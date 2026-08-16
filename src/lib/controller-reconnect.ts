import type {
  ControllerGameFact,
  ControllerSessionAttachment,
  ControllerProjection,
  LiveEventControllerIntent,
  LiveHeatState,
  LiveCatchState,
  LiveResultState,
  LiveSuspensionPenaltyState,
  LiveSuspensionState,
  LiveStoppageState,
  LiveTimeoutState,
} from "@/lib/live-event-game-control";
import { deriveLivePenaltyProjection } from "@/lib/live-event-penalties";
import { parseJsonValue } from "@/lib/event-game-action-codecs";
import {
  applyClockProjectionAction,
  createInitialClockBaseline,
  projectClockBaseline,
} from "@/lib/clock-authority";
import {
  orderControllerGameFacts,
  LIVE_SUSPENSION_SNAPSHOT_VERSION,
  deriveHeatStoppageState,
  parseLiveEventControllerIntent,
} from "@/lib/live-event-game-control";
import {
  SHARED_LIMITS,
  validateIntegerInRange,
  validateOpaqueIdentifier,
} from "@/lib/validation-policy";
import {
  projectControllerReplayRetry,
  orderControllerOperations,
  validateControllerReplay,
} from "@/lib/controller-synchronization";

export const CONTROLLER_REPLICA_VERSION = "controller-replica-v3" as const;
export const CONTROLLER_REPLICA_STORAGE_KEY = "quadball:event-controller-replica";
/** A Controller must revalidate after five seconds without a fresh server response. */
export const CONTROLLER_STALE_DISCONNECTED_AFTER_MS = 5_000 as const;

export type ControllerConnectionStatus = "fresh" | "stale" | "disconnected";

/**
 * Shared monotonic freshness contract for the browser Controller reconnect seam.
 * Offline transport is disconnected immediately; an online session is stale at
 * (and only at) the configured five-second boundary after its last response.
 */
export function deriveControllerConnectionStatus(input: {
  lastSynchronizedAtMs: number | null;
  nowMs: number;
  online: boolean;
}): ControllerConnectionStatus {
  if (!input.online) return "disconnected";
  if (
    input.lastSynchronizedAtMs === null ||
    !Number.isFinite(input.lastSynchronizedAtMs) ||
    !Number.isFinite(input.nowMs) ||
    input.nowMs < input.lastSynchronizedAtMs
  ) {
    return "disconnected";
  }
  return input.nowMs - input.lastSynchronizedAtMs < CONTROLLER_STALE_DISCONNECTED_AFTER_MS
    ? "fresh"
    : "stale";
}

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
  | "locked-discarded"
  | "terminally-rejected";

export type PendingControllerAction = {
  workflow?: "event";
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
  workflow?: "event";
  eventGameId: string;
  /** Non-secret local reference to the exact Event Grant Session owner. */
  sessionReferenceId?: string;
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
  workflow?: "event";
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
  workflow?: "event";
  batchId: string;
  replicaGeneration: string;
  session: ControllerSessionAttachment;
  eventGameId: string;
  status: "synchronized" | "retryable" | "rejected";
  discardedCount?: number;
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
  sessionReferenceId?: string;
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
    workflow: "event",
    eventGameId,
    ...(input.sessionReferenceId === undefined
      ? {}
      : { sessionReferenceId: requireIdentifier(input.sessionReferenceId, "sessionReferenceId") }),
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
    workflow: "event",
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
    workflow: "event",
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
  const envelope = validateControllerReplay(
    selected.map((action) => ({
      id: action.intent.operationId,
      workflow: "event" as const,
      clientSentAtMs: action.dispatchedAtMs,
      causalPredecessorIds: action.causalPredecessorIds,
      intent: action.intent,
    })),
    "event",
  );
  if (!envelope.ok) return null;
  return {
    state: nextState,
    batch: {
      workflow: "event",
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
          "locked-discarded",
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
  if (response.projection !== null && authoritativeProjection.gameFacts !== undefined) {
    const retainedPendingFactIds = new Set(
      pendingActions
        .filter(
          (action) =>
            action.status === "pending" ||
            action.status === "retryable" ||
            action.status === "causally-blocked" ||
            action.status === "held-for-correction",
        )
        .flatMap((action) => ("factId" in action.intent ? [action.intent.factId] : [])),
    );
    authoritativeProjection.gameFacts = authoritativeProjection.gameFacts.filter(
      (fact) => !retainedPendingFactIds.has(fact.factId),
    );
  }
  const reconciled = {
    ...state,
    authoritativeProjection,
    outcomes,
    unacknowledgedBatch: null,
    pendingActions: projectControllerReplayRetry(
      pendingActions,
      new Set(["pending", "retryable", "causally-blocked", "held-for-correction"]),
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
  sessionReferenceId = state.sessionReferenceId,
): ControllerReplicaState {
  if (session.eventGameId !== state.eventGameId) {
    throw new Error("Controller session belongs to another Event Game.");
  }
  return reapplyPendingOptimisticActions({
    ...state,
    ...(sessionReferenceId === undefined ? {} : { sessionReferenceId }),
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
  if (value.workflow !== undefined && value.workflow !== "event")
    throw new Error("Controller replica workflow is invalid.");
  const eventGameId = requireIdentifier(value.eventGameId, "eventGameId");
  const sessionReferenceId =
    value.sessionReferenceId === undefined
      ? undefined
      : requireIdentifier(value.sessionReferenceId, "sessionReferenceId");
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
    workflow: "event",
    eventGameId,
    ...(sessionReferenceId === undefined ? {} : { sessionReferenceId }),
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
  if (state.workflow !== undefined && state.workflow !== "event")
    throw new Error("Controller replica workflow is invalid.");
  requireIdentifier(state.eventGameId, "eventGameId");
  if (state.sessionReferenceId !== undefined)
    requireIdentifier(state.sessionReferenceId, "sessionReferenceId");
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
      data: {
        points: 10,
        sportingOrder: intent.sportingOrder ?? intent.gameTimeMs,
        ...(intent.sportingOrderAdjudication === undefined
          ? {}
          : { sportingOrderAdjudication: intent.sportingOrderAdjudication }),
        ...(intent.sportingOrderOverride === undefined
          ? {}
          : { sportingOrderOverride: intent.sportingOrderOverride }),
      },
    });
    return rebuildOptimisticProjection(state, nextFacts, action.dispatchedAtMs);
  }
  if (intent.type === "record-card") {
    const commencementAtDispatch = projectOptimisticCommencement(
      state.projection.commencement,
      state.projection.clock.running,
      action.dispatchedAtMs,
    );
    const penaltyStart =
      commencementAtDispatch.status === "provisional"
        ? "sticks-up"
        : intent.seekerPenalty === "head-referee-confirmed" &&
            intent.gameTimeMs >= 19 * 60_000 &&
            intent.gameTimeMs < 20 * 60_000
          ? "seeker-release"
          : "immediate";
    const playerKey =
      intent.playerNumber === null
        ? `${intent.gameSideId}:unknown:${intent.factId}`
        : `${intent.gameSideId}:${intent.playerNumber}`;
    let nextFacts = appendOptimisticFact(state.projection, {
      factId: intent.factId,
      factType: "card",
      gameSideId: intent.gameSideId,
      gameTimeMs: intent.gameTimeMs,
      sportingOrder: intent.sportingOrder ?? intent.gameTimeMs,
      data: {
        cardType: intent.cardType,
        playerNumber: intent.playerNumber,
        penaltyStart,
        ...(intent.foulBeforeScore === undefined
          ? {}
          : { foulBeforeScore: intent.foulBeforeScore }),
        ...(intent.seekerPenalty === undefined ? {} : { seekerPenalty: intent.seekerPenalty }),
        sportingOrder: intent.sportingOrder ?? intent.gameTimeMs,
      },
    });
    if (
      intent.foulBeforeScore === true &&
      (intent.cardType === "blue" || intent.cardType === "yellow")
    ) {
      nextFacts = appendOptimisticFact(
        { ...state.projection, gameFacts: nextFacts },
        {
          factId: `${intent.factId}-penalty-release`,
          factType: "penalty-release-consequence",
          gameSideId: intent.gameSideId,
          gameTimeMs: intent.gameTimeMs,
          sportingOrder: intent.sportingOrder ?? intent.gameTimeMs,
          data: {
            sourceFactId: intent.factId,
            playerKey,
            releaseCause: "foul-before-score",
            releasedMs: intent.gameTimeMs,
            serviceDurationMs: 60_000,
            sportingOrder: intent.sportingOrder ?? intent.gameTimeMs,
          },
        },
      );
    }
    return rebuildOptimisticProjection(
      state,
      nextFacts,
      commencementAtDispatch.commencedAtMs ?? action.dispatchedAtMs,
    );
  }
  if (intent.type === "record-penalty-reason") {
    const nextFacts = appendOptimisticFact(state.projection, {
      factId: intent.factId,
      factType: "penalty-reason",
      gameSideId: null,
      gameTimeMs: intent.gameTimeMs,
      sportingOrder: intent.sportingOrder ?? intent.gameTimeMs,
      data: {
        targetCardFactId: intent.targetCardFactId,
        reason: intent.reason,
        sportingOrder: intent.sportingOrder ?? intent.gameTimeMs,
      },
    });
    return rebuildOptimisticProjection(state, nextFacts, action.dispatchedAtMs);
  }
  if (intent.type === "resolve-penalty-expiration") {
    const scoreFact = (state.projection.gameFacts ?? []).find(
      (fact) => fact.factId === intent.scoreFactId && fact.factType === "goal",
    );
    const scoreGameTimeMs = scoreFact?.gameTimeMs ?? intent.gameTimeMs;
    const scoreSportingOrder = scoreFact?.sportingOrder ?? scoreGameTimeMs;
    const nextFacts = appendOptimisticFact(state.projection, {
      factId: intent.factId,
      factType: "penalty-release",
      gameSideId: null,
      gameTimeMs: scoreGameTimeMs,
      sportingOrder: scoreSportingOrder,
      data: {
        pendingId: intent.pendingId,
        scoreFactId: intent.scoreFactId,
        playerKey: intent.playerKey,
        sportingOrder: scoreSportingOrder,
      },
    });
    return rebuildOptimisticProjection(state, nextFacts, action.dispatchedAtMs);
  }
  if (
    intent.type === "record-flag-catch" ||
    intent.type === "record-concession" ||
    intent.type === "record-forfeit" ||
    intent.type === "record-double-forfeit"
  ) {
    const factType = intent.type.replace("record-", "");
    const gameSideId = "gameSideId" in intent ? intent.gameSideId : null;
    const nextFacts = appendOptimisticFact(state.projection, {
      factId: intent.factId,
      factType,
      gameSideId,
      gameTimeMs: intent.gameTimeMs,
      sportingOrder: intent.sportingOrder ?? intent.gameTimeMs,
      data: {
        points: factType === "flag-catch" ? 30 : 0,
        resultKind: factType,
        sportingOrder: intent.sportingOrder ?? intent.gameTimeMs,
        ...(intent.sportingOrderAdjudication === undefined
          ? {}
          : { sportingOrderAdjudication: intent.sportingOrderAdjudication }),
        ...(intent.sportingOrderOverride === undefined
          ? {}
          : { sportingOrderOverride: intent.sportingOrderOverride }),
      },
    });
    return rebuildOptimisticProjection(state, nextFacts, action.dispatchedAtMs);
  }
  if (intent.type === "correct-fact") {
    const gameFacts = (state.projection.gameFacts ?? []).map((fact) =>
      fact.factId === intent.targetFactId ? { ...fact, effective: intent.effective } : fact,
    );
    return rebuildOptimisticProjection(state, gameFacts, action.dispatchedAtMs);
  }
  if (intent.type === "substantive") {
    const nextFacts = appendOptimisticFact(state.projection, {
      factId: intent.factId,
      factType: intent.trigger,
      gameSideId: intent.gameSideId ?? null,
      gameTimeMs: intent.gameTimeMs,
      sportingOrder: intent.sportingOrder ?? intent.gameTimeMs,
      data: {
        trigger: intent.trigger,
        sportingOrder: intent.sportingOrder ?? intent.gameTimeMs,
        ...(intent.sportingOrderAdjudication === undefined
          ? {}
          : { sportingOrderAdjudication: intent.sportingOrderAdjudication }),
        ...(intent.heatAction === undefined ? {} : { heatAction: intent.heatAction }),
        ...(intent.heatTriggerId === undefined ? {} : { heatTriggerId: intent.heatTriggerId }),
      },
    });
    return rebuildOptimisticProjection(state, nextFacts, action.dispatchedAtMs);
  }
  if (
    intent.type === "clock" ||
    intent.type === "set-running" ||
    intent.type === "clock-adjust" ||
    intent.type === "clock-correction" ||
    intent.type === "clock-takeover"
  ) {
    const commencementAtDispatch = projectOptimisticCommencement(
      state.projection.commencement,
      state.projection.clock.running,
      action.dispatchedAtMs,
    );
    const clock = applyClockProjectionAction(state.projection.clock, {
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
    });
    return {
      ...state,
      projection: {
        ...state.projection,
        clock,
        commencement:
          commencementAtDispatch.status === "commenced"
            ? commencementAtDispatch
            : {
                ...commencementAtDispatch,
                provisionalRunningSinceMs: clock.running ? action.dispatchedAtMs : null,
              },
      },
    };
  }
  return {
    ...state,
  };
}

function projectOptimisticCommencement(
  commencement: ControllerProjection["commencement"],
  clockRunning: boolean,
  nowMs: number,
): ControllerProjection["commencement"] {
  if (commencement.status === "commenced") return commencement;
  const liveElapsedMs =
    clockRunning && commencement.provisionalRunningSinceMs !== null
      ? Math.max(0, nowMs - commencement.provisionalRunningSinceMs)
      : 0;
  const provisionalElapsedMs = commencement.provisionalElapsedMs + liveElapsedMs;
  if (provisionalElapsedMs >= 10_000) {
    return {
      status: "commenced",
      commencedAtMs:
        commencement.provisionalRunningSinceMs === null
          ? nowMs
          : commencement.provisionalRunningSinceMs +
            Math.max(0, 10_000 - commencement.provisionalElapsedMs),
      provisionalRunningSinceMs: null,
      provisionalElapsedMs,
    };
  }
  return {
    ...commencement,
    provisionalElapsedMs,
    provisionalRunningSinceMs: clockRunning ? nowMs : null,
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
  const pendingIds = new Set(state.pendingActions.map((action) => action.intent.operationId));
  const ordered = orderControllerOperations(
    state.pendingActions.map((action) => ({
      operationId: action.intent.operationId,
      workflow: "event" as const,
      clientOriginAtMs: action.dispatchedAtMs,
      causalPredecessorIds: action.causalPredecessorIds.filter((id) => pendingIds.has(id)),
      payload: action.intent,
    })),
  );
  if (!ordered.ok) throw new Error(ordered.error);
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
    left.suspension ?? null,
    left.stoppage ?? null,
    left.heat ?? null,
    left.result ?? null,
    left.overtime ?? false,
    left.overtimeTarget ?? left.targetScore ?? null,
    left.winnerGameSideId ?? null,
    left.catch ?? null,
  ]);
  const rightDependent = JSON.stringify([
    right.timeout ?? null,
    right.suspension ?? null,
    right.stoppage ?? null,
    right.heat ?? null,
    right.result ?? null,
    right.overtime ?? false,
    right.overtimeTarget ?? right.targetScore ?? null,
    right.winnerGameSideId ?? null,
    right.catch ?? null,
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
  if (value.workflow !== undefined && value.workflow !== "event")
    throw new Error("Pending action workflow is invalid.");
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
      "locked-discarded",
      "terminally-rejected",
    ].includes(value.status as string)
  ) {
    throw new Error("Pending action status is invalid.");
  }
  const predecessors = value.causalPredecessorIds.map((candidate) =>
    requireIdentifier(candidate, "causalPredecessorId"),
  );
  if (
    new Set(predecessors).size !== predecessors.length ||
    predecessors.includes(intent.value.operationId)
  )
    throw new Error("Pending action causal predecessors are invalid.");
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
    workflow: "event",
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
  if (
    phase !== "scheduled" &&
    phase !== "in-progress" &&
    phase !== "suspended" &&
    phase !== "finished"
  )
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
  const knownDodgeballIds = parseKnownDodgeballIds(value.knownDodgeballIds);
  const timeout = value.timeout === undefined ? undefined : parseTimeoutState(value.timeout);
  const suspension =
    value.suspension === undefined ? undefined : parseSuspensionState(value.suspension);
  const stoppage = value.stoppage === undefined ? undefined : parseStoppageState(value.stoppage);
  const heat = value.heat === undefined ? undefined : parseHeatState(value.heat);
  const result = value.result === undefined ? undefined : parseResultState(value.result);
  const overtime =
    value.overtime === undefined ? undefined : parseBoolean(value.overtime, "overtime");
  const overtimeTarget = parseOptionalScore(value.overtimeTarget ?? value.targetScore);
  const winnerGameSideId = parseOptionalIdentifier(value.winnerGameSideId, "winnerGameSideId");
  const catchState = parseOptionalCatch(value.catch);
  const penalties =
    value.penalties === undefined
      ? undefined
      : deriveLivePenaltyProjection(
          gameFacts ?? [],
          isRecord(clock) && typeof clock.gameTimeMs === "number" ? clock.gameTimeMs : 0,
        );
  return {
    eventGameId,
    phase,
    scoreByGameSide: scores,
    goalCount: goalCount.value,
    ...(value.knownDodgeballIds === undefined ? {} : { knownDodgeballIds }),
    ...(value.penalties === undefined ? {} : { penalties }),
    ...(value.timeout === undefined ? {} : { timeout }),
    ...(value.suspension === undefined ? {} : { suspension }),
    ...(value.stoppage === undefined ? {} : { stoppage }),
    ...(value.heat === undefined ? {} : { heat }),
    ...(value.result === undefined ? {} : { result }),
    ...(overtime === undefined ? {} : { overtime }),
    ...(overtimeTarget === undefined ? {} : { overtimeTarget, targetScore: overtimeTarget }),
    ...(winnerGameSideId === undefined ? {} : { winnerGameSideId }),
    ...(catchState === undefined ? {} : { catch: catchState }),
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

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Projection ${field} is invalid.`);
  return value;
}

function parseOptionalScore(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const parsed = validateIntegerInRange(value, 0, SHARED_LIMITS.score.max, "overtimeTarget");
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function parseOptionalIdentifier(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return requireIdentifier(value, field);
}

function parseOptionalCatch(value: unknown): LiveCatchState | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isRecord(value)) throw new Error("Projection catch state is invalid.");
  const gameTimeMs = validateIntegerInRange(
    value.gameTimeMs,
    0,
    SHARED_LIMITS.clock.maxMs,
    "catch.gameTimeMs",
  );
  if (!gameTimeMs.ok) throw new Error(gameTimeMs.error);
  return {
    factId: requireIdentifier(value.factId, "catch.factId"),
    catchingGameSideId: requireIdentifier(value.catchingGameSideId, "catch.catchingGameSideId"),
    nonCatchingGameSideId: requireIdentifier(
      value.nonCatchingGameSideId,
      "catch.nonCatchingGameSideId",
    ),
    gameTimeMs: gameTimeMs.value,
    targetScore: parseOptionalScore(value.targetScore) ?? null,
  };
}

function parseTimeoutState(value: unknown): LiveTimeoutState {
  if (
    !isRecord(value) ||
    (value.status !== "inactive" &&
      value.status !== "stoppage" &&
      value.status !== "started" &&
      value.status !== "completed")
  ) {
    throw new Error("Projection timeout state is invalid.");
  }
  return {
    ...structuredClone(value),
    status: value.status,
    factId: parseNullableFactId(value.factId, "timeout.factId"),
  } as LiveTimeoutState;
}

function parseSuspensionState(value: unknown): LiveSuspensionState {
  if (!isRecord(value) || (value.status !== "none" && value.status !== "suspended")) {
    throw new Error("Projection suspension state is invalid.");
  }
  const factId = parseNullableFactId(value.factId, "suspension.factId");
  if (value.snapshot === null || value.snapshot === undefined) {
    if (value.status === "suspended") {
      throw new Error("Suspended projection must include a recovery snapshot.");
    }
    return { status: value.status, factId, snapshot: null };
  }
  if (!isRecord(value.snapshot) || !isRecord(value.snapshot.scoreByGameSide)) {
    throw new Error("Projection suspension snapshot is invalid.");
  }
  if (value.snapshot.version !== LIVE_SUSPENSION_SNAPSHOT_VERSION) {
    throw new Error("Projection suspension snapshot version is invalid.");
  }
  const parsedScores: Record<string, number> = {};
  for (const [sideId, score] of Object.entries(value.snapshot.scoreByGameSide)) {
    if (!validateOpaqueIdentifier(sideId, "suspension.snapshot.gameSideId").ok) {
      throw new Error("Projection suspension side is invalid.");
    }
    const parsed = validateIntegerInRange(score, 0, SHARED_LIMITS.score.max, "suspension.score");
    if (!parsed.ok) throw new Error(parsed.error);
    parsedScores[sideId] = parsed.value;
  }
  const penalties = parsePenaltyState(value.snapshot.penalties);
  const volleyballPossession = value.snapshot.volleyballPossession;
  if (typeof volleyballPossession !== "string" || volleyballPossession.length === 0) {
    throw new Error("Projection volleyball possession is invalid.");
  }
  if (!isRecord(value.snapshot.dodgeballPossession)) {
    throw new Error("Projection dodgeball possession is invalid.");
  }
  if (Object.keys(value.snapshot.dodgeballPossession).length === 0) {
    throw new Error("Projection dodgeball possession is incomplete.");
  }
  const knownGameSideIds = new Set(Object.keys(parsedScores));
  if (!knownGameSideIds.has(volleyballPossession)) {
    throw new Error("Projection volleyball possession is not an admitted Game Side.");
  }
  const dodgeballPossession: Record<string, string | null> = {};
  for (const [ballId, possession] of Object.entries(value.snapshot.dodgeballPossession)) {
    if (!validateOpaqueIdentifier(ballId, "suspension.snapshot.dodgeballId").ok) {
      throw new Error("Projection dodgeball id is invalid.");
    }
    if (possession !== null && typeof possession !== "string") {
      throw new Error("Projection dodgeball possession is invalid.");
    }
    if (possession !== null && !knownGameSideIds.has(possession)) {
      throw new Error("Projection dodgeball possession is not an admitted Game Side.");
    }
    dodgeballPossession[ballId] = possession;
  }
  const gameTimeMs = validateIntegerInRange(
    value.snapshot.gameTimeMs,
    0,
    SHARED_LIMITS.clock.maxMs,
    "suspension.snapshot.gameTimeMs",
  );
  if (!gameTimeMs.ok) throw new Error(gameTimeMs.error);
  return {
    status: value.status,
    factId,
    snapshot: {
      version: LIVE_SUSPENSION_SNAPSHOT_VERSION,
      gameTimeMs: gameTimeMs.value,
      scoreByGameSide: parsedScores,
      penalties,
      volleyballPossession,
      dodgeballPossession,
    },
  };
}

function parseKnownDodgeballIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Projection known dodgeball identities are invalid.");
  }
  const ids = value.map((candidate) => requireIdentifier(candidate, "knownDodgeballId"));
  if (new Set(ids).size !== ids.length) {
    throw new Error("Projection known dodgeball identities are duplicated.");
  }
  return ids;
}

function parsePenaltyState(value: unknown): LiveSuspensionPenaltyState {
  if (!isRecord(value) || !Array.isArray(value.segments)) {
    throw new Error("Projection suspension penalties are invalid.");
  }
  const seen = new Set<string>();
  const segments = value.segments.map((segment) => {
    if (!isRecord(segment)) throw new Error("Projection suspension penalty is invalid.");
    const sourceFactId = requireIdentifier(segment.sourceFactId, "suspension.penalty.sourceFactId");
    const elapsedMs = validateIntegerInRange(
      segment.elapsedMs,
      0,
      60_000,
      "suspension.penalty.elapsedMs",
    );
    const remainingMs = validateIntegerInRange(
      segment.remainingMs,
      1,
      60_000,
      "suspension.penalty.remainingMs",
    );
    if (
      !elapsedMs.ok ||
      !remainingMs.ok ||
      elapsedMs.value + remainingMs.value !== 60_000 ||
      seen.has(sourceFactId) ||
      typeof segment.expirableByScore !== "boolean"
    ) {
      throw new Error("Projection suspension penalty timing is invalid.");
    }
    seen.add(sourceFactId);
    return {
      sourceFactId,
      elapsedMs: elapsedMs.value,
      remainingMs: remainingMs.value,
      expirableByScore: segment.expirableByScore,
      ...(segment.cardFactId === undefined
        ? {}
        : { cardFactId: requireIdentifier(segment.cardFactId, "suspension.penalty.cardFactId") }),
      ...(segment.cardType === undefined
        ? {}
        : {
            cardType:
              segment.cardType as LiveSuspensionPenaltyState["segments"][number]["cardType"],
          }),
      ...(segment.gameSideId === undefined
        ? {}
        : { gameSideId: requireIdentifier(segment.gameSideId, "suspension.penalty.gameSideId") }),
      ...(segment.playerKey === undefined
        ? {}
        : { playerKey: requireIdentifier(segment.playerKey, "suspension.penalty.playerKey") }),
      ...(segment.playerNumber === undefined
        ? {}
        : { playerNumber: segment.playerNumber as number | null }),
      ...(segment.eligibleForScoreAtGameTimeMs === undefined
        ? {}
        : { eligibleForScoreAtGameTimeMs: segment.eligibleForScoreAtGameTimeMs as number }),
      ...(segment.notBeforeGameTimeMs === undefined
        ? {}
        : { notBeforeGameTimeMs: segment.notBeforeGameTimeMs as number }),
      ...(segment.startsAtGameTimeMs === undefined
        ? {}
        : { startsAtGameTimeMs: segment.startsAtGameTimeMs as number }),
      ...(segment.endsAtGameTimeMs === undefined
        ? {}
        : { endsAtGameTimeMs: segment.endsAtGameTimeMs as number }),
    };
  });
  return { segments };
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
      value.status !== "required-skip" &&
      value.status !== "suppressed" &&
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
  const allowedDurationMs = parseNullableBoundedNumber(
    value.allowedDurationMs,
    "heat.allowedDurationMs",
  );
  const actualDurationMs = parseNullableBoundedNumber(
    value.actualDurationMs,
    "heat.actualDurationMs",
  );
  const mode =
    value.mode === undefined
      ? undefined
      : value.mode === "enabled" || value.mode === "disabled"
        ? value.mode
        : (() => {
            throw new Error("Projection heat mode is invalid.");
          })();
  const pendingTriggerGameTimeMs = parseNullableBoundedNumber(
    value.pendingTriggerGameTimeMs,
    "heat.pendingTriggerGameTimeMs",
  );
  const nextTriggerGameTimeMs = parseNullableBoundedNumber(
    value.nextTriggerGameTimeMs,
    "heat.nextTriggerGameTimeMs",
  );
  const pendingTrigger =
    value.pendingTrigger === undefined || value.pendingTrigger === null
      ? null
      : isRecord(value.pendingTrigger) &&
          Number.isSafeInteger(value.pendingTrigger.index) &&
          value.pendingTrigger.index >= 0 &&
          pendingTriggerGameTimeMs !== null
        ? { gameTimeMs: pendingTriggerGameTimeMs, index: value.pendingTrigger.index }
        : (() => {
            throw new Error("Projection heat pending trigger is invalid.");
          })();
  const triggerDecision =
    value.triggerDecision === undefined || value.triggerDecision === null
      ? null
      : value.triggerDecision === "end-of-drive" ||
          value.triggerDecision === "dead-volleyball" ||
          value.triggerDecision === "other-stoppage" ||
          value.triggerDecision === "skip" ||
          value.triggerDecision === "skip-required"
        ? value.triggerDecision
        : (() => {
            throw new Error("Projection heat trigger decision is invalid.");
          })();
  return {
    status: value.status,
    factId: parseNullableFactId(value.factId, "heat.factId"),
    startedAtGameTimeMs,
    nominalDurationMs,
    allowedDurationMs,
    actualDurationMs,
    ...(mode === undefined ? {} : { mode }),
    pendingTriggerId:
      value.pendingTriggerId === undefined || value.pendingTriggerId === null
        ? null
        : requireIdentifier(value.pendingTriggerId, "heat.pendingTriggerId"),
    pendingTrigger,
    pendingTriggerGameTimeMs,
    nextTriggerGameTimeMs,
    trigger:
      value.trigger === undefined || value.trigger === null
        ? null
        : isRecord(value.trigger) &&
            typeof value.trigger.id === "string" &&
            Number.isSafeInteger(value.trigger.gameTimeMs) &&
            Number.isSafeInteger(value.trigger.index)
          ? {
              id: requireIdentifier(value.trigger.id, "heat.trigger.id"),
              gameTimeMs: value.trigger.gameTimeMs,
              index: value.trigger.index,
            }
          : (() => {
              throw new Error("Projection heat trigger is invalid.");
            })(),
    permittedExtensionTriggerId:
      value.permittedExtensionTriggerId === undefined || value.permittedExtensionTriggerId === null
        ? null
        : requireIdentifier(value.permittedExtensionTriggerId, "heat.permittedExtensionTriggerId"),
    activeTriggerId:
      value.activeTriggerId === undefined || value.activeTriggerId === null
        ? null
        : requireIdentifier(value.activeTriggerId, "heat.activeTriggerId"),
    triggerDecision,
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
      ...(typeof candidate.trustedAtMs === "number" && Number.isSafeInteger(candidate.trustedAtMs)
        ? { trustedAtMs: candidate.trustedAtMs }
        : {}),
      ...(typeof candidate.acceptedAtMs === "number" && Number.isSafeInteger(candidate.acceptedAtMs)
        ? { acceptedAtMs: candidate.acceptedAtMs }
        : {}),
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
        "locked-discarded",
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
    trustedAtMs: 0,
    acceptedAtMs: 0,
    effective: true,
    data: fact.data as ControllerGameFact["data"],
  });
  return orderControllerGameFacts(facts);
}

function rebuildOptimisticProjection(
  state: ControllerReplicaState,
  gameFacts: readonly ControllerGameFact[],
  dispatchedAtMs: number,
): ControllerReplicaState {
  const projection = state.projection;
  const sideIds = Object.keys(projection.scoreByGameSide);
  const scoreByGameSide: Record<string, number> = Object.fromEntries(
    sideIds.map((side) => [side, 0]),
  );
  let goalCount = 0;
  let overtime = false;
  let overtimeTarget: number | null = null;
  let winnerGameSideId: string | null = null;
  let winnerFactId: string | null = null;
  let catchState: LiveCatchState | null = null;
  let resultFact: ControllerGameFact | null = null;

  const orderedGameFacts = orderControllerGameFacts(gameFacts);
  for (const fact of orderedGameFacts.filter((candidate) => candidate.effective)) {
    const side = fact.gameSideId;
    const data = isRecord(fact.data) ? fact.data : null;
    if (fact.factType === "goal") {
      if (side !== null && side in scoreByGameSide) {
        scoreByGameSide[side] = (scoreByGameSide[side] ?? 0) + 10;
      }
      goalCount += 1;
      if (overtimeTarget !== null && winnerGameSideId === null && side !== null) {
        if ((scoreByGameSide[side] ?? 0) >= overtimeTarget) {
          winnerGameSideId = side;
          winnerFactId = fact.factId;
        }
      }
      continue;
    }
    if (fact.factType === "flag-catch" && catchState === null && side !== null) {
      const nonCatching = sideIds.find((candidate) => candidate !== side);
      if (nonCatching === undefined) continue;
      const nonCatchingScore = scoreByGameSide[nonCatching] ?? 0;
      const catchingScore = (scoreByGameSide[side] ?? 0) + 30;
      const targetScore = nonCatchingScore + 30;
      if (targetScore > 1_000) continue;
      scoreByGameSide[side] = catchingScore;
      catchState = {
        factId: fact.factId,
        catchingGameSideId: side,
        nonCatchingGameSideId: nonCatching,
        gameTimeMs: fact.gameTimeMs ?? fact.sportingOrder,
        targetScore: catchingScore > nonCatchingScore ? null : targetScore,
      };
      if (catchingScore > nonCatchingScore) {
        winnerGameSideId = side;
        winnerFactId = fact.factId;
      } else {
        overtime = true;
        overtimeTarget = targetScore;
      }
      continue;
    }
    if (fact.factType === "concession" && side !== null) {
      const opponent = sideIds.find((candidate) => candidate !== side);
      if (opponent === undefined) continue;
      const concedingScore = scoreByGameSide[side] ?? 0;
      const opponentScore = scoreByGameSide[opponent] ?? 0;
      if (concedingScore >= opponentScore) {
        scoreByGameSide[opponent] =
          opponentScore + Math.max(10, Math.ceil((concedingScore + 10 - opponentScore) / 10) * 10);
      }
      winnerGameSideId = opponent;
      winnerFactId = fact.factId;
      resultFact = fact;
      continue;
    }
    if (fact.factType === "forfeit" && side !== null) {
      winnerGameSideId = sideIds.find((candidate) => candidate !== side) ?? null;
      winnerFactId = fact.factId;
      resultFact = fact;
      continue;
    }
    if (fact.factType === "double-forfeit") {
      winnerGameSideId = null;
      resultFact = fact;
      continue;
    }
    if (fact.factType === "result" && (!overtime || winnerGameSideId !== null)) {
      const declaredWinner =
        data !== null && "winnerGameSideId" in data ? data.winnerGameSideId : undefined;
      if (typeof declaredWinner === "string" && declaredWinner in scoreByGameSide) {
        winnerGameSideId = declaredWinner;
        winnerFactId = fact.factId;
      }
      resultFact = fact;
    }
  }

  if (Object.values(scoreByGameSide).some((score) => score > SHARED_LIMITS.score.max)) {
    return state;
  }
  const dependentState = deriveOptimisticDependentState(
    gameFacts,
    projection.heat?.mode === "enabled",
    projection.clock.gameTimeMs,
  );
  const hasHeatEvidence = gameFacts.some(
    (fact) =>
      fact.effective && (fact.factType === "heat-stoppage" || fact.factType === "heat-mode"),
  );
  const optimisticHeat =
    !hasHeatEvidence && projection.heat?.mode === undefined ? projection.heat : dependentState.heat;
  const commencement =
    projection.commencement.status === "commenced"
      ? projection.commencement
      : {
          status: "commenced" as const,
          commencedAtMs: dispatchedAtMs,
          provisionalRunningSinceMs: null,
          provisionalElapsedMs: projection.commencement.provisionalElapsedMs,
        };
  const result: LiveResultState =
    resultFact === null && winnerFactId === null
      ? null
      : {
          factId: resultFact?.factId ?? winnerFactId!,
          data: structuredClone(
            resultFact?.data ?? { resultKind: "derived-score-completion", winnerGameSideId },
          ),
        };
  const effectiveResult = result !== null || winnerGameSideId !== null;
  const effectiveSuspension = gameFacts.some(
    (fact) => fact.effective && fact.factType === "suspension",
  );
  const phase = effectiveResult
    ? "finished"
    : effectiveSuspension && projection.phase === "suspended"
      ? "suspended"
      : commencement.status === "provisional"
        ? "scheduled"
        : "in-progress";
  return {
    ...state,
    projection: {
      ...projection,
      phase,
      scoreByGameSide,
      goalCount,
      commencement,
      timeout: dependentState.timeout,
      stoppage: dependentState.stoppage,
      heat: optimisticHeat,
      result,
      overtime,
      overtimeTarget,
      targetScore: overtimeTarget,
      winnerGameSideId,
      catch: catchState,
      gameFacts: structuredClone(gameFacts),
      penalties: deriveLivePenaltyProjection(gameFacts, projection.clock.gameTimeMs),
    },
  };
}

function deriveOptimisticDependentState(
  facts: readonly ControllerGameFact[],
  configuredHeatMode = false,
  gameTimeMs = 0,
): {
  timeout: LiveTimeoutState;
  suspension: LiveSuspensionState;
  stoppage: LiveStoppageState;
  heat: LiveHeatState;
  result: LiveResultState;
} {
  const latest = (factType: string) =>
    facts.filter((fact) => fact.effective && fact.factType === factType).at(-1) ?? null;
  const timeoutFacts = facts.filter((fact) => fact.effective && fact.factType === "timeout");
  const resultFact = latest("result");
  let suspension: LiveSuspensionState = { status: "none", factId: null, snapshot: null };
  for (const fact of facts.filter(
    (candidate) => candidate.effective && candidate.factType === "suspension",
  )) {
    const data = isRecord(fact.data) ? (fact.data as Record<string, unknown>) : null;
    if (data?.suspensionAction === "resume") {
      if (data.resumesSuspensionFactId === suspension.factId) {
        suspension = { status: "none", factId: null, snapshot: null };
      }
      continue;
    }
    if (data?.suspensionAction !== "start") continue;
    if (suspension.status === "suspended") continue;
    const rawSnapshot = data?.suspensionSnapshot;
    const snapshot =
      isRecord(rawSnapshot) && isRecord(rawSnapshot.scoreByGameSide)
        ? (structuredClone(rawSnapshot) as LiveSuspensionState["snapshot"])
        : null;
    suspension = { status: "suspended", factId: fact.factId, snapshot };
  }
  const heat = deriveHeatStoppageState(facts, gameTimeMs, configuredHeatMode);
  return {
    timeout: deriveOptimisticTimeoutState(timeoutFacts),
    suspension,
    stoppage:
      suspension.status === "suspended"
        ? { status: "suspension", factId: suspension.factId }
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

function deriveOptimisticTimeoutState(facts: readonly ControllerGameFact[]): LiveTimeoutState {
  const usedGameSideIds = new Set<string>();
  let timeout: LiveTimeoutState = {
    status: "inactive",
    factId: null,
    gameSideId: null,
    usedGameSideIds: [],
    startedAtMs: null,
    remainingMs: null,
    longWhistleCue: "not-applicable",
  };
  for (const fact of facts) {
    const data = isRecord(fact.data) ? (fact.data as Record<string, unknown>) : null;
    if (data === null || typeof data.timeoutGameSideId !== "string") continue;
    const gameSideId = data.timeoutGameSideId;
    if (gameSideId !== null) usedGameSideIds.add(gameSideId);
    const action =
      data?.timeoutAction === "stoppage" ||
      data?.timeoutAction === "complete" ||
      data?.timeoutAction === "start"
        ? data.timeoutAction
        : null;
    if (action === null) continue;
    timeout = {
      status: action === "stoppage" ? "stoppage" : action === "complete" ? "completed" : "started",
      factId: fact.factId,
      gameSideId,
      usedGameSideIds: [...usedGameSideIds].sort(),
      startedAtMs:
        action === "start" && data !== null && typeof data.timeoutStartedAtMs === "number"
          ? data.timeoutStartedAtMs
          : null,
      remainingMs: action === "start" ? 60_000 : action === "complete" ? 0 : null,
      longWhistleCue:
        action === "start" ? "pending" : action === "complete" ? "passed" : "not-applicable",
    };
  }
  return timeout;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
