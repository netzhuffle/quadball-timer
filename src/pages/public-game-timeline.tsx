import { useId, useLayoutEffect, useRef, useState } from "react";
import type {
  PublicAudienceTimelineEntry,
  PublicAudienceTimelineLane,
} from "@/lib/game-timeline-projection";

export function PublicGameTimeline({
  entries,
}: {
  entries: readonly PublicAudienceTimelineEntry[];
}) {
  const headingId = useId();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const previousHeightRef = useRef<number | null>(null);
  const atLiveEdgeRef = useRef(true);
  const [hasNewPlay, setHasNewPlay] = useState(false);
  const signature = JSON.stringify(entries);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;
    const previousHeight = previousHeightRef.current;
    if (previousHeight !== null && !atLiveEdgeRef.current) {
      node.scrollTop += node.scrollHeight - previousHeight;
      setHasNewPlay(true);
    } else if (atLiveEdgeRef.current) {
      node.scrollTop = 0;
    }
    previousHeightRef.current = node.scrollHeight;
  }, [signature]);

  if (entries.length === 0) return null;

  return (
    <section className="space-y-2" aria-labelledby={headingId} data-game-timeline>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id={headingId} className="text-base font-semibold">
            Game Timeline
          </h3>
          <p className="text-xs text-muted-foreground">Newest first · effective public play</p>
        </div>
        {hasNewPlay ? (
          <button
            type="button"
            className="rounded-full border px-3 py-1 text-xs font-semibold text-primary hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring"
            onClick={() => {
              const node = scrollRef.current;
              if (node !== null) node.scrollTo({ top: 0, behavior: "smooth" });
              atLiveEdgeRef.current = true;
              setHasNewPlay(false);
            }}
          >
            New play
          </button>
        ) : null}
      </div>
      <div
        ref={scrollRef}
        className="max-h-[32rem] overflow-y-auto overscroll-contain rounded-xl border bg-muted/20 p-2"
        onScroll={(event) => {
          const node = event.currentTarget;
          atLiveEdgeRef.current = node.scrollTop <= 8;
          if (atLiveEdgeRef.current) setHasNewPlay(false);
        }}
        data-timeline-scroll-region
        aria-label="Game Timeline"
      >
        <ol className="space-y-2">
          {entries.map((entry, index) => (
            <TimelineEntry
              key={`${entry.kind}-${entry.gameTimeMs ?? "unknown"}-${index}`}
              entry={entry}
            />
          ))}
        </ol>
      </div>
    </section>
  );
}

function TimelineEntry({ entry }: { entry: PublicAudienceTimelineEntry }) {
  const display = timelineDisplay(entry);
  return (
    <li
      className="grid gap-2 rounded-lg border bg-card p-3 text-sm sm:grid-cols-[minmax(0,1fr)_6rem_minmax(0,1fr)]"
      data-timeline-kind={entry.kind}
      data-timeline-lane={entry.lane}
    >
      <div
        className="relative flex min-h-12 flex-col items-center justify-center gap-1 sm:col-start-2 sm:row-start-1"
        data-timeline-spine
      >
        <span className="absolute inset-y-0 w-px bg-slate-300" aria-hidden="true" />
        <span className="relative z-10 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
          {formatGameTime(entry.gameTimeMs)}
        </span>
        <span className="relative z-10 h-2 w-2 rounded-full bg-primary" aria-hidden="true" />
      </div>
      <div className={`min-w-0 break-words ${laneClass(entry.lane)}`} data-timeline-content>
        <div className="flex items-center gap-2 sm:hidden">
          <span className="font-sans text-xs text-muted-foreground">{display.label}</span>
        </div>
        <p className="font-medium sm:pt-1">{display.summary}</p>
        {entry.teamName !== null ? (
          <p className="text-xs text-muted-foreground">{entry.teamName}</p>
        ) : null}
        {"player" in entry && entry.player !== null ? (
          <p className="text-xs text-muted-foreground">
            Player #{entry.player.number}
            {entry.player.name === null ? "" : ` · ${entry.player.name}`}
          </p>
        ) : null}
        {entry.kind === "card" && entry.penaltyReason !== null ? (
          <p className="text-xs text-muted-foreground">Penalty Reason: {entry.penaltyReason}</p>
        ) : null}
        {entry.kind === "card" && entry.cardColor !== null ? (
          <p className="text-xs text-muted-foreground">Card color: {entry.cardColor}</p>
        ) : null}
      </div>
    </li>
  );
}

function timelineDisplay(entry: PublicAudienceTimelineEntry): { label: string; summary: string } {
  switch (entry.kind) {
    case "goal":
      return { label: "Goal", summary: `Goal · ${entry.points} points` };
    case "card":
      return { label: "Card", summary: `Card · ${entry.cardColor ?? "recorded"}` };
    case "penalty":
      return {
        label: "Penalty",
        summary: `Penalty · ${entry.release.cause.replaceAll("-", " ")}`,
      };
    case "timeout":
      return {
        label: "Team Timeout",
        summary: `Team Timeout · ${entry.action?.replaceAll("-", " ") ?? "recorded"}`,
      };
    case "suspension":
      return {
        label: "Game Suspension",
        summary: `Game Suspension · ${entry.action?.replaceAll("-", " ") ?? "recorded"}`,
      };
    case "heat-stoppage":
      return {
        label: "Heat Stoppage",
        summary: `Heat Stoppage · ${entry.action?.replaceAll("-", " ") ?? "recorded"}`,
      };
    case "seeker-release":
      return { label: "Seeker Release", summary: "Seekers released" };
    case "flag-catch":
      return { label: "Flag Catch", summary: `Flag Catch · ${entry.points} points` };
    case "overtime":
      return { label: "Overtime", summary: `Overtime · target ${entry.targetScore ?? "set"}` };
    case "finish":
      return {
        label: "Game Finish",
        summary: `Game Finish · ${entry.resultKind?.replaceAll("-", " ") ?? entry.outcome.replaceAll("-", " ")}`,
      };
  }
}

function laneClass(lane: PublicAudienceTimelineLane): string {
  switch (lane) {
    case "side-a":
      return "sm:col-start-1 sm:row-start-1 sm:border-r-2 sm:border-primary/30 sm:pr-4 sm:text-right";
    case "side-b":
      return "sm:col-start-3 sm:row-start-1 sm:border-l-2 sm:border-primary/30 sm:pl-4";
    case "center":
      return "sm:col-span-3 sm:col-start-1 sm:row-start-2 sm:justify-self-center sm:max-w-2xl sm:text-center";
  }
}

function formatGameTime(gameTimeMs: number | null): string {
  if (gameTimeMs === null) return "Game time unavailable";
  const minutes = Math.floor(gameTimeMs / 60_000);
  const seconds = Math.floor((gameTimeMs % 60_000) / 1_000);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
