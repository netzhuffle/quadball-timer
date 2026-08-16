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
test_harness_mode=0
mv_command="mv"
stat_command="stat"
skip_chown=0
before_previous_rm_command=""
ad_hoc_database="$database_dir/ad-hoc.sqlite"
ad_hoc_environment_identity="$environment:$public_origin"
technical_admin_bootstrap_path="/usr/local/sbin/quadball-timer-technical-admin-bootstrap"
TECHNICAL_ADMIN_BOOTSTRAP_SHA256="4bff44f74229c8626f60fba2cff5b042f51b50ab03c9fe19fb36af33ef7abfba"
temporary_bootstrap_path=""
temporary_bootstrap_directory=""

# shellcheck disable=SC2329
cleanup_bootstrap_temporary_state() {
  if [[ -n "$temporary_bootstrap_path" ]]; then
    rm -f -- "$temporary_bootstrap_path" 2>/dev/null || true
    temporary_bootstrap_path=""
  fi
  if [[ "$focused_test_mode" == 1 && -n "$temporary_bootstrap_directory" ]]; then
    rmdir -- "$temporary_bootstrap_directory" 2>/dev/null || true
    temporary_bootstrap_directory=""
  fi
}
trap cleanup_bootstrap_temporary_state EXIT

configure_promotion_test_hooks() {
  if [[ "$test_harness_mode" != 1 ]]; then
    return 0
  fi
  [[ "$EUID" -ne 0 && -n "$focused_test_root" && "$focused_test_root" == /* ]] || {
    echo "Promotion test hooks require a non-root absolute disposable root." >&2
    return 2
  }
  case "$focused_test_root" in
    /|*..*|*//* )
      echo "Promotion test hooks require a safe disposable root." >&2
      return 2
      ;;
  esac
  [[ -d "$focused_test_root" && ! -L "$focused_test_root" ]] || {
    echo "Promotion test hooks require a real disposable root." >&2
    return 2
  }
  local resolved_test_root=""
  resolved_test_root="$(cd -- "$focused_test_root" 2>/dev/null && pwd -P)" || {
    echo "Promotion test hooks require an accessible disposable root." >&2
    return 2
  }
  [[ "$resolved_test_root" == "$focused_test_root" ]] || {
    echo "Promotion test hooks require a canonical disposable root." >&2
    return 2
  }
  mv_command="${QBT_FOCUSED_TEST_MV:-mv}"
  stat_command="${QBT_FOCUSED_TEST_STAT:-stat}"
  skip_chown="${QBT_FOCUSED_TEST_SKIP_CHOWN:-0}"
  before_previous_rm_command="${QBT_FOCUSED_TEST_BEFORE_PREVIOUS_RM:-}"
}

promote_verified_backup_as_root() {
  local candidate_directory="$1"
  local manifest_path="$2"
  local release_attempt_id="$3"
  local retained_pointer="$backup_directory/retained"
  local retained_version="$backup_directory/verified-$release_attempt_id"
  local temporary_pointer="$backup_directory/.retained-$release_attempt_id.tmp"
  local previous_target=""
  local previous_path=""
  local previous_identity=""
  local previous_fd_open=0
  local previous_fd_identity=""
  local previous_cleanup_allowed=0
  local previous_cleanup_warning=""

  [[ "$candidate_directory" == "$backup_directory/.candidate-$release_attempt_id" ]] || {
    echo "Unsafe backup candidate path." >&2
    return 1
  }
  [[ "$manifest_path" == "$candidate_directory"/* && "$manifest_path" != *..* ]] || {
    echo "Unsafe backup manifest path." >&2
    return 1
  }
  [[ -d "$candidate_directory" && ! -L "$candidate_directory" ]] || {
    echo "Production backup candidate directory is not a regular directory." >&2
    return 1
  }
  [[ -f "$manifest_path" && ! -L "$manifest_path" ]] || {
    echo "Production backup manifest is not a regular file." >&2
    return 1
  }
  if [[ -e "$retained_pointer" || -L "$retained_pointer" ]]; then
    [[ -L "$retained_pointer" ]] || {
      echo "Retained backup pointer is not a symlink." >&2
      return 1
    }
    previous_target="$(readlink -- "$retained_pointer")"
    [[ "$previous_target" != "verified-$release_attempt_id" ]] || {
      echo "Production backup release is already retained." >&2
      return 1
    }
    if [[ ! "$previous_target" =~ ^verified-[A-Za-z0-9._-]+$ ]]; then
      previous_cleanup_warning="previous retained backup cleanup skipped: target namespace is invalid"
    else
      previous_path="$backup_directory/$previous_target"
      if [[ ! -d "$previous_path" || -L "$previous_path" ]]; then
        previous_cleanup_warning="previous retained backup cleanup skipped: target is not a directory"
      elif [[ "$($realpath_command -e -- "$previous_path")" != "$previous_path" ]]; then
        previous_cleanup_warning="previous retained backup cleanup skipped: target is not canonical"
      elif [[ "$focused_test_mode" != 1 ]] && ! previous_identity="$($stat_command -c '%d:%i' -- "$previous_path")"; then
        previous_cleanup_warning="previous retained backup cleanup skipped: target identity unavailable"
      else
        previous_cleanup_allowed=1
      fi
    fi
  fi
  if [[ -e "$retained_version" || -L "$retained_version" ]]; then
    [[ -d "$retained_version" && ! -L "$retained_version" ]] || {
      echo "Retained backup destination is not a regular directory." >&2
      return 1
    }
    if ! rm -rf -- "$retained_version"; then
      echo "Retained backup destination could not be replaced." >&2
      return 1
    fi
  fi
  if ! rm -f -- "$temporary_pointer"; then
    echo "Temporary retained backup pointer could not be removed." >&2
    return 1
  fi

  # The service has just finished the full semantic re-verification. Freeze
  # that exact candidate under root ownership before moving it into the
  # retained area; the service group never receives write access to the
  # root-controlled backup parent or retained snapshot.
  local candidate_symlink=""
  if ! candidate_symlink="$(find -P "$candidate_directory" -type l -print -quit)"; then
    echo "Production backup candidate could not be inspected." >&2
    return 1
  fi
  if [[ -n "$candidate_symlink" ]]; then
    echo "Production backup candidate contains a symlink." >&2
    return 1
  fi
  if [[ "$skip_chown" != 1 ]]; then
    if ! chown -R root:root -- "$candidate_directory"; then
      echo "Production backup candidate could not be root-owned." >&2
      return 1
    fi
  fi
  if ! find -P "$candidate_directory" -type d -exec chmod 0700 {} +; then
    echo "Production backup candidate directory modes could not be fixed." >&2
    return 1
  fi
  if ! find -P "$candidate_directory" -type f -exec chmod 0600 {} +; then
    echo "Production backup candidate file modes could not be fixed." >&2
    return 1
  fi

  if ! mv -- "$candidate_directory" "$retained_version"; then
    echo "Verified backup promotion failed before pointer replacement." >&2
    return 1
  fi
  if ! ln -s -- "$(basename -- "$retained_version")" "$temporary_pointer"; then
    echo "Verified backup promotion failed before pointer replacement." >&2
    rm -rf -- "$retained_version"
    return 1
  fi
  if [[ "$focused_test_mode" != 1 && "$previous_cleanup_allowed" == 1 ]]; then
    # Hold the validated directory open across pointer replacement. The
    # orchestrator owns fd 9 for its activation lock; fd 8 is reserved here
    # so inode reuse cannot make a replacement object look unchanged.
    if ! exec 8<"$previous_path"; then
      previous_cleanup_warning="previous retained backup cleanup skipped: target could not be held"
      previous_cleanup_allowed=0
    elif ! previous_fd_identity="$($stat_command -L -c '%d:%i' -- "/proc/self/fd/8")" ||
      [[ "$previous_fd_identity" != "$previous_identity" ]]; then
      exec 8<&-
      previous_cleanup_warning="previous retained backup cleanup skipped: target identity changed"
      previous_cleanup_allowed=0
    else
      previous_fd_open=1
    fi
  fi
  if [[ "$focused_test_mode" == 1 ]]; then
    # BSD mv follows a symlink destination.  Focused mode is disposable and
    # non-root, so remove only this validated pointer before the replacement;
    # Production runs on Linux and uses mv -T for a true no-dereference rename.
    if ! rm -f -- "$retained_pointer" || ! "$mv_command" -- "$temporary_pointer" "$retained_pointer"; then
      echo "Verified backup promotion failed before pointer replacement." >&2
      if [[ "$previous_fd_open" == 1 ]]; then
        exec 8<&-
        previous_fd_open=0
      fi
      rm -f -- "$temporary_pointer"
      rm -rf -- "$retained_version"
      return 1
    fi
  elif ! "$mv_command" -T -- "$temporary_pointer" "$retained_pointer"; then
    echo "Verified backup promotion failed before pointer replacement." >&2
    if [[ "$previous_fd_open" == 1 ]]; then
      exec 8<&-
      previous_fd_open=0
    fi
    rm -f -- "$temporary_pointer"
    rm -rf -- "$retained_version"
    return 1
  fi
  local cleanup_warning="$previous_cleanup_warning"
  if [[ -n "$previous_target" && "$previous_cleanup_allowed" == 1 ]]; then
    local current_previous_target=""
    if [[ -n "$before_previous_rm_command" ]] && ! "$before_previous_rm_command" "$previous_path"; then
      cleanup_warning="previous retained backup cleanup failed"
    elif ! current_previous_target="$(readlink -- "$retained_pointer")" ||
      [[ "$current_previous_target" != "$(basename -- "$retained_version")" ]] ||
      [[ ! -d "$previous_path" || -L "$previous_path" ]] ||
      [[ "$($realpath_command -e -- "$previous_path")" != "$previous_path" ]] ||
      [[ "$focused_test_mode" != 1 && "$($stat_command -c '%d:%i' -- "$previous_path")" != "$previous_fd_identity" ]]; then
      cleanup_warning="previous retained backup cleanup failed"
    elif ! rm -rf -- "$previous_path"; then
      cleanup_warning="previous retained backup cleanup failed"
    else
      cleanup_warning=""
    fi
  fi
  if [[ "$previous_fd_open" == 1 ]]; then
    exec 8<&-
    previous_fd_open=0
  fi
  if [[ -n "$cleanup_warning" ]]; then
    printf '{"pointerCommitted":true,"retainedTarget":"%s","cleanupWarning":"%s"}\n' \
      "$(basename -- "$retained_version")" "$cleanup_warning"
  else
    printf '{"pointerCommitted":true,"retainedTarget":"%s","cleanupWarning":null}\n' \
      "$(basename -- "$retained_version")"
  fi
}

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
  test_harness_mode=1
  export QBT_FOCUSED_TEST_ROOT="$focused_test_root"
  release_base="$focused_test_root${release_base}"
  database_dir="$focused_test_root${database_dir}"
  ad_hoc_database="$database_dir/ad-hoc.sqlite"
  technical_admin_database="$focused_test_root${technical_admin_database}"
  foundation_database="$focused_test_root${foundation_database}"
  key_ring_file="$focused_test_root${key_ring_file}"
  technical_admin_bootstrap_path="$focused_test_root$technical_admin_bootstrap_path"
  [[ -n "$backup_directory" ]] && backup_directory="$focused_test_root${backup_directory}"
fi
configure_promotion_test_hooks || exit 2
systemctl_command="${QBT_FOCUSED_TEST_SYSTEMCTL:-systemctl}"
runuser_command="${QBT_FOCUSED_TEST_RUNUSER:-/usr/sbin/runuser}"
flock_command="${QBT_FOCUSED_TEST_FLOCK:-flock}"
realpath_command="${QBT_FOCUSED_TEST_REALPATH:-realpath}"
install_command="${QBT_FOCUSED_TEST_INSTALL:-/usr/bin/install}"
mktemp_command="${QBT_FOCUSED_TEST_MKTEMP:-/usr/bin/mktemp}"
sha256sum_command="${QBT_FOCUSED_TEST_SHA256SUM:-/usr/bin/sha256sum}"
stat_command="${QBT_FOCUSED_TEST_STAT:-/usr/bin/stat}"
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
  install-technical-admin-bootstrap)
    [[ "$focused_test_mode" == 1 || "${SUDO_USER:-}" == "$expected_caller" ]] || {
      echo "Invalid maintenance caller." >&2
      exit 2
    }
    current_link="${release_base}/current"
    [[ -L "$current_link" && "$($realpath_command -e -- "$current_link")" == "$release_dir" ]] || {
      echo "Technical Admin bootstrap installation requires the active release." >&2
      exit 1
    }
    source_path="$release_dir/deploy/technical-admin-bootstrap-root.sh"
    [[ -f "$source_path" && ! -L "$source_path" && -x "$source_path" ]] || {
      echo "Maintenance release is missing the Technical Admin bootstrap runner." >&2
      exit 1
    }
    if [[ "$focused_test_mode" == 1 ]]; then
      temporary_bootstrap_directory="$focused_test_root/run"
      "$install_command" -d -m 0700 -- "$temporary_bootstrap_directory"
    else
      temporary_bootstrap_directory="/run"
      [[ -d "$temporary_bootstrap_directory" && ! -L "$temporary_bootstrap_directory" ]] || {
        echo "Technical Admin bootstrap temporary root is unavailable." >&2
        exit 1
      }
    fi
    temporary_bootstrap_path="$("$mktemp_command" "$temporary_bootstrap_directory/quadball-timer-technical-admin-bootstrap.XXXXXX")" || {
      echo "Technical Admin bootstrap temporary file could not be created." >&2
      exit 1
    }
    [[ -f "$temporary_bootstrap_path" && ! -L "$temporary_bootstrap_path" ]] || {
      echo "Technical Admin bootstrap temporary file is unsafe." >&2
      exit 2
    }
    if [[ "$focused_test_mode" == 1 ]]; then
      "$install_command" -m 0600 -- "$source_path" "$temporary_bootstrap_path"
    else
      "$install_command" -o root -g root -m 0600 -- "$source_path" "$temporary_bootstrap_path"
      [[ "$("$stat_command" -c '%U:%G:%a' "$temporary_bootstrap_path")" == "root:root:600" ]] || {
        echo "Technical Admin bootstrap temporary file ownership or mode drifted." >&2
        exit 2
      }
    fi
    temporary_digest="$("$sha256sum_command" "$temporary_bootstrap_path" | awk '{print $1}')"
    [[ "$temporary_digest" == "$TECHNICAL_ADMIN_BOOTSTRAP_SHA256" ]] || {
      echo "Technical Admin bootstrap runner trust verification failed." >&2
      exit 1
    }
    if [[ "$focused_test_mode" == 1 ]]; then
      "$install_command" -d -m 0755 -- "$(dirname -- "$technical_admin_bootstrap_path")"
      "$install_command" -m 0755 -- "$temporary_bootstrap_path" "$technical_admin_bootstrap_path"
    else
      "$install_command" -o root -g root -m 0755 -- "$temporary_bootstrap_path" "$technical_admin_bootstrap_path"
    fi
    [[ "$("$sha256sum_command" "$technical_admin_bootstrap_path" | awk '{print $1}')" == "$TECHNICAL_ADMIN_BOOTSTRAP_SHA256" ]] || {
      echo "Technical Admin bootstrap runner digest verification failed." >&2
      exit 2
    }
    if [[ "$focused_test_mode" != 1 ]]; then
      [[ "$("$stat_command" -c '%U:%G:%a' "$technical_admin_bootstrap_path")" == "root:root:755" ]] || {
        echo "Technical Admin bootstrap runner ownership or mode drifted." >&2
        exit 2
      }
    fi
    exit 0
    ;;
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
root_promotion=""
[[ "$command" == "promote" ]] && root_promotion=1
if [[ "$command" == "promote" ]]; then
  maintenance_output="$("$runuser_command" -u "$service_user" -- env -i PATH=/usr/bin:/bin \
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
  QBT_ROOT_PROMOTION="$root_promotion" \
  "$release_dir/quadball-timer" --production-activation "$command" --root-promotion 2>&1)"
  rc=$?
else
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
  QBT_ROOT_PROMOTION="$root_promotion" \
  "$release_dir/quadball-timer" --production-activation "$command"
  rc=$?
fi
set -e
if [[ "$command" == "promote" ]]; then
  if (( rc != 0 )); then
    if (( ${#maintenance_output} > 4096 )); then
      printf '%s\n' "${maintenance_output:0:4096}" >&2
      echo "Activation maintenance output truncated." >&2
    else
      printf '%s\n' "$maintenance_output" >&2
    fi
  else
    if ! promote_verified_backup_as_root "$operation_backup_directory" "$manifest_path" "$release_attempt_id"; then
      rc=1
    fi
  fi
fi
if (( rc != 0 )) && [[ "$command" == "backup" || "$command" == "verify-backup" || "$command" == "promote" ]]; then
  if [[ "$focused_test_mode" == 1 ]]; then chmod -R u+w "$operation_backup_directory" 2>/dev/null || true; rm -rf "$operation_backup_directory"; else chmod -R u+w -- "$operation_backup_directory" 2>/dev/null || true; rm -rf -- "$operation_backup_directory"; fi
fi
exit "$rc"
