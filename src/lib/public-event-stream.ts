/**
 * The public Event stream deliberately knows nothing about the shape of an
 * Audience Projection.  That keeps the transport stable while the projection
 * is assembled by the Event and Game work.
 */
export const PUBLIC_EVENT_STREAM_PROTOCOL = "public-event-stream-v1" as const;

export type PublicAudienceProjectionSnapshot<TProjection> = {
  eventId: string;
  version: number;
  projection: TProjection;
};

export type PublicAudienceProjectionMessage<TProjection> =
  | {
      protocol: typeof PUBLIC_EVENT_STREAM_PROTOCOL;
      type: "snapshot";
      eventId: string;
      version: number;
      projection: TProjection;
    }
  | {
      protocol: typeof PUBLIC_EVENT_STREAM_PROTOCOL;
      type: "projection-replaced";
      eventId: string;
      version: number;
      projection: TProjection;
    }
  | {
      protocol: typeof PUBLIC_EVENT_STREAM_PROTOCOL;
      type: "event-unavailable";
      eventId: string;
    };

export function serializePublicAudienceProjectionMessage<TProjection>(
  message: PublicAudienceProjectionMessage<TProjection>,
): string {
  return JSON.stringify(message);
}

export type PublicAudienceProjectionReadOutcome<TProjection> =
  | { status: "accepted"; snapshot: PublicAudienceProjectionSnapshot<TProjection> }
  | { status: "unavailable" }
  | { status: "retryable-failure" };

export type PublicAudienceProjectionProvider<TProjection> = {
  read(eventId: string): Promise<PublicAudienceProjectionReadOutcome<TProjection>>;
};

export type PublicAudienceProjectionSubscriber<TProjection> = {
  send(message: PublicAudienceProjectionMessage<TProjection>): void | Promise<void>;
  close(code: number, reason: string): void;
};

export type PublicAudienceProjectionMutation =
  | { status: "accepted" }
  | { status: "duplicate" }
  | { status: "out-of-order" }
  | { status: "unavailable" };

export type PublicAudienceProjectionSubscription = {
  unsubscribe(): void;
};

export type PublicAudienceProjectionStream<TProjection> = {
  subscribe(
    eventId: string,
    subscriber: PublicAudienceProjectionSubscriber<TProjection>,
  ): Promise<
    | { status: "accepted"; subscription: PublicAudienceProjectionSubscription }
    | { status: "unavailable" }
  >;
  replaceProjection(
    eventId: string,
    update: { version: number; projection: TProjection },
  ): PublicAudienceProjectionMutation;
  terminateSubscribers(eventId: string): void;
  unpublish(eventId: string): Promise<void>;
  republish(eventId: string): Promise<"accepted" | "unavailable">;
  subscriberCount(eventId?: string): number;
};

type QueuedMessage<TProjection> = {
  message: PublicAudienceProjectionMessage<TProjection>;
  replaceable: boolean;
  terminal: boolean;
};

type SubscriberState<TProjection> = {
  subscriber: PublicAudienceProjectionSubscriber<TProjection>;
  queue: QueuedMessage<TProjection>[];
  draining: boolean;
  closed: boolean;
};

type EventState<TProjection> = {
  snapshot: PublicAudienceProjectionSnapshot<TProjection>;
  subscribers: Set<SubscriberState<TProjection>>;
};

export function createPublicEventStream<TProjection>(
  provider: PublicAudienceProjectionProvider<TProjection>,
): PublicAudienceProjectionStream<TProjection> {
  const events = new Map<string, EventState<TProjection>>();
  const unpublishedEventIds = new Set<string>();
  const publicationGenerations = new Map<string, number>();

  const hydrate = async (eventId: string): Promise<EventState<TProjection> | null> => {
    if (unpublishedEventIds.has(eventId)) return null;
    const generation = currentGeneration(eventId);
    return readAndReplaceEventState(
      eventId,
      () => !unpublishedEventIds.has(eventId) && currentGeneration(eventId) === generation,
    );
  };

  const stream: PublicAudienceProjectionStream<TProjection> = {
    async subscribe(eventId, subscriber) {
      if (!isEventId(eventId)) return { status: "unavailable" };
      const state = await hydrate(eventId);
      if (state === null) return { status: "unavailable" };
      const subscriberState: SubscriberState<TProjection> = {
        subscriber,
        queue: [],
        draining: false,
        closed: false,
      };
      state.subscribers.add(subscriberState);
      enqueue(subscriberState, snapshotMessage(state.snapshot), true, false);
      return {
        status: "accepted",
        subscription: {
          unsubscribe() {
            removeSubscriber(state, subscriberState);
          },
        },
      };
    },

    replaceProjection(eventId, update) {
      if (!isValidVersion(update.version) || !isEventId(eventId)) return { status: "unavailable" };
      const state = events.get(eventId);
      if (state === undefined || unpublishedEventIds.has(eventId)) return { status: "unavailable" };
      if (update.version === state.snapshot.version) return { status: "duplicate" };
      if (update.version < state.snapshot.version) return { status: "out-of-order" };
      state.snapshot = {
        ...state.snapshot,
        version: update.version,
        projection: update.projection,
      };
      broadcast(
        state,
        {
          protocol: PUBLIC_EVENT_STREAM_PROTOCOL,
          type: "projection-replaced",
          eventId,
          version: update.version,
          projection: update.projection,
        },
        true,
      );
      return { status: "accepted" };
    },

    terminateSubscribers(eventId) {
      terminateEvent(eventId, false);
    },

    async unpublish(eventId) {
      if (!isEventId(eventId)) return;
      terminateEvent(eventId, true);
    },

    async republish(eventId) {
      if (!isEventId(eventId)) return "unavailable";
      const generation = currentGeneration(eventId);
      const prior = events.get(eventId);
      const nextState = await readAndReplaceEventState(
        eventId,
        () => currentGeneration(eventId) === generation,
      );
      if (nextState === null) return "unavailable";
      unpublishedEventIds.delete(eventId);
      if (prior !== undefined) broadcast(nextState, snapshotMessage(nextState.snapshot), true);
      return "accepted";
    },

    subscriberCount(eventId) {
      if (eventId === undefined) {
        return [...events.values()].reduce((total, state) => total + state.subscribers.size, 0);
      }
      return events.get(eventId)?.subscribers.size ?? 0;
    },
  };

  return stream;

  function currentGeneration(eventId: string) {
    return publicationGenerations.get(eventId) ?? 0;
  }

  async function readAndReplaceEventState(
    eventId: string,
    isStillEligible: () => boolean,
  ): Promise<EventState<TProjection> | null> {
    const result = await provider.read(eventId);
    if (result.status !== "accepted") return null;
    if (result.snapshot.eventId !== eventId || !isStillEligible()) return null;
    const snapshot = result.snapshot;
    const existing = events.get(eventId);
    if (existing !== undefined && snapshot.version < existing.snapshot.version) return null;
    const nextState: EventState<TProjection> = {
      snapshot,
      subscribers: existing?.subscribers ?? new Set(),
    };
    events.set(eventId, nextState);
    return nextState;
  }

  function terminateEvent(eventId: string, permanentlyUnavailable: boolean) {
    if (permanentlyUnavailable) unpublishedEventIds.add(eventId);
    publicationGenerations.set(eventId, currentGeneration(eventId) + 1);
    const state = events.get(eventId);
    if (state === undefined) return;
    events.delete(eventId);
    for (const subscriber of state.subscribers) {
      subscriber.queue.length = 0;
      enqueue(
        subscriber,
        { protocol: PUBLIC_EVENT_STREAM_PROTOCOL, type: "event-unavailable", eventId },
        false,
        true,
      );
    }
  }

  function removeSubscriber(
    state: EventState<TProjection>,
    subscriber: SubscriberState<TProjection>,
  ) {
    subscriber.closed = true;
    state.subscribers.delete(subscriber);
  }

  function broadcast(
    state: EventState<TProjection>,
    message: PublicAudienceProjectionMessage<TProjection>,
    replaceable: boolean,
  ) {
    for (const subscriber of state.subscribers) enqueue(subscriber, message, replaceable, false);
  }

  function enqueue(
    subscriber: SubscriberState<TProjection>,
    message: PublicAudienceProjectionMessage<TProjection>,
    replaceable: boolean,
    terminal: boolean,
  ) {
    if (subscriber.closed) return;
    if (replaceable) {
      const lastNonReplaceable = subscriber.queue.findLastIndex((item) => !item.replaceable);
      const queued = subscriber.queue
        .slice(lastNonReplaceable + 1)
        .findLast((item) => item.replaceable);
      if (queued !== undefined) {
        queued.message = message;
        return;
      }
    }
    subscriber.queue.push({ message, replaceable, terminal });
    void drain(subscriber);
  }

  async function drain(subscriber: SubscriberState<TProjection>) {
    if (subscriber.draining || subscriber.closed) return;
    subscriber.draining = true;
    try {
      while (!subscriber.closed && subscriber.queue.length > 0) {
        const item = subscriber.queue.shift()!;
        try {
          await subscriber.subscriber.send(item.message);
        } catch {
          subscriber.closed = true;
          subscriber.queue.length = 0;
          subscriber.subscriber.close(1011, "Public Event stream unavailable.");
          return;
        }
        if (item.terminal) {
          subscriber.closed = true;
          subscriber.queue.length = 0;
          subscriber.subscriber.close(1008, "Event unavailable.");
          return;
        }
      }
    } finally {
      subscriber.draining = false;
    }
  }
}

export type PublicAudienceProjectionReplica<TProjection> = {
  eventId: string;
  version: number;
  projection: TProjection | null;
  unavailable: boolean;
};

export type PublicAudienceProjectionApplyResult =
  | { status: "applied" }
  | { status: "duplicate" }
  | { status: "out-of-order" }
  | { status: "unavailable" };

export function createPublicEventStreamReplica<TProjection>(
  eventId: string,
): PublicAudienceProjectionReplica<TProjection> {
  return { eventId, version: -1, projection: null, unavailable: false };
}

export function applyPublicEventStreamMessage<TProjection>(
  replica: PublicAudienceProjectionReplica<TProjection>,
  message: PublicAudienceProjectionMessage<TProjection>,
): PublicAudienceProjectionApplyResult {
  if (message.protocol !== PUBLIC_EVENT_STREAM_PROTOCOL || message.eventId !== replica.eventId)
    return { status: "unavailable" };
  if (message.type === "event-unavailable") {
    replica.unavailable = true;
    replica.projection = null;
    return { status: "unavailable" };
  }
  if (replica.unavailable) return { status: "unavailable" };
  if (message.type === "snapshot") {
    if (message.version === replica.version) return { status: "duplicate" };
    if (message.version < replica.version) return { status: "out-of-order" };
    replica.version = message.version;
    replica.projection = message.projection;
    return { status: "applied" };
  }
  if (message.version === replica.version) return { status: "duplicate" };
  if (message.version < replica.version) return { status: "out-of-order" };
  if (message.type === "projection-replaced") {
    replica.version = message.version;
    replica.projection = message.projection;
    return { status: "applied" };
  }
  return { status: "unavailable" };
}

function snapshotMessage<TProjection>(
  snapshot: PublicAudienceProjectionSnapshot<TProjection>,
): PublicAudienceProjectionMessage<TProjection> {
  return {
    protocol: PUBLIC_EVENT_STREAM_PROTOCOL,
    type: "snapshot",
    eventId: snapshot.eventId,
    version: snapshot.version,
    projection: snapshot.projection,
  };
}

function isEventId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
