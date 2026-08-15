import type {
  EventCatalogFoundationStorage,
  EventCatalogStorageSnapshot,
  StoredEvent,
} from "@/lib/event-catalog";

export type PublicAudienceEventLifecycle = "unscheduled" | "current" | "future" | "past";

export type PublicAudienceEventTeam = {
  name: string;
  color: string;
};

export type PublicAudiencePitch = {
  name: string;
};

/** The narrow publication contract consumed by the future public Event experience. */
export type PublicAudienceEventProjection = {
  eventId: string;
  name: string;
  timeZone: string;
  publicationStatus: "published";
  gameDays: readonly string[];
  lifecycle: PublicAudienceEventLifecycle;
  canonicalPath: string;
  teams: readonly PublicAudienceEventTeam[];
  pitches: readonly PublicAudiencePitch[];
};

export type PublicAudienceEventList = {
  events: readonly PublicAudienceEventProjection[];
};

export type AudienceProjectionOutcome =
  | { status: "accepted"; value: PublicAudienceEventProjection }
  | { status: "unavailable" }
  | { status: "retryable-failure" };

export type AudienceProjectionListOutcome =
  | { status: "accepted"; value: PublicAudienceEventList }
  | { status: "retryable-failure" };

export type AudienceProjectionOptions = {
  now?: () => number;
};

export type AudienceProjectionReader = {
  read(eventId: unknown): Promise<AudienceProjectionOutcome>;
  list(): Promise<AudienceProjectionListOutcome>;
};

export const PUBLIC_AUDIENCE_ABSENCE = Object.freeze({
  status: "unavailable",
} as const);

/**
 * Ineligible and unknown identifiers intentionally share one anonymous semantic absence.
 * Public pages, Timeline composition, and transport fan-out remain owned by #131.
 */
export function createAudienceProjection(
  storage: EventCatalogFoundationStorage,
  options: AudienceProjectionOptions = {},
): AudienceProjectionReader {
  const now = options.now ?? Date.now;
  return {
    async read(eventId: unknown): Promise<AudienceProjectionOutcome> {
      if (typeof eventId !== "string" || eventId.trim().length === 0)
        return { status: "unavailable" };
      try {
        const snapshot = await storage.snapshot();
        const event = snapshot.findEvent(eventId);
        if (event === null || event.publicationStatus !== "published")
          return { status: "unavailable" };
        return { status: "accepted", value: projectPublicEvent(snapshot, event, now()) };
      } catch {
        return { status: "retryable-failure" };
      }
    },
    async list(): Promise<AudienceProjectionListOutcome> {
      try {
        const snapshot = await storage.snapshot();
        const nowMs = now();
        const events = snapshot
          .listEvents()
          .filter((event) => event.publicationStatus === "published")
          .map((event) => projectPublicEvent(snapshot, event, nowMs));
        return {
          status: "accepted",
          value: { events: sortPublicEvents(events) },
        };
      } catch {
        return { status: "retryable-failure" };
      }
    },
  };
}

function projectPublicEvent(
  snapshot: EventCatalogStorageSnapshot,
  event: StoredEvent,
  nowMs: number,
): PublicAudienceEventProjection {
  const gameDays = snapshot
    .listGameDays(event.eventId)
    .map(({ date }) => date)
    .sort();
  return {
    eventId: event.eventId,
    name: event.name,
    timeZone: event.timeZone,
    publicationStatus: "published",
    gameDays,
    lifecycle: classifyLifecycle(gameDays, event.timeZone, nowMs),
    canonicalPath: `/events/${encodeURIComponent(event.eventId)}`,
    teams: snapshot.listEventTeams(event.eventId).map(({ name, defaultColor }) => ({
      name,
      color: defaultColor,
    })),
    pitches: snapshot.listPitches(event.eventId).map(({ name }) => ({ name })),
  };
}

function classifyLifecycle(
  gameDays: readonly string[],
  timeZone: string,
  nowMs: number,
): PublicAudienceEventLifecycle {
  if (gameDays.length === 0) return "unscheduled";
  const today = localDate(nowMs, timeZone);
  if (gameDays.includes(today)) return "current";
  return gameDays.some((date) => date > today) ? "future" : "past";
}

function localDate(nowMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function sortPublicEvents(
  events: readonly PublicAudienceEventProjection[],
): readonly PublicAudienceEventProjection[] {
  return [...events].sort((left, right) => {
    const lifecycle = lifecycleOrder(left.lifecycle) - lifecycleOrder(right.lifecycle);
    if (lifecycle !== 0) return lifecycle;
    const leftDate = left.gameDays[0] ?? "9999-99-99";
    const rightDate = right.gameDays[0] ?? "9999-99-99";
    const date =
      left.lifecycle === "past"
        ? rightDate.localeCompare(leftDate)
        : leftDate.localeCompare(rightDate);
    return date === 0
      ? left.name.localeCompare(right.name) || left.eventId.localeCompare(right.eventId)
      : date;
  });
}

function lifecycleOrder(lifecycle: PublicAudienceEventLifecycle): number {
  return lifecycle === "current"
    ? 0
    : lifecycle === "future"
      ? 1
      : lifecycle === "unscheduled"
        ? 2
        : 3;
}
