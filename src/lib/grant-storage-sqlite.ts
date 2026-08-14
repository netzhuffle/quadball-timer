import { Database } from "bun:sqlite";
import {
  GRANT_CREDENTIAL_FORMAT_VERSION,
  GRANT_CREDENTIAL_KIND,
  GRANT_TYPE,
  isStoredGrantSessionStatus,
  isStoredGrantStatus,
  type StoredControlGrant,
  type StoredGrantAuditEntry,
  type StoredGrantSession,
} from "@/lib/grant-types";

type SqlStatement = ReturnType<Database["query"]>;
type GrantRow = Record<string, unknown>;

export type GrantSqliteStatements = {
  byGrantId: SqlStatement;
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
  sessions.last_active_at_ms AS last_active_at_ms, sessions.revoked_at_ms AS revoked_at_ms
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
  audit.created_at_ms AS created_at_ms
`;

export function createGrantSqliteStatements(database: Database): GrantSqliteStatements {
  return {
    byGrantId: database.query(
      `SELECT ${GRANT_SELECT_COLUMNS} FROM foundation_grant_roots AS grants WHERE grants.grant_id = ?`,
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
        status, created_at_ms, last_active_at_ms, revoked_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateSession: database.query(`
      UPDATE foundation_grant_sessions SET
        grant_id = ?, grant_version = ?, event_game_id = ?, browser_context_digest = ?,
        browser_context_key_version = ?, bearer_material_state = ?, bearer_lookup_verifier = ?,
        bearer_lookup_key_version = ?, status = ?, created_at_ms = ?,
        last_active_at_ms = ?, revoked_at_ms = ?
      WHERE session_id = ?
    `),
    insertAudit: database.query(`
      INSERT INTO foundation_grant_audit (
        audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
        event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
        event_game_id, credential_kind, credential_fingerprint, before_status, after_status,
        created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
  };
}

export function readGrantByStatement(
  statement: SqlStatement,
  ...parameters: string[]
): StoredControlGrant | null {
  const row = statement.get(...parameters) as GrantRow | null;
  return row === null ? null : readStoredControlGrant(row);
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

export function insertGrant(statements: GrantSqliteStatements, grant: StoredControlGrant): void {
  statements.insertGrant.run(
    grant.grantId,
    grant.grantType,
    grant.grantVersion,
    grant.scope.eventId,
    grant.scope.gameDayId,
    grant.scope.pitchId,
    grant.scope.pitchSlotId,
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

export function updateGrant(statements: GrantSqliteStatements, grant: StoredControlGrant): void {
  statements.updateGrant.run(
    grant.grantType,
    grant.grantVersion,
    grant.scope.eventId,
    grant.scope.gameDayId,
    grant.scope.pitchId,
    grant.scope.pitchSlotId,
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
    session.sessionId,
  );
}

export function appendGrantAudit(
  statements: GrantSqliteStatements,
  entry: StoredGrantAuditEntry,
): void {
  statements.insertAudit.run(
    entry.auditId,
    entry.action,
    entry.outcome,
    entry.actorReference,
    entry.grantId,
    entry.grantType,
    entry.grantVersion,
    entry.scope.eventId,
    entry.scope.gameDayId,
    entry.scope.pitchId,
    entry.scope.pitchSlotId,
    entry.sessionId,
    entry.replacedSessionId,
    entry.eventGameId,
    entry.credentialKind,
    entry.credentialFingerprint,
    entry.beforeStatus,
    entry.afterStatus,
    entry.createdAtMs,
  );
}

function readStoredControlGrant(row: GrantRow): StoredControlGrant {
  const grantType = readText(row.grant_type);
  const status = readText(row.status);
  if (grantType !== GRANT_TYPE || !isStoredGrantStatus(status)) {
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
  return {
    grantId: readText(row.grant_id),
    grantType,
    grantVersion: readText(row.grant_version),
    scope: {
      eventId: readText(row.event_id),
      gameDayId: readText(row.game_day_id),
      pitchId: readText(row.pitch_id),
      pitchSlotId: readText(row.pitch_slot_id),
    },
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
  };
}

function readStoredGrantAuditEntry(row: GrantRow): StoredGrantAuditEntry {
  const action = readText(row.action);
  const allowedActions: readonly StoredGrantAuditEntry["action"][] = [
    "grant-created",
    "credential-revealed",
    "credential-rotated",
    "grant-expired",
    "grant-disabled",
    "grant-revoked",
    "session-admitted",
    "session-replaced",
  ];
  if (!allowedActions.includes(action as StoredGrantAuditEntry["action"])) {
    throw new Error("Stored Grant Audit Trail action is invalid.");
  }
  if (readText(row.outcome) !== "accepted" || readText(row.grant_type) !== GRANT_TYPE) {
    throw new Error("Stored Grant Audit Trail outcome is invalid.");
  }
  const credentialKind = readNullableText(row.credential_kind);
  if (credentialKind !== null && credentialKind !== GRANT_CREDENTIAL_KIND) {
    throw new Error("Stored Grant Audit Trail credential kind is invalid.");
  }
  const beforeStatus = readNullableText(row.before_status);
  const afterStatus = readNullableText(row.after_status);
  if (
    (beforeStatus !== null && !isStoredGrantStatus(beforeStatus)) ||
    (afterStatus !== null && !isStoredGrantStatus(afterStatus))
  ) {
    throw new Error("Stored Grant Audit Trail status is invalid.");
  }
  return {
    auditId: readText(row.audit_id),
    action: action as StoredGrantAuditEntry["action"],
    outcome: "accepted",
    actorReference: readText(row.actor_reference),
    grantId: readText(row.grant_id),
    grantType: GRANT_TYPE,
    grantVersion: readText(row.grant_version),
    scope: {
      eventId: readText(row.event_id),
      gameDayId: readText(row.game_day_id),
      pitchId: readText(row.pitch_id),
      pitchSlotId: readText(row.pitch_slot_id),
    },
    sessionId: readNullableText(row.session_id),
    replacedSessionId: readNullableText(row.replaced_session_id),
    eventGameId: readNullableText(row.event_game_id),
    credentialKind: credentialKind as StoredGrantAuditEntry["credentialKind"],
    credentialFingerprint: readNullableText(row.credential_fingerprint),
    beforeStatus: beforeStatus as StoredGrantAuditEntry["beforeStatus"],
    afterStatus: afterStatus as StoredGrantAuditEntry["afterStatus"],
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
