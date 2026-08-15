import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventGameRecord } from "@/lib/event-game-record";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import { createGrantTestAuthorityVerifier } from "@/lib/grant-authority-test-support";
import { createGrantTestKeyRing } from "@/lib/grant-authority-contract";
import { createTypedGrantAuthority } from "@/lib/grant-management";
import { grantKeyRingToDocument, writeGrantKeyRingFile } from "@/lib/grant-key-ring-custody";
import type { GrantKeyRing } from "@/lib/grant-types";
import { createControlScopeResolver } from "@/lib/live-event-game-runtime";
import {
  createLiveEventGameIqaInterpreter,
  LIVE_EVENT_CONTROL_INTENT_VERSION,
} from "@/lib/live-event-game-control";
import {
  createLiveEventGameControlTransport,
  type LiveEventGameControlTransportTarget,
} from "@/lib/live-event-game-transport";
import type { ControllerReplayResult } from "@/lib/live-event-game-control";

describe("Live Event Game HTTP transport pre-mutation boundary", () => {
  test("passes malformed intent content to the authorized Controller seam", async () => {
    const target = createSpyTarget();
    const transport = createLiveEventGameControlTransport(
      () => target,
      () => true,
    );

    const response = await transport.submitControlAction(
      jsonRequest({ sessionBearer: "session", eventGameId: "game", intent: null }),
    );

    expect(response.status).toBe(403);
    expect(target.calls).toEqual([{ kind: "submit", intent: null }]);
  });

  test("rejects a missing direct intent before target invocation", async () => {
    const target = createSpyTarget();
    const transport = createLiveEventGameControlTransport(
      () => target,
      () => true,
    );

    const response = await transport.submitControlAction(
      jsonRequest({ sessionBearer: "session", eventGameId: "game" }),
    );

    expect(response.status).toBe(404);
    expect(target.calls).toEqual([]);
  });

  test("rejects oversized, over-limit, and malformed replay envelopes before target parsing", async () => {
    const target = createSpyTarget();
    const transport = createLiveEventGameControlTransport(
      () => target,
      () => true,
    );
    const common = {
      sessionBearer: "session",
      eventGameId: "game",
      batchId: "batch",
      replicaGeneration: "generation",
      grantSessionId: "grant-session",
      grantVersion: "grant-version",
    };

    const oversized = await transport.replayControlActions(
      jsonRequest({
        ...common,
        actions: Array.from({ length: 101 }, () => ({ eventGameId: "game" })),
      }),
    );
    expect(oversized.status).toBe(404);

    const malformedEntry = await transport.replayControlActions(
      jsonRequest({
        ...common,
        actions: [{ eventGameId: "game", intent: {}, causalPredecessorIds: [7] }],
      }),
    );
    expect(malformedEntry.status).toBe(404);

    const missingIntent = await transport.replayControlActions(
      jsonRequest({
        ...common,
        actions: [{ eventGameId: "game", causalPredecessorIds: [] }],
      }),
    );
    expect(missingIntent.status).toBe(404);

    const oversizedPredecessor = await transport.replayControlActions(
      jsonRequest({
        ...common,
        actions: [
          {
            eventGameId: "game",
            intent: {},
            causalPredecessorIds: ["p".repeat(129)],
          },
        ],
      }),
    );
    expect(oversizedPredecessor.status).toBe(404);

    const tooManyPredecessors = await transport.replayGamePresentationChanges(
      jsonRequest({
        ...common,
        changes: [
          {
            eventGameId: "game",
            change: {},
            causalPredecessorIds: Array.from({ length: 101 }, (_, index) => `p-${index}`),
            originatingGrant: {},
          },
        ],
      }),
    );
    expect(tooManyPredecessors.status).toBe(404);

    const tooLargeBody = await transport.replayControlActions(
      new Request("http://localhost/api/event-control/replay", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(65 * 1024) },
        body: JSON.stringify({ ...common, actions: [{ eventGameId: "game", intent: {} }] }),
      }),
    );
    expect(tooLargeBody.status).toBe(404);
    expect(target.calls).toEqual([]);
  });

  test("forwards only structurally valid replay envelopes and fills omitted causal edges", async () => {
    const target = createSpyTarget();
    const transport = createLiveEventGameControlTransport(
      () => target,
      () => true,
    );
    const response = await transport.replayControlActions(
      jsonRequest({
        sessionBearer: "session",
        eventGameId: "game",
        batchId: "batch",
        replicaGeneration: "generation",
        grantSessionId: "grant-session",
        grantVersion: "grant-version",
        actions: [{ eventGameId: "game", intent: { version: "intent" } }],
      }),
    );

    expect(response.status).toBe(200);
    expect(target.calls).toEqual([
      {
        kind: "replay",
        actions: [{ eventGameId: "game", intent: { version: "intent" }, causalPredecessorIds: [] }],
      },
    ]);
  });

  test("does not expose a live route when the request binding is not allowed", async () => {
    const target = createSpyTarget();
    const transport = createLiveEventGameControlTransport(
      () => target,
      () => false,
    );
    const response = await transport.openController(
      jsonRequest({ qrCredential: "credential", browserContext: "fixture" }),
    );

    expect(response.status).toBe(404);
    expect(target.calls).toEqual([]);
  });

  test(
    "boots the registered HTTP-only Event Game route and leaves Ad Hoc WebSocket ownership intact",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "quadball-event-route-"));
      const ringPath = join(directory, "grant-key-ring.json");
      const databasePath = join(directory, "event-game.sqlite");
      const keyRing = createGrantTestKeyRing();
      const fixture = await prepareLiveEventRouteFixture(databasePath, keyRing);
      writeGrantKeyRingFile(
        ringPath,
        grantKeyRingToDocument("test", keyRing, new Date(0).toISOString()),
      );
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      Object.assign(environment, {
        NODE_ENV: "test",
        QUADBALL_ENVIRONMENT: "test",
        PUBLIC_ORIGIN: "https://localhost",
        WEBAUTHN_RP_ID: "localhost",
        PORT: "0",
        TECHNICAL_ADMIN_DATABASE: join(directory, "technical-admin.sqlite"),
        EVENT_GAME_DATABASE: databasePath,
        GRANT_KEY_RING_FILE: ringPath,
        EVENT_GAME_ENCRYPTION_KEY: encodeKey(
          keyRing.encryption.keys.get(keyRing.encryption.currentVersion),
        ),
        EVENT_GAME_LOOKUP_KEY: encodeKey(keyRing.lookup.keys.get(keyRing.lookup.currentVersion)),
        EVENT_GAME_AUDIT_KEY: encodeKey(keyRing.audit.keys.get(keyRing.audit.currentVersion)),
      });
      const server = Bun.spawn([process.execPath, "run", join(process.cwd(), "src/index.ts")], {
        cwd: process.cwd(),
        env: environment,
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        const address = await waitForServerAddress(server);
        const headers = {
          "content-type": "application/json",
          host: "localhost",
          origin: "https://localhost",
        };
        const opened = await fetch(`${address}/api/event-control/open`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            qrCredential: fixture.qrCredential,
            browserContext: "route-test",
          }),
        });
        expect(opened.status).toBe(200);
        const openedBody = (await opened.json()) as {
          session: { sessionBearer: string; grantSessionId: string; grantVersion: string };
          projection: unknown;
        };
        const sessionBearer = openedBody.session.sessionBearer;

        const invalidRequests = [
          {
            path: "/api/event-control/intent",
            body: {
              sessionBearer,
              eventGameId: fixture.root.eventGameId,
            },
          },
          {
            path: "/api/event-control/intent",
            body: {
              sessionBearer: "self-asserted-authority",
              eventGameId: fixture.root.eventGameId,
              intent: routeGoalIntent("route-forged-authority", "side-a"),
            },
          },
          {
            path: "/api/event-control/intent",
            body: {
              sessionBearer,
              eventGameId: "wrong-game",
              intent: routeGoalIntent("route-wrong-game", "side-a"),
            },
          },
          {
            path: "/api/event-control/intent",
            body: {
              sessionBearer,
              eventGameId: fixture.root.eventGameId,
              intent: routeGoalIntent("route-invalid-number", "side-a", -1),
            },
          },
          {
            path: "/api/event-control/intent",
            body: {
              sessionBearer,
              eventGameId: fixture.root.eventGameId,
              intent: routeGoalIntent("route-invalid-domain", "unknown-side"),
            },
          },
          {
            path: "/api/event-control/intent",
            body: {
              sessionBearer,
              eventGameId: fixture.root.eventGameId,
              intent: routeGoalIntent("o".repeat(129), "side-a"),
            },
          },
          {
            path: "/api/event-control/replay",
            body: {
              sessionBearer,
              eventGameId: fixture.root.eventGameId,
              batchId: "b".repeat(129),
              replicaGeneration: "route-generation",
              grantSessionId: openedBody.session.grantSessionId,
              grantVersion: openedBody.session.grantVersion,
              actions: [],
            },
          },
          {
            path: "/api/event-control/replay",
            body: {
              sessionBearer,
              eventGameId: fixture.root.eventGameId,
              batchId: "route-batch",
              replicaGeneration: "route-generation",
              grantSessionId: openedBody.session.grantSessionId,
              grantVersion: openedBody.session.grantVersion,
              actions: [
                { eventGameId: fixture.root.eventGameId, intent: {}, causalPredecessorIds: [7] },
              ],
            },
          },
          {
            path: "/api/event-control/replay",
            body: {
              sessionBearer,
              eventGameId: fixture.root.eventGameId,
              batchId: "route-missing-intent-batch",
              replicaGeneration: "route-missing-intent-generation",
              grantSessionId: openedBody.session.grantSessionId,
              grantVersion: openedBody.session.grantVersion,
              actions: [{ eventGameId: fixture.root.eventGameId, causalPredecessorIds: [] }],
            },
          },
          {
            path: "/api/event-control/presentation-change",
            body: {
              sessionBearer,
              eventGameId: fixture.root.eventGameId,
              change: routePresentationChange("route-invalid-presentation", "invalid"),
            },
          },
          {
            path: "/api/event-control/presentation-change",
            body: {
              sessionBearer,
              eventGameId: fixture.root.eventGameId,
              change: routePresentationChange("p".repeat(129), "side-a-left"),
            },
          },
          {
            path: "/api/event-control/presentation-replay",
            body: {
              sessionBearer,
              eventGameId: fixture.root.eventGameId,
              batchId: "route-presentation-batch",
              replicaGeneration: "route-presentation-generation",
              grantSessionId: openedBody.session.grantSessionId,
              grantVersion: openedBody.session.grantVersion,
              changes: Array.from({ length: 101 }, () => ({
                eventGameId: fixture.root.eventGameId,
                change: {},
                causalPredecessorIds: [],
                originatingGrant: {},
              })),
            },
          },
          {
            path: "/api/event-control/presentation-replay",
            body: {
              sessionBearer,
              eventGameId: fixture.root.eventGameId,
              batchId: "route-presentation-batch",
              replicaGeneration: "route-presentation-generation",
              grantSessionId: openedBody.session.grantSessionId,
              grantVersion: openedBody.session.grantVersion,
              changes: [
                {
                  eventGameId: fixture.root.eventGameId,
                  change: {},
                  causalPredecessorIds: [7],
                  originatingGrant: {},
                },
              ],
            },
          },
          {
            path: "/api/event-control/presentation-replay",
            body: {
              sessionBearer,
              eventGameId: fixture.root.eventGameId,
              batchId: "route-missing-change-batch",
              replicaGeneration: "route-missing-change-generation",
              grantSessionId: openedBody.session.grantSessionId,
              grantVersion: openedBody.session.grantVersion,
              changes: [
                {
                  eventGameId: fixture.root.eventGameId,
                  causalPredecessorIds: [],
                  originatingGrant: {},
                },
              ],
            },
          },
          {
            path: "/api/event-control/intent",
            body: {
              sessionBearer,
              eventGameId: fixture.root.eventGameId,
              acknowledgement: { operationId: "a".repeat(129) },
            },
          },
        ];
        for (const request of invalidRequests) {
          const response = await fetch(`${address}${request.path}`, {
            method: "POST",
            headers,
            body: JSON.stringify(request.body),
          });
          expect(response.status, request.path).not.toBe(200);
          const body = await response.json();
          expect(body).not.toHaveProperty("acknowledgement");
        }
        const oversizedBody = await fetch(`${address}/api/event-control/intent`, {
          method: "POST",
          headers: { ...headers, "content-length": String(65 * 1024) },
          body: JSON.stringify({
            sessionBearer,
            eventGameId: fixture.root.eventGameId,
            intent: {
              ...routeGoalIntent("route-oversized-body", "side-a"),
              payload: "x".repeat(66_000),
            },
          }),
        });
        expect(oversizedBody.status).not.toBe(200);
        expect(await oversizedBody.json()).not.toHaveProperty("acknowledgement");

        for (const path of ["refresh", "stay", "reveal-qr"]) {
          const response = await fetch(`${address}/api/event-control/${path}`, {
            method: "POST",
            headers,
            body: JSON.stringify({ sessionBearer, eventGameId: "x".repeat(129) }),
          });
          expect(response.status, path).not.toBe(200);
        }

        expect(await readPersistedRouteEvidence(databasePath, keyRing, fixture.root)).toEqual({
          actions: 0,
          actionAudit: 0,
          presentationChanges: 0,
          presentationAudit: 0,
        });

        const refresh = await fetch(`${address}/api/event-control/refresh`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            sessionBearer,
            eventGameId: fixture.root.eventGameId,
          }),
        });
        expect(refresh.status).toBe(200);
        expect(await refresh.json()).toMatchObject({
          projection: {
            scoreByGameSide: { "side-a": 0, "side-b": 0 },
            goalCount: 0,
            gameFacts: [],
          },
        });

        const staleGrant = await fetch(`${address}/api/event-control/replay`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            sessionBearer,
            eventGameId: fixture.root.eventGameId,
            batchId: "route-stale-grant",
            replicaGeneration: "route-stale-grant",
            grantSessionId: openedBody.session.grantSessionId,
            grantVersion: "stale-grant-version",
            actions: [
              {
                eventGameId: fixture.root.eventGameId,
                intent: routeGoalIntent("route-stale-grant", "side-a"),
                causalPredecessorIds: [],
              },
            ],
          }),
        });
        expect(staleGrant.status).not.toBe(200);
        expect(await staleGrant.json()).not.toHaveProperty("acknowledgement");
        expect(await readPersistedRouteEvidence(databasePath, keyRing, fixture.root)).toEqual({
          actions: 0,
          actionAudit: 0,
          presentationChanges: 0,
          presentationAudit: 0,
        });

        const adHocWebSocketBoundary = await fetch(`${address}/ws`, {
          headers: { host: "localhost", origin: "https://localhost" },
        });
        expect(adHocWebSocketBoundary.status).toBe(400);
        expect(await adHocWebSocketBoundary.json()).toEqual({
          error: "WebSocket upgrade failed.",
        });
      } finally {
        if (server.exitCode === null) server.kill();
        await server.exited;
        await rm(directory, { recursive: true, force: true });
      }
    },
    { timeout: 15_000 },
  );
});

async function prepareLiveEventRouteFixture(databasePath: string, keyRing: GrantKeyRing) {
  const root = createRouteRoot();
  const storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
  try {
    await storage.applyMigrations({ requireCandidate: false });
    await storage.transaction((transaction) => {
      transaction.insertEvent({
        eventId: root.eventId,
        name: "Route Event",
        timeZone: "UTC",
        publicationStatus: "unpublished",
        createdAtMs: 1,
        updatedAtMs: 1,
      });
      transaction.insertGameDay({
        gameDayId: root.externalScope.gameDayId,
        eventId: root.eventId,
        date: "2026-08-15",
        heatStoppageConfiguration: "enabled",
        createdAtMs: 1,
        updatedAtMs: 1,
      });
      transaction.insertPitch({
        pitchId: root.externalScope.pitchId,
        eventId: root.eventId,
        name: "Route Pitch",
        createdAtMs: 1,
        updatedAtMs: 1,
      });
      transaction.insertGameplaySlot({
        gameplaySlotId: "route-gameplay-slot",
        eventId: root.eventId,
        gameDayId: root.externalScope.gameDayId,
        sequence: 1,
        scheduledStartMs: 1,
        expectedDelayMs: 0,
        createdAtMs: 1,
        updatedAtMs: 1,
      });
      transaction.insertPitchSlot({
        pitchSlotId: root.externalScope.pitchSlotId,
        eventId: root.eventId,
        gameDayId: root.externalScope.gameDayId,
        pitchId: root.externalScope.pitchId,
        gameplaySlotId: "route-gameplay-slot",
        sequence: 1,
        expectedDelayMs: 0,
        createdAtMs: 1,
        updatedAtMs: 1,
      });
      transaction.insertEventGame({
        eventGameId: root.eventGameId,
        eventId: root.eventId,
        gameDayId: root.externalScope.gameDayId,
        gameplaySlotId: "route-gameplay-slot",
        pitchSlotId: root.externalScope.pitchSlotId,
        gameCode: null,
        gameDesignation: null,
        sideA: {
          sideId: "side-a",
          eventTeamId: null,
          eventTeamName: null,
          sourceLabel: "A",
          confirmedAtMs: null,
        },
        sideB: {
          sideId: "side-b",
          eventTeamId: null,
          eventTeamName: null,
          sourceLabel: "B",
          confirmedAtMs: null,
        },
        createdAtMs: 1,
        updatedAtMs: 1,
      });
    });
    const record = createEventGameRecord(storage, {
      externalScopeResolver: {
        resolve(scope) {
          return JSON.stringify(scope) === JSON.stringify(root.externalScope)
            ? { status: "resolved", scope: structuredClone(scope) }
            : { status: "mismatch", detail: "scope mismatch" };
        },
        resolveEventTeam() {
          return { status: "resolved" };
        },
      },
      interpreter: createLiveEventGameIqaInterpreter(),
      auditAuthorityVerifier: { verify: () => true },
    });
    expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
    const authority = createTypedGrantAuthority(storage, {
      environmentId: "test",
      clock: { nowMs: () => 10_000 },
      randomness: { bytes: (length) => new Uint8Array(length).fill(7) },
      keyRing,
      controlScopeResolver: createControlScopeResolver(() => 10_000),
      privilegedAuthorityVerifier: createGrantTestAuthorityVerifier(),
    });
    const created = await authority.createControlGrant({
      scope: root.externalScope,
      authority: { kind: "fixture", id: "route-fixture" },
    });
    if (created.status !== "created") throw new Error("Expected a route Control Grant.");
    return { root, qrCredential: created.qrCredential };
  } finally {
    storage.close();
  }
}

async function readPersistedRouteEvidence(
  databasePath: string,
  keyRing: GrantKeyRing,
  root: EventGameRecordRoot,
) {
  const storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
  try {
    const record = createEventGameRecord(storage, {
      externalScopeResolver: {
        resolve: () => ({ status: "resolved", scope: structuredClone(root.externalScope) }),
        resolveEventTeam: () => ({ status: "resolved" }),
      },
      interpreter: createLiveEventGameIqaInterpreter(),
      auditAuthorityVerifier: { verify: () => true },
    });
    expect(await record.registerRoot(root)).toMatchObject({ status: "idempotent" });
    return {
      actions: (await record.readActions()).length,
      actionAudit: (await record.readAudit(null)).length,
      presentationChanges: (await record.readPresentationHistory()).length,
      presentationAudit: (await record.readPresentationAudit(null)).length,
    };
  } finally {
    storage.close();
  }
}

function createRouteRoot(): EventGameRecordRoot {
  return {
    recordId: "route-record",
    eventId: "route-event",
    eventGameId: "route-game",
    ownership: { eventId: "route-event", eventGameId: "route-game" },
    externalScope: {
      eventId: "route-event",
      gameDayId: "route-day",
      pitchId: "route-pitch",
      pitchSlotId: "route-slot",
    },
    gameSides: [
      { id: "side-a", eventTeamId: "team-a", teamInterpretationRef: "side-a" },
      { id: "side-b", eventTeamId: "team-b", teamInterpretationRef: "side-b" },
    ],
    lifecycle: {
      phase: "in-progress",
      commencedAtMs: 10_000,
      finishedAtMs: null,
      lockedAtMs: null,
      lockReason: null,
    },
    compatibility: {
      recordVersion: "record-v1",
      schemaVersion: "schema-v1",
      interpreterVersion: "live-event-iqa-v1",
    },
    creationEvidence: {
      operationId: "route-register",
      actorReference: "route-test",
      source: "event-game-registration",
      createdAtMs: 1_000,
    },
  };
}

function routeGoalIntent(operationId: string, gameSideId: string, gameTimeMs = 0) {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "record-goal",
    operationId,
    factId: `${operationId}-fact`,
    gameSideId,
    gameTimeMs,
    occurrence: { clientOriginAtMs: 1_000 },
  };
}

function routePresentationChange(operationId: string, pitchOrientation: string) {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "set-pitch-orientation",
    operationId,
    factId: `${operationId}-fact`,
    presentationChangeId: `${operationId}-change`,
    pitchOrientation,
    gameTimeMs: 0,
    occurrence: { clientOriginAtMs: 1_000 },
  };
}

function encodeKey(value: Uint8Array | undefined): string {
  if (value === undefined) throw new Error("Expected a test key.");
  return Buffer.from(value).toString("base64url");
}

async function waitForServerAddress(server: ReturnType<typeof Bun.spawn>): Promise<string> {
  const stdout = server.stdout;
  if (stdout === null || stdout === undefined || typeof stdout === "number") {
    throw new Error("Server stdout was unavailable.");
  }
  const reader = stdout.getReader();
  if (reader === undefined) throw new Error("Server stdout was unavailable.");
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const next = await reader.read();
    if (next.done) break;
    output += decoder.decode(next.value);
    const match = output.match(/Server running at (https?:\/\/[^\s]+)/);
    if (match?.[1] !== undefined) return match[1];
  }
  throw new Error(`Event Game server did not boot: ${output}`);
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/event-control/replay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createSpyTarget() {
  const calls: unknown[] = [];
  const result: ControllerReplayResult = {
    batchId: "batch",
    replicaGeneration: "generation",
    session: {
      eventGameId: "game",
      grantSessionId: "grant-session",
      grantVersion: "grant-version",
    },
    eventGameId: "game",
    status: "synchronized",
    outcomes: [],
    projection: null,
  };
  const target = {
    calls,
    openController: async () => ({
      status: "rejected",
      message: "Unable to open Controller experience.",
    }),
    refreshController: async () => ({
      status: "rejected",
      message: "Unable to refresh Controller session.",
    }),
    switchController: async () => ({
      status: "rejected",
      message: "Unable to refresh Controller session.",
    }),
    stayController: async () => ({
      status: "rejected",
      message: "Unable to refresh Controller session.",
    }),
    revealControllerQr: async () => ({
      status: "rejected",
      message: "Unable to reveal the active Control Grant QR.",
    }),
    leaveController: async () => ({
      status: "rejected",
      message: "Unable to leave Controller session.",
    }),
    submitControlAction: async (input) => {
      calls.push({ kind: "submit", intent: input.intent });
      return {
        status: "rejected",
        message: "Unable to perform that Controller action.",
        operationId: null,
      };
    },
    replayControlActions: async (
      input: Parameters<LiveEventGameControlTransportTarget["replayControlActions"]>[0],
    ) => {
      calls.push({ kind: "replay", actions: input.actions });
      return result;
    },
    submitGamePresentationChange: async () => ({
      status: "rejected",
      message: "Unable to perform that Game Presentation Change.",
      operationId: null,
    }),
    replayGamePresentationChanges: async (
      input: Parameters<LiveEventGameControlTransportTarget["replayGamePresentationChanges"]>[0],
    ) => {
      calls.push({ kind: "presentation-replay", changes: input.changes });
      return result;
    },
  } satisfies LiveEventGameControlTransportTarget & { calls: unknown[] };
  return target;
}
