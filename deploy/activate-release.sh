#!/usr/bin/env bash
set -euo pipefail

base_dir="/srv/quadball-timer"
release_id=""
service_name="quadball-timer"
port="3000"
keep_releases=5

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

export PATH="$HOME/.bun/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun not found in PATH." >&2
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
bun install --frozen-lockfile --production

ln -sfn "$release_dir" "$current_link"

restart_service() {
  sudo systemctl restart "$service_name"
}

check_health() {
  local api_health_url="http://127.0.0.1:${port}/api/games"
  local root_url="http://127.0.0.1:${port}/"
  local attempt

  for attempt in $(seq 1 20); do
    if curl --fail --silent --show-error --max-time 2 "$api_health_url" >/dev/null &&
      curl --fail --silent --show-error --max-time 2 "$root_url" | grep -qi "<!doctype html"
    then
      return 0
    fi
    sleep 1
  done

  return 1
}

if restart_service && check_health; then
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
fi

echo "Deploy failed; attempting rollback." >&2
if [[ -n "$previous_release" && -d "$previous_release" ]]; then
  ln -sfn "$previous_release" "$current_link"
  sudo systemctl restart "$service_name" || true
fi

exit 1
