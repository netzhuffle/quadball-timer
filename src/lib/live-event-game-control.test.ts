import { describe, expect, test } from "bun:test";
import { applyGameCommand, createInitialGameState } from "@/lib/game-engine";
import { createFoundationAcceptance } from "@/lib/foundation-acceptance";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import { createEventGameRecord } from "@/lib/event-game-record";
import { createGrantTestAuthorityVerifier } from "@/lib/grant-authority-test-support";
import { createTypedGrantAuthority } from "@/lib/grant-management";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import type { GrantKeyRing } from "@/lib/grant-types";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import {
  createLiveEventGameControl,
  createLiveEventGameIqaInterpreter,
  LIVE_EVENT_CONTROL_INTENT_VERSION,
  parseLiveEventControllerIntent,
} from "@/lib/live-event-game-control";
import { createLiveEventGameControlTransport } from "@/lib/live-event-game-transport";

describe("Live Event Game control", () => {
  test("opens from a Control Grant and durably acknowledges a ten-point goal with a rebuilt projection", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-phone",
    });

    expect(opened).toMatchObject({
      status: "opened",
      eventGameId: harness.root.eventGameId,
      projection: {
        eventGameId: harness.root.eventGameId,
        scoreByGameSide: { "side-a": 0, "side-b": 0 },
      },
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    const result = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });

    expect(result).toMatchObject({
      status: "accepted",
      acknowledgement: { status: "acknowledged", operationId: "operation-goal" },
      projection: {
        eventGameId: harness.root.eventGameId,
        scoreByGameSide: { "side-a": 10, "side-b": 0 },
        goalCount: 1,
      },
      synchronization: { status: "synchronized", pendingCount: 0 },
    });
    expect(JSON.stringify(result)).not.toContain(harness.sessionBearer);
    expect(await harness.record.readActions()).toHaveLength(1);

    const secondDevice = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-device-b",
    });
    expect(secondDevice).toMatchObject({
      status: "opened",
      eventGameId: harness.root.eventGameId,
      projection: {
        eventGameId: harness.root.eventGameId,
        scoreByGameSide: { "side-a": 10, "side-b": 0 },
        goalCount: 1,
      },
    });
  });

  test("keeps invalid, empty, conflicted, expired, revoked, rotated, and wrong-scope authority generic", async () => {
    const harness = await createHarness();
    const invalid = await harness.control.openController({
      qrCredential: "not-a-grant",
      browserContext: "controller-phone",
    });
    expect(invalid).toEqual({
      status: "rejected",
      message: "Unable to open Controller experience.",
    });

    const wrongScope = await createHarness({ grantEventGameId: "different-game" });
    const wrong = await wrongScope.control.openController({
      qrCredential: wrongScope.qrCredential,
      browserContext: "controller-phone",
    });
    expect(wrong).toEqual({
      status: "rejected",
      message: "Unable to open Controller experience.",
    });

    const expired = await createHarness({ grantExpiresAtMs: 20_000 });
    expired.setNow(20_000);
    expect(
      await expired.control.openController({
        qrCredential: expired.qrCredential,
        browserContext: "controller-phone",
      }),
    ).toEqual({
      status: "rejected",
      message: "Unable to open Controller experience.",
    });
    expect(await harness.record.readActions()).toHaveLength(0);

    for (const scopeStatus of ["empty", "conflict"] as const) {
      const unresolved = await createHarness({ scopeStatus });
      expect(
        await unresolved.control.openController({
          qrCredential: unresolved.qrCredential,
          browserContext: "controller-phone",
        }),
      ).toEqual({ status: "rejected", message: "Unable to open Controller experience." });
    }

    const revoked = await createHarness();
    await revoked.authority.revokeGrant(revoked.grantId, { kind: "fixture", id: "fixture" });
    expect(
      await revoked.control.openController({
        qrCredential: revoked.qrCredential,
        browserContext: "controller-phone",
      }),
    ).toEqual({ status: "rejected", message: "Unable to open Controller experience." });

    const rotated = await createHarness();
    await rotated.authority.rotateGrant(rotated.grantId, { kind: "fixture", id: "fixture" });
    expect(
      await rotated.control.openController({
        qrCredential: rotated.qrCredential,
        browserContext: "controller-phone",
      }),
    ).toEqual({ status: "rejected", message: "Unable to open Controller experience." });
  });

  test("authorizes the Controller session before inspecting untrusted intent content", async () => {
    const harness = await createHarness();
    expect(
      await harness.control.submitControllerIntent({
        sessionBearer: "invalid-session-bearer",
        eventGameId: harness.root.eventGameId,
        intent: {
          operationId: "untrusted-operation-id",
          version: "unsupported-version",
          payload: { gameSideId: "untrusted-side" },
        },
      }),
    ).toEqual({
      status: "rejected",
      message: "Unable to perform that Controller action.",
      operationId: null,
    });

    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-phone",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    expect(
      await harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: "wrong-event-game",
        intent: {
          operationId: "untrusted-operation-id",
          version: "unsupported-version",
          payload: { gameSideId: "untrusted-side" },
        },
      }),
    ).toEqual({
      status: "rejected",
      message: "Unable to perform that Controller action.",
      operationId: null,
    });
  });

  test("rejects a changed Pitch Slot target without synthesizing a session switch", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-phone",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const before = await ownerState(harness);

    harness.setScopeEventGameId("reassigned-game");
    expect(
      await harness.authority.authorizeGrant({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: "reassigned-game",
        controlSessionDecision: "stay",
      }),
    ).toEqual({
      status: "rejected",
      code: "grant-authorization-failed",
      message: "Unable to authorize this Grant Session.",
    });
    expect(await ownerState(harness)).toEqual(before);
  });

  test("idempotently acknowledges a resend and rejects conflicting content under one identity", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-phone",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    const first = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });
    const duplicate = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });
    const conflict = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent({ gameSideId: "side-b" }),
    });

    expect(first.status).toBe("accepted");
    expect(duplicate).toMatchObject({
      status: "duplicate-accepted",
      acknowledgement: { status: "acknowledged", operationId: "operation-goal" },
      projection: { scoreByGameSide: { "side-a": 10, "side-b": 0 } },
    });
    expect(conflict).toEqual({
      status: "rejected",
      message: "Unable to perform that Controller action.",
      operationId: "operation-goal",
    });
    expect(await harness.record.readActions()).toHaveLength(1);
  });

  test("duplicate-acknowledges an identical retry after the server clock advances", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-phone",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    const accepted = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });
    expect(accepted.status).toBe("accepted");

    harness.setNow(20_000);
    const duplicate = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });

    expect(duplicate).toMatchObject({
      status: "duplicate-accepted",
      acknowledgement: { status: "acknowledged", operationId: "operation-goal" },
    });
    expect((await harness.record.readActions())[0]?.action.occurrence.trustedAtMs).toBe(10_000);
  });

  test("concurrent identical submissions share one trusted occurrence and one action", async () => {
    let nowMs = 10_000;
    const harness = await createHarness({
      controlClock: () => {
        nowMs += 1_000;
        return nowMs;
      },
    });
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-phone",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    const results = await Promise.all(
      [0, 1].map(() =>
        harness.control.submitControllerIntent({
          sessionBearer: opened.session.sessionBearer,
          eventGameId: harness.root.eventGameId,
          intent: goalIntent(),
        }),
      ),
    );

    expect(results.map((result) => result.status).sort()).toEqual([
      "accepted",
      "duplicate-accepted",
    ]);
    const actions = await harness.record.readActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]?.action.occurrence.trustedAtMs).toBeGreaterThan(10_000);
  });

  test("keeps distinct Controller Devices active while reopening one device replaces only itself", async () => {
    const harness = await createHarness();
    const first = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-device-a",
    });
    const second = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-device-b",
    });
    if (first.status !== "opened" || second.status !== "opened") {
      throw new Error("Expected both Controller Devices to open.");
    }

    const reopened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-device-a",
    });
    if (reopened.status !== "opened")
      throw new Error("Expected the first Controller Device to reopen.");

    const sessions = (await ownerState(harness)).grantSessions;
    expect(
      sessions.find((session) => session.sessionId === first.session.grantSessionId)?.status,
    ).toBe("revoked");
    expect(
      sessions.find((session) => session.sessionId === second.session.grantSessionId)?.status,
    ).toBe("active");
    expect(
      sessions.find((session) => session.sessionId === reopened.session.grantSessionId)?.status,
    ).toBe("active");
  });

  test("does not acknowledge or project an action when the durable transaction fails", async () => {
    const harness = await createHarness({ failureBoundary: "after-action" });
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-phone",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    const failed = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });

    expect(failed).toEqual({
      status: "retryable",
      message: "Controller action was not committed; retry is safe.",
      operationId: "operation-goal",
    });
    expect(await harness.record.readActions()).toHaveLength(0);

    harness.failureBoundary = undefined;
    const recovered = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });
    expect(recovered).toMatchObject({
      status: "accepted",
      projection: { scoreByGameSide: { "side-a": 10 } },
    });
  });

  test("assigns trusted occurrence time at the server seam and leaves Ad Hoc commands separate", async () => {
    expect(
      parseLiveEventControllerIntent({
        version: LIVE_EVENT_CONTROL_INTENT_VERSION,
        type: "record-goal",
        operationId: "operation-goal",
        factId: "fact-goal",
        gameSideId: "side-a",
        gameTimeMs: 12_000,
        occurrence: { trustedAtMs: 1, clientOriginAtMs: 10_000, source: "offline" },
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseLiveEventControllerIntent({
        version: LIVE_EVENT_CONTROL_INTENT_VERSION,
        type: "record-goal",
      }),
    ).toMatchObject({ ok: false });

    const adHoc = createInitialGameState({ id: "ad-hoc-regression", nowMs: 10_000 });
    const running = applyGameCommand({
      state: adHoc,
      command: { type: "set-running", running: true },
      nowMs: 10_001,
    });
    expect(running.isRunning).toBe(true);

    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-phone",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });
    const action = (await harness.record.readActions())[0];
    expect(action?.action.occurrence).toMatchObject({
      trustedAtMs: 10_000,
      clientOriginAtMs: 10_000,
      source: "online",
    });
  });

  test("acknowledges a committed goal when projection rebuild is unavailable", async () => {
    let projectionUnavailable = false;
    const harness = await createHarness({ projectionFailure: () => projectionUnavailable });
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-phone",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    projectionUnavailable = true;

    const result = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });

    expect(result).toMatchObject({
      status: "accepted",
      acknowledgement: { status: "acknowledged" },
      projection: null,
      projectionStatus: "unavailable",
    });
    expect(JSON.stringify(result)).not.toContain("not committed");
    expect(await harness.record.readActions()).toHaveLength(1);
  });

  test("keeps every owning module unchanged when durable acceptance fails", async () => {
    const harness = await createHarness({ failureBoundary: "after-action" });
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-phone",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const before = await ownerState(harness);

    const result = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });

    expect(result.status).toBe("retryable");
    expect(await ownerState(harness)).toEqual(before);
  });

  test("exposes the Controller through its HTTP transport without changing Ad Hoc routes", async () => {
    const harness = await createHarness();
    const allowedOrigin = "https://timer.quadball.app";
    const transport = createLiveEventGameControlTransport(
      () => harness.control,
      (request) =>
        request.headers.get("origin") === allowedOrigin &&
        request.headers.get("host") === "timer.quadball.app",
    );
    const rejectedOpen = await transport.openController(
      new Request("https://timer.quadball.app/api/event-control/open", {
        method: "POST",
        headers: { origin: "https://attacker.invalid", host: "timer.quadball.app" },
        body: JSON.stringify({ qrCredential: harness.qrCredential, browserContext: "phone" }),
      }),
    );
    expect(rejectedOpen.status).toBe(404);

    const openedResponse = await transport.openController(
      new Request("https://timer.quadball.app/api/event-control/open", {
        method: "POST",
        headers: { origin: allowedOrigin, host: "timer.quadball.app" },
        body: JSON.stringify({ qrCredential: harness.qrCredential, browserContext: "phone" }),
      }),
    );
    expect(openedResponse.status).toBe(200);
    const opened = (await openedResponse.json()) as {
      eventGameId: string;
      session: { sessionBearer: string };
    };
    expect(opened.session.sessionBearer).toBeString();

    const actionResponse = await transport.submitControllerIntent(
      new Request("https://timer.quadball.app/api/event-control/intent", {
        method: "POST",
        headers: { origin: allowedOrigin, host: "timer.quadball.app" },
        body: JSON.stringify({
          sessionBearer: opened.session.sessionBearer,
          eventGameId: opened.eventGameId,
          intent: goalIntent(),
        }),
      }),
    );
    expect(actionResponse.status).toBe(200);
    expect(await actionResponse.json()).toMatchObject({ status: "accepted" });

    const rejectedAction = await transport.submitControllerIntent(
      new Request("https://timer.quadball.app/api/event-control/intent", {
        method: "POST",
        headers: { origin: "https://attacker.invalid", host: "timer.quadball.app" },
        body: JSON.stringify({
          sessionBearer: opened.session.sessionBearer,
          eventGameId: opened.eventGameId,
          intent: goalIntent(),
        }),
      }),
    );
    expect(rejectedAction.status).toBe(404);
  });
});

async function createHarness(
  overrides: {
    eventGameId?: string;
    grantEventGameId?: string;
    grantExpiresAtMs?: number | null;
    failureBoundary?: "after-action";
    projectionFailure?: () => boolean;
    scopeStatus?: "empty" | "conflict";
    controlClock?: () => number;
  } = {},
) {
  const root = createRoot(overrides.eventGameId ?? "game-live-control");
  const storage = createInMemoryFoundationStorage();
  const grantOptions = createGrantOptions(overrides.grantEventGameId ?? root.eventGameId);
  const authority = createTypedGrantAuthority(storage, grantOptions);
  const created = await authority.createControlGrant({
    scope: root.externalScope,
    authority: { kind: "fixture", id: "fixture" },
    expiresAtMs: overrides.grantExpiresAtMs,
  });
  if (created.status !== "created") throw new Error("Expected a Control Grant.");
  const admitted = await authority.admitGrant({
    qrCredential: created.qrCredential,
    browserContext: "controller-phone",
  });
  if (admitted.status !== "admitted") throw new Error("Expected a Grant Session.");
  if (overrides.scopeStatus !== undefined) grantOptions.setScopeStatus(overrides.scopeStatus);

  let failureBoundary = overrides.failureBoundary;
  const record = createEventGameRecord(storage, {
    externalScopeResolver: createScopeResolver(root),
    interpreter: createLiveEventGameIqaInterpreter(),
    clock: () => grantOptions.clock.nowMs(),
    auditAuthorityVerifier: { verify: () => true },
  });
  if ((await record.registerRoot(root)).status !== "registered") {
    throw new Error("Expected the Event Game Record root to register.");
  }
  const acceptance = createFoundationAcceptance(storage, {
    grant: grantOptions,
    externalScopeResolver: createScopeResolver(root),
    clock: () => grantOptions.clock.nowMs(),
    interpreter: createLiveEventGameIqaInterpreter(),
    failureInjector: (boundary) => {
      if (boundary === failureBoundary) throw new Error("simulated durable failure");
    },
  });
  const control = createLiveEventGameControl({
    resolveEventGameRecord: async (eventGameId) =>
      eventGameId === root.eventGameId ? { recordId: root.recordId, record } : null,
    acceptance,
    grantAuthority: authority,
    clock: overrides.controlClock ?? (() => grantOptions.clock.nowMs()),
    projectionFailure: overrides.projectionFailure,
  });
  return {
    root,
    storage,
    record,
    control,
    authority,
    grantId: created.grantId,
    qrCredential: created.qrCredential,
    sessionBearer: admitted.sessionBearer,
    set failureBoundary(value: typeof failureBoundary) {
      failureBoundary = value;
    },
    setNow(value: number) {
      grantOptions.setNow(value);
    },
    setScopeEventGameId(value: string) {
      grantOptions.setScopeEventGameId(value);
    },
  };
}

function goalIntent(overrides: { gameSideId?: string } = {}) {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "record-goal",
    operationId: "operation-goal",
    factId: "fact-goal",
    gameSideId: overrides.gameSideId ?? "side-a",
    gameTimeMs: 12_000,
    occurrence: { clientOriginAtMs: 10_000 },
  };
}

type TestGrantOptions = GrantAuthorityOptions & {
  setNow: (value: number) => void;
  setScopeStatus: (value: "empty" | "conflict" | undefined) => void;
  setScopeEventGameId: (value: string) => void;
};

function createGrantOptions(eventGameId: string): TestGrantOptions {
  let call = 0;
  let nowMs = 10_000;
  let scopeStatus: "empty" | "conflict" | undefined;
  let resolvedEventGameId = eventGameId;
  return {
    environmentId: "live-control-test",
    clock: { nowMs: () => nowMs },
    randomness: {
      bytes: (length) => {
        call += 1;
        return Uint8Array.from({ length }, (_, index) => (index + call + length) % 256);
      },
    },
    keyRing: createKeyRing(),
    controlScopeResolver: {
      resolve: () =>
        scopeStatus === undefined
          ? { status: "eligible", eventGameId: resolvedEventGameId }
          : { status: scopeStatus },
    },
    privilegedAuthorityVerifier: createGrantTestAuthorityVerifier(),
    setNow(value: number) {
      nowMs = value;
    },
    setScopeStatus(value) {
      scopeStatus = value;
    },
    setScopeEventGameId(value) {
      resolvedEventGameId = value;
    },
  };
}

async function ownerState(harness: Awaited<ReturnType<typeof createHarness>>) {
  return harness.storage.transaction((transaction) => ({
    actions: transaction.listActions(harness.root.recordId),
    metadata: transaction.readRecordMetadata(harness.root.recordId),
    recordAudits: transaction.listAuditEntries(harness.root.recordId),
    grantAudits: transaction.listGrantAudit(harness.grantId),
    grantSessions: transaction.listGrantSessions(harness.grantId),
  }));
}

function createKeyRing(): GrantKeyRing {
  return {
    encryption: { currentVersion: "encryption-v1", keys: new Map([["encryption-v1", bytes(1)]]) },
    lookup: { currentVersion: "lookup-v1", keys: new Map([["lookup-v1", bytes(33)]]) },
    audit: { currentVersion: "audit-v1", keys: new Map([["audit-v1", bytes(65)]]) },
  };
}

function bytes(start: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => start + index);
}

function createRoot(eventGameId: string): EventGameRecordRoot {
  return {
    recordId: `record-${eventGameId}`,
    eventId: "event-live-control",
    eventGameId,
    ownership: { eventId: "event-live-control", eventGameId },
    externalScope: {
      eventId: "event-live-control",
      gameDayId: "day-1",
      pitchId: "pitch-1",
      pitchSlotId: `slot-${eventGameId}`,
    },
    gameSides: [
      { id: "side-a", eventTeamId: "team-a", teamInterpretationRef: "team-a-v1" },
      { id: "side-b", eventTeamId: "team-b", teamInterpretationRef: "team-b-v1" },
    ],
    lifecycle: {
      phase: "scheduled",
      commencedAtMs: null,
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
      operationId: `register-${eventGameId}`,
      actorReference: "actor-test",
      source: "event-game-registration",
      createdAtMs: 500,
    },
  };
}

function createScopeResolver(root: EventGameRecordRoot) {
  return {
    resolve(scope: EventGameRecordRoot["externalScope"]) {
      return JSON.stringify(scope) === JSON.stringify(root.externalScope)
        ? { status: "resolved" as const, scope: structuredClone(scope) }
        : { status: "mismatch" as const, detail: "scope mismatch" };
    },
    resolveEventTeam() {
      return { status: "resolved" as const };
    },
  };
}
