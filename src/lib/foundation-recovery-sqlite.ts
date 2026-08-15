import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";

export const FOUNDATION_BACKUP_POLICY_VERSION = "foundation-backup-policy-v2" as const;

export type FoundationBackupPolicy = {
  version: typeof FOUNDATION_BACKUP_POLICY_VERSION;
  includedRelations: readonly string[];
};

const INCLUDED_RELATIONS = Object.freeze([
  "foundation_acceptance_budgets",
  "foundation_acceptance_integrity_anchors",
  "foundation_control_evidence_provenance",
  "foundation_event_catalog_audit",
  "foundation_event_catalog_events",
  "foundation_event_catalog_game_days",
  "foundation_event_catalog_teams",
  "foundation_event_catalog_roster",
  "foundation_event_catalog_pitches",
  "foundation_event_catalog_gameplay_slots",
  "foundation_event_catalog_pitch_slots",
  "foundation_event_catalog_games",
  "foundation_event_game_presentation_changes",
  "foundation_event_game_presentation_audit",
  "foundation_event_game_presentation_integrity",
  "foundation_event_game_record_actions",
  "foundation_event_game_record_audit",
  "foundation_event_game_record_idempotency",
  "foundation_event_game_record_metadata",
  "foundation_event_game_record_roots",
  "foundation_event_game_record_sides",
  "foundation_grant_admission_global_windows",
  "foundation_grant_admission_state_anchors",
  "foundation_grant_admission_telemetry",
  "foundation_grant_audit",
  "foundation_grant_audit_provenance",
  "foundation_grant_codes",
  "foundation_grant_migration_provenance",
  "foundation_grant_migration_provenance_state",
  "foundation_grant_roots",
  "foundation_grant_sessions",
  "foundation_grant_state_anchors",
  "foundation_migration_ledger",
  "foundation_replay_attempts",
  "foundation_replay_receipts",
  "foundation_replay_reservations",
] as const);

export const FOUNDATION_BACKUP_POLICY: FoundationBackupPolicy = Object.freeze({
  version: FOUNDATION_BACKUP_POLICY_VERSION,
  includedRelations: INCLUDED_RELATIONS,
});

export type RecoverySnapshotFacts = {
  logicalDigest: string;
  actionCount: number;
  grantVersions: readonly { grantId: string; grantType: string; grantVersion: string }[];
};

export type RepresentedKeyVersions = {
  encryption: readonly string[];
  lookup: readonly string[];
  audit: readonly string[];
};

export class FoundationBackupPolicyError extends Error {
  readonly relation: string;

  constructor(relation: string) {
    super("SQLite backup policy rejected an unclassified authority relation.");
    this.name = "FoundationBackupPolicyError";
    this.relation = relation;
  }
}

export function inspectRecoveryDatabase(
  database: Database,
  policy: FoundationBackupPolicy = FOUNDATION_BACKUP_POLICY,
): RecoverySnapshotFacts {
  if (policy.version !== FOUNDATION_BACKUP_POLICY_VERSION) {
    throw new Error("Unsupported SQLite backup inclusion policy.");
  }
  const included = new Set(policy.includedRelations);
  const relations = listRelations(database);
  for (const relation of relations) {
    if (!included.has(relation)) {
      throw new FoundationBackupPolicyError(relation);
    }
  }
  const representedIncluded = relations.filter((relation) => included.has(relation));
  const logicalDigest = createHash("sha256");
  for (const relation of representedIncluded) {
    logicalDigest.update(relation);
    logicalDigest.update("\0");
    for (const row of canonicalRows(database, relation)) {
      logicalDigest.update(row);
      logicalDigest.update("\n");
    }
  }
  const actionCount = included.has("foundation_event_game_record_actions")
    ? countRows(database, "foundation_event_game_record_actions")
    : 0;
  const grantVersions = relations.includes("foundation_grant_roots")
    ? (
        database
          .query(
            "SELECT grant_id, grant_type, grant_version FROM foundation_grant_roots ORDER BY grant_id",
          )
          .all() as Array<{ grant_id: string; grant_type: string; grant_version: string }>
      ).map((row) => ({
        grantId: row.grant_id,
        grantType: row.grant_type,
        grantVersion: row.grant_version,
      }))
    : [];
  return {
    logicalDigest: logicalDigest.digest("hex"),
    actionCount,
    grantVersions,
  };
}

export function readRepresentedKeyVersions(database: Database): RepresentedKeyVersions {
  const relations = new Set(listRelations(database));
  const encryption = new Set<string>();
  const lookup = new Set<string>();
  const audit = new Set<string>();
  const add = (target: Set<string>, value: unknown): void => {
    if (typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value)) target.add(value);
  };
  if (relations.has("foundation_grant_roots")) {
    for (const row of database
      .query(
        "SELECT encryption_key_version AS encryption_version, lookup_key_version AS lookup_version FROM foundation_grant_roots",
      )
      .all() as Array<{ encryption_version: unknown; lookup_version: unknown }>) {
      add(encryption, row.encryption_version);
      add(lookup, row.lookup_version);
    }
  }
  if (relations.has("foundation_grant_codes")) {
    for (const row of database
      .query(
        "SELECT encryption_key_version AS encryption_version, lookup_key_version AS lookup_version FROM foundation_grant_codes",
      )
      .all() as Array<{ encryption_version: unknown; lookup_version: unknown }>) {
      add(encryption, row.encryption_version);
      add(audit, row.lookup_version);
    }
  }
  if (relations.has("foundation_grant_sessions")) {
    for (const row of database
      .query(
        "SELECT browser_context_key_version AS context_version, bearer_lookup_key_version AS bearer_version FROM foundation_grant_sessions",
      )
      .all() as Array<{ context_version: unknown; bearer_version: unknown }>) {
      add(lookup, row.context_version);
      add(lookup, row.bearer_version);
    }
  }
  for (const [relation, column] of [
    ["foundation_grant_audit", "audit_integrity_tag"],
    ["foundation_grant_state_anchors", "integrity_tag"],
    ["foundation_grant_admission_state_anchors", "integrity_tag"],
  ] as const) {
    if (!relations.has(relation)) continue;
    for (const row of database
      .query(`SELECT ${quoteIdentifier(column)} AS value FROM ${quoteIdentifier(relation)}`)
      .all() as Array<{ value: unknown }>) {
      if (typeof row.value !== "string") continue;
      add(audit, /^hmac-sha256-v1:([^:]+):/.exec(row.value)?.[1]);
    }
  }
  if (relations.has("foundation_acceptance_integrity_anchors")) {
    for (const row of database
      .query("SELECT key_version AS value FROM foundation_acceptance_integrity_anchors")
      .all() as Array<{ value: unknown }>)
      add(audit, row.value);
  }
  if (relations.has("foundation_replay_receipts")) {
    for (const row of database
      .query("SELECT receipt_key_version AS value FROM foundation_replay_receipts")
      .all() as Array<{ value: unknown }>)
      add(audit, row.value);
  }
  if (relations.has("foundation_event_game_presentation_integrity")) {
    for (const row of database
      .query("SELECT key_version AS value FROM foundation_event_game_presentation_integrity")
      .all() as Array<{ value: unknown }>)
      add(audit, row.value);
  }
  return {
    encryption: [...encryption].sort(),
    lookup: [...lookup].sort(),
    audit: [...audit].sort(),
  };
}

function listRelations(database: Database): string[] {
  return (
    database
      .query(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function canonicalRows(database: Database, relation: string): string[] {
  const columns = (
    database.query(`PRAGMA table_info(${quoteIdentifier(relation)})`).all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
  if (columns.length === 0) return [];
  const order = columns.map(quoteIdentifier).join(", ");
  const rows = database
    .query(`SELECT * FROM ${quoteIdentifier(relation)} ORDER BY ${order}`)
    .all() as Record<string, unknown>[];
  return rows.map((row) =>
    JSON.stringify(columns.map((column) => canonicalSqliteValue(row[column]))),
  );
}

function canonicalSqliteValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return { blob: Buffer.from(value).toString("base64") };
  if (typeof value === "bigint") return value.toString();
  return value;
}

function countRows(database: Database, relation: string): number {
  const row = database
    .query(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(relation)}`)
    .get() as {
    count: number | bigint;
  };
  return Number(row.count);
}

export function quoteRecoverySqliteString(value: string): string {
  if (value.includes("\0")) throw new Error("SQLite path contains a null byte.");
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
