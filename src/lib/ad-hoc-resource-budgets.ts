/**
 * Ad Hoc resource policy is deliberately kept in its own module.  None of
 * these buckets are reused by Event Games, Grants, or the Event transport.
 */

export const AD_HOC_CREATION_IMMEDIATE_ATTEMPTS = 5;
export const AD_HOC_CREATION_MAX_DELAY_MS = 30_000;

export const AD_HOC_CONTROLLER_SUSTAINED_PER_SECOND = 20;
export const AD_HOC_CONTROLLER_BURST = 40;
export const AD_HOC_GAME_SUSTAINED_PER_SECOND = 50;
export const AD_HOC_GAME_BURST = 100;

export const AD_HOC_REPLAY_MAX_OPERATIONS_PER_BATCH = 100;
export const AD_HOC_REPLAY_SUSTAINED_PER_SECOND = 20;
// Replay batches are admitted in a 20-operation scheduling slice. The wire
// envelope remains 100 so malformed or oversized replay requests fail closed.
export const AD_HOC_REPLAY_BURST = AD_HOC_REPLAY_SUSTAINED_PER_SECOND;
export const AD_HOC_REPLAY_MAX_UNACKNOWLEDGED_BATCHES = 1;

// This is an Ad Hoc-only ceiling.  Event connection capacity is not read or
// mutated here, so a full Ad Hoc pool cannot consume Event capacity.
export const AD_HOC_MAX_CONNECTED_CONTROLLERS = 256;
export const AD_HOC_MAX_QUEUED_OUTPUT_BYTES = 256 * 1024;
export const AD_HOC_EVENT_TOTAL_CONNECTION_CAPACITY = AD_HOC_MAX_CONNECTED_CONTROLLERS + 1;
export const AD_HOC_EVENT_RESERVED_CONNECTION_CAPACITY = 1;

export type AdHocResourceMetric =
  | "creation-delay"
  | "creation-rate-exhausted"
  | "action-rate-exhausted"
  | "replay-pressure"
  | "connection-shed"
  | "queue-pressure";

export type AdHocResourceMetrics = Readonly<{
  creationDelay: number;
  creationRateExhausted: number;
  actionRateExhausted: number;
  replayPressure: number;
  connectionShed: number;
  queuePressure: number;
  connectedControllers: number;
  eventReservedCapacity: {
    configured: number;
    active: number;
    availableForAdHoc: number;
  };
}>;

export type AdHocTokenBucket = {
  tokens: number;
  updatedAtMs: number;
};

export type AdHocTokenDecision =
  | { accepted: true; bucket: AdHocTokenBucket }
  | { accepted: false; retryAfterMs: number; bucket: AdHocTokenBucket };

/** Returns a bounded, progressive delay after the five immediate attempts. */
export function adHocCreationDelayMs(sourceAttemptCount: number): number {
  if (sourceAttemptCount < AD_HOC_CREATION_IMMEDIATE_ATTEMPTS) return 0;
  const exponent = Math.min(5, sourceAttemptCount - AD_HOC_CREATION_IMMEDIATE_ATTEMPTS);
  return Math.min(AD_HOC_CREATION_MAX_DELAY_MS, 1_000 * 2 ** exponent);
}

export function consumeAdHocTokens(
  previous: AdHocTokenBucket | undefined,
  nowMs: number,
  capacity: number,
  refillPerSecond: number,
  cost: number,
): AdHocTokenDecision {
  const current = previous ?? { tokens: capacity, updatedAtMs: nowMs };
  const elapsedMs = Math.max(0, nowMs - current.updatedAtMs);
  const refilled = Math.min(capacity, current.tokens + (elapsedMs * refillPerSecond) / 1_000);
  const bucket = { tokens: refilled, updatedAtMs: nowMs };
  if (cost <= refilled) return { accepted: true, bucket: { ...bucket, tokens: refilled - cost } };
  return {
    accepted: false,
    retryAfterMs: Math.max(1, Math.ceil(((cost - refilled) * 1_000) / refillPerSecond)),
    bucket,
  };
}

export function emptyAdHocResourceMetrics(): {
  -readonly [K in keyof AdHocResourceMetrics]: AdHocResourceMetrics[K];
} {
  return {
    creationDelay: 0,
    creationRateExhausted: 0,
    actionRateExhausted: 0,
    replayPressure: 0,
    connectionShed: 0,
    queuePressure: 0,
    connectedControllers: 0,
    eventReservedCapacity: {
      configured: AD_HOC_EVENT_RESERVED_CONNECTION_CAPACITY,
      active: 0,
      availableForAdHoc: AD_HOC_MAX_CONNECTED_CONTROLLERS,
    },
  };
}
