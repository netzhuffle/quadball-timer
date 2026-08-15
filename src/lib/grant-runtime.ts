import { randomBytes } from "node:crypto";
import { createGrantAuthorityVerifier, type GrantAuthorityOptions } from "@/lib/grant-authority";
import { loadGrantKeyRingFile } from "@/lib/grant-key-ring-custody";
import { isTechnicalAdminAuthority } from "@/lib/technical-admin-auth";

/** Runtime-only wiring for the published Grant authority module. */
export function readGrantAuthorityOptions(
  environment: "production" | "test",
  variables: Record<string, string | undefined> = process.env,
): GrantAuthorityOptions {
  const keyRingPath = variables.GRANT_KEY_RING_FILE?.trim();
  if (keyRingPath === undefined || keyRingPath.length === 0) {
    throw new Error("Grant key ring file is required for the Environment.");
  }
  const keyRing = loadGrantKeyRingFile(keyRingPath, environment, {
    requiredOwnerUid:
      environment === "test" && variables.NODE_ENV !== "production"
        ? (process.getuid?.() ?? 0)
        : variables.QBT_FOCUSED_TEST_MODE === "1"
          ? (process.getuid?.() ?? 0)
          : 0,
  }).keyRing;
  return {
    environmentId: environment,
    clock: { nowMs: () => Date.now() },
    randomness: { bytes: (length) => randomBytes(length) },
    keyRing,
    controlScopeResolver: {
      resolve: () => ({ status: "unavailable", detail: "Control scope is not available." }),
    },
    privilegedAuthorityVerifier: createGrantAuthorityVerifier((input) => {
      if (isTechnicalAdminAuthority(input)) {
        return { kind: "technical-admin", id: input.sessionId };
      }
      if (isRecord(input) && input.kind === "grant-session") {
        return typeof input.sessionBearer === "string"
          ? {
              kind: "grant-session",
              sessionBearer: input.sessionBearer,
              sessionId: "runtime-session",
            }
          : null;
      }
      return null;
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
