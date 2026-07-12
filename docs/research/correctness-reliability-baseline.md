# Correctness and reliability baseline

Baseline captured 12 July 2026 for the current pre-SQM implementation.

## Executive result

The existing deterministic game-engine suite is healthy and the controller fits the target narrow phone without page scrolling, but the current server and recovery model are not production-safe. The most urgent regression work is not broad UI polishing: it is proving state durability, permanent command idempotency, strict recovery parsing, bounded protocol inputs, and accessible primary controls.

## Environment and passing evidence

- Bun resolved to the repository-pinned `1.3.13` after `bun install`.
- `bun run test`: 75 passed, 0 failed.
- `bun run build`: passed.
- `bun run format:check`, `bun run lint`, and `bun run lint:shell`: passed.
- Browser: Codex in-app Chromium browser against `http://127.0.0.1:3000/`.
- Mobile viewport: 360 x 800 CSS pixels.
- Rendered flow: home -> create game -> Cards -> Timeout -> Game end.
- Page identity, meaningful render, framework-overlay, and interaction checks passed after dependencies were installed. The only browser warning was the development hot-reload socket reconnecting when the local server was deliberately restarted.
- Cards, Timeout, and Game end each stayed within a 360 x 800 document with no horizontal overflow and no page scroll. Game time, play/pause, and bottom navigation remained visible.

The first run before dependency installation correctly failed to resolve React. A stale development process continued showing that build overlay after installation until restart; this is development-tool state, not an application regression.

## Reproducible failures and required regression tests

### P0: a process restart deletes every game

`src/index.ts` stores all games, applied command IDs, and subscriptions only in process-local `Map` and `Set` instances. Create a game, stop the process, restart it, and request its API URL: the game is gone. A controller's local copy can remain operable, but the server has no authoritative recovery record and spectators or other Controllers cannot recover the game.

Required regression: create and mutate an Event Game, restart the service against the same durable store, and assert that the projected game, command history needed for idempotency, and subsequent Controller synchronization survive exactly. Also test recovery from an interrupted write and an unavailable/corrupt store.

### P0: command IDs become non-idempotent after 5,000 later commands

`src/index.ts` deletes the oldest ID from `appliedCommandIds` when `appliedCommandOrder` exceeds 5,000. Replaying that old envelope then applies its sporting effect a second time. A delayed offline Controller or restored browser session can therefore duplicate a previously accepted goal or correction.

Required regression: accept a scoring envelope, accept 5,000 distinct later envelopes, resend the original envelope, and assert that score and audit history remain unchanged while the original ID is acknowledged. The durable model must define retention by the Game's lifecycle rather than a count that silently expires correctness.

### P0: persisted Controller state is only shallowly validated

`parsePersistedControllerSession` checks the top-level object, matching IDs, envelope shape, counter, and timestamp, then casts the entire nested state to `GameState`. It does not validate scores, clocks, penalties, timeout state, game status, history entries, or the command discriminated union inside pending envelopes. Structurally corrupt JSON can therefore be accepted as authoritative local state and reach rendering or command application.

Required regressions: table-driven corruptions for every nested `GameState` branch and every pending command type must return `null` and recover safely. Include missing arrays, wrong scalar types, non-finite/out-of-range numeric values, unknown enum values, and a superficially shaped command with an unsupported type.

### P0: WebSocket and game-creation inputs are unbounded

The server accepts an unlimited `commands` array and does not bound WebSocket message bytes, command ID length, client timestamps, team-name length at game creation, total number of games, or retained game history. A single client can force large synchronous parse/apply/broadcast work; repeated game creation grows process memory without a lifecycle limit. Several numeric command fields accept any JSON number without domain bounds.

Required regressions: reject oversized frames before JSON processing; reject batches, IDs, names, and histories beyond documented limits; reject unsafe timestamps and numeric ranges; prove that a rejected batch is atomic and does not partially mutate a game; and load-test the accepted maximum with multiple subscribers.

### P1: concurrent command order follows socket arrival, not the chosen convergence model

The server applies each incoming batch immediately in connection arrival order. `clientSentAtMs` is passed to the engine as event time, but envelopes are not causally ordered and no stable tie-breaker exists across concurrent Controllers. Two replicas receiving the same operations in different arrival orders can produce different results for order-sensitive commands such as score/undo, pause/resume, or game-end actions.

Required regression: feed the same causally related and concurrent envelope set in every relevant arrival permutation and assert one identical state and audit order. Cover equal occurrence times and clock-skew boundaries.

### P1: the primary score adjustment buttons have no accessible names

The browser accessibility snapshot exposes four score adjustment controls as unnamed `button` elements. A screen-reader user cannot distinguish team, direction, or effect. Several frequent controls are also below a 44 x 44 CSS-pixel touch target: score adjustment buttons are 70 x 32, card-type buttons 152 x 28, timeout buttons 308 x 36, and Game end actions 32 pixels high.

Required regressions: accessible-name assertions for every icon-only control, including team and action; keyboard focus/activation coverage; and a rendered target-size audit for frequent controls at the 360-pixel viewport. The intended target-size standard should be recorded before enforcing exceptions.

### P1: browser compatibility is unproven outside one Chromium path

The repository has component tests in happy-dom but no browser-level suite or CI browser matrix. The current Chromium mobile smoke passed, but iOS Safari—the highest-risk event device—Firefox, reload during an offline queue, background/foreground clock behavior, and storage eviction are untested.

Required regressions: a small browser-level SQM critical-path suite in Chromium, WebKit, and Firefox; include create/join, live clock projection, multi-Controller update, offline queue/reconnect, reload recovery, all bottom tabs at 360 pixels, and background/foreground resume. Run the WebKit path on a real iPhone during rehearsal because desktop emulation does not establish device behavior.

### P1: operational observability and resource behavior lack assertions

The health endpoint proves only that the process answers. It does not report release identity, durable-store readiness, writeability, recovery status, connection pressure, command rejection counts, or broadcast failures. There are no stated service limits or performance budgets.

Required checks: readiness must fail when authoritative writes cannot be made; expose release identity; measure p95 command-to-projection latency and reconnect recovery at the expected SQM concurrency plus headroom; assert bounded memory across game creation/history growth; and exercise graceful restart with connected Controllers.

## Coverage that is already credible

- Direct engine behavior has deterministic coverage for clocks, penalties, timeouts, score-triggered expiration, suspension, forfeits, overtime entry, target-score completion, and flag-catch validity.
- WebSocket parsing covers supported events and rejects unknown event and command types.
- Controller persistence rejects invalid JSON, game-ID mismatch, and malformed top-level envelopes.
- WebSocket origin checks and loopback-only health access have direct tests.
- The 360 x 800 controller layout keeps the clock and play/pause visible and keeps Cards, Timeout, and Game end reachable without page scrolling.

These positives should be retained while the new regression layers are added; they are not substitutes for persistence, concurrency, real-browser, and operational tests.

## Recommended gate before feature implementation proceeds

1. Add failing regression tests for restart durability, permanent lifecycle idempotency, strict persisted-state validation, bounded/atomic protocol input, and deterministic concurrent ordering.
2. Add browser-level assertions for accessible names and the SQM critical path at 360 pixels.
3. Define accepted protocol/resource limits and the production latency/recovery budgets, then make them observable.
4. Keep the existing repository gates mandatory and add the browser suite to the pre-rehearsal acceptance gate.

No glossary change was needed: this investigation used the existing Event Game, Controller, Control Audit Trail, Game Timeline, and Official Score Sheet meanings.
