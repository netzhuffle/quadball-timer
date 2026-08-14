import { describe, expect, test } from "bun:test";
import {
  SHARED_LIMITS,
  countUnicodeCodePoints,
  normalizeBoundedText,
  utf8ByteLength,
  validateClockAdjustmentMs,
  validateDerivedScore,
  validateEventName,
  validateGameClockMs,
  validateGameCode,
  validateGameDesignation,
  validateIntegerInRange,
  validateOnlineOccurrenceMs,
  validateOpaqueIdentifier,
  validateOperatorNote,
  validateTeamOrPitchName,
} from "@/lib/validation-policy";

describe("validation-policy", () => {
  test("exports the shared foundation limits as one policy", () => {
    expect(SHARED_LIMITS.transport.websocketTextFrameBytes).toBe(256 * 1024);
    expect(SHARED_LIMITS.transport.httpJsonBodyBytes).toBe(64 * 1024);
    expect(SHARED_LIMITS.replay.maxControlActions).toBe(100);
    expect(SHARED_LIMITS.identifiers.opaqueMaxBytes).toBe(128);
    expect(SHARED_LIMITS.names.teamAndPitchMaxCodePoints).toBe(80);
    expect(SHARED_LIMITS.names.eventAndGameDesignationMaxCodePoints).toBe(120);
    expect(SHARED_LIMITS.names.gameCodeMaxCodePoints).toBe(32);
    expect(SHARED_LIMITS.names.operatorNoteMaxCodePoints).toBe(240);
    expect(SHARED_LIMITS.clock.maxMs).toBe(120 * 60 * 1000);
    expect(SHARED_LIMITS.clock.maxAdjustmentMs).toBe(10 * 60 * 1000);
    expect(SHARED_LIMITS.score.max).toBe(1_000);
    expect(SHARED_LIMITS.occurrence.maxOnlineFutureMs).toBe(120_000);
    expect(SHARED_LIMITS.rate.perGrantSession.sustainedPerSecond).toBe(20);
    expect(SHARED_LIMITS.rate.perGrantSession.burst).toBe(40);
    expect(SHARED_LIMITS.rate.perEventGame.sustainedPerSecond).toBe(50);
    expect(SHARED_LIMITS.rate.perEventGame.burst).toBe(100);
  });

  test("normalizes trimmed text and counts Unicode code points", () => {
    const result = normalizeBoundedText("  A\u0308  ", 1, "team name");

    expect(result).toEqual({ ok: true, value: "Ä" });
    expect(countUnicodeCodePoints("😀")).toBe(1);
  });

  test("accepts and rejects text boundaries without truncating", () => {
    const cases = [
      { label: "team name at the limit", value: "a".repeat(80), max: 80, ok: true },
      { label: "team name over the limit", value: "a".repeat(81), max: 80, ok: false },
      { label: "operator note at the limit", value: "a".repeat(240), max: 240, ok: true },
      { label: "operator note over the limit", value: "a".repeat(241), max: 240, ok: false },
    ];

    for (const testCase of cases) {
      const result = normalizeBoundedText(testCase.value, testCase.max, testCase.label);
      expect(result.ok, testCase.label).toBe(testCase.ok);
      if (testCase.ok) {
        expect(result).toEqual({ ok: true, value: testCase.value });
      }
    }
  });

  test("validates opaque identifiers as non-empty ASCII byte strings", () => {
    const cases = [
      { value: "a".repeat(128), ok: true },
      { value: "a".repeat(129), ok: false },
      { value: "café", ok: false },
      { value: "", ok: false },
    ];

    for (const testCase of cases) {
      expect(validateOpaqueIdentifier(testCase.value).ok).toBe(testCase.ok);
    }
  });

  test("normalizes each named text domain through the same policy", () => {
    expect(validateTeamOrPitchName("  Cafe\u0301  ")).toEqual({
      ok: true,
      value: "Café",
    });
    expect(validateGameCode("  UB.QF.1  ")).toEqual({ ok: true, value: "UB.QF.1" });
    expect(validateOperatorNote("  reason  ")).toEqual({ ok: true, value: "reason" });
    expect(validateGameCode("a".repeat(33)).ok).toBe(false);
  });

  test("accepts every named text domain at its exact boundary and rejects one step over", () => {
    const cases = [
      {
        label: "Event name",
        maximum: SHARED_LIMITS.names.eventAndGameDesignationMaxCodePoints,
        validate: validateEventName,
      },
      {
        label: "Game Designation",
        maximum: SHARED_LIMITS.names.eventAndGameDesignationMaxCodePoints,
        validate: validateGameDesignation,
      },
      {
        label: "Game Code",
        maximum: SHARED_LIMITS.names.gameCodeMaxCodePoints,
        validate: validateGameCode,
      },
      {
        label: "Team or Pitch name",
        maximum: SHARED_LIMITS.names.teamAndPitchMaxCodePoints,
        validate: validateTeamOrPitchName,
      },
      {
        label: "operator note",
        maximum: SHARED_LIMITS.names.operatorNoteMaxCodePoints,
        validate: validateOperatorNote,
      },
    ];

    for (const testCase of cases) {
      expect(testCase.validate("a".repeat(testCase.maximum)).ok, `${testCase.label} exact`).toBe(
        true,
      );
      expect(
        testCase.validate("a".repeat(testCase.maximum + 1)).ok,
        `${testCase.label} one over`,
      ).toBe(false);
    }
  });

  test("rejects non-finite, fractional, unsafe, and out-of-domain numbers", () => {
    const cases = [
      { value: Number.NaN, ok: false },
      { value: Number.POSITIVE_INFINITY, ok: false },
      { value: 1.5, ok: false },
      { value: Number.MAX_SAFE_INTEGER + 1, ok: false },
      { value: 0, ok: true },
      { value: 1_000, ok: true },
      { value: 1_001, ok: false },
    ];

    for (const testCase of cases) {
      expect(validateIntegerInRange(testCase.value, 0, 1_000, "score").ok).toBe(testCase.ok);
    }
  });

  test("enforces clock, adjustment, score, and occurrence boundaries", () => {
    const cases = [
      {
        label: "game clock minimum",
        validate: (value: number) => validateGameClockMs(value),
        minimum: SHARED_LIMITS.clock.minMs,
        maximum: SHARED_LIMITS.clock.maxMs,
      },
      {
        label: "clock adjustment",
        validate: (value: number) => validateClockAdjustmentMs(value),
        minimum: -SHARED_LIMITS.clock.maxAdjustmentMs,
        maximum: SHARED_LIMITS.clock.maxAdjustmentMs,
      },
      {
        label: "derived score",
        validate: (value: number) => validateDerivedScore(value),
        minimum: SHARED_LIMITS.score.min,
        maximum: SHARED_LIMITS.score.max,
      },
    ];

    for (const testCase of cases) {
      expect(testCase.validate(testCase.minimum).ok, `${testCase.label} minimum`).toBe(true);
      expect(testCase.validate(testCase.maximum).ok, `${testCase.label} maximum`).toBe(true);
      expect(testCase.validate(testCase.minimum - 1).ok, `${testCase.label} below`).toBe(false);
      expect(testCase.validate(testCase.maximum + 1).ok, `${testCase.label} above`).toBe(false);
    }

    expect(validateClockAdjustmentMs(-SHARED_LIMITS.clock.maxAdjustmentMs).ok).toBe(true);
    expect(validateClockAdjustmentMs(SHARED_LIMITS.clock.maxAdjustmentMs).ok).toBe(true);
    expect(validateClockAdjustmentMs(-SHARED_LIMITS.clock.maxAdjustmentMs - 1).ok).toBe(false);
    expect(validateClockAdjustmentMs(SHARED_LIMITS.clock.maxAdjustmentMs + 1).ok).toBe(false);

    const occurrenceMaximum = 1_000 + SHARED_LIMITS.occurrence.maxOnlineFutureMs;
    expect(validateOnlineOccurrenceMs(0, 1_000).ok).toBe(true);
    expect(validateOnlineOccurrenceMs(occurrenceMaximum, 1_000).ok).toBe(true);
    expect(validateOnlineOccurrenceMs(-1, 1_000).ok).toBe(false);
    expect(validateOnlineOccurrenceMs(occurrenceMaximum + 1, 1_000).ok).toBe(false);
  });

  test("checks exact and one-step-invalid count budgets through the shared integer validator", () => {
    const cases = [
      ["replay batch", SHARED_LIMITS.replay.maxControlActions],
      [
        "unacknowledged Grant Session batches",
        SHARED_LIMITS.replay.maxUnacknowledgedBatchesPerGrantSession,
      ],
      ["scheduled actions per second", SHARED_LIMITS.replay.scheduledActionsPerSecond],
      ["grant-session sustained rate", SHARED_LIMITS.rate.perGrantSession.sustainedPerSecond],
      ["grant-session burst", SHARED_LIMITS.rate.perGrantSession.burst],
      ["event-game sustained rate", SHARED_LIMITS.rate.perEventGame.sustainedPerSecond],
      ["event-game burst", SHARED_LIMITS.rate.perEventGame.burst],
      ["loaded Event Games", SHARED_LIMITS.load.maxLoadedEventGames],
      ["live Pitches", SHARED_LIMITS.load.maxSimultaneouslyLivePitches],
      ["live Controllers", SHARED_LIMITS.load.maxControllersPerLiveEventGame],
      ["connected spectators", SHARED_LIMITS.load.maxConnectedSpectators],
      ["concurrent replay", SHARED_LIMITS.load.maxConcurrentReplayPerLiveEventGame],
    ] as const;

    for (const [label, maximum] of cases) {
      expect(validateIntegerInRange(maximum, 0, maximum, label).ok, `${label} exact`).toBe(true);
      expect(validateIntegerInRange(maximum + 1, 0, maximum, label).ok, `${label} one over`).toBe(
        false,
      );
    }
  });

  test("measures transport payloads in UTF-8 bytes", () => {
    expect(utf8ByteLength("😀")).toBe(4);
    expect(utf8ByteLength("a".repeat(SHARED_LIMITS.transport.websocketTextFrameBytes))).toBe(
      SHARED_LIMITS.transport.websocketTextFrameBytes,
    );
  });
});
