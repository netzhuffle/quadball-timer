import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCredentialToken, encryptCredential } from "@/lib/grant-crypto";
import { FOUNDATION_MIGRATIONS } from "@/lib/foundation-migrations";
import {
  createTypedGrantAuthority,
  type ControlGrantScope,
  type ControlGrantSessionResolution,
  type ControlGrantScopeResolution,
  type GrantKeyRing,
} from "@/lib/grant-authority";
import type { GrantAuthority } from "@/lib/grant-authority-types";
import {
  createGrantTestKeyRing,
  createGrantTestCurrentOnlyKeyRing,
  createGrantTestRandomness,
  createGrantTestRotatedKeyRing,
  createGrantTestScope,
  registerGrantAuthorityContract,
  type GrantAuthorityContractStorage,
} from "@/lib/grant-authority-contract";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import {
  createGrantTestAuthorityVerifier,
  createLegacyControlGrantTestAuthority,
} from "@/lib/grant-authority-test-support";
import {
  buildGrantAdmissionWorkerCommand,
  createGrantAdmissionWorkerEnvironment,
  superviseGrantAdmissionWorkers,
  writePrivateGrantCredential,
} from "@/lib/grant-concurrency-process";
import {
  installProbeSignalHandlers,
  spawnProbeCommand,
} from "@/lib/sqlite-foundation-probe-process";

describe("focused SQLite Grant authority boundary", () => {
  registerGrantAuthorityContract(test, createStorage);

  test("keeps migration-006 Grants authoritative and rotatable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-timer-grant-migration-authority-"));
    const databasePath = join(directory, "foundation.sqlite");
    const keyRing = createGrantTestKeyRing();
    const scope = createGrantTestScope();
    const grantId = "grant-migration-authority";
    const grantVersion = "grant-version-migration-authority";
    const randomness = createGrantTestRandomness(121);
    const binding = {
      environmentId: "test-environment",
      grantId,
      grantType: "control" as const,
      grantVersion,
      scope,
    };
    const token = createCredentialToken(binding, randomness);
    const credential = encryptCredential(token, binding, randomness, keyRing);
    const legacy = openSqliteFoundationStorage(databasePath, {
      migrations: FOUNDATION_MIGRATIONS.slice(0, 5),
    });
    try {
      await legacy.applyMigrations({ requireCandidate: false });
      legacy.close();

      const seed = new Database(databasePath);
      seed
        .query(
          `INSERT INTO foundation_grant_roots (
             grant_id, grant_type, grant_version, event_id, game_day_id, pitch_id, pitch_slot_id,
             status, created_at_ms, expires_at_ms, credential_format_version, credential_kind,
             encryption_key_version, lookup_key_version, credential_iv, credential_ciphertext,
             credential_tag, credential_lookup_digest, credential_fingerprint
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          grantId,
          "control",
          grantVersion,
          scope.eventId,
          scope.gameDayId,
          scope.pitchId,
          scope.pitchSlotId,
          "active",
          1_000,
          null,
          credential.formatVersion,
          credential.kind,
          credential.encryptionKeyVersion,
          credential.lookupKeyVersion,
          credential.iv,
          credential.ciphertext,
          credential.tag,
          credential.lookupDigest,
          credential.lookupDigest,
        );
      seed
        .query(
          `INSERT INTO foundation_grant_audit (
             audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
             event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
             event_game_id, credential_kind, credential_fingerprint, before_status, after_status,
             created_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "audit-migration-authority-created",
          "grant-created",
          "accepted",
          "actor-migration-authority",
          grantId,
          "control",
          grantVersion,
          scope.eventId,
          scope.gameDayId,
          scope.pitchId,
          scope.pitchSlotId,
          null,
          null,
          null,
          "qr",
          credential.lookupDigest,
          null,
          "active",
          1_000,
        );
      seed.close();

      const current = openSqliteFoundationStorage(databasePath);
      try {
        await current.applyMigrations({ requireCandidate: false });
        const authority = createAuthority(current, createGrantTestRandomness(122), keyRing);
        const beforeRotation = await current.transaction((transaction) => ({
          grant: transaction.findGrantById(grantId),
          audit: transaction.listGrantAudit(grantId),
        }));
        expect(beforeRotation.grant?.credential.fingerprint).toMatch(
          /^opaque-migration-reference-v1:[a-f0-9]{64}$/,
        );
        expect(beforeRotation.audit[0]?.credentialFingerprint).toBeNull();
        expect(await current.readiness()).toMatchObject({ ok: true, schemaVersion: "21" });

        const forged = new Database(databasePath);
        expect(() =>
          forged
            .query(
              `INSERT INTO foundation_grant_migration_provenance (
             grant_id, migration_id, original_status, original_grant_version, original_event_id,
             original_game_day_id, original_pitch_id, original_pitch_slot_id, original_created_at_ms,
                 original_expires_at_ms, retained_opaque_reference
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              grantId,
              "006-grant-cryptographic-erasure",
              "active",
              "forged-version",
              scope.eventId,
              scope.gameDayId,
              scope.pitchId,
              scope.pitchSlotId,
              1_000,
              null,
              `opaque-migration-reference-v1:${"f".repeat(64)}`,
            ),
        ).toThrow();
        forged
          .query("UPDATE foundation_grant_audit SET credential_fingerprint = ? WHERE grant_id = ?")
          .run("sensitive-forged-fingerprint", grantId);
        forged.close();
        expect(await current.readiness()).toMatchObject({ ok: false, status: "integrity-failure" });
        expect(
          await authority.createControlGrant({
            scope,
            actor: createActor(),
          }),
        ).toMatchObject({ status: "rejected", reason: "unavailable" });

        const repaired = new Database(databasePath);
        repaired
          .query(
            "UPDATE foundation_grant_audit SET credential_fingerprint = NULL WHERE grant_id = ?",
          )
          .run(grantId);
        repaired.close();
        expect(await current.readiness()).toMatchObject({ ok: true });
        expect(
          await authority.rotateControlGrantCredentialKeys(grantId, createActor()),
        ).toMatchObject({ status: "rotated" });
        const afterRotation = await current.transaction((transaction) => ({
          grant: transaction.findGrantById(grantId),
          audit: transaction.listGrantAudit(grantId),
        }));
        expect(afterRotation.grant?.credential.fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(afterRotation.grant?.credential.fingerprint).not.toMatch(
          /^opaque-migration-reference-v1:/,
        );
        expect(
          afterRotation.audit.filter((entry) => entry.action === "credential-rotated"),
        ).toEqual([
          expect.objectContaining({
            credentialFingerprint: afterRotation.grant?.credential.fingerprint,
          }),
        ]);
        expect(await current.readiness()).toMatchObject({ ok: true });

        const deleted = new Database(databasePath);
        deleted
          .query("DELETE FROM foundation_grant_audit WHERE audit_id = ?")
          .run("audit-migration-authority-created");
        deleted.close();
        expect(await current.readiness()).toMatchObject({ ok: false, status: "integrity-failure" });
        expect(
          await authority.createControlGrant({
            scope,
            actor: createActor(),
          }),
        ).toMatchObject({ status: "rejected", reason: "unavailable" });
      } finally {
        current.close();
      }
    } finally {
      legacy.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("freezes SQLite after previous Event Game audit provenance tampering", async () => {
    const handle = await createStorage();
    let relationship: ControlGrantSessionResolution = {
      status: "current",
      eventGameId: "game-1",
    };
    const authority = createAuthority(
      handle.storage,
      createGrantTestRandomness(201),
      createGrantTestKeyRing(),
      () => 1_000,
      () => relationship,
    );
    try {
      const created = await createGrant(authority);
      const admitted = await admit(authority, created.qrCredential, "tamper-switch");
      relationship = {
        status: "switchable",
        previousEventGameId: "game-1",
        currentEventGameId: "game-2",
      };
      expect(await authority.acceptControlGrantSessionSwitch(admitted)).toMatchObject({
        status: "switched",
      });
      relationship = {
        status: "switchable",
        previousEventGameId: "game-2",
        currentEventGameId: "game-3",
      };
      expect(await authority.acceptControlGrantSessionSwitch(admitted)).toMatchObject({
        status: "switched",
      });
      const restarted = openSqliteFoundationStorage(handle.databasePath, {
        grantKeyRing: createGrantTestKeyRing(),
      });
      expect(await restarted.readiness()).toMatchObject({ ok: true, schemaVersion: "21" });
      restarted.close();
      const database = new Database(handle.databasePath);
      database
        .query(
          "UPDATE foundation_grant_audit SET previous_event_game_id = ? WHERE action = 'session-switched' AND event_game_id = ?",
        )
        .run("game-3", "game-2");
      database.close();
      expect(await handle.storage.readiness()).toMatchObject({
        ok: false,
        status: "integrity-failure",
      });
      expect(
        await authority.createControlGrant({
          scope: createGrantTestScope(),
          actor: createActor(),
        }),
      ).toMatchObject({ status: "rejected", reason: "unavailable" });
    } finally {
      await handle.cleanup();
    }
  });

  test("freezes restarted SQLite after external Grant Session Event Game mutation", async () => {
    const handle = await createStorage();
    const keyRing = createGrantTestKeyRing();
    const authority = createAuthority(handle.storage, createGrantTestRandomness(203), keyRing);
    try {
      const created = await createGrant(authority);
      const admitted = await admit(authority, created.qrCredential, "external-game-tamper");
      const gameTamperDatabase = new Database(handle.databasePath);
      gameTamperDatabase
        .query("UPDATE foundation_grant_sessions SET event_game_id = ? WHERE session_id = ?")
        .run("game-forged", admitted.grantSessionId);
      gameTamperDatabase.close();

      const restarted = openSqliteFoundationStorage(handle.databasePath, { grantKeyRing: keyRing });
      try {
        expect(await restarted.readiness()).toMatchObject({
          ok: false,
          status: "integrity-failure",
        });
        const restartedAuthority = createAuthority(
          restarted,
          createGrantTestRandomness(204),
          keyRing,
        );
        expect(
          await restartedAuthority.createControlGrant({
            scope: createGrantTestScope(),
            actor: createActor(),
          }),
        ).toMatchObject({ status: "rejected", reason: "unavailable" });
      } finally {
        restarted.close();
      }
    } finally {
      await handle.cleanup();
    }
  });

  test("rejects replay self-links and active origins across SQLite restart validation", async () => {
    const handle = await createStorage();
    const keyRing = createGrantTestKeyRing();
    const options = {
      environmentId: "test-environment",
      clock: { nowMs: () => 1_000 },
      randomness: createGrantTestRandomness(205),
      keyRing,
      privilegedAuthorityVerifier: createGrantTestAuthorityVerifier(),
      controlScopeResolver: {
        resolve: () => ({ status: "eligible" as const, eventGameId: "game-1" }),
        resolveReplay: (
          _scope: ControlGrantScope,
          eventGameId: string,
          replayEvidenceId: string,
        ) =>
          eventGameId === "game-1" && replayEvidenceId === "replay-sqlite"
            ? { status: "eligible" as const, eventGameId: "game-1" }
            : { status: "mismatch" as const },
      },
    };
    const authority = createLegacyControlGrantTestAuthority(handle.storage, options);
    try {
      const created = await createGrant(authority);
      const origin = await admit(authority, created.qrCredential, "sqlite-origin");
      const replacement = await admit(authority, created.qrCredential, "sqlite-replacement");
      expect(
        await authority.authorizeControlGrantReplay({
          sessionBearer: replacement.sessionBearer,
          originatingSessionId: replacement.grantSessionId,
          eventGameId: "game-1",
          replayEvidenceId: "replay-sqlite",
        }),
      ).toMatchObject({ status: "rejected" });
      expect(
        await authority.authorizeControlGrantReplay({
          sessionBearer: replacement.sessionBearer,
          originatingSessionId: origin.grantSessionId,
          eventGameId: "game-1",
          replayEvidenceId: "replay-sqlite",
        }),
      ).toMatchObject({ status: "rejected" });
      const originReplacement = await admit(authority, created.qrCredential, "sqlite-origin");
      expect(
        await authority.authorizeControlGrantReplay({
          sessionBearer: replacement.sessionBearer,
          originatingSessionId: origin.grantSessionId,
          eventGameId: "game-1",
          replayEvidenceId: "replay-sqlite",
        }),
      ).toMatchObject({ status: "authorized" });

      const readyRestart = openSqliteFoundationStorage(handle.databasePath, {
        grantKeyRing: keyRing,
      });
      expect(await readyRestart.readiness()).toMatchObject({ ok: true, schemaVersion: "21" });
      readyRestart.close();

      const selfLinkDatabase = new Database(handle.databasePath);
      selfLinkDatabase
        .query(
          "UPDATE foundation_grant_audit SET replaced_session_id = session_id WHERE action = 'replay-authorized'",
        )
        .run();
      selfLinkDatabase.close();
      const selfLinkedRestart = openSqliteFoundationStorage(handle.databasePath, {
        grantKeyRing: keyRing,
      });
      expect(await selfLinkedRestart.readiness()).toMatchObject({
        ok: false,
        status: "integrity-failure",
      });
      selfLinkedRestart.close();

      const repairedDatabase = new Database(handle.databasePath);
      repairedDatabase
        .query(
          "UPDATE foundation_grant_audit SET replaced_session_id = ? WHERE action = 'replay-authorized'",
        )
        .run(origin.grantSessionId);
      repairedDatabase.close();
      const repairedRestart = openSqliteFoundationStorage(handle.databasePath, {
        grantKeyRing: keyRing,
      });
      expect(await repairedRestart.readiness()).toMatchObject({ ok: true, schemaVersion: "21" });
      repairedRestart.close();

      const activeOriginDatabase = new Database(handle.databasePath);
      activeOriginDatabase
        .query(
          "UPDATE foundation_grant_sessions SET status = 'revoked', revoked_at_ms = ? WHERE session_id = ?",
        )
        .run(2_000, originReplacement.grantSessionId);
      activeOriginDatabase
        .query(
          "UPDATE foundation_grant_sessions SET status = 'active', revoked_at_ms = NULL WHERE session_id = ?",
        )
        .run(origin.grantSessionId);
      activeOriginDatabase.close();

      const rejectedRestart = openSqliteFoundationStorage(handle.databasePath, {
        grantKeyRing: keyRing,
      });
      try {
        expect(await rejectedRestart.readiness()).toMatchObject({
          ok: false,
          status: "integrity-failure",
        });
      } finally {
        rejectedRestart.close();
      }
    } finally {
      await handle.cleanup();
    }
  });

  test("freezes SQLite after an external writer inserts forged audit evidence", async () => {
    const handle = await createStorage();
    const keyRing = createGrantTestKeyRing();
    const authority = createAuthority(handle.storage, createGrantTestRandomness(125), keyRing);
    try {
      const created = await createGrant(authority);
      const database = new Database(handle.databasePath);
      database
        .query(
          `INSERT INTO foundation_grant_audit (
             audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
             event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
             event_game_id, credential_kind, credential_fingerprint, before_status, after_status,
             before_expires_at_ms, after_expires_at_ms, terminal_reason, audit_integrity_tag,
             created_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "audit-forged-external",
          "credential-revealed",
          "accepted",
          "actor-forged-external",
          created.grantId,
          "control",
          created.grantVersion,
          created.scope.eventId,
          created.scope.gameDayId,
          created.scope.pitchId,
          created.scope.pitchSlotId,
          null,
          null,
          null,
          "qr",
          null,
          "active",
          "active",
          null,
          null,
          null,
          `hmac-sha256-v1:audit-v1:${"A".repeat(43)}`,
          2_000,
        );
      database.close();
      expect(await handle.storage.readiness()).toMatchObject({
        ok: false,
        status: "integrity-failure",
      });
      expect(
        await authority.createControlGrant({ scope: createGrantTestScope(), actor: createActor() }),
      ).toMatchObject({ status: "rejected", reason: "unavailable" });
    } finally {
      await handle.cleanup();
    }
  });

  test("upgrades an already-complete schema-006 database through current readiness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-timer-grant-schema-006-upgrade-"));
    const databasePath = join(directory, "foundation.sqlite");
    const keyRing = createGrantTestKeyRing();
    const scope = createGrantTestScope();
    const grantId = "grant-schema-006-upgrade";
    const grantVersion = "grant-version-schema-006-upgrade";
    const binding = {
      environmentId: "test-environment",
      grantId,
      grantType: "control" as const,
      grantVersion,
      scope,
    };
    const credential = encryptCredential(
      createCredentialToken(binding, createGrantTestRandomness(123)),
      binding,
      createGrantTestRandomness(124),
      keyRing,
    );
    const legacy = openSqliteFoundationStorage(databasePath, {
      migrations: FOUNDATION_MIGRATIONS.slice(0, 5),
    });
    try {
      await legacy.applyMigrations({ requireCandidate: false });
      legacy.close();
      const seed = new Database(databasePath);
      seed
        .query(
          `INSERT INTO foundation_grant_roots (
             grant_id, grant_type, grant_version, event_id, game_day_id, pitch_id, pitch_slot_id,
             status, created_at_ms, expires_at_ms, credential_format_version, credential_kind,
             encryption_key_version, lookup_key_version, credential_iv,
             credential_ciphertext, credential_tag, credential_lookup_digest, credential_fingerprint
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          grantId,
          "control",
          grantVersion,
          scope.eventId,
          scope.gameDayId,
          scope.pitchId,
          scope.pitchSlotId,
          "active",
          1_000,
          4_102_444_800_000,
          credential.formatVersion,
          credential.kind,
          credential.encryptionKeyVersion,
          credential.lookupKeyVersion,
          credential.iv,
          credential.ciphertext,
          credential.tag,
          credential.lookupDigest,
          credential.lookupDigest,
        );
      seed
        .query(
          `INSERT INTO foundation_grant_audit (
             audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
             event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
             event_game_id, credential_kind, credential_fingerprint, before_status, after_status,
             created_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "audit-schema-006-created",
          "grant-created",
          "accepted",
          "actor-schema-006",
          grantId,
          "control",
          grantVersion,
          scope.eventId,
          scope.gameDayId,
          scope.pitchId,
          scope.pitchSlotId,
          null,
          null,
          null,
          "qr",
          null,
          null,
          "active",
          1_000,
        );
      seed.close();

      const acceptedSchema006 = openSqliteFoundationStorage(databasePath, {
        migrations: FOUNDATION_MIGRATIONS.slice(0, 6),
      });
      await acceptedSchema006.applyMigrations({ requireCandidate: false });
      acceptedSchema006.close();
      const preIntegritySchema = new Database(databasePath);
      expect(
        preIntegritySchema
          .query(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'foundation_grant_migration_006_evidence'",
          )
          .get(),
      ).toBeNull();
      preIntegritySchema.close();

      const corruptedDatabasePath = join(directory, "corrupted-pre-011.sqlite");
      await Bun.write(corruptedDatabasePath, await Bun.file(databasePath).arrayBuffer());
      const corruptedSeed = new Database(corruptedDatabasePath);
      corruptedSeed
        .query("UPDATE foundation_grant_roots SET grant_version = ? WHERE grant_id = ?")
        .run("corrupted-pre-011-version", grantId);
      corruptedSeed.close();
      const corrupted = openSqliteFoundationStorage(corruptedDatabasePath);
      await corrupted.applyMigrations({ requireCandidate: false });
      expect(await corrupted.readiness()).toMatchObject({
        ok: false,
        status: "integrity-failure",
      });
      corrupted.close();

      const current = openSqliteFoundationStorage(databasePath);
      let currentClosed = false;
      try {
        const report = await current.applyMigrations({ requireCandidate: false });
        expect(report.schemaVersion).toBe(21);
        expect(report.appliedMigrationIds).toEqual([
          "007-anchor-control-action-audit-versions",
          "008-anchor-current-evidence-format",
          "009-immutable-control-evidence-provenance",
          "010-typed-grant-storage",
          "011-persist-session-summary-labels",
          "012-terminal-grant-session-audit",
          "013-grant-audit-evidence-fields",
          "014-grant-provenance-integrity",
          "015-control-session-binding",
          "016-replay-content-provenance",
          "017-composed-acceptance-state",
          "018-acceptance-integrity-history",
          "019-event-catalog",
          "020-grant-codes-and-admission-telemetry",
          "021-grant-code-game-lock-erasure-evidence",
        ]);
        expect(await current.readiness()).toMatchObject({
          ok: true,
          schemaVersion: "21",
        });
        const migrated = await current.transaction((transaction) => ({
          grant: transaction.findGrantById(grantId),
          audit: transaction.listGrantAudit(grantId),
        }));
        expect(migrated.grant?.credential.fingerprint).toMatch(
          /^opaque-migration-reference-v1:[a-f0-9]{64}$/,
        );
        expect(migrated.audit[0]?.credentialFingerprint).toBeNull();
        const tamper = new Database(databasePath);
        tamper
          .query("UPDATE foundation_grant_roots SET expires_at_ms = ? WHERE grant_id = ?")
          .run(4_102_444_800_001, grantId);
        expect(await current.readiness()).toMatchObject({
          ok: false,
          status: "integrity-failure",
        });
        tamper
          .query("UPDATE foundation_grant_roots SET expires_at_ms = NULL WHERE grant_id = ?")
          .run(grantId);
        expect(await current.readiness()).toMatchObject({
          ok: false,
          status: "integrity-failure",
        });
        tamper
          .query("UPDATE foundation_grant_roots SET expires_at_ms = ? WHERE grant_id = ?")
          .run(4_102_444_800_000, grantId);
        tamper.close();
        expect(await current.readiness()).toMatchObject({ ok: true });

        const authority = createAuthority(current, createGrantTestRandomness(126), keyRing);
        expect(
          await authority.rotateControlGrantCredentialKeys(grantId, createActor()),
        ).toMatchObject({ status: "rotated" });
        const keyedAudit = new Database(databasePath);
        expect(
          keyedAudit
            .query(
              "SELECT audit_integrity_tag FROM foundation_grant_audit WHERE action = 'credential-rotated'",
            )
            .get(),
        ).toMatchObject({ audit_integrity_tag: expect.stringMatching(/^hmac-sha256-v1:/) });
        keyedAudit.close();
        current.close();
        currentClosed = true;

        const restarted = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
        try {
          expect(await restarted.readiness()).toMatchObject({ ok: true, schemaVersion: "21" });
          const restartedAudit = await restarted.transaction((transaction) =>
            transaction.listGrantAudit(grantId),
          );
          expect(restartedAudit.some((entry) => entry.action === "credential-rotated")).toBe(true);
        } finally {
          restarted.close();
        }
      } finally {
        if (!currentClosed) current.close();
      }
    } finally {
      legacy.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects repeated Grant lifecycle and session transitions without mutation", async () => {
    const handle = await createStorage();
    let nowMs = Date.parse("2026-03-20T12:00:00Z");
    const authority = createTypedGrantAuthority(handle.storage, {
      environmentId: "test-environment",
      clock: { nowMs: () => nowMs },
      randomness: createGrantTestRandomness(95),
      keyRing: createGrantTestKeyRing(),
      privilegedAuthorityVerifier: createGrantTestAuthorityVerifier(),
      controlScopeResolver: { resolve: () => ({ status: "eligible", eventGameId: "game-1" }) },
    });
    const eventAuthority = { kind: "grant-session" as const, sessionBearer: "" };
    try {
      const eventAdmin = await authority.createEventAdminGrant({
        authority: { kind: "technical-admin", id: "technical-admin-fixture" },
        scope: {
          eventId: "event-repeat",
          eventTimeZone: "UTC",
          finalGameDayDate: "2026-03-20",
        },
      });
      if (eventAdmin.status !== "created") throw new Error("Expected Event Admin Grant.");
      const admitted = await authority.admitGrant({
        qrCredential: eventAdmin.qrCredential,
        browserContext: "repeat-manager",
      });
      if (admitted.status !== "admitted") throw new Error("Expected Event Admin Session.");
      eventAuthority.sessionBearer = admitted.sessionBearer;
      const control = await authority.createControlGrant({
        authority: eventAuthority,
        scope: {
          eventId: "event-repeat",
          gameDayId: "day-1",
          pitchId: "pitch-1",
          pitchSlotId: "slot-repeat",
        },
      });
      if (control.status !== "created") throw new Error("Expected Control Grant.");

      expect(await authority.disableGrant(control.grantId, eventAuthority)).toMatchObject({
        status: "updated",
      });
      const afterDisable = await handle.storage.transaction((transaction) => ({
        grant: transaction.findGrantById(control.grantId),
        audit: transaction.listGrantAudit(control.grantId),
      }));
      expect(await authority.disableGrant(control.grantId, eventAuthority)).toMatchObject({
        status: "rejected",
        reason: "invalid-state",
      });
      expect(
        await handle.storage.transaction((transaction) => ({
          grant: transaction.findGrantById(control.grantId),
          audit: transaction.listGrantAudit(control.grantId),
        })),
      ).toEqual(afterDisable);

      expect(await authority.revokeGrant(control.grantId, eventAuthority)).toMatchObject({
        status: "updated",
      });
      const afterRevoke = await handle.storage.transaction((transaction) => ({
        grant: transaction.findGrantById(control.grantId),
        audit: transaction.listGrantAudit(control.grantId),
      }));
      expect(await authority.revokeGrant(control.grantId, eventAuthority)).toMatchObject({
        status: "rejected",
        reason: "invalid-state",
      });
      expect(
        await handle.storage.transaction((transaction) => ({
          grant: transaction.findGrantById(control.grantId),
          audit: transaction.listGrantAudit(control.grantId),
        })),
      ).toEqual(afterRevoke);

      expect(await authority.reactivateGrant(control.grantId, eventAuthority)).toMatchObject({
        status: "updated",
      });
      const afterReactivate = await handle.storage.transaction((transaction) => ({
        grant: transaction.findGrantById(control.grantId),
        audit: transaction.listGrantAudit(control.grantId),
      }));
      expect(await authority.reactivateGrant(control.grantId, eventAuthority)).toMatchObject({
        status: "rejected",
        reason: "invalid-state",
      });
      expect(
        await handle.storage.transaction((transaction) => ({
          grant: transaction.findGrantById(control.grantId),
          audit: transaction.listGrantAudit(control.grantId),
        })),
      ).toEqual(afterReactivate);

      const revealed = await authority.revealGrant(control.grantId, eventAuthority);
      if (revealed.status !== "revealed") throw new Error("Expected reactivated credential.");
      const controlSession = await authority.admitGrant({
        qrCredential: revealed.qrCredential,
        browserContext: "repeat-control",
      });
      if (controlSession.status !== "admitted") throw new Error("Expected Control Session.");
      const summaries = await authority.listGrantSessions(control.grantId, eventAuthority);
      if (summaries.status !== "ok") throw new Error("Expected session summaries.");
      const label = summaries.value.find((summary) => summary.status === "active")?.label;
      if (label === undefined) throw new Error("Expected active session label.");
      expect(
        await authority.revokeGrantSession(control.grantId, label, eventAuthority),
      ).toMatchObject({
        status: "updated",
      });
      const afterSessionRevoke = await handle.storage.transaction((transaction) =>
        transaction.listGrantAudit(control.grantId),
      );
      expect(
        await authority.revokeGrantSession(control.grantId, label, eventAuthority),
      ).toMatchObject({
        status: "rejected",
        reason: "invalid-state",
      });
      expect(
        await handle.storage.transaction((transaction) =>
          transaction.listGrantAudit(control.grantId),
        ),
      ).toEqual(afterSessionRevoke);
    } finally {
      await handle.cleanup();
    }
  });

  test("fails readiness and freezes writes for authenticated current credential tampering", async () => {
    for (const column of [
      "credential_ciphertext",
      "credential_tag",
      "credential_lookup_digest",
      "credential_fingerprint",
    ] as const) {
      const handle = await createStorage();
      const options = {
        environmentId: "test-environment",
        clock: { nowMs: () => Date.parse("2026-03-20T12:00:00Z") },
        randomness: createGrantTestRandomness(96),
        keyRing: createGrantTestKeyRing(),
        privilegedAuthorityVerifier: createGrantTestAuthorityVerifier(),
        controlScopeResolver: {
          resolve: () => ({ status: "eligible" as const, eventGameId: "game-1" }),
        },
      };
      try {
        const authority = createTypedGrantAuthority(handle.storage, options);
        const eventAdmin = await authority.createEventAdminGrant({
          authority: { kind: "technical-admin", id: "technical-admin-fixture" },
          scope: {
            eventId: "event-authenticated-tamper",
            eventTimeZone: "UTC",
            finalGameDayDate: "2026-03-20",
          },
        });
        if (eventAdmin.status !== "created") throw new Error("Expected Event Admin Grant.");
        const session = await authority.admitGrant({
          qrCredential: eventAdmin.qrCredential,
          browserContext: "authenticated-tamper-manager",
        });
        if (session.status !== "admitted") throw new Error("Expected Event Admin Session.");
        const created = await authority.createControlGrant({
          authority: { kind: "grant-session", sessionBearer: session.sessionBearer },
          scope: {
            eventId: "event-authenticated-tamper",
            gameDayId: "day-1",
            pitchId: "pitch-1",
            pitchSlotId: `slot-${column}`,
          },
        });
        if (created.status !== "created") throw new Error("Expected Control Grant.");
        const database = new Database(handle.databasePath);
        try {
          const row = database
            .query(`SELECT ${column} AS value FROM foundation_grant_roots WHERE grant_id = ?`)
            .get(created.grantId) as { value: string };
          database
            .query(`UPDATE foundation_grant_roots SET ${column} = ? WHERE grant_id = ?`)
            .run(flipBase64Url(row.value), created.grantId);
        } finally {
          database.close();
        }
        expect(await handle.storage.readiness()).toMatchObject({
          ok: false,
          status: "integrity-failure",
        });
        expect(
          await authority.createControlGrant({
            authority: { kind: "technical-admin", id: "technical-admin-fixture" },
            scope: {
              eventId: "event-authenticated-tamper",
              gameDayId: "day-2",
              pitchId: "pitch-2",
              pitchSlotId: `unrelated-${column}`,
            },
          }),
        ).toMatchObject({ status: "rejected", reason: "unavailable" });
        handle.storage.close();
        const reopened = openSqliteFoundationStorage(handle.databasePath);
        try {
          const reopenedAuthority = createTypedGrantAuthority(reopened, options);
          expect(await reopened.readiness()).toMatchObject({
            ok: false,
            status: "integrity-failure",
          });
          expect(
            await reopenedAuthority.createControlGrant({
              authority: { kind: "technical-admin", id: "technical-admin-fixture" },
              scope: {
                eventId: "event-authenticated-tamper",
                gameDayId: "day-3",
                pitchId: "pitch-3",
                pitchSlotId: `restart-${column}`,
              },
            }),
          ).toMatchObject({ status: "rejected", reason: "unavailable" });
        } finally {
          reopened.close();
        }
      } finally {
        await handle.cleanup();
      }
    }
  });

  test("persists typed Event Admin and Pitch Manager Grants through the SQLite adapter", async () => {
    const handle = await createStorage();
    let nowMs = Date.parse("2026-03-20T12:00:00Z");
    const authority = createTypedGrantAuthority(handle.storage, {
      environmentId: "test-environment",
      clock: { nowMs: () => nowMs },
      randomness: createGrantTestRandomness(90),
      keyRing: createGrantTestKeyRing(),
      privilegedAuthorityVerifier: createGrantTestAuthorityVerifier(),
      controlScopeResolver: { resolve: () => ({ status: "eligible", eventGameId: "game-1" }) },
    });
    try {
      const eventAdmin = await authority.createEventAdminGrant({
        authority: { kind: "technical-admin", id: "technical-admin-fixture" },
        scope: {
          eventId: "event-typed",
          eventTimeZone: "Europe/Zurich",
          finalGameDayDate: "2026-03-20",
        },
      });
      expect(eventAdmin).toMatchObject({ status: "created", grantType: "event-admin" });
      if (eventAdmin.status !== "created") throw new Error("Expected a typed Grant.");
      const session = await authority.admitGrant({
        qrCredential: eventAdmin.qrCredential,
        browserContext: "typed-admin",
      });
      expect(session).toMatchObject({ status: "admitted", grantType: "event-admin" });
      const audit = await authority.listGrantAudit(eventAdmin.grantId, {
        kind: "technical-admin",
        id: "technical-admin-fixture",
      });
      expect(audit).toMatchObject({ status: "ok" });
      expect(JSON.stringify(audit)).not.toContain(eventAdmin.qrCredential);
      nowMs = eventAdmin.expiresAtMs ?? nowMs;
      expect(
        await authority.admitGrant({
          qrCredential: eventAdmin.qrCredential,
          browserContext: "after-expiry",
        }),
      ).toMatchObject({ status: "rejected" });
    } finally {
      await handle.cleanup();
    }
  });

  test("fails closed when a legacy Control row contains a crafted typed-scope prefix", async () => {
    const handle = await createStorage();
    try {
      const authority = createAuthority(handle.storage, createGrantTestRandomness(91));
      const created = await createGrant(authority);
      const encoded = Buffer.from(
        JSON.stringify({
          grantType: "event-admin",
          scope: { eventId: "event-forged", eventTimeZone: "UTC", finalGameDayDate: "2026-03-20" },
        }),
        "utf8",
      ).toString("base64url");
      const database = new Database(handle.databasePath);
      database
        .query("UPDATE foundation_grant_roots SET event_id = ? WHERE grant_id = ?")
        .run(`typed-grant-v1:${encoded}`, created.grantId);
      database.close();
      expect(await authority.revealControlGrant(created.grantId, createActor())).toMatchObject({
        status: "rejected",
        reason: "unavailable",
      });
      handle.storage.close();
      const reopened = openSqliteFoundationStorage(handle.databasePath);
      try {
        const reopenedAuthority = createAuthority(reopened, createGrantTestRandomness(92));
        expect(
          await reopenedAuthority.revealControlGrant(created.grantId, createActor()),
        ).toMatchObject({
          status: "rejected",
          reason: "unavailable",
        });
      } finally {
        reopened.close();
      }
    } finally {
      await handle.cleanup();
    }
  });

  test("restarts with rebound metadata credentials and stable rotated session references", async () => {
    const handle = await createStorage();
    const keyRing = createGrantTestKeyRing();
    const options = {
      environmentId: "test-environment",
      clock: { nowMs: () => Date.parse("2026-03-20T12:00:00Z") },
      randomness: createGrantTestRandomness(93),
      keyRing,
      privilegedAuthorityVerifier: createGrantTestAuthorityVerifier(),
      controlScopeResolver: {
        resolve: () => ({ status: "eligible" as const, eventGameId: "game-1" }),
      },
    };
    try {
      const authority = createTypedGrantAuthority(handle.storage, options);
      const eventAdmin = await authority.createEventAdminGrant({
        authority: { kind: "technical-admin", id: "technical-admin-fixture" },
        scope: {
          eventId: "event-rebound",
          eventTimeZone: "UTC",
          finalGameDayDate: "2026-03-25",
        },
      });
      if (eventAdmin.status !== "created") throw new Error("Expected Event Admin Grant.");
      const first = await authority.admitGrant({
        qrCredential: eventAdmin.qrCredential,
        browserContext: "rebound-first",
      });
      const second = await authority.admitGrant({
        qrCredential: eventAdmin.qrCredential,
        browserContext: "rebound-second",
      });
      if (first.status !== "admitted" || second.status !== "admitted")
        throw new Error("Expected Event Admin Sessions.");
      const pitch = await authority.createPitchManagerGrant({
        authority: { kind: "grant-session", sessionBearer: first.sessionBearer },
        scope: {
          eventId: "event-rebound",
          gameDayId: "day-1",
          gameDayDate: "2026-03-21",
          eventTimeZone: "UTC",
          pitchId: "pitch-1",
        },
      });
      if (pitch.status !== "created") throw new Error("Expected Pitch Manager Grant.");
      const corrected = await authority.recalculateGrantExpiry(
        pitch.grantId,
        { gameDayDate: "2026-03-23" },
        { kind: "grant-session", sessionBearer: first.sessionBearer },
      );
      expect(corrected).toMatchObject({ status: "updated" });
      if (corrected.status !== "updated") throw new Error("Expected metadata correction.");
      const revealed = await authority.revealGrant(pitch.grantId, {
        kind: "grant-session",
        sessionBearer: first.sessionBearer,
      });
      if (revealed.status !== "revealed") throw new Error("Expected rebound credential.");
      const before = await authority.listGrantSessions(eventAdmin.grantId, {
        kind: "technical-admin",
        id: "technical-admin-fixture",
      });
      if (before.status !== "ok") throw new Error("Expected session summaries.");
      const secondLabel = before.value[1]?.label;
      if (secondLabel === undefined) throw new Error("Expected second session label.");
      handle.storage.close();

      const reopened = openSqliteFoundationStorage(handle.databasePath, {
        grantKeyRing: options.keyRing,
      });
      try {
        expect(await reopened.readiness()).toMatchObject({ ok: true, schemaVersion: "21" });
        const rotated = createTypedGrantAuthority(reopened, {
          ...options,
          keyRing: createGrantTestRotatedKeyRing(keyRing),
        });
        expect(
          await rotated.admitGrant({
            qrCredential: pitch.qrCredential,
            browserContext: "stale-after-restart",
          }),
        ).toMatchObject({ status: "rejected" });
        expect(
          await rotated.admitGrant({
            qrCredential: revealed.qrCredential,
            browserContext: "fresh-after-restart",
          }),
        ).toMatchObject({ status: "admitted", grantVersion: corrected.grantVersion });
        const after = await rotated.listGrantSessions(eventAdmin.grantId, {
          kind: "technical-admin",
          id: "technical-admin-fixture",
        });
        if (after.status !== "ok") throw new Error("Expected restarted session summaries.");
        expect(after.value.map(({ label }) => label)).toEqual(
          before.value.map(({ label }) => label),
        );
        expect(
          await rotated.revokeGrantSession(eventAdmin.grantId, secondLabel, {
            kind: "technical-admin",
            id: "technical-admin-fixture",
          }),
        ).toMatchObject({ status: "updated" });
      } finally {
        reopened.close();
      }
    } finally {
      await handle.cleanup();
    }
  });

  test("persists typed terminal reasons and fails closed on corrupted terminal evidence", async () => {
    const handle = await createStorage();
    let resolution: ControlGrantScopeResolution = { status: "eligible", eventGameId: "game-1" };
    const options = {
      environmentId: "test-environment",
      clock: { nowMs: () => Date.parse("2026-03-20T12:00:00Z") },
      randomness: createGrantTestRandomness(94),
      keyRing: createGrantTestKeyRing(),
      privilegedAuthorityVerifier: createGrantTestAuthorityVerifier(),
      controlScopeResolver: { resolve: () => resolution },
    };
    try {
      const authority = createTypedGrantAuthority(handle.storage, options);
      const eventAdmin = await authority.createEventAdminGrant({
        authority: { kind: "technical-admin", id: "technical-admin-fixture" },
        scope: {
          eventId: "event-terminal",
          eventTimeZone: "UTC",
          finalGameDayDate: "2026-03-20",
        },
      });
      expect(eventAdmin.status).toBe("created");
      if (eventAdmin.status !== "created") throw new Error("Expected Event Admin Grant.");
      const eventSession = await authority.admitGrant({
        qrCredential: eventAdmin.qrCredential,
        browserContext: "terminal-admin",
      });
      expect(eventSession.status).toBe("admitted");
      if (eventSession.status !== "admitted") throw new Error("Expected Event Admin Session.");
      const control = await authority.createControlGrant({
        authority: { kind: "grant-session", sessionBearer: eventSession.sessionBearer },
        scope: {
          eventId: "event-terminal",
          gameDayId: "day-1",
          pitchId: "pitch-1",
          pitchSlotId: "slot-1",
        },
      });
      expect(control.status).toBe("created");
      if (control.status !== "created") throw new Error("Expected Control Grant.");
      const first = await authority.admitGrant({
        qrCredential: control.qrCredential,
        browserContext: "terminal-a",
      });
      const second = await authority.admitGrant({
        qrCredential: control.qrCredential,
        browserContext: "terminal-b",
      });
      expect(first.status).toBe("admitted");
      expect(second.status).toBe("admitted");
      if (first.status !== "admitted" || second.status !== "admitted")
        throw new Error("Expected Control Sessions.");

      resolution = { status: "terminal", reason: "game-locked", eventGameId: "game-1" };
      expect(
        await authority.authorizeGrant({
          sessionBearer: first.sessionBearer,
          eventGameId: "game-1",
        }),
      ).toMatchObject({
        status: "rejected",
      });
      const sessions = await authority.listGrantSessions(control.grantId, {
        kind: "technical-admin",
        id: "technical-admin-fixture",
      });
      expect(sessions).toMatchObject({ status: "ok" });
      if (sessions.status !== "ok") throw new Error("Expected terminal session evidence.");
      expect(sessions.value.filter((session) => session.status === "active")).toHaveLength(0);
      const audit = await authority.listGrantAudit(control.grantId, {
        kind: "technical-admin",
        id: "technical-admin-fixture",
      });
      expect(audit).toMatchObject({ status: "ok" });
      if (audit.status !== "ok") throw new Error("Expected terminal audit evidence.");
      const terminal = audit.value.filter((entry) => entry.action === "session-terminated");
      expect(terminal).toHaveLength(2);
      expect(terminal).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ terminalReason: "game-locked" }),
          expect.objectContaining({ terminalReason: "game-locked" }),
        ]),
      );
      handle.storage.close();

      const reopened = openSqliteFoundationStorage(handle.databasePath, {
        grantKeyRing: options.keyRing,
      });
      try {
        expect(await reopened.readiness()).toMatchObject({ ok: true, schemaVersion: "21" });
        const reopenedAuthority = createTypedGrantAuthority(reopened, options);
        const reopenedAudit = await reopenedAuthority.listGrantAudit(control.grantId, {
          kind: "technical-admin",
          id: "technical-admin-fixture",
        });
        expect(reopenedAudit).toMatchObject({ status: "ok" });
        const database = new Database(handle.databasePath);
        database
          .query(
            "UPDATE foundation_grant_audit SET terminal_reason = NULL WHERE action = 'session-terminated'",
          )
          .run();
        database.close();
        expect(
          await reopenedAuthority.listGrantAudit(control.grantId, {
            kind: "technical-admin",
            id: "technical-admin-fixture",
          }),
        ).toEqual({
          status: "unavailable",
          code: "grant-storage-unavailable",
          message: "Grant authority storage is temporarily unavailable.",
        });
      } finally {
        reopened.close();
      }
    } finally {
      await handle.cleanup();
    }
  });

  test("redacts credentials from SQLite and preserves lifecycle across restart", async () => {
    const handle = await createStorage();
    const databasePath = handle.databasePath;
    const first = handle.storage;
    try {
      const authority = createAuthority(first, createGrantTestRandomness());
      const created = await createGrant(authority);
      const admitted = await admit(authority, created.qrCredential, "browser-a");
      assertSQLiteSecretsAreRedacted(databasePath, created.qrCredential, admitted.sessionBearer);
      first.close();

      const reopened = openSqliteFoundationStorage(databasePath);
      try {
        const reopenedAuthority = createAuthority(reopened, createGrantTestRandomness());
        expect(
          await reopenedAuthority.revealControlGrant(created.grantId, createActor()),
        ).toMatchObject({ status: "revealed", grantId: created.grantId });
        const readmitted = await admit(reopenedAuthority, created.qrCredential, "browser-b");
        expect(
          await reopenedAuthority.authorizeControlGrant({
            sessionBearer: readmitted.sessionBearer,
            eventGameId: "game-1",
          }),
        ).toMatchObject({ status: "authorized", grantId: created.grantId });
      } finally {
        reopened.close();
      }
    } finally {
      await handle.cleanup();
    }
  });

  test("persists cryptographic erasure through raw SQLite rows and restart", async () => {
    let nowMs = 1_000;
    const handle = await createStorage();
    const authority = createAuthority(
      handle.storage,
      createGrantTestRandomness(),
      createGrantTestKeyRing(),
      () => nowMs,
    );
    try {
      const created = await createGrant(authority, 1_100);
      const admitted = await admit(authority, created.qrCredential, "browser-erasure");
      nowMs = 1_100;
      const auditResult = await authority.listGrantAudit(created.grantId, createActor());
      expect(auditResult.status).toBe("ok");
      if (auditResult.status !== "ok") throw new Error("Expected audit read evidence.");
      expect(auditResult.value.filter((entry) => entry.action === "grant-expired")).toHaveLength(1);
      assertSQLiteGrantSecretsAreErased(
        handle.databasePath,
        created.grantId,
        admitted.grantSessionId,
      );
      handle.storage.close();

      const reopened = openSqliteFoundationStorage(handle.databasePath);
      try {
        const reopenedAuthority = createAuthority(
          reopened,
          createGrantTestRandomness(),
          createGrantTestKeyRing(),
          () => nowMs,
        );
        const reopenedAudit = await reopenedAuthority.listGrantAudit(
          created.grantId,
          createActor(),
        );
        expect(reopenedAudit.status).toBe("ok");
        if (reopenedAudit.status !== "ok") throw new Error("Expected restarted audit evidence.");
        expect(
          reopenedAudit.value.filter((entry) => entry.action === "grant-expired"),
        ).toHaveLength(1);
        assertSQLiteGrantSecretsAreErased(
          handle.databasePath,
          created.grantId,
          admitted.grantSessionId,
        );
      } finally {
        reopened.close();
      }
    } finally {
      await handle.cleanup();
    }
  });

  test("persists atomic credential key rotation across restart", async () => {
    const handle = await createStorage();
    const originalKeyRing = createGrantTestKeyRing();
    const rotatedKeyRing = createGrantTestRotatedKeyRing(originalKeyRing);
    try {
      const original = createAuthority(
        handle.storage,
        createGrantTestRandomness(),
        originalKeyRing,
      );
      const created = await createGrant(original);
      handle.storage.close();

      const rotatingStorage = openSqliteFoundationStorage(handle.databasePath);
      const rotating = createAuthority(
        rotatingStorage,
        createGrantTestRandomness(20),
        rotatedKeyRing,
      );
      expect(
        await rotating.rotateControlGrantCredentialKeys(created.grantId, createActor()),
      ).toMatchObject({
        status: "rotated",
        encryptionKeyVersion: "encryption-v2",
        lookupKeyVersion: "lookup-v2",
      });
      rotatingStorage.close();

      const reopened = openSqliteFoundationStorage(handle.databasePath);
      try {
        const currentOnly = createAuthority(
          reopened,
          createGrantTestRandomness(40),
          createGrantTestCurrentOnlyKeyRing(rotatedKeyRing),
        );
        expect(
          await admit(currentOnly, created.qrCredential, "browser-after-rotation"),
        ).toMatchObject({ grantId: created.grantId });
        const audit = await currentOnly.listGrantAudit(created.grantId, createActor());
        expect(audit.status).toBe("ok");
        if (audit.status !== "ok") throw new Error("Expected rotation audit evidence.");
        expect(audit.value.filter((entry) => entry.action === "credential-rotated")).toHaveLength(
          1,
        );
        expect(JSON.stringify(audit)).not.toContain(created.qrCredential);
        const database = new Database(handle.databasePath);
        try {
          expect(
            database
              .query(
                `SELECT encryption_key_version, lookup_key_version
                 FROM foundation_grant_roots WHERE grant_id = ?`,
              )
              .get(created.grantId),
          ).toEqual({ encryption_key_version: "encryption-v2", lookup_key_version: "lookup-v2" });
        } finally {
          database.close();
        }
      } finally {
        reopened.close();
      }
    } finally {
      await handle.cleanup();
    }
  });

  test("serializes concurrent same-context admission across independent SQLite instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-timer-grant-concurrent-"));
    const databasePath = join(directory, "foundation.sqlite");
    const creator = openSqliteFoundationStorage(databasePath);
    try {
      await creator.applyMigrations();
      const created = await createGrant(createAuthority(creator, createGrantTestRandomness(1)));
      creator.close();
      const readyPaths = [join(directory, "worker-a.ready"), join(directory, "worker-b.ready")];
      const startPath = join(directory, "workers.start");
      const credentialPath = join(directory, "credential.private");
      const workerPath = join(import.meta.dir, "grant-authority-concurrent-worker.ts");
      await writePrivateGrantCredential(credentialPath, created.qrCredential);
      const environment = createGrantAdmissionWorkerEnvironment(directory);
      const commands = [10, 20].map((seed, index) =>
        buildGrantAdmissionWorkerCommand({
          executablePath: process.execPath,
          workerPath,
          databasePath,
          readyPath: readyPaths[index] ?? join(directory, `worker-${index}.ready`),
          startPath,
          credentialPath,
          seed,
        }),
      );
      expect(JSON.stringify({ commands, environment })).not.toContain(created.qrCredential);
      const workers = commands.map((command) =>
        spawnProbeCommand(command, { env: environment, detached: true }),
      );
      const signals = installProbeSignalHandlers();
      try {
        const workerResults = await superviseGrantAdmissionWorkers({
          workers,
          readyPaths,
          startPath,
          artifactPaths: [...readyPaths, startPath, credentialPath],
          signal: signals.signal,
        });
        expect(workers.every((worker) => worker.process.exitCode !== null)).toBe(true);
        const results = workerResults.map(
          (result) => JSON.parse(result.stdout) as WorkerAdmissionResult,
        );
        expect(await Bun.file(credentialPath).exists()).toBe(false);
        const leftResult = results[0];
        const rightResult = results[1];
        expect(leftResult?.status).toBe("admitted");
        expect(rightResult?.status).toBe("admitted");
        if (leftResult?.status !== "admitted" || rightResult?.status !== "admitted") {
          throw new Error("Expected both concurrent admissions to commit.");
        }

        const reader = openSqliteFoundationStorage(databasePath);
        try {
          const readerAuthority = createAuthority(reader, createGrantTestRandomness(30));
          const sessionsResult = await readerAuthority.listGrantSessions(
            created.grantId,
            createActor(),
          );
          expect(sessionsResult.status).toBe("ok");
          if (sessionsResult.status !== "ok") throw new Error("Expected session read evidence.");
          const sessions = sessionsResult.value;
          const active = sessions.filter((session) => session.status === "active");
          expect(active).toHaveLength(1);
          expect(Object.keys(sessions[0] ?? {}).sort()).toEqual([
            "browserClass",
            "createdAtMs",
            "deviceClass",
            "label",
            "lastActiveAtMs",
            "revokedAtMs",
            "status",
          ]);
          expect(JSON.stringify(sessions)).not.toMatch(
            /sessionId|grantId|bearer|verifier|digest|keyVersion|eventGameId|grantVersion/i,
          );
          const admittedIds = new Set([leftResult.grantSessionId, rightResult.grantSessionId]);
          expect(admittedIds).toHaveLength(2);
          expect(active[0]?.label).toMatch(/^session-[A-Za-z0-9_-]{12}$/);
          const revoked = sessions.find((session) => session.status === "revoked");
          expect(revoked).toBeDefined();
          const auditResult = await readerAuthority.listGrantAudit(created.grantId, createActor());
          expect(auditResult.status).toBe("ok");
          if (auditResult.status !== "ok") throw new Error("Expected audit read evidence.");
          const audit = auditResult.value;
          expect(audit).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ action: "session-admitted" }),
              expect.objectContaining({
                action: "session-replaced",
                replacedSessionId: expect.any(String),
              }),
            ]),
          );
        } finally {
          reader.close();
        }
      } finally {
        signals.cleanup();
      }
    } finally {
      creator.close();
      await rm(directory, { recursive: true, force: true });
      expect(existsSync(directory)).toBe(false);
    }
  });
});

type WorkerAdmissionResult = { status: string; grantSessionId?: string };

type SqliteGrantStorage = GrantAuthorityContractStorage & { databasePath: string };

async function createStorage(): Promise<SqliteGrantStorage> {
  const directory = await mkdtemp(join(tmpdir(), "quadball-timer-grant-focused-"));
  const databasePath = join(directory, "foundation.sqlite");
  const storage = openSqliteFoundationStorage(databasePath);
  try {
    await storage.applyMigrations();
  } catch (error) {
    storage.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    storage,
    databasePath,
    cleanup: async () => {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function createAuthority(
  storage: SqliteGrantStorage["storage"],
  randomness: ReturnType<typeof createGrantTestRandomness>,
  keyRing: GrantKeyRing = createGrantTestKeyRing(),
  nowMs: () => number = () => 1_000,
  resolveSession?: () => ControlGrantSessionResolution,
): GrantAuthority {
  return createLegacyControlGrantTestAuthority(storage, {
    environmentId: "test-environment",
    clock: { nowMs },
    randomness,
    keyRing,
    privilegedAuthorityVerifier: createGrantTestAuthorityVerifier(),
    controlScopeResolver: {
      resolve(scope: ControlGrantScope) {
        expect(scope).toEqual(createGrantTestScope());
        return { status: "eligible", eventGameId: "game-1" };
      },
      resolveSession,
    },
  });
}

async function createGrant(authority: GrantAuthority, expiresAtMs?: number) {
  const result = await authority.createControlGrant({
    scope: createGrantTestScope(),
    actor: createActor(),
    expiresAtMs,
  });
  expect(result.status).toBe("created");
  if (result.status !== "created") throw new Error("Expected a created Control Grant.");
  return result;
}

function assertSQLiteGrantSecretsAreErased(
  databasePath: string,
  grantId: string,
  sessionId: string,
): void {
  const database = new Database(databasePath);
  try {
    const grant = database
      .query(
        `SELECT credential_material_state, encryption_key_version, lookup_key_version,
                credential_iv, credential_ciphertext, credential_tag,
                credential_lookup_digest, credential_fingerprint
         FROM foundation_grant_roots WHERE grant_id = ?`,
      )
      .get(grantId) as Record<string, unknown> | null;
    expect(grant).toMatchObject({
      credential_material_state: "erased",
      encryption_key_version: null,
      lookup_key_version: null,
      credential_iv: null,
      credential_ciphertext: null,
      credential_tag: null,
      credential_lookup_digest: null,
    });
    expect(typeof grant?.credential_fingerprint).toBe("string");
    const session = database
      .query(
        `SELECT bearer_material_state, bearer_lookup_verifier, bearer_lookup_key_version
         FROM foundation_grant_sessions WHERE session_id = ?`,
      )
      .get(sessionId) as Record<string, unknown> | null;
    expect(session).toEqual({
      bearer_material_state: "erased",
      bearer_lookup_verifier: null,
      bearer_lookup_key_version: null,
    });
  } finally {
    database.close();
  }
}

function flipBase64Url(value: string): string {
  if (value.length === 0) throw new Error("Expected persisted Base64URL material.");
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}

async function admit(authority: GrantAuthority, qrCredential: string, browserContext: string) {
  const result = await authority.admitControlGrant({ qrCredential, browserContext });
  expect(result.status).toBe("admitted");
  if (result.status !== "admitted") throw new Error("Expected an admitted Grant Session.");
  return result;
}

function createActor() {
  return { kind: "fixture" as const, id: "fixture-authority" };
}

function assertSQLiteSecretsAreRedacted(
  databasePath: string,
  qrCredential: string,
  sessionBearer: string,
): void {
  const database = new Database(databasePath);
  try {
    const serialized = JSON.stringify({
      grants: database.query("SELECT * FROM foundation_grant_roots").all(),
      sessions: database.query("SELECT * FROM foundation_grant_sessions").all(),
      audit: database.query("SELECT * FROM foundation_grant_audit").all(),
    });
    expect(serialized).not.toContain(qrCredential);
    expect(serialized).not.toContain(sessionBearer);
  } finally {
    database.close();
  }
}
