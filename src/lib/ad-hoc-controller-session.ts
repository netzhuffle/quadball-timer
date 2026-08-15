import type { GameCommand, GameState } from "@/lib/game-types";
import { parseGameCommand } from "@/lib/ws-protocol";
import { validateOpaqueIdentifier } from "@/lib/validation-policy";

export const AD_HOC_CONTROLLER_SESSION_VERSION = "ad-hoc-controller-session-v1" as const;

export type AdHocPendingOperation = {
  id: string;
  clientSentAtMs: number;
  command: GameCommand;
  workflow: "ad-hoc";
  causalPredecessorIds: string[];
};

export type AdHocControllerSession = {
  version: typeof AD_HOC_CONTROLLER_SESSION_VERSION;
  workflow: "ad-hoc";
  gameId: string;
  state: GameState;
  authoritativeState?: GameState;
  pendingOperations: AdHocPendingOperation[];
  outcomes: Record<string, "accepted" | "duplicate" | "rejected" | "causally-blocked">;
  operationCounter: number;
  savedAtMs: number;
};

export function getAdHocControllerSessionStorageKey(gameId: string) {
  return `quadball:ad-hoc-controller:${gameId}`;
}

export function clearAdHocControllerSession(gameId: string) {
  try {
    window.localStorage.removeItem(getAdHocControllerSessionStorageKey(gameId));
  } catch {
    // Local recovery is best effort; server authority remains authoritative.
  }
}

export function serializeAdHocControllerSession(session: AdHocControllerSession) {
  validateAdHocControllerSession(session);
  return JSON.stringify(session);
}

export function parseAdHocControllerSession(
  raw: string,
  expectedGameId: string,
): AdHocControllerSession | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || value.version !== AD_HOC_CONTROLLER_SESSION_VERSION) return null;
    if (value.workflow !== "ad-hoc" || value.gameId !== expectedGameId) return null;
    if (!isValidGameState(value.state, expectedGameId)) return null;
    if (
      value.authoritativeState !== undefined &&
      !isValidGameState(value.authoritativeState, expectedGameId)
    )
      return null;
    if (!Array.isArray(value.pendingOperations) || !isRecord(value.outcomes)) return null;
    if (
      typeof value.operationCounter !== "number" ||
      !Number.isSafeInteger(value.operationCounter) ||
      value.operationCounter < 0 ||
      typeof value.savedAtMs !== "number" ||
      !Number.isSafeInteger(value.savedAtMs) ||
      value.savedAtMs < 0
    ) {
      return null;
    }
    const pendingOperations = value.pendingOperations.map(parsePendingOperation);
    if (pendingOperations.some((operation) => operation === null)) return null;
    const pendingIds = new Set(
      pendingOperations
        .map((operation) => operation?.id)
        .filter((id): id is string => id !== undefined),
    );
    for (const operation of pendingOperations) {
      if (operation === null) continue;
      if (
        new Set(operation.causalPredecessorIds).size !== operation.causalPredecessorIds.length ||
        operation.causalPredecessorIds.includes(operation.id) ||
        operation.causalPredecessorIds.some(
          (predecessor) =>
            !pendingIds.has(predecessor) && !outcomeIsAccepted(value.outcomes, predecessor),
        )
      )
        return null;
    }
    const outcomes: AdHocControllerSession["outcomes"] = {};
    for (const [operationId, status] of Object.entries(value.outcomes)) {
      if (!validateOpaqueIdentifier(operationId, "operationId").ok) return null;
      if (
        status !== "accepted" &&
        status !== "duplicate" &&
        status !== "rejected" &&
        status !== "causally-blocked"
      ) {
        return null;
      }
      outcomes[operationId] = status;
    }
    const pendingGraph = new Map(
      pendingOperations
        .filter((operation): operation is AdHocPendingOperation => operation !== null)
        .map((operation) => [operation.id, operation.causalPredecessorIds]),
    );
    for (const operationId of pendingGraph.keys()) {
      if (hasCycle(operationId, pendingGraph, new Set(), new Set())) return null;
    }
    return {
      version: AD_HOC_CONTROLLER_SESSION_VERSION,
      workflow: "ad-hoc",
      gameId: expectedGameId,
      state: value.state as GameState,
      authoritativeState: value.authoritativeState as GameState | undefined,
      pendingOperations: pendingOperations as AdHocPendingOperation[],
      outcomes,
      operationCounter: value.operationCounter,
      savedAtMs: value.savedAtMs,
    };
  } catch {
    return null;
  }
}

export function validateAdHocControllerSession(session: AdHocControllerSession) {
  if (session.version !== AD_HOC_CONTROLLER_SESSION_VERSION || session.workflow !== "ad-hoc") {
    throw new Error("Ad Hoc Controller session version is unsupported.");
  }
  if (!isValidGameState(session.state, session.gameId)) {
    throw new Error("Ad Hoc Controller session state is invalid.");
  }
  if (
    session.authoritativeState !== undefined &&
    !isValidGameState(session.authoritativeState, session.gameId)
  ) {
    throw new Error("Ad Hoc Controller authoritative state is invalid.");
  }
  if (!Number.isSafeInteger(session.operationCounter) || session.operationCounter < 0) {
    throw new Error("Ad Hoc Controller operation counter is invalid.");
  }
  for (const operation of session.pendingOperations) {
    if (parsePendingOperation(operation) === null) {
      throw new Error("Ad Hoc pending operation is invalid.");
    }
  }
  const pendingIds = new Set(session.pendingOperations.map((operation) => operation.id));
  const graph = new Map(
    session.pendingOperations.map((operation) => [operation.id, operation.causalPredecessorIds]),
  );
  for (const operation of session.pendingOperations) {
    if (
      new Set(operation.causalPredecessorIds).size !== operation.causalPredecessorIds.length ||
      operation.causalPredecessorIds.includes(operation.id) ||
      operation.causalPredecessorIds.some(
        (predecessor) =>
          !pendingIds.has(predecessor) &&
          session.outcomes[predecessor] !== "accepted" &&
          session.outcomes[predecessor] !== "duplicate",
      )
    )
      throw new Error("Ad Hoc pending causal references are invalid.");
  }
  for (const operationId of graph.keys()) {
    if (hasCycle(operationId, graph, new Set(), new Set()))
      throw new Error("Ad Hoc pending causal graph contains a cycle.");
  }
}

function parsePendingOperation(value: unknown): AdHocPendingOperation | null {
  if (!isRecord(value)) return null;
  const id = validateOpaqueIdentifier(value.id, "operationId");
  if (
    !id.ok ||
    value.workflow !== "ad-hoc" ||
    typeof value.clientSentAtMs !== "number" ||
    !Number.isSafeInteger(value.clientSentAtMs) ||
    value.clientSentAtMs < 0 ||
    !isRecord(value.command) ||
    !Array.isArray(value.causalPredecessorIds) ||
    value.causalPredecessorIds.some(
      (predecessor) => !validateOpaqueIdentifier(predecessor, "causalPredecessorId").ok,
    )
  ) {
    return null;
  }
  const command = parseGameCommand(value.command);
  if (!command.ok) return null;
  return {
    id: id.value,
    clientSentAtMs: value.clientSentAtMs,
    command: command.command,
    workflow: "ad-hoc",
    causalPredecessorIds: [...value.causalPredecessorIds],
  };
}

function outcomeIsAccepted(value: unknown, operationId: string) {
  return (
    isRecord(value) && (value[operationId] === "accepted" || value[operationId] === "duplicate")
  );
}

function isValidGameState(value: unknown, expectedId: string): value is GameState {
  if (!isRecord(value) || value.id !== expectedId) return false;
  const numericFields = ["createdAtMs", "updatedAtMs", "gameClockMs"];
  if (numericFields.some((field) => !isSafeNumber(value[field]))) return false;
  if (value.gameClockMs < 0 || value.gameClockMs > 7_200_000) return false;
  if (
    typeof value.homeName !== "string" ||
    value.homeName.trim().length === 0 ||
    typeof value.awayName !== "string" ||
    value.awayName.trim().length === 0 ||
    typeof value.homeColor !== "string" ||
    !/^#?[0-9a-fA-F]{6}$/u.test(value.homeColor) ||
    typeof value.awayColor !== "string" ||
    !/^#?[0-9a-fA-F]{6}$/u.test(value.awayColor)
  )
    return false;
  if (
    ["displaySidesSwapped", "isRunning", "isFinished", "isSuspended", "isOvertime"].some(
      (field) => typeof value[field] !== "boolean",
    ) ||
    (value.suspendedAtMs !== null && !isSafeNumber(value.suspendedAtMs)) ||
    (value.winner !== null && value.winner !== "home" && value.winner !== "away") ||
    (value.finishReason !== null &&
      !["forfeit", "double-forfeit", "flag-catch", "target-score", "concede"].includes(
        value.finishReason,
      ))
  )
    return false;
  if (!isRecord(value.score) || !isScore(value.score.home) || !isScore(value.score.away))
    return false;
  if (
    !Array.isArray(value.scoreEvents) ||
    !Array.isArray(value.cardEvents) ||
    !Array.isArray(value.pendingExpirations) ||
    !Array.isArray(value.recentReleases) ||
    !isRecord(value.players) ||
    !isRecord(value.timeouts) ||
    !isRecord(value.nextUnknownPlayerId) ||
    !isScore(value.nextUnknownPlayerId.home) ||
    !isScore(value.nextUnknownPlayerId.away)
  )
    return false;
  if (
    !isRecord(value.timeouts.home) ||
    !isRecord(value.timeouts.away) ||
    typeof value.timeouts.home.used !== "boolean" ||
    typeof value.timeouts.away.used !== "boolean" ||
    (value.timeouts.active !== null && !isRecord(value.timeouts.active))
  )
    return false;
  if (
    value.timeouts.active !== null &&
    (!isTeam(value.timeouts.active.team) ||
      typeof value.timeouts.active.running !== "boolean" ||
      !isSafeNumber(value.timeouts.active.remainingMs))
  )
    return false;
  if (
    value.flagCatch !== null &&
    (!isRecord(value.flagCatch) ||
      !isTeam(value.flagCatch.team) ||
      !isSafeNumber(value.flagCatch.createdAtMs))
  )
    return false;
  for (const [key, player] of Object.entries(value.players)) {
    if (
      !validateOpaqueIdentifier(key, "playerKey").ok ||
      !isRecord(player) ||
      player.key !== key ||
      !isTeam(player.team)
    )
      return false;
    if (player.playerNumber !== null && !isScore(player.playerNumber)) return false;
    if (!Array.isArray(player.segments)) return false;
    for (const segment of player.segments) {
      if (
        !isRecord(segment) ||
        !validateOpaqueIdentifier(segment.id, "segmentId").ok ||
        !isSafeNumber(segment.remainingMs) ||
        segment.remainingMs < 0 ||
        typeof segment.expirableByScore !== "boolean"
      )
        return false;
    }
  }
  return (
    value.scoreEvents.every(isPersistedScoreEvent) &&
    value.cardEvents.every(isPersistedCardEvent) &&
    value.pendingExpirations.every(isPersistedPending) &&
    value.recentReleases.every(isPersistedRelease)
  );
}

function isPersistedScoreEvent(value: unknown): boolean {
  return (
    isRecord(value) &&
    validateOpaqueIdentifier(value.id, "scoreEventId").ok &&
    isTeam(value.team) &&
    isScoreEventPoints(value.points) &&
    isSafeNumber(value.createdAtMs) &&
    (value.reason === "goal" || value.reason === "flag-catch") &&
    (value.pendingExpirationId === null ||
      validateOpaqueIdentifier(value.pendingExpirationId, "pendingExpirationId").ok) &&
    (value.undoneAtMs === null || isSafeNumber(value.undoneAtMs))
  );
}
function isPersistedCardEvent(value: unknown): boolean {
  return (
    isRecord(value) &&
    validateOpaqueIdentifier(value.id, "cardEventId").ok &&
    isTeam(value.team) &&
    (value.playerKey === null || validateOpaqueIdentifier(value.playerKey, "playerKey").ok) &&
    (value.playerNumber === null || isScore(value.playerNumber)) &&
    ["blue", "yellow", "red", "ejection"].includes(value.cardType) &&
    isSafeNumber(value.createdAtMs)
  );
}
function isPersistedPending(value: unknown): boolean {
  return (
    isRecord(value) &&
    validateOpaqueIdentifier(value.id, "pendingId").ok &&
    isTeam(value.penalizedTeam) &&
    isTeam(value.benefitingTeam) &&
    (value.reason === "score" || value.reason === "flag-catch") &&
    isSafeNumber(value.createdAtMs) &&
    Array.isArray(value.candidatePlayerKeys) &&
    value.candidatePlayerKeys.every(
      (key) => validateOpaqueIdentifier(key, "candidatePlayerKey").ok,
    ) &&
    isSafeNumber(value.expireMs) &&
    (value.resolvedAtMs === null || isSafeNumber(value.resolvedAtMs)) &&
    (value.resolvedPlayerKey === null ||
      validateOpaqueIdentifier(value.resolvedPlayerKey, "resolvedPlayerKey").ok)
  );
}
function isPersistedRelease(value: unknown): boolean {
  return (
    isRecord(value) &&
    validateOpaqueIdentifier(value.id, "releaseId").ok &&
    isTeam(value.team) &&
    validateOpaqueIdentifier(value.playerKey, "playerKey").ok &&
    (value.playerNumber === null || isScore(value.playerNumber)) &&
    isSafeNumber(value.releasedAtMs) &&
    (value.reason === "served" || value.reason === "expired")
  );
}

function hasCycle(
  id: string,
  graph: ReadonlyMap<string, readonly string[]>,
  active: Set<string>,
  visited: Set<string>,
): boolean {
  if (active.has(id)) return true;
  if (visited.has(id)) return false;
  active.add(id);
  for (const predecessor of graph.get(id) ?? []) {
    if (graph.has(predecessor) && hasCycle(predecessor, graph, active, visited)) return true;
  }
  active.delete(id);
  visited.add(id);
  return false;
}
function isSafeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isScoreEventPoints(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= -1_000 && value <= 1_000
  );
}
function isScore(value: unknown): value is number {
  return isSafeNumber(value) && value <= 1_000;
}
function isTeam(value: unknown): value is "home" | "away" {
  return value === "home" || value === "away";
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
