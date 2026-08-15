import { describe, expect, test } from "bun:test";
import {
  boundedProbeQualificationResult,
  jsonByteLength,
} from "@/lib/sqlite-foundation-probe-evidence";
import type { ProbeQualificationResult } from "@/lib/sqlite-foundation-probe-result";

function result(): ProbeQualificationResult {
  return {
    schemaVersion: 1,
    invocationId: "invocation",
    phase: "final",
    command: "bun run check:sqlite-runtime [compiled-executable]",
    commit: "abcdef1",
    platform: {
      os: "linux",
      arch: "x64",
      bunVersion: "1.3.14",
      bunRevision: "abcdef12",
      sqliteVersion: "3.53.0",
    },
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1).toISOString(),
    durationMs: 1,
    measuredResources: { processCount: 1, peakMemoryBytes: 1, diskBytes: null, outputBytes: 1 },
    outcome: "passed",
    cleanup: {
      descendantsTerminated: true,
      descendantsReaped: true,
      containerIdentityVerified: true,
      containerRemoved: true,
      temporaryDataRemoved: true,
      retainedContainer: { state: "none", scope: null, resources: [] },
      status: "verified",
      failures: [],
    },
    evidence: {
      disposition: "transient-cleanup",
      location: null,
      retention: "none",
      emission: "verified",
      failures: [],
    },
    diagnostics: { references: [], stdoutBytes: 1, stderrBytes: 0 },
  };
}

describe("bounded Docker qualification evidence", () => {
  test("measures UTF-8 JSON bytes", () => {
    expect(jsonByteLength({ value: "😀" })).toBe(16);
  });

  test("marks oversized evidence as a truthful cleanup failure", () => {
    const bounded = boundedProbeQualificationResult({ ...result(), command: "x".repeat(10_000) });
    expect(bounded.cleanup.status).toBe("verified");
    expect(bounded.evidence.failures).toContain("evidence-size");
    expect(bounded.cleanup.temporaryDataRemoved).toBe(true);
  });
});
