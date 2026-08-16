import { createInitialClockBaseline, projectClockBaseline } from "@/lib/clock-authority";
import type { GameView } from "@/lib/game-types";
import type {
  PublicAudienceEventProjection,
  PublicAudienceGameProjection,
  PublicAudienceScheduleProjection,
} from "@/lib/audience-projection";
import { DEFAULT_AWAY_TEAM_COLOR, DEFAULT_HOME_TEAM_COLOR } from "@/lib/team-colors";

export const SQM_FIXTURE_EVENT_ID = "sqm-2026" as const;
export const SQM_FIXTURE_EVENT_NAME = "Schweizer Quadball Meisterschaft 2026" as const;
export const SQM_FIXTURE_TIME_ZONE = "Europe/Zurich" as const;
export const SQM_FIXTURE_GAME_DAY = "2026-08-16" as const;

export type SqmFixtureKey = "secret1" | "secret2" | "secret3" | "secret4";

export type SqmFixtureGameDefinition = {
  key: SqmFixtureKey;
  scheduledStartMs: number;
  gameDesignation: string;
  homeName: string;
  awayName: string;
  homeColor: string;
  awayColor: string;
};

export const SQM_FIXTURE_GAMES: readonly SqmFixtureGameDefinition[] = [
  {
    key: "secret1",
    scheduledStartMs: Date.parse("2026-08-16T07:30:00.000Z"),
    gameDesignation: "9:30",
    homeName: "Basel Basilisks / Luzern",
    awayName: "Berner Boggarts",
    homeColor: "#16a34a",
    awayColor: "#7f1d1d",
  },
  {
    key: "secret2",
    scheduledStartMs: Date.parse("2026-08-16T08:30:00.000Z"),
    gameDesignation: "10:30",
    homeName: "Turicum Thunderbirds",
    awayName: "Berner Boggarts",
    homeColor: "#facc15",
    awayColor: "#7f1d1d",
  },
  {
    key: "secret3",
    scheduledStartMs: Date.parse("2026-08-16T09:30:00.000Z"),
    gameDesignation: "11:30",
    homeName: "Turicum Thunderbirds",
    awayName: "Basel Basilisks / Luzern",
    homeColor: "#facc15",
    awayColor: "#16a34a",
  },
  {
    key: "secret4",
    scheduledStartMs: Date.parse("2026-08-16T11:00:00.000Z"),
    gameDesignation: "13:00",
    homeName: "Friendlies",
    awayName: "Kidditch",
    homeColor: DEFAULT_HOME_TEAM_COLOR,
    awayColor: DEFAULT_AWAY_TEAM_COLOR,
  },
];

export function getSqmFixtureGame(key: unknown): SqmFixtureGameDefinition | null {
  return SQM_FIXTURE_GAMES.find((game) => game.key === key) ?? null;
}

export function isSqmFixtureKey(value: unknown): value is SqmFixtureKey {
  return getSqmFixtureGame(value) !== null;
}

export function isSqmFixtureActivationDate(nowMs: number): boolean {
  return localDate(nowMs, SQM_FIXTURE_TIME_ZONE) === SQM_FIXTURE_GAME_DAY;
}

export function createSqmFixtureEvent(
  nowMs: number,
  schedule: PublicAudienceScheduleProjection = emptySqmSchedule(nowMs),
): PublicAudienceEventProjection {
  const teams = new Map<string, string>();
  for (const game of SQM_FIXTURE_GAMES) {
    teams.set(game.homeName, game.homeColor);
    teams.set(game.awayName, game.awayColor);
  }
  return {
    eventId: SQM_FIXTURE_EVENT_ID,
    name: SQM_FIXTURE_EVENT_NAME,
    timeZone: SQM_FIXTURE_TIME_ZONE,
    publicationStatus: "published",
    gameDays: [SQM_FIXTURE_GAME_DAY],
    lifecycle: classifySqmFixtureLifecycle(nowMs),
    canonicalPath: `/events/${encodeURIComponent(SQM_FIXTURE_EVENT_ID)}`,
    teams: [...teams].map(([name, color]) => ({ name, color })),
    pitches: [],
    schedule,
  };
}

export function createSqmFixtureGameProjection(
  definition: SqmFixtureGameDefinition,
  game: GameView | null,
  gameId: string | null,
  nowMs: number,
): PublicAudienceGameProjection {
  const state = game?.state;
  const isFinished = state?.isFinished === true;
  const isSuspended = state?.isSuspended === true;
  const isRunning = state?.isRunning === true;
  const operationalProjection = isSuspended
    ? { operationalStatus: "suspended" as const, gameSuspension: "suspended" as const }
    : {
        operationalStatus: isFinished
          ? ("finished" as const)
          : isRunning
            ? ("running" as const)
            : ("scheduled" as const),
        gameSuspension: "none" as const,
      };
  const scheduleStatus = isFinished
    ? ("past" as const)
    : isRunning || isSuspended
      ? ("running" as const)
      : definition.scheduledStartMs <= nowMs
        ? ("awaiting-start" as const)
        : ("future" as const);
  const clock = state === undefined ? null : projectFixtureClock(state, nowMs);
  const winner = state?.winner === "home" ? "side-a" : state?.winner === "away" ? "side-b" : null;
  const catchingSide =
    state?.flagCatch?.team === "home"
      ? "side-a"
      : state?.flagCatch?.team === "away"
        ? "side-b"
        : null;
  return {
    eventId: SQM_FIXTURE_EVENT_ID,
    eventGameId: definition.key,
    gameCode: null,
    gameDesignation: definition.gameDesignation,
    scheduledStartMs: definition.scheduledStartMs,
    expectedStartMs: definition.scheduledStartMs,
    scheduleStatus,
    phase:
      state?.isOvertime === true
        ? "overtime"
        : game?.seekerReleased === true
          ? "seekers-released"
          : "seeker-floor",
    pitch: null,
    sideA: {
      name: state?.homeName ?? definition.homeName,
      color: state?.homeColor ?? definition.homeColor,
      score: state?.score.home ?? null,
    },
    sideB: {
      name: state?.awayName ?? definition.awayName,
      color: state?.awayColor ?? definition.awayColor,
      score: state?.score.away ?? null,
    },
    overtimeTarget: null,
    clock,
    teamTimeout: {
      status:
        state?.timeouts.active === null || state?.timeouts.active === undefined
          ? "inactive"
          : "started",
      side:
        state?.timeouts.active?.team === "home"
          ? "side-a"
          : state?.timeouts.active?.team === "away"
            ? "side-b"
            : null,
      remainingMs: state?.timeouts.active?.remainingMs ?? null,
    },
    heatStoppage: {
      status: "inactive",
      mode: "disabled",
      pending: false,
      allowedDurationMs: null,
      actualDurationMs: null,
      remainingMs: null,
    },
    flagState: { catchingSide },
    result: {
      status: isFinished ? "finished" : "unfinished",
      winner,
      locked: false,
    },
    ...operationalProjection,
    presentation: {
      pitchOrientation: state?.displaySidesSwapped === true ? "side-b-left" : "side-a-left",
      displayedTeamColors: {
        sideA: state?.homeColor ?? definition.homeColor,
        sideB: state?.awayColor ?? definition.awayColor,
      },
    },
    canonicalPath: `/events/${encodeURIComponent(SQM_FIXTURE_EVENT_ID)}/games/${encodeURIComponent(definition.key)}`,
    timeline: [],
    spectatorAvailable: gameId !== null,
  };
}

export function createSqmFixtureSchedule(
  games: readonly PublicAudienceGameProjection[],
  nowMs: number,
): PublicAudienceScheduleProjection {
  const scheduleGames = [...games].sort(
    (left, right) => left.expectedStartMs - right.expectedStartMs,
  );
  const runningGames = scheduleGames.filter((game) => game.scheduleStatus === "running");
  const upcomingGames = scheduleGames.filter(
    (game) =>
      game.scheduleStatus === "future" &&
      game.expectedStartMs >= nowMs &&
      game.expectedStartMs < nowMs + 60 * 60 * 1000,
  );
  const activeIndex = scheduleGames.findIndex(
    (game) => game.scheduleStatus === "running" || game.scheduleStatus === "awaiting-start",
  );
  const futureIndex = scheduleGames.findIndex((game) => game.scheduleStatus === "future");
  return {
    asOfMs: nowMs,
    runningGames,
    upcomingGames,
    scheduleGames,
    focusIndex:
      scheduleGames.length === 0
        ? null
        : activeIndex >= 0
          ? activeIndex
          : futureIndex >= 0
            ? futureIndex
            : scheduleGames.length - 1,
  };
}

function emptySqmSchedule(nowMs: number): PublicAudienceScheduleProjection {
  return {
    asOfMs: nowMs,
    runningGames: [],
    upcomingGames: [],
    scheduleGames: [],
    focusIndex: null,
  };
}

function projectFixtureClock(state: GameView["state"], nowMs: number) {
  const baseline = {
    ...createInitialClockBaseline(),
    gameTimeMs: state.gameClockMs,
    running: false,
    establishedAtMs: state.updatedAtMs,
    lastAcceptedAtMs: state.updatedAtMs,
  };
  return projectClockBaseline(baseline, nowMs);
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
