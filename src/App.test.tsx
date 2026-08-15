import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { App, parseRoute } from "./App";
import { captureAdHocHandoffFromLocation } from "@/lib/ad-hoc-handoff";
import { createInitialGameState, projectGameView } from "@/lib/game-engine";
import { DEFAULT_AWAY_TEAM_COLOR, DEFAULT_HOME_TEAM_COLOR } from "@/lib/team-colors";
import { createInitialClockBaseline, projectClockBaseline } from "@/lib/clock-authority";

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

  close() {
    if (this.readyState === MockWebSocket.CLOSED) {
      return;
    }

    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close"));
  }
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

  test("parses the stable public Event route", () => {
    expect(parseRoute("/events/event-123", "")).toEqual({
      type: "event",
      eventId: "event-123",
    });
    expect(parseRoute("/events", "?view=all")).toEqual({ type: "home", showAll: true });
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
    const setter = Object.getOwnPropertyDescriptor(
      testWindow.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
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
    testWindow.history.replaceState(null, "", "/");

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
      (button.textContent ?? "").includes("Create new game"),
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
    testWindow.history.replaceState(null, "", "/");
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
      (button.textContent ?? "").includes("Create new game"),
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
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Score Button Color Test");
    const previews = Array.from(container.getElementsByTagName("section")).filter(
      (section) => section.getAttribute("data-color-preview") === "true",
    );
    expect(previews).toHaveLength(100);
  });

  test("lists public Events with the Ad Hoc handoff between upcoming and past content", async () => {
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
                gameDays: ["2026-08-14"],
                lifecycle: "current",
                canonicalPath: "/events/current",
                teams: [],
                pitches: [],
              },
              {
                eventId: "future",
                name: "Future Event",
                timeZone: "UTC",
                publicationStatus: "published",
                gameDays: ["2026-08-15"],
                lifecycle: "future",
                canonicalPath: "/events/future",
                teams: [],
                pitches: [],
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
              },
              {
                eventId: "current-two",
                name: "Another Current Event",
                timeZone: "UTC",
                publicationStatus: "published",
                gameDays: ["2026-08-14"],
                lifecycle: "current",
                canonicalPath: "/events/current-two",
                teams: [],
                pitches: [],
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
    expect(text).toContain("Unscheduled Events");
    expect(text).toContain("Start Ad Hoc Game");
    expect(text).toContain("Past Event");
    expect(text.indexOf("Future Event")).toBeLessThan(text.indexOf("Start Ad Hoc Game"));
    expect(text.indexOf("Start Ad Hoc Game")).toBeLessThan(text.indexOf("Past Event"));
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
                gameDays: ["2026-08-14"],
                lifecycle: "current",
                canonicalPath: "/events/only-current",
                teams: [],
                pitches: [],
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
              gameDays: ["2026-08-14"],
              lifecycle: "current",
              canonicalPath: "/events/visible-event",
              teams: [],
              pitches: [],
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
                gameDays: ["2026-08-14"],
                lifecycle: "current",
                canonicalPath: "/events/visible-event",
                teams: [],
                pitches: [],
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

    const allEvents = Array.from(container.getElementsByTagName("button")).find((button) =>
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
});
