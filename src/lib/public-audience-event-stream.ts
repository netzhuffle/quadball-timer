import type {
  AudienceProjectionReader,
  PublicAudienceEventProjection,
} from "@/lib/audience-projection";
import { canonicalizeJson } from "@/lib/event-game-action-json";
import {
  createPublicEventStream,
  type PublicAudienceProjectionProvider,
  type PublicAudienceProjectionStream,
} from "@/lib/public-event-stream";

export type PublicAudienceEventStream =
  PublicAudienceProjectionStream<PublicAudienceEventProjection> & { close(): void };

/**
 * The adapter owns a process-local monotonic revision for the authoritative
 * Audience Projection it has read. The complete public Timeline is assembled
 * by the Audience Projection boundary from the catalog and live Game inputs.
 */
export function createPublicAudienceEventStream(
  projection: Pick<AudienceProjectionReader, "read">,
  options: { refreshIntervalMs?: number } = {},
): PublicAudienceEventStream {
  const revisions = new Map<string, { fingerprint: string; version: number }>();
  const provider: PublicAudienceProjectionProvider<PublicAudienceEventProjection> = {
    async read(eventId) {
      const result = await projection.read(eventId);
      if (result.status === "retryable-failure") return { status: "retryable-failure" };
      if (result.status !== "accepted") return { status: "unavailable" };
      const fingerprint = canonicalizeJson(result.value);
      const previous = revisions.get(eventId);
      const version =
        previous === undefined
          ? 1
          : previous.fingerprint === fingerprint
            ? previous.version
            : previous.version + 1;
      revisions.set(eventId, { fingerprint, version });
      return {
        status: "accepted",
        snapshot: {
          eventId: result.value.eventId,
          version,
          projection: result.value,
        },
      };
    },
  };
  const stream = createPublicEventStream(provider);
  const subscribedEventIds = new Set<string>();
  const lifecycleGenerations = new Map<string, number>();
  const refreshStates = new Map<string, { inFlight: boolean; pending: boolean }>();
  let closed = false;
  const refreshIntervalMs = options.refreshIntervalMs ?? 250;
  const refreshTimer = setInterval(() => {
    for (const eventId of subscribedEventIds) {
      if (stream.subscriberCount(eventId) === 0) {
        subscribedEventIds.delete(eventId);
        continue;
      }
      requestRefresh(eventId);
    }
  }, refreshIntervalMs);

  return {
    ...stream,
    async subscribe(eventId, subscriber) {
      if (closed) return { status: "unavailable" };
      const startsLifecycle = stream.subscriberCount(eventId) === 0;
      const result = await stream.subscribe(eventId, subscriber);
      if (result.status === "accepted") {
        if (startsLifecycle) invalidateLifecycle(eventId);
        subscribedEventIds.add(eventId);
        const unsubscribe = result.subscription.unsubscribe.bind(result.subscription);
        result.subscription.unsubscribe = () => {
          unsubscribe();
          if (stream.subscriberCount(eventId) === 0) {
            subscribedEventIds.delete(eventId);
            invalidateLifecycle(eventId);
          }
        };
      }
      return result;
    },
    terminateSubscribers(eventId) {
      terminateCurrentSubscribers(eventId);
    },
    async unpublish(eventId) {
      invalidateLifecycle(eventId);
      subscribedEventIds.delete(eventId);
      await stream.unpublish(eventId);
    },
    async republish(eventId) {
      invalidateLifecycle(eventId);
      return await stream.republish(eventId);
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(refreshTimer);
      for (const eventId of subscribedEventIds) {
        invalidateLifecycle(eventId);
        void stream.unpublish(eventId);
      }
      subscribedEventIds.clear();
    },
  };

  function requestRefresh(eventId: string) {
    const state = refreshStates.get(eventId) ?? { inFlight: false, pending: false };
    refreshStates.set(eventId, state);
    if (state.inFlight) {
      state.pending = true;
      return;
    }
    void runRefresh(eventId, state);
  }

  async function runRefresh(eventId: string, state: { inFlight: boolean; pending: boolean }) {
    state.inFlight = true;
    state.pending = false;
    const lifecycleGeneration = currentLifecycleGeneration(eventId);
    try {
      const result = await provider
        .read(eventId)
        .catch(() => ({ status: "retryable-failure" as const }));
      if (
        lifecycleGeneration !== currentLifecycleGeneration(eventId) ||
        stream.subscriberCount(eventId) === 0
      ) {
        return;
      }
      if (result.status !== "accepted") {
        terminateCurrentSubscribers(eventId);
        return;
      }
      stream.replaceProjection(eventId, {
        version: result.snapshot.version,
        projection: result.snapshot.projection,
      });
    } finally {
      state.inFlight = false;
      if (
        state.pending &&
        !closed &&
        subscribedEventIds.has(eventId) &&
        stream.subscriberCount(eventId) > 0
      ) {
        void runRefresh(eventId, state);
      } else {
        refreshStates.delete(eventId);
      }
    }
  }

  function terminateCurrentSubscribers(eventId: string) {
    invalidateLifecycle(eventId);
    subscribedEventIds.delete(eventId);
    stream.terminateSubscribers(eventId);
  }

  function invalidateLifecycle(eventId: string) {
    lifecycleGenerations.set(eventId, currentLifecycleGeneration(eventId) + 1);
    const state = refreshStates.get(eventId);
    if (state !== undefined) state.pending = false;
  }

  function currentLifecycleGeneration(eventId: string) {
    return lifecycleGenerations.get(eventId) ?? 0;
  }
}
