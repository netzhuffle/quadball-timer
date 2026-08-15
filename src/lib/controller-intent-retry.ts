import {
  LIVE_EVENT_CONTROL_INTENT_VERSION,
  type LiveEventControllerIntent,
} from "@/lib/live-event-game-control";

export type PendingControllerIntent = LiveEventControllerIntent;
export type PendingControllerGoalIntent = Extract<
  LiveEventControllerIntent,
  { type: "record-goal" }
>;

/** Reuses one immutable intent while a response is uncertain, for every control. */
export function retainControllerIntent(
  pending: PendingControllerIntent | null,
  candidate: PendingControllerIntent,
): PendingControllerIntent {
  return pending !== null &&
    controllerIntentRetryKey(pending) === controllerIntentRetryKey(candidate)
    ? pending
    : candidate;
}

export function controllerIntentRetryKey(intent: LiveEventControllerIntent): string {
  switch (intent.type) {
    case "record-goal":
      return JSON.stringify([
        intent.type,
        intent.gameSideId,
        intent.gameTimeMs,
        intent.sportingOrder ?? null,
        intent.sportingOrderAdjudication ?? null,
        intent.sportingOrderOverride ?? null,
        intent.override ?? null,
      ]);
    case "acknowledge-team-assignment":
      return JSON.stringify([intent.type, intent.gameSideId, intent.correctionOperationId]);
    case "record-flag-catch":
    case "record-concession":
    case "record-forfeit":
      return JSON.stringify([
        intent.type,
        intent.gameSideId,
        intent.gameTimeMs,
        intent.sportingOrder ?? null,
        intent.sportingOrderAdjudication ?? null,
        intent.sportingOrderOverride ?? null,
        intent.override ?? null,
      ]);
    case "record-double-forfeit":
      return JSON.stringify([
        intent.type,
        intent.gameTimeMs,
        intent.sportingOrder ?? null,
        intent.override ?? null,
      ]);
    case "record-card":
      return JSON.stringify([
        intent.type,
        intent.gameSideId,
        intent.playerNumber,
        intent.cardType,
        intent.foulBeforeScore ?? false,
        intent.seekerPenalty ?? null,
        intent.gameTimeMs,
        intent.sportingOrder ?? null,
        intent.override ?? null,
      ]);
    case "record-penalty-reason":
      return JSON.stringify([
        intent.type,
        intent.targetCardFactId,
        intent.reason,
        intent.gameTimeMs,
      ]);
    case "resolve-penalty-expiration":
      return JSON.stringify([
        intent.type,
        intent.pendingId,
        intent.scoreFactId,
        intent.playerKey,
        intent.gameTimeMs,
      ]);
    case "correct-fact":
      return JSON.stringify([
        intent.type,
        intent.targetFactId,
        intent.effective,
        intent.gameTimeMs,
      ]);
    case "clock":
    case "set-running":
      return JSON.stringify([
        intent.type,
        intent.running,
        intent.gameTimeMs,
        intent.clockGeneration ?? null,
        intent.occurrence.source ?? "online",
      ]);
    case "clock-adjust":
      return JSON.stringify([
        intent.type,
        intent.adjustmentMs,
        intent.gameTimeMs,
        intent.clockGeneration ?? null,
        intent.occurrence.source ?? "online",
      ]);
    case "clock-correction":
      return JSON.stringify([
        intent.type,
        intent.clockTimeMs,
        intent.gameTimeMs,
        intent.clockGeneration ?? null,
        intent.occurrence.source ?? "online",
      ]);
    case "clock-takeover":
      return JSON.stringify([
        intent.type,
        intent.clockTimeMs,
        intent.running,
        intent.authorityGeneration,
        intent.gameTimeMs,
        intent.occurrence.source ?? "online",
      ]);
    case "substantive":
      return JSON.stringify([
        intent.type,
        intent.trigger,
        intent.gameSideId ?? null,
        intent.heatAction ?? null,
        intent.gameTimeMs,
        intent.sportingOrder ?? null,
        intent.sportingOrderAdjudication ?? null,
        intent.override ?? null,
      ]);
    case "reset":
    case "undo":
      return JSON.stringify([intent.type, intent.gameTimeMs]);
    case "set-pitch-orientation":
      return JSON.stringify([intent.type, intent.pitchOrientation, intent.presentationChangeId]);
    case "set-displayed-team-color":
      return JSON.stringify([
        intent.type,
        intent.gameSideId,
        intent.color,
        intent.presentationChangeId,
      ]);
  }
}

/** Compatibility wrapper for callers that only construct goal intents. */
export function retainControllerGoalIntent(
  pending: PendingControllerGoalIntent | null,
  gameSideId: string,
  clientOriginAtMs = Date.now(),
): PendingControllerGoalIntent {
  const candidate: PendingControllerGoalIntent = {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "record-goal",
    operationId: crypto.randomUUID(),
    factId: crypto.randomUUID(),
    gameSideId,
    gameTimeMs: 0,
    occurrence: { clientOriginAtMs },
  };
  return retainControllerIntent(pending, candidate) as PendingControllerGoalIntent;
}
