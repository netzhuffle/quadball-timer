import { describe, expect, test } from "bun:test";
import { createPublicAudienceEventStream } from "@/lib/public-audience-event-stream";
import { createPublicAudienceEventWebSocketHub } from "@/lib/public-audience-event-websocket";
import { PUBLIC_EVENT_STREAM_PROTOCOL } from "@/lib/public-event-stream";

const publishedEvent = {
  eventId: "event-1",
  name: "Published Event",
  timeZone: "UTC",
  publicationStatus: "published" as const,
  gameDays: ["2026-08-15"],
  lifecycle: "current" as const,
  canonicalPath: "/events/event-1",
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

function socketHarness() {
  const messages: unknown[] = [];
  const closed: { code: number; reason: string }[] = [];
  return {
    messages,
    closed,
    socket: {
      send(serialized: string) {
        messages.push(JSON.parse(serialized));
        return true;
      },
      close(code: number, reason: string) {
        closed.push({ code, reason });
      },
    },
  };
}

function capacity() {
  return {
    totalConnections: 10,
    reservedConnections: 2,
    activeControllerSessions: () => 0,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("public Event WebSocket adapter", () => {
  test("delivers the composed authoritative projection and refreshes one upstream feed", async () => {
    const messages: unknown[] = [];
    let reads = 0;
    let currentProjection = publishedEvent;
    const stream = createPublicAudienceEventStream(
      {
        read: async () => {
          reads += 1;
          return { status: "accepted" as const, value: currentProjection };
        },
      },
      { refreshIntervalMs: 60_000 },
    );
    const hub = createPublicAudienceEventWebSocketHub({ stream, controllerCapacity: capacity() });
    const first = socketHarness();
    const second = socketHarness();
    expect((await hub.subscribe("client-1", "event-1", first.socket)).status).toBe("admitted");
    expect((await hub.subscribe("client-2", "event-1", second.socket)).status).toBe("admitted");
    expect(reads).toBe(1);
    messages.push(...first.messages, ...second.messages);
    expect(messages).toEqual([
      {
        protocol: PUBLIC_EVENT_STREAM_PROTOCOL,
        type: "snapshot",
        eventId: "event-1",
        version: 1,
        projection: publishedEvent,
      },
      {
        protocol: PUBLIC_EVENT_STREAM_PROTOCOL,
        type: "snapshot",
        eventId: "event-1",
        version: 1,
        projection: publishedEvent,
      },
    ]);

    currentProjection = { ...publishedEvent, name: "Updated Published Event" };
    expect(await stream.republish("event-1")).toBe("accepted");
    expect(first.messages.at(-1)).toMatchObject({
      type: "projection-replaced",
      version: 2,
      projection: { name: "Updated Published Event" },
    });
    expect(second.messages.at(-1)).toMatchObject({
      type: "projection-replaced",
      version: 2,
      projection: { name: "Updated Published Event" },
    });
    hub.close();
    stream.close();
  });

  test("turns an authoritative read failure into one generic unavailable socket outcome", async () => {
    const stream = createPublicAudienceEventStream({
      read: async () => ({ status: "retryable-failure" as const }),
    });
    const hub = createPublicAudienceEventWebSocketHub({ stream, controllerCapacity: capacity() });
    const socket = socketHarness();
    expect(await hub.subscribe("client-1", "event-1", socket.socket)).toEqual({
      status: "unavailable",
      message: "Spectator experience is currently unavailable.",
    });
    expect(socket.messages).toEqual([]);
    hub.close();
    stream.close();
  });

  test("clears an admitted subscriber on refresh failure without tombstoning fresh recovery", async () => {
    let outcome: "accepted" | "retryable-failure" = "accepted";
    const socket = socketHarness();
    const stream = createPublicAudienceEventStream(
      {
        read: async () =>
          outcome === "accepted"
            ? { status: "accepted" as const, value: publishedEvent }
            : { status: "retryable-failure" as const },
      },
      { refreshIntervalMs: 1 },
    );
    const hub = createPublicAudienceEventWebSocketHub({ stream, controllerCapacity: capacity() });
    expect((await hub.subscribe("client-1", "event-1", socket.socket)).status).toBe("admitted");
    expect(socket.messages).toHaveLength(1);

    outcome = "retryable-failure";
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(socket.messages.at(-1)).toMatchObject({ type: "event-unavailable" });
    expect(socket.closed).toEqual([{ code: 1000, reason: "Public Event stream closed." }]);

    outcome = "accepted";
    const recovered = socketHarness();
    expect((await hub.subscribe("client-2", "event-1", recovered.socket)).status).toBe("admitted");
    expect(recovered.messages[0]).toMatchObject({ type: "snapshot", version: 1 });
    hub.close();
    stream.close();
  });

  test("coalesces repeated ticks during one slow success into exactly one follow-up", async () => {
    const slowRead = deferred<{ status: "accepted"; value: typeof publishedEvent }>();
    const followUpRead = deferred<{ status: "accepted"; value: typeof publishedEvent }>();
    const slowReadStarted = deferred<void>();
    const followUpReadStarted = deferred<void>();
    let reads = 0;
    const slowProjection = { ...publishedEvent, name: "Slow Projection" };
    const followUpProjection = { ...publishedEvent, name: "Follow-up Projection" };
    const stream = createPublicAudienceEventStream(
      {
        read: async () => {
          reads += 1;
          if (reads === 1) return { status: "accepted" as const, value: publishedEvent };
          if (reads === 2) {
            slowReadStarted.resolve();
            return slowRead.promise;
          }
          if (reads === 3) {
            followUpReadStarted.resolve();
            return followUpRead.promise;
          }
          return { status: "accepted" as const, value: followUpProjection };
        },
      },
      { refreshIntervalMs: 2 },
    );
    const hub = createPublicAudienceEventWebSocketHub({ stream, controllerCapacity: capacity() });
    const socket = socketHarness();
    expect((await hub.subscribe("client-1", "event-1", socket.socket)).status).toBe("admitted");
    await slowReadStarted.promise;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(reads).toBe(2);

    slowRead.resolve({ status: "accepted", value: slowProjection });
    await followUpReadStarted.promise;
    expect(reads).toBe(3);
    expect(socket.messages.at(-1)).toMatchObject({
      type: "projection-replaced",
      projection: { name: "Slow Projection" },
    });

    followUpRead.resolve({ status: "accepted", value: followUpProjection });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(socket.messages.at(-1)).toMatchObject({
      type: "projection-replaced",
      projection: { name: "Follow-up Projection" },
    });
    expect(socket.closed).toEqual([]);
    hub.close();
    stream.close();
  });

  test("delivers a slow refresh failure despite repeated pending ticks", async () => {
    const slowRead = deferred<{ status: "retryable-failure" }>();
    const slowReadStarted = deferred<void>();
    let reads = 0;
    const stream = createPublicAudienceEventStream(
      {
        read: async () => {
          reads += 1;
          if (reads === 1) return { status: "accepted" as const, value: publishedEvent };
          if (reads === 2) {
            slowReadStarted.resolve();
            return slowRead.promise;
          }
          return { status: "accepted" as const, value: publishedEvent };
        },
      },
      { refreshIntervalMs: 2 },
    );
    const hub = createPublicAudienceEventWebSocketHub({ stream, controllerCapacity: capacity() });
    const socket = socketHarness();
    expect((await hub.subscribe("client-1", "event-1", socket.socket)).status).toBe("admitted");
    await slowReadStarted.promise;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(reads).toBe(2);

    slowRead.resolve({ status: "retryable-failure" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(socket.messages.at(-1)).toMatchObject({ type: "event-unavailable" });
    expect(socket.closed).toEqual([{ code: 1000, reason: "Public Event stream closed." }]);
    expect(reads).toBe(2);
    hub.close();
    stream.close();
  });

  test.each(["unpublish", "close"] as const)(
    "%s during a slow refresh prevents late projection restoration",
    async (transition) => {
      const slowRead = deferred<{ status: "accepted"; value: typeof publishedEvent }>();
      const slowReadStarted = deferred<void>();
      let reads = 0;
      const stream = createPublicAudienceEventStream(
        {
          read: async () => {
            reads += 1;
            if (reads === 1) return { status: "accepted" as const, value: publishedEvent };
            slowReadStarted.resolve();
            return slowRead.promise;
          },
        },
        { refreshIntervalMs: 2 },
      );
      const hub = createPublicAudienceEventWebSocketHub({ stream, controllerCapacity: capacity() });
      const socket = socketHarness();
      expect((await hub.subscribe("client-1", "event-1", socket.socket)).status).toBe("admitted");
      await slowReadStarted.promise;

      if (transition === "unpublish") await stream.unpublish("event-1");
      else stream.close();
      slowRead.resolve({
        status: "accepted",
        value: { ...publishedEvent, name: "Late Projection" },
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(socket.messages.at(-1)).toMatchObject({ type: "event-unavailable" });
      expect(
        socket.messages.some(
          (message) =>
            (message as { projection?: { name?: string } }).projection?.name === "Late Projection",
        ),
      ).toBe(false);
      hub.close();
      stream.close();
    },
  );

  test("reconciles Controller priority and accounts exact serialized envelopes", async () => {
    let activeControllers = 0;
    const stream = createPublicAudienceEventStream({
      read: async () => ({ status: "accepted" as const, value: publishedEvent }),
    });
    const hub = createPublicAudienceEventWebSocketHub({
      stream,
      controllerCapacity: {
        totalConnections: 3,
        reservedConnections: 1,
        activeControllerSessions: () => activeControllers,
      },
      maxSpectators: 2,
    });
    const first = socketHarness();
    const second = socketHarness();
    expect((await hub.subscribe("client-1", "event-1", first.socket)).status).toBe("admitted");
    expect((await hub.subscribe("client-2", "event-1", second.socket)).status).toBe("admitted");
    activeControllers = 2;
    expect(hub.reconcileControllerCapacity()).toMatchObject({
      status: "reconciled",
      disconnected: 1,
    });
    expect(first.closed).toEqual([]);
    expect(second.closed).toEqual([{ code: 1013, reason: "Controller capacity priority." }]);
    hub.close();
    stream.close();
  });

  test("reconnects from an authoritative current snapshot after the last spectator leaves", async () => {
    let reads = 0;
    const stream = createPublicAudienceEventStream(
      {
        read: async () => {
          reads += 1;
          return { status: "accepted" as const, value: publishedEvent };
        },
      },
      { refreshIntervalMs: 60_000 },
    );
    const hub = createPublicAudienceEventWebSocketHub({ stream, controllerCapacity: capacity() });
    const first = socketHarness();
    const recovered = socketHarness();
    expect((await hub.subscribe("client-1", "event-1", first.socket)).status).toBe("admitted");
    hub.disconnect("client-1", "client-reconnect");
    expect((await hub.subscribe("client-2", "event-1", recovered.socket, "1")).status).toBe(
      "admitted",
    );
    expect(reads).toBe(2);
    expect(recovered.messages).toHaveLength(1);
    expect(recovered.messages[0]).toMatchObject({ type: "snapshot", version: 1 });
    hub.close();
    stream.close();
  });

  test("clears queued projection replacements before terminal unavailability", async () => {
    let currentProjection = publishedEvent;
    let releaseBlockedSend: () => void = () => {
      throw new Error("slow send was not blocked");
    };
    let blockedSendResolver: (() => void) | null = null;
    let sendCount = 0;
    const messages: unknown[] = [];
    const blockedSend = new Promise<void>((resolve) => {
      blockedSendResolver = resolve;
    });
    const stream = createPublicAudienceEventStream(
      {
        read: async () => ({ status: "accepted" as const, value: currentProjection }),
      },
      { refreshIntervalMs: 60_000 },
    );
    const hub = createPublicAudienceEventWebSocketHub({ stream, controllerCapacity: capacity() });
    const socket = {
      async send(serialized: string) {
        sendCount += 1;
        if (sendCount === 2) {
          blockedSendResolver?.();
          await new Promise<void>((release) => {
            releaseBlockedSend = release;
          });
        }
        const message = JSON.parse(serialized) as { type?: string };
        messages.push(message);
        if (message.type === "event-unavailable") terminalResolver?.();
        return true;
      },
      close() {},
    };
    let terminalResolver: (() => void) | null = null;
    const terminalReady = new Promise<void>((resolve) => {
      terminalResolver = resolve;
    });
    const admitted = await hub.subscribe("slow-client", "event-1", socket);
    expect(admitted.status).toBe("admitted");
    currentProjection = { ...publishedEvent, name: "Projection v2" };
    expect(await stream.republish("event-1")).toBe("accepted");
    await blockedSend;
    currentProjection = { ...publishedEvent, name: "Projection v3" };
    expect(await stream.republish("event-1")).toBe("accepted");
    await stream.unpublish("event-1");
    releaseBlockedSend();
    await terminalReady;
    expect(messages.at(-1)).toMatchObject({ type: "event-unavailable" });
    expect(messages).not.toContainEqual(
      expect.objectContaining({ projection: { name: "Projection v3" } }),
    );
    hub.close();
    stream.close();
  });
});
