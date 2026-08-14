import {
  createCredentialToken,
  createRandomIdentifier,
  decryptCredential,
  encryptCredential,
} from "@/lib/grant-crypto";
import type { FoundationStorage } from "@/lib/foundation-storage";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import { GRANT_CREDENTIAL_FORMAT_VERSION } from "@/lib/grant-types";
import { createAuditEntry, expireGrantIfDue } from "@/lib/grant-lifecycle";
import {
  bindingFor,
  canManageInTransaction,
  credentialMatches,
  refreshEventAdminSession,
  resolveManagementAuthority,
  revokeAllSessions,
} from "@/lib/grant-management-policy";
import { verifyGrantAuthority } from "@/lib/grant-authority-trust";
import { auditInput } from "@/lib/grant-management-audit";
import type {
  GrantManagementAuthority,
  TypedGrantMutation,
  TypedGrantReveal,
} from "@/lib/grant-management-types";
import { readGrantNow, unauthorizedGrant, unavailableGrant } from "@/lib/grant-management-results";

export async function revealGrant(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  grantId: string,
  authority: GrantManagementAuthority,
): Promise<TypedGrantReveal> {
  const trustedAuthority = verifyGrantAuthority(options.privilegedAuthorityVerifier, authority);
  if (trustedAuthority === null)
    return { status: "rejected", reason: "unauthorized", detail: "The Grant cannot be revealed." };
  try {
    return await storage.transaction((transaction) => {
      const stored = transaction.findGrantById(grantId);
      if (stored === null)
        return { status: "rejected", reason: "not-found", detail: "The Grant cannot be revealed." };
      const grant = expireGrantIfDue(transaction, options, stored);
      const resolvedAuthority = resolveManagementAuthority(transaction, options, trustedAuthority);
      if (
        grant.status !== "active" ||
        resolvedAuthority === null ||
        !canManageInTransaction(transaction, options, grant, resolvedAuthority, "reveal")
      )
        return {
          status: "rejected",
          reason: "unauthorized",
          detail: "The Grant cannot be revealed.",
        };
      const token = decryptCredential(
        grant.credential,
        bindingFor(options, grant),
        options.keyRing,
      );
      if (token === null || !credentialMatches(grant, options, token))
        return {
          status: "rejected",
          reason: "unavailable",
          detail: "The Grant cannot be revealed.",
        };
      transaction.appendGrantAudit(
        createAuditEntry(
          options,
          auditInput("credential-revealed", grant, resolvedAuthority, grant.status),
        ),
      );
      refreshEventAdminSession(transaction, options, resolvedAuthority);
      return {
        status: "revealed",
        grantId,
        grantVersion: grant.grantVersion,
        grantType: grant.grantType,
        qrCredential: token,
        credentialFormatVersion: GRANT_CREDENTIAL_FORMAT_VERSION,
      };
    });
  } catch {
    return { status: "rejected", reason: "unavailable", detail: "The Grant cannot be revealed." };
  }
}

export async function rotateGrant(
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
      const grant = expireGrantIfDue(transaction, options, stored);
      const resolvedAuthority = resolveManagementAuthority(transaction, options, trustedAuthority);
      if (
        grant.status !== "active" ||
        resolvedAuthority === null ||
        !canManageInTransaction(transaction, options, grant, resolvedAuthority, "manage")
      )
        return unauthorizedGrant();
      const version = createRandomIdentifier("grant-version", options.randomness);
      const binding = { ...bindingFor(options, grant), grantVersion: version };
      const token = createCredentialToken(binding, options.randomness);
      const rotated = {
        ...grant,
        grantVersion: version,
        credential: encryptCredential(token, binding, options.randomness, options.keyRing),
      };
      revokeAllSessions(transaction, grantId, readGrantNow(options));
      transaction.updateGrant(rotated);
      transaction.appendGrantAudit(
        createAuditEntry(
          options,
          auditInput(
            "credential-rotated",
            rotated,
            resolvedAuthority,
            "active",
            null,
            null,
            null,
            grant.status,
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

export async function rotateGrantCredentialKeys(
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
      const grant = expireGrantIfDue(transaction, options, stored);
      const resolvedAuthority = resolveManagementAuthority(transaction, options, trustedAuthority);
      if (
        grant.status === "expired" ||
        resolvedAuthority === null ||
        !canManageInTransaction(transaction, options, grant, resolvedAuthority, "manage")
      )
        return unauthorizedGrant();
      const token = decryptCredential(
        grant.credential,
        bindingFor(options, grant),
        options.keyRing,
      );
      if (token === null || !credentialMatches(grant, options, token)) return unavailableGrant();
      const rotated = {
        ...grant,
        credential: encryptCredential(
          token,
          bindingFor(options, grant),
          options.randomness,
          options.keyRing,
        ),
      };
      transaction.updateGrant(rotated);
      transaction.appendGrantAudit(
        createAuditEntry(
          options,
          auditInput(
            "credential-rotated",
            rotated,
            resolvedAuthority,
            grant.status,
            null,
            null,
            null,
            grant.status,
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
