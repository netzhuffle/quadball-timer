import { validateOpaqueIdentifier, type ValidationResult } from "@/lib/validation-policy";

export const GRANT_CREDENTIAL_FORMAT_VERSION = 1 as const;
export const GRANT_CREDENTIAL_KIND = "qr" as const;
export const GRANT_TYPE = "control" as const;
export const EVENT_ADMIN_GRANT_TYPE = "event-admin" as const;
export const PITCH_MANAGER_GRANT_TYPE = "pitch-manager" as const;
export const OPAQUE_MIGRATION_CREDENTIAL_REFERENCE_PREFIX =
  "opaque-migration-reference-v1:" as const;
export const GRANT_AUDIT_LEGACY_INTEGRITY_TAG = "legacy-migration-v1" as const;
export const GRANT_AUDIT_INTEGRITY_TAG_PREFIX = "hmac-sha256-v1:" as const;

export type GrantType =
  | typeof EVENT_ADMIN_GRANT_TYPE
  | typeof PITCH_MANAGER_GRANT_TYPE
  | typeof GRANT_TYPE;
export type GrantCredentialKind = typeof GRANT_CREDENTIAL_KIND;

export type ControlGrantScope = {
  eventId: string;
  gameDayId: string;
  pitchId: string;
  pitchSlotId: string;
};

export type EventAdminGrantScope = {
  eventId: string;
  eventTimeZone: string;
  finalGameDayDate: string;
};

export type PitchManagerGrantScope = {
  eventId: string;
  gameDayId: string;
  gameDayDate: string;
  eventTimeZone: string;
  pitchId: string;
};

export type GrantScope = ControlGrantScope | EventAdminGrantScope | PitchManagerGrantScope;

export type GrantClock = {
  nowMs(): number;
};

export type GrantRandomness = {
  bytes(length: number): Uint8Array;
};

export type GrantKeyRing = {
  encryption: GrantKeySet;
  lookup: GrantKeySet;
  audit: GrantKeySet;
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
  | {
      status: "terminal";
      reason: "accepted-game-switch" | "past-game-day" | "game-locked";
      eventGameId?: string;
    }
  | { status: "empty" | "conflict" | "mismatch" | "unavailable"; detail?: string };

export type ControlGrantSessionResolution =
  | { status: "current"; eventGameId: string }
  | {
      status: "switchable";
      previousEventGameId: string;
      currentEventGameId: string;
    }
  | {
      status: "pinned";
      sessionEventGameId: string;
      currentEventGameId: string;
    }
  | { status: "game-locked"; eventGameId: string }
  | { status: "empty" | "conflict" | "mismatch" | "unavailable"; detail?: string };

export type ControlGrantReplayResolution =
  | { status: "eligible"; eventGameId: string }
  | { status: "finished" | "game-locked" | "mismatch" | "unavailable"; detail?: string };

export type ControlGrantSessionDecision = "stay";

export type ControlGrantScopeResolver = {
  resolve(scope: ControlGrantScope): ControlGrantScopeResolution;
  /** Optional lifecycle-aware seam used after a session has already been admitted. */
  resolveSession?: (
    scope: ControlGrantScope,
    sessionEventGameId: string,
  ) => ControlGrantSessionResolution;
  /** Optional lifecycle-aware seam used by explicit offline replay authorization. */
  resolveReplay?: (
    scope: ControlGrantScope,
    eventGameId: string,
    replayEvidenceId: string,
  ) => ControlGrantReplayResolution;
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

export type StoredGrant = {
  grantId: string;
  grantType: GrantType;
  grantVersion: string;
  scope: GrantScope;
  status: StoredGrantStatus;
  createdAtMs: number;
  expiresAtMs: number | null;
  credential: StoredGrantCredential;
};

export type StoredControlGrant = StoredGrant & {
  grantType: typeof GRANT_TYPE;
  scope: ControlGrantScope;
};

export type StoredGrantSessionStatus = "active" | "revoked" | "expired";

export type TerminalGrantSessionReason = "game-locked" | "accepted-game-switch" | "past-game-day";

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
  deviceClass?: string;
  browserClass?: string;
};

export type GrantAuditAction =
  | "grant-created"
  | "credential-revealed"
  | "credential-rotated"
  | "grant-expired"
  | "grant-disabled"
  | "grant-revoked"
  | "grant-reactivated"
  | "grant-metadata-updated"
  | "session-revoked"
  | "session-terminated"
  | "session-admitted"
  | "session-replaced"
  | "session-switched"
  | "replay-authorized";

export type StoredGrantAuditEntry = {
  auditId: string;
  action: GrantAuditAction;
  outcome: "accepted";
  actorReference: string;
  grantId: string;
  grantType: GrantType;
  grantVersion: string;
  scope: GrantScope;
  sessionId: string | null;
  replacedSessionId: string | null;
  eventGameId: string | null;
  previousEventGameId?: string | null;
  replayEvidenceId?: string | null;
  credentialKind: GrantCredentialKind | null;
  credentialFingerprint: string | null;
  beforeStatus: StoredGrantStatus | null;
  afterStatus: StoredGrantStatus | null;
  beforeExpiresAtMs: number | null;
  afterExpiresAtMs: number | null;
  terminalReason: TerminalGrantSessionReason | null;
  createdAtMs: number;
};

export type GrantSessionSummary = {
  label: string;
  status: StoredGrantSessionStatus;
  createdAtMs: number;
  lastActiveAtMs: number;
  revokedAtMs: number | null;
  deviceClass: string;
  browserClass: string;
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

export function validateEventAdminGrantScope(
  value: unknown,
): ValidationResult<EventAdminGrantScope> {
  if (!isRecord(value)) return invalid("Event Admin Grant scope must be an object.");
  const eventId = validateOpaqueIdentifier(value.eventId, "scope.eventId");
  const eventTimeZone = validateTimeZone(value.eventTimeZone, "scope.eventTimeZone");
  const finalGameDayDate = validateDate(value.finalGameDayDate, "scope.finalGameDayDate");
  if (!eventId.ok) return eventId;
  if (!eventTimeZone.ok) return eventTimeZone;
  if (!finalGameDayDate.ok) return finalGameDayDate;
  return valid({
    eventId: eventId.value,
    eventTimeZone: eventTimeZone.value,
    finalGameDayDate: finalGameDayDate.value,
  });
}

export function validatePitchManagerGrantScope(
  value: unknown,
): ValidationResult<PitchManagerGrantScope> {
  if (!isRecord(value)) return invalid("Pitch Manager Grant scope must be an object.");
  const eventId = validateOpaqueIdentifier(value.eventId, "scope.eventId");
  const gameDayId = validateOpaqueIdentifier(value.gameDayId, "scope.gameDayId");
  const gameDayDate = validateDate(value.gameDayDate, "scope.gameDayDate");
  const eventTimeZone = validateTimeZone(value.eventTimeZone, "scope.eventTimeZone");
  const pitchId = validateOpaqueIdentifier(value.pitchId, "scope.pitchId");
  if (!eventId.ok) return eventId;
  if (!gameDayId.ok) return gameDayId;
  if (!gameDayDate.ok) return gameDayDate;
  if (!eventTimeZone.ok) return eventTimeZone;
  if (!pitchId.ok) return pitchId;
  return valid({
    eventId: eventId.value,
    gameDayId: gameDayId.value,
    gameDayDate: gameDayDate.value,
    eventTimeZone: eventTimeZone.value,
    pitchId: pitchId.value,
  });
}

export function validateGrantScope(type: GrantType, value: unknown): ValidationResult<GrantScope> {
  if (type === EVENT_ADMIN_GRANT_TYPE) return validateEventAdminGrantScope(value);
  if (type === PITCH_MANAGER_GRANT_TYPE) return validatePitchManagerGrantScope(value);
  return validateControlGrantScope(value);
}

function validateDate(value: unknown, field: string): ValidationResult<string> {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return invalid(`${field} must be an ISO calendar date.`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day ?? 0));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== (month ?? 0) - 1 ||
    date.getUTCDate() !== day
  ) {
    return invalid(`${field} must be a valid ISO calendar date.`);
  }
  return valid(value);
}

function validateTimeZone(value: unknown, field: string): ValidationResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    return invalid(`${field} must be a valid IANA time zone.`);
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    return invalid(`${field} must be a valid IANA time zone.`);
  }
  return valid(value);
}

export function cloneStoredControlGrant(grant: StoredControlGrant): StoredControlGrant {
  return structuredClone(grant);
}

export function cloneStoredGrant(grant: StoredGrant): StoredGrant {
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
