import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { createControlActionCodecRegistry } from "./event-game-actions";
import { createLiveEventGameIqaInterpreter } from "./live-event-game-control";
import { createFoundationRecovery, FoundationRestoreFailure } from "./foundation-recovery";
import { createSqliteAdHocRecoveryAdapter, resolveAdHocEnvironmentIdentity } from "./ad-hoc-games";
import {
  openSqliteFoundationStorage,
  readSqliteFoundationStorageReadiness,
} from "./foundation-storage-sqlite";
import { readGrantAuthorityOptions } from "./grant-runtime";
import { readRuntimeConfig } from "./runtime-config";
import {
  createSqliteTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
  type TechnicalAdminStorageIdentity,
} from "./technical-admin-auth";
import {
  assertProductionBackupMetadata,
  requireProductionAdHocBackup,
  promoteVerifiedBackup,
  type ProductionBackupMetadata,
} from "./production-activation";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open as openFile,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

type MaintenanceCommand =
  | "backup"
  | "verify-backup"
  | "promote"
  | "restore"
  | "validate-migration"
  | "apply-migrations"
  | "readiness"
  | "authoritative-operation"
  | "preflight";

type FocusedFailurePhase =
  | "preflight"
  | "backup-create"
  | "backup-verify"
  | "backup-promote"
  | "restore"
  | "candidate-validation"
  | "live-migration"
  | "readiness"
  | "authoritative-operation-write";

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
  const rootPromotionRequested =
    process.env.QBT_ROOT_PROMOTION === "1" || argv.includes("--root-promotion");
  if (
    command !== "backup" &&
    command !== "verify-backup" &&
    command !== "promote" &&
    command !== "restore" &&
    command !== "validate-migration" &&
    command !== "apply-migrations" &&
    command !== "readiness" &&
    command !== "authoritative-operation" &&
    command !== "preflight"
  ) {
    console.error("Unknown activation maintenance command.");
    return 2;
  }

  let technicalAdmin: ReturnType<typeof readRuntimeConfig>["technicalAdmin"];
  let storagePaths: ReturnType<typeof readRuntimeConfig>["storagePaths"];
  let grant: ReturnType<typeof readGrantAuthorityOptions>;
  try {
    ({ technicalAdmin, storagePaths } = readRuntimeConfig());
    grant = readGrantAuthorityOptions(technicalAdmin.environment);
  } catch (error) {
    if (command === "restore") {
      emitBoundedRestoreFailure(error);
      return 1;
    }
    throw error;
  }
  if (
    technicalAdmin.environment !== "production" &&
    (command === "backup" ||
      command === "verify-backup" ||
      command === "promote" ||
      command === "restore")
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
  if (command === "authoritative-operation") {
    let transactionOpen = false;
    const database = new Database(storagePaths.foundationDatabase);
    try {
      const digestBefore = createHash("sha256")
        .update(await readFile(storagePaths.foundationDatabase))
        .digest("hex");
      database.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      if (
        process.env.QBT_FOCUSED_TEST_MODE === "1" &&
        process.env.QBT_FOCUSED_FAILURE_PHASE === "authoritative-operation-write"
      ) {
        database.exec("PRAGMA query_only = ON");
      }
      database.exec(`
        CREATE TABLE __quadball_restore_writeability_probe (id INTEGER PRIMARY KEY);
        INSERT INTO __quadball_restore_writeability_probe (id) VALUES (1);
      `);
      database.exec("ROLLBACK");
      transactionOpen = false;
      const probeAbsent =
        database
          .query(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '__quadball_restore_writeability_probe'",
          )
          .get() === null;
      const digestAfter = createHash("sha256")
        .update(await readFile(storagePaths.foundationDatabase))
        .digest("hex");
      if (!probeAbsent || digestAfter !== digestBefore) {
        throw new Error("Bounded authoritative operation changed Foundation state.");
      }
      console.log(JSON.stringify({ ok: true, operation: "bounded-writeability-probe" }));
      return 0;
    } catch {
      if (transactionOpen) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // The bounded failure remains non-secret and fail closed.
        }
      }
      console.log(JSON.stringify({ ok: false, operation: "bounded-writeability-probe" }));
      return 1;
    } finally {
      database.close();
    }
  }
  let storage: ReturnType<typeof openSqliteFoundationStorage> | null = null;
  let technicalAdminRepository: ReturnType<typeof createSqliteTechnicalAdminAuthRepository> | null =
    null;
  let technicalAdminAuth: ReturnType<typeof createTechnicalAdminAuth> | null = null;
  let technicalAdminStoragePresent = true;
  // A missing store remains the canonical reason: "missing"; invalid filesystem
  // objects are rejected before the repository can follow or mutate them.
  let technicalAdminStorageReason: "missing" | "invalid" | "incompatible" = "missing";
  const readinessContext = {
    actionCodecRegistry: createControlActionCodecRegistry(),
    interpreter: createLiveEventGameIqaInterpreter(),
  };
  try {
    storage = openSqliteFoundationStorage(storagePaths.foundationDatabase, {
      grantKeyRing: grant.keyRing,
      grantValidationContext: { environmentId: technicalAdmin.environment, keyRing: grant.keyRing },
    });
    storage.setReadinessContext(readinessContext);
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
    if (command === "restore" && sourceReleaseAttemptId === undefined) {
      throw new Error("Release identity is required for Production restore.");
    }
    if (
      command === "restore" &&
      (sourceReleaseAttemptId === undefined ||
        !/^[A-Za-z0-9._-]{1,128}$/.test(sourceReleaseAttemptId))
    ) {
      throw new Error("Production restore release identity is unsafe.");
    }
    const manifestPath = process.env.BACKUP_MANIFEST_PATH;
    let restoreManifestPath = manifestPath;
    const restoreDirectory =
      command === "restore" ? process.env.RESTORE_WORKSPACE_DIRECTORY?.trim() || null : null;
    if (command === "restore") {
      if (manifestPath === undefined || restoreDirectory === null) {
        throw new Error("Restore workspace and manifest are required.");
      }
      const expectedRestoreDirectoryPrefix = join(
        backupDirectory,
        `.restore-${sourceReleaseAttemptId}-`,
      );
      const resolvedRestoreDirectory = resolve(restoreDirectory);
      if (
        !resolvedRestoreDirectory.startsWith(expectedRestoreDirectoryPrefix) ||
        !/^[A-Za-z0-9._-]{6,128}$/u.test(
          resolvedRestoreDirectory.slice(expectedRestoreDirectoryPrefix.length),
        )
      ) {
        throw new Error("Restore workspace is outside the bounded restore directory.");
      }
      const restoreDirectoryInfo = await lstat(resolvedRestoreDirectory);
      const selectedManifestPath = resolve(manifestPath);
      const rootStagedManifest = dirname(selectedManifestPath) === resolvedRestoreDirectory;
      const currentUid = process.getuid?.();
      if (
        !restoreDirectoryInfo.isDirectory() ||
        restoreDirectoryInfo.isSymbolicLink() ||
        (restoreDirectoryInfo.mode & 0o777) !== 0o700 ||
        (currentUid !== undefined && restoreDirectoryInfo.uid !== currentUid)
      ) {
        throw new Error("Restore workspace is not a private directory.");
      }
      await copyStableRestoreFile(
        storagePaths.foundationDatabase,
        join(resolvedRestoreDirectory, "failed-live-foundation.sqlite"),
      );
      if (rootStagedManifest) {
        const stagedEntries = await readdir(resolvedRestoreDirectory);
        if (stagedEntries.length !== 5) {
          throw new Error("Restore workspace contains an unexpected staged input set.");
        }
        for (const stagedEntry of stagedEntries) {
          const stagedInfo = await lstat(join(resolvedRestoreDirectory, stagedEntry));
          if (
            !stagedInfo.isFile() ||
            stagedInfo.isSymbolicLink() ||
            (stagedInfo.mode & 0o777) !== 0o600 ||
            (currentUid !== undefined && stagedInfo.uid !== currentUid)
          ) {
            throw new Error("Restore workspace contains an unsafe staged input.");
          }
        }
      } else if ((await readdir(resolvedRestoreDirectory)).length !== 1) {
        throw new Error("Restore workspace contains unexpected input.");
      }
      if (!rootStagedManifest) {
        const selectedManifestRelativePath = relative(backupDirectory, selectedManifestPath);
        if (
          selectedManifestRelativePath === "" ||
          isAbsolute(selectedManifestRelativePath) ||
          selectedManifestRelativePath.startsWith("..") ||
          !/^verified-[A-Za-z0-9._-]+$/u.test(basename(dirname(selectedManifestPath)))
        ) {
          throw new Error("Production restore requires a promoted verified snapshot.");
        }
      }
      const selectedManifestInfo = await lstat(selectedManifestPath);
      if (!selectedManifestInfo.isFile() || selectedManifestInfo.isSymbolicLink()) {
        throw new Error("Restore manifest is not a regular file.");
      }
      const selectedManifest = JSON.parse(await readFile(selectedManifestPath, "utf8")) as {
        snapshotId?: unknown;
        databaseFile?: unknown;
        adHoc?: { databaseFile?: unknown } | null;
      };
      if (
        typeof selectedManifest.snapshotId !== "string" ||
        typeof selectedManifest.databaseFile !== "string" ||
        !/^[A-Za-z0-9._-]{1,128}$/.test(selectedManifest.snapshotId) ||
        selectedManifest.databaseFile !== `${selectedManifest.snapshotId}.sqlite`
      ) {
        throw new Error("Restore manifest database identity is invalid.");
      }
      if (basename(selectedManifestPath) !== `${selectedManifest.snapshotId}.manifest.json`) {
        throw new Error("Restore manifest filename does not match its snapshot identity.");
      }
      const selectedDatabasePath = join(
        dirname(selectedManifestPath),
        selectedManifest.databaseFile,
      );
      const selectedDatabaseInfo = await lstat(selectedDatabasePath);
      if (!selectedDatabaseInfo.isFile() || selectedDatabaseInfo.isSymbolicLink()) {
        throw new Error("Restore database is not a regular file.");
      }
      if (
        selectedManifest.adHoc === null ||
        typeof selectedManifest.adHoc !== "object" ||
        typeof selectedManifest.adHoc.databaseFile !== "string" ||
        selectedManifest.adHoc.databaseFile !== `${selectedManifest.snapshotId}.ad-hoc.sqlite`
      ) {
        throw new Error("Restore Ad Hoc database identity is invalid.");
      }
      const selectedAdHocPath = join(
        dirname(selectedManifestPath),
        selectedManifest.adHoc.databaseFile,
      );
      const selectedAdHocInfo = await lstat(selectedAdHocPath);
      if (!selectedAdHocInfo.isFile() || selectedAdHocInfo.isSymbolicLink()) {
        throw new Error("Restore Ad Hoc database is not a regular file.");
      }
      const selectedDeploymentPath = join(
        dirname(selectedManifestPath),
        `${selectedManifest.snapshotId}.deployment.json`,
      );
      const selectedDeploymentInfo = await lstat(selectedDeploymentPath);
      if (!selectedDeploymentInfo.isFile() || selectedDeploymentInfo.isSymbolicLink()) {
        throw new Error("Restore deployment metadata is not a regular file.");
      }
      if (!rootStagedManifest) {
        await copyStableRestoreFile(
          selectedManifestPath,
          join(resolvedRestoreDirectory, basename(selectedManifestPath)),
        );
        await copyStableRestoreFile(
          selectedDatabasePath,
          join(resolvedRestoreDirectory, selectedManifest.databaseFile),
        );
        await copyStableRestoreFile(
          selectedAdHocPath,
          join(resolvedRestoreDirectory, selectedManifest.adHoc.databaseFile),
        );
        await copyStableRestoreFile(
          selectedDeploymentPath,
          join(resolvedRestoreDirectory, basename(selectedDeploymentPath)),
        );
      }
      restoreManifestPath = selectedManifestPath;
    }
    const candidateDirectory =
      command === "promote"
        ? join(backupDirectory, `.candidate-${sourceReleaseAttemptId}`)
        : backupDirectory;
    const recoveryDirectory =
      command === "promote"
        ? candidateDirectory
        : command === "restore" && restoreDirectory !== null
          ? restoreDirectory
          : backupDirectory;
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
        databasePath: storagePaths.technicalAdminDatabase,
        // The activation script has already stopped the service. This seam is
        // intentionally separate and never opens, copies, or mutates auth data.
        async quiesce() {},
        // Defer the mutable auth adapter until the selected snapshot has passed
        // staging and verification; a missing store remains non-mutating.
        adapter: {
          async prepareForFoundationRestore(request) {
            if (!technicalAdminStoragePresent) {
              return {
                outcome: "re-enrollment-required" as const,
                reason: technicalAdminStorageReason,
              };
            }
            if (technicalAdminAuth === null) {
              throw new Error("Technical Admin restore adapter is unavailable.");
            }
            return technicalAdminAuth.prepareForFoundationRestore(request);
          },
        },
      },
    });
    if (command === "backup") {
      injectFocusedFailure("backup-create");
      const manifest = await recovery.createPreDeploymentBackup();
      const adHoc = requireProductionAdHocBackup(manifest);
      const createdManifestPath = join(backupDirectory, `${manifest.snapshotId}.manifest.json`);
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
      console.log(
        JSON.stringify({
          manifestPath: createdManifestPath,
          snapshotId: manifest.snapshotId,
          metadata,
        }),
      );
      return 0;
    }
    if (command === "restore") {
      injectFocusedFailure("restore");
      if (restoreManifestPath === undefined) throw new Error("Backup manifest path is required.");
      const verifiedManifest = await recovery.verifyBackup(restoreManifestPath);
      const deploymentPath = join(
        dirname(restoreManifestPath),
        `${verifiedManifest.snapshotId}.deployment.json`,
      );
      const metadata = JSON.parse(
        await readFile(deploymentPath, "utf8"),
      ) as ProductionBackupMetadata;
      const schemaCompatibility = process.env.SCHEMA_COMPATIBILITY;
      if (schemaCompatibility === undefined) {
        throw new Error("Schema compatibility is required for Production restore.");
      }
      assertProductionBackupMetadata(
        { manifest: verifiedManifest, metadata },
        {
          sourceReleaseAttemptId: metadata.sourceReleaseAttemptId,
          schemaCompatibility: metadata.schemaCompatibility,
        },
      );
      if (metadata.schemaCompatibility !== schemaCompatibility) {
        throw new Error("Selected restore snapshot is incompatible with this release.");
      }
      if (restoreDirectory === null) throw new Error("Restore workspace is required.");
      const technicalAdminStorage = await prepareTechnicalAdminStorageForRestore(
        storagePaths.technicalAdminDatabase,
        join(restoreDirectory, "technical-admin-auth-evidence"),
        {
          environment: technicalAdmin.environment,
          origin: technicalAdmin.origin,
          rpId: technicalAdmin.rpId,
        },
      );
      technicalAdminStoragePresent = technicalAdminStorage.present;
      if (!technicalAdminStorage.present) {
        technicalAdminStorageReason = technicalAdminStorage.reason;
      }
      if (technicalAdminStoragePresent) {
        technicalAdminRepository = createSqliteTechnicalAdminAuthRepository(
          storagePaths.technicalAdminDatabase,
          {
            environment: technicalAdmin.environment,
            origin: technicalAdmin.origin,
            rpId: technicalAdmin.rpId,
          },
        );
        technicalAdminAuth = createTechnicalAdminAuth(technicalAdmin, technicalAdminRepository);
      }
      const restored = await recovery.restore(restoreManifestPath);
      console.log(
        JSON.stringify({
          restored: true,
          restoreId: restored.restoreId,
          potentiallyNewerWork: restored.potentiallyNewerWork,
          technicalAdminAuth: restored.technicalAdminAuth,
          authorityResurrectionWarning: restored.authorityResurrectionWarning,
        }),
      );
      return 0;
    }
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
      if (rootPromotionRequested) {
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
  } catch (error) {
    if (command !== "restore") throw error;
    emitBoundedRestoreFailure(error);
    return 1;
  } finally {
    technicalAdminAuth?.close();
    technicalAdminRepository?.close();
    storage?.close();
  }
}

export type TechnicalAdminStorageRestorePreparation =
  | { present: true }
  | { present: false; reason: "missing" | "invalid" | "incompatible" };

const requiredTechnicalAdminStorageColumns = {
  technical_admin_credentials: ["credential_id", "public_key_json", "sign_count", "created_at_ms"],
  technical_admin_enrollment: ["token_hash", "expires_at_ms", "used_at_ms"],
  technical_admin_challenges: [
    "challenge_id",
    "challenge",
    "purpose",
    "session_id",
    "fresh_purpose",
    "expires_at_ms",
    "used_at_ms",
  ],
  technical_admin_sessions: [
    "session_id",
    "token_hash",
    "created_at_ms",
    "last_seen_at_ms",
    "absolute_expires_at_ms",
    "revoked_at_ms",
    "csrf_token_hash",
    "fresh_verified_at_ms",
    "fresh_verified_purpose",
  ],
  technical_admin_storage_identity: ["id", "environment", "origin", "rp_id"],
  technical_admin_state: ["id", "generation"],
  technical_admin_operational_logs: [
    "log_id",
    "at_ms",
    "event",
    "outcome",
    "environment",
    "generation",
    "session_reference",
    "source_correlation",
  ],
  technical_admin_alerts: [
    "alert_id",
    "at_ms",
    "event",
    "environment",
    "generation",
    "source_correlation",
  ],
} as const;

export async function prepareTechnicalAdminStorageForRestore(
  databasePath: string,
  evidenceDirectory: string,
  expectedIdentity: TechnicalAdminStorageIdentity,
): Promise<TechnicalAdminStorageRestorePreparation> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(databasePath);
  } catch (error) {
    if (isMissingPathError(error)) return { present: false, reason: "missing" };
    throw new Error("Technical Admin storage cannot be inspected.");
  }

  let reason: "invalid" | "incompatible" | null = null;
  if (!info.isFile() || info.isSymbolicLink()) {
    reason = "invalid";
  } else {
    let inspection: Database | null = null;
    try {
      inspection = new Database(databasePath, { readonly: true, strict: true });
      const quickCheck = inspection.query("PRAGMA quick_check").get() as {
        quick_check?: string;
      } | null;
      if (quickCheck?.quick_check !== "ok") {
        reason = "invalid";
      } else {
        const schemaInspection = inspection;
        const tables = new Set(
          (
            inspection.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
              name: string;
            }>
          ).map(({ name }) => name),
        );
        const schemaCompatible = Object.entries(requiredTechnicalAdminStorageColumns).every(
          ([table, requiredColumns]) => {
            if (!tables.has(table)) return false;
            const columns = new Set(
              (
                schemaInspection.query(`PRAGMA table_info(${table})`).all() as Array<{
                  name: string;
                }>
              ).map(({ name }) => name),
            );
            return requiredColumns.every((column) => columns.has(column));
          },
        );
        if (!schemaCompatible) {
          reason = "incompatible";
        } else {
          const identities = inspection
            .query(
              "SELECT environment, origin, rp_id FROM technical_admin_storage_identity WHERE id = 1",
            )
            .all() as Array<{ environment: string; origin: string; rp_id: string }>;
          const [identity, ...additionalIdentities] = identities;
          if (
            identity === undefined ||
            additionalIdentities.length !== 0 ||
            identity.environment !== expectedIdentity.environment ||
            identity.origin !== expectedIdentity.origin ||
            identity.rp_id !== expectedIdentity.rpId
          ) {
            reason = "incompatible";
          }
        }
      }
    } catch {
      reason = "invalid";
    } finally {
      inspection?.close();
    }
  }

  if (reason === null) return { present: true };

  await mkdir(evidenceDirectory, { mode: 0o700 });
  const evidencePath = join(evidenceDirectory, basename(databasePath));
  await rename(databasePath, evidencePath);
  for (const suffix of ["-wal", "-shm"] as const) {
    try {
      await lstat(`${databasePath}${suffix}`);
      await rename(`${databasePath}${suffix}`, `${evidencePath}${suffix}`);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw new Error("Technical Admin storage evidence cannot be preserved.");
      }
    }
  }

  const replacement = createSqliteTechnicalAdminAuthRepository(databasePath, expectedIdentity);
  replacement.close();
  await chmod(databasePath, 0o600);
  return { present: false, reason };
}

type RestoreFileIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
};
type RestoreFileStat = RestoreFileIdentity & { isFile: boolean; mode: number };

export async function copyStableRestoreFile(
  sourcePath: string,
  destinationPath: string,
  expectedSha256?: string,
): Promise<void> {
  const resolvedSourcePath = resolve(sourcePath);
  if ((await realpath(resolvedSourcePath)) !== resolvedSourcePath) {
    throw new Error("Restore source is not canonical.");
  }
  const source = await openFile(resolvedSourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let destination: Awaited<ReturnType<typeof openFile>> | null = null;
  let destinationIdentity: RestoreFileStat | null = null;
  try {
    const sourceBefore = restoreFileIdentity(await source.stat());
    if (!sourceBefore.isFile) throw new Error("Restore source is not a regular file.");
    const content = await source.readFile();
    const sourceRead = restoreFileIdentity(await source.stat());
    if (!sameRestoreFileSnapshot(sourceBefore, sourceRead)) {
      throw new Error("Restore source changed while it was copied.");
    }
    if ((await realpath(resolvedSourcePath)) !== resolvedSourcePath) {
      throw new Error("Restore source changed its canonical identity while it was copied.");
    }
    const sourcePathIdentity = restoreFileIdentity(await lstat(resolvedSourcePath));
    if (!sameRestoreFileSnapshot(sourceBefore, sourcePathIdentity)) {
      throw new Error("Restore source changed file identity while it was copied.");
    }
    if (
      expectedSha256 !== undefined &&
      createHash("sha256").update(content).digest("hex") !== expectedSha256
    ) {
      throw new Error("Restore source content does not match its manifest.");
    }

    destination = await openFile(
      destinationPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await destination.chmod(0o600);
    destinationIdentity = restoreFileIdentity(await destination.stat());
    if (!destinationIdentity.isFile) throw new Error("Restore destination is not a regular file.");
    await destination.writeFile(content);
    await destination.sync();
    const destinationWritten = restoreFileIdentity(await destination.stat());
    if (!sameRestoreFileIdentity(destinationIdentity, destinationWritten)) {
      throw new Error("Restore destination changed while it was copied.");
    }
    const sourceAfter = restoreFileIdentity(await source.stat());
    const sourcePathAfter = restoreFileIdentity(await lstat(resolvedSourcePath));
    if (
      !sameRestoreFileSnapshot(sourceBefore, sourceAfter) ||
      !sameRestoreFileSnapshot(sourceBefore, sourcePathAfter)
    ) {
      throw new Error("Restore source changed before private copy completion.");
    }
    await destination.close();
    destination = null;
    const destinationPathIdentity = restoreFileIdentity(await lstat(destinationPath));
    if (
      !destinationPathIdentity.isFile ||
      (destinationPathIdentity.mode & 0o777) !== 0o600 ||
      !sameRestoreFileIdentity(destinationIdentity, destinationPathIdentity)
    ) {
      throw new Error("Restore destination changed after private copy completion.");
    }
  } catch (error) {
    await destination?.close().catch(() => undefined);
    if (destinationIdentity !== null) {
      try {
        const current = restoreFileIdentity(await lstat(destinationPath));
        if (sameRestoreFileIdentity(destinationIdentity, current)) await unlink(destinationPath);
      } catch {
        // The bounded restore failure is reported by the caller; never remove a substituted path.
      }
    }
    throw error;
  } finally {
    await source.close();
  }
}

function restoreFileIdentity(info: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  mode?: number;
  isFile?: () => boolean;
  isSymbolicLink?: () => boolean;
}): RestoreFileStat {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    mode: info.mode ?? 0,
    isFile: info.isFile?.() ?? true,
  };
}

function sameRestoreFileIdentity(left: RestoreFileStat, right: RestoreFileStat): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameRestoreFileSnapshot(left: RestoreFileStat, right: RestoreFileStat): boolean {
  return (
    sameRestoreFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.isFile === right.isFile
  );
}

function emitBoundedRestoreFailure(error: unknown): void {
  const foundationFailure = error instanceof FoundationRestoreFailure ? error : null;
  console.error(
    JSON.stringify({
      restored: false,
      outcome: boundedRestoreFailureOutcome(foundationFailure),
      cutoverCompleted: foundationFailure?.cutoverCompleted ?? false,
      technicalAdminAuth: foundationFailure?.technicalAdminAuth ?? {
        outcome: "not-attempted",
        credentialPreserved: false,
        reEnrollmentRequired: false,
      },
    }),
  );
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function boundedRestoreFailureOutcome(
  failure: FoundationRestoreFailure | null,
):
  | "restore-preparation-failed"
  | "auth-sanitation-failed"
  | "foundation-replacement-failed"
  | "cutover-completed-evidence-failed" {
  if (failure?.phase === "auth-sanitation") return "auth-sanitation-failed";
  if (failure?.phase === "foundation-replacement") return "foundation-replacement-failed";
  if (failure?.phase === "post-cutover-evidence") return "cutover-completed-evidence-failed";
  return "restore-preparation-failed";
}
