import type { ActionJsonValue } from "@/lib/event-game-actions";
import { validatePlayerNumber } from "@/lib/validation-policy";

export const LIVE_PENALTY_MINUTE_MS = 60_000;
export const LIVE_SEEKER_RELEASE_MS = 20 * LIVE_PENALTY_MINUTE_MS;

export const LIVE_PENALTY_REASONS = [
  "contact-safety",
  "ball-interaction",
  "position-boundary",
  "procedure-substitution",
  "conduct",
] as const;

export type LivePenaltyReason = (typeof LIVE_PENALTY_REASONS)[number];
export type LiveCardType = "blue" | "yellow" | "red" | "ejection";
export type LivePenaltyStart = "immediate" | "sticks-up" | "seeker-release";

export type LivePenaltyPlayerKey = {
  gameSideId: string;
  playerNumber: number;
};

/** Parse the canonical side:number key used by durable penalty facts. */
export function parseLivePenaltyPlayerKey(value: string): LivePenaltyPlayerKey | null {
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) return null;
  const gameSideId = value.slice(0, separator);
  const playerNumber = Number(value.slice(separator + 1));
  const validated = validatePlayerNumber(playerNumber);
  return validated.ok ? { gameSideId, playerNumber: validated.value } : null;
}

export type LivePenaltyFact = {
  factId: string;
  factType: string;
  gameSideId: string | null;
  gameTimeMs: number | null;
  sportingOrder: number;
  synchronizationOrder: number;
  effective: boolean;
  data: ActionJsonValue;
};

export type LivePenaltySegment = {
  id: string;
  cardFactId: string;
  cardType: Exclude<LiveCardType, "ejection">;
  expirableByScore: boolean;
  eligibleForScoreAtGameTimeMs: number;
  notBeforeGameTimeMs: number;
  startsAtGameTimeMs: number;
  endsAtGameTimeMs: number;
  remainingMs: number;
};

export type LivePenaltyPlayer = {
  playerKey: string;
  gameSideId: string;
  playerNumber: number | null;
  segments: readonly LivePenaltySegment[];
};

export type LivePenaltyPendingExpiration = {
  id: string;
  scoreFactId: string;
  scoreGameTimeMs: number;
  benefitingGameSideId: string;
  penalizedGameSideId: string;
  candidatePlayerKeys: readonly string[];
  serviceDurationMs: number;
  requiresOfficialChoice: boolean;
  resolvedPlayerKey: string | null;
};

/** The sporting cause that released service; distinct from a card's fixed Penalty Reason. */
export type LivePenaltyRelease = {
  id: string;
  scoreFactId: string;
  playerKey: string;
  gameSideId: string;
  releasedMs: number;
  releaseCause: "score" | "foul-before-score";
  sourceFactId: string;
  serviceDurationMs: number;
};

export type LivePenaltyCard = {
  factId: string;
  gameSideId: string;
  playerKey: string | null;
  playerNumber: number | null;
  cardType: LiveCardType;
  penaltyStart: LivePenaltyStart;
  reason: LivePenaltyReason | null;
};

export type LivePenaltyProjection = {
  cards: readonly LivePenaltyCard[];
  players: readonly LivePenaltyPlayer[];
  pendingExpirations: readonly LivePenaltyPendingExpiration[];
  releases: readonly LivePenaltyRelease[];
};

type MutablePlayer = {
  playerKey: string;
  gameSideId: string;
  playerNumber: number | null;
  segments: LivePenaltySegment[];
};

type MutablePending = LivePenaltyPendingExpiration & { resolvedPlayerKey: string | null };

export function deriveLivePenaltyProjection(
  facts: readonly LivePenaltyFact[],
  currentGameTimeMs: number,
): LivePenaltyProjection {
  const ordered = facts
    .filter((fact) => fact.effective)
    .slice()
    .sort(compareLivePenaltyFactOrder);
  const players = new Map<string, MutablePlayer>();
  const cards: LivePenaltyCard[] = [];
  const pending = new Map<string, MutablePending>();
  const releases: LivePenaltyRelease[] = [];
  const reasonByCard = new Map<string, LivePenaltyReason>();
  const durableConsequences = new Map<string, LivePenaltyFact[]>();
  const knownConsequenceSources = new Set<string>();

  for (const fact of facts) {
    if (fact.factType !== "penalty-release-consequence") continue;
    const sourceFactId = stringValue(recordData(fact.data)?.sourceFactId);
    if (sourceFactId === null) continue;
    knownConsequenceSources.add(sourceFactId);
    if (!fact.effective) continue;
    const consequences = durableConsequences.get(sourceFactId) ?? [];
    consequences.push(fact);
    durableConsequences.set(sourceFactId, consequences);
  }

  for (const fact of ordered) {
    const gameTimeMs = fact.gameTimeMs ?? fact.sportingOrder;
    if (!Number.isSafeInteger(gameTimeMs) || gameTimeMs < 0) continue;

    if (fact.factType === "penalty-reason") {
      const data = recordData(fact.data);
      const target = stringValue(data?.targetCardFactId);
      const reason = data?.reason;
      if (target !== null && isPenaltyReason(reason)) {
        reasonByCard.set(target, reason);
      }
      continue;
    }

    if (fact.factType === "penalty-release-consequence") continue;

    if (fact.factType === "penalty-release") {
      const data = recordData(fact.data);
      const pendingId = stringValue(data?.pendingId);
      const scoreFactId = stringValue(data?.scoreFactId);
      const playerKey = stringValue(data?.playerKey);
      if (pendingId === null || scoreFactId === null || playerKey === null) continue;
      const release = pending.get(scoreFactId);
      if (release?.id !== pendingId) continue;
      if (release === undefined || release.resolvedPlayerKey !== null) continue;
      if (!release.candidatePlayerKeys.includes(playerKey)) continue;
      const player = players.get(playerKey);
      if (player === undefined) continue;
      const removed = consumeExpirable(
        player.segments,
        release.serviceDurationMs,
        release.scoreGameTimeMs,
      );
      if (removed <= 0) continue;
      release.resolvedPlayerKey = playerKey;
      releases.push({
        id: fact.factId,
        scoreFactId: release.scoreFactId,
        playerKey,
        gameSideId: player.gameSideId,
        releasedMs: release.scoreGameTimeMs,
        releaseCause: "score",
        sourceFactId: release.scoreFactId,
        serviceDurationMs: release.serviceDurationMs,
      });
      continue;
    }

    if (fact.factType === "card") {
      const data = recordData(fact.data);
      const cardType = data?.cardType;
      if (!isCardType(cardType) || fact.gameSideId === null) continue;
      const playerNumber = numberOrNull(data?.playerNumber);
      const playerKey =
        playerNumber === null
          ? `${fact.gameSideId}:unknown:${fact.factId}`
          : `${fact.gameSideId}:${playerNumber}`;
      const penaltyStart = isPenaltyStart(data?.penaltyStart)
        ? data.penaltyStart
        : inferPenaltyStart(gameTimeMs);
      const card: LivePenaltyCard = {
        factId: fact.factId,
        gameSideId: fact.gameSideId,
        playerKey: cardType === "ejection" ? null : playerKey,
        playerNumber,
        cardType,
        penaltyStart,
        reason: reasonByCard.get(fact.factId) ?? null,
      };
      cards.push(card);
      if (cardType === "ejection") continue;

      const player = players.get(playerKey) ?? {
        playerKey,
        gameSideId: fact.gameSideId,
        playerNumber,
        segments: [],
      };
      players.set(playerKey, player);
      const startsAt = penaltyStartAt(penaltyStart, gameTimeMs);
      const previousEnd = player.segments.at(-1)?.endsAtGameTimeMs ?? startsAt;
      const serviceStart = Math.max(startsAt, previousEnd);
      const segmentCount = cardType === "red" ? 2 : 1;
      for (let index = 0; index < segmentCount; index += 1) {
        const segmentStart = serviceStart + index * LIVE_PENALTY_MINUTE_MS;
        const hasDurableConsequence = knownConsequenceSources.has(fact.factId);
        const immediateExpiry =
          data?.foulBeforeScore === true && cardType !== "red" && !hasDurableConsequence;
        const segment: LivePenaltySegment = {
          id: `${fact.factId}:${index + 1}`,
          cardFactId: fact.factId,
          cardType,
          expirableByScore: cardType !== "red",
          eligibleForScoreAtGameTimeMs: startsAt,
          notBeforeGameTimeMs: penaltyStartAt(penaltyStart, gameTimeMs),
          startsAtGameTimeMs: segmentStart,
          endsAtGameTimeMs: immediateExpiry ? segmentStart : segmentStart + LIVE_PENALTY_MINUTE_MS,
          remainingMs: immediateExpiry
            ? 0
            : remainingAt(segmentStart, segmentStart + LIVE_PENALTY_MINUTE_MS, currentGameTimeMs),
        };
        player.segments.push(segment);
        if (immediateExpiry) {
          releases.push({
            id: `${fact.factId}:foul-before-score`,
            scoreFactId: "",
            playerKey,
            gameSideId: fact.gameSideId,
            releasedMs: gameTimeMs,
            releaseCause: "foul-before-score",
            sourceFactId: fact.factId,
            serviceDurationMs: LIVE_PENALTY_MINUTE_MS,
          });
        }
      }
      applyDurableConsequences(fact.factId, durableConsequences, players, releases);
      continue;
    }

    if (fact.factType !== "goal") continue;
    const scoringSide = fact.gameSideId;
    if (scoringSide === null) continue;
    const penalizedSide = opposingSide(scoringSide, players);
    if (penalizedSide === null) continue;
    const candidates = [...players.values()]
      .filter((player) => player.gameSideId === penalizedSide)
      .map((player) => {
        const activeExpirable = player.segments.find(
          (segment) =>
            segment.expirableByScore &&
            segment.eligibleForScoreAtGameTimeMs <= gameTimeMs &&
            segment.startsAtGameTimeMs <= gameTimeMs &&
            segment.endsAtGameTimeMs > gameTimeMs,
        );
        return {
          playerKey: player.playerKey,
          count: player.segments.filter((segment) => segment.endsAtGameTimeMs > gameTimeMs).length,
          remainingMs:
            activeExpirable === undefined
              ? Number.POSITIVE_INFINITY
              : remainingAt(
                  activeExpirable.startsAtGameTimeMs,
                  activeExpirable.endsAtGameTimeMs,
                  gameTimeMs,
                ),
        };
      })
      .filter((candidate) => Number.isFinite(candidate.remainingMs));
    if (candidates.length === 0) continue;
    const minimumCount = Math.min(...candidates.map((candidate) => candidate.count));
    const byCount = candidates.filter((candidate) => candidate.count === minimumCount);
    const minimumRemaining = Math.min(...byCount.map((candidate) => candidate.remainingMs));
    const candidatePlayerKeys = byCount
      .filter((candidate) => candidate.remainingMs === minimumRemaining)
      .map((candidate) => candidate.playerKey)
      .sort();
    const expiration: MutablePending = {
      id: `penalty-expiration:${fact.factId}`,
      scoreFactId: fact.factId,
      scoreGameTimeMs: gameTimeMs,
      benefitingGameSideId: scoringSide,
      penalizedGameSideId: penalizedSide,
      candidatePlayerKeys,
      serviceDurationMs: minimumRemaining,
      requiresOfficialChoice: candidatePlayerKeys.length > 1,
      resolvedPlayerKey: null,
    };
    if (knownConsequenceSources.has(fact.factId)) {
      applyDurableConsequences(fact.factId, durableConsequences, players, releases);
      continue;
    }
    if (candidatePlayerKeys.length === 1) {
      const playerKey = candidatePlayerKeys[0];
      const player = playerKey === undefined ? undefined : players.get(playerKey);
      if (player !== undefined && playerKey !== undefined) {
        const removed = consumeExpirable(player.segments, minimumRemaining, gameTimeMs);
        if (removed > 0) {
          releases.push({
            id: expiration.id,
            scoreFactId: fact.factId,
            playerKey,
            gameSideId: player.gameSideId,
            releasedMs: gameTimeMs,
            releaseCause: "score",
            sourceFactId: fact.factId,
            serviceDurationMs: minimumRemaining,
          });
          continue;
        }
      }
    }
    pending.set(fact.factId, expiration);
  }

  const resultPlayers = [...players.values()]
    .map((player) => ({
      ...player,
      segments: player.segments
        .map((segment) => ({
          ...segment,
          remainingMs: remainingAt(
            segment.startsAtGameTimeMs,
            segment.endsAtGameTimeMs,
            currentGameTimeMs,
          ),
        }))
        .filter((segment) => segment.remainingMs > 0),
    }))
    .filter((player) => player.segments.length > 0)
    .sort((left, right) => left.playerKey.localeCompare(right.playerKey));
  const resultPending = [...pending.values()].filter(
    (expiration) => expiration.resolvedPlayerKey === null,
  );
  return {
    cards: cards.map((card) => ({
      ...card,
      reason: reasonByCard.get(card.factId) ?? null,
    })),
    players: resultPlayers,
    pendingExpirations: resultPending,
    releases,
  };
}

function consumeExpirable(
  segments: LivePenaltySegment[],
  amountMs: number,
  atGameTimeMs: number,
): number {
  let remaining = amountMs;
  let removed = 0;
  for (const [index, segment] of segments.entries()) {
    if (remaining <= 0) break;
    if (
      !segment.expirableByScore ||
      segment.eligibleForScoreAtGameTimeMs > atGameTimeMs ||
      segment.startsAtGameTimeMs > atGameTimeMs ||
      segment.endsAtGameTimeMs <= atGameTimeMs
    )
      continue;
    const available = remainingAt(
      segment.startsAtGameTimeMs,
      segment.endsAtGameTimeMs,
      atGameTimeMs,
    );
    const consumed = Math.min(available, remaining);
    const oldEnd = segment.endsAtGameTimeMs;
    segment.endsAtGameTimeMs = Math.min(segment.endsAtGameTimeMs, atGameTimeMs);
    segment.remainingMs = Math.max(0, available - consumed);
    shiftQueuedSegments(segments, index + 1, oldEnd - segment.endsAtGameTimeMs);
    remaining -= consumed;
    removed += consumed;
  }
  return removed;
}

function shiftQueuedSegments(segments: LivePenaltySegment[], fromIndex: number, deltaMs: number) {
  if (deltaMs <= 0) return;
  for (let index = fromIndex; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) continue;
    const durationMs = Math.max(0, segment.endsAtGameTimeMs - segment.startsAtGameTimeMs);
    const previousEnd = segments[index - 1]?.endsAtGameTimeMs ?? segment.startsAtGameTimeMs;
    segment.startsAtGameTimeMs = Math.max(
      segment.notBeforeGameTimeMs,
      previousEnd,
      segment.startsAtGameTimeMs - deltaMs,
    );
    segment.endsAtGameTimeMs = segment.startsAtGameTimeMs + durationMs;
  }
}

function applyDurableConsequences(
  sourceFactId: string,
  consequences: Map<string, LivePenaltyFact[]>,
  players: Map<string, MutablePlayer>,
  releases: LivePenaltyRelease[],
) {
  for (const fact of consequences.get(sourceFactId) ?? []) {
    const data = recordData(fact.data);
    const playerKey = stringValue(data?.playerKey);
    const releaseCause = data?.releaseCause;
    if (
      playerKey === null ||
      (releaseCause !== "score" && releaseCause !== "foul-before-score") ||
      releases.some((release) => release.id === fact.factId)
    )
      continue;
    const player = players.get(playerKey);
    if (player === undefined) continue;
    const releaseTime =
      typeof data?.releasedMs === "number" ? data.releasedMs : (fact.gameTimeMs ?? 0);
    const removed =
      releaseCause === "foul-before-score"
        ? expireCardImmediately(player.segments, sourceFactId)
        : consumeExpirable(
            player.segments,
            typeof data?.serviceDurationMs === "number" ? data.serviceDurationMs : 0,
            releaseTime,
          );
    if (removed <= 0) continue;
    releases.push({
      id: fact.factId,
      scoreFactId: releaseCause === "score" ? sourceFactId : "",
      playerKey,
      gameSideId: player.gameSideId,
      releasedMs: releaseTime,
      releaseCause,
      sourceFactId,
      serviceDurationMs:
        typeof data?.serviceDurationMs === "number" ? data.serviceDurationMs : removed,
    });
  }
}

function expireCardImmediately(segments: LivePenaltySegment[], cardFactId: string): number {
  let removed = 0;
  for (const [index, segment] of segments.entries()) {
    if (!segment.expirableByScore || segment.cardFactId !== cardFactId) continue;
    const duration = Math.max(0, segment.endsAtGameTimeMs - segment.startsAtGameTimeMs);
    segment.endsAtGameTimeMs = segment.startsAtGameTimeMs;
    segment.remainingMs = 0;
    shiftQueuedSegments(segments, index + 1, duration);
    removed += duration;
  }
  return removed;
}

function remainingAt(start: number, end: number, current: number): number {
  if (current <= start) return Math.max(0, end - start);
  return Math.max(0, end - Math.max(start, current));
}

function penaltyStartAt(start: LivePenaltyStart, gameTimeMs: number): number {
  if (start === "sticks-up") return 0;
  if (start === "seeker-release") return LIVE_SEEKER_RELEASE_MS;
  return gameTimeMs;
}

function penaltyFactSportingOrder(fact: LivePenaltyFact): number {
  if (fact.factType !== "card" || fact.gameTimeMs === null) return fact.sportingOrder;
  if (fact.sportingOrder !== fact.gameTimeMs) return fact.sportingOrder;
  const penaltyStart = recordData(fact.data)?.penaltyStart;
  return isPenaltyStart(penaltyStart)
    ? penaltyStartAt(penaltyStart, fact.gameTimeMs)
    : fact.sportingOrder;
}

function penaltyFactOrderRank(fact: LivePenaltyFact): number {
  if (fact.factType === "card") return 0;
  if (fact.factType === "goal") return 1;
  if (fact.factType === "penalty-release" || fact.factType === "penalty-release-consequence") {
    return 2;
  }
  return 1;
}

export function compareLivePenaltyFactOrder(left: LivePenaltyFact, right: LivePenaltyFact): number {
  return (
    penaltyFactSportingOrder(left) - penaltyFactSportingOrder(right) ||
    penaltyFactOrderRank(left) - penaltyFactOrderRank(right) ||
    left.synchronizationOrder - right.synchronizationOrder ||
    left.factId.localeCompare(right.factId)
  );
}

function inferPenaltyStart(_gameTimeMs: number): LivePenaltyStart {
  return "immediate";
}

function opposingSide(scoringSide: string, players: Map<string, MutablePlayer>): string | null {
  const sides = [...new Set([...players.values()].map((player) => player.gameSideId))];
  return sides.find((side) => side !== scoringSide) ?? null;
}

function recordData(value: ActionJsonValue): Record<string, ActionJsonValue> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function stringValue(value: ActionJsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: ActionJsonValue | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function isCardType(value: ActionJsonValue | undefined): value is LiveCardType {
  return value === "blue" || value === "yellow" || value === "red" || value === "ejection";
}

function isPenaltyStart(value: ActionJsonValue | undefined): value is LivePenaltyStart {
  return value === "immediate" || value === "sticks-up" || value === "seeker-release";
}

function isPenaltyReason(value: ActionJsonValue | undefined): value is LivePenaltyReason {
  return typeof value === "string" && (LIVE_PENALTY_REASONS as readonly string[]).includes(value);
}
