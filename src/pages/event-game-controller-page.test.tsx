import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { EventGameControllerPage } from "@/pages/event-game-controller-page";
import {
  controllerReplicaStorageKey,
  createControllerReplica,
  dispatchControllerAction,
} from "@/lib/controller-reconnect";
import type { ControllerProjection } from "@/lib/live-event-game-control";
import { createInitialClockBaseline, projectClockBaseline } from "@/lib/clock-authority";

describe("Event Game Controller reconnect browser seam", () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalNavigator = globalThis.navigator;
  const originalSessionStorage = globalThis.sessionStorage;
  const originalLocalStorage = globalThis.localStorage;
  const originalFetch = globalThis.fetch;
  const originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  let testWindow: Window;
  let container: HTMLDivElement;
  let root: Root;
  let replayMode: "lost" | "success" | "deferred";
  let replayCalls: number;
  let replayBodies: Record<string, any>[];
  let intentCalls: number;
  let intentBodies: Record<string, any>[];
  let openGrantSessionId: string;
  let openGrantVersion: string;
  let openBearer: string;
  let refreshProjection: ControllerProjection | null;
  let refreshRejected: boolean;
  let switchRequested: boolean;
  let deferredReplay: ((response: Response) => void) | null;
  let deferredReplayResponse: Response | null;

  beforeEach(() => {
    replayMode = "lost";
    replayCalls = 0;
    replayBodies = [];
    intentCalls = 0;
    intentBodies = [];
    openGrantSessionId = "session";
    openGrantVersion = "version";
    openBearer = "bearer";
    refreshProjection = projection();
    refreshRejected = false;
    switchRequested = false;
    deferredReplay = null;
    deferredReplayResponse = null;
    testWindow = new Window({ url: "http://timer.quadball.app/event-control" });
    Object.assign(globalThis, {
      window: testWindow,
      document: testWindow.document,
      navigator: testWindow.navigator,
      sessionStorage: testWindow.sessionStorage,
      localStorage: testWindow.localStorage,
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith("/api/event-control/open")) {
          return new Response(
            JSON.stringify({
              status: "opened",
              eventGameId: "game-browser",
              session: {
                sessionBearer: openBearer,
                grantSessionId: openGrantSessionId,
                grantVersion: openGrantVersion,
              },
              projection: projection(),
              projectionStatus: "available",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.endsWith("/api/event-control/replay")) {
          replayCalls += 1;
          const rawBody = typeof init?.body === "string" ? init.body : "";
          const body = JSON.parse(rawBody) as {
            batchId: string;
            replicaGeneration: string;
            eventGameId: string;
            grantSessionId: string;
            grantVersion: string;
            actions: { intent: { operationId: string } }[];
          };
          replayBodies.push(body);
          if (replayMode === "lost") throw new Error("offline");
          const replayResponse = new Response(
            JSON.stringify({
              batchId: body.batchId,
              replicaGeneration: body.replicaGeneration,
              eventGameId: body.eventGameId,
              session: {
                eventGameId: body.eventGameId,
                grantSessionId: body.grantSessionId,
                grantVersion: body.grantVersion,
              },
              status: "synchronized",
              outcomes: body.actions.map((action) => ({
                operationId: action.intent.operationId,
                status: "accepted",
              })),
              projection: projection(),
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
          if (replayMode === "deferred") {
            deferredReplayResponse = replayResponse;
            return await new Promise<Response>((resolve) => {
              deferredReplay = resolve;
            });
          }
          return replayResponse;
        }
        if (url.endsWith("/api/event-control/refresh")) {
          if (refreshRejected) return new Response("rejected", { status: 401 });
          if (switchRequested) {
            return new Response(
              JSON.stringify({
                status: "switch-required",
                previousEventGameId: "game-browser",
                currentEventGameId: "game-b",
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return new Response(
            JSON.stringify({
              status: "authorized",
              session: {
                eventGameId: "game-browser",
                grantSessionId: openGrantSessionId,
                grantVersion: openGrantVersion,
              },
              projection: refreshProjection,
              projectionStatus: refreshProjection === null ? "unavailable" : "available",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.endsWith("/api/event-control/intent")) {
          intentCalls += 1;
          const rawBody = typeof init?.body === "string" ? init.body : "";
          const body = JSON.parse(rawBody) as {
            intent: { operationId: string };
          };
          intentBodies.push(body as Record<string, any>);
          return new Response(
            JSON.stringify({
              status: "accepted",
              acknowledgement: { status: "acknowledged", operationId: body.intent.operationId },
              projection: projection(),
              projectionStatus: "available",
              synchronization: { status: "synchronized", pendingCount: 0 },
              auditReference: { kind: "control", id: "audit-online" },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.endsWith("/api/event-control/leave")) {
          return new Response(JSON.stringify({ status: "left" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/api/event-control/switch")) {
          return new Response(
            JSON.stringify({
              status: "authorized",
              session: {
                eventGameId: "game-b",
                grantSessionId: "session-b",
                grantVersion: "version-b",
              },
              projection: projection("game-b"),
              projectionStatus: "available",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("Not found", { status: 404 });
      },
    });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  async function enterAndOpen() {
    await act(async () => {
      root.render(<EventGameControllerPage />);
      await Promise.resolve();
    });
    const grantInput = container.querySelector("input#control-grant") as HTMLInputElement;
    await act(async () => {
      grantInput.value = "qr-credential";
      grantInput.dispatchEvent(
        new testWindow.Event("input", { bubbles: true }) as unknown as Event,
      );
      grantInput.dispatchEvent(
        new testWindow.Event("change", { bubbles: true }) as unknown as Event,
      );
      await Promise.resolve();
    });
    await act(async () => {
      Array.from(container.getElementsByTagName("button"))
        .find((button) => button.textContent?.includes("Open Controller"))
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
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
      sessionStorage: originalSessionStorage,
      localStorage: originalLocalStorage,
      fetch: originalFetch,
    });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      originalActEnvironment;
  });

  test("renders an optimistic action immediately and retains it through a lost replay", async () => {
    await act(async () => {
      root.render(<EventGameControllerPage />);
      await Promise.resolve();
    });
    const grantInput = container.querySelector("input#control-grant") as HTMLInputElement;
    await act(async () => {
      grantInput.value = "qr-credential";
      grantInput.dispatchEvent(
        new testWindow.Event("input", { bubbles: true }) as unknown as Event,
      );
      grantInput.dispatchEvent(
        new testWindow.Event("change", { bubbles: true }) as unknown as Event,
      );
      await Promise.resolve();
    });
    const openButton = Array.from(container.getElementsByTagName("button")).find((button) =>
      button.textContent?.includes("Open Controller"),
    );
    await act(async () => {
      openButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const goalButton = Array.from(container.getElementsByTagName("button")).find((button) =>
      button.textContent?.includes("Record 10-point goal"),
    );
    expect(goalButton).not.toBeNull();
    await act(async () => {
      goalButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("10");
    expect(container.textContent).toContain("retained for reconnect replay");
    const stored = JSON.parse(
      testWindow.localStorage.getItem(controllerReplicaStorageKey("game-browser")) ?? "null",
    ) as { pendingActions?: unknown[] };
    expect(stored.pendingActions).toHaveLength(1);
  });

  test("revalidates a fresh same-Game authority before foreground replay", async () => {
    replayMode = "success";
    await act(async () => {
      root.render(<EventGameControllerPage />);
      await Promise.resolve();
    });
    const grantInput = container.querySelector("input#control-grant") as HTMLInputElement;
    await act(async () => {
      grantInput.value = "qr-credential";
      grantInput.dispatchEvent(
        new testWindow.Event("input", { bubbles: true }) as unknown as Event,
      );
      grantInput.dispatchEvent(
        new testWindow.Event("change", { bubbles: true }) as unknown as Event,
      );
      await Promise.resolve();
    });
    await act(async () => {
      Array.from(container.getElementsByTagName("button"))
        .find((button) => button.textContent?.includes("Open Controller"))
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const goalButton = Array.from(container.getElementsByTagName("button")).find((button) =>
      button.textContent?.includes("Record 10-point goal"),
    );
    await act(async () => {
      goalButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(replayCalls).toBe(1);
    expect(replayBodies[0]?.actions[0]?.intent.occurrence.source).toBe("online");
    expect(container.textContent).not.toContain("retained for reconnect replay");
  });

  test("fresh same-Game scan replays retained work with original evidence", async () => {
    replayMode = "lost";
    await enterAndOpen();
    Object.defineProperty(testWindow.navigator, "onLine", { configurable: true, value: false });
    const goalButton = Array.from(container.getElementsByTagName("button")).find((button) =>
      button.textContent?.includes("Record 10-point goal"),
    );
    await act(async () => {
      goalButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const retainedBody = replayBodies[0];
    expect(retainedBody?.actions).toHaveLength(1);
    const retainedIntent = retainedBody?.actions[0]?.intent;
    await act(async () => {
      Array.from(container.getElementsByTagName("button"))
        .find((button) => button.textContent?.includes("Leave Controller Session"))
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    openGrantSessionId = "session-fresh";
    openGrantVersion = "version-fresh";
    replayMode = "success";
    Object.defineProperty(testWindow.navigator, "onLine", { configurable: true, value: true });
    await enterAndOpen();
    expect(replayCalls).toBe(2);
    expect(replayBodies[1]?.grantSessionId).toBe("session-fresh");
    expect(replayBodies[1]?.grantVersion).toBe("version-fresh");
    expect(replayBodies[1]?.actions[0]?.intent).toMatchObject({
      operationId: retainedIntent?.operationId,
      factId: retainedIntent?.factId,
      occurrence: retainedIntent?.occurrence,
    });
  });

  test("foreground revalidation completes before replaying retained work", async () => {
    replayMode = "lost";
    await enterAndOpen();
    Object.defineProperty(testWindow.navigator, "onLine", { configurable: true, value: false });
    const goalButton = Array.from(container.getElementsByTagName("button")).find((button) =>
      button.textContent?.includes("Record 10-point goal"),
    );
    await act(async () => {
      goalButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(replayCalls).toBe(1);
    replayMode = "success";
    Object.defineProperty(testWindow.navigator, "onLine", { configurable: true, value: true });
    await act(async () => {
      document.dispatchEvent(new testWindow.Event("visibilitychange") as unknown as Event);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(replayCalls).toBe(2);
    expect(container.textContent).not.toContain("retained for reconnect replay");
    expect(container.textContent).toContain("Clock resynchronized.");
  });

  test("unmount and remount restores persisted work before foreground replay", async () => {
    replayMode = "lost";
    await enterAndOpen();
    Object.defineProperty(testWindow.navigator, "onLine", { configurable: true, value: false });
    const goalButton = Array.from(container.getElementsByTagName("button")).find((button) =>
      button.textContent?.includes("Record 10-point goal"),
    );
    await act(async () => {
      goalButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    replayMode = "success";
    Object.defineProperty(testWindow.navigator, "onLine", { configurable: true, value: true });
    root = createRoot(container);
    await act(async () => {
      root.render(<EventGameControllerPage />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(replayCalls).toBe(2);
    expect(container.textContent).not.toContain("retained for reconnect replay");
  });

  test("unmount and remount preserves the authoritative base when refresh has no projection", async () => {
    replayMode = "lost";
    await enterAndOpen();
    Object.defineProperty(testWindow.navigator, "onLine", { configurable: true, value: false });
    await act(async () => {
      Array.from(container.getElementsByTagName("button"))
        .find((button) => button.textContent?.includes("Record 10-point goal"))
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const storageKey = controllerReplicaStorageKey("game-browser");
    const before = JSON.parse(testWindow.localStorage.getItem(storageKey) ?? "null") as {
      authoritativeProjection: ControllerProjection;
      projection: ControllerProjection;
    };
    expect(before.authoritativeProjection.goalCount).toBe(0);
    expect(before.projection.goalCount).toBe(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    refreshProjection = null;
    root = createRoot(container);
    await act(async () => {
      root.render(<EventGameControllerPage />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Goals: 1");
    expect(container.textContent).not.toContain("Goals: 2");
    const after = JSON.parse(testWindow.localStorage.getItem(storageKey) ?? "null") as {
      authoritativeProjection: ControllerProjection;
      projection: ControllerProjection;
    };
    expect(after.authoritativeProjection.goalCount).toBe(0);
    expect(after.projection.goalCount).toBe(1);
  });

  test("reconnect drains successive bounded batches without another wake event", async () => {
    replayMode = "success";
    let storedReplica = createControllerReplica({
      eventGameId: "game-browser",
      projection: projection(),
      grantSessionId: "session",
      grantVersion: "version",
      deviceId: "batch-drain-device",
      replicaGeneration: "batch-drain-generation",
    });
    for (let index = 0; index < 101; index += 1) {
      storedReplica = dispatchControllerAction(storedReplica, {
        version: "live-event-control-intent-v1",
        type: "reset",
        operationId: `batch-drain-operation-${index}`,
        factId: `batch-drain-fact-${index}`,
        gameTimeMs: 0,
        occurrence: { clientOriginAtMs: index, source: "offline" },
      }).state;
    }
    testWindow.localStorage.setItem(
      controllerReplicaStorageKey("game-browser"),
      JSON.stringify(storedReplica),
    );
    testWindow.sessionStorage.setItem(
      "quadball:event-controller-session",
      JSON.stringify({ sessionBearer: "bearer", eventGameId: "game-browser" }),
    );

    await act(async () => {
      root.render(<EventGameControllerPage />);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(replayCalls).toBe(2);
    expect(replayBodies.map((body) => body.actions.length)).toEqual([100, 1]);
    expect(container.textContent).not.toContain("retained for reconnect replay");
  });

  test("fresh authority supersedes an in-flight replay and starts exactly one newest-bearer replay", async () => {
    replayMode = "deferred";
    await enterAndOpen();
    const goalButton = Array.from(container.getElementsByTagName("button")).find((button) =>
      button.textContent?.includes("Record 10-point goal"),
    );
    await act(async () => {
      goalButton?.click();
      await Promise.resolve();
    });
    expect(replayCalls).toBe(1);
    expect(deferredReplay).not.toBeNull();
    const retainedIntent = replayBodies[0]?.actions[0]?.intent;

    await act(async () => {
      Array.from(container.getElementsByTagName("button"))
        .find((button) => button.textContent?.includes("Leave Controller Session"))
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    openBearer = "bearer-b";
    openGrantSessionId = "session-b";
    openGrantVersion = "version-b";
    replayMode = "success";
    await enterAndOpen();
    expect(replayCalls).toBe(1);

    expect(deferredReplayResponse).not.toBeNull();
    deferredReplay?.(deferredReplayResponse as Response);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(replayCalls).toBe(2);
    expect(replayBodies[1]).toMatchObject({
      sessionBearer: "bearer-b",
      grantSessionId: "session-b",
      grantVersion: "version-b",
    });
    expect(replayBodies[1]?.actions[0]?.intent).toMatchObject({
      operationId: retainedIntent?.operationId,
      factId: retainedIntent?.factId,
      occurrence: retainedIntent?.occurrence,
    });
    expect(container.textContent).not.toContain("retained for reconnect replay");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(replayCalls).toBe(2);
  });

  test("online Clock submits directly while disconnected holder Clock taps stay in the replica", async () => {
    await enterAndOpen();
    Object.defineProperty(testWindow.navigator, "onLine", { configurable: true, value: true });
    await act(async () => {
      Array.from(container.getElementsByTagName("button"))
        .find((button) => button.textContent?.includes("Start clock"))
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(intentCalls).toBe(1);
    expect(intentBodies[0]?.intent.occurrence.source).toBe("online");
    Object.defineProperty(testWindow.navigator, "onLine", { configurable: true, value: false });
    await act(async () => {
      Array.from(container.getElementsByTagName("button"))
        .find((button) => button.textContent?.includes("Pause clock"))
        ?.click();
      await Promise.resolve();
    });
    expect(intentCalls).toBe(1);
    expect(container.textContent).toContain("Clock action retained for synchronization");
    const stored = JSON.parse(
      testWindow.localStorage.getItem(controllerReplicaStorageKey("game-browser")) ?? "null",
    ) as { pendingActions?: unknown[] };
    expect(stored.pendingActions).toHaveLength(1);
  });

  test("admitted device performs a confirmed emergency takeover while disconnected", async () => {
    replayMode = "lost";
    await enterAndOpen();
    Object.defineProperty(testWindow.navigator, "onLine", { configurable: true, value: false });
    Object.defineProperty(testWindow, "confirm", {
      configurable: true,
      value: () => true,
    });
    const takeover = container.querySelector(
      'button[data-clock-takeover="true"]',
    ) as HTMLButtonElement;
    expect(takeover).not.toBeNull();
    await act(async () => {
      takeover.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain(
      "Emergency clock takeover retained for synchronization",
    );
    const stored = JSON.parse(
      testWindow.localStorage.getItem(controllerReplicaStorageKey("game-browser")) ?? "null",
    ) as { pendingActions?: { intent?: { type?: string; confirmation?: string } }[] };
    expect(stored.pendingActions?.[0]?.intent).toMatchObject({
      type: "clock-takeover",
      confirmation: "physical-timekeeper-or-head-referee",
    });
  });

  test("quota warning is prominent while ordinary actions continue in memory", async () => {
    Object.defineProperty(testWindow.localStorage, "setItem", {
      configurable: true,
      value: () => {
        throw new Error("quota");
      },
    });
    await enterAndOpen();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("full or unavailable");
    const goalButton = Array.from(container.getElementsByTagName("button")).find((button) =>
      button.textContent?.includes("Record 10-point goal"),
    );
    await act(async () => {
      goalButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("10");
    expect(container.textContent).toContain("retained for reconnect replay");
  });

  test("failed foreground authority revalidation retains evidence and submits no replay", async () => {
    await act(async () => {
      root.render(<EventGameControllerPage />);
      await Promise.resolve();
    });
    const grantInput = container.querySelector("input#control-grant") as HTMLInputElement;
    await act(async () => {
      grantInput.value = "qr-credential";
      grantInput.dispatchEvent(
        new testWindow.Event("input", { bubbles: true }) as unknown as Event,
      );
      grantInput.dispatchEvent(
        new testWindow.Event("change", { bubbles: true }) as unknown as Event,
      );
      await Promise.resolve();
    });
    await act(async () => {
      Array.from(container.getElementsByTagName("button"))
        .find((button) => button.textContent?.includes("Open Controller"))
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const goalButton = Array.from(container.getElementsByTagName("button")).find((button) =>
      button.textContent?.includes("Record 10-point goal"),
    );
    await act(async () => {
      goalButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const callsBeforeRefresh = replayCalls;
    refreshRejected = true;
    await act(async () => {
      document.dispatchEvent(new testWindow.Event("visibilitychange") as unknown as Event);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(replayCalls).toBe(callsBeforeRefresh);
    expect(container.textContent).toContain("retained for reconnect replay");
  });

  test("switching Games invalidates a deferred old response", async () => {
    replayMode = "deferred";
    await act(async () => {
      root.render(<EventGameControllerPage />);
      await Promise.resolve();
    });
    const grantInput = container.querySelector("input#control-grant") as HTMLInputElement;
    await act(async () => {
      grantInput.value = "qr-credential";
      grantInput.dispatchEvent(
        new testWindow.Event("input", { bubbles: true }) as unknown as Event,
      );
      grantInput.dispatchEvent(
        new testWindow.Event("change", { bubbles: true }) as unknown as Event,
      );
      await Promise.resolve();
    });
    await act(async () => {
      Array.from(container.getElementsByTagName("button"))
        .find((button) => button.textContent?.includes("Open Controller"))
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const goalButton = Array.from(container.getElementsByTagName("button")).find((button) =>
      button.textContent?.includes("Record 10-point goal"),
    );
    await act(async () => {
      goalButton?.click();
      await Promise.resolve();
    });
    expect(deferredReplay).not.toBeNull();
    switchRequested = true;
    await act(async () => {
      Array.from(container.getElementsByTagName("button"))
        .find((button) => button.textContent?.includes("Refresh assignment"))
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      Array.from(container.getElementsByTagName("button"))
        .find((button) => button.textContent?.includes("Switch Event Game"))
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(deferredReplayResponse).not.toBeNull();
    deferredReplay?.(deferredReplayResponse as Response);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Controller Device: game-b");
    const oldGame = JSON.parse(
      testWindow.localStorage.getItem(controllerReplicaStorageKey("game-browser")) ?? "null",
    ) as { pendingActions?: unknown[] };
    expect(oldGame.pendingActions).toHaveLength(1);
  });
});

function projection(eventGameId = "game-browser"): ControllerProjection {
  const baseline = createInitialClockBaseline();
  baseline.holderGrantSessionId = "session";
  baseline.holderGeneration = 1;
  baseline.authorityGeneration = 1;
  return {
    eventGameId,
    phase: "scheduled",
    scoreByGameSide: { "side-a": 0, "side-b": 0 },
    goalCount: 0,
    clock: projectClockBaseline(baseline, 0),
    commencement: {
      status: "provisional",
      commencedAtMs: null,
      provisionalRunningSinceMs: null,
      provisionalElapsedMs: 0,
    },
  };
}
