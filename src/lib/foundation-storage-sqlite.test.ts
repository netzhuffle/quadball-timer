import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checksumMigrationSql,
  FOUNDATION_MIGRATIONS,
  type FoundationMigration,
} from "@/lib/foundation-migrations";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import { createDeterministicTestIqaInterpreter } from "@/lib/event-game-actions";
import { createFoundationAcceptance } from "@/lib/foundation-acceptance";
import type { ControlActionInput } from "@/lib/event-game-actions";
import { createEventGameRecord, type ExternalScopeResolver } from "@/lib/event-game-record";
import {
  FoundationMigrationError,
  openSqliteFoundationStorage,
  SqliteFoundationFault,
} from "@/lib/foundation-storage-sqlite";
import { createGrantTestKeyRing } from "@/lib/grant-authority-contract";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import {
  createGrantTestAuthorityVerifier,
  createLegacyControlGrantTestAuthority,
} from "@/lib/grant-authority-test-support";

async function withDatabase<T>(work: (databasePath: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "quadball-timer-sqlite-"));
  try {
    return await work(join(directory, "foundation.sqlite"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("SQLite foundation storage", () => {
  test("latches an after-COMMIT boundary failure without claiming readiness", async () => {
    await withDatabase(async (databasePath) => {
      let injected = true;
      const storage = openSqliteFoundationStorage(databasePath, {
        faultInjector(phase) {
          if (injected && phase === "after-commit")
            throw new SqliteFoundationFault("commit-failure");
        },
      });
      await storage.applyMigrations();
      expect(await storage.readiness()).toMatchObject({
        ok: false,
        status: "not-writeable",
        evidence: { sqlite: { failureCategory: "commit-failure" } },
      });
      injected = false;
      expect(await storage.readiness()).toMatchObject({
        ok: true,
        evidence: { sqlite: { failureCategory: null }, transaction: { writePressure: "normal" } },
      });
      storage.close();
    });
  });

  test("treats corruption as terminal and never probes or changes the database after restart", async () => {
    await withDatabase(async (databasePath) => {
      let injectCorruption = true;
      let probeCalls = 0;
      const storage = openSqliteFoundationStorage(databasePath, {
        faultInjector(phase) {
          if (phase === "readiness-write-probe") {
            probeCalls += 1;
            if (injectCorruption) throw new SqliteFoundationFault("corruption");
          }
        },
      });
      await storage.applyMigrations();
      const markerPath = storage.quarantineMarkerPath;
      expect(markerPath).toBe(`${databasePath}.quarantine`);
      const before = new Database(databasePath);
      const beforeUserVersion = before.query("PRAGMA user_version").get();
      before.close();

      expect(await storage.readiness()).toMatchObject({
        ok: false,
        status: "integrity-failure",
        evidence: { sqlite: { failureCategory: "corruption" } },
      });
      expect(markerPath === null ? null : readFileSync(markerPath, "utf8")).toBe(
        "quadball-timer-foundation-quarantine-v1\ncategory=corruption\n",
      );
      expect(markerPath === null ? null : statSync(markerPath).size).toBeLessThanOrEqual(128);
      expect(markerPath === null ? null : statSync(markerPath).mode & 0o777).toBe(0o600);
      expect(await storage.readiness()).toMatchObject({
        ok: false,
        status: "integrity-failure",
        evidence: { sqlite: { failureCategory: "corruption" } },
      });
      expect(probeCalls).toBe(1);
      injectCorruption = false;
      expect(await storage.readiness()).toMatchObject({ ok: false, status: "integrity-failure" });
      expect(probeCalls).toBe(1);

      const frozenRecord = createEventGameRecord(storage, {
        externalScopeResolver: createScopeResolver(createRoot("corruption-frozen")),
        interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      });
      expect(await frozenRecord.registerRoot(createRoot("corruption-frozen"))).toMatchObject({
        status: "rejected",
        reason: "storage-not-ready",
      });
      const after = new Database(databasePath);
      expect(after.query("PRAGMA user_version").get()).toEqual(beforeUserVersion);
      expect(
        after.query("SELECT COUNT(*) AS count FROM foundation_event_game_record_roots").get(),
      ).toEqual({
        count: 0,
      });
      after.close();
      storage.close();

      let restartedProbeCalls = 0;
      const restarted = openSqliteFoundationStorage(databasePath, {
        faultInjector(phase) {
          if (phase === "readiness-write-probe") restartedProbeCalls += 1;
        },
      });
      expect(await restarted.readiness()).toMatchObject({
        ok: false,
        status: "integrity-failure",
        evidence: { sqlite: { failureCategory: "corruption" } },
      });
      expect(restartedProbeCalls).toBe(0);
      const frozenAfterRestart = createEventGameRecord(restarted, {
        externalScopeResolver: createScopeResolver(createRoot("corruption-restart-frozen")),
        interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      });
      expect(
        await frozenAfterRestart.registerRoot(createRoot("corruption-restart-frozen")),
      ).toMatchObject({ status: "rejected", reason: "storage-not-ready" });
      const afterRestart = new Database(databasePath);
      expect(afterRestart.query("PRAGMA user_version").get()).toEqual(beforeUserVersion);
      expect(
        afterRestart
          .query("SELECT COUNT(*) AS count FROM foundation_event_game_record_roots")
          .get(),
      ).toEqual({ count: 0 });
      afterRestart.close();
      restarted.close();
    });
  });

  test.each([
    "quarantine-write",
    "quarantine-rename",
    "quarantine-sync",
    "quarantine-verify",
  ] as const)("does not acknowledge a quarantine marker %s failure", async (failedPhase) => {
    await withDatabase(async (databasePath) => {
      let probeCalls = 0;
      const storage = openSqliteFoundationStorage(databasePath, {
        faultInjector(phase) {
          if (phase === "readiness-write-probe") {
            probeCalls += 1;
            throw new SqliteFoundationFault("corruption");
          }
          if (phase === failedPhase) throw new Error("Injected quarantine persistence failure.");
        },
      });
      await storage.applyMigrations();

      expect(await storage.readiness()).toMatchObject({
        ok: false,
        status: "quarantine-failure",
        detail: "SQLite corruption quarantine could not be durably persisted.",
        evidence: { sqlite: { failureCategory: "corruption" } },
      });
      expect(probeCalls).toBe(1);
      expect(await storage.readiness()).toMatchObject({
        ok: false,
        status: "quarantine-failure",
        evidence: { sqlite: { failureCategory: "corruption" } },
      });
      expect(probeCalls).toBe(1);

      const root = createRoot(`quarantine-${failedPhase}`);
      const record = createEventGameRecord(storage, {
        externalScopeResolver: createScopeResolver(root),
        interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      });
      expect(await record.registerRoot(root)).toMatchObject({
        status: "rejected",
        reason: "storage-not-ready",
      });
      const raw = new Database(databasePath);
      expect(
        raw.query("SELECT COUNT(*) AS count FROM foundation_event_game_record_roots").get(),
      ).toEqual({ count: 0 });
      raw.close();
      storage.close();
    });
  });

  test("reports persisted key requirements without a ring and distinguishes missing audit keys", async () => {
    await withDatabase(async (databasePath) => {
      const empty = openSqliteFoundationStorage(databasePath);
      await empty.applyMigrations();
      const emptyReadiness = await empty.readiness();
      expect(emptyReadiness).toMatchObject({
        ok: true,
        evidence: {
          keys: {
            requiredCount: 0,
            availableCount: 0,
            missingCount: 0,
            requiredCategories: { encryption: 0, lookup: 0, audit: 0 },
            missingCategories: { encryption: 0, lookup: 0, audit: 0 },
          },
        },
      });
      empty.close();

      const keyRing = createGrantTestKeyRing();
      const keyed = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      const authority = createLegacyControlGrantTestAuthority(
        keyed,
        createGrantOptions("event-game-key-evidence", keyRing),
      );
      const created = await authority.createControlGrant({
        scope: {
          eventId: "event-key-evidence",
          gameDayId: "day-key-evidence",
          pitchId: "pitch-key-evidence",
          pitchSlotId: "slot-key-evidence",
        },
        actor: { kind: "fixture", id: "key-evidence" },
      });
      expect(created.status).toBe("created");
      keyed.close();

      const noRing = openSqliteFoundationStorage(databasePath);
      const noRingReadiness = await noRing.readiness();
      expect(noRingReadiness).toMatchObject({ ok: false });
      const noRingKeys = noRingReadiness.evidence?.keys;
      expect(noRingKeys?.requiredCount).toBeGreaterThan(0);
      expect(noRingKeys?.availableCount).toBe(0);
      expect(noRingKeys?.missingCount).toBe(noRingKeys?.requiredCount);
      expect(noRingKeys?.requiredCategories.audit).toBeGreaterThan(0);
      expect(noRingKeys?.missingCategories.audit).toBe(noRingKeys?.requiredCategories.audit);
      noRing.close();

      const missingAuditRing = {
        ...keyRing,
        audit: { ...keyRing.audit, keys: new Map() },
      };
      const missingAudit = openSqliteFoundationStorage(databasePath, {
        grantKeyRing: missingAuditRing,
      });
      const missingAuditReadiness = await missingAudit.readiness();
      expect(missingAuditReadiness).toMatchObject({ ok: false });
      expect(missingAuditReadiness.evidence?.keys.missingCategories.audit).toBeGreaterThan(0);
      expect(missingAuditReadiness.evidence?.keys.availableCategories.encryption).toBeGreaterThan(
        0,
      );
      expect(missingAuditReadiness.evidence?.keys.availableCategories.lookup).toBeGreaterThan(0);
      missingAudit.close();

      const missingEncryptionRing = {
        ...keyRing,
        encryption: {
          currentVersion: "v2",
          keys: new Map([["v2", keyRing.encryption.keys.get(keyRing.encryption.currentVersion)!]]),
        },
      };
      const missingEncryption = openSqliteFoundationStorage(databasePath, {
        grantKeyRing: missingEncryptionRing,
      });
      const missingEncryptionReadiness = await missingEncryption.readiness();
      expect(missingEncryptionReadiness.ok).toBe(false);
      expect(missingEncryptionReadiness.evidence?.keys.missingCount).toBeGreaterThan(0);
      expect(
        missingEncryptionReadiness.evidence?.keys.missingCategories.encryption,
      ).toBeGreaterThan(0);
      missingEncryption.close();
    });
  });

  test("does not acknowledge Control Action or Grant revocation across a failed COMMIT", async () => {
    await withDatabase(async (databasePath) => {
      const keyRing = createGrantTestKeyRing();
      let injectCommitFailure = false;
      const storage = openSqliteFoundationStorage(databasePath, {
        grantKeyRing: keyRing,
        faultInjector(phase) {
          if (injectCommitFailure && phase === "before-commit")
            throw new SqliteFoundationFault("commit-failure");
        },
      });
      await storage.applyMigrations();
      const root = createRoot("sqlite-acceptance-rpo");
      const grantOptions = createGrantOptions(root.eventGameId, keyRing);
      const authority = createLegacyControlGrantTestAuthority(storage, grantOptions);
      const created = await authority.createControlGrant({
        scope: root.externalScope,
        actor: { kind: "fixture", id: "fixture" },
      });
      if (created.status !== "created") throw new Error("Expected a Control Grant.");
      const admitted = await authority.admitControlGrant({
        qrCredential: created.qrCredential,
        browserContext: "sqlite-controller",
      });
      if (admitted.status !== "admitted") throw new Error("Expected a Control Session.");
      const record = createEventGameRecord(storage, {
        externalScopeResolver: createScopeResolver(root),
        interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      });
      expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
      const acceptance = createFoundationAcceptance(storage, {
        grant: grantOptions,
        externalScopeResolver: createScopeResolver(root),
        interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      });
      const action = createAcceptanceFact(root, admitted.grantSessionId, created.grantVersion);

      injectCommitFailure = true;
      const failedAction = await acceptance.submitBatch({
        recordId: root.recordId,
        eventGameId: root.eventGameId,
        sessionBearer: admitted.sessionBearer,
        actions: [action],
      });
      expect(failedAction).toMatchObject({
        status: "partial",
        results: [{ status: "retry-later", reason: "storage-unavailable" }],
      });
      expect(await storage.readiness()).toMatchObject({ ok: false, status: "not-writeable" });
      injectCommitFailure = false;
      expect(await storage.readiness()).toMatchObject({
        ok: true,
        evidence: { sqlite: { failureCategory: null }, replay: { result: "passed" } },
      });
      expect(await record.readActions()).toHaveLength(0);

      const restarted = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      const restartedRecord = createEventGameRecord(restarted, {
        externalScopeResolver: createScopeResolver(root),
        interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      });
      expect(await restartedRecord.registerRoot(root)).toMatchObject({ status: "idempotent" });
      expect(await restartedRecord.readActions()).toHaveLength(0);
      const restartedAcceptance = createFoundationAcceptance(restarted, {
        grant: grantOptions,
        externalScopeResolver: createScopeResolver(root),
        interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      });
      expect(
        await restartedAcceptance.submitBatch({
          recordId: root.recordId,
          eventGameId: root.eventGameId,
          sessionBearer: admitted.sessionBearer,
          actions: [action],
        }),
      ).toMatchObject({ status: "committed", results: [{ status: "accepted" }] });

      restarted.close();
      injectCommitFailure = true;
      const failedRevocation = await authority.revokeControlGrant(created.grantId, {
        kind: "fixture",
        id: "fixture",
      });
      expect(failedRevocation).toMatchObject({ status: "rejected", reason: "unavailable" });
      expect(await storage.readiness()).toMatchObject({ ok: false, status: "not-writeable" });
      injectCommitFailure = false;
      expect(await storage.readiness()).toMatchObject({ ok: true });
      expect(
        await authority.revokeControlGrant(created.grantId, {
          kind: "fixture",
          id: "fixture",
        }),
      ).toMatchObject({ status: "updated" });
      const final = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      const finalRecord = createEventGameRecord(final, {
        externalScopeResolver: createScopeResolver(root),
        interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      });
      expect(await finalRecord.registerRoot(root)).toMatchObject({ status: "idempotent" });
      expect(await final.readiness()).toMatchObject({ ok: true });
      expect(
        await final.transaction((transaction) => transaction.findGrantById(created.grantId)),
      ).toMatchObject({
        status: "revoked",
      });
      final.close();
      storage.close();
    });
  });

  test.each([
    ["busy", "begin"],
    ["readonly", "readiness-write-probe"],
    ["full", "begin"],
    ["io-error", "begin"],
    ["commit-failure", "commit"],
  ] as const)("fails closed and recovers after a %s failure", async (category, phase) => {
    await withDatabase(async (databasePath) => {
      let injected = true;
      const storage = openSqliteFoundationStorage(databasePath, {
        faultInjector(actualPhase) {
          if (injected && actualPhase === phase) {
            throw new SqliteFoundationFault(category);
          }
        },
      });
      await storage.applyMigrations();
      expect(storage.liveness?.()).toEqual({ ok: true, process: "available" });
      if (phase === "readiness-write-probe")
        expect(await storage.readiness()).toMatchObject({ ok: false, status: "not-writeable" });
      const record = createEventGameRecord(storage, {
        externalScopeResolver: createScopeResolver(createRoot(`fault-${category}`)),
        interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      });
      const root = createRoot(`fault-${category}`);
      const failed = await record.registerRoot(root);
      expect(failed).toMatchObject({ status: "rejected", reason: "storage-not-ready" });

      const raw = new Database(databasePath);
      expect(
        raw.query("SELECT COUNT(*) AS count FROM foundation_event_game_record_roots").get(),
      ).toEqual({ count: 0 });
      raw.close();
      const evidence = await storage.readiness();
      expect(evidence).toMatchObject({ ok: false, status: "not-writeable" });
      expect(evidence.evidence?.sqlite.failureCategory).toBe(category);
      expect(evidence.evidence?.transaction.rejectionCategories[category]).toBeGreaterThan(0);
      const evidenceJson = JSON.stringify(evidence);
      expect(evidenceJson).not.toContain("Injected");
      expect(evidenceJson.length).toBeLessThan(4_096);
      expect(Object.keys(evidence.evidence?.transaction.rejectionCategories ?? {}).sort()).toEqual([
        "busy",
        "commit-failure",
        "corruption",
        "full",
        "io-error",
        "readonly",
      ]);
      injected = false;
      const recovered = await storage.readiness();
      expect(recovered).toMatchObject({ ok: true });
      expect(recovered.evidence?.sqlite.failureCategory).toBeNull();
      expect(recovered.evidence?.transaction.writePressure).toBe("normal");
      expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
      storage.close();
    });
  });

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

  test("rejects the first root without compatible replay context before any durable mutation", async () => {
    await withDatabase(async (databasePath) => {
      const storage = openSqliteFoundationStorage(databasePath);
      await storage.applyMigrations();
      const root = createRoot("first-root-context");
      const absent = createEventGameRecord(storage, {
        externalScopeResolver: createScopeResolver(root),
      });
      expect(await absent.registerRoot(root)).toMatchObject({
        status: "rejected",
        reason: "storage-not-ready",
      });

      const unknown = createEventGameRecord(storage, {
        externalScopeResolver: createScopeResolver(root),
        interpreter: createDeterministicTestIqaInterpreter("rules-unknown"),
      });
      expect(await unknown.registerRoot(root)).toMatchObject({
        status: "rejected",
        reason: "storage-not-ready",
      });
      const raw = new Database(databasePath);
      expect(
        raw.query("SELECT COUNT(*) AS count FROM foundation_event_game_record_roots").get(),
      ).toEqual({
        count: 0,
      });
      expect(
        raw.query("SELECT COUNT(*) AS count FROM foundation_event_game_record_idempotency").get(),
      ).toEqual({
        count: 0,
      });
      expect(
        raw.query("SELECT COUNT(*) AS count FROM foundation_event_game_record_audit").get(),
      ).toEqual({
        count: 0,
      });
      raw.close();
      expect(await storage.readiness()).toMatchObject({ ok: true });

      const valid = createEventGameRecord(storage, {
        externalScopeResolver: createScopeResolver(root),
        interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      });
      expect(await valid.registerRoot(root)).toMatchObject({ status: "registered" });
      storage.close();

      const restarted = openSqliteFoundationStorage(databasePath);
      expect(await restarted.readiness()).toMatchObject({
        ok: false,
        status: "integrity-failure",
        evidence: { replay: { result: "not-configured", rootCount: 1 } },
      });
      createEventGameRecord(restarted, {
        externalScopeResolver: createScopeResolver(root),
        interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      });
      expect(await restarted.readiness()).toMatchObject({
        ok: true,
        evidence: { replay: { result: "passed", rootCount: 1 } },
      });
      restarted.close();
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
        interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      });
      expect(await firstRecord.registerRoot(root)).toMatchObject({ status: "registered" });
      first.close();

      const reopened = openSqliteFoundationStorage(databasePath);
      const beforeContext = await reopened.readiness();
      expect(beforeContext).toMatchObject({
        ok: false,
        status: "integrity-failure",
        evidence: { replay: { result: "not-configured", rootCount: 1 } },
      });
      const reopenedRecord = createEventGameRecord(reopened, {
        externalScopeResolver: createScopeResolver(root),
        interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      });
      expect(await reopenedRecord.readRoot(recordId)).toMatchObject({
        recordId,
        eventGameId: "event-game-reopen",
      });
      expect(await reopenedRecord.registerRoot(root)).toMatchObject({ status: "idempotent" });
      expect(await reopened.readiness()).toMatchObject({
        ok: true,
        schemaVersion: "26",
        evidence: { replay: { result: "passed", rootCount: 1, durationMs: expect.any(Number) } },
      });
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
      expect(candidate.readiness).toMatchObject({ ok: true, schemaVersion: "26" });
      expect(existsSync(candidate.candidatePath)).toBe(false);
      expect(await storage.readiness()).toMatchObject({ ok: false, status: "pending" });

      const migration = await storage.applyMigrations({ requireCandidate: true });
      expect(migration.schemaVersion).toBe(26);
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
      const controlSessionStayMigration = FOUNDATION_MIGRATIONS[21];
      const eventTeamsMigration = FOUNDATION_MIGRATIONS[22];
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
        grantCodeLockMigration === undefined ||
        controlSessionStayMigration === undefined ||
        eventTeamsMigration === undefined
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
        controlSessionStayMigration.id,
        eventTeamsMigration.id,
        "024-event-schedule-slots-and-games",
        "025-event-publication-status",
        "026-event-schedule-expected-delays-and-conflicts",
      ]);
      expect(await current.readiness()).toMatchObject({ ok: true, schemaVersion: "26" });
      current.close();
    });
  });

  test("leaves the prior schema usable when a later migration fails", async () => {
    await withDatabase(async (databasePath) => {
      const baseMigrations = FOUNDATION_MIGRATIONS;
      const failingMigration = createMigration(
        "027-failing-test-migration",
        27,
        27,
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
        schemaVersion: "26",
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
        .run("future-999", 27, 27, "future-checksum", "complete", 2_000);
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
        interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
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

function createGrantOptions(
  eventGameId: string,
  keyRing: ReturnType<typeof createGrantTestKeyRing>,
): GrantAuthorityOptions {
  let call = 0;
  return {
    environmentId: "sqlite-acceptance-test",
    clock: { nowMs: () => 1_000 },
    randomness: {
      bytes(length) {
        call += 1;
        return Uint8Array.from({ length }, (_, index) => (index + call + length) % 256);
      },
    },
    keyRing,
    controlScopeResolver: { resolve: () => ({ status: "eligible", eventGameId }) },
    privilegedAuthorityVerifier: createGrantTestAuthorityVerifier(),
  };
}

function createAcceptanceFact(
  root: EventGameRecordRoot,
  sessionId: string,
  versionId: string,
): ControlActionInput {
  return {
    recordId: root.recordId,
    eventGameId: root.eventGameId,
    operationId: "sqlite-acceptance-operation",
    kind: { id: "game-fact", version: "1" },
    payload: {
      factId: "sqlite-acceptance-fact",
      factType: "test",
      gameSideId: root.gameSides[0]!.id,
      gameTimeMs: 1_000,
      data: { source: "sqlite-acceptance-test" },
    },
    causalPredecessorIds: [],
    occurrence: { trustedAtMs: 1_000, clientOriginAtMs: 1_000, source: "online" },
    grant: { sessionId, versionId },
    lifecycle: structuredClone(root.lifecycle),
  };
}
