import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  PublicAudienceTimelineEntry,
  PublicAudienceTimelineLane,
  PublicAudienceTimelinePlayer,
} from "@/lib/game-timeline-projection";
import { PublicGameTimeline } from "@/pages/public-game-timeline";

describe("public Game Timeline browser seam", () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  let testWindow: Window;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    testWindow = new Window({ url: "http://timer.quadball.app/events/current" });
    Object.assign(globalThis, {
      window: testWindow,
      document: testWindow.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
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
      IS_REACT_ACT_ENVIRONMENT: originalActEnvironment,
    });
  });

  test("standalone history does not borrow another scoreboard's reading clearance", async () => {
    const unrelatedScoreboard = document.createElement("section");
    unrelatedScoreboard.setAttribute("data-scoreboard-compact", "");
    unrelatedScoreboard.setAttribute("data-scoreboard-expanded", "");
    unrelatedScoreboard.getBoundingClientRect = () => new testWindow.DOMRect(0, 0, 360, 120);
    document.body.prepend(unrelatedScoreboard);
    try {
      await act(async () =>
        root.render(
          <PublicGameTimeline
            entries={[{ kind: "game-start", gameTimeMs: 0, lane: "center", teamName: null }]}
          />,
        ),
      );
      expect(
        container
          .querySelector<HTMLElement>("[data-game-timeline]")
          ?.style.getPropertyValue("--timeline-top-clearance"),
      ).toBe("16px");
    } finally {
      unrelatedScoreboard.remove();
    }
  });

  test("shows one Team Timeout and Heat Break, ticking only active rows without new-play announcements", async () => {
    let tick: (() => void) | undefined;
    const clock = spyOn(performance, "now").mockReturnValue(1000);
    const intervalHandle = testWindow.setInterval(() => {}, 60000);
    const scheduler = spyOn(testWindow, "setInterval").mockImplementation((callback) => {
      if (typeof callback === "function") tick = () => callback();
      return intervalHandle;
    });
    try {
      const base = { gameTimeMs: 60000, lane: "side-a" as const, teamName: "Alpha" };
      const entries: PublicAudienceTimelineEntry[] = [
        { ...base, kind: "timeout", action: "complete" },
        { ...base, kind: "timeout", action: "start" },
        { ...base, kind: "timeout", action: "stoppage" },
        { ...base, lane: "center", kind: "heat-stoppage", action: "end" },
        { ...base, lane: "center", kind: "heat-stoppage", action: "start" },
      ];
      const game = {
        result: { status: "unfinished" as const, winner: null, locked: false },
        teamTimeout: { status: "started" as const, side: "side-a" as const, remainingMs: 2500 },
        heatStoppage: {
          status: "ended" as const,
          mode: "enabled" as const,
          pending: false,
          remainingMs: null,
          allowedDurationMs: 60000,
          actualDurationMs: 60000,
        },
      };
      await act(async () =>
        root.render(<PublicGameTimeline entries={entries} game={game} connected />),
      );
      expect(container.querySelectorAll('[data-timeline-kind="timeout"]')).toHaveLength(1);
      expect(container.querySelectorAll('[data-timeline-kind="heat-stoppage"]')).toHaveLength(1);
      expect(container.textContent).toContain("Team Timeout");
      expect(container.textContent).toContain("Heat Break");
      expect(container.textContent).toContain("3s remaining");
      expect(container.textContent).not.toContain("stoppage");
      clock.mockReturnValue(2000);
      await act(async () => tick?.());
      expect(container.textContent).toContain("2s remaining");
      expect(container.textContent).not.toContain("New play available");
      clock.mockReturnValue(3500);
      await act(async () => tick?.());
      expect(container.querySelector("[data-timeline-countdown]")).toBeNull();
      expect(container.textContent).toContain("1:00");
      await act(async () =>
        root.render(
          <PublicGameTimeline
            entries={entries}
            game={{ ...game, result: { ...game.result, status: "finished" } }}
            connected
          />,
        ),
      );
      expect(container.querySelector('[role="timer"]')).toBeNull();
      const heatGame = {
        ...game,
        teamTimeout: { ...game.teamTimeout, status: "completed" as const },
        heatStoppage: { ...game.heatStoppage, status: "extended" as const, remainingMs: 1700 },
      };
      await act(async () =>
        root.render(<PublicGameTimeline entries={entries} game={heatGame} connected />),
      );
      expect(
        container.querySelector('[data-timeline-kind="heat-stoppage"]')?.textContent,
      ).toContain("2s remaining");
      expect(container.querySelector('[data-timeline-kind="timeout"]')?.textContent).not.toContain(
        "remaining",
      );
      clock.mockReturnValue(4500);
      await act(async () => tick?.());
      expect(
        container.querySelector('[data-timeline-kind="heat-stoppage"]')?.textContent,
      ).toContain("1s remaining");
      await act(async () =>
        root.render(<PublicGameTimeline entries={entries} game={heatGame} connected={false} />),
      );
      expect(container.querySelector('[role="timer"]')).toBeNull();
      await act(async () =>
        root.render(<PublicGameTimeline entries={[]} game={heatGame} connected />),
      );
      expect(container.querySelector("[data-game-timeline]")).toBeNull();
    } finally {
      clock.mockRestore();
      scheduler.mockRestore();
    }
  });

  test("phase scores follow pitch orientation and absent history remains absent", async () => {
    for (const pitchOrientation of ["side-a-left", "side-b-left"] as const) {
      await act(async () =>
        root.render(
          <PublicGameTimeline
            entries={[
              {
                kind: "overtime",
                gameTimeMs: 1_300_000,
                lane: "center",
                teamName: null,
                targetScore: 100,
                score: { sideA: 70, sideB: 60 },
              },
              {
                kind: "seeker-release",
                gameTimeMs: 1_200_000,
                lane: "center",
                teamName: null,
                score: { sideA: 70, sideB: 30 },
              },
              { kind: "seeker-release", gameTimeMs: 1_200_000, lane: "center", teamName: null },
            ]}
            presentation={{ pitchOrientation, displayedTeamColors: { sideA: null, sideB: null } }}
          />,
        ),
      );
      expect(
        [...container.querySelectorAll("[data-timeline-phase-score]")].map(
          (node) => node.textContent,
        ),
      ).toEqual(
        pitchOrientation === "side-a-left" ? ["70 – 60", "70 – 30"] : ["60 – 70", "30 – 70"],
      );
      expect(container.textContent).toContain("Overtime started · target 100");
      expect(
        container
          .querySelector('[data-timeline-kind="overtime"]')
          ?.getAttribute("data-timeline-side"),
      ).toBe("center");
    }
  });

  test("names the finish winner explicitly and replaces it after a correction", async () => {
    for (const teamName of ["Berner Boggarts", "Corrected winner", null]) {
      await act(async () => {
        root.render(
          <PublicGameTimeline
            entries={[
              {
                kind: "finish",
                gameTimeMs: 1_323_000,
                lane: "center",
                teamName,
                outcome: "result",
                resultKind: "flag-catch",
              },
            ]}
            presentation={{
              pitchOrientation: "side-b-left",
              displayedTeamColors: { sideA: "#fff000", sideB: "#003399" },
            }}
          />,
        );
      });
      expect(container.textContent).toContain("22:03");
      expect(container.textContent).toContain("Game Finish · flag catch");
      if (teamName) expect(container.textContent).toContain(`Winner: ${teamName}`);
      else expect(container.textContent).not.toContain("Winner:");
      if (teamName !== "Berner Boggarts")
        expect(container.textContent).not.toContain("Berner Boggarts");
    }
  });

  test("renders a name-only scorer without a jersey number label", async () => {
    await act(async () => {
      root.render(
        <PublicGameTimeline
          entries={[entry("goal", 60_000, "Basel", { number: null, name: "Leon" })]}
        />,
      );
    });
    expect(container.textContent).toContain("Leon");
    expect(container.textContent).not.toContain("Player #");
    expect(container.textContent).not.toContain("null");
  });

  test("retains public details and applies effective history updates", async () => {
    const initialEntries = [
      entry("goal", 60_000, "A very long team name that must wrap inside the timeline", {
        number: 7,
        name: "Avery A. Player with a deliberately long roster-resolved name",
      }),
      entry("card", 50_000, "Card with a long penalty reason", { number: 4, name: null }),
      entry("timeout", 40_000, "Team timeout", null, "side-b"),
      entry("suspension", 30_000, "Game suspension", null, "center"),
    ];

    await act(async () => {
      root.render(<PublicGameTimeline entries={initialEntries} />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain(
      "Avery A. Player with a deliberately long roster-resolved name",
    );
    expect(container.textContent).toContain("Player #4");
    expect(container.textContent).toContain("Team Timeout");
    expect(container.textContent).toContain("Game Suspension");
    expect(container.textContent).toContain(
      "A very long reason that should remain readable without widening the page",
    );
    expect(container.textContent).not.toContain("undefined");
    expect(container.textContent).toContain("yellow card");
    expect(container.textContent).toContain("1:00");
    expect(container.querySelector('[role="region"]')?.getAttribute("aria-label")).toBe(
      "Game Timeline",
    );

    await act(async () => {
      root.render(
        <PublicGameTimeline
          entries={[
            entry("goal", 60_000, "Corrected team", { number: 7, name: "Corrected roster name" }),
          ]}
        />,
      );
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Corrected roster name");
    expect(container.textContent).not.toContain("Avery A. Player");
    expect(container.textContent).not.toContain("yellow card");
    expect(container.querySelector("button")).toBeNull();

    await act(async () => {
      root.render(<PublicGameTimeline entries={[]} />);
      await Promise.resolve();
    });
    expect(container.textContent).toBe("");
  });
});

function entry(
  kind: PublicAudienceTimelineEntry["kind"],
  gameTimeMs: number,
  _detail: string,
  player: PublicAudienceTimelinePlayer | null = null,
  lane: PublicAudienceTimelineLane = "side-a",
): PublicAudienceTimelineEntry {
  const base = {
    gameTimeMs,
    lane,
    teamName: "A very long team name that must wrap inside the timeline",
  };
  if (kind === "goal") return { ...base, kind, points: 10, player };
  if (kind === "card") {
    return {
      ...base,
      kind,
      player,
      cardColor: "yellow",
      penaltyReason: "A very long reason that should remain readable without widening the page",
    };
  }
  if (kind === "timeout") return { ...base, kind, action: "start" };
  if (kind === "suspension") return { ...base, kind, action: "start" };
  throw new Error(`Unsupported browser fixture kind: ${kind}`);
}
