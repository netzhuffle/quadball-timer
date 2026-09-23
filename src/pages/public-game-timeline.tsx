import { GameTimelineReadingRegion } from "@/pages/game-spectator-viewport";
import { useEffect, useState, type CSSProperties } from "react";
import { Play, Flag, Users, Target, Timer, Pause, Sun, Trophy, UserCheck } from "lucide-react";
import type { PublicAudienceTimelineEntry } from "@/lib/game-timeline-projection";
import {
  activeBreakRemainingMs,
  visibleTimelineEntries,
  type TimelineBreakState,
} from "@/pages/public-timeline-breaks";
import { mixHexColors } from "@/lib/team-colors";
import "./public-game-timeline.css";

type Presentation = {
  pitchOrientation: "side-a-left" | "side-b-left";
  displayedTeamColors: { sideA: string | null; sideB: string | null };
};

export function PublicGameTimeline({
  entries: sourceEntries,
  presentation,
  game,
  connected = false,
}: {
  entries: readonly PublicAudienceTimelineEntry[];
  presentation?: Presentation;
  game?: TimelineBreakState;
  connected?: boolean;
}) {
  const entries = visibleTimelineEntries(sourceEntries);
  const signature = JSON.stringify({ entries, presentation });
  const occurrences = new Map<string, number>();
  const keyedEntries = [...entries]
    .reverse()
    .map((entry) => {
      const identity = `${entry.kind}:${entry.gameTimeMs}:${entry.lane}:${"player" in entry ? entry.player?.number : ""}:${entry.kind === "card" ? entry.cardColor : ""}`;
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      return { entry, key: `${identity}:${occurrence}` };
    })
    .reverse();

  if (entries.length === 0) return null;
  return (
    <GameTimelineReadingRegion signature={signature}>
      <ol>
        {keyedEntries.map(({ entry, key }) => (
          <TimelineEntry
            key={key}
            entry={entry}
            entryKey={key}
            presentation={presentation}
            countdown={
              <ActiveBreakCountdown
                entry={entry}
                entries={entries}
                game={connected ? game : undefined}
              />
            }
          />
        ))}
      </ol>
    </GameTimelineReadingRegion>
  );
}

function TimelineEntry({
  entry,
  entryKey,
  presentation,
  countdown,
}: {
  entry: PublicAudienceTimelineEntry;
  entryKey: string;
  presentation?: Presentation;
  countdown: React.ReactNode;
}) {
  const display = timelineDisplay(entry);
  const side =
    entry.lane === "center"
      ? "center"
      : (entry.lane === "side-a") !== (presentation?.pitchOrientation === "side-b-left")
        ? "left"
        : "right";
  const teamColor =
    entry.lane === "center"
      ? null
      : entry.lane === "side-a"
        ? presentation?.displayedTeamColors.sideA
        : presentation?.displayedTeamColors.sideB;
  const color =
    entry.kind === "card" ? undefined : mixHexColors(teamColor ?? "#1754b4", "#10213f", 0.55);
  const Icon =
    entry.kind === "flag-catch"
      ? Flag
      : entry.kind === "seeker-release"
        ? Users
        : entry.kind === "overtime"
          ? Target
          : entry.kind === "timeout"
            ? Timer
            : entry.kind === "suspension"
              ? Pause
              : entry.kind === "heat-stoppage"
                ? Sun
                : entry.kind === "finish"
                  ? Trophy
                  : entry.kind === "penalty"
                    ? UserCheck
                    : Play;
  return (
    <li
      className="daylight-timeline-entry"
      data-timeline-kind={entry.kind}
      data-timeline-lane={entry.lane}
      data-timeline-side={side}
      data-timeline-key={entryKey}
      data-card-color={entry.kind === "card" ? entry.cardColor : undefined}
      style={{ "--entry-color": color } as CSSProperties}
    >
      <div className="daylight-timeline-time" data-timeline-spine>
        <span>{formatGameTime(entry.gameTimeMs)}</span>
      </div>
      <div className="daylight-timeline-ledger" data-timeline-content>
        <span className="daylight-timeline-icon" aria-hidden="true">
          {entry.kind === "card" ? (
            <span className="daylight-card-icon" />
          ) : entry.kind === "goal" ? (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <circle cx="12" cy="9" r="6.5" />
              <path d="M12 15.5V22" />
            </svg>
          ) : (
            <Icon />
          )}
        </span>
        <div className="daylight-timeline-copy">
          <p className="daylight-timeline-type">{display.summary}</p>
          {countdown}
          {(entry.kind === "seeker-release" || entry.kind === "overtime") && entry.score != null ? (
            <p data-timeline-phase-score aria-label="Score at this phase">
              {presentation?.pitchOrientation === "side-b-left"
                ? entry.score.sideB
                : entry.score.sideA}
              {" – "}
              {presentation?.pitchOrientation === "side-b-left"
                ? entry.score.sideA
                : entry.score.sideB}
            </p>
          ) : null}
          {entry.teamName !== null ? (
            <p className="daylight-timeline-team">
              {entry.kind === "finish" ? "Winner: " : ""}
              {entry.teamName}
            </p>
          ) : null}
          {"player" in entry && entry.player !== null ? (
            <p>
              {entry.player.number === null
                ? entry.player.name
                : `Player #${entry.player.number}${entry.player.name === null ? "" : ` · ${entry.player.name}`}`}
            </p>
          ) : null}
          {entry.kind === "card" && entry.penaltyReason !== null ? (
            <p>Penalty Reason: {entry.penaltyReason}</p>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function ActiveBreakCountdown({
  entry,
  entries,
  game,
}: {
  entry: PublicAudienceTimelineEntry;
  entries: readonly PublicAudienceTimelineEntry[];
  game?: TimelineBreakState;
}) {
  const [elapsedMs, setElapsedMs] = useState(0);
  const initialRemainingMs = activeBreakRemainingMs(entry, entries, game, 0);
  useEffect(() => {
    setElapsedMs(0);
    if (initialRemainingMs === null) return;
    const observedAt = performance.now();
    const interval = window.setInterval(() => {
      const elapsed = performance.now() - observedAt;
      setElapsedMs(elapsed);
      if (elapsed >= initialRemainingMs) window.clearInterval(interval);
    }, 100);
    return () => window.clearInterval(interval);
  }, [game, initialRemainingMs]);
  const remaining = activeBreakRemainingMs(entry, entries, game, elapsedMs);
  return remaining === null ? null : (
    <p role="timer" aria-label="Break time remaining" data-timeline-countdown>
      {Math.ceil(remaining / 1000)}s remaining
    </p>
  );
}

function timelineDisplay(entry: PublicAudienceTimelineEntry): { label: string; summary: string } {
  switch (entry.kind) {
    case "game-start":
      return { label: "Game start", summary: "Game started" };
    case "goal":
      return { label: "Goal", summary: `Goal · ${entry.points} points` };
    case "card":
      return {
        label: "Card",
        summary:
          entry.cardColor === "ejection" ? "Ejection" : `${entry.cardColor ?? "Recorded"} card`,
      };
    case "penalty":
      return {
        label: "Penalty",
        summary: `Penalty · ${entry.release.cause.replaceAll("-", " ")}`,
      };
    case "timeout":
      return {
        label: "Team Timeout",
        summary: "Team Timeout",
      };
    case "suspension":
      return {
        label: "Game Suspension",
        summary: `Game Suspension · ${entry.action?.replaceAll("-", " ") ?? "recorded"}`,
      };
    case "heat-stoppage":
      return {
        label: "Heat Break",
        summary: "Heat Break",
      };
    case "seeker-release":
      return { label: "Seeker Release", summary: "Seekers released" };
    case "flag-catch":
      return { label: "Flag Catch", summary: `Flag Catch · ${entry.points} points` };
    case "overtime":
      return {
        label: "Overtime",
        summary: `Overtime started · target ${entry.targetScore ?? "set"}`,
      };
    case "finish":
      return {
        label: "Game Finish",
        summary: `Game Finish · ${entry.resultKind?.replaceAll("-", " ") ?? entry.outcome.replaceAll("-", " ")}`,
      };
  }
}

function formatGameTime(gameTimeMs: number | null): string {
  if (gameTimeMs === null) return "Game time unavailable";
  const minutes = Math.floor(gameTimeMs / 60_000);
  const seconds = Math.floor((gameTimeMs % 60_000) / 1_000);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
