import type { EffectiveGameFact, IqaGameRulesInterpreter } from "@/lib/event-game-actions";
import { createDefaultControlActionCodecs } from "@/lib/event-game-actions";
import {
  CLOCK_AUTHORITY_VERSION,
  deriveClockAuthority,
  projectClockBaseline,
  validateClockAuthorityAction,
  type ClockAuthorityAction,
  type ClockProjection,
} from "@/lib/clock-authority";
import type { EventGameLifecyclePhase, EventGameRecordRoot } from "@/lib/foundation-record-types";
import type { EventGameRecord } from "@/lib/event-game-record";
import type { FoundationAcceptance } from "@/lib/foundation-acceptance";
import type { ControlAction } from "@/lib/event-game-actions";
import type { TypedGrantAuthority } from "@/lib/grant-management-types";
import {
  SHARED_LIMITS,
  validateClockAdjustmentMs,
  validateGameClockMs,
  validateIntegerInRange,
  validateOpaqueIdentifier,
} from "@/lib/validation-policy";

export const LIVE_EVENT_CONTROL_INTENT_VERSION = "live-event-control-intent-v1" as const;
export const LIVE_EVENT_IQA_INTERPRETER_VERSION = "live-event-iqa-v1" as const;

type ControllerIntentBase = {
  version: typeof LIVE_EVENT_CONTROL_INTENT_VERSION;
  operationId: string;
  factId: string;
  gameTimeMs: number;
  occurrence: {
    clientOriginAtMs: number | null;
    source?: "online" | "offline";
  };
  clockGeneration?: number;
};

export type LiveEventControllerIntent =
  | (ControllerIntentBase & {
      type: "record-goal";
      gameSideId: string;
    })
  | (ControllerIntentBase & {
      type: "clock" | "set-running";
      running: boolean;
    })
  | (ControllerIntentBase & {
      type: "clock-adjust";
      adjustmentMs: number;
    })
  | (ControllerIntentBase & {
      type: "clock-correction";
      clockTimeMs: number;
    })
  | (ControllerIntentBase & {
      type: "clock-takeover";
      clockTimeMs: number;
      running: boolean;
      authorityGeneration: number;
      confirmation: "physical-timekeeper-or-head-referee";
    })
  | (ControllerIntentBase & {
      type: "substantive";
      trigger: "card" | "timeout" | "suspension" | "result";
    })
  | (ControllerIntentBase & {
      type: "reset" | "undo";
    });

export type ControllerCommencement = {
  status: "provisional" | "commenced";
  commencedAtMs: number | null;
  provisionalRunningSinceMs: number | null;
  provisionalElapsedMs: number;
};

export type ControllerSessionAttachment = {
  eventGameId: string;
  grantSessionId: string;
  grantVersion: string;
};

export type ControllerSwitchRequired = {
  status: "switch-required";
  previousEventGameId: string;
  currentEventGameId: string;
  session: ControllerSessionAttachment;
};

export type ControllerRefreshResult =
  | {
      status: "authorized";
      session: ControllerSessionAttachment;
      projection: ControllerProjection | null;
      projectionStatus: "available" | "unavailable";
    }
  | ControllerSwitchRequired
  | { status: "rejected"; message: "Unable to refresh Controller session." };

export type ControllerQrResult =
  | {
      status: "revealed";
      eventGameId: string;
      qrCredential: string;
    }
  | { status: "rejected"; message: "Unable to reveal the active Control Grant QR." };

export type ControllerLeaveResult =
  | { status: "left" }
  | { status: "rejected"; message: "Unable to leave Controller session." };

export type LiveEventGameDerivedState = {
  interpreterVersion: string;
  phase: EventGameLifecyclePhase;
  scoreByGameSide: Readonly<Record<string, number>>;
  goalCount: number;
  clock: ClockProjection;
};

export type ControllerProjection = {
  eventGameId: string;
  phase: EventGameLifecyclePhase;
  scoreByGameSide: Readonly<Record<string, number>>;
  goalCount: number;
  commencement: ControllerCommencement;
  clock: ClockProjection;
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
  grantAuthority: Pick<
    TypedGrantAuthority,
    | "admitGrant"
    | "authorizeGrant"
    | "acceptControlGrantSessionSwitch"
    | "revealGrant"
    | "leaveGrantSession"
  >;
  clock?: () => number;
  /** Test-only seam for proving the post-commit projection response. */
  projectionFailure?: () => boolean;
};

export type ControllerReplayOutcome = {
  operationId: string;
  status:
    | "accepted"
    | "idempotent"
    | "retryable"
    | "causally-blocked"
    | "held-for-correction"
    | "terminally-rejected";
  detail?: string;
};

export type ControllerReplayResult = {
  batchId: string;
  replicaGeneration: string;
  session: ControllerSessionAttachment;
  eventGameId: string;
  status: "synchronized" | "retryable" | "rejected";
  outcomes: readonly ControllerReplayOutcome[];
  projection: ControllerProjection | null;
};

export function createLiveEventGameIqaInterpreter(
  version = LIVE_EVENT_IQA_INTERPRETER_VERSION,
): IqaGameRulesInterpreter {
  return {
    version,
    rebuild({ root, canonicalActions, effectiveFacts }) {
      return deriveLiveEventGameState(
        root,
        canonicalActions.map((action) => ({ action })),
        effectiveFacts,
        version,
      );
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
  if (
    value.type !== "record-goal" &&
    value.type !== "clock" &&
    value.type !== "set-running" &&
    value.type !== "clock-adjust" &&
    value.type !== "adjust-clock" &&
    value.type !== "adjust-game-clock" &&
    value.type !== "clock-correction" &&
    value.type !== "clock-takeover" &&
    value.type !== "correct-clock" &&
    value.type !== "set-game-clock" &&
    value.type !== "substantive" &&
    value.type !== "reset" &&
    value.type !== "undo"
  )
    return invalid("Controller intent type is unsupported.");
  const normalizedType =
    value.type === "adjust-clock" || value.type === "adjust-game-clock"
      ? "clock-adjust"
      : value.type === "correct-clock" || value.type === "set-game-clock"
        ? "clock-correction"
        : value.type;

  const operationId = validateOpaqueIdentifier(value.operationId, "operationId");
  const factId = validateOpaqueIdentifier(value.factId, "factId");
  const gameTimeMs = validateIntegerInRange(
    value.gameTimeMs,
    0,
    SHARED_LIMITS.clock.maxMs,
    "gameTimeMs",
  );
  if (!operationId.ok) return invalid(operationId.error);
  if (!factId.ok) return invalid(factId.error);
  if (!gameTimeMs.ok) return invalid(gameTimeMs.error);

  let gameSideId: string | undefined;
  if (value.type === "record-goal") {
    const parsedSide = validateOpaqueIdentifier(value.gameSideId, "gameSideId");
    if (!parsedSide.ok) return invalid(parsedSide.error);
    gameSideId = parsedSide.value;
  }
  let running: boolean | undefined;
  if (value.type === "clock" || value.type === "set-running" || value.type === "clock-takeover") {
    if (typeof value.running !== "boolean") return invalid("running must be a boolean.");
    running = value.running;
  }
  let adjustmentMs: number | undefined;
  if (normalizedType === "clock-adjust") {
    const adjustment = validateClockAdjustment(value.adjustmentMs ?? value.deltaMs);
    if (!adjustment.ok) return invalid(adjustment.error);
    adjustmentMs = adjustment.value;
  }
  let clockTimeMs: number | undefined;
  if (normalizedType === "clock-correction" || normalizedType === "clock-takeover") {
    const clockTime = validateGameClock(
      value.clockTimeMs ?? value.targetGameTimeMs ?? value.gameTimeMs,
    );
    if (!clockTime.ok) return invalid(clockTime.error);
    clockTimeMs = clockTime.value;
  }
  let authorityGeneration: number | undefined;
  let confirmation: "physical-timekeeper-or-head-referee" | undefined;
  if (normalizedType === "clock-takeover") {
    const generation = validateIntegerInRange(
      value.authorityGeneration,
      0,
      Number.MAX_SAFE_INTEGER,
      "authorityGeneration",
    );
    if (!generation.ok) return invalid(generation.error);
    if (value.confirmation !== "physical-timekeeper-or-head-referee") {
      return invalid("Clock takeover requires physical Timekeeper or Head Referee confirmation.");
    }
    authorityGeneration = generation.value;
    confirmation = value.confirmation;
  }
  let clockGeneration: number | undefined;
  if (
    value.type === "clock" ||
    value.type === "set-running" ||
    value.type === "clock-adjust" ||
    value.type === "clock-correction"
  ) {
    if (value.clockGeneration !== undefined) {
      const generation = validateIntegerInRange(
        value.clockGeneration,
        0,
        Number.MAX_SAFE_INTEGER,
        "clockGeneration",
      );
      if (!generation.ok) return invalid(generation.error);
      clockGeneration = generation.value;
    }
  }
  let trigger: "card" | "timeout" | "suspension" | "result" | undefined;
  if (value.type === "substantive") {
    if (
      value.trigger !== "card" &&
      value.trigger !== "timeout" &&
      value.trigger !== "suspension" &&
      value.trigger !== "result"
    )
      return invalid("substantive trigger is unsupported.");
    trigger = value.trigger;
  }

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
  let source: "online" | "offline" | undefined;
  if (value.occurrence.source !== undefined) {
    if (value.occurrence.source !== "online" && value.occurrence.source !== "offline") {
      return invalid("occurrence.source is unsupported.");
    }
    source = value.occurrence.source;
  }
  return {
    ok: true,
    value: {
      version: LIVE_EVENT_CONTROL_INTENT_VERSION,
      type: normalizedType,
      operationId: operationId.value,
      factId: factId.value,
      gameTimeMs: gameTimeMs.value,
      occurrence: { clientOriginAtMs, ...(source === undefined ? {} : { source }) },
      ...(gameSideId === undefined ? {} : { gameSideId }),
      ...(running === undefined ? {} : { running }),
      ...(adjustmentMs === undefined ? {} : { adjustmentMs }),
      ...(clockTimeMs === undefined ? {} : { clockTimeMs }),
      ...(authorityGeneration === undefined ? {} : { authorityGeneration }),
      ...(confirmation === undefined ? {} : { confirmation }),
      ...(clockGeneration === undefined ? {} : { clockGeneration }),
      ...(trigger === undefined ? {} : { trigger }),
    } as LiveEventControllerIntent,
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
  const replayingSessions = new Set<string>();

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
    if (owner === null) {
      return rejectedOpen();
    }
    const root = await owner.record.readRoot(owner.recordId);
    if (root === null || root.eventGameId !== authorized.eventGameId) {
      return rejectedOpen();
    }
    const commenced = await ensureClockCommencement(owner, root, clock());
    if (commenced.status === "rejected") {
      return rejectedOpen();
    }

    const projection = await readProjection(owner.record, commenced.root);
    return {
      status: "opened",
      eventGameId: commenced.root.eventGameId,
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

  async function refreshController(input: {
    sessionBearer: string;
    eventGameId: string;
  }): Promise<ControllerRefreshResult> {
    const authorized = await options.grantAuthority.authorizeGrant({
      sessionBearer: input.sessionBearer,
      eventGameId: input.eventGameId,
      readOnly: true,
    });
    if (authorized.status === "switch-required") {
      const previousOwner = await options.resolveEventGameRecord(authorized.previousEventGameId);
      const previousRoot =
        previousOwner === null ? null : await previousOwner.record.readRoot(previousOwner.recordId);
      if (previousOwner !== null && previousRoot !== null) {
        const commenced = await ensureClockCommencement(previousOwner, previousRoot, clock());
        if (commenced.status === "rejected") {
          return { status: "rejected", message: "Unable to refresh Controller session." };
        }
        if (commenced.root.lifecycle.commencedAtMs !== null) {
          const pinned = await options.grantAuthority.authorizeGrant({
            sessionBearer: input.sessionBearer,
            eventGameId: input.eventGameId,
            readOnly: true,
          });
          if (
            pinned.status === "authorized" &&
            pinned.grantType === "control" &&
            pinned.eventGameId !== null
          ) {
            const owner = await options.resolveEventGameRecord(pinned.eventGameId);
            const root = owner === null ? null : await owner.record.readRoot(owner.recordId);
            if (owner !== null && root !== null) {
              const projection = await readProjection(owner.record, root);
              return {
                status: "authorized",
                session: {
                  eventGameId: root.eventGameId,
                  grantSessionId: pinned.grantSessionId,
                  grantVersion: pinned.grantVersion,
                },
                projection,
                projectionStatus: projection === null ? "unavailable" : "available",
              };
            }
          }
        }
      }
      return {
        status: "switch-required",
        previousEventGameId: authorized.previousEventGameId,
        currentEventGameId: authorized.currentEventGameId,
        session: {
          eventGameId: authorized.previousEventGameId,
          grantSessionId: authorized.grantSessionId,
          grantVersion: authorized.grantVersion,
        },
      };
    }
    if (
      authorized.status !== "authorized" ||
      authorized.grantType !== "control" ||
      authorized.eventGameId === null
    )
      return { status: "rejected", message: "Unable to refresh Controller session." };
    const owner = await options.resolveEventGameRecord(authorized.eventGameId);
    const root = owner === null ? null : await owner.record.readRoot(owner.recordId);
    if (owner === null || root === null) {
      return { status: "rejected", message: "Unable to refresh Controller session." };
    }
    const commenced = await ensureClockCommencement(owner, root, clock());
    if (commenced.status === "rejected") {
      return { status: "rejected", message: "Unable to refresh Controller session." };
    }
    const projection = await readProjection(owner.record, commenced.root);
    return {
      status: "authorized",
      session: {
        eventGameId: commenced.root.eventGameId,
        grantSessionId: authorized.grantSessionId,
        grantVersion: authorized.grantVersion,
      },
      projection,
      projectionStatus: projection === null ? "unavailable" : "available",
    };
  }

  async function switchController(input: {
    sessionBearer: string;
  }): Promise<ControllerRefreshResult> {
    const switched = await options.grantAuthority.acceptControlGrantSessionSwitch({
      sessionBearer: input.sessionBearer,
    });
    if (switched.status !== "switched") {
      return { status: "rejected", message: "Unable to refresh Controller session." };
    }
    const owner = await options.resolveEventGameRecord(switched.eventGameId);
    const root = owner === null ? null : await owner.record.readRoot(owner.recordId);
    if (owner === null || root === null || root.eventGameId !== switched.eventGameId) {
      return { status: "rejected", message: "Unable to refresh Controller session." };
    }
    const commenced = await ensureClockCommencement(owner, root, clock());
    if (commenced.status === "rejected") {
      return { status: "rejected", message: "Unable to refresh Controller session." };
    }
    const projection = await readProjection(owner.record, commenced.root);
    return {
      status: "authorized",
      session: {
        eventGameId: commenced.root.eventGameId,
        grantSessionId: switched.grantSessionId,
        grantVersion: switched.grantVersion,
      },
      projection,
      projectionStatus: projection === null ? "unavailable" : "available",
    };
  }

  async function stayController(input: {
    sessionBearer: string;
    eventGameId: string;
  }): Promise<ControllerRefreshResult> {
    const authorized = await options.grantAuthority.authorizeGrant({
      sessionBearer: input.sessionBearer,
      eventGameId: input.eventGameId,
      controlSessionDecision: "stay",
      readOnly: false,
    });
    if (
      authorized.status !== "authorized" ||
      authorized.grantType !== "control" ||
      authorized.eventGameId === null
    )
      return { status: "rejected", message: "Unable to refresh Controller session." };
    const owner = await options.resolveEventGameRecord(authorized.eventGameId);
    const root = owner === null ? null : await owner.record.readRoot(owner.recordId);
    if (owner === null || root === null) {
      return { status: "rejected", message: "Unable to refresh Controller session." };
    }
    const commenced = await ensureClockCommencement(owner, root, clock());
    if (commenced.status === "rejected") {
      return { status: "rejected", message: "Unable to refresh Controller session." };
    }
    const projection = await readProjection(owner.record, commenced.root);
    return {
      status: "authorized",
      session: {
        eventGameId: commenced.root.eventGameId,
        grantSessionId: authorized.grantSessionId,
        grantVersion: authorized.grantVersion,
      },
      projection,
      projectionStatus: projection === null ? "unavailable" : "available",
    };
  }

  async function revealControllerQr(input: {
    sessionBearer: string;
    eventGameId: string;
  }): Promise<ControllerQrResult> {
    const authorized = await options.grantAuthority.authorizeGrant({
      sessionBearer: input.sessionBearer,
      eventGameId: input.eventGameId,
      readOnly: true,
    });
    if (
      authorized.status !== "authorized" ||
      authorized.grantType !== "control" ||
      authorized.eventGameId === null
    )
      return { status: "rejected", message: "Unable to reveal the active Control Grant QR." };
    const owner = await options.resolveEventGameRecord(authorized.eventGameId);
    const root = owner === null ? null : await owner.record.readRoot(owner.recordId);
    if (owner === null || root === null || root.lifecycle.phase === "finished") {
      return { status: "rejected", message: "Unable to reveal the active Control Grant QR." };
    }
    const revealed = await options.grantAuthority.revealGrant(authorized.grantId, {
      kind: "grant-session",
      sessionBearer: input.sessionBearer,
    });
    return revealed.status === "revealed"
      ? { status: "revealed", eventGameId: root.eventGameId, qrCredential: revealed.qrCredential }
      : { status: "rejected", message: "Unable to reveal the active Control Grant QR." };
  }

  async function leaveController(input: { sessionBearer: string }): Promise<ControllerLeaveResult> {
    const left = await options.grantAuthority.leaveGrantSession(input.sessionBearer);
    return left.status === "updated"
      ? { status: "left" }
      : { status: "rejected", message: "Unable to leave Controller session." };
  }

  async function submitControllerIntent(input: {
    sessionBearer: string;
    eventGameId: string;
    intent: unknown;
    causalPredecessorIds?: readonly string[];
  }): Promise<LiveEventGameControlResult> {
    const authorized = await options.grantAuthority.authorizeGrant({
      sessionBearer: input.sessionBearer,
      eventGameId: input.eventGameId,
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
    if (owner === null || root === null) {
      return rejectedAction(parsed.value.operationId);
    }
    const commenced = await ensureClockCommencement(owner, root, clock());
    if (commenced.status === "rejected") return retryableAction(parsed.value.operationId);
    const activeRoot = commenced.root;

    if (parsed.value.type === "record-goal") {
      const gameSideId = parsed.value.gameSideId;
      if (!activeRoot.gameSides.some((side) => side.id === gameSideId)) {
        return rejectedAction(parsed.value.operationId);
      }
    }

    const actionsBefore = await owner.record.readActions();
    const existingAction = actionsBefore.find(
      (stored) => stored.action.operationId === parsed.value.operationId,
    );
    if (activeRoot.lifecycle.phase === "finished" && existingAction === undefined) {
      return rejectedAction(parsed.value.operationId);
    }
    const nowMs = clock();
    const previousClockStartMs = latestRunningClockStart(actionsBefore);
    const clockBefore = projectClockBaseline(
      deriveClockAuthority(readClockAuthorityActions(actionsBefore)),
      nowMs,
    );
    const clockData = readClockIntentData(parsed.value, clockBefore, nowMs);
    if (clockData.status === "rejected") {
      return rejectedAction(parsed.value.operationId);
    }
    if (isClockIntent(parsed.value)) {
      if (
        parsed.value.type === "clock-takeover" &&
        parsed.value.authorityGeneration !== clockBefore.baseline.authorityGeneration
      ) {
        return rejectedAction(parsed.value.operationId);
      }
      if (
        parsed.value.type !== "clock-takeover" &&
        parsed.value.occurrence.source === "offline" &&
        (clockBefore.baseline.holderGrantSessionId === null ||
          (clockBefore.baseline.holderGrantSessionId !== authorized.grantSessionId &&
            (parsed.value.clockGeneration === undefined ||
              parsed.value.clockGeneration === clockBefore.baseline.authorityGeneration)))
      ) {
        return rejectedAction(parsed.value.operationId);
      }
    }
    const clockStartMs =
      parsed.value.type === "clock" || parsed.value.type === "set-running"
        ? parsed.value.running
          ? (previousClockStartMs ?? nowMs)
          : previousClockStartMs
        : null;
    const factType = controllerFactType(parsed.value);
    const gameSideId = parsed.value.type === "record-goal" ? parsed.value.gameSideId : null;

    const action = {
      recordId: owner.recordId,
      eventGameId: activeRoot.eventGameId,
      operationId: parsed.value.operationId,
      kind: { id: goalCodec.kind, version: goalCodec.version },
      payload: {
        factId: parsed.value.factId,
        factType,
        gameSideId,
        gameTimeMs: parsed.value.gameTimeMs,
        data:
          parsed.value.type === "record-goal"
            ? { points: 10 }
            : clockData.value !== null
              ? clockData.value
              : parsed.value.type === "substantive"
                ? { trigger: parsed.value.trigger }
                : null,
      },
      causalPredecessorIds: [...(input.causalPredecessorIds ?? [])],
      occurrence: {
        trustedAtMs: nowMs,
        clientOriginAtMs: parsed.value.occurrence.clientOriginAtMs,
        source: parsed.value.occurrence.source ?? "online",
      },
      grant: {
        sessionId: authorized.grantSessionId,
        versionId: authorized.grantVersion,
      },
      lifecycle: structuredClone(existingAction?.action.lifecycle ?? activeRoot.lifecycle),
    };

    const shouldCommence = shouldRecordCommencement(parsed.value, activeRoot, nowMs, clockStartMs);
    const shouldFinish =
      parsed.value.type === "substantive" &&
      parsed.value.trigger === "result" &&
      activeRoot.lifecycle.finishedAtMs === null;
    const lifecycleTransition: EventGameRecordRoot["lifecycle"] | undefined =
      shouldCommence !== null || shouldFinish
        ? {
            ...activeRoot.lifecycle,
            phase:
              parsed.value.type === "substantive" && parsed.value.trigger === "result"
                ? "finished"
                : "in-progress",
            commencedAtMs: activeRoot.lifecycle.commencedAtMs ?? shouldCommence?.atMs ?? nowMs,
            finishedAtMs:
              parsed.value.type === "substantive" && parsed.value.trigger === "result"
                ? nowMs
                : activeRoot.lifecycle.finishedAtMs,
          }
        : undefined;

    let accepted;
    try {
      accepted = await options.acceptance.submitBatch({
        recordId: activeRoot.recordId,
        eventGameId: activeRoot.eventGameId,
        sessionBearer: input.sessionBearer,
        lifecycleTransition,
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

    const currentRoot = await owner.record.readRoot(owner.recordId);
    const projection =
      currentRoot === null ? null : await readProjection(owner.record, currentRoot);
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

  async function replayControllerActions(input: {
    sessionBearer: string;
    eventGameId: string;
    batchId: string;
    replicaGeneration: string;
    expectedGrantSessionId: string;
    expectedGrantVersion: string;
    actions: readonly {
      eventGameId: string;
      intent: unknown;
      causalPredecessorIds?: readonly unknown[];
    }[];
  }): Promise<ControllerReplayResult> {
    const requestedSession: ControllerSessionAttachment = {
      eventGameId: input.eventGameId,
      grantSessionId: input.expectedGrantSessionId,
      grantVersion: input.expectedGrantVersion,
    };
    const replayContext = {
      batchId: input.batchId,
      replicaGeneration: input.replicaGeneration,
      session: requestedSession,
      eventGameId: input.eventGameId,
    };
    if (
      !validateOpaqueIdentifier(input.batchId, "batchId").ok ||
      !validateOpaqueIdentifier(input.replicaGeneration, "replicaGeneration").ok ||
      !validateOpaqueIdentifier(input.expectedGrantSessionId, "grantSessionId").ok ||
      !validateOpaqueIdentifier(input.expectedGrantVersion, "grantVersion").ok
    ) {
      return replayRejected(input.actions, replayContext);
    }
    const authorized = await options.grantAuthority.authorizeGrant({
      sessionBearer: input.sessionBearer,
      eventGameId: input.eventGameId,
      readOnly: true,
    });
    if (
      authorized.status !== "authorized" ||
      authorized.grantType !== "control" ||
      authorized.eventGameId === null
    ) {
      return replayRejected(input.actions, replayContext);
    }
    if (
      authorized.grantSessionId !== input.expectedGrantSessionId ||
      authorized.grantVersion !== input.expectedGrantVersion
    ) {
      return replayRejected(input.actions, replayContext);
    }
    if (
      input.actions.length === 0 ||
      input.actions.length > SHARED_LIMITS.replay.maxControlActions ||
      replayingSessions.has(authorized.grantSessionId)
    ) {
      return replayRetryable(input.actions, replayContext);
    }
    replayingSessions.add(authorized.grantSessionId);
    try {
      const replayOwner = await options.resolveEventGameRecord(authorized.eventGameId);
      if (replayOwner === null) return replayRetryable(input.actions, replayContext);
      const persistedActions = await replayOwner.record.readActions();
      const persistedOperationIds = new Set(
        persistedActions.map((stored) => stored.action.operationId),
      );
      const replayRoot = await replayOwner.record.readRoot(replayOwner.recordId);
      if (replayRoot === null) return replayRetryable(input.actions, replayContext);
      let finishedUnlocked =
        replayRoot.lifecycle.phase === "finished" && replayRoot.lifecycle.lockedAtMs === null;
      const outcomes: ControllerReplayOutcome[] = [];
      const completed = new Set<string>();
      const blocked = new Set<string>();
      const held = new Set<string>();
      const operationCounts = new Map<string, number>();
      for (const candidate of input.actions) {
        const operationId = readOperationId(candidate.intent);
        if (operationId !== null)
          operationCounts.set(operationId, (operationCounts.get(operationId) ?? 0) + 1);
      }
      const batchOperationIds = new Set(
        input.actions.flatMap((candidate) => {
          const operationId = readOperationId(candidate.intent);
          return operationId === null ? [] : [operationId];
        }),
      );
      let remaining = [...input.actions];
      while (remaining.length > 0) {
        let progressed = false;
        const deferred: typeof remaining = [];
        for (const candidate of remaining) {
          const operationId = readOperationId(candidate.intent);
          const predecessors = candidate.causalPredecessorIds ?? [];
          if (operationId === null) continue;
          const parsedIntent = parseLiveEventControllerIntent(candidate.intent);
          if (!parsedIntent.ok || (operationCounts.get(operationId) ?? 0) > 1) {
            outcomes.push({ operationId, status: "terminally-rejected" });
            blocked.add(operationId);
            progressed = true;
            continue;
          }
          if (
            candidate.eventGameId !== authorized.eventGameId ||
            !Array.isArray(predecessors) ||
            predecessors.some(
              (predecessor) => !validateOpaqueIdentifier(predecessor, "causalPredecessorId").ok,
            ) ||
            new Set(predecessors).size !== predecessors.length ||
            predecessors.some((predecessor) => predecessor === operationId)
          ) {
            outcomes.push({ operationId, status: "terminally-rejected" });
            blocked.add(operationId);
            progressed = true;
            continue;
          }
          if (predecessors.some((predecessor) => blocked.has(predecessor))) {
            outcomes.push({ operationId, status: "causally-blocked" });
            blocked.add(operationId);
            progressed = true;
            continue;
          }
          if (
            predecessors.some(
              (predecessor) =>
                !batchOperationIds.has(predecessor) && !persistedOperationIds.has(predecessor),
            )
          ) {
            outcomes.push({ operationId, status: "terminally-rejected" });
            blocked.add(operationId);
            progressed = true;
            continue;
          }
          if (predecessors.some((predecessor) => held.has(predecessor))) {
            outcomes.push({ operationId, status: "held-for-correction" });
            held.add(operationId);
            progressed = true;
            continue;
          }
          if (finishedUnlocked && !persistedOperationIds.has(operationId)) {
            outcomes.push({ operationId, status: "held-for-correction" });
            held.add(operationId);
            progressed = true;
            continue;
          }
          if (
            predecessors.some(
              (predecessor) => batchOperationIds.has(predecessor) && !completed.has(predecessor),
            )
          ) {
            deferred.push(candidate);
            continue;
          }
          const result = await submitControllerIntent({
            sessionBearer: input.sessionBearer,
            eventGameId: authorized.eventGameId,
            intent: candidate.intent,
            causalPredecessorIds: predecessors,
          });
          if (result.status === "accepted") {
            outcomes.push({ operationId, status: "accepted" });
            completed.add(operationId);
            if (
              parsedIntent.value.type === "substantive" &&
              parsedIntent.value.trigger === "result"
            ) {
              finishedUnlocked = true;
            }
          } else if (result.status === "duplicate-accepted") {
            outcomes.push({ operationId, status: "idempotent" });
            completed.add(operationId);
          } else if (result.status === "retryable") {
            outcomes.push({ operationId, status: "retryable", detail: "retryable server outcome" });
          } else if (finishedUnlocked && !persistedOperationIds.has(operationId)) {
            outcomes.push({ operationId, status: "held-for-correction" });
            held.add(operationId);
          } else {
            outcomes.push({
              operationId,
              status: "terminally-rejected",
              detail: "terminal server rejection",
            });
            blocked.add(operationId);
          }
          progressed = true;
        }
        if (!progressed) {
          for (const candidate of deferred) {
            const operationId = readOperationId(candidate.intent);
            if (operationId !== null) {
              outcomes.push({ operationId, status: "causally-blocked" });
              blocked.add(operationId);
            }
          }
          break;
        }
        remaining = deferred;
      }
      const owner = await options.resolveEventGameRecord(authorized.eventGameId);
      const root = owner === null ? null : await owner.record.readRoot(owner.recordId);
      const projection =
        owner === null || root === null ? null : await readProjection(owner.record, root);
      return {
        ...replayContext,
        session: {
          eventGameId: authorized.eventGameId,
          grantSessionId: authorized.grantSessionId,
          grantVersion: authorized.grantVersion,
        },
        status: outcomes.some((outcome) => outcome.status === "retryable")
          ? "retryable"
          : "synchronized",
        outcomes,
        projection,
      };
    } finally {
      replayingSessions.delete(authorized.grantSessionId);
    }
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
      const actions = await record.readActions();
      const runningSinceMs =
        root.lifecycle.commencedAtMs === null ? latestRunningClockStart(actions) : null;
      return {
        eventGameId: root.eventGameId,
        phase: derived.phase,
        scoreByGameSide: structuredClone(derived.scoreByGameSide),
        goalCount: derived.goalCount,
        clock: projectClockBaseline(derived.clock.baseline, clock()),
        commencement: {
          status: root.lifecycle.commencedAtMs === null ? "provisional" : "commenced",
          commencedAtMs: root.lifecycle.commencedAtMs,
          provisionalRunningSinceMs: runningSinceMs,
          provisionalElapsedMs: runningSinceMs === null ? 0 : Math.max(0, clock() - runningSinceMs),
        },
      };
    } catch {
      return null;
    }
  }

  return {
    openController,
    refreshController,
    switchController,
    stayController,
    revealControllerQr,
    leaveController,
    submitControllerIntent,
    replayControllerActions,
  };
}

function deriveLiveEventGameState(
  root: EventGameRecordRoot,
  canonicalActions: readonly { action: import("@/lib/event-game-actions").ControlAction }[],
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
    clock: projectClockBaseline(
      deriveClockAuthority(readClockAuthorityActions(canonicalActions)),
      0,
    ),
  };
}

function controllerFactType(intent: LiveEventControllerIntent): string {
  if (intent.type === "record-goal") return "goal";
  if (
    intent.type === "clock" ||
    intent.type === "set-running" ||
    intent.type === "clock-adjust" ||
    intent.type === "clock-correction" ||
    intent.type === "clock-takeover"
  )
    return "clock";
  if (intent.type === "substantive") return intent.trigger;
  return intent.type;
}

async function ensureClockCommencement(
  owner: { recordId: string; record: EventGameRecord },
  root: EventGameRecordRoot,
  nowMs: number,
): Promise<{ status: "ready"; root: EventGameRecordRoot } | { status: "rejected" }> {
  if (root.lifecycle.commencedAtMs !== null || root.lifecycle.phase !== "scheduled") {
    return { status: "ready", root };
  }
  const actions = await owner.record.readActions();
  const runningSinceMs = latestRunningClockStart(actions);
  if (runningSinceMs === null || nowMs - runningSinceMs < 10_000) {
    return { status: "ready", root };
  }
  const transition = await owner.record.transitionLifecycle({
    ...root.lifecycle,
    phase: "in-progress",
    commencedAtMs: runningSinceMs + 10_000,
  });
  if (transition.status === "rejected") return { status: "rejected" };
  return { status: "ready", root: transition.root };
}

function latestRunningClockStart(
  actions: readonly { action: { interpretation: unknown } }[],
): number | null {
  for (const stored of [...actions].reverse()) {
    const interpretation = stored.action.interpretation;
    if (
      !isRecord(interpretation) ||
      interpretation.type !== "fact" ||
      interpretation.factType !== "clock"
    )
      continue;
    const payload = interpretation.payload;
    if (!isRecord(payload) || !isRecord(payload.data)) return null;
    if (payload.data.running !== true) return null;
    return typeof payload.data.startedAtMs === "number" ? payload.data.startedAtMs : null;
  }
  return null;
}

function shouldRecordCommencement(
  intent: LiveEventControllerIntent,
  root: EventGameRecordRoot,
  nowMs: number,
  clockStartMs: number | null,
): { atMs: number } | null {
  if (root.lifecycle.commencedAtMs !== null) return null;
  if (intent.type === "record-goal" || intent.type === "substantive") {
    return { atMs: nowMs };
  }
  if (
    (intent.type === "clock" || intent.type === "set-running") &&
    clockStartMs !== null &&
    nowMs - clockStartMs >= 10_000
  ) {
    return { atMs: clockStartMs + 10_000 };
  }
  return null;
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
  const clock = readClockProjection(value.clock);
  if (clock === null) return null;
  return {
    interpreterVersion: value.interpreterVersion,
    phase: value.phase,
    scoreByGameSide,
    goalCount: value.goalCount,
    clock,
  };
}

export function validateLiveEventClockActionInTransaction(
  actions: readonly { action: ControlAction }[],
  candidate: ControlAction,
): { status: "accepted" } | { status: "rejected"; reason: "invalid-action"; detail: string } {
  const candidateClock = readClockAuthorityActions([{ action: candidate }])[0];
  if (candidateClock === undefined || candidateClock.command === "penalty-start") {
    return { status: "accepted" };
  }
  const current = deriveClockAuthority(readClockAuthorityActions(actions));
  if (
    candidateClock.command === "takeover" &&
    candidateClock.authorityGeneration !== undefined &&
    candidateClock.authorityGeneration !== current.authorityGeneration
  ) {
    return {
      status: "rejected",
      reason: "invalid-action",
      detail: "Clock takeover generation is stale.",
    };
  }
  if (
    candidateClock.command !== "takeover" &&
    candidateClock.source === "offline" &&
    (current.holderGrantSessionId === null ||
      (candidateClock.sessionId !== current.holderGrantSessionId &&
        (candidateClock.authorityGeneration === undefined ||
          candidateClock.authorityGeneration === current.authorityGeneration)))
  ) {
    return {
      status: "rejected",
      reason: "invalid-action",
      detail: "Only the Offline Clock Holder may submit disconnected clock actions.",
    };
  }
  const validation = validateClockAuthorityAction(
    readClockAuthorityActions(actions),
    candidateClock,
  );
  return validation.ok
    ? { status: "accepted" }
    : { status: "rejected", reason: "invalid-action", detail: validation.error };
}

function readClockAuthorityActions(
  actions: readonly {
    action?: {
      operationId: string;
      occurrence: { trustedAtMs: number; source: "online" | "offline" };
      acceptedAtMs: number;
      grant: { sessionId: string };
      interpretation: unknown;
    };
    operationId?: string;
    occurrence?: { trustedAtMs: number; source: "online" | "offline" };
    acceptedAtMs?: number;
    grant?: { sessionId: string };
    interpretation?: unknown;
  }[],
): ClockAuthorityAction[] {
  const clockActions: ClockAuthorityAction[] = [];
  for (const stored of actions) {
    const storedAction = stored.action ?? stored;
    if (
      storedAction.operationId === undefined ||
      storedAction.occurrence === undefined ||
      storedAction.acceptedAtMs === undefined ||
      storedAction.grant === undefined ||
      storedAction.interpretation === undefined
    )
      continue;
    const interpretation = storedAction.interpretation;
    if (!isRecord(interpretation) || interpretation.type !== "fact") continue;
    if (interpretation.factType !== "clock" && interpretation.factType !== "card") continue;
    if (!isRecord(interpretation.payload)) continue;
    const data = interpretation.payload.data;
    if (!isRecord(data)) continue;
    if (interpretation.factType === "card") {
      clockActions.push({
        operationId: storedAction.operationId,
        trustedAtMs: storedAction.occurrence.trustedAtMs,
        acceptedAtMs: storedAction.acceptedAtMs,
        sessionId: storedAction.grant.sessionId,
        command: "penalty-start",
      });
      continue;
    }
    const command =
      data.command === "adjust" ||
      data.command === "correct" ||
      data.command === "set-running" ||
      data.command === "takeover"
        ? data.command
        : typeof data.running === "boolean"
          ? "set-running"
          : null;
    if (command === null) continue;
    const clockAction: ClockAuthorityAction = {
      operationId: storedAction.operationId,
      trustedAtMs: storedAction.occurrence.trustedAtMs,
      acceptedAtMs: storedAction.acceptedAtMs,
      sessionId: storedAction.grant.sessionId,
      command,
      source: storedAction.occurrence.source,
      ...(typeof data.authorityGeneration === "number"
        ? { authorityGeneration: data.authorityGeneration }
        : {}),
      ...(data.command === "takeover" ? { takeover: true } : {}),
      ...(typeof data.running === "boolean" ? { running: data.running } : {}),
      ...(typeof data.gameTimeMs === "number" ? { gameTimeMs: data.gameTimeMs } : {}),
      ...(typeof data.adjustmentMs === "number" ? { adjustmentMs: data.adjustmentMs } : {}),
    };
    clockActions.push(clockAction);
  }
  return clockActions;
}

function readClockIntentData(
  intent: LiveEventControllerIntent,
  current: ClockProjection,
  nowMs: number,
): { status: "ready"; value: Record<string, unknown> | null } | { status: "rejected" } {
  if (intent.type === "clock-takeover") {
    return {
      status: "ready",
      value: {
        command: "takeover",
        running: intent.running,
        gameTimeMs: intent.clockTimeMs,
        authorityGeneration: intent.authorityGeneration,
        confirmation: intent.confirmation,
        startedAtMs: intent.running ? nowMs : null,
      },
    };
  }
  if (intent.type === "clock" || intent.type === "set-running") {
    return {
      status: "ready",
      value: {
        command: "set-running",
        running: intent.running,
        ...(intent.clockGeneration === undefined
          ? {}
          : { authorityGeneration: intent.clockGeneration }),
        startedAtMs: intent.running
          ? (current.baseline.runningSinceMs ?? nowMs)
          : current.baseline.runningSinceMs,
      },
    };
  }
  if (intent.type === "clock-adjust") {
    return {
      status: "ready",
      value: {
        command: "adjust",
        adjustmentMs: intent.adjustmentMs,
        ...(intent.clockGeneration === undefined
          ? {}
          : { authorityGeneration: intent.clockGeneration }),
      },
    };
  }
  if (intent.type === "clock-correction") {
    return {
      status: "ready",
      value: {
        command: "correct",
        gameTimeMs: intent.clockTimeMs,
        ...(intent.clockGeneration === undefined
          ? {}
          : { authorityGeneration: intent.clockGeneration }),
      },
    };
  }
  return { status: "ready", value: null };
}

function isClockIntent(
  intent: LiveEventControllerIntent,
): intent is Extract<
  LiveEventControllerIntent,
  { type: "clock" | "set-running" | "clock-adjust" | "clock-correction" | "clock-takeover" }
> {
  return (
    intent.type === "clock" ||
    intent.type === "set-running" ||
    intent.type === "clock-adjust" ||
    intent.type === "clock-correction" ||
    intent.type === "clock-takeover"
  );
}

function readClockProjection(value: unknown): ClockProjection | null {
  if (!isRecord(value) || value.version !== CLOCK_AUTHORITY_VERSION) return null;
  if (!isRecord(value.baseline)) return null;
  if (
    !validateGameClockMs(value.gameTimeMs).ok ||
    !validateGameClockMs(value.activePenaltyTimeMs).ok ||
    typeof value.running !== "boolean" ||
    typeof value.projectedAtMs !== "number" ||
    !Number.isSafeInteger(value.projectedAtMs) ||
    (value.synchronization !== "synchronized" &&
      value.synchronization !== "estimated" &&
      value.synchronization !== "stale" &&
      value.synchronization !== "unavailable")
  )
    return null;
  return {
    ...(value as unknown as ClockProjection),
    lastSynchronizedAtMs:
      typeof value.lastSynchronizedAtMs === "number" ? value.lastSynchronizedAtMs : null,
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

type ReplayContext = {
  batchId: string;
  replicaGeneration: string;
  session: ControllerSessionAttachment;
  eventGameId: string;
};

function replayRejected(
  actions: readonly { intent: unknown }[],
  context: ReplayContext,
): ControllerReplayResult {
  return {
    ...context,
    status: "rejected",
    outcomes: actions.flatMap((action) => {
      const operationId = readOperationId(action.intent);
      return operationId === null ? [] : [{ operationId, status: "retryable" as const }];
    }),
    projection: null,
  };
}

function replayRetryable(
  actions: readonly { intent: unknown }[],
  context: ReplayContext,
): ControllerReplayResult {
  return {
    ...context,
    status: "retryable",
    outcomes: actions.flatMap((action) => {
      const operationId = readOperationId(action.intent);
      return operationId === null ? [] : [{ operationId, status: "retryable" as const }];
    }),
    projection: null,
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

function validateClockAdjustment(value: unknown) {
  return validateClockAdjustmentMs(value);
}

function validateGameClock(value: unknown) {
  return validateGameClockMs(value);
}
