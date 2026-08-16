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

report_operational_failure() {
  local operation="deployment"
  if (( $# >= 3 )); then
    case "${1:-}" in
      deployment|backup|migration|restore|readiness) operation="$1"; shift ;;
    esac
  fi
  local phase="$1" category="$2" outcome="${3:-failed}"
  local reporter_release="${base_dir}/releases/${release_id}" reporter_command="report-operational"
  [[ -x "$maintenance_wrapper" && -n "$release_id" ]] || return 0
  if [[ ! -x "$reporter_release/quadball-timer" || ! -f "$reporter_release/release-manifest.json" ]]; then
    reporter_release="$(realpath "${base_dir}/current" 2>/dev/null || true)"
    [[ "$reporter_release" == "${base_dir}/releases/"* && -x "$reporter_release/quadball-timer" && -f "$reporter_release/release-manifest.json" ]] || return 0
    reporter_command="report-operational-attempt"
  fi
  if [[ "$reporter_command" == report-operational-attempt ]]; then
    nohup sudo "$maintenance_wrapper" test "$reporter_release" "$reporter_command" \
      "$operation" "$phase" "$outcome" "$category" "$release_id" 9>&- </dev/null >/dev/null 2>&1 &
  else
    nohup sudo "$maintenance_wrapper" test "$reporter_release" "$reporter_command" \
      "$operation" "$phase" "$outcome" "$category" 9>&- </dev/null >/dev/null 2>&1 &
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-dir|--release|--staged-dir|--keep-releases)
      option="$1"
      if (( $# < 2 )) || [[ -z "${2:-}" ]]; then
        echo "Missing value for ${option}." >&2
        report_operational_failure preflight atomic-install unavailable
        printf 'unavailable\n' >&2
        exit 1
      fi
      case "$option" in
        --base-dir) base_dir="$2" ;;
        --release) release_id="$2" ;;
        --staged-dir) staged_dir="$2" ;;
        --keep-releases) keep_releases="$2" ;;
      esac
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      report_operational_failure preflight atomic-install unavailable
      printf 'unavailable\n' >&2
      exit 1
      ;;
  esac
done

if [[ ! "$release_id" =~ ^sha-[A-Za-z0-9._-]+-run-[A-Za-z0-9._-]+-attempt-[A-Za-z0-9._-]+$ ]]; then
  echo "Invalid Test release-attempt identity." >&2
  printf 'unavailable\n' >&2
  exit 1
fi
if [[ ! "$keep_releases" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid release retention value." >&2
  printf 'unavailable\n' >&2
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
export QBT_FOCUSED_FAILURE_PHASE="$focused_failure_phase"

inject_focused_failure() {
  if [[ "${QBT_FOCUSED_TEST_MODE:-}" == 1 && "$EUID" -ne 0 && -n "${QBT_FOCUSED_TEST_ROOT:-}" && "$focused_failure_phase" == "$1" ]]; then
    echo "Focused activation failure at $1." >&2
    return 1
  fi
}

rollback_failure_reported=0
report_binary_rollback_failure() {
  rollback_failure_reported=1
  report_operational_failure rollback-restart binary-rollback
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

realpath_command="${QBT_FOCUSED_TEST_REALPATH:-realpath}"

remove_validated_release() {
  local release_path="$1" release_root resolved_release_path quarantine_path
  release_root="$("$realpath_command" -e -- "${base_dir}/releases")" || return 1
  [[ -d "$release_root" && ! -L "$release_root" ]] || return 1
  [[ "$release_path" == "$release_root"/* && "$release_path" != *..* && "$release_path" != *//* ]] || return 1
  [[ -d "$release_path" && ! -L "$release_path" ]] || return 1
  resolved_release_path="$("$realpath_command" -e -- "$release_path")" || return 1
  [[ "$resolved_release_path" == "$release_path" && "$(dirname -- "$resolved_release_path")" == "$release_root" ]] || return 1
  quarantine_path="${release_root}/.prune-$(basename -- "$resolved_release_path")"
  if [[ -e "$quarantine_path" || -L "$quarantine_path" ]]; then
    echo "Release prune cleanup found existing quarantine evidence: ${quarantine_path}" >&2
    return 1
  fi
  if ! mv -- "$resolved_release_path" "$quarantine_path"; then
    echo "Release prune cleanup could not detach validated release: ${release_path}" >&2
    return 1
  fi
  if [[ "${QBT_FOCUSED_TEST_PRUNE_FAILURE:-}" == after-rename ]]; then
    echo "Release prune cleanup deferred after detach: ${quarantine_path}" >&2
    return 1
  fi
  if ! chmod -R u+w "$quarantine_path"; then
    echo "Release prune cleanup left detached evidence after write-enable failure: ${quarantine_path}" >&2
    return 1
  fi
  if ! rm -rf -- "$quarantine_path"; then
    echo "Release prune cleanup left detached evidence after removal failure: ${quarantine_path}" >&2
    return 1
  fi
}

list_selectable_releases() {
  local release_root="$1"
  local release_path
  local -a selectable_releases=()
  shopt -s nullglob
  for release_path in "$release_root"/*; do
    [[ -d "$release_path" && ! -L "$release_path" ]] && selectable_releases+=("$release_path")
  done
  shopt -u nullglob
  if ((${#selectable_releases[@]} > 0)); then
    ls -1dt -- "${selectable_releases[@]}"
  fi
}

if [[ "${QBT_FOCUSED_TEST_PRUNE_PROBE:-}" == 1 ]]; then
  [[ "${QBT_FOCUSED_TEST_MODE:-}" == 1 ]] || exit 1
  remove_validated_release "${QBT_FOCUSED_TEST_PRUNE_TARGET:-}"
  exit $?
fi

if [[ "${QBT_FOCUSED_TEST_PRUNE_LIST:-}" == 1 ]]; then
  [[ "${QBT_FOCUSED_TEST_MODE:-}" == 1 ]] || exit 1
  release_root="$("$realpath_command" -e -- "${base_dir}/releases")" || exit 1
  list_selectable_releases "$release_root"
  exit $?
fi

readiness_window_seconds=60
focused_activation_elapsed_seconds=0
focused_activation_clock_file="${QBT_FOCUSED_TEST_CLOCK_FILE:-}"
activation_now_seconds() {
  if [[ "${QBT_FOCUSED_TEST_CLOCK:-}" == logical ]]; then
    if [[ -n "$focused_activation_clock_file" ]]; then
      cat "$focused_activation_clock_file"
    else
      printf '%s\n' "$focused_activation_elapsed_seconds"
    fi
  else
    date +%s
  fi
}
activation_consume_probe_duration() {
  if [[ "${QBT_FOCUSED_TEST_CLOCK:-}" != logical ]]; then return 0; fi
  local duration="${QBT_FOCUSED_TEST_PROBE_SECONDS:-0}" now remaining
  [[ "$duration" =~ ^[0-9]+$ ]] || return 1
  now="$(activation_now_seconds)" || return 1
  remaining=$((readiness_deadline - now))
  (( remaining > 0 )) || return 0
  (( duration > remaining )) && duration="$remaining"
  if [[ -n "$focused_activation_clock_file" ]]; then
    printf '%s\n' "$((now + duration))" >"$focused_activation_clock_file"
  else
    focused_activation_elapsed_seconds=$((now + duration))
  fi
}
activation_probe_timeout() {
  local now remaining
  now="$(activation_now_seconds)" || return 1
  remaining=$((readiness_deadline - now))
  (( remaining > 0 )) || return 1
  printf '%s\n' "$remaining"
}
activation_record_probe() {
  local probe_name="$1" phase="$2" status="$3" now
  [[ -n "${QBT_FOCUSED_TEST_PROBE_LOG:-}" ]] || return 0
  now="$(activation_now_seconds)" || return 1
  printf '%s %s %s %s\n' "$now" "$phase" "$probe_name" "$status" >>"$QBT_FOCUSED_TEST_PROBE_LOG"
}
activation_curl() {
  local probe_name="$1" request_timeout status
  shift
  request_timeout="$(activation_probe_timeout)" || return 1
  activation_record_probe "$probe_name" start pending || return 1
  curl --silent --show-error --max-time "$request_timeout" "$@"
  status=$?
  activation_consume_probe_duration || return 1
  activation_record_probe "$probe_name" end "$status" || return 1
  return "$status"
}
activation_wait_seconds() {
  local seconds="$1"
  if [[ "${QBT_FOCUSED_TEST_CLOCK:-}" == logical ]]; then
    local now
    now="$(activation_now_seconds)" || return 1
    if [[ -n "$focused_activation_clock_file" ]]; then
      printf '%s\n' "$((now + seconds))" >"$focused_activation_clock_file"
    else
      focused_activation_elapsed_seconds=$((now + seconds))
    fi
  else
    sleep "$seconds"
  fi
}

if [[ -n "$staged_dir" ]]; then
  if [[ "$staged_dir" != "$expected_staged_dir" ]]; then
    echo "Invalid Test staging directory." >&2
    report_operational_failure preflight atomic-install
    exit 1
  fi
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
if ! check_environment_identity; then
  report_operational_failure preflight readiness
  exit 1
fi
# shellcheck disable=SC2329
cleanup() {
  if (( cleanup_staged == 1 )) && [[ -d "$staged_dir" ]]; then
    chmod -R u+w -- "$staged_dir" 2>/dev/null || true
    rm -rf -- "$staged_dir"
  fi
  if (( service_stopped == 1 && migration_attempted == 0 )); then
    if ! sudo systemctl restart "$service_name" >/dev/null 2>&1; then
      report_binary_rollback_failure
    fi
  fi
}
trap cleanup EXIT

if ! mkdir -p -- "${base_dir}/releases" "${base_dir}/.staging"; then
  report_operational_failure preflight atomic-install
  exit 1
fi
if ! exec 9>"${base_dir}/.activation.lock"; then
  report_operational_failure preflight atomic-install
  exit 1
fi
if ! flock -n 9; then
  echo "Another ${service_name} activation is already running." >&2
  report_operational_failure preflight atomic-install
  exit 1
fi
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
    "deploy/restore-production.sh"
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
  [[ ! -e "$release_dir" ]] || { echo "Test release identity already exists and cannot be overwritten." >&2; report_operational_failure preflight atomic-install; exit 1; }
  if [[ "${QBT_FOCUSED_TEST_RELEASE_VERIFIED:-}" != 1 ]] && ! verify_bundle "$staged_dir"; then
    report_operational_failure preflight atomic-install
    exit 1
  fi
  if ! chmod u+w -- "$staged_dir" || ! mv -- "$staged_dir" "$release_dir"; then
    report_operational_failure preflight atomic-install
    exit 1
  fi
  cleanup_staged=0
  if ! chmod -R a-w -- "$release_dir"; then
    report_operational_failure preflight atomic-install
    exit 1
  fi
else
  [[ -d "$release_dir" ]] || {
    echo "Test release directory does not exist." >&2
    report_operational_failure preflight atomic-install
    exit 1
  }
  if [[ "${QBT_FOCUSED_TEST_RELEASE_VERIFIED:-}" != 1 ]] && ! verify_bundle "$release_dir"; then
    report_operational_failure preflight atomic-install
    exit 1
  fi
fi

if [[ "${QBT_FOCUSED_TEST_MODE:-}" != 1 ]] && ! grep -qw avx2 /proc/cpuinfo; then
  echo "Server CPU does not support AVX2, but this release uses bun-linux-x64-modern." >&2
  report_operational_failure preflight atomic-install
  exit 1
fi
expected_exec_start="${current_link}/quadball-timer"
actual_exec_start="$(systemctl show "$service_name" --property=ExecStart --value 2>/dev/null || true)"
if [[ "$actual_exec_start" != *"$expected_exec_start"* ]]; then
  echo "Test service does not run ${expected_exec_start}." >&2
  report_operational_failure preflight atomic-install
  exit 1
fi

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
if ! check_service_contract; then
  report_operational_failure preflight atomic-install
  exit 1
fi

schema_compatibility="$(sed -n 's/.*"schemaCompatibility":"\([^"]*\)".*/\1/p' "${release_dir}/release-manifest.json" || true)"
if [[ -z "$schema_compatibility" ]]; then
  echo "Release schema compatibility is missing." >&2
  report_operational_failure preflight schema-incompatibility
  exit 1
fi
if [[ ! -x "$maintenance_wrapper" ]]; then
  echo "Root maintenance boundary is not installed." >&2
  report_operational_failure preflight atomic-install
  exit 1
fi
available_kb="$(df -Pk /var/lib/quadball-timer-test 2>/dev/null | awk 'NR == 2 {print $4}' || true)"
if [[ ! "$available_kb" =~ ^[0-9]+$ ]] || (( available_kb < 16384 )); then
  echo "Test state directory lacks the required disk reserve." >&2
  report_operational_failure preflight atomic-install
  exit 1
fi
echo "ACTIVATION_PHASE=migration"
if ! sudo "$maintenance_wrapper" test "$release_dir" preflight >/dev/null; then
  echo "Test Foundation preflight/readiness failed; service was not stopped." >&2
  exit 1
fi
if ! inject_focused_failure quiesce-stop; then report_operational_failure quiesce-stop atomic-install; exit 1; fi
if ! sudo systemctl stop "$service_name"; then
  report_operational_failure quiesce-stop atomic-install
  exit 1
fi
service_stopped=1
if ! sudo "$maintenance_wrapper" test "$release_dir" validate-migration; then
  echo "Disposable Test migration candidate did not reach readiness." >&2
  exit 1
fi
migration_attempted=1
if ! sudo "$maintenance_wrapper" test "$release_dir" apply-migrations; then
  echo "Test migration failed; no backup was created or retained." >&2
  exit 1
fi
echo "ACTIVATION_PHASE=activation"
if ! inject_focused_failure release-switch; then report_operational_failure release-switch atomic-install; exit 1; fi
if ! ln -sfn -- "$release_dir" "$current_link"; then
  report_operational_failure release-switch atomic-install
  exit 1
fi
restart_service() {
  local phase="$1" category="$2"
  if ! inject_focused_failure rollback-restart; then
    report_operational_failure "$phase" "$category"
    return 1
  fi
  if ! sudo systemctl restart "$service_name"; then
    report_operational_failure "$phase" "$category"
    return 1
  fi
}

check_release_identity() {
  local selected_release_id="$1"
  local selected_release_dir="$2"
  local identity expected_digest candidate_schema
  identity="$(activation_curl release --fail "http://127.0.0.1:${port}/internal/release")" || return 1
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
  local readiness_now
  inject_focused_failure readiness || return 1
  readiness_now="$(activation_now_seconds)" || return 1
  readiness_deadline=$((readiness_now + readiness_window_seconds))
  while (( readiness_now < readiness_deadline )); do
    if activation_curl health --fail "http://127.0.0.1:${port}/internal/healthz" >/dev/null &&
      activation_curl home --fail "http://127.0.0.1:${port}/" | grep -Fq "Test environment — not for live games" &&
      check_release_identity "$selected_release_id" "$selected_release_dir" &&
      check_representative_behavior; then return 0; fi
    activation_wait_seconds 1 || return 1
    readiness_now="$(activation_now_seconds)" || return 1
  done
  return 1
}

check_representative_behavior() {
  local websocket_headers
  activation_curl events --fail "http://127.0.0.1:${port}/api/audience/events" >/dev/null || return 1
  websocket_headers="$(activation_curl websocket \
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
  local current_release="$1" rollback_release="$2" release_path release_root
  local -a all_releases
 release_root="$("$realpath_command" -e -- "${base_dir}/releases")" || return 1
 find "$release_root" -mindepth 1 -maxdepth 1 -type d -name '.prune-*' -print >&2
 all_releases=()
 while IFS= read -r release_path; do all_releases+=("$release_path"); done < <(
   list_selectable_releases "$release_root"
 )
  local release_count=0
  if ((${#all_releases[@]} > 0)); then
    for release_path in "${all_releases[@]}"; do
      [[ "$release_path" == "$current_release" || "$release_path" == "$rollback_release" ]] && continue
      release_count=$((release_count + 1))
      if (( release_count > keep_releases - 2 )); then remove_validated_release "$release_path"; fi
    done
  fi
}

if restart_service startup atomic-install; then
  if check_health "$release_id" "$release_dir"; then
    if ! prune_releases "$release_dir" "$previous_release"; then
      report_operational_failure final-report atomic-install
      exit 1
    fi
    if ! inject_focused_failure final-report; then report_operational_failure final-report atomic-install; exit 1; fi
    echo "Activated immutable Test release attempt ${release_id}."
    exit 0
  fi
  report_operational_failure readiness readiness
fi
echo "Test deployment failed; attempting compatible binary rollback without restoring data." >&2
if [[ -n "$previous_release" && -d "$previous_release" ]] && compatible_previous_release; then
  previous_release_id="${previous_release##*/}"
  if ! ln -sfn -- "$previous_release" "$current_link"; then
    report_binary_rollback_failure
  elif restart_service rollback-restart binary-rollback; then
    if check_health "$previous_release_id" "$previous_release"; then
      echo "Rolled back Test to ${previous_release}." >&2
    else
      report_binary_rollback_failure
      echo "Test rollback failed health checks; stopping Test service fail-closed." >&2
    fi
  else
    echo "Test rollback failed health checks; stopping Test service fail-closed." >&2
  fi
else
  report_binary_rollback_failure
  echo "No compatible previous Test release available for rollback." >&2
fi
if ! sudo systemctl stop "$service_name"; then
  if [[ "$rollback_failure_reported" == 0 ]]; then
    report_operational_failure quiesce-stop atomic-install
  fi
  echo "Test fail-closed stop failed; service state is not trusted." >&2
else
  echo "Test service stopped after failed activation." >&2
fi
exit 1
