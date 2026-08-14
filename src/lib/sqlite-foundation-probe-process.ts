import path from "node:path";
import type { ProbeResourceMeasurement } from "@/lib/sqlite-foundation-probe-result";
import { createProbeReadiness } from "@/lib/sqlite-foundation-probe-readiness";

export const SQLITE_FOUNDATION_PROBE_TIMEOUT_MS = 15_000;
export const SQLITE_FOUNDATION_PROBE_INNER_TIMEOUT_MS = 5_000;
export const SQLITE_FOUNDATION_PROBE_TERMINATION_GRACE_MS = 250;
export const SQLITE_FOUNDATION_PROBE_REAP_TIMEOUT_MS = 1_000;
export const SQLITE_FOUNDATION_PROBE_CLEANUP_RESERVE_MS = 5_000;
export const SQLITE_FOUNDATION_PROBE_MAX_OUTPUT_BYTES = 4 * 1024;
export const SQLITE_FOUNDATION_PROBE_MAX_PROCESS_COUNT = 7;
export const SQLITE_FOUNDATION_PROBE_SHARED_GROUP_ENV = "QUADBALL_TIMER_SQLITE_PROBE_SHARED_GROUP";

export type ProbeProcess = {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly killed: boolean;
  readonly exited: Promise<number>;
  readonly processGroupId?: number;
  readonly processGroupOwned?: boolean;
  kill(signal?: NodeJS.Signals): void;
};

type SpawnedProbeProcess = ProbeProcess & {
  readonly stdout: ReadableStream<Uint8Array<ArrayBuffer>>;
  readonly stderr: ReadableStream<Uint8Array<ArrayBuffer>>;
};

export type ProbeWorkerResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  outputExceeded: boolean;
  observedOutputBytes?: number;
};

export type ProbeOutputBudget = {
  readonly maximumBytes: number;
  readonly consumedBytes: number;
  readonly observedBytes: number;
  readonly exceeded: boolean;
  consume(bytes: number): number;
};

export type ProbeWorkerHandle = {
  process: ProbeProcess;
  result: Promise<ProbeWorkerResult>;
  ready?: Promise<boolean>;
};

type ProbeTimerHandle = number | NodeJS.Timeout;

export type ProbeSupervisionOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  terminationGraceMs?: number;
  reapTimeoutMs?: number;
  scheduleTimeout?: (callback: () => void, milliseconds: number) => ProbeTimerHandle;
  clearTimeout?: (handle: ProbeTimerHandle) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  signalProcessGroup?: (pid: number, signal: NodeJS.Signals) => boolean;
  killWorkloadTree?: () => Promise<void>;
  resourceCheck?: () => Promise<void>;
  resourcePollMs?: number;
};

export type ProbeSpawnOptions = {
  detached?: boolean;
  env?: Record<string, string>;
  processGroupId?: number;
  outputBudget?: ProbeOutputBudget;
  readyMarker?: string;
};

export function createProbeOutputBudget(
  maximumBytes = SQLITE_FOUNDATION_PROBE_MAX_OUTPUT_BYTES,
): ProbeOutputBudget {
  let consumedBytes = 0;
  let observedBytes = 0;
  let exceeded = false;
  return {
    maximumBytes,
    get consumedBytes() {
      return consumedBytes;
    },
    get observedBytes() {
      return observedBytes;
    },
    get exceeded() {
      return exceeded;
    },
    consume(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        exceeded = true;
        return 0;
      }
      observedBytes += bytes;
      const remaining = Math.max(0, maximumBytes - consumedBytes);
      consumedBytes = Math.min(maximumBytes, consumedBytes + bytes);
      if (bytes > remaining) exceeded = true;
      return Math.min(bytes, remaining);
    },
  };
}

export function capDiagnosticOutput(
  value: string,
  maximumBytes = SQLITE_FOUNDATION_PROBE_MAX_OUTPUT_BYTES,
): { text: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maximumBytes) {
    return { text: value, truncated: false };
  }

  return {
    text: new TextDecoder().decode(encoded.slice(0, maximumBytes)),
    truncated: true,
  };
}

export async function terminateProbeWorkers(
  workers: readonly ProbeWorkerHandle[],
  options: Pick<
    ProbeSupervisionOptions,
    | "terminationGraceMs"
    | "reapTimeoutMs"
    | "sleep"
    | "scheduleTimeout"
    | "clearTimeout"
    | "signalProcessGroup"
    | "killWorkloadTree"
  > = {},
): Promise<void> {
  const signalProcessGroup = options.signalProcessGroup ?? signalProbeProcessGroup;
  const sleep = options.sleep ?? Bun.sleep;
  const terminationGraceMs =
    options.terminationGraceMs ?? SQLITE_FOUNDATION_PROBE_TERMINATION_GRACE_MS;
  const reapTimeoutMs = options.reapTimeoutMs ?? SQLITE_FOUNDATION_PROBE_REAP_TIMEOUT_MS;

  signalWorkers(workers, "SIGTERM", signalProcessGroup);
  const allExited = Promise.allSettled(workers.map((worker) => worker.process.exited)).then(
    () => true,
  );
  const exitedBeforeGrace = await waitForPromise(allExited, terminationGraceMs, sleep);
  if (!exitedBeforeGrace) {
    const killWorkloadTree = options.killWorkloadTree;
    if (killWorkloadTree !== undefined) {
      await killWorkloadTree();
    }
    signalWorkers(workers, "SIGKILL", signalProcessGroup);
    const reapedAfterKill = await waitForPromise(allExited, reapTimeoutMs, sleep);
    if (!reapedAfterKill) {
      throw new ProbeReapTimeoutError(reapTimeoutMs);
    }
  }
}

export async function superviseProbeWorkers(
  workers: readonly ProbeWorkerHandle[],
  options: ProbeSupervisionOptions = {},
): Promise<ProbeWorkerResult[]> {
  if (workers.length === 0) {
    return [];
  }
  if (workers.length > SQLITE_FOUNDATION_PROBE_MAX_PROCESS_COUNT) {
    throw new ProbeResourceLimitError("process count");
  }

  const scheduleTimeout = options.scheduleTimeout ?? setTimeout;
  const clearTimeout = options.clearTimeout ?? globalThis.clearTimeout;
  const sleep = options.sleep ?? Bun.sleep;
  const timeoutMs = options.timeoutMs ?? SQLITE_FOUNDATION_PROBE_TIMEOUT_MS;
  const reapTimeoutMs = options.reapTimeoutMs ?? SQLITE_FOUNDATION_PROBE_REAP_TIMEOUT_MS;
  const results: ProbeWorkerResult[] = [];
  let remaining = workers.length;
  let resolveCompletion: ((value: ProbeWorkerResult[]) => void) | undefined;
  let rejectCompletion: ((reason: unknown) => void) | undefined;
  const completion = new Promise<ProbeWorkerResult[]>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  let resourceTimer: ProbeTimerHandle | undefined;
  let resourceCheckStopped = false;
  const resourceFailure = new Promise<never>((_, reject) => {
    const poll = () => {
      if (resourceCheckStopped || options.resourceCheck === undefined) return;
      void options.resourceCheck().then(
        () => {
          if (!resourceCheckStopped) {
            resourceTimer = scheduleTimeout(poll, options.resourcePollMs ?? 25);
          }
        },
        (error) => reject(error),
      );
    };
    if (options.resourceCheck !== undefined) {
      resourceTimer = scheduleTimeout(poll, options.resourcePollMs ?? 25);
    }
  });

  workers.forEach((worker, index) => {
    worker.result.then(
      (result) => {
        results[index] = result;
        if (result.exitCode !== 0 || result.outputExceeded) {
          rejectCompletion?.(new ProbeWorkerFailureError(index, result));
          return;
        }

        remaining -= 1;
        if (remaining === 0) {
          resolveCompletion?.(results);
        }
      },
      () => rejectCompletion?.(new ProbeWorkerFailureError(index)),
    );
  });

  let timeoutHandle: ProbeTimerHandle | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = scheduleTimeout(() => reject(new ProbeTimeoutError(timeoutMs)), timeoutMs);
  });
  let removeAbortListener: () => void = () => {};
  const interruption = new Promise<never>((_, reject) => {
    const signal = options.signal;
    if (signal === undefined) {
      return;
    }
    const rejectOnAbort = () => reject(new ProbeInterruptedError());
    if (signal.aborted) {
      rejectOnAbort();
      return;
    }
    signal.addEventListener("abort", rejectOnAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", rejectOnAbort);
  });

  let operationResult: ProbeWorkerResult[] | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    operationResult = await Promise.race([completion, timeout, interruption, resourceFailure]);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  if (timeoutHandle !== undefined) {
    clearTimeout(timeoutHandle);
  }
  resourceCheckStopped = true;
  if (resourceTimer !== undefined) clearTimeout(resourceTimer);
  removeAbortListener();

  let terminationError: unknown;
  if (operationFailed) {
    try {
      await terminateProbeWorkers(workers, options);
    } catch (error) {
      terminationError = error;
    }
  }

  const resultsSettled = Promise.allSettled(workers.map((worker) => worker.result));
  const reaped = await waitForPromise(resultsSettled, reapTimeoutMs, sleep);
  if (terminationError !== undefined) {
    throw terminationError;
  }
  if (!reaped) {
    throw new ProbeReapTimeoutError(reapTimeoutMs);
  }
  if (operationFailed) {
    throw operationError;
  }
  if (operationResult === undefined) {
    throw new ProbeReapTimeoutError(reapTimeoutMs);
  }
  return operationResult;
}

export function spawnProbeWorker(
  executablePath: string,
  workerFlag: "--sqlite-foundation-probe-writer" | "--sqlite-foundation-probe-checkpoint",
  arguments_: string[],
  options: ProbeSpawnOptions = {},
): ProbeWorkerHandle {
  const command = buildProbeWorkerCommand(executablePath, workerFlag, arguments_);
  const shareProcessGroup = process.env[SQLITE_FOUNDATION_PROBE_SHARED_GROUP_ENV] === "1";
  return spawnProbeCommand(command, {
    ...options,
    detached: !shareProcessGroup,
    processGroupId: shareProcessGroup ? process.pid : undefined,
  });
}

export function buildProbeWorkerCommand(
  executablePath: string,
  workerFlag: "--sqlite-foundation-probe-writer" | "--sqlite-foundation-probe-checkpoint",
  arguments_: readonly string[],
  runtimeArguments: readonly string[] = process.argv.slice(1),
): string[] {
  const sourceEntrypoint = runtimeArguments.find(
    (argument) => isSourceEntrypointArgument(argument) && !isBunVirtualEntrypoint(argument),
  );
  return sourceEntrypoint === undefined
    ? [executablePath, workerFlag, ...arguments_]
    : [executablePath, sourceEntrypoint, workerFlag, ...arguments_];
}

export function spawnProbeCommand(
  command: string[],
  options: ProbeSpawnOptions = {},
): ProbeWorkerHandle {
  const detached = options.detached ?? true;
  const child = Bun.spawn(command, {
    detached,
    stdout: "pipe",
    stderr: "pipe",
    maxBuffer: SQLITE_FOUNDATION_PROBE_MAX_OUTPUT_BYTES,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const processHandle: SpawnedProbeProcess = {
    pid: child.pid,
    processGroupId: options.processGroupId ?? (detached ? child.pid : undefined),
    get exitCode() {
      return child.exitCode;
    },
    get killed() {
      return child.killed;
    },
    get exited() {
      return child.exited;
    },
    processGroupOwned: detached,
    kill(signal) {
      child.kill(signal);
    },
    stdout: child.stdout,
    stderr: child.stderr,
  };
  const readiness = createProbeReadiness(options.readyMarker);
  return {
    process: processHandle,
    result: collectProbeWorkerResult(processHandle, options, readiness.observe, readiness.finish),
    ready: readiness.ready,
  };
}

export function installProbeSignalHandlers(): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const abort = () => controller.abort();
  for (const signal of signals) {
    process.on(signal, abort);
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const signal of signals) {
        process.off(signal, abort);
      }
    },
  };
}

export function readSingleValueFromWorker(output: string, key: string): string | null {
  try {
    const payload = JSON.parse(output.trim()) as Record<string, unknown>;
    const value = payload[key];
    return value === undefined
      ? null
      : typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : JSON.stringify(value);
  } catch {
    return null;
  }
}

async function collectProbeWorkerResult(
  child: SpawnedProbeProcess,
  options: ProbeSpawnOptions,
  observeOutput: (bytes: Uint8Array) => void,
  finishReadiness: () => void,
): Promise<ProbeWorkerResult> {
  let outputExceeded = false;
  const markOutputExceeded = () => {
    if (outputExceeded) {
      return;
    }
    outputExceeded = true;
    signalProbeProcess(child, "SIGTERM");
  };
  const [stdout, stderr] = await Promise.all([
    readCappedStream(child.stdout, markOutputExceeded, options.outputBudget, observeOutput),
    readCappedStream(child.stderr, markOutputExceeded, options.outputBudget, observeOutput),
  ]);
  finishReadiness();
  const exitCode = await child.exited;
  return {
    exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutBytes: stdout.byteLength,
    stderrBytes: stderr.byteLength,
    outputExceeded:
      outputExceeded ||
      stdout.truncated ||
      stderr.truncated ||
      options.outputBudget?.exceeded === true,
    observedOutputBytes:
      options.outputBudget?.observedBytes ?? stdout.byteLength + stderr.byteLength,
  };
}

async function readCappedStream(
  stream: ReadableStream<Uint8Array<ArrayBuffer>>,
  onExceeded: () => void,
  outputBudget?: ProbeOutputBudget,
  observeOutput?: (bytes: Uint8Array) => void,
): Promise<{ text: string; truncated: boolean; byteLength: number }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      observeOutput?.(value);
      const budgetRemaining = outputBudget
        ? outputBudget.maximumBytes - outputBudget.consumedBytes
        : SQLITE_FOUNDATION_PROBE_MAX_OUTPUT_BYTES - byteLength;
      const acceptedBytes = outputBudget?.consume(value.byteLength) ?? value.byteLength;
      const remaining = Math.min(
        SQLITE_FOUNDATION_PROBE_MAX_OUTPUT_BYTES - byteLength,
        budgetRemaining,
      );
      if (remaining <= 0) {
        truncated = true;
        onExceeded();
        await reader.cancel();
        break;
      }
      if (value.byteLength > remaining || acceptedBytes < value.byteLength) {
        chunks.push(value.slice(0, remaining));
        byteLength += remaining;
        truncated = true;
        onExceeded();
        await reader.cancel();
        break;
      }
      chunks.push(value);
      byteLength += value.byteLength;
    }
  } catch {
    truncated = true;
    onExceeded();
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    text: new TextDecoder().decode(combined),
    truncated,
    byteLength,
  };
}

function signalWorkers(
  workers: readonly ProbeWorkerHandle[],
  signal: NodeJS.Signals,
  signalProcessGroup: (pid: number, signal: NodeJS.Signals) => boolean,
): void {
  const signaledGroups = new Set<number>();
  for (const worker of workers) {
    if (
      worker.process.processGroupOwned === undefined &&
      (worker.process.exitCode !== null || worker.process.killed)
    ) {
      continue;
    }
    const processGroupId = getProcessGroupId(worker.process);
    if (processGroupId !== null) {
      if (signaledGroups.has(processGroupId)) {
        continue;
      }
      signaledGroups.add(processGroupId);
      if (!signalProcessGroup(processGroupId, signal)) {
        if (worker.process.exitCode === null && !worker.process.killed) {
          worker.process.kill(signal);
        }
      }
      continue;
    }

    if (worker.process.processGroupOwned === false) {
      if (worker.process.exitCode === null && !worker.process.killed) {
        worker.process.kill(signal);
      }
      continue;
    }

    if (!signalProcessGroup(worker.process.pid, signal)) {
      if (worker.process.exitCode === null && !worker.process.killed) {
        worker.process.kill(signal);
      }
    }
  }
}

function signalProbeProcess(child: ProbeProcess, signal: NodeJS.Signals): void {
  const processGroupId = getProcessGroupId(child);
  if (processGroupId !== null) {
    if (
      !signalProbeProcessGroup(processGroupId, signal) &&
      child.exitCode === null &&
      !child.killed
    ) {
      child.kill(signal);
    }
    return;
  }
  if (child.processGroupOwned === false) {
    if (child.exitCode === null && !child.killed) {
      child.kill(signal);
    }
    return;
  }
  if (!signalProbeProcessGroup(child.pid, signal) && child.exitCode === null && !child.killed) {
    child.kill(signal);
  }
}

function getProcessGroupId(processHandle: ProbeProcess): number | null {
  if (processHandle.processGroupId !== undefined) {
    return processHandle.processGroupId;
  }
  if (processHandle.processGroupOwned === true) {
    return processHandle.pid;
  }
  return null;
}

function signalProbeProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  if (process.platform === "win32") {
    return false;
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function waitForPromise(
  promise: Promise<unknown>,
  timeoutMs: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    const completed = await Promise.race([
      promise.then(() => true),
      sleep(timeoutMs).then(() => false),
    ]);
    if (completed) {
      return true;
    }

    for (let attempt = 0; attempt < 3 && !settled; attempt += 1) {
      await Promise.resolve();
    }
    return settled;
  } catch {
    return false;
  }
}

function isSourceEntrypointArgument(argument: string): boolean {
  const extension = path.extname(argument);
  return extension === ".ts" || extension === ".js" || extension === ".mjs";
}

function isBunVirtualEntrypoint(argument: string): boolean {
  const normalized = argument.replaceAll("\\", "/");
  return /(?:^|\/)(?:\$bunfs|~bun)(?:\/|$)/i.test(normalized);
}

export class ProbeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`SQLite integrity probe timed out after ${timeoutMs}ms; descendants were terminated.`);
    this.name = "ProbeTimeoutError";
  }
}

export class ProbeInterruptedError extends Error {
  constructor() {
    super("SQLite integrity probe was interrupted; descendants were terminated.");
    this.name = "ProbeInterruptedError";
  }
}

export class ProbeReapTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`SQLite integrity probe descendants were not reaped within ${timeoutMs}ms.`);
    this.name = "ProbeReapTimeoutError";
  }
}

export class ProbeWorkerFailureError extends Error {
  readonly result: ProbeWorkerResult | undefined;

  constructor(index: number, result?: ProbeWorkerResult) {
    const diagnostics = result === undefined ? "" : ` ${formatProbeWorkerDiagnostics(result)}`;
    super(
      result?.outputExceeded
        ? `SQLite integrity probe worker ${index} exceeded its diagnostic output limit.${diagnostics}`
        : `SQLite integrity probe worker ${index} exited unsuccessfully.${diagnostics}`,
    );
    this.name = "ProbeWorkerFailureError";
    this.result = result;
  }
}

export class ProbeResourceLimitError extends Error {
  readonly measurement: ProbeResourceMeasurement | null;

  constructor(resource: string, measurement: ProbeResourceMeasurement | null = null) {
    super(`SQLite integrity probe exceeded its ${resource} limit.`);
    this.name = "ProbeResourceLimitError";
    this.measurement = measurement;
  }
}

function formatProbeWorkerDiagnostics(result: ProbeWorkerResult): string {
  const perStreamBytes = Math.floor((SQLITE_FOUNDATION_PROBE_MAX_OUTPUT_BYTES - 128) / 2);
  const stdout = sanitizeProbeDiagnostic(result.stdout, perStreamBytes);
  const stderr = sanitizeProbeDiagnostic(result.stderr, perStreamBytes);
  return capDiagnosticOutput(
    `Diagnostics: stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
  ).text;
}

function sanitizeProbeDiagnostic(value: string, maximumBytes: number): string {
  const redacted = value
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{0,4}){0,3}(?:-[0-9a-f]{0,12})?/gi, "<capability>")
    .replace(/"(?:[A-Z]:[\\/]|\/)[^"\r\n]*"/gi, '"<path>"')
    .replace(/'(?:[A-Z]:[\\/]|\/)[^'\r\n]*'/gi, "'<path>'")
    .replace(/`(?:[A-Z]:[\\/]|\/)[^`\r\n]*`/gi, "`<path>`")
    .replace(/\b[A-Z]:[\\/][^\s"'`]+/gi, "<path>")
    .replace(/\/[^\s"'`]+/g, "<path>");
  const printable = Array.from(redacted, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (codePoint >= 0 && codePoint <= 8) ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      codePoint === 127
      ? "?"
      : character;
  }).join("");
  return capDiagnosticOutput(printable, maximumBytes).text;
}
