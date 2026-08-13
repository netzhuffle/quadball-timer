import {
  validateIntegerInRange,
  validateOpaqueIdentifier,
  type ValidationResult,
} from "@/lib/validation-policy";

export type EventGameLifecyclePhase = "scheduled" | "in-progress" | "suspended" | "finished";

export type EventGameRecordSide = {
  id: string;
  eventTeamId: string;
  teamInterpretationRef: string;
};

export type EventGameRecordRoot = {
  recordId: string;
  eventId: string;
  eventGameId: string;
  ownership: {
    eventId: string;
    eventGameId: string;
  };
  externalScope: {
    eventId: string;
    gameDayId: string;
    pitchId: string;
    pitchSlotId: string;
  };
  gameSides: readonly [EventGameRecordSide, EventGameRecordSide];
  lifecycle: {
    phase: EventGameLifecyclePhase;
    commencedAtMs: number | null;
    finishedAtMs: number | null;
    lockedAtMs: number | null;
    lockReason: "finished-inactivity" | "administrative" | null;
  };
  compatibility: {
    recordVersion: string;
    schemaVersion: string;
    interpreterVersion: string;
  };
  creationEvidence: {
    operationId: string;
    actorReference: string;
    source: "event-game-registration";
    createdAtMs: number;
  };
};

export type RootValidationResult = ValidationResult<EventGameRecordRoot>;

const MAX_TIMESTAMP_MS = Number.MAX_SAFE_INTEGER;

export function validateEventGameRecordRoot(value: unknown): RootValidationResult {
  if (!isRecord(value)) {
    return invalid("Event Game Record root must be an object.");
  }

  const recordId = validateId(value.recordId, "recordId");
  const eventId = validateId(value.eventId, "eventId");
  const eventGameId = validateId(value.eventGameId, "eventGameId");
  if (!recordId.ok) return recordId;
  if (!eventId.ok) return eventId;
  if (!eventGameId.ok) return eventGameId;

  const ownership = validateOwnership(value.ownership);
  if (!ownership.ok) return ownership;
  if (ownership.value.eventId !== eventId.value) {
    return invalid("ownership.eventId must match eventId.");
  }
  if (ownership.value.eventGameId !== eventGameId.value) {
    return invalid("ownership.eventGameId must match eventGameId.");
  }

  const externalScope = validateExternalScope(value.externalScope);
  if (!externalScope.ok) return externalScope;
  if (externalScope.value.eventId !== eventId.value) {
    return invalid("externalScope.eventId must match eventId.");
  }

  const gameSides = validateGameSides(value.gameSides);
  if (!gameSides.ok) return gameSides;

  const lifecycle = validateLifecycle(value.lifecycle);
  if (!lifecycle.ok) return lifecycle;

  const compatibility = validateCompatibility(value.compatibility);
  if (!compatibility.ok) return compatibility;

  const creationEvidence = validateCreationEvidence(value.creationEvidence);
  if (!creationEvidence.ok) return creationEvidence;

  return valid({
    recordId: recordId.value,
    eventId: eventId.value,
    eventGameId: eventGameId.value,
    ownership: ownership.value,
    externalScope: externalScope.value,
    gameSides: gameSides.value,
    lifecycle: lifecycle.value,
    compatibility: compatibility.value,
    creationEvidence: creationEvidence.value,
  });
}

export function canonicalizeEventGameRecordRoot(root: EventGameRecordRoot): string {
  return JSON.stringify(sortJsonValue(root));
}

export function cloneEventGameRecordRoot(root: EventGameRecordRoot): EventGameRecordRoot {
  return structuredClone(root);
}

function validateOwnership(value: unknown): ValidationResult<EventGameRecordRoot["ownership"]> {
  if (!isRecord(value)) return invalid("ownership must be an object.");

  const eventId = validateId(value.eventId, "ownership.eventId");
  const eventGameId = validateId(value.eventGameId, "ownership.eventGameId");
  if (!eventId.ok) return eventId;
  if (!eventGameId.ok) return eventGameId;

  return valid({ eventId: eventId.value, eventGameId: eventGameId.value });
}

function validateExternalScope(
  value: unknown,
): ValidationResult<EventGameRecordRoot["externalScope"]> {
  if (!isRecord(value)) return invalid("externalScope must be an object.");

  const eventId = validateId(value.eventId, "externalScope.eventId");
  const gameDayId = validateId(value.gameDayId, "externalScope.gameDayId");
  const pitchId = validateId(value.pitchId, "externalScope.pitchId");
  const pitchSlotId = validateId(value.pitchSlotId, "externalScope.pitchSlotId");
  if (!eventId.ok) return eventId;
  if (!gameDayId.ok) return gameDayId;
  if (!pitchId.ok) return pitchId;
  if (!pitchSlotId.ok) return pitchSlotId;

  return valid({
    eventId: eventId.value,
    gameDayId: gameDayId.value,
    pitchId: pitchId.value,
    pitchSlotId: pitchSlotId.value,
  });
}

function validateGameSides(value: unknown): ValidationResult<EventGameRecordRoot["gameSides"]> {
  if (!Array.isArray(value) || value.length !== 2) {
    return invalid("gameSides must contain exactly two stable sides.");
  }

  const sides: EventGameRecordSide[] = [];
  const sideIds = new Set<string>();
  const eventTeamIds = new Set<string>();
  for (const [index, sideValue] of value.entries()) {
    if (!isRecord(sideValue)) return invalid(`gameSides[${index}] must be an object.`);

    const id = validateId(sideValue.id, `gameSides[${index}].id`);
    const eventTeamId = validateId(sideValue.eventTeamId, `gameSides[${index}].eventTeamId`);
    const teamInterpretationRef = validateId(
      sideValue.teamInterpretationRef,
      `gameSides[${index}].teamInterpretationRef`,
    );
    if (!id.ok) return id;
    if (!eventTeamId.ok) return eventTeamId;
    if (!teamInterpretationRef.ok) return teamInterpretationRef;

    if (!sideIds.add(id.value)) {
      return invalid("gameSides must have distinct stable side identities.");
    }
    if (!eventTeamIds.add(eventTeamId.value)) {
      return invalid("gameSides must reference distinct Event Teams.");
    }

    sides.push({
      id: id.value,
      eventTeamId: eventTeamId.value,
      teamInterpretationRef: teamInterpretationRef.value,
    });
  }

  const first = sides[0];
  const second = sides[1];
  if (first === undefined || second === undefined) {
    return invalid("gameSides must contain exactly two stable sides.");
  }

  return valid([first, second]);
}

function validateLifecycle(value: unknown): ValidationResult<EventGameRecordRoot["lifecycle"]> {
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
  if (lockedAtMs.value !== null && finishedAtMs.value === null) {
    return invalid("lifecycle.lockedAtMs requires lifecycle.finishedAtMs.");
  }
  if (finishedAtMs.value !== null && commencedAtMs.value === null) {
    return invalid("lifecycle.finishedAtMs requires lifecycle.commencedAtMs.");
  }
  if (
    commencedAtMs.value !== null &&
    finishedAtMs.value !== null &&
    finishedAtMs.value < commencedAtMs.value
  ) {
    return invalid("lifecycle.finishedAtMs cannot precede lifecycle.commencedAtMs.");
  }
  if (
    finishedAtMs.value !== null &&
    lockedAtMs.value !== null &&
    lockedAtMs.value < finishedAtMs.value
  ) {
    return invalid("lifecycle.lockedAtMs cannot precede lifecycle.finishedAtMs.");
  }
  if (lockedAtMs.value === null && value.lockReason !== null) {
    return invalid("lifecycle.lockReason requires lifecycle.lockedAtMs.");
  }
  if (lockedAtMs.value !== null && value.lockReason === null) {
    return invalid("lifecycle.lockedAtMs requires lifecycle.lockReason.");
  }

  return valid({
    phase: value.phase,
    commencedAtMs: commencedAtMs.value,
    finishedAtMs: finishedAtMs.value,
    lockedAtMs: lockedAtMs.value,
    lockReason: value.lockReason,
  });
}

function validateCompatibility(
  value: unknown,
): ValidationResult<EventGameRecordRoot["compatibility"]> {
  if (!isRecord(value)) return invalid("compatibility must be an object.");

  const recordVersion = validateId(value.recordVersion, "compatibility.recordVersion");
  const schemaVersion = validateId(value.schemaVersion, "compatibility.schemaVersion");
  const interpreterVersion = validateId(
    value.interpreterVersion,
    "compatibility.interpreterVersion",
  );
  if (!recordVersion.ok) return recordVersion;
  if (!schemaVersion.ok) return schemaVersion;
  if (!interpreterVersion.ok) return interpreterVersion;

  return valid({
    recordVersion: recordVersion.value,
    schemaVersion: schemaVersion.value,
    interpreterVersion: interpreterVersion.value,
  });
}

function validateCreationEvidence(
  value: unknown,
): ValidationResult<EventGameRecordRoot["creationEvidence"]> {
  if (!isRecord(value)) return invalid("creationEvidence must be an object.");
  const operationId = validateId(value.operationId, "creationEvidence.operationId");
  const actorReference = validateId(value.actorReference, "creationEvidence.actorReference");
  const createdAtMs = validateTimestamp(value.createdAtMs, "creationEvidence.createdAtMs");
  if (!operationId.ok) return operationId;
  if (!actorReference.ok) return actorReference;
  if (!createdAtMs.ok) return createdAtMs;
  if (value.source !== "event-game-registration") {
    return invalid("creationEvidence.source is unsupported.");
  }

  return valid({
    operationId: operationId.value,
    actorReference: actorReference.value,
    source: value.source,
    createdAtMs: createdAtMs.value,
  });
}

function validateId(value: unknown, field: string): ValidationResult<string> {
  return validateOpaqueIdentifier(value, field);
}

function validateTimestamp(value: unknown, field: string): ValidationResult<number> {
  return validateIntegerInRange(value, 0, MAX_TIMESTAMP_MS, field);
}

function validateNullableTimestamp(value: unknown, field: string): ValidationResult<number | null> {
  if (value === null) return valid(null);
  return validateTimestamp(value, field);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJsonValue(value[key])]),
    );
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valid<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

function invalid<T>(error: string): ValidationResult<T> {
  return { ok: false, error };
}
