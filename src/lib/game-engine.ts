import type {
  CardType,
  GameCommand,
  GameState,
  GameSummary,
  GameView,
  PendingPenaltyExpiration,
  PlayerPenaltyState,
  ReleasedPenaltyEvent,
  ScoreEvent,
  TeamId,
} from "@/lib/game-types";

const ONE_MINUTE_MS = 60_000;
const SEEKER_RELEASE_MS = 20 * ONE_MINUTE_MS;
const SEEKER_COUNTDOWN_START_MS = 19 * ONE_MINUTE_MS;
const TIMEOUT_REMINDER_MS = 15_000;
const RELEASE_EVENT_VISIBLE_MS = 30_000;

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
    recentReleases: [],
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
  const cloned = structuredClone(state) as GameState;
  if (!Array.isArray(cloned.pendingExpirations)) {
    cloned.pendingExpirations = [];
  }
  for (const pending of cloned.pendingExpirations) {
    if (typeof pending.expireMs !== "number" || pending.expireMs < 0) {
      pending.expireMs = ONE_MINUTE_MS;
    }
  }
  if (!Array.isArray(cloned.recentReleases)) {
    cloned.recentReleases = [];
  }
  return cloned;
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
    tickPenaltyClock(next, deltaMs, nowMs);
  }

  if (!next.isRunning && next.timeouts.active?.running) {
    const timeoutDelta = Math.min(deltaMs, next.timeouts.active.remainingMs);
    next.timeouts.active.remainingMs -= timeoutDelta;
    if (next.timeouts.active.remainingMs <= 0) {
      next.timeouts.active = null;
    }
  }

  pruneRecentReleases(next, nowMs);
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
        startedGameClockMs: command.startedGameClockMs,
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
  startedGameClockMs,
  nowMs,
  idGenerator,
}: {
  state: GameState;
  team: TeamId;
  playerNumber: number | null;
  cardType: CardType;
  startedGameClockMs?: number;
  nowMs: number;
  idGenerator: IdGenerator;
}) {
  if (playerNumber !== null && (playerNumber < 0 || playerNumber > 99)) {
    return;
  }

  let playerKey: string | null = null;

  if (cardType !== "ejection") {
    playerKey = getPlayerKey(state, team, playerNumber);
    const existingPlayer = state.players[playerKey];
    const hadExistingSegments =
      existingPlayer !== undefined &&
      existingPlayer.segments.some((segment) => segment.remainingMs > 0);
    const player = getOrCreatePlayer(state, team, playerNumber, playerKey);
    const newSegments: PlayerPenaltyState["segments"] = [];

    if (cardType === "red") {
      newSegments.push(
        createPenaltySegment({ idGenerator, cardType: "red", expirableByScore: false }),
        createPenaltySegment({ idGenerator, cardType: "red", expirableByScore: false }),
      );
    }

    if (cardType === "blue" || cardType === "yellow") {
      newSegments.push(createPenaltySegment({ idGenerator, cardType, expirableByScore: true }));
    }

    const normalizedStartedClockMs =
      typeof startedGameClockMs === "number" ? Math.max(0, startedGameClockMs) : state.gameClockMs;
    const elapsedSinceEntryStartMs = Math.max(0, state.gameClockMs - normalizedStartedClockMs);

    if (!hadExistingSegments && elapsedSinceEntryStartMs > 0) {
      consumePenaltySegments(newSegments, elapsedSinceEntryStartMs);
    }

    player.segments.push(...newSegments.filter((segment) => segment.remainingMs > 0));

    if (player.segments.length === 0) {
      recordReleasedPenalty({
        state,
        player,
        nowMs,
        reason: "served",
      });
      delete state.players[player.key];
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

function tickPenaltyClock(state: GameState, deltaMs: number, nowMs: number) {
  for (const [key, player] of Object.entries(state.players)) {
    consumePenaltySegments(player.segments, deltaMs);

    player.segments = player.segments.filter((segment) => segment.remainingMs > 0);

    if (player.segments.length === 0) {
      recordReleasedPenalty({
        state,
        player,
        nowMs,
        reason: "served",
      });
      delete state.players[key];
    }
  }
}

function consumePenaltySegments(
  segments: Array<{
    remainingMs: number;
  }>,
  deltaMs: number,
) {
  let remainingDelta = deltaMs;

  for (const segment of segments) {
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
}

function consumeExpirablePenaltySegments(player: PlayerPenaltyState, amountMs: number) {
  let remainingDelta = amountMs;
  const requested = amountMs;

  for (const segment of player.segments) {
    if (remainingDelta <= 0) {
      break;
    }

    if (!segment.expirableByScore || segment.remainingMs <= 0) {
      continue;
    }

    const consumed = Math.min(segment.remainingMs, remainingDelta);
    segment.remainingMs -= consumed;
    remainingDelta -= consumed;
  }

  player.segments = player.segments.filter((entry) => entry.remainingMs > 0);
  return requested - remainingDelta;
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
  if (candidates === null) {
    return null;
  }

  const pending: PendingPenaltyExpiration = {
    id: idGenerator(),
    reason,
    benefitingTeam: scoringTeam,
    penalizedTeam,
    createdAtMs: nowMs,
    candidatePlayerKeys: candidates.playerKeys,
    expireMs: candidates.expireMs,
    resolvedAtMs: null,
    resolvedPlayerKey: null,
  };

  state.pendingExpirations.push(pending);
  return pending;
}

function getPenaltyExpirationCandidates(
  state: GameState,
  penalizedTeam: TeamId,
): { playerKeys: string[]; expireMs: number } | null {
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
    return null;
  }

  const minCount = Math.min(...eligibles.map((candidate) => candidate.expirableCount));
  const lowestCount = eligibles.filter((candidate) => candidate.expirableCount === minCount);
  const leastRemainingMs = Math.min(...lowestCount.map((candidate) => candidate.firstExpirableMs));

  const playerKeys = lowestCount
    .filter((candidate) => candidate.firstExpirableMs === leastRemainingMs)
    .map((candidate) => candidate.key)
    .sort();

  return {
    playerKeys,
    expireMs: leastRemainingMs,
  };
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

  const removedMs = consumeExpirablePenaltySegments(player, Math.max(0, pending.expireMs));
  if (removedMs <= 0) {
    return;
  }
  if (player.segments.length === 0) {
    recordReleasedPenalty({
      state,
      player,
      nowMs,
      reason: "expired",
    });
    delete state.players[player.key];
  }

  pending.resolvedAtMs = nowMs;
  pending.resolvedPlayerKey = selectedPlayerKey;
}

function getOpposingTeam(team: TeamId): TeamId {
  return team === "home" ? "away" : "home";
}

function pruneRecentReleases(state: GameState, nowMs: number) {
  state.recentReleases = state.recentReleases.filter(
    (entry) => nowMs - entry.releasedAtMs <= RELEASE_EVENT_VISIBLE_MS,
  );
}

function recordReleasedPenalty({
  state,
  player,
  nowMs,
  reason,
}: {
  state: GameState;
  player: PlayerPenaltyState;
  nowMs: number;
  reason: ReleasedPenaltyEvent["reason"];
}) {
  state.recentReleases.push({
    id: crypto.randomUUID(),
    team: player.team,
    playerKey: player.key,
    playerNumber: player.playerNumber,
    releasedAtMs: nowMs,
    reason,
  });
}

export const gameConstants = {
  ONE_MINUTE_MS,
  SEEKER_RELEASE_MS,
  SEEKER_COUNTDOWN_START_MS,
  TIMEOUT_REMINDER_MS,
  RELEASE_EVENT_VISIBLE_MS,
} as const;
