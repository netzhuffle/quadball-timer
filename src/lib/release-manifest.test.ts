import { describe, expect, test } from "bun:test";
import {
  createReleaseAttemptId,
  createReleaseManifest,
  parseReleaseManifest,
  RELEASE_BUNDLE_ALLOWLIST,
  serializeReleaseManifest,
  verifyReleaseBundle,
} from "./release-manifest";

const members = RELEASE_BUNDLE_ALLOWLIST.map((path, index) => ({
  path,
  sha256: `${String(index + 1).padStart(2, "0")}${"a".repeat(62)}`,
}));

function manifest() {
  return createReleaseManifest({
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    workflowRunId: "1234",
    workflowAttempt: "2",
    runtime: { bunVersion: "1.3.14", bunRevision: "revision", sqliteVersion: "3.49.1" },
    buildTime: "2026-08-15T00:00:00.000Z",
    schemaCompatibility: "foundation-v1",
    bundleMembers: members,
  });
}

describe("release manifest", () => {
  test("makes reruns distinct while retaining the source commit", () => {
    expect(
      createReleaseAttemptId({ sourceCommit: "abc", workflowRunId: "10", workflowAttempt: "1" }),
    ).not.toBe(
      createReleaseAttemptId({ sourceCommit: "abc", workflowRunId: "10", workflowAttempt: "2" }),
    );
    expect(manifest().sourceCommit).toBe("0123456789abcdef0123456789abcdef01234567");
  });

  test("round-trips complete runtime and bundle identity", () => {
    const parsed = parseReleaseManifest(serializeReleaseManifest(manifest()));
    expect(parsed.releaseAttemptId).toBe(
      "sha-0123456789abcdef0123456789abcdef01234567-run-1234-attempt-2",
    );
    expect(parsed.executableSha256).toBe(members[0]!.sha256);
    expect(parsed.bundleMembers).toHaveLength(RELEASE_BUNDLE_ALLOWLIST.length);
    verifyReleaseBundle(parsed, members);
  });

  test("rejects unexpected members and digest substitution", () => {
    expect(() =>
      createReleaseManifest({
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        workflowRunId: "1234",
        workflowAttempt: "2",
        runtime: { bunVersion: "1.3.14", bunRevision: "revision", sqliteVersion: "3.49.1" },
        buildTime: "2026-08-15T00:00:00.000Z",
        schemaCompatibility: "foundation-v1",
        bundleMembers: [...members, { path: ".env", sha256: "a".repeat(64) }],
      }),
    ).toThrow("Unexpected release bundle member");
    const substituted = members.map((member) =>
      member.path === "quadball-timer" ? { ...member, sha256: "b".repeat(64) } : member,
    );
    expect(() => verifyReleaseBundle(manifest(), substituted)).toThrow("digest mismatch");
  });
});
