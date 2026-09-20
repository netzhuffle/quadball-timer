import { describe, expect, test } from "bun:test";
import { createServerDrain, createServerWorkTracker, drainServerRoutes } from "./server-drain";
import { createAdHocLiveSessionTracker } from "./ad-hoc-games";
import { createStartupCleanup } from "./startup-resources";

function harness(overrides: Partial<Parameters<typeof createServerDrain>[0]> = {}) {
  const events: string[] = [];
  const work = createServerWorkTracker();
  const timers: { fire(): void; cancelled: boolean; ms: number }[] = [];
  let timerReady = Promise.withResolvers<void>();
  let consumed = 0;
  const drain = createServerDrain({
    work,
    stopAdmission: () => {
      events.push("admission");
    },
    stopBackground: () => {
      events.push("background");
    },
    closeSockets: () => {
      events.push("sockets");
    },
    stopServer: async (force) => {
      events.push(force ? "force" : "stop");
    },
    closeStorage: () => {
      events.push("storage");
    },
    terminate: () => {
      events.push("terminate");
    },
    report: (result) => {
      events.push(result.outcome);
    },
    schedule: (fire, ms) => {
      const timer = { fire, ms, cancelled: false };
      timers.push(timer);
      timerReady.resolve();
      timerReady = Promise.withResolvers<void>();
      return () => {
        timer.cancelled = true;
      };
    },
    ...overrides,
  });
  return {
    drain,
    work,
    events,
    timers,
    async nextTimer() {
      while (timers.length === consumed) await timerReady.promise;
      return timers[consumed++]!;
    },
  };
}

describe("bounded server drain", () => {
  test("stops admission and timers before awaiting sockets and admitted durable work", async () => {
    const action = Promise.withResolvers<void>();
    const connection = Promise.withResolvers<void>();
    let accepting = true;
    const h = harness({
      stopAdmission: () => {
        accepting = false;
      },
      stopServer: () => connection.promise,
    });
    const routes = drainServerRoutes(
      {
        "/action": {
          POST: async () => {
            await action.promise;
            h.events.push("durable", "ack");
            return new Response("accepted");
          },
        },
      },
      { accepting: () => accepting, work: h.work },
    );
    const response = routes["/action"].POST();
    const stopped = h.drain.stop();
    expect(accepting).toBe(false);
    expect((await routes["/action"].POST()).status).toBe(503);
    expect(h.events).toEqual(["background", "sockets"]);
    action.resolve();
    expect((await response).status).toBe(200);
    expect(h.events).not.toContain("storage");
    connection.resolve();
    expect((await stopped).outcome).toBe("graceful");
    expect(h.events).toEqual(["background", "sockets", "durable", "ack", "storage", "graceful"]);
    expect(h.timers.every((timer) => timer.cancelled)).toBe(true);
  });

  test("forces stalled connections on deadline, then closes storage", async () => {
    const h = harness({
      stopServer: (force) => {
        h.events.push(force ? "force" : "stop");
        return force ? Promise.resolve() : new Promise(() => {});
      },
    });
    const stopped = h.drain.stop();
    const timer = await h.nextTimer();
    expect(timer.ms).toBe(8_000);
    timer.fire();
    expect((await stopped).outcome).toBe("forced");
    expect(h.events).toEqual([
      "admission",
      "background",
      "sockets",
      "stop",
      "force",
      "storage",
      "forced",
    ]);
  });

  test("terminates stalled JS without closing storage or acknowledging it", async () => {
    const h = harness();
    void h.work.track(new Promise(() => {}));
    const stopped = h.drain.stop();
    (await h.nextTimer()).fire();
    const forcedTimer = await h.nextTimer();
    expect(forcedTimer.ms).toBe(1_000);
    forcedTimer.fire();
    expect((await stopped).outcome).toBe("failed");
    expect(h.events).toEqual([
      "admission",
      "background",
      "sockets",
      "stop",
      "force",
      "failed",
      "terminate",
    ]);
    expect(h.events).not.toContain("storage");
  });

  test("settles socket disconnect and background work spawned during shutdown", async () => {
    const disconnected = Promise.withResolvers<void>();
    const refreshed = Promise.withResolvers<void>();
    const h = harness({
      closeSockets: () => {
        void h.work.track(disconnected.promise);
      },
      stopBackground: () => {
        void h.work.track(refreshed.promise);
      },
    });
    const stopped = h.drain.stop();
    await h.nextTimer();
    disconnected.resolve();
    expect(h.events).not.toContain("storage");
    refreshed.resolve();
    expect((await stopped).outcome).toBe("graceful");
  });

  test.each([false, true])(
    "handles stop rejection without duplicate cleanup (force rejects: %s)",
    async (forceRejects) => {
      const error = new Error("stop failed");
      const h = harness({
        stopServer: async (force) => {
          h.events.push(force ? "force" : "stop");
          if (!force || forceRejects) throw error;
        },
      });
      const stopped = h.drain.stop();
      expect(h.drain.stop()).toBe(stopped);
      const result = await stopped;
      expect(result.outcome).toBe("failed");
      expect(result.errors).toContain(error);
      expect(h.events.filter((event) => event === "storage")).toHaveLength(forceRejects ? 0 : 1);
      expect(h.events.filter((event) => event === "terminate")).toHaveLength(1);
      expect(h.drain.stop()).toBe(stopped);
    },
  );

  test("waits for work registered after an initially idle shutdown", async () => {
    const connection = Promise.withResolvers<void>();
    const disconnect = Promise.withResolvers<void>();
    const h = harness({ stopServer: () => connection.promise });
    const stopped = h.drain.stop();
    await h.nextTimer();
    void h.work.track(disconnect.promise);
    connection.resolve();
    await Promise.resolve();
    expect(h.events).not.toContain("storage");
    disconnect.resolve();
    expect((await stopped).outcome).toBe("graceful");
  });

  test("owns queued Ad Hoc disconnects through their whole retry task", async () => {
    const durable = Promise.withResolvers<boolean>();
    const h = harness();
    const tracker = createAdHocLiveSessionTracker(() => durable.promise, {
      trackWork: (task) => {
        void h.work.track(task);
      },
    });
    await tracker.subscribe("socket", { gameId: "game", sessionId: "session" });
    const disconnected = tracker.disconnect("socket");
    tracker.stopRetries();
    const stopped = h.drain.stop();
    await h.nextTimer();
    expect(h.events).not.toContain("storage");
    durable.resolve(true);
    expect(await disconnected).toBe(true);
    expect((await stopped).outcome).toBe("graceful");
    expect(tracker.pendingCount()).toBe(0);
    expect(h.work.count()).toBe(0);
  });

  test("a synchronous stop exception takes the bounded forced path", async () => {
    const h = harness({
      stopServer: (force) => {
        if (!force) throw new Error("synchronous stop failure");
        return Promise.resolve();
      },
    });
    expect((await h.drain.stop()).outcome).toBe("failed");
    expect(h.events.filter((event) => event === "storage")).toHaveLength(1);
    expect(h.events.at(-1)).toBe("terminate");
  });

  test("late graceful rejection after forced completion is observed", async () => {
    const graceful = Promise.withResolvers<void>();
    const h = harness({ stopServer: (force) => (force ? Promise.resolve() : graceful.promise) });
    const stopped = h.drain.stop();
    (await h.nextTimer()).fire();
    await stopped;
    graceful.reject(new Error("late rejection"));
    await Promise.resolve();
    expect(h.events.filter((event) => event === "storage")).toHaveLength(1);
  });

  test("a failed background pause terminates without closing possibly live storage", async () => {
    const h = harness({
      stopBackground: () => {
        throw new Error("background pause failed");
      },
    });
    expect((await h.drain.stop()).outcome).toBe("failed");
    expect(h.events).not.toContain("storage");
    expect(h.events.at(-1)).toBe("terminate");
  });

  test("partial startup cleans all resources once even when one close throws", async () => {
    const cleanup = createStartupCleanup();
    const closed: string[] = [];
    cleanup.add(() => {
      closed.push("first");
    });
    cleanup.add(() => {
      closed.push("second");
      throw new Error("close failed");
    });
    const h = harness({ closeStorage: () => cleanup.run() });
    const result = await h.drain.stop();
    expect(result.outcome).toBe("failed");
    expect(closed).toEqual(["second", "first"]);
    expect(h.events.at(-1)).toBe("terminate");
    await h.drain.stop();
    expect(closed).toEqual(["second", "first"]);
  });

  test("all dynamic routes are gated while static bundles remain untouched", async () => {
    const bundle = { index: "static html" };
    let accepting = true;
    const work = createServerWorkTracker();
    const routes = drainServerRoutes(
      {
        "/": bundle,
        "/direct": () => new Response("ok"),
        "/methods": {
          GET: () => new Response("ok"),
          POST: () => Promise.resolve(new Response("ok")),
        },
      },
      { accepting: () => accepting, work },
    );
    expect(routes["/"]).toBe(bundle);
    expect(routes["/direct"]().status).toBe(200);
    accepting = false;
    expect(routes["/direct"]().status).toBe(503);
    expect(routes["/methods"].GET().status).toBe(503);
    expect((await routes["/methods"].POST()).status).toBe(503);
    expect(work.count()).toBe(0);
  });
});
