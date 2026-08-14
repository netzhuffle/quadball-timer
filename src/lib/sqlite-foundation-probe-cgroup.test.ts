import { describe, expect, test } from "bun:test";
import {
  createProbeCgroupTree,
  ProbeCgroupCleanupError,
  ProbeCgroupCreationError,
  ProbeCgroupOwnershipError,
  type ProbeCgroupFileSystem,
  type ProbeCgroupStat,
} from "@/lib/sqlite-foundation-probe-cgroup";

const PARENT = "/sys/fs/cgroup/delegated";
const MARKER = "/tmp/owned/.probe-cgroup-capability";

describe("sqlite-foundation-probe cgroup ownership", () => {
  test("rejects a broad cgroup root before creating a target", async () => {
    const fileSystem = createFakeCgroupFileSystem();
    expect(
      await captureRejection(() =>
        createProbeCgroupTree({
          fileSystem,
          currentCgroup: "0::/\n",
          markerPath: MARKER,
          capability: "00000000-0000-0000-0000-000000000000",
          invocationId: "11111111-1111-1111-1111-111111111111",
        }),
      ),
    ).toBeInstanceOf(ProbeCgroupOwnershipError);
    expect(fileSystem.createdPaths).toEqual([]);
    expect(fileSystem.removedPaths).toEqual([]);
  });

  test("does not remove a colliding pre-existing target", async () => {
    const fileSystem = createFakeCgroupFileSystem({ collideInvocationRoot: true });
    expect(
      await captureRejection(() =>
        createProbeCgroupTree({
          fileSystem,
          currentCgroup: "0::/delegated\n",
          markerPath: MARKER,
          capability: "00000000-0000-0000-0000-000000000000",
          invocationId: "11111111-1111-1111-1111-111111111111",
        }),
      ),
    ).toBeInstanceOf(ProbeCgroupOwnershipError);
    expect(fileSystem.removedPaths).toEqual([]);
  });

  test("revalidates inode and capability evidence before kill or removal", async () => {
    const fileSystem = createFakeCgroupFileSystem();
    const tree = await createProbeCgroupTree({
      fileSystem,
      currentCgroup: "0::/delegated\n",
      markerPath: MARKER,
      capability: "00000000-0000-0000-0000-000000000000",
      invocationId: "11111111-1111-1111-1111-111111111111",
    });
    fileSystem.swapPath(tree.workloadPath);

    expect(await captureRejection(() => tree.kill())).toBeInstanceOf(ProbeCgroupOwnershipError);
    expect(await captureRejection(() => tree.remove())).toBeInstanceOf(ProbeCgroupOwnershipError);
    expect(fileSystem.writes.some(([target]) => target.endsWith("cgroup.kill"))).toBe(false);
    expect(fileSystem.removedPaths).toEqual([]);
  });

  test("rejects marker replacement before cleanup", async () => {
    const fileSystem = createFakeCgroupFileSystem();
    const tree = await createProbeCgroupTree({
      fileSystem,
      currentCgroup: "0::/delegated\n",
      markerPath: MARKER,
      capability: "00000000-0000-0000-0000-000000000000",
      invocationId: "11111111-1111-1111-1111-111111111111",
    });
    fileSystem.replaceFile(MARKER, "not-owned");

    expect(await captureRejection(() => tree.remove())).toBeInstanceOf(ProbeCgroupOwnershipError);
    expect(fileSystem.removedPaths).toEqual([]);
  });

  test("kills through the owned invocation root instead of independent leaf targets", async () => {
    const fileSystem = createFakeCgroupFileSystem();
    const tree = await createProbeCgroupTree({
      fileSystem,
      currentCgroup: "0::/delegated\n",
      markerPath: MARKER,
      capability: "00000000-0000-0000-0000-000000000000",
      invocationId: "11111111-1111-1111-1111-111111111111",
    });

    await tree.kill();

    expect(fileSystem.writes.filter(([target]) => target.endsWith("cgroup.kill"))).toEqual([
      [`${tree.rootPath}/cgroup.kill`, "1\n"],
    ]);
  });

  test("treats invocation-root members as populated and cleanup-owned", async () => {
    const fileSystem = createFakeCgroupFileSystem();
    const tree = await createProbeCgroupTree({
      fileSystem,
      currentCgroup: "0::/delegated\n",
      markerPath: MARKER,
      capability: "00000000-0000-0000-0000-000000000000",
      invocationId: "11111111-1111-1111-1111-111111111111",
    });
    fileSystem.setMembers(tree.rootPath, "9001\n");

    expect(await tree.isEmpty()).toBe(false);
    const error = await captureRejection(() => tree.remove());
    expect(error).toBeInstanceOf(ProbeCgroupCleanupError);
    expect((error as ProbeCgroupCleanupError).retainedController.retainedPaths).toContain(
      tree.rootPath,
    );
    expect(fileSystem.removedPaths).toEqual([]);
  });

  test.each(["workload", "root"] as const)(
    "retains ownership evidence when %s removal fails",
    async (failureTarget) => {
      const fileSystem = createFakeCgroupFileSystem();
      const tree = await createProbeCgroupTree({
        fileSystem,
        currentCgroup: "0::/delegated\n",
        markerPath: MARKER,
        capability: "00000000-0000-0000-0000-000000000000",
        invocationId: "11111111-1111-1111-1111-111111111111",
      });
      fileSystem.failRemovalPath(failureTarget === "root" ? tree.rootPath : tree.workloadPath);

      const error = await captureRejection(() => tree.remove());
      expect(error).toBeInstanceOf(ProbeCgroupCleanupError);
      const retained = (error as ProbeCgroupCleanupError).retainedController;
      expect(retained.retainedPaths).toContain(
        failureTarget === "root" ? tree.rootPath : tree.workloadPath,
      );
      expect(fileSystem.readFile(MARKER)).resolves.toBeTruthy();
    },
  );

  test("surfaces retained ownership when partial creation cleanup fails", async () => {
    const fileSystem = createFakeCgroupFileSystem();
    const rootPath = `${PARENT}/quadball-timer-sqlite-11111111-1111-1111-1111-111111111111`;
    fileSystem.failWritePath(`${rootPath}/workload/pids.max`);
    fileSystem.failRemovalPath(rootPath);

    const error = await captureRejection(() =>
      createProbeCgroupTree({
        fileSystem,
        currentCgroup: "0::/delegated\n",
        markerPath: MARKER,
        capability: "00000000-0000-0000-0000-000000000000",
        invocationId: "11111111-1111-1111-1111-111111111111",
      }),
    );

    expect(error).toBeInstanceOf(ProbeCgroupCreationError);
    expect((error as ProbeCgroupCreationError).retainedController.retainedPaths).toEqual([
      rootPath,
    ]);
  });
});

type FakeCgroupFileSystem = ProbeCgroupFileSystem & {
  createdPaths: string[];
  removedPaths: string[];
  writes: Array<[string, string]>;
  swapPath(path: string): void;
  replaceFile(path: string, value: string): void;
  setMembers(path: string, value: string): void;
  failRemovalPath(path: string): void;
  failWritePath(path: string): void;
};

function createFakeCgroupFileSystem(
  options: { collideInvocationRoot?: boolean } = {},
): FakeCgroupFileSystem {
  let nextInode = 10n;
  const stats = new Map<string, ProbeCgroupStat>([[PARENT, directoryStat(1n)]]);
  const files = new Map<string, string>([
    [`${PARENT}/cgroup.controllers`, "memory pids\n"],
    [`${PARENT}/cgroup.subtree_control`, "memory pids\n"],
  ]);
  const createdPaths: string[] = [];
  const removedPaths: string[] = [];
  const writes: Array<[string, string]> = [];
  let collisionPending = options.collideInvocationRoot === true;
  let failedRemovalPath: string | undefined;
  let failedWritePath: string | undefined;

  return {
    createdPaths,
    removedPaths,
    writes,
    async mkdir(target) {
      if (collisionPending) {
        collisionPending = false;
        const error = new Error("exists") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      }
      if (stats.has(target)) throw new Error("unexpected collision");
      stats.set(target, directoryStat(nextInode++));
      createdPaths.push(target);
      files.set(`${target}/cgroup.controllers`, "memory pids\n");
      files.set(`${target}/cgroup.subtree_control`, "memory pids\n");
      files.set(`${target}/cgroup.procs`, "\n");
      files.set(`${target}/pids.current`, "0\n");
      files.set(`${target}/pids.peak`, "0\n");
      files.set(`${target}/memory.peak`, "0\n");
      files.set(`${target}/cgroup.kill`, "\n");
    },
    async lstat(target) {
      const stat = stats.get(target);
      if (stat === undefined) throw missing(target);
      return stat;
    },
    async readFile(target) {
      const value = files.get(target);
      if (value === undefined) throw missing(target);
      return value;
    },
    async writeFile(target, value, writeOptions) {
      if (target === failedWritePath) throw new Error(`write failed for ${target}`);
      if (writeOptions?.exclusive === true && files.has(target)) {
        const error = new Error("exists") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      }
      files.set(target, value);
      if (target === MARKER && !stats.has(target)) stats.set(target, fileStat(nextInode++));
      writes.push([target, value]);
    },
    async remove(target) {
      if (target === failedRemovalPath) {
        throw new Error(`remove failed for ${target}`);
      }
      stats.delete(target);
      for (const key of files.keys()) {
        if (key === target || key.startsWith(`${target}/`)) files.delete(key);
      }
      removedPaths.push(target);
    },
    swapPath(target) {
      stats.set(target, directoryStat(nextInode++));
    },
    replaceFile(target, value) {
      files.set(target, value);
    },
    setMembers(target, value) {
      files.set(`${target}/cgroup.procs`, value);
    },
    failRemovalPath(target) {
      failedRemovalPath = target;
    },
    failWritePath(target) {
      failedWritePath = target;
    },
  };
}

function directoryStat(ino: bigint): ProbeCgroupStat {
  return { dev: 1n, ino, isDirectory: true, isSymbolicLink: false };
}

function fileStat(ino: bigint): ProbeCgroupStat {
  return { dev: 1n, ino, isDirectory: false, isSymbolicLink: false };
}

function missing(target: string): NodeJS.ErrnoException {
  const error = new Error(`missing ${target}`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

async function captureRejection(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to reject.");
}
