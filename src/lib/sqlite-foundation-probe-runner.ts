import {
  capDiagnosticOutput,
  createProbeOutputBudget,
  installProbeSignalHandlers,
  ProbeInterruptedError,
  ProbeTimeoutError,
  ProbeWorkerFailureError,
  SQLITE_FOUNDATION_PROBE_CLEANUP_RESERVE_MS,
  spawnProbeCommand,
  superviseProbeWorkers,
  type ProbeSupervisionOptions,
  type ProbeWorkerHandle,
  type ProbeWorkerResult,
} from "@/lib/sqlite-foundation-probe-process";
import {
  buildNoNetworkProbeCommand,
  createProbeNetworkBoundary,
  type ProbeNetworkBoundary,
} from "@/lib/sqlite-foundation-probe-network";
import {
  createProbeResourceController,
  readProbeTmpfsDisposition,
  type ProbeResourceControllerOptions,
  type ProbeResourceController,
} from "@/lib/sqlite-foundation-probe-resources";
import {
  type ProbeQualificationResult,
  type ProbeResourceMeasurement,
} from "@/lib/sqlite-foundation-probe-result";
import {
  SqliteFoundationGateError,
  translateProbeError,
} from "@/lib/sqlite-foundation-probe-errors";
import {
  cleanupOwnedProbeWorkspaceContainer,
  createProbeOuterEnvironment,
  createProbeWorkspaceContainer,
  type ProbeWorkspaceContainer,
} from "@/lib/sqlite-foundation-probe-containment";
import path from "node:path";
import type { ProbeRetainedCgroupController } from "@/lib/sqlite-foundation-probe-cgroup";
import { markProbeResultEmissionFailed } from "@/lib/sqlite-foundation-probe-evidence";
import {
  buildFallbackQualificationResult,
  buildQualificationResult,
  type ProbeCommitChild,
  type QualificationResultInput,
} from "@/lib/sqlite-foundation-probe-runner-evidence";

export type CompiledSqliteFoundationProbeOptions = ProbeSupervisionOptions & {
  createWorkspaceContainer?: (signal?: AbortSignal) => Promise<ProbeWorkspaceContainer>;
  cleanupWorkspaceContainer?: (
    container: ProbeWorkspaceContainer,
    signal?: AbortSignal,
  ) => Promise<void>;
  createNetworkBoundary?: () => Promise<ProbeNetworkBoundary>;
  networkBoundary?: ProbeNetworkBoundary;
  createResourceController?: (
    directoryPath: string,
    options?: ProbeResourceControllerOptions,
  ) => Promise<ProbeResourceController>;
  resourceController?: ProbeResourceController;
  spawnOuter?: (
    command: readonly string[],
    container: ProbeWorkspaceContainer,
  ) => ProbeWorkerHandle;
  command?: string;
  commit?: string | ((signal?: AbortSignal) => string | Promise<string>);
  spawnCommit?: (signal?: AbortSignal) => ProbeCommitChild;
  now?: () => number;
  scheduleTotalTimeout?: (callback: () => void, milliseconds: number) => number | NodeJS.Timeout;
  clearTotalTimeout?: (handle: number | NodeJS.Timeout) => void;
  installSignalHandlers?: typeof installProbeSignalHandlers;
  emitResult?: (result: ProbeQualificationResult) => void | Promise<void>;
  emitResultFallback?: (result: ProbeQualificationResult) => void;
};

export type CompiledSqliteFoundationProbeResult = ProbeWorkerResult & {
  qualificationResult: ProbeQualificationResult;
};

export async function runCompiledSqliteFoundationProbe(
  executablePath: string,
  options: CompiledSqliteFoundationProbeOptions = {},
): Promise<CompiledSqliteFoundationProbeResult> {
  const signalScope =
    options.signal === undefined
      ? (options.installSignalHandlers ?? installProbeSignalHandlers)()
      : null;
  const activeSignal = options.signal ?? signalScope?.signal;
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  const invocationId = crypto.randomUUID();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const cleanupReserveMs = Math.min(SQLITE_FOUNDATION_PROBE_CLEANUP_RESERVE_MS, timeoutMs);
  const workDeadline = startedAtMs + timeoutMs - cleanupReserveMs;
  const setupAbort = new AbortController();
  const cleanupAbort = new AbortController();
  const supervisionAbort = new AbortController();
  let deadlineExpired = false;
  const workTimer = (options.scheduleTotalTimeout ?? setTimeout)(
    () => {
      deadlineExpired = true;
      setupAbort.abort();
      supervisionAbort.abort();
    },
    Math.max(1, workDeadline - startedAtMs),
  );
  const hardTimer = (options.scheduleTotalTimeout ?? setTimeout)(() => {
    deadlineExpired = true;
    cleanupAbort.abort();
  }, timeoutMs);
  const clearTotalTimeout = options.clearTotalTimeout ?? clearTimeout;
  let removeCallerAbort = () => {};
  let interrupted = false;
  if (activeSignal !== undefined) {
    const abortCaller = () => {
      interrupted = true;
      setupAbort.abort();
      supervisionAbort.abort();
    };
    if (activeSignal.aborted) abortCaller();
    else {
      activeSignal.addEventListener("abort", abortCaller, { once: true });
      removeCallerAbort = () => activeSignal.removeEventListener("abort", abortCaller);
    }
  }

  let container: ProbeWorkspaceContainer | undefined;
  let resourceController: ProbeResourceController | undefined;
  let worker: ProbeWorkerHandle | undefined;
  let result: ProbeWorkerResult | undefined;
  let probeError: SqliteFoundationGateError | undefined;
  let terminalError: unknown;
  let supervisionAttempted = false;
  let descendantsTerminated: boolean | null = null;
  let descendantsReaped = false;
  let controllerEmpty: boolean | null = null;
  let controllerRemoved: boolean | null = null;
  let tmpfsRemoved: boolean | null = null;
  let workspaceRemoved: boolean | null = null;
  const cleanupFailures: string[] = [];
  let temporaryDataRemoved = false;
  let cleanupStatus: "pending" | "verified" | "failed" = "pending";
  let retainedController: ProbeRetainedCgroupController | null = null;
  let resultEmissionFailed = false;
  let finalQualificationResult: ProbeQualificationResult | undefined;
  let measuredResources: ProbeResourceMeasurement = {
    processCount: null,
    peakMemoryBytes: null,
    diskBytes: null,
    outputBytes: null,
  };
  const outputBudget = createProbeOutputBudget();

  try {
    container = await runUntilDeadline(
      setupAbort.signal,
      () => (options.createWorkspaceContainer ?? createProbeWorkspaceContainer)(setupAbort.signal),
      () => new ProbeTimeoutError(timeoutMs),
      true,
      startedAtMs + timeoutMs,
    );
    const boundary =
      options.networkBoundary ??
      (await runUntilDeadline(
        setupAbort.signal,
        () =>
          (
            options.createNetworkBoundary ??
            (() =>
              createProbeNetworkBoundary({
                signal: setupAbort.signal,
                timeoutMs: Math.max(1, workDeadline - now()),
              }))
          )(),
        () => new ProbeTimeoutError(timeoutMs),
        true,
        startedAtMs + timeoutMs,
      ));
    const command = buildNoNetworkProbeCommand(boundary, path.resolve(executablePath), [
      "--sqlite-foundation-probe",
    ]);
    resourceController = options.resourceController;
    if (resourceController === undefined) {
      const resourceOptions: ProbeResourceControllerOptions = {
        signal: setupAbort.signal,
        networkBoundary: boundary,
        container,
        invocationId,
      };
      resourceController = await runUntilDeadline(
        setupAbort.signal,
        () =>
          (options.createResourceController ?? createProbeResourceController)(
            container?.workspaceDirectoryPath ?? container?.directoryPath ?? "",
            resourceOptions,
          ),
        () => new ProbeTimeoutError(timeoutMs),
        true,
        startedAtMs + timeoutMs,
      );
    }
    const launch = await runUntilDeadline(
      setupAbort.signal,
      () => resourceController?.prepare(command) ?? Promise.reject(new Error()),
      () => new ProbeTimeoutError(timeoutMs),
      true,
      startedAtMs + timeoutMs,
    );
    worker = options.spawnOuter
      ? options.spawnOuter(launch.command, container)
      : spawnProbeCommand([...launch.command], {
          detached: true,
          env: createProbeOuterEnvironment(container),
          outputBudget,
          readyMarker: "READY\n",
        });
    await runUntilDeadline(
      setupAbort.signal,
      async () => {
        const ready = await worker?.ready;
        if (ready === false) {
          throw new SqliteFoundationGateError(
            "SQLite resource and network boundaries did not reach readiness.",
          );
        }
      },
      () => new ProbeTimeoutError(timeoutMs),
    );
    await runUntilDeadline(
      setupAbort.signal,
      () => resourceController?.attach(worker?.process.pid ?? -1) ?? Promise.reject(new Error()),
      () => new ProbeTimeoutError(timeoutMs),
      true,
      startedAtMs + timeoutMs,
    );
    await runUntilDeadline(
      setupAbort.signal,
      () => launch.release(worker?.process.pid),
      () => new ProbeTimeoutError(timeoutMs),
      true,
      startedAtMs + timeoutMs,
    );
    const sample = () =>
      resourceController?.sample(
        worker?.process.pid ?? -1,
        container?.workspaceDirectoryPath ?? container?.directoryPath ?? "",
        outputBudget.consumedBytes,
        result?.stdout,
        result?.stderr,
      ) ?? Promise.reject(new Error("Resource controller is unavailable."));
    measuredResources = await runUntilDeadline(
      setupAbort.signal,
      sample,
      () => new ProbeTimeoutError(timeoutMs),
    );
    const supervisionOptions: ProbeSupervisionOptions = {
      ...options,
      signal: supervisionAbort.signal,
      killWorkloadTree: () => resourceController?.kill() ?? Promise.resolve(),
      timeoutMs: Math.max(1, workDeadline - now()),
      resourceCheck: async () => {
        measuredResources = await sample();
      },
    };
    supervisionAttempted = true;
    const supervised = await superviseProbeWorkers(
      [worker as ProbeWorkerHandle],
      supervisionOptions,
    );
    result = supervised[0];
    if (result === undefined) {
      throw new SqliteFoundationGateError(
        "SQLite runtime probe returned no result; return the database choice to a human.",
      );
    }
    tmpfsRemoved = readProbeTmpfsDisposition(result.stderr);
    measuredResources = await runUntilDeadline(
      cleanupAbort.signal,
      sample,
      () => new ProbeTimeoutError(timeoutMs),
    );
  } catch (error) {
    terminalError = error;
    probeError = translateProbeError(error);
    retainedController ??= readRetainedController(error);
    if (retainedController !== null) {
      controllerEmpty = false;
      controllerRemoved = false;
      appendCleanupFailure(cleanupFailures, "retained-controller");
      cleanupStatus = "failed";
    }
    const violatingMeasurement = readViolatingMeasurement(error);
    if (violatingMeasurement !== null) measuredResources = violatingMeasurement;
    if (error instanceof ProbeWorkerFailureError && error.result?.outputExceeded) {
      measuredResources = {
        ...measuredResources,
        outputBytes: error.result.observedOutputBytes ?? outputBudget.observedBytes,
      };
    }
    if (interrupted && !deadlineExpired) {
      terminalError = new ProbeInterruptedError();
      probeError = translateProbeError(terminalError);
    }
    if (worker !== undefined && !supervisionAttempted && !cleanupAbort.signal.aborted) {
      supervisionAbort.abort();
      supervisionAttempted = true;
      try {
        await runUntilDeadline(
          cleanupAbort.signal,
          () =>
            superviseProbeWorkers([worker as ProbeWorkerHandle], {
              ...options,
              signal: supervisionAbort.signal,
              killWorkloadTree: () => resourceController?.kill() ?? Promise.resolve(),
              resourceCheck: undefined,
              timeoutMs: Math.max(1, workDeadline - now()),
            }),
          () => new ProbeTimeoutError(timeoutMs),
          false,
          startedAtMs + timeoutMs,
        );
      } catch {
        // The resource controller performs the authoritative cgroup-wide reap below.
      }
    }
  }

  if (deadlineExpired) {
    terminalError = new ProbeTimeoutError(timeoutMs);
    probeError = translateProbeError(terminalError);
  } else if (interrupted) {
    terminalError = new ProbeInterruptedError();
    probeError = translateProbeError(terminalError);
  }

  if (resourceController !== undefined) {
    try {
      await runUntilDeadline(
        cleanupAbort.signal,
        () => resourceController?.reap(cleanupAbort.signal) ?? Promise.resolve(),
        () => new ProbeTimeoutError(timeoutMs),
        false,
        startedAtMs + timeoutMs,
      );
      descendantsTerminated = true;
      descendantsReaped = true;
      controllerEmpty = true;
    } catch (error) {
      retainedController ??= readRetainedController(error);
      descendantsTerminated = false;
      descendantsReaped = false;
      controllerEmpty = false;
      tmpfsRemoved ??= null;
      appendCleanupFailure(cleanupFailures, "descendant-termination-or-reap");
      appendCleanupFailure(cleanupFailures, "controller-empty");
      if (tmpfsRemoved !== true) appendCleanupFailure(cleanupFailures, "tmpfs-removal");
      if (retainedController !== null) {
        controllerRemoved = false;
        appendCleanupFailure(cleanupFailures, "retained-controller");
      }
      cleanupStatus = "failed";
      probeError ??= translateProbeError(error);
      terminalError ??= error;
    }
  } else if (worker === undefined && retainedController === null) {
    descendantsTerminated = true;
    descendantsReaped = true;
  } else if (retainedController !== null) {
    descendantsTerminated = false;
    descendantsReaped = false;
  }

  const emit = async (phase: "pre-cleanup" | "final") => {
    if (options.emitResult === undefined) return;
    const input = (): QualificationResultInput => ({
      phase,
      invocationId,
      command: options.command,
      commit: options.commit,
      spawnCommit: options.spawnCommit,
      startedAtMs,
      now,
      measuredResources,
      result,
      terminalError,
      probeError,
      descendantsReaped,
      descendantsTerminated,
      controllerEmpty,
      controllerRemoved,
      tmpfsRemoved,
      workspaceRemoved,
      cleanupFailures,
      signal: cleanupAbort.signal,
      temporaryDataRemoved: phase === "final" && temporaryDataRemoved,
      cleanupStatus: phase === "pre-cleanup" ? "pending" : cleanupStatus,
      retainedController,
    });
    let qualificationResult: ProbeQualificationResult;
    try {
      qualificationResult = await runUntilDeadline(
        cleanupAbort.signal,
        () => buildQualificationResult(input()),
        () => new ProbeTimeoutError(timeoutMs),
      );
    } catch {
      qualificationResult = buildFallbackQualificationResult(input());
    }
    if (qualificationResult.cleanup.failures.includes("commit-helper-reap-unverified")) {
      cleanupStatus = "failed";
      appendCleanupFailure(cleanupFailures, "commit-helper-reap-unverified");
      const commitCleanupError = new SqliteFoundationGateError(
        "The Git commit helper did not confirm bounded termination and reap.",
      );
      probeError ??= commitCleanupError;
      terminalError ??= commitCleanupError;
    }
    if (phase === "final") finalQualificationResult = qualificationResult;
    const emitFallback = () => {
      resultEmissionFailed = true;
      qualificationResult = markProbeResultEmissionFailed(qualificationResult);
      if (phase === "final") finalQualificationResult = qualificationResult;
      try {
        if (options.emitResultFallback !== undefined) {
          options.emitResultFallback(qualificationResult);
        } else {
          const bounded = capDiagnosticOutput(JSON.stringify(qualificationResult)).text;
          process.stderr.write(`${bounded}\n`);
        }
      } catch {
        // The in-memory result remains truthful even if the fallback sink fails.
      }
    };
    if (cleanupAbort.signal.aborted) {
      emitFallback();
      return;
    }
    try {
      await runUntilDeadline(
        cleanupAbort.signal,
        () => options.emitResult?.(qualificationResult) ?? Promise.resolve(),
        () => new ProbeTimeoutError(timeoutMs),
      );
    } catch {
      emitFallback();
    }
  };

  try {
    await emit("pre-cleanup");
  } catch (error) {
    probeError ??= translateProbeError(error);
  }

  let resourceControllerClosed = resourceController === undefined;
  if (resourceController !== undefined && descendantsReaped) {
    try {
      await runUntilDeadline(
        cleanupAbort.signal,
        () => resourceController?.close(cleanupAbort.signal) ?? Promise.resolve(),
        () => new ProbeTimeoutError(timeoutMs),
        true,
        startedAtMs + timeoutMs,
      );
      resourceControllerClosed = true;
      controllerRemoved = true;
    } catch (error) {
      retainedController ??= readRetainedController(error);
      controllerRemoved = false;
      appendCleanupFailure(cleanupFailures, "controller-removal");
      if (retainedController !== null) appendCleanupFailure(cleanupFailures, "retained-controller");
      cleanupStatus = "failed";
    }
  } else if (resourceController !== undefined) {
    cleanupStatus = "failed";
  }
  if (container !== undefined && resourceControllerClosed && retainedController === null) {
    try {
      await runUntilDeadline(
        cleanupAbort.signal,
        () =>
          (
            options.cleanupWorkspaceContainer ??
            ((owned, signal) =>
              cleanupOwnedProbeWorkspaceContainer(owned.directoryPath, owned.capability, signal))
          )(container as ProbeWorkspaceContainer, cleanupAbort.signal),
        () => new ProbeTimeoutError(timeoutMs),
        true,
        startedAtMs + timeoutMs,
      );
      temporaryDataRemoved = true;
      workspaceRemoved = true;
    } catch {
      workspaceRemoved = false;
      cleanupFailures.push("workspace-removal");
      cleanupStatus = "failed";
    }
  } else if (container !== undefined) {
    cleanupStatus = "failed";
  }
  if (cleanupStatus !== "failed") cleanupStatus = "verified";
  if (cleanupStatus === "failed") {
    const cleanupError = new SqliteFoundationGateError(
      "SQLite integrity probe cleanup could not be verified; return the database choice to a human.",
    );
    probeError ??= cleanupError;
    terminalError ??= cleanupError;
  }
  if (interrupted && !deadlineExpired) {
    terminalError = new ProbeInterruptedError();
    probeError = translateProbeError(terminalError);
  }
  try {
    await emit("final");
  } catch (error) {
    probeError ??= translateProbeError(error);
  }
  if (resultEmissionFailed) {
    probeError ??= new SqliteFoundationGateError(
      "SQLite integrity probe result emission could not be completed within the total deadline.",
    );
  }
  clearTotalTimeout(workTimer);
  clearTotalTimeout(hardTimer);
  removeCallerAbort();
  setupAbort.abort();
  cleanupAbort.abort();
  signalScope?.cleanup();

  if (probeError !== undefined) throw probeError;
  if (result === undefined) {
    throw new SqliteFoundationGateError(
      "SQLite runtime probe returned no result; return the database choice to a human.",
    );
  }
  return {
    ...result,
    qualificationResult:
      finalQualificationResult ??
      buildFallbackQualificationResult({
        phase: "final",
        invocationId,
        command: options.command,
        commit: options.commit,
        spawnCommit: options.spawnCommit,
        startedAtMs,
        now,
        measuredResources,
        result,
        terminalError: undefined,
        probeError: undefined,
        descendantsReaped,
        descendantsTerminated,
        controllerEmpty,
        controllerRemoved,
        tmpfsRemoved,
        workspaceRemoved,
        cleanupFailures,
        signal: cleanupAbort.signal,
        temporaryDataRemoved,
        cleanupStatus,
        retainedController,
      }),
  };
}

async function runUntilDeadline<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
  timeoutError: () => Error,
  reconcile = false,
  hardDeadlineMs = Number.POSITIVE_INFINITY,
): Promise<T> {
  if (signal.aborted) throw timeoutError();
  const operationPromise = Promise.resolve().then(operation);
  let removeAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(timeoutError());
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([operationPromise, aborted]);
  } catch (error) {
    if (reconcile) {
      const reconciliationMs = Math.min(250, Math.max(0, hardDeadlineMs - Date.now()));
      if (reconciliationMs > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const reconciliationTimeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, reconciliationMs);
        });
        await Promise.race([
          operationPromise.then(
            () => undefined,
            () => undefined,
          ),
          reconciliationTimeout,
        ]);
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    throw error;
  } finally {
    removeAbort();
  }
}

function readViolatingMeasurement(error: unknown): ProbeResourceMeasurement | null {
  if (typeof error !== "object" || error === null || !("measurement" in error)) return null;
  const measurement = (error as { measurement?: unknown }).measurement;
  if (typeof measurement !== "object" || measurement === null) return null;
  const value = measurement as Record<string, unknown>;
  if (
    !isNullableMeasurementValue(value.processCount) ||
    !isNullableMeasurementValue(value.peakMemoryBytes) ||
    !isNullableMeasurementValue(value.diskBytes) ||
    !isNullableMeasurementValue(value.outputBytes)
  ) {
    return null;
  }
  return {
    processCount: value.processCount,
    peakMemoryBytes: value.peakMemoryBytes,
    diskBytes: value.diskBytes,
    outputBytes: value.outputBytes,
  };
}

function isNullableMeasurementValue(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function readRetainedController(error: unknown): ProbeRetainedCgroupController | null {
  if (typeof error !== "object" || error === null || !("retainedController" in error)) {
    return null;
  }
  const retainedController = (error as { retainedController?: unknown }).retainedController;
  if (
    typeof retainedController !== "object" ||
    retainedController === null ||
    !Array.isArray((retainedController as { retainedPaths?: unknown }).retainedPaths)
  ) {
    return null;
  }
  const value = retainedController as Record<string, unknown>;
  if (
    typeof value.rootPath !== "string" ||
    typeof value.helperPath !== "string" ||
    typeof value.workloadPath !== "string" ||
    typeof value.markerPath !== "string" ||
    !(value.retainedPaths as unknown[]).every((pathValue) => typeof pathValue === "string")
  ) {
    return null;
  }
  return {
    rootPath: value.rootPath,
    helperPath: value.helperPath,
    workloadPath: value.workloadPath,
    markerPath: value.markerPath,
    retainedPaths: [...(value.retainedPaths as string[])],
  };
}

function appendCleanupFailure(failures: string[], failure: string): void {
  if (!failures.includes(failure)) failures.push(failure);
}
