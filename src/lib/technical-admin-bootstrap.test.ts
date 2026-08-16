import { describe, expect, test } from "bun:test";
import {
  MemoryTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
} from "@/lib/technical-admin-auth";
import {
  createTechnicalAdminBootstrapOperations,
  parseTechnicalAdminBootstrapCli,
} from "@/lib/technical-admin-bootstrap";

const config = {
  environment: "test" as const,
  origin: "https://test.timer.example",
  rpId: "test.timer.example",
};

function createFixture() {
  const repository = new MemoryTechnicalAdminAuthRepository({
    environment: config.environment,
    origin: config.origin,
    rpId: config.rpId,
  });
  const auth = createTechnicalAdminAuth(config, repository, undefined, () => 1_000);
  return { auth, repository };
}

describe("Technical Admin bootstrap maintenance", () => {
  test("parses only complete bounded maintenance commands", () => {
    expect(parseTechnicalAdminBootstrapCli(["--technical-admin-bootstrap", "status"])).toEqual({
      kind: "operation",
      command: "status",
    });
    expect(parseTechnicalAdminBootstrapCli(["--technical-admin-bootstrap", "enroll"])).toEqual({
      kind: "operation",
      command: "enroll",
    });
    expect(parseTechnicalAdminBootstrapCli(["--technical-admin-bootstrap", "reset"])).toEqual({
      kind: "operation",
      command: "reset",
    });
    expect(
      parseTechnicalAdminBootstrapCli(["--technical-admin-bootstrap", "reset", "test"]).kind,
    ).toBe("invalid");
    expect(
      parseTechnicalAdminBootstrapCli(["unexpected", "--technical-admin-bootstrap", "status"]),
    ).toEqual({ kind: "invalid", error: "Incomplete Technical Admin bootstrap command." });
    expect(
      parseTechnicalAdminBootstrapCli(["src/index.ts", "--technical-admin-bootstrap", "status"]),
    ).toEqual({ kind: "operation", command: "status" });
    expect(parseTechnicalAdminBootstrapCli(["--technical-admin-bootstrap", "unknown"])).toEqual({
      kind: "invalid",
      error: "Unknown Technical Admin bootstrap command.",
    });
  });

  test("reports only redacted readiness and authority counts", () => {
    const fixture = createFixture();
    const operations = createTechnicalAdminBootstrapOperations(config, fixture.auth);

    expect(operations.status()).toEqual({
      environment: "test",
      credentialPresent: false,
      activeSessionCount: 0,
      storage: "ready",
    });
    expect(JSON.stringify(operations.status())).not.toContain(config.origin);
    expect(JSON.stringify(operations.status())).not.toContain(config.rpId);
    fixture.auth.close();
  });

  test("keeps enrollment bounded and requires the exact Environment for reset", () => {
    const fixture = createFixture();
    const operations = createTechnicalAdminBootstrapOperations(config, fixture.auth);

    const enrollment = operations.enroll();
    expect(enrollment.ok).toBe(true);
    if (!enrollment.ok) return;
    expect(enrollment.value.url).toMatch(
      /^https:\/\/test\.timer\.example\/admin\/enroll#token=[^&\n]+$/u,
    );

    expect(operations.reset("TEST")).toEqual({ ok: false, error: "invalid-confirmation" });
    expect(fixture.repository.hasCredential()).toBe(false);
    const reset = operations.reset("test");
    expect(reset.ok).toBe(true);
    if (reset.ok) expect(reset.value.url).toMatch(/#token=[^&\n]+$/u);
    fixture.auth.close();
  });
});
