#!/usr/bin/env bash
set -euo pipefail

base_dir="/srv/quadball-timer"
release_id=""
service_name="quadball-timer"
port="3000"
keep_releases=5
executable_path="quadball-timer"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-dir)
      base_dir="${2:-}"
      shift 2
      ;;
    --release)
      release_id="${2:-}"
      shift 2
      ;;
    --service)
      service_name="${2:-}"
      shift 2
      ;;
    --port)
      port="${2:-}"
      shift 2
      ;;
    --keep-releases)
      keep_releases="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$release_id" ]]; then
  echo "Missing --release value." >&2
  exit 1
fi

if [[ ! "$release_id" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Invalid release value: ${release_id}" >&2
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

release_dir="${base_dir}/releases/${release_id}"
current_link="${base_dir}/current"
previous_release=""

if [[ ! -d "$release_dir" ]]; then
  echo "Release directory does not exist: ${release_dir}" >&2
  exit 1
fi

if [[ -L "$current_link" || -d "$current_link" ]]; then
  previous_release="$(readlink -f "$current_link" || true)"
fi

cd "$release_dir"

if [[ ! -x "${release_dir}/${executable_path}" ]]; then
  echo "Compiled executable is missing or not executable: ${release_dir}/${executable_path}" >&2
  exit 1
fi

if ! grep -qw avx2 /proc/cpuinfo; then
  echo "Server CPU does not support AVX2, but this release uses bun-linux-x64-modern." >&2
  exit 1
fi

expected_exec_start="${current_link}/${executable_path}"
actual_exec_start="$(systemctl show "$service_name" --property=ExecStart --value 2>/dev/null || true)"

if [[ "$actual_exec_start" != *"$expected_exec_start"* ]]; then
  echo "Systemd service ${service_name} does not run ${expected_exec_start}." >&2
  echo "Current ExecStart: ${actual_exec_start:-<unavailable>}" >&2
  exit 1
fi

ln -sfn "$release_dir" "$current_link"

restart_service() {
  sudo systemctl restart "$service_name"
}

check_health() {
  local internal_health_url="http://127.0.0.1:${port}/internal/healthz"
  local root_url="http://127.0.0.1:${port}/"
  for ((attempt = 1; attempt <= 20; attempt++)); do
    if curl --fail --silent --show-error --max-time 2 "$internal_health_url" >/dev/null &&
      curl --fail --silent --show-error --max-time 2 "$root_url" | grep -qi "<!doctype html"
    then
      return 0
    fi
    sleep 1
  done

  return 1
}

activate_release() {
  if [[ -d "${base_dir}/releases" ]]; then
    mapfile -t all_releases < <(ls -1dt "${base_dir}"/releases/* 2>/dev/null || true)
    release_count=0
    for release_path in "${all_releases[@]}"; do
      release_count=$((release_count + 1))
      if (( release_count > keep_releases )); then
        rm -rf "$release_path"
      fi
    done
  fi

  echo "Activated release ${release_id}."
  exit 0
}

if restart_service && check_health; then
  activate_release
fi

echo "Deploy failed; attempting rollback." >&2
if [[ -n "$previous_release" && -d "$previous_release" ]]; then
  ln -sfn "$previous_release" "$current_link"
  if restart_service && check_health; then
    echo "Rolled back to ${previous_release}." >&2
  else
    echo "Rollback to ${previous_release} failed health checks." >&2
  fi
else
  echo "No previous release available for rollback." >&2
fi

exit 1
