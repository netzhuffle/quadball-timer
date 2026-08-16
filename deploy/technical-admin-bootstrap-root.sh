#!/usr/bin/env bash
# shellcheck disable=SC2329
set -euo pipefail

environment="${1:-}"
command="${2:-}"
if [[ "$#" -ne 2 ]]; then
  echo "Usage: technical-admin-bootstrap-root.sh <production|test> <status|enroll|reset>" >&2
  exit 2
fi

case "$environment" in
  production)
    service_name="quadball-timer"
    service_user="quadball-timer"
    release_base="/srv/quadball-timer"
    state_directory="/var/lib/quadball-timer"
    public_origin="https://timer.quadball.app"
    rp_id="timer.quadball.app"
    ;;
  test)
    service_name="quadball-timer-test"
    service_user="quadball-timer-test"
    release_base="/srv/quadball-timer-test"
    state_directory="/var/lib/quadball-timer-test"
    public_origin="https://test.timer.quadball.app"
    rp_id="test.timer.quadball.app"
    ;;
  *)
    echo "Unsupported Environment." >&2
    exit 2
    ;;
esac

case "$command" in
  status|enroll|reset) ;;
  *) echo "Unsupported Technical Admin bootstrap operation." >&2; exit 2 ;;
esac

focused_test_mode="${QBT_FOCUSED_TEST_MODE:-}"
if [[ "$focused_test_mode" == 1 ]]; then
  focused_test_root="${QBT_FOCUSED_TEST_ROOT:-}"
  [[ "$EUID" -ne 0 && "$focused_test_root" == /* && "$focused_test_root" != / ]] || {
    echo "Focused bootstrap mode requires a non-root disposable root." >&2
    exit 2
  }
  case "$focused_test_root" in
    *..*|*//* ) echo "Focused bootstrap root is unsafe." >&2; exit 2 ;;
  esac
  [[ -d "$focused_test_root" && ! -L "$focused_test_root" ]] || {
    echo "Focused bootstrap root is not a real directory." >&2
    exit 2
  }
  focused_test_root="$(cd -- "$focused_test_root" && pwd -P)"
  [[ "$focused_test_root" == "$QBT_FOCUSED_TEST_ROOT" ]] || {
    echo "Focused bootstrap root is not canonical." >&2
    exit 2
  }
  release_base="$focused_test_root$release_base"
  state_directory="$focused_test_root$state_directory"
  systemctl_command="${QBT_FOCUSED_TEST_SYSTEMCTL:-systemctl}"
  runuser_command="${QBT_FOCUSED_TEST_RUNUSER:-runuser}"
  realpath_command="${QBT_FOCUSED_TEST_REALPATH:-realpath}"
else
  [[ "$EUID" -eq 0 ]] || { echo "Technical Admin bootstrap requires root." >&2; exit 2; }
  [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != deploy-* ]] || {
    echo "Technical Admin bootstrap requires a human operator through sudo." >&2
    exit 2
  }
  [[ -t 0 && -t 1 ]] || {
    echo "Technical Admin bootstrap requires an interactive terminal." >&2
    exit 2
  }
  systemctl_command="/usr/bin/systemctl"
  runuser_command="/usr/sbin/runuser"
  realpath_command="/usr/bin/realpath"
fi

technical_admin_database="$state_directory/technical-admin.sqlite"
current_link="$release_base/current"
[[ -L "$current_link" ]] || { echo "Selected Environment has no current release." >&2; exit 1; }
release_dir="$($realpath_command -e -- "$current_link")" || {
  echo "Selected Environment current release is unavailable." >&2
  exit 1
}
[[ "$release_dir" == "$release_base"/releases/* && "$release_dir" != *..* && "$release_dir" != *//* ]] || {
  echo "Selected Environment current release is outside its release root." >&2
  exit 2
}
[[ -x "$release_dir/quadball-timer" && ! -L "$release_dir/quadball-timer" ]] || {
  echo "Selected Environment release executable is unavailable." >&2
  exit 1
}
[[ -f "$release_dir/release-manifest.json" && ! -L "$release_dir/release-manifest.json" ]] || {
  echo "Selected Environment release manifest is unavailable." >&2
  exit 1
}

operation_output=""
restart_required=0

restart_service() {
  "$systemctl_command" restart "$service_name" >/dev/null 2>&1 &&
    "$systemctl_command" is-active --quiet "$service_name" >/dev/null 2>&1
}

finish() {
  local status=$?
  trap - EXIT
  if ((restart_required == 1)); then
    if ! restart_service; then
      echo "Selected Environment service could not be confirmed active; authentication may already have changed." >&2
      status=1
    fi
    restart_required=0
  fi
  if ((status == 0)); then
    printf '%s\n' "$operation_output"
  fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' HUP INT TERM

restart_required=1
if ! "$systemctl_command" stop "$service_name" >/dev/null 2>&1; then
  echo "Selected Environment service could not be stopped; authentication was not changed." >&2
  exit 1
fi

set +e
operation_output="$(
  "$runuser_command" -u "$service_user" -- env -i \
    PATH=/usr/bin:/bin \
    NODE_ENV=production \
    QUADBALL_ENVIRONMENT="$environment" \
    PUBLIC_ORIGIN="$public_origin" \
    WEBAUTHN_RP_ID="$rp_id" \
    TECHNICAL_ADMIN_DATABASE="$technical_admin_database" \
    "$release_dir/quadball-timer" -- --technical-admin-bootstrap "$command"
)"
operation_status=$?
set -e
if ((operation_status != 0)); then
  echo "Technical Admin bootstrap operation failed; authentication may be unchanged or already changed." >&2
  exit "$operation_status"
fi

if [[ "$command" == status ]]; then
  [[ "$operation_output" == \{*\} && "$operation_output" != *$'\n'* ]] || {
    echo "Technical Admin status output was invalid." >&2
    exit 1
  }
else
  expected_enrollment_prefix="${public_origin}/admin/enroll#token="
  [[ "$operation_output" == "$expected_enrollment_prefix"* ]] || {
    echo "Technical Admin enrollment authorization output was invalid." >&2
    exit 1
  }
  enrollment_token="${operation_output#"$expected_enrollment_prefix"}"
  [[ -n "$enrollment_token" && "$enrollment_token" != *[[:space:]]* ]] || {
    echo "Technical Admin enrollment authorization output was invalid." >&2
    exit 1
  }
fi

exit 0
