#!/usr/bin/env bash
set -euo pipefail

base_dir="/srv/quadball-timer"
backup_directory="/var/backups/quadball-timer"
service_name="quadball-timer"
port="3000"
public_origin="https://timer.quadball.app"
maintenance_wrapper="/usr/local/sbin/quadball-timer-activation-maintenance"
manifest_path=""
focused_test_mode="${QBT_FOCUSED_TEST_MODE:-}"
focused_test_root="${QBT_FOCUSED_TEST_ROOT:-}"

restore_preparation_failure() {
  local outcome="$1"
  local status="${2:-1}"
  printf '{"restored":false,"outcome":"%s","cutoverCompleted":false,"technicalAdminAuth":{"outcome":"not-attempted","credentialPreserved":false,"reEnrollmentRequired":false}}\n' "$outcome" >&2
  exit "$status"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-dir|--manifest|--service|--port|--maintenance-wrapper)
      [[ $# -ge 2 && -n "${2:-}" ]] || restore_preparation_failure operator-authorization-failed 2
      case "$1" in
        --base-dir) base_dir="$2" ;;
        --manifest) manifest_path="$2" ;;
        --service) service_name="$2" ;;
        --port) port="$2" ;;
        --maintenance-wrapper) maintenance_wrapper="$2" ;;
      esac
      shift 2 || restore_preparation_failure operator-authorization-failed 2
      ;;
    *) restore_preparation_failure operator-authorization-failed 2 ;;
  esac
done

if [[ "$focused_test_mode" == 1 ]]; then
  [[ "$EUID" -ne 0 && -n "$focused_test_root" && "$focused_test_root" == /* ]] || {
    restore_preparation_failure operator-authorization-failed 2
  }
  case "$focused_test_root" in
    /|*..*|*//* )
      restore_preparation_failure operator-authorization-failed 2
      ;;
  esac
  [[ -d "$focused_test_root" && ! -L "$focused_test_root" ]] || {
    restore_preparation_failure operator-authorization-failed 2
  }
  focused_test_root="$(cd -- "$focused_test_root" && pwd -P)" || restore_preparation_failure operator-authorization-failed 2
  [[ "$focused_test_root" == "$QBT_FOCUSED_TEST_ROOT" ]] || restore_preparation_failure operator-authorization-failed 2
  base_dir="$focused_test_root/srv/quadball-timer"
  backup_directory="$focused_test_root/var/backups/quadball-timer"
  maintenance_wrapper="${QBT_FOCUSED_TEST_MAINTENANCE_WRAPPER:-$focused_test_root/bin/maintenance-wrapper}"
  public_origin="${QBT_FOCUSED_TEST_PUBLIC_ORIGIN:-http://127.0.0.1:${port}}"
fi

systemctl_command="${QBT_FOCUSED_TEST_SYSTEMCTL:-systemctl}"
sudo_command="${QBT_FOCUSED_TEST_SUDO:-sudo}"
flock_command="${QBT_FOCUSED_TEST_FLOCK:-flock}"
readlink_command="${QBT_FOCUSED_TEST_READLINK:-readlink}"
sed_command="${QBT_FOCUSED_TEST_SED:-sed}"
curl_command="${QBT_FOCUSED_TEST_CURL:-curl}"
sleep_command="${QBT_FOCUSED_TEST_SLEEP:-sleep}"
readiness_attempts="${QBT_FOCUSED_TEST_READINESS_ATTEMPTS:-5}"
if ! operator_identity="$(id -un)"; then
  restore_preparation_failure operator-authorization-failed 2
fi
if [[ "$focused_test_mode" == 1 ]]; then
  operator_identity="${QBT_FOCUSED_TEST_OPERATOR:-$operator_identity}"
fi

if [[ "$focused_test_mode" != 1 && "$EUID" -eq 0 || "$operator_identity" != deploy-quadball-timer ]]; then
  restore_preparation_failure operator-authorization-failed 2
fi
if [[ ! "$service_name" =~ ^[A-Za-z0-9_.@-]+$ || ! "$port" =~ ^[0-9]+$ ]] ||
  (( port < 1 || port > 65535 )); then
  restore_preparation_failure operator-authorization-failed 2
fi
if [[ "$focused_test_mode" != 1 ]] &&
  [[ "$base_dir" != /srv/quadball-timer || "$backup_directory" != /var/backups/quadball-timer ||
    "$maintenance_wrapper" != /usr/local/sbin/quadball-timer-activation-maintenance ]]; then
  restore_preparation_failure operator-authorization-failed 2
fi
[[ "$manifest_path" == "$backup_directory"/verified-*/*.manifest.json && "$manifest_path" != *..* ]] || {
  restore_preparation_failure restore-selection-invalid 2
}
release_dir="$($readlink_command -f -- "$base_dir/current" 2>/dev/null || true)"
[[ "$release_dir" == "$base_dir"/releases/* && -d "$release_dir" && ! -L "$release_dir" ]] || {
  restore_preparation_failure release-identity-invalid 2
}

if ! exec 9>"$base_dir/.activation.lock"; then
  restore_preparation_failure activation-lock-unavailable 1
fi
if ! "$flock_command" -n 9; then
  restore_preparation_failure activation-lock-unavailable 1
fi
service_state="$("$systemctl_command" is-active "$service_name" 2>/dev/null || true)"
if [[ "$service_state" == active ]]; then
  if ! "$sudo_command" systemctl stop "$service_name" >/dev/null 2>&1; then
    restore_preparation_failure service-quiescence-failed 1
  fi
fi
service_state="$("$systemctl_command" is-active "$service_name" 2>/dev/null || true)"
if [[ "$service_state" != inactive && "$service_state" != failed ]]; then
  restore_preparation_failure service-quiescence-failed 1
fi

if [[ ! -f "$release_dir/release-manifest.json" || -L "$release_dir/release-manifest.json" ]]; then
  restore_preparation_failure release-identity-invalid 1
fi
if ! expected_release_id="$($sed_command -n 's/.*"releaseAttemptId":"\([^"]*\)".*/\1/p' "$release_dir/release-manifest.json")" ||
  ! expected_digest="$($sed_command -n 's/.*"executableSha256":"\([0-9a-f]\{64\}\)".*/\1/p' "$release_dir/release-manifest.json")" ||
  ! expected_schema="$($sed_command -n 's/.*"schemaCompatibility":"\([^"]*\)".*/\1/p' "$release_dir/release-manifest.json")" ||
  [[ -z "$expected_release_id" || -z "$expected_digest" || -z "$expected_schema" ]]; then
  restore_preparation_failure release-identity-invalid 1
fi
check_release_identity() {
  local identity
  identity="$("$curl_command" --fail --silent --max-time 2 "http://127.0.0.1:${port}/internal/release")" || return 1
  grep -Fq "\"releaseAttemptId\":\"${expected_release_id}\"" <<<"$identity" &&
    grep -Fq "\"executableSha256\":\"${expected_digest}\"" <<<"$identity" &&
    grep -Fq "\"runningExecutableSha256\":\"${expected_digest}\"" <<<"$identity" &&
    grep -Fq "\"schemaCompatibility\":\"${expected_schema}\"" <<<"$identity"
}
check_public_health() {
  "$curl_command" --fail --silent --max-time 2 "${public_origin}/healthz" |
    grep -Fxq "healthy"
}
check_public_home() {
  "$curl_command" --fail --silent --max-time 2 "${public_origin}/" |
    grep -qi "<!doctype html"
}
check_post_restart_readiness() {
  local attempt
  for ((attempt = 1; attempt <= readiness_attempts; attempt++)); do
    if [[ "$("$systemctl_command" is-active "$service_name" 2>/dev/null || true)" == active ]] &&
      "$curl_command" --fail --silent --max-time 2 "http://127.0.0.1:${port}/internal/healthz" >/dev/null &&
      check_release_identity
    then return 0; fi
    "$sleep_command" 1
  done
  return 1
}
check_representative_event_read() {
  "$curl_command" --fail --silent --max-time 2 \
    "${public_origin}/api/audience/events" >/dev/null
}
check_authoritative_operation() {
  local operation
  operation="$("$sudo_command" "$maintenance_wrapper" production "$release_dir" authoritative-operation "" 2>/dev/null)" || return 1
  grep -Fq '"ok":true' <<<"$operation"
}
set +e
restore_report="$("$sudo_command" "$maintenance_wrapper" production "$release_dir" restore "$manifest_path" 2>&1)"
restore_rc=$?
set -e
bounded_restore_report="$(printf '%s\n' "$restore_report" | grep -m1 -E '^\{"restored":true,"restoreId":|^\{"restored":false,"outcome":' || true)"
if [[ -z "$bounded_restore_report" ]]; then
  bounded_restore_report='{"restored":false,"outcome":"restore-preparation-failed","cutoverCompleted":false,"technicalAdminAuth":{"outcome":"not-attempted","credentialPreserved":false,"reEnrollmentRequired":false}}'
fi
technical_admin_auth="$(printf '%s\n' "$bounded_restore_report" | sed -n -E 's/.*"technicalAdminAuth":(\{"outcome":"[^"]+","credentialPreserved":(true|false),"reEnrollmentRequired":(true|false)\}).*/\1/p')"
if [[ -z "$technical_admin_auth" ]]; then
  technical_admin_auth='{"outcome":"not-attempted","credentialPreserved":false,"reEnrollmentRequired":false}'
fi
authority_resurrection_warning='Restoring an older snapshot may resurrect Grants, Grant Sessions, Ad Hoc Controller sessions, or QR-admitting state changed after the snapshot.'
restore_outcome="$(printf '%s\n' "$bounded_restore_report" | sed -n -E 's/^\{"restored":[^,]*,"outcome":"([^"]+)".*/\1/p')"
case "$restore_outcome" in
  restore-preparation-failed|restore-selection-invalid|restore-staging-failed|release-identity-invalid|activation-lock-unavailable|service-quiescence-failed|operator-authorization-failed)
    ;;
  *) restore_outcome="restore-failed" ;;
esac
stop_after_failure() {
  local state
  "$sudo_command" systemctl stop "$service_name" >/dev/null 2>&1 || return 1
  state="$("$systemctl_command" is-active "$service_name" 2>/dev/null || true)"
  [[ "$state" == inactive || "$state" == failed ]]
}
if (( restore_rc == 12 )); then
  if stop_after_failure; then
    printf '{"restored":false,"outcome":"cutover-completed-readiness-failed","cutoverCompleted":true,"restartVerified":false,"serviceStopped":true,"technicalAdminAuth":%s,"authorityResurrectionWarning":"%s"}\n' "$technical_admin_auth" "$authority_resurrection_warning" >&2
  else
    printf '{"restored":false,"outcome":"cutover-completed-readiness-failed","cutoverCompleted":true,"restartVerified":false,"serviceStopped":false,"technicalAdminAuth":%s,"authorityResurrectionWarning":"%s"}\n' "$technical_admin_auth" "$authority_resurrection_warning" >&2
  fi
  exit 12
fi
if (( restore_rc != 0 )); then
  if grep -Fq '"cutoverCompleted":true' <<<"$bounded_restore_report"; then
    if stop_after_failure; then
      printf '{"restored":false,"outcome":"cutover-completed-restore-failed","cutoverCompleted":true,"serviceStopped":true,"technicalAdminAuth":%s,"authorityResurrectionWarning":"%s"}\n' "$technical_admin_auth" "$authority_resurrection_warning" >&2
    else
      printf '{"restored":false,"outcome":"cutover-completed-restore-failed","cutoverCompleted":true,"serviceStopped":false,"technicalAdminAuth":%s,"authorityResurrectionWarning":"%s"}\n' "$technical_admin_auth" "$authority_resurrection_warning" >&2
    fi
    exit 12
  fi
  if stop_after_failure; then
    printf '{"restored":false,"outcome":"%s","cutoverCompleted":false,"serviceStopped":true,"technicalAdminAuth":%s}\n' "$restore_outcome" "$technical_admin_auth" >&2
  else
    printf '{"restored":false,"outcome":"%s","cutoverCompleted":false,"serviceStopped":false,"technicalAdminAuth":%s}\n' "$restore_outcome" "$technical_admin_auth" >&2
  fi
  exit 1
fi

if ! check_post_restart_readiness || ! check_public_home || ! check_public_health ||
  ! check_representative_event_read || ! check_authoritative_operation; then
  if stop_after_failure; then
    printf '{"restored":false,"outcome":"cutover-completed-readiness-failed","cutoverCompleted":true,"restartVerified":true,"postRestartVerified":false,"serviceStopped":true,"technicalAdminAuth":%s,"authorityResurrectionWarning":"%s"}\n' "$technical_admin_auth" "$authority_resurrection_warning" >&2
  else
    printf '{"restored":false,"outcome":"cutover-completed-readiness-failed","cutoverCompleted":true,"restartVerified":true,"postRestartVerified":false,"serviceStopped":false,"technicalAdminAuth":%s,"authorityResurrectionWarning":"%s"}\n' "$technical_admin_auth" "$authority_resurrection_warning" >&2
  fi
  exit 12
fi
printf '%s\n' "$bounded_restore_report"
printf '{"restored":true,"outcome":"cutover-completed","postRestartVerified":true,"technicalAdminAuth":%s}\n' "$technical_admin_auth"
