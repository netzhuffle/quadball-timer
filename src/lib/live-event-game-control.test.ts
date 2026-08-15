import { describe, expect, test } from "bun:test";
import { applyGameCommand, createInitialGameState } from "@/lib/game-engine";
import { createFoundationAcceptance } from "@/lib/foundation-acceptance";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import { createEventGameRecord } from "@/lib/event-game-record";
import { createGrantTestAuthorityVerifier } from "@/lib/grant-authority-test-support";
import { createTypedGrantAuthority } from "@/lib/grant-management";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import type { ControlGrantSessionResolution, GrantKeyRing } from "@/lib/grant-types";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import {
  createLiveEventGameControl,
  createLiveEventGameIqaInterpreter,
  LIVE_EVENT_CONTROL_INTENT_VERSION,
  parseLiveEventControllerIntent,
  type LiveEventControllerIntent,
  validateLiveEventGameActionInTransaction,
} from "@/lib/live-event-game-control";
import { createLiveEventGameControlTransport } from "@/lib/live-event-game-transport";
import { createAdHocGamesService } from "@/lib/ad-hoc-games";
import { createControlScopeResolver as createRuntimeControlScopeResolver } from "@/lib/live-event-game-runtime";

describe("Live Event Game control", () => {
  test("Event authority, storage, and control remain accepted after Ad Hoc pressure", async () => {
    const adHoc = createAdHocGamesService({
      now: () => 1_000,
      maxConnectedSockets: 1,
      eventCapacity: { totalConnections: 2, reservedConnections: 1, activeConnections: () => 0 },
    });
    const created = await adHoc.create({
      homeName: "Ad Hoc",
      awayName: "Pressure",
      sourceKey: "pressure-source",
    });
    if (created.status !== "accepted") throw new Error("Expected Ad Hoc Game.");
    expect(
      await adHoc.setConnection({
        gameId: created.gameId,
        sessionId: created.sessionId,
        connected: true,
        connectionId: "pressure-socket",
      }),
    ).toBe(true);
    const operations = Array.from({ length: 40 }, (_, index) => ({
      id: `pressure-${index}`,
      clientSentAtMs: 1_000,
      command: { type: "set-running", running: index % 2 === 0 },
    })) as never[];
    expect(
      (await adHoc.apply({ gameId: created.gameId, sessionId: created.sessionId, operations }))
        .status,
    ).toBe("accepted");
    for (let index = 0; index < 4; index += 1)
      expect(
        (
          await adHoc.create({
            homeName: `Pressure ${index}`,
            awayName: "Away",
            sourceKey: "pressure-source",
          })
        ).status,
      ).toBe("accepted");
    expect(
      (await adHoc.create({ homeName: "Delayed", awayName: "Away", sourceKey: "pressure-source" }))
        .status,
    ).toBe("rejected");

    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "event-after-ad-hoc-pressure",
    });
    if (opened.status !== "opened") throw new Error("Expected the Event Controller to open.");
    const eventResult = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent({
        operationId: "event-after-ad-hoc-pressure",
        factId: "event-after-ad-hoc-pressure",
      }),
    });
    expect(eventResult).toMatchObject({ status: "accepted" });
    expect(await harness.record.readActions()).toHaveLength(1);
  });

  test("reconciles invalidated Event Grant Sessions before reporting connection capacity", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "capacity-expiry",
    });
    expect(opened.status).toBe("opened");
    expect(harness.control.activeControllerSessions()).toBe(1);
    await harness.authority.revokeGrant(harness.grantId, { kind: "fixture", id: "fixture" });
    expect(await harness.control.reconcileActiveControllerSessions()).toBe(0);
    harness.control.close();
    expect(harness.control.activeControllerSessions()).toBe(0);
  });

  test("does not scan Event storage for authorization reads or known expiry", async () => {
    const harness = await createHarness({ grantExpiresAtMs: 10_500 });
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "capacity-read-boundary",
    });
    expect(opened.status).toBe("opened");
    const notifications = harness.lifecycleNotifications;
    harness.setNow(11_000);
    expect(harness.control.activeControllerSessions()).toBe(0);
    expect(harness.lifecycleNotifications).toBe(notifications);
    expect(
      await harness.control.refreshController({
        sessionBearer: harness.sessionBearer,
        eventGameId: harness.root.eventGameId,
      }),
    ).toMatchObject({ status: "authorized" });
    expect(harness.lifecycleNotifications).toBe(notifications);
  });

  test("reruns one dirty Event capacity scan after a lifecycle change arrives", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "capacity-dirty-scan",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const originalAuthorize = harness.authority.authorizeGrant.bind(harness.authority);
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let authorizeCalls = 0;
    harness.authority.authorizeGrant = async (input) => {
      authorizeCalls += 1;
      if (authorizeCalls === 1) {
        markStarted();
        await gate;
      }
      return originalAuthorize(input);
    };
    const scan = harness.control.reconcileActiveControllerSessions();
    await started;
    harness.triggerLifecycleChange();
    release();
    expect(await scan).toBe(1);
    expect(authorizeCalls).toBe(2);
  });

  test("does not repopulate Event capacity after close during reconciliation", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "capacity-close-scan",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const originalAuthorize = harness.authority.authorizeGrant.bind(harness.authority);
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.authority.authorizeGrant = async (input) => {
      markStarted();
      await gate;
      return originalAuthorize(input);
    };
    const scan = harness.control.reconcileActiveControllerSessions();
    await started;
    harness.control.close();
    release();
    expect(await scan).toBe(0);
    expect(harness.control.activeControllerSessions()).toBe(0);
  });

  test("expires a switched post-restart Event session from synchronous capacity", async () => {
    const harness = await createHarness({ grantExpiresAtMs: 10_500 });
    harness.setSessionResolution({
      status: "switchable",
      previousEventGameId: harness.root.eventGameId,
      currentEventGameId: "game-reassigned",
    });
    expect(
      await harness.control.refreshController({
        sessionBearer: harness.sessionBearer,
        eventGameId: harness.root.eventGameId,
      }),
    ).toMatchObject({ status: "switch-required" });
    expect(
      await harness.control.switchController({ sessionBearer: harness.sessionBearer }),
    ).toMatchObject({ status: "authorized", session: { eventGameId: "game-reassigned" } });
    expect(harness.control.activeControllerSessions()).toBe(1);
    harness.setNow(11_000);
    expect(harness.control.activeControllerSessions()).toBe(0);
  });

  test("exposes stable Game Facts and rebuilds score through contextual correction and reinstatement", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "facts-and-corrections",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    expect(
      await harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: goalIntent({ gameTimeMs: 12_000 }),
      }),
    ).toMatchObject({
      status: "accepted",
      projection: {
        gameFacts: [
          expect.objectContaining({
            factId: "fact-goal",
            factType: "goal",
            effective: true,
            sportingOrder: 12_000,
            synchronizationOrder: 1,
          }),
        ],
      },
    });

    const corrected = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      causalPredecessorIds: ["operation-goal"],
      intent: correctionIntent("correction-goal", "correction-fact", false),
    });
    expect(corrected).toMatchObject({
      status: "accepted",
      projection: {
        scoreByGameSide: { "side-a": 0, "side-b": 0 },
        goalCount: 0,
        gameFacts: [expect.objectContaining({ factId: "fact-goal", effective: false })],
      },
    });

    const reinstated = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      causalPredecessorIds: ["correction-goal"],
      intent: correctionIntent("reinstate-goal", "reinstate-fact", true),
    });
    expect(reinstated).toMatchObject({
      status: "accepted",
      projection: {
        scoreByGameSide: { "side-a": 10, "side-b": 0 },
        goalCount: 1,
        gameFacts: [expect.objectContaining({ factId: "fact-goal", effective: true })],
      },
    });
    expect(await harness.record.readActions()).toHaveLength(3);
    expect((await harness.record.readActions())[1]?.action.interpretation).toMatchObject({
      type: "correction",
      targetFactId: "fact-goal",
      effective: false,
    });
  });

  test("keeps sporting order distinct from synchronization order for late Controller information", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "sporting-order",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent({
        operationId: "operation-late",
        factId: "fact-late",
        gameTimeMs: 20_000,
      }),
    });
    harness.setNow(11_000);
    const result = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent({
        operationId: "operation-early",
        factId: "fact-early",
        gameTimeMs: 10_000,
      }),
    });
    const facts = (result as unknown as { projection: { gameFacts: any[] } }).projection.gameFacts;
    const synchronizationOrders = facts.map((fact) => fact.synchronizationOrder);
    expect(synchronizationOrders[0]).toBeGreaterThan(synchronizationOrders[1] ?? 0);
    expect(facts).toMatchObject([
      expect.objectContaining({ factId: "fact-early", sportingOrder: 10_000 }),
      expect.objectContaining({ factId: "fact-late", sportingOrder: 20_000 }),
    ]);

    const unadjudicated = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...goalIntent({ operationId: "operation-unadjudicated", factId: "fact-unadjudicated" }),
        sportingOrder: 1_000,
      },
    });
    expect(unadjudicated).toMatchObject({ status: "rejected" });

    const adjudicated = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...goalIntent({ operationId: "operation-adjudicated", factId: "fact-adjudicated" }),
        sportingOrder: 1_000,
        override: {
          guardrail: "sporting-order-adjudication",
          direction: "head-referee-adjudicated-sporting-order",
          confirmation: "head-referee-confirmed",
          authorityReference: "head-referee",
          gameTimeMs: 12_000,
          beforeValue: { sportingOrder: 12_000 },
          afterValue: { sportingOrder: 1_000 },
          reason: "head-referee-direction",
        },
      },
    });
    expect(adjudicated).toMatchObject({ status: "accepted" });
    expect((await harness.record.readActions()).at(-1)?.action.override).toMatchObject({
      guardrail: "sporting-order-adjudication",
    });
  });

  test("rebuilds penalty, timeout, stoppage, heat, and result state through Corrections", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "dependent-state-corrections",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    const submit = (intent: unknown) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
      });
    await submit(clockIntent("dependent-clock-start", true));
    harness.setNow(11_000);
    await submit(substantiveIntent("card-state", "card"));
    harness.setNow(12_000);
    await submit(clockIntent("dependent-clock-pause", false));
    await submit(substantiveIntent("timeout-state", "timeout"));
    await submit(substantiveIntent("suspension-state", "suspension"));
    await submit({
      ...substantiveIntent("heat-state", "heat-stoppage"),
      heatAction: "start",
    });
    await submit(substantiveIntent("result-state", "result"));

    const finished = await harness.control.refreshController({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
    });
    expect(finished).toMatchObject({
      projection: {
        phase: "finished",
        timeout: { status: "started", factId: "fact-timeout-state" },
        stoppage: { status: "suspension", factId: "fact-suspension-state" },
        heat: { status: "started", factId: "fact-heat-state" },
        result: { factId: "fact-result-state" },
      },
    });
    if (finished.status !== "authorized" || finished.projection === null) {
      throw new Error("Expected the finished Controller projection.");
    }
    expect(finished.projection.clock.activePenaltyTimeMs).toBe(1_000);

    await submit(
      correctionIntent("correct-card-state", "correction-card-state", false, "fact-card-state"),
    );
    await submit(
      correctionIntent(
        "correct-timeout-state",
        "correction-timeout-state",
        false,
        "fact-timeout-state",
      ),
    );
    await submit(
      correctionIntent(
        "correct-suspension-state",
        "correction-suspension-state",
        false,
        "fact-suspension-state",
      ),
    );
    await submit(
      correctionIntent("correct-heat-state", "correction-heat-state", false, "fact-heat-state"),
    );
    const corrected = await submit(
      correctionIntent(
        "correct-result-state",
        "correction-result-state",
        false,
        "fact-result-state",
      ),
    );
    expect(corrected).toMatchObject({
      status: "accepted",
      projection: {
        phase: "in-progress",
        timeout: { status: "inactive", factId: null },
        stoppage: { status: "none", factId: null },
        heat: { status: "inactive", factId: null },
        result: null,
      },
    });
    if (corrected.status !== "accepted" || corrected.projection === null) {
      throw new Error("Expected the corrected Controller projection.");
    }
    expect(corrected.projection.clock.activePenaltyTimeMs).toBe(0);

    const continued = await submit(
      goalIntent({ operationId: "post-result-goal", factId: "fact-post-result" }),
    );
    expect(continued).toMatchObject({
      status: "accepted",
      projection: {
        phase: "in-progress",
        scoreByGameSide: { "side-a": 10, "side-b": 0 },
      },
    });

    const reinstated = await submit(
      correctionIntent(
        "reinstate-result-state",
        "reinstate-result-state",
        true,
        "fact-result-state",
      ),
    );
    expect(reinstated).toMatchObject({
      status: "accepted",
      projection: {
        phase: "finished",
        result: { factId: "fact-result-state" },
      },
    });
  });

  test("records explainable Head Referee Official Override evidence and rejects clock misclassification", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "official-override",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    const running = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: clockIntent("timeout-running", true),
    });
    expect(running).toMatchObject({ status: "accepted" });

    const normalTimeout = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: substantiveIntent("timeout-without-override", "timeout"),
    });
    expect(normalTimeout).toMatchObject({ status: "rejected" });

    const overridden = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...substantiveIntent("timeout-override", "timeout"),
        gameTimeMs: 15_000,
        override: {
          guardrail: "timeout-requires-paused-play",
          direction: "head-referee-directed-timeout-while-running",
          confirmation: "head-referee-confirmed",
          authorityReference: "head-referee",
          gameTimeMs: 15_000,
          reason: "head-referee-direction",
          beforeValue: { running: true },
          afterValue: { timeout: "started" },
        },
      },
    });
    expect(overridden).toMatchObject({ status: "accepted" });
    const acceptedAction = (await harness.record.readActions())[1]?.action;
    expect(acceptedAction?.override).toMatchObject({
      guardrail: "timeout-requires-paused-play",
      confirmation: "head-referee-confirmed",
      authorityReference: "head-referee",
      reason: "head-referee-direction",
      beforeValue: { running: true },
      afterValue: { timeout: "started" },
    });
    expect(acceptedAction?.grant.sessionId).toBe(opened.session.grantSessionId);

    const invalidEvidence = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...substantiveIntent("timeout-invalid-evidence", "timeout"),
        override: {
          guardrail: "timeout-requires-paused-play",
          direction: "head-referee-directed-timeout-while-running",
          confirmation: "head-referee-confirmed",
          authorityReference: "head-referee",
          gameTimeMs: 0,
          reason: "head-referee-direction",
          beforeValue: { running: false },
          afterValue: { timeout: "started" },
        },
      },
    });
    expect(invalidEvidence).toMatchObject({ status: "rejected" });

    const validHeat = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...substantiveIntent("heat-skip", "result"),
        trigger: "heat-stoppage",
        heatAction: "skip-required",
      },
    });
    expect(validHeat).toMatchObject({ status: "accepted" });
    expect((await harness.record.readActions())[2]?.action.override).toBeUndefined();

    const fabricatedHeatOverride = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...substantiveIntent("fabricated-heat-override", "heat-stoppage"),
        heatAction: "skip-required",
        override: {
          guardrail: "heat-stoppage-rule-deviation",
          direction: "head-referee-directed-heat-stoppage",
          confirmation: "head-referee-confirmed",
          authorityReference: "head-referee",
          gameTimeMs: 0,
          beforeValue: { heat: "inactive" },
          afterValue: { heat: "skipped" },
          reason: "head-referee-direction",
        },
      },
    });
    expect(fabricatedHeatOverride).toMatchObject({ status: "rejected" });

    const paused = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: clockIntent("timeout-pause", false),
    });
    expect(paused).toMatchObject({ status: "accepted" });

    const unnecessaryTimeoutOverride = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...substantiveIntent("unnecessary-timeout-override", "timeout"),
        override: {
          guardrail: "timeout-requires-paused-play",
          direction: "head-referee-directed-timeout-while-running",
          confirmation: "head-referee-confirmed",
          authorityReference: "head-referee",
          gameTimeMs: 0,
          beforeValue: { running: false },
          afterValue: { timeout: "started" },
          reason: "head-referee-direction",
        },
      },
    });
    expect(unnecessaryTimeoutOverride).toMatchObject({ status: "rejected" });

    const clockWithOverride = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...clockCorrectionIntent("clock-with-override"),
        override: {
          guardrail: "normal-event-game-operation",
          direction: "head-referee-directed",
          confirmation: "head-referee-confirmed",
          authorityReference: "head-referee",
          gameTimeMs: 1_000,
          reason: "head-referee-direction",
        },
      },
    });
    expect(clockWithOverride).toMatchObject({ status: "rejected" });
    expect(await harness.record.readActions()).toHaveLength(4);
  });

  test("keeps a failed live Correction atomic and safely retryable", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "correction-atomicity",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });

    harness.failureBoundary = "after-action";
    const failed = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: correctionIntent("atomic-correction", "atomic-correction-id", false),
    });
    expect(failed).toMatchObject({ status: "retryable", operationId: "atomic-correction" });
    expect(await harness.record.readActions()).toHaveLength(1);
    expect(await harness.record.rebuild()).toMatchObject({ status: "ready" });

    harness.failureBoundary = undefined;
    const retried = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: correctionIntent("atomic-correction", "atomic-correction-id", false),
    });
    expect(retried).toMatchObject({
      status: "accepted",
      projection: { scoreByGameSide: { "side-a": 0, "side-b": 0 } },
    });
  });

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

  test("keeps a short clock test provisional, then commences after ten active seconds", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "clock-boundary",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    const start = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: clockIntent("clock-start", true),
    });
    expect(start).toMatchObject({
      status: "accepted",
      projection: { commencement: { status: "provisional" } },
    });

    harness.setNow(19_000);
    const shortRunningUpdate = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: clockIntent("clock-short-update", true),
    });
    expect(shortRunningUpdate).toMatchObject({
      projection: { commencement: { status: "provisional" } },
    });
    expect(
      (await harness.record.readRoot(harness.root.recordId))?.lifecycle.commencedAtMs,
    ).toBeNull();

    harness.setNow(20_000);
    const longPause = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: clockIntent("clock-long-pause", false),
    });
    expect(longPause).toMatchObject({ projection: { commencement: { status: "commenced" } } });
    expect((await harness.record.readRoot(harness.root.recordId))?.lifecycle).toMatchObject({
      phase: "in-progress",
      commencedAtMs: 20_000,
    });
  });

  test("persists passive clock commencement at the ten-second boundary during refresh", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "passive-commencement",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: clockIntent("passive-clock-start", true),
    });
    harness.setNow(20_000);
    expect(
      await harness.control.refreshController({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
      }),
    ).toMatchObject({
      status: "authorized",
      projection: { commencement: { status: "commenced", commencedAtMs: 20_000 } },
    });
    expect((await harness.record.readRoot(harness.root.recordId))?.lifecycle).toMatchObject({
      phase: "in-progress",
      commencedAtMs: 20_000,
    });

    harness.setNow(25_000);
    await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: substantiveIntent("passive-card", "card"),
    });
    expect((await harness.record.readRoot(harness.root.recordId))?.lifecycle.commencedAtMs).toBe(
      20_000,
    );
  });

  test.each(["card", "timeout", "suspension", "result"] as const)(
    "commences irreversibly on the first %s trigger",
    async (trigger) => {
      const harness = await createHarness();
      const opened = await harness.control.openController({
        qrCredential: harness.qrCredential,
        browserContext: `trigger-${trigger}`,
      });
      if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
      const result = await harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: substantiveIntent(`trigger-${trigger}`, trigger),
      });
      expect(result.status).toBe("accepted");
      expect((await harness.record.readRoot(harness.root.recordId))?.lifecycle.commencedAtMs).toBe(
        10_000,
      );
      if (trigger === "result") {
        expect((await harness.record.readRoot(harness.root.recordId))?.lifecycle.phase).toBe(
          "finished",
        );
      }
    },
  );

  test("reset and undo do not reverse commencement, and QR reveal stops after finish", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "qr-and-leave",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    expect(
      await harness.control.revealControllerQr({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
      }),
    ).toMatchObject({ status: "revealed", qrCredential: harness.qrCredential });
    await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });
    await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: simpleIntent("reset-1", "reset"),
    });
    await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: simpleIntent("undo-1", "undo"),
    });
    expect(
      (await harness.record.readRoot(harness.root.recordId))?.lifecycle.commencedAtMs,
    ).not.toBeNull();
    const finishIntent = substantiveIntent("finish-1", "result");
    expect(
      await harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: finishIntent,
      }),
    ).toMatchObject({ status: "accepted" });
    expect(
      await harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: finishIntent,
      }),
    ).toMatchObject({ status: "duplicate-accepted" });
    expect(
      await harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: substantiveIntent("post-finish", "card"),
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      (await ownerState(harness)).grantSessions.find(
        (session) => session.sessionId === opened.session.grantSessionId,
      )?.stayedOnEventGameId,
    ).toBeNull();
    expect(
      await harness.control.revealControllerQr({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
      }),
    ).toEqual({ status: "rejected", message: "Unable to reveal the active Control Grant QR." });
    expect(
      await harness.control.leaveController({ sessionBearer: opened.session.sessionBearer }),
    ).toEqual({
      status: "left",
    });
    expect(
      await harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: simpleIntent("after-leave", "undo"),
      }),
    ).toMatchObject({ status: "rejected" });
  });

  test("returns a pre-commencement switch prompt and pins a commenced session", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "switch-boundary",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    harness.setSessionResolution({
      status: "switchable",
      previousEventGameId: harness.root.eventGameId,
      currentEventGameId: "game-reassigned",
    });
    const prompt = await harness.control.refreshController({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
    });
    expect(prompt).toMatchObject({
      status: "switch-required",
      previousEventGameId: harness.root.eventGameId,
      currentEventGameId: "game-reassigned",
    });
    expect(
      await harness.control.revealControllerQr({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      (await ownerState(harness)).grantSessions.find(
        (session) => session.sessionId === opened.session.grantSessionId,
      )?.stayedOnEventGameId,
    ).toBeNull();
    expect(
      await harness.control.stayController({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
      }),
    ).toMatchObject({ status: "authorized", session: { eventGameId: harness.root.eventGameId } });
    expect(
      await harness.control.refreshController({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
      }),
    ).toMatchObject({ status: "authorized", session: { eventGameId: harness.root.eventGameId } });
    expect(
      await harness.control.switchController({ sessionBearer: opened.session.sessionBearer }),
    ).toMatchObject({ status: "authorized" });
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

  test("replays one bounded batch with per-action outcomes and causal blocking", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "reconnect-device",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const result = await harness.control.replayControllerActions({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      batchId: "batch-replay-test",
      replicaGeneration: "generation-replay-test",
      expectedGrantSessionId: opened.session.grantSessionId,
      expectedGrantVersion: opened.session.grantVersion,
      actions: [
        {
          eventGameId: harness.root.eventGameId,
          intent: {
            ...goalIntent({ gameSideId: "side-a" }),
            operationId: "blocked-goal",
            factId: "blocked-fact",
          },
          causalPredecessorIds: ["operation-goal"],
        },
        {
          eventGameId: harness.root.eventGameId,
          intent: goalIntent({ gameSideId: "missing-side" }),
        },
        {
          eventGameId: harness.root.eventGameId,
          intent: { ...goalIntent(), operationId: "unrelated-goal", factId: "unrelated-fact" },
        },
        {
          eventGameId: harness.root.eventGameId,
          intent: { ...goalIntent(), operationId: "unresolved-goal", factId: "unresolved-fact" },
          causalPredecessorIds: ["not-retained"],
        },
      ],
    });
    expect(result.status).toBe("synchronized");
    expect(
      Object.fromEntries(result.outcomes.map((outcome) => [outcome.operationId, outcome.status])),
    ).toEqual({
      "operation-goal": "terminally-rejected",
      "blocked-goal": "causally-blocked",
      "unrelated-goal": "accepted",
      "unresolved-goal": "terminally-rejected",
    });
    expect((await harness.record.readActions()).map((stored) => stored.action.operationId)).toEqual(
      ["unrelated-goal"],
    );
  });

  test("holds new replay evidence for a finished but unlocked Game", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "finished-reconnect-device",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const finish = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: substantiveIntent("finish-before-replay", "result"),
    });
    expect(finish.status).toBe("accepted");
    const replay = await harness.control.replayControllerActions({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      batchId: "batch-finished-hold",
      replicaGeneration: "generation-finished-hold",
      expectedGrantSessionId: opened.session.grantSessionId,
      expectedGrantVersion: opened.session.grantVersion,
      actions: [
        {
          eventGameId: harness.root.eventGameId,
          intent: goalIntent({ operationId: "held-goal", factId: "held-fact" }),
          causalPredecessorIds: [],
        },
      ],
    });
    expect(replay.outcomes).toEqual([{ operationId: "held-goal", status: "held-for-correction" }]);
    expect(await harness.record.readActions()).toHaveLength(1);
  });

  test("holds actions that follow an accepted result in the same replay batch", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "same-batch-finish-device",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const replay = await harness.control.replayControllerActions({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      batchId: "batch-same-batch-finish",
      replicaGeneration: "generation-same-batch-finish",
      expectedGrantSessionId: opened.session.grantSessionId,
      expectedGrantVersion: opened.session.grantVersion,
      actions: [
        {
          eventGameId: harness.root.eventGameId,
          intent: substantiveIntent("same-batch-result", "result"),
          causalPredecessorIds: [],
        },
        {
          eventGameId: harness.root.eventGameId,
          intent: goalIntent({ operationId: "post-result-goal", factId: "post-result-fact" }),
          causalPredecessorIds: [],
        },
      ],
    });
    expect(replay.outcomes).toEqual([
      { operationId: "same-batch-result", status: "accepted" },
      { operationId: "post-result-goal", status: "held-for-correction" },
    ]);
    expect((await harness.record.readActions()).map((stored) => stored.action.operationId)).toEqual(
      ["same-batch-result"],
    );
  });

  test("replays a reversed result Correction chain against rebuilt effective phase", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "reversed-result-correction-chain",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const finish = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: substantiveIntent("replay-order-result", "result"),
    });
    expect(finish.status).toBe("accepted");

    const replay = await harness.control.replayControllerActions({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      batchId: "batch-reversed-result-correction",
      replicaGeneration: "generation-reversed-result-correction",
      expectedGrantSessionId: opened.session.grantSessionId,
      expectedGrantVersion: opened.session.grantVersion,
      actions: [
        {
          eventGameId: harness.root.eventGameId,
          intent: goalIntent({
            operationId: "after-reinstatement-goal",
            factId: "fact-after-reinstatement",
          }),
          causalPredecessorIds: ["replay-order-reinstate"],
        },
        {
          eventGameId: harness.root.eventGameId,
          intent: correctionIntent(
            "replay-order-reinstate",
            "correction-replay-order-reinstate",
            true,
            "fact-replay-order-result",
          ),
          causalPredecessorIds: ["replay-order-goal"],
        },
        {
          eventGameId: harness.root.eventGameId,
          intent: goalIntent({
            operationId: "replay-order-goal",
            factId: "fact-replay-order-goal",
          }),
          causalPredecessorIds: ["replay-order-correct-result"],
        },
        {
          eventGameId: harness.root.eventGameId,
          intent: correctionIntent(
            "replay-order-correct-result",
            "correction-replay-order-result",
            false,
            "fact-replay-order-result",
          ),
          causalPredecessorIds: ["replay-order-result"],
        },
      ],
    });

    expect(replay.outcomes).toEqual([
      { operationId: "replay-order-correct-result", status: "accepted" },
      { operationId: "replay-order-goal", status: "accepted" },
      { operationId: "replay-order-reinstate", status: "accepted" },
      { operationId: "after-reinstatement-goal", status: "held-for-correction" },
    ]);
    expect(replay.projection).toMatchObject({
      phase: "finished",
      scoreByGameSide: { "side-a": 10, "side-b": 0 },
      result: { factId: "fact-replay-order-result" },
      gameFacts: expect.arrayContaining([
        expect.objectContaining({ factId: "fact-replay-order-goal", effective: true }),
      ]),
    });
    expect((await harness.record.readActions()).map((stored) => stored.action.operationId)).toEqual(
      [
        "replay-order-result",
        "replay-order-correct-result",
        "replay-order-goal",
        "replay-order-reinstate",
      ],
    );
  });

  test("rejects replay authority mismatches and malformed causal evidence without submission", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "malformed-reconnect-device",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const mismatch = await harness.control.replayControllerActions({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      batchId: "batch-mismatch",
      replicaGeneration: "generation-mismatch",
      expectedGrantSessionId: opened.session.grantSessionId,
      expectedGrantVersion: "expired-version",
      actions: [{ eventGameId: harness.root.eventGameId, intent: goalIntent() }],
    });
    expect(mismatch.status).toBe("rejected");
    expect(await harness.record.readActions()).toHaveLength(0);
    const malformed = await harness.control.replayControllerActions({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      batchId: "batch-malformed",
      replicaGeneration: "generation-malformed",
      expectedGrantSessionId: opened.session.grantSessionId,
      expectedGrantVersion: opened.session.grantVersion,
      actions: [
        {
          eventGameId: harness.root.eventGameId,
          intent: { ...goalIntent(), operationId: "bad-dependency" },
          causalPredecessorIds: [42],
        },
        {
          eventGameId: harness.root.eventGameId,
          intent: { ...goalIntent(), operationId: "duplicate-dependency" },
          causalPredecessorIds: ["same", "same"],
        },
        {
          eventGameId: "another-game",
          intent: { ...goalIntent(), operationId: "cross-game" },
          causalPredecessorIds: [],
        },
      ],
    });
    expect(malformed.outcomes.map((outcome) => outcome.status)).toEqual([
      "terminally-rejected",
      "terminally-rejected",
      "terminally-rejected",
    ]);
    expect(await harness.record.readActions()).toHaveLength(0);
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

  test("atomically rolls back the action and commencement at the lifecycle boundary", async () => {
    const harness = await createHarness({ failureBoundary: "after-lifecycle" });
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-phone",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    expect(
      await harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: substantiveIntent("atomic-card", "card"),
      }),
    ).toMatchObject({ status: "retryable" });
    expect(await harness.record.readActions()).toHaveLength(0);
    expect((await harness.record.readRoot(harness.root.recordId))?.lifecycle).toMatchObject({
      phase: "scheduled",
      commencedAtMs: null,
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

  test("distinguishes direct online provenance from later offline replay evidence", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "provenance-device",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...goalIntent({ operationId: "online-provenance", factId: "online-fact" }),
        occurrence: { clientOriginAtMs: 1_000, source: "online" as const },
      },
    });
    const offline = {
      ...goalIntent({ operationId: "offline-provenance", factId: "offline-fact" }),
      occurrence: { clientOriginAtMs: 2_000, source: "offline" as const },
    };
    const replay = await harness.control.replayControllerActions({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      batchId: "provenance-batch",
      replicaGeneration: "provenance-generation",
      expectedGrantSessionId: opened.session.grantSessionId,
      expectedGrantVersion: opened.session.grantVersion,
      actions: [
        { eventGameId: harness.root.eventGameId, intent: offline, causalPredecessorIds: [] },
      ],
    });
    expect(replay.outcomes).toEqual([{ operationId: "offline-provenance", status: "accepted" }]);
    const actions = await harness.record.readActions();
    expect(
      actions.map((stored) => ({
        operationId: stored.action.operationId,
        clientOriginAtMs: stored.action.occurrence.clientOriginAtMs,
        source: stored.action.occurrence.source,
      })),
    ).toEqual([
      { operationId: "online-provenance", clientOriginAtMs: 1_000, source: "online" },
      { operationId: "offline-provenance", clientOriginAtMs: 2_000, source: "offline" },
    ]);
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

  test("serializes simultaneous clock transitions, transfers the holder, and ignores goal transfer", async () => {
    const harness = await createHarness();
    const first = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "clock-device-a",
    });
    const second = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "clock-device-b",
    });
    if (first.status !== "opened" || second.status !== "opened") {
      throw new Error("Expected two Controller Devices.");
    }

    const [start, pause] = await Promise.all([
      harness.control.submitControllerIntent({
        sessionBearer: first.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: clockIntent("z-start", true),
      }),
      harness.control.submitControllerIntent({
        sessionBearer: second.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: clockIntent("a-pause", false),
      }),
    ]);
    expect(start.status).toBe("accepted");
    expect(pause.status).toBe("accepted");

    const afterSimultaneous = await harness.control.refreshController({
      sessionBearer: second.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
    });
    expect(afterSimultaneous).toMatchObject({
      projection: {
        clock: {
          running: true,
          offlineClockHolderGrantSessionId: first.session.grantSessionId,
        },
      },
    });

    harness.setNow(15_000);
    const transferred = await harness.control.submitControllerIntent({
      sessionBearer: second.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: clockIntent("b-pause", false),
    });
    expect(transferred).toMatchObject({
      projection: {
        clock: {
          running: false,
          gameTimeMs: 5_000,
          offlineClockHolderGrantSessionId: second.session.grantSessionId,
        },
      },
    });

    const goal = await harness.control.submitControllerIntent({
      sessionBearer: first.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });
    expect(goal).toMatchObject({
      projection: {
        clock: { offlineClockHolderGrantSessionId: second.session.grantSessionId },
      },
    });
    const duplicateGoal = await harness.control.submitControllerIntent({
      sessionBearer: first.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });
    expect(duplicateGoal).toMatchObject({
      status: "duplicate-accepted",
      projection: {
        clock: { offlineClockHolderGrantSessionId: second.session.grantSessionId },
      },
    });
  });

  test("atomically rejects one concurrent bounded adjustment without dropping an accepted Clock action", async () => {
    const harness = await createHarness();
    const first = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "clock-bounds-a",
    });
    const second = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "clock-bounds-b",
    });
    if (first.status !== "opened" || second.status !== "opened") {
      throw new Error("Expected two Controller Devices.");
    }
    const correction = {
      ...clockIntent("clock-correction-105", false),
      type: "clock-correction" as const,
      clockTimeMs: 105 * 60 * 1000,
    };
    expect(
      await harness.control.submitControllerIntent({
        sessionBearer: first.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: correction,
      }),
    ).toMatchObject({ status: "accepted" });
    harness.setNow(20_000);

    const adjustA = clockAdjustmentIntent("clock-bounded-a", 10 * 60 * 1000);
    const adjustB = clockAdjustmentIntent("clock-bounded-b", 10 * 60 * 1000);
    const [resultA, resultB] = await Promise.all([
      harness.control.submitControllerIntent({
        sessionBearer: first.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: adjustA,
      }),
      harness.control.submitControllerIntent({
        sessionBearer: second.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: adjustB,
      }),
    ]);
    expect([resultA.status, resultB.status].sort()).toEqual(["accepted", "rejected"]);
    expect(await harness.record.readActions()).toHaveLength(2);

    const rejected =
      resultA.status === "rejected"
        ? { intent: adjustA, sessionBearer: first.session.sessionBearer }
        : { intent: adjustB, sessionBearer: second.session.sessionBearer };
    expect(
      await harness.control.submitControllerIntent({
        sessionBearer: rejected.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: rejected.intent,
      }),
    ).toMatchObject({ status: "rejected" });
    expect(await harness.record.readActions()).toHaveLength(2);

    const final = await harness.control.refreshController({
      sessionBearer: first.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
    });
    expect(final).toMatchObject({ projection: { clock: { gameTimeMs: 115 * 60 * 1000 } } });

    const accepted =
      resultA.status === "accepted"
        ? { intent: adjustA, sessionBearer: first.session.sessionBearer }
        : { intent: adjustB, sessionBearer: second.session.sessionBearer };
    expect(
      await harness.control.submitControllerIntent({
        sessionBearer: accepted.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: accepted.intent,
      }),
    ).toMatchObject({ status: "duplicate-accepted" });
    expect(await harness.record.readActions()).toHaveLength(2);
  });

  test("composes valid concurrent bounded adjustments at the durable limit", async () => {
    const harness = await createHarness();
    const first = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "clock-compose-a",
    });
    const second = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "clock-compose-b",
    });
    if (first.status !== "opened" || second.status !== "opened") {
      throw new Error("Expected two Controller Devices.");
    }
    expect(
      await harness.control.submitControllerIntent({
        sessionBearer: first.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: {
          ...clockIntent("clock-correction-100", false),
          type: "clock-correction",
          clockTimeMs: 100 * 60 * 1000,
        },
      }),
    ).toMatchObject({ status: "accepted" });
    harness.setNow(20_000);
    const [left, right] = await Promise.all([
      harness.control.submitControllerIntent({
        sessionBearer: first.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: clockAdjustmentIntent("clock-compose-left", 10 * 60 * 1000),
      }),
      harness.control.submitControllerIntent({
        sessionBearer: second.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: clockAdjustmentIntent("clock-compose-right", 10 * 60 * 1000),
      }),
    ]);
    expect(left.status).toBe("accepted");
    expect(right.status).toBe("accepted");
    expect(
      await harness.control.refreshController({
        sessionBearer: first.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
      }),
    ).toMatchObject({ projection: { clock: { gameTimeMs: 120 * 60 * 1000 } } });
  });

  test("projects clock time between snapshots, emits distinct cues, and enforces adjustment bounds", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "clock-projection",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...clockIntent("clock-correct-19", false),
        type: "clock-correction",
        clockTimeMs: 19 * 60 * 1000,
      },
    });
    const warning = await harness.control.refreshController({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
    });
    expect(warning).toMatchObject({
      projection: {
        clock: {
          gameTimeMs: 19 * 60 * 1000,
          activePenaltyTimeMs: 0,
          cues: {
            flagRunnerEntry: "due",
            seekerWarning: "due",
            seekerRelease: "pending",
            seekerCountdownMs: 60_000,
          },
        },
      },
    });

    const adjusted = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...clockIntent("z-clock-adjust-one-second", false),
        type: "clock-adjust",
        adjustmentMs: 1_000,
      },
    });
    expect(adjusted).toMatchObject({
      status: "accepted",
      projection: { clock: { gameTimeMs: 19 * 60 * 1000 + 1_000 } },
    });

    await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...clockIntent("zz-clock-correct-20", false),
        type: "clock-correction",
        clockTimeMs: 20 * 60 * 1000,
      },
    });
    const release = await harness.control.refreshController({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
    });
    expect(release).toMatchObject({
      projection: { clock: { cues: { seekerWarning: "passed", seekerRelease: "released" } } },
    });

    for (const invalid of [Number.NaN, 1.5, 10 * 60 * 1000 + 1]) {
      expect(
        parseLiveEventControllerIntent({
          ...clockIntent(`invalid-${String(invalid)}`, true),
          type: "clock-adjust",
          adjustmentMs: invalid,
        }),
      ).toMatchObject({ ok: false });
    }
    expect(
      parseLiveEventControllerIntent({
        ...clockIntent("invalid-correction", true),
        type: "clock-correction",
        clockTimeMs: 120 * 60 * 1000 + 1,
      }),
    ).toMatchObject({ ok: false });
  });

  test("projects an independent active penalty from a card fact through pause and resume", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "clock-penalty",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    const submit = (intent: LiveEventControllerIntent) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
      });

    await submit(substantiveIntent("penalty-card", "card"));
    const noPlay = await harness.control.refreshController({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
    });
    expect(noPlay).toMatchObject({
      projection: { clock: { gameTimeMs: 0, activePenaltyTimeMs: 0 } },
    });

    harness.setNow(11_000);
    await submit(clockIntent("penalty-start-clock", true));
    harness.setNow(14_000);
    const live = await harness.control.refreshController({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
    });
    expect(live).toMatchObject({
      projection: { clock: { gameTimeMs: 3_000, activePenaltyTimeMs: 3_000 } },
    });

    harness.setNow(15_000);
    await submit(clockIntent("penalty-pause", false));
    harness.setNow(20_000);
    const paused = await harness.control.refreshController({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
    });
    expect(paused).toMatchObject({
      projection: { clock: { gameTimeMs: 4_000, activePenaltyTimeMs: 4_000 } },
    });

    harness.setNow(25_000);
    await submit(clockIntent("penalty-resume", true));
    harness.setNow(27_000);
    const resumed = await harness.control.refreshController({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
    });
    expect(resumed).toMatchObject({
      projection: { clock: { gameTimeMs: 6_000, activePenaltyTimeMs: 6_000 } },
    });
  });

  test("does not acknowledge a clock transition when durable commit fails", async () => {
    const harness = await createHarness({ failureBoundary: "after-action" });
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "clock-commit-failure",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    const failed = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: clockIntent("clock-failure", true),
    });
    expect(failed).toMatchObject({ status: "retryable", operationId: "clock-failure" });
    expect(await harness.record.readActions()).toHaveLength(0);
  });

  test("keeps offline holder continuity, accepts deliberate takeover, and ignores stale generation evidence", async () => {
    const harness = await createHarness();
    const first = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "holder-phone",
    });
    if (first.status !== "opened") throw new Error("Expected the holder Controller to open.");
    const started = await harness.control.submitControllerIntent({
      sessionBearer: first.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: clockIntent("holder-start", true),
    });
    expect(started).toMatchObject({ status: "accepted" });

    const second = await harness.authority.admitGrant({
      qrCredential: harness.qrCredential,
      browserContext: "replacement-phone",
    });
    if (second.status !== "admitted")
      throw new Error("Expected the replacement Controller to open.");
    const rejectedNonHolder = await harness.control.submitControllerIntent({
      sessionBearer: second.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: clockIntent("non-holder-offline", false, {
        source: "offline",
        clockGeneration: 1,
      }),
    });
    expect(rejectedNonHolder.status).toBe("rejected");

    harness.setNow(11_000);
    const takeover = await harness.control.submitControllerIntent({
      sessionBearer: second.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...clockIntent("emergency-takeover", false, { source: "offline" }),
        type: "clock-takeover" as const,
        clockTimeMs: 5_000,
        authorityGeneration: 1,
        confirmation: "physical-timekeeper-or-head-referee" as const,
      },
    });
    expect(takeover).toMatchObject({
      status: "accepted",
      projection: {
        clock: {
          gameTimeMs: 5_000,
          running: false,
          baseline: { authorityGeneration: 2, holderGrantSessionId: second.grantSessionId },
        },
      },
    });

    harness.setNow(12_000);
    const stale = await harness.control.submitControllerIntent({
      sessionBearer: first.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: clockIntent("stale-holder-action", true, {
        source: "offline",
        clockGeneration: 1,
      }),
    });
    expect(stale).toMatchObject({
      status: "accepted",
      projection: {
        clock: {
          gameTimeMs: 5_000,
          running: false,
          baseline: { staleGenerationOperationIds: ["stale-holder-action"] },
        },
      },
    });
    expect(await harness.record.readActions()).toHaveLength(3);
  });

  test("rejects an ordinary offline clock action before any Offline Clock Holder exists", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "fresh-offline-phone",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    const rejected = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: clockIntent("no-offline-holder", true, { source: "offline" }),
    });

    expect(rejected).toMatchObject({ status: "rejected", operationId: "no-offline-holder" });
    expect(await harness.record.readActions()).toHaveLength(0);
    const refreshed = await harness.control.refreshController({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
    });
    if (refreshed.status !== "authorized" || refreshed.projection === null) {
      throw new Error("Expected an authorized Controller projection.");
    }
    expect(refreshed.projection.clock).toMatchObject({
      gameTimeMs: 0,
      running: false,
      offlineClockHolderGrantSessionId: null,
      baseline: { authorityGeneration: 0, holderGrantSessionId: null },
    });
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

    const refreshResponse = await transport.refreshController(
      new Request("https://timer.quadball.app/api/event-control/refresh", {
        method: "POST",
        headers: { origin: allowedOrigin, host: "timer.quadball.app" },
        body: JSON.stringify({
          sessionBearer: opened.session.sessionBearer,
          eventGameId: opened.eventGameId,
        }),
      }),
    );
    expect(refreshResponse.status).toBe(200);
    expect(await refreshResponse.json()).toMatchObject({ status: "authorized" });

    const revealResponse = await transport.revealControllerQr(
      new Request("https://timer.quadball.app/api/event-control/reveal-qr", {
        method: "POST",
        headers: { origin: allowedOrigin, host: "timer.quadball.app" },
        body: JSON.stringify({
          sessionBearer: opened.session.sessionBearer,
          eventGameId: opened.eventGameId,
        }),
      }),
    );
    expect(revealResponse.status).toBe(200);
    expect(await revealResponse.json()).toMatchObject({
      status: "revealed",
      qrCredential: harness.qrCredential,
    });

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

    const leaveResponse = await transport.leaveController(
      new Request("https://timer.quadball.app/api/event-control/leave", {
        method: "POST",
        headers: { origin: allowedOrigin, host: "timer.quadball.app" },
        body: JSON.stringify({ sessionBearer: opened.session.sessionBearer }),
      }),
    );
    expect(leaveResponse.status).toBe(200);
    expect(await leaveResponse.json()).toEqual({ status: "left" });
  });

  test("admits a Controller through the independent Grant Code path without exposing code material", async () => {
    const harness = await createHarness();
    const created = await harness.authority.createGrantCode(harness.grantId, {
      kind: "fixture",
      id: "fixture",
    });
    if (created.status !== "created") throw new Error("Expected a Control Grant Code.");
    const allowedOrigin = "https://timer.quadball.app";
    const transport = createLiveEventGameControlTransport(
      () => harness.control,
      (request) =>
        request.headers.get("origin") === allowedOrigin &&
        request.headers.get("host") === "timer.quadball.app",
    );
    const response = await transport.openController(
      new Request("https://timer.quadball.app/api/event-control/open", {
        method: "POST",
        headers: { origin: allowedOrigin, host: "timer.quadball.app" },
        body: JSON.stringify({ grantCode: created.code, browserContext: "code-controller" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    const opened = await response.json();
    expect(opened).toMatchObject({ status: "opened", eventGameId: harness.root.eventGameId });
    expect(opened).toMatchObject({ sessionExpiresAtMs: null });
    expect(JSON.stringify(opened)).not.toContain(created.code);

    const refreshResponse = await transport.refreshController(
      new Request("https://timer.quadball.app/api/event-control/refresh", {
        method: "POST",
        headers: { origin: allowedOrigin, host: "timer.quadball.app" },
        body: JSON.stringify({
          sessionBearer: opened.session.sessionBearer,
          eventGameId: opened.eventGameId,
        }),
      }),
    );
    expect(refreshResponse.status).toBe(200);
    expect(await refreshResponse.json()).toMatchObject({ status: "authorized" });
  });

  test("uses the production Control scope resolver transaction for typed code admission", async () => {
    const harness = await createHarness();
    const created = await harness.authority.createGrantCode(harness.grantId, {
      kind: "fixture",
      id: "fixture",
    });
    if (created.status !== "created") throw new Error("Expected a Control Grant Code.");
    const wrongScope = await harness.authority.createControlGrant({
      authority: { kind: "fixture", id: "fixture" },
      scope: { ...harness.root.externalScope, pitchSlotId: "wrong-slot" },
    });
    if (wrongScope.status !== "created") throw new Error("Expected wrong-scope Control Grant.");
    const wrongCode = await harness.authority.createGrantCode(wrongScope.grantId, {
      kind: "fixture",
      id: "fixture",
    });
    if (wrongCode.status !== "created") throw new Error("Expected wrong-scope Grant Code.");
    harness.grantOptions.controlScopeResolver = createRuntimeControlScopeResolver(() => 10_000);
    expect(
      await harness.authority.admitControlGrantCode({
        grantCode: created.code,
        browserContext: "production-resolver-controller",
      }),
    ).toMatchObject({ status: "admitted", eventGameId: harness.root.eventGameId });
    expect(
      await harness.authority.admitControlGrantCode({
        grantCode: wrongCode.code,
        browserContext: "production-resolver-wrong-scope",
      }),
    ).toEqual({
      status: "rejected",
      code: "grant-admission-failed",
      message: "Unable to admit this Grant.",
    });
  });

  test("rejects a non-Control Grant Code before Controller session admission", async () => {
    const harness = await createHarness();
    const eventAdmin = await harness.authority.createEventAdminGrant({
      authority: { kind: "fixture", id: "fixture" },
      scope: {
        eventId: harness.root.eventId,
        eventTimeZone: "UTC",
        finalGameDayDate: "2026-08-14",
      },
    });
    if (eventAdmin.status !== "created") throw new Error("Expected Event Admin Grant.");
    const code = await harness.authority.createGrantCode(eventAdmin.grantId, {
      kind: "fixture",
      id: "fixture",
    });
    if (code.status !== "created") throw new Error("Expected Event Admin Grant Code.");

    const opened = await harness.control.openController({
      grantCode: code.code,
      browserContext: "wrong-controller-type",
    });
    expect(opened).toEqual({
      status: "rejected",
      message: "Unable to open Controller experience.",
    });
    expect(
      await harness.authority.listGrantSessions(eventAdmin.grantId, {
        kind: "fixture",
        id: "fixture",
      }),
    ).toMatchObject({ status: "ok", value: [] });
  });
});

async function createHarness(
  overrides: {
    eventGameId?: string;
    grantEventGameId?: string;
    grantExpiresAtMs?: number | null;
    failureBoundary?: "after-action" | "after-lifecycle";
    projectionFailure?: () => boolean;
    scopeStatus?: "empty" | "conflict";
    controlClock?: () => number;
    sessionResolution?: ControlGrantSessionResolution;
  } = {},
) {
  const root = createRoot(overrides.eventGameId ?? "game-live-control");
  const reassignedRoot = createRoot("game-reassigned", "reassigned");
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
  if (overrides.sessionResolution !== undefined)
    grantOptions.setSessionResolution(overrides.sessionResolution);
  let lifecycleNotifications = 0;
  let triggerLifecycleChange = () => {};
  grantOptions.onLifecycleChange = () => {
    lifecycleNotifications += 1;
    triggerLifecycleChange();
  };

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
  const reassignedRecord = createEventGameRecord(storage, {
    externalScopeResolver: createScopeResolver(reassignedRoot),
    interpreter: createLiveEventGameIqaInterpreter(),
    clock: () => grantOptions.clock.nowMs(),
    auditAuthorityVerifier: { verify: () => true },
  });
  if ((await reassignedRecord.registerRoot(reassignedRoot)).status !== "registered") {
    throw new Error("Expected the reassigned Event Game Record root to register.");
  }
  const acceptance = createFoundationAcceptance(storage, {
    grant: grantOptions,
    externalScopeResolver: createScopeResolver(root),
    clock: () => grantOptions.clock.nowMs(),
    interpreter: createLiveEventGameIqaInterpreter(),
    failureInjector: (boundary) => {
      if (boundary === failureBoundary) throw new Error("simulated durable failure");
    },
    validateActionInTransaction: ({ transaction, root, action }) =>
      validateLiveEventGameActionInTransaction(
        transaction.listActions(root.recordId),
        root,
        action,
      ),
  });
  const control = createLiveEventGameControl({
    resolveEventGameRecord: async (eventGameId) =>
      eventGameId === root.eventGameId
        ? { recordId: root.recordId, record }
        : eventGameId === reassignedRoot.eventGameId
          ? { recordId: reassignedRoot.recordId, record: reassignedRecord }
          : null,
    acceptance,
    grantAuthority: authority,
    clock: overrides.controlClock ?? (() => grantOptions.clock.nowMs()),
    projectionFailure: overrides.projectionFailure,
  });
  triggerLifecycleChange = () => {
    void control.reconcileActiveControllerSessions();
  };
  return {
    root,
    storage,
    record,
    control,
    authority,
    grantOptions,
    grantId: created.grantId,
    qrCredential: created.qrCredential,
    sessionBearer: admitted.sessionBearer,
    get lifecycleNotifications() {
      return lifecycleNotifications;
    },
    triggerLifecycleChange() {
      grantOptions.onLifecycleChange?.();
    },
    set failureBoundary(value: typeof failureBoundary) {
      failureBoundary = value;
    },
    setNow(value: number) {
      grantOptions.setNow(value);
    },
    setScopeStatus(value: "empty" | "conflict" | undefined) {
      grantOptions.setScopeStatus(value);
    },
    setScopeEventGameId(value: string) {
      grantOptions.setScopeEventGameId(value);
    },
    setSessionResolution(value: ControlGrantSessionResolution | undefined) {
      grantOptions.setSessionResolution(value);
    },
  };
}

function goalIntent(
  overrides: {
    gameSideId?: string;
    operationId?: string;
    factId?: string;
    gameTimeMs?: number;
  } = {},
) {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "record-goal",
    operationId: overrides.operationId ?? "operation-goal",
    factId: overrides.factId ?? "fact-goal",
    gameSideId: overrides.gameSideId ?? "side-a",
    gameTimeMs: overrides.gameTimeMs ?? 12_000,
    occurrence: { clientOriginAtMs: 10_000 },
  };
}

function correctionIntent(
  operationId: string,
  factId: string,
  effective: boolean,
  targetFactId = "fact-goal",
) {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "correct-fact" as const,
    operationId,
    factId,
    targetFactId,
    effective,
    gameTimeMs: 13_000,
    occurrence: { clientOriginAtMs: 13_000, source: "offline" as const },
  };
}

function clockCorrectionIntent(operationId: string) {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "clock-correction" as const,
    operationId,
    factId: `fact-${operationId}`,
    clockTimeMs: 1_000,
    gameTimeMs: 0,
    occurrence: { clientOriginAtMs: null },
  };
}

function clockIntent(
  operationId: string,
  running: boolean,
  options: { source?: "online" | "offline"; clockGeneration?: number } = {},
) {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "clock" as const,
    operationId,
    factId: `fact-${operationId}`,
    running,
    gameTimeMs: 0,
    occurrence: {
      clientOriginAtMs: null,
      ...(options.source === undefined ? {} : { source: options.source }),
    },
    ...(options.clockGeneration === undefined ? {} : { clockGeneration: options.clockGeneration }),
  };
}

function clockAdjustmentIntent(operationId: string, adjustmentMs: number) {
  return {
    ...clockIntent(operationId, false),
    type: "clock-adjust" as const,
    adjustmentMs,
  };
}

function substantiveIntent(
  operationId: string,
  trigger: "card" | "timeout" | "suspension" | "result" | "heat-stoppage",
) {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "substantive" as const,
    trigger,
    operationId,
    factId: `fact-${operationId}`,
    gameTimeMs: 0,
    occurrence: { clientOriginAtMs: null },
  };
}

function simpleIntent(operationId: string, type: "reset" | "undo") {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type,
    operationId,
    factId: `fact-${operationId}`,
    gameTimeMs: 0,
    occurrence: { clientOriginAtMs: null },
  } as const;
}

type TestGrantOptions = GrantAuthorityOptions & {
  setNow: (value: number) => void;
  setScopeStatus: (value: "empty" | "conflict" | undefined) => void;
  setScopeEventGameId: (value: string) => void;
  setSessionResolution: (value: ControlGrantSessionResolution | undefined) => void;
};

function createGrantOptions(eventGameId: string): TestGrantOptions {
  let call = 0;
  let nowMs = 10_000;
  let scopeStatus: "empty" | "conflict" | undefined;
  let resolvedEventGameId = eventGameId;
  let sessionResolution: ControlGrantSessionResolution | undefined;
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
      resolveSession: (_scope, sessionEventGameId) =>
        sessionResolution ??
        (sessionEventGameId === resolvedEventGameId
          ? { status: "current", eventGameId: resolvedEventGameId }
          : { status: "mismatch" }),
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
    setSessionResolution(value) {
      sessionResolution = value;
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

function createRoot(eventGameId: string, sideSuffix = ""): EventGameRecordRoot {
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
      {
        id: `side-a${sideSuffix}`,
        eventTeamId: `team-a${sideSuffix}`,
        teamInterpretationRef: `team-a${sideSuffix}-v1`,
      },
      {
        id: `side-b${sideSuffix}`,
        eventTeamId: `team-b${sideSuffix}`,
        teamInterpretationRef: `team-b${sideSuffix}-v1`,
      },
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
