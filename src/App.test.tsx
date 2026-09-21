import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { App, parseRoute } from "./App";
import { captureAdHocHandoffFromLocation } from "@/lib/ad-hoc-handoff";
import { createInitialGameState, projectGameView } from "@/lib/game-engine";
import { DEFAULT_AWAY_TEAM_COLOR, DEFAULT_HOME_TEAM_COLOR } from "@/lib/team-colors";
import { createInitialClockBaseline, projectClockBaseline } from "@/lib/clock-authority";
import type {
  PublicAudienceEventProjection,
  PublicAudienceGameProjection,
} from "@/lib/audience-projection";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);

    queueMicrotask(() => {
      if (this.readyState !== MockWebSocket.CONNECTING) {
        return;
      }

      this.readyState = MockWebSocket.OPEN;
      this.onopen?.(new Event("open"));
    });
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  receive(data: unknown) {
    this.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify(data),
      }),
    );
  }

  close() {
    if (this.readyState === MockWebSocket.CLOSED) {
      return;
    }

    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close"));
  }
}

function publishedEventProjection(eventId: string, name: string): PublicAudienceEventProjection {
  return {
    eventId,
    name,
    timeZone: "UTC",
    publicationStatus: "published",
    gameDays: [new Date(Date.now()).toISOString().slice(0, 10)],
    lifecycle: "current",
    canonicalPath: `/events/${eventId}`,
    teams: [],
    pitches: [],
    schedule: {
      asOfMs: 0,
      runningGames: [],
      upcomingGames: [],
      scheduleGames: [],
      focusIndex: null,
    },
  };
}

function publicCardGame(status: "running" | "future" | "past"): PublicAudienceGameProjection {
  return {
    eventId: "card-event",
    eventGameId: "available",
    gameCode: "GAME-1",
    gameDesignation: "First Game",
    canonicalPath: "/events/card-event/games/available",
    scheduledStartMs: 0,
    expectedStartMs: 0,
    scheduleStatus: status,
    operationalStatus:
      status === "past" ? "finished" : status === "running" ? "running" : "scheduled",
    gameSuspension: "none",
    phase: "seeker-floor",
    pitch: null,
    sideA: { name: "Blue Team", color: "#123456", score: 20 },
    sideB: { name: "Red Team", color: "#654321", score: 10 },
    overtimeTarget: null,
    clock: null,
    teamTimeout: { status: "inactive", side: null, remainingMs: null },
    heatStoppage: {
      status: "inactive",
      mode: null,
      pending: status === "running",
      allowedDurationMs: null,
      actualDurationMs: null,
      remainingMs: null,
    },
    flagState: { catchingSide: null },
    result: { status: "unfinished", winner: null, locked: false },
    presentation: {
      pitchOrientation: "side-a-left",
      displayedTeamColors: { sideA: "#123456", sideB: "#654321" },
    },
    timeline: [],
  };
}

describe("App", () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalNavigator = globalThis.navigator;
  const originalLocation = globalThis.location;
  const originalHistory = globalThis.history;
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  const originalPopStateEvent = globalThis.PopStateEvent;
  const originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;

  let testWindow: Window;
  let container: HTMLDivElement;
  let root: Root;

  async function waitForRouteContent(expected: string) {
    const deadline = performance.now() + 1_000;
    // Imports settle outside React; flush their renders until the admission UI is ready.
    while (!container.textContent?.includes(expected) && performance.now() < deadline) {
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  test("accepts underscore-containing generated Ad Hoc Game IDs", () => {
    expect(parseRoute("/game/adhoc-id_with_underscore", "")).toEqual({
      type: "game",
      gameId: "adhoc-id_with_underscore",
      role: "controller",
    });
  });

  test("parses a QR handoff from the URL fragment without putting the credential in the path", () => {
    expect(
      parseRoute(
        "/",
        "",
        "#adhoc-game=adhoc-game-123&adhoc-control=secret-token-abcdefghijklmnopqrstuvwxyz",
      ),
    ).toEqual({
      type: "ad-hoc-handoff",
      handoff: {
        gameId: "adhoc-game-123",
        controlQr: "secret-token-abcdefghijklmnopqrstuvwxyz",
      },
    });
  });

  test("captures and scrubs a QR handoff before the first render", () => {
    const handoffWindow = new Window({
      url: "http://localhost:3000/#adhoc-game=adhoc-game-123&adhoc-control=secret-token-abcdefghijklmnopqrstuvwxyz",
    });
    const handoff = captureAdHocHandoffFromLocation(handoffWindow.location, handoffWindow.history);

    expect(handoff).toEqual({
      attempted: true,
      handoff: {
        gameId: "adhoc-game-123",
        controlQr: "secret-token-abcdefghijklmnopqrstuvwxyz",
      },
    });
    expect(handoffWindow.location.hash).toBe("");
    expect(handoffWindow.location.pathname).toBe("/");
    expect(handoffWindow.history.state).toBeNull();
  });

  test("scrubs malformed Ad Hoc attempts and preserves unrelated hashes", () => {
    const malformedWindow = new Window({
      url: "http://localhost:3000/#adhoc-game=partial",
    });
    expect(
      captureAdHocHandoffFromLocation(malformedWindow.location, malformedWindow.history),
    ).toEqual({
      attempted: true,
      handoff: null,
    });
    expect(malformedWindow.location.hash).toBe("");
    expect(malformedWindow.history.state).toBeNull();

    const unrelatedWindow = new Window({ url: "http://localhost:3000/#scoreboard" });
    expect(
      captureAdHocHandoffFromLocation(unrelatedWindow.location, unrelatedWindow.history),
    ).toEqual({
      attempted: false,
      handoff: null,
    });
    expect(unrelatedWindow.location.hash).toBe("#scoreboard");
  });

  test("routes malformed Ad Hoc attempts to the generic unavailable result", () => {
    expect(parseRoute("/", "", "#adhoc-control=partial")).toEqual({
      type: "ad-hoc-unavailable",
    });
  });

  test("keeps the Home Return card visible when one current Event would auto-redirect", async () => {
    testWindow.history.pushState(null, "", "/events");
    testWindow.localStorage.setItem(
      "quadball:controller-departure",
      JSON.stringify({
        version: "controller-departure-v1",
        status: "returnable",
        departure: {
          workflow: "ad-hoc",
          gameId: "adhoc-return",
          navigationPath: "/game/adhoc-return",
          identity: { title: "Ad Hoc Game", homeName: "Home", awayName: "Away" },
        },
        expiresAtMs: Date.now() + 300_000,
        blockedGameIds: [],
        pendingFinalizations: [],
        reconciliationPending: [],
      }),
    );
    const eventFetch = Object.assign(
      async () =>
        new Response(
          JSON.stringify({
            status: "accepted",
            value: { events: [publishedEventProjection("event-1", "Current Event")] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      { preconnect: () => undefined },
    );
    globalThis.fetch = eventFetch as typeof fetch;
    await act(async () => {
      root.render(<App />);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(testWindow.location.pathname).toBe("/events");
    expect(container.textContent).toContain("Return to Ad Hoc Game");
  });

  test("dedicated creation preserves Controller return on entry, back and cancelled submission", async () => {
    testWindow.history.replaceState(null, "", "/events?view=all");
    const retained = JSON.stringify({
      version: "controller-departure-v1",
      status: "returnable",
      departure: {
        workflow: "ad-hoc",
        gameId: "adhoc-return",
        navigationPath: "/game/adhoc-return",
        identity: { title: "Ad Hoc Game", homeName: "Home", awayName: "Away" },
      },
      expiresAtMs: Date.now() + 300_000,
      blockedGameIds: [],
      pendingFinalizations: [],
      reconciliationPending: [],
    });
    testWindow.localStorage.setItem("quadball:controller-departure", retained);
    const posts: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") posts.push(url);
      return new Response(JSON.stringify({ status: "accepted", value: { events: [] } }), {
        status: 200,
      });
    }) as typeof fetch;
    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const clickLink = async (text: string) => {
      const link = Array.from(container.getElementsByTagName("a")).find(
        (item) => item.textContent === text,
      );
      expect(link).toBeDefined();
      await act(async () => {
        link?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
    };
    await clickLink("Start an Ad Hoc Game");
    expect(testWindow.location.pathname).toBe("/ad-hoc/new");
    expect(testWindow.localStorage.getItem("quadball:controller-departure")).toBe(retained);
    expect(posts).toHaveLength(0);
    await clickLink("Events");
    expect(container.textContent).toContain("Return to Ad Hoc Game");
    expect(posts).toHaveLength(0);
    await clickLink("Start an Ad Hoc Game");
    await act(async () => {
      Array.from(container.getElementsByTagName("button"))
        .find((button) => button.textContent?.includes("Create game"))
        ?.click();
      await Promise.resolve();
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(posts).toHaveLength(0);
    await act(async () => {
      Array.from(container.getElementsByTagName("button"))
        .find((button) => button.textContent === "Cancel")
        ?.click();
      await Promise.resolve();
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(testWindow.localStorage.getItem("quadball:controller-departure")).toBe(retained);
    expect(posts).toHaveLength(0);
  });

  test("terminates the rendered Controller when Return reconciliation proves the Game unavailable", async () => {
    testWindow.localStorage.setItem(
      "quadball:controller-departure",
      JSON.stringify({
        version: "controller-departure-v1",
        status: "returned",
        blockedGameIds: [],
        pendingFinalizations: [],
        reconciliationPending: [
          {
            workflow: "ad-hoc",
            gameId: "test-game",
            navigationPath: "/game/test-game",
            identity: { title: "Ad Hoc Game", homeName: "Home", awayName: "Away" },
          },
        ],
      }),
    );
    const unavailableFetch = Object.assign(async () => new Response("Not found", { status: 404 }), {
      preconnect: () => undefined,
    });
    globalThis.fetch = unavailableFetch as typeof fetch;
    await act(async () => {
      root.render(<App />);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Ad Hoc Game unavailable.");
    expect(container.querySelector('button[name="Start game"]')).toBeNull();
  });

  test("renders replacement confirmation on a different direct Game route before connecting", async () => {
    testWindow.localStorage.setItem(
      "quadball:controller-departure",
      JSON.stringify({
        version: "controller-departure-v1",
        status: "returnable",
        departure: {
          workflow: "ad-hoc",
          gameId: "adhoc-previous",
          navigationPath: "/game/adhoc-previous",
          identity: { title: "Ad Hoc Game", homeName: "Basel", awayName: "Zurich" },
        },
        expiresAtMs: Date.now() + 300_000,
        blockedGameIds: [],
        pendingFinalizations: [],
        reconciliationPending: [],
      }),
    );
    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      "Leave the previous game?",
    );
    expect(container.textContent).toContain("Basel vs Zurich");
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  test("treats a direct route to the returnable Game as Return before connecting", async () => {
    testWindow.localStorage.setItem(
      "quadball:controller-departure",
      JSON.stringify({
        version: "controller-departure-v1",
        status: "returnable",
        departure: {
          workflow: "ad-hoc",
          gameId: "test-game",
          navigationPath: "/game/test-game",
          identity: { title: "Ad Hoc Game", homeName: "Home", awayName: "Away" },
        },
        expiresAtMs: Date.now() + 300_000,
        blockedGameIds: [],
        pendingFinalizations: [],
        reconciliationPending: [],
      }),
    );
    await act(async () => {
      root.render(<App />);
      for (let attempt = 0; attempt < 5; attempt += 1)
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    const stored = JSON.parse(
      testWindow.localStorage.getItem("quadball:controller-departure") ?? "null",
    ) as { status?: unknown } | null;
    expect(stored?.status).toBe("returned");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain("Tap game time or team names to adjust.");
  });

  test("fails closed and clears a retained Ad Hoc replica when lifecycle storage is corrupt", async () => {
    testWindow.localStorage.setItem("quadball:controller-departure", "{truncated");
    testWindow.localStorage.setItem("quadball:ad-hoc-controller:test-game", "retained replica");
    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Ad Hoc Game unavailable.");
    expect(testWindow.localStorage.getItem("quadball:ad-hoc-controller:test-game")).toBeNull();
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  test("parses the stable public Event route", () => {
    expect(parseRoute("/events/event-123", "")).toEqual({
      type: "event",
      eventId: "event-123",
    });
    expect(parseRoute("/events", "?view=all")).toEqual({ type: "home", showAll: true });
    expect(parseRoute("/events/event-123/games/game-456", "")).toEqual({
      type: "event-game",
      eventId: "event-123",
      eventGameId: "game-456",
    });
  });

  beforeEach(() => {
    testWindow = new Window({
      url: "http://localhost:3000/game/test-game?mode=controller",
    });

    Object.assign(globalThis, {
      window: testWindow,
      document: testWindow.document,
      navigator: testWindow.navigator,
      location: testWindow.location,
      history: testWindow.history,
      PopStateEvent: testWindow.PopStateEvent,
      WebSocket: MockWebSocket,
      fetch: async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

        if (url.endsWith("/api/games/test-game")) {
          const state = createInitialGameState({
            id: "test-game",
            nowMs: Date.now(),
            homeName: "Home",
            awayName: "Away",
          });
          return new Response(JSON.stringify({ game: { state } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response("Not found", { status: 404 });
      },
    });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    MockWebSocket.instances = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  function setControllerCredential(value: string) {
    const input = container.querySelector("input#control-grant") as HTMLInputElement | null;
    if (input === null) throw new Error("Expected Controller credential input.");
    const descriptor = Object.getOwnPropertyDescriptor(
      testWindow.HTMLInputElement.prototype,
      "value",
    );
    descriptor?.set?.call(input, value);
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as unknown as Event);
  }

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
      PopStateEvent: originalPopStateEvent,
      WebSocket: originalWebSocket,
      fetch: originalFetch,
    });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      originalActEnvironment;
  });

  test("controller route can transition from loading to live snapshot without hook-order crash", async () => {
    const errors: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      const message = args.map((value) => String(value)).join(" ");
      errors.push(message);
    };

    try {
      await act(async () => {
        root.render(<App />);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(container.textContent).toContain("Tap game time or team names to adjust.");
      const hasHookOrderError = errors.some((message) =>
        message.includes("Rendered more hooks than during the previous render"),
      );
      expect(hasHookOrderError).toBe(false);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("online Event Game Controller keeps Game Clock and play/pause visible", async () => {
    testWindow.history.pushState({}, "", "/event-control");
    const originalDateNow = Date.now;
    Date.now = () => 9_000_000_000_000;
    try {
      const baseline = { ...createInitialClockBaseline(), gameTimeMs: 5_000 };
      const projection = {
        eventGameId: "event-game-1",
        phase: "scheduled" as const,
        scoreByGameSide: { "side-a": 0, "side-b": 0 },
        goalCount: 0,
        commencement: {
          status: "provisional" as const,
          commencedAtMs: null,
          provisionalRunningSinceMs: null,
          provisionalElapsedMs: 0,
        },
        // The server sample is deliberately from a wall clock far from this phone.
        clock: projectClockBaseline(baseline, 4_000),
      };
      Object.assign(globalThis, {
        fetch: async (input: string | URL | Request) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          if (url.endsWith("/api/event-control/open")) {
            return new Response(
              JSON.stringify({
                status: "opened",
                eventGameId: "event-game-1",
                session: {
                  sessionBearer: "session-bearer",
                  grantSessionId: "grant-session",
                  grantVersion: "grant-version",
                },
                projection,
                projectionStatus: "available",
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return new Response("Not found", { status: 404 });
        },
      });

      await act(async () => {
        root.render(<App />);
        await Promise.resolve();
      });

      await act(async () => {
        setControllerCredential("qr-credential");
        await Promise.resolve();
      });

      const openButton = Array.from(container.getElementsByTagName("button")).find((button) =>
        button.textContent?.includes("Open Controller Device"),
      );
      expect(openButton).not.toBeNull();
      await act(async () => {
        openButton?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(container.textContent).toContain("Game Clock");
      expect(container.textContent).toContain("00:05");
      expect(container.textContent).toContain("Start clock");
      expect(container.textContent).toContain("Controller projection");
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("online Controller renders every clock cue phase and rejects fractional correction", async () => {
    testWindow.history.pushState({}, "", "/event-control");
    let phaseMs = 0;
    const makeProjection = () => ({
      eventGameId: "event-game-1",
      phase: "scheduled" as const,
      scoreByGameSide: { "side-a": 0, "side-b": 0 },
      goalCount: 0,
      commencement: {
        status: "provisional" as const,
        commencedAtMs: null,
        provisionalRunningSinceMs: null,
        provisionalElapsedMs: 0,
      },
      clock: projectClockBaseline({ ...createInitialClockBaseline(), gameTimeMs: phaseMs }, 0),
    });
    Object.assign(globalThis, {
      fetch: async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith("/api/event-control/open") || url.endsWith("/api/event-control/refresh")) {
          return new Response(
            JSON.stringify({
              status: url.endsWith("/open") ? "opened" : "authorized",
              eventGameId: "event-game-1",
              session: {
                sessionBearer: "session-bearer",
                eventGameId: "event-game-1",
                grantSessionId: "grant-session",
                grantVersion: "grant-version",
              },
              projection: makeProjection(),
              projectionStatus: "available",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("Not found", { status: 404 });
      },
    });

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
    });
    await act(async () => {
      setControllerCredential("qr-credential");
      await Promise.resolve();
    });
    const openButton = Array.from(container.getElementsByTagName("button")).find((button) =>
      button.textContent?.includes("Open Controller Device"),
    );
    await act(async () => {
      openButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Flag-runner entry pending at 19:00");
    expect(container.textContent).toContain("Seeker warning pending");
    expect(container.textContent).toContain("Seeker release pending at 20:00");

    phaseMs = 19 * 60 * 1000;
    const refreshButton = Array.from(container.getElementsByTagName("button")).find((button) =>
      button.textContent?.includes("Refresh assignment"),
    );
    await act(async () => {
      refreshButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("FLAG-RUNNER ENTRY NOW");
    expect(container.textContent).toContain("SEEKER WARNING: release countdown active");
    expect(container.textContent).toContain("SEEKER COUNTDOWN: 01:00");

    phaseMs = 20 * 60 * 1000;
    await act(async () => {
      refreshButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("SEEKER RELEASED at 20:00");

    const correctionInput = container.querySelector<HTMLInputElement>("#clock-correction");
    const correctionButton = container.querySelector<HTMLButtonElement>(
      '[data-clock-correction="true"]',
    );
    if (correctionInput === null || correctionButton === null) {
      throw new Error("Expected the bounded clock correction controls.");
    }
    await act(async () => {
      correctionButton.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Enter a whole number of milliseconds");
  });

  test("clock adjust controls replace helper text and can be closed from the clock toggle", async () => {
    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Tap game time or team names to adjust.");
    expect(container.textContent).not.toContain("-1m");

    const clockToggleButton = Array.from(container.getElementsByTagName("button")).find(
      (button) => button.getAttribute("data-clock-adjust-keep") === "true",
    );
    expect(clockToggleButton).not.toBeNull();

    await act(async () => {
      clockToggleButton?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("-1m");
    expect(container.textContent).not.toContain("Tap game time or team names to adjust.");

    await act(async () => {
      clockToggleButton?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Tap game time or team names to adjust.");
    expect(container.textContent).not.toContain("-1m");
  });

  test("team rename editor can swap displayed team sides without renaming teams", async () => {
    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const getTopTeamNameButtons = () =>
      Array.from(container.getElementsByTagName("button")).filter((button) =>
        button.className.includes("font-extrabold"),
      );

    const beforeButtons = getTopTeamNameButtons();
    expect(beforeButtons[0]?.textContent?.trim()).toBe("Home");
    expect(beforeButtons[1]?.textContent?.trim()).toBe("Away");

    await act(async () => {
      beforeButtons[0]?.click();
      await Promise.resolve();
    });

    const swapButton = Array.from(container.getElementsByTagName("button")).find(
      (button) => button.getAttribute("aria-label") === "Swap team sides",
    );
    expect(swapButton).not.toBeNull();

    await act(async () => {
      swapButton?.click();
      await Promise.resolve();
    });

    const saveButton = Array.from(container.getElementsByTagName("button")).find(
      (button) => button.textContent?.trim() === "Save",
    );
    expect(saveButton).not.toBeNull();

    await act(async () => {
      saveButton?.click();
      await Promise.resolve();
    });

    const afterButtons = getTopTeamNameButtons();
    expect(afterButtons[0]?.textContent?.trim()).toBe("Away");
    expect(afterButtons[1]?.textContent?.trim()).toBe("Home");
    expect(container.textContent).toContain("Home vs Away");
  });

  test("team side swap sends synced display-side command", async () => {
    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const getTopTeamNameButtons = () =>
      Array.from(container.getElementsByTagName("button")).filter((button) =>
        button.className.includes("font-extrabold"),
      );

    await act(async () => {
      getTopTeamNameButtons()[0]?.click();
      await Promise.resolve();
    });

    const swapButton = Array.from(container.getElementsByTagName("button")).find(
      (button) => button.getAttribute("aria-label") === "Swap team sides",
    );
    expect(swapButton).not.toBeNull();

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (ws === undefined) {
      return;
    }

    const snapshotState = createInitialGameState({
      id: "test-game",
      nowMs: Date.now(),
      homeName: "Home",
      awayName: "Away",
    });
    const snapshotGame = projectGameView(snapshotState, snapshotState.updatedAtMs);
    await act(async () => {
      ws.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "game-snapshot",
            game: snapshotGame,
            serverNowMs: snapshotState.updatedAtMs,
            ackedCommandIds: [],
          }),
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const sentBefore = ws.sentMessages.length;
    await act(async () => {
      swapButton?.click();
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => testWindow.setTimeout(resolve, 0));
      await Promise.resolve();
    });

    expect(ws.sentMessages.length).toBeGreaterThan(sentBefore);
    const parsed = JSON.parse(ws.sentMessages.at(-1) ?? "{}") as {
      type?: string;
      commands?: Array<{ command?: { type?: string; swapped?: boolean } }>;
    };
    expect(parsed.type).toBe("apply-commands");
    expect(parsed.commands?.[0]?.command?.type).toBe("set-display-sides-swapped");
    expect(typeof parsed.commands?.[0]?.command?.swapped).toBe("boolean");
  });

  test("team rename save sends synced color fields", async () => {
    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const getTopTeamNameButtons = () =>
      Array.from(container.getElementsByTagName("button")).filter((button) =>
        button.className.includes("font-extrabold"),
      );

    await act(async () => {
      getTopTeamNameButtons()[0]?.click();
      await Promise.resolve();
    });

    const homeColorInput = Array.from(container.getElementsByTagName("input")).find(
      (input) => input.getAttribute("aria-label") === "home team color",
    );
    expect(homeColorInput).toBeDefined();

    const saveButton = Array.from(container.getElementsByTagName("button")).find(
      (button) => button.textContent?.trim() === "Save",
    );
    expect(saveButton).toBeDefined();

    if (homeColorInput === undefined || saveButton === undefined) {
      return;
    }

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (ws === undefined) {
      return;
    }

    const snapshotState = createInitialGameState({
      id: "test-game",
      nowMs: Date.now(),
      homeName: "Home",
      awayName: "Away",
    });
    const snapshotGame = projectGameView(snapshotState, snapshotState.updatedAtMs);
    await act(async () => {
      ws.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "game-snapshot",
            game: snapshotGame,
            serverNowMs: snapshotState.updatedAtMs,
            ackedCommandIds: [],
          }),
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const sentBefore = ws.sentMessages.length;
    await act(async () => {
      saveButton.click();
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => testWindow.setTimeout(resolve, 0));
      await Promise.resolve();
    });

    expect(ws.sentMessages.length).toBeGreaterThan(sentBefore);
    const parsed = JSON.parse(ws.sentMessages.at(-1) ?? "{}") as {
      type?: string;
      commands?: Array<{ command?: { type?: string; homeColor?: string; awayColor?: string } }>;
    };
    expect(parsed.type).toBe("apply-commands");
    expect(parsed.commands?.[0]?.command?.type).toBe("rename-teams");
    expect(parsed.commands?.[0]?.command?.homeColor).toBe(DEFAULT_HOME_TEAM_COLOR);
    expect(parsed.commands?.[0]?.command?.awayColor).toBe(DEFAULT_AWAY_TEAM_COLOR);
  });

  test("side switch closes team editor when no unsaved rename draft exists", async () => {
    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const getTopTeamNameButtons = () =>
      Array.from(container.getElementsByTagName("button")).filter((button) =>
        button.className.includes("font-extrabold"),
      );
    const getSwapSidesButton = () =>
      Array.from(container.getElementsByTagName("button")).find(
        (button) => button.getAttribute("aria-label") === "Swap team sides",
      );
    const hasSaveButton = () =>
      Array.from(container.getElementsByTagName("button")).some(
        (button) => button.textContent?.trim() === "Save",
      );
    let topButtons = getTopTeamNameButtons();
    await act(async () => {
      topButtons[0]?.click();
      await Promise.resolve();
    });
    expect(hasSaveButton()).toBe(true);

    const swapWithoutDraft = getSwapSidesButton();
    expect(swapWithoutDraft).not.toBeNull();
    await act(async () => {
      swapWithoutDraft?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hasSaveButton()).toBe(false);
    topButtons = getTopTeamNameButtons();
    expect(topButtons).toHaveLength(2);
  });

  test("team name display height remeasures when team names become longer and shorter", async () => {
    let prototype: object | null = testWindow.HTMLElement.prototype;
    let boundingClientRectDescriptor: PropertyDescriptor | undefined;
    while (prototype !== null && boundingClientRectDescriptor === undefined) {
      boundingClientRectDescriptor = Object.getOwnPropertyDescriptor(
        prototype,
        "getBoundingClientRect",
      );
      prototype = Object.getPrototypeOf(prototype);
    }
    const originalPrototypeGetBoundingClientRect = boundingClientRectDescriptor?.value as
      | ((this: unknown) => unknown)
      | undefined;
    if (originalPrototypeGetBoundingClientRect === undefined) {
      throw new Error("Expected HTMLElement#getBoundingClientRect to exist");
    }
    const originalGetBoundingClientRect = (
      element: unknown,
    ): ReturnType<HTMLElement["getBoundingClientRect"]> =>
      originalPrototypeGetBoundingClientRect.call(element) as ReturnType<
        HTMLElement["getBoundingClientRect"]
      >;

    const createMockRect = (height: number): ReturnType<HTMLElement["getBoundingClientRect"]> =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: height,
        right: 100,
        width: 100,
        height,
        toJSON() {
          return {};
        },
      }) as unknown as ReturnType<HTMLElement["getBoundingClientRect"]>;

    testWindow.HTMLElement.prototype.getBoundingClientRect = function (this: unknown) {
      const element = this as unknown;
      if (
        element instanceof testWindow.HTMLButtonElement &&
        element.className.includes("font-extrabold")
      ) {
        const inlineHeight = element.style.height;
        if (inlineHeight.length > 0 && inlineHeight !== "auto") {
          const parsed = Number.parseFloat(inlineHeight);
          return createMockRect(parsed);
        }

        const text = element.textContent?.trim() ?? "";
        const intrinsicHeight = text.length > 18 ? 68 : 28;
        return createMockRect(intrinsicHeight);
      }

      return originalGetBoundingClientRect(element);
    } as unknown as typeof testWindow.HTMLElement.prototype.getBoundingClientRect;

    try {
      await act(async () => {
        root.render(<App />);
        await Promise.resolve();
        await Promise.resolve();
      });

      const getTopTeamNameButtons = () =>
        Array.from(container.getElementsByTagName("button")).filter((button) =>
          button.className.includes("font-extrabold"),
        );

      const flushRaf = async () => {
        await act(async () => {
          await new Promise((resolve) => testWindow.setTimeout(resolve, 0));
        });
      };
      const pushSnapshot = async (names: { homeName: string; awayName: string }) => {
        const ws = MockWebSocket.instances[0];
        expect(ws).toBeDefined();
        if (ws === undefined) {
          return;
        }

        const state = createInitialGameState({
          id: "test-game",
          nowMs: Date.now(),
          homeName: names.homeName,
          awayName: names.awayName,
        });
        const game = projectGameView(state, state.updatedAtMs);

        await act(async () => {
          ws.onmessage?.(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "game-snapshot",
                game,
                serverNowMs: state.updatedAtMs,
                ackedCommandIds: [],
              }),
            }),
          );
          await Promise.resolve();
          await Promise.resolve();
        });
      };

      await flushRaf();

      let topButtons = getTopTeamNameButtons();
      expect(topButtons[0]?.style.height).toBe("28px");
      expect(topButtons[1]?.style.height).toBe("28px");

      await pushSnapshot({
        homeName: "Very Long Team Name Here",
        awayName: "Away",
      });

      await flushRaf();

      topButtons = getTopTeamNameButtons();
      expect(topButtons[0]?.style.height).toBe("68px");
      expect(topButtons[1]?.style.height).toBe("68px");

      await pushSnapshot({
        homeName: "A",
        awayName: "Away",
      });

      await flushRaf();

      topButtons = getTopTeamNameButtons();
      expect(topButtons[0]?.style.height).toBe("28px");
      expect(topButtons[1]?.style.height).toBe("28px");
    } finally {
      testWindow.HTMLElement.prototype.getBoundingClientRect =
        originalPrototypeGetBoundingClientRect as unknown as typeof testWindow.HTMLElement.prototype.getBoundingClientRect;
    }
  });

  test("penalty panels keep team-tinted header styling", async () => {
    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const headings = Array.from(container.getElementsByTagName("p")).filter((node) =>
      (node.textContent ?? "").toLowerCase().includes("penalties"),
    );
    const homeHeading = headings.find((node) =>
      (node.textContent ?? "").toLowerCase().includes("home penalties"),
    );
    const awayHeading = headings.find((node) =>
      (node.textContent ?? "").toLowerCase().includes("away penalties"),
    );

    expect(homeHeading).toBeDefined();
    expect(awayHeading).toBeDefined();
    const tintLayers = Array.from(container.getElementsByTagName("div")).filter((node) =>
      (node.getAttribute("style") ?? "").includes("radial-gradient(circle at"),
    );
    expect(tintLayers.length).toBeGreaterThanOrEqual(2);
    expect(
      tintLayers.some((node) => (node.getAttribute("style") ?? "").includes("12% 18%")),
    ).toBeTrue();
    expect(
      tintLayers.some((node) => (node.getAttribute("style") ?? "").includes("88% 18%")),
    ).toBeTrue();
  });

  test("create game posts team color fields", async () => {
    testWindow.history.replaceState(null, "", "/ad-hoc/new");

    const requests: Array<{ url: string; body: string | null }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url.endsWith("/api/games") && method === "GET") {
        return new Response(JSON.stringify({ games: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.endsWith("/api/games") && method === "POST") {
        requests.push({ url, body: typeof init?.body === "string" ? init.body : null });
        return new Response(JSON.stringify({ gameId: "created-1" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.endsWith("/api/games/created-1")) {
        const state = createInitialGameState({
          id: "created-1",
          nowMs: Date.now(),
          homeName: "Home",
          awayName: "Away",
        });
        return new Response(JSON.stringify({ game: { state } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const homeColor = document.getElementById("home-color");
    const awayColor = document.getElementById("away-color");
    expect(homeColor).not.toBeNull();
    expect(awayColor).not.toBeNull();
    if (homeColor === null || awayColor === null) {
      return;
    }

    const createButton = Array.from(container.getElementsByTagName("button")).find((button) =>
      (button.textContent ?? "").includes("Create game"),
    );
    expect(createButton).not.toBeNull();

    await act(async () => {
      createButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(requests).toHaveLength(1);
    const payload = JSON.parse(requests[0]?.body ?? "{}") as {
      homeColor?: string;
      awayColor?: string;
    };
    expect(payload.homeColor).toBe(DEFAULT_HOME_TEAM_COLOR);
    expect(payload.awayColor).toBe(DEFAULT_AWAY_TEAM_COLOR);
  });

  test("owns one rendered creation retry chain and prevents duplicate submission", async () => {
    testWindow.history.replaceState(null, "", "/ad-hoc/new");
    const requests: string[] = [];
    const retryCallbacks: (() => void)[] = [];
    testWindow.setTimeout = ((callback: () => void) => {
      retryCallbacks.push(callback);
      return 1;
    }) as unknown as typeof testWindow.setTimeout;
    testWindow.clearTimeout = (() => {}) as typeof testWindow.clearTimeout;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/api/games") && init?.method === "POST") {
        requests.push(url);
        if (requests.length === 1)
          return new Response(JSON.stringify({ retryAfterMs: 1_000 }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "1" },
          });
        return new Response(JSON.stringify({ gameId: "retry-created" }), { status: 201 });
      }
      if (url.endsWith("/api/games/retry-created")) {
        const state = createInitialGameState({
          id: "retry-created",
          nowMs: Date.now(),
          homeName: "Home",
          awayName: "Away",
        });
        return new Response(JSON.stringify({ game: { state } }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const createButton = Array.from(container.getElementsByTagName("button")).find((button) =>
      (button.textContent ?? "").includes("Create game"),
    );
    expect(createButton).not.toBeNull();
    await act(async () => {
      createButton?.click();
      createButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(requests).toHaveLength(1);
    expect(container.textContent).toContain("Retrying in 1s.");
    expect(retryCallbacks).toHaveLength(1);

    await act(async () => {
      retryCallbacks.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(requests).toHaveLength(2);
    expect(testWindow.location.pathname).toBe("/game/retry-created");
  });

  test("color test route renders 100 color samples", async () => {
    testWindow.history.replaceState(null, "", "/color-test");

    await act(async () => {
      root.render(<App />);
    });
    await waitForRouteContent("Score Button Color Test");

    expect(container.textContent).toContain("Score Button Color Test");
    const previews = Array.from(container.getElementsByTagName("section")).filter(
      (section) => section.getAttribute("data-color-preview") === "true",
    );
    expect(previews).toHaveLength(100);
  });

  test.each([
    ["/event-admin", "Event Hub"],
    ["/pitch-manager", "Pitch Manager handoff"],
    ["/admin", "Passkey authentication is required."],
    ["/admin/enroll#token=disposable-token", "Enroll Technical Admin"],
  ])("direct deferred route %s preserves its admission screen", async (path, expected) => {
    testWindow.history.replaceState(null, "", path);
    await act(async () => {
      root.render(<App />);
    });
    await waitForRouteContent(expected);
    expect(container.textContent).toContain(expected);
    expect(container.textContent).not.toContain("could not load");
    if (path.includes("enroll")) expect(testWindow.location.hash).toBe("");
    await act(async () => {
      testWindow.history.pushState(null, "", "/game/test-game");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(container.textContent).toContain("Tap game time or team names to adjust.");
  });

  test("lists public Events without an unscheduled section", async () => {
    testWindow.history.replaceState(null, "", "/events");
    (globalThis.fetch as typeof fetch) = (async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.endsWith("/api/audience/events")) return new Response("Not found", { status: 404 });
      return new Response(
        JSON.stringify({
          status: "accepted",
          value: {
            events: [
              {
                eventId: "current",
                name: "Current Event",
                timeZone: "UTC",
                publicationStatus: "published",
                gameDays: [new Date(Date.now()).toISOString().slice(0, 10)],
                lifecycle: "current",
                canonicalPath: "/events/current",
                teams: [],
                pitches: [],
                schedule: {
                  asOfMs: 0,
                  runningGames: [],
                  upcomingGames: [],
                  scheduleGames: [],
                  focusIndex: null,
                },
              },
              {
                eventId: "future",
                name: "Future Event",
                location: "Sample City, Switzerland",
                timeZone: "UTC",
                publicationStatus: "published",
                gameDays: ["2026-08-15"],
                lifecycle: "future",
                canonicalPath: "/events/future",
                teams: [],
                pitches: [],
                schedule: {
                  asOfMs: 0,
                  runningGames: [],
                  upcomingGames: [],
                  scheduleGames: [],
                  focusIndex: null,
                },
              },
              {
                eventId: "unscheduled",
                name: "Unscheduled Event",
                timeZone: "UTC",
                publicationStatus: "published",
                gameDays: [],
                lifecycle: "unscheduled",
                canonicalPath: "/events/unscheduled",
                teams: [],
                pitches: [],
                schedule: {
                  asOfMs: 0,
                  runningGames: [],
                  upcomingGames: [],
                  scheduleGames: [],
                  focusIndex: null,
                },
              },
              {
                eventId: "current-two",
                name: "Another Current Event",
                timeZone: "UTC",
                publicationStatus: "published",
                gameDays: [new Date(Date.now()).toISOString().slice(0, 10)],
                lifecycle: "current",
                canonicalPath: "/events/current-two",
                teams: [],
                pitches: [],
                schedule: {
                  asOfMs: 0,
                  runningGames: [],
                  upcomingGames: [],
                  scheduleGames: [],
                  focusIndex: null,
                },
              },
              {
                eventId: "past",
                name: "Past Event",
                timeZone: "UTC",
                publicationStatus: "published",
                gameDays: ["2026-08-13"],
                lifecycle: "past",
                canonicalPath: "/events/past",
                teams: [],
                pitches: [],
                schedule: {
                  asOfMs: 0,
                  runningGames: [],
                  upcomingGames: [],
                  scheduleGames: [],
                  focusIndex: null,
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Current Event");
    expect(text).toContain("Future Event");
    expect(text).toContain("Sample City, Switzerland");
    expect(container.querySelectorAll(".discovery-event-location")).toHaveLength(1);
    expect(text).not.toContain("Unscheduled Events");
    expect(text).toContain("Start an Ad Hoc Game");
    expect(text).toContain("Past Event");
    expect(text.indexOf("Future Event")).toBeLessThan(text.indexOf("Start an Ad Hoc Game"));
    expect(text.indexOf("Past Event")).toBeLessThan(text.indexOf("Start an Ad Hoc Game"));
    expect(container.querySelector("footer")?.textContent).toContain("Start an Ad Hoc Game");
  });

  test("opens the sole current Published Event from Home", async () => {
    testWindow.history.replaceState(null, "", "/events");
    (globalThis.fetch as typeof fetch) = (async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.endsWith("/api/audience/events")) return new Response("Not found", { status: 404 });
      return new Response(
        JSON.stringify({
          status: "accepted",
          value: {
            events: [
              {
                eventId: "only-current",
                name: "Only Current Event",
                timeZone: "UTC",
                publicationStatus: "published",
                gameDays: [new Date(Date.now()).toISOString().slice(0, 10)],
                lifecycle: "current",
                canonicalPath: "/events/only-current",
                teams: [],
                pitches: [],
                schedule: {
                  asOfMs: 0,
                  runningGames: [],
                  upcomingGames: [],
                  scheduleGames: [],
                  focusIndex: null,
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(testWindow.location.pathname).toBe("/events/only-current");
  });

  test("shows the discovery list when no Event is current", async () => {
    testWindow.history.replaceState(null, "", "/events");
    (globalThis.fetch as typeof fetch) = (async () =>
      new Response(
        JSON.stringify({
          status: "accepted",
          value: {
            events: [
              {
                eventId: "future-only",
                name: "Future Only Event",
                timeZone: "UTC",
                publicationStatus: "published",
                gameDays: ["2026-08-15"],
                lifecycle: "future",
                canonicalPath: "/events/future-only",
                teams: [],
                pitches: [],
                schedule: {
                  asOfMs: 0,
                  runningGames: [],
                  upcomingGames: [],
                  scheduleGames: [],
                  focusIndex: null,
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(testWindow.location.pathname).toBe("/events");
    expect(container.textContent).toContain("No Event is current today.");
    expect(container.textContent).toContain("Future Only Event");
  });

  test("renders a navigable generic page for a direct unavailable Event visit", async () => {
    testWindow.history.replaceState(null, "", "/events/hidden-event");
    (globalThis.fetch as typeof fetch) = (async () =>
      new Response('{"status":"unavailable"}', {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Event unavailable");
    expect(container.textContent).toContain("Back to Home");
    expect(container.textContent).not.toContain('{"status":"unavailable"}');
  });

  test("uses the canonical Event link and escapes to the full list without redirecting", async () => {
    testWindow.history.replaceState(null, "", "/events/visible-event");
    (globalThis.fetch as typeof fetch) = (async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/api/audience/events/visible-event")) {
        return new Response(
          JSON.stringify({
            status: "accepted",
            value: {
              eventId: "visible-event",
              name: "Visible Event",
              timeZone: "UTC",
              publicationStatus: "published",
              gameDays: [new Date(Date.now()).toISOString().slice(0, 10)],
              lifecycle: "current",
              canonicalPath: "/events/visible-event",
              teams: [],
              pitches: [],
              schedule: {
                asOfMs: 0,
                runningGames: [],
                upcomingGames: [],
                scheduleGames: [],
                focusIndex: null,
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          status: "accepted",
          value: {
            events: [
              {
                eventId: "visible-event",
                name: "Visible Event",
                timeZone: "UTC",
                publicationStatus: "published",
                gameDays: [new Date(Date.now()).toISOString().slice(0, 10)],
                lifecycle: "current",
                canonicalPath: "/events/visible-event",
                teams: [],
                pitches: [],
                schedule: {
                  asOfMs: 0,
                  runningGames: [],
                  upcomingGames: [],
                  scheduleGames: [],
                  focusIndex: null,
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const allEvents = Array.from(container.getElementsByTagName("a")).find((button) =>
      (button.textContent ?? "").includes("All events"),
    );
    expect(allEvents).not.toBeNull();
    await act(async () => {
      allEvents?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(testWindow.location.pathname).toBe("/events");
    expect(testWindow.location.search).toBe("?view=all");
  });

  test("converges a Published Event page from HTTP to a committed Audience Projection update", async () => {
    testWindow.history.replaceState(null, "", "/events/streamed-event");
    const projection = publishedEventProjection("streamed-event", "Streamed Event");
    projection.teamAssignmentNotice = "event-team-assignment-corrected";
    (globalThis.fetch as typeof fetch) = (async () =>
      new Response(JSON.stringify({ status: "accepted", value: projection }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const socket = MockWebSocket.instances.at(-1);
    expect(socket).not.toBeUndefined();
    expect(socket?.sentMessages).toContain(
      JSON.stringify({ type: "subscribe-public-event", eventId: "streamed-event" }),
    );
    expect(container.textContent).toContain("Streamed Event");
    expect(container.textContent).toContain(
      "An Event Team assignment was corrected. Current team identities are shown.",
    );

    await act(async () => {
      socket?.receive({
        protocol: "public-event-stream-v1",
        type: "projection-replaced",
        eventId: "streamed-event",
        version: 2,
        projection: { ...projection, name: "Updated Streamed Event" },
      });
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Updated Streamed Event");
  });

  test("opens a separate Event schedule from the calendar and returns to the live arena", async () => {
    const projection = publishedEventProjection("calendar-event", "Calendar Event");
    testWindow.history.replaceState(null, "", projection.canonicalPath);
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: "accepted", value: projection }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-schedule-group="live-now"]')).not.toBeNull();
    expect(container.querySelector('[data-schedule-group="event-schedule"]')).toBeNull();
    const calendar = container.querySelector<HTMLAnchorElement>(
      '[aria-label="View Event schedule"]',
    );
    await act(async () => {
      calendar?.click();
      await Promise.resolve();
    });
    expect(testWindow.location.search).toBe("?view=schedule");
    expect(container.querySelector('[data-schedule-group="event-schedule"]')).not.toBeNull();
    expect(container.querySelector('[data-schedule-group="live-now"]')).toBeNull();
    const back = container.querySelector<HTMLAnchorElement>(
      `a[href="${projection.canonicalPath}"]`,
    );
    await act(async () => {
      back?.click();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-schedule-group="live-now"]')).not.toBeNull();
  });

  test.each([
    { name: "today", timeZone: "UTC", gameDays: ["2026-09-21"], schedule: false },
    { name: "past", timeZone: "UTC", gameDays: ["2026-08-16"], schedule: true },
    { name: "future", timeZone: "UTC", gameDays: ["2026-09-22"], schedule: true },
    {
      name: "multi-day containing today",
      timeZone: "UTC",
      gameDays: ["2026-09-20", "2026-09-21", "2026-09-22"],
      schedule: false,
    },
    {
      name: "gap between game days",
      timeZone: "UTC",
      gameDays: ["2026-09-20", "2026-09-22"],
      schedule: true,
    },
    {
      name: "previous day west of UTC",
      timeZone: "America/Los_Angeles",
      gameDays: ["2026-09-20"],
      schedule: false,
    },
    {
      name: "UTC date not yet reached west of UTC",
      timeZone: "America/Los_Angeles",
      gameDays: ["2026-09-21"],
      schedule: true,
    },
    { name: "unscheduled", timeZone: "UTC", gameDays: [], schedule: true },
  ])(
    "routes $name Event direct visits by its local Game Days",
    async ({ timeZone, gameDays, schedule }) => {
      const originalNow = Date.now;
      Date.now = () => Date.UTC(2026, 8, 21, 0, 30);
      try {
        const projection = {
          ...publishedEventProjection("day-routing", "Day routing"),
          timeZone,
          gameDays,
        };
        projection.schedule.runningGames = [publicCardGame("running")];
        globalThis.fetch = (async () =>
          new Response(JSON.stringify({ status: "accepted", value: projection }), {
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch;
        testWindow.history.replaceState(null, "", projection.canonicalPath);
        await act(async () => {
          root.render(<App />);
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(container.querySelector('[data-schedule-group="live-now"]') !== null).toBe(
          !schedule,
        );
        expect(container.querySelector('[data-schedule-group="event-schedule"]') !== null).toBe(
          schedule,
        );
        expect(testWindow.location.search).toBe(schedule ? "?view=schedule" : "");
        expect(container.querySelector('[aria-label="View Event schedule"]') !== null).toBe(
          !schedule,
        );
        if (schedule)
          expect(container.querySelector("a.event-back")?.getAttribute("href")).toBe(
            "/events?view=all",
          );
      } finally {
        Date.now = originalNow;
      }
    },
  );

  test.each([false, true])(
    "non-today Event discovery routes directly to schedule (explicit list: %s)",
    async (showAll) => {
      const projection = publishedEventProjection("past-current", "Past current");
      projection.gameDays = ["2000-01-01"];
      globalThis.fetch = (async (input) =>
        new Response(
          JSON.stringify({
            status: "accepted",
            value: (typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url
            ).endsWith("/api/audience/events")
              ? { events: [projection] }
              : projection,
          }),
          { headers: { "content-type": "application/json" } },
        )) as typeof fetch;
      testWindow.history.replaceState(null, "", showAll ? "/events?view=all" : "/events");
      await act(async () => {
        root.render(<App />);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      if (showAll) {
        const link = container.querySelector<HTMLAnchorElement>(
          `a[href="${projection.canonicalPath}?view=schedule"]`,
        );
        expect(link).not.toBeNull();
        await act(async () => {
          link?.click();
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });
      }
      expect(testWindow.location.pathname).toBe(projection.canonicalPath);
      expect(testWindow.location.search).toBe("?view=schedule");
      expect(container.querySelector('[data-schedule-group="live-now"]')).toBeNull();
      expect(container.querySelector('[data-schedule-group="event-schedule"]')).not.toBeNull();
    },
  );

  test.each(["awaiting-start", "future"] as const)(
    "shows the earliest %s Games in Up next even while other Games run",
    async (status) => {
      const projection = publishedEventProjection("next-event", "Next Games");
      const now = Date.UTC(2026, 8, 21, 12);
      const expected = now + (status === "future" ? 2 : -2) * 60 * 60 * 1000;
      const next: PublicAudienceGameProjection = {
        ...publicCardGame("future"),
        eventGameId: "next",
        gameCode: "NEXT",
        scheduleStatus: status,
        scheduledStartMs: expected - 60_000,
        expectedStartMs: expected,
      };
      const unavailable = {
        ...next,
        eventGameId: "unavailable",
        gameCode: "UNAVAILABLE",
        spectatorAvailable: false,
      };
      const suspended = {
        ...next,
        eventGameId: "suspended",
        gameCode: "SUSPENDED",
        operationalStatus: "suspended" as const,
        gameSuspension: "suspended" as const,
      };
      projection.schedule.asOfMs = now;
      projection.schedule.runningGames = [publicCardGame("running")];
      projection.schedule.upcomingGames = [];
      projection.schedule.scheduleGames = [
        { ...next, eventGameId: "later", gameCode: "LATER", expectedStartMs: expected + 60_000 },
        { ...publicCardGame("past"), eventGameId: "past", gameCode: "PAST" },
        ...projection.schedule.runningGames,
        next,
        unavailable,
        suspended,
      ];
      testWindow.history.replaceState(null, "", projection.canonicalPath);
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ status: "accepted", value: projection }), {
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;
      await act(async () => {
        root.render(<App />);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      const upcoming = container.querySelector('[data-schedule-group="coming-up"]');
      expect(
        [...upcoming!.querySelectorAll("[data-game-code]")]
          .map((card) => card.getAttribute("data-game-code"))
          .join(","),
      ).toBe("NEXT,UNAVAILABLE,SUSPENDED");
      expect(upcoming?.textContent).not.toContain("Awaiting start");
      expect(upcoming?.textContent).toContain("Suspended");
      expect(upcoming?.querySelector('[data-game-code="UNAVAILABLE"]')?.closest("a")).toBeNull();
      expect(upcoming?.textContent).toContain("Expected");
      expect(container.querySelector("[data-live-projection-status]")?.textContent).toContain(
        "3 upcoming Games.",
      );
      expect(container.querySelector("[data-live-projection-status]")?.textContent).not.toContain(
        "0 upcoming Games.",
      );
      await act(async () => {
        container.querySelector<HTMLAnchorElement>('[aria-label="View Event schedule"]')?.click();
        await Promise.resolve();
      });
      expect(
        container.querySelector('[data-schedule-group="event-schedule"]')?.textContent,
      ).not.toContain("Awaiting start");
    },
  );

  test("orders running Games by Expected Start, natural Pitch order and stable Game identity", async () => {
    const projection = publishedEventProjection("arena-order", "Arena order");
    const games = [
      { eventGameId: "late-pitch-1", pitch: "Pitch 1", expectedStartMs: 200, scheduledStartMs: 0 },
      { eventGameId: "pitch-10", pitch: "Pitch 10", expectedStartMs: 100, scheduledStartMs: 0 },
      { eventGameId: "pitch-2-z", pitch: "Pitch 2", expectedStartMs: 100, scheduledStartMs: 10 },
      {
        eventGameId: "pitch-1",
        pitch: "legacy pitch",
        pitchName: "Pitch 1",
        expectedStartMs: 100,
        scheduledStartMs: 90,
      },
      { eventGameId: "pitch-2-a", pitch: "Pitch 2", expectedStartMs: 100, scheduledStartMs: 90 },
    ].map((details, index) => ({
      ...publicCardGame("running"),
      ...details,
      gameCode: details.eventGameId,
      gameDesignation: `Game ${index}`,
      canonicalPath: `/events/arena-order/games/${details.eventGameId}`,
    }));
    projection.schedule.runningGames = games;
    projection.schedule.scheduleGames = games.slice(1).concat(games[0]!);
    testWindow.history.replaceState(null, "", projection.canonicalPath);
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: "accepted", value: projection }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const visibleOrder = () =>
      [...container.querySelectorAll('[data-schedule-group="live-now"] [data-game-code]')]
        .map((card) => card.getAttribute("data-game-code"))
        .join(",");
    expect(visibleOrder()).toBe("pitch-1,pitch-2-a,pitch-2-z,pitch-10,late-pitch-1");
    await act(async () => {
      MockWebSocket.instances.at(-1)?.receive({
        protocol: "public-event-stream-v1",
        type: "projection-replaced",
        eventId: projection.eventId,
        version: 2,
        projection: {
          ...projection,
          schedule: { ...projection.schedule, runningGames: [...games].reverse() },
        },
      });
      await Promise.resolve();
    });
    expect(visibleOrder()).toBe("pitch-1,pitch-2-a,pitch-2-z,pitch-10,late-pitch-1");
    await act(async () => {
      container.querySelector<HTMLAnchorElement>('[aria-label="View Event schedule"]')?.click();
      await Promise.resolve();
    });
    expect(
      [...container.querySelectorAll('[data-schedule-group="event-schedule"] [data-game-code]')]
        .map((card) => card.getAttribute("data-game-code"))
        .join(","),
    ).toBe("pitch-10,pitch-2-z,pitch-1,pitch-2-a,late-pitch-1");
  });

  test.each([
    {
      name: "separates a delayed Pitch from its original simultaneous start",
      times: [
        [9, 9],
        [9, 10],
      ],
      labels: ["09:00 AM", "10:00 AM"],
      groups: [["GAME-1"], ["GAME-2"]],
      focused: ["GAME-2"],
    },
    {
      name: "combines different scheduled slots that now share Expected Start",
      times: [
        [9, 11],
        [10, 11],
      ],
      labels: ["11:00 AM"],
      groups: [["GAME-1", "GAME-2"]],
      focused: ["GAME-1", "GAME-2"],
    },
    {
      name: "retains expected chronology when an earlier scheduled game is delayed past another",
      times: [
        [10, 10],
        [9, 11],
      ],
      labels: ["10:00 AM", "11:00 AM"],
      groups: [["GAME-1"], ["GAME-2"]],
      focused: ["GAME-2"],
    },
  ])("$name", async ({ times, labels, groups, focused }) => {
    const projection = publishedEventProjection("delay-event", "Delayed Pitches");
    const hour = (value: number) => Date.UTC(2026, 8, 21, value);
    projection.schedule.scheduleGames = times.map(([scheduled, expected], index) => ({
      ...publicCardGame("future"),
      eventGameId: `game-${index}`,
      gameCode: `GAME-${index + 1}`,
      pitch: `Pitch ${index + 1}`,
      scheduledStartMs: hour(scheduled!),
      expectedStartMs: hour(expected!),
    }));
    projection.schedule.focusIndex = 1;
    testWindow.history.replaceState(null, "", `${projection.canonicalPath}?view=schedule`);
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: "accepted", value: projection }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const originalScroll = Object.getOwnPropertyDescriptor(
      testWindow.HTMLElement.prototype,
      "scrollIntoView",
    );
    const scrolled: (string | null)[][] = [];
    testWindow.HTMLElement.prototype.scrollIntoView = function () {
      scrolled.push(
        [...this.querySelectorAll("[data-game-code]")].map((card) =>
          card.getAttribute("data-game-code"),
        ),
      );
    };
    try {
      await act(async () => {
        root.render(<App />);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      const rendered = [...container.querySelectorAll("[data-time-group]")];
      expect(rendered.map((group) => group.querySelector("time")?.textContent).join("|")).toBe(
        labels.join("|"),
      );
      expect(
        JSON.stringify(
          rendered.map((group) =>
            [...group.querySelectorAll("[data-game-code]")].map((card) =>
              card.getAttribute("data-game-code"),
            ),
          ),
        ),
      ).toBe(JSON.stringify(groups));
      expect(JSON.stringify(scrolled)).toBe(JSON.stringify([focused]));
      for (const game of projection.schedule.scheduleGames.filter(
        (game) => game.expectedStartMs !== game.scheduledStartMs,
      )) {
        const card = container.querySelector(`[data-game-code="${game.gameCode}"]`);
        expect(card?.textContent).toContain("Scheduled");
        expect(card?.textContent).toContain(
          new Intl.DateTimeFormat(undefined, {
            timeZone: "UTC",
            hour: "2-digit",
            minute: "2-digit",
          }).format(game.scheduledStartMs),
        );
      }
      await act(async () => {
        MockWebSocket.instances.at(-1)?.receive({
          protocol: "public-event-stream-v1",
          type: "projection-replaced",
          eventId: projection.eventId,
          version: 2,
          projection: {
            ...projection,
            schedule: { ...projection.schedule, asOfMs: 1, focusIndex: 0 },
          },
        });
        await Promise.resolve();
      });
      expect(JSON.stringify(scrolled)).toBe(JSON.stringify([focused]));
    } finally {
      if (originalScroll)
        Object.defineProperty(testWindow.HTMLElement.prototype, "scrollIntoView", originalScroll);
      else Reflect.deleteProperty(testWindow.HTMLElement.prototype, "scrollIntoView");
    }
  });

  test.each(["running", "future", "past"] as const)(
    "opens the whole %s Game card on its own screen and preserves native link gestures",
    async (status) => {
      const projection = publishedEventProjection("card-event", "Card Event");
      const game = publicCardGame(status);
      const unavailable = {
        ...game,
        eventGameId: "unavailable",
        gameCode: "GAME-2",
        gameDesignation: "Unavailable Game",
        canonicalPath: "/events/card-event/games/unavailable",
        spectatorAvailable: false,
      };
      projection.schedule.scheduleGames = [game, unavailable];
      if (status === "running") projection.schedule.runningGames = [game, unavailable];
      if (status === "future") projection.schedule.upcomingGames = [game, unavailable];
      testWindow.history.replaceState(null, "", `${projection.canonicalPath}?view=schedule`);
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ status: "accepted", value: projection }), {
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;
      await act(async () => {
        root.render(<App />);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      const links = container.querySelectorAll(`a[href="${game.canonicalPath}"]`);
      expect(links.length).toBe(1);
      expect(container.querySelector(`a[href="${unavailable.canonicalPath}"]`)).toBeNull();
      expect(container.querySelector("[data-game-timeline]")).toBeNull();
      expect(container.textContent).not.toContain("Game history");
      if (status === "running")
        expect(container.textContent).toContain("Heat stoppage: Inactive · decision pending");
      for (const link of links) {
        expect(link.querySelector("article")).not.toBeNull();
        expect(link.querySelector("a, button, details")).toBeNull();
        expect(link.getAttribute("aria-label")).toContain("Blue Team vs Red Team");
      }
      const link = links[0]!;
      const score = link.querySelector("article")!;
      for (const gesture of [
        { metaKey: true },
        { ctrlKey: true },
        { shiftKey: true },
        { altKey: true },
        { button: 1 },
      ]) {
        const click = new testWindow.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          ...gesture,
        });
        score.dispatchEvent(click as unknown as Event);
        expect(click.defaultPrevented).toBe(false);
        // Happy DOM follows even modified links; reset its native navigation.
        testWindow.history.replaceState(null, "", `${projection.canonicalPath}?view=schedule`);
      }
      await act(async () => {
        score.dispatchEvent(
          new testWindow.MouseEvent("click", {
            bubbles: true,
            cancelable: true,
          }) as unknown as Event,
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(testWindow.location.pathname).toBe(game.canonicalPath);
      expect(container.querySelector("[data-scoreboard-expanded]")).not.toBeNull();
      expect(container.textContent).toContain("No public play history is available yet.");
    },
  );

  test("refetches the authoritative projection before reconnecting after a dropped WebSocket", async () => {
    testWindow.history.replaceState(null, "", "/events/reconnect-event");
    const projection = publishedEventProjection("reconnect-event", "Initial Event");
    let reads = 0;
    (globalThis.fetch as typeof fetch) = (async () => {
      reads += 1;
      const value =
        reads === 1 ? projection : { ...projection, name: `Recovered Event ${reads - 1}` };
      return new Response(JSON.stringify({ status: "accepted", value }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    let priorSocket = MockWebSocket.instances.at(-1);
    expect(priorSocket).not.toBeUndefined();
    expect(container.textContent).toContain("Initial Event");

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await act(async () => {
        priorSocket?.close();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      const recoveredSocket = MockWebSocket.instances.at(-1);
      expect(reads).toBe(cycle + 1);
      expect(recoveredSocket).not.toBe(priorSocket);
      expect(recoveredSocket?.sentMessages).toContain(
        JSON.stringify({ type: "subscribe-public-event", eventId: "reconnect-event" }),
      );
      expect(container.textContent).toContain(`Recovered Event ${cycle}`);
      priorSocket = recoveredSocket;
    }
  });

  test("clears the prior Audience Projection before rendering terminal Event unavailability", async () => {
    testWindow.history.replaceState(null, "", "/events/terminal-event");
    const projection = publishedEventProjection("terminal-event", "Previously Published Event");
    (globalThis.fetch as typeof fetch) = (async () =>
      new Response(JSON.stringify({ status: "accepted", value: projection }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const socket = MockWebSocket.instances.at(-1);
    expect(container.textContent).toContain("Previously Published Event");

    await act(async () => {
      socket?.receive({
        protocol: "public-event-stream-v1",
        type: "event-unavailable",
        eventId: "terminal-event",
      });
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Event unavailable");
    expect(container.textContent).not.toContain("Previously Published Event");
  });
});
