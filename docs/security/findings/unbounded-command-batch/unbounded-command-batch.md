# Unbounded command batches block the shared game service

## Executive Summary

Quadball Timer revision `caa5dac848e9e865524e44f30becae725048bcdc` accepts `apply-commands` WebSocket messages containing an application-unbounded `commands` array. The parser walks every command in one text frame, the server applies every accepted command synchronously to shared game state, and only after the loop does it broadcast snapshots. A remote client that can act as a controller can therefore turn one accepted frame into seconds of event-loop work and thousands of retained command identifiers.

I reviewed the vulnerable revision directly and used the scan's local validation evidence. The scan measured a 5,000-command `add-card` batch in a 578,941-byte frame taking about 6.797 seconds locally and retaining 5,000 command events with a roughly 680,544-byte state projection. I did not send traffic to any public or production service. The included PoC is local-only and defaults to a smaller bounded batch.

This is a High/P1 availability finding. The attack is public in the scanned baseline because controller authority is self-asserted, game identifiers are public, and the server performs the batch work on the same process that serves all games, lobbies, Controllers, and spectators.

## Background

The WebSocket protocol lets clients send command envelopes in batches:

```ts
export type ApplyCommandsMessage = {
  type: "apply-commands";
  gameId: string;
  commands: ClientCommandEnvelope[];
};
```

Batching is useful for offline replay: a Controller can accumulate operations while disconnected and then resend them with stable command IDs. That feature needs a strict server budget because replayed operations cross from a client-controlled queue into shared event state.

In the scanned implementation, the only broad transport limit is Bun's whole-message ceiling. There is no application maximum for the number of command envelopes, total accepted batch cost, per-command class, or per-game replay budget.

## Vulnerability Details

We first reach the parser through a text WebSocket frame. `parseClientWsMessage` requires `commands` to be an array, then loops over every entry:

```ts
if (!Array.isArray(payload.commands)) {
  return {
    ok: false,
    error: "apply-commands requires commands array.",
  };
}

const commands: ClientCommandEnvelope[] = [];
for (const entry of payload.commands) {
```

Inside that loop, each envelope is shape-checked and each nested command is parsed. There is no length check before the loop and no budget check inside it:

```ts
const parsedCommand = parseGameCommand(entry.command);
if (!parsedCommand.ok) {
  return {
    ok: false,
    error: parsedCommand.error,
  };
}

commands.push({
  id: entry.id,
  clientSentAtMs: entry.clientSentAtMs,
  command: parsedCommand.command,
});
```

After parsing, `src/index.ts` authorizes the frame using the socket subscription state. In this revision, the `controller` role in that subscription was supplied by the client. Once those checks pass, the server applies the whole array:

```ts
const ackedCommandIds = applyCommandsToGame({
  managedGame: game,
  commands: parsed.message.commands,
});
```

`applyCommandsToGame` is also unbounded by batch count:

```ts
for (const envelope of commands) {
  if (managedGame.appliedCommandIds.has(envelope.id)) {
    ackedCommandIds.push(envelope.id);
    continue;
  }

  managedGame.state = applyGameCommand({
    state: managedGame.state,
    command: envelope.command,
    nowMs: envelope.clientSentAtMs,
  });
```

Each new command mutates the game, inserts its ID into the dedupe set, pushes the ID into order, and acknowledges it. The dedupe history is capped at 5,000 IDs, but that cap is not a per-message work cap. A 5,000-command frame still performs 5,000 parser iterations, 5,000 engine applications, and retains up to 5,000 IDs/events before it returns.

The server then broadcasts the result:

```ts
broadcastGameSnapshot({
  gameId: parsed.message.gameId,
  game,
  sender: ws,
  senderAckedCommandIds: ackedCommandIds,
});
broadcastLobbySnapshot();
```

The missed invariant is that replay is allowed to be batched without a server-side operation budget. Offline recovery should be idempotent and ordered, but not allowed to monopolize the event loop or apply arbitrarily many commands in one frame.

## Exploitability Analysis

The strongest route is a single `apply-commands` frame containing many cheap valid commands. `add-card` is a useful command for this demonstration because it is valid, creates persistent state, and includes enough per-command structure to exercise parser and engine cost. The attacker does not need a malformed payload: the frame is normal JSON and every command envelope can be individually valid.

In the scanned baseline, an anonymous remote client can reach the command path by subscribing to a known game with `role: "controller"`. The server stores that self-asserted role and later treats it as the mutation gate. That missing authorization finding is separate, but it materially raises this batch finding's likelihood because the batch path is public rather than limited to a compromised legitimate Controller.

The scan's local validation gives a concrete lower bound. A 578,941-byte frame with 5,000 `add-card` commands was well below Bun's 16,777,216-byte whole-message cap and still took about 6.797 seconds to process. During that interval, the same single-threaded service is busy applying the batch. Other games, lobby snapshots, and controller updates share the process.

The retained state also matters. A large batch of new command IDs fills the dedupe history and, depending on command type, expands game state. A sender receives an acknowledgement array with every command ID, and subscribers receive the resulting snapshot. Even if later batches repeat IDs and hit the dedupe branch, the server still iterates over the array and grows the acknowledgement response for the sender.

Meaningful constraints remain:

- Bun rejects frames above the whole-message ceiling.
- The dedupe ID set is capped at 5,000 retained IDs.
- The measured payload did not prove a permanent process crash.
- Production Caddy limits and host headroom were not measured.

Those constraints do not close the vulnerability. The application accepts multi-second batches below the transport ceiling, performs the work synchronously, and exposes the path through a public controller role in the target revision.

## Proof of Concept

The included PoC is a local-only bounded probe. It creates a local game, subscribes as controller, sends a batch of `add-card` commands, and reports the elapsed time until the acknowledgement snapshot arrives.

Run it from the report directory against a disposable local server:

```sh
cd poc
bun run unbounded-command-batch-poc.ts
```

Representative output:

```text
[+] target: http://127.0.0.1:3000
[+] creating local game
[+] sending 1000 add-card commands
[+] received 1000 acknowledgements in 842 ms
[+] local-only probe complete
```

The default count is intentionally smaller than the scan's 5,000-command validation run. Increase `COUNT` only in an isolated disposable environment:

```sh
COUNT=5000 bun run unbounded-command-batch-poc.ts
```

Do not run this probe against public or production services. Larger counts can block the target process and disrupt connected clients.

## Remediation

Restore the invariant that a replay batch has an explicit server budget. The server should reject oversized batches before parsing or applying every command, and it should consider chunking or scheduling replay work so one socket cannot monopolize the event loop.

A minimal parser-side guard is:

```ts
const MAX_COMMANDS_PER_BATCH = 100;

if (!Array.isArray(payload.commands)) {
  return { ok: false, error: "apply-commands requires commands array." };
}

if (payload.commands.length > MAX_COMMANDS_PER_BATCH) {
  return { ok: false, error: "apply-commands batch is too large." };
}
```

That narrow check should be paired with application controls:

- validate a game-scoped controller capability before accepting any command batch;
- cap command ID length and acknowledgement response size;
- enforce per-game and per-controller replay rate limits;
- apply replay batches transactionally so one invalid command cannot partially apply earlier entries unless that behavior is explicit;
- consider server-side chunking with yields between chunks if large offline recovery is a supported requirement;
- add regression tests for maximum accepted batch size, rejection before mutation, duplicate-ID batches, and command classes with high state growth.

The important fix is not only picking a number. It is making the replay budget explicit in the protocol contract and enforcing that budget before expensive parsing, state mutation, or broadcast work.

## Summary

`apply-commands` currently lets one WebSocket frame carry an unbounded number of command envelopes below the transport ceiling. We can carry that array through parser validation into synchronous game-state mutation, retained command IDs, acknowledgement construction, and snapshot fan-out. The scan's local measurement showed a 5,000-command frame producing multi-second processing time. A small server-enforced batch budget, capability authorization, and replay-rate controls close the immediate issue and give offline recovery a defensible production contract.
