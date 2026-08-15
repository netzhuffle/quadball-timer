#!/usr/bin/env bash
set -euo pipefail

environment="${1:-}"
release_dir="${2:-}"
command="${3:-}"
manifest_path="${4:-}"
case "$environment" in
  production)
    service_user="quadball-timer"
    service_name="quadball-timer"
    public_origin="https://timer.quadball.app"
    expected_caller="deploy-quadball-timer"
    release_base="/srv/quadball-timer"
    database_dir="/var/lib/quadball-timer"
    technical_admin_database="$database_dir/technical-admin.sqlite"
    foundation_database="$database_dir/foundation.sqlite"
    key_ring_file="/etc/quadball-timer/production-grant-key-ring.json"
    backup_directory="/var/backups/quadball-timer"
    ;;
  test)
    service_user="quadball-timer-test"
    service_name="quadball-timer-test"
    public_origin="https://test.timer.quadball.app"
    expected_caller="deploy-quadball-timer-test"
    release_base="/srv/quadball-timer-test"
    database_dir="/var/lib/quadball-timer-test"
    technical_admin_database="$database_dir/technical-admin.sqlite"
    foundation_database="$database_dir/foundation.sqlite"
    key_ring_file="/etc/quadball-timer/test-grant-key-ring.json"
    backup_directory=""
    ;;
  *) echo "Unsupported Environment." >&2; exit 2 ;;
esac
focused_test_mode="${QBT_FOCUSED_TEST_MODE:-}"
focused_test_root="${QBT_FOCUSED_TEST_ROOT:-}"
focused_failure_phase="${QBT_FOCUSED_FAILURE_PHASE:-}"
ad_hoc_database="$database_dir/ad-hoc.sqlite"
ad_hoc_environment_identity="$environment:$public_origin"
if [[ "$focused_test_mode" == 1 ]]; then
  [[ "$EUID" -ne 0 && -n "$focused_test_root" && "$focused_test_root" == /* ]] || {
    echo "Focused activation mode requires a non-root disposable absolute root." >&2
    exit 2
  }
  case "$focused_test_root" in
    /|*..*|*//* ) echo "Focused activation root is unsafe." >&2; exit 2 ;;
  esac
  [[ -d "$focused_test_root" && ! -L "$focused_test_root" ]] || { echo "Focused activation root is not a real directory." >&2; exit 2; }
  focused_test_root_resolved="$(cd -- "$focused_test_root" && pwd -P)" || { echo "Focused activation root is inaccessible." >&2; exit 2; }
  [[ "$focused_test_root_resolved" == "$focused_test_root" ]] || { echo "Focused activation root is not canonical." >&2; exit 2; }
  focused_test_root="$focused_test_root_resolved"
  export QBT_FOCUSED_TEST_ROOT="$focused_test_root"
  release_base="$focused_test_root${release_base}"
  database_dir="$focused_test_root${database_dir}"
  ad_hoc_database="$database_dir/ad-hoc.sqlite"
  technical_admin_database="$focused_test_root${technical_admin_database}"
  foundation_database="$focused_test_root${foundation_database}"
  key_ring_file="$focused_test_root${key_ring_file}"
  [[ -n "$backup_directory" ]] && backup_directory="$focused_test_root${backup_directory}"
fi
systemctl_command="${QBT_FOCUSED_TEST_SYSTEMCTL:-systemctl}"
runuser_command="${QBT_FOCUSED_TEST_RUNUSER:-/usr/sbin/runuser}"
flock_command="${QBT_FOCUSED_TEST_FLOCK:-flock}"
realpath_command="${QBT_FOCUSED_TEST_REALPATH:-realpath}"
[[ "$release_dir" == "$release_base"/releases/* ]] || { echo "Unsafe release path." >&2; exit 2; }
[[ "$release_dir" != *..* && "$release_dir" != *//* ]] || { echo "Unsafe release path." >&2; exit 2; }
[[ -d "$release_dir" && ! -L "$release_dir" ]] || { echo "Unsafe release path." >&2; exit 2; }
resolved_release_dir="$($realpath_command -e -- "$release_dir")"
[[ "$resolved_release_dir" == "$release_base"/releases/* && "$resolved_release_dir" == "$release_dir" ]] || {
  echo "Release path is not canonical." >&2
  exit 2
}
[[ -x "$release_dir/quadball-timer" && -f "$release_dir/release-manifest.json" ]] || {
  echo "Maintenance release is incomplete." >&2
  exit 1
}
release_attempt_id="$(sed -n 's/.*"releaseAttemptId":"\([^"]*\)".*/\1/p' "$release_dir/release-manifest.json")"
schema_compatibility="$(sed -n 's/.*"schemaCompatibility":"\([^"]*\)".*/\1/p' "$release_dir/release-manifest.json")"
[[ -n "$release_attempt_id" && -n "$schema_compatibility" ]] || {
  echo "Maintenance release identity is incomplete." >&2
  exit 1
}
[[ "$release_attempt_id" =~ ^[A-Za-z0-9._-]+$ && "$(basename -- "$release_dir")" == "$release_attempt_id" ]] || {
  echo "Maintenance release identity does not match its path." >&2
  exit 2
}
[[ ! -L "$release_dir/quadball-timer" && ! -L "$release_dir/release-manifest.json" ]] || {
  echo "Maintenance release contains symlinked inputs." >&2
  exit 2
}
case "$command" in
  backup|verify-backup|promote)
    [[ "$environment" == production ]] || { echo "Production backup operations only." >&2; exit 2; }
    [[ "${SUDO_USER:-}" == "$expected_caller" ]] || { echo "Invalid maintenance caller." >&2; exit 2; }
    [[ "$($systemctl_command is-active quadball-timer 2>/dev/null || true)" == inactive ]] || { echo "Production service must be inactive." >&2; exit 1; }
    exec 9>"$release_base/.activation.lock"
    if QBT_ACTIVATION_LOCK_PATH="$release_base/.activation.lock" "$flock_command" -n 9; then echo "Activation lock is not held by the orchestrator." >&2; exit 1; fi
    ;;
  validate-migration|apply-migrations)
    [[ "${SUDO_USER:-}" == "$expected_caller" ]] || { echo "Invalid maintenance caller." >&2; exit 2; }
    [[ "$($systemctl_command is-active "$service_name" 2>/dev/null || true)" == inactive ]] || { echo "Service must be inactive." >&2; exit 1; }
    exec 9>"$release_base/.activation.lock"
    if QBT_ACTIVATION_LOCK_PATH="$release_base/.activation.lock" "$flock_command" -n 9; then echo "Activation lock is not held by the orchestrator." >&2; exit 1; fi
    ;;
  readiness|preflight)
    [[ "${SUDO_USER:-}" == "$expected_caller" ]] || { echo "Invalid maintenance caller." >&2; exit 2; }
    ;;
  *) echo "Unsupported maintenance operation." >&2; exit 2 ;;
esac
if [[ "$environment" == production && "$command" != readiness && "$command" != preflight && "$command" != validate-migration && "$command" != apply-migrations ]]; then
  if [[ -e "$backup_directory" || -L "$backup_directory" ]]; then
    [[ -d "$backup_directory" && ! -L "$backup_directory" ]] || { echo "Backup root is missing or symlinked." >&2; exit 2; }
    [[ "$($realpath_command -e -- "$backup_directory")" == "$backup_directory" ]] || { echo "Backup root is not canonical." >&2; exit 2; }
  else
    [[ "$($realpath_command -e -- "$(dirname -- "$backup_directory")")" == "$(dirname -- "$backup_directory")" ]] || { echo "Backup parent is not canonical." >&2; exit 2; }
    if [[ "$focused_test_mode" == 1 ]]; then mkdir -p "$backup_directory"; chmod 0750 "$backup_directory"; else install -d -o root -g "$service_user" -m 0750 "$backup_directory"; fi
  fi
  if [[ "$focused_test_mode" != 1 ]]; then
    [[ "$(stat -c '%U:%G:%a' "$backup_directory")" == "root:${service_user}:750" ]] || { echo "Backup root ownership or mode drifted." >&2; exit 2; }
  fi
fi
if [[ "$command" == "backup" ]]; then
  operation_backup_directory="$backup_directory/.candidate-${release_attempt_id}"
  if [[ "$focused_test_mode" == 1 ]]; then rm -rf "$operation_backup_directory"; mkdir -p "$operation_backup_directory"; chmod 0700 "$operation_backup_directory"; else rm -rf -- "$operation_backup_directory"; install -d -o "$service_user" -g "$service_user" -m 0700 "$operation_backup_directory"; fi
elif [[ "$command" == "verify-backup" ]]; then
  operation_backup_directory="$backup_directory/.candidate-${release_attempt_id}"
  [[ "$manifest_path" == "$operation_backup_directory"/* && "$manifest_path" != *..* ]] || { echo "Unsafe backup manifest path." >&2; exit 2; }
  manifest_path="$($realpath_command -e -- "$manifest_path")"
  [[ "$manifest_path" == "$operation_backup_directory"/* && ! -L "$manifest_path" ]] || { echo "Backup manifest is not canonical." >&2; exit 2; }
elif [[ "$command" == "promote" ]]; then
  operation_backup_directory="$backup_directory/.candidate-${release_attempt_id}"
else
  operation_backup_directory="${backup_directory:-$database_dir}"
fi
if [[ "$command" == "promote" ]]; then
  candidate_directory="$backup_directory/.candidate-${release_attempt_id}"
  [[ "$manifest_path" == "$candidate_directory"/* && "$manifest_path" != *..* ]] || { echo "Unsafe backup manifest path." >&2; exit 2; }
  manifest_path="$($realpath_command -e -- "$manifest_path")"
  [[ "$manifest_path" == "$candidate_directory"/* && ! -L "$manifest_path" ]] || { echo "Backup manifest is not canonical." >&2; exit 2; }
fi
set +e
foundation_backup_directory="$operation_backup_directory"
[[ "$command" == "promote" ]] && foundation_backup_directory="$backup_directory"
"$runuser_command" -u "$service_user" -- env -i PATH=/usr/bin:/bin \
  QUADBALL_ENVIRONMENT="$environment" \
  NODE_ENV=production \
  PUBLIC_ORIGIN="$public_origin" \
  TECHNICAL_ADMIN_DATABASE="$technical_admin_database" \
  FOUNDATION_DATABASE="$foundation_database" \
  AD_HOC_DATABASE="$ad_hoc_database" \
  EVENT_GAME_DATABASE="$database_dir/event-game.sqlite" \
  GRANT_KEY_RING_FILE="$key_ring_file" \
  FOUNDATION_BACKUP_DIRECTORY="$foundation_backup_directory" \
  RELEASE_ATTEMPT_ID="$release_attempt_id" \
  SCHEMA_COMPATIBILITY="$schema_compatibility" \
  RELEASE_MANIFEST_PATH="$release_dir/release-manifest.json" \
  BACKUP_MANIFEST_PATH="$manifest_path" \
  QBT_FOCUSED_TEST_MODE="$focused_test_mode" \
  QBT_FOCUSED_TEST_ROOT="$focused_test_root" \
  AD_HOC_ENVIRONMENT_ID="$ad_hoc_environment_identity" \
  QBT_FOCUSED_FAILURE_PHASE="$focused_failure_phase" \
  "$release_dir/quadball-timer" --production-activation "$command"
rc=$?
set -e
if (( rc != 0 )) && [[ "$command" == "backup" || "$command" == "verify-backup" || "$command" == "promote" ]]; then
  if [[ "$focused_test_mode" == 1 ]]; then chmod -R u+w "$operation_backup_directory" 2>/dev/null || true; rm -rf "$operation_backup_directory"; else chmod -R u+w -- "$operation_backup_directory" 2>/dev/null || true; rm -rf -- "$operation_backup_directory"; fi
fi
exit "$rc"
