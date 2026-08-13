import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
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
  type StoredEventGameRecordRoot,
} from "@/lib/foundation-storage";

export type SqliteFoundationStorageOptions = {
  migrations?: readonly FoundationMigration[];
  busyTimeoutMs?: number;
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

type RootRow = Record<string, unknown>;

type RootStatements = {
  byRecordId: SqlStatement;
  byEventGameId: SqlStatement;
  byPitchSlotId: SqlStatement;
  byGameSideId: SqlStatement;
  insertRoot: SqlStatement;
  insertSide: SqlStatement;
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

export class SqliteFoundationStorage implements FoundationStorage {
  readonly databasePath: string;

  private readonly database: Database;
  private readonly migrations: readonly FoundationMigration[];
  private readonly busyTimeoutMs: number;
  private writerTail: Promise<void> = Promise.resolve();
  private statements: RootStatements | undefined;
  private closed = false;

  constructor(databasePath: string, options: SqliteFoundationStorageOptions = {}) {
    this.databasePath = databasePath;
    this.migrations = options.migrations ?? FOUNDATION_MIGRATIONS;
    this.busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    this.database = new Database(databasePath);
    this.configureDatabase();
  }

  transaction<T>(work: FoundationStorageTransactionWork<T>): Promise<T> {
    return this.enqueue(() => {
      const readiness = this.readinessSync();
      if (!readiness.ok) {
        throw new FoundationStorageNotReadyError(readiness);
      }

      this.database.exec("BEGIN IMMEDIATE;");
      try {
        const result = work(this.createTransaction());
        if (isThenable(result)) {
          throw new TypeError("Foundation storage transactions must complete synchronously.");
        }
        this.database.exec("COMMIT;");
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
      findRootByRecordId: (recordId) => this.readRootByStatement(statements.byRecordId, recordId),
      findRootByEventGameId: (eventGameId) =>
        this.readRootByStatement(statements.byEventGameId, eventGameId),
      findRootByPitchSlotId: (pitchSlotId) =>
        this.readRootByStatement(statements.byPitchSlotId, pitchSlotId),
      findRootByGameSideId: (gameSideId) =>
        this.readRootByStatement(statements.byGameSideId, gameSideId),
      insertRoot: (storedRoot) => this.insertRoot(statements, storedRoot),
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

  private readRootByStatement(
    statement: SqlStatement,
    ...parameters: string[]
  ): EventGameRecordRoot | null {
    const row = statement.get(...parameters) as RootRow | null;
    if (row === null) return null;
    return readValidatedFoundationRoot(this.database, row);
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
    };
    return this.statements;
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
      const schemaVerification = verifyFoundationSchema(this.database);
      if (!schemaVerification.ok) {
        return { ...schemaVerification, storage: "sqlite" };
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

  private tableExists(name: string): boolean {
    const row = this.database
      .query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) as RootRow | null;
    return row !== null;
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
  if (message.includes("record_id")) {
    return new FoundationStorageConstraintError("record-id");
  }
  if (message.includes("event_game_id")) {
    return new FoundationStorageConstraintError("event-game-id");
  }
  if (message.includes("pitch_slot_id")) {
    return new FoundationStorageConstraintError("pitch-slot-id");
  }
  if (message.includes("side_id")) {
    return new FoundationStorageConstraintError("game-side-id");
  }
  return error;
}

function quoteSqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function asRecord(value: unknown): RootRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("SQLite returned an invalid row.");
  }
  return value as RootRow;
}

function readText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "journal_mode" in value) {
    return readText(value.journal_mode);
  }
  if (typeof value === "object" && value !== null && "synchronous" in value) {
    return readText(value.synchronous);
  }
  if (typeof value === "object" && value !== null && "foreign_keys" in value) {
    return readText(value.foreign_keys);
  }
  if (typeof value === "object" && value !== null && "busy_timeout" in value) {
    return readText(value.busy_timeout);
  }
  if (typeof value === "object" && value !== null && "timeout" in value) {
    return readText(value.timeout);
  }
  if (typeof value === "object" && value !== null && "quick_check" in value) {
    return readText(value.quick_check);
  }
  if (typeof value === "object" && value !== null && "integrity_check" in value) {
    return readText(value.integrity_check);
  }
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  throw new Error("SQLite returned an invalid value.");
}

function readInteger(value: unknown): number {
  const parsed = Number(readText(value));
  if (!Number.isSafeInteger(parsed)) throw new Error("SQLite returned an invalid integer.");
  return parsed;
}
