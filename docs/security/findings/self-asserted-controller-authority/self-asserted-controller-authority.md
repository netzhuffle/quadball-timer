# Anonymous Clients Can Self-Assert Controller Authority

## Executive Summary

Quadball Timer revision `caa5dac848e9e865524e44f30becae725048bcdc`
accepts a WebSocket `subscribe-game` message where the client chooses both the
game ID and `role: "controller"`. The server stores that client-selected role
in socket session state and later uses the same value as the authorization
check for `apply-commands`. Because no server-issued game-scoped capability,
grant, authenticated principal, or controller session is validated, an
anonymous same-origin user can become the controller for any known game and
mutate the shared live game state.

I reviewed the vulnerable revision directly, the scan validation and
attack-path artifacts, and the relevant source files; I did not exercise this
against public production. The accompanying PoC is designed only for a local or
lab instance. The final record risk is bounded by the official paper score
sheet, but the application-level impact is still high: we can change clocks,
scores, penalties, timeouts, suspensions, forfeits, flag-catch outcomes, team
metadata, and results in the live server state that other users see.

## Background

The production architecture intentionally exposes the application over HTTPS
and WebSockets. The Bun server listens on a local address, while the public
reverse proxy forwards browser traffic to it. Inside the app, game state is
held in memory and distributed to connected clients through snapshots.

The WebSocket route has one edge-level guard: the browser `Origin` and `Host`
must match either the production origin or a local development origin.

```ts
// src/index.ts, /ws route
if (!isAllowedWebSocketOrigin(req.headers.get("origin"), req.headers.get("host"))) {
  return json({ error: "WebSocket origin not allowed." }, 403);
}

const upgraded = routeServer.upgrade(req, {
  data: {
    id: crypto.randomUUID(),
    subscription: { type: "none" },
  },
});
```

That protects against simple cross-site WebSocket abuse, but it is not an
identity system. Once we are in the first-party application context, the socket
starts with only a random connection ID and an empty subscription. There is no
user account, cookie-backed session, grant table, or per-game controller token
attached to the connection.

The shared state object is explicitly privileged. When the server accepts a
controller command, it calls the game engine and then broadcasts the new state
to every subscribed game and lobby client.

```ts
// src/index.ts, applyCommandsToGame and broadcast path
managedGame.state = applyGameCommand({
  state: managedGame.state,
  command: envelope.command,
  nowMs: envelope.clientSentAtMs,
});

managedGame.appliedCommandIds.add(envelope.id);
managedGame.appliedCommandOrder.push(envelope.id);
```

The security invariant should therefore be simple: a client may receive public
or spectator state, but only a server-authorized controller for that specific
game may send mutation commands.

## Vulnerability Details

The vulnerable path starts in the message parser. A client asks to subscribe to
a game and supplies a `role`. The parser validates that the role is one of two
known strings, then returns the value unchanged.

```ts
// src/lib/ws-protocol.ts, parseClientWsMessage
if (payload.type === "subscribe-game") {
  if (typeof payload.gameId !== "string" || payload.gameId.length === 0) {
    return { ok: false, error: "subscribe-game requires a non-empty gameId." };
  }

  if (payload.role !== "controller" && payload.role !== "spectator") {
    return { ok: false, error: "subscribe-game requires role controller or spectator." };
  }

  return {
    ok: true,
    message: {
      type: "subscribe-game",
      gameId: payload.gameId,
      role: payload.role,
    },
  };
}
```

This is a good shape check, but it is not an authorization check. We fully
control `payload.gameId`, and we fully control `payload.role`. If we send
`role: "controller"`, the parsed message carries that exact value forward.

The server then stores the parsed message directly on the WebSocket session.
The only game-specific check at this point is existence: the target game ID
must be present in the server's `games` map.

```ts
// src/index.ts, subscribe-game handler
const game = games.get(parsed.message.gameId);
if (game === undefined) {
  sendMessage(ws, { type: "error", message: "Game not found." });
  return;
}

ws.data.subscription = {
  type: "game",
  gameId: parsed.message.gameId,
  role: parsed.message.role,
};
```

From here the bad state is concrete: the server session now contains
`subscription.role === "controller"`, but that value came only from the client.
No server-side fact says that this connection received authority for the game.

The same session state is later treated as the controller authorization gate
for `apply-commands`.

```ts
// src/index.ts, apply-commands handler
if (ws.data.subscription.role !== "controller") {
  sendMessage(ws, {
    type: "error",
    message: "Spectators cannot apply commands.",
  });
  return;
}

if (ws.data.subscription.gameId !== parsed.message.gameId) {
  sendMessage(ws, { type: "error", message: "Command gameId mismatch." });
  return;
}
```

These checks establish protocol consistency, not authority. We first choose
the subscription game ID and role, then we send a command for the same game ID.
The comparison proves only that the second attacker-controlled frame agrees
with the first attacker-controlled frame. Once that comparison passes, the
server applies the commands to shared state and broadcasts the update.

The command surface is broad. `GameCommand` includes score changes, clock
changes, cards and penalties, timeout state, flag catches, concessions,
forfeits, suspension/resume actions, and team metadata changes. We do not need
to corrupt memory or win a race; a valid JSON protocol sequence is enough.

## Exploitability Analysis

The strongest exploitation route uses the product exactly as deployed. We
first learn a game ID from the public lobby or from an event URL. Then we open
the first-party WebSocket route and subscribe to the target game as a
controller:

```json
{
  "type": "subscribe-game",
  "gameId": "game-12345678",
  "role": "controller"
}
```

After that, we can send a normal controller command:

```json
{
  "type": "apply-commands",
  "gameId": "game-12345678",
  "commands": [
    {
      "id": "attacker-command-1",
      "clientSentAtMs": 1783821600000,
      "command": {
        "type": "change-score",
        "team": "home",
        "delta": 10,
        "reason": "manual"
      }
    }
  ]
}
```

The route is reliable because all required values are deterministic and under
our control. The server does reject spectators, unsubscribed sockets,
mismatched game IDs, unknown games, malformed messages, and unsupported command
types. Those are useful protocol defenses, but they do not add a credential or
capability requirement. We can satisfy every check with ordinary first-party
traffic.

There are several ways to use the primitive. A low-noise attacker can make a
small score or clock adjustment that looks like an operator mistake. A more
disruptive attacker can pause or resume the clock, suspend a game, record a
forfeit, or alter team names and colors so every connected display receives a
bad snapshot. Because the server broadcasts accepted state, the impact is not
limited to the attacker's screen; other controllers, spectators, and lobby
views see the mutated state.

The main constraints are operational rather than technical. The command is
scoped to one subscribed game at a time, so we do not get one-frame control of
every game. The official paper score sheet remains authoritative, which limits
final-record integrity impact and provides a human recovery path. The backend
also runs behind a reverse proxy as an unprivileged service, so this is not a
host compromise or deployment compromise. Those constraints keep the severity
below critical, but they do not weaken the core application authorization
bypass.

The most relevant dead end is the Origin check. At first glance it may look
like a remote attacker needs to forge browser origin state. In practice the
public first-party page already supplies the allowed origin and the normal UI
offers a controller mode. Even for a direct lab client, sending a matching
local origin is sufficient against a local development instance. Origin
checking is useful defense in depth, but it cannot distinguish an authorized
controller from an anonymous user who selects controller mode.

## Proof of Concept

The included PoC is intentionally local-only. It creates a disposable local
game over `POST /api/games`, opens `/ws` with a matching local Origin,
subscribes to the new game as `controller` without any grant, sends a
`change-score` command, and verifies the mutation through `GET /api/games/:id`.

From the report directory, run:

```sh
cd poc
TARGET_BASE_URL=http://127.0.0.1:3000 bun run self_asserted_controller_authority.ts
```

Use a local development or lab server only. The script creates a test game and
mutates that game's score; it does not clean the game up because the scanned
revision stores games in process memory and does not expose a delete endpoint.
Restarting the local server clears the disposable state.

Representative output on the vulnerable revision:

```text
[+] created local game game-1a2b3c4d
[+] subscribed as controller without presenting a grant or credential
[+] unauthenticated controller command changed score to 10-0
```

A fixed implementation should reject the unauthenticated controller
subscription or reject the later command, so the PoC should fail before the
score changes unless it supplies a valid server-issued controller capability.

## Remediation

The invariant to restore is: controller authority must be a server-side,
game-scoped fact, not a client-selected role string. The server can still let a
client request controller mode, but it must verify a capability or authenticated
grant before storing `role: "controller"` or before accepting any mutation.

A minimal shape is to add a controller grant to the subscription message and
bind the verified result to the session:

```ts
// Sketch only: exact storage depends on the chosen grant model.
if (parsed.message.role === "controller") {
  const grant = validateControllerGrant({
    gameId: parsed.message.gameId,
    presentedGrant: parsed.message.controllerGrant,
    nowMs: Date.now(),
  });

  if (!grant.ok) {
    sendMessage(ws, {
      type: "error",
      message: "Controller authorization required.",
    });
    return;
  }

  ws.data.subscription = {
    type: "game",
    gameId: parsed.message.gameId,
    role: "controller",
    grantId: grant.grantId,
  };
} else {
  ws.data.subscription = {
    type: "game",
    gameId: parsed.message.gameId,
    role: "spectator",
  };
}
```

The command path should also re-check the server-side grant state, especially
if grants can be revoked, expire, or be rotated while a WebSocket remains open.
That second check prevents a stale socket from keeping authority after the
grant is no longer valid.

Regression coverage should include the exact vulnerable path:

- a `subscribe-game` frame with `role: "controller"` and no valid grant is
  rejected or downgraded to spectator authority;
- an `apply-commands` frame after an unauthenticated controller subscription
  cannot mutate state;
- a valid controller grant works only for its bound game ID;
- a valid grant for one game cannot command another game;
- a revoked or expired grant fails on an already-open socket.

The broader hardening direction is to separate public view DTOs from command
authority, keep grants out of URLs when possible, record command attribution,
and make controller authorization explicit in the WebSocket protocol instead
of deriving it from UI mode.

## Summary

This vulnerability exists because the server collapses UI mode and authority
into the same `role` field. We choose `role: "controller"`, the parser returns
it, the server stores it, and the later mutation gate trusts it. That lets an
anonymous same-origin user cross from public game access into controller-grade
live game control for any known game.

The PoC demonstrates the issue on a local instance by changing a disposable
game's score without presenting a controller grant. Future variant analysis
should look for every place where route state, URL mode, game IDs, or WebSocket
fields are treated as authorization evidence, and for long-lived sockets that
could retain stale authority after the real grant model is added.
