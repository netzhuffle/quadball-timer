import type { ValidationResult } from "@/lib/validation-policy";
import type { EventGameLifecyclePhase, EventGameRecordRoot } from "@/lib/foundation-record-types";
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
  validateStoredInput,
  validateTimestamp,
  valid,
} from "@/lib/event-game-action-codecs";

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
  grant: ControlActionGrantProvenance;
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

export type NonFactInterpretation = {
  type: "non-fact";
  stableId: string;
};

export type ControlActionInterpretation =
  | FactInterpretation
  | CorrectionInterpretation
  | NonFactInterpretation;

export type ControlAction = ControlActionInput & {
  acceptedAtMs: number;
  interpretation: ControlActionInterpretation;
};

export type ControlAuditEntry = {
  auditId: string;
  recordId: string;
  eventGameId: string;
  operationId: string | null;
  kind: "action-accepted" | "action-conflict" | "action-rejected" | "action-duplicate";
  outcome: string;
  createdAtMs: number;
  redactedDetail: string;
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

export type IqaGameRulesRebuildInput = {
  root: EventGameRecordRoot;
  canonicalActions: readonly ControlAction[];
  effectiveFacts: readonly EffectiveGameFact[];
};

export type IqaGameRulesInterpreter = {
  version: string;
  rebuild(input: IqaGameRulesRebuildInput): unknown;
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

export type PreparedControlAction = {
  input: ControlActionInput;
  canonicalContent: string;
  contentFingerprint: string;
  interpretation: ControlActionInterpretation;
};

export type ActionHistoryReadiness = { ok: true } | { ok: false; detail: string };

export type ActionRebuildResult =
  | {
      status: "ready";
      canonicalActions: readonly ControlAction[];
      effectiveFacts: readonly EffectiveGameFact[];
      derivedGameState: unknown;
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
  root: EventGameRecordRoot,
  registry: ControlActionCodecRegistry,
  serverNowMs: number,
): ValidationResult<PreparedControlAction> {
  if (!isRecord(input)) return invalid("Control Action must be an object.");

  const recordId = validateId(input.recordId, "recordId");
  const eventGameId = validateId(input.eventGameId, "eventGameId");
  const operationId = validateId(input.operationId, "operationId");
  if (!recordId.ok) return recordId;
  if (!eventGameId.ok) return eventGameId;
  if (!operationId.ok) return operationId;
  if (recordId.value !== root.recordId) return invalid("Control Action references another record.");
  if (eventGameId.value !== root.eventGameId) {
    return invalid("Control Action references another Event Game.");
  }

  const kindResult = validateKind(input.kind);
  if (!kindResult.ok) return kindResult;
  const codec = registry.resolve(kindResult.value.id, kindResult.value.version);
  if (codec === undefined) {
    return invalid("The Control Action kind or version is unsupported.");
  }

  const payloadResult = codec.decode(input.payload);
  if (!payloadResult.ok) return payloadResult;
  let canonicalPayloadValue: ActionJsonValue;
  let canonicalPayload: string;
  let codecFingerprint: string;
  let interpretation: ControlActionInterpretation;
  try {
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
  if (interpretationResult.value.type === "fact") {
    const { gameSideId } = interpretationResult.value;
    if (gameSideId !== null && !root.gameSides.some((side) => side.id === gameSideId)) {
      return invalid("Game Fact references an unknown stable Game Side.");
    }
  }

  const predecessorResult = validatePredecessors(input.causalPredecessorIds);
  if (!predecessorResult.ok) return predecessorResult;
  const occurrenceResult = validateOccurrence(input.occurrence, serverNowMs);
  if (!occurrenceResult.ok) return occurrenceResult;
  const grantResult = validateGrant(input.grant);
  if (!grantResult.ok) return grantResult;
  const lifecycleResult = validateLifecycle(input.lifecycle);
  if (!lifecycleResult.ok) return lifecycleResult;
  if (!sameLifecycle(lifecycleResult.value, root.lifecycle)) {
    return invalid("Control Action lifecycle context is stale.");
  }
  const overrideResult = validateOverride(input.override);
  if (!overrideResult.ok) return overrideResult;
  const recoveryResult = validateRecoveryProvenance(
    input.recoveryProvenance,
    root,
    operationId.value,
  );
  if (!recoveryResult.ok) return recoveryResult;

  const normalizedInput: ControlActionInput = {
    recordId: recordId.value,
    eventGameId: eventGameId.value,
    operationId: operationId.value,
    kind: kindResult.value,
    payload: structuredClone(payloadResult.value),
    causalPredecessorIds: predecessorResult.value,
    occurrence: occurrenceResult.value,
    grant: grantResult.value,
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
  return valid({
    ...inputResult.value,
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
  const prepared = prepareControlAction(action, root, registry, action.occurrence.trustedAtMs);
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
    });
    secondState = interpreter.rebuild({
      root: structuredClone(root),
      canonicalActions: structuredClone(ordered.actions),
      effectiveFacts: structuredClone(effectiveFacts),
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
    derivedGameState: firstState,
  };
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
  return (
    left.occurrence.trustedAtMs - right.occurrence.trustedAtMs ||
    left.operationId.localeCompare(right.operationId)
  );
}
