import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { App } from "./App";
import { createInitialGameState, projectGameView } from "@/lib/game-engine";

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
    // eslint-disable-next-line typescript-eslint/unbound-method
    const originalPrototypeGetBoundingClientRect = testWindow.HTMLElement.prototype
      .getBoundingClientRect as unknown as (this: unknown) => unknown;
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

    expect(homeHeading).not.toBeNull();
    expect(awayHeading).not.toBeNull();
    expect(homeHeading?.className).toContain("text-sky-800");
    expect(awayHeading?.className).toContain("text-orange-800");
  });
});
