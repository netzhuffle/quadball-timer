# Test Environment host provisioning

This is the one-time privileged bootstrap for `test.timer.quadball.app`. It
creates a separate runtime user, release root, state directory, root-controlled
Test key file, and narrow deploy permission. It does not inspect, copy, restart,
or alter `quadball-timer.service`, `/srv/quadball-timer`, or
`/var/lib/quadball-timer`.

Run the following on `jannis.rocks` as `jannis` in fish:

```fish
set app quadball-timer-test
set deploy_user deploy-quadball-timer-test
set base_dir /srv/quadball-timer-test
set env_dir /etc/quadball-timer
set env_file $env_dir/test.env
set group $app

getent group $group >/dev/null 2>&1; or sudo groupadd --system $group
or begin
    echo "Could not create the dedicated Test system group: $group" >&2
    exit 1
end

id -u $app >/dev/null 2>&1; or sudo useradd --system --home-dir $base_dir --gid $group --shell /usr/sbin/nologin $app
or begin
    echo "Could not create the Test runtime user: $app" >&2
    exit 1
end

id -u $deploy_user >/dev/null 2>&1; or sudo useradd --system --create-home --home-dir /home/$deploy_user --gid $group --shell /bin/bash $deploy_user
or begin
    echo "Could not create the Test deploy user: $deploy_user" >&2
    exit 1
end

test (id -gn $app) = $group; and string match -q "*:$base_dir:/usr/sbin/nologin" -- (getent passwd $app)
or begin
    echo "Existing Test runtime user conflicts with the required group, home, or shell." >&2
    exit 1
end
test (id -gn $deploy_user) = $group; and string match -q "*:/home/$deploy_user:/bin/bash" -- (getent passwd $deploy_user)
or begin
    echo "Existing Test deploy user conflicts with the required group, home, or shell." >&2
    exit 1
end

sudo install -d -o $deploy_user -g $app -m 0700 /home/$deploy_user/.ssh
sudo install -d -o $deploy_user -g $app -m 2750 $base_dir $base_dir/releases
sudo install -d -o root -g $app -m 0750 $env_dir
sudo test -s $env_file; or begin
    set secret_dir (mktemp -d /tmp/quadball-timer-test-keys.XXXXXX)
    set generated_env $secret_dir/test.env
    for name in GRANT_ENCRYPTION_KEY GRANT_LOOKUP_KEY GRANT_AUDIT_KEY EVENT_GAME_ENCRYPTION_KEY EVENT_GAME_LOOKUP_KEY EVENT_GAME_AUDIT_KEY
        openssl rand -hex 32 > $secret_dir/$name
        printf '%s=' $name >> $generated_env
        cat $secret_dir/$name >> $generated_env
        printf '\n' >> $generated_env
    end
    chmod 600 $secret_dir/*
    sudo install -o root -g $app -m 0640 $generated_env $env_file
    rm -rf $secret_dir
end
```

The block generates six distinct Test-only 32-byte keys into a private
temporary directory and installs them without printing their values. It does
not overwrite an existing non-empty key file. Never reuse a Production key.

Create a dedicated Test-only Ed25519 deploy key in 1Password. Use no
passphrase because this workflow reads the key from the GitHub encrypted
secret non-interactively. Keep the private key in 1Password and never paste it
into a terminal command or commit it. Copy only the public key to a temporary
local file, then upload that public key to the server.

Run locally in fish after copying the public key from 1Password:

```fish
set key_dir (mktemp -d /tmp/quadball-timer-test-deploy.XXXXXX)
chmod 700 $key_dir
pbpaste > $key_dir/test-deploy.pub
chmod 644 $key_dir/test-deploy.pub
scp $key_dir/test-deploy.pub jannis@jannis.rocks:/tmp/quadball-timer-test-deploy.pub
```

Run on `jannis.rocks` as `jannis` in fish to install that public key for the
dedicated deploy user, then remove the temporary server copy:

```fish
set deploy_user deploy-quadball-timer-test
set app quadball-timer-test
sudo install -d -o $deploy_user -g $app -m 0700 /home/$deploy_user/.ssh
sudo install -o $deploy_user -g $app -m 0600 /tmp/quadball-timer-test-deploy.pub /home/$deploy_user/.ssh/authorized_keys
sudo rm -f /tmp/quadball-timer-test-deploy.pub
sudo ssh-keygen -lf /home/$deploy_user/.ssh/authorized_keys
```

Copy the matching private key from 1Password into a local private temporary
file without printing it, then set the GitHub `test` environment values. The
host, user, and deploy base are fixed by this ticket; the known-hosts file must
contain the verified key returned for `jannis.rocks` by `ssh-keyscan` and must
not be replaced with `StrictHostKeyChecking=no`.

Run locally in fish:

```fish
set private_key $key_dir/test-deploy
pbpaste > $private_key
chmod 600 $private_key
set known_hosts_file $key_dir/known_hosts
ssh-keyscan -H jannis.rocks > $known_hosts_file
chmod 644 $known_hosts_file
ssh-keygen -lf $known_hosts_file

set repo (gh repo view --json nameWithOwner --jq .nameWithOwner)
gh api --method PUT repos/$repo/environments/test >/dev/null
gh secret set TEST_SSH_KEY --env test < $private_key
gh secret set TEST_KNOWN_HOSTS --env test < $known_hosts_file
gh secret set TEST_HOST --env test --body jannis.rocks
gh secret set TEST_USER --env test --body deploy-quadball-timer-test
gh variable set TEST_DEPLOY_BASE --env test --body /srv/quadball-timer-test
rm -rf $key_dir
```

The GitHub commands read the private key and known-hosts file from stdin and
do not print their values. Confirm the `ssh-keygen` fingerprint against the
trusted host record already used for `jannis.rocks` before setting
`TEST_KNOWN_HOSTS`; do not accept an unexpected fingerprint.

The first Test workflow run can upload its immutable release but will stop at
activation until this unit is installed. Install the narrow restart permission
and load the unit after that upload. Replace `$release_id` with the
40-character commit shown by that workflow, then rerun the same workflow:

```fish
set release_id "REPLACE_WITH_RELEASE_ATTEMPT_ID"
set unit_source /srv/quadball-timer-test/releases/$release_id/deploy/systemd/quadball-timer-test.service

sudo install -o root -g root -m 0644 $unit_source /etc/systemd/system/quadball-timer-test.service
sudo systemctl daemon-reload
sudo systemctl enable quadball-timer-test
sudo visudo -f /etc/sudoers.d/deploy-quadball-timer-test
```

The sudoers file must contain only:

```text
deploy-quadball-timer-test ALL=(root) NOPASSWD: /usr/bin/systemctl restart quadball-timer-test
```

Verify the bounded result without printing the key file:

```fish
id $app
id $deploy_user
ls -ld $base_dir $base_dir/releases
sudo stat -c '%U:%G %a' $env_file
sudo systemctl cat quadball-timer-test.service | string match -r '^(User|Group|WorkingDirectory|Environment=|EnvironmentFile|StateDirectory|ExecStart)='
sudo -l -U $deploy_user
```

The service starts only when the Test activation script switches the separate
`/srv/quadball-timer-test/current` pointer. The application owns the separate
`/var/lib/quadball-timer-test` state and uses the canonical Test origin; no
Production database, credential, service, pointer, or public route is used.

After the Test service and Caddy route are active, run this bounded public
verification locally in fish:

```fish
set headers (mktemp /tmp/quadball-timer-test-headers.XXXXXX)
set body (mktemp /tmp/quadball-timer-test-body.XXXXXX)
curl --fail --silent --show-error --max-time 10 -D $headers https://test.timer.quadball.app/ -o $body
and grep -Fq 'Test environment — not for live games' $body
and grep -Eiq '^x-robots-tag: noindex, nofollow, noarchive, noimageindex\r?$' $headers
and grep -Eq '^HTTP/[^ ]+ 200([[:space:]]|$)' $headers
set smoke_status $status
rm -f $headers $body
exit $smoke_status
```
