import type {
  EventCatalogFoundationStorage,
  EventCatalogStorageSnapshot,
  StoredEvent,
} from "@/lib/event-catalog";

/** The narrow publication contract consumed by the future public Event experience. */
export type PublicAudienceEventProjection = {
  eventId: string;
  name: string;
  timeZone: string;
  publicationStatus: "published";
  gameDays: readonly string[];
};

export type AudienceProjectionOutcome =
  | { status: "accepted"; value: PublicAudienceEventProjection }
  | { status: "unavailable" }
  | { status: "retryable-failure" };

export type AudienceProjectionReader = {
  read(eventId: unknown): Promise<AudienceProjectionOutcome>;
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
): AudienceProjectionReader {
  return {
    async read(eventId: unknown): Promise<AudienceProjectionOutcome> {
      if (typeof eventId !== "string" || eventId.trim().length === 0)
        return { status: "unavailable" };
      try {
        const snapshot = await storage.snapshot();
        const event = snapshot.findEvent(eventId);
        if (event === null || event.publicationStatus !== "published")
          return { status: "unavailable" };
        return { status: "accepted", value: projectPublicEvent(snapshot, event) };
      } catch {
        return { status: "retryable-failure" };
      }
    },
  };
}

function projectPublicEvent(
  snapshot: EventCatalogStorageSnapshot,
  event: StoredEvent,
): PublicAudienceEventProjection {
  return {
    eventId: event.eventId,
    name: event.name,
    timeZone: event.timeZone,
    publicationStatus: "published",
    gameDays: snapshot
      .listGameDays(event.eventId)
      .map(({ date }) => date)
      .sort((left, right) => left.localeCompare(right)),
  };
}
