import {
  EVENT_ADMIN_GRANT_TYPE,
  PITCH_MANAGER_GRANT_TYPE,
  type EventAdminGrantScope,
  type GrantScope,
  type GrantType,
  type PitchManagerGrantScope,
} from "@/lib/grant-types";

export const DAY_MS = 24 * 60 * 60 * 1000;

export function resolveGrantExpiry(
  type: GrantType,
  scope: GrantScope,
  explicit: number | null,
): number | null {
  if (explicit !== null) return explicit;
  return type === PITCH_MANAGER_GRANT_TYPE
    ? atEventTime(
        addDays((scope as PitchManagerGrantScope).gameDayDate, 1),
        (scope as PitchManagerGrantScope).eventTimeZone,
      )
    : type === EVENT_ADMIN_GRANT_TYPE
      ? atEventTime(
          addDays((scope as EventAdminGrantScope).finalGameDayDate, 7),
          (scope as EventAdminGrantScope).eventTimeZone,
        )
      : null;
}

export function grantExpiryCap(type: GrantType, scope: GrantScope): number {
  if (type === PITCH_MANAGER_GRANT_TYPE) {
    const value = scope as PitchManagerGrantScope;
    return atEventTime(addDays(value.gameDayDate, 1), value.eventTimeZone);
  }
  if (type === EVENT_ADMIN_GRANT_TYPE) {
    const value = scope as EventAdminGrantScope;
    return atEventTime(addDays(value.finalGameDayDate, 7), value.eventTimeZone);
  }
  return Number.MAX_SAFE_INTEGER;
}

export function atEventTime(date: string, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const target = `${date} 04:30`;
  const center = Date.parse(`${date}T04:30:00Z`);
  for (let delta = -48 * 60; delta <= 48 * 60; delta += 1) {
    const candidate = center + delta * 60_000;
    const parts = Object.fromEntries(
      formatter
        .formatToParts(candidate)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    if (`${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}` === target)
      return candidate;
  }
  throw new Error("Unable to resolve Event time.");
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
