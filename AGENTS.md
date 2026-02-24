# AGENTS.md

## Project
- Name: `Quadball Timer`
- Stack: `bun` + `TypeScript` + `React` + `TailwindCSS` + `shadcn/ui`
- Quality tooling: `oxfmt` + `oxlint` + `oxlint-tsgolint`
- Package manager/runtime: `bun`
- Tests: `bun test` with colocated `*.test.ts` files
- VCS: `git`

## Goal
Provide clear, low-friction defaults so OpenAI Codex can make safe, high-quality changes quickly in this repo.

## Working Defaults For Codex
- Keep changes focused and minimal; avoid unrelated refactors.
- Prefer small, reviewable commits.
- Do not edit generated artifacts unless the task explicitly requires it.
- Every change must keep both tests and documentation up to date for the touched behavior/surfaces.
- Before handoff, always run `bun run check` and `bun run test` (and `bun run build` when frontend/module resolution may be affected).
- Fix bugs at root cause, not only symptoms. Identify the exact leak/failure path and add regression tests that cover both internal/state behavior and user-visible outcomes.

## Commands
- Install deps: `bun install`
- Dev server: `bun dev`
- Production run: `bun start`
- Build: `bun run build.ts`
- Run all tests: `bun run test`
- Run a single test file: `bun test path/to/file.test.ts`
- Format code: `bun run format`
- Check formatting only: `bun run format:check`
- Lint (type-aware + type-check): `bun run lint`
- Full quality gate: `bun run check`

## Command Usage
- Use `bun run format` before large reviews or commits to normalize formatting.
- Use `bun run format:check` in CI or pre-merge validation to ensure formatting is clean.
- Use `bun run lint` for strict type-aware and type-check linting with `oxlint`.
- Use `bun run check` as the default pre-merge command. It runs:
  1. `format:check`
  2. `lint`

## Test Conventions
- Place tests next to source files using `*.test.ts` naming.
- Add/update tests for behavioral changes and bug fixes.
- Prefer deterministic tests (no real network, no time flakiness).
- Keep tests fast; mock/stub expensive boundaries.
- Changes in websocket event parsing/contract (`/ws` flow) must include parser/contract tests for valid events and rejection of unsupported event types.
- Changes in `src/lib/game-engine.ts` must include/update direct rule tests (clock/penalty ticking, timeout behavior, score-triggered expiration, flag-catch behavior).
- Concurrency/offline-sync bug fixes must include a regression test that asserts the exact undesired behavior does not recur.
- Changes to controller persistence/recovery (`src/lib/controller-session.ts` and controller sync flow in `src/App.tsx`) must include tests for corrupted payload rejection and safe local recovery behavior.
- Changes to contextual controller interactions in `src/App.tsx` (for example clock-adjust open/close and helper-text swapping) must include `src/App.test.tsx` coverage for both activation and outside-tap dismissal.

## Code Style
- TypeScript first: prefer explicit, narrow types at public boundaries.
- React: functional components and hooks; keep components focused.
- Tailwind: use utility classes directly; extract repeated patterns only when helpful.
- shadcn/ui: prefer existing primitives/components before introducing new UI patterns.
- Keep comments concise and only where intent is not obvious from code.

## File/Structure Guidelines
- Respect existing aliases from `components.json`:
  - `@/components`
  - `@/components/ui`
  - `@/lib`
  - `@/hooks`
- Keep business logic out of presentation-only components when practical.
- Co-locate small helper utilities near usage; promote to shared `lib` only when reused.
- Keep non-UI orchestration logic in focused modules under `src/lib` (not inside large React components) so it can be tested directly.

## Controller UI Priorities
- Treat the controller view as phone-first: keep the main game screen usable without page scrolling.
- Keep game-time visibility and play/pause access persistent; these controls must not be obscured by secondary workflows.
- Use contextual reveal for low-frequency actions (for example clock correction or rename flows) instead of showing all controls at once.
- Prefer showing actionable/urgent information only; hide neutral status text when nothing requires attention.
- Keep high-frequency actions single-tap with clear, compact controls suitable for quick glances during live play.
- After controller layout changes, manually verify narrow-phone viewports (at least one ~360px width) to ensure no panel/control cutoff in any active bottom tab.

## Sync Guardrails
- For offline command queueing, include a client timestamp per command and replay in order when reconnecting.
- Keep idempotent command IDs on the server to avoid duplicate state application during reconnect/resend.
- Live timer UIs must render from projected state (`projectGameView`) against `now`, not only from last synced snapshot.
- Controller devices must remain operable even if the server loses a game ID: keep local state as authoritative, keep accepting local actions, and avoid forced session closure.
- When in local-only fallback mode, keep periodic background reconnect attempts so sync resumes automatically if the server recovers.

## Common Pitfalls
- Avoid `return` inside `finally` blocks (`no-unsafe-finally`); compute restart/cleanup decisions and apply them after `finally`.
- Avoid unnecessary escapes in template strings (e.g. `\"`) to keep lint clean.
- In strict TS tests, prefer explicit runtime guards and typed locals over nullable optional chaining on captured values.
- In `happy-dom` UI tests, avoid relying on `querySelector` for complex attribute selectors; prefer iterating elements and checking attributes directly. For pointer/outside-tap dismissal flows, prefer browser-level coverage (Playwright) when possible, because `happy-dom` event bubbling can be unreliable.
- `bun run build` is mandatory for frontend/module-path changes; do not rely on lint/tests alone for import-resolution safety.
- For any live timer/clock display, render from projected state against `now`, not only from last synced snapshot.

## Commit Message Style
- Use a concise imperative subject in sentence case (capitalize the first word, e.g. `Implement websocket command replay`).
- Do not use prefix tags like `feat:` or `fix:` unless explicitly requested.
- Keep the title behavior-focused (what changed for users/system), not file-focused.
- Before writing the commit message, check the staged diff (`git diff --cached --stat` and/or `git diff --cached`) and make sure the subject/body cover the full staged change scope, not only the most recent tweak discussed.
- In the subject, lead with the primary user-visible behavior change; avoid leading with qualities that are expected defaults in this app (for example `synced`) unless sync behavior itself is the main change.
- Do not describe the committed change relative to an uncommitted attempt (for example `instead of ...`); describe only what is actually in the staged diff/history.
- Optional body is recommended for larger changes: explain major areas touched and key rules/constraints added.
- Keep tone factual and avoid filler language.

## Git Workflow
- Before finishing, run relevant checks/tests for touched areas.
- Include a concise change summary and any follow-up risks in PR/hand-off notes.
- In this Codex sandbox setup, run `git add`/`git commit` with escalated permissions by default (to avoid recurring `.git/index.lock` permission failures), with a clear one-line justification.

## Safety Rules
- Never run destructive git/file commands unless explicitly requested.
- Never commit secrets or environment-specific credentials.
- If requirements are ambiguous, choose the safest minimal interpretation and document assumptions.

## Preferred Change Output
When completing a task, provide:
1. What changed (files + behavior)
2. Validation performed (tests/commands)
3. Any assumptions or remaining risks
