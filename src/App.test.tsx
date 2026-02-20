import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { App } from "./App";
import { createInitialGameState } from "@/lib/game-engine";

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

      expect(container.textContent).toContain("Tap game time to adjust");
      const hasHookOrderError = errors.some((message) =>
        message.includes("Rendered more hooks than during the previous render"),
      );
      expect(hasHookOrderError).toBe(false);
    } finally {
      console.error = originalConsoleError;
    }
  });
});
