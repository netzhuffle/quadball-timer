import { validateOpaqueIdentifier } from "@/lib/validation-policy";
import type { GrantAuthorityActor } from "@/lib/grant-types";
import type { TechnicalAdminAuthority } from "@/lib/technical-admin-auth";

const TRUSTED_AUTHORITY = Symbol("trusted-grant-authority");

export type GrantAuthorityInput =
  | { kind: "technical-admin"; id: string }
  | TechnicalAdminAuthority
  | { kind: "grant-session"; sessionBearer: string }
  | GrantAuthorityActor;

export type TrustedGrantAuthority =
  | ({ kind: "technical-admin"; id: string } & TrustedMarker)
  | ({
      kind: "grant-session";
      sessionBearer: string;
      sessionId?: string;
      pseudonymKeyVersion?: string;
    } & TrustedMarker)
  | (GrantAuthorityActor & TrustedMarker);

export type GrantAuthorityVerifier = {
  verify(input: unknown): TrustedGrantAuthority | null;
};

export type GrantAuthorityVerification =
  | { kind: "technical-admin"; id: string }
  | { kind: "grant-session"; sessionBearer: string; sessionId: string };

type GrantTestAuthorityVerification = GrantAuthorityVerification | GrantAuthorityActor;

type TrustedMarker = {
  readonly [TRUSTED_AUTHORITY]: true;
};

export function verifyGrantAuthority(
  verifier: GrantAuthorityVerifier | undefined,
  input: unknown,
): TrustedGrantAuthority | null {
  if (verifier === undefined || typeof verifier.verify !== "function") return null;
  const candidate = verifier.verify(input);
  if (!isRecord(candidate) || candidate[TRUSTED_AUTHORITY] !== true) return null;
  if (candidate.kind === "technical-admin") {
    return validateOpaqueIdentifier(candidate.id, "authority.id").ok ? candidate : null;
  }
  if (candidate.kind === "grant-session") {
    return typeof candidate.sessionBearer === "string" && candidate.sessionBearer.length > 0
      ? candidate
      : null;
  }
  if (candidate.kind === "fixture") {
    return validateOpaqueIdentifier(candidate.id, "authority.id").ok ? candidate : null;
  }
  return null;
}

/**
 * Wraps an actual privileged-authority verification callback at the trust seam.
 * The callback owns passkey/session verification; this module owns the brand.
 */
export function createGrantAuthorityVerifier(
  verify: (input: unknown) => GrantAuthorityVerification | null,
): GrantAuthorityVerifier {
  return createBrandedAuthorityVerifier(verify, false);
}

/** Test-only branding seam. It is intentionally not re-exported by the public authority facade. */
export function createGrantTestAuthorityVerifierInternal(
  verify: (input: unknown) => GrantTestAuthorityVerification | null,
): GrantAuthorityVerifier {
  return createBrandedAuthorityVerifier(verify, true);
}

function createBrandedAuthorityVerifier(
  verify: (input: unknown) => GrantTestAuthorityVerification | null,
  allowFixture: boolean,
): GrantAuthorityVerifier {
  return {
    verify(input) {
      const verified = verify(input);
      if (!isRecord(verified)) return null;
      if (
        verified.kind === "technical-admin" &&
        !validateOpaqueIdentifier(verified.id, "authority.id").ok
      )
        return null;
      if (
        verified.kind === "grant-session" &&
        (!isNonEmptySecret(verified.sessionBearer) ||
          !validateOpaqueIdentifier(verified.sessionId, "authority.sessionId").ok)
      )
        return null;
      if (verified.kind === "fixture") {
        if (!allowFixture || !validateOpaqueIdentifier(verified.id, "authority.id").ok) return null;
      } else if (verified.kind !== "technical-admin" && verified.kind !== "grant-session") {
        return null;
      }
      return trusted(verified);
    },
  };
}

export function bindTrustedGrantSession(
  authority: TrustedGrantAuthority,
  sessionId: string,
  pseudonymKeyVersion: string,
): TrustedGrantAuthority | null {
  if (authority.kind !== "grant-session") return null;
  if (!validateOpaqueIdentifier(sessionId, "authority.sessionId").ok) return null;
  if (!validateOpaqueIdentifier(pseudonymKeyVersion, "authority.pseudonymKeyVersion").ok)
    return null;
  return trusted({ ...authority, sessionId, pseudonymKeyVersion });
}

function isNonEmptySecret(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function trusted<T extends GrantAuthorityInput>(value: T): T & TrustedMarker {
  return Object.freeze({ ...value, [TRUSTED_AUTHORITY]: true }) as unknown as T & TrustedMarker;
}

function isRecord(value: unknown): value is Record<string | symbol, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
