import { computeLookupDigest, createRandomIdentifier } from "@/lib/grant-crypto";
import type { FoundationStorageTransaction } from "@/lib/foundation-storage";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import {
  GRANT_CREDENTIAL_KIND,
  OPAQUE_MIGRATION_CREDENTIAL_REFERENCE_PREFIX,
  type GrantAuthorityActor,
  type StoredGrant,
  type StoredGrantAuditEntry,
  type StoredGrantStatus,
  type TerminalGrantSessionReason,
} from "@/lib/grant-types";
import { validateOpaqueIdentifier } from "@/lib/validation-policy";

export function validateActor(
  value: unknown,
): { ok: true; value: GrantAuthorityActor } | { ok: false; error: string } {
  if (!isRecord(value) || value.kind !== "fixture") {
    return { ok: false, error: "actor must be a structured fixture authority." };
  }
  const id = validateOpaqueIdentifier(value.id, "actor.id");
  if (!id.ok) return id;
  return { ok: true, value: { kind: "fixture", id: id.value } };
}

export function createAuditEntry(
  options: GrantAuthorityOptions,
  input: {
    action: StoredGrantAuditEntry["action"];
    actor:
      | { kind: "authority"; value: GrantAuthorityActor }
      | { kind: "session"; sessionId: string; pseudonymKeyVersion: string }
      | { kind: "system"; value: "grant-expiry" | "grant-session-termination" };
    grant: StoredGrant;
    sessionId: string | null;
    replacedSessionId: string | null;
    eventGameId: string | null;
    beforeStatus: StoredGrantStatus | null;
    afterStatus: StoredGrantStatus | null;
    beforeExpiresAtMs?: number | null;
    afterExpiresAtMs?: number | null;
    terminalReason?: TerminalGrantSessionReason | null;
  },
): StoredGrantAuditEntry {
  const auditId = createRandomIdentifier("grant-audit", options.randomness);
  return {
    auditId,
    action: input.action,
    outcome: "accepted",
    actorReference: deriveAuditActorReference(options, input.grant.grantId, input.actor),
    grantId: input.grant.grantId,
    grantType: input.grant.grantType,
    grantVersion: input.grant.grantVersion,
    scope: structuredClone(input.grant.scope),
    sessionId: input.sessionId,
    replacedSessionId: input.replacedSessionId,
    eventGameId: input.eventGameId,
    credentialKind: GRANT_CREDENTIAL_KIND,
    credentialFingerprint: input.grant.credential.fingerprint.startsWith(
      OPAQUE_MIGRATION_CREDENTIAL_REFERENCE_PREFIX,
    )
      ? null
      : input.grant.credential.fingerprint,
    beforeStatus: input.beforeStatus,
    afterStatus: input.afterStatus,
    beforeExpiresAtMs:
      input.beforeExpiresAtMs ?? (input.beforeStatus === null ? null : input.grant.expiresAtMs),
    afterExpiresAtMs: input.afterExpiresAtMs ?? input.grant.expiresAtMs,
    terminalReason: input.terminalReason ?? null,
    createdAtMs: readNow(options),
  };
}

export function expireGrantIfDue(
  transaction: FoundationStorageTransaction,
  options: GrantAuthorityOptions,
  grant: StoredGrant,
): StoredGrant {
  if (grant.status === "expired" || grant.expiresAtMs === null) return grant;
  const nowMs = readNow(options);
  if (nowMs < grant.expiresAtMs) return grant;

  const expiredGrant: StoredGrant = {
    ...grant,
    status: "expired",
    credential: eraseGrantCredential(grant.credential),
  };
  transaction.updateGrant(expiredGrant);
  for (const session of transaction.listGrantSessions(grant.grantId)) {
    if (
      session.status !== "expired" ||
      session.bearerMaterialState !== "erased" ||
      session.bearerLookupVerifier !== null ||
      session.bearerLookupKeyVersion !== null
    ) {
      transaction.updateGrantSession({
        ...session,
        status: "expired",
        bearerMaterialState: "erased",
        bearerLookupVerifier: null,
        bearerLookupKeyVersion: null,
      });
    }
  }
  transaction.appendGrantAudit(
    createAuditEntry(options, {
      action: "grant-expired",
      actor: { kind: "system", value: "grant-expiry" },
      grant,
      sessionId: null,
      replacedSessionId: null,
      eventGameId: null,
      beforeStatus: grant.status,
      afterStatus: "expired",
    }),
  );
  return expiredGrant;
}

function eraseGrantCredential(credential: StoredGrant["credential"]): StoredGrant["credential"] {
  return {
    materialState: "erased",
    formatVersion: credential.formatVersion,
    kind: credential.kind,
    encryptionKeyVersion: null,
    lookupKeyVersion: null,
    iv: null,
    ciphertext: null,
    tag: null,
    lookupDigest: null,
    fingerprint: credential.fingerprint,
  };
}

function deriveAuditActorReference(
  options: GrantAuthorityOptions,
  grantId: string,
  actor:
    | { kind: "authority"; value: GrantAuthorityActor }
    | { kind: "session"; sessionId: string; pseudonymKeyVersion: string }
    | { kind: "system"; value: "grant-expiry" | "grant-session-termination" },
): string {
  const source =
    actor.kind === "authority"
      ? { source: actor.kind, authorityKind: actor.value.kind, authorityId: actor.value.id }
      : actor.kind === "session"
        ? { source: actor.kind, sessionId: actor.sessionId }
        : { source: actor.kind, operation: actor.value };
  return `actor-${computeLookupDigest(
    JSON.stringify({ domain: "grant-audit", grantId, source }),
    options.keyRing,
    actor.kind === "session" ? actor.pseudonymKeyVersion : undefined,
  )}`;
}

function readNow(options: GrantAuthorityOptions): number {
  const nowMs = options.clock.nowMs();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("Grant clock returned an invalid timestamp.");
  }
  return nowMs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
