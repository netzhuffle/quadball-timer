import type { Event, Stacktrace, StackFrame } from "@sentry/core";
import {
  OPERATIONAL_CATEGORIES,
  OPERATIONAL_OPERATIONS,
  OPERATIONAL_PHASES,
  OPERATIONAL_OUTCOMES,
} from "@/lib/operational-monitoring";

type ExceptionValue = NonNullable<NonNullable<Event["exception"]>["values"]>[number];

export type MonitoringIdentity = {
  environment: "production" | "test";
  release: string;
  browserCorrelation: string;
};

export type BrowserMonitoringPublicConfig = {
  dsn?: string;
  environment: MonitoringIdentity["environment"];
  release: string;
  browserCorrelation: string;
};

export function browserMonitoringPublicConfig(
  identity: MonitoringIdentity,
  dsn?: string,
): BrowserMonitoringPublicConfig {
  return {
    dsn,
    environment: identity.environment,
    release: identity.browserCorrelation,
    browserCorrelation: identity.browserCorrelation,
  };
}

export type MonitoringContext = {
  category?: string;
  component?: string;
  operation?: string;
  phase?: string;
  status?: string;
};

export type MonitoringTransport = (event: Event) => void | Promise<void>;

const SAFE_TAGS = ["category", "component", "operation", "phase", "status"] as const;
const SAFE_VALUE = /^[A-Za-z0-9._:/-]{1,96}$/u;
const SENSITIVE_ASSIGNMENT =
  /((?:authorization|cookie|csrf|grant(?:[-_ ]?(?:code|session))?|password|secret|token|credential|qr|key|body|audit|database|path|web.?authn)[^:=\s]{0,32})\s*[:=]\s*([^,;\s}]+)/giu;
const SENSITIVE_NAMED_VALUE =
  /\b(?:grant(?:\s+(?:code|session))?|qr(?:\s+(?:credential|value))?|authorization|cookie|csrf|password|secret|token|credential|key|body|audit|database|path)\b\s*(?::|=|\bis\b)\s*[^,;\s}]+/giu;
const BEARER = /\b(?:bearer|basic)\s+[A-Za-z0-9+/=._~-]+/giu;
const ABSOLUTE_PATH = /(?:[A-Za-z]:)?\/(?:[^\s/]+\/){1,}[^\s/]+/gu;
const TOKEN_MATERIAL = /\b[A-Za-z0-9_-]{32,96}\b/gu;
const SENSITIVE_WORD =
  /\b(?:grant|qr|session|cookie|token|credential|password|secret|authorization|csrf|audit|database|key|path)\b/iu;
const SAFE_EXCEPTION_TYPES = new Set([
  "AbortError",
  "Error",
  "NetworkError",
  "RangeError",
  "SyntaxError",
  "TypeError",
]);

/**
 * Rebuild a Sentry event using only fields reviewed for this application.
 *
 * In particular, this deliberately drops request, user, contexts, breadcrumbs,
 * extra data, and all stack-frame file names. Sentry's downstream scrubbing is
 * not part of this application's privacy boundary.
 */
export function redactSentryEvent(event: Event, identity: MonitoringIdentity): Event {
  if (event.tags?.operationalEvent === "1") {
    return redactOperationalSentryEvent(event, identity);
  }
  const exceptionValues = event.exception?.values
    ?.map((value) => redactExceptionValue(value))
    .filter((value): value is ExceptionValue => value !== null);

  return {
    event_id: isEventId(event.event_id) ? event.event_id : undefined,
    timestamp: event.timestamp,
    platform: "javascript",
    level: event.level,
    logger: "quadball-timer",
    environment: identity.environment,
    release: identity.release,
    message: "Quadball Timer application error",
    tags: {
      Environment: identity.environment,
      Release: identity.release,
      ReleaseAttempt: identity.release,
      BrowserCorrelation: identity.browserCorrelation,
      ...safeTags(event.tags),
      ...safeOperationalIdentityTags(event.tags, identity),
    },
    exception:
      exceptionValues === undefined || exceptionValues.length === 0
        ? undefined
        : { values: exceptionValues },
  };
}

/** Rebuild operational events using only their reviewed fixed allowlist. */
export function redactOperationalSentryEvent(event: Event, identity: MonitoringIdentity): Event {
  const tags = event.tags ?? {};
  const operation = allowlistedTag(tags.operation, OPERATIONAL_OPERATIONS);
  const phase = allowlistedTag(tags.phase, OPERATIONAL_PHASES);
  const outcome = allowlistedTag(tags.outcome, OPERATIONAL_OUTCOMES);
  const category = allowlistedTag(tags.category, OPERATIONAL_CATEGORIES);
  const eventEnvironment = tags.Environment ?? tags.environment;
  const eventRelease = tags.ReleaseAttempt ?? tags.releaseAttempt;

  return {
    timestamp: Number.isFinite(event.timestamp) ? event.timestamp : undefined,
    level: "error",
    message: "Quadball Timer operational failure",
    tags: {
      ...(operation === undefined ? {} : { operation }),
      ...(eventEnvironment === identity.environment ? { Environment: identity.environment } : {}),
      ...(eventRelease === identity.release ? { ReleaseAttempt: identity.release } : {}),
      ...(phase === undefined ? {} : { phase }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(category === undefined ? {} : { category }),
    },
  };
}

function safeOperationalIdentityTags(
  tags: Record<string, unknown> | undefined,
  identity: MonitoringIdentity,
): Record<string, string> {
  const environment = tags?.environment;
  const releaseAttempt = tags?.releaseAttempt;
  return {
    ...(environment === identity.environment ? { Environment: identity.environment } : {}),
    ...(releaseAttempt === identity.release ? { ReleaseAttempt: identity.release } : {}),
  };
}

export function serializeBrowserMonitoringConfig(config: BrowserMonitoringPublicConfig): string {
  return JSON.stringify(config).replaceAll("<", "\\u003c");
}

export function safeMonitoringTags(context: MonitoringContext = {}): Record<string, string> {
  return safeTags(context);
}

export async function sendRedactedEvent(
  event: Event,
  identity: MonitoringIdentity,
  transport: MonitoringTransport,
): Promise<void> {
  await transport(redactSentryEvent(event, identity));
}

export function redactText(value: unknown): string {
  if (typeof value !== "string") return "[redacted]";
  const redacted = value
    .slice(0, 500)
    .replace(BEARER, "[REDACTED CREDENTIAL]")
    .replace(SENSITIVE_ASSIGNMENT, "$1=[REDACTED]")
    .replace(SENSITIVE_NAMED_VALUE, "[REDACTED VALUE]")
    .replace(ABSOLUTE_PATH, "[REDACTED PATH]")
    .replace(TOKEN_MATERIAL, "[REDACTED VALUE]");
  return SENSITIVE_WORD.test(redacted) ? "[REDACTED ERROR]" : redacted;
}

function redactExceptionValue(value: ExceptionValue): ExceptionValue | null {
  const type =
    value.type !== undefined && SAFE_EXCEPTION_TYPES.has(value.type) ? value.type : "Error";
  const exception: ExceptionValue = {
    type,
    value: "Application exception",
    stacktrace: value.stacktrace === undefined ? undefined : redactStacktrace(value.stacktrace),
    mechanism:
      value.mechanism === undefined
        ? undefined
        : { type: "application", handled: value.mechanism.handled !== false },
  };
  return exception.type === undefined && exception.value === undefined ? null : exception;
}

function redactStacktrace(stacktrace: Stacktrace): Stacktrace {
  return {
    frames: stacktrace.frames
      ?.map((frame) => redactStackFrame(frame))
      .filter((frame): frame is StackFrame => frame !== null),
  };
}

function redactStackFrame(frame: StackFrame): StackFrame | null {
  const safeFrame: StackFrame = {
    function: frame.function === undefined ? undefined : redactText(frame.function),
    module: frame.module === undefined ? undefined : redactText(frame.module),
    lineno: frame.lineno,
    colno: frame.colno,
  };
  return safeFrame.function === undefined && safeFrame.module === undefined
    ? safeFrame.lineno === undefined && safeFrame.colno === undefined
      ? null
      : safeFrame
    : safeFrame;
}

function safeTags(tags: Record<string, unknown> | undefined) {
  const output: Record<string, string> = {};
  for (const key of SAFE_TAGS) {
    const value = tags?.[key];
    if (typeof value === "string" && SAFE_VALUE.test(value) && !SENSITIVE_WORD.test(value)) {
      output[key] = value;
    }
  }
  return output;
}

function allowlistedTag<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number] | undefined {
  return typeof value === "string" && values.includes(value as Values[number]) ? value : undefined;
}

function isEventId(value: string | undefined): value is string {
  return value !== undefined && /^[a-f0-9]{32}$/u.test(value);
}
