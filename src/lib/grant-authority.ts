import {
  computeBrowserContextDigest,
  computeLookupDigest,
  computeSessionVerifier,
  createCredentialToken,
  createRandomIdentifier,
  decryptCredential,
  encryptCredential,
  listLookupKeyVersions,
  parseCredentialToken,
  sameSecret,
} from "@/lib/grant-crypto";
import {
  FoundationStorageConstraintError,
  type FoundationStorage,
  type FoundationStorageConstraint,
} from "@/lib/foundation-storage";
import {
  GRANT_CREDENTIAL_FORMAT_VERSION,
  GRANT_TYPE,
  validateControlGrantScope,
  type ControlGrantScope,
  type ControlGrantScopeResolver,
  type GrantClock,
  type GrantAuthorityActor,
  type GrantKeyRing,
  type GrantRandomness,
  type GrantSessionSummary,
  type StoredControlGrant,
  type StoredGrantSession,
  type StoredGrantStatus,
} from "@/lib/grant-types";
import {
  GENERIC_GRANT_ADMISSION_FAILURE,
  GENERIC_GRANT_AUTHORIZATION_FAILURE,
  GENERIC_GRANT_STORAGE_FAILURE,
  type AdmitControlGrantInput,
  type AdmitControlGrantResult,
  type AuthorizeControlGrantInput,
  type AuthorizeControlGrantResult,
  type CreateControlGrantInput,
  type CreateControlGrantResult,
  type GrantAuditListResult,
  type GrantAuthority,
  type GrantMutationResult,
  type GrantSessionListResult,
  type RevealControlGrantResult,
} from "@/lib/grant-authority-types";
import { createAuditEntry, expireGrantIfDue, validateActor } from "@/lib/grant-lifecycle";
import { rotateControlGrantCredentialKeys } from "@/lib/grant-rotation";
import { validateOpaqueIdentifier } from "@/lib/validation-policy";

export type {
  ControlGrantScope,
  ControlGrantScopeResolution,
  ControlGrantScopeResolver,
  GrantClock,
  GrantAuthorityActor,
  GrantKeyRing,
  GrantRandomness,
} from "@/lib/grant-types";

export type GrantAuthorityOptions = {
  environmentId: string;
  clock: GrantClock;
  randomness: GrantRandomness;
  keyRing: GrantKeyRing;
  controlScopeResolver: ControlGrantScopeResolver;
};

export type {
  AdmitControlGrantInput,
  AdmitControlGrantResult,
  AuthorizeControlGrantInput,
  AuthorizeControlGrantResult,
  CreateControlGrantInput,
  CreateControlGrantResult,
  GrantAuditListResult,
  GrantAuthority,
  GrantMutationResult,
  GrantSessionListResult,
  RevealControlGrantResult,
  RotateControlGrantCredentialKeysResult,
} from "@/lib/grant-authority-types";
export {
  GENERIC_GRANT_ADMISSION_FAILURE,
  GENERIC_GRANT_STORAGE_FAILURE,
} from "@/lib/grant-authority-types";

export function createGrantAuthority(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
): GrantAuthority {
  const environmentId = validateIdentifier(options.environmentId, "environmentId");
  validateKeyConfiguration(options.keyRing);

  return {
    createControlGrant(input) {
      return createControlGrant(storage, options, environmentId, input);
    },
    revealControlGrant(grantId, actor) {
      return revealControlGrant(storage, options, environmentId, grantId, actor);
    },
    rotateControlGrantCredentialKeys(grantId, actor) {
      return rotateControlGrantCredentialKeys(storage, options, environmentId, grantId, actor);
    },
    admitControlGrant(input) {
      return admitControlGrant(storage, options, environmentId, input);
    },
    authorizeControlGrant(input) {
      return authorizeControlGrant(storage, options, input);
    },
    disableControlGrant(grantId, actor) {
      return updateGrantStatus(storage, options, grantId, "disabled", "grant-disabled", actor);
    },
    revokeControlGrant(grantId, actor) {
      return updateGrantStatus(storage, options, grantId, "revoked", "grant-revoked", actor);
    },
    listGrantSessions(grantId) {
      return storage
        .transaction((transaction) => {
          const grant = transaction.findGrantById(grantId);
          if (grant !== null) expireGrantIfDue(transaction, options, grant);
          return transaction.listGrantSessions(grantId).map(toSessionSummary);
        })
        .then((value) => ({ status: "ok", value }) satisfies GrantSessionListResult)
        .catch(() => GENERIC_GRANT_STORAGE_FAILURE);
    },
    listGrantAudit(grantId) {
      return storage
        .transaction((transaction) => {
          const grant = transaction.findGrantById(grantId);
          if (grant !== null) expireGrantIfDue(transaction, options, grant);
          return transaction.listGrantAudit(grantId);
        })
        .then((value) => ({ status: "ok", value }) satisfies GrantAuditListResult)
        .catch(() => GENERIC_GRANT_STORAGE_FAILURE);
    },
  };
}

async function createControlGrant(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  environmentId: string,
  input: CreateControlGrantInput,
): Promise<CreateControlGrantResult> {
  if (!isRecord(input)) {
    return {
      status: "rejected",
      reason: "invalid-input",
      detail: "Control Grant input must be an object.",
    };
  }
  const scope = validateControlGrantScope(input.scope);
  if (!scope.ok) return { status: "rejected", reason: "invalid-input", detail: scope.error };
  const actor = validateActor(input.actor);
  if (!actor.ok) {
    return { status: "rejected", reason: "invalid-input", detail: actor.error };
  }
  const nowMs = readNow(options.clock);
  const expiresAtMs = input.expiresAtMs ?? null;
  if (expiresAtMs !== null && (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs)) {
    return {
      status: "rejected",
      reason: "invalid-input",
      detail: "expiresAtMs must be a safe timestamp after the current time.",
    };
  }

  const grantId = createRandomIdentifier("grant", options.randomness);
  const grantVersion = createRandomIdentifier("grant-version", options.randomness);
  const binding = {
    environmentId,
    grantId,
    grantType: GRANT_TYPE,
    grantVersion,
    scope: scope.value,
  } as const;
  const qrCredential = createCredentialToken(binding, options.randomness);
  const credential = encryptCredential(qrCredential, binding, options.randomness, options.keyRing);
  const grant: StoredControlGrant = {
    grantId,
    grantType: GRANT_TYPE,
    grantVersion,
    scope: scope.value,
    status: "active",
    createdAtMs: nowMs,
    expiresAtMs,
    credential,
  };
  const audit = createAuditEntry(options, {
    action: "grant-created",
    actor: { kind: "authority", value: actor.value },
    grant,
    sessionId: null,
    replacedSessionId: null,
    eventGameId: null,
    beforeStatus: null,
    afterStatus: "active",
  });

  try {
    await storage.transaction((transaction) => {
      transaction.insertGrant(grant);
      transaction.appendGrantAudit(audit);
    });
  } catch (error) {
    if (isGrantIdentityConstraint(error)) {
      return {
        status: "rejected",
        reason: "invalid-input",
        detail: "The Control Grant identity conflicts with existing authority.",
      };
    }
    return {
      status: "rejected",
      reason: "unavailable",
      detail: "Grant authority storage is temporarily unavailable.",
    };
  }

  return {
    status: "created",
    grantId,
    grantVersion,
    grantType: GRANT_TYPE,
    scope: structuredClone(scope.value),
    qrCredential,
    credentialFormatVersion: GRANT_CREDENTIAL_FORMAT_VERSION,
  };
}

async function revealControlGrant(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  environmentId: string,
  grantId: string,
  actorInput: GrantAuthorityActor,
): Promise<RevealControlGrantResult> {
  const actor = validateActor(actorInput);
  if (!actor.ok) {
    return { status: "rejected", reason: "unavailable", detail: "The Grant cannot be revealed." };
  }

  return storage
    .transaction<RevealControlGrantResult>((transaction) => {
      const storedGrant = transaction.findGrantById(grantId);
      if (storedGrant === null) {
        return { status: "rejected", reason: "not-found", detail: "The Grant was not found." };
      }
      const grant = expireGrantIfDue(transaction, options, storedGrant);
      if (grant.status !== "active") {
        return {
          status: "rejected",
          reason: "unavailable",
          detail: "The Grant cannot be revealed.",
        };
      }
      const token = decryptCredential(
        grant.credential,
        bindingForGrant(environmentId, grant),
        options.keyRing,
      );
      if (token === null || !credentialMatches(token, environmentId, grant)) {
        return {
          status: "rejected",
          reason: "unavailable",
          detail: "The Grant cannot be revealed.",
        };
      }
      transaction.appendGrantAudit(
        createAuditEntry(options, {
          action: "credential-revealed",
          actor: { kind: "authority", value: actor.value },
          grant,
          sessionId: null,
          replacedSessionId: null,
          eventGameId: null,
          beforeStatus: grant.status,
          afterStatus: grant.status,
        }),
      );
      return {
        status: "revealed",
        grantId: grant.grantId,
        grantVersion: grant.grantVersion,
        qrCredential: token,
        credentialFormatVersion: GRANT_CREDENTIAL_FORMAT_VERSION,
      };
    })
    .catch((): RevealControlGrantResult => ({
      status: "rejected",
      reason: "unavailable",
      detail: "The Grant cannot be revealed.",
    }));
}

async function admitControlGrant(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  environmentId: string,
  input: AdmitControlGrantInput,
): Promise<AdmitControlGrantResult> {
  if (
    !isRecord(input) ||
    !isValidBrowserContext(input.browserContext) ||
    !isValidCredential(input.qrCredential)
  ) {
    return GENERIC_GRANT_ADMISSION_FAILURE;
  }

  try {
    return await storage.transaction((transaction) => {
      let grant: StoredControlGrant | null = null;
      for (const keyVersion of listLookupKeyVersions(options.keyRing)) {
        const lookupDigest = computeLookupDigest(input.qrCredential, options.keyRing, keyVersion);
        grant = transaction.findGrantByCredentialLookupDigest(lookupDigest);
        if (grant !== null) break;
      }
      if (grant === null) return GENERIC_GRANT_ADMISSION_FAILURE;
      grant = expireGrantIfDue(transaction, options, grant);
      if (grant.status !== "active") {
        return GENERIC_GRANT_ADMISSION_FAILURE;
      }
      if (
        grant.credential.materialState !== "present" ||
        grant.credential.lookupDigest === null ||
        grant.credential.lookupKeyVersion === null
      ) {
        return GENERIC_GRANT_ADMISSION_FAILURE;
      }

      const decrypted = decryptCredential(
        grant.credential,
        bindingForGrant(environmentId, grant),
        options.keyRing,
      );
      if (
        decrypted === null ||
        !sameSecret(decrypted, input.qrCredential) ||
        !credentialMatches(decrypted, environmentId, grant) ||
        !sameSecret(
          grant.credential.lookupDigest,
          computeLookupDigest(decrypted, options.keyRing, grant.credential.lookupKeyVersion),
        )
      ) {
        return GENERIC_GRANT_ADMISSION_FAILURE;
      }

      const resolved = options.controlScopeResolver.resolve(grant.scope);
      if (resolved.status !== "eligible" || !isValidEventGameId(resolved.eventGameId)) {
        return GENERIC_GRANT_ADMISSION_FAILURE;
      }

      const nowMs = readNow(options.clock);
      const lookupKeyVersion = options.keyRing.lookup.currentVersion;
      let previousSession: StoredGrantSession | null = null;
      for (const keyVersion of listLookupKeyVersions(options.keyRing)) {
        previousSession = transaction.findActiveSessionByGrantAndContext(
          grant.grantId,
          computeBrowserContextDigest(input.browserContext, options.keyRing, keyVersion),
        );
        if (previousSession !== null) break;
      }
      const browserContextDigest = computeBrowserContextDigest(
        input.browserContext,
        options.keyRing,
        lookupKeyVersion,
      );
      if (previousSession !== null) {
        transaction.updateGrantSession({
          ...previousSession,
          status: "revoked",
          revokedAtMs: nowMs,
        });
      }

      const sessionBearerBytes = options.randomness.bytes(32);
      if (sessionBearerBytes.byteLength !== 32) {
        throw new Error("Injected session randomness has an invalid size.");
      }
      const sessionBearer = Buffer.from(sessionBearerBytes).toString("base64url");
      const session: StoredGrantSession = {
        sessionId: createRandomIdentifier("grant-session", options.randomness),
        grantId: grant.grantId,
        grantVersion: grant.grantVersion,
        eventGameId: resolved.eventGameId,
        browserContextDigest,
        browserContextKeyVersion: lookupKeyVersion,
        bearerMaterialState: "present",
        bearerLookupVerifier: computeSessionVerifier(
          sessionBearer,
          options.keyRing,
          lookupKeyVersion,
        ),
        bearerLookupKeyVersion: lookupKeyVersion,
        status: "active",
        createdAtMs: nowMs,
        lastActiveAtMs: nowMs,
        revokedAtMs: null,
      };
      transaction.insertGrantSession(session);
      transaction.appendGrantAudit(
        createAuditEntry(options, {
          action: previousSession === null ? "session-admitted" : "session-replaced",
          actor: { kind: "session", sessionId: session.sessionId },
          grant,
          sessionId: session.sessionId,
          replacedSessionId: previousSession?.sessionId ?? null,
          eventGameId: session.eventGameId,
          beforeStatus: previousSession?.status === "active" ? "active" : null,
          afterStatus: "active",
        }),
      );

      return {
        status: "admitted",
        grantId: grant.grantId,
        grantVersion: grant.grantVersion,
        grantType: GRANT_TYPE,
        scope: structuredClone(grant.scope),
        eventGameId: session.eventGameId,
        grantSessionId: session.sessionId,
        sessionBearer,
      };
    });
  } catch {
    return GENERIC_GRANT_ADMISSION_FAILURE;
  }
}

async function authorizeControlGrant(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  input: AuthorizeControlGrantInput,
): Promise<AuthorizeControlGrantResult> {
  if (!isRecord(input) || !isValidBearer(input.sessionBearer)) {
    return GENERIC_GRANT_AUTHORIZATION_FAILURE;
  }

  try {
    return await storage.transaction((transaction) => {
      let session: StoredGrantSession | null = null;
      for (const keyVersion of listLookupKeyVersions(options.keyRing)) {
        const verifier = computeSessionVerifier(input.sessionBearer, options.keyRing, keyVersion);
        session = transaction.findSessionByBearerVerifier(verifier, keyVersion);
        if (session !== null) break;
      }
      if (session === null) {
        return GENERIC_GRANT_AUTHORIZATION_FAILURE;
      }

      const storedGrant = transaction.findGrantById(session.grantId);
      if (storedGrant === null) return GENERIC_GRANT_AUTHORIZATION_FAILURE;
      const grant = expireGrantIfDue(transaction, options, storedGrant);
      if (
        session.status !== "active" ||
        grant.status !== "active" ||
        grant.grantVersion !== session.grantVersion
      ) {
        return GENERIC_GRANT_AUTHORIZATION_FAILURE;
      }
      const resolved = options.controlScopeResolver.resolve(grant.scope);
      if (
        resolved.status !== "eligible" ||
        !isValidEventGameId(resolved.eventGameId) ||
        resolved.eventGameId !== session.eventGameId
      ) {
        return GENERIC_GRANT_AUTHORIZATION_FAILURE;
      }

      const nowMs = readNow(options.clock);
      transaction.updateGrantSession({ ...session, lastActiveAtMs: nowMs });
      return {
        status: "authorized",
        grantId: grant.grantId,
        grantVersion: grant.grantVersion,
        grantType: GRANT_TYPE,
        scope: structuredClone(grant.scope),
        eventGameId: session.eventGameId,
        grantSessionId: session.sessionId,
      };
    });
  } catch {
    return GENERIC_GRANT_AUTHORIZATION_FAILURE;
  }
}

async function updateGrantStatus(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  grantId: string,
  status: Extract<StoredGrantStatus, "disabled" | "revoked">,
  action: "grant-disabled" | "grant-revoked",
  actorInput: GrantAuthorityActor,
): Promise<GrantMutationResult> {
  const actor = validateActor(actorInput);
  if (!actor.ok) return { status: "rejected", reason: "invalid-input" };
  return storage
    .transaction<GrantMutationResult>((transaction) => {
      const storedGrant = transaction.findGrantById(grantId);
      if (storedGrant === null) return { status: "rejected", reason: "not-found" };
      const grant = expireGrantIfDue(transaction, options, storedGrant);
      if (grant.status === "expired") return { status: "updated", grantId };
      if (grant.status === status) return { status: "updated", grantId };
      transaction.updateGrant({ ...grant, status });
      transaction.appendGrantAudit(
        createAuditEntry(options, {
          action,
          actor: { kind: "authority", value: actor.value },
          grant,
          sessionId: null,
          replacedSessionId: null,
          eventGameId: null,
          beforeStatus: grant.status,
          afterStatus: status,
        }),
      );
      return { status: "updated", grantId };
    })
    .catch((): GrantMutationResult => ({
      status: "rejected",
      reason: "unavailable",
      detail: "Grant authority storage is temporarily unavailable.",
    }));
}

function bindingForGrant(environmentId: string, grant: StoredControlGrant) {
  return {
    environmentId,
    grantId: grant.grantId,
    grantType: grant.grantType,
    grantVersion: grant.grantVersion,
    scope: grant.scope,
  } as const;
}

function credentialMatches(
  token: string,
  environmentId: string,
  grant: StoredControlGrant,
): boolean {
  const parsed = parseCredentialForComparison(token);
  return (
    parsed !== null &&
    parsed.environmentId === environmentId &&
    parsed.grantId === grant.grantId &&
    parsed.grantType === grant.grantType &&
    parsed.grantVersion === grant.grantVersion &&
    parsed.credentialKind === grant.credential.kind &&
    parsed.formatVersion === grant.credential.formatVersion &&
    sameScope(parsed.scope, grant.scope)
  );
}

function parseCredentialForComparison(token: string) {
  return parseCredentialToken(token);
}

function validateIdentifier(value: unknown, field: string): string {
  const result = validateOpaqueIdentifier(value, field);
  if (!result.ok) throw new Error(`Invalid Grant configuration: ${result.error}`);
  return result.value;
}

function isGrantIdentityConstraint(error: unknown): boolean {
  return (
    error instanceof FoundationStorageConstraintError &&
    GRANT_IDENTITY_CONSTRAINTS.has(error.constraint)
  );
}

const GRANT_IDENTITY_CONSTRAINTS = new Set<FoundationStorageConstraint>([
  "grant-id",
  "grant-version",
  "grant-pitch-slot-id",
  "grant-credential-digest",
]);

function isValidBrowserContext(value: unknown): value is string {
  return validateOpaqueIdentifier(value, "browserContext").ok;
}

function isValidCredential(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function isValidEventGameId(value: unknown): value is string {
  return validateOpaqueIdentifier(value, "eventGameId").ok;
}

function isValidBearer(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function readNow(clock: GrantClock): number {
  const nowMs = clock.nowMs();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("Grant clock returned an invalid timestamp.");
  }
  return nowMs;
}

function validateKeyConfiguration(keyRing: GrantKeyRing): void {
  if (
    keyRing.encryption.currentVersion.length === 0 ||
    keyRing.lookup.currentVersion.length === 0
  ) {
    throw new Error("Grant key-ring versions must not be empty.");
  }
  if (!keyRing.encryption.keys.has(keyRing.encryption.currentVersion)) {
    throw new Error("The current Grant encryption key is unavailable.");
  }
  if (!keyRing.lookup.keys.has(keyRing.lookup.currentVersion)) {
    throw new Error("The current Grant lookup key is unavailable.");
  }
}

function sameScope(left: ControlGrantScope, right: ControlGrantScope): boolean {
  return (
    left.eventId === right.eventId &&
    left.gameDayId === right.gameDayId &&
    left.pitchId === right.pitchId &&
    left.pitchSlotId === right.pitchSlotId
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toSessionSummary(session: StoredGrantSession): GrantSessionSummary {
  return {
    sessionId: session.sessionId,
    grantId: session.grantId,
    grantVersion: session.grantVersion,
    eventGameId: session.eventGameId,
    status: session.status,
    createdAtMs: session.createdAtMs,
    lastActiveAtMs: session.lastActiveAtMs,
    revokedAtMs: session.revokedAtMs,
  };
}
