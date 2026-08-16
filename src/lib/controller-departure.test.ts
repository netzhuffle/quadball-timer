import { describe, expect, test } from "bun:test";
import {
  CONTROLLER_LEAVE_GRACE_MS,
  controllerDepartureBlocksGame,
  createControllerDeparture,
  createInMemoryControllerDepartureAdapters,
  type ControllerDepartureReference,
} from "@/lib/controller-departure";

const departure = (gameId: string): ControllerDepartureReference => ({
  workflow: "ad-hoc",
  gameId,
  navigationPath: `/game/${gameId}`,
  identity: { title: "Ad Hoc Game", homeName: "Basel", awayName: "Zurich" },
});

describe("Controller Departure", () => {
  test("keeps the newest opportunity and blocks every superseded game", async () => {
    const adapters = createInMemoryControllerDepartureAdapters({ nowMs: 100 });
    const module = createControllerDeparture(adapters);
    await module.transition({ type: "leave", departure: departure("adhoc-a"), online: false });
    const result = await module.transition({
      type: "leave",
      departure: departure("adhoc-b"),
      online: false,
      nowMs: 200,
    });
    expect(result).toMatchObject({
      status: "left",
      projection: { departure: { gameId: "adhoc-b" } },
    });
    expect(controllerDepartureBlocksGame(module.project(), "adhoc-a")).toBe(true);
    expect(adapters.clearedReplicas).toContain("adhoc-a");
    expect(
      (await module.transition({ type: "return", gameId: "adhoc-a", online: false })).status,
    ).toBe("unavailable");
  });

  test("requires confirmation before replacing a return opportunity", async () => {
    const finalized: string[] = [];
    const adapters = createInMemoryControllerDepartureAdapters({
      departure: departure("adhoc-a"),
      finalize: async (value) => {
        finalized.push(value.gameId);
        return "accepted";
      },
    });
    const module = createControllerDeparture(adapters);
    const request = await module.transition({
      type: "request-entry",
      destination: { kind: "new-ad-hoc" },
      online: true,
    });
    expect(request).toMatchObject({
      status: "needs-confirmation",
      departure: { gameId: "adhoc-a" },
    });
    if (request.status !== "needs-confirmation") throw new Error("Expected replacement request.");
    const decision = await module.transition({
      type: "confirm-entry",
      request: request.request,
      online: true,
    });
    expect(decision.status).toBe("authorized");
    if (decision.status !== "authorized") throw new Error("Expected replacement authorization.");
    const committed = await module.transition({
      type: "commit-entry",
      authorization: decision.authorization,
    });
    expect(committed).toMatchObject({ status: "committed" });
    if (committed.status !== "committed" || committed.completion === undefined)
      throw new Error("Expected entry completion.");
    expect(
      await module.transition({
        type: "complete-entry",
        completion: committed.completion,
        succeeded: true,
      }),
    ).toMatchObject({ status: "committed" });
    expect(finalized).toEqual(["adhoc-a"]);
    expect(controllerDepartureBlocksGame(module.project(), "adhoc-a")).toBe(true);
  });

  test("defers offline expiry and retries accepted finalization after a restart", async () => {
    const finalized: string[] = [];
    const adapters = createInMemoryControllerDepartureAdapters({
      nowMs: 0,
      departure: departure("adhoc-a"),
      finalize: async (value) => {
        finalized.push(value.gameId);
        return "accepted";
      },
    });
    const first = createControllerDeparture(adapters);
    adapters.setOnline(false);
    expect(
      await first.transition({ type: "expire", online: false, nowMs: CONTROLLER_LEAVE_GRACE_MS }),
    ).toEqual({ status: "expired", finalization: "deferred" });
    expect(first.project()).toMatchObject({
      status: "blocked",
      pendingFinalizations: [{ gameId: "adhoc-a" }],
    });
    first.dispose();
    const restarted = createControllerDeparture(adapters);
    adapters.setOnline(true);
    await flushRetries();
    expect(finalized).toEqual(["adhoc-a"]);
    expect(restarted.project()).toMatchObject({ status: "blocked", pendingFinalizations: [] });
  });

  test("keeps deferred expiry when later finalization is unavailable", async () => {
    let result: "accepted" | "unavailable" | "deferred" = "unavailable";
    const adapters = createInMemoryControllerDepartureAdapters({
      nowMs: 0,
      departure: departure("adhoc-a"),
      finalize: async () => result,
    });
    const module = createControllerDeparture(adapters);
    adapters.setOnline(false);
    await module.transition({ type: "expire", online: false, nowMs: CONTROLLER_LEAVE_GRACE_MS });
    adapters.setOnline(true);
    await flushRetries();
    expect(module.project()).toMatchObject({ status: "blocked", pendingFinalizations: [] });
    expect(adapters.clearedReplicas).toContain("adhoc-a");
    result = "accepted";
  });

  test("retains pending finalization after an adapter failure", async () => {
    let attempts = 0;
    const adapters = createInMemoryControllerDepartureAdapters({
      nowMs: 0,
      departure: departure("adhoc-a"),
      finalize: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transport failure");
        return "accepted";
      },
    });
    const module = createControllerDeparture(adapters);
    expect(
      await module.transition({ type: "expire", online: true, nowMs: CONTROLLER_LEAVE_GRACE_MS }),
    ).toEqual({
      status: "expired",
      finalization: "deferred",
    });
    expect(module.project()).toMatchObject({ pendingFinalizations: [{ gameId: "adhoc-a" }] });
    adapters.setOnline(false);
    adapters.setOnline(true);
    await flushRetries();
    expect(attempts).toBe(2);
    expect(module.project()).toMatchObject({ pendingFinalizations: [] });
  });

  test("offline Return survives restart and reconciles without clearing a valid replica", async () => {
    let reconcileResult: "available" | "transient" | "unavailable" = "available";
    const adapters = createInMemoryControllerDepartureAdapters({
      departure: departure("adhoc-a"),
      reconcile: async () => reconcileResult,
    });
    const first = createControllerDeparture(adapters);
    adapters.setOnline(false);
    expect(await first.transition({ type: "return", gameId: "adhoc-a", online: false })).toEqual({
      status: "resumed",
      mode: "offline",
    });
    first.dispose();
    const restarted = createControllerDeparture(adapters);
    adapters.setOnline(true);
    await flushRetries();
    expect(restarted.project()).toMatchObject({ status: "returned", reconciliationPending: [] });
    expect(adapters.clearedReplicas).toEqual([]);
  });

  test("authoritative unavailability after offline Return blocks reopening and clears its replica", async () => {
    const adapters = createInMemoryControllerDepartureAdapters({
      departure: departure("adhoc-a"),
      reconcile: async () => "unavailable",
    });
    const module = createControllerDeparture(adapters);
    adapters.setOnline(false);
    await module.transition({ type: "return", gameId: "adhoc-a", online: false });
    adapters.setOnline(true);
    await flushRetries();
    expect(controllerDepartureBlocksGame(module.project(), "adhoc-a")).toBe(true);
    expect(adapters.clearedReplicas).toContain("adhoc-a");
  });

  test("transient reconciliation failure does not invalidate offline Return", async () => {
    const adapters = createInMemoryControllerDepartureAdapters({
      departure: departure("adhoc-a"),
      reconcile: async () => "transient",
    });
    const module = createControllerDeparture(adapters);
    adapters.setOnline(false);
    await module.transition({ type: "return", gameId: "adhoc-a", online: false });
    adapters.setOnline(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(controllerDepartureBlocksGame(module.project(), "adhoc-a")).toBe(false);
    expect(module.project()).toMatchObject({ reconciliationPending: [{ gameId: "adhoc-a" }] });
  });

  test("fails closed when persistence cannot write", async () => {
    const module = createControllerDeparture({
      persistence: {
        read: () => ({ status: "empty", revision: 0 }),
        write: () => false,
        clear: () => undefined,
      },
    });
    expect(await module.transition({ type: "leave", departure: departure("adhoc-a") })).toEqual({
      status: "unavailable",
    });
  });

  test("serializes retry-in-flight before a newer Leave and preserves the newest departure", async () => {
    let releaseRetry!: (result: "accepted" | "deferred" | "unavailable") => void;
    let finalizeCalls = 0;
    const retryResult = new Promise<"accepted" | "deferred" | "unavailable">((resolve) => {
      releaseRetry = resolve;
    });
    const adapters = createInMemoryControllerDepartureAdapters({
      nowMs: 0,
      departure: departure("adhoc-a"),
      finalize: async () => {
        finalizeCalls += 1;
        return retryResult;
      },
    });
    const module = createControllerDeparture(adapters);
    adapters.setOnline(false);
    await module.transition({ type: "expire", online: false, nowMs: CONTROLLER_LEAVE_GRACE_MS });
    adapters.setOnline(true);
    await Promise.resolve();
    const leave = module.transition({
      type: "leave",
      departure: departure("adhoc-b"),
      online: false,
      nowMs: CONTROLLER_LEAVE_GRACE_MS + 1,
    });
    expect(finalizeCalls).toBe(1);
    releaseRetry("accepted");
    expect(await leave).toMatchObject({
      status: "left",
      projection: { departure: { gameId: "adhoc-b" } },
    });
    expect(module.project()).toMatchObject({
      status: "returnable",
      departure: { gameId: "adhoc-b" },
    });
    expect(controllerDepartureBlocksGame(module.project(), "adhoc-a")).toBe(true);
  });

  test("does not finalize or clear a replica when superseding Leave cannot persist", async () => {
    let state = {
      status: "returnable" as const,
      revision: 0,
      departure: departure("adhoc-a"),
      expiresAtMs: CONTROLLER_LEAVE_GRACE_MS,
      blockedGameIds: [],
      pendingFinalizations: [],
      reconciliationPending: [],
    };
    let writes = 0;
    const cleared: string[] = [];
    const finalized: string[] = [];
    const clock = createInMemoryControllerDepartureAdapters({ nowMs: 0 }).clock;
    const module = createControllerDeparture({
      clock,
      persistence: {
        read: () => state,
        write: () => {
          writes += 1;
          return false;
        },
        clear: () => undefined,
      },
      replica: { clear: (gameId) => cleared.push(gameId), clearAll: () => undefined },
      authority: {
        finalize: async (value) => {
          finalized.push(value.gameId);
          return "accepted";
        },
        reconcile: async () => "available",
      },
    });
    expect(
      await module.transition({ type: "leave", departure: departure("adhoc-b"), online: true }),
    ).toEqual({ status: "unavailable" });
    expect(writes).toBe(1);
    expect(state.departure.gameId).toBe("adhoc-a");
    expect(cleared).toEqual([]);
    expect(finalized).toEqual([]);
  });

  test("does not finalize or clear a replica when confirmed replacement cannot persist", async () => {
    const initial = {
      status: "returnable" as const,
      revision: 0,
      departure: departure("adhoc-a"),
      expiresAtMs: CONTROLLER_LEAVE_GRACE_MS,
      blockedGameIds: [],
      pendingFinalizations: [],
      reconciliationPending: [],
    };
    const cleared: string[] = [];
    const finalized: string[] = [];
    const clock = createInMemoryControllerDepartureAdapters({ nowMs: 0 }).clock;
    const module = createControllerDeparture({
      clock,
      persistence: {
        read: () => initial,
        write: () => false,
        clear: () => undefined,
      },
      replica: { clear: (gameId) => cleared.push(gameId), clearAll: () => undefined },
      authority: {
        finalize: async (value) => {
          finalized.push(value.gameId);
          return "accepted";
        },
        reconcile: async () => "available",
      },
    });
    const request = await module.transition({
      type: "request-entry",
      destination: { kind: "new-ad-hoc" },
    });
    expect(request.status).toBe("needs-confirmation");
    if (request.status !== "needs-confirmation") throw new Error("Expected replacement request.");
    expect(await module.transition({ type: "confirm-entry", request: request.request })).toEqual({
      status: "unavailable",
    });
    expect(cleared).toEqual([]);
    expect(finalized).toEqual([]);
  });

  test("re-prompts when departure B supersedes the departure shown by dialog A", async () => {
    const adapters = createInMemoryControllerDepartureAdapters({
      departure: departure("adhoc-a"),
    });
    const dialogModule = createControllerDeparture(adapters);
    const writerModule = createControllerDeparture(adapters);
    const requested = await dialogModule.transition({
      type: "request-entry",
      destination: { kind: "new-ad-hoc" },
      online: false,
    });
    expect(requested).toMatchObject({
      status: "needs-confirmation",
      departure: { gameId: "adhoc-a" },
    });
    if (requested.status !== "needs-confirmation") throw new Error("Expected dialog A.");

    await writerModule.transition({
      type: "leave",
      departure: departure("adhoc-b"),
      online: false,
      nowMs: 100,
    });
    const staleConfirm = await dialogModule.transition({
      type: "confirm-entry",
      request: requested.request,
      online: false,
    });
    expect(staleConfirm).toMatchObject({
      status: "needs-confirmation",
      departure: { gameId: "adhoc-b" },
    });
  });

  test("invalidates an authorization when a newer departure is persisted", async () => {
    const adapters = createInMemoryControllerDepartureAdapters();
    const entryModule = createControllerDeparture(adapters);
    const writerModule = createControllerDeparture(adapters);
    const authorized = await entryModule.transition({
      type: "request-entry",
      destination: { kind: "new-ad-hoc" },
      online: false,
    });
    if (authorized.status !== "authorized") throw new Error("Expected entry authorization.");

    await writerModule.transition({
      type: "leave",
      departure: departure("adhoc-b"),
      online: false,
    });
    const staleCommit = await entryModule.transition({
      type: "commit-entry",
      authorization: authorized.authorization,
    });
    expect(staleCommit).toMatchObject({
      status: "needs-confirmation",
      departure: { gameId: "adhoc-b" },
    });
  });

  test("merges a retry result into a newer revision written by another module", async () => {
    let releaseRetry!: (result: "accepted" | "deferred" | "unavailable") => void;
    const retryResult = new Promise<"accepted" | "deferred" | "unavailable">((resolve) => {
      releaseRetry = resolve;
    });
    const adapters = createInMemoryControllerDepartureAdapters({
      nowMs: 0,
      departure: departure("adhoc-a"),
      finalize: async () => retryResult,
    });
    const retryModule = createControllerDeparture(adapters);
    adapters.setOnline(false);
    await retryModule.transition({
      type: "expire",
      online: false,
      nowMs: CONTROLLER_LEAVE_GRACE_MS,
    });
    adapters.setOnline(true);
    await Promise.resolve();
    adapters.setOnline(false);
    const writerModule = createControllerDeparture(adapters);
    await writerModule.transition({
      type: "leave",
      departure: departure("adhoc-b"),
      online: false,
      nowMs: CONTROLLER_LEAVE_GRACE_MS + 1,
    });
    releaseRetry("accepted");
    await flushRetries();

    expect(retryModule.project()).toMatchObject({
      status: "returnable",
      departure: { gameId: "adhoc-b" },
      pendingFinalizations: [],
    });
    expect(controllerDepartureBlocksGame(retryModule.project(), "adhoc-a")).toBe(true);
  });

  test("treats direct entry to the returnable Game as Return and cancels expiry", async () => {
    let finalized = 0;
    const adapters = createInMemoryControllerDepartureAdapters({
      nowMs: 0,
      departure: departure("adhoc-a"),
      finalize: async () => {
        finalized += 1;
        return "accepted";
      },
    });
    adapters.setOnline(false);
    const module = createControllerDeparture(adapters);
    const entry = await module.transition({
      type: "request-entry",
      destination: { kind: "resume-ad-hoc", gameId: "adhoc-a" },
      online: false,
    });
    expect(entry.status).toBe("authorized");
    expect(module.project()).toMatchObject({
      status: "returned",
      reconciliationPending: [{ gameId: "adhoc-a" }],
    });
    adapters.advanceTo(CONTROLLER_LEAVE_GRACE_MS + 1);
    await flushRetries();
    expect(module.project().status).toBe("returned");
    expect(finalized).toBe(0);
  });

  test("fails closed on corrupt lifecycle state and only recovers through fresh admission", async () => {
    const adapters = createInMemoryControllerDepartureAdapters({
      projection: { status: "failed-closed", revision: 7 },
    });
    const module = createControllerDeparture(adapters);
    expect(module.project()).toMatchObject({ status: "failed-closed" });
    expect(adapters.clearAllCount).toBe(1);
    expect(
      await module.transition({
        type: "request-entry",
        destination: { kind: "resume-ad-hoc", gameId: "adhoc-retained" },
      }),
    ).toEqual({ status: "unavailable" });
    const fresh = await module.transition({
      type: "request-entry",
      destination: { kind: "admit-ad-hoc", gameId: "adhoc-fresh" },
    });
    if (fresh.status !== "authorized") throw new Error("Expected fresh admission authorization.");
    const committed = await module.transition({
      type: "commit-entry",
      authorization: fresh.authorization,
    });
    expect(committed).toMatchObject({ status: "committed" });
    if (committed.status !== "committed" || committed.completion === undefined)
      throw new Error("Expected admission completion.");
    expect(module.project()).toMatchObject({ status: "failed-closed" });
    expect(
      await module.transition({
        type: "complete-entry",
        completion: committed.completion,
        succeeded: false,
      }),
    ).toMatchObject({ status: "committed" });
    expect(module.project()).toMatchObject({ status: "failed-closed" });

    const retry = await module.transition({
      type: "request-entry",
      destination: { kind: "admit-ad-hoc", gameId: "adhoc-fresh" },
    });
    if (retry.status !== "authorized") throw new Error("Expected fresh admission retry.");
    const retryCommitted = await module.transition({
      type: "commit-entry",
      authorization: retry.authorization,
    });
    if (retryCommitted.status !== "committed" || retryCommitted.completion === undefined)
      throw new Error("Expected retry completion.");
    expect(
      await module.transition({
        type: "complete-entry",
        completion: retryCommitted.completion,
        succeeded: true,
      }),
    ).toMatchObject({ status: "committed" });
    expect(module.project()).toMatchObject({ status: "empty" });
  });

  test("keeps browser finalization retryable for network, 429, and 5xx failures", async () => {
    const originalFetch = globalThis.fetch;
    const statuses = ["network", 429, 503, 200] as const;
    let calls = 0;
    globalThis.fetch = (async () => {
      const status = statuses[calls++] ?? 200;
      if (status === "network") throw new Error("offline");
      return new Response(null, { status });
    }) as unknown as typeof fetch;
    try {
      const base = createInMemoryControllerDepartureAdapters({
        nowMs: 0,
        departure: departure("adhoc-a"),
      });
      const module = createControllerDeparture({
        clock: base.clock,
        persistence: base.persistence,
        connectivity: base.connectivity,
        replica: base.replica,
      });
      base.setOnline(false);
      await module.transition({ type: "expire", online: false, nowMs: CONTROLLER_LEAVE_GRACE_MS });
      for (const expectedCalls of [1, 2, 3, 4]) {
        base.setOnline(true);
        await flushRetries();
        expect(calls).toBe(expectedCalls);
        if (expectedCalls < 4) {
          expect(module.project()).toMatchObject({ pendingFinalizations: [{ gameId: "adhoc-a" }] });
          base.setOnline(false);
        }
      }
      expect(module.project()).toMatchObject({ pendingFinalizations: [] });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

async function flushRetries() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
