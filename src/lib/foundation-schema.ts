import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  FOUNDATION_ACTION_RECORD_INDEX_SQL,
  FOUNDATION_CURRENT_ACTION_TABLE_SQL,
  FOUNDATION_AUDIT_RECORD_INDEX_SQL,
  FOUNDATION_CURRENT_AUDIT_TABLE_SQL,
  FOUNDATION_LEDGER_TABLE_SQL,
  FOUNDATION_IDEMPOTENCY_RECORD_INDEX_SQL,
  FOUNDATION_IDEMPOTENCY_TABLE_SQL,
  FOUNDATION_METADATA_TABLE_SQL,
  FOUNDATION_ROOT_EVENT_INDEX_SQL,
  FOUNDATION_ROOT_GAME_DAY_INDEX_SQL,
  FOUNDATION_ROOT_TABLE_SQL,
  FOUNDATION_SIDE_RECORD_INDEX_SQL,
  FOUNDATION_SIDE_TABLE_SQL,
  FOUNDATION_GRANT_AUDIT_GRANT_INDEX_SQL,
  FOUNDATION_TYPED_GRANT_AUDIT_TABLE_V11_SQL,
  FOUNDATION_GRANT_SESSION_CONTEXT_INDEX_SQL,
  FOUNDATION_GRANT_SESSION_GRANT_INDEX_SQL,
  FOUNDATION_EVIDENCE_PROVENANCE_TABLE_SQL,
  FOUNDATION_EVIDENCE_PROVENANCE_UPDATE_TRIGGER_SQL,
  FOUNDATION_EVIDENCE_PROVENANCE_DELETE_TRIGGER_SQL,
  FOUNDATION_TYPED_GRANT_TABLE_SQL,
  FOUNDATION_TYPED_GRANT_SESSION_TABLE_SQL,
  FOUNDATION_GRANT_MIGRATION_PROVENANCE_TABLE_SQL,
  FOUNDATION_GRANT_MIGRATION_PROVENANCE_STATE_TABLE_SQL,
  FOUNDATION_GRANT_AUDIT_PROVENANCE_TABLE_SQL,
  FOUNDATION_GRANT_AUDIT_PROVENANCE_GRANT_INDEX_SQL,
  FOUNDATION_GRANT_MIGRATION_PROVENANCE_NO_UPDATE_TRIGGER_SQL,
  FOUNDATION_GRANT_MIGRATION_PROVENANCE_NO_INSERT_TRIGGER_SQL,
  FOUNDATION_GRANT_MIGRATION_PROVENANCE_NO_DELETE_TRIGGER_SQL,
  FOUNDATION_GRANT_MIGRATION_PROVENANCE_STATE_NO_UPDATE_TRIGGER_SQL,
  FOUNDATION_GRANT_MIGRATION_PROVENANCE_STATE_NO_INSERT_TRIGGER_SQL,
  FOUNDATION_GRANT_MIGRATION_PROVENANCE_STATE_NO_DELETE_TRIGGER_SQL,
  FOUNDATION_GRANT_AUDIT_PROVENANCE_NO_UPDATE_TRIGGER_SQL,
  FOUNDATION_GRANT_AUDIT_PROVENANCE_NO_DELETE_TRIGGER_SQL,
  FOUNDATION_GRANT_AUDIT_PROVENANCE_AFTER_INSERT_TRIGGER_SQL,
  FOUNDATION_GRANT_AUDIT_NO_LEGACY_TAG_INSERT_TRIGGER_SQL,
} from "@/lib/foundation-migrations";
import { computeGrantAuditIntegrityTag } from "@/lib/grant-crypto";
import { readStoredGrantAuditEntry, scanGrantState } from "@/lib/grant-storage-sqlite";
import type { GrantStateValidationContext } from "@/lib/grant-state-validation";
import { GRANT_AUDIT_LEGACY_INTEGRITY_TAG } from "@/lib/grant-types";
import {
  canonicalizeEventGameRecordRoot,
  cloneEventGameRecordRoot,
  validateEventGameRecordRoot,
  type EventGameRecordRoot,
} from "@/lib/foundation-record-types";

type SchemaColumn = {
  name: string;
  type: string;
  notNull: number;
  defaultValue: string | null;
  primaryKeyPosition: number;
};

type SchemaForeignKey = {
  id: number;
  sequence: number;
  table: string;
  from: string;
  to: string;
  onUpdate: string;
  onDelete: string;
  match: string;
};

type SchemaIndex = {
  name: string;
  unique: number;
  origin: string;
  partial: number;
  columns: string[];
};

type FoundationSchemaManifest = {
  objects: readonly {
    type: string;
    name: string;
    tableName: string;
    sql: string;
  }[];
  tables: readonly {
    name: string;
    columns: readonly SchemaColumn[];
    foreignKeys: readonly SchemaForeignKey[];
  }[];
  indexes: readonly SchemaIndex[];
};

const ROOT_TABLE = "foundation_event_game_record_roots";
const SIDE_TABLE = "foundation_event_game_record_sides";
const LEDGER_TABLE = "foundation_migration_ledger";
const ACTION_TABLE = "foundation_event_game_record_actions";
const IDEMPOTENCY_TABLE = "foundation_event_game_record_idempotency";
const METADATA_TABLE = "foundation_event_game_record_metadata";
const AUDIT_TABLE = "foundation_event_game_record_audit";
const GRANT_TABLE = "foundation_grant_roots";
const GRANT_SESSION_TABLE = "foundation_grant_sessions";
const GRANT_AUDIT_TABLE = "foundation_grant_audit";
const PROVENANCE_TABLE = "foundation_control_evidence_provenance";
const GRANT_MIGRATION_PROVENANCE_TABLE = "foundation_grant_migration_provenance";
const GRANT_MIGRATION_PROVENANCE_STATE_TABLE = "foundation_grant_migration_provenance_state";
const GRANT_AUDIT_PROVENANCE_TABLE = "foundation_grant_audit_provenance";

const expectedManifest: FoundationSchemaManifest = {
  objects: [
    object("table", LEDGER_TABLE, LEDGER_TABLE, FOUNDATION_LEDGER_TABLE_SQL),
    object("table", ROOT_TABLE, ROOT_TABLE, FOUNDATION_ROOT_TABLE_SQL),
    object("table", SIDE_TABLE, SIDE_TABLE, FOUNDATION_SIDE_TABLE_SQL),
    object("table", ACTION_TABLE, ACTION_TABLE, FOUNDATION_CURRENT_ACTION_TABLE_SQL),
    object("table", IDEMPOTENCY_TABLE, IDEMPOTENCY_TABLE, FOUNDATION_IDEMPOTENCY_TABLE_SQL),
    object("table", METADATA_TABLE, METADATA_TABLE, FOUNDATION_METADATA_TABLE_SQL),
    object("table", AUDIT_TABLE, AUDIT_TABLE, FOUNDATION_CURRENT_AUDIT_TABLE_SQL),
    object("table", GRANT_TABLE, GRANT_TABLE, FOUNDATION_TYPED_GRANT_TABLE_SQL),
    object(
      "table",
      GRANT_SESSION_TABLE,
      GRANT_SESSION_TABLE,
      FOUNDATION_TYPED_GRANT_SESSION_TABLE_SQL,
    ),
    object(
      "table",
      GRANT_AUDIT_TABLE,
      GRANT_AUDIT_TABLE,
      FOUNDATION_TYPED_GRANT_AUDIT_TABLE_V11_SQL,
    ),
    object("table", PROVENANCE_TABLE, PROVENANCE_TABLE, FOUNDATION_EVIDENCE_PROVENANCE_TABLE_SQL),
    object(
      "trigger",
      "foundation_control_evidence_provenance_no_update",
      PROVENANCE_TABLE,
      FOUNDATION_EVIDENCE_PROVENANCE_UPDATE_TRIGGER_SQL,
    ),
    object(
      "trigger",
      "foundation_control_evidence_provenance_no_delete",
      PROVENANCE_TABLE,
      FOUNDATION_EVIDENCE_PROVENANCE_DELETE_TRIGGER_SQL,
    ),
    object(
      "table",
      GRANT_MIGRATION_PROVENANCE_TABLE,
      GRANT_MIGRATION_PROVENANCE_TABLE,
      FOUNDATION_GRANT_MIGRATION_PROVENANCE_TABLE_SQL,
    ),
    object(
      "table",
      GRANT_MIGRATION_PROVENANCE_STATE_TABLE,
      GRANT_MIGRATION_PROVENANCE_STATE_TABLE,
      FOUNDATION_GRANT_MIGRATION_PROVENANCE_STATE_TABLE_SQL,
    ),
    object(
      "table",
      GRANT_AUDIT_PROVENANCE_TABLE,
      GRANT_AUDIT_PROVENANCE_TABLE,
      FOUNDATION_GRANT_AUDIT_PROVENANCE_TABLE_SQL,
    ),
    object(
      "trigger",
      "foundation_grant_migration_provenance_no_update",
      GRANT_MIGRATION_PROVENANCE_TABLE,
      FOUNDATION_GRANT_MIGRATION_PROVENANCE_NO_UPDATE_TRIGGER_SQL,
    ),
    object(
      "trigger",
      "foundation_grant_migration_provenance_no_insert",
      GRANT_MIGRATION_PROVENANCE_TABLE,
      FOUNDATION_GRANT_MIGRATION_PROVENANCE_NO_INSERT_TRIGGER_SQL,
    ),
    object(
      "trigger",
      "foundation_grant_migration_provenance_no_delete",
      GRANT_MIGRATION_PROVENANCE_TABLE,
      FOUNDATION_GRANT_MIGRATION_PROVENANCE_NO_DELETE_TRIGGER_SQL,
    ),
    object(
      "trigger",
      "foundation_grant_migration_provenance_state_no_update",
      GRANT_MIGRATION_PROVENANCE_STATE_TABLE,
      FOUNDATION_GRANT_MIGRATION_PROVENANCE_STATE_NO_UPDATE_TRIGGER_SQL,
    ),
    object(
      "trigger",
      "foundation_grant_migration_provenance_state_no_insert",
      GRANT_MIGRATION_PROVENANCE_STATE_TABLE,
      FOUNDATION_GRANT_MIGRATION_PROVENANCE_STATE_NO_INSERT_TRIGGER_SQL,
    ),
    object(
      "trigger",
      "foundation_grant_migration_provenance_state_no_delete",
      GRANT_MIGRATION_PROVENANCE_STATE_TABLE,
      FOUNDATION_GRANT_MIGRATION_PROVENANCE_STATE_NO_DELETE_TRIGGER_SQL,
    ),
    object(
      "trigger",
      "foundation_grant_audit_provenance_no_update",
      GRANT_AUDIT_PROVENANCE_TABLE,
      FOUNDATION_GRANT_AUDIT_PROVENANCE_NO_UPDATE_TRIGGER_SQL,
    ),
    object(
      "trigger",
      "foundation_grant_audit_provenance_no_delete",
      GRANT_AUDIT_PROVENANCE_TABLE,
      FOUNDATION_GRANT_AUDIT_PROVENANCE_NO_DELETE_TRIGGER_SQL,
    ),
    object(
      "trigger",
      "foundation_grant_audit_no_legacy_integrity_tag",
      GRANT_AUDIT_TABLE,
      FOUNDATION_GRANT_AUDIT_NO_LEGACY_TAG_INSERT_TRIGGER_SQL,
    ),
    object(
      "trigger",
      "foundation_grant_audit_provenance_after_insert",
      GRANT_AUDIT_TABLE,
      FOUNDATION_GRANT_AUDIT_PROVENANCE_AFTER_INSERT_TRIGGER_SQL,
    ),
    object(
      "index",
      "foundation_event_game_record_roots_event_id",
      ROOT_TABLE,
      FOUNDATION_ROOT_EVENT_INDEX_SQL,
    ),
    object(
      "index",
      "foundation_event_game_record_roots_game_day_id",
      ROOT_TABLE,
      FOUNDATION_ROOT_GAME_DAY_INDEX_SQL,
    ),
    object(
      "index",
      "foundation_event_game_record_sides_record_id",
      SIDE_TABLE,
      FOUNDATION_SIDE_RECORD_INDEX_SQL,
    ),
    object(
      "index",
      "foundation_event_game_record_actions_record_id",
      ACTION_TABLE,
      FOUNDATION_ACTION_RECORD_INDEX_SQL,
    ),
    object(
      "index",
      "foundation_event_game_record_idempotency_record_id",
      IDEMPOTENCY_TABLE,
      FOUNDATION_IDEMPOTENCY_RECORD_INDEX_SQL,
    ),
    object(
      "index",
      "foundation_event_game_record_audit_record_id",
      AUDIT_TABLE,
      FOUNDATION_AUDIT_RECORD_INDEX_SQL,
    ),
    object(
      "index",
      "foundation_grant_sessions_grant_id",
      GRANT_SESSION_TABLE,
      FOUNDATION_GRANT_SESSION_GRANT_INDEX_SQL,
    ),
    object(
      "index",
      "foundation_grant_sessions_active_context",
      GRANT_SESSION_TABLE,
      FOUNDATION_GRANT_SESSION_CONTEXT_INDEX_SQL,
    ),
    object(
      "index",
      "foundation_grant_audit_grant_id",
      GRANT_AUDIT_TABLE,
      FOUNDATION_GRANT_AUDIT_GRANT_INDEX_SQL,
    ),
    object(
      "index",
      "foundation_grant_audit_provenance_grant_id",
      GRANT_AUDIT_PROVENANCE_TABLE,
      FOUNDATION_GRANT_AUDIT_PROVENANCE_GRANT_INDEX_SQL,
    ),
  ].sort(compareNamed),
  tables: [
    {
      name: LEDGER_TABLE,
      columns: [
        column("migration_id", "TEXT", 1, 1),
        column("ordinal", "INTEGER", 1, 0),
        column("schema_version", "INTEGER", 1, 0),
        column("checksum", "TEXT", 1, 0),
        column("status", "TEXT", 1, 0),
        column("applied_at_ms", "INTEGER", 0, 0),
      ],
      foreignKeys: [],
    },
    {
      name: ROOT_TABLE,
      columns: [
        column("record_id", "TEXT", 1, 1),
        column("event_id", "TEXT", 1, 0),
        column("event_game_id", "TEXT", 1, 0),
        column("owner_event_id", "TEXT", 1, 0),
        column("owner_event_game_id", "TEXT", 1, 0),
        column("scope_event_id", "TEXT", 1, 0),
        column("game_day_id", "TEXT", 1, 0),
        column("pitch_id", "TEXT", 1, 0),
        column("pitch_slot_id", "TEXT", 1, 0),
        column("lifecycle_phase", "TEXT", 1, 0),
        column("commenced_at_ms", "INTEGER", 0, 0),
        column("finished_at_ms", "INTEGER", 0, 0),
        column("locked_at_ms", "INTEGER", 0, 0),
        column("lock_reason", "TEXT", 0, 0),
        column("record_version", "TEXT", 1, 0),
        column("schema_version", "TEXT", 1, 0),
        column("interpreter_version", "TEXT", 1, 0),
        column("creation_operation_id", "TEXT", 1, 0),
        column("creation_actor_reference", "TEXT", 1, 0),
        column("creation_source", "TEXT", 1, 0),
        column("creation_created_at_ms", "INTEGER", 1, 0),
        column("canonical_content", "TEXT", 1, 0),
        column("root_json", "TEXT", 1, 0),
      ],
      foreignKeys: [],
    },
    {
      name: SIDE_TABLE,
      columns: [
        column("side_id", "TEXT", 1, 1),
        column("record_id", "TEXT", 1, 0),
        column("side_position", "TEXT", 1, 0),
        column("event_team_id", "TEXT", 1, 0),
        column("team_interpretation_ref", "TEXT", 1, 0),
      ],
      foreignKeys: [
        {
          id: 0,
          sequence: 0,
          table: ROOT_TABLE,
          from: "record_id",
          to: "record_id",
          onUpdate: "NO ACTION",
          onDelete: "CASCADE",
          match: "NONE",
        },
      ],
    },
    {
      name: ACTION_TABLE,
      columns: [
        column("action_id", "TEXT", 1, 1),
        column("record_id", "TEXT", 1, 0),
        column("event_game_id", "TEXT", 1, 0),
        column("operation_id", "TEXT", 1, 0),
        column("action_kind", "TEXT", 1, 0),
        column("action_version", "TEXT", 1, 0),
        column("accepted_at_ms", "INTEGER", 1, 0),
        column("content_fingerprint", "TEXT", 1, 0),
        column("canonical_content", "TEXT", 1, 0),
        column("action_json", "TEXT", 1, 0),
        column("control_action_version", "TEXT", 1, 0, "'control-action-legacy-v0'"),
        column("action_evidence_format", "TEXT", 1, 0, "'legacy'"),
      ],
      foreignKeys: [
        {
          id: 0,
          sequence: 0,
          table: ROOT_TABLE,
          from: "record_id",
          to: "record_id",
          onUpdate: "NO ACTION",
          onDelete: "CASCADE",
          match: "NONE",
        },
      ],
    },
    {
      name: GRANT_TABLE,
      columns: [
        column("grant_id", "TEXT", 1, 1),
        column("grant_type", "TEXT", 1, 0),
        column("grant_version", "TEXT", 1, 0),
        column("event_id", "TEXT", 1, 0),
        column("game_day_id", "TEXT", 1, 0),
        column("pitch_id", "TEXT", 1, 0),
        column("pitch_slot_id", "TEXT", 1, 0),
        column("status", "TEXT", 1, 0),
        column("created_at_ms", "INTEGER", 1, 0),
        column("expires_at_ms", "INTEGER", 0, 0),
        column("credential_format_version", "INTEGER", 1, 0),
        column("credential_kind", "TEXT", 1, 0),
        column("credential_material_state", "TEXT", 1, 0),
        column("encryption_key_version", "TEXT", 0, 0),
        column("lookup_key_version", "TEXT", 0, 0),
        column("credential_iv", "TEXT", 0, 0),
        column("credential_ciphertext", "TEXT", 0, 0),
        column("credential_tag", "TEXT", 0, 0),
        column("credential_lookup_digest", "TEXT", 0, 0),
        column("credential_fingerprint", "TEXT", 1, 0),
      ],
      foreignKeys: [],
    },
    {
      name: GRANT_SESSION_TABLE,
      columns: [
        column("session_id", "TEXT", 1, 1),
        column("grant_id", "TEXT", 1, 0),
        column("grant_version", "TEXT", 1, 0),
        column("event_game_id", "TEXT", 1, 0),
        column("browser_context_digest", "TEXT", 1, 0),
        column("browser_context_key_version", "TEXT", 1, 0),
        column("bearer_material_state", "TEXT", 1, 0),
        column("bearer_lookup_verifier", "TEXT", 0, 0),
        column("bearer_lookup_key_version", "TEXT", 0, 0),
        column("status", "TEXT", 1, 0),
        column("created_at_ms", "INTEGER", 1, 0),
        column("last_active_at_ms", "INTEGER", 1, 0),
        column("revoked_at_ms", "INTEGER", 0, 0),
        column("device_class", "TEXT", 1, 0),
        column("browser_class", "TEXT", 1, 0),
      ],
      foreignKeys: [
        {
          id: 0,
          sequence: 0,
          table: GRANT_TABLE,
          from: "grant_id",
          to: "grant_id",
          onUpdate: "NO ACTION",
          onDelete: "CASCADE",
          match: "NONE",
        },
      ],
    },
    {
      name: IDEMPOTENCY_TABLE,
      columns: [
        column("action_id", "TEXT", 1, 1),
        column("record_id", "TEXT", 1, 0),
        column("operation_id", "TEXT", 1, 0),
        column("content_fingerprint", "TEXT", 1, 0),
        column("accepted_at_ms", "INTEGER", 1, 0),
      ],
      foreignKeys: [
        {
          id: 0,
          sequence: 0,
          table: "foundation_event_game_record_actions",
          from: "record_id",
          to: "record_id",
          onUpdate: "NO ACTION",
          onDelete: "CASCADE",
          match: "NONE",
        },
        {
          id: 0,
          sequence: 1,
          table: "foundation_event_game_record_actions",
          from: "operation_id",
          to: "operation_id",
          onUpdate: "NO ACTION",
          onDelete: "CASCADE",
          match: "NONE",
        },
        {
          id: 1,
          sequence: 0,
          table: ACTION_TABLE,
          from: "action_id",
          to: "action_id",
          onUpdate: "NO ACTION",
          onDelete: "CASCADE",
          match: "NONE",
        },
      ],
    },
    {
      name: METADATA_TABLE,
      columns: [
        column("record_id", "TEXT", 1, 1),
        column("action_count", "INTEGER", 1, 0),
        column("ordering_version", "TEXT", 1, 0),
        column("last_accepted_at_ms", "INTEGER", 0, 0),
        column("updated_at_ms", "INTEGER", 1, 0),
      ],
      foreignKeys: [
        {
          id: 0,
          sequence: 0,
          table: ROOT_TABLE,
          from: "record_id",
          to: "record_id",
          onUpdate: "NO ACTION",
          onDelete: "CASCADE",
          match: "NONE",
        },
      ],
    },
    {
      name: AUDIT_TABLE,
      columns: [
        column("audit_id", "TEXT", 1, 1),
        column("record_id", "TEXT", 1, 0),
        column("event_game_id", "TEXT", 1, 0),
        column("operation_id", "TEXT", 0, 0),
        column("audit_kind", "TEXT", 1, 0),
        column("outcome", "TEXT", 1, 0),
        column("created_at_ms", "INTEGER", 1, 0),
        column("redacted_detail", "TEXT", 1, 0),
        column("audit_json", "TEXT", 1, 0),
        column("audit_version", "TEXT", 1, 0, "'control-audit-legacy-v0'"),
        column("audit_evidence_format", "TEXT", 1, 0, "'legacy'"),
      ],
      foreignKeys: [
        {
          id: 0,
          sequence: 0,
          table: ROOT_TABLE,
          from: "record_id",
          to: "record_id",
          onUpdate: "NO ACTION",
          onDelete: "CASCADE",
          match: "NONE",
        },
      ],
    },
    {
      name: GRANT_AUDIT_TABLE,
      columns: [
        column("audit_id", "TEXT", 1, 1),
        column("action", "TEXT", 1, 0),
        column("outcome", "TEXT", 1, 0),
        column("actor_reference", "TEXT", 1, 0),
        column("grant_id", "TEXT", 1, 0),
        column("grant_type", "TEXT", 1, 0),
        column("grant_version", "TEXT", 1, 0),
        column("event_id", "TEXT", 1, 0),
        column("game_day_id", "TEXT", 1, 0),
        column("pitch_id", "TEXT", 1, 0),
        column("pitch_slot_id", "TEXT", 1, 0),
        column("session_id", "TEXT", 0, 0),
        column("replaced_session_id", "TEXT", 0, 0),
        column("event_game_id", "TEXT", 0, 0),
        column("credential_kind", "TEXT", 0, 0),
        column("credential_fingerprint", "TEXT", 0, 0),
        column("before_status", "TEXT", 0, 0),
        column("after_status", "TEXT", 0, 0),
        column("before_expires_at_ms", "INTEGER", 0, 0),
        column("after_expires_at_ms", "INTEGER", 0, 0),
        column("terminal_reason", "TEXT", 0, 0),
        column("audit_integrity_tag", "TEXT", 1, 0),
        column("created_at_ms", "INTEGER", 1, 0),
      ],
      foreignKeys: [
        {
          id: 0,
          sequence: 0,
          table: GRANT_TABLE,
          from: "grant_id",
          to: "grant_id",
          onUpdate: "NO ACTION",
          onDelete: "CASCADE",
          match: "NONE",
        },
      ],
    },
    {
      name: PROVENANCE_TABLE,
      columns: [
        column("evidence_kind", "TEXT", 1, 1),
        column("evidence_id", "TEXT", 1, 2),
        column("evidence_format", "TEXT", 1, 0),
        column("origin", "TEXT", 1, 0),
      ],
      foreignKeys: [],
    },
    {
      name: GRANT_MIGRATION_PROVENANCE_TABLE,
      columns: [
        column("grant_id", "TEXT", 1, 1),
        column("migration_id", "TEXT", 1, 0),
        column("original_status", "TEXT", 1, 0),
        column("original_grant_version", "TEXT", 1, 0),
        column("original_event_id", "TEXT", 1, 0),
        column("original_game_day_id", "TEXT", 1, 0),
        column("original_pitch_id", "TEXT", 1, 0),
        column("original_pitch_slot_id", "TEXT", 1, 0),
        column("original_created_at_ms", "INTEGER", 1, 0),
        column("original_expires_at_ms", "INTEGER", 0, 0),
        column("retained_opaque_reference", "TEXT", 1, 0),
      ],
      foreignKeys: [
        {
          id: 0,
          sequence: 0,
          table: GRANT_TABLE,
          from: "grant_id",
          to: "grant_id",
          onUpdate: "NO ACTION",
          onDelete: "RESTRICT",
          match: "NONE",
        },
      ],
    },
    {
      name: GRANT_MIGRATION_PROVENANCE_STATE_TABLE,
      columns: [column("state_id", "INTEGER", 0, 1), column("migration_id", "TEXT", 1, 0)],
      foreignKeys: [],
    },
    {
      name: GRANT_AUDIT_PROVENANCE_TABLE,
      columns: [
        column("audit_id", "TEXT", 1, 1),
        column("action", "TEXT", 1, 0),
        column("outcome", "TEXT", 1, 0),
        column("actor_reference", "TEXT", 1, 0),
        column("grant_id", "TEXT", 1, 0),
        column("grant_type", "TEXT", 1, 0),
        column("grant_version", "TEXT", 1, 0),
        column("event_id", "TEXT", 1, 0),
        column("game_day_id", "TEXT", 1, 0),
        column("pitch_id", "TEXT", 1, 0),
        column("pitch_slot_id", "TEXT", 1, 0),
        column("session_id", "TEXT", 0, 0),
        column("replaced_session_id", "TEXT", 0, 0),
        column("event_game_id", "TEXT", 0, 0),
        column("credential_kind", "TEXT", 0, 0),
        column("credential_fingerprint", "TEXT", 0, 0),
        column("before_status", "TEXT", 0, 0),
        column("after_status", "TEXT", 0, 0),
        column("before_expires_at_ms", "INTEGER", 0, 0),
        column("after_expires_at_ms", "INTEGER", 0, 0),
        column("terminal_reason", "TEXT", 0, 0),
        column("audit_integrity_tag", "TEXT", 1, 0),
        column("created_at_ms", "INTEGER", 1, 0),
      ],
      foreignKeys: [
        {
          id: 0,
          sequence: 0,
          table: GRANT_TABLE,
          from: "grant_id",
          to: "grant_id",
          onUpdate: "NO ACTION",
          onDelete: "RESTRICT",
          match: "NONE",
        },
      ],
    },
  ].sort(compareNamed),
  indexes: [
    index("foundation_event_game_record_roots_event_id", 0, ["event_id"]),
    index("foundation_event_game_record_roots_game_day_id", 0, ["scope_event_id", "game_day_id"]),
    index("foundation_event_game_record_sides_record_id", 0, ["record_id"]),
    index("foundation_event_game_record_actions_record_id", 0, ["record_id", "accepted_at_ms"]),
    index("foundation_event_game_record_idempotency_record_id", 0, ["record_id"]),
    index("foundation_event_game_record_audit_record_id", 0, ["record_id", "created_at_ms"]),
    index("foundation_grant_sessions_grant_id", 0, ["grant_id"]),
    index("foundation_grant_sessions_active_context", 1, ["grant_id", "browser_context_digest"], 1),
    index("foundation_grant_audit_grant_id", 0, ["grant_id", "audit_id"]),
    index("foundation_grant_audit_provenance_grant_id", 0, ["grant_id", "audit_id"]),
  ].sort(compareNamed),
};

export const FOUNDATION_SCHEMA_FINGERPRINT = fingerprint(expectedManifest);

export type FoundationSchemaVerification =
  | { ok: true }
  | {
      ok: false;
      status: "missing" | "integrity-failure" | "not-writeable";
      detail: string;
    };

export function hasExpectedFoundationSchema(database: Database): boolean {
  return foundationSchemaFingerprint(database) === FOUNDATION_SCHEMA_FINGERPRINT;
}

export function foundationSchemaFingerprint(database: Database): string {
  return fingerprint(readSchemaManifest(database));
}

export function verifyFoundationSchema(
  database: Database,
  grantValidationContext?: GrantStateValidationContext,
): FoundationSchemaVerification {
  try {
    if (!tableExists(database, ROOT_TABLE)) {
      return {
        ok: false,
        status: "missing",
        detail: "The supported root table is missing.",
      };
    }
    if (!hasExpectedFoundationSchema(database)) {
      return {
        ok: false,
        status: "integrity-failure",
        detail: "SQLite does not contain the supported foundation schema definition.",
      };
    }
    if (
      readPragmaText(database, "quick_check") !== "ok" ||
      readPragmaText(database, "integrity_check") !== "ok"
    ) {
      return {
        ok: false,
        status: "integrity-failure",
        detail: "SQLite integrity checks did not pass.",
      };
    }
    const foreignKeyViolations = database.query("PRAGMA foreign_key_check").all() as unknown[];
    if (foreignKeyViolations.length !== 0) {
      return {
        ok: false,
        status: "integrity-failure",
        detail: "SQLite reported foreign-key violations.",
      };
    }
    if (!canBeginWrite(database)) {
      return {
        ok: false,
        status: "not-writeable",
        detail: "SQLite did not permit a writeability check.",
      };
    }
    scanFoundationRoots(database);
    verifyGrantProvenance(database, grantValidationContext);
    scanFoundationGrantState(database, grantValidationContext);
    return { ok: true };
  } catch {
    return {
      ok: false,
      status: "integrity-failure",
      detail: "SQLite foundation schema verification failed.",
    };
  }
}

export function readValidatedFoundationRoot(
  database: Database,
  row: Record<string, unknown>,
): EventGameRecordRoot {
  const parsed = JSON.parse(readText(row.root_json)) as unknown;
  const validated = validateEventGameRecordRoot(parsed);
  if (!validated.ok) {
    throw new Error("Stored Event Game Record root failed validation.");
  }
  if (canonicalizeEventGameRecordRoot(validated.value) !== readText(row.canonical_content)) {
    throw new Error("Stored Event Game Record root checksum does not match its content.");
  }
  assertRootProjection(row, validated.value);
  assertStoredSides(database, validated.value);
  return cloneEventGameRecordRoot(validated.value);
}

export function scanFoundationRoots(database: Database): void {
  const rows = database
    .query("SELECT * FROM foundation_event_game_record_roots ORDER BY record_id")
    .all() as unknown[];
  for (const value of rows) {
    readValidatedFoundationRoot(database, asRecord(value));
  }
}

function scanFoundationGrantState(
  database: Database,
  grantValidationContext?: GrantStateValidationContext,
): void {
  const invalidGrant = database
    .query(
      `SELECT grant_id FROM foundation_grant_roots
       WHERE (status = 'expired') <> (credential_material_state = 'erased')
       LIMIT 1`,
    )
    .get();
  if (invalidGrant !== null) {
    throw new Error("Stored Grant lifecycle and credential material state do not match.");
  }
  const invalidSession = database
    .query(
      `SELECT session_id FROM foundation_grant_sessions
       WHERE (status = 'expired') <> (bearer_material_state = 'erased')
       LIMIT 1`,
    )
    .get();
  if (invalidSession !== null) {
    throw new Error("Stored Grant Session lifecycle and bearer material state do not match.");
  }
  scanGrantState(database, grantValidationContext);
}

function verifyGrantProvenance(
  database: Database,
  validationContext?: GrantStateValidationContext,
): void {
  const stateRows = database
    .query("SELECT state_id, migration_id FROM foundation_grant_migration_provenance_state")
    .all() as unknown[];
  if (
    stateRows.length !== 1 ||
    readInteger(asRecord(stateRows[0]).state_id) !== 1 ||
    readText(asRecord(stateRows[0]).migration_id) !== "014-grant-provenance-integrity"
  ) {
    throw new Error("Grant migration provenance state is incomplete.");
  }

  const provenanceRows = database
    .query(
      `SELECT grant_id, migration_id, original_status, original_grant_version,
              original_event_id, original_game_day_id, original_pitch_id,
              original_pitch_slot_id, original_created_at_ms, original_expires_at_ms,
              retained_opaque_reference
       FROM foundation_grant_migration_provenance ORDER BY grant_id`,
    )
    .all() as unknown[];
  const provenance = new Map<string, Record<string, unknown>>();
  for (const value of provenanceRows) {
    const row = asRecord(value);
    const grantId = readText(row.grant_id);
    const reference = readText(row.retained_opaque_reference);
    if (
      readText(row.migration_id) !== "006-grant-cryptographic-erasure" ||
      !/^opaque-migration-reference-v1:[a-f0-9]{64}$/.test(reference) ||
      provenance.has(grantId)
    ) {
      throw new Error("Grant migration provenance is invalid.");
    }
    provenance.set(grantId, row);
  }
  const grants = database
    .query("SELECT grant_id, credential_fingerprint FROM foundation_grant_roots ORDER BY grant_id")
    .all() as unknown[];
  for (const value of grants) {
    const row = asRecord(value);
    const grantId = readText(row.grant_id);
    const fingerprint = readText(row.credential_fingerprint);
    const recorded = provenance.get(grantId);
    if (fingerprint.startsWith("opaque-migration-reference-v1:")) {
      if (recorded === undefined || readText(recorded.retained_opaque_reference) !== fingerprint) {
        throw new Error("An opaque migration Grant lacks bound durable provenance.");
      }
    }
  }
  for (const [grantId, row] of provenance) {
    if (!grants.some((value) => readText(asRecord(value).grant_id) === grantId)) {
      throw new Error("Grant migration provenance references an unknown Grant.");
    }
    if (readText(row.original_grant_version).length === 0) {
      throw new Error("Grant migration provenance lacks original Grant evidence.");
    }
  }

  const columns = [
    "audit_id",
    "action",
    "outcome",
    "actor_reference",
    "grant_id",
    "grant_type",
    "grant_version",
    "event_id",
    "game_day_id",
    "pitch_id",
    "pitch_slot_id",
    "session_id",
    "replaced_session_id",
    "event_game_id",
    "credential_kind",
    "credential_fingerprint",
    "before_status",
    "after_status",
    "before_expires_at_ms",
    "after_expires_at_ms",
    "terminal_reason",
    "audit_integrity_tag",
    "created_at_ms",
  ] as const;
  const select = columns.join(", ");
  const current = database
    .query(`SELECT ${select} FROM foundation_grant_audit ORDER BY audit_id`)
    .all() as unknown[];
  const durable = database
    .query(`SELECT ${select} FROM foundation_grant_audit_provenance ORDER BY audit_id`)
    .all() as unknown[];
  for (const value of current) {
    const row = asRecord(value);
    const tag = readText(row.audit_integrity_tag);
    if (tag === GRANT_AUDIT_LEGACY_INTEGRITY_TAG) continue;
    if (validationContext?.keyRing === undefined) {
      throw new Error("Grant Audit Trail integrity cannot be verified.");
    }
    const audit = readStoredGrantAuditEntry(row);
    const tagParts = tag.split(":");
    const keyVersion = tagParts[1];
    if (
      tagParts.length !== 3 ||
      keyVersion === undefined ||
      computeGrantAuditIntegrityTag(audit, validationContext.keyRing, keyVersion) !== tag
    ) {
      throw new Error("Grant Audit Trail integrity is invalid.");
    }
  }
  if (current.length !== durable.length) {
    throw new Error("Grant Audit Trail provenance history is incomplete.");
  }
  for (let index = 0; index < current.length; index += 1) {
    const currentRow = asRecord(current[index]);
    const durableRow = asRecord(durable[index]);
    for (const column of columns) {
      if (currentRow[column] !== durableRow[column]) {
        throw new Error("Grant Audit Trail evidence has been mutated.");
      }
    }
  }
}

function assertStoredSides(database: Database, root: EventGameRecordRoot): void {
  const rows = database
    .query(
      `SELECT side_id, side_position, event_team_id, team_interpretation_ref
       FROM foundation_event_game_record_sides
       WHERE record_id = ?
       ORDER BY side_position`,
    )
    .all(root.recordId) as unknown[];
  if (rows.length !== 2) {
    throw new Error("Stored Event Game Record sides are incomplete.");
  }
  const sides = rows.map((value) => {
    const row = asRecord(value);
    return {
      id: readText(row.side_id),
      position: readText(row.side_position),
      eventTeamId: readText(row.event_team_id),
      teamInterpretationRef: readText(row.team_interpretation_ref),
    };
  });
  const [sideA, sideB] = root.gameSides;
  const storedA = sides.find((side) => side.position === "a");
  const storedB = sides.find((side) => side.position === "b");
  if (
    storedA === undefined ||
    storedB === undefined ||
    storedA.id !== sideA.id ||
    storedA.eventTeamId !== sideA.eventTeamId ||
    storedA.teamInterpretationRef !== sideA.teamInterpretationRef ||
    storedB.id !== sideB.id ||
    storedB.eventTeamId !== sideB.eventTeamId ||
    storedB.teamInterpretationRef !== sideB.teamInterpretationRef
  ) {
    throw new Error("Stored Event Game Record sides do not match the semantic root.");
  }
}

function assertRootProjection(row: Record<string, unknown>, root: EventGameRecordRoot): void {
  const expectedText: readonly [string, string][] = [
    ["record_id", root.recordId],
    ["event_id", root.eventId],
    ["event_game_id", root.eventGameId],
    ["owner_event_id", root.ownership.eventId],
    ["owner_event_game_id", root.ownership.eventGameId],
    ["scope_event_id", root.externalScope.eventId],
    ["game_day_id", root.externalScope.gameDayId],
    ["pitch_id", root.externalScope.pitchId],
    ["pitch_slot_id", root.externalScope.pitchSlotId],
    ["lifecycle_phase", root.lifecycle.phase],
    ["record_version", root.compatibility.recordVersion],
    ["schema_version", root.compatibility.schemaVersion],
    ["interpreter_version", root.compatibility.interpreterVersion],
    ["creation_operation_id", root.creationEvidence.operationId],
    ["creation_actor_reference", root.creationEvidence.actorReference],
    ["creation_source", root.creationEvidence.source],
  ];
  for (const [field, expected] of expectedText) {
    if (readText(row[field]) !== expected) {
      throw new Error("Stored Event Game Record projection does not match its semantic root.");
    }
  }
  const expectedNullableNumbers: readonly [string, number | null][] = [
    ["commenced_at_ms", root.lifecycle.commencedAtMs],
    ["finished_at_ms", root.lifecycle.finishedAtMs],
    ["locked_at_ms", root.lifecycle.lockedAtMs],
  ];
  for (const [field, expected] of expectedNullableNumbers) {
    if (readNullableInteger(row[field]) !== expected) {
      throw new Error("Stored Event Game Record timestamps do not match their semantic root.");
    }
  }
  if (readNullableText(row.lock_reason) !== root.lifecycle.lockReason) {
    throw new Error("Stored Event Game Record lock state does not match its semantic root.");
  }
  if (readInteger(row.creation_created_at_ms) !== root.creationEvidence.createdAtMs) {
    throw new Error("Stored Event Game Record creation evidence does not match its semantic root.");
  }
}

function readSchemaManifest(database: Database): FoundationSchemaManifest {
  const objects = (
    database
      .query(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as unknown[]
  ).map((value) => {
    const row = asRecord(value);
    return object(
      readText(row.type),
      readText(row.name),
      readText(row.tbl_name),
      readText(row.sql),
    );
  });

  const tables = [
    LEDGER_TABLE,
    ROOT_TABLE,
    SIDE_TABLE,
    ACTION_TABLE,
    IDEMPOTENCY_TABLE,
    METADATA_TABLE,
    AUDIT_TABLE,
    GRANT_TABLE,
    GRANT_SESSION_TABLE,
    GRANT_AUDIT_TABLE,
    PROVENANCE_TABLE,
    GRANT_MIGRATION_PROVENANCE_TABLE,
    GRANT_MIGRATION_PROVENANCE_STATE_TABLE,
    GRANT_AUDIT_PROVENANCE_TABLE,
  ].map((name) => ({
    name,
    columns: readColumns(database, name),
    foreignKeys: readForeignKeys(database, name),
  }));
  const indexes = [
    "foundation_event_game_record_roots_event_id",
    "foundation_event_game_record_roots_game_day_id",
    "foundation_event_game_record_sides_record_id",
    "foundation_event_game_record_actions_record_id",
    "foundation_event_game_record_idempotency_record_id",
    "foundation_event_game_record_audit_record_id",
    "foundation_grant_sessions_grant_id",
    "foundation_grant_sessions_active_context",
    "foundation_grant_audit_grant_id",
    "foundation_grant_audit_provenance_grant_id",
  ].map((name) => readIndex(database, name));

  return {
    objects: objects.sort(compareNamed),
    tables: tables.sort(compareNamed),
    indexes: indexes.sort(compareNamed),
  };
}

function tableExists(database: Database, name: string): boolean {
  return (
    database
      .query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== null
  );
}

function canBeginWrite(database: Database): boolean {
  if (database.inTransaction) return true;
  try {
    database.exec("BEGIN IMMEDIATE; ROLLBACK;");
    return true;
  } catch {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // The verification result is the useful boundary for callers.
    }
    return false;
  }
}

function readPragmaText(database: Database, name: "quick_check" | "integrity_check"): string {
  const value = database.query(`PRAGMA ${name}`).get();
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    if (name in row) return readText(row[name]);
  }
  return readText(value);
}

function readColumns(database: Database, tableName: string): SchemaColumn[] {
  return (
    database.query(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as unknown[]
  ).map((value) => {
    const row = asRecord(value);
    return {
      name: readText(row.name),
      type: readText(row.type),
      notNull: readInteger(row.notnull),
      defaultValue: row.dflt_value === null ? null : readText(row.dflt_value),
      primaryKeyPosition: readInteger(row.pk),
    };
  });
}

function readForeignKeys(database: Database, tableName: string): SchemaForeignKey[] {
  return (
    database.query(`PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`).all() as unknown[]
  ).map((value) => {
    const row = asRecord(value);
    return {
      id: readInteger(row.id),
      sequence: readInteger(row.seq),
      table: readText(row.table),
      from: readText(row.from),
      to: readText(row.to),
      onUpdate: readText(row.on_update),
      onDelete: readText(row.on_delete),
      match: readText(row.match),
    };
  });
}

function readIndex(database: Database, name: string): SchemaIndex {
  const indexRows = database
    .query(`PRAGMA index_list(${quoteIdentifier(indexTable(name))})`)
    .all() as unknown[];
  const indexRow = indexRows.map(asRecord).find((row) => readText(row.name) === name);
  if (indexRow === undefined) {
    throw new Error(`Expected SQLite index ${name} is missing.`);
  }
  const columns = (database.query(`PRAGMA index_info(${quoteIdentifier(name)})`).all() as unknown[])
    .map(asRecord)
    .sort((left, right) => readInteger(left.seqno) - readInteger(right.seqno))
    .map((row) => readText(row.name));
  return {
    name,
    unique: readInteger(indexRow.unique),
    origin: readText(indexRow.origin),
    partial: readInteger(indexRow.partial),
    columns,
  };
}

function indexTable(name: string): string {
  if (name.startsWith("foundation_grant_sessions")) return GRANT_SESSION_TABLE;
  if (name.startsWith("foundation_grant_audit_provenance")) return GRANT_AUDIT_PROVENANCE_TABLE;
  if (name.startsWith("foundation_grant_audit")) return GRANT_AUDIT_TABLE;
  if (name.includes("sides")) return SIDE_TABLE;
  if (name.includes("actions")) return ACTION_TABLE;
  if (name.includes("idempotency")) return IDEMPOTENCY_TABLE;
  if (name.includes("audit")) return AUDIT_TABLE;
  return ROOT_TABLE;
}

function object(
  type: string,
  name: string,
  tableName: string,
  sql: string,
): FoundationSchemaManifest["objects"][number] {
  return { type, name, tableName, sql: normalizeSql(sql) };
}

function column(
  name: string,
  type: string,
  notNull: number,
  primaryKeyPosition: number,
  defaultValue: string | null = null,
): SchemaColumn {
  return {
    name,
    type,
    notNull,
    defaultValue,
    primaryKeyPosition,
  };
}

function index(name: string, unique: number, columns: string[], partial = 0): SchemaIndex {
  return { name, unique, origin: "c", partial, columns };
}

function fingerprint(manifest: FoundationSchemaManifest): string {
  return createHash("sha256").update(JSON.stringify(manifest), "utf8").digest("hex");
}

function normalizeSql(sql: string): string {
  return sql
    .replaceAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g, "$1")
    .replaceAll(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function compareNamed(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("SQLite returned an invalid schema row.");
  }
  return value as Record<string, unknown>;
}

function readText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  throw new Error("SQLite returned an invalid schema value.");
}

function readInteger(value: unknown): number {
  const parsed = Number(readText(value));
  if (!Number.isSafeInteger(parsed)) throw new Error("SQLite returned an invalid schema integer.");
  return parsed;
}

function readNullableInteger(value: unknown): number | null {
  return value === null ? null : readInteger(value);
}

function readNullableText(value: unknown): string | null {
  return value === null ? null : readText(value);
}
