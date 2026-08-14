import type { FoundationStorage } from "@/lib/foundation-storage";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import {
  createCredentialToken,
  createRandomIdentifier,
  encryptCredential,
} from "@/lib/grant-crypto";
import {
  EVENT_ADMIN_GRANT_TYPE,
  GRANT_TYPE,
  PITCH_MANAGER_GRANT_TYPE,
  type StoredGrant,
  validateGrantScope,
} from "@/lib/grant-types";
import { createAuditEntry, expireGrantIfDue } from "@/lib/grant-lifecycle";
import { grantExpiryCap, resolveGrantExpiry } from "@/lib/grant-calendar";
import {
  bindingFor,
  canManageInTransaction,
  resolveManagementAuthority,
  refreshEventAdminSession,
  revokeAllSessions,
} from "@/lib/grant-management-policy";
import { verifyGrantAuthority, type GrantAuthorityInput } from "@/lib/grant-authority-trust";
import { auditInput } from "@/lib/grant-management-audit";
import type { TypedGrantMutation } from "@/lib/grant-management-types";

export type GrantLifecycleMetadataCorrection = {
  expiresAtMs?: number | null;
  gameDayDate?: string;
  finalGameDayDate?: string;
};

export async function recalculateExpiry(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  grantId: string,
  correction: GrantLifecycleMetadataCorrection,
  authority: GrantAuthorityInput,
): Promise<TypedGrantMutation> {
  const trustedAuthority = verifyGrantAuthority(options.privilegedAuthorityVerifier, authority);
  if (trustedAuthority === null) return unauthorized();
  const normalized = normalizeMetadataCorrection(correction);
  if (normalized === null) return invalid("Grant lifecycle metadata correction is invalid.");
  if (
    normalized.expiresAtMs !== undefined &&
    normalized.expiresAtMs !== null &&
    (!Number.isSafeInteger(normalized.expiresAtMs) || normalized.expiresAtMs <= readNow(options))
  )
    return invalid("Grant expiry must be in the future.");
  try {
    return await storage.transaction((transaction) => {
      const stored = transaction.findGrantById(grantId);
      if (stored === null) return { status: "rejected", reason: "not-found" };
      const current = expireGrantIfDue(transaction, options, stored);
      if (current.status === "expired") return unauthorized();
      const resolvedAuthority = resolveManagementAuthority(transaction, options, trustedAuthority);
      if (
        resolvedAuthority === null ||
        !canManageInTransaction(transaction, options, current, resolvedAuthority, "manage")
      )
        return unauthorized();
      const correctedScope = correctGrantScope(current, normalized);
      if (!correctedScope.ok) return invalid(correctedScope.error);
      const requestedExpiry = normalized.expiresAtMs === undefined ? null : normalized.expiresAtMs;
      const effectiveExpiry = resolveGrantExpiry(
        current.grantType,
        correctedScope.value,
        requestedExpiry,
      );
      if (
        effectiveExpiry !== null &&
        effectiveExpiry > grantExpiryCap(current.grantType, correctedScope.value)
      )
        return invalid("Grant expiry exceeds the lifecycle cap.");
      if (effectiveExpiry !== null && effectiveExpiry <= readNow(options))
        return invalid("Grant expiry correction must remain in the future.");
      if (
        JSON.stringify(correctedScope.value) === JSON.stringify(current.scope) &&
        effectiveExpiry === current.expiresAtMs
      )
        return invalid("Grant lifecycle metadata correction has no effect.");
      const grantVersion = createRandomIdentifier("grant-version", options.randomness);
      const rebound = {
        ...current,
        grantVersion,
        scope: correctedScope.value,
        expiresAtMs: effectiveExpiry,
      };
      const binding = bindingFor(options, rebound);
      const credential = createCredentialToken(binding, options.randomness);
      const corrected = {
        ...rebound,
        credential: encryptCredential(credential, binding, options.randomness, options.keyRing),
      };
      revokeAllSessions(transaction, grantId, readNow(options));
      transaction.updateGrant(corrected);
      transaction.appendGrantAudit(
        createAuditEntry(
          options,
          auditInput(
            "grant-metadata-updated",
            corrected,
            resolvedAuthority,
            current.status,
            null,
            null,
            null,
            current.status,
            null,
            current.expiresAtMs,
            effectiveExpiry,
          ),
        ),
      );
      refreshEventAdminSession(transaction, options, resolvedAuthority);
      return { status: "updated", grantId, grantVersion };
    });
  } catch {
    return unavailable();
  }
}

function normalizeMetadataCorrection(
  correction: GrantLifecycleMetadataCorrection | number | null,
): GrantLifecycleMetadataCorrection | null {
  if (!isRecord(correction)) return null;
  const keys = Object.keys(correction);
  if (
    keys.length === 0 ||
    keys.some((key) => !["expiresAtMs", "gameDayDate", "finalGameDayDate"].includes(key))
  )
    return null;
  if (
    (correction.expiresAtMs !== undefined &&
      correction.expiresAtMs !== null &&
      typeof correction.expiresAtMs !== "number") ||
    (correction.gameDayDate !== undefined && typeof correction.gameDayDate !== "string") ||
    (correction.finalGameDayDate !== undefined && typeof correction.finalGameDayDate !== "string")
  )
    return null;
  return { ...correction };
}

function correctGrantScope(
  grant: StoredGrant,
  correction: GrantLifecycleMetadataCorrection,
): ReturnType<typeof validateGrantScope> {
  const scope = { ...grant.scope } as Record<string, unknown>;
  if (grant.grantType === PITCH_MANAGER_GRANT_TYPE) {
    if (correction.finalGameDayDate !== undefined)
      return { ok: false, error: "Pitch Manager Grants require game-day metadata." };
    if (correction.gameDayDate !== undefined) scope.gameDayDate = correction.gameDayDate;
  }
  if (grant.grantType === EVENT_ADMIN_GRANT_TYPE) {
    if (correction.gameDayDate !== undefined)
      return { ok: false, error: "Event Admin Grants require final-game-day metadata." };
    if (correction.finalGameDayDate !== undefined)
      scope.finalGameDayDate = correction.finalGameDayDate;
  }
  if (
    grant.grantType === GRANT_TYPE &&
    (correction.gameDayDate !== undefined || correction.finalGameDayDate !== undefined)
  )
    return { ok: false, error: "Control Grants do not have lifecycle date metadata." };
  return validateGrantScope(grant.grantType, scope);
}

function readNow(options: GrantAuthorityOptions): number {
  const now = options.clock.nowMs();
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error("Grant clock returned an invalid timestamp.");
  return now;
}

function invalid(detail: string): TypedGrantMutation {
  return { status: "rejected", reason: "invalid-input", detail };
}

function unauthorized(): TypedGrantMutation {
  return {
    status: "rejected",
    reason: "unauthorized",
    detail: "Grant authority is not permitted for this operation.",
  };
}

function unavailable(): TypedGrantMutation {
  return {
    status: "rejected",
    reason: "unavailable",
    detail: "Grant authority storage is temporarily unavailable.",
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
