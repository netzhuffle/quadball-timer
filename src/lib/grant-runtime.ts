import { createHash, randomBytes } from "node:crypto";
import { createGrantAuthorityVerifier, type GrantAuthorityOptions } from "@/lib/grant-authority";
import { isTechnicalAdminAuthority } from "@/lib/technical-admin-auth";
import type { GrantKeyRing } from "@/lib/grant-types";

const KEY_BYTES = 32;

/** Runtime-only wiring for the published Grant authority module. */
export function readGrantAuthorityOptions(
  environment: "production" | "test",
  variables: Record<string, string | undefined> = process.env,
): GrantAuthorityOptions {
  const keyRing = readKeyRing(environment, variables);
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

function readKeyRing(
  environment: "production" | "test",
  variables: Record<string, string | undefined>,
): GrantKeyRing {
  const names = {
    encryption: "GRANT_ENCRYPTION_KEY",
    lookup: "GRANT_LOOKUP_KEY",
    audit: "GRANT_AUDIT_KEY",
  } as const;
  const configured = Object.values(names).map((name) => variables[name]?.trim() ?? "");
  if (configured.some(Boolean)) {
    if (configured.some((value) => value.length === 0))
      throw new Error("All Grant key environment variables must be configured together.");
    return {
      encryption: { currentVersion: "v1", keys: new Map([["v1", decodeKey(configured[0]!)]]) },
      lookup: { currentVersion: "v1", keys: new Map([["v1", decodeKey(configured[1]!)]]) },
      audit: { currentVersion: "v1", keys: new Map([["v1", decodeKey(configured[2]!)]]) },
    };
  }
  if (environment === "production")
    throw new Error("Grant keys are required in the Production Environment.");
  return {
    encryption: { currentVersion: "v1", keys: new Map([["v1", testKey("encryption")]]) },
    lookup: { currentVersion: "v1", keys: new Map([["v1", testKey("lookup")]]) },
    audit: { currentVersion: "v1", keys: new Map([["v1", testKey("audit")]]) },
  };
}

function testKey(name: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(`quadball-test-grant-v1:${name}`).digest());
}

function decodeKey(value: string): Uint8Array {
  const decoded = /^[0-9a-f]{64}$/u.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64url");
  if (decoded.byteLength !== KEY_BYTES)
    throw new Error("Grant keys must contain exactly 32 bytes.");
  return new Uint8Array(decoded);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
