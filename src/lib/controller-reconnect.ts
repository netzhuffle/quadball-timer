import type {
  ControllerGameFact,
  ControllerSessionAttachment,
  ControllerProjection,
  LiveEventControllerIntent,
  LiveHeatState,
  LiveResultState,
  LiveStoppageState,
  LiveTimeoutState,
} from "@/lib/live-event-game-control";
import { parseJsonValue } from "@/lib/event-game-action-codecs";
import {
  applyClockProjectionAction,
  createInitialClockBaseline,
  projectClockBaseline,
} from "@/lib/clock-authority";
import { parseLiveEventControllerIntent } from "@/lib/live-event-game-control";
import {
  SHARED_LIMITS,
  validateIntegerInRange,
  validateOpaqueIdentifier,
} from "@/lib/validation-policy";

export const CONTROLLER_REPLICA_VERSION = "controller-replica-v3" as const;
export const CONTROLLER_REPLICA_STORAGE_KEY = "quadball:event-controller-replica";

export function controllerReplicaStorageKey(eventGameId?: string): string {
  return eventGameId === undefined
    ? CONTROLLER_REPLICA_STORAGE_KEY
    : `${CONTROLLER_REPLICA_STORAGE_KEY}:${eventGameId}`;
}

export type ControllerActionOutcomeStatus =
  | "pending"
  | "accepted"
  | "idempotent"
  | "retryable"
  | "causally-blocked"
  | "held-for-correction"
  | "terminally-rejected";

export type PendingControllerAction = {
  eventGameId: string;
  intent: LiveEventControllerIntent;
  causalPredecessorIds: readonly string[];
  dispatchedAtMs: number;
  identity: {
    deviceId: string;
    counter: number;
  };
  counter: number;
  status: ControllerActionOutcomeStatus;
  detail?: string;
};

export type ControllerReplicaState = {
  version: typeof CONTROLLER_REPLICA_VERSION;
  eventGameId: string;
  authoritativeProjection: ControllerProjection;
  projection: ControllerProjection;
  pendingActions: readonly PendingControllerAction[];
  outcomes: Readonly<Record<string, ControllerActionOutcomeStatus>>;
  identity: {
    deviceId: string;
    nextCounter: number;
  };
  session: ControllerSessionAttachment;
  replicaGeneration: string;
  unacknowledgedBatch: {
    batchId: string;
    replicaGeneration: string;
    session: ControllerSessionAttachment;
    actionOperationIds: readonly string[];
  } | null;
  durability: "durable" | "memory-only";
};

export type ControllerReplicaStorage = {
  read(): string | null;
  write(value: string): void;
  quarantine?(value: string): void;
};

export type ControllerReplicaLoad = {
  state: ControllerReplicaState | null;
  warning: string | null;
  quarantined: boolean;
};

export type ControllerReplayBatch = {
  batchId: string;
  replicaGeneration: string;
  session: ControllerSessionAttachment;
  eventGameId: string;
  actions: readonly {
    eventGameId: string;
    intent: LiveEventControllerIntent;
    causalPredecessorIds: readonly string[];
  }[];
};

export type ControllerReplayBatchResponse = {
  batchId: string;
  replicaGeneration: string;
  session: ControllerSessionAttachment;
  eventGameId: string;
  status: "synchronized" | "retryable" | "rejected";
  outcomes: readonly {
    operationId: string;
    status: Exclude<ControllerActionOutcomeStatus, "pending">;
    detail?: string;
  }[];
  projection: ControllerProjection | null;
};

export function createControllerReplica(input: {
  eventGameId: string;
  projection: ControllerProjection;
  grantSessionId: string;
  grantVersion: string;
  deviceId?: string;
  replicaGeneration?: string;
}): ControllerReplicaState {
  const eventGameId = requireIdentifier(input.eventGameId, "eventGameId");
  if (input.projection.eventGameId !== eventGameId) {
    throw new Error("Controller projection belongs to another Event Game.");
  }
  const deviceId = input.deviceId ?? `controller-device-${crypto.randomUUID()}`;
  requireIdentifier(deviceId, "deviceId");
  return {
    version: CONTROLLER_REPLICA_VERSION,
    eventGameId,
    authoritativeProjection: cloneProjection(input.projection),
    projection: cloneProjection(input.projection),
    pendingActions: [],
    outcomes: {},
    identity: { deviceId, nextCounter: 1 },
    session: {
      eventGameId,
      grantSessionId: requireIdentifier(input.grantSessionId, "grantSessionId"),
      grantVersion: requireIdentifier(input.grantVersion, "grantVersion"),
    },
    replicaGeneration: requireIdentifier(
      input.replicaGeneration ?? crypto.randomUUID(),
      "replicaGeneration",
    ),
    unacknowledgedBatch: null,
    durability: "durable",
  };
}

export function dispatchControllerAction(
  state: ControllerReplicaState,
  intent: LiveEventControllerIntent,
  options: { nowMs?: number; causalPredecessorIds?: readonly string[] } = {},
): { state: ControllerReplicaState; action: PendingControllerAction } {
  const parsed = parseLiveEventControllerIntent(intent);
  if (!parsed.ok) throw new Error(`Cannot dispatch invalid Controller action: ${parsed.error}`);
  if (parsed.value.type === "clock" || parsed.value.type === "set-running") {
    throw new Error("Clock reconnect belongs to Clock Authority.");
  }
  const predecessors = [...(options.causalPredecessorIds ?? [])];
  validateCausalPredecessors(state, parsed.value.operationId, predecessors);
  if (predecessors.some((predecessor) => state.outcomes[predecessor] === "terminally-rejected")) {
    throw new Error("Causal predecessor was terminally rejected.");
  }
  const existing = state.pendingActions.find(
    (action) => action.intent.operationId === parsed.value.operationId,
  );
  if (existing !== undefined) return { state, action: existing };
  const counter = state.identity.nextCounter;
  const action: PendingControllerAction = {
    eventGameId: state.eventGameId,
    intent: structuredClone(parsed.value),
    causalPredecessorIds: predecessors,
    dispatchedAtMs: options.nowMs ?? Date.now(),
    identity: { deviceId: state.identity.deviceId, counter },
    counter,
    status: "pending",
  };
  const nextState = applyOptimisticAction(
    {
      ...state,
      pendingActions: [...state.pendingActions, action],
      identity: { ...state.identity, nextCounter: counter + 1 },
    },
    action,
  );
  return { state: nextState, action };
}

/** Queue a disconnected clock action without widening the ordinary reconnect path. */
export function dispatchControllerClockAction(
  state: ControllerReplicaState,
  intent: LiveEventControllerIntent,
  options: { nowMs?: number; causalPredecessorIds?: readonly string[] } = {},
): { state: ControllerReplicaState; action: PendingControllerAction } {
  const parsed = parseLiveEventControllerIntent(intent);
  if (!parsed.ok) throw new Error(`Cannot dispatch invalid Controller action: ${parsed.error}`);
  if (
    parsed.value.type !== "clock" &&
    parsed.value.type !== "set-running" &&
    parsed.value.type !== "clock-adjust" &&
    parsed.value.type !== "clock-correction" &&
    parsed.value.type !== "clock-takeover"
  ) {
    throw new Error("Only clock actions belong to Clock Authority.");
  }
  if (
    parsed.value.type !== "clock-takeover" &&
    (state.projection.clock.offlineClockHolderGrantSessionId === null ||
      state.projection.clock.offlineClockHolderGrantSessionId !== state.session.grantSessionId)
  ) {
    throw new Error("Only the Offline Clock Holder may submit disconnected clock actions.");
  }
  const predecessors = [...(options.causalPredecessorIds ?? [])];
  validateCausalPredecessors(state, parsed.value.operationId, predecessors);
  const existing = state.pendingActions.find(
    (action) => action.intent.operationId === parsed.value.operationId,
  );
  if (existing !== undefined) return { state, action: existing };
  const counter = state.identity.nextCounter;
  const action: PendingControllerAction = {
    eventGameId: state.eventGameId,
    intent: structuredClone(parsed.value),
    causalPredecessorIds: predecessors,
    dispatchedAtMs: options.nowMs ?? Date.now(),
    identity: { deviceId: state.identity.deviceId, counter },
    counter,
    status: "pending",
  };
  const nextState = applyOptimisticAction(
    {
      ...state,
      pendingActions: [...state.pendingActions, action],
      identity: { ...state.identity, nextCounter: counter + 1 },
    },
    action,
  );
  return { state: nextState, action };
}

export function buildControllerReplayBatch(
  state: ControllerReplicaState,
): ControllerReplayBatch | null {
  const prepared = prepareControllerReplayBatch(state);
  return prepared?.batch ?? null;
}

export function prepareControllerReplayBatch(
  state: ControllerReplicaState,
): { state: ControllerReplicaState; batch: ControllerReplayBatch } | null {
  const eligibleStatuses = new Set<ControllerActionOutcomeStatus>([
    "pending",
    "retryable",
    "causally-blocked",
  ]);
  const priorBatch = state.unacknowledgedBatch;
  const pending = state.pendingActions.filter((action) => eligibleStatuses.has(action.status));
  if (pending.length === 0) return null;
  const selected =
    priorBatch === null
      ? pending.slice(0, SHARED_LIMITS.replay.maxControlActions)
      : priorBatch.actionOperationIds.flatMap((operationId) => {
          const action = pending.find((candidate) => candidate.intent.operationId === operationId);
          return action === undefined ? [] : [action];
        });
  if (selected.length === 0) {
    return prepareControllerReplayBatch({ ...state, unacknowledgedBatch: null });
  }
  const batchId = priorBatch?.batchId ?? crypto.randomUUID();
  const nextState = {
    ...state,
    unacknowledgedBatch: {
      batchId,
      replicaGeneration: state.replicaGeneration,
      session: structuredClone(state.session),
      actionOperationIds: selected.map((action) => action.intent.operationId),
    },
  };
  return {
    state: nextState,
    batch: {
      batchId,
      replicaGeneration: state.replicaGeneration,
      session: structuredClone(state.session),
      eventGameId: state.eventGameId,
      actions: selected.map((action) => ({
        eventGameId: action.eventGameId,
        intent: structuredClone(action.intent),
        causalPredecessorIds: [...action.causalPredecessorIds],
      })),
    },
  };
}

export function reconcileControllerReplay(
  state: ControllerReplicaState,
  response: ControllerReplayBatchResponse,
): ControllerReplicaState {
  if (
    response.batchId !== state.unacknowledgedBatch?.batchId ||
    response.replicaGeneration !== state.replicaGeneration ||
    response.eventGameId !== state.eventGameId ||
    response.session.eventGameId !== state.session.eventGameId ||
    response.session.grantSessionId !== state.session.grantSessionId ||
    response.session.grantVersion !== state.session.grantVersion
  ) {
    return state;
  }
  const batchOperationIds = new Set(state.unacknowledgedBatch.actionOperationIds);
  const responseOperationIds = new Set<string>();
  if (
    response.outcomes.some((outcome) => {
      const invalid =
        !batchOperationIds.has(outcome.operationId) ||
        responseOperationIds.has(outcome.operationId) ||
        ![
          "accepted",
          "idempotent",
          "retryable",
          "causally-blocked",
          "held-for-correction",
          "terminally-rejected",
        ].includes(outcome.status);
      responseOperationIds.add(outcome.operationId);
      return invalid;
    })
  ) {
    return state;
  }
  const outcomeByOperation = new Map(
    response.outcomes.map((outcome) => [outcome.operationId, outcome]),
  );
  const outcomes = { ...state.outcomes };
  const pendingActions = state.pendingActions.map((action) => {
    const outcome = outcomeByOperation.get(action.intent.operationId);
    if (outcome === undefined) return action;
    outcomes[action.intent.operationId] = outcome.status;
    return {
      ...action,
      status: outcome.status,
      ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
    };
  });
  const authoritativeProjection =
    response.projection === null
      ? state.authoritativeProjection
      : cloneProjection(response.projection);
  const reconciled = {
    ...state,
    authoritativeProjection,
    outcomes,
    unacknowledgedBatch: null,
    pendingActions: pendingActions.filter(
      (action) =>
        action.status === "pending" ||
        action.status === "retryable" ||
        action.status === "causally-blocked" ||
        action.status === "held-for-correction",
    ),
  };
  return reapplyPendingOptimisticActions(reconciled);
}

export function acknowledgeControllerProjection(
  state: ControllerReplicaState,
  projection: ControllerProjection | null,
): ControllerReplicaState {
  if (projection === null) return state;
  return reapplyPendingOptimisticActions({
    ...state,
    authoritativeProjection: cloneProjection(projection),
  });
}

export function rebindControllerReplica(
  state: ControllerReplicaState,
  session: ControllerSessionAttachment,
  projection: ControllerProjection | null,
): ControllerReplicaState {
  if (session.eventGameId !== state.eventGameId) {
    throw new Error("Controller session belongs to another Event Game.");
  }
  return reapplyPendingOptimisticActions({
    ...state,
    authoritativeProjection:
      projection === null ? state.authoritativeProjection : cloneProjection(projection),
    session: structuredClone(session),
    replicaGeneration: crypto.randomUUID(),
    unacknowledgedBatch: null,
  });
}

export function invalidateControllerReplica(state: ControllerReplicaState): ControllerReplicaState {
  return {
    ...state,
    replicaGeneration: crypto.randomUUID(),
    unacknowledgedBatch: null,
  };
}

export function reapplyPendingOptimisticActions(
  state: ControllerReplicaState,
): ControllerReplicaState {
  const pendingByOperationId = new Map(
    state.pendingActions.map((action) => [action.intent.operationId, action]),
  );
  const blocked = new Set(
    Object.entries(state.outcomes)
      .filter(([, status]) => status === "terminally-rejected" || status === "held-for-correction")
      .map(([operationId]) => operationId),
  );
  const canReapply = (action: PendingControllerAction): boolean =>
    (action.status === "pending" ||
      action.status === "retryable" ||
      action.status === "causally-blocked") &&
    !action.causalPredecessorIds.some((predecessor) => {
      if (blocked.has(predecessor)) return true;
      const pending = pendingByOperationId.get(predecessor);
      return pending !== undefined && !canReapply(pending);
    });
  return state.pendingActions.reduce(
    (current, action) => {
      if (canReapply(action)) return applyOptimisticAction(current, action);
      return current;
    },
    {
      ...state,
      projection: cloneProjection(state.authoritativeProjection),
    },
  );
}

export function serializeControllerReplica(state: ControllerReplicaState): string {
  validateControllerReplica(state);
  return JSON.stringify(state);
}

export function parseControllerReplica(
  value: unknown,
  expectedEventGameId?: string,
): ControllerReplicaState {
  if (!isRecord(value)) throw new Error("Controller replica must be an object.");
  if (value.version !== CONTROLLER_REPLICA_VERSION)
    throw new Error("Controller replica version is unsupported.");
  const eventGameId = requireIdentifier(value.eventGameId, "eventGameId");
  if (expectedEventGameId !== undefined && eventGameId !== expectedEventGameId) {
    throw new Error("Controller replica belongs to another Event Game.");
  }
  const authoritativeProjection = parseProjection(value.authoritativeProjection);
  const projection = parseProjection(value.projection);
  if (
    authoritativeProjection.eventGameId !== eventGameId ||
    projection.eventGameId !== eventGameId
  ) {
    throw new Error("Controller projection belongs to another Event Game.");
  }
  if (!Array.isArray(value.pendingActions)) throw new Error("pendingActions must be an array.");
  if (value.pendingActions.length > 10_000)
    throw new Error("pendingActions exceeds the retained limit.");
  const identity = parseIdentity(value.identity);
  const pendingActions = value.pendingActions.map((action) =>
    parsePendingAction(action, eventGameId, identity.deviceId),
  );
  const session = parseSession(value.session, eventGameId);
  const outcomes = parseOutcomes(value.outcomes);
  const replicaGeneration = requireIdentifier(value.replicaGeneration, "replicaGeneration");
  const unacknowledgedBatch = parseUnacknowledgedBatch(
    value.unacknowledgedBatch,
    eventGameId,
    replicaGeneration,
  );
  if (value.durability !== "durable" && value.durability !== "memory-only") {
    throw new Error("Replica durability is invalid.");
  }
  const state: ControllerReplicaState = {
    version: CONTROLLER_REPLICA_VERSION,
    eventGameId,
    authoritativeProjection,
    projection,
    pendingActions,
    outcomes,
    identity,
    session,
    replicaGeneration,
    unacknowledgedBatch,
    durability: value.durability,
  };
  if (
    state.unacknowledgedBatch !== null &&
    !sameSession(state.unacknowledgedBatch.session, session)
  ) {
    throw new Error("Unacknowledged batch session is stale.");
  }
  if (
    state.unacknowledgedBatch !== null &&
    state.unacknowledgedBatch.actionOperationIds.some(
      (operationId) =>
        !state.pendingActions.some((action) => action.intent.operationId === operationId),
    )
  ) {
    throw new Error("Unacknowledged batch action is not retained.");
  }
  validateCausalGraph(state);
  validateDerivedProjection(state);
  return state;
}

export function loadControllerReplica(
  storage: ControllerReplicaStorage,
  expectedEventGameId?: string,
): ControllerReplicaLoad {
  let raw: string | null;
  try {
    raw = storage.read();
  } catch {
    return {
      state: null,
      warning: "Controller recovery storage is unavailable; changes remain in memory.",
      quarantined: false,
    };
  }
  if (raw === null) return { state: null, warning: null, quarantined: false };
  try {
    return {
      state: parseControllerReplica(JSON.parse(raw), expectedEventGameId),
      warning: null,
      quarantined: false,
    };
  } catch {
    try {
      storage.quarantine?.(raw);
    } catch {
      // Quarantine is best effort. The malformed data is never used as authority.
    }
    return {
      state: null,
      warning: "Saved Controller recovery data was rejected and quarantined.",
      quarantined: true,
    };
  }
}

export function persistControllerReplica(
  state: ControllerReplicaState,
  storage: ControllerReplicaStorage,
): { state: ControllerReplicaState; warning: string | null } {
  try {
    storage.write(serializeControllerReplica(state));
    return { state: { ...state, durability: "durable" }, warning: null };
  } catch {
    return {
      state: { ...state, durability: "memory-only" },
      warning: "Controller recovery storage is full or unavailable; changes remain in memory.",
    };
  }
}

export function validateControllerReplica(state: ControllerReplicaState): void {
  if (state.version !== CONTROLLER_REPLICA_VERSION)
    throw new Error("Controller replica version is unsupported.");
  requireIdentifier(state.eventGameId, "eventGameId");
  parseProjection(state.authoritativeProjection);
  parseProjection(state.projection);
  if (
    state.authoritativeProjection.eventGameId !== state.eventGameId ||
    state.projection.eventGameId !== state.eventGameId
  ) {
    throw new Error("Controller projection belongs to another Event Game.");
  }
  parseIdentity(state.identity);
  parseSession(state.session, state.eventGameId);
  requireIdentifier(state.replicaGeneration, "replicaGeneration");
  parseUnacknowledgedBatch(state.unacknowledgedBatch, state.eventGameId, state.replicaGeneration);
  if (
    state.unacknowledgedBatch !== null &&
    !sameSession(state.unacknowledgedBatch.session, state.session)
  ) {
    throw new Error("Unacknowledged batch session is stale.");
  }
  if (!Array.isArray(state.pendingActions) || state.pendingActions.length > 10_000) {
    throw new Error("pendingActions is invalid.");
  }
  for (const action of state.pendingActions)
    parsePendingAction(action, state.eventGameId, state.identity.deviceId);
  if (
    state.unacknowledgedBatch !== null &&
    state.unacknowledgedBatch.actionOperationIds.some(
      (operationId) =>
        !state.pendingActions.some((action) => action.intent.operationId === operationId),
    )
  ) {
    throw new Error("Unacknowledged batch action is not retained.");
  }
  validateCausalGraph(state);
  validateDerivedProjection(state);
}

function applyOptimisticAction(
  state: ControllerReplicaState,
  action: PendingControllerAction,
): ControllerReplicaState {
  const intent = action.intent;
  if (
    action.status !== "pending" &&
    action.status !== "retryable" &&
    action.status !== "causally-blocked"
  )
    return state;
  if (intent.type === "record-goal") {
    const current = state.projection.scoreByGameSide[intent.gameSideId];
    if (current === undefined) return state;
    const nextFacts = appendOptimisticFact(state.projection, {
      factId: intent.factId,
      factType: "goal",
      gameSideId: intent.gameSideId,
      gameTimeMs: intent.gameTimeMs,
      sportingOrder: intent.sportingOrder ?? intent.gameTimeMs,
      data: { points: 10, sportingOrder: intent.sportingOrder ?? intent.gameTimeMs },
    });
    return {
      ...state,
      projection: {
        ...state.projection,
        scoreByGameSide: { ...state.projection.scoreByGameSide, [intent.gameSideId]: current + 10 },
        goalCount: state.projection.goalCount + 1,
        gameFacts: nextFacts,
      },
    };
  }
  if (intent.type === "correct-fact") {
    const gameFacts = (state.projection.gameFacts ?? []).map((fact) =>
      fact.factId === intent.targetFactId ? { ...fact, effective: intent.effective } : fact,
    );
    const scoreByGameSide = Object.fromEntries(
      Object.keys(state.projection.scoreByGameSide).map((side) => [side, 0]),
    );
    const dependentState = deriveOptimisticDependentState(gameFacts);
    let goalCount = 0;
    for (const fact of gameFacts) {
      if (!fact.effective || fact.factType !== "goal") continue;
      if (fact.gameSideId !== null && fact.gameSideId in scoreByGameSide) {
        scoreByGameSide[fact.gameSideId] = (scoreByGameSide[fact.gameSideId] ?? 0) + 10;
      }
      goalCount += 1;
    }
    return {
      ...state,
      projection: {
        ...state.projection,
        gameFacts,
        scoreByGameSide,
        goalCount,
        phase: gameFacts.some((fact) => fact.effective && fact.factType === "result")
          ? "finished"
          : state.projection.phase === "finished"
            ? "in-progress"
            : state.projection.phase,
        ...(state.projection.timeout === undefined ? {} : { timeout: dependentState.timeout }),
        ...(state.projection.stoppage === undefined ? {} : { stoppage: dependentState.stoppage }),
        ...(state.projection.heat === undefined ? {} : { heat: dependentState.heat }),
        ...(state.projection.result === undefined ? {} : { result: dependentState.result }),
      },
    };
  }
  if (intent.type === "substantive") {
    const nextFacts = appendOptimisticFact(state.projection, {
      factId: intent.factId,
      factType: intent.trigger,
      gameSideId: null,
      gameTimeMs: intent.gameTimeMs,
      sportingOrder: intent.sportingOrder ?? intent.gameTimeMs,
      data: {
        trigger: intent.trigger,
        sportingOrder: intent.sportingOrder ?? intent.gameTimeMs,
        ...(intent.heatAction === undefined ? {} : { heatAction: intent.heatAction }),
      },
    });
    const dependentState = deriveOptimisticDependentState(nextFacts);
    const commencement =
      state.projection.commencement.status === "commenced"
        ? state.projection.commencement
        : {
            status: "commenced" as const,
            commencedAtMs: action.dispatchedAtMs,
            provisionalRunningSinceMs: null,
            provisionalElapsedMs: state.projection.commencement.provisionalElapsedMs,
          };
    return {
      ...state,
      projection: {
        ...state.projection,
        phase:
          intent.trigger === "result"
            ? "finished"
            : state.projection.commencement.status === "provisional"
              ? "in-progress"
              : state.projection.phase,
        commencement,
        gameFacts: nextFacts,
        ...(state.projection.timeout === undefined ? {} : { timeout: dependentState.timeout }),
        ...(state.projection.stoppage === undefined ? {} : { stoppage: dependentState.stoppage }),
        ...(state.projection.heat === undefined ? {} : { heat: dependentState.heat }),
        ...(state.projection.result === undefined ? {} : { result: dependentState.result }),
      },
    };
  }
  if (
    intent.type === "clock" ||
    intent.type === "set-running" ||
    intent.type === "clock-adjust" ||
    intent.type === "clock-correction" ||
    intent.type === "clock-takeover"
  ) {
    return {
      ...state,
      projection: {
        ...state.projection,
        clock: applyClockProjectionAction(state.projection.clock, {
          command:
            intent.type === "clock" || intent.type === "set-running"
              ? "set-running"
              : intent.type === "clock-adjust"
                ? "adjust"
                : intent.type === "clock-correction"
                  ? "correct"
                  : "takeover",
          running: "running" in intent ? intent.running : undefined,
          gameTimeMs: "clockTimeMs" in intent ? intent.clockTimeMs : undefined,
          adjustmentMs: "adjustmentMs" in intent ? intent.adjustmentMs : undefined,
          authorityGeneration:
            "authorityGeneration" in intent ? intent.authorityGeneration : intent.clockGeneration,
          sessionId: state.session.grantSessionId,
          operationId: intent.operationId,
        }),
      },
    };
  }
  return {
    ...state,
  };
}

function validateCausalPredecessors(
  state: ControllerReplicaState,
  operationId: string,
  predecessors: readonly string[],
) {
  const unique = new Set(predecessors);
  if (unique.size !== predecessors.length || unique.has(operationId))
    throw new Error("Causal predecessors are invalid.");
  for (const predecessor of predecessors) {
    requireIdentifier(predecessor, "causalPredecessorId");
    if (
      !state.pendingActions.some((action) => action.intent.operationId === predecessor) &&
      state.outcomes[predecessor] === undefined
    ) {
      throw new Error("Causal predecessor is not retained.");
    }
  }
}

function validateCausalGraph(state: ControllerReplicaState) {
  const ids = new Set<string>();
  const counters = new Set<number>();
  let maximumCounter = 0;
  const pendingByOperationId = new Map(
    state.pendingActions.map((action) => [action.intent.operationId, action]),
  );
  for (const [operationId, outcome] of Object.entries(state.outcomes)) {
    const pending = pendingByOperationId.get(operationId);
    if (pending !== undefined && pending.status !== outcome) {
      throw new Error("Controller action outcome is inconsistent.");
    }
  }
  for (const action of state.pendingActions) {
    const operationId = action.intent.operationId;
    if (ids.has(operationId)) throw new Error("Controller action identities must be unique.");
    ids.add(operationId);
    if (
      action.identity.deviceId !== state.identity.deviceId ||
      action.counter !== action.identity.counter
    ) {
      throw new Error("Controller action identity is inconsistent.");
    }
    if (counters.has(action.counter)) throw new Error("Controller action counters must be unique.");
    counters.add(action.counter);
    maximumCounter = Math.max(maximumCounter, action.counter);
  }
  if (state.identity.nextCounter <= maximumCounter)
    throw new Error("nextCounter must exceed every retained action counter.");
  for (const action of state.pendingActions) {
    validateCausalPredecessors(
      {
        ...state,
        pendingActions: state.pendingActions.filter((candidate) => candidate !== action),
      },
      action.intent.operationId,
      action.causalPredecessorIds,
    );
    if (hasCausalCycle(action.intent.operationId, state.pendingActions, new Set()))
      throw new Error("Controller causal graph contains a cycle.");
  }
}

function validateDerivedProjection(state: ControllerReplicaState) {
  const derived = reapplyPendingOptimisticActions({
    ...state,
    projection: cloneProjection(state.authoritativeProjection),
  }).projection;
  if (!sameProjection(derived, state.projection)) {
    throw new Error(
      "Controller optimistic projection is inconsistent with its authoritative base.",
    );
  }
}

function sameProjection(left: ControllerProjection, right: ControllerProjection): boolean {
  const leftScores = Object.entries(left.scoreByGameSide).sort(([a], [b]) => a.localeCompare(b));
  const rightScores = Object.entries(right.scoreByGameSide).sort(([a], [b]) => a.localeCompare(b));
  const leftFacts = JSON.stringify(left.gameFacts ?? []);
  const rightFacts = JSON.stringify(right.gameFacts ?? []);
  const leftDependent = JSON.stringify([
    left.timeout ?? null,
    left.stoppage ?? null,
    left.heat ?? null,
    left.result ?? null,
  ]);
  const rightDependent = JSON.stringify([
    right.timeout ?? null,
    right.stoppage ?? null,
    right.heat ?? null,
    right.result ?? null,
  ]);
  return (
    left.eventGameId === right.eventGameId &&
    left.phase === right.phase &&
    left.goalCount === right.goalCount &&
    left.commencement.status === right.commencement.status &&
    left.commencement.commencedAtMs === right.commencement.commencedAtMs &&
    left.commencement.provisionalRunningSinceMs === right.commencement.provisionalRunningSinceMs &&
    left.commencement.provisionalElapsedMs === right.commencement.provisionalElapsedMs &&
    JSON.stringify(left.clock) === JSON.stringify(right.clock) &&
    leftFacts === rightFacts &&
    leftDependent === rightDependent &&
    leftScores.length === rightScores.length &&
    leftScores.every(
      ([side, score], index) =>
        rightScores[index]?.[0] === side && rightScores[index]?.[1] === score,
    )
  );
}

function hasCausalCycle(
  operationId: string,
  actions: readonly PendingControllerAction[],
  seen: Set<string>,
): boolean {
  if (seen.has(operationId)) return true;
  const action = actions.find((candidate) => candidate.intent.operationId === operationId);
  if (action === undefined) return false;
  const nextSeen = new Set(seen).add(operationId);
  return action.causalPredecessorIds.some((predecessor) =>
    hasCausalCycle(predecessor, actions, nextSeen),
  );
}

function parsePendingAction(
  value: unknown,
  eventGameId: string,
  expectedDeviceId: string,
): PendingControllerAction {
  if (!isRecord(value) || value.eventGameId !== eventGameId)
    throw new Error("Pending action has the wrong Event Game.");
  const intent = parseLiveEventControllerIntent(value.intent);
  if (!intent.ok) throw new Error(intent.error);
  if (!Array.isArray(value.causalPredecessorIds))
    throw new Error("causalPredecessorIds must be an array.");
  const dispatchedAtMs = validateIntegerInRange(
    value.dispatchedAtMs,
    0,
    Number.MAX_SAFE_INTEGER,
    "dispatchedAtMs",
  );
  const counter = validateIntegerInRange(value.counter, 1, Number.MAX_SAFE_INTEGER, "counter");
  if (!dispatchedAtMs.ok || !counter.ok)
    throw new Error("Pending action timing or counter is invalid.");
  if (
    ![
      "pending",
      "accepted",
      "idempotent",
      "retryable",
      "causally-blocked",
      "held-for-correction",
      "terminally-rejected",
    ].includes(value.status as string)
  ) {
    throw new Error("Pending action status is invalid.");
  }
  const predecessors = value.causalPredecessorIds.map((candidate) =>
    requireIdentifier(candidate, "causalPredecessorId"),
  );
  if (!isRecord(value.identity)) throw new Error("Pending action identity is invalid.");
  const identityDeviceId = requireIdentifier(value.identity.deviceId, "action.identity.deviceId");
  const identityCounter = validateIntegerInRange(
    value.identity.counter,
    1,
    Number.MAX_SAFE_INTEGER,
    "action.identity.counter",
  );
  if (!identityCounter.ok) throw new Error(identityCounter.error);
  if (identityDeviceId !== expectedDeviceId || identityCounter.value !== counter.value) {
    throw new Error("Pending action identity is inconsistent.");
  }
  return {
    eventGameId,
    intent: intent.value,
    causalPredecessorIds: predecessors,
    dispatchedAtMs: dispatchedAtMs.value,
    identity: { deviceId: identityDeviceId, counter: identityCounter.value },
    counter: counter.value,
    status: value.status as ControllerActionOutcomeStatus,
    ...(typeof value.detail === "string" ? { detail: value.detail } : {}),
  };
}

function parseProjection(value: unknown): ControllerProjection {
  if (!isRecord(value)) throw new Error("Controller projection is invalid.");
  const eventGameId = requireIdentifier(value.eventGameId, "projection.eventGameId");
  const phase = value.phase;
  if (phase !== "scheduled" && phase !== "in-progress" && phase !== "finished")
    throw new Error("Projection phase is invalid.");
  if (!isRecord(value.scoreByGameSide)) throw new Error("Projection scores are invalid.");
  const scores: Record<string, number> = {};
  for (const [side, score] of Object.entries(value.scoreByGameSide)) {
    requireIdentifier(side, "gameSideId");
    const parsed = validateIntegerInRange(
      score,
      SHARED_LIMITS.score.min,
      SHARED_LIMITS.score.max,
      "score",
    );
    if (!parsed.ok) throw new Error(parsed.error);
    scores[side] = parsed.value;
  }
  const goalCount = validateIntegerInRange(value.goalCount, 0, 10_000, "goalCount");
  if (!goalCount.ok) throw new Error(goalCount.error);
  if (!isRecord(value.commencement)) throw new Error("Projection commencement is invalid.");
  const commencementStatus = value.commencement.status;
  if (commencementStatus !== "provisional" && commencementStatus !== "commenced")
    throw new Error("Projection commencement status is invalid.");
  const commencedAtMs = nullableNumber(value.commencement.commencedAtMs, "commencedAtMs");
  const runningSinceMs = nullableNumber(
    value.commencement.provisionalRunningSinceMs,
    "provisionalRunningSinceMs",
  );
  const elapsed = validateIntegerInRange(
    value.commencement.provisionalElapsedMs,
    0,
    Number.MAX_SAFE_INTEGER,
    "provisionalElapsedMs",
  );
  if (!elapsed.ok) throw new Error(elapsed.error);
  const clock = isRecord(value.clock)
    ? (structuredClone(value.clock) as ControllerProjection["clock"])
    : projectClockBaseline(createInitialClockBaseline(), 0);
  const gameFacts = parseGameFacts(value.gameFacts);
  const guardrails = parseGuardrails(value.guardrails);
  const timeout = value.timeout === undefined ? undefined : parseTimeoutState(value.timeout);
  const stoppage = value.stoppage === undefined ? undefined : parseStoppageState(value.stoppage);
  const heat = value.heat === undefined ? undefined : parseHeatState(value.heat);
  const result = value.result === undefined ? undefined : parseResultState(value.result);
  return {
    eventGameId,
    phase,
    scoreByGameSide: scores,
    goalCount: goalCount.value,
    ...(value.timeout === undefined ? {} : { timeout }),
    ...(value.stoppage === undefined ? {} : { stoppage }),
    ...(value.heat === undefined ? {} : { heat }),
    ...(value.result === undefined ? {} : { result }),
    ...(value.gameFacts === undefined ? {} : { gameFacts }),
    ...(value.guardrails === undefined ? {} : { guardrails }),
    clock,
    commencement: {
      status: commencementStatus,
      commencedAtMs,
      provisionalRunningSinceMs: runningSinceMs,
      provisionalElapsedMs: elapsed.value,
    },
  };
}

function parseTimeoutState(value: unknown): LiveTimeoutState {
  if (!isRecord(value) || (value.status !== "inactive" && value.status !== "started")) {
    throw new Error("Projection timeout state is invalid.");
  }
  return { status: value.status, factId: parseNullableFactId(value.factId, "timeout.factId") };
}

function parseStoppageState(value: unknown): LiveStoppageState {
  if (
    !isRecord(value) ||
    (value.status !== "none" && value.status !== "suspension" && value.status !== "heat-stoppage")
  ) {
    throw new Error("Projection stoppage state is invalid.");
  }
  return {
    status: value.status,
    factId: parseNullableFactId(value.factId, "stoppage.factId"),
  };
}

function parseHeatState(value: unknown): LiveHeatState {
  if (
    !isRecord(value) ||
    (value.status !== "inactive" &&
      value.status !== "started" &&
      value.status !== "ended" &&
      value.status !== "skipped" &&
      value.status !== "extended")
  ) {
    throw new Error("Projection heat state is invalid.");
  }
  const startedAtGameTimeMs = parseNullableBoundedNumber(
    value.startedAtGameTimeMs,
    "heat.startedAtGameTimeMs",
  );
  const nominalDurationMs = parseNullableBoundedNumber(
    value.nominalDurationMs,
    "heat.nominalDurationMs",
  );
  return {
    status: value.status,
    factId: parseNullableFactId(value.factId, "heat.factId"),
    startedAtGameTimeMs,
    nominalDurationMs,
  };
}

function parseResultState(value: unknown): LiveResultState {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error("Projection result state is invalid.");
  const factId = requireIdentifier(value.factId, "result.factId");
  const data = parseJsonValue(value.data, "result.data");
  if (!data.ok) throw new Error(data.error);
  return { factId, data: data.value };
}

function parseNullableFactId(value: unknown, field: string): string | null {
  return value === null ? null : requireIdentifier(value, field);
}

function parseNullableBoundedNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  const parsed = validateIntegerInRange(value, 0, SHARED_LIMITS.clock.maxMs, field);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function parseGuardrails(value: unknown): ControllerProjection["guardrails"] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error("Projection guardrails are invalid.");
  }
  return structuredClone(value) as ControllerProjection["guardrails"];
}

function parseGameFacts(value: unknown): ControllerProjection["gameFacts"] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > SHARED_LIMITS.replay.maxControlActions) {
    throw new Error("Projection game facts are invalid.");
  }
  return value.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Projection game fact is invalid.");
    const factId = requireIdentifier(candidate.factId, "gameFacts.factId");
    const factType = requireIdentifier(candidate.factType, "gameFacts.factType");
    const gameSideId =
      candidate.gameSideId === null
        ? null
        : requireIdentifier(candidate.gameSideId, "gameFacts.gameSideId");
    if (!Number.isSafeInteger(candidate.gameTimeMs) && candidate.gameTimeMs !== null)
      throw new Error("Projection game fact time is invalid.");
    if (
      !Number.isSafeInteger(candidate.sportingOrder) ||
      !Number.isSafeInteger(candidate.synchronizationOrder) ||
      typeof candidate.effective !== "boolean"
    )
      throw new Error("Projection game fact ordering is invalid.");
    return {
      ...(structuredClone(candidate) as ControllerGameFact),
      factId,
      factType,
      gameSideId,
    };
  });
}

function parseIdentity(value: unknown): ControllerReplicaState["identity"] {
  if (!isRecord(value)) throw new Error("Replica identity is invalid.");
  const deviceId = requireIdentifier(value.deviceId, "deviceId");
  const nextCounter = validateIntegerInRange(
    value.nextCounter,
    1,
    Number.MAX_SAFE_INTEGER,
    "nextCounter",
  );
  if (!nextCounter.ok) throw new Error(nextCounter.error);
  return { deviceId, nextCounter: nextCounter.value };
}

function parseSession(value: unknown, eventGameId: string): ControllerReplicaState["session"] {
  if (!isRecord(value) || value.eventGameId !== eventGameId)
    throw new Error("Replica session scope is invalid.");
  return {
    eventGameId,
    grantSessionId: requireIdentifier(value.grantSessionId, "grantSessionId"),
    grantVersion: requireIdentifier(value.grantVersion, "grantVersion"),
  };
}

function parseOutcomes(value: unknown): Readonly<Record<string, ControllerActionOutcomeStatus>> {
  if (!isRecord(value)) throw new Error("Replica outcomes are invalid.");
  const outcomes: Record<string, ControllerActionOutcomeStatus> = {};
  for (const [operationId, outcome] of Object.entries(value)) {
    requireIdentifier(operationId, "operationId");
    if (
      ![
        "accepted",
        "idempotent",
        "retryable",
        "causally-blocked",
        "held-for-correction",
        "terminally-rejected",
      ].includes(outcome as string)
    )
      throw new Error("Replica outcome is invalid.");
    outcomes[operationId] = outcome as ControllerActionOutcomeStatus;
  }
  return outcomes;
}

function parseUnacknowledgedBatch(
  value: unknown,
  eventGameId: string,
  replicaGeneration: string,
): ControllerReplicaState["unacknowledgedBatch"] {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error("Unacknowledged batch is invalid.");
  const batchId = requireIdentifier(value.batchId, "batchId");
  if (value.replicaGeneration !== replicaGeneration) {
    throw new Error("Unacknowledged batch generation is stale.");
  }
  if (!Array.isArray(value.actionOperationIds) || value.actionOperationIds.length === 0) {
    throw new Error("Unacknowledged batch actions are invalid.");
  }
  const actionOperationIds = value.actionOperationIds.map((operationId) =>
    requireIdentifier(operationId, "batch.actionOperationId"),
  );
  if (new Set(actionOperationIds).size !== actionOperationIds.length) {
    throw new Error("Unacknowledged batch actions must be unique.");
  }
  if (!isRecord(value.session)) throw new Error("Batch session is invalid.");
  const session = parseSession(value.session, eventGameId);
  return { batchId, replicaGeneration, session, actionOperationIds };
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  const parsed = validateIntegerInRange(value, 0, Number.MAX_SAFE_INTEGER, field);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function sameSession(
  left: ControllerSessionAttachment,
  right: ControllerSessionAttachment,
): boolean {
  return (
    left.eventGameId === right.eventGameId &&
    left.grantSessionId === right.grantSessionId &&
    left.grantVersion === right.grantVersion
  );
}

function requireIdentifier(value: unknown, field: string): string {
  const parsed = validateOpaqueIdentifier(value, field);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function cloneProjection(projection: ControllerProjection): ControllerProjection {
  return structuredClone(projection);
}

function appendOptimisticFact(
  projection: ControllerProjection,
  fact: {
    factId: string;
    factType: string;
    gameSideId: string | null;
    gameTimeMs: number;
    sportingOrder: number;
    data: unknown;
  },
) {
  const facts = [...(projection.gameFacts ?? [])];
  const synchronizationOrder =
    facts.reduce((highest, candidate) => Math.max(highest, candidate.synchronizationOrder), 0) + 1;
  facts.push({
    factId: fact.factId,
    factType: fact.factType,
    gameSideId: fact.gameSideId,
    gameTimeMs: fact.gameTimeMs,
    sportingOrder: fact.sportingOrder,
    synchronizationOrder,
    effective: true,
    data: fact.data as ControllerGameFact["data"],
  });
  return facts.sort(
    (left, right) =>
      left.sportingOrder - right.sportingOrder ||
      left.synchronizationOrder - right.synchronizationOrder,
  );
}

function deriveOptimisticDependentState(facts: readonly ControllerGameFact[]): {
  timeout: LiveTimeoutState;
  stoppage: LiveStoppageState;
  heat: LiveHeatState;
  result: LiveResultState;
} {
  const latest = (factType: string) =>
    facts.filter((fact) => fact.effective && fact.factType === factType).at(-1) ?? null;
  const timeoutFact = latest("timeout");
  const suspensionFact = latest("suspension");
  const heatFact = latest("heat-stoppage");
  const resultFact = latest("result");
  const heatData =
    heatFact !== null && isRecord(heatFact.data)
      ? (heatFact.data as Record<string, unknown>)
      : null;
  const heatAction =
    heatData !== null &&
    (heatData.heatAction === "end" ||
      heatData.heatAction === "skip-required" ||
      heatData.heatAction === "extend-permitted")
      ? heatData.heatAction
      : null;
  const heatStatus: LiveHeatState["status"] =
    heatFact === null
      ? "inactive"
      : heatAction === "end"
        ? "ended"
        : heatAction === "skip-required"
          ? "skipped"
          : heatAction === "extend-permitted"
            ? "extended"
            : "started";
  const effectiveHeatStarts = facts.filter((fact) => {
    const data = isRecord(fact.data) ? (fact.data as unknown as Record<string, unknown>) : null;
    return (
      fact.effective &&
      fact.factType === "heat-stoppage" &&
      (data === null ||
        (data.heatAction !== "end" &&
          data.heatAction !== "skip-required" &&
          data.heatAction !== "extend-permitted"))
    );
  });
  const nominalDurationMs =
    heatStatus === "started" || heatStatus === "extended"
      ? effectiveHeatStarts.length <= 1
        ? 4 * 60 * 1000
        : 2 * 60 * 1000
      : null;
  const startedAtGameTimeMs =
    nominalDurationMs === null || heatFact?.gameTimeMs === null
      ? null
      : (heatFact?.gameTimeMs ?? null);
  const heat: LiveHeatState = {
    status: heatStatus,
    factId: heatFact?.factId ?? null,
    startedAtGameTimeMs,
    nominalDurationMs,
  };
  return {
    timeout: {
      status: timeoutFact === null ? "inactive" : "started",
      factId: timeoutFact?.factId ?? null,
    },
    stoppage:
      suspensionFact !== null
        ? { status: "suspension", factId: suspensionFact.factId }
        : heat.status === "started" || heat.status === "extended"
          ? { status: "heat-stoppage", factId: heat.factId }
          : { status: "none", factId: null },
    heat,
    result:
      resultFact === null
        ? null
        : { factId: resultFact.factId, data: structuredClone(resultFact.data) },
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
