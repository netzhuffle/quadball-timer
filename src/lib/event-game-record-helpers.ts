import {
  CONTROL_ACTION_ORDERING_VERSION,
  actionIdentity,
  sha256,
  type ControlAction,
  type ControlActionInput,
  type ControlAuditEntry,
} from "@/lib/event-game-actions";
import { canonicalizeJson } from "@/lib/event-game-action-json";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import {
  FoundationStorageConstraintError,
  type FoundationStorageSnapshot,
  type FoundationStorageTransaction,
  type StoredControlAction,
  type StoredControlIdempotencyEntry,
} from "@/lib/foundation-storage";
import type {
  ControlActionAcceptanceOutcome,
  RootRegistrationOutcome,
} from "@/lib/event-game-record";

export const ACCEPTED_AUDIT_DETAIL =
  "accepted after atomic action, idempotency, metadata, and audit commit";

export function ensureRecordMetadata(
  transaction: FoundationStorageTransaction,
  root: EventGameRecordRoot,
): void {
  if (transaction.readRecordMetadata(root.recordId) !== null) return;
  transaction.upsertRecordMetadata({
    recordId: root.recordId,
    actionCount: 0,
    orderingVersion: CONTROL_ACTION_ORDERING_VERSION,
    lastAcceptedAtMs: null,
    updatedAtMs: root.creationEvidence.createdAtMs,
  });
}

export function validateAuditHistory(
  root: EventGameRecordRoot,
  actions: readonly StoredControlAction[],
  entries: readonly ControlAuditEntry[],
): string | null {
  const actionsByOperationId = new Map(
    actions.map((stored) => [stored.action.operationId, stored.action]),
  );
  const actionOperationIds = new Set(actionsByOperationId.keys());
  const acceptedOperationIds = new Set<string>();
  for (const entry of entries) {
    if (entry.recordId !== root.recordId || entry.eventGameId !== root.eventGameId) {
      return "Control Audit Trail entry references another Event Game Record.";
    }
    const expectedOutcome =
      entry.kind === "action-accepted" || entry.kind === "action-duplicate"
        ? "accepted"
        : "rejected";
    if (entry.outcome !== expectedOutcome) {
      return "Control Audit Trail entry outcome is inconsistent.";
    }
    if (entry.kind === "action-accepted") {
      const action =
        entry.operationId === null ? undefined : actionsByOperationId.get(entry.operationId);
      if (
        entry.operationId === null ||
        !actionOperationIds.has(entry.operationId) ||
        action === undefined ||
        entry.auditId !== acceptedAuditId(action) ||
        entry.redactedDetail !== ACCEPTED_AUDIT_DETAIL ||
        !acceptedOperationIds.add(entry.operationId)
      ) {
        return "Control Audit Trail accepted-action evidence is inconsistent.";
      }
    }
  }
  if (acceptedOperationIds.size !== actions.length) {
    return "Control Audit Trail is missing accepted-action evidence.";
  }
  return null;
}

export function validateIdempotencyHistory(
  root: EventGameRecordRoot,
  actions: readonly StoredControlAction[],
  entries: readonly StoredControlIdempotencyEntry[],
): string | null {
  if (entries.length !== actions.length) {
    return "Control Action and idempotency histories have different lengths.";
  }
  const actionFingerprints = new Set<string>();
  const entriesByActionId = new Map<string, StoredControlIdempotencyEntry>();
  for (const entry of entries) {
    if (
      entry.recordId !== root.recordId ||
      entry.actionId !== actionIdentity(entry.recordId, entry.operationId) ||
      entriesByActionId.has(entry.actionId)
    ) {
      return "Control Action idempotency evidence is inconsistent.";
    }
    entriesByActionId.set(entry.actionId, entry);
  }
  for (const stored of actions) {
    const { action } = stored;
    if (!actionFingerprints.add(stored.contentFingerprint)) {
      return "Control Action content fingerprints are not unique.";
    }
    const expectedActionId = actionIdentity(action.recordId, action.operationId);
    const entry = entriesByActionId.get(expectedActionId);
    if (
      entry === undefined ||
      entry.recordId !== action.recordId ||
      entry.operationId !== action.operationId ||
      entry.contentFingerprint !== stored.contentFingerprint ||
      entry.acceptedAtMs !== action.acceptedAtMs
    ) {
      return "Control Action idempotency evidence is inconsistent.";
    }
  }
  return null;
}

export function readRecordId(input: unknown): string {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const value = (input as Record<string, unknown>).recordId;
    if (typeof value === "string") return value;
  }
  return "invalid-record-id";
}

export function validateDependencies(
  transaction: FoundationStorageSnapshot,
  input: ControlActionInput,
): Extract<ControlActionAcceptanceOutcome, { status: "rejected" }> | null {
  if (input.causalPredecessorIds.includes(input.operationId)) {
    return {
      status: "rejected",
      reason: "cyclic-dependency",
      detail: "A Control Action cannot depend on itself.",
    };
  }
  for (const predecessorId of input.causalPredecessorIds) {
    if (transaction.findActionByOperationId(input.recordId, predecessorId) === null) {
      return {
        status: "rejected",
        reason: "missing-dependency",
        detail: "A causal predecessor is not retained for this Event Game Record.",
      };
    }
  }
  return null;
}

export function findFactById(
  actions: readonly StoredControlAction[],
  factId: string,
): StoredControlAction | null {
  return (
    actions.find(
      (stored) =>
        stored.action.interpretation.type === "fact" &&
        stored.action.interpretation.factId === factId,
    ) ?? null
  );
}

export function createAuditEntry(
  input: ControlActionInput,
  kind: ControlAuditEntry["kind"],
  redactedDetail: string,
  createdAtMs: number,
): ControlAuditEntry {
  return {
    auditId: `audit-${sha256(`${input.recordId}:${input.operationId}:${kind}:${redactedDetail}:${canonicalizeJson(input.payload)}`)}`,
    recordId: input.recordId,
    eventGameId: input.eventGameId,
    operationId: input.operationId,
    kind,
    outcome: kind === "action-accepted" ? "accepted" : "rejected",
    createdAtMs,
    redactedDetail,
  };
}

export function acceptedAuditId(action: ControlAction): string {
  return `audit-${sha256(`${action.recordId}:${action.operationId}:action-accepted:${ACCEPTED_AUDIT_DETAIL}:${canonicalizeJson(action.payload)}`)}`;
}

export function sameExternalScope(
  left: EventGameRecordRoot["externalScope"],
  right: EventGameRecordRoot["externalScope"],
): boolean {
  return (
    left.eventId === right.eventId &&
    left.gameDayId === right.gameDayId &&
    left.pitchId === right.pitchId &&
    left.pitchSlotId === right.pitchSlotId
  );
}

export function classifyRootConflict(
  existing: EventGameRecordRoot,
  incoming: EventGameRecordRoot,
): Extract<RootRegistrationOutcome, { status: "rejected" }>["reason"] {
  if (
    existing.ownership.eventId !== incoming.ownership.eventId ||
    existing.ownership.eventGameId !== incoming.ownership.eventGameId
  ) {
    return "ownership-conflict";
  }
  if (
    existing.externalScope.eventId !== incoming.externalScope.eventId ||
    existing.externalScope.gameDayId !== incoming.externalScope.gameDayId ||
    existing.externalScope.pitchId !== incoming.externalScope.pitchId ||
    existing.externalScope.pitchSlotId !== incoming.externalScope.pitchSlotId
  ) {
    return "external-scope-conflict";
  }
  return "content-conflict";
}

export function constraintToConflict(
  error: FoundationStorageConstraintError,
): Extract<RootRegistrationOutcome, { status: "rejected" }>["reason"] {
  switch (error.constraint) {
    case "event-game-id":
      return "ownership-conflict";
    case "pitch-slot-id":
      return "external-scope-conflict";
    case "game-side-id":
      return "stable-side-conflict";
    case "record-id":
    case "operation-id":
    case "audit-id":
    case "grant-id":
    case "grant-version":
    case "grant-pitch-slot-id":
    case "grant-credential-digest":
    case "grant-session-id":
    case "grant-session-verifier":
    case "grant-session-context":
    case "grant-audit-id":
      return "content-conflict";
  }
}
