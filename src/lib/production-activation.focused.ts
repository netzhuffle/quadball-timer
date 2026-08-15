import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath as fsRealpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  createControlActionCodecRegistry,
  createDeterministicTestIqaInterpreter,
} from "@/lib/event-game-actions";
import { createGrantTestAuthorityVerifier } from "@/lib/grant-authority-test-support";
import { createGrantTestKeyRing, createGrantTestRandomness } from "@/lib/grant-authority-contract";
import { grantKeyRingToDocument, writeGrantKeyRingFile } from "@/lib/grant-key-ring-custody";
import { FOUNDATION_MIGRATIONS } from "@/lib/foundation-migrations";
import {
  createFoundationRecovery,
  type FoundationRecoveryManifest,
} from "@/lib/foundation-recovery";
import {
  openSqliteFoundationStorage,
  readSqliteFoundationStorageReadiness,
} from "@/lib/foundation-storage-sqlite";
import {
  assertProductionBackupMetadata,
  promoteVerifiedBackup,
  requireProductionAdHocBackup,
  type ProductionBackupMetadata,
  type VerifiedProductionBackup,
} from "@/lib/production-activation";
import {
  createAdHocGamesService,
  createSqliteAdHocRecoveryAdapter,
  openSqliteAdHocStore,
} from "@/lib/ad-hoc-games";

const schemaVersion = String(FOUNDATION_MIGRATIONS.at(-1)?.schemaVersion ?? 0);

describe("disposable activation SQLite integration", () => {
  test("uses the wrapper and real executable across the lock and SQLite seam", async () => {
    const root = await fsRealpath(await mkdtemp(join(tmpdir(), "quadball-activation-wrapper-")));
    const binDirectory = join(root, "bin");
    const releaseDirectory = join(root, "srv/quadball-timer/releases/lock-test");
    const stateDirectory = join(root, "var/lib/quadball-timer");
    const keyRingPath = join(root, "etc/quadball-timer/production-grant-key-ring.json");
    const foundationPath = join(stateDirectory, "foundation.sqlite");
    const adHocPath = join(stateDirectory, "ad-hoc.sqlite");
    const authPath = join(stateDirectory, "technical-admin.sqlite");
    const wrapper = resolve("deploy/activation-maintenance-root.sh");
    const keyRing = createGrantTestKeyRing();
    const builtExecutable = join(root, "build-output/quadball-timer");
    try {
      await mkdir(binDirectory, { recursive: true });
      await mkdir(releaseDirectory, { recursive: true });
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      await mkdir(join(root, "var/backups"), { recursive: true });
      const auth = new Database(authPath);
      auth.exec(
        "CREATE TABLE auth_canary (value TEXT); INSERT INTO auth_canary VALUES ('private');",
      );
      auth.close();
      const authDigest = digest(authPath);
      writeGrantKeyRingFile(keyRingPath, grantKeyRingToDocument("production", keyRing), {
        requiredOwnerUid: process.getuid?.() ?? 0,
      });
      const legacy = openSqliteFoundationStorage(foundationPath, {
        migrations: FOUNDATION_MIGRATIONS.slice(0, 2),
        grantKeyRing: keyRing,
        grantValidationContext: { environmentId: "production", keyRing },
      });
      await legacy.applyMigrations({ requireCandidate: false });
      legacy.close();
      const adHocEnvironmentIdentity = "production:https://timer.quadball.app";
      const adHocStore = openSqliteAdHocStore(adHocPath, adHocEnvironmentIdentity);
      const adHocService = createAdHocGamesService({
        store: adHocStore,
        environmentIdentity: adHocEnvironmentIdentity,
        now: () => 10,
      });
      const createdAdHoc = await adHocService.create({
        homeName: "Focused Home",
        awayName: "Focused Away",
        sourceKey: "focused-production-backup",
        nowMs: 10,
      });
      expect(createdAdHoc.status).toBe("accepted");
      adHocService.close();
      await writeFile(
        join(releaseDirectory, "release-manifest.json"),
        JSON.stringify({ releaseAttemptId: "lock-test", schemaCompatibility: "foundation-v1" }),
      );
      const target =
        process.platform === "darwin"
          ? process.arch === "arm64"
            ? "bun-darwin-arm64"
            : "bun-darwin-x64"
          : process.platform === "linux"
            ? process.arch === "arm64"
              ? "bun-linux-arm64"
              : "bun-linux-x64-modern"
            : null;
      if (target === null)
        throw new Error(`Unsupported focused activation host: ${process.platform}`);
      const build = Bun.spawnSync([
        "bun",
        "run",
        "build.ts",
        "--compile",
        `--compile-target=${target}`,
        `--outfile=${builtExecutable}`,
      ]);
      if (build.exitCode !== 0) throw new Error(new TextDecoder().decode(build.stderr));
      await Bun.write(
        join(releaseDirectory, "quadball-timer"),
        await Bun.file(builtExecutable).arrayBuffer(),
      );
      await chmod(join(releaseDirectory, "quadball-timer"), 0o755);
      const systemctlStub = join(binDirectory, "systemctl");
      await writeFile(
        systemctlStub,
        '#!/bin/sh\n[ "$1" = is-active ] && { echo inactive; exit 0; }; exit 0\n',
      );
      await chmod(systemctlStub, 0o755);
      const runuserStub = join(binDirectory, "runuser");
      await writeFile(runuserStub, '#!/bin/sh\nshift 3\nexec "$@"\n');
      await chmod(runuserStub, 0o755);
      const flockStub = join(binDirectory, "flock");
      await writeFile(
        flockStub,
        '#!/bin/sh\n[ "$QBT_ACTIVATION_LOCK_PATH" = "$QBT_ACTIVATION_LOCK_HELD_PATH" ] && exit 1\nexit 0\n',
      );
      await chmod(flockStub, 0o755);
      const realpathStub = join(binDirectory, "realpath");
      await writeFile(
        realpathStub,
        '#!/bin/sh\n[ "$1" = -e ] && shift\n[ "$1" = -- ] && shift\n/bin/realpath "$@"\n',
      );
      await chmod(realpathStub, 0o755);

      const run = async (
        command: string,
        heldPath = "",
        manifestPath = "",
        failurePhase = "",
        releasePath = releaseDirectory,
      ) => {
        const child = Bun.spawn(
          ["bash", wrapper, "production", releasePath, command, manifestPath],
          {
            env: {
              PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
              SUDO_USER: "deploy-quadball-timer",
              QBT_FOCUSED_TEST_MODE: "1",
              QBT_FOCUSED_TEST_ROOT: root,
              QBT_FOCUSED_TEST_SYSTEMCTL: systemctlStub,
              QBT_FOCUSED_TEST_RUNUSER: runuserStub,
              QBT_FOCUSED_TEST_FLOCK: flockStub,
              QBT_FOCUSED_TEST_REALPATH: realpathStub,
              QBT_FOCUSED_TEST_SKIP_CHOWN: "1",
              QBT_ACTIVATION_LOCK_HELD_PATH: heldPath,
              QBT_FOCUSED_FAILURE_PHASE: failurePhase,
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        return {
          code: await child.exited,
          output: `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`,
        };
      };

      const canonicalLock = join(root, "srv/quadball-timer/.activation.lock");
      const preflightDigest = digest(foundationPath);
      const preflight = await run("preflight", canonicalLock);
      expect(preflight.code, preflight.output).toBe(0);
      expect(digest(foundationPath)).toBe(preflightDigest);
      expect((await run("readiness", canonicalLock)).code).not.toBe(0);
      expect(
        (await run("backup", join(root, "var/lib/quadball-timer/.activation.lock"))).code,
      ).not.toBe(0);
      const backup = await run("backup", canonicalLock);
      expect(backup.code, backup.output).toBe(0);
      const manifestPath = JSON.parse(backup.output).manifestPath as string;
      const backupManifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        adHoc?: { databaseFile?: string; facts?: { environmentIdentity?: string } };
      };
      expect(backupManifest.adHoc?.databaseFile).toBeTruthy();
      expect(backupManifest.adHoc?.facts?.environmentIdentity).toBe(adHocEnvironmentIdentity);
      const adHocBackupPath = join(dirname(manifestPath), backupManifest.adHoc?.databaseFile ?? "");
      expect(adHocBackupPath.startsWith(root)).toBe(true);
      expect(await pathExists(adHocBackupPath)).toBe(true);
      expect(backup.output).not.toContain("/var/lib/quadball-timer/ad-hoc.sqlite");
      expect(
        (
          await run(
            "verify-backup",
            join(root, "var/lib/quadball-timer/.activation.lock"),
            manifestPath,
          )
        ).code,
      ).not.toBe(0);
      expect((await run("verify-backup", canonicalLock, manifestPath)).code).toBe(0);
      expect(
        (await run("promote", join(root, "var/lib/quadball-timer/.activation.lock"), manifestPath))
          .code,
      ).not.toBe(0);
      expect((await run("promote", canonicalLock, manifestPath)).code).toBe(0);
      const retainedDirectory = join(root, "var/backups/quadball-timer/verified-lock-test");
      expect((await lstat(retainedDirectory)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(retainedDirectory, basename(manifestPath)))).mode & 0o777).toBe(
        0o600,
      );
      expect(await pathExists(join(root, "var/backups/quadball-timer/.candidate-lock-test"))).toBe(
        false,
      );

      const secondReleaseDirectory = join(root, "srv/quadball-timer/releases/lock-test-2");
      await mkdir(secondReleaseDirectory, { recursive: true });
      await Bun.write(
        join(secondReleaseDirectory, "quadball-timer"),
        await Bun.file(join(releaseDirectory, "quadball-timer")).arrayBuffer(),
      );
      await chmod(join(secondReleaseDirectory, "quadball-timer"), 0o755);
      await writeFile(
        join(secondReleaseDirectory, "release-manifest.json"),
        JSON.stringify({ releaseAttemptId: "lock-test-2", schemaCompatibility: "foundation-v1" }),
      );
      const secondBackup = await run("backup", canonicalLock, "", "", secondReleaseDirectory);
      expect(secondBackup.code, secondBackup.output).toBe(0);
      const secondManifestPath = JSON.parse(secondBackup.output).manifestPath as string;
      const secondPromote = await run(
        "promote",
        canonicalLock,
        secondManifestPath,
        "",
        secondReleaseDirectory,
      );
      expect(secondPromote.code, secondPromote.output).toBe(0);
      expect(await readlink(join(root, "var/backups/quadball-timer/retained"))).toBe(
        "verified-lock-test-2",
      );
      expect(await pathExists(retainedDirectory)).toBe(false);
      expect(
        (await lstat(join(root, "var/backups/quadball-timer/verified-lock-test-2"))).mode & 0o777,
      ).toBe(0o700);
      expect((await run("validate-migration", canonicalLock)).code).toBe(0);
      expect((await run("apply-migrations", canonicalLock)).code).toBe(0);
      expect((await run("readiness", canonicalLock)).code).toBe(0);
      const migrated = new Database(foundationPath, { readonly: true });
      const latestSchema = migrated
        .query("SELECT MAX(schema_version) AS schema_version FROM foundation_migration_ledger")
        .get() as { schema_version: number };
      migrated.close();
      expect(latestSchema.schema_version).toBe(Number(schemaVersion));
      expect(digest(authPath)).toBe(authDigest);

      const expectFocusedFailure = async (
        command: string,
        failurePhase: string,
        manifestPath = "",
      ) => {
        const failed = await run(command, canonicalLock, manifestPath, failurePhase);
        expect(failed.code, failurePhase).not.toBe(0);
        expect(failed.output, failurePhase).not.toContain("private");
        return failed;
      };
      const retainedBeforeFailures = await readlink(
        join(root, "var/backups/quadball-timer/retained"),
      );
      await expectFocusedFailure("preflight", "preflight");
      await expectFocusedFailure("readiness", "readiness");
      await expectFocusedFailure("validate-migration", "candidate-validation");
      const liveBeforeFailure = digest(foundationPath);
      await expectFocusedFailure("apply-migrations", "live-migration");
      expect(digest(foundationPath)).toBe(liveBeforeFailure);
      const failedBackup = await expectFocusedFailure("backup", "backup-create");
      expect(failedBackup.output).not.toContain('"manifestPath"');
      expect(await pathExists(join(root, "var/backups/quadball-timer/.candidate-lock-test"))).toBe(
        false,
      );
      const verifyFailureBackup = await run("backup", canonicalLock);
      const verifyFailureManifest = JSON.parse(verifyFailureBackup.output).manifestPath as string;
      await expectFocusedFailure("verify-backup", "backup-verify", verifyFailureManifest);
      expect(await pathExists(join(root, "var/backups/quadball-timer/.candidate-lock-test"))).toBe(
        false,
      );
      const promoteFailureBackup = await run("backup", canonicalLock);
      const promoteFailureManifest = JSON.parse(promoteFailureBackup.output).manifestPath as string;
      await expectFocusedFailure("promote", "backup-promote", promoteFailureManifest);
      expect(await readlink(join(root, "var/backups/quadball-timer/retained"))).toBe(
        retainedBeforeFailures,
      );

      const testReleaseDirectory = join(root, "srv/quadball-timer-test/releases/test-lock");
      await mkdir(testReleaseDirectory, { recursive: true });
      await writeFile(
        join(testReleaseDirectory, "release-manifest.json"),
        JSON.stringify({ releaseAttemptId: "test-lock", schemaCompatibility: "foundation-v1" }),
      );
      await Bun.write(
        join(testReleaseDirectory, "quadball-timer"),
        await Bun.file(builtExecutable).arrayBuffer(),
      );
      await chmod(join(testReleaseDirectory, "quadball-timer"), 0o755);
      const testChild = Bun.spawn(["bash", wrapper, "test", testReleaseDirectory, "backup"], {
        env: {
          PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
          SUDO_USER: "deploy-quadball-timer-test",
          QBT_FOCUSED_TEST_MODE: "1",
          QBT_FOCUSED_TEST_ROOT: root,
          QBT_FOCUSED_TEST_SYSTEMCTL: systemctlStub,
          QBT_FOCUSED_TEST_RUNUSER: runuserStub,
          QBT_FOCUSED_TEST_FLOCK: flockStub,
          QBT_FOCUSED_TEST_REALPATH: realpathStub,
          QBT_ACTIVATION_LOCK_HELD_PATH: join(root, "srv/quadball-timer-test/.activation.lock"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const testOutput = `${await new Response(testChild.stdout).text()}${await new Response(testChild.stderr).text()}`;
      expect(await testChild.exited).not.toBe(0);
      expect(testOutput).not.toContain("/var/backups/quadball-timer");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("verifies snapshot and sidecar, validates then applies migrations, and promotes safely", async () => {
    const root = await mkdtemp(join(tmpdir(), "quadball-activation-"));
    const livePath = join(root, "foundation.sqlite");
    const authPath = join(root, "technical-admin.sqlite");
    const backupParent = await mkdtemp(join(tmpdir(), "quadball-activation-backups-"));
    const backupRoot = join(backupParent, "backups");
    await mkdir(backupRoot, { recursive: true, mode: 0o700 });
    const keyRing = createGrantTestKeyRing();
    const readinessContext = createReadinessContext();
    const auth = new Database(authPath);
    auth.exec("CREATE TABLE auth_canary (value TEXT); INSERT INTO auth_canary VALUES ('private');");
    auth.close();
    const authDigest = digest(authPath);

    const storage = openSqliteFoundationStorage(livePath, {
      grantKeyRing: keyRing,
      grantValidationContext: { environmentId: "production", keyRing },
    });
    await storage.applyMigrations({ requireCandidate: false });
    storage.setReadinessContext(readinessContext);
    const beforeReadOnly = digest(livePath);
    const readiness = await readSqliteFoundationStorageReadiness(livePath, {
      grantKeyRing: keyRing,
      grantValidationContext: { environmentId: "production", keyRing },
    });
    expect(readiness.ok).toBe(true);
    expect(digest(livePath)).toBe(beforeReadOnly);

    const candidateDirectory = join(backupRoot, ".candidate-release-1");
    await mkdir(candidateDirectory, { recursive: true });
    await chmod(candidateDirectory, 0o700);
    const recovery = createRecovery(
      storage,
      candidateDirectory,
      authPath,
      keyRing,
      readinessContext,
    );
    try {
      const first = await recovery.createPreDeploymentBackup();
      const firstManifestPath = join(candidateDirectory, `${first.snapshotId}.manifest.json`);
      const firstMetadata = createMetadata(first, "release-1");
      const firstMetadataPath = join(candidateDirectory, `${first.snapshotId}.deployment.json`);
      await writeFile(firstMetadataPath, `${JSON.stringify(firstMetadata)}\n`);
      expect((await lstat(firstManifestPath)).isFile()).toBe(true);
      expect((await lstat(join(candidateDirectory, first.databaseFile))).isFile()).toBe(true);
      expect((await lstat(firstMetadataPath)).isFile()).toBe(true);
      const verifiedFirst = await verifyCandidate(
        recovery,
        candidateDirectory,
        firstManifestPath,
        firstMetadata,
      );
      expect(verifiedFirst).toMatchObject({ manifest: first, metadata: firstMetadata });

      await writeFile(firstManifestPath, `${JSON.stringify({ ...first, adHoc: undefined })}\n`);
      await expectRejected(
        verifyCandidate(recovery, candidateDirectory, firstManifestPath, firstMetadata),
        "Ad Hoc",
      );
      await writeFile(firstManifestPath, `${JSON.stringify(first)}\n`);

      const adHocBackupPath = join(
        candidateDirectory,
        requireProductionAdHocBackup(first).databaseFile,
      );
      const originalAdHocDatabase = await readFile(adHocBackupPath);
      await writeFile(adHocBackupPath, Buffer.from("tampered Ad Hoc backup"));
      await expectRejected(
        verifyCandidate(recovery, candidateDirectory, firstManifestPath, firstMetadata),
      );
      await writeFile(adHocBackupPath, originalAdHocDatabase);

      const tampered = { ...firstMetadata, databaseSha256: "0".repeat(64) };
      await writeFile(firstMetadataPath, `${JSON.stringify(tampered)}\n`);
      let tamperError: unknown;
      try {
        await verifyCandidate(recovery, candidateDirectory, firstManifestPath, tampered);
      } catch (error) {
        tamperError = error;
      }
      expect(tamperError).toBeInstanceOf(Error);
      await writeFile(firstMetadataPath, `${JSON.stringify(firstMetadata)}\n`);

      const originalDatabase = await readFile(join(candidateDirectory, first.databaseFile));
      const verifierTamperCases: Array<{ name: string; mutate(database: Database): void }> = [
        {
          name: "backup-policy",
          mutate: (database) =>
            database.exec("CREATE TABLE unapproved_backup_relation (value TEXT)"),
        },
        {
          name: "technical-admin-exclusion",
          mutate: (database) => database.exec("CREATE TABLE technical_admin_shadow (value TEXT)"),
        },
        {
          name: "grant-recovery-schema",
          mutate: (database) => database.exec("DROP TABLE foundation_grant_roots"),
        },
        {
          name: "foreign-key-schema",
          mutate: (database) => database.exec("DROP TABLE foundation_event_game_record_sides"),
        },
        {
          name: "idempotency-schema",
          mutate: (database) =>
            database.exec("DROP TABLE foundation_event_game_record_idempotency"),
        },
        {
          name: "replay-schema",
          mutate: (database) => database.exec("DROP TABLE foundation_event_game_record_actions"),
        },
      ];
      for (const tamperCase of verifierTamperCases) {
        await writeFile(join(candidateDirectory, first.databaseFile), originalDatabase);
        const tamperedDatabase = new Database(join(candidateDirectory, first.databaseFile));
        tamperCase.mutate(tamperedDatabase);
        tamperedDatabase.close();
        let rejected = false;
        try {
          await verifyCandidate(recovery, candidateDirectory, firstManifestPath, firstMetadata);
        } catch {
          rejected = true;
        }
        expect(rejected, tamperCase.name).toBe(true);
        expect(await pathExists(join(backupRoot, "retained")), tamperCase.name).toBe(false);
      }
      await writeFile(join(candidateDirectory, first.databaseFile), originalDatabase);

      await promoteVerifiedBackup({
        backupDirectory: backupRoot,
        candidateDirectory,
        manifestPath: firstManifestPath,
        releaseAttemptId: "release-1",
        verifyCandidate: () =>
          verifyCandidate(recovery, candidateDirectory, firstManifestPath, firstMetadata),
      });
      expect(await readlink(join(backupRoot, "retained"))).toBe("verified-release-1");

      const secondCandidateDirectory = join(backupRoot, ".candidate-release-2");
      await mkdir(secondCandidateDirectory, { recursive: true });
      await chmod(secondCandidateDirectory, 0o700);
      const secondRecovery = createRecovery(
        storage,
        secondCandidateDirectory,
        authPath,
        keyRing,
        readinessContext,
      );
      const second = await secondRecovery.createPreDeploymentBackup();
      const secondManifestPath = join(
        secondCandidateDirectory,
        `${second.snapshotId}.manifest.json`,
      );
      const secondMetadata = createMetadata(second, "release-2");
      await writeFile(
        join(secondCandidateDirectory, `${second.snapshotId}.deployment.json`),
        `${JSON.stringify(secondMetadata)}\n`,
      );
      const secondPromotion = await promoteVerifiedBackup({
        backupDirectory: backupRoot,
        candidateDirectory: secondCandidateDirectory,
        manifestPath: secondManifestPath,
        releaseAttemptId: "release-2",
        verifyCandidate: () =>
          verifyCandidate(
            secondRecovery,
            secondCandidateDirectory,
            secondManifestPath,
            secondMetadata,
          ),
        afterPointerReplace: () => {
          throw new Error("injected retained cleanup failure");
        },
      });
      expect(secondPromotion).toMatchObject({
        pointerCommitted: true,
        retainedTarget: "verified-release-2",
        cleanupWarning: "injected retained cleanup failure",
      });
      expect(await readlink(join(backupRoot, "retained"))).toBe("verified-release-2");
      expect(await pathExists(join(backupRoot, "verified-release-1"))).toBe(true);

      const failedCandidateDirectory = join(backupRoot, ".candidate-release-3");
      await mkdir(failedCandidateDirectory, { recursive: true });
      await chmod(failedCandidateDirectory, 0o700);
      const failedRecovery = createRecovery(
        storage,
        failedCandidateDirectory,
        authPath,
        keyRing,
        readinessContext,
      );
      const failed = await failedRecovery.createPreDeploymentBackup();
      const failedManifestPath = join(
        failedCandidateDirectory,
        `${failed.snapshotId}.manifest.json`,
      );
      const failedMetadata = createMetadata(failed, "release-3");
      await writeFile(
        join(failedCandidateDirectory, `${failed.snapshotId}.deployment.json`),
        `${JSON.stringify(failedMetadata)}\n`,
      );
      let promotionError: unknown;
      try {
        await promoteVerifiedBackup({
          backupDirectory: backupRoot,
          candidateDirectory: failedCandidateDirectory,
          manifestPath: failedManifestPath,
          releaseAttemptId: "release-3",
          verifyCandidate: () =>
            verifyCandidate(
              failedRecovery,
              failedCandidateDirectory,
              failedManifestPath,
              failedMetadata,
            ),
          beforePointerReplace: () => {
            throw new Error("injected promotion failure");
          },
        });
      } catch (error) {
        promotionError = error;
      }
      expect(promotionError).toBeInstanceOf(Error);
      expect(await pathExists(join(backupRoot, ".candidate-release-3"))).toBe(false);
      expect(await pathExists(join(backupRoot, "verified-release-3"))).toBe(false);
      expect(await pathExists(join(backupRoot, ".retained-release-3.tmp"))).toBe(false);

      const legacyRoot = join(root, "migration");
      await mkdir(legacyRoot, { recursive: true });
      const legacyPath = join(legacyRoot, "foundation.sqlite");
      const legacy = openSqliteFoundationStorage(legacyPath, {
        migrations: FOUNDATION_MIGRATIONS.slice(0, -1),
        grantKeyRing: keyRing,
        grantValidationContext: { environmentId: "production", keyRing },
      });
      await legacy.applyMigrations({ requireCandidate: false });
      legacy.close();
      const migrating = openSqliteFoundationStorage(legacyPath, {
        grantKeyRing: keyRing,
        grantValidationContext: { environmentId: "production", keyRing },
      });
      migrating.setReadinessContext(readinessContext);
      const migrationBefore = digest(legacyPath);
      const candidate = await migrating.validateCandidate();
      expect(candidate.ready).toBe(true);
      expect(await pathExists(candidate.candidatePath)).toBe(false);
      expect(digest(legacyPath)).toBe(migrationBefore);
      await migrating.applyMigrations({ requireCandidate: true });
      expect((await migrating.readiness()).ok).toBe(true);
      expect(digest(legacyPath)).not.toBe(migrationBefore);
      migrating.close();
      expect(digest(authPath)).toBe(authDigest);
    } finally {
      storage.close();
      await rm(root, { recursive: true, force: true });
      await rm(backupParent, { recursive: true, force: true });
    }
  });

  test("keeps Test isolated and without backup operations", () => {
    const wrapper = readFileSync(resolve("deploy/activation-maintenance-root.sh"), "utf8");
    const testWrapper = readFileSync(resolve("deploy/activate-test-release.sh"), "utf8");
    const unit = readFileSync(resolve("deploy/systemd/quadball-timer-test.service"), "utf8");
    expect(wrapper).toContain('public_origin="https://test.timer.quadball.app"');
    expect(wrapper).toContain('expected_caller="deploy-quadball-timer-test"');
    expect(wrapper).toContain('backup_directory=""');
    expect(testWrapper).not.toContain('"backup"');
    expect(unit).not.toContain("/var/lib/quadball-timer/");
    expect(unit).toContain("Environment=PUBLIC_ORIGIN=https://test.timer.quadball.app");
  });
});

function createReadinessContext() {
  return {
    actionCodecRegistry: createControlActionCodecRegistry(),
    interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
  };
}

function createRecovery(
  storage: Parameters<typeof createFoundationRecovery>[0],
  backupDirectory: string,
  authPath: string,
  keyRing: ReturnType<typeof createGrantTestKeyRing>,
  readinessContext: ReturnType<typeof createReadinessContext>,
) {
  return createFoundationRecovery(storage, {
    backupDirectory,
    keyRing,
    readinessContext,
    grant: {
      environmentId: "production",
      clock: { nowMs: () => 10 },
      randomness: createGrantTestRandomness(),
      keyRing,
      controlScopeResolver: {
        resolve: () => ({ status: "unavailable", detail: "focused" }),
        resolveSession: () => ({ status: "unavailable", detail: "focused" }),
      },
      privilegedAuthorityVerifier: createGrantTestAuthorityVerifier(),
    },
    acceptance: {
      externalScopeResolver: {
        resolve: (scope, snapshot) =>
          snapshot.findEvent(scope.eventId) === null
            ? { status: "missing", detail: "Event unavailable." }
            : { status: "resolved", scope: structuredClone(scope) },
        resolveEventTeam: (eventId, eventTeamId, snapshot) =>
          snapshot.findEvent(eventId) !== null && snapshot.findEventTeam(eventTeamId) !== null
            ? { status: "resolved" }
            : { status: "missing", detail: "Event Team unavailable." },
      },
      interpreter: readinessContext.interpreter,
    },
    technicalAdminAuth: {
      databasePath: authPath,
      async quiesce() {},
      adapter: {
        async prepareForFoundationRestore() {
          throw new Error("Foundation restore is not part of Production activation.");
        },
      },
    },
    adHoc: (() => {
      const adHocPath = join(dirname(storage.databasePath), "ad-hoc.sqlite");
      const adHocEnvironmentIdentity = "production:https://timer.quadball.app";
      if (!existsSync(adHocPath)) {
        const store = openSqliteAdHocStore(adHocPath, adHocEnvironmentIdentity);
        store.close();
      }
      return createSqliteAdHocRecoveryAdapter(adHocPath, adHocEnvironmentIdentity);
    })(),
    nowMs: () => 10,
    createId: (() => {
      let sequence = 0;
      return () => `focused-${++sequence}`;
    })(),
  });
}

function createMetadata(
  manifest: FoundationRecoveryManifest,
  sourceReleaseAttemptId: string,
): ProductionBackupMetadata {
  const adHoc = requireProductionAdHocBackup(manifest);
  const metadata: ProductionBackupMetadata = {
    environment: "production",
    createdAtMs: manifest.snapshotAtMs,
    sourceReleaseAttemptId,
    schemaCompatibility: "foundation-v1",
    migrationLedgerSchemaVersion: schemaVersion,
    databaseSha256: manifest.databaseSha256,
    representedKeyVersions: manifest.representedKeyVersions,
    adHoc: { databaseSha256: adHoc.databaseSha256, facts: adHoc.facts },
  };
  assertProductionBackupMetadata(
    { manifest, metadata },
    { sourceReleaseAttemptId, schemaCompatibility: "foundation-v1" },
  );
  return metadata;
}

async function verifyCandidate(
  recovery: ReturnType<typeof createRecovery>,
  candidateDirectory: string,
  manifestPath: string,
  metadata: ProductionBackupMetadata,
): Promise<VerifiedProductionBackup> {
  const manifest = await recovery.verifyBackup(manifestPath);
  if (basename(manifestPath) !== `${manifest.snapshotId}.manifest.json`) {
    throw new Error("Backup manifest filename does not match its snapshot identity.");
  }
  const databasePath = join(candidateDirectory, manifest.databaseFile);
  const metadataPath = join(candidateDirectory, `${manifest.snapshotId}.deployment.json`);
  for (const path of [manifestPath, databasePath, metadataPath]) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Backup candidate is not regular.");
  }
  const returnedMetadata = JSON.parse(
    await readFile(metadataPath, "utf8"),
  ) as ProductionBackupMetadata;
  expect(returnedMetadata).toEqual(metadata);
  assertProductionBackupMetadata(
    { manifest, metadata: returnedMetadata },
    {
      sourceReleaseAttemptId: metadata.sourceReleaseAttemptId,
      schemaCompatibility: metadata.schemaCompatibility,
    },
  );
  return { manifest, metadata: returnedMetadata };
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function pathExists(path: string): Promise<boolean> {
  return lstat(path)
    .then(() => true)
    .catch(() => false);
}

async function expectRejected(
  operation: Promise<unknown>,
  expectedMessage?: string,
): Promise<void> {
  let error: unknown;
  try {
    await operation;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  if (expectedMessage !== undefined) expect(String(error)).toContain(expectedMessage);
}
