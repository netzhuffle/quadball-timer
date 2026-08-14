import {
  createCredentialToken,
  createRandomIdentifier,
  encryptCredential,
} from "@/lib/grant-crypto";
import type { FoundationStorage } from "@/lib/foundation-storage";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import {
  GRANT_CREDENTIAL_FORMAT_VERSION,
  type StoredGrant,
  validateGrantScope,
} from "@/lib/grant-types";
import { createAuditEntry, expireGrantIfDue } from "@/lib/grant-lifecycle";
import { grantExpiryCap, resolveGrantExpiry } from "@/lib/grant-calendar";
import {
  bindingFor,
  canCreateInTransaction,
  canManageInTransaction,
  refreshEventAdminSession,
  resolveManagementAuthority,
  revokeAllSessions,
} from "@/lib/grant-management-policy";
import { verifyGrantAuthority } from "@/lib/grant-authority-trust";
import { auditInput } from "@/lib/grant-management-audit";
import type {
  CreateTypedGrantInput,
  GrantManagementAuthority,
  TypedGrantCreated,
  TypedGrantMutation,
} from "@/lib/grant-management-types";
import {
  GrantUnauthorizedError,
  invalidGrant,
  isGrantRecord,
  isGrantType,
  readGrantNow,
  unauthorizedGrant,
  unavailableGrant,
} from "@/lib/grant-management-results";

export async function createGrant(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  input: CreateTypedGrantInput,
): Promise<TypedGrantCreated | TypedGrantMutation> {
  if (!isGrantRecord(input) || !isGrantType(input.grantType))
    return invalidGrant("Grant type is invalid.");
  const scope = validateGrantScope(input.grantType, input.scope);
  if (!scope.ok) return invalidGrant(scope.error);
  const trustedAuthority = verifyGrantAuthority(
    options.privilegedAuthorityVerifier,
    input.authority,
  );
  if (trustedAuthority === null) return unauthorizedGrant();
  const nowMs = readGrantNow(options);
  const expiresAtMs = resolveGrantExpiry(input.grantType, scope.value, input.expiresAtMs ?? null);
  if (expiresAtMs !== null && (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs))
    return invalidGrant("Grant expiry must be in the future.");
  if (expiresAtMs !== null && expiresAtMs > grantExpiryCap(input.grantType, scope.value))
    return invalidGrant("Grant expiry exceeds the lifecycle cap.");

  const grantId = createRandomIdentifier("grant", options.randomness);
  const grantVersion = createRandomIdentifier("grant-version", options.randomness);
  const binding = {
    environmentId: options.environmentId,
    grantId,
    grantType: input.grantType,
    grantVersion,
    scope: scope.value,
  };
  const qrCredential = createCredentialToken(binding, options.randomness);
  const grant: StoredGrant = {
    grantId,
    grantType: input.grantType,
    grantVersion,
    scope: scope.value,
    status: "active",
    createdAtMs: nowMs,
    expiresAtMs,
    credential: encryptCredential(qrCredential, binding, options.randomness, options.keyRing),
  };
  try {
    await storage.transaction((transaction) => {
      const resolvedAuthority = resolveManagementAuthority(transaction, options, trustedAuthority);
      if (
        resolvedAuthority === null ||
        !canCreateInTransaction(transaction, options, grant, resolvedAuthority)
      )
        throw new GrantUnauthorizedError();
      transaction.insertGrant(grant);
      transaction.appendGrantAudit(
        createAuditEntry(options, auditInput("grant-created", grant, resolvedAuthority, "active")),
      );
      refreshEventAdminSession(transaction, options, resolvedAuthority);
    });
  } catch (error) {
    if (error instanceof GrantUnauthorizedError) return unauthorizedGrant();
    return unavailableGrant();
  }
  return {
    status: "created",
    grantId,
    grantVersion,
    grantType: grant.grantType,
    scope: structuredClone(grant.scope),
    qrCredential,
    credentialFormatVersion: GRANT_CREDENTIAL_FORMAT_VERSION,
    expiresAtMs,
  };
}

export async function updateGrantStatus(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  grantId: string,
  authority: GrantManagementAuthority,
  status: "disabled" | "revoked",
  action: "grant-disabled" | "grant-revoked",
): Promise<TypedGrantMutation> {
  const trustedAuthority = verifyGrantAuthority(options.privilegedAuthorityVerifier, authority);
  if (trustedAuthority === null) return unauthorizedGrant();
  try {
    return await storage.transaction((transaction) => {
      const stored = transaction.findGrantById(grantId);
      if (stored === null) return { status: "rejected", reason: "not-found" };
      const grant = expireGrantIfDue(transaction, options, stored);
      if (grant.status === "expired") return unavailableGrant();
      const resolvedAuthority = resolveManagementAuthority(transaction, options, trustedAuthority);
      if (
        resolvedAuthority === null ||
        !canManageInTransaction(transaction, options, grant, resolvedAuthority, "manage")
      )
        return unauthorizedGrant();
      if (grant.status === status) {
        return {
          status: "rejected",
          reason: "invalid-state",
          detail: "Grant status transition has no effect.",
        };
      }
      transaction.updateGrant({ ...grant, status });
      if (status === "revoked")
        revokeAllSessions(transaction, grant.grantId, readGrantNow(options));
      transaction.appendGrantAudit(
        createAuditEntry(
          options,
          auditInput(
            action,
            grant,
            resolvedAuthority,
            status,
            null,
            null,
            null,
            grant.status,
            null,
            grant.expiresAtMs,
            grant.expiresAtMs,
          ),
        ),
      );
      refreshEventAdminSession(transaction, options, resolvedAuthority);
      return { status: "updated", grantId, grantVersion: grant.grantVersion };
    });
  } catch {
    return unavailableGrant();
  }
}

export async function reactivateGrant(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  grantId: string,
  authority: GrantManagementAuthority,
): Promise<TypedGrantMutation> {
  const trustedAuthority = verifyGrantAuthority(options.privilegedAuthorityVerifier, authority);
  if (trustedAuthority === null) return unauthorizedGrant();
  try {
    return await storage.transaction((transaction) => {
      const stored = transaction.findGrantById(grantId);
      if (stored === null) return { status: "rejected", reason: "not-found" };
      const current = expireGrantIfDue(transaction, options, stored);
      const resolvedAuthority = resolveManagementAuthority(transaction, options, trustedAuthority);
      if (
        current.status === "expired" ||
        resolvedAuthority === null ||
        !canManageInTransaction(transaction, options, current, resolvedAuthority, "manage")
      )
        return unauthorizedGrant();
      if (current.status === "active") {
        return {
          status: "rejected",
          reason: "invalid-state",
          detail: "Grant is already active.",
        };
      }
      const version = createRandomIdentifier("grant-version", options.randomness);
      const binding = { ...bindingFor(options, current), grantVersion: version };
      const token = createCredentialToken(binding, options.randomness);
      const fresh: StoredGrant = {
        ...current,
        grantVersion: version,
        status: "active",
        credential: encryptCredential(token, binding, options.randomness, options.keyRing),
      };
      revokeAllSessions(transaction, grantId, readGrantNow(options));
      transaction.updateGrant(fresh);
      transaction.appendGrantAudit(
        createAuditEntry(
          options,
          auditInput(
            "grant-reactivated",
            fresh,
            resolvedAuthority,
            "active",
            null,
            null,
            null,
            current.status,
          ),
        ),
      );
      refreshEventAdminSession(transaction, options, resolvedAuthority);
      return { status: "updated", grantId, grantVersion: version };
    });
  } catch {
    return unavailableGrant();
  }
}
