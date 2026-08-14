import {
  computeGrantAuditIntegrityTag,
  computeCredentialFingerprint,
  computeLookupDigest,
  decryptCredential,
  parseCredentialToken,
} from "@/lib/grant-crypto";
import {
  GRANT_CREDENTIAL_FORMAT_VERSION,
  GRANT_CREDENTIAL_KIND,
  OPAQUE_MIGRATION_CREDENTIAL_REFERENCE_PREFIX,
  isStoredGrantSessionStatus,
  isStoredGrantStatus,
  validateGrantScope,
  type GrantKeyRing,
  type GrantScope,
  type StoredGrant,
  type StoredGrantAuditEntry,
  type StoredGrantSession,
  type TerminalGrantSessionReason,
} from "@/lib/grant-types";
import { validateOpaqueIdentifier } from "@/lib/validation-policy";

export type GrantStateValidationContext = {
  environmentId?: string;
  keyRing?: GrantKeyRing;
  migrationProvenance?: ReadonlyMap<string, string>;
  migrationExpiryProvenance?: ReadonlyMap<string, number | null>;
  auditProvenance?: ReadonlyMap<string, StoredGrantAuditEntry>;
  auditIntegrityTags?: ReadonlyMap<string, string>;
};

export function validateGrantState(
  grants: Iterable<StoredGrant>,
  sessions: Iterable<StoredGrantSession>,
  audits: Iterable<StoredGrantAuditEntry>,
  context: GrantStateValidationContext = {},
): string | null {
  const keyRingFailure = validateKeyRing(context.keyRing);
  if (keyRingFailure !== null) return keyRingFailure;
  const auditEntries = [...audits];
  if (context.auditProvenance !== undefined) {
    if (context.auditProvenance.size !== auditEntries.length) {
      return "Stored Grant Audit Trail provenance history is incomplete.";
    }
    for (const audit of auditEntries) {
      const durable = context.auditProvenance.get(audit.auditId);
      if (durable === undefined || JSON.stringify(durable) !== JSON.stringify(audit)) {
        return "Stored Grant Audit Trail evidence has been mutated.";
      }
    }
  }
  if (context.auditIntegrityTags !== undefined) {
    if (context.auditIntegrityTags.size !== auditEntries.length) {
      return "Stored Grant Audit Trail integrity tags are incomplete.";
    }
    for (const audit of auditEntries) {
      const tag = context.auditIntegrityTags.get(audit.auditId);
      if (tag === undefined || context.keyRing === undefined) {
        return "Stored Grant Audit Trail integrity cannot be verified.";
      }
      const tagParts = tag.split(":");
      const keyVersion = tagParts[1];
      if (
        tagParts.length !== 3 ||
        keyVersion === undefined ||
        tag !== computeGrantAuditIntegrityTag(audit, context.keyRing, keyVersion)
      ) {
        return "Stored Grant Audit Trail integrity is invalid.";
      }
    }
  }

  const grantMap = new Map<string, StoredGrant>();
  for (const grant of grants) {
    const failure = validateGrant(grant, context);
    if (failure !== null) return failure;
    if (grantMap.has(grant.grantId)) return "Stored Grant identities are not unique.";
    grantMap.set(grant.grantId, grant);
  }
  if (context.migrationProvenance !== undefined) {
    for (const [grantId, fingerprint] of context.migrationProvenance) {
      const grant = grantMap.get(grantId);
      if (
        grant === undefined ||
        !isOpaqueMigrationReference(fingerprint) ||
        (isOpaqueMigrationReference(grant.credential.fingerprint) &&
          grant.credential.fingerprint !== fingerprint)
      )
        return "Stored Grant migration provenance is invalid.";
    }
  }

  const sessionMap = new Map<string, StoredGrantSession>();
  for (const session of sessions) {
    const grant = grantMap.get(session.grantId);
    if (grant === undefined) return "Stored Grant Session references an unknown Grant.";
    const failure = validateSession(session, grant, context);
    if (failure !== null) return failure;
    if (sessionMap.has(session.sessionId)) return "Stored Grant Session identities are not unique.";
    sessionMap.set(session.sessionId, session);
  }

  for (const audit of auditEntries) {
    const grant = grantMap.get(audit.grantId);
    if (grant === undefined) return "Stored Grant Audit Trail references an unknown Grant.";
    const failure = validateAudit(audit, grant, sessionMap, context);
    if (failure !== null) return failure;
  }
  for (const grant of grantMap.values()) {
    const grantAudits = auditEntries.filter((audit) => audit.grantId === grant.grantId);
    const completenessFailure = validateGrantAuditCompleteness(
      grant,
      grantAudits,
      sessionMap,
      context,
    );
    if (completenessFailure !== null) return completenessFailure;
    if (grantAudits.filter((audit) => audit.action === "grant-created").length !== 1)
      return "Stored Grant Audit Trail is missing exactly one Grant creation record.";
    const expiryCount = grantAudits.filter((audit) => audit.action === "grant-expired").length;
    if (expiryCount !== (grant.status === "expired" ? 1 : 0))
      return "Stored Grant Audit Trail terminal expiry evidence is incomplete.";
  }
  return null;
}

function validateGrantAuditCompleteness(
  grant: StoredGrant,
  audits: readonly StoredGrantAuditEntry[],
  sessions: ReadonlyMap<string, StoredGrantSession>,
  context: GrantStateValidationContext,
): string | null {
  const auditIds = new Set<string>();
  for (const audit of audits) {
    if (auditIds.has(audit.auditId)) return "Stored Grant Audit Trail identities are not unique.";
    auditIds.add(audit.auditId);
  }
  const created = audits.filter((audit) => audit.action === "grant-created");
  if (created.length !== 1) return "Stored Grant Audit Trail is missing Grant creation evidence.";
  if (
    isOpaqueMigrationReference(grant.credential.fingerprint) &&
    audits.some(
      (audit) =>
        audit.action === "credential-rotated" ||
        audit.action === "grant-reactivated" ||
        audit.action === "grant-metadata-updated",
    )
  ) {
    return "Stored migrated Grant retained an opaque reference after credential replacement.";
  }
  const creation = created[0];
  if (
    creation === undefined ||
    creation.beforeStatus !== null ||
    creation.afterStatus === null ||
    (creation.grantVersion !== grant.grantVersion &&
      !audits.some(
        (audit) =>
          audit.action === "credential-rotated" ||
          audit.action === "grant-reactivated" ||
          audit.action === "grant-metadata-updated",
      ))
  ) {
    return "Stored Grant creation evidence is inconsistent.";
  }

  const ordered = [...audits].sort(
    (left, right) =>
      left.createdAtMs - right.createdAtMs || left.auditId.localeCompare(right.auditId),
  );
  let expectedStatus: StoredGrant["status"] = creation.afterStatus;
  let expectedVersion = creation.grantVersion;
  let expectedScope = creation.scope;
  let expectedExpiresAtMs = creation.afterExpiresAtMs;
  const migrationExpiresAtMs = context.migrationExpiryProvenance?.get(grant.grantId);
  if (migrationExpiresAtMs !== undefined) expectedExpiresAtMs = migrationExpiresAtMs;
  const scopeByVersion = new Map<string, GrantScope>([[creation.grantVersion, creation.scope]]);
  let expiredEvidence = false;
  const stateActions = new Set<StoredGrantAuditEntry["action"]>([
    "grant-disabled",
    "grant-revoked",
    "grant-reactivated",
    "grant-metadata-updated",
    "credential-rotated",
    "grant-expired",
  ]);
  const stateAudits = ordered.filter((audit) => stateActions.has(audit.action));
  const remainingStateAudits = [...stateAudits];
  while (remainingStateAudits.length > 0) {
    const index = remainingStateAudits.findIndex(
      (audit) => audit.beforeStatus === null || audit.beforeStatus === expectedStatus,
    );
    if (index < 0) return "Stored Grant Audit Trail lifecycle continuity is invalid.";
    const [audit] = remainingStateAudits.splice(index, 1);
    if (audit === undefined) return "Stored Grant Audit Trail lifecycle continuity is invalid.";
    if (audit.afterStatus !== null) expectedStatus = audit.afterStatus;
    expectedVersion = audit.grantVersion;
    expectedScope = audit.scope;
    scopeByVersion.set(audit.grantVersion, audit.scope);
    const hasExpiryEvidence =
      audit.beforeExpiresAtMs !== null ||
      audit.afterExpiresAtMs !== null ||
      audit.action === "grant-metadata-updated";
    if (hasExpiryEvidence) {
      if (
        audit.beforeExpiresAtMs !== null &&
        expectedExpiresAtMs !== null &&
        audit.beforeExpiresAtMs !== expectedExpiresAtMs
      ) {
        return "Stored Grant Audit Trail expiry continuity is invalid.";
      }
      expectedExpiresAtMs = audit.afterExpiresAtMs;
    }
    if (audit.action === "grant-expired") expiredEvidence = true;
  }
  for (const audit of ordered) {
    if (audit.action === "grant-created" || stateActions.has(audit.action)) continue;
    const historicalScope = scopeByVersion.get(audit.grantVersion);
    if (historicalScope !== undefined && !sameScope(historicalScope, audit.scope)) {
      return "Stored Grant Audit Trail scope evidence is inconsistent.";
    }
    if (
      (audit.action === "session-admitted" || audit.action === "session-replaced") &&
      (audit.sessionId === null || !sessions.has(audit.sessionId))
    ) {
      return "Stored Grant Audit Trail is missing session admission evidence.";
    }
    if (audit.action === "session-replaced") {
      if (audit.replacedSessionId === null || !sessions.has(audit.replacedSessionId))
        return "Stored Grant Audit Trail is missing session replacement evidence.";
    }
    if (
      (audit.action === "session-revoked" || audit.action === "session-terminated") &&
      (audit.sessionId === null || !sessions.has(audit.sessionId))
    ) {
      return "Stored Grant Audit Trail is missing session terminal evidence.";
    }
  }
  if (expectedStatus !== grant.status || expectedVersion !== grant.grantVersion) {
    return "Stored Grant Audit Trail does not reconstruct the current Grant state.";
  }
  if (!sameScope(expectedScope, grant.scope)) {
    return "Stored Grant Audit Trail does not reconstruct the current Grant scope.";
  }
  if (
    expectedExpiresAtMs !== null ||
    migrationExpiresAtMs !== undefined ||
    creation.afterExpiresAtMs !== null
  ) {
    if (expectedExpiresAtMs !== grant.expiresAtMs) {
      return "Stored Grant Audit Trail does not reconstruct the current Grant expiry.";
    }
  }
  if (expiredEvidence !== (grant.status === "expired")) {
    return "Stored Grant Audit Trail terminal expiry evidence is incomplete.";
  }

  const grantSessionAudits = new Map<string, StoredGrantAuditEntry[]>();
  for (const audit of ordered) {
    if (audit.sessionId === null) continue;
    const entries = grantSessionAudits.get(audit.sessionId) ?? [];
    entries.push(audit);
    grantSessionAudits.set(audit.sessionId, entries);
  }
  for (const session of sessions.values()) {
    if (session.grantId !== grant.grantId) continue;
    const sessionAudits = grantSessionAudits.get(session.sessionId) ?? [];
    const admitted = ordered.some(
      (audit) =>
        (audit.action === "session-admitted" || audit.action === "session-replaced") &&
        audit.sessionId === session.sessionId,
    );
    if (!admitted) return "Stored Grant Audit Trail is missing session admission evidence.";
    const terminalCount = sessionAudits.filter(
      (audit) => audit.action === "session-terminated",
    ).length;
    if (terminalCount > 1) return "Stored Grant Audit Trail contains duplicate terminal evidence.";
    if (session.status === "active") continue;
    const hasDirectTermination = sessionAudits.some(
      (audit) => audit.action === "session-revoked" || audit.action === "session-terminated",
    );
    const wasReplaced = ordered.some(
      (audit) =>
        audit.action === "session-replaced" && audit.replacedSessionId === session.sessionId,
    );
    const grantWideTermination = ordered.some(
      (audit) =>
        audit.action === "grant-expired" ||
        audit.action === "grant-revoked" ||
        audit.action === "grant-reactivated" ||
        audit.action === "grant-metadata-updated" ||
        audit.action === "credential-rotated",
    );
    if (!hasDirectTermination && !wasReplaced && !grantWideTermination) {
      return "Stored Grant Audit Trail is missing session revocation evidence.";
    }
  }
  return null;
}

function validateGrant(grant: StoredGrant, context: GrantStateValidationContext): string | null {
  const deepCredentialValidation =
    context.environmentId !== undefined || context.keyRing !== undefined;
  if (
    !validateOpaqueIdentifier(grant.grantId, "grantId").ok ||
    !validateOpaqueIdentifier(grant.grantVersion, "grantVersion").ok ||
    !isStoredGrantStatus(grant.status) ||
    !Number.isSafeInteger(grant.createdAtMs) ||
    grant.createdAtMs < 0 ||
    (grant.expiresAtMs !== null &&
      (!Number.isSafeInteger(grant.expiresAtMs) || grant.expiresAtMs <= grant.createdAtMs)) ||
    !validateGrantScope(grant.grantType, grant.scope).ok
  ) {
    return "Stored Grant identity or lifecycle metadata is invalid.";
  }
  const credential = grant.credential;
  if (
    (credential.materialState !== "present" && credential.materialState !== "erased") ||
    credential.formatVersion !== GRANT_CREDENTIAL_FORMAT_VERSION ||
    credential.kind !== GRANT_CREDENTIAL_KIND ||
    (grant.status === "expired") !== (credential.materialState === "erased")
  ) {
    return "Stored Grant credential lifecycle state is invalid.";
  }

  if (credential.materialState === "erased") {
    if (
      credential.encryptionKeyVersion !== null ||
      credential.lookupKeyVersion !== null ||
      credential.iv !== null ||
      credential.ciphertext !== null ||
      credential.tag !== null ||
      credential.lookupDigest !== null
    )
      return "Stored erased Grant credential material is invalid.";
    const migrationReference = migrationReferenceFor(grant, context);
    if (credential.fingerprint.startsWith(OPAQUE_MIGRATION_CREDENTIAL_REFERENCE_PREFIX)) {
      if (migrationReference === null)
        return "Stored erased Grant migration reference is malformed.";
    } else if (deepCredentialValidation && !isBase64UrlBytes(credential.fingerprint, 32)) {
      return "Stored erased Grant fingerprint is malformed.";
    }
    return null;
  }

  if (
    credential.encryptionKeyVersion === null ||
    credential.lookupKeyVersion === null ||
    credential.iv === null ||
    credential.ciphertext === null ||
    credential.tag === null ||
    credential.lookupDigest === null
  )
    return "Stored Grant credential material is incomplete.";
  const migrationReference = migrationReferenceFor(grant, context);
  if (
    credential.fingerprint.startsWith(OPAQUE_MIGRATION_CREDENTIAL_REFERENCE_PREFIX) &&
    migrationReference === null
  )
    return "Stored Grant migration reference is not recorded.";
  if (
    deepCredentialValidation &&
    (!isBase64UrlBytes(credential.iv, 12) ||
      !isBase64UrlAtLeast(credential.ciphertext, 1) ||
      !isBase64UrlBytes(credential.tag, 16) ||
      !isBase64UrlBytes(credential.lookupDigest, 32) ||
      (migrationReference === null && !isBase64UrlBytes(credential.fingerprint, 32)))
  )
    return "Stored Grant credential material is malformed.";
  if (context.keyRing !== undefined) {
    if (!hasAesKey(context.keyRing.encryption.keys, credential.encryptionKeyVersion))
      return "A required Grant encryption key version is unavailable.";
    if (!hasKey(context.keyRing.lookup.keys, credential.lookupKeyVersion, 32))
      return "A required Grant lookup key version is unavailable.";
  }
  if (context.environmentId !== undefined) {
    const binding = {
      environmentId: context.environmentId,
      grantId: grant.grantId,
      grantType: grant.grantType,
      grantVersion: grant.grantVersion,
      scope: grant.scope,
    };
    if (context.keyRing === undefined) return "Grant key material is not configured.";
    const token = decryptCredential(credential, binding, context.keyRing);
    const parsed = token === null ? null : parseCredentialToken(token);
    if (
      token === null ||
      parsed === null ||
      parsed.environmentId !== context.environmentId ||
      parsed.grantId !== grant.grantId ||
      parsed.grantType !== grant.grantType ||
      parsed.grantVersion !== grant.grantVersion ||
      !sameScope(parsed.scope, grant.scope) ||
      computeLookupDigest(token, context.keyRing, credential.lookupKeyVersion) !==
        credential.lookupDigest ||
      (migrationReference === null &&
        computeCredentialFingerprint(token, context.keyRing, credential.lookupKeyVersion) !==
          credential.fingerprint)
    ) {
      return "Stored Grant credential authentication failed.";
    }
  }
  return null;
}

function validateSession(
  session: StoredGrantSession,
  grant: StoredGrant,
  context: GrantStateValidationContext,
): string | null {
  if (
    !validateOpaqueIdentifier(session.sessionId, "sessionId").ok ||
    !validateOpaqueIdentifier(session.grantId, "session.grantId").ok ||
    !validateOpaqueIdentifier(session.grantVersion, "session.grantVersion").ok ||
    session.eventGameId.length === 0 ||
    session.browserContextKeyVersion.length === 0 ||
    !isStoredGrantSessionStatus(session.status) ||
    !Number.isSafeInteger(session.createdAtMs) ||
    session.createdAtMs < 0 ||
    !Number.isSafeInteger(session.lastActiveAtMs) ||
    session.lastActiveAtMs < session.createdAtMs ||
    (session.bearerMaterialState !== "present" && session.bearerMaterialState !== "erased") ||
    (session.revokedAtMs !== null &&
      (!Number.isSafeInteger(session.revokedAtMs) || session.revokedAtMs < 0)) ||
    (session.status === "active" && session.revokedAtMs !== null) ||
    (session.status === "active" && session.grantVersion !== grant.grantVersion) ||
    (session.status === "expired") !== (session.bearerMaterialState === "erased")
  ) {
    return "Stored Grant Session metadata is invalid.";
  }
  if (context.environmentId !== undefined && !isBase64UrlBytes(session.browserContextDigest, 32))
    return "Stored Grant Session browser context material is malformed.";
  if (session.bearerMaterialState === "present") {
    if (session.bearerLookupVerifier === null || session.bearerLookupKeyVersion === null)
      return "Stored Grant Session bearer material is incomplete.";
    if (context.environmentId !== undefined && !isBase64UrlBytes(session.bearerLookupVerifier, 32))
      return "Stored Grant Session bearer material is malformed.";
    if (
      context.keyRing !== undefined &&
      !hasKey(context.keyRing.lookup.keys, session.bearerLookupKeyVersion, 32)
    )
      return "A required Grant Session lookup key version is unavailable.";
  } else if (session.bearerLookupVerifier !== null || session.bearerLookupKeyVersion !== null) {
    return "Stored erased Grant Session material is invalid.";
  }
  if (
    context.keyRing !== undefined &&
    !hasKey(context.keyRing.lookup.keys, session.browserContextKeyVersion, 32)
  )
    return "A required Grant Session context key version is unavailable.";
  return null;
}

function validateAudit(
  audit: StoredGrantAuditEntry,
  grant: StoredGrant,
  sessions: ReadonlyMap<string, StoredGrantSession>,
  context: GrantStateValidationContext,
): string | null {
  const deepCredentialValidation =
    context.environmentId !== undefined || context.keyRing !== undefined;
  const allowedActions: readonly StoredGrantAuditEntry["action"][] = [
    "grant-created",
    "credential-revealed",
    "credential-rotated",
    "grant-expired",
    "grant-disabled",
    "grant-revoked",
    "grant-reactivated",
    "grant-metadata-updated",
    "session-admitted",
    "session-replaced",
    "session-revoked",
    "session-terminated",
  ];
  const allowedTerminalReasons: readonly TerminalGrantSessionReason[] = [
    "game-locked",
    "accepted-game-switch",
    "past-game-day",
  ];
  if (
    !allowedActions.includes(audit.action) ||
    audit.outcome !== "accepted" ||
    !validateOpaqueIdentifier(audit.auditId, "auditId").ok ||
    !validateOpaqueIdentifier(audit.grantId, "audit.grantId").ok ||
    !validateOpaqueIdentifier(audit.grantVersion, "audit.grantVersion").ok ||
    audit.actorReference.length === 0 ||
    !audit.actorReference.startsWith("actor-") ||
    !Number.isSafeInteger(audit.createdAtMs) ||
    audit.createdAtMs < 0 ||
    audit.grantType !== grant.grantType ||
    !validateGrantScope(audit.grantType, audit.scope).ok ||
    audit.credentialKind !== GRANT_CREDENTIAL_KIND ||
    (audit.beforeStatus !== null && !isStoredGrantStatus(audit.beforeStatus)) ||
    (audit.afterStatus !== null && !isStoredGrantStatus(audit.afterStatus)) ||
    (audit.beforeExpiresAtMs !== null &&
      (!Number.isSafeInteger(audit.beforeExpiresAtMs) || audit.beforeExpiresAtMs < 0)) ||
    (audit.afterExpiresAtMs !== null &&
      (!Number.isSafeInteger(audit.afterExpiresAtMs) || audit.afterExpiresAtMs < 0)) ||
    (audit.terminalReason !== null && !allowedTerminalReasons.includes(audit.terminalReason))
  )
    return "Stored Grant Audit Trail provenance is invalid.";
  if (audit.action === "session-terminated") {
    if (audit.terminalReason === null || audit.sessionId === null || audit.eventGameId === null)
      return "Stored terminal Grant Audit Trail evidence is incomplete.";
    const session = sessions.get(audit.sessionId);
    if (
      session === undefined ||
      session.grantId !== audit.grantId ||
      session.grantVersion !== audit.grantVersion ||
      session.eventGameId !== audit.eventGameId
    )
      return "Stored terminal Grant Audit Trail provenance is invalid.";
  } else if (audit.terminalReason !== null) {
    return "Stored non-terminal Grant Audit Trail evidence has a terminal reason.";
  }
  if (audit.credentialFingerprint !== null) {
    if (migrationReferenceFor(grant, context) !== null)
      return "Stored migration Grant Audit Trail credential evidence must be erased.";
    if (
      deepCredentialValidation &&
      !isOpaqueMigrationReference(grant.credential.fingerprint) &&
      !isBase64UrlBytes(audit.credentialFingerprint, 32)
    )
      return "Stored Grant Audit Trail credential evidence is malformed.";
  }
  return null;
}

function validateKeyRing(keyRing: GrantKeyRing | undefined): string | null {
  if (keyRing === undefined) return null;
  if (
    typeof keyRing.encryption.currentVersion !== "string" ||
    typeof keyRing.lookup.currentVersion !== "string" ||
    typeof keyRing.audit.currentVersion !== "string" ||
    !hasAesKey(keyRing.encryption.keys, keyRing.encryption.currentVersion) ||
    !hasKey(keyRing.lookup.keys, keyRing.lookup.currentVersion, 32) ||
    !hasKey(keyRing.audit.keys, keyRing.audit.currentVersion, 32)
  )
    return "The configured Grant key ring is unusable.";
  return null;
}

function hasKey(
  keys: ReadonlyMap<string, Uint8Array>,
  version: string | null,
  minimum: number,
): boolean {
  return version !== null && version.length > 0 && (keys.get(version)?.byteLength ?? 0) >= minimum;
}

function hasAesKey(keys: ReadonlyMap<string, Uint8Array>, version: string | null): boolean {
  return version !== null && version.length > 0 && keys.get(version)?.byteLength === 32;
}

function isBase64UrlBytes(value: string | null, expectedLength: number): boolean {
  if (value === null || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const bytes = new Uint8Array(Buffer.from(value, "base64url"));
    return (
      bytes.byteLength === expectedLength && Buffer.from(bytes).toString("base64url") === value
    );
  } catch {
    return false;
  }
}

function isBase64UrlAtLeast(value: string | null, minimumLength: number): boolean {
  if (value === null || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const bytes = new Uint8Array(Buffer.from(value, "base64url"));
    return bytes.byteLength >= minimumLength && Buffer.from(bytes).toString("base64url") === value;
  } catch {
    return false;
  }
}

function isOpaqueMigrationReference(value: string): boolean {
  return /^opaque-migration-reference-v1:[a-f0-9]{64}$/.test(value);
}

function migrationReferenceFor(
  grant: StoredGrant,
  context: GrantStateValidationContext,
): string | null {
  const fingerprint = grant.credential.fingerprint;
  if (!isOpaqueMigrationReference(fingerprint)) return null;
  return context.migrationProvenance?.get(grant.grantId) === fingerprint ? fingerprint : null;
}

function sameScope(left: GrantScope, right: GrantScope): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
