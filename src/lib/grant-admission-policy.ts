import type { FoundationStorageTransaction } from "@/lib/foundation-storage";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import { DAY_MS } from "@/lib/grant-calendar";
import {
  EVENT_ADMIN_GRANT_TYPE,
  PITCH_MANAGER_GRANT_TYPE,
  type ControlGrantScope,
  type GrantType,
  type PitchManagerGrantScope,
  type StoredGrant,
  validateControlGrantScope,
  validateEventAdminGrantScope,
  validatePitchManagerGrantScope,
} from "@/lib/grant-types";
import { validateOpaqueIdentifier } from "@/lib/validation-policy";

export function grantTypeMatchesExpected(
  grant: Pick<StoredGrant, "grantType">,
  expectedGrantType: GrantType | undefined,
): boolean {
  return expectedGrantType === undefined || grant.grantType === expectedGrantType;
}

export function validateExpectedGrantScope(
  transaction: FoundationStorageTransaction,
  grant: Pick<StoredGrant, "grantType" | "scope">,
  expectedGrantType: GrantType | undefined,
): boolean {
  if (expectedGrantType === undefined || grant.grantType !== expectedGrantType) return false;
  if (expectedGrantType === EVENT_ADMIN_GRANT_TYPE)
    return validateEventAdminGrantScope(grant.scope).ok;
  if (expectedGrantType === PITCH_MANAGER_GRANT_TYPE) {
    const scope = validatePitchManagerGrantScope(grant.scope);
    return scope.ok && isLivePitchManagerScope(transaction, scope.value);
  }
  return validateControlGrantScope(grant.scope).ok;
}

export function isLivePitchManagerScope(
  transaction: FoundationStorageTransaction,
  scope: PitchManagerGrantScope,
): boolean {
  const event = transaction.findEvent(scope.eventId);
  const day = transaction
    .listGameDays(scope.eventId)
    .find((candidate) => candidate.gameDayId === scope.gameDayId);
  const pitch = transaction.findPitch(scope.pitchId);
  return (
    event !== null &&
    day !== undefined &&
    day.date === scope.gameDayDate &&
    event.timeZone === scope.eventTimeZone &&
    pitch !== null &&
    pitch.eventId === scope.eventId
  );
}

export function sessionExpiresAtMsForGrant(
  grant: Pick<StoredGrant, "grantType" | "expiresAtMs">,
  nowMs: number,
): number | null {
  if (grant.grantType === EVENT_ADMIN_GRANT_TYPE)
    return Math.min(grant.expiresAtMs ?? Number.MAX_SAFE_INTEGER, nowMs + 30 * DAY_MS);
  if (grant.grantType === PITCH_MANAGER_GRANT_TYPE) return grant.expiresAtMs;
  return null;
}

export function resolveControlGrantAdmission(
  options: GrantAuthorityOptions,
  transaction: FoundationStorageTransaction,
  scope: ControlGrantScope,
): string | null {
  const resolved = options.controlScopeResolver.resolve(scope, transaction);
  return resolved.status === "eligible" &&
    validateOpaqueIdentifier(resolved.eventGameId, "eventGameId").ok
    ? resolved.eventGameId
    : null;
}
