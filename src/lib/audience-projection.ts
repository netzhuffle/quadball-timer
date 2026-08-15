import type {
  EventCatalogFoundationStorage,
  EventCatalogStorageSnapshot,
  EventGame,
  ProjectedEventGame,
  StoredEvent,
} from "@/lib/event-catalog";
import { projectScheduleGames } from "@/lib/event-catalog";
import { projectClockBaseline } from "@/lib/clock-authority";
import {
  projectLiveEventGameDerivedState,
  type LiveEventGameDerivedState,
} from "@/lib/live-event-game-control";

export type PublicAudienceEventLifecycle = "unscheduled" | "current" | "future" | "past";

export type PublicAudienceEventTeam = {
  name: string;
  color: string;
};

export type PublicAudiencePitch = {
  name: string;
};

export type PublicAudienceGameScheduleStatus = "past" | "running" | "awaiting-start" | "future";

export type PublicAudienceGamePhase = "seeker-floor" | "seekers-released" | "overtime";

export type PublicAudienceGameOperationalStatus =
  | "scheduled"
  | "running"
  | "paused"
  | "suspended"
  | "finished";

export type PublicAudienceGameSide = {
  name: string | null;
  color: string | null;
  score: number | null;
  flagCatch: boolean;
};

export type PublicAudienceClockProjection = {
  gameTimeMs: number;
  activePenaltyTimeMs: number;
  running: boolean;
  projectedAtMs: number;
  synchronization: "synchronized" | "estimated" | "stale" | "unavailable";
  lastSynchronizedAtMs: number | null;
  cues: LiveEventGameDerivedState["clock"]["cues"];
};

export type PublicAudienceGameProjection = {
  gameCode: string | null;
  gameDesignation: string | null;
  scheduledStartMs: number;
  expectedStartMs: number;
  scheduleStatus: PublicAudienceGameScheduleStatus;
  phase: PublicAudienceGamePhase;
  operationalStatus: PublicAudienceGameOperationalStatus;
  pitch: string | null;
  sideA: PublicAudienceGameSide;
  sideB: PublicAudienceGameSide;
  winner: "side-a" | "side-b" | null;
  overtimeTarget: number | null;
  clock: PublicAudienceClockProjection | null;
};

export type PublicAudienceScheduleProjection = {
  asOfMs: number;
  runningGames: readonly PublicAudienceGameProjection[];
  upcomingGames: readonly PublicAudienceGameProjection[];
  scheduleGames: readonly PublicAudienceGameProjection[];
  focusIndex: number | null;
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
  schedule: PublicAudienceScheduleProjection;
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
    schedule: projectSchedule(snapshot, event.eventId, nowMs),
  };
}

function projectSchedule(
  snapshot: EventCatalogStorageSnapshot,
  eventId: string,
  nowMs: number,
): PublicAudienceScheduleProjection {
  const gamesById = new Map<string, EventGame>();
  for (const gameDay of snapshot.listGameDays(eventId)) {
    for (const game of snapshot.listEventGames(gameDay.gameDayId)) {
      if (game.eventId !== eventId || gamesById.has(game.eventGameId)) continue;
      gamesById.set(game.eventGameId, game);
    }
  }

  const multiplePitches = snapshot.listPitches(eventId).length > 1;
  const projected = projectScheduleGames(snapshot, [...gamesById.values()])
    .map((game) => projectAudienceGame(snapshot, game, nowMs, multiplePitches))
    .sort(compareAudienceGames);
  const runningGames = projected.filter((game) => game.scheduleStatus === "running");
  const upcomingGames = projected.filter(
    (game) =>
      game.scheduleStatus === "future" &&
      game.expectedStartMs >= nowMs &&
      game.expectedStartMs < nowMs + 60 * 60 * 1000,
  );
  const focusIndex = findScheduleFocusIndex(projected);

  return {
    asOfMs: nowMs,
    runningGames,
    upcomingGames,
    scheduleGames: projected,
    focusIndex,
  };
}

function projectAudienceGame(
  snapshot: EventCatalogStorageSnapshot,
  game: ProjectedEventGame,
  nowMs: number,
  multiplePitches: boolean,
): PublicAudienceGameProjection {
  const root = snapshot.findRootByEventGameId(game.eventGameId);
  const derived = root === null ? null : readDerivedState(snapshot, root);
  const lifecyclePhase = derived?.phase ?? root?.lifecycle.phase ?? "scheduled";
  const phase = projectGamePhase(derived);
  const pitchSlot = snapshot.findPitchSlot(game.pitchSlotId);
  const pitch = pitchSlot === null ? null : (snapshot.findPitch(pitchSlot.pitchId)?.name ?? null);
  const sideA = projectAudienceGameSide(snapshot, game.sideA, derived, root, "a");
  const sideB = projectAudienceGameSide(snapshot, game.sideB, derived, root, "b");
  const winner = winnerSide(derived, root);

  return {
    gameCode: game.gameCode,
    gameDesignation: game.gameDesignation,
    scheduledStartMs: scheduledStartForGame(snapshot, game),
    expectedStartMs: game.expectedStartMs,
    scheduleStatus: classifyScheduleStatus(lifecyclePhase, game.expectedStartMs, nowMs),
    phase,
    operationalStatus: operationalStatus(lifecyclePhase, derived),
    pitch: multiplePitches ? pitch : null,
    sideA,
    sideB,
    winner,
    overtimeTarget: derived?.overtimeTarget ?? null,
    clock: projectClock(
      derived === null ? null : projectClockBaseline(derived.clock.baseline, nowMs),
    ),
  };
}

function readDerivedState(
  snapshot: EventCatalogStorageSnapshot,
  root: NonNullable<ReturnType<EventCatalogStorageSnapshot["findRootByEventGameId"]>>,
): LiveEventGameDerivedState {
  const derived = projectLiveEventGameDerivedState(root, snapshot.listActions(root.recordId));
  if (derived === null) {
    throw new Error("Committed Event Game state cannot be rebuilt.");
  }
  return derived;
}

function projectAudienceGameSide(
  snapshot: EventCatalogStorageSnapshot,
  side: EventGame["sideA"],
  derived: LiveEventGameDerivedState | null,
  root: ReturnType<EventCatalogStorageSnapshot["findRootByEventGameId"]>,
  sideLabel: "a" | "b",
): PublicAudienceGameSide {
  const color =
    side.eventTeamId === null
      ? null
      : (snapshot.findEventTeam(side.eventTeamId)?.defaultColor ?? null);
  const rootSide = root?.gameSides[sideLabel === "a" ? 0 : 1];
  const score =
    derived === null || rootSide === undefined
      ? null
      : (derived.scoreByGameSide[rootSide.id] ?? null);
  const flagCatch =
    derived?.catch !== null &&
    derived?.catch !== undefined &&
    rootSide !== undefined &&
    derived.catch.catchingGameSideId === rootSide.id;
  return {
    name: side.eventTeamName ?? side.sourceLabel,
    color,
    score,
    flagCatch,
  };
}

function scheduledStartForGame(snapshot: EventCatalogStorageSnapshot, game: ProjectedEventGame) {
  return snapshot.findGameplaySlot(game.gameplaySlotId)?.scheduledStartMs ?? game.expectedStartMs;
}

function projectGamePhase(derived: LiveEventGameDerivedState | null): PublicAudienceGamePhase {
  if (derived?.overtime === true) return "overtime";
  return derived?.clock.cues.seekerRelease === "released" ? "seekers-released" : "seeker-floor";
}

function classifyScheduleStatus(
  phase: LiveEventGameDerivedState["phase"] | "scheduled",
  expectedStartMs: number,
  nowMs: number,
): PublicAudienceGameScheduleStatus {
  if (phase === "finished") return "past";
  if (phase === "in-progress" || phase === "suspended") return "running";
  return expectedStartMs <= nowMs ? "awaiting-start" : "future";
}

function operationalStatus(
  phase: LiveEventGameDerivedState["phase"] | "scheduled",
  derived: LiveEventGameDerivedState | null,
): PublicAudienceGameOperationalStatus {
  return phase === "in-progress"
    ? derived?.clock.running === false
      ? "paused"
      : "running"
    : phase === "suspended"
      ? "suspended"
      : phase === "finished"
        ? "finished"
        : "scheduled";
}

function winnerSide(
  derived: LiveEventGameDerivedState | null,
  root: ReturnType<EventCatalogStorageSnapshot["findRootByEventGameId"]>,
): "side-a" | "side-b" | null {
  if (
    derived?.winnerGameSideId === null ||
    derived?.winnerGameSideId === undefined ||
    root === null
  )
    return null;
  if (root.gameSides[0]?.id === derived.winnerGameSideId) return "side-a";
  if (root.gameSides[1]?.id === derived.winnerGameSideId) return "side-b";
  return null;
}

function projectClock(
  clock: LiveEventGameDerivedState["clock"] | null,
): PublicAudienceClockProjection | null {
  if (clock === null) return null;
  return {
    gameTimeMs: clock.gameTimeMs,
    activePenaltyTimeMs: clock.activePenaltyTimeMs,
    running: clock.running,
    projectedAtMs: clock.projectedAtMs,
    synchronization: clock.synchronization,
    lastSynchronizedAtMs: clock.lastSynchronizedAtMs,
    cues: structuredClone(clock.cues),
  };
}

function compareAudienceGames(
  left: PublicAudienceGameProjection,
  right: PublicAudienceGameProjection,
): number {
  return (
    left.expectedStartMs - right.expectedStartMs ||
    left.scheduledStartMs - right.scheduledStartMs ||
    (left.gameCode ?? left.gameDesignation ?? "").localeCompare(
      right.gameCode ?? right.gameDesignation ?? "",
    )
  );
}

function findScheduleFocusIndex(games: readonly PublicAudienceGameProjection[]): number | null {
  if (games.length === 0) return null;
  const active = games.findIndex(
    (game) => game.scheduleStatus === "running" || game.scheduleStatus === "awaiting-start",
  );
  if (active >= 0) return active;
  const future = games.findIndex((game) => game.scheduleStatus === "future");
  return future >= 0 ? future : games.length - 1;
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
