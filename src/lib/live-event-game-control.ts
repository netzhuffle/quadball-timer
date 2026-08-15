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
  SYSTEM_TIMEOUT_COMPLETION_GRANT,
} from "@/lib/event-game-actions";
import { parseJsonValue, validateOverride } from "@/lib/event-game-action-codecs";
import {
  isValidHexColor,
  type GamePresentation,
  type GamePresentationGrantProvenance,
  type PitchOrientation,
} from "@/lib/game-presentation";
import { createInitialGamePresentation } from "@/lib/game-presentation-projection";
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
import type { ControlAction, ControlActionInput } from "@/lib/event-game-actions";
import type { TypedGrantAuthority } from "@/lib/grant-management-types";
import type {
  HeatStoppageConfiguration,
  HeatStoppageConfigurationScope,
} from "@/lib/heat-stoppage-configuration";
import {
  compareLivePenaltyFactOrder,
  deriveLivePenaltyProjection,
  LIVE_PENALTY_MINUTE_MS,
  LIVE_PENALTY_REASONS,
  LIVE_SEEKER_RELEASE_MS,
  type LiveCardType,
  type LivePenaltyProjection,
  type LivePenaltyReason,
  type LivePenaltyStart,
} from "@/lib/live-event-penalties";
import {
  SHARED_LIMITS,
  validateClockAdjustmentMs,
  validateGameClockMs,
  validateIntegerInRange,
  validateOpaqueIdentifier,
} from "@/lib/validation-policy";
import { sha256 } from "@/lib/event-game-action-json";

export const LIVE_EVENT_CONTROL_INTENT_VERSION = "live-event-control-intent-v1" as const;
export const LIVE_EVENT_IQA_INTERPRETER_VERSION = "live-event-iqa-v1" as const;
export const CLOSE_PLAY_ADJUDICATION_WINDOW_MS = 1_000;
export const EVENT_GAME_LOCK_DELAY_MS = 15 * 60 * 1000;
export const LIVE_SUSPENSION_SNAPSHOT_VERSION = "live-suspension-snapshot-v1" as const;
const PENALTY_DURATION_MS = 60_000;

export type SportingOrderAdjudication = {
  relatedFactId: string;
  relation: "before" | "after";
};

export const HEAT_STOPPAGE_FIRST_TRIGGER_GAME_TIME_MS = 15 * 60 * 1000;
export const HEAT_STOPPAGE_SECOND_TRIGGER_GAME_TIME_MS = 25 * 60 * 1000;
export const HEAT_STOPPAGE_TRIGGER_INTERVAL_MS = 5 * 60 * 1000;
export const HEAT_STOPPAGE_FIRST_NOMINAL_DURATION_MS = 4 * 60 * 1000;
export const HEAT_STOPPAGE_LATER_NOMINAL_DURATION_MS = 2 * 60 * 1000;

export type LiveHeatAction =
  | "start"
  | "end"
  | "skip-required"
  | "extend-permitted"
  | "extend"
  | "end-of-drive"
  | "dead-volleyball"
  | "other-stoppage"
  | "skip"
  | "suppress"
  | "enable"
  | "disable";

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
  heatTriggerId?: string;
  override?: OfficialOverrideMetadata;
};

type ControllerPresentationIntentBase = Omit<ControllerIntentBase, "factId"> & {
  factId: string;
  presentationChangeId: string;
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
      type: "record-card";
      gameSideId: string;
      playerNumber: number | null;
      cardType: LiveCardType;
      foulBeforeScore?: boolean;
      seekerPenalty?: "head-referee-confirmed";
    })
  | (ControllerIntentBase & {
      type: "record-penalty-reason";
      targetCardFactId: string;
      reason: LivePenaltyReason;
    })
  | (ControllerIntentBase & {
      type: "resolve-penalty-expiration";
      pendingId: string;
      scoreFactId: string;
      playerKey: string;
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
      penaltyCardType?: "blue" | "yellow" | "red" | "ejection";
      penaltyPlayerKey?: string;
      heatAction?: LiveHeatAction;
      timeoutAction?: "stoppage" | "start" | "complete";
      timeoutGameSideId?: string;
      suspensionAction?: "start" | "resume";
      suspensionSnapshot?: LiveSuspensionSnapshot;
      resumesSuspensionFactId?: string;
    })
  | (ControllerIntentBase & {
      type: "reset" | "undo";
    })
  | (ControllerPresentationIntentBase & {
      type: "set-pitch-orientation";
      pitchOrientation: PitchOrientation;
    })
  | (ControllerPresentationIntentBase & {
      type: "set-displayed-team-color";
      gameSideId: string;
      color: string;
    });

export type LiveEventControllerSubmission = LiveEventControllerIntent;
export type GamePresentationChangeIntent = Extract<
  LiveEventControllerIntent,
  { type: "set-pitch-orientation" | "set-displayed-team-color" }
>;
export type LiveEventControlActionIntent = Exclude<
  LiveEventControllerIntent,
  GamePresentationChangeIntent
>;
export type GamePresentationChangeResult =
  | {
      status: "accepted" | "duplicate-accepted";
      operationId: string;
      presentation: GamePresentation;
      auditId: string;
    }
  | { status: "retryable" | "rejected"; operationId: string | null; message: string };

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
export type ControllerSessionWithReplayProof = ControllerSessionAttachment & {
  replayProvenanceProof: string;
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
  suspension: LiveSuspensionState;
  stoppage: LiveStoppageState;
  heat: LiveHeatState;
  result: LiveResultState;
  overtime: boolean;
  overtimeTarget: number | null;
  winnerGameSideId: string | null;
  catch: LiveCatchState | null;
  gameFacts: readonly ControllerGameFact[];
  penalties: LivePenaltyProjection;
  presentation?: GamePresentation;
};

/**
 * Rebuild the public-safe sporting state from the committed Event Game Record inputs.
 * Audience projections use this instead of reimplementing scoring or correction semantics.
 */
export function projectLiveEventGameDerivedState(
  root: EventGameRecordRoot,
  storedActions: readonly {
    action: ControlAction;
    canonicalContent: string;
    contentFingerprint: string;
  }[],
): LiveEventGameDerivedState | null {
  return rebuildLiveDerivedState(root, storedActions);
}

export type LiveTimeoutState = {
  status: "inactive" | "stoppage" | "started" | "completed";
  factId: string | null;
  gameSideId?: string | null;
  usedGameSideIds?: readonly string[];
  startedAtMs?: number | null;
  remainingMs?: number | null;
  longWhistleCue?: "not-applicable" | "pending" | "due" | "passed";
};

export type LiveSuspensionSnapshot = {
  version: typeof LIVE_SUSPENSION_SNAPSHOT_VERSION;
  gameTimeMs: number;
  scoreByGameSide: Readonly<Record<string, number>>;
  penalties: LiveSuspensionPenaltyState;
  volleyballPossession: string;
  dodgeballPossession: Readonly<Record<string, string | null>>;
};

export type LiveSuspensionPenaltyState = {
  segments: readonly {
    sourceFactId: string;
    elapsedMs: number;
    remainingMs: number;
    expirableByScore: boolean;
    cardFactId?: string;
    cardType?: Exclude<LiveCardType, "ejection">;
    gameSideId?: string;
    playerKey?: string;
    playerNumber?: number | null;
    eligibleForScoreAtGameTimeMs?: number;
    notBeforeGameTimeMs?: number;
    startsAtGameTimeMs?: number;
    endsAtGameTimeMs?: number;
  }[];
};

export type LiveSuspensionState = {
  status: "none" | "suspended";
  factId: string | null;
  snapshot: LiveSuspensionSnapshot | null;
};

export type LiveStoppageState = {
  status: "none" | "suspension" | "heat-stoppage";
  factId: string | null;
};

export type LiveHeatState = {
  status:
    | "inactive"
    | "started"
    | "ended"
    | "skipped"
    | "required-skip"
    | "suppressed"
    | "extended";
  factId: string | null;
  startedAtGameTimeMs: number | null;
  nominalDurationMs: number | null;
  allowedDurationMs?: number | null;
  actualDurationMs?: number | null;
  completedAtAllowed?: boolean;
  rawActualDurationMs?: number | null;
  completionAtTrustedAtMs?: number | null;
  mode?: "enabled" | "disabled";
  pendingTrigger?: { gameTimeMs: number; index: number } | null;
  pendingTriggerId?: string | null;
  pendingTriggerGameTimeMs?: number | null;
  nextTriggerGameTimeMs?: number | null;
  trigger?: { id: string; gameTimeMs: number; index: number } | null;
  permittedExtensionTriggerId?: string | null;
  activeTriggerId?: string | null;
  triggerDecision?:
    | "end-of-drive"
    | "dead-volleyball"
    | "other-stoppage"
    | "skip"
    | "skip-required"
    | null;
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
  trustedAtMs?: number;
  acceptedAtMs?: number;
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
  knownDodgeballIds?: readonly string[];
  timeout?: LiveTimeoutState;
  suspension?: LiveSuspensionState;
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
  penalties?: LivePenaltyProjection;
  guardrails?: readonly LiveEventGuardrailExplanation[];
  commencement: ControllerCommencement;
  clock: ClockProjection;
  presentation?: GamePresentation;
};

type LiveMaterializationAuthority = {
  sessionBearer: string;
  grantSessionId: string;
  grantVersion: string;
};

type TimeoutMaterializationResult =
  | { status: "ready"; root: EventGameRecordRoot }
  | { status: "failed"; root: EventGameRecordRoot };

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
      /** Internal replay handoff; omitted from ordinary transport results. */
      replayReservationId?: string;
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
  listEventGameRoots: () => Promise<readonly EventGameRecordRoot[]>;
  /** Runtime-owned, per-replay capability store. */
  lockedReplayCapability?: {
    issue(replayDigest: string): string;
    remember(input: { evidence: string; replayDigest: string; reservationId: string }): void;
    find(replayDigest: string): string | null;
    authorize(replayDigest: string): void;
    authorized(evidence: string): boolean;
    reservationId(evidence: string): string | null;
  };
  authorizeLockedReplay?: (input: {
    sessionBearer: string;
    eventGameId: string;
    grantSessionId: string;
    grantVersion: string;
    evidence?: string;
  }) => Promise<boolean>;
  lockEventGame?: (
    eventGameId: string,
    lockedAtMs: number,
  ) => Promise<
    | { status: "locked"; eventGameId: string; terminatedSessionCount: number }
    | { status: "rejected"; reason: string }
  >;
  clock?: () => number;
  /** Event-Game-scoped authoritative dodgeball identities; required for a first suspension. */
  knownDodgeballIdsForEventGame?: (eventGameId: string) => readonly string[] | undefined;
  /** Test-only seam for proving the post-commit projection response. */
  projectionFailure?: () => boolean;
  /** Production composition seam backed by the Event Admin catalog snapshot. */
  readHeatStoppageConfiguration?: (
    scope: HeatStoppageConfigurationScope,
  ) => HeatStoppageConfiguration | null | Promise<HeatStoppageConfiguration | null>;
  /** Fixed configuration shortcut for deterministic callers and tests. */
  heatStoppageConfiguration?: boolean;
};

export type ControllerReplayOutcome = {
  operationId: string;
  status:
    | "accepted"
    | "idempotent"
    | "retryable"
    | "causally-blocked"
    | "held-for-correction"
    | "locked-discarded"
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
  discardedCount?: number;
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
    value.type !== "record-card" &&
    value.type !== "record-penalty-reason" &&
    value.type !== "resolve-penalty-expiration" &&
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
    value.type !== "undo" &&
    value.type !== "set-pitch-orientation" &&
    value.type !== "set-displayed-team-color"
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
  const gameTimeMs = validateIntegerInRange(
    value.gameTimeMs,
    0,
    SHARED_LIMITS.clock.maxMs,
    "gameTimeMs",
  );
  if (!operationId.ok) return invalid(operationId.error);
  if (!gameTimeMs.ok) return invalid(gameTimeMs.error);

  if (value.type === "set-pitch-orientation" || value.type === "set-displayed-team-color") {
    const presentationChangeId = validateOpaqueIdentifier(
      value.presentationChangeId,
      "presentationChangeId",
    );
    if (!presentationChangeId.ok) return invalid(presentationChangeId.error);
    if (!isRecord(value.occurrence)) return invalid("occurrence must be an object.");
    const clientOrigin =
      value.occurrence.clientOriginAtMs === null || value.occurrence.clientOriginAtMs === undefined
        ? null
        : validateIntegerInRange(
            value.occurrence.clientOriginAtMs,
            0,
            Number.MAX_SAFE_INTEGER,
            "occurrence.clientOriginAtMs",
          );
    if (clientOrigin !== null && !clientOrigin.ok) return invalid(clientOrigin.error);
    const source = value.occurrence.source;
    if (source !== undefined && source !== "online" && source !== "offline") {
      return invalid("occurrence.source is unsupported.");
    }
    if (value.type === "set-pitch-orientation") {
      if (value.pitchOrientation !== "side-a-left" && value.pitchOrientation !== "side-b-left") {
        return invalid("pitchOrientation is unsupported.");
      }
      return {
        ok: true,
        value: {
          version: LIVE_EVENT_CONTROL_INTENT_VERSION,
          type: value.type,
          operationId: operationId.value,
          factId: presentationChangeId.value,
          presentationChangeId: presentationChangeId.value,
          gameTimeMs: gameTimeMs.value,
          pitchOrientation: value.pitchOrientation,
          occurrence: {
            clientOriginAtMs: clientOrigin === null ? null : clientOrigin.value,
            ...(source === undefined ? {} : { source }),
          },
        },
      } as { ok: true; value: LiveEventControllerIntent };
    }
    const gameSideId = validateOpaqueIdentifier(value.gameSideId, "gameSideId");
    if (!gameSideId.ok) return invalid(gameSideId.error);
    if (!isValidHexColor(value.color)) return invalid("color is invalid.");
    return {
      ok: true,
      value: {
        version: LIVE_EVENT_CONTROL_INTENT_VERSION,
        type: value.type,
        operationId: operationId.value,
        factId: presentationChangeId.value,
        presentationChangeId: presentationChangeId.value,
        gameTimeMs: gameTimeMs.value,
        gameSideId: gameSideId.value,
        color: value.color.trim().startsWith("#")
          ? value.color.trim().toUpperCase()
          : `#${value.color.trim().toUpperCase()}`,
        occurrence: {
          clientOriginAtMs: clientOrigin === null ? null : clientOrigin.value,
          ...(source === undefined ? {} : { source }),
        },
      },
    } as { ok: true; value: LiveEventControllerIntent };
  }
  const factId = validateOpaqueIdentifier(value.factId, "factId");
  if (!factId.ok) return invalid(factId.error);

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
  if (requiresGameSide || value.type === "record-card") {
    const parsedSide = validateOpaqueIdentifier(value.gameSideId, "gameSideId");
    if (!parsedSide.ok) return invalid(parsedSide.error);
    gameSideId = parsedSide.value;
  }
  let playerNumber: number | null | undefined;
  let cardType: LiveCardType | undefined;
  let foulBeforeScore: boolean | undefined;
  let seekerPenalty: "head-referee-confirmed" | undefined;
  if (value.type === "record-card") {
    if (
      value.cardType !== "blue" &&
      value.cardType !== "yellow" &&
      value.cardType !== "red" &&
      value.cardType !== "ejection"
    ) {
      return invalid("cardType is unsupported.");
    }
    if (value.playerNumber !== null && value.playerNumber !== undefined) {
      if (
        typeof value.playerNumber !== "number" ||
        !Number.isSafeInteger(value.playerNumber) ||
        value.playerNumber < 0 ||
        value.playerNumber > 99
      ) {
        return invalid("playerNumber is invalid.");
      }
      playerNumber = value.playerNumber;
    } else {
      playerNumber = null;
    }
    if (value.foulBeforeScore !== undefined && typeof value.foulBeforeScore !== "boolean") {
      return invalid("foulBeforeScore must be a boolean.");
    }
    if (value.seekerPenalty !== undefined && value.seekerPenalty !== "head-referee-confirmed") {
      return invalid("seekerPenalty requires Head Referee confirmation.");
    }
    cardType = value.cardType;
    foulBeforeScore =
      value.cardType === "blue" || value.cardType === "yellow" ? value.foulBeforeScore : undefined;
    seekerPenalty = value.seekerPenalty;
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
  let targetCardFactId: string | undefined;
  let reason: LivePenaltyReason | undefined;
  if (value.type === "record-penalty-reason") {
    const target = validateOpaqueIdentifier(value.targetCardFactId, "targetCardFactId");
    if (!target.ok) return invalid(target.error);
    if (!(LIVE_PENALTY_REASONS as readonly string[]).includes(value.reason as string)) {
      return invalid("reason is unsupported.");
    }
    targetCardFactId = target.value;
    reason = value.reason as LivePenaltyReason;
  }
  let pendingId: string | undefined;
  let scoreFactId: string | undefined;
  let playerKey: string | undefined;
  if (value.type === "resolve-penalty-expiration") {
    const pending = validateOpaqueIdentifier(value.pendingId, "pendingId");
    const scoreFact = validateOpaqueIdentifier(value.scoreFactId, "scoreFactId");
    const player = validateOpaqueIdentifier(value.playerKey, "playerKey");
    if (!pending.ok) return invalid(pending.error);
    if (!scoreFact.ok) return invalid(scoreFact.error);
    if (!player.ok) return invalid(player.error);
    pendingId = pending.value;
    scoreFactId = scoreFact.value;
    playerKey = player.value;
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
  let heatTriggerId: string | undefined;
  if (value.heatTriggerId !== undefined) {
    const parsedTriggerId = validateOpaqueIdentifier(value.heatTriggerId, "heatTriggerId");
    if (!parsedTriggerId.ok) return invalid(parsedTriggerId.error);
    heatTriggerId = parsedTriggerId.value;
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
  let penaltyCardType: "blue" | "yellow" | "red" | "ejection" | undefined;
  let penaltyPlayerKey: string | undefined;
  let heatAction: LiveHeatAction | undefined;
  let timeoutAction: "stoppage" | "start" | "complete" | undefined;
  let timeoutGameSideId: string | undefined;
  let suspensionAction: "start" | "resume" | undefined;
  let suspensionSnapshot: LiveSuspensionSnapshot | undefined;
  let resumesSuspensionFactId: string | undefined;
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
    if (trigger === "card") {
      if (
        value.penaltyCardType !== undefined &&
        value.penaltyCardType !== "blue" &&
        value.penaltyCardType !== "yellow" &&
        value.penaltyCardType !== "red" &&
        value.penaltyCardType !== "ejection"
      ) {
        return invalid("penaltyCardType is unsupported.");
      }
      penaltyCardType = value.penaltyCardType;
      if (value.penaltyPlayerKey !== undefined) {
        const playerKey = validateOpaqueIdentifier(value.penaltyPlayerKey, "penaltyPlayerKey");
        if (!playerKey.ok) return invalid(playerKey.error);
        penaltyPlayerKey = playerKey.value;
      }
    }
    if (trigger === "heat-stoppage") {
      if (value.heatAction === undefined) {
        return invalid("heatAction is required for Heat Stoppage operations.");
      }
      if (!isLiveHeatAction(value.heatAction)) {
        return invalid("heatAction is unsupported.");
      }
      heatAction = value.heatAction;
    }
    if (trigger === "timeout") {
      if (
        value.timeoutAction !== "stoppage" &&
        value.timeoutAction !== "start" &&
        value.timeoutAction !== "complete"
      ) {
        return invalid("timeoutAction is unsupported.");
      }
      timeoutAction = value.timeoutAction;
      const parsedSide = validateOpaqueIdentifier(value.timeoutGameSideId, "timeoutGameSideId");
      if (!parsedSide.ok) return invalid(parsedSide.error);
      timeoutGameSideId = parsedSide.value;
    }
    if (trigger === "suspension") {
      if (value.suspensionAction !== "start" && value.suspensionAction !== "resume") {
        return invalid("suspensionAction is unsupported.");
      }
      suspensionAction = value.suspensionAction;
      if (suspensionAction === "start" && value.suspensionSnapshot === undefined) {
        return invalid("suspensionSnapshot is required when suspending.");
      }
      if (value.suspensionSnapshot !== undefined) {
        const parsedSnapshot = parseLiveSuspensionSnapshot(value.suspensionSnapshot);
        if (!parsedSnapshot.ok) return invalid(parsedSnapshot.error);
        suspensionSnapshot = parsedSnapshot.value;
      }
      if (value.resumesSuspensionFactId !== undefined) {
        const parsedFact = validateOpaqueIdentifier(
          value.resumesSuspensionFactId,
          "resumesSuspensionFactId",
        );
        if (!parsedFact.ok) return invalid(parsedFact.error);
        resumesSuspensionFactId = parsedFact.value;
      }
      if (suspensionAction === "resume" && resumesSuspensionFactId === undefined) {
        return invalid("resumesSuspensionFactId is required when resuming.");
      }
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
      ...(playerNumber === undefined ? {} : { playerNumber }),
      ...(cardType === undefined
        ? {}
        : { cardType: cardType as Exclude<LiveCardType, "ejection"> }),
      ...(foulBeforeScore === undefined ? {} : { foulBeforeScore }),
      ...(seekerPenalty === undefined ? {} : { seekerPenalty }),
      ...(targetCardFactId === undefined ? {} : { targetCardFactId }),
      ...(reason === undefined ? {} : { reason }),
      ...(pendingId === undefined ? {} : { pendingId }),
      ...(scoreFactId === undefined ? {} : { scoreFactId }),
      ...(playerKey === undefined ? {} : { playerKey }),
      ...(running === undefined ? {} : { running }),
      ...(adjustmentMs === undefined ? {} : { adjustmentMs }),
      ...(clockTimeMs === undefined ? {} : { clockTimeMs }),
      ...(authorityGeneration === undefined ? {} : { authorityGeneration }),
      ...(confirmation === undefined ? {} : { confirmation }),
      ...(clockGeneration === undefined ? {} : { clockGeneration }),
      ...(heatTriggerId === undefined ? {} : { heatTriggerId }),
      ...(trigger === undefined ? {} : { trigger }),
      ...(penaltyCardType === undefined ? {} : { penaltyCardType }),
      ...(penaltyPlayerKey === undefined ? {} : { penaltyPlayerKey }),
      ...(heatAction === undefined ? {} : { heatAction }),
      ...(timeoutAction === undefined ? {} : { timeoutAction }),
      ...(timeoutGameSideId === undefined ? {} : { timeoutGameSideId }),
      ...(suspensionAction === undefined ? {} : { suspensionAction }),
      ...(suspensionSnapshot === undefined ? {} : { suspensionSnapshot }),
      ...(resumesSuspensionFactId === undefined ? {} : { resumesSuspensionFactId }),
      ...(overrideResult.value === undefined ? {} : { override: overrideResult.value }),
    } as LiveEventControllerIntent,
  };
}

export const parseLiveEventControllerSubmission = parseLiveEventControllerIntent;

export function explainLiveEventGuardrail(intent: {
  type: LiveEventControllerIntent["type"];
  trigger?: Extract<LiveEventControllerIntent, { type: "substantive" }>["trigger"];
  heatAction?: LiveHeatAction;
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
  if (
    intent.type === "substantive" &&
    intent.trigger === "heat-stoppage" &&
    (intent.heatAction === "enable" || intent.heatAction === "disable")
  ) {
    return {
      guardrail: "heat-stoppage-mode-change",
      normalBehavior: "Heat Stoppage Mode is fixed at Game Commencement.",
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

function parseLiveSuspensionSnapshot(
  value: unknown,
): { ok: true; value: LiveSuspensionSnapshot } | { ok: false; error: string } {
  if (!isRecord(value)) return invalid("suspensionSnapshot must be an object.");
  const allowedKeys = new Set([
    "version",
    "gameTimeMs",
    "scoreByGameSide",
    "penalties",
    "volleyballPossession",
    "dodgeballPossession",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return invalid("suspensionSnapshot contains unsupported fields.");
  }
  if (value.version !== LIVE_SUSPENSION_SNAPSHOT_VERSION) {
    return invalid("suspensionSnapshot version is unsupported.");
  }
  const gameTimeMs = validateGameClock(value.gameTimeMs);
  if (!gameTimeMs.ok) return invalid(gameTimeMs.error);
  if (!isRecord(value.scoreByGameSide)) {
    return invalid("suspensionSnapshot.scoreByGameSide must be an object.");
  }
  const scoreByGameSide: Record<string, number> = {};
  for (const [gameSideId, score] of Object.entries(value.scoreByGameSide)) {
    if (!validateOpaqueIdentifier(gameSideId, "suspensionSnapshot.gameSideId").ok) {
      return invalid("suspensionSnapshot.gameSideId is invalid.");
    }
    const parsedScore = validateIntegerInRange(
      score,
      0,
      SHARED_LIMITS.score.max,
      "suspensionSnapshot.score",
    );
    if (!parsedScore.ok) return invalid(parsedScore.error);
    scoreByGameSide[gameSideId] = parsedScore.value;
  }
  const penalties = parseLiveSuspensionPenaltyState(value.penalties);
  if (!penalties.ok) return penalties;
  const volleyballPossession = parsePossessionValue(
    value.volleyballPossession,
    "suspensionSnapshot.volleyballPossession",
  );
  if (!volleyballPossession.ok || volleyballPossession.value === null) {
    return invalid("suspensionSnapshot.volleyballPossession must be confirmed.");
  }
  const rawDodgeballPossession = value.dodgeballPossession;
  if (!isRecord(rawDodgeballPossession)) {
    return invalid("suspensionSnapshot.dodgeballPossession must be an object.");
  }
  if (Object.keys(rawDodgeballPossession).length === 0) {
    return invalid("suspensionSnapshot.dodgeballPossession must list every dodgeball.");
  }
  const dodgeballPossession: Record<string, string | null> = {};
  for (const [ballId, possession] of Object.entries(rawDodgeballPossession)) {
    if (!validateOpaqueIdentifier(ballId, "suspensionSnapshot.dodgeballId").ok) {
      return invalid("suspensionSnapshot.dodgeballId is invalid.");
    }
    const parsedPossession = parsePossessionValue(
      possession,
      "suspensionSnapshot.dodgeballPossession",
    );
    if (!parsedPossession.ok) return parsedPossession;
    dodgeballPossession[ballId] = parsedPossession.value;
  }
  return {
    ok: true,
    value: {
      version: LIVE_SUSPENSION_SNAPSHOT_VERSION,
      gameTimeMs: gameTimeMs.value,
      scoreByGameSide,
      penalties: penalties.value,
      volleyballPossession: volleyballPossession.value,
      dodgeballPossession,
    },
  };
}

function parseLiveSuspensionPenaltyState(
  value: unknown,
): { ok: true; value: LiveSuspensionPenaltyState } | { ok: false; error: string } {
  if (!isRecord(value)) return invalid("suspensionSnapshot.penalties must be an object.");
  if (Object.keys(value).some((key) => key !== "segments") || !Array.isArray(value.segments)) {
    return invalid("suspensionSnapshot.penalties.segments must be an array.");
  }
  const segments: LiveSuspensionPenaltyState["segments"][number][] = [];
  const sourceFactIds = new Set<string>();
  for (const segment of value.segments) {
    if (
      !isRecord(segment) ||
      Object.keys(segment).some(
        (key) =>
          ![
            "sourceFactId",
            "elapsedMs",
            "remainingMs",
            "expirableByScore",
            "cardFactId",
            "cardType",
            "gameSideId",
            "playerKey",
            "playerNumber",
            "eligibleForScoreAtGameTimeMs",
            "notBeforeGameTimeMs",
            "startsAtGameTimeMs",
            "endsAtGameTimeMs",
          ].includes(key),
      )
    ) {
      return invalid("suspensionSnapshot.penalties segment is invalid.");
    }
    const sourceFactId = validateOpaqueIdentifier(
      segment.sourceFactId,
      "suspensionSnapshot.penalties.sourceFactId",
    );
    const elapsedMs = validateIntegerInRange(
      segment.elapsedMs,
      0,
      PENALTY_DURATION_MS,
      "suspensionSnapshot.penalties.elapsedMs",
    );
    const remainingMs = validateIntegerInRange(
      segment.remainingMs,
      1,
      PENALTY_DURATION_MS,
      "suspensionSnapshot.penalties.remainingMs",
    );
    if (!sourceFactId.ok) return sourceFactId;
    if (!elapsedMs.ok) return elapsedMs;
    if (!remainingMs.ok) return remainingMs;
    if (typeof segment.expirableByScore !== "boolean") {
      return invalid("suspensionSnapshot.penalties.expirableByScore is required.");
    }
    if (sourceFactIds.has(sourceFactId.value)) {
      return invalid("suspensionSnapshot.penalties must list each penalty once.");
    }
    if (elapsedMs.value + remainingMs.value !== PENALTY_DURATION_MS) {
      return invalid("suspensionSnapshot.penalties elapsed and remaining time must agree.");
    }
    const optionalIdentifier = (field: string): string | undefined => {
      if (segment[field] === undefined) return undefined;
      const parsed = validateOpaqueIdentifier(segment[field], field);
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.value;
    };
    const cardType = segment.cardType;
    if (
      cardType !== undefined &&
      cardType !== "blue" &&
      cardType !== "yellow" &&
      cardType !== "red"
    ) {
      return invalid("suspensionSnapshot.penalties.cardType is invalid.");
    }
    const playerNumber = segment.playerNumber;
    if (
      playerNumber !== undefined &&
      playerNumber !== null &&
      !validateIntegerInRange(playerNumber, 0, 99, "suspensionSnapshot.penalties.playerNumber").ok
    ) {
      return invalid("suspensionSnapshot.penalties.playerNumber is invalid.");
    }
    const optionalTime = (field: string): number | undefined => {
      if (segment[field] === undefined) return undefined;
      const parsed = validateIntegerInRange(
        segment[field],
        0,
        SHARED_LIMITS.clock.maxMs,
        `suspensionSnapshot.penalties.${field}`,
      );
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.value;
    };
    sourceFactIds.add(sourceFactId.value);
    segments.push({
      sourceFactId: sourceFactId.value,
      elapsedMs: elapsedMs.value,
      remainingMs: remainingMs.value,
      expirableByScore: segment.expirableByScore,
      ...(optionalIdentifier("cardFactId") === undefined
        ? {}
        : { cardFactId: optionalIdentifier("cardFactId") }),
      ...(cardType === undefined
        ? {}
        : { cardType: cardType as Exclude<LiveCardType, "ejection"> }),
      ...(optionalIdentifier("gameSideId") === undefined
        ? {}
        : { gameSideId: optionalIdentifier("gameSideId") }),
      ...(optionalIdentifier("playerKey") === undefined
        ? {}
        : { playerKey: optionalIdentifier("playerKey") }),
      ...(playerNumber === undefined ? {} : { playerNumber }),
      ...(optionalTime("eligibleForScoreAtGameTimeMs") === undefined
        ? {}
        : { eligibleForScoreAtGameTimeMs: optionalTime("eligibleForScoreAtGameTimeMs") }),
      ...(optionalTime("notBeforeGameTimeMs") === undefined
        ? {}
        : { notBeforeGameTimeMs: optionalTime("notBeforeGameTimeMs") }),
      ...(optionalTime("startsAtGameTimeMs") === undefined
        ? {}
        : { startsAtGameTimeMs: optionalTime("startsAtGameTimeMs") }),
      ...(optionalTime("endsAtGameTimeMs") === undefined
        ? {}
        : { endsAtGameTimeMs: optionalTime("endsAtGameTimeMs") }),
    } as LiveSuspensionPenaltyState["segments"][number]);
  }
  return { ok: true, value: { segments } };
}

function parsePossessionValue(
  value: unknown,
  label: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  const parsed = validateOpaqueIdentifier(value, label);
  return parsed.ok ? parsed : invalid(parsed.error);
}

export function createLiveEventGameControl(options: LiveEventGameControlOptions) {
  const clock = options.clock ?? (() => Date.now());
  const configuredDodgeballIdsFor = (eventGameId: string) =>
    normalizeConfiguredDodgeballIds(options.knownDodgeballIdsForEventGame?.(eventGameId));
  const gameFactCodec = createDefaultControlActionCodecs().find(
    (codec) => codec.kind === "game-fact" && codec.version === "1",
  );
  if (gameFactCodec === undefined) {
    throw new Error("The game-fact runtime codec is unavailable.");
  }
  const gameFactCodecKind = gameFactCodec.kind;
  const gameFactCodecVersion = gameFactCodec.version;
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

  async function lockEventGameIfDue(eventGameId: string): Promise<boolean> {
    try {
      if (options.lockEventGame === undefined) return false;
      const owner = await options.resolveEventGameRecord(eventGameId);
      if (owner === null) return false;
      const root = await owner.record.readRoot(owner.recordId);
      if (
        root === null ||
        root.lifecycle.phase !== "finished" ||
        root.lifecycle.finishedAtMs === null ||
        root.lifecycle.lockedAtMs !== null
      )
        return false;
      const metadata = await owner.record.readMetadata();
      const lastAcceptedAtMs = metadata?.lastAcceptedAtMs;
      const nowMs = clock();
      if (
        lastAcceptedAtMs === null ||
        lastAcceptedAtMs === undefined ||
        !Number.isSafeInteger(lastAcceptedAtMs) ||
        !Number.isSafeInteger(nowMs) ||
        nowMs < 0 ||
        nowMs < lastAcceptedAtMs + EVENT_GAME_LOCK_DELAY_MS
      )
        return false;
      const result = await options.lockEventGame(eventGameId, nowMs);
      if (result.status !== "locked") return false;
      for (const [sessionBearer, session] of activeControllerSessions) {
        if (session.eventGameId === eventGameId) activeControllerSessions.delete(sessionBearer);
      }
      return true;
    } catch {
      return false;
    }
  }

  async function reconcileEventGameLocks(): Promise<number> {
    if (closed) return 0;
    let roots: readonly EventGameRecordRoot[];
    try {
      roots = await options.listEventGameRoots();
    } catch {
      return 0;
    }
    let lockedCount = 0;
    for (const root of roots) {
      if (await lockEventGameIfDue(root.eventGameId)) lockedCount += 1;
    }
    return lockedCount;
  }

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
    await reconcileEventGameLocks();
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
    const commenced = await ensureClockCommencement(owner, root, {
      sessionBearer: admitted.sessionBearer,
      sessionId: authorized.grantSessionId,
      grantVersion: authorized.grantVersion,
    });
    if (commenced.status === "rejected") {
      return rejectedOpen();
    }

    const materialized = await materializeExpiredTimeout(owner, commenced.root, {
      sessionBearer: admitted.sessionBearer,
      grantSessionId: authorized.grantSessionId,
      grantVersion: authorized.grantVersion,
    });
    if (materialized.status === "failed") return rejectedOpen();
    const materializedRoot = materialized.root;
    const projection = await readProjection(owner.record, materializedRoot);
    trackActiveControllerSession(
      admitted.sessionBearer,
      materializedRoot.eventGameId,
      authorized.sessionExpiresAtMs,
    );
    return {
      status: "opened",
      eventGameId: materializedRoot.eventGameId,
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
    deferTimeoutMaterialization?: boolean;
  }): Promise<ControllerRefreshResult> {
    await lockEventGameIfDue(input.eventGameId);
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
        const commenced = await ensureClockCommencement(previousOwner, previousRoot, {
          sessionBearer: input.sessionBearer,
          sessionId: authorized.grantSessionId,
          grantVersion: authorized.grantVersion,
        });
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
              const materialized = input.deferTimeoutMaterialization
                ? { status: "ready" as const, root }
                : await materializeExpiredTimeout(owner, root, {
                    sessionBearer: input.sessionBearer,
                    grantSessionId: pinned.grantSessionId,
                    grantVersion: pinned.grantVersion,
                  });
              if (materialized.status === "failed") {
                return { status: "rejected", message: "Unable to refresh Controller session." };
              }
              const materializedRoot = materialized.root;
              const projection = await readProjection(owner.record, materializedRoot);
              trackActiveControllerSession(
                input.sessionBearer,
                materializedRoot.eventGameId,
                pinned.sessionExpiresAtMs,
              );
              return {
                status: "authorized",
                session: {
                  eventGameId: materializedRoot.eventGameId,
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
    const commenced = await ensureClockCommencement(owner, root, {
      sessionBearer: input.sessionBearer,
      sessionId: authorized.grantSessionId,
      grantVersion: authorized.grantVersion,
    });
    if (commenced.status === "rejected") {
      return { status: "rejected", message: "Unable to refresh Controller session." };
    }
    const materialized = input.deferTimeoutMaterialization
      ? { status: "ready" as const, root: commenced.root }
      : await materializeExpiredTimeout(owner, commenced.root, {
          sessionBearer: input.sessionBearer,
          grantSessionId: authorized.grantSessionId,
          grantVersion: authorized.grantVersion,
        });
    if (materialized.status === "failed") {
      return { status: "rejected", message: "Unable to refresh Controller session." };
    }
    const materializedRoot = materialized.root;
    const projection = await readProjection(owner.record, materializedRoot);
    trackActiveControllerSession(
      input.sessionBearer,
      materializedRoot.eventGameId,
      authorized.sessionExpiresAtMs,
    );
    return {
      status: "authorized",
      session: {
        eventGameId: materializedRoot.eventGameId,
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
    await reconcileEventGameLocks();
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
    const commenced = await ensureClockCommencement(owner, root, {
      sessionBearer: input.sessionBearer,
      sessionId: switched.grantSessionId,
      grantVersion: switched.grantVersion,
    });
    if (commenced.status === "rejected") {
      return { status: "rejected", message: "Unable to refresh Controller session." };
    }
    const materialized = await materializeExpiredTimeout(owner, commenced.root, {
      sessionBearer: input.sessionBearer,
      grantSessionId: switched.grantSessionId,
      grantVersion: switched.grantVersion,
    });
    if (materialized.status === "failed") {
      return { status: "rejected", message: "Unable to refresh Controller session." };
    }
    const materializedRoot = materialized.root;
    const projection = await readProjection(owner.record, materializedRoot);
    trackActiveControllerSession(
      input.sessionBearer,
      materializedRoot.eventGameId,
      switched.sessionExpiresAtMs,
    );
    return {
      status: "authorized",
      session: {
        eventGameId: materializedRoot.eventGameId,
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
    await lockEventGameIfDue(input.eventGameId);
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
    const commenced = await ensureClockCommencement(owner, root, {
      sessionBearer: input.sessionBearer,
      sessionId: authorized.grantSessionId,
      grantVersion: authorized.grantVersion,
    });
    if (commenced.status === "rejected") {
      return { status: "rejected", message: "Unable to refresh Controller session." };
    }
    const materialized = await materializeExpiredTimeout(owner, commenced.root, {
      sessionBearer: input.sessionBearer,
      grantSessionId: authorized.grantSessionId,
      grantVersion: authorized.grantVersion,
    });
    if (materialized.status === "failed") {
      return { status: "rejected", message: "Unable to refresh Controller session." };
    }
    const materializedRoot = materialized.root;
    const projection = await readProjection(owner.record, materializedRoot);
    trackActiveControllerSession(
      input.sessionBearer,
      materializedRoot.eventGameId,
      authorized.sessionExpiresAtMs,
    );
    return {
      status: "authorized",
      session: {
        eventGameId: materializedRoot.eventGameId,
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
    await lockEventGameIfDue(input.eventGameId);
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

  async function discardLockedReplay(input: {
    sessionBearer: string;
    eventGameId: string;
    expectedGrantSessionId: string;
    capabilityEvidence: string;
    actions: readonly { eventGameId: string; intent: unknown }[];
    context: Omit<ControllerReplayResult, "status" | "outcomes" | "projection">;
  }): Promise<ControllerReplayResult | null> {
    if (options.lockedReplayCapability === undefined) return null;
    const owner = await options.resolveEventGameRecord(input.eventGameId);
    const root = owner === null ? null : await owner.record.readRoot(owner.recordId);
    if (owner === null || root === null || root.lifecycle.lockedAtMs === null) return null;
    if (
      input.actions.length === 0 ||
      input.actions.length > SHARED_LIMITS.replay.maxControlActions ||
      input.actions.some((candidate) => candidate.eventGameId !== input.eventGameId)
    )
      return null;
    const parsed = input.actions.map((candidate) =>
      parseLiveEventControllerIntent(candidate.intent),
    );
    if (parsed.some((candidate) => !candidate.ok)) return null;
    const actionIds = parsed.map((candidate) => (candidate.ok ? candidate.value.operationId : ""));
    if (new Set(actionIds).size !== actionIds.length || actionIds.some((id) => id === ""))
      return null;
    const actions = parsed.map((candidate) => {
      if (!candidate.ok) throw new Error("Locked replay intent is invalid.");
      if (!("factId" in candidate.value))
        throw new Error("Presentation changes are not locked actions.");
      return {
        recordId: root.recordId,
        eventGameId: root.eventGameId,
        operationId: candidate.value.operationId,
        kind: { id: "game-fact", version: "1" },
        payload: {
          factId: candidate.value.factId,
          factType: "locked-replay-discard",
          gameSideId: null,
          gameTimeMs: 0,
          data: null,
        },
        causalPredecessorIds: [],
        occurrence: {
          trustedAtMs: root.lifecycle.lockedAtMs ?? clock(),
          clientOriginAtMs: candidate.value.occurrence.clientOriginAtMs,
          source: "offline",
        },
        grant: {
          sessionId: input.expectedGrantSessionId,
          versionId: input.context.session.grantVersion,
        },
        lifecycle: structuredClone(root.lifecycle),
      };
    });
    try {
      const accepted = await options.acceptance.submitBatch({
        mode: "replay",
        recordId: root.recordId,
        eventGameId: root.eventGameId,
        replay: {
          sessionBearer: input.sessionBearer,
          originatingSessionId: input.expectedGrantSessionId,
          replayEvidenceId: input.capabilityEvidence,
        },
        actions,
      });
      const discarded = accepted.results.find((result) => result.status === "locked-discarded");
      if (discarded?.status !== "locked-discarded") return null;
      return {
        ...input.context,
        status: "synchronized",
        outcomes: actionIds.map((operationId) => ({
          operationId,
          status: "locked-discarded" as const,
          detail: `${discarded.count} queued Controller action(s) were discarded after Game Lock.`,
        })),
        projection: null,
        discardedCount: discarded.count,
      };
    } catch {
      return null;
    }
  }

  async function submitControllerIntent(input: {
    sessionBearer: string;
    eventGameId: string;
    intent: unknown;
    causalPredecessorIds?: readonly string[];
    replay?: {
      sessionBearer: string;
      originatingSessionId: string;
      replayEvidenceId: string;
      reserveOnly?: boolean;
    };
    deferTimeoutMaterialization?: boolean;
  }): Promise<LiveEventGameControlResult> {
    await lockEventGameIfDue(input.eventGameId);
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
    if (isGamePresentationIntentValue(parsed.value))
      return rejectedAction(parsed.value.operationId);

    const owner = await options.resolveEventGameRecord(authorized.eventGameId);
    const root = owner === null ? null : await owner.record.readRoot(owner.recordId);
    if (owner === null || root === null) {
      return rejectedAction(parsed.value.operationId);
    }
    const commenced = await ensureClockCommencement(owner, root, {
      sessionBearer: input.sessionBearer,
      sessionId: authorized.grantSessionId,
      grantVersion: authorized.grantVersion,
    });
    if (commenced.status === "rejected") return retryableAction(parsed.value.operationId);
    const materialized = input.deferTimeoutMaterialization
      ? { status: "ready" as const, root: commenced.root }
      : await materializeExpiredTimeout(owner, commenced.root, {
          sessionBearer: input.sessionBearer,
          grantSessionId: authorized.grantSessionId,
          grantVersion: authorized.grantVersion,
        });
    if (materialized.status === "failed") return retryableAction(parsed.value.operationId);
    const activeRoot = materialized.root;

    if (
      parsed.value.type === "record-goal" ||
      parsed.value.type === "record-card" ||
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
    const nowMs = clock();
    const stateWithFrozenMode = rebuildLiveDerivedState(
      activeRoot,
      actionsBefore,
      nowMs,
      false,
      nowMs,
    );
    if (stateWithFrozenMode === null) {
      return retryableAction(parsed.value.operationId);
    }
    let configuredHeatMode: boolean;
    try {
      const reserveNonHeatReplay =
        input.replay?.reserveOnly === true &&
        !(parsed.value.type === "substantive" && parsed.value.trigger === "heat-stoppage");
      configuredHeatMode = reserveNonHeatReplay
        ? false
        : await readConfiguredHeatMode(activeRoot, stateWithFrozenMode.gameFacts);
    } catch {
      return retryableAction(parsed.value.operationId);
    }
    const effectiveStateBefore =
      configuredHeatMode === false
        ? stateWithFrozenMode
        : rebuildLiveDerivedState(activeRoot, actionsBefore, nowMs, true, nowMs);
    if (effectiveStateBefore === null) {
      return retryableAction(parsed.value.operationId);
    }
    if (
      effectiveStateBefore.phase === "finished" &&
      existingAction === undefined &&
      parsed.value.type !== "correct-fact" &&
      !allowsLatePreCatchGoal(parsed.value, effectiveStateBefore) &&
      input.replay?.reserveOnly !== true
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
    const previousClockStartMs = latestRunningClockStart(effectiveStateBefore.gameFacts);
    const clockAuthorityActionsBefore = readClockAuthorityActions(actionsBefore);
    const clockBefore = projectClockBaseline(
      deriveClockAuthority(clockAuthorityActionsBefore),
      nowMs,
    );
    const releaseScoreFactId =
      parsed.value.type === "resolve-penalty-expiration" ? parsed.value.scoreFactId : null;
    const releaseSourceFact =
      releaseScoreFactId === null
        ? undefined
        : effectiveStateBefore.gameFacts.find(
            (fact) =>
              fact.factId === releaseScoreFactId && fact.factType === "goal" && fact.effective,
          );
    const releaseSourceGameTimeMs =
      releaseSourceFact?.gameTimeMs ?? releaseSourceFact?.sportingOrder;
    const factGameTimeMs =
      parsed.value.type === "resolve-penalty-expiration" && releaseSourceGameTimeMs !== undefined
        ? releaseSourceGameTimeMs
        : (parsed.value.type === "record-goal" || parsed.value.type === "record-card") &&
            parsed.value.occurrence.source !== "offline" &&
            parsed.value.gameTimeMs === 0 &&
            clockAuthorityActionsBefore.length > 0
          ? clockBefore.gameTimeMs
          : parsed.value.gameTimeMs;
    const clockData = readClockIntentData(parsed.value, clockBefore, nowMs);
    if (clockData.status === "rejected") {
      return rejectedAction(parsed.value.operationId);
    }
    let suspensionSnapshot: LiveSuspensionSnapshot | undefined;
    if (
      parsed.value.type === "substantive" &&
      parsed.value.trigger === "suspension" &&
      parsed.value.suspensionAction === "start" &&
      parsed.value.suspensionSnapshot !== undefined
    ) {
      const canonicalSnapshot = canonicalizeLiveSuspensionSnapshot(
        parsed.value.suspensionSnapshot,
        effectiveStateBefore,
        nowMs,
        configuredDodgeballIdsFor(activeRoot.eventGameId),
      );
      if (!canonicalSnapshot.ok) return rejectedAction(parsed.value.operationId);
      suspensionSnapshot = canonicalSnapshot.value;
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
    const derivedPenaltyStart =
      parsed.value.type === "record-card"
        ? deriveControllerPenaltyStart(activeRoot, factGameTimeMs, parsed.value.seekerPenalty)
        : undefined;
    const gameSideId =
      parsed.value.type === "record-card"
        ? parsed.value.gameSideId
        : parsed.value.type === "substantive" && parsed.value.trigger === "timeout"
          ? (parsed.value.timeoutGameSideId ?? controllerGameSideId(parsed.value))
          : controllerGameSideId(parsed.value);
    const isCorrection = parsed.value.type === "correct-fact";
    let override: OfficialOverrideMetadata | undefined;
    try {
      override = buildLiveOfficialOverride(parsed.value, authorized.grantSessionId);
    } catch {
      return rejectedAction(parsed.value.operationId);
    }

    const causalPredecessorIds = new Set(input.causalPredecessorIds ?? []);
    const requiredPredecessorFactId =
      parsed.value.type === "substantive" &&
      parsed.value.trigger === "timeout" &&
      parsed.value.timeoutAction === "start"
        ? effectiveStateBefore.timeout.factId
        : parsed.value.type === "substantive" &&
            parsed.value.trigger === "suspension" &&
            parsed.value.suspensionAction === "resume"
          ? effectiveStateBefore.suspension.factId
          : null;
    if (requiredPredecessorFactId !== null) {
      const predecessor = actionsBefore.find(
        ({ action: storedAction }) =>
          storedAction.interpretation.type === "fact" &&
          storedAction.interpretation.factId === requiredPredecessorFactId,
      );
      if (predecessor !== undefined) causalPredecessorIds.add(predecessor.action.operationId);
    }

    const heatAction =
      parsed.value.type === "substantive" && parsed.value.trigger === "heat-stoppage"
        ? parsed.value.heatAction
        : undefined;
    const resolvesHeatTrigger =
      heatAction === "start" ||
      heatAction === "end-of-drive" ||
      heatAction === "dead-volleyball" ||
      heatAction === "other-stoppage" ||
      heatAction === "skip-required" ||
      heatAction === "skip" ||
      heatAction === "suppress";
    const requiresHeatTrigger =
      heatAction !== undefined && heatAction !== "enable" && heatAction !== "disable";
    const activeHeatTriggerId =
      heatAction === "extend-permitted"
        ? effectiveStateBefore.heat.permittedExtensionTriggerId
        : heatAction === "extend"
          ? (effectiveStateBefore.heat.activeTriggerId ?? null)
          : heatAction === "end"
            ? (effectiveStateBefore.heat.activeTriggerId ?? null)
            : null;
    const requestedHeatTriggerId =
      parsed.value.heatTriggerId ??
      (resolvesHeatTrigger &&
      effectiveStateBefore.heat.pendingTriggerId !== null &&
      effectiveStateBefore.heat.pendingTriggerGameTimeMs === parsed.value.gameTimeMs
        ? effectiveStateBefore.heat.pendingTriggerId
        : activeHeatTriggerId);
    const enforceHeatAdmission = hasHeatStoppageConfiguration() || requestedHeatTriggerId === null;
    if (
      enforceHeatAdmission &&
      requiresHeatTrigger &&
      (effectiveStateBefore.heat.mode !== "enabled" ||
        requestedHeatTriggerId === null ||
        (resolvesHeatTrigger &&
          (requestedHeatTriggerId !== effectiveStateBefore.heat.pendingTriggerId ||
            effectiveStateBefore.heat.pendingTriggerGameTimeMs !== parsed.value.gameTimeMs)) ||
        (heatAction === "end" &&
          requestedHeatTriggerId !== effectiveStateBefore.heat.activeTriggerId) ||
        (heatAction === "extend" &&
          requestedHeatTriggerId !== effectiveStateBefore.heat.activeTriggerId) ||
        (heatAction === "extend-permitted" &&
          requestedHeatTriggerId !== effectiveStateBefore.heat.permittedExtensionTriggerId))
    ) {
      return rejectedAction(parsed.value.operationId);
    }
    const heatTriggerGameTimeMs =
      requestedHeatTriggerId === effectiveStateBefore.heat.pendingTriggerId
        ? effectiveStateBefore.heat.pendingTriggerGameTimeMs
        : undefined;
    const heatSequence =
      heatAction === undefined
        ? undefined
        : actionsBefore.filter(
            ({ action }) =>
              action.interpretation.type === "fact" &&
              action.interpretation.factType === "heat-stoppage",
          ).length + 1;
    const action = {
      recordId: owner.recordId,
      eventGameId: activeRoot.eventGameId,
      operationId: parsed.value.operationId,
      kind:
        parsed.value.type === "correct-fact"
          ? { id: "correction", version: "1" }
          : { id: gameFactCodecKind, version: gameFactCodecVersion },
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
              gameTimeMs: factGameTimeMs,
              data:
                parsed.value.type === "record-goal"
                  ? {
                      points: 10,
                      sportingOrder: parsed.value.sportingOrder ?? factGameTimeMs,
                      ...(parsed.value.sportingOrderAdjudication === undefined
                        ? {}
                        : { sportingOrderAdjudication: parsed.value.sportingOrderAdjudication }),
                      ...(parsed.value.sportingOrderOverride === undefined
                        ? {}
                        : { sportingOrderOverride: parsed.value.sportingOrderOverride }),
                    }
                  : parsed.value.type === "record-card"
                    ? {
                        cardType: parsed.value.cardType,
                        playerNumber: parsed.value.playerNumber,
                        penaltyStart: derivedPenaltyStart,
                        ...(parsed.value.foulBeforeScore === undefined
                          ? {}
                          : { foulBeforeScore: parsed.value.foulBeforeScore }),
                        ...(parsed.value.seekerPenalty === undefined
                          ? {}
                          : { seekerPenalty: parsed.value.seekerPenalty }),
                        sportingOrder: parsed.value.sportingOrder ?? factGameTimeMs,
                      }
                    : parsed.value.type === "record-penalty-reason"
                      ? {
                          targetCardFactId: parsed.value.targetCardFactId,
                          reason: parsed.value.reason,
                          sportingOrder: parsed.value.sportingOrder ?? parsed.value.gameTimeMs,
                        }
                      : parsed.value.type === "resolve-penalty-expiration"
                        ? {
                            pendingId: parsed.value.pendingId,
                            scoreFactId: parsed.value.scoreFactId,
                            playerKey: parsed.value.playerKey,
                            sportingOrder:
                              releaseSourceFact?.sportingOrder ?? parsed.value.gameTimeMs,
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
                                : {
                                    sportingOrderAdjudication:
                                      parsed.value.sportingOrderAdjudication,
                                  }),
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
                                sportingOrder:
                                  parsed.value.sportingOrder ?? parsed.value.gameTimeMs,
                                ...(parsed.value.sportingOrderAdjudication === undefined
                                  ? {}
                                  : {
                                      sportingOrderAdjudication:
                                        parsed.value.sportingOrderAdjudication,
                                    }),
                              }
                            : clockData.value !== null
                              ? {
                                  ...clockData.value,
                                  sportingOrder:
                                    parsed.value.sportingOrder ?? parsed.value.gameTimeMs,
                                  ...(parsed.value.sportingOrderAdjudication === undefined
                                    ? {}
                                    : {
                                        sportingOrderAdjudication:
                                          parsed.value.sportingOrderAdjudication,
                                      }),
                                }
                              : parsed.value.type === "substantive"
                                ? {
                                    trigger: parsed.value.trigger,
                                    sportingOrder:
                                      parsed.value.sportingOrder ?? parsed.value.gameTimeMs,
                                    ...(parsed.value.sportingOrderAdjudication === undefined
                                      ? {}
                                      : {
                                          sportingOrderAdjudication:
                                            parsed.value.sportingOrderAdjudication,
                                        }),
                                    ...(parsed.value.heatAction === undefined
                                      ? {}
                                      : { heatAction: parsed.value.heatAction }),
                                    ...(heatSequence === undefined ? {} : { heatSequence }),
                                    ...(requestedHeatTriggerId === null ||
                                    requestedHeatTriggerId === undefined
                                      ? {}
                                      : { heatTriggerId: requestedHeatTriggerId }),
                                    ...(heatTriggerGameTimeMs === undefined
                                      ? {}
                                      : { triggerGameTimeMs: heatTriggerGameTimeMs }),
                                    ...((heatAction === "end" || heatAction === "extend") &&
                                    typeof effectiveStateBefore.heat.actualDurationMs === "number"
                                      ? {
                                          actualDurationMs:
                                            effectiveStateBefore.heat.actualDurationMs,
                                        }
                                      : {}),
                                    ...(heatAction === "end" &&
                                    effectiveStateBefore.heat.completedAtAllowed === true &&
                                    override === undefined
                                      ? { completionAtAllowed: true }
                                      : {}),
                                    ...(parsed.value.penaltyCardType === undefined
                                      ? {}
                                      : { penaltyCardType: parsed.value.penaltyCardType }),
                                    ...(parsed.value.penaltyPlayerKey === undefined
                                      ? {}
                                      : { penaltyPlayerKey: parsed.value.penaltyPlayerKey }),
                                    ...(parsed.value.timeoutAction === undefined
                                      ? {}
                                      : { timeoutAction: parsed.value.timeoutAction }),
                                    ...(parsed.value.timeoutGameSideId === undefined
                                      ? {}
                                      : { timeoutGameSideId: parsed.value.timeoutGameSideId }),
                                    ...(parsed.value.suspensionAction === undefined
                                      ? {}
                                      : { suspensionAction: parsed.value.suspensionAction }),
                                    ...(suspensionSnapshot === undefined
                                      ? {}
                                      : { suspensionSnapshot }),
                                    ...(parsed.value.resumesSuspensionFactId === undefined
                                      ? {}
                                      : {
                                          resumesSuspensionFactId:
                                            parsed.value.resumesSuspensionFactId,
                                        }),
                                  }
                                : null,
            },
      causalPredecessorIds: [...causalPredecessorIds],
      occurrence: {
        trustedAtMs:
          parsed.value.occurrence.source === "offline" &&
          parsed.value.occurrence.clientOriginAtMs !== null
            ? parsed.value.occurrence.clientOriginAtMs
            : nowMs,
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
    const hasDirectAutomaticPenaltyConsequence = actionsBefore.some(
      ({ action: storedAction }) =>
        storedAction.interpretation.type === "fact" &&
        storedAction.interpretation.factType === "penalty-release-consequence" &&
        isRecord(storedAction.interpretation.payload) &&
        isRecord(storedAction.interpretation.payload.data) &&
        "factId" in parsed.value &&
        storedAction.interpretation.payload.data.sourceFactId === parsed.value.factId,
    );
    const automaticPenaltyConsequence =
      (hasDirectAutomaticPenaltyConsequence
        ? null
        : buildAutomaticPenaltyConsequence({
            intent: parsed.value,
            factGameTimeMs,
            beforeFacts: effectiveStateBefore.gameFacts,
          })) ?? buildMissingAutomaticPenaltyConsequence(activeRoot, actionsBefore, action);
    const { override: sourceOverride, ...automaticConsequenceBase } = action;
    void sourceOverride;
    const actions =
      automaticPenaltyConsequence === null
        ? [action]
        : [
            action,
            {
              ...automaticConsequenceBase,
              kind: { id: gameFactCodecKind, version: gameFactCodecVersion },
              operationId: automaticPenaltyConsequence.operationId,
              causalPredecessorIds: [
                ...new Set([
                  ...(input.causalPredecessorIds ?? []),
                  action.operationId,
                  automaticPenaltyConsequence.sourceOperationId,
                ]),
              ],
              payload: {
                factId: automaticPenaltyConsequence.factId,
                factType: "penalty-release-consequence",
                gameSideId: automaticPenaltyConsequence.gameSideId,
                gameTimeMs: automaticPenaltyConsequence.gameTimeMs,
                data: automaticPenaltyConsequence.data,
              },
            },
          ];

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

    const heatModeSnapshot = hasHeatStoppageConfiguration()
      ? createHeatModeSnapshotAction({
          root: activeRoot,
          nowMs,
          enabled: configuredHeatMode,
          gameTimeMs: clockBefore.gameTimeMs,
          shouldCommence: shouldCommence?.atMs ?? activeRoot.lifecycle.commencedAtMs,
          existingActions: actionsBefore,
          causalPredecessorIds: [action.operationId],
        })
      : null;
    const modeTimeline = deriveHeatModeTimeline(effectiveStateBefore.gameFacts, configuredHeatMode);
    const heatTriggerActions = createHeatTriggerActions({
      root: activeRoot,
      nowMs,
      currentGameTimeMs: clockBefore.gameTimeMs,
      targetGameTimeMs:
        typeof clockData.value?.gameTimeMs === "number"
          ? clockData.value.gameTimeMs
          : clockBefore.gameTimeMs,
      enabledAtGameTimeMs: modeTimeline.enabled ? modeTimeline.enabledAtGameTimeMs : null,
      existingActions: actionsBefore,
      causalPredecessorIds: [action.operationId],
    });
    const batchActions = [
      ...actions,
      ...heatTriggerActions,
      ...(heatModeSnapshot === null ? [] : [heatModeSnapshot]),
    ];

    let accepted;
    try {
      accepted = await options.acceptance.submitBatch({
        recordId: activeRoot.recordId,
        eventGameId: activeRoot.eventGameId,
        ...(input.replay === undefined ? { sessionBearer: input.sessionBearer } : {}),
        ...(input.replay === undefined ? {} : { mode: "replay", replay: input.replay }),
        lifecycleTransition,
        reconcileDerivedLifecycle: derivedLifecycle !== undefined,
        atomic: lifecycleTransition !== undefined && heatModeSnapshot !== null,
        actions: batchActions,
      });
    } catch {
      return retryableAction(parsed.value.operationId);
    }
    const result = accepted.results[0];
    const consequenceResult = accepted.results[1];
    if (accepted.status === "partial" || result?.status === "retry-later") {
      return retryableAction(parsed.value.operationId, accepted.reservationId);
    }
    if (
      consequenceResult !== undefined &&
      consequenceResult.status !== "accepted" &&
      consequenceResult.status !== "duplicate-accepted"
    ) {
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
    const replayDigest = sha256(
      canonicalizeJson({
        eventGameId: input.eventGameId,
        batchId: input.batchId,
        replicaGeneration: input.replicaGeneration,
        grantSessionId: input.expectedGrantSessionId,
        grantVersion: input.expectedGrantVersion,
        actions: input.actions,
      }),
    );
    if (options.authorizeLockedReplay !== undefined) {
      const authorized = await options.authorizeLockedReplay({
        sessionBearer: input.sessionBearer,
        eventGameId: input.eventGameId,
        grantSessionId: input.expectedGrantSessionId,
        grantVersion: input.expectedGrantVersion,
      });
      if (!authorized) {
        return replayRejected(input.actions, replayContext);
      }
      options.lockedReplayCapability?.authorize(replayDigest);
    }
    await lockEventGameIfDue(input.eventGameId);
    const capability = options.lockedReplayCapability;
    const capabilityEvidence = capability?.find(replayDigest) ?? null;
    const ownerAfterLock = await options.resolveEventGameRecord(input.eventGameId);
    const rootAfterLock =
      ownerAfterLock === null
        ? null
        : await ownerAfterLock.record.readRoot(ownerAfterLock.recordId);
    if (rootAfterLock?.lifecycle.lockedAtMs !== null && capabilityEvidence === null) {
      return replayRejected(input.actions, replayContext);
    }
    const lockedReplay = await discardLockedReplay({
      sessionBearer: input.sessionBearer,
      eventGameId: input.eventGameId,
      expectedGrantSessionId: input.expectedGrantSessionId,
      capabilityEvidence: capabilityEvidence ?? "",
      actions: input.actions,
      context: replayContext,
    });
    if (lockedReplay !== null) return lockedReplay;
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
      const replayRoot = await replayOwner.record.readRoot(replayOwner.recordId);
      if (replayRoot === null) return replayRetryable(input.actions, replayContext);
      const persistedActions = await replayOwner.record.readActions();
      const persistedOperationIds = new Set(
        persistedActions.map((stored) => stored.action.operationId),
      );
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
      const replayDigest = sha256(
        canonicalizeJson({
          eventGameId: input.eventGameId,
          batchId: input.batchId,
          replicaGeneration: input.replicaGeneration,
          grantSessionId: input.expectedGrantSessionId,
          grantVersion: input.expectedGrantVersion,
          actions: input.actions,
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
            const capability = options.lockedReplayCapability;
            const replayEvidenceId =
              capability?.find(replayDigest) ?? capability?.issue(replayDigest);
            if (replayEvidenceId !== undefined) {
              const heldResult = await submitControllerIntent({
                sessionBearer: input.sessionBearer,
                eventGameId: authorized.eventGameId,
                intent: candidate.intent,
                causalPredecessorIds: predecessors,
                replay: {
                  sessionBearer: input.sessionBearer,
                  originatingSessionId: input.expectedGrantSessionId,
                  replayEvidenceId,
                  reserveOnly: true,
                },
              });
              if (
                heldResult.status === "retryable" &&
                heldResult.replayReservationId !== undefined
              ) {
                capability?.remember({
                  evidence: replayEvidenceId,
                  replayDigest,
                  reservationId: heldResult.replayReservationId,
                });
              }
            }
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
            deferTimeoutMaterialization: true,
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
      const unresolvedTimeoutEvidence = outcomes.some((outcome) => {
        if (
          outcome.status !== "retryable" &&
          outcome.status !== "causally-blocked" &&
          outcome.status !== "held-for-correction"
        ) {
          return false;
        }
        const candidate = input.actions.find(
          (action) => readOperationId(action.intent) === outcome.operationId,
        );
        if (candidate === undefined) return false;
        const parsed = parseLiveEventControllerIntent(candidate.intent);
        return (
          parsed.ok &&
          (parsed.value.type === "correct-fact" ||
            (parsed.value.type === "substantive" && parsed.value.trigger === "timeout"))
        );
      });
      const materialized =
        owner === null || root === null || unresolvedTimeoutEvidence
          ? root === null
            ? null
            : { status: "ready" as const, root }
          : await materializeExpiredTimeout(owner, root, {
              sessionBearer: input.sessionBearer,
              grantSessionId: authorized.grantSessionId,
              grantVersion: authorized.grantVersion,
            });
      if (materialized?.status === "failed") return replayRetryable(input.actions, replayContext);
      const projection =
        owner === null || materialized === null
          ? null
          : await readProjection(owner.record, materialized.root);
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

  async function materializeExpiredTimeout(
    owner: { recordId: string; record: EventGameRecord },
    root: EventGameRecordRoot,
    authority: LiveMaterializationAuthority,
  ): Promise<TimeoutMaterializationResult> {
    const actions = await owner.record.readActions();
    const derived = rebuildLiveDerivedState(root, actions);
    const startedAtMs = derived?.timeout.startedAtMs;
    if (
      derived === null ||
      derived.timeout.status !== "started" ||
      derived.timeout.factId === null ||
      startedAtMs === null ||
      startedAtMs === undefined ||
      clock() - startedAtMs < 60_000
    ) {
      return { status: "ready", root };
    }

    const sourceFact = derived.gameFacts.find(
      (fact) => fact.factId === derived.timeout.factId && fact.effective,
    );
    const sourceAction = actions.find(
      (stored) =>
        stored.action.interpretation.type === "fact" &&
        stored.action.interpretation.factId === derived.timeout.factId,
    );
    if (sourceFact === undefined || sourceAction === undefined) {
      return { status: "failed", root };
    }

    const completionFactId = `timeout-completion-fact-${derived.timeout.factId}`;
    const completionOperationId = `timeout-completion-operation-${derived.timeout.factId}`;
    if (actions.some((stored) => stored.action.operationId === completionOperationId)) {
      return { status: "ready", root };
    }

    const completedAtMs = clock();
    const accepted = await options.acceptance.submitBatch({
      recordId: owner.recordId,
      eventGameId: root.eventGameId,
      sessionBearer: authority.sessionBearer,
      systemOperation: "timeout-completion",
      actions: [
        {
          recordId: owner.recordId,
          eventGameId: root.eventGameId,
          operationId: completionOperationId,
          kind: { id: gameFactCodecKind, version: gameFactCodecVersion },
          payload: {
            factId: completionFactId,
            factType: "timeout",
            gameSideId: derived.timeout.gameSideId,
            gameTimeMs: sourceFact.gameTimeMs ?? 0,
            data: {
              trigger: "timeout",
              sportingOrder: sourceFact.sportingOrder,
              timeoutAction: "complete",
              timeoutGameSideId: derived.timeout.gameSideId,
              timeoutSourceFactId: derived.timeout.factId,
              timeoutCompletedAtMs: completedAtMs,
            },
          },
          causalPredecessorIds: [sourceAction.action.operationId],
          occurrence: {
            trustedAtMs: completedAtMs,
            clientOriginAtMs: null,
            source: "online",
          },
          grant: {
            ...SYSTEM_TIMEOUT_COMPLETION_GRANT,
          },
          lifecycle: structuredClone(root.lifecycle),
        },
      ],
    });
    const result = accepted.results[0];
    if (result?.status !== "accepted" && result?.status !== "duplicate-accepted") {
      return { status: "failed", root };
    }
    return { status: "ready", root: (await owner.record.readRoot(owner.recordId)) ?? root };
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
      const configuredHeatMode = await readConfiguredHeatMode(root, derived.gameFacts);
      const projectedClock = projectClockBaseline(derived.clock.baseline, clock());
      const projectedFacts = derived.gameFacts.map((fact) => ({
        ...fact,
        data: structuredClone(fact.data),
      }));
      const projectedHeat = deriveHeatStoppageState(
        derived.gameFacts,
        projectedClock.gameTimeMs,
        configuredHeatMode,
        clock(),
      );
      const projectedStoppage: LiveStoppageState =
        derived.stoppage.status === "suspension"
          ? derived.stoppage
          : projectedHeat.status === "started" || projectedHeat.status === "extended"
            ? { status: "heat-stoppage", factId: projectedHeat.factId }
            : { status: "none", factId: null };
      const presentation = await record.readPresentation();
      const runningSinceMs =
        root.lifecycle.commencedAtMs === null ? latestRunningClockStart(derived.gameFacts) : null;
      const controllerProjection: ControllerProjection = {
        eventGameId: root.eventGameId,
        phase: derived.phase,
        scoreByGameSide: structuredClone(derived.scoreByGameSide),
        goalCount: derived.goalCount,
        knownDodgeballIds: [
          ...(configuredDodgeballIdsFor(root.eventGameId) ??
            knownDodgeballIdsFromFacts(derived.gameFacts) ??
            []),
        ].sort(),
        timeout: projectLiveTimeout(derived.timeout, clock()),
        suspension: structuredClone(derived.suspension),
        result: structuredClone(derived.result),
        overtime: derived.overtime,
        overtimeTarget: derived.overtimeTarget,
        targetScore: derived.overtimeTarget,
        winnerGameSideId: derived.winnerGameSideId,
        catch: structuredClone(derived.catch),
        gameFacts: projectedFacts,
        penalties: deriveLivePenaltyProjection(projectedFacts, projectedClock.gameTimeMs),
        stoppage: structuredClone(projectedStoppage),
        heat: structuredClone(projectedHeat),
        guardrails: [
          explainLiveEventGuardrail({ type: "substantive", trigger: "timeout" }),
          explainLiveEventGuardrail({ type: "substantive", trigger: "suspension" }),
          explainLiveEventGuardrail({ type: "substantive", trigger: "heat-stoppage" }),
          explainLiveEventGuardrail({ type: "record-goal", gameTimeMs: 1, sportingOrder: 0 }),
        ],
        clock: projectedClock,
        commencement: {
          status: root.lifecycle.commencedAtMs === null ? "provisional" : "commenced",
          commencedAtMs: root.lifecycle.commencedAtMs,
          provisionalRunningSinceMs: runningSinceMs,
          provisionalElapsedMs: runningSinceMs === null ? 0 : Math.max(0, clock() - runningSinceMs),
        },
        presentation: structuredClone(presentation),
      };
      return controllerProjection;
    } catch {
      return null;
    }
  }

  async function ensureClockCommencement(
    owner: { recordId: string; record: EventGameRecord },
    root: EventGameRecordRoot,
    authority: { sessionBearer: string; sessionId: string; grantVersion: string },
  ): Promise<{ status: "ready"; root: EventGameRecordRoot } | { status: "rejected" }> {
    if (root.lifecycle.commencedAtMs !== null || root.lifecycle.phase !== "scheduled") {
      return { status: "ready", root };
    }
    const actions = await owner.record.readActions();
    const nowMs = clock();
    const fallbackState = rebuildLiveDerivedState(root, actions, nowMs, false, nowMs);
    if (fallbackState === null) return { status: "rejected" };
    const runningSinceMs = latestRunningClockStart(fallbackState.gameFacts);
    if (runningSinceMs === null || nowMs - runningSinceMs < 10_000) {
      return { status: "ready", root };
    }
    const commencementAtMs = runningSinceMs + 10_000;
    const lifecycleTransition = {
      ...root.lifecycle,
      phase: "in-progress" as const,
      commencedAtMs: commencementAtMs,
    };
    let configuredHeatMode: boolean;
    try {
      configuredHeatMode = await readConfiguredHeatMode(root, fallbackState.gameFacts);
    } catch {
      return { status: "rejected" };
    }
    const snapshot = hasHeatStoppageConfiguration()
      ? createHeatModeSnapshotAction({
          root,
          nowMs,
          enabled: configuredHeatMode,
          gameTimeMs: fallbackState.clock.gameTimeMs,
          shouldCommence: commencementAtMs,
          existingActions: actions,
          causalPredecessorIds: [],
        })
      : null;
    if (snapshot === null) {
      const transition = await owner.record.transitionLifecycle(lifecycleTransition);
      return transition.status === "rejected"
        ? { status: "rejected" }
        : { status: "ready", root: transition.root };
    }
    const accepted = await options.acceptance.submitBatch({
      recordId: root.recordId,
      eventGameId: root.eventGameId,
      sessionBearer: authority.sessionBearer,
      lifecycleTransition,
      atomic: true,
      actions: [snapshot],
    });
    if (
      accepted.status !== "committed" ||
      (accepted.results[0]?.status !== "accepted" &&
        accepted.results[0]?.status !== "duplicate-accepted")
    ) {
      return { status: "rejected" };
    }
    const updatedRoot = await owner.record.readRoot(owner.recordId);
    return updatedRoot === null ? { status: "rejected" } : { status: "ready", root: updatedRoot };
  }

  async function readConfiguredHeatMode(
    root: EventGameRecordRoot,
    facts: readonly ControllerGameFact[],
  ): Promise<boolean> {
    const snapshot = facts.find((fact) => fact.factType === "heat-mode" && isRecord(fact.data));
    if (snapshot !== undefined && isRecord(snapshot.data)) {
      return snapshot.data.enabled === true;
    }
    if (options.readHeatStoppageConfiguration !== undefined) {
      const configured = await options.readHeatStoppageConfiguration({
        eventId: root.externalScope.eventId,
        gameDayId: root.externalScope.gameDayId,
        eventGameId: root.eventGameId,
      });
      if (configured === null) throw new Error("Heat Stoppage Configuration is unavailable.");
      return configured === "enabled";
    }
    return options.heatStoppageConfiguration ?? false;
  }

  function hasHeatStoppageConfiguration(): boolean {
    return (
      options.readHeatStoppageConfiguration !== undefined ||
      options.heatStoppageConfiguration !== undefined
    );
  }

  async function submitGamePresentationChange(input: {
    sessionBearer: string;
    eventGameId: string;
    change: unknown;
    causalPredecessorIds?: readonly string[];
    originatingGrant?: GamePresentationGrantProvenance;
  }): Promise<GamePresentationChangeResult> {
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
      return {
        status: "rejected",
        operationId: null,
        message: "Unable to perform that Game Presentation Change.",
      };
    }
    const parsed = parseLiveEventControllerIntent(input.change);
    if (!parsed.ok || !isGamePresentationIntentValue(parsed.value)) {
      return {
        status: "rejected",
        operationId: readOperationId(input.change),
        message: "Unable to perform that Game Presentation Change.",
      };
    }
    const owner = await options.resolveEventGameRecord(authorized.eventGameId);
    const root = owner === null ? null : await owner.record.readRoot(owner.recordId);
    if (owner === null || root === null) {
      return {
        status: "rejected",
        operationId: parsed.value.operationId,
        message: "Unable to perform that Game Presentation Change.",
      };
    }
    const grant: GamePresentationGrantProvenance = input.originatingGrant ?? {
      sessionId: authorized.grantSessionId,
      versionId: authorized.grantVersion,
    };
    const outcome = await owner.record.acceptPresentationChange({
      recordId: root.recordId,
      eventGameId: root.eventGameId,
      operationId: parsed.value.operationId,
      presentationChangeId: parsed.value.presentationChangeId,
      change:
        parsed.value.type === "set-pitch-orientation"
          ? { type: "pitch-orientation", pitchOrientation: parsed.value.pitchOrientation }
          : {
              type: "displayed-team-color",
              gameSideId: parsed.value.gameSideId,
              color: parsed.value.color,
            },
      causalPredecessorIds: [...(input.causalPredecessorIds ?? [])],
      occurrence: {
        trustedAtMs: clock(),
        clientOriginAtMs: parsed.value.occurrence.clientOriginAtMs,
        source: parsed.value.occurrence.source ?? "online",
      },
      grant,
      acceptedAtMs: clock(),
    });
    if (outcome.status === "rejected") {
      return {
        status: outcome.reason === "storage-not-ready" ? "retryable" : "rejected",
        operationId: parsed.value.operationId,
        message: outcome.detail,
      };
    }
    const projection = await readProjection(owner.record, root);
    return {
      status: outcome.status,
      operationId: parsed.value.operationId,
      presentation:
        projection?.presentation ??
        createInitialGamePresentation(root.gameSides.map((side) => side.id)),
      auditId: outcome.auditId,
    };
  }

  async function replayGamePresentationChanges(input: {
    sessionBearer: string;
    eventGameId: string;
    batchId: string;
    replicaGeneration: string;
    expectedGrantSessionId: string;
    expectedGrantVersion: string;
    changes: readonly {
      eventGameId: string;
      change: unknown;
      causalPredecessorIds?: readonly unknown[];
      originatingGrant?: unknown;
    }[];
  }): Promise<ControllerReplayResult> {
    const outcomes: ControllerReplayOutcome[] = [];
    for (const candidate of input.changes) {
      const parsed = parseLiveEventControllerIntent(candidate.change);
      const operationId = parsed.ok
        ? parsed.value.operationId
        : (readOperationId(candidate.change) ?? "");
      if (!parsed.ok || candidate.eventGameId !== input.eventGameId) {
        outcomes.push({ operationId, status: "terminally-rejected" });
        continue;
      }
      const result = await submitGamePresentationChange({
        sessionBearer: input.sessionBearer,
        eventGameId: input.eventGameId,
        change: candidate.change,
        causalPredecessorIds: Array.isArray(candidate.causalPredecessorIds)
          ? candidate.causalPredecessorIds.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
      });
      outcomes.push({
        operationId,
        status:
          result.status === "accepted"
            ? "accepted"
            : result.status === "duplicate-accepted"
              ? "idempotent"
              : result.status === "retryable"
                ? "retryable"
                : "terminally-rejected",
      });
    }
    const owner = await options.resolveEventGameRecord(input.eventGameId);
    const root = owner === null ? null : await owner.record.readRoot(owner.recordId);
    const projection =
      owner === null || root === null ? null : await readProjection(owner.record, root);
    return {
      batchId: input.batchId,
      replicaGeneration: input.replicaGeneration,
      session: {
        eventGameId: input.eventGameId,
        grantSessionId: input.expectedGrantSessionId,
        grantVersion: input.expectedGrantVersion,
      },
      eventGameId: input.eventGameId,
      status: outcomes.some((outcome) => outcome.status === "retryable")
        ? "retryable"
        : "synchronized",
      outcomes,
      projection,
    };
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
    reconcileEventGameLocks,
    reconcileActiveControllerSessions,
    close() {
      closed = true;
      reconciliationGeneration += 1;
      reconciliationDirty = false;
      activeControllerSessions.clear();
    },
    submitControllerIntent,
    replayControllerActions,
    submitControlAction: submitControllerIntent,
    replayControlActions: replayControllerActions,
    submitGamePresentationChange,
    replayGamePresentationChanges,
  };
}

function isGamePresentationIntentValue(
  value: LiveEventControllerIntent,
): value is GamePresentationChangeIntent {
  return value.type === "set-pitch-orientation" || value.type === "set-displayed-team-color";
}

function projectLiveTimeout(timeout: LiveTimeoutState, nowMs: number): LiveTimeoutState {
  if (
    timeout.status !== "started" ||
    timeout.startedAtMs === null ||
    timeout.startedAtMs === undefined
  ) {
    return structuredClone(timeout);
  }
  const remainingMs = Math.max(0, 60_000 - Math.max(0, nowMs - timeout.startedAtMs));
  if (remainingMs === 0) {
    return {
      ...structuredClone(timeout),
      status: "completed",
      remainingMs: 0,
      longWhistleCue: "passed",
    };
  }
  return {
    ...structuredClone(timeout),
    remainingMs,
    longWhistleCue: remainingMs <= 15_000 ? "due" : "pending",
  };
}

function readSuspensionSnapshotData(value: unknown): LiveSuspensionSnapshot {
  const parsed = parseLiveSuspensionSnapshot(value);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function canonicalizeLiveSuspensionSnapshot(
  snapshot: LiveSuspensionSnapshot,
  current: LiveEventGameDerivedState,
  atMs: number,
  configuredDodgeballIds: readonly string[] | null,
): { ok: true; value: LiveSuspensionSnapshot } | { ok: false; error: string } {
  const clock = projectClockBaseline(current.clock.baseline, atMs);
  if (snapshot.gameTimeMs !== clock.gameTimeMs) {
    return { ok: false, error: "Suspension snapshot Game Clock is stale." };
  }
  if (!sameNumberRecord(snapshot.scoreByGameSide, current.scoreByGameSide)) {
    return { ok: false, error: "Suspension snapshot score is stale." };
  }
  const actualPenalty = suspensionPenaltyStateFromProjection(
    deriveLivePenaltyProjection(current.gameFacts, clock.gameTimeMs),
  );
  if (canonicalizeJson(snapshot.penalties) !== canonicalizeJson(actualPenalty)) {
    return { ok: false, error: "Suspension snapshot penalty state is stale." };
  }

  const gameSideIds = new Set(Object.keys(current.scoreByGameSide));
  if (!gameSideIds.has(snapshot.volleyballPossession)) {
    return { ok: false, error: "Volleyball possession must name an admitted Game Side." };
  }
  for (const [ballId, gameSideId] of Object.entries(snapshot.dodgeballPossession)) {
    if (gameSideId !== null && !gameSideIds.has(gameSideId)) {
      return {
        ok: false,
        error: `Dodgeball ${ballId} possession must name an admitted Game Side.`,
      };
    }
  }

  const knownDodgeballIds = configuredDodgeballIds
    ? new Set(configuredDodgeballIds)
    : knownDodgeballIdsFromFacts(current.gameFacts);
  if (knownDodgeballIds === null) {
    return { ok: false, error: "Authoritative dodgeball identities are unavailable." };
  }
  const suppliedDodgeballIds = Object.keys(snapshot.dodgeballPossession);
  if (
    knownDodgeballIds.size > 0 &&
    (knownDodgeballIds.size !== suppliedDodgeballIds.length ||
      suppliedDodgeballIds.some((ballId) => !knownDodgeballIds.has(ballId)))
  ) {
    return { ok: false, error: "Suspension snapshot must list every known dodgeball." };
  }
  return {
    ok: true,
    value: {
      version: LIVE_SUSPENSION_SNAPSHOT_VERSION,
      gameTimeMs: clock.gameTimeMs,
      scoreByGameSide: structuredClone(current.scoreByGameSide),
      penalties: actualPenalty,
      volleyballPossession: snapshot.volleyballPossession,
      dodgeballPossession: structuredClone(snapshot.dodgeballPossession),
    },
  };
}

function normalizeConfiguredDodgeballIds(
  value: readonly string[] | undefined,
): readonly string[] | null {
  if (value === undefined) return null;
  if (value.length === 0 || new Set(value).size !== value.length) {
    throw new Error("The configured dodgeball identity set must be non-empty and unique.");
  }
  for (const ballId of value) {
    if (!validateOpaqueIdentifier(ballId, "knownDodgeballIds").ok) {
      throw new Error("The configured dodgeball identity set is invalid.");
    }
  }
  return [...value].sort();
}

function knownDodgeballIdsFromFacts(facts: readonly ControllerGameFact[]): Set<string> | null {
  const ids = new Set<string>();
  for (const fact of facts) {
    if (fact.factType !== "suspension") continue;
    const data = isRecord(fact.data) ? fact.data : null;
    if (data?.suspensionSnapshot === undefined) continue;
    const snapshot = parseLiveSuspensionSnapshot(data.suspensionSnapshot);
    if (!snapshot.ok) continue;
    for (const ballId of Object.keys(snapshot.value.dodgeballPossession)) ids.add(ballId);
  }
  return ids.size === 0 ? null : ids;
}

export function suspensionPenaltyStateFromProjection(
  projection: LivePenaltyProjection,
): LiveSuspensionPenaltyState {
  return {
    segments: projection.players.flatMap((player) =>
      player.segments.map((segment) => ({
        sourceFactId: segment.id,
        cardFactId: segment.cardFactId,
        cardType: segment.cardType,
        gameSideId: player.gameSideId,
        playerKey: player.playerKey,
        playerNumber: player.playerNumber,
        eligibleForScoreAtGameTimeMs: segment.eligibleForScoreAtGameTimeMs,
        notBeforeGameTimeMs: segment.notBeforeGameTimeMs,
        startsAtGameTimeMs: segment.startsAtGameTimeMs,
        endsAtGameTimeMs: segment.endsAtGameTimeMs,
        elapsedMs: Math.max(
          0,
          segment.endsAtGameTimeMs - segment.startsAtGameTimeMs - segment.remainingMs,
        ),
        remainingMs: segment.remainingMs,
        expirableByScore: segment.expirableByScore,
      })),
    ),
  };
}

function sameNumberRecord(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  );
}

function deriveLiveEventGameState(
  root: EventGameRecordRoot,
  canonicalActions: readonly { action: import("@/lib/event-game-actions").ControlAction }[],
  effectiveFacts: readonly EffectiveGameFact[],
  version: string,
  projectedAtMs = 0,
  configuredHeatMode = false,
  nowMs = 0,
): LiveEventGameDerivedState {
  const scoreByGameSide: Record<string, number> = Object.fromEntries(
    root.gameSides.map((side) => [side.id, 0]),
  );
  const effectiveFactIds = new Set(effectiveFacts.map((fact) => fact.factId));
  const synchronizationOrderByOperationId = new Map(
    canonicalActions.map(({ action }, index) => [action.operationId, index + 1]),
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
            trustedAtMs: action.occurrence.trustedAtMs,
            acceptedAtMs: action.acceptedAtMs,
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
  const effectiveGameFacts = gameFacts.filter((fact) => fact.effective);
  const latestEffectiveFact = (factType: string): ControllerGameFact | null =>
    effectiveGameFacts.filter((fact) => fact.factType === factType).at(-1) ?? null;
  const timeoutFacts = effectiveGameFacts.filter((fact) => fact.factType === "timeout");
  const usedTimeoutGameSideIds = new Set<string>();
  let timeout: LiveTimeoutState = {
    status: "inactive",
    factId: null,
    gameSideId: null,
    usedGameSideIds: [],
    startedAtMs: null,
    remainingMs: null,
    longWhistleCue: "not-applicable",
  };
  for (const fact of timeoutFacts) {
    const data = isRecord(fact.data) ? fact.data : null;
    if (data === null || typeof data.timeoutGameSideId !== "string") {
      throw new Error("Effective timeout Fact has no explicit Game Side.");
    }
    const gameSideId = data.timeoutGameSideId;
    const timeoutAction = readTimeoutAction(data);
    if (timeoutAction === null) throw new Error("Effective timeout Fact has no explicit action.");
    if (timeoutAction === "stoppage") {
      if (timeout.status === "stoppage" || timeout.status === "started") {
        throw new Error("An effective timeout procedure cannot replace another active timeout.");
      }
      if (usedTimeoutGameSideIds.has(gameSideId)) {
        throw new Error("Each Game Side may use only one timeout.");
      }
      usedTimeoutGameSideIds.add(gameSideId);
      timeout = {
        status: "stoppage",
        factId: fact.factId,
        gameSideId,
        usedGameSideIds: [...usedTimeoutGameSideIds].sort(),
        startedAtMs: null,
        remainingMs: null,
        longWhistleCue: "not-applicable",
      };
    } else if (timeoutAction === "start") {
      if (timeout.status !== "stoppage" || timeout.gameSideId !== gameSideId) {
        throw new Error("A timeout minute must match its active stoppage Game Side.");
      }
      const action = effectiveFacts.find((candidate) => candidate.factId === fact.factId)?.action;
      const startedAtMs =
        data !== null && typeof data.timeoutStartedAtMs === "number"
          ? data.timeoutStartedAtMs
          : (action?.acceptedAtMs ?? null);
      timeout = {
        status: "started",
        factId: fact.factId,
        gameSideId,
        usedGameSideIds: [...usedTimeoutGameSideIds].sort(),
        startedAtMs,
        remainingMs: 60_000,
        longWhistleCue: "pending",
      };
    } else {
      if (
        timeout.status !== "started" ||
        timeout.factId === null ||
        data.timeoutSourceFactId !== timeout.factId
      ) {
        throw new Error("A timeout completion must target its effective timeout minute.");
      }
      timeout = {
        status: "completed",
        factId: fact.factId,
        gameSideId,
        usedGameSideIds: [...usedTimeoutGameSideIds].sort(),
        startedAtMs: null,
        remainingMs: 0,
        longWhistleCue: "passed",
      };
    }
  }
  timeout = {
    ...timeout,
    usedGameSideIds: [...usedTimeoutGameSideIds].sort(),
  };

  let suspension: LiveSuspensionState = {
    status: "none",
    factId: null,
    snapshot: null,
  };
  for (const fact of effectiveGameFacts) {
    if (fact.factType !== "suspension") continue;
    const data = isRecord(fact.data) ? fact.data : null;
    const action =
      data?.suspensionAction === "start" || data?.suspensionAction === "resume"
        ? data.suspensionAction
        : null;
    if (action === null) throw new Error("Effective suspension Fact has no explicit action.");
    if (action === "resume") {
      const target = data?.resumesSuspensionFactId;
      if (suspension.factId === null || target !== suspension.factId) {
        throw new Error("Effective resume does not target the effective suspension Fact.");
      }
      suspension = { status: "none", factId: null, snapshot: null };
      continue;
    }
    if (suspension.status === "suspended") {
      throw new Error("Effective suspension Facts cannot start a second suspension.");
    }
    const snapshot = readSuspensionSnapshotData(data?.suspensionSnapshot);
    suspension = { status: "suspended", factId: fact.factId, snapshot };
  }

  const latestResultFact = latestEffectiveFact("result");
  const clock = projectClockBaseline(
    deriveClockAuthority(
      readClockAuthorityActions(effectiveFacts.map((fact) => ({ action: fact.action }))),
    ),
    projectedAtMs,
  );
  const heat = deriveHeatStoppageState(gameFacts, clock.gameTimeMs, configuredHeatMode, nowMs);
  if (suspension.status === "suspended" && clock.running) {
    throw new Error("Effective suspension cannot coexist with a running Game Clock.");
  }
  const stoppage: LiveStoppageState =
    suspension.status === "suspended"
      ? { status: "suspension", factId: suspension.factId }
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
  const effectiveSuspension = suspension.status === "suspended";
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
    suspension,
    stoppage,
    heat,
    result,
    overtime,
    overtimeTarget,
    winnerGameSideId,
    catch: catchState,
    gameFacts,
    penalties: deriveLivePenaltyProjection(gameFacts, clock.gameTimeMs),
    clock,
  };
}

function readTimeoutAction(
  data: Record<string, unknown> | null,
): "stoppage" | "start" | "complete" | null {
  return data?.timeoutAction === "stoppage" ||
    data?.timeoutAction === "start" ||
    data?.timeoutAction === "complete"
    ? data.timeoutAction
    : null;
}
export function deriveHeatStoppageState(
  facts: readonly ControllerGameFact[],
  gameTimeMs: number,
  configuredHeatMode: boolean,
  nowMs = 0,
): LiveHeatState {
  const effectiveFacts = facts.filter((fact) => fact.effective);
  const modeTimeline = deriveHeatModeTimeline(effectiveFacts, configuredHeatMode);
  const { enabled, configured, enabledAtGameTimeMs, segments } = modeTimeline;
  const currentIntervalFirstTrigger = enabled ? firstHeatTriggerAfter(enabledAtGameTimeMs) : null;
  const triggerFacts = effectiveFacts.filter((fact) => fact.factType === "heat-trigger");
  const triggerById = new Map<string, { id: string; gameTimeMs: number; durable: boolean }>();
  for (const fact of triggerFacts) {
    const data = isRecord(fact.data) ? fact.data : null;
    const triggerGameTimeMs =
      typeof data?.triggerGameTimeMs === "number" ? data.triggerGameTimeMs : fact.gameTimeMs;
    const triggerId = typeof data?.triggerId === "string" ? data.triggerId : null;
    if (triggerId !== null && triggerGameTimeMs !== null) {
      triggerById.set(triggerId, { id: triggerId, gameTimeMs: triggerGameTimeMs, durable: true });
    }
  }
  const derivedTriggerTimes = new Set<number>();
  for (const segment of segments) {
    if (segment.end !== null) continue;
    const end = Math.max(gameTimeMs, ...effectiveFacts.map((fact) => fact.gameTimeMs ?? 0));
    for (
      let trigger = firstHeatTriggerAfter(segment.start);
      trigger <= end;
      trigger = nextHeatTrigger(trigger)
    ) {
      derivedTriggerTimes.add(trigger);
    }
  }
  for (const triggerGameTimeMs of derivedTriggerTimes) {
    const triggerId = heatTriggerId(triggerGameTimeMs);
    if (!triggerById.has(triggerId)) {
      triggerById.set(triggerId, { id: triggerId, gameTimeMs: triggerGameTimeMs, durable: false });
    }
  }
  const orderedTriggers = [...triggerById.values()].sort(
    (left, right) => left.gameTimeMs - right.gameTimeMs || left.id.localeCompare(right.id),
  );
  const resolvedTriggerIds = new Set<string>();
  const heatFacts = effectiveFacts.filter((fact) => fact.factType === "heat-stoppage");
  for (const fact of heatFacts) {
    const data = isRecord(fact.data) ? fact.data : null;
    const action = data?.heatAction;
    if (
      action === "enable" ||
      action === "disable" ||
      action === "end" ||
      action === "extend-permitted" ||
      action === "extend"
    )
      continue;
    const triggerTime = typeof data?.triggerGameTimeMs === "number" ? data.triggerGameTimeMs : null;
    const triggerId =
      typeof data?.heatTriggerId === "string"
        ? data.heatTriggerId
        : typeof data?.triggerId === "string"
          ? data.triggerId
          : triggerTime === null
            ? null
            : heatTriggerId(triggerTime);
    if (triggerId !== null) resolvedTriggerIds.add(triggerId);
  }
  const pendingTrigger =
    configured && enabled && currentIntervalFirstTrigger !== null
      ? (orderedTriggers.find(
          (trigger) =>
            trigger.gameTimeMs >= currentIntervalFirstTrigger &&
            (trigger.durable || trigger.gameTimeMs <= gameTimeMs) &&
            !resolvedTriggerIds.has(trigger.id),
        ) ?? null)
      : null;
  const nextTrigger =
    configured && enabled
      ? (orderedTriggers.find(
          (trigger) =>
            trigger.gameTimeMs >= (currentIntervalFirstTrigger ?? 0) &&
            trigger.gameTimeMs > gameTimeMs &&
            !resolvedTriggerIds.has(trigger.id),
        ) ?? {
          id: heatTriggerId(firstHeatTriggerAfter(Math.max(gameTimeMs, enabledAtGameTimeMs))),
          gameTimeMs: firstHeatTriggerAfter(Math.max(gameTimeMs, enabledAtGameTimeMs)),
          durable: false,
        })
      : null;

  const starts = heatFacts.filter((fact) => {
    const action = isRecord(fact.data) ? fact.data.heatAction : null;
    return (
      action === "start" ||
      action === "end-of-drive" ||
      action === "dead-volleyball" ||
      action === "other-stoppage"
    );
  });
  const orderedHeatFacts = [...heatFacts].sort(
    (left, right) =>
      heatFactSequence(left) - heatFactSequence(right) ||
      (left.gameTimeMs ?? 0) - (right.gameTimeMs ?? 0) ||
      left.synchronizationOrder - right.synchronizationOrder,
  );
  const latestHeatFact = orderedHeatFacts.at(-1) ?? null;
  const latestData =
    latestHeatFact !== null && isRecord(latestHeatFact.data) ? latestHeatFact.data : null;
  const latestAction = latestData?.heatAction;
  const latestStart =
    [...starts]
      .sort(
        (left, right) =>
          heatFactSequence(left) - heatFactSequence(right) ||
          (left.gameTimeMs ?? 0) - (right.gameTimeMs ?? 0) ||
          left.synchronizationOrder - right.synchronizationOrder,
      )
      .at(-1) ?? null;
  const latestStartTime = latestStart?.gameTimeMs ?? null;
  const latestStartData =
    latestStart !== null && isRecord(latestStart.data) ? latestStart.data : null;
  const activeTriggerId =
    typeof latestStartData?.heatTriggerId === "string"
      ? latestStartData.heatTriggerId
      : typeof latestStartData?.triggerId === "string"
        ? latestStartData.triggerId
        : typeof latestStartData?.triggerGameTimeMs === "number"
          ? heatTriggerId(latestStartData.triggerGameTimeMs)
          : null;
  const nominalDurationMs =
    latestStart === null
      ? null
      : starts.length === 1
        ? HEAT_STOPPAGE_FIRST_NOMINAL_DURATION_MS
        : HEAT_STOPPAGE_LATER_NOMINAL_DURATION_MS;
  const endedBy =
    latestHeatFact !== null &&
    (latestAction === "end" || latestAction === "disable") &&
    latestStart !== null &&
    (latestHeatFact.gameTimeMs ?? 0) >= (latestStart.gameTimeMs ?? 0) &&
    latestHeatFact.synchronizationOrder !== latestStart.synchronizationOrder
      ? latestHeatFact
      : null;
  const startTrustedAtMs = latestStart?.trustedAtMs ?? null;
  const endTrustedAtMs = endedBy?.trustedAtMs ?? null;
  const rawActualDurationMs =
    startTrustedAtMs === null
      ? null
      : Math.max(0, (endTrustedAtMs ?? (nowMs > 0 ? nowMs : startTrustedAtMs)) - startTrustedAtMs);
  const decision =
    latestAction === "end-of-drive" ||
    latestAction === "dead-volleyball" ||
    latestAction === "other-stoppage" ||
    latestAction === "skip" ||
    latestAction === "skip-required"
      ? latestAction
      : null;
  const pendingIndex = pendingTrigger === null ? -1 : orderedTriggers.indexOf(pendingTrigger);
  let permittedExtensionTriggerId: string | null = null;
  let followingExtensionActive = false;
  let followingExtensionConsumed = false;
  for (const fact of orderedHeatFacts) {
    const data = isRecord(fact.data) ? fact.data : null;
    const action = data?.heatAction;
    const triggerTime =
      typeof data?.triggerGameTimeMs === "number"
        ? data.triggerGameTimeMs
        : typeof data?.heatTriggerId === "string"
          ? orderedTriggers.find((trigger) => trigger.id === data.heatTriggerId)?.gameTimeMs
          : fact.gameTimeMs;
    const triggerId =
      typeof data?.heatTriggerId === "string"
        ? data.heatTriggerId
        : typeof triggerTime === "number"
          ? heatTriggerId(triggerTime)
          : null;
    if (action === "skip" || action === "skip-required") {
      permittedExtensionTriggerId =
        typeof triggerTime === "number" ? heatTriggerId(nextHeatTrigger(triggerTime)) : null;
      followingExtensionActive = false;
      followingExtensionConsumed = false;
    } else if (
      action === "start" ||
      action === "end-of-drive" ||
      action === "dead-volleyball" ||
      action === "other-stoppage"
    ) {
      if (permittedExtensionTriggerId !== null && triggerId !== permittedExtensionTriggerId) {
        permittedExtensionTriggerId = null;
        followingExtensionActive = false;
        followingExtensionConsumed = false;
      } else if (
        permittedExtensionTriggerId !== null &&
        triggerId === permittedExtensionTriggerId
      ) {
        followingExtensionActive = true;
      }
    } else if (action === "extend-permitted") {
      if (triggerId === permittedExtensionTriggerId && followingExtensionActive) {
        followingExtensionConsumed = true;
        permittedExtensionTriggerId = null;
      }
    } else if (action === "extend") {
      followingExtensionActive = false;
      followingExtensionConsumed = false;
      permittedExtensionTriggerId = null;
    }
  }
  const allowedDurationMs =
    nominalDurationMs === null
      ? null
      : followingExtensionActive || followingExtensionConsumed
        ? HEAT_STOPPAGE_FIRST_NOMINAL_DURATION_MS
        : nominalDurationMs;
  const completionRecordedAtAllowed = latestData?.completionAtAllowed === true;
  const completedAtAllowed =
    latestStart !== null &&
    latestAction !== "extend" &&
    (endedBy === null || completionRecordedAtAllowed) &&
    allowedDurationMs !== null &&
    (rawActualDurationMs ?? 0) >= allowedDurationMs;
  const actualDurationMs =
    (completedAtAllowed || completionRecordedAtAllowed) && allowedDurationMs !== null
      ? allowedDurationMs
      : rawActualDurationMs;
  const completionAtTrustedAtMs =
    startTrustedAtMs !== null && allowedDurationMs !== null
      ? startTrustedAtMs + allowedDurationMs
      : null;
  const status: LiveHeatState["status"] =
    latestHeatFact === null || latestStart === null
      ? latestAction === "extend-permitted" || latestAction === "extend"
        ? "extended"
        : latestAction === "skip-required"
          ? "required-skip"
          : latestAction === "skip"
            ? "skipped"
            : latestAction === "suppress"
              ? "suppressed"
              : "inactive"
      : latestAction === "skip-required"
        ? "required-skip"
        : latestAction === "skip"
          ? "skipped"
          : latestAction === "suppress"
            ? "suppressed"
            : latestAction === "extend-permitted" || latestAction === "extend"
              ? completedAtAllowed
                ? "ended"
                : "extended"
              : latestAction === "end" || (configured && !enabled) || endedBy !== null
                ? "ended"
                : completedAtAllowed
                  ? "ended"
                  : "started";
  return {
    status,
    factId: latestHeatFact?.factId ?? null,
    startedAtGameTimeMs: latestStartTime,
    nominalDurationMs,
    allowedDurationMs,
    actualDurationMs,
    completedAtAllowed,
    rawActualDurationMs,
    completionAtTrustedAtMs,
    mode: enabled ? "enabled" : "disabled",
    pendingTrigger:
      pendingTrigger === null
        ? null
        : {
            gameTimeMs: pendingTrigger.gameTimeMs,
            index: pendingIndex,
          },
    pendingTriggerId: pendingTrigger?.id ?? null,
    pendingTriggerGameTimeMs: pendingTrigger?.gameTimeMs ?? null,
    nextTriggerGameTimeMs: nextTrigger?.gameTimeMs ?? null,
    trigger:
      pendingTrigger === null
        ? null
        : { id: pendingTrigger.id, gameTimeMs: pendingTrigger.gameTimeMs, index: pendingIndex },
    permittedExtensionTriggerId,
    activeTriggerId,
    triggerDecision: decision,
  };
}

/**
 * Project the Controller's local Heat Stoppage view from its last trusted
 * projection. Durable admission still validates stable trigger identity on
 * the server; this helper only updates the browser cue and timer between
 * server round trips.
 */
export function projectLiveHeatState(
  facts: readonly ControllerGameFact[],
  currentMode: LiveHeatState["mode"] | undefined,
  gameTimeMs: number,
  nowMs: number,
): LiveHeatState {
  return deriveHeatStoppageState(facts, gameTimeMs, currentMode === "enabled", nowMs);
}

function deriveHeatModeTimeline(
  facts: readonly ControllerGameFact[],
  configuredHeatMode: boolean,
): {
  enabled: boolean;
  configured: boolean;
  enabledAtGameTimeMs: number;
  segments: Array<{ start: number; end: number | null }>;
} {
  const effectiveFacts = facts.filter((fact) => fact.effective);
  const heatModeFacts = effectiveFacts.filter((fact) => fact.factType === "heat-mode");
  const modeChanges = effectiveFacts
    .filter((fact) => {
      if (fact.factType !== "heat-stoppage" || !isRecord(fact.data)) return false;
      return fact.data.heatAction === "enable" || fact.data.heatAction === "disable";
    })
    .sort(
      (left, right) =>
        heatFactSequence(left) - heatFactSequence(right) ||
        (left.gameTimeMs ?? 0) - (right.gameTimeMs ?? 0) ||
        left.synchronizationOrder - right.synchronizationOrder,
    );
  let enabled = configuredHeatMode;
  let configured = configuredHeatMode || heatModeFacts.length > 0;
  let enabledAtGameTimeMs = 0;
  const segments: Array<{ start: number; end: number | null }> = [];
  const firstModeFact = heatModeFacts[0];
  if (firstModeFact !== undefined && isRecord(firstModeFact.data)) {
    configured = true;
    enabled = firstModeFact.data.enabled === true;
    enabledAtGameTimeMs = firstModeFact.gameTimeMs ?? 0;
  }
  if (enabled) segments.push({ start: enabledAtGameTimeMs, end: null });
  for (const fact of modeChanges) {
    const action = isRecord(fact.data) ? fact.data.heatAction : null;
    const at = fact.gameTimeMs ?? 0;
    if (action === "enable") {
      configured = true;
      if (!enabled) {
        enabled = true;
        enabledAtGameTimeMs = at;
        segments.push({ start: at, end: null });
      }
    } else if (action === "disable") {
      configured = true;
      if (enabled) {
        enabled = false;
        const currentSegment = segments.at(-1);
        if (currentSegment?.end === null) currentSegment.end = at;
      }
    }
  }
  return { enabled, configured, enabledAtGameTimeMs, segments };
}

function heatTriggerId(gameTimeMs: number): string {
  return `heat-trigger-${gameTimeMs}`;
}

function heatFactSequence(fact: ControllerGameFact): number {
  const data = isRecord(fact.data) ? fact.data : null;
  return typeof data?.heatSequence === "number" ? data.heatSequence : Number.MAX_SAFE_INTEGER;
}

function firstHeatTriggerAfter(gameTimeMs: number): number {
  if (gameTimeMs < HEAT_STOPPAGE_FIRST_TRIGGER_GAME_TIME_MS) {
    return HEAT_STOPPAGE_FIRST_TRIGGER_GAME_TIME_MS;
  }
  if (gameTimeMs < HEAT_STOPPAGE_SECOND_TRIGGER_GAME_TIME_MS) {
    return HEAT_STOPPAGE_SECOND_TRIGGER_GAME_TIME_MS;
  }
  return (
    HEAT_STOPPAGE_SECOND_TRIGGER_GAME_TIME_MS +
    (Math.floor(
      (gameTimeMs - HEAT_STOPPAGE_SECOND_TRIGGER_GAME_TIME_MS) / HEAT_STOPPAGE_TRIGGER_INTERVAL_MS,
    ) +
      1) *
      HEAT_STOPPAGE_TRIGGER_INTERVAL_MS
  );
}

function nextHeatTrigger(gameTimeMs: number): number {
  return gameTimeMs < HEAT_STOPPAGE_SECOND_TRIGGER_GAME_TIME_MS
    ? HEAT_STOPPAGE_SECOND_TRIGGER_GAME_TIME_MS
    : gameTimeMs + HEAT_STOPPAGE_TRIGGER_INTERVAL_MS;
}

function controllerFactType(intent: LiveEventControllerIntent): string {
  if (intent.type === "record-goal") return "goal";
  if (intent.type === "record-flag-catch") return "flag-catch";
  if (intent.type === "record-concession") return "concession";
  if (intent.type === "record-forfeit") return "forfeit";
  if (intent.type === "record-double-forfeit") return "double-forfeit";
  if (intent.type === "record-card") return "card";
  if (intent.type === "record-penalty-reason") return "penalty-reason";
  if (intent.type === "resolve-penalty-expiration") return "penalty-release";
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

function buildAutomaticPenaltyConsequence(input: {
  intent: LiveEventControllerIntent;
  factGameTimeMs: number;
  beforeFacts: readonly ControllerGameFact[];
}): {
  operationId: string;
  sourceOperationId: string;
  factId: string;
  gameTimeMs: number;
  gameSideId: string | null;
  data: ActionJsonValue;
} | null {
  const { intent, factGameTimeMs, beforeFacts } = input;
  if (
    intent.type === "record-card" &&
    intent.foulBeforeScore === true &&
    (intent.cardType === "blue" || intent.cardType === "yellow")
  ) {
    const sourceFact = beforeFacts.find((fact) => fact.factId === intent.factId);
    const sourceSportingOrder = sourceFact?.sportingOrder ?? intent.sportingOrder ?? factGameTimeMs;
    const playerKey =
      intent.playerNumber === null
        ? `${intent.gameSideId}:unknown:${intent.factId}`
        : `${intent.gameSideId}:${intent.playerNumber}`;
    return {
      operationId: `${intent.operationId}-penalty-release`,
      sourceOperationId: intent.operationId,
      factId: `${intent.factId}-penalty-release`,
      gameTimeMs: factGameTimeMs,
      gameSideId: intent.gameSideId,
      data: {
        sourceFactId: intent.factId,
        playerKey,
        releaseCause: "foul-before-score",
        releasedMs: factGameTimeMs,
        serviceDurationMs: LIVE_PENALTY_MINUTE_MS,
        sportingOrder: sourceSportingOrder,
      },
    };
  }
  if (intent.type !== "record-goal") return null;
  const sourceFact = beforeFacts.find((fact) => fact.factId === intent.factId);
  const sourceSportingOrder = sourceFact?.sportingOrder ?? intent.sportingOrder ?? factGameTimeMs;
  const prospectiveFact = {
    factId: intent.factId,
    factType: "goal",
    gameSideId: intent.gameSideId,
    gameTimeMs: factGameTimeMs,
    sportingOrder: sourceSportingOrder,
    synchronizationOrder:
      beforeFacts.reduce((highest, fact) => Math.max(highest, fact.synchronizationOrder), 0) + 1,
    effective: true,
    data: {
      points: 10,
      sportingOrder: sourceSportingOrder,
    },
  } satisfies import("@/lib/live-event-penalties").LivePenaltyFact;
  const projected = deriveLivePenaltyProjection(
    beforeFacts.some((fact) => fact.factId === intent.factId)
      ? beforeFacts
      : [...beforeFacts, prospectiveFact],
    factGameTimeMs,
  );
  const release = projected.releases.find(
    (candidate) => candidate.scoreFactId === intent.factId && candidate.releaseCause === "score",
  );
  if (release === undefined) return null;
  const beforeProjection = deriveLivePenaltyProjection(beforeFacts, factGameTimeMs);
  const serviceDurationMs = Math.min(
    ...(beforeProjection.players
      .find((player) => player.playerKey === release.playerKey)
      ?.segments.filter(
        (segment) =>
          segment.expirableByScore &&
          segment.eligibleForScoreAtGameTimeMs <= factGameTimeMs &&
          segment.startsAtGameTimeMs <= factGameTimeMs &&
          segment.endsAtGameTimeMs > factGameTimeMs,
      )
      .map((segment) =>
        Math.max(
          0,
          Math.min(segment.endsAtGameTimeMs, factGameTimeMs + LIVE_PENALTY_MINUTE_MS) -
            factGameTimeMs,
        ),
      ) ?? [LIVE_PENALTY_MINUTE_MS]),
  );
  return {
    operationId: `${intent.operationId}-penalty-release`,
    sourceOperationId: intent.operationId,
    factId: `${intent.factId}-penalty-release`,
    gameTimeMs: factGameTimeMs,
    gameSideId: release.gameSideId,
    data: {
      sourceFactId: intent.factId,
      playerKey: release.playerKey,
      releaseCause: "score",
      releasedMs: factGameTimeMs,
      serviceDurationMs,
      sportingOrder: sourceSportingOrder,
    },
  };
}

function buildMissingAutomaticPenaltyConsequence(
  root: EventGameRecordRoot,
  actionsBefore: readonly {
    action: ControlAction;
    canonicalContent: string;
    contentFingerprint: string;
  }[],
  candidate: unknown,
): {
  operationId: string;
  sourceOperationId: string;
  factId: string;
  gameTimeMs: number;
  gameSideId: string | null;
  data: ActionJsonValue;
} | null {
  if (
    !isRecord(candidate) ||
    !isRecord(candidate.occurrence) ||
    typeof candidate.occurrence.trustedAtMs !== "number"
  ) {
    return null;
  }
  const acceptedAtMs = candidate.occurrence.trustedAtMs;
  const registry = createControlActionCodecRegistry(createDefaultControlActionCodecs());
  const prepared = prepareControlAction(candidate, root, registry, acceptedAtMs);
  if (!prepared.ok) return null;
  const candidateStored = {
    action: materializeControlAction(prepared.value, acceptedAtMs),
    canonicalContent: prepared.value.canonicalContent,
    contentFingerprint: prepared.value.contentFingerprint,
  };
  const prospectiveActions = [...actionsBefore, candidateStored];
  const prospective = rebuildLiveDerivedState(root, prospectiveActions);
  if (prospective?.penalties === undefined) return null;
  const knownSources = new Set(
    prospective.gameFacts.flatMap((fact) => {
      if (fact.factType !== "penalty-release-consequence" || !isRecord(fact.data)) return [];
      return typeof fact.data.sourceFactId === "string" ? [fact.data.sourceFactId] : [];
    }),
  );
  const release = prospective.penalties.releases.find(
    (candidateRelease) =>
      candidateRelease.sourceFactId.length > 0 && !knownSources.has(candidateRelease.sourceFactId),
  );
  if (release === undefined) return null;
  const sourceFact = prospective.gameFacts.find(
    (fact) => fact.factId === release.sourceFactId && fact.effective,
  );
  const sourceAction = prospectiveActions.find(({ action }) => {
    if (action.interpretation.type !== "fact" || !isRecord(action.interpretation.payload)) {
      return false;
    }
    return action.interpretation.payload.factId === release.sourceFactId;
  })?.action;
  if (sourceAction === undefined) return null;
  return {
    operationId: `${sourceAction.operationId}-penalty-release`,
    sourceOperationId: sourceAction.operationId,
    factId: `${release.sourceFactId}-penalty-release`,
    gameTimeMs: release.releasedMs,
    gameSideId: release.gameSideId,
    data: {
      sourceFactId: release.sourceFactId,
      playerKey: release.playerKey,
      releaseCause: release.releaseCause,
      releasedMs: release.releasedMs,
      serviceDurationMs: release.serviceDurationMs,
      sportingOrder: sourceFact?.sportingOrder ?? release.releasedMs,
    },
  };
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
  const rebuilt = rebuildLiveDerivedState(root, actions);
  if (rebuilt === null) return { status: "rejected" };
  const runningSinceMs = latestRunningClockStart(rebuilt.gameFacts);
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

function createHeatModeSnapshotAction(input: {
  root: EventGameRecordRoot;
  nowMs: number;
  enabled: boolean;
  gameTimeMs: number;
  shouldCommence: number | null;
  existingActions: readonly { action: ControlAction }[];
  causalPredecessorIds: readonly string[];
}): ControlActionInput | null {
  if (input.shouldCommence === null) return null;
  if (
    input.existingActions.some(
      ({ action }) =>
        action.interpretation.type === "fact" && action.interpretation.factType === "heat-mode",
    )
  )
    return null;
  const operationId = `heat-mode-snapshot-${input.root.eventGameId}`;
  return {
    recordId: input.root.recordId,
    eventGameId: input.root.eventGameId,
    operationId,
    kind: { id: "game-fact", version: "1" },
    payload: {
      factId: `heat-mode-${input.root.eventGameId}`,
      factType: "heat-mode",
      gameSideId: null,
      gameTimeMs: input.gameTimeMs,
      data: {
        enabled: input.enabled,
        source: "game-day",
        frozenAtCommencementMs: input.shouldCommence,
        sportingOrder: input.gameTimeMs,
      },
    },
    causalPredecessorIds: [...input.causalPredecessorIds],
    occurrence: {
      trustedAtMs: input.nowMs,
      clientOriginAtMs: null,
      source: "online",
    },
    grant: null,
    origin: "system-heat-stoppage",
    lifecycle: structuredClone(input.root.lifecycle),
  };
}

function createHeatTriggerActions(input: {
  root: EventGameRecordRoot;
  nowMs: number;
  currentGameTimeMs: number;
  targetGameTimeMs: number;
  enabledAtGameTimeMs: number | null;
  existingActions: readonly { action: ControlAction }[];
  causalPredecessorIds: readonly string[];
}): ControlActionInput[] {
  if (input.enabledAtGameTimeMs === null) return [];
  const existingTriggerTimes = new Set<number>();
  for (const { action } of input.existingActions) {
    if (
      action.interpretation.type !== "fact" ||
      action.interpretation.factType !== "heat-trigger"
    ) {
      continue;
    }
    const payload = action.interpretation.payload;
    const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
    if (typeof data?.triggerGameTimeMs === "number")
      existingTriggerTimes.add(data.triggerGameTimeMs);
  }
  const upperBound = Math.max(input.currentGameTimeMs, input.targetGameTimeMs);
  const triggerTimes: number[] = [];
  for (
    let trigger = firstHeatTriggerAfter(input.enabledAtGameTimeMs);
    trigger <= upperBound;
    trigger = nextHeatTrigger(trigger)
  ) {
    if (!existingTriggerTimes.has(trigger)) triggerTimes.push(trigger);
  }
  return triggerTimes.map((triggerGameTimeMs) => {
    const triggerId = heatTriggerId(triggerGameTimeMs);
    return {
      recordId: input.root.recordId,
      eventGameId: input.root.eventGameId,
      operationId: `materialize-${triggerId}`,
      kind: { id: "game-fact", version: "1" },
      payload: {
        factId: triggerId,
        factType: "heat-trigger",
        gameSideId: null,
        gameTimeMs: triggerGameTimeMs,
        data: {
          triggerId,
          triggerGameTimeMs,
          sportingOrder: triggerGameTimeMs,
        },
      },
      causalPredecessorIds: [...input.causalPredecessorIds],
      occurrence: { trustedAtMs: input.nowMs, clientOriginAtMs: null, source: "online" },
      grant: null,
      origin: "system-heat-stoppage",
      lifecycle: structuredClone(input.root.lifecycle),
    };
  });
}

function latestRunningClockStart(facts: readonly ControllerGameFact[]): number | null {
  for (const fact of [...facts].reverse()) {
    if (!fact.effective || fact.factType !== "clock" || !isRecord(fact.data)) continue;
    if (fact.data.running !== true) return null;
    return typeof fact.data.startedAtMs === "number" ? fact.data.startedAtMs : null;
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
    intent.type === "record-card" ||
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

function deriveControllerPenaltyStart(
  root: EventGameRecordRoot,
  gameTimeMs: number,
  seekerPenalty: "head-referee-confirmed" | undefined,
): LivePenaltyStart {
  if (root.lifecycle.commencedAtMs === null) return "sticks-up";
  return seekerPenalty === "head-referee-confirmed" &&
    gameTimeMs >= 19 * LIVE_PENALTY_MINUTE_MS &&
    gameTimeMs < LIVE_SEEKER_RELEASE_MS
    ? "seeker-release"
    : "immediate";
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
  const suspension = readLiveSuspensionState(value.suspension);
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
    suspension,
    stoppage,
    heat,
    result,
    overtime,
    overtimeTarget: overtimeTarget === "missing" ? null : overtimeTarget,
    winnerGameSideId: winnerGameSideId.status === "value" ? winnerGameSideId.value : null,
    catch: catchState === "missing" ? null : catchState,
    gameFacts,
    penalties: deriveLivePenaltyProjection(gameFacts, clock.gameTimeMs),
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
      trustedAtMs:
        typeof candidate.trustedAtMs === "number" && Number.isSafeInteger(candidate.trustedAtMs)
          ? candidate.trustedAtMs
          : 0,
      acceptedAtMs:
        typeof candidate.acceptedAtMs === "number" && Number.isSafeInteger(candidate.acceptedAtMs)
          ? candidate.acceptedAtMs
          : 0,
      effective: candidate.effective,
      data: data.value,
    });
  }
  return facts;
}

function readLiveTimeoutState(value: unknown): LiveTimeoutState {
  if (value === undefined) return { status: "inactive", factId: null };
  if (!isRecord(value)) throw new Error("Derived timeout state is invalid.");
  if (
    value.status !== "inactive" &&
    value.status !== "stoppage" &&
    value.status !== "started" &&
    value.status !== "completed"
  ) {
    throw new Error("Derived timeout status is invalid.");
  }
  const factId =
    value.factId === null ? null : validateOpaqueIdentifier(value.factId, "timeout.factId");
  if (factId !== null && !factId.ok) throw new Error("Derived timeout fact is invalid.");
  const gameSideId =
    value.gameSideId === undefined || value.gameSideId === null
      ? null
      : validateOpaqueIdentifier(value.gameSideId, "timeout.gameSideId");
  if (gameSideId !== null && !gameSideId.ok) throw new Error("Derived timeout side is invalid.");
  const usedGameSideIds = value.usedGameSideIds === undefined ? [] : value.usedGameSideIds;
  if (
    !Array.isArray(usedGameSideIds) ||
    usedGameSideIds.some((sideId) => !validateOpaqueIdentifier(sideId, "timeout.usedGameSideId").ok)
  ) {
    throw new Error("Derived timeout entitlements are invalid.");
  }
  const startedAtMs =
    value.startedAtMs === undefined || value.startedAtMs === null
      ? null
      : validateIntegerInRange(
          value.startedAtMs,
          0,
          Number.MAX_SAFE_INTEGER,
          "timeout.startedAtMs",
        );
  const remainingMs =
    value.remainingMs === undefined || value.remainingMs === null
      ? null
      : validateIntegerInRange(value.remainingMs, 0, 60_000, "timeout.remainingMs");
  if (startedAtMs !== null && !startedAtMs.ok) throw new Error("Derived timeout start is invalid.");
  if (remainingMs !== null && !remainingMs.ok)
    throw new Error("Derived timeout remaining time is invalid.");
  const cue = value.longWhistleCue ?? "not-applicable";
  if (cue !== "not-applicable" && cue !== "pending" && cue !== "due" && cue !== "passed") {
    throw new Error("Derived timeout cue is invalid.");
  }
  return {
    status: value.status,
    factId: factId === null ? null : factId.value,
    gameSideId: gameSideId === null ? null : gameSideId.value,
    usedGameSideIds: usedGameSideIds as string[],
    startedAtMs: startedAtMs === null ? null : startedAtMs.value,
    remainingMs: remainingMs === null ? null : remainingMs.value,
    longWhistleCue: cue,
  };
}

function readLiveSuspensionState(value: unknown): LiveSuspensionState {
  if (value === undefined) return { status: "none", factId: null, snapshot: null };
  if (!isRecord(value)) throw new Error("Derived suspension state is invalid.");
  if (value.status !== "none" && value.status !== "suspended") {
    throw new Error("Derived suspension status is invalid.");
  }
  const factId =
    value.factId === null ? null : validateOpaqueIdentifier(value.factId, "suspension.factId");
  if (factId !== null && !factId.ok) throw new Error("Derived suspension fact is invalid.");
  if (value.snapshot === null || value.snapshot === undefined) {
    return { status: value.status, factId: factId === null ? null : factId.value, snapshot: null };
  }
  const parsed = parseLiveSuspensionSnapshot(value.snapshot);
  if (!parsed.ok) throw new Error("Derived suspension snapshot is invalid.");
  return {
    status: value.status,
    factId: factId === null ? null : factId.value,
    snapshot: parsed.value,
  };
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
    value.status !== "required-skip" &&
    value.status !== "suppressed" &&
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
  const allowedDurationMs =
    value.allowedDurationMs === undefined || value.allowedDurationMs === null
      ? ({ ok: true, value: null } as const)
      : validateIntegerInRange(
          value.allowedDurationMs,
          0,
          SHARED_LIMITS.clock.maxMs,
          "heat.allowedDurationMs",
        );
  const actualDurationMs =
    value.actualDurationMs === undefined || value.actualDurationMs === null
      ? ({ ok: true, value: null } as const)
      : validateIntegerInRange(
          value.actualDurationMs,
          0,
          SHARED_LIMITS.clock.maxMs,
          "heat.actualDurationMs",
        );
  const rawActualDurationMs =
    value.rawActualDurationMs === undefined || value.rawActualDurationMs === null
      ? ({ ok: true, value: null } as const)
      : validateIntegerInRange(
          value.rawActualDurationMs,
          0,
          SHARED_LIMITS.clock.maxMs,
          "heat.rawActualDurationMs",
        );
  const completionAtTrustedAtMs =
    value.completionAtTrustedAtMs === undefined || value.completionAtTrustedAtMs === null
      ? ({ ok: true, value: null } as const)
      : validateIntegerInRange(
          value.completionAtTrustedAtMs,
          0,
          Number.MAX_SAFE_INTEGER,
          "heat.completionAtTrustedAtMs",
        );
  const mode =
    value.mode === undefined
      ? ({ ok: true, value: undefined } as const)
      : value.mode === "enabled" || value.mode === "disabled"
        ? ({ ok: true, value: value.mode } as const)
        : ({ ok: false, error: "heat.mode is invalid." } as const);
  const completedAtAllowed =
    value.completedAtAllowed === undefined
      ? ({ ok: true, value: false } as const)
      : typeof value.completedAtAllowed === "boolean"
        ? ({ ok: true, value: value.completedAtAllowed } as const)
        : ({ ok: false, error: "heat.completedAtAllowed is invalid." } as const);
  const pendingTriggerGameTimeMs =
    value.pendingTriggerGameTimeMs === undefined || value.pendingTriggerGameTimeMs === null
      ? ({ ok: true, value: null } as const)
      : validateIntegerInRange(
          value.pendingTriggerGameTimeMs,
          0,
          SHARED_LIMITS.clock.maxMs,
          "heat.pendingTriggerGameTimeMs",
        );
  const nextTriggerGameTimeMs =
    value.nextTriggerGameTimeMs === undefined || value.nextTriggerGameTimeMs === null
      ? ({ ok: true, value: null } as const)
      : validateIntegerInRange(
          value.nextTriggerGameTimeMs,
          0,
          SHARED_LIMITS.clock.maxMs,
          "heat.nextTriggerGameTimeMs",
        );
  const pendingTrigger =
    value.pendingTrigger === undefined || value.pendingTrigger === null
      ? ({ ok: true, value: null } as const)
      : isRecord(value.pendingTrigger) &&
          typeof value.pendingTrigger.index === "number" &&
          Number.isSafeInteger(value.pendingTrigger.index) &&
          value.pendingTrigger.index >= 0 &&
          pendingTriggerGameTimeMs.ok &&
          pendingTriggerGameTimeMs.value !== null
        ? ({
            ok: true,
            value: {
              gameTimeMs: pendingTriggerGameTimeMs.value,
              index: value.pendingTrigger.index,
            },
          } as const)
        : ({ ok: false, error: "heat.pendingTrigger is invalid." } as const);
  const triggerDecision =
    value.triggerDecision === undefined || value.triggerDecision === null
      ? ({ ok: true, value: null } as const)
      : value.triggerDecision === "end-of-drive" ||
          value.triggerDecision === "dead-volleyball" ||
          value.triggerDecision === "other-stoppage" ||
          value.triggerDecision === "skip" ||
          value.triggerDecision === "skip-required"
        ? ({ ok: true, value: value.triggerDecision } as const)
        : ({ ok: false, error: "heat.triggerDecision is invalid." } as const);
  if (
    !startedAtGameTimeMs.ok ||
    !nominalDurationMs.ok ||
    !allowedDurationMs.ok ||
    !actualDurationMs.ok ||
    !rawActualDurationMs.ok ||
    !completionAtTrustedAtMs.ok ||
    !mode.ok ||
    !completedAtAllowed.ok ||
    !pendingTriggerGameTimeMs.ok ||
    !nextTriggerGameTimeMs.ok ||
    !pendingTrigger.ok ||
    !triggerDecision.ok ||
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
    allowedDurationMs: allowedDurationMs.value,
    actualDurationMs: actualDurationMs.value,
    completedAtAllowed: completedAtAllowed.value,
    rawActualDurationMs: rawActualDurationMs.value,
    completionAtTrustedAtMs: completionAtTrustedAtMs.value,
    ...(mode.value === undefined ? {} : { mode: mode.value }),
    pendingTriggerId: readOptionalIdentifier(value.pendingTriggerId, "heat.pendingTriggerId"),
    pendingTriggerGameTimeMs: pendingTriggerGameTimeMs.value,
    nextTriggerGameTimeMs: nextTriggerGameTimeMs.value,
    pendingTrigger: pendingTrigger.value,
    trigger:
      value.trigger === undefined || value.trigger === null
        ? null
        : isRecord(value.trigger) &&
            typeof value.trigger.id === "string" &&
            validateOpaqueIdentifier(value.trigger.id, "heat.trigger.id").ok &&
            typeof value.trigger.gameTimeMs === "number" &&
            Number.isSafeInteger(value.trigger.gameTimeMs) &&
            typeof value.trigger.index === "number" &&
            Number.isSafeInteger(value.trigger.index) &&
            value.trigger.index >= 0
          ? {
              id: String(value.trigger.id),
              gameTimeMs: value.trigger.gameTimeMs,
              index: value.trigger.index,
            }
          : (() => {
              throw new Error("Derived heat trigger is invalid.");
            })(),
    permittedExtensionTriggerId: readOptionalIdentifier(
      value.permittedExtensionTriggerId,
      "heat.permittedExtensionTriggerId",
    ),
    activeTriggerId: readOptionalIdentifier(value.activeTriggerId, "heat.activeTriggerId"),
    triggerDecision: triggerDecision.value,
  };
}

function readOptionalIdentifier(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  const parsed = validateOpaqueIdentifier(value, field);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
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
  projectedAtMs = 0,
  configuredHeatMode = false,
  nowMs = 0,
): LiveEventGameDerivedState | null {
  try {
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
      projectedAtMs,
      configuredHeatMode,
      nowMs,
    );
  } catch {
    return null;
  }
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
  configuredDodgeballIds: readonly string[] | null = null,
): { status: "accepted" } | { status: "rejected"; reason: "invalid-action"; detail: string } {
  const clockValidation = validateLiveEventClockActionInTransaction(actions, candidate);
  if (clockValidation.status === "rejected") return clockValidation;

  const current = rebuildLiveDerivedState(
    root,
    actions,
    candidate.occurrence.trustedAtMs,
    false,
    candidate.occurrence.trustedAtMs,
  );
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
    if (candidate.override !== undefined) {
      return rejectedLiveAction("Official Overrides cannot be attached to a Correction.");
    }
    const prepared = prepareControlAction(
      candidate,
      { ...root, lifecycle: candidate.lifecycle },
      createControlActionCodecRegistry(createDefaultControlActionCodecs()),
      candidate.occurrence.trustedAtMs,
      { allowConcurrentTeamAssignment: true },
    );
    if (!prepared.ok) return rejectedLiveAction("The Correction could not be prepared.");
    const prospective = rebuildLiveDerivedState(
      root,
      [
        ...actions,
        {
          action: candidate,
          canonicalContent: prepared.value.canonicalContent,
          contentFingerprint: prepared.value.contentFingerprint,
        },
      ],
      candidate.acceptedAtMs,
    );
    if (prospective === null) {
      return rejectedLiveAction(
        "The Correction would leave suspension and Clock state inconsistent.",
      );
    }
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
  const currentPhaseIsSuspended = current.phase === "suspended";
  if (
    candidate.interpretation.factType === "clock" &&
    data?.running === true &&
    currentPhaseIsSuspended
  ) {
    return rejectedLiveAction("A suspended game must be resumed before the clock can restart.");
  }
  if (candidate.interpretation.factType === "penalty-reason") {
    const targetCardFactId = data?.targetCardFactId;
    if (
      typeof targetCardFactId !== "string" ||
      !actions.some(
        ({ action }) =>
          action.interpretation.type === "fact" &&
          action.interpretation.factId === targetCardFactId &&
          action.interpretation.factType === "card",
      )
    ) {
      return rejectedLiveAction("A Penalty Reason must refer to an accepted card fact.");
    }
  }
  if (candidate.interpretation.factType === "penalty-release-consequence") {
    const sourceFactId = data?.sourceFactId;
    const playerKey = data?.playerKey;
    const releaseCause = data?.releaseCause;
    const source =
      typeof sourceFactId === "string"
        ? actions.find(
            ({ action }) =>
              action.interpretation.type === "fact" &&
              action.interpretation.factId === sourceFactId,
          )
        : undefined;
    if (
      source === undefined ||
      typeof playerKey !== "string" ||
      (releaseCause !== "score" && releaseCause !== "foul-before-score") ||
      (releaseCause === "score" &&
        source.action.interpretation.type === "fact" &&
        source.action.interpretation.factType !== "goal") ||
      (releaseCause === "foul-before-score" &&
        (source.action.interpretation.type !== "fact" ||
          source.action.interpretation.factType !== "card"))
    ) {
      return rejectedLiveAction("The automatic Penalty Release consequence is invalid.");
    }
  }
  if (candidate.interpretation.factType === "penalty-release") {
    const pendingId = data?.pendingId;
    const scoreFactId = data?.scoreFactId;
    const playerKey = data?.playerKey;
    const scoreFact =
      typeof scoreFactId === "string"
        ? current.gameFacts.find(
            (fact) => fact.factId === scoreFactId && fact.factType === "goal" && fact.effective,
          )
        : undefined;
    const scoreGameTimeMs = scoreFact?.gameTimeMs ?? scoreFact?.sportingOrder;
    const releaseSportingOrder =
      data !== null && typeof data.sportingOrder === "number" ? data.sportingOrder : null;
    const factsThroughScore =
      scoreFact === undefined
        ? []
        : current.gameFacts.filter((fact) => compareLivePenaltyFactOrder(fact, scoreFact) <= 0);
    const scoreProjection =
      scoreGameTimeMs === undefined
        ? null
        : deriveLivePenaltyProjection(factsThroughScore, scoreGameTimeMs);
    const existingEffectiveChoice =
      typeof scoreFactId === "string"
        ? current.gameFacts.find(
            (fact) =>
              fact.factType === "penalty-release" &&
              fact.effective &&
              isRecord(fact.data) &&
              fact.data.scoreFactId === scoreFactId,
          )
        : undefined;
    const pending =
      typeof pendingId === "string" && typeof scoreFactId === "string"
        ? scoreProjection?.pendingExpirations.find(
            (expiration) => expiration.id === pendingId && expiration.scoreFactId === scoreFactId,
          )
        : undefined;
    if (
      pending === undefined ||
      typeof playerKey !== "string" ||
      !pending.candidatePlayerKeys.includes(playerKey) ||
      gameTimeMs !== scoreGameTimeMs ||
      releaseSportingOrder !== scoreFact?.sportingOrder ||
      (existingEffectiveChoice !== undefined &&
        existingEffectiveChoice.factId !== candidate.interpretation.factId)
    ) {
      return rejectedLiveAction("The Penalty Release choice is no longer valid.");
    }
  }
  if (candidate.interpretation.factType === "heat-stoppage") {
    const heatAction = data?.heatAction;
    if (!isLiveHeatAction(heatAction)) {
      return rejectedLiveAction("heatAction is required for Heat Stoppage operations.");
    }
    const hasFrozenMode = current.gameFacts.some((fact) => fact.factType === "heat-mode");
    if (heatAction === "enable" || heatAction === "disable") {
      if (root.lifecycle.commencedAtMs === null) {
        return rejectedLiveAction(
          "Heat Stoppage Mode follows Game Day configuration before commencement.",
        );
      }
    }
    const requiresTrigger = heatAction !== "enable" && heatAction !== "disable";
    const resolvesTrigger =
      heatAction === "start" ||
      heatAction === "end-of-drive" ||
      heatAction === "dead-volleyball" ||
      heatAction === "other-stoppage" ||
      heatAction === "skip" ||
      heatAction === "skip-required" ||
      heatAction === "suppress";
    if (hasFrozenMode && requiresTrigger && current.heat.mode !== "enabled") {
      return rejectedLiveAction("Heat Stoppage Mode is disabled.");
    }
    if (hasFrozenMode && resolvesTrigger && current.heat.pendingTriggerGameTimeMs === null) {
      return rejectedLiveAction("A Heat Stoppage Trigger is not pending.");
    }
    const suppliedTriggerId =
      typeof data?.heatTriggerId === "string"
        ? data.heatTriggerId
        : typeof data?.triggerId === "string"
          ? data.triggerId
          : null;
    if (hasFrozenMode && resolvesTrigger && suppliedTriggerId !== current.heat.pendingTriggerId) {
      return rejectedLiveAction("The Heat Stoppage Trigger identity is stale or mismatched.");
    }
    if (hasFrozenMode && resolvesTrigger && current.heat.pendingTriggerGameTimeMs !== gameTimeMs) {
      return rejectedLiveAction("The Heat Stoppage Trigger game time is stale or mismatched.");
    }
    if (
      hasFrozenMode &&
      heatAction === "end" &&
      suppliedTriggerId !== current.heat.activeTriggerId
    ) {
      return rejectedLiveAction("The Heat Stoppage end is not linked to the active trigger.");
    }
    if (
      hasFrozenMode &&
      heatAction === "extend" &&
      ((current.heat.status === "ended" &&
        !(current.heat.completedAtAllowed === true && candidate.override !== undefined)) ||
        suppliedTriggerId !== current.heat.activeTriggerId)
    ) {
      return rejectedLiveAction(
        current.heat.status === "ended" && current.heat.completedAtAllowed !== true
          ? "An ended Heat Stoppage cannot be extended."
          : "The Heat Stoppage extension is not linked to the active trigger.",
      );
    }
    if (
      hasFrozenMode &&
      heatAction === "extend-permitted" &&
      suppliedTriggerId !== current.heat.permittedExtensionTriggerId
    ) {
      return rejectedLiveAction(
        "The permitted Heat Stoppage extension is linked to another trigger.",
      );
    }
    if (
      (heatAction === "start" ||
        heatAction === "end-of-drive" ||
        heatAction === "dead-volleyball" ||
        heatAction === "other-stoppage") &&
      Math.abs(
        (Object.values(current.scoreByGameSide)[0] ?? 0) -
          (Object.values(current.scoreByGameSide)[1] ?? 0),
      ) <= 10 &&
      candidate.override === undefined
    ) {
      return rejectedLiveAction("The within-one-goal Heat Stoppage requires an ordinary skip.");
    }
    if (heatAction === "skip" || heatAction === "skip-required") {
      const scores = Object.values(current.scoreByGameSide);
      const scoreDifference = Math.abs((scores[0] ?? 0) - (scores[1] ?? 0));
      if (heatAction === "skip" && scoreDifference <= 10 && candidate.override === undefined) {
        return rejectedLiveAction("A within-one-goal Heat Stoppage requires skip-required.");
      }
      if (scoreDifference > 10 && candidate.override === undefined) {
        return rejectedLiveAction("A within-one-goal Heat Stoppage skip is not eligible.");
      }
    }
    if (
      heatAction === "extend-permitted" &&
      (current.heat.factId === null ||
        current.heat.startedAtGameTimeMs === null ||
        (current.heat.status !== "started" &&
          current.heat.status !== "extended" &&
          current.heat.status !== "required-skip"))
    ) {
      return rejectedLiveAction("A permitted Heat Stoppage extension requires an active timer.");
    }
    if (heatAction === "extend-permitted" && current.heat.permittedExtensionTriggerId === null) {
      if (candidate.override === undefined) {
        return rejectedLiveAction(
          "A permitted Heat Stoppage extension must follow the linked required skip.",
        );
      }
    }
    if (
      heatAction === "extend-permitted" &&
      current.heat.permittedExtensionTriggerId !== null &&
      suppliedTriggerId !== current.heat.permittedExtensionTriggerId
    ) {
      return rejectedLiveAction(
        "The permitted Heat Stoppage extension is linked to another trigger.",
      );
    }
  }
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
        root,
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
  if (candidate.interpretation.factType === "timeout") {
    if (data === null) return rejectedLiveAction("Timeout action and Game Side are required.");
    const timeoutAction = readTimeoutAction(data);
    if (timeoutAction === null || typeof data.timeoutGameSideId !== "string") {
      return rejectedLiveAction("Timeout action and Game Side are required.");
    }
    if (timeoutAction === "stoppage") {
      if (current.timeout.status === "stoppage" || current.timeout.status === "started") {
        return rejectedLiveAction("Another Team Timeout procedure is already active.");
      }
      if (current.timeout.usedGameSideIds?.includes(data.timeoutGameSideId)) {
        return rejectedLiveAction("Each Game Side may use only one timeout.");
      }
    }
    if (timeoutAction === "start") {
      if (current.clock.running) {
        return rejectedLiveAction("The timeout minute cannot start while play is running.");
      }
      if (
        current.timeout.status !== "stoppage" ||
        current.timeout.gameSideId !== data.timeoutGameSideId
      ) {
        return rejectedLiveAction("The timeout minute must match its active stoppage Game Side.");
      }
    }
    if (timeoutAction === "complete") {
      if (
        current.timeout.status !== "started" ||
        current.timeout.factId === null ||
        data.timeoutSourceFactId !== current.timeout.factId
      ) {
        return rejectedLiveAction("Timeout completion must target the effective timeout minute.");
      }
    }
  }
  if (candidate.interpretation.factType === "suspension") {
    const suspensionAction =
      data?.suspensionAction === "start" || data?.suspensionAction === "resume"
        ? data.suspensionAction
        : null;
    if (suspensionAction === null) {
      return rejectedLiveAction("Suspension action is required.");
    }
    if (suspensionAction === "start" && current.suspension.status === "suspended") {
      return rejectedLiveAction("An effective suspension is already active.");
    }
    if (suspensionAction === "start" && current.clock.running) {
      return rejectedLiveAction("A Game may be suspended only while play is stopped.");
    }
    if (suspensionAction === "resume") {
      if (current.phase !== "suspended" || current.suspension.factId === null) {
        return rejectedLiveAction("A resume requires an effective suspension.");
      }
      if (data?.resumesSuspensionFactId !== current.suspension.factId) {
        return rejectedLiveAction("Resume must target the effective suspension fact.");
      }
    }
    if (suspensionAction === "start") {
      if (data?.suspensionSnapshot === undefined) {
        return rejectedLiveAction("Suspension snapshot is required.");
      }
      const parsedSnapshot = parseLiveSuspensionSnapshot(data.suspensionSnapshot);
      if (!parsedSnapshot.ok) return rejectedLiveAction(parsedSnapshot.error);
      const canonicalSnapshot = canonicalizeLiveSuspensionSnapshot(
        parsedSnapshot.value,
        current,
        candidate.acceptedAtMs,
        configuredDodgeballIds,
      );
      if (!canonicalSnapshot.ok) return rejectedLiveAction(canonicalSnapshot.error);
    }
  }
  const expected =
    candidate.interpretation.factType === "penalty-release-consequence"
      ? null
      : closePair.fact !== null && sportingOrderAdjudication !== null
        ? expectedClosePlayOverride(closePair.fact, gameTimeMs, sportingOrderAdjudication)
        : expectedLiveOverride(candidate, current, sportingOrderDiffers, gameTimeMs, data, root);
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
  root: EventGameRecordRoot,
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
    if (data?.timeoutAction !== "stoppage") return null;
    return {
      required: true,
      guardrail: "timeout-requires-paused-play",
      direction: "head-referee-directed-timeout-while-running",
      beforeValue: { running: current.clock.running },
      afterValue: { timeout: "stoppage" },
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
    if (heatAction === "enable" || heatAction === "disable") {
      if (root.lifecycle.commencedAtMs === null) return null;
      return {
        required: true,
        guardrail: "heat-stoppage-mode-change",
        direction: "head-referee-directed-heat-mode-change",
        beforeValue: { heatMode: current.heat.mode === "enabled" },
        afterValue: { heatMode: heatAction === "enable" },
        gameTimeMs,
      };
    }
    if (heatAction === "suppress") {
      const pendingTriggerGameTimeMs = current.heat.pendingTriggerGameTimeMs;
      if (typeof pendingTriggerGameTimeMs !== "number") return null;
      return {
        required: true,
        guardrail: "heat-stoppage-rule-deviation",
        direction: "head-referee-directed-heat-stoppage",
        beforeValue: { pendingTriggerGameTimeMs },
        afterValue: { trigger: "suppressed" },
        gameTimeMs,
      };
    }
    if (
      heatAction === "start" ||
      heatAction === "end-of-drive" ||
      heatAction === "dead-volleyball" ||
      heatAction === "other-stoppage"
    ) {
      const scores = Object.values(current.scoreByGameSide);
      const scoreDifference = Math.abs((scores[0] ?? 0) - (scores[1] ?? 0));
      if (scoreDifference <= 10) {
        return {
          required: true,
          guardrail: "heat-stoppage-rule-deviation",
          direction: "head-referee-directed-heat-stoppage",
          beforeValue: { heat: "pending", requiredDecision: "skip" },
          afterValue: { heat: heatAction },
          gameTimeMs,
        };
      }
    }
    if (heatAction === "skip" || heatAction === "skip-required") {
      const scores = Object.values(current.scoreByGameSide);
      const scoreDifference = Math.abs((scores[0] ?? 0) - (scores[1] ?? 0));
      if (scoreDifference > 10 || heatAction === "skip") {
        return {
          required: true,
          guardrail: "heat-stoppage-rule-deviation",
          direction: "head-referee-directed-heat-stoppage",
          beforeValue: { scoreDifference },
          afterValue: { heat: "skipped" },
          gameTimeMs,
        };
      }
    }
    if (
      heatAction === "extend-permitted" &&
      current.heat.nominalDurationMs !== null &&
      current.heat.allowedDurationMs !== null &&
      current.heat.allowedDurationMs !== undefined &&
      (current.heat.actualDurationMs ?? 0) > current.heat.allowedDurationMs
    ) {
      return {
        required: true,
        guardrail: "heat-stoppage-rule-deviation",
        direction: "head-referee-directed-heat-stoppage",
        beforeValue: {
          heat: current.heat.status,
          nominalDurationMs: current.heat.nominalDurationMs,
          actualDurationMs: current.heat.actualDurationMs ?? 0,
        },
        afterValue: { heat: "extended" },
        gameTimeMs,
      };
    }
    if (heatAction === "extend-permitted" && current.heat.permittedExtensionTriggerId === null) {
      return {
        required: true,
        guardrail: "heat-stoppage-rule-deviation",
        direction: "head-referee-directed-heat-stoppage",
        beforeValue: { permittedExtensionTriggerId: null },
        afterValue: { heat: "extended" },
        gameTimeMs,
      };
    }
    if (heatAction === "extend") {
      if (
        (current.heat.status !== "started" &&
          current.heat.status !== "extended" &&
          !(current.heat.status === "ended" && current.heat.completedAtAllowed === true)) ||
        current.heat.startedAtGameTimeMs === null ||
        current.heat.nominalDurationMs === null
      ) {
        return null;
      }
      return {
        required: true,
        guardrail: "heat-stoppage-rule-deviation",
        direction: "head-referee-directed-heat-stoppage",
        beforeValue:
          typeof current.heat.actualDurationMs === "number" &&
          current.heat.actualDurationMs >= current.heat.nominalDurationMs
            ? {
                heat: current.heat.status,
                nominalDurationMs: current.heat.nominalDurationMs,
                actualDurationMs: current.heat.actualDurationMs,
              }
            : { heat: current.heat.status },
        afterValue: { heat: "extended" },
        gameTimeMs,
      };
    }
    const offlineLateCompletion =
      current.heat.completedAtAllowed === true &&
      candidate.occurrence.source === "offline" &&
      typeof current.heat.completionAtTrustedAtMs === "number" &&
      candidate.occurrence.trustedAtMs > current.heat.completionAtTrustedAtMs;
    if (
      heatAction !== "end" ||
      (current.heat.status !== "started" &&
        current.heat.status !== "extended" &&
        !offlineLateCompletion) ||
      current.heat.startedAtGameTimeMs === null ||
      current.heat.nominalDurationMs === null ||
      current.heat.allowedDurationMs === null ||
      current.heat.allowedDurationMs === undefined
    ) {
      return null;
    }
    const actualDurationMs =
      (offlineLateCompletion ? current.heat.rawActualDurationMs : current.heat.actualDurationMs) ??
      0;
    if (current.heat.completedAtAllowed === true && !offlineLateCompletion) {
      if (candidate.override === undefined) return null;
      return {
        required: false,
        guardrail: "heat-stoppage-rule-deviation",
        direction: "head-referee-directed-heat-stoppage",
        beforeValue: {
          heat: current.heat.status,
          nominalDurationMs: current.heat.nominalDurationMs,
          actualDurationMs: current.heat.actualDurationMs ?? current.heat.allowedDurationMs,
        },
        afterValue: { heat: "ended" },
        gameTimeMs,
      };
    }
    if (actualDurationMs < current.heat.allowedDurationMs) {
      return {
        required: true,
        guardrail: "heat-stoppage-rule-deviation",
        direction: "head-referee-directed-heat-stoppage",
        beforeValue: { heat: current.heat.status },
        afterValue: { heat: "ended" },
        gameTimeMs,
      };
    }
    if (actualDurationMs === current.heat.allowedDurationMs) {
      return null;
    }
    return {
      required: true,
      guardrail: "heat-stoppage-rule-deviation",
      direction: "head-referee-directed-heat-stoppage",
      beforeValue:
        actualDurationMs > current.heat.allowedDurationMs
          ? {
              heat: current.heat.status,
              nominalDurationMs: current.heat.nominalDurationMs,
              actualDurationMs,
            }
          : { heat: current.heat.status },
      afterValue: { heat: "ended" },
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
    !matchesLiveOverrideBeforeValue(override.beforeValue, expected) ||
    canonicalizeJson(override.afterValue) !== canonicalizeJson(expected.afterValue)
  ) {
    return rejectedLiveAction("Official Override evidence does not match effective state.");
  }
  return { status: "accepted" };
}

function matchesLiveOverrideBeforeValue(
  supplied: ActionJsonValue,
  expected: LiveOverrideExpectation,
): boolean {
  if (canonicalizeJson(supplied) === canonicalizeJson(expected.beforeValue)) return true;
  if (expected.guardrail !== "heat-stoppage-rule-deviation") return false;
  if (!isRecord(supplied) || !isRecord(expected.beforeValue)) return false;
  if (
    typeof supplied.actualDurationMs !== "number" ||
    !Number.isFinite(supplied.actualDurationMs) ||
    supplied.actualDurationMs < 0 ||
    typeof expected.beforeValue.actualDurationMs !== "number"
  ) {
    return false;
  }
  const { actualDurationMs: _suppliedActual, ...suppliedGuardrail } = supplied;
  const { actualDurationMs: _expectedActual, ...expectedGuardrail } = expected.beforeValue;
  return canonicalizeJson(suppliedGuardrail) === canonicalizeJson(expectedGuardrail);
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
      grant: { sessionId: string } | null;
      interpretation: unknown;
    };
    operationId?: string;
    occurrence?: { trustedAtMs: number; source: "online" | "offline" };
    acceptedAtMs?: number;
    grant?: { sessionId: string } | null;
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
      storedAction.grant === null ||
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
      if (isRecord(data) && typeof data.cardType === "string") {
        // Live penalty timing is rebuilt from the sporting Game Clock. The
        // legacy trigger-only card fact retains the clock-authority signal
        // used by the earlier live-control slice.
        continue;
      }
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

function retryableAction(
  operationId: string | null,
  replayReservationId?: string,
): LiveEventGameControlResult {
  return {
    status: "retryable",
    message: "Controller action was not committed; retry is safe.",
    operationId,
    ...(replayReservationId === undefined ? {} : { replayReservationId }),
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

function isLiveHeatAction(value: unknown): value is LiveHeatAction {
  return (
    value === "start" ||
    value === "end" ||
    value === "skip-required" ||
    value === "extend-permitted" ||
    value === "extend" ||
    value === "end-of-drive" ||
    value === "dead-volleyball" ||
    value === "other-stoppage" ||
    value === "skip" ||
    value === "suppress" ||
    value === "enable" ||
    value === "disable"
  );
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
    ...(intent.type === "substantive" ? { heatAction: intent.heatAction } : {}),
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
