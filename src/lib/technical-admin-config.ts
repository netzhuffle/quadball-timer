import type {
  TechnicalAdminAuthConfig,
  TechnicalAdminEnvironment,
} from "@/lib/technical-admin-auth";
import { readRuntimeStoragePaths } from "@/lib/runtime-storage-config";

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
    (environment === "test" ? `https://localhost:${port}` : "https://timer.quadball.app");
  const rpId = environmentVariables.WEBAUTHN_RP_ID ?? new URL(origin).hostname;
  const databasePath = readRuntimeStoragePaths(
    environment,
    environmentVariables,
  ).technicalAdminDatabase;
  const logKey = environmentVariables.TECHNICAL_ADMIN_LOG_KEY;
  const trustProxyHeaders = environmentVariables.TRUSTED_PROXY_HEADERS === "true";
  return { environment, origin, rpId, databasePath, logKey, trustProxyHeaders };
}
