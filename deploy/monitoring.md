# GlitchTip monitoring

Quadball Timer uses the supported `@sentry/bun` and `@sentry/react` clients. The
application rebuilds every event through `src/lib/monitoring-redaction.ts`
before transport; GlitchTip scrubbing is not the application privacy boundary.

The service reads `GLITCHTIP_DSN` only from the root-controlled environment file
outside the release bundle. Browser delivery uses the separate public DSN value
`PUBLIC_GLITCHTIP_DSN`; it is injected into the HTML without exposing the server
environment or any server credential. Both values are optional, so a missing or
failed monitoring transport never changes an application response or authority
decision.

Deployment, backup, migration, restore, and readiness failures use one
best-effort operational adapter. Its event is limited to the operation,
`Environment`, trusted release attempt when available, phase, bounded outcome,
bounded category, and timestamp. It never carries commands, environment values,
logs, paths, database/request data, credentials, authority/session data, restore
details, or WebAuthn details. Delivery is detached and bounded; output records
only `sent`, `failed`, or `unavailable`, never the event payload.

The activation shell delegates shell-owned failures to the root-owned
`activation-maintenance-root.sh` seam. That seam selects the Environment-specific
root-controlled `EnvironmentFile`, reads only `GLITCHTIP_DSN` without sourcing it,
and invokes the immutable release executable with the manifest release identity.
If the attempted candidate has not reached the immutable release directory, the
same seam uses the current installed executable while passing only the validated
attempt identity; it never executes the rejected staged candidate. A private
root-owned per-attempt record lets the workflow read only the latest bounded
delivery status through a five-second SSH boundary.
Missing DSN is reported as `unavailable`; it never changes activation cleanup,
rollback, or fail-closed results.

To exercise server delivery, from the Test host run this bounded transient unit.
It runs as the Test service identity, loads the root-controlled Test
`EnvironmentFile`, uses the immutable compiled release as its working directory,
and pipes only the command's bounded non-secret result (never the environment):

```fish
sudo systemd-run --wait --collect --pipe --quiet \
  --unit=quadball-timer-monitoring-test \
  --property=User=quadball-timer-test \
  --property=Group=quadball-timer-test \
  --property=WorkingDirectory=/srv/quadball-timer-test/current \
  --property=EnvironmentFile=/etc/quadball-timer/test.env \
  --setenv=NODE_ENV=production \
  --setenv=QUADBALL_ENVIRONMENT=test \
  /srv/quadball-timer-test/current/quadball-timer --emit-test-monitoring-error
```

The command emits one fixed harmless event and has no public HTTP route. It must
never be run against the Production environment. The repository convenience
command is `bun run monitoring:test` for non-deployed local Test configuration.

With the Test site open, the bounded browser check is performed from that same
Test browser's developer console:

```js
window.dispatchEvent(
  new ErrorEvent("error", { message: "Quadball Timer browser monitoring test" }),
);
```

Confirm that one browser event arrives with the Test Environment and active
release tags. Do not paste the event payload, credentials, cookies, or any
issue/workflow evidence; this check records only the operator's pass/fail
observation.
