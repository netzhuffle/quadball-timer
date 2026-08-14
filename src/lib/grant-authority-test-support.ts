import { createHash } from "node:crypto";
import {
  createGrantTestAuthorityVerifierInternal,
  type GrantAuthorityVerifier,
} from "@/lib/grant-authority-trust";
import type { FoundationStorage } from "@/lib/foundation-storage";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import type {
  AdmitControlGrantResult,
  AuthorizeControlGrantResult,
  GrantAuthority,
  GrantMutationResult,
  RevealControlGrantResult,
} from "@/lib/grant-authority-types";
import { createTypedGrantAuthority } from "@/lib/grant-management";

/** Test-only permissive authority construction. Production code must inject verified outcomes. */
export function createGrantTestAuthorityVerifier(): GrantAuthorityVerifier {
  return createGrantTestAuthorityVerifierInternal((input) => {
    if (!isRecord(input)) return null;
    if (input.kind === "technical-admin" && typeof input.id === "string")
      return { kind: "technical-admin", id: input.id };
    if (
      input.kind === "grant-session" &&
      typeof input.sessionBearer === "string" &&
      typeof input.sessionId === "string"
    )
      return {
        kind: "grant-session",
        sessionBearer: input.sessionBearer,
        sessionId: input.sessionId,
      };
    if (input.kind === "grant-session" && typeof input.sessionBearer === "string")
      return {
        kind: "grant-session",
        sessionBearer: input.sessionBearer,
        sessionId: `test-session-${createHash("sha256")
          .update(input.sessionBearer, "utf8")
          .digest("hex")
          .slice(0, 24)}`,
      };
    if (input.kind === "fixture" && typeof input.id === "string")
      return { kind: "fixture", id: input.id };
    return null;
  });
}

/** Historical Control-only names for legacy contract tests; never exported by the public facade. */
export function createLegacyControlGrantTestAuthority(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
): GrantAuthority {
  const typed = createTypedGrantAuthority(storage, options);
  return {
    async createControlGrant(input) {
      return (await typed.createControlGrant({
        scope: input.scope,
        authority: input.actor,
        expiresAtMs: input.expiresAtMs,
      })) as Awaited<ReturnType<GrantAuthority["createControlGrant"]>>;
    },
    async revealControlGrant(grantId, actor) {
      return (await typed.revealGrant(grantId, actor)) as RevealControlGrantResult;
    },
    async rotateControlGrantCredentialKeys(grantId, actor) {
      const result = await typed.rotateGrantCredentialKeys(grantId, actor);
      if (result.status !== "updated")
        return {
          status: "rejected",
          reason: result.reason === "not-found" ? "not-found" : "unavailable",
          detail: "The Grant credential cannot be rotated.",
        };
      return {
        status: "rotated",
        grantId,
        encryptionKeyVersion: options.keyRing.encryption.currentVersion,
        lookupKeyVersion: options.keyRing.lookup.currentVersion,
      };
    },
    async admitControlGrant(input) {
      return (await typed.admitGrant(input)) as AdmitControlGrantResult;
    },
    async authorizeControlGrant(input) {
      return (await typed.authorizeGrant(input)) as AuthorizeControlGrantResult;
    },
    async disableControlGrant(grantId, actor) {
      return (await typed.disableGrant(grantId, actor)) as GrantMutationResult;
    },
    async revokeControlGrant(grantId, actor) {
      return (await typed.revokeGrant(grantId, actor)) as GrantMutationResult;
    },
    listGrantSessions: (grantId, authority) => typed.listGrantSessions(grantId, authority),
    listGrantAudit: (grantId, authority) => typed.listGrantAudit(grantId, authority),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
