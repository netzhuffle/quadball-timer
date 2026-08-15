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

/** Schema-15 audit shape. Earlier migration SQL remains byte-stable. */
export const FOUNDATION_TYPED_GRANT_AUDIT_TABLE_V15_SQL =
  FOUNDATION_TYPED_GRANT_AUDIT_TABLE_V11_SQL.replace(
    "'session-terminated'))",
    "'session-terminated', 'session-switched', 'replay-authorized'))",
  ).replace(
    "    terminal_reason TEXT CHECK (terminal_reason IS NULL OR terminal_reason IN ('game-locked', 'accepted-game-switch', 'past-game-day'))",
    "    previous_event_game_id TEXT,\n    terminal_reason TEXT CHECK (terminal_reason IS NULL OR terminal_reason IN ('game-locked', 'accepted-game-switch', 'past-game-day'))",
  );

/** Schema-16 adds immutable content-bound replay provenance. */
export const FOUNDATION_TYPED_GRANT_AUDIT_TABLE_V16_SQL =
  FOUNDATION_TYPED_GRANT_AUDIT_TABLE_V15_SQL.replace(
    "    previous_event_game_id TEXT,",
    "    previous_event_game_id TEXT,\n    replay_evidence_id TEXT,",
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

export const FOUNDATION_GRANT_AUDIT_PROVENANCE_TABLE_V15_SQL =
  FOUNDATION_GRANT_AUDIT_PROVENANCE_TABLE_SQL.replace(
    "    terminal_reason TEXT,",
    "    previous_event_game_id TEXT,\n    terminal_reason TEXT,",
  );

export const FOUNDATION_GRANT_AUDIT_PROVENANCE_TABLE_V16_SQL =
  FOUNDATION_GRANT_AUDIT_PROVENANCE_TABLE_V15_SQL.replace(
    "    previous_event_game_id TEXT,",
    "    previous_event_game_id TEXT,\n    replay_evidence_id TEXT,",
  );

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

export const FOUNDATION_GRANT_AUDIT_PROVENANCE_AFTER_INSERT_TRIGGER_V15_SQL = `
  CREATE TRIGGER foundation_grant_audit_provenance_after_insert
    AFTER INSERT ON foundation_grant_audit
    BEGIN
      INSERT INTO foundation_grant_audit_provenance (
        audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
        event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
        event_game_id, previous_event_game_id, credential_kind, credential_fingerprint,
        before_status, after_status, before_expires_at_ms, after_expires_at_ms,
        terminal_reason, audit_integrity_tag, created_at_ms
      ) VALUES (
        NEW.audit_id, NEW.action, NEW.outcome, NEW.actor_reference, NEW.grant_id, NEW.grant_type,
        NEW.grant_version, NEW.event_id, NEW.game_day_id, NEW.pitch_id, NEW.pitch_slot_id,
        NEW.session_id, NEW.replaced_session_id, NEW.event_game_id, NEW.previous_event_game_id,
        NEW.credential_kind, NEW.credential_fingerprint, NEW.before_status, NEW.after_status,
        NEW.before_expires_at_ms, NEW.after_expires_at_ms, NEW.terminal_reason,
        NEW.audit_integrity_tag, NEW.created_at_ms
      );
    END
`;

export const FOUNDATION_GRANT_AUDIT_PROVENANCE_AFTER_INSERT_TRIGGER_V16_SQL =
  FOUNDATION_GRANT_AUDIT_PROVENANCE_AFTER_INSERT_TRIGGER_V15_SQL.replace(
    "event_game_id, previous_event_game_id, credential_kind",
    "event_game_id, previous_event_game_id, replay_evidence_id, credential_kind",
  ).replace(
    "NEW.event_game_id, NEW.previous_event_game_id,\n        NEW.credential_kind",
    "NEW.event_game_id, NEW.previous_event_game_id, NEW.replay_evidence_id,\n        NEW.credential_kind",
  );

export const FOUNDATION_GRANT_AUDIT_PROVENANCE_AFTER_INSERT_TRIGGER_V17_SQL = `
  CREATE TRIGGER foundation_grant_audit_provenance_after_insert
    AFTER INSERT ON foundation_grant_audit
    BEGIN
      INSERT INTO foundation_grant_audit_provenance (
        audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
        event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
        event_game_id, previous_event_game_id, replay_evidence_id, credential_kind,
        credential_fingerprint, before_status, after_status, before_expires_at_ms,
        after_expires_at_ms, terminal_reason, audit_sequence, predecessor_audit_id,
        code_state, previous_code_fingerprint, code_format_version,
        code_encryption_key_version, code_lookup_key_version, code_state_before,
        audit_integrity_tag, created_at_ms
      ) VALUES (
        NEW.audit_id, NEW.action, NEW.outcome, NEW.actor_reference, NEW.grant_id, NEW.grant_type,
        NEW.grant_version, NEW.event_id, NEW.game_day_id, NEW.pitch_id, NEW.pitch_slot_id,
        NEW.session_id, NEW.replaced_session_id, NEW.event_game_id, NEW.previous_event_game_id,
        NEW.replay_evidence_id, NEW.credential_kind, NEW.credential_fingerprint, NEW.before_status,
        NEW.after_status, NEW.before_expires_at_ms, NEW.after_expires_at_ms, NEW.terminal_reason,
        NEW.audit_sequence, NEW.predecessor_audit_id, NEW.code_state, NEW.previous_code_fingerprint,
        NEW.code_format_version, NEW.code_encryption_key_version, NEW.code_lookup_key_version,
        NEW.code_state_before, NEW.audit_integrity_tag, NEW.created_at_ms
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

const FOUNDATION_CONTROL_SESSION_BINDING_MIGRATION_SQL = `
  CREATE TABLE foundation_grant_audit_control_session_copy AS SELECT * FROM foundation_grant_audit;
  DROP TABLE foundation_grant_audit;
  ${FOUNDATION_TYPED_GRANT_AUDIT_TABLE_V15_SQL};
  INSERT INTO foundation_grant_audit (
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, previous_event_game_id, credential_kind, credential_fingerprint,
    before_status, after_status, before_expires_at_ms, after_expires_at_ms,
    terminal_reason, audit_integrity_tag, created_at_ms
  )
  SELECT
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, NULL, credential_kind, credential_fingerprint, before_status,
    after_status, before_expires_at_ms, after_expires_at_ms, terminal_reason,
    audit_integrity_tag, created_at_ms
  FROM foundation_grant_audit_control_session_copy;
  DROP TABLE foundation_grant_audit_control_session_copy;
  CREATE TABLE foundation_grant_audit_provenance_control_session_copy AS
    SELECT * FROM foundation_grant_audit_provenance;
  DROP TABLE foundation_grant_audit_provenance;
  ${FOUNDATION_GRANT_AUDIT_PROVENANCE_TABLE_V15_SQL};
  INSERT INTO foundation_grant_audit_provenance (
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, previous_event_game_id, credential_kind, credential_fingerprint,
    before_status, after_status, before_expires_at_ms, after_expires_at_ms,
    terminal_reason, audit_integrity_tag, created_at_ms
  )
  SELECT
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, NULL, credential_kind, credential_fingerprint, before_status,
    after_status, before_expires_at_ms, after_expires_at_ms, terminal_reason,
    audit_integrity_tag, created_at_ms
  FROM foundation_grant_audit_provenance_control_session_copy;
  DROP TABLE foundation_grant_audit_provenance_control_session_copy;
  ${FOUNDATION_GRANT_AUDIT_PROVENANCE_GRANT_INDEX_SQL};
  ${FOUNDATION_GRANT_AUDIT_PROVENANCE_NO_UPDATE_TRIGGER_SQL};
  ${FOUNDATION_GRANT_AUDIT_PROVENANCE_NO_DELETE_TRIGGER_SQL};
  ${FOUNDATION_GRANT_AUDIT_GRANT_INDEX_SQL};
  ${FOUNDATION_GRANT_AUDIT_NO_LEGACY_TAG_INSERT_TRIGGER_SQL};
  ${FOUNDATION_GRANT_AUDIT_PROVENANCE_AFTER_INSERT_TRIGGER_V15_SQL};
`;

const FOUNDATION_REPLAY_PROVENANCE_MIGRATION_SQL = `
  CREATE TABLE foundation_grant_audit_replay_provenance_copy AS SELECT * FROM foundation_grant_audit;
  DROP TABLE foundation_grant_audit;
  ${FOUNDATION_TYPED_GRANT_AUDIT_TABLE_V16_SQL};
  INSERT INTO foundation_grant_audit (
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, previous_event_game_id, replay_evidence_id, credential_kind,
    credential_fingerprint, before_status, after_status, before_expires_at_ms,
    after_expires_at_ms, terminal_reason, audit_integrity_tag, created_at_ms
  )
  SELECT
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, previous_event_game_id, NULL, credential_kind, credential_fingerprint,
    before_status, after_status, before_expires_at_ms, after_expires_at_ms, terminal_reason,
    audit_integrity_tag, created_at_ms
  FROM foundation_grant_audit_replay_provenance_copy;
  DROP TABLE foundation_grant_audit_replay_provenance_copy;
  CREATE TABLE foundation_grant_audit_provenance_replay_copy AS
    SELECT * FROM foundation_grant_audit_provenance;
  DROP TABLE foundation_grant_audit_provenance;
  ${FOUNDATION_GRANT_AUDIT_PROVENANCE_TABLE_V16_SQL};
  INSERT INTO foundation_grant_audit_provenance (
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, previous_event_game_id, replay_evidence_id, credential_kind,
    credential_fingerprint, before_status, after_status, before_expires_at_ms,
    after_expires_at_ms, terminal_reason, audit_integrity_tag, created_at_ms
  )
  SELECT
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, previous_event_game_id, NULL, credential_kind, credential_fingerprint,
    before_status, after_status, before_expires_at_ms, after_expires_at_ms, terminal_reason,
    audit_integrity_tag, created_at_ms
  FROM foundation_grant_audit_provenance_replay_copy;
  DROP TABLE foundation_grant_audit_provenance_replay_copy;
  ${FOUNDATION_GRANT_AUDIT_PROVENANCE_GRANT_INDEX_SQL};
  ${FOUNDATION_GRANT_AUDIT_PROVENANCE_NO_UPDATE_TRIGGER_SQL};
  ${FOUNDATION_GRANT_AUDIT_PROVENANCE_NO_DELETE_TRIGGER_SQL};
  ${FOUNDATION_GRANT_AUDIT_GRANT_INDEX_SQL};
  ${FOUNDATION_GRANT_AUDIT_NO_LEGACY_TAG_INSERT_TRIGGER_SQL};
  ${FOUNDATION_GRANT_AUDIT_PROVENANCE_AFTER_INSERT_TRIGGER_V16_SQL};
`;

const FOUNDATION_COMPOSED_GRANT_AUDIT_TABLE_SQL =
  FOUNDATION_TYPED_GRANT_AUDIT_TABLE_V16_SQL.replace(
    "'session-terminated', 'session-switched', 'replay-authorized'))",
    "'session-terminated', 'session-switched', 'replay-authorized', 'control-action-accepted', 'control-action-duplicate', 'control-action-rejected', 'control-action-retry-later', 'control-action-dependency-blocked'))",
  ).replace(
    "    created_at_ms INTEGER NOT NULL",
    "    acceptance_id TEXT,\n    control_audit_id TEXT,\n    control_action_id TEXT,\n    content_fingerprint TEXT,\n    outcome_detail TEXT,\n    created_at_ms INTEGER NOT NULL",
  );

/** Schema-17 is the append-only durable state for the composed acceptance seam. */
const FOUNDATION_COMPOSED_ACCEPTANCE_MIGRATION_SQL = `
  CREATE TABLE foundation_acceptance_budgets (
    bucket_id TEXT PRIMARY KEY,
    bucket_kind TEXT NOT NULL CHECK (bucket_kind IN ('online-session', 'online-event', 'replay-session')),
    subject_id TEXT NOT NULL,
    capacity INTEGER NOT NULL CHECK (capacity > 0),
    refill_per_second INTEGER NOT NULL CHECK (refill_per_second > 0),
    tokens REAL NOT NULL CHECK (tokens >= 0 AND tokens <= capacity),
    updated_at_ms INTEGER NOT NULL,
    state_revision INTEGER NOT NULL CHECK (state_revision > 0)
  ) STRICT;
  CREATE TABLE foundation_replay_reservations (
    reservation_id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL REFERENCES foundation_event_game_record_roots(record_id) ON DELETE CASCADE,
    event_game_id TEXT NOT NULL,
    originating_session_id TEXT NOT NULL,
    replacement_session_id TEXT,
    action_count INTEGER NOT NULL CHECK (action_count > 0),
    status TEXT NOT NULL CHECK (status IN ('reserved', 'committing', 'committed', 'partial', 'discarded', 'acknowledged')),
    batch_digest TEXT,
    created_at_ms INTEGER NOT NULL,
    committed_at_ms INTEGER,
    acknowledged_at_ms INTEGER,
    state_revision INTEGER NOT NULL CHECK (state_revision > 0)
  ) STRICT;
  CREATE TABLE foundation_replay_attempts (
    attempt_id TEXT PRIMARY KEY,
    reservation_id TEXT NOT NULL REFERENCES foundation_replay_reservations(reservation_id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'duplicate-accepted', 'rejected', 'retry-later')),
    action_fingerprint TEXT,
    result_json TEXT,
    control_audit_id TEXT,
    grant_audit_id TEXT,
    created_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER,
    state_revision INTEGER NOT NULL CHECK (state_revision > 0),
    UNIQUE (reservation_id, operation_id)
  ) STRICT;
  CREATE TABLE foundation_replay_receipts (
    receipt_id TEXT PRIMARY KEY,
    reservation_id TEXT NOT NULL REFERENCES foundation_replay_reservations(reservation_id) ON DELETE CASCADE,
    receipt_digest TEXT NOT NULL UNIQUE,
    receipt_key_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('committed', 'acknowledged')),
    action_count INTEGER NOT NULL CHECK (action_count > 0),
    created_at_ms INTEGER NOT NULL,
    acknowledged_at_ms INTEGER,
    state_revision INTEGER NOT NULL CHECK (state_revision > 0)
  ) STRICT;
  CREATE TABLE foundation_acceptance_integrity_anchors (
    anchor_id TEXT PRIMARY KEY,
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('budget', 'reservation', 'attempt', 'receipt')),
    subject_id TEXT NOT NULL,
    state_revision INTEGER NOT NULL CHECK (state_revision > 0),
    key_version TEXT NOT NULL,
    integrity_tag TEXT NOT NULL,
    UNIQUE (subject_kind, subject_id, state_revision)
  ) STRICT;
  CREATE TRIGGER foundation_acceptance_integrity_anchors_no_update
    BEFORE UPDATE ON foundation_acceptance_integrity_anchors
    BEGIN SELECT RAISE(ABORT, 'Acceptance integrity anchors are immutable.'); END;
  CREATE TRIGGER foundation_acceptance_integrity_anchors_no_delete
    BEFORE DELETE ON foundation_acceptance_integrity_anchors
    BEGIN SELECT RAISE(ABORT, 'Acceptance integrity anchors are immutable.'); END;
  DROP TRIGGER IF EXISTS foundation_grant_audit_provenance_after_insert;
  DROP TRIGGER IF EXISTS foundation_grant_audit_no_legacy_integrity_tag;
  DROP INDEX IF EXISTS foundation_grant_audit_grant_id;
  ALTER TABLE foundation_grant_audit_provenance ADD COLUMN acceptance_id TEXT;
  ALTER TABLE foundation_grant_audit_provenance ADD COLUMN control_audit_id TEXT;
  ALTER TABLE foundation_grant_audit_provenance ADD COLUMN control_action_id TEXT;
  ALTER TABLE foundation_grant_audit_provenance ADD COLUMN content_fingerprint TEXT;
  ALTER TABLE foundation_grant_audit_provenance ADD COLUMN outcome_detail TEXT;
  ALTER TABLE foundation_grant_audit RENAME TO foundation_grant_audit_pre17;
  ${FOUNDATION_COMPOSED_GRANT_AUDIT_TABLE_SQL};
  INSERT INTO foundation_grant_audit (
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, credential_kind, credential_fingerprint, before_status, after_status,
    before_expires_at_ms, after_expires_at_ms, previous_event_game_id, replay_evidence_id,
    terminal_reason, audit_integrity_tag, acceptance_id, control_audit_id,
    control_action_id, content_fingerprint, outcome_detail, created_at_ms
  ) SELECT audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, credential_kind, credential_fingerprint, before_status, after_status,
    before_expires_at_ms, after_expires_at_ms, previous_event_game_id, replay_evidence_id,
    terminal_reason, audit_integrity_tag, NULL, NULL, NULL, NULL, NULL, created_at_ms
    FROM foundation_grant_audit_pre17;
  DROP TABLE foundation_grant_audit_pre17;
  CREATE INDEX foundation_grant_audit_grant_id ON foundation_grant_audit (grant_id, audit_id);
  CREATE TRIGGER foundation_grant_audit_no_legacy_integrity_tag
    BEFORE INSERT ON foundation_grant_audit
    WHEN NEW.audit_integrity_tag = 'legacy-migration-v1'
    BEGIN SELECT RAISE(ABORT, 'Legacy Grant Audit integrity tags are migration-owned.'); END;
  CREATE TRIGGER foundation_grant_audit_provenance_after_insert
    AFTER INSERT ON foundation_grant_audit
    BEGIN
      INSERT INTO foundation_grant_audit_provenance (
        audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
        event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
        event_game_id, previous_event_game_id, replay_evidence_id, credential_kind,
        credential_fingerprint, before_status, after_status, before_expires_at_ms,
        after_expires_at_ms, terminal_reason, audit_integrity_tag, acceptance_id,
        control_audit_id, control_action_id, content_fingerprint, outcome_detail, created_at_ms
      ) VALUES (
        NEW.audit_id, NEW.action, NEW.outcome, NEW.actor_reference, NEW.grant_id,
        NEW.grant_type, NEW.grant_version, NEW.event_id, NEW.game_day_id, NEW.pitch_id,
        NEW.pitch_slot_id, NEW.session_id, NEW.replaced_session_id, NEW.event_game_id,
        NEW.previous_event_game_id, NEW.replay_evidence_id, NEW.credential_kind,
        NEW.credential_fingerprint, NEW.before_status, NEW.after_status,
        NEW.before_expires_at_ms, NEW.after_expires_at_ms, NEW.terminal_reason,
        NEW.audit_integrity_tag, NEW.acceptance_id, NEW.control_audit_id,
        NEW.control_action_id, NEW.content_fingerprint, NEW.outcome_detail, NEW.created_at_ms
      );
    END;
  CREATE INDEX foundation_replay_reservations_record_id
    ON foundation_replay_reservations(record_id, created_at_ms);
  CREATE INDEX foundation_replay_attempts_reservation_id
    ON foundation_replay_attempts(reservation_id, attempt_id);
`;

const FOUNDATION_ACCEPTANCE_INTEGRITY_HISTORY_MIGRATION_SQL = `
  ALTER TABLE foundation_acceptance_integrity_anchors
    ADD COLUMN canonical_value TEXT NOT NULL DEFAULT '';
  DROP TRIGGER foundation_acceptance_integrity_anchors_no_delete;
  CREATE TRIGGER foundation_acceptance_integrity_anchors_no_delete
    BEFORE DELETE ON foundation_acceptance_integrity_anchors
    WHEN NOT EXISTS (
      SELECT 1 FROM foundation_replay_reservations AS reservations
      WHERE reservations.status IN ('reserved', 'partial')
        AND (
          (OLD.subject_kind = 'reservation' AND reservations.reservation_id = OLD.subject_id)
          OR (OLD.subject_kind = 'attempt' AND OLD.subject_id LIKE reservations.reservation_id || ':%')
        )
    )
    BEGIN SELECT RAISE(ABORT, 'Acceptance integrity anchors are immutable.'); END;
`;
const FOUNDATION_GRANT_CODE_AUDIT_TABLE_V17_SQL = FOUNDATION_COMPOSED_GRANT_AUDIT_TABLE_SQL.replace(
  "'control-action-dependency-blocked'))",
  "'control-action-dependency-blocked', 'grant-code-created', 'grant-code-replaced', 'grant-code-disabled', 'grant-code-erased-expiry', 'grant-code-admitted'))",
)
  .replace(
    "    outcome_detail TEXT,\n    created_at_ms INTEGER NOT NULL",
    "    outcome_detail TEXT,\n    audit_sequence INTEGER,\n    predecessor_audit_id TEXT,\n    code_state TEXT CHECK (code_state IS NULL OR code_state IN ('present', 'disabled', 'erased')),\n    previous_code_fingerprint TEXT,\n    code_format_version INTEGER,\n    code_encryption_key_version TEXT,\n    code_lookup_key_version TEXT,\n    code_state_before TEXT CHECK (code_state IS NULL OR code_state IN ('absent', 'present', 'disabled', 'erased')),\n    created_at_ms INTEGER NOT NULL",
  )
  .replace(
    "    credential_kind TEXT CHECK (credential_kind IS NULL OR credential_kind = 'qr'),",
    "    credential_kind TEXT CHECK (credential_kind IS NULL OR credential_kind IN ('qr', 'manual-code')),",
  );

const FOUNDATION_GRANT_CODE_AUDIT_PROVENANCE_TABLE_V17_SQL =
  FOUNDATION_GRANT_AUDIT_PROVENANCE_TABLE_V16_SQL.replace(
    "'session-terminated', 'session-switched', 'replay-authorized'))",
    "'session-terminated', 'session-switched', 'replay-authorized', 'control-action-accepted', 'control-action-duplicate', 'control-action-rejected', 'control-action-retry-later', 'control-action-dependency-blocked', 'grant-code-created', 'grant-code-replaced', 'grant-code-disabled', 'grant-code-erased-expiry', 'grant-code-admitted'))",
  ).replace(
    "    terminal_reason TEXT,\n    audit_integrity_tag TEXT",
    "    terminal_reason TEXT,\n    acceptance_id TEXT,\n    control_audit_id TEXT,\n    control_action_id TEXT,\n    content_fingerprint TEXT,\n    outcome_detail TEXT,\n    audit_sequence INTEGER,\n    predecessor_audit_id TEXT,\n    code_state TEXT CHECK (code_state IS NULL OR code_state IN ('present', 'disabled', 'erased')),\n    previous_code_fingerprint TEXT,\n    code_format_version INTEGER,\n    code_encryption_key_version TEXT,\n    code_lookup_key_version TEXT,\n    code_state_before TEXT CHECK (code_state_before IS NULL OR code_state_before IN ('absent', 'present', 'disabled', 'erased')),\n    audit_integrity_tag TEXT",
  );

export const FOUNDATION_TYPED_GRANT_AUDIT_TABLE_V17_SQL = FOUNDATION_GRANT_CODE_AUDIT_TABLE_V17_SQL;
export const FOUNDATION_GRANT_AUDIT_PROVENANCE_TABLE_V17_SQL =
  FOUNDATION_GRANT_CODE_AUDIT_PROVENANCE_TABLE_V17_SQL;

const FOUNDATION_GRANT_AUDIT_PROVENANCE_AFTER_INSERT_TRIGGER_V19_SQL = `
  CREATE TRIGGER foundation_grant_audit_provenance_after_insert
    AFTER INSERT ON foundation_grant_audit
    BEGIN
      INSERT INTO foundation_grant_audit_provenance (
        audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
        event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
        event_game_id, previous_event_game_id, replay_evidence_id, credential_kind,
        credential_fingerprint, before_status, after_status, before_expires_at_ms,
        after_expires_at_ms, terminal_reason, acceptance_id, control_audit_id,
        control_action_id, content_fingerprint, outcome_detail, audit_sequence,
        predecessor_audit_id, code_state, previous_code_fingerprint, code_format_version,
        code_encryption_key_version, code_lookup_key_version, code_state_before,
        audit_integrity_tag, created_at_ms
      ) VALUES (
        NEW.audit_id, NEW.action, NEW.outcome, NEW.actor_reference, NEW.grant_id,
        NEW.grant_type, NEW.grant_version, NEW.event_id, NEW.game_day_id, NEW.pitch_id,
        NEW.pitch_slot_id, NEW.session_id, NEW.replaced_session_id, NEW.event_game_id,
        NEW.previous_event_game_id, NEW.replay_evidence_id, NEW.credential_kind,
        NEW.credential_fingerprint, NEW.before_status, NEW.after_status,
        NEW.before_expires_at_ms, NEW.after_expires_at_ms, NEW.terminal_reason,
        NEW.acceptance_id, NEW.control_audit_id, NEW.control_action_id,
        NEW.content_fingerprint, NEW.outcome_detail, NEW.audit_sequence,
        NEW.predecessor_audit_id, NEW.code_state, NEW.previous_code_fingerprint,
        NEW.code_format_version, NEW.code_encryption_key_version, NEW.code_lookup_key_version,
        NEW.code_state_before, NEW.audit_integrity_tag, NEW.created_at_ms
      );
    END
`;

const FOUNDATION_GRANT_CODE_MIGRATION_SQL = `
  CREATE TABLE foundation_grant_audit_code_copy AS SELECT * FROM foundation_grant_audit;
  DROP TABLE foundation_grant_audit;
  ${FOUNDATION_GRANT_CODE_AUDIT_TABLE_V17_SQL};
  INSERT INTO foundation_grant_audit (
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, previous_event_game_id, replay_evidence_id, credential_kind,
    credential_fingerprint, before_status, after_status, before_expires_at_ms,
    after_expires_at_ms, terminal_reason, acceptance_id, control_audit_id, control_action_id,
    content_fingerprint, outcome_detail, audit_sequence, predecessor_audit_id,
    code_state, previous_code_fingerprint, code_format_version, code_encryption_key_version,
    code_lookup_key_version, code_state_before, audit_integrity_tag, created_at_ms
  )
  SELECT
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, previous_event_game_id, replay_evidence_id, credential_kind,
    credential_fingerprint, before_status, after_status, before_expires_at_ms,
    after_expires_at_ms, terminal_reason, acceptance_id, control_audit_id, control_action_id,
    content_fingerprint, outcome_detail, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    audit_integrity_tag, created_at_ms
  FROM foundation_grant_audit_code_copy;
  DROP TABLE foundation_grant_audit_code_copy;
  CREATE TABLE foundation_grant_audit_provenance_code_copy AS SELECT * FROM foundation_grant_audit_provenance;
  DROP TABLE foundation_grant_audit_provenance;
  ${FOUNDATION_GRANT_CODE_AUDIT_PROVENANCE_TABLE_V17_SQL};
  INSERT INTO foundation_grant_audit_provenance (
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, previous_event_game_id, replay_evidence_id, credential_kind,
    credential_fingerprint, before_status, after_status, before_expires_at_ms,
    after_expires_at_ms, terminal_reason, acceptance_id, control_audit_id, control_action_id,
    content_fingerprint, outcome_detail, audit_sequence, predecessor_audit_id,
    code_state, previous_code_fingerprint, code_format_version, code_encryption_key_version,
    code_lookup_key_version, code_state_before, audit_integrity_tag, created_at_ms
  )
  SELECT
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, previous_event_game_id, replay_evidence_id, credential_kind,
    credential_fingerprint, before_status, after_status, before_expires_at_ms,
    after_expires_at_ms, terminal_reason, acceptance_id, control_audit_id, control_action_id,
    content_fingerprint, outcome_detail, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    audit_integrity_tag, created_at_ms
  FROM foundation_grant_audit_provenance_code_copy;
  DROP TABLE foundation_grant_audit_provenance_code_copy;
  ${FOUNDATION_GRANT_AUDIT_PROVENANCE_GRANT_INDEX_SQL};
  ${FOUNDATION_GRANT_AUDIT_PROVENANCE_NO_UPDATE_TRIGGER_SQL};
  ${FOUNDATION_GRANT_AUDIT_PROVENANCE_NO_DELETE_TRIGGER_SQL};
  ${FOUNDATION_GRANT_AUDIT_GRANT_INDEX_SQL};
  ${FOUNDATION_GRANT_AUDIT_NO_LEGACY_TAG_INSERT_TRIGGER_SQL};
  ${FOUNDATION_GRANT_AUDIT_PROVENANCE_AFTER_INSERT_TRIGGER_V19_SQL};

  CREATE TABLE foundation_grant_codes (
    grant_id TEXT PRIMARY KEY REFERENCES foundation_grant_roots(grant_id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('present', 'disabled', 'erased')),
    format_version INTEGER NOT NULL CHECK (format_version = 1),
    kind TEXT NOT NULL CHECK (kind = 'manual-code'),
    encryption_key_version TEXT,
    lookup_key_version TEXT,
    code_iv TEXT,
    code_ciphertext TEXT,
    code_tag TEXT,
    code_lookup_digest TEXT UNIQUE,
    code_fingerprint TEXT NOT NULL,
    CHECK (
      (state = 'present' AND encryption_key_version IS NOT NULL AND lookup_key_version IS NOT NULL AND code_iv IS NOT NULL AND code_ciphertext IS NOT NULL AND code_tag IS NOT NULL AND code_lookup_digest IS NOT NULL)
      OR
      (state IN ('disabled', 'erased') AND encryption_key_version IS NULL AND lookup_key_version IS NULL AND code_iv IS NULL AND code_ciphertext IS NULL AND code_tag IS NULL AND code_lookup_digest IS NULL)
    )
  ) STRICT;

  CREATE TABLE foundation_grant_admission_telemetry (
    mode TEXT NOT NULL CHECK (mode IN ('qr', 'code')),
    source_digest TEXT NOT NULL,
    failed_attempts INTEGER NOT NULL CHECK (failed_attempts >= 0),
    delay_until_ms INTEGER,
    last_attempt_at_ms INTEGER NOT NULL,
    last_success_at_ms INTEGER,
    PRIMARY KEY (mode, source_digest)
  ) STRICT;

  CREATE TABLE foundation_grant_admission_global_windows (
    mode TEXT PRIMARY KEY CHECK (mode IN ('qr', 'code')),
    window_started_at_ms INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0)
  ) STRICT;

  CREATE TABLE foundation_grant_state_anchors (
    grant_id TEXT PRIMARY KEY REFERENCES foundation_grant_roots(grant_id) ON DELETE CASCADE,
    anchor_version INTEGER NOT NULL CHECK (anchor_version = 1),
    audit_count INTEGER NOT NULL CHECK (audit_count >= 1),
    audit_head_id TEXT NOT NULL,
    state_digest TEXT NOT NULL,
    integrity_tag TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE foundation_grant_admission_state_anchors (
    anchor_id INTEGER PRIMARY KEY CHECK (anchor_id = 1),
    anchor_version INTEGER NOT NULL CHECK (anchor_version = 1),
    state_digest TEXT NOT NULL,
    integrity_tag TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  ) STRICT;
  INSERT INTO foundation_grant_admission_state_anchors
    (anchor_id, anchor_version, state_digest, integrity_tag, created_at_ms)
  VALUES (1, 1, 'pending-schema-20-key', 'pending-schema-20-key', 0);
`;

/** Schema-18 adds the permanent Game-Lock Grant-Code erasure evidence. */
export const FOUNDATION_GRANT_CODE_LOCK_AUDIT_TABLE_V18_SQL =
  FOUNDATION_GRANT_CODE_AUDIT_TABLE_V17_SQL.replace(
    "'grant-code-admitted'))",
    "'grant-code-admitted', 'grant-code-erased-game-lock'))",
  );

export const FOUNDATION_GRANT_CODE_LOCK_AUDIT_PROVENANCE_TABLE_V18_SQL =
  FOUNDATION_GRANT_CODE_AUDIT_PROVENANCE_TABLE_V17_SQL.replace(
    "'grant-code-admitted'))",
    "'grant-code-admitted', 'grant-code-erased-game-lock'))",
  );

const FOUNDATION_GRANT_CODE_LOCK_MIGRATION_SQL = `
  CREATE TABLE foundation_grant_audit_game_lock_copy AS SELECT * FROM foundation_grant_audit;
  DROP TABLE foundation_grant_audit;
  ${FOUNDATION_GRANT_CODE_LOCK_AUDIT_TABLE_V18_SQL};
  INSERT INTO foundation_grant_audit (
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, previous_event_game_id, replay_evidence_id, credential_kind,
    credential_fingerprint, before_status, after_status, before_expires_at_ms,
    after_expires_at_ms, terminal_reason, acceptance_id, control_audit_id, control_action_id,
    content_fingerprint, outcome_detail, audit_sequence, predecessor_audit_id,
    code_state, previous_code_fingerprint, code_format_version, code_encryption_key_version,
    code_lookup_key_version, code_state_before, audit_integrity_tag, created_at_ms
  )
  SELECT
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, previous_event_game_id, replay_evidence_id, credential_kind,
    credential_fingerprint, before_status, after_status, before_expires_at_ms,
    after_expires_at_ms, terminal_reason, acceptance_id, control_audit_id, control_action_id,
    content_fingerprint, outcome_detail, audit_sequence, predecessor_audit_id,
    code_state, previous_code_fingerprint, code_format_version, code_encryption_key_version,
    code_lookup_key_version, code_state_before, audit_integrity_tag, created_at_ms
  FROM foundation_grant_audit_game_lock_copy;
  DROP TABLE foundation_grant_audit_game_lock_copy;
  CREATE TABLE foundation_grant_audit_provenance_game_lock_copy AS
    SELECT * FROM foundation_grant_audit_provenance;
  DROP TABLE foundation_grant_audit_provenance;
  ${FOUNDATION_GRANT_CODE_LOCK_AUDIT_PROVENANCE_TABLE_V18_SQL};
  INSERT INTO foundation_grant_audit_provenance (
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, previous_event_game_id, replay_evidence_id, credential_kind,
    credential_fingerprint, before_status, after_status, before_expires_at_ms,
    after_expires_at_ms, terminal_reason, acceptance_id, control_audit_id, control_action_id,
    content_fingerprint, outcome_detail, audit_sequence, predecessor_audit_id,
    code_state, previous_code_fingerprint, code_format_version, code_encryption_key_version,
    code_lookup_key_version, code_state_before, audit_integrity_tag, created_at_ms
  )
  SELECT
    audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
    event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
    event_game_id, previous_event_game_id, replay_evidence_id, credential_kind,
    credential_fingerprint, before_status, after_status, before_expires_at_ms,
    after_expires_at_ms, terminal_reason, acceptance_id, control_audit_id, control_action_id,
    content_fingerprint, outcome_detail, audit_sequence, predecessor_audit_id,
    code_state, previous_code_fingerprint, code_format_version, code_encryption_key_version,
    code_lookup_key_version, code_state_before, audit_integrity_tag, created_at_ms
  FROM foundation_grant_audit_provenance_game_lock_copy;
  DROP TABLE foundation_grant_audit_provenance_game_lock_copy;
  ${FOUNDATION_GRANT_AUDIT_PROVENANCE_GRANT_INDEX_SQL};
  ${FOUNDATION_GRANT_AUDIT_PROVENANCE_NO_UPDATE_TRIGGER_SQL};
  ${FOUNDATION_GRANT_AUDIT_PROVENANCE_NO_DELETE_TRIGGER_SQL};
  ${FOUNDATION_GRANT_AUDIT_GRANT_INDEX_SQL};
  ${FOUNDATION_GRANT_AUDIT_NO_LEGACY_TAG_INSERT_TRIGGER_SQL};
  ${FOUNDATION_GRANT_AUDIT_PROVENANCE_AFTER_INSERT_TRIGGER_V19_SQL};
`;

export const FOUNDATION_EVENT_CATALOG_EVENTS_TABLE_SQL = `
  CREATE TABLE foundation_event_catalog_events (
    event_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    time_zone TEXT NOT NULL,
    publication_status TEXT NOT NULL CHECK (publication_status = 'unpublished'),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT
`;

const FOUNDATION_EVENT_CATALOG_EVENTS_TABLE_V25_SQL =
  FOUNDATION_EVENT_CATALOG_EVENTS_TABLE_SQL.replace(
    "publication_status TEXT NOT NULL CHECK (publication_status = 'unpublished')",
    "publication_status TEXT NOT NULL CHECK (publication_status IN ('unpublished', 'published', 'cancelled'))",
  );

export const FOUNDATION_EVENT_CATALOG_GAME_DAYS_TABLE_SQL = `
  CREATE TABLE foundation_event_catalog_game_days (
    game_day_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES foundation_event_catalog_events(event_id) ON DELETE CASCADE,
    game_day_date TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE (event_id, game_day_date)
  ) STRICT
`;

export const FOUNDATION_EVENT_CATALOG_AUDIT_TABLE_SQL = `
  CREATE TABLE foundation_event_catalog_audit (
    audit_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL UNIQUE,
    action TEXT NOT NULL CHECK (action IN (
      'event-created', 'event-updated', 'event-removed',
      'game-day-added', 'game-day-updated', 'game-day-removed'
    )),
    event_id TEXT NOT NULL,
    game_day_id TEXT,
    actor_reference TEXT NOT NULL,
    occurred_at_ms INTEGER NOT NULL,
    before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
    after_json TEXT NOT NULL CHECK (json_valid(after_json))
  ) STRICT
`;

export const FOUNDATION_EVENT_CATALOG_AUDIT_TABLE_V2_SQL =
  FOUNDATION_EVENT_CATALOG_AUDIT_TABLE_SQL.replace(
    "'game-day-added', 'game-day-updated', 'game-day-removed'",
    "'game-day-added', 'game-day-updated', 'game-day-removed', 'event-team-created', 'event-team-updated', 'roster-updated', 'pitch-created', 'pitch-updated'",
  );

export const FOUNDATION_EVENT_CATALOG_AUDIT_TABLE_V3_SQL =
  FOUNDATION_EVENT_CATALOG_AUDIT_TABLE_V2_SQL.replace(
    "'pitch-created', 'pitch-updated'",
    "'pitch-created', 'pitch-updated', 'gameplay-slot-created', 'pitch-slot-created', 'event-game-created', 'event-game-teams-confirmed'",
  );

export const FOUNDATION_EVENT_CATALOG_TEAMS_TABLE_SQL = `
  CREATE TABLE foundation_event_catalog_teams (
    event_team_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES foundation_event_catalog_events(event_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    default_color TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE (event_id, name)
  ) STRICT
`;

export const FOUNDATION_EVENT_CATALOG_ROSTER_TABLE_SQL = `
  CREATE TABLE foundation_event_catalog_roster (
    roster_entry_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES foundation_event_catalog_events(event_id) ON DELETE CASCADE,
    event_team_id TEXT NOT NULL REFERENCES foundation_event_catalog_teams(event_team_id) ON DELETE CASCADE,
    player_number INTEGER NOT NULL CHECK (player_number BETWEEN 0 AND 99),
    public_name TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE (event_team_id, player_number)
  ) STRICT
`;

export const FOUNDATION_EVENT_CATALOG_PITCHES_TABLE_SQL = `
  CREATE TABLE foundation_event_catalog_pitches (
    pitch_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES foundation_event_catalog_events(event_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE (event_id, name)
  ) STRICT
`;

export const FOUNDATION_EVENT_CATALOG_GAME_DAYS_EVENT_INDEX_SQL = `
  CREATE INDEX foundation_event_catalog_game_days_event_id
    ON foundation_event_catalog_game_days (event_id, game_day_date)
`;

export const FOUNDATION_EVENT_CATALOG_AUDIT_EVENT_INDEX_SQL = `
  CREATE INDEX foundation_event_catalog_audit_event_id
    ON foundation_event_catalog_audit (event_id, occurred_at_ms, audit_id)
`;

export const FOUNDATION_EVENT_CATALOG_ROSTER_TEAM_INDEX_SQL = `
  CREATE INDEX foundation_event_catalog_roster_team_id
    ON foundation_event_catalog_roster (event_team_id, player_number)
`;

export const FOUNDATION_EVENT_CATALOG_PITCHES_EVENT_INDEX_SQL = `
  CREATE INDEX foundation_event_catalog_pitches_event_id
    ON foundation_event_catalog_pitches (event_id, name, pitch_id)
`;

const FOUNDATION_EVENT_CATALOG_MIGRATION_SQL = `
  ${FOUNDATION_EVENT_CATALOG_EVENTS_TABLE_SQL};
  ${FOUNDATION_EVENT_CATALOG_GAME_DAYS_TABLE_SQL};
  ${FOUNDATION_EVENT_CATALOG_AUDIT_TABLE_SQL};
  ${FOUNDATION_EVENT_CATALOG_GAME_DAYS_EVENT_INDEX_SQL};
  ${FOUNDATION_EVENT_CATALOG_AUDIT_EVENT_INDEX_SQL};
`;

const FOUNDATION_CONTROL_SESSION_STAY_MIGRATION_SQL = `
  ALTER TABLE foundation_grant_sessions
    ADD COLUMN stayed_on_event_game_id TEXT;
`;

const FOUNDATION_EVENT_TEAMS_AND_PITCHES_MIGRATION_SQL = `
  CREATE TABLE foundation_event_catalog_audit_v2 AS
    SELECT * FROM foundation_event_catalog_audit;
  DROP TABLE foundation_event_catalog_audit;
  ${FOUNDATION_EVENT_CATALOG_AUDIT_TABLE_V2_SQL.replace(
    "CREATE TABLE foundation_event_catalog_audit",
    "CREATE TABLE foundation_event_catalog_audit_rebuilt",
  )};
  INSERT INTO foundation_event_catalog_audit_rebuilt
    (audit_id, operation_id, action, event_id, game_day_id, actor_reference,
     occurred_at_ms, before_json, after_json)
  SELECT audit_id, operation_id, action, event_id, game_day_id, actor_reference,
         occurred_at_ms, before_json, after_json
  FROM foundation_event_catalog_audit_v2;
  DROP TABLE foundation_event_catalog_audit_v2;
  ALTER TABLE foundation_event_catalog_audit_rebuilt RENAME TO foundation_event_catalog_audit;
  ${FOUNDATION_EVENT_CATALOG_TEAMS_TABLE_SQL};
  ${FOUNDATION_EVENT_CATALOG_ROSTER_TABLE_SQL};
  ${FOUNDATION_EVENT_CATALOG_PITCHES_TABLE_SQL};
  ${FOUNDATION_EVENT_CATALOG_AUDIT_EVENT_INDEX_SQL};
  ${FOUNDATION_EVENT_CATALOG_ROSTER_TEAM_INDEX_SQL};
  ${FOUNDATION_EVENT_CATALOG_PITCHES_EVENT_INDEX_SQL};
`;

export const FOUNDATION_EVENT_CATALOG_GAMEPLAY_SLOTS_TABLE_SQL = `
  CREATE TABLE foundation_event_catalog_gameplay_slots (
    gameplay_slot_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES foundation_event_catalog_events(event_id) ON DELETE CASCADE,
    game_day_id TEXT NOT NULL REFERENCES foundation_event_catalog_game_days(game_day_id) ON DELETE CASCADE,
    sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
    scheduled_start_ms INTEGER NOT NULL CHECK (scheduled_start_ms >= 0),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE (game_day_id, sequence_number)
  ) STRICT;
`;
export const FOUNDATION_EVENT_CATALOG_GAMEPLAY_SLOTS_INDEX_SQL = `
  CREATE INDEX foundation_event_catalog_gameplay_slots_game_day_id
    ON foundation_event_catalog_gameplay_slots (game_day_id, sequence_number, gameplay_slot_id)
`;
export const FOUNDATION_EVENT_CATALOG_PITCH_SLOTS_TABLE_SQL = `
  CREATE TABLE foundation_event_catalog_pitch_slots (
    pitch_slot_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES foundation_event_catalog_events(event_id) ON DELETE CASCADE,
    game_day_id TEXT NOT NULL REFERENCES foundation_event_catalog_game_days(game_day_id) ON DELETE CASCADE,
    pitch_id TEXT NOT NULL REFERENCES foundation_event_catalog_pitches(pitch_id) ON DELETE CASCADE,
    gameplay_slot_id TEXT NOT NULL REFERENCES foundation_event_catalog_gameplay_slots(gameplay_slot_id) ON DELETE CASCADE,
    sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE (pitch_id, gameplay_slot_id),
    UNIQUE (pitch_slot_id, gameplay_slot_id)
  ) STRICT;
`;
export const FOUNDATION_EVENT_CATALOG_PITCH_SLOTS_INDEX_SQL = `
  CREATE INDEX foundation_event_catalog_pitch_slots_game_day_id
    ON foundation_event_catalog_pitch_slots (game_day_id, pitch_id, sequence_number, pitch_slot_id)
`;
export const FOUNDATION_EVENT_CATALOG_GAMES_TABLE_SQL = `
  CREATE TABLE foundation_event_catalog_games (
    event_game_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES foundation_event_catalog_events(event_id) ON DELETE CASCADE,
    game_day_id TEXT NOT NULL REFERENCES foundation_event_catalog_game_days(game_day_id) ON DELETE CASCADE,
    gameplay_slot_id TEXT NOT NULL REFERENCES foundation_event_catalog_gameplay_slots(gameplay_slot_id) ON DELETE CASCADE,
    pitch_slot_id TEXT NOT NULL REFERENCES foundation_event_catalog_pitch_slots(pitch_slot_id) ON DELETE CASCADE,
    game_code TEXT,
    game_designation TEXT,
    side_a_id TEXT NOT NULL UNIQUE,
    side_a_event_team_id TEXT REFERENCES foundation_event_catalog_teams(event_team_id),
    side_a_event_team_name TEXT,
    side_a_source_label TEXT,
    side_a_confirmed_at_ms INTEGER,
    side_b_id TEXT NOT NULL UNIQUE,
    side_b_event_team_id TEXT REFERENCES foundation_event_catalog_teams(event_team_id),
    side_b_event_team_name TEXT,
    side_b_source_label TEXT,
    side_b_confirmed_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE (pitch_slot_id),
    UNIQUE (event_id, game_code),
    CHECK ((side_a_event_team_id IS NOT NULL AND side_a_event_team_name IS NOT NULL AND side_a_source_label IS NULL AND side_a_confirmed_at_ms IS NOT NULL) OR (side_a_event_team_id IS NULL AND side_a_event_team_name IS NULL AND side_a_source_label IS NOT NULL AND side_a_confirmed_at_ms IS NULL)),
    CHECK ((side_b_event_team_id IS NOT NULL AND side_b_event_team_name IS NOT NULL AND side_b_source_label IS NULL AND side_b_confirmed_at_ms IS NOT NULL) OR (side_b_event_team_id IS NULL AND side_b_event_team_name IS NULL AND side_b_source_label IS NOT NULL AND side_b_confirmed_at_ms IS NULL)),
    CHECK (side_a_event_team_id IS NULL OR side_a_event_team_id <> side_b_event_team_id)
  ) STRICT;
`;

export const FOUNDATION_EVENT_CATALOG_GAMEPLAY_SLOTS_TABLE_V25_SQL =
  FOUNDATION_EVENT_CATALOG_GAMEPLAY_SLOTS_TABLE_SQL.replace(
    "scheduled_start_ms INTEGER NOT NULL CHECK (scheduled_start_ms >= 0),",
    "scheduled_start_ms INTEGER NOT NULL CHECK (scheduled_start_ms >= 0),\n    expected_delay_ms INTEGER NOT NULL DEFAULT 0 CHECK (expected_delay_ms >= 0),",
  );
export const FOUNDATION_EVENT_CATALOG_PITCH_SLOTS_TABLE_V25_SQL =
  FOUNDATION_EVENT_CATALOG_PITCH_SLOTS_TABLE_SQL.replace(
    "sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),",
    "sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),\n    expected_delay_ms INTEGER NOT NULL DEFAULT 0 CHECK (expected_delay_ms >= 0),",
  );
export const FOUNDATION_EVENT_CATALOG_GAMES_TABLE_V25_SQL =
  FOUNDATION_EVENT_CATALOG_GAMES_TABLE_SQL.replace("    UNIQUE (pitch_slot_id),\n", "");
export const FOUNDATION_EVENT_CATALOG_GAMES_INDEX_SQL = `
  CREATE INDEX foundation_event_catalog_games_game_day_id
    ON foundation_event_catalog_games (game_day_id, gameplay_slot_id, event_game_id)
`;
export const FOUNDATION_EVENT_SCHEDULE_MIGRATION_SQL = `
  CREATE TABLE foundation_event_catalog_audit_v3 AS SELECT * FROM foundation_event_catalog_audit;
  DROP TABLE foundation_event_catalog_audit;
  ${FOUNDATION_EVENT_CATALOG_AUDIT_TABLE_V3_SQL.replace(
    "CREATE TABLE foundation_event_catalog_audit",
    "CREATE TABLE foundation_event_catalog_audit_rebuilt",
  )};
  INSERT INTO foundation_event_catalog_audit_rebuilt
    (audit_id, operation_id, action, event_id, game_day_id, actor_reference,
     occurred_at_ms, before_json, after_json)
  SELECT audit_id, operation_id, action, event_id, game_day_id, actor_reference,
         occurred_at_ms, before_json, after_json
  FROM foundation_event_catalog_audit_v3;
  DROP TABLE foundation_event_catalog_audit_v3;
  ALTER TABLE foundation_event_catalog_audit_rebuilt RENAME TO foundation_event_catalog_audit;
  ${FOUNDATION_EVENT_CATALOG_AUDIT_EVENT_INDEX_SQL};
  ${FOUNDATION_EVENT_CATALOG_GAMEPLAY_SLOTS_TABLE_SQL};
  ${FOUNDATION_EVENT_CATALOG_GAMEPLAY_SLOTS_INDEX_SQL};
  ${FOUNDATION_EVENT_CATALOG_PITCH_SLOTS_TABLE_SQL};
  ${FOUNDATION_EVENT_CATALOG_PITCH_SLOTS_INDEX_SQL};
  ${FOUNDATION_EVENT_CATALOG_GAMES_TABLE_SQL};
  ${FOUNDATION_EVENT_CATALOG_GAMES_INDEX_SQL};
`;

function foundationEventCatalogV25Sql(sql: string): string {
  return sql.replaceAll("foundation_event_catalog_", "foundation_event_catalog_v25_");
}

const FOUNDATION_EVENT_PUBLICATION_MIGRATION_SQL = `
  ${foundationEventCatalogV25Sql(FOUNDATION_EVENT_CATALOG_EVENTS_TABLE_V25_SQL)};
  ${foundationEventCatalogV25Sql(FOUNDATION_EVENT_CATALOG_GAME_DAYS_TABLE_SQL)};
  ${foundationEventCatalogV25Sql(FOUNDATION_EVENT_CATALOG_TEAMS_TABLE_SQL)};
  ${foundationEventCatalogV25Sql(FOUNDATION_EVENT_CATALOG_ROSTER_TABLE_SQL)};
  ${foundationEventCatalogV25Sql(FOUNDATION_EVENT_CATALOG_PITCHES_TABLE_SQL)};
  ${foundationEventCatalogV25Sql(FOUNDATION_EVENT_CATALOG_GAMEPLAY_SLOTS_TABLE_SQL)};
  ${foundationEventCatalogV25Sql(FOUNDATION_EVENT_CATALOG_PITCH_SLOTS_TABLE_SQL)};
  ${foundationEventCatalogV25Sql(FOUNDATION_EVENT_CATALOG_GAMES_TABLE_SQL)};
  INSERT INTO foundation_event_catalog_v25_events
    (event_id, name, time_zone, publication_status, created_at_ms, updated_at_ms)
  SELECT event_id, name, time_zone, publication_status, created_at_ms, updated_at_ms
  FROM foundation_event_catalog_events;
  INSERT INTO foundation_event_catalog_v25_game_days
    (game_day_id, event_id, game_day_date, created_at_ms, updated_at_ms)
  SELECT game_day_id, event_id, game_day_date, created_at_ms, updated_at_ms
  FROM foundation_event_catalog_game_days;
  INSERT INTO foundation_event_catalog_v25_teams
    (event_team_id, event_id, name, default_color, created_at_ms, updated_at_ms)
  SELECT event_team_id, event_id, name, default_color, created_at_ms, updated_at_ms
  FROM foundation_event_catalog_teams;
  INSERT INTO foundation_event_catalog_v25_roster
    (roster_entry_id, event_id, event_team_id, player_number, public_name, created_at_ms, updated_at_ms)
  SELECT roster_entry_id, event_id, event_team_id, player_number, public_name, created_at_ms, updated_at_ms
  FROM foundation_event_catalog_roster;
  INSERT INTO foundation_event_catalog_v25_pitches
    (pitch_id, event_id, name, created_at_ms, updated_at_ms)
  SELECT pitch_id, event_id, name, created_at_ms, updated_at_ms
  FROM foundation_event_catalog_pitches;
  INSERT INTO foundation_event_catalog_v25_gameplay_slots
    (gameplay_slot_id, event_id, game_day_id, sequence_number, scheduled_start_ms, created_at_ms, updated_at_ms)
  SELECT gameplay_slot_id, event_id, game_day_id, sequence_number, scheduled_start_ms, created_at_ms, updated_at_ms
  FROM foundation_event_catalog_gameplay_slots;
  INSERT INTO foundation_event_catalog_v25_pitch_slots
    (pitch_slot_id, event_id, game_day_id, pitch_id, gameplay_slot_id, sequence_number, created_at_ms, updated_at_ms)
  SELECT pitch_slot_id, event_id, game_day_id, pitch_id, gameplay_slot_id, sequence_number, created_at_ms, updated_at_ms
  FROM foundation_event_catalog_pitch_slots;
  INSERT INTO foundation_event_catalog_v25_games
    (event_game_id, event_id, game_day_id, gameplay_slot_id, pitch_slot_id,
     game_code, game_designation, side_a_id, side_a_event_team_id, side_a_event_team_name,
     side_a_source_label, side_a_confirmed_at_ms, side_b_id, side_b_event_team_id,
     side_b_event_team_name, side_b_source_label, side_b_confirmed_at_ms, created_at_ms, updated_at_ms)
  SELECT event_game_id, event_id, game_day_id, gameplay_slot_id, pitch_slot_id,
     game_code, game_designation, side_a_id, side_a_event_team_id, side_a_event_team_name,
     side_a_source_label, side_a_confirmed_at_ms, side_b_id, side_b_event_team_id,
     side_b_event_team_name, side_b_source_label, side_b_confirmed_at_ms, created_at_ms, updated_at_ms
  FROM foundation_event_catalog_games;

  DROP TABLE foundation_event_catalog_games;
  DROP TABLE foundation_event_catalog_pitch_slots;
  DROP TABLE foundation_event_catalog_gameplay_slots;
  DROP TABLE foundation_event_catalog_roster;
  DROP TABLE foundation_event_catalog_pitches;
  DROP TABLE foundation_event_catalog_teams;
  DROP TABLE foundation_event_catalog_game_days;
  DROP TABLE foundation_event_catalog_events;
  ALTER TABLE foundation_event_catalog_v25_events RENAME TO foundation_event_catalog_events;
  ALTER TABLE foundation_event_catalog_v25_game_days RENAME TO foundation_event_catalog_game_days;
  ALTER TABLE foundation_event_catalog_v25_teams RENAME TO foundation_event_catalog_teams;
  ALTER TABLE foundation_event_catalog_v25_roster RENAME TO foundation_event_catalog_roster;
  ALTER TABLE foundation_event_catalog_v25_pitches RENAME TO foundation_event_catalog_pitches;
  ALTER TABLE foundation_event_catalog_v25_gameplay_slots RENAME TO foundation_event_catalog_gameplay_slots;
  ALTER TABLE foundation_event_catalog_v25_pitch_slots RENAME TO foundation_event_catalog_pitch_slots;
  ALTER TABLE foundation_event_catalog_v25_games RENAME TO foundation_event_catalog_games;
  ${FOUNDATION_EVENT_CATALOG_GAME_DAYS_EVENT_INDEX_SQL};
  ${FOUNDATION_EVENT_CATALOG_ROSTER_TEAM_INDEX_SQL};
  ${FOUNDATION_EVENT_CATALOG_PITCHES_EVENT_INDEX_SQL};
  ${FOUNDATION_EVENT_CATALOG_GAMEPLAY_SLOTS_INDEX_SQL};
  ${FOUNDATION_EVENT_CATALOG_PITCH_SLOTS_INDEX_SQL};
  ${FOUNDATION_EVENT_CATALOG_GAMES_INDEX_SQL};

  CREATE TABLE foundation_event_catalog_audit_v25 AS SELECT * FROM foundation_event_catalog_audit;
  DROP TABLE foundation_event_catalog_audit;
  ${FOUNDATION_EVENT_CATALOG_AUDIT_TABLE_V3_SQL.replace(
    "CREATE TABLE foundation_event_catalog_audit",
    "CREATE TABLE foundation_event_catalog_audit_rebuilt",
  ).replace(
    "'event-game-teams-confirmed'",
    "'event-game-teams-confirmed', 'event-publication-changed'",
  )};
  INSERT INTO foundation_event_catalog_audit_rebuilt
    (audit_id, operation_id, action, event_id, game_day_id, actor_reference,
     occurred_at_ms, before_json, after_json)
  SELECT audit_id, operation_id, action, event_id, game_day_id, actor_reference,
         occurred_at_ms, before_json, after_json
  FROM foundation_event_catalog_audit_v25;
  DROP TABLE foundation_event_catalog_audit_v25;
  ALTER TABLE foundation_event_catalog_audit_rebuilt RENAME TO foundation_event_catalog_audit;
  ${FOUNDATION_EVENT_CATALOG_AUDIT_EVENT_INDEX_SQL};
`;

/** Schema-25 adds independent Expected Delay offsets and permits deliberate schedule conflicts. */
export const FOUNDATION_EVENT_SCHEDULE_EXPECTED_DELAYS_MIGRATION_SQL = `
  ALTER TABLE foundation_event_catalog_gameplay_slots
    ADD COLUMN expected_delay_ms INTEGER NOT NULL DEFAULT 0 CHECK (expected_delay_ms >= 0);
  ALTER TABLE foundation_event_catalog_pitch_slots
    ADD COLUMN expected_delay_ms INTEGER NOT NULL DEFAULT 0 CHECK (expected_delay_ms >= 0);
  CREATE TABLE foundation_event_catalog_games_shift_copy AS
    SELECT * FROM foundation_event_catalog_games;
  DROP TABLE foundation_event_catalog_games;
  CREATE TABLE foundation_event_catalog_games (
    event_game_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES foundation_event_catalog_events(event_id) ON DELETE CASCADE,
    game_day_id TEXT NOT NULL REFERENCES foundation_event_catalog_game_days(game_day_id) ON DELETE CASCADE,
    gameplay_slot_id TEXT NOT NULL REFERENCES foundation_event_catalog_gameplay_slots(gameplay_slot_id) ON DELETE CASCADE,
    pitch_slot_id TEXT NOT NULL REFERENCES foundation_event_catalog_pitch_slots(pitch_slot_id) ON DELETE CASCADE,
    game_code TEXT,
    game_designation TEXT,
    side_a_id TEXT NOT NULL UNIQUE,
    side_a_event_team_id TEXT REFERENCES foundation_event_catalog_teams(event_team_id),
    side_a_event_team_name TEXT,
    side_a_source_label TEXT,
    side_a_confirmed_at_ms INTEGER,
    side_b_id TEXT NOT NULL UNIQUE,
    side_b_event_team_id TEXT REFERENCES foundation_event_catalog_teams(event_team_id),
    side_b_event_team_name TEXT,
    side_b_source_label TEXT,
    side_b_confirmed_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE (event_id, game_code),
    CHECK ((side_a_event_team_id IS NOT NULL AND side_a_event_team_name IS NOT NULL AND side_a_source_label IS NULL AND side_a_confirmed_at_ms IS NOT NULL) OR (side_a_event_team_id IS NULL AND side_a_event_team_name IS NULL AND side_a_source_label IS NOT NULL AND side_a_confirmed_at_ms IS NULL)),
    CHECK ((side_b_event_team_id IS NOT NULL AND side_b_event_team_name IS NOT NULL AND side_b_source_label IS NULL AND side_b_confirmed_at_ms IS NOT NULL) OR (side_b_event_team_id IS NULL AND side_b_event_team_name IS NULL AND side_b_source_label IS NOT NULL AND side_b_confirmed_at_ms IS NULL)),
    CHECK (side_a_event_team_id IS NULL OR side_a_event_team_id <> side_b_event_team_id)
  ) STRICT;
  INSERT INTO foundation_event_catalog_games
    SELECT * FROM foundation_event_catalog_games_shift_copy;
  DROP TABLE foundation_event_catalog_games_shift_copy;
  ${FOUNDATION_EVENT_CATALOG_GAMES_INDEX_SQL};
`;

/** Schema-27 adds the durable Event Catalog removal audit action. */
export const FOUNDATION_EVENT_CATALOG_REMOVAL_MIGRATION_SQL = `
  CREATE TABLE foundation_event_catalog_audit_v27 AS SELECT * FROM foundation_event_catalog_audit;
  DROP TABLE foundation_event_catalog_audit;
  ${FOUNDATION_EVENT_CATALOG_AUDIT_TABLE_V3_SQL.replace(
    "CREATE TABLE foundation_event_catalog_audit",
    "CREATE TABLE foundation_event_catalog_audit_rebuilt",
  ).replace(
    "'event-game-teams-confirmed'",
    "'event-game-teams-confirmed', 'event-publication-changed', 'event-catalog-entry-removed'",
  )};
  INSERT INTO foundation_event_catalog_audit_rebuilt
    (audit_id, operation_id, action, event_id, game_day_id, actor_reference,
     occurred_at_ms, before_json, after_json)
  SELECT audit_id, operation_id, action, event_id, game_day_id, actor_reference,
         occurred_at_ms, before_json, after_json
  FROM foundation_event_catalog_audit_v27;
  DROP TABLE foundation_event_catalog_audit_v27;
  ALTER TABLE foundation_event_catalog_audit_rebuilt RENAME TO foundation_event_catalog_audit;
  ${FOUNDATION_EVENT_CATALOG_AUDIT_EVENT_INDEX_SQL};
`;

/** Schema-28 adds the redacted Event Administration Access Sheet audit action. */
export const FOUNDATION_ACCESS_SHEET_AUDIT_MIGRATION_SQL = `
  CREATE TABLE foundation_event_catalog_audit_v28 AS SELECT * FROM foundation_event_catalog_audit;
  DROP TABLE foundation_event_catalog_audit;
  ${FOUNDATION_EVENT_CATALOG_AUDIT_TABLE_V3_SQL.replace(
    "CREATE TABLE foundation_event_catalog_audit",
    "CREATE TABLE foundation_event_catalog_audit_rebuilt",
  ).replace(
    "'event-game-teams-confirmed'",
    "'event-game-teams-confirmed', 'event-publication-changed', 'event-catalog-entry-removed', 'access-sheet-generated'",
  )};
  INSERT INTO foundation_event_catalog_audit_rebuilt
    (audit_id, operation_id, action, event_id, game_day_id, actor_reference,
     occurred_at_ms, before_json, after_json)
  SELECT audit_id, operation_id, action, event_id, game_day_id, actor_reference,
         occurred_at_ms, before_json, after_json
  FROM foundation_event_catalog_audit_v28;
  DROP TABLE foundation_event_catalog_audit_v28;
  ALTER TABLE foundation_event_catalog_audit_rebuilt RENAME TO foundation_event_catalog_audit;
  ${FOUNDATION_EVENT_CATALOG_AUDIT_EVENT_INDEX_SQL};
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
  createMigration({
    id: "015-control-session-binding",
    ordinal: 15,
    schemaVersion: 15,
    sql: FOUNDATION_CONTROL_SESSION_BINDING_MIGRATION_SQL,
  }),
  createMigration({
    id: "016-replay-content-provenance",
    ordinal: 16,
    schemaVersion: 16,
    sql: FOUNDATION_REPLAY_PROVENANCE_MIGRATION_SQL,
  }),
  createMigration({
    id: "017-composed-acceptance-state",
    ordinal: 17,
    schemaVersion: 17,
    sql: FOUNDATION_COMPOSED_ACCEPTANCE_MIGRATION_SQL,
  }),
  createMigration({
    id: "018-acceptance-integrity-history",
    ordinal: 18,
    schemaVersion: 18,
    sql: FOUNDATION_ACCEPTANCE_INTEGRITY_HISTORY_MIGRATION_SQL,
  }),
  createMigration({
    id: "019-event-catalog",
    ordinal: 19,
    schemaVersion: 19,
    sql: FOUNDATION_EVENT_CATALOG_MIGRATION_SQL,
  }),
  createMigration({
    id: "020-grant-codes-and-admission-telemetry",
    ordinal: 20,
    schemaVersion: 20,
    sql: FOUNDATION_GRANT_CODE_MIGRATION_SQL,
  }),
  createMigration({
    id: "021-grant-code-game-lock-erasure-evidence",
    ordinal: 21,
    schemaVersion: 21,
    sql: FOUNDATION_GRANT_CODE_LOCK_MIGRATION_SQL,
  }),
  createMigration({
    id: "022-control-session-stay-binding",
    ordinal: 22,
    schemaVersion: 22,
    sql: FOUNDATION_CONTROL_SESSION_STAY_MIGRATION_SQL,
  }),
  createMigration({
    id: "023-event-teams-rosters-and-pitches",
    ordinal: 23,
    schemaVersion: 23,
    sql: FOUNDATION_EVENT_TEAMS_AND_PITCHES_MIGRATION_SQL,
  }),
  createMigration({
    id: "024-event-schedule-slots-and-games",
    ordinal: 24,
    schemaVersion: 24,
    sql: FOUNDATION_EVENT_SCHEDULE_MIGRATION_SQL,
  }),
  createMigration({
    id: "025-event-publication-status",
    ordinal: 25,
    schemaVersion: 25,
    sql: FOUNDATION_EVENT_PUBLICATION_MIGRATION_SQL,
  }),
  createMigration({
    id: "026-event-schedule-expected-delays-and-conflicts",
    ordinal: 26,
    schemaVersion: 26,
    sql: FOUNDATION_EVENT_SCHEDULE_EXPECTED_DELAYS_MIGRATION_SQL,
  }),
  createMigration({
    id: "027-event-catalog-removal-audit",
    ordinal: 27,
    schemaVersion: 27,
    sql: FOUNDATION_EVENT_CATALOG_REMOVAL_MIGRATION_SQL,
  }),
  createMigration({
    id: "028-access-sheet-generated-audit-action",
    ordinal: 28,
    schemaVersion: 28,
    sql: FOUNDATION_ACCESS_SHEET_AUDIT_MIGRATION_SQL,
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
