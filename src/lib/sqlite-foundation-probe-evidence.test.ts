import { describe, expect, test } from "bun:test";
import {
  boundedProbeQualificationResult,
  SQLITE_FOUNDATION_PROBE_RESULT_MAX_BYTES,
} from "@/lib/sqlite-foundation-probe-evidence";
import type { ProbeQualificationResult } from "@/lib/sqlite-foundation-probe-result";

describe("sqlite qualification evidence", () => {
  test("caps external commit and command strings before emission", () => {
    const result: ProbeQualificationResult = {
      schemaVersion: 1,
      invocationId: "invocation",
      phase: "final",
      command: "x".repeat(20_000),
      commit: "secret-and-not-a-commit".repeat(20_000),
      platform: {
        os: "linux",
        arch: "x64",
        bunVersion: "1.3.14",
        bunRevision: "revision",
        sqliteVersion: null,
      },
      startedAt: "2026-08-14T00:00:00.000Z",
      endedAt: "2026-08-14T00:00:01.000Z",
      durationMs: 1,
      measuredResources: {
        processCount: 7,
        peakMemoryBytes: 512,
        diskBytes: 4096,
        outputBytes: 123,
      },
      outcome: "failed",
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
        failures: ["failure"],
      },
      evidence: {
        disposition: "cleanup-failure",
        location: null,
        retention: "coordinator-handoff",
      },
      diagnostics: { references: [], stdoutBytes: 0, stderrBytes: 0 },
    };
    const bounded = boundedProbeQualificationResult(result);
    expect(new TextEncoder().encode(JSON.stringify(bounded)).byteLength).toBeLessThanOrEqual(
      SQLITE_FOUNDATION_PROBE_RESULT_MAX_BYTES,
    );
    expect(bounded.commit).toBe("unknown");
    expect(bounded.measuredResources).toEqual({
      processCount: 7,
      peakMemoryBytes: 512,
      diskBytes: 4096,
      outputBytes: 123,
    });
    expect(JSON.stringify(bounded)).not.toContain("secret-and-not-a-commit");
  });
});
