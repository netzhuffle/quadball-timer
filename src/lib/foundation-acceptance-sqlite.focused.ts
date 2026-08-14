import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFoundationAcceptance,
  type FoundationAcceptanceOptions,
} from "@/lib/foundation-acceptance";
import { anchorFor } from "@/lib/foundation-acceptance-integrity";
import { computeGrantAuditIntegrityTag } from "@/lib/grant-crypto";
import {
  createDeterministicTestIqaInterpreter,
  sha256,
  type ControlActionInput,
} from "@/lib/event-game-actions";
import { createEventGameRecord } from "@/lib/event-game-record";
import {
  canonicalizeEventGameRecordRoot,
  type EventGameRecordRoot,
} from "@/lib/foundation-record-types";
import {
  openSqliteFoundationStorage,
  type SqliteFoundationStorage,
} from "@/lib/foundation-storage-sqlite";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import {
  createGrantTestAuthorityVerifier,
  createLegacyControlGrantTestAuthority,
} from "@/lib/grant-authority-test-support";
import type { GrantKeyRing } from "@/lib/grant-types";
import { readStoredGrantAuditEntry } from "@/lib/grant-storage-sqlite";

describe("focused SQLite composed acceptance", () => {
  test("commits paired evidence, survives restart, and acknowledges only a durable receipt", async () => {
    await withDatabase(async (databasePath) => {
      const storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: createKeyRing() });
      await storage.applyMigrations();
      const root = createRoot("sqlite-acceptance");
      const grantOptions = createGrantOptions(root.eventGameId);
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
      if (admitted.status !== "admitted")
        throw new Error(`Expected a Control Session: ${JSON.stringify(admitted)}`);
      const record = createEventGameRecord(storage, {
        externalScopeResolver: createScopeResolver(root),
        interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
        auditAuthorityVerifier: { verify: () => true },
      });
      expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
      const acceptance = createAcceptance(storage, root, grantOptions);
      const result = await acceptance.submitBatch({
        recordId: root.recordId,
        eventGameId: root.eventGameId,
        sessionBearer: admitted.sessionBearer,
        actions: [
          createFact(root, "sqlite-operation", admitted.grantSessionId, created.grantVersion),
        ],
      });
      expect(result).toMatchObject({ status: "committed" });
      expect(result.results[0]).toMatchObject({ status: "accepted" });
      expect(result.receipt).toBeUndefined();
      const beforeRestart = await storage.transaction((transaction) => ({
        actions: transaction.listActions(root.recordId),
        controls: transaction.listAuditEntries(root.recordId),
        grants: transaction.listGrantAudit(created.grantId),
      }));
      expect(beforeRestart.actions).toHaveLength(1);
      expect(beforeRestart.controls.filter((entry) => entry.links?.grantAuditId)).toHaveLength(1);
      expect(beforeRestart.grants.filter((entry) => entry.acceptanceId)).toHaveLength(1);
      storage.close();

      const reopened = openSqliteFoundationStorage(databasePath, { grantKeyRing: createKeyRing() });
      expect(await reopened.readiness()).toMatchObject({ ok: true, schemaVersion: "18" });
      expect(await reopened.readActions(root.recordId)).toHaveLength(1);
      expect(await reopened.readAuditEntries(root.recordId)).toHaveLength(1);
      reopened.close();
    });
  });

  test("freezes an online pair when Control and Grant fingerprints are coordinated wrongly", async () => {
    await withDatabase(async (databasePath) => {
      const keyRing = createKeyRing();
      const storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      await storage.applyMigrations();
      const root = createRoot("sqlite-online-fingerprint");
      const grantOptions = createGrantOptions(root.eventGameId);
      const authority = createLegacyControlGrantTestAuthority(storage, grantOptions);
      const created = await authority.createControlGrant({
        scope: root.externalScope,
        actor: { kind: "fixture", id: "fixture" },
      });
      if (created.status !== "created") throw new Error("Expected a Control Grant.");
      const admitted = await authority.admitControlGrant({
        qrCredential: created.qrCredential,
        browserContext: "sqlite-online-fingerprint-controller",
      });
      if (admitted.status !== "admitted") throw new Error("Expected a Control Session.");
      const record = createEventGameRecord(storage, {
        externalScopeResolver: createScopeResolver(root),
      });
      expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
      const action = createFact(
        root,
        "sqlite-online-fingerprint-operation",
        admitted.grantSessionId,
        created.grantVersion,
      );
      expect(
        await createAcceptance(storage, root, grantOptions).submitBatch({
          recordId: root.recordId,
          eventGameId: root.eventGameId,
          sessionBearer: admitted.sessionBearer,
          actions: [action],
        }),
      ).toMatchObject({ status: "committed" });
      storage.close();

      const raw = new Database(databasePath);
      const wrongFingerprint = "f".repeat(64);
      const controlRow = raw
        .query("SELECT audit_id, audit_json FROM foundation_event_game_record_audit LIMIT 1")
        .get() as { audit_id: string; audit_json: string };
      const control = JSON.parse(controlRow.audit_json) as {
        links: { contentFingerprint?: string };
      };
      control.links.contentFingerprint = wrongFingerprint;
      raw
        .query("UPDATE foundation_event_game_record_audit SET audit_json = ? WHERE audit_id = ?")
        .run(JSON.stringify(control), controlRow.audit_id);
      const grantRow = raw
        .query("SELECT * FROM foundation_grant_audit WHERE content_fingerprint IS NOT NULL LIMIT 1")
        .get() as Parameters<typeof readStoredGrantAuditEntry>[0];
      const grantAudit = readStoredGrantAuditEntry(grantRow);
      raw
        .query(
          "UPDATE foundation_grant_audit SET content_fingerprint = ?, audit_integrity_tag = ? WHERE audit_id = ?",
        )
        .run(
          wrongFingerprint,
          computeGrantAuditIntegrityTag(
            { ...grantAudit, contentFingerprint: wrongFingerprint },
            keyRing,
          ),
          grantAudit.auditId,
        );
      raw.close();

      const reopened = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      expect(await reopened.readiness()).toMatchObject({ ok: false, status: "integrity-failure" });
      reopened.close();
    });
  });

  test("uses independent SQLite writers for duplicate and conflict races", async () => {
    await withDatabase(async (databasePath) => {
      const bootstrap = openSqliteFoundationStorage(databasePath, {
        grantKeyRing: createKeyRing(),
      });
      await bootstrap.applyMigrations();
      const root = createRoot("sqlite-race");
      const grantOptions = createGrantOptions(root.eventGameId);
      const authority = createLegacyControlGrantTestAuthority(bootstrap, grantOptions);
      const created = await authority.createControlGrant({
        scope: root.externalScope,
        actor: { kind: "fixture", id: "fixture" },
      });
      if (created.status !== "created") throw new Error("Expected a Control Grant.");
      const admitted = await authority.admitControlGrant({
        qrCredential: created.qrCredential,
        browserContext: "sqlite-race-controller",
      });
      if (admitted.status !== "admitted")
        throw new Error(`Expected a Control Session: ${JSON.stringify(admitted)}`);
      const record = createEventGameRecord(bootstrap, {
        externalScopeResolver: createScopeResolver(root),
      });
      expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
      bootstrap.close();

      const left = openSqliteFoundationStorage(databasePath, { grantKeyRing: createKeyRing() });
      const right = openSqliteFoundationStorage(databasePath, { grantKeyRing: createKeyRing() });
      const leftAcceptance = createAcceptance(left, root, grantOptions);
      const rightAcceptance = createAcceptance(right, root, grantOptions);
      const duplicateAction = createFact(
        root,
        "duplicate-race",
        admitted.grantSessionId,
        created.grantVersion,
      );
      const duplicateResults = await Promise.all([
        leftAcceptance.submitBatch({
          recordId: root.recordId,
          eventGameId: root.eventGameId,
          sessionBearer: admitted.sessionBearer,
          actions: [duplicateAction],
        }),
        rightAcceptance.submitBatch({
          recordId: root.recordId,
          eventGameId: root.eventGameId,
          sessionBearer: admitted.sessionBearer,
          actions: [duplicateAction],
        }),
      ]);
      expect(
        duplicateResults
          .map((result) => result.results[0]?.status)
          .sort((left, right) => (left ?? "").localeCompare(right ?? "")),
      ).toEqual(["accepted", "duplicate-accepted"]);

      const conflictLeft = createFact(
        root,
        "conflict-race",
        admitted.grantSessionId,
        created.grantVersion,
      );
      const conflictRight = structuredClone(conflictLeft);
      conflictRight.payload = {
        factId: "fact-conflict-race",
        factType: "test",
        gameSideId: "side-a-sqlite-race",
        gameTimeMs: 1,
        data: { operationId: "different-content" },
      };
      const conflictResults = await Promise.all([
        leftAcceptance.submitBatch({
          recordId: root.recordId,
          eventGameId: root.eventGameId,
          sessionBearer: admitted.sessionBearer,
          actions: [conflictLeft],
        }),
        rightAcceptance.submitBatch({
          recordId: root.recordId,
          eventGameId: root.eventGameId,
          sessionBearer: admitted.sessionBearer,
          actions: [conflictRight],
        }),
      ]);
      expect(
        conflictResults
          .map((result) => result.results[0]?.status)
          .sort((left, right) => (left ?? "").localeCompare(right ?? "")),
      ).toEqual(["accepted", "rejected"]);
      expect(
        conflictResults.find((result) => result.results[0]?.status === "rejected")?.results[0],
      ).toMatchObject({
        reason: "operation-conflict",
      });
      left.close();
      right.close();

      const verify = openSqliteFoundationStorage(databasePath, { grantKeyRing: createKeyRing() });
      const verifyAcceptance = createAcceptance(verify, root, grantOptions);
      const thirdDuplicate = await verifyAcceptance.submitBatch({
        recordId: root.recordId,
        eventGameId: root.eventGameId,
        sessionBearer: admitted.sessionBearer,
        actions: [duplicateAction],
      });
      expect(thirdDuplicate.results[0]).toMatchObject({ status: "duplicate-accepted" });

      const restartConflictAccepted = createFact(
        root,
        "sqlite-restart-conflict",
        admitted.grantSessionId,
        created.grantVersion,
      );
      expect(
        await verifyAcceptance.submitBatch({
          recordId: root.recordId,
          eventGameId: root.eventGameId,
          sessionBearer: admitted.sessionBearer,
          actions: [restartConflictAccepted],
        }),
      ).toMatchObject({ results: [{ status: "accepted" }] });
      const restartConflictRejected = structuredClone(restartConflictAccepted);
      restartConflictRejected.payload = {
        factId: "fact-sqlite-restart-conflict-other",
        factType: "test",
        gameSideId: root.gameSides[0]?.id ?? "side-a",
        gameTimeMs: 1,
        data: { operationId: "sqlite-restart-conflict" },
      };
      const firstRestartRejection = await verifyAcceptance.submitBatch({
        recordId: root.recordId,
        eventGameId: root.eventGameId,
        sessionBearer: admitted.sessionBearer,
        actions: [restartConflictRejected],
      });
      expect(firstRestartRejection.results[0]).toMatchObject({
        status: "rejected",
        reason: "operation-conflict",
      });
      verify.close();

      const reopened = openSqliteFoundationStorage(databasePath, {
        grantKeyRing: createKeyRing(),
      });
      const reopenedAcceptance = createAcceptance(reopened, root, grantOptions);
      const repeatedRestartRejection = await reopenedAcceptance.submitBatch({
        recordId: root.recordId,
        eventGameId: root.eventGameId,
        sessionBearer: admitted.sessionBearer,
        actions: [restartConflictRejected],
      });
      expect(repeatedRestartRejection.results[0]).toEqual(firstRestartRejection.results[0]);
      expect(await reopened.readiness()).toMatchObject({ ok: true });
      reopened.close();

      const finalVerify = openSqliteFoundationStorage(databasePath, {
        grantKeyRing: createKeyRing(),
      });
      expect(await finalVerify.readiness()).toMatchObject({ ok: true });
      expect(await finalVerify.readActions(root.recordId)).toHaveLength(3);
      finalVerify.close();
    });
  });

  test("persists prepared budget retries and bounded replay-ineligible outcomes", async () => {
    await withDatabase(async (databasePath) => {
      const storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: createKeyRing() });
      await storage.applyMigrations();
      const root = createRoot("sqlite-correction-regressions");
      const grantOptions = createGrantOptions(root.eventGameId);
      const authority = createLegacyControlGrantTestAuthority(storage, grantOptions);
      const created = await authority.createControlGrant({
        scope: root.externalScope,
        actor: { kind: "fixture", id: "fixture" },
      });
      if (created.status !== "created") throw new Error("Expected a Control Grant.");
      const admitted = await authority.admitControlGrant({
        qrCredential: created.qrCredential,
        browserContext: "sqlite-correction-controller",
      });
      if (admitted.status !== "admitted") throw new Error("Expected a Control Session.");
      const record = createEventGameRecord(storage, {
        externalScopeResolver: createScopeResolver(root),
      });
      expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
      const nowMs = { value: 1_000 };
      const acceptance = createAcceptance(storage, root, grantOptions, false, undefined, {
        clock: () => nowMs.value,
        limits: { onlineSessionCapacity: 1, onlineEventCapacity: 1 },
      });
      const first = createFact(
        root,
        "sqlite-budget-first",
        admitted.grantSessionId,
        created.grantVersion,
      );
      const retry = createFact(
        root,
        "sqlite-budget-retry",
        admitted.grantSessionId,
        created.grantVersion,
      );
      expect(
        await acceptance.submitBatch({
          recordId: root.recordId,
          eventGameId: root.eventGameId,
          sessionBearer: admitted.sessionBearer,
          actions: [first],
        }),
      ).toMatchObject({ results: [{ status: "accepted" }] });

      const exhausted = await acceptance.submitBatch({
        recordId: root.recordId,
        eventGameId: root.eventGameId,
        sessionBearer: admitted.sessionBearer,
        actions: [retry],
      });
      expect(exhausted.results[0]).toMatchObject({ status: "retry-later", reason: "rate-budget" });
      const retryAudit = (await storage.readAuditEntries(root.recordId)).find(
        (entry) => entry.links?.reason === "rate-budget",
      );
      expect(retryAudit?.links?.rejectedCandidate?.codecIdentity).toEqual(expect.any(String));
      expect(retryAudit?.links?.rejectedCandidate?.codecIdentity).not.toBe("unprepared");
      storage.close();

      nowMs.value = 2_000;
      const reopened = openSqliteFoundationStorage(databasePath, { grantKeyRing: createKeyRing() });
      const resumed = await createAcceptance(reopened, root, grantOptions, false, undefined, {
        clock: () => nowMs.value,
        limits: { onlineSessionCapacity: 1, onlineEventCapacity: 1 },
      }).submitBatch({
        recordId: root.recordId,
        eventGameId: root.eventGameId,
        sessionBearer: admitted.sessionBearer,
        actions: [retry],
      });
      expect(resumed.results[0]).toMatchObject({ status: "accepted" });

      const unsupported = createFact(
        root,
        "sqlite-unsupported-replay",
        admitted.grantSessionId,
        created.grantVersion,
      );
      unsupported.kind = { id: "sqlite-unsupported-codec", version: "9" };
      const unsupportedFirst = await createAcceptance(reopened, root, grantOptions).submitBatch({
        mode: "replay",
        recordId: root.recordId,
        eventGameId: root.eventGameId,
        replay: {
          sessionBearer: admitted.sessionBearer,
          originatingSessionId: admitted.grantSessionId,
          replayEvidenceId: "sqlite-unsupported-replay",
        },
        actions: [unsupported],
      });
      expect(unsupportedFirst.results[0]).toMatchObject({
        status: "rejected",
        reason: "invalid-action",
      });
      reopened.close();

      const reopenedForReplay = openSqliteFoundationStorage(databasePath, {
        grantKeyRing: createKeyRing(),
      });
      const unsupportedSecond = await createAcceptance(
        reopenedForReplay,
        root,
        grantOptions,
      ).submitBatch({
        mode: "replay",
        recordId: root.recordId,
        eventGameId: root.eventGameId,
        replay: {
          sessionBearer: admitted.sessionBearer,
          originatingSessionId: admitted.grantSessionId,
          replayEvidenceId: "sqlite-unsupported-replay",
        },
        actions: [unsupported],
      });
      expect(unsupportedSecond.results[0]).toEqual(unsupportedFirst.results[0]);
      const replayFirst = await createAcceptance(
        reopenedForReplay,
        root,
        grantOptions,
        true,
        undefined,
        {
          replayDecision: "throw",
        },
      ).submitBatch({
        mode: "replay",
        recordId: root.recordId,
        eventGameId: root.eventGameId,
        replay: {
          sessionBearer: admitted.sessionBearer,
          originatingSessionId: admitted.grantSessionId,
          replayEvidenceId: "sqlite-generic-replay-ineligible",
        },
        actions: [
          createFact(
            root,
            "sqlite-generic-replay-ineligible",
            admitted.grantSessionId,
            created.grantVersion,
          ),
        ],
      });
      expect(replayFirst.results[0]).toMatchObject({
        status: "authority-expired",
        reason: "replay-ineligible",
        detail: "Replay authorization is unavailable.",
      });
      reopenedForReplay.close();

      const replayReopened = openSqliteFoundationStorage(databasePath, {
        grantKeyRing: createKeyRing(),
      });
      const replaySecond = await createAcceptance(
        replayReopened,
        root,
        grantOptions,
        true,
        undefined,
        { replayDecision: "throw" },
      ).submitBatch({
        mode: "replay",
        recordId: root.recordId,
        eventGameId: root.eventGameId,
        replay: {
          sessionBearer: admitted.sessionBearer,
          originatingSessionId: admitted.grantSessionId,
          replayEvidenceId: "sqlite-generic-replay-ineligible",
        },
        actions: [
          createFact(
            root,
            "sqlite-generic-replay-ineligible",
            admitted.grantSessionId,
            created.grantVersion,
          ),
        ],
      });
      expect(replaySecond.results[0]).toEqual(replayFirst.results[0]);
      expect(
        await replayReopened.transaction((transaction) =>
          transaction.findReplayReservationByOriginTuple(
            root.recordId,
            root.eventGameId,
            admitted.grantSessionId,
            1,
          ),
        ),
      ).toBeNull();
      expect(await replayReopened.readiness()).toMatchObject({ ok: true });
      replayReopened.close();
    });
  });

  test("persists replay attempts and a keyed receipt without storing the bearer", async () => {
    await withDatabase(async (databasePath) => {
      const storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: createKeyRing() });
      await storage.applyMigrations();
      const root = createRoot("sqlite-replay");
      const grantOptions = createGrantOptions(root.eventGameId);
      const authority = createLegacyControlGrantTestAuthority(storage, grantOptions);
      const created = await authority.createControlGrant({
        scope: root.externalScope,
        actor: { kind: "fixture", id: "fixture" },
      });
      if (created.status !== "created") throw new Error("Expected a Control Grant.");
      const admitted = await authority.admitControlGrant({
        qrCredential: created.qrCredential,
        browserContext: "sqlite-replay-controller",
      });
      if (admitted.status !== "admitted") throw new Error("Expected a Control Session.");
      const record = createEventGameRecord(storage, {
        externalScopeResolver: createScopeResolver(root),
      });
      expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
      const acceptance = createAcceptance(storage, root, grantOptions, true);
      const duplicateAction = createFact(
        root,
        "sqlite-replay-duplicate",
        admitted.grantSessionId,
        created.grantVersion,
      );
      expect(
        await createAcceptance(storage, root, grantOptions).submitBatch({
          recordId: root.recordId,
          eventGameId: root.eventGameId,
          sessionBearer: admitted.sessionBearer,
          actions: [duplicateAction],
        }),
      ).toMatchObject({ results: [{ status: "accepted" }] });
      const duplicateReplay = await acceptance.submitBatch({
        mode: "replay",
        recordId: root.recordId,
        eventGameId: root.eventGameId,
        replay: {
          sessionBearer: admitted.sessionBearer,
          originatingSessionId: "sqlite-duplicate-origin",
          replayEvidenceId: "sqlite-duplicate-replay",
        },
        actions: [duplicateAction],
      });
      const duplicateReservationId = duplicateReplay.reservationId;
      const duplicateReceipt = duplicateReplay.receipt;
      expect(duplicateReplay.results[0]).toMatchObject({
        status: "duplicate-accepted",
      });
      expect(duplicateReplay).toMatchObject({
        status: "committed",
        receipt: expect.any(String),
        reservationId: expect.any(String),
      });
      const rejectionAction = {
        ...createFact(
          root,
          "sqlite-replay-rejected",
          admitted.grantSessionId,
          created.grantVersion,
        ),
        causalPredecessorIds: ["missing-replay-predecessor"],
      };
      const rejectionReplay = await acceptance.submitBatch({
        mode: "replay",
        recordId: root.recordId,
        eventGameId: root.eventGameId,
        replay: {
          sessionBearer: admitted.sessionBearer,
          originatingSessionId: "sqlite-rejection-origin",
          replayEvidenceId: "sqlite-rejection-replay",
        },
        actions: [rejectionAction],
      });
      const rejectionReservationId = rejectionReplay.reservationId;
      const rejectionReceipt = rejectionReplay.receipt;
      expect(rejectionReplay.results[0]).toMatchObject({
        status: "rejected",
        reason: "missing-dependency",
      });
      expect(rejectionReplay).toMatchObject({
        status: "committed",
        receipt: expect.any(String),
        reservationId: expect.any(String),
      });
      const replay = await acceptance.submitBatch({
        mode: "replay",
        recordId: root.recordId,
        eventGameId: root.eventGameId,
        replay: {
          sessionBearer: admitted.sessionBearer,
          originatingSessionId: admitted.grantSessionId,
          replayEvidenceId: "sqlite-replay-evidence",
        },
        actions: [
          createFact(
            root,
            "sqlite-replay-operation",
            admitted.grantSessionId,
            created.grantVersion,
          ),
        ],
      });
      const replayReceipt = replay.receipt;
      expect(replay.status).toBe("committed");
      expect(replayReceipt).toEqual(expect.any(String));
      storage.close();

      const raw = new Database(databasePath);
      const receiptRows = raw
        .query("SELECT receipt_digest FROM foundation_replay_receipts")
        .all() as Array<{ receipt_digest: string }>;
      expect(receiptRows).toHaveLength(3);
      expect(receiptRows[0]?.receipt_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(receiptRows[0]?.receipt_digest).not.toBe(replayReceipt);
      raw.close();

      const rotatedGrantOptions = { ...grantOptions, keyRing: rotateKeyRing() };
      const reopened = openSqliteFoundationStorage(databasePath, {
        grantKeyRing: rotatedGrantOptions.keyRing,
      });
      const reopenedAcceptance = createAcceptance(reopened, root, rotatedGrantOptions, true);
      const duplicateRetry = await reopenedAcceptance.submitBatch({
        mode: "replay",
        recordId: root.recordId,
        eventGameId: root.eventGameId,
        replay: {
          sessionBearer: admitted.sessionBearer,
          originatingSessionId: "sqlite-duplicate-origin",
          replayEvidenceId: "sqlite-duplicate-replay",
        },
        actions: [duplicateAction],
      });
      expect(duplicateRetry.results[0]).toEqual(duplicateReplay.results[0]);
      expect(duplicateRetry.reservationId).toBe(duplicateReservationId);
      expect(duplicateRetry.receipt).toBe(duplicateReceipt);
      const rejectionRetry = await reopenedAcceptance.submitBatch({
        mode: "replay",
        recordId: root.recordId,
        eventGameId: root.eventGameId,
        replay: {
          sessionBearer: admitted.sessionBearer,
          originatingSessionId: "sqlite-rejection-origin",
          replayEvidenceId: "sqlite-rejection-replay",
        },
        actions: [rejectionAction],
      });
      expect(rejectionRetry.results[0]).toEqual(rejectionReplay.results[0]);
      expect(rejectionRetry.reservationId).toBe(rejectionReservationId);
      expect(rejectionRetry.receipt).toBe(rejectionReceipt);
      const retried = await reopenedAcceptance.submitBatch({
        mode: "replay",
        recordId: root.recordId,
        eventGameId: root.eventGameId,
        replay: {
          sessionBearer: admitted.sessionBearer,
          originatingSessionId: admitted.grantSessionId,
          replayEvidenceId: "sqlite-replay-evidence",
        },
        actions: [
          createFact(
            root,
            "sqlite-replay-operation",
            admitted.grantSessionId,
            created.grantVersion,
          ),
        ],
      });
      expect(retried).toMatchObject({ status: "committed", receipt: replayReceipt });
      const rotatedAuthority = createLegacyControlGrantTestAuthority(reopened, rotatedGrantOptions);
      expect(
        await rotatedAuthority.revokeControlGrant(created.grantId, {
          kind: "fixture",
          id: "fixture",
        }),
      ).toMatchObject({ status: "updated" });
      expect(await reopenedAcceptance.acknowledgeReplay(replayReceipt!)).toEqual({
        status: "acknowledged",
      });
      expect(await reopenedAcceptance.acknowledgeReplay(duplicateReceipt!)).toEqual({
        status: "acknowledged",
      });
      expect(await reopenedAcceptance.acknowledgeReplay(rejectionReceipt!)).toEqual({
        status: "acknowledged",
      });
      expect(await reopened.readiness()).toMatchObject({ ok: true, schemaVersion: "18" });
      reopened.close();
    });
  });

  test("resumes a partial replay after SQLite restart without a premature receipt", async () => {
    await withDatabase(async (databasePath) => {
      const storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: createKeyRing() });
      await storage.applyMigrations();
      const root = createRoot("sqlite-partial-replay");
      const grantOptions = createGrantOptions(root.eventGameId);
      const authority = createLegacyControlGrantTestAuthority(storage, grantOptions);
      const created = await authority.createControlGrant({
        scope: root.externalScope,
        actor: { kind: "fixture", id: "fixture" },
      });
      if (created.status !== "created") throw new Error("Expected a Control Grant.");
      const admitted = await authority.admitControlGrant({
        qrCredential: created.qrCredential,
        browserContext: "sqlite-partial-replay-controller",
      });
      if (admitted.status !== "admitted") throw new Error("Expected a Control Session.");
      const record = createEventGameRecord(storage, {
        externalScopeResolver: createScopeResolver(root),
      });
      expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
      const nowMs = { value: 1_000 };
      const limits = { replaySessionCapacity: 1 };
      const first = createFact(
        root,
        "sqlite-partial-first",
        admitted.grantSessionId,
        created.grantVersion,
      );
      const second = {
        ...createFact(root, "sqlite-partial-second", admitted.grantSessionId, created.grantVersion),
        causalPredecessorIds: [first.operationId],
      };
      const input = {
        mode: "replay" as const,
        recordId: root.recordId,
        eventGameId: root.eventGameId,
        replay: {
          sessionBearer: admitted.sessionBearer,
          originatingSessionId: "sqlite-partial-origin",
          replayEvidenceId: "sqlite-partial-replay",
        },
        actions: [second, first],
      };
      const partial = await createAcceptance(storage, root, grantOptions, true, undefined, {
        clock: () => nowMs.value,
        limits,
      }).submitBatch(input);
      expect(partial.results.map((result) => result.status)).toEqual(["retry-later", "accepted"]);
      expect(partial.receipt).toBeUndefined();
      const partialReservationId = partial.reservationId;
      expect(partialReservationId).toEqual(expect.any(String));
      storage.close();

      nowMs.value = 2_000;
      const reopened = openSqliteFoundationStorage(databasePath, {
        grantKeyRing: createKeyRing(),
      });
      const resumed = await createAcceptance(reopened, root, grantOptions, true, undefined, {
        clock: () => nowMs.value,
        limits,
      }).submitBatch(input);
      expect(resumed.results[1]).toEqual(partial.results[1]);
      expect(resumed.results[0]).toMatchObject({ status: "accepted" });
      expect(resumed.reservationId).toBe(partialReservationId);
      const resumedReceipt = resumed.receipt;
      expect(resumedReceipt).toEqual(expect.any(String));
      expect(await reopened.readAuditEntries(root.recordId)).toHaveLength(3);
      expect(
        await createAcceptance(reopened, root, grantOptions, true).acknowledgeReplay(
          resumedReceipt!,
        ),
      ).toEqual({
        status: "acknowledged",
      });
      expect(await reopened.readiness()).toMatchObject({ ok: true });
      reopened.close();
    });
  });

  test("persists definitive mixed replay outcomes under one SQLite reservation", async () => {
    for (const unsupported of [true, false]) {
      await withDatabase(async (databasePath) => {
        const storage = openSqliteFoundationStorage(databasePath, {
          grantKeyRing: createKeyRing(),
        });
        await storage.applyMigrations();
        const root = createRoot(
          unsupported ? "sqlite-mixed-unsupported" : "sqlite-mixed-ineligible",
        );
        const grantOptions = createGrantOptions(root.eventGameId);
        const authority = createLegacyControlGrantTestAuthority(storage, grantOptions);
        const created = await authority.createControlGrant({
          scope: root.externalScope,
          actor: { kind: "fixture", id: "fixture" },
        });
        if (created.status !== "created") throw new Error("Expected a Control Grant.");
        const admitted = await authority.admitControlGrant({
          qrCredential: created.qrCredential,
          browserContext: "sqlite-mixed-replay-controller",
        });
        if (admitted.status !== "admitted") throw new Error("Expected a Control Session.");
        const record = createEventGameRecord(storage, {
          externalScopeResolver: createScopeResolver(root),
        });
        expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
        const first = createFact(
          root,
          unsupported ? "sqlite-mixed-valid-codec" : "sqlite-mixed-valid-eligibility",
          admitted.grantSessionId,
          created.grantVersion,
        );
        const second = createFact(
          root,
          unsupported ? "sqlite-mixed-unsupported" : "sqlite-mixed-ineligible",
          admitted.grantSessionId,
          created.grantVersion,
        );
        if (unsupported) second.kind = { id: "sqlite-mixed-unsupported-codec", version: "1" };
        const makeAcceptance = (target: SqliteFoundationStorage) =>
          createFoundationAcceptance(target, {
            grant: grantOptions,
            externalScopeResolver: createScopeResolver(root),
            clock: () => 1_000,
            interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
            replayEligibility: ({ action }) => {
              if (!unsupported && action.input.operationId === second.operationId)
                throw new Error("adapter callback failure");
              return { status: "eligible" as const };
            },
          });
        const input = {
          mode: "replay" as const,
          recordId: root.recordId,
          eventGameId: root.eventGameId,
          replay: {
            sessionBearer: admitted.sessionBearer,
            originatingSessionId: unsupported
              ? "sqlite-mixed-unsupported-origin"
              : "sqlite-mixed-ineligible-origin",
            replayEvidenceId: "sqlite-mixed-replay",
          },
          actions: [first, second],
        };
        const firstDelivery = await makeAcceptance(storage).submitBatch(input);
        const reservationId = firstDelivery.reservationId;
        const receipt = firstDelivery.receipt;
        expect(firstDelivery.results[0]).toMatchObject({ status: "accepted" });
        expect(firstDelivery.results[1]).toMatchObject(
          unsupported
            ? { status: "rejected", reason: "invalid-action" }
            : { status: "authority-expired", reason: "replay-ineligible" },
        );
        expect(reservationId).toEqual(expect.any(String));
        expect(receipt).toEqual(expect.any(String));
        const attempts = await storage.transaction((transaction) =>
          transaction.listReplayAttempts(reservationId!),
        );
        expect(attempts).toHaveLength(2);
        expect(attempts.every((attempt) => attempt.status !== "retry-later")).toBe(true);
        expect(await storage.readAuditEntries(root.recordId)).toHaveLength(2);
        storage.close();

        const reopened = openSqliteFoundationStorage(databasePath, {
          grantKeyRing: createKeyRing(),
        });
        const restarted = await makeAcceptance(reopened).submitBatch(input);
        expect(restarted.results).toEqual(firstDelivery.results);
        expect(restarted.reservationId).toBe(reservationId);
        expect(restarted.receipt).toBe(receipt);
        expect(await makeAcceptance(reopened).acknowledgeReplay(receipt!)).toEqual({
          status: "acknowledged",
        });
        expect(await reopened.readAuditEntries(root.recordId)).toHaveLength(2);
        expect(await reopened.readiness()).toMatchObject({ ok: true });
        reopened.close();
      });
    }
  });

  test("recovers an exact committed replay after Game Lock and key rotation", async () => {
    await withDatabase(async (databasePath) => {
      const storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: createKeyRing() });
      await storage.applyMigrations();
      const root = createRoot("sqlite-lock-recovery");
      const grantOptions = createGrantOptions(root.eventGameId);
      const authority = createLegacyControlGrantTestAuthority(storage, grantOptions);
      const created = await authority.createControlGrant({
        scope: root.externalScope,
        actor: { kind: "fixture", id: "fixture" },
      });
      if (created.status !== "created") throw new Error("Expected a Control Grant.");
      const admitted = await authority.admitControlGrant({
        qrCredential: created.qrCredential,
        browserContext: "sqlite-lock-recovery-controller",
      });
      if (admitted.status !== "admitted") throw new Error("Expected a Control Session.");
      const record = createEventGameRecord(storage, {
        externalScopeResolver: createScopeResolver(root),
      });
      expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
      const action = createFact(
        root,
        "sqlite-lock-recovery-operation",
        admitted.grantSessionId,
        created.grantVersion,
      );
      const evidence = "sqlite-lock-recovery-evidence";
      const digest = sha256(
        JSON.stringify({
          recordId: root.recordId,
          eventGameId: root.eventGameId,
          mode: "replay",
          replay: { originatingSessionId: admitted.grantSessionId, replayEvidenceId: evidence },
          actions: [action],
        }),
      );
      const acceptance = createAcceptance(storage, root, grantOptions, true);
      const committed = await acceptance.submitBatch({
        mode: "replay",
        recordId: root.recordId,
        eventGameId: root.eventGameId,
        replay: {
          sessionBearer: admitted.sessionBearer,
          originatingSessionId: admitted.grantSessionId,
          replayEvidenceId: evidence,
        },
        actions: [action],
      });
      const receipt = committed.receipt;
      expect(committed).toMatchObject({ status: "committed", receipt: expect.any(String) });
      storage.close();

      const locked = {
        ...root,
        lifecycle: {
          phase: "finished" as const,
          commencedAtMs: 100,
          finishedAtMs: 800,
          lockedAtMs: 900,
          lockReason: "administrative" as const,
        },
      };
      const raw = new Database(databasePath);
      raw
        .query(
          `UPDATE foundation_event_game_record_roots
           SET lifecycle_phase = ?, commenced_at_ms = ?, finished_at_ms = ?, locked_at_ms = ?,
               lock_reason = ?, canonical_content = ?, root_json = ? WHERE record_id = ?`,
        )
        .run(
          locked.lifecycle.phase,
          locked.lifecycle.commencedAtMs,
          locked.lifecycle.finishedAtMs,
          locked.lifecycle.lockedAtMs,
          locked.lifecycle.lockReason,
          canonicalizeEventGameRecordRoot(locked),
          JSON.stringify(locked),
          root.recordId,
        );
      raw.close();

      const rotatedGrantOptions = { ...grantOptions, keyRing: rotateKeyRing() };
      const reopened = openSqliteFoundationStorage(databasePath, {
        grantKeyRing: rotatedGrantOptions.keyRing,
      });
      const lockedAcceptance = createAcceptance(reopened, root, rotatedGrantOptions, true, digest);
      const recovered = await lockedAcceptance.submitBatch({
        mode: "replay",
        recordId: root.recordId,
        eventGameId: root.eventGameId,
        replay: {
          sessionBearer: "lost-response-bearer",
          originatingSessionId: admitted.grantSessionId,
          replayEvidenceId: evidence,
        },
        actions: [action],
      });
      expect(recovered).toMatchObject({ status: "committed", receipt });
      expect(await lockedAcceptance.acknowledgeReplay(receipt!)).toEqual({
        status: "acknowledged",
      });
      reopened.close();
    });
  });

  test("revalidates authority and root state across a synchronized independent-writer barrier", async () => {
    await withRaceCase(
      "revocation",
      async ({ right, created }) => {
        await right.authority.revokeControlGrant(created.grantId, {
          kind: "fixture",
          id: "fixture",
        });
      },
      (result) => {
        expect(result.results[0]).toMatchObject({
          status: "authority-expired",
          reason: "grant-session",
        });
      },
    );
    await withRaceCase(
      "grant-rotation",
      async ({ right, created }) => {
        await right.authority.rotateControlGrant(created.grantId, {
          kind: "fixture",
          id: "fixture",
        });
      },
      (result) => {
        expect(result.results[0]).toMatchObject({
          status: "authority-expired",
          reason: "grant-session",
          detail: "The Grant Session is no longer current.",
        });
      },
      undefined,
      0,
      0,
    );
    await withRaceCase(
      "lifecycle-drift",
      async (context) => {
        context.setNow(1_500);
        context.changeRootLifecycle();
      },
      (result) => {
        expect(result.results[0]).toMatchObject({
          status: "retry-later",
          reason: "stale-preflight",
        });
      },
      undefined,
      0,
      0,
      true,
    );
    await withRaceCase(
      "key-rotation",
      async (context) => {
        const rotatedKeyRing = rotateKeyRing();
        const rotatedOptions = { ...context.grantOptions, keyRing: rotatedKeyRing };
        const rotatedAuthority = createLegacyControlGrantTestAuthority(
          context.right.storage,
          rotatedOptions,
        );
        await rotatedAuthority.rotateControlGrantCredentialKeys(context.created.grantId, {
          kind: "fixture",
          id: "fixture",
        });
        context.grantOptions.keyRing = rotatedKeyRing;
        context.left.setGrantKeyRing?.(rotatedKeyRing);
      },
      (result) => {
        expect(result.results[0]).toMatchObject({ status: "accepted" });
      },
      undefined,
      1,
      1,
    );
    await withRaceCase(
      "expiry",
      async (context) => {
        context.setNow(2_000);
      },
      (result) => {
        expect(result.results[0]).toMatchObject({
          status: "authority-expired",
          reason: "grant-session",
        });
      },
      1_500,
    );
    await withRaceCase(
      "scope-change",
      async (context) => {
        context.setScopeAvailable(false);
      },
      (result) => {
        expect(result.results[0]).toMatchObject({
          status: "retry-later",
          reason: "scope-unavailable",
        });
      },
    );
    await withRaceCase(
      "game-lock",
      async (context) => {
        context.lockRoot();
      },
      (result) => {
        expect(result.results[0]).toMatchObject({
          status: "authority-expired",
          reason: "game-locked",
        });
      },
    );
  });

  test("freezes SQLite writes for mutated, gapped, and extra integrity history", async () => {
    for (const corruption of ["mutated", "gapped", "extra"] as const) {
      await withDatabase(async (databasePath) => {
        const keyRing = createKeyRing();
        const storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
        await storage.applyMigrations();
        const first = createBudget("history-budget", 1);
        const second = createBudget("history-budget", 2);
        await storage.transaction((transaction) => {
          transaction.upsertAcceptanceBudget(first);
          transaction.insertAcceptanceIntegrityAnchor(anchorFor("budget", first, keyRing));
          transaction.upsertAcceptanceBudget(second);
          transaction.insertAcceptanceIntegrityAnchor(anchorFor("budget", second, keyRing));
        });
        const database = new Database(databasePath);
        database.exec("DROP TRIGGER foundation_acceptance_integrity_anchors_no_update;");
        database.exec("DROP TRIGGER foundation_acceptance_integrity_anchors_no_delete;");
        if (corruption === "mutated") {
          database
            .query(
              "UPDATE foundation_acceptance_integrity_anchors SET integrity_tag = ? WHERE subject_kind = 'budget' AND subject_id = ? AND state_revision = 1",
            )
            .run("hmac-sha256-v1:audit-v1:tampered", first.bucketId);
        } else if (corruption === "gapped") {
          database
            .query(
              "DELETE FROM foundation_acceptance_integrity_anchors WHERE subject_kind = 'budget' AND subject_id = ? AND state_revision = 1",
            )
            .run(first.bucketId);
        } else {
          const extra = createBudget("history-budget", 3);
          const anchor = anchorFor("budget", extra, keyRing);
          database
            .query(
              `INSERT INTO foundation_acceptance_integrity_anchors
               (anchor_id, subject_kind, subject_id, state_revision, key_version, integrity_tag, canonical_value)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              anchor.anchorId,
              anchor.subjectKind,
              anchor.subjectId,
              anchor.stateRevision,
              anchor.keyVersion,
              anchor.integrityTag,
              anchor.canonicalValue,
            );
        }
        database.close();
        expect(await storage.readiness()).toMatchObject({ ok: false, status: "integrity-failure" });
        await storage
          .transaction(() => "must-not-write")
          .then(
            () => {
              throw new Error("Expected a frozen storage transaction to reject.");
            },
            (error: unknown) => {
              expect(String(error)).toContain("not ready");
            },
          );
        storage.close();
      });
    }
  });
});

type RaceContext = {
  left: SqliteFoundationStorage;
  right: {
    storage: SqliteFoundationStorage;
    authority: ReturnType<typeof createLegacyControlGrantTestAuthority>;
    close(): void;
  };
  root: EventGameRecordRoot;
  created: { grantId: string; grantVersion: string };
  admitted: { grantSessionId: string; sessionBearer: string };
  grantOptions: GrantAuthorityOptions;
  setNow(nowMs: number): void;
  setScopeAvailable(available: boolean): void;
  changeRootLifecycle(): void;
  lockRoot(): void;
};

async function withRaceCase(
  suffix: string,
  mutate: (context: RaceContext) => Promise<void>,
  assertResult: (
    result: Awaited<ReturnType<ReturnType<typeof createAcceptance>["submitBatch"]>>,
  ) => void,
  expiresAtMs?: number,
  expectedAuditCount = 0,
  expectedActionCount = 0,
  assertAcceptanceStateUnchanged = false,
): Promise<void> {
  await withDatabase(async (databasePath) => {
    let nowMs = 1_000;
    let scopeAvailable = true;
    const bootstrap = openSqliteFoundationStorage(databasePath, { grantKeyRing: createKeyRing() });
    await bootstrap.applyMigrations();
    const root = createRoot(`race-${suffix}`);
    const grantOptions = { ...createGrantOptions(root.eventGameId), clock: { nowMs: () => nowMs } };
    const authority = createLegacyControlGrantTestAuthority(bootstrap, grantOptions);
    const created = await authority.createControlGrant({
      scope: root.externalScope,
      actor: { kind: "fixture", id: "fixture" },
      expiresAtMs,
    });
    if (created.status !== "created") throw new Error("Expected a Control Grant.");
    const admitted = await authority.admitControlGrant({
      qrCredential: created.qrCredential,
      browserContext: `race-${suffix}-controller`,
    });
    if (admitted.status !== "admitted") throw new Error("Expected a Control Session.");
    const record = createEventGameRecord(bootstrap, {
      externalScopeResolver: createScopeResolver(root),
      interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
    });
    expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
    bootstrap.close();

    const left = openSqliteFoundationStorage(databasePath, { grantKeyRing: createKeyRing() });
    const rightStorage = openSqliteFoundationStorage(databasePath, {
      grantKeyRing: createKeyRing(),
    });
    const rightAuthority = createLegacyControlGrantTestAuthority(rightStorage, grantOptions);
    const scopeResolver = {
      resolve(scope: EventGameRecordRoot["externalScope"]) {
        return scopeAvailable
          ? { status: "resolved" as const, scope: structuredClone(scope) }
          : { status: "mismatch" as const, detail: "scope changed" };
      },
      resolveEventTeam() {
        return { status: "resolved" as const };
      },
    };
    const context = {
      left,
      right: {
        storage: rightStorage,
        authority: rightAuthority,
        close: () => rightStorage.close(),
      },
      root,
      created,
      admitted,
      grantOptions,
      setNow(value: number) {
        nowMs = value;
      },
      setScopeAvailable(value: boolean) {
        scopeAvailable = value;
      },
      lockRoot() {
        const database = new Database(databasePath);
        const locked = {
          ...root,
          lifecycle: {
            phase: "finished" as const,
            commencedAtMs: 100,
            finishedAtMs: 800,
            lockedAtMs: 900,
            lockReason: "administrative" as const,
          },
        };
        database
          .query(
            `UPDATE foundation_event_game_record_roots
             SET lifecycle_phase = ?, commenced_at_ms = ?, finished_at_ms = ?, locked_at_ms = ?,
                 lock_reason = ?, canonical_content = ?, root_json = ? WHERE record_id = ?`,
          )
          .run(
            locked.lifecycle.phase,
            locked.lifecycle.commencedAtMs,
            locked.lifecycle.finishedAtMs,
            locked.lifecycle.lockedAtMs,
            locked.lifecycle.lockReason,
            canonicalizeEventGameRecordRoot(locked),
            JSON.stringify(locked),
            root.recordId,
          );
        database.close();
      },
      changeRootLifecycle() {
        const database = new Database(databasePath);
        const changed = {
          ...root,
          lifecycle: {
            phase: "in-progress" as const,
            commencedAtMs: 1_200,
            finishedAtMs: null,
            lockedAtMs: null,
            lockReason: null,
          },
        };
        database
          .query(
            `UPDATE foundation_event_game_record_roots
             SET lifecycle_phase = ?, commenced_at_ms = ?, finished_at_ms = ?, locked_at_ms = ?,
                 lock_reason = ?, canonical_content = ?, root_json = ? WHERE record_id = ?`,
          )
          .run(
            changed.lifecycle.phase,
            changed.lifecycle.commencedAtMs,
            changed.lifecycle.finishedAtMs,
            changed.lifecycle.lockedAtMs,
            changed.lifecycle.lockReason,
            canonicalizeEventGameRecordRoot(changed),
            JSON.stringify(changed),
            root.recordId,
          );
        database.close();
      },
    } satisfies RaceContext;
    const acceptanceStateBefore = assertAcceptanceStateUnchanged
      ? await left.transaction((transaction) => ({
          actions: transaction.listActions(root.recordId),
          audits: transaction.listAuditEntries(root.recordId),
          metadata: transaction.readRecordMetadata(root.recordId),
          session: transaction.listGrantSessions(created.grantId),
          budgets: [
            transaction.findAcceptanceBudget(`budget-online-session:${admitted.grantSessionId}`),
            transaction.findAcceptanceBudget(`budget-online-event:${root.eventGameId}`),
          ],
        }))
      : null;
    const acceptance = createFoundationAcceptance(left, {
      grant: grantOptions,
      externalScopeResolver: scopeResolver,
      clock: () => nowMs,
      interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      afterReadOnlyPreflight: () => mutate(context),
    });
    const result = await acceptance.submitBatch({
      recordId: root.recordId,
      eventGameId: root.eventGameId,
      sessionBearer: admitted.sessionBearer,
      actions: [
        createFact(root, `operation-${suffix}`, admitted.grantSessionId, created.grantVersion),
      ],
    });
    assertResult(result);
    expect(await left.readAuditEntries(root.recordId)).toHaveLength(expectedAuditCount);
    expect(await left.readActions(root.recordId)).toHaveLength(expectedActionCount);
    if (acceptanceStateBefore !== null) {
      await left.transaction((transaction) => {
        expect({
          actions: transaction.listActions(root.recordId),
          audits: transaction.listAuditEntries(root.recordId),
          metadata: transaction.readRecordMetadata(root.recordId),
          session: transaction.listGrantSessions(created.grantId),
          budgets: [
            transaction.findAcceptanceBudget(`budget-online-session:${admitted.grantSessionId}`),
            transaction.findAcceptanceBudget(`budget-online-event:${root.eventGameId}`),
          ],
        }).toEqual(acceptanceStateBefore);
      });
    }
    left.close();
    rightStorage.close();
  });
}

function createAcceptance(
  storage: SqliteFoundationStorage,
  root: EventGameRecordRoot,
  grant: GrantAuthorityOptions,
  replay = false,
  lockedDigest?: string,
  correctionOptions: {
    clock?: () => number;
    limits?: FoundationAcceptanceOptions["limits"];
    replayDecision?: "throw" | { reason: unknown; detail: unknown };
  } = {},
) {
  const replayDecision = correctionOptions.replayDecision;
  const replayEligibility = !replay
    ? undefined
    : replayDecision === "throw"
      ? () => {
          throw new Error("adapter detail must not escape");
        }
      : replayDecision === undefined
        ? () => ({ status: "eligible" as const })
        : () => ({
            status: "ineligible" as const,
            reason: replayDecision.reason,
            detail: replayDecision.detail,
          });
  return createFoundationAcceptance(storage, {
    grant,
    externalScopeResolver: createScopeResolver(root),
    clock: correctionOptions.clock ?? (() => 1_000),
    interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
    limits: correctionOptions.limits,
    replayEligibility,
    verifyLockedReplay:
      lockedDigest === undefined ? undefined : ({ batchDigest }) => batchDigest === lockedDigest,
  });
}

async function withDatabase(work: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "quadball-timer-acceptance-sqlite-"));
  try {
    await work(join(directory, "foundation.sqlite"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function createGrantOptions(eventGameId: string): GrantAuthorityOptions {
  let call = 0;
  return {
    environmentId: "acceptance-sqlite-test",
    clock: { nowMs: () => 1_000 },
    randomness: {
      bytes: (length) => {
        call += 1;
        return Uint8Array.from({ length }, (_, index) => (index + call + length) % 256);
      },
    },
    keyRing: createKeyRing(),
    controlScopeResolver: { resolve: () => ({ status: "eligible", eventGameId }) },
    privilegedAuthorityVerifier: createGrantTestAuthorityVerifier(),
  };
}

function createKeyRing(): GrantKeyRing {
  return {
    encryption: { currentVersion: "encryption-v1", keys: new Map([["encryption-v1", bytes(1)]]) },
    lookup: { currentVersion: "lookup-v1", keys: new Map([["lookup-v1", bytes(33)]]) },
    audit: { currentVersion: "audit-v1", keys: new Map([["audit-v1", bytes(65)]]) },
  };
}

function rotateKeyRing(): GrantKeyRing {
  const current = createKeyRing();
  return {
    encryption: current.encryption,
    lookup: {
      currentVersion: "lookup-v2",
      keys: new Map([...current.lookup.keys, ["lookup-v2", bytes(97)]]),
    },
    audit: {
      currentVersion: "audit-v2",
      keys: new Map([...current.audit.keys, ["audit-v2", bytes(129)]]),
    },
  };
}

function bytes(start: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => start + index);
}

function createBudget(bucketId: string, stateRevision: number) {
  return {
    bucketId: `budget-online-session:${bucketId}`,
    bucketKind: "online-session" as const,
    subjectId: bucketId,
    capacity: 10,
    refillPerSecond: 1,
    tokens: 9,
    updatedAtMs: 1_000 + stateRevision,
    stateRevision,
  };
}

function createRoot(suffix: string): EventGameRecordRoot {
  return {
    recordId: `record-${suffix}`,
    eventId: `event-${suffix}`,
    eventGameId: `game-${suffix}`,
    ownership: { eventId: `event-${suffix}`, eventGameId: `game-${suffix}` },
    externalScope: {
      eventId: `event-${suffix}`,
      gameDayId: "day-1",
      pitchId: `pitch-${suffix}`,
      pitchSlotId: `slot-${suffix}`,
    },
    gameSides: [
      { id: `side-a-${suffix}`, eventTeamId: "team-a", teamInterpretationRef: "team-a-v1" },
      { id: `side-b-${suffix}`, eventTeamId: "team-b", teamInterpretationRef: "team-b-v1" },
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
      operationId: `register-${suffix}`,
      actorReference: "actor-test",
      source: "event-game-registration",
      createdAtMs: 500,
    },
  };
}

function createScopeResolver(root: EventGameRecordRoot) {
  return {
    resolve(scope: EventGameRecordRoot["externalScope"]) {
      return JSON.stringify(scope) === JSON.stringify(root.externalScope)
        ? { status: "resolved" as const, scope: structuredClone(scope) }
        : { status: "mismatch" as const, detail: "scope mismatch" };
    },
    resolveEventTeam() {
      return { status: "resolved" as const };
    },
  };
}

function createFact(
  root: EventGameRecordRoot,
  operationId: string,
  sessionId: string,
  versionId: string,
): ControlActionInput {
  const sideA = root.gameSides[0];
  if (sideA === undefined) throw new Error("Expected side A.");
  return {
    recordId: root.recordId,
    eventGameId: root.eventGameId,
    operationId,
    kind: { id: "game-fact", version: "1" },
    payload: {
      factId: `fact-${operationId}`,
      factType: "test",
      gameSideId: sideA.id,
      gameTimeMs: 1,
      data: { operationId },
    },
    causalPredecessorIds: [],
    occurrence: { trustedAtMs: 1_000, clientOriginAtMs: 1_000, source: "online" },
    grant: { sessionId, versionId },
    lifecycle: structuredClone(root.lifecycle),
  };
}
