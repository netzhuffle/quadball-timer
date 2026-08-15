export type EventOperationsHealth = {
  unresolvedTeamCount: number;
  scheduleConflictCount: number;
  teamScheduleConflictCount: number;
  grantProblemCount: number;
};

export function isEventOperationsHealth(value: unknown): value is EventOperationsHealth {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonnegativeSafeInteger(candidate.unresolvedTeamCount) &&
    isNonnegativeSafeInteger(candidate.scheduleConflictCount) &&
    isNonnegativeSafeInteger(candidate.teamScheduleConflictCount) &&
    isNonnegativeSafeInteger(candidate.grantProblemCount)
  );
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
