import { createHash } from "node:crypto";

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
