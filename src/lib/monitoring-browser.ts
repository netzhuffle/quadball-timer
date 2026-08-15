import * as Sentry from "@sentry/react";
import type { ErrorInfo } from "react";
import {
  redactSentryEvent,
  safeMonitoringTags,
  type MonitoringContext,
} from "@/lib/monitoring-redaction";

export type BrowserMonitoringConfig = {
  dsn?: string;
  environment: "production" | "test";
  release: string;
  browserCorrelation: string;
};

export type BrowserMonitoringEventTarget = Pick<Window, "addEventListener">;
export type BrowserMonitoringCapture = (error: unknown, context: MonitoringContext) => void;
export type ReactRootErrorHandlers = {
  onCaughtError: (error: unknown, errorInfo: ErrorInfo) => void;
  onRecoverableError: (error: unknown, errorInfo: ErrorInfo) => void;
  onUncaughtError: (error: unknown, errorInfo: ErrorInfo) => void;
};

export function initializeBrowserMonitoring(config: BrowserMonitoringConfig): void {
  if (config.dsn === undefined || config.dsn.length === 0) return;

  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    defaultIntegrations: false,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend(event) {
      return redactSentryEvent(event, config) as typeof event;
    },
  });

  installBrowserMonitoringListeners(window, (error, context) => {
    Sentry.withScope((scope) => {
      scope.setTags(safeMonitoringTags(context));
      Sentry.captureException(error);
    });
  });
}

export function installBrowserMonitoringListeners(
  target: BrowserMonitoringEventTarget,
  capture: BrowserMonitoringCapture,
): void {
  target.addEventListener("error", (event) => {
    const errorEvent = event as ErrorEvent;
    capture(errorEvent.error ?? new Error(errorEvent.message || "Browser error"), {
      category: "browser",
      component: "window",
    });
  });
  target.addEventListener("unhandledrejection", (event) => {
    const rejectionEvent = event as PromiseRejectionEvent;
    capture(
      rejectionEvent.reason instanceof Error
        ? rejectionEvent.reason
        : new Error("Unhandled browser rejection"),
      { category: "browser", component: "promise" },
    );
  });
}

/**
 * Keep React 19 root error capture behind one narrow, failure-isolated seam.
 * Sentry's beforeSend callback applies the same redaction boundary as browser
 * and server errors.
 */
export function createReactRootErrorHandlers(): ReactRootErrorHandlers {
  const handler = Sentry.reactErrorHandler();
  const isolated = (error: unknown, errorInfo: ErrorInfo): void => {
    try {
      handler(error, errorInfo);
    } catch {
      // Monitoring is observational and must never change React application behavior.
    }
  };
  return {
    onCaughtError: isolated,
    onRecoverableError: isolated,
    onUncaughtError: isolated,
  };
}

export function captureBrowserMessage(message: string, context?: MonitoringContext): void {
  Sentry.withScope((scope) => {
    scope.setTags(safeMonitoringTags(context));
    Sentry.captureMessage(message);
  });
}
