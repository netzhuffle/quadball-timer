import { SHARED_LIMITS, validateOpaqueIdentifier } from "@/lib/validation-policy";

/** The workflow discriminator keeps Ad Hoc replay out of Event authority. */
export const CONTROLLER_WORKFLOW_VERSION = "controller-workflow-v1" as const;
export type ControllerWorkflowKind = "event" | "ad-hoc";

export type ControllerOperationOutcomeStatus =
  | "accepted"
  | "duplicate"
  | "rejected"
  | "causally-blocked";

export type ControllerOperationOutcome = {
  operationId: string;
  workflow: ControllerWorkflowKind;
  status: ControllerOperationOutcomeStatus;
  detail?: string;
};

export type ControllerSynchronizationOperation<T> = {
  operationId: string;
  workflow: ControllerWorkflowKind;
  clientOriginAtMs: number;
  causalPredecessorIds: readonly string[];
  payload: T;
};

export type ControllerReplayValidation =
  | { ok: true; operations: readonly ControllerSynchronizationOperation<unknown>[] }
  | { ok: false; error: string };

export type ControllerBatchResolution<T> = {
  ordered: readonly ControllerSynchronizationOperation<T>[];
  statuses: ReadonlyMap<string, "accepted" | "rejected" | "causally-blocked">;
  details: ReadonlyMap<string, string>;
};

export type ControllerTopologyResult<T> = {
  ordered: readonly ControllerSynchronizationOperation<T>[];
  missingOperationIds: readonly string[];
  cyclicOperationIds: readonly string[];
};

export type ControllerReplayAcknowledgement = {
  workflow: ControllerWorkflowKind;
  acknowledgedOperationIds: readonly string[];
  outcomes: readonly ControllerOperationOutcome[];
};

export function createControllerReplayAcknowledgement(input: {
  workflow: ControllerWorkflowKind;
  acknowledgedOperationIds: readonly string[];
  outcomes: readonly ControllerOperationOutcome[];
}): ControllerReplayAcknowledgement {
  const ids = new Set<string>();
  for (const operationId of input.acknowledgedOperationIds) {
    if (!validateOpaqueIdentifier(operationId, "operationId").ok || ids.has(operationId))
      throw new Error("Controller acknowledgement identities are invalid.");
    ids.add(operationId);
  }
  for (const outcome of input.outcomes) {
    if (outcome.workflow !== input.workflow || !ids.has(outcome.operationId))
      throw new Error("Controller acknowledgement workflow is invalid.");
  }
  return {
    workflow: input.workflow,
    acknowledgedOperationIds: [...input.acknowledgedOperationIds],
    outcomes: structuredClone(input.outcomes),
  };
}

export function projectControllerReplayRetry<T extends { status: string }>(
  operations: readonly T[],
  retryableStatuses: ReadonlySet<string>,
): readonly T[] {
  return operations.filter((operation) => retryableStatuses.has(operation.status));
}

/**
 * Validate the transport-shaped part of a replay before a store mutation. The
 * operation payload is intentionally left to the owning deep module.
 */
export function validateControllerReplay(
  value: unknown,
  workflow: ControllerWorkflowKind,
): ControllerReplayValidation {
  if (!Array.isArray(value)) return { ok: false, error: "Replay operations must be an array." };
  if (value.length === 0) return { ok: false, error: "Replay operations must not be empty." };
  if (value.length > SHARED_LIMITS.replay.maxControlActions) {
    return { ok: false, error: "Replay operations exceed the configured limit." };
  }

  const operationIds = new Set<string>();
  const operations: ControllerSynchronizationOperation<unknown>[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return { ok: false, error: "Replay operation must be an object." };
    const operationId = validateOpaqueIdentifier(
      candidate.id ?? candidate.operationId,
      "operationId",
    );
    if (!operationId.ok) return { ok: false, error: operationId.error };
    if (operationIds.has(operationId.value)) {
      return { ok: false, error: "Replay operation identities must be unique." };
    }
    operationIds.add(operationId.value);
    if (
      typeof candidate.clientSentAtMs !== "number" ||
      !Number.isSafeInteger(candidate.clientSentAtMs) ||
      candidate.clientSentAtMs < 0
    ) {
      return { ok: false, error: "Replay operation timestamp is invalid." };
    }
    if (candidate.workflow !== undefined && candidate.workflow !== workflow) {
      return { ok: false, error: "Replay workflow does not match the subscribed Controller." };
    }
    const predecessors = candidate.causalPredecessorIds ?? [];
    if (
      !Array.isArray(predecessors) ||
      predecessors.length > SHARED_LIMITS.replay.maxControlActions ||
      predecessors.some(
        (predecessor) => !validateOpaqueIdentifier(predecessor, "causalPredecessorId").ok,
      ) ||
      new Set(predecessors).size !== predecessors.length ||
      predecessors.includes(operationId.value)
    ) {
      return { ok: false, error: "Replay causal predecessors are invalid." };
    }
    operations.push({
      operationId: operationId.value,
      workflow,
      clientOriginAtMs: candidate.clientSentAtMs,
      causalPredecessorIds: [...predecessors],
      payload: candidate.command ?? candidate.intent,
    });
  }
  const externalPredecessors = new Set(
    operations.flatMap((operation) =>
      operation.causalPredecessorIds.filter((predecessor) => !operationIds.has(predecessor)),
    ),
  );
  const topology = topologicallyOrderControllerOperations(operations, {
    knownOperationIds: externalPredecessors,
  });
  if (topology.cyclicOperationIds.length > 0) {
    return { ok: false, error: "Replay causal predecessors contain a cycle." };
  }
  return { ok: true, operations };
}

/**
 * Resolve a complete incoming batch against retained workflow state. The
 * caller supplies retained statuses; the incoming transport order is never
 * used as causal order.
 */
export function resolveControllerBatch<T>(input: {
  operations: readonly ControllerSynchronizationOperation<T>[];
  retainedStatuses: ReadonlyMap<string, "accepted" | "rejected" | "causally-blocked">;
}): ControllerBatchResolution<T> {
  const statuses = new Map<string, "accepted" | "rejected" | "causally-blocked">();
  const details = new Map<string, string>();
  const byId = new Map(input.operations.map((operation) => [operation.operationId, operation]));
  for (const operation of input.operations) {
    const predecessors = new Set(operation.causalPredecessorIds);
    if (predecessors.has(operation.operationId)) {
      statuses.set(operation.operationId, "rejected");
      details.set(operation.operationId, "Causal cycle.");
    }
    if (
      [...predecessors].some(
        (predecessor) => !byId.has(predecessor) && !input.retainedStatuses.has(predecessor),
      )
    ) {
      statuses.set(operation.operationId, "rejected");
      details.set(operation.operationId, "Causal predecessor is not retained.");
    }
  }
  const topology = topologicallyOrderControllerOperations(input.operations, {
    knownOperationIds: new Set(input.retainedStatuses.keys()),
    excludedOperationIds: new Set(statuses.keys()),
  });
  for (const operationId of topology.cyclicOperationIds) {
    statuses.set(operationId, "rejected");
    details.set(operationId, "Causal cycle.");
  }
  for (const operation of topology.ordered) {
    if (statuses.has(operation.operationId)) continue;
    const blocked = operation.causalPredecessorIds.find((predecessor) => {
      const incomingStatus = statuses.get(predecessor);
      const retainedStatus = input.retainedStatuses.get(predecessor);
      return (
        incomingStatus === "rejected" ||
        incomingStatus === "causally-blocked" ||
        (incomingStatus === undefined && retainedStatus !== "accepted")
      );
    });
    if (blocked !== undefined) {
      statuses.set(operation.operationId, "causally-blocked");
      details.set(operation.operationId, "Causal predecessor was rejected.");
    } else {
      statuses.set(operation.operationId, "accepted");
    }
  }
  return { ordered: topology.ordered, statuses, details };
}

/** One deterministic Kahn traversal shared by Event and Ad Hoc policy layers. */
export function topologicallyOrderControllerOperations<T>(
  operations: readonly ControllerSynchronizationOperation<T>[],
  options: {
    knownOperationIds?: ReadonlySet<string>;
    excludedOperationIds?: ReadonlySet<string>;
  } = {},
): ControllerTopologyResult<T> {
  const knownOperationIds = options.knownOperationIds ?? new Set<string>();
  const excludedOperationIds = options.excludedOperationIds ?? new Set<string>();
  const byId = new Map(operations.map((operation) => [operation.operationId, operation]));
  const missingOperationIds = operations
    .filter(
      (operation) =>
        !excludedOperationIds.has(operation.operationId) &&
        operation.causalPredecessorIds.some(
          (predecessor) => !byId.has(predecessor) && !knownOperationIds.has(predecessor),
        ),
    )
    .map((operation) => operation.operationId);
  const failed = new Set([...excludedOperationIds, ...missingOperationIds]);
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const operation of operations) {
    if (failed.has(operation.operationId)) continue;
    let count = 0;
    for (const predecessor of new Set(operation.causalPredecessorIds)) {
      if (!byId.has(predecessor) || failed.has(predecessor)) continue;
      count += 1;
      dependents.set(predecessor, [...(dependents.get(predecessor) ?? []), operation.operationId]);
    }
    indegree.set(operation.operationId, count);
  }
  const ready = operations
    .filter(
      (operation) =>
        !failed.has(operation.operationId) && indegree.get(operation.operationId) === 0,
    )
    .sort(compareControllerOperations);
  const ordered: ControllerSynchronizationOperation<T>[] = [];
  while (ready.length > 0) {
    const operation = ready.shift();
    if (operation === undefined) break;
    ordered.push(operation);
    for (const dependentId of dependents.get(operation.operationId) ?? []) {
      const remaining = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, remaining);
      if (remaining === 0) {
        const dependent = byId.get(dependentId);
        if (dependent !== undefined) ready.push(dependent);
        ready.sort(compareControllerOperations);
      }
    }
  }
  const orderedIds = new Set(ordered.map((operation) => operation.operationId));
  return {
    ordered,
    missingOperationIds,
    cyclicOperationIds: operations
      .filter(
        (operation) => !failed.has(operation.operationId) && !orderedIds.has(operation.operationId),
      )
      .map((operation) => operation.operationId),
  };
}

/**
 * Return a deterministic causal order. Independent operations are ordered by
 * their content-bound origin timestamp and opaque identity, so two relays
 * receiving the same accepted set rebuild the same current state.
 */
export function orderControllerOperations<T>(
  operations: readonly ControllerSynchronizationOperation<T>[],
):
  | { ok: true; operations: readonly ControllerSynchronizationOperation<T>[] }
  | { ok: false; operationIds: readonly string[]; error: string } {
  const topology = topologicallyOrderControllerOperations(operations);
  if (topology.missingOperationIds.length > 0) {
    return {
      ok: false,
      operationIds: topology.missingOperationIds,
      error: "Causal predecessor is not retained.",
    };
  }
  if (topology.cyclicOperationIds.length > 0) {
    return {
      ok: false,
      operationIds: topology.cyclicOperationIds,
      error: "Causal cycle.",
    };
  }
  return { ok: true, operations: topology.ordered };
}

function compareControllerOperations<T>(
  left: ControllerSynchronizationOperation<T>,
  right: ControllerSynchronizationOperation<T>,
) {
  return (
    left.clientOriginAtMs - right.clientOriginAtMs ||
    left.operationId.localeCompare(right.operationId)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
