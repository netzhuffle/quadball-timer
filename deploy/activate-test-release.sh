#!/usr/bin/env bash
set -euo pipefail

base_dir="/srv/quadball-timer-test"
service_name="quadball-timer-test"
port="3001"
release_id=""
keep_releases=5

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release)
      release_id="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ ! "$release_id" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Invalid Test release commit." >&2
  exit 1
fi

release_dir="${base_dir}/releases/${release_id}"
current_link="${base_dir}/current"
manifest_path="${release_dir}/release-manifest.json"
previous_release=""

if [[ ! -d "$release_dir" ]]; then
  echo "Test release directory does not exist: ${release_dir}" >&2
  exit 1
fi
if [[ ! -x "${release_dir}/quadball-timer" ]]; then
  echo "Test executable is missing or not executable." >&2
  exit 1
fi
if [[ ! -s "$manifest_path" ]]; then
  echo "Test release manifest is missing." >&2
  exit 1
fi
if ! grep -Fq '"environment":"test"' "$manifest_path" ||
  ! grep -Fq "\"sourceCommit\":\"${release_id}\"" "$manifest_path"; then
  echo "Test release manifest has the wrong environment or source commit." >&2
  exit 1
fi

if ! grep -qw avx2 /proc/cpuinfo; then
  echo "Server CPU does not support AVX2, but this release uses bun-linux-x64-modern." >&2
  exit 1
fi

expected_digest="$(sed -n 's/.*"executableSha256":"\([0-9a-f]\{64\}\)".*/\1/p' "$manifest_path")"
actual_digest="$(sha256sum "${release_dir}/quadball-timer" | awk '{print $1}')"
if [[ -z "$expected_digest" || "$expected_digest" != "$actual_digest" ]]; then
  echo "Test executable digest does not match the release manifest." >&2
  exit 1
fi

if [[ -L "$current_link" || -d "$current_link" ]]; then
  previous_release="$(readlink -f "$current_link" || true)"
fi

expected_exec_start="${current_link}/quadball-timer"
actual_exec_start="$(systemctl show "$service_name" --property=ExecStart --value 2>/dev/null || true)"
if [[ "$actual_exec_start" != *"$expected_exec_start"* ]]; then
  echo "Test service does not run ${expected_exec_start}." >&2
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
    [[ " $effective_environment " != *" EVENT_GAME_DATABASE=/var/lib/quadball-timer-test/event-game.sqlite "* ]]; then
    echo "Test service does not provide the required isolated state contract." >&2
    echo "Install ${release_dir}/deploy/systemd/quadball-timer-test.service and run systemctl daemon-reload." >&2
    return 1
  fi
}

check_service_contract
ln -sfn "$release_dir" "$current_link"

restart_service() {
  sudo systemctl restart "$service_name"
}

check_health() {
  local internal_health_url="http://127.0.0.1:${port}/internal/healthz"
  local root_url="http://127.0.0.1:${port}/"
  for ((attempt = 1; attempt <= 20; attempt++)); do
    if curl --fail --silent --show-error --max-time 2 "$internal_health_url" >/dev/null &&
      curl --fail --silent --show-error --max-time 2 "$root_url" | grep -Fq "Test environment — not for live games"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

if restart_service && check_health; then
  mapfile -t all_releases < <(ls -1dt "${base_dir}"/releases/* 2>/dev/null || true)
  release_count=0
  for release_path in "${all_releases[@]}"; do
    release_count=$((release_count + 1))
    if (( release_count > keep_releases )) && [[ "$release_path" != "$current_link" ]]; then
      rm -rf "$release_path"
    fi
  done
  echo "Activated Test release ${release_id} (${actual_digest})."
  exit 0
fi

echo "Test deployment failed; attempting rollback." >&2
if [[ -n "$previous_release" && -d "$previous_release" ]]; then
  ln -sfn "$previous_release" "$current_link"
  if restart_service && check_health; then
    echo "Rolled back Test to ${previous_release}." >&2
  else
    echo "Rollback of Test failed health checks." >&2
  fi
else
  echo "No previous Test release available for rollback." >&2
fi
exit 1
