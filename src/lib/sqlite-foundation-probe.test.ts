import { describe, expect, test } from "bun:test";
import {
  isSupportedSqliteVersion,
  parseSqliteProbeInvocation,
  SQLITE_FOUNDATION_PROBE_WORKLOAD,
} from "@/lib/sqlite-foundation-probe";

describe("SQLite qualification workload", () => {
  test("keeps the exact release workload unchanged", () => {
    expect(SQLITE_FOUNDATION_PROBE_WORKLOAD).toEqual({
      writerCount: 6,
      rowsPerWriter: 1_000,
      passiveCheckpointAttempts: 5_000,
    });
  });

  test("recognizes only the public outer and worker invocations", () => {
    expect(parseSqliteProbeInvocation(["src/index.ts", "--sqlite-foundation-probe"])).toEqual({
      kind: "outer",
    });
    expect(
      parseSqliteProbeInvocation([
        "--sqlite-foundation-probe-writer",
        "/tmp/work",
        "00000000-0000-0000-0000-000000000000",
        "0",
      ]).kind,
    ).toBe("writer");
    expect(parseSqliteProbeInvocation(["--unexpected", "--sqlite-foundation-probe"]).kind).toBe(
      "invalid",
    );
  });

  test("fails closed below the supported SQLite version", () => {
    expect(isSupportedSqliteVersion("3.51.2")).toBe(false);
    expect(isSupportedSqliteVersion("3.51.3")).toBe(true);
    expect(isSupportedSqliteVersion("3.53.0")).toBe(true);
  });
});
