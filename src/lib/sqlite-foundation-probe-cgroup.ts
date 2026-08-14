import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const CGROUP_ROOT = "/sys/fs/cgroup";
const CGROUP_NAME_PREFIX = "quadball-timer-sqlite-";
const CAPABILITY_PATTERN = /^[0-9a-f-]{36}$/;

export type ProbeCgroupStat = {
  dev: bigint;
  ino: bigint;
  isDirectory: boolean;
  isSymbolicLink: boolean;
};

export type ProbeCgroupFileSystem = {
  mkdir(target: string): Promise<void>;
  lstat(target: string): Promise<ProbeCgroupStat>;
  readFile(target: string): Promise<string>;
  writeFile(target: string, value: string, options?: { exclusive?: boolean }): Promise<void>;
  remove(target: string): Promise<void>;
};

export type ProbeCgroupTree = {
  rootPath: string;
  helperPath: string;
  workloadPath: string;
  markerPath: string;
  verify(): Promise<void>;
  kill(): Promise<void>;
  isEmpty(): Promise<boolean>;
  remove(): Promise<void>;
  readNumber(group: "helper" | "workload", fileName: string): Promise<number>;
};

export type ProbeRetainedCgroupController = {
  rootPath: string;
  helperPath: string;
  workloadPath: string;
  markerPath: string;
  retainedPaths: string[];
};

export type CreateProbeCgroupTreeOptions = {
  fileSystem?: ProbeCgroupFileSystem;
  cgroupRoot?: string;
  currentCgroup: string;
  markerPath: string;
  capability: string;
  invocationId: string;
  helperProcessLimit?: number;
  helperMemoryLimit?: number;
  workloadProcessLimit?: number;
  workloadMemoryLimit?: number;
  signal?: AbortSignal;
};

type OwnedIdentity = {
  path: string;
  dev: bigint;
  ino: bigint;
};

type MarkerEvidence = {
  schemaVersion: 1;
  capability: string;
  invocationId: string;
  parentPath: string;
  root: SerializedIdentity;
  helper: SerializedIdentity;
  workload: SerializedIdentity;
};

type SerializedIdentity = {
  path: string;
  dev: string;
  ino: string;
};

export async function createProbeCgroupTree(
  options: CreateProbeCgroupTreeOptions,
): Promise<ProbeCgroupTree> {
  const fileSystem = options.fileSystem ?? nodeProbeCgroupFileSystem;
  const cgroupRoot = path.resolve(options.cgroupRoot ?? CGROUP_ROOT);
  validateToken(options.capability, "cgroup capability");
  validateToken(options.invocationId, "cgroup invocation identity");
  throwIfAborted(options.signal);

  const parentPath = resolveDelegatedParent(cgroupRoot, options.currentCgroup);
  await validateDelegatedParent(fileSystem, cgroupRoot, parentPath);
  const rootPath = path.join(parentPath, `${CGROUP_NAME_PREFIX}${options.invocationId}`);
  const helperPath = path.join(rootPath, "helper");
  const workloadPath = path.join(rootPath, "workload");
  validateOwnedLayout(cgroupRoot, parentPath, rootPath, helperPath, workloadPath);

  let rootIdentity: OwnedIdentity | undefined;
  let helperIdentity: OwnedIdentity | undefined;
  let workloadIdentity: OwnedIdentity | undefined;
  let markerIdentity: OwnedIdentity | undefined;
  let markerText: string | undefined;
  try {
    await createNewDirectory(fileSystem, rootPath);
    rootIdentity = await readDirectoryIdentity(fileSystem, rootPath);
    throwIfAborted(options.signal);
    await fileSystem.writeFile(path.join(rootPath, "cgroup.subtree_control"), "+memory +pids\n");
    await requireControllers(fileSystem, rootPath, "cgroup.controllers");
    await requireControllers(fileSystem, rootPath, "cgroup.subtree_control");
    await fileSystem.readFile(path.join(rootPath, "cgroup.kill"));

    await createNewDirectory(fileSystem, helperPath);
    helperIdentity = await readDirectoryIdentity(fileSystem, helperPath);
    await configureLeaf(
      fileSystem,
      helperPath,
      options.helperProcessLimit ?? 16,
      options.helperMemoryLimit ?? 128 * 1024 * 1024,
    );
    throwIfAborted(options.signal);

    await createNewDirectory(fileSystem, workloadPath);
    workloadIdentity = await readDirectoryIdentity(fileSystem, workloadPath);
    await configureLeaf(
      fileSystem,
      workloadPath,
      options.workloadProcessLimit ?? 8,
      options.workloadMemoryLimit ?? 512 * 1024 * 1024,
    );
    throwIfAborted(options.signal);

    const evidence: MarkerEvidence = {
      schemaVersion: 1,
      capability: options.capability,
      invocationId: options.invocationId,
      parentPath,
      root: serializeIdentity(rootIdentity),
      helper: serializeIdentity(helperIdentity),
      workload: serializeIdentity(workloadIdentity),
    };
    markerText = JSON.stringify(evidence);
    await fileSystem.writeFile(options.markerPath, markerText, { exclusive: true });
    markerIdentity = await readFileIdentity(fileSystem, options.markerPath);
    throwIfAborted(options.signal);
  } catch (error) {
    const cleanup = await cleanupCreatedTree(fileSystem, {
      markerPath: options.markerPath,
      markerIdentity,
      markerText,
      workloadIdentity,
      helperIdentity,
      rootIdentity,
      rootPath,
      helperPath,
      workloadPath,
    });
    if (cleanup.retainedController !== null) {
      throw new ProbeCgroupCreationError(
        "Owned cgroup setup failed and retained an owned controller.",
        cleanup.retainedController,
      );
    }
    if (error instanceof ProbeCgroupOwnershipError) throw error;
    throw new ProbeCgroupOwnershipError("Owned cgroup tree could not be created safely.");
  }

  const identities = {
    root: requireIdentity(rootIdentity),
    helper: requireIdentity(helperIdentity),
    workload: requireIdentity(workloadIdentity),
    marker: requireIdentity(markerIdentity),
  };
  const expectedMarker = markerText ?? "";

  const verify = async () => {
    validateOwnedLayout(cgroupRoot, parentPath, rootPath, helperPath, workloadPath);
    await verifyIdentity(fileSystem, identities.root, true);
    await verifyIdentity(fileSystem, identities.helper, true);
    await verifyIdentity(fileSystem, identities.workload, true);
    await verifyIdentity(fileSystem, identities.marker, false);
    const observedMarker = await fileSystem.readFile(options.markerPath).catch(() => null);
    if (observedMarker !== expectedMarker) {
      throw new ProbeCgroupOwnershipError("Owned cgroup capability evidence changed.");
    }
  };

  return {
    rootPath,
    helperPath,
    workloadPath,
    markerPath: options.markerPath,
    verify,
    async kill() {
      await verify();
      await fileSystem.writeFile(path.join(rootPath, "cgroup.kill"), "1\n");
    },
    async isEmpty() {
      await verify();
      return await ownedTreeIsEmpty(fileSystem, rootPath, helperPath, workloadPath);
    },
    async remove() {
      await verify();
      if (!(await ownedTreeIsEmpty(fileSystem, rootPath, helperPath, workloadPath))) {
        throw new ProbeCgroupCleanupError(
          "Owned cgroup tree remains populated.",
          await retainedController(fileSystem, {
            rootPath,
            helperPath,
            workloadPath,
            markerPath: options.markerPath,
            identities,
          }),
        );
      }
      for (const identity of [identities.workload, identities.helper, identities.root]) {
        try {
          await removeVerified(fileSystem, identity, true);
        } catch (error) {
          throw new ProbeCgroupCleanupError(
            "Owned cgroup controller removal could not be verified.",
            await retainedController(fileSystem, {
              rootPath,
              helperPath,
              workloadPath,
              markerPath: options.markerPath,
              identities,
            }),
            error,
          );
        }
      }
      try {
        await removeVerified(fileSystem, identities.marker, false);
      } catch (error) {
        throw new ProbeCgroupCleanupError(
          "Owned cgroup capability evidence removal could not be verified.",
          await retainedController(fileSystem, {
            rootPath,
            helperPath,
            workloadPath,
            markerPath: options.markerPath,
            identities,
          }),
          error,
        );
      }
    },
    async readNumber(group, fileName) {
      await verify();
      return await readSafeNumber(
        fileSystem,
        group === "helper" ? helperPath : workloadPath,
        fileName,
      );
    },
  };
}

export const nodeProbeCgroupFileSystem: ProbeCgroupFileSystem = {
  async mkdir(target) {
    await mkdir(target, { mode: 0o700 });
  },
  async lstat(target) {
    const stat = await lstat(target, { bigint: true });
    return {
      dev: stat.dev,
      ino: stat.ino,
      isDirectory: stat.isDirectory(),
      isSymbolicLink: stat.isSymbolicLink(),
    };
  },
  async readFile(target) {
    return await readFile(target, "utf8");
  },
  async writeFile(target, value, options) {
    await writeFile(target, value, {
      encoding: "utf8",
      ...(options?.exclusive === true ? { flag: "wx", mode: 0o600 } : {}),
    });
  },
  async remove(target) {
    await rm(target, { recursive: false, force: false });
  },
};

function resolveDelegatedParent(cgroupRoot: string, currentCgroup: string): string {
  const matches = [...currentCgroup.matchAll(/^0::([^\r\n]+)$/gm)];
  if (matches.length !== 1) {
    throw new ProbeCgroupOwnershipError("Current cgroup delegation is ambiguous.");
  }
  const relativePath = matches[0]?.[1];
  if (relativePath === undefined || relativePath === "/" || !relativePath.startsWith("/")) {
    throw new ProbeCgroupOwnershipError("Broad cgroup roots are not valid delegated parents.");
  }
  const parentPath = path.resolve(cgroupRoot, `.${relativePath}`);
  if (parentPath === cgroupRoot || !parentPath.startsWith(`${cgroupRoot}${path.sep}`)) {
    throw new ProbeCgroupOwnershipError("Delegated cgroup parent escaped its root.");
  }
  return parentPath;
}

async function validateDelegatedParent(
  fileSystem: ProbeCgroupFileSystem,
  cgroupRoot: string,
  parentPath: string,
): Promise<void> {
  if (parentPath === cgroupRoot) {
    throw new ProbeCgroupOwnershipError("Broad cgroup roots are not valid delegated parents.");
  }
  await readDirectoryIdentity(fileSystem, parentPath);
  await requireControllers(fileSystem, parentPath, "cgroup.controllers");
  await requireControllers(fileSystem, parentPath, "cgroup.subtree_control");
}

function validateOwnedLayout(
  cgroupRoot: string,
  parentPath: string,
  rootPath: string,
  helperPath: string,
  workloadPath: string,
): void {
  if (
    parentPath === cgroupRoot ||
    path.dirname(rootPath) !== parentPath ||
    path.dirname(helperPath) !== rootPath ||
    path.dirname(workloadPath) !== rootPath ||
    rootPath === cgroupRoot ||
    !rootPath.startsWith(`${parentPath}${path.sep}${CGROUP_NAME_PREFIX}`)
  ) {
    throw new ProbeCgroupOwnershipError("Owned cgroup layout is broad or ambiguous.");
  }
}

async function configureLeaf(
  fileSystem: ProbeCgroupFileSystem,
  groupPath: string,
  processLimit: number,
  memoryLimit: number,
): Promise<void> {
  requirePositiveLimit(processLimit);
  requirePositiveLimit(memoryLimit);
  await fileSystem.writeFile(path.join(groupPath, "pids.max"), `${processLimit}\n`);
  await fileSystem.writeFile(path.join(groupPath, "memory.max"), `${memoryLimit}\n`);
  if (
    (await readSafeNumber(fileSystem, groupPath, "pids.max")) !== processLimit ||
    (await readSafeNumber(fileSystem, groupPath, "memory.max")) !== memoryLimit
  ) {
    throw new ProbeCgroupOwnershipError("Owned cgroup limits were not enforced.");
  }
  for (const fileName of ["pids.current", "pids.peak", "memory.peak"]) {
    await readSafeNumber(fileSystem, groupPath, fileName);
  }
  await fileSystem.readFile(path.join(groupPath, "cgroup.kill"));
}

async function requireControllers(
  fileSystem: ProbeCgroupFileSystem,
  groupPath: string,
  fileName: string,
): Promise<void> {
  const value = await fileSystem.readFile(path.join(groupPath, fileName)).catch(() => "");
  const controllers = value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((controller) => controller.replace(/^\+/, ""));
  if (!controllers.includes("memory") || !controllers.includes("pids")) {
    throw new ProbeCgroupOwnershipError("Required delegated cgroup controllers are unavailable.");
  }
}

async function createNewDirectory(
  fileSystem: ProbeCgroupFileSystem,
  target: string,
): Promise<void> {
  try {
    await fileSystem.mkdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ProbeCgroupOwnershipError("Refusing a pre-existing cgroup target.");
    }
    throw error;
  }
}

async function readDirectoryIdentity(
  fileSystem: ProbeCgroupFileSystem,
  target: string,
): Promise<OwnedIdentity> {
  const stat = await fileSystem.lstat(target).catch(() => null);
  if (
    stat === null ||
    !stat.isDirectory ||
    stat.isSymbolicLink ||
    stat.dev <= 0n ||
    stat.ino <= 0n
  ) {
    throw new ProbeCgroupOwnershipError("Cgroup target identity is invalid.");
  }
  return { path: target, dev: stat.dev, ino: stat.ino };
}

async function readFileIdentity(
  fileSystem: ProbeCgroupFileSystem,
  target: string,
): Promise<OwnedIdentity> {
  const stat = await fileSystem.lstat(target).catch(() => null);
  if (
    stat === null ||
    stat.isDirectory ||
    stat.isSymbolicLink ||
    stat.dev <= 0n ||
    stat.ino <= 0n
  ) {
    throw new ProbeCgroupOwnershipError("Cgroup capability marker identity is invalid.");
  }
  return { path: target, dev: stat.dev, ino: stat.ino };
}

async function verifyIdentity(
  fileSystem: ProbeCgroupFileSystem,
  identity: OwnedIdentity,
  directory: boolean,
): Promise<void> {
  const stat = await fileSystem.lstat(identity.path).catch(() => null);
  if (
    stat === null ||
    stat.isDirectory !== directory ||
    stat.isSymbolicLink ||
    stat.dev !== identity.dev ||
    stat.ino !== identity.ino
  ) {
    throw new ProbeCgroupOwnershipError("Owned cgroup identity changed before mutation.");
  }
}

async function removeVerified(
  fileSystem: ProbeCgroupFileSystem,
  identity: OwnedIdentity,
  directory: boolean,
): Promise<void> {
  await verifyIdentity(fileSystem, identity, directory);
  await fileSystem.remove(identity.path);
}

async function ownedTreeIsEmpty(
  fileSystem: ProbeCgroupFileSystem,
  rootPath: string,
  helperPath: string,
  workloadPath: string,
): Promise<boolean> {
  for (const groupPath of [rootPath, helperPath, workloadPath]) {
    if ((await fileSystem.readFile(path.join(groupPath, "cgroup.procs"))).trim().length !== 0) {
      return false;
    }
  }
  return true;
}

async function readSafeNumber(
  fileSystem: ProbeCgroupFileSystem,
  groupPath: string,
  fileName: string,
): Promise<number> {
  const raw = await fileSystem.readFile(path.join(groupPath, fileName)).catch(() => "");
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProbeCgroupOwnershipError(`Unable to measure owned cgroup ${fileName}.`);
  }
  return value;
}

async function cleanupCreatedTree(
  fileSystem: ProbeCgroupFileSystem,
  created: {
    markerPath: string;
    markerIdentity?: OwnedIdentity;
    markerText?: string;
    workloadIdentity?: OwnedIdentity;
    helperIdentity?: OwnedIdentity;
    rootIdentity?: OwnedIdentity;
    rootPath: string;
    helperPath: string;
    workloadPath: string;
  },
): Promise<{ retainedController: ProbeRetainedCgroupController | null }> {
  for (const identity of [created.workloadIdentity, created.helperIdentity, created.rootIdentity]) {
    if (identity === undefined) continue;
    try {
      await verifyIdentity(fileSystem, identity, true);
      if ((await fileSystem.readFile(path.join(identity.path, "cgroup.procs"))).trim() !== "") {
        continue;
      }
      await fileSystem.remove(identity.path);
    } catch {
      // Refuse to remove any target whose exact identity can no longer be established.
    }
  }
  const retainedPaths = await existingPaths(fileSystem, [
    created.rootPath,
    created.helperPath,
    created.workloadPath,
  ]);
  if (
    retainedPaths.length === 0 &&
    created.markerIdentity !== undefined &&
    created.markerText !== undefined
  ) {
    try {
      await verifyIdentity(fileSystem, created.markerIdentity, false);
      if ((await fileSystem.readFile(created.markerPath)) === created.markerText) {
        await fileSystem.remove(created.markerPath);
      }
    } catch {
      // Refuse to remove replaced capability evidence.
    }
  }
  const retainedAfterMarker = await existingPaths(fileSystem, [created.markerPath]);
  if (retainedPaths.length === 0 && retainedAfterMarker.length === 0) {
    return { retainedController: null };
  }
  return {
    retainedController: {
      rootPath: created.rootPath,
      helperPath: created.helperPath,
      workloadPath: created.workloadPath,
      markerPath: created.markerPath,
      retainedPaths: [...retainedPaths, ...retainedAfterMarker],
    },
  };
}

async function existingPaths(
  fileSystem: ProbeCgroupFileSystem,
  paths: string[],
): Promise<string[]> {
  const retained: string[] = [];
  for (const target of paths) {
    if (
      await fileSystem.lstat(target).then(
        () => true,
        () => false,
      )
    )
      retained.push(target);
  }
  return retained;
}

async function retainedController(
  fileSystem: ProbeCgroupFileSystem,
  input: {
    rootPath: string;
    helperPath: string;
    workloadPath: string;
    markerPath: string;
    identities: {
      root: OwnedIdentity;
      helper: OwnedIdentity;
      workload: OwnedIdentity;
      marker: OwnedIdentity;
    };
  },
): Promise<ProbeRetainedCgroupController> {
  const retainedPaths = await existingPaths(fileSystem, [
    input.rootPath,
    input.helperPath,
    input.workloadPath,
    input.markerPath,
  ]);
  return {
    rootPath: input.rootPath,
    helperPath: input.helperPath,
    workloadPath: input.workloadPath,
    markerPath: input.markerPath,
    retainedPaths,
  };
}

function serializeIdentity(identity: OwnedIdentity): SerializedIdentity {
  return { path: identity.path, dev: String(identity.dev), ino: String(identity.ino) };
}

function requireIdentity(identity: OwnedIdentity | undefined): OwnedIdentity {
  if (identity === undefined)
    throw new ProbeCgroupOwnershipError("Owned cgroup identity is missing.");
  return identity;
}

function validateToken(value: string, label: string): void {
  if (!CAPABILITY_PATTERN.test(value)) {
    throw new ProbeCgroupOwnershipError(`Invalid ${label}.`);
  }
}

function requirePositiveLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProbeCgroupOwnershipError("Invalid cgroup resource limit.");
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProbeCgroupOwnershipError("Cgroup setup was interrupted.");
}

export class ProbeCgroupOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeCgroupOwnershipError";
  }
}

export class ProbeCgroupCreationError extends ProbeCgroupOwnershipError {
  readonly retainedController: ProbeRetainedCgroupController;

  constructor(message: string, retainedController: ProbeRetainedCgroupController) {
    super(message);
    this.name = "ProbeCgroupCreationError";
    this.retainedController = retainedController;
  }
}

export class ProbeCgroupCleanupError extends ProbeCgroupOwnershipError {
  readonly retainedController: ProbeRetainedCgroupController;

  constructor(message: string, retainedController: ProbeRetainedCgroupController, cause?: unknown) {
    super(message);
    this.name = "ProbeCgroupCleanupError";
    this.retainedController = retainedController;
    if (cause !== undefined) this.cause = cause;
  }
}
