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
import { createLiveEventGameControlTransport } from "@/lib/live-event-game-transport";
import {
  openLiveEventGameRuntime,
  readLiveEventGrantKeyRing,
  type LiveEventGameRuntime,
} from "@/lib/live-event-game-runtime";
import {
  clearTechnicalAdminCookie,
  clearTechnicalAdminCsrfCookie,
  createSqliteTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
  createTechnicalAdminRetentionScheduler,
  technicalAdminCsrfCookie,
  technicalAdminCookie,
  type AuthResult,
  type CeremonyBinding,
  type TechnicalAdminAuth,
  type TechnicalAdminAuthority,
} from "@/lib/technical-admin-auth";
import { readRuntimeConfig } from "@/lib/runtime-config";
import {
  createEventCatalog,
  createFoundationEventCatalogStorage,
  createUnavailableEventCatalogStorage,
  type CatalogOutcome,
} from "@/lib/event-catalog";
import {
  createEventAdministration,
  type EventAdministration,
  type EventAdministrationAuthority,
  type EventAdministrationOutcome,
} from "@/lib/event-administration";
import { createGrantAuthority } from "@/lib/grant-authority";
import { readGrantAuthorityOptions } from "@/lib/grant-runtime";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import type { FoundationStorage } from "@/lib/foundation-storage";
import { assertProductionStateBoundary } from "@/lib/runtime-storage-config";
import { createStartupCleanup } from "@/lib/startup-resources";

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

  await startServer();
}

async function startServer() {
  let technicalAdminRepository:
    | ReturnType<typeof createSqliteTechnicalAdminAuthRepository>
    | undefined;
  let technicalAdminAuth!: ReturnType<typeof createTechnicalAdminAuth>;
  let foundationStorage: FoundationStorage | undefined;
  let server: Bun.Server<SessionData> | undefined;
  let shutdown: (() => void) | undefined;
  const startupCleanup = createStartupCleanup();
  const cleanup = () => startupCleanup.run();

  try {
    const port = Number(process.env.PORT ?? 3000);
    const { technicalAdmin: technicalAdminConfig, storagePaths } = readRuntimeConfig();
    const { environment } = technicalAdminConfig;
    assertProductionStateBoundary(environment, storagePaths);
    const databasePath = storagePaths.technicalAdminDatabase;
    technicalAdminRepository = createSqliteTechnicalAdminAuthRepository(databasePath, {
      environment: technicalAdminConfig.environment,
      origin: technicalAdminConfig.origin,
      rpId: technicalAdminConfig.rpId,
    });
    startupCleanup.add(() => technicalAdminRepository?.close());
    technicalAdminAuth = createTechnicalAdminAuth(technicalAdminConfig, technicalAdminRepository);
    startupCleanup.add(() => {
      technicalAdminAuth.stopRetentionMaintenance();
      technicalAdminAuth.close();
    });
    technicalAdminAuth.storageStatus();
    technicalAdminAuth.startRetentionMaintenance(createTechnicalAdminRetentionScheduler());

    const foundationDatabasePath = storagePaths.foundationDatabase;
    let eventCatalogStorage;
    let candidateFoundation: FoundationStorage | undefined;
    try {
      candidateFoundation =
        environment === "test" && !process.env.FOUNDATION_DATABASE?.trim()
          ? createInMemoryFoundationStorage()
          : openSqliteFoundationStorage(foundationDatabasePath);
      const readiness = await candidateFoundation.readiness();
      if (readiness.ok) {
        const readyFoundation = candidateFoundation;
        foundationStorage = readyFoundation;
        candidateFoundation = undefined;
        startupCleanup.add(() => readyFoundation.close());
        eventCatalogStorage = createFoundationEventCatalogStorage(readyFoundation);
      } else {
        candidateFoundation.close();
        candidateFoundation = undefined;
        eventCatalogStorage = createUnavailableEventCatalogStorage(
          `Event catalog foundation storage is not ready: ${readiness.status}.`,
        );
      }
    } catch (error) {
      candidateFoundation?.close();
      foundationStorage?.close();
      foundationStorage = undefined;
      eventCatalogStorage = createUnavailableEventCatalogStorage(
        error instanceof Error
          ? `Event catalog foundation storage is unavailable: ${error.message}`
          : "Event catalog foundation storage is unavailable.",
      );
    }

    const eventCatalog = createEventCatalog(eventCatalogStorage, {});
    let eventAdministration: EventAdministration | null = null;
    if (foundationStorage !== undefined) {
      try {
        const grantAuthority = createGrantAuthority(
          foundationStorage,
          readGrantAuthorityOptions(environment),
        );
        eventAdministration = createEventAdministration({
          storage: foundationStorage,
          grants: grantAuthority,
        });
      } catch {
        // Grant keys are an Event Administration dependency, not a server-wide dependency.
        // Keep the foundation-backed Technical Admin and Event Catalog routes available.
        eventAdministration = null;
      }
    }
    let liveEventRuntime: LiveEventGameRuntime | null = null;
    const liveEventDatabasePath =
      process.env.EVENT_GAME_DATABASE ?? `data/${environment}/event-game.sqlite`;
    const liveEventKeyRing = readLiveEventGrantKeyRing();
    if (liveEventKeyRing !== null) {
      try {
        liveEventRuntime = await openLiveEventGameRuntime({
          databasePath: liveEventDatabasePath,
          environmentId: environment,
          keyRing: liveEventKeyRing,
        });
        startupCleanup.add(() => liveEventRuntime?.close());
      } catch (error) {
        console.warn("Durable Event Game Controller is unavailable.", error);
      }
    }
    const liveEventControlTransport = createLiveEventGameControlTransport(
      () => liveEventRuntime?.control ?? null,
      (request) => technicalAdminAuth.isExpectedBinding(requestBinding(request)),
    );
    const adminGrantMutationRoute =
      (
        operation:
          | "rotateEventAdminGrant"
          | "disableEventAdminGrant"
          | "revokeEventAdminGrant"
          | "reactivateEventAdminGrant",
      ) =>
      async (req: Request) => {
        const token = requireTechnicalAdminMutationToken(req, technicalAdminAuth);
        if (token === null) return genericAuthFailure(401);
        if (eventAdministration === null) return genericAuthFailure(503);
        const eventId = new URL(req.url).pathname.split("/").at(-3) ?? "";
        return eventAdministrationResponse(await eventAdministration[operation](eventId, token));
      };
    const tls =
      process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE
        ? { cert: Bun.file(process.env.TLS_CERT_FILE), key: Bun.file(process.env.TLS_KEY_FILE) }
        : undefined;

    shutdown = () => {
      cleanup();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);

    server = serve<SessionData>({
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
            const game = readAdHocGame(gameId);
            if (game === null) {
              return json({ error: "Game not found." }, 404);
            }

            return json({ game });
          },
        },
        "/api/event-control/open": {
          POST(req: Request) {
            return liveEventControlTransport.openController(req);
          },
        },
        "/api/event-control/intent": {
          POST(req: Request) {
            return liveEventControlTransport.submitControllerIntent(req);
          },
        },
        "/api/event-control/replay": {
          POST(req: Request) {
            return liveEventControlTransport.replayControllerActions(req);
          },
        },
        "/api/event-control/refresh": {
          POST(req: Request) {
            return liveEventControlTransport.refreshController(req);
          },
        },
        "/api/event-control/switch": {
          POST(req: Request) {
            return liveEventControlTransport.switchController(req);
          },
        },
        "/api/event-control/stay": {
          POST(req: Request) {
            return liveEventControlTransport.stayController(req);
          },
        },
        "/api/event-control/reveal-qr": {
          POST(req: Request) {
            return liveEventControlTransport.revealControllerQr(req);
          },
        },
        "/api/event-control/leave": {
          POST(req: Request) {
            return liveEventControlTransport.leaveController(req);
          },
        },
        "/api/admin/enrollment/options": {
          async POST(req: Request) {
            const body = await readJsonRecord(req);
            const token = body?.token;
            if (typeof token !== "string") return genericAuthFailure(400);
            const result = technicalAdminAuth.beginEnrollment(token, requestBinding(req));
            return result.ok
              ? sensitiveJson(result.value)
              : genericAuthFailure(result.error === "not-enrollable" ? 409 : 401);
          },
        },
        "/api/admin/enrollment/complete": {
          async POST(req: Request) {
            const body = await readCeremonyBody(req);
            if (body === null) {
              return genericAuthFailure(400);
            }
            const result = await technicalAdminAuth.completeEnrollment(
              body.challengeId,
              body.response,
              requestBinding(req),
              technicalAdminAuth.correlateSource(
                requestSource(req, technicalAdminConfig.trustProxyHeaders),
              ),
            );
            return result.ok ? sensitiveJson({ enrolled: true }) : authFailureResponse(result);
          },
        },
        "/api/admin/authentication/options": {
          POST(req: Request) {
            const result = technicalAdminAuth.beginAuthentication(requestBinding(req));
            return result.ok ? sensitiveJson(result.value) : genericAuthFailure(401);
          },
        },
        "/api/admin/authentication/complete": {
          async POST(req: Request) {
            const body = await readCeremonyBody(req);
            if (body === null) {
              return genericAuthFailure(400);
            }
            const result = await technicalAdminAuth.completeAuthentication(
              body.challengeId,
              body.response,
              requestBinding(req),
              technicalAdminAuth.correlateSource(
                requestSource(req, technicalAdminConfig.trustProxyHeaders),
              ),
            );
            if (!result.ok) return authFailureResponse(result);
            return sensitiveJson({ authenticated: true }, 200, [
              ["set-cookie", technicalAdminCookie(result.value.token)],
              ["set-cookie", technicalAdminCsrfCookie(result.value.csrfToken)],
            ]);
          },
        },
        "/api/admin/session": {
          GET(req: Request) {
            const token = readTechnicalAdminCookie(req.headers.get("cookie"));
            if (token === null || !technicalAdminAuth.authenticateSession(token))
              return genericAuthFailure(401);
            return sensitiveJson({
              authenticated: true,
              environment,
              activeSessionCount: technicalAdminAuth.activeSessionCount(),
            });
          },
        },
        "/api/admin/logout": {
          POST(req: Request) {
            const token = requireAdminMutation(req, technicalAdminAuth);
            if (token === null) return genericAuthFailure(401);
            technicalAdminAuth.logout(token);
            return sensitiveJson({ loggedOut: true }, 200, [
              ["set-cookie", clearTechnicalAdminCookie()],
              ["set-cookie", clearTechnicalAdminCsrfCookie()],
            ]);
          },
        },
        "/api/admin/step-up/options": {
          async POST(req: Request) {
            const token = requireAdminMutation(req, technicalAdminAuth);
            if (token === null) return genericAuthFailure(401);
            const body = await readJsonRecord(req);
            const purpose = body?.purpose;
            if (purpose !== "replace-credential" && purpose !== "revoke-other-sessions") {
              return genericAuthFailure(400);
            }
            const result = technicalAdminAuth.beginFreshVerification(
              token,
              purpose,
              requestBinding(req),
            );
            return result.ok ? sensitiveJson(result.value) : genericAuthFailure(401);
          },
        },
        "/api/admin/step-up/complete": {
          async POST(req: Request) {
            const token = requireAdminMutation(req, technicalAdminAuth);
            if (token === null) return genericAuthFailure(401);
            const body = await readCeremonyBody(req);
            if (body === null) {
              return genericAuthFailure(400);
            }
            const result = await technicalAdminAuth.completeFreshVerification(
              token,
              body.challengeId,
              body.response,
              requestBinding(req),
              technicalAdminAuth.correlateSource(
                requestSource(req, technicalAdminConfig.trustProxyHeaders),
              ),
            );
            return result.ok ? sensitiveJson({ verified: true }) : authFailureResponse(result);
          },
        },
        "/api/admin/replacement/options": {
          POST(req: Request) {
            const token = requireAdminMutation(req, technicalAdminAuth);
            if (token === null) return genericAuthFailure(401);
            const result = technicalAdminAuth.beginReplacement(token, requestBinding(req));
            return result.ok ? sensitiveJson(result.value) : genericAuthFailure(401);
          },
        },
        "/api/admin/replacement/complete": {
          async POST(req: Request) {
            const token = requireAdminMutation(req, technicalAdminAuth);
            if (token === null) return genericAuthFailure(401);
            const body = await readCeremonyBody(req);
            if (body === null) {
              return genericAuthFailure(400);
            }
            const result = await technicalAdminAuth.completeReplacement(
              token,
              body.challengeId,
              body.response,
              requestBinding(req),
              technicalAdminAuth.correlateSource(
                requestSource(req, technicalAdminConfig.trustProxyHeaders),
              ),
            );
            if (!result.ok) return authFailureResponse(result);
            return sensitiveJson({ replaced: true }, 200, [
              ["set-cookie", technicalAdminCookie(result.value.token)],
              ["set-cookie", technicalAdminCsrfCookie(result.value.csrfToken)],
            ]);
          },
        },
        "/api/admin/sessions/revoke-others": {
          POST(req: Request) {
            const token = requireAdminMutation(req, technicalAdminAuth);
            if (token === null) return genericAuthFailure(401);
            const result = technicalAdminAuth.revokeOtherSessions(token);
            return result.ok ? sensitiveJson(result.value) : authFailureResponse(result);
          },
        },
        "/api/admin/events": {
          async GET(req: Request) {
            const token = requireTechnicalAdminToken(req, technicalAdminAuth);
            if (token === null) return genericAuthFailure(401);
            return catalogResponse(await eventCatalog.listEvents(token));
          },
          async POST(req: Request) {
            const token = requireTechnicalAdminMutationToken(req, technicalAdminAuth);
            if (token === null) return genericAuthFailure(401);
            const body = await readJsonRecord(req);
            if (body === null)
              return json(
                {
                  status: "rejected",
                  reason: "invalid-input",
                  detail: "JSON body must be an object.",
                },
                400,
              );
            return catalogResponse(
              await eventCatalog.createEvent({ name: body.name, timeZone: body.timeZone }, token),
              201,
            );
          },
        },
        "/api/admin/events/:eventId": {
          async GET(req: Request) {
            const token = requireTechnicalAdminToken(req, technicalAdminAuth);
            if (token === null) return genericAuthFailure(401);
            const eventId = new URL(req.url).pathname.split("/").at(-1) ?? "";
            return catalogResponse(await eventCatalog.inspectEvent(eventId, token));
          },
          async PATCH(req: Request) {
            const token = requireTechnicalAdminMutationToken(req, technicalAdminAuth);
            if (token === null) return genericAuthFailure(401);
            const eventId = new URL(req.url).pathname.split("/").at(-1) ?? "";
            const body = await readJsonRecord(req);
            if (body === null)
              return json(
                {
                  status: "rejected",
                  reason: "invalid-input",
                  detail: "JSON body must be an object.",
                },
                400,
              );
            return catalogResponse(
              await eventCatalog.updateEvent(
                eventId,
                { name: body.name, timeZone: body.timeZone },
                token,
              ),
            );
          },
          async DELETE(req: Request) {
            const token = requireTechnicalAdminMutationToken(req, technicalAdminAuth);
            if (token === null) return genericAuthFailure(401);
            const eventId = new URL(req.url).pathname.split("/").at(-1) ?? "";
            return catalogResponse(await eventCatalog.removeEvent(eventId, token));
          },
        },
        "/api/admin/events/:eventId/game-days": {
          async POST(req: Request) {
            const token = requireTechnicalAdminMutationToken(req, technicalAdminAuth);
            if (token === null) return genericAuthFailure(401);
            const path = new URL(req.url).pathname.split("/");
            const eventId = path.at(-2) ?? "";
            const body = await readJsonRecord(req);
            if (body === null)
              return json(
                {
                  status: "rejected",
                  reason: "invalid-input",
                  detail: "JSON body must be an object.",
                },
                400,
              );
            return catalogResponse(
              await eventCatalog.addGameDay(eventId, { date: body.date }, token),
              201,
            );
          },
        },
        "/api/admin/events/:eventId/game-days/:gameDayId": {
          async PATCH(req: Request) {
            const token = requireTechnicalAdminMutationToken(req, technicalAdminAuth);
            if (token === null) return genericAuthFailure(401);
            const path = new URL(req.url).pathname.split("/");
            const eventId = path.at(-3) ?? "";
            const gameDayId = path.at(-1) ?? "";
            const body = await readJsonRecord(req);
            if (body === null)
              return json(
                {
                  status: "rejected",
                  reason: "invalid-input",
                  detail: "JSON body must be an object.",
                },
                400,
              );
            return catalogResponse(
              await eventCatalog.updateGameDay(eventId, gameDayId, { date: body.date }, token),
            );
          },
          async DELETE(req: Request) {
            const token = requireTechnicalAdminMutationToken(req, technicalAdminAuth);
            if (token === null) return genericAuthFailure(401);
            const path = new URL(req.url).pathname.split("/");
            const eventId = path.at(-3) ?? "";
            const gameDayId = path.at(-1) ?? "";
            return catalogResponse(await eventCatalog.removeGameDay(eventId, gameDayId, token));
          },
        },
        "/api/admin/events/:eventId/event-admin-grant": {
          async GET(req: Request) {
            const token = requireTechnicalAdminToken(req, technicalAdminAuth);
            if (token === null) return genericAuthFailure(401);
            if (eventAdministration === null) return genericAuthFailure(503);
            const eventId = new URL(req.url).pathname.split("/").at(-2) ?? "";
            return eventAdministrationResponse(
              await eventAdministration.inspectEventAdminGrant(eventId, token),
            );
          },
          async POST(req: Request) {
            const token = requireTechnicalAdminMutationToken(req, technicalAdminAuth);
            if (token === null) return genericAuthFailure(401);
            if (eventAdministration === null) return genericAuthFailure(503);
            const eventId = new URL(req.url).pathname.split("/").at(-2) ?? "";
            return eventAdministrationResponse(
              await eventAdministration.createEventAdminGrant(eventId, token),
              201,
            );
          },
        },
        "/api/admin/events/:eventId/event-admin-grant/reveal": {
          async POST(req: Request) {
            const token = requireTechnicalAdminMutationToken(req, technicalAdminAuth);
            if (token === null) return genericAuthFailure(401);
            if (eventAdministration === null) return genericAuthFailure(503);
            const eventId = new URL(req.url).pathname.split("/").at(-3) ?? "";
            return sensitiveEventAdministrationResponse(
              await eventAdministration.revealEventAdminGrant(eventId, token),
            );
          },
        },
        "/api/admin/events/:eventId/event-admin-grant/rotate": {
          POST: adminGrantMutationRoute("rotateEventAdminGrant"),
        },
        "/api/admin/events/:eventId/event-admin-grant/disable": {
          POST: adminGrantMutationRoute("disableEventAdminGrant"),
        },
        "/api/admin/events/:eventId/event-admin-grant/revoke": {
          POST: adminGrantMutationRoute("revokeEventAdminGrant"),
        },
        "/api/admin/events/:eventId/event-admin-grant/reactivate": {
          POST: adminGrantMutationRoute("reactivateEventAdminGrant"),
        },
        "/api/event-admin/admit": {
          async POST(req: Request) {
            if (eventAdministration === null) return genericAuthFailure(503);
            const body = await readJsonRecord(req);
            if (body === null || typeof body.qrCredential !== "string")
              return json({ error: "Unable to admit this Grant." }, 400);
            const context = readEventAdminContext(req.headers.get("cookie")) ?? crypto.randomUUID();
            const result = await eventAdministration.admitEventAdmin({
              qrCredential: body.qrCredential,
              browserContext: context,
              deviceClass: body.deviceClass,
              browserClass: body.browserClass,
            });
            if (result.status !== "admitted") return sensitiveJson(result, 401);
            return sensitiveJson(
              {
                status: "admitted",
                grantId: result.grantId,
                grantVersion: result.grantVersion,
                grantType: result.grantType,
                scope: result.scope,
                grantSessionId: result.grantSessionId,
              },
              200,
              [
                ["set-cookie", eventAdminContextCookie(context)],
                [
                  "set-cookie",
                  eventAdminSessionCookie(result.sessionBearer, result.sessionExpiresAtMs),
                ],
              ],
            );
          },
        },
        "/api/event-admin/hub": {
          async GET(req: Request) {
            if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
            const url = new URL(req.url);
            const eventId = url.searchParams.get("eventId") ?? "";
            const gameDayId = url.searchParams.get("gameDayId") ?? undefined;
            const authority = resolveEventAdministrationAuthority(req, technicalAdminAuth);
            if (authority === null) return sensitiveGenericAuthFailure(401);
            const result = await eventAdministration.openEventHub({
              eventId,
              gameDayId,
              authority,
            });
            const refreshHeaders: Array<[string, string]> =
              authority.kind === "grant-session" && result.status === "accepted"
                ? [
                    [
                      "set-cookie",
                      eventAdminSessionCookie(
                        authority.sessionBearer,
                        result.value.grantSessionExpiresAtMs,
                      ),
                    ],
                  ]
                : [];
            return sensitiveEventAdministrationResponse(result, 200, refreshHeaders);
          },
        },
        "/api/event-admin/leave": {
          async POST(req: Request) {
            if (eventAdministration === null) return genericAuthFailure(503);
            const sessionBearer = readEventAdminSession(req.headers.get("cookie"));
            if (sessionBearer === null) return genericAuthFailure(401);
            const result = await eventAdministration.leaveEventAdminSession(sessionBearer);
            return sensitiveJson(result, result.status === "updated" ? 200 : 401, [
              ["set-cookie", clearEventAdminSessionCookie()],
            ]);
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
    startupCleanup.add(() => void server?.stop());

    console.log(`Server running at ${server.url}`);
  } catch (error) {
    if (shutdown !== undefined) {
      process.removeListener("SIGTERM", shutdown);
      process.removeListener("SIGINT", shutdown);
    }
    cleanup();
    throw error;
  }
}

if (import.meta.main) void main();

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

export async function createGame(req: Request) {
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

export function readAdHocGame(gameId: string) {
  const game = games.get(gameId);
  return game === undefined ? null : projectGameView(game.state, Date.now());
}

export function applyAdHocCommand(input: {
  gameId: string;
  id: string;
  clientSentAtMs: number;
  command: GameCommand;
}) {
  const managedGame = games.get(input.gameId);
  if (managedGame === undefined) return false;
  applyCommandsToGame({ managedGame, commands: [input] });
  return true;
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

function json(payload: unknown, status = 200, extraHeaders: Iterable<[string, string]> = []) {
  const headers = new Headers(Array.from(extraHeaders));
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(payload), {
    status,
    headers,
  });
}

function sensitiveJson(
  payload: unknown,
  status = 200,
  extraHeaders: Iterable<[string, string]> = [],
) {
  const headers = new Headers(Array.from(extraHeaders));
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  return json(payload, status, headers.entries());
}

async function readJsonRecord(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await req.json();
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

async function readCeremonyBody(
  req: Request,
): Promise<{ challengeId: string; response: unknown } | null> {
  const body = await readJsonRecord(req);
  if (body === null || typeof body.challengeId !== "string" || body.response === undefined) {
    return null;
  }
  return { challengeId: body.challengeId, response: body.response };
}

function requestBinding(req: Request): CeremonyBinding {
  return {
    origin: req.headers.get("origin") ?? "",
    host: req.headers.get("host") ?? "",
  };
}

function requestSource(req: Request, trustProxyHeaders = false) {
  return (
    (trustProxyHeaders ? req.headers.get("x-forwarded-for") : null) ??
    req.headers.get("user-agent") ??
    "unknown"
  );
}

function requireAdminMutation(req: Request, auth: TechnicalAdminAuth): string | null {
  if (!auth.isExpectedBinding(requestBinding(req))) return null;
  const contentType = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return null;
  }
  const token = readTechnicalAdminCookie(req.headers.get("cookie"));
  const csrfToken = req.headers.get("x-technical-admin-csrf");
  if (token === null || csrfToken === null) return null;
  return auth.authenticateSession(token) && auth.verifyCsrf(token, csrfToken) ? token : null;
}

function genericAuthFailure(status: number) {
  return json({ error: "Authentication failed." }, status);
}

function sensitiveGenericAuthFailure(status: number) {
  return sensitiveJson({ error: "Authentication failed." }, status);
}

function authFailureResponse(result: AuthResult<unknown>) {
  if (result.ok) return sensitiveJson(result.value);
  const headers: Array<[string, string]> = [];
  if (result.retryAfterMs !== undefined) {
    headers.push(["retry-after", String(Math.max(1, Math.ceil(result.retryAfterMs / 1_000)))]);
  }
  return sensitiveJson(
    { error: "Authentication failed." },
    result.error === "throttled" ? 429 : 401,
    headers,
  );
}

function requireTechnicalAdminToken(
  req: Request,
  technicalAdminAuth: ReturnType<typeof createTechnicalAdminAuth>,
): TechnicalAdminAuthority | null {
  const token = readTechnicalAdminCookie(req.headers.get("cookie"));
  return token === null ? null : technicalAdminAuth.resolveCurrentAuthority(token);
}

function requireTechnicalAdminMutationToken(
  req: Request,
  technicalAdminAuth: ReturnType<typeof createTechnicalAdminAuth>,
): TechnicalAdminAuthority | null {
  if (!technicalAdminAuth.isExpectedBinding(requestBinding(req))) return null;
  const token = readTechnicalAdminCookie(req.headers.get("cookie"));
  const csrfToken = req.headers.get("x-technical-admin-csrf");
  if (token === null || csrfToken === null) return null;
  if (!technicalAdminAuth.authenticateSession(token)) return null;
  if (!technicalAdminAuth.verifyCsrf(token, csrfToken)) return null;
  return technicalAdminAuth.resolveCurrentAuthority(token);
}

function catalogResponse<T>(result: CatalogOutcome<T>, acceptedStatus = 200) {
  if (result.status === "accepted") return json(result, acceptedStatus);
  if (result.status === "retryable-failure") return json(result, 503);
  const status =
    result.reason === "unauthorized"
      ? 401
      : result.reason === "not-found"
        ? 404
        : result.reason === "invalid-input"
          ? 400
          : 409;
  return json(result, status);
}

function eventAdministrationResponse<T>(
  result: EventAdministrationOutcome<T>,
  acceptedStatus = 200,
  extraHeaders: Iterable<[string, string]> = [],
) {
  if (result.status === "accepted") return json(result, acceptedStatus, extraHeaders);
  if (result.status === "retryable-failure") return json(result, 503, extraHeaders);
  const status = result.reason === "unauthorized" ? 401 : result.reason === "not-found" ? 404 : 400;
  return json(result, status, extraHeaders);
}

function sensitiveEventAdministrationResponse<T>(
  result: EventAdministrationOutcome<T>,
  acceptedStatus = 200,
  extraHeaders: Iterable<[string, string]> = [],
) {
  if (result.status === "accepted") return sensitiveJson(result, acceptedStatus, extraHeaders);
  if (result.status === "retryable-failure") return sensitiveJson(result, 503, extraHeaders);
  return sensitiveJson(
    result,
    result.reason === "unauthorized" ? 401 : result.reason === "not-found" ? 404 : 400,
    extraHeaders,
  );
}

function readTechnicalAdminCookie(header: string | null): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === "__Host-technical-admin" && value.length > 0) return value.join("=");
  }
  return null;
}

function resolveEventAdministrationAuthority(
  req: Request,
  technicalAdminAuth: ReturnType<typeof createTechnicalAdminAuth>,
): EventAdministrationAuthority | null {
  const technicalToken = readTechnicalAdminCookie(req.headers.get("cookie"));
  const technical =
    technicalToken === null ? null : technicalAdminAuth.resolveCurrentAuthority(technicalToken);
  if (technical !== null) return technical;
  const sessionBearer = readEventAdminSession(req.headers.get("cookie"));
  return sessionBearer === null ? null : { kind: "grant-session", sessionBearer };
}

function readEventAdminContext(header: string | null): string | null {
  return readCookieValue(header, "__Host-event-admin-context");
}

function readEventAdminSession(header: string | null): string | null {
  return readCookieValue(header, "__Host-event-admin-session");
}

function readCookieValue(header: string | null, cookieName: string): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === cookieName && value.length > 0) return value.join("=");
  }
  return null;
}

function eventAdminContextCookie(value: string): string {
  return `__Host-event-admin-context=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

function eventAdminSessionCookie(value: string, expiresAtMs: number | null | undefined): string {
  const maxAgeSeconds =
    expiresAtMs === null || expiresAtMs === undefined
      ? 2_592_000
      : Math.max(0, Math.min(2_592_000, Math.ceil((expiresAtMs - Date.now()) / 1_000)));
  return `__Host-event-admin-session=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

function clearEventAdminSessionCookie(): string {
  return "__Host-event-admin-session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
