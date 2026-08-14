import {
  computeGrantAuditIntegrityTag,
  computeLegacyGrantAuditIntegrityTag,
  computeCredentialFingerprint,
  computeLookupDigest,
  decryptCredential,
  parseCredentialToken,
} from "@/lib/grant-crypto";
import { decryptGrantCode, grantCodeFingerprint, grantCodeLookupDigest } from "@/lib/grant-code";
import {
  GRANT_CREDENTIAL_FORMAT_VERSION,
  GRANT_CREDENTIAL_KIND,
  GRANT_CODE_KIND,
  GRANT_CODE_FORMAT_VERSION,
  GRANT_ADMISSION_GLOBAL_ATTEMPT_LIMITS,
  GRANT_ADMISSION_SOURCE_FAILURE_SATURATION,
  OPAQUE_MIGRATION_CREDENTIAL_REFERENCE_PREFIX,
  isStoredGrantSessionStatus,
  isStoredGrantStatus,
  validateGrantScope,
  type GrantKeyRing,
  type GrantAdmissionGlobalWindow,
  type GrantAdmissionTelemetry,
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
  admissionTelemetry?: Iterable<GrantAdmissionTelemetry>;
  admissionGlobalWindows?: Iterable<GrantAdmissionGlobalWindow>;
};

export function orderGrantAudits(audits: Iterable<StoredGrantAuditEntry>): StoredGrantAuditEntry[] {
  return [...audits].sort((left, right) => {
    if (left.auditSequence === undefined && right.auditSequence !== undefined) return -1;
    if (left.auditSequence !== undefined && right.auditSequence === undefined) return 1;
    return (
      (left.auditSequence ?? 0) - (right.auditSequence ?? 0) ||
      left.createdAtMs - right.createdAtMs ||
      left.auditId.localeCompare(right.auditId)
    );
  });
}

export function grantStateMaterial(
  grants: Iterable<StoredGrant>,
  sessions: Iterable<StoredGrantSession>,
  audits: Iterable<StoredGrantAuditEntry>,
  telemetry: Iterable<GrantAdmissionTelemetry> = [],
  globalWindows: Iterable<GrantAdmissionGlobalWindow> = [],
): string {
  return JSON.stringify({
    grants: [...grants].sort((left, right) => left.grantId.localeCompare(right.grantId)),
    sessions: [...sessions].sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
    audits: orderGrantAudits(audits),
    telemetry: [...telemetry].sort((left, right) =>
      `${left.mode}:${left.sourceDigest}`.localeCompare(`${right.mode}:${right.sourceDigest}`),
    ),
    globalWindows: [...globalWindows].sort((left, right) => left.mode.localeCompare(right.mode)),
  });
}

export function grantAdmissionStateMaterial(
  telemetry: Iterable<GrantAdmissionTelemetry>,
  globalWindows: Iterable<GrantAdmissionGlobalWindow>,
): string {
  return JSON.stringify({
    telemetry: [...telemetry].sort((left, right) =>
      `${left.mode}:${left.sourceDigest}`.localeCompare(`${right.mode}:${right.sourceDigest}`),
    ),
    globalWindows: [...globalWindows].sort((left, right) => left.mode.localeCompare(right.mode)),
  });
}

export function validateGrantState(
  grants: Iterable<StoredGrant>,
  sessions: Iterable<StoredGrantSession>,
  audits: Iterable<StoredGrantAuditEntry>,
  context: GrantStateValidationContext = {},
): string | null {
  const keyRingFailure = validateKeyRing(context.keyRing);
  if (keyRingFailure !== null) return keyRingFailure;
  const auditEntries = [...audits];
  const chainFailure = validateAuditChain(auditEntries);
  if (chainFailure !== null) return chainFailure;
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
        (tag !== computeGrantAuditIntegrityTag(audit, context.keyRing, keyVersion) &&
          (audit.action === "session-switched" ||
            audit.action === "replay-authorized" ||
            tag !== computeLegacyGrantAuditIntegrityTag(audit, context.keyRing, keyVersion)))
      ) {
        return "Stored Grant Audit Trail integrity is invalid.";
      }
    }
  }

  const telemetryFailure = validateAdmissionState(context);
  if (telemetryFailure !== null) return telemetryFailure;

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

  const switchFailure = validateSessionSwitchChains(auditEntries, sessionMap, grantMap);
  if (switchFailure !== null) return switchFailure;

  for (const audit of auditEntries) {
    const grant = grantMap.get(audit.grantId);
    if (grant === undefined) return "Stored Grant Audit Trail references an unknown Grant.";
    const failure = validateAudit(audit, grant, sessionMap, auditEntries, context);
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

function validateAuditChain(audits: readonly StoredGrantAuditEntry[]): string | null {
  const byGrant = new Map<string, StoredGrantAuditEntry[]>();
  for (const audit of audits) {
    const entries = byGrant.get(audit.grantId) ?? [];
    entries.push(audit);
    byGrant.set(audit.grantId, entries);
  }
  for (const entries of byGrant.values()) {
    const ordered = orderGrantAudits(entries);
    const seenSequences = new Set<number>();
    let sequenceStarted = false;
    for (let index = 0; index < ordered.length; index += 1) {
      const audit = ordered[index];
      if (audit === undefined) continue;
      if (audit.auditSequence === undefined || audit.auditSequence === null) {
        if (sequenceStarted) return "Stored Grant Audit Trail sequence was downgraded.";
        if ((audit.predecessorAuditId ?? null) !== null) {
          return "Stored Grant Audit Trail legacy predecessor is invalid.";
        }
        continue;
      }
      sequenceStarted = true;
      if (
        !Number.isSafeInteger(audit.auditSequence) ||
        audit.auditSequence !== index + 1 ||
        seenSequences.has(audit.auditSequence) ||
        (audit.predecessorAuditId ?? null) !== (ordered[index - 1]?.auditId ?? null)
      ) {
        return "Stored Grant Audit Trail sequence or predecessor is invalid.";
      }
      seenSequences.add(audit.auditSequence);
    }
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

  const ordered = orderGrantAudits(audits);
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
    if (
      audit.action === "grant-created" ||
      stateActions.has(audit.action) ||
      audit.action === "grant-code-created" ||
      audit.action === "grant-code-replaced" ||
      audit.action === "grant-code-disabled" ||
      audit.action === "grant-code-erased-expiry" ||
      audit.action === "grant-code-erased-game-lock" ||
      audit.action === "grant-code-admitted"
    )
      continue;
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
  const gameLockCodeFailure = validateGameLockCodeEvidence(
    grant,
    ordered,
    sessions,
    scopeByVersion,
  );
  if (gameLockCodeFailure !== null) return gameLockCodeFailure;

  let expectedCodeState: "absent" | "present" | "disabled" | "erased" = "absent";
  let expectedCodeFingerprint: string | null = null;
  let expectedCodeFormatVersion: number | null = null;
  let expectedCodeEncryptionKeyVersion: string | null = null;
  let expectedCodeLookupKeyVersion: string | null = null;
  for (const audit of ordered) {
    const isCodeAction =
      audit.action === "grant-code-created" ||
      audit.action === "grant-code-replaced" ||
      audit.action === "grant-code-disabled" ||
      audit.action === "grant-code-admitted";
    const hasCodeOnlyEvidence =
      audit.codeFormatVersion !== undefined ||
      audit.codeEncryptionKeyVersion !== undefined ||
      audit.codeLookupKeyVersion !== undefined ||
      audit.codeStateBefore !== undefined ||
      audit.codeState !== undefined ||
      audit.previousCodeFingerprint !== undefined;
    const isCodeErasure =
      audit.action === "grant-code-erased-expiry" || audit.action === "grant-code-erased-game-lock";
    if (isCodeAction) {
      if (audit.credentialKind !== GRANT_CODE_KIND)
        return "Stored Grant-Code Audit Trail credential kind is invalid.";
      if (
        audit.codeStateBefore === null ||
        audit.codeStateBefore === undefined ||
        audit.codeState === null ||
        audit.codeState === undefined ||
        audit.codeFormatVersion !== GRANT_CODE_FORMAT_VERSION ||
        audit.codeEncryptionKeyVersion === null ||
        audit.codeEncryptionKeyVersion === undefined ||
        audit.codeLookupKeyVersion === null ||
        audit.codeLookupKeyVersion === undefined
      ) {
        return "Stored Grant-Code Audit Trail state evidence is incomplete.";
      }
      if (audit.action === "grant-code-created") {
        if (
          (expectedCodeState !== "absent" &&
            expectedCodeState !== "disabled" &&
            expectedCodeState !== "erased") ||
          audit.codeStateBefore !== expectedCodeState ||
          audit.codeState !== "present" ||
          (expectedCodeState === "absent"
            ? (audit.previousCodeFingerprint ?? null) !== null
            : audit.previousCodeFingerprint !== expectedCodeFingerprint)
        ) {
          return "Stored Grant-Code creation continuity is invalid.";
        }
        expectedCodeFingerprint = audit.credentialFingerprint;
        expectedCodeFormatVersion = audit.codeFormatVersion;
        expectedCodeEncryptionKeyVersion = audit.codeEncryptionKeyVersion;
        expectedCodeLookupKeyVersion = audit.codeLookupKeyVersion;
      } else if (audit.action === "grant-code-replaced") {
        const auditIndex = ordered.findIndex((candidate) => candidate.auditId === audit.auditId);
        if (
          expectedCodeState !== "present" ||
          audit.codeStateBefore !== "present" ||
          audit.codeState !== "present" ||
          (audit.previousCodeFingerprint ?? null) !== expectedCodeFingerprint ||
          audit.credentialFingerprint === null ||
          (audit.credentialFingerprint === expectedCodeFingerprint &&
            !ordered
              .slice(0, auditIndex)
              .some(
                (candidate) =>
                  candidate.action === "credential-rotated" &&
                  candidate.grantVersion === audit.grantVersion,
              ))
        ) {
          return "Stored Grant-Code replacement continuity is invalid.";
        }
        if (
          expectedCodeFormatVersion === null ||
          (audit.codeFormatVersion !== expectedCodeFormatVersion &&
            audit.codeFormatVersion !== GRANT_CODE_FORMAT_VERSION)
        )
          return "Stored Grant-Code replacement envelope is invalid.";
        expectedCodeFingerprint = audit.credentialFingerprint;
        expectedCodeFormatVersion = audit.codeFormatVersion;
        expectedCodeEncryptionKeyVersion = audit.codeEncryptionKeyVersion;
        expectedCodeLookupKeyVersion = audit.codeLookupKeyVersion;
      } else if (audit.action === "grant-code-disabled") {
        const auditIndex = ordered.findIndex((candidate) => candidate.auditId === audit.auditId);
        const previousCodeFingerprint =
          [...ordered]
            .slice(0, auditIndex)
            .reverse()
            .find(
              (candidate) =>
                candidate.action === "grant-code-created" ||
                candidate.action === "grant-code-replaced",
            )?.credentialFingerprint ?? null;
        if (
          expectedCodeState !== "present" ||
          audit.codeStateBefore !== "present" ||
          audit.codeState !== "disabled" ||
          (audit.previousCodeFingerprint ?? null) !== previousCodeFingerprint ||
          audit.credentialFingerprint !== previousCodeFingerprint
        ) {
          return "Stored Grant-Code disable continuity is invalid.";
        }
        if (
          audit.codeFormatVersion !== expectedCodeFormatVersion ||
          audit.codeEncryptionKeyVersion !== expectedCodeEncryptionKeyVersion ||
          audit.codeLookupKeyVersion !== expectedCodeLookupKeyVersion
        )
          return "Stored Grant-Code disable envelope is invalid.";
        expectedCodeFingerprint = previousCodeFingerprint;
        expectedCodeEncryptionKeyVersion = null;
        expectedCodeLookupKeyVersion = null;
      } else if (
        expectedCodeState !== "present" ||
        audit.codeStateBefore !== "present" ||
        audit.codeState !== "present" ||
        (audit.previousCodeFingerprint ?? null) !== null ||
        audit.credentialFingerprint !== expectedCodeFingerprint
      ) {
        return "Stored Grant-Code admission continuity is invalid.";
      }
      if (
        audit.action === "grant-code-admitted" &&
        (audit.codeFormatVersion !== expectedCodeFormatVersion ||
          audit.codeEncryptionKeyVersion !== expectedCodeEncryptionKeyVersion ||
          audit.codeLookupKeyVersion !== expectedCodeLookupKeyVersion)
      )
        return "Stored Grant-Code admission envelope is invalid.";
      expectedCodeState = audit.codeState;
    } else if (isCodeErasure) {
      if (
        audit.credentialKind !== GRANT_CODE_KIND ||
        audit.codeState !== "erased" ||
        audit.codeStateBefore !== expectedCodeState ||
        audit.credentialFingerprint === null ||
        audit.credentialFingerprint !== audit.previousCodeFingerprint ||
        (expectedCodeState !== "present" && expectedCodeState !== "disabled") ||
        (audit.previousCodeFingerprint ?? null) !== expectedCodeFingerprint
      ) {
        return "Stored Grant-Code expiry continuity is invalid.";
      }
      if (
        audit.codeFormatVersion !== expectedCodeFormatVersion ||
        (expectedCodeState === "present" &&
          (audit.codeEncryptionKeyVersion !== expectedCodeEncryptionKeyVersion ||
            audit.codeLookupKeyVersion !== expectedCodeLookupKeyVersion)) ||
        (expectedCodeState === "disabled" &&
          (audit.codeEncryptionKeyVersion !== null || audit.codeLookupKeyVersion !== null))
      )
        return "Stored Grant-Code expiry envelope is invalid.";
      expectedCodeState = "erased";
      expectedCodeFormatVersion = GRANT_CODE_FORMAT_VERSION;
      expectedCodeEncryptionKeyVersion = null;
      expectedCodeLookupKeyVersion = null;
    } else if (hasCodeOnlyEvidence) {
      return "Stored Grant-Code state leaked into an unrelated audit action.";
    } else if (audit.credentialKind !== GRANT_CREDENTIAL_KIND) {
      return "Stored non-Code Grant Audit Trail credential kind is invalid.";
    }
  }
  const storedCodeState = grant.code?.state ?? "absent";
  if (storedCodeState !== expectedCodeState) {
    return "Stored Grant-Code Audit Trail does not reconstruct current code state.";
  }
  if (
    grant.code !== undefined &&
    grant.code !== null &&
    grant.code.fingerprint !== expectedCodeFingerprint
  ) {
    return "Stored Grant-Code Audit Trail does not reconstruct current code fingerprint.";
  }
  if (grant.code !== undefined && grant.code !== null) {
    if (
      grant.code.formatVersion !== expectedCodeFormatVersion ||
      grant.code.encryptionKeyVersion !== expectedCodeEncryptionKeyVersion ||
      grant.code.lookupKeyVersion !== expectedCodeLookupKeyVersion
    )
      return "Stored Grant-Code Audit Trail does not reconstruct the current code envelope.";
  } else if (
    expectedCodeState === "present" ||
    expectedCodeFormatVersion !== null ||
    expectedCodeEncryptionKeyVersion !== null ||
    expectedCodeLookupKeyVersion !== null
  ) {
    return "Stored Grant-Code Audit Trail lost current code evidence.";
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
    const grantWideTermination = ordered.some((audit) => {
      if (
        audit.action === "grant-expired" ||
        audit.action === "grant-revoked" ||
        audit.action === "grant-reactivated" ||
        audit.action === "grant-metadata-updated"
      )
        return true;
      return audit.action === "credential-rotated" && audit.grantVersion !== session.grantVersion;
    });
    if (!hasDirectTermination && !wasReplaced && !grantWideTermination) {
      return "Stored Grant Audit Trail is missing session revocation evidence.";
    }
  }
  return null;
}

function validateGameLockCodeEvidence(
  grant: StoredGrant,
  ordered: readonly StoredGrantAuditEntry[],
  sessions: ReadonlyMap<string, StoredGrantSession>,
  scopeByVersion: ReadonlyMap<string, GrantScope>,
): string | null {
  const timeline = [...ordered].sort(
    (left, right) =>
      (left.auditSequence ?? Number.MAX_SAFE_INTEGER) -
        (right.auditSequence ?? Number.MAX_SAFE_INTEGER) ||
      left.createdAtMs - right.createdAtMs ||
      left.auditId.localeCompare(right.auditId),
  );
  const lockAudits = timeline.filter((audit) => audit.action === "grant-code-erased-game-lock");
  if (lockAudits.length === 0) {
    if (grant.status === "active" && grant.code?.state === "erased")
      return "Stored Grant Code erasure evidence is missing.";
    return null;
  }
  if (grant.grantType !== "control") return "Stored Grant Code erasure evidence is invalid.";

  let codeState: "absent" | "present" | "disabled" | "erased" = "absent";
  let codeFingerprint: string | null = null;
  let previousLockIndex = -1;
  const replayedSessions = new Map<string, ReplayedGrantSession>();
  let preLockSessions = new Map<string, ReplayedGrantSession>();
  for (const [auditIndex, audit] of timeline.entries()) {
    const sessionReplayFailure = replayGrantSessionAudit(
      replayedSessions,
      audit,
      grant.grantId,
      sessions,
      false,
    );
    if (sessionReplayFailure !== null) return sessionReplayFailure;
    if (!(audit.action === "session-terminated" && audit.terminalReason === "game-locked")) {
      const preLockReplayFailure = replayGrantSessionAudit(
        preLockSessions,
        audit,
        grant.grantId,
        sessions,
        true,
      );
      if (preLockReplayFailure !== null) return preLockReplayFailure;
    }
    if (audit.action === "grant-code-created" || audit.action === "grant-code-replaced") {
      if (audit.codeState !== "present" || audit.credentialFingerprint === null)
        return "Stored Grant Code creation evidence is incomplete.";
      const previousFingerprint = audit.previousCodeFingerprint ?? null;
      if (previousFingerprint === null) {
        if (codeState !== "absent" && codeState !== "erased")
          return "Stored Grant Code fingerprint history is invalid.";
      } else if (
        codeFingerprint !== previousFingerprint ||
        (codeState !== "present" && codeState !== "disabled" && codeState !== "erased") ||
        (audit.credentialFingerprint === previousFingerprint &&
          !timeline
            .slice(0, auditIndex)
            .some(
              (candidate) =>
                candidate.action === "credential-rotated" &&
                candidate.grantVersion === audit.grantVersion,
            ))
      ) {
        return "Stored Grant Code fingerprint history is invalid.";
      }
      if (
        (audit.action === "grant-code-replaced" &&
          (previousFingerprint === null || codeState !== "present")) ||
        (audit.action === "grant-code-created" &&
          previousFingerprint !== null &&
          codeState !== "disabled" &&
          codeState !== "erased")
      )
        return "Stored Grant Code replacement history is invalid.";
      codeState = "present";
      codeFingerprint = audit.credentialFingerprint;
      continue;
    }
    if (audit.action === "grant-code-disabled") {
      if (
        audit.codeState !== "disabled" ||
        audit.credentialFingerprint === null ||
        (audit.previousCodeFingerprint !== undefined &&
          audit.previousCodeFingerprint !== null &&
          audit.previousCodeFingerprint !== codeFingerprint) ||
        codeState !== "present" ||
        codeFingerprint !== audit.credentialFingerprint
      )
        return "Stored Grant Code disable evidence is incomplete.";
      codeState = "disabled";
      continue;
    }
    if (audit.action !== "grant-code-erased-game-lock") continue;

    if (
      audit.terminalReason !== "game-locked" ||
      audit.eventGameId === null ||
      !validateOpaqueIdentifier(audit.eventGameId, "eventGameId").ok ||
      audit.credentialKind !== GRANT_CODE_KIND ||
      audit.codeFormatVersion !== GRANT_CODE_FORMAT_VERSION ||
      audit.codeEncryptionKeyVersion === null ||
      audit.codeLookupKeyVersion === null ||
      audit.codeStateBefore !== "present" ||
      audit.codeState !== "erased" ||
      audit.credentialFingerprint === null ||
      audit.previousCodeFingerprint !== audit.credentialFingerprint ||
      (audit.beforeStatus !== "active" && audit.beforeStatus !== "disabled") ||
      audit.afterStatus !== audit.beforeStatus ||
      audit.sessionId !== null ||
      audit.replacedSessionId !== null ||
      codeState !== "present" ||
      codeFingerprint !== audit.credentialFingerprint
    )
      return "Stored Grant Code erasure evidence is incomplete.";
    const expectedScope = scopeByVersion.get(audit.grantVersion);
    if (expectedScope === undefined || !sameScope(expectedScope, audit.scope))
      return "Stored Grant Code erasure scope evidence is invalid.";

    const lockIndex = timeline.indexOf(audit);
    const interval = timeline.slice(previousLockIndex + 1, lockIndex);
    const activeSessionIds = new Set(
      [...preLockSessions.entries()]
        .filter(
          ([, session]) =>
            session.active &&
            session.grantVersion === audit.grantVersion &&
            session.eventGameId === audit.eventGameId,
        )
        .map(([sessionId]) => sessionId),
    );
    const gameLockedTerminations = interval.filter(
      (candidate) =>
        candidate.action === "session-terminated" &&
        candidate.terminalReason === "game-locked" &&
        candidate.grantId === grant.grantId &&
        candidate.grantVersion === audit.grantVersion &&
        candidate.eventGameId === audit.eventGameId,
    );
    const terminatedSessionIds = new Set<string>();
    for (const terminal of gameLockedTerminations) {
      if (terminal.sessionId === null || terminatedSessionIds.has(terminal.sessionId))
        return "Stored Grant Code erasure terminal session evidence is invalid.";
      terminatedSessionIds.add(terminal.sessionId);
    }
    if (
      gameLockedTerminations.length !== activeSessionIds.size ||
      terminatedSessionIds.size !== activeSessionIds.size ||
      [...activeSessionIds].some((sessionId) => !terminatedSessionIds.has(sessionId))
    )
      return "Stored Grant Code erasure session evidence is incomplete.";
    codeState = "erased";
    previousLockIndex = lockIndex;
    preLockSessions = cloneReplayedGrantSessions(replayedSessions);
  }

  if (grant.code === undefined || grant.code === null) {
    if (codeState !== "absent") return "Stored current Grant Code is missing.";
  } else if (grant.code.state !== codeState || grant.code.fingerprint !== codeFingerprint) {
    return "Stored current Grant Code does not match erasure evidence.";
  }
  return null;
}

type ReplayedGrantSession = {
  grantVersion: string;
  eventGameId: string;
  active: boolean;
};

function replayGrantSessionAudit(
  replayed: Map<string, ReplayedGrantSession>,
  audit: StoredGrantAuditEntry,
  grantId: string,
  sessions: ReadonlyMap<string, StoredGrantSession>,
  ignoreGameLockTermination: boolean,
): string | null {
  if (audit.grantId !== grantId) return null;
  if (audit.action === "session-admitted" || audit.action === "session-replaced") {
    if (
      audit.sessionId === null ||
      audit.eventGameId === null ||
      !validateOpaqueIdentifier(audit.eventGameId, "eventGameId").ok ||
      (audit.action === "session-admitted" && audit.replacedSessionId !== null) ||
      (audit.action === "session-replaced" && audit.replacedSessionId === null)
    )
      return "Stored Grant Session admission evidence is invalid.";
    const stored = sessions.get(audit.sessionId);
    if (
      stored === undefined ||
      stored.grantId !== grantId ||
      stored.grantVersion !== audit.grantVersion ||
      replayed.has(audit.sessionId)
    )
      return "Stored Grant Session admission history is invalid.";
    if (audit.replacedSessionId !== null) {
      const replaced = replayed.get(audit.replacedSessionId);
      if (
        replaced === undefined ||
        !replaced.active ||
        replaced.grantVersion !== audit.grantVersion
      )
        return "Stored Grant Session replacement history is invalid.";
      replaced.active = false;
    }
    replayed.set(audit.sessionId, {
      grantVersion: audit.grantVersion,
      eventGameId: audit.eventGameId,
      active: true,
    });
    return null;
  }
  if (audit.action === "session-revoked") {
    if (audit.sessionId === null) return "Stored Grant Session revocation evidence is invalid.";
    const session = replayed.get(audit.sessionId);
    if (session === undefined || !session.active)
      return "Stored Grant Session revocation history is invalid.";
    if (audit.eventGameId !== null && audit.eventGameId !== session.eventGameId)
      return "Stored Grant Session revocation Game binding is invalid.";
    session.active = false;
    return null;
  }
  if (audit.action === "session-terminated") {
    if (ignoreGameLockTermination && audit.terminalReason === "game-locked") return null;
    if (audit.sessionId === null || audit.eventGameId === null || audit.terminalReason === null)
      return "Stored terminal Grant Session evidence is incomplete.";
    const session = replayed.get(audit.sessionId);
    if (session === undefined || !session.active || session.eventGameId !== audit.eventGameId)
      return "Stored terminal Grant Session history is invalid.";
    session.active = false;
    return null;
  }
  if (audit.action === "session-switched") {
    if (
      audit.sessionId === null ||
      audit.previousEventGameId === null ||
      audit.eventGameId === null ||
      audit.previousEventGameId === audit.eventGameId
    )
      return "Stored Grant Session switch evidence is invalid.";
    const session = replayed.get(audit.sessionId);
    if (
      session === undefined ||
      !session.active ||
      session.eventGameId !== audit.previousEventGameId
    )
      return "Stored Grant Session switch history is invalid.";
    session.eventGameId = audit.eventGameId;
    return null;
  }
  if (
    audit.action === "grant-expired" ||
    audit.action === "grant-revoked" ||
    audit.action === "grant-reactivated" ||
    audit.action === "grant-metadata-updated"
  ) {
    for (const session of replayed.values()) session.active = false;
  } else if (audit.action === "credential-rotated") {
    // Key rewraps retain the Grant version and its live sessions. Full
    // credential rotation advances the version and revokes old sessions.
    for (const session of replayed.values()) {
      if (session.active && session.grantVersion !== audit.grantVersion) session.active = false;
    }
  }
  return null;
}

function cloneReplayedGrantSessions(
  sessions: ReadonlyMap<string, ReplayedGrantSession>,
): Map<string, ReplayedGrantSession> {
  return new Map(
    [...sessions.entries()].map(([sessionId, session]) => [sessionId, { ...session }]),
  );
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
    return validateStoredGrantCode(grant, context);
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
  return validateStoredGrantCode(grant, context);
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
    !validateOpaqueIdentifier(session.eventGameId, "session.eventGameId").ok ||
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

function validateStoredGrantCode(
  grant: StoredGrant,
  context: GrantStateValidationContext,
): string | null {
  const code = grant.code;
  if (code === undefined || code === null) return null;
  if (
    !["present", "disabled", "erased"].includes(code.state) ||
    code.formatVersion !== 1 ||
    code.kind !== "manual-code" ||
    !isBase64UrlBytes(code.fingerprint, 32)
  )
    return "Stored Grant Code metadata is invalid.";
  const hasMaterial =
    code.encryptionKeyVersion !== null &&
    code.lookupKeyVersion !== null &&
    code.iv !== null &&
    code.ciphertext !== null &&
    code.tag !== null &&
    code.lookupDigest !== null;
  if ((code.state === "present") !== hasMaterial)
    return "Stored Grant Code material state is invalid.";
  if (!hasMaterial) return null;
  if (
    context.keyRing !== undefined &&
    (!hasAesKey(context.keyRing.encryption.keys, code.encryptionKeyVersion) ||
      code.lookupKeyVersion !== context.keyRing.audit.currentVersion ||
      !hasKey(context.keyRing.audit.keys, code.lookupKeyVersion, 32) ||
      !isBase64UrlBytes(code.iv, 12) ||
      !isBase64UrlAtLeast(code.ciphertext, 1) ||
      !isBase64UrlBytes(code.tag, 16) ||
      !isBase64UrlBytes(code.lookupDigest, 32))
  )
    return "Stored Grant Code material is malformed.";
  if (code.state === "present") {
    if (context.environmentId === undefined || context.keyRing === undefined) {
      return "Grant-Code authentication context is not configured.";
    }
    const binding = {
      environmentId: context.environmentId,
      grantId: grant.grantId,
      grantType: grant.grantType,
      grantVersion: grant.grantVersion,
      scope: grant.scope,
    };
    const codeValue = decryptGrantCode(code, binding, context.keyRing);
    if (
      codeValue === null ||
      code.lookupKeyVersion !== context.keyRing.audit.currentVersion ||
      grantCodeLookupDigest(codeValue, context.keyRing, code.lookupKeyVersion) !==
        code.lookupDigest ||
      grantCodeFingerprint(codeValue, context.keyRing, code.lookupKeyVersion) !== code.fingerprint
    ) {
      return "Stored Grant Code authentication failed.";
    }
  }
  return null;
}

function validateAdmissionState(context: GrantStateValidationContext): string | null {
  const telemetry = [...(context.admissionTelemetry ?? [])];
  const sources = new Set<string>();
  for (const entry of telemetry) {
    if (
      (entry.mode !== "qr" && entry.mode !== "code") ||
      !isBase64UrlBytes(entry.sourceDigest, 32) ||
      sources.has(`${entry.mode}:${entry.sourceDigest}`) ||
      !Number.isSafeInteger(entry.failedAttempts) ||
      entry.failedAttempts < 0 ||
      entry.failedAttempts > GRANT_ADMISSION_SOURCE_FAILURE_SATURATION ||
      !Number.isSafeInteger(entry.lastAttemptAtMs) ||
      entry.lastAttemptAtMs < 0 ||
      (entry.delayUntilMs !== null &&
        (!Number.isSafeInteger(entry.delayUntilMs) ||
          entry.delayUntilMs < entry.lastAttemptAtMs)) ||
      (entry.lastSuccessAtMs !== null &&
        (!Number.isSafeInteger(entry.lastSuccessAtMs) ||
          entry.lastSuccessAtMs < 0 ||
          entry.lastSuccessAtMs > entry.lastAttemptAtMs))
    ) {
      return "Stored Grant admission telemetry is invalid.";
    }
    sources.add(`${entry.mode}:${entry.sourceDigest}`);
  }
  const windows = [...(context.admissionGlobalWindows ?? [])];
  const modes = new Set<string>();
  for (const window of windows) {
    if (
      (window.mode !== "qr" && window.mode !== "code") ||
      modes.has(window.mode) ||
      !Number.isSafeInteger(window.windowStartedAtMs) ||
      window.windowStartedAtMs < 0 ||
      !Number.isSafeInteger(window.attemptCount) ||
      window.attemptCount < 0 ||
      window.attemptCount > GRANT_ADMISSION_GLOBAL_ATTEMPT_LIMITS[window.mode]
    ) {
      return "Stored Grant admission global throttle state is invalid.";
    }
    modes.add(window.mode);
  }
  return null;
}

function validateAudit(
  audit: StoredGrantAuditEntry,
  grant: StoredGrant,
  sessions: ReadonlyMap<string, StoredGrantSession>,
  audits: readonly StoredGrantAuditEntry[],
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
    "session-switched",
    "replay-authorized",
    "control-action-accepted",
    "control-action-duplicate",
    "control-action-rejected",
    "control-action-retry-later",
    "control-action-dependency-blocked",
    "grant-code-created",
    "grant-code-replaced",
    "grant-code-disabled",
    "grant-code-erased-expiry",
    "grant-code-erased-game-lock",
    "grant-code-admitted",
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
    (audit.credentialKind !== GRANT_CREDENTIAL_KIND && audit.credentialKind !== GRANT_CODE_KIND) ||
    (audit.beforeStatus !== null && !isStoredGrantStatus(audit.beforeStatus)) ||
    (audit.afterStatus !== null && !isStoredGrantStatus(audit.afterStatus)) ||
    (audit.beforeExpiresAtMs !== null &&
      (!Number.isSafeInteger(audit.beforeExpiresAtMs) || audit.beforeExpiresAtMs < 0)) ||
    (audit.afterExpiresAtMs !== null &&
      (!Number.isSafeInteger(audit.afterExpiresAtMs) || audit.afterExpiresAtMs < 0)) ||
    (audit.terminalReason !== null && !allowedTerminalReasons.includes(audit.terminalReason))
  ) {
    return "Stored Grant Audit Trail provenance is invalid.";
  }
  const codeOnlyFieldsPresent =
    audit.codeFormatVersion !== undefined ||
    audit.codeEncryptionKeyVersion !== undefined ||
    audit.codeLookupKeyVersion !== undefined ||
    audit.codeStateBefore !== undefined ||
    audit.codeState !== undefined ||
    audit.previousCodeFingerprint !== undefined;
  const codeAction =
    audit.action === "grant-code-created" ||
    audit.action === "grant-code-replaced" ||
    audit.action === "grant-code-disabled" ||
    audit.action === "grant-code-erased-expiry" ||
    audit.action === "grant-code-erased-game-lock" ||
    audit.action === "grant-code-admitted";
  if (codeAction !== (audit.credentialKind === GRANT_CODE_KIND))
    return "Stored Grant Audit Trail credential kind does not match its action.";
  if (!codeAction && codeOnlyFieldsPresent)
    return "Stored non-Code Grant Audit Trail contains Code-only evidence.";
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
  } else if (
    audit.action === "grant-code-erased-game-lock" &&
    audit.terminalReason === "game-locked" &&
    audit.eventGameId !== null &&
    validateOpaqueIdentifier(audit.eventGameId, "eventGameId").ok
  ) {
    // The Game-Lock Code evidence carries the same terminal reason as the
    // corresponding session evidence; its complete relationship is checked below.
  } else if (audit.terminalReason !== null) {
    return "Stored non-terminal Grant Audit Trail evidence has a terminal reason.";
  }
  if (audit.action === "session-admitted" || audit.action === "session-replaced") {
    if (audit.sessionId === null || (grant.grantType === "control" && audit.eventGameId === null))
      return "Stored admitted Grant Audit Trail evidence is incomplete.";
    const session = sessions.get(audit.sessionId);
    if (
      session === undefined ||
      session.grantId !== audit.grantId ||
      session.grantVersion !== audit.grantVersion ||
      (audit.eventGameId !== null &&
        !validateOpaqueIdentifier(audit.eventGameId, "audit.eventGameId").ok)
    )
      return "Stored admitted Grant Audit Trail provenance is invalid.";
  }
  if (audit.action === "session-switched") {
    if (
      audit.sessionId === null ||
      audit.eventGameId === null ||
      audit.previousEventGameId === null
    )
      return "Stored switched Grant Audit Trail evidence is incomplete.";
    const session = sessions.get(audit.sessionId);
    if (
      session === undefined ||
      session.grantId !== audit.grantId ||
      session.grantVersion !== audit.grantVersion
    ) {
      return "Stored switched Grant Audit Trail provenance is invalid.";
    }
  }
  if (
    audit.action !== "session-switched" &&
    audit.action !== "replay-authorized" &&
    audit.previousEventGameId !== null
  )
    return "Stored Grant Audit Trail previous Event Game provenance is invalid.";
  if (audit.action === "replay-authorized") {
    if (audit.sessionId === null || audit.replacedSessionId === null || audit.eventGameId === null)
      return "Stored replay Grant Audit Trail evidence is incomplete.";
    const replacement = sessions.get(audit.sessionId);
    const originating = sessions.get(audit.replacedSessionId);
    if (
      replacement === undefined ||
      originating === undefined ||
      replacement.sessionId === originating.sessionId ||
      originating.status === "active" ||
      replacement.grantId !== audit.grantId ||
      originating.grantId !== audit.grantId ||
      replacement.grantVersion !== audit.grantVersion ||
      replacement.eventGameId !== audit.eventGameId ||
      originating.eventGameId !== audit.eventGameId ||
      (audit.replayEvidenceId !== null &&
        audit.replayEvidenceId !== undefined &&
        !validateOpaqueIdentifier(audit.replayEvidenceId, "replayEvidenceId").ok)
    )
      return "Stored replay Grant Audit Trail provenance is invalid.";
    if (
      !audits.some(
        (candidate) =>
          (candidate.action === "session-admitted" || candidate.action === "session-replaced") &&
          candidate.sessionId === originating.sessionId &&
          candidate.grantId === originating.grantId &&
          candidate.grantVersion === originating.grantVersion &&
          candidate.eventGameId === audit.eventGameId,
      )
    )
      return "Stored replay Grant Audit Trail originating evidence is invalid.";
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

function validateSessionSwitchChains(
  audits: readonly StoredGrantAuditEntry[],
  sessions: ReadonlyMap<string, StoredGrantSession>,
  grants: ReadonlyMap<string, StoredGrant>,
): string | null {
  const switchedBySession = new Map<string, StoredGrantAuditEntry[]>();
  for (const audit of audits) {
    if (audit.action !== "session-switched" || audit.sessionId === null) continue;
    const history = switchedBySession.get(audit.sessionId) ?? [];
    history.push(audit);
    switchedBySession.set(audit.sessionId, history);
  }
  for (const session of sessions.values()) {
    const grant = grants.get(session.grantId);
    if (grant?.grantType !== "control") continue;
    const admissions = audits.filter(
      (audit) =>
        (audit.action === "session-admitted" || audit.action === "session-replaced") &&
        audit.sessionId === session.sessionId,
    );
    if (admissions.length !== 1)
      return "Stored Grant Session lacks exactly one admission provenance record.";
    const admission = admissions[0];
    if (
      admission === undefined ||
      admission.eventGameId === null ||
      admission.grantId !== session.grantId ||
      admission.grantVersion !== session.grantVersion
    )
      return "Stored Grant Session admission provenance is invalid.";
    let expectedPreviousEventGameId = admission.eventGameId;
    const remaining = [...(switchedBySession.get(session.sessionId) ?? [])];
    while (remaining.length > 0) {
      const index = remaining.findIndex(
        (audit) => audit.previousEventGameId === expectedPreviousEventGameId,
      );
      if (index < 0) return "Stored switched Grant Audit Trail relationship chain is invalid.";
      const [audit] = remaining.splice(index, 1);
      if (
        audit === undefined ||
        audit.eventGameId === null ||
        audit.eventGameId === expectedPreviousEventGameId
      )
        return "Stored switched Grant Audit Trail relationship chain is invalid.";
      expectedPreviousEventGameId = audit.eventGameId;
    }
    if (session.eventGameId !== expectedPreviousEventGameId)
      return "Stored switched Grant Audit Trail relationship chain is incomplete.";
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
