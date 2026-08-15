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

export function boundedProbeQualificationResult(
  result: ProbeQualificationResult,
): ProbeQualificationResult {
  if (jsonByteLength(result) <= SQLITE_FOUNDATION_PROBE_RESULT_MAX_BYTES) return result;
  return {
    ...result,
    command: "qualification-harness",
    commit: validCommit(result.commit),
    measuredResources: {
      processCount: boundedMeasurement(result.measuredResources.processCount),
      peakMemoryBytes: boundedMeasurement(result.measuredResources.peakMemoryBytes),
      diskBytes: boundedMeasurement(result.measuredResources.diskBytes),
      outputBytes: boundedMeasurement(result.measuredResources.outputBytes),
      ...(result.measuredResources.resourceViolations === undefined
        ? {}
        : { resourceViolations: result.measuredResources.resourceViolations.slice(0, 8) }),
    },
    cleanup: {
      ...result.cleanup,
    },
    evidence: {
      ...result.evidence,
      emission: "failed",
      failures: [...new Set([...(result.evidence?.failures ?? []), "evidence-size"])],
    },
    diagnostics: { references: [], stdoutBytes: 0, stderrBytes: 0 },
  };
}

export function markProbeResultEmissionFailed(
  result: ProbeQualificationResult,
): ProbeQualificationResult {
  return boundedProbeQualificationResult({
    ...result,
    outcome: result.outcome === "passed" ? "failed" : result.outcome,
    evidence: {
      ...result.evidence,
      disposition: result.cleanup.status === "failed" ? "cleanup-failure" : "retained-owned-state",
      retention: "coordinator-handoff",
      emission: "failed",
      failures: [...new Set([...(result.evidence?.failures ?? []), "result-emission"])],
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
