# Anonymous game creation can retain unbounded server state

## Executive Summary

Quadball Timer revision `caa5dac848e9e865524e44f30becae725048bcdc` lets any anonymous HTTP client create games through `POST /api/games`. Each successful request allocates a new `ManagedGame`, stores it in the process-global `games` map, and immediately recomputes and broadcasts lobby state. There is no authentication, rate limit, lifecycle expiry, game-count quota, or cleanup path in the reviewed implementation.

I reviewed the vulnerable revision directly and used the existing scan validation artifacts; I did not send traffic to any public or production service. The PoC shipped with this report is intentionally local-only and uses a small bounded request count by default.

The practical impact is resource exhaustion and lobby pollution. On its own, this is a Low/P3 finding because the request count needed for active-event denial was not measured, the official paper score sheet remains authoritative, and a restart clears the in-memory map. It is still security-relevant because the attack crosses from anonymous public input into shared service resources used by Controllers and spectators during live play.

## Background

The server keeps all game state in memory:

```ts
const games = new Map<string, ManagedGame>();
const sockets = new Set<ServerWebSocket<SessionData>>();
```

The public API exposes both lobby reads and game creation:

```ts
"/api/games": {
  GET() {
    const snapshots = [...games.values()]
      .map((game) => projectGameSummary(game.state, nowMs))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    return json({ games: snapshots });
  },
  POST(req: Request) {
    return createGame(req);
  },
},
```

The production threat model treats live availability as part of the protected event operation. That matters here because the lobby and controller service share the same Bun process and the same process-global `games` registry. A request that looks like ordinary game setup can therefore become an allocation primitive if the server does not impose an admission decision or lifecycle policy.

## Vulnerability Details

We reach the bug through a normal public route. `POST /api/games` calls `createGame(req)` without checking an authenticated principal, event role, pitch assignment, client quota, or global capacity.

Inside `createGame`, the body parser is permissive. Invalid JSON falls back to `{}`, missing names become `"Home"` and `"Away"`, and colors are optional. That means even the smallest anonymous request can pass:

```ts
return req
  .json()
  .catch(() => ({}))
  .then((body) => {
    const payload = isRecord(body) ? body : {};
    const homeName =
      typeof payload.homeName === "string" && payload.homeName.trim().length > 0
        ? payload.homeName
        : "Home";
```

From there we carry attacker-controlled or defaulted values into a fresh `ManagedGame`:

```ts
const id = createGameId();
const managedGame: ManagedGame = {
  state: createInitialGameState({
    id,
    nowMs,
    homeName,
    awayName,
    homeColor,
    awayColor,
  }),
  appliedCommandIds: new Set(),
  appliedCommandOrder: [],
};
```

The missing invariant is the admission decision before retention. The server should decide whether this actor may create another game, whether the event/pitch has capacity for it, and whether old games should expire. Instead it unconditionally retains the object:

```ts
games.set(id, managedGame);
broadcastLobbySnapshot();

return json({ gameId: id, game: projectGameView(managedGame.state, nowMs) }, 201);
```

After insertion, the cost is not limited to one map entry. `broadcastLobbySnapshot()` walks every socket subscribed to the lobby, and `sendLobbySnapshot()` rematerializes the full list from every retained game:

```ts
const summaries = [...games.values()]
  .map((game) => projectGameSummary(game.state, nowMs))
  .sort((a, b) => b.updatedAtMs - a.updatedAtMs);

sendMessage(ws, { type: "lobby-snapshot", games: summaries, serverNowMs: nowMs });
```

So the attacker's repeated small request stream grows process memory and increases CPU/serialization work for later reads and broadcasts. The vulnerability is not just that creation is public; it is that public creation is also unbounded and retained for the lifetime of the process.

## Exploitability Analysis

The strongest route is straightforward: we issue repeated `POST /api/games` requests to the public creation endpoint. Each accepted request receives a unique `game-*` identifier generated from `crypto.randomUUID()`, so we do not need to win races or predict identifiers. We also do not need a large body. An empty JSON object is enough to allocate the complete initial game state.

The useful primitive is persistent process allocation plus repeated lobby amplification. After `n` requests, a later lobby snapshot maps, sorts, serializes, and sends `n` summaries. If lobby clients are connected, each creation also triggers immediate fan-out. If no lobby clients are connected, the retained map still grows and later `GET /api/games` requests pay the traversal and serialization cost.

There are meaningful constraints:

- The state is in memory only. A restart clears the attacker-created games, although that also interrupts and loses legitimate live games.
- The scan did not establish the request count or rate needed to cause event-wide denial.
- Caddy or hosting-provider limits may reduce request throughput, but no repository-owned application limit was found.
- This path does not reach host permissions, secrets, deployment credentials, backups, or durable audit records.

Those constraints are why the finding is Low/P3 rather than a higher-severity denial-of-service claim. The security issue remains real because the current control surface lets anonymous internet clients consume shared event resources without an application-level budget.

## Proof of Concept

The included PoC is a local-only bounded probe. It creates a configurable number of games on a local test server and then reads the lobby count. It does not target production and should not be run against an event system.

Run it from the report directory after starting a local vulnerable server:

```sh
cd poc
bun run anonymous-game-creation-poc.ts
```

Representative output:

```text
[+] target: http://127.0.0.1:3000
[+] creating 25 games
[+] created 25 games
[+] lobby now reports at least 25 games
[+] local-only probe complete
```

The default count is intentionally small. Increase `COUNT` only in an isolated disposable environment:

```sh
COUNT=100 bun run anonymous-game-creation-poc.ts
```

## Remediation

Restore the invariant that game creation is an authorized, budgeted event operation. At minimum, the server should bind creation to a game-scoped or event-scoped capability, enforce global and per-actor creation limits, and expire or archive games through a deliberate lifecycle.

A minimal defensive shape is:

```ts
const MAX_ACTIVE_GAMES = 64;

function canCreateGame(req: Request) {
  const grant = parseCreateGameGrant(req.headers.get("authorization"));
  return grant.ok && grant.scope === "event:create-game";
}

function createGame(req: Request) {
  if (!canCreateGame(req)) {
    return json({ error: "Not authorized." }, 403);
  }

  if (games.size >= MAX_ACTIVE_GAMES) {
    return json({ error: "Active game limit reached." }, 429);
  }

  // Existing bounded body parsing and creation path.
}
```

That snippet is only the narrow gate. The production fix should also include:

- request body and team-name length limits before `createInitialGameState`;
- a lifecycle policy for completed, abandoned, or test games;
- a cheap lobby projection cache or pagination if lobbies can contain many games;
- rate limits at the edge and at the application boundary;
- regression tests that anonymous creation is rejected, quota exhaustion returns a non-201 status, and lobby snapshots remain bounded.

## Summary

Anonymous `POST /api/games` currently creates process-lifetime game state and triggers full lobby recomputation without authentication, quotas, or expiry. We can use this as a low-friction allocation and amplification path against the shared timer service. The current evidence supports a Low/P3 availability finding, with the main future research being controlled load measurement under expected event subscriber counts and the exact production proxy limits.
