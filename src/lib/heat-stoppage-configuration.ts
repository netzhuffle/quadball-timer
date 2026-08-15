import type { FoundationStorageSnapshot } from "@/lib/foundation-storage";

export type HeatStoppageConfiguration = "enabled" | "disabled";

export const DEFAULT_HEAT_STOPPAGE_CONFIGURATION =
  "disabled" as const satisfies HeatStoppageConfiguration;

export type HeatStoppageConfigurationScope = {
  eventId: string;
  gameDayId: string;
  eventGameId: string;
};

/** Resolve the Event Administration-owned value inside the caller's transaction. */
export function resolveHeatStoppageConfiguration(
  snapshot: FoundationStorageSnapshot,
  scope: unknown,
): HeatStoppageConfiguration | null {
  try {
    if (!isScope(scope) || typeof snapshot.findEventGame !== "function") return null;

    const event = snapshot.findEvent(scope.eventId);
    if (!isRecord(event) || event.eventId !== scope.eventId) return null;

    const gameDays = snapshot.listGameDays(scope.eventId);
    if (!Array.isArray(gameDays)) return null;
    const gameDay = gameDays.find((candidate) => candidate?.gameDayId === scope.gameDayId);
    if (
      !isRecord(gameDay) ||
      gameDay.gameDayId !== scope.gameDayId ||
      gameDay.eventId !== scope.eventId ||
      !isHeatStoppageConfiguration(gameDay.heatStoppageConfiguration)
    ) {
      return null;
    }

    const eventGame = snapshot.findEventGame(scope.eventGameId);
    if (
      !isRecord(eventGame) ||
      eventGame.eventGameId !== scope.eventGameId ||
      eventGame.eventId !== scope.eventId ||
      eventGame.gameDayId !== scope.gameDayId
    ) {
      return null;
    }

    return gameDay.heatStoppageConfiguration;
  } catch {
    return null;
  }
}

function isHeatStoppageConfiguration(value: unknown): value is HeatStoppageConfiguration {
  return value === "enabled" || value === "disabled";
}

function isScope(value: unknown): value is HeatStoppageConfigurationScope {
  return (
    isRecord(value) &&
    typeof value.eventId === "string" &&
    typeof value.gameDayId === "string" &&
    typeof value.eventGameId === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
