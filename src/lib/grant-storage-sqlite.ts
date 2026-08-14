import { Database } from "bun:sqlite";
import { computeGrantAuditIntegrityTag } from "@/lib/grant-crypto";
import {
  GRANT_CREDENTIAL_FORMAT_VERSION,
  GRANT_CREDENTIAL_KIND,
  GRANT_TYPE,
  EVENT_ADMIN_GRANT_TYPE,
  PITCH_MANAGER_GRANT_TYPE,
  isStoredGrantSessionStatus,
  isStoredGrantStatus,
  type StoredGrant,
  type StoredGrantAuditEntry,
  type StoredGrantSession,
  type ControlGrantScope,
  type GrantScope,
  type GrantType,
  type GrantKeyRing,
  validateGrantScope,
} from "@/lib/grant-types";
import { validateGrantState, type GrantStateValidationContext } from "@/lib/grant-state-validation";

type SqlStatement = ReturnType<Database["query"]>;
type GrantRow = Record<string, unknown>;

export type GrantSqliteStatements = {
  byGrantId: SqlStatement;
  allGrants: SqlStatement;
  byCredentialDigest: SqlStatement;
  activeSessionByContext: SqlStatement;
  sessionByBearer: SqlStatement;
  sessionsByGrant: SqlStatement;
  auditByGrant: SqlStatement;
  insertGrant: SqlStatement;
  updateGrant: SqlStatement;
  insertSession: SqlStatement;
  updateSession: SqlStatement;
  insertAudit: SqlStatement;
};

const GRANT_SELECT_COLUMNS = `
  grants.grant_id AS grant_id, grants.grant_type AS grant_type,
  grants.grant_version AS grant_version, grants.event_id AS event_id,
  grants.game_day_id AS game_day_id, grants.pitch_id AS pitch_id,
  grants.pitch_slot_id AS pitch_slot_id, grants.status AS status,
  grants.created_at_ms AS created_at_ms, grants.expires_at_ms AS expires_at_ms,
  grants.credential_format_version AS credential_format_version,
  grants.credential_kind AS credential_kind,
  grants.credential_material_state AS credential_material_state,
  grants.encryption_key_version AS encryption_key_version,
  grants.lookup_key_version AS lookup_key_version,
  grants.credential_iv AS credential_iv,
  grants.credential_ciphertext AS credential_ciphertext,
  grants.credential_tag AS credential_tag,
  grants.credential_lookup_digest AS credential_lookup_digest,
  grants.credential_fingerprint AS credential_fingerprint
`;

const SESSION_SELECT_COLUMNS = `
  sessions.session_id AS session_id, sessions.grant_id AS grant_id,
  sessions.grant_version AS grant_version, sessions.event_game_id AS event_game_id,
  sessions.browser_context_digest AS browser_context_digest,
  sessions.browser_context_key_version AS browser_context_key_version,
  sessions.bearer_material_state AS bearer_material_state,
  sessions.bearer_lookup_verifier AS bearer_lookup_verifier,
  sessions.bearer_lookup_key_version AS bearer_lookup_key_version,
  sessions.status AS status, sessions.created_at_ms AS created_at_ms,
  sessions.last_active_at_ms AS last_active_at_ms, sessions.revoked_at_ms AS revoked_at_ms,
  sessions.device_class AS device_class, sessions.browser_class AS browser_class
`;

const AUDIT_SELECT_COLUMNS = `
  audit.audit_id AS audit_id, audit.action AS action, audit.outcome AS outcome,
  audit.actor_reference AS actor_reference, audit.grant_id AS grant_id,
  audit.grant_type AS grant_type, audit.grant_version AS grant_version,
  audit.event_id AS event_id, audit.game_day_id AS game_day_id,
  audit.pitch_id AS pitch_id, audit.pitch_slot_id AS pitch_slot_id,
  audit.session_id AS session_id, audit.replaced_session_id AS replaced_session_id,
  audit.event_game_id AS event_game_id, audit.credential_kind AS credential_kind,
  audit.credential_fingerprint AS credential_fingerprint,
  audit.before_status AS before_status, audit.after_status AS after_status,
  audit.before_expires_at_ms AS before_expires_at_ms,
  audit.after_expires_at_ms AS after_expires_at_ms,
  audit.previous_event_game_id AS previous_event_game_id,
  audit.replay_evidence_id AS replay_evidence_id,
  audit.terminal_reason AS terminal_reason,
  audit.created_at_ms AS created_at_ms
`;

export function createGrantSqliteStatements(database: Database): GrantSqliteStatements {
  return {
    byGrantId: database.query(
      `SELECT ${GRANT_SELECT_COLUMNS} FROM foundation_grant_roots AS grants WHERE grants.grant_id = ?`,
    ),
    allGrants: database.query(
      `SELECT ${GRANT_SELECT_COLUMNS} FROM foundation_grant_roots AS grants ORDER BY grants.grant_id`,
    ),
    byCredentialDigest: database.query(
      `SELECT ${GRANT_SELECT_COLUMNS} FROM foundation_grant_roots AS grants WHERE grants.credential_lookup_digest = ?`,
    ),
    activeSessionByContext: database.query(
      `SELECT ${SESSION_SELECT_COLUMNS}
       FROM foundation_grant_sessions AS sessions
       WHERE sessions.grant_id = ? AND sessions.browser_context_digest = ? AND sessions.status = 'active'`,
    ),
    sessionByBearer: database.query(
      `SELECT ${SESSION_SELECT_COLUMNS}
       FROM foundation_grant_sessions AS sessions
       WHERE sessions.bearer_lookup_verifier = ? AND sessions.bearer_lookup_key_version = ?`,
    ),
    sessionsByGrant: database.query(
      `SELECT ${SESSION_SELECT_COLUMNS}
       FROM foundation_grant_sessions AS sessions
       WHERE sessions.grant_id = ? ORDER BY sessions.session_id`,
    ),
    auditByGrant: database.query(
      `SELECT ${AUDIT_SELECT_COLUMNS}
       FROM foundation_grant_audit AS audit
       WHERE audit.grant_id = ? ORDER BY audit.audit_id`,
    ),
    insertGrant: database.query(`
      INSERT INTO foundation_grant_roots (
        grant_id, grant_type, grant_version, event_id, game_day_id, pitch_id, pitch_slot_id,
        status, created_at_ms, expires_at_ms, credential_format_version, credential_kind,
        credential_material_state, encryption_key_version, lookup_key_version, credential_iv, credential_ciphertext,
        credential_tag, credential_lookup_digest, credential_fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateGrant: database.query(`
      UPDATE foundation_grant_roots SET
        grant_type = ?, grant_version = ?, event_id = ?, game_day_id = ?, pitch_id = ?,
        pitch_slot_id = ?, status = ?, created_at_ms = ?, expires_at_ms = ?,
        credential_format_version = ?, credential_kind = ?, credential_material_state = ?, encryption_key_version = ?,
        lookup_key_version = ?, credential_iv = ?, credential_ciphertext = ?,
        credential_tag = ?, credential_lookup_digest = ?, credential_fingerprint = ?
      WHERE grant_id = ?
    `),
    insertSession: database.query(`
      INSERT INTO foundation_grant_sessions (
        session_id, grant_id, grant_version, event_game_id, browser_context_digest,
        browser_context_key_version, bearer_material_state, bearer_lookup_verifier, bearer_lookup_key_version,
        status, created_at_ms, last_active_at_ms, revoked_at_ms, device_class, browser_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateSession: database.query(`
      UPDATE foundation_grant_sessions SET
        grant_id = ?, grant_version = ?, event_game_id = ?, browser_context_digest = ?,
        browser_context_key_version = ?, bearer_material_state = ?, bearer_lookup_verifier = ?,
        bearer_lookup_key_version = ?, status = ?, created_at_ms = ?,
        last_active_at_ms = ?, revoked_at_ms = ?, device_class = ?, browser_class = ?
      WHERE session_id = ?
    `),
    insertAudit: database.query(`
      INSERT INTO foundation_grant_audit (
        audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
        event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
        event_game_id, credential_kind, credential_fingerprint, before_status, after_status,
        before_expires_at_ms, after_expires_at_ms, previous_event_game_id, replay_evidence_id,
        terminal_reason,
        audit_integrity_tag, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
  };
}

export function readGrantByStatement(
  statement: SqlStatement,
  ...parameters: string[]
): StoredGrant | null {
  const row = statement.get(...parameters) as GrantRow | null;
  return row === null ? null : readStoredControlGrant(row);
}

export function listGrants(statement: SqlStatement): StoredGrant[] {
  return statement.all().map((row) => readStoredControlGrant(asRecord(row)));
}

export function readSessionByStatement(
  statement: SqlStatement,
  ...parameters: string[]
): StoredGrantSession | null {
  const row = statement.get(...parameters) as GrantRow | null;
  return row === null ? null : readStoredGrantSession(row);
}

export function listGrantSessions(statement: SqlStatement, grantId: string): StoredGrantSession[] {
  return statement.all(grantId).map((row) => readStoredGrantSession(asRecord(row)));
}

export function listGrantAudit(statement: SqlStatement, grantId: string): StoredGrantAuditEntry[] {
  return statement.all(grantId).map((row) => readStoredGrantAuditEntry(asRecord(row)));
}

/** Validate every persisted Grant row before the database can be authoritative. */
export function scanGrantState(
  database: Database,
  validationContext?: GrantStateValidationContext,
): void {
  const grants: StoredGrant[] = [];
  const grantRows = database
    .query("SELECT * FROM foundation_grant_roots ORDER BY grant_id")
    .all() as unknown[];
  for (const value of grantRows) {
    const grant = readStoredControlGrant(asRecord(value));
    grants.push(grant);
  }

  const sessions: StoredGrantSession[] = [];
  const sessionRows = database
    .query("SELECT * FROM foundation_grant_sessions ORDER BY session_id")
    .all() as unknown[];
  for (const value of sessionRows) {
    sessions.push(readStoredGrantSession(asRecord(value)));
  }

  const audits = database
    .query("SELECT * FROM foundation_grant_audit ORDER BY audit_id")
    .all()
    .map((value) => readStoredGrantAuditEntry(asRecord(value)));
  const failure = validateGrantState(grants, sessions, audits, validationContext);
  if (failure !== null) throw new Error(failure);
}

export function insertGrant(statements: GrantSqliteStatements, grant: StoredGrant): void {
  const fields = storageGrantFields(grant);
  statements.insertGrant.run(
    grant.grantId,
    grant.grantType,
    grant.grantVersion,
    fields.eventId,
    fields.gameDayId,
    fields.pitchId,
    fields.pitchSlotId,
    grant.status,
    grant.createdAtMs,
    grant.expiresAtMs,
    grant.credential.formatVersion,
    grant.credential.kind,
    grant.credential.materialState,
    grant.credential.encryptionKeyVersion,
    grant.credential.lookupKeyVersion,
    grant.credential.iv,
    grant.credential.ciphertext,
    grant.credential.tag,
    grant.credential.lookupDigest,
    grant.credential.fingerprint,
  );
}

export function updateGrant(statements: GrantSqliteStatements, grant: StoredGrant): void {
  const fields = storageGrantFields(grant);
  statements.updateGrant.run(
    grant.grantType,
    grant.grantVersion,
    fields.eventId,
    fields.gameDayId,
    fields.pitchId,
    fields.pitchSlotId,
    grant.status,
    grant.createdAtMs,
    grant.expiresAtMs,
    grant.credential.formatVersion,
    grant.credential.kind,
    grant.credential.materialState,
    grant.credential.encryptionKeyVersion,
    grant.credential.lookupKeyVersion,
    grant.credential.iv,
    grant.credential.ciphertext,
    grant.credential.tag,
    grant.credential.lookupDigest,
    grant.credential.fingerprint,
    grant.grantId,
  );
}

export function insertGrantSession(
  statements: GrantSqliteStatements,
  session: StoredGrantSession,
): void {
  statements.insertSession.run(
    session.sessionId,
    session.grantId,
    session.grantVersion,
    session.eventGameId,
    session.browserContextDigest,
    session.browserContextKeyVersion,
    session.bearerMaterialState,
    session.bearerLookupVerifier,
    session.bearerLookupKeyVersion,
    session.status,
    session.createdAtMs,
    session.lastActiveAtMs,
    session.revokedAtMs,
    session.deviceClass ?? "unknown",
    session.browserClass ?? "unknown",
  );
}

export function updateGrantSession(
  statements: GrantSqliteStatements,
  session: StoredGrantSession,
): void {
  statements.updateSession.run(
    session.grantId,
    session.grantVersion,
    session.eventGameId,
    session.browserContextDigest,
    session.browserContextKeyVersion,
    session.bearerMaterialState,
    session.bearerLookupVerifier,
    session.bearerLookupKeyVersion,
    session.status,
    session.createdAtMs,
    session.lastActiveAtMs,
    session.revokedAtMs,
    session.deviceClass ?? "unknown",
    session.browserClass ?? "unknown",
    session.sessionId,
  );
}

export function appendGrantAudit(
  statements: GrantSqliteStatements,
  entry: StoredGrantAuditEntry,
  keyRing: GrantKeyRing | undefined,
): void {
  if (keyRing === undefined) {
    throw new Error("Grant Audit Trail integrity requires the Grant key ring.");
  }
  const fields = storageAuditFields(entry);
  const integrityTag = computeGrantAuditIntegrityTag(entry, keyRing);
  statements.insertAudit.run(
    entry.auditId,
    entry.action,
    entry.outcome,
    entry.actorReference,
    entry.grantId,
    entry.grantType,
    entry.grantVersion,
    fields.eventId,
    fields.gameDayId,
    fields.pitchId,
    fields.pitchSlotId,
    entry.sessionId,
    entry.replacedSessionId,
    entry.eventGameId,
    entry.credentialKind,
    entry.credentialFingerprint,
    entry.beforeStatus,
    entry.afterStatus,
    entry.beforeExpiresAtMs,
    entry.afterExpiresAtMs,
    entry.previousEventGameId ?? null,
    entry.replayEvidenceId ?? null,
    entry.terminalReason,
    integrityTag,
    entry.createdAtMs,
  );
}

function storageAuditFields(entry: StoredGrantAuditEntry): GrantStorageFields {
  if (entry.grantType === GRANT_TYPE) {
    const scope = entry.scope as ControlGrantScope;
    return {
      eventId: scope.eventId,
      gameDayId: scope.gameDayId,
      pitchId: scope.pitchId,
      pitchSlotId: scope.pitchSlotId,
    };
  }
  return {
    eventId: `${TYPED_SCOPE_PREFIX}${Buffer.from(JSON.stringify({ grantType: entry.grantType, scope: entry.scope }), "utf8").toString("base64url")}`,
    gameDayId: `${entry.grantType}:${entry.grantId}:game-day`,
    pitchId: `${entry.grantType}:${entry.grantId}:pitch`,
    pitchSlotId: `${entry.grantType}:${entry.grantId}:slot`,
  };
}

function readStoredControlGrant(row: GrantRow): StoredGrant {
  const grantType = readText(row.grant_type);
  const status = readText(row.status);
  if (
    ![GRANT_TYPE, EVENT_ADMIN_GRANT_TYPE, PITCH_MANAGER_GRANT_TYPE].includes(
      grantType as GrantType,
    ) ||
    !isStoredGrantStatus(status)
  ) {
    throw new Error("Stored Grant state is invalid.");
  }
  const formatVersion = readInteger(row.credential_format_version);
  const kind = readText(row.credential_kind);
  if (formatVersion !== GRANT_CREDENTIAL_FORMAT_VERSION || kind !== GRANT_CREDENTIAL_KIND) {
    throw new Error("Stored Grant credential metadata is invalid.");
  }
  const materialState = readText(row.credential_material_state);
  const encryptionKeyVersion = readNullableText(row.encryption_key_version);
  const lookupKeyVersion = readNullableText(row.lookup_key_version);
  const iv = readNullableText(row.credential_iv);
  const ciphertext = readNullableText(row.credential_ciphertext);
  const tag = readNullableText(row.credential_tag);
  const lookupDigest = readNullableText(row.credential_lookup_digest);
  const materialPresent =
    materialState === "present" &&
    encryptionKeyVersion !== null &&
    lookupKeyVersion !== null &&
    iv !== null &&
    ciphertext !== null &&
    tag !== null &&
    lookupDigest !== null;
  const materialErased =
    materialState === "erased" &&
    encryptionKeyVersion === null &&
    lookupKeyVersion === null &&
    iv === null &&
    ciphertext === null &&
    tag === null &&
    lookupDigest === null;
  if (!materialPresent && !materialErased) {
    throw new Error("Stored Grant credential material state is invalid.");
  }
  if ((status === "expired") !== (materialState === "erased")) {
    throw new Error("Stored Grant lifecycle and credential material state do not match.");
  }
  const decoded = decodeGrantScope(row);
  return {
    grantId: readText(row.grant_id),
    grantType: decoded.grantType,
    grantVersion: readText(row.grant_version),
    scope: decoded.scope,
    status,
    createdAtMs: readInteger(row.created_at_ms),
    expiresAtMs: readNullableInteger(row.expires_at_ms),
    credential: {
      materialState: materialState as "present" | "erased",
      formatVersion,
      kind,
      encryptionKeyVersion,
      lookupKeyVersion,
      iv,
      ciphertext,
      tag,
      lookupDigest,
      fingerprint: readText(row.credential_fingerprint),
    },
  };
}

type GrantStorageFields = {
  eventId: string;
  gameDayId: string;
  pitchId: string;
  pitchSlotId: string;
};

const TYPED_SCOPE_PREFIX = "typed-grant-v1:";

function storageGrantFields(grant: StoredGrant): GrantStorageFields {
  if (grant.grantType === GRANT_TYPE) {
    const scope = grant.scope as ControlGrantScope;
    return {
      eventId: scope.eventId,
      gameDayId: scope.gameDayId,
      pitchId: scope.pitchId,
      pitchSlotId: scope.pitchSlotId,
    };
  }
  return {
    eventId: `${TYPED_SCOPE_PREFIX}${Buffer.from(JSON.stringify({ grantType: grant.grantType, scope: grant.scope }), "utf8").toString("base64url")}`,
    gameDayId: `${grant.grantType}:${grant.grantId}:game-day`,
    pitchId: `${grant.grantType}:${grant.grantId}:pitch`,
    pitchSlotId: `${grant.grantType}:${grant.grantId}:slot`,
  };
}

function decodeGrantScope(row: GrantRow): { grantType: GrantType; scope: GrantScope } {
  const eventId = readText(row.event_id);
  const storedGrantType = readText(row.grant_type) as GrantType;
  if (storedGrantType !== GRANT_TYPE) {
    if (!eventId.startsWith(TYPED_SCOPE_PREFIX))
      throw new Error("Typed Grant scope encoding is missing.");
    let decoded: { grantType: GrantType; scope: GrantScope };
    try {
      decoded = JSON.parse(
        Buffer.from(eventId.slice(TYPED_SCOPE_PREFIX.length), "base64url").toString("utf8"),
      ) as { grantType: GrantType; scope: GrantScope };
    } catch {
      throw new Error("Typed Grant scope encoding is invalid.");
    }
    if (decoded.grantType !== storedGrantType)
      throw new Error("Stored Grant type does not match encoded scope type.");
    const validated = validateGrantScope(storedGrantType, decoded.scope);
    if (!validated.ok) throw new Error("Stored typed Grant scope is invalid.");
    return { grantType: storedGrantType, scope: validated.value };
  }
  if (eventId.startsWith(TYPED_SCOPE_PREFIX)) {
    let decoded: { grantType?: unknown; scope?: unknown };
    try {
      decoded = JSON.parse(
        Buffer.from(eventId.slice(TYPED_SCOPE_PREFIX.length), "base64url").toString("utf8"),
      ) as { grantType?: unknown; scope?: unknown };
    } catch {
      throw new Error("Stored Control Grant contains an invalid typed scope encoding.");
    }
    if (decoded.grantType !== GRANT_TYPE)
      throw new Error("Stored Control Grant contains a mismatched typed scope encoding.");
    const validated = validateGrantScope(GRANT_TYPE, decoded.scope);
    if (!validated.ok) throw new Error("Stored Control Grant typed scope is invalid.");
    const storedScope = {
      eventId,
      gameDayId: readText(row.game_day_id),
      pitchId: readText(row.pitch_id),
      pitchSlotId: readText(row.pitch_slot_id),
    };
    if (JSON.stringify(validated.value) !== JSON.stringify(storedScope))
      throw new Error("Stored Control Grant typed scope does not match stored fields.");
    return { grantType: GRANT_TYPE, scope: validated.value };
  }
  const controlScope = validateGrantScope(GRANT_TYPE, {
    eventId,
    gameDayId: readText(row.game_day_id),
    pitchId: readText(row.pitch_id),
    pitchSlotId: readText(row.pitch_slot_id),
  });
  if (!controlScope.ok) throw new Error("Stored Control Grant scope is invalid.");
  return {
    grantType: GRANT_TYPE,
    scope: controlScope.value,
  };
}

function readStoredGrantSession(row: GrantRow): StoredGrantSession {
  const status = readText(row.status);
  if (!isStoredGrantSessionStatus(status)) {
    throw new Error("Stored Grant Session state is invalid.");
  }
  const bearerMaterialState = readText(row.bearer_material_state);
  const bearerLookupVerifier = readNullableText(row.bearer_lookup_verifier);
  const bearerLookupKeyVersion = readNullableText(row.bearer_lookup_key_version);
  if (
    !(
      (bearerMaterialState === "present" &&
        bearerLookupVerifier !== null &&
        bearerLookupKeyVersion !== null) ||
      (bearerMaterialState === "erased" &&
        bearerLookupVerifier === null &&
        bearerLookupKeyVersion === null)
    )
  ) {
    throw new Error("Stored Grant Session bearer material state is invalid.");
  }
  if ((status === "expired") !== (bearerMaterialState === "erased")) {
    throw new Error("Stored Grant Session lifecycle and bearer material state do not match.");
  }
  return {
    sessionId: readText(row.session_id),
    grantId: readText(row.grant_id),
    grantVersion: readText(row.grant_version),
    eventGameId: readText(row.event_game_id),
    browserContextDigest: readText(row.browser_context_digest),
    browserContextKeyVersion: readText(row.browser_context_key_version),
    bearerMaterialState: bearerMaterialState as "present" | "erased",
    bearerLookupVerifier,
    bearerLookupKeyVersion,
    status,
    createdAtMs: readInteger(row.created_at_ms),
    lastActiveAtMs: readInteger(row.last_active_at_ms),
    revokedAtMs: readNullableInteger(row.revoked_at_ms),
    deviceClass: readText(row.device_class),
    browserClass: readText(row.browser_class),
  };
}

export function readStoredGrantAuditEntry(row: GrantRow): StoredGrantAuditEntry {
  let action = readText(row.action) as StoredGrantAuditEntry["action"];
  const allowedActions: readonly StoredGrantAuditEntry["action"][] = [
    "grant-created",
    "credential-revealed",
    "credential-rotated",
    "grant-expired",
    "grant-disabled",
    "grant-revoked",
    "session-admitted",
    "session-replaced",
    "grant-reactivated",
    "grant-metadata-updated",
    "session-revoked",
    "session-terminated",
    "session-switched",
    "replay-authorized",
  ];
  if (!allowedActions.includes(action)) {
    throw new Error("Stored Grant Audit Trail action is invalid.");
  }
  const storedGrantType = readText(row.grant_type);
  if (
    readText(row.outcome) !== "accepted" ||
    ![GRANT_TYPE, EVENT_ADMIN_GRANT_TYPE, PITCH_MANAGER_GRANT_TYPE].includes(
      storedGrantType as GrantType,
    )
  ) {
    throw new Error("Stored Grant Audit Trail outcome is invalid.");
  }
  const credentialKind = readNullableText(row.credential_kind);
  if (credentialKind !== null && credentialKind !== GRANT_CREDENTIAL_KIND) {
    throw new Error("Stored Grant Audit Trail credential kind is invalid.");
  }
  const beforeStatus = readNullableText(row.before_status);
  const afterStatus = readNullableText(row.after_status);
  const terminalReason = readNullableText(row.terminal_reason);
  const beforeExpiresAtMs = readNullableInteger(row.before_expires_at_ms);
  const afterExpiresAtMs = readNullableInteger(row.after_expires_at_ms);
  if (
    (beforeStatus !== null && !isStoredGrantStatus(beforeStatus)) ||
    (afterStatus !== null && !isStoredGrantStatus(afterStatus))
  ) {
    throw new Error("Stored Grant Audit Trail status is invalid.");
  }
  if (
    terminalReason !== null &&
    !["game-locked", "accepted-game-switch", "past-game-day"].includes(terminalReason)
  ) {
    throw new Error("Stored Grant Audit Trail terminal reason is invalid.");
  }
  if (action === "session-terminated" && terminalReason === null) {
    throw new Error("Stored terminal Grant Audit Trail evidence is incomplete.");
  }
  if (action !== "session-terminated" && terminalReason !== null) {
    throw new Error("Stored non-terminal Grant Audit Trail evidence has a terminal reason.");
  }
  return {
    auditId: readText(row.audit_id),
    action,
    outcome: "accepted",
    actorReference: readText(row.actor_reference),
    grantId: readText(row.grant_id),
    grantType: decodeGrantScope(row).grantType,
    grantVersion: readText(row.grant_version),
    scope: decodeGrantScope(row).scope,
    sessionId: readNullableText(row.session_id),
    replacedSessionId: readNullableText(row.replaced_session_id),
    eventGameId: readNullableText(row.event_game_id),
    credentialKind: credentialKind as StoredGrantAuditEntry["credentialKind"],
    credentialFingerprint: readNullableText(row.credential_fingerprint),
    beforeStatus: beforeStatus as StoredGrantAuditEntry["beforeStatus"],
    afterStatus: afterStatus as StoredGrantAuditEntry["afterStatus"],
    beforeExpiresAtMs,
    afterExpiresAtMs,
    previousEventGameId: readNullableText(row.previous_event_game_id),
    replayEvidenceId: readNullableText(row.replay_evidence_id),
    terminalReason: terminalReason as StoredGrantAuditEntry["terminalReason"],
    createdAtMs: readInteger(row.created_at_ms),
  };
}

function asRecord(value: unknown): GrantRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("SQLite returned an invalid Grant row.");
  }
  return value as GrantRow;
}

function readText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  throw new Error("SQLite returned an invalid Grant value.");
}

function readInteger(value: unknown): number {
  const parsed = Number(readText(value));
  if (!Number.isSafeInteger(parsed)) throw new Error("SQLite returned an invalid Grant integer.");
  return parsed;
}

function readNullableText(value: unknown): string | null {
  return value === null ? null : readText(value);
}

function readNullableInteger(value: unknown): number | null {
  return value === null ? null : readInteger(value);
}
