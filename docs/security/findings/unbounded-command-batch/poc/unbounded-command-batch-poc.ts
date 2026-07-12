const target = process.env.TARGET ?? "http://127.0.0.1:3000";
const count = Number.parseInt(process.env.COUNT ?? "1000", 10);

if (!Number.isSafeInteger(count) || count < 1 || count > 5_000) {
  throw new Error("COUNT must be an integer from 1 to 5000 for this bounded local probe.");
}

console.log(`[+] target: ${target}`);
console.log("[+] creating local game");

const createResponse = await fetch(`${target}/api/games`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ homeName: "Home", awayName: "Away" }),
});

if (createResponse.status !== 201) {
  throw new Error(`game creation failed with HTTP ${createResponse.status}`);
}

const createBody = (await createResponse.json()) as { gameId?: unknown };
if (typeof createBody.gameId !== "string") {
  throw new Error("game creation did not return a gameId");
}

const gameId = createBody.gameId;
const websocketUrl = target.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
const targetOrigin = new URL(target).origin;
const commands = Array.from({ length: count }, (_, index) => ({
  id: `batch-poc-${index}`,
  clientSentAtMs: Date.now() + index,
  command: {
    type: "add-card",
    team: index % 2 === 0 ? "home" : "away",
    playerNumber: null,
    cardType: "blue",
  },
}));

type BunWebSocketConstructor = new (
  url: string | URL,
  options: { headers: Record<string, string> },
) => WebSocket;

const BunWebSocket = WebSocket as unknown as BunWebSocketConstructor;
const socket = new BunWebSocket(`${websocketUrl}/ws`, {
  headers: {
    origin: targetOrigin,
  },
});
let subscribed = false;
let startedAt = 0;

await new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error("timed out waiting for acknowledgement")),
    30_000,
  );

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "subscribe-game", gameId, role: "controller" }));
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      type?: unknown;
      ackedCommandIds?: unknown;
    };

    if (message.type !== "game-snapshot") {
      return;
    }

    if (!subscribed) {
      subscribed = true;
      console.log(`[+] sending ${count} add-card commands`);
      startedAt = Date.now();
      socket.send(JSON.stringify({ type: "apply-commands", gameId, commands }));
      return;
    }

    const acknowledgements = Array.isArray(message.ackedCommandIds)
      ? message.ackedCommandIds.length
      : 0;
    if (acknowledgements === count) {
      clearTimeout(timeout);
      const elapsedMs = Date.now() - startedAt;
      console.log(`[+] received ${acknowledgements} acknowledgements in ${elapsedMs} ms`);
      socket.close();
      resolve();
    }
  });

  socket.addEventListener("error", () => {
    clearTimeout(timeout);
    reject(new Error("websocket error"));
  });
});

console.log("[+] local-only probe complete");
