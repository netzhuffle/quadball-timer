import {
  LIVE_EVENT_CONTROL_INTENT_VERSION,
  type LiveEventControllerIntent,
} from "@/lib/live-event-game-control";

export type PendingControllerGoalIntent = LiveEventControllerIntent;

export function retainControllerGoalIntent(
  pending: PendingControllerGoalIntent | null,
  gameSideId: string,
  clientOriginAtMs = Date.now(),
): PendingControllerGoalIntent {
  if (pending?.gameSideId === gameSideId) return pending;
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "record-goal",
    operationId: crypto.randomUUID(),
    factId: crypto.randomUUID(),
    gameSideId,
    gameTimeMs: 0,
    occurrence: { clientOriginAtMs },
  };
}
