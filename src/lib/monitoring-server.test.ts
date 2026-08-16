import { describe, expect, test } from "bun:test";
import {
  captureOperationalFailureEvent,
  createBrowserCorrelation,
  readTrustedMonitoringIdentity,
} from "@/lib/monitoring-server";

describe("trusted monitoring release identity", () => {
  test("does not fabricate a deployed identity when the immutable manifest is unavailable", async () => {
    const identity = await readTrustedMonitoringIdentity("production", { NODE_ENV: "production" });
    expect(identity).toBe(null);
  });

  test("allows an explicit local fallback only outside production", async () => {
    const identity = await readTrustedMonitoringIdentity("test", { NODE_ENV: "development" });
    expect(identity).toEqual({
      environment: "test",
      release: "test-local",
      browserCorrelation: createBrowserCorrelation("test-local"),
    });
  });

  test("accepts only the trusted release-attempt environment value", async () => {
    const identity = await readTrustedMonitoringIdentity("production", {
      NODE_ENV: "production",
      RELEASE_ATTEMPT_ID: "sha-commit-run-123-attempt-1",
    });
    expect(identity).toEqual({
      environment: "production",
      release: "sha-commit-run-123-attempt-1",
      browserCorrelation: createBrowserCorrelation("sha-commit-run-123-attempt-1"),
    });
  });

  test("returns capture success and preserves only the operational event shape", () => {
    const captured: unknown[] = [];
    const event = {
      operation: "restore",
      environment: "test",
      releaseAttempt: "sha-safe-release-attempt",
      phase: "staged-restore",
      outcome: "failed",
      category: "staged-restore",
      timestampMs: 123_000,
    } as const;
    const identity = {
      environment: "test" as const,
      release: "sha-safe-release-attempt",
    };

    expect(captureOperationalFailureEvent(event, identity, (value) => captured.push(value))).toBe(
      true,
    );
    expect(captured).toEqual([
      {
        level: "error",
        message: "Quadball Timer operational failure",
        timestamp: 123,
        tags: {
          operationalEvent: "1",
          Environment: "test",
          ReleaseAttempt: "sha-safe-release-attempt",
          operation: "restore",
          phase: "staged-restore",
          outcome: "failed",
          category: "staged-restore",
        },
      },
    ]);
    expect(
      captureOperationalFailureEvent(event, identity, () => {
        throw new Error("monitoring transport unavailable");
      }),
    ).toBe(false);
    expect(
      captureOperationalFailureEvent(
        { ...event, environment: "production" },
        identity,
        () => undefined,
      ),
    ).toBe(false);
  });
});
