import { performance } from "node:perf_hooks";
import {
  admitDockerEngine,
  buildFocusedDockerCommand,
  cleanupMalformedCreateOutput,
  cleanupOwnedDockerContainer,
  parseContainerId,
  DockerAdmissionError,
  SQLITE_FOUNDATION_PROBE_DOCKER_FINAL_CLEANUP_SLICE_MS,
  runDockerCommand,
  SQLITE_FOUNDATION_PROBE_DOCKER_CREATE_RECONCILIATION_MS,
  verifyDockerContainerConfiguration,
  type DockerAdmissionDisposition,
  type DockerProbeLifecycle,
} from "@/lib/sqlite-foundation-probe-docker";
import {
  focusedAdmissionExitCode,
  focusedAdmissionRecordByteLength,
} from "@/lib/sqlite-foundation-probe-focused-admission";

class FocusedAdmissionError extends Error {
  readonly disposition: DockerAdmissionDisposition;

  constructor(message: string, disposition: DockerAdmissionDisposition) {
    super(message);
    this.name = "FocusedAdmissionError";
    this.disposition = disposition;
  }
}

const startedAt = performance.now();
const invocationId = crypto.randomUUID();
let outcome: "passed" | "failed" | "blocked" = "blocked";
let containerRemoved: boolean | null = null;
let identityVerified: boolean | null = null;
let workloadLaunched = false;
let errorReference: string | null = null;
let engine: unknown = null;
let descendantsTerminated: boolean | null = null;
let descendantsReaped = false;
let temporaryDataRemoved = false;
const workAbort = new AbortController();
const admissionAbort = new AbortController();
const reconciliationAbort = new AbortController();
const hardAbort = new AbortController();
const workTimer = setTimeout(() => workAbort.abort(), 3_000);
const admissionTimer = setTimeout(
  () => admissionAbort.abort(),
  3_000 + SQLITE_FOUNDATION_PROBE_DOCKER_CREATE_RECONCILIATION_MS,
);
const reconciliationTimer = setTimeout(
  () => reconciliationAbort.abort(),
  5_000 - SQLITE_FOUNDATION_PROBE_DOCKER_FINAL_CLEANUP_SLICE_MS,
);
const hardTimer = setTimeout(() => hardAbort.abort(), 5_000);
const abortAdmissionAtHardDeadline = () => admissionAbort.abort();
hardAbort.signal.addEventListener("abort", abortAdmissionAtHardDeadline, { once: true });
const abortReconciliationAtHardDeadline = () => reconciliationAbort.abort();
hardAbort.signal.addEventListener("abort", abortReconciliationAtHardDeadline, { once: true });
let execution: Awaited<ReturnType<typeof createHarmlessExecution>> | undefined;

try {
  engine = await admitDockerEngine({
    runCommand: (arguments_) => runDockerCommand(arguments_, { signal: workAbort.signal }),
  });
  const command = buildFocusedDockerCommand(`quadball-timer-focused-${invocationId}`, invocationId);
  if (command.includes("--sqlite-foundation-probe"))
    throw new Error("focused command contains the qualification workload");
  execution = await createHarmlessExecution(command, invocationId, {
    workSignal: workAbort.signal,
    admissionSignal: admissionAbort.signal,
    reconciliationSignal: reconciliationAbort.signal,
    cleanupSignal: hardAbort.signal,
  });
  workloadLaunched = true;
  const result = await execution.run();
  if (result.exitCode !== 0) throw new Error("Docker containment helper failed");
  outcome = "passed";
} catch (error) {
  if (error instanceof DockerAdmissionError) errorReference = "docker-admission-unavailable";
  else if (error instanceof FocusedAdmissionError) {
    errorReference = error.name;
    temporaryDataRemoved = error.disposition !== "unverified";
    if (error.disposition === "removed") {
      identityVerified = true;
      containerRemoved = true;
    }
  } else errorReference = error instanceof Error ? error.name : "UnknownError";
  outcome = engine === null ? "blocked" : "failed";
} finally {
  if (execution !== undefined) {
    if (outcome !== "passed") {
      try {
        await execution.stop(hardAbort.signal);
        descendantsTerminated = true;
        descendantsReaped = true;
      } catch {
        errorReference ??= "stop-wait-failed";
      }
    }
    try {
      const cleanup = await execution.cleanup();
      identityVerified = cleanup.identityVerified;
      containerRemoved = cleanup.removed;
      temporaryDataRemoved = cleanup.removed;
      descendantsTerminated = cleanup.descendantsTerminated ?? descendantsTerminated;
      descendantsReaped = cleanup.descendantsReaped ?? descendantsReaped;
      if (!cleanup.identityVerified || !cleanup.removed) outcome = "failed";
    } catch (error) {
      identityVerified = false;
      containerRemoved = false;
      outcome = "failed";
      errorReference ??= error instanceof Error ? error.name : "cleanup-failed";
    }
  }
  clearTimeout(workTimer);
  clearTimeout(admissionTimer);
  clearTimeout(reconciliationTimer);
  clearTimeout(hardTimer);
  hardAbort.signal.removeEventListener("abort", abortAdmissionAtHardDeadline);
  hardAbort.signal.removeEventListener("abort", abortReconciliationAtHardDeadline);
  admissionAbort.abort();
  reconciliationAbort.abort();
}

const evidence = {
  schemaVersion: 1,
  kind: "sqlite-focused-docker-admission-evidence",
  platform: { os: process.platform, arch: process.arch, bunVersion: Bun.version },
  qualificationWorkloadRan: false,
  dockerCommandContainsQualificationWorkload: false,
  outcome,
  containerIdentityVerified: identityVerified,
  containerRemoved,
  descendantsTerminated,
  descendantsReaped,
  temporaryDataRemoved,
  workloadLaunched,
  durationMs: Math.ceil(performance.now() - startedAt),
  totalDeadlineMs: 5_000,
  cleanupReserveMs: 2_000,
  blocker:
    process.platform === "linux" && process.arch === "x64" ? null : "native-linux-x64-required",
  errorReference,
};
if (focusedAdmissionRecordByteLength(evidence) > 4 * 1024)
  throw new Error("focused evidence exceeded its bound");
process.stdout.write(`${JSON.stringify(evidence)}\n`);
process.exitCode = focusedAdmissionExitCode(outcome);

async function createHarmlessExecution(
  command: string[],
  capability: string,
  lifecycle: DockerProbeLifecycle,
) {
  const name = command[command.indexOf("--name") + 1] ?? `quadball-timer-focused-${capability}`;
  // Allow only the short admission grace after the work deadline; cleanup keeps
  // the remaining reserve for exact ownership and absence proof.
  const create = await runDockerCommand(command, { signal: lifecycle.admissionSignal }).catch(
    () => null,
  );
  if (create === null || create.exitCode !== 0 || create.outputExceeded) {
    const cleanupDisposition = await cleanupMalformedCreateOutput(
      runDockerCommand,
      name,
      capability,
      lifecycle,
    );
    throw new FocusedAdmissionError(
      "Docker could not create focused container",
      cleanupDisposition,
    );
  }
  const id = parseContainerId(create.stdout);
  if (id === null) {
    const cleanupDisposition = await cleanupMalformedCreateOutput(
      runDockerCommand,
      name,
      capability,
      lifecycle,
    );
    throw new FocusedAdmissionError(
      "Docker returned an invalid focused container identity",
      cleanupDisposition,
    );
  }
  const admitted = await verifyDockerContainerConfiguration(
    runDockerCommand,
    { id, name, capability },
    lifecycle.admissionSignal,
    null,
  );
  if (!admitted) {
    const cleanupDisposition = await cleanupMalformedCreateOutput(
      runDockerCommand,
      name,
      capability,
      lifecycle,
    );
    throw new FocusedAdmissionError(
      "Docker focused containment configuration could not be verified",
      cleanupDisposition,
    );
  }
  let stopVerified = false;
  const execution = {
    container: { id, name, capability, artifactPath: "", identityVerified: false },
    async run() {
      const start = await runDockerCommand(["start", id], { signal: lifecycle.workSignal });
      if (start.exitCode !== 0) throw new Error("Docker could not start focused container");
      await Bun.sleep(25);
      const stop = await runDockerCommand(["stop", "--time", "1", id], {
        signal: lifecycle.workSignal,
      });
      if (stop.exitCode !== 0) {
        await runDockerCommand(["kill", id], { signal: lifecycle.workSignal });
      }
      const wait = await runDockerCommand(["wait", id], { signal: lifecycle.workSignal });
      parseFocusedWaitExitCode(wait);
      stopVerified = true;
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        stdoutBytes: 0,
        stderrBytes: 0,
        outputExceeded: false,
      };
    },
    async stop(signal: AbortSignal) {
      const stop = await runDockerCommand(["stop", "--time", "1", id], {
        signal,
      });
      if (stop.exitCode !== 0) {
        await runDockerCommand(["kill", id], { signal });
      }
      const wait = await runDockerCommand(["wait", id], { signal });
      parseFocusedWaitExitCode(wait);
      stopVerified = true;
    },
    async cleanup() {
      const cleanup = await cleanupOwnedDockerContainer(
        runDockerCommand,
        { id, name, capability },
        lifecycle.cleanupSignal,
      );
      if (!cleanup.identityVerified) throw new Error("focused container ownership failed");
      return {
        ...cleanup,
        descendantsTerminated: stopVerified,
        descendantsReaped: stopVerified,
        temporaryDataRemoved: cleanup.removed,
      };
    },
  };
  return execution;
}

function parseFocusedWaitExitCode(result: { exitCode: number; stdout: string }): number {
  if (result.exitCode !== 0 || !/^(?:0|[1-9][0-9]*)\n?$/.test(result.stdout))
    throw new Error("Docker wait did not return an exact exit code");
  const exitCode = Number(result.stdout.trim());
  if (!Number.isSafeInteger(exitCode)) throw new Error("Docker wait exit code was unsafe");
  return exitCode;
}
