import { expect, test } from "bun:test";
import {
  visibleTimelineEntries,
  activeBreakRemainingMs,
  type TimelineBreakState,
} from "@/pages/public-timeline-breaks";
import type { PublicAudienceTimelineEntry } from "@/lib/game-timeline-projection";
const row = (kind: "timeout" | "heat-stoppage", action: string): PublicAudienceTimelineEntry => ({
  kind,
  action,
  gameTimeMs: 60000,
  lane: kind === "timeout" ? "side-a" : "center",
  teamName: null,
});
const live: TimelineBreakState = {
  result: { status: "unfinished", winner: null, locked: false },
  teamTimeout: { status: "started", side: "side-a", remainingMs: 5000 },
  heatStoppage: {
    status: "started",
    mode: "enabled",
    pending: false,
    allowedDurationMs: 60000,
    actualDurationMs: 55000,
    remainingMs: 5000,
  },
};
for (const kind of ["timeout", "heat-stoppage"] as const) {
  test(`${kind} keeps one actual start, not surrounding evidence or repeated starts`, () => {
    const start = row(kind, "start");
    const canonical = [
      row(kind, kind === "timeout" ? "complete" : "end"),
      row(kind, "start"),
      start,
      row(kind, "stoppage"),
    ];
    expect(visibleTimelineEntries(canonical)).toEqual([start]);
    expect(canonical).toHaveLength(4);
    expect(visibleTimelineEntries([row(kind, "stoppage")])).toEqual([]);
    expect(visibleTimelineEntries([])).toEqual([]);
  });
  test(`${kind} active seconds expire and stay absent after completion, disconnect or finish`, () => {
    const start = row(kind, "start");
    const entries = [start];
    expect(activeBreakRemainingMs(start, entries, live, 2000)).toBe(3000);
    expect(activeBreakRemainingMs(start, entries, live, 5000)).toBeNull();
    expect(activeBreakRemainingMs(start, entries, undefined, 0)).toBeNull();
    expect(
      activeBreakRemainingMs(
        start,
        entries,
        { ...live, result: { ...live.result, status: "finished" } },
        0,
      ),
    ).toBeNull();
    expect(
      activeBreakRemainingMs(
        start,
        entries,
        {
          ...live,
          teamTimeout: { ...live.teamTimeout, status: "completed" },
          heatStoppage: { ...live.heatStoppage, status: "ended" },
        },
        0,
      ),
    ).toBeNull();
    const earlier = row(kind, "start");
    expect(activeBreakRemainingMs(earlier, [start, earlier], live, 0)).toBeNull();
  });
}

for (const terminal of ["end", "disable", "skip", "skip-required", "suppress"]) {
  test(`heat ${terminal} permits a new start and assigns the countdown only to that start`, () => {
    const first = { ...row("heat-stoppage", "start"), gameTimeMs: 15 * 60000 };
    const second = { ...row("heat-stoppage", "start"), gameTimeMs: 25 * 60000 };
    const terminalFact = { ...row("heat-stoppage", terminal), gameTimeMs: 15 * 60000 };
    const enabled = { ...row("heat-stoppage", "enable"), gameTimeMs: 20 * 60000 };
    const visible = visibleTimelineEntries([second, enabled, terminalFact, first]);
    expect(visible).toEqual([second, first]);
    expect(activeBreakRemainingMs(second, visible, live, 0)).toBe(5000);
    expect(activeBreakRemainingMs(first, visible, live, 0)).toBeNull();
    // A mode change also separates explicit starts at the same retained clock.
    const sameClock = { ...second, gameTimeMs: first.gameTimeMs };
    expect(visibleTimelineEntries([sameClock, terminalFact, first])).toEqual([sameClock, first]);
  });
}
for (const action of ["start", "end-of-drive", "dead-volleyball", "other-stoppage"]) {
  test(`heat ${action} is an actual start after automatically elapsed prior break`, () => {
    const first = { ...row("heat-stoppage", "start"), gameTimeMs: 15 * 60000 };
    const second = { ...row("heat-stoppage", action), gameTimeMs: 25 * 60000 };
    expect(visibleTimelineEntries([second, first])).toEqual([second, first]);
  });
}
