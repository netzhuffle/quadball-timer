import type {
  CardType,
  GameCommand,
  GameState,
  GameSummary,
  GameView,
  PendingPenaltyExpiration,
  PlayerPenaltyState,
  ScoreEvent,
  TeamId,
} from "@/lib/game-types";

const ONE_MINUTE_MS = 60_000;
const SEEKER_RELEASE_MS = 20 * ONE_MINUTE_MS;
const SEEKER_COUNTDOWN_START_MS = 19 * ONE_MINUTE_MS;
const TIMEOUT_REMINDER_MS = 15_000;

export type IdGenerator = () => string;

export function createInitialGameState({
  id,
  nowMs,
  homeName = "Home",
  awayName = "Away",
}: {
  id: string;
  nowMs: number;
  homeName?: string;
  awayName?: string;
}): GameState {
  return {
    id,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    homeName,
    awayName,
    gameClockMs: 0,
    isRunning: false,
    isFinished: false,
    score: {
      home: 0,
      away: 0,
    },
    scoreEvents: [],
    cardEvents: [],
    players: {},
    pendingExpirations: [],
    flagCatch: null,
    timeouts: {
      home: { used: false },
      away: { used: false },
      active: null,
    },
    nextUnknownPlayerId: {
      home: 1,
      away: 1,
    },
  };
}

export function cloneGameState(state: GameState): GameState {
  return structuredClone(state);
}

export function projectGameView(state: GameState, nowMs: number): GameView {
  const advanced = advanceGameState(state, nowMs);
  const seekerReleaseCountdownMs =
    advanced.gameClockMs >= SEEKER_COUNTDOWN_START_MS
      ? Math.max(0, SEEKER_RELEASE_MS - advanced.gameClockMs)
      : null;

  const activeTimeout = advanced.timeouts.active;
  const timeoutIsRunning =
    activeTimeout !== null && activeTimeout.running && activeTimeout.remainingMs > 0;

  return {
    state: advanced,
    seekerReleaseCountdownMs,
    seekerReleased: advanced.gameClockMs >= SEEKER_RELEASE_MS,
    timeoutReminderActive: timeoutIsRunning,
    timeoutWarningActive: timeoutIsRunning && activeTimeout.remainingMs <= 20_000,
    timeoutFinalCountdown: timeoutIsRunning && activeTimeout.remainingMs <= TIMEOUT_REMINDER_MS,
  };
}

export function projectGameSummary(state: GameState, nowMs: number): GameSummary {
  const advanced = advanceGameState(state, nowMs);

  return {
    id: advanced.id,
    homeName: advanced.homeName,
    awayName: advanced.awayName,
    score: advanced.score,
    gameClockMs: advanced.gameClockMs,
    isRunning: advanced.isRunning,
    isFinished: advanced.isFinished,
    updatedAtMs: advanced.updatedAtMs,
  };
}

export function advanceGameState(state: GameState, nowMs: number): GameState {
  if (nowMs <= state.updatedAtMs) {
    return cloneGameState(state);
  }

  const next = cloneGameState(state);
  const deltaMs = nowMs - next.updatedAtMs;

  if (next.isRunning && !next.isFinished) {
    next.gameClockMs += deltaMs;
    tickPenaltyClock(next, deltaMs);
  }

  if (!next.isRunning && next.timeouts.active?.running) {
    const timeoutDelta = Math.min(deltaMs, next.timeouts.active.remainingMs);
    next.timeouts.active.remainingMs -= timeoutDelta;
    if (next.timeouts.active.remainingMs <= 0) {
      next.timeouts.active = null;
    }
  }

  next.updatedAtMs = nowMs;
  return next;
}

export function applyGameCommand({
  state,
  command,
  nowMs,
  idGenerator,
}: {
  state: GameState;
  command: GameCommand;
  nowMs: number;
  idGenerator?: IdGenerator;
}): GameState {
  const makeId = idGenerator ?? (() => crypto.randomUUID());
  const next = advanceGameState(state, nowMs);

  switch (command.type) {
    case "set-running": {
      if (next.isFinished) {
        return next;
      }

      next.isRunning = command.running;
      if (command.running && next.timeouts.active !== null) {
        next.timeouts.active.running = false;
      }
      return next;
    }

    case "adjust-game-clock": {
      next.gameClockMs = Math.max(0, next.gameClockMs + command.deltaMs);
      return next;
    }

    case "set-game-clock": {
      next.gameClockMs = Math.max(0, command.gameClockMs);
      return next;
    }

    case "change-score": {
      if (command.delta === 0 || command.delta % 10 !== 0) {
        return next;
      }

      if (command.delta < 0 || command.reason === "manual") {
        applyScoreDelta(next, command.team, command.delta);
        return next;
      }

      if (command.reason === "goal") {
        applyPositiveScore({
          state: next,
          team: command.team,
          points: command.delta,
          reason: "goal",
          nowMs,
          idGenerator: makeId,
        });
      }
      return next;
    }

    case "undo-last-score": {
      undoLastScoreForTeam(next, command.team, nowMs);
      return next;
    }

    case "add-card": {
      addCardToPlayer({
        state: next,
        cardType: command.cardType,
        team: command.team,
        playerNumber: command.playerNumber,
        nowMs,
        idGenerator: makeId,
      });
      return next;
    }

    case "confirm-penalty-expiration": {
      confirmPendingExpiration({
        state: next,
        pendingId: command.pendingId,
        playerKey: command.playerKey,
        nowMs,
      });
      return next;
    }

    case "dismiss-penalty-expiration": {
      const pending = next.pendingExpirations.find(
        (expiration) => expiration.id === command.pendingId,
      );
      if (pending !== undefined && pending.resolvedAtMs === null) {
        next.pendingExpirations = next.pendingExpirations.filter(
          (expiration) => expiration.id !== command.pendingId,
        );
      }
      return next;
    }

    case "start-timeout": {
      if (
        next.isRunning ||
        next.isFinished ||
        next.timeouts.active !== null ||
        next.timeouts[command.team].used
      ) {
        return next;
      }

      next.timeouts[command.team].used = true;
      next.timeouts.active = {
        team: command.team,
        running: false,
        remainingMs: ONE_MINUTE_MS,
      };
      return next;
    }

    case "set-timeout-running": {
      if (next.isRunning || next.timeouts.active === null) {
        return next;
      }

      if (command.running) {
        next.timeouts.active.running = next.timeouts.active.remainingMs > 0;
      }
      return next;
    }

    case "undo-timeout-start": {
      const activeTimeout = next.timeouts.active;
      if (activeTimeout !== null && activeTimeout.remainingMs > 0) {
        next.timeouts[activeTimeout.team].used = false;
        next.timeouts.active = null;
      }
      return next;
    }

    case "cancel-timeout": {
      if (next.timeouts.active !== null) {
        next.timeouts.active.running = false;
        next.timeouts.active = null;
      }
      return next;
    }

    case "record-flag-catch": {
      if (next.flagCatch !== null || next.isRunning || next.gameClockMs < SEEKER_RELEASE_MS) {
        return next;
      }

      applyPositiveScore({
        state: next,
        team: command.team,
        points: 30,
        reason: "flag-catch",
        nowMs,
        idGenerator: makeId,
      });
      next.flagCatch = {
        team: command.team,
        createdAtMs: nowMs,
      };
      next.isFinished = true;
      next.isRunning = false;
      if (next.timeouts.active !== null) {
        next.timeouts.active.running = false;
      }
      return next;
    }

    case "rename-teams": {
      const homeName = command.homeName.trim();
      const awayName = command.awayName.trim();
      if (homeName.length > 0) {
        next.homeName = homeName;
      }
      if (awayName.length > 0) {
        next.awayName = awayName;
      }
      return next;
    }

    case "finish-game": {
      next.isFinished = true;
      next.isRunning = false;
      if (next.timeouts.active !== null) {
        next.timeouts.active.running = false;
      }
      return next;
    }

    default: {
      const _exhaustive: never = command;
      return _exhaustive;
    }
  }
}

function applyPositiveScore({
  state,
  team,
  points,
  reason,
  nowMs,
  idGenerator,
}: {
  state: GameState;
  team: TeamId;
  points: number;
  reason: "goal" | "flag-catch";
  nowMs: number;
  idGenerator: IdGenerator;
}) {
  if (points <= 0) {
    return;
  }

  const pendingExpiration = createPendingExpiration({
    state,
    scoringTeam: team,
    nowMs,
    reason: reason === "goal" ? "score" : "flag-catch",
    idGenerator,
  });

  applyScoreDelta(state, team, points);

  const scoreEvent: ScoreEvent = {
    id: idGenerator(),
    team,
    points,
    createdAtMs: nowMs,
    reason,
    pendingExpirationId: pendingExpiration?.id ?? null,
    undoneAtMs: null,
  };

  state.scoreEvents.push(scoreEvent);
}

function applyScoreDelta(state: GameState, team: TeamId, delta: number) {
  const nextScore = Math.max(0, state.score[team] + delta);
  state.score[team] = nextScore;
}

function undoLastScoreForTeam(state: GameState, team: TeamId, nowMs: number) {
  const latestEvent = [...state.scoreEvents]
    .reverse()
    .find((event) => event.team === team && event.reason === "goal" && event.undoneAtMs === null);

  if (latestEvent === undefined) {
    return;
  }

  latestEvent.undoneAtMs = nowMs;
  state.score[team] = Math.max(0, state.score[team] - latestEvent.points);

  if (latestEvent.pendingExpirationId !== null) {
    const pending = state.pendingExpirations.find(
      (expiration) => expiration.id === latestEvent.pendingExpirationId,
    );
    if (pending !== undefined && pending.resolvedAtMs === null) {
      state.pendingExpirations = state.pendingExpirations.filter(
        (expiration) => expiration.id !== latestEvent.pendingExpirationId,
      );
    }
  }
}

function addCardToPlayer({
  state,
  team,
  playerNumber,
  cardType,
  nowMs,
  idGenerator,
}: {
  state: GameState;
  team: TeamId;
  playerNumber: number | null;
  cardType: CardType;
  nowMs: number;
  idGenerator: IdGenerator;
}) {
  if (playerNumber !== null && (playerNumber < 0 || playerNumber > 99)) {
    return;
  }

  let playerKey: string | null = null;

  if (cardType !== "ejection") {
    playerKey = getPlayerKey(state, team, playerNumber);
    const player = getOrCreatePlayer(state, team, playerNumber, playerKey);

    if (cardType === "red") {
      player.segments.push(
        createPenaltySegment({ idGenerator, cardType: "red", expirableByScore: false }),
        createPenaltySegment({ idGenerator, cardType: "red", expirableByScore: false }),
      );
    }

    if (cardType === "blue" || cardType === "yellow") {
      player.segments.push(createPenaltySegment({ idGenerator, cardType, expirableByScore: true }));
    }
  } else if (playerNumber !== null) {
    playerKey = `${team}:${playerNumber}`;
  }

  state.cardEvents.push({
    id: idGenerator(),
    team,
    playerKey,
    playerNumber,
    cardType,
    createdAtMs: nowMs,
  });
}

function createPenaltySegment({
  idGenerator,
  cardType,
  expirableByScore,
}: {
  idGenerator: IdGenerator;
  cardType: "blue" | "yellow" | "red";
  expirableByScore: boolean;
}) {
  return {
    id: idGenerator(),
    cardType,
    remainingMs: ONE_MINUTE_MS,
    expirableByScore,
  };
}

function getPlayerKey(state: GameState, team: TeamId, playerNumber: number | null): string {
  if (playerNumber !== null) {
    return `${team}:${playerNumber}`;
  }

  const unknownIndex = state.nextUnknownPlayerId[team];
  state.nextUnknownPlayerId[team] += 1;
  return `${team}:unknown:${unknownIndex}`;
}

function getOrCreatePlayer(
  state: GameState,
  team: TeamId,
  playerNumber: number | null,
  key: string,
): PlayerPenaltyState {
  if (state.players[key] === undefined) {
    state.players[key] = {
      key,
      team,
      playerNumber,
      segments: [],
    };
  }

  return state.players[key];
}

function tickPenaltyClock(state: GameState, deltaMs: number) {
  for (const [key, player] of Object.entries(state.players)) {
    let remainingDelta = deltaMs;

    for (const segment of player.segments) {
      if (remainingDelta <= 0) {
        break;
      }

      if (segment.remainingMs <= 0) {
        continue;
      }

      const consumed = Math.min(segment.remainingMs, remainingDelta);
      segment.remainingMs -= consumed;
      remainingDelta -= consumed;
    }

    player.segments = player.segments.filter((segment) => segment.remainingMs > 0);

    if (player.segments.length === 0) {
      delete state.players[key];
    }
  }
}

function createPendingExpiration({
  state,
  scoringTeam,
  nowMs,
  reason,
  idGenerator,
}: {
  state: GameState;
  scoringTeam: TeamId;
  nowMs: number;
  reason: PendingPenaltyExpiration["reason"];
  idGenerator: IdGenerator;
}): PendingPenaltyExpiration | null {
  const penalizedTeam = getOpposingTeam(scoringTeam);

  const candidates = getPenaltyExpirationCandidates(state, penalizedTeam);
  if (candidates.length === 0) {
    return null;
  }

  const pending: PendingPenaltyExpiration = {
    id: idGenerator(),
    reason,
    benefitingTeam: scoringTeam,
    penalizedTeam,
    createdAtMs: nowMs,
    candidatePlayerKeys: candidates,
    resolvedAtMs: null,
    resolvedPlayerKey: null,
  };

  state.pendingExpirations.push(pending);
  return pending;
}

function getPenaltyExpirationCandidates(state: GameState, penalizedTeam: TeamId): string[] {
  const eligibles = Object.values(state.players)
    .filter((player) => player.team === penalizedTeam)
    .map((player) => {
      const expirableSegments = player.segments.filter(
        (segment) => segment.expirableByScore && segment.remainingMs > 0,
      );
      const firstExpirable = expirableSegments[0];

      return {
        key: player.key,
        expirableCount: expirableSegments.length,
        firstExpirableMs: firstExpirable?.remainingMs ?? Number.POSITIVE_INFINITY,
      };
    })
    .filter((candidate) => candidate.expirableCount > 0);

  if (eligibles.length === 0) {
    return [];
  }

  const minCount = Math.min(...eligibles.map((candidate) => candidate.expirableCount));
  const lowestCount = eligibles.filter((candidate) => candidate.expirableCount === minCount);
  const leastRemainingMs = Math.min(...lowestCount.map((candidate) => candidate.firstExpirableMs));

  return lowestCount
    .filter((candidate) => candidate.firstExpirableMs === leastRemainingMs)
    .map((candidate) => candidate.key)
    .sort();
}

function confirmPendingExpiration({
  state,
  pendingId,
  playerKey,
  nowMs,
}: {
  state: GameState;
  pendingId: string;
  playerKey: string | null;
  nowMs: number;
}) {
  const pending = state.pendingExpirations.find((expiration) => expiration.id === pendingId);
  if (pending === undefined || pending.resolvedAtMs !== null) {
    return;
  }

  const selectedPlayerKey =
    playerKey ??
    (pending.candidatePlayerKeys.length === 1 ? (pending.candidatePlayerKeys[0] ?? null) : null);
  if (selectedPlayerKey === null) {
    return;
  }

  const player = state.players[selectedPlayerKey];
  if (player === undefined || player.team !== pending.penalizedTeam) {
    return;
  }

  const segment = player.segments.find((entry) => entry.expirableByScore && entry.remainingMs > 0);
  if (segment === undefined) {
    return;
  }

  segment.remainingMs = 0;
  player.segments = player.segments.filter((entry) => entry.remainingMs > 0);
  if (player.segments.length === 0) {
    delete state.players[player.key];
  }

  pending.resolvedAtMs = nowMs;
  pending.resolvedPlayerKey = selectedPlayerKey;
}

function getOpposingTeam(team: TeamId): TeamId {
  return team === "home" ? "away" : "home";
}

export const gameConstants = {
  ONE_MINUTE_MS,
  SEEKER_RELEASE_MS,
  SEEKER_COUNTDOWN_START_MS,
  TIMEOUT_REMINDER_MS,
} as const;
