# AGENTS.md

## Project

Quadball Timer is a phone-first live game timer built with Bun, TypeScript, React, Tailwind CSS, and shadcn/ui. Use Bun for package management and script execution; prefer TypeScript for new code.

## Commands

- Install dependencies: `bun install`
- Start development: `bun dev`
- Run the production server locally: `bun start`
- Run all tests: `bun run test`
- Run tests affected by local changes: `bun run test:changed`
- Run one test file: `bun test path/to/file.test.ts`
- Format: `bun run format`
- Run the full quality gate: `bun run check`
- Build the frontend/server bundle: `bun run build`
- Build the Linux production executable: `bun run build:executable`

Before handoff, always run `bun run check` and `bun run test`. Also run `bun run build` after frontend or module-resolution changes.

## Implementation conventions

- Keep changes focused. Update tests and documentation for touched behavior.
- Prefer explicit, narrow types at public boundaries and functional React components with hooks.
- Use existing shadcn/ui primitives and Tailwind utilities before adding new UI patterns.
- Keep business logic and orchestration in focused modules under `src/lib`; keep presentation components focused.
- Co-locate tests with source files as `*.test.ts`. Tests must be deterministic and avoid real network calls and timing flakiness.
- Treat roughly 700 lines as a soft file-size limit. Split by cohesive responsibility when a file grows beyond it.
- Use the aliases defined in `components.json`: `@/components`, `@/components/ui`, `@/lib`, and `@/hooks`.
- The Bun version in `packageManager` and the `@types/bun` version must match exactly. Update both and `bun.lock` together.
- Production deploys the compiled `bun-linux-x64-modern` executable as `current/quadball-timer`; do not add a server-side Bun runtime dependency without a documented reason.

## Behavioral guardrails

- Render live clocks from `projectGameView` against the current time, not only from the last synchronized snapshot.
- Offline commands require client timestamps and ordered replay. Server command IDs must remain idempotent across reconnects and resends.
- If the server loses a game ID, a controller must keep its local state authoritative, remain operable, and retry synchronization in the background.
- Keep the phone controller usable without page scrolling. Game time and play/pause must remain visible, frequent actions must stay single-tap, and low-frequency actions should use contextual reveal.
- After controller layout changes, manually verify every active bottom tab at a viewport around 360 px wide.

## Required regression coverage

- WebSocket contract changes: valid event parsing and rejection of unsupported event types.
- `src/lib/game-engine.ts`: direct rules for clocks, penalties, timeouts, score-triggered expiration, and flag catches.
- Offline or concurrency fixes: assert that the exact failure cannot recur.
- Controller persistence or recovery: reject corrupt payloads and recover safely from local state.
- Contextual controller interactions: cover activation and dismissal in `src/App.test.tsx`. Prefer browser-level coverage for pointer or outside-tap behavior when `happy-dom` is unreliable.

## Known pitfalls

- Do not return from `finally` blocks.
- In strict tests, use runtime guards and typed locals rather than optional chaining on nullable captured values.
- In `happy-dom`, find complex attribute combinations by iterating elements and checking attributes rather than relying on complex `querySelector` selectors.

## Git

- Keep commits small and reviewable. Never edit generated artifacts or use destructive Git commands unless the task explicitly requires it.
- Commit subjects use imperative sentence case without `feat:` or `fix:` prefixes. Lead with the primary behavior change.
- Before committing, inspect the complete staged diff and ensure the message covers its full scope.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues, and external contributor pull requests are a triage request surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses a single-context layout. See `docs/agents/domain.md`.
