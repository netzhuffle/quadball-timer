export type SessionSubscription =
  | { type: "none" }
  | { type: "lobby" }
  | { type: "game"; gameId: string; sessionId: string }
  | { type: "public-event"; eventId: string };

export type WebSocketSubscriptionQueue = {
  subscription: SessionSubscription;
  subscriptionWork: Promise<void>;
};

export function canBeginWebSocketSubscription(subscription: SessionSubscription): boolean {
  return subscription.type === "none";
}

export function queueWebSocketSubscription(
  queue: WebSocketSubscriptionQueue,
  operation: {
    isClosed?: () => boolean;
    alreadySubscribed: (message: string) => void;
    subscribe: () => Promise<void>;
  },
): Promise<"started" | "already-subscribed" | "closed"> {
  const handleSubscription = async () => {
    if (operation.isClosed?.()) return "closed" as const;
    if (!canBeginWebSocketSubscription(queue.subscription)) {
      operation.alreadySubscribed("WebSocket is already subscribed.");
      return "already-subscribed" as const;
    }
    await operation.subscribe();
    return "started" as const;
  };
  const queued = queue.subscriptionWork.then(handleSubscription, handleSubscription);
  queue.subscriptionWork = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}
