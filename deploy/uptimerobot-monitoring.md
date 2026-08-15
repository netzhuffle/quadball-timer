# Production UptimeRobot monitoring

Quadball Timer exposes one deliberately minimal public readiness route at
`/healthz`. It returns HTTP `200` and the fixed body `healthy` only when the
core service boundary—the Technical Admin store and Foundation database,
migrations, replay checks, required keys, and authoritative write boundary—is
ready. Every unavailable or unsafe state returns HTTP `503` and the fixed body
`unhealthy`. The public monitor does not require the separately optional Live
Event runtime to be configured; Event, Ad Hoc, and Grant operations retain
their own readiness and fail-closed boundaries. The response is
`Cache-Control: no-store`; it never includes release, commit, runtime, schema,
database, credential, object-count, dependency, or diagnostic information.

The existing `/internal/healthz` endpoint remains a loopback-only process
liveness check for activation. It is not a public monitor and must continue to
return `404` through the public Production host. The separate loopback-only
`/internal/release` endpoint remains the non-public release identity check.

The Test deployment may expose the same `/healthz` route for deterministic
verification, but it has no UptimeRobot monitor obligation.

## Operator-owned UptimeRobot setup

Create these two monitors in the operator-owned UptimeRobot account. Use
method `GET`, a five-minute interval, and the operator's existing Production
availability contact group:

| Monitor | UptimeRobot monitor type | URL | Expected result |
| --- | --- | --- | --- |
| Production Home | HTTP(s) | `https://timer.quadball.app/` | status `200` |
| Production health | HTTP(s) Keyword | `https://timer.quadball.app/healthz` | status `200`, alert when keyword `unhealthy` exists |

For Production health, select the HTTP(s) Keyword monitor type and configure
the exact keyword `unhealthy` with the `Keyword Exists` alert condition. The
monitor must remain up only for a successful HTTP response whose body does not
contain `unhealthy`; the UptimeRobot keyword condition must alert when that
word appears. Do not configure a positive `healthy` substring match: `healthy`
is contained in `unhealthy`. Do not use a private header, cookie, token, or
account credential. The bounded local verification below checks the exact
successful body `healthy\n` by comparing its UTF-8 bytes.

Use UptimeRobot's free five-minute HTTP monitors. Do not configure a paid
one-minute plan or a continuous WebSocket monitor for this SQM slice. Route
both monitors to the operator's existing Production availability contact
group. Monitor ownership, contact routing, and alert mute/escalation choices
are external account settings; do not add account IDs, API keys, webhook
secrets, or copied private diagnostics to this repository, release artifact,
server environment, or deployment workflow.

## Bounded human verification

After the Production route is deployed, run this in fish from a trusted
operator workstation:

```fish
set home_code (curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' https://timer.quadball.app/)
if not test "$home_code" = 200
    echo "Production Home returned HTTP $home_code" >&2
    exit 1
end
set health_body (mktemp /tmp/quadball-timer-health-body.XXXXXX)
set health_code (curl --silent --show-error --max-time 10 --output $health_body --write-out '%{http_code}' https://timer.quadball.app/healthz)
if not test "$health_code" = 200
    rm -f $health_body
    echo "Production health returned HTTP $health_code" >&2
    exit 1
end
set health_body_hex (od -An -tx1 -v $health_body | string join "" | string replace -a " " "")
if not test "$health_body_hex" = 6865616c7468790a
    rm -f $health_body
    echo "Production health did not return the exact expected body" >&2
    exit 1
end
rm -f $health_body
```

Then confirm the Production Home monitor reports status `200` and the
Production health HTTP(s) Keyword monitor reports status `200` and remains up
when `unhealthy` is absent. Confirm that a response containing `unhealthy`
would trigger the configured keyword alert; do not copy response captures or
private monitor diagnostics into the handoff.
Record only the monitor names, URLs, interval, and observed HTTP outcome in
the deployment handoff. Do not export monitor credentials, response captures,
or private UptimeRobot diagnostics. This external check is a human
setup/verification step and is not run by the application test suite or
deployment workflow.
