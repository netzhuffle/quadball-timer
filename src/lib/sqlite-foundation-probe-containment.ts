import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const SQLITE_FOUNDATION_PROBE_WRITER_COUNT = 6;
export const PROBE_DIRECTORY_PREFIX = "quadball-timer-sqlite-probe-";
export const CAPABILITY_FILE_NAME = ".probe-capability";
export const DATABASE_FILE_NAME = "probe.sqlite";
export const SQLITE_WAL_FILE_NAME = `${DATABASE_FILE_NAME}-wal`;
export const SQLITE_SHARED_MEMORY_FILE_NAME = `${DATABASE_FILE_NAME}-shm`;
export const PROBE_CAPABILITY_PATTERN = /^[0-9a-f-]{36}$/;

export type SqliteProbeInvocation =
  | { kind: "none" }
  | { kind: "invalid"; error: string }
  | { kind: "outer" }
  | { kind: "writer"; directoryPath: string; capability: string; writerId: number }
  | { kind: "checkpoint"; directoryPath: string; capability: string };

export type ProbeWorkspace = {
  directoryPath: string;
  databasePath: string;
  capabilityPath: string;
  capability: string;
};

export type ProbeWorkspaceState = "fresh" | "database" | "cleanup";

export function parseSqliteProbeInvocation(rawArguments: readonly string[]): SqliteProbeInvocation {
  const arguments_ = stripEntrypointArgument(rawArguments);
  const mode = arguments_[0];
  if (mode === undefined) return { kind: "none" };
  if (mode === "--sqlite-foundation-probe")
    return arguments_.length === 1 ? { kind: "outer" } : invalidInvocation();
  if (mode === "--sqlite-foundation-probe-writer") {
    const directoryPath = arguments_[1];
    const capability = arguments_[2];
    const writerId = Number(arguments_[3]);
    if (
      arguments_.length !== 4 ||
      directoryPath === undefined ||
      capability === undefined ||
      !isProbeCapability(capability) ||
      !Number.isSafeInteger(writerId) ||
      writerId < 0 ||
      writerId >= SQLITE_FOUNDATION_PROBE_WRITER_COUNT
    )
      return invalidInvocation();
    return { kind: "writer", directoryPath, capability, writerId };
  }
  if (mode === "--sqlite-foundation-probe-checkpoint") {
    const directoryPath = arguments_[1];
    const capability = arguments_[2];
    if (
      arguments_.length !== 3 ||
      directoryPath === undefined ||
      capability === undefined ||
      !isProbeCapability(capability)
    )
      return invalidInvocation();
    return { kind: "checkpoint", directoryPath, capability };
  }
  return isProbeModePresent(arguments_) ? invalidInvocation() : { kind: "none" };
}

export async function createProbeWorkspace(): Promise<ProbeWorkspace> {
  const directoryPath = await mkdtemp(path.join(tmpdir(), PROBE_DIRECTORY_PREFIX));
  try {
    await chmod(directoryPath, 0o700);
    const canonicalDirectoryPath = await validateProbeDirectory(directoryPath);
    const capability = crypto.randomUUID();
    const capabilityPath = path.join(canonicalDirectoryPath, CAPABILITY_FILE_NAME);
    await writeFile(capabilityPath, capability, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(capabilityPath, 0o600);
    return await validateOwnedProbeWorkspace(canonicalDirectoryPath, capability, "fresh");
  } catch (error) {
    await rm(directoryPath, { recursive: true, force: true });
    throw error;
  }
}

export function createProbeOuterEnvironment(): Record<string, string> {
  return { LANG: "C", LC_ALL: "C", NODE_ENV: "test", NO_COLOR: "1", TMPDIR: tmpdir(), TZ: "UTC" };
}

export async function validateOwnedProbeWorkspace(
  directoryPath: string,
  capability: string,
  state: ProbeWorkspaceState,
): Promise<ProbeWorkspace> {
  if (!isProbeCapability(capability)) throw new ProbeOwnershipError();
  const canonicalDirectoryPath = await validateProbeDirectory(directoryPath);
  const capabilityPath = path.join(canonicalDirectoryPath, CAPABILITY_FILE_NAME);
  const capabilityStat = await safeLstat(capabilityPath);
  if (
    capabilityStat === null ||
    !capabilityStat.isFile() ||
    capabilityStat.isSymbolicLink() ||
    (capabilityStat.mode & 0o077) !== 0
  )
    throw new ProbeOwnershipError();
  if ((await readFile(capabilityPath, "utf8").catch(() => null)) !== capability)
    throw new ProbeOwnershipError();
  const databasePath = path.join(canonicalDirectoryPath, DATABASE_FILE_NAME);
  const sidecarPaths = [
    path.join(canonicalDirectoryPath, SQLITE_WAL_FILE_NAME),
    path.join(canonicalDirectoryPath, SQLITE_SHARED_MEMORY_FILE_NAME),
  ];
  const entries = await readdir(canonicalDirectoryPath, { withFileTypes: true }).catch(() => null);
  if (entries === null) throw new ProbeOwnershipError();
  const allowed = new Set([
    CAPABILITY_FILE_NAME,
    DATABASE_FILE_NAME,
    SQLITE_WAL_FILE_NAME,
    SQLITE_SHARED_MEMORY_FILE_NAME,
  ]);
  if (
    entries.some(
      (entry) => !allowed.has(entry.name) || entry.isSymbolicLink() || entry.isDirectory(),
    )
  )
    throw new ProbeOwnershipError();
  const databaseStat = await safeLstat(databasePath);
  const sidecarStats = await Promise.all(sidecarPaths.map((sidecarPath) => safeLstat(sidecarPath)));
  if (state === "fresh" && (databaseStat !== null || sidecarStats.some((stat) => stat !== null)))
    throw new ProbeOwnershipError();
  if (state === "database" && (databaseStat === null || !databaseStat.isFile()))
    throw new ProbeOwnershipError();
  if (databaseStat !== null && (!databaseStat.isFile() || databaseStat.isSymbolicLink()))
    throw new ProbeOwnershipError();
  if (sidecarStats.some((stat) => stat !== null && (!stat.isFile() || stat.isSymbolicLink())))
    throw new ProbeOwnershipError();
  return { directoryPath: canonicalDirectoryPath, databasePath, capabilityPath, capability };
}

export async function validateOwnedProbeWorkerWorkspace(
  directoryPath: string,
  capability: string,
  state: ProbeWorkspaceState,
): Promise<ProbeWorkspace> {
  return validateOwnedProbeWorkspace(directoryPath, capability, state);
}

export async function cleanupOwnedProbeWorkspace(
  directoryPath: string,
  capability: string,
): Promise<void> {
  const workspace = await validateOwnedProbeWorkspace(directoryPath, capability, "cleanup");
  await rm(workspace.directoryPath, { recursive: true, force: true });
  if ((await safeLstat(workspace.directoryPath)) !== null) throw new ProbeOwnershipError();
}

export async function measureOwnedProbeWorkspaceBytes(
  directoryPath: string,
  capability: string,
): Promise<number> {
  const workspace = await validateOwnedProbeWorkspace(directoryPath, capability, "database");
  const entries = await readdir(workspace.directoryPath);
  const sizes = await Promise.all(
    entries.map((entry) =>
      stat(path.join(workspace.directoryPath, entry)).then((value) => value.size),
    ),
  );
  return sizes.reduce((total, size) => total + size, 0);
}

async function validateProbeDirectory(directoryPath: string): Promise<string> {
  const resolved = path.resolve(directoryPath);
  const inputStat = await safeLstat(resolved);
  if (inputStat === null || !inputStat.isDirectory() || inputStat.isSymbolicLink())
    throw new ProbeOwnershipError();
  const canonical = await realpath(resolved).catch(() => null);
  const temporaryRoot = await realpath(tmpdir()).catch(() => null);
  if (
    canonical === null ||
    temporaryRoot === null ||
    path.dirname(canonical) !== temporaryRoot ||
    !path.basename(canonical).startsWith(PROBE_DIRECTORY_PREFIX)
  )
    throw new ProbeOwnershipError();
  return canonical;
}

async function safeLstat(filePath: string) {
  return lstat(filePath).catch(() => null);
}
function stripEntrypointArgument(arguments_: readonly string[]): string[] {
  const first = arguments_[0];
  return first !== undefined && (/\.(?:ts|js|mjs)$/.test(first) || first.endsWith("quadball-timer"))
    ? arguments_.slice(1)
    : arguments_.slice();
}
function isProbeModePresent(arguments_: readonly string[]): boolean {
  return arguments_.some((value) => value.startsWith("--sqlite-foundation-probe"));
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
