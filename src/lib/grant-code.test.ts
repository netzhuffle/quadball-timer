import { describe, expect, test } from "bun:test";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import { createGrantTestKeyRing, createGrantTestRandomness } from "@/lib/grant-authority-contract";
import { createGrantTestAuthorityVerifier } from "@/lib/grant-authority-test-support";
import type { FoundationStorageTransaction } from "@/lib/foundation-storage";
import { expireGrantIfDue } from "@/lib/grant-lifecycle";
import { createTypedGrantAuthority } from "@/lib/grant-management";
import {
  GRANT_CODE_CONFUSABILITY_REVIEW,
  GRANT_CODE_REVIEWED_CONFUSABLE_GROUPS,
  GRANT_CODE_WORDS,
  GRANT_CODE_WORD_LIST_REVIEW,
  eraseGrantCode,
  generateGrantCode,
  normalizeGrantCode,
  validateGrantCodeConfusabilityArtifact,
  validateGrantCodeWordList,
} from "@/lib/grant-code";
import { GENERIC_GRANT_ADMISSION_FAILURE } from "@/lib/grant-authority-types";
import {
  beginAdmission,
  GRANT_ADMISSION_GLOBAL_ATTEMPT_LIMIT,
  GRANT_ADMISSION_QR_GLOBAL_ATTEMPT_LIMIT,
  GRANT_ADMISSION_QR_SOURCE_BURST,
  recordAdmissionFailure,
  recordAdmissionSuccess,
  sourceDigest,
} from "@/lib/grant-admission-throttle";
import type { GrantAdmissionMode, StoredGrant } from "@/lib/grant-types";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import { lockControlGrantEventGame } from "@/lib/grant-management-sessions";
import { validateGrantState } from "@/lib/grant-state-validation";

describe("Grant Codes", () => {
  test("validates the reviewed 1,024-word radio vocabulary", () => {
    expect(GRANT_CODE_WORDS).toHaveLength(1024);
    expect(validateGrantCodeWordList()).toBeNull();
    expect(GRANT_CODE_WORD_LIST_REVIEW).toMatchObject({
      artifactVersion: "grant-code-word-list-v1",
      wordCount: 1024,
      normalizedWordCount: 1024,
      uniqueNormalizedWordCount: 1024,
      reviewedShortWords: true,
      reviewedCommonEnglish: true,
      reviewedForNonNativeComprehension: true,
      reviewedRadioDistinct: true,
      reviewedSpelling: true,
      reviewedHomophones: true,
      reviewedPrefixConfusability: true,
      radioConfusablePairs: 0,
      homophonePairs: 0,
      prefixAmbiguities: 0,
    });
    expect(GRANT_CODE_CONFUSABILITY_REVIEW).toEqual({
      artifactVersion: "grant-code-confusability-review-v1",
      groupCount: 31,
      canonicalSha256: "97c8140c8ac6d5db78ee40291d36021696eff6e0a41ebee507ef9d6fc28affb3",
    });
    expect(GRANT_CODE_REVIEWED_CONFUSABLE_GROUPS).toHaveLength(31);
    expect(validateGrantCodeConfusabilityArtifact()).toBeNull();
  });

  test("rejects every discovered confusable pair through the reviewed artifact", () => {
    for (const [first, second] of [
      ["seen", "scene"],
      ["wait", "weight"],
      ["sell", "cell"],
      ["weather", "whether"],
    ] as const) {
      const candidate = [...GRANT_CODE_WORDS];
      const replacementIndex = candidate.findIndex((word) => word !== first && word !== second);
      expect(replacementIndex).toBeGreaterThanOrEqual(0);
      candidate.splice(replacementIndex, 1, first);
      const validation = validateGrantCodeWordList(candidate);
      if (validation === null) throw new Error(`Expected ${first}/${second} rejection.`);
      expect(validation).toContain(first);
      expect(validation).toContain(second);
    }

    for (const [first, second] of [
      ["role", "roll"],
      ["accept", "except"],
    ] as const) {
      const candidate = [...GRANT_CODE_WORDS];
      const replacementIndex = candidate.findIndex((word) => word !== first && word !== second);
      expect(replacementIndex).toBeGreaterThanOrEqual(0);
      candidate.splice(replacementIndex, 1, first);
      const validation = validateGrantCodeWordList(candidate);
      if (validation === null) throw new Error(`Expected ${first}/${second} rejection.`);
      expect(validation).toContain(first);
      expect(validation).toContain(second);
    }
  });

  test("samples both word positions and digits without fallback bias", () => {
    let calls = 0;
    const randomness = {
      bytes(length: number) {
        calls += 1;
        expect(length).toBe(6);
        return Uint8Array.from([0, 0, 3, 255, 0, 0]);
      },
    };
    const code = generateGrantCode(randomness);
    expect(code).toBe(`${GRANT_CODE_WORDS[0]}-${GRANT_CODE_WORDS[1023]}-000`);
    expect(normalizeGrantCode(code)).toBe(code);
    expect(code).toMatch(/^[a-z]+-[a-z]+-\d{3}$/u);

    const listEnd = generateGrantCode({
      bytes() {
        return Uint8Array.from([255, 255, 255, 254, 253, 231]);
      },
    });
    expect(listEnd).toBe(`${GRANT_CODE_WORDS[1023]}-${GRANT_CODE_WORDS[1022]}-999`);
    expect(calls).toBe(1);
  });

  test("retries collisions and rejected digit samples within a hard bound", () => {
    let calls = 0;
    const code = generateGrantCode({
      bytes() {
        calls += 1;
        return calls === 1
          ? Uint8Array.from([0, 5, 0, 5, 0, 0])
          : Uint8Array.from([0, 5, 0, 6, 253, 231]);
      },
    });
    expect(code).toBe(`${GRANT_CODE_WORDS[5]}-${GRANT_CODE_WORDS[6]}-999`);
    expect(calls).toBe(2);

    expect(() =>
      generateGrantCode({
        bytes: () => Uint8Array.from([0, 5, 0, 5, 0, 0]),
      }),
    ).toThrow("distinct unbiased code");
  });

  test("keeps Code and QR budgets independent and durable at their boundaries", async () => {
    let nowMs = 1_000;
    const options = createOptions(811, () => nowMs);
    const storage = createInMemoryFoundationStorage();
    storage.setGrantKeyRing?.(options.keyRing);

    for (let attempt = 0; attempt < 5; attempt += 1)
      expect(await useBudget(storage, options, "code", "code-source-a", true)).toBeNull();
    expect(await useBudget(storage, options, "code", "code-source-a", false)).toMatchObject({
      retryAfterMs: 1_000,
    });
    expect(await useBudget(storage, options, "code", "code-source-b", true)).toBeNull();
    nowMs += 1_000;
    expect(await useBudget(storage, options, "code", "code-source-a", false)).toBeNull();
    await storage.transaction((transaction) => {
      recordAdmissionSuccess(transaction, "code", sourceDigest(options, "code-source-a"), nowMs);
    });
    expect(await useBudget(storage, options, "code", "code-source-a", false)).toBeNull();

    const globalCodeStorage = createInMemoryFoundationStorage();
    globalCodeStorage.setGrantKeyRing?.(options.keyRing);
    for (let attempt = 0; attempt < GRANT_ADMISSION_GLOBAL_ATTEMPT_LIMIT; attempt += 1)
      expect(
        await useBudget(globalCodeStorage, options, "code", `global-${attempt}`, true),
      ).toBeNull();
    expect(await useBudget(globalCodeStorage, options, "code", "global-last", true)).toMatchObject({
      retryAfterMs: expect.any(Number),
    });

    const qrStorage = createInMemoryFoundationStorage();
    qrStorage.setGrantKeyRing?.(options.keyRing);
    for (let attempt = 0; attempt < GRANT_ADMISSION_QR_SOURCE_BURST; attempt += 1)
      expect(await useBudget(qrStorage, options, "qr", "qr-source-a", true)).toBeNull();
    expect(await useBudget(qrStorage, options, "qr", "qr-source-a", true)).toMatchObject({
      retryAfterMs: expect.any(Number),
    });
    expect(await useBudget(qrStorage, options, "qr", "qr-source-b", true)).toBeNull();
    nowMs += 500;
    expect(await useBudget(qrStorage, options, "qr", "qr-source-a", false)).toMatchObject({
      retryAfterMs: 500,
    });
    nowMs += 500;
    expect(await useBudget(qrStorage, options, "qr", "qr-source-a", true)).toBeNull();
    nowMs += 1_000;
    expect(await useBudget(qrStorage, options, "qr", "qr-source-a", true)).toBeNull();

    const globalQrStorage = createInMemoryFoundationStorage();
    globalQrStorage.setGrantKeyRing?.(options.keyRing);
    for (let attempt = 0; attempt < GRANT_ADMISSION_QR_GLOBAL_ATTEMPT_LIMIT; attempt += 1)
      expect(
        await useBudget(globalQrStorage, options, "qr", `qr-global-${attempt}`, true),
      ).toBeNull();
    expect(await useBudget(globalQrStorage, options, "qr", "qr-global-last", true)).toMatchObject({
      retryAfterMs: expect.any(Number),
    });
  });

  test("creates, replaces, admits, and terminally erases a code without storing plaintext", async () => {
    const storage = createInMemoryFoundationStorage();
    const authority = createTypedGrantAuthority(storage, createOptions());
    const admin = await authority.createEventAdminGrant({
      authority: { kind: "technical-admin", id: "tech" },
      scope: { eventId: "event-code", eventTimeZone: "UTC", finalGameDayDate: "2026-03-20" },
    });
    expect(admin.status).toBe("created");
    if (admin.status !== "created") throw new Error("Expected Event Admin Grant.");
    const adminSession = await authority.admitGrant({
      qrCredential: admin.qrCredential,
      browserContext: "admin-code",
    });
    expect(adminSession.status).toBe("admitted");
    if (adminSession.status !== "admitted") throw new Error("Expected Event Admin Session.");
    const grant = await authority.createControlGrant({
      authority: { kind: "grant-session", sessionBearer: adminSession.sessionBearer },
      scope: {
        eventId: "event-code",
        gameDayId: "day-code",
        pitchId: "pitch-code",
        pitchSlotId: "slot-code",
      },
    });
    expect(grant.status).toBe("created");
    if (grant.status !== "created") throw new Error("Expected Control Grant.");

    const created = await authority.createGrantCode(grant.grantId, {
      kind: "grant-session",
      sessionBearer: adminSession.sessionBearer,
    });
    expect(created.status).toBe("created");
    if (created.status !== "created") throw new Error("Expected Grant Code.");
    expect(created.code).toMatch(/^[a-z]+-[a-z]+-[0-9]{3}$/);
    const stored = await storage.transaction((transaction) =>
      transaction.findGrantById(grant.grantId),
    );
    expect(JSON.stringify(stored)).not.toContain(created.code);
    expect(stored?.code).toMatchObject({ state: "present", ciphertext: expect.any(String) });

    const admitted = await authority.admitGrantCode({
      grantCode: created.code.toUpperCase(),
      browserContext: "code-device",
    });
    expect(admitted.status).toBe("admitted");

    const replacement = await authority.replaceGrantCode(grant.grantId, {
      kind: "grant-session",
      sessionBearer: adminSession.sessionBearer,
    });
    expect(replacement.status).toBe("replaced");
    if (replacement.status !== "replaced") throw new Error("Expected replacement Grant Code.");
    expect(replacement.code).not.toBe(created.code);
    expect(
      await authority.admitGrantCode({ grantCode: created.code, browserContext: "old" }),
    ).toEqual(GENERIC_GRANT_ADMISSION_FAILURE);

    expect(
      await authority.disableGrantCode(grant.grantId, {
        kind: "grant-session",
        sessionBearer: adminSession.sessionBearer,
      }),
    ).toMatchObject({ status: "updated" });
    const erased = await storage.transaction((transaction) =>
      transaction.findGrantById(grant.grantId),
    );
    expect(erased?.code).toMatchObject({
      state: "disabled",
      ciphertext: null,
      lookupDigest: null,
      iv: null,
      tag: null,
    });

    const beforeMalformedAudit = await storage.transaction((transaction) => ({
      grant: transaction.findGrantById(grant.grantId),
      audit: transaction.listGrantAudit(grant.grantId),
      anchor: transaction.readGrantAdmissionStateAnchor?.() ?? null,
    }));
    const firstAudit = beforeMalformedAudit.audit[0];
    if (firstAudit === undefined) throw new Error("Expected Grant audit evidence.");
    await expect(
      storage.transaction((transaction) =>
        transaction.appendGrantAudit({
          ...firstAudit,
          auditId: "audit-malformed-code",
          codeState: "present",
        }),
      ),
    ).rejects.toThrow();
    const afterMalformedAudit = await storage.transaction((transaction) => ({
      grant: transaction.findGrantById(grant.grantId),
      audit: transaction.listGrantAudit(grant.grantId),
      anchor: transaction.readGrantAdmissionStateAnchor?.() ?? null,
    }));
    expect(afterMalformedAudit).toEqual(beforeMalformedAudit);
    expect(await storage.readiness()).toMatchObject({ ok: true });
  });

  test("rejects malformed telemetry without changing the authenticated admission state", async () => {
    const storage = createInMemoryFoundationStorage();
    const options = createOptions();
    storage.setGrantKeyRing?.(options.keyRing);
    const before = await storage.transaction((transaction) => ({
      anchor: transaction.readGrantAdmissionStateAnchor?.() ?? null,
      telemetry: transaction.readGrantAdmissionTelemetry?.("code", "A".repeat(43)) ?? null,
    }));
    let failedRevision = -1;
    await expect(
      storage.transaction((transaction) => {
        failedRevision = transaction.revision;
        transaction.writeGrantAdmissionTelemetry?.({
          mode: "code",
          sourceDigest: "A".repeat(43),
          failedAttempts: 1_000_001,
          delayUntilMs: null,
          lastAttemptAtMs: 1_000,
          lastSuccessAtMs: null,
        });
      }),
    ).rejects.toThrow();
    const after = await storage.transaction((transaction) => ({
      anchor: transaction.readGrantAdmissionStateAnchor?.() ?? null,
      telemetry: transaction.readGrantAdmissionTelemetry?.("code", "A".repeat(43)) ?? null,
      revision: transaction.revision,
    }));
    expect(after.anchor).toEqual(before.anchor);
    expect(after.telemetry).toEqual(before.telemetry);
    expect(after.revision).toBe(failedRevision);
    expect(await storage.readiness()).toMatchObject({ ok: true });
  });

  test("does not key memory admission rows installed before the Grant key ring", async () => {
    const storage = createInMemoryFoundationStorage();
    const internal = storage as unknown as {
      state: {
        grantAdmissionTelemetry: Map<string, unknown>;
      };
    };
    internal.state.grantAdmissionTelemetry.set(`code:${"A".repeat(43)}`, {
      mode: "code",
      sourceDigest: "A".repeat(43),
      failedAttempts: 1,
      delayUntilMs: null,
      lastAttemptAtMs: 1_000,
      lastSuccessAtMs: null,
    });
    expect(await storage.readiness()).toMatchObject({ ok: false });
    expect(() => storage.setGrantKeyRing?.(createGrantTestKeyRing())).toThrow();
    expect(await storage.readiness()).toMatchObject({ ok: false });
  });

  test("expires a coded Grant with separate QR and Code erasure evidence", async () => {
    let nowMs = 1_000;
    const storage = createInMemoryFoundationStorage();
    const authority = createTypedGrantAuthority(storage, {
      ...createOptions(),
      clock: { nowMs: () => nowMs },
    });
    const admin = await authority.createEventAdminGrant({
      authority: { kind: "technical-admin", id: "tech" },
      scope: { eventId: "event-expiry", eventTimeZone: "UTC", finalGameDayDate: "2026-03-20" },
    });
    if (admin.status !== "created") throw new Error("Expected Event Admin Grant.");
    const adminSession = await authority.admitGrant({
      qrCredential: admin.qrCredential,
      browserContext: "admin-expiry",
    });
    if (adminSession.status !== "admitted") throw new Error("Expected Event Admin Session.");
    const grant = await authority.createControlGrant({
      authority: { kind: "grant-session", sessionBearer: adminSession.sessionBearer },
      scope: {
        eventId: "event-expiry",
        gameDayId: "day-expiry",
        pitchId: "pitch-expiry",
        pitchSlotId: "slot-expiry",
      },
      expiresAtMs: 1_100,
    });
    if (grant.status !== "created") throw new Error("Expected expiring Control Grant.");
    const code = await authority.createGrantCode(grant.grantId, {
      kind: "grant-session",
      sessionBearer: adminSession.sessionBearer,
    });
    if (code.status !== "created") throw new Error("Expected Grant Code.");
    const stored = await storage.transaction((transaction) =>
      transaction.findGrantById(grant.grantId),
    );
    const codeFingerprint = stored?.code?.fingerprint;
    if (codeFingerprint === undefined) throw new Error("Expected stored Code fingerprint.");

    nowMs = 1_100;
    expect(
      await authority.admitGrant({
        qrCredential: grant.qrCredential,
        browserContext: "expired-browser",
      }),
    ).toEqual(GENERIC_GRANT_ADMISSION_FAILURE);
    const audits = await storage.transaction((transaction) =>
      transaction.listGrantAudit(grant.grantId),
    );
    const qrExpiry = audits.find((audit) => audit.action === "grant-expired");
    const codeExpiry = audits.find((audit) => audit.action === "grant-code-erased-expiry");
    expect(qrExpiry).toMatchObject({ action: "grant-expired", credentialKind: "qr" });
    expect(qrExpiry?.codeState).toBeUndefined();
    expect(codeExpiry).toMatchObject({
      action: "grant-code-erased-expiry",
      credentialKind: "manual-code",
      credentialFingerprint: codeFingerprint,
      previousCodeFingerprint: codeFingerprint,
      codeFormatVersion: 1,
      codeStateBefore: "present",
      codeState: "erased",
    });
    expect(await storage.readiness()).toMatchObject({ ok: true });
  });

  test("preserves Game-Lock Code erasure when Grant expiry follows", async () => {
    let nowMs = 1_000;
    const storage = createInMemoryFoundationStorage();
    const options = createOptions({
      resolve: () => ({ status: "eligible" as const, eventGameId: "game-expiry-lock" }),
      resolveEventGameLock: () => ({ eventGameId: "game-expiry-lock", apply: () => {} }),
    });
    options.clock = { nowMs: () => nowMs };
    const authority = createTypedGrantAuthority(storage, options);
    const admin = await authority.createEventAdminGrant({
      authority: { kind: "technical-admin", id: "tech" },
      scope: { eventId: "event-lock-expiry", eventTimeZone: "UTC", finalGameDayDate: "2026-03-20" },
    });
    if (admin.status !== "created") throw new Error("Expected Event Admin Grant.");
    const adminSession = await authority.admitGrant({
      qrCredential: admin.qrCredential,
      browserContext: "lock-expiry-admin",
    });
    if (adminSession.status !== "admitted") throw new Error("Expected Event Admin Session.");
    const grant = await authority.createControlGrant({
      authority: { kind: "grant-session", sessionBearer: adminSession.sessionBearer },
      scope: {
        eventId: "event-lock-expiry",
        gameDayId: "day-lock-expiry",
        pitchId: "pitch-lock-expiry",
        pitchSlotId: "slot-lock-expiry",
      },
      expiresAtMs: 1_100,
    });
    if (grant.status !== "created") throw new Error("Expected expiring Control Grant.");
    const code = await authority.createGrantCode(grant.grantId, {
      kind: "grant-session",
      sessionBearer: adminSession.sessionBearer,
    });
    if (code.status !== "created") throw new Error("Expected Grant Code.");
    expect(
      await authority.admitGrantCode({ grantCode: code.code, browserContext: "lock-expiry-code" }),
    ).toMatchObject({ status: "admitted" });
    expect(await lockControlGrantEventGame(storage, options, { accepted: true })).toMatchObject({
      status: "locked",
    });
    const beforeExpiry = await storage.transaction((transaction) =>
      transaction.listGrantAudit(grant.grantId),
    );
    expect(
      beforeExpiry.filter((audit) => audit.action === "grant-code-erased-game-lock"),
    ).toHaveLength(1);
    nowMs = 1_100;
    expect(
      await authority.admitGrant({
        qrCredential: grant.qrCredential,
        browserContext: "lock-expiry-qr",
      }),
    ).toEqual(GENERIC_GRANT_ADMISSION_FAILURE);
    expect(
      await authority.admitGrantCode({
        grantCode: code.code,
        browserContext: "lock-expiry-code-old",
      }),
    ).toEqual(GENERIC_GRANT_ADMISSION_FAILURE);
    const afterExpiry = await storage.transaction((transaction) => ({
      grant: transaction.findGrantById(grant.grantId),
      audit: transaction.listGrantAudit(grant.grantId),
    }));
    const priorIds = new Set(beforeExpiry.map((audit) => audit.auditId));
    const newlyAdded = afterExpiry.audit.filter((audit) => !priorIds.has(audit.auditId));
    expect(newlyAdded.map((audit) => audit.action)).toEqual(["grant-expired"]);
    expect(
      afterExpiry.audit.filter((audit) => audit.action === "grant-code-erased-expiry"),
    ).toHaveLength(0);
    expect(
      afterExpiry.audit.filter((audit) => audit.action === "grant-code-erased-game-lock"),
    ).toHaveLength(1);
    expect(afterExpiry.grant?.status).toBe("expired");
    expect(afterExpiry.grant?.code?.state).toBe("erased");
    expect(await storage.readiness()).toMatchObject({ ok: true });
  });

  test("expires Code-first access and clears binding-bound Codes on lifecycle changes", async () => {
    let nowMs = 1_000;
    const storage = createInMemoryFoundationStorage();
    const options = createOptions({
      resolve: () => ({ status: "eligible" as const, eventGameId: "game-binding" }),
      resolveEventGameLock: () => ({ eventGameId: "game-binding", apply: () => {} }),
    });
    options.clock = { nowMs: () => nowMs };
    const authority = createTypedGrantAuthority(storage, options);
    const admin = await authority.createEventAdminGrant({
      authority: { kind: "technical-admin", id: "tech" },
      scope: { eventId: "event-binding", eventTimeZone: "UTC", finalGameDayDate: "2026-03-20" },
    });
    if (admin.status !== "created") throw new Error("Expected Event Admin Grant.");
    const adminSession = await authority.admitGrant({
      qrCredential: admin.qrCredential,
      browserContext: "binding-admin",
    });
    if (adminSession.status !== "admitted") throw new Error("Expected Event Admin Session.");
    const management = {
      kind: "grant-session" as const,
      sessionBearer: adminSession.sessionBearer,
    };

    const expiring = await authority.createControlGrant({
      authority: management,
      scope: {
        eventId: "event-binding",
        gameDayId: "day-binding",
        pitchId: "pitch-expiring",
        pitchSlotId: "slot-expiring",
      },
      expiresAtMs: 1_100,
    });
    if (expiring.status !== "created") throw new Error("Expected expiring Control Grant.");
    const expiringCode = await authority.createGrantCode(expiring.grantId, management);
    if (expiringCode.status !== "created") throw new Error("Expected expiring Grant Code.");
    nowMs = 1_100;
    expect(
      await authority.admitGrantCode({
        grantCode: expiringCode.code,
        browserContext: "expired-code-first",
      }),
    ).toEqual(GENERIC_GRANT_ADMISSION_FAILURE);
    const expiredState = await storage.transaction((transaction) => ({
      grant: transaction.findGrantById(expiring.grantId),
      audit: transaction.listGrantAudit(expiring.grantId),
    }));
    expect(expiredState.grant).toMatchObject({ status: "expired", code: { state: "erased" } });
    expect(expiredState.audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "grant-expired" }),
        expect.objectContaining({
          action: "grant-code-erased-expiry",
          codeStateBefore: "present",
          codeState: "erased",
        }),
      ]),
    );

    nowMs = 1_000;
    const reactivated = await authority.createControlGrant({
      authority: management,
      scope: {
        eventId: "event-binding",
        gameDayId: "day-binding",
        pitchId: "pitch-reactivation",
        pitchSlotId: "slot-reactivation",
      },
    });
    if (reactivated.status !== "created") throw new Error("Expected reactivation Grant.");
    const reactivationCode = await authority.createGrantCode(reactivated.grantId, management);
    if (reactivationCode.status !== "created") throw new Error("Expected reactivation Code.");
    expect(await authority.disableGrant(reactivated.grantId, management)).toMatchObject({
      status: "updated",
    });
    expect(await authority.reactivateGrant(reactivated.grantId, management)).toMatchObject({
      status: "updated",
    });
    expect(
      await authority.admitGrantCode({
        grantCode: reactivationCode.code,
        browserContext: "old-reactivation-code",
      }),
    ).toEqual(GENERIC_GRANT_ADMISSION_FAILURE);
    const reactivatedState = await storage.transaction((transaction) => ({
      grant: transaction.findGrantById(reactivated.grantId),
      audit: transaction.listGrantAudit(reactivated.grantId),
    }));
    expect(reactivatedState.grant).toMatchObject({ status: "active", code: { state: "disabled" } });
    expect(reactivatedState.audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "grant-code-disabled",
          codeStateBefore: "present",
          codeState: "disabled",
        }),
        expect.objectContaining({ action: "grant-reactivated" }),
      ]),
    );

    const pitch = await authority.createPitchManagerGrant({
      authority: management,
      scope: {
        eventId: "event-binding",
        gameDayId: "day-binding",
        gameDayDate: "2026-03-20",
        eventTimeZone: "UTC",
        pitchId: "pitch-metadata",
      },
    });
    if (pitch.status !== "created") throw new Error("Expected Pitch Manager Grant.");
    const metadataCode = await authority.createGrantCode(pitch.grantId, management);
    if (metadataCode.status !== "created") throw new Error("Expected metadata Grant Code.");
    const beforeMetadata = await storage.transaction((transaction) =>
      transaction.findGrantById(pitch.grantId),
    );
    expect(
      await authority.recalculateGrantExpiry(
        pitch.grantId,
        { gameDayDate: "2026-03-21" },
        management,
      ),
    ).toMatchObject({ status: "updated" });
    expect(
      await authority.admitGrantCode({
        grantCode: metadataCode.code,
        browserContext: "old-metadata-code",
      }),
    ).toEqual(GENERIC_GRANT_ADMISSION_FAILURE);
    const metadataState = await storage.transaction((transaction) => ({
      grant: transaction.findGrantById(pitch.grantId),
      audit: transaction.listGrantAudit(pitch.grantId),
    }));
    expect(metadataState.grant).toMatchObject({
      status: "active",
      code: { state: "disabled" },
      scope: { gameDayDate: "2026-03-21" },
    });
    expect(metadataState.grant?.grantVersion).not.toBe(beforeMetadata?.grantVersion);
    expect(metadataState.audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "grant-code-disabled",
          codeStateBefore: "present",
          codeState: "disabled",
        }),
        expect.objectContaining({ action: "grant-metadata-updated" }),
      ]),
    );

    const due = await authority.createControlGrant({
      authority: management,
      scope: {
        eventId: "event-binding",
        gameDayId: "day-binding",
        pitchId: "pitch-due-lock",
        pitchSlotId: "slot-due-lock",
      },
      expiresAtMs: 1_100,
    });
    const notDue = await authority.createControlGrant({
      authority: management,
      scope: {
        eventId: "event-binding",
        gameDayId: "day-binding",
        pitchId: "pitch-not-due-lock",
        pitchSlotId: "slot-not-due-lock",
      },
      expiresAtMs: 1_200,
    });
    if (due.status !== "created" || notDue.status !== "created")
      throw new Error("Expected neighboring lock Grants.");
    const dueCode = await authority.createGrantCode(due.grantId, management);
    const notDueCode = await authority.createGrantCode(notDue.grantId, management);
    if (dueCode.status !== "created" || notDueCode.status !== "created")
      throw new Error("Expected neighboring lock Codes.");
    nowMs = 1_100;
    expect(await lockControlGrantEventGame(storage, options, { accepted: true })).toMatchObject({
      status: "locked",
    });
    const lockState = await storage.transaction((transaction) => ({
      due: transaction.findGrantById(due.grantId),
      dueAudit: transaction.listGrantAudit(due.grantId),
      notDue: transaction.findGrantById(notDue.grantId),
      notDueAudit: transaction.listGrantAudit(notDue.grantId),
    }));
    expect(lockState.due).toMatchObject({ status: "expired", code: { state: "erased" } });
    expect(lockState.dueAudit).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "grant-expired" })]),
    );
    expect(lockState.dueAudit.some((audit) => audit.action === "grant-code-erased-game-lock")).toBe(
      false,
    );
    expect(lockState.notDue).toMatchObject({ status: "active", code: { state: "erased" } });
    expect(lockState.notDueAudit).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "grant-code-erased-game-lock" })]),
    );
    expect(await storage.readiness()).toMatchObject({ ok: true });
  });

  test("does not emit a second Code erasure for already-erased material", () => {
    const options = { ...createOptions(), clock: { nowMs: () => 1_100 } };
    const code = {
      state: "erased" as const,
      formatVersion: 1 as const,
      kind: "manual-code" as const,
      encryptionKeyVersion: null,
      lookupKeyVersion: null,
      iv: null,
      ciphertext: null,
      tag: null,
      lookupDigest: null,
      fingerprint: "A".repeat(43),
    };
    const grant: StoredGrant = {
      grantId: "grant-erased-code",
      grantType: "control",
      grantVersion: "grant-version-erased-code",
      scope: {
        eventId: "event-erased-code",
        gameDayId: "day-erased-code",
        pitchId: "pitch-erased-code",
        pitchSlotId: "slot-erased-code",
      },
      status: "active",
      createdAtMs: 1,
      expiresAtMs: 1_100,
      credential: {
        materialState: "present",
        formatVersion: 1,
        kind: "qr",
        encryptionKeyVersion: "encryption-v1",
        lookupKeyVersion: "lookup-v1",
        iv: "A".repeat(16),
        ciphertext: "A",
        tag: "A".repeat(22),
        lookupDigest: "A".repeat(43),
        fingerprint: "A".repeat(43),
      },
      code,
    };
    const audits: Array<{ action: string }> = [];
    let updated: StoredGrant | null = null;
    const transaction = {
      updateGrant: (value: StoredGrant) => {
        updated = value;
      },
      listGrantSessions: () => [],
      appendGrantAudit: (entry: { action: string }) => {
        audits.push(entry);
      },
    } as unknown as FoundationStorageTransaction;

    const expired = expireGrantIfDue(transaction, options, {
      ...grant,
      code: eraseGrantCode(code, "erased"),
    });
    expect(expired.status).toBe("expired");
    expect(updated).toEqual(expect.objectContaining({ status: "expired" }));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe("grant-expired");
  });

  test("throttles malformed and failed attempts privately after the bounded budget", async () => {
    const storage = createInMemoryFoundationStorage();
    const authority = createTypedGrantAuthority(storage, createOptions());
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        await authority.admitGrantCode({ grantCode: "bad", browserContext: "source-a" }),
      ).toEqual(GENERIC_GRANT_ADMISSION_FAILURE);
    }
    expect(
      await authority.admitGrantCode({ grantCode: "bad", browserContext: "source-a" }),
    ).toMatchObject({ status: "rejected", code: "grant-admission-throttled", retryAfterMs: 1_000 });
    expect(
      await authority.admitGrantCode({ grantCode: "bad", browserContext: "source-a" }),
    ).toMatchObject({
      status: "rejected",
      code: "grant-admission-throttled",
    });
    expect(
      await authority.admitGrantCode({ grantCode: "bad", browserContext: "source-b" }),
    ).toEqual(GENERIC_GRANT_ADMISSION_FAILURE);
    expect(
      await authority.admitGrantCode({ grantCode: "bad", browserContext: 123 as never }),
    ).toEqual(GENERIC_GRANT_ADMISSION_FAILURE);

    const invalidDigest = sourceDigest(createOptions(), 123);
    expect(invalidDigest).toBe(sourceDigest(createOptions(), "x".repeat(129)));
    const telemetry = await storage.transaction((transaction) =>
      transaction.readGrantAdmissionTelemetry?.("code", invalidDigest),
    );
    expect(telemetry?.failedAttempts).toBeGreaterThan(0);
  });

  test("keeps long-lived source failures below the global ceiling and preserves readiness", async () => {
    let nowMs = 1_000;
    const storage = createInMemoryFoundationStorage();
    const authority = createTypedGrantAuthority(storage, {
      ...createOptions(),
      clock: { nowMs: () => nowMs },
    });
    for (let attempt = 0; attempt < 121; attempt += 1) {
      expect(
        await authority.admitGrantCode({
          grantCode: "bad",
          browserContext: `long-lived-source-${attempt}`,
        }),
      ).toEqual(GENERIC_GRANT_ADMISSION_FAILURE);
      nowMs += 60_001;
    }
    expect(await storage.readiness()).toMatchObject({ ok: true });
  });

  test("accepts QR admission attempts through 600 and throttles only the 601st", async () => {
    const storage = createInMemoryFoundationStorage();
    const options = createOptions();
    storage.setGrantKeyRing?.(options.keyRing);
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const result = await storage.transaction((transaction) =>
        beginAdmission(transaction, options, "qr", `qr-boundary-${attempt}`, 1_000),
      );
      expect(result.throttle).toBeNull();
    }
    const throttled = await storage.transaction((transaction) =>
      beginAdmission(transaction, options, "qr", "qr-boundary-601", 1_000),
    );
    expect(throttled.throttle).toMatchObject({
      status: "rejected",
      code: "grant-admission-throttled",
    });
    expect(await storage.readiness()).toMatchObject({ ok: true });
  });

  test("freezes the empty memory adapter after raw admission-anchor deletion", async () => {
    const storage = createInMemoryFoundationStorage();
    const options = createOptions();
    storage.setGrantKeyRing?.(options.keyRing);
    expect(await storage.readiness()).toMatchObject({ ok: true });
    const internal = storage as unknown as {
      state: { grantAdmissionStateAnchor: unknown };
    };
    internal.state.grantAdmissionStateAnchor = null;
    expect(await storage.readiness()).toMatchObject({ ok: false, status: "integrity-failure" });
  });

  test("preflights every Game-Lock Grant and fails closed without partial mutation", async () => {
    const storage = createInMemoryFoundationStorage();
    let resolutionMode: "normal" | "throw" | "conflict" | "missing" | "past-day" | "switch" =
      "normal";
    let lockApplied = false;
    const options = createOptions({
      resolve: (scope) => {
        if (resolutionMode === "throw") throw new Error("resolver failed");
        if (resolutionMode === "conflict") return { status: "conflict" as const };
        if (resolutionMode === "missing")
          return { status: "terminal" as const, reason: "game-locked" as const };
        if (resolutionMode === "past-day" && scope.pitchId === "second")
          return {
            status: "terminal" as const,
            reason: "past-game-day" as const,
            eventGameId: "game-lock",
          };
        if (resolutionMode === "switch" && scope.pitchId === "second")
          return {
            status: "terminal" as const,
            reason: "accepted-game-switch" as const,
            eventGameId: "game-lock",
          };
        return {
          status: "eligible" as const,
          eventGameId: scope.pitchId === "first" ? "game-lock" : "other-game",
        };
      },
      resolveEventGameLock: () => ({
        eventGameId: "game-lock",
        apply: () => {
          lockApplied = true;
        },
      }),
    });
    const authority = createTypedGrantAuthority(storage, options);
    const admin = await authority.createEventAdminGrant({
      authority: { kind: "technical-admin", id: "tech" },
      scope: { eventId: "event-code", eventTimeZone: "UTC", finalGameDayDate: "2026-03-20" },
    });
    if (admin.status !== "created") throw new Error("Expected Event Admin Grant.");
    const adminSession = await authority.admitGrant({
      qrCredential: admin.qrCredential,
      browserContext: "multi-lock-admin",
    });
    if (adminSession.status !== "admitted") throw new Error("Expected Event Admin Session.");
    const makeGrant = async (pitchId: string, browserContext: string) => {
      const grant = await authority.createControlGrant({
        authority: { kind: "grant-session", sessionBearer: adminSession.sessionBearer },
        scope: {
          eventId: "event-code",
          gameDayId: "day-code",
          pitchId,
          pitchSlotId: `${pitchId}-slot`,
        },
      });
      if (grant.status !== "created") throw new Error("Expected Control Grant.");
      const code = await authority.createGrantCode(grant.grantId, {
        kind: "grant-session",
        sessionBearer: adminSession.sessionBearer,
      });
      if (code.status !== "created") throw new Error("Expected Grant Code.");
      const session = await authority.admitGrantCode({ grantCode: code.code, browserContext });
      if (session.status !== "admitted") throw new Error("Expected Control Session.");
      return { grantId: grant.grantId, code: code.code };
    };
    const first = await makeGrant("first", "multi-lock-first");
    const second = await makeGrant("second", "multi-lock-second");
    const snapshot = () =>
      storage.transaction((transaction) => ({
        firstGrant: transaction.findGrantById(first.grantId),
        secondGrant: transaction.findGrantById(second.grantId),
        firstSessions: transaction.listGrantSessions(first.grantId),
        secondSessions: transaction.listGrantSessions(second.grantId),
        firstAudit: transaction.listGrantAudit(first.grantId),
        secondAudit: transaction.listGrantAudit(second.grantId),
      }));

    resolutionMode = "throw";
    const beforeThrow = await snapshot();
    expect(await lockControlGrantEventGame(storage, options, { accepted: true })).toEqual({
      status: "rejected",
      reason: "unavailable",
    });
    expect(await snapshot()).toEqual(beforeThrow);
    expect(lockApplied).toBe(false);

    resolutionMode = "conflict";
    const beforeConflict = await snapshot();
    expect(await lockControlGrantEventGame(storage, options, { accepted: true })).toEqual({
      status: "rejected",
      reason: "unavailable",
    });
    expect(await snapshot()).toEqual(beforeConflict);
    expect(lockApplied).toBe(false);

    resolutionMode = "missing";
    const beforeMissing = await snapshot();
    expect(await lockControlGrantEventGame(storage, options, { accepted: true })).toEqual({
      status: "rejected",
      reason: "unavailable",
    });
    expect(await snapshot()).toEqual(beforeMissing);

    for (const rejectedMode of ["past-day", "switch"] as const) {
      resolutionMode = rejectedMode;
      const beforeRejectedTerminal = await snapshot();
      expect(await lockControlGrantEventGame(storage, options, { accepted: true })).toEqual({
        status: "rejected",
        reason: "unavailable",
      });
      expect(await snapshot()).toEqual(beforeRejectedTerminal);
      expect(lockApplied).toBe(false);
    }

    resolutionMode = "normal";
    expect(await lockControlGrantEventGame(storage, options, { accepted: true })).toMatchObject({
      status: "locked",
      eventGameId: "game-lock",
    });
    const after = await snapshot();
    expect(after.firstGrant?.code?.state).toBe("erased");
    expect(after.secondGrant?.code?.state).toBe("present");
  });

  test("authorizes management scope before invoking the target admission resolver", async () => {
    let resolverCalls = 0;
    const storage = createInMemoryFoundationStorage();
    const options = createOptions({
      resolve: () => {
        resolverCalls += 1;
        return { status: "eligible" as const, eventGameId: "game-code" };
      },
    });
    const authority = createTypedGrantAuthority(storage, options);
    const targetAdmin = await authority.createEventAdminGrant({
      authority: { kind: "technical-admin", id: "tech" },
      scope: { eventId: "target-event", eventTimeZone: "UTC", finalGameDayDate: "2026-03-20" },
    });
    const otherAdmin = await authority.createEventAdminGrant({
      authority: { kind: "technical-admin", id: "tech" },
      scope: { eventId: "other-event", eventTimeZone: "UTC", finalGameDayDate: "2026-03-20" },
    });
    if (targetAdmin.status !== "created" || otherAdmin.status !== "created")
      throw new Error("Expected Event Admin Grants.");
    const targetSession = await authority.admitGrant({
      qrCredential: targetAdmin.qrCredential,
      browserContext: "target-admin",
    });
    const otherSession = await authority.admitGrant({
      qrCredential: otherAdmin.qrCredential,
      browserContext: "other-admin",
    });
    if (targetSession.status !== "admitted" || otherSession.status !== "admitted")
      throw new Error("Expected Event Admin Sessions.");
    const target = await authority.createControlGrant({
      authority: { kind: "grant-session", sessionBearer: targetSession.sessionBearer },
      scope: {
        eventId: "target-event",
        gameDayId: "day-code",
        pitchId: "pitch-code",
        pitchSlotId: "slot-code",
      },
    });
    if (target.status !== "created") throw new Error("Expected Control Grant.");
    resolverCalls = 0;
    const outOfScope = {
      kind: "grant-session" as const,
      sessionBearer: otherSession.sessionBearer,
    };
    expect(await authority.createGrantCode(target.grantId, outOfScope)).toMatchObject({
      status: "rejected",
      reason: "unauthorized",
    });
    expect(await authority.replaceGrantCode(target.grantId, outOfScope)).toMatchObject({
      status: "rejected",
      reason: "unauthorized",
    });
    expect(await authority.rotateGrant(target.grantId, outOfScope)).toMatchObject({
      status: "rejected",
      reason: "unauthorized",
    });
    expect(resolverCalls).toBe(0);
  });

  test("locks Control sessions and erases the active code atomically without reviving it", async () => {
    const storage = createInMemoryFoundationStorage();
    let failLock = false;
    const options = createOptions({
      resolve: () => ({ status: "eligible" as const, eventGameId: "game-code" }),
      resolveEventGameLock: () => ({
        eventGameId: "game-code",
        apply: () => {
          if (failLock) throw new Error("lock transition failed");
        },
      }),
    });
    const authority = createTypedGrantAuthority(storage, options);
    const admin = await authority.createEventAdminGrant({
      authority: { kind: "technical-admin", id: "tech" },
      scope: { eventId: "event-code", eventTimeZone: "UTC", finalGameDayDate: "2026-03-20" },
    });
    if (admin.status !== "created") throw new Error("Expected Event Admin Grant.");
    const adminSession = await authority.admitGrant({
      qrCredential: admin.qrCredential,
      browserContext: "lock-admin",
    });
    if (adminSession.status !== "admitted") throw new Error("Expected Event Admin Session.");
    const grant = await authority.createControlGrant({
      authority: { kind: "grant-session", sessionBearer: adminSession.sessionBearer },
      scope: {
        eventId: "event-code",
        gameDayId: "day-code",
        pitchId: "pitch-code",
        pitchSlotId: "slot-code",
      },
    });
    if (grant.status !== "created") throw new Error("Expected Control Grant.");
    const code = await authority.createGrantCode(grant.grantId, {
      kind: "grant-session",
      sessionBearer: adminSession.sessionBearer,
    });
    if (code.status !== "created") throw new Error("Expected Grant Code.");
    const session = await authority.admitGrantCode({
      grantCode: code.code,
      browserContext: "lock-controller-replaced",
    });
    if (session.status !== "admitted") throw new Error("Expected code session.");
    const replaced = await authority.admitGrantCode({
      grantCode: code.code,
      browserContext: "lock-controller-replaced",
    });
    if (replaced.status !== "admitted") throw new Error("Expected replaced code session.");
    expect(await authority.leaveGrantSession(replaced.sessionBearer)).toMatchObject({
      status: "updated",
    });
    const freshSessionBeforeLock = await authority.admitGrantCode({
      grantCode: code.code,
      browserContext: "lock-controller-fresh",
    });
    if (freshSessionBeforeLock.status !== "admitted")
      throw new Error("Expected fresh code session.");

    const locked = await lockControlGrantEventGame(storage, options, { accepted: true });
    expect(locked).toEqual({
      status: "locked",
      eventGameId: "game-code",
      terminatedSessionCount: 1,
    });
    const lockedState = await storage.transaction((transaction) => ({
      grant: transaction.findGrantById(grant.grantId),
      sessions: transaction.listGrantSessions(grant.grantId),
      audit: transaction.listGrantAudit(grant.grantId),
    }));
    expect(lockedState.grant?.code).toMatchObject({
      state: "erased",
      ciphertext: null,
      lookupDigest: null,
    });
    expect(lockedState.sessions).toHaveLength(3);
    expect(lockedState.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "expired", bearerMaterialState: "erased" }),
        expect.objectContaining({ status: "revoked" }),
      ]),
    );
    expect(lockedState.audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "grant-code-erased-game-lock",
          credentialFingerprint: lockedState.grant?.code?.fingerprint,
          codeState: "erased",
        }),
      ]),
    );
    const lockAudit = lockedState.audit.find(
      (audit) => audit.action === "grant-code-erased-game-lock",
    );
    if (lockedState.grant === null || lockAudit === undefined)
      throw new Error("Expected Game-Lock evidence.");
    const gameLockTermination = lockedState.audit.find(
      (audit) => audit.action === "session-terminated" && audit.terminalReason === "game-locked",
    );
    if (gameLockTermination === undefined)
      throw new Error("Expected Game-Lock session termination evidence.");
    const validationContext = { environmentId: options.environmentId, keyRing: options.keyRing };
    expect(
      validateGrantState(
        [lockedState.grant],
        lockedState.sessions,
        lockedState.audit,
        validationContext,
      ),
    ).toBeNull();
    const malformed = structuredClone(lockAudit);
    malformed.previousCodeFingerprint = "malformed-code-fingerprint";
    expect(
      validateGrantState(
        [lockedState.grant],
        lockedState.sessions,
        [...lockedState.audit.filter((audit) => audit.auditId !== lockAudit.auditId), malformed],
        validationContext,
      ),
    ).not.toBeNull();
    expect(
      validateGrantState(
        [lockedState.grant],
        lockedState.sessions,
        lockedState.audit.filter((audit) => audit.auditId !== gameLockTermination.auditId),
        validationContext,
      ),
    ).not.toBeNull();
    const extraGameLockTermination = {
      ...structuredClone(gameLockTermination),
      auditId: "extra-game-lock-termination",
    };
    expect(
      validateGrantState(
        [lockedState.grant],
        lockedState.sessions,
        [...lockedState.audit, extraGameLockTermination],
        validationContext,
      ),
    ).not.toBeNull();
    expect(
      validateGrantState(
        [lockedState.grant],
        lockedState.sessions,
        lockedState.audit.filter((audit) => audit.auditId !== lockAudit.auditId),
        validationContext,
      ),
    ).not.toBeNull();
    const extra = { ...structuredClone(lockAudit), auditId: "extra-game-lock-evidence" };
    expect(
      validateGrantState(
        [lockedState.grant],
        lockedState.sessions,
        [...lockedState.audit, extra],
        validationContext,
      ),
    ).not.toBeNull();
    expect(
      await authority.admitGrantCode({ grantCode: code.code, browserContext: "old-code" }),
    ).toEqual(GENERIC_GRANT_ADMISSION_FAILURE);

    const fresh = await authority.createGrantCode(grant.grantId, {
      kind: "grant-session",
      sessionBearer: adminSession.sessionBearer,
    });
    expect(fresh.status).toBe("created");
    if (fresh.status !== "created") throw new Error("Expected a fresh post-reopen code.");
    const freshSession = await authority.admitGrantCode({
      grantCode: fresh.code,
      browserContext: "lock-controller-second-cycle",
    });
    expect(freshSession.status).toBe("admitted");
    expect(await lockControlGrantEventGame(storage, options, { accepted: true })).toEqual({
      status: "locked",
      eventGameId: "game-code",
      terminatedSessionCount: 1,
    });
    const secondLockedState = await storage.transaction((transaction) => ({
      grant: transaction.findGrantById(grant.grantId),
      sessions: transaction.listGrantSessions(grant.grantId),
      audit: transaction.listGrantAudit(grant.grantId),
    }));
    expect(secondLockedState.grant?.code).toMatchObject({ state: "erased", ciphertext: null });
    expect(
      validateGrantState(
        [secondLockedState.grant!],
        secondLockedState.sessions,
        secondLockedState.audit,
        validationContext,
      ),
    ).toBeNull();
    const secondLockAudits = secondLockedState.audit.filter(
      (audit) => audit.action === "grant-code-erased-game-lock",
    );
    expect(secondLockAudits).toHaveLength(2);
    const secondLock = secondLockAudits[1];
    if (secondLock === undefined) throw new Error("Expected second Game-Lock evidence.");
    expect(
      validateGrantState(
        [secondLockedState.grant!],
        secondLockedState.sessions,
        secondLockedState.audit.filter((audit) => audit.auditId !== secondLock.auditId),
        validationContext,
      ),
    ).not.toBeNull();

    const third = await authority.createGrantCode(grant.grantId, {
      kind: "grant-session",
      sessionBearer: adminSession.sessionBearer,
    });
    expect(third.status).toBe("created");
    const beforeFailure = await storage.transaction((transaction) => ({
      grant: transaction.findGrantById(grant.grantId),
      sessions: transaction.listGrantSessions(grant.grantId),
      audit: transaction.listGrantAudit(grant.grantId),
    }));
    failLock = true;
    expect(await lockControlGrantEventGame(storage, options, { accepted: true })).toEqual({
      status: "rejected",
      reason: "unavailable",
    });
    expect(
      await storage.transaction((transaction) => ({
        grant: transaction.findGrantById(grant.grantId),
        sessions: transaction.listGrantSessions(grant.grantId),
        audit: transaction.listGrantAudit(grant.grantId),
      })),
    ).toEqual(beforeFailure);
  });

  test("replays switch-away and switch-in bindings before Game-Lock", async () => {
    for (const direction of ["away", "in"] as const) {
      const storage = createInMemoryFoundationStorage();
      let currentEventGame = direction === "away" ? "game-lock" : "game-other";
      const options = createOptions({
        resolve: () => ({ status: "eligible" as const, eventGameId: currentEventGame }),
        resolveSession: (_scope, sessionEventGameId) =>
          direction === "away" && sessionEventGameId === "game-lock"
            ? {
                status: "switchable" as const,
                previousEventGameId: "game-lock",
                currentEventGameId: "game-other",
              }
            : direction === "in" && sessionEventGameId === "game-other"
              ? {
                  status: "switchable" as const,
                  previousEventGameId: "game-other",
                  currentEventGameId: "game-lock",
                }
              : { status: "current" as const, eventGameId: sessionEventGameId },
        resolveEventGameLock: () => ({ eventGameId: "game-lock", apply: () => {} }),
      });
      const authority = createTypedGrantAuthority(storage, options);
      const admin = await authority.createEventAdminGrant({
        authority: { kind: "technical-admin", id: "tech" },
        scope: { eventId: "event-switch", eventTimeZone: "UTC", finalGameDayDate: "2026-03-20" },
      });
      if (admin.status !== "created") throw new Error("Expected Event Admin Grant.");
      const adminSession = await authority.admitGrant({
        qrCredential: admin.qrCredential,
        browserContext: `switch-${direction}-admin`,
      });
      if (adminSession.status !== "admitted") throw new Error("Expected Event Admin Session.");
      const grant = await authority.createControlGrant({
        authority: { kind: "grant-session", sessionBearer: adminSession.sessionBearer },
        scope: {
          eventId: "event-switch",
          gameDayId: "day-switch",
          pitchId: `pitch-${direction}`,
          pitchSlotId: `slot-${direction}`,
        },
      });
      if (grant.status !== "created") throw new Error("Expected Control Grant.");
      const code = await authority.createGrantCode(grant.grantId, {
        kind: "grant-session",
        sessionBearer: adminSession.sessionBearer,
      });
      if (code.status !== "created") throw new Error("Expected Grant Code.");
      const session = await authority.admitGrantCode({
        grantCode: code.code,
        browserContext: `switch-${direction}-controller`,
      });
      if (session.status !== "admitted") throw new Error("Expected Control Session.");
      if (direction === "in") currentEventGame = "game-lock";
      expect(
        await authority.authorizeGrant({
          sessionBearer: session.sessionBearer,
          eventGameId: direction === "away" ? "game-other" : "game-lock",
        }),
      ).toMatchObject({ status: "switch-required" });
      expect(
        await authority.acceptControlGrantSessionSwitch({ sessionBearer: session.sessionBearer }),
      ).toMatchObject({
        status: "switched",
        eventGameId: direction === "away" ? "game-other" : "game-lock",
      });
      const locked = await lockControlGrantEventGame(storage, options, { accepted: true });
      expect(locked).toMatchObject({
        status: "locked",
        terminatedSessionCount: direction === "away" ? 0 : 1,
      });
      const state = await storage.transaction((transaction) => ({
        grant: transaction.findGrantById(grant.grantId),
        sessions: transaction.listGrantSessions(grant.grantId),
        audit: transaction.listGrantAudit(grant.grantId),
      }));
      expect(
        validateGrantState([state.grant!], state.sessions, state.audit, {
          environmentId: options.environmentId,
          keyRing: options.keyRing,
        }),
      ).toBeNull();
      expect(state.grant?.code?.state).toBe("erased");
      expect(state.sessions[0]).toMatchObject({
        status: direction === "away" ? "active" : "expired",
        eventGameId: direction === "away" ? "game-other" : "game-lock",
      });
    }
  });

  test("keeps a pinned Game-A session active when reassigned Game B locks", async () => {
    const storage = createInMemoryFoundationStorage();
    let currentEventGame = "game-a";
    const options = createOptions({
      resolve: () => ({ status: "eligible" as const, eventGameId: currentEventGame }),
      resolveSession: (_scope, sessionEventGameId) =>
        sessionEventGameId === "game-a"
          ? {
              status: "pinned" as const,
              sessionEventGameId: "game-a",
              currentEventGameId: "game-b",
            }
          : { status: "current" as const, eventGameId: sessionEventGameId },
      resolveEventGameLock: () => ({ eventGameId: "game-b", apply: () => {} }),
    });
    const authority = createTypedGrantAuthority(storage, options);
    const admin = await authority.createEventAdminGrant({
      authority: { kind: "technical-admin", id: "tech" },
      scope: {
        eventId: "event-reassignment",
        eventTimeZone: "UTC",
        finalGameDayDate: "2026-03-20",
      },
    });
    if (admin.status !== "created") throw new Error("Expected Event Admin Grant.");
    const adminSession = await authority.admitGrant({
      qrCredential: admin.qrCredential,
      browserContext: "reassignment-admin",
    });
    if (adminSession.status !== "admitted") throw new Error("Expected Event Admin Session.");
    const grant = await authority.createControlGrant({
      authority: { kind: "grant-session", sessionBearer: adminSession.sessionBearer },
      scope: {
        eventId: "event-reassignment",
        gameDayId: "day-reassignment",
        pitchId: "pitch-reassignment",
        pitchSlotId: "slot-reassignment",
      },
    });
    if (grant.status !== "created") throw new Error("Expected Control Grant.");
    const code = await authority.createGrantCode(grant.grantId, {
      kind: "grant-session",
      sessionBearer: adminSession.sessionBearer,
    });
    if (code.status !== "created") throw new Error("Expected Grant Code.");
    const session = await authority.admitGrantCode({
      grantCode: code.code,
      browserContext: "reassignment-controller",
    });
    if (session.status !== "admitted") throw new Error("Expected Control Session.");
    expect(
      await authority.authorizeGrant({
        sessionBearer: session.sessionBearer,
        eventGameId: "game-a",
        controlSessionDecision: "stay",
      }),
    ).toMatchObject({ status: "authorized", eventGameId: "game-a" });

    currentEventGame = "game-b";
    expect(await lockControlGrantEventGame(storage, options, { accepted: true })).toEqual({
      status: "locked",
      eventGameId: "game-b",
      terminatedSessionCount: 0,
    });
    const state = await storage.transaction((transaction) => ({
      grant: transaction.findGrantById(grant.grantId),
      sessions: transaction.listGrantSessions(grant.grantId),
      audit: transaction.listGrantAudit(grant.grantId),
    }));
    expect(state.grant?.code).toMatchObject({ state: "erased", ciphertext: null });
    expect(state.sessions[0]).toMatchObject({ status: "active", eventGameId: "game-a" });
    expect(
      await authority.authorizeGrant({
        sessionBearer: session.sessionBearer,
        eventGameId: "game-a",
        controlSessionDecision: "stay",
      }),
    ).toMatchObject({ status: "authorized", eventGameId: "game-a" });
    expect(
      validateGrantState([state.grant!], state.sessions, state.audit, {
        environmentId: options.environmentId,
        keyRing: options.keyRing,
      }),
    ).toBeNull();
  });

  test("terminates the active session after a same-version key rewrap", async () => {
    const storage = createInMemoryFoundationStorage();
    const options = createOptions({
      resolveEventGameLock: () => ({ eventGameId: "game-code", apply: () => {} }),
    });
    const authority = createTypedGrantAuthority(storage, options);
    const admin = await authority.createEventAdminGrant({
      authority: { kind: "technical-admin", id: "tech" },
      scope: { eventId: "event-rewrap", eventTimeZone: "UTC", finalGameDayDate: "2026-03-20" },
    });
    if (admin.status !== "created") throw new Error("Expected Event Admin Grant.");
    const adminSession = await authority.admitGrant({
      qrCredential: admin.qrCredential,
      browserContext: "rewrap-admin",
    });
    if (adminSession.status !== "admitted") throw new Error("Expected Event Admin Session.");
    const grant = await authority.createControlGrant({
      authority: { kind: "grant-session", sessionBearer: adminSession.sessionBearer },
      scope: { eventId: "event-rewrap", gameDayId: "day", pitchId: "pitch", pitchSlotId: "slot" },
    });
    if (grant.status !== "created") throw new Error("Expected Control Grant.");
    const code = await authority.createGrantCode(grant.grantId, {
      kind: "grant-session",
      sessionBearer: adminSession.sessionBearer,
    });
    if (code.status !== "created") throw new Error("Expected Grant Code.");
    const session = await authority.admitGrantCode({
      grantCode: code.code,
      browserContext: "rewrap-controller",
    });
    if (session.status !== "admitted") throw new Error("Expected Control Session.");
    expect(
      await authority.rotateGrantCredentialKeys(grant.grantId, {
        kind: "grant-session",
        sessionBearer: adminSession.sessionBearer,
      }),
    ).toMatchObject({ status: "updated", grantVersion: grant.grantVersion });
    expect(await lockControlGrantEventGame(storage, options, { accepted: true })).toMatchObject({
      status: "locked",
      terminatedSessionCount: 1,
    });
    const state = await storage.transaction((transaction) => ({
      grant: transaction.findGrantById(grant.grantId),
      sessions: transaction.listGrantSessions(grant.grantId),
      audit: transaction.listGrantAudit(grant.grantId),
    }));
    expect(state.sessions[0]).toMatchObject({ status: "expired", eventGameId: "game-code" });
    expect(state.grant?.code).toMatchObject({ state: "erased", ciphertext: null });
    expect(
      validateGrantState([state.grant!], state.sessions, state.audit, {
        environmentId: options.environmentId,
        keyRing: options.keyRing,
      }),
    ).toBeNull();
  });

  test("keeps disabled Grant sessions until Game-Lock terminates them", async () => {
    const storage = createInMemoryFoundationStorage();
    const options = createOptions({
      resolveEventGameLock: () => ({ eventGameId: "game-code", apply: () => {} }),
    });
    const authority = createTypedGrantAuthority(storage, options);
    const admin = await authority.createEventAdminGrant({
      authority: { kind: "technical-admin", id: "tech" },
      scope: { eventId: "event-disabled", eventTimeZone: "UTC", finalGameDayDate: "2026-03-20" },
    });
    if (admin.status !== "created") throw new Error("Expected Event Admin Grant.");
    const adminSession = await authority.admitGrant({
      qrCredential: admin.qrCredential,
      browserContext: "disabled-admin",
    });
    if (adminSession.status !== "admitted") throw new Error("Expected Event Admin Session.");
    const grant = await authority.createControlGrant({
      authority: { kind: "grant-session", sessionBearer: adminSession.sessionBearer },
      scope: { eventId: "event-disabled", gameDayId: "day", pitchId: "pitch", pitchSlotId: "slot" },
    });
    if (grant.status !== "created") throw new Error("Expected Control Grant.");
    const code = await authority.createGrantCode(grant.grantId, {
      kind: "grant-session",
      sessionBearer: adminSession.sessionBearer,
    });
    if (code.status !== "created") throw new Error("Expected Grant Code.");
    const session = await authority.admitGrantCode({
      grantCode: code.code,
      browserContext: "disabled-controller",
    });
    if (session.status !== "admitted") throw new Error("Expected Control Session.");
    expect(
      await authority.disableGrant(grant.grantId, {
        kind: "grant-session",
        sessionBearer: adminSession.sessionBearer,
      }),
    ).toMatchObject({ status: "updated" });
    expect(await lockControlGrantEventGame(storage, options, { accepted: true })).toMatchObject({
      status: "locked",
      terminatedSessionCount: 1,
    });
    const state = await storage.transaction((transaction) => ({
      grant: transaction.findGrantById(grant.grantId),
      sessions: transaction.listGrantSessions(grant.grantId),
      audit: transaction.listGrantAudit(grant.grantId),
    }));
    expect(state.grant?.status).toBe("disabled");
    expect(state.sessions[0]).toMatchObject({ status: "expired", eventGameId: "game-code" });
    expect(state.grant?.code).toMatchObject({ state: "erased", ciphertext: null });
    expect(
      validateGrantState([state.grant!], state.sessions, state.audit, {
        environmentId: options.environmentId,
        keyRing: options.keyRing,
      }),
    ).toBeNull();
  });

  test("requires live admission eligibility and a present code for replacement", async () => {
    let eligible = false;
    const storage = createInMemoryFoundationStorage();
    const options = createOptions({
      resolve: () =>
        eligible
          ? { status: "eligible" as const, eventGameId: "game-code" }
          : { status: "empty" as const },
    });
    const authority = createTypedGrantAuthority(storage, options);
    const admin = await authority.createEventAdminGrant({
      authority: { kind: "technical-admin", id: "tech" },
      scope: { eventId: "event-code", eventTimeZone: "UTC", finalGameDayDate: "2026-03-20" },
    });
    if (admin.status !== "created") throw new Error("Expected Event Admin Grant.");
    const session = await authority.admitGrant({
      qrCredential: admin.qrCredential,
      browserContext: "eligibility-admin",
    });
    if (session.status !== "admitted") throw new Error("Expected Event Admin Session.");
    const grant = await authority.createControlGrant({
      authority: { kind: "grant-session", sessionBearer: session.sessionBearer },
      scope: {
        eventId: "event-code",
        gameDayId: "day-code",
        pitchId: "pitch-code",
        pitchSlotId: "slot-code",
      },
    });
    if (grant.status !== "created") throw new Error("Expected Control Grant.");
    const before = await storage.transaction((transaction) => ({
      grant: transaction.findGrantById(grant.grantId),
      audit: transaction.listGrantAudit(grant.grantId),
    }));
    expect(
      await authority.createGrantCode(grant.grantId, {
        kind: "grant-session",
        sessionBearer: session.sessionBearer,
      }),
    ).toMatchObject({
      status: "rejected",
      reason: "invalid-state",
    });
    expect(
      await storage.transaction((transaction) => ({
        grant: transaction.findGrantById(grant.grantId),
        audit: transaction.listGrantAudit(grant.grantId),
      })),
    ).toEqual(before);

    eligible = true;
    const created = await authority.createGrantCode(grant.grantId, {
      kind: "grant-session",
      sessionBearer: session.sessionBearer,
    });
    if (created.status !== "created") throw new Error("Expected Grant Code.");
    await authority.disableGrantCode(grant.grantId, {
      kind: "grant-session",
      sessionBearer: session.sessionBearer,
    });
    expect(
      await authority.replaceGrantCode(grant.grantId, {
        kind: "grant-session",
        sessionBearer: session.sessionBearer,
      }),
    ).toMatchObject({ status: "rejected", reason: "invalid-state" });
  });

  test("returns one-time full rotation secrets and invalidates both old credentials", async () => {
    const storage = createInMemoryFoundationStorage();
    const options = createOptions();
    const authority = createTypedGrantAuthority(storage, options);
    const admin = await authority.createEventAdminGrant({
      authority: { kind: "technical-admin", id: "tech" },
      scope: { eventId: "event-code", eventTimeZone: "UTC", finalGameDayDate: "2026-03-20" },
    });
    if (admin.status !== "created") throw new Error("Expected Event Admin Grant.");
    const session = await authority.admitGrant({
      qrCredential: admin.qrCredential,
      browserContext: "rotation-admin",
    });
    if (session.status !== "admitted") throw new Error("Expected Event Admin Session.");
    const grant = await authority.createControlGrant({
      authority: { kind: "grant-session", sessionBearer: session.sessionBearer },
      scope: {
        eventId: "event-code",
        gameDayId: "day-code",
        pitchId: "pitch-code",
        pitchSlotId: "slot-code",
      },
    });
    if (grant.status !== "created") throw new Error("Expected Control Grant.");
    const oldCode = await authority.createGrantCode(grant.grantId, {
      kind: "grant-session",
      sessionBearer: session.sessionBearer,
    });
    if (oldCode.status !== "created") throw new Error("Expected Grant Code.");
    const oldQrSession = await authority.admitGrant({
      qrCredential: grant.qrCredential,
      browserContext: "old-qr",
    });
    const oldCodeSession = await authority.admitGrantCode({
      grantCode: oldCode.code,
      browserContext: "old-code",
    });
    if (oldQrSession.status !== "admitted" || oldCodeSession.status !== "admitted")
      throw new Error("Expected old credential sessions.");

    const beforeFailedRotation = await storage.transaction((transaction) => ({
      grant: transaction.findGrantById(grant.grantId),
      sessions: transaction.listGrantSessions(grant.grantId),
      audit: transaction.listGrantAudit(grant.grantId),
    }));
    const failingAuthority = createTypedGrantAuthority(storage, {
      ...options,
      randomness: {
        bytes() {
          throw new Error("rotation randomness failed");
        },
      },
    });
    expect(
      await failingAuthority.rotateGrant(grant.grantId, {
        kind: "grant-session",
        sessionBearer: session.sessionBearer,
      }),
    ).toMatchObject({ status: "rejected", reason: "unavailable" });
    expect(
      await storage.transaction((transaction) => ({
        grant: transaction.findGrantById(grant.grantId),
        sessions: transaction.listGrantSessions(grant.grantId),
        audit: transaction.listGrantAudit(grant.grantId),
      })),
    ).toEqual(beforeFailedRotation);

    const rotated = await authority.rotateGrant(grant.grantId, {
      kind: "grant-session",
      sessionBearer: session.sessionBearer,
    });
    if (
      rotated.status !== "updated" ||
      !("qrCredential" in rotated) ||
      rotated.qrCredential === undefined ||
      rotated.code === undefined
    )
      throw new Error("Expected one-time rotated credentials.");
    const newQrCredential = rotated.qrCredential;
    const newCode = rotated.code;
    expect(rotated).toMatchObject({
      status: "updated",
      qrCredential: expect.any(String),
      code: expect.any(String),
      oneTime: true,
      noStore: true,
    });
    const stored = await storage.transaction((transaction) =>
      transaction.findGrantById(grant.grantId),
    );
    expect(JSON.stringify(stored).includes(newQrCredential)).toBe(false);
    expect(JSON.stringify(stored).includes(newCode)).toBe(false);
    expect(
      await authority.admitGrant({ qrCredential: grant.qrCredential, browserContext: "old-qr-2" }),
    ).toEqual(GENERIC_GRANT_ADMISSION_FAILURE);
    expect(
      await authority.admitGrantCode({ grantCode: oldCode.code, browserContext: "old-code-2" }),
    ).toEqual(GENERIC_GRANT_ADMISSION_FAILURE);
    expect(
      await authority.authorizeGrant({
        sessionBearer: oldQrSession.sessionBearer,
        eventGameId: "game-code",
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      await authority.authorizeGrant({
        sessionBearer: oldCodeSession.sessionBearer,
        eventGameId: "game-code",
      }),
    ).toMatchObject({ status: "rejected" });
    const newQr = await authority.admitGrant({
      qrCredential: newQrCredential,
      browserContext: "new-qr",
    });
    expect(newQr).toMatchObject({ status: "admitted" });
    expect(
      await authority.admitGrantCode({ grantCode: newCode, browserContext: "new-code" }),
    ).toMatchObject({ status: "admitted" });
  });

  test("full rotation always returns both credentials for absent, disabled, and lock-erased Codes", async () => {
    const storage = createInMemoryFoundationStorage();
    const options = createOptions({
      resolve: () => ({ status: "eligible" as const, eventGameId: "game-code" }),
      resolveEventGameLock: () => ({ eventGameId: "game-code", apply: () => {} }),
    });
    const authority = createTypedGrantAuthority(storage, options);
    const admin = await authority.createEventAdminGrant({
      authority: { kind: "technical-admin", id: "tech" },
      scope: { eventId: "event-code", eventTimeZone: "UTC", finalGameDayDate: "2026-03-20" },
    });
    if (admin.status !== "created") throw new Error("Expected Event Admin Grant.");
    const session = await authority.admitGrant({
      qrCredential: admin.qrCredential,
      browserContext: "state-matrix-admin",
    });
    if (session.status !== "admitted") throw new Error("Expected Event Admin Session.");
    const grant = await authority.createControlGrant({
      authority: { kind: "grant-session", sessionBearer: session.sessionBearer },
      scope: {
        eventId: "event-code",
        gameDayId: "day-code",
        pitchId: "pitch-code",
        pitchSlotId: "slot-code",
      },
    });
    if (grant.status !== "created") throw new Error("Expected Control Grant.");
    const rotateAndAssert = async () => {
      const rotated = await authority.rotateGrant(grant.grantId, {
        kind: "grant-session",
        sessionBearer: session.sessionBearer,
      });
      if (
        rotated.status !== "updated" ||
        !("qrCredential" in rotated) ||
        rotated.code === undefined
      )
        throw new Error("Expected both rotated credentials.");
      expect(rotated.oneTime).toBe(true);
      expect(rotated.noStore).toBe(true);
      const stored = await storage.transaction((transaction) =>
        transaction.findGrantById(grant.grantId),
      );
      expect(stored?.code?.state).toBe("present");
      expect(JSON.stringify(stored)).not.toContain(rotated.qrCredential);
      expect(JSON.stringify(stored)).not.toContain(rotated.code);
      return rotated;
    };
    const absent = await rotateAndAssert();
    await authority.disableGrantCode(grant.grantId, {
      kind: "grant-session",
      sessionBearer: session.sessionBearer,
    });
    const rotatedFromDisabled = await rotateAndAssert();
    expect(
      await authority.admitGrantCode({ grantCode: absent.code!, browserContext: "old-absent" }),
    ).toEqual(GENERIC_GRANT_ADMISSION_FAILURE);
    expect(
      await authority.admitGrantCode({ grantCode: absent.code!, browserContext: "old-disabled" }),
    ).toEqual(GENERIC_GRANT_ADMISSION_FAILURE);
    expect(await lockControlGrantEventGame(storage, options, { accepted: true })).toMatchObject({
      status: "locked",
    });
    const erased = await rotateAndAssert();
    expect(
      await authority.admitGrantCode({
        grantCode: rotatedFromDisabled.code!,
        browserContext: "old-erased",
      }),
    ).toEqual(GENERIC_GRANT_ADMISSION_FAILURE);
    expect(erased.code).not.toBe(rotatedFromDisabled.code);
  });
});

async function useBudget(
  storage: ReturnType<typeof createInMemoryFoundationStorage>,
  options: ReturnType<typeof createOptions>,
  mode: GrantAdmissionMode,
  browserContext: string,
  recordFailure: boolean,
) {
  return storage.transaction((transaction) => {
    const budget = beginAdmission(
      transaction,
      options,
      mode,
      browserContext,
      options.clock.nowMs(),
    );
    if (budget.throttle === null && recordFailure)
      recordAdmissionFailure(transaction, mode, budget.sourceDigest, options.clock.nowMs());
    return budget.throttle;
  });
}

function createOptions(
  seedOrConfiguration:
    | number
    | {
        resolve?: GrantAuthorityOptions["controlScopeResolver"]["resolve"];
        resolveSession?: GrantAuthorityOptions["controlScopeResolver"]["resolveSession"];
        resolveEventGameLock?: NonNullable<
          GrantAuthorityOptions["controlGrantLifecycle"]
        >["resolveEventGameLock"];
      } = 811,
  nowMs = () => 1_000,
) {
  const seed = typeof seedOrConfiguration === "number" ? seedOrConfiguration : 811;
  const configuration = typeof seedOrConfiguration === "number" ? {} : seedOrConfiguration;
  return {
    environmentId: "test-environment",
    clock: { nowMs },
    randomness: createGrantTestRandomness(seed),
    keyRing: createGrantTestKeyRing(),
    controlScopeResolver: {
      resolve:
        configuration.resolve ??
        (() => ({ status: "eligible" as const, eventGameId: "game-code" })),
      ...(configuration.resolveSession === undefined
        ? {}
        : { resolveSession: configuration.resolveSession }),
    },
    controlGrantLifecycle:
      configuration.resolveEventGameLock === undefined
        ? undefined
        : { resolveEventGameLock: configuration.resolveEventGameLock },
    privilegedAuthorityVerifier: createGrantTestAuthorityVerifier(),
  };
}
