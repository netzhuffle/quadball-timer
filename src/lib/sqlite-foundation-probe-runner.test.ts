import { describe, expect, test } from "bun:test";
import {
  runCompiledSqliteFoundationProbe,
  type ProbeProcess,
  type ProbeQualificationResult,
  type ProbeWorkerHandle,
  type ProbeWorkerResult,
  type ProbeWorkspaceContainer,
} from "@/lib/sqlite-foundation-probe";
import {
  buildQualificationResult,
  resolveProbeCommit,
  type ProbeCommitChild,
} from "@/lib/sqlite-foundation-probe-runner-evidence";
import type { ProbeNetworkBoundary } from "@/lib/sqlite-foundation-probe-network";
import { createProbeOutputBudget, spawnProbeCommand } from "@/lib/sqlite-foundation-probe-process";
import {
  ProbeResourceLimitError,
  type ProbeResourceController,
} from "@/lib/sqlite-foundation-probe-resources";

const CAPABILITY = "00000000-0000-0000-0000-000000000000";

describe("sqlite-foundation-probe runner", () => {
  test("bounds nested wrapper cleanup for success, failure, timeout, and interruption", async () => {
    const cases = [
      { label: "success", outcome: "success" as const, expectedSignals: [] },
      { label: "failure", outcome: "failure" as const, expectedSignals: ["701:SIGTERM"] },
      {
        label: "timeout",
        outcome: "timeout" as const,
        expectedSignals: ["701:SIGTERM", "701:SIGKILL"],
      },
    ];

    for (const testCase of cases) {
      const nested = createNestedProbe(testCase.outcome);

      let workspaceRemoved = false;
      const signals: string[] = [];
      const emittedResults: Array<{
        phase: "pre-cleanup" | "final";
        outcome: string;
        cleanup: { temporaryDataRemoved: boolean };
        platform: { sqliteVersion: string | null };
      }> = [];
      const networkBoundary: ProbeNetworkBoundary = {
        commandPrefix: ["unshare", "--net", "--"],
        namespace: "net:[fake]",
        verified: true,
      };
      const resourceController: ProbeResourceController = {
        prepare: async (command) => ({ command, release: async () => {} }),
        attach: async () => {},
        kill: async () => {},
        reap: async () => {},
        sample: async () => ({
          processCount: 7,
          peakMemoryBytes: 512 * 1024 * 1024,
          diskBytes: 0,
          outputBytes: 0,
        }),
        close: async () => {},
      };
      const options = {
        timeoutMs: 15_000,
        scheduleTimeout: (callback: () => void) => {
          if (testCase.outcome === "timeout") callback();
          return 0;
        },
        clearTimeout: () => {},
        sleep: async () => {},
        signalProcessGroup: (pid: number, signal: NodeJS.Signals) => {
          signals.push(`${pid}:${signal}`);
          nested.terminateGroup(signal);
          return true;
        },
        createWorkspaceContainer: async () => nested.container,
        networkBoundary,
        resourceController,
        cleanupWorkspaceContainer: async () => {
          expect(emittedResults).toHaveLength(1);
          workspaceRemoved = true;
        },
        spawnOuter: () => nested.outer,
        emitResult: (result: ProbeQualificationResult) => {
          expect(workspaceRemoved).toBe(result.phase === "final");
          emittedResults.push(result);
        },
      };

      const operation = () => runCompiledSqliteFoundationProbe("compiled-probe", options);
      if (testCase.outcome === "success") await operation();
      else await captureRejection(operation);

      expect(signals, `${testCase.label} TERM/KILL order`).toEqual(testCase.expectedSignals);
      expect(nested.outer.process.exitCode, `${testCase.label} outer reaped`).not.toBeNull();
      expect(nested.childReaped, `${testCase.label} descendants reaped`).toBe(true);
      expect(workspaceRemoved, `${testCase.label} workspace removed`).toBe(true);
      expect(emittedResults[0]?.outcome, `${testCase.label} result`).toBe(
        testCase.outcome === "success"
          ? "passed"
          : testCase.outcome === "timeout"
            ? "timed-out"
            : "failed",
      );
      expect(emittedResults[0]?.cleanup.temporaryDataRemoved).toBe(false);
      expect(emittedResults[1]?.cleanup.temporaryDataRemoved).toBe(true);
      if (testCase.outcome === "success") {
        expect(emittedResults[1]?.platform.sqliteVersion).toBe("3.53.0");
      }
    }
  });

  test("retains a final cleanup failure instead of claiming temporary data was removed", async () => {
    const nested = createNestedProbe("success");
    const resourceController: ProbeResourceController = {
      prepare: async (command) => ({ command, release: async () => {} }),
      attach: async () => {},
      kill: async () => {},
      reap: async () => {},
      sample: async () => ({
        processCount: 7,
        peakMemoryBytes: 512 * 1024 * 1024,
        diskBytes: 0,
        outputBytes: 0,
      }),
      close: async () => {},
    };
    const results: ProbeQualificationResult[] = [];

    await captureRejection(() =>
      runCompiledSqliteFoundationProbe("compiled-probe", {
        networkBoundary: {
          commandPrefix: ["unshare", "--net", "--"],
          namespace: "net:[fake]",
          verified: true,
        },
        resourceController,
        createWorkspaceContainer: async () => nested.container,
        spawnOuter: () => nested.outer,
        cleanupWorkspaceContainer: async () => {
          throw new Error("cleanup unavailable");
        },
        emitResult: (result) => {
          results.push(result);
        },
        emitResultFallback: (result) => {
          results.push(result);
        },
      }),
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.invocationId).toBe(results[1]?.invocationId);
    expect(results[0]?.cleanup).toEqual({
      descendantsTerminated: true,
      descendantsReaped: true,
      controllerEmpty: true,
      controllerRemoved: null,
      tmpfsRemoved: true,
      workspaceRemoved: null,
      temporaryDataRemoved: false,
      retainedController: { state: "none", scope: null, resources: [] },
      status: "pending",
      failures: [],
    });
    expect(results[1]?.cleanup).toEqual({
      descendantsTerminated: true,
      descendantsReaped: true,
      controllerEmpty: true,
      controllerRemoved: true,
      tmpfsRemoved: true,
      workspaceRemoved: false,
      temporaryDataRemoved: false,
      retainedController: { state: "unknown", scope: "invocation-cgroup", resources: [] },
      status: "failed",
      failures: ["workspace-removal"],
    });
  });

  test("does not infer tree cleanup from an outer exit when cgroup reaping fails", async () => {
    const nested = createNestedProbe("success");
    const results: ProbeQualificationResult[] = [];
    let workspaceCleanupCalls = 0;

    await captureRejection(() =>
      runCompiledSqliteFoundationProbe("compiled-probe", {
        networkBoundary: {
          commandPrefix: ["unshare", "--net", "--"],
          namespace: "net:[fake]",
          verified: true,
        },
        resourceController: {
          prepare: async (command) => ({ command, release: async () => {} }),
          attach: async () => {},
          kill: async () => {},
          reap: async () => {
            throw new Error("cgroup membership unavailable");
          },
          sample: async () => ({
            processCount: 7,
            peakMemoryBytes: 512 * 1024 * 1024,
            diskBytes: 0,
            outputBytes: 0,
          }),
          close: async () => {},
        },
        createWorkspaceContainer: async () => nested.container,
        cleanupWorkspaceContainer: async () => {
          workspaceCleanupCalls += 1;
        },
        spawnOuter: () => nested.outer,
        emitResult: (result) => {
          results.push(result);
        },
      }),
    );

    expect(workspaceCleanupCalls).toBe(0);
    expect(results[0]?.cleanup.descendantsReaped).toBe(false);
    expect(results[1]?.cleanup.descendantsReaped).toBe(false);
    expect(results[1]?.cleanup).toMatchObject({
      descendantsTerminated: false,
      controllerEmpty: false,
      controllerRemoved: null,
      tmpfsRemoved: true,
      workspaceRemoved: null,
      failures: ["descendant-termination-or-reap", "controller-empty"],
    });
    expect(results[1]?.cleanup.temporaryDataRemoved).toBe(false);
    expect(results[1]?.cleanup.status).toBe("failed");
  });

  test("retains a partial controller and blocks generic workspace cleanup", async () => {
    const results: ProbeQualificationResult[] = [];
    let workspaceCleanupCalls = 0;
    const retainedController = {
      rootPath: "/sys/fs/cgroup/delegated/quadball-timer-sqlite-root",
      helperPath: "/sys/fs/cgroup/delegated/quadball-timer-sqlite-root/helper",
      workloadPath: "/sys/fs/cgroup/delegated/quadball-timer-sqlite-root/workload",
      markerPath: "/tmp/container/.probe-cgroup-capability",
      retainedPaths: ["/sys/fs/cgroup/delegated/quadball-timer-sqlite-root"],
    };

    await captureRejection(() =>
      runCompiledSqliteFoundationProbe("compiled-probe", {
        networkBoundary: {
          commandPrefix: ["unshare", "--net", "--"],
          namespace: "net:[fake]",
          verified: true,
        },
        createWorkspaceContainer: async () => createNestedProbe("success").container,
        createResourceController: async () => {
          const error = new Error("controller setup retained a cgroup") as Error & {
            retainedController: typeof retainedController;
          };
          error.retainedController = retainedController;
          throw error;
        },
        cleanupWorkspaceContainer: async () => {
          workspaceCleanupCalls += 1;
        },
        emitResult: (result) => {
          results.push(result);
        },
      }),
    );

    expect(workspaceCleanupCalls).toBe(0);
    expect(results).toHaveLength(2);
    expect(results[1]?.cleanup).toMatchObject({
      descendantsReaped: false,
      controllerEmpty: false,
      controllerRemoved: false,
      workspaceRemoved: null,
      temporaryDataRemoved: false,
      status: "failed",
      failures: ["retained-controller"],
    });
    expect(results[1]?.cleanup.retainedController).toEqual({
      state: "retained",
      scope: "invocation-cgroup",
      resources: ["root"],
    });
    expect(results[1]?.evidence).toEqual({
      disposition: "retained-owned-state",
      location: null,
      retention: "coordinator-handoff",
    });
    expect(JSON.stringify(results[1])).not.toContain("/sys/fs/cgroup");
  });

  test("uses the installed signal scope to interrupt setup, reap descendants, and retain cleanup", async () => {
    const nested = createNestedProbe("timeout");
    const interruption = new AbortController();
    const results: ProbeQualificationResult[] = [];
    const signals: string[] = [];
    let signalScopeCleaned = false;

    await captureRejection(() =>
      runCompiledSqliteFoundationProbe("compiled-probe", {
        networkBoundary: {
          commandPrefix: ["unshare", "--net", "--"],
          namespace: "net:[fake]",
          verified: true,
        },
        resourceController: {
          prepare: async (command) => ({ command, release: async () => {} }),
          attach: async () => {
            interruption.abort();
          },
          kill: async () => {},
          reap: async () => {},
          sample: async () => ({
            processCount: 7,
            peakMemoryBytes: 512 * 1024 * 1024,
            diskBytes: 0,
            outputBytes: 0,
          }),
          close: async () => {},
        },
        createWorkspaceContainer: async () => nested.container,
        cleanupWorkspaceContainer: async () => {},
        spawnOuter: () => nested.outer,
        installSignalHandlers: () => ({
          signal: interruption.signal,
          cleanup: () => {
            signalScopeCleaned = true;
          },
        }),
        scheduleTimeout: () => 0,
        clearTimeout: () => {},
        sleep: async () => {},
        signalProcessGroup: (pid, signal) => {
          signals.push(`${pid}:${signal}`);
          nested.terminateGroup(signal);
          return true;
        },
        emitResult: (result) => {
          results.push(result);
        },
        emitResultFallback: (result) => {
          results.push(result);
        },
      }),
    );

    expect(signals).toEqual(["701:SIGTERM", "701:SIGKILL"]);
    expect(nested.childReaped).toBe(true);
    expect(results[0]?.outcome).toBe("interrupted");
    expect(results[1]?.cleanup).toEqual({
      descendantsTerminated: true,
      descendantsReaped: true,
      controllerEmpty: true,
      controllerRemoved: true,
      tmpfsRemoved: null,
      workspaceRemoved: true,
      temporaryDataRemoved: true,
      retainedController: { state: "none", scope: null, resources: [] },
      status: "verified",
      failures: [],
    });
    expect(signalScopeCleaned).toBe(true);
  });

  test("retains the violating resource measurement in both bounded result records", async () => {
    const nested = createNestedProbe("timeout");
    const violatingMeasurement = {
      processCount: 8,
      peakMemoryBytes: 513 * 1024 * 1024,
      diskBytes: 16 * 1024 * 1024 + 1,
      outputBytes: 4 * 1024 + 1,
    };
    const results: ProbeQualificationResult[] = [];

    await captureRejection(() =>
      runCompiledSqliteFoundationProbe("compiled-probe", {
        networkBoundary: {
          commandPrefix: ["unshare", "--net", "--"],
          namespace: "net:[fake]",
          verified: true,
        },
        resourceController: {
          prepare: async (command) => ({ command, release: async () => {} }),
          attach: async () => {},
          kill: async () => {},
          reap: async () => {},
          sample: async () => {
            throw new ProbeResourceLimitError(violatingMeasurement);
          },
          close: async () => {},
        },
        createWorkspaceContainer: async () => nested.container,
        cleanupWorkspaceContainer: async () => {},
        spawnOuter: () => nested.outer,
        signalProcessGroup: (pid, signal) => {
          nested.terminateGroup(signal);
          return true;
        },
        sleep: async () => {},
        emitResult: (result) => {
          results.push(result);
        },
      }),
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.measuredResources).toEqual(violatingMeasurement);
    expect(results[1]?.measuredResources).toEqual(violatingMeasurement);
  });

  test("retains the observed byte count on the actual captured-output overflow path", async () => {
    const results: ProbeQualificationResult[] = [];
    const container = createNestedProbe("success").container;
    const overflowingCommand = [process.execPath, "-e", 'process.stdout.write("x".repeat(5000))'];

    await captureRejection(() =>
      runCompiledSqliteFoundationProbe("unused", {
        networkBoundary: {
          commandPrefix: overflowingCommand,
          namespace: "net:[fake]",
          verified: true,
        },
        resourceController: {
          prepare: async (command) => ({ command, release: async () => {} }),
          attach: async () => {},
          kill: async () => {},
          reap: async () => {},
          sample: async () => ({
            processCount: 7,
            peakMemoryBytes: 512 * 1024 * 1024,
            diskBytes: 0,
            outputBytes: 0,
          }),
          close: async () => {},
        },
        createWorkspaceContainer: async () => container,
        cleanupWorkspaceContainer: async () => {},
        spawnOuter: () =>
          spawnProbeCommand(overflowingCommand, {
            detached: true,
            outputBudget: createProbeOutputBudget(),
          }),
        emitResult: (result) => {
          results.push(result);
        },
      }),
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.measuredResources.outputBytes).toBe(5000);
    expect(results[1]?.measuredResources.outputBytes).toBe(5000);
  });

  test("prepares the cgroup start barrier before spawning the artifact", async () => {
    const nested = createNestedProbe("success");
    const events: string[] = [];

    await runCompiledSqliteFoundationProbe("compiled-probe", {
      networkBoundary: {
        commandPrefix: ["unshare", "--net", "--"],
        namespace: "net:[fake]",
        verified: true,
      },
      resourceController: {
        prepare: async (command) => {
          events.push("prepare");
          return {
            command,
            release: async () => {
              events.push("release");
            },
          };
        },
        attach: async () => {
          events.push("attach");
        },
        kill: async () => {},
        reap: async () => {},
        sample: async () => ({
          processCount: 7,
          peakMemoryBytes: 512 * 1024 * 1024,
          diskBytes: 0,
          outputBytes: 0,
        }),
        close: async () => {},
      },
      createWorkspaceContainer: async () => nested.container,
      cleanupWorkspaceContainer: async () => {},
      spawnOuter: () => {
        events.push("spawn");
        return {
          ...nested.outer,
          ready: Promise.resolve().then(() => {
            events.push("ready");
            return true;
          }),
        };
      },
      emitResult: () => {},
    });

    expect(events).toEqual(["prepare", "spawn", "ready", "attach", "release"]);
  });

  test("reconciles a late setup completion before retaining final evidence", async () => {
    const results: ProbeQualificationResult[] = [];
    let expireSetup: (() => void) | undefined;
    let lateSetupSettled = false;

    await captureRejection(() =>
      runCompiledSqliteFoundationProbe("compiled-probe", {
        scheduleTotalTimeout: (callback) => {
          expireSetup ??= callback;
          return 0;
        },
        createWorkspaceContainer: async (signal) => {
          signal?.addEventListener("abort", () => {}, { once: true });
          expireSetup?.();
          await Promise.resolve();
          lateSetupSettled = true;
          throw new Error("cooperative setup abort");
        },
        emitResult: (result) => {
          results.push(result);
        },
      }),
    );

    expect(lateSetupSettled).toBe(true);
    expect(results[1]?.cleanup).toEqual({
      descendantsTerminated: true,
      descendantsReaped: true,
      controllerEmpty: null,
      controllerRemoved: null,
      tmpfsRemoved: null,
      workspaceRemoved: null,
      temporaryDataRemoved: false,
      retainedController: { state: "none", scope: null, resources: [] },
      status: "verified",
      failures: [],
    });
  });

  test("uses the total deadline to stop the workload while retaining bounded final cleanup", async () => {
    const nested = createNestedProbe("timeout");
    const results: ProbeQualificationResult[] = [];
    let totalTimerCalls = 0;
    let expireWork: (() => void) | undefined;
    const signals: string[] = [];

    await captureRejection(() =>
      runCompiledSqliteFoundationProbe("compiled-probe", {
        networkBoundary: {
          commandPrefix: ["unshare", "--net", "--"],
          namespace: "net:[fake]",
          verified: true,
        },
        resourceController: {
          prepare: async (command) => ({ command, release: async () => {} }),
          attach: async () => {
            expireWork?.();
          },
          kill: async () => {},
          reap: async () => {},
          sample: async () => ({
            processCount: 7,
            peakMemoryBytes: 512 * 1024 * 1024,
            diskBytes: 0,
            outputBytes: 0,
          }),
          close: async () => {},
        },
        createWorkspaceContainer: async () => nested.container,
        cleanupWorkspaceContainer: async () => {},
        spawnOuter: () => nested.outer,
        scheduleTotalTimeout: (callback) => {
          totalTimerCalls += 1;
          if (totalTimerCalls === 1) expireWork = callback;
          return totalTimerCalls;
        },
        scheduleTimeout: () => 0,
        clearTimeout: () => {},
        sleep: async () => {},
        signalProcessGroup: (pid, signal) => {
          signals.push(`${pid}:${signal}`);
          nested.terminateGroup(signal);
          return true;
        },
        emitResult: (result) => {
          results.push(result);
        },
      }),
    );

    expect(signals).toEqual(["701:SIGTERM", "701:SIGKILL"]);
    expect(results).toHaveLength(2);
    expect(results[0]?.outcome).toBe("timed-out");
    expect(results[0]?.cleanup.temporaryDataRemoved).toBe(false);
    expect(results[1]?.cleanup).toEqual({
      descendantsTerminated: true,
      descendantsReaped: true,
      controllerEmpty: true,
      controllerRemoved: true,
      tmpfsRemoved: null,
      workspaceRemoved: true,
      temporaryDataRemoved: true,
      retainedController: { state: "none", scope: null, resources: [] },
      status: "verified",
      failures: [],
    });
  });

  test("retains final cleanup evidence when the hard deadline interrupts cleanup", async () => {
    const nested = createNestedProbe("success");
    const results: ProbeQualificationResult[] = [];
    let totalTimerCalls = 0;
    let expireHardDeadline: (() => void) | undefined;

    await captureRejection(() =>
      runCompiledSqliteFoundationProbe("compiled-probe", {
        networkBoundary: {
          commandPrefix: ["unshare", "--net", "--"],
          namespace: "net:[fake]",
          verified: true,
        },
        resourceController: {
          prepare: async (command) => ({ command, release: async () => {} }),
          attach: async () => {},
          kill: async () => {},
          reap: async () => {},
          sample: async () => ({
            processCount: 7,
            peakMemoryBytes: 512 * 1024 * 1024,
            diskBytes: 0,
            outputBytes: 0,
          }),
          close: async () => {
            expireHardDeadline?.();
          },
        },
        createWorkspaceContainer: async () => nested.container,
        cleanupWorkspaceContainer: async () => {},
        spawnOuter: () => nested.outer,
        scheduleTotalTimeout: (callback) => {
          totalTimerCalls += 1;
          if (totalTimerCalls === 2) expireHardDeadline = callback;
          return totalTimerCalls;
        },
        scheduleTimeout: () => 0,
        clearTimeout: () => {},
        emitResult: (result) => {
          results.push(result);
        },
        emitResultFallback: (result) => {
          results.push(result);
        },
      }),
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.cleanup.temporaryDataRemoved).toBe(false);
    expect(results[1]?.cleanup.temporaryDataRemoved).toBe(false);
    expect(results[1]?.cleanup.status).toBe("failed");
  });

  test("falls back to bounded final evidence when the async emitter stalls", async () => {
    const nested = createNestedProbe("success");
    const primaryResults: ProbeQualificationResult[] = [];
    const fallbackResults: ProbeQualificationResult[] = [];
    let timerCalls = 0;
    let expireHardDeadline: (() => void) | undefined;

    await captureRejection(() =>
      runCompiledSqliteFoundationProbe("compiled-probe", {
        networkBoundary: {
          commandPrefix: ["unshare", "--net", "--"],
          namespace: "net:[fake]",
          verified: true,
        },
        resourceController: {
          prepare: async (command) => ({ command, release: async () => {} }),
          attach: async () => {},
          kill: async () => {},
          reap: async () => {},
          sample: async () => ({
            processCount: 7,
            peakMemoryBytes: 512 * 1024 * 1024,
            diskBytes: 0,
            outputBytes: 0,
          }),
          close: async () => {},
        },
        createWorkspaceContainer: async () => nested.container,
        cleanupWorkspaceContainer: async () => {},
        spawnOuter: () => nested.outer,
        scheduleTotalTimeout: (callback) => {
          timerCalls += 1;
          if (timerCalls === 2) expireHardDeadline = callback;
          return timerCalls;
        },
        scheduleTimeout: () => 0,
        clearTimeout: () => {},
        emitResult: (result) => {
          if (result.phase === "final") {
            expireHardDeadline?.();
            return new Promise<void>(() => {});
          }
          primaryResults.push(result);
        },
        emitResultFallback: (result) => {
          fallbackResults.push(result);
        },
      }),
    );

    expect(primaryResults).toHaveLength(1);
    expect(fallbackResults).toHaveLength(1);
    expect(fallbackResults[0]?.phase).toBe("final");
    expect(fallbackResults[0]?.outcome).toBe("failed");
    expect(fallbackResults[0]?.cleanup.status).toBe("failed");
    expect(fallbackResults[0]?.cleanup.failures).toContain("result-emission");
    expect(fallbackResults[0]?.evidence.retention).toBe("coordinator-handoff");
    expect(fallbackResults[0]?.cleanup.temporaryDataRemoved).toBe(true);
  });

  test("retains incomplete cleanup when cgroup reap never settles", async () => {
    const nested = createNestedProbe("success");
    const results: ProbeQualificationResult[] = [];
    let hardDeadline: (() => void) | undefined;
    let timerCalls = 0;
    await captureRejection(() =>
      runCompiledSqliteFoundationProbe("compiled-probe", {
        networkBoundary: {
          commandPrefix: ["unshare", "--net", "--"],
          namespace: "net:[fake]",
          verified: true,
        },
        resourceController: {
          prepare: async (command) => ({ command, release: async () => {} }),
          attach: async () => {},
          kill: async () => {},
          reap: async () => {
            hardDeadline?.();
            await new Promise<void>(() => {});
          },
          sample: async () => ({
            processCount: 7,
            peakMemoryBytes: 0,
            diskBytes: 0,
            outputBytes: 0,
          }),
          close: async () => {},
        },
        createWorkspaceContainer: async () => nested.container,
        spawnOuter: () => nested.outer,
        scheduleTotalTimeout: (callback) => {
          timerCalls += 1;
          if (timerCalls === 2) hardDeadline = callback;
          return timerCalls;
        },
        clearTotalTimeout: () => {},
        emitResult: (result) => {
          results.push(result);
        },
        emitResultFallback: (result) => {
          results.push(result);
        },
      }),
    );
    expect(results.at(-1)?.cleanup.status).toBe("failed");
    expect(results.at(-1)?.cleanup.retainedController.state).toBe("unknown");
    expect(results.at(-1)?.cleanup.temporaryDataRemoved).toBe(false);
    expect(results.at(-1)?.evidence.retention).toBe("coordinator-handoff");
  });

  test("aborts injected commit resolution through the lifecycle signal", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const result = resolveProbeCommit((signal) => {
      receivedSignal = signal;
      return new Promise<string>(() => {});
    }, controller.signal);
    controller.abort();
    expect(await result).toBe("unknown");
    expect(receivedSignal).toBe(controller.signal);
  });

  test("retains explicit evidence failure when the commit helper cannot be reaped", async () => {
    const controller = new AbortController();
    let killed = false;
    const child: ProbeCommitChild = {
      stdout: new ReadableStream<Uint8Array>(),
      exited: new Promise<number>(() => {}),
      kill: () => {
        killed = true;
      },
    };
    const result = buildQualificationResult({
      phase: "final",
      invocationId: "invocation",
      command: undefined,
      commit: undefined,
      spawnCommit: (signal) => {
        queueMicrotask(() => controller.abort());
        expect(signal).toBe(controller.signal);
        return child;
      },
      startedAtMs: 0,
      now: () => 1,
      measuredResources: { processCount: 7, peakMemoryBytes: 512, diskBytes: 1, outputBytes: 1 },
      result: {
        exitCode: 0,
        stdout: '{"sqliteVersion":"3.53.0"}',
        stderr: "",
        stdoutBytes: 27,
        stderrBytes: 0,
        outputExceeded: false,
      },
      terminalError: undefined,
      probeError: undefined,
      descendantsReaped: true,
      descendantsTerminated: true,
      controllerEmpty: true,
      controllerRemoved: true,
      tmpfsRemoved: true,
      workspaceRemoved: true,
      cleanupFailures: [],
      temporaryDataRemoved: true,
      cleanupStatus: "verified",
      retainedController: null,
      signal: controller.signal,
    });
    const evidence = await result;
    expect(evidence.outcome).toBe("failed");
    expect(evidence.cleanup.status).toBe("failed");
    expect(evidence.cleanup.failures).toContain("commit-helper-reap-unverified");
    expect(evidence.cleanup.descendantsTerminated).toBeNull();
    expect(evidence.cleanup.descendantsReaped).toBe(false);
    expect(evidence.cleanup.retainedController.state).toBe("none");
    expect(evidence.evidence).toEqual({
      disposition: "cleanup-failure",
      location: null,
      retention: "coordinator-handoff",
    });
    expect(killed).toBe(true);
  });

  test("retains a successful bounded commit-helper reap", async () => {
    const child: ProbeCommitChild = {
      stdout: new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode("abcdef1\n"));
          stream.close();
        },
      }),
      exited: Promise.resolve(0),
      kill: () => {},
    };
    expect(await resolveProbeCommit(undefined, new AbortController().signal, () => child)).toBe(
      "abcdef1",
    );
  });
});

function createNestedProbe(outcome: "success" | "failure" | "timeout" | "interruption"): {
  outer: ProbeWorkerHandle;
  container: ProbeWorkspaceContainer;
  childReaped: boolean;
  terminateGroup: (signal: NodeJS.Signals) => void;
} {
  let exitCode: number | null = null;
  let resolveExited: (code: number) => void = () => {};
  let resolveResult: (result: ProbeWorkerResult) => void = () => {};
  let childReaped = outcome === "success";
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });
  const result = new Promise<ProbeWorkerResult>((resolve) => {
    resolveResult = resolve;
  });
  const process: ProbeProcess = {
    pid: 701,
    processGroupOwned: true,
    get exitCode() {
      return exitCode;
    },
    get killed() {
      return exitCode !== null;
    },
    exited,
    kill(signal) {
      if (signal !== undefined) terminateGroup(signal);
    },
  };
  const outer = { process, result };
  const container: ProbeWorkspaceContainer = {
    directoryPath: "/tmp/fake-probe-container",
    capabilityPath: "/tmp/fake-probe-container/.capability",
    capability: CAPABILITY,
  };

  if (outcome === "success") completeOuter(0);
  else if (outcome === "failure") completeOuter(1);

  function completeOuter(code: number) {
    if (exitCode !== null) return;
    exitCode = code;
    resolveExited(code);
    const artifact = '{"sqliteVersion":"3.53.0"}';
    resolveResult({
      exitCode: code,
      stdout: artifact,
      stderr: code === 0 || code === 1 ? "TMPFS_REMOVED=1\n" : "",
      stdoutBytes: new TextEncoder().encode(artifact).byteLength,
      stderrBytes: code === 0 || code === 1 ? 16 : 0,
      outputExceeded: false,
    });
  }

  function terminateGroup(signal: NodeJS.Signals) {
    if (signal === "SIGTERM" && (outcome === "timeout" || outcome === "interruption")) return;
    childReaped = true;
    completeOuter(signal === "SIGKILL" ? 137 : 143);
  }

  return {
    outer,
    container,
    get childReaped() {
      return childReaped;
    },
    terminateGroup,
  };
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
