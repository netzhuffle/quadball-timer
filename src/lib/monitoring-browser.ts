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

type BrowserMonitoringClient = {
  init(options: Parameters<typeof Sentry.init>[0]): void;
  withScope(callback: (scope: { setTags(tags: Record<string, string>): void }) => void): void;
  captureException(error: unknown): void;
  captureMessage(message: string): void;
};

const defaultBrowserMonitoringClient: BrowserMonitoringClient = {
  init(options) {
    Sentry.init(options);
  },
  withScope(callback) {
    Sentry.withScope((scope) => callback(scope));
  },
  captureException(error) {
    Sentry.captureException(error);
  },
  captureMessage(message) {
    Sentry.captureMessage(message);
  },
};

type ReactErrorHandlerClient = {
  reactErrorHandler: typeof Sentry.reactErrorHandler;
};

export function initializeBrowserMonitoring(
  config: BrowserMonitoringConfig,
  client: BrowserMonitoringClient = defaultBrowserMonitoringClient,
  target: BrowserMonitoringEventTarget = window,
): void {
  if (config.dsn === undefined || config.dsn.length === 0) return;

  try {
    client.init({
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

    installBrowserMonitoringListeners(target, (error, context) => {
      safelyCapture(() => {
        client.withScope((scope) => {
          scope.setTags(safeMonitoringTags(context));
          client.captureException(error);
        });
      });
    });
  } catch {
    // Monitoring setup is observational and must never prevent application startup.
  }
}

export function installBrowserMonitoringListeners(
  target: BrowserMonitoringEventTarget,
  capture: BrowserMonitoringCapture,
): void {
  target.addEventListener("error", (event) => {
    const errorEvent = event as ErrorEvent;
    safelyCapture(() => {
      capture(errorEvent.error ?? new Error(errorEvent.message || "Browser error"), {
        category: "browser",
        component: "window",
      });
    });
  });
  target.addEventListener("unhandledrejection", (event) => {
    const rejectionEvent = event as PromiseRejectionEvent;
    safelyCapture(() => {
      capture(
        rejectionEvent.reason instanceof Error
          ? rejectionEvent.reason
          : new Error("Unhandled browser rejection"),
        { category: "browser", component: "promise" },
      );
    });
  });
}

/**
 * Keep React 19 root error capture behind one narrow, failure-isolated seam.
 * Sentry's beforeSend callback applies the same redaction boundary as browser
 * and server errors.
 */
export function createReactRootErrorHandlers(
  client: ReactErrorHandlerClient = Sentry,
): ReactRootErrorHandlers {
  let handler: ReturnType<typeof Sentry.reactErrorHandler>;
  try {
    handler = client.reactErrorHandler();
  } catch {
    return {
      onCaughtError() {},
      onRecoverableError() {},
      onUncaughtError() {},
    };
  }
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
  safelyCapture(() => {
    defaultBrowserMonitoringClient.withScope((scope) => {
      scope.setTags(safeMonitoringTags(context));
      defaultBrowserMonitoringClient.captureMessage(message);
    });
  });
}

function safelyCapture(capture: () => void): void {
  try {
    capture();
  } catch {
    // Monitoring is observational and must never alter application behavior.
  }
}
