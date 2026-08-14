import {
  SQLITE_FOUNDATION_PROBE_COMMAND,
  type ProbeOutcome,
  type ProbeQualificationResult,
  type ProbeResourceMeasurement,
} from "@/lib/sqlite-foundation-probe-result";
import {
  boundedProbeQualificationResult,
  capProbeEvidenceString,
  retainedControllerEvidence,
} from "@/lib/sqlite-foundation-probe-evidence";
import {
  ProbeInterruptedError,
  ProbeTimeoutError,
  type ProbeWorkerResult,
} from "@/lib/sqlite-foundation-probe-process";
import type { SqliteFoundationGateError } from "@/lib/sqlite-foundation-probe-errors";
import type { ProbeRetainedCgroupController } from "@/lib/sqlite-foundation-probe-cgroup";

export type QualificationResultInput = {
  phase: "pre-cleanup" | "final";
  invocationId: string;
  command: string | undefined;
  commit: string | ((signal?: AbortSignal) => string | Promise<string>) | undefined;
  spawnCommit?: (signal?: AbortSignal) => ProbeCommitChild;
  startedAtMs: number;
  now: () => number;
  measuredResources: ProbeResourceMeasurement;
  result: ProbeWorkerResult | undefined;
  terminalError: unknown;
  probeError: SqliteFoundationGateError | undefined;
  descendantsReaped: boolean;
  descendantsTerminated: boolean | null;
  controllerEmpty: boolean | null;
  controllerRemoved: boolean | null;
  tmpfsRemoved: boolean | null;
  workspaceRemoved: boolean | null;
  cleanupFailures: string[];
  temporaryDataRemoved: boolean;
  cleanupStatus: "pending" | "verified" | "failed";
  retainedController: ProbeRetainedCgroupController | null;
  retainedControllerUnverified?: boolean;
  signal: AbortSignal;
};

export type ProbeCommitChild = {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: (signal: NodeJS.Signals) => void;
};

export class ProbeCommitCleanupError extends Error {
  constructor() {
    super("The Git commit helper did not confirm bounded termination and reap.");
    this.name = "ProbeCommitCleanupError";
  }
}

export async function buildQualificationResult(
  input: QualificationResultInput,
): Promise<ProbeQualificationResult> {
  try {
    return boundedProbeQualificationResult(
      createQualificationResult(
        input,
        await resolveProbeCommit(input.commit, input.signal, input.spawnCommit),
      ),
    );
  } catch (error) {
    if (!(error instanceof ProbeCommitCleanupError)) throw error;
    return boundedProbeQualificationResult(
      createQualificationResult(
        {
          ...input,
          cleanupFailures: [...input.cleanupFailures, "commit-helper-reap-unverified"],
          cleanupStatus: "failed",
          descendantsTerminated: null,
          descendantsReaped: false,
          retainedControllerUnverified: false,
        },
        "unknown",
      ),
    );
  }
}

export function buildFallbackQualificationResult(
  input: QualificationResultInput,
): ProbeQualificationResult {
  return boundedProbeQualificationResult(createQualificationResult(input, "unknown"));
}

function createQualificationResult(
  input: QualificationResultInput,
  commit: string,
): ProbeQualificationResult {
  const controllerEvidence = retainedControllerEvidence(
    input.retainedController,
    input.retainedControllerUnverified ??
      (input.cleanupStatus === "failed" && input.retainedController === null),
  );
  const cleanupFailure = input.cleanupStatus === "failed" || input.cleanupFailures.length > 0;
  return {
    schemaVersion: 1,
    invocationId: capProbeEvidenceString(input.invocationId, 64),
    phase: input.phase,
    command: capProbeEvidenceString(input.command, 192, SQLITE_FOUNDATION_PROBE_COMMAND),
    commit: capProbeEvidenceString(commit, 64),
    platform: {
      os: capProbeEvidenceString(process.platform, 16),
      arch: capProbeEvidenceString(process.arch, 16),
      bunVersion: capProbeEvidenceString(Bun.version, 32),
      bunRevision: capProbeEvidenceString(Bun.revision, 64),
      sqliteVersion: readRuntimeField(input.result?.stdout ?? "", "sqliteVersion"),
    },
    startedAt: new Date(input.startedAtMs).toISOString(),
    endedAt: new Date(input.now()).toISOString(),
    durationMs: Math.max(0, input.now() - input.startedAtMs),
    measuredResources: input.measuredResources,
    outcome: getOutcome(input.terminalError, input.probeError, input.cleanupFailures),
    cleanup: {
      descendantsTerminated: input.descendantsTerminated,
      descendantsReaped: input.descendantsReaped,
      controllerEmpty: input.controllerEmpty,
      controllerRemoved: input.controllerRemoved,
      tmpfsRemoved: input.tmpfsRemoved,
      workspaceRemoved: input.workspaceRemoved,
      temporaryDataRemoved: input.phase === "final" && input.temporaryDataRemoved,
      retainedController: controllerEvidence,
      status: input.cleanupStatus,
      failures: [...new Set(input.cleanupFailures)].slice(0, 16),
    },
    evidence: {
      disposition:
        controllerEvidence.state === "retained"
          ? "retained-owned-state"
          : cleanupFailure
            ? "cleanup-failure"
            : "transient-cleanup",
      location: null,
      retention:
        controllerEvidence.state === "retained" || cleanupFailure ? "coordinator-handoff" : "none",
    },
    diagnostics: {
      references:
        input.result === undefined ? [] : ["outer-process.stdout", "outer-process.stderr"],
      stdoutBytes: boundedNumber(input.result?.stdoutBytes ?? 0),
      stderrBytes: boundedNumber(input.result?.stderrBytes ?? 0),
    },
  };
}

function getOutcome(
  error: unknown,
  probeError: SqliteFoundationGateError | undefined,
  cleanupFailures: readonly string[],
): ProbeOutcome {
  if (error instanceof ProbeTimeoutError) return "timed-out";
  if (error instanceof ProbeInterruptedError) return "interrupted";
  if (cleanupFailures.includes("commit-helper-reap-unverified")) return "failed";
  return probeError === undefined ? "passed" : "failed";
}

export async function resolveProbeCommit(
  commit: string | ((signal?: AbortSignal) => string | Promise<string>) | undefined,
  signal: AbortSignal,
  spawnCommit?: (signal?: AbortSignal) => ProbeCommitChild,
): Promise<string> {
  if (typeof commit === "string") return validCommit(commit);
  if (commit !== undefined) {
    try {
      return validCommit(
        await raceWithAbort(
          Promise.resolve().then(() => commit(signal)),
          signal,
        ),
      );
    } catch {
      return "unknown";
    }
  }
  const configured = process.env.GIT_COMMIT;
  if (configured !== undefined && configured.length > 0) {
    return /^[0-9a-f]{7,64}$/i.test(configured) ? configured : "unknown";
  }
  try {
    const child =
      spawnCommit?.(signal) ??
      (() => {
        const process = Bun.spawn(["git", "rev-parse", "HEAD"], {
          maxBuffer: 256,
          stdout: "pipe",
          stderr: "ignore",
        });
        return {
          stdout: process.stdout,
          exited: process.exited,
          kill: (killSignal: NodeJS.Signals) => process.kill(killSignal),
        } satisfies ProbeCommitChild;
      })();
    const output = new Response(child.stdout).text();
    const revision = await raceCommitChild(child, output, signal);
    if (revision[0] === 0 && /^[0-9a-f]{7,64}$/i.test(revision[1].trim()))
      return revision[1].trim();
  } catch (error) {
    if (error instanceof ProbeCommitCleanupError) throw error;
    // A copied production artifact may not have Git metadata.
  }
  return "unknown";
}

function validCommit(value: unknown): string {
  return typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value) ? value : "unknown";
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new ProbeTimeoutError(1);
  let remove = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new ProbeTimeoutError(1));
    signal.addEventListener("abort", onAbort, { once: true });
    remove = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    remove();
  }
}

async function raceCommitChild(
  child: ProbeCommitChild,
  output: Promise<string>,
  signal: AbortSignal,
): Promise<[number, string]> {
  const operation = Promise.all([child.exited, output]);
  if (signal.aborted) {
    await terminateCommitChild(child);
    throw new ProbeTimeoutError(1);
  }
  let remove = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => {
      void terminateCommitChild(child).then(
        () => reject(new ProbeTimeoutError(1)),
        (error) => reject(error),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    remove = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    remove();
  }
}

async function terminateCommitChild(child: ProbeCommitChild): Promise<void> {
  try {
    child.kill("SIGKILL");
  } catch {
    // The child may have exited concurrently.
  }
  const observedExit = await Promise.race([
    child.exited.then(
      () => true,
      () => false,
    ),
    Bun.sleep(100).then(() => false),
  ]);
  if (!observedExit) throw new ProbeCommitCleanupError();
}

function readRuntimeField(output: string, key: string): string | null {
  try {
    const value = (JSON.parse(output.trim()) as Record<string, unknown>)[key];
    return typeof value === "string" ? capProbeEvidenceString(value, 64) : null;
  } catch {
    return null;
  }
}

function boundedNumber(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
