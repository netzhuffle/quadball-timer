import type { PublicAudienceGameProjection } from "@/lib/audience-projection";
import type { PublicAudienceTimelineEntry } from "@/lib/game-timeline-projection";

export type TimelineBreakState = Pick<
  PublicAudienceGameProjection,
  "teamTimeout" | "heatStoppage" | "result"
>;

/** Keep canonical evidence intact; spectators see one row at each actual break start. */
export function visibleTimelineEntries(entries: readonly PublicAudienceTimelineEntry[]) {
  const visible: PublicAudienceTimelineEntry[] = [];
  const startedTimeouts = new Set<string>();
  let heatStarted = false;
  let heatStartGameTimeMs: number | null = null;
  for (const entry of [...entries].reverse()) {
    if (entry.kind === "timeout") {
      if (
        entry.action === "stoppage" ||
        entry.action === "complete" ||
        entry.action === "completed"
      ) {
        startedTimeouts.delete(entry.lane);
        continue;
      }
      if (entry.action !== "start" && entry.action !== "started") continue;
      if (startedTimeouts.has(entry.lane)) continue;
      startedTimeouts.add(entry.lane);
    }
    if (entry.kind === "heat-stoppage") {
      if (
        entry.action === "end" ||
        entry.action === "complete" ||
        entry.action === "disable" ||
        entry.action === "skip" ||
        entry.action === "skip-required" ||
        entry.action === "suppress"
      ) {
        heatStarted = false;
        continue;
      }
      if (
        entry.action !== "start" &&
        entry.action !== "started" &&
        entry.action !== "end-of-drive" &&
        entry.action !== "dead-volleyball" &&
        entry.action !== "other-stoppage"
      )
        continue;
      // Automatic completion need not add an end fact. A later Game Clock start
      // belongs to another break even when no explicit completion separates them.
      if (heatStarted && heatStartGameTimeMs === entry.gameTimeMs) continue;
      heatStarted = true;
      heatStartGameTimeMs = entry.gameTimeMs;
    }
    visible.push(entry);
  }
  return visible.reverse();
}

export function activeBreakRemainingMs(
  entry: PublicAudienceTimelineEntry,
  entries: readonly PublicAudienceTimelineEntry[],
  game: TimelineBreakState | undefined,
  elapsedMs: number,
): number | null {
  if (game === undefined || game.result.status === "finished") return null;
  let remaining: number | null = null;
  if (
    entry.kind === "timeout" &&
    game.teamTimeout.status === "started" &&
    entry.lane === game.teamTimeout.side &&
    entries.find((candidate) => candidate.kind === "timeout" && candidate.lane === entry.lane) ===
      entry
  )
    remaining = game.teamTimeout.remainingMs;
  if (
    entry.kind === "heat-stoppage" &&
    (game.heatStoppage.status === "started" || game.heatStoppage.status === "extended") &&
    entries.find((candidate) => candidate.kind === "heat-stoppage") === entry
  )
    remaining = game.heatStoppage.remainingMs;
  if (remaining === null || !Number.isFinite(remaining)) return null;
  return Math.max(0, remaining - Math.max(0, elapsedMs)) || null;
}
