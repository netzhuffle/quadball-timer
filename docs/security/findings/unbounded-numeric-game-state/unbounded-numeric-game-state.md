# Unbounded Numeric Game State Corruption

## Executive Summary

Quadball Timer revision `caa5dac848e9e865524e44f30becae725048bcdc`
accepts controller command numbers at the WebSocket boundary with JavaScript
type checks only. An attacker who can send controller commands can supply
standards-compliant finite JSON numbers that pass parsing, overflow during
clock arithmetic, and leave the authoritative in-memory game state with a
non-finite numeric value. When the server then broadcasts a snapshot,
`JSON.stringify` converts that non-finite property to `null`, breaking the
wire contract for live controller and spectator clients.

I reviewed the vulnerable revision directly and built a local semantic PoC for
the parser-to-arithmetic-to-serialization path. I did not send traffic to a
public service, and I did not measure browser UI recovery after receiving the
malformed snapshot. The evidence supports a Medium/P2 live-game integrity and
availability issue: the affected state is in-memory and game-scoped today, but
the corruption crosses from untrusted WebSocket input into shared server state
and public/controller projections.

## Background

The timer server accepts WebSocket messages from clients, parses a small
protocol, and applies accepted commands to a `ManagedGame`. The command envelope
contains a client timestamp and a game command. Normal controller operations can
start or stop the clock, adjust the game clock, set the clock, update score, and
add penalty cards.

The current protocol parser establishes shape and primitive type, but it does
not establish the numeric invariant the rest of the system needs: every accepted
number should be finite and inside the domain of the field it represents. We
first reach that trust boundary in `src/lib/ws-protocol.ts`:

```ts
if (
  !isRecord(entry) ||
  typeof entry.id !== "string" ||
  entry.id.length === 0 ||
  typeof entry.clientSentAtMs !== "number" ||
  !isRecord(entry.command)
) {
  return {
    ok: false,
    error: "Invalid command envelope.",
  };
}
```

That code accepts any JavaScript value with type `number`. Bare `NaN` and
`Infinity` are not valid JSON tokens, but JSON can carry very large finite
IEEE-754 values such as `1e308`. We can therefore start with valid JSON and
still reach non-finite engine state after arithmetic.

The server-side command gate is separate from numeric validation. In
`src/index.ts`, the socket must have a game subscription and the stored role must
be `controller`, but the stored role originates in the earlier subscription
message. Once that gate passes, the parsed envelopes are supplied directly to
the engine:

```ts
const ackedCommandIds = applyCommandsToGame({
  managedGame: game,
  commands: parsed.message.commands,
});
```

In the current baseline, the missing controller capability check makes this
publicly reachable for an anonymous client. Even after the planned controller
grant design exists, however, the numeric invariant still has to hold because a
grant holder, replayed offline operation, or modified local client remains
untrusted at the operation-validation boundary.

## Vulnerability Details

The vulnerable parser branch for clock changes is concise. We control
`deltaMs`, and the parser only asks whether the value is a number:

```ts
if (payload.type === "adjust-game-clock") {
  if (typeof payload.deltaMs !== "number") {
    return {
      ok: false,
      error: "adjust-game-clock requires deltaMs number.",
    };
  }

  return {
    ok: true,
    command: {
      type: "adjust-game-clock",
      deltaMs: payload.deltaMs,
    },
  };
}
```

The same pattern appears for `set-game-clock`, `change-score`,
`add-card.playerNumber`, and `add-card.startedGameClockMs`. Some downstream
fields have partial domain checks, such as score deltas being non-zero multiples
of ten or player numbers being bounded later in the engine. Those checks do not
restore a general numeric invariant, and they do not protect the clock path.

If we carry the accepted `deltaMs` into `src/lib/game-engine.ts`, the engine
adds it to the current game clock and clamps only the lower bound:

```ts
case "adjust-game-clock": {
  next.gameClockMs = Math.max(0, next.gameClockMs + command.deltaMs);
  return next;
}

case "set-game-clock": {
  next.gameClockMs = Math.max(0, command.gameClockMs);
  return next;
}
```

`Math.max(0, value)` is useful against negative values, but it is not a
finite-number check. With `next.gameClockMs` already near `1e308`, another
accepted positive finite adjustment can make `next.gameClockMs +
command.deltaMs` evaluate to `Infinity`. `Math.max(0, Infinity)` returns
`Infinity`, so the engine stores a non-finite value in authoritative game state.

From there the value is projected and broadcast. `projectGameView` carries the
advanced state into the server message, and `sendMessage` serializes the whole
payload:

```ts
function sendMessage(ws: ServerWebSocket<SessionData>, payload: ServerWsMessage) {
  ws.send(JSON.stringify(payload));
}
```

JavaScript JSON serialization converts non-finite numeric property values to
`null`. That means the server does not merely hold an unrealistic clock; it
broadcasts a `game.state.gameClockMs` field whose wire value is no longer a
number. We have crossed from a permissive input parser into shared game state
and then into a protocol-level type violation visible to other clients.

A concrete state transition looks like this:

| Step | Input or state | Result |
| --- | --- | --- |
| 1 | `set-game-clock` with `gameClockMs: 1e308` | Parser accepts a finite JSON number; state stores `1e308`. |
| 2 | `adjust-game-clock` with `deltaMs: 1e308` | Parser accepts a second finite JSON number. |
| 3 | Engine computes `1e308 + 1e308` | JavaScript result is `Infinity`. |
| 4 | Engine stores `Math.max(0, Infinity)` | Authoritative `gameClockMs` becomes `Infinity`. |
| 5 | Server broadcasts snapshot | JSON wire value becomes `"gameClockMs": null`. |

This is the critical invariant break. The application type says
`gameClockMs` is a number, the parser accepts only a number, but the server can
publish a non-number because it never checked whether accepted numbers remain
finite and domain-valid through arithmetic.

## Exploitability Analysis

The strongest route is the clock path because it requires no special game
history and no complex side condition. We first set the clock to an enormous but
valid finite value, then we apply another finite positive delta. The arithmetic
overflow is deterministic in JavaScript, and the lower-bound clamp preserves
positive infinity.

This route gives us a useful operational primitive rather than code execution.
We can corrupt one selected game's live state, cause snapshots to violate their
documented numeric shape, and potentially force the controller crew to recreate
or manually repair the game. The damage is visible to subscribers and public
lobby readers for that game, but the current implementation keeps games in a
process-local map, so a server restart clears the entire in-memory set. The
signed paper score sheet also remains authoritative for final match records.
Those facts keep the standalone numeric issue below a host- or event-wide
compromise.

There are related but weaker numeric routes:

- `set-game-clock` alone can store unrealistic finite values, which can make
  release/countdown logic nonsensical even before non-finite overflow.
- `clientSentAtMs` is also type-only and feeds `advanceGameState`; extreme
  timestamp values can influence elapsed-time calculations, although the
  simplest deterministic wire-type break uses explicit clock commands.
- `change-score` accepts large numeric multiples of ten and can create
  unrealistic scores, but the score path does not need non-finite conversion to
  prove live integrity loss.
- `add-card.startedGameClockMs` can preserve unrealistic penalty timing
  metadata. Player numbers receive a later `0..99` engine check, so that field
  is a useful example of partial hardening rather than the best exploit path.

Origin and loopback binding do not close this issue. They restrict where the
application is served from and how the Bun process is exposed, but they do not
prove a user is authorized to mutate the selected game. The current missing
controller authorization finding increases practical reachability. Future
authorization will reduce the attacker set, but it will not make unbounded
numbers safe: the server must reject malformed operations before they affect
state, persistence, audit records, or projections.

## Proof of Concept

The included PoC is a local, non-network semantic probe. It models the
vulnerable parser checks, the engine clock arithmetic, and JSON serialization
behavior using the same values that an accepted WebSocket command can carry. It
does not contact a live service and does not modify a repository checkout.

From this report directory:

```sh
cd poc
bun run numeric-state-corruption-poc.ts
```

Representative output:

```text
[+] first command accepted: set-game-clock 1e+308
[+] second command accepted: adjust-game-clock 1e+308
[+] stored gameClockMs: Infinity
[+] finite after arithmetic: false
[+] serialized snapshot: {"type":"game-snapshot","game":{"state":{"gameClockMs":null}}}
[+] wire gameClockMs after JSON parse: null
[+] vulnerable invariant reached: finite JSON inputs produced a null numeric wire field
```

The PoC intentionally uses two finite JSON numbers. That matters because a
defense that only notes that `NaN` and `Infinity` are not valid JSON misses the
actual path: accepted finite operands can still produce non-finite authoritative
state.

## Remediation

The invariant to restore is straightforward: every number accepted at the
WebSocket boundary must be finite and must fit the domain of the specific field
before arithmetic, persistence, replay, projection, or broadcast. For clock
fields, that means rejecting non-finite values, rejecting values outside a
realistic match-clock range, and rejecting arithmetic that would overflow or
produce an out-of-domain result.

A minimal parser-side helper could look like this:

```ts
const MAX_GAME_CLOCK_MS = 120 * 60_000;
const MAX_CLOCK_ADJUSTMENT_MS = 10 * 60_000;

function isFiniteNumberInRange(
  value: unknown,
  { min, max }: { min: number; max: number },
): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
```

The `adjust-game-clock` branch should then use a signed adjustment bound, and
the engine should still defend the final arithmetic result:

```ts
if (
  !isFiniteNumberInRange(payload.deltaMs, {
    min: -MAX_CLOCK_ADJUSTMENT_MS,
    max: MAX_CLOCK_ADJUSTMENT_MS,
  })
) {
  return {
    ok: false,
    error: "adjust-game-clock requires a finite delta within the allowed range.",
  };
}
```

Do the same by field, not with one generic maximum:

- `clientSentAtMs`: finite timestamp in an acceptable skew window, or mapped to
  a server receive time before command application.
- `gameClockMs`: finite clock value in the supported match/overtime range.
- `delta`: finite score delta with both divisibility and realistic magnitude
  bounds.
- `startedGameClockMs`: finite clock value or omitted.
- player-facing numbers: integer-only where the domain is integral.

The engine should also assert its output invariants before returning a mutated
state. Parser checks are the first line of defense; engine invariants prevent a
future internal call site or replay path from reintroducing malformed state.

Regression coverage should exercise the real vulnerable path:

- `parseClientWsMessage` rejects extreme finite clock values and out-of-window
  timestamps.
- Applying two accepted-looking large clock operations cannot produce
  non-finite `gameClockMs`.
- `JSON.stringify` of a projected snapshot keeps all numeric fields as numbers
  for accepted commands.
- Nearby score, card, timeout, and penalty fields reject non-finite,
  fractional-where-integer, and out-of-domain values.

## Summary

The vulnerability is present because the WebSocket parser treats JavaScript's
`number` type as if it were a complete validation rule. We can start from valid
JSON, pass the parser, overflow during clock arithmetic, and make the server
publish `null` for a field that the protocol and application types expect to be
numeric. In the current production-shaped baseline, the missing controller grant
makes the path anonymous and remote; with the planned grant model, the same
numeric checks remain necessary for malicious controllers, modified clients,
offline replay, and durable operation ingestion.

Future variant review should cover every numeric field that crosses the command
boundary, plus any recovery/import path that replays locally stored operations.
The important structural fix is not just `Number.isFinite` in one branch; it is
a single, testable rule that no accepted operation can create non-finite or
out-of-domain game state before that state is stored, replayed, audited, or
broadcast.
