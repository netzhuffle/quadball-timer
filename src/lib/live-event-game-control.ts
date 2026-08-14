import type { EffectiveGameFact, IqaGameRulesInterpreter } from "@/lib/event-game-actions";
import { createDefaultControlActionCodecs } from "@/lib/event-game-actions";
import type { EventGameLifecyclePhase, EventGameRecordRoot } from "@/lib/foundation-record-types";
import type { EventGameRecord } from "@/lib/event-game-record";
import type { FoundationAcceptance } from "@/lib/foundation-acceptance";
import type { TypedGrantAuthority } from "@/lib/grant-management-types";
import {
  SHARED_LIMITS,
  validateIntegerInRange,
  validateOpaqueIdentifier,
} from "@/lib/validation-policy";

export const LIVE_EVENT_CONTROL_INTENT_VERSION = "live-event-control-intent-v1" as const;
export const LIVE_EVENT_IQA_INTERPRETER_VERSION = "live-event-iqa-v1" as const;

export type LiveEventControllerIntent = {
  version: typeof LIVE_EVENT_CONTROL_INTENT_VERSION;
  type: "record-goal";
  operationId: string;
  factId: string;
  gameSideId: string;
  gameTimeMs: number;
  occurrence: {
    clientOriginAtMs: number | null;
  };
};

export type LiveEventGameDerivedState = {
  interpreterVersion: string;
  phase: EventGameLifecyclePhase;
  scoreByGameSide: Readonly<Record<string, number>>;
  goalCount: number;
};

export type ControllerProjection = {
  eventGameId: string;
  phase: EventGameLifecyclePhase;
  scoreByGameSide: Readonly<Record<string, number>>;
  goalCount: number;
};

export type ControllerSynchronization = {
  status: "synchronized";
  pendingCount: 0;
};

export type OpenControllerResult =
  | {
      status: "opened";
      eventGameId: string;
      session: {
        sessionBearer: string;
        grantSessionId: string;
        grantVersion: string;
      };
      projection: ControllerProjection | null;
      projectionStatus: "available" | "unavailable";
      synchronization: ControllerSynchronization;
    }
  | {
      status: "rejected";
      message: "Unable to open Controller experience.";
    };

export type LiveEventGameControlResult =
  | {
      status: "accepted" | "duplicate-accepted";
      acknowledgement: {
        status: "acknowledged";
        operationId: string;
      };
      projection: ControllerProjection | null;
      projectionStatus: "available" | "unavailable";
      synchronization: ControllerSynchronization;
      auditReference: {
        kind: "control";
        id: string;
      };
    }
  | {
      status: "retryable";
      message: "Controller action was not committed; retry is safe.";
      operationId: string | null;
    }
  | {
      status: "rejected";
      message: "Unable to perform that Controller action.";
      operationId: string | null;
    };

export type LiveEventGameControlOptions = {
  resolveEventGameRecord: (
    eventGameId: string,
  ) => Promise<{ recordId: string; record: EventGameRecord } | null>;
  acceptance: FoundationAcceptance;
  grantAuthority: Pick<TypedGrantAuthority, "admitGrant" | "authorizeGrant">;
  clock?: () => number;
  /** Test-only seam for proving the post-commit projection response. */
  projectionFailure?: () => boolean;
};

export function createLiveEventGameIqaInterpreter(
  version = LIVE_EVENT_IQA_INTERPRETER_VERSION,
): IqaGameRulesInterpreter {
  return {
    version,
    rebuild({ root, effectiveFacts }) {
      return deriveLiveEventGameState(root, effectiveFacts, version);
    },
  };
}

export function parseLiveEventControllerIntent(
  value: unknown,
): { ok: true; value: LiveEventControllerIntent } | { ok: false; error: string } {
  if (!isRecord(value)) return invalid("Controller intent must be an object.");
  if (value.version !== LIVE_EVENT_CONTROL_INTENT_VERSION) {
    return invalid("Controller intent version is unsupported.");
  }
  if (value.type !== "record-goal") return invalid("Controller intent type is unsupported.");

  const operationId = validateOpaqueIdentifier(value.operationId, "operationId");
  const factId = validateOpaqueIdentifier(value.factId, "factId");
  const gameSideId = validateOpaqueIdentifier(value.gameSideId, "gameSideId");
  const gameTimeMs = validateIntegerInRange(
    value.gameTimeMs,
    0,
    SHARED_LIMITS.clock.maxMs,
    "gameTimeMs",
  );
  if (!operationId.ok) return invalid(operationId.error);
  if (!factId.ok) return invalid(factId.error);
  if (!gameSideId.ok) return invalid(gameSideId.error);
  if (!gameTimeMs.ok) return invalid(gameTimeMs.error);

  if (!isRecord(value.occurrence)) return invalid("occurrence must be an object.");
  let clientOriginAtMs: number | null = null;
  if (
    value.occurrence.clientOriginAtMs !== undefined &&
    value.occurrence.clientOriginAtMs !== null
  ) {
    const clientOrigin = validateIntegerInRange(
      value.occurrence.clientOriginAtMs,
      0,
      Number.MAX_SAFE_INTEGER,
      "occurrence.clientOriginAtMs",
    );
    if (!clientOrigin.ok) return invalid(clientOrigin.error);
    clientOriginAtMs = clientOrigin.value;
  }
  return {
    ok: true,
    value: {
      version: LIVE_EVENT_CONTROL_INTENT_VERSION,
      type: "record-goal",
      operationId: operationId.value,
      factId: factId.value,
      gameSideId: gameSideId.value,
      gameTimeMs: gameTimeMs.value,
      occurrence: { clientOriginAtMs },
    },
  };
}

export function createLiveEventGameControl(options: LiveEventGameControlOptions) {
  const clock = options.clock ?? (() => Date.now());
  const gameFactCodec = createDefaultControlActionCodecs().find(
    (codec) => codec.kind === "game-fact" && codec.version === "1",
  );
  if (gameFactCodec === undefined) {
    throw new Error("The game-fact runtime codec is unavailable.");
  }
  const goalCodec = gameFactCodec;

  async function openController(input: {
    qrCredential: string;
    browserContext: string;
    deviceClass?: string;
    browserClass?: string;
  }): Promise<OpenControllerResult> {
    const admitted = await options.grantAuthority.admitGrant(input);
    if (admitted.status !== "admitted" || admitted.eventGameId === null) {
      return rejectedOpen();
    }

    const authorized = await options.grantAuthority.authorizeGrant({
      sessionBearer: admitted.sessionBearer,
      eventGameId: admitted.eventGameId,
      controlSessionDecision: "stay",
      readOnly: true,
    });
    if (
      authorized.status !== "authorized" ||
      authorized.grantType !== "control" ||
      authorized.eventGameId === null ||
      authorized.grantSessionId !== admitted.grantSessionId
    ) {
      return rejectedOpen();
    }

    const owner = await options.resolveEventGameRecord(authorized.eventGameId);
    if (owner === null) return rejectedOpen();
    const root = await owner.record.readRoot(owner.recordId);
    if (root === null || root.eventGameId !== authorized.eventGameId) return rejectedOpen();

    const projection = await readProjection(owner.record, root);
    return {
      status: "opened",
      eventGameId: root.eventGameId,
      session: {
        sessionBearer: admitted.sessionBearer,
        grantSessionId: authorized.grantSessionId,
        grantVersion: authorized.grantVersion,
      },
      projection,
      projectionStatus: projection === null ? "unavailable" : "available",
      synchronization: synchronized(),
    };
  }

  async function submitControllerIntent(input: {
    sessionBearer: string;
    eventGameId: string;
    intent: unknown;
  }): Promise<LiveEventGameControlResult> {
    const authorized = await options.grantAuthority.authorizeGrant({
      sessionBearer: input.sessionBearer,
      eventGameId: input.eventGameId,
      controlSessionDecision: "stay",
      readOnly: true,
    });
    if (
      authorized.status !== "authorized" ||
      authorized.grantType !== "control" ||
      authorized.eventGameId === null
    ) {
      return rejectedAction(null);
    }

    const operationId = readOperationId(input.intent);
    const parsed = parseLiveEventControllerIntent(input.intent);
    if (!parsed.ok) return rejectedAction(operationId);

    const owner = await options.resolveEventGameRecord(authorized.eventGameId);
    const root = owner === null ? null : await owner.record.readRoot(owner.recordId);
    if (
      owner === null ||
      root === null ||
      !root.gameSides.some((side) => side.id === parsed.value.gameSideId)
    ) {
      return rejectedAction(parsed.value.operationId);
    }

    const action = {
      recordId: owner.recordId,
      eventGameId: root.eventGameId,
      operationId: parsed.value.operationId,
      kind: { id: goalCodec.kind, version: goalCodec.version },
      payload: {
        factId: parsed.value.factId,
        factType: "goal",
        gameSideId: parsed.value.gameSideId,
        gameTimeMs: parsed.value.gameTimeMs,
        data: { points: 10 },
      },
      causalPredecessorIds: [],
      occurrence: {
        trustedAtMs: clock(),
        clientOriginAtMs: parsed.value.occurrence.clientOriginAtMs,
        source: "online",
      },
      grant: {
        sessionId: authorized.grantSessionId,
        versionId: authorized.grantVersion,
      },
      lifecycle: structuredClone(root.lifecycle),
    };

    let accepted;
    try {
      accepted = await options.acceptance.submitBatch({
        recordId: root.recordId,
        eventGameId: root.eventGameId,
        sessionBearer: input.sessionBearer,
        controlSessionDecision: "stay",
        actions: [action],
      });
    } catch {
      return retryableAction(parsed.value.operationId);
    }

    const result = accepted.results[0];
    if (accepted.status === "partial" || result?.status === "retry-later") {
      return retryableAction(parsed.value.operationId);
    }
    if (result === undefined) return rejectedAction(parsed.value.operationId);
    if (result.status !== "accepted" && result.status !== "duplicate-accepted") {
      return rejectedAction(parsed.value.operationId);
    }

    const projection = await readProjection(owner.record, root);
    return {
      status: result.status,
      acknowledgement: {
        status: "acknowledged",
        operationId: parsed.value.operationId,
      },
      projection,
      projectionStatus: projection === null ? "unavailable" : "available",
      synchronization: synchronized(),
      auditReference: {
        kind: "control",
        id: result.auditId,
      },
    };
  }

  async function readProjection(
    record: EventGameRecord,
    root: EventGameRecordRoot,
  ): Promise<ControllerProjection | null> {
    try {
      if (options.projectionFailure?.() === true) return null;
      const rebuild = await record.rebuild();
      if (rebuild.status !== "ready") return null;
      const derived = readDerivedState(rebuild.derivedGameState);
      if (derived === null) return null;
      return {
        eventGameId: root.eventGameId,
        phase: derived.phase,
        scoreByGameSide: structuredClone(derived.scoreByGameSide),
        goalCount: derived.goalCount,
      };
    } catch {
      return null;
    }
  }

  return { openController, submitControllerIntent };
}

function deriveLiveEventGameState(
  root: EventGameRecordRoot,
  effectiveFacts: readonly EffectiveGameFact[],
  version: string,
): LiveEventGameDerivedState {
  const scoreByGameSide: Record<string, number> = Object.fromEntries(
    root.gameSides.map((side) => [side.id, 0]),
  );
  let goalCount = 0;
  for (const fact of effectiveFacts) {
    if (fact.interpretation.factType !== "goal") continue;
    const gameSideId = fact.interpretation.gameSideId;
    if (gameSideId !== null && gameSideId in scoreByGameSide) {
      scoreByGameSide[gameSideId] = (scoreByGameSide[gameSideId] ?? 0) + 10;
    }
    goalCount += 1;
  }
  return {
    interpreterVersion: version,
    phase: root.lifecycle.phase,
    scoreByGameSide,
    goalCount,
  };
}

function readDerivedState(value: unknown): LiveEventGameDerivedState | null {
  if (!isRecord(value) || typeof value.interpreterVersion !== "string") return null;
  if (
    value.phase !== "scheduled" &&
    value.phase !== "in-progress" &&
    value.phase !== "suspended" &&
    value.phase !== "finished"
  )
    return null;
  if (!isRecord(value.scoreByGameSide)) return null;
  const scoreByGameSide: Record<string, number> = {};
  for (const [gameSideId, score] of Object.entries(value.scoreByGameSide)) {
    if (
      !validateOpaqueIdentifier(gameSideId, "scoreByGameSide.gameSideId").ok ||
      typeof score !== "number" ||
      !Number.isSafeInteger(score) ||
      score < 0
    )
      return null;
    scoreByGameSide[gameSideId] = score;
  }
  if (
    typeof value.goalCount !== "number" ||
    !Number.isSafeInteger(value.goalCount) ||
    value.goalCount < 0
  )
    return null;
  return {
    interpreterVersion: value.interpreterVersion,
    phase: value.phase,
    scoreByGameSide,
    goalCount: value.goalCount,
  };
}

function synchronized(): ControllerSynchronization {
  return { status: "synchronized", pendingCount: 0 };
}

function rejectedOpen(): OpenControllerResult {
  return { status: "rejected", message: "Unable to open Controller experience." };
}

function rejectedAction(operationId: string | null): LiveEventGameControlResult {
  return {
    status: "rejected",
    message: "Unable to perform that Controller action.",
    operationId,
  };
}

function retryableAction(operationId: string | null): LiveEventGameControlResult {
  return {
    status: "retryable",
    message: "Controller action was not committed; retry is safe.",
    operationId,
  };
}

function readOperationId(value: unknown): string | null {
  return isRecord(value) && typeof value.operationId === "string" ? value.operationId : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(error: string): { ok: false; error: string } {
  return { ok: false, error };
}
