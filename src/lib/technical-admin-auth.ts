import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type TechnicalAdminEnvironment = "production" | "test";

export type TechnicalAdminAuthConfig = {
  environment: TechnicalAdminEnvironment;
  origin: string;
  rpId: string;
  databasePath?: string;
  logKey?: string;
  trustProxyHeaders?: boolean;
};

export type CeremonyBinding = {
  origin: string;
  host: string;
};

export type EnrollmentAuthorization = {
  url: string;
  expiresAtMs: number;
};

export type RegistrationOptions = {
  challengeId: string;
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  timeout: number;
  attestation: "none";
  authenticatorSelection: { residentKey: "required"; userVerification: "required" };
};

export type AuthenticationOptions = {
  challengeId: string;
  challenge: string;
  rpId: string;
  allowCredentials: Array<{ id: string; type: "public-key" }>;
  timeout: number;
  userVerification: "required";
};

export type TechnicalAdminSession = {
  token: string;
  expiresAtMs: number;
  csrfToken: string;
};

export type FreshVerificationPurpose = "replace-credential" | "revoke-other-sessions";

const technicalAdminAuthorityBrand = Symbol("technical-admin-authority");

export type TechnicalAdminAuthority = {
  readonly kind: "technical-admin";
  readonly environment: TechnicalAdminEnvironment;
  readonly sessionId: string;
  readonly [technicalAdminAuthorityBrand]: true;
};

export type TechnicalAdminStorageStatus = {
  state: "ready" | "unavailable" | "corrupt" | "read-only";
  credentialPresent: boolean;
  activeSessionCount: number;
  generation: number;
};

export type TechnicalAdminOperationalLog = {
  atMs: number;
  event:
    | "enrollment-issued"
    | "enrollment-completed"
    | "authentication-succeeded"
    | "authentication-failed"
    | "fresh-verification-succeeded"
    | "fresh-verification-failed"
    | "credential-replaced"
    | "other-sessions-revoked"
    | "logout"
    | "emergency-reset"
    | "throttled";
  outcome: "accepted" | "rejected" | "unavailable";
  environment: TechnicalAdminEnvironment;
  generation: number;
  sessionReference: string | null;
  sourceCorrelation: string | null;
};

export type TechnicalAdminAlert = {
  atMs: number;
  event: "sustained-throttle" | "global-throttle" | "unsafe-storage" | "reset-failure";
  environment: TechnicalAdminEnvironment;
  generation: number;
  sourceCorrelation: string | null;
};

export type AuthFailure =
  | "not-enrollable"
  | "invalid-enrollment"
  | "invalid-ceremony"
  | "invalid-credentials"
  | "not-authenticated"
  | "storage-failure"
  | "not-fresh"
  | "throttled";

export type AuthResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AuthFailure; retryAfterMs?: number };

export type CredentialRecord = {
  credentialId: string;
  publicKey: JsonWebKey;
  signCount: number;
  createdAtMs: number;
};

type ChallengeRecord = {
  id: string;
  value: string;
  purpose: "registration" | "authentication" | "fresh-verification" | "replacement";
  sessionId: string | null;
  freshPurpose: FreshVerificationPurpose | null;
  expiresAtMs: number;
  usedAtMs: number | null;
};

type SessionRecord = {
  id: string;
  tokenHash: string;
  createdAtMs: number;
  lastSeenAtMs: number;
  absoluteExpiresAtMs: number;
  revokedAtMs: number | null;
  csrfTokenHash: string;
  freshVerifiedAtMs: number | null;
  freshVerifiedPurpose: FreshVerificationPurpose | null;
};

type EnrollmentRecord = {
  tokenHash: string;
  expiresAtMs: number;
  usedAtMs: number | null;
};

export interface TechnicalAdminAuthRepository {
  hasCredential(): boolean;
  getCredential(): CredentialRecord | null;
  issueEnrollment(tokenHash: string, expiresAtMs: number): void;
  consumeEnrollment(tokenHash: string, nowMs: number): boolean;
  createChallenge(challenge: ChallengeRecord): void;
  consumeChallenge(
    id: string,
    purpose: ChallengeRecord["purpose"],
    nowMs: number,
    sessionId?: string,
  ): string | null;
  commitEnrollment(challengeId: string, credential: CredentialRecord): boolean;
  commitAuthentication(
    challengeId: string,
    credentialId: string,
    signCount: number,
    session: SessionRecord,
  ): boolean;
  commitFreshVerification(challengeId: string, signCount: number, nowMs: number): boolean;
  commitReplacement(
    challengeId: string,
    credentialId: string,
    credential: CredentialRecord,
    session: SessionRecord,
  ): boolean;
  getSession(tokenHash: string): SessionRecord | null;
  touchSession(id: string, nowMs: number): void;
  revokeSession(id: string, nowMs: number): void;
  revokeOtherSessions(id: string, nowMs: number): number;
  activeSessionCount(nowMs: number): number;
  getGeneration(): number;
  resetAuthority(nowMs: number, resetLog: TechnicalAdminOperationalLog): boolean;
  getStorageStatus(nowMs: number): TechnicalAdminStorageStatus;
  appendOperationalLog(log: TechnicalAdminOperationalLog): void;
  appendAlert(alert: TechnicalAdminAlert): void;
  nextTelemetryExpiry(): number | null;
  maintain(nowMs: number): void;
  close(): void;
}

export type TechnicalAdminStorageIdentity = {
  environment: TechnicalAdminEnvironment;
  origin: string;
  rpId: string;
};

export type SqliteTechnicalAdminAuthRepositoryOptions = {
  readwrite?: boolean;
};

export type TechnicalAdminRetentionScheduler = {
  schedule(callback: () => void, deadlineMs: number, onFailure?: () => void): unknown;
  cancel(timer: unknown): void;
  unref?(timer: unknown): void;
};

export type TechnicalAdminRetentionTimerSource = {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(timer: unknown): void;
  unref?(timer: unknown): void;
};

const MAX_RETENTION_TIMER_DELAY_MS = 2_147_483_647;

const defaultTechnicalAdminRetentionTimerSource: TechnicalAdminRetentionTimerSource = {
  schedule(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  cancel(timer) {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
  unref(timer) {
    (timer as { unref?: () => void }).unref?.();
  },
};

export function createTechnicalAdminRetentionScheduler(
  now: () => number = () => Date.now(),
  timerSource: TechnicalAdminRetentionTimerSource = defaultTechnicalAdminRetentionTimerSource,
): TechnicalAdminRetentionScheduler {
  type RetentionTimer = {
    cancelled: boolean;
    deadlineMs: number;
    timer: unknown;
    unrefRequested: boolean;
  };

  return {
    schedule(callback, deadlineMs, onFailure = () => {}) {
      const handle: RetentionTimer = {
        cancelled: false,
        deadlineMs,
        timer: null,
        unrefRequested: false,
      };
      let firstArm = true;
      let initialArm = true;
      const arm = () => {
        if (handle.cancelled) return;
        const remainingMs = handle.deadlineMs - now();
        if (!firstArm && remainingMs <= 0) {
          callback();
          return;
        }
        firstArm = false;
        try {
          handle.timer = timerSource.schedule(
            () => {
              if (handle.cancelled) return;
              if (handle.deadlineMs - now() <= 0) {
                callback();
                return;
              }
              arm();
            },
            Math.min(Math.max(0, remainingMs), MAX_RETENTION_TIMER_DELAY_MS),
          );
          if (handle.unrefRequested) timerSource.unref?.(handle.timer);
        } catch (error) {
          const failedTimer = handle.timer;
          handle.cancelled = true;
          handle.timer = null;
          if (failedTimer !== null) {
            try {
              timerSource.cancel(failedTimer);
            } catch {
              // Timer cleanup is best effort after a timer-source failure.
            }
          }
          if (initialArm) throw error;
          queueMicrotask(() => {
            try {
              onFailure();
            } catch {
              // A scheduler failure notification must not escape the timer boundary.
            }
          });
        }
      };
      arm();
      initialArm = false;
      return handle;
    },
    cancel(timer) {
      const handle = timer as RetentionTimer;
      handle.cancelled = true;
      timerSource.cancel(handle.timer);
      handle.timer = null;
    },
    unref(timer) {
      const handle = timer as RetentionTimer;
      handle.unrefRequested = true;
      if (handle.timer !== null) timerSource.unref?.(handle.timer);
    },
  };
}

const ENROLLMENT_TTL_MS = 10 * 60 * 1_000;
const CHALLENGE_TTL_MS = 5 * 60 * 1_000;
const SESSION_IDLE_TTL_MS = 2 * 60 * 60 * 1_000;
const SESSION_ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1_000;
const FRESH_VERIFICATION_TTL_MS = 5 * 60 * 1_000;
const AUTH_FAILURE_WINDOW_MS = 10 * 60 * 1_000;
const AUTH_GLOBAL_WINDOW_MS = 60 * 1_000;
const AUTH_GLOBAL_LIMIT = 60;
const AUTH_IMMEDIATE_FAILURES = 5;
const AUTH_MAX_DELAY_MS = 30 * 1_000;
const LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const RETENTION_RECOVERY_RETRY_MS = 60 * 1_000;
const TOKEN_BYTES = 32;

export function createTechnicalAdminAuth(
  config: TechnicalAdminAuthConfig,
  repository: TechnicalAdminAuthRepository,
  verifier: WebAuthnVerifier = new NativeWebAuthnVerifier(),
  now: () => number = () => Date.now(),
): TechnicalAdminAuth {
  const expectedOrigin = new URL(config.origin).origin;
  const expectedUrl = new URL(config.origin);
  const expectedHost = expectedUrl.host;
  if (
    expectedOrigin !== config.origin ||
    expectedUrl.protocol !== "https:" ||
    config.rpId !== expectedUrl.hostname
  ) {
    throw new Error("Technical Admin origin must be an exact origin.");
  }

  const sourceFailures = new Map<string, number[]>();
  const completionTimes: number[] = [];
  const sourceCorrelationKey = config.logKey ?? randomToken();
  let retentionScheduler: TechnicalAdminRetentionScheduler | null = null;
  let retentionTimer: unknown = null;
  let retentionRecoveryQueued = false;
  let retentionRecoveryGeneration = 0;

  const cancelRetentionTimer = (): boolean => {
    const timer = retentionTimer;
    if (timer === null) return true;
    if (retentionScheduler === null) {
      retentionTimer = null;
      return true;
    }
    try {
      retentionScheduler.cancel(timer);
      retentionTimer = null;
      return true;
    } catch {
      // Scheduler cleanup is best effort and never escapes an auth boundary.
      return false;
    }
  };

  const attemptSchedule = (deadlineMs: number, callback: () => void): boolean => {
    const scheduler = retentionScheduler;
    if (scheduler === null || retentionTimer !== null) return false;
    let scheduling = true;
    let discarded = false;
    let deferred = false;
    const dispatch = () => {
      if (!scheduling) {
        callback();
        return;
      }
      if (deferred) return;
      deferred = true;
      queueMicrotask(() => {
        deferred = false;
        if (!discarded) callback();
      });
    };
    let scheduledTimer: unknown = null;
    const onSchedulerFailure = () => {
      if (scheduling) {
        queueMicrotask(onSchedulerFailure);
        return;
      }
      if (retentionTimer !== scheduledTimer) return;
      retentionTimer = null;
      requestRecoveryRetry();
    };
    try {
      const timer = scheduler.schedule(dispatch, deadlineMs, onSchedulerFailure);
      scheduledTimer = timer;
      scheduling = false;
      retentionTimer = timer;
      try {
        scheduler.unref?.(timer);
      } catch {
        discarded = true;
        cancelRetentionTimer();
        return false;
      }
      return true;
    } catch {
      scheduling = false;
      discarded = true;
      retentionTimer = null;
      return false;
    }
  };

  const requestRecoveryRetry = () => {
    const scheduler = retentionScheduler;
    if (scheduler === null || retentionTimer !== null || retentionRecoveryQueued) return;
    retentionRecoveryQueued = true;
    const generation = retentionRecoveryGeneration;
    queueMicrotask(() => {
      if (generation !== retentionRecoveryGeneration) return;
      retentionRecoveryQueued = false;
      if (retentionScheduler !== scheduler || retentionTimer !== null) return;
      attemptSchedule(now() + RETENTION_RECOVERY_RETRY_MS, () => {
        retentionTimer = null;
        try {
          repository.maintain(now());
        } catch {
          requestRecoveryRetry();
          return;
        }
        refreshRetentionSchedule();
      });
    });
  };

  const refreshRetentionSchedule = () => {
    if (retentionScheduler === null) return;
    if (!cancelRetentionTimer()) return;
    let expiry: number | null;
    try {
      expiry = repository.nextTelemetryExpiry();
    } catch {
      requestRecoveryRetry();
      return;
    }
    if (expiry === null) return;
    const scheduled = attemptSchedule(expiry, () => {
      retentionTimer = null;
      try {
        repository.maintain(now());
      } catch {
        requestRecoveryRetry();
        return;
      }
      refreshRetentionSchedule();
    });
    if (!scheduled) requestRecoveryRetry();
  };

  const scheduleRetention = refreshRetentionSchedule;

  const recordLog = (
    event: TechnicalAdminOperationalLog["event"],
    outcome: TechnicalAdminOperationalLog["outcome"],
    sessionReference: string | null = null,
    sourceCorrelation: string | null = null,
  ): boolean => {
    try {
      repository.appendOperationalLog({
        atMs: now(),
        event,
        outcome,
        environment: config.environment,
        generation: repository.getGeneration(),
        sessionReference,
        sourceCorrelation,
      });
      scheduleRetention();
      return true;
    } catch {
      // Operational telemetry is redacted and bounded, but never becomes a fail-open path.
      return false;
    }
  };

  const recordAlert = (
    event: TechnicalAdminAlert["event"],
    sourceCorrelation: string | null = null,
  ) => {
    try {
      repository.appendAlert({
        atMs: now(),
        event,
        environment: config.environment,
        generation: repository.getGeneration(),
        sourceCorrelation,
      });
      scheduleRetention();
    } catch {
      // Alert transport is best effort and never changes the authority decision.
    }
  };

  const completionGate = (sourceCorrelation: string): AuthResult<void> | null => {
    const current = now();
    while (
      completionTimes[0] !== undefined &&
      completionTimes[0] <= current - AUTH_GLOBAL_WINDOW_MS
    ) {
      completionTimes.shift();
    }
    if (completionTimes.length >= AUTH_GLOBAL_LIMIT) {
      const retryAfterMs = Math.max(
        1_000,
        (completionTimes[0] ?? current) + AUTH_GLOBAL_WINDOW_MS - current,
      );
      recordLog("throttled", "rejected", null, sourceCorrelation);
      recordAlert("global-throttle", sourceCorrelation);
      return { ok: false, error: "throttled", retryAfterMs };
    }
    completionTimes.push(current);
    const failures = sourceFailures.get(sourceCorrelation) ?? [];
    while (failures[0] !== undefined && failures[0] <= current - AUTH_FAILURE_WINDOW_MS) {
      failures.shift();
    }
    const delayIndex = failures.length - AUTH_IMMEDIATE_FAILURES;
    if (delayIndex >= 0) {
      const delayMs = Math.min(2 ** delayIndex * 1_000, AUTH_MAX_DELAY_MS);
      const retryAfterMs = Math.max(0, (failures.at(-1) ?? current) + delayMs - current);
      if (retryAfterMs > 0) {
        recordLog("throttled", "rejected", null, sourceCorrelation);
        if (delayIndex > 0) recordAlert("sustained-throttle", sourceCorrelation);
        return { ok: false, error: "throttled", retryAfterMs };
      }
    }
    return null;
  };

  const noteFailure = (sourceCorrelation: string, event: TechnicalAdminOperationalLog["event"]) => {
    const failures = sourceFailures.get(sourceCorrelation) ?? [];
    failures.push(now());
    sourceFailures.set(sourceCorrelation, failures);
    recordLog(event, "rejected", null, sourceCorrelation);
  };

  const clearFailures = (sourceCorrelation: string) => {
    sourceFailures.delete(sourceCorrelation);
  };

  const getActiveSession = (token: string, current: number) => {
    const session = repository.getSession(hashToken(token));
    if (
      session === null ||
      session.revokedAtMs !== null ||
      current >= session.absoluteExpiresAtMs ||
      current - session.lastSeenAtMs >= SESSION_IDLE_TTL_MS
    ) {
      return null;
    }
    return session;
  };

  const freshSession = (session: SessionRecord, current: number) =>
    session.freshVerifiedAtMs !== null &&
    current - session.freshVerifiedAtMs < FRESH_VERIFICATION_TTL_MS;

  const freshSessionFor = (
    session: SessionRecord,
    current: number,
    purpose: FreshVerificationPurpose,
  ) => freshSession(session, current) && session.freshVerifiedPurpose === purpose;

  const createSession = (current: number) => {
    const token = randomToken();
    const csrfToken = randomToken();
    return {
      token,
      csrfToken,
      session: {
        id: crypto.randomUUID(),
        tokenHash: hashToken(token),
        createdAtMs: current,
        lastSeenAtMs: current,
        absoluteExpiresAtMs: current + SESSION_ABSOLUTE_TTL_MS,
        revokedAtMs: null,
        csrfTokenHash: hashToken(csrfToken),
        freshVerifiedAtMs: null,
        freshVerifiedPurpose: null,
      } satisfies SessionRecord,
    };
  };

  return {
    issueEnrollmentAuthorization(): AuthResult<EnrollmentAuthorization> {
      try {
        if (repository.hasCredential()) return { ok: false, error: "not-enrollable" };
        const secret = randomToken();
        const expiresAtMs = now() + ENROLLMENT_TTL_MS;
        repository.issueEnrollment(hashToken(secret), expiresAtMs);
        recordLog("enrollment-issued", "accepted");
        return {
          ok: true,
          value: {
            url: `${config.origin}/admin/enroll#token=${encodeURIComponent(secret)}`,
            expiresAtMs,
          },
        };
      } catch {
        return { ok: false, error: "storage-failure" };
      }
    },

    beginEnrollment(token: string, binding: CeremonyBinding): AuthResult<RegistrationOptions> {
      try {
        if (!isExactBinding(binding, expectedOrigin, expectedHost) || repository.hasCredential()) {
          return { ok: false, error: "invalid-enrollment" };
        }
        const current = now();
        if (!repository.consumeEnrollment(hashToken(token), current)) {
          return { ok: false, error: "invalid-enrollment" };
        }
        const challenge = createChallenge("registration", current);
        repository.createChallenge(challenge);
        return {
          ok: true,
          value: {
            challengeId: challenge.id,
            challenge: challenge.value,
            rp: { id: config.rpId, name: "Quadball Timer" },
            user: {
              id: base64UrlEncode(
                new TextEncoder().encode(`${config.environment}:technical-admin`),
              ),
              name: "technical-admin",
              displayName: "Technical Admin",
            },
            timeout: CHALLENGE_TTL_MS,
            attestation: "none",
            authenticatorSelection: { residentKey: "required", userVerification: "required" },
          },
        };
      } catch {
        return { ok: false, error: "storage-failure" };
      }
    },

    async completeEnrollment(
      challengeId: string,
      response: unknown,
      binding: CeremonyBinding,
      sourceCorrelation = "unknown",
    ): Promise<AuthResult<void>> {
      if (!isExactBinding(binding, expectedOrigin, expectedHost)) {
        return { ok: false, error: "invalid-ceremony" };
      }
      const gated = completionGate(sourceCorrelation);
      if (gated !== null) return gated;
      try {
        const challenge = consumeChallenge(repository, challengeId, "registration", now());
        if (challenge === null || repository.hasCredential()) {
          return { ok: false, error: "invalid-ceremony" };
        }
        const credential = await verifier.verifyRegistration(response, {
          challenge,
          origin: expectedOrigin,
          rpId: config.rpId,
          requireUserVerification: true,
        });
        if (
          !repository.commitEnrollment(challengeId, {
            ...credential,
            createdAtMs: now(),
          })
        ) {
          noteFailure(sourceCorrelation, "enrollment-completed");
          return { ok: false, error: "invalid-ceremony" };
        }
        recordLog("enrollment-completed", "accepted", null, sourceCorrelation);
        return { ok: true, value: undefined };
      } catch {
        noteFailure(sourceCorrelation, "enrollment-completed");
        return { ok: false, error: "invalid-ceremony" };
      }
    },

    beginAuthentication(binding: CeremonyBinding): AuthResult<AuthenticationOptions> {
      if (!isExactBinding(binding, expectedOrigin, expectedHost)) {
        return { ok: false, error: "invalid-ceremony" };
      }
      try {
        const credential = repository.getCredential();
        if (credential === null) return { ok: false, error: "invalid-credentials" };
        const challenge = createChallenge("authentication", now());
        repository.createChallenge(challenge);
        return {
          ok: true,
          value: {
            challengeId: challenge.id,
            challenge: challenge.value,
            rpId: config.rpId,
            allowCredentials: [{ id: credential.credentialId, type: "public-key" }],
            timeout: CHALLENGE_TTL_MS,
            userVerification: "required",
          },
        };
      } catch {
        return { ok: false, error: "storage-failure" };
      }
    },

    async completeAuthentication(
      challengeId: string,
      response: unknown,
      binding: CeremonyBinding,
      sourceCorrelation = "unknown",
    ): Promise<AuthResult<TechnicalAdminSession>> {
      if (!isExactBinding(binding, expectedOrigin, expectedHost)) {
        return { ok: false, error: "invalid-ceremony" };
      }
      const gated = completionGate(sourceCorrelation);
      if (gated !== null) return gated as AuthResult<TechnicalAdminSession>;
      try {
        const credential = repository.getCredential();
        const challenge = consumeChallenge(repository, challengeId, "authentication", now());
        if (credential === null || challenge === null) {
          noteFailure(sourceCorrelation, "authentication-failed");
          return { ok: false, error: "invalid-ceremony" };
        }
        const result = await verifier.verifyAuthentication(response, {
          challenge,
          origin: expectedOrigin,
          rpId: config.rpId,
          credential,
          requireUserVerification: true,
        });
        const nextSignCount = result.signCount === 0 ? credential.signCount : result.signCount;
        const current = now();
        const created = createSession(current);
        if (
          !repository.commitAuthentication(
            challengeId,
            credential.credentialId,
            nextSignCount,
            created.session,
          )
        ) {
          noteFailure(sourceCorrelation, "authentication-failed");
          return { ok: false, error: "invalid-ceremony" };
        }
        clearFailures(sourceCorrelation);
        recordLog("authentication-succeeded", "accepted", created.session.id, sourceCorrelation);
        return {
          ok: true,
          value: {
            token: created.token,
            csrfToken: created.csrfToken,
            expiresAtMs: created.session.absoluteExpiresAtMs,
          },
        };
      } catch {
        noteFailure(sourceCorrelation, "authentication-failed");
        return { ok: false, error: "invalid-ceremony" };
      }
    },

    beginFreshVerification(
      token: string,
      purpose: FreshVerificationPurpose,
      binding: CeremonyBinding,
    ): AuthResult<AuthenticationOptions> {
      if (!isExactBinding(binding, expectedOrigin, expectedHost)) {
        return { ok: false, error: "invalid-ceremony" };
      }
      try {
        const current = now();
        const session = getActiveSession(token, current);
        const credential = repository.getCredential();
        if (session === null || credential === null) {
          return { ok: false, error: "not-authenticated" };
        }
        const challenge = createChallenge("fresh-verification", current, session.id, purpose);
        repository.createChallenge(challenge);
        return {
          ok: true,
          value: {
            challengeId: challenge.id,
            challenge: challenge.value,
            rpId: config.rpId,
            allowCredentials: [{ id: credential.credentialId, type: "public-key" }],
            timeout: CHALLENGE_TTL_MS,
            userVerification: "required",
          },
        };
      } catch {
        return { ok: false, error: "storage-failure" };
      }
    },

    async completeFreshVerification(
      token: string,
      challengeId: string,
      response: unknown,
      binding: CeremonyBinding,
      sourceCorrelation = "unknown",
    ): Promise<AuthResult<void>> {
      if (!isExactBinding(binding, expectedOrigin, expectedHost)) {
        return { ok: false, error: "invalid-ceremony" };
      }
      const gated = completionGate(sourceCorrelation);
      if (gated !== null) return gated;
      try {
        const current = now();
        const session = getActiveSession(token, current);
        const credential = repository.getCredential();
        const challenge = consumeChallenge(
          repository,
          challengeId,
          "fresh-verification",
          current,
          session?.id,
        );
        if (session === null || credential === null || challenge === null) {
          noteFailure(sourceCorrelation, "fresh-verification-failed");
          return { ok: false, error: "invalid-ceremony" };
        }
        const result = await verifier.verifyAuthentication(response, {
          challenge,
          origin: expectedOrigin,
          rpId: config.rpId,
          credential,
          requireUserVerification: true,
        });
        if (!repository.commitFreshVerification(challengeId, result.signCount, now())) {
          noteFailure(sourceCorrelation, "fresh-verification-failed");
          return { ok: false, error: "invalid-ceremony" };
        }
        clearFailures(sourceCorrelation);
        recordLog("fresh-verification-succeeded", "accepted", null, sourceCorrelation);
        return { ok: true, value: undefined };
      } catch {
        noteFailure(sourceCorrelation, "fresh-verification-failed");
        return { ok: false, error: "invalid-ceremony" };
      }
    },

    beginReplacement(token: string, binding: CeremonyBinding): AuthResult<RegistrationOptions> {
      if (!isExactBinding(binding, expectedOrigin, expectedHost)) {
        return { ok: false, error: "invalid-ceremony" };
      }
      try {
        const current = now();
        const session = getActiveSession(token, current);
        const credential = repository.getCredential();
        if (session === null) return { ok: false, error: "not-authenticated" };
        if (!freshSessionFor(session, current, "replace-credential")) {
          return { ok: false, error: "not-fresh" };
        }
        if (credential === null) return { ok: false, error: "invalid-credentials" };
        const challenge = createChallenge("replacement", current, session.id, "replace-credential");
        repository.createChallenge(challenge);
        return {
          ok: true,
          value: {
            challengeId: challenge.id,
            challenge: challenge.value,
            rp: { id: config.rpId, name: "Quadball Timer" },
            user: {
              id: base64UrlEncode(
                new TextEncoder().encode(`${config.environment}:technical-admin`),
              ),
              name: "technical-admin",
              displayName: "Technical Admin",
            },
            timeout: CHALLENGE_TTL_MS,
            attestation: "none",
            authenticatorSelection: { residentKey: "required", userVerification: "required" },
          },
        };
      } catch {
        return { ok: false, error: "storage-failure" };
      }
    },

    async completeReplacement(
      token: string,
      challengeId: string,
      response: unknown,
      binding: CeremonyBinding,
      sourceCorrelation = "unknown",
    ): Promise<AuthResult<TechnicalAdminSession>> {
      if (!isExactBinding(binding, expectedOrigin, expectedHost)) {
        return { ok: false, error: "invalid-ceremony" };
      }
      const gated = completionGate(sourceCorrelation);
      if (gated !== null) return gated as AuthResult<TechnicalAdminSession>;
      try {
        const current = now();
        const session = getActiveSession(token, current);
        const credential = repository.getCredential();
        if (
          session === null ||
          credential === null ||
          !freshSessionFor(session, current, "replace-credential")
        ) {
          noteFailure(sourceCorrelation, "credential-replaced");
          return { ok: false, error: "invalid-ceremony" };
        }
        const challenge = consumeChallenge(
          repository,
          challengeId,
          "replacement",
          current,
          session.id,
        );
        if (challenge === null) {
          noteFailure(sourceCorrelation, "credential-replaced");
          return { ok: false, error: "invalid-ceremony" };
        }
        const replacement = await verifier.verifyRegistration(response, {
          challenge,
          origin: expectedOrigin,
          rpId: config.rpId,
          requireUserVerification: true,
        });
        const created = createSession(current);
        if (
          !repository.commitReplacement(
            challengeId,
            credential.credentialId,
            { ...replacement, createdAtMs: current },
            created.session,
          )
        ) {
          noteFailure(sourceCorrelation, "credential-replaced");
          return { ok: false, error: "invalid-ceremony" };
        }
        clearFailures(sourceCorrelation);
        recordLog("credential-replaced", "accepted", created.session.id, sourceCorrelation);
        return {
          ok: true,
          value: {
            token: created.token,
            csrfToken: created.csrfToken,
            expiresAtMs: created.session.absoluteExpiresAtMs,
          },
        };
      } catch {
        noteFailure(sourceCorrelation, "credential-replaced");
        return { ok: false, error: "invalid-ceremony" };
      }
    },

    authenticateSession(token: string): boolean {
      try {
        const current = now();
        const session = getActiveSession(token, current);
        if (session === null) {
          return false;
        }
        repository.touchSession(session.id, current);
        return true;
      } catch {
        return false;
      }
    },

    logout(token: string): void {
      try {
        const session = repository.getSession(hashToken(token));
        if (session !== null) {
          repository.revokeSession(session.id, now());
          recordLog("logout", "accepted", session.id);
        }
      } catch {
        // Logout is intentionally idempotent and fail-closed.
      }
    },

    verifyCsrf(token: string, csrfToken: string): boolean {
      try {
        const session = getActiveSession(token, now());
        return session !== null && constantTimeEqual(session.csrfTokenHash, hashToken(csrfToken));
      } catch {
        return false;
      }
    },

    activeSessionCount(): number {
      try {
        return repository.activeSessionCount(now());
      } catch {
        return 0;
      }
    },

    resolveCurrentAuthority(token: string): TechnicalAdminAuthority | null {
      try {
        const session = getActiveSession(token, now());
        if (session === null) return null;
        repository.touchSession(session.id, now());
        return {
          kind: "technical-admin",
          environment: config.environment,
          sessionId: session.id,
          [technicalAdminAuthorityBrand]: true,
        };
      } catch {
        return null;
      }
    },

    storageStatus(): TechnicalAdminStorageStatus {
      try {
        const current = now();
        const status = repository.getStorageStatus(current);
        scheduleRetention();
        if (status.state !== "ready") recordAlert("unsafe-storage");
        return status;
      } catch {
        scheduleRetention();
        recordAlert("unsafe-storage");
        return {
          state: "unavailable",
          credentialPresent: false,
          activeSessionCount: 0,
          generation: 0,
        };
      }
    },

    startRetentionMaintenance(scheduler: TechnicalAdminRetentionScheduler): void {
      this.stopRetentionMaintenance();
      retentionScheduler = scheduler;
      scheduleRetention();
    },

    stopRetentionMaintenance(): void {
      retentionRecoveryGeneration += 1;
      retentionRecoveryQueued = false;
      cancelRetentionTimer();
      retentionScheduler = null;
    },

    close(): void {
      this.stopRetentionMaintenance();
    },

    emergencyReset(): AuthResult<EnrollmentAuthorization> {
      try {
        const current = now();
        const resetLog: TechnicalAdminOperationalLog = {
          atMs: current,
          event: "emergency-reset",
          outcome: "accepted",
          environment: config.environment,
          generation: repository.getGeneration() + 1,
          sessionReference: null,
          sourceCorrelation: null,
        };
        if (!repository.resetAuthority(current, resetLog)) {
          recordAlert("reset-failure");
          return { ok: false, error: "storage-failure" };
        }
        return this.issueEnrollmentAuthorization();
      } catch {
        recordAlert("reset-failure");
        return { ok: false, error: "storage-failure" };
      }
    },

    revokeOtherSessions(token: string): AuthResult<{ revokedCount: number }> {
      try {
        const current = now();
        const session = getActiveSession(token, current);
        if (session === null) return { ok: false, error: "not-authenticated" };
        if (!freshSessionFor(session, current, "revoke-other-sessions")) {
          return { ok: false, error: "not-fresh" };
        }
        const revokedCount = repository.revokeOtherSessions(session.id, current);
        recordLog("other-sessions-revoked", "accepted", session.id);
        return { ok: true, value: { revokedCount } };
      } catch {
        return { ok: false, error: "storage-failure" };
      }
    },

    correlateSource(value: string): string {
      return hashToken(`${sourceCorrelationKey}:${value}`);
    },

    isExpectedBinding(binding: CeremonyBinding): boolean {
      return isExactBinding(binding, expectedOrigin, expectedHost);
    },

    config,
  };
}

export interface TechnicalAdminAuth {
  issueEnrollmentAuthorization(): AuthResult<EnrollmentAuthorization>;
  beginEnrollment(token: string, binding: CeremonyBinding): AuthResult<RegistrationOptions>;
  completeEnrollment(
    challengeId: string,
    response: unknown,
    binding: CeremonyBinding,
    sourceCorrelation?: string,
  ): Promise<AuthResult<void>>;
  beginAuthentication(binding: CeremonyBinding): AuthResult<AuthenticationOptions>;
  completeAuthentication(
    challengeId: string,
    response: unknown,
    binding: CeremonyBinding,
    sourceCorrelation?: string,
  ): Promise<AuthResult<TechnicalAdminSession>>;
  beginFreshVerification(
    token: string,
    purpose: FreshVerificationPurpose,
    binding: CeremonyBinding,
  ): AuthResult<AuthenticationOptions>;
  completeFreshVerification(
    token: string,
    challengeId: string,
    response: unknown,
    binding: CeremonyBinding,
    sourceCorrelation?: string,
  ): Promise<AuthResult<void>>;
  beginReplacement(token: string, binding: CeremonyBinding): AuthResult<RegistrationOptions>;
  completeReplacement(
    token: string,
    challengeId: string,
    response: unknown,
    binding: CeremonyBinding,
    sourceCorrelation?: string,
  ): Promise<AuthResult<TechnicalAdminSession>>;
  authenticateSession(token: string): boolean;
  logout(token: string): void;
  verifyCsrf(token: string, csrfToken: string): boolean;
  activeSessionCount(): number;
  resolveCurrentAuthority(token: string): TechnicalAdminAuthority | null;
  storageStatus(): TechnicalAdminStorageStatus;
  startRetentionMaintenance(scheduler: TechnicalAdminRetentionScheduler): void;
  stopRetentionMaintenance(): void;
  close(): void;
  emergencyReset(): AuthResult<EnrollmentAuthorization>;
  revokeOtherSessions(token: string): AuthResult<{ revokedCount: number }>;
  correlateSource(value: string): string;
  isExpectedBinding(binding: CeremonyBinding): boolean;
  config: TechnicalAdminAuthConfig;
}

export type WebAuthnRegistrationExpectation = {
  challenge: string;
  origin: string;
  rpId: string;
  requireUserVerification: boolean;
};

export type WebAuthnAuthenticationExpectation = WebAuthnRegistrationExpectation & {
  credential: CredentialRecord;
};

export interface WebAuthnVerifier {
  verifyRegistration(
    response: unknown,
    expectation: WebAuthnRegistrationExpectation,
  ): Promise<Omit<CredentialRecord, "createdAtMs">>;
  verifyAuthentication(
    response: unknown,
    expectation: WebAuthnAuthenticationExpectation,
  ): Promise<{ signCount: number }>;
}

export class NativeWebAuthnVerifier implements WebAuthnVerifier {
  async verifyRegistration(
    response: unknown,
    expectation: WebAuthnRegistrationExpectation,
  ): Promise<Omit<CredentialRecord, "createdAtMs">> {
    const parsed = parseCredentialResponse(response, "registration");
    parseClientData(parsed.clientDataJSON, "webauthn.create", expectation);
    const attestation = decodeCbor(parsed.attestationObject);
    if (!(attestation instanceof Map)) throw new Error("Invalid attestation object.");
    if (attestation.get("fmt") !== "none") throw new Error("Unsupported attestation format.");
    const authData = bytesFrom(attestation.get("authData"));
    const parsedAuthData = parseAuthenticatorData(authData, true, expectation.rpId);
    if (!parsedAuthData.credentialId || !parsedAuthData.publicKey) {
      throw new Error("Missing attested credential data.");
    }
    return {
      credentialId: base64UrlEncode(parsedAuthData.credentialId),
      publicKey: parsedAuthData.publicKey,
      signCount: parsedAuthData.signCount,
    };
  }

  async verifyAuthentication(
    response: unknown,
    expectation: WebAuthnAuthenticationExpectation,
  ): Promise<{ signCount: number }> {
    const parsed = parseCredentialResponse(response, "authentication");
    if (parsed.id !== expectation.credential.credentialId)
      throw new Error("Unexpected credential.");
    parseClientData(parsed.clientDataJSON, "webauthn.get", expectation);
    const authData = parseAuthenticatorData(parsed.authenticatorData, false, expectation.rpId);
    if (!authData.userVerification || !authData.userPresent) throw new Error("UV required.");
    const clientDataHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", parsed.clientDataJSON as BufferSource),
    );
    const signedData = concatBytes(parsed.authenticatorData, clientDataHash);
    const valid = await verifyWebAuthnSignature(
      expectation.credential.publicKey,
      parsed.signature,
      signedData,
    );
    if (!valid) throw new Error("Invalid signature.");
    if (
      expectation.credential.signCount !== 0 &&
      authData.signCount !== 0 &&
      authData.signCount <= expectation.credential.signCount
    ) {
      throw new Error("Authenticator counter did not advance.");
    }
    return { signCount: authData.signCount };
  }
}

export class MemoryTechnicalAdminAuthRepository implements TechnicalAdminAuthRepository {
  credential: CredentialRecord | null = null;
  enrollment: EnrollmentRecord | null = null;
  challenges = new Map<string, ChallengeRecord>();
  sessions = new Map<string, SessionRecord>();
  logs: TechnicalAdminOperationalLog[] = [];
  alerts: TechnicalAdminAlert[] = [];
  generation = 0;

  hasCredential() {
    return this.credential !== null;
  }
  getCredential() {
    return this.credential;
  }
  issueEnrollment(tokenHash: string, expiresAtMs: number) {
    this.enrollment = { tokenHash, expiresAtMs, usedAtMs: null };
  }
  consumeEnrollment(tokenHash: string, nowMs: number) {
    if (
      this.enrollment === null ||
      this.enrollment.tokenHash !== tokenHash ||
      this.enrollment.usedAtMs !== null ||
      nowMs >= this.enrollment.expiresAtMs
    )
      return false;
    this.enrollment.usedAtMs = nowMs;
    return true;
  }
  createChallenge(challenge: ChallengeRecord) {
    this.challenges.set(challenge.id, challenge);
  }
  consumeChallenge(
    id: string,
    purpose: ChallengeRecord["purpose"],
    nowMs: number,
    sessionId?: string,
  ) {
    const challenge = this.challenges.get(id);
    if (
      challenge === undefined ||
      challenge.purpose !== purpose ||
      (sessionId !== undefined && challenge.sessionId !== sessionId) ||
      challenge.usedAtMs !== null ||
      nowMs >= challenge.expiresAtMs
    )
      return null;
    challenge.usedAtMs = nowMs;
    return challenge.value;
  }
  commitEnrollment(challengeId: string, credential: CredentialRecord) {
    if (this.credential !== null || !this.challenges.has(challengeId)) return false;
    this.credential = credential;
    return true;
  }
  commitAuthentication(
    _challengeId: string,
    credentialId: string,
    signCount: number,
    session: SessionRecord,
  ) {
    if (this.credential === null || this.credential.credentialId !== credentialId) return false;
    this.credential = { ...this.credential, signCount };
    this.sessions.set(session.id, session);
    return true;
  }
  commitFreshVerification(challengeId: string, signCount: number, nowMs: number) {
    const challenge = this.challenges.get(challengeId);
    if (
      challenge?.purpose !== "fresh-verification" ||
      challenge.sessionId === null ||
      challenge.freshPurpose === null ||
      challenge.usedAtMs === null ||
      this.credential === null
    )
      return false;
    const session = this.sessions.get(challenge.sessionId);
    if (session === undefined || session.revokedAtMs !== null) return false;
    if (signCount !== 0 && signCount <= this.credential.signCount) return false;
    this.credential = {
      ...this.credential,
      signCount: signCount === 0 ? this.credential.signCount : signCount,
    };
    session.freshVerifiedAtMs = nowMs;
    session.freshVerifiedPurpose = challenge.freshPurpose;
    return true;
  }
  commitReplacement(
    challengeId: string,
    credentialId: string,
    credential: CredentialRecord,
    session: SessionRecord,
  ) {
    const challenge = this.challenges.get(challengeId);
    if (
      this.credential === null ||
      this.credential.credentialId !== credentialId ||
      challenge?.purpose !== "replacement" ||
      challenge.sessionId === null
    )
      return false;
    const current = this.sessions.get(challenge.sessionId);
    if (current === undefined || current.revokedAtMs !== null) return false;
    for (const existing of this.sessions.values()) {
      if (existing.revokedAtMs === null) existing.revokedAtMs = session.createdAtMs;
    }
    this.credential = credential;
    this.sessions.set(session.id, session);
    this.generation += 1;
    return true;
  }
  getSession(tokenHash: string) {
    return [...this.sessions.values()].find((session) => session.tokenHash === tokenHash) ?? null;
  }
  touchSession(id: string, nowMs: number) {
    const session = this.sessions.get(id);
    if (session) session.lastSeenAtMs = nowMs;
  }
  revokeSession(id: string, nowMs: number) {
    const session = this.sessions.get(id);
    if (session) session.revokedAtMs = nowMs;
  }
  revokeOtherSessions(id: string, nowMs: number) {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.id !== id && session.revokedAtMs === null) {
        session.revokedAtMs = nowMs;
        count += 1;
      }
    }
    return count;
  }
  activeSessionCount(nowMs: number) {
    return [...this.sessions.values()].filter(
      (session) =>
        session.revokedAtMs === null &&
        nowMs < session.absoluteExpiresAtMs &&
        nowMs - session.lastSeenAtMs < SESSION_IDLE_TTL_MS,
    ).length;
  }
  getGeneration() {
    return this.generation;
  }
  resetAuthority(nowMs: number, resetLog: TechnicalAdminOperationalLog) {
    const previousCredential = this.credential;
    const previousEnrollment = this.enrollment;
    const previousChallenges = new Map(this.challenges);
    const previousSessions = new Map(
      [...this.sessions].map(([id, session]) => [id, { ...session }] as const),
    );
    const previousLogs = [...this.logs];
    const previousGeneration = this.generation;
    try {
      this.credential = null;
      this.enrollment = null;
      this.challenges.clear();
      for (const session of this.sessions.values()) {
        if (session.revokedAtMs === null) session.revokedAtMs = nowMs;
      }
      this.generation += 1;
      this.appendOperationalLog(resetLog);
      return true;
    } catch {
      this.credential = previousCredential;
      this.enrollment = previousEnrollment;
      this.challenges = previousChallenges;
      this.sessions = previousSessions;
      this.logs = previousLogs;
      this.generation = previousGeneration;
      return false;
    }
  }
  getStorageStatus(nowMs: number): TechnicalAdminStorageStatus {
    this.maintain(nowMs);
    return {
      state: "ready",
      credentialPresent: this.credential !== null,
      activeSessionCount: this.activeSessionCount(nowMs),
      generation: this.generation,
    };
  }
  appendOperationalLog(log: TechnicalAdminOperationalLog) {
    this.logs = [...this.logs.filter((entry) => entry.atMs > log.atMs - LOG_RETENTION_MS), log];
  }
  appendAlert(alert: TechnicalAdminAlert) {
    this.alerts = [
      ...this.alerts.filter((entry) => entry.atMs > alert.atMs - LOG_RETENTION_MS),
      alert,
    ];
  }
  nextTelemetryExpiry() {
    const timestamps = [...this.logs, ...this.alerts].map((entry) => entry.atMs + LOG_RETENTION_MS);
    return timestamps.length === 0 ? null : Math.min(...timestamps);
  }
  maintain(nowMs: number) {
    const cutoff = nowMs - LOG_RETENTION_MS;
    this.logs = this.logs.filter((entry) => entry.atMs > cutoff);
    this.alerts = this.alerts.filter((entry) => entry.atMs > cutoff);
  }
  close() {}
}

export class SqliteTechnicalAdminAuthRepository implements TechnicalAdminAuthRepository {
  readonly database: Database;
  constructor(
    databasePath: string,
    identity?: TechnicalAdminStorageIdentity,
    options: SqliteTechnicalAdminAuthRepositoryOptions = {},
  ) {
    mkdirSync(dirname(databasePath), { recursive: true });
    const readwrite = options.readwrite ?? true;
    this.database = readwrite
      ? new Database(databasePath, { create: true, readwrite: true })
      : new Database(databasePath, { readonly: true });
    if (!readwrite) return;
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS technical_admin_credentials (
        credential_id TEXT PRIMARY KEY, public_key_json TEXT NOT NULL, sign_count INTEGER NOT NULL, created_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS technical_admin_enrollment (
        token_hash TEXT PRIMARY KEY, expires_at_ms INTEGER NOT NULL, used_at_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS technical_admin_challenges (
        challenge_id TEXT PRIMARY KEY, challenge TEXT NOT NULL, purpose TEXT NOT NULL, session_id TEXT, fresh_purpose TEXT, expires_at_ms INTEGER NOT NULL, used_at_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS technical_admin_sessions (
        session_id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, created_at_ms INTEGER NOT NULL, last_seen_at_ms INTEGER NOT NULL,
        absolute_expires_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER, csrf_token_hash TEXT NOT NULL, fresh_verified_at_ms INTEGER, fresh_verified_purpose TEXT
      );
      CREATE TABLE IF NOT EXISTS technical_admin_storage_identity (
        id INTEGER PRIMARY KEY CHECK (id = 1), environment TEXT NOT NULL, origin TEXT NOT NULL, rp_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS technical_admin_state (
        id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS technical_admin_operational_logs (
        log_id INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, event TEXT NOT NULL, outcome TEXT NOT NULL,
        environment TEXT NOT NULL, generation INTEGER NOT NULL, session_reference TEXT, source_correlation TEXT
      );
      CREATE TABLE IF NOT EXISTS technical_admin_alerts (
        alert_id INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, event TEXT NOT NULL,
        environment TEXT NOT NULL, generation INTEGER NOT NULL, source_correlation TEXT
      );
    `);
    this.addColumnIfMissing("technical_admin_challenges", "session_id", "TEXT");
    this.addColumnIfMissing("technical_admin_challenges", "fresh_purpose", "TEXT");
    this.addColumnIfMissing(
      "technical_admin_sessions",
      "csrf_token_hash",
      "TEXT NOT NULL DEFAULT ''",
    );
    this.addColumnIfMissing("technical_admin_sessions", "fresh_verified_at_ms", "INTEGER");
    this.addColumnIfMissing("technical_admin_sessions", "fresh_verified_purpose", "TEXT");
    this.database
      .query("INSERT OR IGNORE INTO technical_admin_state (id, generation) VALUES (1, 0)")
      .run();
    if (identity) {
      const existing = this.database
        .query(
          "SELECT environment, origin, rp_id FROM technical_admin_storage_identity WHERE id = 1",
        )
        .get() as { environment: string; origin: string; rp_id: string } | null;
      if (
        existing &&
        (existing.environment !== identity.environment ||
          existing.origin !== identity.origin ||
          existing.rp_id !== identity.rpId)
      ) {
        throw new Error("Technical Admin storage identity does not match the environment.");
      }
      if (!existing)
        this.database
          .query("INSERT INTO technical_admin_storage_identity VALUES (1, ?, ?, ?)")
          .run(identity.environment, identity.origin, identity.rpId);
    }
  }
  private addColumnIfMissing(table: string, column: string, definition: string) {
    const columns = this.database.query(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (!columns.some((item) => item.name === column)) {
      this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
  hasCredential() {
    return this.database.query("SELECT 1 FROM technical_admin_credentials LIMIT 1").get() !== null;
  }
  getCredential() {
    const row = this.database.query("SELECT * FROM technical_admin_credentials LIMIT 1").get() as {
      credential_id: string;
      public_key_json: string;
      sign_count: number;
      created_at_ms: number;
    } | null;
    return row
      ? {
          credentialId: row.credential_id,
          publicKey: JSON.parse(row.public_key_json) as JsonWebKey,
          signCount: row.sign_count,
          createdAtMs: row.created_at_ms,
        }
      : null;
  }
  issueEnrollment(tokenHash: string, expiresAtMs: number) {
    this.database.exec(
      "DELETE FROM technical_admin_enrollment; DELETE FROM technical_admin_challenges WHERE expires_at_ms <= strftime('%s','now') * 1000;",
    );
    this.database
      .query("INSERT INTO technical_admin_enrollment (token_hash, expires_at_ms) VALUES (?, ?)")
      .run(tokenHash, expiresAtMs);
  }
  consumeEnrollment(tokenHash: string, nowMs: number) {
    const result = this.database
      .query(
        "UPDATE technical_admin_enrollment SET used_at_ms = ? WHERE token_hash = ? AND used_at_ms IS NULL AND expires_at_ms > ?",
      )
      .run(nowMs, tokenHash, nowMs);
    return result.changes === 1;
  }
  createChallenge(challenge: ChallengeRecord) {
    this.database
      .query(
        "INSERT INTO technical_admin_challenges (challenge_id, challenge, purpose, session_id, fresh_purpose, expires_at_ms, used_at_ms) VALUES (?, ?, ?, ?, ?, ?, NULL)",
      )
      .run(
        challenge.id,
        challenge.value,
        challenge.purpose,
        challenge.sessionId,
        challenge.freshPurpose,
        challenge.expiresAtMs,
      );
  }
  consumeChallenge(
    id: string,
    purpose: ChallengeRecord["purpose"],
    nowMs: number,
    sessionId?: string,
  ) {
    const row = this.database
      .query(
        "SELECT challenge FROM technical_admin_challenges WHERE challenge_id = ? AND purpose = ? AND (? IS NULL OR session_id = ?) AND used_at_ms IS NULL AND expires_at_ms > ?",
      )
      .get(id, purpose, sessionId ?? null, sessionId ?? null, nowMs) as {
      challenge: string;
    } | null;
    if (!row) return null;
    const result = this.database
      .query(
        "UPDATE technical_admin_challenges SET used_at_ms = ? WHERE challenge_id = ? AND (? IS NULL OR session_id = ?) AND used_at_ms IS NULL AND expires_at_ms > ?",
      )
      .run(nowMs, id, sessionId ?? null, sessionId ?? null, nowMs);
    return result.changes === 1 ? row.challenge : null;
  }
  commitEnrollment(challengeId: string, credential: CredentialRecord) {
    try {
      return this.database.transaction(() => {
        if (this.hasCredential()) return false;
        const challenge = this.database
          .query(
            "SELECT 1 FROM technical_admin_challenges WHERE challenge_id = ? AND used_at_ms IS NOT NULL",
          )
          .get(challengeId);
        if (!challenge) return false;
        this.database
          .query("INSERT INTO technical_admin_credentials VALUES (?, ?, ?, ?)")
          .run(
            credential.credentialId,
            JSON.stringify(credential.publicKey),
            credential.signCount,
            credential.createdAtMs,
          );
        return true;
      })();
    } catch {
      return false;
    }
  }
  commitFreshVerification(challengeId: string, signCount: number, nowMs: number) {
    try {
      return this.database.transaction(() => {
        const challenge = this.database
          .query(
            "SELECT session_id, fresh_purpose FROM technical_admin_challenges WHERE challenge_id = ? AND purpose = 'fresh-verification' AND used_at_ms IS NOT NULL",
          )
          .get(challengeId) as {
          session_id: string | null;
          fresh_purpose: FreshVerificationPurpose | null;
        } | null;
        if (challenge?.session_id === null || challenge?.fresh_purpose === null || !challenge) {
          return false;
        }
        const credential = this.database
          .query("SELECT sign_count FROM technical_admin_credentials LIMIT 1")
          .get() as { sign_count: number } | null;
        if (!credential || (signCount !== 0 && signCount <= credential.sign_count)) return false;
        const credentialUpdate = this.database
          .query("UPDATE technical_admin_credentials SET sign_count = ?")
          .run(signCount === 0 ? credential.sign_count : signCount);
        if (credentialUpdate.changes !== 1) throw new Error("Credential counter update failed.");
        const sessionUpdate = this.database
          .query(
            "UPDATE technical_admin_sessions SET fresh_verified_at_ms = ?, fresh_verified_purpose = ? WHERE session_id = ? AND revoked_at_ms IS NULL",
          )
          .run(nowMs, challenge.fresh_purpose, challenge.session_id);
        if (sessionUpdate.changes !== 1) throw new Error("Fresh authority update failed.");
        return true;
      })();
    } catch {
      return false;
    }
  }
  commitReplacement(
    challengeId: string,
    credentialId: string,
    credential: CredentialRecord,
    session: SessionRecord,
  ) {
    try {
      return this.database.transaction(() => {
        const challenge = this.database
          .query(
            "SELECT session_id FROM technical_admin_challenges WHERE challenge_id = ? AND purpose = 'replacement' AND used_at_ms IS NOT NULL",
          )
          .get(challengeId) as { session_id: string | null } | null;
        if (challenge?.session_id === null || challenge === null) return false;
        const current = this.database
          .query(
            "SELECT 1 FROM technical_admin_sessions WHERE session_id = ? AND revoked_at_ms IS NULL",
          )
          .get(challenge.session_id);
        if (!current) return false;
        const credentialUpdate = this.database
          .query(
            "UPDATE technical_admin_credentials SET credential_id = ?, public_key_json = ?, sign_count = ?, created_at_ms = ? WHERE credential_id = ?",
          )
          .run(
            credential.credentialId,
            JSON.stringify(credential.publicKey),
            credential.signCount,
            credential.createdAtMs,
            credentialId,
          );
        if (credentialUpdate.changes !== 1) return false;
        this.database
          .query(
            "UPDATE technical_admin_sessions SET revoked_at_ms = ? WHERE revoked_at_ms IS NULL",
          )
          .run(session.createdAtMs);
        this.database
          .query(
            "INSERT INTO technical_admin_sessions (session_id, token_hash, created_at_ms, last_seen_at_ms, absolute_expires_at_ms, revoked_at_ms, csrf_token_hash, fresh_verified_at_ms, fresh_verified_purpose) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL)",
          )
          .run(
            session.id,
            session.tokenHash,
            session.createdAtMs,
            session.lastSeenAtMs,
            session.absoluteExpiresAtMs,
            session.csrfTokenHash,
          );
        this.database
          .query("UPDATE technical_admin_state SET generation = generation + 1 WHERE id = 1")
          .run();
        return true;
      })();
    } catch {
      return false;
    }
  }
  commitAuthentication(
    challengeId: string,
    credentialId: string,
    signCount: number,
    session: SessionRecord,
  ) {
    try {
      return this.database.transaction(() => {
        const challenge = this.database
          .query(
            "SELECT 1 FROM technical_admin_challenges WHERE challenge_id = ? AND used_at_ms IS NOT NULL",
          )
          .get(challengeId);
        if (!challenge) return false;
        const update = this.database
          .query("UPDATE technical_admin_credentials SET sign_count = ? WHERE credential_id = ?")
          .run(signCount, credentialId);
        if (update.changes !== 1) return false;
        this.database
          .query(
            "INSERT INTO technical_admin_sessions (session_id, token_hash, created_at_ms, last_seen_at_ms, absolute_expires_at_ms, revoked_at_ms, csrf_token_hash, fresh_verified_at_ms, fresh_verified_purpose) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL)",
          )
          .run(
            session.id,
            session.tokenHash,
            session.createdAtMs,
            session.lastSeenAtMs,
            session.absoluteExpiresAtMs,
            session.csrfTokenHash,
          );
        return true;
      })();
    } catch {
      return false;
    }
  }
  getSession(tokenHash: string) {
    const row = this.database
      .query("SELECT * FROM technical_admin_sessions WHERE token_hash = ?")
      .get(tokenHash) as Record<string, number | string | null> | null;
    return row
      ? {
          id: String(row.session_id),
          tokenHash: String(row.token_hash),
          createdAtMs: Number(row.created_at_ms),
          lastSeenAtMs: Number(row.last_seen_at_ms),
          absoluteExpiresAtMs: Number(row.absolute_expires_at_ms),
          revokedAtMs: row.revoked_at_ms === null ? null : Number(row.revoked_at_ms),
          csrfTokenHash: String(row.csrf_token_hash ?? ""),
          freshVerifiedAtMs:
            row.fresh_verified_at_ms === null ? null : Number(row.fresh_verified_at_ms),
          freshVerifiedPurpose:
            row.fresh_verified_purpose === null
              ? null
              : (String(row.fresh_verified_purpose) as FreshVerificationPurpose),
        }
      : null;
  }
  touchSession(id: string, nowMs: number) {
    this.database
      .query("UPDATE technical_admin_sessions SET last_seen_at_ms = ? WHERE session_id = ?")
      .run(nowMs, id);
  }
  revokeSession(id: string, nowMs: number) {
    this.database
      .query("UPDATE technical_admin_sessions SET revoked_at_ms = ? WHERE session_id = ?")
      .run(nowMs, id);
  }
  revokeOtherSessions(id: string, nowMs: number) {
    return this.database
      .query(
        "UPDATE technical_admin_sessions SET revoked_at_ms = ? WHERE session_id <> ? AND revoked_at_ms IS NULL",
      )
      .run(nowMs, id).changes;
  }
  activeSessionCount(nowMs: number) {
    return Number(
      (
        this.database
          .query(
            "SELECT COUNT(*) AS count FROM technical_admin_sessions WHERE revoked_at_ms IS NULL AND absolute_expires_at_ms > ? AND last_seen_at_ms > ?",
          )
          .get(nowMs, nowMs - SESSION_IDLE_TTL_MS) as { count: number }
      ).count,
    );
  }
  getGeneration() {
    return Number(
      (
        this.database.query("SELECT generation FROM technical_admin_state WHERE id = 1").get() as {
          generation: number;
        }
      ).generation,
    );
  }
  resetAuthority(nowMs: number, resetLog: TechnicalAdminOperationalLog) {
    try {
      return this.database.transaction(() => {
        const credentialCount = Number(
          (
            this.database
              .query("SELECT COUNT(*) AS count FROM technical_admin_credentials")
              .get() as {
              count: number;
            }
          ).count,
        );
        if (credentialCount > 1 || (credentialCount === 1 && this.getCredential() === null)) {
          return false;
        }
        this.database.exec(
          "DELETE FROM technical_admin_credentials; DELETE FROM technical_admin_enrollment; DELETE FROM technical_admin_challenges;",
        );
        this.database
          .query(
            "UPDATE technical_admin_sessions SET revoked_at_ms = ? WHERE revoked_at_ms IS NULL",
          )
          .run(nowMs);
        this.database
          .query("UPDATE technical_admin_state SET generation = generation + 1 WHERE id = 1")
          .run();
        this.database
          .query("DELETE FROM technical_admin_operational_logs WHERE at_ms <= ?")
          .run(resetLog.atMs - LOG_RETENTION_MS);
        this.database
          .query(
            "INSERT INTO technical_admin_operational_logs (at_ms, event, outcome, environment, generation, session_reference, source_correlation) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            resetLog.atMs,
            resetLog.event,
            resetLog.outcome,
            resetLog.environment,
            resetLog.generation,
            resetLog.sessionReference,
            resetLog.sourceCorrelation,
          );
        return true;
      })();
    } catch {
      return false;
    }
  }
  getStorageStatus(nowMs: number): TechnicalAdminStorageStatus {
    try {
      const quickCheck = this.database.query("PRAGMA quick_check").get() as { quick_check: string };
      if (quickCheck.quick_check !== "ok") {
        return {
          state: "corrupt",
          credentialPresent: false,
          activeSessionCount: 0,
          generation: 0,
        };
      }
      this.maintain(nowMs);
      const credentialCount = Number(
        (
          this.database
            .query("SELECT COUNT(*) AS count FROM technical_admin_credentials")
            .get() as {
            count: number;
          }
        ).count,
      );
      if (credentialCount > 1) {
        return {
          state: "corrupt",
          credentialPresent: true,
          activeSessionCount: 0,
          generation: 0,
        };
      }
      const credentialPresent = credentialCount === 1;
      if (credentialPresent && this.getCredential() === null) {
        return {
          state: "corrupt",
          credentialPresent: true,
          activeSessionCount: 0,
          generation: 0,
        };
      }
      return {
        state: "ready",
        credentialPresent,
        activeSessionCount: this.activeSessionCount(nowMs),
        generation: this.getGeneration(),
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message.toLowerCase() : "";
      return {
        state:
          detail.includes("readonly") || detail.includes("read-only") ? "read-only" : "unavailable",
        credentialPresent: false,
        activeSessionCount: 0,
        generation: 0,
      };
    }
  }
  appendOperationalLog(log: TechnicalAdminOperationalLog) {
    this.database.transaction(() => {
      this.database
        .query("DELETE FROM technical_admin_operational_logs WHERE at_ms <= ?")
        .run(log.atMs - LOG_RETENTION_MS);
      this.database
        .query(
          "INSERT INTO technical_admin_operational_logs (at_ms, event, outcome, environment, generation, session_reference, source_correlation) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          log.atMs,
          log.event,
          log.outcome,
          log.environment,
          log.generation,
          log.sessionReference,
          log.sourceCorrelation,
        );
    })();
  }
  appendAlert(alert: TechnicalAdminAlert) {
    this.database.transaction(() => {
      this.database
        .query("DELETE FROM technical_admin_alerts WHERE at_ms <= ?")
        .run(alert.atMs - LOG_RETENTION_MS);
      this.database
        .query(
          "INSERT INTO technical_admin_alerts (at_ms, event, environment, generation, source_correlation) VALUES (?, ?, ?, ?, ?)",
        )
        .run(alert.atMs, alert.event, alert.environment, alert.generation, alert.sourceCorrelation);
    })();
  }
  nextTelemetryExpiry() {
    const row = this.database
      .query(
        "SELECT MIN(expiry_ms) AS expiry_ms FROM (SELECT at_ms + ? AS expiry_ms FROM technical_admin_operational_logs UNION ALL SELECT at_ms + ? AS expiry_ms FROM technical_admin_alerts)",
      )
      .get(LOG_RETENTION_MS, LOG_RETENTION_MS) as { expiry_ms: number | null };
    return row.expiry_ms === null ? null : Number(row.expiry_ms);
  }
  maintain(nowMs: number) {
    this.database.transaction(() => {
      this.database
        .query("DELETE FROM technical_admin_operational_logs WHERE at_ms <= ?")
        .run(nowMs - LOG_RETENTION_MS);
      this.database
        .query("DELETE FROM technical_admin_alerts WHERE at_ms <= ?")
        .run(nowMs - LOG_RETENTION_MS);
    })();
  }
  close() {
    this.database.close();
  }
}

function consumeChallenge(
  repository: TechnicalAdminAuthRepository,
  id: string,
  purpose: ChallengeRecord["purpose"],
  nowMs: number,
  sessionId?: string,
) {
  return repository.consumeChallenge(id, purpose, nowMs, sessionId);
}

function createChallenge(
  purpose: ChallengeRecord["purpose"],
  nowMs: number,
  sessionId: string | null = null,
  freshPurpose: FreshVerificationPurpose | null = null,
): ChallengeRecord {
  return {
    id: crypto.randomUUID(),
    value: randomToken(),
    purpose,
    sessionId,
    freshPurpose,
    expiresAtMs: nowMs + CHALLENGE_TTL_MS,
    usedAtMs: null,
  };
}

function isExactBinding(binding: CeremonyBinding, origin: string, host: string) {
  return binding.origin === origin && binding.host === host;
}

function randomToken() {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}
function hashToken(token: string) {
  return bytesToHex(new Uint8Array(new Bun.CryptoHasher("sha256").update(token).digest()));
}

function parseCredentialResponse(
  value: unknown,
  kind: "registration",
): {
  id: string;
  clientDataJSON: Uint8Array;
  attestationObject: Uint8Array;
};
function parseCredentialResponse(
  value: unknown,
  kind: "authentication",
): {
  id: string;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  signature: Uint8Array;
};
function parseCredentialResponse(
  value: unknown,
  kind: "registration" | "authentication",
):
  | { id: string; clientDataJSON: Uint8Array; attestationObject: Uint8Array }
  | {
      id: string;
      clientDataJSON: Uint8Array;
      authenticatorData: Uint8Array;
      signature: Uint8Array;
    } {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.response))
    throw new Error("Invalid credential response.");
  const response = value.response;
  const parsed = {
    id: value.id,
    clientDataJSON: base64UrlDecode(requiredString(response.clientDataJSON)),
  };
  if (kind === "registration") {
    return {
      ...parsed,
      attestationObject: base64UrlDecode(
        requiredString(response.attestationObject, "attestationObject"),
      ),
    };
  }
  return {
    ...parsed,
    authenticatorData: base64UrlDecode(
      requiredString(response.authenticatorData, "authenticatorData"),
    ),
    signature: base64UrlDecode(requiredString(response.signature, "signature")),
  };
}

function parseClientData(
  bytes: Uint8Array,
  type: string,
  expectation: WebAuthnRegistrationExpectation,
) {
  const data = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  if (
    data.type !== type ||
    data.origin !== expectation.origin ||
    data.challenge !== expectation.challenge
  )
    throw new Error("Invalid client data.");
  return data;
}

function parseAuthenticatorData(bytes: Uint8Array, registration: boolean, rpId: string) {
  if (bytes.length < 37) throw new Error("Invalid authenticator data.");
  const expectedRpIdHash = new Uint8Array(new Bun.CryptoHasher("sha256").update(rpId).digest());
  if (!bytesEqual(bytes.slice(0, 32), expectedRpIdHash)) throw new Error("Invalid RP ID.");
  const flags = bytes[32] ?? 0;
  if ((flags & 0x01) === 0) throw new Error("User presence required.");
  if ((flags & 0x04) === 0) throw new Error("User verification required.");
  const signCount = new DataView(bytes.buffer, bytes.byteOffset + 33, 4).getUint32(0);
  if (!registration) return { signCount, userVerification: true, userPresent: true };
  if ((flags & 0x40) === 0 || bytes.length < 55)
    throw new Error("Missing attested credential data.");
  let offset = 37 + 16;
  const credentialLength = new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0);
  offset += 2;
  const credentialId = bytes.slice(offset, offset + credentialLength);
  offset += credentialLength;
  const key = decodeCbor(bytes.slice(offset));
  return {
    signCount,
    userVerification: true,
    userPresent: true,
    credentialId,
    publicKey: coseKeyToJwk(key),
  };
}

async function verifyWebAuthnSignature(
  publicKey: JsonWebKey,
  signature: Uint8Array,
  data: Uint8Array,
) {
  const algorithm =
    publicKey.kty === "EC" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "Ed25519" };
  const key = await crypto.subtle.importKey("jwk", publicKey, algorithm, false, ["verify"]);
  const normalizedSignature = publicKey.kty === "EC" ? derToP1363(signature) : signature;
  return crypto.subtle.verify(
    publicKey.kty === "EC" ? { name: "ECDSA", hash: "SHA-256" } : { name: "Ed25519" },
    key,
    normalizedSignature as BufferSource,
    data as BufferSource,
  );
}

function coseKeyToJwk(value: unknown): JsonWebKey {
  if (!(value instanceof Map)) throw new Error("Invalid COSE key.");
  const kty = Number(value.get(1));
  if (kty === 2)
    return {
      kty: "EC",
      crv: "P-256",
      x: base64UrlEncode(bytesFrom(value.get(-2))),
      y: base64UrlEncode(bytesFrom(value.get(-3))),
      alg: "ES256",
      ext: true,
    };
  if (kty === 1)
    return {
      kty: "OKP",
      crv: "Ed25519",
      x: base64UrlEncode(bytesFrom(value.get(-2))),
      alg: "EdDSA",
      ext: true,
    };
  if (kty === 3)
    return {
      kty: "RSA",
      n: base64UrlEncode(bytesFrom(value.get(-1))),
      e: base64UrlEncode(bytesFrom(value.get(-2))),
      alg: "RS256",
      ext: true,
    };
  throw new Error("Unsupported COSE key.");
}

function derToP1363(signature: Uint8Array) {
  if (signature[0] !== 0x30) return signature;
  let offset = 2;
  if (signature[offset] !== 0x02) throw new Error("Invalid ECDSA signature.");
  const rLength = signature[offset + 1] ?? 0;
  const r = signature.slice(offset + 2, offset + 2 + rLength);
  offset += 2 + rLength;
  if (signature[offset] !== 0x02) throw new Error("Invalid ECDSA signature.");
  const sLength = signature[offset + 1] ?? 0;
  const s = signature.slice(offset + 2, offset + 2 + sLength);
  return concatBytes(leftPad32(trimLeadingZeroes(r)), leftPad32(trimLeadingZeroes(s)));
}

function trimLeadingZeroes(bytes: Uint8Array) {
  return bytes.slice(
    Math.max(
      0,
      bytes.findIndex((byte) => byte !== 0),
    ),
  );
}
function leftPad32(bytes: Uint8Array) {
  const result = new Uint8Array(32);
  result.set(bytes.slice(-32), 32 - Math.min(32, bytes.length));
  return result;
}
function concatBytes(...values: Uint8Array[]) {
  const result = new Uint8Array(values.reduce((sum, value) => sum + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}
function bytesEqual(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function constantTimeEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index++) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}
function bytesFrom(value: unknown) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("Expected bytes.");
}
function requiredString(value: unknown, name = "clientDataJSON") {
  if (typeof value !== "string") throw new Error(`Missing ${name}.`);
  return value;
}
function base64UrlEncode(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url");
}
function base64UrlDecode(value: string) {
  return new Uint8Array(Buffer.from(value, "base64url"));
}
function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeCbor(bytes: Uint8Array): unknown {
  let offset = 0;
  const read = (): unknown => {
    const initial = bytes[offset++];
    if (initial === undefined) throw new Error("Invalid CBOR.");
    const major = initial >> 5;
    const additional = initial & 0x1f;
    const length = readLength(additional);
    if (major === 0) return length;
    if (major === 1) return -1 - length;
    if (major === 2) {
      const result = bytes.slice(offset, offset + length);
      offset += length;
      return result;
    }
    if (major === 3) {
      const result = new TextDecoder().decode(bytes.slice(offset, offset + length));
      offset += length;
      return result;
    }
    if (major === 4) return Array.from({ length }, () => read());
    if (major === 5) {
      const map = new Map<unknown, unknown>();
      for (let index = 0; index < length; index++) map.set(read(), read());
      return map;
    }
    throw new Error("Unsupported CBOR value.");
  };
  const readLength = (additional: number): number => {
    if (additional < 24) return additional;
    const width = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : 0;
    if (width === 0 || offset + width > bytes.length) throw new Error("Invalid CBOR length.");
    let value = 0;
    for (let index = 0; index < width; index++) value = value * 256 + (bytes[offset++] ?? 0);
    return value;
  };
  return read();
}

export function createSqliteTechnicalAdminAuthRepository(
  databasePath: string,
  identity?: TechnicalAdminStorageIdentity,
  options?: SqliteTechnicalAdminAuthRepositoryOptions,
) {
  return new SqliteTechnicalAdminAuthRepository(databasePath, identity, options);
}
export function technicalAdminCookie(token: string) {
  return `__Host-technical-admin=${token}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}
export function clearTechnicalAdminCookie() {
  return "__Host-technical-admin=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0";
}
export function technicalAdminCsrfCookie(token: string) {
  return `__Host-technical-admin-csrf=${token}; Path=/; Secure; SameSite=Strict`;
}
export function clearTechnicalAdminCsrfCookie() {
  return "__Host-technical-admin-csrf=; Path=/; Secure; SameSite=Strict; Max-Age=0";
}
export function technicalAdminSessionTtls() {
  return {
    idleMs: SESSION_IDLE_TTL_MS,
    absoluteMs: SESSION_ABSOLUTE_TTL_MS,
    freshVerificationMs: FRESH_VERIFICATION_TTL_MS,
    logRetentionMs: LOG_RETENTION_MS,
    retentionRecoveryRetryMs: RETENTION_RECOVERY_RETRY_MS,
  };
}
