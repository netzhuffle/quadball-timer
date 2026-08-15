import {
  SHARED_LIMITS,
  validateClockAdjustmentMs,
  validateGameClockMs,
  validateIntegerInRange,
  type ValidationResult,
} from "@/lib/validation-policy";

export const FLAG_RUNNER_ENTRY_MS = 19 * 60 * 1000;
export const SEEKER_RELEASE_MS = 20 * 60 * 1000;
export const CLOCK_AUTHORITY_VERSION = "clock-authority-v1" as const;

export type ClockSynchronization = "synchronized" | "estimated" | "stale" | "unavailable";

export type ClockAuthorityAction = {
  operationId: string;
  trustedAtMs: number;
  acceptedAtMs: number;
  sessionId: string;
  command: "set-running" | "adjust" | "correct" | "penalty-start" | "takeover";
  authorityGeneration?: number;
  source?: "online" | "offline";
  takeover?: boolean;
  running?: boolean;
  gameTimeMs?: number;
  adjustmentMs?: number;
};

export type ClockPenaltyBaseline = {
  elapsedMs: number;
  establishedAtMs: number;
  sourceOperationId: string;
};

export type ClockBaseline = {
  version: typeof CLOCK_AUTHORITY_VERSION;
  gameTimeMs: number;
  /** Compatibility field; this is the independent active-penalty elapsed value. */
  penaltyTimeMs: number;
  activePenalty: ClockPenaltyBaseline | null;
  running: boolean;
  runningSinceMs: number | null;
  establishedAtMs: number;
  holderGrantSessionId: string | null;
  holderGeneration: number;
  lastTransitionOperationId: string | null;
  lastAcceptedAtMs: number | null;
  authorityGeneration: number;
  staleGenerationOperationIds: readonly string[];
};

export type ClockCueState = {
  flagRunnerEntry: "pending" | "due" | "passed";
  seekerWarning: "pending" | "due" | "passed";
  seekerCountdownMs: number | null;
  seekerRelease: "pending" | "released";
};

export type ClockProjection = {
  version: typeof CLOCK_AUTHORITY_VERSION;
  baseline: ClockBaseline;
  gameTimeMs: number;
  activePenaltyTimeMs: number;
  running: boolean;
  projectedAtMs: number;
  synchronization: ClockSynchronization;
  lastSynchronizedAtMs: number | null;
  offlineClockHolderGrantSessionId: string | null;
  cues: ClockCueState;
};

export function validateClockFactData(value: unknown): ValidationResult<unknown> {
  if (!isRecord(value)) return invalid("Clock Fact data must be an object.");
  if (value.startedAtMs !== undefined && value.startedAtMs !== null) {
    const startedAtMs = validateIntegerInRange(
      value.startedAtMs,
      0,
      Number.MAX_SAFE_INTEGER,
      "Clock Fact startedAtMs",
    );
    if (!startedAtMs.ok) return startedAtMs;
  }
  const command = value.command;
  if (command === "takeover") {
    const gameTimeMs = validateGameClockMs(value.gameTimeMs);
    const authorityGeneration = validateIntegerInRange(
      value.authorityGeneration,
      0,
      Number.MAX_SAFE_INTEGER,
      "Clock takeover authorityGeneration",
    );
    if (!gameTimeMs.ok) return gameTimeMs;
    if (typeof value.running !== "boolean")
      return invalid("Clock takeover running must be a boolean.");
    if (!authorityGeneration.ok) return authorityGeneration;
    if (value.confirmation !== "physical-timekeeper-or-head-referee") {
      return invalid("Clock takeover confirmation is required.");
    }
    return valid(value);
  }
  if (command !== "set-running" && command !== "adjust" && command !== "correct") {
    if (typeof value.running !== "boolean") {
      return invalid("Clock Fact data command is unsupported.");
    }
    return valid(value);
  }
  if (command === "set-running") {
    if (typeof value.running !== "boolean") return invalid("Clock Fact running must be a boolean.");
    return valid(value);
  }
  if (command === "adjust") {
    const adjustmentMs = validateClockAdjustmentMs(value.adjustmentMs);
    if (!adjustmentMs.ok) return adjustmentMs;
    return valid(value);
  }
  const gameTimeMs = validateGameClockMs(value.gameTimeMs);
  if (!gameTimeMs.ok) return gameTimeMs;
  return valid(value);
}

export function createInitialClockBaseline(): ClockBaseline {
  return {
    version: CLOCK_AUTHORITY_VERSION,
    gameTimeMs: 0,
    penaltyTimeMs: 0,
    activePenalty: null,
    running: false,
    runningSinceMs: null,
    establishedAtMs: 0,
    holderGrantSessionId: null,
    holderGeneration: 0,
    lastTransitionOperationId: null,
    lastAcceptedAtMs: null,
    authorityGeneration: 0,
    staleGenerationOperationIds: [],
  };
}

/** Fold the accepted immutable action set in trusted-occurrence order. */
export function deriveClockAuthority(actions: readonly ClockAuthorityAction[]): ClockBaseline {
  const uniqueActions = new Map<string, ClockAuthorityAction>();
  for (const action of actions) {
    if (!uniqueActions.has(action.operationId)) uniqueActions.set(action.operationId, action);
  }
  const ordered = [...uniqueActions.values()].sort(compareClockActions);
  let baseline = createInitialClockBaseline();
  const appliedClockActions: ClockAuthorityAction[] = [];

  for (const action of ordered) {
    baseline = advanceBaseline(baseline, action.trustedAtMs);
    const transitioned = applyClockAction(baseline, action);
    if (transitioned === null) continue;
    baseline = transitioned;
    if (
      action.command !== "penalty-start" &&
      baseline.lastTransitionOperationId === action.operationId
    ) {
      appliedClockActions.push(action);
    }
  }

  const latestAccepted = [...appliedClockActions].sort(compareAcceptedClockActions).at(-1) ?? null;
  return {
    ...baseline,
    holderGrantSessionId: latestAccepted?.sessionId ?? null,
    holderGeneration: appliedClockActions.length,
    lastAcceptedAtMs: latestAccepted?.acceptedAtMs ?? null,
    authorityGeneration: appliedClockActions.length,
  };
}

/** Validate a candidate without inserting it; callers invoke this in a storage transaction. */
export function validateClockAuthorityAction(
  actions: readonly ClockAuthorityAction[],
  candidate: ClockAuthorityAction,
): ValidationResult<null> {
  const uniqueActions = new Map<string, ClockAuthorityAction>();
  for (const action of [...actions, candidate]) {
    if (!uniqueActions.has(action.operationId)) uniqueActions.set(action.operationId, action);
  }
  let baseline = createInitialClockBaseline();
  for (const action of [...uniqueActions.values()].sort(compareClockActions)) {
    baseline = advanceBaseline(baseline, action.trustedAtMs);
    const transitioned = applyClockAction(baseline, action);
    if (transitioned === null) {
      return action.operationId === candidate.operationId
        ? invalid("Clock transition exceeds the durable game-clock bounds.")
        : invalid("Clock history contains an out-of-bounds transition.");
    }
    baseline = transitioned;
  }
  return valid(null);
}

export function projectClockBaseline(baseline: ClockBaseline, nowMs: number): ClockProjection {
  const projected = advanceBaseline(baseline, nowMs);
  return createProjection(projected, nowMs);
}

export function markClockProjectionUnavailable(projection: ClockProjection): ClockProjection {
  return {
    ...structuredClone(projection),
    synchronization: "unavailable",
  };
}

export function applyClockProjectionAction(
  projection: ClockProjection,
  action: {
    command: "set-running" | "adjust" | "correct" | "takeover";
    running?: boolean;
    gameTimeMs?: number;
    adjustmentMs?: number;
    authorityGeneration?: number;
    sessionId?: string;
    operationId?: string;
  },
): ClockProjection {
  const current = structuredClone(projection);
  const baselineDefaults = {
    authorityGeneration: Number.isSafeInteger(current.baseline.authorityGeneration)
      ? current.baseline.authorityGeneration
      : 0,
    staleGenerationOperationIds: current.baseline.staleGenerationOperationIds ?? [],
  };
  current.baseline = { ...current.baseline, ...baselineDefaults };
  const currentGameTimeMs = current.gameTimeMs;
  const actionGameTimeMs = action.gameTimeMs ?? currentGameTimeMs;
  const nextGameTimeMs =
    action.command === "adjust"
      ? actionGameTimeMs + (action.adjustmentMs ?? 0)
      : action.command === "correct" || action.command === "takeover"
        ? actionGameTimeMs
        : currentGameTimeMs;
  const validatedGameTime = validateGameClockMs(nextGameTimeMs);
  if (!validatedGameTime.ok) return current;
  const running =
    action.command === "set-running" || action.command === "takeover"
      ? action.running === true
      : current.running;
  const baseline: ClockBaseline = {
    ...current.baseline,
    gameTimeMs: validatedGameTime.value,
    penaltyTimeMs: current.baseline.activePenalty?.elapsedMs ?? 0,
    running: running && validatedGameTime.value < SHARED_LIMITS.clock.maxMs,
    runningSinceMs: !running
      ? null
      : action.command === "takeover" || !current.running
        ? current.projectedAtMs
        : current.baseline.runningSinceMs,
    establishedAtMs: current.projectedAtMs,
    holderGrantSessionId: action.sessionId ?? current.baseline.holderGrantSessionId,
    authorityGeneration:
      action.command === "takeover"
        ? current.baseline.authorityGeneration + 1
        : Math.max(current.baseline.authorityGeneration, action.authorityGeneration ?? 0) + 1,
    lastTransitionOperationId: action.operationId ?? current.baseline.lastTransitionOperationId,
  };
  baseline.holderGeneration = baseline.authorityGeneration;
  return {
    ...current,
    baseline,
    gameTimeMs: baseline.gameTimeMs,
    running: baseline.running,
    activePenaltyTimeMs: baseline.activePenalty?.elapsedMs ?? 0,
    synchronization: baseline.running ? "estimated" : "stale",
    lastSynchronizedAtMs: current.lastSynchronizedAtMs ?? current.baseline.lastAcceptedAtMs ?? null,
    cues: cuesFor(baseline.gameTimeMs),
  };
}

/** Advance a server sample by local monotonic elapsed time, never wall time. */
export function projectClockSample(
  projection: ClockProjection,
  elapsedMs: number,
): ClockProjection {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || !projection.running) {
    return {
      ...structuredClone(projection),
      synchronization: projection.running ? "estimated" : "stale",
    };
  }
  const elapsed = Math.floor(elapsedMs);
  const gameTimeMs = Math.min(SHARED_LIMITS.clock.maxMs, projection.gameTimeMs + elapsed);
  const activePenaltyTimeMs =
    projection.baseline.activePenalty === null
      ? 0
      : Math.min(SHARED_LIMITS.clock.maxMs, projection.activePenaltyTimeMs + elapsed);
  const projected = {
    ...structuredClone(projection),
    gameTimeMs,
    activePenaltyTimeMs,
    running: gameTimeMs < SHARED_LIMITS.clock.maxMs,
    projectedAtMs: projection.projectedAtMs + elapsed,
    synchronization: "estimated" as const,
  };
  return { ...projected, cues: cuesFor(gameTimeMs) };
}

function createProjection(baseline: ClockBaseline, projectedAtMs: number): ClockProjection {
  return {
    version: CLOCK_AUTHORITY_VERSION,
    baseline: structuredClone(baseline),
    gameTimeMs: baseline.gameTimeMs,
    activePenaltyTimeMs: baseline.activePenalty?.elapsedMs ?? 0,
    running: baseline.running,
    projectedAtMs,
    synchronization: "synchronized",
    lastSynchronizedAtMs: baseline.lastAcceptedAtMs ?? null,
    offlineClockHolderGrantSessionId: baseline.holderGrantSessionId,
    cues: cuesFor(baseline.gameTimeMs),
  };
}

function cuesFor(gameTimeMs: number): ClockCueState {
  const countdown =
    gameTimeMs >= FLAG_RUNNER_ENTRY_MS && gameTimeMs < SEEKER_RELEASE_MS
      ? SEEKER_RELEASE_MS - gameTimeMs
      : null;
  return {
    flagRunnerEntry:
      gameTimeMs < FLAG_RUNNER_ENTRY_MS
        ? "pending"
        : gameTimeMs < SEEKER_RELEASE_MS
          ? "due"
          : "passed",
    seekerWarning:
      gameTimeMs < FLAG_RUNNER_ENTRY_MS
        ? "pending"
        : gameTimeMs < SEEKER_RELEASE_MS
          ? "due"
          : "passed",
    seekerCountdownMs: countdown,
    seekerRelease: gameTimeMs >= SEEKER_RELEASE_MS ? "released" : "pending",
  };
}

function advanceBaseline(baseline: ClockBaseline, atMs: number): ClockBaseline {
  if (!Number.isSafeInteger(atMs) || atMs <= baseline.establishedAtMs || !baseline.running) {
    return { ...baseline };
  }

  const elapsedMs = atMs - baseline.establishedAtMs;
  const gameElapsedMs = Math.min(
    elapsedMs,
    Math.max(0, SHARED_LIMITS.clock.maxMs - baseline.gameTimeMs),
  );
  const gameTimeMs = baseline.gameTimeMs + gameElapsedMs;
  const activePenalty =
    baseline.activePenalty === null
      ? null
      : {
          ...baseline.activePenalty,
          elapsedMs: Math.min(
            SHARED_LIMITS.clock.maxMs,
            baseline.activePenalty.elapsedMs + gameElapsedMs,
          ),
          establishedAtMs: atMs,
        };
  return {
    ...baseline,
    gameTimeMs,
    penaltyTimeMs: activePenalty?.elapsedMs ?? 0,
    activePenalty,
    establishedAtMs: atMs,
    running: gameTimeMs < SHARED_LIMITS.clock.maxMs,
  };
}

function compareClockActions(left: ClockAuthorityAction, right: ClockAuthorityAction): number {
  return left.trustedAtMs - right.trustedAtMs || left.operationId.localeCompare(right.operationId);
}

function compareAcceptedClockActions(
  left: ClockAuthorityAction,
  right: ClockAuthorityAction,
): number {
  return (
    left.acceptedAtMs - right.acceptedAtMs || left.operationId.localeCompare(right.operationId)
  );
}

function applyClockAction(
  baseline: ClockBaseline,
  action: ClockAuthorityAction,
): ClockBaseline | null {
  if (
    action.authorityGeneration !== undefined &&
    action.command !== "takeover" &&
    action.authorityGeneration !== baseline.authorityGeneration
  ) {
    return {
      ...baseline,
      staleGenerationOperationIds: [...baseline.staleGenerationOperationIds, action.operationId],
    };
  }
  if (
    action.command === "takeover" &&
    action.authorityGeneration !== undefined &&
    action.authorityGeneration !== baseline.authorityGeneration
  ) {
    return {
      ...baseline,
      staleGenerationOperationIds: [...baseline.staleGenerationOperationIds, action.operationId],
    };
  }
  if (action.command === "penalty-start") {
    return baseline.activePenalty === null
      ? {
          ...baseline,
          penaltyTimeMs: 0,
          activePenalty: {
            elapsedMs: 0,
            establishedAtMs: action.trustedAtMs,
            sourceOperationId: action.operationId,
          },
        }
      : baseline;
  }

  if (action.command === "takeover") {
    const validatedGameTime = validateGameClockMs(action.gameTimeMs);
    if (!validatedGameTime.ok || action.running === undefined) return null;
    return {
      ...baseline,
      gameTimeMs: validatedGameTime.value,
      running: action.running && validatedGameTime.value < SHARED_LIMITS.clock.maxMs,
      runningSinceMs: action.running ? action.trustedAtMs : null,
      establishedAtMs: action.trustedAtMs,
      holderGrantSessionId: action.sessionId,
      holderGeneration: baseline.holderGeneration + 1,
      authorityGeneration: baseline.authorityGeneration + 1,
      lastTransitionOperationId: action.operationId,
    };
  }

  const nextGameTimeMs =
    action.command === "adjust"
      ? baseline.gameTimeMs + (action.adjustmentMs ?? 0)
      : action.command === "correct"
        ? action.gameTimeMs
        : baseline.gameTimeMs;
  const validatedGameTime = validateGameClockMs(nextGameTimeMs);
  if (!validatedGameTime.ok) return null;
  const nextRunning =
    action.command === "set-running" && action.running !== undefined
      ? action.running
      : baseline.running;
  return {
    ...baseline,
    gameTimeMs: validatedGameTime.value,
    running: nextRunning && validatedGameTime.value < SHARED_LIMITS.clock.maxMs,
    runningSinceMs: nextRunning
      ? baseline.running
        ? baseline.runningSinceMs
        : action.trustedAtMs
      : null,
    establishedAtMs: action.trustedAtMs,
    lastTransitionOperationId: action.operationId,
    authorityGeneration: baseline.authorityGeneration + 1,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valid<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

function invalid<T>(error: string): ValidationResult<T> {
  return { ok: false, error };
}
