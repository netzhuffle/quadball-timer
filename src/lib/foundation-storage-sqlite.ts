import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import {
  appendGrantAudit,
  createGrantSqliteStatements,
  insertGrant,
  insertGrantSession,
  listGrantAudit,
  listGrants,
  listGrantSessions,
  readGrantByStatement,
  readSessionByStatement,
  updateGrant,
  updateGrantSession,
  type GrantSqliteStatements,
} from "@/lib/grant-storage-sqlite";
import type { GrantKeyRing } from "@/lib/grant-types";
import type { GrantStateValidationContext } from "@/lib/grant-state-validation";
import {
  assessMigrationReadiness,
  FOUNDATION_MIGRATION_LEDGER_SQL,
  FOUNDATION_MIGRATIONS,
  type FoundationMigration,
  type MigrationLedgerEntry,
  type MigrationReadiness,
} from "@/lib/foundation-migrations";
import { verifyFoundationSchema, readValidatedFoundationRoot } from "@/lib/foundation-schema";
import {
  FoundationStorageClosedError,
  FoundationStorageConstraintError,
  FoundationStorageNotReadyError,
  isThenable,
  type FoundationStorage,
  type FoundationStorageReadiness,
  type FoundationStorageTransaction,
  type FoundationStorageTransactionWork,
  type StoredControlAction,
  type StoredControlAuditEntry,
  type StoredControlIdempotencyEntry,
  type StoredEventGameRecordMetadata,
  type StoredEventGameRecordRoot,
} from "@/lib/foundation-storage";
import {
  actionIdentity,
  asRecord,
  quoteSqliteString,
  readAudit,
  readIdempotency,
  readInteger,
  readNullableInteger,
  readMetadata,
  readStoredAction,
  readText,
  translateSqliteConstraint as translateControlSqliteConstraint,
  type RootRow,
} from "@/lib/foundation-storage-sqlite-helpers";

export type SqliteFoundationStorageOptions = {
  migrations?: readonly FoundationMigration[];
  busyTimeoutMs?: number;
  /** Test-only synchronization seam immediately before acquiring the writer lock. */
  beforeWriteTransactionLock?: () => void;
  grantKeyRing?: GrantKeyRing;
  grantValidationContext?: GrantStateValidationContext;
};

export type SqliteFoundationSettings = {
  journalMode: string;
  synchronous: number;
  foreignKeys: number;
  busyTimeoutMs: number;
};

export type FoundationMigrationReport = {
  appliedMigrationIds: string[];
  schemaVersion: number;
};

export type FoundationMigrationCandidateReport = {
  ready: boolean;
  candidatePath: string;
  migration: FoundationMigrationReport;
  readiness: FoundationStorageReadiness;
};

export class FoundationMigrationError extends Error {
  readonly readiness?: MigrationReadiness;

  constructor(message: string, readiness?: MigrationReadiness) {
    super(message);
    this.name = "FoundationMigrationError";
    this.readiness = readiness;
  }
}

type SqlStatement = ReturnType<Database["query"]>;

type RootStatements = {
  byRecordId: SqlStatement;
  byEventGameId: SqlStatement;
  byPitchSlotId: SqlStatement;
  byGameSideId: SqlStatement;
  insertRoot: SqlStatement;
  insertSide: SqlStatement;
  actionByOperationId: SqlStatement;
  actionsByRecordId: SqlStatement;
  insertAction: SqlStatement;
  insertIdempotency: SqlStatement;
  metadataByRecordId: SqlStatement;
  upsertMetadata: SqlStatement;
  auditByRecordId: SqlStatement;
  idempotencyByRecordId: SqlStatement;
  insertAudit: SqlStatement;
  insertEvidenceProvenance: SqlStatement;
};

const ROOT_SELECT_COLUMNS = `
  roots.record_id AS record_id, roots.event_id AS event_id, roots.event_game_id AS event_game_id,
  roots.owner_event_id AS owner_event_id, roots.owner_event_game_id AS owner_event_game_id,
  roots.scope_event_id AS scope_event_id, roots.game_day_id AS game_day_id,
  roots.pitch_id AS pitch_id, roots.pitch_slot_id AS pitch_slot_id,
  roots.lifecycle_phase AS lifecycle_phase, roots.commenced_at_ms AS commenced_at_ms,
  roots.finished_at_ms AS finished_at_ms, roots.locked_at_ms AS locked_at_ms,
  roots.lock_reason AS lock_reason, roots.record_version AS record_version,
  roots.schema_version AS schema_version, roots.interpreter_version AS interpreter_version,
  roots.creation_operation_id AS creation_operation_id,
  roots.creation_actor_reference AS creation_actor_reference,
  roots.creation_source AS creation_source, roots.creation_created_at_ms AS creation_created_at_ms,
  roots.canonical_content AS canonical_content, roots.root_json AS root_json
`;

const OPAQUE_MIGRATION_REFERENCE_PATTERN = /^opaque-migration-reference-v1:[a-f0-9]{64}$/;

export class SqliteFoundationStorage implements FoundationStorage {
  readonly databasePath: string;

  private readonly database: Database;
  private readonly migrations: readonly FoundationMigration[];
  private readonly busyTimeoutMs: number;
  private readonly beforeWriteTransactionLock: (() => void) | undefined;
  private grantValidationContext: GrantStateValidationContext;
  private writerTail: Promise<void> = Promise.resolve();
  private statements: RootStatements | undefined;
  private grantStatements: GrantSqliteStatements | undefined;
  private closed = false;
  private revision = 0;
  private dataVersion: number;

  constructor(databasePath: string, options: SqliteFoundationStorageOptions = {}) {
    this.databasePath = databasePath;
    this.migrations = options.migrations ?? FOUNDATION_MIGRATIONS;
    this.busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    this.beforeWriteTransactionLock = options.beforeWriteTransactionLock;
    this.grantValidationContext = options.grantValidationContext ?? {
      keyRing: options.grantKeyRing,
    };
    this.database = new Database(databasePath);
    this.configureDatabase();
    this.dataVersion = this.readDataVersion();
  }

  transaction<T>(work: FoundationStorageTransactionWork<T>): Promise<T> {
    return this.enqueue(() => {
      this.beforeWriteTransactionLock?.();
      this.database.exec("BEGIN IMMEDIATE;");
      try {
        // The write lock fixes the snapshot before both the external revision
        // token and semantic readiness are derived. A commit from another
        // connection cannot land between these operations and be hidden by
        // the verified-revision cache.
        this.refreshExternalRevision();
        const readiness = this.readinessSync();
        if (!readiness.ok) {
          throw new FoundationStorageNotReadyError(readiness);
        }
        const result = work(this.createTransaction());
        if (isThenable(result)) {
          throw new TypeError("Foundation storage transactions must complete synchronously.");
        }
        this.database.exec("COMMIT;");
        this.revision += 1;
        this.dataVersion = this.readDataVersion();
        return result;
      } catch (error) {
        this.rollbackQuietly();
        throw translateSqliteConstraint(error);
      }
    });
  }

  readRoot(recordId: string): Promise<EventGameRecordRoot | null> {
    return this.enqueue(() => {
      const readiness = this.readinessSync();
      if (!readiness.ok) {
        throw new FoundationStorageNotReadyError(readiness);
      }
      return this.readRootByStatement(this.getStatements().byRecordId, recordId);
    });
  }

  readActions(recordId: string): Promise<StoredControlAction[]> {
    return this.enqueue(() => {
      const readiness = this.readinessSync();
      if (!readiness.ok) throw new FoundationStorageNotReadyError(readiness);
      return this.readActionsByRecordId(this.getStatements().actionsByRecordId, recordId);
    });
  }

  readRecordMetadata(recordId: string): Promise<StoredEventGameRecordMetadata | null> {
    return this.enqueue(() => {
      const readiness = this.readinessSync();
      if (!readiness.ok) throw new FoundationStorageNotReadyError(readiness);
      const row = this.getStatements().metadataByRecordId.get(recordId) as RootRow | null;
      return row === null ? null : readMetadata(row);
    });
  }

  readIdempotencyEntries(recordId: string): Promise<StoredControlIdempotencyEntry[]> {
    return this.enqueue(() => {
      const readiness = this.readinessSync();
      if (!readiness.ok) throw new FoundationStorageNotReadyError(readiness);
      return this.readIdempotencyByRecordId(this.getStatements().idempotencyByRecordId, recordId);
    });
  }

  readAuditEntries(recordId: string): Promise<StoredControlAuditEntry[]> {
    return this.enqueue(() => {
      const readiness = this.readinessSync();
      if (!readiness.ok) throw new FoundationStorageNotReadyError(readiness);
      return this.readAuditByRecordId(this.getStatements().auditByRecordId, recordId);
    });
  }

  readiness(): Promise<FoundationStorageReadiness> {
    return this.enqueue(() => this.readinessSync());
  }

  getSettings(): SqliteFoundationSettings {
    this.assertOpen();
    return this.readSettings();
  }

  async applyMigrations(
    options: { requireCandidate?: boolean } = {},
  ): Promise<FoundationMigrationReport> {
    if (options.requireCandidate !== false) {
      const candidate = await this.validateCandidate();
      if (!candidate.ready) {
        throw new FoundationMigrationError(
          "The disposable migration candidate did not reach readiness.",
        );
      }
    }

    return this.enqueue(() => this.applyMigrationsSync());
  }

  async validateCandidate(
    options: { retainCandidate?: boolean } = {},
  ): Promise<FoundationMigrationCandidateReport> {
    this.assertOpen();
    if (this.databasePath === ":memory:") {
      throw new FoundationMigrationError(
        "A file-backed database is required for candidate validation.",
      );
    }

    const temporaryDirectory = await mkdtemp(join(tmpdir(), "quadball-timer-foundation-"));
    const candidatePath = join(temporaryDirectory, "candidate.sqlite");
    let candidate: SqliteFoundationStorage | undefined;
    let retainCandidate = options.retainCandidate === true;
    try {
      await this.enqueue(() => {
        this.database.exec(`VACUUM INTO ${quoteSqliteString(candidatePath)};`);
      });

      candidate = new SqliteFoundationStorage(candidatePath, {
        migrations: this.migrations,
        busyTimeoutMs: this.busyTimeoutMs,
        grantValidationContext: this.grantValidationContext,
      });
      const migration = await candidate.applyMigrations({ requireCandidate: false });
      const readiness = await candidate.readiness();
      retainCandidate = options.retainCandidate === true;
      return {
        ready: readiness.ok,
        candidatePath,
        migration,
        readiness,
      };
    } finally {
      candidate?.close();
      if (!retainCandidate) {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  setGrantKeyRing(keyRing: GrantKeyRing): void {
    this.grantValidationContext = { ...this.grantValidationContext, keyRing };
  }

  setGrantValidationContext(context: GrantStateValidationContext): void {
    this.grantValidationContext = { ...this.grantValidationContext, ...context };
  }

  private applyMigrationsSync(): FoundationMigrationReport {
    this.assertOpen();
    const appliedMigrationIds: string[] = [];

    while (true) {
      this.database.exec("BEGIN IMMEDIATE;");
      try {
        this.database.exec(FOUNDATION_MIGRATION_LEDGER_SQL);
        const state = this.readMigrationState();
        const readiness = assessMigrationReadiness(true, state.entries, this.migrations);
        if (readiness.status === "ready") {
          this.database.exec("COMMIT;");
          return {
            appliedMigrationIds,
            schemaVersion: readiness.schemaVersion,
          };
        }

        if (readiness.status !== "missing" && readiness.status !== "pending") {
          throw new FoundationMigrationError(
            "The migration ledger is incompatible with this executable.",
            readiness,
          );
        }

        const nextMigration = this.migrations[state.entries.length];
        if (nextMigration === undefined) {
          throw new FoundationMigrationError(
            "The migration ledger is missing a required migration.",
            readiness,
          );
        }
        this.database
          .query(
            `INSERT INTO foundation_migration_ledger
              (migration_id, ordinal, schema_version, checksum, status, applied_at_ms)
             VALUES (?, ?, ?, ?, 'applying', NULL)`,
          )
          .run(
            nextMigration.id,
            nextMigration.ordinal,
            nextMigration.schemaVersion,
            nextMigration.checksum,
          );
        this.database.exec(nextMigration.sql);
        this.database
          .query(
            `UPDATE foundation_migration_ledger
             SET status = 'complete', applied_at_ms = ?
             WHERE migration_id = ?`,
          )
          .run(Date.now(), nextMigration.id);
        this.database.exec("COMMIT;");
        appliedMigrationIds.push(nextMigration.id);
      } catch (error) {
        this.rollbackQuietly();
        if (error instanceof FoundationMigrationError) {
          throw error;
        }
        throw new FoundationMigrationError("The transactional foundation migration failed.");
      }
    }
  }

  private createTransaction(): FoundationStorageTransaction {
    const statements = this.getStatements();
    return {
      revision: this.revision,
      findRootByRecordId: (recordId) => this.readRootByStatement(statements.byRecordId, recordId),
      findRootByEventGameId: (eventGameId) =>
        this.readRootByStatement(statements.byEventGameId, eventGameId),
      findRootByPitchSlotId: (pitchSlotId) =>
        this.readRootByStatement(statements.byPitchSlotId, pitchSlotId),
      findRootByGameSideId: (gameSideId) =>
        this.readRootByStatement(statements.byGameSideId, gameSideId),
      insertRoot: (storedRoot) => this.insertRoot(statements, storedRoot),
      findActionByOperationId: (recordId, operationId) =>
        this.readActionByStatement(statements.actionByOperationId, recordId, operationId),
      listActions: (recordId) => this.readActionsByRecordId(statements.actionsByRecordId, recordId),
      listIdempotencyEntries: (recordId) =>
        this.readIdempotencyByRecordId(statements.idempotencyByRecordId, recordId),
      readRecordMetadata: (recordId) => {
        const row = statements.metadataByRecordId.get(recordId) as RootRow | null;
        return row === null ? null : readMetadata(row);
      },
      listAuditEntries: (recordId) =>
        this.readAuditByRecordId(statements.auditByRecordId, recordId),
      insertAction: (storedAction) => this.insertAction(statements, storedAction),
      upsertRecordMetadata: (metadata) => this.upsertRecordMetadata(statements, metadata),
      appendAuditEntry: (entry) => this.appendAuditEntry(statements, entry),
      findGrantById: (grantId) =>
        readGrantByStatement(this.getGrantStatements().byGrantId, grantId),
      listGrants: () => listGrants(this.getGrantStatements().allGrants),
      findGrantByCredentialLookupDigest: (lookupDigest) =>
        readGrantByStatement(this.getGrantStatements().byCredentialDigest, lookupDigest),
      findActiveSessionByGrantAndContext: (grantId, browserContextDigest) =>
        readSessionByStatement(
          this.getGrantStatements().activeSessionByContext,
          grantId,
          browserContextDigest,
        ),
      findSessionByBearerVerifier: (bearerLookupVerifier, bearerLookupKeyVersion) =>
        readSessionByStatement(
          this.getGrantStatements().sessionByBearer,
          bearerLookupVerifier,
          bearerLookupKeyVersion,
        ),
      listGrantSessions: (grantId) =>
        listGrantSessions(this.getGrantStatements().sessionsByGrant, grantId),
      listGrantAudit: (grantId) => listGrantAudit(this.getGrantStatements().auditByGrant, grantId),
      insertGrant: (grant) => insertGrant(this.getGrantStatements(), grant),
      updateGrant: (grant) => updateGrant(this.getGrantStatements(), grant),
      insertGrantSession: (session) => insertGrantSession(this.getGrantStatements(), session),
      updateGrantSession: (session) => updateGrantSession(this.getGrantStatements(), session),
      appendGrantAudit: (entry) =>
        appendGrantAudit(this.getGrantStatements(), entry, this.grantValidationContext.keyRing),
    };
  }

  private insertRoot(statements: RootStatements, storedRoot: StoredEventGameRecordRoot): void {
    const { root } = storedRoot;
    statements.insertRoot.run(
      root.recordId,
      root.eventId,
      root.eventGameId,
      root.ownership.eventId,
      root.ownership.eventGameId,
      root.externalScope.eventId,
      root.externalScope.gameDayId,
      root.externalScope.pitchId,
      root.externalScope.pitchSlotId,
      root.lifecycle.phase,
      root.lifecycle.commencedAtMs,
      root.lifecycle.finishedAtMs,
      root.lifecycle.lockedAtMs,
      root.lifecycle.lockReason,
      root.compatibility.recordVersion,
      root.compatibility.schemaVersion,
      root.compatibility.interpreterVersion,
      root.creationEvidence.operationId,
      root.creationEvidence.actorReference,
      root.creationEvidence.source,
      root.creationEvidence.createdAtMs,
      storedRoot.canonicalContent,
      JSON.stringify(root),
    );
    const [sideA, sideB] = root.gameSides;
    statements.insertSide.run(
      sideA.id,
      root.recordId,
      "a",
      sideA.eventTeamId,
      sideA.teamInterpretationRef,
    );
    statements.insertSide.run(
      sideB.id,
      root.recordId,
      "b",
      sideB.eventTeamId,
      sideB.teamInterpretationRef,
    );
  }

  private insertAction(statements: RootStatements, storedAction: StoredControlAction): void {
    const { action } = storedAction;
    const actionId = actionIdentity(action.recordId, action.operationId);
    statements.insertAction.run(
      actionId,
      action.recordId,
      action.eventGameId,
      action.operationId,
      action.kind.id,
      action.kind.version,
      action.acceptedAtMs,
      storedAction.contentFingerprint,
      storedAction.canonicalContent,
      JSON.stringify(action),
      action.controlActionVersion,
      "current",
    );
    statements.insertEvidenceProvenance.run("action", actionId);
    statements.insertIdempotency.run(
      actionId,
      action.recordId,
      action.operationId,
      storedAction.contentFingerprint,
      action.acceptedAtMs,
    );
  }

  private upsertRecordMetadata(
    statements: RootStatements,
    metadata: StoredEventGameRecordMetadata,
  ): void {
    statements.upsertMetadata.run(
      metadata.recordId,
      metadata.actionCount,
      metadata.orderingVersion,
      metadata.lastAcceptedAtMs,
      metadata.updatedAtMs,
    );
  }

  private appendAuditEntry(statements: RootStatements, entry: StoredControlAuditEntry): void {
    statements.insertAudit.run(
      entry.auditId,
      entry.recordId,
      entry.eventGameId,
      entry.operationId,
      entry.kind,
      entry.outcome,
      entry.createdAtMs,
      entry.redactedDetail,
      JSON.stringify(entry),
      entry.auditVersion,
      "current",
    );
    statements.insertEvidenceProvenance.run("audit", entry.auditId);
  }

  private readRootByStatement(
    statement: SqlStatement,
    ...parameters: string[]
  ): EventGameRecordRoot | null {
    const row = statement.get(...parameters) as RootRow | null;
    if (row === null) return null;
    return readValidatedFoundationRoot(this.database, row);
  }

  private readActionByStatement(
    statement: SqlStatement,
    recordId: string,
    operationId: string,
  ): StoredControlAction | null {
    const row = statement.get(recordId, operationId) as RootRow | null;
    return row === null ? null : readStoredAction(row);
  }

  private readActionsByRecordId(statement: SqlStatement, recordId: string): StoredControlAction[] {
    const rows = statement.all(recordId) as unknown[];
    return rows.map((value) => readStoredAction(asRecord(value)));
  }

  private readIdempotencyByRecordId(
    statement: SqlStatement,
    recordId: string,
  ): StoredControlIdempotencyEntry[] {
    const rows = statement.all(recordId) as unknown[];
    return rows.map((value) => readIdempotency(asRecord(value)));
  }

  private readAuditByRecordId(
    statement: SqlStatement,
    recordId: string,
  ): StoredControlAuditEntry[] {
    const rows = statement.all(recordId) as unknown[];
    return rows.map((value) => readAudit(asRecord(value)));
  }

  private getStatements(): RootStatements {
    if (this.statements !== undefined) return this.statements;
    this.statements = {
      byRecordId: this.database.query(
        `SELECT ${ROOT_SELECT_COLUMNS} FROM foundation_event_game_record_roots AS roots WHERE roots.record_id = ?`,
      ),
      byEventGameId: this.database.query(
        `SELECT ${ROOT_SELECT_COLUMNS} FROM foundation_event_game_record_roots AS roots WHERE roots.event_game_id = ?`,
      ),
      byPitchSlotId: this.database.query(
        `SELECT ${ROOT_SELECT_COLUMNS} FROM foundation_event_game_record_roots AS roots WHERE roots.pitch_slot_id = ?`,
      ),
      byGameSideId: this.database.query(
        `SELECT ${ROOT_SELECT_COLUMNS}
         FROM foundation_event_game_record_roots AS roots
         INNER JOIN foundation_event_game_record_sides AS sides
           ON sides.record_id = roots.record_id
         WHERE sides.side_id = ?`,
      ),
      insertRoot: this.database.query(`
        INSERT INTO foundation_event_game_record_roots (
          record_id, event_id, event_game_id, owner_event_id, owner_event_game_id,
          scope_event_id, game_day_id, pitch_id, pitch_slot_id,
          lifecycle_phase, commenced_at_ms, finished_at_ms, locked_at_ms, lock_reason,
          record_version, schema_version, interpreter_version,
          creation_operation_id, creation_actor_reference, creation_source,
          creation_created_at_ms, canonical_content, root_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertSide: this.database.query(`
        INSERT INTO foundation_event_game_record_sides (
          side_id, record_id, side_position, event_team_id, team_interpretation_ref
        ) VALUES (?, ?, ?, ?, ?)
      `),
      actionByOperationId: this.database.query(`
        SELECT action_id, action_json, action_kind, action_version, accepted_at_ms,
               canonical_content, content_fingerprint, control_action_version,
               action_evidence_format,
               (SELECT evidence_format FROM foundation_control_evidence_provenance
                WHERE evidence_kind = 'action' AND evidence_id = foundation_event_game_record_actions.action_id) AS action_provenance_format
        FROM foundation_event_game_record_actions
        WHERE record_id = ? AND operation_id = ?
      `),
      actionsByRecordId: this.database.query(`
        SELECT action_id, action_json, action_kind, action_version, accepted_at_ms,
               canonical_content, content_fingerprint, control_action_version,
               action_evidence_format,
               (SELECT evidence_format FROM foundation_control_evidence_provenance
                WHERE evidence_kind = 'action' AND evidence_id = foundation_event_game_record_actions.action_id) AS action_provenance_format
        FROM foundation_event_game_record_actions
        WHERE record_id = ?
        ORDER BY rowid
      `),
      insertAction: this.database.query(`
        INSERT INTO foundation_event_game_record_actions (
          action_id, record_id, event_game_id, operation_id, action_kind, action_version,
          accepted_at_ms, content_fingerprint, canonical_content, action_json,
          control_action_version, action_evidence_format
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertIdempotency: this.database.query(`
        INSERT INTO foundation_event_game_record_idempotency (
          action_id, record_id, operation_id, content_fingerprint, accepted_at_ms
        ) VALUES (?, ?, ?, ?, ?)
      `),
      metadataByRecordId: this.database.query(`
        SELECT record_id, action_count, ordering_version, last_accepted_at_ms, updated_at_ms
        FROM foundation_event_game_record_metadata
        WHERE record_id = ?
      `),
      upsertMetadata: this.database.query(`
        INSERT INTO foundation_event_game_record_metadata (
          record_id, action_count, ordering_version, last_accepted_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(record_id) DO UPDATE SET
          action_count = excluded.action_count,
          ordering_version = excluded.ordering_version,
          last_accepted_at_ms = excluded.last_accepted_at_ms,
          updated_at_ms = excluded.updated_at_ms
      `),
      auditByRecordId: this.database.query(`
        SELECT audit_id, record_id, event_game_id, operation_id, audit_kind, outcome,
               created_at_ms, redacted_detail, audit_json, audit_version,
               audit_evidence_format,
               (SELECT evidence_format FROM foundation_control_evidence_provenance
                WHERE evidence_kind = 'audit' AND evidence_id = foundation_event_game_record_audit.audit_id) AS audit_provenance_format
        FROM foundation_event_game_record_audit
        WHERE record_id = ?
        ORDER BY rowid
      `),
      idempotencyByRecordId: this.database.query(`
        SELECT action_id, record_id, operation_id, content_fingerprint, accepted_at_ms
        FROM foundation_event_game_record_idempotency
        WHERE record_id = ?
        ORDER BY rowid
      `),
      insertAudit: this.database.query(`
        INSERT INTO foundation_event_game_record_audit (
          audit_id, record_id, event_game_id, operation_id, audit_kind, outcome,
               created_at_ms, redacted_detail, audit_json, audit_version,
               audit_evidence_format
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertEvidenceProvenance: this.database.query(`
        INSERT INTO foundation_control_evidence_provenance
          (evidence_kind, evidence_id, evidence_format, origin)
        VALUES (?, ?, 'current', 'post-75-current')
      `),
    };
    return this.statements;
  }

  private getGrantStatements(): GrantSqliteStatements {
    if (this.grantStatements !== undefined) return this.grantStatements;
    this.grantStatements = createGrantSqliteStatements(this.database);
    return this.grantStatements;
  }

  private readMigrationState(): { ledgerExists: boolean; entries: MigrationLedgerEntry[] } {
    const ledgerExists = this.tableExists("foundation_migration_ledger");
    if (!ledgerExists) return { ledgerExists: false, entries: [] };

    const entries = this.database
      .query(
        "SELECT migration_id, ordinal, schema_version, checksum, status FROM foundation_migration_ledger ORDER BY ordinal",
      )
      .all() as unknown[];
    return {
      ledgerExists: true,
      entries: entries.map((entry) => {
        const row = asRecord(entry);
        return {
          id: readText(row.migration_id),
          ordinal: readInteger(row.ordinal),
          schemaVersion: readInteger(row.schema_version),
          checksum: readText(row.checksum),
          status: readText(row.status) === "complete" ? "complete" : "applying",
        };
      }),
    };
  }

  private readinessSync(): FoundationStorageReadiness {
    try {
      this.assertOpen();
      const settings = this.readSettings();
      if (
        settings.journalMode.toLowerCase() !== "wal" ||
        settings.synchronous !== 2 ||
        settings.foreignKeys !== 1
      ) {
        return {
          ok: false,
          status: "unsafe-settings",
          detail: "SQLite did not report the required WAL, FULL, and foreign-key settings.",
          storage: "sqlite",
        };
      }

      const migrationState = this.readMigrationState();
      const migrationReadiness = assessMigrationReadiness(
        migrationState.ledgerExists,
        migrationState.entries,
        this.migrations,
      );
      if (migrationReadiness.status !== "ready") {
        return {
          ok: false,
          status: migrationReadiness.status,
          detail: migrationReadiness.detail,
          storage: "sqlite",
        };
      }
      if (
        migrationReadiness.schemaVersion >= 6 &&
        this.migrations.some((migration) => migration.id === "006-grant-cryptographic-erasure")
      )
        this.refreshGrantMigrationProvenance();
      const schemaVerification = verifyFoundationSchema(this.database, this.grantValidationContext);
      if (!schemaVerification.ok) {
        return { ...schemaVerification, storage: "sqlite" };
      }
      const idempotencyFailure = this.verifyIdempotencyParity();
      if (idempotencyFailure !== null) {
        return {
          ok: false,
          status: "integrity-failure",
          detail: idempotencyFailure,
          storage: "sqlite",
        };
      }

      return {
        ok: true,
        schemaVersion: String(migrationReadiness.schemaVersion),
        storage: "sqlite",
      };
    } catch (error) {
      if (error instanceof FoundationStorageClosedError) {
        return {
          ok: false,
          status: "closed",
          detail: "SQLite foundation storage is closed.",
          storage: "sqlite",
        };
      }
      return {
        ok: false,
        status: "integrity-failure",
        detail: "SQLite readiness verification failed.",
        storage: "sqlite",
      };
    }
  }

  private readSettings(): SqliteFoundationSettings {
    return {
      journalMode: readText(this.database.query("PRAGMA journal_mode").get()),
      synchronous: readInteger(this.database.query("PRAGMA synchronous").get()),
      foreignKeys: readInteger(this.database.query("PRAGMA foreign_keys").get()),
      busyTimeoutMs: readInteger(this.database.query("PRAGMA busy_timeout").get()),
    };
  }

  private refreshGrantMigrationProvenance(): void {
    const state = this.database
      .query(
        "SELECT migration_id FROM foundation_grant_migration_provenance_state WHERE state_id = 1",
      )
      .get() as RootRow | null;
    if (state === null || readText(state.migration_id) !== "014-grant-provenance-integrity")
      throw new Error("Grant migration provenance is incomplete.");
    const provenance = new Map<string, string>();
    const expiryProvenance = new Map<string, number | null>();
    const rows = this.database
      .query(
        `SELECT grant_id, retained_opaque_reference, migration_id, original_expires_at_ms
         FROM foundation_grant_migration_provenance ORDER BY grant_id`,
      )
      .all() as unknown[];
    for (const value of rows) {
      const row = asRecord(value);
      const grantId = readText(row.grant_id);
      const fingerprint = readText(row.retained_opaque_reference);
      if (
        readText(row.migration_id) !== "006-grant-cryptographic-erasure" ||
        !OPAQUE_MIGRATION_REFERENCE_PATTERN.test(fingerprint) ||
        provenance.has(grantId)
      )
        throw new Error("Grant migration provenance is invalid.");
      provenance.set(grantId, fingerprint);
      expiryProvenance.set(grantId, readNullableInteger(row.original_expires_at_ms));
    }
    this.grantValidationContext = {
      ...this.grantValidationContext,
      migrationProvenance: provenance,
      migrationExpiryProvenance: expiryProvenance,
    };
  }

  private readDataVersion(): number {
    return readInteger(this.database.query("PRAGMA data_version").get());
  }

  private refreshExternalRevision(): void {
    const currentDataVersion = this.readDataVersion();
    if (currentDataVersion !== this.dataVersion) {
      this.revision += 1;
      this.dataVersion = currentDataVersion;
    }
  }

  private tableExists(name: string): boolean {
    const row = this.database
      .query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) as RootRow | null;
    return row !== null;
  }

  private verifyIdempotencyParity(): string | null {
    const actionCount = readInteger(
      this.database
        .query("SELECT COUNT(*) AS count FROM foundation_event_game_record_actions")
        .get(),
    );
    const idempotencyCount = readInteger(
      this.database
        .query("SELECT COUNT(*) AS count FROM foundation_event_game_record_idempotency")
        .get(),
    );
    if (actionCount !== idempotencyCount) {
      return "SQLite action and idempotency row counts are inconsistent.";
    }
    const rows = this.database
      .query(`
        SELECT
          actions.action_id AS action_action_id,
          actions.record_id AS action_record_id,
          actions.operation_id AS action_operation_id,
          actions.content_fingerprint AS action_content_fingerprint,
          actions.accepted_at_ms AS action_accepted_at_ms,
          idempotency.action_id AS idempotency_action_id,
          idempotency.record_id AS idempotency_record_id,
          idempotency.operation_id AS idempotency_operation_id,
          idempotency.content_fingerprint AS idempotency_content_fingerprint,
          idempotency.accepted_at_ms AS idempotency_accepted_at_ms
        FROM foundation_event_game_record_actions AS actions
        LEFT JOIN foundation_event_game_record_idempotency AS idempotency
          ON idempotency.action_id = actions.action_id
      `)
      .all() as unknown[];
    for (const value of rows) {
      const row = asRecord(value);
      if (row.idempotency_action_id === null) {
        return "SQLite action and idempotency state is missing a paired row.";
      }
      if (
        readText(row.action_action_id) !== readText(row.idempotency_action_id) ||
        readText(row.action_record_id) !== readText(row.idempotency_record_id) ||
        readText(row.action_operation_id) !== readText(row.idempotency_operation_id) ||
        readText(row.action_content_fingerprint) !==
          readText(row.idempotency_content_fingerprint) ||
        readInteger(row.action_accepted_at_ms) !== readInteger(row.idempotency_accepted_at_ms)
      ) {
        return "SQLite action and idempotency columns are inconsistent.";
      }
    }
    const extra = this.database
      .query(`
        SELECT idempotency.action_id
        FROM foundation_event_game_record_idempotency AS idempotency
        LEFT JOIN foundation_event_game_record_actions AS actions
          ON actions.action_id = idempotency.action_id
        WHERE actions.action_id IS NULL
        LIMIT 1
      `)
      .get() as RootRow | null;
    return extra === null ? null : "SQLite idempotency state has an extra row.";
  }

  private configureDatabase(): void {
    this.database.exec(
      `PRAGMA busy_timeout = ${this.busyTimeoutMs};
       PRAGMA journal_mode = WAL;
       PRAGMA synchronous = FULL;
       PRAGMA foreign_keys = ON;`,
    );
  }

  private rollbackQuietly(): void {
    try {
      this.database.exec("ROLLBACK;");
    } catch {
      // The original transaction error is the useful one for callers.
    }
  }

  private enqueue<T>(operation: () => T): Promise<T> {
    const queued = this.writerTail.then(() => {
      this.assertOpen();
      return operation();
    });
    this.writerTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private assertOpen(): void {
    if (this.closed) throw new FoundationStorageClosedError();
  }
}

export function openSqliteFoundationStorage(
  databasePath: string,
  options: SqliteFoundationStorageOptions = {},
): SqliteFoundationStorage {
  return new SqliteFoundationStorage(databasePath, options);
}

export async function validateFoundationMigrationCandidate(
  storage: SqliteFoundationStorage,
  options: { retainCandidate?: boolean } = {},
): Promise<FoundationMigrationCandidateReport> {
  return storage.validateCandidate(options);
}

function translateSqliteConstraint(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const message = error.message.toLowerCase();
  if (message.includes("foundation_grant_roots.grant_id")) {
    return new FoundationStorageConstraintError("grant-id");
  }
  if (message.includes("foundation_grant_roots.grant_version")) {
    return new FoundationStorageConstraintError("grant-version");
  }
  if (message.includes("foundation_grant_roots.pitch_slot_id")) {
    return new FoundationStorageConstraintError("grant-pitch-slot-id");
  }
  if (message.includes("foundation_grant_roots.credential_lookup_digest")) {
    return new FoundationStorageConstraintError("grant-credential-digest");
  }
  if (
    message.includes("foundation_grant_sessions_active_context") ||
    (message.includes("foundation_grant_sessions.grant_id") &&
      message.includes("browser_context_digest"))
  ) {
    return new FoundationStorageConstraintError("grant-session-context");
  }
  if (message.includes("foundation_grant_sessions.session_id")) {
    return new FoundationStorageConstraintError("grant-session-id");
  }
  if (message.includes("foundation_grant_sessions.bearer_lookup_verifier")) {
    return new FoundationStorageConstraintError("grant-session-verifier");
  }
  if (message.includes("foundation_grant_audit.audit_id")) {
    return new FoundationStorageConstraintError("grant-audit-id");
  }
  return translateControlSqliteConstraint(error);
}
