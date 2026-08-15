import { describe, expect, test } from "bun:test";
import {
  PRODUCTION_PUBLIC_ORIGIN,
  TEST_PUBLIC_ORIGIN,
  readTechnicalAdminConfig,
} from "@/lib/technical-admin-config";

describe("Technical Admin environment configuration", () => {
  test("uses the canonical Test origin for the deployed runtime", () => {
    expect(
      readTechnicalAdminConfig({ NODE_ENV: "production", QUADBALL_ENVIRONMENT: "test" }),
    ).toMatchObject({
      environment: "test",
      origin: TEST_PUBLIC_ORIGIN,
      rpId: "test.timer.quadball.app",
    });
  });

  test("rejects a Test identity combined with the Production origin", () => {
    expect(() =>
      readTechnicalAdminConfig({
        NODE_ENV: "production",
        QUADBALL_ENVIRONMENT: "test",
        PUBLIC_ORIGIN: PRODUCTION_PUBLIC_ORIGIN,
      }),
    ).toThrow("Test must not use the Production public origin");
  });

  test("rejects a Production RP ID for the deployed Test origin", () => {
    expect(() =>
      readTechnicalAdminConfig({
        NODE_ENV: "production",
        QUADBALL_ENVIRONMENT: "test",
        PUBLIC_ORIGIN: TEST_PUBLIC_ORIGIN,
        WEBAUTHN_RP_ID: "timer.quadball.app",
      }),
    ).toThrow("Test must use its canonical WebAuthn RP ID");
  });

  test("rejects a Production identity combined with the Test origin", () => {
    expect(() =>
      readTechnicalAdminConfig({
        NODE_ENV: "production",
        QUADBALL_ENVIRONMENT: "production",
        PUBLIC_ORIGIN: TEST_PUBLIC_ORIGIN,
      }),
    ).toThrow("Production must use its canonical public origin");
  });

  test("allows an explicit loopback origin for local Test startup", () => {
    expect(
      readTechnicalAdminConfig({
        NODE_ENV: "production",
        QUADBALL_ENVIRONMENT: "test",
        PUBLIC_ORIGIN: "https://localhost.test",
      }),
    ).toMatchObject({ origin: "https://localhost.test", rpId: "localhost.test" });
  });
});
