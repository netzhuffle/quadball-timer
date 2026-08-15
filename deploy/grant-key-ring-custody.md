# Grant key-ring custody

Production and Test use independent versioned Grant key rings. The active
server files are:

- Production: /etc/quadball-timer/production-grant-key-ring.json
- Test: /etc/quadball-timer/test-grant-key-ring.json

Each file is a JSON document with the Environment identity, format version,
generation time, current version, and every retained encryption, lookup, and
audit key version. The file must be a regular root-owned file with mode 0600 or
0640. Its parent must also be root-owned and not group- or world-writable.
Systemd passes only the environment-specific path to the service. The release,
repository, database, workflow artifact, logs, and public responses never
contain the ring.

The canonical legacy EnvironmentFiles for the one-time conversion are
/etc/quadball-timer/production.env and /etc/quadball-timer/test.env. Both are
root-controlled. The Production unit treats production.env as optional because
the pre-#162 unit did not establish that file; the Test unit loads test.env.
When either file exists, only its unrelated EnvironmentFile entries remain
after conversion; Grant authority reads the versioned ring files.

## Pre-merge bootstrap

The executable already installed at `/srv/quadball-timer/current` is the
pre-#162 binary and does not contain the `--grant-key-ring` mode. Before
merging or restarting, build a candidate helper from the reviewed checkout
on the operator workstation and install it beside the service releases. This
does not invoke 1Password or restart either service.

On the operator workstation, in the candidate checkout:

```fish
bun run build:executable
scp dist/quadball-timer jannis@jannis.rocks:/tmp/quadball-timer-162-candidate
```

On `jannis.rocks`, still without restarting:

```fish
sudo install -d -o root -g root -m 0755 /usr/local/libexec
sudo install -o root -g root -m 0755 /tmp/quadball-timer-162-candidate /usr/local/libexec/quadball-timer-grant-key-ring-candidate
set bootstrap_dir /root/quadball-timer-grant-bootstrap
sudo install -d -o root -g root -m 0700 $bootstrap_dir
```

Before choosing the conversion branch, inspect the live Production source
without printing any values. This read-only inspection prints only configured
paths, file metadata, and the names of any inline GRANT variables:

```fish
sudo systemctl show quadball-timer --property=FragmentPath --property=DropInPaths --property=EnvironmentFiles --value
for source in (sudo systemctl show quadball-timer --property=EnvironmentFiles --value | string match -r -o -- '/[^ )]+')
    set source_path (string replace -r '^-?' '' -- $source)
    test -n "$source_path"; and sudo stat -c '%n %U:%G %a' "$source_path"
end
sudo systemctl show quadball-timer --property=Environment --value | awk 'BEGIN { RS=" "; ORS="\n" } { name=$0; sub(/=.*/, "", name); if (name ~ /^GRANT_(ENCRYPTION|LOOKUP|AUDIT)_KEY$/) print name }'
```

If the inspection finds legacy GRANT names in an existing root-controlled
EnvironmentFile, use that exact path as `production_legacy_file`. If it finds
inline GRANT names in the old unit or drop-in, extract only those values into
the root-private bootstrap directory without displaying them, then use that
file as the source:

```fish
sudo systemctl show quadball-timer --property=Environment --value | awk 'BEGIN { RS=" "; ORS="\n" } $0 ~ /^GRANT_(ENCRYPTION|LOOKUP|AUDIT)_KEY=/ { print }' | sudo tee $bootstrap_dir/production-inline.env >/dev/null
sudo chown root:quadball-timer $bootstrap_dir/production-inline.env
sudo chmod 0640 $bootstrap_dir/production-inline.env
set production_legacy_file $bootstrap_dir/production-inline.env
```

If no GRANT names are found in either source, do not invent a legacy file:
generate a fresh Production v1 ring on the operator workstation with the
local `bun run grant:key-ring create` flow below, store its separate recovery
handoff, and transfer only its active ring into `$bootstrap_dir` for install.
For this branch, use the following exact workstation transfer. The remote
`mktemp` creates the upload atomically before `scp`; the remote command then
makes it private, installs it into the root-only bootstrap directory, verifies
it, and removes the upload without printing key material:

```fish
set fresh_production_dir (mktemp -d /tmp/quadball-grant-production-fresh.XXXXXX)
chmod 700 $fresh_production_dir
bun run grant:key-ring create --environment production --active-file $fresh_production_dir/production-grant-key-ring.json --handoff-file $fresh_production_dir/production-grant-key-ring-1password.json --required-version v1
set remote_bootstrap_dir /root/quadball-timer-grant-bootstrap
set fresh_upload (ssh jannis@jannis.rocks 'mktemp /tmp/quadball-grant-production-fresh-upload.XXXXXX')
scp $fresh_production_dir/production-grant-key-ring.json jannis@jannis.rocks:$fresh_upload
ssh jannis@jannis.rocks "chmod 600 $fresh_upload; sudo install -o root -g root -m 0600 $fresh_upload $remote_bootstrap_dir/production-grant-key-ring.json; sudo /usr/local/libexec/quadball-timer-grant-key-ring-candidate --grant-key-ring verify --environment production --active-file $remote_bootstrap_dir/production-grant-key-ring.json --required-version v1; rm -f $fresh_upload"
```

If legacy values were found, set `production_legacy_file` to the inspected
EnvironmentFile or extracted inline file, then run the Production conversion.
The following assignment is the canonical-file example; replace it with the exact
path reported by the read-only inspection when the source is elsewhere:

```fish
set production_legacy_file /etc/quadball-timer/production.env
```

The candidate helper reads the exact existing legacy source and writes a
temporary ring and recovery handoff without accepting key values in arguments
or printing them. Run the selected Production conversion explicitly:

```fish
sudo /usr/local/libexec/quadball-timer-grant-key-ring-candidate --grant-key-ring convert --environment production --legacy-file $production_legacy_file --active-file $bootstrap_dir/production-grant-key-ring.json --handoff-file $bootstrap_dir/production-grant-key-ring-1password.json --required-version v1
sudo /usr/local/libexec/quadball-timer-grant-key-ring-candidate --grant-key-ring verify --environment production --active-file $bootstrap_dir/production-grant-key-ring.json --required-version v1
```

Independently, convert and verify the Test legacy source:

```fish
sudo /usr/local/libexec/quadball-timer-grant-key-ring-candidate --grant-key-ring convert --environment test --legacy-file /etc/quadball-timer/test.env --active-file $bootstrap_dir/test-grant-key-ring.json --handoff-file $bootstrap_dir/test-grant-key-ring-1password.json --required-version v1
sudo /usr/local/libexec/quadball-timer-grant-key-ring-candidate --grant-key-ring verify --environment test --active-file $bootstrap_dir/test-grant-key-ring.json --required-version v1
```

Transfer each root-generated 0600 handoff to Jannis's private workstation
without displaying it. On the host, make a temporary Jannis-owned copy; on
the workstation, use a private directory and `scp`; then remove both host
copies. The commands transfer paths only and never place secret values in an
argument. The Production copy exists in this block only when the legacy
conversion branch was selected; for the fresh-ring branch, keep and store the
workstation-created handoff from `$fresh_production_dir` directly on the
private workstation and never upload it to the host:

```fish
sudo install -d -o jannis -m 0700 /home/jannis/.quadball-timer-grant-handoffs
# Legacy Production branch only; omit this Production line for a fresh ring.
sudo install -o jannis -m 0600 $bootstrap_dir/production-grant-key-ring-1password.json /home/jannis/.quadball-timer-grant-handoffs/production-grant-key-ring-1password.json
sudo install -o jannis -m 0600 $bootstrap_dir/test-grant-key-ring-1password.json /home/jannis/.quadball-timer-grant-handoffs/test-grant-key-ring-1password.json
```

On the private workstation:

```fish
set handoff_dir (mktemp -d /tmp/quadball-grant-handoffs.XXXXXX)
chmod 700 $handoff_dir
# Legacy Production branch only; omit these three Production lines for a fresh ring.
scp jannis@jannis.rocks:/home/jannis/.quadball-timer-grant-handoffs/production-grant-key-ring-1password.json $handoff_dir/production-grant-key-ring-1password.json
chmod 600 $handoff_dir/production-grant-key-ring-1password.json
test -s $handoff_dir/production-grant-key-ring-1password.json
scp jannis@jannis.rocks:/home/jannis/.quadball-timer-grant-handoffs/test-grant-key-ring-1password.json $handoff_dir/test-grant-key-ring-1password.json
chmod 600 $handoff_dir/test-grant-key-ring-1password.json
test -s $handoff_dir/test-grant-key-ring-1password.json
```

Store each handoff's protected `keyRing` object in its matching separate
1Password recovery item from that private directory, without printing the
files. Now install and verify each ring before removing its legacy variables:

```fish
sudo install -o root -g quadball-timer -m 0640 $bootstrap_dir/production-grant-key-ring.json /etc/quadball-timer/production-grant-key-ring.json
sudo /usr/local/libexec/quadball-timer-grant-key-ring-candidate --grant-key-ring verify --environment production --active-file /etc/quadball-timer/production-grant-key-ring.json --required-version v1
if set -q production_legacy_file
    sudo /usr/local/libexec/quadball-timer-grant-key-ring-candidate --grant-key-ring remove-legacy --environment production --legacy-file $production_legacy_file --active-file /etc/quadball-timer/production-grant-key-ring.json --required-version v1
end
sudo install -o root -g quadball-timer-test -m 0640 $bootstrap_dir/test-grant-key-ring.json /etc/quadball-timer/test-grant-key-ring.json
sudo /usr/local/libexec/quadball-timer-grant-key-ring-candidate --grant-key-ring verify --environment test --active-file /etc/quadball-timer/test-grant-key-ring.json --required-version v1
sudo /usr/local/libexec/quadball-timer-grant-key-ring-candidate --grant-key-ring remove-legacy --environment test --legacy-file /etc/quadball-timer/test.env --active-file /etc/quadball-timer/test-grant-key-ring.json --required-version v1
```

Only after both handoffs are stored and both rings are installed and verified,
upload and install the new unit files and reload systemd:

On the private workstation:

```fish
scp deploy/systemd/quadball-timer.service jannis@jannis.rocks:/tmp/quadball-timer.service-162-candidate
scp deploy/systemd/quadball-timer-test.service jannis@jannis.rocks:/tmp/quadball-timer-test.service-162-candidate
```

On `jannis.rocks`, still without restarting:

```fish
sudo install -o root -g root -m 0644 /tmp/quadball-timer.service-162-candidate /etc/systemd/system/quadball-timer.service
sudo install -o root -g root -m 0644 /tmp/quadball-timer-test.service-162-candidate /etc/systemd/system/quadball-timer-test.service
sudo systemctl daemon-reload
```

Now verify the installed unit contracts and the actual optional Production
EnvironmentFile state:

```fish
sudo systemctl show quadball-timer --property=ExecStart --value | string match -q '*quadball-timer/current/quadball-timer*'
and sudo systemctl show quadball-timer --property=EnvironmentFiles --value | string match -q '*production.env*'
and sudo systemctl show quadball-timer-test --property=ExecStart --value | string match -q '*quadball-timer-test/current/quadball-timer*'
and sudo systemctl show quadball-timer-test --property=EnvironmentFiles --value | string match -q '*test.env*'
if sudo test -e /etc/quadball-timer/production.env
    sudo stat -c '%n %U:%G %a' /etc/quadball-timer/production.env
    and sudo -u quadball-timer test -r /etc/quadball-timer/production.env
else
    echo 'production.env is absent; the Production EnvironmentFile is optional.'
end
```

Then, on the host, remove temporary server copies:

```fish
sudo rm -f /tmp/quadball-timer-162-candidate /tmp/quadball-timer.service-162-candidate /tmp/quadball-timer-test.service-162-candidate
sudo rm -f /home/jannis/.quadball-timer-grant-handoffs/production-grant-key-ring-1password.json /home/jannis/.quadball-timer-grant-handoffs/test-grant-key-ring-1password.json
sudo rmdir /home/jannis/.quadball-timer-grant-handoffs
sudo rm -f $bootstrap_dir/production-grant-key-ring.json $bootstrap_dir/production-grant-key-ring-1password.json $bootstrap_dir/test-grant-key-ring.json $bootstrap_dir/test-grant-key-ring-1password.json $bootstrap_dir/production-inline.env
sudo rmdir $bootstrap_dir
sudo rm -f /usr/local/libexec/quadball-timer-grant-key-ring-candidate
```

After the separate items are checked, remove the private workstation
temporary directories, including the fresh Production handoff directory when
that branch was used:

```fish
rm -r $handoff_dir
if set -q fresh_production_dir
    rm -r $fresh_production_dir
end
```

Only after both rings, both separate recovery items, any applicable legacy
EnvironmentFiles, and both installed units verify should the change be merged
and the normal release activation and restart run. If bootstrap fails, do not
merge or restart; leave the existing services untouched and retain only the
bounded evidence needed for repair.

## One-time setup and recovery item

Generate each ring on an operator workstation, never on the server. Use a
different private temporary directory for each Environment:

```fish
set ring_dir (mktemp -d /tmp/quadball-grant-ring-production.XXXXXX)
chmod 700 $ring_dir
bun run grant:key-ring create --environment production --active-file $ring_dir/production-grant-key-ring.json --handoff-file $ring_dir/production-1password.json
```

Store the handoff's protected keyRing object in the separate 1Password item
Quadball Timer Production Grant Key Ring Recovery. Store the corresponding
Test handoff in Quadball Timer Test Grant Key Ring Recovery; never share an
item or ring between Environments. The non-secret item metadata is the
Environment, format version, generatedAt, currentVersions, and retainedVersions.
Delete the local handoff only after the item has been checked.

Transfer only the active ring file to the host through the approved operator
transfer path, then install it as root with group read access for the matching
service user. Do not transfer the handoff to the server:

```fish
sudo install -o root -g quadball-timer -m 0640 $ring_dir/production-grant-key-ring.json /etc/quadball-timer/production-grant-key-ring.json
```

For Test, use group quadball-timer-test and the Test path. The deployed
compiled executable contains the host-local verifier, so the operator does
not depend on repository source being present. Verify an operator-reinstalled
copy with sudo; root ownership is expected and no key material is printed:

```fish
sudo /srv/quadball-timer/current/quadball-timer --grant-key-ring verify --environment production --active-file /etc/quadball-timer/production-grant-key-ring.json --required-version v1
```

Verification prints only the format, Environment, generation time, current
versions, and retained-version counts. A missing, malformed, cross-environment,
incompletely versioned, or unsafe file fails closed.

## Legacy conversion

An existing root-controlled environment file may contain the old
GRANT_ENCRYPTION_KEY, GRANT_LOOKUP_KEY, and GRANT_AUDIT_KEY entries. Convert
those values in place without putting them in arguments or output. The
compiled executable reads the file itself and writes a new v1 ring and
handoff:

```fish
set host_bootstrap_dir /root/quadball-timer-grant-bootstrap
sudo install -d -o root -g root -m 0700 $host_bootstrap_dir
sudo /srv/quadball-timer-test/current/quadball-timer --grant-key-ring convert --environment test --legacy-file /etc/quadball-timer/test.env --active-file $host_bootstrap_dir/test-grant-key-ring.json --handoff-file $host_bootstrap_dir/test-grant-key-ring-1password.json --required-version v1
sudo /srv/quadball-timer-test/current/quadball-timer --grant-key-ring verify --environment test --active-file $host_bootstrap_dir/test-grant-key-ring.json --required-version v1
sudo install -o root -g quadball-timer-test -m 0640 $host_bootstrap_dir/test-grant-key-ring.json /etc/quadball-timer/test-grant-key-ring.json
sudo /srv/quadball-timer-test/current/quadball-timer --grant-key-ring verify --environment test --active-file /etc/quadball-timer/test-grant-key-ring.json --required-version v1
sudo /srv/quadball-timer-test/current/quadball-timer --grant-key-ring remove-legacy --environment test --legacy-file /etc/quadball-timer/test.env --active-file /etc/quadball-timer/test-grant-key-ring.json --required-version v1
```

Use this exact Production sequence after the read-only source inspection has
selected an existing legacy file. It uses `/srv/quadball-timer/current`, the
inspected `production_legacy_file`, and Environment identity `production`.
Move the handoff to the operator's private workstation using the safe
pre-merge transfer above, store it in the separate Production 1Password
recovery item, then install only the active ring:

```fish
set host_bootstrap_dir /root/quadball-timer-grant-bootstrap
sudo install -d -o root -g root -m 0700 $host_bootstrap_dir
# Replace this with the exact inspected legacy source when it is not the
# canonical EnvironmentFile.
set production_legacy_file /etc/quadball-timer/production.env
sudo /srv/quadball-timer/current/quadball-timer --grant-key-ring convert --environment production --legacy-file $production_legacy_file --active-file $host_bootstrap_dir/production-grant-key-ring.json --handoff-file $host_bootstrap_dir/production-grant-key-ring-1password.json --required-version v1
sudo /srv/quadball-timer/current/quadball-timer --grant-key-ring verify --environment production --active-file $host_bootstrap_dir/production-grant-key-ring.json --required-version v1
sudo install -o root -g quadball-timer -m 0640 $host_bootstrap_dir/production-grant-key-ring.json /etc/quadball-timer/production-grant-key-ring.json
sudo /srv/quadball-timer/current/quadball-timer --grant-key-ring verify --environment production --active-file /etc/quadball-timer/production-grant-key-ring.json --required-version v1
sudo /srv/quadball-timer/current/quadball-timer --grant-key-ring remove-legacy --environment production --legacy-file $production_legacy_file --active-file /etc/quadball-timer/production-grant-key-ring.json --required-version v1
```

Only after the installed ring verifies does remove-legacy rewrite the legacy
file without the three GRANT entries; unrelated Event Game entries remain.
Keep the temporary handoff until its 1Password item is checked, then remove
the temporary files. Repeat the same conversion sequence independently for
Production and Test.

## Rotation

Rotation is the only operation that changes the recovery item. Restore the
current ring from the matching recovery item into a user-owned private
workstation directory, then use the local Bun CLI to create a new active copy
and handoff while retaining every old version:

```fish
set rotation_dir (mktemp -d /tmp/quadball-grant-ring-production-rotate.XXXXXX)
chmod 700 $rotation_dir
bun run grant:key-ring rotate --environment production --input $rotation_dir/current.json --active-file $rotation_dir/production-grant-key-ring.json --handoff-file $rotation_dir/production-1password.json --next-version v2 --required-version v1
bun run grant:key-ring verify --environment production --active-file $rotation_dir/production-grant-key-ring.json --required-version v1
```

Install the new active file, verify it, and replace the matching 1Password
item's protected keyRing object. Individual Grant creation, rotation, disable,
revoke, expiry, or recreation does not rotate this ring and does not require a
1Password change. The service does not install, authenticate to, invoke, or
fetch from 1Password.
