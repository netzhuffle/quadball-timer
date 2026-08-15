import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { PublicEventGamePage } from "@/pages/public-event-page";
import type { PublicAudienceGameProjection } from "@/lib/audience-projection";

describe("public spectator Game page", () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalNavigator = globalThis.navigator;
  const originalLocation = globalThis.location;
  const originalHistory = globalThis.history;
  const originalFetch = globalThis.fetch;
  const originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  let testWindow: Window;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    testWindow = new Window({ url: "http://timer.quadball.app/events/event-1/games/game-1" });
    Object.assign(globalThis, {
      window: testWindow,
      document: testWindow.document,
      navigator: testWindow.navigator,
      location: testWindow.location,
      history: testWindow.history,
      fetch: async () =>
        new Response(JSON.stringify({ status: "accepted", value: projection() }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
    testWindow.close();
    Object.assign(globalThis, {
      window: originalWindow,
      document: originalDocument,
      navigator: originalNavigator,
      location: originalLocation,
      history: originalHistory,
      fetch: originalFetch,
    });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      originalActEnvironment;
  });

  test("keeps the expanded score readable and exposes sporting freshness", async () => {
    await act(async () => {
      root.render(<PublicEventGamePage eventId="event-1" eventGameId="game-1" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const scoreboard = container.querySelector('[aria-label="Live scoreboard"]');
    expect(scoreboard?.className).not.toContain("sticky");
    expect(container.querySelector("[data-scoreboard-expanded]")).not.toBeNull();
    expect(container.textContent).toContain("Winner Side A · Locked");
    expect(container.textContent).toContain("Game Phase");
    expect(container.textContent).toContain("Operational status");
    expect(container.textContent).toContain("Team Timeout");
    expect(container.textContent).toContain("Game Suspension");
    expect(container.textContent).toContain("Heat Stoppage");
    expect(container.textContent).toContain("Stale clock");
    expect(container.textContent).toContain("Last synchronized:");
    expect(container.textContent).toContain("started · 0:30 remaining");
    expect(container.textContent).toContain("Suspended");
    expect(container.textContent).toContain("Locked");
    expect(container.textContent).toContain("Flag catch");
    expect(container.textContent).toContain("A Very Long Team Name That Must Wrap");
    expect(container.textContent).toContain("Another Long Team Name For A Narrow Screen");
    expect(container.textContent).toContain("2:05");
    expect(container.querySelectorAll(".break-words").length).toBe(2);
    const expandedSides = Array.from(
      container.querySelectorAll("[data-scoreboard-expanded] [data-side-id]"),
    );
    expect(expandedSides.map((side) => side.getAttribute("data-side-id"))).toEqual([
      "side-b",
      "side-a",
    ]);
    expect(expandedSides[0]?.textContent).toContain("Flag catch");
    expect(expandedSides[1]?.textContent).not.toContain("Flag catch");

    Object.defineProperty(testWindow, "scrollY", { configurable: true, value: 500 });
    await act(async () => {
      testWindow.dispatchEvent(new testWindow.Event("scroll"));
      await Promise.resolve();
    });
    const compact = container.querySelector("[data-scoreboard-compact]");
    expect(compact?.textContent).toContain("A Very Long Team Name That Must Wrap");
    expect(compact?.textContent).toContain("Another Long Team Name For A Narrow Screen");
    expect(compact?.textContent).toContain("30");
    expect(compact?.textContent).toContain("20");
    expect(compact?.textContent).toContain("2:05");
    expect(compact?.textContent).toContain("Stale clock");
    expect(compact?.textContent).toContain("Overtime");
    expect(compact?.textContent).toContain("Operational status: Suspended");
    expect(compact?.textContent).toContain("Flag catch");
    const compactSides = Array.from(compact?.querySelectorAll("[data-side-id]") ?? []);
    expect(compactSides.map((side) => side.getAttribute("data-side-id"))).toEqual([
      "side-b",
      "side-a",
    ]);
    expect(compactSides[0]?.textContent).toContain("Flag catch");
    expect(compactSides[1]?.textContent).not.toContain("Flag catch");
  });
});

function projection(): PublicAudienceGameProjection {
  return {
    eventId: "event-1",
    gameCode: "A1",
    gameDesignation: "Final",
    scheduledStartMs: 1_000,
    expectedStartMs: 2_000,
    scheduleStatus: "past",
    operationalStatus: "suspended",
    phase: "overtime",
    pitch: "Pitch A",
    sideA: {
      name: "A Very Long Team Name That Must Wrap",
      color: "#112233",
      score: 30,
    },
    sideB: {
      name: "Another Long Team Name For A Narrow Screen",
      color: "#445566",
      score: 20,
    },
    overtimeTarget: 40,
    clock: {
      gameTimeMs: 125_000,
      activePenaltyTimeMs: 0,
      running: false,
      projectedAtMs: 125_000,
      synchronization: "stale",
      lastSynchronizedAtMs: 120_000,
      cues: {
        flagRunnerEntry: "passed",
        seekerWarning: "passed",
        seekerCountdownMs: null,
        seekerRelease: "released",
      },
    },
    presentation: {
      pitchOrientation: "side-b-left",
      displayedTeamColors: { sideA: "#112233", sideB: "#445566" },
    },
    teamTimeout: { status: "completed", side: "side-a", remainingMs: 0 },
    gameSuspension: "suspended",
    heatStoppage: {
      status: "started",
      mode: "enabled",
      pending: false,
      allowedDurationMs: 120_000,
      actualDurationMs: 90_000,
      remainingMs: 30_000,
    },
    flagState: { catchingSide: "side-b" },
    result: { status: "finished", winner: "side-a", locked: true },
    canonicalPath: "/events/event-1/games/game-1",
  };
}
