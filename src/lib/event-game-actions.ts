import type { ValidationResult } from "@/lib/validation-policy";
import type { EventGameLifecyclePhase, EventGameRecordRoot } from "@/lib/foundation-record-types";
import type { IqaSportingRules } from "@/lib/iqa-game-rules";
import { canonicalizeJson, sha256 } from "@/lib/event-game-action-json";
import {
  invalid,
  isRecord,
  sameLifecycle,
  validateGrant,
  validateInterpretation,
  validateId,
  validateKind,
  validateLifecycle,
  validateOccurrence,
  validateOverride,
  validatePredecessors,
  validateRecoveryProvenance,
  validateRecoveryProvenanceShape,
  validateStoredInput,
  validateTimestamp,
  valid,
} from "@/lib/event-game-action-codecs";
import { DURABLE_EVIDENCE_PROVENANCE } from "@/lib/foundation-storage";

export { canonicalizeJson, sha256 } from "@/lib/event-game-action-json";
export {
  createControlActionCodecRegistry,
  createDefaultControlActionCodecs,
  createDeterministicTestIqaInterpreter,
} from "@/lib/event-game-action-codecs";

export type ActionJsonValue =
  | null
  | boolean
  | number
  | string
  | ActionJsonValue[]
  | { [key: string]: ActionJsonValue };

export type ControlActionKind = {
  id: string;
  version: string;
};

export type ControlActionOccurrence = {
  trustedAtMs: number;
  clientOriginAtMs: number | null;
  source: "online" | "offline";
};

export type ControlActionGrantProvenance = {
  sessionId: string;
  versionId: string;
  authorityReference?: string;
};

export const SYSTEM_TIMEOUT_COMPLETION_GRANT: Readonly<{
  sessionId: "system-timeout-completion";
  versionId: "system-v1";
}> = Object.freeze({
  sessionId: "system-timeout-completion",
  versionId: "system-v1",
});

export type ControlActionOrigin = "controller" | "system-heat-stoppage";

export type ControlActionLifecycleContext = {
  phase: EventGameLifecyclePhase;
  commencedAtMs: number | null;
  finishedAtMs: number | null;
  lockedAtMs: number | null;
  lockReason: "finished-inactivity" | "administrative" | null;
};

export type ControlActionRecoveryProvenance = {
  importId: string;
  sourceRecordId: string;
  sourceEventGameId: string;
  sourceOperationId: string;
  sourceReference: string;
  sourceAcceptedAtMs: number | null;
};

export type OfficialOverrideMetadata = {
  guardrail: string;
  direction: string;
  confirmation: string;
  authorityReference: string;
  gameTimeMs: number;
  beforeValue?: ActionJsonValue;
  afterValue?: ActionJsonValue;
  reason?: string;
  note?: string;
};

export type ControlActionInput = {
  recordId: string;
  eventGameId: string;
  operationId: string;
  kind: ControlActionKind;
  payload: unknown;
  causalPredecessorIds: readonly string[];
  occurrence: ControlActionOccurrence;
  /** Controller actions carry Grant provenance; trusted system obligations do not. */
  grant: ControlActionGrantProvenance | null;
  /** Explicitly distinguishes derived heat obligations from Controller submissions. */
  origin?: ControlActionOrigin;
  lifecycle: ControlActionLifecycleContext;
  override?: OfficialOverrideMetadata;
  recoveryProvenance?: ControlActionRecoveryProvenance;
};

export type FactInterpretation = {
  type: "fact";
  factId: string;
  factType: string;
  gameSideId: string | null;
  payload: ActionJsonValue;
};

export type CorrectionInterpretation = {
  type: "correction";
  correctionId: string;
  targetFactId: string;
  effective: boolean;
};

export type TeamAssignmentCorrectionInterpretation = {
  type: "team-assignment-correction";
  correctionId: string;
  gameSideId: string;
  eventTeamId: string;
  teamInterpretationRef: string;
};

export type NonFactInterpretation = {
  type: "non-fact";
  stableId: string;
};

export type ControlActionInterpretation =
  | FactInterpretation
  | CorrectionInterpretation
  | TeamAssignmentCorrectionInterpretation
  | NonFactInterpretation;

export type ControlAuditCollisionEvidence = {
  acceptedActionId: string;
  acceptedOperationId: string;
  acceptedContentFingerprint: string;
  rejectedAttempt: {
    input: ControlActionInput;
    codecIdentity?: string;
    codecFingerprint?: string;
    canonicalContent: string;
    contentFingerprint: string;
    interpretation: ControlActionInterpretation;
  };
};

export type ControlAuditLinkage = {
  actionId: string | null;
  targetFactId: string | null;
  causalPredecessorIds: readonly string[];
  relatedOperationIds: readonly string[];
  ordering: {
    trustedAtMs: number;
    operationId: string;
  } | null;
  grantAuditId?: string | null;
  acceptanceId?: string | null;
  /** Acceptance-owned candidate identity, paired independently from Grant evidence. */
  contentFingerprint?: string;
  /** Acceptance-owned status discriminant for non-accepted outcomes. */
  reason?: string;
  /** Canonical rejected candidate retained independently from Grant evidence. */
  rejectedCandidate?: {
    codecIdentity: string;
    codecFingerprint: string;
    canonicalContent: string;
    contentFingerprint: string;
  };
  collision?: ControlAuditCollisionEvidence;
};

export type ControlAuditProvenance = {
  occurrence: ControlActionOccurrence | null;
  grant: ControlActionGrantProvenance | null;
  origin?: ControlActionOrigin;
  lifecycle: ControlActionLifecycleContext | null;
  override: OfficialOverrideMetadata | null;
  recoveryProvenance: ControlActionRecoveryProvenance | null;
};

/**
 * Audit rows written by #75 carry complete action linkage and provenance.
 * Rows from the pre-#75 durable format are read as LEGACY and are validated
 * by the explicit compatibility path in validateAuditHistory.
 */
export const CONTROL_AUDIT_VERSION = "control-audit-v1";
export const LEGACY_CONTROL_AUDIT_VERSION = "control-audit-legacy-v0";
export type ControlAuditVersion =
  | typeof CONTROL_AUDIT_VERSION
  | typeof LEGACY_CONTROL_AUDIT_VERSION;
export const CONTROL_ACTION_VERSION = "control-action-v1";
export const LEGACY_CONTROL_ACTION_VERSION = "control-action-legacy-v0";
export type ControlActionVersion =
  | typeof CONTROL_ACTION_VERSION
  | typeof LEGACY_CONTROL_ACTION_VERSION;

export type ControlAction = ControlActionInput & {
  controlActionVersion: ControlActionVersion;
  acceptedAtMs: number;
  interpretation: ControlActionInterpretation;
};

export type ControlAuditEntry = {
  auditVersion: ControlAuditVersion;
  auditId: string;
  recordId: string;
  eventGameId: string;
  operationId: string | null;
  kind: "action-accepted" | "action-conflict" | "action-rejected" | "action-duplicate";
  outcome: string;
  createdAtMs: number;
  redactedDetail: string;
  links?: ControlAuditLinkage;
  provenance?: ControlAuditProvenance;
  lockedReplay?: {
    count: number;
    originatingSessionId: string;
    eventGameId: string;
    rejectedAtMs: number;
  };
};

export type EventGameRecordMetadata = {
  recordId: string;
  actionCount: number;
  orderingVersion: string;
  lastAcceptedAtMs: number | null;
  updatedAtMs: number;
};

export const CONTROL_ACTION_ORDERING_VERSION = "causal-occurrence-operation-v1";

export type EffectiveGameFact = {
  factId: string;
  action: ControlAction;
  interpretation: FactInterpretation;
};

export type EffectiveGameSideAssignment = {
  gameSideId: string;
  eventTeamId: string;
  teamInterpretationRef: string;
};

export type ControlActionConflict = {
  targetFactId: string | null;
  operationIds: readonly [string, string];
  winnerOperationId: string;
  reason: "opposing-concurrent-corrections" | "opposing-concurrent-team-assignments";
  eventTeamId?: string;
  gameSideIds?: readonly [string, string];
};

export type IqaGameRulesRebuildInput = {
  root: EventGameRecordRoot;
  canonicalActions: readonly ControlAction[];
  effectiveFacts: readonly EffectiveGameFact[];
  effectiveTeamAssignments: readonly EffectiveGameSideAssignment[];
};

export type IqaGameRulesInterpreter = {
  version: string;
  rebuild(input: IqaGameRulesRebuildInput): unknown;
  sporting?: IqaSportingRules;
};

export type ControlActionCodec<TPayload = unknown> = {
  kind: string;
  version: string;
  decode(payload: unknown): ValidationResult<TPayload>;
  canonicalize(payload: TPayload): string;
  fingerprint(payload: TPayload): string;
  interpret(payload: TPayload): ControlActionInterpretation;
};

export type ControlActionCodecRegistry = {
  register(codec: ControlActionCodec): void;
  resolve(kind: string, version: string): ControlActionCodec | undefined;
  entries(): readonly ControlActionCodec[];
};

export function controlActionCodecIdentity(
  kind: { id: string; version: string },
  registry: ControlActionCodecRegistry,
): string {
  const codec = registry.resolve(kind.id, kind.version);
  return canonicalizeJson({
    schema: "control-codec-identity-v1",
    claimed: { id: kind.id, version: kind.version },
    registered: codec === undefined ? null : { id: codec.kind, version: codec.version },
  });
}

export type PreparedControlAction = {
  input: ControlActionInput;
  codecIdentity: string;
  codecFingerprint: string;
  canonicalContent: string;
  contentFingerprint: string;
  interpretation: ControlActionInterpretation;
};

/**
 * The portion of an action that can be inspected before Grant authorization.
 * Payload decoding, codec lookup, interpretation, and root-dependent checks
 * deliberately do not belong here.
 */
export type ControlActionEnvelope = Omit<ControlActionInput, "payload"> & {
  payload: unknown;
};

export function validateControlActionEnvelope(
  input: unknown,
  serverNowMs: number,
): ValidationResult<ControlActionEnvelope> {
  if (!isRecord(input)) return invalid("Control Action must be an object.");
  const recordId = validateId(input.recordId, "recordId");
  const eventGameId = validateId(input.eventGameId, "eventGameId");
  const operationId = validateId(input.operationId, "operationId");
  if (!recordId.ok) return recordId;
  if (!eventGameId.ok) return eventGameId;
  if (!operationId.ok) return operationId;

  // Keep codec identity opaque at this boundary. In particular, resolving an
  // unknown codec must not allow an invalid bearer to learn anything about it.
  if (!isRecord(input.kind)) return invalid("Control Action kind must be an object.");
  const kind = {
    id: typeof input.kind.id === "string" ? input.kind.id : String(input.kind.id),
    version:
      typeof input.kind.version === "string" ? input.kind.version : String(input.kind.version),
  };
  const predecessors = validatePredecessors(input.causalPredecessorIds);
  const occurrence = validateOccurrence(input.occurrence, serverNowMs);
  const originResult: ValidationResult<ControlActionOrigin | undefined> =
    input.origin === undefined
      ? valid(undefined)
      : input.origin === "controller" || input.origin === "system-heat-stoppage"
        ? valid(input.origin)
        : invalid("origin is unsupported.");
  const grant =
    input.origin === "system-heat-stoppage" && input.grant === null
      ? valid(null)
      : validateGrant(input.grant);
  const lifecycle = validateLifecycle(input.lifecycle);
  const override = validateOverride(input.override);
  const recovery = validateRecoveryProvenanceShape(input.recoveryProvenance);
  if (!predecessors.ok) return predecessors;
  if (!occurrence.ok) return occurrence;
  if (!grant.ok) return grant;
  if (!originResult.ok) return originResult;
  if (!lifecycle.ok) return lifecycle;
  if (!override.ok) return override;
  if (!recovery.ok) return recovery;

  return valid({
    recordId: recordId.value,
    eventGameId: eventGameId.value,
    operationId: operationId.value,
    kind,
    payload: input.payload,
    causalPredecessorIds: predecessors.value,
    occurrence: occurrence.value,
    grant: grant.value,
    ...(originResult.value === undefined ? {} : { origin: originResult.value }),
    lifecycle: lifecycle.value,
    ...(override.value === undefined ? {} : { override: override.value }),
    ...(recovery.value === undefined ? {} : { recoveryProvenance: recovery.value }),
  });
}

export type ActionHistoryReadiness = { ok: true } | { ok: false; detail: string };

export type ActionRebuildResult =
  | {
      status: "ready";
      canonicalActions: readonly ControlAction[];
      effectiveFacts: readonly EffectiveGameFact[];
      effectiveTeamAssignments: readonly EffectiveGameSideAssignment[];
      derivedGameState: unknown;
      conflicts: readonly ControlActionConflict[];
    }
  | {
      status: "failed";
      reason:
        | "invalid-history"
        | "missing-dependency"
        | "cyclic-dependency"
        | "unknown-action-version"
        | "unknown-interpreter-version"
        | "missing-interpreter"
        | "nondeterministic-interpreter";
      detail: string;
    };

export function prepareControlAction(
  input: unknown,
  root: EventGameRecordRoot | null,
  registry: ControlActionCodecRegistry,
  serverNowMs: number,
  options: { allowConcurrentTeamAssignment?: boolean } = {},
): ValidationResult<PreparedControlAction> {
  if (!isRecord(input)) return invalid("Control Action must be an object.");

  const recordId = validateId(input.recordId, "recordId");
  const eventGameId = validateId(input.eventGameId, "eventGameId");
  const operationId = validateId(input.operationId, "operationId");
  if (!recordId.ok) return recordId;
  if (!eventGameId.ok) return eventGameId;
  if (!operationId.ok) return operationId;
  if (root !== null && recordId.value !== root.recordId)
    return invalid("Control Action references another record.");
  if (root !== null && eventGameId.value !== root.eventGameId) {
    return invalid("Control Action references another Event Game.");
  }

  const kindResult = validateKind(input.kind);
  if (!kindResult.ok) return kindResult;
  const codecIdentity = controlActionCodecIdentity(kindResult.value, registry);
  const codec = registry.resolve(kindResult.value.id, kindResult.value.version);
  if (codec === undefined) {
    return invalid("The Control Action kind or version is unsupported.");
  }

  let decodedPayload: unknown;
  let canonicalPayloadValue: ActionJsonValue;
  let canonicalPayload: string;
  let codecFingerprint: string;
  let interpretation: ControlActionInterpretation;
  try {
    // Codecs are supplied at the acceptance seam and are therefore untrusted
    // implementations. Keep the complete codec call chain behind one
    // fail-closed read-only preparation boundary.
    const payloadResult = codec.decode(input.payload);
    if (!payloadResult.ok) return payloadResult;
    decodedPayload = payloadResult.value;
    canonicalPayload = codec.canonicalize(payloadResult.value);
    codecFingerprint = codec.fingerprint(payloadResult.value);
    interpretation = codec.interpret(payloadResult.value);
    if (typeof canonicalPayload !== "string" || typeof codecFingerprint !== "string") {
      throw new TypeError("The Control Action codec returned a non-string canonical value.");
    }
    canonicalPayloadValue = JSON.parse(canonicalPayload) as ActionJsonValue;
    if (canonicalizeJson(canonicalPayloadValue) !== canonicalPayload) {
      throw new TypeError("The Control Action codec returned a non-canonical payload.");
    }
  } catch {
    return invalid("The Control Action payload could not be canonicalized.");
  }
  const interpretationResult = validateInterpretation(interpretation);
  if (!interpretationResult.ok) return interpretationResult;
  if (root !== null && interpretationResult.value.type === "fact") {
    const { gameSideId } = interpretationResult.value;
    if (gameSideId !== null && !root.gameSides.some((side) => side.id === gameSideId)) {
      return invalid("Game Fact references an unknown stable Game Side.");
    }
  }
  if (root !== null && interpretationResult.value.type === "team-assignment-correction") {
    const { gameSideId, eventTeamId } = interpretationResult.value;
    if (!root.gameSides.some((candidate) => candidate.id === gameSideId)) {
      return invalid("Team Assignment Correction references an unknown stable Game Side.");
    }
    if (
      !options.allowConcurrentTeamAssignment &&
      root.gameSides.some(
        (candidate) => candidate.id !== gameSideId && candidate.eventTeamId === eventTeamId,
      )
    ) {
      return invalid("Team Assignment Correction would assign both Game Sides to one Event Team.");
    }
  }

  const predecessorResult = validatePredecessors(input.causalPredecessorIds);
  if (!predecessorResult.ok) return predecessorResult;
  const occurrenceResult = validateOccurrence(input.occurrence, serverNowMs);
  if (!occurrenceResult.ok) return occurrenceResult;
  const originResult: ValidationResult<ControlActionOrigin | undefined> =
    input.origin === undefined
      ? valid(undefined)
      : input.origin === "controller" || input.origin === "system-heat-stoppage"
        ? valid(input.origin)
        : invalid("origin is unsupported.");
  if (!originResult.ok) return originResult;
  const grantResult =
    input.origin === "system-heat-stoppage" && input.grant === null
      ? valid(null)
      : validateGrant(input.grant);
  if (!grantResult.ok) return grantResult;
  const lifecycleResult = validateLifecycle(input.lifecycle);
  if (!lifecycleResult.ok) return lifecycleResult;
  if (root !== null && !sameLifecycle(lifecycleResult.value, root.lifecycle)) {
    return invalid("Control Action lifecycle context is stale.");
  }
  const overrideResult = validateOverride(input.override);
  if (!overrideResult.ok) return overrideResult;
  const recoveryResult =
    root === null
      ? validateRecoveryProvenanceShape(input.recoveryProvenance)
      : validateRecoveryProvenance(input.recoveryProvenance, root, operationId.value);
  if (!recoveryResult.ok) return recoveryResult;

  const normalizedInput: ControlActionInput = {
    recordId: recordId.value,
    eventGameId: eventGameId.value,
    operationId: operationId.value,
    kind: kindResult.value,
    payload: structuredClone(decodedPayload),
    causalPredecessorIds: predecessorResult.value,
    occurrence: occurrenceResult.value,
    grant: grantResult.value,
    ...(originResult.value === undefined ? {} : { origin: originResult.value }),
    lifecycle: lifecycleResult.value,
    ...(overrideResult.value === undefined ? {} : { override: overrideResult.value }),
    ...(recoveryResult.value === undefined ? {} : { recoveryProvenance: recoveryResult.value }),
  };
  const canonicalContent = canonicalizeJson({
    ...normalizedInput,
    payload: canonicalPayloadValue,
  });
  const contentFingerprint = sha256(`${codecFingerprint}:${canonicalContent}`);
  return valid({
    input: normalizedInput,
    codecIdentity,
    codecFingerprint,
    canonicalContent,
    contentFingerprint,
    interpretation: interpretationResult.value,
  });
}

export function materializeControlAction(
  prepared: PreparedControlAction,
  acceptedAtMs: number,
): ControlAction {
  return {
    ...structuredClone(prepared.input),
    controlActionVersion: CONTROL_ACTION_VERSION,
    acceptedAtMs,
    interpretation: structuredClone(prepared.interpretation),
  };
}

export function actionIdentity(recordId: string, operationId: string): string {
  return `action-${sha256(`${recordId}:${operationId}`)}`;
}

export function parseStoredControlAction(value: unknown): ValidationResult<ControlAction> {
  if (!isRecord(value)) return invalid("Stored Control Action must be an object.");
  const acceptedAtMs = validateTimestamp(value.acceptedAtMs, "acceptedAtMs");
  const inputResult = validateStoredInput(value);
  if (!acceptedAtMs.ok) return acceptedAtMs;
  if (!inputResult.ok) return inputResult;
  const interpretationResult = validateInterpretation(value.interpretation);
  if (!interpretationResult.ok) return interpretationResult;
  const controlActionVersion =
    value.controlActionVersion === undefined
      ? LEGACY_CONTROL_ACTION_VERSION
      : value.controlActionVersion;
  if (
    controlActionVersion !== CONTROL_ACTION_VERSION &&
    controlActionVersion !== LEGACY_CONTROL_ACTION_VERSION
  ) {
    return invalid("Stored Control Action version is unsupported.");
  }
  return valid({
    ...inputResult.value,
    controlActionVersion,
    acceptedAtMs: acceptedAtMs.value,
    interpretation: interpretationResult.value,
  });
}

export function validateStoredControlAction(
  action: ControlAction,
  canonicalContent: string,
  contentFingerprint: string,
  root: EventGameRecordRoot,
  registry: ControlActionCodecRegistry,
): ActionHistoryReadiness {
  const prepared = prepareControlAction(
    action,
    { ...root, lifecycle: action.lifecycle },
    registry,
    action.occurrence.trustedAtMs,
    { allowConcurrentTeamAssignment: true },
  );
  if (!prepared.ok) return { ok: false, detail: prepared.error };
  if (prepared.value.canonicalContent !== canonicalContent) {
    return { ok: false, detail: "Stored Control Action canonical content is inconsistent." };
  }
  if (prepared.value.contentFingerprint !== contentFingerprint) {
    return { ok: false, detail: "Stored Control Action fingerprint is inconsistent." };
  }
  if (canonicalizeJson(prepared.value.interpretation) !== canonicalizeJson(action.interpretation)) {
    return { ok: false, detail: "Stored Control Action interpreter hook output is inconsistent." };
  }
  return { ok: true };
}

export function rebuildControlActionHistory(
  root: EventGameRecordRoot,
  storedActions: readonly {
    action: ControlAction;
    canonicalContent: string;
    contentFingerprint: string;
    durableFormat?: "current" | "legacy";
    [DURABLE_EVIDENCE_PROVENANCE]?: "current" | "legacy";
  }[],
  registry: ControlActionCodecRegistry,
  interpreter: IqaGameRulesInterpreter,
): ActionRebuildResult {
  if (interpreter.version !== root.compatibility.interpreterVersion) {
    return {
      status: "failed",
      reason: "unknown-interpreter-version",
      detail: "The registered IQA interpreter does not match the record version.",
    };
  }

  const actions: ControlAction[] = [];
  for (const stored of storedActions) {
    if (
      (stored[DURABLE_EVIDENCE_PROVENANCE] === "current" &&
        stored.action.controlActionVersion !== CONTROL_ACTION_VERSION) ||
      (stored[DURABLE_EVIDENCE_PROVENANCE] === "legacy" &&
        stored.action.controlActionVersion !== LEGACY_CONTROL_ACTION_VERSION)
    ) {
      return {
        status: "failed",
        reason: "invalid-history",
        detail: "Durable Control Action evidence was downgraded across its storage boundary.",
      };
    }
    const validity = validateStoredControlAction(
      stored.action,
      stored.canonicalContent,
      stored.contentFingerprint,
      root,
      registry,
    );
    if (!validity.ok) {
      const reason = validity.detail.includes("unsupported")
        ? "unknown-action-version"
        : "invalid-history";
      return { status: "failed", reason, detail: validity.detail };
    }
    actions.push(structuredClone(stored.action));
  }

  const ordered = canonicalizeActionHistory(actions);
  if (!ordered.ok) {
    return {
      status: "failed",
      reason: ordered.reason,
      detail: ordered.detail,
    };
  }

  const factsById = new Map<string, EffectiveGameFact>();
  for (const action of ordered.actions) {
    if (action.interpretation.type !== "fact") continue;
    if (factsById.has(action.interpretation.factId)) {
      return {
        status: "failed",
        reason: "invalid-history",
        detail: "The retained history contains duplicate stable Game Fact identities.",
      };
    }
    factsById.set(action.interpretation.factId, {
      factId: action.interpretation.factId,
      action,
      interpretation: action.interpretation,
    });
  }

  const effectiveByFactId = new Map([...factsById.keys()].map((factId) => [factId, true]));
  const effectiveTeamAssignments = new Map(
    root.gameSides.map((side) => [
      side.id,
      {
        gameSideId: side.id,
        eventTeamId: side.eventTeamId,
        teamInterpretationRef: side.teamInterpretationRef,
      },
    ]),
  );
  const actionMap = actionsByOperationId(actions);
  const conflicts = [
    ...findConcurrentCorrectionConflictsInOrder(ordered.actions, actionMap),
    ...findConcurrentTeamAssignmentConflictsInOrder(ordered.actions, actionMap),
  ];
  const teamConflictWinners = globalTeamConflictWinners(ordered.actions, conflicts);
  for (const action of ordered.actions) {
    if (action.interpretation.type !== "correction") continue;
    if (!factsById.has(action.interpretation.targetFactId)) {
      return {
        status: "failed",
        reason: "invalid-history",
        detail: "A Correction targets a missing stable Game Fact.",
      };
    }
    effectiveByFactId.set(action.interpretation.targetFactId, action.interpretation.effective);
  }
  for (const action of ordered.actions) {
    if (action.interpretation.type !== "team-assignment-correction") continue;
    const { gameSideId, eventTeamId, teamInterpretationRef } = action.interpretation;
    const current = effectiveTeamAssignments.get(gameSideId);
    if (current === undefined) {
      return {
        status: "failed",
        reason: "invalid-history",
        detail: "A Team Assignment Correction targets a missing stable Game Side.",
      };
    }
    const teamConflictWinner = teamConflictWinners.get(action.operationId);
    if (teamConflictWinner !== undefined && teamConflictWinner !== action.operationId) {
      continue;
    }
    if (
      [...effectiveTeamAssignments.values()].some(
        (assignment) =>
          assignment.gameSideId !== gameSideId && assignment.eventTeamId === eventTeamId,
      )
    ) {
      return {
        status: "failed",
        reason: "invalid-history",
        detail: "Effective Game Side assignments must reference distinct Event Teams.",
      };
    }
    effectiveTeamAssignments.set(gameSideId, {
      ...current,
      eventTeamId,
      teamInterpretationRef,
    });
  }

  const effectiveFacts: EffectiveGameFact[] = [];
  for (const action of ordered.actions) {
    if (
      action.interpretation.type !== "fact" ||
      effectiveByFactId.get(action.interpretation.factId) !== true
    ) {
      continue;
    }
    const fact = factsById.get(action.interpretation.factId);
    if (fact !== undefined) effectiveFacts.push(fact);
  }

  let firstState: unknown;
  let secondState: unknown;
  try {
    firstState = interpreter.rebuild({
      root: structuredClone(root),
      canonicalActions: structuredClone(ordered.actions),
      effectiveFacts: structuredClone(effectiveFacts),
      effectiveTeamAssignments: structuredClone([...effectiveTeamAssignments.values()]),
    });
    secondState = interpreter.rebuild({
      root: structuredClone(root),
      canonicalActions: structuredClone(ordered.actions),
      effectiveFacts: structuredClone(effectiveFacts),
      effectiveTeamAssignments: structuredClone([...effectiveTeamAssignments.values()]),
    });
  } catch {
    return {
      status: "failed",
      reason: "invalid-history",
      detail: "The IQA interpreter could not rebuild the retained history.",
    };
  }
  let firstCanonical: string;
  let secondCanonical: string;
  try {
    firstCanonical = canonicalizeJson(firstState);
    secondCanonical = canonicalizeJson(secondState);
  } catch {
    return {
      status: "failed",
      reason: "nondeterministic-interpreter",
      detail: "The IQA interpreter returned a non-canonical state.",
    };
  }
  if (firstCanonical !== secondCanonical) {
    return {
      status: "failed",
      reason: "nondeterministic-interpreter",
      detail: "The IQA interpreter produced different rebuild results.",
    };
  }

  return {
    status: "ready",
    canonicalActions: ordered.actions,
    effectiveFacts,
    effectiveTeamAssignments: [...effectiveTeamAssignments.values()],
    derivedGameState: firstState,
    conflicts,
  };
}

export function findConcurrentCorrectionConflicts(
  actions: readonly ControlAction[],
): readonly ControlActionConflict[] {
  const ordered = canonicalizeActionHistory(actions);
  return ordered.ok
    ? findConcurrentCorrectionConflictsInOrder(ordered.actions, actionsByOperationId(actions))
    : [];
}

export function findConcurrentTeamAssignmentConflicts(
  actions: readonly ControlAction[],
): readonly ControlActionConflict[] {
  const ordered = canonicalizeActionHistory(actions);
  return ordered.ok
    ? findConcurrentTeamAssignmentConflictsInOrder(ordered.actions, actionsByOperationId(actions))
    : [];
}

function findConcurrentCorrectionConflictsInOrder(
  orderedActions: readonly ControlAction[],
  actions: ReadonlyMap<string, ControlAction>,
): ControlActionConflict[] {
  const conflicts: ControlActionConflict[] = [];
  for (let leftIndex = 0; leftIndex < orderedActions.length; leftIndex += 1) {
    const left = orderedActions[leftIndex];
    if (left === undefined || left.interpretation.type !== "correction") continue;
    for (let rightIndex = leftIndex + 1; rightIndex < orderedActions.length; rightIndex += 1) {
      const right = orderedActions[rightIndex];
      if (
        right === undefined ||
        right.interpretation.type !== "correction" ||
        left.interpretation.targetFactId !== right.interpretation.targetFactId ||
        left.interpretation.effective === right.interpretation.effective ||
        causallyRelated(left, right, actions)
      ) {
        continue;
      }
      conflicts.push({
        targetFactId: left.interpretation.targetFactId,
        operationIds: [left.operationId, right.operationId],
        winnerOperationId: right.operationId,
        reason: "opposing-concurrent-corrections",
      });
    }
  }
  return conflicts;
}

function findConcurrentTeamAssignmentConflictsInOrder(
  orderedActions: readonly ControlAction[],
  actions: ReadonlyMap<string, ControlAction>,
): ControlActionConflict[] {
  const conflicts: ControlActionConflict[] = [];
  for (let leftIndex = 0; leftIndex < orderedActions.length; leftIndex += 1) {
    const left = orderedActions[leftIndex];
    if (left === undefined || left.interpretation.type !== "team-assignment-correction") continue;
    for (let rightIndex = leftIndex + 1; rightIndex < orderedActions.length; rightIndex += 1) {
      const right = orderedActions[rightIndex];
      if (
        right === undefined ||
        right.interpretation.type !== "team-assignment-correction" ||
        left.interpretation.eventTeamId !== right.interpretation.eventTeamId ||
        left.interpretation.gameSideId === right.interpretation.gameSideId ||
        causallyRelated(left, right, actions)
      )
        continue;
      conflicts.push({
        targetFactId: null,
        eventTeamId: left.interpretation.eventTeamId,
        gameSideIds: [left.interpretation.gameSideId, right.interpretation.gameSideId],
        operationIds: [left.operationId, right.operationId],
        winnerOperationId: right.operationId,
        reason: "opposing-concurrent-team-assignments",
      });
    }
  }
  return conflicts;
}

function globalTeamConflictWinners(
  orderedActions: readonly ControlAction[],
  conflicts: readonly ControlActionConflict[],
): ReadonlyMap<string, string> {
  const adjacency = new Map<string, Set<string>>();
  for (const conflict of conflicts) {
    if (conflict.reason !== "opposing-concurrent-team-assignments") continue;
    const [left, right] = conflict.operationIds;
    if (left === undefined || right === undefined) continue;
    const leftNeighbours = adjacency.get(left) ?? new Set<string>();
    const rightNeighbours = adjacency.get(right) ?? new Set<string>();
    leftNeighbours.add(right);
    rightNeighbours.add(left);
    adjacency.set(left, leftNeighbours);
    adjacency.set(right, rightNeighbours);
  }

  const canonicalIndex = new Map(
    orderedActions.map((action, index) => [action.operationId, index] as const),
  );
  const winners = new Map<string, string>();
  const visited = new Set<string>();
  for (const operationId of adjacency.keys()) {
    if (visited.has(operationId)) continue;
    const component: string[] = [];
    const pending = [operationId];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || visited.has(current)) continue;
      visited.add(current);
      component.push(current);
      for (const neighbour of adjacency.get(current) ?? []) pending.push(neighbour);
    }
    const winner = component.reduce((latest, candidate) =>
      (canonicalIndex.get(candidate) ?? -1) > (canonicalIndex.get(latest) ?? -1)
        ? candidate
        : latest,
    );
    for (const member of component) winners.set(member, winner);
  }
  return winners;
}

function actionsByOperationId(actions: readonly ControlAction[]): Map<string, ControlAction> {
  return new Map(actions.map((action) => [action.operationId, action]));
}

function causallyRelated(
  left: ControlAction,
  right: ControlAction,
  actions: ReadonlyMap<string, ControlAction>,
): boolean {
  return (
    reaches(left.operationId, right.operationId, actions) ||
    reaches(right.operationId, left.operationId, actions)
  );
}

/** Shared canonical reachability predicate for conflict and audit validation. */
export function isCausallyRelated(
  left: ControlAction,
  right: ControlAction,
  actions: ReadonlyMap<string, ControlAction>,
): boolean {
  return causallyRelated(left, right, actions);
}

function reaches(
  predecessorOperationId: string,
  descendantOperationId: string,
  actions: ReadonlyMap<string, ControlAction>,
): boolean {
  const pending = [...(actions.get(descendantOperationId)?.causalPredecessorIds ?? [])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const operationId = pending.pop();
    if (operationId === undefined || !visited.add(operationId)) continue;
    if (operationId === predecessorOperationId) return true;
    pending.push(...(actions.get(operationId)?.causalPredecessorIds ?? []));
  }
  return false;
}

function canonicalizeActionHistory(actions: readonly ControlAction[]):
  | { ok: true; actions: ControlAction[] }
  | {
      ok: false;
      reason: Extract<ActionRebuildResult, { status: "failed" }>["reason"];
      detail: string;
    } {
  const byOperationId = new Map<string, ControlAction>();
  const dependents = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const action of actions) {
    if (byOperationId.has(action.operationId)) {
      return {
        ok: false,
        reason: "invalid-history",
        detail: "The retained history contains duplicate operation identities.",
      };
    }
    byOperationId.set(action.operationId, action);
    remaining.set(action.operationId, action.causalPredecessorIds.length);
    for (const predecessorId of action.causalPredecessorIds) {
      if (!byOperationId.has(predecessorId)) {
        // The complete map is populated after this loop; defer this check.
        continue;
      }
      const dependentIds = dependents.get(predecessorId) ?? [];
      dependentIds.push(action.operationId);
      dependents.set(predecessorId, dependentIds);
    }
  }

  for (const action of actions) {
    for (const predecessorId of action.causalPredecessorIds) {
      if (!byOperationId.has(predecessorId)) {
        return {
          ok: false,
          reason: "missing-dependency",
          detail: "A retained Control Action references a missing predecessor.",
        };
      }
      const dependentIds = dependents.get(predecessorId) ?? [];
      if (!dependentIds.includes(action.operationId)) dependentIds.push(action.operationId);
      dependents.set(predecessorId, dependentIds);
    }
  }

  const ready = actions
    .filter((action) => remaining.get(action.operationId) === 0)
    .sort(compareCanonicalActions);
  const ordered: ControlAction[] = [];
  while (ready.length > 0) {
    const next = ready.shift();
    if (next === undefined) break;
    ordered.push(next);
    for (const dependentId of dependents.get(next.operationId) ?? []) {
      const count = (remaining.get(dependentId) ?? 0) - 1;
      remaining.set(dependentId, count);
      if (count === 0) {
        const dependent = byOperationId.get(dependentId);
        if (dependent !== undefined) {
          ready.push(dependent);
          ready.sort(compareCanonicalActions);
        }
      }
    }
  }
  if (ordered.length !== actions.length) {
    return {
      ok: false,
      reason: "cyclic-dependency",
      detail: "The retained Control Action history contains a causal cycle.",
    };
  }
  return { ok: true, actions: ordered };
}

function compareCanonicalActions(left: ControlAction, right: ControlAction): number {
  if (left.occurrence.trustedAtMs !== right.occurrence.trustedAtMs) {
    return left.occurrence.trustedAtMs < right.occurrence.trustedAtMs ? -1 : 1;
  }
  return compareOpaqueIdentifiers(left.operationId, right.operationId);
}

function compareOpaqueIdentifiers(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
