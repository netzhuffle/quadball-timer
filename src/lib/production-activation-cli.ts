import { createControlActionCodecRegistry } from "./event-game-actions";
import { createLiveEventGameIqaInterpreter } from "./live-event-game-control";
import { createFoundationRecovery } from "./foundation-recovery";
import { createSqliteAdHocRecoveryAdapter, resolveAdHocEnvironmentIdentity } from "./ad-hoc-games";
import {
  openSqliteFoundationStorage,
  readSqliteFoundationStorageReadiness,
} from "./foundation-storage-sqlite";
import { readGrantAuthorityOptions } from "./grant-runtime";
import { readRuntimeConfig } from "./runtime-config";
import {
  assertProductionBackupMetadata,
  requireProductionAdHocBackup,
  promoteVerifiedBackup,
  type ProductionBackupMetadata,
} from "./production-activation";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

type MaintenanceCommand =
  | "backup"
  | "verify-backup"
  | "promote"
  | "validate-migration"
  | "apply-migrations"
  | "readiness"
  | "preflight";

type FocusedFailurePhase =
  | "preflight"
  | "backup-create"
  | "backup-verify"
  | "backup-promote"
  | "candidate-validation"
  | "live-migration"
  | "readiness";

function injectFocusedFailure(phase: FocusedFailurePhase): void {
  if (
    process.env.QBT_FOCUSED_TEST_MODE === "1" &&
    process.env.QBT_FOCUSED_FAILURE_PHASE === phase
  ) {
    throw new Error(`Focused activation failure at ${phase}.`);
  }
}

/** Host-local maintenance entrypoint used by the shipped compiled executable. */
export async function runProductionActivationCli(argv: readonly string[]): Promise<number> {
  const command = argv[0] as MaintenanceCommand | undefined;
  if (
    command !== "backup" &&
    command !== "verify-backup" &&
    command !== "promote" &&
    command !== "validate-migration" &&
    command !== "apply-migrations" &&
    command !== "readiness" &&
    command !== "preflight"
  ) {
    console.error("Unknown activation maintenance command.");
    return 2;
  }

  const { technicalAdmin, storagePaths } = readRuntimeConfig();
  const grant = readGrantAuthorityOptions(technicalAdmin.environment);
  if (
    technicalAdmin.environment !== "production" &&
    (command === "backup" || command === "verify-backup" || command === "promote")
  ) {
    throw new Error("Production backup operations are unavailable in the Test Environment.");
  }
  if (command === "readiness") {
    injectFocusedFailure("readiness");
    const readiness = await readSqliteFoundationStorageReadiness(storagePaths.foundationDatabase, {
      grantKeyRing: grant.keyRing,
      grantValidationContext: { environmentId: technicalAdmin.environment, keyRing: grant.keyRing },
    });
    console.log(
      JSON.stringify({
        ok: readiness.ok,
        schemaVersion: readiness.ok ? readiness.schemaVersion : null,
        migration: readiness.evidence?.migration ?? null,
      }),
    );
    return readiness.ok ? 0 : 1;
  }
  const storage = openSqliteFoundationStorage(storagePaths.foundationDatabase, {
    grantKeyRing: grant.keyRing,
    grantValidationContext: { environmentId: technicalAdmin.environment, keyRing: grant.keyRing },
  });
  const readinessContext = {
    actionCodecRegistry: createControlActionCodecRegistry(),
    interpreter: createLiveEventGameIqaInterpreter(),
  };
  storage.setReadinessContext(readinessContext);
  try {
    if (command === "preflight") {
      injectFocusedFailure("preflight");
      const migration = await storage.migrationPreflight();
      const compatible =
        migration.status === "ready" ||
        migration.status === "pending" ||
        migration.status === "missing";
      console.log(
        JSON.stringify({ compatible, schemaVersion: migration.schemaVersion, migration }),
      );
      return compatible ? 0 : 1;
    }
    if (command === "validate-migration") {
      injectFocusedFailure("candidate-validation");
      const candidate = await storage.validateCandidate();
      console.log(JSON.stringify({ ready: candidate.ready, migration: candidate.migration }));
      return candidate.ready ? 0 : 1;
    }
    if (command === "apply-migrations") {
      injectFocusedFailure("live-migration");
      const migration = await storage.applyMigrations({ requireCandidate: true });
      console.log(JSON.stringify(migration));
      return 0;
    }

    const backupDirectory = resolve(
      process.env.FOUNDATION_BACKUP_DIRECTORY ?? "/var/lib/quadball-timer/backups",
    );
    const sourceReleaseAttemptId = process.env.RELEASE_ATTEMPT_ID;
    if (command === "promote" && sourceReleaseAttemptId === undefined) {
      throw new Error("Release identity is required for backup promotion.");
    }
    const candidateDirectory =
      command === "promote"
        ? join(backupDirectory, `.candidate-${sourceReleaseAttemptId}`)
        : backupDirectory;
    const recoveryDirectory = command === "promote" ? candidateDirectory : backupDirectory;
    const expectedAdHocDatabasePath = join(
      dirname(storagePaths.foundationDatabase),
      "ad-hoc.sqlite",
    );
    const adHocDatabasePath = process.env.AD_HOC_DATABASE?.trim() || expectedAdHocDatabasePath;
    if (adHocDatabasePath !== expectedAdHocDatabasePath) {
      throw new Error("Production Ad Hoc database must share the Environment database directory.");
    }
    const adHocEnvironmentIdentity = resolveAdHocEnvironmentIdentity(
      technicalAdmin.environment,
      technicalAdmin.origin,
      process.env.AD_HOC_ENVIRONMENT_ID,
    );
    const recovery = createFoundationRecovery(storage, {
      backupDirectory: recoveryDirectory,
      keyRing: grant.keyRing,
      readinessContext,
      adHoc: createSqliteAdHocRecoveryAdapter(adHocDatabasePath, adHocEnvironmentIdentity),
      grant: {
        ...grant,
        controlScopeResolver: {
          resolve: () => ({ status: "unavailable", detail: "Control scope is unavailable." }),
          resolveSession: () => ({
            status: "unavailable",
            detail: "Control scope is unavailable.",
          }),
        },
      },
      acceptance: {
        externalScopeResolver: {
          resolve(scope, snapshot) {
            return snapshot.findEvent(scope.eventId) === null
              ? { status: "missing", detail: "Event is unavailable." }
              : { status: "resolved", scope: structuredClone(scope) };
          },
          resolveEventTeam(eventId, eventTeamId, snapshot) {
            const event = snapshot.findEvent(eventId);
            return event !== null && snapshot.findEventTeam(eventTeamId) !== null
              ? { status: "resolved" }
              : { status: "missing", detail: "Event Team is unavailable." };
          },
        },
        interpreter: readinessContext.interpreter,
      },
      technicalAdminAuth: {
        // Backup-only activation deliberately supplies no live auth-store
        // path; #81 requires this option for restore but creation never uses
        // it. Policy A keeps the separate Technical Admin store out of scope.
        databasePath: join(recoveryDirectory, ".technical-admin-unused"),
        // The activation script has already stopped the service. This seam is
        // intentionally separate and never opens, copies, or mutates auth data.
        async quiesce() {},
        // #165 does not expose Foundation restore. Keep the current Policy A
        // adapter boundary fail-closed without pulling #166 into activation.
        adapter: {
          async prepareForFoundationRestore() {
            throw new Error("Foundation restore is not part of Production activation.");
          },
        },
      },
    });
    if (command === "backup") {
      injectFocusedFailure("backup-create");
      const manifest = await recovery.createPreDeploymentBackup();
      const adHoc = requireProductionAdHocBackup(manifest);
      const manifestPath = join(backupDirectory, `${manifest.snapshotId}.manifest.json`);
      const schemaCompatibility = process.env.SCHEMA_COMPATIBILITY;
      if (sourceReleaseAttemptId === undefined || schemaCompatibility === undefined) {
        throw new Error("Release and schema identity are required for a Production backup.");
      }
      const currentMigration = await storage.migrationPreflight();
      const metadata = {
        environment: "production" as const,
        createdAtMs: manifest.snapshotAtMs,
        sourceReleaseAttemptId,
        schemaCompatibility,
        migrationLedgerSchemaVersion: String(currentMigration.schemaVersion),
        databaseSha256: manifest.databaseSha256,
        representedKeyVersions: manifest.representedKeyVersions,
        adHoc: { databaseSha256: adHoc.databaseSha256, facts: adHoc.facts },
      };
      assertProductionBackupMetadata(
        { manifest, metadata },
        { sourceReleaseAttemptId, schemaCompatibility },
      );
      await writeFile(
        join(backupDirectory, `${manifest.snapshotId}.deployment.json`),
        `${JSON.stringify(metadata)}\n`,
        { mode: 0o600, flag: "wx" },
      );
      console.log(JSON.stringify({ manifestPath, snapshotId: manifest.snapshotId, metadata }));
      return 0;
    }
    const manifestPath = process.env.BACKUP_MANIFEST_PATH;
    const schemaCompatibility = process.env.SCHEMA_COMPATIBILITY;
    if (manifestPath === undefined) throw new Error("Backup manifest path is required.");
    if (sourceReleaseAttemptId === undefined || schemaCompatibility === undefined) {
      throw new Error("Release and schema identity are required for backup verification.");
    }
    if (dirname(resolve(manifestPath)) !== candidateDirectory) {
      throw new Error("Backup manifest is outside its candidate directory.");
    }
    const verifyCandidate = async () => {
      injectFocusedFailure(command === "promote" ? "backup-promote" : "backup-verify");
      const manifest = await recovery.verifyBackup(manifestPath);
      requireProductionAdHocBackup(manifest);
      if (basename(manifestPath) !== `${manifest.snapshotId}.manifest.json`) {
        throw new Error("Backup manifest filename does not match its snapshot identity.");
      }
      const databasePath = join(candidateDirectory, manifest.databaseFile);
      const metadataPath = join(dirname(manifestPath), `${manifest.snapshotId}.deployment.json`);
      for (const path of [manifestPath, databasePath, metadataPath]) {
        const info = await lstat(path);
        if (!info.isFile()) throw new Error("Backup candidate contains a non-regular file.");
      }
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as ProductionBackupMetadata;
      assertProductionBackupMetadata(
        { manifest, metadata },
        { sourceReleaseAttemptId, schemaCompatibility },
      );
      return { manifest, metadata };
    };
    if (command === "promote") {
      // The root maintenance wrapper owns the backup parent and performs the
      // final pointer swap.  The service user still performs the complete
      // candidate re-verification here, but must not attempt to rename the
      // candidate into the root-controlled retained area.
      if (process.env.QBT_ROOT_PROMOTION === "1") {
        const { manifest } = await verifyCandidate();
        console.log(JSON.stringify({ verified: true, snapshotId: manifest.snapshotId }));
        return 0;
      }
      const promotion = await promoteVerifiedBackup({
        backupDirectory,
        candidateDirectory,
        manifestPath,
        releaseAttemptId: sourceReleaseAttemptId,
        verifyCandidate,
      });
      console.log(JSON.stringify({ promoted: true, manifestPath, ...promotion }));
      return 0;
    }
    const { manifest } = await verifyCandidate();
    console.log(JSON.stringify({ verified: true, snapshotId: manifest.snapshotId }));
    return 0;
  } finally {
    storage.close();
  }
}
