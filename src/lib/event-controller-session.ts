import { validateOpaqueIdentifier } from "@/lib/validation-policy";

export const EVENT_CONTROLLER_SESSION_STORAGE_KEY = "quadball:event-controller-session";
const EVENT_CONTROLLER_SESSION_VERSION = "event-controller-session-v4" as const;
const PREVIOUS_EVENT_CONTROLLER_SESSION_VERSION = "event-controller-session-v3" as const;
const LEGACY_EVENT_CONTROLLER_SESSION_VERSION = "event-controller-session-v2" as const;

export type PersistedEventControllerSession = {
  sessionBearer: string;
  eventGameId: string;
  sessionReferenceId: string;
};

export type EventControllerSessionInput = Omit<
  PersistedEventControllerSession,
  "sessionReferenceId"
> & { sessionReferenceId?: string };

type PersistedEventControllerSessionDocument = {
  version: typeof EVENT_CONTROLLER_SESSION_VERSION;
  currentEventGameId: string;
  currentSessionReferenceId: string;
  sessions: PersistedEventControllerSession[];
};

export type EventControllerSessionStorage = {
  read(): PersistedEventControllerSession | null;
  readForGame(
    eventGameId: string,
    sessionReferenceId?: string,
  ): PersistedEventControllerSession | null;
  write(session: EventControllerSessionInput): boolean;
  clear(gameId?: string, sessionReferenceId?: string): void;
};

export function createBrowserEventControllerSessionStorage(): EventControllerSessionStorage {
  return {
    read: readBrowserEventControllerSession,
    readForGame: readBrowserEventControllerSessionForGame,
    write(session) {
      const current = readBrowserEventControllerSessionDocument();
      const normalized = {
        ...session,
        sessionReferenceId: session.sessionReferenceId ?? createEventControllerSessionReference(),
      };
      const sessions =
        current?.sessions.filter(
          (candidate) => candidate.sessionReferenceId !== normalized.sessionReferenceId,
        ) ?? [];
      sessions.push(normalized);
      return writeBrowserEventControllerSessionDocument({
        version: EVENT_CONTROLLER_SESSION_VERSION,
        currentEventGameId: normalized.eventGameId,
        currentSessionReferenceId: normalized.sessionReferenceId,
        sessions,
      });
    },
    clear(gameId, sessionReferenceId) {
      const current = readBrowserEventControllerSessionDocument();
      if (current === null) return;
      const sessions =
        gameId === undefined
          ? []
          : current.sessions.filter(
              (candidate) =>
                candidate.eventGameId !== gameId ||
                (sessionReferenceId !== undefined &&
                  candidate.sessionReferenceId !== sessionReferenceId),
            );
      if (sessions.length === 0) {
        removeBrowserEventControllerSessionDocument();
        return;
      }
      const currentSession =
        sessions.find(
          (candidate) => candidate.sessionReferenceId === current.currentSessionReferenceId,
        ) ?? sessions.at(-1)!;
      writeBrowserEventControllerSessionDocument({
        version: EVENT_CONTROLLER_SESSION_VERSION,
        currentEventGameId: currentSession.eventGameId,
        currentSessionReferenceId: currentSession.sessionReferenceId,
        sessions,
      });
    },
  };
}

export function readBrowserEventControllerSession(): PersistedEventControllerSession | null {
  const document = readBrowserEventControllerSessionDocument();
  if (document === null) return null;
  return (
    document.sessions.find(
      (session) => session.sessionReferenceId === document.currentSessionReferenceId,
    ) ??
    document.sessions.at(-1) ??
    null
  );
}

export function readBrowserEventControllerSessionForGame(
  eventGameId: string,
  sessionReferenceId?: string,
): PersistedEventControllerSession | null {
  return (() => {
    const document = readBrowserEventControllerSessionDocument();
    if (document === null) return null;
    if (sessionReferenceId !== undefined)
      return (
        document.sessions.find(
          (session) =>
            session.eventGameId === eventGameId &&
            session.sessionReferenceId === sessionReferenceId,
        ) ?? null
      );
    return (
      document.sessions.find(
        (session) =>
          session.eventGameId === eventGameId &&
          session.sessionReferenceId === document.currentSessionReferenceId,
      ) ??
      document.sessions.find((session) => session.eventGameId === eventGameId) ??
      null
    );
  })();
}

export function parseEventControllerSession(raw: string): PersistedEventControllerSession | null {
  const document = parseEventControllerSessionDocument(raw);
  return (
    document?.sessions.find(
      (session) => session.sessionReferenceId === document.currentSessionReferenceId,
    ) ??
    document?.sessions.at(-1) ??
    null
  );
}

function readBrowserEventControllerSessionDocument(): PersistedEventControllerSessionDocument | null {
  const copies: string[] = [];
  try {
    const local = window.localStorage.getItem(EVENT_CONTROLLER_SESSION_STORAGE_KEY);
    if (local !== null) copies.push(local);
  } catch {
    return null;
  }
  try {
    const session = window.sessionStorage.getItem(EVENT_CONTROLLER_SESSION_STORAGE_KEY);
    if (session !== null) copies.push(session);
  } catch {
    // A readable durable local copy remains usable when the mirror is blocked.
  }
  if (copies.length === 0) return null;
  const documents = copies.map(parseEventControllerSessionDocument);
  if (documents.some((document) => document === null)) return null;
  const [first, ...rest] = documents as PersistedEventControllerSessionDocument[];
  // localStorage is durable and sessionStorage is its mirror. A mismatch is
  // a failed-closed partial write, never a reason to choose a stale copy.
  if (rest.some((document) => JSON.stringify(document) !== JSON.stringify(first))) return null;
  return first ?? null;
}

function writeBrowserEventControllerSessionDocument(
  document: PersistedEventControllerSessionDocument,
): boolean {
  const value = JSON.stringify(document);
  let localWritten = false;
  let sessionWritten = false;
  try {
    window.localStorage.setItem(EVENT_CONTROLLER_SESSION_STORAGE_KEY, value);
    localWritten = window.localStorage.getItem(EVENT_CONTROLLER_SESSION_STORAGE_KEY) === value;
  } catch {
    // Durable storage is required for recovery; a session-only write is not enough.
  }
  try {
    window.sessionStorage.setItem(EVENT_CONTROLLER_SESSION_STORAGE_KEY, value);
    sessionWritten = window.sessionStorage.getItem(EVENT_CONTROLLER_SESSION_STORAGE_KEY) === value;
  } catch {
    // The caller receives a durability warning.
  }
  if (localWritten && sessionWritten) return true;
  removeBrowserEventControllerSessionDocument();
  return false;
}

function removeBrowserEventControllerSessionDocument() {
  try {
    window.localStorage.removeItem(EVENT_CONTROLLER_SESSION_STORAGE_KEY);
  } catch {
    // Best effort; lifecycle state remains authoritative.
  }
  try {
    window.sessionStorage.removeItem(EVENT_CONTROLLER_SESSION_STORAGE_KEY);
  } catch {
    // Best effort; lifecycle state remains authoritative.
  }
}

function parseEventControllerSessionDocument(
  raw: string,
): PersistedEventControllerSessionDocument | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.version === EVENT_CONTROLLER_SESSION_VERSION ||
      value.version === PREVIOUS_EVENT_CONTROLLER_SESSION_VERSION ||
      value.version === LEGACY_EVENT_CONTROLLER_SESSION_VERSION
    ) {
      if (typeof value.currentEventGameId !== "string" || !Array.isArray(value.sessions))
        return null;
      const sessions = value.sessions
        .filter(isPersistedEventControllerSessionShape)
        .map((session) => normalizeEventControllerSession(session, true));
      if (sessions.length !== value.sessions.length || sessions.length === 0) return null;
      if (!sessions.some((session) => session.eventGameId === value.currentEventGameId))
        return null;
      const currentSessionReferenceId =
        typeof value.currentSessionReferenceId === "string" &&
        sessions.some((session) => session.sessionReferenceId === value.currentSessionReferenceId)
          ? value.currentSessionReferenceId
          : [...sessions]
              .reverse()
              .find((session) => session.eventGameId === value.currentEventGameId)!
              .sessionReferenceId;
      return {
        version: EVENT_CONTROLLER_SESSION_VERSION,
        currentEventGameId: value.currentEventGameId,
        currentSessionReferenceId,
        sessions,
      };
    }
    // #268 stored one current credential. Preserve it as the first v2 entry.
    if (isPersistedEventControllerSession(value)) {
      return {
        version: EVENT_CONTROLLER_SESSION_VERSION,
        currentEventGameId: value.eventGameId,
        currentSessionReferenceId: normalizeEventControllerSession(value, true).sessionReferenceId,
        sessions: [normalizeEventControllerSession(value, true)],
      };
    }
    return null;
  } catch {
    return null;
  }
}

function isPersistedEventControllerSessionShape(value: unknown): value is Omit<
  PersistedEventControllerSession,
  "sessionReferenceId"
> & {
  sessionReferenceId?: unknown;
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.sessionBearer === "string" &&
    typeof candidate.eventGameId === "string" &&
    validateOpaqueIdentifier(candidate.sessionBearer, "sessionBearer").ok &&
    validateOpaqueIdentifier(candidate.eventGameId, "eventGameId").ok &&
    (candidate.sessionReferenceId === undefined ||
      (typeof candidate.sessionReferenceId === "string" &&
        validateOpaqueIdentifier(candidate.sessionReferenceId, "sessionReferenceId").ok))
  );
}

function isPersistedEventControllerSession(
  value: unknown,
): value is Omit<PersistedEventControllerSession, "sessionReferenceId"> {
  return isPersistedEventControllerSessionShape(value);
}

function normalizeEventControllerSession(
  session:
    | EventControllerSessionInput
    | (Omit<PersistedEventControllerSession, "sessionReferenceId"> & {
        sessionReferenceId?: unknown;
      }),
  legacy = false,
): PersistedEventControllerSession {
  const sessionReferenceId =
    typeof session.sessionReferenceId === "string" &&
    validateOpaqueIdentifier(session.sessionReferenceId, "sessionReferenceId").ok
      ? session.sessionReferenceId
      : legacy
        ? legacyEventControllerSessionReference(session.eventGameId)
        : createEventControllerSessionReference();
  return { ...session, sessionReferenceId };
}

export function createEventControllerSessionReference(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return `event-session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function legacyEventControllerSessionReference(eventGameId: string): string {
  return `legacy-event-session-${eventGameId}`;
}
