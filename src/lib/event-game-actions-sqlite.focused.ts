import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDeterministicTestIqaInterpreter,
  createControlActionCodecRegistry,
  actionIdentity,
  LEGACY_CONTROL_ACTION_VERSION,
  LEGACY_CONTROL_AUDIT_VERSION,
  materializeControlAction,
  prepareControlAction,
  sha256,
  type ControlActionInput,
} from "@/lib/event-game-actions";
import { createEventGameRecord, type ExternalScopeResolver } from "@/lib/event-game-record";
import {
  ACCEPTED_AUDIT_DETAIL,
  createAuditEntry,
  createConflictAuditEntry,
} from "@/lib/event-game-record-helpers";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import { canonicalizeEventGameRecordRoot } from "@/lib/foundation-record-types";
import { FOUNDATION_MIGRATIONS } from "@/lib/foundation-migrations";

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
      const audit = await reopenedRecord.readAudit(createAuditAuthority());
      expect(audit.length).toBe(1);
      expect(audit[0]).toMatchObject({
        links: {
          actionId: expect.any(String),
          targetFactId: null,
          causalPredecessorIds: [],
          relatedOperationIds: [],
        },
        provenance: {
          occurrence: action.occurrence,
          grant: action.grant,
          lifecycle: action.lifecycle,
          override: null,
          recoveryProvenance: null,
        },
      });
      expect(await reopenedRecord.rebuild()).toMatchObject({ status: "ready" });
      expect(await reopenedRecord.readiness()).toMatchObject({ ok: true, actionCount: 1 });
      reopenedStorage.close();
    });
  });

  test("fails closed for an out-of-scope Team Assignment Correction without SQLite partial retention", async () => {
    await withDatabase(async (databasePath) => {
      const root = createRoot("record-sqlite-team-scope");
      const storage = openSqliteFoundationStorage(databasePath);
      await storage.applyMigrations();
      const record = createRecord(storage, root);
      expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
      const correction: ControlActionInput = {
        ...createFact(root, "operation-team-out-of-scope", 1_000),
        kind: { id: "team-assignment-correction", version: "1" },
        payload: {
          correctionId: "correction-team-out-of-scope",
          gameSideId: "side-a",
          eventTeamId: "team-not-in-event",
          teamInterpretationRef: "interpretation-out-of-scope",
        },
      };
      expect(await record.acceptAction(correction)).toMatchObject({
        status: "rejected",
        reason: "invalid-action",
      });
      expect(await record.acceptAction(correction)).toMatchObject({
        status: "rejected",
        reason: "invalid-action",
      });
      expect(await record.readActions()).toHaveLength(0);
      expect(await record.readiness()).toMatchObject({ ok: true, actionCount: 0 });
      storage.close();
    });
  });

  test("uses current effective team assignments for SQLite reuse and rejects causal duplicates", async () => {
    await withDatabase(async (databasePath) => {
      const root = createRoot("record-sqlite-team-history");
      const storage = openSqliteFoundationStorage(databasePath);
      await storage.applyMigrations();
      const record = createRecord(storage, root);
      expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
      const moveSideB = createTeamAssignmentCorrection(
        root,
        "operation-team-b-to-d",
        "side-b",
        "team-d",
        "interpretation-b-d",
        1_000,
      );
      const reuseFreedTeam = createTeamAssignmentCorrection(
        root,
        "operation-team-a-to-b",
        "side-a",
        "team-b",
        "interpretation-a-b",
        2_000,
        ["operation-team-b-to-d"],
      );
      expect(await record.acceptAction(moveSideB)).toMatchObject({ status: "accepted" });
      expect(await record.acceptAction(reuseFreedTeam)).toMatchObject({ status: "accepted" });
      expect(await record.readiness()).toMatchObject({ ok: true, actionCount: 2 });
      storage.close();

      const reopenedStorage = openSqliteFoundationStorage(databasePath);
      const reopened = createRecord(reopenedStorage, root);
      expect(await reopened.registerRoot(root)).toMatchObject({ status: "idempotent" });
      expect(await reopened.readiness()).toMatchObject({ ok: true, actionCount: 2 });
      const rebuilt = await reopened.rebuild();
      expect(rebuilt).toMatchObject({ status: "ready" });
      if (rebuilt.status !== "ready") throw new Error("Expected a ready rebuild.");
      expect(rebuilt.effectiveTeamAssignments).toEqual([
        {
          gameSideId: "side-a",
          eventTeamId: "team-b",
          teamInterpretationRef: "interpretation-a-b",
        },
        {
          gameSideId: "side-b",
          eventTeamId: "team-d",
          teamInterpretationRef: "interpretation-b-d",
        },
      ]);

      const first = createTeamAssignmentCorrection(
        root,
        "operation-team-a-to-c",
        "side-a",
        "team-c",
        "interpretation-a-c",
        3_000,
        ["operation-team-a-to-b"],
      );
      const duplicate = createTeamAssignmentCorrection(
        root,
        "operation-team-b-to-c",
        "side-b",
        "team-c",
        "interpretation-b-c",
        4_000,
        ["operation-team-a-to-c"],
      );
      expect(await reopened.acceptAction(first)).toMatchObject({ status: "accepted" });
      expect(await reopened.acceptAction(duplicate)).toMatchObject({
        status: "rejected",
        reason: "invalid-action",
      });
      expect((await reopened.readActions()).map((stored) => stored.action.operationId)).toEqual([
        "operation-team-b-to-d",
        "operation-team-a-to-b",
        "operation-team-a-to-c",
      ]);
      expect(await reopened.readiness()).toMatchObject({ ok: true, actionCount: 3 });
      reopenedStorage.close();
    });
  });

  test("rebuilds overlapping team-conflict components and accepts a causal repair after restart", async () => {
    await withDatabase(async (databasePath) => {
      const root = createRoot("record-sqlite-team-component");
      const storage = openSqliteFoundationStorage(databasePath);
      await storage.applyMigrations();
      const record = createRecord(storage, root);
      expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
      const assignmentA1 = createTeamAssignmentCorrection(
        root,
        "team-component-a-1",
        "side-a",
        "team-c",
        "interpretation-a-c-1",
        1_000,
      );
      const assignmentB = createTeamAssignmentCorrection(
        root,
        "team-component-b",
        "side-b",
        "team-c",
        "interpretation-b-c",
        1_001,
      );
      const assignmentA2 = createTeamAssignmentCorrection(
        root,
        "team-component-a-2",
        "side-a",
        "team-c",
        "interpretation-a-c-2",
        1_002,
      );
      for (const action of [assignmentB, assignmentA2, assignmentA1]) {
        expect(await record.acceptAction(action)).toMatchObject({ status: "accepted" });
      }
      expect(await record.readiness()).toMatchObject({ ok: true, actionCount: 3 });
      storage.close();

      const reopenedStorage = openSqliteFoundationStorage(databasePath);
      const reopened = createRecord(reopenedStorage, root);
      expect(await reopened.registerRoot(root)).toMatchObject({ status: "idempotent" });
      expect(await reopened.readiness()).toMatchObject({ ok: true, actionCount: 3 });
      const rebuilt = await reopened.rebuild();
      expect(rebuilt).toMatchObject({ status: "ready" });
      if (rebuilt.status !== "ready") throw new Error("Expected a ready rebuild.");
      expect(rebuilt.effectiveTeamAssignments).toEqual([
        {
          gameSideId: "side-a",
          eventTeamId: "team-c",
          teamInterpretationRef: "interpretation-a-c-2",
        },
        {
          gameSideId: "side-b",
          eventTeamId: "team-b",
          teamInterpretationRef: "interpretation-b",
        },
      ]);
      expect(rebuilt.conflicts).toEqual([
        expect.objectContaining({
          operationIds: ["team-component-a-1", "team-component-b"],
          winnerOperationId: "team-component-b",
        }),
        expect.objectContaining({
          operationIds: ["team-component-b", "team-component-a-2"],
          winnerOperationId: "team-component-a-2",
        }),
      ]);

      const repair = createTeamAssignmentCorrection(
        root,
        "team-component-repair",
        "side-b",
        "team-d",
        "interpretation-b-d-repair",
        2_000,
        ["team-component-a-1", "team-component-b", "team-component-a-2"],
      );
      expect(await reopened.acceptAction(repair)).toMatchObject({ status: "accepted" });
      expect(await reopened.readiness()).toMatchObject({ ok: true, actionCount: 4 });
      const repaired = await reopened.rebuild();
      expect(repaired).toMatchObject({ status: "ready" });
      if (repaired.status !== "ready") throw new Error("Expected a ready rebuild.");
      expect(repaired.effectiveTeamAssignments).toEqual([
        {
          gameSideId: "side-a",
          eventTeamId: "team-c",
          teamInterpretationRef: "interpretation-a-c-2",
        },
        {
          gameSideId: "side-b",
          eventTeamId: "team-d",
          teamInterpretationRef: "interpretation-b-d-repair",
        },
      ]);
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
      const candidates: readonly ControlActionInput[] = [
        {
          ...action,
          payload: {
            ...(action.payload as Record<string, unknown>),
            data: { changed: true },
          },
        },
        {
          ...action,
          occurrence: { trustedAtMs: 1_001, clientOriginAtMs: 1_001, source: "online" },
        },
        {
          ...action,
          grant: { sessionId: "session-2", versionId: "grant-version-1" },
        },
        {
          ...action,
          causalPredecessorIds: ["operation-conflict"],
        },
        {
          ...action,
          kind: { id: "correction", version: "1" },
          payload: {
            correctionId: "correction-reused-operation",
            targetFactId: "fact-operation-conflict",
            effective: false,
          },
        },
      ];
      for (const candidate of candidates) {
        expect(await record.acceptAction(candidate)).toMatchObject({
          status: "rejected",
          reason: "operation-conflict",
        });
      }
      expect((await record.readActions()).length).toBe(1);
      expect(await record.readMetadata()).toMatchObject({ actionCount: 1 });
      expect(await record.readiness()).toMatchObject({ ok: true, actionCount: 1 });
      expect((await record.readAudit(createAuditAuthority())).length).toBe(candidates.length + 1);
      storage.close();

      const reopened = openSqliteFoundationStorage(databasePath);
      const reopenedRecord = createRecord(reopened, root);
      expect(await reopenedRecord.registerRoot(root)).toMatchObject({ status: "idempotent" });
      expect(await reopenedRecord.readiness()).toMatchObject({ ok: true, actionCount: 1 });
      expect(
        await reopenedRecord.acceptAction(createFact(root, "operation-after-conflict", 2_000)),
      ).toMatchObject({ status: "accepted" });
      reopened.close();
    });
  });

  test("fails readiness when durable rejected-collision evidence is not content-bound", async () => {
    const mutations: readonly [string, (audit: Record<string, unknown>) => void][] = [
      [
        "interpretation",
        (audit) => {
          const rejected = requiredRejectedAttempt(audit);
          const interpretation = rejected.interpretation as Record<string, unknown>;
          interpretation.factType = "tampered-fact-type";
        },
      ],
      [
        "canonical-content",
        (audit) => {
          requiredRejectedAttempt(audit).canonicalContent = "{}";
        },
      ],
      [
        "fingerprint",
        (audit) => {
          const rejected = requiredRejectedAttempt(audit);
          rejected.contentFingerprint = "f".repeat(64);
          audit.auditId = `audit-${sha256(`${String(audit.recordId)}:operation-conflict:${String(audit.operationId)}:${String(rejected.contentFingerprint)}`)}`;
        },
      ],
      [
        "accepted-operation",
        (audit) => {
          const collision = (audit.links as Record<string, unknown>).collision as Record<
            string,
            unknown
          >;
          collision.acceptedOperationId = "operation-not-retained";
        },
      ],
      [
        "accepted-action-id",
        (audit) => {
          const links = audit.links as Record<string, unknown>;
          links.actionId = "action-not-retained";
        },
      ],
      [
        "ordering-operation",
        (audit) => {
          const links = audit.links as Record<string, unknown>;
          (links.ordering as Record<string, unknown>).operationId = "operation-not-retained";
        },
      ],
      [
        "entry-operation",
        (audit) => {
          audit.operationId = "operation-retargeted";
        },
      ],
      [
        "accepted-fingerprint",
        (audit) => {
          const collision = (audit.links as Record<string, unknown>).collision as Record<
            string,
            unknown
          >;
          collision.acceptedContentFingerprint = "f".repeat(64);
        },
      ],
      [
        "accepted-provenance",
        (audit) => {
          const provenance = audit.provenance as Record<string, unknown>;
          (provenance.grant as Record<string, unknown>).sessionId = "session-retargeted";
        },
      ],
    ];

    for (const [label, mutate] of mutations) {
      await withDatabase(async (databasePath) => {
        const root = createRoot(`record-sqlite-collision-${label}`);
        const storage = openSqliteFoundationStorage(databasePath);
        await storage.applyMigrations();
        const record = createRecord(storage, root);
        await record.registerRoot(root);
        const accepted = createFact(root, "operation-collision", 1_000);
        expect(await record.acceptAction(accepted)).toMatchObject({ status: "accepted" });
        expect(
          await record.acceptAction({
            ...accepted,
            payload: {
              ...(accepted.payload as Record<string, unknown>),
              data: { rejected: true },
            },
          }),
        ).toMatchObject({ status: "rejected", reason: "operation-conflict" });
        expect(await record.readiness()).toMatchObject({ ok: true, actionCount: 1 });
        storage.close();

        const database = new Database(databasePath);
        const row = database
          .query(
            "SELECT audit_id, audit_json FROM foundation_event_game_record_audit WHERE audit_kind = 'action-conflict'",
          )
          .get() as { audit_id: string; audit_json: string } | null;
        if (row === null) throw new Error("Expected rejected collision evidence.");
        const audit = JSON.parse(row.audit_json) as Record<string, unknown>;
        mutate(audit);
        database
          .query(
            "UPDATE foundation_event_game_record_audit SET audit_id = ?, audit_json = ? WHERE audit_id = ?",
          )
          .run(String(audit.auditId), JSON.stringify(audit), row.audit_id);
        database.close();

        const reopened = openSqliteFoundationStorage(databasePath);
        const reopenedRecord = createRecord(reopened, root);
        expect(await reopenedRecord.registerRoot(root)).toMatchObject({ status: "idempotent" });
        expect(await reopenedRecord.readiness(), label).toMatchObject({
          ok: false,
          status: "rebuild-failure",
        });
        expect(
          await reopenedRecord.acceptAction(createFact(root, "operation-after-corruption", 2_000)),
        ).toMatchObject({ status: "rejected", reason: "storage-not-ready" });
        reopened.close();
      });
    }
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

  test("fails readiness when a conflict audit consistently rewrites the loser as canonical winner", async () => {
    await withDatabase(async (databasePath) => {
      const root = createRoot("record-sqlite-conflict-winner-corrupt");
      const storage = openSqliteFoundationStorage(databasePath);
      await storage.applyMigrations();
      const record = createRecord(storage, root);
      await record.registerRoot(root);
      expect(await record.acceptAction(createFact(root, "operation-fact", 1_000))).toMatchObject({
        status: "accepted",
      });
      expect(
        await record.acceptAction(createCorrection(root, "correction-false", false, 2_000)),
      ).toMatchObject({ status: "accepted" });
      expect(
        await record.acceptAction(createCorrection(root, "correction-true", true, 2_000)),
      ).toMatchObject({ status: "accepted" });
      storage.close();

      const database = new Database(databasePath);
      const conflictRow = database
        .query(
          "SELECT audit_id, audit_json FROM foundation_event_game_record_audit WHERE audit_kind = 'action-conflict'",
        )
        .get() as { audit_id: string; audit_json: string } | null;
      const loserRow = database
        .query(
          "SELECT audit_json FROM foundation_event_game_record_audit WHERE operation_id = ? AND audit_kind = 'action-accepted'",
        )
        .get("correction-false") as { audit_json: string } | null;
      if (conflictRow === null || loserRow === null)
        throw new Error("Expected conflict audit rows.");
      const conflict = JSON.parse(conflictRow.audit_json) as Record<string, any>;
      const loser = JSON.parse(loserRow.audit_json) as Record<string, any>;
      conflict.links = {
        ...loser.links,
        relatedOperationIds: ["correction-false", "correction-true"],
      };
      conflict.provenance = loser.provenance;
      conflict.redactedDetail =
        "Opposing Concurrent Corrections resolved for fact-operation-fact; winner correction-false";
      conflict.auditId = `audit-${sha256(
        `${root.recordId}:concurrent-correction:fact-operation-fact:correction-false:correction-true:correction-false`,
      )}`;
      database
        .query(
          "UPDATE foundation_event_game_record_audit SET audit_id = ?, redacted_detail = ?, audit_json = ? WHERE audit_id = ?",
        )
        .run(
          conflict.auditId,
          conflict.redactedDetail,
          JSON.stringify(conflict),
          conflictRow.audit_id,
        );
      database.close();

      const reopened = openSqliteFoundationStorage(databasePath);
      const reopenedRecord = createRecord(reopened, root);
      expect(await reopenedRecord.registerRoot(root)).toMatchObject({ status: "idempotent" });
      expect(await reopenedRecord.readiness()).toMatchObject({
        ok: false,
        status: "rebuild-failure",
      });
      reopened.close();
    });
  });

  test("freezes writes after restart when a correction conflict audit is deleted", async () => {
    await withDatabase(async (databasePath) => {
      const root = createRoot("record-sqlite-missing-correction-conflict");
      const storage = openSqliteFoundationStorage(databasePath);
      await storage.applyMigrations();
      const record = createRecord(storage, root);
      await record.registerRoot(root);
      expect(await record.acceptAction(createFact(root, "operation-fact", 1_000))).toMatchObject({
        status: "accepted",
      });
      expect(
        await record.acceptAction(createCorrection(root, "correction-false", false, 2_000)),
      ).toMatchObject({ status: "accepted" });
      expect(
        await record.acceptAction(createCorrection(root, "correction-true", true, 2_000)),
      ).toMatchObject({ status: "accepted" });
      storage.close();

      const database = new Database(databasePath);
      const deletion = database
        .query(
          "DELETE FROM foundation_event_game_record_audit WHERE audit_kind = 'action-conflict' AND outcome = 'conflict-resolved' AND redacted_detail LIKE 'Opposing Concurrent Corrections resolved %'",
        )
        .run();
      expect(deletion.changes).toBe(1);
      database.close();

      const reopened = openSqliteFoundationStorage(databasePath);
      const reopenedRecord = createRecord(reopened, root);
      expect(await reopenedRecord.registerRoot(root)).toMatchObject({ status: "idempotent" });
      expect(await reopenedRecord.readiness()).toMatchObject({
        ok: false,
        status: "rebuild-failure",
        detail: "Control Audit Trail is missing canonical conflict evidence.",
      });
      expect(
        await reopenedRecord.acceptAction(createFact(root, "operation-after-delete", 3_000)),
      ).toMatchObject({ status: "rejected", reason: "storage-not-ready" });
      reopened.close();
    });
  });

  test("freezes writes after restart when a team-assignment conflict audit is deleted", async () => {
    await withDatabase(async (databasePath) => {
      const root = createRoot("record-sqlite-missing-team-conflict");
      const storage = openSqliteFoundationStorage(databasePath);
      await storage.applyMigrations();
      const record = createRecord(storage, root);
      await record.registerRoot(root);
      expect(
        await record.acceptAction(
          createTeamAssignmentCorrection(
            root,
            "team-assignment-a",
            "side-a",
            "team-c",
            "interpretation-a-c",
            1_000,
          ),
        ),
      ).toMatchObject({ status: "accepted" });
      expect(
        await record.acceptAction(
          createTeamAssignmentCorrection(
            root,
            "team-assignment-b",
            "side-b",
            "team-c",
            "interpretation-b-c",
            1_000,
          ),
        ),
      ).toMatchObject({ status: "accepted" });
      storage.close();

      const database = new Database(databasePath);
      const deletion = database
        .query(
          "DELETE FROM foundation_event_game_record_audit WHERE audit_kind = 'action-conflict' AND outcome = 'conflict-resolved' AND redacted_detail LIKE 'Opposing Concurrent Team Assignments resolved %'",
        )
        .run();
      expect(deletion.changes).toBe(1);
      database.close();

      const reopened = openSqliteFoundationStorage(databasePath);
      const reopenedRecord = createRecord(reopened, root);
      expect(await reopenedRecord.registerRoot(root)).toMatchObject({ status: "idempotent" });
      expect(await reopenedRecord.readiness()).toMatchObject({
        ok: false,
        status: "rebuild-failure",
        detail: "Control Audit Trail is missing canonical conflict evidence.",
      });
      expect(
        await reopenedRecord.acceptAction(createFact(root, "operation-after-delete", 2_000)),
      ).toMatchObject({ status: "rejected", reason: "storage-not-ready" });
      reopened.close();
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

  test("does not allow current evidence to be downgraded into the legacy validation path", async () => {
    const mutations: readonly [string, (database: Database, root: EventGameRecordRoot) => void][] =
      [
        [
          "action",
          (database, root) => {
            const row = database
              .query(
                "SELECT action_json FROM foundation_event_game_record_actions WHERE record_id = ?",
              )
              .get(root.recordId) as { action_json: string } | null;
            if (row === null) throw new Error("Expected a current action.");
            const action = JSON.parse(row.action_json) as Record<string, unknown>;
            action.controlActionVersion = "control-action-legacy-v0";
            database
              .query(
                "UPDATE foundation_event_game_record_actions SET action_json = ?, control_action_version = ?, action_evidence_format = ? WHERE record_id = ?",
              )
              .run(JSON.stringify(action), "control-action-legacy-v0", "legacy", root.recordId);
          },
        ],
        [
          "audit",
          (database, root) => {
            const row = database
              .query(
                "SELECT audit_id, audit_json FROM foundation_event_game_record_audit WHERE record_id = ? LIMIT 1",
              )
              .get(root.recordId) as { audit_id: string; audit_json: string } | null;
            if (row === null) throw new Error("Expected current audit evidence.");
            const audit = JSON.parse(row.audit_json) as Record<string, unknown>;
            audit.auditVersion = "control-audit-legacy-v0";
            delete audit.links;
            delete audit.provenance;
            database
              .query(
                "UPDATE foundation_event_game_record_audit SET audit_json = ?, audit_version = ?, audit_evidence_format = ? WHERE audit_id = ?",
              )
              .run(JSON.stringify(audit), "control-audit-legacy-v0", "legacy", row.audit_id);
          },
        ],
      ];

    for (const [label, mutate] of mutations) {
      await withDatabase(async (databasePath) => {
        const root = createRoot(`record-sqlite-evidence-downgrade-${label}`);
        const storage = openSqliteFoundationStorage(databasePath);
        await storage.applyMigrations();
        const record = createRecord(storage, root);
        await record.registerRoot(root);
        expect(
          await record.acceptAction(createFact(root, "operation-current", 1_000)),
        ).toMatchObject({
          status: "accepted",
        });
        storage.close();

        const database = new Database(databasePath);
        mutate(database, root);
        database.close();

        const reopened = openSqliteFoundationStorage(databasePath);
        const reopenedRecord = createRecord(reopened, root);
        expect(await reopenedRecord.registerRoot(root)).toMatchObject({ status: "idempotent" });
        expect(await reopenedRecord.readiness(), label).toMatchObject({
          ok: false,
          status: "rebuild-failure",
        });
        reopened.close();
      });
    }
  });

  test("preserves genuine pre-#75 legacy rows through migration while current provenance stays distinct", async () => {
    await withDatabase(async (databasePath) => {
      const root = createRoot("record-sqlite-legacy-migration");
      const legacy = openSqliteFoundationStorage(databasePath, {
        migrations: [
          (await import("@/lib/foundation-migrations")).FOUNDATION_MIGRATIONS[0]!,
          (await import("@/lib/foundation-migrations")).FOUNDATION_MIGRATIONS[1]!,
          (await import("@/lib/foundation-migrations")).FOUNDATION_MIGRATIONS[2]!,
        ],
      });
      await legacy.applyMigrations({ requireCandidate: false });
      legacy.close();

      const legacyDatabase = new Database(databasePath);
      legacyDatabase
        .query(
          "INSERT INTO foundation_event_game_record_roots (record_id, event_id, event_game_id, owner_event_id, owner_event_game_id, scope_event_id, game_day_id, pitch_id, pitch_slot_id, lifecycle_phase, commenced_at_ms, finished_at_ms, locked_at_ms, lock_reason, record_version, schema_version, interpreter_version, creation_operation_id, creation_actor_reference, creation_source, creation_created_at_ms, canonical_content, root_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
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
          canonicalizeEventGameRecordRoot(root),
          JSON.stringify(root),
        );
      legacyDatabase
        .query(
          "INSERT INTO foundation_event_game_record_sides (side_id, record_id, side_position, event_team_id, team_interpretation_ref) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          root.gameSides[0]!.id,
          root.recordId,
          "a",
          root.gameSides[0]!.eventTeamId,
          root.gameSides[0]!.teamInterpretationRef,
        );
      legacyDatabase
        .query(
          "INSERT INTO foundation_event_game_record_sides (side_id, record_id, side_position, event_team_id, team_interpretation_ref) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          root.gameSides[1]!.id,
          root.recordId,
          "b",
          root.gameSides[1]!.eventTeamId,
          root.gameSides[1]!.teamInterpretationRef,
        );
      legacyDatabase
        .query(
          "INSERT INTO foundation_event_game_record_metadata (record_id, action_count, ordering_version, last_accepted_at_ms, updated_at_ms) VALUES (?, 0, ?, NULL, ?)",
        )
        .run(root.recordId, "causal-occurrence-operation-v1", root.creationEvidence.createdAtMs);
      legacyDatabase.close();

      const input = createFact(root, "legacy-operation", 1_000);
      const prepared = prepareControlAction(
        input,
        root,
        createControlActionCodecRegistry(),
        10_000,
      );
      if (!prepared.ok) throw new Error(prepared.error);
      const action = materializeControlAction(prepared.value, 10_000);
      action.controlActionVersion = LEGACY_CONTROL_ACTION_VERSION;
      const audit = createAuditEntry(input, "action-accepted", ACCEPTED_AUDIT_DETAIL, 10_000, {
        interpretation: prepared.value.interpretation,
      });
      audit.auditVersion = LEGACY_CONTROL_AUDIT_VERSION;
      delete audit.links;
      delete audit.provenance;
      const database = new Database(databasePath);
      database
        .query(
          "INSERT INTO foundation_event_game_record_actions (action_id, record_id, event_game_id, operation_id, action_kind, action_version, accepted_at_ms, content_fingerprint, canonical_content, action_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          actionIdentity(root.recordId, action.operationId),
          root.recordId,
          root.eventGameId,
          action.operationId,
          action.kind.id,
          action.kind.version,
          action.acceptedAtMs,
          prepared.value.contentFingerprint,
          prepared.value.canonicalContent,
          JSON.stringify(action),
        );
      database
        .query(
          "INSERT INTO foundation_event_game_record_idempotency (action_id, record_id, operation_id, content_fingerprint, accepted_at_ms) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          actionIdentity(root.recordId, action.operationId),
          root.recordId,
          action.operationId,
          prepared.value.contentFingerprint,
          action.acceptedAtMs,
        );
      database
        .query(
          "UPDATE foundation_event_game_record_metadata SET action_count = 1, last_accepted_at_ms = ?, updated_at_ms = ? WHERE record_id = ?",
        )
        .run(action.acceptedAtMs, action.acceptedAtMs, root.recordId);
      database
        .query(
          "INSERT INTO foundation_event_game_record_audit (audit_id, record_id, event_game_id, operation_id, audit_kind, outcome, created_at_ms, redacted_detail, audit_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          audit.auditId,
          audit.recordId,
          audit.eventGameId,
          audit.operationId,
          audit.kind,
          audit.outcome,
          audit.createdAtMs,
          audit.redactedDetail,
          JSON.stringify(audit),
        );
      database.close();

      const current = openSqliteFoundationStorage(databasePath);
      expect((await current.applyMigrations()).schemaVersion).toBe(9);
      const currentRecord = createRecord(current, root);
      expect(await currentRecord.registerRoot(root)).toMatchObject({ status: "idempotent" });
      expect(await currentRecord.readiness()).toMatchObject({ ok: true, actionCount: 1 });
      expect(await currentRecord.rebuild()).toMatchObject({ status: "ready" });
      current.close();
    });
  });

  test("keeps a migrated legacy opposing pair ready after an unrelated current Fact", async () => {
    await withDatabase(async (databasePath) => {
      const root = createRoot("record-sqlite-legacy-conflict-unrelated-current");
      await seedLegacyConflictHistory(databasePath, root);

      const storage = openSqliteFoundationStorage(databasePath);
      expect((await storage.applyMigrations()).schemaVersion).toBe(9);
      const record = createRecord(storage, root);
      expect(await record.registerRoot(root)).toMatchObject({ status: "idempotent" });
      expect(await record.readiness()).toMatchObject({ ok: true, actionCount: 3 });
      expect(await record.acceptAction(createFact(root, "current-unrelated", 3_000))).toMatchObject(
        { status: "accepted" },
      );
      expect(await record.readiness()).toMatchObject({ ok: true, actionCount: 4 });
      expect(
        await record.acceptAction(createFact(root, "current-after-legacy", 4_000)),
      ).toMatchObject({ status: "accepted" });
      storage.close();
    });
  });

  test("requires and freezes on missing current evidence added to migrated legacy conflict history", async () => {
    await withDatabase(async (databasePath) => {
      const root = createRoot("record-sqlite-legacy-conflict-current-participant");
      await seedLegacyConflictHistory(databasePath, root);

      const storage = openSqliteFoundationStorage(databasePath);
      expect((await storage.applyMigrations()).schemaVersion).toBe(9);
      const record = createRecord(storage, root);
      expect(await record.registerRoot(root)).toMatchObject({ status: "idempotent" });
      expect(
        await record.acceptAction(createCorrection(root, "correction-z-current", false, 3_000)),
      ).toMatchObject({ status: "accepted" });
      expect(await record.readiness()).toMatchObject({ ok: true, actionCount: 4 });
      storage.close();

      const database = new Database(databasePath);
      const deletion = database
        .query(
          "DELETE FROM foundation_event_game_record_audit WHERE audit_kind = 'action-conflict' AND outcome = 'conflict-resolved' AND redacted_detail LIKE 'Opposing Concurrent Corrections resolved %winner correction-z-current'",
        )
        .run();
      expect(deletion.changes).toBe(1);
      database.close();

      const reopened = openSqliteFoundationStorage(databasePath);
      const reopenedRecord = createRecord(reopened, root);
      expect(await reopenedRecord.registerRoot(root)).toMatchObject({ status: "idempotent" });
      expect(await reopenedRecord.readiness()).toMatchObject({
        ok: false,
        status: "rebuild-failure",
        detail: "Control Audit Trail is missing canonical conflict evidence.",
      });
      expect(
        await reopenedRecord.acceptAction(createFact(root, "current-after-delete", 4_000)),
      ).toMatchObject({ status: "rejected", reason: "storage-not-ready" });
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

  test("fails closed on #75 audit linkage, predecessor, provenance, and rejected-entry corruption", async () => {
    const mutations: readonly [string, (audit: Record<string, unknown>) => void][] = [
      [
        "missing-version",
        (audit) => {
          delete audit.auditVersion;
          delete audit.links;
          delete audit.provenance;
        },
      ],
      ["missing-links", (audit) => delete audit.links],
      [
        "wrong-predecessors",
        (audit) => {
          const links = audit.links as Record<string, unknown>;
          links.causalPredecessorIds = ["operation-retained"];
        },
      ],
      [
        "missing-override-evidence",
        (audit) => {
          const provenance = audit.provenance as Record<string, unknown>;
          delete provenance.override;
        },
      ],
      [
        "invalid-recovery-id",
        (audit) => {
          const provenance = audit.provenance as Record<string, unknown>;
          provenance.recoveryProvenance = {
            importId: "import-1",
            sourceRecordId: "record-audit-corrupt-invalid-recovery-id",
            sourceEventGameId: "event-game-record-audit-corrupt-invalid-recovery-id",
            sourceOperationId: "operation-retained",
            sourceReference: "é",
            sourceAcceptedAtMs: 1,
          };
        },
      ],
    ];
    for (const [label, mutate] of mutations) {
      await withDatabase(async (databasePath) => {
        const root = createRoot(`record-audit-corrupt-${label}`);
        const storage = openSqliteFoundationStorage(databasePath);
        await storage.applyMigrations();
        const record = createRecord(storage, root);
        await record.registerRoot(root);
        await record.acceptAction(createFact(root, "operation-retained", 1_000));
        if (label === "missing-links" || label === "missing-override-evidence") {
          await record.acceptAction({
            ...createFact(root, "operation-rejected", 2_000),
            kind: { id: "correction", version: "1" },
            payload: {
              correctionId: "correction-rejected",
              targetFactId: "missing-fact",
              effective: false,
            },
          });
        }
        storage.close();
        const database = new Database(databasePath);
        const row = database
          .query(
            "SELECT audit_id, audit_json FROM foundation_event_game_record_audit WHERE record_id = ? ORDER BY rowid DESC LIMIT 1",
          )
          .get(root.recordId) as { audit_id: string; audit_json: string } | null;
        if (row === null) throw new Error("Expected a durable audit row.");
        const audit = JSON.parse(row.audit_json) as Record<string, unknown>;
        mutate(audit);
        database
          .query("UPDATE foundation_event_game_record_audit SET audit_json = ? WHERE audit_id = ?")
          .run(JSON.stringify(audit), row.audit_id);
        if (label === "missing-version") {
          const actionRow = database
            .query(
              "SELECT action_json FROM foundation_event_game_record_actions WHERE operation_id = ?",
            )
            .get("operation-retained") as { action_json: string } | null;
          if (actionRow === null) throw new Error("Expected a durable action row.");
          const action = JSON.parse(actionRow.action_json) as Record<string, unknown>;
          delete action.controlActionVersion;
          database
            .query(
              "UPDATE foundation_event_game_record_actions SET action_json = ? WHERE operation_id = ?",
            )
            .run(JSON.stringify(action), "operation-retained");
        }
        database.close();
        const reopened = openSqliteFoundationStorage(databasePath);
        const reopenedRecord = createRecord(reopened, root);
        expect(await reopenedRecord.registerRoot(root)).toMatchObject({ status: "idempotent" });
        expect(await reopenedRecord.readiness()).toMatchObject({ ok: false });
        expect(
          await reopenedRecord.acceptAction(createFact(root, "operation-after-corruption", 3_000)),
        ).toMatchObject({ status: "rejected", reason: "storage-not-ready" });
        reopened.close();
      });
    }
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

async function seedLegacyConflictHistory(
  databasePath: string,
  root: EventGameRecordRoot,
): Promise<void> {
  const legacy = openSqliteFoundationStorage(databasePath, {
    migrations: FOUNDATION_MIGRATIONS.slice(0, 3),
  });
  await legacy.applyMigrations({ requireCandidate: false });
  legacy.close();

  const database = new Database(databasePath);
  database
    .query(
      "INSERT INTO foundation_event_game_record_roots (record_id, event_id, event_game_id, owner_event_id, owner_event_game_id, scope_event_id, game_day_id, pitch_id, pitch_slot_id, lifecycle_phase, commenced_at_ms, finished_at_ms, locked_at_ms, lock_reason, record_version, schema_version, interpreter_version, creation_operation_id, creation_actor_reference, creation_source, creation_created_at_ms, canonical_content, root_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
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
      canonicalizeEventGameRecordRoot(root),
      JSON.stringify(root),
    );
  for (const [side, position] of root.gameSides.map(
    (side, index) => [side, index === 0 ? "a" : "b"] as const,
  )) {
    database
      .query(
        "INSERT INTO foundation_event_game_record_sides (side_id, record_id, side_position, event_team_id, team_interpretation_ref) VALUES (?, ?, ?, ?, ?)",
      )
      .run(side.id, root.recordId, position, side.eventTeamId, side.teamInterpretationRef);
  }
  database
    .query(
      "INSERT INTO foundation_event_game_record_metadata (record_id, action_count, ordering_version, last_accepted_at_ms, updated_at_ms) VALUES (?, 0, ?, NULL, ?)",
    )
    .run(root.recordId, "causal-occurrence-operation-v1", root.creationEvidence.createdAtMs);

  const inputs = [
    createFact(root, "operation-fact", 1_000),
    createCorrection(root, "correction-false", false, 2_000),
    createCorrection(root, "correction-true", true, 2_000),
  ];
  const preparedActions = inputs.map((input) => {
    const prepared = prepareControlAction(input, root, createControlActionCodecRegistry(), 10_000);
    if (!prepared.ok) throw new Error(prepared.error);
    const action = materializeControlAction(prepared.value, 10_000);
    action.controlActionVersion = LEGACY_CONTROL_ACTION_VERSION;
    return { input, prepared, action };
  });
  for (const { prepared, action } of preparedActions) {
    database
      .query(
        "INSERT INTO foundation_event_game_record_actions (action_id, record_id, event_game_id, operation_id, action_kind, action_version, accepted_at_ms, content_fingerprint, canonical_content, action_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        actionIdentity(root.recordId, action.operationId),
        root.recordId,
        root.eventGameId,
        action.operationId,
        action.kind.id,
        action.kind.version,
        action.acceptedAtMs,
        prepared.value.contentFingerprint,
        prepared.value.canonicalContent,
        JSON.stringify(action),
      );
    database
      .query(
        "INSERT INTO foundation_event_game_record_idempotency (action_id, record_id, operation_id, content_fingerprint, accepted_at_ms) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        actionIdentity(root.recordId, action.operationId),
        root.recordId,
        action.operationId,
        prepared.value.contentFingerprint,
        action.acceptedAtMs,
      );
  }
  const audits = preparedActions.map(({ input, prepared }) => {
    const audit = createAuditEntry(input, "action-accepted", ACCEPTED_AUDIT_DETAIL, 10_000, {
      interpretation: prepared.value.interpretation,
    });
    audit.auditVersion = LEGACY_CONTROL_AUDIT_VERSION;
    delete audit.links;
    delete audit.provenance;
    return audit;
  });
  const conflictAudit = createConflictAuditEntry(
    preparedActions[1]!.action,
    preparedActions[2]!.action,
    "fact-operation-fact",
    "correction-true",
    10_000,
  );
  conflictAudit.auditVersion = LEGACY_CONTROL_AUDIT_VERSION;
  delete conflictAudit.links;
  delete conflictAudit.provenance;
  audits.push(conflictAudit);
  for (const audit of audits) {
    database
      .query(
        "INSERT INTO foundation_event_game_record_audit (audit_id, record_id, event_game_id, operation_id, audit_kind, outcome, created_at_ms, redacted_detail, audit_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        audit.auditId,
        audit.recordId,
        audit.eventGameId,
        audit.operationId,
        audit.kind,
        audit.outcome,
        audit.createdAtMs,
        audit.redactedDetail,
        JSON.stringify(audit),
      );
  }
  database
    .query(
      "UPDATE foundation_event_game_record_metadata SET action_count = ?, last_accepted_at_ms = ?, updated_at_ms = ? WHERE record_id = ?",
    )
    .run(inputs.length, 10_000, 10_000, root.recordId);
  database.close();
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

function createCorrection(
  root: EventGameRecordRoot,
  operationId: string,
  effective: boolean,
  trustedAtMs: number,
): ControlActionInput {
  return {
    ...createFact(root, operationId, trustedAtMs),
    kind: { id: "correction", version: "1" },
    payload: {
      correctionId: operationId,
      targetFactId: "fact-operation-fact",
      effective,
    },
  };
}

function createTeamAssignmentCorrection(
  root: EventGameRecordRoot,
  operationId: string,
  gameSideId: string,
  eventTeamId: string,
  teamInterpretationRef: string,
  trustedAtMs: number,
  causalPredecessorIds: readonly string[] = [],
): ControlActionInput {
  return {
    ...createFact(root, operationId, trustedAtMs),
    kind: { id: "team-assignment-correction", version: "1" },
    payload: {
      correctionId: operationId,
      gameSideId,
      eventTeamId,
      teamInterpretationRef,
    },
    causalPredecessorIds,
  };
}

function requiredRejectedAttempt(audit: Record<string, unknown>): Record<string, unknown> {
  const links = audit.links as Record<string, unknown> | undefined;
  const collision = links?.collision as Record<string, unknown> | undefined;
  const rejectedAttempt = collision?.rejectedAttempt;
  if (typeof rejectedAttempt !== "object" || rejectedAttempt === null) {
    throw new Error("Expected rejected collision evidence.");
  }
  return rejectedAttempt as Record<string, unknown>;
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
    resolveEventTeam(eventId, eventTeamId) {
      return eventId === root.eventId &&
        ["team-a", "team-b", "team-c", "team-d", "team-e"].includes(eventTeamId)
        ? { status: "resolved" }
        : { status: "mismatch", detail: "The Event Team is outside the Event scope." };
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
