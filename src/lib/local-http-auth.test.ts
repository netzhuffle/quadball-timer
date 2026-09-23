import { expect, test } from "bun:test";
import { createDisabledLocalAuth, isLocalHttpDevelopment } from "./local-http-auth";
import { readTechnicalAdminConfig } from "./technical-admin-config";
import { isAllowedWebSocketOrigin } from "./ws-origin";

const config = readTechnicalAdminConfig({
  NODE_ENV: "development",
  PUBLIC_ORIGIN: "http://localhost:3000",
});
test("HTTP mode cannot disable authentication in deployed Test or Production", () => {
  expect(isLocalHttpDevelopment(config, { NODE_ENV: "development", LOCAL_HTTP_DEV: "1" })).toBe(
    true,
  );
  expect(isLocalHttpDevelopment(config, {})).toBe(false);
  expect(() =>
    isLocalHttpDevelopment(config, { NODE_ENV: "production", LOCAL_HTTP_DEV: "1" }),
  ).toThrow();
  expect(() =>
    isLocalHttpDevelopment(
      { ...config, environment: "production" },
      { NODE_ENV: "development", LOCAL_HTTP_DEV: "1" },
    ),
  ).toThrow();
});
test("disabled auth never issues authority, sessions, or enrollment but retains exact request admission", async () => {
  const auth = createDisabledLocalAuth(config);
  const binding = { origin: config.origin, host: "localhost:3000" };
  expect(auth.isExpectedBinding(binding)).toBe(true);
  expect(auth.isExpectedBinding({ ...binding, host: "evil.example" })).toBe(false);
  expect(auth.issueEnrollmentAuthorization().ok).toBe(false);
  expect((await auth.beginAuthentication(binding)).ok).toBe(false);
  expect(auth.authenticateSession("anything")).toBe(false);
  expect(auth.verifyCsrf("anything", "anything")).toBe(false);
  expect(auth.resolveCurrentAuthority("anything")).toBeNull();
  expect(() => auth.resolveHostLocalAuthority()).toThrow();
  expect(auth.emergencyReset().ok).toBe(false);
});
test("preview WebSockets admit only the exact configured origin and host", () => {
  const origin = "https://mars.example.ts.net:8443";
  expect(isAllowedWebSocketOrigin(origin, "mars.example.ts.net:8443", origin)).toBe(true);
  expect(isAllowedWebSocketOrigin(origin, "mars.example.ts.net:8444", origin)).toBe(false);
  expect(
    isAllowedWebSocketOrigin(
      "https://other.example.ts.net:8443",
      "mars.example.ts.net:8443",
      origin,
    ),
  ).toBe(false);
  expect(isAllowedWebSocketOrigin(origin, "mars.example.ts.net:8443")).toBe(false);
  expect(isAllowedWebSocketOrigin("http://localhost:3000", "localhost:3000", origin)).toBe(false);
  expect(isAllowedWebSocketOrigin("https://timer.quadball.app", "timer.quadball.app", origin)).toBe(
    false,
  );
});
