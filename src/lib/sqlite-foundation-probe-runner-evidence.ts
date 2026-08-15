import {
  SQLITE_FOUNDATION_PROBE_COMMAND,
  type ProbeOutcome,
  type ProbeQualificationResult,
  type ProbeResourceMeasurement,
} from "@/lib/sqlite-foundation-probe-result";
import {
  boundedProbeQualificationResult,
  capProbeEvidenceString,
} from "@/lib/sqlite-foundation-probe-evidence";
import {
  ProbeInterruptedError,
  ProbeTimeoutError,
  type ProbeWorkerResult,
} from "@/lib/sqlite-foundation-probe-process";
import {
  DockerAdmissionError,
  parseDockerArtifactIdentity,
} from "@/lib/sqlite-foundation-probe-docker";
import type { SqliteFoundationGateError } from "@/lib/sqlite-foundation-probe-errors";

export type QualificationResultInput = {
  phase: "pre-cleanup" | "final";
  invocationId: string;
  command: string | undefined;
  commit: string | ((signal?: AbortSignal) => string | Promise<string>) | undefined;
  startedAtMs: number;
  now: () => number;
  measuredResources: ProbeResourceMeasurement;
  result: ProbeWorkerResult | undefined;
  terminalError: unknown;
  probeError: SqliteFoundationGateError | undefined;
  descendantsReaped: boolean;
  descendantsTerminated: boolean | null;
  containerIdentityVerified: boolean | null;
  containerRemoved: boolean | null;
  cleanupFailures: string[];
  temporaryDataRemoved: boolean;
  cleanupStatus: "pending" | "verified" | "failed";
  evidenceEmission: "pending" | "verified" | "failed";
  evidenceFailures: string[];
  signal: AbortSignal;
};

export async function buildQualificationResult(
  input: QualificationResultInput,
): Promise<ProbeQualificationResult> {
  return boundedProbeQualificationResult(
    createQualificationResult(input, await resolveProbeCommit(input.commit, input.signal)),
  );
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
  const cleanupFailure = input.cleanupStatus === "failed" || input.cleanupFailures.length > 0;
  const artifact = readArtifactIdentity(input.result?.stdout ?? "");
  return {
    schemaVersion: 1,
    invocationId: capProbeEvidenceString(input.invocationId, 64),
    phase: input.phase,
    command: capProbeEvidenceString(input.command, 192, SQLITE_FOUNDATION_PROBE_COMMAND),
    commit: capProbeEvidenceString(commit, 64),
    platform: {
      os: capProbeEvidenceString(artifact?.os ?? process.platform, 16),
      arch: capProbeEvidenceString(artifact?.architecture ?? process.arch, 16),
      bunVersion: capProbeEvidenceString(artifact?.bunVersion ?? Bun.version, 32),
      bunRevision: capProbeEvidenceString(artifact?.bunRevision ?? Bun.revision, 64),
      sqliteVersion: artifact?.sqliteVersion ?? null,
    },
    startedAt: new Date(input.startedAtMs).toISOString(),
    endedAt: new Date(input.now()).toISOString(),
    durationMs: Math.max(0, input.now() - input.startedAtMs),
    measuredResources: input.measuredResources,
    outcome: getOutcome(input.terminalError, input.probeError, input.cleanupFailures),
    cleanup: {
      descendantsTerminated: input.descendantsTerminated,
      descendantsReaped: input.descendantsReaped,
      containerIdentityVerified: input.containerIdentityVerified,
      containerRemoved: input.containerRemoved,
      temporaryDataRemoved: input.phase === "final" && input.temporaryDataRemoved,
      retainedContainer: {
        state:
          input.cleanupStatus === "failed" && input.containerIdentityVerified !== true
            ? "unknown"
            : "none",
        scope:
          input.cleanupStatus === "failed" && input.containerIdentityVerified !== true
            ? "docker-container"
            : null,
        resources: [],
      },
      status: input.cleanupStatus,
      failures: [...new Set(input.cleanupFailures)].slice(0, 16),
    },
    evidence: {
      disposition: cleanupFailure ? "cleanup-failure" : "transient-cleanup",
      location: null,
      retention: cleanupFailure ? "coordinator-handoff" : "none",
      emission: input.evidenceEmission,
      failures: [...new Set(input.evidenceFailures)].slice(0, 16),
    },
    diagnostics: {
      references: input.result === undefined ? [] : ["docker.stdout", "docker.stderr"],
      stdoutBytes: input.result?.stdoutBytes ?? 0,
      stderrBytes: input.result?.stderrBytes ?? 0,
    },
  };
}

function getOutcome(
  error: unknown,
  probeError: SqliteFoundationGateError | undefined,
  failures: readonly string[],
): ProbeOutcome {
  if (error instanceof ProbeTimeoutError) return "timed-out";
  if (error instanceof ProbeInterruptedError) return "interrupted";
  if (error instanceof DockerAdmissionError) return "blocked";
  return probeError === undefined && failures.length === 0 ? "passed" : "failed";
}

export async function resolveProbeCommit(
  commit: string | ((signal?: AbortSignal) => string | Promise<string>) | undefined,
  signal: AbortSignal,
): Promise<string> {
  if (typeof commit === "string") return validCommit(commit);
  if (commit !== undefined) {
    try {
      return validCommit(
        await Promise.race([Promise.resolve().then(() => commit(signal)), abortOnSignal(signal)]),
      );
    } catch {
      return "unknown";
    }
  }
  const configured = process.env.GIT_COMMIT;
  if (configured !== undefined) return validCommit(configured);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const abortGit = () => {
    child?.kill("SIGTERM");
    killTimer = setTimeout(() => child?.kill("SIGKILL"), 250);
  };
  try {
    const spawned = Bun.spawn(["git", "rev-parse", "HEAD"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    child = spawned;
    if (signal.aborted) abortGit();
    else signal.addEventListener("abort", abortGit, { once: true });
    const revision = await Promise.race([
      (async () => {
        const value = (await new Response(spawned.stdout).text()).trim();
        await spawned.exited;
        return value;
      })(),
      abortOnSignal(signal),
    ]);
    return validCommit(revision);
  } catch {
    return "unknown";
  } finally {
    if (killTimer !== undefined) clearTimeout(killTimer);
    signal.removeEventListener("abort", abortGit);
    void child?.exited.catch(() => {});
  }
}

function readArtifactIdentity(stdout: string): Record<string, string> | null {
  const identity = parseDockerArtifactIdentity(stdout);
  return identity === null ? null : { ...identity, architecture: identity.architecture };
}

function abortOnSignal(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(new ProbeTimeoutError(1));
  return new Promise((_, reject) =>
    signal.addEventListener("abort", () => reject(new ProbeTimeoutError(1)), { once: true }),
  );
}

function validCommit(value: unknown): string {
  return typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value) ? value : "unknown";
}
