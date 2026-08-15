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
import type { ClockProjection } from "@/lib/clock-authority";
import type { GamePresentation } from "@/lib/game-presentation";

export type PublicAudienceEventLifecycle = "unscheduled" | "current" | "future" | "past";

export type PublicAudienceEventTeam = {
  name: string;
  color: string;
};

export type PublicAudiencePitch = {
  name: string;
};

export type PublicAudienceEventGameInput = {
  eventGameId: string;
  sides: readonly [
    { gameSideId: string; eventTeamId: string | null; eventTeamName: string | null },
    { gameSideId: string; eventTeamId: string | null; eventTeamName: string | null },
  ];
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
};

export type PublicAudienceTeamTimeout = {
  status: "inactive" | "stoppage" | "started" | "completed";
  side: "side-a" | "side-b" | null;
  remainingMs: number | null;
};

export type PublicAudienceGameSuspension = "none" | "suspended";

export type PublicAudienceHeatStoppage = {
  status:
    | "inactive"
    | "started"
    | "ended"
    | "skipped"
    | "required-skip"
    | "suppressed"
    | "extended";
  mode: "enabled" | "disabled" | null;
  pending: boolean;
  allowedDurationMs: number | null;
  actualDurationMs: number | null;
  remainingMs: number | null;
};

export type PublicAudienceResult = {
  status: "unfinished" | "finished";
  winner: "side-a" | "side-b" | null;
  locked: boolean;
};

type PublicAudienceGameOperationalProjection =
  | {
      operationalStatus: Exclude<PublicAudienceGameOperationalStatus, "suspended">;
      gameSuspension: "none";
    }
  | {
      operationalStatus: "suspended";
      gameSuspension: "suspended";
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

export type PublicAudienceGameProjection = PublicAudienceGameOperationalProjection & {
  eventId: string;
  gameCode: string | null;
  gameDesignation: string | null;
  scheduledStartMs: number;
  expectedStartMs: number;
  scheduleStatus: PublicAudienceGameScheduleStatus;
  phase: PublicAudienceGamePhase;
  pitch: string | null;
  sideA: PublicAudienceGameSide;
  sideB: PublicAudienceGameSide;
  overtimeTarget: number | null;
  clock: PublicAudienceClockProjection | null;
  teamTimeout: PublicAudienceTeamTimeout;
  heatStoppage: PublicAudienceHeatStoppage;
  flagState: { catchingSide: "side-a" | "side-b" | null };
  result: PublicAudienceResult;
  presentation: {
    pitchOrientation: "side-a-left" | "side-b-left";
    displayedTeamColors: { sideA: string | null; sideB: string | null };
  };
  canonicalPath: string;
};

/** Allowlisted, server-side input for one public Audience Projection. */
export type AudienceProjectionGameInput = {
  gameSideIds: readonly [string, string];
  phase: PublicAudienceGamePhase;
  operationalStatus: PublicAudienceGameOperationalStatus;
  scoreByGameSide: Readonly<Record<string, number>>;
  clock: ClockProjection | null;
  presentation: GamePresentation | null;
  overtimeTarget: number | null;
  teamTimeout: {
    status: PublicAudienceTeamTimeout["status"];
    gameSideId: string | null;
    remainingMs: number | null;
  };
  heatStoppage: PublicAudienceHeatStoppage;
  winnerGameSideId: string | null;
  catchingGameSideId: string | null;
  locked: boolean;
};

export type AudienceProjectionGameInputOutcome =
  | { status: "accepted"; value: AudienceProjectionGameInput }
  | { status: "unavailable" }
  | { status: "retryable-failure" };

export type AudienceProjectionGameInputReader = {
  read(eventGameId: string): Promise<AudienceProjectionGameInputOutcome>;
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
  /** Neutral public state; correction reasons, audit rows, and provenance stay private. */
  identityNotice?: "event-team-identities-current";
  /** Allowlisted identity input for downstream roster and public Timeline composition. */
  eventGames?: readonly PublicAudienceEventGameInput[];
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
  gameInput?: AudienceProjectionGameInputReader;
};

export type AudienceProjectionReader = {
  read(eventId: unknown): Promise<AudienceProjectionOutcome>;
  readGame(
    eventId: unknown,
    eventGameId: unknown,
  ): Promise<
    | { status: "accepted"; value: PublicAudienceGameProjection }
    | { status: "unavailable" }
    | { status: "retryable-failure" }
  >;
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
    async readGame(eventId: unknown, eventGameId: unknown) {
      if (
        typeof eventId !== "string" ||
        eventId.trim().length === 0 ||
        typeof eventGameId !== "string" ||
        eventGameId.trim().length === 0 ||
        options.gameInput === undefined
      )
        return { status: "unavailable" };
      try {
        const snapshot = await storage.snapshot();
        const event = snapshot.findEvent(eventId);
        const game = snapshot.findEventGame(eventGameId);
        if (
          event === null ||
          event.publicationStatus !== "published" ||
          game === null ||
          game.eventId !== eventId
        )
          return { status: "unavailable" };
        const input = await options.gameInput.read(eventGameId);
        if (input.status !== "accepted") return input;
        const projected = projectScheduleGames(snapshot, [game]).at(0);
        if (projected === undefined) return { status: "unavailable" };
        return {
          status: "accepted",
          value: projectAudienceGameFromInput(snapshot, event, projected, input.value, now()),
        };
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
    identityNotice: "event-team-identities-current",
    eventGames: snapshot
      .listGameDays(event.eventId)
      .flatMap((day) => snapshot.listEventGames(day.gameDayId))
      .map((game) => ({
        eventGameId: game.eventGameId,
        sides: [
          {
            gameSideId: game.sideA.sideId,
            eventTeamId: game.sideA.eventTeamId,
            eventTeamName: game.sideA.eventTeamName,
          },
          {
            gameSideId: game.sideB.sideId,
            eventTeamId: game.sideB.eventTeamId,
            eventTeamName: game.sideB.eventTeamName,
          },
        ],
      })) as PublicAudienceEventGameInput[],
    schedule: projectSchedule(snapshot, event, nowMs),
  };
}

function projectAudienceGameFromInput(
  snapshot: EventCatalogStorageSnapshot,
  event: StoredEvent,
  game: ProjectedEventGame,
  input: AudienceProjectionGameInput,
  nowMs: number,
): PublicAudienceGameProjection {
  const sideA = projectAudienceGameSideFromInput(snapshot, game.sideA, input, "a");
  const sideB = projectAudienceGameSideFromInput(snapshot, game.sideB, input, "b");
  const winner = sideForGameSideId(input.winnerGameSideId, input.gameSideIds);
  const pitchSlot = snapshot.findPitchSlot(game.pitchSlotId);
  const pitch = pitchSlot === null ? null : (snapshot.findPitch(pitchSlot.pitchId)?.name ?? null);
  const multiplePitches = snapshot.listPitches(event.eventId).length > 1;
  return {
    eventId: event.eventId,
    gameCode: game.gameCode,
    gameDesignation: game.gameDesignation,
    scheduledStartMs: scheduledStartForGame(snapshot, game),
    expectedStartMs: game.expectedStartMs,
    scheduleStatus: classifyScheduleStatus(
      input.operationalStatus === "finished"
        ? "finished"
        : input.operationalStatus === "suspended"
          ? "suspended"
          : input.operationalStatus === "scheduled"
            ? "scheduled"
            : "in-progress",
      game.expectedStartMs,
      nowMs,
    ),
    phase: input.phase,
    ...publicOperationalProjection(input.operationalStatus),
    pitch: multiplePitches ? pitch : null,
    sideA,
    sideB,
    overtimeTarget: input.overtimeTarget,
    clock: projectClock(input.clock),
    teamTimeout: {
      status: input.teamTimeout.status,
      side: sideForGameSideId(input.teamTimeout.gameSideId, input.gameSideIds),
      remainingMs: input.teamTimeout.remainingMs,
    },
    heatStoppage: structuredClone(input.heatStoppage),
    flagState: {
      catchingSide: sideForGameSideId(input.catchingGameSideId, input.gameSideIds),
    },
    result: {
      status: input.operationalStatus === "finished" ? "finished" : "unfinished",
      winner,
      locked: input.locked,
    },
    presentation: {
      pitchOrientation: input.presentation?.pitchOrientation ?? "side-a-left",
      displayedTeamColors: {
        sideA: sideA.color,
        sideB: sideB.color,
      },
    },
    canonicalPath: `/events/${encodeURIComponent(event.eventId)}/games/${encodeURIComponent(game.eventGameId)}`,
  };
}

function projectAudienceGameSideFromInput(
  snapshot: EventCatalogStorageSnapshot,
  side: EventGame["sideA"],
  input: AudienceProjectionGameInput,
  sideLabel: "a" | "b",
): PublicAudienceGameSide {
  const eventColor =
    side.eventTeamId === null
      ? null
      : (snapshot.findEventTeam(side.eventTeamId)?.defaultColor ?? null);
  const gameSideId = input.gameSideIds[sideLabel === "a" ? 0 : 1]!;
  return {
    name: side.eventTeamName ?? side.sourceLabel,
    color: input.presentation?.displayedTeamColors[gameSideId] ?? eventColor,
    score: input.scoreByGameSide[gameSideId] ?? null,
  };
}

function sideForGameSideId(
  gameSideId: string | null,
  gameSideIds: readonly [string, string] | undefined,
): "side-a" | "side-b" | null {
  if (gameSideIds === undefined) return null;
  return gameSideId === gameSideIds[0] ? "side-a" : gameSideId === gameSideIds[1] ? "side-b" : null;
}

function projectSchedule(
  snapshot: EventCatalogStorageSnapshot,
  event: StoredEvent,
  nowMs: number,
): PublicAudienceScheduleProjection {
  const eventId = event.eventId;
  const gamesById = new Map<string, EventGame>();
  for (const gameDay of snapshot.listGameDays(eventId)) {
    for (const game of snapshot.listEventGames(gameDay.gameDayId)) {
      if (game.eventId !== eventId || gamesById.has(game.eventGameId)) continue;
      gamesById.set(game.eventGameId, game);
    }
  }

  const projected = projectScheduleGames(snapshot, [...gamesById.values()])
    .map((game) =>
      projectAudienceGameFromInput(
        snapshot,
        event,
        game,
        readAudienceProjectionGameInputFromCatalog(snapshot, game, nowMs),
        nowMs,
      ),
    )
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

function readAudienceProjectionGameInputFromCatalog(
  snapshot: EventCatalogStorageSnapshot,
  game: ProjectedEventGame,
  nowMs: number,
): AudienceProjectionGameInput {
  const root = snapshot.findRootByEventGameId(game.eventGameId);
  const derived = root === null ? null : readDerivedState(snapshot, root);
  const lifecyclePhase = derived?.phase ?? root?.lifecycle.phase ?? "scheduled";
  const gameSideIds = [
    root?.gameSides[0]?.id ?? game.sideA.sideId,
    root?.gameSides[1]?.id ?? game.sideB.sideId,
  ] as const;
  const clock = derived === null ? null : projectClockBaseline(derived.clock.baseline, nowMs);
  return {
    gameSideIds,
    phase: projectGamePhase(derived),
    operationalStatus: operationalStatus(lifecyclePhase, derived),
    scoreByGameSide: structuredClone(derived?.scoreByGameSide ?? {}),
    clock,
    presentation:
      derived?.presentation === undefined ? null : structuredClone(derived.presentation),
    overtimeTarget: derived?.overtimeTarget ?? null,
    teamTimeout: {
      status: derived?.timeout.status ?? "inactive",
      gameSideId: derived?.timeout.gameSideId ?? null,
      remainingMs: derived?.timeout.remainingMs ?? null,
    },
    heatStoppage: {
      status: derived?.heat.status ?? "inactive",
      mode: derived?.heat.mode ?? null,
      pending: (derived?.heat.pendingTriggerGameTimeMs ?? null) !== null,
      allowedDurationMs: derived?.heat.allowedDurationMs ?? null,
      actualDurationMs: derived?.heat.actualDurationMs ?? null,
      remainingMs: heatRemainingMs(derived?.heat.allowedDurationMs, derived?.heat.actualDurationMs),
    },
    winnerGameSideId: derived?.winnerGameSideId ?? null,
    catchingGameSideId: derived?.catch?.catchingGameSideId ?? null,
    locked: root?.lifecycle.lockedAtMs !== null && root?.lifecycle.lockedAtMs !== undefined,
  };
}

function heatRemainingMs(
  allowedDurationMs: number | null | undefined,
  actualDurationMs: number | null | undefined,
) {
  if (
    allowedDurationMs === null ||
    allowedDurationMs === undefined ||
    actualDurationMs === null ||
    actualDurationMs === undefined
  )
    return null;
  return Math.max(0, allowedDurationMs - actualDurationMs);
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

function publicOperationalProjection(
  operationalStatus: PublicAudienceGameOperationalStatus,
): PublicAudienceGameOperationalProjection {
  return operationalStatus === "suspended"
    ? { operationalStatus, gameSuspension: "suspended" }
    : { operationalStatus, gameSuspension: "none" };
}

function projectClock(clock: ClockProjection | null): PublicAudienceClockProjection | null {
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
