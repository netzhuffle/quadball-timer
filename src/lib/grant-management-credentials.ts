import {
  createCredentialToken,
  createRandomIdentifier,
  decryptCredential,
  encryptCredential,
} from "@/lib/grant-crypto";
import {
  requireGrantStorageTransaction,
  type FoundationStorage,
  type FoundationStorageTransaction,
} from "@/lib/foundation-storage";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import {
  GRANT_CREDENTIAL_FORMAT_VERSION,
  GRANT_CODE_KIND,
  type StoredGrant,
  type StoredGrantCode,
} from "@/lib/grant-types";
import { createAuditEntry, expireGrantIfDue } from "@/lib/grant-lifecycle";
import {
  bindingFor,
  canManageInTransaction,
  credentialMatches,
  hasCurrentAdmissionEligibility,
  refreshEventAdminSession,
  refreshGrantManagementSession,
  resolveManagementAuthority,
  revokeAllSessions,
} from "@/lib/grant-management-policy";
import { verifyGrantAuthority } from "@/lib/grant-authority-trust";
import {
  decryptGrantCode,
  encryptGrantCode,
  generateGrantCode,
  grantCodeLookupDigest,
} from "@/lib/grant-code";
import { auditInput } from "@/lib/grant-management-audit";
import type {
  GrantManagementAuthority,
  TypedGrantMutation,
  TypedGrantReveal,
  TypedGrantRotated,
} from "@/lib/grant-management-types";
import { readGrantNow, unauthorizedGrant, unavailableGrant } from "@/lib/grant-management-results";

export async function revealGrant(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  grantId: string,
  authority: GrantManagementAuthority,
): Promise<TypedGrantReveal> {
  try {
    return await storage.transaction((transaction) =>
      revealGrantInTransaction(transaction, options, grantId, authority),
    );
  } catch {
    return { status: "rejected", reason: "unavailable", detail: "The Grant cannot be revealed." };
  }
}

export function revealGrantInTransaction(
  transaction: FoundationStorageTransaction,
  options: GrantAuthorityOptions,
  grantId: string,
  authority: GrantManagementAuthority,
): TypedGrantReveal {
  const trustedAuthority = verifyGrantAuthority(options.privilegedAuthorityVerifier, authority);
  if (trustedAuthority === null)
    return { status: "rejected", reason: "unauthorized", detail: "The Grant cannot be revealed." };
  const grantTransaction = requireGrantStorageTransaction(transaction);
  const stored = grantTransaction.findGrantById(grantId);
  if (stored === null)
    return { status: "rejected", reason: "not-found", detail: "The Grant cannot be revealed." };
  const grant = expireGrantIfDue(transaction, options, stored);
  if (grant.grantType === "control" && !hasCurrentAdmissionEligibility(options, grant, transaction))
    return {
      status: "rejected",
      reason: "unauthorized",
      detail: "The Grant cannot be revealed.",
    };
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
  const token = decryptCredential(grant.credential, bindingFor(options, grant), options.keyRing);
  if (token === null || !credentialMatches(grant, options, token))
    return {
      status: "rejected",
      reason: "unavailable",
      detail: "The Grant cannot be revealed.",
    };
  grantTransaction.appendGrantAudit(
    createAuditEntry(
      options,
      auditInput("credential-revealed", grant, resolvedAuthority, grant.status),
    ),
  );
  refreshGrantManagementSession(transaction, options, resolvedAuthority);
  return {
    status: "revealed",
    grantId,
    grantVersion: grant.grantVersion,
    grantType: grant.grantType,
    qrCredential: token,
    credentialFormatVersion: GRANT_CREDENTIAL_FORMAT_VERSION,
  };
}

export async function rotateGrant(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  grantId: string,
  authority: GrantManagementAuthority,
): Promise<TypedGrantRotated | TypedGrantMutation> {
  try {
    return await storage.transaction((transaction) =>
      rotateGrantInTransaction(transaction, options, grantId, authority),
    );
  } catch {
    return unavailableGrant();
  }
}

export function rotateGrantInTransaction(
  transaction: FoundationStorageTransaction,
  options: GrantAuthorityOptions,
  grantId: string,
  authority: GrantManagementAuthority,
): TypedGrantRotated | TypedGrantMutation {
  const trustedAuthority = verifyGrantAuthority(options.privilegedAuthorityVerifier, authority);
  if (trustedAuthority === null) return unauthorizedGrant();
  const grantTransaction = requireGrantStorageTransaction(transaction);
  const stored = grantTransaction.findGrantById(grantId);
  if (stored === null) return { status: "rejected", reason: "not-found" };
  const resolvedAuthority = resolveManagementAuthority(transaction, options, trustedAuthority);
  if (
    resolvedAuthority === null ||
    !canManageInTransaction(transaction, options, stored, resolvedAuthority, "manage")
  )
    return unauthorizedGrant();
  const grant = expireGrantIfDue(transaction, options, stored);
  if (grant.status !== "active") return unauthorizedGrant();
  if (!hasCurrentAdmissionEligibility(options, grant, transaction))
    return {
      status: "rejected",
      reason: "invalid-state",
      detail: "Grant admission is not currently eligible.",
    };
  const version = createRandomIdentifier("grant-version", options.randomness);
  const binding = { ...bindingFor(options, grant), grantVersion: version };
  const token = createCredentialToken(binding, options.randomness);
  let rotatedCode: StoredGrantCode | null = null;
  let replacementCode: string | null = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = generateGrantCode(options.randomness);
    if (
      grantTransaction.findGrantByCodeLookupDigest === undefined ||
      grantTransaction.findGrantByCodeLookupDigest(
        grantCodeLookupDigest(candidate, options.keyRing),
      ) === null
    ) {
      replacementCode = candidate;
      rotatedCode = encryptGrantCode(
        candidate,
        { ...binding, grantVersion: version },
        options.randomness,
        options.keyRing,
      );
      break;
    }
  }
  if (rotatedCode === null || replacementCode === null) return unavailableGrant();
  const rotated = {
    ...grant,
    grantVersion: version,
    credential: encryptCredential(token, binding, options.randomness, options.keyRing),
    code: rotatedCode,
  };
  const affectedSessionCount = revokeAllSessions(transaction, grantId, readGrantNow(options));
  grantTransaction.updateGrant(rotated);
  grantTransaction.appendGrantAudit(
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
  const codeAudit = createAuditEntry(
    options,
    auditInput(
      grant.code?.state === "present" ? "grant-code-replaced" : "grant-code-created",
      rotated,
      resolvedAuthority,
      "active",
      null,
      null,
      null,
      grant.status,
    ),
  );
  grantTransaction.appendGrantAudit({
    ...codeAudit,
    credentialKind: GRANT_CODE_KIND,
    credentialFingerprint: rotated.code.fingerprint,
    codeFormatVersion: rotated.code.formatVersion,
    codeEncryptionKeyVersion: rotated.code.encryptionKeyVersion,
    codeLookupKeyVersion: rotated.code.lookupKeyVersion,
    codeStateBefore: grant.code?.state ?? "absent",
    codeState: rotated.code.state,
    previousCodeFingerprint: grant.code?.fingerprint ?? null,
  });
  refreshGrantManagementSession(transaction, options, resolvedAuthority);
  return {
    status: "updated",
    grantId,
    grantVersion: version,
    qrCredential: token,
    credentialFormatVersion: GRANT_CREDENTIAL_FORMAT_VERSION,
    code: replacementCode,
    codeFormatVersion: 1 as const,
    oneTime: true,
    noStore: true,
    affectedSessionCount,
  };
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
      const grantTransaction = requireGrantStorageTransaction(transaction);
      const stored = grantTransaction.findGrantById(grantId);
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
        code:
          grant.code?.state === "present"
            ? (() => {
                const plaintext = decryptGrantCode(
                  grant.code,
                  codeBinding(options, grant),
                  options.keyRing,
                );
                return plaintext === null
                  ? null
                  : encryptGrantCode(
                      plaintext,
                      codeBinding(options, grant),
                      options.randomness,
                      options.keyRing,
                    );
              })()
            : (grant.code ?? null),
      };
      if (grant.code?.state === "present" && rotated.code === null) return unavailableGrant();
      grantTransaction.updateGrant(rotated);
      grantTransaction.appendGrantAudit(
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
      if (grant.code?.state === "present" && rotated.code !== null) {
        const codeAudit = createAuditEntry(
          options,
          auditInput("grant-code-replaced", rotated, resolvedAuthority, grant.status),
        );
        grantTransaction.appendGrantAudit({
          ...codeAudit,
          credentialKind: GRANT_CODE_KIND,
          credentialFingerprint: rotated.code.fingerprint,
          codeFormatVersion: rotated.code.formatVersion,
          codeEncryptionKeyVersion: rotated.code.encryptionKeyVersion,
          codeLookupKeyVersion: rotated.code.lookupKeyVersion,
          codeStateBefore: grant.code.state,
          codeState: rotated.code.state,
          previousCodeFingerprint: grant.code.fingerprint,
        });
      }
      refreshEventAdminSession(transaction, options, resolvedAuthority);
      return { status: "updated", grantId, grantVersion: grant.grantVersion };
    });
  } catch {
    return unavailableGrant();
  }
}

function codeBinding(options: GrantAuthorityOptions, grant: StoredGrant) {
  return {
    environmentId: options.environmentId,
    grantId: grant.grantId,
    grantType: grant.grantType,
    grantVersion: grant.grantVersion,
    scope: grant.scope,
  };
}
