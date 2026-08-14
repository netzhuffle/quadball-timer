import { computeLookupDigest } from "@/lib/grant-crypto";
import {
  requireGrantStorageTransaction,
  type FoundationStorageTransaction,
} from "@/lib/foundation-storage";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import {
  GRANT_ADMISSION_GLOBAL_ATTEMPT_LIMITS,
  GRANT_ADMISSION_RETENTION_MS,
  GRANT_ADMISSION_SOURCE_FAILURE_SATURATION,
  GRANT_ADMISSION_WINDOW_MS,
  type GrantAdmissionMode,
  type GrantAdmissionTelemetry,
} from "@/lib/grant-types";
import { grantAdmissionThrottled } from "@/lib/grant-authority-types";
import { validateOpaqueIdentifier } from "@/lib/validation-policy";

export const GRANT_ADMISSION_SOURCE_FAILURE_LIMIT = 5;
export const GRANT_ADMISSION_GLOBAL_ATTEMPT_LIMIT = GRANT_ADMISSION_GLOBAL_ATTEMPT_LIMITS.code;
export const GRANT_ADMISSION_QR_SOURCE_BURST = 120;
export const GRANT_ADMISSION_QR_SOURCE_SUSTAINED_PER_MINUTE = 60;
export const GRANT_ADMISSION_QR_GLOBAL_ATTEMPT_LIMIT = GRANT_ADMISSION_GLOBAL_ATTEMPT_LIMITS.qr;
export const INVALID_ADMISSION_SOURCE = "invalid-grant-admission-source-v1";

export type AdmissionThrottle = ReturnType<typeof grantAdmissionThrottled> | null;

export function normalizeAdmissionSource(browserContext: unknown): string {
  if (
    typeof browserContext !== "string" ||
    browserContext.length > 128 ||
    !validateOpaqueIdentifier(browserContext, "browserContext").ok
  )
    return INVALID_ADMISSION_SOURCE;
  return browserContext;
}

export function sourceDigest(options: GrantAuthorityOptions, browserContext: unknown): string {
  const raw = normalizeAdmissionSource(browserContext);
  return computeLookupDigest(
    "grant-admission-source:" + raw,
    options.keyRing,
    options.keyRing.lookup.currentVersion,
  );
}

export function beginAdmission(
  transaction: FoundationStorageTransaction,
  options: GrantAuthorityOptions,
  mode: GrantAdmissionMode,
  browserContext: unknown,
  nowMs: number,
): { sourceDigest: string; throttle: AdmissionThrottle } {
  const grantTransaction = requireGrantStorageTransaction(transaction);
  const digest = sourceDigest(options, browserContext);
  grantTransaction.pruneGrantAdmissionTelemetry(nowMs - GRANT_ADMISSION_RETENTION_MS);
  const global = grantTransaction.readGrantAdmissionGlobalWindow(mode);
  const activeGlobal =
    global === null || nowMs - global.windowStartedAtMs >= GRANT_ADMISSION_WINDOW_MS
      ? { mode, windowStartedAtMs: nowMs, attemptCount: 0 }
      : global;
  if (activeGlobal.attemptCount >= GRANT_ADMISSION_GLOBAL_ATTEMPT_LIMITS[mode]) {
    return {
      sourceDigest: digest,
      throttle: grantAdmissionThrottled(
        Math.max(1, activeGlobal.windowStartedAtMs + GRANT_ADMISSION_WINDOW_MS - nowMs),
      ),
    };
  }
  grantTransaction.writeGrantAdmissionGlobalWindow({
    ...activeGlobal,
    attemptCount: activeGlobal.attemptCount + 1,
  });
  const telemetry = grantTransaction.readGrantAdmissionTelemetry(mode, digest);
  if (mode === "qr") return beginQrAdmission(grantTransaction, telemetry, digest, nowMs);
  if (
    telemetry?.delayUntilMs !== null &&
    telemetry?.delayUntilMs !== undefined &&
    telemetry.delayUntilMs > nowMs
  ) {
    return {
      sourceDigest: digest,
      throttle: grantAdmissionThrottled(telemetry.delayUntilMs - nowMs),
    };
  }
  if (
    telemetry !== null &&
    telemetry.failedAttempts >= GRANT_ADMISSION_SOURCE_FAILURE_LIMIT &&
    telemetry.delayUntilMs === null
  ) {
    const failures = Math.min(
      GRANT_ADMISSION_SOURCE_FAILURE_SATURATION,
      telemetry.failedAttempts + 1,
    );
    const delayMs = codeDelayMs(failures);
    grantTransaction.writeGrantAdmissionTelemetry({
      ...telemetry,
      failedAttempts: failures,
      delayUntilMs: nowMs + delayMs,
      lastAttemptAtMs: nowMs,
    });
    return {
      sourceDigest: digest,
      throttle: grantAdmissionThrottled(delayMs),
    };
  }
  return { sourceDigest: digest, throttle: null };
}

function beginQrAdmission(
  transaction: ReturnType<typeof requireGrantStorageTransaction>,
  previous: GrantAdmissionTelemetry | null,
  digest: string,
  nowMs: number,
): { sourceDigest: string; throttle: AdmissionThrottle } {
  // The prerequisite-C schema has one bounded integer source counter. For QR
  // rows it is the remaining source-bucket tokens; Code rows retain failure
  // count semantics below. Both interpretations remain keyed and durable.
  const refilled = refillQrTokens(previous, nowMs);
  const available = Math.floor(refilled);
  if (available < 1) {
    const retryAfterMs = Math.max(
      1,
      Math.ceil(
        ((1 - refilled) * GRANT_ADMISSION_WINDOW_MS) /
          GRANT_ADMISSION_QR_SOURCE_SUSTAINED_PER_MINUTE,
      ),
    );
    transaction.writeGrantAdmissionTelemetry({
      mode: "qr",
      sourceDigest: digest,
      failedAttempts: available,
      delayUntilMs: nowMs + retryAfterMs,
      lastAttemptAtMs: previous?.lastAttemptAtMs ?? nowMs,
      lastSuccessAtMs: previous?.lastSuccessAtMs ?? null,
    });
    return { sourceDigest: digest, throttle: grantAdmissionThrottled(retryAfterMs) };
  }
  transaction.writeGrantAdmissionTelemetry({
    mode: "qr",
    sourceDigest: digest,
    failedAttempts: available - 1,
    delayUntilMs: null,
    lastAttemptAtMs: nowMs,
    lastSuccessAtMs: previous?.lastSuccessAtMs ?? null,
  });
  return { sourceDigest: digest, throttle: null };
}

function refillQrTokens(previous: GrantAdmissionTelemetry | null, nowMs: number): number {
  if (previous === null) return GRANT_ADMISSION_QR_SOURCE_BURST;
  const elapsedMs = Math.max(0, nowMs - previous.lastAttemptAtMs);
  return Math.min(
    GRANT_ADMISSION_QR_SOURCE_BURST,
    previous.failedAttempts +
      (elapsedMs * GRANT_ADMISSION_QR_SOURCE_SUSTAINED_PER_MINUTE) / GRANT_ADMISSION_WINDOW_MS,
  );
}

function codeDelayMs(failures: number): number {
  return Math.min(
    30_000,
    1_000 * 2 ** Math.min(15, failures - GRANT_ADMISSION_SOURCE_FAILURE_LIMIT - 1),
  );
}

export function recordAdmissionFailure(
  transaction: FoundationStorageTransaction,
  mode: GrantAdmissionMode,
  sourceDigestValue: string,
  nowMs: number,
): void {
  const grantTransaction = requireGrantStorageTransaction(transaction);
  const previous = grantTransaction.readGrantAdmissionTelemetry(mode, sourceDigestValue);
  if (mode === "qr") {
    if (previous === null) return;
    grantTransaction.writeGrantAdmissionTelemetry({
      ...previous,
      delayUntilMs: null,
      lastAttemptAtMs: nowMs,
    });
    return;
  }
  const failures = Math.min(
    GRANT_ADMISSION_SOURCE_FAILURE_SATURATION,
    (previous?.failedAttempts ?? 0) + 1,
  );
  const delayMs = failures <= GRANT_ADMISSION_SOURCE_FAILURE_LIMIT ? 0 : codeDelayMs(failures);
  const value: GrantAdmissionTelemetry = {
    mode,
    sourceDigest: sourceDigestValue,
    failedAttempts: failures,
    delayUntilMs: delayMs === 0 ? null : nowMs + delayMs,
    lastAttemptAtMs: nowMs,
    lastSuccessAtMs: previous?.lastSuccessAtMs ?? null,
  };
  grantTransaction.writeGrantAdmissionTelemetry(value);
}

export function recordAdmissionSuccess(
  transaction: FoundationStorageTransaction,
  mode: GrantAdmissionMode,
  sourceDigestValue: string,
  nowMs: number,
): void {
  const grantTransaction = requireGrantStorageTransaction(transaction);
  const previous = grantTransaction.readGrantAdmissionTelemetry(mode, sourceDigestValue);
  grantTransaction.writeGrantAdmissionTelemetry({
    mode,
    sourceDigest: sourceDigestValue,
    failedAttempts: mode === "qr" ? (previous?.failedAttempts ?? 0) : 0,
    delayUntilMs: null,
    lastAttemptAtMs: nowMs,
    lastSuccessAtMs: nowMs,
  });
}
