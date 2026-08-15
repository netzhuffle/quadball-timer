# Issue #168 privileged wrapper installation handoff

This handoff installs only the reviewed #168 privileged reporter wrapper on
`jannis.rocks`. It does not deploy a release, restart either service, change a
unit or sudoers rule, read a DSN, or contact GlitchTip. The previous wrapper is
retained as `/usr/local/sbin/quadball-timer-activation-maintenance.pre-168` for
bounded recovery.

The wrapper reads the selected Environment's root-controlled `GLITCHTIP_DSN`
without printing it, launches the bounded reporter independently from release
recovery, and stores only `sent`, `failed`, or `unavailable` in root-owned
`/run/quadball-timer-operational-status` records (`0700` directory, `0600`
files).

Run each fish block only if the preceding block succeeds. The blocks
intentionally contain no `exit`, because closing a failed block must not close
the operator's terminal tab.

## 1. Verify the accepted local candidate

```fish
set candidate_root (git rev-parse --show-toplevel)
set accepted_base 260a8b1deba98d6ed982be651928d268f274bb24
set wrapper_sha c892da10bff3350492ff5f17293e69b161ad33926bd75a7cffd7b231610643eb

cd $candidate_root
and test (git status --porcelain) = ""
and git diff --quiet
and git diff --cached --quiet
and test (git rev-list --count $accepted_base..HEAD) = 1
and test (git merge-base $accepted_base HEAD) = $accepted_base
and test (shasum -a 256 deploy/activation-maintenance-root.sh | awk '{print $1}') = $wrapper_sha
or begin
    echo "STOP: the #168 candidate is dirty, has the wrong ancestry, or has the wrong wrapper checksum." >&2
    false
end
```

## 2. Upload the exact reviewed wrapper

```fish
set candidate_dir (mktemp -d /tmp/quadball-timer-168-candidate.XXXXXX)
set remote_dir /tmp/quadball-timer-168-final-premerge

chmod 700 $candidate_dir
and cp deploy/activation-maintenance-root.sh $candidate_dir/activation-maintenance-root.sh
and test (shasum -a 256 $candidate_dir/activation-maintenance-root.sh | awk '{print $1}') = $wrapper_sha
and ssh jannis@jannis.rocks "test ! -e $remote_dir && /usr/bin/install -d -m 0700 $remote_dir"
and scp $candidate_dir/activation-maintenance-root.sh jannis@jannis.rocks:$remote_dir/activation-maintenance-root.sh
and set remote_wrapper_sha (ssh jannis@jannis.rocks "/usr/bin/sha256sum $remote_dir/activation-maintenance-root.sh | /usr/bin/awk '{print \\$1}'")
and test $remote_wrapper_sha = $wrapper_sha
or begin
    echo "STOP: wrapper staging or upload verification failed; nothing privileged was changed." >&2
    false
end
```

## 3. Install and verify in one privileged session

This replaces one root-owned executable and runs read-only unit/sudoers/service
checks plus `daemon-reload`. It does not stop or restart a service.

```fish
set remote_script (string join '; ' \
    'set -euo pipefail' \
    "/usr/bin/sha256sum $remote_dir/activation-maintenance-root.sh | /usr/bin/grep -F '$wrapper_sha  $remote_dir/activation-maintenance-root.sh'" \
    '/usr/bin/sudo -v' \
    "if /usr/bin/sudo /usr/bin/test -e /usr/local/sbin/quadball-timer-activation-maintenance.pre-168; then /usr/bin/sudo /usr/bin/test -f /usr/local/sbin/quadball-timer-activation-maintenance.pre-168; else /usr/bin/sudo /usr/bin/install -o root -g root -m 0755 /usr/local/sbin/quadball-timer-activation-maintenance /usr/local/sbin/quadball-timer-activation-maintenance.pre-168; fi" \
    "/usr/bin/sudo /usr/bin/install -o root -g root -m 0755 $remote_dir/activation-maintenance-root.sh /usr/local/sbin/quadball-timer-activation-maintenance.new-168" \
    "/usr/bin/sudo /usr/bin/sha256sum /usr/local/sbin/quadball-timer-activation-maintenance.new-168 | /usr/bin/grep -F '$wrapper_sha  /usr/local/sbin/quadball-timer-activation-maintenance.new-168'" \
    '/usr/bin/sudo /usr/bin/mv -T /usr/local/sbin/quadball-timer-activation-maintenance.new-168 /usr/local/sbin/quadball-timer-activation-maintenance' \
    "/usr/bin/sudo /usr/bin/sha256sum /usr/local/sbin/quadball-timer-activation-maintenance | /usr/bin/grep -F '$wrapper_sha  /usr/local/sbin/quadball-timer-activation-maintenance'" \
    "/usr/bin/sudo /usr/bin/stat -c '%n %U:%G %a' /usr/local/sbin/quadball-timer-activation-maintenance /usr/local/sbin/quadball-timer-activation-maintenance.pre-168" \
    '/usr/bin/sudo /usr/sbin/visudo -cf /etc/sudoers.d/deploy-quadball-timer' \
    '/usr/bin/sudo /usr/sbin/visudo -cf /etc/sudoers.d/deploy-quadball-timer-test' \
    "/usr/bin/sudo /usr/bin/systemctl show quadball-timer --property=User --property=Group --property=WorkingDirectory --property=EnvironmentFiles --property=StateDirectory --property=ExecStart --no-pager" \
    "/usr/bin/sudo /usr/bin/systemctl show quadball-timer-test --property=User --property=Group --property=WorkingDirectory --property=EnvironmentFiles --property=StateDirectory --property=ExecStart --no-pager" \
    '/usr/bin/sudo /usr/bin/systemctl daemon-reload' \
    '/usr/bin/sudo /usr/bin/systemctl is-active quadball-timer' \
    '/usr/bin/sudo /usr/bin/systemctl is-active quadball-timer-test' \
    "/usr/bin/rm -rf -- $remote_dir" \
    "/usr/bin/test ! -e $remote_dir" \
    "echo privileged-wrapper-install-ok")

ssh -tt jannis@jannis.rocks "/usr/bin/bash -c "(string escape -- $remote_script)
or begin
    echo "STOP: privileged wrapper installation or verification failed. Do not restart either service." >&2
    false
end
```

Expected terminal evidence includes the reviewed checksum for the installed
wrapper, `root:root 755`, both sudoers files parsing OK, both service contracts,
two `active` results, and `privileged-wrapper-install-ok`.

## 4. Remove the local staging copy

```fish
rm -rf -- $candidate_dir
and test ! -e $candidate_dir
and echo local-candidate-removed
```

## Recovery if the installed wrapper itself is defective

Recovery is a separate explicitly chosen action. Before using it, confirm the
failure is in the installed wrapper rather than the candidate executable. It
atomically restores only the retained pre-#168 wrapper and does not restart a
service:

```fish
ssh -tt jannis@jannis.rocks "/usr/bin/sudo -v && /usr/bin/sudo /usr/bin/test -f /usr/local/sbin/quadball-timer-activation-maintenance.pre-168 && /usr/bin/sudo /usr/bin/install -o root -g root -m 0755 /usr/local/sbin/quadball-timer-activation-maintenance.pre-168 /usr/local/sbin/quadball-timer-activation-maintenance.rollback-168 && /usr/bin/sudo /usr/bin/mv -T /usr/local/sbin/quadball-timer-activation-maintenance.rollback-168 /usr/local/sbin/quadball-timer-activation-maintenance && /usr/bin/sudo /usr/bin/stat -c '%n %U:%G %a' /usr/local/sbin/quadball-timer-activation-maintenance"
```

GlitchTip Test arrival and tags are a separate bounded operator check after the
Test DSN is installed. This handoff claims no live delivery result.
