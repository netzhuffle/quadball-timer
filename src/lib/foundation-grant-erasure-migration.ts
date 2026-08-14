type GrantErasureMigrationTables = {
  grantTableSql: string;
  sessionTableSql: string;
  auditTableSql: string;
  sessionGrantIndexSql: string;
  sessionContextIndexSql: string;
  auditGrantIndexSql: string;
};

export function createFoundationGrantErasureMigrationSql(
  tables: GrantErasureMigrationTables,
): string {
  return `
  CREATE TABLE foundation_grant_erasure_mapping (
    grant_id TEXT PRIMARY KEY,
    original_status TEXT NOT NULL,
    should_expire INTEGER NOT NULL CHECK (should_expire IN (0, 1)),
    old_lookup_digest TEXT NOT NULL,
    retained_opaque_reference TEXT NOT NULL
  ) STRICT;
  INSERT INTO foundation_grant_erasure_mapping (
    grant_id, original_status, should_expire, old_lookup_digest, retained_opaque_reference
  )
  SELECT
    grant_id,
    status,
    CASE
      WHEN status = 'expired' THEN 1
      WHEN expires_at_ms IS NOT NULL AND expires_at_ms <= CAST(unixepoch('subsec') * 1000 AS INTEGER) THEN 1
      ELSE 0
    END,
    credential_lookup_digest,
    CASE
      WHEN credential_fingerprint = credential_lookup_digest
      THEN 'opaque-migration-reference-v1:' || lower(hex(randomblob(32)))
      ELSE credential_fingerprint
    END
  FROM foundation_grant_roots;

  CREATE TABLE foundation_grant_sessions_erasure_copy AS SELECT
    session_id, grant_id, grant_version, event_game_id, browser_context_digest,
    browser_context_key_version,
    CASE WHEN mapping.should_expire = 1 THEN 'erased' ELSE 'present' END AS bearer_material_state,
    CASE WHEN mapping.should_expire = 1 THEN NULL ELSE bearer_lookup_verifier END AS bearer_lookup_verifier,
    CASE WHEN mapping.should_expire = 1 THEN NULL ELSE bearer_lookup_key_version END AS bearer_lookup_key_version,
    CASE WHEN mapping.should_expire = 1 THEN 'expired' ELSE sessions.status END AS status,
    created_at_ms,
    last_active_at_ms, revoked_at_ms
  FROM foundation_grant_sessions AS sessions
  JOIN foundation_grant_erasure_mapping AS mapping USING (grant_id);
  DROP TABLE foundation_grant_sessions;

  CREATE TABLE foundation_grant_audit_erasure_copy AS SELECT *
  FROM foundation_grant_audit;
  DROP TABLE foundation_grant_audit;

  ${tables.grantTableSql.replace(
    "CREATE TABLE foundation_grant_roots",
    "CREATE TABLE foundation_grant_roots_v5",
  )};
  INSERT INTO foundation_grant_roots_v5 (
    grant_id, grant_type, grant_version, event_id, game_day_id, pitch_id, pitch_slot_id,
    status, created_at_ms, expires_at_ms, credential_format_version, credential_kind,
    credential_material_state, encryption_key_version, lookup_key_version, credential_iv,
    credential_ciphertext, credential_tag, credential_lookup_digest, credential_fingerprint
  )
  SELECT
    roots.grant_id, grant_type, grant_version, event_id, game_day_id, pitch_id, pitch_slot_id,
    CASE WHEN mapping.should_expire = 1 THEN 'expired' ELSE roots.status END,
    created_at_ms, expires_at_ms, credential_format_version, credential_kind,
    CASE WHEN mapping.should_expire = 1 THEN 'erased' ELSE 'present' END,
    CASE WHEN mapping.should_expire = 1 THEN NULL ELSE encryption_key_version END,
    CASE WHEN mapping.should_expire = 1 THEN NULL ELSE lookup_key_version END,
    CASE WHEN mapping.should_expire = 1 THEN NULL ELSE credential_iv END,
    CASE WHEN mapping.should_expire = 1 THEN NULL ELSE credential_ciphertext END,
    CASE WHEN mapping.should_expire = 1 THEN NULL ELSE credential_tag END,
    CASE WHEN mapping.should_expire = 1 THEN NULL ELSE credential_lookup_digest END,
    mapping.retained_opaque_reference
  FROM foundation_grant_roots AS roots
  JOIN foundation_grant_erasure_mapping AS mapping USING (grant_id);
  DROP TABLE foundation_grant_roots;
  ALTER TABLE foundation_grant_roots_v5 RENAME TO foundation_grant_roots;

  ${tables.sessionTableSql};
  INSERT INTO foundation_grant_sessions (
    session_id, grant_id, grant_version, event_game_id, browser_context_digest,
    browser_context_key_version, bearer_material_state, bearer_lookup_verifier,
    bearer_lookup_key_version, status, created_at_ms, last_active_at_ms, revoked_at_ms
  )
  SELECT
    session_id, grant_id, grant_version, event_game_id, browser_context_digest,
    browser_context_key_version, bearer_material_state, bearer_lookup_verifier,
    bearer_lookup_key_version, status, created_at_ms, last_active_at_ms, revoked_at_ms
  FROM foundation_grant_sessions_erasure_copy;
  DROP TABLE foundation_grant_sessions_erasure_copy;
  ${tables.sessionGrantIndexSql};
  ${tables.sessionContextIndexSql};

  ${tables.auditTableSql};
  INSERT INTO foundation_grant_audit (
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, credential_kind, credential_fingerprint, before_status, after_status,
    created_at_ms
  )
  SELECT
    audit_id, action, outcome, actor_reference, audit.grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, credential_kind,
    CASE
      WHEN mapping.retained_opaque_reference LIKE 'opaque-migration-reference-v1:%' THEN NULL
      ELSE audit.credential_fingerprint
    END,
    before_status, after_status, created_at_ms
  FROM foundation_grant_audit_erasure_copy AS audit
  JOIN foundation_grant_erasure_mapping AS mapping USING (grant_id);

  INSERT INTO foundation_grant_audit (
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, credential_kind, credential_fingerprint, before_status, after_status,
    created_at_ms
  )
  SELECT
    'grant-audit-migration-' || lower(hex(randomblob(16))),
    'grant-expired',
    'accepted',
    'actor-migration-' || lower(hex(randomblob(32))),
    roots.grant_id,
    roots.grant_type,
    roots.grant_version,
    roots.event_id,
    roots.game_day_id,
    roots.pitch_id,
    roots.pitch_slot_id,
    NULL,
    NULL,
    NULL,
    roots.credential_kind,
    CASE
      WHEN mapping.retained_opaque_reference LIKE 'opaque-migration-reference-v1:%' THEN NULL
      ELSE mapping.retained_opaque_reference
    END,
    mapping.original_status,
    'expired',
    COALESCE(roots.expires_at_ms, roots.created_at_ms)
  FROM foundation_grant_roots AS roots
  JOIN foundation_grant_erasure_mapping AS mapping USING (grant_id)
  WHERE mapping.should_expire = 1
    AND NOT EXISTS (
      SELECT 1 FROM foundation_grant_audit AS audit
      WHERE audit.grant_id = roots.grant_id AND audit.action = 'grant-expired'
    );
  ${tables.auditGrantIndexSql};

  DROP TABLE foundation_grant_audit_erasure_copy;
  DROP TABLE foundation_grant_erasure_mapping;
`;
}
