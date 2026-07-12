# Production deployment and operational failure audit

Audit date: 12 July 2026

## Answer

The current deployment is a good process-availability baseline, but it is not yet safe for SQM game state. GitHub Actions builds and tests the exact compiled Bun executable, deploys through a narrow SSH path, switches a `current` symlink, checks localhost health, attempts rollback, and verifies the public page. Caddy terminates TLS, proxies only to loopback, supplies appropriate security headers, and hides the internal health endpoint.

Two deployment properties are nevertheless production blockers:

1. Every activation restarts a server whose complete game registry exists only in memory. A deploy, crash, host reboot, or rollback therefore loses every server-side game and command-id record. Rollback restores an executable, not game state. This violates the accepted server-outage recovery drill and makes deployment during an active Event unsafe.
2. A release directory is named only by Git commit SHA. Re-running or re-dispatching a deployment for the same commit uploads into that same directory with `rsync --delete`. If it is the current release, the workflow mutates the active rollback target before activation; an interrupted upload or failed activation cannot reliably return to the previous bytes.

The remaining gaps are production controls and evidence: production has no approval rule, live release identity is not observable, smoke coverage is too shallow, the systemd/Caddy installation can drift from source, secret rotation and artifact-audit procedures are undocumented, and neither rollback nor server-loss recovery has a recorded rehearsal.

## Evidence inspected

- `.github/workflows/deploy-production.yml`, `deploy/activate-release.sh`, `deploy/systemd/quadball-timer.service`, `package.json`, `src/index.ts`, and the internal-health implementation and tests.
- The production GitHub environment, Actions variables and secret names, and recent deployment runs. Secret values were not accessed.
- The source-of-truth Caddy route and documented server state in `infra-caddy`.
- The accepted SQM production acceptance and rehearsal plan.
- Read-only public checks against `https://timer.quadball.app` on 12 July 2026.

## What already matches `prepare-deployment`

| Area | Current evidence | Assessment |
| --- | --- | --- |
| Build and quality gate | A pinned workflow installs the package-manager version from `package.json`, runs `bun run check` and `bun run test`, and builds `bun-linux-x64-modern`. | Meets the baseline. The uploaded executable is the artifact that passed CI. |
| Workflow permissions and serialization | `contents: read`; production deploys share a non-cancelling concurrency group. | Meets the baseline and prevents overlapping activation jobs. |
| Artifact handoff | The deploy job downloads a seven-day Actions artifact containing only the executable and activation script. | Good minimal bundle shape. Add a manifest and an explicit secret/file audit. |
| SSH handling | Strict host-key checking uses a stored known-hosts value; host, user, and private key are Actions secrets. | Good baseline. The key is written only to an ephemeral runner, though an explicit always-run cleanup is still preferable. |
| Server shape | `/srv/quadball-timer/releases`, `current`, a dedicated runtime user, a separate deploy user, systemd, and `127.0.0.1:3000`. | Matches the recommended Bun service shape. |
| Activation | Validates names and port, checks AVX2 and executable presence, verifies systemd `ExecStart`, switches `current`, restarts, polls internal health and root HTML, and attempts rollback. | Sound process-level structure, subject to the state-loss and mutable-release blockers below. |
| systemd | Non-root user, loopback configuration, restart policy, empty capabilities, restricted address families, and multiple sandboxing directives. | Strong baseline. Source and installed unit still need a drift check; writable-state policy must be revisited when persistence lands. |
| Caddy | `timer.quadball.app` proxies to `127.0.0.1:3000`, blocks `/internal/*`, redacts sensitive log headers/query strings, and supplies CSP, HSTS, framing, permissions, referrer, and MIME-sniffing protections. | Meets the current routing/security baseline. |

## Required operational changes before SQM

### 1. Make releases immutable and identifiable

- Give every deployment attempt a unique release id, for example `<sha>-<run-id>-<run-attempt>`; never upload into an existing final release directory.
- Upload into a new staging directory, validate the complete bundle and hashes, and then rename it into the final release directory before activation.
- Include a release manifest with commit SHA, Actions run and attempt, Bun version, build timestamp, and executable digest.
- Expose that identity through localhost-only readiness/status output and record it in the deployment summary. The public `/internal/*` route must remain `404`.
- Remove SSH key material in an `if: always()` workflow step.

### 2. Separate production promotion from ordinary `main` pushes

- Keep CI on every push, but require an explicit production promotion of the accepted release candidate by 2 August. Use required reviewers on the GitHub `production` environment or an equivalent manual promotion gate if environment reviewers are unavailable.
- Preserve the non-cancelling production concurrency group.
- Record the exact approved commit, artifact digest, deployment run, and live release identity in the durable acceptance record.
- From feature freeze through SQM, do not deploy merely because documentation or unrelated code lands on `main`. No event-day deployment is planned; an exceptional event-day deploy or rollback remains the repository maintainer's onsite judgment.

### 3. Make restart and rollback state-safe

- The durable-state and recovery work must make a process restart, failed activation, executable rollback, and host reboot preserve or reconstruct every Event Game, accepted operation, idempotency key, and active grant required for recovery.
- Activation must refuse to restart production while an active Event Game would be lost, unless a deliberate maintenance/incident override is recorded.
- Health must not report ready until durable state is readable and its schema is compatible with the executable.
- Schema migration must have its own backup, compatibility, and rollback rule. A binary symlink rollback alone is not sufficient after a non-backward-compatible migration.

Until that work passes the accepted server-outage drill, the current deployment must be treated as unsafe during any live game.

### 4. Expand automated deployment verification

After activation, verify all of the following against the deployed release:

- localhost liveness/readiness and release identity;
- public root HTML;
- public read-only game API shape;
- a WebSocket handshake with production `Origin` and one non-mutating contract exchange;
- public rejection of `/internal/healthz`;
- expected security headers;
- service restart count and recent error logs.

The check must fail the deployment when the release identity does not equal the artifact being promoted. Do not create a production game as a smoke test.

### 5. Detect installation drift and bound the service

- Verify the installed unit against `deploy/systemd/quadball-timer.service`, including runtime user/group, `ExecStart`, working directory, loopback host/port, and hardening directives. The current activation check covers only `ExecStart`.
- Re-run `systemd-analyze security quadball-timer.service` and document intentional deviations. `ProtectSystem=strict` should be used only with an explicit systemd-managed writable state directory once the persistence design is known.
- Add justified memory/task/file-descriptor limits after measuring the production-like rehearsal load; alert on repeated restarts, resource exhaustion, and disk pressure rather than choosing arbitrary limits now.
- Validate and live-check Caddy through the separate `infra-caddy` workflow whenever its route changes.

### 6. Document secret and recovery operations

- Inventory the deploy key owner, authorized-key entry, narrow sudoers command, known-hosts source, rotation/revocation procedure, and emergency operator. Do not copy secret values into the runbook or acceptance evidence.
- Confirm the runtime user cannot read the deploy private key and the deploy user can run only the intended activation/restart path.
- Scan the release bundle for `.env`, private keys, tokens, raw data, generated grant URLs/codes, and other loose secrets before upload. Future grants and server-side secrets must live outside immutable release directories.
- Keep the accepted printed grant recovery sheet as a separate operational control; deployment evidence records only that it exists.

## Required live verification and rehearsal

These checks require the deployed server and, where noted, a deliberate outage. They should be captured in the acceptance record rather than inferred from source.

### Before the 26 July rehearsal baseline

- Verify `current` resolves to an immutable release whose manifest and executable digest match the selected Actions artifact.
- Inspect `systemctl cat`, `systemctl show`, service status, restart count, journal errors, runtime/deploy users, directory ownership, sudoers, AVX2 support, loopback listener, free disk space, and Caddy upstream configuration.
- Confirm the public root and API are available, the production-origin WebSocket connects, `/internal/healthz` is publicly `404`, and localhost readiness returns the expected release identity.
- Confirm one-minute external HTTP/API and functional-WebSocket monitoring, plus alerts for sustained failure, repeated restarts, low disk, and backup failure.
- Confirm a production-data backup can be restored into an isolated rehearsal deployment before destructive recovery testing.

### In the isolated 3–9 August rehearsal window

- Deploy the exact release-candidate artifact to the separate rehearsal deployment and database.
- Re-run the same artifact without overwriting the first release; prove both remain byte-identical and independently selectable.
- Force a bad-health activation and show automatic rollback restores the prior executable, compatible schema, and complete game state.
- Restart the service and reboot the rehearsal host during an active time-compressed Event Game; prove Controllers remain locally operable and the server reconstructs one trustworthy state on return.
- Exercise the accepted offline, concurrent-action, lost-phone, and server-unavailable drills, while monitoring and alerting are observed by the maintainer.
- Restore rehearsal data from backup and compare Event Games, operations, grants, and idempotency records with the pre-failure checkpoint.

### Before the 12 August go/no-go decision

- Promote the already-rehearsed artifact through the production approval gate; do not rebuild it.
- Match the live release identity and digest to the acceptance record.
- Run non-mutating public HTTP/API/WebSocket and internal readiness checks, verify monitoring is green, and inspect recent service/Caddy errors.
- Record both Production Acceptance Authority approvals. Any state-loss, convergence, grant, monitoring, or restoration failure remains a no-go defect.

## Current live snapshot

On 12 July 2026:

- the latest production workflow run for commit `92f49ace0a3f1b1084dd9ba4f325664bfe5e1580` completed successfully;
- the production environment had no protection rules;
- repository Actions variables matched `/srv/quadball-timer`, `quadball-timer`, and port `3000`, and the four expected deploy secret names existed;
- the public root returned `200` with the expected security headers;
- `/internal/healthz` returned public `404`;
- the read-only game API returned the expected JSON shape;
- a WebSocket opened when sent `Origin: https://timer.quadball.app`.

The app does not expose a live release identifier, so the successful workflow is evidence of deployment but cannot prove which commit bytes the running process currently serves. No SSH/systemd inspection or disruptive rollback/restart drill was performed during this read-only audit.

## Follow-up boundary

One focused implementation ticket can address immutable releases, promotion gating, release identity, expanded smoke checks, artifact cleanup, and installation-drift verification now. Durable persistence, migrations, backup/restore, monitoring, and the isolated rehearsal remain dependent on the authoritative operations/persistence architecture and the map's later production-readiness work.
