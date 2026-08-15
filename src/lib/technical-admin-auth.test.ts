import { describe, expect, test } from "bun:test";
import {
  MemoryTechnicalAdminAuthRepository,
  NativeWebAuthnVerifier,
  createTechnicalAdminRetentionScheduler,
  createTechnicalAdminAuth,
  type TechnicalAdminAuthRepository,
  type TechnicalAdminRetentionTimerSource,
  technicalAdminCookie,
  technicalAdminSessionTtls,
  type TechnicalAdminRetentionScheduler,
  type WebAuthnVerifier,
} from "@/lib/technical-admin-auth";

const binding = { origin: "https://timer.example", host: "timer.example" };
const validEd25519PublicKey: JsonWebKey = {
  kty: "OKP",
  crv: "Ed25519",
  x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  alg: "EdDSA",
  ext: true,
};
const validP256PublicKey: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  x: "axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY",
  y: "T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU",
  alg: "ES256",
  ext: true,
};

function createFixture() {
  let nowMs = 1_000;
  let registrationCredentialId = "credential-1";
  let authenticationSignCount = 2;
  const repository = new MemoryTechnicalAdminAuthRepository({
    environment: "production",
    origin: binding.origin,
    rpId: "timer.example",
  });
  const verifier: WebAuthnVerifier = {
    async verifyRegistration() {
      return {
        credentialId: registrationCredentialId,
        publicKey: { ...validEd25519PublicKey },
        signCount: 1,
      };
    },
    async verifyAuthentication() {
      return { signCount: authenticationSignCount++ };
    },
  };
  const auth = createTechnicalAdminAuth(
    { environment: "production", origin: binding.origin, rpId: "timer.example" },
    repository,
    verifier,
    () => nowMs,
  );
  return {
    auth,
    repository,
    verifier,
    setRegistrationCredentialId: (value: string) => (registrationCredentialId = value),
    advance: (amount: number) => (nowMs += amount),
    now: () => nowMs,
  };
}

function createManualRetentionScheduler(now: () => number) {
  let nextId = 0;
  let scheduleFailures = 0;
  let unrefCount = 0;
  const timers = new Map<number, { atMs: number; callback: () => void }>();
  const scheduler: TechnicalAdminRetentionScheduler = {
    schedule(callback, deadlineMs) {
      if (scheduleFailures > 0) {
        scheduleFailures -= 1;
        throw new Error("injected scheduler failure");
      }
      const id = ++nextId;
      timers.set(id, { atMs: deadlineMs, callback });
      return id;
    },
    cancel(timer) {
      timers.delete(timer as number);
    },
    unref() {
      unrefCount += 1;
    },
  };
  return {
    scheduler,
    failNextSchedule: () => (scheduleFailures += 1),
    pendingCount: () => timers.size,
    unrefCount: () => unrefCount,
    pendingDelays: () =>
      [...timers.values()].map((timer) => timer.atMs - now()).sort((a, b) => a - b),
    runDue: () => {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.atMs <= now())
        .sort(([, left], [, right]) => left.atMs - right.atMs);
      for (const [id, timer] of due) {
        if (!timers.delete(id)) continue;
        timer.callback();
      }
    },
  };
}

function createManualTimerSource() {
  let nextId = 0;
  let scheduleFailures = 0;
  let unrefCount = 0;
  const records = new Map<number, { callback: () => void; delayMs: number }>();
  const source: TechnicalAdminRetentionTimerSource = {
    schedule(callback, delayMs) {
      if (scheduleFailures > 0) {
        scheduleFailures -= 1;
        throw new Error("injected timer-source failure");
      }
      const id = ++nextId;
      records.set(id, { callback, delayMs });
      return id;
    },
    cancel(timer) {
      records.delete(timer as number);
    },
    unref() {
      unrefCount += 1;
    },
  };
  return {
    source,
    failNextSchedule: () => (scheduleFailures += 1),
    firstDelay: () => [...records.values()][0]?.delayMs,
    firstCallback: () => [...records.values()][0]?.callback,
    pendingCount: () => records.size,
    unrefCount: () => unrefCount,
    fireFirst: () => {
      const entry = [...records.entries()][0];
      if (entry === undefined) return;
      records.delete(entry[0]);
      entry[1].callback();
    },
  };
}

async function flushRetentionMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Technical Admin authentication", () => {
  test("issues a bounded enrollment URL and consumes its authorization once", async () => {
    const fixture = createFixture();
    const issued = fixture.auth.issueEnrollmentAuthorization();
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.value.url).toMatch(/^https:\/\/timer\.example\/admin\/enroll#token=[^&]+$/u);
    const token = decodeURIComponent(issued.value.url.split("token=")[1] ?? "");

    expect(
      fixture.auth.beginEnrollment(token, { ...binding, origin: "https://other.example" }).ok,
    ).toBe(false);
    const options = fixture.auth.beginEnrollment(token, binding);
    expect(options).toMatchObject({
      ok: true,
      value: {
        rp: { id: "timer.example" },
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      },
    });
    expect(fixture.auth.beginEnrollment(token, binding)).toEqual({
      ok: false,
      error: "invalid-enrollment",
    });

    if (!options.ok) return;
    expect(await fixture.auth.completeEnrollment(options.value.challengeId, {}, binding)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(fixture.repository.getCredential()?.credentialId).toBe("credential-1");
    expect(fixture.auth.issueEnrollmentAuthorization()).toEqual({
      ok: false,
      error: "not-enrollable",
    });
  });

  test("requires the exact host and origin for authentication ceremonies", async () => {
    const fixture = createFixture();
    const issued = fixture.auth.issueEnrollmentAuthorization();
    if (!issued.ok) throw new Error("Expected enrollment authorization.");
    const token = decodeURIComponent(issued.value.url.split("token=")[1] ?? "");
    const enrollment = fixture.auth.beginEnrollment(token, binding);
    if (!enrollment.ok) throw new Error("Expected enrollment options.");
    expect(await fixture.auth.beginAuthentication(binding)).toEqual({
      ok: false,
      error: "invalid-credentials",
    });
    const wrongBindingResult = await fixture.auth.completeEnrollment(
      enrollment.value.challengeId,
      {},
      { ...binding, host: "evil.example" },
    );
    expect(wrongBindingResult).toEqual({ ok: false, error: "invalid-ceremony" });
  });

  test("creates a rotated nonpersistent session and enforces idle and absolute expiry", async () => {
    const fixture = createFixture();
    const issued = fixture.auth.issueEnrollmentAuthorization();
    if (!issued.ok) throw new Error("Expected enrollment authorization.");
    const token = decodeURIComponent(issued.value.url.split("token=")[1] ?? "");
    const enrollment = fixture.auth.beginEnrollment(token, binding);
    if (!enrollment.ok) throw new Error("Expected enrollment options.");
    await fixture.auth.completeEnrollment(enrollment.value.challengeId, {}, binding);

    const authentication = await fixture.auth.beginAuthentication(binding);
    if (!authentication.ok) throw new Error("Expected authentication options.");
    const session = await fixture.auth.completeAuthentication(
      authentication.value.challengeId,
      {},
      binding,
    );
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    expect(technicalAdminCookie(session.value.token)).toContain("__Host-technical-admin=");
    expect(technicalAdminCookie(session.value.token)).toContain(
      "Secure; HttpOnly; SameSite=Strict",
    );
    expect(fixture.auth.authenticateSession(session.value.token)).toBe(true);
    expect(fixture.auth.verifyCsrf(session.value.token, session.value.csrfToken)).toBe(true);
    expect(fixture.auth.verifyCsrf(session.value.token, "wrong-csrf")).toBe(false);

    fixture.advance(technicalAdminSessionTtls().idleMs);
    expect(fixture.auth.authenticateSession(session.value.token)).toBe(false);
  });

  test("rejects authentication replay and enforces the absolute deadline despite activity", async () => {
    const fixture = createFixture();
    await enroll(fixture);
    const options = await fixture.auth.beginAuthentication(binding);
    if (!options.ok) throw new Error("Expected authentication options.");
    const first = await fixture.auth.completeAuthentication(options.value.challengeId, {}, binding);
    expect(first.ok).toBe(true);
    expect(
      await fixture.auth.completeAuthentication(options.value.challengeId, {}, binding),
    ).toEqual({
      ok: false,
      error: "invalid-ceremony",
    });
    if (!first.ok) return;
    const hour = 60 * 60 * 1_000;
    for (let elapsed = 0; elapsed < 11 * hour; elapsed += hour) {
      fixture.advance(hour);
      expect(fixture.auth.authenticateSession(first.value.token)).toBe(true);
    }
    fixture.advance(hour - 1_000);
    expect(fixture.auth.authenticateSession(first.value.token)).toBe(true);
    fixture.advance(1_000);
    expect(fixture.auth.authenticateSession(first.value.token)).toBe(false);
  });

  test("requires fresh verified authority for session revocation and resolves only live authority", async () => {
    const fixture = createFixture();
    await enroll(fixture);
    const first = await authenticate(fixture);
    const second = await authenticate(fixture);
    expect(fixture.auth.activeSessionCount()).toBe(2);
    expect(fixture.auth.revokeOtherSessions(first.token)).toEqual({
      ok: false,
      error: "not-fresh",
    });
    const stepUp = fixture.auth.beginFreshVerification(
      first.token,
      "revoke-other-sessions",
      binding,
    );
    if (!stepUp.ok) throw new Error("Expected fresh-verification options.");
    expect(
      await fixture.auth.completeFreshVerification(
        first.token,
        stepUp.value.challengeId,
        {},
        binding,
      ),
    ).toEqual({
      ok: true,
      value: undefined,
    });
    expect(fixture.auth.revokeOtherSessions(first.token)).toEqual({
      ok: true,
      value: { revokedCount: 1 },
    });
    expect(fixture.auth.authenticateSession(second.token)).toBe(false);
    expect(fixture.auth.resolveCurrentAuthority(first.token)).toMatchObject({
      kind: "technical-admin",
      environment: "production",
    });
    expect(fixture.auth.resolveCurrentAuthority(second.token)).toBeNull();
    expect(
      fixture.auth.resolveCurrentAuthority(
        JSON.stringify({ kind: "technical-admin", environment: "production" }),
      ),
    ).toBeNull();
    expect(fixture.repository.getCredential()?.signCount).toBe(4);
  });

  test("binds fresh verification to its privileged purpose", async () => {
    const revokeFixture = createFixture();
    await enroll(revokeFixture);
    const revokeSession = await authenticate(revokeFixture);
    const revokeStepUp = revokeFixture.auth.beginFreshVerification(
      revokeSession.token,
      "revoke-other-sessions",
      binding,
    );
    if (!revokeStepUp.ok) throw new Error("Expected revoke step-up options.");
    expect(
      await revokeFixture.auth.completeFreshVerification(
        revokeSession.token,
        revokeStepUp.value.challengeId,
        {},
        binding,
      ),
    ).toEqual({ ok: true, value: undefined });
    expect(revokeFixture.auth.beginReplacement(revokeSession.token, binding)).toEqual({
      ok: false,
      error: "not-fresh",
    });

    const replaceFixture = createFixture();
    await enroll(replaceFixture);
    const replaceSession = await authenticate(replaceFixture);
    const replaceStepUp = replaceFixture.auth.beginFreshVerification(
      replaceSession.token,
      "replace-credential",
      binding,
    );
    if (!replaceStepUp.ok) throw new Error("Expected replacement step-up options.");
    expect(
      await replaceFixture.auth.completeFreshVerification(
        replaceSession.token,
        replaceStepUp.value.challengeId,
        {},
        binding,
      ),
    ).toEqual({ ok: true, value: undefined });
    expect(replaceFixture.auth.revokeOtherSessions(replaceSession.token)).toEqual({
      ok: false,
      error: "not-fresh",
    });
  });

  test("replaces the credential and all sessions atomically after fresh verification", async () => {
    const fixture = createFixture();
    await enroll(fixture);
    const oldSession = await authenticate(fixture);
    const otherSession = await authenticate(fixture);
    const stepUp = fixture.auth.beginFreshVerification(
      oldSession.token,
      "replace-credential",
      binding,
    );
    if (!stepUp.ok) throw new Error("Expected fresh-verification options.");
    await fixture.auth.completeFreshVerification(
      oldSession.token,
      stepUp.value.challengeId,
      {},
      binding,
    );
    fixture.setRegistrationCredentialId("credential-2");
    const replacement = fixture.auth.beginReplacement(oldSession.token, binding);
    if (!replacement.ok) throw new Error("Expected replacement options.");
    const replaced = await fixture.auth.completeReplacement(
      oldSession.token,
      replacement.value.challengeId,
      {},
      binding,
    );
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(fixture.auth.authenticateSession(oldSession.token)).toBe(false);
    expect(fixture.auth.authenticateSession(otherSession.token)).toBe(false);
    expect(fixture.auth.authenticateSession(replaced.value.token)).toBe(true);
    expect(fixture.repository.getCredential()?.credentialId).toBe("credential-2");
    expect(fixture.auth.activeSessionCount()).toBe(1);
  });

  test("resets authority before issuing enrollment and keeps redacted logs bounded", async () => {
    const fixture = createFixture();
    await enroll(fixture);
    const session = await authenticate(fixture);
    const oldToken = session.token;
    const reset = fixture.auth.emergencyReset();
    expect(reset.ok).toBe(true);
    if (!reset.ok) return;
    expect(reset.value.url).toContain("#token=");
    expect(fixture.auth.authenticateSession(oldToken)).toBe(false);
    expect(fixture.auth.storageStatus()).toMatchObject({
      state: "ready",
      credentialPresent: false,
      activeSessionCount: 0,
    });
    expect(JSON.stringify(fixture.repository.logs)).not.toContain(oldToken);
    expect(fixture.repository.logs.some((log) => log.event === "emergency-reset")).toBe(true);
  });

  test("clears a source failure window after successful authentication", async () => {
    const fixture = createFixture();
    await enroll(fixture);
    for (let index = 0; index < 5; index++) {
      expect(await fixture.auth.completeAuthentication("missing", {}, binding, "source-a")).toEqual(
        { ok: false, error: "invalid-ceremony" },
      );
    }
    fixture.advance(1_000);
    const options = await fixture.auth.beginAuthentication(binding);
    if (!options.ok) throw new Error("Expected authentication options.");
    expect(
      await fixture.auth.completeAuthentication(options.value.challengeId, {}, binding, "source-a"),
    ).toMatchObject({ ok: true });
    expect(await fixture.auth.completeAuthentication("missing", {}, binding, "source-a")).toEqual({
      ok: false,
      error: "invalid-ceremony",
    });
  });

  test("enforces the global completion ceiling and records a global alert", async () => {
    const fixture = createFixture();
    for (let index = 0; index < 60; index++) {
      expect(
        await fixture.auth.completeAuthentication("missing", {}, binding, `source-${index}`),
      ).toEqual({ ok: false, error: "invalid-ceremony" });
    }
    expect(
      await fixture.auth.completeAuthentication("missing", {}, binding, "source-global"),
    ).toMatchObject({ ok: false, error: "throttled" });
    expect(fixture.repository.alerts.some((alert) => alert.event === "global-throttle")).toBe(true);
  });

  test("expires operational logs and alerts during the storage-status maintenance boundary", async () => {
    const fixture = createFixture();
    fixture.repository.logs.push({
      atMs: 1_000,
      event: "logout",
      outcome: "accepted",
      environment: "test",
      generation: 0,
      sessionReference: null,
      sourceCorrelation: null,
    });
    fixture.repository.alerts.push({
      atMs: 1_000,
      event: "unsafe-storage",
      environment: "test",
      generation: 0,
      sourceCorrelation: null,
    });
    fixture.advance(technicalAdminSessionTtls().logRetentionMs + 1);
    expect(fixture.auth.storageStatus()).toMatchObject({ state: "ready" });
    expect(fixture.repository.logs).toEqual([]);
    expect(fixture.repository.alerts).toEqual([]);
  });

  test("schedules the first append and cancels its timer with the auth lifecycle", () => {
    const fixture = createFixture();
    const manual = createManualRetentionScheduler(fixture.now);
    fixture.auth.startRetentionMaintenance(manual.scheduler);
    expect(manual.pendingCount()).toBe(0);

    expect(fixture.auth.issueEnrollmentAuthorization().ok).toBe(true);
    expect(manual.pendingDelays()).toEqual([technicalAdminSessionTtls().logRetentionMs]);

    fixture.auth.close();
    expect(manual.pendingCount()).toBe(0);
  });

  test("prunes at the earliest expiry and schedules the next quiet-period expiry", () => {
    const fixture = createFixture();
    fixture.repository.logs.push({
      atMs: 1_000,
      event: "logout",
      outcome: "accepted",
      environment: "test",
      generation: 0,
      sessionReference: null,
      sourceCorrelation: null,
    });
    fixture.repository.alerts.push({
      atMs: 2_000,
      event: "unsafe-storage",
      environment: "test",
      generation: 0,
      sourceCorrelation: null,
    });
    const manual = createManualRetentionScheduler(fixture.now);
    fixture.auth.startRetentionMaintenance(manual.scheduler);
    const retentionMs = technicalAdminSessionTtls().logRetentionMs;
    expect(manual.pendingDelays()).toEqual([retentionMs]);

    fixture.advance(retentionMs);
    manual.runDue();
    expect(fixture.repository.logs).toEqual([]);
    expect(fixture.repository.alerts).toHaveLength(1);
    expect(manual.pendingDelays()).toEqual([1_000]);

    fixture.advance(1_000);
    manual.runDue();
    expect(fixture.repository.alerts).toEqual([]);
    expect(manual.pendingCount()).toBe(0);
    fixture.auth.close();
  });

  test("contains maintenance failure and recovers with one bounded retry", async () => {
    const fixture = createFixture();
    fixture.repository.logs.push({
      atMs: 1_000,
      event: "logout",
      outcome: "accepted",
      environment: "test",
      generation: 0,
      sessionReference: null,
      sourceCorrelation: null,
    });
    const originalMaintain = fixture.repository.maintain.bind(fixture.repository);
    let maintainCalls = 0;
    fixture.repository.maintain = (nowMs: number) => {
      maintainCalls += 1;
      if (maintainCalls === 1) throw new Error("injected maintenance failure");
      originalMaintain(nowMs);
    };
    const manual = createManualRetentionScheduler(fixture.now);
    fixture.auth.startRetentionMaintenance(manual.scheduler);
    const retentionMs = technicalAdminSessionTtls().logRetentionMs;
    const retryMs = technicalAdminSessionTtls().retentionRecoveryRetryMs;
    fixture.advance(retentionMs);
    manual.runDue();
    expect(maintainCalls).toBe(1);
    expect(manual.pendingCount()).toBe(0);

    await flushRetentionMicrotasks();
    expect(manual.pendingCount()).toBe(1);
    expect(manual.pendingDelays()).toEqual([retryMs]);
    fixture.advance(retryMs);
    manual.runDue();
    expect(maintainCalls).toBe(2);
    expect(fixture.repository.logs).toEqual([]);
    expect(manual.pendingCount()).toBe(0);
    fixture.auth.close();
  });

  test("contains next-expiry query failure and resumes exact scheduling after recovery", async () => {
    const fixture = createFixture();
    fixture.repository.logs.push({
      atMs: 1_000,
      event: "logout",
      outcome: "accepted",
      environment: "test",
      generation: 0,
      sessionReference: null,
      sourceCorrelation: null,
    });
    const originalNextExpiry = fixture.repository.nextTelemetryExpiry.bind(fixture.repository);
    let failuresRemaining = 2;
    fixture.repository.nextTelemetryExpiry = () => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error("injected expiry query failure");
      }
      return originalNextExpiry();
    };
    const manual = createManualRetentionScheduler(fixture.now);
    fixture.auth.startRetentionMaintenance(manual.scheduler);
    expect(() => fixture.auth.storageStatus()).not.toThrow();
    expect(manual.pendingCount()).toBe(0);

    await flushRetentionMicrotasks();
    const retryMs = technicalAdminSessionTtls().retentionRecoveryRetryMs;
    expect(manual.pendingDelays()).toEqual([retryMs]);
    fixture.advance(retryMs);
    manual.runDue();
    expect(manual.pendingDelays()).toEqual([technicalAdminSessionTtls().logRetentionMs - retryMs]);
    fixture.auth.close();
  });

  test("contains a scheduler-boundary failure without synchronous retry", async () => {
    const fixture = createFixture();
    fixture.repository.logs.push({
      atMs: 1_000,
      event: "logout",
      outcome: "accepted",
      environment: "test",
      generation: 0,
      sessionReference: null,
      sourceCorrelation: null,
    });
    const manual = createManualRetentionScheduler(fixture.now);
    manual.failNextSchedule();
    fixture.auth.startRetentionMaintenance(manual.scheduler);
    expect(manual.pendingCount()).toBe(0);
    await flushRetentionMicrotasks();
    expect(manual.pendingCount()).toBe(1);
    expect(manual.pendingDelays()).toEqual([technicalAdminSessionTtls().retentionRecoveryRetryMs]);
    fixture.auth.close();
  });

  test("recomputes absolute long deadlines and honors cancel/unref", () => {
    let nowMs = 0;
    const source = createManualTimerSource();
    const scheduler = createTechnicalAdminRetentionScheduler(() => nowMs, source.source);
    let fired = 0;
    const deadlineMs = 3_000_000_000;
    const handle = scheduler.schedule(() => (fired += 1), deadlineMs);
    scheduler.unref?.(handle);
    expect(source.firstDelay()).toBeGreaterThan(0);
    expect(source.firstDelay()).toBeLessThan(deadlineMs);
    expect(source.unrefCount()).toBe(1);

    nowMs = deadlineMs + 1;
    source.fireFirst();
    expect(fired).toBe(1);
    expect(source.pendingCount()).toBe(0);

    const canceledHandle = scheduler.schedule(() => (fired += 1), nowMs + 1_000);
    const canceledCallback = source.firstCallback();
    scheduler.unref?.(canceledHandle);
    scheduler.cancel(canceledHandle);
    canceledCallback?.();
    expect(fired).toBe(1);
    expect(source.pendingCount()).toBe(0);
  });

  test("reports a later long-arm failure and recovers through one bounded retry", async () => {
    const fixture = createFixture();
    fixture.repository.logs.push({
      atMs: fixture.now(),
      event: "logout",
      outcome: "accepted",
      environment: "test",
      generation: 0,
      sessionReference: null,
      sourceCorrelation: null,
    });
    const source = createManualTimerSource();
    const scheduler = createTechnicalAdminRetentionScheduler(fixture.now, source.source);
    fixture.auth.startRetentionMaintenance(scheduler);
    expect(source.pendingCount()).toBe(1);

    source.failNextSchedule();
    fixture.advance(2_147_483_647);
    source.fireFirst();
    expect(source.pendingCount()).toBe(0);

    await flushRetentionMicrotasks();
    expect(source.pendingCount()).toBe(1);
    expect(source.firstDelay()).toBe(technicalAdminSessionTtls().retentionRecoveryRetryMs);

    fixture.auth.close();
    expect(source.pendingCount()).toBe(0);
  });

  test("fails closed when reset cannot commit", async () => {
    const fixture = createFixture();
    await enroll(fixture);
    const auth = createTechnicalAdminAuth(
      { environment: "production", origin: binding.origin, rpId: "timer.example" },
      throwingRepository("resetAuthority", fixture.repository),
      fixture.verifier,
    );
    expect(auth.emergencyReset()).toEqual({ ok: false, error: "storage-failure" });
    expect(fixture.repository.credential?.credentialId).toBe("credential-1");
    expect(fixture.repository.alerts.some((alert) => alert.event === "reset-failure")).toBe(true);
  });

  test("preserves the exact credential and invalidates every transient authority", async () => {
    const fixture = createFixture();
    const artifacts = await createRestoreArtifacts(fixture);
    const credentialBefore = structuredClone(fixture.repository.getCredential());

    expect(
      await fixture.auth.prepareForFoundationRestore({ mode: "preserve-compatible-credential" }),
    ).toEqual({ outcome: "preserved-transients-invalidated" });
    expect(fixture.repository.getCredential()).toEqual(credentialBefore);
    expect(fixture.repository.enrollment).toBeNull();
    expect(fixture.repository.challenges.size).toBe(0);
    expect(fixture.auth.authenticateSession(artifacts.session.token)).toBe(false);
    expect(fixture.auth.verifyCsrf(artifacts.session.token, artifacts.session.csrfToken)).toBe(
      false,
    );
    expect(fixture.auth.resolveCurrentAuthority(artifacts.session.token)).toBeNull();
    expect(
      fixture.auth.beginFreshVerification(artifacts.session.token, "replace-credential", binding),
    ).toEqual({ ok: false, error: "not-authenticated" });
    expect(await fixture.auth.completeAuthentication(artifacts.challengeId, {}, binding)).toEqual({
      ok: false,
      error: "invalid-ceremony",
    });
    expect(fixture.auth.beginEnrollment(artifacts.enrollmentToken, binding)).toEqual({
      ok: false,
      error: "invalid-enrollment",
    });

    const freshSignIn = await authenticate(fixture);
    expect(freshSignIn.token).not.toBe(artifacts.session.token);
    expect(fixture.repository.getCredential()).toMatchObject({
      credentialId: credentialBefore?.credentialId,
      publicKey: credentialBefore?.publicKey,
    });
  });

  test("sanitizes readable missing credential state before requiring re-enrollment", async () => {
    const fixture = createFixture();
    const artifacts = await createRestoreArtifacts(fixture);
    fixture.repository.credential = null;

    expect(
      await fixture.auth.prepareForFoundationRestore({ mode: "preserve-compatible-credential" }),
    ).toEqual({ outcome: "re-enrollment-required", reason: "missing" });
    expect(fixture.repository.enrollment).toBeNull();
    expect(fixture.repository.challenges.size).toBe(0);
    await expectRestoreArtifactsRejected(fixture, artifacts);
  });

  test("sanitizes readable invalid credential state before requiring re-enrollment", async () => {
    const fixture = createFixture();
    const artifacts = await createRestoreArtifacts(fixture);
    fixture.repository.credential = {
      credentialId: "",
      publicKey: { kty: "unsupported" },
      signCount: -1,
      createdAtMs: Number.NaN,
    };

    expect(
      await fixture.auth.prepareForFoundationRestore({ mode: "preserve-compatible-credential" }),
    ).toEqual({ outcome: "re-enrollment-required", reason: "invalid" });
    expect(fixture.repository.enrollment).toBeNull();
    expect(fixture.repository.challenges.size).toBe(0);
    await expectRestoreArtifactsRejected(fixture, artifacts);
  });

  test("sanitizes readable incompatible storage before requiring re-enrollment", async () => {
    const fixture = createFixture();
    const artifacts = await createRestoreArtifacts(fixture);
    fixture.repository.storageIdentity = {
      environment: "test",
      origin: "https://other.example",
      rpId: "other.example",
    };

    expect(
      await fixture.auth.prepareForFoundationRestore({ mode: "preserve-compatible-credential" }),
    ).toEqual({ outcome: "re-enrollment-required", reason: "incompatible" });
    expect(fixture.repository.enrollment).toBeNull();
    expect(fixture.repository.challenges.size).toBe(0);
    await expectRestoreArtifactsRejected(fixture, artifacts);
  });

  test("explicit reset removes the credential even when storage identity is incompatible", async () => {
    const fixture = createFixture();
    const artifacts = await createRestoreArtifacts(fixture);
    fixture.repository.storageIdentity = {
      environment: "test",
      origin: "https://other.example",
      rpId: "other.example",
    };

    expect(await fixture.auth.prepareForFoundationRestore({ mode: "explicit-reset" })).toEqual({
      outcome: "re-enrollment-required",
      reason: "explicit-reset",
    });
    expect(fixture.repository.getCredential()).toBeNull();
    expect(fixture.repository.generation).toBe(1);
    await expectRestoreArtifactsRejected(fixture, artifacts);
    expect(fixture.auth.issueEnrollmentAuthorization().ok).toBe(true);
  });

  test("rolls back an incompatible explicit reset when its commit fails", async () => {
    const fixture = createFixture();
    const artifacts = await createRestoreArtifacts(fixture);
    const before = {
      credential: structuredClone(fixture.repository.credential),
      enrollment: structuredClone(fixture.repository.enrollment),
      challenges: structuredClone([...fixture.repository.challenges]),
      sessions: structuredClone([...fixture.repository.sessions]),
      generation: fixture.repository.generation,
    };
    fixture.repository.storageIdentity = {
      environment: "test",
      origin: "https://other.example",
      rpId: "other.example",
    };
    fixture.repository.failRestoreCommit = true;

    expect(await fixture.auth.prepareForFoundationRestore({ mode: "explicit-reset" })).toEqual({
      outcome: "sanitation-failed",
    });
    expect(fixture.repository.credential).toEqual(before.credential);
    expect(fixture.repository.enrollment).toEqual(before.enrollment);
    expect([...fixture.repository.challenges]).toEqual(before.challenges);
    expect([...fixture.repository.sessions]).toEqual(before.sessions);
    expect(fixture.repository.generation).toBe(before.generation);
    expect(fixture.auth.authenticateSession(artifacts.session.token)).toBe(true);
  });

  test("accepts only canonical supported credential key records before issuing a challenge", async () => {
    const supported = [
      validEd25519PublicKey,
      { ...validEd25519PublicKey, use: "sig", key_ops: ["verify"] },
      validP256PublicKey,
      { ...validP256PublicKey, use: "sig", key_ops: ["verify"] },
    ];
    for (const publicKey of supported) {
      const fixture = createFixture();
      fixture.repository.credential = {
        credentialId: "credential-1",
        publicKey: { ...publicKey },
        signCount: 1,
        createdAtMs: fixture.now(),
      };
      const authentication = await fixture.auth.beginAuthentication(binding);
      expect(authentication.ok).toBe(true);
      expect(fixture.repository.challenges.size).toBe(1);
    }

    const invalidKeys: JsonWebKey[] = [
      { kty: "EC", crv: "P-256", x: "AA", y: validP256PublicKey.y },
      { kty: "EC", crv: "P-256", x: validP256PublicKey.x, y: "AA" },
      {
        kty: "EC",
        crv: "P-256",
        x: `${validP256PublicKey.x}=`,
        y: validP256PublicKey.y,
      },
      { kty: "EC", crv: "Ed25519", x: validP256PublicKey.x, y: validP256PublicKey.y },
      {
        kty: "EC",
        crv: "P-256",
        x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        y: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
      { kty: "OKP", crv: "Ed25519", x: "AA", y: validEd25519PublicKey.x },
      { kty: "OKP", crv: "P-256", x: validEd25519PublicKey.x },
      { kty: "OKP", crv: "Ed25519", x: `${validEd25519PublicKey.x}=`, alg: "ES256" },
      { kty: "RSA", n: validEd25519PublicKey.x, e: "AQAB", alg: "RS256" },
      { kty: "unsupported", x: validEd25519PublicKey.x },
    ];
    for (const publicKey of invalidKeys) {
      const fixture = createFixture();
      fixture.repository.credential = {
        credentialId: "credential-1",
        publicKey,
        signCount: 1,
        createdAtMs: fixture.now(),
      };
      expect(await fixture.auth.beginAuthentication(binding)).toEqual({
        ok: false,
        error: "invalid-credentials",
      });
      expect(fixture.repository.challenges.size).toBe(0);
      expect(
        await fixture.auth.prepareForFoundationRestore({ mode: "preserve-compatible-credential" }),
      ).toEqual({ outcome: "re-enrollment-required", reason: "invalid" });
    }
  });

  test("rejects invalid credential IDs before challenge creation and classifies them during restore", async () => {
    for (const credentialId of ["", "AA=", "credential-live", "!"]) {
      const fixture = createFixture();
      fixture.repository.credential = {
        credentialId,
        publicKey: { ...validEd25519PublicKey },
        signCount: 1,
        createdAtMs: fixture.now(),
      };

      expect(await fixture.auth.beginAuthentication(binding)).toEqual({
        ok: false,
        error: "invalid-credentials",
      });
      expect(fixture.repository.challenges.size).toBe(0);
      expect(
        await fixture.auth.prepareForFoundationRestore({ mode: "preserve-compatible-credential" }),
      ).toEqual({ outcome: "re-enrollment-required", reason: "invalid" });
    }
  });

  test("rejects private, symmetric, cross-family, and unknown JWK fields", async () => {
    const forbiddenFields = ["d", "n", "e", "p", "q", "dp", "dq", "qi", "oth", "k", "unexpected"];
    for (const publicKey of [validP256PublicKey, validEd25519PublicKey]) {
      for (const field of forbiddenFields) {
        const fixture = createFixture();
        fixture.repository.credential = {
          credentialId: "credential-1",
          publicKey: { ...publicKey, [field]: "forbidden" } as JsonWebKey,
          signCount: 1,
          createdAtMs: fixture.now(),
        };

        expect(await fixture.auth.beginAuthentication(binding)).toEqual({
          ok: false,
          error: "invalid-credentials",
        });
        expect(fixture.repository.challenges.size).toBe(0);
        expect(
          await fixture.auth.prepareForFoundationRestore({
            mode: "preserve-compatible-credential",
          }),
        ).toEqual({ outcome: "re-enrollment-required", reason: "invalid" });
        expect(fixture.repository.enrollment).toBeNull();
        expect(fixture.repository.sessions.size).toBe(0);
      }
    }
  });

  test("rejects WebCrypto-incompatible JWK metadata before challenge creation", async () => {
    const invalidMetadata: JsonWebKey[] = [
      { ...validEd25519PublicKey, alg: undefined },
      { ...validEd25519PublicKey, ext: undefined },
      { ...validEd25519PublicKey, alg: "ES256" },
      { ...validEd25519PublicKey, ext: false },
      { ...validEd25519PublicKey, use: "enc" },
      { ...validEd25519PublicKey, key_ops: ["sign"] },
      { ...validEd25519PublicKey, key_ops: ["verify", "sign"] },
    ];
    for (const publicKey of invalidMetadata) {
      const fixture = createFixture();
      fixture.repository.credential = {
        credentialId: "credential-1",
        publicKey,
        signCount: 1,
        createdAtMs: fixture.now(),
      };

      expect(await fixture.auth.beginAuthentication(binding)).toEqual({
        ok: false,
        error: "invalid-credentials",
      });
      expect(fixture.repository.challenges.size).toBe(0);
      expect(
        await fixture.auth.prepareForFoundationRestore({ mode: "preserve-compatible-credential" }),
      ).toEqual({ outcome: "re-enrollment-required", reason: "invalid" });
    }
  });

  test("performs explicit reset atomically and returns the deliberate reset classification", async () => {
    const fixture = createFixture();
    const artifacts = await createRestoreArtifacts(fixture);

    expect(await fixture.auth.prepareForFoundationRestore({ mode: "explicit-reset" })).toEqual({
      outcome: "re-enrollment-required",
      reason: "explicit-reset",
    });
    expect(fixture.repository.getCredential()).toBeNull();
    expect(fixture.repository.enrollment).toBeNull();
    expect(fixture.repository.challenges.size).toBe(0);
    await expectRestoreArtifactsRejected(fixture, artifacts);
  });

  test("rolls back the credential and every transient collection when sanitation cannot commit", async () => {
    const fixture = createFixture();
    await createRestoreArtifacts(fixture);
    const before = {
      credential: structuredClone(fixture.repository.credential),
      enrollment: structuredClone(fixture.repository.enrollment),
      challenges: structuredClone([...fixture.repository.challenges]),
      sessions: structuredClone([...fixture.repository.sessions]),
      generation: fixture.repository.generation,
    };
    fixture.repository.failRestoreCommit = true;

    expect(
      await fixture.auth.prepareForFoundationRestore({ mode: "preserve-compatible-credential" }),
    ).toEqual({ outcome: "sanitation-failed" });
    expect(fixture.repository.credential).toEqual(before.credential);
    expect(fixture.repository.enrollment).toEqual(before.enrollment);
    expect([...fixture.repository.challenges]).toEqual(before.challenges);
    expect([...fixture.repository.sessions]).toEqual(before.sessions);
    expect(fixture.repository.generation).toBe(before.generation);
  });

  test("rolls back an explicit reset when credential removal cannot commit", async () => {
    const fixture = createFixture();
    await createRestoreArtifacts(fixture);
    const credentialBefore = structuredClone(fixture.repository.credential);
    const sessionsBefore = structuredClone([...fixture.repository.sessions]);
    fixture.repository.failRestoreCommit = true;

    expect(await fixture.auth.prepareForFoundationRestore({ mode: "explicit-reset" })).toEqual({
      outcome: "sanitation-failed",
    });
    expect(fixture.repository.credential).toEqual(credentialBefore);
    expect([...fixture.repository.sessions]).toEqual(sessionsBefore);
    expect(fixture.repository.enrollment).not.toBeNull();
    expect(fixture.repository.challenges.size).toBeGreaterThan(0);
  });

  test("does not expose storage details when the sanitation operation is unreadable", async () => {
    const fixture = createFixture();
    const auth = createTechnicalAdminAuth(
      { environment: "production", origin: binding.origin, rpId: "timer.example" },
      throwingRepository("prepareForFoundationRestore", fixture.repository),
    );

    const result = await auth.prepareForFoundationRestore({
      mode: "preserve-compatible-credential",
    });
    expect(result).toEqual({ outcome: "sanitation-failed" });
    expect(JSON.stringify(result)).not.toMatch(/credential|sqlite|path|schema|injected/u);
    expect(Object.keys(result)).toEqual(["outcome"]);
  });

  test("does not issue enrollment when reset evidence cannot be recorded", async () => {
    const fixture = createFixture();
    await enroll(fixture);
    fixture.repository.appendOperationalLog = () => {
      throw new Error("injected reset log failure");
    };
    const auth = createTechnicalAdminAuth(
      { environment: "test", origin: binding.origin, rpId: "timer.example" },
      fixture.repository,
      fixture.verifier,
    );
    expect(auth.emergencyReset()).toEqual({ ok: false, error: "storage-failure" });
    expect(fixture.repository.credential?.credentialId).toBe("credential-1");
    expect(fixture.repository.enrollment).not.toBeNull();
  });

  test("applies progressive delay after five failed ceremony completions", async () => {
    const fixture = createFixture();
    for (let index = 0; index < 5; index++) {
      expect(await fixture.auth.completeAuthentication("missing", {}, binding, "source-a")).toEqual(
        { ok: false, error: "invalid-ceremony" },
      );
    }
    expect(
      await fixture.auth.completeAuthentication("missing", {}, binding, "source-a"),
    ).toMatchObject({ ok: false, error: "throttled", retryAfterMs: 1_000 });
    fixture.advance(1_000);
    expect(await fixture.auth.completeAuthentication("missing", {}, binding, "source-a")).toEqual({
      ok: false,
      error: "invalid-ceremony",
    });
    expect(
      await fixture.auth.completeAuthentication("missing", {}, binding, "source-a"),
    ).toMatchObject({ ok: false, error: "throttled" });
    expect(fixture.repository.alerts.some((alert) => alert.event === "sustained-throttle")).toBe(
      true,
    );
    expect(await fixture.auth.completeAuthentication("missing", {}, binding, "source-b")).toEqual({
      ok: false,
      error: "invalid-ceremony",
    });
  });

  test("rejects an HTTP origin and an RP ID that is not the exact origin host", () => {
    expect(() =>
      createTechnicalAdminAuth(
        { environment: "test", origin: "http://localhost:3000", rpId: "localhost" },
        new MemoryTechnicalAdminAuthRepository(),
      ),
    ).toThrow();
    expect(() =>
      createTechnicalAdminAuth(
        { environment: "test", origin: binding.origin, rpId: "example" },
        new MemoryTechnicalAdminAuthRepository(),
      ),
    ).toThrow();
  });

  test("native verification rejects missing UV and a wrong RP hash", async () => {
    const verifier = new NativeWebAuthnVerifier();
    const challenge = "Y2hhbGxlbmdl";
    const clientDataJSON = encodeBase64Url(
      JSON.stringify({ type: "webauthn.get", challenge, origin: binding.origin }),
    );
    const validRpHash = new Uint8Array(
      new Bun.CryptoHasher("sha256").update("timer.example").digest(),
    );
    const missingUvAuthData = new Uint8Array(37);
    missingUvAuthData.set(validRpHash);
    missingUvAuthData[32] = 0x01;
    let missingUvError: unknown;
    try {
      await verifier.verifyAuthentication(
        {
          id: "credential-1",
          response: {
            clientDataJSON,
            authenticatorData: encodeBase64Url(missingUvAuthData),
            signature: encodeBase64Url(new Uint8Array()),
          },
        },
        {
          challenge,
          origin: binding.origin,
          rpId: "timer.example",
          credential: {
            credentialId: "credential-1",
            publicKey: { kty: "OKP", crv: "Ed25519", x: "AA" },
            signCount: 0,
            createdAtMs: 0,
          },
          requireUserVerification: true,
        },
      );
    } catch (error) {
      missingUvError = error;
    }
    expect(String(missingUvError)).toContain("User verification required");
    const wrongRpAuthData = new Uint8Array(missingUvAuthData);
    wrongRpAuthData[0] = (wrongRpAuthData[0] ?? 0) ^ 0xff;
    let wrongRpError: unknown;
    try {
      await verifier.verifyAuthentication(
        {
          id: "credential-1",
          response: {
            clientDataJSON,
            authenticatorData: encodeBase64Url(wrongRpAuthData),
            signature: encodeBase64Url(new Uint8Array()),
          },
        },
        {
          challenge,
          origin: binding.origin,
          rpId: "timer.example",
          credential: {
            credentialId: "credential-1",
            publicKey: { kty: "OKP", crv: "Ed25519", x: "AA" },
            signCount: 0,
            createdAtMs: 0,
          },
          requireUserVerification: true,
        },
      );
    } catch (error) {
      wrongRpError = error;
    }
    expect(String(wrongRpError)).toContain("Invalid RP ID");
  });

  test("native verification explicitly rejects unsupported RSA dispatch", async () => {
    const verifier = new NativeWebAuthnVerifier();
    const challenge = "Y2hhbGxlbmdl";
    const clientDataJSON = encodeBase64Url(
      JSON.stringify({ type: "webauthn.get", challenge, origin: binding.origin }),
    );
    const authData = new Uint8Array(37);
    authData.set(new Uint8Array(new Bun.CryptoHasher("sha256").update("timer.example").digest()));
    authData[32] = 0x05;

    await expect(
      verifier.verifyAuthentication(
        {
          id: "credential-1",
          response: {
            clientDataJSON,
            authenticatorData: encodeBase64Url(authData),
            signature: encodeBase64Url(new Uint8Array()),
          },
        },
        {
          challenge,
          origin: binding.origin,
          rpId: "timer.example",
          credential: {
            credentialId: "credential-1",
            publicKey: { kty: "RSA", n: "AA", e: "AQAB", alg: "RS256" },
            signCount: 0,
            createdAtMs: 0,
          },
          requireUserVerification: true,
        },
      ),
    ).rejects.toThrow("Unsupported public key.");
  });

  test("contains storage and commit failures without acknowledging state", async () => {
    const issueFailure = createTechnicalAdminAuth(
      { environment: "test", origin: binding.origin, rpId: "timer.example" },
      throwingRepository("hasCredential"),
    );
    expect(issueFailure.issueEnrollmentAuthorization()).toEqual({
      ok: false,
      error: "storage-failure",
    });

    const fixture = createFixture();
    await enroll(fixture);
    const enrolledOptions = await fixture.auth.beginAuthentication(binding);
    if (!enrolledOptions.ok) throw new Error("Expected authentication options.");
    const enrolledSession = await fixture.auth.completeAuthentication(
      enrolledOptions.value.challengeId,
      {},
      binding,
    );
    if (!enrolledSession.ok) throw new Error("Expected session.");
    const credentialReadFailure = createTechnicalAdminAuth(
      { environment: "test", origin: binding.origin, rpId: "timer.example" },
      throwingRepository("getCredential", fixture.repository),
      fixture.verifier,
    );
    expect(await credentialReadFailure.beginAuthentication(binding)).toEqual({
      ok: false,
      error: "storage-failure",
    });
    const commitFailure = createTechnicalAdminAuth(
      { environment: "production", origin: binding.origin, rpId: "timer.example" },
      throwingRepository("commitAuthentication", fixture.repository),
      fixture.verifier,
    );
    const authentication = await commitFailure.beginAuthentication(binding);
    if (!authentication.ok) throw new Error("Expected authentication options.");
    expect(
      await commitFailure.completeAuthentication(authentication.value.challengeId, {}, binding),
    ).toEqual({ ok: false, error: "invalid-ceremony" });
    const readFailure = createTechnicalAdminAuth(
      { environment: "test", origin: binding.origin, rpId: "timer.example" },
      throwingRepository("getSession", fixture.repository),
      fixture.verifier,
    );
    expect(readFailure.authenticateSession("missing")).toBe(false);
    const touchFailure = createTechnicalAdminAuth(
      { environment: "test", origin: binding.origin, rpId: "timer.example" },
      throwingRepository("touchSession", fixture.repository),
      fixture.verifier,
    );
    expect(touchFailure.authenticateSession(enrolledSession.value.token)).toBe(false);
    const revokeFailure = createTechnicalAdminAuth(
      { environment: "test", origin: binding.origin, rpId: "timer.example" },
      throwingRepository("revokeSession", fixture.repository),
      fixture.verifier,
    );
    expect(() => revokeFailure.logout(enrolledSession.value.token)).not.toThrow();
  });
});

async function enroll(fixture: ReturnType<typeof createFixture>) {
  const issued = fixture.auth.issueEnrollmentAuthorization();
  if (!issued.ok) throw new Error("Expected enrollment authorization.");
  const token = decodeURIComponent(issued.value.url.split("token=")[1] ?? "");
  const options = fixture.auth.beginEnrollment(token, binding);
  if (!options.ok) throw new Error("Expected enrollment options.");
  expect(await fixture.auth.completeEnrollment(options.value.challengeId, {}, binding)).toEqual({
    ok: true,
    value: undefined,
  });
}

async function authenticate(fixture: ReturnType<typeof createFixture>) {
  const options = await fixture.auth.beginAuthentication(binding);
  if (!options.ok) throw new Error("Expected authentication options.");
  const session = await fixture.auth.completeAuthentication(options.value.challengeId, {}, binding);
  if (!session.ok) throw new Error("Expected authenticated session.");
  return session.value;
}

async function createRestoreArtifacts(fixture: ReturnType<typeof createFixture>) {
  await enroll(fixture);
  const session = await authenticate(fixture);
  await authenticate(fixture);
  const fresh = fixture.auth.beginFreshVerification(session.token, "replace-credential", binding);
  if (!fresh.ok) throw new Error("Expected fresh verification options.");
  expect(
    await fixture.auth.completeFreshVerification(
      session.token,
      fresh.value.challengeId,
      {},
      binding,
    ),
  ).toEqual({ ok: true, value: undefined });
  const pendingAuthentication = await fixture.auth.beginAuthentication(binding);
  if (!pendingAuthentication.ok) throw new Error("Expected pending authentication challenge.");
  fixture.repository.issueEnrollment("pending-enrollment", fixture.now() + 60_000);
  return {
    session,
    challengeId: pendingAuthentication.value.challengeId,
    enrollmentToken: "pending-enrollment",
  };
}

async function expectRestoreArtifactsRejected(
  fixture: ReturnType<typeof createFixture>,
  artifacts: Awaited<ReturnType<typeof createRestoreArtifacts>>,
) {
  expect(fixture.auth.authenticateSession(artifacts.session.token)).toBe(false);
  expect(fixture.auth.verifyCsrf(artifacts.session.token, artifacts.session.csrfToken)).toBe(false);
  expect(fixture.auth.resolveCurrentAuthority(artifacts.session.token)).toBeNull();
  expect(
    fixture.auth.beginFreshVerification(artifacts.session.token, "replace-credential", binding),
  ).toEqual({ ok: false, error: "not-authenticated" });
  expect(await fixture.auth.completeAuthentication(artifacts.challengeId, {}, binding)).toEqual({
    ok: false,
    error: "invalid-ceremony",
  });
  expect(fixture.auth.beginEnrollment(artifacts.enrollmentToken, binding)).toEqual({
    ok: false,
    error: "invalid-enrollment",
  });
}

function encodeBase64Url(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Buffer.from(bytes).toString("base64url");
}

function throwingRepository(
  failure: string,
  base = new MemoryTechnicalAdminAuthRepository(),
): TechnicalAdminAuthRepository {
  const fail = () => {
    throw new Error(`injected ${failure} failure`);
  };
  return {
    hasCredential: failure === "hasCredential" ? fail : () => base.hasCredential(),
    getCredential: failure === "getCredential" ? fail : () => base.getCredential(),
    issueEnrollment:
      failure === "issueEnrollment" ? fail : (...args) => base.issueEnrollment(...args),
    consumeEnrollment:
      failure === "consumeEnrollment" ? fail : (...args) => base.consumeEnrollment(...args),
    createChallenge:
      failure === "createChallenge" ? fail : (...args) => base.createChallenge(...args),
    consumeChallenge:
      failure === "consumeChallenge" ? fail : (...args) => base.consumeChallenge(...args),
    commitEnrollment:
      failure === "commitEnrollment" ? fail : (...args) => base.commitEnrollment(...args),
    commitAuthentication:
      failure === "commitAuthentication" ? fail : (...args) => base.commitAuthentication(...args),
    commitFreshVerification:
      failure === "commitFreshVerification"
        ? fail
        : (...args) => base.commitFreshVerification(...args),
    commitReplacement:
      failure === "commitReplacement" ? fail : (...args) => base.commitReplacement(...args),
    getSession: failure === "getSession" ? fail : (...args) => base.getSession(...args),
    touchSession: failure === "touchSession" ? fail : (...args) => base.touchSession(...args),
    revokeSession: failure === "revokeSession" ? fail : (...args) => base.revokeSession(...args),
    revokeOtherSessions:
      failure === "revokeOtherSessions" ? fail : (...args) => base.revokeOtherSessions(...args),
    activeSessionCount:
      failure === "activeSessionCount" ? fail : (...args) => base.activeSessionCount(...args),
    getGeneration: failure === "getGeneration" ? fail : () => base.getGeneration(),
    resetAuthority:
      failure === "resetAuthority" || failure === "appendOperationalLog"
        ? fail
        : (...args) => base.resetAuthority(...args),
    prepareForFoundationRestore:
      failure === "prepareForFoundationRestore"
        ? fail
        : (...args) => base.prepareForFoundationRestore(...args),
    getStorageIdentity: () => base.getStorageIdentity(),
    getStorageStatus:
      failure === "getStorageStatus" ? fail : (...args) => base.getStorageStatus(...args),
    appendOperationalLog:
      failure === "appendOperationalLog" ? fail : (...args) => base.appendOperationalLog(...args),
    appendAlert: failure === "appendAlert" ? fail : (...args) => base.appendAlert(...args),
    nextTelemetryExpiry:
      failure === "nextTelemetryExpiry" ? fail : () => base.nextTelemetryExpiry(),
    maintain: failure === "maintain" ? fail : (...args) => base.maintain(...args),
    close: failure === "close" ? fail : () => base.close(),
  };
}
