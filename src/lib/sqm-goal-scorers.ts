import annotations from "./sqm-goal-scorers.json";
import type { ControllerGameFact } from "@/lib/live-event-game-control";
import type { PublicAudienceTimelinePlayer } from "@/lib/game-timeline-projection";

/** Approved paper-score-sheet annotations; original sporting actions remain immutable. */
export function sqmGoalPlayers(
  fixtureKey: string | undefined,
  facts: readonly ControllerGameFact[],
): ReadonlyMap<string, PublicAudienceTimelinePlayer> {
  const players = new Map<string, PublicAudienceTimelinePlayer>();
  if (fixtureKey === undefined) return players;
  for (const annotation of annotations) {
    if (annotation.fixtureKey !== fixtureKey || annotation.player === null) continue;
    const fact = facts.find((candidate) => candidate.factId === annotation.scoreActionId);
    if (
      fact?.effective !== true ||
      fact.factType !== "goal" ||
      fact.gameSideId !== annotation.side ||
      fact.gameTimeMs !== annotation.gameTimeMs ||
      typeof fact.data !== "object" ||
      fact.data === null ||
      Array.isArray(fact.data) ||
      fact.data.points !== 10
    )
      continue;
    players.set(fact.factId, annotation.player);
  }
  return players;
}
