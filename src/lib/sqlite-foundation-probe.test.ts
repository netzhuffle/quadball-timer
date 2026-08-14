import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildProbeWorkerCommand,
  capDiagnosticOutput,
  cleanupOwnedProbeWorkspace,
  cleanupOwnedProbeWorkspaceContainer,
  createProbeWorkspace,
  createProbeWorkspaceContainer,
  isSupportedSqliteVersion,
  parseSqliteProbeInvocation,
  SQLITE_FOUNDATION_PROBE_MAX_OUTPUT_BYTES,
  SQLITE_FOUNDATION_PROBE_WORKLOAD,
  superviseProbeWorkers,
  type ProbeProcess,
  type ProbeWorkerHandle,
  type ProbeWorkerResult,
  SqliteFoundationGateError,
  validateOwnedProbeWorkspace,
  validateOwnedProbeWorkerWorkspace,
} from "@/lib/sqlite-foundation-probe";

const CAPABILITY = "00000000-0000-0000-0000-000000000000";

describe("sqlite-foundation-probe", () => {
  test("accepts the fixed SQLite boundary and newer versions", () => {
    const cases = [
      { version: "3.51.2", supported: false },
      { version: "3.51.3", supported: true },
      { version: "3.51.4", supported: true },
      { version: "3.53.0", supported: true },
      { version: "not-a-version", supported: false },
    ];

    for (const testCase of cases) {
      expect(isSupportedSqliteVersion(testCase.version), testCase.version).toBe(testCase.supported);
    }
  });

  test("marks an affected runtime as a human database-choice decision", () => {
    const error = new SqliteFoundationGateError(
      "SQLite delivery stopped: embedded SQLite 3.51.0 is earlier than the supported minimum 3.51.3.",
    );

    expect(error.name).toBe("SqliteFoundationGateError");
    expect(error.decisionRequired).toBe(true);
  });

  test("keeps the expensive workload fixed and diagnostics bounded", () => {
    expect(SQLITE_FOUNDATION_PROBE_WORKLOAD).toEqual({
      writerCount: 6,
      rowsPerWriter: 1_000,
      passiveCheckpointAttempts: 5_000,
    });

    const capped = capDiagnosticOutput("😀".repeat(SQLITE_FOUNDATION_PROBE_MAX_OUTPUT_BYTES));
    expect(capped.truncated).toBe(true);
    expect(new TextEncoder().encode(capped.text).byteLength).toBeLessThanOrEqual(
      SQLITE_FOUNDATION_PROBE_MAX_OUTPUT_BYTES,
    );
  });

  test("accepts only the private outer mode without a database argument", () => {
    expect(parseSqliteProbeInvocation(["src/index.ts", "--sqlite-foundation-probe"])).toEqual({
      kind: "outer",
    });
    expect(
      parseSqliteProbeInvocation(["--sqlite-foundation-probe", "/operator/database.sqlite"]),
    ).toEqual({
      kind: "invalid",
      error: "SQLite probe arguments are invalid; the public probe accepts no database path.",
    });
    expect(parseSqliteProbeInvocation(["--unexpected", "--sqlite-foundation-probe"])).toEqual({
      kind: "invalid",
      error: "SQLite probe arguments are invalid; the public probe accepts no database path.",
    });
  });

  test("does not forward a compiled virtual entrypoint when self-spawning workers", () => {
    const writerArguments = ["/owned/probe", CAPABILITY, "0"] as const;
    const virtualEntrypoints = [
      "/$bunfs/root/src/index.ts",
      "/$bunfs/root/quadball-timer",
      "B:\\~BUN\\root\\src\\index.js",
    ];

    for (const virtualEntrypoint of virtualEntrypoints) {
      const command = buildProbeWorkerCommand(
        "/opt/quadball-timer",
        "--sqlite-foundation-probe-writer",
        writerArguments,
        [virtualEntrypoint, "--sqlite-foundation-probe"],
      );
      expect(command, virtualEntrypoint).toEqual([
        "/opt/quadball-timer",
        "--sqlite-foundation-probe-writer",
        ...writerArguments,
      ]);
      expect(
        parseSqliteProbeInvocation([virtualEntrypoint, ...command.slice(1)]),
        `${virtualEntrypoint} child argv`,
      ).toEqual({
        kind: "writer",
        directoryPath: writerArguments[0],
        capability: writerArguments[1],
        writerId: 0,
      });
    }
  });

  test("forwards a real source entrypoint when Bun runs the uncompiled server", () => {
    expect(
      buildProbeWorkerCommand(
        "/opt/bun",
        "--sqlite-foundation-probe-checkpoint",
        ["/owned/probe", CAPABILITY],
        ["/repo/src/index.ts", "--sqlite-foundation-probe"],
      ),
    ).toEqual([
      "/opt/bun",
      "/repo/src/index.ts",
      "--sqlite-foundation-probe-checkpoint",
      "/owned/probe",
      CAPABILITY,
    ]);
  });

  test("requires capability evidence and rejects pre-existing or arbitrary targets", async () => {
    const workspace = await createProbeWorkspace();
    try {
      const validated = await validateOwnedProbeWorkspace(
        workspace.directoryPath,
        workspace.capability,
        "fresh",
      );
      expect(validated.databasePath).toBe(workspace.databasePath);

      await writeFile(workspace.databasePath, "not-a-parent-created-database");
      expect(
        await captureRejection(() =>
          validateOwnedProbeWorkspace(workspace.directoryPath, workspace.capability, "fresh"),
        ),
      ).toHaveProperty("message", "SQLite probe ownership validation failed.");
      expect(
        await captureRejection(() =>
          validateOwnedProbeWorkspace(
            workspace.directoryPath,
            "11111111-1111-1111-1111-111111111111",
            "cleanup",
          ),
        ),
      ).toHaveProperty("message", "SQLite probe ownership validation failed.");
    } finally {
      await cleanupOwnedProbeWorkspace(workspace.directoryPath, workspace.capability);
    }

    const arbitraryDirectory = await mkdtemp(path.join(tmpdir(), "quadball-timer-arbitrary-"));
    try {
      await writeFile(path.join(arbitraryDirectory, ".probe-capability"), CAPABILITY);
      expect(
        await captureRejection(() =>
          validateOwnedProbeWorkspace(arbitraryDirectory, CAPABILITY, "fresh"),
        ),
      ).toHaveProperty("message", "SQLite probe ownership validation failed.");
    } finally {
      await rm(arbitraryDirectory, { recursive: true, force: true });
    }
  });

  test("rejects symlinked probe directories and cleans only the owned directory", async () => {
    const workspace = await createProbeWorkspace();
    const symlinkPath = path.join(
      tmpdir(),
      `quadball-timer-sqlite-probe-link-${crypto.randomUUID()}`,
    );
    const siblingPath = path.join(
      tmpdir(),
      `quadball-timer-sqlite-probe-sibling-${crypto.randomUUID()}`,
    );
    try {
      await symlink(workspace.directoryPath, symlinkPath);
      expect(
        await captureRejection(() =>
          validateOwnedProbeWorkspace(symlinkPath, workspace.capability, "fresh"),
        ),
      ).toHaveProperty("message", "SQLite probe ownership validation failed.");

      await writeFile(siblingPath, "keep");
      await cleanupOwnedProbeWorkspace(workspace.directoryPath, workspace.capability);
      expect(await Bun.file(siblingPath).text()).toBe("keep");
      expect(await Bun.file(workspace.directoryPath).exists()).toBe(false);
    } finally {
      await rm(symlinkPath, { force: true });
      await rm(siblingPath, { force: true });
      if (await Bun.file(workspace.directoryPath).exists()) {
        await cleanupOwnedProbeWorkspace(workspace.directoryPath, workspace.capability);
      }
    }
  });

  test("contains a nested workspace under a wrapper-owned temporary container", async () => {
    const container = await createProbeWorkspaceContainer();
    let workspace = null as Awaited<ReturnType<typeof createProbeWorkspace>> | null;
    try {
      workspace = await createProbeWorkspace(container);
      expect(workspace.directoryPath.startsWith(`${container.directoryPath}/`)).toBe(true);
      expect(
        (
          await validateOwnedProbeWorkerWorkspace(
            workspace.directoryPath,
            workspace.capability,
            "fresh",
            container,
          )
        ).directoryPath,
      ).toBe(workspace.directoryPath);
      await cleanupOwnedProbeWorkspace(workspace.directoryPath, workspace.capability);
      expect(await Bun.file(workspace.directoryPath).exists()).toBe(false);
      await cleanupOwnedProbeWorkspaceContainer(container.directoryPath, container.capability);
      expect(await Bun.file(container.directoryPath).exists()).toBe(false);
    } finally {
      if (workspace !== null && (await Bun.file(workspace.directoryPath).exists())) {
        await cleanupOwnedProbeWorkspace(workspace.directoryPath, workspace.capability);
      }
      if (await Bun.file(container.directoryPath).exists()) {
        await cleanupOwnedProbeWorkspaceContainer(container.directoryPath, container.capability);
      }
    }
  });

  test("rejects direct worker validation without parent ownership evidence", async () => {
    const workspace = await createProbeWorkspace();
    try {
      expect(
        await captureRejection(() =>
          validateOwnedProbeWorkerWorkspace(workspace.directoryPath, workspace.capability, "fresh"),
        ),
      ).toHaveProperty("message", "SQLite probe ownership validation failed.");
    } finally {
      await cleanupOwnedProbeWorkspace(workspace.directoryPath, workspace.capability);
    }
  });

  test("terminates all siblings on the first worker failure without waiting for the workload", async () => {
    const first = createFakeWorker(101, false);
    const second = createFakeWorker(102, false);
    const workers = [first.worker, second.worker];
    const signals: string[] = [];
    first.complete({
      exitCode: 1,
      stdout: "",
      stderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      outputExceeded: false,
    });

    expect(
      await captureRejection(() =>
        superviseProbeWorkers(workers, {
          scheduleTimeout: () => 0,
          clearTimeout: () => {},
          sleep: async () => {},
          signalProcessGroup: (pid, signal) => {
            signals.push(`${pid}:${signal}`);
            const target = pid === first.worker.process.pid ? first : second;
            target.terminate(signal);
            return true;
          },
        }),
      ),
    ).toHaveProperty(
      "message",
      expect.stringContaining("SQLite integrity probe worker 0 exited unsuccessfully."),
    );

    expect(signals).toEqual(["102:SIGTERM"]);
  });

  test("surfaces deterministic capped diagnostics without capability or path secrets", async () => {
    const secretPath = "/tmp/quadball-timer-sqlite-container-secret/probe.sqlite";
    const quotedPosixPath = "/Users/jannis/Documents/workspace/php js/private/probe.sqlite";
    const quotedWindowsPath = "C:\\Program Files\\Quadball Timer\\private\\probe.sqlite";
    const secretCapability = "12345678-1234-1234-1234-123456789abc";
    const run = async () => {
      const failed = createFakeWorker(111, false);
      const sibling = createFakeWorker(112, false);
      failed.complete({
        exitCode: 1,
        stdout: `worker opened ${secretPath}; then "${quotedPosixPath}".\n${"x".repeat(10_000)}`,
        stderr: `capability=${secretCapability}; failed at '${quotedWindowsPath}',`,
        stdoutBytes: new TextEncoder().encode(
          `worker opened ${secretPath}; then "${quotedPosixPath}".\n${"x".repeat(10_000)}`,
        ).byteLength,
        stderrBytes: new TextEncoder().encode(
          `capability=${secretCapability}; failed at '${quotedWindowsPath}',`,
        ).byteLength,
        outputExceeded: false,
      });
      return captureRejection(() =>
        superviseProbeWorkers([failed.worker, sibling.worker], {
          scheduleTimeout: () => 0,
          clearTimeout: () => {},
          sleep: async () => {},
          signalProcessGroup: (_pid, signal) => {
            sibling.terminate(signal);
            return true;
          },
        }),
      );
    };
    const firstError = await run();
    const secondError = await run();

    expect(firstError.message).toBe(secondError.message);
    expect(firstError.message).toContain("stdout=");
    expect(firstError.message).toContain("stderr=");
    expect(firstError.message).toContain("<path>");
    expect(firstError.message).toContain("<capability>");
    expect(firstError.message).not.toContain(secretPath);
    expect(firstError.message).not.toContain(quotedPosixPath);
    expect(firstError.message).not.toContain("js/private/probe.sqlite");
    expect(firstError.message).not.toContain(quotedWindowsPath);
    expect(firstError.message).not.toContain("Quadball Timer");
    expect(firstError.message).not.toContain(secretCapability);
    expect(new TextEncoder().encode(firstError.message).byteLength).toBeLessThanOrEqual(
      SQLITE_FOUNDATION_PROBE_MAX_OUTPUT_BYTES + 256,
    );
  });

  test("redacts secrets that cross the smaller diagnostic output boundary", async () => {
    const perStreamBoundary = Math.floor((SQLITE_FOUNDATION_PROBE_MAX_OUTPUT_BYTES - 128) / 2);
    const capabilityPrefix = "12345678-1234";
    const pathPrefix = "/tmp/private-probe";
    const failed = createFakeWorker(121, false);
    const sibling = createFakeWorker(122, false);
    failed.complete({
      exitCode: 1,
      stdout: `${"x".repeat(perStreamBoundary - 6)}${capabilityPrefix}-1234-1234-123456789abc`,
      stderr: `${"y".repeat(perStreamBoundary - 6)}${pathPrefix}/probe.sqlite`,
      stdoutBytes: new TextEncoder().encode(
        `${"x".repeat(perStreamBoundary - 6)}${capabilityPrefix}-1234-1234-123456789abc`,
      ).byteLength,
      stderrBytes: new TextEncoder().encode(
        `${"y".repeat(perStreamBoundary - 6)}${pathPrefix}/probe.sqlite`,
      ).byteLength,
      outputExceeded: false,
    });

    const error = await captureRejection(() =>
      superviseProbeWorkers([failed.worker, sibling.worker], {
        scheduleTimeout: () => 0,
        clearTimeout: () => {},
        sleep: async () => {},
        signalProcessGroup: (_pid, signal) => {
          sibling.terminate(signal);
          return true;
        },
      }),
    );

    expect(error.message).not.toContain(capabilityPrefix);
    expect(error.message).not.toContain(pathPrefix);
  });

  test("signals one shared outer process group for all nested workers", async () => {
    const first = createFakeWorker(501, false, 500);
    const second = createFakeWorker(502, false, 500);
    const signals: string[] = [];
    first.complete({
      exitCode: 1,
      stdout: "",
      stderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      outputExceeded: false,
    });

    expect(
      await captureRejection(() =>
        superviseProbeWorkers([first.worker, second.worker], {
          scheduleTimeout: () => 0,
          clearTimeout: () => {},
          sleep: async () => {},
          signalProcessGroup: (pid, signal) => {
            signals.push(`${pid}:${signal}`);
            second.terminate(signal);
            return true;
          },
        }),
      ),
    ).toHaveProperty(
      "message",
      expect.stringContaining("SQLite integrity probe worker 0 exited unsuccessfully."),
    );

    expect(signals).toEqual(["500:SIGTERM"]);
  });

  test("uses a strict timeout and TERM then KILL cleanup without real-time sleeps", async () => {
    const first = createFakeWorker(201, true);
    const second = createFakeWorker(202, true);
    const signals: string[] = [];

    expect(
      await captureRejection(() =>
        superviseProbeWorkers([first.worker, second.worker], {
          scheduleTimeout: (callback) => {
            callback();
            return 0;
          },
          clearTimeout: () => {},
          sleep: async () => {},
          signalProcessGroup: (pid, signal) => {
            signals.push(`${pid}:${signal}`);
            const target = pid === first.worker.process.pid ? first : second;
            target.terminate(signal);
            return true;
          },
        }),
      ),
    ).toHaveProperty(
      "message",
      "SQLite integrity probe timed out after 15000ms; descendants were terminated.",
    );

    expect(signals).toEqual(["201:SIGTERM", "202:SIGTERM", "201:SIGKILL", "202:SIGKILL"]);
  });

  test("bounds final reap when a process handle never reports SIGKILL exit", async () => {
    const worker = createFakeWorker(401, true);
    const signals: string[] = [];

    expect(
      await captureRejection(() =>
        superviseProbeWorkers([worker.worker], {
          timeoutMs: 1,
          reapTimeoutMs: 1,
          scheduleTimeout: (callback) => {
            callback();
            return 0;
          },
          clearTimeout: () => {},
          sleep: async () => {},
          signalProcessGroup: (pid, signal) => {
            signals.push(`${pid}:${signal}`);
            return true;
          },
        }),
      ),
    ).toHaveProperty("message", "SQLite integrity probe descendants were not reaped within 1ms.");

    expect(signals).toEqual(["401:SIGTERM", "401:SIGKILL"]);
  });

  test("cleans up every worker when interrupted", async () => {
    const controller = new AbortController();
    controller.abort();
    const worker = createFakeWorker(301, false);
    const signals: string[] = [];

    expect(
      await captureRejection(() =>
        superviseProbeWorkers([worker.worker], {
          signal: controller.signal,
          scheduleTimeout: () => 0,
          clearTimeout: () => {},
          sleep: async () => {},
          signalProcessGroup: (pid, signal) => {
            signals.push(`${pid}:${signal}`);
            worker.terminate(signal);
            return true;
          },
        }),
      ),
    ).toHaveProperty(
      "message",
      "SQLite integrity probe was interrupted; descendants were terminated.",
    );

    expect(signals).toEqual(["301:SIGTERM"]);
  });
});

function createFakeWorker(
  pid: number,
  ignoreTerminationSignal: boolean,
  processGroupId?: number,
): {
  worker: ProbeWorkerHandle;
  complete: (result: ProbeWorkerResult) => void;
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
      if (signal !== undefined) {
        terminate(signal);
      }
    },
  };
  const worker = { process, result };

  function complete(workerResult: ProbeWorkerResult) {
    exitCode = workerResult.exitCode;
    resolveExited(workerResult.exitCode);
    resolveResult(workerResult);
  }

  function terminate(signal: NodeJS.Signals) {
    if (signal === "SIGTERM" && ignoreTerminationSignal) {
      return;
    }
    complete({
      exitCode: signal === "SIGKILL" ? 137 : 143,
      stdout: "",
      stderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      outputExceeded: false,
    });
  }

  return { worker, complete, terminate };
}

async function captureRejection(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error("Expected an Error rejection.");
  }
  throw new Error("Expected the operation to reject.");
}
