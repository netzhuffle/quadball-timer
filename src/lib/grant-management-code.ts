import { requireGrantStorageTransaction, type FoundationStorage } from "@/lib/foundation-storage";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import {
  grantAdmissionThrottled,
  GENERIC_GRANT_ADMISSION_FAILURE,
} from "@/lib/grant-authority-types";
import {
  decryptGrantCode,
  encryptGrantCode,
  eraseGrantCode,
  generateGrantCode,
  grantCodeLookupDigest,
  normalizeGrantCode,
} from "@/lib/grant-code";
import { createAuditEntry, expireGrantIfDue } from "@/lib/grant-lifecycle";
import { auditInput } from "@/lib/grant-management-audit";
import {
  canManageInTransaction,
  findActiveContext,
  hasCurrentAdmissionEligibility,
  refreshEventAdminSession,
  resolveManagementAuthority,
} from "@/lib/grant-management-policy";
import { verifyGrantAuthority } from "@/lib/grant-authority-trust";
import {
  beginAdmission,
  recordAdmissionFailure,
  recordAdmissionSuccess,
} from "@/lib/grant-admission-throttle";
import { type StoredGrant, type StoredGrantCode, type StoredGrantSession } from "@/lib/grant-types";
import type {
  GrantManagementAuthority,
  TypedGrantAdmission,
  TypedGrantCodeCreated,
  TypedGrantMutation,
} from "@/lib/grant-management-types";
import {
  createRandomIdentifier,
  computeBrowserContextDigest,
  computeSessionVerifier,
} from "@/lib/grant-crypto";
import { coarse } from "@/lib/grant-management-audit";
import {
  isGrantRecord,
  readGrantNow,
  requireGrantBytes,
  unauthorizedGrant,
  unavailableGrant,
} from "@/lib/grant-management-results";
import { GRANT_CODE_KIND, GRANT_TYPE, type ControlGrantScope } from "@/lib/grant-types";
import { validateOpaqueIdentifier } from "@/lib/validation-policy";

export async function createGrantCode(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  grantId: string,
  authority: GrantManagementAuthority,
  replace: boolean,
): Promise<TypedGrantCodeCreated | TypedGrantMutation> {
  const trusted = verifyGrantAuthority(options.privilegedAuthorityVerifier, authority);
  if (trusted === null) return unauthorizedGrant();
  try {
    return await storage.transaction((transaction) => {
      const grantTransaction = requireGrantStorageTransaction(transaction);
      const stored = grantTransaction.findGrantById(grantId);
      if (stored === null) return { status: "rejected", reason: "not-found" };
      const grant = expireGrantIfDue(grantTransaction, options, stored);
      const resolved = resolveManagementAuthority(grantTransaction, options, trusted);
      if (
        resolved === null ||
        !canManageInTransaction(grantTransaction, options, stored, resolved, "manage")
      )
        return unauthorizedGrant();
      if (grant.status !== "active") return unauthorizedGrant();
      if (!hasCurrentAdmissionEligibility(options, grant))
        return {
          status: "rejected",
          reason: "invalid-state",
          detail: "Grant admission is not currently eligible.",
        };
      if (!replace && grant.code?.state === "present")
        return {
          status: "rejected",
          reason: "invalid-state",
          detail: "Grant already has an active code.",
        };
      if (replace && grant.code?.state !== "present")
        return {
          status: "rejected",
          reason: "invalid-state",
          detail: "Grant has no active code to replace.",
        };
      const previousFingerprint = grant.code?.fingerprint ?? null;
      let next: StoredGrantCode | null = null;
      let code = "";
      for (let attempt = 0; attempt < 8; attempt += 1) {
        code = generateGrantCode(options.randomness);
        const digest = grantCodeLookupDigest(code, options.keyRing);
        if (grantTransaction.findGrantByCodeLookupDigest(digest) === null) {
          next = encryptGrantCode(
            code,
            codeBinding(options, grant, grant.grantVersion),
            options.randomness,
            options.keyRing,
          );
          break;
        }
      }
      if (next === null) return unavailableGrant();
      const updated = { ...grant, code: next };
      grantTransaction.updateGrant(updated);
      const audit = createAuditEntry(
        options,
        auditInput(
          replace && grant.code?.state === "present" ? "grant-code-replaced" : "grant-code-created",
          updated,
          resolved,
          grant.status,
          null,
          null,
          null,
          grant.status,
          null,
          grant.expiresAtMs,
          grant.expiresAtMs,
        ),
      );
      grantTransaction.appendGrantAudit({
        ...audit,
        credentialKind: GRANT_CODE_KIND,
        credentialFingerprint: next.fingerprint,
        codeFormatVersion: next.formatVersion,
        codeEncryptionKeyVersion: next.encryptionKeyVersion,
        codeLookupKeyVersion: next.lookupKeyVersion,
        codeStateBefore: grant.code?.state ?? "absent",
        codeState: next.state,
        previousCodeFingerprint: previousFingerprint,
      });
      refreshEventAdminSession(grantTransaction, options, resolved);
      return {
        status: replace && grant.code?.state === "present" ? "replaced" : "created",
        grantId: grant.grantId,
        grantVersion: grant.grantVersion,
        code,
        formatVersion: 1,
      };
    });
  } catch {
    return unavailableGrant();
  }
}

export async function disableGrantCode(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  grantId: string,
  authority: GrantManagementAuthority,
): Promise<TypedGrantMutation> {
  const trusted = verifyGrantAuthority(options.privilegedAuthorityVerifier, authority);
  if (trusted === null) return unauthorizedGrant();
  try {
    return await storage.transaction((transaction) => {
      const grantTransaction = requireGrantStorageTransaction(transaction);
      const stored = grantTransaction.findGrantById(grantId);
      if (stored === null) return { status: "rejected", reason: "not-found" };
      const grant = expireGrantIfDue(grantTransaction, options, stored);
      const resolved = resolveManagementAuthority(grantTransaction, options, trusted);
      if (
        grant.status !== "active" ||
        resolved === null ||
        !canManageInTransaction(grantTransaction, options, grant, resolved, "manage")
      )
        return unauthorizedGrant();
      if (grant.code?.state !== "present")
        return { status: "rejected", reason: "invalid-state", detail: "Grant has no active code." };
      const disabled = eraseGrantCode(grant.code, "disabled");
      const updated = { ...grant, code: disabled };
      grantTransaction.updateGrant(updated);
      const audit = createAuditEntry(
        options,
        auditInput(
          "grant-code-disabled",
          updated,
          resolved,
          grant.status,
          null,
          null,
          null,
          grant.status,
          null,
          grant.expiresAtMs,
          grant.expiresAtMs,
        ),
      );
      grantTransaction.appendGrantAudit({
        ...audit,
        credentialKind: GRANT_CODE_KIND,
        credentialFingerprint: disabled.fingerprint,
        codeFormatVersion: grant.code.formatVersion,
        codeEncryptionKeyVersion: grant.code.encryptionKeyVersion,
        codeLookupKeyVersion: grant.code.lookupKeyVersion,
        codeStateBefore: grant.code.state,
        codeState: "disabled",
        previousCodeFingerprint: grant.code.fingerprint,
      });
      refreshEventAdminSession(grantTransaction, options, resolved);
      return { status: "updated", grantId, grantVersion: grant.grantVersion };
    });
  } catch {
    return unavailableGrant();
  }
}

export async function admitGrantCode(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  input: unknown,
): Promise<TypedGrantAdmission | ReturnType<typeof grantAdmissionThrottled>> {
  const record = isGrantRecord(input) ? input : {};
  const browserContext = record.browserContext;
  const rawCode = record.grantCode;
  try {
    return await storage.transaction((transaction) => {
      const grantTransaction = requireGrantStorageTransaction(transaction);
      const nowMs = readGrantNow(options);
      const budget = beginAdmission(grantTransaction, options, "code", browserContext, nowMs);
      if (budget.throttle !== null) return budget.throttle;
      const code = normalizeGrantCode(rawCode);
      if (code === null || !validateOpaqueIdentifier(browserContext, "browserContext").ok) {
        recordAdmissionFailure(transaction, "code", budget.sourceDigest, nowMs);
        return GENERIC_GRANT_ADMISSION_FAILURE;
      }
      const storedGrant = grantTransaction.findGrantByCodeLookupDigest(
        grantCodeLookupDigest(code, options.keyRing),
      );
      const grant =
        storedGrant === null ? null : expireGrantIfDue(grantTransaction, options, storedGrant);
      if (grant === null || grant.status !== "active" || grant.code?.state !== "present") {
        recordAdmissionFailure(transaction, "code", budget.sourceDigest, nowMs);
        return GENERIC_GRANT_ADMISSION_FAILURE;
      }
      const decrypted = decryptGrantCode(
        grant.code,
        codeBinding(options, grant, grant.grantVersion),
        options.keyRing,
      );
      if (
        decrypted !== code ||
        grant.code.lookupDigest !== grantCodeLookupDigest(code, options.keyRing)
      ) {
        recordAdmissionFailure(transaction, "code", budget.sourceDigest, nowMs);
        return GENERIC_GRANT_ADMISSION_FAILURE;
      }
      let eventGameId: string | null = null;
      if (grant.grantType === GRANT_TYPE) {
        const resolved = options.controlScopeResolver.resolve(grant.scope as ControlGrantScope);
        if (
          resolved.status !== "eligible" ||
          !validateOpaqueIdentifier(resolved.eventGameId, "eventGameId").ok
        ) {
          recordAdmissionFailure(transaction, "code", budget.sourceDigest, nowMs);
          return GENERIC_GRANT_ADMISSION_FAILURE;
        }
        eventGameId = resolved.eventGameId;
      }
      const lookupVersion = options.keyRing.lookup.currentVersion;
      const contextDigest = computeBrowserContextDigest(
        browserContext,
        options.keyRing,
        lookupVersion,
      );
      const previous = findActiveContext(transaction, grant.grantId, options, browserContext);
      if (previous !== null)
        grantTransaction.updateGrantSession({ ...previous, status: "revoked", revokedAtMs: nowMs });
      const bearer = Buffer.from(requireGrantBytes(options.randomness, 32)).toString("base64url");
      const session: StoredGrantSession = {
        sessionId: createRandomIdentifier("grant-session", options.randomness),
        grantId: grant.grantId,
        grantVersion: grant.grantVersion,
        eventGameId: eventGameId ?? "grant-management",
        browserContextDigest: contextDigest,
        browserContextKeyVersion: lookupVersion,
        bearerMaterialState: "present",
        bearerLookupVerifier: computeSessionVerifier(bearer, options.keyRing, lookupVersion),
        bearerLookupKeyVersion: lookupVersion,
        status: "active",
        createdAtMs: nowMs,
        lastActiveAtMs: nowMs,
        revokedAtMs: null,
        deviceClass: coarse(record.deviceClass),
        browserClass: coarse(record.browserClass),
      };
      grantTransaction.insertGrantSession(session);
      const audit = createAuditEntry(
        options,
        auditInput(
          previous === null ? "session-admitted" : "session-replaced",
          grant,
          {
            kind: "session",
            sessionId: session.sessionId,
            pseudonymKeyVersion: session.browserContextKeyVersion,
          },
          grant.status,
          session.sessionId,
          previous?.sessionId ?? null,
          eventGameId,
        ),
      );
      grantTransaction.appendGrantAudit(audit);
      const codeAudit = createAuditEntry(
        options,
        auditInput(
          "grant-code-admitted",
          grant,
          {
            kind: "session",
            sessionId: session.sessionId,
            pseudonymKeyVersion: session.browserContextKeyVersion,
          },
          grant.status,
          session.sessionId,
          null,
          eventGameId,
        ),
      );
      grantTransaction.appendGrantAudit({
        ...codeAudit,
        credentialKind: GRANT_CODE_KIND,
        credentialFingerprint: grant.code.fingerprint,
        codeFormatVersion: grant.code.formatVersion,
        codeEncryptionKeyVersion: grant.code.encryptionKeyVersion,
        codeLookupKeyVersion: grant.code.lookupKeyVersion,
        codeStateBefore: grant.code.state,
        codeState: "present",
      });
      recordAdmissionSuccess(grantTransaction, "code", budget.sourceDigest, nowMs);
      return {
        status: "admitted",
        grantId: grant.grantId,
        grantVersion: grant.grantVersion,
        grantType: grant.grantType,
        scope: structuredClone(grant.scope),
        eventGameId,
        grantSessionId: session.sessionId,
        sessionBearer: bearer,
      };
    });
  } catch {
    return GENERIC_GRANT_ADMISSION_FAILURE;
  }
}

function codeBinding(options: GrantAuthorityOptions, grant: StoredGrant, version: string) {
  return {
    environmentId: options.environmentId,
    grantId: grant.grantId,
    grantType: grant.grantType,
    grantVersion: version,
    scope: grant.scope,
  };
}
