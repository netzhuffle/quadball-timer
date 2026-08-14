import {
  computeBrowserContextDigest,
  computeSessionVerifier,
  createRandomIdentifier,
} from "@/lib/grant-crypto";
import type { FoundationStorage } from "@/lib/foundation-storage";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import {
  EVENT_ADMIN_GRANT_TYPE,
  GRANT_TYPE,
  type ControlGrantScope,
  type StoredGrantSession,
} from "@/lib/grant-types";
import {
  GENERIC_GRANT_ADMISSION_FAILURE,
  GENERIC_GRANT_AUTHORIZATION_FAILURE,
} from "@/lib/grant-authority-types";
import { createAuditEntry, expireGrantIfDue } from "@/lib/grant-lifecycle";
import { validateOpaqueIdentifier } from "@/lib/validation-policy";
import { DAY_MS } from "@/lib/grant-calendar";
import {
  canManageInTransaction,
  credentialMatches,
  expireSession,
  findActiveContext,
  findGrantByCredential,
  findSessionByBearer,
  refreshEventAdminSession,
  resolveManagementAuthority,
  terminateControlSession,
} from "@/lib/grant-management-policy";
import { verifyGrantAuthority } from "@/lib/grant-authority-trust";
import { auditInput, coarse, sessionLabel } from "@/lib/grant-management-audit";
import type {
  GrantManagementAuthority,
  TypedGrantAdmission,
  TypedGrantAuthorization,
  TypedGrantMutation,
} from "@/lib/grant-management-types";
import {
  invalidGrant,
  isGrantRecord,
  isValidGrantSecret,
  readGrantNow,
  requireGrantBytes,
  unauthorizedGrant,
  unavailableGrant,
} from "@/lib/grant-management-results";

export async function admitGrant(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  input: {
    qrCredential: string;
    browserContext: string;
    deviceClass?: string;
    browserClass?: string;
  },
): Promise<TypedGrantAdmission> {
  if (
    !isGrantRecord(input) ||
    !isValidGrantSecret(input.qrCredential) ||
    !validateOpaqueIdentifier(input.browserContext, "browserContext").ok
  )
    return GENERIC_GRANT_ADMISSION_FAILURE;
  try {
    return await storage.transaction((transaction) => {
      const grant = findGrantByCredential(transaction, options, input.qrCredential);
      if (grant === null) return GENERIC_GRANT_ADMISSION_FAILURE;
      const current = expireGrantIfDue(transaction, options, grant);
      if (current.status !== "active" || !credentialMatches(current, options, input.qrCredential))
        return GENERIC_GRANT_ADMISSION_FAILURE;
      let eventGameId: string | null = null;
      if (current.grantType === GRANT_TYPE) {
        const resolved = options.controlScopeResolver.resolve(current.scope as ControlGrantScope);
        if (resolved.status !== "eligible") return GENERIC_GRANT_ADMISSION_FAILURE;
        eventGameId = resolved.eventGameId;
      }
      const nowMs = readGrantNow(options);
      const lookupVersion = options.keyRing.lookup.currentVersion;
      const contextDigest = computeBrowserContextDigest(
        input.browserContext,
        options.keyRing,
        lookupVersion,
      );
      const previous = findActiveContext(
        transaction,
        current.grantId,
        options,
        input.browserContext,
      );
      if (previous !== null)
        transaction.updateGrantSession({ ...previous, status: "revoked", revokedAtMs: nowMs });
      const bearer = Buffer.from(requireGrantBytes(options.randomness, 32)).toString("base64url");
      const session: StoredGrantSession = {
        sessionId: createRandomIdentifier("grant-session", options.randomness),
        grantId: current.grantId,
        grantVersion: current.grantVersion,
        eventGameId: eventGameId ?? "grant-management",
        browserContextDigest: contextDigest,
        browserContextKeyVersion: lookupVersion,
        bearerMaterialState: "present",
        bearerLookupVerifier: computeSessionVerifier(bearer, options.keyRing, lookupVersion),
        bearerLookupKeyVersion: lookupVersion,
        status: "active",
        createdAtMs: nowMs,
        lastActiveAtMs: nowMs,
        revokedAtMs: null,
        deviceClass: coarse(input.deviceClass),
        browserClass: coarse(input.browserClass),
      };
      transaction.insertGrantSession(session);
      transaction.appendGrantAudit(
        createAuditEntry(
          options,
          auditInput(
            previous === null ? "session-admitted" : "session-replaced",
            current,
            {
              kind: "session",
              sessionId: session.sessionId,
              pseudonymKeyVersion: session.browserContextKeyVersion,
            },
            "active",
            session.sessionId,
            previous?.sessionId ?? null,
            eventGameId,
          ),
        ),
      );
      return {
        status: "admitted",
        grantId: current.grantId,
        grantVersion: current.grantVersion,
        grantType: current.grantType,
        scope: structuredClone(current.scope),
        eventGameId,
        grantSessionId: session.sessionId,
        sessionBearer: bearer,
      };
    });
  } catch {
    return GENERIC_GRANT_ADMISSION_FAILURE;
  }
}

export async function authorizeGrant(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  bearer: string,
): Promise<TypedGrantAuthorization> {
  if (!isValidGrantSecret(bearer)) return GENERIC_GRANT_AUTHORIZATION_FAILURE;
  try {
    return await storage.transaction((transaction) => {
      const session = findSessionByBearer(transaction, options, bearer);
      if (session === null) return GENERIC_GRANT_AUTHORIZATION_FAILURE;
      const stored = transaction.findGrantById(session.grantId);
      if (stored === null) return GENERIC_GRANT_AUTHORIZATION_FAILURE;
      const grant = expireGrantIfDue(transaction, options, stored);
      if (
        grant.status !== "active" ||
        session.status !== "active" ||
        session.grantVersion !== grant.grantVersion
      )
        return GENERIC_GRANT_AUTHORIZATION_FAILURE;
      const nowMs = readGrantNow(options);
      if (
        grant.grantType === EVENT_ADMIN_GRANT_TYPE &&
        nowMs >=
          Math.min(
            grant.expiresAtMs ?? Number.MAX_SAFE_INTEGER,
            session.lastActiveAtMs + 30 * DAY_MS,
          )
      ) {
        expireSession(transaction, options, grant, session);
        return GENERIC_GRANT_AUTHORIZATION_FAILURE;
      }
      let eventGameId: string | null = null;
      if (grant.grantType === GRANT_TYPE) {
        const resolved = options.controlScopeResolver.resolve(grant.scope as ControlGrantScope);
        if (resolved.status === "terminal") {
          terminateControlSession(transaction, options, grant, resolved.reason);
          return GENERIC_GRANT_AUTHORIZATION_FAILURE;
        }
        if (resolved.status !== "eligible" || resolved.eventGameId !== session.eventGameId)
          return GENERIC_GRANT_AUTHORIZATION_FAILURE;
        eventGameId = resolved.eventGameId;
      }
      transaction.updateGrantSession({ ...session, lastActiveAtMs: nowMs });
      return {
        status: "authorized",
        grantId: grant.grantId,
        grantVersion: grant.grantVersion,
        grantType: grant.grantType,
        scope: structuredClone(grant.scope),
        eventGameId,
        grantSessionId: session.sessionId,
      };
    });
  } catch {
    return GENERIC_GRANT_AUTHORIZATION_FAILURE;
  }
}

export async function revokeGrantSession(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  grantId: string,
  sessionReference: string,
  authority: GrantManagementAuthority,
): Promise<TypedGrantMutation> {
  const trustedAuthority = verifyGrantAuthority(options.privilegedAuthorityVerifier, authority);
  if (trustedAuthority === null) return unauthorizedGrant();
  try {
    return await storage.transaction((transaction) => {
      const storedGrant = transaction.findGrantById(grantId);
      if (storedGrant === null) return { status: "rejected", reason: "not-found" };
      const grant = expireGrantIfDue(transaction, options, storedGrant);
      const resolvedAuthority = resolveManagementAuthority(transaction, options, trustedAuthority);
      if (
        grant.status !== "active" ||
        resolvedAuthority === null ||
        !canManageInTransaction(transaction, options, grant, resolvedAuthority, "manage")
      )
        return unauthorizedGrant();
      const matches = transaction
        .listGrantSessions(grantId)
        .filter((candidate) => sessionLabel(options, candidate) === sessionReference);
      if (matches.length !== 1) return { status: "rejected", reason: "not-found" };
      const session = matches[0];
      if (session === undefined) return { status: "rejected", reason: "not-found" };
      if (session.status !== "active")
        return {
          status: "rejected",
          reason: "invalid-state",
          detail: "Grant Session is already inactive.",
        };
      transaction.updateGrantSession({
        ...session,
        status: "revoked",
        revokedAtMs: readGrantNow(options),
      });
      transaction.appendGrantAudit(
        createAuditEntry(
          options,
          auditInput("session-revoked", grant, resolvedAuthority, grant.status, session.sessionId),
        ),
      );
      refreshEventAdminSession(transaction, options, resolvedAuthority);
      return { status: "updated", grantId, grantVersion: grant.grantVersion };
    });
  } catch {
    return unavailableGrant();
  }
}

export async function leaveGrantSession(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  sessionBearer: string,
): Promise<TypedGrantMutation> {
  if (!isValidGrantSecret(sessionBearer)) return invalidGrant("Grant Session bearer is invalid.");
  try {
    return await storage.transaction((transaction) => {
      const session = findSessionByBearer(transaction, options, sessionBearer);
      if (session === null) return unauthorizedGrant();
      const stored = transaction.findGrantById(session.grantId);
      if (stored === null) return unauthorizedGrant();
      const grant = expireGrantIfDue(transaction, options, stored);
      if (
        grant.status !== "active" ||
        session.status !== "active" ||
        session.grantVersion !== grant.grantVersion
      )
        return unauthorizedGrant();
      transaction.updateGrantSession({
        ...session,
        status: "expired",
        bearerMaterialState: "erased",
        bearerLookupVerifier: null,
        bearerLookupKeyVersion: null,
        revokedAtMs: readGrantNow(options),
      });
      transaction.appendGrantAudit(
        createAuditEntry(
          options,
          auditInput(
            "session-revoked",
            grant,
            {
              kind: "session",
              sessionId: session.sessionId,
              pseudonymKeyVersion: session.browserContextKeyVersion,
            },
            grant.status,
            session.sessionId,
          ),
        ),
      );
      return { status: "updated", grantId: grant.grantId, grantVersion: grant.grantVersion };
    });
  } catch {
    return unavailableGrant();
  }
}
