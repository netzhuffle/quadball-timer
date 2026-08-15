# Issue #165 pre-merge activation handoff

This is the bounded, operator-run host prerequisite for the schema-aware
activation in Draft PR #222. It is intentionally separate from deployment:
the agent does not SSH, upload, install, restart, or change the live server.

Run it from a clean checkout containing the final #165 correction. The target
is `jannis.rocks` as login user `jannis`. Candidate upload and checksum
inspection are non-privileged. The privileged preflight, installation,
daemon-reload, backup-root preparation, and contract verification run inside
one interactive SSH session, whose single `sudo -v` prompt is the only
interactive secret entry. No secret is created, printed, uploaded, or stored
by this handoff.

The candidate files are the exact reviewed artifacts from accepted PR head
`38107e7c7708be601d5101e491fe95b68ce09f9e`. The checksums below pin every file
uploaded or installed by the sequence, including the two narrow sudoers files.

| Candidate | SHA-256 |
| --- | --- |
| `deploy/activation-maintenance-root.sh` | `aac4b8c2c3478165e7b356c41e809e522c59ab8f8889b8c9b39189050a6e361e` |
| `deploy/systemd/quadball-timer.service` | `9c9ab61dc4c8892ef5416703e0e5667752daca86e62630c90fdf889174c8e71e` |
| `deploy/systemd/quadball-timer-test.service` | `8885dfc9c1e1544c0cd14c8dd247dc2c46a44563049420807471a98813a541d2` |
| Production sudoers content | `c37a4991dec87b4ecc7d641dd0343a3e418ad00163a1df96df34384c0cf47d84` |
| Test sudoers content | `d7ce26e3686ddbe82945f7e28c08bba0bed37d86d9abfa3e3d58d405416e08fb` |

The sequence installs the shared root maintenance wrapper, the reviewed
Production unit, both dedicated sudoers files, and then reloads systemd. It
does not install or restart the Test unit: the existing Test unit is checked
against the reviewed checksum before any privileged mutation. If that check
fails, stop and investigate the drift rather than overwriting it. The
Production backup root is created only when absent and is otherwise required
to already be a non-symlink `root:quadball-timer` directory with mode `0750`.

## Runbook

Run this in fish from the candidate checkout:

```fish
set candidate_root (git rev-parse --show-toplevel)
and cd $candidate_root
and test (git status --porcelain) = ""
and git diff --quiet
and git diff --cached --quiet
or begin
    echo "Run this handoff only from a clean candidate checkout." >&2
    exit 1
end

set wrapper_sha aac4b8c2c3478165e7b356c41e809e522c59ab8f8889b8c9b39189050a6e361e
set production_unit_sha 9c9ab61dc4c8892ef5416703e0e5667752daca86e62630c90fdf889174c8e71e
set test_unit_sha 8885dfc9c1e1544c0cd14c8dd247dc2c46a44563049420807471a98813a541d2
set production_sudoers_sha c37a4991dec87b4ecc7d641dd0343a3e418ad00163a1df96df34384c0cf47d84
set test_sudoers_sha d7ce26e3686ddbe82945f7e28c08bba0bed37d86d9abfa3e3d58d405416e08fb
set candidate_dir (mktemp -d /tmp/quadball-timer-165-candidate.XXXXXX)
chmod 700 $candidate_dir
cp deploy/activation-maintenance-root.sh $candidate_dir/activation-maintenance-root.sh
cp deploy/systemd/quadball-timer.service $candidate_dir/quadball-timer.service
cp deploy/systemd/quadball-timer-test.service $candidate_dir/quadball-timer-test.service
printf '%s\n' 'deploy-quadball-timer ALL=(root) NOPASSWD: /usr/bin/systemctl stop quadball-timer, /usr/bin/systemctl restart quadball-timer, /usr/local/sbin/quadball-timer-activation-maintenance' > $candidate_dir/deploy-quadball-timer
printf '%s\n' 'deploy-quadball-timer-test ALL=(root) NOPASSWD: /usr/bin/systemctl stop quadball-timer-test, /usr/bin/systemctl restart quadball-timer-test, /usr/local/sbin/quadball-timer-activation-maintenance' > $candidate_dir/deploy-quadball-timer-test

test (shasum -a 256 $candidate_dir/activation-maintenance-root.sh | awk '{print $1}') = $wrapper_sha
and test (shasum -a 256 $candidate_dir/quadball-timer.service | awk '{print $1}') = $production_unit_sha
and test (shasum -a 256 $candidate_dir/quadball-timer-test.service | awk '{print $1}') = $test_unit_sha
and test (shasum -a 256 $candidate_dir/deploy-quadball-timer | awk '{print $1}') = $production_sudoers_sha
and test (shasum -a 256 $candidate_dir/deploy-quadball-timer-test | awk '{print $1}') = $test_sudoers_sha
or begin
    echo "A candidate artifact checksum does not match the reviewed contract." >&2
    rm -r $candidate_dir
    exit 1
end

set remote_dir /tmp/quadball-timer-165-final-premerge
ssh jannis@jannis.rocks "/usr/bin/bash -se -c 'test ! -e $remote_dir && /usr/bin/install -d -m 0700 $remote_dir'"
and scp $candidate_dir/activation-maintenance-root.sh jannis@jannis.rocks:$remote_dir/activation-maintenance-root.sh
and scp $candidate_dir/quadball-timer.service jannis@jannis.rocks:$remote_dir/quadball-timer.service
and scp $candidate_dir/quadball-timer-test.service jannis@jannis.rocks:$remote_dir/quadball-timer-test.service
and scp $candidate_dir/deploy-quadball-timer jannis@jannis.rocks:$remote_dir/deploy-quadball-timer
and scp $candidate_dir/deploy-quadball-timer-test jannis@jannis.rocks:$remote_dir/deploy-quadball-timer-test
or begin
    echo "Candidate upload failed; no privileged mutation was requested." >&2
    exit 1
end

set uploaded_hashes (ssh jannis@jannis.rocks "/usr/bin/sha256sum $remote_dir/activation-maintenance-root.sh $remote_dir/quadball-timer.service $remote_dir/quadball-timer-test.service $remote_dir/deploy-quadball-timer $remote_dir/deploy-quadball-timer-test")
string match -q -- "$wrapper_sha *" $uploaded_hashes
and string match -q -- "$production_unit_sha *" $uploaded_hashes
and string match -q -- "$test_unit_sha *" $uploaded_hashes
and string match -q -- "$production_sudoers_sha *" $uploaded_hashes
and string match -q -- "$test_sudoers_sha *" $uploaded_hashes
or begin
    echo "Uploaded artifact checksum verification failed; do not continue." >&2
    exit 1
end

# The next command opens one interactive SSH session and requests Jannis's
# sudo password once. Every privileged precondition, mutation, and
# verification stays inside this same PTY so the sudo timestamp is shared.
set privileged_command (string join ' ' \
    "/usr/bin/bash -se -c 'set -euo pipefail;" \
    "/usr/bin/sudo -v" \
    "&& /usr/bin/test \"\$(/usr/bin/id -un)\" = jannis" \
    "&& /usr/bin/test -x /usr/bin/systemctl" \
    "&& /usr/bin/test -x /usr/sbin/visudo" \
    "&& /usr/bin/test -d /srv/quadball-timer" \
    "&& /usr/bin/test -d /srv/quadball-timer-test" \
    "&& /usr/bin/test -d /etc/systemd/system" \
    "&& /usr/bin/test -d /etc/sudoers.d" \
    "&& /usr/bin/sudo /usr/sbin/visudo -cf $remote_dir/deploy-quadball-timer" \
    "&& /usr/bin/sudo /usr/sbin/visudo -cf $remote_dir/deploy-quadball-timer-test" \
    "&& /usr/bin/sudo /usr/bin/sha256sum /etc/systemd/system/quadball-timer-test.service | /usr/bin/grep -F \"$test_unit_sha  /etc/systemd/system/quadball-timer-test.service\"" \
    "&& if /usr/bin/sudo /usr/bin/test -e /etc/sudoers.d/deploy-quadball-timer; then /usr/bin/sudo /usr/bin/test ! -L /etc/sudoers.d/deploy-quadball-timer && /usr/bin/sudo /usr/bin/wc -l /etc/sudoers.d/deploy-quadball-timer | /usr/bin/grep -Eq \"^1[[:space:]]\"; fi" \
    "&& if /usr/bin/sudo /usr/bin/test -e /etc/sudoers.d/deploy-quadball-timer-test; then /usr/bin/sudo /usr/bin/test ! -L /etc/sudoers.d/deploy-quadball-timer-test && /usr/bin/sudo /usr/bin/wc -l /etc/sudoers.d/deploy-quadball-timer-test | /usr/bin/grep -Eq \"^1[[:space:]]\"; fi" \
    "&& /usr/bin/sudo /usr/bin/install -o root -g root -m 0755 $remote_dir/activation-maintenance-root.sh /usr/local/sbin/quadball-timer-activation-maintenance" \
    "&& /usr/bin/sudo /usr/bin/sha256sum /usr/local/sbin/quadball-timer-activation-maintenance | /usr/bin/grep -F \"$wrapper_sha  /usr/local/sbin/quadball-timer-activation-maintenance\"" \
    "&& /usr/bin/sudo /usr/bin/install -o root -g root -m 0644 $remote_dir/quadball-timer.service /etc/systemd/system/quadball-timer.service" \
    "&& /usr/bin/sudo /usr/bin/sha256sum /etc/systemd/system/quadball-timer.service | /usr/bin/grep -F \"$production_unit_sha  /etc/systemd/system/quadball-timer.service\"" \
    "&& /usr/bin/sudo /usr/bin/install -o root -g root -m 0440 $remote_dir/deploy-quadball-timer /etc/sudoers.d/deploy-quadball-timer" \
    "&& /usr/bin/sudo /usr/sbin/visudo -cf /etc/sudoers.d/deploy-quadball-timer" \
    "&& /usr/bin/sudo /usr/bin/sha256sum /etc/sudoers.d/deploy-quadball-timer | /usr/bin/grep -F \"$production_sudoers_sha  /etc/sudoers.d/deploy-quadball-timer\"" \
    "&& /usr/bin/sudo /usr/bin/install -o root -g root -m 0440 $remote_dir/deploy-quadball-timer-test /etc/sudoers.d/deploy-quadball-timer-test" \
    "&& /usr/bin/sudo /usr/sbin/visudo -cf /etc/sudoers.d/deploy-quadball-timer-test" \
    "&& /usr/bin/sudo /usr/bin/sha256sum /etc/sudoers.d/deploy-quadball-timer-test | /usr/bin/grep -F \"$test_sudoers_sha  /etc/sudoers.d/deploy-quadball-timer-test\"" \
    "&& /usr/bin/sudo /usr/bin/systemctl daemon-reload" \
    "&& test \"\$(/usr/bin/sudo /usr/bin/systemctl show quadball-timer --property=LoadState --value)\" = loaded" \
    "&& test \"\$(/usr/bin/sudo /usr/bin/systemctl show quadball-timer-test --property=LoadState --value)\" = loaded" \
    "&& if /usr/bin/sudo /usr/bin/test -e /var/backups/quadball-timer; then /usr/bin/sudo /usr/bin/test -d /var/backups/quadball-timer && /usr/bin/sudo /usr/bin/test ! -L /var/backups/quadball-timer && test \"\$(/usr/bin/sudo /usr/bin/stat -c \"%U:%G:%a\" /var/backups/quadball-timer)\" = root:quadball-timer:750; else /usr/bin/sudo /usr/bin/install -d -o root -g quadball-timer -m 0750 /var/backups/quadball-timer && test \"\$(/usr/bin/sudo /usr/bin/stat -c \"%U:%G:%a\" /var/backups/quadball-timer)\" = root:quadball-timer:750; fi" \
    "&& /usr/bin/sudo /usr/bin/sha256sum /usr/local/sbin/quadball-timer-activation-maintenance /etc/systemd/system/quadball-timer.service /etc/systemd/system/quadball-timer-test.service /etc/sudoers.d/deploy-quadball-timer /etc/sudoers.d/deploy-quadball-timer-test" \
    "&& /usr/bin/sudo /usr/bin/systemctl cat quadball-timer.service | /usr/bin/grep -E \"^(User|Group|WorkingDirectory|Environment=|EnvironmentFile|StateDirectory|StateDirectoryMode|ExecStart)=\"" \
    "&& /usr/bin/sudo /usr/bin/systemctl cat quadball-timer-test.service | /usr/bin/grep -E \"^(User|Group|WorkingDirectory|Environment=|EnvironmentFile|StateDirectory|StateDirectoryMode|ExecStart)=\"" \
    "&& /usr/bin/sudo /usr/sbin/visudo -cf /etc/sudoers.d/deploy-quadball-timer" \
    "&& /usr/bin/sudo /usr/sbin/visudo -cf /etc/sudoers.d/deploy-quadball-timer-test" \
    "&& /usr/bin/sudo /usr/bin/sudo -l -U deploy-quadball-timer" \
    "&& /usr/bin/sudo /usr/bin/sudo -l -U deploy-quadball-timer-test" \
    "&& /usr/bin/sudo /usr/bin/stat -c \"%n %U:%G %a\" /var/backups/quadball-timer'" )
ssh -tt jannis@jannis.rocks $privileged_command
or begin
    echo "Privileged host session failed; do not restart either service. Retain its non-secret output." >&2
    exit 1
end

# Cleanup is non-privileged, bounded to the exact fixed directory, and gated:
# local cleanup does not run unless remote deletion and absence both succeed.
set cleanup_command (string join ' ' \
    "/usr/bin/bash -se -c 'set -euo pipefail;" \
    "/usr/bin/test -d $remote_dir" \
    "&& /usr/bin/test ! -L $remote_dir" \
    "&& /usr/bin/rm -rf -- $remote_dir" \
    "&& /usr/bin/test ! -e $remote_dir'" )
ssh jannis@jannis.rocks $cleanup_command
and rm -r $candidate_dir
or begin
    echo "Remote or local temporary cleanup failed; do not rerun until inspected." >&2
    exit 1
end

```

No service restart is included. The handoff changes only root-owned wrapper,
unit, sudoers, and backup-root preparation state; it does not alter databases,
release pointers, application files, credentials, Grant key rings, Caddy, or
running service state. If any check fails, retain the printed non-secret
evidence and stop. Do not perform an automatic rollback or database restore.

Paste back:

- the five installed-artifact checksum lines;
- both `visudo -cf` success results;
- the filtered `systemctl cat` lines for `quadball-timer.service` and
  `quadball-timer-test.service`;
- the final backup-root metadata line; and
- confirmation that neither service was restarted; and
- confirmation that the fixed remote candidate directory was removed and
  verified absent.
