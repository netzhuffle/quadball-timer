import type { ServerMonitoring } from "@/lib/monitoring-server";
import type { createServerWorkTracker } from "@/lib/server-drain";

/** One per-connection boundary for Bun callbacks and asynchronous message dispatch. */
export function createWebSocketFailureBoundary<
  Socket extends { close(code: number, reason: string): unknown },
>(input: {
  work: Pick<ReturnType<typeof createServerWorkTracker>, "track">;
  accepting(): boolean;
  closed(socket: Socket): boolean;
  monitoring: Pick<ServerMonitoring, "captureException">;
  disconnect(socket: Socket): void;
}) {
  const failed = new WeakSet<Socket>();
  function fail(error: unknown, socket: Socket): void {
    if (failed.has(socket) || input.closed(socket)) return;
    failed.add(socket);
    try {
      input.monitoring.captureException(error, { category: "server", component: "websocket" });
    } catch {
      // Reporting must not prevent connection cleanup.
    }
    try {
      input.disconnect(socket);
    } catch {
      // The disconnect owner retains ownership of durable bookkeeping.
    }
    try {
      socket.close(1011, "Internal server error.");
    } catch {
      // A failed transport can already be unavailable.
    }
  }
  return {
    fail,
    async dispatch<T>(socket: Socket, operation: () => T | Promise<T>): Promise<T | undefined> {
      if (!input.accepting() || input.closed(socket) || failed.has(socket)) return;
      try {
        return await input.work.track(Promise.resolve(operation()));
      } catch (error) {
        fail(error, socket);
      }
    },
  };
}
