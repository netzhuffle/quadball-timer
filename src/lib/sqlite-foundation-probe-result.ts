import {
  SQLITE_FOUNDATION_PROBE_MAX_OUTPUT_BYTES,
  SQLITE_FOUNDATION_PROBE_MAX_PROCESS_COUNT,
} from "@/lib/sqlite-foundation-probe-process";

export { SQLITE_FOUNDATION_PROBE_MAX_PROCESS_COUNT } from "@/lib/sqlite-foundation-probe-process";

export const SQLITE_FOUNDATION_PROBE_COMMAND = "bun run check:sqlite-runtime [compiled-executable]";
export const SQLITE_FOUNDATION_PROBE_MAX_MEMORY_BYTES = 512 * 1024 * 1024;
export const SQLITE_FOUNDATION_PROBE_MAX_DISK_BYTES = 16 * 1024 * 1024;

export type ProbeOutcome = "passed" | "failed" | "timed-out" | "interrupted";

export type ProbeRetainedControllerEvidence = {
  state: "none" | "retained" | "unknown";
  scope: "invocation-cgroup" | null;
  resources: Array<"root" | "helper" | "workload" | "capability-marker">;
};

export type ProbeResourceMeasurement = {
  processCount: number | null;
  peakMemoryBytes: number | null;
  diskBytes: number | null;
  outputBytes: number | null;
};

export type ProbeQualificationResult = {
  schemaVersion: 1;
  invocationId: string;
  phase: "pre-cleanup" | "final";
  command: string;
  commit: string;
  platform: {
    os: string;
    arch: string;
    bunVersion: string;
    bunRevision: string;
    sqliteVersion: string | null;
  };
  startedAt: string;
  endedAt: string;
  durationMs: number;
  measuredResources: ProbeResourceMeasurement;
  outcome: ProbeOutcome;
  cleanup: {
    descendantsTerminated: boolean | null;
    descendantsReaped: boolean;
    controllerEmpty: boolean | null;
    controllerRemoved: boolean | null;
    tmpfsRemoved: boolean | null;
    workspaceRemoved: boolean | null;
    temporaryDataRemoved: boolean;
    retainedController: ProbeRetainedControllerEvidence;
    status: "pending" | "verified" | "failed";
    failures: string[];
  };
  evidence: {
    disposition: "transient-cleanup" | "retained-owned-state" | "cleanup-failure";
    location: null;
    retention: "none" | "coordinator-handoff";
  };
  diagnostics: {
    references: string[];
    stdoutBytes: number;
    stderrBytes: number;
  };
};

export function isProbeResourceMeasurementWithinLimits(
  resources: ProbeResourceMeasurement,
): boolean {
  return (
    resources.processCount !== null &&
    resources.peakMemoryBytes !== null &&
    resources.diskBytes !== null &&
    resources.outputBytes !== null &&
    resources.processCount <= SQLITE_FOUNDATION_PROBE_MAX_PROCESS_COUNT &&
    resources.peakMemoryBytes <= SQLITE_FOUNDATION_PROBE_MAX_MEMORY_BYTES &&
    resources.diskBytes <= SQLITE_FOUNDATION_PROBE_MAX_DISK_BYTES &&
    resources.outputBytes <= SQLITE_FOUNDATION_PROBE_MAX_OUTPUT_BYTES
  );
}
