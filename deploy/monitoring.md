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

The two environments use separate DSN pairs and must not reuse one another's
values:

| Environment | Server DSN | Browser DSN | Root-controlled file | Service group |
| --- | --- | --- | --- | --- |
| Production | `GLITCHTIP_DSN` | `PUBLIC_GLITCHTIP_DSN` | `/etc/quadball-timer/production.env` | `quadball-timer` |
| Test | `GLITCHTIP_DSN` | `PUBLIC_GLITCHTIP_DSN` | `/etc/quadball-timer/test.env` | `quadball-timer-test` |

The server DSN is never sent to a browser. The browser DSN is intentionally
public Sentry-compatible configuration, but remains outside the release and is
injected only by the matching Environment service. Install both files as
`root:<service-group>` with mode `0640`: Production uses
`root:quadball-timer` and Test uses `root:quadball-timer-test`, matching the
systemd units above. The optional Production file must be created with that
ownership before enabling Production delivery. Do not print either DSN while
checking the files: inspect only file metadata and the allowlisted variable
names.

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

The command emits one fixed harmless exception and has no public HTTP route. It must
never be run against the Production environment. The repository convenience
command is `bun run monitoring:test` for non-deployed local Test configuration.

With the Test site open, the bounded browser check is performed from that same
Test browser's developer console:

```js
window.dispatchEvent(
  new ErrorEvent("error", { message: "Quadball Timer browser monitoring test" }),
);
```

Confirm that exactly one browser error arrives with the Test Environment and
active immutable release/correlation tags, and that its displayed exception is
the generic redacted application shape rather than the dispatched message or
any browser/request data. Do not paste the event payload, credentials, cookies,
or any issue/workflow evidence; record only the operator's pass/fail
observation.
