# Production UptimeRobot monitoring

Quadball Timer exposes one deliberately minimal public readiness route at
`/healthz`. It returns HTTP `200` and the fixed body `healthy` only when the
Technical Admin store, Foundation database, migration/readiness checks, and
authoritative write boundary are ready. Every unavailable or unsafe state
returns HTTP `503` and the fixed body `unhealthy`. The response is
`Cache-Control: no-store`; it never includes release, commit, runtime, schema,
database, credential, object-count, dependency, or diagnostic information.

The existing `/internal/healthz` endpoint remains a loopback-only process
liveness check for activation. It is not a public monitor and must continue to
return `404` through the public Production host. The separate loopback-only
`/internal/release` endpoint remains the non-public release identity check.

The Test deployment may expose the same `/healthz` route for deterministic
verification, but it has no UptimeRobot monitor obligation.

## Operator-owned UptimeRobot setup

Create these two monitors in the operator-owned UptimeRobot account:

| Monitor | URL | Expected result | Interval |
| --- | --- | --- | --- |
| Production Home | `https://timer.quadball.app/` | HTTP `200` | 5 minutes |
| Production health | `https://timer.quadball.app/healthz` | HTTP `200` and body containing `healthy` | 5 minutes |

Use UptimeRobot's free five-minute HTTP monitors. Do not configure a paid
one-minute plan or a continuous WebSocket monitor for this SQM slice. Route
both monitors to the operator's existing Production availability contact
group. Monitor ownership, contact routing, and alert mute/escalation choices
are external account settings; do not add account IDs, API keys, webhook
secrets, or copied private diagnostics to this repository, release artifact,
server environment, or deployment workflow.

## Bounded human verification

After the Production route is deployed, the operator records only the monitor
names, URLs, interval, and observed HTTP outcome in the deployment handoff.
Do not export monitor credentials, response captures, or private UptimeRobot
diagnostics. The external check is a human setup/verification step and is not
run by the application test suite or deployment workflow.
