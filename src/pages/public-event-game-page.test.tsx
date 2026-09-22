import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, Profiler } from "react";
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
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  const originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  let testWindow: Window;
  let container: HTMLDivElement;
  let root: Root;
  let contentHeight: number;
  let currentProjection: ReturnType<typeof eventProjection>;

  beforeEach(() => {
    currentProjection = eventProjection();
    testWindow = new Window({ url: "http://timer.quadball.app/events/event-1/games/game-1" });
    contentHeight = 1100;
    Object.defineProperty(testWindow.document.documentElement, "clientHeight", {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(testWindow.HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get() {
        return this.hasAttribute("data-scoreboard-sentinel") ? 100 : 0;
      },
    });
    Object.defineProperty(testWindow.HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        return this.hasAttribute("data-scoreboard-content") ? contentHeight : 0;
      },
    });
    Object.assign(globalThis, {
      window: testWindow,
      document: testWindow.document,
      navigator: testWindow.navigator,
      location: testWindow.location,
      history: testWindow.history,
      WebSocket: class {
        onopen: (() => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onclose: (() => void) | null = null;
        send() {}
        close() {
          this.onclose?.();
        }
        constructor() {
          queueMicrotask(() => this.onopen?.());
        }
      },
      fetch: async () =>
        new Response(JSON.stringify({ status: "accepted", value: currentProjection }), {
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
      WebSocket: originalWebSocket,
      fetch: originalFetch,
    });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      originalActEnvironment;
  });

  test("keeps the finished score readable without obsolete state or duplicate metadata", async () => {
    await act(async () => {
      root.render(<PublicEventGamePage eventId="event-1" eventGameId="game-1" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const scoreboard = container.querySelector('[aria-label="Live scoreboard"]');
    expect(scoreboard?.className).not.toContain("sticky");
    expect(container.querySelector("[data-scoreboard-expanded]")).not.toBeNull();
    expect(container.querySelector(".daylight-status")?.textContent).toBe("Finished");
    expect(container.querySelector(".daylight-details")).toBeNull();
    expect(container.querySelector("header")?.textContent).not.toContain("Final");
    expect(
      container
        .querySelector('header a[aria-label="Back to Event"] svg')
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(container.querySelector("header")?.textContent).not.toContain("←");
    expect(container.querySelector("h1")?.textContent).toContain("Final:");
    const announcement = container.querySelector("[data-live-projection-status]")?.textContent;
    expect(announcement).toContain("Finished");
    for (const obsolete of [
      "Overtime",
      "Suspended",
      "Target",
      "Locked",
      "Winner Side A",
      "Last synchronized:",
    ])
      expect(announcement).not.toContain(obsolete);
    expect(container.querySelector("header")?.textContent).toContain("SQM 2026");
    expect(container.querySelector("header")?.textContent).not.toContain("Published Event");
    expect(container.querySelector('[aria-label="Game start and Pitch"]')?.textContent).toContain(
      "Started",
    );
    expect(
      container.querySelector('[aria-label="Game start and Pitch"] time')?.getAttribute("datetime"),
    ).toBe("2026-08-16T07:32:00.000Z");
    expect(container.querySelector('[aria-label="Game start and Pitch"]')?.textContent).toContain(
      "09:32",
    );
    expect(container.textContent).not.toContain("Last synchronized:");
    expect(container.textContent).not.toContain("Winner Side A · Locked");
    expect(container.textContent).toContain("Flag catch");
    expect(container.textContent).toContain("A Very Long Team Name That Must Wrap");
    expect(container.textContent).toContain("Another Long Team Name For A Narrow Screen");
    expect(container.textContent).toContain("2:05");
    expect(container.textContent).toContain(
      "An Event Team assignment was corrected. Current team identities are shown.",
    );
    expect(container.querySelectorAll("img").length).toBe(0);
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
    expect(compact).toBe(scoreboard);
    expect(compact?.querySelector(".daylight-status")?.textContent).toBe("Finished");
    expect(compact?.textContent).toContain("Flag catch");
    const compactSides = Array.from(compact?.querySelectorAll("[data-side-id]") ?? []);
    expect(compactSides.map((side) => side.getAttribute("data-side-id"))).toEqual([
      "side-b",
      "side-a",
    ]);
    expect(compactSides[0]?.textContent).toContain("Flag catch");
    expect(compactSides[1]?.textContent).not.toContain("Flag catch");
  });

  test("preserves unfinished suspension, timeout, heat and stale-clock details and announcements", async () => {
    currentProjection.schedule.scheduleGames[0]!.result = {
      status: "unfinished",
      winner: null,
      locked: false,
    };
    await act(async () => {
      root.render(<PublicEventGamePage eventId="event-1" eventGameId="game-1" />);
      await Promise.resolve();
      await Promise.resolve();
    });
    for (const label of [
      "Overtime",
      "Suspended",
      "Target 40",
      "Stale clock",
      "Team Timeout",
      "Game Suspension",
      "Heat Stoppage",
      "started · 0:30 remaining",
    ])
      expect(container.textContent).toContain(label);
    const announcement = container.querySelector("[data-live-projection-status]")?.textContent;
    for (const label of ["Overtime", "Suspended", "Target 40"])
      expect(announcement).toContain(label);
    expect(announcement).not.toContain("Finished");
    expect(container.textContent).not.toContain("Last synchronized:");
    Object.defineProperty(testWindow, "scrollY", { configurable: true, value: 500 });
    await act(async () => {
      testWindow.dispatchEvent(new testWindow.Event("scroll"));
    });
    const compact = container.querySelector("[data-scoreboard-compact]");
    for (const label of ["Overtime", "Suspended", "Target 40", "Stale clock"])
      expect(compact?.textContent).toContain(label);
  });

  test.each(["scheduled", "running"] as const)(
    "only warns about an unavailable clock after a Game has started (%s)",
    async (status) => {
      const game = currentProjection.schedule.scheduleGames[0]!;
      game.result = { status: "unfinished", winner: null, locked: false };
      game.operationalStatus = status;
      game.phase = "seeker-floor";
      game.clock = null;
      if (status === "scheduled") delete game.startedAtMs;
      await act(async () => {
        root.render(<PublicEventGamePage eventId="event-1" eventGameId="game-1" />);
        await Promise.resolve();
        await Promise.resolve();
      });
      const statusText = container.querySelector(".daylight-status")?.textContent;
      if (status === "scheduled") expect(statusText).toBe("Not started");
      else expect(statusText).toContain("Clock unavailable");
    },
  );

  test.each([
    { height: 600, scroll: 500, progress: 0 },
    { height: 1100, scroll: -200, progress: 0 },
    { height: 1100, scroll: 190, progress: 0.5 },
    { height: 890, scroll: 900, progress: 0.5 },
  ])(
    "clamps scroll to the expanded content range ($height/$scroll)",
    async ({ height, scroll, progress }) => {
      contentHeight = height;
      await act(async () => {
        root.render(<PublicEventGamePage eventId="event-1" eventGameId="game-1" />);
        await Promise.resolve();
        await Promise.resolve();
      });
      Object.defineProperty(testWindow, "scrollY", { configurable: true, value: scroll });
      await act(async () => {
        testWindow.dispatchEvent(new testWindow.Event("scroll"));
        await Promise.resolve();
      });
      expect(
        container.querySelector("[data-collapse-progress]")?.getAttribute("data-collapse-progress"),
      ).toBe(String(progress));
    },
  );

  test("does not rerender the spectator page during scoreboard scrolling", async () => {
    let commits = 0;
    await act(async () => {
      root.render(
        <Profiler id="spectator" onRender={() => commits++}>
          <PublicEventGamePage eventId="event-1" eventGameId="game-1" />
        </Profiler>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const initialCommits = commits;
    for (const scrollY of [190, 250, 100, 500, 0])
      await act(async () => {
        Object.defineProperty(testWindow, "scrollY", { configurable: true, value: scrollY });
        testWindow.dispatchEvent(new testWindow.Event("scroll"));
      });
    expect(commits).toBe(initialCommits);
    expect(
      container.querySelector("[data-collapse-progress]")?.getAttribute("data-collapse-progress"),
    ).toBe("0");
  });

  test("renders Game unavailable after the Event loads without the requested Game identity", async () => {
    await act(async () => {
      root.render(<PublicEventGamePage eventId="event-1" eventGameId="unknown-game" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Game unavailable");
    expect(container.textContent).not.toContain("Loading public Game information");
  });
});

function projection(): PublicAudienceGameProjection {
  return {
    eventId: "event-1",
    eventGameId: "game-1",
    gameCode: "A1",
    gameDesignation: "Final",
    scheduledStartMs: 1_000,
    startedAtMs: Date.parse("2026-08-16T07:32:00Z"),
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
    timeline: [],
    teamAssignmentNotice: "event-team-assignment-corrected",
  };
}

function eventProjection() {
  const game = projection();
  return {
    eventId: "event-1",
    name: "Published Event",
    shortName: "SQM 2026",
    timeZone: "Europe/Zurich",
    publicationStatus: "published" as const,
    gameDays: ["2026-08-15"],
    lifecycle: "current" as const,
    canonicalPath: "/events/event-1",
    teams: [],
    pitches: [{ name: "Pitch A" }],
    schedule: {
      asOfMs: 0,
      runningGames: [],
      upcomingGames: [],
      scheduleGames: [game],
      focusIndex: null,
    },
  };
}
