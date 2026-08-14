import { describe, expect, test } from "bun:test";
import {
  buildNoNetworkProbeCommand,
  createProbeOutputBudget,
  runCompiledSqliteFoundationProbe,
  type ProbeWorkspaceContainer,
  superviseProbeWorkers,
  type ProbeProcess,
  type ProbeWorkerHandle,
  type ProbeWorkerResult,
} from "@/lib/sqlite-foundation-probe";
import { createProbeNetworkBoundary } from "@/lib/sqlite-foundation-probe-network";
import { readSingleValueFromWorker } from "@/lib/sqlite-foundation-probe-process";
import {
  buildProbePrivateMountCommand,
  createProbeDiskBoundary,
  readProbeTmpfsDisposition,
  ProbeResourceControlError,
  ProbeResourceLimitError,
  signalProbeCgroupMembers,
} from "@/lib/sqlite-foundation-probe-resources";

const CAPABILITY = "00000000-0000-0000-0000-000000000000";

describe("sqlite-foundation-probe safety", () => {
  test("builds the workload launch inside a private mount namespace before mounting tmpfs", () => {
    const command = buildProbePrivateMountCommand({
      unshare: "/usr/bin/unshare",
      shell: "/bin/sh",
      mount: "/bin/mount",
      stat: "/usr/bin/stat",
      umount: "/bin/umount",
      du: "/usr/bin/du",
      awk: "/usr/bin/awk",
      findmnt: "/usr/bin/findmnt",
      parentMountNamespace: "mnt:[parent]",
      parentNetworkNamespace: "net:[parent]",
      helperCgroupProcessesPath: "/owned/helper-cgroup.procs",
      workloadCgroupProcessesPath: "/owned/workload-cgroup.procs",
      workspacePath: "/owned/workspace",
      command: ["/owned/probe", "--sqlite-foundation-probe"],
    });

    expect(command.slice(0, 11)).toEqual([
      "/usr/bin/unshare",
      "--user",
      "--map-root-user",
      "--mount",
      "--net",
      "--propagation",
      "private",
      "--",
      "/bin/sh",
      "-eu",
      "-c",
    ]);
    expect(command.join(" ")).toContain(
      'test "$(readlink /proc/self/ns/mnt)" != "$parent_mount_namespace"',
    );
    expect(command.join(" ")).toContain(
      'test "$(readlink /proc/self/ns/net)" != "$parent_network_namespace"',
    );
    expect(command.join(" ")).toContain('export TMPDIR="$workspace_path/tmp"');
    expect(command.join(" ")).toContain("--bind");
    expect(command.join(" ")).toContain("-t tmpfs");
    expect(command.join(" ")).toContain("umount");

    const script = command[11] ?? "";
    const selfAttach = script.indexOf('printf "%s\\n" "$$" > "$workload_cgroup"');
    const sealCgroup = script.indexOf('remount,bind,ro "/sys/fs/cgroup"');
    const ready = script.indexOf('printf "READY\\n"');
    const leaveWorkspace = script.indexOf("cd /; unset TMPDIR");
    const unmount = script.indexOf('"/bin/umount" "$workspace_path"');
    const tmpfsMarker = script.indexOf('printf "TMPFS_REMOVED=%s\\n" "$tmpfs_removed" >&2');
    expect(selfAttach).toBeGreaterThan(-1);
    expect(sealCgroup).toBeGreaterThan(selfAttach);
    expect(ready).toBeGreaterThan(sealCgroup);
    expect(leaveWorkspace).toBeGreaterThan(ready);
    expect(unmount).toBeGreaterThan(leaveWorkspace);
    expect(tmpfsMarker).toBeGreaterThan(unmount);
    expect(script).toContain('printf "READY\\n" >&2');
    expect(script).toContain('printf "DISK_BYTES=%s\\n" "${1:-0}" >&2');
    expect(script).toContain('test -n "$mount_options"');
    expect(script).toContain('test -n "$cgroup_options"');
    expect(script).toContain('case ",$cgroup_options," in *,ro,*)');
    expect(script).toContain('case ",$cgroup_options," in *,rw,*) exit 125');
    expect(script).toContain("*,ro,*");
    expect(script).toContain("*,rw,*) exit 125");
    expect(script).toContain('printf "TMPFS_REMOVED=%s\\n" "$tmpfs_removed"');
  });

  test("reports tmpfs removal independently from workload correctness", () => {
    expect(readProbeTmpfsDisposition("workload failed\nTMPFS_REMOVED=1\n")).toBe(true);
    expect(readProbeTmpfsDisposition("TMPFS_REMOVED=0\n")).toBe(false);
    expect(readProbeTmpfsDisposition("workload failed\n")).toBeNull();
    expect(readProbeTmpfsDisposition("TMPFS_REMOVED=1\nTMPFS_REMOVED=0\n")).toBeNull();
  });

  test("keeps artifact JSON parseable while control frames stay separate", () => {
    expect(readSingleValueFromWorker('{"sqliteVersion":"3.53.0"}', "sqliteVersion")).toBe("3.53.0");
    expect(
      readSingleValueFromWorker('READY\n{"sqliteVersion":"3.53.0"}\nDISK_BYTES=1', "sqliteVersion"),
    ).toBeNull();
    expect(readProbeTmpfsDisposition("READY\nDISK_BYTES=1\nTMPFS_REMOVED=1\n")).toBe(true);
  });

  test("requires and verifies an OS network namespace before building the workload command", async () => {
    const boundary = await createProbeNetworkBoundary({
      platform: "linux",
      which: (command) => `/usr/bin/${command}`,
      parentNamespace: () => "net:[parent]",
    });
    const command = buildNoNetworkProbeCommand(boundary, "/owned/quadball-timer", [
      "--sqlite-foundation-probe",
    ]);

    expect(command).toEqual(["/owned/quadball-timer", "--sqlite-foundation-probe"]);
    expect(boundary.namespace).toBe("net:[parent]");
  });

  test("counts captured output as raw bytes and stops at the shared cap", () => {
    const budget = createProbeOutputBudget(4);
    expect(budget.consume(new TextEncoder().encode("😀").byteLength)).toBe(4);
    expect(budget.consumedBytes).toBe(4);
    expect(budget.observedBytes).toBe(4);
    expect(budget.exceeded).toBe(false);
    expect(budget.consume(1)).toBe(0);
    expect(budget.observedBytes).toBe(5);
    expect(budget.exceeded).toBe(true);
  });

  test("requires an OS-enforced temporary-disk boundary before admission", async () => {
    const tools = createProbeDiskBoundary("/owned/workspace", {
      platform: "linux",
      which: (command) => `/usr/bin/${command}`,
      parentMountNamespace: () => "mnt:[parent]",
    });

    expect(tools).toEqual({
      unshare: "/usr/bin/unshare",
      mount: "/usr/bin/mount",
      stat: "/usr/bin/stat",
      umount: "/usr/bin/umount",
      du: "/usr/bin/du",
      awk: "/usr/bin/awk",
      findmnt: "/usr/bin/findmnt",
      parentMountNamespace: "mnt:[parent]",
    });

    const diskError = await captureRejection(async () => {
      createProbeDiskBoundary("/owned/workspace", {
        platform: "linux",
        which: (command) => (command === "mount" ? undefined : `/usr/bin/${command}`),
        parentMountNamespace: () => "mnt:[parent]",
      });
    });
    expect(diskError).toBeInstanceOf(ProbeResourceControlError);
  });

  test("fails closed on boundary verification and does not launch the workload", async () => {
    let launches = 0;
    const container: ProbeWorkspaceContainer = {
      directoryPath: "/tmp/fake-probe-container",
      capabilityPath: "/tmp/fake-probe-container/.capability",
      capability: CAPABILITY,
    };
    const operation = () =>
      runCompiledSqliteFoundationProbe("compiled-probe", {
        createWorkspaceContainer: async () => container,
        createNetworkBoundary: () =>
          createProbeNetworkBoundary({
            platform: "linux",
            which: (command) => `/usr/bin/${command}`,
            parentNamespace: () => null,
          }),
        cleanupWorkspaceContainer: async () => {},
        spawnOuter: () => {
          launches += 1;
          throw new Error("must not launch");
        },
        emitResult: () => {},
      });

    await captureRejection(operation);
    expect(launches).toBe(0);
  });

  test.each(["process count", "peak memory", "temporary disk", "captured output"])(
    "stops the full process tree when the observed %s bound overruns",
    async (resource) => {
      const first = createFakeWorker(601, false);
      const second = createFakeWorker(602, false);
      const signals: string[] = [];
      let timerCalls = 0;
      const measurement = {
        processCount: 7,
        peakMemoryBytes: 512 * 1024 * 1024,
        diskBytes: 16 * 1024 * 1024,
        outputBytes: 4 * 1024,
      };

      expect(
        await captureRejection(() =>
          superviseProbeWorkers([first.worker, second.worker], {
            scheduleTimeout: (callback) => {
              timerCalls += 1;
              if (timerCalls === 1) callback();
              return 0;
            },
            clearTimeout: () => {},
            sleep: async () => {},
            resourceCheck: async () => {
              throw new ProbeResourceLimitError(measurement);
            },
            signalProcessGroup: (pid, signal) => {
              signals.push(`${pid}:${signal}`);
              (pid === first.worker.process.pid ? first : second).terminate(signal);
              return true;
            },
          }),
        ),
      ).toHaveProperty(
        "message",
        expect.stringContaining("enforced process, memory, disk, or output"),
      );
      expect(signals).toEqual(["601:SIGTERM", "602:SIGTERM"]);
      expect(resource).toBeString();
    },
  );

  test("uses cgroup-wide termination to reap descendants that escaped a process group", async () => {
    const first = createFakeWorker(701, true);
    const second = createFakeWorker(702, true);
    const signals: string[] = [];
    const terminationOrder: string[] = [];
    let cgroupKills = 0;

    const killError = await captureRejection(() =>
      superviseProbeWorkers([first.worker, second.worker], {
        scheduleTimeout: (callback) => {
          callback();
          return 0;
        },
        clearTimeout: () => {},
        sleep: async () => {},
        resourceCheck: async () => {
          throw new ProbeResourceLimitError({
            processCount: 8,
            peakMemoryBytes: 0,
            diskBytes: 0,
            outputBytes: 0,
          });
        },
        signalProcessGroup: (pid, signal) => {
          signals.push(`${pid}:${signal}`);
          terminationOrder.push(`group:${signal}`);
          return true;
        },
        killWorkloadTree: async () => {
          cgroupKills += 1;
          terminationOrder.push("cgroup:kill");
          first.terminate("SIGKILL");
          second.terminate("SIGKILL");
        },
      }),
    );
    expect(killError).toBeInstanceOf(Error);

    expect(signals).toEqual(["701:SIGTERM", "702:SIGTERM"]);
    expect(terminationOrder).toEqual(["group:SIGTERM", "group:SIGTERM", "cgroup:kill"]);
    expect(cgroupKills).toBe(1);
    expect(first.worker.process.exitCode).toBe(137);
    expect(second.worker.process.exitCode).toBe(137);
  });

  test("signals invocation-root members during cgroup reap", async () => {
    const signals: Array<[number, NodeJS.Signals]> = [];
    await signalProbeCgroupMembers(
      ["/owned/invocation-root/cgroup.procs"],
      "SIGTERM",
      async () => "9001\n",
      (pid, signal) => {
        signals.push([pid, signal]);
      },
    );
    expect(signals).toEqual([[9001, "SIGTERM"]]);
  });
});

function createFakeWorker(
  pid: number,
  ignoreTerminationSignal: boolean,
  processGroupId?: number,
): {
  worker: ProbeWorkerHandle;
  terminate: (signal: NodeJS.Signals) => void;
} {
  let exitCode: number | null = null;
  let resolveExited: (code: number) => void = () => {};
  let resolveResult: (result: ProbeWorkerResult) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });
  const result = new Promise<ProbeWorkerResult>((resolve) => {
    resolveResult = resolve;
  });
  const process: ProbeProcess = {
    pid,
    processGroupId,
    get exitCode() {
      return exitCode;
    },
    get killed() {
      return exitCode !== null;
    },
    exited,
    kill(signal) {
      if (signal !== undefined) terminate(signal);
    },
  };

  function terminate(signal: NodeJS.Signals) {
    if (signal === "SIGTERM" && ignoreTerminationSignal) return;
    exitCode = signal === "SIGKILL" ? 137 : 143;
    resolveExited(exitCode);
    resolveResult({
      exitCode,
      stdout: "",
      stderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      outputExceeded: false,
    });
  }

  return { worker: { process, result }, terminate };
}

async function captureRejection(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("Expected an Error rejection.");
  }
  throw new Error("Expected the operation to reject.");
}
