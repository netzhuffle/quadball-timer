import {
  availableNonControllerCapacity,
  type ControllerCapacityInput,
} from "@/lib/controller-capacity";
import { SHARED_LIMITS } from "@/lib/validation-policy";

/**
 * The spectator path deliberately owns delivery pressure only. Controller
 * admission and authority remain owned by the live-control runtime; this
 * source is the read-only capacity signal supplied by that runtime.
 */
export type ControllerCapacitySignal = {
  totalConnections: number;
  reservedConnections: number;
  /** Number of currently active authoritative Controller Grant Sessions. */
  activeControllerSessions: () => number;
};

export type SpectatorCurrentVersion<TPayload> = {
  version: string;
  payload: TPayload;
};

export type SpectatorQueuedUpdate<TPayload> = SpectatorCurrentVersion<TPayload> & {
  eventId: string;
  replaceableKey: string | null;
};

export type SpectatorCurrentVersionResult<TPayload> =
  | { status: "available"; current: SpectatorCurrentVersion<TPayload> }
  | { status: "unavailable" };

export type SpectatorStreamAdapter<TPayload> = {
  readCurrentVersion(input: { eventId: string }): Promise<SpectatorCurrentVersionResult<TPayload>>;
  /** Exact bytes of the serialized transport envelope, supplied by the transport seam. */
  measureQueuedOutputBytes(update: SpectatorQueuedUpdate<TPayload>): number;
  write(clientId: string, update: SpectatorQueuedUpdate<TPayload>): boolean | Promise<boolean>;
  close(clientId: string, reason: SpectatorDisconnectReason): void;
};

export type SpectatorDisconnectReason =
  | "slow-reader"
  | "controller-priority"
  | "client-reconnect"
  | "client-closed";

export type SpectatorCapacityOptions<TPayload> = {
  adapter: SpectatorStreamAdapter<TPayload>;
  controllerCapacity: ControllerCapacitySignal;
  maxSpectators?: number;
  /** Maximum number of queued updates retained for one spectator. */
  perClientQueueLimit?: number;
  /** Maximum number of queued updates retained across all spectators. */
  globalQueueLimit?: number;
  /** Reuses the shared WebSocket text-frame byte boundary by default. */
  perClientQueuedOutputBytes?: number;
};

export type SpectatorAdmissionInput = {
  clientId: string;
  eventId: string;
  /** Informational only: no historical replay is attempted. */
  lastSeenVersion?: string;
};

export type SpectatorAdmissionResult =
  | {
      status: "admitted";
      currentVersion: string;
      currentVersionWasAlreadyKnown: boolean;
    }
  | {
      status: "rejected";
      reason: "capacity";
      message: "Spectator capacity is currently full; try again later.";
    }
  | {
      status: "rejected";
      reason: "output-limit";
      message: "Spectator output is currently unavailable.";
    }
  | {
      status: "unavailable";
      message: "Spectator experience is currently unavailable.";
    };

export type SpectatorPublishInput<TPayload> = SpectatorCurrentVersion<TPayload> & {
  eventId: string;
  replaceableKey: string | null;
};

export type SpectatorPublishResult = {
  queued: number;
  coalesced: number;
  disconnected: number;
};

export type SpectatorQueueState = {
  queuedUpdates: number;
  queuedBytes: number;
  queuedVersions: readonly string[];
};

export type SpectatorCapacityMetrics = {
  activeSpectators: number;
  rejectedAdmission: number;
  coalescedUpdates: number;
  slowReaderDisconnects: number;
  queuedClients: number;
  queuedUpdates: number;
  queuedBytes: number;
  controllerImpactGuardrail: {
    totalConnections: number;
    reservedConnections: number;
    activeControllerSessions: number;
    availableForSpectators: number;
    protectedAdmissionRejects: number;
    reserveBreachesObserved: number;
  };
};

type SpectatorClient<TPayload> = {
  eventId: string;
  queue: SpectatorQueuedUpdate<TPayload>[];
  queuedBytes: number;
  admittedSequence: number;
};

const DEFAULT_MAX_SPECTATORS = SHARED_LIMITS.load.maxConnectedSpectators;
const DEFAULT_PER_CLIENT_QUEUE_LIMIT = 8;
const DEFAULT_GLOBAL_QUEUE_LIMIT = 2_000;
const DEFAULT_PER_CLIENT_QUEUED_OUTPUT_BYTES = SHARED_LIMITS.transport.websocketTextFrameBytes;
const GENERIC_UNAVAILABLE_MESSAGE = "Spectator experience is currently unavailable." as const;
const OUTPUT_LIMIT_MESSAGE = "Spectator output is currently unavailable." as const;

export function createSpectatorCapacity<TPayload>(
  options: SpectatorCapacityOptions<TPayload>,
): SpectatorCapacity<TPayload> {
  const maxSpectators = positiveLimit(options.maxSpectators, DEFAULT_MAX_SPECTATORS);
  const perClientQueueLimit = positiveLimit(
    options.perClientQueueLimit,
    DEFAULT_PER_CLIENT_QUEUE_LIMIT,
  );
  const globalQueueLimit = positiveLimit(options.globalQueueLimit, DEFAULT_GLOBAL_QUEUE_LIMIT);
  const perClientQueuedOutputBytes = positiveLimit(
    options.perClientQueuedOutputBytes,
    DEFAULT_PER_CLIENT_QUEUED_OUTPUT_BYTES,
  );
  const clients = new Map<string, SpectatorClient<TPayload>>();
  let queuedUpdates = 0;
  let queuedBytes = 0;
  let rejectedAdmission = 0;
  let coalescedUpdates = 0;
  let slowReaderDisconnects = 0;
  let protectedAdmissionRejects = 0;
  let reserveBreachesObserved = 0;
  let admissionSequence = 0;
  const provisionalAdmissions = new Set<string>();

  function controllerSignal() {
    const totalConnections = positiveLimit(options.controllerCapacity.totalConnections, 1);
    const reservedConnections = boundedLimit(
      options.controllerCapacity.reservedConnections,
      0,
      totalConnections,
    );
    let activeControllerSessions = 0;
    try {
      const observed = options.controllerCapacity.activeControllerSessions();
      if (!Number.isFinite(observed)) return null;
      activeControllerSessions = Math.max(0, Math.floor(observed));
    } catch {
      return null;
    }
    const capacityInput: ControllerCapacityInput = {
      totalConnections,
      reservedConnections,
      activeControllerSessions,
    };
    const availableForSpectators = availableNonControllerCapacity(capacityInput);
    return {
      totalConnections,
      reservedConnections,
      activeControllerSessions,
      availableForSpectators,
    };
  }

  function allowedSpectators(signal: NonNullable<ReturnType<typeof controllerSignal>>): number {
    return Math.min(maxSpectators, signal.availableForSpectators);
  }

  function reconcileControllerCapacityInternal(
    signal: NonNullable<ReturnType<typeof controllerSignal>>,
  ): number {
    const excess = clients.size - allowedSpectators(signal);
    if (excess <= 0) return 0;
    const victims = [...clients.entries()]
      .sort(
        ([leftId, left], [rightId, right]) =>
          right.admittedSequence - left.admittedSequence || rightId.localeCompare(leftId),
      )
      .slice(0, excess);
    for (const [clientId] of victims) disconnect(clientId, "controller-priority");
    reserveBreachesObserved += victims.length;
    return victims.length;
  }

  function canAdmit(signal: NonNullable<ReturnType<typeof controllerSignal>>, clientId: string) {
    const existing = clients.get(clientId);
    const replacingCount = existing === undefined ? 0 : 1;
    const alreadyProvisional = provisionalAdmissions.has(clientId);
    const prospectiveSpectators =
      clients.size - replacingCount + provisionalAdmissions.size + (alreadyProvisional ? 0 : 1);
    const prospectiveQueuedUpdates =
      queuedUpdates -
      (existing?.queue.length ?? 0) +
      (provisionalAdmissions.size - (alreadyProvisional ? 1 : 0)) +
      1;
    return (
      prospectiveSpectators <= allowedSpectators(signal) &&
      prospectiveQueuedUpdates <= globalQueueLimit
    );
  }

  function recordCapacityRejection(signal: NonNullable<ReturnType<typeof controllerSignal>>) {
    rejectedAdmission += 1;
    protectedAdmissionRejects +=
      signal.availableForSpectators < maxSpectators &&
      allowedSpectators(signal) <= clients.size + provisionalAdmissions.size
        ? 1
        : 0;
  }

  function measureUpdateBytes(update: SpectatorQueuedUpdate<TPayload>): number {
    try {
      const measured = options.adapter.measureQueuedOutputBytes(update);
      return Number.isFinite(measured) && measured >= 0 ? measured : Number.POSITIVE_INFINITY;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  function disconnect(clientId: string, reason: SpectatorDisconnectReason): boolean {
    const client = clients.get(clientId);
    if (client === undefined) return false;
    clients.delete(clientId);
    queuedUpdates -= client.queue.length;
    queuedBytes -= client.queuedBytes;
    if (reason === "slow-reader") slowReaderDisconnects += 1;
    options.adapter.close(clientId, reason);
    return true;
  }

  function enqueue(clientId: string, update: SpectatorQueuedUpdate<TPayload>): boolean {
    const client = clients.get(clientId);
    if (client === undefined) return false;
    const updateBytes = measureUpdateBytes(update);
    if (!Number.isFinite(updateBytes) || updateBytes < 0) {
      disconnect(clientId, "slow-reader");
      return false;
    }
    if (update.replaceableKey !== null) {
      let latestBarrierIndex = -1;
      for (let index = 0; index < client.queue.length; index += 1) {
        if (client.queue[index]?.replaceableKey === null) latestBarrierIndex = index;
      }
      const existingIndex = client.queue.findIndex(
        (queued, index) =>
          index > latestBarrierIndex && queued.replaceableKey === update.replaceableKey,
      );
      if (existingIndex >= 0) {
        const previous = client.queue[existingIndex];
        if (previous === undefined) return false;
        const previousBytes = measureUpdateBytes(previous);
        const nextQueuedBytes = client.queuedBytes - previousBytes + updateBytes;
        if (!Number.isFinite(previousBytes) || nextQueuedBytes > perClientQueuedOutputBytes) {
          disconnect(clientId, "slow-reader");
          return false;
        }
        client.queue[existingIndex] = update;
        queuedBytes += nextQueuedBytes - client.queuedBytes;
        client.queuedBytes = nextQueuedBytes;
        coalescedUpdates += 1;
        if (client.queue.length > perClientQueueLimit || queuedUpdates > globalQueueLimit) {
          disconnect(clientId, "slow-reader");
          return false;
        }
        return true;
      }
    }

    if (
      client.queue.length >= perClientQueueLimit ||
      queuedUpdates >= globalQueueLimit ||
      client.queuedBytes + updateBytes > perClientQueuedOutputBytes
    ) {
      disconnect(clientId, "slow-reader");
      return false;
    }
    client.queue.push(update);
    client.queuedBytes += updateBytes;
    queuedUpdates += 1;
    queuedBytes += updateBytes;
    return true;
  }

  async function drain(clientId: string, limit = Number.POSITIVE_INFINITY): Promise<number> {
    const client = clients.get(clientId);
    if (client === undefined) return 0;
    let written = 0;
    while (written < limit) {
      const update = client.queue[0];
      if (update === undefined) break;
      let accepted = false;
      try {
        accepted = await options.adapter.write(clientId, update);
      } catch {
        accepted = false;
      }
      if (!accepted) {
        disconnect(clientId, "slow-reader");
        break;
      }
      client.queue.shift();
      queuedUpdates -= 1;
      const updateBytes = measureUpdateBytes(update);
      client.queuedBytes -= updateBytes;
      queuedBytes -= updateBytes;
      written += 1;
    }
    return written;
  }

  return {
    async admit(input): Promise<SpectatorAdmissionResult> {
      const initialSignal = controllerSignal();
      if (initialSignal === null) {
        return { status: "unavailable", message: GENERIC_UNAVAILABLE_MESSAGE };
      }
      reconcileControllerCapacityInternal(initialSignal);
      if (!canAdmit(initialSignal, input.clientId)) {
        recordCapacityRejection(initialSignal);
        return {
          status: "rejected",
          reason: "capacity",
          message: "Spectator capacity is currently full; try again later.",
        };
      }

      if (provisionalAdmissions.has(input.clientId)) {
        recordCapacityRejection(initialSignal);
        return {
          status: "rejected",
          reason: "capacity",
          message: "Spectator capacity is currently full; try again later.",
        };
      }
      const provisional = !clients.has(input.clientId);
      if (provisional) provisionalAdmissions.add(input.clientId);
      try {
        const result = await options.adapter.readCurrentVersion({ eventId: input.eventId });
        if (result.status !== "available")
          return { status: "unavailable", message: GENERIC_UNAVAILABLE_MESSAGE };
        const current = result.current;

        const finalSignal = controllerSignal();
        if (finalSignal === null) {
          return { status: "unavailable", message: GENERIC_UNAVAILABLE_MESSAGE };
        }
        reconcileControllerCapacityInternal(finalSignal);
        if (!clients.has(input.clientId) && !provisionalAdmissions.has(input.clientId)) {
          if (!canAdmit(finalSignal, input.clientId)) {
            recordCapacityRejection(finalSignal);
            return {
              status: "rejected",
              reason: "capacity",
              message: "Spectator capacity is currently full; try again later.",
            };
          }
          provisionalAdmissions.add(input.clientId);
        }
        if (!canAdmit(finalSignal, input.clientId)) {
          recordCapacityRejection(finalSignal);
          return {
            status: "rejected",
            reason: "capacity",
            message: "Spectator capacity is currently full; try again later.",
          };
        }

        if (clients.has(input.clientId)) disconnect(input.clientId, "client-reconnect");
        clients.set(input.clientId, {
          eventId: input.eventId,
          queue: [],
          queuedBytes: 0,
          admittedSequence: admissionSequence++,
        });
        provisionalAdmissions.delete(input.clientId);
        const queued = enqueue(input.clientId, {
          eventId: input.eventId,
          version: current.version,
          payload: current.payload,
          replaceableKey: "projection",
        });
        if (!queued) {
          return {
            status: "rejected",
            reason: "output-limit",
            message: OUTPUT_LIMIT_MESSAGE,
          };
        }
        return {
          status: "admitted",
          currentVersion: current.version,
          currentVersionWasAlreadyKnown: input.lastSeenVersion === current.version,
        };
      } catch {
        return { status: "unavailable", message: GENERIC_UNAVAILABLE_MESSAGE };
      } finally {
        provisionalAdmissions.delete(input.clientId);
      }
    },
    publish(input): SpectatorPublishResult {
      const signal = controllerSignal();
      if (signal === null) return { queued: 0, coalesced: 0, disconnected: 0 };
      reconcileControllerCapacityInternal(signal);
      let queued = 0;
      let coalesced = 0;
      let disconnected = 0;
      for (const clientId of clients.keys()) {
        const client = clients.get(clientId);
        if (client?.eventId !== input.eventId) continue;
        const before = coalescedUpdates;
        if (
          enqueue(clientId, {
            eventId: input.eventId,
            version: input.version,
            payload: input.payload,
            replaceableKey: input.replaceableKey,
          })
        ) {
          queued += 1;
          coalesced += coalescedUpdates - before;
        } else {
          disconnected += 1;
        }
      }
      return { queued, coalesced, disconnected };
    },
    /** Call after authoritative Controller admission or session reconciliation. */
    reconcileControllerCapacity() {
      const signal = controllerSignal();
      if (signal === null) {
        return { status: "unavailable", message: GENERIC_UNAVAILABLE_MESSAGE };
      }
      return {
        status: "reconciled",
        activeControllerSessions: signal.activeControllerSessions,
        availableForSpectators: signal.availableForSpectators,
        disconnected: reconcileControllerCapacityInternal(signal),
      };
    },
    drain,
    disconnect(clientId, reason = "client-closed") {
      return disconnect(clientId, reason);
    },
    getQueueState(clientId): SpectatorQueueState | null {
      const client = clients.get(clientId);
      if (client === undefined) return null;
      return {
        queuedUpdates: client.queue.length,
        queuedBytes: client.queuedBytes,
        queuedVersions: client.queue.map((update) => update.version),
      };
    },
    getMetrics(): SpectatorCapacityMetrics {
      const signal = controllerSignal();
      const safeSignal = signal ?? {
        totalConnections: positiveLimit(options.controllerCapacity.totalConnections, 1),
        reservedConnections: boundedLimit(
          options.controllerCapacity.reservedConnections,
          0,
          positiveLimit(options.controllerCapacity.totalConnections, 1),
        ),
        activeControllerSessions: 0,
        availableForSpectators: 0,
      };
      return {
        activeSpectators: clients.size,
        rejectedAdmission,
        coalescedUpdates,
        slowReaderDisconnects,
        queuedClients: [...clients.values()].filter((client) => client.queue.length > 0).length,
        queuedUpdates,
        queuedBytes,
        controllerImpactGuardrail: {
          ...safeSignal,
          protectedAdmissionRejects,
          reserveBreachesObserved,
        },
      };
    },
  };
}

export type SpectatorCapacity<TPayload> = {
  admit(input: SpectatorAdmissionInput): Promise<SpectatorAdmissionResult>;
  publish(input: SpectatorPublishInput<TPayload>): SpectatorPublishResult;
  reconcileControllerCapacity():
    | {
        status: "reconciled";
        activeControllerSessions: number;
        availableForSpectators: number;
        disconnected: number;
      }
    | { status: "unavailable"; message: "Spectator experience is currently unavailable." };
  drain(clientId: string, limit?: number): Promise<number>;
  disconnect(clientId: string, reason?: SpectatorDisconnectReason): boolean;
  getQueueState(clientId: string): SpectatorQueueState | null;
  getMetrics(): SpectatorCapacityMetrics;
};

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

function boundedLimit(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}
