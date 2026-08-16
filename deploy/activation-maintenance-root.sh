#!/usr/bin/env bash
set -euo pipefail

environment="${1:-}"
release_dir="${2:-}"
command="${3:-}"
manifest_path="${4:-}"
restore_report_emitted=0
restore_result_emitted=0
restore_error_fd=2
if [[ "$command" == restore ]]; then
  exec 8>&2
  exec 2>/dev/null
  restore_error_fd=8
fi

restore_preparation_failure() {
  local outcome="$1"
  local status="${2:-1}"
  if declare -F detach_operational_report >/dev/null; then
    detach_operational_report restore staged-restore failed staged-restore
  fi
  printf '{"restored":false,"outcome":"%s","cutoverCompleted":false,"technicalAdminAuth":{"outcome":"not-attempted","credentialPreserved":false,"reEnrollmentRequired":false}}\n' "$outcome" >&${restore_error_fd}
  restore_report_emitted=1
  exit "$status"
}

maintenance_preflight_failure() {
  local outcome="$1"
  local status="$2"
  local message="$3"
  if [[ "$command" != restore ]] && declare -F report_early_root_preflight_failure >/dev/null; then
    report_early_root_preflight_failure
  fi
  if [[ "$command" == restore ]]; then
    restore_preparation_failure "$outcome" "$status"
  fi
  echo "$message" >&2
  exit "$status"
}

# shellcheck disable=SC2329
restore_exit_report() {
  local status="$?"
  trap - EXIT
  if [[ "$command" == restore && "$restore_report_emitted" == 0 ]]; then
    printf '{"restored":false,"outcome":"restore-preparation-failed","cutoverCompleted":false,"technicalAdminAuth":{"outcome":"not-attempted","credentialPreserved":false,"reEnrollmentRequired":false}}\n' >&"${restore_error_fd}"
  fi
  exit "$status"
}
trap restore_exit_report EXIT

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
    environment_file="/etc/quadball-timer/production.env"
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
    environment_file="/etc/quadball-timer/test.env"
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
operational_status_directory="/run/quadball-timer-operational-status"

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
  environment_file="$focused_test_root${environment_file}"
  [[ -n "$backup_directory" ]] && backup_directory="$focused_test_root${backup_directory}"
  operational_status_directory="$focused_test_root/run/quadball-timer-operational-status"
fi
configure_promotion_test_hooks || exit 2
owner_identity_command="${QBT_FOCUSED_TEST_OWNER_SEAM:-}"
systemctl_command="${QBT_FOCUSED_TEST_SYSTEMCTL:-systemctl}"
runuser_command="${QBT_FOCUSED_TEST_RUNUSER:-/usr/sbin/runuser}"
flock_command="${QBT_FOCUSED_TEST_FLOCK:-flock}"
realpath_command="${QBT_FOCUSED_TEST_REALPATH:-realpath}"
readlink_command="${QBT_FOCUSED_TEST_READLINK:-readlink}"
install_command="${QBT_FOCUSED_TEST_INSTALL:-/usr/bin/install}"
mktemp_command="${QBT_FOCUSED_TEST_MKTEMP:-mktemp}"
operational_report_file=""
operational_report_dispatched=0

# Release validation happens before the full root dispatcher is available.
# Once a canonical executable and manifest exist, any remaining validation
# failure is still reported directly and detached; invalid/untrusted paths are
# never executed merely to obtain monitoring evidence.
report_early_root_preflight_failure() {
  local candidate="$release_dir/quadball-timer" manifest="$release_dir/release-manifest.json"
  local candidate_release dsn="" operation="deployment" phase="preflight" category="atomic-install"
  trap - ERR
  set +e
  [[ "$operational_report_dispatched" == 0 && "$command" != report-operational && "$command" != report-operational-attempt && "$command" != read-operational-status && "$command" != read-operational-delivery ]] || return 0
  [[ "$release_dir" == "$release_base"/releases/* && "$release_dir" != *..* && "$release_dir" != *//* ]] || return 0
  [[ -d "$release_dir" && ! -L "$release_dir" ]] || return 0
  [[ "$($realpath_command -e -- "$release_dir" 2>/dev/null)" == "$release_dir" ]] || return 0
  [[ -x "$candidate" && -f "$candidate" && ! -L "$candidate" && -f "$manifest" && ! -L "$manifest" ]] || return 0
  candidate_release="$(sed -n 's/.*"releaseAttemptId":"\([^"]*\)".*/\1/p' "$manifest" | head -n 1)"
  [[ "$candidate_release" =~ ^[A-Za-z0-9._-]+$ ]] || candidate_release="$(basename -- "$release_dir")"
  [[ "$candidate_release" =~ ^[A-Za-z0-9._-]+$ ]] || return 0
  if [[ "$command" == restore ]]; then
    operation="restore"
    phase="staged-restore"
    category="staged-restore"
  fi
  if [[ -f "$environment_file" && ! -L "$environment_file" ]]; then
    dsn="$(sed -n -E 's/^[[:space:]]*GLITCHTIP_DSN=(.*)$/\1/p' "$environment_file" | head -n 1)"
    case "$dsn" in
      \"*\") dsn="${dsn:1:${#dsn}-2}" ;;
      \'*\') dsn="${dsn:1:${#dsn}-2}" ;;
    esac
    [[ "$dsn" =~ ^https?://[^[:space:]]+$ ]] || dsn=""
  fi
  operational_report_dispatched=1
  nohup "$runuser_command" -u "$service_user" -- env -i PATH=/usr/bin:/bin \
    QUADBALL_ENVIRONMENT="$environment" NODE_ENV=production \
    RELEASE_ATTEMPT_ID="$candidate_release" GLITCHTIP_DSN="$dsn" \
    "$candidate" --emit-operational-failure --operation "$operation" \
    --phase "$phase" --outcome failed --category "$category" \
    9>&- </dev/null >/dev/null 2>&1 &
}

fail_root_preflight_validation() {
  local message="$1" status="$2"
  echo "$message" >&2
  report_early_root_preflight_failure
  exit "$status"
}

[[ "$release_dir" == "$release_base"/releases/* ]] || fail_root_preflight_validation "Unsafe release path." 2
[[ "$release_dir" != *..* && "$release_dir" != *//* ]] || fail_root_preflight_validation "Unsafe release path." 2
[[ -d "$release_dir" && ! -L "$release_dir" ]] || fail_root_preflight_validation "Unsafe release path." 2
resolved_release_dir="$($realpath_command -e -- "$release_dir")" || fail_root_preflight_validation "Release path is not canonical." 2
[[ "$resolved_release_dir" == "$release_base"/releases/* && "$resolved_release_dir" == "$release_dir" ]] || {
  fail_root_preflight_validation "Release path is not canonical." 2
}
[[ -x "$release_dir/quadball-timer" && -f "$release_dir/release-manifest.json" ]] || {
  fail_root_preflight_validation "Maintenance release is incomplete." 1
}
if ! release_attempt_id="$(sed -n 's/.*"releaseAttemptId":"\([^"]*\)".*/\1/p' "$release_dir/release-manifest.json")"; then
  maintenance_preflight_failure release-identity-invalid 1 "Maintenance release identity is unreadable."
fi
if ! schema_compatibility="$(sed -n 's/.*"schemaCompatibility":"\([^"]*\)".*/\1/p' "$release_dir/release-manifest.json")"; then
  maintenance_preflight_failure release-identity-invalid 1 "Maintenance release identity is unreadable."
fi
[[ -n "$release_attempt_id" && -n "$schema_compatibility" ]] ||
  maintenance_preflight_failure release-identity-invalid 1 "Maintenance release identity is incomplete."
[[ "$release_attempt_id" =~ ^[A-Za-z0-9._-]+$ && "$(basename -- "$release_dir")" == "$release_attempt_id" ]] || {
  fail_root_preflight_validation "Maintenance release identity does not match its path." 2
}
[[ ! -L "$release_dir/quadball-timer" && ! -L "$release_dir/release-manifest.json" ]] || {
  fail_root_preflight_validation "Maintenance release contains symlinked inputs." 2
}
operational_event_release_attempt="$release_attempt_id"

read_trusted_glitchtip_dsn() {
  local raw
  [[ -f "$environment_file" && ! -L "$environment_file" ]] || return 0
  raw="$(sed -n -E 's/^[[:space:]]*GLITCHTIP_DSN=(.*)$/\1/p' "$environment_file" | head -n 1)"
  case "$raw" in
    \"*\") raw="${raw:1:${#raw}-2}" ;;
    \'*\') raw="${raw:1:${#raw}-2}" ;;
  esac
  [[ "$raw" =~ ^https?://[^[:space:]]+$ ]] && (( ${#raw} <= 2048 )) || return 0
  printf '%s' "$raw"
}

emit_operational_report() {
  local operation="$1" phase="$2" outcome="$3" category="$4" delivery dsn
  case "$operation" in
    deployment|backup|migration|restore|readiness) ;;
    *) return 0 ;;
  esac
  case "$phase" in
    preflight|quiesce-stop|backup-create|backup-verify|backup-promote|candidate-validation|live-migration|staged-restore|release-switch|startup|readiness|rollback-restart|final-report) ;;
    *) return 0 ;;
  esac
  case "$outcome" in failed|degraded|blocked|incompatible|rolled-back|unavailable) ;;
    *) return 0 ;;
  esac
  case "$category" in
    backup-candidate|migration-candidate|schema-incompatibility|binary-rollback|staged-restore|key-version|technical-admin-auth-sanitization|re-enrollment-required|atomic-install|readiness) ;;
    *) return 0 ;;
  esac
  dsn="$(read_trusted_glitchtip_dsn)"
  local -a reporter_command=(
    "$runuser_command" -u "$service_user" -- env -i PATH=/usr/bin:/bin
    QUADBALL_ENVIRONMENT="$environment"
    NODE_ENV=production
    RELEASE_ATTEMPT_ID="$operational_event_release_attempt"
    GLITCHTIP_DSN="$dsn"
    "$release_dir/quadball-timer" --emit-operational-failure
    --operation "$operation" --phase "$phase" --outcome "$outcome" --category "$category"
  )
  if [[ "$focused_test_mode" == 1 ]]; then
    delivery="$("${reporter_command[@]}" 2>/dev/null || true)"
  else
    delivery="$(/usr/bin/timeout --signal=KILL 2s "${reporter_command[@]}" 2>/dev/null || true)"
  fi
  case "$delivery" in sent|failed|unavailable) ;; *) delivery="unavailable" ;; esac
  write_operational_status "$phase" "$category" "$delivery"
}

operational_status_path() {
  printf '%s/status-%s-%s-%s' "$operational_status_directory" "$operational_event_release_attempt" "$1" "$2"
}

operational_latest_status_path() {
  printf '%s/status-%s-latest' "$operational_status_directory" "$operational_event_release_attempt"
}

status_path_metadata() {
  local path="$1"
  if [[ "$(uname -s)" == Darwin ]]; then
    /usr/bin/stat -f '%u:%g:%Lp' "$path" 2>/dev/null
  else
    "$stat_command" -c '%u:%g:%a' -- "$path" 2>/dev/null
  fi
}

ensure_operational_status_directory() {
  local expected_owner metadata resolved
  if [[ "$focused_test_mode" == 1 ]]; then
    mkdir -p -- "$operational_status_directory" 2>/dev/null || return 1
    chmod 0700 "$operational_status_directory" 2>/dev/null || return 1
    expected_owner="$(id -u):$(id -g):700"
  else
    /usr/bin/install -d -o root -g root -m 0700 -- "$operational_status_directory" 2>/dev/null || return 1
    expected_owner="0:0:700"
  fi
  [[ -d "$operational_status_directory" && ! -L "$operational_status_directory" ]] || return 1
  resolved="$($realpath_command -e -- "$operational_status_directory" 2>/dev/null)" || return 1
  [[ "$resolved" == "$operational_status_directory" ]] || return 1
  metadata="$(status_path_metadata "$operational_status_directory")" || return 1
  [[ "$metadata" == "$expected_owner" ]]
}

write_operational_status_record() {
  local status_path="$1" delivery="$2" temporary_path expected_owner metadata
  ensure_operational_status_directory || return 0
  temporary_path="$(mktemp "${status_path}.tmp.XXXXXX")" 2>/dev/null || return 0
  printf '%s\n' "$delivery" >"$temporary_path" 2>/dev/null || { rm -f -- "$temporary_path"; return 0; }
  chmod 0600 "$temporary_path" 2>/dev/null || { rm -f -- "$temporary_path" 2>/dev/null || true; return 0; }
  if [[ "$focused_test_mode" == 1 ]]; then
    expected_owner="$(id -u):$(id -g):600"
  else
    chown root:root "$temporary_path" 2>/dev/null || { rm -f -- "$temporary_path"; return 0; }
    expected_owner="0:0:600"
  fi
  metadata="$(status_path_metadata "$temporary_path")" || { rm -f -- "$temporary_path"; return 0; }
  [[ "$metadata" == "$expected_owner" ]] || { rm -f -- "$temporary_path"; return 0; }
  if [[ "$focused_test_mode" == 1 ]]; then
    mv -f -- "$temporary_path" "$status_path" 2>/dev/null || rm -f -- "$temporary_path" 2>/dev/null || true
  else
    mv -T -- "$temporary_path" "$status_path" 2>/dev/null || rm -f -- "$temporary_path" 2>/dev/null || true
  fi
}

write_operational_status() {
  local phase="$1" category="$2" delivery="$3"
  write_operational_status_record "$(operational_status_path "$phase" "$category")" "$delivery"
  write_operational_status_record "$(operational_latest_status_path)" "$delivery"
}

read_operational_status() {
  local phase="$1" category="$2" status_path delivery="unavailable" expected_owner metadata resolved
  ensure_operational_status_directory || { printf 'unavailable\n'; return 0; }
  status_path="$(operational_status_path "$phase" "$category")"
  if [[ -f "$status_path" && ! -L "$status_path" ]]; then
    resolved="$($realpath_command -e -- "$status_path" 2>/dev/null || true)"
    if [[ "$focused_test_mode" == 1 ]]; then
      expected_owner="$(id -u):$(id -g):600"
    else
      expected_owner="0:0:600"
    fi
    metadata="$(status_path_metadata "$status_path" 2>/dev/null || true)"
    if [[ "$resolved" == "$status_path" && "$metadata" == "$expected_owner" ]]; then
      IFS= read -r delivery <"$status_path" || delivery="unavailable"
    fi
  fi
  case "$delivery" in sent|failed|unavailable) ;; *) delivery="unavailable" ;; esac
  printf '%s\n' "$delivery"
}

read_operational_delivery() {
  local status_path delivery="unavailable" expected_owner metadata resolved
  ensure_operational_status_directory || { printf 'unavailable\n'; return 0; }
  status_path="$(operational_latest_status_path)"
  if [[ -f "$status_path" && ! -L "$status_path" ]]; then
    resolved="$($realpath_command -e -- "$status_path" 2>/dev/null || true)"
    if [[ "$focused_test_mode" == 1 ]]; then
      expected_owner="$(id -u):$(id -g):600"
    else
      expected_owner="0:0:600"
    fi
    metadata="$(status_path_metadata "$status_path" 2>/dev/null || true)"
    if [[ "$resolved" == "$status_path" && "$metadata" == "$expected_owner" ]]; then
      IFS= read -r delivery <"$status_path" || delivery="unavailable"
    fi
  fi
  case "$delivery" in sent|failed|unavailable) ;; *) delivery="unavailable" ;; esac
  printf '%s\n' "$delivery"
}

prepare_operational_report_file() {
  local candidate
  if [[ "$focused_test_mode" == 1 ]]; then
    mkdir -p -- "$database_dir" || return 1
    candidate="$database_dir/.operational-report-${release_attempt_id}"
    : >"$candidate" || return 1
    chmod 0600 "$candidate" || { rm -f -- "$candidate"; return 1; }
  else
    candidate="$(mktemp "$database_dir/.operational-report-${release_attempt_id}.XXXXXX")" || return 1
    chown "$service_user:$service_user" "$candidate" || { rm -f -- "$candidate"; return 1; }
    chmod 0600 "$candidate" || { rm -f -- "$candidate"; return 1; }
  fi
  operational_report_file="$candidate"
}

dispatch_operational_report() {
  local line operation event_environment event_release phase outcome category
  [[ -n "$operational_report_file" && -f "$operational_report_file" ]] || return 0
  while IFS= read -r line; do
    IFS=$'\t' read -r operation event_environment event_release phase outcome category <<<"$line"
    [[ "$event_environment" == "$environment" ]] || continue
    [[ "$event_release" == "$release_attempt_id" ]] || continue
    case "$operation" in deployment|backup|migration|restore|readiness) ;; *) continue ;; esac
    case "$phase" in preflight|quiesce-stop|backup-create|backup-verify|backup-promote|candidate-validation|live-migration|staged-restore|release-switch|startup|readiness|rollback-restart|final-report) ;; *) continue ;; esac
    case "$outcome" in failed|degraded|blocked|incompatible|rolled-back|unavailable) ;; *) continue ;; esac
    case "$category" in backup-candidate|migration-candidate|schema-incompatibility|binary-rollback|staged-restore|key-version|technical-admin-auth-sanitization|re-enrollment-required|atomic-install|readiness) ;; *) continue ;; esac
    detach_operational_report "$operation" "$phase" "$outcome" "$category"
    break
  done <"$operational_report_file"
  rm -f -- "$operational_report_file" || true
}

detach_operational_report() {
  operational_report_dispatched=1
  nohup "$0" "$environment" "$release_dir" report-operational \
    "$1" "$2" "$3" "$4" 9>&- </dev/null >/dev/null 2>&1 &
}

# shellcheck disable=SC2329 # invoked by the ERR trap below
report_unhandled_root_failure() {
  local operation="deployment" phase="preflight" category="atomic-install"
  trap - ERR
  set +e
  [[ "$operational_report_dispatched" == 0 ]] || return 0
  case "$command" in
    backup) operation="backup"; phase="backup-create"; category="backup-candidate" ;;
    verify-backup) operation="backup"; phase="backup-verify"; category="backup-candidate" ;;
    promote) operation="backup"; phase="backup-promote"; category="backup-candidate" ;;
    validate-migration) operation="migration"; phase="candidate-validation"; category="migration-candidate" ;;
    apply-migrations) operation="migration"; phase="live-migration"; category="migration-candidate" ;;
    readiness) operation="readiness"; phase="readiness"; category="readiness" ;;
    restore) operation="restore"; phase="staged-restore"; category="staged-restore" ;;
  esac
  detach_operational_report "$operation" "$phase" failed "$category"
}

# Any otherwise-unhandled root failure after the immutable release has been
# validated is observationally queued once. The trap never waits for delivery
# and cannot replace the authoritative command status.
trap report_unhandled_root_failure ERR

trusted_glitchtip_dsn="$(read_trusted_glitchtip_dsn)"

case "$command" in
  report-operational)
    [[ "${SUDO_USER:-}" == "$expected_caller" ]] || { echo "Invalid maintenance caller." >&2; exit 2; }
    [[ -n "$manifest_path" && -n "${5:-}" && -n "${6:-}" && -n "${7:-}" ]] || { echo "Operational report fields are incomplete." >&2; exit 2; }
    emit_operational_report "$manifest_path" "$5" "$6" "$7"
    exit 0
    ;;
  report-operational-attempt)
    [[ "${SUDO_USER:-}" == "$expected_caller" ]] || { echo "Invalid maintenance caller." >&2; exit 2; }
    [[ -n "$manifest_path" && -n "${5:-}" && -n "${6:-}" && -n "${7:-}" && -n "${8:-}" ]] || { echo "Operational report fields are incomplete." >&2; exit 2; }
    [[ "$8" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || { echo "Operational release identity is invalid." >&2; exit 2; }
    operational_event_release_attempt="$8"
    emit_operational_report "$manifest_path" "$5" "$6" "$7"
    exit 0
    ;;
  read-operational-status)
    [[ "${SUDO_USER:-}" == "$expected_caller" ]] || { echo "Invalid maintenance caller." >&2; exit 2; }
    [[ -n "$manifest_path" && -n "${5:-}" ]] || { echo "Operational status fields are incomplete." >&2; exit 2; }
    case "$manifest_path" in preflight|quiesce-stop|backup-create|backup-verify|backup-promote|candidate-validation|live-migration|staged-restore|release-switch|startup|readiness|rollback-restart|final-report) ;; *) exit 2 ;; esac
    case "$5" in backup-candidate|migration-candidate|schema-incompatibility|binary-rollback|staged-restore|key-version|technical-admin-auth-sanitization|re-enrollment-required|atomic-install|readiness) ;; *) exit 2 ;; esac
    read_operational_status "$manifest_path" "$5"
    exit 0
    ;;
  read-operational-delivery)
    [[ "${SUDO_USER:-}" == "$expected_caller" ]] || { echo "Invalid maintenance caller." >&2; exit 2; }
    [[ "$manifest_path" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || { echo "Operational release identity is invalid." >&2; exit 2; }
    operational_event_release_attempt="$manifest_path"
    read_operational_delivery
    exit 0
    ;;
  backup|verify-backup|promote|restore)
    [[ "$environment" == production ]] || { echo "Production backup operations only." >&2; exit 2; }
    [[ "${SUDO_USER:-}" == "$expected_caller" ]] || { echo "Invalid maintenance caller." >&2; exit 2; }
    service_state="$($systemctl_command is-active quadball-timer 2>/dev/null || true)"
    if [[ "$service_state" != inactive && "$service_state" != failed ]]; then
      echo "Production service must be inactive or failed." >&2
      if [[ "$command" == restore ]]; then
        detach_operational_report restore staged-restore failed staged-restore
      else
        detach_operational_report backup preflight failed atomic-install
      fi
      exit 1
    fi
    if ! exec 9>"$release_base/.activation.lock"; then
      maintenance_preflight_failure activation-lock-unavailable 1 "Activation lock could not be opened."
    fi
    if QBT_ACTIVATION_LOCK_PATH="$release_base/.activation.lock" "$flock_command" -n 9; then
      echo "Activation lock is not held by the orchestrator." >&2
      if [[ "$command" == restore ]]; then
        detach_operational_report restore staged-restore failed staged-restore
      else
        detach_operational_report backup preflight failed atomic-install
      fi
      exit 1
    fi
    ;;
  validate-migration|apply-migrations)
    [[ "${SUDO_USER:-}" == "$expected_caller" ]] || { echo "Invalid maintenance caller." >&2; exit 2; }
    [[ "$($systemctl_command is-active "$service_name" 2>/dev/null || true)" == inactive ]] || { echo "Service must be inactive." >&2; detach_operational_report migration preflight failed atomic-install; exit 1; }
    if ! exec 9>"$release_base/.activation.lock"; then detach_operational_report migration preflight failed atomic-install; exit 1; fi
    if QBT_ACTIVATION_LOCK_PATH="$release_base/.activation.lock" "$flock_command" -n 9; then echo "Activation lock is not held by the orchestrator." >&2; detach_operational_report migration preflight failed atomic-install; exit 1; fi
    ;;
  readiness|authoritative-operation|preflight)
    [[ "${SUDO_USER:-}" == "$expected_caller" ]] || { echo "Invalid maintenance caller." >&2; exit 2; }
    ;;
  *) echo "Unsupported maintenance operation." >&2; exit 2 ;;
esac
if [[ "$environment" == production && "$command" != readiness && "$command" != authoritative-operation && "$command" != preflight && "$command" != validate-migration && "$command" != apply-migrations ]]; then
  root_preflight_operation="backup"
  root_preflight_phase="preflight"
  root_preflight_category="atomic-install"
  if [[ "$command" == restore ]]; then
    root_preflight_operation="restore"
    root_preflight_phase="staged-restore"
    root_preflight_category="staged-restore"
  fi
  if [[ -e "$backup_directory" || -L "$backup_directory" ]]; then
    [[ -d "$backup_directory" && ! -L "$backup_directory" ]] || { echo "Backup root is missing or symlinked." >&2; detach_operational_report "$root_preflight_operation" "$root_preflight_phase" failed "$root_preflight_category"; exit 2; }
    [[ "$($realpath_command -e -- "$backup_directory")" == "$backup_directory" ]] || { echo "Backup root is not canonical." >&2; detach_operational_report "$root_preflight_operation" "$root_preflight_phase" failed "$root_preflight_category"; exit 2; }
  else
    [[ "$($realpath_command -e -- "$(dirname -- "$backup_directory")")" == "$(dirname -- "$backup_directory")" ]] || { echo "Backup parent is not canonical." >&2; detach_operational_report "$root_preflight_operation" "$root_preflight_phase" failed "$root_preflight_category"; exit 2; }
    if [[ "$focused_test_mode" == 1 ]]; then
      if ! mkdir -p "$backup_directory" || ! chmod 0750 "$backup_directory"; then
        detach_operational_report "$root_preflight_operation" "$root_preflight_phase" failed "$root_preflight_category"
        exit 2
      fi
    elif ! install -d -o root -g "$service_user" -m 0750 "$backup_directory"; then
      detach_operational_report "$root_preflight_operation" "$root_preflight_phase" failed "$root_preflight_category"
      exit 2
    fi
  fi
  if [[ "$focused_test_mode" != 1 ]]; then
    [[ "$(stat -c '%U:%G:%a' "$backup_directory")" == "root:${service_user}:750" ]] || { echo "Backup root ownership or mode drifted." >&2; detach_operational_report "$root_preflight_operation" "$root_preflight_phase" failed "$root_preflight_category"; exit 2; }
  fi
fi

stage_restore_input() {
  local source_path="$1"
  local destination_name="$2"
  local destination_path="$restore_workspace/$destination_name"
  local before_identity=""
  local after_identity=""
  local source_copy_path="$source_path"

  [[ "$destination_name" =~ ^[A-Za-z0-9._-]+$ ]] || return 1
  [[ "$source_path" == "$snapshot_directory"/* && "$source_path" != *..* ]] || return 1
  [[ -f "$source_path" && ! -L "$source_path" ]] || return 1
  [[ "$($realpath_command -e -- "$source_path")" == "$source_path" ]] || return 1
  if [[ "$focused_test_mode" == 1 && -n "$owner_identity_command" ]]; then
    [[ "$($owner_identity_command "$source_path")" == root:root:600 ]] || return 1
  elif [[ "$focused_test_mode" != 1 ]]; then
    [[ "$($stat_command -c '%U:%G:%a' -- "$source_path")" == root:root:600 ]] || return 1
  fi
  if [[ "$focused_test_mode" == 1 ]]; then
    before_identity="$($stat_command -f '%d:%i:%z:%m' -- "$source_path")" || return 1
  else
    before_identity="$($stat_command -L -c '%d:%i:%s:%Y' -- "$source_path")" || return 1
    exec 7<"$source_path" || return 1
    source_copy_path="/proc/self/fd/7"
    [[ "$($readlink_command "$source_copy_path")" == "$source_path" ]] || {
      exec 7<&-
      return 1
    }
    held_identity="$($stat_command -L -c '%d:%i:%s:%Y' -- "$source_copy_path")" || {
      exec 7<&-
      return 1
    }
    [[ "$before_identity" == "$held_identity" ]] || {
      exec 7<&-
      return 1
    }
  fi
  local original_umask
  original_umask="$(umask)"
  umask 077
  set -o noclobber
  if ! exec 6>"$destination_path"; then
    set +o noclobber
    umask "$original_umask"
    [[ "$focused_test_mode" == 1 ]] || exec 7<&-
    return 1
  fi
  set +o noclobber
  umask "$original_umask"
  if [[ "$focused_test_mode" == 1 ]]; then
    cat "$source_copy_path" >&6 || { exec 6>&-; return 1; }
  else
    cat <"$source_copy_path" >&6 || { exec 6>&-; exec 7<&-; return 1; }
  fi
  if [[ "$focused_test_mode" != 1 ]]; then
    sync -f -- "$destination_path" || { exec 6>&-; exec 7<&-; return 1; }
  fi
  exec 6>&-
  chmod 0600 "$destination_path" || return 1
  if [[ "$focused_test_mode" != 1 ]]; then
    chown "$service_user:$service_user" -- "$destination_path" || return 1
  fi
  if [[ "$focused_test_mode" == 1 ]]; then
    [[ "$($stat_command -f '%Lp' -- "$destination_path")" == 600 ]] || return 1
    if [[ -n "$owner_identity_command" ]]; then
      [[ "$($owner_identity_command "$destination_path")" == quadball-timer:quadball-timer:600 ]] || return 1
    fi
  else
    [[ "$($stat_command -c '%U:%G:%a' -- "$destination_path")" == "${service_user}:${service_user}:600" ]] || return 1
  fi
  [[ -f "$destination_path" && ! -L "$destination_path" ]] || return 1
  [[ "$($realpath_command -e -- "$destination_path")" == "$destination_path" ]] || return 1
  if [[ "$focused_test_mode" == 1 ]]; then
    [[ "$($stat_command -f '%Lp' -- "$destination_path")" == 600 ]] || return 1
    after_identity="$($stat_command -f '%d:%i:%z:%m' -- "$source_path")" || return 1
  else
    [[ "$($stat_command -c '%U:%G:%a' -- "$destination_path")" == "${service_user}:${service_user}:600" ]] || return 1
    after_identity="$($stat_command -L -c '%d:%i:%s:%Y' -- "$source_path")" || return 1
    held_identity="$($stat_command -L -c '%d:%i:%s:%Y' -- "$source_copy_path")" || return 1
    exec 7<&-
  fi
  [[ "$before_identity" == "$after_identity" ]] || return 1
  [[ "$focused_test_mode" == 1 || "$before_identity" == "$held_identity" ]] || return 1
}

if [[ "$command" == "backup" ]]; then
  operation_backup_directory="$backup_directory/.candidate-${release_attempt_id}"
  if [[ "$focused_test_mode" == 1 ]]; then rm -rf "$operation_backup_directory"; mkdir -p "$operation_backup_directory"; chmod 0700 "$operation_backup_directory"; else rm -rf -- "$operation_backup_directory"; install -d -o "$service_user" -g "$service_user" -m 0700 "$operation_backup_directory"; fi
elif [[ "$command" == "verify-backup" ]]; then
  operation_backup_directory="$backup_directory/.candidate-${release_attempt_id}"
  [[ "$manifest_path" == "$operation_backup_directory"/* && "$manifest_path" != *..* ]] || { echo "Unsafe backup manifest path." >&2; detach_operational_report backup backup-verify failed backup-candidate; exit 2; }
  manifest_path="$($realpath_command -e -- "$manifest_path")"
  [[ "$manifest_path" == "$operation_backup_directory"/* && ! -L "$manifest_path" ]] || { echo "Backup manifest is not canonical." >&2; detach_operational_report backup backup-verify failed backup-candidate; exit 2; }
elif [[ "$command" == "promote" ]]; then
  operation_backup_directory="$backup_directory/.candidate-${release_attempt_id}"
else
  operation_backup_directory="${backup_directory:-$database_dir}"
fi
if [[ "$command" == "promote" ]]; then
  candidate_directory="$backup_directory/.candidate-${release_attempt_id}"
  [[ "$manifest_path" == "$candidate_directory"/* && "$manifest_path" != *..* ]] || { echo "Unsafe backup manifest path." >&2; detach_operational_report backup backup-promote failed backup-candidate; exit 2; }
  manifest_path="$($realpath_command -e -- "$manifest_path")"
  [[ "$manifest_path" == "$candidate_directory"/* && ! -L "$manifest_path" ]] || { echo "Backup manifest is not canonical." >&2; detach_operational_report backup backup-promote failed backup-candidate; exit 2; }
elif [[ "$command" == "restore" ]]; then
  [[ "$environment" == production ]] || restore_preparation_failure restore-selection-invalid 2
  [[ -n "$manifest_path" && "$manifest_path" == "$backup_directory"/* && "$manifest_path" != *..* ]] || restore_preparation_failure restore-selection-invalid 2
  manifest_path="$($realpath_command -e -- "$manifest_path")" || restore_preparation_failure restore-selection-invalid 2
  [[ "$manifest_path" == "$backup_directory"/* && ! -L "$manifest_path" ]] || restore_preparation_failure restore-selection-invalid 2
  [[ "$(basename -- "$(dirname -- "$manifest_path")")" =~ ^verified-[A-Za-z0-9._-]+$ ]] || restore_preparation_failure restore-selection-invalid 2
  [[ "$(basename -- "$manifest_path")" =~ ^[A-Za-z0-9._-]+\.manifest\.json$ ]] || restore_preparation_failure restore-selection-invalid 2
fi
restore_workspace=""
if [[ "$command" == "restore" ]]; then
  restore_workspace="$($mktemp_command -d "$backup_directory/.restore-${release_attempt_id}-XXXXXX")" || {
    restore_preparation_failure restore-preparation-failed 1
  }
  [[ "$restore_workspace" == "$backup_directory/.restore-${release_attempt_id}-"* && "$restore_workspace" != *..* ]] || {
    restore_preparation_failure restore-preparation-failed 2
  }
  if ! "$install_command" -d -o root -g root -m 0700 "$restore_workspace" >/dev/null 2>&1; then
    restore_preparation_failure restore-preparation-failed 1
  fi
  [[ -d "$restore_workspace" && ! -L "$restore_workspace" ]] || {
    restore_preparation_failure restore-preparation-failed 2
  }
  [[ "$($realpath_command -e -- "$restore_workspace")" == "$restore_workspace" ]] || {
    restore_preparation_failure restore-preparation-failed 2
  }
  if [[ "$focused_test_mode" != 1 ]]; then
    [[ "$(stat -c '%U:%G:%a' "$restore_workspace")" == "root:root:700" ]] || {
      restore_preparation_failure restore-preparation-failed 2
    }
  fi
  snapshot_directory="$(dirname -- "$manifest_path")"
  snapshot_id="$(basename -- "$manifest_path" .manifest.json)"
  [[ "$snapshot_id" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || {
    restore_preparation_failure restore-selection-invalid 2
  }
  [[ "$(basename -- "$snapshot_directory")" =~ ^verified-[A-Za-z0-9._-]+$ ]] || {
    restore_preparation_failure restore-selection-invalid 2
  }
  stage_restore_input "$manifest_path" "$(basename -- "$manifest_path")" || {
    restore_preparation_failure restore-staging-failed 1
  }
  stage_restore_input "$snapshot_directory/$snapshot_id.sqlite" "$snapshot_id.sqlite" || {
    restore_preparation_failure restore-staging-failed 1
  }
  stage_restore_input "$snapshot_directory/$snapshot_id.ad-hoc.sqlite" "$snapshot_id.ad-hoc.sqlite" || {
    restore_preparation_failure restore-staging-failed 1
  }
  stage_restore_input "$snapshot_directory/$snapshot_id.deployment.json" "$snapshot_id.deployment.json" || {
    restore_preparation_failure restore-staging-failed 1
  }
  if [[ "$focused_test_mode" != 1 ]]; then
    chown "$service_user:$service_user" -- "$restore_workspace" ||
      restore_preparation_failure restore-staging-failed 1
    chmod 0700 -- "$restore_workspace" || restore_preparation_failure restore-staging-failed 1
    [[ "$(stat -c '%U:%G:%a' "$restore_workspace")" == "${service_user}:${service_user}:700" ]] ||
      restore_preparation_failure restore-staging-failed 1
  fi
  manifest_path="$restore_workspace/$(basename -- "$manifest_path")"
fi
if ! prepare_operational_report_file; then
  operational_report_file=""
fi
# The maintenance CLI owns its semantic event in the private spool. Its
# expected nonzero result is collected explicitly below and must not also fire
# the root ERR fallback.
trap - ERR
set +e
foundation_backup_directory="$operation_backup_directory"
[[ "$command" == "promote" ]] && foundation_backup_directory="$backup_directory"
root_promotion=""
[[ "$command" == "promote" ]] && root_promotion=1
if [[ "$command" == "promote" || "$command" == "restore" ]]; then
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
  RESTORE_WORKSPACE_DIRECTORY="$restore_workspace" \
  QBT_FOCUSED_TEST_MODE="$focused_test_mode" \
  QBT_FOCUSED_TEST_ROOT="$focused_test_root" \
  QBT_OPERATIONAL_REPORT_FILE="$operational_report_file" \
  AD_HOC_ENVIRONMENT_ID="$ad_hoc_environment_identity" \
  GLITCHTIP_DSN="$trusted_glitchtip_dsn" \
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
  QBT_OPERATIONAL_REPORT_FILE="$operational_report_file" \
  GLITCHTIP_DSN="$trusted_glitchtip_dsn" \
  QBT_FOCUSED_FAILURE_PHASE="$focused_failure_phase" \
  AD_HOC_ENVIRONMENT_ID="$ad_hoc_environment_identity" \
  QBT_ROOT_PROMOTION="$root_promotion" \
  "$release_dir/quadball-timer" --production-activation "$command"
  rc=$?
fi
set -e
if [[ "$command" == "restore" ]]; then
  bounded_restore_report="$(printf '%s\n' "$maintenance_output" | grep -m1 -E '^\{"restored":true,"restoreId":|^\{"restored":false,"outcome":' || true)"
  if [[ -z "$bounded_restore_report" ]]; then
    bounded_restore_report='{"restored":false,"outcome":"restore-preparation-failed","cutoverCompleted":false,"technicalAdminAuth":{"outcome":"not-attempted","credentialPreserved":false,"reEnrollmentRequired":false}}'
  fi
  technical_admin_auth="$(printf '%s\n' "$bounded_restore_report" | sed -n -E 's/.*"technicalAdminAuth":(\{"outcome":"[^"]+","credentialPreserved":(true|false),"reEnrollmentRequired":(true|false)\}).*/\1/p')"
  if [[ -z "$technical_admin_auth" ]]; then
    technical_admin_auth='{"outcome":"not-attempted","credentialPreserved":false,"reEnrollmentRequired":false}'
  fi
  restore_report_emitted=1
fi
dispatch_operational_report || true
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
      detach_operational_report backup backup-promote failed backup-candidate
      rc=1
    fi
  fi
fi
if (( rc == 0 )) && [[ "$command" == "restore" ]]; then
  if ! "$systemctl_command" restart "$service_name" >/dev/null 2>&1; then
    detach_operational_report restore startup failed atomic-install
    printf '{"restored":false,"outcome":"cutover-completed-readiness-failed","cutoverCompleted":true,"restartVerified":false,"technicalAdminAuth":%s,"authorityResurrectionWarning":"Restoring an older snapshot may resurrect Grants, Grant Sessions, Ad Hoc Controller sessions, or QR-admitting state changed after the snapshot."}\n' "$technical_admin_auth" >&${restore_error_fd}
    restore_result_emitted=1
    rc=12
  elif [[ "$($systemctl_command is-active "$service_name" 2>/dev/null || true)" != active ]]; then
    detach_operational_report restore readiness failed readiness
    printf '{"restored":false,"outcome":"cutover-completed-readiness-failed","cutoverCompleted":true,"restartVerified":false,"technicalAdminAuth":%s,"authorityResurrectionWarning":"Restoring an older snapshot may resurrect Grants, Grant Sessions, Ad Hoc Controller sessions, or QR-admitting state changed after the snapshot."}\n' "$technical_admin_auth" >&${restore_error_fd}
    restore_result_emitted=1
    rc=12
  fi
fi
if [[ "$command" == restore && "$restore_result_emitted" == 0 ]]; then
  printf '%s\n' "$bounded_restore_report"
  restore_result_emitted=1
fi
if (( rc != 0 )) && [[ "$command" == "backup" || "$command" == "verify-backup" || "$command" == "promote" ]]; then
  if [[ "$focused_test_mode" == 1 ]]; then chmod -R u+w "$operation_backup_directory" 2>/dev/null || true; rm -rf "$operation_backup_directory"; else chmod -R u+w -- "$operation_backup_directory" 2>/dev/null || true; rm -rf -- "$operation_backup_directory"; fi
fi
trap - ERR
if (( rc != 0 )) && [[ "$operational_report_dispatched" == 0 ]]; then
  report_unhandled_root_failure
fi
exit "$rc"
