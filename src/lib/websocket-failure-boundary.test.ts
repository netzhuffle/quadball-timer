import { expect, test } from "bun:test";
import { createServerWorkTracker } from "@/lib/server-drain";
import { createWebSocketFailureBoundary } from "@/lib/websocket-failure-boundary";

test("contains synchronous dispatch failure without retrying or accepting work", async () => {
  const work = createServerWorkTracker();
  const socket = {
    closed: false,
    close: (code: number, reason: string) => closed.push([code, reason]),
  };
  const closed: [number, string][] = [];
  const reports: unknown[][] = [];
  let attempts = 0;
  let disconnects = 0;
  const boundary = createWebSocketFailureBoundary({
    work,
    accepting: () => true,
    closed: (ws: typeof socket) => ws.closed,
    monitoring: {
      captureException: (...args: unknown[]) => {
        reports.push(args);
      },
    },
    disconnect: (ws) => {
      disconnects++;
      ws.closed = true;
    },
  });
  const error = new Error("failure");
  expect(
    await boundary.dispatch(socket, () => {
      attempts++;
      throw error;
    }),
  ).toBeUndefined();
  boundary.fail(error, socket);
  expect(attempts).toBe(1);
  expect(work.count()).toBe(0);
  expect(disconnects).toBe(1);
  expect(closed).toEqual([[1011, "Internal server error."]]);
  expect(reports).toEqual([[error, { category: "server", component: "websocket" }]]);
});

test("tracks rejected work and leaves asynchronous disconnect work with its owner", async () => {
  const work = createServerWorkTracker();
  const operation = Promise.withResolvers<void>();
  const durable = Promise.withResolvers<void>();
  const socket = { closed: false, close() {} };
  let attempts = 0;
  const boundary = createWebSocketFailureBoundary({
    work,
    accepting: () => true,
    closed: (ws: typeof socket) => ws.closed,
    monitoring: { captureException() {} },
    disconnect: (ws) => {
      ws.closed = true;
      void work.track(durable.promise);
    },
  });
  const dispatched = boundary.dispatch(socket, () => {
    attempts++;
    return operation.promise;
  });
  expect(work.count()).toBe(1);
  operation.reject(new Error("rejected"));
  expect(await dispatched).toBeUndefined();
  expect(work.count()).toBe(1);
  expect(attempts).toBe(1);
  durable.resolve();
  await work.idle();
  expect(work.count()).toBe(0);
});

test("preserves successful results and ignores closed or stopped admission", async () => {
  const work = createServerWorkTracker();
  let accepting = true;
  const socket = {
    closed: false,
    close() {
      throw new Error("unexpected close");
    },
  };
  let attempts = 0;
  const boundary = createWebSocketFailureBoundary({
    work,
    accepting: () => accepting,
    closed: (ws: typeof socket) => ws.closed,
    monitoring: {
      captureException() {
        throw new Error("unexpected report");
      },
    },
    disconnect() {
      throw new Error("unexpected disconnect");
    },
  });
  expect(
    await boundary.dispatch(socket, () => {
      attempts++;
      return "accepted";
    }),
  ).toBe("accepted");
  expect(work.count()).toBe(0);
  socket.closed = true;
  expect(
    await boundary.dispatch(socket, () => {
      attempts++;
    }),
  ).toBeUndefined();
  boundary.fail(new Error("late callback"), socket);
  socket.closed = false;
  accepting = false;
  expect(
    await boundary.dispatch(socket, () => {
      attempts++;
    }),
  ).toBeUndefined();
  expect(attempts).toBe(1);
});

test.each(["monitor", "disconnect", "close"])(
  "continues cleanup when %s throws and contains repeat failure",
  async (failure) => {
    const events: string[] = [];
    const socket = {
      close() {
        events.push("close");
        if (failure === "close") throw new Error("close");
      },
    };
    const unaffected = {
      close() {
        events.push("unaffected");
      },
    };
    const boundary = createWebSocketFailureBoundary({
      work: createServerWorkTracker(),
      accepting: () => true,
      closed: () => false,
      monitoring: {
        captureException() {
          events.push("monitor");
          if (failure === "monitor") throw new Error("monitor");
        },
      },
      disconnect() {
        events.push("disconnect");
        if (failure === "disconnect") throw new Error("disconnect");
      },
    });
    expect(() => boundary.fail(new Error("failure"), socket)).not.toThrow();
    boundary.fail(new Error("repeat"), socket);
    await boundary.dispatch(socket, () => {
      events.push("retried");
    });
    expect(events).toEqual(["monitor", "disconnect", "close"]);
    expect(await boundary.dispatch(unaffected, () => "healthy")).toBe("healthy");
  },
);
