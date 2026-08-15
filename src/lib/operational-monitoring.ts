import { appendFileSync } from "node:fs";

export const OPERATIONAL_OPERATIONS = [
  "deployment",
  "backup",
  "migration",
  "restore",
  "readiness",
] as const;
export type OperationalOperation = (typeof OPERATIONAL_OPERATIONS)[number];

export const OPERATIONAL_PHASES = [
  "preflight",
  "quiesce-stop",
  "backup-create",
  "backup-verify",
  "backup-promote",
  "candidate-validation",
  "live-migration",
  "staged-restore",
  "release-switch",
  "startup",
  "readiness",
  "rollback-restart",
  "final-report",
] as const;
export type OperationalPhase = (typeof OPERATIONAL_PHASES)[number];

export const OPERATIONAL_CATEGORIES = [
  "backup-candidate",
  "migration-candidate",
  "schema-incompatibility",
  "binary-rollback",
  "staged-restore",
  "key-version",
  "technical-admin-auth-sanitization",
  "re-enrollment-required",
  "atomic-install",
  "readiness",
] as const;
export type OperationalCategory = (typeof OPERATIONAL_CATEGORIES)[number];

export const OPERATIONAL_OUTCOMES = [
  "failed",
  "degraded",
  "blocked",
  "incompatible",
  "rolled-back",
  "unavailable",
] as const;
export type OperationalOutcome = (typeof OPERATIONAL_OUTCOMES)[number];

export type OperationalEvent = {
  operation: OperationalOperation;
  environment: "production" | "test";
  releaseAttempt?: string;
  phase: OperationalPhase;
  outcome: OperationalOutcome;
  category: OperationalCategory;
  timestampMs: number;
};

export type OperationalDelivery = "sent" | "failed" | "unavailable";

export type OperationalFailureInput = Omit<OperationalEvent, "timestampMs"> & {
  timestampMs?: number;
};

export type OperationalMonitoringAdapter = {
  /** Queue delivery without allowing monitoring to delay the caller. */
  reportFailure(input: OperationalFailureInput): void;
  /** Await one bounded delivery attempt for an explicit reporter boundary. */
  deliverFailure(input: OperationalFailureInput): Promise<OperationalDelivery>;
};

export function createOperationalMonitoringAdapter(options: {
  enabled: boolean;
  send?: (event: OperationalEvent) => boolean | void | Promise<boolean | void>;
  now?: () => number;
  timeoutMs?: number;
  scheduleTimeout?: (callback: () => void, timeoutMs: number) => void;
  onDelivery?: (delivery: OperationalDelivery) => void;
}): OperationalMonitoringAdapter {
  const now = options.now ?? Date.now;
  const timeoutMs = Math.max(1, Math.min(1_000, options.timeoutMs ?? 250));
  const scheduleTimeout =
    options.scheduleTimeout ??
    ((callback, delayMs) => {
      setTimeout(callback, delayMs);
    });
  const operations = new Set<string>(OPERATIONAL_OPERATIONS);
  const phases = new Set<string>(OPERATIONAL_PHASES);
  const categories = new Set<string>(OPERATIONAL_CATEGORIES);
  const outcomes = new Set<string>(OPERATIONAL_OUTCOMES);

  const normalizeEvent = (input: OperationalFailureInput): OperationalEvent => ({
    operation: allowlistedEnum(operations, input.operation, "deployment") as OperationalOperation,
    environment: input.environment === "production" ? "production" : "test",
    ...(typeof input.releaseAttempt === "string" &&
    /^[A-Za-z0-9._-]{1,128}$/u.test(input.releaseAttempt)
      ? { releaseAttempt: input.releaseAttempt }
      : {}),
    phase: allowlistedEnum(phases, input.phase, "readiness") as OperationalPhase,
    outcome: allowlistedEnum(outcomes, input.outcome, "failed") as OperationalOutcome,
    category: allowlistedEnum(categories, input.category, "readiness") as OperationalCategory,
    timestampMs:
      typeof input.timestampMs === "number" && Number.isSafeInteger(input.timestampMs)
        ? input.timestampMs
        : now(),
  });

  const deliverEvent = (event: OperationalEvent): Promise<OperationalDelivery> => {
    if (!options.enabled || options.send === undefined) return Promise.resolve("unavailable");

    let pending: boolean | void | Promise<boolean | void>;
    try {
      pending = options.send(event);
    } catch {
      return Promise.resolve("failed");
    }
    if (!(pending instanceof Promise)) {
      return Promise.resolve(pending === true ? "sent" : "failed");
    }

    const timeout = new Promise<OperationalDelivery>((resolve) => {
      scheduleTimeout(() => resolve("failed"), timeoutMs);
    });
    return Promise.race([
      pending.then(
        (delivered): OperationalDelivery => (delivered === true ? "sent" : "failed"),
        () => "failed" as const,
      ),
      timeout,
    ]).catch(() => "failed");
  };

  return {
    reportFailure(input) {
      const event = normalizeEvent(input);
      if (!options.enabled || options.send === undefined) {
        options.onDelivery?.("unavailable");
        return;
      }

      queueMicrotask(() => {
        void deliverEvent(event).then((delivery) => options.onDelivery?.(delivery));
      });
    },
    async deliverFailure(input) {
      const delivery = await deliverEvent(normalizeEvent(input));
      options.onDelivery?.(delivery);
      return delivery;
    },
  };
}

export function createOperationalMonitoringAdapterForMaintenance(
  reportFile: string,
): OperationalMonitoringAdapter {
  return createOperationalMonitoringAdapter({
    enabled: true,
    send: (event) => {
      appendFileSync(
        reportFile,
        `${event.operation}\t${event.environment}\t${event.releaseAttempt ?? ""}\t${event.phase}\t${event.outcome}\t${event.category}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      return true;
    },
  });
}

function allowlistedEnum(values: Set<string>, value: unknown, fallback: string): string {
  return typeof value === "string" && values.has(value) ? value : fallback;
}
