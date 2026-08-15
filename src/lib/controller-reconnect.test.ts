import { describe, expect, test } from "bun:test";
import {
  buildControllerReplayBatch,
  createControllerReplica,
  dispatchControllerClockAction,
  dispatchControllerAction,
  loadControllerReplica,
  prepareControllerReplayBatch,
  parseControllerReplica,
  persistControllerReplica,
  rebindControllerReplica,
  reconcileControllerReplay,
  serializeControllerReplica,
  type ControllerReplicaStorage,
} from "@/lib/controller-reconnect";
import { LIVE_EVENT_CONTROL_INTENT_VERSION } from "@/lib/live-event-game-control";
import { createInitialClockBaseline, projectClockBaseline } from "@/lib/clock-authority";

describe("Controller reconnect replica", () => {
  test("optimistically retains immutable identity, causal dependencies, and original occurrence evidence", () => {
    let state = createReplica();
    const first = dispatchControllerAction(state, goal("goal-1", "fact-1"), { nowMs: 100 });
    state = first.state;
    const second = dispatchControllerAction(state, goal("goal-2", "fact-2"), {
      nowMs: 101,
      causalPredecessorIds: [first.action.intent.operationId],
    });
    state = second.state;

    expect(state.projection.scoreByGameSide).toEqual({ "side-a": 20, "side-b": 0 });
    expect(state.pendingActions.map((action) => action.counter)).toEqual([1, 2]);
    expect(state.pendingActions[0]?.intent.occurrence).toEqual({
      clientOriginAtMs: 42,
      source: "offline",
    });
    expect(second.action.causalPredecessorIds).toEqual([first.action.intent.operationId]);
    expect(buildControllerReplayBatch(state)?.actions).toHaveLength(2);
  });

  test("optimistically applies every ordinary Controller action family with existing lifecycle semantics", () => {
    for (const trigger of ["card", "timeout", "suspension"] as const) {
      const next = dispatchControllerAction(
        createReplica(),
        substantive(`substantive-${trigger}`, trigger),
        { nowMs: 100 },
      ).state;
      expect(next.projection.phase).toBe("in-progress");
      expect(next.projection.commencement.status).toBe("commenced");
    }
    const finished = dispatchControllerAction(
      createReplica(),
      substantive("substantive-result", "result"),
      { nowMs: 101 },
    ).state;
    expect(finished.projection.phase).toBe("finished");
    const resetState = dispatchControllerAction(createReplica(), reset("reset", "reset-fact"), {
      nowMs: 102,
    }).state;
    const undoState = dispatchControllerAction(createReplica(), reset("undo", "undo-fact"), {
      nowMs: 103,
    }).state;
    expect(resetState.pendingActions).toHaveLength(1);
    expect(undoState.pendingActions).toHaveLength(1);
    expect(resetState.projection.phase).toBe("scheduled");
    expect(undoState.projection.phase).toBe("scheduled");
  });

  test("keeps mixed causal optimistic effects while unrelated actions progress", () => {
    let state = createReplica();
    const card = dispatchControllerAction(state, substantive("card", "card"), { nowMs: 100 });
    state = card.state;
    state = dispatchControllerAction(state, goal("unrelated-goal", "unrelated-fact"), {
      nowMs: 101,
    }).state;
    state = dispatchControllerAction(state, substantive("result", "result"), {
      nowMs: 102,
      causalPredecessorIds: [card.action.intent.operationId],
    }).state;
    expect(state.projection).toMatchObject({ phase: "finished", goalCount: 1 });
    expect(state.pendingActions.map((action) => action.intent.operationId)).toEqual([
      "card",
      "unrelated-goal",
      "result",
    ]);
  });

  test("reconciles explicit outcomes without deleting retryable or causally blocked evidence", () => {
    let state = createReplica();
    state = dispatchControllerAction(state, goal("accepted", "fact-a"), { nowMs: 100 }).state;
    state = dispatchControllerAction(state, goal("retry", "fact-b"), { nowMs: 101 }).state;
    state = dispatchControllerAction(state, goal("blocked", "fact-c"), {
      nowMs: 102,
      causalPredecessorIds: ["retry"],
    }).state;
    const prepared = prepareControllerReplayBatch(state);
    if (prepared === null) throw new Error("Expected replay batch.");
    const reconciled = reconcileControllerReplay(prepared.state, {
      batchId: prepared.batch.batchId,
      replicaGeneration: prepared.batch.replicaGeneration,
      session: prepared.batch.session,
      eventGameId: prepared.batch.eventGameId,
      status: "retryable",
      projection: state.projection,
      outcomes: [
        { operationId: "accepted", status: "accepted" },
        { operationId: "retry", status: "retryable" },
        { operationId: "blocked", status: "causally-blocked" },
      ],
    });
    expect(reconciled.outcomes).toMatchObject({
      accepted: "accepted",
      retry: "retryable",
      blocked: "causally-blocked",
    });
    expect(reconciled.pendingActions.map((action) => action.intent.operationId)).toEqual([
      "retry",
      "blocked",
    ]);
  });

  test("adopts the durable projection, reapplies retryable work, and holds finished evidence", () => {
    let state = createReplica();
    state = dispatchControllerAction(state, goal("accepted", "fact-a"), { nowMs: 100 }).state;
    state = dispatchControllerAction(state, goal("retry", "fact-b"), { nowMs: 101 }).state;
    const prepared = prepareControllerReplayBatch(state);
    if (prepared === null) throw new Error("Expected replay batch.");
    const reconciled = reconcileControllerReplay(prepared.state, {
      batchId: prepared.batch.batchId,
      replicaGeneration: prepared.batch.replicaGeneration,
      session: prepared.batch.session,
      eventGameId: prepared.batch.eventGameId,
      status: "retryable",
      projection: {
        ...state.projection,
        goalCount: 1,
        scoreByGameSide: { "side-a": 10, "side-b": 0 },
      },
      outcomes: [
        { operationId: "accepted", status: "accepted" },
        { operationId: "retry", status: "retryable" },
      ],
    });
    expect(reconciled.projection.goalCount).toBe(2);
    expect(reconciled.pendingActions.map((action) => action.intent.operationId)).toEqual(["retry"]);

    const held = reconcileControllerReplay(
      {
        ...prepared.state,
        pendingActions: prepared.state.pendingActions.map((action) => ({ ...action })),
      },
      {
        ...prepared.batch,
        status: "synchronized",
        outcomes: prepared.batch.actions.map((action) => ({
          operationId: action.intent.operationId,
          status: "held-for-correction" as const,
        })),
        projection: state.projection,
      },
    );
    expect(held.pendingActions.every((action) => action.status === "held-for-correction")).toBe(
      true,
    );
    expect(buildControllerReplayBatch(held)).toBeNull();
  });

  test("ignores a delayed response after the replica is rebound and rejects Clock reconnect work", () => {
    let state = createReplica();
    state = dispatchControllerAction(state, goal("goal-a", "fact-a"), { nowMs: 100 }).state;
    const prepared = prepareControllerReplayBatch(state);
    if (prepared === null) throw new Error("Expected replay batch.");
    const rebound = rebindControllerReplica(
      prepared.state,
      { ...prepared.state.session, grantVersion: "grant-version-2" },
      prepared.state.projection,
    );
    const response = {
      ...prepared.batch,
      status: "synchronized" as const,
      outcomes: [{ operationId: "goal-a", status: "accepted" as const }],
      projection: prepared.state.projection,
    };
    expect(reconcileControllerReplay(rebound, response)).toBe(rebound);
    expect(() =>
      dispatchControllerAction(rebound, {
        version: LIVE_EVENT_CONTROL_INTENT_VERSION,
        type: "clock",
        operationId: "clock-a",
        factId: "clock-fact",
        running: true,
        gameTimeMs: 0,
        occurrence: { clientOriginAtMs: 100 },
      }),
    ).toThrow("Clock reconnect belongs to Clock Authority");
  });

  test("keeps disconnected clock authority with the holder and permits deliberate admitted takeover", () => {
    const holder = createReplica();
    const queued = dispatchControllerClockAction(holder, clock("offline-clock", true), {
      nowMs: 200,
    });
    expect(queued.state.projection.clock.running).toBe(true);
    expect(queued.state.pendingActions).toHaveLength(1);

    expect(() =>
      dispatchControllerClockAction(
        createReplica({ grantSessionId: "session-2" }),
        clock("non-holder-clock", true),
      ),
    ).toThrow("Offline Clock Holder");

    const takeover = dispatchControllerClockAction(
      createReplica({ grantSessionId: "session-2" }),
      {
        ...clock("takeover", false),
        type: "clock-takeover" as const,
        clockTimeMs: 5_000,
        authorityGeneration: 1,
        confirmation: "physical-timekeeper-or-head-referee" as const,
      },
      { nowMs: 300 },
    );
    expect(takeover.state.projection.clock).toMatchObject({
      gameTimeMs: 5_000,
      synchronization: "stale",
      baseline: { authorityGeneration: 2, holderGrantSessionId: "session-2" },
    });
  });

  test("fails closed for disconnected clock actions before an Offline Clock Holder exists", () => {
    const state = createControllerReplica({
      eventGameId: "game-1",
      grantSessionId: "session-without-holder",
      grantVersion: "grant-version-1",
      deviceId: "device-1",
      projection: {
        eventGameId: "game-1",
        phase: "scheduled",
        scoreByGameSide: { "side-a": 0, "side-b": 0 },
        goalCount: 0,
        clock: projectClockBaseline(createInitialClockBaseline(), 0),
        commencement: {
          status: "provisional",
          commencedAtMs: null,
          provisionalRunningSinceMs: null,
          provisionalElapsedMs: 0,
        },
      },
    });

    expect(() => dispatchControllerClockAction(state, clock("no-holder", true))).toThrow(
      "Offline Clock Holder",
    );
    expect(state.pendingActions).toHaveLength(0);
    expect(state.projection.clock.gameTimeMs).toBe(0);
  });

  test("derives optimism exactly once across null and authoritative rebinds", () => {
    let state = createReplica();
    state = dispatchControllerAction(state, goal("goal-rebind", "fact-goal-rebind"), {
      nowMs: 100,
    }).state;
    state = dispatchControllerAction(state, substantive("card-rebind", "card"), {
      nowMs: 101,
    }).state;
    state = dispatchControllerAction(state, substantive("timeout-rebind", "timeout"), {
      nowMs: 102,
    }).state;
    const optimistic = structuredClone(state.projection);
    expect(optimistic).toMatchObject({
      phase: "in-progress",
      scoreByGameSide: { "side-a": 10, "side-b": 0 },
      goalCount: 1,
    });

    const firstNullRebind = rebindControllerReplica(
      state,
      { ...state.session, grantSessionId: "session-2", grantVersion: "grant-version-2" },
      null,
    );
    expect(firstNullRebind.authoritativeProjection).toEqual(state.authoritativeProjection);
    expect(firstNullRebind.projection).toEqual(optimistic);

    const secondNullRebind = rebindControllerReplica(
      firstNullRebind,
      { ...firstNullRebind.session, grantVersion: "grant-version-3" },
      null,
    );
    expect(secondNullRebind.projection).toEqual(optimistic);

    const authoritative = {
      ...state.authoritativeProjection,
      scoreByGameSide: { "side-a": 20, "side-b": 0 },
      goalCount: 2,
    };
    const replaced = rebindControllerReplica(
      secondNullRebind,
      { ...secondNullRebind.session, grantVersion: "grant-version-4" },
      authoritative,
    );
    expect(replaced.authoritativeProjection).toEqual(authoritative);
    expect(replaced.projection).toMatchObject({
      phase: "in-progress",
      scoreByGameSide: { "side-a": 30, "side-b": 0 },
      goalCount: 3,
    });

    const restored = parseControllerReplica(
      JSON.parse(serializeControllerReplica(replaced)),
      "game-1",
    );
    expect(restored.authoritativeProjection).toEqual(authoritative);
    expect(restored.projection).toEqual(replaced.projection);
    const corrupted = JSON.parse(serializeControllerReplica(replaced)) as Record<string, any>;
    corrupted.projection.goalCount += 1;
    expect(() => parseControllerReplica(corrupted, "game-1")).toThrow(
      "optimistic projection is inconsistent",
    );
  });

  test("rejects malformed, duplicate, and unknown causal predecessors without weakening the action", () => {
    const state = createReplica();
    const candidate = goal("goal-a", "fact-a");
    expect(() =>
      dispatchControllerAction(state, candidate, {
        causalPredecessorIds: [null as unknown as string],
      }),
    ).toThrow();
    expect(() =>
      dispatchControllerAction(state, candidate, {
        causalPredecessorIds: ["missing", "missing"],
      }),
    ).toThrow();
    expect(() =>
      dispatchControllerAction(state, candidate, { causalPredecessorIds: ["missing"] }),
    ).toThrow();
  });

  test("keeps one stable batch across lost transport and accepts reordered outcomes", () => {
    let state = createReplica();
    state = dispatchControllerAction(state, goal("first", "fact-first"), { nowMs: 100 }).state;
    state = dispatchControllerAction(state, goal("second", "fact-second"), {
      nowMs: 101,
      causalPredecessorIds: ["first"],
    }).state;
    const firstBatch = prepareControllerReplayBatch(state);
    if (firstBatch === null) throw new Error("Expected replay batch.");
    expect(prepareControllerReplayBatch(firstBatch.state)?.batch.batchId).toBe(
      firstBatch.batch.batchId,
    );
    expect(
      reconcileControllerReplay(firstBatch.state, {
        ...firstBatch.batch,
        status: "synchronized",
        outcomes: [
          { operationId: "second", status: "accepted" },
          { operationId: "first", status: "accepted" },
        ],
        projection: { ...state.projection, goalCount: 2 },
      }).pendingActions,
    ).toHaveLength(0);
  });

  test("quarantines duplicate and inconsistent retained counters", () => {
    let state = createReplica();
    state = dispatchControllerAction(state, goal("goal-a", "fact-a"), { nowMs: 100 }).state;
    state = dispatchControllerAction(state, goal("goal-b", "fact-b"), { nowMs: 101 }).state;
    const encoded = JSON.parse(serializeControllerReplica(state)) as Record<string, any>;
    const duplicateCounter = structuredClone(encoded);
    duplicateCounter.pendingActions[1].counter = duplicateCounter.pendingActions[0].counter;
    duplicateCounter.pendingActions[1].identity.counter =
      duplicateCounter.pendingActions[0].counter;
    expect(() => parseControllerReplica(duplicateCounter, "game-1")).toThrow();
    const repairedCounter = structuredClone(encoded);
    repairedCounter.identity.nextCounter = 2;
    expect(() => parseControllerReplica(repairedCounter, "game-1")).toThrow();
  });

  test("rejects corrupt, cross-Game, cyclic, and malformed persisted state", () => {
    const state = createReplica();
    const encoded = JSON.parse(serializeControllerReplica(state)) as Record<string, unknown>;
    expect(() =>
      parseControllerReplica({ ...encoded, eventGameId: "another-game" }, "game-1"),
    ).toThrow();
    expect(() => parseControllerReplica({ ...encoded, version: "future" }, "game-1")).toThrow();
    expect(() =>
      parseControllerReplica(
        { ...encoded, projection: { ...state.projection, eventGameId: "another-game" } },
        "game-1",
      ),
    ).toThrow();
  });

  test("quarantines corrupt storage and reports quota failure without silent eviction", () => {
    let quarantined: string | null = null;
    const corruptStorage: ControllerReplicaStorage = {
      read: () => "{not-json",
      write: () => undefined,
      quarantine: (value) => {
        quarantined = value;
      },
    };
    expect(loadControllerReplica(corruptStorage, "game-1")).toMatchObject({
      state: null,
      quarantined: true,
    });
    expect(String(quarantined)).toBe("{not-json");

    const state = createReplica();
    const fullStorage: ControllerReplicaStorage = {
      read: () => null,
      write: () => {
        throw new Error("quota");
      },
    };
    const memoryOnly = persistControllerReplica(state, fullStorage);
    expect(memoryOnly).toMatchObject({
      state: { durability: "memory-only" },
      warning: expect.stringContaining("full"),
    });
    expect(
      dispatchControllerAction(memoryOnly.state, goal("after-quota", "fact-after-quota")).state,
    ).toMatchObject({ pendingActions: [{ status: "pending" }] });
  });

  test("retains 10,000 stable identities deterministically", () => {
    let state = createReplica();
    for (let index = 0; index < 10_000; index += 1) {
      state = dispatchControllerAction(state, reset(`operation-${index}`, `fact-${index}`), {
        nowMs: index,
      }).state;
    }
    expect(state.pendingActions).toHaveLength(10_000);
    expect(state.identity.nextCounter).toBe(10_001);
    expect(
      parseControllerReplica(JSON.parse(serializeControllerReplica(state)), "game-1")
        .pendingActions,
    ).toHaveLength(10_000);
  });
});

function createReplica(input: { grantSessionId?: string } = {}) {
  const baseline = createInitialClockBaseline();
  baseline.holderGrantSessionId = "session-1";
  baseline.holderGeneration = 1;
  baseline.authorityGeneration = 1;
  return createControllerReplica({
    eventGameId: "game-1",
    grantSessionId: input.grantSessionId ?? "session-1",
    grantVersion: "grant-version-1",
    deviceId: "device-1",
    projection: {
      eventGameId: "game-1",
      phase: "scheduled",
      scoreByGameSide: { "side-a": 0, "side-b": 0 },
      goalCount: 0,
      clock: projectClockBaseline(baseline, 0),
      commencement: {
        status: "provisional",
        commencedAtMs: null,
        provisionalRunningSinceMs: null,
        provisionalElapsedMs: 0,
      },
    },
  });
}

function clock(operationId: string, running: boolean) {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "clock" as const,
    operationId,
    factId: `fact-${operationId}`,
    running,
    gameTimeMs: 0,
    occurrence: { clientOriginAtMs: null, source: "offline" as const },
  };
}

function goal(operationId: string, factId: string) {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "record-goal" as const,
    operationId,
    factId,
    gameSideId: "side-a",
    gameTimeMs: 42,
    occurrence: { clientOriginAtMs: 42, source: "offline" as const },
  };
}

function reset(operationId: string, factId: string) {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "reset" as const,
    operationId,
    factId,
    gameTimeMs: 0,
    occurrence: { clientOriginAtMs: 0, source: "offline" as const },
  };
}

function substantive(operationId: string, trigger: "card" | "timeout" | "suspension" | "result") {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "substantive" as const,
    trigger,
    operationId,
    factId: `fact-${operationId}`,
    gameTimeMs: 0,
    occurrence: { clientOriginAtMs: 0, source: "offline" as const },
  };
}
