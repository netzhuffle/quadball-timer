#!/usr/bin/env bash
set -euo pipefail

base_dir="/srv/quadball-timer-test"
service_name="quadball-timer-test"
port="3001"
release_id=""
staged_dir=""
keep_releases=5
expected_environment="test"
maintenance_wrapper="/usr/local/sbin/quadball-timer-activation-maintenance"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-dir) base_dir="${2:-}"; shift 2 ;;
    --release) release_id="${2:-}"; shift 2 ;;
    --staged-dir) staged_dir="${2:-}"; shift 2 ;;
    --keep-releases) keep_releases="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ ! "$release_id" =~ ^sha-[A-Za-z0-9._-]+-run-[A-Za-z0-9._-]+-attempt-[A-Za-z0-9._-]+$ ]]; then
  echo "Invalid Test release-attempt identity." >&2
  exit 1
fi
if [[ ! "$keep_releases" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid release retention value." >&2
  exit 1
fi

release_dir="${base_dir}/releases/${release_id}"
current_link="${base_dir}/current"
expected_staged_dir="${base_dir}/.staging/${release_id}"
previous_release=""
cleanup_staged=0
service_stopped=0
migration_attempted=0
focused_failure_phase="${QBT_FOCUSED_FAILURE_PHASE:-}"

inject_focused_failure() {
  if [[ "${QBT_FOCUSED_TEST_MODE:-}" == 1 && "$EUID" -ne 0 && -n "${QBT_FOCUSED_TEST_ROOT:-}" && "$focused_failure_phase" == "$1" ]]; then
    echo "Focused activation failure at $1." >&2
    return 1
  fi
}
if [[ "${QBT_FOCUSED_TEST_MODE:-}" == 1 ]]; then
  focused_test_root="${QBT_FOCUSED_TEST_ROOT:-}"
  focused_maintenance_wrapper="${QBT_FOCUSED_TEST_MAINTENANCE_WRAPPER:-}"
  canonical_focused_directory() {
    [[ -d "$1" && ! -L "$1" ]] || return 1
    (cd -- "$1" && pwd -P)
  }
  canonical_focused_file() {
    local parent
    [[ -f "$1" && ! -L "$1" ]] || return 1
    parent="$(canonical_focused_directory "$(dirname -- "$1")")" || return 1
    printf '%s/%s\n' "$parent" "$(basename -- "$1")"
  }
  if [[ "$EUID" -eq 0 || "$focused_test_root" != /* || "$focused_test_root" == / ||
    "$focused_test_root" == *..* || "$focused_test_root" == *//* ||
    ! -d "$focused_test_root" || -L "$focused_test_root" ||
    "$base_dir" != /* || "$base_dir" == *..* || "$base_dir" == *//* ||
    "$focused_maintenance_wrapper" != /* || "$focused_maintenance_wrapper" == *..* ||
    "$focused_maintenance_wrapper" == *//* ]]
  then
    echo "Invalid non-root focused activation boundary." >&2
    exit 1
  fi
  focused_test_root_resolved="$(canonical_focused_directory "$focused_test_root")" || exit 1
  base_dir_resolved="$(canonical_focused_directory "$base_dir")" || exit 1
  maintenance_wrapper_resolved="$(canonical_focused_file "$focused_maintenance_wrapper")" || exit 1
  if [[ "$focused_test_root_resolved" != "$focused_test_root" || "$base_dir_resolved" != "$base_dir" ||
    "$maintenance_wrapper_resolved" != "$focused_maintenance_wrapper" ||
    "$base_dir_resolved" != "$focused_test_root_resolved"/* ||
    "$maintenance_wrapper_resolved" != "$focused_test_root_resolved"/* ||
    ! -x "$maintenance_wrapper_resolved" ]]
  then
    echo "Focused activation paths escape the disposable root." >&2
    exit 1
  fi
  base_dir="$base_dir_resolved"
  focused_test_root="$focused_test_root_resolved"
  maintenance_wrapper="$maintenance_wrapper_resolved"
  export QBT_FOCUSED_TEST_ROOT="$focused_test_root"
  release_dir="${base_dir}/releases/${release_id}"
  current_link="${base_dir}/current"
  expected_staged_dir="${base_dir}/.staging/${release_id}"
fi
if [[ -n "$staged_dir" ]]; then
  [[ "$staged_dir" == "$expected_staged_dir" ]] || { echo "Invalid Test staging directory." >&2; exit 1; }
  cleanup_staged=1
fi

check_environment_identity() {
  local effective_environment
  effective_environment="$(systemctl show "$service_name" --property=Environment --value 2>/dev/null || true)"
  [[ " $effective_environment " == *" QUADBALL_ENVIRONMENT=${expected_environment} "* ]] || {
    echo "Service ${service_name} does not belong to ${expected_environment} Environment." >&2
    return 1
  }
  [[ " $effective_environment " == *" FOUNDATION_DATABASE=/var/lib/quadball-timer-test/foundation.sqlite "* ]] || {
    echo "Service ${service_name} does not use the Test Foundation database." >&2
    return 1
  }
}
check_environment_identity
# shellcheck disable=SC2329
cleanup() {
  if (( cleanup_staged == 1 )) && [[ -d "$staged_dir" ]]; then
    chmod -R u+w -- "$staged_dir" 2>/dev/null || true
    rm -rf -- "$staged_dir"
  fi
  if (( service_stopped == 1 && migration_attempted == 0 )); then
    sudo systemctl restart "$service_name" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

mkdir -p -- "${base_dir}/releases" "${base_dir}/.staging"
exec 9>"${base_dir}/.activation.lock"
if ! flock -n 9; then echo "Another ${service_name} activation is already running." >&2; exit 1; fi
if [[ -L "$current_link" || -d "$current_link" ]]; then previous_release="$(readlink -f "$current_link" || true)"; fi

verify_bundle() {
  local directory="$1"
  local manifest_path="${directory}/release-manifest.json"
  local expected_digest actual_digest member
  local -a members expected_members
  [[ -d "$directory" && ! -L "$directory" && -s "$manifest_path" ]] || { echo "Test release staging directory or manifest is missing." >&2; return 1; }
  if find "$directory" -type l -print -quit | grep -q .; then echo "Test bundle contains a symlink." >&2; return 1; fi
  mapfile -t members < <(find "$directory" -type f -printf '%P\n' | sort)
  expected_members=(
    "deploy/activate-release.sh"
    "deploy/activate-test-release.sh"
    "deploy/activation-maintenance-root.sh"
    "deploy/systemd/quadball-timer.service"
    "deploy/systemd/quadball-timer-test.service"
    "quadball-timer"
    "release-manifest.json"
  )
  [[ "${members[*]}" == "${expected_members[*]}" ]] || { echo "Test bundle members do not match the allowlist." >&2; return 1; }
  grep -Fq "\"releaseAttemptId\":\"${release_id}\"" "$manifest_path" || { echo "Test manifest has the wrong release identity." >&2; return 1; }
  expected_digest="$(sed -n 's/.*"executableSha256":"\([0-9a-f]\{64\}\)".*/\1/p' "$manifest_path")"
  actual_digest="$(sha256sum "${directory}/quadball-timer" | awk '{print $1}')"
  [[ -n "$expected_digest" && "$expected_digest" == "$actual_digest" ]] || { echo "Test executable digest mismatch." >&2; return 1; }
  for member in "${expected_members[@]}"; do
    [[ "$member" == "release-manifest.json" ]] && continue
    actual_digest="$(sha256sum "${directory}/${member}" | awk '{print $1}')"
    grep -Fq "\"path\":\"${member}\",\"sha256\":\"${actual_digest}\"" "$manifest_path" || { echo "Test member digest mismatch: ${member}." >&2; return 1; }
  done
}

if [[ -n "$staged_dir" ]]; then
  [[ ! -e "$release_dir" ]] || { echo "Test release identity already exists and cannot be overwritten." >&2; exit 1; }
  if [[ "${QBT_FOCUSED_TEST_RELEASE_VERIFIED:-}" != 1 ]]; then verify_bundle "$staged_dir"; fi
  chmod u+w -- "$staged_dir"
  mv -- "$staged_dir" "$release_dir"
  cleanup_staged=0
  chmod -R a-w -- "$release_dir"
else
  [[ -d "$release_dir" ]] || { echo "Test release directory does not exist." >&2; exit 1; }
  if [[ "${QBT_FOCUSED_TEST_RELEASE_VERIFIED:-}" != 1 ]]; then verify_bundle "$release_dir"; fi
fi

grep -qw avx2 /proc/cpuinfo || { echo "Server CPU does not support AVX2, but this release uses bun-linux-x64-modern." >&2; exit 1; }
expected_exec_start="${current_link}/quadball-timer"
actual_exec_start="$(systemctl show "$service_name" --property=ExecStart --value 2>/dev/null || true)"
[[ "$actual_exec_start" == *"$expected_exec_start"* ]] || { echo "Test service does not run ${expected_exec_start}." >&2; exit 1; }

check_service_contract() {
  local state_directory state_directory_mode effective_environment
  state_directory="$(systemctl show "$service_name" --property=StateDirectory --value 2>/dev/null || true)"
  state_directory_mode="$(systemctl show "$service_name" --property=StateDirectoryMode --value 2>/dev/null || true)"
  effective_environment="$(systemctl show "$service_name" --property=Environment --value 2>/dev/null || true)"
  if [[ "$state_directory" != "quadball-timer-test" ]] ||
    [[ "$state_directory_mode" != "0750" ]] ||
    [[ " $effective_environment " != *" QUADBALL_ENVIRONMENT=test "* ]] ||
    [[ " $effective_environment " != *" PUBLIC_ORIGIN=https://test.timer.quadball.app "* ]] ||
    [[ " $effective_environment " != *" TECHNICAL_ADMIN_DATABASE=/var/lib/quadball-timer-test/technical-admin.sqlite "* ]] ||
    [[ " $effective_environment " != *" FOUNDATION_DATABASE=/var/lib/quadball-timer-test/foundation.sqlite "* ]] ||
    [[ " $effective_environment " != *" EVENT_GAME_DATABASE=/var/lib/quadball-timer-test/event-game.sqlite "* ]] ||
    [[ " $effective_environment " != *" GRANT_KEY_RING_FILE=/etc/quadball-timer/test-grant-key-ring.json "* ]]; then
    echo "Test service does not provide the required isolated state contract." >&2
    echo "Install ${release_dir}/deploy/systemd/quadball-timer-test.service and run systemctl daemon-reload." >&2
    return 1
  fi
}
check_service_contract

schema_compatibility="$(sed -n 's/.*"schemaCompatibility":"\([^"]*\)".*/\1/p' "${release_dir}/release-manifest.json")"
[[ -n "$schema_compatibility" ]] || { echo "Release schema compatibility is missing." >&2; exit 1; }
[[ -x "$maintenance_wrapper" ]] || { echo "Root maintenance boundary is not installed." >&2; exit 1; }
available_kb="$(df -Pk /var/lib/quadball-timer-test | awk 'NR == 2 {print $4}')"
if [[ ! "$available_kb" =~ ^[0-9]+$ ]] || (( available_kb < 16384 )); then
  echo "Test state directory lacks the required disk reserve." >&2
  exit 1
fi
echo "ACTIVATION_PHASE=migration"
if ! inject_focused_failure preflight; then exit 1; fi
if ! sudo "$maintenance_wrapper" test "$release_dir" preflight >/dev/null; then
  echo "Test Foundation preflight/readiness failed; service was not stopped." >&2
  exit 1
fi
if ! inject_focused_failure quiesce-stop; then exit 1; fi
sudo systemctl stop "$service_name"
service_stopped=1
if ! inject_focused_failure candidate-validation; then exit 1; fi
if ! sudo "$maintenance_wrapper" test "$release_dir" validate-migration; then
  echo "Disposable Test migration candidate did not reach readiness." >&2
  exit 1
fi
if ! inject_focused_failure live-migration; then exit 1; fi
migration_attempted=1
if ! sudo "$maintenance_wrapper" test "$release_dir" apply-migrations; then
  echo "Test migration failed; no backup was created or retained." >&2
  exit 1
fi
echo "ACTIVATION_PHASE=activation"
if ! inject_focused_failure release-switch; then exit 1; fi
ln -sfn -- "$release_dir" "$current_link"
restart_service() { inject_focused_failure rollback-restart || return 1; sudo systemctl restart "$service_name"; }

check_release_identity() {
  local selected_release_id="$1"
  local selected_release_dir="$2"
  local identity expected_digest candidate_schema
  identity="$(curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:${port}/internal/release")" || return 1
  expected_digest="$(sed -n 's/.*"executableSha256":"\([0-9a-f]\{64\}\)".*/\1/p' "${selected_release_dir}/release-manifest.json")"
  candidate_schema="$(sed -n 's/.*"schemaCompatibility":"\([^"]*\)\".*/\1/p' "${selected_release_dir}/release-manifest.json")"
  grep -Fq "\"releaseAttemptId\":\"${selected_release_id}\"" <<<"$identity" || return 1
  grep -Fq "\"executableSha256\":\"${expected_digest}\"" <<<"$identity" || return 1
  grep -Fq "\"runningExecutableSha256\":\"${expected_digest}\"" <<<"$identity" || return 1
  grep -Fq "\"schemaCompatibility\":\"${candidate_schema}\"" <<<"$identity" || return 1
}
check_health() {
  local selected_release_id="$1"
  local selected_release_dir="$2"
  inject_focused_failure readiness || return 1
  for ((attempt = 1; attempt <= 20; attempt++)); do
    if curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:${port}/internal/healthz" >/dev/null &&
      curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:${port}/" | grep -Fq "Test environment — not for live games" &&
      check_release_identity "$selected_release_id" "$selected_release_dir"; then return 0; fi
    sleep 1
  done
  return 1
}

check_representative_behavior() {
  curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:${port}/api/audience/events" >/dev/null || return 1
  local websocket_headers
  websocket_headers="$(curl --silent --show-error --max-time 2 \
    -H "Origin: http://127.0.0.1:${port}" \
    -H "Connection: Upgrade" \
    -H "Upgrade: websocket" \
    -H "Sec-WebSocket-Version: 13" \
    -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
    -D - -o /dev/null "http://127.0.0.1:${port}/ws" || true)"
  grep -Eq '^HTTP/[0-9.]+ 101 ' <<<"$websocket_headers"
}
compatible_previous_release() {
  local previous_manifest="${previous_release}/release-manifest.json" actual_schema supported_versions
  [[ -s "$previous_manifest" ]] || return 1
  actual_schema="$(sudo "$maintenance_wrapper" test "$release_dir" preflight | sed -n 's/.*"schemaVersion":\([0-9][0-9]*\).*/\1/p')"
  [[ -n "$actual_schema" ]] || return 1
  supported_versions="$(sed -n 's/.*"supportedFoundationSchemaVersions":\[\([^]]*\)\].*/\1/p' "$previous_manifest")"
  [[ -n "$supported_versions" ]] || return 1
  [[ ",${supported_versions}," == *,"\"${actual_schema}\"",* ]]
}

prune_releases() {
  local current_release="$1" rollback_release="$2" release_path
  local -a all_releases
  mapfile -t all_releases < <(find "${base_dir}/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
  local release_count=0
  for release_path in "${all_releases[@]}"; do
    [[ "$release_path" == "$current_release" || "$release_path" == "$rollback_release" ]] && continue
    release_count=$((release_count + 1))
    if (( release_count > keep_releases - 2 )); then rm -rf -- "$release_path"; fi
  done
}

if restart_service && check_health "$release_id" "$release_dir" && check_representative_behavior; then
  prune_releases "$release_dir" "$previous_release"
  if ! inject_focused_failure final-report; then exit 1; fi
  echo "Activated immutable Test release attempt ${release_id}."
  exit 0
fi
echo "Test deployment failed; attempting compatible binary rollback without restoring data." >&2
if [[ -n "$previous_release" && -d "$previous_release" ]] && compatible_previous_release; then
  previous_release_id="${previous_release##*/}"
  ln -sfn -- "$previous_release" "$current_link"
  if restart_service && check_health "$previous_release_id" "$previous_release"; then echo "Rolled back Test to ${previous_release}." >&2; else echo "Test rollback failed health checks." >&2; fi
else
  echo "No compatible previous Test release available for rollback." >&2
fi
exit 1
