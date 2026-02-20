import { serve, type ServerWebSocket } from "bun";
import index from "./index.html";
import {
  applyGameCommand,
  createInitialGameState,
  projectGameSummary,
  projectGameView,
} from "@/lib/game-engine";
import type { ControllerRole, GameCommand, GameState } from "@/lib/game-types";
import { parseClientWsMessage, type ServerWsMessage } from "@/lib/ws-protocol";

type ManagedGame = {
  state: GameState;
  appliedCommandIds: Set<string>;
  appliedCommandOrder: string[];
};

type SessionSubscription =
  | {
      type: "none";
    }
  | {
      type: "lobby";
    }
  | {
      type: "game";
      gameId: string;
      role: ControllerRole;
    };

type SessionData = {
  id: string;
  subscription: SessionSubscription;
};

const games = new Map<string, ManagedGame>();
const sockets = new Set<ServerWebSocket<SessionData>>();

const MAX_TRACKED_COMMAND_IDS = 5_000;

const server = serve<SessionData>({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/ws": (req: Bun.BunRequest<"/ws">, routeServer: Bun.Server<SessionData>) => {
      const upgraded = routeServer.upgrade(req, {
        data: {
          id: crypto.randomUUID(),
          subscription: { type: "none" },
        },
      });

      if (upgraded) {
        return;
      }

      console.warn("WebSocket upgrade failed", {
        url: req.url,
        upgrade: req.headers.get("upgrade"),
        connection: req.headers.get("connection"),
      });

      return json(
        {
          error: "WebSocket upgrade failed.",
        },
        400,
      );
    },
    "/api/games": {
      GET() {
        const nowMs = Date.now();
        const snapshots = [...games.values()]
          .map((game) => projectGameSummary(game.state, nowMs))
          .sort((a, b) => b.updatedAtMs - a.updatedAtMs);

        return json({ games: snapshots });
      },
      POST(req: Request) {
        return createGame(req);
      },
    },
    "/api/games/:gameId": {
      GET(req: Request) {
        const gameId = new URL(req.url).pathname.replace("/api/games/", "");
        const game = games.get(gameId);
        if (game === undefined) {
          return json({ error: "Game not found." }, 404);
        }

        return json({ game: projectGameView(game.state, Date.now()) });
      },
    },
    "/*": index,
  },
  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
  websocket: {
    open(ws) {
      sockets.add(ws);
    },
    close(ws) {
      sockets.delete(ws);
    },
    message(ws, message) {
      if (typeof message !== "string") {
        sendMessage(ws, {
          type: "error",
          message: "Unsupported message format.",
        });
        return;
      }

      const parsed = parseClientWsMessage(message);
      if (!parsed.ok) {
        sendMessage(ws, {
          type: "error",
          message: parsed.error,
        });
        return;
      }

      switch (parsed.message.type) {
        case "subscribe-lobby": {
          ws.data.subscription = {
            type: "lobby",
          };
          sendLobbySnapshot(ws);
          return;
        }

        case "subscribe-game": {
          const game = games.get(parsed.message.gameId);
          if (game === undefined) {
            sendMessage(ws, {
              type: "error",
              message: "Game not found.",
            });
            return;
          }

          ws.data.subscription = {
            type: "game",
            gameId: parsed.message.gameId,
            role: parsed.message.role,
          };

          sendGameSnapshot({
            ws,
            game,
            ackedCommandIds: [],
          });
          return;
        }

        case "apply-commands": {
          if (ws.data.subscription.type !== "game") {
            sendMessage(ws, {
              type: "error",
              message: "Not subscribed to a game.",
            });
            return;
          }

          if (ws.data.subscription.role !== "controller") {
            sendMessage(ws, {
              type: "error",
              message: "Spectators cannot apply commands.",
            });
            return;
          }

          if (ws.data.subscription.gameId !== parsed.message.gameId) {
            sendMessage(ws, {
              type: "error",
              message: "Command gameId mismatch.",
            });
            return;
          }

          const game = games.get(parsed.message.gameId);
          if (game === undefined) {
            sendMessage(ws, {
              type: "error",
              message: "Game not found.",
            });
            return;
          }

          const ackedCommandIds = applyCommandsToGame({
            managedGame: game,
            commands: parsed.message.commands,
          });

          broadcastGameSnapshot({
            gameId: parsed.message.gameId,
            game,
            sender: ws,
            senderAckedCommandIds: ackedCommandIds,
          });
          broadcastLobbySnapshot();
          return;
        }

        default: {
          const _never: never = parsed.message;
          return _never;
        }
      }
    },
  },
});

console.log(`Server running at ${server.url}`);

function createGame(req: Request) {
  return req
    .json()
    .catch(() => ({}))
    .then((body) => {
      const payload = isRecord(body) ? body : {};
      const homeName =
        typeof payload.homeName === "string" && payload.homeName.trim().length > 0
          ? payload.homeName
          : "Home";
      const awayName =
        typeof payload.awayName === "string" && payload.awayName.trim().length > 0
          ? payload.awayName
          : "Away";

      const id = createGameId();
      const nowMs = Date.now();
      const managedGame: ManagedGame = {
        state: createInitialGameState({
          id,
          nowMs,
          homeName,
          awayName,
        }),
        appliedCommandIds: new Set(),
        appliedCommandOrder: [],
      };

      games.set(id, managedGame);
      broadcastLobbySnapshot();

      return json(
        {
          gameId: id,
          game: projectGameView(managedGame.state, nowMs),
        },
        201,
      );
    });
}

function createGameId() {
  return `game-${crypto.randomUUID().slice(0, 8)}`;
}

function applyCommandsToGame({
  managedGame,
  commands,
}: {
  managedGame: ManagedGame;
  commands: {
    id: string;
    clientSentAtMs: number;
    command: GameCommand;
  }[];
}) {
  const ackedCommandIds: string[] = [];

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

    managedGame.appliedCommandIds.add(envelope.id);
    managedGame.appliedCommandOrder.push(envelope.id);
    ackedCommandIds.push(envelope.id);

    if (managedGame.appliedCommandOrder.length > MAX_TRACKED_COMMAND_IDS) {
      const removedId = managedGame.appliedCommandOrder.shift();
      if (removedId !== undefined) {
        managedGame.appliedCommandIds.delete(removedId);
      }
    }
  }

  return ackedCommandIds;
}

function broadcastLobbySnapshot() {
  for (const ws of sockets) {
    if (ws.data.subscription.type === "lobby") {
      sendLobbySnapshot(ws);
    }
  }
}

function sendLobbySnapshot(ws: ServerWebSocket<SessionData>) {
  const nowMs = Date.now();
  const summaries = [...games.values()]
    .map((game) => projectGameSummary(game.state, nowMs))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  sendMessage(ws, {
    type: "lobby-snapshot",
    games: summaries,
    serverNowMs: nowMs,
  });
}

function broadcastGameSnapshot({
  gameId,
  game,
  sender,
  senderAckedCommandIds,
}: {
  gameId: string;
  game: ManagedGame;
  sender: ServerWebSocket<SessionData>;
  senderAckedCommandIds: string[];
}) {
  for (const ws of sockets) {
    if (ws.data.subscription.type !== "game" || ws.data.subscription.gameId !== gameId) {
      continue;
    }

    sendGameSnapshot({
      ws,
      game,
      ackedCommandIds: ws === sender ? senderAckedCommandIds : [],
    });
  }
}

function sendGameSnapshot({
  ws,
  game,
  ackedCommandIds,
}: {
  ws: ServerWebSocket<SessionData>;
  game: ManagedGame;
  ackedCommandIds: string[];
}) {
  const nowMs = Date.now();
  sendMessage(ws, {
    type: "game-snapshot",
    game: projectGameView(game.state, nowMs),
    serverNowMs: nowMs,
    ackedCommandIds,
  });
}

function sendMessage(ws: ServerWebSocket<SessionData>, payload: ServerWsMessage) {
  ws.send(JSON.stringify(payload));
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
