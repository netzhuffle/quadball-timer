import type {
  TechnicalAdminAuthConfig,
  TechnicalAdminEnvironment,
} from "@/lib/technical-admin-auth";

export const PRODUCTION_PUBLIC_ORIGIN = "https://timer.quadball.app";
export const TEST_PUBLIC_ORIGIN = "https://test.timer.quadball.app";
const PRODUCTION_RP_ID = new URL(PRODUCTION_PUBLIC_ORIGIN).hostname;
const TEST_RP_ID = new URL(TEST_PUBLIC_ORIGIN).hostname;

export function readTechnicalAdminConfig(
  environmentVariables: Record<string, string | undefined> = process.env,
): TechnicalAdminAuthConfig {
  const port = Number(environmentVariables.PORT ?? 3000);
  const environment: TechnicalAdminEnvironment =
    environmentVariables.QUADBALL_ENVIRONMENT === "production"
      ? "production"
      : environmentVariables.QUADBALL_ENVIRONMENT === "test" ||
          environmentVariables.NODE_ENV !== "production"
        ? "test"
        : "production";
  const origin =
    environmentVariables.PUBLIC_ORIGIN ??
    (environment === "test"
      ? environmentVariables.NODE_ENV === "production"
        ? TEST_PUBLIC_ORIGIN
        : `https://localhost:${port}`
      : PRODUCTION_PUBLIC_ORIGIN);
  assertEnvironmentOriginBoundary(environment, origin);
  const rpId = readWebAuthnRpId(environment, origin, environmentVariables);
  const logKey = environmentVariables.TECHNICAL_ADMIN_LOG_KEY;
  const trustProxyHeaders = environmentVariables.TRUSTED_PROXY_HEADERS === "true";
  return { environment, origin, rpId, logKey, trustProxyHeaders };
}

function readWebAuthnRpId(
  environment: TechnicalAdminEnvironment,
  origin: string,
  environmentVariables: Record<string, string | undefined>,
): string {
  const configuredRpId = environmentVariables.WEBAUTHN_RP_ID?.trim();
  if (environment !== "test") {
    return configuredRpId ?? new URL(origin).hostname;
  }

  if (origin === TEST_PUBLIC_ORIGIN) {
    if (configuredRpId !== undefined && configuredRpId !== TEST_RP_ID) {
      throw new Error("Test must use its canonical WebAuthn RP ID.");
    }
    return TEST_RP_ID;
  }

  if (configuredRpId === PRODUCTION_RP_ID) {
    throw new Error("Test must not use the Production WebAuthn RP ID.");
  }
  return configuredRpId ?? new URL(origin).hostname;
}

function assertEnvironmentOriginBoundary(
  environment: TechnicalAdminEnvironment,
  origin: string,
): void {
  const normalizedOrigin = new URL(origin).origin;
  if (normalizedOrigin !== origin) {
    throw new Error("PUBLIC_ORIGIN must be an exact origin without a path.");
  }

  if (environment === "production" && origin !== PRODUCTION_PUBLIC_ORIGIN) {
    throw new Error("Production must use its canonical public origin.");
  }

  if (environment === "test" && origin === PRODUCTION_PUBLIC_ORIGIN) {
    throw new Error("Test must not use the Production public origin.");
  }
}
