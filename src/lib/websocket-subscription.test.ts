import { describe, expect, test } from "bun:test";
import {
  canBeginWebSocketSubscription,
  queueWebSocketSubscription,
  type SessionSubscription,
  type WebSocketSubscriptionQueue,
} from "./websocket-subscription";

describe("WebSocket protocol subscription", () => {
  test("allows a new protocol subscription only from the empty state", () => {
    expect(canBeginWebSocketSubscription({ type: "none" })).toBe(true);
    expect(canBeginWebSocketSubscription({ type: "lobby" })).toBe(false);
    expect(
      canBeginWebSocketSubscription({
        type: "game",
        gameId: "adhoc-existing",
        sessionId: "existing-session",
      }),
    ).toBe(false);
    expect(canBeginWebSocketSubscription({ type: "public-event", eventId: "event-existing" })).toBe(
      false,
    );
  });

  test("rejects an Ad Hoc Game subscription after a public Audience Projection subscription before side effects", async () => {
    const queue: WebSocketSubscriptionQueue = {
      subscription: { type: "public-event", eventId: "event-existing" },
      subscriptionWork: Promise.resolve(),
    };
    const errors: string[] = [];
    let resolverCalls = 0;
    let trackingCalls = 0;
    let connectionCalls = 0;
    let snapshots = 0;

    const result = await queueWebSocketSubscription(queue, {
      alreadySubscribed(message) {
        errors.push(message);
      },
      async subscribe() {
        resolverCalls += 1;
        trackingCalls += 1;
        connectionCalls += 1;
        snapshots += 1;
        queue.subscription = {
          type: "game",
          gameId: "adhoc-attempted",
          sessionId: "attempted-session",
        };
      },
    });

    expect(result).toBe("already-subscribed");
    expect(errors).toEqual(["WebSocket is already subscribed."]);
    expect(queue.subscription).toEqual({ type: "public-event", eventId: "event-existing" });
    expect({ resolverCalls, trackingCalls, connectionCalls, snapshots }).toEqual({
      resolverCalls: 0,
      trackingCalls: 0,
      connectionCalls: 0,
      snapshots: 0,
    });
  });

  test("rejects a public Audience Projection subscription after an Ad Hoc Game subscription", async () => {
    const queue: WebSocketSubscriptionQueue = {
      subscription: {
        type: "game",
        gameId: "adhoc-existing",
        sessionId: "existing-session",
      },
      subscriptionWork: Promise.resolve(),
    };
    let publicCapacityCalls = 0;

    expect(
      await queueWebSocketSubscription(queue, {
        alreadySubscribed() {},
        async subscribe() {
          publicCapacityCalls += 1;
        },
      }),
    ).toBe("already-subscribed");
    expect(publicCapacityCalls).toBe(0);
  });

  test("rejects a second subscription to the same protocol without subscription work", async () => {
    const subscriptions: SessionSubscription[] = [
      { type: "public-event", eventId: "event-existing" },
      {
        type: "game",
        gameId: "adhoc-existing",
        sessionId: "existing-session",
      },
    ];

    for (const subscription of subscriptions) {
      const queue: WebSocketSubscriptionQueue = {
        subscription,
        subscriptionWork: Promise.resolve(),
      };
      let sideEffects = 0;
      expect(
        await queueWebSocketSubscription(queue, {
          alreadySubscribed() {},
          async subscribe() {
            sideEffects += 1;
          },
        }),
      ).toBe("already-subscribed");
      expect(sideEffects).toBe(0);
      expect(queue.subscription).toEqual(subscription);
    }
  });

  test("queued handler ordering admits only the first subscription in either protocol order", async () => {
    const orders: Array<[SessionSubscription, SessionSubscription]> = [
      [
        { type: "public-event", eventId: "event-first" },
        {
          type: "game",
          gameId: "adhoc-second",
          sessionId: "second-session",
        },
      ],
      [
        {
          type: "game",
          gameId: "adhoc-first",
          sessionId: "first-session",
        },
        { type: "public-event", eventId: "event-second" },
      ],
    ];

    for (const [firstSubscription, secondSubscription] of orders) {
      const queue: WebSocketSubscriptionQueue = {
        subscription: { type: "none" },
        subscriptionWork: Promise.resolve(),
      };
      const sideEffects: string[] = [];
      const first = queueWebSocketSubscription(queue, {
        alreadySubscribed() {},
        async subscribe() {
          await Promise.resolve();
          sideEffects.push("first-capacity");
          queue.subscription = firstSubscription;
        },
      });
      const second = queueWebSocketSubscription(queue, {
        alreadySubscribed() {},
        async subscribe() {
          sideEffects.push("second-capacity");
          queue.subscription = secondSubscription;
        },
      });

      expect(await Promise.all([first, second])).toEqual(["started", "already-subscribed"]);
      expect(sideEffects).toEqual(["first-capacity"]);
      expect(queue.subscription).toEqual(firstSubscription);
    }
  });
});
