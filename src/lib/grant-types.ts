import { validateOpaqueIdentifier, type ValidationResult } from "@/lib/validation-policy";

export const GRANT_CREDENTIAL_FORMAT_VERSION = 1 as const;
export const GRANT_CREDENTIAL_KIND = "qr" as const;
export const GRANT_TYPE = "control" as const;
export const OPAQUE_MIGRATION_CREDENTIAL_REFERENCE_PREFIX =
  "opaque-migration-reference-v1:" as const;

export type GrantType = typeof GRANT_TYPE;
export type GrantCredentialKind = typeof GRANT_CREDENTIAL_KIND;

export type ControlGrantScope = {
  eventId: string;
  gameDayId: string;
  pitchId: string;
  pitchSlotId: string;
};

export type GrantClock = {
  nowMs(): number;
};

export type GrantRandomness = {
  bytes(length: number): Uint8Array;
};

export type GrantKeyRing = {
  encryption: GrantKeySet;
  lookup: GrantKeySet;
};

export type GrantKeySet = {
  currentVersion: string;
  keys: ReadonlyMap<string, Uint8Array>;
};

export type GrantAuthorityActor = {
  kind: "fixture";
  id: string;
};

export type ControlGrantScopeResolution =
  | { status: "eligible"; eventGameId: string }
  | { status: "empty" | "conflict" | "mismatch" | "unavailable"; detail?: string };

export type ControlGrantScopeResolver = {
  resolve(scope: ControlGrantScope): ControlGrantScopeResolution;
};

export type StoredGrantStatus = "active" | "disabled" | "revoked" | "expired";

export type StoredGrantCredential = {
  materialState: "present" | "erased";
  formatVersion: typeof GRANT_CREDENTIAL_FORMAT_VERSION;
  kind: GrantCredentialKind;
  encryptionKeyVersion: string | null;
  lookupKeyVersion: string | null;
  iv: string | null;
  ciphertext: string | null;
  tag: string | null;
  lookupDigest: string | null;
  fingerprint: string;
};

export type StoredControlGrant = {
  grantId: string;
  grantType: GrantType;
  grantVersion: string;
  scope: ControlGrantScope;
  status: StoredGrantStatus;
  createdAtMs: number;
  expiresAtMs: number | null;
  credential: StoredGrantCredential;
};

export type StoredGrantSessionStatus = "active" | "revoked" | "expired";

export type StoredGrantSession = {
  sessionId: string;
  grantId: string;
  grantVersion: string;
  eventGameId: string;
  browserContextDigest: string;
  browserContextKeyVersion: string;
  bearerMaterialState: "present" | "erased";
  bearerLookupVerifier: string | null;
  bearerLookupKeyVersion: string | null;
  status: StoredGrantSessionStatus;
  createdAtMs: number;
  lastActiveAtMs: number;
  revokedAtMs: number | null;
};

export type GrantAuditAction =
  | "grant-created"
  | "credential-revealed"
  | "credential-rotated"
  | "grant-expired"
  | "grant-disabled"
  | "grant-revoked"
  | "session-admitted"
  | "session-replaced";

export type StoredGrantAuditEntry = {
  auditId: string;
  action: GrantAuditAction;
  outcome: "accepted";
  actorReference: string;
  grantId: string;
  grantType: GrantType;
  grantVersion: string;
  scope: ControlGrantScope;
  sessionId: string | null;
  replacedSessionId: string | null;
  eventGameId: string | null;
  credentialKind: GrantCredentialKind | null;
  credentialFingerprint: string | null;
  beforeStatus: StoredGrantStatus | null;
  afterStatus: StoredGrantStatus | null;
  createdAtMs: number;
};

export type GrantSessionSummary = {
  sessionId: string;
  grantId: string;
  grantVersion: string;
  eventGameId: string;
  status: StoredGrantSessionStatus;
  createdAtMs: number;
  lastActiveAtMs: number;
  revokedAtMs: number | null;
};

export function validateControlGrantScope(value: unknown): ValidationResult<ControlGrantScope> {
  if (!isRecord(value)) return invalid("Control Grant scope must be an object.");

  const eventId = validateOpaqueIdentifier(value.eventId, "scope.eventId");
  const gameDayId = validateOpaqueIdentifier(value.gameDayId, "scope.gameDayId");
  const pitchId = validateOpaqueIdentifier(value.pitchId, "scope.pitchId");
  const pitchSlotId = validateOpaqueIdentifier(value.pitchSlotId, "scope.pitchSlotId");
  if (!eventId.ok) return eventId;
  if (!gameDayId.ok) return gameDayId;
  if (!pitchId.ok) return pitchId;
  if (!pitchSlotId.ok) return pitchSlotId;

  return valid({
    eventId: eventId.value,
    gameDayId: gameDayId.value,
    pitchId: pitchId.value,
    pitchSlotId: pitchSlotId.value,
  });
}

export function cloneStoredControlGrant(grant: StoredControlGrant): StoredControlGrant {
  return structuredClone(grant);
}

export function cloneStoredGrantSession(session: StoredGrantSession): StoredGrantSession {
  return structuredClone(session);
}

export function cloneStoredGrantAuditEntry(entry: StoredGrantAuditEntry): StoredGrantAuditEntry {
  return structuredClone(entry);
}

export function isStoredGrantStatus(value: unknown): value is StoredGrantStatus {
  return value === "active" || value === "disabled" || value === "revoked" || value === "expired";
}

export function isStoredGrantSessionStatus(value: unknown): value is StoredGrantSessionStatus {
  return value === "active" || value === "revoked" || value === "expired";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valid<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

function invalid<T>(error: string): ValidationResult<T> {
  return { ok: false, error };
}
