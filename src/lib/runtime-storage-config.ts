import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { TechnicalAdminEnvironment } from "@/lib/technical-admin-auth";

export const PRODUCTION_STATE_DIRECTORY = "/var/lib/quadball-timer";
export const TEST_STATE_DIRECTORY = "/var/lib/quadball-timer-test";

export type RuntimeStoragePaths = {
  technicalAdminDatabase: string;
  foundationDatabase: string;
  eventGameDatabase: string;
};

export function readRuntimeStoragePaths(
  environment: TechnicalAdminEnvironment,
  environmentVariables: Record<string, string | undefined> = process.env,
): RuntimeStoragePaths {
  if (environment === "production") {
    if (environmentVariables.QBT_FOCUSED_TEST_MODE === "1") {
      const focusedRoot = environmentVariables.QBT_FOCUSED_TEST_ROOT;
      const paths = {
        technicalAdminDatabase: environmentVariables.TECHNICAL_ADMIN_DATABASE,
        foundationDatabase: environmentVariables.FOUNDATION_DATABASE,
        eventGameDatabase: environmentVariables.EVENT_GAME_DATABASE,
      };
      if (
        process.getuid?.() === 0 ||
        focusedRoot === undefined ||
        !focusedRoot.startsWith("/") ||
        focusedRoot === "/" ||
        focusedRoot.includes("..") ||
        focusedRoot.includes("//") ||
        !isCanonicalFocusedDirectory(focusedRoot) ||
        Object.values(paths).some(
          (path) => path === undefined || !isCanonicalFocusedPath(path, focusedRoot),
        )
      ) {
        throw new Error("Focused activation paths must be absolute and disposable.");
      }
      return paths as RuntimeStoragePaths;
    }
    const canonicalPaths = {
      technicalAdminDatabase: `${PRODUCTION_STATE_DIRECTORY}/technical-admin.sqlite`,
      foundationDatabase: `${PRODUCTION_STATE_DIRECTORY}/foundation.sqlite`,
      eventGameDatabase: `${PRODUCTION_STATE_DIRECTORY}/event-game.sqlite`,
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
    requireCanonicalProductionPath(
      "EVENT_GAME_DATABASE",
      environmentVariables.EVENT_GAME_DATABASE,
      canonicalPaths.eventGameDatabase,
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
    eventGameDatabase:
      environmentVariables.EVENT_GAME_DATABASE?.trim() || `${defaultDirectory}/event-game.sqlite`,
  };
}

function isCanonicalFocusedDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(path) === path;
  } catch {
    return false;
  }
}

function isCanonicalFocusedPath(path: string, root: string): boolean {
  if (!path.startsWith(`${root}/`) || path.includes("..") || path.includes("//")) return false;
  const directory = dirname(path);
  try {
    return realpathSync(root) === root && realpathSync(directory) === directory;
  } catch {
    return false;
  }
}

export function assertProductionStateBoundary(
  environment: TechnicalAdminEnvironment,
  paths: RuntimeStoragePaths,
): void {
  if (environment !== "production") return;

  if (
    !isAbsolute(paths.technicalAdminDatabase) ||
    !isAbsolute(paths.foundationDatabase) ||
    !isAbsolute(paths.eventGameDatabase)
  ) {
    throw new Error("Production database paths must be absolute.");
  }

  const technicalAdminDirectory = dirname(paths.technicalAdminDatabase);
  const databaseDirectories = [
    technicalAdminDirectory,
    dirname(paths.foundationDatabase),
    dirname(paths.eventGameDatabase),
  ];
  if (databaseDirectories.some((directory) => directory !== technicalAdminDirectory)) {
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

export function assertEnvironmentStorageBoundary(
  environment: "production" | "test",
  paths: RuntimeStoragePaths,
): void {
  if (environment !== "test") return;

  const productionPrefix = `${PRODUCTION_STATE_DIRECTORY}/`;
  if (
    [paths.technicalAdminDatabase, paths.foundationDatabase, paths.eventGameDatabase].some(
      (path) => path === PRODUCTION_STATE_DIRECTORY || path.startsWith(productionPrefix),
    )
  ) {
    throw new Error("Test databases must not use Production state.");
  }
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
