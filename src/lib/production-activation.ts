import { lstat, readlink, rename, rm, symlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { FoundationRecoveryManifest } from "./foundation-recovery";

/**
 * The metadata that makes a Foundation recovery snapshot usable by deployment.
 * The Foundation recovery contract owns the database contents and exclusion
 * policy; this envelope binds that snapshot to one deployment attempt.
 */
export type ProductionBackupMetadata = {
  environment: "production";
  createdAtMs: number;
  sourceReleaseAttemptId: string;
  schemaCompatibility: string;
  migrationLedgerSchemaVersion: string;
  databaseSha256: string;
  representedKeyVersions: FoundationRecoveryManifest["representedKeyVersions"];
  adHoc: {
    databaseSha256: NonNullable<FoundationRecoveryManifest["adHoc"]>["databaseSha256"];
    facts: NonNullable<FoundationRecoveryManifest["adHoc"]>["facts"];
  };
};

export type VerifiedProductionBackup = {
  manifest: FoundationRecoveryManifest;
  metadata: ProductionBackupMetadata;
};

export type PromoteVerifiedBackupInput = {
  backupDirectory: string;
  candidateDirectory: string;
  manifestPath: string;
  releaseAttemptId: string;
  verifyCandidate(): Promise<VerifiedProductionBackup>;
  /** Test-only failure seam immediately before the atomic pointer replacement. */
  beforePointerReplace?: () => void;
  /** Test-only seam for bounded cleanup after the pointer is committed. */
  afterPointerReplace?: () => void;
};

export type PromoteVerifiedBackupResult = {
  pointerCommitted: true;
  retainedTarget: string;
  cleanupWarning: string | null;
};

/**
 * Re-verify the returned candidate and atomically publish the one retained
 * pointer. The candidate remains disposable until the pointer replacement
 * succeeds, so every failure preserves the previous pointer.
 */
export async function promoteVerifiedBackup(
  input: PromoteVerifiedBackupInput,
): Promise<PromoteVerifiedBackupResult> {
  const backupDirectory = resolve(input.backupDirectory);
  const candidateDirectory = resolve(input.candidateDirectory);
  const manifestPath = resolve(input.manifestPath);
  const expectedCandidateDirectory = join(backupDirectory, `.candidate-${input.releaseAttemptId}`);
  if (
    candidateDirectory !== expectedCandidateDirectory ||
    dirname(manifestPath) !== candidateDirectory ||
    !/^[A-Za-z0-9._-]+\.manifest\.json$/u.test(basename(manifestPath))
  ) {
    throw new Error("Production backup candidate path is not canonical.");
  }

  const retainedPointer = join(backupDirectory, "retained");
  const retainedVersion = join(backupDirectory, `verified-${input.releaseAttemptId}`);
  const temporaryPointer = join(backupDirectory, `.retained-${input.releaseAttemptId}.tmp`);
  let previousTarget: string | null = null;
  try {
    const pointerInfo = await lstat(retainedPointer).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (pointerInfo !== null) {
      if (!pointerInfo.isSymbolicLink())
        throw new Error("Retained backup pointer is not a symlink.");
      previousTarget = await readlink(retainedPointer);
      if (!/^[A-Za-z0-9._-]+$/u.test(previousTarget)) {
        throw new Error("Retained backup pointer target is unsafe.");
      }
      if (previousTarget === basename(retainedVersion)) {
        throw new Error("Production backup release is already retained.");
      }
    }

    const candidateInfo = await lstat(candidateDirectory);
    const manifestInfo = await lstat(manifestPath);
    if (!candidateInfo.isDirectory() || candidateInfo.isSymbolicLink()) {
      throw new Error("Production backup candidate directory is not a regular directory.");
    }
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
      throw new Error("Production backup manifest is not a regular file.");
    }
    await input.verifyCandidate();
    await rm(retainedVersion, { recursive: true, force: true });
    await rm(temporaryPointer, { force: true });

    let movedCandidate = false;
    let pointerReplaced = false;
    try {
      await rename(candidateDirectory, retainedVersion);
      movedCandidate = true;
      await symlink(basename(retainedVersion), temporaryPointer);
      input.beforePointerReplace?.();
      await rename(temporaryPointer, retainedPointer);
      pointerReplaced = true;
    } finally {
      if (!pointerReplaced) {
        await rm(temporaryPointer, { force: true });
        if (movedCandidate) await rm(retainedVersion, { recursive: true, force: true });
        else await rm(candidateDirectory, { recursive: true, force: true });
      }
    }

    let cleanupWarning: string | null = null;
    try {
      input.afterPointerReplace?.();
      if (previousTarget !== null && previousTarget !== basename(retainedVersion)) {
        await rm(join(backupDirectory, previousTarget), { recursive: true, force: true });
      }
    } catch (error) {
      cleanupWarning = error instanceof Error ? error.message : "retained backup cleanup failed";
    }
    return {
      pointerCommitted: true,
      retainedTarget: basename(retainedVersion),
      cleanupWarning,
    };
  } catch (error) {
    await rm(candidateDirectory, { recursive: true, force: true });
    await rm(temporaryPointer, { force: true });
    throw error;
  }
}

/** Validate the deployment envelope without opening or mutating either database. */
export function assertProductionBackupMetadata(
  candidate: {
    manifest: FoundationRecoveryManifest;
    metadata: ProductionBackupMetadata;
  },
  input: { sourceReleaseAttemptId: string; schemaCompatibility: string },
): void {
  const { manifest, metadata } = candidate;
  const adHoc = requireProductionAdHocBackup(manifest);
  if (metadata.environment !== "production") {
    throw new Error("Production backup metadata has the wrong Environment.");
  }
  if (metadata.sourceReleaseAttemptId !== input.sourceReleaseAttemptId) {
    throw new Error("Production backup metadata is bound to another release attempt.");
  }
  if (metadata.schemaCompatibility !== input.schemaCompatibility) {
    throw new Error("Production backup metadata has incompatible schema compatibility.");
  }
  if (!/^[0-9]+$/u.test(metadata.migrationLedgerSchemaVersion)) {
    throw new Error("Production backup metadata has no migration-ledger schema identity.");
  }
  if (!Number.isSafeInteger(metadata.createdAtMs) || metadata.createdAtMs <= 0) {
    throw new Error("Production backup metadata has an invalid creation time.");
  }
  if (metadata.databaseSha256 !== manifest.databaseSha256) {
    throw new Error("Production backup metadata digest does not match the Foundation manifest.");
  }
  if (metadata.adHoc === undefined) {
    throw new Error("Production backup metadata has no Ad Hoc database.");
  }
  if (metadata.adHoc.databaseSha256 !== adHoc.databaseSha256) {
    throw new Error("Production backup metadata digest does not match the Ad Hoc manifest.");
  }
  if (JSON.stringify(metadata.adHoc.facts) !== JSON.stringify(adHoc.facts)) {
    throw new Error("Production backup metadata facts do not match the Ad Hoc manifest.");
  }
  if (
    JSON.stringify(metadata.representedKeyVersions) !==
    JSON.stringify(manifest.representedKeyVersions)
  ) {
    throw new Error(
      "Production backup key-version metadata does not match the Foundation manifest.",
    );
  }
  for (const versions of Object.values(metadata.representedKeyVersions)) {
    if (!Array.isArray(versions) || versions.some((version) => typeof version !== "string")) {
      throw new Error("Production backup key-version metadata is invalid.");
    }
  }
}

export function requireProductionAdHocBackup(
  manifest: FoundationRecoveryManifest,
): NonNullable<FoundationRecoveryManifest["adHoc"]> {
  if (manifest.adHoc === undefined) {
    throw new Error("Production backup manifest has no Ad Hoc database.");
  }
  return manifest.adHoc;
}
