import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { canonicalizeJson } from "@/lib/event-game-action-json";
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
  FOUNDATION_TYPED_GRANT_AUDIT_TABLE_V16_SQL,
  FOUNDATION_GRANT_SESSION_CONTEXT_INDEX_SQL,
  FOUNDATION_GRANT_SESSION_GRANT_INDEX_SQL,
  FOUNDATION_EVIDENCE_PROVENANCE_TABLE_SQL,
  FOUNDATION_EVIDENCE_PROVENANCE_UPDATE_TRIGGER_SQL,
  FOUNDATION_EVIDENCE_PROVENANCE_DELETE_TRIGGER_SQL,
  FOUNDATION_TYPED_GRANT_TABLE_SQL,
  FOUNDATION_TYPED_GRANT_SESSION_TABLE_SQL,
  FOUNDATION_GRANT_MIGRATION_PROVENANCE_TABLE_SQL,
  FOUNDATION_GRANT_MIGRATION_PROVENANCE_STATE_TABLE_SQL,
  FOUNDATION_GRANT_AUDIT_PROVENANCE_TABLE_V16_SQL,
  FOUNDATION_GRANT_AUDIT_PROVENANCE_GRANT_INDEX_SQL,
  FOUNDATION_GRANT_MIGRATION_PROVENANCE_NO_UPDATE_TRIGGER_SQL,
  FOUNDATION_GRANT_MIGRATION_PROVENANCE_NO_INSERT_TRIGGER_SQL,
  FOUNDATION_GRANT_MIGRATION_PROVENANCE_NO_DELETE_TRIGGER_SQL,
  FOUNDATION_GRANT_MIGRATION_PROVENANCE_STATE_NO_UPDATE_TRIGGER_SQL,
  FOUNDATION_GRANT_MIGRATION_PROVENANCE_STATE_NO_INSERT_TRIGGER_SQL,
  FOUNDATION_GRANT_MIGRATION_PROVENANCE_STATE_NO_DELETE_TRIGGER_SQL,
  FOUNDATION_GRANT_AUDIT_PROVENANCE_NO_UPDATE_TRIGGER_SQL,
  FOUNDATION_GRANT_AUDIT_PROVENANCE_NO_DELETE_TRIGGER_SQL,
  FOUNDATION_GRANT_AUDIT_PROVENANCE_AFTER_INSERT_TRIGGER_V16_SQL,
  FOUNDATION_GRANT_AUDIT_NO_LEGACY_TAG_INSERT_TRIGGER_SQL,
  FOUNDATION_EVENT_CATALOG_EVENTS_TABLE_SQL,
  FOUNDATION_EVENT_CATALOG_GAME_DAYS_TABLE_SQL,
  FOUNDATION_EVENT_CATALOG_AUDIT_TABLE_SQL,
  FOUNDATION_EVENT_CATALOG_GAME_DAYS_EVENT_INDEX_SQL,
  FOUNDATION_EVENT_CATALOG_AUDIT_EVENT_INDEX_SQL,
} from "@/lib/foundation-migrations";
import {
  computeGrantAuditIntegrityTag,
  computeLegacyGrantAuditIntegrityTag,
  computeAcceptanceIntegrityTag,
} from "@/lib/grant-crypto";
import { readStoredGrantAuditEntry, scanGrantState } from "@/lib/grant-storage-sqlite";
import type { GrantStateValidationContext } from "@/lib/grant-state-validation";
import { GRANT_AUDIT_LEGACY_INTEGRITY_TAG } from "@/lib/grant-types";
import {
  anchorFor,
  acceptanceAuditPairFailure,
  replayAttemptResultFailure,
} from "@/lib/foundation-acceptance-integrity";
import type { AcceptanceIntegritySubject } from "@/lib/foundation-acceptance-integrity";
import type { GrantKeyRing, StoredGrantAuditEntry } from "@/lib/grant-types";
import type {
  StoredControlAuditEntry,
  StoredReplayAttempt,
  StoredReplayReceipt,
  StoredReplayReservation,
} from "@/lib/foundation-storage";
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
const EVENT_CATALOG_EVENTS_TABLE = "foundation_event_catalog_events";
const EVENT_CATALOG_GAME_DAYS_TABLE = "foundation_event_catalog_game_days";
const EVENT_CATALOG_AUDIT_TABLE = "foundation_event_catalog_audit";

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
      FOUNDATION_TYPED_GRANT_AUDIT_TABLE_V16_SQL,
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
      FOUNDATION_GRANT_AUDIT_PROVENANCE_TABLE_V16_SQL,
    ),
    object(
      "table",
      EVENT_CATALOG_EVENTS_TABLE,
      EVENT_CATALOG_EVENTS_TABLE,
      FOUNDATION_EVENT_CATALOG_EVENTS_TABLE_SQL,
    ),
    object(
      "table",
      EVENT_CATALOG_GAME_DAYS_TABLE,
      EVENT_CATALOG_GAME_DAYS_TABLE,
      FOUNDATION_EVENT_CATALOG_GAME_DAYS_TABLE_SQL,
    ),
    object(
      "table",
      EVENT_CATALOG_AUDIT_TABLE,
      EVENT_CATALOG_AUDIT_TABLE,
      FOUNDATION_EVENT_CATALOG_AUDIT_TABLE_SQL,
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
      FOUNDATION_GRANT_AUDIT_PROVENANCE_AFTER_INSERT_TRIGGER_V16_SQL,
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
    object(
      "index",
      "foundation_event_catalog_game_days_event_id",
      EVENT_CATALOG_GAME_DAYS_TABLE,
      FOUNDATION_EVENT_CATALOG_GAME_DAYS_EVENT_INDEX_SQL,
    ),
    object(
      "index",
      "foundation_event_catalog_audit_event_id",
      EVENT_CATALOG_AUDIT_TABLE,
      FOUNDATION_EVENT_CATALOG_AUDIT_EVENT_INDEX_SQL,
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
        column("previous_event_game_id", "TEXT", 0, 0),
        column("replay_evidence_id", "TEXT", 0, 0),
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
        column("previous_event_game_id", "TEXT", 0, 0),
        column("replay_evidence_id", "TEXT", 0, 0),
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
    {
      name: EVENT_CATALOG_EVENTS_TABLE,
      columns: [
        column("event_id", "TEXT", 1, 1),
        column("name", "TEXT", 1, 0),
        column("time_zone", "TEXT", 1, 0),
        column("publication_status", "TEXT", 1, 0),
        column("created_at_ms", "INTEGER", 1, 0),
        column("updated_at_ms", "INTEGER", 1, 0),
      ],
      foreignKeys: [],
    },
    {
      name: EVENT_CATALOG_GAME_DAYS_TABLE,
      columns: [
        column("game_day_id", "TEXT", 1, 1),
        column("event_id", "TEXT", 1, 0),
        column("game_day_date", "TEXT", 1, 0),
        column("created_at_ms", "INTEGER", 1, 0),
        column("updated_at_ms", "INTEGER", 1, 0),
      ],
      foreignKeys: [
        {
          id: 0,
          sequence: 0,
          table: EVENT_CATALOG_EVENTS_TABLE,
          from: "event_id",
          to: "event_id",
          onUpdate: "NO ACTION",
          onDelete: "CASCADE",
          match: "NONE",
        },
      ],
    },
    {
      name: EVENT_CATALOG_AUDIT_TABLE,
      columns: [
        column("audit_id", "TEXT", 1, 1),
        column("operation_id", "TEXT", 1, 0),
        column("action", "TEXT", 1, 0),
        column("event_id", "TEXT", 1, 0),
        column("game_day_id", "TEXT", 0, 0),
        column("actor_reference", "TEXT", 1, 0),
        column("occurred_at_ms", "INTEGER", 1, 0),
        column("before_json", "TEXT", 0, 0),
        column("after_json", "TEXT", 1, 0),
      ],
      foreignKeys: [],
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
    index("foundation_event_catalog_game_days_event_id", 0, ["event_id", "game_day_date"]),
    index("foundation_event_catalog_audit_event_id", 0, ["event_id", "occurred_at_ms", "audit_id"]),
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

function hasComposedAcceptanceSchema(database: Database): boolean {
  const requiredTables = [
    "foundation_acceptance_budgets",
    "foundation_replay_reservations",
    "foundation_replay_attempts",
    "foundation_replay_receipts",
    "foundation_acceptance_integrity_anchors",
  ];
  if (
    requiredTables.some(
      (name) =>
        database
          .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(name) === null,
    )
  )
    return false;
  const expectedColumns: Record<string, readonly string[]> = {
    foundation_acceptance_budgets: [
      "bucket_id",
      "bucket_kind",
      "subject_id",
      "capacity",
      "refill_per_second",
      "tokens",
      "updated_at_ms",
      "state_revision",
    ],
    foundation_replay_reservations: [
      "reservation_id",
      "record_id",
      "event_game_id",
      "originating_session_id",
      "replacement_session_id",
      "action_count",
      "status",
      "batch_digest",
      "created_at_ms",
      "committed_at_ms",
      "acknowledged_at_ms",
      "state_revision",
    ],
    foundation_replay_attempts: [
      "attempt_id",
      "reservation_id",
      "operation_id",
      "status",
      "action_fingerprint",
      "result_json",
      "control_audit_id",
      "grant_audit_id",
      "created_at_ms",
      "completed_at_ms",
      "state_revision",
    ],
    foundation_replay_receipts: [
      "receipt_id",
      "reservation_id",
      "receipt_digest",
      "receipt_key_version",
      "status",
      "action_count",
      "created_at_ms",
      "acknowledged_at_ms",
      "state_revision",
    ],
    foundation_acceptance_integrity_anchors: [
      "anchor_id",
      "subject_kind",
      "subject_id",
      "state_revision",
      "key_version",
      "integrity_tag",
      "canonical_value",
    ],
  };
  for (const [table, columns] of Object.entries(expectedColumns)) {
    const actual = database
      .query(`PRAGMA table_info(${table})`)
      .all()
      .map((value) => String((value as Record<string, unknown>).name));
    if (actual.length !== columns.length || actual.some((name, index) => name !== columns[index]))
      return false;
  }
  const requiredIndexes = [
    "foundation_replay_reservations_record_id",
    "foundation_replay_attempts_reservation_id",
  ];
  if (
    requiredIndexes.some(
      (name) =>
        database
          .query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get(name) === null,
    )
  )
    return false;
  const requiredTriggers = [
    "foundation_acceptance_integrity_anchors_no_update",
    "foundation_acceptance_integrity_anchors_no_delete",
    "foundation_grant_audit_no_legacy_integrity_tag",
    "foundation_grant_audit_provenance_after_insert",
  ];
  if (
    requiredTriggers.some(
      (name) =>
        database
          .query("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?")
          .get(name) === null,
    )
  )
    return false;
  const receiptColumns = database
    .query("PRAGMA table_info(foundation_replay_receipts)")
    .all()
    .map((value) => String((value as Record<string, unknown>).name));
  if (!receiptColumns.includes("receipt_key_version")) return false;
  const columns = database
    .query("PRAGMA table_info(foundation_grant_audit)")
    .all()
    .map((value) => String((value as Record<string, unknown>).name));
  return [
    "acceptance_id",
    "control_audit_id",
    "control_action_id",
    "content_fingerprint",
    "outcome_detail",
  ].every((name) => columns.includes(name));
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
    const composedAcceptance = hasComposedAcceptanceSchema(database);
    if (!hasExpectedFoundationSchema(database) && !composedAcceptance) {
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
    if (composedAcceptance)
      verifyComposedAcceptanceState(database, grantValidationContext?.keyRing);
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

function verifyComposedAcceptanceState(database: Database, keyRing?: GrantKeyRing): void {
  const anchors = database
    .query("SELECT * FROM foundation_acceptance_integrity_anchors ORDER BY anchor_id")
    .all() as unknown[];
  if (
    keyRing === undefined &&
    (anchors.length !== 0 ||
      database.query("SELECT 1 FROM foundation_acceptance_budgets LIMIT 1").get() !== null ||
      database.query("SELECT 1 FROM foundation_replay_reservations LIMIT 1").get() !== null ||
      database.query("SELECT 1 FROM foundation_replay_attempts LIMIT 1").get() !== null ||
      database.query("SELECT 1 FROM foundation_replay_receipts LIMIT 1").get() !== null)
  )
    throw new Error("Acceptance integrity key material is unavailable.");
  if (keyRing === undefined) return;
  const budgets = database.query("SELECT * FROM foundation_acceptance_budgets").all() as unknown[];
  for (const value of budgets) {
    const row = asRecord(value);
    const kind = readText(row.bucket_kind);
    const subject = readText(row.subject_id);
    const capacity = readInteger(row.capacity);
    const refill = readInteger(row.refill_per_second);
    const tokens = readReal(row.tokens);
    if (
      readText(row.bucket_id) !== `budget-${kind}:${subject}` ||
      !["online-session", "online-event", "replay-session"].includes(kind) ||
      capacity <= 0 ||
      refill <= 0 ||
      tokens < 0 ||
      tokens > capacity ||
      !Number.isSafeInteger(readInteger(row.updated_at_ms)) ||
      !Number.isSafeInteger(readInteger(row.state_revision)) ||
      !verifyAcceptanceAnchor(
        database,
        anchors,
        "budget",
        readText(row.bucket_id),
        readInteger(row.state_revision),
        row,
        keyRing,
      )
    )
      throw new Error("Acceptance budget state is inconsistent.");
  }

  const reservations = database
    .query(
      `SELECT reservations.*, roots.event_game_id AS root_event_game_id
       FROM foundation_replay_reservations AS reservations
       LEFT JOIN foundation_event_game_record_roots AS roots ON roots.record_id = reservations.record_id`,
    )
    .all() as unknown[];
  const reservationIds = new Set<string>();
  const reservationCounts = new Map<string, number>();
  for (const value of reservations) {
    const row = asRecord(value);
    const reservationId = readText(row.reservation_id);
    const status = readText(row.status);
    const count = readInteger(row.action_count);
    const digest = readNullableText(row.batch_digest);
    if (
      reservationIds.has(reservationId) ||
      readText(row.root_event_game_id) !== readText(row.event_game_id) ||
      count <= 0 ||
      digest === null ||
      !/^[a-f0-9]{64}$/.test(digest) ||
      !["reserved", "committing", "committed", "partial", "discarded", "acknowledged"].includes(
        status,
      ) ||
      !verifyAcceptanceAnchor(
        database,
        anchors,
        "reservation",
        reservationId,
        readInteger(row.state_revision),
        row,
        keyRing,
      )
    )
      throw new Error("Replay reservation state is inconsistent.");
    const committedAt = readNullableInteger(row.committed_at_ms);
    const acknowledgedAt = readNullableInteger(row.acknowledged_at_ms);
    if (
      ((status === "committed" || status === "acknowledged") && committedAt === null) ||
      (status === "acknowledged" && acknowledgedAt === null) ||
      (status === "discarded" && (committedAt !== null || acknowledgedAt !== null))
    )
      throw new Error("Replay reservation timestamps are inconsistent.");
    if (
      status === "discarded" &&
      (digest !== null || readNullableText(row.replacement_session_id) !== null)
    )
      throw new Error("Discarded replay retained authorization provenance.");
    reservationIds.add(reservationId);
    reservationCounts.set(reservationId, count);
  }

  const attempts = database.query("SELECT * FROM foundation_replay_attempts").all() as unknown[];
  const attemptsByReservation = new Map<string, number>();
  for (const value of attempts) {
    const row = asRecord(value);
    const fingerprint = readNullableText(row.action_fingerprint);
    const resultJson = readNullableText(row.result_json);
    if (
      !reservationIds.has(readText(row.reservation_id)) ||
      readText(row.operation_id).length === 0 ||
      (fingerprint !== null && !/^[a-f0-9]{64}$/.test(fingerprint)) ||
      (resultJson !== null && !isValidJsonObject(resultJson)) ||
      (readNullableText(row.control_audit_id) === null) !== (resultJson === null) ||
      (readNullableText(row.grant_audit_id) === null) !== (resultJson === null) ||
      !verifyAcceptanceAnchor(
        database,
        anchors,
        "attempt",
        readText(row.attempt_id),
        readInteger(row.state_revision),
        row,
        keyRing,
      )
    )
      throw new Error("Replay attempt state is inconsistent.");
    if (resultJson === null || !isValidJsonObject(resultJson))
      throw new Error("Replay attempt result evidence is missing.");
    if (canonicalizeJson(JSON.parse(resultJson)) !== resultJson)
      throw new Error("Replay attempt result JSON is not canonical.");
    const result = JSON.parse(resultJson) as { status?: string };
    const status = readText(row.status);
    if (
      typeof result.status !== "string" ||
      (status === "accepted" && result.status !== "accepted") ||
      (status === "duplicate-accepted" && result.status !== "duplicate-accepted") ||
      (status === "retry-later" && result.status !== "retry-later") ||
      (status === "rejected" &&
        !["rejected", "dependency-blocked", "authority-expired"].includes(result.status))
    )
      throw new Error("Replay attempt result status is inconsistent.");
    const createdAt = readInteger(row.created_at_ms);
    const completedAt = readNullableInteger(row.completed_at_ms);
    if (
      (status === "retry-later") !== (completedAt === null) ||
      createdAt < 0 ||
      (completedAt !== null && completedAt < 0)
    )
      throw new Error("Replay attempt timestamps are inconsistent.");
    const reservationId = readText(row.reservation_id);
    attemptsByReservation.set(reservationId, (attemptsByReservation.get(reservationId) ?? 0) + 1);
  }
  for (const value of reservations) {
    const row = asRecord(value);
    const status = readText(row.status);
    const attemptsCount = attemptsByReservation.get(readText(row.reservation_id)) ?? 0;
    const receiptsCount = database
      .query("SELECT COUNT(*) AS count FROM foundation_replay_receipts WHERE reservation_id = ?")
      .get(readText(row.reservation_id));
    const receiptCount = readInteger(asRecord(receiptsCount).count);
    if (
      (status === "reserved" && (attemptsCount !== 0 || receiptCount !== 0)) ||
      (status === "partial" &&
        (attemptsCount === 0 ||
          attemptsCount > readInteger(row.action_count) ||
          receiptCount !== 0)) ||
      ((status === "committed" || status === "acknowledged") &&
        (attemptsCount !== readInteger(row.action_count) || receiptCount !== 1)) ||
      (status === "discarded" && (attemptsCount !== 0 || receiptCount !== 0))
    )
      throw new Error("Replay evidence cardinality is inconsistent.");
  }

  const receipts = database.query("SELECT * FROM foundation_replay_receipts").all() as unknown[];
  for (const value of receipts) {
    const row = asRecord(value);
    const reservationId = readText(row.reservation_id);
    if (
      !reservationIds.has(reservationId) ||
      readInteger(row.action_count) !== reservationCounts.get(reservationId) ||
      !/^[a-f0-9]{64}$/.test(readText(row.receipt_digest)) ||
      readText(row.receipt_key_version).length === 0 ||
      !["committed", "acknowledged"].includes(readText(row.status)) ||
      !verifyAcceptanceAnchor(
        database,
        anchors,
        "receipt",
        readText(row.receipt_id),
        readInteger(row.state_revision),
        row,
        keyRing,
      )
    )
      throw new Error("Replay receipt state is inconsistent.");
    const receiptStatus = readText(row.status);
    const acknowledgedAt = readNullableInteger(row.acknowledged_at_ms);
    if (
      (receiptStatus === "acknowledged") !== (acknowledgedAt !== null) ||
      readInteger(row.created_at_ms) < 0
    )
      throw new Error("Replay receipt timestamps are inconsistent.");
  }

  const currentRevisions = new Map<string, number>();
  for (const value of budgets) {
    const row = asRecord(value);
    currentRevisions.set(`budget:${readText(row.bucket_id)}`, readInteger(row.state_revision));
  }
  for (const value of reservations) {
    const row = asRecord(value);
    currentRevisions.set(
      `reservation:${readText(row.reservation_id)}`,
      readInteger(row.state_revision),
    );
  }
  for (const value of attempts) {
    const row = asRecord(value);
    currentRevisions.set(
      `attempt:${readText(row.reservation_id)}:${readText(row.attempt_id)}`,
      readInteger(row.state_revision),
    );
  }
  for (const value of receipts) {
    const row = asRecord(value);
    currentRevisions.set(`receipt:${readText(row.receipt_id)}`, readInteger(row.state_revision));
  }
  const anchorGroups = new Map<string, Record<string, unknown>[]>();
  for (const value of anchors) {
    const row = asRecord(value);
    const subjectKind = readText(row.subject_kind) as AcceptanceIntegritySubject;
    const subjectId = readText(row.subject_id);
    const revision = readInteger(row.state_revision);
    const canonicalValue = readText(row.canonical_value);
    let parsed: unknown;
    try {
      parsed = JSON.parse(canonicalValue) as unknown;
    } catch {
      throw new Error("Acceptance integrity anchor evidence is not valid JSON.");
    }
    if (
      !["budget", "reservation", "attempt", "receipt"].includes(subjectKind) ||
      canonicalizeJson(parsed) !== canonicalValue ||
      readText(row.anchor_id) !== `${subjectKind}:${subjectId}:${revision}`
    )
      throw new Error("Acceptance integrity anchor identity is inconsistent.");
    let expectedTag: string;
    try {
      expectedTag = computeAcceptanceIntegrityTag(
        canonicalizeJson({
          domain: "foundation-acceptance-state-v1",
          subjectKind,
          subjectId,
          stateRevision: revision,
          value: parsed,
        }),
        keyRing,
        readText(row.key_version),
      );
    } catch {
      throw new Error("Acceptance integrity anchor key material is unavailable.");
    }
    if (readText(row.integrity_tag) !== expectedTag)
      throw new Error("Acceptance integrity anchor authentication failed.");
    const key = `${subjectKind}:${subjectId}`;
    const group = anchorGroups.get(key) ?? [];
    group.push(row);
    anchorGroups.set(key, group);
  }
  for (const [key, group] of anchorGroups) {
    const current = currentRevisions.get(key);
    if (current === undefined || group.length !== current) {
      throw new Error("Acceptance integrity anchor history is missing or orphaned.");
    }
    const revisions = group.map((row) => readInteger(row.state_revision)).sort((a, b) => a - b);
    if (revisions.some((revision, index) => revision !== index + 1))
      throw new Error("Acceptance integrity anchor history is not contiguous.");
  }
  if (anchorGroups.size !== currentRevisions.size)
    throw new Error("Acceptance integrity anchor history has an extra or missing subject.");
  for (const value of anchors) {
    const row = asRecord(value);
    const key = `${readText(row.subject_kind)}:${readText(row.subject_id)}`;
    const currentRevision = currentRevisions.get(key);
    if (currentRevision === undefined) {
      const subject = readText(row.subject_id);
      const separator = subject.lastIndexOf(":");
      const reservationId = separator > 0 ? subject.slice(0, separator) : "";
      const discarded = database
        .query(
          "SELECT 1 FROM foundation_replay_reservations WHERE reservation_id = ? AND status = 'discarded'",
        )
        .get(reservationId);
      if (readText(row.subject_kind) !== "attempt" || discarded === null)
        throw new Error("Acceptance integrity anchor is orphaned.");
      continue;
    }
    if (readInteger(row.state_revision) > currentRevision)
      throw new Error("Acceptance integrity anchor is orphaned.");
  }
  const maximumAnchorRevision = new Map<string, number>();
  for (const value of anchors) {
    const row = asRecord(value);
    const key = `${readText(row.subject_kind)}:${readText(row.subject_id)}`;
    maximumAnchorRevision.set(
      key,
      Math.max(maximumAnchorRevision.get(key) ?? 0, readInteger(row.state_revision)),
    );
  }
  for (const value of budgets) {
    const row = asRecord(value);
    if (
      maximumAnchorRevision.get(`budget:${readText(row.bucket_id)}`) !==
      readInteger(row.state_revision)
    )
      throw new Error("Acceptance integrity history is not monotonic.");
  }
  for (const value of reservations) {
    const row = asRecord(value);
    if (
      maximumAnchorRevision.get(`reservation:${readText(row.reservation_id)}`) !==
      readInteger(row.state_revision)
    )
      throw new Error("Acceptance integrity history is not monotonic.");
  }
  for (const value of attempts) {
    const row = asRecord(value);
    if (
      maximumAnchorRevision.get(
        `attempt:${readText(row.reservation_id)}:${readText(row.attempt_id)}`,
      ) !== readInteger(row.state_revision)
    )
      throw new Error("Acceptance integrity history is not monotonic.");
  }
  for (const value of receipts) {
    const row = asRecord(value);
    if (
      maximumAnchorRevision.get(`receipt:${readText(row.receipt_id)}`) !==
      readInteger(row.state_revision)
    )
      throw new Error("Acceptance integrity history is not monotonic.");
  }

  const controlAudits = database
    .query("SELECT * FROM foundation_event_game_record_audit ORDER BY audit_id")
    .all()
    .map((value) => JSON.parse(readText(asRecord(value).audit_json)) as StoredControlAuditEntry);
  const grantAudits = database
    .query("SELECT * FROM foundation_grant_audit ORDER BY audit_id")
    .all()
    .map((value) => readStoredGrantAuditEntry(asRecord(value)));
  const controlsById = new Map(controlAudits.map((audit) => [audit.auditId, audit]));
  const grantsById = new Map(grantAudits.map((audit) => [audit.auditId, audit]));
  const actionEvidence = new Map<
    string,
    { contentFingerprint: string; canonicalContent: string; actionJson: string }
  >();
  for (const value of database
    .query(
      "SELECT record_id, operation_id, content_fingerprint, canonical_content, action_json FROM foundation_event_game_record_actions",
    )
    .all()) {
    const row = asRecord(value);
    actionEvidence.set(`${readText(row.record_id)}:${readText(row.operation_id)}`, {
      contentFingerprint: readText(row.content_fingerprint),
      canonicalContent: readText(row.canonical_content),
      actionJson: readText(row.action_json),
    });
  }
  const idempotencyEvidence = new Map<string, string>();
  for (const value of database
    .query(
      "SELECT record_id, operation_id, content_fingerprint FROM foundation_event_game_record_idempotency",
    )
    .all()) {
    const row = asRecord(value);
    idempotencyEvidence.set(
      `${readText(row.record_id)}:${readText(row.operation_id)}`,
      readText(row.content_fingerprint),
    );
  }
  for (const control of controlAudits) {
    const linkedGrantId = control.links?.grantAuditId;
    if (linkedGrantId !== undefined && linkedGrantId !== null) {
      const grant = grantsById.get(linkedGrantId);
      if (
        grant === undefined ||
        acceptanceAuditPairFailure(control, grant) !== null ||
        sqliteAcceptanceFingerprintFailure(control, grant, actionEvidence, idempotencyEvidence) !==
          null
      )
        throw new Error("Control and Grant acceptance semantics are inconsistent.");
    } else if (control.links?.acceptanceId !== undefined && control.links.acceptanceId !== null) {
      throw new Error("Control acceptance evidence has no paired Grant audit.");
    }
  }
  for (const grant of grantAudits) {
    const hasAcceptanceFields =
      grant.acceptanceId !== null ||
      grant.controlAuditId !== null ||
      grant.controlActionId !== null ||
      grant.contentFingerprint !== null ||
      grant.outcomeDetail !== null;
    if (!hasAcceptanceFields) continue;
    const control =
      typeof grant.controlAuditId !== "string" ? undefined : controlsById.get(grant.controlAuditId);
    if (
      control === undefined ||
      acceptanceAuditPairFailure(control, grant) !== null ||
      sqliteAcceptanceFingerprintFailure(control, grant, actionEvidence, idempotencyEvidence) !==
        null
    )
      throw new Error("Grant acceptance evidence has no exact paired Control audit.");
  }

  const linkedGrantAudits = database
    .query(
      `SELECT grants.audit_id, grants.acceptance_id, grants.control_audit_id,
              grants.control_action_id,
              json_extract(controls.audit_json, '$.auditId') AS control_id,
              json_extract(controls.audit_json, '$.links.grantAuditId') AS linked_grant_id,
              json_extract(controls.audit_json, '$.links.acceptanceId') AS linked_acceptance_id
       FROM foundation_grant_audit AS grants
       LEFT JOIN foundation_event_game_record_audit AS controls
         ON json_extract(controls.audit_json, '$.auditId') = grants.control_audit_id
       WHERE grants.acceptance_id IS NOT NULL`,
    )
    .all() as unknown[];
  for (const value of linkedGrantAudits) {
    const row = asRecord(value);
    if (
      readText(row.control_id) !== readText(row.control_audit_id) ||
      readText(row.linked_grant_id) !== readText(row.audit_id) ||
      readText(row.linked_acceptance_id) !== readText(row.acceptance_id) ||
      readText(row.control_action_id).length === 0
    )
      throw new Error("Control and Grant acceptance evidence is not bidirectionally linked.");
  }
  const orphanedControlLinks = database
    .query(
      `SELECT controls.audit_id, json_extract(controls.audit_json, '$.links.grantAuditId') AS grant_id
       FROM foundation_event_game_record_audit AS controls
       LEFT JOIN foundation_grant_audit AS grants
         ON grants.audit_id = json_extract(controls.audit_json, '$.links.grantAuditId')
       WHERE json_extract(controls.audit_json, '$.links.grantAuditId') IS NOT NULL
         AND (grants.audit_id IS NULL OR grants.control_audit_id <> controls.audit_id)`,
    )
    .all() as unknown[];
  if (orphanedControlLinks.length !== 0)
    throw new Error("Control acceptance evidence points to an orphan Grant audit.");
  const orphanedAttempts = database
    .query(
      `SELECT attempts.attempt_id
       FROM foundation_replay_attempts AS attempts
       LEFT JOIN foundation_event_game_record_audit AS controls
         ON controls.audit_id = attempts.control_audit_id
       LEFT JOIN foundation_grant_audit AS grants
         ON grants.audit_id = attempts.grant_audit_id
       WHERE controls.audit_id IS NULL
          OR grants.audit_id IS NULL
          OR grants.control_audit_id <> controls.audit_id
          OR json_extract(controls.audit_json, '$.links.grantAuditId') <> grants.audit_id
          OR json_extract(controls.audit_json, '$.links.acceptanceId') <> grants.acceptance_id
          OR grants.acceptance_id IS NULL
          OR grants.content_fingerprint IS NULL
          OR (attempts.action_fingerprint IS NOT NULL AND attempts.action_fingerprint <> grants.content_fingerprint)`,
    )
    .all() as unknown[];
  if (orphanedAttempts.length !== 0)
    throw new Error("Replay attempt evidence is not paired with its durable audits.");

  for (const value of attempts) {
    const row = asRecord(value);
    const control = controlsById.get(readText(row.control_audit_id));
    const grant = grantsById.get(readText(row.grant_audit_id));
    if (control === undefined || grant === undefined) continue;
    const attempt: StoredReplayAttempt = {
      attemptId: readText(row.attempt_id),
      reservationId: readText(row.reservation_id),
      operationId: readText(row.operation_id),
      status: readText(row.status) as StoredReplayAttempt["status"],
      actionFingerprint: readNullableText(row.action_fingerprint),
      resultJson: readNullableText(row.result_json),
      controlAuditId: readNullableText(row.control_audit_id),
      grantAuditId: readNullableText(row.grant_audit_id),
      createdAtMs: readInteger(row.created_at_ms),
      completedAtMs: readNullableInteger(row.completed_at_ms),
      stateRevision: readInteger(row.state_revision),
    };
    const evidence = actionEvidence.get(`${control.recordId}:${control.operationId}`);
    let result: unknown = null;
    try {
      result = JSON.parse(attempt.resultJson ?? "null");
    } catch {
      result = null;
    }
    const accepted = control.kind === "action-accepted" || control.kind === "action-duplicate";
    const collisionFingerprint = control.links?.collision?.rejectedAttempt?.contentFingerprint;
    const candidateFingerprint =
      collisionFingerprint ?? control.links?.rejectedCandidate?.contentFingerprint;
    const expectedFingerprint = accepted ? evidence?.contentFingerprint : candidateFingerprint;
    if (
      acceptanceAuditPairFailure(control, grant, attempt) !== null ||
      sqliteAcceptanceFingerprintFailure(control, grant, actionEvidence, idempotencyEvidence) !==
        null ||
      (accepted &&
        (evidence === undefined ||
          grant.contentFingerprint !== evidence.contentFingerprint ||
          attempt.actionFingerprint !== evidence.contentFingerprint ||
          idempotencyEvidence.get(`${control.recordId}:${control.operationId}`) !==
            evidence.contentFingerprint ||
          !isRecord(result) ||
          canonicalizeJson(result.action) !== canonicalizeJson(JSON.parse(evidence.actionJson)))) ||
      (expectedFingerprint !== undefined &&
        (grant.contentFingerprint !== expectedFingerprint ||
          attempt.actionFingerprint !== expectedFingerprint)) ||
      replayAttemptResultFailure(attempt) !== null
    )
      throw new Error("Replay attempt semantics are not paired with its Control/Grant audits.");
  }
}

function sqliteAcceptanceFingerprintFailure(
  control: StoredControlAuditEntry,
  grant: StoredGrantAuditEntry,
  actionEvidence: ReadonlyMap<
    string,
    { contentFingerprint: string; canonicalContent: string; actionJson: string }
  >,
  idempotencyEvidence: ReadonlyMap<string, string>,
): string | null {
  if (control.operationId === null || grant.contentFingerprint === null) return "missing";
  const key = `${control.recordId}:${control.operationId}`;
  const accepted = control.kind === "action-accepted" || control.kind === "action-duplicate";
  const action = actionEvidence.get(key);
  const collisionFingerprint = control.links?.collision?.rejectedAttempt?.contentFingerprint;
  const candidateFingerprint =
    collisionFingerprint ?? control.links?.rejectedCandidate?.contentFingerprint;
  const expectedFingerprint = accepted ? action?.contentFingerprint : candidateFingerprint;
  if (
    expectedFingerprint === undefined ||
    control.links?.contentFingerprint !== expectedFingerprint ||
    grant.contentFingerprint !== expectedFingerprint
  )
    return "fingerprint";
  if (accepted && (action === undefined || idempotencyEvidence.get(key) !== expectedFingerprint))
    return "fingerprint";
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function verifyAcceptanceAnchor(
  _database: Database,
  anchors: unknown[],
  subjectKind: AcceptanceIntegritySubject,
  subjectId: string,
  stateRevision: number,
  row: Record<string, unknown>,
  keyRing: GrantKeyRing,
): boolean {
  const anchorSubjectId =
    subjectKind === "attempt" ? `${readText(row.reservation_id)}:${subjectId}` : subjectId;
  const anchorRow = anchors
    .map(asRecord)
    .find(
      (candidate) =>
        readText(candidate.subject_kind) === subjectKind &&
        readText(candidate.subject_id) === anchorSubjectId &&
        readInteger(candidate.state_revision) === stateRevision,
    );
  if (anchorRow === undefined) return false;
  const value =
    subjectKind === "budget"
      ? {
          bucketId: readText(row.bucket_id),
          bucketKind: readText(row.bucket_kind) as
            | "online-session"
            | "online-event"
            | "replay-session",
          subjectId: readText(row.subject_id),
          capacity: readInteger(row.capacity),
          refillPerSecond: readInteger(row.refill_per_second),
          tokens: readReal(row.tokens),
          updatedAtMs: readInteger(row.updated_at_ms),
          stateRevision,
        }
      : subjectKind === "reservation"
        ? {
            reservationId: readText(row.reservation_id),
            recordId: readText(row.record_id),
            eventGameId: readText(row.event_game_id),
            originatingSessionId: readText(row.originating_session_id),
            replacementSessionId: readNullableText(row.replacement_session_id),
            actionCount: readInteger(row.action_count),
            status: readText(row.status) as StoredReplayReservation["status"],
            batchDigest: readNullableText(row.batch_digest),
            createdAtMs: readInteger(row.created_at_ms),
            committedAtMs: readNullableInteger(row.committed_at_ms),
            acknowledgedAtMs: readNullableInteger(row.acknowledged_at_ms),
            stateRevision,
          }
        : subjectKind === "attempt"
          ? {
              attemptId: readText(row.attempt_id),
              reservationId: readText(row.reservation_id),
              operationId: readText(row.operation_id),
              status: readText(row.status) as StoredReplayAttempt["status"],
              actionFingerprint: readNullableText(row.action_fingerprint),
              resultJson: readNullableText(row.result_json),
              controlAuditId: readNullableText(row.control_audit_id),
              grantAuditId: readNullableText(row.grant_audit_id),
              createdAtMs: readInteger(row.created_at_ms),
              completedAtMs: readNullableInteger(row.completed_at_ms),
              stateRevision,
            }
          : {
              receiptId: readText(row.receipt_id),
              reservationId: readText(row.reservation_id),
              receiptDigest: readText(row.receipt_digest),
              receiptKeyVersion: readText(row.receipt_key_version),
              status: readText(row.status) as StoredReplayReceipt["status"],
              actionCount: readInteger(row.action_count),
              createdAtMs: readInteger(row.created_at_ms),
              acknowledgedAtMs: readNullableInteger(row.acknowledged_at_ms),
              stateRevision,
            };
  const expected = anchorFor(subjectKind, value, keyRing, readText(anchorRow.key_version));
  return (
    readText(anchorRow.anchor_id) === expected.anchorId &&
    readText(anchorRow.key_version) === expected.keyVersion &&
    readText(anchorRow.canonical_value) === expected.canonicalValue &&
    readText(anchorRow.integrity_tag) === expected.integrityTag
  );
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
    "previous_event_game_id",
    "replay_evidence_id",
    "terminal_reason",
    "audit_integrity_tag",
    "created_at_ms",
  ] as const;
  const currentColumns = [
    ...columns.slice(0, -1),
    "acceptance_id",
    "control_audit_id",
    "control_action_id",
    "content_fingerprint",
    "outcome_detail",
    "created_at_ms",
  ] as const;
  const select = columns.join(", ");
  const currentSelect = currentColumns.join(", ");
  const current = database
    .query(`SELECT ${currentSelect} FROM foundation_grant_audit ORDER BY audit_id`)
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
    if (
      audit.action !== "session-switched" &&
      audit.action !== "replay-authorized" &&
      audit.previousEventGameId !== null
    ) {
      throw new Error("Grant Audit Trail previous Event Game provenance is invalid.");
    }
    const tagParts = tag.split(":");
    const keyVersion = tagParts[1];
    if (
      tagParts.length !== 3 ||
      keyVersion === undefined ||
      (computeGrantAuditIntegrityTag(audit, validationContext.keyRing, keyVersion) !== tag &&
        (audit.action === "session-switched" ||
          audit.action === "replay-authorized" ||
          computeLegacyGrantAuditIntegrityTag(audit, validationContext.keyRing, keyVersion) !==
            tag))
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
    EVENT_CATALOG_EVENTS_TABLE,
    EVENT_CATALOG_GAME_DAYS_TABLE,
    EVENT_CATALOG_AUDIT_TABLE,
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
    "foundation_event_catalog_game_days_event_id",
    "foundation_event_catalog_audit_event_id",
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
  if (name.startsWith("foundation_event_catalog_game_days")) return EVENT_CATALOG_GAME_DAYS_TABLE;
  if (name.startsWith("foundation_event_catalog_audit")) return EVENT_CATALOG_AUDIT_TABLE;
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

function readReal(value: unknown): number {
  const parsed = Number(readText(value));
  if (!Number.isFinite(parsed)) throw new Error("SQLite returned an invalid schema real.");
  return parsed;
}

function readNullableInteger(value: unknown): number | null {
  return value === null ? null : readInteger(value);
}

function readNullableText(value: unknown): string | null {
  return value === null ? null : readText(value);
}

function isValidJsonObject(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}
