import {
  CONTROL_AUDIT_VERSION,
  CONTROL_ACTION_VERSION,
  LEGACY_CONTROL_ACTION_VERSION,
  LEGACY_CONTROL_AUDIT_VERSION,
  CONTROL_ACTION_ORDERING_VERSION,
  actionIdentity,
  findConcurrentCorrectionConflicts,
  findConcurrentTeamAssignmentConflicts,
  isCausallyRelated,
  prepareControlAction,
  sha256,
  type ControlAction,
  type ControlActionCodecRegistry,
  type ControlActionInput,
  type ControlActionInterpretation,
  type ControlAuditEntry,
  type PreparedControlAction,
} from "@/lib/event-game-actions";
import { canonicalizeJson } from "@/lib/event-game-action-json";
import { projectControlAuditEntryForConvergence } from "@/lib/event-game-convergence";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import {
  FoundationStorageConstraintError,
  type FoundationStorageSnapshot,
  type FoundationStorageTransaction,
  type StoredControlAction,
  type StoredControlAuditEntry,
  type StoredControlIdempotencyEntry,
} from "@/lib/foundation-storage";
import { DURABLE_EVIDENCE_PROVENANCE } from "@/lib/foundation-storage";
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
  entries: readonly StoredControlAuditEntry[],
  registry: ControlActionCodecRegistry,
): string | null {
  const actionsByOperationId = new Map(
    actions.map((stored) => [stored.action.operationId, stored.action]),
  );
  const storedActionsByOperationId = new Map(
    actions.map((stored) => [stored.action.operationId, stored]),
  );
  const contentFingerprintsByOperationId = new Map(
    actions.map((stored) => [stored.action.operationId, stored.contentFingerprint]),
  );
  const actionOperationIds = new Set(actionsByOperationId.keys());
  const acceptedOperationIds = new Set<string>();
  for (const entry of entries) {
    if (entry.recordId !== root.recordId || entry.eventGameId !== root.eventGameId) {
      return "Control Audit Trail entry references another Event Game Record.";
    }
    const validOutcome =
      entry.kind === "action-accepted" || entry.kind === "action-duplicate"
        ? entry.outcome === "accepted"
        : entry.kind === "action-conflict"
          ? entry.outcome === "rejected" || entry.outcome === "conflict-resolved"
          : entry.outcome === "rejected";
    if (!validOutcome) {
      return "Control Audit Trail entry outcome is inconsistent.";
    }
    if (
      entry.auditVersion !== "control-audit-v1" &&
      entry.auditVersion !== "control-audit-legacy-v0"
    ) {
      return "Control Audit Trail version is unsupported.";
    }
    if (
      (entry[DURABLE_EVIDENCE_PROVENANCE] === "current" &&
        entry.auditVersion !== CONTROL_AUDIT_VERSION) ||
      (entry[DURABLE_EVIDENCE_PROVENANCE] === "legacy" &&
        entry.auditVersion !== LEGACY_CONTROL_AUDIT_VERSION)
    ) {
      return "Control Audit Trail durable format marker is inconsistent.";
    }
    if (entry.auditVersion === "control-audit-legacy-v0") {
      if (entry.kind === "action-accepted") {
        const action =
          entry.operationId === null ? undefined : actionsByOperationId.get(entry.operationId);
        const storedAction =
          entry.operationId === null
            ? undefined
            : storedActionsByOperationId.get(entry.operationId);
        if (
          entry.operationId === null ||
          action === undefined ||
          storedAction?.[DURABLE_EVIDENCE_PROVENANCE] === "current" ||
          action.controlActionVersion !== LEGACY_CONTROL_ACTION_VERSION ||
          entry.auditId !== acceptedAuditId(action) ||
          entry.redactedDetail !== ACCEPTED_AUDIT_DETAIL ||
          !acceptedOperationIds.add(entry.operationId)
        ) {
          return "Legacy Control Audit accepted-action evidence is inconsistent.";
        }
      }
      continue;
    }
    if (entry.lockedReplay !== undefined) {
      if (
        entry.redactedDetail !== undefined ||
        entry.links !== undefined ||
        entry.provenance !== undefined ||
        entry.kind !== "action-rejected" ||
        entry.operationId !== null ||
        entry.outcome !== "rejected" ||
        entry.lockedReplay.eventGameId !== root.eventGameId ||
        !Number.isSafeInteger(entry.lockedReplay.count) ||
        entry.lockedReplay.count <= 0 ||
        entry.lockedReplay.originatingSessionId.length === 0 ||
        !Number.isSafeInteger(entry.lockedReplay.rejectedAtMs)
      )
        return "Locked replay discard evidence is inconsistent.";
      continue;
    }
    if (entry.links === undefined || entry.provenance === undefined) {
      return "#75 Control Audit Trail linkage and provenance are mandatory.";
    }
    const linkageFailure = validateAuditLinkage(
      entry,
      root,
      actionsByOperationId,
      contentFingerprintsByOperationId,
      registry,
    );
    if (linkageFailure !== null) return linkageFailure;
    if (entry.kind === "action-accepted") {
      const action =
        entry.operationId === null ? undefined : actionsByOperationId.get(entry.operationId);
      if (
        entry.operationId === null ||
        !actionOperationIds.has(entry.operationId) ||
        action === undefined ||
        entry.auditId !== acceptedAuditId(action) ||
        entry.createdAtMs !== action.acceptedAtMs ||
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
  const conflictEvidenceFailure = validateCompleteConflictEvidence(actions, entries);
  if (conflictEvidenceFailure !== null) return conflictEvidenceFailure;
  return null;
}

function validateCompleteConflictEvidence(
  actions: readonly StoredControlAction[],
  entries: readonly StoredControlAuditEntry[],
): string | null {
  // The legacy format predates durable conflict linkage. Keep that explicit
  // compatibility path intact, but require the complete set once any action
  // has crossed into the current durable format.
  if (!actions.some((stored) => stored[DURABLE_EVIDENCE_PROVENANCE] === "current")) {
    return null;
  }

  const currentConflictAuditIds = new Set(
    entries
      .filter(
        (entry) =>
          entry[DURABLE_EVIDENCE_PROVENANCE] === "current" &&
          entry.kind === "action-conflict" &&
          entry.outcome === "conflict-resolved",
      )
      .map((entry) => entry.auditId),
  );
  const expectedByAuditId = new Map(
    createExpectedConflictAudits(actions, currentConflictAuditIds).map((entry) => [
      entry.auditId,
      entry,
    ]),
  );
  const seenAuditIds = new Set<string>();
  for (const entry of entries) {
    if (
      entry[DURABLE_EVIDENCE_PROVENANCE] !== "current" ||
      entry.kind !== "action-conflict" ||
      entry.outcome !== "conflict-resolved"
    ) {
      continue;
    }
    if (!seenAuditIds.add(entry.auditId)) {
      return "Control Audit Trail contains duplicate conflict evidence.";
    }
    const expected = expectedByAuditId.get(entry.auditId);
    if (expected === undefined) {
      return "Control Audit Trail contains unexpected conflict evidence.";
    }
    if (
      canonicalizeJson(projectStoredAuditEntryForConvergence(entry)) !==
      canonicalizeJson(projectControlAuditEntryForConvergence(expected))
    ) {
      return "Control Audit Trail conflict evidence is not canonical.";
    }
  }
  if (seenAuditIds.size !== expectedByAuditId.size) {
    return "Control Audit Trail is missing canonical conflict evidence.";
  }
  return null;
}

function projectStoredAuditEntryForConvergence(
  entry: StoredControlAuditEntry,
): ReturnType<typeof projectControlAuditEntryForConvergence> {
  const {
    durableFormat: _durableFormat,
    [DURABLE_EVIDENCE_PROVENANCE]: _durableEvidenceProvenance,
    ...auditEntry
  } = entry;
  return projectControlAuditEntryForConvergence(auditEntry);
}

function createExpectedConflictAudits(
  storedActions: readonly StoredControlAction[],
  currentConflictAuditIds: ReadonlySet<string>,
): ControlAuditEntry[] {
  const actions = storedActions.map((stored) => stored.action);
  const actionsByOperationId = new Map(actions.map((action) => [action.operationId, action]));
  const storedActionsByOperationId = new Map(
    storedActions.map((stored) => [stored.action.operationId, stored]),
  );
  const expected: ControlAuditEntry[] = [];
  for (const conflict of findConcurrentCorrectionConflicts(actions)) {
    if (conflict.targetFactId === null) continue;
    const left = actionsByOperationId.get(conflict.operationIds[0]);
    const right = actionsByOperationId.get(conflict.operationIds[1]);
    if (left === undefined || right === undefined) continue;
    const auditId = createConflictAuditEntry(
      left,
      right,
      conflict.targetFactId,
      conflict.winnerOperationId,
      0,
    ).auditId;
    if (
      !isCurrentStoredAction(storedActionsByOperationId.get(left.operationId)) &&
      !isCurrentStoredAction(storedActionsByOperationId.get(right.operationId)) &&
      !currentConflictAuditIds.has(auditId)
    ) {
      continue;
    }
    expected.push(
      createConflictAuditEntry(left, right, conflict.targetFactId, conflict.winnerOperationId, 0),
    );
  }
  for (const conflict of findConcurrentTeamAssignmentConflicts(actions)) {
    if (conflict.eventTeamId === undefined) continue;
    const left = actionsByOperationId.get(conflict.operationIds[0]);
    const right = actionsByOperationId.get(conflict.operationIds[1]);
    if (left === undefined || right === undefined) continue;
    const auditId = createTeamAssignmentConflictAuditEntry(
      left,
      right,
      conflict.eventTeamId,
      conflict.winnerOperationId,
      0,
    ).auditId;
    if (
      !isCurrentStoredAction(storedActionsByOperationId.get(left.operationId)) &&
      !isCurrentStoredAction(storedActionsByOperationId.get(right.operationId)) &&
      !currentConflictAuditIds.has(auditId)
    ) {
      continue;
    }
    expected.push(
      createTeamAssignmentConflictAuditEntry(
        left,
        right,
        conflict.eventTeamId,
        conflict.winnerOperationId,
        0,
      ),
    );
  }
  return expected;
}

function isCurrentStoredAction(stored: StoredControlAction | undefined): boolean {
  return stored?.[DURABLE_EVIDENCE_PROVENANCE] === "current";
}

function validateAuditLinkage(
  entry: ControlAuditEntry,
  root: EventGameRecordRoot,
  actionsByOperationId: ReadonlyMap<string, ControlAction>,
  contentFingerprintsByOperationId: ReadonlyMap<string, string>,
  registry: ControlActionCodecRegistry,
): string | null {
  if (entry.lockedReplay !== undefined) {
    if (
      entry.redactedDetail !== undefined ||
      entry.links !== undefined ||
      entry.provenance !== undefined ||
      entry.kind !== "action-rejected" ||
      entry.operationId !== null ||
      entry.outcome !== "rejected" ||
      entry.lockedReplay.eventGameId !== root.eventGameId ||
      entry.lockedReplay.count <= 0 ||
      entry.lockedReplay.originatingSessionId.length === 0 ||
      !Number.isSafeInteger(entry.lockedReplay.rejectedAtMs)
    )
      return "Locked replay discard evidence is inconsistent.";
    return null;
  }
  const links = entry.links;
  const provenance = entry.provenance;
  if (links === undefined || provenance === undefined) {
    return "Control Audit Trail evidence is missing.";
  }
  if (links.ordering === null) return "Control Audit Trail ordering linkage is missing.";
  if (
    entry.operationId !== null &&
    links.actionId !== actionIdentity(root.recordId, entry.operationId)
  ) {
    return "Control Audit Trail operation linkage is inconsistent.";
  }
  if (links.ordering.operationId.length === 0) {
    return "Control Audit Trail ordering linkage is invalid.";
  }
  const orderedAction = actionsByOperationId.get(links.ordering.operationId);
  if (orderedAction !== undefined) {
    if (
      (orderedAction.controlActionVersion === CONTROL_ACTION_VERSION) !==
      (entry.auditVersion === CONTROL_AUDIT_VERSION)
    ) {
      return "Control Audit Trail and action compatibility versions are inconsistent.";
    }
    if (links.actionId !== actionIdentity(root.recordId, orderedAction.operationId)) {
      return "Control Audit Trail action linkage is inconsistent.";
    }
    if (links.ordering.trustedAtMs !== orderedAction.occurrence.trustedAtMs) {
      return "Control Audit Trail ordering evidence is inconsistent.";
    }
    if (
      canonicalizeJson(links.causalPredecessorIds) !==
      canonicalizeJson(orderedAction.causalPredecessorIds)
    ) {
      return "Control Audit Trail causal predecessor evidence is inconsistent.";
    }
    const expectedTargetFactId =
      orderedAction.interpretation.type === "correction"
        ? orderedAction.interpretation.targetFactId
        : null;
    if (links.targetFactId !== expectedTargetFactId) {
      return "Control Audit Trail target linkage is inconsistent.";
    }
    if (canonicalizeJson(provenance) !== canonicalizeJson(actionProvenance(orderedAction))) {
      return "Control Audit Trail provenance is inconsistent.";
    }
  } else if (entry.kind === "action-accepted" || entry.outcome === "conflict-resolved") {
    return "Control Audit Trail references a missing accepted action.";
  }

  const collision = links.collision;
  if (collision !== undefined) {
    if (entry.kind !== "action-conflict" || entry.outcome !== "rejected") {
      return "Control Audit Trail collision evidence is attached to the wrong outcome.";
    }
    const acceptedAction = actionsByOperationId.get(collision.acceptedOperationId);
    const acceptedFingerprint = contentFingerprintsByOperationId.get(collision.acceptedOperationId);
    const rejected = collision.rejectedAttempt;
    const preparedRejected = prepareControlAction(
      rejected.input,
      { ...root, lifecycle: rejected.input.lifecycle },
      registry,
      rejected.input.occurrence.trustedAtMs,
    );
    if (
      !preparedRejected.ok ||
      acceptedAction === undefined ||
      acceptedFingerprint === undefined ||
      collision.acceptedOperationId !== links.ordering.operationId ||
      collision.acceptedActionId !==
        actionIdentity(acceptedAction.recordId, acceptedAction.operationId) ||
      links.actionId !== collision.acceptedActionId ||
      acceptedFingerprint !== collision.acceptedContentFingerprint ||
      entry.operationId === null ||
      entry.operationId !== rejected.input.operationId ||
      rejected.input.recordId !== root.recordId ||
      rejected.input.eventGameId !== root.eventGameId ||
      rejected.contentFingerprint === acceptedFingerprint ||
      preparedRejected.value.canonicalContent !== rejected.canonicalContent ||
      preparedRejected.value.contentFingerprint !== rejected.contentFingerprint ||
      canonicalizeJson(preparedRejected.value.interpretation) !==
        canonicalizeJson(rejected.interpretation) ||
      links.relatedOperationIds.length !== 0 ||
      links.targetFactId !==
        (acceptedAction.interpretation.type === "correction"
          ? acceptedAction.interpretation.targetFactId
          : null) ||
      canonicalizeJson(links.causalPredecessorIds) !==
        canonicalizeJson(acceptedAction.causalPredecessorIds) ||
      canonicalizeJson(provenance) !== canonicalizeJson(actionProvenance(acceptedAction)) ||
      entry.redactedDetail !== "operation identity is already bound to different content" ||
      entry.auditId !==
        `audit-${sha256(`${root.recordId}:operation-conflict:${entry.operationId}:${rejected.contentFingerprint}`)}`
    ) {
      return "Control Audit Trail collision evidence is inconsistent.";
    }
  } else if (entry.kind === "action-conflict" && entry.outcome === "rejected") {
    return "Control Audit Trail collision evidence is missing.";
  }

  if (entry.operationId !== null && collision === undefined) {
    const action = actionsByOperationId.get(entry.operationId);
    if (action !== undefined) {
      const targetFactId =
        action.interpretation.type === "correction"
          ? action.interpretation.targetFactId
          : undefined;
      const targetAction =
        targetFactId === undefined
          ? undefined
          : [...actionsByOperationId.values()].find(
              (candidate) =>
                candidate.interpretation.type === "fact" &&
                candidate.interpretation.factId === targetFactId,
            );
      const expectedRelated = targetAction === undefined ? [] : [targetAction.operationId];
      if (canonicalizeJson(links.relatedOperationIds) !== canonicalizeJson(expectedRelated)) {
        return "Control Audit Trail related operation evidence is inconsistent.";
      }
    }
  }

  for (const relatedOperationId of links.relatedOperationIds) {
    if (!actionsByOperationId.has(relatedOperationId)) {
      return "Control Audit Trail related operation is missing.";
    }
  }
  if (entry.outcome === "conflict-resolved") {
    if (entry.operationId !== null || links.relatedOperationIds.length !== 2) {
      return "Control Audit Trail conflict linkage is inconsistent.";
    }
    const relatedActions = links.relatedOperationIds.map((operationId) =>
      actionsByOperationId.get(operationId),
    );
    const teamActions = relatedActions.filter(
      (action): action is ControlAction =>
        action?.interpretation.type === "team-assignment-correction",
    );
    const left = teamActions[0];
    const right = teamActions[1];
    const leftInterpretation = left?.interpretation;
    const rightInterpretation = right?.interpretation;
    if (
      leftInterpretation?.type === "team-assignment-correction" &&
      rightInterpretation?.type === "team-assignment-correction"
    ) {
      const expectedConflict = findConcurrentTeamAssignmentConflicts([
        ...actionsByOperationId.values(),
      ]).find(
        (conflict) =>
          conflict.eventTeamId === leftInterpretation.eventTeamId &&
          canonicalizeJson([...conflict.operationIds].sort()) ===
            canonicalizeJson(links.relatedOperationIds),
      );
      if (
        leftInterpretation.eventTeamId !== rightInterpretation.eventTeamId ||
        leftInterpretation.gameSideId === rightInterpretation.gameSideId ||
        links.targetFactId !== null ||
        expectedConflict === undefined ||
        expectedConflict.winnerOperationId !== links.ordering.operationId ||
        entry.redactedDetail !==
          `Opposing Concurrent Team Assignments resolved for ${leftInterpretation.eventTeamId}; winner ${expectedConflict.winnerOperationId}` ||
        entry.auditId !==
          `audit-${sha256(`${root.recordId}:concurrent-team-assignment:${leftInterpretation.eventTeamId}:${[left!.operationId, right!.operationId].sort().join(":")}:${expectedConflict.winnerOperationId}`)}`
      ) {
        return "Control Audit Trail team conflict linkage is inconsistent.";
      }
      return null;
    }
    if (
      relatedActions.some(
        (action) => action === undefined || action.interpretation.type !== "correction",
      ) ||
      !links.relatedOperationIds.includes(links.ordering.operationId)
    ) {
      return "Control Audit Trail conflict linkage is inconsistent.";
    }
    const corrections = relatedActions as [ControlAction, ControlAction];
    const expectedConflict = findConcurrentCorrectionConflicts([
      ...actionsByOperationId.values(),
    ]).find(
      (conflict) =>
        conflict.targetFactId === links.targetFactId &&
        canonicalizeJson([...conflict.operationIds].sort()) ===
          canonicalizeJson(links.relatedOperationIds),
    );
    const hasTargetFact = [...actionsByOperationId.values()].some(
      (action) =>
        action.interpretation.type === "fact" &&
        action.interpretation.factId === links.targetFactId,
    );
    if (
      corrections[0].interpretation.type !== "correction" ||
      corrections[1].interpretation.type !== "correction" ||
      corrections[0].interpretation.targetFactId !== links.targetFactId ||
      corrections[1].interpretation.targetFactId !== links.targetFactId ||
      corrections[0].interpretation.effective === corrections[1].interpretation.effective ||
      isCausallyRelated(corrections[0], corrections[1], actionsByOperationId) ||
      !hasTargetFact ||
      expectedConflict === undefined ||
      expectedConflict.winnerOperationId !== links.ordering.operationId ||
      entry.redactedDetail !==
        `Opposing Concurrent Corrections resolved for ${links.targetFactId}; winner ${expectedConflict.winnerOperationId}` ||
      entry.auditId !==
        `audit-${sha256(`${root.recordId}:concurrent-correction:${links.targetFactId}:${links.relatedOperationIds.join(":")}:${expectedConflict.winnerOperationId}`)}`
    ) {
      return "Control Audit Trail conflict linkage is inconsistent.";
    }
  }
  return null;
}

function actionProvenance(action: ControlAction): Record<string, unknown> {
  return {
    occurrence: action.occurrence,
    grant: action.grant,
    ...(action.origin === undefined ? {} : { origin: action.origin }),
    lifecycle: action.lifecycle,
    override: action.override ?? null,
    recoveryProvenance: action.recoveryProvenance ?? null,
  };
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
  context: {
    interpretation?: ControlActionInterpretation;
    relatedOperationIds?: readonly string[];
    collision?: {
      acceptedAction: ControlAction;
      acceptedContentFingerprint: string;
      rejectedAttempt: PreparedControlAction;
    };
  } = {},
): ControlAuditEntry {
  const targetFactId =
    (context.collision?.acceptedAction.interpretation ?? context.interpretation)?.type ===
    "correction"
      ? (
          (context.collision?.acceptedAction.interpretation ?? context.interpretation) as {
            type: "correction";
            targetFactId: string;
          }
        ).targetFactId
      : null;
  const acceptedAction = context.collision?.acceptedAction;
  const collision = context.collision;
  const rejectedAttempt = context.collision?.rejectedAttempt;
  const provenanceAction = acceptedAction ?? input;
  const auditId =
    acceptedAction !== undefined && rejectedAttempt !== undefined
      ? `audit-${sha256(`${input.recordId}:operation-conflict:${input.operationId}:${rejectedAttempt.contentFingerprint}`)}`
      : `audit-${sha256(`${input.recordId}:${input.operationId}:${kind}:${redactedDetail}:${canonicalizeJson(input.payload)}`)}`;
  return {
    auditVersion: CONTROL_AUDIT_VERSION,
    auditId,
    recordId: input.recordId,
    eventGameId: input.eventGameId,
    operationId: input.operationId,
    kind,
    outcome: kind === "action-accepted" ? "accepted" : "rejected",
    createdAtMs,
    redactedDetail,
    links: {
      actionId: actionIdentity(
        (acceptedAction ?? input).recordId,
        (acceptedAction ?? input).operationId,
      ),
      targetFactId,
      causalPredecessorIds: [
        ...(acceptedAction?.causalPredecessorIds ?? input.causalPredecessorIds),
      ],
      relatedOperationIds: [
        ...(context.collision !== undefined ? [] : (context.relatedOperationIds ?? [])),
      ],
      ordering: {
        trustedAtMs: (acceptedAction ?? input).occurrence.trustedAtMs,
        operationId: (acceptedAction ?? input).operationId,
      },
      ...(acceptedAction !== undefined && rejectedAttempt !== undefined && collision !== undefined
        ? {
            collision: {
              acceptedActionId: actionIdentity(acceptedAction.recordId, acceptedAction.operationId),
              acceptedOperationId: acceptedAction.operationId,
              acceptedContentFingerprint: collision.acceptedContentFingerprint,
              rejectedAttempt: {
                input: structuredClone(rejectedAttempt.input),
                codecIdentity: rejectedAttempt.codecIdentity,
                codecFingerprint: rejectedAttempt.codecFingerprint,
                canonicalContent: rejectedAttempt.canonicalContent,
                contentFingerprint: rejectedAttempt.contentFingerprint,
                interpretation: structuredClone(rejectedAttempt.interpretation),
              },
            },
          }
        : {}),
    },
    provenance: {
      occurrence: structuredClone(provenanceAction.occurrence),
      grant: structuredClone(provenanceAction.grant),
      ...(provenanceAction.origin === undefined ? {} : { origin: provenanceAction.origin }),
      lifecycle: structuredClone(provenanceAction.lifecycle),
      override:
        provenanceAction.override === undefined ? null : structuredClone(provenanceAction.override),
      recoveryProvenance:
        provenanceAction.recoveryProvenance === undefined
          ? null
          : structuredClone(provenanceAction.recoveryProvenance),
    },
  };
}

export function createConflictAuditEntry(
  left: ControlAction,
  right: ControlAction,
  targetFactId: string,
  winnerOperationId: string,
  createdAtMs: number,
): ControlAuditEntry {
  const operationIds = [left.operationId, right.operationId].sort();
  const winner = winnerOperationId === left.operationId ? left : right;
  const relatedOperationIds = operationIds;
  const detail = `Opposing Concurrent Corrections resolved for ${targetFactId}; winner ${winnerOperationId}`;
  return {
    ...createAuditEntry(winner, "action-conflict", detail, createdAtMs, {
      interpretation: winner.interpretation,
      relatedOperationIds,
    }),
    auditId: `audit-${sha256(`${winner.recordId}:concurrent-correction:${targetFactId}:${operationIds.join(":")}:${winnerOperationId}`)}`,
    operationId: null,
    outcome: "conflict-resolved",
  };
}

export function createTeamAssignmentConflictAuditEntry(
  left: ControlAction,
  right: ControlAction,
  eventTeamId: string,
  winnerOperationId: string,
  createdAtMs: number,
): ControlAuditEntry {
  const operationIds = [left.operationId, right.operationId].sort();
  const winner = winnerOperationId === left.operationId ? left : right;
  const detail = `Opposing Concurrent Team Assignments resolved for ${eventTeamId}; winner ${winnerOperationId}`;
  return {
    ...createAuditEntry(winner, "action-conflict", detail, createdAtMs, {
      interpretation: winner.interpretation,
      relatedOperationIds: operationIds,
    }),
    auditId: `audit-${sha256(`${winner.recordId}:concurrent-team-assignment:${eventTeamId}:${operationIds.join(":")}:${winnerOperationId}`)}`,
    operationId: null,
    outcome: "conflict-resolved",
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
    case "acceptance-budget-id":
    case "replay-reservation-id":
    case "replay-attempt-id":
    case "replay-receipt-id":
    case "replay-receipt-digest":
    case "grant-code-digest":
      return "content-conflict";
  }
  return "content-conflict";
}
