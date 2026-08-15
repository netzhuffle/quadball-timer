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
      return JSON.stringify([intent.type, intent.gameSideId, intent.gameTimeMs]);
    case "clock":
    case "set-running":
      return JSON.stringify([intent.type, intent.running, intent.gameTimeMs]);
    case "clock-adjust":
      return JSON.stringify([intent.type, intent.adjustmentMs, intent.gameTimeMs]);
    case "clock-correction":
      return JSON.stringify([intent.type, intent.clockTimeMs, intent.gameTimeMs]);
    case "substantive":
      return JSON.stringify([intent.type, intent.trigger, intent.gameTimeMs]);
    case "reset":
    case "undo":
      return JSON.stringify([intent.type, intent.gameTimeMs]);
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
