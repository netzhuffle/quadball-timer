import { describe, expect, test } from "bun:test";
import {
  applyPublicEventStreamMessage,
  createPublicEventStream,
  createPublicEventStreamReplica,
  PUBLIC_EVENT_STREAM_PROTOCOL,
  type PublicAudienceProjectionMessage,
  type PublicAudienceProjectionSubscriber,
} from "@/lib/public-event-stream";

type State = { clock: number; score: number; timeline?: readonly string[] };
function snapshot(version = 1, state: State = { clock: 0, score: 0 }) {
  return { eventId: "event-1", version, projection: state };
}

function subscriberHarness() {
  const messages: PublicAudienceProjectionMessage<State>[] = [];
  let resolveSend: (() => void) | null = null;
  let closed: { code: number; reason: string } | null = null;
  const subscriber: PublicAudienceProjectionSubscriber<State> = {
    async send(message) {
      messages.push(message);
      if (messages.length === 1) await new Promise<void>((resolve) => (resolveSend = resolve));
    },
    close(code, reason) {
      closed = { code, reason };
    },
  };
  return {
    messages,
    subscriber,
    release() {
      resolveSend?.();
      resolveSend = null;
    },
    closed: () => closed,
  };
}

async function settleDelivery() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("Public Event stream", () => {
  test("sends an authoritative snapshot on subscribe and rejects duplicate/out-of-order updates", async () => {
    const stream = createPublicEventStream<State>({
      read: async () => ({ status: "accepted", snapshot: snapshot() }),
    });
    const harness = subscriberHarness();
    const result = await stream.subscribe("event-1", harness.subscriber);
    expect(result.status).toBe("accepted");
    expect(harness.messages[0]).toMatchObject({
      protocol: PUBLIC_EVENT_STREAM_PROTOCOL,
      type: "snapshot",
      version: 1,
      projection: { clock: 0, score: 0 },
    });
    harness.release();

    expect(
      stream.replaceProjection("event-1", { version: 1, projection: { clock: 1, score: 0 } }),
    ).toEqual({
      status: "duplicate",
    });
    expect(
      stream.replaceProjection("event-1", { version: 0, projection: { clock: 1, score: 0 } }),
    ).toEqual({
      status: "out-of-order",
    });
    expect(
      stream.replaceProjection("event-1", { version: 2, projection: { clock: 1, score: 0 } }),
    ).toEqual({
      status: "accepted",
    });
  });

  test("coalesces replaceable projection updates while delivery is blocked", async () => {
    const stream = createPublicEventStream<State>({
      read: async () => ({ status: "accepted", snapshot: snapshot() }),
    });
    const harness = subscriberHarness();
    await stream.subscribe("event-1", harness.subscriber);
    expect(
      stream.replaceProjection("event-1", { version: 2, projection: { clock: 1, score: 0 } }),
    ).toEqual({
      status: "accepted",
    });
    expect(
      stream.replaceProjection("event-1", { version: 4, projection: { clock: 2, score: 0 } }),
    ).toEqual({ status: "accepted" });
    expect(
      stream.replaceProjection("event-1", { version: 5, projection: { clock: 3, score: 0 } }),
    ).toEqual({ status: "accepted" });

    harness.release();
    await settleDelivery();
    expect(harness.messages.map((message) => message.type)).toEqual([
      "snapshot",
      "projection-replaced",
    ]);
    expect(harness.messages[1]).toMatchObject({ version: 5, projection: { clock: 3 } });
    expect(harness.messages[2]).toBeUndefined();
  });

  test("coalesces complete projections without dropping distinct effective Timeline entries", async () => {
    const stream = createPublicEventStream<State>({
      read: async () => ({ status: "accepted", snapshot: snapshot() }),
    });
    const harness = subscriberHarness();
    await stream.subscribe("event-1", harness.subscriber);
    expect(
      stream.replaceProjection("event-1", {
        version: 2,
        projection: { clock: 1, score: 1, timeline: ["goal-1"] },
      }),
    ).toEqual({ status: "accepted" });
    expect(
      stream.replaceProjection("event-1", {
        version: 3,
        projection: { clock: 2, score: 2, timeline: ["goal-1", "goal-2"] },
      }),
    ).toEqual({ status: "accepted" });
    harness.release();
    await settleDelivery();
    expect(harness.messages).toHaveLength(2);
    expect(harness.messages.at(-1)).toMatchObject({
      type: "projection-replaced",
      version: 3,
      projection: { timeline: ["goal-1", "goal-2"] },
    });
  });

  test("unpublication is terminal and a later subscribe cannot recover metadata until republish", async () => {
    let published = true;
    const stream = createPublicEventStream<State>({
      read: async () =>
        published ? { status: "accepted", snapshot: snapshot() } : { status: "unavailable" },
    });
    const harness = subscriberHarness();
    await stream.subscribe("event-1", harness.subscriber);
    expect(
      stream.replaceProjection("event-1", { version: 2, projection: { clock: 1, score: 0 } }),
    ).toEqual({ status: "accepted" });
    published = false;
    await stream.unpublish("event-1");
    harness.release();
    await settleDelivery();
    expect(harness.messages.map((message) => message.type)).toEqual([
      "snapshot",
      "event-unavailable",
    ]);
    expect(harness.messages.at(-1)).toEqual({
      protocol: PUBLIC_EVENT_STREAM_PROTOCOL,
      type: "event-unavailable",
      eventId: "event-1",
    });
    expect(harness.closed()).toEqual({ code: 1008, reason: "Event unavailable." });
    expect(await stream.subscribe("event-1", subscriberHarness().subscriber)).toEqual({
      status: "unavailable",
    });

    published = true;
    expect(await stream.republish("event-1")).toBe("accepted");
    const next = subscriberHarness();
    expect((await stream.subscribe("event-1", next.subscriber)).status).toBe("accepted");
    expect(next.messages[0]).toMatchObject({ type: "snapshot", projection: { clock: 0 } });
  });

  test("an older republish cannot restore a projection after a later unpublication", async () => {
    let releaseRead: (value: {
      status: "accepted";
      snapshot: ReturnType<typeof snapshot>;
    }) => void = (_value) => {
      throw new Error("Republish read was not deferred.");
    };
    let reads = 0;
    const deferredRead = new Promise<{ status: "accepted"; snapshot: ReturnType<typeof snapshot> }>(
      (resolve) => {
        releaseRead = resolve;
      },
    );
    const stream = createPublicEventStream<State>({
      read: async () => {
        reads += 1;
        return reads === 1 ? { status: "accepted", snapshot: snapshot() } : deferredRead;
      },
    });
    const subscriber = subscriberHarness();
    await stream.subscribe("event-1", subscriber.subscriber);
    const republish = stream.republish("event-1");
    await stream.unpublish("event-1");
    releaseRead({ status: "accepted", snapshot: snapshot(2) });

    expect(await republish).toBe("unavailable");
    expect(await stream.subscribe("event-1", subscriberHarness().subscriber)).toEqual({
      status: "unavailable",
    });
  });

  test("rechecks publication eligibility after an in-flight authoritative read", async () => {
    let signalReadStarted: () => void = () => {
      throw new Error("Authoritative read did not start.");
    };
    let releaseRead: (value: {
      status: "accepted";
      snapshot: ReturnType<typeof snapshot>;
    }) => void = (_value) => {
      throw new Error("Authoritative read was not deferred.");
    };
    const readBegan = new Promise<void>((resolve) => (signalReadStarted = resolve));
    const read = new Promise<{ status: "accepted"; snapshot: ReturnType<typeof snapshot> }>(
      (resolve) => {
        releaseRead = (value) => resolve(value);
      },
    );
    const stream = createPublicEventStream<State>({
      read: async () => {
        signalReadStarted();
        return read;
      },
    });
    const harness = subscriberHarness();
    const pending = stream.subscribe("event-1", harness.subscriber);
    await readBegan;
    await stream.unpublish("event-1");
    releaseRead({ status: "accepted", snapshot: snapshot() });

    expect(await pending).toEqual({ status: "unavailable" });
    expect(harness.messages).toEqual([]);
    expect(stream.subscriberCount("event-1")).toBe(0);
  });

  test("a browser replica converges from HTTP snapshot, ignores duplicates and rejects stale data", () => {
    const replica = createPublicEventStreamReplica<State>("event-1");
    const state = { clock: 12, score: 10 };
    const snapshotMessage: PublicAudienceProjectionMessage<State> = {
      protocol: PUBLIC_EVENT_STREAM_PROTOCOL,
      type: "snapshot",
      eventId: "event-1",
      version: 10,
      projection: state,
    };
    expect(applyPublicEventStreamMessage(replica, snapshotMessage)).toEqual({ status: "applied" });
    expect(applyPublicEventStreamMessage(replica, snapshotMessage)).toEqual({
      status: "duplicate",
    });
    expect(
      applyPublicEventStreamMessage(replica, {
        protocol: PUBLIC_EVENT_STREAM_PROTOCOL,
        type: "projection-replaced",
        eventId: "event-1",
        version: 9,
        projection: { clock: 11, score: 10 },
      }),
    ).toEqual({ status: "out-of-order" });
    expect(
      applyPublicEventStreamMessage(replica, {
        protocol: PUBLIC_EVENT_STREAM_PROTOCOL,
        type: "event-unavailable",
        eventId: "event-1",
      }),
    ).toEqual({ status: "unavailable" });
    expect(replica).toMatchObject({ version: 10, projection: null, unavailable: true });
  });

  test("the replica applies projection replacement in version order", () => {
    const replica = createPublicEventStreamReplica<State>("event-1");
    const messages: PublicAudienceProjectionMessage<State>[] = [
      {
        protocol: PUBLIC_EVENT_STREAM_PROTOCOL,
        type: "snapshot",
        eventId: "event-1",
        version: 1,
        projection: { clock: 0, score: 0 },
      },
      {
        protocol: PUBLIC_EVENT_STREAM_PROTOCOL,
        type: "projection-replaced",
        eventId: "event-1",
        version: 2,
        projection: { clock: 1, score: 0 },
      },
      {
        protocol: PUBLIC_EVENT_STREAM_PROTOCOL,
        type: "projection-replaced",
        eventId: "event-1",
        version: 3,
        projection: { clock: 1, score: 1 },
      },
      {
        protocol: PUBLIC_EVENT_STREAM_PROTOCOL,
        type: "projection-replaced",
        eventId: "event-1",
        version: 4,
        projection: { clock: 2, score: 1 },
      },
    ];

    expect(messages.map((message) => applyPublicEventStreamMessage(replica, message))).toEqual([
      { status: "applied" },
      { status: "applied" },
      { status: "applied" },
      { status: "applied" },
    ]);
    expect(replica).toMatchObject({ version: 4, projection: { clock: 2, score: 1 } });
  });
});
