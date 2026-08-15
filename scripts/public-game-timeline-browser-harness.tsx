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
    teamName: index % 2 === 0 ? "Harness Side A" : "Harness Side B",
    player: { number: index + 1, name: `Harness Player ${index + 1}` },
    points: 10,
  }),
);

function PublicGameTimelineBrowserHarness() {
  const [entries, setEntries] = useState(initialEntries);
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-4">
      <h1 className="text-xl font-semibold">Public Game Timeline browser harness</h1>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded border px-3 py-2 text-sm"
          onClick={() =>
            setEntries((current) => [
              {
                kind: "goal",
                gameTimeMs: 121_000,
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
                gameTimeMs: 122_000,
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
      <PublicGameTimeline entries={entries} />
    </main>
  );
}

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("Timeline harness root is missing.");
createRoot(rootElement).render(<PublicGameTimelineBrowserHarness />);
