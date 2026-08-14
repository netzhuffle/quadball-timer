export const FOUNDATION_REJECTION_REASONS = [
  "causal-dependency-rejected",
  "causal-predecessor-retry",
  "cyclic-dependency",
  "fact-target-missing",
  "game-locked",
  "grant-session",
  "invalid-action",
  "missing-dependency",
  "operation-conflict",
  "rate-budget",
  "record-not-found",
  "replay-ineligible",
  "replay-reservation-mismatch",
  "replay-session-mismatch",
  "scope-unavailable",
  "stale-preflight",
  "storage-unavailable",
] as const;

export type FoundationRejectionReason = (typeof FOUNDATION_REJECTION_REASONS)[number];

export function isFoundationRejectionReason(value: unknown): value is FoundationRejectionReason {
  return (
    typeof value === "string" && (FOUNDATION_REJECTION_REASONS as readonly string[]).includes(value)
  );
}

/**
 * Adapter extensions cannot create a new durable reason. Unknown replay
 * ineligibility is retained under the shared, deliberately opaque reason.
 */
export function normalizeFoundationRejectionReason(value: unknown): FoundationRejectionReason {
  return isFoundationRejectionReason(value) ? value : "replay-ineligible";
}
