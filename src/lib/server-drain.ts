/** Tracks JavaScript work separately from Bun's connection lifetime. */
export function createServerWorkTracker() {
  const pending = new Set<Promise<unknown>>();
  const listeners = new Set<() => void>();
  return {
    track<T>(work: Promise<T>): Promise<T> {
      pending.add(work);
      const settled = () => {
        pending.delete(work);
        if (pending.size === 0) {
          for (const resolve of listeners) resolve();
          listeners.clear();
        }
      };
      void work.then(settled, settled);
      return work;
    },
    async idle(): Promise<void> {
      while (pending.size > 0) await new Promise<void>((resolve) => listeners.add(resolve));
    },
    count: () => pending.size,
  };
}

export type ServerDrainResult = { outcome: "graceful" | "forced" | "failed"; errors: unknown[] };

export function createServerDrain(input: {
  work: ReturnType<typeof createServerWorkTracker>;
  stopAdmission(): void;
  stopBackground(): void;
  closeSockets(): void;
  stopServer(force: boolean): Promise<void>;
  closeStorage(): void;
  terminate(): void;
  report(result: ServerDrainResult): void;
  gracefulMs?: number;
  forcedMs?: number;
  schedule?: (callback: () => void, ms: number) => () => void;
}) {
  let completion: Promise<ServerDrainResult> | undefined;
  const schedule =
    input.schedule ??
    ((callback, ms) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    });
  const bounded = async (work: Promise<unknown>, ms: number) => {
    let cancel = () => {};
    const deadline = new Promise<"deadline">((resolve) => {
      cancel = schedule(() => resolve("deadline"), ms);
    });
    try {
      return await Promise.race([work.then(() => "settled" as const), deadline]);
    } finally {
      cancel();
    }
  };
  const run = async (): Promise<ServerDrainResult> => {
    const errors: unknown[] = [];
    const attempt = (operation: () => void) => {
      try {
        operation();
      } catch (error) {
        errors.push(error);
      }
    };
    attempt(() => input.stopAdmission());
    attempt(() => input.stopBackground());
    attempt(() => input.closeSockets());
    const quiesced = errors.length === 0;
    let forced = !quiesced;
    try {
      const stopped = Promise.resolve().then(() => input.stopServer(false));
      forced =
        (await bounded(
          stopped.then(() => input.work.idle()),
          input.gracefulMs ?? 8_000,
        )) === "deadline" || forced;
    } catch (error) {
      errors.push(error);
      forced = true;
    }
    if (forced) {
      try {
        const stopped = Promise.resolve().then(() => input.stopServer(true));
        if (
          (await bounded(
            stopped.then(() => input.work.idle()),
            input.forcedMs ?? 1_000,
          )) === "deadline"
        ) {
          throw new Error("Server drain deadline exceeded with live connections or owned work.");
        }
      } catch (error) {
        errors.push(error);
        const result: ServerDrainResult = { outcome: "failed", errors };
        input.report(result);
        // Closing a socket does not cancel its async storage continuation. Only
        // terminating the process safely ends such work without a false ack.
        input.terminate();
        return result;
      }
    }
    // If a producer could not be stopped, future work may still arrive.
    if (quiesced) attempt(() => input.closeStorage());
    const result: ServerDrainResult = {
      outcome: errors.length > 0 ? "failed" : forced ? "forced" : "graceful",
      errors,
    };
    input.report(result);
    if (errors.length > 0) input.terminate();
    return result;
  };
  return {
    stop(): Promise<ServerDrainResult> {
      // Install the shared promise before running callbacks (including reentrant signals).
      if (completion === undefined) {
        const deferred = Promise.withResolvers<ServerDrainResult>();
        completion = deferred.promise;
        void run().then(deferred.resolve, deferred.reject);
      }
      return completion;
    },
  };
}

/** Keep static HTML bundles intact; gate and own every dynamic route method. */
export function drainServerRoutes<T extends Record<string, unknown>>(
  routes: T,
  input: { accepting(): boolean; work: ReturnType<typeof createServerWorkTracker> },
): T {
  const wrap =
    (handler: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      if (!input.accepting())
        return new Response("Server shutting down.", {
          status: 503,
          headers: { "retry-after": "1" },
        });
      // Calling synchronously preserves admission ordering with shutdown.
      const result = handler(...args);
      return result instanceof Promise ? input.work.track(result) : result;
    };
  return Object.fromEntries(
    Object.entries(routes).map(([path, route]) => {
      if (typeof route === "function")
        return [path, wrap(route as (...args: unknown[]) => unknown)];
      if (route !== null && typeof route === "object") {
        const methods = Object.entries(route);
        if (
          methods.some(
            ([method, handler]) =>
              /^(GET|HEAD|POST|PUT|DELETE|PATCH|OPTIONS)$/.test(method) &&
              typeof handler === "function",
          )
        ) {
          return [
            path,
            Object.fromEntries(
              methods.map(([method, handler]) => [
                method,
                typeof handler === "function"
                  ? wrap(handler as (...args: unknown[]) => unknown)
                  : handler,
              ]),
            ),
          ];
        }
      }
      return [path, route];
    }),
  ) as T;
}
