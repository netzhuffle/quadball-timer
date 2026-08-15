#!/usr/bin/env bash
set -euo pipefail

base_dir="/srv/quadball-timer"
release_id=""
staged_dir=""
service_name="quadball-timer"
port="3000"
keep_releases=5
expected_environment="production"
maintenance_wrapper="/usr/local/sbin/quadball-timer-activation-maintenance"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-dir) base_dir="${2:-}"; shift 2 ;;
    --release) release_id="${2:-}"; shift 2 ;;
    --staged-dir) staged_dir="${2:-}"; shift 2 ;;
    --service) service_name="${2:-}"; shift 2 ;;
    --port) port="${2:-}"; shift 2 ;;
    --keep-releases) keep_releases="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ ! "$release_id" =~ ^sha-[A-Za-z0-9._-]+-run-[A-Za-z0-9._-]+-attempt-[A-Za-z0-9._-]+$ ]]; then
  echo "Invalid release-attempt identity." >&2
  exit 1
fi
if [[ ! "$service_name" =~ ^[A-Za-z0-9_.@-]+$ ]]; then
  echo "Invalid service value: ${service_name}" >&2
  exit 1
fi
if [[ ! "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
  echo "Invalid port value: ${port}" >&2
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
candidate_dir=""
service_stopped=0
migration_attempted=0
focused_failure_phase="${QBT_FOCUSED_FAILURE_PHASE:-}"
focused_batch_output="${QBT_FOCUSED_TEST_BATCH_OUTPUT:-}"

if [[ "${QBT_FOCUSED_TEST_BATCH:-}" == 1 && "${QBT_FOCUSED_TEST_MODE:-}" != 1 ]]; then
  echo "Focused batch activation requires focused test mode." >&2
  exit 1
fi

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
  if [[ "${QBT_FOCUSED_TEST_BATCH:-}" == 1 ]]; then
    focused_batch_validate_directory() {
      local path="$1" expected="$2" resolved
      [[ "$path" == /* && "$path" != *..* && "$path" != *//* ]] || return 1
      resolved="$(canonical_focused_directory "$path")" || return 1
      [[ "$resolved" == "$path" && "$resolved" == "$focused_test_root"/* && "$resolved" == "$expected" ]]
    }
    focused_batch_validate_file() {
      local path="$1" parent resolved
      [[ "$path" == /* && "$path" != *..* && "$path" != *//* && -f "$path" && ! -L "$path" ]] || return 1
      parent="$(canonical_focused_directory "$(dirname -- "$path")")" || return 1
      resolved="$(canonical_focused_file "$path")" || return 1
      [[ "$parent" == "$focused_test_root"/* && "$resolved" == "$path" ]]
    }
    focused_batch_validate_phase_list() {
      local phase seen=""
      [[ "$1" == "preflight,quiesce-stop,backup-create,backup-verify,backup-promote,candidate-validation,live-migration,release-switch,readiness,rollback-restart,final-report" ]] || return 1
      [[ "$1" =~ ^[A-Za-z-]+(,[A-Za-z-]+)*$ ]] || return 1
      for phase in ${1//,/ }; do
        case ",${seen}" in *,"$phase",*) return 1 ;; esac
        case "$phase" in
          preflight|quiesce-stop|backup-create|backup-verify|backup-promote|candidate-validation|live-migration|release-switch|readiness|rollback-restart|final-report) ;;
          *) return 1 ;;
        esac
        seen="${seen}${phase},"
      done
    }
    focused_batch_validate_phase_list "${QBT_FOCUSED_TEST_PHASES:-}" || {
      echo "Focused batch phases are malformed or not allowlisted." >&2
      exit 1
    }
    focused_batch_validate_directory "${QBT_FAST_BASE:-}" "$base_dir" || { echo "Focused batch base is unsafe." >&2; exit 1; }
    focused_batch_validate_directory "${QBT_FAST_STATE:-}" "${QBT_FAST_STATE:-}" || { echo "Focused batch state directory is unsafe." >&2; exit 1; }
    focused_batch_validate_directory "${QBT_FAST_PREVIOUS:-}" "${QBT_FAST_PREVIOUS:-}" || { echo "Focused batch previous release is unsafe." >&2; exit 1; }
    focused_batch_validate_file "${QBT_FAST_DATABASE:-}" || { echo "Focused batch database path is unsafe." >&2; exit 1; }
    focused_batch_validate_file "${QBT_FAST_POINTER:-}" || { echo "Focused batch pointer path is unsafe." >&2; exit 1; }
    focused_batch_validate_file "${QBT_FAST_LOG:-}" || { echo "Focused batch log path is unsafe." >&2; exit 1; }
    if [[ -n "${QBT_FOCUSED_TEST_PROBE_OUTPUT:-}" ]]; then
      focused_batch_validate_file "$QBT_FOCUSED_TEST_PROBE_OUTPUT" || { echo "Focused batch probe path is unsafe." >&2; exit 1; }
      focused_probe_phase=0
      focused_batch_validate_phase_list "${QBT_FOCUSED_TEST_PROBE_PHASES:-}" && focused_probe_phase=1
      focused_probe_pointer=0
      focused_batch_validate_file "${QBT_FOCUSED_TEST_PROBE_POINTER:-}" || focused_probe_pointer=1
      focused_probe_state=0
      focused_batch_validate_directory "${QBT_FOCUSED_TEST_PROBE_STATE:-}" "${QBT_FOCUSED_TEST_PROBE_STATE:-}" || focused_probe_state=1
      printf '%s %s %s\n' "$focused_probe_phase" "$focused_probe_pointer" "$focused_probe_state" >"$QBT_FOCUSED_TEST_PROBE_OUTPUT"
      exit 1
    fi
    [[ "$focused_batch_output" == "$focused_test_root"/* && "$focused_batch_output" != *..* && "$focused_batch_output" != *//* ]] || {
      echo "Focused batch output escapes the disposable root." >&2
      exit 1
    }
    focused_batch_output_parent="$(canonical_focused_directory "$(dirname -- "$focused_batch_output")")" || exit 1
    [[ "$focused_batch_output_parent" == "$focused_test_root" || "$focused_batch_output_parent" == "$focused_test_root"/* ]] || {
      echo "Focused batch output parent escapes the disposable root." >&2
      exit 1
    }
    if [[ -e "$focused_batch_output" || -L "$focused_batch_output" ]]; then
      focused_batch_validate_directory "$focused_batch_output" "$focused_batch_output" || exit 1
    else
      mkdir -p -- "$focused_batch_output"
    fi
    focused_batch_output_resolved="$(canonical_focused_directory "$focused_batch_output")" || exit 1
    [[ "$focused_batch_output_resolved" == "$focused_batch_output" && "$focused_batch_output_resolved" == "$focused_test_root"/* ]] || {
      echo "Focused batch output is not canonical." >&2
      exit 1
    }
    focused_batch_output="$focused_batch_output_resolved"
  fi
  release_dir="${base_dir}/releases/${release_id}"
  current_link="${base_dir}/current"
  expected_staged_dir="${base_dir}/.staging/${release_id}"
fi

realpath_command="${QBT_FOCUSED_TEST_REALPATH:-realpath}"

remove_validated_release() {
  local release_path="$1" release_root resolved_release_path trash_root detached_path
  release_root="$("$realpath_command" -e -- "${base_dir}/releases")" || return 1
  [[ -d "$release_root" && ! -L "$release_root" ]] || return 1
  [[ "$release_path" == "$release_root"/* && "$release_path" != *..* && "$release_path" != *//* ]] || return 1
  [[ -d "$release_path" && ! -L "$release_path" ]] || return 1
  resolved_release_path="$("$realpath_command" -e -- "$release_path")" || return 1
  [[ "$resolved_release_path" == "$release_path" && "$(dirname -- "$resolved_release_path")" == "$release_root" ]] || return 1
  [[ -d "${base_dir}/.staging" && ! -L "${base_dir}/.staging" ]] || return 1
  trash_root="$(mktemp -d "${base_dir}/.staging/.prune-XXXXXX")" || {
    echo "Release prune cleanup could not allocate bounded trash: ${release_path}" >&2
    return 1
  }
  detached_path="${trash_root}/$(basename -- "$resolved_release_path")"
  if ! mv -- "$resolved_release_path" "$detached_path"; then
    rmdir -- "$trash_root" 2>/dev/null || true
    echo "Release prune cleanup could not detach validated release: ${release_path}" >&2
    return 1
  fi
  if [[ "${QBT_FOCUSED_TEST_PRUNE_FAILURE:-}" == after-rename ]]; then
    echo "Release prune cleanup deferred after detach: ${detached_path}" >&2
    return 1
  fi
  if ! chmod -R u+w "$detached_path"; then
    echo "Release prune cleanup left detached evidence after write-enable failure: ${detached_path}" >&2
    return 1
  fi
  if ! rm -rf -- "$detached_path"; then
    echo "Release prune cleanup left detached evidence after removal failure: ${detached_path}" >&2
    return 1
  fi
  rmdir -- "$trash_root" 2>/dev/null || true
}

if [[ "${QBT_FOCUSED_TEST_PRUNE_PROBE:-}" == 1 ]]; then
  [[ "${QBT_FOCUSED_TEST_MODE:-}" == 1 ]] || exit 1
  remove_validated_release "${QBT_FOCUSED_TEST_PRUNE_TARGET:-}"
  exit $?
fi

inject_focused_failure() {
  if [[ "${QBT_FOCUSED_TEST_MODE:-}" == 1 && "$EUID" -ne 0 && -n "${QBT_FOCUSED_TEST_ROOT:-}" && "$focused_failure_phase" == "$1" ]]; then
    echo "Focused activation failure at $1." >&2
    return 1
  fi
}

check_environment_identity() {
  local effective_environment
  effective_environment="$(systemctl show "$service_name" --property=Environment --value 2>/dev/null || true)"
  [[ " $effective_environment " == *" QUADBALL_ENVIRONMENT=${expected_environment} "* ]] || {
    echo "Service ${service_name} does not belong to ${expected_environment} Environment." >&2
    return 1
  }
  [[ " $effective_environment " == *" FOUNDATION_DATABASE=/var/lib/quadball-timer/foundation.sqlite "* ]] || {
    echo "Service ${service_name} does not use the Production Foundation database." >&2
    return 1
  }
}

activation_attempt() {
previous_release=""
cleanup_staged=0
candidate_dir=""
service_stopped=0
migration_attempted=0
focused_failure_phase="${QBT_FOCUSED_FAILURE_PHASE:-}"
if [[ "${QBT_FOCUSED_TEST_BATCH:-}" != 1 || "$focused_failure_phase" == preflight ]]; then
  check_environment_identity
fi

if [[ -n "$staged_dir" ]]; then
  if [[ "$staged_dir" != "$expected_staged_dir" ]]; then
    echo "Staging directory is outside the environment staging root." >&2
    return 1
  fi
  cleanup_staged=1
fi

# shellcheck disable=SC2329
cleanup() {
  if (( cleanup_staged == 1 )) && [[ -d "$staged_dir" ]]; then
    chmod -R u+w -- "$staged_dir" 2>/dev/null || true
    rm -rf -- "$staged_dir"
  fi
  if [[ -n "$candidate_dir" && -d "$candidate_dir" ]]; then
    chmod -R u+w -- "$candidate_dir" 2>/dev/null || true
    rm -rf -- "$candidate_dir"
  fi
  if (( service_stopped == 1 && migration_attempted == 0 )); then
    sudo systemctl restart "$service_name" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ "${QBT_FOCUSED_TEST_BATCH:-}" != 1 ]]; then
  mkdir -p -- "${base_dir}/releases" "${base_dir}/.staging"
  exec 9>"${base_dir}/.activation.lock"
  if ! flock -n 9; then
    echo "Another ${service_name} activation is already running." >&2
    return 1
  fi
fi

if [[ -L "$current_link" || -d "$current_link" ]]; then
  if [[ "${QBT_FOCUSED_TEST_BATCH:-}" == 1 && -n "${QBT_FAST_PREVIOUS:-}" ]]; then
    previous_release="$QBT_FAST_PREVIOUS"
  elif [[ "${QBT_FOCUSED_TEST_MODE:-}" == 1 ]]; then
    previous_release="$(readlink "$current_link" || true)"
  else
    previous_release="$(readlink -f "$current_link" || true)"
  fi
fi

verify_bundle() {
  local directory="$1"
  local manifest_path="${directory}/release-manifest.json"
  local expected_digest
  local actual_digest
  local member
  local -a members expected_members

  if [[ ! -d "$directory" || -L "$directory" || ! -s "$manifest_path" ]]; then
    echo "Release staging directory or manifest is missing." >&2
    return 1
  fi
  if find "$directory" -type l -print -quit | grep -q .; then
    echo "Release bundle contains a symlink." >&2
    return 1
  fi
  while IFS= read -r member; do members+=("${member#./}"); done < <(
    cd "$directory" && find . -type f -print | LC_ALL=C sort
  )
  expected_members=(
    "deploy/activate-release.sh"
    "deploy/activate-test-release.sh"
    "deploy/activation-maintenance-root.sh"
    "deploy/systemd/quadball-timer-test.service"
    "deploy/systemd/quadball-timer.service"
    "quadball-timer"
    "release-manifest.json"
  )
  if [[ "${members[*]}" != "${expected_members[*]}" ]]; then
    echo "Release bundle members do not match the allowlist." >&2
    return 1
  fi
  if ! grep -Fq "\"releaseAttemptId\":\"${release_id}\"" "$manifest_path"; then
    echo "Release manifest has the wrong release-attempt identity." >&2
    return 1
  fi
  expected_digest="$(sed -n 's/.*"executableSha256":"\([0-9a-f]\{64\}\)".*/\1/p' "$manifest_path")"
  actual_digest="$(sha256sum "${directory}/quadball-timer" | awk '{print $1}')"
  if [[ -z "$expected_digest" || "$expected_digest" != "$actual_digest" ]]; then
    echo "Release executable digest does not match its manifest." >&2
    return 1
  fi
  for member in "${expected_members[@]}"; do
    [[ "$member" == "release-manifest.json" ]] && continue
    actual_digest="$(sha256sum "${directory}/${member}" | awk '{print $1}')"
    if ! grep -Fq "\"path\":\"${member}\",\"sha256\":\"${actual_digest}\"" "$manifest_path"; then
      echo "Release member digest does not match its manifest: ${member}." >&2
      return 1
    fi
  done
}

if [[ -n "$staged_dir" ]]; then
  if [[ -e "$release_dir" ]]; then
    echo "Release-attempt identity already exists and cannot be overwritten: ${release_id}" >&2
    return 1
  fi
  if [[ "${QBT_FOCUSED_TEST_RELEASE_VERIFIED:-}" != 1 ]]; then verify_bundle "$staged_dir"; fi
  chmod u+w -- "$staged_dir"
  mv -- "$staged_dir" "$release_dir"
  cleanup_staged=0
  chmod -R a-w -- "$release_dir"
else
  if [[ ! -d "$release_dir" ]]; then
    echo "Release directory does not exist: ${release_dir}" >&2
    return 1
  fi
  if [[ "${QBT_FOCUSED_TEST_RELEASE_VERIFIED:-}" != 1 ]]; then verify_bundle "$release_dir"; fi
fi

if [[ "${QBT_FOCUSED_TEST_BATCH:-}" != 1 || "$focused_failure_phase" == preflight ]]; then
  if [[ ! -x "${release_dir}/quadball-timer" ]]; then
    echo "Compiled executable is missing or not executable: ${release_dir}/quadball-timer" >&2
    return 1
  fi
  if [[ "${QBT_FOCUSED_TEST_MODE:-}" != 1 ]] && ! grep -qw avx2 /proc/cpuinfo; then
    echo "Server CPU does not support AVX2, but this release uses bun-linux-x64-modern." >&2
    return 1
  fi

  expected_exec_start="${current_link}/quadball-timer"
  actual_exec_start="$(systemctl show "$service_name" --property=ExecStart --value 2>/dev/null || true)"
  if [[ "$actual_exec_start" != *"$expected_exec_start"* ]]; then
    echo "Systemd service ${service_name} does not run ${expected_exec_start}." >&2
    echo "Current ExecStart: ${actual_exec_start:-<unavailable>}" >&2
    return 1
  fi
fi

check_service_state_contract() {
  local effective_environment effective_state_directory effective_state_directory_mode
  effective_state_directory="$(systemctl show "$service_name" --property=StateDirectory --value 2>/dev/null || true)"
  effective_state_directory_mode="$(systemctl show "$service_name" --property=StateDirectoryMode --value 2>/dev/null || true)"
  effective_environment="$(systemctl show "$service_name" --property=Environment --value 2>/dev/null || true)"
  if [[ "$effective_state_directory" != "quadball-timer" ]] ||
    [[ "$effective_state_directory_mode" != "0750" ]] ||
    [[ " $effective_environment " != *" TECHNICAL_ADMIN_DATABASE=/var/lib/quadball-timer/technical-admin.sqlite "* ]] ||
    [[ " $effective_environment " != *" FOUNDATION_DATABASE=/var/lib/quadball-timer/foundation.sqlite "* ]] ||
    [[ " $effective_environment " != *" GRANT_KEY_RING_FILE=/etc/quadball-timer/production-grant-key-ring.json "* ]]
  then
    echo "Systemd service ${service_name} does not provide the required Production state contract." >&2
    echo "Install ${release_dir}/deploy/systemd/quadball-timer.service and run systemctl daemon-reload before activation." >&2
    return 1
  fi
}
if [[ "${QBT_FOCUSED_TEST_BATCH:-}" != 1 || "$focused_failure_phase" == preflight ]]; then
  check_service_state_contract
  schema_compatibility="$(sed -n 's/.*"schemaCompatibility":"\([^"]*\)".*/\1/p' "${release_dir}/release-manifest.json")"
  [[ -n "$schema_compatibility" ]] || { echo "Release schema compatibility is missing." >&2; return 1; }
  [[ -x "$maintenance_wrapper" ]] || { echo "Root maintenance boundary is not installed." >&2; return 1; }
  available_kb="$(df -Pk /var/lib/quadball-timer | awk 'NR == 2 {print $4}')"
  if [[ ! "$available_kb" =~ ^[0-9]+$ ]] || (( available_kb < 131072 )); then
    echo "Production state directory lacks the required disk reserve." >&2
    return 1
  fi
fi
echo "ACTIVATION_PHASE=migration"
if ! inject_focused_failure preflight; then return 1; fi
if ! sudo "$maintenance_wrapper" production "$release_dir" preflight >/dev/null; then
  echo "Production Foundation preflight/readiness failed; service was not stopped." >&2
  return 1
fi
echo "ACTIVATION_PHASE=backup"

# The service owns the writer boundary. The compiled maintenance mode reuses
# #81's Foundation recovery operation; it never opens the Technical Admin DB.
if ! inject_focused_failure quiesce-stop; then return 1; fi
sudo systemctl stop "$service_name"
service_stopped=1
if ! inject_focused_failure backup-create; then return 1; fi
maintenance_json="$(sudo "$maintenance_wrapper" production "$release_dir" backup)" || {
  echo "Production backup creation failed; previous verified backup preserved." >&2
  return 1
}
manifest_path="$(sed -n 's/.*"manifestPath":"\([^"]*\)".*/\1/p' <<<"$maintenance_json")"
[[ -n "$manifest_path" ]] || { echo "Production backup did not return a manifest." >&2; return 1; }
if ! inject_focused_failure backup-verify; then return 1; fi
if ! sudo "$maintenance_wrapper" production "$release_dir" verify-backup "$manifest_path"; then
  echo "Production backup independent verification failed; previous verified backup preserved." >&2
  return 1
fi
if ! inject_focused_failure backup-promote; then return 1; fi
if ! sudo "$maintenance_wrapper" production "$release_dir" promote "$manifest_path"; then
  echo "Verified backup promotion failed; previous retained backup preserved." >&2
  return 1
fi
echo "ACTIVATION_PHASE=migration"
if ! inject_focused_failure candidate-validation; then return 1; fi
if ! sudo "$maintenance_wrapper" production "$release_dir" validate-migration; then
  echo "Disposable migration candidate did not reach readiness." >&2
  return 1
fi
migration_attempted=1
if ! inject_focused_failure live-migration; then return 1; fi
if ! sudo "$maintenance_wrapper" production "$release_dir" apply-migrations; then
  echo "Live migration failed; database preserved without automatic restore." >&2
  return 1
fi

echo "ACTIVATION_PHASE=activation"
if ! inject_focused_failure release-switch; then return 1; fi
ln -sfn -- "$release_dir" "$current_link"

restart_service() { inject_focused_failure rollback-restart || return 1; sudo systemctl restart "$service_name"; }

report_service_state() {
  local property value
  echo "Service state after failed activation:" >&2
  for property in ActiveState SubState Result ExecMainStatus; do
    value="$(systemctl show "$service_name" --property="$property" --value 2>/dev/null || true)"
    echo "  ${property}=${value:-<unavailable>}" >&2
  done
}

check_release_identity() {
  local selected_release_id="$1"
  local selected_release_dir="$2"
  local identity_url="http://127.0.0.1:${port}/internal/release"
  local identity expected_digest candidate_schema
  identity="$(curl --fail --silent --show-error --max-time 2 "$identity_url")" || return 1
  expected_digest="$(sed -n 's/.*"executableSha256":"\([0-9a-f]\{64\}\)".*/\1/p' "${selected_release_dir}/release-manifest.json")"
  candidate_schema="$(sed -n 's/.*"schemaCompatibility":"\([^"]*\)".*/\1/p' "${selected_release_dir}/release-manifest.json")"
  grep -Fq "\"releaseAttemptId\":\"${selected_release_id}\"" <<<"$identity" || return 1
  grep -Fq "\"executableSha256\":\"${expected_digest}\"" <<<"$identity" || return 1
  grep -Fq "\"runningExecutableSha256\":\"${expected_digest}\"" <<<"$identity" || return 1
  grep -Fq "\"schemaCompatibility\":\"${candidate_schema}\"" <<<"$identity" || return 1
}

check_health() {
  local selected_release_id="$1"
  local selected_release_dir="$2"
  local internal_health_url="http://127.0.0.1:${port}/internal/healthz" root_url="http://127.0.0.1:${port}/"
  inject_focused_failure readiness || return 1
  for ((attempt = 1; attempt <= 20; attempt++)); do
    if curl --fail --silent --show-error --max-time 2 "$internal_health_url" >/dev/null &&
      curl --fail --silent --show-error --max-time 2 "$root_url" | grep -qi "<!doctype html" &&
      check_release_identity "$selected_release_id" "$selected_release_dir"
    then return 0; fi
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
  actual_schema="$(sudo "$maintenance_wrapper" production "$release_dir" preflight | sed -n 's/.*"schemaVersion":\([0-9][0-9]*\).*/\1/p')"
  [[ -n "$actual_schema" ]] || return 1
  supported_versions="$(sed -n 's/.*"supportedFoundationSchemaVersions":\[\([^]]*\)\].*/\1/p' "$previous_manifest")"
  [[ -n "$supported_versions" ]] || return 1
  [[ ",${supported_versions}," == *,"\"${actual_schema}\"",* ]]
}

prune_releases() {
  local current_release="$1" rollback_release="$2" release_path release_root
  local -a all_releases
  if [[ "${QBT_FOCUSED_TEST_MODE:-}" == 1 ]]; then return 0; fi
  release_root="$("$realpath_command" -e -- "${base_dir}/releases")" || return 1
  all_releases=()
  while IFS= read -r release_path; do all_releases+=("$release_path"); done < <(
    find "$release_root" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-
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

if restart_service && check_health "$release_id" "$release_dir" && check_representative_behavior; then
  prune_releases "$release_dir" "$previous_release"
  if ! inject_focused_failure final-report; then return 1; fi
  echo "Activated immutable release attempt ${release_id}."
  return 0
fi

report_service_state
echo "Deploy failed; attempting compatible binary rollback without restoring database state." >&2
if [[ -n "$previous_release" && -d "$previous_release" ]] && compatible_previous_release; then
  previous_release_id="${previous_release##*/}"
  ln -sfn -- "$previous_release" "$current_link"
  if restart_service && check_health "$previous_release_id" "$previous_release"; then
    echo "Rolled back to ${previous_release}." >&2
  else
    echo "Rollback of ${previous_release} failed health checks." >&2
  fi
else
  echo "No compatible previous release available for rollback." >&2
fi
return 1
}

if [[ "${QBT_FOCUSED_TEST_BATCH:-}" == 1 ]]; then
  mkdir -p -- "${base_dir}/releases" "${base_dir}/.staging"
  exec 9>"${base_dir}/.activation.lock"
  if ! flock -n 9; then
    echo "Another ${service_name} activation is already running." >&2
    exit 1
  fi
  focused_batch_directories=()
  for focused_batch_phase in ${QBT_FOCUSED_TEST_PHASES//,/ }; do
    focused_batch_directories+=("${focused_batch_output}/${focused_batch_phase}")
  done
  for focused_batch_directory in "${focused_batch_directories[@]}"; do
    if [[ -e "$focused_batch_directory" || -L "$focused_batch_directory" ]]; then
      echo "Focused batch phase evidence path already exists: ${focused_batch_directory}" >&2
      exit 1
    fi
  done
  for focused_batch_directory in "${focused_batch_directories[@]}"; do
    mkdir -- "$focused_batch_directory"
    focused_batch_directory_resolved="$(canonical_focused_directory "$focused_batch_directory")" || exit 1
    [[ "$focused_batch_directory_resolved" == "$focused_batch_directory" &&
      "$focused_batch_directory_resolved" == "$focused_batch_output"/* ]] || {
      echo "Focused batch phase evidence path escapes the disposable output root." >&2
      exit 1
    }
  done
  for focused_batch_phase in ${QBT_FOCUSED_TEST_PHASES//,/ }; do
    rm -f -- "$current_link"
    ln -s -- "$QBT_FAST_PREVIOUS" "$current_link"
    printf 'schema-before\n' >"$QBT_FAST_DATABASE"
    printf 'retained-before\n' >"$QBT_FAST_POINTER"
    rm -rf -- "$QBT_FAST_STATE/backup-candidate"
    : >"$QBT_FAST_LOG"
    focused_batch_directory="${focused_batch_output}/${focused_batch_phase}"
    if QBT_FOCUSED_FAILURE_PHASE="$focused_batch_phase" activation_attempt >"${focused_batch_directory}/output" 2>&1; then
      focused_batch_status=0
    else
      focused_batch_status=$?
    fi
    cleanup >>"${focused_batch_directory}/output" 2>&1 || true
    trap - EXIT
    printf '%s\n' "$focused_batch_status" >"${focused_batch_directory}/status"
    readlink "$current_link" >"${focused_batch_directory}/current"
    printf '%s\n' "$(<"$QBT_FAST_POINTER")" >"${focused_batch_directory}/pointer"
    printf '%s\n' "$(<"$QBT_FAST_DATABASE")" >"${focused_batch_directory}/database"
    cat -- "$QBT_FAST_LOG" >>"${focused_batch_directory}/output"
  done
  exit 1
fi
activation_attempt
exit $?
