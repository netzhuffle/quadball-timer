import { createHash, randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open as openFile,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  ACCEPTANCE_LIMITS,
  createFoundationAcceptance,
  type FoundationAcceptanceOptions,
  type FoundationBatchOutcome,
} from "@/lib/foundation-acceptance";
import type {
  ControlAction,
  ControlActionGrantProvenance,
  ControlActionLifecycleContext,
} from "@/lib/event-game-actions";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import { createAuditEntry, expireGrantIfDue } from "@/lib/grant-lifecycle";
import { eraseGrantCode } from "@/lib/grant-code";
import { expireSession } from "@/lib/grant-management-policy";
import { resolveControlSession } from "@/lib/grant-management-sessions";
import {
  GRANT_CODE_KIND,
  type ControlGrantScope,
  type GrantKeyRing,
  type StoredGrant,
  type StoredGrantSession,
  type TerminalGrantSessionReason,
} from "@/lib/grant-types";
import {
  openSqliteFoundationStorage,
  type SqliteFoundationStorage,
} from "@/lib/foundation-storage-sqlite";
import type { FoundationStorageReadinessContext } from "@/lib/foundation-storage";
import type { FoundationStorageTransaction } from "@/lib/foundation-storage";
import type { AdHocRecoveryAdapter, AdHocRecoveryFacts } from "@/lib/ad-hoc-games";
import type {
  TechnicalAdminAuth,
  TechnicalAdminRecoveryResult,
  TechnicalAdminRestorePreparationRequest,
  TechnicalAdminRestorePreparationResult,
} from "@/lib/technical-admin-auth";
import {
  FOUNDATION_BACKUP_POLICY_VERSION,
  inspectRecoveryDatabase,
  readRepresentedKeyVersions,
  quoteRecoverySqliteString,
  type RepresentedKeyVersions,
  type RecoverySnapshotFacts,
} from "@/lib/foundation-recovery-sqlite";

const RECOVERY_MANIFEST_VERSION = "foundation-recovery-manifest-v1" as const;
const RECOVERY_EVIDENCE_VERSION = "foundation-recovery-evidence-v1" as const;
const EVENT_ADMIN_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export type FoundationRecoveryManifest = {
  version: typeof RECOVERY_MANIFEST_VERSION;
  snapshotId: string;
  snapshotAtMs: number;
  policyVersion: typeof FOUNDATION_BACKUP_POLICY_VERSION;
  databaseFile: string;
  databaseSha256: string;
  logicalDigest: string;
  actionCount: number;
  representedKeyVersions: RepresentedKeyVersions;
  restoredGrantVersions: readonly {
    grantReference: string;
    grantType: string;
    grantVersion: string;
  }[];
  adHoc?: {
    databaseFile: string;
    databaseSha256: string;
    facts: AdHocRecoveryFacts;
  };
  verifiedAtMs: number;
};

export type FoundationRecoveryOptions = {
  backupDirectory: string;
  keyRing: GrantKeyRing;
  readinessContext: FoundationStorageReadinessContext;
  grant: GrantAuthorityOptions;
  /** Composed once against this recovery's storage and Grant environment. */
  acceptance: Omit<FoundationAcceptanceOptions, "grant">;
  technicalAdminAuth: {
    /** Separate Technical Admin auth database; it is preserved but never restored from Foundation. */
    databasePath: string;
    /** Stops new auth writes and drains the auth store before semantic restore preparation. */
    quiesce(): Promise<void>;
    /** The sole semantic auth boundary consumed by Foundation recovery. */
    adapter: Pick<TechnicalAdminAuth, "prepareForFoundationRestore">;
  };
  /** Optional Ad Hoc database included in the same staged recovery boundary. */
  adHoc?: AdHocRecoveryAdapter;
  nowMs?: () => number;
  createId?: () => string;
  faultInjector?: (
    phase:
      | "after-vacuum"
      | "after-compaction"
      | "after-verification"
      | "after-restore-staging"
      | "after-authoritative-quiescence"
      | "after-final-authority-evaluation"
      | "after-post-cutover-inspection"
      | "after-live-preserved"
      | "before-live-replacement"
      | "before-completed-restore-evidence",
  ) => void;
};

export type RecoveryGapInput = {
  gapId: string;
  category: "controller-history-unavailable" | "server-evidence-unavailable" | "action-rejected";
  redactedDetail: string;
};

export type RecoveryImportInput = {
  importId: string;
  recordId: string;
  eventGameId: string;
  sessionBearer: string;
  currentGrant: ControlActionGrantProvenance;
  currentLifecycle: ControlActionLifecycleContext;
  sourceReference: string;
  actions: readonly {
    action: ControlAction;
    /** Null unless surviving evidence establishes the original server acceptance time. */
    sourceAcceptedAtMs: number | null;
  }[];
  gaps: readonly RecoveryGapInput[];
};

export type FoundationRecovery = {
  createPreDeploymentBackup(): Promise<FoundationRecoveryManifest>;
  verifyBackup(manifestPath: string): Promise<FoundationRecoveryManifest>;
  restore(
    manifestPath: string,
    options?: FoundationRestoreOptions,
  ): Promise<{
    restoreId: string;
    failedDatabasePath: string;
    /**
     * @deprecated Compatibility-only field. Policy A never moves the separate Technical Admin
     * store and always returns null.
     */
    failedTechnicalAdminDatabasePath: string | null;
    failedAdHocDatabasePath: string | null;
    completed: true;
    evidencePath: string;
    completionEvidencePath: string | null;
    completionEvidenceStatus: "written" | "write-failed";
    potentiallyNewerWork: boolean | null;
    technicalAdminAuth: FoundationRestoreSuccessTechnicalAdminReport;
    authorityResurrectionWarning: string;
  }>;
  importControllerRecovery(
    input: RecoveryImportInput,
  ): Promise<{ outcome: FoundationBatchOutcome; evidencePath: string }>;
};

export type FoundationRestoreOptions = {
  technicalAdminAuthMode?: TechnicalAdminRestorePreparationRequest["mode"];
};

export type FoundationRestoreFailurePhase =
  | "staging"
  | "auth-sanitation"
  | "pre-cutover-validation"
  | "foundation-replacement"
  | "post-cutover-evidence";
type FoundationRestoreSuccessTechnicalAdminReport = Exclude<
  TechnicalAdminRecoveryResult,
  { outcome: "not-attempted" | "sanitation-failed" }
>;
type FoundationRestoreTechnicalAdminReport = TechnicalAdminRecoveryResult;

export class FoundationRestoreFailure extends Error {
  readonly technicalAdminAuth: FoundationRestoreTechnicalAdminReport;
  readonly phase: FoundationRestoreFailurePhase;
  readonly cutoverCompleted: boolean;

  constructor(
    cause: unknown,
    technicalAdminAuth: FoundationRestoreTechnicalAdminReport,
    phase: FoundationRestoreFailurePhase,
    cutoverCompleted: boolean,
  ) {
    super(cause instanceof Error ? cause.message : "Foundation restore failed.");
    this.name = "FoundationRestoreFailure";
    this.technicalAdminAuth = technicalAdminAuth;
    this.phase = phase;
    this.cutoverCompleted = cutoverCompleted;
  }
}

export function createFoundationRecovery(
  storage: SqliteFoundationStorage,
  options: FoundationRecoveryOptions,
): FoundationRecovery {
  const nowMs = options.nowMs ?? (() => Date.now());
  const createId = options.createId ?? randomUUID;
  const backupDirectory = resolve(options.backupDirectory);
  const livePath = resolve(storage.databasePath);
  const liveDirectory = dirname(livePath);
  const technicalAdminPath = resolve(options.technicalAdminAuth.databasePath);
  if (technicalAdminPath === livePath) {
    throw new Error("Technical Admin auth must remain separate from Event foundation storage.");
  }
  if (options.keyRing !== options.grant.keyRing) {
    throw new Error("Foundation recovery and acceptance must share one Grant key-ring boundary.");
  }
  assertBackupOutsideLiveDirectory(liveDirectory, backupDirectory);
  const acceptance = createFoundationAcceptance(storage, {
    ...options.acceptance,
    grant: options.grant,
  });

  async function createPreDeploymentBackup(): Promise<FoundationRecoveryManifest> {
    await prepareBackupWorkspace(liveDirectory, backupDirectory);
    const snapshotId = boundedId(createId(), "snapshotId");
    const rawPath = join(backupDirectory, `.${snapshotId}.raw.sqlite`);
    const stagedPath = join(backupDirectory, `.${snapshotId}.staged.sqlite`);
    const databasePath = join(backupDirectory, `${snapshotId}.sqlite`);
    const manifestPath = join(backupDirectory, `${snapshotId}.manifest.json`);
    const adHocRawPath = join(backupDirectory, `.${snapshotId}.ad-hoc.raw.sqlite`);
    const adHocDatabasePath = join(backupDirectory, `${snapshotId}.ad-hoc.sqlite`);
    const snapshotAtMs = readTime(nowMs);
    let publishedDatabaseIdentity: StableFileIdentity | null = null;
    let publishedManifestIdentity: StableFileIdentity | null = null;
    let rawIdentity: StableFileIdentity | null = null;
    let stagedIdentity: StableFileIdentity | null = null;
    let adHocRawIdentity: StableFileIdentity | null = null;
    let publishedAdHocIdentity: StableFileIdentity | null = null;
    let adHocFacts: AdHocRecoveryFacts | null = null;
    let completed = false;
    try {
      await assertPathAbsent(rawPath, "raw recovery snapshot");
      await assertPathAbsent(stagedPath, "compacted recovery snapshot");
      await assertPathAbsent(databasePath, "verified recovery snapshot");
      await assertPathAbsent(manifestPath, "recovery manifest");
      if (options.adHoc !== undefined) {
        await assertPathAbsent(adHocRawPath, "raw Ad Hoc recovery snapshot");
        await assertPathAbsent(adHocDatabasePath, "verified Ad Hoc recovery snapshot");
      }
      const sourceFacts = await storage.createRecoveryVacuumSnapshot(rawPath);
      rawIdentity = await assertOwnedPrivateFile(rawPath, "raw recovery snapshot");
      options.faultInjector?.("after-vacuum");
      const raw = new Database(rawPath);
      try {
        raw.exec(`VACUUM INTO ${quoteRecoverySqliteString(stagedPath)};`);
      } finally {
        raw.close();
      }
      await chmod(stagedPath, 0o600);
      options.faultInjector?.("after-compaction");
      stagedIdentity = await assertOwnedPrivateFile(stagedPath, "compacted recovery snapshot");
      const verified = await verifyDatabase(stagedPath, sourceFacts);
      options.faultInjector?.("after-verification");
      if (options.adHoc !== undefined) {
        adHocFacts = await options.adHoc.createRecoveryVacuumSnapshot(adHocRawPath);
        adHocRawIdentity = await assertOwnedPrivateFile(
          adHocRawPath,
          "raw Ad Hoc recovery snapshot",
        );
        await options.adHoc.verifyRecoverySnapshot(adHocRawPath, adHocFacts);
        publishedAdHocIdentity = await copyStablePrivateFile(adHocRawPath, adHocDatabasePath);
        await removeStablePath(adHocRawPath, adHocRawIdentity);
        adHocRawIdentity = null;
      }
      const manifest: FoundationRecoveryManifest = {
        version: RECOVERY_MANIFEST_VERSION,
        snapshotId,
        snapshotAtMs,
        policyVersion: FOUNDATION_BACKUP_POLICY_VERSION,
        databaseFile: basename(databasePath),
        databaseSha256: await sha256File(stagedPath),
        logicalDigest: verified.facts.logicalDigest,
        actionCount: verified.facts.actionCount,
        representedKeyVersions: verified.keyVersions,
        restoredGrantVersions: redactGrantVersions(verified.facts),
        ...(options.adHoc === undefined || adHocFacts === null
          ? {}
          : {
              adHoc: {
                databaseFile: basename(adHocDatabasePath),
                databaseSha256: await sha256File(adHocDatabasePath),
                facts: adHocFacts,
              },
            }),
        verifiedAtMs: readTime(nowMs),
      };
      publishedDatabaseIdentity = await copyStablePrivateFile(stagedPath, databasePath);
      await removeStablePath(stagedPath, stagedIdentity);
      stagedIdentity = null;
      publishedManifestIdentity = await writeJsonFile(manifestPath, manifest);
      await syncDirectory(backupDirectory);
      completed = true;
      return manifest;
    } finally {
      if (rawIdentity !== null) await removeStablePath(rawPath, rawIdentity);
      if (stagedIdentity !== null) await removeStablePath(stagedPath, stagedIdentity);
      if (adHocRawIdentity !== null) await removeStablePath(adHocRawPath, adHocRawIdentity);
      if (!completed && publishedDatabaseIdentity !== null)
        await removeStablePath(databasePath, publishedDatabaseIdentity);
      if (!completed && publishedAdHocIdentity !== null)
        await removeStablePath(adHocDatabasePath, publishedAdHocIdentity);
      if (!completed && publishedManifestIdentity !== null)
        await removeStablePath(manifestPath, publishedManifestIdentity);
    }
  }

  async function verifyBackup(manifestPath: string): Promise<FoundationRecoveryManifest> {
    await prepareBackupWorkspace(liveDirectory, backupDirectory);
    const manifest = await readManifest(manifestPath, backupDirectory);
    const verificationPath = join(
      backupDirectory,
      `.${manifest.snapshotId}.verify-${boundedId(createId(), "verificationId")}.sqlite`,
    );
    const adHocVerificationPath =
      manifest.adHoc === undefined
        ? null
        : join(
            backupDirectory,
            `.${manifest.snapshotId}.verify-${boundedId(createId(), "verificationId")}.ad-hoc.sqlite`,
          );
    let verificationIdentity: StableFileIdentity | null = null;
    let adHocVerificationIdentity: StableFileIdentity | null = null;
    try {
      verificationIdentity = await copyStablePrivateFile(
        resolveBackupDatabasePath(manifestPath, manifest, backupDirectory),
        verificationPath,
        manifest.databaseSha256,
      );
      const verified = await verifyDatabase(verificationPath, {
        logicalDigest: manifest.logicalDigest,
        actionCount: manifest.actionCount,
        grantVersions: [],
      });
      if (
        JSON.stringify(verified.keyVersions) !== JSON.stringify(manifest.representedKeyVersions)
      ) {
        throw new Error("Verified backup key-version representation changed.");
      }
      if (manifest.adHoc !== undefined) {
        if (options.adHoc === undefined || adHocVerificationPath === null) {
          throw new Error("Ad Hoc recovery adapter is required to verify this backup.");
        }
        adHocVerificationIdentity = await copyStablePrivateFile(
          resolveBackupAdHocDatabasePath(manifestPath, manifest, backupDirectory),
          adHocVerificationPath,
          manifest.adHoc.databaseSha256,
        );
        await options.adHoc.verifyRecoverySnapshot(adHocVerificationPath, manifest.adHoc.facts);
      }
      return manifest;
    } finally {
      if (verificationIdentity !== null)
        await removeStablePath(verificationPath, verificationIdentity);
      if (adHocVerificationIdentity !== null && adHocVerificationPath !== null)
        await removeStablePath(adHocVerificationPath, adHocVerificationIdentity);
      await rm(`${verificationPath}-wal`, { force: true });
      await rm(`${verificationPath}-shm`, { force: true });
      await rm(`${verificationPath}.quarantine`, { force: true });
    }
  }

  async function restore(manifestPath: string, restoreOptions: FoundationRestoreOptions = {}) {
    await prepareBackupWorkspace(liveDirectory, backupDirectory);
    const manifest = await readManifest(manifestPath, backupDirectory);
    const backupPath = resolveBackupDatabasePath(manifestPath, manifest, backupDirectory);
    const restoreId = boundedId(createId(), "restoreId");
    const restoreAttemptDirectory = join(backupDirectory, `${restoreId}.restore-attempt`);
    const stagedPath = join(restoreAttemptDirectory, `${basename(livePath)}.staged`);
    const failedDatabasePath = `${livePath}.failed-${restoreId}`;
    const adHocLivePath = options.adHoc?.databasePath ?? null;
    const stagedAdHocPath =
      adHocLivePath === null
        ? null
        : join(restoreAttemptDirectory, `${basename(adHocLivePath)}.staged`);
    const failedAdHocDatabasePath =
      adHocLivePath === null ? null : `${adHocLivePath}.failed-${restoreId}`;
    const evidencePath = join(backupDirectory, `${restoreId}.restore-evidence.json`);
    const completionEvidenceCandidatePath = join(
      backupDirectory,
      `${restoreId}.restore-completed.json`,
    );
    let staged: SqliteFoundationStorage | undefined;
    let stagedIdentity: StableFileIdentity | null = null;
    let stagedAdHocIdentity: StableFileIdentity | null = null;
    const stagedSidecarIdentities = new Map<string, StableFileIdentity>();
    let evidenceIdentity: StableFileIdentity | null = null;
    let cutoverCompleted = false;
    let restoreSucceeded = false;
    let restorePhase: FoundationRestoreFailurePhase = "staging";
    let technicalAdminAuthReport: FoundationRestoreTechnicalAdminReport = {
      outcome: "not-attempted",
      credentialPreserved: false,
      reEnrollmentRequired: false,
    };
    const rememberStagedSidecars = async () => {
      for (const sidecarPath of [`${stagedPath}-wal`, `${stagedPath}-shm`]) {
        if (stagedSidecarIdentities.has(sidecarPath) || !(await pathExists(sidecarPath))) continue;
        stagedSidecarIdentities.set(sidecarPath, stableIdentity(await lstat(sidecarPath)));
      }
    };
    try {
      await mkdir(restoreAttemptDirectory, { mode: 0o700 });
      await assertOwnedPrivateDirectory(restoreAttemptDirectory, "restore attempt workspace");
      await assertPathAbsent(failedDatabasePath, "failed Event foundation image");
      if (failedAdHocDatabasePath !== null)
        await assertPathAbsent(failedAdHocDatabasePath, "failed Ad Hoc image");
      await assertPathAbsent(evidencePath, "restore evidence");
      await assertPathAbsent(completionEvidenceCandidatePath, "completed restore evidence");
      stagedIdentity = await copyStablePrivateFile(backupPath, stagedPath, manifest.databaseSha256);
      const verified = await verifyDatabase(stagedPath, {
        logicalDigest: manifest.logicalDigest,
        actionCount: manifest.actionCount,
        grantVersions: [],
      });
      if (
        JSON.stringify(verified.keyVersions) !== JSON.stringify(manifest.representedKeyVersions)
      ) {
        throw new Error("Verified backup key-version representation changed.");
      }
      if (manifest.adHoc !== undefined) {
        if (
          options.adHoc === undefined ||
          adHocLivePath === null ||
          stagedAdHocPath === null ||
          failedAdHocDatabasePath === null
        ) {
          throw new Error("Ad Hoc recovery adapter is required to restore this backup.");
        }
        stagedAdHocIdentity = await copyStablePrivateFile(
          resolveBackupAdHocDatabasePath(manifestPath, manifest, backupDirectory),
          stagedAdHocPath,
          manifest.adHoc.databaseSha256,
        );
        await options.adHoc.verifyRecoverySnapshot(stagedAdHocPath, manifest.adHoc.facts);
      }
      options.faultInjector?.("after-restore-staging");

      evidenceIdentity = await writeJsonFile(evidencePath, {
        version: RECOVERY_EVIDENCE_VERSION,
        kind: "restore",
        status: "pending-replacement",
        restoreId,
        snapshotId: manifest.snapshotId,
        snapshotAtMs: manifest.snapshotAtMs,
        snapshotActionCount: manifest.actionCount,
        restoredGrantVersions: manifest.restoredGrantVersions,
      });

      // Both authoritative writer domains are closed before the final current-fact
      // evaluation. Any writer already queued drains before this boundary; any
      // later writer is rejected by the closed repositories.
      restorePhase = "auth-sanitation";
      await options.technicalAdminAuth.quiesce();
      await storage.quiesceForRecovery();
      await options.adHoc?.quiesceForRecovery();
      options.faultInjector?.("after-authoritative-quiescence");

      const technicalAdminAuthResult = await prepareTechnicalAdminForRestore(
        options.technicalAdminAuth.adapter,
        restoreOptions.technicalAdminAuthMode ?? "preserve-compatible-credential",
      );
      const technicalAdminAuthEvidence =
        redactTechnicalAdminRestoreResult(technicalAdminAuthResult);
      technicalAdminAuthReport = toTechnicalAdminRecoveryResult(technicalAdminAuthResult);
      if (technicalAdminAuthResult.outcome === "sanitation-failed") {
        evidenceIdentity = await writeJsonFile(
          evidencePath,
          {
            version: RECOVERY_EVIDENCE_VERSION,
            kind: "restore",
            status: "aborted-auth-sanitation",
            restoreId,
            snapshotId: manifest.snapshotId,
            snapshotAtMs: manifest.snapshotAtMs,
            snapshotActionCount: manifest.actionCount,
            technicalAdminAuth: technicalAdminAuthEvidence,
            restoredGrantVersions: manifest.restoredGrantVersions,
          },
          "replace-owned",
          evidenceIdentity,
        );
        throw new Error("Technical Admin authentication sanitation failed before replacement.");
      }
      const technicalAdminAuthSuccessReport =
        toTechnicalAdminSuccessResult(technicalAdminAuthResult);
      restorePhase = "pre-cutover-validation";
      // The finite auth result is committed to the pending record before any
      // Foundation replacement. A later replacement rollback changes only
      // Foundation state and leaves the already-sanitized auth store untouched.
      evidenceIdentity = await writeJsonFile(
        evidencePath,
        {
          version: RECOVERY_EVIDENCE_VERSION,
          kind: "restore",
          status: "pending-replacement",
          restoreId,
          snapshotId: manifest.snapshotId,
          snapshotAtMs: manifest.snapshotAtMs,
          snapshotActionCount: manifest.actionCount,
          technicalAdminAuth: technicalAdminAuthEvidence,
          restoredGrantVersions: manifest.restoredGrantVersions,
        },
        "replace-owned",
        evidenceIdentity,
      );

      await assertStablePrivateFile(
        stagedPath,
        stagedIdentity,
        "independently verified restore staging image",
      );
      staged = openSqliteFoundationStorage(stagedPath, {
        grantKeyRing: options.keyRing,
        grantValidationContext: {
          environmentId: options.grant.environmentId,
          keyRing: options.keyRing,
        },
      });
      await rememberStagedSidecars();
      staged.setReadinessContext(options.readinessContext);
      let stagedReadiness = await staged.readiness();
      if (!stagedReadiness.ok) {
        const migration = await staged.migrationPreflight();
        if (migration.status !== "pending" && migration.status !== "missing") {
          throw new Error("Restored staging database has incompatible migrations.");
        }
        try {
          await staged.applyMigrations({ requireCandidate: false });
        } finally {
          await rememberStagedSidecars();
        }
        stagedReadiness = await staged.readiness();
      }
      try {
        await reevaluateRestoredAuthority(staged, options.grant);
      } finally {
        await rememberStagedSidecars();
      }
      stagedReadiness = await staged.readiness();
      if (!stagedReadiness.ok || stagedReadiness.evidence?.keys.missingCount !== 0) {
        throw new Error("Restored staging database did not pass independent readiness.");
      }
      try {
        await staged.quiesceForRecovery();
      } finally {
        await rememberStagedSidecars();
      }
      staged = undefined;
      const reevaluatedStagedIdentity = await assertOwnedPrivateFile(
        stagedPath,
        "verified restore staging image",
      );
      if (!samePhysicalFile(reevaluatedStagedIdentity, stagedIdentity)) {
        throw new Error("Restore staging changed file identity during authority reevaluation.");
      }
      stagedIdentity = reevaluatedStagedIdentity;
      options.faultInjector?.("after-final-authority-evaluation");
      await assertStablePrivateFile(evidencePath, evidenceIdentity, "pending restore evidence");

      const liveIdentity = stableIdentity(await lstat(livePath));
      const liveFacts = safelyInspectClosedDatabase(livePath);
      await assertStableFileIdentity(livePath, liveIdentity, "quiesced Event foundation image");
      const adHocLiveIdentity =
        adHocLivePath === null ? null : stableIdentity(await lstat(adHocLivePath));
      const adHocLiveFacts =
        options.adHoc === undefined || adHocLivePath === null
          ? null
          : options.adHoc.inspectRecoveryDatabase(adHocLivePath);
      const potentiallyNewerWork =
        liveFacts === null
          ? null
          : liveFacts.logicalDigest !== manifest.logicalDigest ||
            (manifest.adHoc !== undefined &&
              adHocLiveFacts !== null &&
              JSON.stringify(adHocLiveFacts) !== JSON.stringify(manifest.adHoc.facts));
      const movedSidecars: Array<{
        from: string;
        to: string;
        identity: StableFileIdentity;
      }> = [];
      const installedPaths: Array<{ path: string; identity: StableFileIdentity }> = [];
      restorePhase = "foundation-replacement";
      try {
        const failedLiveIdentity = await moveToExclusivePath(
          livePath,
          failedDatabasePath,
          "failed Event foundation image",
          liveIdentity,
        );
        movedSidecars.push({
          from: failedDatabasePath,
          to: livePath,
          identity: failedLiveIdentity,
        });
        for (const suffix of ["-wal", "-shm", ".quarantine"] as const) {
          const source = `${livePath}${suffix}`;
          if (!(await pathExists(source))) continue;
          const failed = `${failedDatabasePath}${suffix}`;
          const sourceIdentity = stableIdentity(await lstat(source));
          const failedIdentity = await moveToExclusivePath(
            source,
            failed,
            "failed Event foundation sidecar",
            sourceIdentity,
          );
          movedSidecars.push({ from: failed, to: source, identity: failedIdentity });
        }
        // Policy A keeps the already-sanitized Technical Admin store at its live
        // path. Foundation replacement must not displace or reopen that store.
        if (
          manifest.adHoc !== undefined &&
          adHocLivePath !== null &&
          failedAdHocDatabasePath !== null &&
          adHocLiveIdentity !== null
        ) {
          const failedIdentity = await moveToExclusivePath(
            adHocLivePath,
            failedAdHocDatabasePath,
            "failed Ad Hoc image",
            adHocLiveIdentity,
          );
          movedSidecars.push({
            from: failedAdHocDatabasePath,
            to: adHocLivePath,
            identity: failedIdentity,
          });
          for (const suffix of ["-wal", "-shm"] as const) {
            const source = `${adHocLivePath}${suffix}`;
            if (!(await pathExists(source))) continue;
            const failed = `${failedAdHocDatabasePath}${suffix}`;
            const sourceIdentity = stableIdentity(await lstat(source));
            const failedIdentity = await moveToExclusivePath(
              source,
              failed,
              "failed Ad Hoc sidecar",
              sourceIdentity,
            );
            movedSidecars.push({ from: failed, to: source, identity: failedIdentity });
          }
        }
        options.faultInjector?.("after-live-preserved");
        options.faultInjector?.("before-live-replacement");
        installedPaths.push({
          path: livePath,
          identity: await moveToExclusivePath(
            stagedPath,
            livePath,
            "restored Event foundation image",
            stagedIdentity,
          ),
        });
        // Once the candidate has replaced the live Foundation path, report the
        // cutover boundary truthfully even if a later sidecar or Ad Hoc move
        // fails and the bounded rollback path is entered.
        cutoverCompleted = true;
        stagedIdentity = null;
        for (const suffix of ["-wal", "-shm"] as const) {
          if (await pathExists(`${stagedPath}${suffix}`)) {
            const stagedSidecarPath = `${stagedPath}${suffix}`;
            const stagedSidecarIdentity = stableIdentity(await lstat(stagedSidecarPath));
            installedPaths.push({
              path: `${livePath}${suffix}`,
              identity: await moveToExclusivePath(
                stagedSidecarPath,
                `${livePath}${suffix}`,
                "restored Event foundation sidecar",
                stagedSidecarIdentity,
              ),
            });
          }
        }
        if (manifest.adHoc !== undefined && stagedAdHocPath !== null && adHocLivePath !== null) {
          if (stagedAdHocIdentity === null)
            throw new Error("Ad Hoc restore staging is unavailable.");
          await assertStablePrivateFile(
            stagedAdHocPath,
            stagedAdHocIdentity,
            "verified Ad Hoc restore staging image",
          );
          installedPaths.push({
            path: adHocLivePath,
            identity: await moveToExclusivePath(
              stagedAdHocPath,
              adHocLivePath,
              "restored Ad Hoc image",
              stagedAdHocIdentity,
            ),
          });
          stagedAdHocIdentity = null;
          for (const suffix of ["-wal", "-shm"] as const) {
            if (await pathExists(`${stagedAdHocPath}${suffix}`)) {
              const stagedSidecarPath = `${stagedAdHocPath}${suffix}`;
              const stagedSidecarIdentity = stableIdentity(await lstat(stagedSidecarPath));
              installedPaths.push({
                path: `${adHocLivePath}${suffix}`,
                identity: await moveToExclusivePath(
                  stagedSidecarPath,
                  `${adHocLivePath}${suffix}`,
                  "restored Ad Hoc sidecar",
                  stagedSidecarIdentity,
                ),
              });
            }
          }
        }
        await syncDirectory(liveDirectory);
        if (adHocLivePath !== null && dirname(adHocLivePath) !== liveDirectory) {
          await syncDirectory(dirname(adHocLivePath));
        }
      } catch (error) {
        for (const installed of installedPaths.reverse()) {
          const preservedCandidatePath = join(
            restoreAttemptDirectory,
            `installed-${basename(installed.path)}`,
          );
          await copyStablePrivateFile(installed.path, preservedCandidatePath);
          await removeStablePath(installed.path, installed.identity);
        }
        for (const moved of movedSidecars.reverse()) {
          if (await pathExists(moved.from)) {
            await copyStablePrivateFile(moved.from, moved.to);
          }
        }
        await syncDirectory(liveDirectory);
        if (adHocLivePath !== null && dirname(adHocLivePath) !== liveDirectory) {
          await syncDirectory(dirname(adHocLivePath));
        }
        throw error;
      }
      cutoverCompleted = true;
      restorePhase = "post-cutover-evidence";
      // Keep an evaluated candidate copy in the retryable attempt workspace. It
      // is transient only on complete success and remains evidence on every
      // later inspection or evidence failure.
      stagedIdentity = await copyStablePrivateFile(livePath, stagedPath);
      if (stagedAdHocPath !== null && adHocLivePath !== null) {
        stagedAdHocIdentity = await copyStablePrivateFile(adHocLivePath, stagedAdHocPath);
      }
      const restoredFacts = safelyInspectClosedDatabase(livePath);
      const restoredAdHocFacts =
        options.adHoc !== undefined && adHocLivePath !== null
          ? options.adHoc.inspectRecoveryDatabase(adHocLivePath)
          : null;
      options.faultInjector?.("after-post-cutover-inspection");
      const evidence = {
        version: RECOVERY_EVIDENCE_VERSION,
        kind: "restore",
        status: "completed",
        restoreId,
        restoredAtMs: readTime(nowMs),
        snapshotId: manifest.snapshotId,
        snapshotAtMs: manifest.snapshotAtMs,
        snapshotActionCount: manifest.actionCount,
        liveActionCountBeforeRestore: liveFacts?.actionCount ?? null,
        potentiallyNewerWork,
        adHoc:
          manifest.adHoc === undefined
            ? null
            : {
                retainedGameCount: manifest.adHoc.facts.retainedGameCount,
                unfinishedGameCount: manifest.adHoc.facts.unfinishedGameCount,
                resurrectionExposure: "older-snapshot-may-resurrect-departed-session",
                restoredLogicalDigest: restoredAdHocFacts?.logicalDigest ?? null,
              },
        failedDatabasePath,
        failedAdHocDatabasePath:
          failedAdHocDatabasePath !== null && (await pathExists(failedAdHocDatabasePath))
            ? failedAdHocDatabasePath
            : null,
        technicalAdminAuth: technicalAdminAuthEvidence,
        restoredGrantVersions:
          restoredFacts === null
            ? manifest.restoredGrantVersions
            : redactGrantVersions(restoredFacts),
      };
      await assertStablePrivateFile(evidencePath, evidenceIdentity, "pending restore evidence");
      options.faultInjector?.("before-completed-restore-evidence");
      await writeAtomicJsonFile(completionEvidenceCandidatePath, evidence);
      restoreSucceeded = true;
      return {
        restoreId,
        failedDatabasePath,
        failedTechnicalAdminDatabasePath: null,
        failedAdHocDatabasePath:
          failedAdHocDatabasePath !== null && (await pathExists(failedAdHocDatabasePath))
            ? failedAdHocDatabasePath
            : null,
        completed: true as const,
        evidencePath,
        completionEvidencePath: completionEvidenceCandidatePath,
        completionEvidenceStatus: "written" as const,
        potentiallyNewerWork,
        technicalAdminAuth: technicalAdminAuthSuccessReport,
        authorityResurrectionWarning:
          "Restoring an older snapshot may resurrect Grants, Grant Sessions, Ad Hoc Controller sessions, or QR-admitting state changed after the snapshot.",
      };
    } catch (error) {
      try {
        if (!(await pathExists(failedDatabasePath)) && (await pathExists(livePath))) {
          await copyStablePrivateFile(livePath, failedDatabasePath);
        }
      } catch {
        // Preserve the bounded failure classification even if evidence I/O is
        // unavailable; never replace it with a raw filesystem exception.
      }
      try {
        if (
          failedAdHocDatabasePath !== null &&
          adHocLivePath !== null &&
          !(await pathExists(failedAdHocDatabasePath)) &&
          (await pathExists(adHocLivePath))
        ) {
          await copyStablePrivateFile(adHocLivePath, failedAdHocDatabasePath);
        }
      } catch {
        // The original Foundation failure and auth outcome remain authoritative.
      }
      throw new FoundationRestoreFailure(
        error,
        technicalAdminAuthReport,
        restorePhase,
        cutoverCompleted,
      );
    } finally {
      staged?.close();
      if (restoreSucceeded) {
        if (stagedIdentity !== null) await removeMatchingStablePath(stagedPath, stagedIdentity);
        if (stagedAdHocIdentity !== null && stagedAdHocPath !== null)
          await removeMatchingStablePath(stagedAdHocPath, stagedAdHocIdentity);
        for (const [sidecarPath, identity] of stagedSidecarIdentities) {
          await removeMatchingStablePath(sidecarPath, identity);
        }
        await rm(restoreAttemptDirectory, { recursive: true, force: true });
      }
    }
  }

  async function importControllerRecovery(
    input: RecoveryImportInput,
  ): Promise<{ outcome: FoundationBatchOutcome; evidencePath: string }> {
    await prepareBackupWorkspace(liveDirectory, backupDirectory);
    const normalized = normalizeRecoveryImport(input);
    const evidencePath = join(backupDirectory, `${normalized.importId}.recovery-import.json`);
    await assertPathAbsent(evidencePath, "recovery import evidence");
    const pendingEvidence = {
      version: RECOVERY_EVIDENCE_VERSION,
      kind: "recovery-import",
      importId: normalized.importId,
      recordedAtMs: readTime(nowMs),
      status: "pending",
      eventGameReference: redactReference(normalized.eventGameId),
      actionOperationReferences: normalized.actions.map((action) =>
        redactReference(action.action.operationId),
      ),
      gaps: normalized.gaps,
    };
    const evidenceIdentity = await writeJsonFile(evidencePath, pendingEvidence);
    const actions = normalized.actions.map(({ action: source, sourceAcceptedAtMs }) => ({
      recordId: normalized.recordId,
      eventGameId: normalized.eventGameId,
      operationId: source.operationId,
      kind: source.kind,
      payload: structuredClone(source.payload),
      causalPredecessorIds: [...source.causalPredecessorIds],
      occurrence: structuredClone(source.occurrence),
      grant: structuredClone(normalized.currentGrant),
      lifecycle: structuredClone(normalized.currentLifecycle),
      ...(source.override === undefined ? {} : { override: structuredClone(source.override) }),
      recoveryProvenance: {
        importId: normalized.importId,
        sourceRecordId: normalized.recordId,
        sourceEventGameId: normalized.eventGameId,
        sourceOperationId: source.operationId,
        sourceReference: normalized.sourceReference,
        sourceAcceptedAtMs,
      },
    }));
    const outcome = await acceptance.submitBatch({
      recordId: normalized.recordId,
      eventGameId: normalized.eventGameId,
      mode: "online",
      sessionBearer: normalized.sessionBearer,
      actions,
    });
    const rejectionGaps = normalized.actions.flatMap((_, index) => {
      const result = outcome.results[index];
      return result?.status === "accepted" || result?.status === "duplicate-accepted"
        ? []
        : [
            {
              gapId: `action-${index + 1}-not-accepted`,
              category: "action-rejected" as const,
              redactedDetail: "A supplied Controller action was not recovered.",
            },
          ];
    });
    await writeJsonFile(
      evidencePath,
      {
        ...pendingEvidence,
        recordedAtMs: readTime(nowMs),
        status: outcome.status,
        gaps: [...normalized.gaps, ...rejectionGaps],
      },
      "replace-owned",
      evidenceIdentity,
    );
    return { outcome, evidencePath };
  }

  async function verifyDatabase(
    databasePath: string,
    expected: RecoverySnapshotFacts,
  ): Promise<{ facts: RecoverySnapshotFacts; keyVersions: RepresentedKeyVersions }> {
    const verificationPath = `${databasePath}.verify-${boundedId(createId(), "verificationId")}`;
    const verificationIdentity = await copyStablePrivateFile(databasePath, verificationPath);
    let verifier: SqliteFoundationStorage | undefined;
    try {
      const inspection = new Database(verificationPath, { readonly: true });
      let facts: RecoverySnapshotFacts;
      let keyVersions: RepresentedKeyVersions;
      try {
        facts = inspectRecoveryDatabase(inspection);
        keyVersions = readRepresentedKeyVersions(inspection);
      } finally {
        inspection.close();
      }
      if (
        facts.logicalDigest !== expected.logicalDigest ||
        facts.actionCount !== expected.actionCount
      ) {
        throw new Error("Backup deterministic state differs from the quiesced recovery point.");
      }
      requireRepresentedKeys(keyVersions, options.keyRing);
      verifier = openSqliteFoundationStorage(verificationPath, {
        grantKeyRing: options.keyRing,
        grantValidationContext: {
          environmentId: options.grant.environmentId,
          keyRing: options.keyRing,
        },
      });
      verifier.setReadinessContext(options.readinessContext);
      const readiness = await verifier.readiness();
      if (!readiness.ok) {
        const migration = await verifier.migrationPreflight();
        if (migration.status !== "pending" && migration.status !== "missing") {
          throw new Error(
            "Independent backup integrity, reference, key, or replay verification failed.",
          );
        }
        await verifier.applyMigrations({ requireCandidate: false });
      }
      const finalReadiness = await verifier.readiness();
      if (!finalReadiness.ok || finalReadiness.evidence?.keys.missingCount !== 0) {
        throw new Error(
          "Independent backup integrity, reference, key, or replay verification failed.",
        );
      }
      return { facts, keyVersions };
    } finally {
      verifier?.close();
      await removeStablePath(verificationPath, verificationIdentity);
      await rm(`${verificationPath}-wal`, { force: true });
      await rm(`${verificationPath}-shm`, { force: true });
      await rm(`${verificationPath}.quarantine`, { force: true });
    }
  }

  return { createPreDeploymentBackup, verifyBackup, restore, importControllerRecovery };
}

async function prepareTechnicalAdminForRestore(
  adapter: Pick<TechnicalAdminAuth, "prepareForFoundationRestore">,
  mode: TechnicalAdminRestorePreparationRequest["mode"],
): Promise<TechnicalAdminRestorePreparationResult> {
  try {
    const result = await adapter.prepareForFoundationRestore({ mode });
    if (result.outcome === "preserved-transients-invalidated") {
      return result;
    }
    if (
      result.outcome === "re-enrollment-required" &&
      (result.reason === "missing" ||
        result.reason === "invalid" ||
        result.reason === "incompatible" ||
        result.reason === "explicit-reset")
    ) {
      return result;
    }
  } catch {
    // The composition boundary deliberately exposes no adapter or storage error.
  }
  return { outcome: "sanitation-failed" };
}

function toTechnicalAdminRecoveryResult(
  result: TechnicalAdminRestorePreparationResult,
): Exclude<TechnicalAdminRecoveryResult, { outcome: "not-attempted" }> {
  if (result.outcome === "preserved-transients-invalidated") {
    return {
      outcome: result.outcome,
      credentialPreserved: true,
      reEnrollmentRequired: false,
    };
  }
  if (result.outcome === "re-enrollment-required") {
    return {
      outcome: result.outcome,
      credentialPreserved: false,
      reEnrollmentRequired: true,
    };
  }
  return {
    outcome: "sanitation-failed",
    credentialPreserved: false,
    reEnrollmentRequired: false,
  };
}

function toTechnicalAdminSuccessResult(
  result: TechnicalAdminRestorePreparationResult,
): FoundationRestoreSuccessTechnicalAdminReport {
  if (result.outcome === "preserved-transients-invalidated") {
    return {
      outcome: result.outcome,
      credentialPreserved: true,
      reEnrollmentRequired: false,
    };
  }
  if (result.outcome === "re-enrollment-required") {
    return {
      outcome: result.outcome,
      credentialPreserved: false,
      reEnrollmentRequired: true,
    };
  }
  throw new Error("Technical Admin sanitation did not produce a successful recovery result.");
}

function redactTechnicalAdminRestoreResult(
  result: TechnicalAdminRestorePreparationResult,
): TechnicalAdminRestorePreparationResult {
  return result.outcome === "re-enrollment-required"
    ? { outcome: result.outcome, reason: result.reason }
    : { outcome: result.outcome };
}

async function reevaluateRestoredAuthority(
  storage: SqliteFoundationStorage,
  options: GrantAuthorityOptions,
): Promise<void> {
  await storage.transaction((transaction) => {
    const current = readTime(() => options.clock.nowMs());
    for (const stored of transaction.listGrants()) {
      const grant = expireGrantIfDue(transaction, options, stored);
      if (grant.status !== "active") continue;
      if (grant.grantType === "event-admin") {
        for (const session of transaction.listGrantSessions(grant.grantId)) {
          if (
            session.status === "active" &&
            current >=
              Math.min(
                grant.expiresAtMs ?? Number.MAX_SAFE_INTEGER,
                session.lastActiveAtMs + EVENT_ADMIN_IDLE_TTL_MS,
              )
          )
            expireSession(transaction, options, grant, session);
        }
        continue;
      }
      if (grant.grantType !== "control") continue;
      const resolveSession = options.controlScopeResolver.resolveSession;
      const activeSessions = transaction
        .listGrantSessions(grant.grantId)
        .filter((session) => session.status === "active");
      if (activeSessions.length > 0 && resolveSession === undefined) {
        throw new Error("Current Control Session lifecycle seam is unavailable during restore.");
      }
      const currentLockedEventGameId =
        grant.code?.state === "present"
          ? resolveCurrentGrantCodeGameLock(options, grant.scope as ControlGrantScope)
          : null;
      for (const session of activeSessions) {
        let resolution;
        try {
          resolution = resolveControlSession(
            transaction,
            options,
            grant.scope as ControlGrantScope,
            session.eventGameId,
          );
        } catch {
          throw new Error(
            "Current Control Session lifecycle could not be resolved during restore.",
          );
        }
        if (
          resolution.status === "current" ||
          resolution.status === "pinned" ||
          resolution.status === "switchable"
        )
          continue;
        if (resolution.status !== "game-locked" && resolution.status !== "past-game-day") {
          throw new Error(
            "Current Control Session lifecycle could not be resolved during restore.",
          );
        }
        terminateExactRestoredControlSession(
          transaction,
          options,
          grant,
          session,
          resolution.status,
        );
      }
      if (currentLockedEventGameId !== null && grant.code?.state === "present") {
        const erased = eraseGrantCode(grant.code, "erased");
        transaction.updateGrant({ ...grant, code: erased });
        const audit = createAuditEntry(options, {
          action: "grant-code-erased-game-lock",
          actor: { kind: "system", value: "grant-session-termination" },
          grant,
          sessionId: null,
          replacedSessionId: null,
          eventGameId: currentLockedEventGameId,
          beforeStatus: grant.status,
          afterStatus: grant.status,
          terminalReason: "game-locked",
        });
        transaction.appendGrantAudit({
          ...audit,
          credentialKind: GRANT_CODE_KIND,
          credentialFingerprint: grant.code.fingerprint,
          codeFormatVersion: grant.code.formatVersion,
          codeEncryptionKeyVersion: grant.code.encryptionKeyVersion,
          codeLookupKeyVersion: grant.code.lookupKeyVersion,
          codeStateBefore: grant.code.state,
          codeState: "erased",
          previousCodeFingerprint: grant.code.fingerprint,
        });
      }
    }
  });
}

function resolveCurrentGrantCodeGameLock(
  options: GrantAuthorityOptions,
  scope: ControlGrantScope,
): string | null {
  let resolution;
  try {
    resolution = options.controlScopeResolver.resolve(scope);
  } catch {
    throw new Error("Current Control Grant lifecycle could not be resolved during restore.");
  }
  if (resolution.status === "eligible") {
    boundedId(resolution.eventGameId, "eventGameId");
    return null;
  }
  if (resolution.status === "terminal") {
    if (resolution.reason !== "game-locked") return null;
    if (resolution.eventGameId === undefined) {
      throw new Error("Current Control Grant Game Lock identity is unavailable during restore.");
    }
    return boundedId(resolution.eventGameId, "eventGameId");
  }
  throw new Error("Current Control Grant lifecycle could not be resolved during restore.");
}

function terminateExactRestoredControlSession(
  transaction: FoundationStorageTransaction,
  options: GrantAuthorityOptions,
  grant: StoredGrant,
  session: StoredGrantSession,
  reason: Extract<TerminalGrantSessionReason, "game-locked" | "past-game-day">,
): void {
  const terminatedAtMs = readTime(() => options.clock.nowMs());
  transaction.updateGrantSession({
    ...session,
    status: "expired",
    bearerMaterialState: "erased",
    bearerLookupVerifier: null,
    bearerLookupKeyVersion: null,
    revokedAtMs: terminatedAtMs,
  });
  transaction.appendGrantAudit(
    createAuditEntry(options, {
      action: "session-terminated",
      actor: { kind: "system", value: "grant-session-termination" },
      grant,
      sessionId: session.sessionId,
      replacedSessionId: null,
      eventGameId: session.eventGameId,
      beforeStatus: grant.status,
      afterStatus: grant.status,
      terminalReason: reason,
    }),
  );
}

function normalizeRecoveryImport(input: RecoveryImportInput): RecoveryImportInput {
  const importId = boundedId(input.importId, "importId");
  boundedId(input.recordId, "recordId");
  boundedId(input.eventGameId, "eventGameId");
  boundedId(input.sourceReference, "sourceReference");
  if (
    !Array.isArray(input.actions) ||
    input.actions.length === 0 ||
    input.actions.length > ACCEPTANCE_LIMITS.maxBatchActions
  )
    throw new Error("Recovery import action count is outside the bounded batch limit.");
  if (!Array.isArray(input.gaps) || input.gaps.length > ACCEPTANCE_LIMITS.maxBatchActions)
    throw new Error("Recovery Gap count is outside the bounded batch limit.");
  if (input.actions.length + input.gaps.length > ACCEPTANCE_LIMITS.maxBatchActions * 2)
    throw new Error("Recovery import evidence count is outside the bounded limit.");
  if (typeof input.sessionBearer !== "string" || input.sessionBearer.length === 0) {
    throw new Error("Recovery import requires fresh current Grant Session authorization.");
  }
  for (const recovered of input.actions) {
    if (
      recovered.action.recordId !== input.recordId ||
      recovered.action.eventGameId !== input.eventGameId
    ) {
      throw new Error("Recovery import rejected cross-Game Controller evidence.");
    }
    if (
      recovered.sourceAcceptedAtMs !== null &&
      (!Number.isSafeInteger(recovered.sourceAcceptedAtMs) || recovered.sourceAcceptedAtMs < 0)
    )
      throw new Error("Recovery source acceptance time is invalid.");
  }
  const gaps = input.gaps.map((gap) => ({
    gapId: boundedId(gap.gapId, "gapId"),
    category: gap.category,
    redactedDetail: boundedRedactedDetail(gap.redactedDetail),
  }));
  return { ...input, importId, gaps };
}

function requireRepresentedKeys(versions: RepresentedKeyVersions, keyRing: GrantKeyRing): void {
  for (const category of ["encryption", "lookup", "audit"] as const) {
    for (const version of versions[category]) {
      if (!keyRing[category].keys.has(version)) {
        throw new Error(
          `Separately supplied ${category} key ring is missing a represented version.`,
        );
      }
    }
  }
}

function safelyInspectClosedDatabase(databasePath: string): RecoverySnapshotFacts | null {
  try {
    const database = new Database(databasePath, { readonly: true });
    try {
      return inspectRecoveryDatabase(database);
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

function redactGrantVersions(facts: RecoverySnapshotFacts) {
  return facts.grantVersions.map((grant) => ({
    grantReference: redactReference(grant.grantId),
    grantType: grant.grantType,
    grantVersion: grant.grantVersion,
  }));
}

function redactReference(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function boundedRedactedDetail(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 160) {
    throw new Error("Recovery Gap detail must be a bounded redacted statement.");
  }
  if (/bearer|credential|cipher|token|secret|lookup|passkey/i.test(value)) {
    throw new Error("Recovery Gap detail appears to contain authority material.");
  }
  return value;
}

function boundedId(value: string, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw new Error(`${label} must be an opaque bounded identifier.`);
  }
  return value;
}

function readTime(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Recovery clock is invalid.");
  return value;
}

function assertBackupOutsideLiveDirectory(liveDirectory: string, backupDirectory: string): void {
  if (!isAbsolute(backupDirectory)) throw new Error("Backup directory must be absolute.");
  const location = relative(liveDirectory, backupDirectory);
  if (location === "" || (!location.startsWith("..") && !isAbsolute(location))) {
    throw new Error("Verified SQLite backups must be outside the live database directory.");
  }
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readStablePrivateFile(path))
    .digest("hex");
}

async function writeJsonFile(
  path: string,
  value: unknown,
  mode: "create" | "replace-owned" = "create",
  expectedIdentity?: StableFileIdentity,
): Promise<StableFileIdentity> {
  const flags =
    mode === "create"
      ? fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW
      : fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW;
  const handle = await openFile(path, flags, 0o600);
  let openedIdentity: StableFileIdentity | null = null;
  try {
    await handle.chmod(0o600);
    openedIdentity = stableIdentity(await handle.stat());
    await assertStablePrivateFile(path, openedIdentity, "recovery evidence");
    if (expectedIdentity !== undefined && !samePhysicalFile(openedIdentity, expectedIdentity)) {
      throw new Error("Recovery evidence changed file identity before it was updated.");
    }
    if (mode === "replace-owned") await handle.truncate(0);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    const writtenIdentity = stableIdentity(await handle.stat());
    if (!samePhysicalFile(openedIdentity, writtenIdentity)) {
      throw new Error("Recovery evidence changed file identity while it was written.");
    }
    await assertStablePrivateFile(path, writtenIdentity, "recovery evidence");
    await handle.close();
    await assertStablePrivateFile(path, writtenIdentity, "recovery evidence");
    await syncDirectory(dirname(path));
    return writtenIdentity;
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (mode === "create" && openedIdentity !== null) {
      await removeStablePath(path, openedIdentity);
    }
    throw error;
  }
}

async function writeAtomicJsonFile(path: string, value: unknown): Promise<StableFileIdentity> {
  await assertPathAbsent(path, "atomic recovery evidence");
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let temporaryIdentity: StableFileIdentity | null = null;
  try {
    temporaryIdentity = await writeJsonFile(temporaryPath, value);
    const publishedIdentity = await moveToExclusivePath(
      temporaryPath,
      path,
      "atomic recovery evidence",
      temporaryIdentity,
    );
    temporaryIdentity = null;
    await syncDirectory(dirname(path));
    return publishedIdentity;
  } finally {
    if (temporaryIdentity !== null) {
      await removeStablePath(temporaryPath, temporaryIdentity);
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await openFile(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readManifest(
  path: string,
  backupDirectory: string,
): Promise<FoundationRecoveryManifest> {
  const resolvedPath = resolve(path);
  if (dirname(resolvedPath) !== backupDirectory) {
    throw new Error("Recovery manifest must be in the owned backup workspace.");
  }
  const parsed: unknown = JSON.parse((await readStablePrivateFile(resolvedPath)).toString("utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== RECOVERY_MANIFEST_VERSION ||
    (parsed as { policyVersion?: unknown }).policyVersion !== FOUNDATION_BACKUP_POLICY_VERSION ||
    typeof (parsed as { snapshotId?: unknown }).snapshotId !== "string" ||
    typeof (parsed as { databaseFile?: unknown }).databaseFile !== "string" ||
    !/^[a-f0-9]{64}$/.test(String((parsed as { databaseSha256?: unknown }).databaseSha256)) ||
    !Number.isSafeInteger((parsed as { actionCount?: unknown }).actionCount) ||
    (parsed as { actionCount: number }).actionCount < 0
  )
    throw new Error("Recovery manifest is incompatible.");
  const manifest = parsed as FoundationRecoveryManifest;
  boundedId(manifest.snapshotId, "snapshotId");
  if (manifest.databaseFile !== `${manifest.snapshotId}.sqlite`) {
    throw new Error("Recovery manifest database identity is invalid.");
  }
  if (manifest.adHoc !== undefined) {
    if (
      typeof manifest.adHoc !== "object" ||
      manifest.adHoc === null ||
      manifest.adHoc.databaseFile !== `${manifest.snapshotId}.ad-hoc.sqlite` ||
      !/^[a-f0-9]{64}$/.test(manifest.adHoc.databaseSha256) ||
      manifest.adHoc.facts?.version !== "ad-hoc-recovery-manifest-v1"
    ) {
      throw new Error("Recovery manifest Ad Hoc database identity is invalid.");
    }
  }
  return manifest;
}

function resolveBackupAdHocDatabasePath(
  manifestPath: string,
  manifest: FoundationRecoveryManifest,
  backupDirectory: string,
): string {
  if (manifest.adHoc === undefined) throw new Error("Recovery manifest has no Ad Hoc database.");
  const databasePath = resolve(backupDirectory, manifest.adHoc.databaseFile);
  if (
    dirname(databasePath) !== backupDirectory ||
    basename(databasePath) !== manifest.adHoc.databaseFile ||
    resolve(manifestPath) === databasePath
  ) {
    throw new Error("Recovery manifest Ad Hoc database path is invalid.");
  }
  return databasePath;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return false;
  }
}

type StableFileIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
};

async function prepareBackupWorkspace(
  liveDirectory: string,
  backupDirectory: string,
): Promise<void> {
  try {
    await lstat(backupDirectory);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  }
  const workspace = await lstat(backupDirectory);
  const currentUid = process.getuid?.();
  if (
    workspace.isSymbolicLink() ||
    !workspace.isDirectory() ||
    (workspace.mode & 0o777) !== 0o700 ||
    (currentUid !== undefined && workspace.uid !== currentUid)
  )
    throw new Error("Recovery backup workspace must be an owned non-symlink 0700 directory.");
  const physicalLiveDirectory = await realpath(liveDirectory);
  const physicalBackupDirectory = await realpath(backupDirectory);
  assertBackupOutsideLiveDirectory(physicalLiveDirectory, physicalBackupDirectory);
}

async function assertPathAbsent(path: string, label: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  throw new Error(`Refusing to replace a pre-existing ${label} path.`);
}

async function assertOwnedPrivateFile(path: string, label: string): Promise<StableFileIdentity> {
  const info = await lstat(path);
  const currentUid = process.getuid?.();
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    (info.mode & 0o777) !== 0o600 ||
    (currentUid !== undefined && info.uid !== currentUid)
  )
    throw new Error(`${label} must be an owned non-symlink 0600 regular file.`);
  return stableIdentity(info);
}

async function assertOwnedPrivateDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  const currentUid = process.getuid?.();
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    (info.mode & 0o777) !== 0o700 ||
    (currentUid !== undefined && info.uid !== currentUid)
  )
    throw new Error(`${label} must be an owned non-symlink 0700 directory.`);
}

async function assertStablePrivateFile(
  path: string,
  expected: StableFileIdentity,
  label: string,
): Promise<void> {
  const current = await assertOwnedPrivateFile(path, label);
  if (!samePhysicalFile(current, expected)) {
    throw new Error(`${label} changed file identity during recovery.`);
  }
}

async function assertStableSourceFile(
  path: string,
  expected: StableFileIdentity,
  label: string,
): Promise<void> {
  const info = await lstat(path);
  const currentUid = process.getuid?.();
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    (currentUid !== undefined && info.uid !== currentUid)
  ) {
    throw new Error(`${label} must be an owned non-symlink regular file.`);
  }
  const current = stableIdentity(info);
  if (!sameFileSnapshot(current, expected)) {
    throw new Error(`${label} changed file identity during recovery.`);
  }
}

async function assertStableFileIdentity(
  path: string,
  expected: StableFileIdentity,
  label: string,
): Promise<void> {
  const current = stableIdentity(await lstat(path));
  if (!sameFileSnapshot(current, expected)) {
    throw new Error(`${label} changed during recovery.`);
  }
}

async function readStablePrivateFile(path: string, requirePrivateMode = true): Promise<Buffer> {
  const handle = await openFile(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = stableIdentity(await handle.stat());
    if (requirePrivateMode) {
      await assertStablePrivateFile(path, before, "recovery source file");
    } else {
      await assertStableSourceFile(path, before, "recovery source file");
    }
    const content = await handle.readFile();
    const after = stableIdentity(await handle.stat());
    if (!sameFileSnapshot(before, after)) {
      throw new Error("Recovery source file changed while it was read.");
    }
    if (requirePrivateMode) {
      await assertStablePrivateFile(path, before, "recovery source file");
    } else {
      await assertStableSourceFile(path, before, "recovery source file");
    }
    return content;
  } finally {
    await handle.close();
  }
}

async function copyStablePrivateFile(
  sourcePath: string,
  destinationPath: string,
  expectedSha256?: string,
): Promise<StableFileIdentity> {
  const source = await openFile(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let sourceIdentity: StableFileIdentity | null = null;
  let destination: Awaited<ReturnType<typeof openFile>> | undefined;
  let openedIdentity: StableFileIdentity | null = null;
  try {
    sourceIdentity = stableIdentity(await source.stat());
    await assertStableSourceFile(sourcePath, sourceIdentity, "recovery source file");
    const content = await source.readFile();
    const afterReadIdentity = stableIdentity(await source.stat());
    if (!sameFileSnapshot(sourceIdentity, afterReadIdentity)) {
      throw new Error("Recovery source file changed while it was read.");
    }
    if (
      expectedSha256 !== undefined &&
      createHash("sha256").update(content).digest("hex") !== expectedSha256
    )
      throw new Error("Verified backup file identity does not match its manifest.");
    destination = await openFile(
      destinationPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await destination.chmod(0o600);
    openedIdentity = stableIdentity(await destination.stat());
    await assertStablePrivateFile(destinationPath, openedIdentity, "recovery copy");
    await destination.writeFile(content);
    await destination.sync();
    const writtenIdentity = stableIdentity(await destination.stat());
    if (!samePhysicalFile(openedIdentity, writtenIdentity)) {
      throw new Error("Recovery copy changed file identity while it was written.");
    }
    await assertStablePrivateFile(destinationPath, writtenIdentity, "recovery copy");
    await destination.close();
    destination = undefined;
    await assertStableSourceFile(sourcePath, sourceIdentity, "recovery source file");
    await assertStablePrivateFile(destinationPath, writtenIdentity, "recovery copy");
    return writtenIdentity;
  } catch (error) {
    await destination?.close().catch(() => undefined);
    if (openedIdentity !== null) await removeStablePath(destinationPath, openedIdentity);
    throw error;
  } finally {
    await source.close();
  }
}

async function moveToExclusivePath(
  sourcePath: string,
  destinationPath: string,
  label: string,
  expectedIdentity: StableFileIdentity,
): Promise<StableFileIdentity> {
  const sourceIdentity = await tightenStableOwnedFile(sourcePath, expectedIdentity, label);
  let destinationCreated = false;
  try {
    await link(sourcePath, destinationPath);
    destinationCreated = true;
    const destinationIdentity = await assertOwnedPrivateFile(destinationPath, label);
    if (!sameFileSnapshot(sourceIdentity, destinationIdentity)) {
      throw new Error(
        `${label} source changed before exclusive publication; file identity changed.`,
      );
    }
    const currentSource = await assertOwnedPrivateFile(sourcePath, `${label} source`);
    if (!sameFileSnapshot(sourceIdentity, currentSource)) {
      throw new Error(
        `${label} source changed during exclusive publication; file identity changed.`,
      );
    }
    await unlink(sourcePath);
    const publishedIdentity = await assertOwnedPrivateFile(destinationPath, label);
    if (!sameFileSnapshot(sourceIdentity, publishedIdentity)) {
      throw new Error(`${label} changed after exclusive publication; file identity changed.`);
    }
    return publishedIdentity;
  } catch (error) {
    if (destinationCreated) await removeStablePath(destinationPath, sourceIdentity);
    throw error;
  }
}

async function tightenStableOwnedFile(
  path: string,
  expected: StableFileIdentity,
  label: string,
): Promise<StableFileIdentity> {
  const handle = await openFile(path, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
  try {
    const beforeInfo = await handle.stat();
    const currentUid = process.getuid?.();
    if (!beforeInfo.isFile() || (currentUid !== undefined && beforeInfo.uid !== currentUid)) {
      throw new Error(`${label} source must be an owned non-symlink regular file.`);
    }
    const before = stableIdentity(beforeInfo);
    if (!sameFileSnapshot(before, expected)) {
      throw new Error(
        `${label} source changed before exclusive publication; file identity changed.`,
      );
    }
    await assertStableFileIdentity(path, before, `${label} source`);
    await handle.chmod(0o600);
    await handle.sync();
    const afterInfo = await handle.stat();
    const after = stableIdentity(afterInfo);
    if (
      !afterInfo.isFile() ||
      (afterInfo.mode & 0o777) !== 0o600 ||
      (currentUid !== undefined && afterInfo.uid !== currentUid) ||
      !sameFileSnapshot(before, after)
    ) {
      throw new Error(`${label} source changed while its private mode was enforced.`);
    }
    await assertStablePrivateFile(path, after, `${label} source`);
    return after;
  } finally {
    await handle.close();
  }
}

async function removeStablePath(path: string, expected: StableFileIdentity): Promise<void> {
  let current: StableFileIdentity;
  try {
    current = stableIdentity(await lstat(path));
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  if (!samePhysicalFile(current, expected)) {
    throw new Error("Refusing to remove a recovery path whose file identity changed.");
  }
  await unlink(path);
}

async function removeMatchingStablePath(path: string, expected: StableFileIdentity): Promise<void> {
  await removeStablePath(path, expected).catch(() => undefined);
}

function resolveBackupDatabasePath(
  manifestPath: string,
  manifest: FoundationRecoveryManifest,
  backupDirectory: string,
): string {
  if (dirname(resolve(manifestPath)) !== backupDirectory) {
    throw new Error("Recovery manifest must be in the owned backup workspace.");
  }
  const databasePath = resolve(backupDirectory, manifest.databaseFile);
  if (
    dirname(databasePath) !== backupDirectory ||
    basename(databasePath) !== manifest.databaseFile
  ) {
    throw new Error("Recovery manifest database path escapes its directory.");
  }
  return databasePath;
}

function stableIdentity(info: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}): StableFileIdentity {
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
}

function samePhysicalFile(left: StableFileIdentity, right: StableFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left: StableFileIdentity, right: StableFileIdentity): boolean {
  return (
    samePhysicalFile(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs
  );
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
