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
deploy-quadball-timer ALL=NOPASSWD: /bin/systemctl restart quadball-timer
```

The app itself binds to `127.0.0.1:3000`; public HTTPS and WebSocket traffic is
terminated by Caddy and proxied to that localhost backend.

## Quality checks

```bash
bun run check
bun run test
bun run build
bun run build:executable
```
