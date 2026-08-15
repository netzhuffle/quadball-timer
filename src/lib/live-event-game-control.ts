import type {
  ActionJsonValue,
  EffectiveGameFact,
  IqaGameRulesInterpreter,
  OfficialOverrideMetadata,
} from "@/lib/event-game-actions";
import {
  canonicalizeJson,
  createControlActionCodecRegistry,
  createDefaultControlActionCodecs,
  materializeControlAction,
  prepareControlAction,
  rebuildControlActionHistory,
} from "@/lib/event-game-actions";
import { parseJsonValue, validateOverride } from "@/lib/event-game-action-codecs";
import { DEFAULT_IQA_SPORTING_RULES } from "@/lib/iqa-game-rules";
import {
  CLOCK_AUTHORITY_VERSION,
  deriveClockAuthority,
  projectClockBaseline,
  SEEKER_RELEASE_MS,
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
export const CLOSE_PLAY_ADJUDICATION_WINDOW_MS = 1_000;

export type SportingOrderAdjudication = {
  relatedFactId: string;
  relation: "before" | "after";
};

type ControllerIntentBase = {
  version: typeof LIVE_EVENT_CONTROL_INTENT_VERSION;
  operationId: string;
  factId: string;
  gameTimeMs: number;
  sportingOrder?: number;
  sportingOrderAdjudication?: SportingOrderAdjudication;
  sportingOrderOverride?: OfficialOverrideMetadata;
  occurrence: {
    clientOriginAtMs: number | null;
    source?: "online" | "offline";
  };
  clockGeneration?: number;
  override?: OfficialOverrideMetadata;
};

export type LiveEventControllerIntent =
  | (ControllerIntentBase & {
      type: "record-goal";
      gameSideId: string;
    })
  | (ControllerIntentBase & {
      type: "record-flag-catch" | "record-concession" | "record-forfeit";
      gameSideId: string;
    })
  | (ControllerIntentBase & {
      type: "record-double-forfeit";
    })
  | (ControllerIntentBase & {
      type: "correct-fact";
      targetFactId: string;
      effective: boolean;
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
      trigger:
        | "card"
        | "timeout"
        | "suspension"
        | "result"
        | "heat-stoppage"
        | "flag-catch"
        | "concession"
        | "forfeit"
        | "double-forfeit";
      gameSideId?: string;
      heatAction?: "start" | "end" | "skip-required" | "extend-permitted";
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
  timeout: LiveTimeoutState;
  stoppage: LiveStoppageState;
  heat: LiveHeatState;
  result: LiveResultState;
  overtime: boolean;
  overtimeTarget: number | null;
  winnerGameSideId: string | null;
  catch: LiveCatchState | null;
  gameFacts: readonly ControllerGameFact[];
};

export type LiveTimeoutState = {
  status: "inactive" | "started";
  factId: string | null;
};

export type LiveStoppageState = {
  status: "none" | "suspension" | "heat-stoppage";
  factId: string | null;
};

export type LiveHeatState = {
  status: "inactive" | "started" | "ended" | "skipped" | "extended";
  factId: string | null;
  startedAtGameTimeMs: number | null;
  nominalDurationMs: number | null;
};

export type LiveResultState = {
  factId: string;
  data: ActionJsonValue;
} | null;

export type LiveCatchState = {
  factId: string;
  catchingGameSideId: string;
  nonCatchingGameSideId: string;
  gameTimeMs: number;
  targetScore: number | null;
};

export type ControllerGameFact = {
  factId: string;
  factType: string;
  gameSideId: string | null;
  gameTimeMs: number | null;
  sportingOrder: number;
  synchronizationOrder: number;
  effective: boolean;
  data: ActionJsonValue;
};

export type LiveEventGuardrailExplanation = {
  guardrail: string;
  normalBehavior: string;
  overrideAllowed: boolean;
  fixedReason: "head-referee-direction" | null;
};

export type ControllerProjection = {
  eventGameId: string;
  phase: EventGameLifecyclePhase;
  scoreByGameSide: Readonly<Record<string, number>>;
  goalCount: number;
  timeout?: LiveTimeoutState;
  stoppage?: LiveStoppageState;
  heat?: LiveHeatState;
  result?: LiveResultState;
  overtime?: boolean;
  overtimeTarget?: number | null;
  /** Alias retained for Controller clients that call the IQA target a target score. */
  targetScore?: number | null;
  winnerGameSideId?: string | null;
  catch?: LiveCatchState | null;
  gameFacts?: readonly ControllerGameFact[];
  guardrails?: readonly LiveEventGuardrailExplanation[];
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
      sessionExpiresAtMs: number | null;
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
    | "admitGrantCode"
    | "admitControlGrantCode"
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
    sporting: DEFAULT_IQA_SPORTING_RULES,
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
    value.type !== "record-flag-catch" &&
    value.type !== "record-concession" &&
    value.type !== "record-forfeit" &&
    value.type !== "record-double-forfeit" &&
    value.type !== "correct-fact" &&
    value.type !== "correction" &&
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
        : value.type === "correction"
          ? "correct-fact"
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

  let sportingOrder: number | undefined;
  if (value.sportingOrder !== undefined) {
    const parsedSportingOrder = validateIntegerInRange(
      value.sportingOrder,
      0,
      SHARED_LIMITS.clock.maxMs,
      "sportingOrder",
    );
    if (!parsedSportingOrder.ok) return invalid(parsedSportingOrder.error);
    sportingOrder = parsedSportingOrder.value;
  }
  let sportingOrderAdjudication: SportingOrderAdjudication | undefined;
  if (value.sportingOrderAdjudication !== undefined) {
    if (!isRecord(value.sportingOrderAdjudication)) {
      return invalid("sportingOrderAdjudication must be an object.");
    }
    const relatedFactId = validateOpaqueIdentifier(
      value.sportingOrderAdjudication.relatedFactId,
      "sportingOrderAdjudication.relatedFactId",
    );
    if (!relatedFactId.ok) return invalid(relatedFactId.error);
    if (
      value.sportingOrderAdjudication.relation !== "before" &&
      value.sportingOrderAdjudication.relation !== "after"
    ) {
      return invalid("sportingOrderAdjudication.relation is unsupported.");
    }
    sportingOrderAdjudication = {
      relatedFactId: relatedFactId.value,
      relation: value.sportingOrderAdjudication.relation,
    };
  }

  let gameSideId: string | undefined;
  const requiresGameSide =
    value.type === "record-goal" ||
    value.type === "record-flag-catch" ||
    value.type === "record-concession" ||
    value.type === "record-forfeit" ||
    (value.type === "substantive" &&
      (value.trigger === "flag-catch" ||
        value.trigger === "concession" ||
        value.trigger === "forfeit"));
  if (requiresGameSide) {
    const parsedSide = validateOpaqueIdentifier(value.gameSideId, "gameSideId");
    if (!parsedSide.ok) return invalid(parsedSide.error);
    gameSideId = parsedSide.value;
  }
  let targetFactId: string | undefined;
  let effective: boolean | undefined;
  if (normalizedType === "correct-fact") {
    const parsedTarget = validateOpaqueIdentifier(value.targetFactId, "targetFactId");
    if (!parsedTarget.ok) return invalid(parsedTarget.error);
    if (typeof value.effective !== "boolean") return invalid("effective must be a boolean.");
    targetFactId = parsedTarget.value;
    effective = value.effective;
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
  let trigger:
    | "card"
    | "timeout"
    | "suspension"
    | "result"
    | "heat-stoppage"
    | "flag-catch"
    | "concession"
    | "forfeit"
    | "double-forfeit"
    | undefined;
  let heatAction: "start" | "end" | "skip-required" | "extend-permitted" | undefined;
  if (value.type === "substantive") {
    if (
      value.trigger !== "card" &&
      value.trigger !== "timeout" &&
      value.trigger !== "suspension" &&
      value.trigger !== "result" &&
      value.trigger !== "heat-stoppage" &&
      value.trigger !== "flag-catch" &&
      value.trigger !== "concession" &&
      value.trigger !== "forfeit" &&
      value.trigger !== "double-forfeit"
    )
      return invalid("substantive trigger is unsupported.");
    trigger = value.trigger;
    if (trigger === "heat-stoppage") {
      if (
        value.heatAction !== undefined &&
        value.heatAction !== "start" &&
        value.heatAction !== "end" &&
        value.heatAction !== "skip-required" &&
        value.heatAction !== "extend-permitted"
      ) {
        return invalid("heatAction is unsupported.");
      }
      heatAction = value.heatAction;
    }
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
  const overrideResult = validateOverride(value.override);
  if (!overrideResult.ok) return invalid(overrideResult.error);
  const sportingOrderOverrideResult = validateOverride(value.sportingOrderOverride);
  if (!sportingOrderOverrideResult.ok) return invalid(sportingOrderOverrideResult.error);
  if (
    sportingOrderAdjudication !== undefined &&
    normalizedType !== "record-goal" &&
    normalizedType !== "record-flag-catch"
  ) {
    return invalid("Sporting-order adjudication is only valid for a goal or flag catch.");
  }
  if (sportingOrderOverrideResult.value !== undefined && sportingOrderAdjudication === undefined) {
    return invalid("sportingOrderOverride requires sportingOrderAdjudication.");
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
      ...(sportingOrder === undefined ? {} : { sportingOrder }),
      ...(sportingOrderAdjudication === undefined ? {} : { sportingOrderAdjudication }),
      ...(sportingOrderOverrideResult.value === undefined
        ? {}
        : { sportingOrderOverride: sportingOrderOverrideResult.value }),
      ...(targetFactId === undefined ? {} : { targetFactId }),
      ...(effective === undefined ? {} : { effective }),
      ...(gameSideId === undefined ? {} : { gameSideId }),
      ...(running === undefined ? {} : { running }),
      ...(adjustmentMs === undefined ? {} : { adjustmentMs }),
      ...(clockTimeMs === undefined ? {} : { clockTimeMs }),
      ...(authorityGeneration === undefined ? {} : { authorityGeneration }),
      ...(confirmation === undefined ? {} : { confirmation }),
      ...(clockGeneration === undefined ? {} : { clockGeneration }),
      ...(trigger === undefined ? {} : { trigger }),
      ...(heatAction === undefined ? {} : { heatAction }),
      ...(overrideResult.value === undefined ? {} : { override: overrideResult.value }),
    } as LiveEventControllerIntent,
  };
}

export function explainLiveEventGuardrail(intent: {
  type: LiveEventControllerIntent["type"];
  trigger?: Extract<LiveEventControllerIntent, { type: "substantive" }>["trigger"];
  gameTimeMs?: number;
  sportingOrder?: number;
}): LiveEventGuardrailExplanation {
  if (
    intent.gameTimeMs !== undefined &&
    intent.sportingOrder !== undefined &&
    intent.sportingOrder !== intent.gameTimeMs
  ) {
    return {
      guardrail: "sporting-order-adjudication",
      normalBehavior: "Sporting order follows the ordinary trusted game-time timeline.",
      overrideAllowed: true,
      fixedReason: "head-referee-direction",
    };
  }
  if (intent.type === "substantive" && intent.trigger === "timeout") {
    return {
      guardrail: "timeout-requires-paused-play",
      normalBehavior: "A timeout starts while play is paused.",
      overrideAllowed: true,
      fixedReason: "head-referee-direction",
    };
  }
  if (intent.type === "substantive" && intent.trigger === "suspension") {
    return {
      guardrail: "suspension-requires-head-referee-direction",
      normalBehavior: "A suspension is recorded as a normal Controller action.",
      overrideAllowed: false,
      fixedReason: null,
    };
  }
  if (
    intent.type === "record-flag-catch" ||
    (intent.type === "substantive" && intent.trigger === "flag-catch")
  ) {
    return {
      guardrail: "flag-catch-requires-seeker-release-and-stopped-play",
      normalBehavior: "A flag catch is recorded after seeker release and while play is stopped.",
      overrideAllowed: true,
      fixedReason: "head-referee-direction",
    };
  }
  if (intent.type === "substantive" && intent.trigger === "heat-stoppage") {
    return {
      guardrail: "heat-stoppage-rule-deviation",
      normalBehavior: "A valid heat-stoppage action follows the settled heat workflow.",
      overrideAllowed: true,
      fixedReason: "head-referee-direction",
    };
  }
  return {
    guardrail: "normal-event-game-operation",
    normalBehavior: "The Controller action follows the ordinary Event Game workflow.",
    overrideAllowed: false,
    fixedReason: null,
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
  const activeControllerSessions = new Map<
    string,
    { eventGameId: string; expiresAtMs: number | null }
  >();
  let reconcilingActiveControllerSessions = false;
  let reconciliationDirty = false;
  let reconciliationGeneration = 0;
  let reconciliationCompletion: Promise<number> | null = null;
  let closed = false;

  const trackActiveControllerSession = (
    sessionBearer: string,
    eventGameId: string,
    expiresAtMs?: number | null,
  ) => {
    activeControllerSessions.set(sessionBearer, {
      eventGameId,
      expiresAtMs: expiresAtMs ?? activeControllerSessions.get(sessionBearer)?.expiresAtMs ?? null,
    });
  };

  async function reconcileActiveControllerSessions(): Promise<number> {
    if (closed) return 0;
    if (reconcilingActiveControllerSessions) {
      reconciliationDirty = true;
      return reconciliationCompletion ?? activeControllerSessions.size;
    }
    reconcilingActiveControllerSessions = true;
    const generation = reconciliationGeneration;
    const completion = (async () => {
      try {
        do {
          reconciliationDirty = false;
          for (const [sessionBearer, session] of activeControllerSessions) {
            if (closed || generation !== reconciliationGeneration) return 0;
            let authorized: Awaited<ReturnType<typeof options.grantAuthority.authorizeGrant>>;
            try {
              authorized = await options.grantAuthority.authorizeGrant({
                sessionBearer,
                eventGameId: session.eventGameId,
                readOnly: true,
              });
            } catch {
              continue;
            }
            if (closed || generation !== reconciliationGeneration) return 0;
            if (authorized.status === "authorized" && authorized.grantType === "control") {
              if (authorized.eventGameId !== null) {
                trackActiveControllerSession(
                  sessionBearer,
                  authorized.eventGameId,
                  authorized.sessionExpiresAtMs,
                );
              }
            } else if (authorized.status === "switch-required") {
              trackActiveControllerSession(
                sessionBearer,
                authorized.currentEventGameId,
                session.expiresAtMs,
              );
            } else {
              activeControllerSessions.delete(sessionBearer);
            }
          }
        } while (reconciliationDirty && !closed && generation === reconciliationGeneration);
        if (closed || generation !== reconciliationGeneration) return 0;
        return activeControllerSessions.size;
      } finally {
        reconcilingActiveControllerSessions = false;
        reconciliationDirty = false;
      }
    })();
    reconciliationCompletion = completion;
    try {
      return await completion;
    } finally {
      if (reconciliationCompletion === completion) reconciliationCompletion = null;
    }
  }

  async function openController(input: {
    qrCredential?: string;
    grantCode?: string;
    browserContext: string;
    deviceClass?: string;
    browserClass?: string;
  }): Promise<OpenControllerResult> {
    const admitted =
      input.grantCode === undefined
        ? await options.grantAuthority.admitGrant(
            {
              qrCredential: input.qrCredential ?? "",
              browserContext: input.browserContext,
              deviceClass: input.deviceClass,
              browserClass: input.browserClass,
            },
            "control",
          )
        : await options.grantAuthority.admitControlGrantCode({
            grantCode: input.grantCode,
            browserContext: input.browserContext,
            deviceClass: input.deviceClass,
            browserClass: input.browserClass,
          });
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
    trackActiveControllerSession(
      admitted.sessionBearer,
      commenced.root.eventGameId,
      authorized.sessionExpiresAtMs,
    );
    return {
      status: "opened",
      eventGameId: commenced.root.eventGameId,
      session: {
        sessionBearer: admitted.sessionBearer,
        grantSessionId: authorized.grantSessionId,
        grantVersion: authorized.grantVersion,
      },
      sessionExpiresAtMs: admitted.sessionExpiresAtMs ?? null,
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
              trackActiveControllerSession(
                input.sessionBearer,
                root.eventGameId,
                pinned.sessionExpiresAtMs,
              );
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
    trackActiveControllerSession(
      input.sessionBearer,
      commenced.root.eventGameId,
      authorized.sessionExpiresAtMs,
    );
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
    trackActiveControllerSession(
      input.sessionBearer,
      commenced.root.eventGameId,
      switched.sessionExpiresAtMs,
    );
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
    trackActiveControllerSession(
      input.sessionBearer,
      commenced.root.eventGameId,
      authorized.sessionExpiresAtMs,
    );
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
    if (left.status === "updated") activeControllerSessions.delete(input.sessionBearer);
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

    if (
      parsed.value.type === "record-goal" ||
      parsed.value.type === "record-flag-catch" ||
      parsed.value.type === "record-concession" ||
      parsed.value.type === "record-forfeit" ||
      (parsed.value.type === "substantive" &&
        (parsed.value.trigger === "flag-catch" ||
          parsed.value.trigger === "concession" ||
          parsed.value.trigger === "forfeit"))
    ) {
      const gameSideId = parsed.value.gameSideId;
      if (!activeRoot.gameSides.some((side) => side.id === gameSideId)) {
        return rejectedAction(parsed.value.operationId);
      }
    }

    const actionsBefore = await owner.record.readActions();
    const existingAction = actionsBefore.find(
      (stored) => stored.action.operationId === parsed.value.operationId,
    );
    const effectiveStateBefore = rebuildLiveDerivedState(activeRoot, actionsBefore);
    if (effectiveStateBefore === null) {
      return retryableAction(parsed.value.operationId);
    }
    if (
      effectiveStateBefore.phase === "finished" &&
      existingAction === undefined &&
      parsed.value.type !== "correct-fact" &&
      !allowsLatePreCatchGoal(parsed.value, effectiveStateBefore)
    ) {
      return rejectedAction(parsed.value.operationId);
    }
    if (
      effectiveStateBefore.overtime &&
      parsed.value.type === "substantive" &&
      parsed.value.trigger === "result" &&
      effectiveStateBefore.winnerGameSideId === null
    ) {
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
    const gameSideId = controllerGameSideId(parsed.value);
    const isCorrection = parsed.value.type === "correct-fact";
    let override: OfficialOverrideMetadata | undefined;
    try {
      override = buildLiveOfficialOverride(parsed.value, authorized.grantSessionId);
    } catch {
      return rejectedAction(parsed.value.operationId);
    }

    const action = {
      recordId: owner.recordId,
      eventGameId: activeRoot.eventGameId,
      operationId: parsed.value.operationId,
      kind:
        parsed.value.type === "correct-fact"
          ? { id: "correction", version: "1" }
          : { id: goalCodec.kind, version: goalCodec.version },
      payload:
        parsed.value.type === "correct-fact"
          ? {
              correctionId: parsed.value.factId,
              targetFactId: parsed.value.targetFactId,
              effective: parsed.value.effective,
            }
          : {
              factId: parsed.value.factId,
              factType,
              gameSideId,
              gameTimeMs: parsed.value.gameTimeMs,
              data:
                parsed.value.type === "record-goal"
                  ? {
                      points: 10,
                      sportingOrder: parsed.value.sportingOrder ?? parsed.value.gameTimeMs,
                      ...(parsed.value.sportingOrderAdjudication === undefined
                        ? {}
                        : { sportingOrderAdjudication: parsed.value.sportingOrderAdjudication }),
                      ...(parsed.value.sportingOrderOverride === undefined
                        ? {}
                        : { sportingOrderOverride: parsed.value.sportingOrderOverride }),
                    }
                  : isScoringIntent(parsed.value)
                    ? {
                        points:
                          parsed.value.type === "record-flag-catch" ||
                          (parsed.value.type === "substantive" &&
                            parsed.value.trigger === "flag-catch")
                            ? 30
                            : 0,
                        sportingOrder: parsed.value.sportingOrder ?? parsed.value.gameTimeMs,
                        ...(parsed.value.sportingOrderAdjudication === undefined
                          ? {}
                          : { sportingOrderAdjudication: parsed.value.sportingOrderAdjudication }),
                        ...(parsed.value.sportingOrderOverride === undefined
                          ? {}
                          : { sportingOrderOverride: parsed.value.sportingOrderOverride }),
                        ...(parsed.value.type === "substantive"
                          ? { trigger: parsed.value.trigger }
                          : {}),
                      }
                    : isResultIntent(parsed.value)
                      ? {
                          resultKind: controllerFactType(parsed.value),
                          sportingOrder: parsed.value.sportingOrder ?? parsed.value.gameTimeMs,
                          ...(parsed.value.sportingOrderAdjudication === undefined
                            ? {}
                            : {
                                sportingOrderAdjudication: parsed.value.sportingOrderAdjudication,
                              }),
                        }
                      : clockData.value !== null
                        ? {
                            ...clockData.value,
                            sportingOrder: parsed.value.sportingOrder ?? parsed.value.gameTimeMs,
                            ...(parsed.value.sportingOrderAdjudication === undefined
                              ? {}
                              : {
                                  sportingOrderAdjudication: parsed.value.sportingOrderAdjudication,
                                }),
                          }
                        : parsed.value.type === "substantive"
                          ? {
                              trigger: parsed.value.trigger,
                              sportingOrder: parsed.value.sportingOrder ?? parsed.value.gameTimeMs,
                              ...(parsed.value.sportingOrderAdjudication === undefined
                                ? {}
                                : {
                                    sportingOrderAdjudication:
                                      parsed.value.sportingOrderAdjudication,
                                  }),
                              ...(parsed.value.heatAction === undefined
                                ? {}
                                : { heatAction: parsed.value.heatAction }),
                            }
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
      ...(override === undefined ? {} : { override }),
    };

    const derivedLifecycle =
      existingAction === undefined
        ? deriveControllerLifecycleAfterAction(
            activeRoot,
            actionsBefore,
            action,
            parsed.value,
            nowMs,
          )
        : undefined;
    const shouldCommence =
      existingAction !== undefined || isCorrection
        ? null
        : shouldRecordCommencement(parsed.value, activeRoot, nowMs, clockStartMs);
    const shouldFinish =
      existingAction === undefined &&
      activeRoot.lifecycle.finishedAtMs === null &&
      intentFinishesGame(parsed.value, effectiveStateBefore);
    const lifecycleTransition: EventGameRecordRoot["lifecycle"] | undefined =
      derivedLifecycle ??
      (shouldCommence !== null || shouldFinish
        ? {
            ...activeRoot.lifecycle,
            phase: shouldFinish ? "finished" : "in-progress",
            commencedAtMs: activeRoot.lifecycle.commencedAtMs ?? shouldCommence?.atMs ?? nowMs,
            finishedAtMs: shouldFinish ? nowMs : activeRoot.lifecycle.finishedAtMs,
          }
        : undefined);

    let accepted;
    try {
      accepted = await options.acceptance.submitBatch({
        recordId: activeRoot.recordId,
        eventGameId: activeRoot.eventGameId,
        sessionBearer: input.sessionBearer,
        lifecycleTransition,
        actions: [action],
        reconcileDerivedLifecycle: derivedLifecycle !== undefined,
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
      let replayState = rebuildLiveDerivedState(replayRoot, persistedActions);
      if (replayState === null) return replayRetryable(input.actions, replayContext);
      let finishedUnlocked =
        replayState.phase === "finished" && replayRoot.lifecycle.lockedAtMs === null;
      const refreshFinishedState = async (): Promise<boolean> => {
        const currentRoot = await replayOwner.record.readRoot(replayOwner.recordId);
        if (currentRoot === null) return true;
        const currentActions = await replayOwner.record.readActions();
        const currentState = rebuildLiveDerivedState(currentRoot, currentActions);
        if (currentState !== null) replayState = currentState;
        return currentState?.phase === "finished" && currentRoot.lifecycle.lockedAtMs === null;
      };
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
          if (
            predecessors.some(
              (predecessor) => batchOperationIds.has(predecessor) && !completed.has(predecessor),
            )
          ) {
            deferred.push(candidate);
            continue;
          }
          if (
            finishedUnlocked &&
            parsedIntent.value.type !== "correct-fact" &&
            !allowsLatePreCatchGoal(parsedIntent.value, replayState) &&
            !persistedOperationIds.has(operationId)
          ) {
            outcomes.push({ operationId, status: "held-for-correction" });
            held.add(operationId);
            progressed = true;
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
            finishedUnlocked = await refreshFinishedState();
          } else if (result.status === "duplicate-accepted") {
            outcomes.push({ operationId, status: "idempotent" });
            completed.add(operationId);
            finishedUnlocked = await refreshFinishedState();
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
      const controllerProjection: ControllerProjection = {
        eventGameId: root.eventGameId,
        phase: derived.phase,
        scoreByGameSide: structuredClone(derived.scoreByGameSide),
        goalCount: derived.goalCount,
        timeout: structuredClone(derived.timeout),
        stoppage: structuredClone(derived.stoppage),
        heat: structuredClone(derived.heat),
        result: structuredClone(derived.result),
        overtime: derived.overtime,
        overtimeTarget: derived.overtimeTarget,
        targetScore: derived.overtimeTarget,
        winnerGameSideId: derived.winnerGameSideId,
        catch: structuredClone(derived.catch),
        gameFacts: derived.gameFacts.map((fact) => ({
          ...fact,
          data: structuredClone(fact.data),
        })),
        guardrails: [
          explainLiveEventGuardrail({ type: "substantive", trigger: "timeout" }),
          explainLiveEventGuardrail({ type: "substantive", trigger: "suspension" }),
          explainLiveEventGuardrail({ type: "substantive", trigger: "heat-stoppage" }),
          explainLiveEventGuardrail({ type: "record-goal", gameTimeMs: 1, sportingOrder: 0 }),
        ],
        clock: projectClockBaseline(derived.clock.baseline, clock()),
        commencement: {
          status: root.lifecycle.commencedAtMs === null ? "provisional" : "commenced",
          commencedAtMs: root.lifecycle.commencedAtMs,
          provisionalRunningSinceMs: runningSinceMs,
          provisionalElapsedMs: runningSinceMs === null ? 0 : Math.max(0, clock() - runningSinceMs),
        },
      };
      return controllerProjection;
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
    activeControllerSessions: () => {
      if (closed) return 0;
      const nowMs = clock();
      for (const [sessionBearer, session] of activeControllerSessions) {
        if (session.expiresAtMs !== null && nowMs >= session.expiresAtMs) {
          activeControllerSessions.delete(sessionBearer);
        }
      }
      return activeControllerSessions.size;
    },
    reconcileActiveControllerSessions,
    close() {
      closed = true;
      reconciliationGeneration += 1;
      reconciliationDirty = false;
      activeControllerSessions.clear();
    },
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
  const effectiveFactIds = new Set(effectiveFacts.map((fact) => fact.factId));
  const synchronizationOrderByOperationId = new Map(
    [...canonicalActions]
      .sort(
        ({ action: left }, { action: right }) =>
          left.acceptedAtMs - right.acceptedAtMs ||
          left.operationId.localeCompare(right.operationId),
      )
      .map(({ action }, index) => [action.operationId, index + 1]),
  );
  const gameFacts = orderControllerGameFacts(
    canonicalActions
      .flatMap(({ action }) => {
        if (action.interpretation.type !== "fact") return [];
        const payload = action.interpretation.payload;
        const gameTimeMs =
          isRecord(payload) && typeof payload.gameTimeMs === "number" ? payload.gameTimeMs : null;
        const data = isRecord(payload) && "data" in payload ? payload.data : null;
        const sportingOrder =
          isRecord(data) && typeof data.sportingOrder === "number"
            ? data.sportingOrder
            : (gameTimeMs ?? 0);
        return [
          {
            factId: action.interpretation.factId,
            factType: action.interpretation.factType,
            gameSideId: action.interpretation.gameSideId,
            gameTimeMs,
            sportingOrder,
            synchronizationOrder: synchronizationOrderByOperationId.get(action.operationId) ?? 0,
            effective: effectiveFactIds.has(action.interpretation.factId),
            data: isActionJsonValue(data) ? structuredClone(data) : null,
          } satisfies ControllerGameFact,
        ];
      })
      .sort(
        (left, right) =>
          left.sportingOrder - right.sportingOrder ||
          left.synchronizationOrder - right.synchronizationOrder ||
          left.factId.localeCompare(right.factId),
      ),
  );
  const orderedEffectiveFacts = gameFacts.filter((fact) => fact.effective);
  const sideIds = root.gameSides.map((side) => side.id);
  let goalCount = 0;
  let overtime = false;
  let overtimeTarget: number | null = null;
  let winnerGameSideId: string | null = null;
  let winnerFactId: string | null = null;
  let catchState: LiveCatchState | null = null;
  let resultFact: ControllerGameFact | null = null;

  for (const fact of orderedEffectiveFacts) {
    const data = isRecord(fact.data) ? fact.data : null;
    const side = fact.gameSideId;
    if (fact.factType === "goal") {
      if (side !== null && side in scoreByGameSide) {
        scoreByGameSide[side] = (scoreByGameSide[side] ?? 0) + 10;
      }
      goalCount += 1;
      if (overtimeTarget !== null && winnerGameSideId === null) {
        const reached = side !== null && (scoreByGameSide[side] ?? 0) >= overtimeTarget;
        if (reached) {
          winnerGameSideId = side;
          winnerFactId = fact.factId;
        }
      }
      continue;
    }
    if (fact.factType === "flag-catch" && catchState === null && side !== null) {
      const nonCatching = sideIds.find((candidate) => candidate !== side);
      if (nonCatching === undefined) continue;
      scoreByGameSide[side] = (scoreByGameSide[side] ?? 0) + 30;
      const nonCatchingScore = scoreByGameSide[nonCatching] ?? 0;
      const catchingScore = scoreByGameSide[side] ?? 0;
      const targetScore = nonCatchingScore + 30;
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
        const requiredLead = concedingScore + 10;
        const points = Math.max(10, Math.ceil((requiredLead - opponentScore) / 10) * 10);
        scoreByGameSide[opponent] = opponentScore + points;
      }
      winnerGameSideId = opponent;
      resultFact = fact;
      winnerFactId = fact.factId;
      continue;
    }
    if (fact.factType === "forfeit" && side !== null) {
      winnerGameSideId = sideIds.find((candidate) => candidate !== side) ?? null;
      resultFact = fact;
      winnerFactId = fact.factId;
      continue;
    }
    if (fact.factType === "double-forfeit") {
      winnerGameSideId = null;
      resultFact = fact;
      continue;
    }
    if (fact.factType === "result") {
      const declaredWinner = data?.winnerGameSideId;
      winnerGameSideId =
        typeof declaredWinner === "string" && declaredWinner in scoreByGameSide
          ? declaredWinner
          : winnerGameSideId;
      resultFact = fact;
      if (winnerGameSideId !== null) winnerFactId = fact.factId;
    }
  }
  const latestEffectiveFact = (factType: string): ControllerGameFact | null =>
    gameFacts.filter((fact) => fact.effective && fact.factType === factType).at(-1) ?? null;
  const timeoutFact = latestEffectiveFact("timeout");
  const suspensionFact = latestEffectiveFact("suspension");
  const heatFact = latestEffectiveFact("heat-stoppage");
  const latestResultFact = latestEffectiveFact("result");
  const heatAction =
    isRecord(heatFact?.data) &&
    (heatFact.data.heatAction === "start" ||
      heatFact.data.heatAction === "end" ||
      heatFact.data.heatAction === "skip-required" ||
      heatFact.data.heatAction === "extend-permitted")
      ? heatFact.data.heatAction
      : heatFact === null
        ? null
        : "start";
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
  const effectiveHeatStarts = gameFacts.filter(
    (fact) =>
      fact.effective &&
      fact.factType === "heat-stoppage" &&
      (!isRecord(fact.data) ||
        (fact.data.heatAction !== "end" &&
          fact.data.heatAction !== "skip-required" &&
          fact.data.heatAction !== "extend-permitted")),
  );
  const heatNominalDurationMs =
    heatStatus === "started" || heatStatus === "extended"
      ? effectiveHeatStarts.length <= 1
        ? 4 * 60 * 1000
        : 2 * 60 * 1000
      : null;
  const heatStartedAtGameTimeMs =
    heatNominalDurationMs === null || heatFact?.gameTimeMs === null
      ? null
      : (heatFact?.gameTimeMs ?? null);
  const timeout: LiveTimeoutState = {
    status: timeoutFact === null ? "inactive" : "started",
    factId: timeoutFact?.factId ?? null,
  };
  const heat: LiveHeatState = {
    status: heatStatus,
    factId: heatFact?.factId ?? null,
    startedAtGameTimeMs: heatStartedAtGameTimeMs,
    nominalDurationMs: heatNominalDurationMs,
  };
  const stoppage: LiveStoppageState =
    suspensionFact !== null
      ? { status: "suspension", factId: suspensionFact.factId }
      : heat.status === "started" || heat.status === "extended"
        ? { status: "heat-stoppage", factId: heat.factId }
        : { status: "none", factId: null };
  const result: LiveResultState =
    resultFact === null && latestResultFact === null && winnerFactId === null
      ? null
      : {
          factId: (resultFact ?? latestResultFact)?.factId ?? winnerFactId!,
          data: structuredClone(
            (resultFact ?? latestResultFact)?.data ?? {
              resultKind: "derived-score-completion",
              winnerGameSideId,
            },
          ),
        };
  const effectiveResult = result !== null || winnerGameSideId !== null;
  const effectiveSuspension = gameFacts.some(
    (fact) => fact.effective && fact.factType === "suspension",
  );
  const phase = effectiveResult
    ? "finished"
    : effectiveSuspension && root.lifecycle.phase !== "finished"
      ? "suspended"
      : root.lifecycle.phase === "scheduled"
        ? "scheduled"
        : "in-progress";
  return {
    interpreterVersion: version,
    phase,
    scoreByGameSide,
    goalCount,
    timeout,
    stoppage,
    heat,
    result,
    overtime,
    overtimeTarget,
    winnerGameSideId,
    catch: catchState,
    gameFacts,
    clock: projectClockBaseline(
      deriveClockAuthority(
        readClockAuthorityActions(effectiveFacts.map((fact) => ({ action: fact.action }))),
      ),
      0,
    ),
  };
}

function controllerFactType(intent: LiveEventControllerIntent): string {
  if (intent.type === "record-goal") return "goal";
  if (intent.type === "record-flag-catch") return "flag-catch";
  if (intent.type === "record-concession") return "concession";
  if (intent.type === "record-forfeit") return "forfeit";
  if (intent.type === "record-double-forfeit") return "double-forfeit";
  if (
    intent.type === "clock" ||
    intent.type === "set-running" ||
    intent.type === "clock-adjust" ||
    intent.type === "clock-correction" ||
    intent.type === "clock-takeover"
  )
    return "clock";
  if (intent.type === "substantive") return intent.trigger;
  if (intent.type === "correct-fact") return "correction";
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
  if (
    intent.type === "record-goal" ||
    intent.type === "record-flag-catch" ||
    intent.type === "record-concession" ||
    intent.type === "record-forfeit" ||
    intent.type === "record-double-forfeit" ||
    intent.type === "substantive"
  ) {
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

function controllerGameSideId(intent: LiveEventControllerIntent): string | null {
  return "gameSideId" in intent && typeof intent.gameSideId === "string" ? intent.gameSideId : null;
}

function isScoringIntent(intent: LiveEventControllerIntent): boolean {
  return (
    intent.type === "record-flag-catch" ||
    intent.type === "record-concession" ||
    (intent.type === "substantive" &&
      (intent.trigger === "flag-catch" || intent.trigger === "concession"))
  );
}

function isResultIntent(intent: LiveEventControllerIntent): boolean {
  return (
    intent.type === "record-forfeit" ||
    intent.type === "record-double-forfeit" ||
    (intent.type === "substantive" &&
      (intent.trigger === "forfeit" || intent.trigger === "double-forfeit"))
  );
}

function intentFinishesGame(
  intent: LiveEventControllerIntent,
  current: LiveEventGameDerivedState,
): boolean {
  if (
    intent.type === "record-concession" ||
    intent.type === "record-forfeit" ||
    intent.type === "record-double-forfeit" ||
    (intent.type === "substantive" &&
      (intent.trigger === "concession" ||
        intent.trigger === "forfeit" ||
        intent.trigger === "double-forfeit"))
  )
    return true;
  if (intent.type === "substantive" && intent.trigger === "result") {
    return !current.overtime || current.winnerGameSideId !== null;
  }
  if (
    intent.type === "record-flag-catch" ||
    (intent.type === "substantive" && intent.trigger === "flag-catch")
  ) {
    const catching = intent.gameSideId;
    if (catching === undefined) return false;
    const other = currentSideIds(current).find((side) => side !== catching);
    return (
      other !== undefined &&
      (current.scoreByGameSide[catching] ?? 0) + 30 > (current.scoreByGameSide[other] ?? 0)
    );
  }
  if (intent.type === "record-goal" && current.overtimeTarget !== null) {
    return (current.scoreByGameSide[intent.gameSideId] ?? 0) + 10 >= current.overtimeTarget;
  }
  return false;
}

function deriveControllerLifecycleAfterAction(
  root: EventGameRecordRoot,
  actionsBefore: readonly {
    action: ControlAction;
    canonicalContent: string;
    contentFingerprint: string;
  }[],
  actionInput: unknown,
  intent: LiveEventControllerIntent,
  acceptedAtMs: number,
): EventGameRecordRoot["lifecycle"] | undefined {
  const scoringFactNeedsRebuild =
    root.lifecycle.phase === "finished" ||
    intent.type !== "record-goal" ||
    actionsBefore.some(({ action }) => {
      if (action.interpretation.type !== "fact") return false;
      return action.interpretation.factType === "flag-catch";
    });
  const relevantFact =
    intent.type === "correct-fact"
      ? rootDerivedScoringFactForCorrection(root, actionsBefore, intent.targetFactId)
      : scoringFactNeedsRebuild &&
          (intent.type === "record-goal" ||
            intent.type === "record-flag-catch" ||
            intent.type === "record-concession" ||
            intent.type === "record-forfeit" ||
            intent.type === "record-double-forfeit" ||
            (intent.type === "substantive" && intent.trigger === "result"))
        ? true
        : false;
  if (!relevantFact) return undefined;
  const prepared = prepareControlAction(
    actionInput,
    root,
    createControlActionCodecRegistry(createDefaultControlActionCodecs()),
    acceptedAtMs,
  );
  if (!prepared.ok) return undefined;
  const candidate = materializeControlAction(prepared.value, acceptedAtMs);
  const rebuilt = rebuildLiveDerivedState(root, [
    ...actionsBefore,
    {
      action: candidate,
      canonicalContent: prepared.value.canonicalContent,
      contentFingerprint: prepared.value.contentFingerprint,
    },
  ]);
  if (rebuilt === null || (rebuilt.phase !== "in-progress" && rebuilt.phase !== "finished")) {
    return undefined;
  }
  const desiredPhase = rebuilt.phase;
  const desired: EventGameRecordRoot["lifecycle"] = {
    ...root.lifecycle,
    phase: desiredPhase,
    commencedAtMs: root.lifecycle.commencedAtMs ?? acceptedAtMs,
    finishedAtMs:
      desiredPhase === "finished" ? (root.lifecycle.finishedAtMs ?? acceptedAtMs) : null,
  };
  return JSON.stringify(desired) === JSON.stringify(root.lifecycle) ? undefined : desired;
}

function rootDerivedScoringFactForCorrection(
  root: EventGameRecordRoot,
  actionsBefore: readonly {
    action: ControlAction;
    canonicalContent: string;
    contentFingerprint: string;
  }[],
  targetFactId: string,
): boolean {
  const current = rebuildLiveDerivedState(root, actionsBefore);
  if (current === null) return false;
  const fact = current.gameFacts.find((candidate) => candidate.factId === targetFactId);
  return (
    fact !== undefined &&
    (fact.factType === "goal" ||
      fact.factType === "flag-catch" ||
      fact.factType === "concession" ||
      fact.factType === "forfeit" ||
      fact.factType === "double-forfeit" ||
      fact.factType === "result")
  );
}

function allowsLatePreCatchGoal(
  intent: LiveEventControllerIntent,
  current: LiveEventGameDerivedState,
): boolean {
  if (intent.type !== "record-goal" || current.catch === null) return false;
  const catchFact = current.gameFacts.find(
    (fact) => fact.factId === current.catch?.factId && fact.effective,
  );
  if (catchFact === undefined) return false;
  if (
    intent.sportingOrderAdjudication?.relatedFactId === catchFact.factId &&
    intent.sportingOrderAdjudication.relation === "before" &&
    catchFact.gameTimeMs !== null &&
    Math.abs(intent.gameTimeMs - catchFact.gameTimeMs) <= CLOSE_PLAY_ADJUDICATION_WINDOW_MS
  ) {
    return true;
  }
  const candidateOrder = intent.sportingOrder ?? intent.gameTimeMs;
  return candidateOrder < catchFact.sportingOrder;
}

function currentSideIds(state: LiveEventGameDerivedState): string[] {
  return Object.keys(state.scoreByGameSide);
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
      score < 0 ||
      score > SHARED_LIMITS.score.max
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
  const timeout = readLiveTimeoutState(value.timeout);
  const stoppage = readLiveStoppageState(value.stoppage);
  const heat = readLiveHeatState(value.heat);
  const result = readLiveResultState(value.result);
  const overtime = value.overtime === undefined ? false : value.overtime;
  if (typeof overtime !== "boolean") return null;
  const overtimeTarget = readNullableScore(value.overtimeTarget ?? value.targetScore);
  if (overtimeTarget === "invalid") return null;
  const winnerGameSideId = readNullableIdentifier(value.winnerGameSideId);
  if (winnerGameSideId.status === "invalid") return null;
  const catchState = readLiveCatchState(value.catch);
  if (catchState === "invalid") return null;
  const gameFacts = readControllerGameFacts(value.gameFacts);
  if (gameFacts === null) return null;
  return {
    interpreterVersion: value.interpreterVersion,
    phase: value.phase,
    scoreByGameSide,
    goalCount: value.goalCount,
    timeout,
    stoppage,
    heat,
    result,
    overtime,
    overtimeTarget: overtimeTarget === "missing" ? null : overtimeTarget,
    winnerGameSideId: winnerGameSideId.status === "value" ? winnerGameSideId.value : null,
    catch: catchState === "missing" ? null : catchState,
    gameFacts,
    clock,
  };
}

function readControllerGameFacts(value: unknown): ControllerGameFact[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > SHARED_LIMITS.replay.maxControlActions) return null;
  const facts: ControllerGameFact[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return null;
    const factId = validateOpaqueIdentifier(candidate.factId, "gameFacts.factId");
    const factType = validateOpaqueIdentifier(candidate.factType, "gameFacts.factType");
    const gameSideId =
      candidate.gameSideId === null
        ? null
        : validateOpaqueIdentifier(candidate.gameSideId, "gameFacts.gameSideId");
    const gameTimeMsResult =
      candidate.gameTimeMs === null
        ? ({ ok: true, value: null } as const)
        : validateIntegerInRange(candidate.gameTimeMs, 0, SHARED_LIMITS.clock.maxMs, "gameTimeMs");
    const sportingOrder = validateIntegerInRange(
      candidate.sportingOrder,
      0,
      SHARED_LIMITS.clock.maxMs,
      "sportingOrder",
    );
    const synchronizationOrder = validateIntegerInRange(
      candidate.synchronizationOrder,
      1,
      SHARED_LIMITS.replay.maxControlActions,
      "synchronizationOrder",
    );
    const data = parseJsonValue(candidate.data, "gameFacts.data");
    if (
      !factId.ok ||
      !factType.ok ||
      (gameSideId !== null && !gameSideId.ok) ||
      !gameTimeMsResult.ok ||
      !sportingOrder.ok ||
      !synchronizationOrder.ok ||
      !data.ok ||
      typeof candidate.effective !== "boolean"
    )
      return null;
    facts.push({
      factId: factId.value,
      factType: factType.value,
      gameSideId: gameSideId === null ? null : gameSideId.value,
      gameTimeMs: gameTimeMsResult.value,
      sportingOrder: sportingOrder.value,
      synchronizationOrder: synchronizationOrder.value,
      effective: candidate.effective,
      data: data.value,
    });
  }
  return facts;
}

function readLiveTimeoutState(value: unknown): LiveTimeoutState {
  if (value === undefined) return { status: "inactive", factId: null };
  if (!isRecord(value)) throw new Error("Derived timeout state is invalid.");
  if (value.status !== "inactive" && value.status !== "started") {
    throw new Error("Derived timeout status is invalid.");
  }
  const factId =
    value.factId === null ? null : validateOpaqueIdentifier(value.factId, "timeout.factId");
  if (factId !== null && !factId.ok) throw new Error("Derived timeout fact is invalid.");
  return { status: value.status, factId: factId === null ? null : factId.value };
}

function readLiveStoppageState(value: unknown): LiveStoppageState {
  if (value === undefined) return { status: "none", factId: null };
  if (!isRecord(value)) throw new Error("Derived stoppage state is invalid.");
  if (
    value.status !== "none" &&
    value.status !== "suspension" &&
    value.status !== "heat-stoppage"
  ) {
    throw new Error("Derived stoppage status is invalid.");
  }
  const factId =
    value.factId === null ? null : validateOpaqueIdentifier(value.factId, "stoppage.factId");
  if (factId !== null && !factId.ok) throw new Error("Derived stoppage fact is invalid.");
  return { status: value.status, factId: factId === null ? null : factId.value };
}

function readLiveHeatState(value: unknown): LiveHeatState {
  if (value === undefined) {
    return { status: "inactive", factId: null, startedAtGameTimeMs: null, nominalDurationMs: null };
  }
  if (!isRecord(value)) throw new Error("Derived heat state is invalid.");
  if (
    value.status !== "inactive" &&
    value.status !== "started" &&
    value.status !== "ended" &&
    value.status !== "skipped" &&
    value.status !== "extended"
  ) {
    throw new Error("Derived heat status is invalid.");
  }
  const factId =
    value.factId === null ? null : validateOpaqueIdentifier(value.factId, "heat.factId");
  if (factId !== null && !factId.ok) throw new Error("Derived heat fact is invalid.");
  const startedAtGameTimeMs =
    value.startedAtGameTimeMs === undefined || value.startedAtGameTimeMs === null
      ? ({ ok: true, value: null } as const)
      : validateIntegerInRange(
          value.startedAtGameTimeMs,
          0,
          SHARED_LIMITS.clock.maxMs,
          "heat.startedAtGameTimeMs",
        );
  const nominalDurationMs =
    value.nominalDurationMs === undefined || value.nominalDurationMs === null
      ? ({ ok: true, value: null } as const)
      : validateIntegerInRange(
          value.nominalDurationMs,
          0,
          SHARED_LIMITS.clock.maxMs,
          "heat.nominalDurationMs",
        );
  if (
    !startedAtGameTimeMs.ok ||
    !nominalDurationMs.ok ||
    (value.status === "inactive" &&
      (startedAtGameTimeMs.value !== null || nominalDurationMs.value !== null))
  ) {
    throw new Error("Derived heat timing is invalid.");
  }
  return {
    status: value.status,
    factId: factId === null ? null : factId.value,
    startedAtGameTimeMs: startedAtGameTimeMs.value,
    nominalDurationMs: nominalDurationMs.value,
  };
}

function readLiveResultState(value: unknown): LiveResultState {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error("Derived result state is invalid.");
  const factId = validateOpaqueIdentifier(value.factId, "result.factId");
  const data = parseJsonValue(value.data, "result.data");
  if (!factId.ok || !data.ok) throw new Error("Derived result state is invalid.");
  return { factId: factId.value, data: data.value };
}

function readNullableScore(value: unknown): number | null | "missing" | "invalid" {
  if (value === undefined) return "missing";
  if (value === null) return null;
  const parsed = validateIntegerInRange(value, 0, 1_000, "overtimeTarget");
  return parsed.ok ? parsed.value : "invalid";
}

function readNullableIdentifier(
  value: unknown,
): { status: "missing" | "null" | "invalid" } | { status: "value"; value: string } {
  if (value === undefined) return { status: "missing" };
  if (value === null) return { status: "null" };
  const parsed = validateOpaqueIdentifier(value, "winnerGameSideId");
  return parsed.ok ? { status: "value", value: parsed.value } : { status: "invalid" };
}

function readLiveCatchState(value: unknown): LiveCatchState | null | "missing" | "invalid" {
  if (value === undefined) return "missing";
  if (value === null) return null;
  if (!isRecord(value)) return "invalid";
  const factId = validateOpaqueIdentifier(value.factId, "catch.factId");
  const catchingGameSideId = validateOpaqueIdentifier(
    value.catchingGameSideId,
    "catch.catchingGameSideId",
  );
  const nonCatchingGameSideId = validateOpaqueIdentifier(
    value.nonCatchingGameSideId,
    "catch.nonCatchingGameSideId",
  );
  const gameTimeMs = validateIntegerInRange(
    value.gameTimeMs,
    0,
    SHARED_LIMITS.clock.maxMs,
    "catch.gameTimeMs",
  );
  const targetScore = readNullableScore(value.targetScore);
  if (
    !factId.ok ||
    !catchingGameSideId.ok ||
    !nonCatchingGameSideId.ok ||
    !gameTimeMs.ok ||
    targetScore === "missing" ||
    targetScore === "invalid"
  )
    return "invalid";
  return {
    factId: factId.value,
    catchingGameSideId: catchingGameSideId.value,
    nonCatchingGameSideId: nonCatchingGameSideId.value,
    gameTimeMs: gameTimeMs.value,
    targetScore,
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

function rebuildLiveDerivedState(
  root: EventGameRecordRoot,
  actions: readonly {
    action: ControlAction;
    canonicalContent: string;
    contentFingerprint: string;
  }[],
): LiveEventGameDerivedState | null {
  const rebuilt = rebuildControlActionHistory(
    root,
    actions,
    createControlActionCodecRegistry(createDefaultControlActionCodecs()),
    createLiveEventGameIqaInterpreter(),
  );
  if (rebuilt.status !== "ready") return null;
  return deriveLiveEventGameState(
    root,
    rebuilt.canonicalActions.map((action) => ({ action })),
    rebuilt.effectiveFacts,
    LIVE_EVENT_IQA_INTERPRETER_VERSION,
  );
}

function rebuildLiveDerivedStateWithCandidate(
  actions: readonly {
    action: ControlAction;
    canonicalContent: string;
    contentFingerprint: string;
  }[],
  root: EventGameRecordRoot,
  candidate: ControlAction,
): LiveEventGameDerivedState | null {
  const prepared = prepareControlAction(
    candidate,
    root,
    createControlActionCodecRegistry(createDefaultControlActionCodecs()),
    candidate.acceptedAtMs,
  );
  if (!prepared.ok) return null;
  return rebuildLiveDerivedState(root, [
    ...actions,
    {
      action: candidate,
      canonicalContent: prepared.value.canonicalContent,
      contentFingerprint: prepared.value.contentFingerprint,
    },
  ]);
}

function validateEffectiveClosePlayOrdering(
  state: LiveEventGameDerivedState,
): { status: "accepted" } | { status: "rejected"; reason: "invalid-action"; detail: string } {
  const scoringFacts = state.gameFacts.filter(
    (fact) =>
      fact.effective &&
      fact.gameTimeMs !== null &&
      (fact.factType === "goal" || fact.factType === "flag-catch"),
  );
  const selectedPairs: { catchFactId: string; goalFactId: string }[] = [];
  for (const fact of scoringFacts) {
    const adjudication = readSportingOrderAdjudication(isRecord(fact.data) ? fact.data : null);
    if (adjudication === null) continue;
    const related = scoringFacts.filter(
      (candidate) => candidate.factId === adjudication.relatedFactId,
    );
    if (related.length !== 1 || !isCloseOpposingScoringPair(fact, related[0]!)) {
      return rejectedLiveAction(
        "Sporting-order adjudication must name one effective close opposing Game Fact.",
      );
    }
    const pair =
      fact.factType === "flag-catch"
        ? { catchFactId: fact.factId, goalFactId: related[0]!.factId }
        : { catchFactId: related[0]!.factId, goalFactId: fact.factId };
    if (
      !selectedPairs.some(
        (candidate) =>
          candidate.catchFactId === pair.catchFactId && candidate.goalFactId === pair.goalFactId,
      )
    ) {
      selectedPairs.push(pair);
    }
  }
  for (const catchFact of scoringFacts.filter((fact) => fact.factType === "flag-catch")) {
    const nearbyGoals = scoringFacts.filter(
      (fact) => fact.factType === "goal" && isCloseOpposingScoringPair(catchFact, fact),
    );
    if (nearbyGoals.length === 0) continue;
    const catchPairs = selectedPairs.filter((pair) => pair.catchFactId === catchFact.factId);
    if (catchPairs.length !== 1) {
      return rejectedLiveAction(
        catchPairs.length === 0
          ? "A close goal and flag catch require explicit Head Referee sporting-order adjudication."
          : "Close-play sporting-order evidence must identify exactly one paired goal.",
      );
    }
  }
  return { status: "accepted" };
}

function validateEffectiveConcessionPreconditions(
  state: LiveEventGameDerivedState,
): { status: "accepted" } | { status: "rejected"; reason: "invalid-action"; detail: string } {
  const effectiveFacts = orderControllerGameFacts(state.gameFacts).filter((fact) => fact.effective);
  for (const [index, fact] of effectiveFacts.entries()) {
    if (fact.factType !== "concession") continue;
    const precedingFacts = effectiveFacts.slice(0, index);
    const precedingOutcome = deriveScoringOutcomeByGameFacts(state.scoreByGameSide, precedingFacts);
    const precedingResult = precedingFacts.some(
      (candidate) =>
        candidate.factType === "concession" ||
        candidate.factType === "forfeit" ||
        candidate.factType === "double-forfeit" ||
        candidate.factType === "result",
    );
    if (
      precedingOutcome.overtimeTarget === null ||
      precedingResult ||
      Object.values(precedingOutcome.scoreByGameSide).some(
        (score) => score >= precedingOutcome.overtimeTarget!,
      )
    ) {
      return rejectedLiveAction("A concession is only effective during unfinished overtime.");
    }
  }
  return { status: "accepted" };
}

function validateEffectiveResultPreconditions(
  state: LiveEventGameDerivedState,
): { status: "accepted" } | { status: "rejected"; reason: "invalid-action"; detail: string } {
  const hasEffectiveGenericResult = state.gameFacts.some(
    (fact) => fact.effective && fact.factType === "result",
  );
  if (
    hasEffectiveGenericResult &&
    state.overtimeTarget !== null &&
    state.winnerGameSideId === null
  ) {
    return rejectedLiveAction("A generic Result cannot finish unfinished overtime.");
  }
  return { status: "accepted" };
}

export function validateLiveEventGameActionInTransaction(
  actions: readonly {
    action: ControlAction;
    canonicalContent: string;
    contentFingerprint: string;
  }[],
  root: EventGameRecordRoot,
  candidate: ControlAction,
): { status: "accepted" } | { status: "rejected"; reason: "invalid-action"; detail: string } {
  const clockValidation = validateLiveEventClockActionInTransaction(actions, candidate);
  if (clockValidation.status === "rejected") return clockValidation;

  const current = rebuildLiveDerivedState(root, actions);
  if (current === null) {
    return {
      status: "rejected",
      reason: "invalid-action",
      detail: "The current Event Game state cannot be rebuilt authoritatively.",
    };
  }
  const scoreValidation = validateDerivedScoreUpperBound(current, candidate);
  if (scoreValidation.status === "rejected") return scoreValidation;
  if (candidate.interpretation.type === "correction") {
    const rebuilt = rebuildLiveDerivedStateWithCandidate(actions, root, candidate);
    if (rebuilt === null) {
      return rejectedLiveAction("The corrected live Game state cannot be rebuilt authoritatively.");
    }
    if (candidate.interpretation.effective) {
      const effectiveCatchCount = rebuilt.gameFacts.filter(
        (fact) => fact.effective && fact.factType === "flag-catch",
      ).length;
      if (effectiveCatchCount > 1) {
        return rejectedLiveAction("Only one Flag Catch can remain effective.");
      }
      const closePlayValidation = validateEffectiveClosePlayOrdering(rebuilt);
      if (closePlayValidation.status === "rejected") return closePlayValidation;
    }
    const concessionValidation = validateEffectiveConcessionPreconditions(rebuilt);
    if (concessionValidation.status === "rejected") return concessionValidation;
    const resultValidation = validateEffectiveResultPreconditions(rebuilt);
    if (resultValidation.status === "rejected") return resultValidation;
    return candidate.override === undefined
      ? { status: "accepted" }
      : rejectedLiveAction("Official Overrides cannot be attached to a Correction.");
  }
  if (candidate.interpretation.type !== "fact") {
    return candidate.override === undefined
      ? { status: "accepted" }
      : rejectedLiveAction("Official Overrides require a supported live Game Fact.");
  }
  const payload = candidate.interpretation.payload;
  if (!isRecord(payload)) return rejectedLiveAction("The live Game Fact payload is invalid.");
  const gameTimeMs = typeof payload.gameTimeMs === "number" ? payload.gameTimeMs : null;
  const data = isRecord(payload.data) ? payload.data : null;
  const sportingOrder =
    data !== null && typeof data.sportingOrder === "number" ? data.sportingOrder : gameTimeMs;
  const sportingOrderDiffers =
    gameTimeMs !== null && sportingOrder !== null && sportingOrder !== gameTimeMs;
  const sportingOrderAdjudication = readSportingOrderAdjudication(data);
  const sportingOrderOverride = readSportingOrderOverride(data);
  const closePair = findCloseGoalCatchPair(
    candidate,
    current,
    gameTimeMs,
    sportingOrderAdjudication,
  );
  if (closePair.status === "rejected") return closePair;
  if (closePair.fact !== null) {
    if (sportingOrderAdjudication === null) {
      return rejectedLiveAction(
        "A close goal and flag catch require explicit Head Referee sporting-order adjudication.",
      );
    }
    if (sportingOrderAdjudication.relatedFactId !== closePair.fact.factId) {
      return rejectedLiveAction(
        "Sporting-order adjudication must name the close opposing Game Fact.",
      );
    }
  } else if (sportingOrderAdjudication !== null) {
    return rejectedLiveAction("Sporting-order adjudication requires one close opposing Game Fact.");
  }
  if (candidate.interpretation.factType === "target-score") {
    return rejectedLiveAction("Overtime winners are derived from accepted scoring facts.");
  }
  if (
    candidate.interpretation.factType === "concession" &&
    (!current.overtime || current.winnerGameSideId !== null || current.phase === "finished")
  ) {
    return rejectedLiveAction("A concession is only accepted during unfinished overtime.");
  }
  if (candidate.interpretation.factType === "flag-catch") {
    if (current.catch !== null) {
      return rejectedLiveAction("Only one effective flag catch may determine the Game result.");
    }
    const validCatchBoundary =
      gameTimeMs !== null && gameTimeMs >= SEEKER_RELEASE_MS && !current.clock.running;
    if (!validCatchBoundary) {
      const expectedBoundaryOverride = expectedLiveOverride(
        candidate,
        current,
        false,
        gameTimeMs,
        data,
      );
      if (candidate.override === undefined || expectedBoundaryOverride === null) {
        return rejectedLiveAction("A flag catch requires released seekers and stopped play.");
      }
      const boundaryValidation = validateOfficialOverrideEvidence(
        candidate.override,
        expectedBoundaryOverride,
      );
      if (boundaryValidation.status === "rejected") return boundaryValidation;
      if (closePair.fact !== null && sportingOrderAdjudication !== null) {
        const expectedSportingOrderOverride = expectedClosePlayOverride(
          closePair.fact,
          gameTimeMs,
          sportingOrderAdjudication,
        );
        if (sportingOrderOverride === undefined || expectedSportingOrderOverride === null) {
          return rejectedLiveAction(
            "A separate Sporting Order override is required for this close flag catch.",
          );
        }
        return validateOfficialOverrideEvidence(
          sportingOrderOverride,
          expectedSportingOrderOverride,
        );
      }
      return { status: "accepted" };
    }
  }
  if (candidate.interpretation.factType === "timeout" && current.clock.running) {
    if (candidate.override?.guardrail !== "timeout-requires-paused-play") {
      return rejectedLiveAction("A normal timeout requires paused play.");
    }
  }
  const expected =
    closePair.fact !== null && sportingOrderAdjudication !== null
      ? expectedClosePlayOverride(closePair.fact, gameTimeMs, sportingOrderAdjudication)
      : expectedLiveOverride(candidate, current, sportingOrderDiffers, gameTimeMs, data);
  if (sportingOrderOverride !== undefined) {
    return rejectedLiveAction(
      "A separate Sporting Order override is only valid with a flag-catch boundary override.",
    );
  }
  if (expected === null) {
    return candidate.override === undefined
      ? { status: "accepted" }
      : rejectedLiveAction("The Official Override does not match a supported live guardrail.");
  }
  if (candidate.override === undefined) {
    return expected.required || sportingOrderDiffers
      ? rejectedLiveAction("Head Referee provenance is required for adjudicated sporting order.")
      : { status: "accepted" };
  }
  return validateLiveOfficialOverrideEvidence(candidate, expected);
}

type LiveOverrideExpectation = {
  required: boolean;
  guardrail: string;
  direction: string;
  beforeValue: ActionJsonValue;
  afterValue: ActionJsonValue;
  gameTimeMs: number;
};

function expectedLiveOverride(
  candidate: ControlAction,
  current: LiveEventGameDerivedState,
  sportingOrderDiffers: boolean,
  gameTimeMs: number | null,
  data: Record<string, unknown> | null,
): LiveOverrideExpectation | null {
  if (gameTimeMs === null) return null;
  if (candidate.interpretation.type !== "fact") return null;
  const factType = candidate.interpretation.factType;
  if (sportingOrderDiffers) {
    const adjudicatedSportingOrder =
      data !== null && typeof data.sportingOrder === "number" ? data.sportingOrder : gameTimeMs;
    return {
      required: true,
      guardrail: "sporting-order-adjudication",
      direction: "head-referee-adjudicated-sporting-order",
      beforeValue: { sportingOrder: gameTimeMs },
      afterValue: { sportingOrder: adjudicatedSportingOrder },
      gameTimeMs,
    };
  }
  if (factType === "timeout") {
    if (!current.clock.running) return null;
    return {
      required: true,
      guardrail: "timeout-requires-paused-play",
      direction: "head-referee-directed-timeout-while-running",
      beforeValue: { running: current.clock.running },
      afterValue: { timeout: "started" },
      gameTimeMs,
    };
  }
  if (factType === "flag-catch") {
    if (gameTimeMs >= SEEKER_RELEASE_MS && !current.clock.running && current.catch === null) {
      return null;
    }
    return {
      required: true,
      guardrail: "flag-catch-requires-seeker-release-and-stopped-play",
      direction: "head-referee-directed-flag-catch-boundary",
      beforeValue: {
        seekerReleased: gameTimeMs >= SEEKER_RELEASE_MS,
        running: current.clock.running,
      },
      afterValue: { flagCatch: "accepted" },
      gameTimeMs,
    };
  }
  if (factType === "heat-stoppage") {
    const heatAction = data?.heatAction;
    if (
      heatAction !== "end" ||
      current.heat.status !== "started" ||
      current.heat.startedAtGameTimeMs === null ||
      current.heat.nominalDurationMs === null ||
      gameTimeMs >= current.heat.startedAtGameTimeMs + current.heat.nominalDurationMs
    ) {
      return null;
    }
    const afterValue =
      heatAction === "end"
        ? "ended"
        : heatAction === "skip-required"
          ? "skipped"
          : heatAction === "extend-permitted"
            ? "extended"
            : "started";
    return {
      required: true,
      guardrail: "heat-stoppage-rule-deviation",
      direction: "head-referee-directed-heat-stoppage",
      beforeValue: { heat: current.heat.status },
      afterValue: { heat: afterValue },
      gameTimeMs,
    };
  }
  return null;
}

function expectedClosePlayOverride(
  relatedFact: ControllerGameFact,
  gameTimeMs: number | null,
  adjudication: SportingOrderAdjudication,
): LiveOverrideExpectation | null {
  if (gameTimeMs === null) return null;
  return {
    required: true,
    guardrail: "sporting-order-adjudication",
    direction: "head-referee-adjudicated-sporting-order",
    beforeValue: {
      candidateGameTimeMs: gameTimeMs,
      relatedFactId: relatedFact.factId,
      relatedGameTimeMs: relatedFact.gameTimeMs,
    },
    afterValue: {
      relation: adjudication.relation,
      sportingOrder: "explicit-pair-order",
    },
    gameTimeMs,
  };
}

function validateLiveOfficialOverrideEvidence(
  candidate: ControlAction,
  expected: LiveOverrideExpectation,
): { status: "accepted" } | { status: "rejected"; reason: "invalid-action"; detail: string } {
  const override = candidate.override;
  if (override === undefined) return rejectedLiveAction("Official Override evidence is missing.");
  return validateOfficialOverrideEvidence(override, expected);
}

function validateOfficialOverrideEvidence(
  override: OfficialOverrideMetadata,
  expected: LiveOverrideExpectation,
): { status: "accepted" } | { status: "rejected"; reason: "invalid-action"; detail: string } {
  if (
    override.guardrail !== expected.guardrail ||
    override.direction !== expected.direction ||
    override.confirmation !== "head-referee-confirmed" ||
    override.reason !== "head-referee-direction" ||
    override.gameTimeMs !== expected.gameTimeMs ||
    override.beforeValue === undefined ||
    override.afterValue === undefined ||
    canonicalizeJson(override.beforeValue) !== canonicalizeJson(expected.beforeValue) ||
    canonicalizeJson(override.afterValue) !== canonicalizeJson(expected.afterValue)
  ) {
    return rejectedLiveAction("Official Override evidence does not match effective state.");
  }
  return { status: "accepted" };
}

function rejectedLiveAction(detail: string): {
  status: "rejected";
  reason: "invalid-action";
  detail: string;
} {
  return { status: "rejected", reason: "invalid-action", detail };
}

function validateDerivedScoreUpperBound(
  current: LiveEventGameDerivedState,
  candidate: ControlAction,
): { status: "accepted" } | { status: "rejected"; reason: "invalid-action"; detail: string } {
  const currentScores = Object.values(current.scoreByGameSide);
  if (currentScores.some((score) => score > SHARED_LIMITS.score.max)) {
    return rejectedLiveAction("The derived score already exceeds the permitted upper bound.");
  }
  const interpretation = candidate.interpretation;
  if (interpretation.type === "correction") {
    const target = current.gameFacts.find((fact) => fact.factId === interpretation.targetFactId);
    if (target === undefined || target.effective === interpretation.effective) {
      return { status: "accepted" };
    }
    const facts = current.gameFacts.map((fact) =>
      fact.factId === target.factId ? { ...fact, effective: interpretation.effective } : fact,
    );
    return validateScoringOutcomeBounds(
      deriveScoringOutcomeByGameFacts(current.scoreByGameSide, facts),
    );
  }
  if (candidate.interpretation.type !== "fact") return { status: "accepted" };
  const factType = candidate.interpretation.factType;
  const gameSideId = candidate.interpretation.gameSideId;
  if (gameSideId === null || !(gameSideId in current.scoreByGameSide)) {
    return { status: "accepted" };
  }
  const nextScores = { ...current.scoreByGameSide };
  if (factType === "goal") {
    nextScores[gameSideId] = (nextScores[gameSideId] ?? 0) + 10;
  } else if (factType === "flag-catch" && current.catch === null) {
    nextScores[gameSideId] = (nextScores[gameSideId] ?? 0) + 30;
  } else if (factType === "concession") {
    const opponent = Object.keys(nextScores).find((side) => side !== gameSideId);
    if (opponent !== undefined) {
      const concedingScore = nextScores[gameSideId] ?? 0;
      const opponentScore = nextScores[opponent] ?? 0;
      if (concedingScore >= opponentScore) {
        const points = Math.max(10, Math.ceil((concedingScore + 10 - opponentScore) / 10) * 10);
        nextScores[opponent] = opponentScore + points;
      }
    }
  }
  const scoreValidation = scoreUpperBoundResult(nextScores);
  if (scoreValidation.status === "rejected") return scoreValidation;
  if (
    (factType === "goal" || factType === "flag-catch") &&
    (factType !== "flag-catch" || current.catch === null)
  ) {
    return validateScoringOutcomeBounds(
      deriveScoringOutcomeByGameFacts(current.scoreByGameSide, [
        ...current.gameFacts,
        controllerGameFactFromCandidate(candidate, current.gameFacts),
      ]),
    );
  }
  return { status: "accepted" };
}

function scoreUpperBoundResult(
  scores: Readonly<Record<string, number>>,
): { status: "accepted" } | { status: "rejected"; reason: "invalid-action"; detail: string } {
  return Object.values(scores).some((score) => score > SHARED_LIMITS.score.max)
    ? rejectedLiveAction(`The derived score must not exceed ${SHARED_LIMITS.score.max}.`)
    : { status: "accepted" };
}

function validateScoringOutcomeBounds(outcome: {
  scoreByGameSide: Readonly<Record<string, number>>;
  overtimeTarget: number | null;
}): { status: "accepted" } | { status: "rejected"; reason: "invalid-action"; detail: string } {
  const scoreValidation = scoreUpperBoundResult(outcome.scoreByGameSide);
  if (scoreValidation.status === "rejected") return scoreValidation;
  return outcome.overtimeTarget !== null && outcome.overtimeTarget > SHARED_LIMITS.score.max
    ? rejectedLiveAction(`The derived overtime target must not exceed ${SHARED_LIMITS.score.max}.`)
    : { status: "accepted" };
}

function controllerGameFactFromCandidate(
  candidate: ControlAction,
  currentFacts: readonly ControllerGameFact[],
): ControllerGameFact {
  if (candidate.interpretation.type !== "fact") {
    throw new Error("Only a Game Fact can be projected as a candidate fact.");
  }
  const payload = isRecord(candidate.interpretation.payload)
    ? candidate.interpretation.payload
    : {};
  const gameTimeMs = typeof payload.gameTimeMs === "number" ? payload.gameTimeMs : null;
  const data = isActionJsonValue(payload.data) ? payload.data : null;
  const sportingOrder =
    isRecord(data) && typeof data.sportingOrder === "number"
      ? data.sportingOrder
      : (gameTimeMs ?? 0);
  return {
    factId: candidate.interpretation.factId,
    factType: candidate.interpretation.factType,
    gameSideId: candidate.interpretation.gameSideId,
    gameTimeMs,
    sportingOrder,
    synchronizationOrder:
      currentFacts.reduce((highest, fact) => Math.max(highest, fact.synchronizationOrder), 0) + 1,
    effective: true,
    data,
  };
}

function readSportingOrderAdjudication(
  data: Record<string, unknown> | null,
): SportingOrderAdjudication | null {
  const value = data?.sportingOrderAdjudication;
  if (!isRecord(value)) return null;
  if (
    typeof value.relatedFactId !== "string" ||
    (value.relation !== "before" && value.relation !== "after")
  ) {
    return null;
  }
  return { relatedFactId: value.relatedFactId, relation: value.relation };
}

function readSportingOrderOverride(
  data: Record<string, unknown> | null,
): OfficialOverrideMetadata | undefined {
  const parsed = validateOverride(data?.sportingOrderOverride);
  return parsed.ok ? parsed.value : undefined;
}

function findCloseGoalCatchPair(
  candidate: ControlAction,
  current: LiveEventGameDerivedState,
  gameTimeMs: number | null,
  adjudication: SportingOrderAdjudication | null,
):
  | { status: "accepted"; fact: ControllerGameFact | null }
  | { status: "rejected"; reason: "invalid-action"; detail: string } {
  if (candidate.interpretation.type !== "fact" || gameTimeMs === null)
    return { status: "accepted", fact: null };
  const candidateIsGoal = candidate.interpretation.factType === "goal";
  const candidateIsCatch = candidate.interpretation.factType === "flag-catch";
  if (!candidateIsGoal && !candidateIsCatch) return { status: "accepted", fact: null };
  const candidates = current.gameFacts.filter(
    (fact) =>
      fact.effective &&
      fact.gameTimeMs !== null &&
      Math.abs(fact.gameTimeMs - gameTimeMs) <= CLOSE_PLAY_ADJUDICATION_WINDOW_MS &&
      ((candidateIsGoal && fact.factType === "flag-catch") ||
        (candidateIsCatch && fact.factType === "goal")),
  );
  if (adjudication !== null) {
    const namedFacts = current.gameFacts.filter(
      (fact) => fact.factId === adjudication.relatedFactId,
    );
    if (namedFacts.length !== 1) {
      return rejectedLiveAction(
        "Sporting-order adjudication must name one known opposing Game Fact.",
      );
    }
    const namedFact = namedFacts[0];
    if (namedFact === undefined || !candidates.some((fact) => fact.factId === namedFact.factId)) {
      return rejectedLiveAction(
        "Sporting-order adjudication must name one effective close opposing Game Fact.",
      );
    }
    if (hasEffectiveClosePlayPair(namedFact, current)) {
      return rejectedLiveAction(
        "Close-play sporting-order evidence must identify exactly one paired goal and catch.",
      );
    }
    return { status: "accepted", fact: namedFact };
  }
  const unpairedCandidates = candidates.filter((fact) => !hasEffectiveClosePlayPair(fact, current));
  if (unpairedCandidates.length === 0) return { status: "accepted", fact: null };
  if (unpairedCandidates.length > 1) {
    return rejectedLiveAction(
      "Head Referee sporting-order adjudication must identify the exact paired Game Fact.",
    );
  }
  return { status: "accepted", fact: unpairedCandidates[0] ?? null };
}

function hasEffectiveClosePlayPair(
  fact: ControllerGameFact,
  current: LiveEventGameDerivedState,
): boolean {
  const effectiveScoringFacts = current.gameFacts.filter(
    (candidate) =>
      candidate.effective && (candidate.factType === "goal" || candidate.factType === "flag-catch"),
  );
  const ownAdjudication = readSportingOrderAdjudication(isRecord(fact.data) ? fact.data : null);
  if (
    ownAdjudication !== null &&
    effectiveScoringFacts.some(
      (candidate) =>
        candidate.factId === ownAdjudication.relatedFactId &&
        isCloseOpposingScoringPair(fact, candidate),
    )
  ) {
    return true;
  }
  return effectiveScoringFacts.some((candidate) => {
    const adjudication = readSportingOrderAdjudication(
      isRecord(candidate.data) ? candidate.data : null,
    );
    return (
      adjudication?.relatedFactId === fact.factId && isCloseOpposingScoringPair(fact, candidate)
    );
  });
}

function isCloseOpposingScoringPair(left: ControllerGameFact, right: ControllerGameFact): boolean {
  return (
    left.gameTimeMs !== null &&
    right.gameTimeMs !== null &&
    ((left.factType === "goal" && right.factType === "flag-catch") ||
      (left.factType === "flag-catch" && right.factType === "goal")) &&
    Math.abs(left.gameTimeMs - right.gameTimeMs) <= CLOSE_PLAY_ADJUDICATION_WINDOW_MS
  );
}

export function orderControllerGameFacts(
  facts: readonly ControllerGameFact[],
): ControllerGameFact[] {
  const ordered = [...facts].sort(
    (left, right) =>
      left.sportingOrder - right.sportingOrder ||
      left.synchronizationOrder - right.synchronizationOrder ||
      left.factId.localeCompare(right.factId),
  );
  for (const candidate of facts) {
    if (!candidate.effective) continue;
    const adjudication = readSportingOrderAdjudication(
      isRecord(candidate.data) ? candidate.data : null,
    );
    if (adjudication === null) continue;
    const relatedIndex = ordered.findIndex((fact) => fact.factId === adjudication.relatedFactId);
    const candidateIndex = ordered.findIndex((fact) => fact.factId === candidate.factId);
    if (relatedIndex < 0 || candidateIndex < 0 || relatedIndex === candidateIndex) continue;
    if (ordered[relatedIndex]?.effective !== true) continue;
    const candidateShouldPrecedeRelated = adjudication.relation === "before";
    const candidateCurrentlyPrecedesRelated = candidateIndex < relatedIndex;
    if (candidateShouldPrecedeRelated === candidateCurrentlyPrecedesRelated) continue;
    const related = ordered[relatedIndex];
    const currentCandidate = ordered[candidateIndex];
    if (related === undefined || currentCandidate === undefined) continue;
    // Swap only the adjudicated pair. Every unrelated fact keeps its established
    // slot, including facts sharing either endpoint's Game Clock time.
    ordered[relatedIndex] = currentCandidate;
    ordered[candidateIndex] = related;
  }
  return ordered;
}

function deriveScoringOutcomeByGameFacts(
  initialScores: Readonly<Record<string, number>>,
  facts: readonly ControllerGameFact[],
): {
  scoreByGameSide: Readonly<Record<string, number>>;
  overtimeTarget: number | null;
} {
  const scores = Object.fromEntries(Object.keys(initialScores).map((side) => [side, 0]));
  let catchProcessed = false;
  let overtimeTarget: number | null = null;
  const orderedFacts = orderControllerGameFacts(facts).filter((candidate) => candidate.effective);
  for (const fact of orderedFacts) {
    const side = fact.gameSideId;
    if (fact.factType === "goal" && side !== null && side in scores) {
      scores[side] = (scores[side] ?? 0) + 10;
    } else if (fact.factType === "flag-catch" && side !== null && side in scores) {
      if (catchProcessed) continue;
      scores[side] = (scores[side] ?? 0) + 30;
      const opponent = Object.keys(scores).find((candidate) => candidate !== side);
      if (opponent !== undefined && (scores[side] ?? 0) <= (scores[opponent] ?? 0)) {
        overtimeTarget = (scores[opponent] ?? 0) + 30;
      }
      catchProcessed = true;
    } else if (fact.factType === "concession" && side !== null && side in scores) {
      const opponent = Object.keys(scores).find((candidate) => candidate !== side);
      if (opponent === undefined) continue;
      const concedingScore = scores[side] ?? 0;
      const opponentScore = scores[opponent] ?? 0;
      if (concedingScore >= opponentScore) {
        scores[opponent] =
          opponentScore + Math.max(10, Math.ceil((concedingScore + 10 - opponentScore) / 10) * 10);
      }
    }
  }
  return { scoreByGameSide: scores, overtimeTarget };
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

function isActionJsonValue(value: unknown): value is ActionJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isActionJsonValue(item));
  return isRecord(value) && Object.values(value).every((item) => isActionJsonValue(item));
}

function buildLiveOfficialOverride(
  intent: LiveEventControllerIntent,
  sessionId: string,
): OfficialOverrideMetadata | undefined {
  if (intent.override === undefined) return undefined;
  if (
    intent.type === "clock" ||
    intent.type === "set-running" ||
    intent.type === "clock-adjust" ||
    intent.type === "clock-correction" ||
    intent.type === "reset" ||
    intent.type === "undo" ||
    intent.type === "correct-fact"
  ) {
    throw new Error("Official Overrides are not valid for this Controller action.");
  }
  if (intent.sportingOrderAdjudication !== undefined) {
    if (intent.type !== "record-goal" && intent.type !== "record-flag-catch") {
      throw new Error("Sporting-order adjudication is only valid for a goal or flag catch.");
    }
    return {
      ...structuredClone(intent.override),
      gameTimeMs: intent.gameTimeMs,
      authorityReference: intent.override.authorityReference || sessionId,
    };
  }
  const expected = explainLiveEventGuardrail({
    type: intent.type,
    ...(intent.type === "substantive" ? { trigger: intent.trigger } : {}),
    gameTimeMs: intent.gameTimeMs,
    sportingOrder: intent.sportingOrder,
  });
  if (!expected.overrideAllowed || intent.override.guardrail !== expected.guardrail) {
    throw new Error("The Official Override does not match the active IQA guardrail.");
  }
  if (intent.override.reason !== expected.fixedReason) {
    throw new Error("The Official Override requires the fixed Head Referee reason.");
  }
  return {
    ...structuredClone(intent.override),
    gameTimeMs: intent.gameTimeMs,
    authorityReference: intent.override.authorityReference || sessionId,
  };
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
