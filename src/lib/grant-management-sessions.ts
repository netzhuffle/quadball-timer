import {
  computeBrowserContextDigest,
  computeSessionVerifier,
  createRandomIdentifier,
} from "@/lib/grant-crypto";
import type { FoundationStorage, FoundationStorageTransaction } from "@/lib/foundation-storage";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import {
  EVENT_ADMIN_GRANT_TYPE,
  GRANT_CODE_KIND,
  GRANT_TYPE,
  PITCH_MANAGER_GRANT_TYPE,
  type GrantType,
  validateEventAdminGrantScope,
  validatePitchManagerGrantScope,
  type ControlGrantScope,
  type ControlGrantScopeResolution,
  type ControlGrantSessionDecision,
  type ControlGrantSessionResolution,
  type StoredGrant,
  type StoredGrantSession,
} from "@/lib/grant-types";
import {
  GENERIC_GRANT_ADMISSION_FAILURE,
  GENERIC_GRANT_AUTHORIZATION_FAILURE,
} from "@/lib/grant-authority-types";
import { createAuditEntry, expireGrantIfDue } from "@/lib/grant-lifecycle";
import { validateOpaqueIdentifier } from "@/lib/validation-policy";
import {
  beginAdmission,
  recordAdmissionFailure,
  recordAdmissionSuccess,
} from "@/lib/grant-admission-throttle";
import { DAY_MS } from "@/lib/grant-calendar";
import {
  canManageInTransaction,
  credentialMatches,
  expireSession,
  findActiveContext,
  findGrantByCredential,
  findSessionByBearer,
  refreshGrantManagementSession,
  resolveManagementAuthority,
  terminateControlSessionForEventGame,
} from "@/lib/grant-management-policy";
import { eraseGrantCode } from "@/lib/grant-code";
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
import { grantAdmissionThrottled } from "@/lib/grant-authority-types";

export async function admitGrant(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  input: {
    qrCredential: string;
    browserContext: string;
    deviceClass?: string;
    browserClass?: string;
  },
  expectedGrantType?: GrantType,
): Promise<TypedGrantAdmission | ReturnType<typeof grantAdmissionThrottled>> {
  const record: Record<string, unknown> = isGrantRecord(input) ? input : {};
  try {
    return await storage.transaction((transaction) => {
      const nowMs = readGrantNow(options);
      const budget = beginAdmission(transaction, options, "qr", record.browserContext, nowMs);
      if (budget.throttle !== null) return budget.throttle;
      if (
        !isValidGrantSecret(record.qrCredential) ||
        !validateOpaqueIdentifier(record.browserContext, "browserContext").ok
      ) {
        recordAdmissionFailure(transaction, "qr", budget.sourceDigest, nowMs);
        return GENERIC_GRANT_ADMISSION_FAILURE;
      }
      const browserContext = record.browserContext as string;
      const grant = findGrantByCredential(transaction, options, record.qrCredential);
      if (grant === null) {
        recordAdmissionFailure(transaction, "qr", budget.sourceDigest, nowMs);
        return GENERIC_GRANT_ADMISSION_FAILURE;
      }
      const current = expireGrantIfDue(transaction, options, grant);
      if (
        current.status !== "active" ||
        !credentialMatches(current, options, record.qrCredential)
      ) {
        recordAdmissionFailure(transaction, "qr", budget.sourceDigest, nowMs);
        return GENERIC_GRANT_ADMISSION_FAILURE;
      }
      if (expectedGrantType !== undefined && current.grantType !== expectedGrantType) {
        recordAdmissionFailure(transaction, "qr", budget.sourceDigest, nowMs);
        return GENERIC_GRANT_ADMISSION_FAILURE;
      }
      if (expectedGrantType === PITCH_MANAGER_GRANT_TYPE) {
        const scope = validatePitchManagerGrantScope(current.scope);
        if (!scope.ok || !isLivePitchManagerScope(transaction, scope.value)) {
          recordAdmissionFailure(transaction, "qr", budget.sourceDigest, nowMs);
          return GENERIC_GRANT_ADMISSION_FAILURE;
        }
      }
      if (expectedGrantType === EVENT_ADMIN_GRANT_TYPE) {
        if (!validateEventAdminGrantScope(current.scope).ok) {
          recordAdmissionFailure(transaction, "qr", budget.sourceDigest, nowMs);
          return GENERIC_GRANT_ADMISSION_FAILURE;
        }
      }
      let eventGameId: string | null = null;
      if (current.grantType === GRANT_TYPE) {
        const resolved = options.controlScopeResolver.resolve(
          current.scope as ControlGrantScope,
          transaction,
        );
        if (
          resolved.status !== "eligible" ||
          !validateOpaqueIdentifier(resolved.eventGameId, "eventGameId").ok
        ) {
          recordAdmissionFailure(transaction, "qr", budget.sourceDigest, nowMs);
          return GENERIC_GRANT_ADMISSION_FAILURE;
        }
        eventGameId = resolved.eventGameId;
      }
      const lookupVersion = options.keyRing.lookup.currentVersion;
      const contextDigest = computeBrowserContextDigest(
        browserContext,
        options.keyRing,
        lookupVersion,
      );
      const previous = findActiveContext(transaction, current.grantId, options, browserContext);
      if (previous !== null)
        transaction.updateGrantSession({ ...previous, status: "revoked", revokedAtMs: nowMs });
      const bearer = Buffer.from(requireGrantBytes(options.randomness, 32)).toString("base64url");
      const session: StoredGrantSession = {
        sessionId: createRandomIdentifier("grant-session", options.randomness),
        grantId: current.grantId,
        grantVersion: current.grantVersion,
        eventGameId: eventGameId ?? "grant-management",
        stayedOnEventGameId: null,
        browserContextDigest: contextDigest,
        browserContextKeyVersion: lookupVersion,
        bearerMaterialState: "present",
        bearerLookupVerifier: computeSessionVerifier(bearer, options.keyRing, lookupVersion),
        bearerLookupKeyVersion: lookupVersion,
        status: "active",
        createdAtMs: nowMs,
        lastActiveAtMs: nowMs,
        revokedAtMs: null,
        deviceClass: coarse(record.deviceClass),
        browserClass: coarse(record.browserClass),
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
      recordAdmissionSuccess(transaction, "qr", budget.sourceDigest, nowMs);
      return {
        status: "admitted",
        grantId: current.grantId,
        grantVersion: current.grantVersion,
        grantType: current.grantType,
        scope: structuredClone(current.scope),
        eventGameId,
        grantSessionId: session.sessionId,
        sessionBearer: bearer,
        sessionExpiresAtMs:
          current.grantType === EVENT_ADMIN_GRANT_TYPE
            ? Math.min(current.expiresAtMs ?? Number.MAX_SAFE_INTEGER, nowMs + 30 * DAY_MS)
            : current.grantType === PITCH_MANAGER_GRANT_TYPE || current.grantType === GRANT_TYPE
              ? current.expiresAtMs
              : null,
      };
    });
  } catch {
    return GENERIC_GRANT_ADMISSION_FAILURE;
  }
}

function isLivePitchManagerScope(
  transaction: FoundationStorageTransaction,
  scope: {
    eventId: string;
    gameDayId: string;
    gameDayDate: string;
    eventTimeZone: string;
    pitchId: string;
  },
): boolean {
  const event = transaction.findEvent(scope.eventId);
  const gameDay = transaction
    .listGameDays(scope.eventId)
    .find((candidate) => candidate.gameDayId === scope.gameDayId);
  const pitch = transaction.findPitch(scope.pitchId);
  return (
    event !== null &&
    gameDay !== undefined &&
    gameDay.date === scope.gameDayDate &&
    event.timeZone === scope.eventTimeZone &&
    pitch !== null &&
    pitch.eventId === scope.eventId
  );
}

export async function authorizeGrant(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  input: {
    sessionBearer: string;
    eventGameId?: string;
    controlSessionDecision?: ControlGrantSessionDecision;
    readOnly?: boolean;
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
    controlSessionDecision?: ControlGrantSessionDecision;
    readOnly?: boolean;
  },
): TypedGrantAuthorization {
  let session = findSessionByBearer(transaction, options, input.sessionBearer);
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
      transaction,
      options,
      grant.scope as ControlGrantScope,
      session.eventGameId,
    );
    if (relationship.status === "game-locked" || relationship.status === "past-game-day") {
      if (input.readOnly) return GENERIC_GRANT_AUTHORIZATION_FAILURE;
      terminateControlSessionForEventGame(
        transaction,
        options,
        grant,
        relationship.status,
        relationship.eventGameId,
      );
      return GENERIC_GRANT_AUTHORIZATION_FAILURE;
    }
    if (relationship.status === "switchable") {
      if (
        input.controlSessionDecision === "stay" &&
        input.eventGameId === relationship.previousEventGameId &&
        !input.readOnly
      ) {
        session = {
          ...session,
          stayedOnEventGameId: relationship.currentEventGameId,
        };
        transaction.updateGrantSession({
          ...session,
        });
        eventGameId = relationship.previousEventGameId;
      } else if (
        session.stayedOnEventGameId === relationship.currentEventGameId &&
        input.eventGameId === relationship.previousEventGameId
      ) {
        eventGameId = relationship.previousEventGameId;
      } else if (
        input.eventGameId !== undefined &&
        (input.eventGameId === relationship.currentEventGameId ||
          (input.controlSessionDecision === undefined &&
            input.eventGameId === relationship.previousEventGameId))
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
  const effectiveActivityAtMs = input.readOnly ? session.lastActiveAtMs : nowMs;
  if (!input.readOnly) {
    transaction.updateGrantSession({ ...session, lastActiveAtMs: nowMs });
  }
  return {
    status: "authorized",
    grantId: grant.grantId,
    grantVersion: grant.grantVersion,
    grantType: grant.grantType,
    scope: structuredClone(grant.scope),
    eventGameId,
    grantSessionId: session.sessionId,
    sessionExpiresAtMs:
      grant.grantType === EVENT_ADMIN_GRANT_TYPE
        ? Math.min(
            grant.expiresAtMs ?? Number.MAX_SAFE_INTEGER,
            effectiveActivityAtMs + 30 * DAY_MS,
          )
        : grant.grantType === PITCH_MANAGER_GRANT_TYPE || grant.grantType === GRANT_TYPE
          ? grant.expiresAtMs
          : null,
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
        transaction,
        options,
        grant.scope as ControlGrantScope,
        session.eventGameId,
      );
      if (relationship.status !== "switchable") return GENERIC_GRANT_AUTHORIZATION_FAILURE;
      const nowMs = readGrantNow(options);
      transaction.updateGrantSession({
        ...session,
        eventGameId: relationship.currentEventGameId,
        stayedOnEventGameId: null,
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
        ...(grant.expiresAtMs === null ? {} : { sessionExpiresAtMs: grant.expiresAtMs }),
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
      const resolvedGrants: Array<{
        grant: StoredGrant;
        eventGameId: string;
      }> = [];
      for (const grant of transaction.listGrants()) {
        if (grant.grantType !== GRANT_TYPE) continue;
        const current = expireGrantIfDue(transaction, options, grant);
        if (current.status === "expired") continue;
        let resolved: ControlGrantScopeResolution;
        try {
          resolved = options.controlScopeResolver.resolve(current.scope as ControlGrantScope);
        } catch {
          return { status: "rejected", reason: "unavailable" };
        }
        const resolvedEventGameId =
          resolved.status === "eligible"
            ? resolved.eventGameId
            : resolved.status === "terminal" && resolved.reason === "game-locked"
              ? resolved.eventGameId
              : undefined;
        if (
          resolvedEventGameId === undefined ||
          !validateOpaqueIdentifier(resolvedEventGameId, "eventGameId").ok
        )
          return { status: "rejected", reason: "unavailable" };
        resolvedGrants.push({ grant: current, eventGameId: resolvedEventGameId });
      }
      let terminatedSessionCount = 0;
      for (const { grant, eventGameId } of resolvedGrants) {
        if (eventGameId !== transition.eventGameId) continue;
        terminatedSessionCount += terminateControlSessionForEventGame(
          transaction,
          options,
          grant,
          "game-locked",
          transition.eventGameId,
        );
        if (grant.code?.state === "present") {
          const erased = eraseGrantCode(grant.code, "erased");
          transaction.updateGrant({ ...grant, code: erased });
          const codeAudit = createAuditEntry(options, {
            action: "grant-code-erased-game-lock",
            actor: { kind: "system", value: "grant-session-termination" },
            grant,
            sessionId: null,
            replacedSessionId: null,
            eventGameId: transition.eventGameId,
            beforeStatus: grant.status,
            afterStatus: grant.status,
            terminalReason: "game-locked",
          });
          transaction.appendGrantAudit({
            ...codeAudit,
            credentialKind: GRANT_CODE_KIND,
            credentialFingerprint: grant.code.fingerprint,
            codeFormatVersion: grant.code.formatVersion,
            codeEncryptionKeyVersion: grant.code.encryptionKeyVersion,
            codeLookupKeyVersion: grant.code.lookupKeyVersion,
            codeStateBefore: grant.code.state,
            codeState: "erased",
            previousCodeFingerprint: grant.code.fingerprint,
          });
        }
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

export function resolveControlSession(
  transaction: FoundationStorageTransaction,
  options: GrantAuthorityOptions,
  scope: ControlGrantScope,
  sessionEventGameId: string,
): ControlGrantSessionResolution {
  if (options.controlScopeResolver.resolveSession !== undefined) {
    const resolved = options.controlScopeResolver.resolveSession(
      scope,
      sessionEventGameId,
      transaction,
    );
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
    if (resolved.status === "past-game-day")
      return resolved.eventGameId === sessionEventGameId &&
        validateOpaqueIdentifier(resolved.eventGameId, "eventGameId").ok
        ? resolved
        : { status: "mismatch" };
    return resolved;
  }
  const current = options.controlScopeResolver.resolve(scope, transaction);
  if (
    current.status === "eligible" &&
    validateOpaqueIdentifier(current.eventGameId, "eventGameId").ok
  )
    return current.eventGameId === sessionEventGameId
      ? { status: "current", eventGameId: current.eventGameId }
      : { status: "mismatch" };
  if (
    current.status === "terminal" &&
    (current.reason === "game-locked" || current.reason === "past-game-day") &&
    current.eventGameId === sessionEventGameId &&
    validateOpaqueIdentifier(current.eventGameId, "eventGameId").ok
  )
    return { status: current.reason, eventGameId: current.eventGameId };
  return { status: "mismatch" };
}

export async function revokeGrantSession(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  grantId: string,
  sessionReference: string,
  authority: GrantManagementAuthority,
): Promise<TypedGrantMutation> {
  try {
    return await storage.transaction((transaction) =>
      revokeGrantSessionInTransaction(transaction, options, grantId, sessionReference, authority),
    );
  } catch {
    return unavailableGrant();
  }
}

export function revokeGrantSessionInTransaction(
  transaction: FoundationStorageTransaction,
  options: GrantAuthorityOptions,
  grantId: string,
  sessionReference: string,
  authority: GrantManagementAuthority,
): TypedGrantMutation {
  const trustedAuthority = verifyGrantAuthority(options.privilegedAuthorityVerifier, authority);
  if (trustedAuthority === null) return unauthorizedGrant();
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
  refreshGrantManagementSession(transaction, options, resolvedAuthority);
  return { status: "updated", grantId, grantVersion: grant.grantVersion };
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
