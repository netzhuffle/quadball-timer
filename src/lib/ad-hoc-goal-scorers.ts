import type { ControllerGameFact } from "@/lib/live-event-game-control";
import type { PublicAudienceTimelinePlayer } from "@/lib/game-timeline-projection";

export type AdHocGoalScorer = {
  scoreActionId: string;
  gameTimeMs: number;
  side: "home" | "away";
  player: PublicAudienceTimelinePlayer | null;
};

/** Stored annotations may label only the matching effective goal. */
export function adHocGoalPlayers(
  annotations: readonly AdHocGoalScorer[],
  facts: readonly ControllerGameFact[],
): ReadonlyMap<string, PublicAudienceTimelinePlayer> {
  const players = new Map<string, PublicAudienceTimelinePlayer>();
  for (const annotation of annotations) {
    if (annotation.player === null) continue;
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
