#!/usr/bin/env bash
set -euo pipefail

base_dir="/srv/quadball-timer"
release_id=""
staged_dir=""
service_name="quadball-timer"
port="3000"
keep_releases=5

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

if [[ -n "$staged_dir" ]]; then
  if [[ "$staged_dir" != "$expected_staged_dir" ]]; then
    echo "Staging directory is outside the environment staging root." >&2
    exit 1
  fi
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
if ! flock -n 9; then
  echo "Another ${service_name} activation is already running." >&2
  exit 1
fi

if [[ -L "$current_link" || -d "$current_link" ]]; then
  previous_release="$(readlink -f "$current_link" || true)"
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
  mapfile -t members < <(find "$directory" -type f -printf '%P\n' | sort)
  expected_members=(
    "deploy/activate-release.sh"
    "deploy/activate-test-release.sh"
    "deploy/systemd/quadball-timer.service"
    "deploy/systemd/quadball-timer-test.service"
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
    exit 1
  fi
  verify_bundle "$staged_dir"
  chmod u+w -- "$staged_dir"
  mv -- "$staged_dir" "$release_dir"
  cleanup_staged=0
  chmod -R a-w -- "$release_dir"
else
  if [[ ! -d "$release_dir" ]]; then
    echo "Release directory does not exist: ${release_dir}" >&2
    exit 1
  fi
  verify_bundle "$release_dir"
fi

if [[ ! -x "${release_dir}/quadball-timer" ]]; then
  echo "Compiled executable is missing or not executable: ${release_dir}/quadball-timer" >&2
  exit 1
fi
if ! grep -qw avx2 /proc/cpuinfo; then
  echo "Server CPU does not support AVX2, but this release uses bun-linux-x64-modern." >&2
  exit 1
fi

expected_exec_start="${current_link}/quadball-timer"
actual_exec_start="$(systemctl show "$service_name" --property=ExecStart --value 2>/dev/null || true)"
if [[ "$actual_exec_start" != *"$expected_exec_start"* ]]; then
  echo "Systemd service ${service_name} does not run ${expected_exec_start}." >&2
  echo "Current ExecStart: ${actual_exec_start:-<unavailable>}" >&2
  exit 1
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
check_service_state_contract

ln -sfn -- "$release_dir" "$current_link"

restart_service() { sudo systemctl restart "$service_name"; }

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
  local identity expected_digest
  identity="$(curl --fail --silent --show-error --max-time 2 "$identity_url")" || return 1
  expected_digest="$(sed -n 's/.*"executableSha256":"\([0-9a-f]\{64\}\)".*/\1/p' "${selected_release_dir}/release-manifest.json")"
  grep -Fq "\"releaseAttemptId\":\"${selected_release_id}\"" <<<"$identity" || return 1
  grep -Fq "\"executableSha256\":\"${expected_digest}\"" <<<"$identity" || return 1
  grep -Fq "\"runningExecutableSha256\":\"${expected_digest}\"" <<<"$identity" || return 1
}

check_health() {
  local selected_release_id="$1"
  local selected_release_dir="$2"
  local internal_health_url="http://127.0.0.1:${port}/internal/healthz" root_url="http://127.0.0.1:${port}/"
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

if restart_service && check_health "$release_id" "$release_dir" && check_representative_behavior; then
  prune_releases "$release_dir" "$previous_release"
  echo "Activated immutable release attempt ${release_id}."
  exit 0
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
exit 1
