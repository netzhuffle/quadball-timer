import { describe, expect, test } from "bun:test";
import {
  LIVE_EVENT_CONTROL_INTENT_VERSION,
  LIVE_SUSPENSION_SNAPSHOT_VERSION,
  parseLiveEventControllerIntent,
  suspensionPenaltyStateFromProjection,
} from "@/lib/live-event-game-control";
import type { LivePenaltyProjection } from "@/lib/live-event-penalties";

describe("Live Event Game suspension recovery", () => {
  test("round-trips every remaining penalty segment and score-expiry meaning", () => {
    const projection: LivePenaltyProjection = {
      cards: [],
      players: [
        {
          playerKey: "side-a:4",
          gameSideId: "side-a",
          playerNumber: 4,
          segments: [
            {
              id: "red-card:1",
              cardFactId: "red-card",
              cardType: "red",
              expirableByScore: false,
              eligibleForScoreAtGameTimeMs: 0,
              notBeforeGameTimeMs: 0,
              startsAtGameTimeMs: 0,
              endsAtGameTimeMs: 60_000,
              remainingMs: 45_000,
            },
            {
              id: "red-card:2",
              cardFactId: "red-card",
              cardType: "red",
              expirableByScore: false,
              eligibleForScoreAtGameTimeMs: 60_000,
              notBeforeGameTimeMs: 60_000,
              startsAtGameTimeMs: 60_000,
              endsAtGameTimeMs: 120_000,
              remainingMs: 60_000,
            },
          ],
        },
      ],
      pendingExpirations: [],
      releases: [],
    };

    const snapshot = suspensionPenaltyStateFromProjection(projection);
    expect(snapshot.segments).toMatchObject([
      {
        sourceFactId: "red-card:1",
        cardFactId: "red-card",
        cardType: "red",
        remainingMs: 45_000,
        expirableByScore: false,
      },
      {
        sourceFactId: "red-card:2",
        cardFactId: "red-card",
        cardType: "red",
        remainingMs: 60_000,
        expirableByScore: false,
      },
    ]);
  });

  test("requires explicit timeout and suspension lifecycle fields", () => {
    const base = {
      version: LIVE_EVENT_CONTROL_INTENT_VERSION,
      type: "substantive" as const,
      operationId: "missing-lifecycle-field",
      factId: "missing-lifecycle-fact",
      gameTimeMs: 0,
      occurrence: { clientOriginAtMs: null },
    };

    expect(parseLiveEventControllerIntent({ ...base, trigger: "timeout" })).toMatchObject({
      ok: false,
    });
    expect(
      parseLiveEventControllerIntent({
        ...base,
        trigger: "timeout",
        timeoutAction: "stoppage",
      }),
    ).toMatchObject({ ok: false });
    expect(parseLiveEventControllerIntent({ ...base, trigger: "suspension" })).toMatchObject({
      ok: false,
    });
    expect(
      parseLiveEventControllerIntent({
        ...base,
        trigger: "suspension",
        suspensionAction: "resume",
      }),
    ).toMatchObject({ ok: false });
  });

  test("keeps the versioned possession snapshot shape explicit", () => {
    const parsed = parseLiveEventControllerIntent({
      version: LIVE_EVENT_CONTROL_INTENT_VERSION,
      type: "substantive",
      trigger: "suspension",
      operationId: "snapshot-shape",
      factId: "snapshot-shape-fact",
      gameTimeMs: 0,
      suspensionAction: "start",
      suspensionSnapshot: {
        version: LIVE_SUSPENSION_SNAPSHOT_VERSION,
        gameTimeMs: 0,
        scoreByGameSide: { "side-a": 0, "side-b": 0 },
        penalties: { segments: [] },
        volleyballPossession: "side-a",
        dodgeballPossession: { "ball-1": "side-a" },
      },
      occurrence: { clientOriginAtMs: null },
    });
    expect(parsed.ok).toBe(true);
  });
});
