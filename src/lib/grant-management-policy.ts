import {
  computeBrowserContextDigest,
  computeLookupDigest,
  computeSessionVerifier,
  decryptCredential,
  listLookupKeyVersions,
  parseCredentialToken,
  sameSecret,
} from "@/lib/grant-crypto";
import type { FoundationStorageTransaction } from "@/lib/foundation-storage";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import { DAY_MS } from "@/lib/grant-calendar";
import { createAuditEntry, expireGrantIfDue } from "@/lib/grant-lifecycle";
import type {
  ControlGrantScope,
  EventAdminGrantScope,
  GrantScope,
  PitchManagerGrantScope,
  StoredGrant,
  StoredGrantSession,
} from "@/lib/grant-types";
import type { TrustedGrantAuthority } from "@/lib/grant-authority-trust";
import { bindTrustedGrantSession } from "@/lib/grant-authority-trust";
import { validateOpaqueIdentifier } from "@/lib/validation-policy";

/**
 * Grant-Code creation and full rotation must use the same live resolver as
 * admission. This is deliberately a read-only policy check; callers that
 * need lifecycle cleanup use the management authorization path instead.
 */
export function hasCurrentAdmissionEligibility(
  options: GrantAuthorityOptions,
  grant: StoredGrant,
): boolean {
  if (grant.grantType !== "control") return true;
  try {
    const resolved = options.controlScopeResolver.resolve(grant.scope as ControlGrantScope);
    return (
      resolved.status === "eligible" &&
      validateOpaqueIdentifier(resolved.eventGameId, "eventGameId").ok
    );
  } catch {
    return false;
  }
}

export function canInspectInTransaction(
  transaction: FoundationStorageTransaction,
  options: GrantAuthorityOptions,
  grant: StoredGrant,
  authority: TrustedGrantAuthority,
): boolean {
  authority = resolveManagementAuthority(transaction, options, authority) ?? authority;
  if (authority.kind === "technical-admin" || authority.kind === "fixture") return true;
  if (authority.kind !== "grant-session") return false;
  const session = findSessionByBearer(transaction, options, authority.sessionBearer);
  if (session === null || session.status !== "active") return false;
  const storedCaller = transaction.findGrantById(session.grantId);
  if (storedCaller === null) return false;
  const caller = expireGrantIfDue(transaction, options, storedCaller);
  if (caller.status !== "active" || caller.grantVersion !== session.grantVersion) return false;
  if (caller.grantType !== "event-admin") return false;
  const nowMs = readNow(options);
  if (
    nowMs >=
    Math.min(caller.expiresAtMs ?? Number.MAX_SAFE_INTEGER, session.lastActiveAtMs + 30 * DAY_MS)
  ) {
    expireSession(transaction, options, caller, session);
    return false;
  }
  return (caller.scope as EventAdminGrantScope).eventId === grant.scope.eventId;
}

/** Session-summary inspection is narrower than Grant Audit Trail inspection. */
export function canInspectSessionSummariesInTransaction(
  transaction: FoundationStorageTransaction,
  options: GrantAuthorityOptions,
  grant: StoredGrant,
  authority: TrustedGrantAuthority,
): boolean {
  authority = resolveManagementAuthority(transaction, options, authority) ?? authority;
  if (authority.kind === "technical-admin" || authority.kind === "fixture") return true;
  if (authority.kind !== "grant-session") return false;

  const session = findSessionByBearer(transaction, options, authority.sessionBearer);
  if (session === null || session.status !== "active") return false;
  const storedCaller = transaction.findGrantById(session.grantId);
  if (storedCaller === null) return false;
  const caller = expireGrantIfDue(transaction, options, storedCaller);
  if (caller.status !== "active" || caller.grantVersion !== session.grantVersion) return false;

  if (caller.grantType === "event-admin") {
    const nowMs = readNow(options);
    if (
      nowMs >=
      Math.min(caller.expiresAtMs ?? Number.MAX_SAFE_INTEGER, session.lastActiveAtMs + 30 * DAY_MS)
    ) {
      expireSession(transaction, options, caller, session);
      return false;
    }
    return (caller.scope as EventAdminGrantScope).eventId === grant.scope.eventId;
  }

  if (caller.grantType !== "pitch-manager" || grant.grantType !== "control") return false;
  const callerScope = caller.scope as PitchManagerGrantScope;
  const targetScope = grant.scope as ControlGrantScope;
  return (
    callerScope.eventId === targetScope.eventId &&
    callerScope.gameDayId === targetScope.gameDayId &&
    callerScope.pitchId === targetScope.pitchId
  );
}

/** Refresh only a successful Event Admin operation; this never changes the Grant cap. */
export function refreshEventAdminSession(
  transaction: FoundationStorageTransaction,
  options: GrantAuthorityOptions,
  authority: TrustedGrantAuthority,
): void {
  if (authority.kind !== "grant-session") return;
  const session = findSessionByBearer(transaction, options, authority.sessionBearer);
  if (session === null || session.status !== "active") return;
  const storedGrant = transaction.findGrantById(session.grantId);
  if (storedGrant === null) return;
  const grant = expireGrantIfDue(transaction, options, storedGrant);
  if (grant.status !== "active" || grant.grantType !== "event-admin") return;
  const nowMs = readNow(options);
  if (
    nowMs >=
    Math.min(grant.expiresAtMs ?? Number.MAX_SAFE_INTEGER, session.lastActiveAtMs + 30 * DAY_MS)
  ) {
    expireSession(transaction, options, grant, session);
    return;
  }
  transaction.updateGrantSession({ ...session, lastActiveAtMs: nowMs });
}

export function canManageInTransaction(
  transaction: FoundationStorageTransaction,
  options: GrantAuthorityOptions,
  grant: StoredGrant,
  authority: TrustedGrantAuthority,
  operation: "manage" | "reveal",
): boolean {
  authority = resolveManagementAuthority(transaction, options, authority) ?? authority;
  if (authority.kind === "technical-admin") return grant.grantType === "event-admin";
  if (authority.kind === "fixture") return true;
  if (authority.kind !== "grant-session") return false;
  const session = findSessionByBearer(transaction, options, authority.sessionBearer);
  if (
    session === null ||
    session.status !== "active" ||
    session.grantVersion !== transaction.findGrantById(session.grantId)?.grantVersion
  )
    return false;
  const storedCaller = transaction.findGrantById(session.grantId);
  if (storedCaller === null) return false;
  const caller = expireGrantIfDue(transaction, options, storedCaller);
  if (caller.status !== "active") return false;
  const nowMs = readNow(options);
  if (
    caller.grantType === "event-admin" &&
    nowMs >=
      Math.min(caller.expiresAtMs ?? Number.MAX_SAFE_INTEGER, session.lastActiveAtMs + 30 * DAY_MS)
  ) {
    expireSession(transaction, options, caller, session);
    return false;
  }
  if (caller.grantType === "control") {
    const resolved = options.controlScopeResolver.resolve(
      caller.scope as ControlGrantScope,
      transaction,
    );
    if (resolved.status === "terminal") {
      if (resolved.reason === "game-locked")
        terminateControlSessionForEventGame(
          transaction,
          options,
          caller,
          resolved.reason,
          resolved.eventGameId ?? session.eventGameId,
        );
      else terminateControlSession(transaction, options, caller, resolved.reason);
      return false;
    }
    if (resolved.status !== "eligible" || resolved.eventGameId !== session.eventGameId)
      return false;
  }
  if (caller.grantType === "event-admin")
    return grant.grantType !== "event-admin" && caller.scope.eventId === grant.scope.eventId;
  if (caller.grantType === "pitch-manager" && grant.grantType === "control") {
    const callerScope = caller.scope as PitchManagerGrantScope;
    const targetScope = grant.scope as ControlGrantScope;
    return (
      callerScope.eventId === targetScope.eventId &&
      callerScope.gameDayId === targetScope.gameDayId &&
      callerScope.pitchId === targetScope.pitchId
    );
  }
  return (
    operation === "reveal" && caller.grantType === "control" && caller.grantId === grant.grantId
  );
}

export function canCreateInTransaction(
  transaction: FoundationStorageTransaction,
  options: GrantAuthorityOptions,
  grant: StoredGrant,
  authority: TrustedGrantAuthority,
): boolean {
  authority = resolveManagementAuthority(transaction, options, authority) ?? authority;
  if (authority.kind === "fixture") return true;
  if (authority.kind === "technical-admin") return grant.grantType === "event-admin";
  if (authority.kind !== "grant-session") return false;
  const session = findSessionByBearer(transaction, options, authority.sessionBearer);
  if (session === null || session.status !== "active") return false;
  const storedCaller = transaction.findGrantById(session.grantId);
  if (storedCaller === null) return false;
  const caller = expireGrantIfDue(transaction, options, storedCaller);
  if (caller.status !== "active" || caller.grantVersion !== session.grantVersion) return false;
  const nowMs = readNow(options);
  if (
    caller.grantType === "event-admin" &&
    nowMs >=
      Math.min(caller.expiresAtMs ?? Number.MAX_SAFE_INTEGER, session.lastActiveAtMs + 30 * DAY_MS)
  ) {
    expireSession(transaction, options, caller, session);
    return false;
  }
  if (caller.grantType === "control") {
    const resolved = options.controlScopeResolver.resolve(
      caller.scope as ControlGrantScope,
      transaction,
    );
    if (resolved.status === "terminal") {
      if (resolved.reason === "game-locked")
        terminateControlSessionForEventGame(
          transaction,
          options,
          caller,
          resolved.reason,
          resolved.eventGameId ?? session.eventGameId,
        );
      else terminateControlSession(transaction, options, caller, resolved.reason);
      return false;
    }
    if (resolved.status !== "eligible" || resolved.eventGameId !== session.eventGameId)
      return false;
  }
  if (caller.grantType === "event-admin")
    return grant.grantType !== "event-admin" && caller.scope.eventId === grant.scope.eventId;
  if (caller.grantType === "pitch-manager" && grant.grantType === "control") {
    const callerScope = caller.scope as PitchManagerGrantScope;
    const targetScope = grant.scope as ControlGrantScope;
    return (
      callerScope.eventId === targetScope.eventId &&
      callerScope.gameDayId === targetScope.gameDayId &&
      callerScope.pitchId === targetScope.pitchId
    );
  }
  return false;
}

export function findGrantByCredential(
  transaction: FoundationStorageTransaction,
  options: GrantAuthorityOptions,
  token: string,
): StoredGrant | null {
  for (const version of listLookupKeyVersions(options.keyRing)) {
    const grant = transaction.findGrantByCredentialLookupDigest(
      computeLookupDigest(token, options.keyRing, version),
    );
    if (grant !== null) return grant;
  }
  return null;
}

export function findSessionByBearer(
  transaction: FoundationStorageTransaction,
  options: GrantAuthorityOptions,
  bearer: string,
): StoredGrantSession | null {
  for (const version of listLookupKeyVersions(options.keyRing)) {
    const session = transaction.findSessionByBearerVerifier(
      computeSessionVerifier(bearer, options.keyRing, version),
      version,
    );
    if (session !== null) return session;
  }
  return null;
}

export function findActiveContext(
  transaction: FoundationStorageTransaction,
  grantId: string,
  options: GrantAuthorityOptions,
  context: string,
): StoredGrantSession | null {
  for (const version of listLookupKeyVersions(options.keyRing)) {
    const found = transaction.findActiveSessionByGrantAndContext(
      grantId,
      computeBrowserContextDigest(context, options.keyRing, version),
    );
    if (found !== null) return found;
  }
  return null;
}

export function credentialMatches(
  grant: StoredGrant,
  options: GrantAuthorityOptions,
  token: string,
): boolean {
  const parsed = parseCredentialToken(token);
  if (
    parsed === null ||
    parsed.environmentId !== options.environmentId ||
    parsed.grantId !== grant.grantId ||
    parsed.grantType !== grant.grantType ||
    parsed.grantVersion !== grant.grantVersion ||
    !sameScope(parsed.scope, grant.scope)
  )
    return false;
  const decrypted = decryptCredential(
    grant.credential,
    bindingFor(options, grant),
    options.keyRing,
  );
  if (decrypted === null || !sameSecret(decrypted, token)) return false;
  if (grant.credential.lookupDigest === null || grant.credential.lookupKeyVersion === null)
    return false;
  return sameSecret(
    grant.credential.lookupDigest,
    computeLookupDigest(token, options.keyRing, grant.credential.lookupKeyVersion),
  );
}

export function bindingFor(options: GrantAuthorityOptions, grant: StoredGrant) {
  return {
    environmentId: options.environmentId,
    grantId: grant.grantId,
    grantType: grant.grantType,
    grantVersion: grant.grantVersion,
    scope: grant.scope,
  };
}

export function revokeAllSessions(
  transaction: FoundationStorageTransaction,
  grantId: string,
  nowMs: number,
): void {
  for (const session of transaction.listGrantSessions(grantId))
    if (session.status === "active")
      transaction.updateGrantSession({ ...session, status: "revoked", revokedAtMs: nowMs });
}

export function resolveManagementAuthority(
  transaction: FoundationStorageTransaction,
  options: GrantAuthorityOptions,
  authority: TrustedGrantAuthority,
): TrustedGrantAuthority | null {
  if (authority.kind !== "grant-session") return authority;
  const session = findSessionByBearer(transaction, options, authority.sessionBearer);
  if (session === null || session.status !== "active") return null;
  const storedGrant = transaction.findGrantById(session.grantId);
  if (storedGrant === null) return null;
  const grant = expireGrantIfDue(transaction, options, storedGrant);
  if (grant.status !== "active" || grant.grantVersion !== session.grantVersion) return null;
  return bindTrustedGrantSession(authority, session.sessionId, session.browserContextKeyVersion);
}

export function expireSession(
  transaction: FoundationStorageTransaction,
  options: GrantAuthorityOptions,
  grant: StoredGrant,
  session: StoredGrantSession,
): void {
  transaction.updateGrantSession({
    ...session,
    status: "expired",
    bearerMaterialState: "erased",
    bearerLookupVerifier: null,
    bearerLookupKeyVersion: null,
  });
  transaction.appendGrantAudit(
    createAuditEntry(options, {
      action: "session-revoked",
      actor: { kind: "system", value: "grant-expiry" },
      grant,
      sessionId: session.sessionId,
      replacedSessionId: null,
      eventGameId: session.eventGameId,
      beforeStatus: grant.status,
      afterStatus: grant.status,
    }),
  );
}

export function terminateControlSession(
  transaction: FoundationStorageTransaction,
  options: GrantAuthorityOptions,
  grant: StoredGrant,
  reason: "accepted-game-switch" | "past-game-day" | "game-locked",
): void {
  terminateControlSessionForEventGame(transaction, options, grant, reason, null);
}

export function terminateControlSessionForEventGame(
  transaction: FoundationStorageTransaction,
  options: GrantAuthorityOptions,
  grant: StoredGrant,
  reason: "accepted-game-switch" | "past-game-day" | "game-locked",
  eventGameId: string | null,
): number {
  const nowMs = readNow(options);
  let terminated = 0;
  for (const affected of transaction.listGrantSessions(grant.grantId)) {
    if (
      affected.status !== "active" ||
      (eventGameId !== null && affected.eventGameId !== eventGameId)
    )
      continue;
    transaction.updateGrantSession({
      ...affected,
      status: "expired",
      bearerMaterialState: "erased",
      bearerLookupVerifier: null,
      bearerLookupKeyVersion: null,
      revokedAtMs: nowMs,
    });
    transaction.appendGrantAudit(
      createAuditEntry(options, {
        action: "session-terminated",
        actor: { kind: "system", value: "grant-session-termination" },
        grant,
        sessionId: affected.sessionId,
        replacedSessionId: null,
        eventGameId: affected.eventGameId,
        beforeStatus: grant.status,
        afterStatus: grant.status,
        terminalReason: reason,
      }),
    );
    terminated += 1;
  }
  return terminated;
}

function sameScope(left: GrantScope, right: GrantScope): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readNow(options: GrantAuthorityOptions): number {
  const nowMs = options.clock.nowMs();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0)
    throw new Error("Grant clock returned an invalid timestamp.");
  return nowMs;
}
