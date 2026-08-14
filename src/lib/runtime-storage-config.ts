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
  const defaultDirectory =
    environment === "production" ? PRODUCTION_STATE_DIRECTORY : `data/${environment}`;

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
}
