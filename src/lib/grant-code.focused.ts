import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createGrantTestKeyRing, createGrantTestRandomness } from "@/lib/grant-authority-contract";
import { createGrantTestAuthorityVerifier } from "@/lib/grant-authority-test-support";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import { createTypedGrantAuthority } from "@/lib/grant-management";
import { beginAdmission, recordAdmissionFailure } from "@/lib/grant-admission-throttle";
import type { GrantAdmissionMode } from "@/lib/grant-types";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import { lockControlGrantEventGame } from "@/lib/grant-management-sessions";
import { validateGrantState } from "@/lib/grant-state-validation";
import { FOUNDATION_MIGRATIONS } from "@/lib/foundation-migrations";

const CURRENT_SCHEMA_VERSION = String(FOUNDATION_MIGRATIONS.at(-1)?.schemaVersion ?? 0);

describe("focused SQLite Grant Code integration", () => {
  test("survives restart and freezes same-length ciphertext and anchor tampering", async () => {
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "quadball-timer-grant-code-"),
    );
    const databasePath = join(directory, "foundation.sqlite");
    const keyRing = createGrantTestKeyRing();
    try {
      const storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      await storage.applyMigrations({ requireCandidate: false });
      const authority = createTypedGrantAuthority(storage, createOptions(keyRing, 901));
      const created = await createGrantWithCode(authority);
      const grantId = created.grantId;
      const first = await authority.listGrantAudit(grantId, {
        kind: "technical-admin",
        id: "tech",
      });
      expect(first.status).toBe("ok");
      if (first.status !== "ok") throw new Error("Expected Grant audit evidence.");
      expect(first.value.find((entry) => entry.action === "grant-code-created")).toMatchObject({
        credentialKind: "manual-code",
        codeFormatVersion: 1,
        codeEncryptionKeyVersion: keyRing.encryption.currentVersion,
        codeLookupKeyVersion: keyRing.audit.currentVersion,
        codeStateBefore: "absent",
        codeState: "present",
      });
      storage.close();

      const restarted = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      createTypedGrantAuthority(restarted, createOptions(keyRing, 902));
      expect(await restarted.readiness()).toMatchObject({
        ok: true,
        schemaVersion: CURRENT_SCHEMA_VERSION,
      });
      const stored = await restarted.transaction((transaction) =>
        transaction.findGrantById(grantId),
      );
      expect(stored?.code?.state).toBe("present");
      if (stored?.code?.ciphertext === null || stored?.code?.ciphertext === undefined) {
        throw new Error("Expected persisted Grant Code ciphertext.");
      }
      const tamper = new Database(databasePath);
      const replacement = stored.code.ciphertext[0] === "A" ? "B" : "A";
      tamper
        .query("UPDATE foundation_grant_codes SET code_ciphertext = ? WHERE grant_id = ?")
        .run(replacement + stored.code.ciphertext.slice(1), grantId);
      tamper.close();
      expect(await restarted.readiness()).toMatchObject({ ok: false, status: "integrity-failure" });
      restarted.close();

      const clean = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      createTypedGrantAuthority(clean, createOptions(keyRing, 903));
      // Repairing a raw secret is intentionally outside the authority seam; restore the
      // original database from a fresh run before checking authenticated anchor deletion.
      clean.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("freezes a restarted instance when the authenticated state anchor is deleted", async () => {
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "quadball-timer-grant-anchor-"),
    );
    const databasePath = join(directory, "foundation.sqlite");
    const keyRing = createGrantTestKeyRing();
    try {
      const storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      await storage.applyMigrations({ requireCandidate: false });
      const authority = createTypedGrantAuthority(storage, createOptions(keyRing, 904));
      const grantId = (await createGrantWithCode(authority)).grantId;
      storage.close();
      const tamper = new Database(databasePath);
      tamper.query("DELETE FROM foundation_grant_state_anchors WHERE grant_id = ?").run(grantId);
      tamper.close();
      const restarted = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      createTypedGrantAuthority(restarted, createOptions(keyRing, 905));
      expect(await restarted.readiness()).toMatchObject({ ok: false, status: "integrity-failure" });
      restarted.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("freezes same-length Grant digest tampering and paired session or throttle mutation", async () => {
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "quadball-timer-grant-state-integrity-"),
    );
    const databasePath = join(directory, "foundation.sqlite");
    const keyRing = createGrantTestKeyRing();
    try {
      const storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      await storage.applyMigrations({ requireCandidate: false });
      const authority = createTypedGrantAuthority(storage, createOptions(keyRing, 906));
      const created = await createGrantWithCode(authority);
      const admitted = await authority.admitGrantCode({
        grantCode: created.code,
        browserContext: "focused-code-session",
      });
      expect(admitted.status).toBe("admitted");
      storage.close();

      const tamper = new Database(databasePath);
      const originalDigest = tamper
        .query("SELECT code_lookup_digest FROM foundation_grant_codes WHERE grant_id = ?")
        .get(created.grantId) as { code_lookup_digest: string };
      const replacement = originalDigest.code_lookup_digest[0] === "A" ? "B" : "A";
      tamper
        .query("UPDATE foundation_grant_codes SET code_lookup_digest = ? WHERE grant_id = ?")
        .run(replacement + originalDigest.code_lookup_digest.slice(1), created.grantId);
      tamper
        .query(
          "UPDATE foundation_grant_sessions SET last_active_at_ms = last_active_at_ms + 1 WHERE grant_id = ?",
        )
        .run(created.grantId);
      tamper
        .query(
          "UPDATE foundation_grant_admission_telemetry SET failed_attempts = failed_attempts + 1 WHERE mode = 'code'",
        )
        .run();
      tamper
        .query(
          "UPDATE foundation_grant_admission_global_windows SET attempt_count = attempt_count + 1 WHERE mode = 'code'",
        )
        .run();
      tamper.close();

      const restarted = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      createTypedGrantAuthority(restarted, createOptions(keyRing, 907));
      expect(await restarted.readiness()).toMatchObject({ ok: false, status: "integrity-failure" });
      restarted.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rolls back malformed telemetry and audit candidates before SQLite commit", async () => {
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "quadball-timer-grant-rollback-"),
    );
    const databasePath = join(directory, "foundation.sqlite");
    const keyRing = createGrantTestKeyRing();
    try {
      const storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      await storage.applyMigrations({ requireCandidate: false });
      const authority = createTypedGrantAuthority(storage, createOptions(keyRing, 908));
      const created = await createGrantWithCode(authority);
      const before = await storage.transaction((transaction) => ({
        grant: transaction.findGrantById(created.grantId),
        audit: transaction.listGrantAudit(created.grantId),
        anchor: transaction.readGrantAdmissionStateAnchor?.() ?? null,
      }));
      let failedRevision = -1;
      await expect(
        storage.transaction((transaction) => {
          failedRevision = transaction.revision;
          transaction.writeGrantAdmissionTelemetry?.({
            mode: "code",
            sourceDigest: "A".repeat(43),
            failedAttempts: 1_000_001,
            delayUntilMs: null,
            lastAttemptAtMs: 1_000,
            lastSuccessAtMs: null,
          });
        }),
      ).rejects.toThrow();
      const afterTelemetry = await storage.transaction((transaction) => ({
        grant: transaction.findGrantById(created.grantId),
        audit: transaction.listGrantAudit(created.grantId),
        anchor: transaction.readGrantAdmissionStateAnchor?.() ?? null,
        revision: transaction.revision,
      }));
      expect(afterTelemetry.grant).toEqual(before.grant);
      expect(afterTelemetry.audit).toEqual(before.audit);
      expect(afterTelemetry.anchor).toEqual(before.anchor);
      expect(afterTelemetry.revision).toBe(failedRevision);

      const firstAudit = before.audit[0];
      if (firstAudit === undefined) throw new Error("Expected Grant audit evidence.");
      await expect(
        storage.transaction((transaction) =>
          transaction.appendGrantAudit({
            ...firstAudit,
            auditId: "audit-malformed-code",
            codeState: "present",
          }),
        ),
      ).rejects.toThrow();
      const afterAudit = await storage.transaction((transaction) => ({
        grant: transaction.findGrantById(created.grantId),
        audit: transaction.listGrantAudit(created.grantId),
        anchor: transaction.readGrantAdmissionStateAnchor?.() ?? null,
      }));
      expect(afterAudit).toEqual({
        grant: before.grant,
        audit: before.audit,
        anchor: before.anchor,
      });
      expect(await storage.readiness()).toMatchObject({ ok: true });
      storage.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("accepts Code erasure expiry evidence after SQLite restart", async () => {
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "quadball-timer-grant-expiry-"),
    );
    const databasePath = join(directory, "foundation.sqlite");
    const keyRing = createGrantTestKeyRing();
    let nowMs = 1_000;
    try {
      const storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      await storage.applyMigrations({ requireCandidate: false });
      const authority = createTypedGrantAuthority(storage, {
        ...createOptions(keyRing, 909),
        clock: { nowMs: () => nowMs },
      });
      const created = await createGrantWithCode(authority, 1_100);
      nowMs = 1_100;
      expect(
        await authority.admitGrant({
          qrCredential: created.qrCredential,
          browserContext: "expired-code",
        }),
      ).toMatchObject({ status: "rejected" });
      storage.close();

      const restarted = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      createTypedGrantAuthority(restarted, {
        ...createOptions(keyRing, 910),
        clock: { nowMs: () => nowMs },
      });
      expect(await restarted.readiness()).toMatchObject({
        ok: true,
        schemaVersion: CURRENT_SCHEMA_VERSION,
      });
      const state = await restarted.transaction((transaction) => ({
        grant: transaction.findGrantById(created.grantId),
        audit: transaction.listGrantAudit(created.grantId),
      }));
      expect(state.grant?.status).toBe("expired");
      expect(state.grant?.code?.state).toBe("erased");
      expect(state.audit).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: "grant-expired", credentialKind: "qr" }),
          expect.objectContaining({
            action: "grant-code-erased-expiry",
            credentialKind: "manual-code",
            codeStateBefore: "present",
            codeState: "erased",
          }),
        ]),
      );
      restarted.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("adds only Grant expiry after prior Game-Lock Code erasure across SQLite restart", async () => {
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "quadball-timer-grant-lock-expiry-restart-"),
    );
    const databasePath = join(directory, "foundation.sqlite");
    const keyRing = createGrantTestKeyRing();
    let nowMs = 1_000;
    try {
      const options = createOptions(keyRing, 911, {
        resolveEventGameLock: () => ({ eventGameId: "game-focused", apply: () => {} }),
      });
      options.clock = { nowMs: () => nowMs };
      const storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      await storage.applyMigrations({ requireCandidate: false });
      const authority = createTypedGrantAuthority(storage, options);
      const created = await createGrantWithCode(authority, 1_100);
      expect(
        await authority.admitGrantCode({
          grantCode: created.code,
          browserContext: "lock-expiry-code",
        }),
      ).toMatchObject({ status: "admitted" });
      expect(await lockControlGrantEventGame(storage, options, { accepted: true })).toMatchObject({
        status: "locked",
      });
      const beforeExpiry = await storage.transaction((transaction) =>
        transaction.listGrantAudit(created.grantId),
      );
      expect(
        beforeExpiry.filter((audit) => audit.action === "grant-code-erased-game-lock"),
      ).toHaveLength(1);
      nowMs = 1_100;
      expect(
        await authority.admitGrant({
          qrCredential: created.qrCredential,
          browserContext: "lock-expiry-qr",
        }),
      ).toEqual({
        status: "rejected",
        code: "grant-admission-failed",
        message: "Unable to admit this Grant.",
      });
      expect(
        await authority.admitGrantCode({
          grantCode: created.code,
          browserContext: "lock-expiry-code-old",
        }),
      ).toEqual({
        status: "rejected",
        code: "grant-admission-failed",
        message: "Unable to admit this Grant.",
      });
      const afterExpiry = await storage.transaction((transaction) => ({
        grant: transaction.findGrantById(created.grantId),
        audit: transaction.listGrantAudit(created.grantId),
      }));
      const priorIds = new Set(beforeExpiry.map((audit) => audit.auditId));
      const newlyAdded = afterExpiry.audit.filter((audit) => !priorIds.has(audit.auditId));
      expect(newlyAdded.map((audit) => audit.action)).toEqual(["grant-expired"]);
      expect(
        afterExpiry.audit.filter((audit) => audit.action === "grant-code-erased-expiry"),
      ).toHaveLength(0);
      expect(
        afterExpiry.audit.filter((audit) => audit.action === "grant-code-erased-game-lock"),
      ).toHaveLength(1);
      expect(afterExpiry.grant?.status).toBe("expired");
      expect(afterExpiry.grant?.code?.state).toBe("erased");
      expect(await storage.readiness()).toMatchObject({ ok: true });
      storage.close();

      const restarted = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      const reopened = createTypedGrantAuthority(
        restarted,
        createOptions(keyRing, 912, () => nowMs),
      );
      expect(await restarted.readiness()).toMatchObject({
        ok: true,
        schemaVersion: CURRENT_SCHEMA_VERSION,
      });
      expect(
        await reopened.admitGrant({
          qrCredential: created.qrCredential,
          browserContext: "lock-expiry-qr-restart",
        }),
      ).toEqual({
        status: "rejected",
        code: "grant-admission-failed",
        message: "Unable to admit this Grant.",
      });
      expect(
        await reopened.admitGrantCode({
          grantCode: created.code,
          browserContext: "lock-expiry-code-restart",
        }),
      ).toEqual({
        status: "rejected",
        code: "grant-admission-failed",
        message: "Unable to admit this Grant.",
      });
      restarted.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rebinds or expires Codes before lifecycle decisions across SQLite restart", async () => {
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "quadball-timer-grant-binding-restart-"),
    );
    const databasePath = join(directory, "foundation.sqlite");
    const keyRing = createGrantTestKeyRing();
    let nowMs = 1_000;
    const options = createOptions(keyRing, 913, {
      resolveEventGameLock: () => ({ eventGameId: "game-focused", apply: () => {} }),
    });
    options.clock = { nowMs: () => nowMs };
    try {
      const storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      await storage.applyMigrations({ requireCandidate: false });
      const authority = createTypedGrantAuthority(storage, options);
      const reactivation = await createGrantCodeScenario(authority);
      const management = {
        kind: "grant-session" as const,
        sessionBearer: reactivation.adminBearer,
      };
      expect(await authority.disableGrant(reactivation.grantId, management)).toMatchObject({
        status: "updated",
      });

      const admin = await authority.createEventAdminGrant({
        authority: { kind: "technical-admin", id: "tech" },
        scope: {
          eventId: "event-focused-metadata",
          eventTimeZone: "UTC",
          finalGameDayDate: "2026-03-20",
        },
      });
      if (admin.status !== "created") throw new Error("Expected metadata Event Admin Grant.");
      const metadataManager = await authority.admitGrant({
        qrCredential: admin.qrCredential,
        browserContext: "focused-metadata-admin",
      });
      if (metadataManager.status !== "admitted")
        throw new Error("Expected metadata Event Admin Session.");
      const metadata = await authority.createPitchManagerGrant({
        authority: { kind: "grant-session", sessionBearer: metadataManager.sessionBearer },
        scope: {
          eventId: "event-focused-metadata",
          gameDayId: "day",
          gameDayDate: "2026-03-20",
          eventTimeZone: "UTC",
          pitchId: "pitch-metadata",
        },
      });
      if (metadata.status !== "created") throw new Error("Expected metadata Grant.");
      const metadataCode = await authority.createGrantCode(metadata.grantId, {
        kind: "grant-session",
        sessionBearer: metadataManager.sessionBearer,
      });
      if (metadataCode.status !== "created") throw new Error("Expected metadata Grant Code.");

      const codeFirst = await createGrantCodeScenario(authority, 1_050, "-code-first");
      const dueLock = await createGrantCodeScenario(authority, 1_100, "-due-lock");
      const notDueLock = await createGrantCodeScenario(authority, 1_200, "-not-due-lock");
      expect(
        await authority.admitGrantCode({
          grantCode: dueLock.code,
          browserContext: "due-lock-session",
        }),
      ).toMatchObject({ status: "admitted" });
      expect(
        await authority.admitGrantCode({
          grantCode: notDueLock.code,
          browserContext: "not-due-lock-session",
        }),
      ).toMatchObject({ status: "admitted" });
      expect(await storage.readiness()).toMatchObject({ ok: true });
      storage.close();

      const restarted = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      const reopened = createTypedGrantAuthority(restarted, {
        ...options,
        randomness: createGrantTestRandomness(9999),
      });
      expect(await restarted.readiness()).toMatchObject({
        ok: true,
        schemaVersion: CURRENT_SCHEMA_VERSION,
      });

      expect(await reopened.reactivateGrant(reactivation.grantId, management)).toMatchObject({
        status: "updated",
      });
      expect(
        await reopened.admitGrantCode({
          grantCode: reactivation.code,
          browserContext: "old-reactivation-code-restart",
        }),
      ).toMatchObject({ status: "rejected" });
      const reactivatedState = await restarted.transaction((transaction) => ({
        grant: transaction.findGrantById(reactivation.grantId),
        audit: transaction.listGrantAudit(reactivation.grantId),
      }));
      expect(reactivatedState.grant).toMatchObject({
        status: "active",
        code: { state: "disabled" },
      });
      expect(reactivatedState.audit).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "grant-code-disabled",
            codeStateBefore: "present",
            codeState: "disabled",
          }),
          expect.objectContaining({ action: "grant-reactivated" }),
        ]),
      );

      expect(
        await reopened.recalculateGrantExpiry(
          metadata.grantId,
          { gameDayDate: "2026-03-21" },
          { kind: "grant-session", sessionBearer: metadataManager.sessionBearer },
        ),
      ).toMatchObject({ status: "updated" });
      expect(
        await reopened.admitGrantCode({
          grantCode: metadataCode.code,
          browserContext: "old-metadata-code-restart",
        }),
      ).toMatchObject({ status: "rejected" });
      const metadataState = await restarted.transaction((transaction) => ({
        grant: transaction.findGrantById(metadata.grantId),
        audit: transaction.listGrantAudit(metadata.grantId),
      }));
      expect(metadataState.grant).toMatchObject({
        status: "active",
        code: { state: "disabled" },
        scope: { gameDayDate: "2026-03-21" },
      });
      expect(metadataState.audit).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "grant-code-disabled",
            codeStateBefore: "present",
            codeState: "disabled",
          }),
          expect.objectContaining({ action: "grant-metadata-updated" }),
        ]),
      );

      nowMs = 1_050;
      expect(
        await reopened.admitGrantCode({
          grantCode: codeFirst.code,
          browserContext: "expired-code-first-restart",
        }),
      ).toMatchObject({ status: "rejected" });
      const codeFirstState = await restarted.transaction((transaction) => ({
        grant: transaction.findGrantById(codeFirst.grantId),
        audit: transaction.listGrantAudit(codeFirst.grantId),
      }));
      expect(codeFirstState.grant).toMatchObject({ status: "expired", code: { state: "erased" } });
      expect(codeFirstState.audit).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: "grant-expired" }),
          expect.objectContaining({
            action: "grant-code-erased-expiry",
            codeStateBefore: "present",
            codeState: "erased",
          }),
        ]),
      );

      nowMs = 1_100;
      const beforeLockDue = await restarted.transaction((transaction) =>
        transaction.listGrantAudit(dueLock.grantId),
      );
      expect(await lockControlGrantEventGame(restarted, options, { accepted: true })).toMatchObject(
        {
          status: "locked",
        },
      );
      const afterLock = await restarted.transaction((transaction) => ({
        due: transaction.findGrantById(dueLock.grantId),
        dueAudit: transaction.listGrantAudit(dueLock.grantId),
        notDue: transaction.findGrantById(notDueLock.grantId),
        notDueAudit: transaction.listGrantAudit(notDueLock.grantId),
        dueSessions: transaction.listGrantSessions(dueLock.grantId),
        notDueSessions: transaction.listGrantSessions(notDueLock.grantId),
      }));
      expect(afterLock.due).toMatchObject({ status: "expired", code: { state: "erased" } });
      const newDueActions = afterLock.dueAudit
        .filter((audit) => !beforeLockDue.some((before) => before.auditId === audit.auditId))
        .map((audit) => audit.action);
      expect(newDueActions).toEqual(["grant-expired", "grant-code-erased-expiry"]);
      expect(
        afterLock.dueAudit.some((audit) => audit.action === "grant-code-erased-game-lock"),
      ).toBe(false);
      expect(afterLock.dueSessions.every((session) => session.status === "expired")).toBe(true);
      expect(afterLock.notDue).toMatchObject({ status: "active", code: { state: "erased" } });
      expect(afterLock.notDueAudit).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: "grant-code-erased-game-lock" }),
          expect.objectContaining({ action: "session-terminated", terminalReason: "game-locked" }),
        ]),
      );
      expect(await restarted.readiness()).toMatchObject({ ok: true });
      restarted.close();

      const finalRestart = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      try {
        createTypedGrantAuthority(finalRestart, {
          ...options,
          randomness: createGrantTestRandomness(915),
        });
        expect(await finalRestart.readiness()).toMatchObject({
          ok: true,
          schemaVersion: CURRENT_SCHEMA_VERSION,
        });
        expect(
          await finalRestart.transaction((transaction) =>
            transaction.findGrantById(dueLock.grantId),
          ),
        ).toMatchObject({ status: "expired", code: { state: "erased" } });
      } finally {
        finalRestart.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("persists Code delay across restart without consuming QR admission", async () => {
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "quadball-timer-grant-code-throttle-"),
    );
    const databasePath = join(directory, "foundation.sqlite");
    const keyRing = createGrantTestKeyRing();
    try {
      let nowMs = 1_000;
      const options = createOptions(keyRing, 906, () => nowMs);
      const storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      await storage.applyMigrations({ requireCandidate: false });
      for (let attempt = 0; attempt < 5; attempt += 1)
        expect(await useBudget(storage, options, "code", "restart-source", true)).toBeNull();
      expect(await useBudget(storage, options, "code", "restart-source", false)).toMatchObject({
        retryAfterMs: 1_000,
      });
      storage.close();

      const restarted = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      expect(await useBudget(restarted, options, "code", "restart-source", false)).toMatchObject({
        retryAfterMs: 1_000,
      });
      expect(await useBudget(restarted, options, "qr", "restart-source", true)).toBeNull();
      nowMs += 1_000;
      expect(await useBudget(restarted, options, "code", "restart-source", false)).toBeNull();
      restarted.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("persists Game-Lock erasure, restart-safe fresh codes, rollback, and full rotation", async () => {
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "quadball-timer-grant-code-lifecycle-"),
    );
    const databasePath = join(directory, "foundation.sqlite");
    const keyRing = createGrantTestKeyRing();
    let failLock = false;
    const options = createOptions(keyRing, 906, {
      resolveEventGameLock: () => ({
        eventGameId: "game-focused",
        apply: () => {
          if (failLock) throw new Error("lock transition failed");
        },
      }),
    });
    try {
      const storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      await storage.applyMigrations({ requireCandidate: false });
      const authority = createTypedGrantAuthority(storage, options);
      const scenario = await createGrantCodeScenario(authority);
      const admitted = await authority.admitGrantCode({
        grantCode: scenario.code,
        browserContext: "focused-lock-controller",
      });
      expect(admitted.status).toBe("admitted");
      const replaced = await authority.admitGrantCode({
        grantCode: scenario.code,
        browserContext: "focused-lock-controller",
      });
      expect(replaced.status).toBe("admitted");
      if (replaced.status !== "admitted") throw new Error("Expected replaced Control Session.");
      expect(await authority.leaveGrantSession(replaced.sessionBearer)).toMatchObject({
        status: "updated",
      });
      const freshBeforeLock = await authority.admitGrantCode({
        grantCode: scenario.code,
        browserContext: "focused-lock-controller-fresh",
      });
      expect(freshBeforeLock.status).toBe("admitted");
      const locked = await lockControlGrantEventGame(storage, options, { accepted: true });
      expect(locked).toMatchObject({
        status: "locked",
        eventGameId: "game-focused",
        terminatedSessionCount: 1,
      });
      const erased = await storage.transaction((transaction) => ({
        grant: transaction.findGrantById(scenario.grantId),
        audit: transaction.listGrantAudit(scenario.grantId),
      }));
      expect(erased.grant?.code).toMatchObject({ state: "erased", ciphertext: null });
      expect(erased.audit).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: "grant-code-erased-game-lock", codeState: "erased" }),
        ]),
      );
      storage.close();

      const restarted = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      const reopened = createTypedGrantAuthority(restarted, createOptions(keyRing, 1307));
      expect(await restarted.readiness()).toMatchObject({
        ok: true,
        schemaVersion: CURRENT_SCHEMA_VERSION,
      });
      expect(
        await reopened.admitGrantCode({ grantCode: scenario.code, browserContext: "old-code" }),
      ).toMatchObject({ status: "rejected" });
      const fresh = await reopened.createGrantCode(scenario.grantId, {
        kind: "grant-session",
        sessionBearer: scenario.adminBearer,
      });
      expect(fresh.status).toBe("created");
      if (fresh.status !== "created") throw new Error("Expected a fresh restarted Grant Code.");
      const freshSession = await reopened.admitGrantCode({
        grantCode: fresh.code,
        browserContext: "focused-lock-controller-second-cycle",
      });
      expect(freshSession.status).toBe("admitted");
      expect(await lockControlGrantEventGame(restarted, options, { accepted: true })).toEqual({
        status: "locked",
        eventGameId: "game-focused",
        terminatedSessionCount: 1,
      });
      const secondCycle = await restarted.transaction((transaction) => ({
        grant: transaction.findGrantById(scenario.grantId),
        sessions: transaction.listGrantSessions(scenario.grantId),
        audit: transaction.listGrantAudit(scenario.grantId),
      }));
      expect(secondCycle.grant?.code).toMatchObject({ state: "erased", ciphertext: null });
      expect(
        secondCycle.audit.filter((audit) => audit.action === "grant-code-erased-game-lock"),
      ).toHaveLength(2);
      restarted.close();

      const restartedAgain = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      const reopenedAgain = createTypedGrantAuthority(restartedAgain, createOptions(keyRing, 1308));
      expect(await restartedAgain.readiness()).toMatchObject({
        ok: true,
        schemaVersion: CURRENT_SCHEMA_VERSION,
      });
      expect(
        await reopenedAgain.admitGrantCode({
          grantCode: scenario.code,
          browserContext: "old-code-second-restart",
        }),
      ).toMatchObject({ status: "rejected" });
      expect(
        await reopenedAgain.admitGrantCode({
          grantCode: fresh.code,
          browserContext: "fresh-code-second-restart",
        }),
      ).toMatchObject({ status: "rejected" });
      const third = await reopenedAgain.createGrantCode(scenario.grantId, {
        kind: "grant-session",
        sessionBearer: scenario.adminBearer,
      });
      expect(third.status).toBe("created");
      const beforeFailure = await restartedAgain.transaction((transaction) => ({
        grant: transaction.findGrantById(scenario.grantId),
        sessions: transaction.listGrantSessions(scenario.grantId),
        audit: transaction.listGrantAudit(scenario.grantId),
      }));
      failLock = true;
      expect(await lockControlGrantEventGame(restartedAgain, options, { accepted: true })).toEqual({
        status: "rejected",
        reason: "unavailable",
      });
      expect(
        await restartedAgain.transaction((transaction) => ({
          grant: transaction.findGrantById(scenario.grantId),
          sessions: transaction.listGrantSessions(scenario.grantId),
          audit: transaction.listGrantAudit(scenario.grantId),
        })),
      ).toEqual(beforeFailure);
      restartedAgain.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("preflights every SQLite Game-Lock Grant before committing any mutation", async () => {
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "quadball-timer-grant-code-multi-lock-"),
    );
    const databasePath = join(directory, "foundation.sqlite");
    const keyRing = createGrantTestKeyRing();
    let resolutionMode: "normal" | "throw" | "conflict" | "past-day" | "switch" = "normal";
    let lockApplied = false;
    const options = createOptions(keyRing, 911, {
      resolve: (scope) => {
        if (resolutionMode === "throw" && scope.pitchId === "second")
          throw new Error("resolver failed");
        if (resolutionMode === "conflict" && scope.pitchId === "second")
          return { status: "conflict" as const };
        if (resolutionMode === "past-day" && scope.pitchId === "second")
          return {
            status: "terminal" as const,
            reason: "past-game-day" as const,
            eventGameId: "game-focused",
          };
        if (resolutionMode === "switch" && scope.pitchId === "second")
          return {
            status: "terminal" as const,
            reason: "accepted-game-switch" as const,
            eventGameId: "game-focused",
          };
        return {
          status: "eligible" as const,
          eventGameId: scope.pitchId === "first" ? "game-focused" : "other-game",
        };
      },
      resolveEventGameLock: () => ({
        eventGameId: "game-focused",
        apply: () => {
          lockApplied = true;
        },
      }),
    });
    try {
      const storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      await storage.applyMigrations({ requireCandidate: false });
      const authority = createTypedGrantAuthority(storage, options);
      const admin = await authority.createEventAdminGrant({
        authority: { kind: "technical-admin", id: "tech" },
        scope: {
          eventId: "event-focused-code",
          eventTimeZone: "UTC",
          finalGameDayDate: "2026-03-20",
        },
      });
      if (admin.status !== "created") throw new Error("Expected Event Admin Grant.");
      const adminSession = await authority.admitGrant({
        qrCredential: admin.qrCredential,
        browserContext: "multi-lock-admin",
      });
      if (adminSession.status !== "admitted") throw new Error("Expected Event Admin Session.");
      const makeGrant = async (pitchId: string) => {
        const grant = await authority.createControlGrant({
          authority: { kind: "grant-session", sessionBearer: adminSession.sessionBearer },
          scope: {
            eventId: "event-focused-code",
            gameDayId: "day",
            pitchId,
            pitchSlotId: `${pitchId}-slot`,
          },
        });
        if (grant.status !== "created") throw new Error("Expected Control Grant.");
        const code = await authority.createGrantCode(grant.grantId, {
          kind: "grant-session",
          sessionBearer: adminSession.sessionBearer,
        });
        if (code.status !== "created") throw new Error("Expected Grant Code.");
        const session = await authority.admitGrantCode({
          grantCode: code.code,
          browserContext: `multi-lock-${pitchId}`,
        });
        if (session.status !== "admitted") throw new Error("Expected Control Session.");
        return grant.grantId;
      };
      const firstGrantId = await makeGrant("first");
      const secondGrantId = await makeGrant("second");
      const snapshot = () =>
        storage.transaction((transaction) => ({
          firstGrant: transaction.findGrantById(firstGrantId),
          secondGrant: transaction.findGrantById(secondGrantId),
          firstSessions: transaction.listGrantSessions(firstGrantId),
          secondSessions: transaction.listGrantSessions(secondGrantId),
          firstAudit: transaction.listGrantAudit(firstGrantId),
          secondAudit: transaction.listGrantAudit(secondGrantId),
        }));
      resolutionMode = "throw";
      const beforeThrow = await snapshot();
      expect(await lockControlGrantEventGame(storage, options, { accepted: true })).toEqual({
        status: "rejected",
        reason: "unavailable",
      });
      expect(await snapshot()).toEqual(beforeThrow);
      expect(lockApplied).toBe(false);
      resolutionMode = "conflict";
      const beforeConflict = await snapshot();
      expect(await lockControlGrantEventGame(storage, options, { accepted: true })).toEqual({
        status: "rejected",
        reason: "unavailable",
      });
      expect(await snapshot()).toEqual(beforeConflict);
      expect(lockApplied).toBe(false);
      for (const rejectedMode of ["past-day", "switch"] as const) {
        resolutionMode = rejectedMode;
        const beforeRejectedTerminal = await snapshot();
        expect(await lockControlGrantEventGame(storage, options, { accepted: true })).toEqual({
          status: "rejected",
          reason: "unavailable",
        });
        expect(await snapshot()).toEqual(beforeRejectedTerminal);
        expect(lockApplied).toBe(false);
      }
      resolutionMode = "normal";
      expect(await lockControlGrantEventGame(storage, options, { accepted: true })).toMatchObject({
        status: "locked",
      });
      const after = await snapshot();
      expect(after.firstGrant?.code?.state).toBe("erased");
      expect(after.secondGrant?.code?.state).toBe("present");
      storage.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("replays switch-away and switch-in bindings across SQLite restart", async () => {
    for (const [index, direction] of (["away", "in"] as const).entries()) {
      const directory = await mkdtemp(
        join(process.env.TMPDIR ?? "/tmp", `quadball-timer-grant-code-switch-${direction}-`),
      );
      const databasePath = join(directory, "foundation.sqlite");
      const keyRing = createGrantTestKeyRing();
      let currentEventGame = direction === "away" ? "game-focused" : "game-other";
      const options = createOptions(keyRing, 1401 + index, {
        resolve: () => ({ status: "eligible" as const, eventGameId: currentEventGame }),
        resolveSession: (_scope, sessionEventGameId) =>
          direction === "away" && sessionEventGameId === "game-focused"
            ? {
                status: "switchable" as const,
                previousEventGameId: "game-focused",
                currentEventGameId: "game-other",
              }
            : direction === "in" && sessionEventGameId === "game-other"
              ? {
                  status: "switchable" as const,
                  previousEventGameId: "game-other",
                  currentEventGameId: "game-focused",
                }
              : { status: "current" as const, eventGameId: sessionEventGameId },
        resolveEventGameLock: () => ({ eventGameId: "game-focused", apply: () => {} }),
      });
      try {
        const storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
        await storage.applyMigrations({ requireCandidate: false });
        const authority = createTypedGrantAuthority(storage, options);
        const scenario = await createGrantCodeScenario(authority);
        const session = await authority.admitGrantCode({
          grantCode: scenario.code,
          browserContext: `sqlite-switch-${direction}`,
        });
        if (session.status !== "admitted") throw new Error("Expected Control Session.");
        if (direction === "in") currentEventGame = "game-focused";
        expect(
          await authority.authorizeGrant({
            sessionBearer: session.sessionBearer,
            eventGameId: direction === "away" ? "game-other" : "game-focused",
          }),
        ).toMatchObject({ status: "switch-required" });
        expect(
          await authority.acceptControlGrantSessionSwitch({ sessionBearer: session.sessionBearer }),
        ).toMatchObject({
          status: "switched",
          eventGameId: direction === "away" ? "game-other" : "game-focused",
        });
        expect(await lockControlGrantEventGame(storage, options, { accepted: true })).toMatchObject(
          {
            status: "locked",
            terminatedSessionCount: direction === "away" ? 0 : 1,
          },
        );
        storage.close();

        const restarted = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
        createTypedGrantAuthority(restarted, options);
        expect(await restarted.readiness()).toMatchObject({
          ok: true,
          schemaVersion: CURRENT_SCHEMA_VERSION,
        });
        const state = await restarted.transaction((transaction) => ({
          grant: transaction.findGrantById(scenario.grantId),
          sessions: transaction.listGrantSessions(scenario.grantId),
        }));
        expect(state.grant?.code?.state).toBe("erased");
        expect(state.sessions[0]).toMatchObject({
          status: direction === "away" ? "active" : "expired",
          eventGameId: direction === "away" ? "game-other" : "game-focused",
        });
        restarted.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  test("keeps rewrap and disabled sessions until SQLite Game-Lock", async () => {
    for (const [index, mode] of (["rewrap", "disabled"] as const).entries()) {
      const directory = await mkdtemp(
        join(process.env.TMPDIR ?? "/tmp", `quadball-timer-grant-code-${mode}-lock-`),
      );
      const databasePath = join(directory, "foundation.sqlite");
      const keyRing = createGrantTestKeyRing();
      const options = createOptions(keyRing, 1501 + index, {
        resolveEventGameLock: () => ({ eventGameId: "game-focused", apply: () => {} }),
      });
      try {
        const storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
        await storage.applyMigrations({ requireCandidate: false });
        const authority = createTypedGrantAuthority(storage, options);
        const scenario = await createGrantCodeScenario(authority);
        const admitted = await authority.admitGrantCode({
          grantCode: scenario.code,
          browserContext: `sqlite-${mode}-controller`,
        });
        expect(admitted).toMatchObject({ status: "admitted" });
        if (mode === "rewrap") {
          expect(
            await authority.rotateGrantCredentialKeys(scenario.grantId, {
              kind: "grant-session",
              sessionBearer: scenario.adminBearer,
            }),
          ).toMatchObject({ status: "updated" });
        } else {
          expect(
            await authority.disableGrant(scenario.grantId, {
              kind: "grant-session",
              sessionBearer: scenario.adminBearer,
            }),
          ).toMatchObject({ status: "updated" });
        }
        expect(await lockControlGrantEventGame(storage, options, { accepted: true })).toEqual({
          status: "locked",
          eventGameId: "game-focused",
          terminatedSessionCount: 1,
        });
        storage.close();

        const restarted = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
        createTypedGrantAuthority(restarted, createOptions(keyRing, 1601 + index));
        expect(await restarted.readiness()).toMatchObject({
          ok: true,
          schemaVersion: CURRENT_SCHEMA_VERSION,
        });
        const state = await restarted.transaction((transaction) => ({
          grant: transaction.findGrantById(scenario.grantId),
          sessions: transaction.listGrantSessions(scenario.grantId),
          audit: transaction.listGrantAudit(scenario.grantId),
        }));
        expect(state.grant).toMatchObject({
          status: mode === "disabled" ? "disabled" : "active",
          code: { state: "erased", ciphertext: null },
        });
        expect(state.sessions[0]).toMatchObject({
          status: "expired",
          eventGameId: "game-focused",
        });
        expect(
          state.audit.filter(
            (audit) =>
              audit.action === "session-terminated" && audit.terminalReason === "game-locked",
          ),
        ).toHaveLength(1);
        restarted.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  test("returns both SQLite rotation credentials from absent, disabled, and lock-erased states", async () => {
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "quadball-timer-grant-code-state-matrix-"),
    );
    const databasePath = join(directory, "foundation.sqlite");
    const keyRing = createGrantTestKeyRing();
    const options = createOptions(keyRing, 912, {
      resolveEventGameLock: () => ({ eventGameId: "game-focused", apply: () => {} }),
    });
    try {
      const storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      await storage.applyMigrations({ requireCandidate: false });
      const authority = createTypedGrantAuthority(storage, options);
      const admin = await authority.createEventAdminGrant({
        authority: { kind: "technical-admin", id: "tech" },
        scope: {
          eventId: "event-focused-code",
          eventTimeZone: "UTC",
          finalGameDayDate: "2026-03-20",
        },
      });
      if (admin.status !== "created") throw new Error("Expected Event Admin Grant.");
      const adminSession = await authority.admitGrant({
        qrCredential: admin.qrCredential,
        browserContext: "state-matrix-admin",
      });
      if (adminSession.status !== "admitted") throw new Error("Expected Event Admin Session.");
      const grant = await authority.createControlGrant({
        authority: { kind: "grant-session", sessionBearer: adminSession.sessionBearer },
        scope: {
          eventId: "event-focused-code",
          gameDayId: "day",
          pitchId: "pitch",
          pitchSlotId: "slot",
        },
      });
      if (grant.status !== "created") throw new Error("Expected Control Grant.");
      const rotate = async () => {
        const result = await authority.rotateGrant(grant.grantId, {
          kind: "grant-session",
          sessionBearer: adminSession.sessionBearer,
        });
        if (result.status !== "updated" || !("qrCredential" in result) || result.code === undefined)
          throw new Error("Expected both rotation credentials.");
        const raw = new Database(databasePath);
        const roots = raw.query("SELECT * FROM foundation_grant_roots").all();
        const codes = raw.query("SELECT * FROM foundation_grant_codes").all();
        raw.close();
        expect(JSON.stringify({ roots, codes })).not.toContain(result.qrCredential);
        expect(JSON.stringify({ roots, codes })).not.toContain(result.code);
        return result;
      };
      const absent = await rotate();
      await authority.disableGrantCode(grant.grantId, {
        kind: "grant-session",
        sessionBearer: adminSession.sessionBearer,
      });
      const disabled = await rotate();
      expect(
        await authority.admitGrantCode({ grantCode: absent.code!, browserContext: "old-absent" }),
      ).toMatchObject({ status: "rejected" });
      expect(await lockControlGrantEventGame(storage, options, { accepted: true })).toMatchObject({
        status: "locked",
      });
      const erased = await rotate();
      expect(
        await authority.admitGrantCode({
          grantCode: disabled.code!,
          browserContext: "old-disabled",
        }),
      ).toMatchObject({ status: "rejected" });
      expect(erased.code).not.toBe(disabled.code);
      storage.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("freezes SQLite readiness when Game-Lock Code evidence is malformed", async () => {
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "quadball-timer-grant-code-evidence-"),
    );
    const databasePath = join(directory, "foundation.sqlite");
    const keyRing = createGrantTestKeyRing();
    const options = createOptions(keyRing, 913, {
      resolveEventGameLock: () => ({ eventGameId: "game-focused", apply: () => {} }),
    });
    try {
      let storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      await storage.applyMigrations({ requireCandidate: false });
      const authority = createTypedGrantAuthority(storage, options);
      const scenario = await createGrantCodeScenario(authority);
      expect(
        await authority.admitGrantCode({
          grantCode: scenario.code,
          browserContext: "evidence-controller",
        }),
      ).toMatchObject({ status: "admitted" });
      expect(await lockControlGrantEventGame(storage, options, { accepted: true })).toMatchObject({
        status: "locked",
      });
      const secondCycle = await storage.transaction((transaction) => ({
        grant: transaction.findGrantById(scenario.grantId),
        sessions: transaction.listGrantSessions(scenario.grantId),
        audit: transaction.listGrantAudit(scenario.grantId),
      }));
      if (secondCycle.grant === null) throw new Error("Expected second-cycle Grant state.");
      const gameLockTermination = secondCycle.audit.find(
        (audit) => audit.action === "session-terminated" && audit.terminalReason === "game-locked",
      );
      if (gameLockTermination === undefined)
        throw new Error("Expected Game-Lock session termination evidence.");
      const validationContext = { environmentId: options.environmentId, keyRing: options.keyRing };
      expect(
        validateGrantState(
          [secondCycle.grant],
          secondCycle.sessions,
          secondCycle.audit.filter((audit) => audit.auditId !== gameLockTermination.auditId),
          validationContext,
        ),
      ).not.toBeNull();
      expect(
        validateGrantState(
          [secondCycle.grant],
          secondCycle.sessions,
          [
            ...secondCycle.audit,
            { ...structuredClone(gameLockTermination), auditId: "extra-game-lock-termination" },
          ],
          validationContext,
        ),
      ).not.toBeNull();
      storage.close();
      storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      const reopened = createTypedGrantAuthority(storage, createOptions(keyRing, 1313));
      expect(await storage.readiness()).toMatchObject({
        ok: true,
        schemaVersion: CURRENT_SCHEMA_VERSION,
      });
      const fresh = await reopened.createGrantCode(scenario.grantId, {
        kind: "grant-session",
        sessionBearer: scenario.adminBearer,
      });
      expect(fresh.status).toBe("created");
      if (fresh.status !== "created") throw new Error("Expected a fresh second-cycle code.");
      expect(
        await reopened.admitGrantCode({
          grantCode: fresh.code,
          browserContext: "evidence-controller-second-cycle",
        }),
      ).toMatchObject({ status: "admitted" });
      expect(await lockControlGrantEventGame(storage, options, { accepted: true })).toMatchObject({
        status: "locked",
      });
      storage.close();
      const tamper = new Database(databasePath);
      tamper
        .query(
          "UPDATE foundation_grant_audit SET previous_code_fingerprint = ? WHERE action = ? AND grant_id = ? AND audit_sequence = (SELECT MAX(audit_sequence) FROM foundation_grant_audit WHERE action = ? AND grant_id = ?)",
        )
        .run(
          "malformed-second-cycle",
          "grant-code-erased-game-lock",
          scenario.grantId,
          "grant-code-erased-game-lock",
          scenario.grantId,
        );
      tamper.close();
      const restarted = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      expect(await restarted.readiness()).toMatchObject({ ok: false, status: "integrity-failure" });
      restarted.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("returns full-rotation secrets once and invalidates both old secrets after restart", async () => {
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "quadball-timer-grant-full-rotation-"),
    );
    const databasePath = join(directory, "foundation.sqlite");
    const keyRing = createGrantTestKeyRing();
    try {
      const storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      await storage.applyMigrations({ requireCandidate: false });
      const authority = createTypedGrantAuthority(storage, createOptions(keyRing, 908));
      const scenario = await createGrantCodeScenario(authority);
      const oldQr = await authority.admitGrant({
        qrCredential: scenario.qrCredential,
        browserContext: "old-qr",
      });
      const oldCode = await authority.admitGrantCode({
        grantCode: scenario.code,
        browserContext: "old-code",
      });
      expect(oldQr.status).toBe("admitted");
      expect(oldCode.status).toBe("admitted");
      const rotated = await authority.rotateGrant(scenario.grantId, {
        kind: "grant-session",
        sessionBearer: scenario.adminBearer,
      });
      if (
        rotated.status !== "updated" ||
        !("qrCredential" in rotated) ||
        rotated.qrCredential === undefined ||
        rotated.code === undefined
      )
        throw new Error("Expected one-time full rotation secrets.");
      const newQr = rotated.qrCredential;
      const newCode = rotated.code;
      expect(rotated).toMatchObject({ oneTime: true, noStore: true });
      const rawDatabase = new Database(databasePath);
      const rawRoots = rawDatabase.query("SELECT * FROM foundation_grant_roots").all();
      const rawCodes = rawDatabase.query("SELECT * FROM foundation_grant_codes").all();
      rawDatabase.close();
      expect(JSON.stringify({ rawRoots, rawCodes }).includes(newQr)).toBe(false);
      expect(JSON.stringify({ rawRoots, rawCodes }).includes(newCode)).toBe(false);
      expect(
        await authority.admitGrantCode({
          grantCode: newCode,
          browserContext: "new-code-before-restart",
        }),
      ).toMatchObject({ status: "admitted" });
      storage.close();

      const restarted = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      const reopened = createTypedGrantAuthority(restarted, createOptions(keyRing, 1001));
      expect(await restarted.readiness()).toMatchObject({
        ok: true,
        schemaVersion: CURRENT_SCHEMA_VERSION,
      });
      expect(
        await reopened.admitGrant({
          qrCredential: scenario.qrCredential,
          browserContext: "old-qr-restart",
        }),
      ).toMatchObject({ status: "rejected" });
      expect(
        await reopened.admitGrantCode({
          grantCode: scenario.code,
          browserContext: "old-code-restart",
        }),
      ).toMatchObject({ status: "rejected" });
      expect(
        await reopened.admitGrant({ qrCredential: newQr, browserContext: "new-qr" }),
      ).toMatchObject({ status: "admitted" });
      expect(
        await reopened.admitGrantCode({ grantCode: newCode, browserContext: "new-code-restart" }),
      ).toMatchObject({ status: "admitted" });
      restarted.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function useBudget(
  storage: ReturnType<typeof openSqliteFoundationStorage>,
  options: ReturnType<typeof createOptions>,
  mode: GrantAdmissionMode,
  browserContext: string,
  recordFailure: boolean,
) {
  return storage.transaction((transaction) => {
    const budget = beginAdmission(
      transaction,
      options,
      mode,
      browserContext,
      options.clock.nowMs(),
    );
    if (budget.throttle === null && recordFailure)
      recordAdmissionFailure(transaction, mode, budget.sourceDigest, options.clock.nowMs());
    return budget.throttle;
  });
}

async function createGrantWithCode(
  authority: ReturnType<typeof createTypedGrantAuthority>,
  expiresAtMs?: number,
): Promise<{ grantId: string; code: string; qrCredential: string }> {
  const admin = await authority.createEventAdminGrant({
    authority: { kind: "technical-admin", id: "tech" },
    scope: { eventId: "event-focused-code", eventTimeZone: "UTC", finalGameDayDate: "2026-03-20" },
  });
  if (admin.status !== "created") throw new Error("Expected Event Admin Grant.");
  const session = await authority.admitGrant({
    qrCredential: admin.qrCredential,
    browserContext: "focused-admin",
  });
  if (session.status !== "admitted") throw new Error("Expected Event Admin Session.");
  const grant = await authority.createControlGrant({
    authority: { kind: "grant-session", sessionBearer: session.sessionBearer },
    scope: {
      eventId: "event-focused-code",
      gameDayId: "day",
      pitchId: "pitch",
      pitchSlotId: "slot",
    },
    ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
  });
  if (grant.status !== "created") throw new Error("Expected Control Grant.");
  const code = await authority.createGrantCode(grant.grantId, {
    kind: "grant-session",
    sessionBearer: session.sessionBearer,
  });
  if (code.status !== "created") throw new Error("Expected Grant Code.");
  return { grantId: grant.grantId, code: code.code, qrCredential: grant.qrCredential };
}

async function createGrantCodeScenario(
  authority: ReturnType<typeof createTypedGrantAuthority>,
  expiresAtMs?: number,
  suffix = "",
): Promise<{ grantId: string; qrCredential: string; code: string; adminBearer: string }> {
  const eventId = `event-focused-code${suffix}`;
  const admin = await authority.createEventAdminGrant({
    authority: { kind: "technical-admin", id: "tech" },
    scope: { eventId, eventTimeZone: "UTC", finalGameDayDate: "2026-03-20" },
  });
  if (admin.status !== "created") throw new Error("Expected Event Admin Grant.");
  const session = await authority.admitGrant({
    qrCredential: admin.qrCredential,
    browserContext: "focused-admin-scenario",
  });
  if (session.status !== "admitted") throw new Error("Expected Event Admin Session.");
  const grant = await authority.createControlGrant({
    authority: { kind: "grant-session", sessionBearer: session.sessionBearer },
    scope: {
      eventId,
      gameDayId: "day",
      pitchId: `pitch${suffix}`,
      pitchSlotId: `slot${suffix}`,
    },
    ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
  });
  if (grant.status !== "created") throw new Error("Expected Control Grant.");
  const code = await authority.createGrantCode(grant.grantId, {
    kind: "grant-session",
    sessionBearer: session.sessionBearer,
  });
  if (code.status !== "created") throw new Error("Expected Grant Code.");
  return {
    grantId: grant.grantId,
    qrCredential: grant.qrCredential,
    code: code.code,
    adminBearer: session.sessionBearer,
  };
}

function createOptions(
  keyRing: ReturnType<typeof createGrantTestKeyRing>,
  seed: number,
  configurationOrNowMs:
    | (() => number)
    | {
        resolve?: GrantAuthorityOptions["controlScopeResolver"]["resolve"];
        resolveSession?: GrantAuthorityOptions["controlScopeResolver"]["resolveSession"];
        resolveEventGameLock?: NonNullable<
          GrantAuthorityOptions["controlGrantLifecycle"]
        >["resolveEventGameLock"];
      } = {},
) {
  const nowMs = typeof configurationOrNowMs === "function" ? configurationOrNowMs : () => 1_000;
  const configuration = typeof configurationOrNowMs === "function" ? {} : configurationOrNowMs;
  return {
    environmentId: "test-environment",
    clock: { nowMs },
    randomness: createGrantTestRandomness(seed),
    keyRing,
    controlScopeResolver: {
      resolve:
        configuration.resolve ??
        (() => ({ status: "eligible" as const, eventGameId: "game-focused" })),
      ...(configuration.resolveSession === undefined
        ? {}
        : { resolveSession: configuration.resolveSession }),
    },
    controlGrantLifecycle:
      configuration.resolveEventGameLock === undefined
        ? undefined
        : { resolveEventGameLock: configuration.resolveEventGameLock },
    privilegedAuthorityVerifier: createGrantTestAuthorityVerifier(),
  };
}
