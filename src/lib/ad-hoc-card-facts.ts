import type { CardEvent, CardType, GameState, PenaltySegment, TeamId } from "@/lib/game-types";
import { validateGameClockMs, validatePlayerNumber } from "@/lib/validation-policy";

const ONE_MINUTE_MS = 60_000;

export type AdHocCardMutation =
  | {
      type: "add-card";
      team: TeamId;
      playerNumber: number | null;
      cardType: CardType;
      startedGameClockMs?: number;
    }
  | {
      type: "update-card";
      cardId: string;
      team: TeamId;
      playerNumber: number | null;
      cardType: CardType;
    };

/**
 * The Ad Hoc card-fact seam owns card identity, original Game Clock time, and
 * the player segments derived from each card. Callers never need to infer a
 * "latest" card or manipulate player penalty state directly.
 */
export function applyAdHocCardMutation({
  state,
  mutation,
  nowMs,
  idGenerator,
}: {
  state: GameState;
  mutation: AdHocCardMutation;
  nowMs: number;
  idGenerator: () => string;
}): boolean {
  if (mutation.type === "add-card") {
    const gameClockMs = mutation.startedGameClockMs ?? state.gameClockMs;
    if (!validCardInput(mutation.team, mutation.playerNumber, mutation.cardType, gameClockMs)) {
      return false;
    }

    const cardId = idGenerator();
    const event: CardEvent = {
      id: cardId,
      team: mutation.team,
      playerKey: null,
      playerNumber: mutation.playerNumber,
      cardType: mutation.cardType,
      createdAtMs: nowMs,
      gameClockMs,
    };
    addSegmentsForCard(state, event, idGenerator, nowMs);
    state.cardEvents.push(event);
    return true;
  }

  if (!validCardInput(mutation.team, mutation.playerNumber, mutation.cardType, state.gameClockMs)) {
    return false;
  }
  const event = state.cardEvents.find((candidate) => candidate.id === mutation.cardId);
  if (event === undefined) return false;
  const hasLinkedSegments = Object.values(state.players).some((player) =>
    player.segments.some((segment) => segment.cardEventId === event.id),
  );
  if (event.cardType !== "ejection" && !hasLinkedSegments) return false;

  removeSegmentsForCard(state, event.id);
  event.team = mutation.team;
  event.playerNumber = mutation.playerNumber;
  event.cardType = mutation.cardType;
  event.playerKey = null;
  addSegmentsForCard(state, event, idGenerator, nowMs);
  return true;
}

function validCardInput(
  team: TeamId,
  playerNumber: number | null,
  cardType: CardType,
  gameClockMs: number,
) {
  return (
    (team === "home" || team === "away") &&
    (cardType === "blue" ||
      cardType === "yellow" ||
      cardType === "red" ||
      cardType === "ejection") &&
    (playerNumber === null || validatePlayerNumber(playerNumber).ok) &&
    validateGameClockMs(gameClockMs).ok
  );
}

function addSegmentsForCard(
  state: GameState,
  event: CardEvent,
  idGenerator: () => string,
  nowMs: number,
) {
  if (event.cardType === "ejection") {
    event.playerKey = event.playerNumber === null ? null : `${event.team}:${event.playerNumber}`;
    return;
  }

  const playerKey =
    event.playerNumber === null
      ? `${event.team}:unknown:${state.nextUnknownPlayerId[event.team]++}`
      : `${event.team}:${event.playerNumber}`;
  event.playerKey = playerKey;
  const player = (state.players[playerKey] ??= {
    key: playerKey,
    team: event.team,
    playerNumber: event.playerNumber,
    segments: [],
  });
  const hadExistingSegments = player.segments.some((segment) => segment.remainingMs > 0);
  const segments: PenaltySegment[] = [];
  if (event.cardType === "red") {
    segments.push(
      createSegment(idGenerator, "red", false, event.id),
      createSegment(idGenerator, "red", false, event.id),
    );
  } else {
    segments.push(createSegment(idGenerator, event.cardType, true, event.id));
  }

  if (!hadExistingSegments) {
    const elapsedSinceEntryMs = Math.max(0, state.gameClockMs - event.gameClockMs);
    consumeSegments(segments, elapsedSinceEntryMs);
  }
  player.segments.push(...segments.filter((segment) => segment.remainingMs > 0));
  if (player.segments.length === 0) {
    state.recentReleases.push({
      id: idGenerator(),
      team: event.team,
      playerKey,
      playerNumber: event.playerNumber,
      releasedAtMs: nowMs,
      reason: "served",
    });
    delete state.players[playerKey];
  }
}

function removeSegmentsForCard(state: GameState, cardId: string) {
  for (const [playerKey, player] of Object.entries(state.players)) {
    player.segments = player.segments.filter((segment) => segment.cardEventId !== cardId);
    if (player.segments.length === 0) delete state.players[playerKey];
  }
}

function createSegment(
  idGenerator: () => string,
  cardType: "blue" | "yellow" | "red",
  expirableByScore: boolean,
  cardEventId: string,
): PenaltySegment {
  return {
    id: idGenerator(),
    cardType,
    remainingMs: ONE_MINUTE_MS,
    expirableByScore,
    cardEventId,
  };
}

function consumeSegments(segments: PenaltySegment[], elapsedMs: number) {
  let remaining = elapsedMs;
  for (const segment of segments) {
    if (remaining <= 0) break;
    const consumed = Math.min(segment.remainingMs, remaining);
    segment.remainingMs -= consumed;
    remaining -= consumed;
  }
}
