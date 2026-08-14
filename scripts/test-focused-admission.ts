import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cleanupOwnedProbeWorkspaceContainer,
  createProbeOuterEnvironment,
  createProbeWorkspaceContainer,
  type ProbeWorkspaceContainer,
} from "@/lib/sqlite-foundation-probe-containment";
import { createProbeNetworkBoundary } from "@/lib/sqlite-foundation-probe-network";
import {
  createProbeOutputBudget,
  spawnProbeCommand,
  superviseProbeWorkers,
} from "@/lib/sqlite-foundation-probe-process";
import {
  createProbeResourceController,
  readProbeTmpfsDisposition,
  type ProbeResourceController,
} from "@/lib/sqlite-foundation-probe-resources";
import { createFocusedAdmissionDeadline } from "@/lib/sqlite-foundation-probe-focused-deadline";
import {
  focusedAdmissionExitCode,
  focusedAdmissionRecordByteLength,
  runFocusedBounded,
} from "@/lib/sqlite-foundation-probe-focused-admission";
import { capProbeEvidenceString } from "@/lib/sqlite-foundation-probe-evidence";

const FOCUSED_TOTAL_DEADLINE_MS = 5_000;
const FOCUSED_CLEANUP_RESERVE_MS = 2_000;
const startedAt = performance.now();
const deadline = createFocusedAdmissionDeadline(
  FOCUSED_TOTAL_DEADLINE_MS,
  FOCUSED_CLEANUP_RESERVE_MS,
);
const workSignal = deadline.workSignal;
const overallSignal = deadline.overallSignal;

let container: ProbeWorkspaceContainer | undefined;
let controller: ProbeResourceController | undefined;
let worker: ReturnType<typeof spawnProbeCommand> | undefined;
let controllerEmpty: boolean | null = null;
let controllerRemoved: boolean | null = null;
let workspaceRemoved: boolean | null = null;
let tmpfsRemoved: boolean | null = null;
let descendantsTerminated: boolean | null = null;
let descendantsReaped: boolean | null = null;
let retainedController = false;
const failures: string[] = [];
let outcome: "passed" | "failed" | "blocked" = "blocked";
let errorReference: string | null = null;
const measurements: Record<string, number | null> = {
  admissionMs: null,
  readinessMs: null,
  releaseAndExitMs: null,
  sampleMs: null,
  emitterMs: null,
  teardownMs: null,
  totalMs: null,
};

try {
  if (process.platform !== "linux" || process.arch !== "x64") {
    errorReference = "native-linux-x64-controls-unavailable";
  } else {
    const admissionStartedAt = performance.now();
    container = await bounded(
      createProbeWorkspaceContainer(workSignal),
      workSignal,
      "container creation",
    );
    const networkBoundary = await bounded(
      createProbeNetworkBoundary({ signal: workSignal, timeoutMs: remainingMs() }),
      workSignal,
      "network admission",
    );
    controller = await bounded(
      createProbeResourceController(container.workspaceDirectoryPath ?? container.directoryPath, {
        networkBoundary,
        container,
        invocationId: crypto.randomUUID(),
        signal: workSignal,
      }),
      workSignal,
      "controller creation",
    );
    measurements.admissionMs = elapsed(admissionStartedAt);

    const workspacePath = container.workspaceDirectoryPath ?? container.directoryPath;
    const hostProbePaths = [
      path.join(container.directoryPath, ".host-write-probe"),
      path.join(process.cwd(), ".host-write-probe"),
      path.join(tmpdir(), ".host-write-probe"),
    ];
    const launch = await bounded(
      controller.prepare([
        "/bin/sh",
        "-eu",
        "-c",
        'for target in "$1" "$2" "$3"; do if printf x > "$target" 2>/dev/null; then exit 42; fi; done; test "$PWD" = "$4"; test "$TMPDIR" = "$4/tmp"',
        "focused-admission",
        ...hostProbePaths,
        workspacePath,
      ]),
      workSignal,
      "launch preparation",
    );
    const readyStartedAt = performance.now();
    worker = spawnProbeCommand([...launch.command], {
      detached: true,
      env: createProbeOuterEnvironment(container),
      outputBudget: createProbeOutputBudget(),
      readyMarker: "READY\n",
    });
    const ready = await bounded(worker.ready ?? Promise.resolve(true), workSignal, "readiness");
    if (!ready) throw new Error("focused admission did not reach readiness");
    measurements.readinessMs = elapsed(readyStartedAt);
    await bounded(controller.attach(worker.process.pid), workSignal, "attachment");
    const releaseStartedAt = performance.now();
    await bounded(launch.release(worker.process.pid), workSignal, "release");
    const [result] = await bounded(
      superviseProbeWorkers([worker], {
        signal: workSignal,
        timeoutMs: remainingMs(),
        killWorkloadTree: () => controller?.kill() ?? Promise.resolve(),
      }),
      workSignal,
      "harmless helper exit",
    );
    descendantsTerminated = result?.exitCode !== null && result?.exitCode !== undefined;
    tmpfsRemoved = readProbeTmpfsDisposition(result?.stdout ?? "");
    measurements.releaseAndExitMs = elapsed(releaseStartedAt);
    const sampleStartedAt = performance.now();
    await bounded(
      controller.sample(
        worker.process.pid,
        workspacePath,
        result?.stdoutBytes ?? 0,
        result?.stdout,
        result?.stderr,
      ),
      workSignal,
      "resource sample",
    );
    measurements.sampleMs = elapsed(sampleStartedAt);
    outcome = "passed";
  }
} catch (error) {
  outcome = "failed";
  errorReference = boundedErrorReference(error);
  if (hasRetainedController(error)) {
    retainedController = true;
    controllerEmpty = false;
    controllerRemoved = false;
    failures.push("retained-controller");
  }
} finally {
  const teardownStartedAt = performance.now();
  if (controller !== undefined) {
    try {
      await bounded(controller.reap(overallSignal), overallSignal, "controller reap");
      controllerEmpty = await bounded(
        controller.isEmpty?.() ?? Promise.resolve(true),
        overallSignal,
        "controller empty verification",
      );
      descendantsReaped = controllerEmpty;
      if (controllerEmpty) {
        await bounded(controller.close(overallSignal), overallSignal, "controller close");
        controllerRemoved = true;
        controller = undefined;
      } else {
        controllerRemoved = false;
        failures.push("controller-empty");
        outcome = "failed";
      }
    } catch (error) {
      retainedController = true;
      controllerEmpty = false;
      controllerRemoved = false;
      descendantsReaped = false;
      if (hasRetainedController(error)) retainedController = true;
      failures.push("descendant-reap", "controller-empty", "controller-removal");
      if (tmpfsRemoved !== true) failures.push("tmpfs-removal");
      outcome = "failed";
      errorReference ??= boundedErrorReference(error);
    }
  }
  if (worker !== undefined && worker.process.exitCode === null) {
    worker.process.kill("SIGKILL");
    await bounded(worker.process.exited, overallSignal, "direct helper reap").catch((error) => {
      outcome = "failed";
      errorReference ??= boundedErrorReference(error);
    });
  }
  if (worker !== undefined && worker.process.exitCode !== null) descendantsTerminated = true;
  if (
    container !== undefined &&
    (controller === undefined || controllerRemoved) &&
    !retainedController
  ) {
    try {
      await bounded(
        cleanupOwnedProbeWorkspaceContainer(
          container.directoryPath,
          container.capability,
          overallSignal,
        ),
        overallSignal,
        "workspace cleanup",
      );
      workspaceRemoved = true;
    } catch (error) {
      workspaceRemoved = false;
      outcome = "failed";
      errorReference ??= boundedErrorReference(error);
    }
  }
  measurements.teardownMs = elapsed(teardownStartedAt);
  const emitterStartedAt = performance.now();
  const evidence = {
    schemaVersion: 1,
    kind: "sqlite-focused-admission-evidence",
    platform: { os: process.platform, arch: process.arch, bunVersion: Bun.version },
    qualificationWorkloadRan: false,
    totalDeadlineMs: FOCUSED_TOTAL_DEADLINE_MS,
    cleanupReserveMs: FOCUSED_CLEANUP_RESERVE_MS,
    outcome,
    measurements,
    cleanup: {
      descendantsTerminated,
      descendantsReaped,
      controllerEmpty,
      controllerRemoved,
      tmpfsRemoved,
      workspaceRemoved,
      failures: [...new Set(failures)],
      retainedController: {
        state: retainedController ? "retained" : "none",
        scope: retainedController ? "invocation-cgroup" : null,
        resources: [],
      },
    },
    evidence: {
      disposition: retainedController
        ? "retained-owned-state"
        : outcome === "failed"
          ? "cleanup-failure"
          : "transient-cleanup",
      retention: retainedController || outcome === "failed" ? "coordinator-handoff" : "none",
    },
    blocker:
      process.platform === "linux" && process.arch === "x64"
        ? null
        : "Native Linux x86-64 admission and teardown measurements remain required.",
    errorReference,
  };
  measurements.emitterMs = elapsed(emitterStartedAt);
  measurements.totalMs = elapsed(startedAt);
  const emittedEvidence = boundedFocusedEvidence({
    ...evidence,
    outcome,
    errorReference,
    measurements,
    cleanup: { ...evidence.cleanup, failures: [...new Set(failures)] },
  });
  if (emittedEvidence.outcome === "failed") outcome = "failed";
  process.stdout.write(`${JSON.stringify(emittedEvidence)}\n`);
  deadline.cleanup();
  process.exitCode = focusedAdmissionExitCode(outcome);
}

async function bounded<T>(operation: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
  try {
    return await runFocusedBounded(operation, signal, label);
  } catch (error) {
    if (signal.aborted && !overallSignal.aborted) {
      await Promise.race([
        operation.then(
          () => undefined,
          () => undefined,
        ),
        waitForAbort(overallSignal),
      ]);
    }
    throw error;
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

function remainingMs(): number {
  return Math.max(1, FOCUSED_TOTAL_DEADLINE_MS - elapsed(startedAt));
}

function elapsed(start: number): number {
  return Math.max(0, Math.ceil(performance.now() - start));
}

function boundedErrorReference(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  return capProbeEvidenceString(name.replace(/[^A-Za-z0-9_-]/g, ""), 64, "UnknownError");
}

function boundedFocusedEvidence(record: Record<string, unknown>): Record<string, unknown> {
  if (focusedAdmissionRecordByteLength(record) <= 4 * 1024) return record;
  return {
    schemaVersion: 1,
    kind: "sqlite-focused-admission-evidence",
    platform: {
      os: capProbeEvidenceString(process.platform, 16),
      arch: capProbeEvidenceString(process.arch, 16),
      bunVersion: capProbeEvidenceString(Bun.version, 32),
    },
    qualificationWorkloadRan: false,
    totalDeadlineMs: FOCUSED_TOTAL_DEADLINE_MS,
    cleanupReserveMs: FOCUSED_CLEANUP_RESERVE_MS,
    outcome: "failed",
    measurements: {
      admissionMs: null,
      readinessMs: null,
      releaseAndExitMs: null,
      sampleMs: null,
      emitterMs: 0,
      teardownMs: null,
      totalMs: elapsed(startedAt),
    },
    cleanup: {
      descendantsTerminated: null,
      descendantsReaped: false,
      controllerEmpty: null,
      controllerRemoved: false,
      tmpfsRemoved: null,
      workspaceRemoved: false,
      failures: ["evidence-size"],
      retainedController: { state: "unknown", scope: "invocation-cgroup", resources: [] },
    },
    evidence: { disposition: "cleanup-failure", retention: "coordinator-handoff" },
    blocker: null,
    errorReference: "focused-evidence-size-limit",
  };
}

function hasRetainedController(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "retainedController" in error &&
    (error as { retainedController?: unknown }).retainedController !== null
  );
}
