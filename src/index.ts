import { serve, type ServerWebSocket } from "bun";
import index from "./index.html";
import {
  applyGameCommand,
  createInitialGameState,
  projectGameSummary,
  projectGameView,
} from "@/lib/game-engine";
import type { ControllerRole, GameCommand, GameState } from "@/lib/game-types";
import { readJsonBodyWithinLimit } from "@/lib/http-body";
import { isInternalHealthHost } from "@/lib/internal-health";
import { normalizeBoundedText, SHARED_LIMITS } from "@/lib/validation-policy";
import {
  parseSqliteProbeInvocation,
  runSqliteFoundationProbe,
  runSqliteFoundationProbeWorker,
  type SqliteProbeInvocation,
} from "@/lib/sqlite-foundation-probe";
import { isAllowedWebSocketOrigin } from "@/lib/ws-origin";
import { parseClientWsMessage, type ServerWsMessage } from "@/lib/ws-protocol";
import {
  clearTechnicalAdminCookie,
  createSqliteTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
  technicalAdminCookie,
  type CeremonyBinding,
} from "@/lib/technical-admin-auth";
import { readTechnicalAdminConfig } from "@/lib/technical-admin-config";

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

const probeInvocation = parseSqliteProbeInvocation(process.argv.slice(1));

async function main() {
  if (probeInvocation.kind === "invalid") {
    console.error(probeInvocation.error);
    process.exitCode = 1;
    return;
  }

  if (probeInvocation.kind !== "none") {
    await runProbeMode(probeInvocation);
    return;
  }

  startServer();
}

function startServer() {
  const port = Number(process.env.PORT ?? 3000);
  const technicalAdminConfig = readTechnicalAdminConfig();
  const { environment } = technicalAdminConfig;
  const databasePath =
    technicalAdminConfig.databasePath ?? `data/${environment}/technical-admin.sqlite`;
  const technicalAdminAuth = createTechnicalAdminAuth(
    technicalAdminConfig,
    createSqliteTechnicalAdminAuthRepository(databasePath, {
      environment: technicalAdminConfig.environment,
      origin: technicalAdminConfig.origin,
      rpId: technicalAdminConfig.rpId,
    }),
  );
  const tls =
    process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE
      ? { cert: Bun.file(process.env.TLS_CERT_FILE), key: Bun.file(process.env.TLS_KEY_FILE) }
      : undefined;

  const server = serve<SessionData>({
    hostname: process.env.HOST ?? "127.0.0.1",
    port,
    ...(tls ? { tls } : {}),
    routes: {
      "/ws": (req: Bun.BunRequest<"/ws">, routeServer: Bun.Server<SessionData>) => {
        if (!isAllowedWebSocketOrigin(req.headers.get("origin"), req.headers.get("host"))) {
          return json(
            {
              error: "WebSocket origin not allowed.",
            },
            403,
          );
        }

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
      "/api/admin/enrollment/options": {
        async POST(req: Request) {
          const body = await readJsonRecord(req);
          const token = body?.token;
          if (typeof token !== "string") return genericAuthFailure(400);
          const result = technicalAdminAuth.beginEnrollment(token, requestBinding(req));
          return result.ok
            ? json(result.value)
            : genericAuthFailure(result.error === "not-enrollable" ? 409 : 401);
        },
      },
      "/api/admin/enrollment/complete": {
        async POST(req: Request) {
          const body = await readJsonRecord(req);
          if (!body || typeof body.challengeId !== "string" || body.response === undefined) {
            return genericAuthFailure(400);
          }
          const result = await technicalAdminAuth.completeEnrollment(
            body.challengeId,
            body.response,
            requestBinding(req),
          );
          return result.ok ? json({ enrolled: true }) : genericAuthFailure(401);
        },
      },
      "/api/admin/authentication/options": {
        POST(req: Request) {
          const result = technicalAdminAuth.beginAuthentication(requestBinding(req));
          return result.ok ? json(result.value) : genericAuthFailure(401);
        },
      },
      "/api/admin/authentication/complete": {
        async POST(req: Request) {
          const body = await readJsonRecord(req);
          if (!body || typeof body.challengeId !== "string" || body.response === undefined) {
            return genericAuthFailure(400);
          }
          const result = await technicalAdminAuth.completeAuthentication(
            body.challengeId,
            body.response,
            requestBinding(req),
          );
          if (!result.ok) return genericAuthFailure(401);
          return new Response(JSON.stringify({ authenticated: true }), {
            headers: {
              "content-type": "application/json",
              "set-cookie": technicalAdminCookie(result.value.token),
            },
          });
        },
      },
      "/api/admin/session": {
        GET(req: Request) {
          const token = readTechnicalAdminCookie(req.headers.get("cookie"));
          if (token === null || !technicalAdminAuth.authenticateSession(token))
            return genericAuthFailure(401);
          return json({ authenticated: true, environment });
        },
      },
      "/api/admin/logout": {
        POST(req: Request) {
          if (!technicalAdminAuth.isExpectedBinding(requestBinding(req)))
            return genericAuthFailure(403);
          const token = readTechnicalAdminCookie(req.headers.get("cookie"));
          if (token !== null) technicalAdminAuth.logout(token);
          return new Response(JSON.stringify({ loggedOut: true }), {
            headers: {
              "content-type": "application/json",
              "set-cookie": clearTechnicalAdminCookie(),
            },
          });
        },
      },
      "/internal/healthz": {
        GET(req: Request) {
          if (!isInternalHealthHost(req.headers.get("host"))) {
            return json({ error: "Not found." }, 404);
          }

          return json({ ok: true });
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

        const parsed = parseClientWsMessage(message, {
          serverNowMs: Date.now(),
        });
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
}

void main();

async function runProbeMode(
  invocation: Exclude<SqliteProbeInvocation, { kind: "none" } | { kind: "invalid" }>,
) {
  try {
    switch (invocation.kind) {
      case "outer": {
        const report = await runSqliteFoundationProbe();
        console.log(JSON.stringify(report));
        return;
      }
      case "writer": {
        await runSqliteFoundationProbeWorker(
          "writer",
          invocation.directoryPath,
          invocation.capability,
          invocation.writerId,
        );
        return;
      }
      case "checkpoint": {
        await runSqliteFoundationProbeWorker(
          "checkpoint",
          invocation.directoryPath,
          invocation.capability,
        );
        return;
      }
      default: {
        const _never: never = invocation;
        return _never;
      }
    }
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "SQLite probe failed; return the database choice to a human.",
    );
    process.exitCode = 1;
  }
}

async function createGame(req: Request) {
  const body = await readJsonBodyWithinLimit(req, SHARED_LIMITS.transport.httpJsonBodyBytes);
  if (!body.ok) {
    return json({ error: body.error }, body.status);
  }

  if (!isRecord(body.body)) {
    return json({ error: "JSON body must be an object." }, 400);
  }

  const payload = body.body;
  const homeName =
    payload.homeName === undefined
      ? { ok: true as const, value: "Home" }
      : normalizeBoundedText(
          payload.homeName,
          SHARED_LIMITS.names.teamAndPitchMaxCodePoints,
          "homeName",
        );
  const awayName =
    payload.awayName === undefined
      ? { ok: true as const, value: "Away" }
      : normalizeBoundedText(
          payload.awayName,
          SHARED_LIMITS.names.teamAndPitchMaxCodePoints,
          "awayName",
        );

  if (!homeName.ok) {
    return json(
      {
        error: homeName.error,
      },
      400,
    );
  }
  if (!awayName.ok) {
    return json({ error: awayName.error }, 400);
  }

  const homeColor = typeof payload.homeColor === "string" ? payload.homeColor : undefined;
  const awayColor = typeof payload.awayColor === "string" ? payload.awayColor : undefined;

  const id = createGameId();
  const nowMs = Date.now();
  const managedGame: ManagedGame = {
    state: createInitialGameState({
      id,
      nowMs,
      homeName: homeName.value,
      awayName: awayName.value,
      homeColor,
      awayColor,
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

async function readJsonRecord(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await req.json();
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function requestBinding(req: Request): CeremonyBinding {
  return {
    origin: req.headers.get("origin") ?? "",
    host: req.headers.get("host") ?? "",
  };
}

function genericAuthFailure(status: number) {
  return json({ error: "Authentication failed." }, status);
}

function readTechnicalAdminCookie(header: string | null): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === "__Host-technical-admin" && value.length > 0) return value.join("=");
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
