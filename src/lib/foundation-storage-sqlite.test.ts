import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checksumMigrationSql,
  FOUNDATION_MIGRATIONS,
  type FoundationMigration,
} from "@/lib/foundation-migrations";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import { createEventGameRecord, type ExternalScopeResolver } from "@/lib/event-game-record";
import {
  FoundationMigrationError,
  openSqliteFoundationStorage,
} from "@/lib/foundation-storage-sqlite";
import { createGrantTestKeyRing } from "@/lib/grant-authority-contract";

async function withDatabase<T>(work: (databasePath: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "quadball-timer-sqlite-"));
  try {
    return await work(join(directory, "foundation.sqlite"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("SQLite foundation storage", () => {
  test("configures production settings without migrating on open", async () => {
    await withDatabase(async (databasePath) => {
      const storage = openSqliteFoundationStorage(databasePath);
      expect(storage.getSettings()).toEqual({
        journalMode: "wal",
        synchronous: 2,
        foreignKeys: 1,
        busyTimeoutMs: 5_000,
      });
      expect(await storage.readiness()).toMatchObject({
        ok: false,
        status: "pending",
      });
      storage.close();
    });
  });

  test("applies explicit migrations, persists a root, and reopens it", async () => {
    await withDatabase(async (databasePath) => {
      const first = openSqliteFoundationStorage(databasePath);
      await first.applyMigrations();
      const recordId = "record-reopen";
      const root = createRoot(recordId);
      const firstRecord = createEventGameRecord(first, {
        externalScopeResolver: createScopeResolver(root),
      });
      expect(await firstRecord.registerRoot(root)).toMatchObject({ status: "registered" });
      first.close();

      const reopened = openSqliteFoundationStorage(databasePath);
      expect(await reopened.readiness()).toMatchObject({ ok: true, schemaVersion: "22" });
      const reopenedRecord = createEventGameRecord(reopened, {
        externalScopeResolver: createScopeResolver(root),
      });
      expect(await reopenedRecord.readRoot(recordId)).toMatchObject({
        recordId,
        eventGameId: "event-game-reopen",
      });
      expect(await reopenedRecord.registerRoot(root)).toMatchObject({ status: "idempotent" });
      reopened.close();
    });
  });

  test("keeps the empty-store admission anchor across restart and freezes raw deletion", async () => {
    await withDatabase(async (databasePath) => {
      const keyRing = createGrantTestKeyRing();
      const first = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      await first.applyMigrations();
      expect(await first.readiness()).toMatchObject({ ok: true });
      first.close();

      const raw = new Database(databasePath);
      raw.exec("DELETE FROM foundation_grant_admission_state_anchors WHERE anchor_id = 1");
      raw.close();

      const corrupted = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      expect(await corrupted.readiness()).toMatchObject({ ok: false, status: "integrity-failure" });
      corrupted.close();
    });
  });

  test("does not key pending admission rows installed after a no-key schema-17 migration", async () => {
    await withDatabase(async (databasePath) => {
      const storage = openSqliteFoundationStorage(databasePath);
      await storage.applyMigrations();
      const raw = new Database(databasePath);
      raw
        .query(
          "INSERT INTO foundation_grant_admission_telemetry (mode, source_digest, failed_attempts, delay_until_ms, last_attempt_at_ms, last_success_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("code", "A".repeat(43), 1, null, 1_000, null);
      raw.close();
      expect(await storage.readiness()).toMatchObject({ ok: false });
      expect(() => storage.setGrantKeyRing?.(createGrantTestKeyRing())).toThrow();
      expect(await storage.readiness()).toMatchObject({ ok: false });
      storage.close();
    });
  });

  test("validates a disposable candidate before production migration", async () => {
    await withDatabase(async (databasePath) => {
      const storage = openSqliteFoundationStorage(databasePath);
      const candidate = await storage.validateCandidate();
      expect(candidate.ready).toBe(true);
      expect(candidate.readiness).toMatchObject({ ok: true, schemaVersion: "22" });
      expect(existsSync(candidate.candidatePath)).toBe(false);
      expect(await storage.readiness()).toMatchObject({ ok: false, status: "pending" });

      const migration = await storage.applyMigrations({ requireCandidate: true });
      expect(migration.schemaVersion).toBe(22);
      expect(await storage.readiness()).toMatchObject({ ok: true });
      storage.close();
    });
  });

  test("upgrades an already-ledgered initial schema through the explicit repair migration", async () => {
    await withDatabase(async (databasePath) => {
      const initialMigration = FOUNDATION_MIGRATIONS[0];
      const repairMigration = FOUNDATION_MIGRATIONS[1];
      const actionMigration = FOUNDATION_MIGRATIONS[2];
      const grantMigration = FOUNDATION_MIGRATIONS[3];
      const expiryMigration = FOUNDATION_MIGRATIONS[4];
      const erasureMigration = FOUNDATION_MIGRATIONS[5];
      const controlVersionMigration = FOUNDATION_MIGRATIONS[6];
      const evidenceFormatMigration = FOUNDATION_MIGRATIONS[7];
      const controlProvenanceMigration = FOUNDATION_MIGRATIONS[8];
      const typedMigration = FOUNDATION_MIGRATIONS[9];
      const summaryMigration = FOUNDATION_MIGRATIONS[10];
      const terminalAuditMigration = FOUNDATION_MIGRATIONS[11];
      const auditEvidenceMigration = FOUNDATION_MIGRATIONS[12];
      const provenanceMigration = FOUNDATION_MIGRATIONS[13];
      const bindingMigration = FOUNDATION_MIGRATIONS[14];
      const replayProvenanceMigration = FOUNDATION_MIGRATIONS[15];
      const composedAcceptanceMigration = FOUNDATION_MIGRATIONS[16];
      const acceptanceIntegrityHistoryMigration = FOUNDATION_MIGRATIONS[17];
      const eventCatalogMigration = FOUNDATION_MIGRATIONS[18];
      const grantCodeMigration = FOUNDATION_MIGRATIONS[19];
      const grantCodeLockMigration = FOUNDATION_MIGRATIONS[20];
      if (
        initialMigration === undefined ||
        repairMigration === undefined ||
        actionMigration === undefined ||
        grantMigration === undefined ||
        expiryMigration === undefined ||
        erasureMigration === undefined ||
        controlVersionMigration === undefined ||
        evidenceFormatMigration === undefined ||
        controlProvenanceMigration === undefined ||
        typedMigration === undefined ||
        summaryMigration === undefined ||
        terminalAuditMigration === undefined ||
        auditEvidenceMigration === undefined ||
        provenanceMigration === undefined ||
        bindingMigration === undefined ||
        replayProvenanceMigration === undefined ||
        composedAcceptanceMigration === undefined ||
        acceptanceIntegrityHistoryMigration === undefined ||
        eventCatalogMigration === undefined ||
        grantCodeMigration === undefined ||
        grantCodeLockMigration === undefined
      ) {
        throw new Error("Expected the foundation migrations.");
      }
      const legacy = openSqliteFoundationStorage(databasePath, {
        migrations: [initialMigration],
      });
      await legacy.applyMigrations({ requireCandidate: false });
      legacy.close();

      const current = openSqliteFoundationStorage(databasePath);
      expect(await current.readiness()).toMatchObject({ ok: false, status: "missing" });
      const migration = await current.applyMigrations();
      expect(migration.appliedMigrationIds).toEqual([
        repairMigration.id,
        actionMigration.id,
        grantMigration.id,
        expiryMigration.id,
        erasureMigration.id,
        controlVersionMigration.id,
        evidenceFormatMigration.id,
        controlProvenanceMigration.id,
        typedMigration.id,
        summaryMigration.id,
        terminalAuditMigration.id,
        auditEvidenceMigration.id,
        provenanceMigration.id,
        bindingMigration.id,
        replayProvenanceMigration.id,
        composedAcceptanceMigration.id,
        acceptanceIntegrityHistoryMigration.id,
        eventCatalogMigration.id,
        grantCodeMigration.id,
        grantCodeLockMigration.id,
        "022-event-teams-rosters-and-pitches",
      ]);
      expect(await current.readiness()).toMatchObject({ ok: true, schemaVersion: "22" });
      current.close();
    });
  });

  test("leaves the prior schema usable when a later migration fails", async () => {
    await withDatabase(async (databasePath) => {
      const baseMigrations = FOUNDATION_MIGRATIONS;
      const failingMigration = createMigration(
        "023-failing-test-migration",
        23,
        23,
        "CREATE TABLE migration_failure_probe (id TEXT) STRICT; THIS IS NOT SQL;",
      );
      const store = openSqliteFoundationStorage(databasePath, {
        migrations: [...baseMigrations, failingMigration],
      });
      let failure: unknown;
      try {
        await store.applyMigrations({ requireCandidate: false });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      store.close();

      const priorBinary = openSqliteFoundationStorage(databasePath, {
        migrations: baseMigrations,
      });
      expect(await priorBinary.readiness()).toMatchObject({
        ok: true,
        schemaVersion: "22",
      });
      priorBinary.close();

      const database = new Database(databasePath);
      expect(
        database
          .query("SELECT 1 AS present FROM sqlite_master WHERE name = 'migration_failure_probe'")
          .get(),
      ).toBeNull();
      database.close();
    });
  });

  test("fails readiness for changed, incomplete, and future ledger state", async () => {
    await withDatabase(async (databasePath) => {
      const initial = openSqliteFoundationStorage(databasePath);
      await initial.applyMigrations();
      initial.close();

      const firstMigration = FOUNDATION_MIGRATIONS[0];
      const secondMigration = FOUNDATION_MIGRATIONS[1];
      if (firstMigration === undefined || secondMigration === undefined) {
        throw new Error("Expected the foundation migrations.");
      }

      const database = new Database(databasePath);
      database
        .query("UPDATE foundation_migration_ledger SET checksum = ? WHERE migration_id = ?")
        .run("changed", firstMigration.id);
      database.close();
      const changed = openSqliteFoundationStorage(databasePath);
      expect(await changed.readiness()).toMatchObject({
        ok: false,
        status: "changed-checksum",
      });
      changed.close();

      const incompleteDatabase = new Database(databasePath);
      incompleteDatabase
        .query(
          "UPDATE foundation_migration_ledger SET checksum = ?, status = ? WHERE migration_id = ?",
        )
        .run(firstMigration.checksum, "complete", firstMigration.id);
      incompleteDatabase
        .query(
          "UPDATE foundation_migration_ledger SET checksum = ?, status = ? WHERE migration_id = ?",
        )
        .run(secondMigration.checksum, "applying", secondMigration.id);
      incompleteDatabase.close();
      const incomplete = openSqliteFoundationStorage(databasePath);
      expect(await incomplete.readiness()).toMatchObject({
        ok: false,
        status: "incomplete",
      });
      incomplete.close();

      const futureDatabase = new Database(databasePath);
      futureDatabase
        .query(
          "UPDATE foundation_migration_ledger SET checksum = ?, status = ? WHERE migration_id = ?",
        )
        .run(firstMigration.checksum, "complete", firstMigration.id);
      futureDatabase
        .query(
          "UPDATE foundation_migration_ledger SET checksum = ?, status = ? WHERE migration_id = ?",
        )
        .run(secondMigration.checksum, "complete", secondMigration.id);
      futureDatabase
        .query(
          "INSERT INTO foundation_migration_ledger (migration_id, ordinal, schema_version, checksum, status, applied_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("future-999", 23, 23, "future-checksum", "complete", 2_000);
      futureDatabase.close();
      const future = openSqliteFoundationStorage(databasePath);
      expect(await future.readiness()).toMatchObject({ ok: false });
      future.close();
    });
  });

  test("scans every owned root and refuses production migration for canonical corruption", async () => {
    await withDatabase(async (databasePath) => {
      const initial = openSqliteFoundationStorage(databasePath);
      await initial.applyMigrations();
      const root = createRoot("corrupt-root");
      const record = createEventGameRecord(initial, {
        externalScopeResolver: createScopeResolver(root),
      });
      expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
      initial.close();

      const database = new Database(databasePath);
      database
        .query("UPDATE foundation_event_game_record_roots SET canonical_content = ?")
        .run("tampered-canonical-content");
      database.close();

      const reopened = openSqliteFoundationStorage(databasePath);
      expect(await reopened.readiness()).toMatchObject({
        ok: false,
        status: "integrity-failure",
      });
      const candidate = await reopened.validateCandidate();
      expect(candidate.ready).toBe(false);
      expect(candidate.readiness).toMatchObject({
        ok: false,
        status: "integrity-failure",
      });
      let migrationFailure: unknown;
      try {
        await reopened.applyMigrations();
      } catch (error) {
        migrationFailure = error;
      }
      expect(migrationFailure).toBeInstanceOf(FoundationMigrationError);
      reopened.close();
    });
  });

  test("fails closed when a valid ledger has a tampered installed schema", async () => {
    await withDatabase(async (databasePath) => {
      const initial = openSqliteFoundationStorage(databasePath);
      await initial.applyMigrations();
      initial.close();

      const database = new Database(databasePath);
      database.exec(
        "DROP TABLE foundation_event_game_record_sides; CREATE TABLE foundation_event_game_record_sides (side_id TEXT PRIMARY KEY) STRICT;",
      );
      database.close();

      const reopened = openSqliteFoundationStorage(databasePath);
      expect(await reopened.readiness()).toMatchObject({
        ok: false,
        status: "integrity-failure",
      });
      const candidate = await reopened.validateCandidate();
      expect(candidate.ready).toBe(false);
      expect(candidate.readiness).toMatchObject({
        ok: false,
        status: "integrity-failure",
      });
      let migrationFailure: unknown;
      try {
        await reopened.applyMigrations();
      } catch (error) {
        migrationFailure = error;
      }
      expect(migrationFailure).toBeInstanceOf(FoundationMigrationError);
      reopened.close();
    });
  });
});

function createMigration(
  id: string,
  ordinal: number,
  schemaVersion: number,
  sql: string,
): FoundationMigration {
  return {
    id,
    ordinal,
    schemaVersion,
    sql,
    checksum: checksumMigrationSql(sql),
  };
}

function createRoot(recordId: string): EventGameRecordRoot {
  return {
    recordId,
    eventId: "event-reopen",
    eventGameId: "event-game-reopen",
    ownership: {
      eventId: "event-reopen",
      eventGameId: "event-game-reopen",
    },
    externalScope: {
      eventId: "event-reopen",
      gameDayId: "day-reopen",
      pitchId: "pitch-reopen",
      pitchSlotId: `slot-${recordId}`,
    },
    gameSides: [
      {
        id: `side-a-${recordId}`,
        eventTeamId: "team-a",
        teamInterpretationRef: "interpretation-a",
      },
      {
        id: `side-b-${recordId}`,
        eventTeamId: "team-b",
        teamInterpretationRef: "interpretation-b",
      },
    ],
    lifecycle: {
      phase: "scheduled" as const,
      commencedAtMs: null,
      finishedAtMs: null,
      lockedAtMs: null,
      lockReason: null,
    },
    compatibility: {
      recordVersion: "record-v1",
      schemaVersion: "schema-v1",
      interpreterVersion: "rules-v1",
    },
    creationEvidence: {
      operationId: `operation-${recordId}`,
      actorReference: "test-actor",
      source: "event-game-registration" as const,
      createdAtMs: 1_000,
    },
  };
}

function createScopeResolver(root: EventGameRecordRoot): ExternalScopeResolver {
  return {
    resolve(scope) {
      return JSON.stringify(scope) === JSON.stringify(root.externalScope)
        ? { status: "resolved", scope: structuredClone(scope) }
        : { status: "mismatch", detail: "The external scope does not match the root." };
    },
    resolveEventTeam(eventId, eventTeamId) {
      return eventId === root.eventId && eventTeamId.length > 0
        ? { status: "resolved" }
        : { status: "mismatch", detail: "The Event Team is outside the Event scope." };
    },
  };
}
