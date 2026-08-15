import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDeterministicTestIqaInterpreter } from "@/lib/event-game-actions";
import type { ControlAction } from "@/lib/event-game-actions";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import { createGrantAuthority } from "@/lib/grant-authority";
import { createGrantTestKeyRing, createGrantTestRandomness } from "@/lib/grant-authority-contract";
import { createGrantTestAuthorityVerifier } from "@/lib/grant-authority-test-support";
import { createLegacyControlGrantTestAuthority } from "@/lib/grant-authority-test-support";
import { createEventGameRecord } from "@/lib/event-game-record";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import { FOUNDATION_MIGRATIONS } from "@/lib/foundation-migrations";
import { createFoundationRecovery } from "@/lib/foundation-recovery";
import {
  AD_HOC_RECOVERY_MANIFEST_VERSION,
  type AdHocRecoveryAdapter,
  type AdHocRecoveryFacts,
} from "@/lib/ad-hoc-games";
import { FoundationBackupPolicyError } from "@/lib/foundation-recovery-sqlite";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";

const CURRENT_MIGRATION_COUNT = FOUNDATION_MIGRATIONS.length;
const CURRENT_SCHEMA_VERSION = String(FOUNDATION_MIGRATIONS.at(-1)?.schemaVersion ?? 0);

describe("Event foundation recovery", () => {
  test("sanitizes Technical Admin auth physically and verifies a retained VACUUM snapshot", async () => {
    await withRecoveryPaths(async ({ livePath, backupDirectory }) => {
      const harness = await createHarness(livePath, backupDirectory);
      const canary = "synthetic-passkey-canary-never-in-backup";
      const injected = new Database(livePath);
      injected.exec(`
        CREATE TABLE technical_admin_credentials (credential_id TEXT PRIMARY KEY, public_key_json TEXT);
        CREATE TABLE technical_admin_sessions (session_id TEXT PRIMARY KEY, token_hash TEXT);
      `);
      injected
        .query("INSERT INTO technical_admin_credentials VALUES (?, ?)")
        .run("credential", canary);
      injected
        .query("INSERT INTO technical_admin_sessions VALUES (?, ?)")
        .run("session", `${canary}-session`);
      injected.close();

      const manifest = await harness.recovery.createPreDeploymentBackup();
      const manifestPath = join(backupDirectory, `${manifest.snapshotId}.manifest.json`);
      const databasePath = join(backupDirectory, manifest.databaseFile);
      expect(await harness.recovery.verifyBackup(manifestPath)).toEqual(manifest);
      const manifestAlias = join(backupDirectory, "manifest-alias.json");
      await symlink(manifestPath, manifestAlias);
      expect(harness.recovery.verifyBackup(manifestAlias)).rejects.toThrow();
      const compactedBytes = readFileSync(databasePath);
      expect(compactedBytes.includes(Buffer.from(canary))).toBe(false);
      const verified = new Database(databasePath, { readonly: true });
      expect(
        verified
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'technical_admin_%'",
          )
          .all(),
      ).toEqual([]);
      expect(
        verified.query("SELECT COUNT(*) AS count FROM foundation_migration_ledger").get(),
      ).toEqual({ count: CURRENT_MIGRATION_COUNT });
      verified.close();
      harness.storage.close();
    });
  });

  test("fails closed on an unclassified authority relation and retains the prior verified backup", async () => {
    await withRecoveryPaths(async ({ livePath, backupDirectory }) => {
      const ids = ["first", "verify-first", "second"];
      const harness = await createHarness(livePath, backupDirectory, () => ids.shift() ?? "extra");
      const first = await harness.recovery.createPreDeploymentBackup();
      const firstDatabase = join(backupDirectory, first.databaseFile);
      const injected = new Database(livePath);
      injected.exec("CREATE TABLE plugin_authority_secrets (secret TEXT NOT NULL);");
      injected.close();
      expect(harness.recovery.createPreDeploymentBackup()).rejects.toBeInstanceOf(
        FoundationBackupPolicyError,
      );
      expect(existsSync(firstDatabase)).toBe(true);
      expect(existsSync(join(backupDirectory, `${first.snapshotId}.manifest.json`))).toBe(true);
      harness.storage.close();
    });
  });

  test("uses a private physical workspace and rejects unsafe existing paths", async () => {
    await withRecoveryPaths(async ({ livePath, backupDirectory }) => {
      let rawMode: number | null = null;
      const harness = await createHarness(livePath, backupDirectory, () => "private-snapshot");
      const recovery = createFoundationRecovery(harness.storage, {
        ...harness.options,
        createId: () => "private-snapshot",
        faultInjector(phase) {
          if (phase !== "after-vacuum") return;
          const raw = lstatSync(join(backupDirectory, ".private-snapshot.raw.sqlite"));
          expect(raw.isSymbolicLink()).toBe(false);
          rawMode = raw.mode & 0o777;
          throw new Error("inspect private raw snapshot");
        },
      });
      expect(recovery.createPreDeploymentBackup()).rejects.toThrow("inspect private raw snapshot");
      expect(Number(rawMode)).toBe(0o600);
      expect(lstatSync(backupDirectory).mode & 0o777).toBe(0o700);

      await writeFile(join(backupDirectory, "private-snapshot.sqlite"), "preserve", {
        mode: 0o600,
      });
      expect(harness.recovery.createPreDeploymentBackup()).rejects.toThrow();
      expect(await readFile(join(backupDirectory, "private-snapshot.sqlite"), "utf8")).toBe(
        "preserve",
      );
      harness.storage.close();
    });

    await withRecoveryPaths(async ({ livePath, backupDirectory }) => {
      const harness = await createHarness(livePath, backupDirectory, () => "raced-snapshot");
      const racedPath = join(backupDirectory, "raced-snapshot.sqlite");
      const recovery = createFoundationRecovery(harness.storage, {
        ...harness.options,
        createId: () => "raced-snapshot",
        faultInjector(phase) {
          if (phase === "after-verification") {
            writeFileSync(racedPath, "replacement-must-survive", { mode: 0o600 });
          }
        },
      });
      expect(recovery.createPreDeploymentBackup()).rejects.toThrow();
      expect(await readFile(racedPath, "utf8")).toBe("replacement-must-survive");
      expect(existsSync(join(backupDirectory, "raced-snapshot.manifest.json"))).toBe(false);
      harness.storage.close();
    });

    await withRecoveryPaths(async ({ livePath, backupDirectory }) => {
      const redirect = `${backupDirectory}-redirect`;
      await mkdir(redirect, { mode: 0o700 });
      await symlink(redirect, backupDirectory);
      const harness = await createHarness(livePath, backupDirectory);
      expect(harness.recovery.createPreDeploymentBackup()).rejects.toThrow(
        "owned non-symlink 0700",
      );
      harness.storage.close();
    });

    await withRecoveryPaths(async ({ livePath, backupDirectory }) => {
      await mkdir(backupDirectory, { mode: 0o700 });
      await chmod(backupDirectory, 0o777);
      const harness = await createHarness(livePath, backupDirectory);
      expect(harness.recovery.createPreDeploymentBackup()).rejects.toThrow(
        "owned non-symlink 0700",
      );
      harness.storage.close();
    });
  });

  test("composes Ad Hoc backup, cutover, failed-image preservation, and rollback", async () => {
    await withRecoveryPaths(async ({ livePath, backupDirectory }) => {
      const harness = await createHarness(livePath, backupDirectory, () => "fast-composed");
      const adHocPath = join(dirname(livePath), "ad-hoc.sqlite");
      const adHoc = await createFastAdHocRecoveryAdapter(adHocPath, "snapshot");
      const recovery = createFoundationRecovery(harness.storage, {
        ...harness.options,
        adHoc: adHoc.adapter,
        createId: () => "fast-composed",
      });
      const manifest = await recovery.createPreDeploymentBackup();
      const manifestPath = join(backupDirectory, `${manifest.snapshotId}.manifest.json`);
      expect(manifest.adHoc).toMatchObject({
        databaseFile: `${manifest.snapshotId}.ad-hoc.sqlite`,
        facts: { retainedGameCount: 1 },
      });
      expect(await recovery.verifyBackup(manifestPath)).toEqual(manifest);
      adHoc.setLive("newer-live-state");
      const restored = await recovery.restore(manifestPath);
      expect(restored).toMatchObject({ completed: true, potentiallyNewerWork: true });
      expect(adHoc.readLive()).toBe("snapshot");
      expect(restored.failedAdHocDatabasePath).not.toBeNull();
      expect(await readFile(restored.failedAdHocDatabasePath!, "utf8")).toBe("newer-live-state");
      harness.storage.close();
    });

    await withRecoveryPaths(async ({ livePath, backupDirectory }) => {
      const harness = await createHarness(livePath, backupDirectory, () => "fast-rollback");
      const adHocPath = join(dirname(livePath), "ad-hoc.sqlite");
      const adHoc = await createFastAdHocRecoveryAdapter(adHocPath, "snapshot");
      const initial = createFoundationRecovery(harness.storage, {
        ...harness.options,
        adHoc: adHoc.adapter,
        createId: () => "fast-rollback",
      });
      const manifest = await initial.createPreDeploymentBackup();
      const manifestPath = join(backupDirectory, `${manifest.snapshotId}.manifest.json`);
      adHoc.setLive("newer-live-state");
      const rollback = createFoundationRecovery(harness.storage, {
        ...harness.options,
        adHoc: adHoc.adapter,
        createId: () => "fast-rollback-restore",
        faultInjector(phase) {
          if (phase === "before-live-replacement") throw new Error("fast rollback");
        },
      });
      await expectRejected(rollback.restore(manifestPath), "fast rollback");
      expect(adHoc.readLive()).toBe("newer-live-state");
      expect(existsSync(`${adHocPath}.failed-fast-rollback-restore`)).toBe(false);
      expect(existsSync(`${livePath}.failed-fast-rollback-restore`)).toBe(false);
      harness.storage.close();
    });
  });

  test("stages restore, preserves the failed database, and rolls replacement failures back", async () => {
    await withRecoveryPaths(async ({ livePath, backupDirectory }) => {
      const ids = ["snapshot", "verify-backup", "verify-before-restore", "restore"];
      const harness = await createHarness(livePath, backupDirectory, () => ids.shift() ?? "extra");
      const manifest = await harness.recovery.createPreDeploymentBackup();
      const manifestPath = join(backupDirectory, `${manifest.snapshotId}.manifest.json`);
      const live = new Database(livePath);
      live
        .query("INSERT INTO foundation_event_catalog_events VALUES (?, ?, ?, 'unpublished', ?, ?)")
        .run("newer-event", "Potentially newer work", "Europe/Zurich", 20, 20);
      live.close();
      const technicalAdminPath = harness.options.technicalAdminAuth.databasePath;
      const technicalAdmin = new Database(technicalAdminPath, { create: true });
      technicalAdmin.exec(
        "CREATE TABLE technical_admin_credentials (credential_id TEXT PRIMARY KEY, public_key_json TEXT);",
      );
      technicalAdmin
        .query("INSERT INTO technical_admin_credentials VALUES (?, ?)")
        .run("active-passkey", "must-not-revive");
      technicalAdmin.close();

      const technicalAdminWalPath = `${technicalAdminPath}-wal`;
      const technicalAdminShmPath = `${technicalAdminPath}-shm`;
      const quarantinePath = `${livePath}.quarantine`;
      const recovery = createFoundationRecovery(harness.storage, {
        ...harness.options,
        faultInjector(phase) {
          if (phase !== "after-final-authority-evaluation") return;
          chmodSync(livePath, 0o644);
          chmodSync(technicalAdminPath, 0o644);
          writeFileSync(technicalAdminWalPath, "technical-admin-wal", { mode: 0o644 });
          writeFileSync(technicalAdminShmPath, "technical-admin-shm", { mode: 0o644 });
          writeFileSync(quarantinePath, "quarantine", { mode: 0o644 });
        },
      });
      const restored = await recovery.restore(manifestPath);
      expect(restored.potentiallyNewerWork).toBe(true);
      expect(existsSync(restored.failedDatabasePath)).toBe(true);
      expect(existsSync(technicalAdminPath)).toBe(false);
      expect(restored.failedTechnicalAdminDatabasePath).not.toBeNull();
      expect(existsSync(restored.failedTechnicalAdminDatabasePath ?? "")).toBe(true);
      for (const privatePath of [
        restored.failedDatabasePath,
        restored.failedTechnicalAdminDatabasePath ?? "",
        `${restored.failedTechnicalAdminDatabasePath ?? ""}-wal`,
        `${restored.failedTechnicalAdminDatabasePath ?? ""}-shm`,
        `${restored.failedDatabasePath}.quarantine`,
      ]) {
        expect(lstatSync(privatePath).mode & 0o777).toBe(0o600);
      }
      expect(existsSync(livePath)).toBe(true);
      const current = new Database(livePath);
      expect(
        current.query("SELECT COUNT(*) AS count FROM foundation_event_catalog_events").get(),
      ).toEqual({ count: 0 });
      current.close();
      const failed = new Database(restored.failedDatabasePath);
      expect(
        failed.query("SELECT COUNT(*) AS count FROM foundation_event_catalog_events").get(),
      ).toEqual({ count: 1 });
      failed.close();
      expect(JSON.parse(readFileSync(restored.evidencePath, "utf8"))).toMatchObject({
        status: "pending-replacement",
        restoreId: restored.restoreId,
      });
      expect(restored).toMatchObject({
        completed: true,
        completionEvidenceStatus: "written",
      });
      if (restored.completionEvidencePath === null) {
        throw new Error("Expected completed restore evidence.");
      }
      expect(lstatSync(restored.evidencePath).mode & 0o777).toBe(0o600);
      expect(lstatSync(restored.completionEvidencePath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(restored.completionEvidencePath, "utf8"))).toMatchObject({
        status: "completed",
        technicalAdminAuthRevived: false,
        potentiallyNewerWork: true,
        snapshotAtMs: manifest.snapshotAtMs,
      });
    });

    await withRecoveryPaths(async ({ livePath, backupDirectory }) => {
      const ids = ["snapshot-failure", "verify-1", "verify-2", "restore-failure"];
      const initial = await createHarness(livePath, backupDirectory, () => ids.shift() ?? "extra");
      const manifest = await initial.recovery.createPreDeploymentBackup();
      const manifestPath = join(backupDirectory, `${manifest.snapshotId}.manifest.json`);
      const technicalAdminPath = initial.options.technicalAdminAuth.databasePath;
      const technicalAdmin = new Database(technicalAdminPath, { create: true });
      technicalAdmin.exec("CREATE TABLE technical_admin_credentials (credential_id TEXT);");
      technicalAdmin.close();
      const recovery = createFoundationRecovery(initial.storage, {
        ...initial.options,
        createId: () => ids.shift() ?? "extra",
        faultInjector(phase) {
          if (phase === "after-final-authority-evaluation") {
            chmodSync(livePath, 0o644);
            chmodSync(technicalAdminPath, 0o644);
            writeFileSync(`${technicalAdminPath}-wal`, "rollback-wal", { mode: 0o644 });
            writeFileSync(`${technicalAdminPath}-shm`, "rollback-shm", { mode: 0o644 });
            writeFileSync(`${livePath}.quarantine`, "rollback-quarantine", { mode: 0o644 });
          }
          if (phase === "before-live-replacement") throw new Error("injected replacement failure");
        },
      });
      expect(recovery.restore(manifestPath)).rejects.toThrow("injected replacement failure");
      expect(existsSync(livePath)).toBe(true);
      expect(existsSync(technicalAdminPath)).toBe(true);
      for (const privatePath of [
        livePath,
        technicalAdminPath,
        `${technicalAdminPath}-wal`,
        `${technicalAdminPath}-shm`,
        `${livePath}.quarantine`,
      ]) {
        expect(lstatSync(privatePath).mode & 0o777).toBe(0o600);
      }
      await rm(`${livePath}.quarantine`);
      const reopened = openSqliteFoundationStorage(livePath, {
        grantKeyRing: initial.keyRing,
        grantValidationContext: { environmentId: "test", keyRing: initial.keyRing },
      });
      reopened.setReadinessContext(initial.readinessContext);
      expect(await reopened.readiness()).toMatchObject({ ok: true });
      reopened.close();
    });

    await withRecoveryPaths(async ({ livePath, backupDirectory }) => {
      const ids = [
        "snapshot-completion-io",
        "verify-backup",
        "restore-completion-io",
        "verify-restore",
      ];
      const initial = await createHarness(livePath, backupDirectory, () => ids.shift() ?? "extra");
      const manifest = await initial.recovery.createPreDeploymentBackup();
      const manifestPath = join(backupDirectory, `${manifest.snapshotId}.manifest.json`);
      const recovery = createFoundationRecovery(initial.storage, {
        ...initial.options,
        createId: () => ids.shift() ?? "extra",
        faultInjector(phase) {
          if (phase === "before-completed-restore-evidence") {
            throw new Error("ENOSPC injected after completed cutover");
          }
        },
      });
      const restored = await recovery.restore(manifestPath);
      expect(restored).toMatchObject({
        completed: true,
        completionEvidencePath: null,
        completionEvidenceStatus: "write-failed",
      });
      expect(JSON.parse(readFileSync(restored.evidencePath, "utf8"))).toMatchObject({
        status: "pending-replacement",
        restoreId: restored.restoreId,
        snapshotId: manifest.snapshotId,
      });
      expect(
        existsSync(join(backupDirectory, `${restored.restoreId}.restore-completed.json`)),
      ).toBe(false);
      expect(existsSync(restored.failedDatabasePath)).toBe(true);
      const reopened = openSqliteFoundationStorage(livePath, {
        grantKeyRing: initial.keyRing,
        grantValidationContext: { environmentId: "test", keyRing: initial.keyRing },
      });
      reopened.setReadinessContext(initial.readinessContext);
      expect(await reopened.readiness()).toMatchObject({ ok: true });
      reopened.close();
    });

    await withRecoveryPaths(async ({ livePath, backupDirectory }) => {
      const ids = [
        "snapshot-pre-reevaluation-race",
        "verify-backup",
        "restore-pre-reevaluation-race",
        "verify-restore",
      ];
      const initial = await createHarness(livePath, backupDirectory, () => ids.shift() ?? "extra");
      const manifest = await initial.recovery.createPreDeploymentBackup();
      const manifestPath = join(backupDirectory, `${manifest.snapshotId}.manifest.json`);
      const backupPath = join(backupDirectory, manifest.databaseFile);
      const stagedPath = join(
        dirname(livePath),
        ".foundation.sqlite.restore-pre-reevaluation-race.staged",
      );
      const displacedPath = `${stagedPath}.verified-inode`;
      const recovery = createFoundationRecovery(initial.storage, {
        ...initial.options,
        createId: () => ids.shift() ?? "extra",
        faultInjector(phase) {
          if (phase === "after-authoritative-quiescence") {
            renameSync(stagedPath, displacedPath);
            copyFileSync(backupPath, stagedPath);
            chmodSync(stagedPath, 0o600);
          }
        },
      });
      expect(recovery.restore(manifestPath)).rejects.toThrow("file identity");
      expect(existsSync(stagedPath)).toBe(true);
      expect(existsSync(displacedPath)).toBe(true);
      const reopened = openSqliteFoundationStorage(livePath, {
        grantKeyRing: initial.keyRing,
        grantValidationContext: { environmentId: "test", keyRing: initial.keyRing },
      });
      reopened.setReadinessContext(initial.readinessContext);
      expect(await reopened.readiness()).toMatchObject({ ok: true });
      reopened.close();
    });

    await withRecoveryPaths(async ({ livePath, backupDirectory }) => {
      const ids = ["snapshot-stage-race", "verify-backup", "restore-stage-race", "verify-restore"];
      const initial = await createHarness(livePath, backupDirectory, () => ids.shift() ?? "extra");
      const manifest = await initial.recovery.createPreDeploymentBackup();
      const manifestPath = join(backupDirectory, `${manifest.snapshotId}.manifest.json`);
      const stagedPath = join(dirname(livePath), ".foundation.sqlite.restore-stage-race.staged");
      const displacedPath = `${stagedPath}.verified-inode`;
      const recovery = createFoundationRecovery(initial.storage, {
        ...initial.options,
        createId: () => ids.shift() ?? "extra",
        faultInjector(phase) {
          if (phase === "after-final-authority-evaluation") {
            renameSync(stagedPath, displacedPath);
            writeFileSync(stagedPath, "replacement-must-not-be-installed", { mode: 0o600 });
          }
        },
      });
      expect(recovery.restore(manifestPath)).rejects.toThrow("file identity");
      expect(await readFile(stagedPath, "utf8")).toBe("replacement-must-not-be-installed");
      expect(existsSync(displacedPath)).toBe(true);
      const reopened = openSqliteFoundationStorage(livePath, {
        grantKeyRing: initial.keyRing,
        grantValidationContext: { environmentId: "test", keyRing: initial.keyRing },
      });
      reopened.setReadinessContext(initial.readinessContext);
      expect(await reopened.readiness()).toMatchObject({ ok: true });
      reopened.close();
    });

    await withRecoveryPaths(async ({ livePath, backupDirectory }) => {
      const ids = [
        "snapshot-stage-mutation",
        "verify-backup",
        "restore-stage-mutation",
        "verify-restore",
      ];
      const initial = await createHarness(livePath, backupDirectory, () => ids.shift() ?? "extra");
      const manifest = await initial.recovery.createPreDeploymentBackup();
      const manifestPath = join(backupDirectory, `${manifest.snapshotId}.manifest.json`);
      const stagedPath = join(
        dirname(livePath),
        ".foundation.sqlite.restore-stage-mutation.staged",
      );
      const recovery = createFoundationRecovery(initial.storage, {
        ...initial.options,
        createId: () => ids.shift() ?? "extra",
        faultInjector(phase) {
          if (phase === "after-final-authority-evaluation") {
            writeFileSync(stagedPath, "same-inode-mutation", { mode: 0o600 });
          }
        },
      });
      expect(recovery.restore(manifestPath)).rejects.toThrow(
        "source changed before exclusive publication",
      );
      const reopened = openSqliteFoundationStorage(livePath, {
        grantKeyRing: initial.keyRing,
        grantValidationContext: { environmentId: "test", keyRing: initial.keyRing },
      });
      reopened.setReadinessContext(initial.readinessContext);
      expect(await reopened.readiness()).toMatchObject({ ok: true });
      reopened.close();
    });
  });

  test("records one bounded gap for every action in a whole-batch rejection", async () => {
    await withRecoveryPaths(async ({ livePath, backupDirectory }) => {
      const harness = await createHarness(livePath, backupDirectory);
      const action = createRecoveredAction();
      const secondAction = {
        ...createRecoveredAction(),
        operationId: "original-operation-2",
        payload: { factId: "fact-2", factType: "score", gameSideId: "side-1", value: 2 },
        interpretation: {
          type: "fact" as const,
          factId: "fact-2",
          factType: "score",
          gameSideId: "side-1",
          payload: { value: 2 },
        },
      };
      const imported = await harness.recovery.importControllerRecovery({
        importId: "import-1",
        recordId: action.recordId,
        eventGameId: action.eventGameId,
        sessionBearer: "fresh-current-session-bearer",
        currentGrant: { sessionId: "current-session", versionId: "current-version" },
        currentLifecycle: {
          phase: "malformed",
          commencedAtMs: null,
          finishedAtMs: null,
          lockedAtMs: null,
          lockReason: null,
        } as never,
        sourceReference: "controller-history-1",
        actions: [
          { action, sourceAcceptedAtMs: null },
          { action: secondAction, sourceAcceptedAtMs: null },
        ],
        gaps: [
          {
            gapId: "gap-1",
            category: "server-evidence-unavailable",
            redactedDetail: "Server-only acknowledgement evidence was unavailable.",
          },
        ],
      });
      const evidence = JSON.parse(readFileSync(imported.evidencePath, "utf8"));
      expect(evidence.gaps).toEqual([
        expect.objectContaining({ category: "server-evidence-unavailable" }),
        expect.objectContaining({ category: "action-rejected" }),
        expect.objectContaining({ category: "action-rejected" }),
      ]);
      expect(JSON.stringify(evidence)).not.toContain("fresh-current-session-bearer");
      harness.storage.close();
    });
  });

  test("bounds action and supplied-gap counts before pending recovery evidence", async () => {
    await withRecoveryPaths(async ({ livePath, backupDirectory }) => {
      const harness = await createHarness(livePath, backupDirectory);
      const action = createRecoveredAction();
      const input = {
        importId: "too-many-actions",
        recordId: action.recordId,
        eventGameId: action.eventGameId,
        sessionBearer: "fresh-current-session-bearer",
        currentGrant: { sessionId: "current-session", versionId: "current-version" },
        currentLifecycle: action.lifecycle,
        sourceReference: "controller-history-1",
        actions: Array.from({ length: 101 }, (_, index) => ({
          action: {
            ...action,
            operationId: `operation-${index + 1}`,
          },
          sourceAcceptedAtMs: null,
        })),
        gaps: [],
      };
      expect(harness.recovery.importControllerRecovery(input)).rejects.toThrow("action count");
      expect(existsSync(join(backupDirectory, "too-many-actions.recovery-import.json"))).toBe(
        false,
      );

      const tooManyGaps = {
        ...input,
        importId: "too-many-gaps",
        actions: [{ action, sourceAcceptedAtMs: null }],
        gaps: Array.from({ length: 101 }, (_, index) => ({
          gapId: `gap-${index + 1}`,
          category: "server-evidence-unavailable" as const,
          redactedDetail: "Server-only evidence was unavailable.",
        })),
      };
      expect(harness.recovery.importControllerRecovery(tooManyGaps)).rejects.toThrow("Gap count");
      expect(existsSync(join(backupDirectory, "too-many-gaps.recovery-import.json"))).toBe(false);
      harness.storage.close();
    });
  });

  test("quiesces writers before preserving a pinned Game and terminating multiple exact terminal Games", async () => {
    await withRecoveryPaths(async ({ livePath, backupDirectory }) => {
      let now = 10;
      const lockedEventGameIds = new Set<string>();
      const pastGameDayEventGameIds = new Set(["game-past"]);
      let currentEventGameId = "game-old";
      const lateWriterLanded = {
        lock: false,
        gameDay: false,
        expiry: false,
        revocation: false,
      };
      const lateWriterResults: Promise<unknown>[] = [];
      const keyRing = createGrantTestKeyRing();
      const readinessContext = {
        actionCodecRegistry: (
          await import("@/lib/event-game-actions")
        ).createControlActionCodecRegistry(),
        interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      };
      const grant: GrantAuthorityOptions = {
        environmentId: "test",
        clock: { nowMs: () => now },
        randomness: createGrantTestRandomness(),
        keyRing,
        controlScopeResolver: {
          resolve: () =>
            lockedEventGameIds.has(currentEventGameId)
              ? {
                  status: "terminal" as const,
                  reason: "game-locked" as const,
                  eventGameId: currentEventGameId,
                }
              : { status: "eligible" as const, eventGameId: currentEventGameId },
          resolveSession: (_scope, sessionEventGameId) =>
            pastGameDayEventGameIds.has(sessionEventGameId)
              ? { status: "past-game-day" as const, eventGameId: sessionEventGameId }
              : lockedEventGameIds.has(sessionEventGameId)
                ? {
                    status: "game-locked" as const,
                    eventGameId: sessionEventGameId,
                  }
                : sessionEventGameId === "game-old" && currentEventGameId === "game-new"
                  ? {
                      status: "pinned" as const,
                      sessionEventGameId,
                      currentEventGameId,
                    }
                  : { status: "current" as const, eventGameId: sessionEventGameId },
        },
        privilegedAuthorityVerifier: createGrantTestAuthorityVerifier(),
      };
      const storage = openSqliteFoundationStorage(livePath, {
        grantKeyRing: keyRing,
        grantValidationContext: { environmentId: "test", keyRing },
      });
      await storage.applyMigrations({ requireCandidate: false });
      storage.setReadinessContext(readinessContext);
      const authority = createGrantAuthority(storage, grant);
      const eventAdmin = await authority.createEventAdminGrant({
        authority: { kind: "technical-admin", id: "technical-admin" },
        scope: {
          eventId: "event-1",
          eventTimeZone: "UTC",
          finalGameDayDate: "2026-08-15",
        },
      });
      if (eventAdmin.status !== "created") throw new Error("Expected Event Admin Grant.");
      const eventSession = await authority.admitGrant({
        qrCredential: eventAdmin.qrCredential,
        browserContext: "event-admin-browser",
      });
      if (eventSession.status !== "admitted") throw new Error("Expected Event Admin session.");
      const control = await authority.createControlGrant({
        authority: { kind: "grant-session", sessionBearer: eventSession.sessionBearer },
        scope: {
          eventId: "event-1",
          gameDayId: "day-1",
          pitchId: "pitch-1",
          pitchSlotId: "slot-1",
        },
      });
      if (control.status !== "created") throw new Error("Expected Control Grant.");
      const code = await authority.createGrantCode(control.grantId, {
        kind: "grant-session",
        sessionBearer: eventSession.sessionBearer,
      });
      if (code.status !== "created") throw new Error("Expected Control Grant Code.");
      const controller = await authority.admitGrant({
        qrCredential: control.qrCredential,
        browserContext: "controller-old-game",
      });
      if (controller.status !== "admitted") throw new Error("Expected Controller session.");
      expect(controller.eventGameId).toBe("game-old");
      currentEventGameId = "game-other";
      const otherController = await authority.admitGrant({
        qrCredential: control.qrCredential,
        browserContext: "controller-other-game",
      });
      if (otherController.status !== "admitted") {
        throw new Error("Expected other-Game Controller session.");
      }
      expect(otherController.eventGameId).toBe("game-other");
      currentEventGameId = "game-new";
      const reassignedController = await authority.admitGrant({
        qrCredential: control.qrCredential,
        browserContext: "controller-new-game",
      });
      if (reassignedController.status !== "admitted") {
        throw new Error("Expected reassigned Controller session.");
      }
      expect(reassignedController.eventGameId).toBe("game-new");
      currentEventGameId = "game-past";
      const pastGameController = await authority.admitGrant({
        qrCredential: control.qrCredential,
        browserContext: "controller-past-game-day",
      });
      if (pastGameController.status !== "admitted") {
        throw new Error("Expected past-Game-Day Controller session fixture.");
      }
      currentEventGameId = "game-new";
      expect(await storage.readiness()).toMatchObject({ ok: true });

      const recovery = createFoundationRecovery(storage, {
        backupDirectory,
        keyRing,
        readinessContext,
        grant,
        acceptance: {
          externalScopeResolver: createPermissiveRecoveryScopeResolver(),
          clock: () => now,
          interpreter: readinessContext.interpreter,
        },
        technicalAdminAuth: {
          databasePath: join(dirname(livePath), "technical-admin.sqlite"),
          async quiesce() {},
        },
        nowMs: () => now,
        faultInjector(phase) {
          if (phase === "after-authoritative-quiescence") {
            lockedEventGameIds.add("game-new");
            lockedEventGameIds.add("game-other");
            now = 30 * 24 * 60 * 60 * 1_000 + 10;
          }
          if (phase === "after-final-authority-evaluation") {
            const attempt = (writer: () => void): void => {
              lateWriterResults.push(
                storage.transaction(() => writer()).catch((error: unknown) => error),
              );
            };
            attempt(() => {
              lockedEventGameIds.add("game-old");
              lateWriterLanded.lock = true;
            });
            attempt(() => {
              pastGameDayEventGameIds.add("game-old");
              lateWriterLanded.gameDay = true;
            });
            attempt(() => {
              now += 1;
              lateWriterLanded.expiry = true;
            });
            lateWriterResults.push(
              storage
                .transaction((transaction) => {
                  const session = transaction
                    .listGrantSessions(control.grantId)
                    .find((candidate) => candidate.sessionId === controller.grantSessionId);
                  if (session !== undefined) {
                    transaction.updateGrantSession({
                      ...session,
                      status: "revoked",
                      revokedAtMs: now,
                    });
                    lateWriterLanded.revocation = true;
                  }
                })
                .catch((error: unknown) => error),
            );
          }
        },
      });
      const manifest = await recovery.createPreDeploymentBackup();
      const restored = await recovery.restore(
        join(backupDirectory, `${manifest.snapshotId}.manifest.json`),
      );
      expect(lateWriterResults).toHaveLength(4);
      for (const result of await Promise.all(lateWriterResults)) {
        expect(result).toBeInstanceOf(Error);
      }
      expect(lateWriterLanded).toEqual({
        lock: false,
        gameDay: false,
        expiry: false,
        revocation: false,
      });
      expect(lockedEventGameIds).toEqual(new Set(["game-new", "game-other"]));
      expect(pastGameDayEventGameIds).toEqual(new Set(["game-past"]));
      const reopened = openSqliteFoundationStorage(livePath, {
        grantKeyRing: keyRing,
        grantValidationContext: { environmentId: "test", keyRing },
      });
      reopened.setReadinessContext(readinessContext);
      const restoredState = await reopened.transaction((transaction) => ({
        grant: transaction.findGrantById(control.grantId),
        sessions: transaction.listGrantSessions(control.grantId),
        audit: transaction.listGrantAudit(control.grantId),
        eventAdminSession: transaction
          .listGrantSessions(eventAdmin.grantId)
          .find((session) => session.sessionId === eventSession.grantSessionId),
      }));
      expect(restoredState.eventAdminSession).toMatchObject({
        status: "expired",
        bearerMaterialState: "erased",
      });
      expect(
        restoredState.sessions.find((session) => session.sessionId === controller.grantSessionId),
      ).toMatchObject({
        eventGameId: "game-old",
        status: "active",
        bearerMaterialState: "present",
      });
      expect(
        restoredState.sessions.find(
          (session) => session.sessionId === otherController.grantSessionId,
        ),
      ).toMatchObject({
        eventGameId: "game-other",
        status: "expired",
        bearerMaterialState: "erased",
        bearerLookupVerifier: null,
      });
      expect(
        restoredState.sessions.find(
          (session) => session.sessionId === reassignedController.grantSessionId,
        ),
      ).toMatchObject({
        eventGameId: "game-new",
        status: "expired",
        bearerMaterialState: "erased",
        bearerLookupVerifier: null,
      });
      expect(
        restoredState.sessions.find(
          (session) => session.sessionId === pastGameController.grantSessionId,
        ),
      ).toMatchObject({
        eventGameId: "game-past",
        status: "expired",
        bearerMaterialState: "erased",
        bearerLookupVerifier: null,
      });
      expect(restoredState.grant?.code).toMatchObject({
        state: "erased",
        ciphertext: null,
        lookupDigest: null,
      });
      expect(
        restoredState.audit.filter((entry) => entry.action === "grant-code-erased-game-lock"),
      ).toEqual([
        expect.objectContaining({
          eventGameId: "game-new",
          terminalReason: "game-locked",
          codeStateBefore: "present",
          codeState: "erased",
        }),
      ]);
      expect(
        restoredState.audit
          .filter((entry) => entry.action === "session-terminated")
          .map((entry) => [entry.eventGameId, entry.terminalReason]),
      ).toEqual(
        expect.arrayContaining([
          ["game-other", "game-locked"],
          ["game-new", "game-locked"],
          ["game-past", "past-game-day"],
        ]),
      );
      if (restored.completionEvidencePath === null) {
        throw new Error("Expected completed restore evidence.");
      }
      expect(
        JSON.stringify(JSON.parse(readFileSync(restored.completionEvidencePath, "utf8"))),
      ).not.toContain(control.grantId);
      reopened.close();
    });
  });

  test("retains base-contract present and disabled Grant Codes as audit-key material across readiness and backup", async () => {
    await withRecoveryPaths(async ({ livePath, backupDirectory }) => {
      const harness = await createHarness(livePath, backupDirectory);
      const authority = createGrantAuthority(harness.storage, harness.options.grant);
      const eventAdmin = await authority.createEventAdminGrant({
        authority: { kind: "technical-admin", id: "technical-admin" },
        scope: {
          eventId: "event-1",
          eventTimeZone: "UTC",
          finalGameDayDate: "2026-08-15",
        },
      });
      if (eventAdmin.status !== "created") throw new Error("Expected Event Admin Grant.");
      const eventSession = await authority.admitGrant({
        qrCredential: eventAdmin.qrCredential,
        browserContext: "event-admin-key-version",
      });
      if (eventSession.status !== "admitted") throw new Error("Expected Event Admin session.");
      const control = await authority.createControlGrant({
        authority: { kind: "grant-session", sessionBearer: eventSession.sessionBearer },
        scope: {
          eventId: "event-1",
          gameDayId: "day-1",
          pitchId: "pitch-1",
          pitchSlotId: "slot-1",
        },
      });
      if (control.status !== "created") throw new Error("Expected Control Grant.");
      const code = await authority.createGrantCode(control.grantId, {
        kind: "grant-session",
        sessionBearer: eventSession.sessionBearer,
      });
      if (code.status !== "created") throw new Error("Expected Control Grant Code.");

      const disabledControl = await authority.createControlGrant({
        authority: { kind: "grant-session", sessionBearer: eventSession.sessionBearer },
        scope: {
          eventId: "event-1",
          gameDayId: "day-1",
          pitchId: "pitch-1",
          pitchSlotId: "slot-2",
        },
      });
      if (disabledControl.status !== "created") {
        throw new Error("Expected disabled-Code Control Grant.");
      }
      const disabledCode = await authority.createGrantCode(disabledControl.grantId, {
        kind: "grant-session",
        sessionBearer: eventSession.sessionBearer,
      });
      if (disabledCode.status !== "created") throw new Error("Expected second Grant Code.");
      expect(
        await authority.disableGrantCode(disabledControl.grantId, {
          kind: "grant-session",
          sessionBearer: eventSession.sessionBearer,
        }),
      ).toMatchObject({ status: "updated" });

      const baseContractState = await harness.storage.transaction((transaction) => ({
        present: transaction.findGrantById(control.grantId)?.code,
        disabled: transaction.findGrantById(disabledControl.grantId)?.code,
      }));
      expect(baseContractState.present).toMatchObject({
        state: "present",
        lookupKeyVersion: harness.keyRing.audit.currentVersion,
      });
      expect(baseContractState.disabled).toMatchObject({
        state: "disabled",
        lookupKeyVersion: null,
      });
      harness.storage.close();

      const upgradedStorage = openSqliteFoundationStorage(livePath, {
        grantKeyRing: harness.keyRing,
        grantValidationContext: { environmentId: "test", keyRing: harness.keyRing },
      });
      upgradedStorage.setReadinessContext(harness.readinessContext);
      expect(await upgradedStorage.readiness()).toMatchObject({
        ok: true,
        schemaVersion: CURRENT_SCHEMA_VERSION,
      });
      const recovery = createFoundationRecovery(upgradedStorage, harness.options);

      const manifest = await recovery.createPreDeploymentBackup();
      expect(manifest.representedKeyVersions.lookup).toContain("lookup-v1");
      expect(manifest.representedKeyVersions.audit).toContain("audit-v1");
      const manifestPath = join(backupDirectory, `${manifest.snapshotId}.manifest.json`);
      upgradedStorage.close();

      const missingAuditKeyRing = {
        ...harness.keyRing,
        audit: {
          currentVersion: harness.keyRing.audit.currentVersion,
          keys: new Map<string, Uint8Array>(),
        },
      };
      const verificationStorage = openSqliteFoundationStorage(livePath, {
        grantKeyRing: missingAuditKeyRing,
        grantValidationContext: { environmentId: "test", keyRing: missingAuditKeyRing },
      });
      const verifier = createFoundationRecovery(verificationStorage, {
        ...harness.options,
        keyRing: missingAuditKeyRing,
        grant: { ...harness.options.grant, keyRing: missingAuditKeyRing },
      });
      expect(verifier.verifyBackup(manifestPath)).rejects.toThrow("supplied audit key ring");
      verificationStorage.close();
    });
  });

  test("aborts unavailable, ambiguous, and malformed per-session restore resolution", async () => {
    const rejectedResolutions = [
      { status: "unavailable" as const },
      { status: "conflict" as const },
      { status: "current" as const, eventGameId: "wrong-game" },
    ];
    for (const [index, rejectedResolution] of rejectedResolutions.entries()) {
      await withRecoveryPaths(async ({ livePath, backupDirectory }) => {
        const harness = await createHarness(livePath, backupDirectory);
        const authority = createLegacyControlGrantTestAuthority(
          harness.storage,
          harness.options.grant,
        );
        const created = await authority.createControlGrant({
          scope: createRecoveryRoot().externalScope,
          actor: { kind: "fixture", id: `restore-resolution-${index}` },
        });
        if (created.status !== "created") throw new Error("Expected Control Grant.");
        const admitted = await authority.admitControlGrant({
          qrCredential: created.qrCredential,
          browserContext: `restore-resolution-browser-${index}`,
        });
        if (admitted.status !== "admitted") throw new Error("Expected Control Session.");
        const manifest = await harness.recovery.createPreDeploymentBackup();
        harness.options.grant.controlScopeResolver.resolveSession = () => rejectedResolution;
        expect(
          harness.recovery.restore(join(backupDirectory, `${manifest.snapshotId}.manifest.json`)),
        ).rejects.toThrow("could not be resolved");
        expect(existsSync(livePath)).toBe(true);
      });
    }
  });

  test("binds recovery import to real composed acceptance and durable SQLite mutation", async () => {
    await withRecoveryPaths(async ({ livePath, backupDirectory }) => {
      const harness = await createHarness(livePath, backupDirectory);
      const root = { ...createRecoveryRoot(), eventGameId: "game-1" };
      root.ownership.eventGameId = root.eventGameId;
      const authority = createLegacyControlGrantTestAuthority(
        harness.storage,
        harness.options.grant,
      );
      const created = await authority.createControlGrant({
        scope: root.externalScope,
        actor: { kind: "fixture", id: "recovery-authority" },
      });
      if (created.status !== "created") throw new Error("Expected Control Grant.");
      const admitted = await authority.admitControlGrant({
        qrCredential: created.qrCredential,
        browserContext: "recovery-controller",
      });
      if (admitted.status !== "admitted") throw new Error("Expected Control Session.");
      const record = createEventGameRecord(harness.storage, {
        externalScopeResolver: createRecoveryScopeResolver(root),
        interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
        clock: () => 1_000,
      });
      expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
      const source = createMemoryRecoveredAction(root);
      const imported = await harness.recovery.importControllerRecovery({
        importId: "memory-import",
        recordId: root.recordId,
        eventGameId: root.eventGameId,
        sessionBearer: admitted.sessionBearer,
        currentGrant: {
          sessionId: admitted.grantSessionId,
          versionId: created.grantVersion,
        },
        currentLifecycle: structuredClone(root.lifecycle),
        sourceReference: "controller-retained-history",
        actions: [{ action: source, sourceAcceptedAtMs: source.acceptedAtMs }],
        gaps: [],
      });
      expect(imported.outcome.results.map((result) => result.status)).toEqual(["accepted"]);
      expect((await record.readActions()).map((stored) => stored.action.operationId)).toEqual([
        source.operationId,
      ]);
      expect(await record.readRecoveryProvenance()).toEqual([
        expect.objectContaining({
          importId: "memory-import",
          sourceOperationId: source.operationId,
          sourceAcceptedAtMs: source.acceptedAtMs,
        }),
      ]);
      harness.storage.close();

      const reopened = openSqliteFoundationStorage(livePath, {
        grantKeyRing: harness.keyRing,
        grantValidationContext: { environmentId: "test", keyRing: harness.keyRing },
      });
      reopened.setReadinessContext(harness.readinessContext);
      const durableRecord = createEventGameRecord(reopened, {
        externalScopeResolver: createRecoveryScopeResolver(root),
        interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
        clock: () => 1_000,
      });
      expect(await durableRecord.registerRoot(root)).toMatchObject({ status: "idempotent" });
      expect(
        (await durableRecord.readActions()).map((stored) => stored.action.operationId),
      ).toEqual([source.operationId]);
      reopened.close();
    });
  });
});

async function createFastAdHocRecoveryAdapter(databasePath: string, liveContent: string) {
  const factsFor = (content: string): AdHocRecoveryFacts => ({
    version: AD_HOC_RECOVERY_MANIFEST_VERSION,
    schemaVersion: 1,
    environmentIdentity: "test",
    retainedGameCount: 1,
    unfinishedGameCount: 1,
    creationEventCount: 1,
    logicalDigest: createHash("sha256").update(content).digest("hex"),
    capacityEvidenceDigest: createHash("sha256").update(`capacity:${content}`).digest("hex"),
  });
  await writeFile(databasePath, liveContent, { mode: 0o600 });
  let current = liveContent;
  const adapter: AdHocRecoveryAdapter = {
    databasePath,
    environmentIdentity: "test",
    async createRecoveryVacuumSnapshot(destinationPath) {
      await writeFile(destinationPath, current, { mode: 0o600 });
      return factsFor(current);
    },
    async verifyRecoverySnapshot(path, expected) {
      const actual = factsFor(await readFile(path, "utf8"));
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error("Fast Ad Hoc snapshot facts changed.");
      return actual;
    },
    inspectRecoveryDatabase(path) {
      return factsFor(readFileSync(path, "utf8"));
    },
    readiness() {
      return { ok: true, status: "ready", facts: factsFor(current) };
    },
    async quiesceForRecovery() {},
  };
  return {
    adapter,
    setLive(content: string) {
      current = content;
      writeFileSync(databasePath, content, { mode: 0o600 });
    },
    readLive() {
      return readFileSync(databasePath, "utf8");
    },
  };
}

async function expectRejected(promise: Promise<unknown>, message?: string): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  if (message !== undefined) expect((failure as Error).message).toContain(message);
}

async function withRecoveryPaths(
  work: (paths: { livePath: string; backupDirectory: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "quadball-timer-recovery-"));
  const liveDirectory = join(root, "live");
  const backupDirectory = join(root, "backup");
  const livePath = join(liveDirectory, "foundation.sqlite");
  await mkdir(liveDirectory, { recursive: true });
  const setup = new Database(livePath, { create: true });
  setup.close();
  try {
    await work({ livePath, backupDirectory });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createHarness(
  livePath: string,
  backupDirectory: string,
  createId: () => string = (() => {
    let value = 0;
    return () => `recovery-${++value}`;
  })(),
) {
  const keyRing = createGrantTestKeyRing();
  const readinessContext = {
    actionCodecRegistry: (
      await import("@/lib/event-game-actions")
    ).createControlActionCodecRegistry(),
    interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
  };
  const grant: GrantAuthorityOptions = {
    environmentId: "test",
    clock: { nowMs: () => 10 },
    randomness: createGrantTestRandomness(),
    keyRing,
    controlScopeResolver: {
      resolve: () => ({ status: "eligible", eventGameId: "game-1" }),
      resolveSession: (_scope, sessionEventGameId) => ({
        status: "current",
        eventGameId: sessionEventGameId,
      }),
    },
    privilegedAuthorityVerifier: createGrantTestAuthorityVerifier(),
  };
  const storage = openSqliteFoundationStorage(livePath, {
    grantKeyRing: keyRing,
    grantValidationContext: { environmentId: "test", keyRing },
  });
  await storage.applyMigrations({ requireCandidate: false });
  storage.setReadinessContext(readinessContext);
  const options = {
    backupDirectory,
    keyRing,
    readinessContext,
    grant,
    acceptance: {
      externalScopeResolver: createPermissiveRecoveryScopeResolver(),
      clock: () => 10,
      interpreter: readinessContext.interpreter,
    },
    technicalAdminAuth: {
      databasePath: join(dirname(livePath), "technical-admin.sqlite"),
      async quiesce() {},
    },
    nowMs: () => 10,
    createId,
  };
  return {
    storage,
    recovery: createFoundationRecovery(storage, options),
    options,
    keyRing,
    readinessContext,
  };
}

function createPermissiveRecoveryScopeResolver() {
  return {
    resolve(scope: EventGameRecordRoot["externalScope"]) {
      return { status: "resolved" as const, scope: structuredClone(scope) };
    },
    resolveEventTeam() {
      return { status: "resolved" as const };
    },
  };
}

function createRecoveredAction(): ControlAction {
  return {
    controlActionVersion: "control-action-v1",
    recordId: "record-1",
    eventGameId: "game-1",
    operationId: "original-operation-1",
    kind: { id: "game-fact", version: "1" },
    payload: { factId: "fact-1", factType: "score", gameSideId: "side-1", value: 1 },
    causalPredecessorIds: [],
    occurrence: { trustedAtMs: 6, clientOriginAtMs: 5, source: "offline" },
    grant: { sessionId: "old-session", versionId: "old-version" },
    lifecycle: {
      phase: "scheduled",
      commencedAtMs: null,
      finishedAtMs: null,
      lockedAtMs: null,
      lockReason: null,
    },
    acceptedAtMs: 7,
    interpretation: {
      type: "fact",
      factId: "fact-1",
      factType: "score",
      gameSideId: "side-1",
      payload: { value: 1 },
    },
  };
}

function createRecoveryRoot(): EventGameRecordRoot {
  return {
    recordId: "recovery-record",
    eventId: "recovery-event",
    eventGameId: "recovery-game",
    ownership: { eventId: "recovery-event", eventGameId: "recovery-game" },
    externalScope: {
      eventId: "recovery-event",
      gameDayId: "recovery-day",
      pitchId: "recovery-pitch",
      pitchSlotId: "recovery-slot",
    },
    gameSides: [
      { id: "side-a", eventTeamId: "team-a", teamInterpretationRef: "team-a-v1" },
      { id: "side-b", eventTeamId: "team-b", teamInterpretationRef: "team-b-v1" },
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
      operationId: "register-recovery",
      actorReference: "actor-recovery",
      source: "event-game-registration",
      createdAtMs: 500,
    },
  };
}

function createRecoveryScopeResolver(root: EventGameRecordRoot) {
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

function createMemoryRecoveredAction(root: EventGameRecordRoot): ControlAction {
  return {
    controlActionVersion: "control-action-v1",
    recordId: root.recordId,
    eventGameId: root.eventGameId,
    operationId: "controller-original-operation",
    kind: { id: "game-fact", version: "1" },
    payload: {
      factId: "recovered-fact",
      factType: "test",
      gameSideId: "side-a",
      gameTimeMs: 1,
      data: { recovered: true },
    },
    causalPredecessorIds: [],
    occurrence: { trustedAtMs: 900, clientOriginAtMs: 800, source: "offline" },
    grant: { sessionId: "historical-session", versionId: "historical-version" },
    lifecycle: structuredClone(root.lifecycle),
    acceptedAtMs: 900,
    interpretation: {
      type: "fact",
      factId: "recovered-fact",
      factType: "test",
      gameSideId: "side-a",
      payload: { recovered: true },
    },
  };
}
