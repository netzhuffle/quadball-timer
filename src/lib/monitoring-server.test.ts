import { describe, expect, test } from "bun:test";
import {
  createBrowserCorrelation,
  initializeServerMonitoring,
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
});

describe("monitoring setup boundary", () => {
  test("disables a server client when initialization fails", async () => {
    const monitoring = initializeServerMonitoring(
      {
        dsn: "https://public@example.test/1",
        environment: "test",
        release: "release-test",
        browserCorrelation: "browser-test",
      },
      {
        init() {
          throw new Error("transport setup unavailable");
        },
        withScope() {},
        captureException() {},
        captureMessage() {},
        flush: async () => true,
      },
    );

    expect(monitoring.enabled).toBe(false);
    expect(() => monitoring.captureException(new Error("application failure"))).not.toThrow();
    expect(await monitoring.flush()).toBe(true);
  });
});
