import { serve, type ServerWebSocket } from "bun";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import index from "./index.html";
import { readJsonBodyWithinLimit } from "@/lib/http-body";
import { isInternalHealthHost } from "@/lib/internal-health";
import { SHARED_LIMITS } from "@/lib/validation-policy";
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
  createControlScopeResolver,
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
  createAudienceProjection,
  PUBLIC_AUDIENCE_ABSENCE,
  type AudienceProjectionListOutcome,
  type AudienceProjectionReader,
} from "@/lib/audience-projection";
import {
  createEventAdministration,
  type EventAdministration,
  type EventAdministrationAuthority,
  type EventAdministrationMutationOutcome,
  type EventAdministrationOutcome,
  type GrantCodeProjection,
} from "@/lib/event-administration";
import {
  createAdministrativeAuditProjection,
  type AdministrativeAuditProjection,
  type AdministrativeAuditProjectionKind,
} from "@/lib/administrative-audit";
import { createGrantAuthority } from "@/lib/grant-authority";
import { readGrantAuthorityOptions } from "@/lib/grant-runtime";
import { createControlActionCodecRegistry } from "@/lib/event-game-actions";
import { createLiveEventGameIqaInterpreter } from "@/lib/live-event-game-control";
import type {
  TypedGrantMutation,
  TypedGrantReveal,
  TypedGrantRotated,
} from "@/lib/grant-management";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import type { FoundationStorage } from "@/lib/foundation-storage";
import { assertProductionStateBoundary } from "@/lib/runtime-storage-config";
import { createStartupCleanup } from "@/lib/startup-resources";
import { parseGrantKeyRingCli, runGrantKeyRingCli } from "@/lib/grant-key-ring-cli";
import { GrantKeyRingCustodyError } from "@/lib/grant-key-ring-custody";
import {
  createAdHocLiveSessionTracker,
  createAdHocGamesService,
  openSqliteAdHocStore,
  type AdHocGameView,
  type AdHocGamesService,
} from "@/lib/ad-hoc-games";
import { readBuiltRuntimeIdentity, readRunningReleaseIdentity } from "@/lib/release-identity";
import {
  AD_HOC_EVENT_RESERVED_CONNECTION_CAPACITY,
  AD_HOC_EVENT_TOTAL_CONNECTION_CAPACITY,
  AD_HOC_MAX_CONNECTED_CONTROLLERS,
  AD_HOC_MAX_QUEUED_OUTPUT_BYTES,
} from "@/lib/ad-hoc-resource-budgets";

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
      sessionId: string;
    };

type SessionData = {
  id: string;
  cookieHeader: string | null;
  sessionId: string | null;
  subscription: SessionSubscription;
  subscriptionWork: Promise<void>;
  closed: boolean;
};

const sockets = new Set<ServerWebSocket<SessionData>>();
const defaultAdHocService = createAdHocGamesService();
const pendingSocketReservations = new Map<string, ReturnType<typeof setTimeout>>();

const probeInvocation = parseSqliteProbeInvocation(process.argv.slice(1));
const grantKeyRingInvocation = parseGrantKeyRingCli(process.argv.slice(1));

async function main() {
  if (process.argv.includes("--release-runtime-identity")) {
    console.log(JSON.stringify(readBuiltRuntimeIdentity()));
    return;
  }

  if (grantKeyRingInvocation.kind === "invalid") {
    console.error(grantKeyRingInvocation.error);
    process.exitCode = 1;
    return;
  }
  if (grantKeyRingInvocation.kind === "operation") {
    process.exitCode = runGrantKeyRingCli(grantKeyRingInvocation, 0);
    return;
  }
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
  let grantAuthorityOptions: ReturnType<typeof readGrantAuthorityOptions>;
  let server: Bun.Server<SessionData> | undefined;
  let shutdown: (() => void) | undefined;
  const startupCleanup = createStartupCleanup();
  const cleanup = () => startupCleanup.run();

  try {
    const port = Number(process.env.PORT ?? 3000);
    const { technicalAdmin: technicalAdminConfig, storagePaths } = readRuntimeConfig();
    const { environment } = technicalAdminConfig;
    assertProductionStateBoundary(environment, storagePaths);
    grantAuthorityOptions = readGrantAuthorityOptions(environment);
    const adHocDatabasePath =
      process.env.AD_HOC_DATABASE?.trim() ||
      (environment === "production"
        ? "/var/lib/quadball-timer/ad-hoc.sqlite"
        : `data/${environment}/ad-hoc.sqlite`);
    if (
      environment === "production" &&
      adHocDatabasePath !== "/var/lib/quadball-timer/ad-hoc.sqlite"
    ) {
      throw new Error("Production Ad Hoc database must use its canonical path.");
    }
    const adHocEnvironmentIdentity =
      process.env.AD_HOC_ENVIRONMENT_ID?.trim() || `${environment}:${technicalAdminConfig.origin}`;
    let eventCapacitySource = () => 0;
    const adHocService = createAdHocGamesService({
      environmentIdentity: adHocEnvironmentIdentity,
      deferReplayAcknowledgement: true,
      maxConnectedSockets: readRuntimeCapacity(
        process.env.AD_HOC_MAX_CONNECTED_SOCKETS,
        AD_HOC_MAX_CONNECTED_CONTROLLERS,
      ),
      eventCapacity: {
        totalConnections: readRuntimeCapacity(
          process.env.EVENT_TOTAL_CONNECTION_CAPACITY,
          AD_HOC_EVENT_TOTAL_CONNECTION_CAPACITY,
        ),
        reservedConnections: readRuntimeCapacity(
          process.env.EVENT_RESERVED_CONNECTION_CAPACITY,
          AD_HOC_EVENT_RESERVED_CONNECTION_CAPACITY,
        ),
        activeConnections: () => eventCapacitySource(),
      },
      store:
        environment === "test" && !process.env.AD_HOC_DATABASE?.trim()
          ? undefined
          : openSqliteAdHocStore(adHocDatabasePath, adHocEnvironmentIdentity, {
              reconcileConnectionsAtStartup: true,
            }),
    });
    const liveAdHocSessions = createAdHocLiveSessionTracker((identity) =>
      adHocService.setConnection({
        gameId: identity.gameId,
        sessionId: identity.sessionId,
        connected: false,
      }),
    );
    startupCleanup.add(() => adHocService.close());
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
          : openSqliteFoundationStorage(foundationDatabasePath, {
              grantKeyRing: grantAuthorityOptions.keyRing,
            });
      candidateFoundation.setReadinessContext?.({
        actionCodecRegistry: createControlActionCodecRegistry(),
        interpreter: createLiveEventGameIqaInterpreter(),
      });
      const readiness = await candidateFoundation.readiness();
      if ((readiness.evidence?.keys?.missingCount ?? 0) > 0) {
        throw new GrantKeyRingCustodyError("missing-key-version");
      }
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
      if (error instanceof GrantKeyRingCustodyError) throw error;
      eventCatalogStorage = createUnavailableEventCatalogStorage(
        error instanceof Error
          ? `Event catalog foundation storage is unavailable: ${error.message}`
          : "Event catalog foundation storage is unavailable.",
      );
    }

    const eventCatalog = createEventCatalog(eventCatalogStorage, {});
    const audienceProjection = createAudienceProjection(eventCatalogStorage);
    let eventAdministration: EventAdministration | null = null;
    let administrativeAuditProjection: AdministrativeAuditProjection | null = null;
    if (foundationStorage !== undefined) {
      try {
        const grantOptions = {
          ...grantAuthorityOptions,
          controlScopeResolver: createControlScopeResolver(),
        };
        const grantAuthority = createGrantAuthority(foundationStorage, grantOptions);
        eventAdministration = createEventAdministration({
          storage: foundationStorage,
          grants: grantAuthority,
          controlScopeResolver: grantOptions.controlScopeResolver,
        });
        administrativeAuditProjection = createAdministrativeAuditProjection({
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
    const liveEventDatabasePath = storagePaths.eventGameDatabase;
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
    eventCapacitySource = () => liveEventRuntime?.control.activeControllerSessions() ?? 0;
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
        if (token === null) return sensitiveGenericAuthFailure(401);
        if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
        const eventId = new URL(req.url).pathname.split("/").at(-3) ?? "";
        const result = await eventAdministration[operation](eventId, token);
        await liveEventRuntime?.control.reconcileActiveControllerSessions();
        return sensitiveEventAdministrationMutationResponse(
          result as EventAdministrationMutationOutcome<TypedGrantRotated | TypedGrantMutation>,
          token,
        );
      };
    const pitchManagerGrantMutation = async (
      req: Request,
      operation:
        | "revealPitchManagerGrant"
        | "rotatePitchManagerGrant"
        | "disablePitchManagerGrant"
        | "revokePitchManagerGrant"
        | "reactivatePitchManagerGrant",
    ) => {
      if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
      const authority = resolveEventAdministrationAuthority(req, technicalAdminAuth);
      const path = new URL(req.url).pathname.split("/");
      if (authority === null) return sensitiveGenericAuthFailure(401);
      const result =
        operation === "revealPitchManagerGrant"
          ? await eventAdministration.revealPitchManagerGrant(
              path[4] ?? "",
              path[6] ?? "",
              path[8] ?? "",
              authority,
            )
          : operation === "rotatePitchManagerGrant"
            ? await eventAdministration.rotatePitchManagerGrant(
                path[4] ?? "",
                path[6] ?? "",
                path[8] ?? "",
                authority,
              )
            : operation === "disablePitchManagerGrant"
              ? await eventAdministration.disablePitchManagerGrant(
                  path[4] ?? "",
                  path[6] ?? "",
                  path[8] ?? "",
                  authority,
                )
              : operation === "revokePitchManagerGrant"
                ? await eventAdministration.revokePitchManagerGrant(
                    path[4] ?? "",
                    path[6] ?? "",
                    path[8] ?? "",
                    authority,
                  )
                : await eventAdministration.reactivatePitchManagerGrant(
                    path[4] ?? "",
                    path[6] ?? "",
                    path[8] ?? "",
                    authority,
                  );
      if (operation !== "revealPitchManagerGrant") {
        await liveEventRuntime?.control.reconcileActiveControllerSessions();
      }
      return sensitiveEventAdministrationMutationResponse<
        TypedGrantMutation | TypedGrantReveal | TypedGrantRotated
      >(
        result as EventAdministrationMutationOutcome<
          TypedGrantMutation | TypedGrantReveal | TypedGrantRotated
        >,
        authority,
      );
    };
    const controlGrantMutation = async (
      req: Request,
      authorityResolver: (request: Request) => EventAdministrationAuthority | null,
      operation: "reveal" | "rotate" | "revoke-session",
      audience: "event-admin" | "pitch-manager" = "event-admin",
    ) => {
      if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
      const authority = authorityResolver(req);
      const path = new URL(req.url).pathname.split("/");
      if (authority === null) return sensitiveGenericAuthFailure(401);
      const common = [path[4] ?? "", path[6] ?? "", path[8] ?? "", path[10] ?? ""] as const;
      const result =
        operation === "reveal"
          ? await eventAdministration.revealControlGrant(...common, authority)
          : operation === "rotate"
            ? await eventAdministration.rotateControlGrant(...common, authority)
            : await eventAdministration.revokeControlGrantSession(
                ...common,
                (await readJsonRecord(req))?.sessionReference,
                authority,
              );
      if (operation !== "reveal") {
        await liveEventRuntime?.control.reconcileActiveControllerSessions();
      }
      return sensitiveEventAdministrationMutationResponse<
        TypedGrantMutation | TypedGrantReveal | TypedGrantRotated
      >(
        result as EventAdministrationMutationOutcome<
          TypedGrantMutation | TypedGrantReveal | TypedGrantRotated
        >,
        authority,
        200,
        audience,
      );
    };
    const pitchManagerCodeMutation = async (
      req: Request,
      operation: "inspect" | "create" | "replace" | "disable",
    ) => {
      if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
      const authority = resolveEventAdministrationAuthority(req, technicalAdminAuth);
      const path = new URL(req.url).pathname.split("/");
      if (authority === null) return sensitiveGenericAuthFailure(401);
      const common = [path[4] ?? "", path[6] ?? "", path[8] ?? ""] as const;
      const result =
        operation === "inspect"
          ? await eventAdministration.inspectPitchManagerGrantCode(...common, authority)
          : operation === "create"
            ? await eventAdministration.createPitchManagerGrantCode(...common, authority)
            : operation === "replace"
              ? await eventAdministration.replacePitchManagerGrantCode(...common, authority)
              : await eventAdministration.disablePitchManagerGrantCode(...common, authority);
      if (operation === "inspect")
        return sensitiveEventAdministrationResponse(
          result as EventAdministrationOutcome<GrantCodeProjection | null>,
        );
      return sensitiveEventAdministrationMutationResponse(
        result as EventAdministrationMutationOutcome<unknown>,
        authority,
      );
    };
    const controlCodeMutation = async (
      req: Request,
      operation: "inspect" | "create" | "replace" | "disable",
      audience: "event-admin" | "pitch-manager" = "event-admin",
    ) => {
      if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
      const authority =
        audience === "pitch-manager"
          ? resolvePitchManagerAuthority(req, technicalAdminAuth)
          : resolveEventAdministrationAuthority(req, technicalAdminAuth);
      const path = new URL(req.url).pathname.split("/");
      if (authority === null) return sensitiveGenericAuthFailure(401);
      const common = [path[4] ?? "", path[6] ?? "", path[8] ?? "", path[10] ?? ""] as const;
      const result =
        operation === "inspect"
          ? await eventAdministration.inspectControlGrantCode(...common, authority)
          : operation === "create"
            ? await eventAdministration.createControlGrantCode(...common, authority)
            : operation === "replace"
              ? await eventAdministration.replaceControlGrantCode(...common, authority)
              : await eventAdministration.disableControlGrantCode(...common, authority);
      if (operation === "inspect")
        return sensitiveEventAdministrationResponse(
          result as EventAdministrationOutcome<GrantCodeProjection | null>,
        );
      return sensitiveEventAdministrationMutationResponse(
        result as EventAdministrationMutationOutcome<unknown>,
        authority,
        200,
        audience,
      );
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

    const htmlRoute =
      environment === "test" && process.env.NODE_ENV === "production"
        ? await createTestHtmlRoute()
        : index;

    server = serve<SessionData>({
      hostname: process.env.HOST ?? "127.0.0.1",
      port,
      ...(tls ? { tls } : {}),
      routes: {
        "/ws": async (req: Bun.BunRequest<"/ws">, routeServer: Bun.Server<SessionData>) => {
          if (!isAllowedWebSocketOrigin(req.headers.get("origin"), req.headers.get("host"))) {
            return json(
              {
                error: "WebSocket origin not allowed.",
              },
              403,
            );
          }

          const socketId = crypto.randomUUID();
          const totalSocketCapacity = calculateAdHocUpgradeCapacity({
            eventTotalConnections: readRuntimeCapacity(
              process.env.EVENT_TOTAL_CONNECTION_CAPACITY,
              AD_HOC_EVENT_TOTAL_CONNECTION_CAPACITY,
            ),
            eventReservedConnections: readRuntimeCapacity(
              process.env.EVENT_RESERVED_CONNECTION_CAPACITY,
              AD_HOC_EVENT_RESERVED_CONNECTION_CAPACITY,
            ),
            activeEventConnections: eventCapacitySource(),
            adHocSocketCeiling: readRuntimeCapacity(
              process.env.AD_HOC_MAX_CONNECTED_SOCKETS,
              AD_HOC_MAX_CONNECTED_CONTROLLERS,
            ),
          });
          if (sockets.size + pendingSocketReservations.size >= totalSocketCapacity) {
            adHocService.recordResourcePressure("connection-shed");
            return json({ error: "Ad Hoc connection busy.", retryAfterMs: 1_000 }, 503, [
              ["retry-after", "1"],
            ]);
          }
          pendingSocketReservations.set(
            socketId,
            setTimeout(() => releasePendingSocketReservation(socketId), 5_000),
          );
          const upgraded = routeServer.upgrade(req, {
            data: {
              id: socketId,
              cookieHeader: req.headers.get("cookie"),
              sessionId: null,
              subscription: { type: "none" },
              subscriptionWork: Promise.resolve(),
              closed: false,
            },
          });

          if (upgraded) {
            return;
          }
          releasePendingSocketReservation(socketId);

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
            return adHocUnavailableResponse();
          },
          POST(req: Request) {
            return createGame(req, adHocService);
          },
        },
        "/api/audience/events/:eventId": {
          GET(req: Request) {
            return readAudienceEvent(req, audienceProjection);
          },
        },
        "/api/audience/events": {
          GET(req: Request) {
            return readAudienceEvents(req, audienceProjection);
          },
        },
        "/api/games/:gameId": {
          GET(req: Request) {
            return readGame(req, adHocService);
          },
        },
        "/api/games/:gameId/admit": {
          async POST(req: Request) {
            return admitGame(req, adHocService);
          },
        },
        "/api/games/:gameId/leave": {
          POST(req: Request) {
            return leaveGame(req, adHocService);
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
        "/api/admin/events/:eventId/audit": {
          async GET(req: Request) {
            const token = requireTechnicalAdminToken(req, technicalAdminAuth);
            if (token === null) return sensitiveGenericAuthFailure(401);
            if (administrativeAuditProjection === null) return sensitiveGenericAuthFailure(503);
            const eventId = new URL(req.url).pathname.split("/").at(-2) ?? "";
            return administrativeAuditResponse(
              await administrativeAuditProjection.read(
                administrativeAuditQuery(new URL(req.url), eventId, token),
              ),
            );
          },
        },
        "/api/admin/events/:eventId/publication-status": {
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
            const eventId = new URL(req.url).pathname.split("/").at(-2) ?? "";
            return catalogResponse(
              await eventCatalog.changePublicationStatus(
                eventId,
                { status: body.status, impactConfirmed: body.impactConfirmed },
                token,
              ),
            );
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
        "/api/admin/events/:eventId/event-admin-grant/code": {
          async GET(req: Request) {
            const token = requireTechnicalAdminToken(req, technicalAdminAuth);
            if (token === null) return sensitiveGenericAuthFailure(401);
            if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
            const eventId = new URL(req.url).pathname.split("/").at(-3) ?? "";
            return sensitiveEventAdministrationResponse(
              await eventAdministration.inspectEventAdminGrantCode(eventId, token),
            );
          },
          async POST(req: Request) {
            const token = requireTechnicalAdminMutationToken(req, technicalAdminAuth);
            if (token === null) return sensitiveGenericAuthFailure(401);
            if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
            const eventId = new URL(req.url).pathname.split("/").at(-3) ?? "";
            return sensitiveEventAdministrationMutationResponse(
              await eventAdministration.createEventAdminGrantCode(eventId, token),
              token,
            );
          },
        },
        "/api/admin/events/:eventId/event-admin-grant/code/replace": {
          POST: async (req: Request) => {
            const token = requireTechnicalAdminMutationToken(req, technicalAdminAuth);
            if (token === null) return sensitiveGenericAuthFailure(401);
            if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
            const eventId = new URL(req.url).pathname.split("/").at(-4) ?? "";
            return sensitiveEventAdministrationMutationResponse(
              await eventAdministration.replaceEventAdminGrantCode(eventId, token),
              token,
            );
          },
        },
        "/api/admin/events/:eventId/event-admin-grant/code/disable": {
          POST: async (req: Request) => {
            const token = requireTechnicalAdminMutationToken(req, technicalAdminAuth);
            if (token === null) return sensitiveGenericAuthFailure(401);
            if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
            const eventId = new URL(req.url).pathname.split("/").at(-4) ?? "";
            return sensitiveEventAdministrationMutationResponse(
              await eventAdministration.disableEventAdminGrantCode(eventId, token),
              token,
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
            if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
            const body = await readJsonRecord(req);
            if (
              body === null ||
              (typeof body.qrCredential !== "string" && typeof body.grantCode !== "string") ||
              (typeof body.qrCredential === "string" && typeof body.grantCode === "string")
            )
              return sensitiveJson({ error: "Unable to admit this Grant." }, 400);
            const context = readEventAdminContext(req.headers.get("cookie")) ?? crypto.randomUUID();
            const result =
              typeof body.grantCode === "string"
                ? await eventAdministration.admitEventAdminCode({
                    grantCode: body.grantCode,
                    browserContext: context,
                    deviceClass: body.deviceClass,
                    browserClass: body.browserClass,
                  })
                : await eventAdministration.admitEventAdmin({
                    qrCredential: body.qrCredential,
                    browserContext: context,
                    deviceClass: body.deviceClass,
                    browserClass: body.browserClass,
                  });
            if (result.status !== "admitted") return sensitiveJson(result, 401);
            const sessionHeaders: Array<[string, string]> = [
              ["set-cookie", eventAdminContextCookie(context)],
            ];
            if (typeof result.sessionExpiresAtMs === "number")
              sessionHeaders.push([
                "set-cookie",
                eventAdminSessionCookie(result.sessionBearer, result.sessionExpiresAtMs),
              ]);
            return sensitiveJson(
              {
                status: "admitted",
                grantId: result.grantId,
                grantVersion: result.grantVersion,
                grantType: result.grantType,
                scope: result.scope,
                grantSessionId: result.grantSessionId,
                sessionExpiresAtMs: result.sessionExpiresAtMs ?? null,
              },
              200,
              sessionHeaders,
            );
          },
        },
        "/api/event-admin/events/:eventId/game-days/:gameDayId/pitches/:pitchId/pitch-manager-grant":
          {
            async GET(req: Request) {
              if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
              const authority = resolveEventAdministrationAuthority(req, technicalAdminAuth);
              const path = new URL(req.url).pathname.split("/");
              if (authority === null) return sensitiveGenericAuthFailure(401);
              return sensitiveEventAdministrationResponse(
                await eventAdministration.inspectPitchManagerGrant(
                  path.at(-6) ?? "",
                  path.at(-4) ?? "",
                  path.at(-2) ?? "",
                  authority,
                ),
              );
            },
            async POST(req: Request) {
              if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
              const authority = resolveEventAdministrationAuthority(req, technicalAdminAuth);
              const path = new URL(req.url).pathname.split("/");
              if (authority === null) return sensitiveGenericAuthFailure(401);
              return sensitiveEventAdministrationMutationResponse(
                await eventAdministration.createPitchManagerGrant(
                  path.at(-6) ?? "",
                  path.at(-4) ?? "",
                  path.at(-2) ?? "",
                  authority,
                ),
                authority,
                201,
              );
            },
          },
        "/api/event-admin/events/:eventId/game-days/:gameDayId/pitches/:pitchId/pitch-manager-grant/reveal":
          {
            POST: (req: Request) => pitchManagerGrantMutation(req, "revealPitchManagerGrant"),
          },
        "/api/event-admin/events/:eventId/game-days/:gameDayId/pitches/:pitchId/pitch-manager-grant/rotate":
          {
            POST: (req: Request) => pitchManagerGrantMutation(req, "rotatePitchManagerGrant"),
          },
        "/api/event-admin/events/:eventId/game-days/:gameDayId/pitches/:pitchId/pitch-manager-grant/disable":
          {
            POST: (req: Request) => pitchManagerGrantMutation(req, "disablePitchManagerGrant"),
          },
        "/api/event-admin/events/:eventId/game-days/:gameDayId/pitches/:pitchId/pitch-manager-grant/revoke":
          {
            POST: (req: Request) => pitchManagerGrantMutation(req, "revokePitchManagerGrant"),
          },
        "/api/event-admin/events/:eventId/game-days/:gameDayId/pitches/:pitchId/pitch-manager-grant/reactivate":
          {
            POST: (req: Request) => pitchManagerGrantMutation(req, "reactivatePitchManagerGrant"),
          },
        "/api/event-admin/events/:eventId/game-days/:gameDayId/pitches/:pitchId/pitch-manager-grant/code":
          {
            GET: (req: Request) => pitchManagerCodeMutation(req, "inspect"),
            POST: (req: Request) => pitchManagerCodeMutation(req, "create"),
          },
        "/api/event-admin/events/:eventId/game-days/:gameDayId/pitches/:pitchId/pitch-manager-grant/code/replace":
          { POST: (req: Request) => pitchManagerCodeMutation(req, "replace") },
        "/api/event-admin/events/:eventId/game-days/:gameDayId/pitches/:pitchId/pitch-manager-grant/code/disable":
          { POST: (req: Request) => pitchManagerCodeMutation(req, "disable") },
        "/api/event-admin/events/:eventId/game-days/:gameDayId/pitches/:pitchId/pitch-slots/:pitchSlotId/control-grant":
          {
            async GET(req: Request) {
              if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
              const authority = resolveEventAdministrationAuthority(req, technicalAdminAuth);
              const path = new URL(req.url).pathname.split("/");
              if (authority === null) return sensitiveGenericAuthFailure(401);
              return sensitiveEventAdministrationResponse(
                await eventAdministration.inspectControlGrant(
                  path[4] ?? "",
                  path[6] ?? "",
                  path[8] ?? "",
                  path[10] ?? "",
                  authority,
                ),
              );
            },
            async POST(req: Request) {
              if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
              const authority = resolveEventAdministrationAuthority(req, technicalAdminAuth);
              const path = new URL(req.url).pathname.split("/");
              if (authority === null) return sensitiveGenericAuthFailure(401);
              return sensitiveEventAdministrationMutationResponse(
                await eventAdministration.createControlGrant(
                  path[4] ?? "",
                  path[6] ?? "",
                  path[8] ?? "",
                  path[10] ?? "",
                  authority,
                ),
                authority,
                201,
              );
            },
          },
        "/api/event-admin/events/:eventId/game-days/:gameDayId/pitches/:pitchId/pitch-slots/:pitchSlotId/control-grant/reveal":
          {
            POST: (req: Request) =>
              controlGrantMutation(
                req,
                (request) => resolveEventAdministrationAuthority(request, technicalAdminAuth),
                "reveal",
              ),
          },
        "/api/event-admin/events/:eventId/game-days/:gameDayId/pitches/:pitchId/pitch-slots/:pitchSlotId/control-grant/code":
          {
            GET: (req: Request) => controlCodeMutation(req, "inspect"),
            POST: (req: Request) => controlCodeMutation(req, "create"),
          },
        "/api/event-admin/events/:eventId/game-days/:gameDayId/pitches/:pitchId/pitch-slots/:pitchSlotId/control-grant/code/replace":
          { POST: (req: Request) => controlCodeMutation(req, "replace") },
        "/api/event-admin/events/:eventId/game-days/:gameDayId/pitches/:pitchId/pitch-slots/:pitchSlotId/control-grant/code/disable":
          { POST: (req: Request) => controlCodeMutation(req, "disable") },
        "/api/event-admin/events/:eventId/game-days/:gameDayId/pitches/:pitchId/pitch-slots/:pitchSlotId/control-grant/rotate":
          {
            POST: (req: Request) =>
              controlGrantMutation(
                req,
                (request) => resolveEventAdministrationAuthority(request, technicalAdminAuth),
                "rotate",
              ),
          },
        "/api/event-admin/events/:eventId/game-days/:gameDayId/pitches/:pitchId/pitch-slots/:pitchSlotId/control-grant/sessions":
          {
            async GET(req: Request) {
              if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
              const authority = resolveEventAdministrationAuthority(req, technicalAdminAuth);
              const path = new URL(req.url).pathname.split("/");
              if (authority === null) return sensitiveGenericAuthFailure(401);
              return sensitiveEventAdministrationResponse(
                await eventAdministration.listControlGrantSessions(
                  path[4] ?? "",
                  path[6] ?? "",
                  path[8] ?? "",
                  path[10] ?? "",
                  authority,
                ),
              );
            },
          },
        "/api/event-admin/events/:eventId/game-days/:gameDayId/pitches/:pitchId/pitch-slots/:pitchSlotId/control-grant/sessions/revoke":
          {
            POST: (req: Request) =>
              controlGrantMutation(
                req,
                (request) => resolveEventAdministrationAuthority(request, technicalAdminAuth),
                "revoke-session",
              ),
          },
        "/api/pitch-manager/admit": {
          async POST(req: Request) {
            if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
            const body = await readJsonRecord(req);
            if (
              body === null ||
              (typeof body.qrCredential !== "string" && typeof body.grantCode !== "string") ||
              (typeof body.qrCredential === "string" && typeof body.grantCode === "string")
            )
              return sensitiveJson({ error: "Unable to admit this Grant." }, 400);
            const context =
              readPitchManagerContext(req.headers.get("cookie")) ?? crypto.randomUUID();
            const result =
              typeof body.grantCode === "string"
                ? await eventAdministration.admitPitchManagerCode({
                    grantCode: body.grantCode,
                    browserContext: context,
                    deviceClass: body.deviceClass,
                    browserClass: body.browserClass,
                  })
                : await eventAdministration.admitPitchManager({
                    qrCredential: body.qrCredential,
                    browserContext: context,
                    deviceClass: body.deviceClass,
                    browserClass: body.browserClass,
                  });
            if (result.status !== "admitted") return sensitiveJson(result, 401);
            const sessionHeaders: Array<[string, string]> = [
              ["set-cookie", pitchManagerContextCookie(context)],
            ];
            if (typeof result.sessionExpiresAtMs === "number")
              sessionHeaders.push([
                "set-cookie",
                pitchManagerSessionCookie(result.sessionBearer, result.sessionExpiresAtMs),
              ]);
            return sensitiveJson(
              {
                status: "admitted",
                grantId: result.grantId,
                grantVersion: result.grantVersion,
                grantType: result.grantType,
                scope: result.scope,
                grantSessionId: result.grantSessionId,
                sessionExpiresAtMs: result.sessionExpiresAtMs ?? null,
              },
              200,
              sessionHeaders,
            );
          },
        },
        "/api/pitch-manager/view": {
          async GET(req: Request) {
            if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
            const url = new URL(req.url);
            const authority = resolvePitchManagerAuthority(req, technicalAdminAuth);
            if (authority === null) return sensitiveGenericAuthFailure(401);
            return sensitiveEventAdministrationResponse(
              await eventAdministration.openPitchManagerView({
                eventId: url.searchParams.get("eventId") ?? "",
                gameDayId: url.searchParams.get("gameDayId") ?? "",
                pitchId: url.searchParams.get("pitchId") ?? "",
                authority,
              }),
            );
          },
        },
        "/api/pitch-manager/current": {
          async GET(req: Request) {
            if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
            const sessionBearer = readPitchManagerSession(req.headers.get("cookie"));
            if (sessionBearer === null) return sensitiveGenericAuthFailure(401);
            return sensitiveEventAdministrationResponse(
              await eventAdministration.openPitchManagerCurrentView({
                authority: { kind: "grant-session", sessionBearer },
              }),
            );
          },
        },
        "/api/pitch-manager/events/:eventId/game-days/:gameDayId/pitches/:pitchId/pitch-slots/:pitchSlotId/control-grant":
          {
            async GET(req: Request) {
              if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
              const authority = resolvePitchManagerAuthority(req, technicalAdminAuth);
              const path = new URL(req.url).pathname.split("/");
              if (authority === null) return sensitiveGenericAuthFailure(401);
              return sensitiveEventAdministrationResponse(
                await eventAdministration.inspectControlGrant(
                  path[4] ?? "",
                  path[6] ?? "",
                  path[8] ?? "",
                  path[10] ?? "",
                  authority,
                ),
              );
            },
            async POST(req: Request) {
              if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
              const authority = resolvePitchManagerAuthority(req, technicalAdminAuth);
              const path = new URL(req.url).pathname.split("/");
              if (authority === null) return sensitiveGenericAuthFailure(401);
              return sensitiveEventAdministrationMutationResponse(
                await eventAdministration.createControlGrant(
                  path[4] ?? "",
                  path[6] ?? "",
                  path[8] ?? "",
                  path[10] ?? "",
                  authority,
                ),
                authority,
                201,
                "pitch-manager",
              );
            },
          },
        "/api/pitch-manager/events/:eventId/game-days/:gameDayId/pitches/:pitchId/pitch-slots/:pitchSlotId/control-grant/reveal":
          {
            POST: (req: Request) =>
              controlGrantMutation(
                req,
                (request) => resolvePitchManagerAuthority(request, technicalAdminAuth),
                "reveal",
                "pitch-manager",
              ),
          },
        "/api/pitch-manager/events/:eventId/game-days/:gameDayId/pitches/:pitchId/pitch-slots/:pitchSlotId/control-grant/rotate":
          {
            POST: (req: Request) =>
              controlGrantMutation(
                req,
                (request) => resolvePitchManagerAuthority(request, technicalAdminAuth),
                "rotate",
                "pitch-manager",
              ),
          },
        "/api/pitch-manager/events/:eventId/game-days/:gameDayId/pitches/:pitchId/pitch-slots/:pitchSlotId/control-grant/sessions":
          {
            async GET(req: Request) {
              if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
              const authority = resolvePitchManagerAuthority(req, technicalAdminAuth);
              const path = new URL(req.url).pathname.split("/");
              if (authority === null) return sensitiveGenericAuthFailure(401);
              return sensitiveEventAdministrationResponse(
                await eventAdministration.listControlGrantSessions(
                  path[4] ?? "",
                  path[6] ?? "",
                  path[8] ?? "",
                  path[10] ?? "",
                  authority,
                ),
              );
            },
          },
        "/api/pitch-manager/events/:eventId/game-days/:gameDayId/pitches/:pitchId/pitch-slots/:pitchSlotId/control-grant/sessions/revoke":
          {
            POST: (req: Request) =>
              controlGrantMutation(
                req,
                (request) => resolvePitchManagerAuthority(request, technicalAdminAuth),
                "revoke-session",
                "pitch-manager",
              ),
          },
        "/api/pitch-manager/leave": {
          async POST(req: Request) {
            if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
            const sessionBearer = readPitchManagerSession(req.headers.get("cookie"));
            if (sessionBearer === null) return sensitiveGenericAuthFailure(401);
            const result = await eventAdministration.leavePitchManagerSession(sessionBearer);
            return sensitiveJson(result, result.status === "updated" ? 200 : 401, [
              ["set-cookie", clearPitchManagerSessionCookie()],
            ]);
          },
        },
        "/api/pitch-manager/events/:eventId/game-days/:gameDayId/pitches/:pitchId/pitch-slots/:pitchSlotId/control-grant/code":
          {
            GET: (req: Request) => controlCodeMutation(req, "inspect", "pitch-manager"),
            POST: (req: Request) => controlCodeMutation(req, "create", "pitch-manager"),
          },
        "/api/pitch-manager/events/:eventId/game-days/:gameDayId/pitches/:pitchId/pitch-slots/:pitchSlotId/control-grant/code/replace":
          {
            POST: (req: Request) => controlCodeMutation(req, "replace", "pitch-manager"),
          },
        "/api/pitch-manager/events/:eventId/game-days/:gameDayId/pitches/:pitchId/pitch-slots/:pitchSlotId/control-grant/code/disable":
          {
            POST: (req: Request) => controlCodeMutation(req, "disable", "pitch-manager"),
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
            return sensitiveEventAdministrationResponse(result);
          },
        },
        "/api/event-admin/audit": {
          async GET(req: Request) {
            if (administrativeAuditProjection === null) return sensitiveGenericAuthFailure(503);
            const authority = resolveEventAdministrationAuthority(req, technicalAdminAuth);
            if (authority === null) return sensitiveGenericAuthFailure(401);
            const url = new URL(req.url);
            return administrativeAuditResponse(
              await administrativeAuditProjection.read(
                administrativeAuditQuery(url, url.searchParams.get("eventId") ?? "", authority),
              ),
            );
          },
        },
        "/api/event-admin/catalog": {
          async GET(req: Request) {
            if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
            const url = new URL(req.url);
            const eventId = url.searchParams.get("eventId") ?? "";
            const authority = resolveEventAdministrationAuthority(req, technicalAdminAuth);
            if (authority === null) return sensitiveGenericAuthFailure(401);
            const result = await eventAdministration.openEventHub({
              eventId,
              gameDayId: url.searchParams.get("gameDayId") ?? undefined,
              authority,
            });
            return sensitiveEventAdministrationResponse(result);
          },
        },
        "/api/event-admin/events/:eventId/publication-status": {
          async POST(req: Request) {
            if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
            const authority = resolveEventAdministrationAuthority(req, technicalAdminAuth);
            const body = await readJsonRecord(req);
            const eventId = new URL(req.url).pathname.split("/").at(-2) ?? "";
            if (authority === null || body === null) return sensitiveGenericAuthFailure(401);
            return sensitiveEventAdministrationMutationResponse(
              await eventAdministration.changePublicationStatus(
                eventId,
                { status: body.status, impactConfirmed: body.impactConfirmed },
                authority,
              ),
              authority,
            );
          },
        },
        "/api/event-admin/events/:eventId/teams": {
          async POST(req: Request) {
            if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
            const authority = resolveEventAdministrationAuthority(req, technicalAdminAuth);
            const body = await readJsonRecord(req);
            const eventId = new URL(req.url).pathname.split("/").at(-2) ?? "";
            if (authority === null || body === null) return sensitiveGenericAuthFailure(401);
            return sensitiveEventAdministrationMutationResponse(
              await eventAdministration.createEventTeam(
                eventId,
                { name: body.name, defaultColor: body.defaultColor },
                authority,
              ),
              authority,
              201,
            );
          },
        },
        "/api/event-admin/events/:eventId/teams/:eventTeamId": {
          async PATCH(req: Request) {
            if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
            const authority = resolveEventAdministrationAuthority(req, technicalAdminAuth);
            const body = await readJsonRecord(req);
            const path = new URL(req.url).pathname.split("/");
            if (authority === null || body === null) return sensitiveGenericAuthFailure(401);
            return sensitiveEventAdministrationMutationResponse(
              await eventAdministration.updateEventTeam(
                path.at(-3) ?? "",
                path.at(-1) ?? "",
                body,
                authority,
              ),
              authority,
            );
          },
        },
        "/api/event-admin/events/:eventId/teams/:eventTeamId/roster": {
          async PUT(req: Request) {
            if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
            const authority = resolveEventAdministrationAuthority(req, technicalAdminAuth);
            const body = await readJsonRecord(req);
            const path = new URL(req.url).pathname.split("/");
            if (authority === null || body === null) return sensitiveGenericAuthFailure(401);
            return sensitiveEventAdministrationMutationResponse(
              await eventAdministration.upsertEventTeamRoster(
                path.at(-4) ?? "",
                path.at(-2) ?? "",
                { playerNumber: body.playerNumber, publicName: body.publicName },
                authority,
              ),
              authority,
            );
          },
        },
        "/api/event-admin/events/:eventId/pitches": {
          async POST(req: Request) {
            if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
            const authority = resolveEventAdministrationAuthority(req, technicalAdminAuth);
            const body = await readJsonRecord(req);
            const eventId = new URL(req.url).pathname.split("/").at(-2) ?? "";
            if (authority === null || body === null) return sensitiveGenericAuthFailure(401);
            return sensitiveEventAdministrationMutationResponse(
              await eventAdministration.createPitch(eventId, { name: body.name }, authority),
              authority,
              201,
            );
          },
        },
        "/api/event-admin/events/:eventId/pitches/:pitchId": {
          async PATCH(req: Request) {
            if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
            const authority = resolveEventAdministrationAuthority(req, technicalAdminAuth);
            const body = await readJsonRecord(req);
            const path = new URL(req.url).pathname.split("/");
            if (authority === null || body === null) return sensitiveGenericAuthFailure(401);
            return sensitiveEventAdministrationMutationResponse(
              await eventAdministration.updatePitch(
                path.at(-3) ?? "",
                path.at(-1) ?? "",
                { name: body.name },
                authority,
              ),
              authority,
            );
          },
        },
        "/api/event-admin/events/:eventId/game-days/:gameDayId/gameplay-slots": {
          async POST(req: Request) {
            if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
            const authority = resolveEventAdministrationAuthority(req, technicalAdminAuth);
            const body = await readJsonRecord(req);
            const path = new URL(req.url).pathname.split("/");
            if (authority === null || body === null) return sensitiveGenericAuthFailure(401);
            return sensitiveEventAdministrationMutationResponse(
              await eventAdministration.createGameplaySlot(
                path.at(-4) ?? "",
                path.at(-2) ?? "",
                {
                  sequence: body.sequence,
                  scheduledStart: body.scheduledStart ?? body.scheduledStartMs,
                },
                authority,
              ),
              authority,
              201,
            );
          },
        },
        "/api/event-admin/events/:eventId/game-days/:gameDayId/event-games": {
          async POST(req: Request) {
            if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
            const authority = resolveEventAdministrationAuthority(req, technicalAdminAuth);
            const body = await readJsonRecord(req);
            const path = new URL(req.url).pathname.split("/");
            if (authority === null || body === null) return sensitiveGenericAuthFailure(401);
            return sensitiveEventAdministrationMutationResponse(
              await eventAdministration.createEventGame(
                path.at(-4) ?? "",
                path.at(-2) ?? "",
                {
                  gameplaySlotId: body.gameplaySlotId,
                  pitchSlotId: body.pitchSlotId,
                  gameCode: body.gameCode,
                  gameDesignation: body.gameDesignation,
                  sideA: body.sideA,
                  sideB: body.sideB,
                },
                authority,
              ),
              authority,
              201,
            );
          },
        },
        "/api/event-admin/events/:eventId/game-days/:gameDayId/gameplay-slots/:gameplaySlotId/confirm-teams":
          {
            async POST(req: Request) {
              if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
              const authority = resolveEventAdministrationAuthority(req, technicalAdminAuth);
              const body = await readJsonRecord(req);
              const path = new URL(req.url).pathname.split("/");
              if (authority === null || body === null) return sensitiveGenericAuthFailure(401);
              return sensitiveEventAdministrationMutationResponse(
                await eventAdministration.confirmGameplaySlotTeams(
                  path.at(-6) ?? "",
                  path.at(-4) ?? "",
                  path.at(-2) ?? "",
                  { games: body.games },
                  authority,
                ),
                authority,
              );
            },
          },
        "/api/event-admin/events/:eventId/game-days/:gameDayId/gameplay-slots/:gameplaySlotId/expected-delay":
          {
            async POST(req: Request) {
              if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
              const authority = resolveEventAdministrationAuthority(req, technicalAdminAuth);
              const body = await readJsonRecord(req);
              const path = new URL(req.url).pathname.split("/");
              if (authority === null || body === null) return sensitiveGenericAuthFailure(401);
              return sensitiveEventAdministrationMutationResponse(
                await eventAdministration.setGameplaySlotExpectedDelay(
                  path.at(-6) ?? "",
                  path.at(-4) ?? "",
                  path.at(-2) ?? "",
                  { expectedDelayMs: body.expectedDelayMs, cascade: body.cascade },
                  authority,
                ),
                authority,
              );
            },
          },
        "/api/event-admin/events/:eventId/game-days/:gameDayId/gameplay-slots/:gameplaySlotId/expected-delay/preview":
          {
            async POST(req: Request) {
              if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
              const authority = resolveEventAdministrationAuthority(req, technicalAdminAuth);
              const body = await readJsonRecord(req);
              const path = new URL(req.url).pathname.split("/");
              if (authority === null || body === null) return sensitiveGenericAuthFailure(401);
              return sensitiveEventAdministrationResponse(
                await eventAdministration.previewGameplaySlotExpectedDelay(
                  path.at(-7) ?? "",
                  path.at(-5) ?? "",
                  path.at(-3) ?? "",
                  { expectedDelayMs: body.expectedDelayMs, cascade: body.cascade },
                  authority,
                ),
              );
            },
          },
        "/api/event-admin/events/:eventId/game-days/:gameDayId/pitch-slots/:pitchSlotId/expected-delay":
          {
            async POST(req: Request) {
              if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
              const authority = resolveEventAdministrationAuthority(req, technicalAdminAuth);
              const body = await readJsonRecord(req);
              const path = new URL(req.url).pathname.split("/");
              if (authority === null || body === null) return sensitiveGenericAuthFailure(401);
              return sensitiveEventAdministrationMutationResponse(
                await eventAdministration.setPitchSlotExpectedDelay(
                  path.at(-6) ?? "",
                  path.at(-4) ?? "",
                  path.at(-2) ?? "",
                  { expectedDelayMs: body.expectedDelayMs, cascade: body.cascade },
                  authority,
                ),
                authority,
              );
            },
          },
        "/api/event-admin/events/:eventId/game-days/:gameDayId/pitch-slots/:pitchSlotId/expected-delay/preview":
          {
            async POST(req: Request) {
              if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
              const authority = resolveEventAdministrationAuthority(req, technicalAdminAuth);
              const body = await readJsonRecord(req);
              const path = new URL(req.url).pathname.split("/");
              if (authority === null || body === null) return sensitiveGenericAuthFailure(401);
              return sensitiveEventAdministrationResponse(
                await eventAdministration.previewPitchSlotExpectedDelay(
                  path.at(-7) ?? "",
                  path.at(-5) ?? "",
                  path.at(-3) ?? "",
                  { expectedDelayMs: body.expectedDelayMs, cascade: body.cascade },
                  authority,
                ),
              );
            },
          },
        "/api/event-admin/events/:eventId/game-days/:gameDayId/event-games/:eventGameId/reassign": {
          async POST(req: Request) {
            if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
            const authority = resolveEventAdministrationAuthority(req, technicalAdminAuth);
            const body = await readJsonRecord(req);
            const path = new URL(req.url).pathname.split("/");
            if (authority === null || body === null) return sensitiveGenericAuthFailure(401);
            return sensitiveEventAdministrationMutationResponse(
              await eventAdministration.reassignEventGame(
                path.at(-6) ?? "",
                path.at(-4) ?? "",
                path.at(-2) ?? "",
                { targetPitchSlotId: body.targetPitchSlotId, mode: body.mode },
                authority,
              ),
              authority,
            );
          },
        },
        "/api/event-admin/slot-setup": {
          async GET(req: Request) {
            if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
            const url = new URL(req.url);
            const authority = resolveEventAdministrationAuthority(req, technicalAdminAuth);
            if (authority === null) return sensitiveGenericAuthFailure(401);
            return sensitiveEventAdministrationResponse(
              await eventAdministration.openSlotSetup(
                url.searchParams.get("eventId") ?? "",
                url.searchParams.get("gameDayId") ?? "",
                authority,
              ),
            );
          },
        },
        "/api/event-admin/pitch-view": {
          async GET(req: Request) {
            if (eventAdministration === null) return sensitiveGenericAuthFailure(503);
            const url = new URL(req.url);
            const authority = resolveEventAdministrationAuthority(req, technicalAdminAuth);
            if (authority === null) return sensitiveGenericAuthFailure(401);
            return sensitiveEventAdministrationResponse(
              await eventAdministration.openPitchView(
                url.searchParams.get("eventId") ?? "",
                url.searchParams.get("gameDayId") ?? "",
                url.searchParams.get("pitchId") ?? "",
                authority,
              ),
            );
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
        "/internal/release": {
          async GET(req: Request) {
            if (!isInternalHealthHost(req.headers.get("host"))) {
              return json({ error: "Not found." }, 404);
            }

            try {
              const identity = await readRunningReleaseIdentity();
              return json({
                releaseAttemptId: identity.releaseAttemptId,
                sourceCommit: identity.sourceCommit,
                workflowRunId: identity.workflowRunId,
                workflowAttempt: identity.workflowAttempt,
                executableSha256: identity.executableSha256,
                runningExecutableSha256: identity.runningExecutableSha256,
                bunVersion: identity.bunVersion,
                bunRevision: identity.bunRevision,
                sqliteVersion: identity.sqliteVersion,
                schemaCompatibility: identity.schemaCompatibility,
              });
            } catch {
              return json({ error: "Release identity unavailable." }, 503);
            }
          },
        },
        "/game/:gameId": htmlRoute,
        "/": htmlRoute,
        "/events/:eventId": {
          async GET(req: Request, routeServer: Bun.Server<SessionData>) {
            return readPublicAudienceEventPage(req, audienceProjection, () =>
              fetch(new URL("/", routeServer.url)),
            );
          },
        },
        "/sitemap.xml": {
          GET(req: Request) {
            return readAudienceSitemap(req, audienceProjection);
          },
        },
        "/robots.txt": {
          GET(req: Request) {
            return audienceRobotsResponse(req);
          },
        },
        "/events": htmlRoute,
        "/events/": htmlRoute,
        "/admin": htmlRoute,
        "/admin/": htmlRoute,
        "/admin/enroll": htmlRoute,
        "/admin/enroll/": htmlRoute,
        "/color-test": htmlRoute,
        "/prototype/event-operations": htmlRoute,
        "/event-admin": htmlRoute,
        "/event-admin/": htmlRoute,
        "/pitch-manager": htmlRoute,
        "/pitch-manager/": htmlRoute,
        "/event-control": htmlRoute,
        "/event-control/": htmlRoute,
        "/game": () => adHocUnavailableResponse(),
        "/game/*": () => adHocUnavailableResponse(),
        "/api/games/*": () => adHocUnavailableResponse(),
        "/*": htmlRoute,
      },
      development: process.env.NODE_ENV !== "production" &&
        process.env.NODE_ENV !== "test" && {
          hmr: true,
          console: true,
        },
      websocket: {
        backpressureLimit: AD_HOC_MAX_QUEUED_OUTPUT_BYTES,
        closeOnBackpressureLimit: true,
        open(ws) {
          releasePendingSocketReservation(ws.data.id);
          sockets.add(ws);
        },
        close(ws) {
          releasePendingSocketReservation(ws.data.id);
          sockets.delete(ws);
          ws.data.closed = true;
          void ws.data.subscriptionWork
            .then(
              () => liveAdHocSessions.disconnect(ws.data.id),
              () => liveAdHocSessions.disconnect(ws.data.id),
            )
            .then((durable) => {
              if (!durable) void liveAdHocSessions.retryPending();
            })
            .catch(() => undefined);
        },
        async message(ws, message) {
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
              sendMessage(ws, { type: "error", message: adHocService.genericUnavailableMessage });
              ws.close(1008, "Ad Hoc subscription unavailable.");
              return;
            }

            case "subscribe-game": {
              const subscribeGameId = parsed.message.gameId;
              const handleSubscription = async () => {
                const result = await resolveAdHocWebSocketSubscription({
                  service: adHocService,
                  cookieHeader: ws.data.cookieHeader,
                  gameId: subscribeGameId,
                });
                if (result.status === "capacity") {
                  if (!ws.data.closed) {
                    adHocService.recordResourcePressure("connection-shed");
                    sendMessage(ws, {
                      type: "error",
                      message: "Ad Hoc connection busy. Try again later.",
                      retryAfterMs: result.retryAfterMs,
                    });
                    setTimeout(() => ws.close(1013, "Ad Hoc connection busy."), 25);
                  }
                  return;
                }
                if (result.status !== "accepted") {
                  if (!ws.data.closed) {
                    sendMessage(ws, {
                      type: "error",
                      message: adHocService.genericUnavailableMessage,
                    });
                    ws.close(1008, "Ad Hoc subscription unavailable.");
                  }
                  return;
                }
                const identity = {
                  gameId: subscribeGameId,
                  sessionId: result.sessionId,
                };
                const tracking = await liveAdHocSessions.subscribe(ws.data.id, {
                  ...identity,
                });
                if (!tracking.attached) {
                  if (liveAdHocSessions.count(identity) === 0) {
                    await adHocService.setConnection({ ...identity, connected: false });
                  }
                  if (!ws.data.closed) {
                    sendMessage(ws, {
                      type: "error",
                      message: adHocService.genericUnavailableMessage,
                    });
                    ws.close(1008, "Ad Hoc subscription unavailable.");
                  }
                  return;
                }
                ws.data.sessionId = result.sessionId;
                ws.data.subscription = {
                  type: "game",
                  gameId: subscribeGameId,
                  sessionId: result.sessionId,
                };
                if (!ws.data.closed) {
                  sendMessage(ws, {
                    type: "game-snapshot",
                    game: stripSession(result.game),
                    serverNowMs: Date.now(),
                    ackedCommandIds: [],
                  });
                }
                if (!tracking.previousDisconnectDurable) void liveAdHocSessions.retryPending();
              };
              const queued = ws.data.subscriptionWork.then(handleSubscription, handleSubscription);
              ws.data.subscriptionWork = queued.catch(() => undefined);
              await queued;
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

              if (ws.data.subscription.gameId !== parsed.message.gameId) {
                sendMessage(ws, {
                  type: "error",
                  message: "Command gameId mismatch.",
                });
                return;
              }

              const result = await adHocService.apply({
                gameId: parsed.message.gameId,
                sessionId: ws.data.subscription.sessionId,
                operations: parsed.message.commands,
              });
              if (result.status === "rejected") {
                if (result.outcomes !== undefined) {
                  await broadcastGameSnapshot({
                    gameId: parsed.message.gameId,
                    service: adHocService,
                    sender: ws,
                    senderAckedCommandIds: [],
                    operationOutcomes: result.outcomes,
                  });
                }
                sendMessage(ws, {
                  type: "error",
                  message:
                    result.reason === "unavailable"
                      ? adHocService.genericUnavailableMessage
                      : result.reason === "rate-limited"
                        ? "Ad Hoc operation busy. Try again later."
                        : "Ad Hoc operation rejected.",
                  ...(result.retryAfterMs === undefined
                    ? {}
                    : { retryAfterMs: Math.min(30_000, Math.max(1, result.retryAfterMs)) }),
                });
                return;
              }
              const delivered = await broadcastGameSnapshot({
                gameId: parsed.message.gameId,
                service: adHocService,
                sender: ws,
                senderAckedCommandIds: result.ackedOperationIds,
                operationOutcomes: result.outcomes,
              });
              if (result.replayId !== undefined) {
                await adHocService.acknowledgeReplay({
                  sessionId: ws.data.subscription.sessionId,
                  replayId: result.replayId,
                  delivered,
                });
              }
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

async function createTestHtmlRoute() {
  const html = await Bun.file(index.index)
    .text()
    .catch(() => null);
  if (html === null) {
    throw new Error("Test HTML presentation bundle is unavailable.");
  }

  const body = html
    .replace(
      "</head>",
      '<meta name="robots" content="noindex, nofollow, noarchive, noimageindex" /></head>',
    )
    .replace(
      "<body>",
      '<body><div class="test-environment-banner">Test environment — not for live games</div>',
    );
  const headers = {
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
    "x-robots-tag": "noindex, nofollow, noarchive, noimageindex",
  };
  const assetDirectory = dirname(index.index);
  const assetPaths = new Map<string, string>();
  for (const match of html.matchAll(/(?:href|src)="\.\/([a-zA-Z0-9._-]+)"/gu)) {
    const assetName = match[1];
    if (assetName !== undefined)
      assetPaths.set(`/${assetName}`, resolve(assetDirectory, assetName));
  }

  return (req: Request) => {
    const assetPath = assetPaths.get(new URL(req.url).pathname);
    return assetPath === undefined
      ? new Response(body, { headers })
      : new Response(Bun.file(assetPath), {
          headers: { "cache-control": "no-store", "x-robots-tag": headers["x-robots-tag"] },
        });
  };
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

export async function createGame(
  req: Request,
  service: AdHocGamesService = defaultAdHocService,
  sourceKey?: string,
) {
  const body = await readJsonBodyWithinLimit(req, SHARED_LIMITS.transport.httpJsonBodyBytes);
  if (!body.ok) {
    return json({ error: body.error }, body.status);
  }

  if (!isRecord(body.body)) {
    return json({ error: "JSON body must be an object." }, 400);
  }

  const payload = body.body;
  const existingSource = readAdHocSource(req.headers.get("cookie"));
  const effectiveSource = sourceKey ?? existingSource ?? randomBytes(32).toString("base64url");
  const sourceCookie =
    sourceKey === undefined && existingSource === null ? adHocSourceCookie(effectiveSource) : null;
  const result = await service.create({
    homeName: payload.homeName === undefined ? "Home" : payload.homeName,
    awayName: payload.awayName === undefined ? "Away" : payload.awayName,
    homeColor: payload.homeColor,
    awayColor: payload.awayColor,
    browserId: payload.browserId,
    sourceKey: effectiveSource,
  });
  if (result.status !== "accepted") {
    const status =
      result.reason === "invalid-input" ? 400 : result.reason === "unavailable" ? 503 : 429;
    const headers: Array<[string, string]> = [];
    if (result.retryAfterMs !== undefined)
      headers.push(["retry-after", String(Math.max(1, Math.ceil(result.retryAfterMs / 1_000)))]);
    if (sourceCookie !== null) headers.push(["set-cookie", sourceCookie]);
    return sensitiveJson(
      {
        error: result.detail ?? "Unable to create an Ad Hoc Game.",
        retryAfterMs: result.retryAfterMs,
      },
      status,
      headers,
    );
  }
  return sensitiveJson(
    { gameId: result.gameId, controlQr: result.controlQr, game: stripSession(result.game) },
    201,
    [
      ["set-cookie", adHocSessionCookie(result.gameId, result.sessionId)],
      ...(sourceCookie === null ? [] : [["set-cookie", sourceCookie] as [string, string]]),
    ],
  );
}

export async function admitGame(req: Request, service: AdHocGamesService = defaultAdHocService) {
  const gameId = new URL(req.url).pathname.split("/").at(-2) ?? "";
  const body = await readJsonRecord(req);
  const priorSessionId = readAdHocSession(req.headers.get("cookie"), gameId);
  const result = await service.admit({
    gameId,
    controlQr: body?.controlQr,
    browserId: body?.browserId,
    priorSessionId,
  });
  return result.status === "accepted"
    ? sensitiveJson({ game: stripSession(result.game) }, 200, [
        ["set-cookie", adHocSessionCookie(gameId, result.game.sessionId)],
      ])
    : adHocUnavailableResponse(service);
}

export async function readGame(req: Request, service: AdHocGamesService = defaultAdHocService) {
  const gameId = new URL(req.url).pathname.replace("/api/games/", "");
  const sessionId = readAdHocSession(req.headers.get("cookie"), gameId);
  const result = await service.read({ gameId, sessionId });
  return result.status === "accepted"
    ? sensitiveJson({ game: stripSession(result.game) })
    : adHocUnavailableResponse(service);
}

export async function readAudienceEvent(
  req: Request,
  projection: Pick<AudienceProjectionReader, "read">,
): Promise<Response> {
  const eventId = readPathSegment(req.url);
  const result = await projection.read(eventId);
  if (result.status === "accepted") return sensitiveJson(result);
  return publicAudienceUnavailableResponse();
}

export async function readPublicAudienceEventPage(
  req: Request,
  projection: Pick<AudienceProjectionReader, "read">,
  readIndex: () => Response | Promise<Response>,
): Promise<Response> {
  const result = await projection.read(readPathSegment(req.url));
  const response = await readIndex();
  if (result.status !== "accepted") response.headers.set("x-robots-tag", "noindex");
  return response;
}

export async function readAudienceEvents(
  _req: Request,
  projection: Pick<AudienceProjectionReader, "list">,
): Promise<Response> {
  const result = await projection.list();
  if (result.status === "accepted") return sensitiveJson(result);
  return publicAudienceUnavailableResponse();
}

export async function readAudienceSitemap(
  req: Request,
  projection: Pick<AudienceProjectionReader, "list">,
): Promise<Response> {
  const result = await projection.list();
  if (result.status !== "accepted") return publicAudienceUnavailableResponse();
  return new Response(renderAudienceSitemap(new URL(req.url), result), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/xml; charset=utf-8",
      "referrer-policy": "no-referrer",
    },
  });
}

export async function leaveGame(req: Request, service: AdHocGamesService = defaultAdHocService) {
  const gameId = new URL(req.url).pathname.split("/").at(-2) ?? "";
  const sessionId = readAdHocSession(req.headers.get("cookie"), gameId);
  const left = await service.leave({ gameId, sessionId });
  return left
    ? sensitiveJson({ left: true }, 200, [["set-cookie", clearAdHocSessionCookie(gameId)]])
    : adHocUnavailableResponse(service);
}

export async function resolveAdHocWebSocketSubscription({
  service,
  cookieHeader,
  gameId,
}: {
  service: AdHocGamesService;
  cookieHeader: string | null;
  gameId: unknown;
}): Promise<
  | { status: "accepted"; sessionId: string; game: AdHocGameView }
  | { status: "capacity"; retryAfterMs: number }
  | { status: "unavailable" }
> {
  const sessionId = readAdHocSession(cookieHeader, gameId);
  const result = await service.subscribe({ gameId, sessionId });
  if (result.status === "capacity") return result;
  if (result.status !== "accepted") return { status: "unavailable" };
  return { status: "accepted", sessionId: result.game.sessionId, game: result.game };
}

export async function readAuthorizedAdHocGame(
  service: AdHocGamesService,
  gameId: string,
  sessionId: string,
  nowMs?: number,
): Promise<AdHocGameView | null> {
  const result = await service.read({ gameId, sessionId, nowMs });
  return result.status === "accepted" ? result.game : null;
}

async function broadcastGameSnapshot({
  gameId,
  service,
  sender,
  senderAckedCommandIds,
  operationOutcomes,
}: {
  gameId: string;
  service: AdHocGamesService;
  sender: ServerWebSocket<SessionData>;
  senderAckedCommandIds: string[];
  operationOutcomes: readonly {
    operationId: string;
    workflow: "ad-hoc" | "event";
    status: "accepted" | "duplicate" | "rejected" | "causally-blocked";
    detail?: string;
  }[];
}): Promise<boolean> {
  const delivery = await Promise.all(
    [...sockets].map(async (ws) => {
      if (ws.data.subscription.type !== "game" || ws.data.subscription.gameId !== gameId) {
        return ws === sender ? false : null;
      }
      const serverNowMs = Date.now();
      const game = await readAuthorizedAdHocGame(
        service,
        gameId,
        ws.data.subscription.sessionId,
        serverNowMs,
      );
      if (game === null) return ws === sender ? false : null;
      const sent = sendMessage(ws, {
        type: "game-snapshot",
        game: stripSession(game),
        serverNowMs,
        ackedCommandIds: ws === sender ? senderAckedCommandIds : [],
        operationOutcomes,
      });
      if (!sent) service.recordResourcePressure("queue-pressure");
      return ws === sender ? sent : null;
    }),
  );
  return delivery.some((sent) => sent === true);
}

function sendMessage(ws: ServerWebSocket<SessionData>, payload: ServerWsMessage) {
  const serialized = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > AD_HOC_MAX_QUEUED_OUTPUT_BYTES) {
    ws.close(1013, "Ad Hoc output limit reached.");
    return false;
  }
  try {
    const sentBytes = ws.send(serialized);
    if (sentBytes !== bytes) {
      ws.close(1013, "Ad Hoc output backpressure.");
      return false;
    }
  } catch {
    ws.close(1011, "Ad Hoc output unavailable.");
    return false;
  }
  return true;
}

function stripSession<T extends { sessionId: string }>(game: T) {
  const { sessionId: _sessionId, ...safe } = game;
  return safe;
}

function adHocUnavailableResponse(service: AdHocGamesService = defaultAdHocService) {
  return sensitiveJson({ error: service.genericUnavailableMessage }, 404);
}

export function readAdHocSession(cookieHeader: string | null, gameId: unknown): string | null {
  if (cookieHeader === null) return null;
  const cookieName = adHocSessionCookieName(gameId);
  if (cookieName === null) return null;
  for (const cookie of cookieHeader.split(";")) {
    const [name, ...value] = cookie.trim().split("=");
    if (name === cookieName && value.length > 0) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

const AD_HOC_SOURCE_COOKIE_NAME = "adhoc_source";

function readAdHocSource(cookieHeader: string | null): string | null {
  if (cookieHeader === null) return null;
  for (const cookie of cookieHeader.split(";")) {
    const [name, ...value] = cookie.trim().split("=");
    if (name !== AD_HOC_SOURCE_COOKIE_NAME || value.length === 0) continue;
    try {
      const decoded = decodeURIComponent(value.join("="));
      return /^[A-Za-z0-9_-]{32,128}$/.test(decoded) ? decoded : null;
    } catch {
      return null;
    }
  }
  return null;
}

function adHocSourceCookie(source: string): string {
  return `${AD_HOC_SOURCE_COOKIE_NAME}=${encodeURIComponent(source)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`;
}

function adHocSessionCookieName(gameId: unknown): string | null {
  if (typeof gameId !== "string" || !/^adhoc-[a-zA-Z0-9_-]+$/.test(gameId)) return null;
  return `adhoc_session_${gameId}`;
}

function adHocSessionCookie(gameId: string, sessionId: string): string {
  return `${adHocSessionCookieName(gameId)}=${encodeURIComponent(sessionId)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`;
}

function clearAdHocSessionCookie(gameId: string): string {
  return `${adHocSessionCookieName(gameId)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

export function adHocFallbackRoute(req: Request) {
  return adHocFallbackRouteFor(req, index);
}

type HtmlRoute = typeof index | ((req: Request) => Response);

function adHocFallbackRouteFor(req: Request, htmlRoute: HtmlRoute) {
  const pathname = new URL(req.url).pathname;
  if (isAdHocPath(pathname)) return adHocUnavailableResponse();
  if (isPublicEventPath(pathname)) return publicAudienceUnavailableResponse();
  return resolveHtmlRoute(req, htmlRoute);
}

function resolveHtmlRoute(req: Request, htmlRoute: HtmlRoute) {
  return typeof htmlRoute === "function" ? htmlRoute(req) : htmlRoute;
}

function isAdHocPath(pathname: string): boolean {
  return (
    pathname === "/game" ||
    pathname.startsWith("/game/") ||
    pathname === "/api/games" ||
    pathname.startsWith("/api/games/")
  );
}

function isPublicEventPath(pathname: string): boolean {
  return pathname === "/events/" || pathname.startsWith("/events/");
}

function readPathSegment(url: string): string {
  const segment = new URL(url).pathname.split("/").at(-1) ?? "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

function publicAudienceUnavailableResponse() {
  return sensitiveJson(PUBLIC_AUDIENCE_ABSENCE, 404);
}

function audienceRobotsResponse(req: Request): Response {
  const origin = new URL(req.url).origin;
  return new Response(
    [
      "User-agent: *",
      "Allow: /",
      "Disallow: /admin",
      "Disallow: /event-admin",
      "Disallow: /event-control",
      "Disallow: /api/",
      `Sitemap: ${origin}/sitemap.xml`,
      "",
    ].join("\n"),
    {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "referrer-policy": "no-referrer",
      },
    },
  );
}

function renderAudienceSitemap(
  origin: URL,
  result: AudienceProjectionListOutcome & { status: "accepted" },
): string {
  const locations = [
    new URL("/", origin).toString(),
    ...result.value.events.map((event) => new URL(event.canonicalPath, origin).toString()),
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...locations.map((location) => `  <url><loc>${escapeXml(location)}</loc></url>`),
    "</urlset>",
    "",
  ].join("\n");
}

function escapeXml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "'":
        return "&apos;";
      default:
        return "&quot;";
    }
  });
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

function administrativeAuditResponse<T>(
  result: import("@/lib/administrative-audit").AdministrativeAuditOutcome<T>,
) {
  if (result.status === "accepted") return sensitiveJson(result);
  if (result.status === "unavailable") return sensitiveJson(result, 503);
  return sensitiveJson(result, result.reason === "unauthorized" ? 401 : 400);
}

function administrativeAuditQuery(
  url: URL,
  eventId: string,
  authority: EventAdministrationAuthority,
) {
  const projection = url.searchParams.get("projection");
  return {
    projection: (projection === null
      ? "event-administration"
      : projection) as AdministrativeAuditProjectionKind,
    eventId,
    authority,
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    direction: url.searchParams.get("direction") ?? undefined,
    action: url.searchParams.get("action") ?? undefined,
    grantId: url.searchParams.get("grantId") ?? undefined,
    eventGameId: url.searchParams.get("eventGameId") ?? undefined,
    gameDayId: url.searchParams.get("gameDayId") ?? undefined,
    pitchId: url.searchParams.get("pitchId") ?? undefined,
    pitchSlotId: url.searchParams.get("pitchSlotId") ?? undefined,
  };
}

function sensitiveEventAdministrationMutationResponse<T>(
  result: EventAdministrationMutationOutcome<T>,
  authority: EventAdministrationAuthority,
  acceptedStatus = 200,
  audience: "event-admin" | "pitch-manager" = "event-admin",
) {
  const refreshHeaders: Array<[string, string]> =
    authority.kind === "grant-session" &&
    result.status === "accepted" &&
    typeof result.sessionExpiresAtMs === "number"
      ? [
          [
            "set-cookie",
            audience === "pitch-manager"
              ? pitchManagerSessionCookie(authority.sessionBearer, result.sessionExpiresAtMs)
              : eventAdminSessionCookie(authority.sessionBearer, result.sessionExpiresAtMs),
          ],
        ]
      : [];
  return sensitiveEventAdministrationResponse(result, acceptedStatus, refreshHeaders);
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

function resolvePitchManagerAuthority(
  req: Request,
  technicalAdminAuth: ReturnType<typeof createTechnicalAdminAuth>,
): EventAdministrationAuthority | null {
  const technicalToken = readTechnicalAdminCookie(req.headers.get("cookie"));
  const technical =
    technicalToken === null ? null : technicalAdminAuth.resolveCurrentAuthority(technicalToken);
  if (technical !== null) return technical;
  const sessionBearer = readPitchManagerSession(req.headers.get("cookie"));
  return sessionBearer === null ? null : { kind: "grant-session", sessionBearer };
}

function readEventAdminContext(header: string | null): string | null {
  return readCookieValue(header, "__Host-event-admin-context");
}

function readEventAdminSession(header: string | null): string | null {
  return readCookieValue(header, "__Host-event-admin-session");
}

function readPitchManagerContext(header: string | null): string | null {
  return readCookieValue(header, "__Host-pitch-manager-context");
}

function readPitchManagerSession(header: string | null): string | null {
  return readCookieValue(header, "__Host-pitch-manager-session");
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

function eventAdminSessionCookie(value: string, expiresAtMs: number): string {
  const maxAgeSeconds = Math.max(
    0,
    Math.min(2_592_000, Math.ceil((expiresAtMs - Date.now()) / 1_000)),
  );
  return `__Host-event-admin-session=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

function pitchManagerContextCookie(value: string): string {
  return `__Host-pitch-manager-context=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

function pitchManagerSessionCookie(value: string, expiresAtMs: number): string {
  const maxAgeSeconds = Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 1_000));
  return `__Host-pitch-manager-session=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

function clearEventAdminSessionCookie(): string {
  return "__Host-event-admin-session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict";
}

function clearPitchManagerSessionCookie(): string {
  return "__Host-pitch-manager-session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict";
}

function readRuntimeCapacity(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function calculateAdHocUpgradeCapacity(input: {
  eventTotalConnections: number;
  eventReservedConnections: number;
  activeEventConnections: number;
  adHocSocketCeiling: number;
}): number {
  const eventTotal = Math.max(0, input.eventTotalConnections);
  const eventReserve = Math.max(0, input.eventReservedConnections);
  const activeEvent = Math.max(0, input.activeEventConnections);
  const adHocCeiling = Math.max(0, input.adHocSocketCeiling);
  return Math.max(0, Math.min(adHocCeiling, eventTotal - Math.max(eventReserve, activeEvent)));
}

function releasePendingSocketReservation(socketId: string) {
  const timer = pendingSocketReservations.get(socketId);
  if (timer === undefined) return;
  clearTimeout(timer);
  pendingSocketReservations.delete(socketId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
