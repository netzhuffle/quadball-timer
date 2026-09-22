import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { PublicAudienceTimelineEntry } from "@/lib/game-timeline-projection";
import { PublicGameTimeline } from "@/pages/public-game-timeline";
import "@/index.css";

const initialEntries: readonly PublicAudienceTimelineEntry[] = Array.from(
  { length: 24 },
  (_, index) => ({
    kind: "goal" as const,
    gameTimeMs: 120_000 - index * 1_000,
    lane: index % 2 === 0 ? ("side-a" as const) : ("side-b" as const),
    teamName:
      index % 2 === 0
        ? "Basel Basilisks / Luzern Combined Quadball Team"
        : "Bern International Thunderbirds",
    player: { number: index + 1, name: `Alexandria-Montgomery Harness Player ${index + 1}` },
    points: 10,
  }),
);

function PublicGameTimelineBrowserHarness() {
  const [swapped, setSwapped] = useState(false);
  const [entries, setEntries] = useState<readonly PublicAudienceTimelineEntry[]>([
    {
      kind: "card",
      lane: "side-b",
      gameTimeMs: 180_000,
      teamName: "Bern International Thunderbirds",
      player: { number: 88, name: "Alexandria-Montgomery Longplayername" },
      cardColor: "yellow",
      penaltyReason: "Repeated illegal contact against an opponent without possession of the ball",
    },
    {
      kind: "overtime",
      lane: "center",
      gameTimeMs: 175_000,
      teamName: null,
      targetScore: 100,
      score: { sideA: 70, sideB: 60 },
    },
    {
      kind: "flag-catch",
      lane: "side-b",
      gameTimeMs: 175_000,
      teamName: "Bern International Thunderbirds",
      points: 30,
      player: null,
    },
    {
      kind: "seeker-release",
      lane: "center",
      gameTimeMs: 170_000,
      teamName: null,
      score: { sideA: 70, sideB: 30 },
    },
    ...initialEntries,
    { kind: "game-start", lane: "center", gameTimeMs: 0, teamName: null },
  ]);
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-4">
      <h1 className="text-xl font-semibold">Public Game Timeline browser harness</h1>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() =>
            setEntries((current) => [
              {
                kind: "finish",
                gameTimeMs: 1_323_000,
                lane: "center",
                teamName: "Berner Boggarts",
                outcome: "result",
                resultKind: "flag-catch",
              },
              ...current,
            ])
          }
        >
          Show finished game
        </button>
        <button type="button" onClick={() => setSwapped((current) => !current)}>
          Swap Pitch Orientation
        </button>
        <button
          type="button"
          className="rounded border px-3 py-2 text-sm"
          onClick={() =>
            setEntries((current) => [
              {
                kind: "goal",
                gameTimeMs: 181_000,
                lane: "side-a",
                teamName: "Harness Side A",
                player: { number: 99, name: "Harness Newer Player" },
                points: 10,
              },
              ...current,
            ])
          }
        >
          Deliver newer play while away
        </button>
        <button
          type="button"
          className="rounded border px-3 py-2 text-sm"
          onClick={() =>
            setEntries((current) => [
              {
                kind: "card",
                gameTimeMs: 182_000,
                lane: "side-b",
                teamName: "Harness Side B",
                player: { number: 88, name: "Harness Live-edge Player" },
                cardColor: "blue",
                penaltyReason: "Harness live-edge update",
              },
              ...current,
            ])
          }
        >
          Deliver newer play at live edge
        </button>
      </div>
      <PublicGameTimeline
        entries={entries}
        presentation={{
          pitchOrientation: swapped ? "side-b-left" : "side-a-left",
          displayedTeamColors: { sideA: "#137829", sideB: "#134578" },
        }}
      />
    </main>
  );
}

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("Timeline harness root is missing.");
createRoot(rootElement).render(<PublicGameTimelineBrowserHarness />);
