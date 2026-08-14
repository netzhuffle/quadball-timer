import type { ProbeRetainedCgroupController } from "@/lib/sqlite-foundation-probe-cgroup";
import type { ProbeQualificationResult } from "@/lib/sqlite-foundation-probe-result";

export const SQLITE_FOUNDATION_PROBE_RESULT_MAX_BYTES = 4 * 1024;

export function capProbeEvidenceString(
  value: unknown,
  maximumBytes = 128,
  fallback = "unknown",
): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  let normalized = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code > 0x1f && code !== 0x7f) normalized += character;
  }
  const bytes = new TextEncoder().encode(normalized);
  if (bytes.byteLength <= maximumBytes) return normalized;
  return (
    new TextDecoder().decode(bytes.slice(0, maximumBytes)).replace(/[\uFFFD]/g, "") || fallback
  );
}

export function capProbeEvidenceList(values: readonly unknown[], maximum = 16): string[] {
  return values
    .slice(0, maximum)
    .map((value) => capProbeEvidenceString(value, 96))
    .filter((value) => value !== "unknown");
}

export function retainedControllerEvidence(
  controller: ProbeRetainedCgroupController | null,
  cleanupUnknown = false,
): ProbeQualificationResult["cleanup"]["retainedController"] {
  if (controller === null) {
    return {
      state: cleanupUnknown ? "unknown" : "none",
      scope: cleanupUnknown ? "invocation-cgroup" : null,
      resources: [],
    };
  }
  const resources: ProbeQualificationResult["cleanup"]["retainedController"]["resources"] = [];
  for (const retainedPath of controller.retainedPaths) {
    if (retainedPath === controller.rootPath) resources.push("root");
    else if (retainedPath === controller.helperPath) resources.push("helper");
    else if (retainedPath === controller.workloadPath) resources.push("workload");
    else if (retainedPath === controller.markerPath) resources.push("capability-marker");
  }
  return {
    state: "retained",
    scope: "invocation-cgroup",
    resources: [...new Set(resources)],
  };
}

export function boundedProbeQualificationResult(
  result: ProbeQualificationResult,
): ProbeQualificationResult {
  if (jsonByteLength(result) <= SQLITE_FOUNDATION_PROBE_RESULT_MAX_BYTES) return result;
  const fallback: ProbeQualificationResult = {
    schemaVersion: 1,
    invocationId: capProbeEvidenceString(result.invocationId, 64, "unknown"),
    phase: result.phase,
    command: "qualification-harness",
    commit: validCommit(result.commit),
    platform: {
      os: capProbeEvidenceString(result.platform.os, 16),
      arch: capProbeEvidenceString(result.platform.arch, 16),
      bunVersion: capProbeEvidenceString(result.platform.bunVersion, 32),
      bunRevision: capProbeEvidenceString(result.platform.bunRevision, 64),
      sqliteVersion: capProbeEvidenceString(result.platform.sqliteVersion, 32, "unknown"),
    },
    startedAt: capProbeEvidenceString(result.startedAt, 32),
    endedAt: capProbeEvidenceString(result.endedAt, 32),
    durationMs: Number.isSafeInteger(result.durationMs) ? result.durationMs : 0,
    measuredResources: {
      processCount: boundedMeasurement(result.measuredResources.processCount),
      peakMemoryBytes: boundedMeasurement(result.measuredResources.peakMemoryBytes),
      diskBytes: boundedMeasurement(result.measuredResources.diskBytes),
      outputBytes: boundedMeasurement(result.measuredResources.outputBytes),
    },
    outcome: result.outcome,
    cleanup: {
      ...result.cleanup,
      failures: ["evidence-size"],
      temporaryDataRemoved: false,
      status: "failed",
    },
    evidence: {
      disposition: "cleanup-failure",
      location: null,
      retention: "coordinator-handoff",
    },
    diagnostics: { references: [], stdoutBytes: 0, stderrBytes: 0 },
  };
  if (jsonByteLength(fallback) <= SQLITE_FOUNDATION_PROBE_RESULT_MAX_BYTES) return fallback;
  return {
    schemaVersion: 1,
    invocationId: "unknown",
    phase: result.phase,
    command: "qualification-harness",
    commit: "unknown",
    platform: {
      os: "unknown",
      arch: "unknown",
      bunVersion: "unknown",
      bunRevision: "unknown",
      sqliteVersion: null,
    },
    startedAt: "unknown",
    endedAt: "unknown",
    durationMs: 0,
    measuredResources: {
      processCount: null,
      peakMemoryBytes: null,
      diskBytes: null,
      outputBytes: null,
    },
    outcome: result.outcome,
    cleanup: {
      descendantsTerminated: null,
      descendantsReaped: false,
      controllerEmpty: null,
      controllerRemoved: false,
      tmpfsRemoved: null,
      workspaceRemoved: false,
      temporaryDataRemoved: false,
      retainedController: { state: "unknown", scope: "invocation-cgroup", resources: [] },
      status: "failed",
      failures: ["evidence-size"],
    },
    evidence: { disposition: "cleanup-failure", location: null, retention: "coordinator-handoff" },
    diagnostics: { references: [], stdoutBytes: 0, stderrBytes: 0 },
  };
}

export function markProbeResultEmissionFailed(
  result: ProbeQualificationResult,
): ProbeQualificationResult {
  return boundedProbeQualificationResult({
    ...result,
    outcome: result.outcome === "passed" ? "failed" : result.outcome,
    cleanup: {
      ...result.cleanup,
      status: "failed",
      failures: [...new Set([...result.cleanup.failures, "result-emission"])],
    },
    evidence: {
      disposition: "cleanup-failure",
      location: null,
      retention: "coordinator-handoff",
    },
  });
}

export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function validCommit(value: unknown): string {
  return typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value) ? value : "unknown";
}

function boundedMeasurement(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
