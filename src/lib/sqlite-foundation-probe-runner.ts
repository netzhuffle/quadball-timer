import {
  DockerAdmissionError,
  type DockerAdmissionDisposition,
  DockerCleanupError,
  createDockerProbeExecution,
  DockerExecutionError,
  DockerResourceLimitError,
  type DockerProbeDependencies,
  type DockerProbeExecution,
} from "@/lib/sqlite-foundation-probe-docker";
import {
  SQLITE_FOUNDATION_PROBE_CLEANUP_RESERVE_MS,
  SQLITE_FOUNDATION_PROBE_TIMEOUT_MS,
  ProbeInterruptedError,
  ProbeTimeoutError,
  type ProbeWorkerResult,
} from "@/lib/sqlite-foundation-probe-process";
import type {
  ProbeQualificationResult,
  ProbeResourceMeasurement,
} from "@/lib/sqlite-foundation-probe-result";
import {
  SqliteFoundationGateError,
  translateProbeError,
} from "@/lib/sqlite-foundation-probe-errors";
import { markProbeResultEmissionFailed } from "@/lib/sqlite-foundation-probe-evidence";
import {
  buildFallbackQualificationResult,
  buildQualificationResult,
} from "@/lib/sqlite-foundation-probe-runner-evidence";

export type CompiledSqliteFoundationProbeOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  docker?: DockerProbeDependencies;
  createExecution?: (
    executablePath: string,
    signal?: AbortSignal,
    cleanupSignal?: AbortSignal,
  ) => Promise<DockerProbeExecution>;
  command?: string;
  commit?: string | ((signal?: AbortSignal) => string | Promise<string>);
  now?: () => number;
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
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  const invocationId = crypto.randomUUID();
  const timeoutMs = options.timeoutMs ?? SQLITE_FOUNDATION_PROBE_TIMEOUT_MS;
  const workAbort = new AbortController();
  const hardAbort = new AbortController();
  const removeCallerSignal = forwardAbort(options.signal, workAbort);
  const cleanupReserveMs = Math.min(
    SQLITE_FOUNDATION_PROBE_CLEANUP_RESERVE_MS,
    Math.floor(timeoutMs / 2),
  );
  const workTimer = setTimeout(() => workAbort.abort(), Math.max(1, timeoutMs - cleanupReserveMs));
  const hardTimer = setTimeout(() => hardAbort.abort(), timeoutMs);
  let execution: DockerProbeExecution | undefined;
  let result: ProbeWorkerResult | undefined;
  let terminalError: unknown;
  let probeError: SqliteFoundationGateError | undefined;
  let interrupted = false;
  let timedOut = false;
  let descendantsTerminated: boolean | null = null;
  let descendantsReaped = false;
  let containerIdentityVerified: boolean | null = null;
  let containerRemoved: boolean | null = null;
  let temporaryDataRemoved = false;
  let cleanupStatus: "pending" | "verified" | "failed" = "pending";
  let lateAdmissionDisposition: DockerAdmissionDisposition | undefined;
  const cleanupFailures: string[] = [];
  let evidenceEmission: "pending" | "verified" | "failed" = "pending";
  const evidenceFailures: string[] = [];
  let measuredResources: ProbeResourceMeasurement = {
    processCount: null,
    peakMemoryBytes: null,
    diskBytes: null,
    outputBytes: null,
  };
  const emitted: ProbeQualificationResult[] = [];

  try {
    const admission = options.createExecution
      ? options.createExecution(executablePath, workAbort.signal, hardAbort.signal)
      : createDockerProbeExecution(executablePath, {
          ...options.docker,
          invocationId,
          signal: workAbort.signal,
          cleanupSignal: hardAbort.signal,
        });
    try {
      execution = await raceWithAbort(
        admission,
        workAbort.signal,
        new ProbeTimeoutError(timeoutMs),
      );
    } catch (admissionError) {
      try {
        execution = await raceWithAbort(
          admission,
          hardAbort.signal,
          new ProbeTimeoutError(timeoutMs),
        );
      } catch (lateAdmissionError) {
        if (lateAdmissionError instanceof DockerAdmissionError) {
          lateAdmissionDisposition = lateAdmissionError.disposition;
        }
        // The production admission path owns late create discovery and cleanup.
      }
      throw admissionError;
    }
    result = await raceWithAbort(
      execution.run(workAbort.signal),
      workAbort.signal,
      new ProbeTimeoutError(timeoutMs),
    );
    descendantsTerminated = true;
    descendantsReaped = true;
    measuredResources = readMeasurement(result);
  } catch (error) {
    terminalError = error;
    interrupted = options.signal?.aborted === true;
    timedOut = !interrupted && (workAbort.signal.aborted || hardAbort.signal.aborted);
    if (execution !== undefined) {
      try {
        await execution.stop(hardAbort.signal);
        descendantsTerminated = true;
        descendantsReaped = true;
      } catch {
        cleanupFailures.push("descendant-termination");
      }
    } else {
      descendantsTerminated = null;
      descendantsReaped = false;
    }
    if (error instanceof Error && "measurement" in error)
      measuredResources = (error as { measurement: ProbeResourceMeasurement }).measurement;
    if (error instanceof DockerExecutionError && error.result !== undefined) {
      result = error.result;
      measuredResources = readMeasurement(error.result);
    }
    if (error instanceof DockerResourceLimitError) {
      result = error.result;
      measuredResources = error.measurement;
    }
    probeError = translateProbeError(
      timedOut
        ? new ProbeTimeoutError(timeoutMs)
        : interrupted
          ? new ProbeInterruptedError()
          : error,
    );
  }
  if (timedOut) {
    terminalError = new ProbeTimeoutError(timeoutMs);
    probeError = translateProbeError(terminalError);
  } else if (interrupted) {
    terminalError = new ProbeInterruptedError();
    probeError = translateProbeError(terminalError);
  }

  await emitResult("pre-cleanup");
  if (execution !== undefined) {
    try {
      const cleanup = await raceWithAbort(
        execution.cleanup(hardAbort.signal),
        hardAbort.signal,
        new ProbeTimeoutError(timeoutMs),
      );
      containerIdentityVerified = cleanup.identityVerified;
      containerRemoved = cleanup.removed;
      descendantsTerminated = cleanup.descendantsTerminated ?? descendantsTerminated;
      descendantsReaped = cleanup.descendantsReaped ?? descendantsReaped;
      temporaryDataRemoved = cleanup.temporaryDataRemoved ?? cleanup.removed;
      cleanupStatus = cleanup.removed ? "verified" : "failed";
    } catch (error) {
      containerIdentityVerified = error instanceof DockerCleanupError ? true : false;
      containerRemoved = false;
      cleanupFailures.push("container-cleanup");
      cleanupStatus = "failed";
      probeError ??= translateProbeError(error);
    }
  } else {
    const admissionDisposition: DockerAdmissionDisposition =
      lateAdmissionDisposition ??
      (terminalError instanceof DockerAdmissionError ? terminalError.disposition : "unverified");
    if (admissionDisposition === "removed") {
      containerIdentityVerified = true;
      containerRemoved = true;
    }
    cleanupStatus = admissionDisposition === "unverified" ? "failed" : "verified";
    temporaryDataRemoved = admissionDisposition !== "unverified";
    if (admissionDisposition === "unverified") cleanupFailures.push("container-cleanup");
  }
  if (cleanupStatus === "failed")
    probeError ??= new SqliteFoundationGateError(
      "SQLite qualification cleanup could not be verified.",
    );
  await emitResult("final");
  clearTimeout(workTimer);
  clearTimeout(hardTimer);
  removeCallerSignal();
  hardAbort.abort();
  workAbort.abort();
  if (probeError !== undefined) throw probeError;
  if (result === undefined)
    throw new SqliteFoundationGateError("SQLite qualification returned no result.");
  return {
    ...result,
    qualificationResult: emitted.at(-1) ?? buildFallbackQualificationResult(buildInput("final")),
  };

  async function emitResult(phase: "pre-cleanup" | "final"): Promise<void> {
    evidenceEmission = "verified";
    let qualificationResult: ProbeQualificationResult;
    try {
      qualificationResult = await raceWithAbort(
        buildQualificationResult(buildInput(phase)),
        hardAbort.signal,
        new ProbeTimeoutError(timeoutMs),
      );
    } catch {
      qualificationResult = buildFallbackQualificationResult(buildInput(phase));
    }
    emitted.push(qualificationResult);
    try {
      if (options.emitResult !== undefined)
        await raceWithAbort(
          Promise.resolve(options.emitResult(qualificationResult)),
          hardAbort.signal,
          new ProbeTimeoutError(timeoutMs),
        );
    } catch {
      evidenceEmission = "failed";
      evidenceFailures.push("result-emission");
      probeError ??= new SqliteFoundationGateError(
        "SQLite qualification result emission could not be completed within the hard deadline.",
      );
      const fallback = markProbeResultEmissionFailed(qualificationResult);
      emitted[emitted.length - 1] = fallback;
      try {
        options.emitResultFallback?.(fallback);
      } catch {
        // The bounded in-memory result remains the final evidence.
      }
      return;
    }
  }

  function buildInput(phase: "pre-cleanup" | "final") {
    return {
      phase,
      invocationId,
      command: options.command,
      commit: options.commit,
      startedAtMs,
      now,
      measuredResources,
      result,
      terminalError,
      probeError,
      descendantsReaped,
      descendantsTerminated,
      containerIdentityVerified,
      containerRemoved,
      cleanupFailures,
      temporaryDataRemoved,
      cleanupStatus,
      evidenceEmission,
      evidenceFailures,
      signal: hardAbort.signal,
    };
  }
}

function forwardAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (source === undefined) return () => {};
  const abort = () => target.abort();
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutError: Error,
): Promise<T> {
  if (signal.aborted) throw timeoutError;
  let remove = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(timeoutError);
    signal.addEventListener("abort", onAbort, { once: true });
    remove = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([operation, aborted]);
  } catch (error) {
    void operation.catch(() => {});
    throw error;
  } finally {
    remove();
  }
}

function readMeasurement(result: ProbeWorkerResult): ProbeResourceMeasurement {
  return (
    result.measurement ?? {
      processCount: null,
      peakMemoryBytes: null,
      diskBytes: null,
      outputBytes: result.stdoutBytes + result.stderrBytes,
    }
  );
}
