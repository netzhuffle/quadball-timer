export const SHARED_LIMITS = {
  transport: {
    websocketTextFrameBytes: 256 * 1024,
    httpJsonBodyBytes: 64 * 1024,
  },
  replay: {
    maxControlActions: 100,
    maxUnacknowledgedBatchesPerGrantSession: 1,
    scheduledActionsPerSecond: 20,
  },
  identifiers: {
    opaqueMaxBytes: 128,
  },
  names: {
    teamAndPitchMaxCodePoints: 80,
    eventAndGameDesignationMaxCodePoints: 120,
    gameCodeMaxCodePoints: 32,
    operatorNoteMaxCodePoints: 240,
  },
  clock: {
    minMs: 0,
    maxMs: 120 * 60 * 1000,
    maxAdjustmentMs: 10 * 60 * 1000,
  },
  score: {
    min: 0,
    max: 1_000,
  },
  occurrence: {
    maxOnlineFutureMs: 2 * 60 * 1000,
  },
  rate: {
    perGrantSession: {
      sustainedPerSecond: 20,
      burst: 40,
    },
    perEventGame: {
      sustainedPerSecond: 50,
      burst: 100,
    },
  },
  load: {
    maxLoadedEventGames: 96,
    maxSimultaneouslyLivePitches: 6,
    maxControllersPerLiveEventGame: 2,
    maxConnectedSpectators: 500,
    maxConcurrentReplayPerLiveEventGame: 1,
  },
} as const;

export type ValidationResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: string;
    };

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function countUnicodeCodePoints(value: string): number {
  return Array.from(value).length;
}

export function normalizeBoundedText(
  value: unknown,
  maxCodePoints: number,
  field: string,
): ValidationResult<string> {
  if (typeof value !== "string") {
    return invalid(`${field} must be a string.`);
  }

  const normalized = value.trim().normalize("NFC");
  if (normalized.length === 0) {
    return invalid(`${field} must not be empty.`);
  }

  if (countUnicodeCodePoints(normalized) > maxCodePoints) {
    return invalid(`${field} exceeds ${maxCodePoints} Unicode code points.`);
  }

  return valid(normalized);
}

export function validateOpaqueIdentifier(
  value: unknown,
  field = "identifier",
): ValidationResult<string> {
  if (typeof value !== "string" || value.length === 0) {
    return invalid(`${field} must be a non-empty ASCII identifier.`);
  }

  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index) ?? 0;
    if (codePoint > 0x7f) {
      return invalid(`${field} must contain only ASCII characters.`);
    }

    if (codePoint > 0xffff) {
      index += 1;
    }
  }

  if (utf8ByteLength(value) > SHARED_LIMITS.identifiers.opaqueMaxBytes) {
    return invalid(`${field} exceeds ${SHARED_LIMITS.identifiers.opaqueMaxBytes} ASCII bytes.`);
  }

  return valid(value);
}

export function validateIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
): ValidationResult<number> {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return invalid(`${field} must be a finite number.`);
  }

  if (!Number.isInteger(value)) {
    return invalid(`${field} must be an integer.`);
  }

  if (!Number.isSafeInteger(value)) {
    return invalid(`${field} must be a safe integer.`);
  }

  if (value < minimum || value > maximum) {
    return invalid(`${field} must be between ${minimum} and ${maximum}.`);
  }

  return valid(value);
}

export function validateTeamOrPitchName(value: unknown): ValidationResult<string> {
  return normalizeBoundedText(
    value,
    SHARED_LIMITS.names.teamAndPitchMaxCodePoints,
    "team or Pitch name",
  );
}

export function validateEventName(value: unknown): ValidationResult<string> {
  return normalizeBoundedText(
    value,
    SHARED_LIMITS.names.eventAndGameDesignationMaxCodePoints,
    "Event name",
  );
}

export function validateGameDesignation(value: unknown): ValidationResult<string> {
  return normalizeBoundedText(
    value,
    SHARED_LIMITS.names.eventAndGameDesignationMaxCodePoints,
    "Game Designation",
  );
}

export function validateGameCode(value: unknown): ValidationResult<string> {
  return normalizeBoundedText(value, SHARED_LIMITS.names.gameCodeMaxCodePoints, "Game Code");
}

export function validateOperatorNote(value: unknown): ValidationResult<string> {
  return normalizeBoundedText(
    value,
    SHARED_LIMITS.names.operatorNoteMaxCodePoints,
    "operator note",
  );
}

export function validateGameClockMs(value: unknown): ValidationResult<number> {
  return validateIntegerInRange(
    value,
    SHARED_LIMITS.clock.minMs,
    SHARED_LIMITS.clock.maxMs,
    "game clock",
  );
}

export function validateClockAdjustmentMs(value: unknown): ValidationResult<number> {
  return validateIntegerInRange(
    value,
    -SHARED_LIMITS.clock.maxAdjustmentMs,
    SHARED_LIMITS.clock.maxAdjustmentMs,
    "game clock adjustment",
  );
}

export function validateDerivedScore(value: unknown): ValidationResult<number> {
  return validateIntegerInRange(
    value,
    SHARED_LIMITS.score.min,
    SHARED_LIMITS.score.max,
    "derived score",
  );
}

export function validateOnlineOccurrenceMs(
  value: unknown,
  serverNowMs: number,
): ValidationResult<number> {
  const timestamp = validateIntegerInRange(value, 0, Number.MAX_SAFE_INTEGER, "occurrence time");
  if (!timestamp.ok) {
    return timestamp;
  }

  if (!Number.isSafeInteger(serverNowMs)) {
    return invalid("server time must be a safe integer.");
  }

  if (timestamp.value > serverNowMs + SHARED_LIMITS.occurrence.maxOnlineFutureMs) {
    return invalid(
      `occurrence time must not be more than ${SHARED_LIMITS.occurrence.maxOnlineFutureMs}ms in the future.`,
    );
  }

  return timestamp;
}

export function validatePlayerNumber(value: unknown): ValidationResult<number> {
  return validateIntegerInRange(value, 0, 99, "player number");
}

function valid<T>(value: T): ValidationResult<T> {
  return {
    ok: true,
    value,
  };
}

function invalid<T>(error: string): ValidationResult<T> {
  return {
    ok: false,
    error,
  };
}
