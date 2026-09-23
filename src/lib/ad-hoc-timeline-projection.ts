import { isDeepStrictEqual } from "node:util";
import { sqmGoalPlayers } from "@/lib/sqm-goal-scorers";
import type { StoredAdHocGame } from "@/lib/ad-hoc-games";
import { orderControllerOperations } from "@/lib/controller-synchronization";
import { advanceGameState } from "@/lib/game-engine";
import {
  projectPublicGameTimeline,
  type PublicAudienceTimelineEntry,
} from "@/lib/game-timeline-projection";
import type { ControllerGameFact } from "@/lib/live-event-game-control";
import { DEFAULT_IQA_SPORTING_RULES, type IqaSportingRules } from "@/lib/iqa-game-rules";

/** Replay private Ad Hoc evidence into the same allowlisted sporting facts as Event Games. */
export function projectAdHocGameTimeline(
  game: Pick<
    StoredAdHocGame,
    "initialState" | "state" | "operations" | "replayBaselineOperationIds"
  > &
    Pick<StoredAdHocGame, "fixtureKey">,
  rules: IqaSportingRules = DEFAULT_IQA_SPORTING_RULES,
  nowMs = game.state.updatedAtMs,
): readonly PublicAudienceTimelineEntry[] {
  const initial = game.initialState;
  // A migrated checkpoint cannot establish the history preceding it.
  if (
    initial === undefined ||
    (game.replayBaselineOperationIds?.length ?? 0) !== 0 ||
    initial.gameClockMs !== 0 ||
    initial.score.home !== 0 ||
    initial.score.away !== 0 ||
    initial.scoreEvents.length !== 0 ||
    initial.cardEvents.length !== 0
  )
    return [];
  const operations = Object.entries(game.operations)
    .filter(([, operation]) => operation.status === undefined || operation.status === "accepted")
    .map(([operationId, operation]) => ({
      operationId,
      workflow: "ad-hoc" as const,
      clientOriginAtMs: operation.clientSentAtMs ?? operation.acceptedAtMs,
      causalPredecessorIds: operation.causalPredecessorIds ?? [],
      payload: operation.command,
    }));
  const ids = new Set(operations.map((operation) => operation.operationId));
  if (operations.some((operation) => operation.causalPredecessorIds.some((id) => !ids.has(id))))
    return [];
  const ordered = orderControllerOperations(operations);
  if (!ordered.ok) return [];
  let state = structuredClone(initial);
  const facts: ControllerGameFact[] = [];
  let sequence = 0;
  const add = (
    factType: string,
    gameTimeMs: number,
    gameSideId: string | null,
    data: ControllerGameFact["data"] = {},
    factId = `history-${sequence}`,
  ) => {
    const fact: ControllerGameFact = {
      factId,
      factType,
      gameTimeMs,
      gameSideId,
      data,
      effective: true,
      sportingOrder: sequence,
      synchronizationOrder: sequence,
    };
    sequence += 1;
    facts.push(fact);
    return fact;
  };
  let overtimeCatchId: string | null = null;
  let overtimeTarget: number | null = null;
  let finish: ControllerGameFact | null = null;
  let commencedAtMs: number | null = null;
  let manualScoreAdjustment = false;
  const releases = new Set<string>();
  const timeoutFacts = new Map<string, ControllerGameFact[]>();
  const addTimeout = (
    side: string,
    gameTimeMs: number,
    action: "stoppage" | "start" | "complete",
  ) => {
    const fact = add("timeout", gameTimeMs, side, { timeoutAction: action });
    const related = timeoutFacts.get(side) ?? [];
    related.push(fact);
    timeoutFacts.set(side, related);
  };
  for (const operation of ordered.operations) {
    const before = advanceGameState(state, operation.clientOriginAtMs);
    if (state.timeouts.active !== null && before.timeouts.active === null)
      addTimeout(state.timeouts.active.team, before.gameClockMs, "complete");
    let generated = 0;
    const after = rules.apply({
      state,
      command: operation.payload,
      nowMs: operation.clientOriginAtMs,
      idGenerator: () => `${operation.operationId}:${++generated}`,
    });
    if (commencedAtMs === null && (after.isRunning || after.gameClockMs > 0))
      commencedAtMs = operation.clientOriginAtMs;
    // The pre-command clock puts scores made exactly at seeker release on the right side of the boundary.
    add("clock", before.gameClockMs, null);
    for (const score of after.scoreEvents) {
      if (state.scoreEvents.some((previous) => previous.id === score.id)) continue;
      add(score.reason, after.gameClockMs, score.team, { points: score.points }, score.id);
      if (score.reason === "flag-catch" && !before.isOvertime && after.isOvertime) {
        overtimeCatchId = score.id;
        overtimeTarget = after.score[score.team === "home" ? "away" : "home"] + 30;
      }
    }
    if (
      operation.payload.type === "change-score" &&
      (operation.payload.reason === "manual" || operation.payload.delta < 0) &&
      !isDeepStrictEqual(before.score, after.score)
    )
      manualScoreAdjustment = true;
    for (const card of after.cardEvents) {
      if (state.cardEvents.some((previous) => previous.id === card.id)) continue;
      add("card", card.gameClockMs, card.team, {}, card.id);
    }
    if (before.timeouts.active === null && after.timeouts.active !== null) {
      timeoutFacts.set(after.timeouts.active.team, []);
      addTimeout(after.timeouts.active.team, after.gameClockMs, "stoppage");
    }
    if (before.timeouts.active?.running === false && after.timeouts.active?.running === true)
      addTimeout(after.timeouts.active.team, after.gameClockMs, "start");
    if (before.timeouts.active !== null && after.timeouts.active === null) {
      const side = before.timeouts.active.team;
      if (after.timeouts[side].used) addTimeout(side, after.gameClockMs, "complete");
      else for (const fact of timeoutFacts.get(side) ?? []) fact.effective = false;
    }
    if (before.isSuspended !== after.isSuspended)
      add("suspension", after.gameClockMs, null, {
        suspensionAction: after.isSuspended ? "suspended" : "resumed",
      });
    for (const release of after.recentReleases) {
      if (releases.has(release.id)) continue;
      releases.add(release.id);
      add("penalty-release-consequence", after.gameClockMs, release.team, {
        playerNumber: release.playerNumber,
        releaseCause: release.reason,
      });
    }
    if (before.isFinished && !after.isFinished && finish !== null) finish.effective = false;
    if (!before.isFinished && after.isFinished) {
      const factType =
        after.finishReason === "concede"
          ? "concession"
          : after.finishReason === "forfeit"
            ? "forfeit"
            : after.finishReason === "double-forfeit"
              ? "double-forfeit"
              : "result";
      finish = add(factType, after.gameClockMs, null, { resultKind: after.finishReason });
    }
    add("clock", after.gameClockMs, null);
    state = after;
  }
  // Never publish a plausible replay if it disagrees with durable sporting evidence.
  for (const field of [
    "score",
    "scoreEvents",
    "cardEvents",
    "gameClockMs",
    "isFinished",
    "winner",
    "finishReason",
    "flagCatch",
    "isOvertime",
    "timeouts",
    "isSuspended",
    "suspendedAtMs",
  ] as const) {
    if (!isDeepStrictEqual(state[field], game.state[field])) return [];
  }
  // Expiry can occur after the final accepted operation, while the reader projects the clock.
  if (state.timeouts.active !== null && advanceGameState(state, nowMs).timeouts.active === null)
    addTimeout(state.timeouts.active.team, state.gameClockMs, "complete");
  for (const fact of facts) {
    if (fact.factType === "goal" || fact.factType === "flag-catch")
      fact.effective = state.scoreEvents.some(
        (score) => score.id === fact.factId && score.undoneAtMs === null,
      );
    if (fact.factType === "card") {
      const card = state.cardEvents.find((card) => card.id === fact.factId);
      fact.effective = card !== undefined;
      if (card) {
        fact.gameSideId = card.team;
        fact.data = { cardType: card.cardType, playerNumber: card.playerNumber };
      }
    }
  }
  const caught = facts.find((fact) => fact.factType === "flag-catch" && fact.effective);
  const timeline = projectPublicGameTimeline({
    goalPlayers: sqmGoalPlayers(game.fixtureKey, facts),
    facts,
    sideA: { sideId: "home", eventTeamId: null, teamName: game.state.homeName },
    sideB: { sideId: "away", eventTeamId: null, teamName: game.state.awayName },
    lookupRosterName: () => null,
    commencedAtMs,
    winnerGameSideId: game.state.winner,
    derived: {
      catch:
        caught === undefined || caught.gameTimeMs === null || caught.gameSideId === null
          ? null
          : {
              factId: caught.factId,
              gameTimeMs: caught.gameTimeMs,
              catchingGameSideId: caught.gameSideId,
            },
      overtime: caught !== undefined && caught.factId === overtimeCatchId,
      overtimeTarget,
      result: finish?.effective ? { factId: finish.factId } : null,
    },
  });
  // Manual score adjustments lack goal provenance; do not invent goals or phase totals.
  return manualScoreAdjustment
    ? timeline.map((entry) =>
        entry.kind === "seeker-release" || entry.kind === "overtime"
          ? { ...entry, score: null }
          : entry,
      )
    : timeline;
}
