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

type ControllerIntentBase = {
  version: typeof LIVE_EVENT_CONTROL_INTENT_VERSION;
  operationId: string;
  factId: string;
  gameTimeMs: number;
  occurrence: {
    clientOriginAtMs: number | null;
  };
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
};

export type ControllerProjection = {
  eventGameId: string;
  phase: EventGameLifecyclePhase;
  scoreByGameSide: Readonly<Record<string, number>>;
  goalCount: number;
  commencement: ControllerCommencement;
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
  if (
    value.type !== "record-goal" &&
    value.type !== "clock" &&
    value.type !== "set-running" &&
    value.type !== "substantive" &&
    value.type !== "reset" &&
    value.type !== "undo"
  )
    return invalid("Controller intent type is unsupported.");

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
  if (value.type === "clock" || value.type === "set-running") {
    if (typeof value.running !== "boolean") return invalid("running must be a boolean.");
    running = value.running;
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
  return {
    ok: true,
    value: {
      version: LIVE_EVENT_CONTROL_INTENT_VERSION,
      type: value.type,
      operationId: operationId.value,
      factId: factId.value,
      gameTimeMs: gameTimeMs.value,
      occurrence: { clientOriginAtMs },
      ...(gameSideId === undefined ? {} : { gameSideId }),
      ...(running === undefined ? {} : { running }),
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
            : parsed.value.type === "clock" || parsed.value.type === "set-running"
              ? { running: parsed.value.running, startedAtMs: clockStartMs }
              : parsed.value.type === "substantive"
                ? { trigger: parsed.value.trigger }
                : null,
      },
      causalPredecessorIds: [],
      occurrence: {
        trustedAtMs: nowMs,
        clientOriginAtMs: parsed.value.occurrence.clientOriginAtMs,
        source: "online",
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
  };
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

function controllerFactType(intent: LiveEventControllerIntent): string {
  if (intent.type === "record-goal") return "goal";
  if (intent.type === "clock" || intent.type === "set-running") return "clock";
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
