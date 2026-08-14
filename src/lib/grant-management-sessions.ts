import {
  computeBrowserContextDigest,
  computeSessionVerifier,
  createRandomIdentifier,
} from "@/lib/grant-crypto";
import type { FoundationStorage, FoundationStorageTransaction } from "@/lib/foundation-storage";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import {
  EVENT_ADMIN_GRANT_TYPE,
  GRANT_TYPE,
  type ControlGrantScope,
  type ControlGrantSessionResolution,
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
  terminateControlSessionForEventGame,
} from "@/lib/grant-management-policy";
import { verifyGrantAuthority } from "@/lib/grant-authority-trust";
import { auditInput, coarse, sessionLabel } from "@/lib/grant-management-audit";
import type {
  GrantManagementAuthority,
  TypedGrantAdmission,
  TypedGrantAuthorization,
  TypedControlGrantSwitch,
  TypedGrantReplayAuthorization,
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
        if (
          resolved.status !== "eligible" ||
          !validateOpaqueIdentifier(resolved.eventGameId, "eventGameId").ok
        )
          return GENERIC_GRANT_ADMISSION_FAILURE;
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
  input: {
    sessionBearer: string;
    eventGameId?: string;
    controlSessionDecision?: "stay";
  },
): Promise<TypedGrantAuthorization> {
  if (
    !isValidGrantSecret(input.sessionBearer) ||
    (input.eventGameId !== undefined &&
      !validateOpaqueIdentifier(input.eventGameId, "eventGameId").ok) ||
    (input.controlSessionDecision !== undefined && input.controlSessionDecision !== "stay")
  )
    return GENERIC_GRANT_AUTHORIZATION_FAILURE;
  try {
    return await storage.transaction((transaction) =>
      authorizeGrantInTransaction(transaction, options, input),
    );
  } catch {
    return GENERIC_GRANT_AUTHORIZATION_FAILURE;
  }
}

/** Transaction-local authorization used by the composed acceptance seam. */
export function authorizeGrantInTransaction(
  transaction: FoundationStorageTransaction,
  options: GrantAuthorityOptions,
  input: {
    sessionBearer: string;
    eventGameId?: string;
    controlSessionDecision?: "stay";
    readOnly?: boolean;
  },
): TypedGrantAuthorization {
  const session = findSessionByBearer(transaction, options, input.sessionBearer);
  if (session === null) return GENERIC_GRANT_AUTHORIZATION_FAILURE;
  const stored = transaction.findGrantById(session.grantId);
  if (stored === null) return GENERIC_GRANT_AUTHORIZATION_FAILURE;
  // Batch preflight must not refresh sessions, expire grants, or emit lifecycle
  // evidence. The accepting transaction repeats this check with the default
  // mutating behavior before it commits any action evidence.
  const grant = input.readOnly ? stored : expireGrantIfDue(transaction, options, stored);
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
      Math.min(grant.expiresAtMs ?? Number.MAX_SAFE_INTEGER, session.lastActiveAtMs + 30 * DAY_MS)
  ) {
    if (input.readOnly) return GENERIC_GRANT_AUTHORIZATION_FAILURE;
    expireSession(transaction, options, grant, session);
    return GENERIC_GRANT_AUTHORIZATION_FAILURE;
  }
  let eventGameId: string | null = null;
  if (grant.grantType === GRANT_TYPE) {
    if (input.eventGameId === undefined) return GENERIC_GRANT_AUTHORIZATION_FAILURE;
    const relationship = resolveControlSession(
      options,
      grant.scope as ControlGrantScope,
      session.eventGameId,
    );
    if (relationship.status === "game-locked") {
      if (input.readOnly) return GENERIC_GRANT_AUTHORIZATION_FAILURE;
      terminateControlSessionForEventGame(
        transaction,
        options,
        grant,
        "game-locked",
        relationship.eventGameId,
      );
      return GENERIC_GRANT_AUTHORIZATION_FAILURE;
    }
    if (relationship.status === "switchable") {
      if (
        input.controlSessionDecision === "stay" &&
        input.eventGameId === relationship.previousEventGameId
      ) {
        eventGameId = relationship.previousEventGameId;
      } else if (
        input.eventGameId === relationship.currentEventGameId ||
        (input.controlSessionDecision === undefined &&
          input.eventGameId === relationship.previousEventGameId)
      ) {
        return {
          status: "switch-required",
          grantId: grant.grantId,
          grantVersion: grant.grantVersion,
          grantType: GRANT_TYPE,
          scope: structuredClone(grant.scope as ControlGrantScope),
          grantSessionId: session.sessionId,
          previousEventGameId: relationship.previousEventGameId,
          currentEventGameId: relationship.currentEventGameId,
        } satisfies TypedGrantAuthorization;
      } else return GENERIC_GRANT_AUTHORIZATION_FAILURE;
    }
    if (relationship.status === "pinned") {
      if (input.eventGameId !== relationship.sessionEventGameId)
        return GENERIC_GRANT_AUTHORIZATION_FAILURE;
      eventGameId = relationship.sessionEventGameId;
    } else if (relationship.status === "current") {
      if (input.eventGameId !== relationship.eventGameId)
        return GENERIC_GRANT_AUTHORIZATION_FAILURE;
      eventGameId = relationship.eventGameId;
    } else if (relationship.status !== "switchable") return GENERIC_GRANT_AUTHORIZATION_FAILURE;
  }
  if (!input.readOnly) transaction.updateGrantSession({ ...session, lastActiveAtMs: nowMs });
  return {
    status: "authorized",
    grantId: grant.grantId,
    grantVersion: grant.grantVersion,
    grantType: grant.grantType,
    scope: structuredClone(grant.scope),
    eventGameId,
    grantSessionId: session.sessionId,
  };
}

export async function acceptControlGrantSessionSwitch(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  bearer: string,
): Promise<TypedControlGrantSwitch> {
  if (!isValidGrantSecret(bearer)) return GENERIC_GRANT_AUTHORIZATION_FAILURE;
  try {
    return await storage.transaction((transaction) => {
      const session = findSessionByBearer(transaction, options, bearer);
      if (session === null || session.status !== "active")
        return GENERIC_GRANT_AUTHORIZATION_FAILURE;
      const stored = transaction.findGrantById(session.grantId);
      if (stored === null || stored.grantType !== GRANT_TYPE)
        return GENERIC_GRANT_AUTHORIZATION_FAILURE;
      const grant = expireGrantIfDue(transaction, options, stored);
      if (grant.status !== "active" || grant.grantVersion !== session.grantVersion)
        return GENERIC_GRANT_AUTHORIZATION_FAILURE;
      const relationship = resolveControlSession(
        options,
        grant.scope as ControlGrantScope,
        session.eventGameId,
      );
      if (relationship.status !== "switchable") return GENERIC_GRANT_AUTHORIZATION_FAILURE;
      const nowMs = readGrantNow(options);
      transaction.updateGrantSession({
        ...session,
        eventGameId: relationship.currentEventGameId,
        lastActiveAtMs: nowMs,
      });
      transaction.appendGrantAudit(
        createAuditEntry(
          options,
          auditInput(
            "session-switched",
            grant,
            {
              kind: "session",
              sessionId: session.sessionId,
              pseudonymKeyVersion: session.browserContextKeyVersion,
            },
            "active",
            session.sessionId,
            null,
            relationship.currentEventGameId,
            null,
            null,
            null,
            null,
            relationship.previousEventGameId,
          ),
        ),
      );
      return {
        status: "switched",
        grantId: grant.grantId,
        grantVersion: grant.grantVersion,
        grantSessionId: session.sessionId,
        previousEventGameId: relationship.previousEventGameId,
        eventGameId: relationship.currentEventGameId,
      } satisfies TypedControlGrantSwitch;
    });
  } catch {
    return GENERIC_GRANT_AUTHORIZATION_FAILURE;
  }
}

export async function lockControlGrantEventGame(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  evidence: unknown,
): Promise<
  | {
      status: "locked";
      eventGameId: string;
      terminatedSessionCount: number;
    }
  | { status: "rejected"; reason: "invalid-input" | "unavailable" }
> {
  let transition:
    | {
        eventGameId: string;
        apply(transaction: import("@/lib/foundation-storage").FoundationStorageTransaction): void;
      }
    | null
    | undefined;
  try {
    transition = options.controlGrantLifecycle?.resolveEventGameLock(evidence);
  } catch {
    return { status: "rejected", reason: "unavailable" };
  }
  if (
    transition === undefined ||
    transition === null ||
    !validateOpaqueIdentifier(transition.eventGameId, "eventGameId").ok ||
    typeof transition.apply !== "function"
  )
    return { status: "rejected", reason: "invalid-input" };
  try {
    return await storage.transaction((transaction) => {
      let terminatedSessionCount = 0;
      for (const grant of transaction.listGrants()) {
        if (grant.grantType !== GRANT_TYPE) continue;
        terminatedSessionCount += terminateControlSessionForEventGame(
          transaction,
          options,
          grant,
          "game-locked",
          transition.eventGameId,
        );
      }
      transition.apply(transaction);
      return { status: "locked", eventGameId: transition.eventGameId, terminatedSessionCount };
    });
  } catch {
    return { status: "rejected", reason: "unavailable" };
  }
}

export async function authorizeControlGrantReplay(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  input: {
    sessionBearer: string;
    originatingSessionId: string;
    eventGameId: string;
    replayEvidenceId: string;
  },
): Promise<TypedGrantReplayAuthorization> {
  if (
    !isValidGrantSecret(input.sessionBearer) ||
    !validateOpaqueIdentifier(input.originatingSessionId, "originatingSessionId").ok ||
    !validateOpaqueIdentifier(input.eventGameId, "eventGameId").ok ||
    !validateOpaqueIdentifier(input.replayEvidenceId, "replayEvidenceId").ok
  )
    return GENERIC_GRANT_AUTHORIZATION_FAILURE;
  try {
    return await storage.transaction((transaction) => {
      const replacement = findSessionByBearer(transaction, options, input.sessionBearer);
      if (replacement === null || replacement.status !== "active")
        return GENERIC_GRANT_AUTHORIZATION_FAILURE;
      const stored = transaction.findGrantById(replacement.grantId);
      if (stored === null || stored.grantType !== GRANT_TYPE)
        return GENERIC_GRANT_AUTHORIZATION_FAILURE;
      const grant = expireGrantIfDue(transaction, options, stored);
      if (
        grant.status !== "active" ||
        replacement.grantVersion !== grant.grantVersion ||
        replacement.eventGameId !== input.eventGameId
      )
        return GENERIC_GRANT_AUTHORIZATION_FAILURE;
      const replay = options.controlScopeResolver.resolveReplay?.(
        grant.scope as ControlGrantScope,
        input.eventGameId,
        input.replayEvidenceId,
      );
      if (replay === undefined) return GENERIC_GRANT_AUTHORIZATION_FAILURE;
      if (replay.status !== "eligible" || replay.eventGameId !== input.eventGameId)
        return GENERIC_GRANT_AUTHORIZATION_FAILURE;
      const originating = transaction
        .listGrantSessions(grant.grantId)
        .find((candidate) => candidate.sessionId === input.originatingSessionId);
      if (
        originating === undefined ||
        originating.sessionId === replacement.sessionId ||
        originating.status === "active" ||
        originating.grantId !== grant.grantId ||
        originating.eventGameId !== input.eventGameId
      )
        return GENERIC_GRANT_AUTHORIZATION_FAILURE;
      const originatingEvidence = transaction
        .listGrantAudit(grant.grantId)
        .some(
          (audit) =>
            (audit.action === "session-admitted" || audit.action === "session-replaced") &&
            audit.sessionId === originating.sessionId &&
            audit.grantVersion === originating.grantVersion &&
            audit.eventGameId === input.eventGameId &&
            audit.grantId === originating.grantId,
        );
      if (!originatingEvidence) return GENERIC_GRANT_AUTHORIZATION_FAILURE;
      transaction.updateGrantSession({
        ...replacement,
        lastActiveAtMs: readGrantNow(options),
      });
      transaction.appendGrantAudit(
        createAuditEntry(
          options,
          auditInput(
            "replay-authorized",
            grant,
            {
              kind: "session",
              sessionId: replacement.sessionId,
              pseudonymKeyVersion: replacement.browserContextKeyVersion,
            },
            "active",
            replacement.sessionId,
            originating.sessionId,
            input.eventGameId,
            null,
            null,
            null,
            null,
            null,
            input.replayEvidenceId,
          ),
        ),
      );
      return {
        status: "authorized",
        grantId: grant.grantId,
        grantVersion: grant.grantVersion,
        grantSessionId: replacement.sessionId,
        originatingSessionId: originating.sessionId,
        eventGameId: input.eventGameId,
        replayEvidenceId: input.replayEvidenceId,
      } satisfies TypedGrantReplayAuthorization;
    });
  } catch {
    return GENERIC_GRANT_AUTHORIZATION_FAILURE;
  }
}

function resolveControlSession(
  options: GrantAuthorityOptions,
  scope: ControlGrantScope,
  sessionEventGameId: string,
): ControlGrantSessionResolution {
  if (options.controlScopeResolver.resolveSession !== undefined) {
    const resolved = options.controlScopeResolver.resolveSession(scope, sessionEventGameId);
    if (resolved.status === "current")
      return resolved.eventGameId === sessionEventGameId &&
        validateOpaqueIdentifier(resolved.eventGameId, "eventGameId").ok
        ? resolved
        : { status: "mismatch" };
    if (resolved.status === "pinned")
      return resolved.sessionEventGameId === sessionEventGameId &&
        validateOpaqueIdentifier(resolved.sessionEventGameId, "sessionEventGameId").ok &&
        validateOpaqueIdentifier(resolved.currentEventGameId, "currentEventGameId").ok
        ? resolved
        : { status: "mismatch" };
    if (resolved.status === "switchable")
      return resolved.previousEventGameId === sessionEventGameId &&
        resolved.previousEventGameId !== resolved.currentEventGameId &&
        validateOpaqueIdentifier(resolved.previousEventGameId, "previousEventGameId").ok &&
        validateOpaqueIdentifier(resolved.currentEventGameId, "currentEventGameId").ok
        ? resolved
        : { status: "mismatch" };
    if (resolved.status === "game-locked")
      return resolved.eventGameId === sessionEventGameId &&
        validateOpaqueIdentifier(resolved.eventGameId, "eventGameId").ok
        ? resolved
        : { status: "mismatch" };
    return resolved;
  }
  const current = options.controlScopeResolver.resolve(scope);
  if (
    current.status === "eligible" &&
    current.eventGameId === sessionEventGameId &&
    validateOpaqueIdentifier(current.eventGameId, "eventGameId").ok
  )
    return { status: "current", eventGameId: current.eventGameId };
  if (
    current.status === "terminal" &&
    current.reason === "game-locked" &&
    current.eventGameId === sessionEventGameId &&
    validateOpaqueIdentifier(current.eventGameId, "eventGameId").ok
  )
    return { status: "game-locked", eventGameId: current.eventGameId };
  return { status: "mismatch" };
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
