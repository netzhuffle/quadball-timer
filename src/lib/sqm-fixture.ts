import type { PublicAudienceEventProjection } from "@/lib/audience-projection";

export const SQM_FIXTURE_EVENT_ID = "sqm-2026" as const;
export const SQM_FIXTURE_EVENT_NAME = "Schweizer Quadball Meisterschaft 2026" as const;
export const SQM_FIXTURE_TIME_ZONE = "Europe/Zurich" as const;
export const SQM_FIXTURE_GAME_DAY = "2026-08-16" as const;

export function createSqmFixtureEvent(nowMs: number): PublicAudienceEventProjection {
  return {
    eventId: SQM_FIXTURE_EVENT_ID,
    name: SQM_FIXTURE_EVENT_NAME,
    timeZone: SQM_FIXTURE_TIME_ZONE,
    publicationStatus: "published",
    gameDays: [SQM_FIXTURE_GAME_DAY],
    lifecycle: classifySqmFixtureLifecycle(nowMs),
    canonicalPath: `/events/${encodeURIComponent(SQM_FIXTURE_EVENT_ID)}`,
    teams: [],
    pitches: [],
    schedule: {
      asOfMs: nowMs,
      runningGames: [],
      upcomingGames: [],
      scheduleGames: [],
      focusIndex: null,
    },
  };
}

function classifySqmFixtureLifecycle(nowMs: number): PublicAudienceEventProjection["lifecycle"] {
  const today = localDate(nowMs, SQM_FIXTURE_TIME_ZONE);
  return today < SQM_FIXTURE_GAME_DAY
    ? "future"
    : today === SQM_FIXTURE_GAME_DAY
      ? "current"
      : "past";
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
