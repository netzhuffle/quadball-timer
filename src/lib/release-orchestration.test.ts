import { describe, expect, test } from "bun:test";
import { RELEASE_BUNDLE_ALLOWLIST } from "./release-manifest";
import {
  makeReleaseManifest,
  runReleaseAttempt,
  type ReleaseEnvironmentAdapter,
} from "./release-orchestration";

const manifest = makeReleaseManifest({
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
  workflowRunId: "1234",
  workflowAttempt: "1",
  runtime: { bunVersion: "1.3.14", bunRevision: "revision", sqliteVersion: "3.49.1" },
  buildTime: "2026-08-15T00:00:00.000Z",
  schemaCompatibility: "foundation-v1",
  bundleMembers: RELEASE_BUNDLE_ALLOWLIST.map((path, index) => ({
    path,
    sha256: `${String(index + 1).padStart(2, "0")}${"a".repeat(62)}`,
  })),
});

function adapter(
  environment: "production" | "test",
  events: string[],
  failurePhase?: "stage" | "verify" | "finalize",
): ReleaseEnvironmentAdapter {
  return {
    environment,
    async acquireLock() {
      events.push(`${environment}:lock`);
      return () => {
        events.push(`${environment}:unlock`);
      };
    },
    async verifyConfiguration() {
      events.push(`${environment}:configuration`);
    },
    async stage() {
      events.push(`${environment}:stage`);
      if (failurePhase === "stage") throw new Error("stage failed");
    },
    async finalize() {
      events.push(`${environment}:finalize`);
      if (failurePhase === "finalize") throw new Error("finalize failed");
    },
    async activate() {
      events.push(`${environment}:activate`);
    },
    async verify() {
      events.push(`${environment}:verify`);
      if (failurePhase === "verify") throw new Error("verify failed");
    },
    async currentRelease() {
      events.push(`${environment}:current`);
      return { releaseAttemptId: `${environment}-prior`, schemaCompatibility: "foundation-v1" };
    },
    async rollback(releaseAttemptId) {
      events.push(`${environment}:rollback:${releaseAttemptId}`);
    },
    async prune() {
      events.push(`${environment}:prune`);
    },
  };
}

describe("release orchestration", () => {
  test("runs both environments independently and protects the prior release", async () => {
    const events: string[] = [];
    const report = await runReleaseAttempt({
      manifest,
      environments: [adapter("production", events), adapter("test", events)],
    });
    expect(report.status).toBe("succeeded");
    expect(report.environments.production.status).toBe("succeeded");
    expect(report.environments.test.status).toBe("succeeded");
    expect(report.environments.production.phase).toBe("verified");
    expect(events).toContain("production:prune");
    expect(events).toContain("test:prune");
  });

  test("reports one environment failure without hiding the other outcome", async () => {
    const events: string[] = [];
    const report = await runReleaseAttempt({
      manifest,
      environments: [adapter("production", events, "verify"), adapter("test", events)],
    });
    expect(report.status).toBe("failed");
    expect(report.environments.production.status).toBe("failed");
    expect(report.environments.production.phase).toBe("verification");
    expect(report.environments.production.rollbackReleaseAttemptId).toBe("production-prior");
    expect(report.environments.test.status).toBe("succeeded");
    expect(events).toContain("production:rollback:production-prior");
    expect(events).toContain("test:prune");
  });

  test("keeps a Test-only failure independent from Production", async () => {
    const events: string[] = [];
    const report = await runReleaseAttempt({
      manifest,
      environments: [adapter("production", events), adapter("test", events, "verify")],
    });

    expect(report.status).toBe("failed");
    expect(report.environments.production.status).toBe("succeeded");
    expect(report.environments.test.status).toBe("failed");
    expect(report.environments.test.rollbackReleaseAttemptId).toBe("test-prior");
    expect(events).toContain("production:prune");
    expect(events).toContain("test:rollback:test-prior");
  });

  test("reports both failures and rolls each environment back independently", async () => {
    const events: string[] = [];
    const report = await runReleaseAttempt({
      manifest,
      environments: [adapter("production", events, "verify"), adapter("test", events, "verify")],
    });

    expect(report.status).toBe("failed");
    expect(report.environments.production.status).toBe("failed");
    expect(report.environments.test.status).toBe("failed");
    expect(events).toContain("production:rollback:production-prior");
    expect(events).toContain("test:rollback:test-prior");
  });

  test("does not roll back or disturb the current release after lock or staging failure", async () => {
    const events: string[] = [];
    const lockContended: ReleaseEnvironmentAdapter = {
      ...adapter("production", events),
      async acquireLock() {
        events.push("production:lock-contention");
        throw new Error("lock busy");
      },
    };
    const report = await runReleaseAttempt({
      manifest,
      environments: [lockContended, adapter("test", events, "stage")],
    });

    expect(report.status).toBe("failed");
    expect(report.environments.production.phase).toBe("lock-acquisition");
    expect(report.environments.test.phase).toBe("staging");
    expect(report.environments.production.rollbackReleaseAttemptId).toBeNull();
    expect(report.environments.test.rollbackReleaseAttemptId).toBeNull();
    expect(events).not.toContain("production:rollback:production-prior");
    expect(events).not.toContain("test:rollback:test-prior");
  });

  test("always releases each environment lock after a failed activation", async () => {
    const events: string[] = [];
    await runReleaseAttempt({
      manifest,
      environments: [adapter("production", events, "verify"), adapter("test", events)],
    });

    expect(events).toContain("production:unlock");
    expect(events).toContain("test:unlock");
  });
});
