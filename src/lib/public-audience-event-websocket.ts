import {
  createSpectatorCapacity,
  type SpectatorCapacity,
  type SpectatorDisconnectReason,
  type SpectatorQueuedUpdate,
} from "@/lib/spectator-capacity";
import type { ControllerCapacitySignal } from "@/lib/controller-capacity";
import type { PublicAudienceEventProjection } from "@/lib/audience-projection";
import {
  PUBLIC_EVENT_STREAM_PROTOCOL,
  serializePublicAudienceProjectionMessage,
  type PublicAudienceProjectionMessage,
  type PublicAudienceProjectionStream,
} from "@/lib/public-event-stream";
import { utf8ByteLength } from "@/lib/validation-policy";

type PublicAudienceMessage = PublicAudienceProjectionMessage<PublicAudienceEventProjection>;

export type PublicAudienceEventSocket = {
  send(serialized: string): boolean | Promise<boolean>;
  close(code: number, reason: string): void;
};

export type PublicAudienceEventWebSocketSubscriptionResult =
  | { status: "admitted"; currentVersion: string; currentVersionWasAlreadyKnown: boolean }
  | {
      status: "rejected";
      reason: "capacity" | "output-limit";
      message: string;
    }
  | { status: "unavailable"; message: string };

export type PublicAudienceEventWebSocketHub = {
  subscribe(
    clientId: string,
    eventId: string,
    socket: PublicAudienceEventSocket,
    lastSeenVersion?: string,
  ): Promise<PublicAudienceEventWebSocketSubscriptionResult>;
  disconnect(clientId: string, reason?: SpectatorDisconnectReason): void;
  reconcileControllerCapacity(): ReturnType<
    SpectatorCapacity<PublicAudienceMessage>["reconcileControllerCapacity"]
  >;
  close(): void;
};

type Feed = {
  eventId: string;
  current: { version: string; payload: PublicAudienceMessage } | null;
  subscription: { unsubscribe(): void } | null;
  ready: Promise<boolean>;
  resolveReady: (available: boolean) => void;
};

type Client = {
  eventId: string;
  socket: PublicAudienceEventSocket;
};

const CAPACITY_UNAVAILABLE = "Spectator experience is currently unavailable.";

/**
 * Owns the public transport seam: one authoritative stream subscription per
 * Event, then the #138 capacity queues fan out the exact serialized envelope
 * to admitted sockets.
 */
export function createPublicAudienceEventWebSocketHub(options: {
  stream: Pick<PublicAudienceProjectionStream<PublicAudienceEventProjection>, "subscribe">;
  controllerCapacity: ControllerCapacitySignal;
  maxSpectators?: number;
}): PublicAudienceEventWebSocketHub {
  const feeds = new Map<string, Feed>();
  const clients = new Map<string, Client>();
  const drains = new Map<string, Promise<void>>();
  let closed = false;

  const capacity = createSpectatorCapacity<PublicAudienceMessage>({
    controllerCapacity: options.controllerCapacity,
    maxSpectators: options.maxSpectators,
    adapter: {
      async readCurrentVersion({ eventId }) {
        const feed = feeds.get(eventId);
        if (feed?.current === null || feed?.current === undefined) {
          return { status: "unavailable" };
        }
        return { status: "available", current: feed.current };
      },
      serializeQueuedOutput(update) {
        const serialized = serializePublicAudienceProjectionMessage(update.payload);
        return { serialized, bytes: utf8ByteLength(serialized) };
      },
      async write(clientId, _update, serialized) {
        const client = clients.get(clientId);
        if (client === undefined || serialized === undefined) return false;
        return await client.socket.send(serialized);
      },
      close(clientId, reason) {
        const client = clients.get(clientId);
        if (client === undefined) return;
        clients.delete(clientId);
        client.socket.close(closeCode(reason), closeReason(reason));
        void disposeFeedIfUnused(client.eventId);
      },
    },
  });

  return {
    async subscribe(clientId, eventId, socket, lastSeenVersion) {
      if (closed || clients.has(clientId)) {
        return { status: "unavailable", message: CAPACITY_UNAVAILABLE };
      }
      const feed = await ensureFeed(eventId);
      if (feed === null || feed.current === null) {
        return { status: "unavailable", message: CAPACITY_UNAVAILABLE };
      }
      clients.set(clientId, { eventId, socket });
      const result = await capacity.admit({ clientId, eventId, lastSeenVersion });
      if (result.status !== "admitted") {
        clients.delete(clientId);
        await disposeFeedIfUnused(eventId);
        return result;
      }
      await drainClient(clientId);
      if (!clients.has(clientId)) {
        return {
          status: "rejected",
          reason: "output-limit",
          message: "Spectator output is currently unavailable.",
        };
      }
      return result;
    },
    disconnect(clientId, reason = "client-closed") {
      const client = clients.get(clientId);
      clients.delete(clientId);
      capacity.disconnect(clientId, reason);
      if (client !== undefined) void disposeFeedIfUnused(client.eventId);
    },
    reconcileControllerCapacity() {
      return capacity.reconcileControllerCapacity();
    },
    close() {
      if (closed) return;
      closed = true;
      for (const clientId of clients.keys()) this.disconnect(clientId, "client-closed");
      for (const feed of feeds.values()) feed.subscription?.unsubscribe();
      feeds.clear();
    },
  };

  async function ensureFeed(eventId: string): Promise<Feed | null> {
    const existing = feeds.get(eventId);
    if (existing !== undefined) {
      return (await existing.ready) && existing.current !== null ? existing : null;
    }
    let resolveReady: (available: boolean) => void = () => {};
    const ready = new Promise<boolean>((resolve) => {
      resolveReady = resolve;
    });
    const feed: Feed = {
      eventId,
      current: null,
      subscription: null,
      ready,
      resolveReady,
    };
    feeds.set(eventId, feed);
    const result = await options.stream.subscribe(eventId, {
      send: async (message) => {
        if (message.protocol !== PUBLIC_EVENT_STREAM_PROTOCOL) return;
        if (message.type === "event-unavailable") {
          feed.current = null;
          feed.resolveReady(false);
          await deliverTerminal(feed);
          return;
        }
        const version = String(message.version);
        const deliveryMessage: PublicAudienceMessage =
          message.type === "snapshot" && feed.current !== null
            ? {
                protocol: PUBLIC_EVENT_STREAM_PROTOCOL,
                type: "projection-replaced",
                eventId: message.eventId,
                version: message.version,
                projection: message.projection,
              }
            : message;
        feed.current = { version, payload: deliveryMessage };
        feed.resolveReady(true);
        if (message.type !== "snapshot" || deliveryMessage.type === "projection-replaced") {
          await deliver(feed, {
            eventId,
            version,
            payload: deliveryMessage,
            replaceableKey: deliveryMessage.type === "projection-replaced" ? "projection" : null,
          });
        }
      },
      close() {},
    });
    if (result.status !== "accepted") {
      feed.resolveReady(false);
      feeds.delete(eventId);
      return null;
    }
    feed.subscription = result.subscription;
    if (!(await feed.ready) || feed.current === null) {
      feed.subscription.unsubscribe();
      feeds.delete(eventId);
      return null;
    }
    return feed;
  }

  async function deliver(feed: Feed, update: SpectatorQueuedUpdate<PublicAudienceMessage>) {
    capacity.publish(update);
    await Promise.all(
      [...clients.entries()]
        .filter(([, client]) => client.eventId === feed.eventId)
        .map(([clientId]) => drainClient(clientId)),
    );
  }

  async function deliverTerminal(feed: Feed) {
    const update: SpectatorQueuedUpdate<PublicAudienceMessage> = {
      eventId: feed.eventId,
      version: "terminal",
      payload: {
        protocol: PUBLIC_EVENT_STREAM_PROTOCOL,
        type: "event-unavailable",
        eventId: feed.eventId,
      },
      replaceableKey: null,
    };
    capacity.clearQueuedUpdates(feed.eventId);
    capacity.publish(update);
    const clientIds = [...clients.entries()]
      .filter(([, client]) => client.eventId === feed.eventId)
      .map(([clientId]) => clientId);
    await Promise.all(clientIds.map((clientId) => drainClient(clientId)));
    for (const clientId of clientIds) capacity.disconnect(clientId, "client-closed");
    feed.subscription?.unsubscribe();
    feeds.delete(feed.eventId);
  }

  async function drainClient(clientId: string) {
    const prior = drains.get(clientId) ?? Promise.resolve();
    const next = prior.then(async () => {
      await capacity.drain(clientId);
    });
    drains.set(clientId, next);
    try {
      await next;
    } finally {
      if (drains.get(clientId) === next) drains.delete(clientId);
    }
  }

  async function disposeFeedIfUnused(eventId: string) {
    if ([...clients.values()].some((client) => client.eventId === eventId)) return;
    const feed = feeds.get(eventId);
    if (feed === undefined) return;
    feed.subscription?.unsubscribe();
    feeds.delete(eventId);
  }
}

function closeCode(reason: SpectatorDisconnectReason): number {
  return reason === "client-closed" || reason === "client-reconnect" ? 1000 : 1013;
}

function closeReason(reason: SpectatorDisconnectReason): string {
  return reason === "controller-priority"
    ? "Controller capacity priority."
    : reason === "slow-reader"
      ? "Public Event stream backpressure."
      : reason === "client-reconnect"
        ? "Public Event stream reconnecting."
        : "Public Event stream closed.";
}
