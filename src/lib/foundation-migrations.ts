import { createHash } from "node:crypto";

import { createFoundationGrantErasureMigrationSql } from "./foundation-grant-erasure-migration";

export const FOUNDATION_MIGRATION_LEDGER_TABLE = "foundation_migration_ledger";

export type FoundationMigration = {
  id: string;
  ordinal: number;
  schemaVersion: number;
  sql: string;
  checksum: string;
};

export type MigrationLedgerEntry = {
  id: string;
  ordinal: number;
  schemaVersion: number;
  checksum: string;
  status: "complete" | "applying";
};

export type MigrationReadiness =
  | {
      status: "ready";
      schemaVersion: number;
      appliedMigrationIds: string[];
    }
  | {
      status: "pending" | "missing" | "reordered" | "changed-checksum" | "incomplete" | "future";
      detail: string;
      schemaVersion: number;
      appliedMigrationIds: string[];
    };

export const FOUNDATION_LEDGER_TABLE_SQL = `
  CREATE TABLE foundation_migration_ledger (
    migration_id TEXT PRIMARY KEY,
    ordinal INTEGER NOT NULL UNIQUE,
    schema_version INTEGER NOT NULL,
    checksum TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('complete', 'applying')),
    applied_at_ms INTEGER
  ) STRICT
`;

export const FOUNDATION_ROOT_TABLE_SQL = `
  CREATE TABLE foundation_event_game_record_roots (
    record_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    event_game_id TEXT NOT NULL UNIQUE,
    owner_event_id TEXT NOT NULL,
    owner_event_game_id TEXT NOT NULL,
    scope_event_id TEXT NOT NULL,
    game_day_id TEXT NOT NULL,
    pitch_id TEXT NOT NULL,
    pitch_slot_id TEXT NOT NULL UNIQUE,
    lifecycle_phase TEXT NOT NULL CHECK (lifecycle_phase IN ('scheduled', 'in-progress', 'suspended', 'finished')),
    commenced_at_ms INTEGER,
    finished_at_ms INTEGER,
    locked_at_ms INTEGER,
    lock_reason TEXT CHECK (lock_reason IS NULL OR lock_reason IN ('finished-inactivity', 'administrative')),
    record_version TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    interpreter_version TEXT NOT NULL,
    creation_operation_id TEXT NOT NULL,
    creation_actor_reference TEXT NOT NULL,
    creation_source TEXT NOT NULL CHECK (creation_source = 'event-game-registration'),
    creation_created_at_ms INTEGER NOT NULL,
    canonical_content TEXT NOT NULL,
    root_json TEXT NOT NULL CHECK (json_valid(root_json)),
    CHECK (owner_event_id = event_id),
    CHECK (owner_event_game_id = event_game_id),
    CHECK (scope_event_id = event_id),
    CHECK (finished_at_ms IS NULL OR commenced_at_ms IS NOT NULL),
    CHECK (locked_at_ms IS NULL OR finished_at_ms IS NOT NULL),
    CHECK ((locked_at_ms IS NULL) = (lock_reason IS NULL))
  ) STRICT
`;

export const FOUNDATION_SIDE_TABLE_SQL = `
  CREATE TABLE foundation_event_game_record_sides (
    side_id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL REFERENCES foundation_event_game_record_roots(record_id) ON DELETE CASCADE,
    side_position TEXT NOT NULL CHECK (side_position IN ('a', 'b')),
    event_team_id TEXT NOT NULL,
    team_interpretation_ref TEXT NOT NULL,
    UNIQUE (record_id, side_position),
    UNIQUE (record_id, event_team_id)
  ) STRICT
`;

export const FOUNDATION_ACTION_TABLE_SQL = `
  CREATE TABLE foundation_event_game_record_actions (
    action_id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL REFERENCES foundation_event_game_record_roots(record_id) ON DELETE CASCADE,
    event_game_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    action_kind TEXT NOT NULL,
    action_version TEXT NOT NULL,
    accepted_at_ms INTEGER NOT NULL,
    content_fingerprint TEXT NOT NULL,
    canonical_content TEXT NOT NULL,
    action_json TEXT NOT NULL CHECK (json_valid(action_json)),
    UNIQUE (record_id, operation_id),
    UNIQUE (record_id, content_fingerprint),
    CHECK (length(content_fingerprint) = 64),
    CHECK (event_game_id <> '')
  ) STRICT
`;

export const FOUNDATION_IDEMPOTENCY_TABLE_SQL = `
  CREATE TABLE foundation_event_game_record_idempotency (
    action_id TEXT PRIMARY KEY REFERENCES foundation_event_game_record_actions(action_id) ON DELETE CASCADE,
    record_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    content_fingerprint TEXT NOT NULL,
    accepted_at_ms INTEGER NOT NULL,
    UNIQUE (record_id, operation_id),
    UNIQUE (record_id, content_fingerprint),
    FOREIGN KEY (record_id, operation_id)
      REFERENCES foundation_event_game_record_actions(record_id, operation_id)
      ON DELETE CASCADE
  ) STRICT
`;

export const FOUNDATION_METADATA_TABLE_SQL = `
  CREATE TABLE foundation_event_game_record_metadata (
    record_id TEXT PRIMARY KEY REFERENCES foundation_event_game_record_roots(record_id) ON DELETE CASCADE,
    action_count INTEGER NOT NULL CHECK (action_count >= 0),
    ordering_version TEXT NOT NULL,
    last_accepted_at_ms INTEGER,
    updated_at_ms INTEGER NOT NULL
  ) STRICT
`;

export const FOUNDATION_AUDIT_TABLE_SQL = `
  CREATE TABLE foundation_event_game_record_audit (
    audit_id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL REFERENCES foundation_event_game_record_roots(record_id) ON DELETE CASCADE,
    event_game_id TEXT NOT NULL,
    operation_id TEXT,
    audit_kind TEXT NOT NULL CHECK (audit_kind IN ('action-accepted', 'action-conflict', 'action-rejected', 'action-duplicate')),
    outcome TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    redacted_detail TEXT NOT NULL,
    audit_json TEXT NOT NULL CHECK (json_valid(audit_json)),
    CHECK (event_game_id <> '')
  ) STRICT
`;

export const FOUNDATION_CURRENT_ACTION_TABLE_SQL = FOUNDATION_ACTION_TABLE_SQL.replace(
  "    action_json TEXT NOT NULL CHECK (json_valid(action_json)),",
  "    action_json TEXT NOT NULL CHECK (json_valid(action_json)),\n    control_action_version TEXT NOT NULL DEFAULT 'control-action-legacy-v0' CHECK (control_action_version IN ('control-action-v1', 'control-action-legacy-v0')),\n    action_evidence_format TEXT NOT NULL DEFAULT 'legacy' CHECK (action_evidence_format IN ('current', 'legacy')),",
);

export const FOUNDATION_CURRENT_AUDIT_TABLE_SQL = FOUNDATION_AUDIT_TABLE_SQL.replace(
  "    audit_json TEXT NOT NULL CHECK (json_valid(audit_json)),",
  "    audit_json TEXT NOT NULL CHECK (json_valid(audit_json)),\n    audit_version TEXT NOT NULL DEFAULT 'control-audit-legacy-v0' CHECK (audit_version IN ('control-audit-v1', 'control-audit-legacy-v0')),\n    audit_evidence_format TEXT NOT NULL DEFAULT 'legacy' CHECK (audit_evidence_format IN ('current', 'legacy')),",
);

export const FOUNDATION_ROOT_EVENT_INDEX_SQL = `
  CREATE INDEX foundation_event_game_record_roots_event_id
    ON foundation_event_game_record_roots (event_id)
`;

export const FOUNDATION_ROOT_GAME_DAY_INDEX_SQL = `
  CREATE INDEX foundation_event_game_record_roots_game_day_id
    ON foundation_event_game_record_roots (scope_event_id, game_day_id)
`;

export const FOUNDATION_SIDE_RECORD_INDEX_SQL = `
  CREATE INDEX foundation_event_game_record_sides_record_id
    ON foundation_event_game_record_sides (record_id)
`;

export const FOUNDATION_ACTION_RECORD_INDEX_SQL = `
  CREATE INDEX foundation_event_game_record_actions_record_id
    ON foundation_event_game_record_actions (record_id, accepted_at_ms)
`;

export const FOUNDATION_IDEMPOTENCY_RECORD_INDEX_SQL = `
  CREATE INDEX foundation_event_game_record_idempotency_record_id
    ON foundation_event_game_record_idempotency (record_id)
`;

export const FOUNDATION_AUDIT_RECORD_INDEX_SQL = `
  CREATE INDEX foundation_event_game_record_audit_record_id
    ON foundation_event_game_record_audit (record_id, created_at_ms)
`;

const FOUNDATION_GRANT_TABLE_V4_SQL = `
  CREATE TABLE foundation_grant_roots (
    grant_id TEXT PRIMARY KEY,
    grant_type TEXT NOT NULL CHECK (grant_type = 'control'),
    grant_version TEXT NOT NULL UNIQUE,
    event_id TEXT NOT NULL,
    game_day_id TEXT NOT NULL,
    pitch_id TEXT NOT NULL,
    pitch_slot_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'revoked', 'expired')),
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER,
    credential_format_version INTEGER NOT NULL CHECK (credential_format_version = 1),
    credential_kind TEXT NOT NULL CHECK (credential_kind = 'qr'),
    encryption_key_version TEXT NOT NULL,
    lookup_key_version TEXT NOT NULL,
    credential_iv TEXT NOT NULL,
    credential_ciphertext TEXT NOT NULL,
    credential_tag TEXT NOT NULL,
    credential_lookup_digest TEXT NOT NULL UNIQUE,
    credential_fingerprint TEXT NOT NULL,
    CHECK (expires_at_ms IS NULL OR expires_at_ms > created_at_ms)
  ) STRICT
`;

const FOUNDATION_GRANT_SESSION_TABLE_V4_SQL = `
  CREATE TABLE foundation_grant_sessions (
    session_id TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL REFERENCES foundation_grant_roots(grant_id) ON DELETE CASCADE,
    grant_version TEXT NOT NULL,
    event_game_id TEXT NOT NULL,
    browser_context_digest TEXT NOT NULL,
    browser_context_key_version TEXT NOT NULL,
    bearer_lookup_verifier TEXT NOT NULL UNIQUE,
    bearer_lookup_key_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
    created_at_ms INTEGER NOT NULL,
    last_active_at_ms INTEGER NOT NULL,
    revoked_at_ms INTEGER,
    CHECK ((status = 'active' AND revoked_at_ms IS NULL) OR (status <> 'active'))
  ) STRICT
`;

export const FOUNDATION_GRANT_TABLE_SQL = `
  CREATE TABLE foundation_grant_roots (
    grant_id TEXT PRIMARY KEY,
    grant_type TEXT NOT NULL CHECK (grant_type = 'control'),
    grant_version TEXT NOT NULL UNIQUE,
    event_id TEXT NOT NULL,
    game_day_id TEXT NOT NULL,
    pitch_id TEXT NOT NULL,
    pitch_slot_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'revoked', 'expired')),
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER,
    credential_format_version INTEGER NOT NULL CHECK (credential_format_version = 1),
    credential_kind TEXT NOT NULL CHECK (credential_kind = 'qr'),
    credential_material_state TEXT NOT NULL CHECK (credential_material_state IN ('present', 'erased')),
    encryption_key_version TEXT,
    lookup_key_version TEXT,
    credential_iv TEXT,
    credential_ciphertext TEXT,
    credential_tag TEXT,
    credential_lookup_digest TEXT UNIQUE,
    credential_fingerprint TEXT NOT NULL,
    CHECK (expires_at_ms IS NULL OR expires_at_ms > created_at_ms),
    CHECK (
      (credential_material_state = 'present' AND encryption_key_version IS NOT NULL AND lookup_key_version IS NOT NULL AND credential_iv IS NOT NULL AND credential_ciphertext IS NOT NULL AND credential_tag IS NOT NULL AND credential_lookup_digest IS NOT NULL)
      OR
      (credential_material_state = 'erased' AND encryption_key_version IS NULL AND lookup_key_version IS NULL AND credential_iv IS NULL AND credential_ciphertext IS NULL AND credential_tag IS NULL AND credential_lookup_digest IS NULL)
    ),
    CHECK (
      (status = 'expired' AND credential_material_state = 'erased')
      OR
      (status <> 'expired' AND credential_material_state = 'present')
    )
  ) STRICT
`;

export const FOUNDATION_GRANT_SESSION_TABLE_SQL = `
  CREATE TABLE foundation_grant_sessions (
    session_id TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL REFERENCES foundation_grant_roots(grant_id) ON DELETE CASCADE,
    grant_version TEXT NOT NULL,
    event_game_id TEXT NOT NULL,
    browser_context_digest TEXT NOT NULL,
    browser_context_key_version TEXT NOT NULL,
    bearer_material_state TEXT NOT NULL CHECK (bearer_material_state IN ('present', 'erased')),
    bearer_lookup_verifier TEXT UNIQUE,
    bearer_lookup_key_version TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
    created_at_ms INTEGER NOT NULL,
    last_active_at_ms INTEGER NOT NULL,
    revoked_at_ms INTEGER,
    CHECK ((status = 'active' AND revoked_at_ms IS NULL) OR (status <> 'active')),
    CHECK (
      (bearer_material_state = 'present' AND bearer_lookup_verifier IS NOT NULL AND bearer_lookup_key_version IS NOT NULL)
      OR
      (bearer_material_state = 'erased' AND bearer_lookup_verifier IS NULL AND bearer_lookup_key_version IS NULL)
    ),
    CHECK (
      (status = 'expired' AND bearer_material_state = 'erased')
      OR
      (status <> 'expired' AND bearer_material_state = 'present')
    )
  ) STRICT
`;

const FOUNDATION_GRANT_AUDIT_TABLE_V4_SQL = `
  CREATE TABLE foundation_grant_audit (
    audit_id TEXT PRIMARY KEY,
    action TEXT NOT NULL CHECK (action IN ('grant-created', 'credential-revealed', 'grant-disabled', 'grant-revoked', 'session-admitted', 'session-replaced')),
    outcome TEXT NOT NULL CHECK (outcome = 'accepted'),
    actor_reference TEXT NOT NULL,
    grant_id TEXT NOT NULL REFERENCES foundation_grant_roots(grant_id) ON DELETE CASCADE,
    grant_type TEXT NOT NULL CHECK (grant_type = 'control'),
    grant_version TEXT NOT NULL,
    event_id TEXT NOT NULL,
    game_day_id TEXT NOT NULL,
    pitch_id TEXT NOT NULL,
    pitch_slot_id TEXT NOT NULL,
    session_id TEXT,
    replaced_session_id TEXT,
    event_game_id TEXT,
    credential_kind TEXT CHECK (credential_kind IS NULL OR credential_kind = 'qr'),
    credential_fingerprint TEXT,
    before_status TEXT CHECK (before_status IS NULL OR before_status IN ('active', 'disabled', 'revoked', 'expired')),
    after_status TEXT CHECK (after_status IS NULL OR after_status IN ('active', 'disabled', 'revoked', 'expired')),
    created_at_ms INTEGER NOT NULL
  ) STRICT
`;

const FOUNDATION_GRANT_AUDIT_TABLE_V5_SQL = `
  CREATE TABLE foundation_grant_audit (
    audit_id TEXT PRIMARY KEY,
    action TEXT NOT NULL CHECK (action IN ('grant-created', 'credential-revealed', 'grant-expired', 'grant-disabled', 'grant-revoked', 'session-admitted', 'session-replaced')),
    outcome TEXT NOT NULL CHECK (outcome = 'accepted'),
    actor_reference TEXT NOT NULL,
    grant_id TEXT NOT NULL REFERENCES foundation_grant_roots(grant_id) ON DELETE CASCADE,
    grant_type TEXT NOT NULL CHECK (grant_type = 'control'),
    grant_version TEXT NOT NULL,
    event_id TEXT NOT NULL,
    game_day_id TEXT NOT NULL,
    pitch_id TEXT NOT NULL,
    pitch_slot_id TEXT NOT NULL,
    session_id TEXT,
    replaced_session_id TEXT,
    event_game_id TEXT,
    credential_kind TEXT CHECK (credential_kind IS NULL OR credential_kind = 'qr'),
    credential_fingerprint TEXT,
    before_status TEXT CHECK (before_status IS NULL OR before_status IN ('active', 'disabled', 'revoked', 'expired')),
    after_status TEXT CHECK (after_status IS NULL OR after_status IN ('active', 'disabled', 'revoked', 'expired')),
    created_at_ms INTEGER NOT NULL
  ) STRICT
`;

export const FOUNDATION_GRANT_AUDIT_TABLE_SQL = `
  CREATE TABLE foundation_grant_audit (
    audit_id TEXT PRIMARY KEY,
    action TEXT NOT NULL CHECK (action IN ('grant-created', 'credential-revealed', 'credential-rotated', 'grant-expired', 'grant-disabled', 'grant-revoked', 'session-admitted', 'session-replaced')),
    outcome TEXT NOT NULL CHECK (outcome = 'accepted'),
    actor_reference TEXT NOT NULL,
    grant_id TEXT NOT NULL REFERENCES foundation_grant_roots(grant_id) ON DELETE CASCADE,
    grant_type TEXT NOT NULL CHECK (grant_type = 'control'),
    grant_version TEXT NOT NULL,
    event_id TEXT NOT NULL,
    game_day_id TEXT NOT NULL,
    pitch_id TEXT NOT NULL,
    pitch_slot_id TEXT NOT NULL,
    session_id TEXT,
    replaced_session_id TEXT,
    event_game_id TEXT,
    credential_kind TEXT CHECK (credential_kind IS NULL OR credential_kind = 'qr'),
    credential_fingerprint TEXT,
    before_status TEXT CHECK (before_status IS NULL OR before_status IN ('active', 'disabled', 'revoked', 'expired')),
    after_status TEXT CHECK (after_status IS NULL OR after_status IN ('active', 'disabled', 'revoked', 'expired')),
    created_at_ms INTEGER NOT NULL
  ) STRICT
`;

export const FOUNDATION_TYPED_GRANT_TABLE_SQL = FOUNDATION_GRANT_TABLE_SQL.replace(
  "CHECK (grant_type = 'control')",
  "CHECK (grant_type IN ('control', 'event-admin', 'pitch-manager'))",
);

export const FOUNDATION_TYPED_GRANT_AUDIT_TABLE_V1_SQL = FOUNDATION_GRANT_AUDIT_TABLE_SQL.replace(
  "CHECK (action IN ('grant-created', 'credential-revealed', 'credential-rotated', 'grant-expired', 'grant-disabled', 'grant-revoked', 'session-admitted', 'session-replaced'))",
  "CHECK (action IN ('grant-created', 'credential-revealed', 'credential-rotated', 'grant-expired', 'grant-disabled', 'grant-revoked', 'grant-reactivated', 'grant-metadata-updated', 'session-admitted', 'session-replaced', 'session-revoked'))",
).replace(
  "CHECK (grant_type = 'control')",
  "CHECK (grant_type IN ('control', 'event-admin', 'pitch-manager'))",
);

export const FOUNDATION_TYPED_GRANT_AUDIT_TABLE_V9_SQL =
  FOUNDATION_TYPED_GRANT_AUDIT_TABLE_V1_SQL.replace(
    "'session-revoked'))",
    "'session-revoked', 'session-terminated'))",
  );

export const FOUNDATION_TYPED_GRANT_AUDIT_TABLE_SQL =
  FOUNDATION_TYPED_GRANT_AUDIT_TABLE_V9_SQL.replace(
    "    created_at_ms INTEGER NOT NULL",
    "    before_expires_at_ms INTEGER,\n    after_expires_at_ms INTEGER,\n    terminal_reason TEXT CHECK (terminal_reason IS NULL OR terminal_reason IN ('game-locked', 'accepted-game-switch', 'past-game-day')),\n    created_at_ms INTEGER NOT NULL",
  );

export const FOUNDATION_TYPED_GRANT_AUDIT_TABLE_V11_SQL =
  FOUNDATION_TYPED_GRANT_AUDIT_TABLE_SQL.replace(
    "    created_at_ms INTEGER NOT NULL",
    "    audit_integrity_tag TEXT NOT NULL CHECK (audit_integrity_tag = 'legacy-migration-v1' OR audit_integrity_tag GLOB 'hmac-sha256-v1:*'),\n    created_at_ms INTEGER NOT NULL",
  );

export const FOUNDATION_TYPED_GRANT_SESSION_TABLE_SQL = FOUNDATION_GRANT_SESSION_TABLE_SQL.replace(
  "    revoked_at_ms INTEGER,",
  "    revoked_at_ms INTEGER,\n    device_class TEXT NOT NULL,\n    browser_class TEXT NOT NULL,",
);

export const FOUNDATION_GRANT_SESSION_GRANT_INDEX_SQL = `
  CREATE INDEX foundation_grant_sessions_grant_id
    ON foundation_grant_sessions (grant_id)
`;

export const FOUNDATION_GRANT_SESSION_CONTEXT_INDEX_SQL = `
  CREATE UNIQUE INDEX foundation_grant_sessions_active_context
    ON foundation_grant_sessions (grant_id, browser_context_digest)
    WHERE status = 'active'
`;

export const FOUNDATION_GRANT_AUDIT_GRANT_INDEX_SQL = `
  CREATE INDEX foundation_grant_audit_grant_id
    ON foundation_grant_audit (grant_id, audit_id)
`;

export const FOUNDATION_GRANT_MIGRATION_PROVENANCE_TABLE_SQL = `
  CREATE TABLE foundation_grant_migration_provenance (
    grant_id TEXT PRIMARY KEY REFERENCES foundation_grant_roots(grant_id) ON DELETE RESTRICT,
    migration_id TEXT NOT NULL CHECK (migration_id = '006-grant-cryptographic-erasure'),
    original_status TEXT NOT NULL CHECK (original_status IN ('active', 'disabled', 'revoked', 'expired')),
    original_grant_version TEXT NOT NULL,
    original_event_id TEXT NOT NULL,
    original_game_day_id TEXT NOT NULL,
    original_pitch_id TEXT NOT NULL,
    original_pitch_slot_id TEXT NOT NULL,
    original_created_at_ms INTEGER NOT NULL,
    original_expires_at_ms INTEGER,
    retained_opaque_reference TEXT NOT NULL UNIQUE
      CHECK (retained_opaque_reference GLOB 'opaque-migration-reference-v1:*')
  ) STRICT
`;

export const FOUNDATION_GRANT_MIGRATION_PROVENANCE_STATE_TABLE_SQL = `
  CREATE TABLE foundation_grant_migration_provenance_state (
    state_id INTEGER PRIMARY KEY CHECK (state_id = 1),
    migration_id TEXT NOT NULL CHECK (migration_id = '014-grant-provenance-integrity')
  ) STRICT
`;

export const FOUNDATION_GRANT_AUDIT_PROVENANCE_TABLE_SQL = `
  CREATE TABLE foundation_grant_audit_provenance (
    audit_id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    outcome TEXT NOT NULL,
    actor_reference TEXT NOT NULL,
    grant_id TEXT NOT NULL REFERENCES foundation_grant_roots(grant_id) ON DELETE RESTRICT,
    grant_type TEXT NOT NULL,
    grant_version TEXT NOT NULL,
    event_id TEXT NOT NULL,
    game_day_id TEXT NOT NULL,
    pitch_id TEXT NOT NULL,
    pitch_slot_id TEXT NOT NULL,
    session_id TEXT,
    replaced_session_id TEXT,
    event_game_id TEXT,
    credential_kind TEXT,
    credential_fingerprint TEXT,
    before_status TEXT,
    after_status TEXT,
    before_expires_at_ms INTEGER,
    after_expires_at_ms INTEGER,
    terminal_reason TEXT,
    audit_integrity_tag TEXT NOT NULL CHECK (audit_integrity_tag = 'legacy-migration-v1' OR audit_integrity_tag GLOB 'hmac-sha256-v1:*'),
    created_at_ms INTEGER NOT NULL
  ) STRICT
`;

export const FOUNDATION_GRANT_AUDIT_PROVENANCE_GRANT_INDEX_SQL = `
  CREATE INDEX foundation_grant_audit_provenance_grant_id
    ON foundation_grant_audit_provenance (grant_id, audit_id)
`;

export const FOUNDATION_GRANT_MIGRATION_PROVENANCE_NO_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER foundation_grant_migration_provenance_no_update
    BEFORE UPDATE ON foundation_grant_migration_provenance
    BEGIN SELECT RAISE(ABORT, 'Grant migration provenance is immutable.'); END
`;
export const FOUNDATION_GRANT_MIGRATION_PROVENANCE_NO_INSERT_TRIGGER_SQL = `
  CREATE TRIGGER foundation_grant_migration_provenance_no_insert
    BEFORE INSERT ON foundation_grant_migration_provenance
    BEGIN SELECT RAISE(ABORT, 'Grant migration provenance is migration-owned.'); END
`;
export const FOUNDATION_GRANT_MIGRATION_PROVENANCE_NO_DELETE_TRIGGER_SQL = `
  CREATE TRIGGER foundation_grant_migration_provenance_no_delete
    BEFORE DELETE ON foundation_grant_migration_provenance
    BEGIN SELECT RAISE(ABORT, 'Grant migration provenance is immutable.'); END
`;
export const FOUNDATION_GRANT_MIGRATION_PROVENANCE_STATE_NO_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER foundation_grant_migration_provenance_state_no_update
    BEFORE UPDATE ON foundation_grant_migration_provenance_state
    BEGIN SELECT RAISE(ABORT, 'Grant migration provenance state is immutable.'); END
`;
export const FOUNDATION_GRANT_MIGRATION_PROVENANCE_STATE_NO_INSERT_TRIGGER_SQL = `
  CREATE TRIGGER foundation_grant_migration_provenance_state_no_insert
    BEFORE INSERT ON foundation_grant_migration_provenance_state
    BEGIN SELECT RAISE(ABORT, 'Grant migration provenance state is migration-owned.'); END
`;
export const FOUNDATION_GRANT_MIGRATION_PROVENANCE_STATE_NO_DELETE_TRIGGER_SQL = `
  CREATE TRIGGER foundation_grant_migration_provenance_state_no_delete
    BEFORE DELETE ON foundation_grant_migration_provenance_state
    BEGIN SELECT RAISE(ABORT, 'Grant migration provenance state is immutable.'); END
`;
export const FOUNDATION_GRANT_AUDIT_PROVENANCE_NO_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER foundation_grant_audit_provenance_no_update
    BEFORE UPDATE ON foundation_grant_audit_provenance
    BEGIN SELECT RAISE(ABORT, 'Grant audit provenance is immutable.'); END
`;
export const FOUNDATION_GRANT_AUDIT_PROVENANCE_NO_DELETE_TRIGGER_SQL = `
  CREATE TRIGGER foundation_grant_audit_provenance_no_delete
    BEFORE DELETE ON foundation_grant_audit_provenance
    BEGIN SELECT RAISE(ABORT, 'Grant audit provenance is immutable.'); END
`;
export const FOUNDATION_GRANT_AUDIT_PROVENANCE_AFTER_INSERT_TRIGGER_SQL = `
  CREATE TRIGGER foundation_grant_audit_provenance_after_insert
    AFTER INSERT ON foundation_grant_audit
    BEGIN
      INSERT INTO foundation_grant_audit_provenance (
        audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
        event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
        event_game_id, credential_kind, credential_fingerprint, before_status, after_status,
        before_expires_at_ms, after_expires_at_ms, terminal_reason, audit_integrity_tag, created_at_ms
      ) VALUES (
        NEW.audit_id, NEW.action, NEW.outcome, NEW.actor_reference, NEW.grant_id, NEW.grant_type,
        NEW.grant_version, NEW.event_id, NEW.game_day_id, NEW.pitch_id, NEW.pitch_slot_id,
        NEW.session_id, NEW.replaced_session_id, NEW.event_game_id, NEW.credential_kind,
        NEW.credential_fingerprint, NEW.before_status, NEW.after_status,
        NEW.before_expires_at_ms, NEW.after_expires_at_ms, NEW.terminal_reason, NEW.audit_integrity_tag,
        NEW.created_at_ms
      );
    END
`;
export const FOUNDATION_GRANT_AUDIT_NO_LEGACY_TAG_INSERT_TRIGGER_SQL = `
  CREATE TRIGGER foundation_grant_audit_no_legacy_integrity_tag
    BEFORE INSERT ON foundation_grant_audit
    WHEN NEW.audit_integrity_tag = 'legacy-migration-v1'
    BEGIN SELECT RAISE(ABORT, 'Legacy Grant Audit integrity tags are migration-owned.'); END
`;

export const FOUNDATION_GRANT_PROVENANCE_IMMUTABILITY_SQL = `
  ${FOUNDATION_GRANT_MIGRATION_PROVENANCE_NO_UPDATE_TRIGGER_SQL};
  ${FOUNDATION_GRANT_MIGRATION_PROVENANCE_NO_INSERT_TRIGGER_SQL};
  ${FOUNDATION_GRANT_MIGRATION_PROVENANCE_NO_DELETE_TRIGGER_SQL};
  ${FOUNDATION_GRANT_MIGRATION_PROVENANCE_STATE_NO_UPDATE_TRIGGER_SQL};
  ${FOUNDATION_GRANT_MIGRATION_PROVENANCE_STATE_NO_INSERT_TRIGGER_SQL};
  ${FOUNDATION_GRANT_MIGRATION_PROVENANCE_STATE_NO_DELETE_TRIGGER_SQL};
  ${FOUNDATION_GRANT_AUDIT_PROVENANCE_NO_UPDATE_TRIGGER_SQL};
  ${FOUNDATION_GRANT_AUDIT_PROVENANCE_NO_DELETE_TRIGGER_SQL};
  ${FOUNDATION_GRANT_AUDIT_NO_LEGACY_TAG_INSERT_TRIGGER_SQL};
  ${FOUNDATION_GRANT_AUDIT_PROVENANCE_AFTER_INSERT_TRIGGER_SQL};
`;

export const FOUNDATION_GRANT_PROVENANCE_MIGRATION_SQL = `
  -- One-time compatibility trust transition: schema-006 completed before keyed
  -- provenance existed, so its derivable root and audit relationships are
  -- recorded here. Keyed integrity is authoritative for all later writes.
  CREATE TABLE foundation_grant_audit_integrity_copy AS SELECT * FROM foundation_grant_audit;
  DROP TABLE foundation_grant_audit;
  ${FOUNDATION_TYPED_GRANT_AUDIT_TABLE_V11_SQL};
  INSERT INTO foundation_grant_audit (
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, credential_kind, credential_fingerprint, before_status, after_status,
    before_expires_at_ms, after_expires_at_ms, terminal_reason, audit_integrity_tag, created_at_ms
  )
  SELECT
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, credential_kind, credential_fingerprint, before_status, after_status,
    before_expires_at_ms, after_expires_at_ms, terminal_reason, 'legacy-migration-v1', created_at_ms
  FROM foundation_grant_audit_integrity_copy;
  DROP TABLE foundation_grant_audit_integrity_copy;
  ${FOUNDATION_GRANT_AUDIT_GRANT_INDEX_SQL};
  ${FOUNDATION_GRANT_MIGRATION_PROVENANCE_TABLE_SQL};
  ${FOUNDATION_GRANT_MIGRATION_PROVENANCE_STATE_TABLE_SQL};
  ${FOUNDATION_GRANT_AUDIT_PROVENANCE_TABLE_SQL};
  INSERT INTO foundation_grant_migration_provenance (
    grant_id, migration_id, original_status, original_grant_version, original_event_id,
    original_game_day_id, original_pitch_id, original_pitch_slot_id, original_created_at_ms,
    original_expires_at_ms, retained_opaque_reference
  )
  SELECT
    grant_id, '006-grant-cryptographic-erasure', status, grant_version, event_id,
    game_day_id, pitch_id, pitch_slot_id, created_at_ms, expires_at_ms, credential_fingerprint
  FROM foundation_grant_roots
  WHERE credential_fingerprint GLOB 'opaque-migration-reference-v1:*';
  INSERT INTO foundation_grant_migration_provenance_state (state_id, migration_id)
    VALUES (1, '014-grant-provenance-integrity');
  INSERT INTO foundation_grant_audit_provenance (
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, credential_kind, credential_fingerprint, before_status, after_status,
    before_expires_at_ms, after_expires_at_ms, terminal_reason, audit_integrity_tag, created_at_ms
  )
  SELECT
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, credential_kind, credential_fingerprint, before_status, after_status,
    before_expires_at_ms, after_expires_at_ms, terminal_reason, audit_integrity_tag, created_at_ms
  FROM foundation_grant_audit;
  ${FOUNDATION_GRANT_AUDIT_PROVENANCE_GRANT_INDEX_SQL};
  ${FOUNDATION_GRANT_PROVENANCE_IMMUTABILITY_SQL};
  DROP TABLE IF EXISTS foundation_grant_migration_provenance_legacy;
  DROP TABLE IF EXISTS foundation_grant_migration_provenance_state_legacy
`;

const FOUNDATION_INITIAL_ROOT_MIGRATION_SQL = `
      CREATE TABLE foundation_event_game_record_roots (
        record_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        event_game_id TEXT NOT NULL UNIQUE,
        owner_event_id TEXT NOT NULL,
        owner_event_game_id TEXT NOT NULL,
        scope_event_id TEXT NOT NULL,
        game_day_id TEXT NOT NULL,
        pitch_id TEXT NOT NULL,
        pitch_slot_id TEXT NOT NULL UNIQUE,
        side_a_id TEXT NOT NULL UNIQUE,
        side_a_event_team_id TEXT NOT NULL,
        side_a_team_interpretation_ref TEXT NOT NULL,
        side_b_id TEXT NOT NULL UNIQUE,
        side_b_event_team_id TEXT NOT NULL,
        side_b_team_interpretation_ref TEXT NOT NULL,
        lifecycle_phase TEXT NOT NULL CHECK (lifecycle_phase IN ('scheduled', 'in-progress', 'suspended', 'finished')),
        commenced_at_ms INTEGER,
        finished_at_ms INTEGER,
        locked_at_ms INTEGER,
        lock_reason TEXT CHECK (lock_reason IS NULL OR lock_reason IN ('finished-inactivity', 'administrative')),
        record_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        interpreter_version TEXT NOT NULL,
        creation_operation_id TEXT NOT NULL,
        creation_actor_reference TEXT NOT NULL,
        creation_source TEXT NOT NULL CHECK (creation_source = 'event-game-registration'),
        creation_created_at_ms INTEGER NOT NULL,
        canonical_content TEXT NOT NULL,
        root_json TEXT NOT NULL CHECK (json_valid(root_json)),
        CHECK (owner_event_id = event_id),
        CHECK (owner_event_game_id = event_game_id),
        CHECK (scope_event_id = event_id),
        CHECK (finished_at_ms IS NULL OR commenced_at_ms IS NOT NULL),
        CHECK (locked_at_ms IS NULL OR finished_at_ms IS NOT NULL),
        CHECK (locked_at_ms IS NULL OR lock_reason IS NOT NULL)
      ) STRICT;

      CREATE INDEX foundation_event_game_record_roots_event_id
        ON foundation_event_game_record_roots (event_id);
      CREATE INDEX foundation_event_game_record_roots_game_day_id
        ON foundation_event_game_record_roots (scope_event_id, game_day_id);
    `;

const FOUNDATION_NORMALIZE_ROOTS_MIGRATION_SQL = `
  CREATE TABLE foundation_event_game_record_roots_v2 (
    record_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    event_game_id TEXT NOT NULL UNIQUE,
    owner_event_id TEXT NOT NULL,
    owner_event_game_id TEXT NOT NULL,
    scope_event_id TEXT NOT NULL,
    game_day_id TEXT NOT NULL,
    pitch_id TEXT NOT NULL,
    pitch_slot_id TEXT NOT NULL UNIQUE,
    lifecycle_phase TEXT NOT NULL CHECK (lifecycle_phase IN ('scheduled', 'in-progress', 'suspended', 'finished')),
    commenced_at_ms INTEGER,
    finished_at_ms INTEGER,
    locked_at_ms INTEGER,
    lock_reason TEXT CHECK (lock_reason IS NULL OR lock_reason IN ('finished-inactivity', 'administrative')),
    record_version TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    interpreter_version TEXT NOT NULL,
    creation_operation_id TEXT NOT NULL,
    creation_actor_reference TEXT NOT NULL,
    creation_source TEXT NOT NULL CHECK (creation_source = 'event-game-registration'),
    creation_created_at_ms INTEGER NOT NULL,
    canonical_content TEXT NOT NULL,
    root_json TEXT NOT NULL CHECK (json_valid(root_json)),
    CHECK (owner_event_id = event_id),
    CHECK (owner_event_game_id = event_game_id),
    CHECK (scope_event_id = event_id),
    CHECK (finished_at_ms IS NULL OR commenced_at_ms IS NOT NULL),
    CHECK (locked_at_ms IS NULL OR finished_at_ms IS NOT NULL),
    CHECK ((locked_at_ms IS NULL) = (lock_reason IS NULL))
  ) STRICT;

  INSERT INTO foundation_event_game_record_roots_v2 (
    record_id, event_id, event_game_id, owner_event_id, owner_event_game_id,
    scope_event_id, game_day_id, pitch_id, pitch_slot_id,
    lifecycle_phase, commenced_at_ms, finished_at_ms, locked_at_ms, lock_reason,
    record_version, schema_version, interpreter_version,
    creation_operation_id, creation_actor_reference, creation_source,
    creation_created_at_ms, canonical_content, root_json
  )
  SELECT
    record_id, event_id, event_game_id, owner_event_id, owner_event_game_id,
    scope_event_id, game_day_id, pitch_id, pitch_slot_id,
    lifecycle_phase, commenced_at_ms, finished_at_ms, locked_at_ms, lock_reason,
    record_version, schema_version, interpreter_version,
    creation_operation_id, creation_actor_reference, creation_source,
    creation_created_at_ms, canonical_content, root_json
  FROM foundation_event_game_record_roots;

  CREATE TABLE foundation_event_game_record_sides_v2 (
    side_id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL REFERENCES foundation_event_game_record_roots_v2(record_id) ON DELETE CASCADE,
    side_position TEXT NOT NULL CHECK (side_position IN ('a', 'b')),
    event_team_id TEXT NOT NULL,
    team_interpretation_ref TEXT NOT NULL,
    UNIQUE (record_id, side_position),
    UNIQUE (record_id, event_team_id)
  ) STRICT;

  INSERT INTO foundation_event_game_record_sides_v2 (
    side_id, record_id, side_position, event_team_id, team_interpretation_ref
  )
  SELECT side_a_id, record_id, 'a', side_a_event_team_id, side_a_team_interpretation_ref
  FROM foundation_event_game_record_roots
  UNION ALL
  SELECT side_b_id, record_id, 'b', side_b_event_team_id, side_b_team_interpretation_ref
  FROM foundation_event_game_record_roots;

  DROP TABLE foundation_event_game_record_roots;
  ALTER TABLE foundation_event_game_record_roots_v2 RENAME TO foundation_event_game_record_roots;
  ALTER TABLE foundation_event_game_record_sides_v2 RENAME TO foundation_event_game_record_sides;

  CREATE INDEX foundation_event_game_record_roots_event_id
    ON foundation_event_game_record_roots (event_id);
  CREATE INDEX foundation_event_game_record_roots_game_day_id
    ON foundation_event_game_record_roots (scope_event_id, game_day_id);
  CREATE INDEX foundation_event_game_record_sides_record_id
    ON foundation_event_game_record_sides (record_id);
`;

const FOUNDATION_ACTIONS_MIGRATION_SQL = `
  ${FOUNDATION_ACTION_TABLE_SQL};
  ${FOUNDATION_IDEMPOTENCY_TABLE_SQL};
  ${FOUNDATION_METADATA_TABLE_SQL};
  ${FOUNDATION_AUDIT_TABLE_SQL};
  INSERT INTO foundation_event_game_record_metadata (
    record_id, action_count, ordering_version, last_accepted_at_ms, updated_at_ms
  )
  SELECT record_id, 0, 'causal-occurrence-operation-v1', NULL, creation_created_at_ms
  FROM foundation_event_game_record_roots;
  ${FOUNDATION_ACTION_RECORD_INDEX_SQL};
  ${FOUNDATION_IDEMPOTENCY_RECORD_INDEX_SQL};
  ${FOUNDATION_AUDIT_RECORD_INDEX_SQL};
`;

const FOUNDATION_GRANT_MIGRATION_SQL = `
  ${FOUNDATION_GRANT_TABLE_V4_SQL};
  ${FOUNDATION_GRANT_SESSION_TABLE_V4_SQL};
  ${FOUNDATION_GRANT_AUDIT_TABLE_V4_SQL};
  ${FOUNDATION_GRANT_SESSION_GRANT_INDEX_SQL};
  ${FOUNDATION_GRANT_SESSION_CONTEXT_INDEX_SQL};
  ${FOUNDATION_GRANT_AUDIT_GRANT_INDEX_SQL};
`;

const FOUNDATION_GRANT_EXPIRY_MIGRATION_SQL = `
  ${FOUNDATION_GRANT_AUDIT_TABLE_V5_SQL.replace(
    "CREATE TABLE foundation_grant_audit",
    "CREATE TABLE foundation_grant_audit_v4",
  )};
  INSERT INTO foundation_grant_audit_v4 (
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, credential_kind, credential_fingerprint, before_status, after_status,
    created_at_ms
  )
  SELECT
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, credential_kind, credential_fingerprint, before_status, after_status,
    created_at_ms
  FROM foundation_grant_audit;
  DROP TABLE foundation_grant_audit;
  ALTER TABLE foundation_grant_audit_v4 RENAME TO foundation_grant_audit;
  ${FOUNDATION_GRANT_AUDIT_GRANT_INDEX_SQL};
`;

const FOUNDATION_GRANT_ERASURE_MIGRATION_SQL = createFoundationGrantErasureMigrationSql({
  grantTableSql: FOUNDATION_GRANT_TABLE_SQL,
  sessionTableSql: FOUNDATION_GRANT_SESSION_TABLE_SQL,
  auditTableSql: FOUNDATION_GRANT_AUDIT_TABLE_SQL,
  sessionGrantIndexSql: FOUNDATION_GRANT_SESSION_GRANT_INDEX_SQL,
  sessionContextIndexSql: FOUNDATION_GRANT_SESSION_CONTEXT_INDEX_SQL,
  auditGrantIndexSql: FOUNDATION_GRANT_AUDIT_GRANT_INDEX_SQL,
});

const FOUNDATION_CONTROL_VERSION_PROJECTION_MIGRATION_SQL = `
  ALTER TABLE foundation_event_game_record_actions
    ADD COLUMN control_action_version TEXT NOT NULL DEFAULT 'control-action-legacy-v0'
      CHECK (control_action_version IN ('control-action-v1', 'control-action-legacy-v0'));
  ALTER TABLE foundation_event_game_record_audit
    ADD COLUMN audit_version TEXT NOT NULL DEFAULT 'control-audit-legacy-v0'
      CHECK (audit_version IN ('control-audit-v1', 'control-audit-legacy-v0'));
`;

const FOUNDATION_EVIDENCE_FORMAT_MIGRATION_SQL = `
  ALTER TABLE foundation_event_game_record_actions
    ADD COLUMN action_evidence_format TEXT NOT NULL DEFAULT 'legacy'
      CHECK (action_evidence_format IN ('current', 'legacy'));
  ALTER TABLE foundation_event_game_record_audit
    ADD COLUMN audit_evidence_format TEXT NOT NULL DEFAULT 'legacy'
      CHECK (audit_evidence_format IN ('current', 'legacy'));
  UPDATE foundation_event_game_record_actions
    SET action_evidence_format = 'current'
    WHERE control_action_version = 'control-action-v1';
  UPDATE foundation_event_game_record_audit
    SET audit_evidence_format = 'current'
    WHERE audit_version = 'control-audit-v1';
`;

export const FOUNDATION_EVIDENCE_PROVENANCE_TABLE_SQL = `
  CREATE TABLE foundation_control_evidence_provenance (
    evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('action', 'audit')),
    evidence_id TEXT NOT NULL,
    evidence_format TEXT NOT NULL CHECK (evidence_format IN ('current', 'legacy')),
    origin TEXT NOT NULL CHECK (origin IN ('pre-75-migration', 'post-75-current')),
    PRIMARY KEY (evidence_kind, evidence_id)
  ) STRICT
`;

export const FOUNDATION_EVIDENCE_PROVENANCE_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER foundation_control_evidence_provenance_no_update
  BEFORE UPDATE ON foundation_control_evidence_provenance
  BEGIN
    SELECT RAISE(ABORT, 'Control evidence provenance is immutable');
  END
`;

export const FOUNDATION_EVIDENCE_PROVENANCE_DELETE_TRIGGER_SQL = `
  CREATE TRIGGER foundation_control_evidence_provenance_no_delete
  BEFORE DELETE ON foundation_control_evidence_provenance
  BEGIN
    SELECT RAISE(ABORT, 'Control evidence provenance is immutable');
  END
`;

const FOUNDATION_EVIDENCE_PROVENANCE_MIGRATION_SQL = `
  ${FOUNDATION_EVIDENCE_PROVENANCE_TABLE_SQL};
  INSERT INTO foundation_control_evidence_provenance (evidence_kind, evidence_id, evidence_format, origin)
  SELECT 'action', action_id,
         CASE WHEN control_action_version = 'control-action-v1' THEN 'current' ELSE 'legacy' END,
         CASE WHEN control_action_version = 'control-action-v1' THEN 'post-75-current' ELSE 'pre-75-migration' END
  FROM foundation_event_game_record_actions;
  INSERT INTO foundation_control_evidence_provenance (evidence_kind, evidence_id, evidence_format, origin)
  SELECT 'audit', audit_id,
         CASE WHEN audit_version = 'control-audit-v1' THEN 'current' ELSE 'legacy' END,
         CASE WHEN audit_version = 'control-audit-v1' THEN 'post-75-current' ELSE 'pre-75-migration' END
  FROM foundation_event_game_record_audit;
  ${FOUNDATION_EVIDENCE_PROVENANCE_UPDATE_TRIGGER_SQL};
  ${FOUNDATION_EVIDENCE_PROVENANCE_DELETE_TRIGGER_SQL};
`;

const FOUNDATION_TYPED_GRANT_MIGRATION_SQL = `
  CREATE TABLE foundation_grant_sessions_typed_copy AS SELECT * FROM foundation_grant_sessions;
  CREATE TABLE foundation_grant_audit_typed_copy AS SELECT * FROM foundation_grant_audit;
  DROP TABLE foundation_grant_sessions;
  DROP TABLE foundation_grant_audit;
  ${FOUNDATION_TYPED_GRANT_TABLE_SQL.replace(
    "CREATE TABLE foundation_grant_roots",
    "CREATE TABLE foundation_grant_roots_typed",
  )};
  INSERT INTO foundation_grant_roots_typed SELECT * FROM foundation_grant_roots;
  DROP TABLE foundation_grant_roots;
  ALTER TABLE foundation_grant_roots_typed RENAME TO foundation_grant_roots;
  ${FOUNDATION_GRANT_SESSION_TABLE_SQL};
  INSERT INTO foundation_grant_sessions SELECT * FROM foundation_grant_sessions_typed_copy;
  DROP TABLE foundation_grant_sessions_typed_copy;
  ${FOUNDATION_GRANT_SESSION_GRANT_INDEX_SQL};
  ${FOUNDATION_GRANT_SESSION_CONTEXT_INDEX_SQL};
  ${FOUNDATION_TYPED_GRANT_AUDIT_TABLE_V1_SQL};
  INSERT INTO foundation_grant_audit SELECT * FROM foundation_grant_audit_typed_copy;
  DROP TABLE foundation_grant_audit_typed_copy;
  ${FOUNDATION_GRANT_AUDIT_GRANT_INDEX_SQL};
`;

const FOUNDATION_TYPED_GRANT_SESSION_SUMMARY_MIGRATION_SQL = `
  CREATE TABLE foundation_grant_sessions_summary_copy AS
    SELECT *, 'unknown' AS device_class, 'unknown' AS browser_class
    FROM foundation_grant_sessions;
  DROP TABLE foundation_grant_sessions;
  ${FOUNDATION_TYPED_GRANT_SESSION_TABLE_SQL};
  INSERT INTO foundation_grant_sessions (
    session_id, grant_id, grant_version, event_game_id, browser_context_digest,
    browser_context_key_version, bearer_material_state, bearer_lookup_verifier,
    bearer_lookup_key_version, status, created_at_ms, last_active_at_ms, revoked_at_ms,
    device_class, browser_class
  )
  SELECT
    session_id, grant_id, grant_version, event_game_id, browser_context_digest,
    browser_context_key_version, bearer_material_state, bearer_lookup_verifier,
    bearer_lookup_key_version, status, created_at_ms, last_active_at_ms, revoked_at_ms,
    device_class, browser_class
  FROM foundation_grant_sessions_summary_copy;
  DROP TABLE foundation_grant_sessions_summary_copy;
  ${FOUNDATION_GRANT_SESSION_GRANT_INDEX_SQL};
  ${FOUNDATION_GRANT_SESSION_CONTEXT_INDEX_SQL};
`;

const FOUNDATION_TYPED_GRANT_TERMINAL_AUDIT_MIGRATION_SQL = `
  CREATE TABLE foundation_grant_audit_terminal_copy AS SELECT * FROM foundation_grant_audit;
  DROP TABLE foundation_grant_audit;
  ${FOUNDATION_TYPED_GRANT_AUDIT_TABLE_V9_SQL};
  INSERT INTO foundation_grant_audit SELECT * FROM foundation_grant_audit_terminal_copy;
  DROP TABLE foundation_grant_audit_terminal_copy;
  ${FOUNDATION_GRANT_AUDIT_GRANT_INDEX_SQL};
`;

const FOUNDATION_TYPED_GRANT_AUDIT_EVIDENCE_MIGRATION_SQL = `
  CREATE TABLE foundation_grant_audit_evidence_copy AS SELECT * FROM foundation_grant_audit;
  DROP TABLE foundation_grant_audit;
  ${FOUNDATION_TYPED_GRANT_AUDIT_TABLE_SQL};
  INSERT INTO foundation_grant_audit (
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, credential_kind, credential_fingerprint, before_status, after_status,
    before_expires_at_ms, after_expires_at_ms, terminal_reason, created_at_ms
  )
  SELECT
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, credential_kind, credential_fingerprint, before_status, after_status,
    NULL, NULL, NULL, created_at_ms
  FROM foundation_grant_audit_evidence_copy;
  DROP TABLE foundation_grant_audit_evidence_copy;
  ${FOUNDATION_GRANT_AUDIT_GRANT_INDEX_SQL};
`;

export const FOUNDATION_MIGRATIONS: readonly FoundationMigration[] = Object.freeze([
  createMigration({
    id: "001-foundation-event-game-record-roots",
    ordinal: 1,
    schemaVersion: 1,
    sql: FOUNDATION_INITIAL_ROOT_MIGRATION_SQL,
  }),
  createMigration({
    id: "002-normalize-event-game-record-sides",
    ordinal: 2,
    schemaVersion: 2,
    sql: FOUNDATION_NORMALIZE_ROOTS_MIGRATION_SQL,
  }),
  createMigration({
    id: "003-persist-event-game-actions",
    ordinal: 3,
    schemaVersion: 3,
    sql: FOUNDATION_ACTIONS_MIGRATION_SQL,
  }),
  createMigration({
    id: "004-foundation-control-grants",
    ordinal: 4,
    schemaVersion: 4,
    sql: FOUNDATION_GRANT_MIGRATION_SQL,
  }),
  createMigration({
    id: "005-grant-expiry-lifecycle",
    ordinal: 5,
    schemaVersion: 5,
    sql: FOUNDATION_GRANT_EXPIRY_MIGRATION_SQL,
  }),
  createMigration({
    id: "006-grant-cryptographic-erasure",
    ordinal: 6,
    schemaVersion: 6,
    sql: FOUNDATION_GRANT_ERASURE_MIGRATION_SQL,
  }),
  createMigration({
    id: "007-anchor-control-action-audit-versions",
    ordinal: 7,
    schemaVersion: 7,
    sql: FOUNDATION_CONTROL_VERSION_PROJECTION_MIGRATION_SQL,
  }),
  createMigration({
    id: "008-anchor-current-evidence-format",
    ordinal: 8,
    schemaVersion: 8,
    sql: FOUNDATION_EVIDENCE_FORMAT_MIGRATION_SQL,
  }),
  createMigration({
    id: "009-immutable-control-evidence-provenance",
    ordinal: 9,
    schemaVersion: 9,
    sql: FOUNDATION_EVIDENCE_PROVENANCE_MIGRATION_SQL,
  }),
  createMigration({
    id: "010-typed-grant-storage",
    ordinal: 10,
    schemaVersion: 10,
    sql: FOUNDATION_TYPED_GRANT_MIGRATION_SQL,
  }),
  createMigration({
    id: "011-persist-session-summary-labels",
    ordinal: 11,
    schemaVersion: 11,
    sql: FOUNDATION_TYPED_GRANT_SESSION_SUMMARY_MIGRATION_SQL,
  }),
  createMigration({
    id: "012-terminal-grant-session-audit",
    ordinal: 12,
    schemaVersion: 12,
    sql: FOUNDATION_TYPED_GRANT_TERMINAL_AUDIT_MIGRATION_SQL,
  }),
  createMigration({
    id: "013-grant-audit-evidence-fields",
    ordinal: 13,
    schemaVersion: 13,
    sql: FOUNDATION_TYPED_GRANT_AUDIT_EVIDENCE_MIGRATION_SQL,
  }),
  createMigration({
    id: "014-grant-provenance-integrity",
    ordinal: 14,
    schemaVersion: 14,
    sql: FOUNDATION_GRANT_PROVENANCE_MIGRATION_SQL,
  }),
]);

export const FOUNDATION_MIGRATION_LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS ${FOUNDATION_MIGRATION_LEDGER_TABLE} (
    migration_id TEXT PRIMARY KEY,
    ordinal INTEGER NOT NULL UNIQUE,
    schema_version INTEGER NOT NULL,
    checksum TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('complete', 'applying')),
    applied_at_ms INTEGER
  ) STRICT;
`;

export function checksumMigrationSql(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export function assessMigrationReadiness(
  ledgerExists: boolean,
  entries: readonly MigrationLedgerEntry[],
  migrations: readonly FoundationMigration[] = FOUNDATION_MIGRATIONS,
): MigrationReadiness {
  const expectedIds = migrations.map((migration) => migration.id);
  const appliedMigrationIds = entries.map((entry) => entry.id);
  const latestSchemaVersion = migrations.at(-1)?.schemaVersion ?? 0;
  const currentSchemaVersion = entries.reduce(
    (version, entry) => Math.max(version, entry.schemaVersion),
    0,
  );

  if (!ledgerExists) {
    return {
      status: "pending",
      detail: "The application-owned migration ledger has not been created.",
      schemaVersion: currentSchemaVersion,
      appliedMigrationIds,
    };
  }

  const expectedById = new Map(migrations.map((migration) => [migration.id, migration]));
  for (const entry of entries) {
    const expected = expectedById.get(entry.id);
    if (expected === undefined || entry.ordinal > migrations.length) {
      return {
        status: "future",
        detail: `Migration ${entry.id} is newer than this executable supports.`,
        schemaVersion: currentSchemaVersion,
        appliedMigrationIds,
      };
    }
    if (entry.status !== "complete") {
      return {
        status: "incomplete",
        detail: `Migration ${entry.id} is incomplete.`,
        schemaVersion: currentSchemaVersion,
        appliedMigrationIds,
      };
    }
    if (entry.checksum !== expected.checksum) {
      return {
        status: "changed-checksum",
        detail: `Migration ${entry.id} has a changed checksum.`,
        schemaVersion: currentSchemaVersion,
        appliedMigrationIds,
      };
    }
    if (entry.schemaVersion !== expected.schemaVersion || entry.ordinal !== expected.ordinal) {
      return {
        status: "reordered",
        detail: `Migration ${entry.id} has an incompatible order or schema version.`,
        schemaVersion: currentSchemaVersion,
        appliedMigrationIds,
      };
    }
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const expectedId = expectedIds[index];
    if (entry === undefined || expectedId === undefined) break;
    if (entry.id !== expectedId) {
      return {
        status: "reordered",
        detail: "Applied migrations are not an ordered prefix of the release migrations.",
        schemaVersion: currentSchemaVersion,
        appliedMigrationIds,
      };
    }
  }

  if (entries.length < migrations.length) {
    const missingMigration = migrations[entries.length];
    return {
      status: entries.length === 0 ? "pending" : "missing",
      detail:
        missingMigration === undefined
          ? "The migration ledger is missing a required migration."
          : `Migration ${missingMigration.id} has not been applied.`,
      schemaVersion: currentSchemaVersion,
      appliedMigrationIds,
    };
  }

  if (currentSchemaVersion > latestSchemaVersion) {
    return {
      status: "future",
      detail: "The database schema is newer than this executable supports.",
      schemaVersion: currentSchemaVersion,
      appliedMigrationIds,
    };
  }

  return {
    status: "ready",
    schemaVersion: currentSchemaVersion,
    appliedMigrationIds,
  };
}

function createMigration(migration: Omit<FoundationMigration, "checksum">): FoundationMigration {
  return {
    ...migration,
    checksum: checksumMigrationSql(migration.sql),
  };
}
