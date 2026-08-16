import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { CONTROLLER_LEAVE_GRACE_MS, createControllerDeparture } from "@/lib/controller-departure";
import {
  createBrowserEventControllerSessionStorage,
  readBrowserEventControllerSession,
} from "@/lib/event-controller-session";

describe("Event Controller credential store", () => {
  const originalWindow = globalThis.window;
  const originalLocalStorage = globalThis.localStorage;
  const originalSessionStorage = globalThis.sessionStorage;
  let testWindow: Window;

  beforeEach(() => {
    testWindow = new Window({ url: "http://timer.quadball.app/event-control" });
    Object.assign(globalThis, {
      window: testWindow,
      localStorage: testWindow.localStorage,
      sessionStorage: testWindow.sessionStorage,
    });
  });

  afterEach(() => {
    testWindow.close();
    Object.assign(globalThis, {
      window: originalWindow,
      localStorage: originalLocalStorage,
      sessionStorage: originalSessionStorage,
    });
  });

  test("retains Event A while Event B is current for deferred finalization", () => {
    const storage = createBrowserEventControllerSessionStorage();
    expect(
      storage.write({
        eventGameId: "event-a",
        sessionBearer: "bearer-a",
        sessionReferenceId: "session-a",
      }),
    ).toBe(true);
    expect(
      storage.write({
        eventGameId: "event-b",
        sessionBearer: "bearer-b",
        sessionReferenceId: "session-b",
      }),
    ).toBe(true);

    expect(readBrowserEventControllerSession()).toEqual({
      eventGameId: "event-b",
      sessionBearer: "bearer-b",
      sessionReferenceId: "session-b",
    });
    expect(storage.readForGame("event-a")).toEqual({
      eventGameId: "event-a",
      sessionBearer: "bearer-a",
      sessionReferenceId: "session-a",
    });
    storage.clear("event-a");
    expect(storage.readForGame("event-a")).toBeNull();
    expect(storage.readForGame("event-b")).toEqual({
      eventGameId: "event-b",
      sessionBearer: "bearer-b",
      sessionReferenceId: "session-b",
    });
  });

  test("retains same-Game old and new Grant Sessions for exact deferred finalization", async () => {
    const storage = createBrowserEventControllerSessionStorage();
    storage.write({
      eventGameId: "event-a",
      sessionBearer: "bearer-old",
      sessionReferenceId: "session-old",
    });
    const departureModule = createControllerDeparture();
    const departure = {
      workflow: "event" as const,
      gameId: "event-a",
      sessionReferenceId: "session-old",
      navigationPath: "/event-control",
      identity: { title: "Event Game", homeName: "Basel", awayName: "Zurich" },
    };
    Object.defineProperty(testWindow.navigator, "onLine", { configurable: true, value: false });
    await departureModule.transition({ type: "leave", departure, online: false, nowMs: 0 });
    await departureModule.transition({
      type: "expire",
      online: false,
      nowMs: CONTROLLER_LEAVE_GRACE_MS,
    });
    storage.write({
      eventGameId: "event-a",
      sessionBearer: "bearer-new",
      sessionReferenceId: "session-new",
    });
    expect(storage.read()).toEqual({
      eventGameId: "event-a",
      sessionBearer: "bearer-new",
      sessionReferenceId: "session-new",
    });
    expect(createBrowserEventControllerSessionStorage().read()).toEqual({
      eventGameId: "event-a",
      sessionBearer: "bearer-new",
      sessionReferenceId: "session-new",
    });

    const originalFetch = globalThis.fetch;
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input, init) => {
      bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
      return new Response(JSON.stringify({ status: "left" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      Object.defineProperty(testWindow.navigator, "onLine", { configurable: true, value: true });
      testWindow.dispatchEvent(new testWindow.Event("online"));
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
      expect(bodies).toEqual([{ sessionBearer: "bearer-old" }]);
      expect(storage.readForGame("event-a", "session-new")).toMatchObject({
        sessionBearer: "bearer-new",
      });
    } finally {
      departureModule.dispose();
      globalThis.fetch = originalFetch;
    }
  });

  test("treats a production-shaped HTTP 409 switch-required refresh as available", async () => {
    const storage = createBrowserEventControllerSessionStorage();
    storage.write({
      eventGameId: "event-conflict",
      sessionBearer: "bearer-conflict",
      sessionReferenceId: "session-conflict",
    });
    const departureModule = createControllerDeparture();
    const departure = {
      workflow: "event" as const,
      gameId: "event-conflict",
      sessionReferenceId: "session-conflict",
      navigationPath: "/event-control",
      identity: { title: "Event Game", homeName: "Basel", awayName: "Zurich" },
    };
    await departureModule.transition({ type: "leave", departure, online: false, nowMs: 0 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: "switch-required" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    try {
      const result = await departureModule.transition({
        type: "return",
        gameId: "event-conflict",
        online: true,
      });
      expect(result).toEqual({ status: "resumed", mode: "online" });
      expect(departureModule.project()).toMatchObject({ status: "returned" });
    } finally {
      departureModule.dispose();
      globalThis.fetch = originalFetch;
    }
  });

  test("fails closed on a partial write and on divergent storage copies", () => {
    const storage = createBrowserEventControllerSessionStorage();
    const sessionSetItem = testWindow.sessionStorage.setItem.bind(testWindow.sessionStorage);
    Object.defineProperty(testWindow.sessionStorage, "setItem", {
      configurable: true,
      value: () => {
        throw new Error("session quota");
      },
    });
    expect(storage.write({ eventGameId: "event-a", sessionBearer: "bearer-a" })).toBe(false);
    expect(readBrowserEventControllerSession()).toBeNull();

    Object.defineProperty(testWindow.sessionStorage, "setItem", {
      configurable: true,
      value: sessionSetItem,
    });
    testWindow.localStorage.setItem(
      "quadball:event-controller-session",
      JSON.stringify({ sessionBearer: "bearer-a", eventGameId: "event-a" }),
    );
    testWindow.sessionStorage.setItem(
      "quadball:event-controller-session",
      JSON.stringify({ sessionBearer: "bearer-b", eventGameId: "event-b" }),
    );
    expect(readBrowserEventControllerSession()).toBeNull();
  });

  test("migrates the single #268 credential without changing its identity", () => {
    const legacy = JSON.stringify({ sessionBearer: "bearer-a", eventGameId: "event-a" });
    testWindow.localStorage.setItem("quadball:event-controller-session", legacy);
    testWindow.sessionStorage.setItem("quadball:event-controller-session", legacy);
    expect(readBrowserEventControllerSession()).toEqual({
      eventGameId: "event-a",
      sessionBearer: "bearer-a",
      sessionReferenceId: "legacy-event-session-event-a",
    });
  });

  test("migrates a v3 same-Game document to its newest current session", () => {
    const legacy = JSON.stringify({
      version: "event-controller-session-v3",
      currentEventGameId: "event-a",
      sessions: [
        { eventGameId: "event-a", sessionBearer: "bearer-old", sessionReferenceId: "session-old" },
        { eventGameId: "event-a", sessionBearer: "bearer-new", sessionReferenceId: "session-new" },
      ],
    });
    testWindow.localStorage.setItem("quadball:event-controller-session", legacy);
    testWindow.sessionStorage.setItem("quadball:event-controller-session", legacy);

    expect(readBrowserEventControllerSession()).toEqual({
      eventGameId: "event-a",
      sessionBearer: "bearer-new",
      sessionReferenceId: "session-new",
    });
  });
});
