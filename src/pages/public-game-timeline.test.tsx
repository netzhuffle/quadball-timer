import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

  test("wraps long public content and preserves both scroll positions on new play", async () => {
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
    expect(container.querySelector('[data-timeline-lane="side-a"]')).not.toBeNull();
    expect(container.querySelector('[data-timeline-lane="side-b"]')).not.toBeNull();
    expect(container.querySelector('[data-timeline-lane="center"]')).not.toBeNull();
    expect(
      container.querySelector('[data-timeline-lane="side-a"] [data-timeline-content]')?.className,
    ).toContain("sm:col-start-1");
    expect(
      container.querySelector('[data-timeline-lane="side-b"] [data-timeline-content]')?.className,
    ).toContain("sm:col-start-3");
    expect(
      container.querySelector('[data-timeline-lane="center"] [data-timeline-content]')?.className,
    ).toContain("sm:col-span-3");
    expect(container.querySelectorAll("[data-timeline-spine]").length).toBe(4);

    const region = container.querySelector(
      "[data-timeline-scroll-region]",
    ) as HTMLDivElement | null;
    if (region === null) throw new Error("Expected timeline scroll region.");
    let height = 200;
    Object.defineProperty(region, "scrollHeight", {
      configurable: true,
      get: () => height,
    });
    region.scrollTo = ((optionsOrX: ScrollToOptions | number) => {
      region.scrollTop = typeof optionsOrX === "number" ? optionsOrX : (optionsOrX.top ?? 0);
    }) as typeof region.scrollTo;

    await act(async () => {
      root.render(<PublicGameTimeline entries={initialEntries.slice(0, 1)} />);
      await Promise.resolve();
    });
    region.scrollTop = 80;
    region.dispatchEvent(new testWindow.Event("scroll", { bubbles: true }) as unknown as Event);
    height = 260;
    await act(async () => {
      root.render(
        <PublicGameTimeline
          entries={[
            entry("timeout", 70_000, "A newly arrived play"),
            ...initialEntries.slice(0, 1),
          ]}
        />,
      );
      await Promise.resolve();
    });
    expect(region.scrollTop).toBe(140);
    expect(container.querySelector("button")?.textContent).toBe("New play");

    await act(async () => {
      container
        .querySelector("button")
        ?.dispatchEvent(new testWindow.Event("click", { bubbles: true }) as unknown as Event);
      await Promise.resolve();
    });
    expect(region.scrollTop).toBe(0);

    height = 320;
    await act(async () => {
      root.render(
        <PublicGameTimeline
          entries={[
            entry("goal", 80_000, "Live-edge play"),
            entry("timeout", 70_000, "A newly arrived play"),
            ...initialEntries.slice(0, 1),
          ]}
        />,
      );
      await Promise.resolve();
    });
    expect(region.scrollTop).toBe(0);
    expect(container.querySelector("button")).toBeNull();
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
  if (kind === "timeout") return { ...base, kind, action: "stoppage" };
  if (kind === "suspension") return { ...base, kind, action: "start" };
  throw new Error(`Unsupported browser fixture kind: ${kind}`);
}
