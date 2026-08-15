import { describe, expect, test } from "bun:test";
import {
  createSpectatorCapacity,
  type SpectatorCurrentVersion,
  type SpectatorQueuedUpdate,
  type SpectatorStreamAdapter,
} from "@/lib/spectator-capacity";
import { SHARED_LIMITS, utf8ByteLength } from "@/lib/validation-policy";

type AudienceProjection = { score: number; privateToken?: string };

function createHarness(
  options: {
    activeControllers?: number;
    totalConnections?: number;
    controllerReserve?: number;
    maxSpectators?: number;
    perClientQueueLimit?: number;
    globalQueueLimit?: number;
    perClientQueuedOutputBytes?: number;
    measureQueuedOutputBytes?: (update: SpectatorQueuedUpdate<AudienceProjection>) => number;
    current?: SpectatorCurrentVersion<AudienceProjection>;
  } = {},
) {
  const closed: { clientId: string; reason: string }[] = [];
  const writes = new Map<string, string[]>();
  const replicaOutcomes: { clientId: string; version: string; replaceableKey: string | null }[] =
    [];
  let current = options.current ?? { version: "v1", payload: { score: 0 } };
  let currentAvailable = true;
  let controllerCapacityAvailable = true;
  let activeControllers = options.activeControllers ?? 0;
  let currentReadCount = 0;
  let blockCurrentRead = false;
  let releaseCurrentRead: (() => void) | null = null;
  const adapter: SpectatorStreamAdapter<AudienceProjection> = {
    async readCurrentVersion() {
      currentReadCount += 1;
      if (blockCurrentRead) {
        await new Promise<void>((resolve) => {
          releaseCurrentRead = resolve;
        });
      }
      if (!currentAvailable) return { status: "unavailable" };
      return { status: "available", current };
    },
    measureQueuedOutputBytes(update) {
      return (
        options.measureQueuedOutputBytes?.(update) ??
        utf8ByteLength(
          JSON.stringify({
            type: "audience-projection",
            eventId: update.eventId,
            version: update.version,
            replaceableKey: update.replaceableKey,
            payload: update.payload,
          }),
        )
      );
    },
    write(clientId, update) {
      const clientWrites = writes.get(clientId) ?? [];
      clientWrites.push(update.version);
      writes.set(clientId, clientWrites);
      replicaOutcomes.push({
        clientId,
        version: update.version,
        replaceableKey: update.replaceableKey,
      });
      return true;
    },
    close(clientId, reason) {
      closed.push({ clientId, reason });
    },
  };
  const capacity = createSpectatorCapacity({
    adapter,
    maxSpectators: options.maxSpectators,
    perClientQueueLimit: options.perClientQueueLimit,
    globalQueueLimit: options.globalQueueLimit,
    perClientQueuedOutputBytes: options.perClientQueuedOutputBytes,
    controllerCapacity: {
      totalConnections: options.totalConnections ?? 502,
      reservedConnections: options.controllerReserve ?? 2,
      activeControllerSessions: () => {
        if (!controllerCapacityAvailable) throw new Error("capacity unavailable");
        return activeControllers;
      },
    },
  });
  return {
    capacity,
    closed,
    writes,
    replicaOutcomes,
    currentReadCount: () => currentReadCount,
    blockCurrentVersionRead() {
      blockCurrentRead = true;
    },
    releaseCurrentVersionRead() {
      blockCurrentRead = false;
      releaseCurrentRead?.();
      releaseCurrentRead = null;
    },
    setCurrent(next: SpectatorCurrentVersion<AudienceProjection>) {
      current = next;
    },
    setActiveControllers(next: number) {
      activeControllers = next;
    },
    acceptControllerSession() {
      activeControllers += 1;
      return activeControllers;
    },
    setAdapterCurrentVersionUnavailable() {
      currentAvailable = false;
    },
    setControllerCapacityUnavailable() {
      controllerCapacityAvailable = false;
    },
  };
}

describe("Spectator capacity", () => {
  test("admits 500 logical spectators while protecting the Controller reserve", async () => {
    const harness = createHarness();

    for (let index = 0; index < 500; index += 1) {
      expect(
        await harness.capacity.admit({ clientId: `spectator-${index}`, eventId: "event-1" }),
      ).toMatchObject({
        status: "admitted",
        currentVersion: "v1",
      });
    }

    expect(
      await harness.capacity.admit({ clientId: "spectator-overflow", eventId: "event-1" }),
    ).toEqual({
      status: "rejected",
      reason: "capacity",
      message: "Spectator capacity is currently full; try again later.",
    });
    expect(harness.capacity.getMetrics()).toMatchObject({
      activeSpectators: 500,
      rejectedAdmission: 1,
      controllerImpactGuardrail: {
        reservedConnections: 2,
        activeControllerSessions: 0,
        protectedAdmissionRejects: 0,
      },
    });
  });

  test("uses the Controller reserve before active Controller Sessions consume spectator capacity", async () => {
    const harness = createHarness({ totalConnections: 5, controllerReserve: 2, maxSpectators: 5 });
    expect(harness.acceptControllerSession()).toBe(1);

    for (let index = 0; index < 3; index += 1) {
      expect(
        await harness.capacity.admit({ clientId: `spectator-${index}`, eventId: "event-1" }),
      ).toMatchObject({
        status: "admitted",
      });
    }
    expect(harness.capacity.getMetrics().controllerImpactGuardrail).toMatchObject({
      activeControllerSessions: 1,
      availableForSpectators: 3,
    });

    expect(harness.acceptControllerSession()).toBe(2);
    expect(harness.capacity.reconcileControllerCapacity()).toMatchObject({
      status: "reconciled",
      disconnected: 0,
      availableForSpectators: 3,
    });
    expect(harness.acceptControllerSession()).toBe(3);
    expect(harness.capacity.reconcileControllerCapacity()).toMatchObject({
      status: "reconciled",
      disconnected: 1,
      availableForSpectators: 2,
    });
    expect(
      await harness.capacity.admit({ clientId: "spectator-3", eventId: "event-1" }),
    ).toMatchObject({
      status: "rejected",
      reason: "capacity",
    });
    const metricsAfterReconciliation = harness.capacity.getMetrics();
    expect(harness.capacity.getMetrics()).toEqual(metricsAfterReconciliation);
    expect(metricsAfterReconciliation.controllerImpactGuardrail).toMatchObject({
      activeControllerSessions: 3,
      availableForSpectators: 2,
      reserveBreachesObserved: 1,
    });
  });

  test("preflights overflow before authoritative projection reads while Controller priority stays available", async () => {
    const harness = createHarness({ totalConnections: 502, controllerReserve: 2 });
    for (let index = 0; index < 500; index += 1) {
      await harness.capacity.admit({ clientId: `spectator-${index}`, eventId: "event-1" });
    }
    expect(harness.currentReadCount()).toBe(500);

    expect(harness.acceptControllerSession()).toBe(1);
    expect(harness.capacity.reconcileControllerCapacity()).toMatchObject({ disconnected: 0 });
    const readsBeforeOverflow = harness.currentReadCount();
    expect(
      await harness.capacity.admit({ clientId: "overflow", eventId: "event-1" }),
    ).toMatchObject({ status: "rejected", reason: "capacity" });
    expect(harness.currentReadCount()).toBe(readsBeforeOverflow);

    expect(harness.acceptControllerSession()).toBe(2);
    expect(harness.capacity.reconcileControllerCapacity()).toMatchObject({ disconnected: 0 });
    expect(harness.acceptControllerSession()).toBe(3);
    expect(harness.capacity.reconcileControllerCapacity()).toMatchObject({ disconnected: 1 });
    expect(harness.capacity.getMetrics()).toMatchObject({
      activeSpectators: 499,
      controllerImpactGuardrail: {
        activeControllerSessions: 3,
        availableForSpectators: 499,
      },
    });
  });

  test("rechecks and releases a provisional admission when Controller capacity changes during the read", async () => {
    const harness = createHarness({ totalConnections: 5, controllerReserve: 2, maxSpectators: 5 });
    await harness.capacity.admit({ clientId: "spectator-1", eventId: "event-1" });
    await harness.capacity.admit({ clientId: "spectator-2", eventId: "event-1" });

    harness.blockCurrentVersionRead();
    const pendingAdmission = harness.capacity.admit({
      clientId: "provisional",
      eventId: "event-1",
    });
    await Promise.resolve();
    expect(harness.currentReadCount()).toBe(3);

    harness.setActiveControllers(3);
    expect(harness.capacity.reconcileControllerCapacity()).toMatchObject({ disconnected: 0 });
    harness.releaseCurrentVersionRead();
    expect(await pendingAdmission).toMatchObject({ status: "rejected", reason: "capacity" });
    expect(harness.capacity.getMetrics()).toMatchObject({ activeSpectators: 2 });

    harness.setActiveControllers(0);
    expect(
      await harness.capacity.admit({ clientId: "after-release", eventId: "event-1" }),
    ).toMatchObject({ status: "admitted" });
  });

  test("reserves global queued-output slots before concurrent authoritative reads", async () => {
    const harness = createHarness({
      totalConnections: 10,
      controllerReserve: 0,
      maxSpectators: 10,
      globalQueueLimit: 2,
    });
    await harness.capacity.admit({ clientId: "first", eventId: "event-1" });
    harness.blockCurrentVersionRead();
    const pendingAdmission = harness.capacity.admit({ clientId: "second", eventId: "event-1" });
    await Promise.resolve();
    expect(harness.currentReadCount()).toBe(2);

    expect(
      await harness.capacity.admit({ clientId: "overflow", eventId: "event-1" }),
    ).toMatchObject({ status: "rejected", reason: "capacity" });
    expect(harness.currentReadCount()).toBe(2);
    harness.releaseCurrentVersionRead();
    expect(await pendingAdmission).toMatchObject({ status: "admitted" });
    expect(harness.capacity.getMetrics()).toMatchObject({ queuedUpdates: 2 });

    const reconnectHarness = createHarness({
      totalConnections: 10,
      controllerReserve: 0,
      maxSpectators: 10,
      globalQueueLimit: 1,
    });
    await reconnectHarness.capacity.admit({ clientId: "reconnect", eventId: "event-1" });
    await reconnectHarness.capacity.drain("reconnect");
    reconnectHarness.blockCurrentVersionRead();
    const reconnect = reconnectHarness.capacity.admit({
      clientId: "reconnect",
      eventId: "event-1",
    });
    await Promise.resolve();
    expect(reconnectHarness.currentReadCount()).toBe(2);
    reconnectHarness.releaseCurrentVersionRead();
    expect(await reconnect).toMatchObject({ status: "admitted" });
  });

  test("coalesces only after the latest barrier and preserves replica order", async () => {
    const harness = createHarness({ perClientQueueLimit: 3, globalQueueLimit: 4 });
    const admitted = await harness.capacity.admit({ clientId: "spectator-1", eventId: "event-1" });
    expect(admitted.status).toBe("admitted");
    await harness.capacity.drain("spectator-1");

    expect(
      harness.capacity.publish({
        eventId: "event-1",
        version: "v2",
        payload: { score: 10 },
        replaceableKey: "projection",
      }),
    ).toMatchObject({ queued: 1 });
    harness.capacity.publish({
      eventId: "event-1",
      version: "timeline-v3",
      payload: { score: 20 },
      replaceableKey: null,
    });
    expect(
      harness.capacity.publish({
        eventId: "event-1",
        version: "projection-v4",
        payload: { score: 30 },
        replaceableKey: "projection",
      }),
    ).toMatchObject({ queued: 1, coalesced: 0 });
    expect(
      harness.capacity.publish({
        eventId: "event-1",
        version: "projection-v5",
        payload: { score: 40 },
        replaceableKey: "projection",
      }),
    ).toMatchObject({ queued: 1, coalesced: 1 });

    expect(harness.capacity.getQueueState("spectator-1")).toMatchObject({
      queuedUpdates: 3,
      queuedVersions: ["v2", "timeline-v3", "projection-v5"],
    });
    await harness.capacity.drain("spectator-1");
    expect(harness.writes.get("spectator-1")).toEqual(["v1", "v2", "timeline-v3", "projection-v5"]);
    expect(harness.replicaOutcomes).toEqual([
      { clientId: "spectator-1", version: "v1", replaceableKey: "projection" },
      { clientId: "spectator-1", version: "v2", replaceableKey: "projection" },
      { clientId: "spectator-1", version: "timeline-v3", replaceableKey: null },
      { clientId: "spectator-1", version: "projection-v5", replaceableKey: "projection" },
    ]);
    expect(harness.capacity.getMetrics().coalescedUpdates).toBe(1);
  });

  test("disconnects a slow reader at the per-client and global queue boundary", async () => {
    const harness = createHarness({ perClientQueueLimit: 2, globalQueueLimit: 2 });
    await harness.capacity.admit({ clientId: "slow", eventId: "event-1" });
    await harness.capacity.drain("slow");
    harness.capacity.publish({
      eventId: "event-1",
      version: "v2",
      payload: { score: 1 },
      replaceableKey: null,
    });
    harness.capacity.publish({
      eventId: "event-1",
      version: "v3",
      payload: { score: 2 },
      replaceableKey: null,
    });
    harness.capacity.publish({
      eventId: "event-1",
      version: "v4",
      payload: { score: 3 },
      replaceableKey: null,
    });

    expect(harness.closed).toEqual([{ clientId: "slow", reason: "slow-reader" }]);
    expect(harness.capacity.getMetrics()).toMatchObject({ slowReaderDisconnects: 1 });
    expect(harness.capacity.getQueueState("slow")).toBeNull();
  });

  test("rejects oversized or Infinity-sized Audience Projections before buffering them", async () => {
    const initialTooLarge = createHarness({
      current: { version: "v1", payload: { score: 1 } },
      perClientQueuedOutputBytes: SHARED_LIMITS.transport.websocketTextFrameBytes,
      measureQueuedOutputBytes: () => Number.POSITIVE_INFINITY,
    });
    expect(
      await initialTooLarge.capacity.admit({ clientId: "too-large", eventId: "event-1" }),
    ).toEqual({
      status: "rejected",
      reason: "output-limit",
      message: "Spectator output is currently unavailable.",
    });
    expect(initialTooLarge.closed).toEqual([{ clientId: "too-large", reason: "slow-reader" }]);
    expect(initialTooLarge.capacity.getMetrics()).toMatchObject({
      activeSpectators: 0,
      queuedUpdates: 0,
    });

    let large = false;
    const coalescedTooLarge = createHarness({
      perClientQueuedOutputBytes: SHARED_LIMITS.transport.websocketTextFrameBytes,
      measureQueuedOutputBytes: (update) =>
        large
          ? Number.POSITIVE_INFINITY
          : utf8ByteLength(
              JSON.stringify({
                type: "audience-projection",
                eventId: update.eventId,
                version: update.version,
                replaceableKey: update.replaceableKey,
                payload: update.payload,
              }),
            ),
    });
    expect(
      await coalescedTooLarge.capacity.admit({
        clientId: "coalesced-too-large",
        eventId: "event-1",
      }),
    ).toMatchObject({ status: "admitted" });
    await coalescedTooLarge.capacity.drain("coalesced-too-large");
    coalescedTooLarge.capacity.publish({
      eventId: "event-1",
      version: "v2",
      payload: { score: 2 },
      replaceableKey: "projection",
    });
    large = true;
    expect(
      coalescedTooLarge.capacity.publish({
        eventId: "event-1",
        version: "v3",
        payload: { score: 3 },
        replaceableKey: "projection",
      }),
    ).toMatchObject({ queued: 0, disconnected: 1 });
    expect(coalescedTooLarge.capacity.getQueueState("coalesced-too-large")).toBeNull();
  });

  test("enforces the exact serialized envelope boundary, including escaped fields", async () => {
    const eventId = 'event-"quoted"';
    const current = { version: "v1", payload: { score: 1 } } as const;
    const exactEnvelope = JSON.stringify({
      type: "audience-projection",
      eventId,
      version: current.version,
      replaceableKey: "projection",
      payload: current.payload,
    });
    const harness = createHarness({
      current,
      perClientQueuedOutputBytes: utf8ByteLength(exactEnvelope),
    });

    expect(await harness.capacity.admit({ clientId: "escaped", eventId })).toMatchObject({
      status: "admitted",
    });
    await harness.capacity.drain("escaped");
    harness.capacity.publish({
      eventId,
      version: "v2",
      payload: { score: 123456789012345 },
      replaceableKey: null,
    });
    expect(harness.closed).toEqual([{ clientId: "escaped", reason: "slow-reader" }]);
  });

  test("reconnects from the current authoritative version without replaying stale payloads", async () => {
    const harness = createHarness({ current: { version: "v8", payload: { score: 80 } } });
    await harness.capacity.admit({ clientId: "old", eventId: "event-1" });
    await harness.capacity.drain("old");
    harness.setCurrent({
      version: "v9",
      payload: { score: 90, privateToken: "must-not-be-measured" },
    });
    harness.capacity.publish({
      eventId: "event-1",
      version: "v9",
      payload: { score: 90, privateToken: "must-not-be-measured" },
      replaceableKey: "projection",
    });
    harness.capacity.disconnect("old", "client-reconnect");

    const reconnected = await harness.capacity.admit({
      clientId: "new",
      eventId: "event-1",
      lastSeenVersion: "v1",
    });
    expect(reconnected).toMatchObject({ status: "admitted", currentVersion: "v9" });
    expect(harness.capacity.getQueueState("new")).toMatchObject({ queuedVersions: ["v9"] });
    expect(JSON.stringify(harness.capacity.getMetrics())).not.toContain("privateToken");
  });

  test("returns a generic unavailable result when the authoritative current version cannot be read", async () => {
    const harness = createHarness();
    harness.setAdapterCurrentVersionUnavailable();

    expect(await harness.capacity.admit({ clientId: "spectator-1", eventId: "event-1" })).toEqual({
      status: "unavailable",
      message: "Spectator experience is currently unavailable.",
    });
  });

  test("does not turn an unavailable Controller capacity read into a public capacity detail", async () => {
    const harness = createHarness();
    harness.setControllerCapacityUnavailable();

    expect(await harness.capacity.admit({ clientId: "spectator-1", eventId: "event-1" })).toEqual({
      status: "unavailable",
      message: "Spectator experience is currently unavailable.",
    });
  });

  test("runs the deterministic 500-spectator harness with slow-reader, reconnect, and Controller churn", async () => {
    const harness = createHarness({
      perClientQueueLimit: 2,
      totalConnections: 502,
      controllerReserve: 2,
    });
    for (let index = 0; index < 500; index += 1) {
      await harness.capacity.admit({ clientId: `logical-${index}`, eventId: "event-1" });
      if (index < 499) await harness.capacity.drain(`logical-${index}`);
      if (index === 99) {
        expect(harness.acceptControllerSession()).toBe(1);
        expect(harness.capacity.reconcileControllerCapacity()).toMatchObject({ disconnected: 0 });
      }
      if (index === 299) {
        expect(harness.acceptControllerSession()).toBe(2);
        expect(harness.capacity.reconcileControllerCapacity()).toMatchObject({ disconnected: 0 });
      }
    }

    harness.capacity.publish({
      eventId: "event-1",
      version: "v2",
      payload: { score: 1 },
      replaceableKey: null,
    });
    harness.capacity.publish({
      eventId: "event-1",
      version: "v3",
      payload: { score: 2 },
      replaceableKey: null,
    });
    expect(harness.capacity.getQueueState("logical-499")).toBeNull();

    for (let index = 0; index < 3; index += 1) {
      harness.capacity.disconnect(`logical-${index}`, "client-reconnect");
      expect(
        await harness.capacity.admit({
          clientId: `reconnected-${index}`,
          eventId: "event-1",
          lastSeenVersion: "v1",
        }),
      ).toMatchObject({ status: "admitted", currentVersion: "v1" });
      await harness.capacity.drain(`reconnected-${index}`);
    }

    expect(harness.acceptControllerSession()).toBe(3);
    expect(harness.capacity.reconcileControllerCapacity()).toMatchObject({
      status: "reconciled",
      disconnected: 0,
    });
    expect(harness.acceptControllerSession()).toBe(4);
    expect(harness.capacity.reconcileControllerCapacity()).toMatchObject({
      status: "reconciled",
      disconnected: 1,
    });
    expect(harness.closed.at(-1)).toEqual({
      clientId: "reconnected-2",
      reason: "controller-priority",
    });
    expect(
      await harness.capacity.admit({ clientId: "controller-pressure", eventId: "event-1" }),
    ).toMatchObject({
      status: "rejected",
      reason: "capacity",
    });
    expect(harness.capacity.getMetrics()).toMatchObject({
      activeSpectators: 498,
      slowReaderDisconnects: 1,
      controllerImpactGuardrail: {
        activeControllerSessions: 4,
        availableForSpectators: 498,
        reserveBreachesObserved: 1,
      },
    });
  });
});
