import * as Sentry from "@sentry/bun";
import type { Event } from "@sentry/core";
import { createHash } from "node:crypto";
import { readRunningReleaseIdentity } from "@/lib/release-identity";
import {
  redactSentryEvent,
  safeMonitoringTags,
  type MonitoringContext,
  type MonitoringIdentity,
} from "@/lib/monitoring-redaction";
import type { OperationalEvent } from "@/lib/operational-monitoring";

export type ServerMonitoring = {
  enabled: boolean;
  captureException(error: unknown, context?: MonitoringContext): void;
  captureMessage(message: string, context?: MonitoringContext): void;
  captureOperationalFailure(event: OperationalEvent): boolean;
  flush(timeoutMs?: number): Promise<boolean>;
};

export type ServerMonitoringOptions = MonitoringIdentity & {
  dsn?: string;
};

export async function readTrustedMonitoringIdentity(
  environment: MonitoringIdentity["environment"],
  environmentVariables: Record<string, string | undefined> = process.env,
): Promise<MonitoringIdentity | null> {
  const configuredRelease = environmentVariables.RELEASE_ATTEMPT_ID?.trim();
  if (configuredRelease !== undefined && /^[A-Za-z0-9._-]+$/u.test(configuredRelease)) {
    return {
      environment,
      release: configuredRelease,
      browserCorrelation: createBrowserCorrelation(configuredRelease),
    };
  }

  try {
    const release = await readRunningReleaseIdentity();
    return {
      environment,
      release: release.releaseAttemptId,
      browserCorrelation: createBrowserCorrelation(release.releaseAttemptId),
    };
  } catch {
    return environmentVariables.NODE_ENV === "production"
      ? null
      : {
          environment,
          release: `${environment}-local`,
          browserCorrelation: createBrowserCorrelation(`${environment}-local`),
        };
  }
}

export function createBrowserCorrelation(release: string): string {
  return `release-${createHash("sha256").update(release).digest("hex").slice(0, 16)}`;
}

export function initializeServerMonitoring(options: ServerMonitoringOptions): ServerMonitoring {
  if (options.dsn === undefined || options.dsn.length === 0) return createDisabledMonitoring();

  try {
    Sentry.init({
      dsn: options.dsn,
      environment: options.environment,
      release: options.release,
      defaultIntegrations: false,
      sendDefaultPii: false,
      tracesSampleRate: 0,
      beforeSend(event) {
        return redactSentryEvent(event, options) as typeof event;
      },
    });
  } catch {
    return createDisabledMonitoring();
  }

  return {
    enabled: true,
    captureException(error, context) {
      safelyCapture(() => {
        Sentry.withScope((scope) => {
          scope.setTags(safeMonitoringTags(context));
          Sentry.captureException(error);
        });
      });
    },
    captureMessage(message, context) {
      safelyCapture(() => {
        Sentry.withScope((scope) => {
          scope.setTags(safeMonitoringTags(context));
          Sentry.captureMessage(message);
        });
      });
    },
    captureOperationalFailure(event) {
      return captureOperationalFailureEvent(event, options, (captured) => {
        Sentry.captureEvent(captured);
      });
    },
    flush(timeoutMs = 2_000) {
      return Sentry.flush(timeoutMs).catch(() => false);
    },
  };
}

export function captureOperationalFailureEvent(
  event: OperationalEvent,
  identity: Pick<MonitoringIdentity, "environment" | "release">,
  capture: (event: Event) => void,
): boolean {
  if (event.environment !== identity.environment) return false;
  if (event.releaseAttempt !== undefined && event.releaseAttempt !== identity.release) return false;
  const timestampMs =
    Number.isSafeInteger(event.timestampMs) && event.timestampMs >= 0
      ? event.timestampMs
      : Date.now();
  return tryCapture(() => {
    capture({
      level: "error",
      message: "Quadball Timer operational failure",
      timestamp: timestampMs / 1_000,
      tags: {
        operationalEvent: "1",
        Environment: event.environment,
        ...(event.releaseAttempt === undefined ? {} : { ReleaseAttempt: event.releaseAttempt }),
        operation: event.operation,
        phase: event.phase,
        outcome: event.outcome,
        category: event.category,
      },
    });
  });
}

function safelyCapture(capture: () => void): void {
  tryCapture(capture);
}

function tryCapture(capture: () => void): boolean {
  try {
    capture();
    return true;
  } catch {
    // Monitoring is observational and must never alter application behavior.
    return false;
  }
}

export function redactServerEventForTest(event: Event, identity: MonitoringIdentity): Event {
  return redactSentryEvent(event, identity);
}

function createDisabledMonitoring(): ServerMonitoring {
  return {
    enabled: false,
    captureException() {},
    captureMessage() {},
    captureOperationalFailure() {
      return false;
    },
    flush: async () => true,
  };
}
