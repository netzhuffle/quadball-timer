import { accessSync, constants, lstatSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { TechnicalAdminEnvironment } from "@/lib/technical-admin-auth";

export const PRODUCTION_STATE_DIRECTORY = "/var/lib/quadball-timer";

export type RuntimeStoragePaths = {
  technicalAdminDatabase: string;
  foundationDatabase: string;
};

export function readRuntimeStoragePaths(
  environment: TechnicalAdminEnvironment,
  environmentVariables: Record<string, string | undefined> = process.env,
): RuntimeStoragePaths {
  if (environment === "production") {
    const canonicalPaths = {
      technicalAdminDatabase: `${PRODUCTION_STATE_DIRECTORY}/technical-admin.sqlite`,
      foundationDatabase: `${PRODUCTION_STATE_DIRECTORY}/foundation.sqlite`,
    };
    requireCanonicalProductionPath(
      "TECHNICAL_ADMIN_DATABASE",
      environmentVariables.TECHNICAL_ADMIN_DATABASE,
      canonicalPaths.technicalAdminDatabase,
    );
    requireCanonicalProductionPath(
      "FOUNDATION_DATABASE",
      environmentVariables.FOUNDATION_DATABASE,
      canonicalPaths.foundationDatabase,
    );
    return canonicalPaths;
  }

  const defaultDirectory = `data/${environment}`;

  return {
    technicalAdminDatabase:
      environmentVariables.TECHNICAL_ADMIN_DATABASE?.trim() ||
      `${defaultDirectory}/technical-admin.sqlite`,
    foundationDatabase:
      environmentVariables.FOUNDATION_DATABASE?.trim() || `${defaultDirectory}/foundation.sqlite`,
  };
}

export function assertProductionStateBoundary(
  environment: TechnicalAdminEnvironment,
  paths: RuntimeStoragePaths,
): void {
  if (environment !== "production") return;

  if (!isAbsolute(paths.technicalAdminDatabase) || !isAbsolute(paths.foundationDatabase)) {
    throw new Error("Production database paths must be absolute.");
  }

  const technicalAdminDirectory = dirname(paths.technicalAdminDatabase);
  const foundationDirectory = dirname(paths.foundationDatabase);
  if (technicalAdminDirectory !== foundationDirectory) {
    throw new Error("Production databases must use one state directory.");
  }

  let stateDirectory;
  try {
    stateDirectory = lstatSync(technicalAdminDirectory);
  } catch {
    throw new Error("Production state directory is absent or inaccessible.");
  }

  if (!stateDirectory.isDirectory() || stateDirectory.isSymbolicLink()) {
    throw new Error("Production state directory must be a real directory.");
  }

  if ((stateDirectory.mode & 0o022) !== 0) {
    throw new Error("Production state directory permissions are unsafe.");
  }

  const currentUserId = process.getuid?.();
  if (currentUserId !== undefined && stateDirectory.uid !== currentUserId) {
    throw new Error("Production state directory has the wrong owner.");
  }

  try {
    accessSync(technicalAdminDirectory, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    throw new Error("Production state directory is not readable and writable by the service.");
  }

  assertTechnicalAdminDatabaseFile(paths.technicalAdminDatabase, currentUserId);
}

function requireCanonicalProductionPath(
  variableName: string,
  configuredPath: string | undefined,
  canonicalPath: string,
): void {
  const normalizedPath = configuredPath?.trim();
  if (normalizedPath !== undefined && normalizedPath !== "" && normalizedPath !== canonicalPath) {
    throw new Error(`${variableName} must use its canonical path ${canonicalPath}.`);
  }
}

function assertTechnicalAdminDatabaseFile(
  databasePath: string,
  currentUserId: number | undefined,
): void {
  let databaseFile;
  try {
    databaseFile = lstatSync(databasePath);
  } catch (error) {
    if (isMissingPath(error)) return;
    throw new Error("Technical Admin database is inaccessible.");
  }

  if (!databaseFile.isFile() || databaseFile.isSymbolicLink()) {
    throw new Error("Technical Admin database must be a regular file.");
  }
  if ((databaseFile.mode & 0o022) !== 0) {
    throw new Error("Technical Admin database permissions are unsafe.");
  }
  if (currentUserId !== undefined && databaseFile.uid !== currentUserId) {
    throw new Error("Technical Admin database has the wrong owner.");
  }
  try {
    accessSync(databasePath, constants.R_OK | constants.W_OK);
  } catch {
    throw new Error("Technical Admin database is not readable and writable by the service.");
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
