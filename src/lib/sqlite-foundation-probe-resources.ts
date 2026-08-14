import { readFile, readdir } from "node:fs/promises";
import { readlinkSync } from "node:fs";
import path from "node:path";
import type { ProbeNetworkBoundary } from "@/lib/sqlite-foundation-probe-network";
import {
  createProbeCgroupTree,
  ProbeCgroupCleanupError,
  ProbeCgroupCreationError,
  type ProbeCgroupFileSystem,
  type ProbeRetainedCgroupController,
  type ProbeCgroupTree,
} from "@/lib/sqlite-foundation-probe-cgroup";
import {
  validateOwnedProbeWorkspaceContainer,
  type ProbeWorkspaceContainer,
} from "@/lib/sqlite-foundation-probe-containment";
import {
  SQLITE_FOUNDATION_PROBE_MAX_OUTPUT_BYTES,
  SQLITE_FOUNDATION_PROBE_REAP_TIMEOUT_MS,
  SQLITE_FOUNDATION_PROBE_TERMINATION_GRACE_MS,
} from "@/lib/sqlite-foundation-probe-process";
import {
  isProbeResourceMeasurementWithinLimits,
  SQLITE_FOUNDATION_PROBE_MAX_DISK_BYTES,
  SQLITE_FOUNDATION_PROBE_MAX_MEMORY_BYTES,
  SQLITE_FOUNDATION_PROBE_MAX_PROCESS_COUNT,
  type ProbeResourceMeasurement,
} from "@/lib/sqlite-foundation-probe-result";

export type ProbeResourceController = {
  prepare: (command: readonly string[]) => Promise<ProbePreparedLaunch>;
  attach: (rootPid: number) => Promise<void>;
  kill: () => Promise<void>;
  reap: (signal?: AbortSignal) => Promise<void>;
  isEmpty?: () => Promise<boolean>;
  sample: (
    rootPid: number,
    directoryPath: string,
    outputBytes: number,
    stdout?: string,
    stderr?: string,
  ) => Promise<ProbeResourceMeasurement>;
  close: (signal?: AbortSignal) => Promise<void>;
};

export type ProbePreparedLaunch = {
  command: readonly string[];
  release: (rootPid?: number) => Promise<void>;
};

export type ProbeResourceControllerOptions = {
  platform?: NodeJS.Platform;
  which?: (command: string) => string | undefined;
  sleep?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
  parentMountNamespace?: () => string | null;
  networkBoundary?: ProbeNetworkBoundary;
  container?: ProbeWorkspaceContainer;
  invocationId?: string;
  currentCgroup?: string;
  cgroupFileSystem?: ProbeCgroupFileSystem;
};

const SQLITE_FOUNDATION_PROBE_CGROUP_MAX_PROCESS_COUNT =
  SQLITE_FOUNDATION_PROBE_MAX_PROCESS_COUNT + 1;
const SQLITE_FOUNDATION_PROBE_HELPER_PROCESS_LIMIT = 16;

export type ProbePrivateMountCommandOptions = {
  unshare: string;
  shell: string;
  mount: string;
  stat: string;
  umount: string;
  du: string;
  awk: string;
  findmnt: string;
  parentMountNamespace: string;
  parentNetworkNamespace: string;
  helperCgroupProcessesPath: string;
  workloadCgroupProcessesPath: string;
  workspacePath: string;
  command: readonly string[];
};

export async function createProbeResourceController(
  directoryPath: string,
  options: ProbeResourceControllerOptions = {},
): Promise<ProbeResourceController> {
  throwIfProbeAborted(options.signal);
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") {
    throw new ProbeResourceControlError("OS-enforced Linux resource controls are unavailable.");
  }

  const container = options.container;
  if (container === undefined || options.invocationId === undefined) {
    throw new ProbeResourceControlError("An owned invocation container is required.");
  }
  const ownedContainer = await validateOwnedProbeWorkspaceContainer(
    container.directoryPath,
    container.capability,
  ).catch(() => {
    throw new ProbeResourceControlError("The invocation container capability is invalid.");
  });
  const currentCgroup =
    options.currentCgroup ?? (await readFile("/proc/self/cgroup", "utf8").catch(() => null));
  if (currentCgroup === null) {
    throw new ProbeResourceControlError("The current cgroup delegation could not be identified.");
  }
  const cgroups = await createProbeCgroupTree({
    fileSystem: options.cgroupFileSystem,
    currentCgroup,
    markerPath: path.join(ownedContainer.directoryPath, ".probe-cgroup-capability"),
    capability: ownedContainer.capability,
    invocationId: options.invocationId,
    helperProcessLimit: SQLITE_FOUNDATION_PROBE_HELPER_PROCESS_LIMIT,
    helperMemoryLimit: 128 * 1024 * 1024,
    workloadProcessLimit: SQLITE_FOUNDATION_PROBE_CGROUP_MAX_PROCESS_COUNT,
    workloadMemoryLimit: SQLITE_FOUNDATION_PROBE_MAX_MEMORY_BYTES,
    signal: options.signal,
  }).catch((error) => {
    throw new ProbeResourceControlError(
      "Required owned cgroup controls could not be enabled.",
      readRetainedController(error),
    );
  });
  let diskTools: ProbePrivateMountTools;
  try {
    diskTools = createProbeDiskBoundary(directoryPath, options);
  } catch (error) {
    try {
      await cgroups.remove();
    } catch (cleanupError) {
      throw new ProbeResourceControlError(
        "Resource-controller setup failed and its cgroup cleanup could not be verified.",
        readRetainedController(cleanupError),
      );
    }
    throw error;
  }
  const shell = (options.which ?? ((command) => Bun.which(command) ?? undefined))("sh");
  if (shell === undefined) {
    await removeCgroupsOrThrow(cgroups);
    throw new ProbeResourceControlError("A workload start barrier shell is unavailable.");
  }
  const networkBoundary = options.networkBoundary;
  if (networkBoundary === undefined) {
    await removeCgroupsOrThrow(cgroups);
    throw new ProbeResourceControlError("A verified network boundary is required.");
  }
  throwIfProbeAborted(options.signal);
  const sleep = options.sleep ?? Bun.sleep;
  const parentMountNamespace = (options.parentMountNamespace ?? readParentMountNamespace)();
  if (parentMountNamespace === null) {
    await removeCgroupsOrThrow(cgroups);
    throw new ProbeResourceControlError("The caller mount namespace could not be verified.");
  }
  let lastProcessCount: number | null = null;
  let lastDiskBytes: number | null = null;
  return {
    prepare: async (command) => {
      throwIfProbeAborted(options.signal);
      const barrierCommand = buildProbePrivateMountCommand({
        ...diskTools,
        shell,
        parentNetworkNamespace: networkBoundary.namespace,
        helperCgroupProcessesPath: path.join(cgroups.helperPath, "cgroup.procs"),
        workloadCgroupProcessesPath: path.join(cgroups.workloadPath, "cgroup.procs"),
        workspacePath: directoryPath,
        command,
      });
      return {
        command: barrierCommand,
        release: async (rootPid) => {
          throwIfProbeAborted(options.signal);
          if (rootPid === undefined || process.platform === "win32") {
            throw new ProbeResourceControlError("The workload release signal is unavailable.");
          }
          try {
            process.kill(rootPid, "SIGUSR1");
          } catch {
            throw new ProbeResourceControlError("The workload release signal could not be sent.");
          }
        },
      };
    },
    attach: async (rootPid) => {
      throwIfProbeAborted(options.signal);
      await cgroups.verify();
      const helperMembers = await readFile(path.join(cgroups.helperPath, "cgroup.procs"), "utf8");
      const workloadMembers = await readFile(
        path.join(cgroups.workloadPath, "cgroup.procs"),
        "utf8",
      );
      const processLimit = await cgroups.readNumber("workload", "pids.max");
      const memoryLimit = await cgroups.readNumber("workload", "memory.max");
      if (
        !helperMembers.split(/\s+/).includes(String(rootPid)) ||
        workloadMembers.trim().length === 0 ||
        processLimit !== SQLITE_FOUNDATION_PROBE_CGROUP_MAX_PROCESS_COUNT ||
        memoryLimit !== SQLITE_FOUNDATION_PROBE_MAX_MEMORY_BYTES
      ) {
        throw new ProbeResourceControlError(
          "Workload readiness did not establish the expected cgroup boundaries.",
        );
      }
    },
    kill: async () => {
      await forceKillCgroups(cgroups, sleep);
    },
    reap: async (signal) => {
      throwIfProbeAborted(signal);
      await cgroups.verify();
      const membersPaths = cgroupMemberPaths(cgroups);
      await signalProbeCgroupMembers(membersPaths, "SIGTERM", undefined, undefined, signal);
      const graceDeadline = Date.now() + SQLITE_FOUNDATION_PROBE_TERMINATION_GRACE_MS;
      while (Date.now() < graceDeadline) {
        throwIfProbeAborted(signal);
        if (await cgroupsAreEmpty(membersPaths, signal)) {
          await cgroups.verify();
          return;
        }
        await sleep(10);
      }
      await forceKillCgroups(cgroups, sleep, signal);
    },
    isEmpty: async () => await cgroups.isEmpty(),
    sample: async (_rootPid, _directoryPath, outputBytes, stdout = "", stderr = "") => {
      throwIfProbeAborted(options.signal);
      const currentProcesses = await cgroups.readNumber("workload", "pids.current");
      const peakProcesses = await cgroups.readNumber("workload", "pids.peak");
      lastProcessCount = Math.max(0, peakProcesses - 1);
      const controlOutput = `${stdout}\n${stderr}`;
      const diskMatch = /(?:^|\n)DISK_BYTES=(\d+)(?:\n|$)/.exec(controlOutput);
      if (diskMatch?.[1] !== undefined) lastDiskBytes = Number(diskMatch[1]);
      const measurement = {
        processCount: lastProcessCount,
        peakMemoryBytes: await cgroups.readNumber("workload", "memory.peak"),
        diskBytes: lastDiskBytes,
        outputBytes,
      } satisfies ProbeResourceMeasurement;
      const processMemoryAndOutputWithinLimits =
        measurement.processCount !== null &&
        measurement.peakMemoryBytes !== null &&
        measurement.outputBytes !== null &&
        measurement.processCount <= SQLITE_FOUNDATION_PROBE_MAX_PROCESS_COUNT &&
        measurement.peakMemoryBytes <= SQLITE_FOUNDATION_PROBE_MAX_MEMORY_BYTES &&
        measurement.outputBytes <= SQLITE_FOUNDATION_PROBE_MAX_OUTPUT_BYTES;
      if (currentProcesses > SQLITE_FOUNDATION_PROBE_CGROUP_MAX_PROCESS_COUNT) {
        throw new ProbeResourceLimitError(measurement);
      }
      if (!processMemoryAndOutputWithinLimits) {
        throw new ProbeResourceLimitError(measurement);
      }
      if (lastDiskBytes !== null && !isProbeResourceMeasurementWithinLimits(measurement)) {
        throw new ProbeResourceLimitError(measurement);
      }
      return measurement;
    },
    close: async (signal) => {
      throwIfProbeAborted(signal);
      if (!(await cgroups.isEmpty())) {
        throw new ProbeResourceControlError("Workload cgroup remains populated during cleanup.");
      }
      throwIfProbeAborted(signal);
      try {
        await cgroups.remove();
      } catch (error) {
        throw new ProbeResourceControlError(
          "Workload cgroup removal could not be verified.",
          readRetainedController(error),
        );
      }
    },
  };
}

async function forceKillCgroups(
  cgroups: ProbeCgroupTree,
  sleep: (milliseconds: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  throwIfProbeAborted(signal);
  await cgroups.kill();
  const deadline = Date.now() + SQLITE_FOUNDATION_PROBE_REAP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    throwIfProbeAborted(signal);
    if (await cgroups.isEmpty()) return;
    await sleep(10);
  }
  throw new ProbeResourceControlError("Workload cgroup descendants were not reaped.");
}

function cgroupMemberPaths(cgroups: ProbeCgroupTree): string[] {
  return [
    path.join(cgroups.rootPath, "cgroup.procs"),
    path.join(cgroups.workloadPath, "cgroup.procs"),
    path.join(cgroups.helperPath, "cgroup.procs"),
  ];
}

export async function signalProbeCgroupMembers(
  membersPaths: readonly string[],
  signal: NodeJS.Signals,
  readMembers: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
  signalMember: (pid: number, signal: NodeJS.Signals) => void = (pid, memberSignal) =>
    process.kill(pid, memberSignal),
  abortSignal?: AbortSignal,
): Promise<void> {
  for (const membersPath of membersPaths) {
    throwIfProbeAborted(abortSignal);
    const members = await readMembers(membersPath);
    for (const pid of members
      .split(/\s+/)
      .map(Number)
      .filter((value) => Number.isSafeInteger(value) && value > 0)) {
      throwIfProbeAborted(abortSignal);
      try {
        signalMember(pid, signal);
      } catch {
        // The process may have exited between membership observation and signaling.
      }
    }
  }
}

async function cgroupsAreEmpty(
  membersPaths: readonly string[],
  signal?: AbortSignal,
): Promise<boolean> {
  for (const membersPath of membersPaths) {
    throwIfProbeAborted(signal);
    if ((await readFile(membersPath, "utf8")).trim().length !== 0) return false;
  }
  return true;
}

async function removeCgroupsOrThrow(cgroups: ProbeCgroupTree): Promise<void> {
  try {
    await cgroups.remove();
  } catch (error) {
    const retainedController = readRetainedController(error);
    throw new ProbeResourceControlError(
      "Owned cgroup cleanup could not be verified during admission.",
      retainedController,
    );
  }
}

type ProbePrivateMountTools = Omit<
  ProbePrivateMountCommandOptions,
  | "shell"
  | "command"
  | "parentNetworkNamespace"
  | "helperCgroupProcessesPath"
  | "workloadCgroupProcessesPath"
  | "workspacePath"
>;

export function createProbeDiskBoundary(
  directoryPath: string,
  options: ProbeResourceControllerOptions,
): ProbePrivateMountTools {
  throwIfProbeAborted(options.signal);
  const which = options.which ?? ((command: string) => Bun.which(command) ?? undefined);
  const unshare = which("unshare");
  const mount = which("mount");
  const stat = which("stat");
  const umount = which("umount");
  const du = which("du");
  const awk = which("awk");
  const findmnt = which("findmnt");
  if (
    unshare === undefined ||
    mount === undefined ||
    stat === undefined ||
    umount === undefined ||
    du === undefined ||
    awk === undefined ||
    findmnt === undefined
  ) {
    throw new ProbeResourceControlError("OS-enforced temporary-disk controls are unavailable.");
  }
  const parentMountNamespace = (options.parentMountNamespace ?? readParentMountNamespace)();
  if (parentMountNamespace === null) {
    throw new ProbeResourceControlError("The caller mount namespace could not be verified.");
  }
  throwIfProbeAborted(options.signal);
  void directoryPath;
  return {
    unshare,
    mount,
    stat,
    umount,
    du,
    awk,
    findmnt,
    parentMountNamespace,
  };
}

function readParentMountNamespace(): string | null {
  try {
    return readlinkSync("/proc/self/ns/mnt");
  } catch {
    return null;
  }
}

export function buildProbePrivateMountCommand(options: ProbePrivateMountCommandOptions): string[] {
  const script = [
    "set -eu; umask 077",
    "helper_cgroup_processes=$1; workload_cgroup_processes=$2; parent_mount_namespace=$3; parent_network_namespace=$4; workspace_path=$5; shift 5",
    'printf "%s\\n" "$$" > "$helper_cgroup_processes"',
    `"${options.mount}" --make-rprivate /`,
    `for target in $("${options.findmnt}" -rn -o TARGET); do case "$target" in /sys/fs/cgroup|/sys/fs/cgroup/*) continue;; esac; if "${options.mount}" --bind "$target" "$target" 2>/dev/null; then "${options.mount}" -o remount,bind,ro "$target"; fi; mount_options=$("${options.findmnt}" -rn -o OPTIONS --target "$target" 2>/dev/null || true); test -n "$mount_options"; case ",$mount_options," in *,ro,*) :;; *) exit 125;; esac; case ",$mount_options," in *,rw,*) exit 125;; esac; done`,
    `root_options=$("${options.findmnt}" -rn -o OPTIONS --target / 2>/dev/null || true); test -n "$root_options"; case ",$root_options," in *,ro,*) :;; *) exit 125;; esac; case ",$root_options," in *,rw,*) exit 125;; esac`,
    `"${options.mount}" -t tmpfs -o size=${SQLITE_FOUNDATION_PROBE_MAX_DISK_BYTES},mode=700 tmpfs "$workspace_path"`,
    `capacity=$("${options.stat}" -f -c "%S %b" "$workspace_path" | "${options.awk}" '{print $1 * $2}'); test "$capacity" -le ${SQLITE_FOUNDATION_PROBE_MAX_DISK_BYTES}`,
    'test "$(readlink /proc/self/ns/mnt)" != "$parent_mount_namespace"',
    'test "$(readlink /proc/self/ns/net)" != "$parent_network_namespace"',
    `test -z "$("${options.awk}" 'NR > 2 && $1 !~ /^[[:space:]]*lo[[:space:]]*:/ { print }' /proc/net/dev)"`,
    `test -z "$("${options.awk}" 'NR > 1 && NF > 0 { print }' /proc/net/route)"`,
    `test -z "$("${options.awk}" 'NF > 0 { print }' /proc/net/ipv6_route)"`,
    'mkdir -m 700 "$workspace_path/tmp"; cd "$workspace_path"; export TMPDIR="$workspace_path/tmp"',
    `release=0; attached=0; workload_pid=; trap 'release=1; if [ -n "$workload_pid" ]; then kill -USR1 "$workload_pid" 2>/dev/null || true; fi' USR1; trap 'attached=1' USR2`,
    `"${options.shell}" -eu -c 'workload_cgroup=$1; parent_pid=$2; shift 2; release=0; printf "%s\\n" "$$" > "$workload_cgroup"; trap "release=1" USR1; kill -USR2 "$parent_pid"; while [ "$release" -eq 0 ]; do sleep 0.01; done; exec "$@"' probe-workload "$workload_cgroup_processes" "$$" "$@" & workload_pid=$!`,
    'while [ "$attached" -eq 0 ]; do kill -0 "$workload_pid" 2>/dev/null || exit 125; sleep 0.01; done',
    `"${options.mount}" --bind /sys/fs/cgroup /sys/fs/cgroup; "${options.mount}" -o remount,bind,ro "/sys/fs/cgroup"`,
    `cgroup_options=$("${options.findmnt}" -rn -o OPTIONS --target /sys/fs/cgroup 2>/dev/null || true); test -n "$cgroup_options"; case ",$cgroup_options," in *,ro,*) :;; *) exit 125;; esac; case ",$cgroup_options," in *,rw,*) exit 125;; esac`,
    'printf "READY\\n" >&2',
    'while kill -0 "$workload_pid" 2>/dev/null; do usage_line=$("' +
      options.du +
      '" -sb "$workspace_path" 2>/dev/null || true); set -- $usage_line; if [ -n "${1:-}" ] && [ "$1" -gt ' +
      SQLITE_FOUNDATION_PROBE_MAX_DISK_BYTES +
      ' ]; then kill -TERM "$workload_pid" 2>/dev/null || true; fi; sleep 0.01; done',
    'set +e; wait "$workload_pid"; status=$?; set -e',
    `usage_line=$("${options.du}" -sb "$workspace_path" 2>/dev/null || true); set -- $usage_line; printf "DISK_BYTES=%s\\n" "\${1:-0}" >&2`,
    "cd /; unset TMPDIR",
    'tmpfs_removed=0; if "' +
      options.umount +
      '" "$workspace_path"; then tmpfs_removed=1; else status=125; fi',
    'printf "TMPFS_REMOVED=%s\\n" "$tmpfs_removed" >&2',
    'exit "$status"',
  ].join("; ");
  return [
    options.unshare,
    "--user",
    "--map-root-user",
    "--mount",
    "--net",
    "--propagation",
    "private",
    "--",
    options.shell,
    "-eu",
    "-c",
    script,
    "probe-private-mount",
    options.helperCgroupProcessesPath,
    options.workloadCgroupProcessesPath,
    options.parentMountNamespace,
    options.parentNetworkNamespace,
    options.workspacePath,
    ...options.command,
  ];
}

export function readProbeTmpfsDisposition(output: string): boolean | null {
  if (typeof output !== "string" || new TextEncoder().encode(output).byteLength > 16 * 1024) {
    return null;
  }
  const lines = output.split(/\r?\n/).filter((line) => line.startsWith("TMPFS_REMOVED="));
  if (lines.length !== 1 || !/^TMPFS_REMOVED=[01]$/.test(lines[0] ?? "")) return null;
  return lines[0] === "TMPFS_REMOVED=1";
}

export async function countProbeDescendants(rootPid: number): Promise<number> {
  if (process.platform !== "linux") {
    throw new ProbeResourceControlError("Process-tree measurement requires Linux /proc.");
  }
  const entries = await readdir("/proc");
  const parentByPid = new Map<number, number>();
  await Promise.all(
    entries
      .filter((entry) => /^\d+$/.test(entry))
      .map(async (entry) => {
        const statLine = await readFile(`/proc/${entry}/stat`, "utf8").catch(() => null);
        if (statLine === null) return;
        const closingName = statLine.lastIndexOf(")");
        const fields = statLine.slice(closingName + 2).split(" ");
        const parentPid = Number(fields[1]);
        if (Number.isSafeInteger(parentPid)) parentByPid.set(Number(entry), parentPid);
      }),
  );

  const descendants = new Set<number>();
  let frontier = [rootPid];
  while (frontier.length > 0) {
    const children = [...parentByPid.entries()]
      .filter(([pid, parentPid]) => frontier.includes(parentPid) && !descendants.has(pid))
      .map(([pid]) => pid);
    for (const child of children) descendants.add(child);
    frontier = children;
  }
  return descendants.size;
}

function throwIfProbeAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ProbeResourceControlError("SQLite resource-controller setup was interrupted.");
  }
}

export class ProbeResourceControlError extends Error {
  readonly retainedController: ProbeRetainedCgroupController | null;

  constructor(message: string, retainedController: ProbeRetainedCgroupController | null = null) {
    super(message);
    this.name = "ProbeResourceControlError";
    this.retainedController = retainedController;
  }
}

export class ProbeResourceLimitError extends Error {
  readonly measurement: ProbeResourceMeasurement;

  constructor(measurement: ProbeResourceMeasurement) {
    super("SQLite integrity probe exceeded an enforced process, memory, disk, or output limit.");
    this.name = "ProbeResourceLimitError";
    this.measurement = measurement;
  }
}

function readRetainedController(error: unknown): ProbeRetainedCgroupController | null {
  if (error instanceof ProbeCgroupCreationError || error instanceof ProbeCgroupCleanupError) {
    return error.retainedController;
  }
  if (error instanceof ProbeResourceControlError) return error.retainedController;
  return null;
}
