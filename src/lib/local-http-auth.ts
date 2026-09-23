import type {
  TechnicalAdminAuth,
  TechnicalAdminAuthConfig,
  CeremonyBinding,
} from "./technical-admin-auth";

/** Request admission is shared by passkey and Grant routes; it does not grant authority. */
export function matchesRequestOrigin(origin: string, binding: CeremonyBinding): boolean {
  return binding.origin === origin && binding.host === new URL(origin).host;
}

export function isLocalHttpDevelopment(
  config: TechnicalAdminAuthConfig,
  variables: Record<string, string | undefined> = process.env,
): boolean {
  if (variables.LOCAL_HTTP_DEV !== "1") return false;
  const url = new URL(config.origin);
  if (
    variables.NODE_ENV !== "development" ||
    config.environment !== "test" ||
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    throw new Error(
      "Local HTTP development requires a development runtime and loopback Test origin.",
    );
  }
  return true;
}

/** Disabled auth denies every authority path and never opens a credential database. */
export function createDisabledLocalAuth(config: TechnicalAdminAuthConfig): TechnicalAdminAuth {
  const denied = () => ({ ok: false as const, error: "not-authenticated" as const });
  return {
    config,
    issueEnrollmentAuthorization: denied,
    beginEnrollment: denied,
    completeEnrollment: async () => denied(),
    beginAuthentication: async () => denied(),
    completeAuthentication: async () => denied(),
    beginFreshVerification: denied,
    completeFreshVerification: async () => denied(),
    beginReplacement: denied,
    completeReplacement: async () => denied(),
    authenticateSession: () => false,
    logout: () => {},
    verifyCsrf: () => false,
    activeSessionCount: () => 0,
    resolveCurrentAuthority: () => null,
    resolveHostLocalAuthority: () => {
      throw new Error("Technical Admin requires HTTPS.");
    },
    storageStatus: () => ({
      state: "unavailable",
      credentialPresent: false,
      activeSessionCount: 0,
      generation: 0,
    }),
    startRetentionMaintenance: () => {},
    stopRetentionMaintenance: () => {},
    close: () => {},
    emergencyReset: denied,
    prepareForFoundationRestore: async () => ({ outcome: "sanitation-failed" }),
    revokeOtherSessions: denied,
    correlateSource: () => "local-http-auth-disabled",
    isExpectedBinding: (binding) => matchesRequestOrigin(config.origin, binding),
  };
}
