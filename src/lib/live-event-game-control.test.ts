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
  validateLiveEventClockActionInTransaction,
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
      validateLiveEventClockActionInTransaction(transaction.listActions(root.recordId), action),
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
    setSessionResolution(value: ControlGrantSessionResolution | undefined) {
      grantOptions.setSessionResolution(value);
    },
  };
}

function goalIntent(
  overrides: { gameSideId?: string; operationId?: string; factId?: string } = {},
) {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "record-goal",
    operationId: overrides.operationId ?? "operation-goal",
    factId: overrides.factId ?? "fact-goal",
    gameSideId: overrides.gameSideId ?? "side-a",
    gameTimeMs: 12_000,
    occurrence: { clientOriginAtMs: 10_000 },
  };
}

function clockIntent(operationId: string, running: boolean) {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "clock" as const,
    operationId,
    factId: `fact-${operationId}`,
    running,
    gameTimeMs: 0,
    occurrence: { clientOriginAtMs: null },
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
  trigger: "card" | "timeout" | "suspension" | "result",
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
