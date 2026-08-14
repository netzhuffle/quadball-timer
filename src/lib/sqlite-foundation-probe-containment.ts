import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SQLITE_FOUNDATION_PROBE_SHARED_GROUP_ENV } from "@/lib/sqlite-foundation-probe-process";

export const SQLITE_FOUNDATION_PROBE_WRITER_COUNT = 6;
export const PROBE_DIRECTORY_PREFIX = "quadball-timer-sqlite-probe-";
export const PROBE_CONTAINER_DIRECTORY_PREFIX = "quadball-timer-sqlite-container-";
export const CAPABILITY_FILE_NAME = ".probe-capability";
export const CONTAINER_CAPABILITY_FILE_NAME = ".probe-container-capability";
export const DATABASE_FILE_NAME = "probe.sqlite";
export const SQLITE_WAL_FILE_NAME = `${DATABASE_FILE_NAME}-wal`;
export const SQLITE_SHARED_MEMORY_FILE_NAME = `${DATABASE_FILE_NAME}-shm`;
export const SQLITE_FOUNDATION_PROBE_PARENT_DIRECTORY_ENV =
  "QUADBALL_TIMER_SQLITE_PROBE_PARENT_DIRECTORY";
export const SQLITE_FOUNDATION_PROBE_PARENT_CAPABILITY_ENV =
  "QUADBALL_TIMER_SQLITE_PROBE_PARENT_CAPABILITY";
export const PROBE_CAPABILITY_PATTERN = /^[0-9a-f-]{36}$/;

export type SqliteProbeInvocation =
  | { kind: "none" }
  | { kind: "invalid"; error: string }
  | { kind: "outer" }
  | {
      kind: "writer";
      directoryPath: string;
      capability: string;
      writerId: number;
    }
  | { kind: "checkpoint"; directoryPath: string; capability: string };

export type ProbeWorkspace = {
  directoryPath: string;
  databasePath: string;
  capabilityPath: string;
  capability: string;
};

export type ProbeWorkspaceContainer = {
  directoryPath: string;
  workspaceDirectoryPath?: string;
  capabilityPath: string;
  capability: string;
};

export type ProbeWorkspaceState = "fresh" | "database" | "cleanup";

export function parseSqliteProbeInvocation(rawArguments: readonly string[]): SqliteProbeInvocation {
  const arguments_ = stripEntrypointArgument(rawArguments);
  const modeIndex = arguments_.findIndex(isProbeMode);

  if (modeIndex === -1) {
    return { kind: "none" };
  }
  if (modeIndex !== 0) {
    return invalidInvocation();
  }

  const mode = arguments_[0];
  if (mode === "--sqlite-foundation-probe") {
    return arguments_.length === 1 ? { kind: "outer" } : invalidInvocation();
  }

  if (mode === "--sqlite-foundation-probe-writer") {
    if (arguments_.length !== 4) {
      return invalidInvocation();
    }
    const directoryPath = arguments_[1];
    const capability = arguments_[2];
    const writerId = Number(arguments_[3]);
    if (
      directoryPath === undefined ||
      capability === undefined ||
      !isProbeCapability(capability) ||
      !Number.isSafeInteger(writerId) ||
      writerId < 0 ||
      writerId >= SQLITE_FOUNDATION_PROBE_WRITER_COUNT
    ) {
      return invalidInvocation();
    }
    return { kind: "writer", directoryPath, capability, writerId };
  }

  if (arguments_.length !== 3) {
    return invalidInvocation();
  }
  const directoryPath = arguments_[1];
  const capability = arguments_[2];
  if (directoryPath === undefined || capability === undefined || !isProbeCapability(capability)) {
    return invalidInvocation();
  }
  return { kind: "checkpoint", directoryPath, capability };
}

export async function createProbeWorkspace(
  container?: ProbeWorkspaceContainer | null,
): Promise<ProbeWorkspace> {
  const configuredContainer =
    container === undefined ? await readProbeWorkspaceContainerFromEnv() : container;
  const ownedContainer =
    configuredContainer === null
      ? null
      : await validateOwnedProbeWorkspaceContainer(
          configuredContainer.directoryPath,
          configuredContainer.capability,
        );
  const parentDirectory = ownedContainer?.workspaceDirectoryPath ?? ownedContainer?.directoryPath;
  const directoryPath = await mkdtemp(
    path.join(parentDirectory ?? tmpdir(), PROBE_DIRECTORY_PREFIX),
  );
  try {
    await chmod(directoryPath, 0o700);
    const canonicalDirectoryPath = await validateProbeDirectory(directoryPath);
    const capability = crypto.randomUUID();
    const capabilityPath = path.join(canonicalDirectoryPath, CAPABILITY_FILE_NAME);
    await writeFile(capabilityPath, capability, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(capabilityPath, 0o600);
    return await validateOwnedProbeWorkspace(canonicalDirectoryPath, capability, "fresh");
  } catch (error) {
    await removeOwnedPath(directoryPath);
    throw error;
  }
}

export async function createProbeWorkspaceContainer(
  signal?: AbortSignal,
): Promise<ProbeWorkspaceContainer> {
  throwIfProbeAborted(signal);
  const directoryPath = await mkdtemp(path.join(tmpdir(), PROBE_CONTAINER_DIRECTORY_PREFIX));
  try {
    throwIfProbeAborted(signal);
    await chmod(directoryPath, 0o700);
    const capability = crypto.randomUUID();
    const capabilityPath = path.join(directoryPath, CONTAINER_CAPABILITY_FILE_NAME);
    await writeFile(capabilityPath, capability, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(capabilityPath, 0o600);
    const workspaceDirectoryPath = path.join(directoryPath, "workspace");
    await mkdir(workspaceDirectoryPath, { mode: 0o700 });
    await chmod(workspaceDirectoryPath, 0o700);
    throwIfProbeAborted(signal);
    return await validateOwnedProbeWorkspaceContainer(directoryPath, capability);
  } catch (error) {
    await removeOwnedPath(directoryPath);
    throw error;
  }
}

export async function readProbeWorkspaceContainerFromEnv(): Promise<ProbeWorkspaceContainer | null> {
  const directoryPath = process.env[SQLITE_FOUNDATION_PROBE_PARENT_DIRECTORY_ENV];
  const capability = process.env[SQLITE_FOUNDATION_PROBE_PARENT_CAPABILITY_ENV];
  if (directoryPath === undefined && capability === undefined) {
    return null;
  }
  if (directoryPath === undefined || capability === undefined) {
    throw new ProbeOwnershipError();
  }
  return validateOwnedProbeWorkspaceContainer(directoryPath, capability);
}

export async function cleanupOwnedProbeWorkspaceContainer(
  directoryPath: string,
  capability: string,
  signal?: AbortSignal,
): Promise<void> {
  const container = await validateOwnedProbeWorkspaceContainer(directoryPath, capability);
  throwIfProbeAborted(signal);
  await removeOwnedPath(container.directoryPath);
}

function throwIfProbeAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProbeOwnershipError();
}

export function createProbeOuterEnvironment(
  container: ProbeWorkspaceContainer,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of ["LANG", "LC_ALL", "PATH", "TMPDIR", "TZ"]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.NODE_ENV = "test";
  environment[SQLITE_FOUNDATION_PROBE_PARENT_DIRECTORY_ENV] = container.directoryPath;
  environment[SQLITE_FOUNDATION_PROBE_PARENT_CAPABILITY_ENV] = container.capability;
  environment[SQLITE_FOUNDATION_PROBE_SHARED_GROUP_ENV] = "1";
  return environment;
}

export async function validateOwnedProbeWorkspace(
  directoryPath: string,
  capability: string,
  state: ProbeWorkspaceState,
): Promise<ProbeWorkspace> {
  if (!isProbeCapability(capability)) {
    throw new ProbeOwnershipError();
  }

  const canonicalDirectoryPath = await validateProbeDirectory(directoryPath);
  const capabilityPath = path.join(canonicalDirectoryPath, CAPABILITY_FILE_NAME);
  const capabilityStat = await safeLstat(capabilityPath);
  if (capabilityStat === null || !capabilityStat.isFile() || capabilityStat.isSymbolicLink()) {
    throw new ProbeOwnershipError();
  }
  if ((capabilityStat.mode & 0o077) !== 0) {
    throw new ProbeOwnershipError();
  }

  const storedCapability = await readFile(capabilityPath, "utf8").catch(() => null);
  if (storedCapability !== capability) {
    throw new ProbeOwnershipError();
  }

  const databasePath = path.join(canonicalDirectoryPath, DATABASE_FILE_NAME);
  const sidecarPaths = [
    path.join(canonicalDirectoryPath, SQLITE_WAL_FILE_NAME),
    path.join(canonicalDirectoryPath, SQLITE_SHARED_MEMORY_FILE_NAME),
  ];
  const entries = await readdir(canonicalDirectoryPath, { withFileTypes: true }).catch(() => null);
  if (entries === null) {
    throw new ProbeOwnershipError();
  }

  const allowedNames = new Set([
    CAPABILITY_FILE_NAME,
    DATABASE_FILE_NAME,
    SQLITE_WAL_FILE_NAME,
    SQLITE_SHARED_MEMORY_FILE_NAME,
  ]);
  for (const entry of entries) {
    if (!allowedNames.has(entry.name) || entry.isSymbolicLink() || entry.isDirectory()) {
      throw new ProbeOwnershipError();
    }
  }

  const databaseStat = await safeLstat(databasePath);
  const sidecarStats = await Promise.all(sidecarPaths.map((sidecarPath) => safeLstat(sidecarPath)));
  const databaseExists = databaseStat !== null;
  const sidecarExists = sidecarStats.some((stat) => stat !== null);
  if (state === "fresh" && (databaseExists || sidecarExists)) {
    throw new ProbeOwnershipError();
  }
  if (state === "database" && (databaseStat === null || !databaseStat.isFile())) {
    throw new ProbeOwnershipError();
  }
  if (databaseStat !== null && (!databaseStat.isFile() || databaseStat.isSymbolicLink())) {
    throw new ProbeOwnershipError();
  }

  for (const sidecarStat of sidecarStats) {
    if (sidecarStat !== null && (!sidecarStat.isFile() || sidecarStat.isSymbolicLink())) {
      throw new ProbeOwnershipError();
    }
  }

  return { directoryPath: canonicalDirectoryPath, databasePath, capabilityPath, capability };
}

export async function validateOwnedProbeWorkerWorkspace(
  directoryPath: string,
  capability: string,
  state: ProbeWorkspaceState,
  parentContainer?: ProbeWorkspaceContainer,
): Promise<ProbeWorkspace> {
  const container = parentContainer ?? (await readProbeWorkspaceContainerFromEnv());
  if (container === null) {
    throw new ProbeOwnershipError();
  }
  const workspace = await validateOwnedProbeWorkspace(directoryPath, capability, state);
  if (
    path.dirname(workspace.directoryPath) !==
    (container.workspaceDirectoryPath ?? container.directoryPath)
  ) {
    throw new ProbeOwnershipError();
  }
  return workspace;
}

export async function cleanupOwnedProbeWorkspace(
  directoryPath: string,
  capability: string,
): Promise<void> {
  const workspace = await validateOwnedProbeWorkspace(directoryPath, capability, "cleanup");
  await rm(workspace.directoryPath, { recursive: true, force: true });
}

export async function validateOwnedProbeWorkspaceContainer(
  directoryPath: string,
  capability: string,
): Promise<ProbeWorkspaceContainer> {
  if (!isProbeCapability(capability)) {
    throw new ProbeOwnershipError();
  }
  const canonicalDirectoryPath = await validateProbeContainerDirectory(directoryPath);
  const capabilityPath = path.join(canonicalDirectoryPath, CONTAINER_CAPABILITY_FILE_NAME);
  const capabilityStat = await safeLstat(capabilityPath);
  if (capabilityStat === null || !capabilityStat.isFile() || capabilityStat.isSymbolicLink()) {
    throw new ProbeOwnershipError();
  }
  if ((capabilityStat.mode & 0o077) !== 0) {
    throw new ProbeOwnershipError();
  }
  const storedCapability = await readFile(capabilityPath, "utf8").catch(() => null);
  if (storedCapability !== capability) {
    throw new ProbeOwnershipError();
  }
  const workspaceDirectoryPath = path.join(canonicalDirectoryPath, "workspace");
  const workspaceStat = await safeLstat(workspaceDirectoryPath);
  if (
    workspaceStat === null ||
    !workspaceStat.isDirectory() ||
    workspaceStat.isSymbolicLink() ||
    (workspaceStat.mode & 0o077) !== 0
  ) {
    throw new ProbeOwnershipError();
  }
  return {
    directoryPath: canonicalDirectoryPath,
    workspaceDirectoryPath,
    capabilityPath,
    capability,
  };
}

async function validateProbeDirectory(directoryPath: string): Promise<string> {
  const resolvedDirectoryPath = path.resolve(directoryPath);
  const inputDirectoryStat = await safeLstat(resolvedDirectoryPath);
  if (
    inputDirectoryStat === null ||
    !inputDirectoryStat.isDirectory() ||
    inputDirectoryStat.isSymbolicLink()
  ) {
    throw new ProbeOwnershipError();
  }
  const canonicalDirectoryPath = await realpath(resolvedDirectoryPath).catch(() => null);
  if (
    canonicalDirectoryPath === null ||
    path.basename(canonicalDirectoryPath).startsWith(PROBE_DIRECTORY_PREFIX) === false
  ) {
    throw new ProbeOwnershipError();
  }

  const temporaryRoot = await realpath(tmpdir()).catch(() => null);
  const canonicalParentPath = await realpath(path.dirname(canonicalDirectoryPath)).catch(
    () => null,
  );
  if (
    temporaryRoot === null ||
    canonicalParentPath === null ||
    (canonicalParentPath !== temporaryRoot &&
      !(await isOwnedProbeContainerDirectory(canonicalParentPath)) &&
      !(await isOwnedProbeContainerWorkspaceDirectory(canonicalParentPath)))
  ) {
    throw new ProbeOwnershipError();
  }

  const directoryStat = await safeLstat(canonicalDirectoryPath);
  if (directoryStat === null || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new ProbeOwnershipError();
  }
  return canonicalDirectoryPath;
}

async function validateProbeContainerDirectory(directoryPath: string): Promise<string> {
  const resolvedDirectoryPath = path.resolve(directoryPath);
  const inputDirectoryStat = await safeLstat(resolvedDirectoryPath);
  if (
    inputDirectoryStat === null ||
    !inputDirectoryStat.isDirectory() ||
    inputDirectoryStat.isSymbolicLink()
  ) {
    throw new ProbeOwnershipError();
  }
  const canonicalDirectoryPath = await realpath(resolvedDirectoryPath).catch(() => null);
  const temporaryRoot = await realpath(tmpdir()).catch(() => null);
  if (
    canonicalDirectoryPath === null ||
    temporaryRoot === null ||
    path.dirname(canonicalDirectoryPath) !== temporaryRoot ||
    !path.basename(canonicalDirectoryPath).startsWith(PROBE_CONTAINER_DIRECTORY_PREFIX)
  ) {
    throw new ProbeOwnershipError();
  }
  const directoryStat = await safeLstat(canonicalDirectoryPath);
  if (directoryStat === null || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new ProbeOwnershipError();
  }
  return canonicalDirectoryPath;
}

async function isOwnedProbeContainerDirectory(directoryPath: string): Promise<boolean> {
  try {
    const canonicalDirectoryPath = await validateProbeContainerDirectory(directoryPath);
    const capabilityPath = path.join(canonicalDirectoryPath, CONTAINER_CAPABILITY_FILE_NAME);
    const capabilityStat = await safeLstat(capabilityPath);
    if (capabilityStat === null || !capabilityStat.isFile() || capabilityStat.isSymbolicLink()) {
      return false;
    }
    if ((capabilityStat.mode & 0o077) !== 0) {
      return false;
    }
    const capability = await readFile(capabilityPath, "utf8").catch(() => null);
    return capability !== null && isProbeCapability(capability);
  } catch {
    return false;
  }
}

async function isOwnedProbeContainerWorkspaceDirectory(directoryPath: string): Promise<boolean> {
  try {
    const workspacePath = path.resolve(directoryPath);
    if (path.basename(workspacePath) !== "workspace") return false;
    const containerPath = path.dirname(workspacePath);
    const container = await validateOwnedProbeWorkspaceContainerByDirectory(containerPath);
    return container.workspaceDirectoryPath === workspacePath;
  } catch {
    return false;
  }
}

async function validateOwnedProbeWorkspaceContainerByDirectory(
  directoryPath: string,
): Promise<ProbeWorkspaceContainer> {
  const canonicalDirectoryPath = await validateProbeContainerDirectory(directoryPath);
  const capabilityPath = path.join(canonicalDirectoryPath, CONTAINER_CAPABILITY_FILE_NAME);
  const capability = await readFile(capabilityPath, "utf8").catch(() => null);
  if (capability === null) throw new ProbeOwnershipError();
  return validateOwnedProbeWorkspaceContainer(canonicalDirectoryPath, capability);
}

async function safeLstat(filePath: string) {
  return lstat(filePath).catch(() => null);
}

async function removeOwnedPath(directoryPath: string): Promise<void> {
  try {
    await rm(directoryPath, { recursive: true, force: true });
  } catch {
    throw new ProbeOwnershipError();
  }
  try {
    await lstat(directoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new ProbeOwnershipError();
  }
  throw new ProbeOwnershipError();
}

function stripEntrypointArgument(rawArguments: readonly string[]): string[] {
  const first = rawArguments[0];
  if (first !== undefined && isEntrypointArgument(first)) {
    return rawArguments.slice(1);
  }
  return rawArguments.slice();
}

function isEntrypointArgument(argument: string): boolean {
  const extension = path.extname(argument);
  return (
    extension === ".ts" ||
    extension === ".js" ||
    extension === ".mjs" ||
    argument.endsWith("quadball-timer")
  );
}

function isProbeMode(argument: string | undefined): boolean {
  return (
    argument === "--sqlite-foundation-probe" ||
    argument === "--sqlite-foundation-probe-writer" ||
    argument === "--sqlite-foundation-probe-checkpoint"
  );
}

function invalidInvocation(): SqliteProbeInvocation {
  return {
    kind: "invalid",
    error: "SQLite probe arguments are invalid; the public probe accepts no database path.",
  };
}

function isProbeCapability(value: string): boolean {
  return PROBE_CAPABILITY_PATTERN.test(value);
}

export class ProbeOwnershipError extends Error {
  constructor() {
    super("SQLite probe ownership validation failed.");
    this.name = "ProbeOwnershipError";
  }
}
