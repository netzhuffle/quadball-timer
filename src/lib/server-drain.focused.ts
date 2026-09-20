import { expect, test } from "bun:test";
import { createServerDrain, createServerWorkTracker, drainServerRoutes } from "./server-drain";

// Disposable loopback sockets exercise Bun's real asynchronous stop boundary.
test("Bun drains an admitted request and WebSocket before storage closure", async () => {
  const work = createServerWorkTracker();
  const admitted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const sockets = new Set<Bun.ServerWebSocket<undefined>>();
  let accepting = true;
  let storageClosed = false;
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    routes: drainServerRoutes(
      {
        "/action": async () => {
          admitted.resolve();
          await release.promise;
          expect(storageClosed).toBe(false);
          return new Response("durable");
        },
        "/ws": (request: Request, current: Bun.Server<undefined>) =>
          current.upgrade(request, { data: undefined })
            ? undefined
            : new Response("upgrade failed", { status: 400 }),
      },
      { accepting: () => accepting, work },
    ),
    websocket: {
      open(socket) {
        sockets.add(socket);
      },
      message() {},
      close(socket) {
        sockets.delete(socket);
      },
    },
  });
  const drain = createServerDrain({
    work,
    stopAdmission: () => {
      accepting = false;
    },
    stopBackground() {},
    closeSockets: () => {
      for (const socket of sockets) socket.close(1012, "Server restarting.");
    },
    stopServer: (force) => server.stop(force),
    closeStorage: () => {
      storageClosed = true;
    },
    terminate: () => {
      throw new Error("Unexpected forced termination.");
    },
    report() {},
    gracefulMs: 2_000,
    forcedMs: 500,
  });
  const socket = new WebSocket(new URL("/ws", server.url).href.replace("http:", "ws:"));
  try {
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("WebSocket failed"));
    });
    const closed = new Promise<CloseEvent>((resolve) => {
      socket.onclose = resolve;
    });
    const response = fetch(new URL("/action", server.url));
    await admitted.promise;
    const stopped = drain.stop();
    expect(storageClosed).toBe(false);
    release.resolve();
    expect(await (await response).text()).toBe("durable");
    expect((await closed).code).toBe(1012);
    expect((await stopped).outcome).toBe("graceful");
    expect(storageClosed).toBe(true);
  } finally {
    release.resolve();
    socket.close();
    await server.stop(true);
  }
}, 5_000);
