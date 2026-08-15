import {
  SHARED_LIMITS,
  validateIntegerInRange,
  validateOnlineOccurrenceMs,
  validateOpaqueIdentifier,
  type ValidationResult,
} from "@/lib/validation-policy";
import { canonicalizeJson, sha256 } from "@/lib/event-game-action-json";
import { validateClockFactData } from "@/lib/clock-authority";
import type {
  ActionJsonValue,
  ControlActionCodec,
  ControlActionCodecRegistry,
  ControlActionGrantProvenance,
  ControlActionInput,
  ControlActionOrigin,
  ControlActionInterpretation,
  ControlActionKind,
  ControlActionLifecycleContext,
  ControlActionOccurrence,
  ControlActionRecoveryProvenance,
  IqaGameRulesInterpreter,
  OfficialOverrideMetadata,
} from "@/lib/event-game-actions";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import { DEFAULT_IQA_SPORTING_RULES } from "@/lib/iqa-game-rules";

const MAX_TIMESTAMP_MS = Number.MAX_SAFE_INTEGER;

export function createControlActionCodecRegistry(
  codecs: readonly ControlActionCodec[] = createDefaultControlActionCodecs(),
): ControlActionCodecRegistry {
  const byKey = new Map<string, ControlActionCodec>();
  for (const codec of codecs) {
    registerCodec(byKey, codec);
  }

  return {
    register(codec) {
      registerCodec(byKey, codec);
    },
    resolve(kind, version) {
      return byKey.get(codecKey(kind, version));
    },
    entries() {
      return [...byKey.values()];
    },
  };
}

export function createDefaultControlActionCodecs(): readonly ControlActionCodec[] {
  return [createGameFactCodec(), createCorrectionCodec(), createTeamAssignmentCorrectionCodec()];
}

export function createDeterministicTestIqaInterpreter(version: string): IqaGameRulesInterpreter {
  return {
    version,
    sporting: DEFAULT_IQA_SPORTING_RULES,
    rebuild({ canonicalActions, effectiveFacts }) {
      return {
        interpreterVersion: version,
        canonicalActionIds: canonicalActions.map((action) => action.operationId),
        effectiveFactIds: effectiveFacts.map((fact) => fact.factId),
      };
    },
  };
}

type GameFactPayload = {
  factId: string;
  factType: string;
  gameSideId: string | null;
  gameTimeMs: number | null;
  data: ActionJsonValue;
};

type CorrectionPayload = {
  correctionId: string;
  targetFactId: string;
  effective: boolean;
};

type TeamAssignmentCorrectionPayload = {
  correctionId: string;
  gameSideId: string;
  eventTeamId: string;
  teamInterpretationRef: string;
  eventTeamName?: string;
};

function createGameFactCodec(): ControlActionCodec<GameFactPayload> {
  return {
    kind: "game-fact",
    version: "1",
    decode(payload) {
      if (!isRecord(payload)) return invalid("Game Fact payload must be an object.");
      const factId = validateId(payload.factId, "payload.factId");
      const factType = validateId(payload.factType, "payload.factType");
      if (!factId.ok) return factId;
      if (!factType.ok) return factType;
      const gameSideId =
        payload.gameSideId === null
          ? valid(null)
          : validateId(payload.gameSideId, "payload.gameSideId");
      if (!gameSideId.ok) return gameSideId;
      const gameTimeMs =
        payload.gameTimeMs === undefined
          ? valid(null)
          : validateIntegerInRange(
              payload.gameTimeMs,
              0,
              SHARED_LIMITS.clock.maxMs,
              "payload.gameTimeMs",
            );
      if (!gameTimeMs.ok) return gameTimeMs;
      let data: ActionJsonValue = null;
      if (payload.data !== undefined) {
        const dataResult = parseJsonValue(payload.data, "payload.data");
        if (!dataResult.ok) return dataResult;
        if (factType.value === "clock") {
          const clockData = validateClockFactData(dataResult.value);
          if (!clockData.ok) return clockData;
        }
        data = dataResult.value;
      }
      return valid({
        factId: factId.value,
        factType: factType.value,
        gameSideId: gameSideId.value,
        gameTimeMs: gameTimeMs.value,
        data,
      });
    },
    canonicalize(payload) {
      return canonicalizeJson(payload);
    },
    fingerprint(payload) {
      return sha256(canonicalizeJson(payload));
    },
    interpret(payload) {
      return {
        type: "fact",
        factId: payload.factId,
        factType: payload.factType,
        gameSideId: payload.gameSideId,
        payload: payload as ActionJsonValue,
      };
    },
  };
}

function createCorrectionCodec(): ControlActionCodec<CorrectionPayload> {
  return {
    kind: "correction",
    version: "1",
    decode(payload) {
      if (!isRecord(payload)) return invalid("Correction payload must be an object.");
      const correctionId = validateId(payload.correctionId, "payload.correctionId");
      const targetFactId = validateId(payload.targetFactId, "payload.targetFactId");
      if (!correctionId.ok) return correctionId;
      if (!targetFactId.ok) return targetFactId;
      if (typeof payload.effective !== "boolean") {
        return invalid("payload.effective must be a boolean.");
      }
      return valid({
        correctionId: correctionId.value,
        targetFactId: targetFactId.value,
        effective: payload.effective,
      });
    },
    canonicalize(payload) {
      return canonicalizeJson(payload);
    },
    fingerprint(payload) {
      return sha256(canonicalizeJson(payload));
    },
    interpret(payload) {
      return {
        type: "correction",
        correctionId: payload.correctionId,
        targetFactId: payload.targetFactId,
        effective: payload.effective,
      };
    },
  };
}

function createTeamAssignmentCorrectionCodec(): ControlActionCodec<TeamAssignmentCorrectionPayload> {
  return {
    kind: "team-assignment-correction",
    version: "1",
    decode(payload) {
      if (!isRecord(payload))
        return invalid("Team Assignment Correction payload must be an object.");
      const correctionId = validateId(payload.correctionId, "payload.correctionId");
      const gameSideId = validateId(payload.gameSideId, "payload.gameSideId");
      const eventTeamId = validateId(payload.eventTeamId, "payload.eventTeamId");
      const teamInterpretationRef = validateId(
        payload.teamInterpretationRef,
        "payload.teamInterpretationRef",
      );
      if (!correctionId.ok) return correctionId;
      if (!gameSideId.ok) return gameSideId;
      if (!eventTeamId.ok) return eventTeamId;
      if (!teamInterpretationRef.ok) return teamInterpretationRef;
      const eventTeamName =
        payload.eventTeamName === undefined
          ? valid(undefined)
          : validateId(payload.eventTeamName, "payload.eventTeamName");
      if (!eventTeamName.ok) return eventTeamName;
      return valid({
        correctionId: correctionId.value,
        gameSideId: gameSideId.value,
        eventTeamId: eventTeamId.value,
        teamInterpretationRef: teamInterpretationRef.value,
        ...(eventTeamName.value === undefined ? {} : { eventTeamName: eventTeamName.value }),
      });
    },
    canonicalize(payload) {
      return canonicalizeJson(payload);
    },
    fingerprint(payload) {
      return sha256(canonicalizeJson(payload));
    },
    interpret(payload) {
      return {
        type: "team-assignment-correction",
        correctionId: payload.correctionId,
        gameSideId: payload.gameSideId,
        eventTeamId: payload.eventTeamId,
        teamInterpretationRef: payload.teamInterpretationRef,
        ...(payload.eventTeamName === undefined ? {} : { eventTeamName: payload.eventTeamName }),
      };
    },
  };
}

export function validateKind(value: unknown): ValidationResult<ControlActionKind> {
  if (!isRecord(value)) return invalid("Control Action kind must be an object.");
  const id = validateId(value.id, "kind.id");
  const version = validateId(value.version, "kind.version");
  if (!id.ok) return id;
  if (!version.ok) return version;
  return valid({ id: id.value, version: version.value });
}

export function validatePredecessors(value: unknown): ValidationResult<string[]> {
  if (!Array.isArray(value)) return invalid("causalPredecessorIds must be an array.");
  if (value.length > SHARED_LIMITS.replay.maxControlActions) {
    return invalid("causalPredecessorIds exceeds the replay action limit.");
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const id = validateId(item, `causalPredecessorIds[${index}]`);
    if (!id.ok) return id;
    if (!seen.add(id.value)) return invalid("causalPredecessorIds must be unique.");
    ids.push(id.value);
  }
  ids.sort();
  return valid(ids);
}

export function validateOccurrence(
  value: unknown,
  serverNowMs: number,
): ValidationResult<ControlActionOccurrence> {
  const occurrence = validateOccurrenceWithoutClock(value);
  if (!occurrence.ok) return occurrence;
  if (occurrence.value.source === "online") {
    const trusted = validateOnlineOccurrenceMs(occurrence.value.trustedAtMs, serverNowMs);
    if (!trusted.ok) return trusted;
  }
  return occurrence;
}

export function validateOccurrenceWithoutClock(
  value: unknown,
): ValidationResult<ControlActionOccurrence> {
  if (!isRecord(value)) return invalid("occurrence must be an object.");
  const trustedAtMs = validateTimestamp(value.trustedAtMs, "occurrence.trustedAtMs");
  const clientOriginAtMs =
    value.clientOriginAtMs === null
      ? valid(null)
      : validateTimestamp(value.clientOriginAtMs, "occurrence.clientOriginAtMs");
  if (!trustedAtMs.ok) return trustedAtMs;
  if (!clientOriginAtMs.ok) return clientOriginAtMs;
  if (value.source !== "online" && value.source !== "offline") {
    return invalid("occurrence.source is unsupported.");
  }
  return valid({
    trustedAtMs: trustedAtMs.value,
    clientOriginAtMs: clientOriginAtMs.value,
    source: value.source,
  });
}

export function validateGrant(value: unknown): ValidationResult<ControlActionGrantProvenance> {
  if (!isRecord(value)) return invalid("grant must be an object.");
  const sessionId = validateId(value.sessionId, "grant.sessionId");
  const versionId = validateId(value.versionId, "grant.versionId");
  const authorityReference =
    value.authorityReference === undefined
      ? valid(undefined)
      : validateId(value.authorityReference, "grant.authorityReference");
  if (!sessionId.ok) return sessionId;
  if (!versionId.ok) return versionId;
  if (!authorityReference.ok) return authorityReference;
  return valid({
    sessionId: sessionId.value,
    versionId: versionId.value,
    ...(authorityReference.value === undefined
      ? {}
      : { authorityReference: authorityReference.value }),
  });
}

export function validateLifecycle(value: unknown): ValidationResult<ControlActionLifecycleContext> {
  if (!isRecord(value)) return invalid("lifecycle must be an object.");
  if (
    value.phase !== "scheduled" &&
    value.phase !== "in-progress" &&
    value.phase !== "suspended" &&
    value.phase !== "finished"
  ) {
    return invalid("lifecycle.phase is unsupported.");
  }
  const commencedAtMs = validateNullableTimestamp(value.commencedAtMs, "lifecycle.commencedAtMs");
  const finishedAtMs = validateNullableTimestamp(value.finishedAtMs, "lifecycle.finishedAtMs");
  const lockedAtMs = validateNullableTimestamp(value.lockedAtMs, "lifecycle.lockedAtMs");
  if (!commencedAtMs.ok) return commencedAtMs;
  if (!finishedAtMs.ok) return finishedAtMs;
  if (!lockedAtMs.ok) return lockedAtMs;
  if (
    value.lockReason !== null &&
    value.lockReason !== "finished-inactivity" &&
    value.lockReason !== "administrative"
  ) {
    return invalid("lifecycle.lockReason is unsupported.");
  }
  return valid({
    phase: value.phase,
    commencedAtMs: commencedAtMs.value,
    finishedAtMs: finishedAtMs.value,
    lockedAtMs: lockedAtMs.value,
    lockReason: value.lockReason,
  });
}

export function validateOverride(
  value: unknown,
): ValidationResult<OfficialOverrideMetadata | undefined> {
  if (value === undefined) return valid(undefined);
  if (!isRecord(value)) return invalid("override must be an object.");
  const guardrail = validateId(value.guardrail, "override.guardrail");
  const direction = validateId(value.direction, "override.direction");
  const confirmation = validateId(value.confirmation, "override.confirmation");
  const authorityReference = validateId(value.authorityReference, "override.authorityReference");
  const gameTimeMs = validateIntegerInRange(
    value.gameTimeMs,
    0,
    SHARED_LIMITS.clock.maxMs,
    "override.gameTimeMs",
  );
  const beforeValue =
    value.beforeValue === undefined
      ? valid(undefined)
      : parseJsonValue(value.beforeValue, "override.beforeValue");
  const afterValue =
    value.afterValue === undefined
      ? valid(undefined)
      : parseJsonValue(value.afterValue, "override.afterValue");
  const reason = validateOptionalBoundedText(value.reason, "override.reason");
  const note = validateOptionalBoundedText(value.note, "override.note");
  if (!guardrail.ok) return guardrail;
  if (!direction.ok) return direction;
  if (!confirmation.ok) return confirmation;
  if (!authorityReference.ok) return authorityReference;
  if (!gameTimeMs.ok) return gameTimeMs;
  if (!beforeValue.ok) return beforeValue;
  if (!afterValue.ok) return afterValue;
  if (!reason.ok) return reason;
  if (!note.ok) return note;
  return valid({
    guardrail: guardrail.value,
    direction: direction.value,
    confirmation: confirmation.value,
    authorityReference: authorityReference.value,
    gameTimeMs: gameTimeMs.value,
    ...(beforeValue.value === undefined ? {} : { beforeValue: beforeValue.value }),
    ...(afterValue.value === undefined ? {} : { afterValue: afterValue.value }),
    ...(reason.value === undefined ? {} : { reason: reason.value }),
    ...(note.value === undefined ? {} : { note: note.value }),
  });
}

export function validateRecoveryProvenance(
  value: unknown,
  root: EventGameRecordRoot,
  operationId: string,
): ValidationResult<ControlActionRecoveryProvenance | undefined> {
  const shape = validateRecoveryProvenanceShape(value);
  if (!shape.ok) return shape;
  if (shape.value === undefined) return shape;
  const provenance = shape.value;
  if (
    provenance.sourceRecordId !== root.recordId ||
    provenance.sourceEventGameId !== root.eventGameId
  ) {
    return invalid("recoveryProvenance references another Event Game Record.");
  }
  if (provenance.sourceOperationId !== operationId) {
    return invalid("recoveryProvenance.sourceOperationId must match operationId.");
  }
  return shape;
}

export function validateRecoveryProvenanceShape(
  value: unknown,
): ValidationResult<ControlActionRecoveryProvenance | undefined> {
  if (value === undefined) return valid(undefined);
  if (!isRecord(value)) return invalid("recoveryProvenance must be an object.");
  const importId = validateId(value.importId, "recoveryProvenance.importId");
  const sourceRecordId = validateId(value.sourceRecordId, "recoveryProvenance.sourceRecordId");
  const sourceEventGameId = validateId(
    value.sourceEventGameId,
    "recoveryProvenance.sourceEventGameId",
  );
  const sourceOperationId = validateId(
    value.sourceOperationId,
    "recoveryProvenance.sourceOperationId",
  );
  const sourceReference = validateId(value.sourceReference, "recoveryProvenance.sourceReference");
  const sourceAcceptedAtMs = validateNullableTimestamp(
    value.sourceAcceptedAtMs,
    "recoveryProvenance.sourceAcceptedAtMs",
  );
  if (!importId.ok) return importId;
  if (!sourceRecordId.ok) return sourceRecordId;
  if (!sourceEventGameId.ok) return sourceEventGameId;
  if (!sourceOperationId.ok) return sourceOperationId;
  if (!sourceReference.ok) return sourceReference;
  if (!sourceAcceptedAtMs.ok) return sourceAcceptedAtMs;
  return valid({
    importId: importId.value,
    sourceRecordId: sourceRecordId.value,
    sourceEventGameId: sourceEventGameId.value,
    sourceOperationId: sourceOperationId.value,
    sourceReference: sourceReference.value,
    sourceAcceptedAtMs: sourceAcceptedAtMs.value,
  });
}

function validateOptionalBoundedText(
  value: unknown,
  field: string,
): ValidationResult<string | undefined> {
  if (value === undefined) return valid(undefined);
  if (typeof value !== "string") return invalid(`${field} must be a string.`);
  const normalized = value.trim().normalize("NFC");
  if (Array.from(normalized).length > SHARED_LIMITS.names.operatorNoteMaxCodePoints) {
    return invalid(
      `${field} exceeds ${SHARED_LIMITS.names.operatorNoteMaxCodePoints} Unicode code points.`,
    );
  }
  return valid(normalized);
}

export function validateInterpretation(
  value: unknown,
): ValidationResult<ControlActionInterpretation> {
  if (!isRecord(value)) return invalid("Action interpreter output must be an object.");
  if (value.type === "fact") {
    const factId = validateId(value.factId, "interpretation.factId");
    const factType = validateId(value.factType, "interpretation.factType");
    const gameSideId =
      value.gameSideId === null
        ? valid(null)
        : validateId(value.gameSideId, "interpretation.gameSideId");
    const payload = parseJsonValue(value.payload, "interpretation.payload");
    if (!factId.ok) return factId;
    if (!factType.ok) return factType;
    if (!gameSideId.ok) return gameSideId;
    if (!payload.ok) return payload;
    return valid({
      type: "fact",
      factId: factId.value,
      factType: factType.value,
      gameSideId: gameSideId.value,
      payload: payload.value,
    });
  }
  if (value.type === "correction") {
    const correctionId = validateId(value.correctionId, "interpretation.correctionId");
    const targetFactId = validateId(value.targetFactId, "interpretation.targetFactId");
    if (!correctionId.ok) return correctionId;
    if (!targetFactId.ok) return targetFactId;
    if (typeof value.effective !== "boolean") {
      return invalid("interpretation.effective must be boolean.");
    }
    return valid({
      type: "correction",
      correctionId: correctionId.value,
      targetFactId: targetFactId.value,
      effective: value.effective,
    });
  }
  if (value.type === "team-assignment-correction") {
    const correctionId = validateId(value.correctionId, "interpretation.correctionId");
    const gameSideId = validateId(value.gameSideId, "interpretation.gameSideId");
    const eventTeamId = validateId(value.eventTeamId, "interpretation.eventTeamId");
    const teamInterpretationRef = validateId(
      value.teamInterpretationRef,
      "interpretation.teamInterpretationRef",
    );
    const eventTeamName =
      value.eventTeamName === undefined
        ? valid(undefined)
        : validateId(value.eventTeamName, "interpretation.eventTeamName");
    if (!correctionId.ok) return correctionId;
    if (!gameSideId.ok) return gameSideId;
    if (!eventTeamId.ok) return eventTeamId;
    if (!teamInterpretationRef.ok) return teamInterpretationRef;
    if (!eventTeamName.ok) return eventTeamName;
    return valid({
      type: "team-assignment-correction",
      correctionId: correctionId.value,
      gameSideId: gameSideId.value,
      eventTeamId: eventTeamId.value,
      teamInterpretationRef: teamInterpretationRef.value,
      ...(eventTeamName.value === undefined ? {} : { eventTeamName: eventTeamName.value }),
    });
  }
  if (value.type === "non-fact") {
    const stableId = validateId(value.stableId, "interpretation.stableId");
    return stableId.ok ? valid({ type: "non-fact", stableId: stableId.value }) : stableId;
  }
  return invalid("Action interpreter output type is unsupported.");
}

function registerCodec(byKey: Map<string, ControlActionCodec>, codec: ControlActionCodec): void {
  if (!codec || typeof codec !== "object") throw new TypeError("Control Action codec is invalid.");
  const kind = validateId(codec.kind, "codec.kind");
  const version = validateId(codec.version, "codec.version");
  if (!kind.ok || !version.ok) throw new TypeError("Control Action codec identity is invalid.");
  if (
    typeof codec.decode !== "function" ||
    typeof codec.canonicalize !== "function" ||
    typeof codec.fingerprint !== "function" ||
    typeof codec.interpret !== "function"
  ) {
    throw new TypeError(
      "Control Action codec must provide decode, canonicalize, fingerprint, and interpret.",
    );
  }
  const key = codecKey(kind.value, version.value);
  if (byKey.has(key)) throw new TypeError("Control Action codec identity is already registered.");
  byKey.set(key, codec);
}

function codecKey(kind: string, version: string): string {
  return `${kind}\u0000${version}`;
}

export function sameLifecycle(
  left: ControlActionLifecycleContext,
  right: EventGameRecordRoot["lifecycle"],
): boolean {
  return (
    left.phase === right.phase &&
    left.commencedAtMs === right.commencedAtMs &&
    left.finishedAtMs === right.finishedAtMs &&
    left.lockedAtMs === right.lockedAtMs &&
    left.lockReason === right.lockReason
  );
}

export function parseJsonValue(value: unknown, field: string): ValidationResult<ActionJsonValue> {
  try {
    const canonical = canonicalizeJson(value);
    return valid(JSON.parse(canonical) as ActionJsonValue);
  } catch {
    return invalid(`${field} must contain only canonical JSON values.`);
  }
}

export function validateStoredInput(
  value: Record<string, unknown>,
): ValidationResult<ControlActionInput> {
  const recordId = validateId(value.recordId, "recordId");
  const eventGameId = validateId(value.eventGameId, "eventGameId");
  const operationId = validateId(value.operationId, "operationId");
  const kind = validateKind(value.kind);
  const predecessors = validatePredecessors(value.causalPredecessorIds);
  const occurrence = validateOccurrenceWithoutClock(value.occurrence);
  const origin: ValidationResult<ControlActionOrigin | undefined> =
    value.origin === undefined
      ? valid(undefined)
      : value.origin === "controller" ||
          value.origin === "system-heat-stoppage" ||
          value.origin === "event-admin"
        ? valid(value.origin)
        : invalid("origin is unsupported.");
  const grant =
    (value.origin === "system-heat-stoppage" || value.origin === "event-admin") &&
    value.grant === null
      ? valid(null)
      : validateGrant(value.grant);
  const lifecycle = validateLifecycle(value.lifecycle);
  const payload = parseJsonValue(value.payload, "payload");
  const override = validateOverride(value.override);
  const recoveryProvenance = validateRecoveryProvenanceShape(value.recoveryProvenance);
  if (!recordId.ok) return recordId;
  if (!eventGameId.ok) return eventGameId;
  if (!operationId.ok) return operationId;
  if (!kind.ok) return kind;
  if (!predecessors.ok) return predecessors;
  if (!occurrence.ok) return occurrence;
  if (!grant.ok) return grant;
  if (!origin.ok) return origin;
  if (!lifecycle.ok) return lifecycle;
  if (!payload.ok) return payload;
  if (!override.ok) return override;
  if (!recoveryProvenance.ok) return recoveryProvenance;
  return valid({
    recordId: recordId.value,
    eventGameId: eventGameId.value,
    operationId: operationId.value,
    kind: kind.value,
    payload: payload.value,
    causalPredecessorIds: predecessors.value,
    occurrence: occurrence.value,
    grant: grant.value,
    ...(origin.value === undefined ? {} : { origin: origin.value }),
    lifecycle: lifecycle.value,
    ...(override.value === undefined ? {} : { override: override.value }),
    ...(recoveryProvenance.value === undefined
      ? {}
      : { recoveryProvenance: recoveryProvenance.value }),
  });
}

export function validateId(value: unknown, field: string): ValidationResult<string> {
  return validateOpaqueIdentifier(value, field);
}

export function validateTimestamp(value: unknown, field: string): ValidationResult<number> {
  return validateIntegerInRange(value, 0, MAX_TIMESTAMP_MS, field);
}

function validateNullableTimestamp(value: unknown, field: string): ValidationResult<number | null> {
  return value === null ? valid(null) : validateTimestamp(value, field);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function valid<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

export function invalid<T>(error: string): ValidationResult<T> {
  return { ok: false, error };
}
