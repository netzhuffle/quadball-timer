# Quadball Timer

Quadball Timer is a mobile-first scorekeeper + timekeeper app for quadball tournaments.

## What it does

- Game clock with play/pause, manual adjustments, and seeker-release countdown (19:00 to 20:00).
- Score controls in 10-point increments (+10/-10) with undo.
- Card entry (blue, yellow, red, ejection) with per-player penalty tracking.
- Penalty clocks that pause with game pauses, highlight final 10 seconds, and support explicit score-triggered expiration confirmation.
- Timeout flow (one per team) that runs only while game time is paused, including 15-second reminder messaging.
- Flag catch handling after seeker release while paused (+30 and opposing penalty-expiration trigger).
- Live websocket synchronization for controllers and spectators.
- Offline-first controller behavior: local actions continue while disconnected and sync when the websocket reconnects.
- Home screen with create-game and live running/past game list (score + game time).

## Stack

- Bun
- TypeScript
- React
- TailwindCSS
- shadcn/ui

## Development

```bash
bun install
bun dev
```

## Deployment

Production deploys upload a compiled Linux executable and activate it under
`/srv/quadball-timer/current`. The deploy SSH user is expected to have only the
sudo access needed to restart the app service:

```sudoers
deploy-quadball-timer ALL=(root) NOPASSWD: /usr/bin/systemctl stop quadball-timer, /usr/bin/systemctl restart quadball-timer, /usr/local/sbin/quadball-timer-activation-maintenance
```

Install the root-owned maintenance wrapper once on the host:

```fish
sudo install -o root -g root -m 0755 deploy/activation-maintenance-root.sh /usr/local/sbin/quadball-timer-activation-maintenance
```

Technical Admin bootstrap is a separate human-only authority. Install the
fixed runner from the selected current release as root; do not add it to either
deployment user's sudoers entry:

```fish
sudo install -o root -g root -m 0755 /srv/quadball-timer/current/deploy/technical-admin-bootstrap-root.sh /usr/local/sbin/quadball-timer-technical-admin-bootstrap
sudo install -o root -g root -m 0755 /srv/quadball-timer-test/current/deploy/technical-admin-bootstrap-root.sh /usr/local/sbin/quadball-timer-technical-admin-bootstrap
```

The runner accepts only an Environment and `status`, `enroll`, or `reset`.
It maps the service, current release, service user, canonical origin, RP ID,
and Technical Admin database itself, stops and restarts only that Environment,
and prints an enrollment URL only after the service is confirmed active. Use it
from an interactive `sudo` terminal; it never requires Bun or a source checkout.
The root-installed activation-maintenance wrapper verifies the runner bytes
before activation updates this shared file. Updating the runner or that wrapper
requires the existing human root installation boundary; it does not broaden
deployment sudo authority.

For the bounded first-time or repair bootstrap of the Production/Test host
contract, use `docs/agents/issue-165-pre-merge-handoff.md`.

The app itself binds to `127.0.0.1:3000`; public HTTPS and WebSocket traffic is
terminated by Caddy and proxied to that localhost backend.

Production state is separate from immutable releases. The systemd unit owns the
private `/var/lib/quadball-timer` state directory. Technical Admin authority is
stored in `technical-admin.sqlite`, while Event administration foundation data
uses the separate `foundation.sqlite` file. Activation fails before switching a
release when the installed unit does not provide this state contract.

The permanent Test Environment is deployed independently at
`https://test.timer.quadball.app` by the Test job in
`.github/workflows/deploy-production.yml`. Every eligible merge to `main` builds
one immutable Release Bundle and performs Test Activation only. Production is
activated by the Production job in the same workflow after you approve the
`production` Environment. It uses the exact shared Test-validated bundle and
never rebuilds it. Follow `deploy/production-promotion.md` for the operator
steps.
Test uses
the separate `quadball-timer-test` service on `127.0.0.1:3001`, release root
`/srv/quadball-timer-test`, and state directory `/var/lib/quadball-timer-test`.
Its root-controlled key file is `/etc/quadball-timer/test.env`; Test keys must
never be copied from Production or committed to the repository. Test data is
persistent across ordinary restarts but explicitly expendable and has no
standing backup or availability guarantee. See
`deploy/test-environment-provisioning.md` for the one-time privileged setup.
The Test Environment Technical Admin verification checklist is in
`deploy/technical-admin-bootstrap-test-checklist.md`.

Pushes to `main` skip CI and Test Activation when every changed path is limited to
`AGENTS.md`, `CONTEXT.md`, `README.md`, `docs/`, or `.github/dependabot.yml`.
Files under `docs/` are also excluded from formatting, linting, and type-aware
validation. Manually dispatch the Test workflow to force CI/Test Activation; use
the separate Production promotion workflow for a reviewed Production Approval.

## Quality checks

```bash
bun run check
bun run test
bun run build
bun run build:executable
```
