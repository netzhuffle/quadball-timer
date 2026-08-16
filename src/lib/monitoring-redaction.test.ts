import { describe, expect, test } from "bun:test";
import type { Event } from "@sentry/core";
import {
  browserMonitoringPublicConfig,
  redactText,
  sendRedactedEvent,
  serializeBrowserMonitoringConfig,
} from "@/lib/monitoring-redaction";
import { redactServerEventForTest } from "@/lib/monitoring-server";

describe("monitoring redaction boundary", () => {
  test("sends only the reviewed event shape to a fake transport", async () => {
    const sent: Event[] = [];
    await sendRedactedEvent(
      {
        event_id: "0123456789abcdef0123456789abcdef",
        message: "Team name Falcons scored 7 points; authorization=Bearer very-secret-token",
        environment: "attacker-controlled",
        release: "attacker-release",
        tags: {
          category: "server",
          operation: "open",
          environment: "test",
          releaseAttempt: "sha-safe-release-attempt",
          grantCode: "raw-grant-code",
          userInput: "private team name",
        },
        request: {
          url: "https://timer.example/api/grants?code=raw-grant-code",
          headers: {
            authorization: "Bearer very-secret-token",
            cookie: "grant_session=private-cookie",
          },
          data: {
            qrCredential: "raw-qr-value",
            grantSession: { bearer: "raw-session" },
          },
        },
        contexts: {
          grant: { code: "raw-grant-code", key: "private-key" },
          audit: { trail: "private audit" },
        },
        extra: {
          body: { password: "raw-password" },
          database: "/var/lib/quadball-timer/foundation.sqlite",
        },
        exception: {
          values: [
            {
              type: "Error",
              value: "failed at /var/lib/quadball-timer/foundation.sqlite token=secret",
              stacktrace: {
                frames: [
                  {
                    filename: "/var/lib/quadball-timer/src/index.ts",
                    function: "handleRequest",
                    lineno: 42,
                  },
                ],
              },
            },
          ],
        },
      },
      {
        environment: "test",
        release: "sha-safe-release-attempt",
        browserCorrelation: "release-safe-alias",
      },
      (event) => {
        sent.push(event);
      },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      environment: "test",
      release: "sha-safe-release-attempt",
      message: "Quadball Timer application error",
      tags: {
        Environment: "test",
        Release: "sha-safe-release-attempt",
        ReleaseAttempt: "sha-safe-release-attempt",
        BrowserCorrelation: "release-safe-alias",
        category: "server",
        operation: "open",
      },
    });
    expect(sent[0]).not.toHaveProperty("request");
    expect(sent[0]).not.toHaveProperty("contexts");
    expect(sent[0]).not.toHaveProperty("extra");
    expect(sent[0]).toMatchObject({
      exception: { values: [{ type: "Error", value: "Application exception" }] },
    });
    expect(JSON.stringify(sent[0])).not.toContain("raw-grant-code");
    expect(JSON.stringify(sent[0])).not.toContain("raw-session");
    expect(JSON.stringify(sent[0])).not.toContain("private audit");
    expect(JSON.stringify(sent[0])).not.toContain("foundation.sqlite");
    expect(JSON.stringify(sent[0])).not.toContain("Falcons");
    expect(JSON.stringify(sent[0])).not.toContain("7 points");
  });

  test("keeps trusted identity when event fields try to override it", async () => {
    const sent: Event[] = [];
    await sendRedactedEvent(
      {
        environment: "production",
        release: "request-release",
        tags: {
          Environment: "request-environment",
          Release: "request-release",
          BrowserCorrelation: "request-alias",
          environment: "production",
          releaseAttempt: "request-release",
        },
        message: "safe failure",
      },
      {
        environment: "test",
        release: "sha-trusted",
        browserCorrelation: "release-trusted-alias",
      },
      (event) => {
        sent.push(event);
      },
    );

    expect(sent[0]).toMatchObject({
      environment: "test",
      release: "sha-trusted",
      tags: {
        Environment: "test",
        Release: "sha-trusted",
        BrowserCorrelation: "release-trusted-alias",
      },
    });
  });

  test("composes a real operational event through the reviewed server redaction boundary", () => {
    const redacted = redactServerEventForTest(
      {
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
        request: { url: "https://timer.example/private" },
        extra: { secret: "never-send" },
      },
      {
        environment: "test",
        release: "sha-safe-release-attempt",
        browserCorrelation: "release-safe-alias",
      },
    );

    expect(redacted).toMatchObject({
      timestamp: 123,
      tags: {
        Environment: "test",
        ReleaseAttempt: "sha-safe-release-attempt",
        operation: "restore",
        phase: "staged-restore",
        outcome: "failed",
        category: "staged-restore",
      },
    });
    expect(redacted).not.toHaveProperty("request");
    expect(redacted).not.toHaveProperty("extra");
  });

  test("keeps operational events to the fixed allowlist", () => {
    const redacted = redactServerEventForTest(
      {
        platform: "javascript",
        logger: "attacker-controlled",
        message: "secret command /var/lib/private token=secret",
        tags: {
          operationalEvent: "1",
          Environment: "test",
          ReleaseAttempt: "sha-safe-release-attempt",
          operation: "restore",
          phase: "staged-restore",
          outcome: "failed",
          category: "technical-admin-auth-sanitization",
          BrowserCorrelation: "must-not-leave",
        },
        request: { url: "https://timer.example/private" },
        extra: { stdout: "secret" },
      },
      {
        environment: "test",
        release: "sha-safe-release-attempt",
        browserCorrelation: "release-safe-alias",
      },
    );

    expect(redacted).toEqual({
      timestamp: undefined,
      level: "error",
      message: "Quadball Timer operational failure",
      tags: {
        operation: "restore",
        Environment: "test",
        ReleaseAttempt: "sha-safe-release-attempt",
        phase: "staged-restore",
        outcome: "failed",
        category: "technical-admin-auth-sanitization",
      },
    });
    expect(JSON.stringify(redacted)).not.toContain("secret");
    expect(JSON.stringify(redacted)).not.toContain("BrowserCorrelation");
  });

  test("redacts Basic credentials and plausible key material before rewrites", () => {
    for (const length of [32, 64, 96]) {
      const material = "a".repeat(length);
      const redacted = redactText(`Basic basic-secret ${material}`);
      expect(redacted).not.toContain("basic-secret");
      expect(redacted).not.toContain(material);
    }
  });

  test("publishes only the browser correlation alias", () => {
    const exactRelease = "sha-production-run-123-attempt-1";
    const alias = "release-0123456789abcdef";
    const serialized = serializeBrowserMonitoringConfig(
      browserMonitoringPublicConfig(
        { environment: "production", release: exactRelease, browserCorrelation: alias },
        "https://public@example.test/1",
      ),
    );
    expect(serialized).toContain(alias);
    expect(serialized).not.toContain(exactRelease);
  });
});
