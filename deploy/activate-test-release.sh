#!/usr/bin/env bash
set -euo pipefail

base_dir="/srv/quadball-timer-test"
service_name="quadball-timer-test"
port="3001"
release_id=""
staged_dir=""
keep_releases=5

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
if [[ -n "$staged_dir" ]]; then
  [[ "$staged_dir" == "$expected_staged_dir" ]] || { echo "Invalid Test staging directory." >&2; exit 1; }
  cleanup_staged=1
fi
# shellcheck disable=SC2329
cleanup() {
  if (( cleanup_staged == 1 )) && [[ -d "$staged_dir" ]]; then
    chmod -R u+w -- "$staged_dir" 2>/dev/null || true
    rm -rf -- "$staged_dir"
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
  verify_bundle "$staged_dir"
  chmod u+w -- "$staged_dir"
  mv -- "$staged_dir" "$release_dir"
  cleanup_staged=0
  chmod -R a-w -- "$release_dir"
else
  [[ -d "$release_dir" ]] || { echo "Test release directory does not exist." >&2; exit 1; }
  verify_bundle "$release_dir"
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
    [[ " $effective_environment " != *" EVENT_GAME_DATABASE=/var/lib/quadball-timer-test/event-game.sqlite "* ]]; then
    echo "Test service does not provide the required isolated state contract." >&2
    echo "Install ${release_dir}/deploy/systemd/quadball-timer-test.service and run systemctl daemon-reload." >&2
    return 1
  fi
}
check_service_contract
ln -sfn -- "$release_dir" "$current_link"
restart_service() { sudo systemctl restart "$service_name"; }

check_release_identity() {
  local selected_release_id="$1"
  local selected_release_dir="$2"
  local identity expected_digest
  identity="$(curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:${port}/internal/release")" || return 1
  expected_digest="$(sed -n 's/.*"executableSha256":"\([0-9a-f]\{64\}\)".*/\1/p' "${selected_release_dir}/release-manifest.json")"
  grep -Fq "\"releaseAttemptId\":\"${selected_release_id}\"" <<<"$identity" || return 1
  grep -Fq "\"executableSha256\":\"${expected_digest}\"" <<<"$identity" || return 1
  grep -Fq "\"runningExecutableSha256\":\"${expected_digest}\"" <<<"$identity" || return 1
}
check_health() {
  local selected_release_id="$1"
  local selected_release_dir="$2"
  for ((attempt = 1; attempt <= 20; attempt++)); do
    if curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:${port}/internal/healthz" >/dev/null &&
      curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:${port}/" | grep -Fq "Test environment — not for live games" &&
      check_release_identity "$selected_release_id" "$selected_release_dir"; then return 0; fi
    sleep 1
  done
  return 1
}
compatible_previous_release() {
  local previous_manifest="${previous_release}/release-manifest.json" candidate_schema previous_schema
  [[ -s "$previous_manifest" ]] || return 1
  candidate_schema="$(sed -n 's/.*"schemaCompatibility":"\([^"]*\)".*/\1/p' "${release_dir}/release-manifest.json")"
  previous_schema="$(sed -n 's/.*"schemaCompatibility":"\([^"]*\)".*/\1/p' "$previous_manifest")"
  [[ -n "$candidate_schema" && "$candidate_schema" == "$previous_schema" ]]
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

if restart_service && check_health "$release_id" "$release_dir"; then
  prune_releases "$release_dir" "$previous_release"
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
