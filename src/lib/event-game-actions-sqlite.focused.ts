import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDeterministicTestIqaInterpreter,
  type ControlActionInput,
} from "@/lib/event-game-actions";
import { createEventGameRecord, type ExternalScopeResolver } from "@/lib/event-game-record";
import { ACCEPTED_AUDIT_DETAIL, createAuditEntry } from "@/lib/event-game-record-helpers";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";

describe("SQLite immutable Event Game actions", () => {
  test("persists the action, idempotency, metadata, and audit across restart", async () => {
    await withDatabase(async (databasePath) => {
      const root = createRoot("record-sqlite-restart");
      const firstStorage = openSqliteFoundationStorage(databasePath);
      await firstStorage.applyMigrations();
      const firstRecord = createRecord(firstStorage, root);
      expect(await firstRecord.registerRoot(root)).toMatchObject({ status: "registered" });
      const action = createFact(root, "operation-restart", 1_000);
      expect(await firstRecord.acceptAction(action)).toMatchObject({ status: "accepted" });
      firstStorage.close();

      const reopenedStorage = openSqliteFoundationStorage(databasePath);
      const reopenedRecord = createRecord(reopenedStorage, root);
      expect(await reopenedRecord.registerRoot(root)).toMatchObject({ status: "idempotent" });
      expect(await reopenedRecord.acceptAction(action)).toMatchObject({
        status: "duplicate-accepted",
      });
      expect(await reopenedRecord.readMetadata()).toMatchObject({ actionCount: 1 });
      expect((await reopenedRecord.readAudit(createAuditAuthority())).length).toBe(1);
      expect(await reopenedRecord.rebuild()).toMatchObject({ status: "ready" });
      expect(await reopenedRecord.readiness()).toMatchObject({ ok: true, actionCount: 1 });
      reopenedStorage.close();
    });
  });

  test("rejects changed content under a permanent operation identity without mutating action state", async () => {
    await withDatabase(async (databasePath) => {
      const root = createRoot("record-sqlite-conflict");
      const storage = openSqliteFoundationStorage(databasePath);
      await storage.applyMigrations();
      const record = createRecord(storage, root);
      await record.registerRoot(root);
      const action = createFact(root, "operation-conflict", 1_000);
      expect(await record.acceptAction(action)).toMatchObject({ status: "accepted" });
      expect(
        await record.acceptAction({
          ...action,
          payload: {
            ...(action.payload as Record<string, unknown>),
            data: { changed: true },
          },
        }),
      ).toMatchObject({ status: "rejected", reason: "operation-conflict" });
      expect((await record.readActions()).length).toBe(1);
      expect(await record.readMetadata()).toMatchObject({ actionCount: 1 });
      expect((await record.readAudit(createAuditAuthority())).length).toBe(2);
      storage.close();
    });
  });

  test("rolls back action, idempotency, metadata, and audit when the commit fails", async () => {
    await withDatabase(async (databasePath) => {
      const root = createRoot("record-sqlite-rollback");
      const storage = openSqliteFoundationStorage(databasePath);
      await storage.applyMigrations();
      const record = createRecord(storage, root);
      await record.registerRoot(root);
      const database = new Database(databasePath);
      database.exec(`
        CREATE TRIGGER fail_action_audit
        BEFORE INSERT ON foundation_event_game_record_audit
        WHEN NEW.audit_kind = 'action-accepted'
        BEGIN
          SELECT RAISE(ABORT, 'simulated audit failure');
        END;
      `);
      database.close();

      expect(
        await record.acceptAction(createFact(root, "operation-rollback", 1_000)),
      ).toMatchObject({
        status: "rejected",
        reason: "storage-not-ready",
      });
      const repaired = new Database(databasePath);
      repaired.exec("DROP TRIGGER fail_action_audit;");
      repaired.close();
      expect((await record.readActions()).length).toBe(0);
      expect(await record.readMetadata()).toMatchObject({ actionCount: 0 });
      expect((await record.readAudit(createAuditAuthority())).length).toBe(0);
      storage.close();
    });
  });

  test("fails readiness when durable action versions are unknown", async () => {
    await withDatabase(async (databasePath) => {
      const root = createRoot("record-sqlite-unknown-version");
      const storage = openSqliteFoundationStorage(databasePath);
      await storage.applyMigrations();
      const record = createRecord(storage, root);
      await record.registerRoot(root);
      await record.acceptAction(createFact(root, "operation-unknown-version", 1_000));
      storage.close();

      const database = new Database(databasePath);
      const row = database
        .query(
          "SELECT action_json FROM foundation_event_game_record_actions WHERE operation_id = ?",
        )
        .get("operation-unknown-version") as { action_json: string } | null;
      if (row === null) throw new Error("Expected the durable action row.");
      const action = JSON.parse(row.action_json) as Record<string, unknown>;
      action.kind = { id: "game-fact", version: "99" };
      database
        .query(
          "UPDATE foundation_event_game_record_actions SET action_json = ?, action_version = ? WHERE operation_id = ?",
        )
        .run(JSON.stringify(action), "99", "operation-unknown-version");
      database.close();

      const reopened = openSqliteFoundationStorage(databasePath);
      const reopenedRecord = createRecord(reopened, root);
      expect(await reopenedRecord.registerRoot(root)).toMatchObject({ status: "idempotent" });
      expect(await reopenedRecord.readiness()).toMatchObject({
        ok: false,
        status: "rebuild-failure",
      });
      expect(
        await reopenedRecord.acceptAction(
          createFact(root, "operation-after-unknown-version", 2_000),
        ),
      ).toMatchObject({ status: "rejected", reason: "storage-not-ready" });
      expect(
        (await reopenedRecord.readAudit(createAuditAuthority())).filter(
          (entry) => entry.operationId === "operation-after-unknown-version",
        ),
      ).toHaveLength(0);
      reopened.close();
    });
  });

  test("fails closed on idempotency ledger parity corruption before a new write", async () => {
    await withDatabase(async (databasePath) => {
      const root = createRoot("record-sqlite-idempotency-corrupt");
      const storage = openSqliteFoundationStorage(databasePath);
      await storage.applyMigrations();
      const record = createRecord(storage, root);
      await record.registerRoot(root);
      await record.acceptAction(createFact(root, "operation-idempotency-corrupt", 1_000));
      storage.close();

      const database = new Database(databasePath);
      database
        .query(
          "UPDATE foundation_event_game_record_idempotency SET content_fingerprint = ? WHERE operation_id = ?",
        )
        .run("f".repeat(64), "operation-idempotency-corrupt");
      database.close();

      const reopened = openSqliteFoundationStorage(databasePath);
      const reopenedRecord = createRecord(reopened, root);
      expect(await reopenedRecord.registerRoot(root)).toMatchObject({
        status: "rejected",
        reason: "storage-not-ready",
      });
      expect(await reopened.readiness()).toMatchObject({
        ok: false,
        status: "integrity-failure",
      });
      expect(
        await reopenedRecord.acceptAction(
          createFact(root, "operation-after-idempotency-corrupt", 2_000),
        ),
      ).toMatchObject({ status: "rejected", reason: "storage-not-ready" });
      const unchanged = new Database(databasePath);
      const actionCount = unchanged
        .query("SELECT COUNT(*) AS count FROM foundation_event_game_record_actions")
        .get() as { count: number };
      expect(actionCount.count).toBe(1);
      unchanged.close();
      reopened.close();
    });
  });

  test("fails closed on missing and extra idempotency rows", async () => {
    const mutations: readonly [string, (database: Database, root: EventGameRecordRoot) => void][] =
      [
        [
          "missing",
          (database, root) => {
            database
              .query("DELETE FROM foundation_event_game_record_idempotency WHERE record_id = ?")
              .run(root.recordId);
          },
        ],
        [
          "extra",
          (database, root) => {
            database.exec("PRAGMA foreign_keys = OFF;");
            database
              .query(
                "INSERT INTO foundation_event_game_record_idempotency (action_id, record_id, operation_id, content_fingerprint, accepted_at_ms) VALUES (?, ?, ?, ?, ?)",
              )
              .run("extra-action", root.recordId, "extra-operation", "e".repeat(64), 2_000);
          },
        ],
      ];

    for (const [label, mutate] of mutations) {
      await withDatabase(async (databasePath) => {
        const root = createRoot(`record-sqlite-idempotency-${label}`);
        const storage = openSqliteFoundationStorage(databasePath);
        await storage.applyMigrations();
        const record = createRecord(storage, root);
        await record.registerRoot(root);
        await record.acceptAction(createFact(root, "operation-retained", 1_000));
        storage.close();

        const database = new Database(databasePath);
        mutate(database, root);
        database.close();

        const reopened = openSqliteFoundationStorage(databasePath);
        const reopenedRecord = createRecord(reopened, root);
        expect(await reopened.readiness()).toMatchObject({
          ok: false,
          status: "integrity-failure",
        });
        expect(
          await reopenedRecord.acceptAction(createFact(root, `operation-after-${label}`, 2_000)),
        ).toMatchObject({ status: "rejected", reason: "storage-not-ready" });
        reopened.close();
      });
    }
  });

  test("does not acknowledge an accepted action when its audit identity is already occupied", async () => {
    await withDatabase(async (databasePath) => {
      const root = createRoot("record-sqlite-strict-audit");
      const storage = openSqliteFoundationStorage(databasePath);
      await storage.applyMigrations();
      const record = createRecord(storage, root);
      await record.registerRoot(root);
      const action = createFact(root, "operation-strict-audit", 1_000);
      await storage.transaction((transaction) => {
        const acceptedAuditId = createAuditEntry(
          action,
          "action-accepted",
          ACCEPTED_AUDIT_DETAIL,
          10_000,
        ).auditId;
        transaction.appendAuditEntry({
          ...createAuditEntry(action, "action-rejected", "occupied audit identity", 10_000),
          auditId: acceptedAuditId,
        });
      });
      expect(await record.acceptAction(action)).toMatchObject({
        status: "rejected",
        reason: "storage-not-ready",
      });
      expect(await record.readActions()).toHaveLength(0);
      expect(await record.readMetadata()).toMatchObject({ actionCount: 0 });
      storage.close();
    });
  });

  test("blocks a new SQLite action when the injected interpreter is nondeterministic", async () => {
    await withDatabase(async (databasePath) => {
      const root = createRoot("record-sqlite-nondeterministic");
      const storage = openSqliteFoundationStorage(databasePath);
      await storage.applyMigrations();
      const seeded = createRecord(storage, root);
      await seeded.registerRoot(root);
      await seeded.acceptAction(createFact(root, "operation-seeded", 1_000));

      let rebuildCount = 0;
      const nondeterministic = createEventGameRecord(storage, {
        externalScopeResolver: createScopeResolver(root),
        clock: () => 10_000,
        interpreter: {
          version: "rules-v1",
          rebuild() {
            rebuildCount += 1;
            return { rebuildCount };
          },
        },
        auditAuthorityVerifier: testAuditAuthorityVerifier,
      });
      expect(await nondeterministic.registerRoot(root)).toMatchObject({ status: "idempotent" });
      expect(
        await nondeterministic.acceptAction(
          createFact(root, "operation-after-nondeterministic", 2_000),
        ),
      ).toMatchObject({ status: "rejected", reason: "storage-not-ready" });
      expect(await seeded.readActions()).toHaveLength(1);
      expect(await nondeterministic.readAudit(createAuditAuthority())).toHaveLength(1);
      storage.close();
    });
  });

  test("rechecks semantic history after an independent commit before the write lock", async () => {
    await withDatabase(async (databasePath) => {
      const root = createRoot("record-sqlite-cache-race");
      let arm = false;
      let injected = false;
      const storage = openSqliteFoundationStorage(databasePath, {
        beforeWriteTransactionLock() {
          if (!arm || injected) return;
          injected = true;
          const external = new Database(databasePath);
          const row = external
            .query(
              "SELECT action_json FROM foundation_event_game_record_actions WHERE operation_id = ?",
            )
            .get("operation-cache-seed") as { action_json: string } | null;
          if (row === null) throw new Error("Expected the seeded durable action.");
          const action = JSON.parse(row.action_json) as Record<string, unknown>;
          action.kind = { id: "game-fact", version: "99" };
          external
            .query(
              "UPDATE foundation_event_game_record_actions SET action_json = ?, action_version = ? WHERE operation_id = ?",
            )
            .run(JSON.stringify(action), "99", "operation-cache-seed");
          external.close();
        },
      });
      await storage.applyMigrations();
      const record = createRecord(storage, root);
      await record.registerRoot(root);
      expect(
        await record.acceptAction(createFact(root, "operation-cache-seed", 1_000)),
      ).toMatchObject({
        status: "accepted",
      });
      arm = true;

      expect(
        await record.acceptAction(createFact(root, "operation-after-cache-race", 2_000)),
      ).toMatchObject({ status: "rejected", reason: "storage-not-ready" });
      expect(await record.readActions()).toHaveLength(1);
      expect(await record.readAudit(createAuditAuthority())).toHaveLength(1);
      storage.close();
    });
  });
});

async function withDatabase(work: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "quadball-timer-action-sqlite-"));
  try {
    await work(join(directory, "foundation.sqlite"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function createRecord(
  storage: ReturnType<typeof openSqliteFoundationStorage>,
  root: EventGameRecordRoot,
) {
  return createEventGameRecord(storage, {
    externalScopeResolver: createScopeResolver(root),
    clock: () => 10_000,
    interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
    auditAuthorityVerifier: testAuditAuthorityVerifier,
  });
}

function createFact(
  root: EventGameRecordRoot,
  operationId: string,
  trustedAtMs: number,
): ControlActionInput {
  return {
    recordId: root.recordId,
    eventGameId: root.eventGameId,
    operationId,
    kind: { id: "game-fact", version: "1" },
    payload: {
      factId: `fact-${operationId}`,
      factType: "deterministic-test-fact",
      gameSideId: "side-a",
      gameTimeMs: trustedAtMs,
      data: { operationId },
    },
    causalPredecessorIds: [],
    occurrence: { trustedAtMs, clientOriginAtMs: trustedAtMs, source: "online" },
    grant: { sessionId: "session-1", versionId: "grant-version-1" },
    lifecycle: structuredClone(root.lifecycle),
  };
}

function createRoot(recordId: string): EventGameRecordRoot {
  return {
    recordId,
    eventId: `event-${recordId}`,
    eventGameId: `event-game-${recordId}`,
    ownership: { eventId: `event-${recordId}`, eventGameId: `event-game-${recordId}` },
    externalScope: {
      eventId: `event-${recordId}`,
      gameDayId: `day-${recordId}`,
      pitchId: `pitch-${recordId}`,
      pitchSlotId: `slot-${recordId}`,
    },
    gameSides: [
      { id: "side-a", eventTeamId: "team-a", teamInterpretationRef: "interpretation-a" },
      { id: "side-b", eventTeamId: "team-b", teamInterpretationRef: "interpretation-b" },
    ],
    lifecycle: {
      phase: "scheduled",
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
      operationId: `register-${recordId}`,
      actorReference: "event-admin-session-1",
      source: "event-game-registration",
      createdAtMs: 500,
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
  };
}

function createAuditAuthority(): object {
  return testAuditAuthority.credential;
}

function createTestAuditAuthority(role: "event-admin" | "technical-admin"): {
  credential: object;
  verifier: { verify(candidate: unknown): boolean };
} {
  const credentials = new WeakSet<object>();
  const credential = Object.freeze({ role });
  credentials.add(credential);
  return {
    credential,
    verifier: {
      verify(candidate: unknown) {
        return typeof candidate === "object" && candidate !== null && credentials.has(candidate);
      },
    },
  };
}

const testAuditAuthority = createTestAuditAuthority("technical-admin");
const testAuditAuthorityVerifier = testAuditAuthority.verifier;
