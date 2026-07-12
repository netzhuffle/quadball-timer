# Unbounded team names are retained and repeatedly amplified

## Executive Summary

Quadball Timer revision `caa5dac848e9e865524e44f30becae725048bcdc` accepts `rename-teams` commands whose `homeName` and `awayName` fields are checked only for JavaScript string type. A controller WebSocket frame below the transport message ceiling can therefore store very large non-whitespace strings in shared `GameState`. Later game snapshots, lobby projections, HTTP reads, and WebSocket broadcasts repeatedly clone, serialize, and fan out those retained strings.

I reviewed the vulnerable revision directly, including the parser, engine, broadcast path, and scan validation evidence. I did not send oversized traffic to a public or production service. The included PoC is a bounded local script that targets only `127.0.0.1` by default.

This is a Medium/P2 availability finding. The current Bun transport bounds a single inbound message and per-connection backpressure at 16 MiB, and renames replace two fields rather than accumulating an unbounded list. Those facts narrow the finding. They do not provide a semantic application limit for team names or protect the service from repeated clone, serialization, and fan-out work on attacker-controlled retained values.

## Background

Controllers can rename teams during a game. The command enters as a WebSocket `apply-commands` frame, is parsed into a typed `GameCommand`, and is then applied to the process-global `ManagedGame`:

```ts
const ackedCommandIds = applyCommandsToGame({
  managedGame: game,
  commands: parsed.message.commands,
});
```

Snapshots are sent after commands and on later game reads. The server serializes the projected game state directly:

```ts
sendMessage(ws, {
  type: "game-snapshot",
  game: projectGameView(game.state, nowMs),
  serverNowMs: nowMs,
  ackedCommandIds,
});
```

In the scanned revision, controller authority is itself self-asserted by the client. Even after the planned capability design is implemented, however, the name fields remain untrusted input: a valid grant holder, a compromised controller browser, or an offline replay can still supply unreasonable values unless the server enforces domain bounds.

## Vulnerability Details

The root parser accepts `rename-teams` once both names are strings:

```ts
if (payload.type === "rename-teams") {
  if (typeof payload.homeName !== "string" || typeof payload.awayName !== "string") {
    return {
      ok: false,
      error: "rename-teams requires homeName and awayName.",
    };
  }
```

It validates optional color strings, but it does not check the length, normalized length, display length, or byte budget of either name:

```ts
return {
  ok: true,
  command: {
    type: "rename-teams",
    homeName: payload.homeName,
    awayName: payload.awayName,
    homeColor,
    awayColor,
  },
};
```

We then carry those strings into the engine. The engine trims and stores them:

```ts
case "rename-teams":
  return {
    ...state,
    homeName: command.homeName.trim(),
    awayName: command.awayName.trim(),
    homeColor: command.homeColor,
    awayColor: command.awayColor,
    updatedAtMs: nowMs,
  };
```

`trim()` is not a size control. If the attacker supplies one million `A` characters, trimming preserves one million `A` characters. The retained state then reaches every later projection path. Game snapshots include the full game view; lobby snapshots include summaries for all games; and WebSocket fan-out serializes the retained state once per subscriber.

The missed invariant is simple: human-facing names should have a small, explicit application maximum before storage or broadcast. The transport's eventual frame ceiling is too high to be a domain invariant, and it protects only the inbound frame, not repeated outbound work.

## Exploitability Analysis

The strongest route is a single valid `rename-teams` command containing a large non-whitespace `homeName` or `awayName`. In the current baseline, an anonymous client can first subscribe to a public game while declaring `role: "controller"`, then submit the command. After that, the value is no longer transient parser memory. It becomes shared game state.

The retained value creates several useful pressure points:

- Every later snapshot for the affected game carries the large name.
- Every subscriber to that game gets a serialized copy.
- Lobby reads and lobby broadcasts traverse retained games and include the large names in summary projections.
- The attacker can repeat the rename after cleanup or restart.

The scan validated one concrete lower-bound: a 1,000,000-character `homeName` in a 1,000,149-byte protocol frame was accepted by the target-revision parser and preserved in the parsed command. The exact whole-message ceiling observed for Bun 1.3.13 is 16,777,216 bytes, but the finding does not need a near-limit payload. The important point is that the application accepts values many orders of magnitude larger than a legitimate team name and retains them for repeated work.

There are constraints. The current implementation stores only two names per game, so repeated renames replace rather than append. Per-socket output backpressure is bounded. A legitimate rename can replace the large strings. The scan did not prove reliable all-event denial under production subscriber counts. These constraints keep the finding at Medium/P2, while public reachability and cross-user amplification keep it reportable.

## Proof of Concept

The PoC is local-only and bounded. It assumes a disposable vulnerable server is running on `127.0.0.1:3000`. It creates one game, subscribes as controller, sends a `rename-teams` command with a configurable string length, and verifies that the returned snapshot contains the retained length.

Run it from the report directory:

```sh
cd poc
bun run unbounded-team-names-poc.ts
```

Representative output:

```text
[+] target: http://127.0.0.1:3000
[+] creating local game
[+] connecting websocket
[+] sending rename-teams with 100000 byte homeName
[+] snapshot retained homeName length 100000
[+] local-only probe complete
```

The default payload is far below the transport ceiling. Use an isolated test process before raising `NAME_LENGTH`:

```sh
NAME_LENGTH=1000000 bun run unbounded-team-names-poc.ts
```

## Remediation

Restore the invariant that team names are small, displayable domain values before they enter `GameCommand` or `GameState`. The server should reject names above a clear maximum after trimming, and tests should cover both parser rejection and engine-level safety.

A minimal parser-side shape is:

```ts
const MAX_TEAM_NAME_LENGTH = 80;

function parseTeamName(value: unknown) {
  if (typeof value !== "string") {
    return { ok: false as const, error: "Team name must be a string." };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TEAM_NAME_LENGTH) {
    return { ok: false as const, error: "Team name length is invalid." };
  }

  return { ok: true as const, value: trimmed };
}
```

The command parser should store the normalized value so the engine does not need to repeat trimming:

```ts
const homeName = parseTeamName(payload.homeName);
const awayName = parseTeamName(payload.awayName);
if (!homeName.ok || !awayName.ok) {
  return { ok: false, error: "rename-teams requires bounded team names." };
}

return {
  ok: true,
  command: {
    type: "rename-teams",
    homeName: homeName.value,
    awayName: awayName.value,
    homeColor,
    awayColor,
  },
};
```

Recommended regression tests:

- `parseClientWsMessage` rejects `rename-teams` names above the maximum;
- boundary-length names are accepted after trimming;
- HTTP game creation applies the same name bound;
- snapshots cannot contain names above the domain maximum;
- a command batch containing an oversized rename is rejected before any command in the batch mutates state.

The same budget should also apply to initial `POST /api/games` names, otherwise an attacker can bypass the WebSocket command path and seed oversized names at creation time.

## Summary

The vulnerable revision treats team names as arbitrary strings until they hit a broad transport ceiling. We can carry an oversized name through the WebSocket parser into shared state, then force repeated clone, serialization, and fan-out work whenever the game or lobby is projected. A small domain maximum, enforced before storage and shared by game creation and rename paths, closes the vulnerability and makes the wire contract testable.
