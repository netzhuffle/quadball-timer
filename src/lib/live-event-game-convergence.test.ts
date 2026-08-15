import { describe, expect, test } from "bun:test";
import {
  createControlActionCodecRegistry,
  createDefaultControlActionCodecs,
  materializeControlAction,
  prepareControlAction,
  rebuildControlActionHistory,
  type ActionJsonValue,
  type ControlActionInput,
} from "@/lib/event-game-actions";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import {
  canonicalizeGamePresentationChange,
  fingerprintGamePresentationChange,
  orderGamePresentationChanges,
  type StoredGamePresentationChange,
} from "@/lib/game-presentation";
import { deriveGamePresentation } from "@/lib/game-presentation-projection";
import {
  createLiveEventGameIqaInterpreter,
  LIVE_EVENT_IQA_INTERPRETER_VERSION,
  LIVE_SUSPENSION_SNAPSHOT_VERSION,
  type LiveEventGameDerivedState,
} from "@/lib/live-event-game-control";

type LiveControlMatrixEntry = {
  name: string;
  ordinaryEvidence: string;
  operationIds: readonly string[];
  expectedBaseline: object;
  observe(eventGameId: string, arrivalOrder: readonly string[]): unknown;
};

const LIVE_NONCOMMUTATIVE_MATRIX: readonly LiveControlMatrixEntry[] = [
  liveScenario({
    name: "clock transitions / correction / Offline Clock Holder",
    ordinaryEvidence:
      "serializes simultaneous clock transitions, transfers the holder, and ignores goal transfer",
    operationIds: ["clock-start", "clock-correct", "clock-pause"],
    build: (root) => [
      fact(root, {
        operationId: "clock-start",
        factType: "clock",
        factId: "fact-clock-start",
        gameTimeMs: 0,
        trustedAtMs: 1_000,
        sessionId: "controller-a",
        data: { command: "set-running", running: true, startedAtMs: 1_000, sportingOrder: 0 },
      }),
      fact(root, {
        operationId: "clock-correct",
        factType: "clock",
        factId: "fact-clock-correct",
        gameTimeMs: 5_000,
        trustedAtMs: 2_000,
        sessionId: "controller-a",
        causalPredecessorIds: ["clock-start"],
        data: {
          command: "correct",
          gameTimeMs: 5_000,
          authorityGeneration: 1,
          sportingOrder: 5_000,
        },
      }),
      fact(root, {
        operationId: "clock-pause",
        factType: "clock",
        factId: "fact-clock-pause",
        gameTimeMs: 5_000,
        trustedAtMs: 3_000,
        sessionId: "controller-b",
        causalPredecessorIds: ["clock-correct"],
        data: {
          command: "set-running",
          running: false,
          authorityGeneration: 2,
          startedAtMs: 1_000,
          sportingOrder: 5_000,
        },
      }),
    ],
    project: (state) => stableClockProjection(state.clock),
    expectedProjection: {
      running: false,
      gameTimeMs: 6_000,
      offlineClockHolderGrantSessionId: "controller-b",
      baseline: { running: false, gameTimeMs: 6_000, holderGrantSessionId: "controller-b" },
    },
  }),
  liveScenario({
    name: "goal / flag-catch close play / result lifecycle",
    ordinaryEvidence: "requires Head Referee order for close-play goal and catch and follows it",
    operationIds: ["close-goal", "close-catch"],
    build: (root) => [
      fact(root, {
        operationId: "close-goal",
        factType: "goal",
        factId: "fact-close-goal",
        gameSideId: "side-a",
        gameTimeMs: 1_199_500,
        trustedAtMs: 1_000,
        data: { points: 10, sportingOrder: 1_199_500 },
      }),
      fact(root, {
        operationId: "close-catch",
        factType: "flag-catch",
        factId: "fact-close-catch",
        gameSideId: "side-b",
        gameTimeMs: 1_200_000,
        trustedAtMs: 2_000,
        data: {
          points: 30,
          sportingOrder: 1_200_000,
          sportingOrderAdjudication: { relatedFactId: "fact-close-goal", relation: "after" },
        },
      }),
    ],
    project: (state) => ({
      phase: state.phase,
      scoreByGameSide: state.scoreByGameSide,
      catch: state.catch,
      result: state.result,
      winnerGameSideId: state.winnerGameSideId,
    }),
    expectedProjection: {
      phase: "finished",
      scoreByGameSide: { "side-a": 10, "side-b": 30 },
      catch: { factId: "fact-close-catch", catchingGameSideId: "side-b" },
      winnerGameSideId: "side-b",
    },
  }),
  liveScenario({
    name: "card / opposing goal / durable score release",
    ordinaryEvidence: "materializes an automatic consequence when a late card precedes a score",
    operationIds: ["penalty-card", "penalty-goal", "penalty-release"],
    build: (root) => [
      fact(root, {
        operationId: "penalty-card",
        factType: "card",
        factId: "fact-penalty-card",
        gameSideId: "side-b",
        gameTimeMs: 1_000,
        trustedAtMs: 1_000,
        data: {
          cardType: "blue",
          playerNumber: 7,
          penaltyStart: "immediate",
          sportingOrder: 1_000,
        },
      }),
      fact(root, {
        operationId: "penalty-goal",
        factType: "goal",
        factId: "fact-penalty-goal",
        gameSideId: "side-a",
        gameTimeMs: 2_000,
        trustedAtMs: 2_000,
        causalPredecessorIds: ["penalty-card"],
        data: { points: 10, sportingOrder: 2_000 },
      }),
      fact(root, {
        operationId: "penalty-release",
        factType: "penalty-release-consequence",
        factId: "fact-penalty-release",
        gameSideId: "side-b",
        gameTimeMs: 2_000,
        trustedAtMs: 2_001,
        causalPredecessorIds: ["penalty-card", "penalty-goal"],
        data: {
          sourceFactId: "fact-penalty-goal",
          playerKey: "side-b:7",
          releaseCause: "score",
          releasedMs: 2_000,
          serviceDurationMs: 59_000,
          sportingOrder: 2_000,
        },
      }),
    ],
    project: (state) => ({
      scoreByGameSide: state.scoreByGameSide,
      penalties: state.penalties,
    }),
    expectedProjection: {
      scoreByGameSide: { "side-a": 10, "side-b": 0 },
      penalties: {
        pendingExpirations: [],
        releases: [
          {
            scoreFactId: "fact-penalty-goal",
            playerKey: "side-b:7",
            releaseCause: "score",
          },
        ],
      },
    },
  }),
  liveScenario({
    name: "timeout procedure / suspension start and resume lifecycle",
    ordinaryEvidence:
      "rebuilds penalty, timeout, stoppage, heat, and result state through Corrections",
    operationIds: ["timeout-stoppage", "timeout-start", "suspend", "resume"],
    build: (root) => [
      fact(root, {
        operationId: "timeout-stoppage",
        factType: "timeout",
        factId: "fact-timeout-stoppage",
        gameSideId: "side-a",
        gameTimeMs: 3_000,
        trustedAtMs: 1_000,
        data: { timeoutAction: "stoppage", timeoutGameSideId: "side-a", sportingOrder: 3_000 },
      }),
      fact(root, {
        operationId: "timeout-start",
        factType: "timeout",
        factId: "fact-timeout-start",
        gameSideId: "side-a",
        gameTimeMs: 3_000,
        trustedAtMs: 2_000,
        causalPredecessorIds: ["timeout-stoppage"],
        data: {
          timeoutAction: "start",
          timeoutGameSideId: "side-a",
          timeoutStartedAtMs: 2_000,
          sportingOrder: 3_001,
        },
      }),
      fact(root, {
        operationId: "suspend",
        factType: "suspension",
        factId: "fact-suspend",
        gameTimeMs: 4_000,
        trustedAtMs: 3_000,
        causalPredecessorIds: ["timeout-start"],
        data: {
          suspensionAction: "start",
          suspensionSnapshot: suspensionSnapshot(4_000),
          sportingOrder: 4_000,
        },
      }),
      fact(root, {
        operationId: "resume",
        factType: "suspension",
        factId: "fact-resume",
        gameTimeMs: 4_000,
        trustedAtMs: 4_000,
        causalPredecessorIds: ["suspend"],
        data: {
          suspensionAction: "resume",
          resumesSuspensionFactId: "fact-suspend",
          sportingOrder: 4_001,
        },
      }),
    ],
    project: (state) => ({
      phase: state.phase,
      timeout: state.timeout,
      suspension: state.suspension,
      stoppage: state.stoppage,
    }),
    expectedProjection: {
      phase: "in-progress",
      timeout: { status: "started", factId: "fact-timeout-start", gameSideId: "side-a" },
      suspension: { status: "none", factId: null },
      stoppage: { status: "none", factId: null },
    },
  }),
  liveScenario({
    name: "Heat Stoppage Mode / durable trigger / Head Referee decision",
    ordinaryEvidence:
      "freezes Game Day Heat Stoppage Mode at commencement and carries durable trigger obligations",
    operationIds: ["heat-mode", "heat-trigger", "heat-start"],
    build: (root) => [
      fact(root, {
        operationId: "heat-mode",
        factType: "heat-mode",
        factId: "fact-heat-mode",
        gameTimeMs: 0,
        trustedAtMs: 1_000,
        system: true,
        data: { enabled: true, source: "game-day", frozenAtCommencementMs: 0, sportingOrder: 0 },
      }),
      fact(root, {
        operationId: "heat-trigger",
        factType: "heat-trigger",
        factId: "heat-trigger-900000",
        gameTimeMs: 900_000,
        trustedAtMs: 2_000,
        causalPredecessorIds: ["heat-mode"],
        system: true,
        data: {
          triggerId: "heat-trigger-900000",
          triggerGameTimeMs: 900_000,
          sportingOrder: 900_000,
        },
      }),
      fact(root, {
        operationId: "heat-start",
        factType: "heat-stoppage",
        factId: "fact-heat-start",
        gameTimeMs: 900_000,
        trustedAtMs: 3_000,
        causalPredecessorIds: ["heat-trigger"],
        data: {
          trigger: "heat-stoppage",
          heatAction: "start",
          heatSequence: 1,
          heatTriggerId: "heat-trigger-900000",
          triggerGameTimeMs: 900_000,
          sportingOrder: 900_000,
        },
      }),
    ],
    project: (state) => ({ heat: state.heat, stoppage: state.stoppage }),
    expectedProjection: {
      heat: {
        status: "started",
        mode: "enabled",
        factId: "fact-heat-start",
        activeTriggerId: "heat-trigger-900000",
      },
      stoppage: { status: "heat-stoppage", factId: "fact-heat-start" },
    },
  }),
  presentationScenario(),
  liveScenario({
    name: "finish / late sporting Fact / Correction and reinstatement",
    ordinaryEvidence:
      "atomically reconciles durable finish lifecycle through late scoring and catch Correction",
    operationIds: ["finish", "late-goal", "finish-correction", "finish-reinstatement"],
    build: (root) => [
      fact(root, {
        operationId: "finish",
        factType: "result",
        factId: "fact-finish",
        gameTimeMs: 10_000,
        trustedAtMs: 1_000,
        data: { resultKind: "result", winnerGameSideId: "side-a", sportingOrder: 10_000 },
      }),
      fact(root, {
        operationId: "late-goal",
        factType: "goal",
        factId: "fact-late-goal",
        gameSideId: "side-b",
        gameTimeMs: 9_000,
        trustedAtMs: 2_000,
        data: { points: 10, sportingOrder: 9_000 },
      }),
      correction(root, {
        operationId: "finish-correction",
        correctionId: "correction-finish",
        targetFactId: "fact-finish",
        effective: false,
        trustedAtMs: 3_000,
        causalPredecessorIds: ["finish"],
      }),
      correction(root, {
        operationId: "finish-reinstatement",
        correctionId: "reinstatement-finish",
        targetFactId: "fact-finish",
        effective: true,
        trustedAtMs: 4_000,
        causalPredecessorIds: ["finish-correction"],
      }),
    ],
    project: (state) => ({
      phase: state.phase,
      scoreByGameSide: state.scoreByGameSide,
      result: state.result,
      winnerGameSideId: state.winnerGameSideId,
      effectiveFacts: state.gameFacts.map((fact) => ({
        factId: fact.factId,
        effective: fact.effective,
        sportingOrder: fact.sportingOrder,
      })),
    }),
    expectedProjection: {
      phase: "finished",
      scoreByGameSide: { "side-a": 0, "side-b": 10 },
      result: { factId: "fact-finish" },
      winnerGameSideId: "side-a",
      effectiveFacts: [
        { factId: "fact-late-goal", effective: true, sportingOrder: 9_000 },
        { factId: "fact-finish", effective: true, sportingOrder: 10_000 },
      ],
    },
  }),
];

describe("Live Event Game semantic convergence fixture", () => {
  test("audits every live-control noncommutative category across arrival permutations", () => {
    expect(LIVE_NONCOMMUTATIVE_MATRIX.map((entry) => entry.name)).toEqual([
      "clock transitions / correction / Offline Clock Holder",
      "goal / flag-catch close play / result lifecycle",
      "card / opposing goal / durable score release",
      "timeout procedure / suspension start and resume lifecycle",
      "Heat Stoppage Mode / durable trigger / Head Referee decision",
      "Game Presentation same-field ordering",
      "finish / late sporting Fact / Correction and reinstatement",
    ]);
    for (const entry of LIVE_NONCOMMUTATIVE_MATRIX) {
      const permutations = allPermutations(entry.operationIds);
      expect(permutations.length, `${entry.name}: ${entry.ordinaryEvidence}`).toBeGreaterThan(1);
      const baseline = entry.observe(`matrix-${slug(entry.name)}`, entry.operationIds);
      expect(baseline, entry.name).toMatchObject(entry.expectedBaseline);
      for (const permutation of permutations) {
        expect(
          entry.observe(`matrix-${slug(entry.name)}`, permutation),
          `${entry.name}:${permutation.join(",")}`,
        ).toEqual(baseline);
      }
    }
  });
});

function liveScenario(input: {
  name: string;
  ordinaryEvidence: string;
  operationIds: readonly string[];
  build(root: EventGameRecordRoot): readonly ControlActionInput[];
  project(state: LiveEventGameDerivedState): unknown;
  expectedProjection: unknown;
}): LiveControlMatrixEntry {
  return {
    name: input.name,
    ordinaryEvidence: input.ordinaryEvidence,
    operationIds: input.operationIds,
    expectedBaseline: {
      canonicalOrder: input.operationIds,
      derivedGameState: input.expectedProjection,
    },
    observe(eventGameId, arrivalOrder) {
      const root = createLiveRoot(eventGameId);
      const rebuilt = rebuildLiveActions(root, input.build(root), arrivalOrder);
      return {
        canonicalOrder: rebuilt.canonicalActions.map((action) => action.operationId),
        derivedGameState: input.project(rebuilt.derivedGameState as LiveEventGameDerivedState),
      };
    },
  };
}

function presentationScenario(): LiveControlMatrixEntry {
  const operationIds = ["orientation-left", "orientation-right"] as const;
  return {
    name: "Game Presentation same-field ordering",
    ordinaryEvidence: "preserves two same-field races in deterministic order and audit snapshots",
    operationIds,
    expectedBaseline: {
      canonicalOrder: operationIds,
      derivedGameState: { pitchOrientation: "side-a-left" },
    },
    observe(eventGameId, arrivalOrder) {
      const root = createLiveRoot(eventGameId);
      const changes = [
        presentationChange(root, {
          operationId: "orientation-left",
          presentationChangeId: "presentation-left",
          trustedAtMs: 1_000,
          pitchOrientation: "side-b-left",
        }),
        presentationChange(root, {
          operationId: "orientation-right",
          presentationChangeId: "presentation-right",
          trustedAtMs: 2_000,
          pitchOrientation: "side-a-left",
        }),
      ];
      const byOperationId = new Map(changes.map((change) => [change.operationId, change]));
      const arrived = arrivalOrder.map((operationId) => {
        const change = byOperationId.get(operationId);
        if (change === undefined) throw new Error(`Unknown presentation operation: ${operationId}`);
        return { ...change, acceptedAtMs: 100_000 + change.occurrence.trustedAtMs };
      });
      return {
        canonicalOrder: orderGamePresentationChanges(arrived).map((change) => change.operationId),
        derivedGameState: deriveGamePresentation(
          root.gameSides.map((side) => side.id),
          arrived,
        ),
      };
    },
  };
}

function rebuildLiveActions(
  root: EventGameRecordRoot,
  inputs: readonly ControlActionInput[],
  arrivalOrder: readonly string[],
) {
  const registry = createControlActionCodecRegistry(createDefaultControlActionCodecs());
  const byOperationId = new Map(inputs.map((input) => [input.operationId, input]));
  const stored = arrivalOrder.map((operationId) => {
    const actionInput = byOperationId.get(operationId);
    if (actionInput === undefined) throw new Error(`Unknown live operation: ${operationId}`);
    const prepared = prepareControlAction(
      actionInput,
      root,
      registry,
      actionInput.occurrence.trustedAtMs,
    );
    if (!prepared.ok) throw new Error(`${operationId}: ${prepared.error}`);
    return {
      action: materializeControlAction(
        prepared.value,
        100_000 + actionInput.occurrence.trustedAtMs,
      ),
      canonicalContent: prepared.value.canonicalContent,
      contentFingerprint: prepared.value.contentFingerprint,
    };
  });
  const rebuilt = rebuildControlActionHistory(
    root,
    stored,
    registry,
    createLiveEventGameIqaInterpreter(),
  );
  if (rebuilt.status !== "ready") {
    throw new Error(`${rebuilt.reason}: ${rebuilt.detail}`);
  }
  return rebuilt;
}

function fact(
  root: EventGameRecordRoot,
  input: {
    operationId: string;
    factType: string;
    factId: string;
    gameSideId?: string | null;
    gameTimeMs: number;
    trustedAtMs: number;
    data: ActionJsonValue;
    causalPredecessorIds?: readonly string[];
    sessionId?: string;
    system?: boolean;
  },
): ControlActionInput {
  return {
    recordId: root.recordId,
    eventGameId: root.eventGameId,
    operationId: input.operationId,
    kind: { id: "game-fact", version: "1" },
    payload: {
      factId: input.factId,
      factType: input.factType,
      gameSideId: input.gameSideId ?? null,
      gameTimeMs: input.gameTimeMs,
      data: input.data,
    },
    causalPredecessorIds: input.causalPredecessorIds ?? [],
    occurrence: {
      trustedAtMs: input.trustedAtMs,
      clientOriginAtMs: input.trustedAtMs,
      source: "offline",
    },
    grant: input.system
      ? null
      : { sessionId: input.sessionId ?? "controller-a", versionId: "grant-version-1" },
    ...(input.system ? { origin: "system-heat-stoppage" as const } : {}),
    lifecycle: structuredClone(root.lifecycle),
  };
}

function correction(
  root: EventGameRecordRoot,
  input: {
    operationId: string;
    correctionId: string;
    targetFactId: string;
    effective: boolean;
    trustedAtMs: number;
    causalPredecessorIds: readonly string[];
  },
): ControlActionInput {
  return {
    ...fact(root, {
      operationId: input.operationId,
      factType: "correction",
      factId: input.correctionId,
      gameTimeMs: input.trustedAtMs,
      trustedAtMs: input.trustedAtMs,
      causalPredecessorIds: input.causalPredecessorIds,
      data: null,
    }),
    kind: { id: "correction", version: "1" },
    payload: {
      correctionId: input.correctionId,
      targetFactId: input.targetFactId,
      effective: input.effective,
    },
  };
}

function presentationChange(
  root: EventGameRecordRoot,
  input: {
    operationId: string;
    presentationChangeId: string;
    trustedAtMs: number;
    pitchOrientation: "side-a-left" | "side-b-left";
  },
): StoredGamePresentationChange {
  const candidate = {
    recordId: root.recordId,
    eventGameId: root.eventGameId,
    operationId: input.operationId,
    presentationChangeId: input.presentationChangeId,
    change: { type: "pitch-orientation" as const, pitchOrientation: input.pitchOrientation },
    causalPredecessorIds: [],
    occurrence: {
      trustedAtMs: input.trustedAtMs,
      clientOriginAtMs: input.trustedAtMs,
      source: "offline" as const,
    },
    grant: { sessionId: "controller-a", versionId: "grant-version-1" },
  };
  return {
    ...candidate,
    acceptedAtMs: 0,
    canonicalContent: canonicalizeGamePresentationChange(candidate),
    contentFingerprint: fingerprintGamePresentationChange(candidate),
  };
}

function suspensionSnapshot(gameTimeMs: number) {
  return {
    version: LIVE_SUSPENSION_SNAPSHOT_VERSION,
    gameTimeMs,
    scoreByGameSide: { "side-a": 0, "side-b": 0 },
    penalties: { segments: [] },
    volleyballPossession: "side-a",
    dodgeballPossession: { "ball-1": "side-a" },
  };
}

function stableClockProjection(clock: LiveEventGameDerivedState["clock"]) {
  const { lastSynchronizedAtMs: _lastSynchronizedAtMs, baseline, ...projection } = clock;
  const { lastAcceptedAtMs: _lastAcceptedAtMs, ...stableBaseline } = baseline;
  return { ...projection, baseline: stableBaseline };
}

function createLiveRoot(eventGameId: string): EventGameRecordRoot {
  return {
    recordId: `record-${eventGameId}`,
    eventId: "event-live-convergence",
    eventGameId,
    ownership: { eventId: "event-live-convergence", eventGameId },
    externalScope: {
      eventId: "event-live-convergence",
      gameDayId: "day-live-convergence",
      pitchId: "pitch-live-convergence",
      pitchSlotId: `slot-${eventGameId}`,
    },
    gameSides: [
      { id: "side-a", eventTeamId: "team-a", teamInterpretationRef: "team-a-v1" },
      { id: "side-b", eventTeamId: "team-b", teamInterpretationRef: "team-b-v1" },
    ],
    lifecycle: {
      phase: "in-progress",
      commencedAtMs: 0,
      finishedAtMs: null,
      lockedAtMs: null,
      lockReason: null,
    },
    compatibility: {
      recordVersion: "record-v1",
      schemaVersion: "schema-v1",
      interpreterVersion: LIVE_EVENT_IQA_INTERPRETER_VERSION,
    },
    creationEvidence: {
      operationId: `register-${eventGameId}`,
      actorReference: "event-admin-fixture",
      source: "event-game-registration",
      createdAtMs: 0,
    },
  };
}

function allPermutations(values: readonly string[]): string[][] {
  if (values.length <= 1) return [values.slice()];
  const permutations: string[][] = [];
  for (const [index, value] of values.entries()) {
    const remaining = [...values.slice(0, index), ...values.slice(index + 1)];
    for (const suffix of allPermutations(remaining)) permutations.push([value, ...suffix]);
  }
  return permutations;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/(^-|-$)/g, "");
}
