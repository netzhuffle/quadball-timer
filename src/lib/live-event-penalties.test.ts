import { describe, expect, test } from "bun:test";
import {
  deriveLivePenaltyProjection,
  LIVE_PENALTY_MINUTE_MS,
  LIVE_SEEKER_RELEASE_MS,
  parseLivePenaltyPlayerKey,
  type LivePenaltyFact,
} from "@/lib/live-event-penalties";

let nextSync = 0;

function fact(
  factType: string,
  factId: string,
  gameSideId: string | null,
  gameTimeMs: number,
  data: Record<string, unknown> = {},
): LivePenaltyFact {
  nextSync += 1;
  return {
    factType,
    factId,
    gameSideId,
    gameTimeMs,
    sportingOrder: gameTimeMs,
    synchronizationOrder: nextSync,
    effective: true,
    data,
  } as LivePenaltyFact;
}

function card(
  factId: string,
  playerNumber: number,
  gameTimeMs: number,
  cardType: "blue" | "yellow" | "red",
  extra: Record<string, unknown> = {},
) {
  return fact("card", factId, "away", gameTimeMs, {
    cardType,
    playerNumber,
    penaltyStart: "immediate",
    ...extra,
  });
}

describe("live Event Game penalty timing", () => {
  test("parses only canonical side:number penalty player keys", () => {
    expect(parseLivePenaltyPlayerKey("away:7")).toEqual({
      gameSideId: "away",
      playerNumber: 7,
    });
    expect(parseLivePenaltyPlayerKey("away:unknown:card-1")).toBeNull();
    expect(parseLivePenaltyPlayerKey("away:not-a-number")).toBeNull();
  });

  test("blue and yellow have one expirable minute while red has two consecutive non-expirable minutes", () => {
    const projection = deriveLivePenaltyProjection(
      [
        card("blue-card", 1, 0, "blue"),
        card("yellow-card", 2, 0, "yellow"),
        card("red-card", 3, 0, "red"),
      ],
      30_000,
    );

    expect(projection.players).toMatchObject([
      { playerNumber: 1, segments: [{ expirableByScore: true, remainingMs: 30_000 }] },
      { playerNumber: 2, segments: [{ expirableByScore: true, remainingMs: 30_000 }] },
      {
        playerNumber: 3,
        segments: [
          { expirableByScore: false, remainingMs: 30_000 },
          { expirableByScore: false, remainingMs: 60_000 },
        ],
      },
    ]);
  });

  test("multiple penalties serve in assessment order and follow the Game Clock, not wall time", () => {
    const projection = deriveLivePenaltyProjection(
      [card("first", 7, 10_000, "blue"), card("second", 7, 20_000, "yellow")],
      80_000,
    );

    expect(projection.players[0]?.segments).toMatchObject([
      { cardFactId: "second", remainingMs: 50_000 },
    ]);
  });

  test("does not release a blue minute queued behind a red card before that minute starts", () => {
    const beforeBlueStarts = deriveLivePenaltyProjection(
      [
        card("red-card", 1, 0, "red"),
        card("blue-card", 1, 0, "blue"),
        fact("goal", "early-goal", "home", 30_000, { points: 10, sportingOrder: 30_000 }),
      ],
      30_000,
    );

    expect(beforeBlueStarts.pendingExpirations).toHaveLength(0);
    expect(beforeBlueStarts.releases).toHaveLength(0);
    expect(beforeBlueStarts.players).toMatchObject([
      {
        playerNumber: 1,
        segments: [
          { cardType: "red", expirableByScore: false, remainingMs: 30_000 },
          { cardType: "red", expirableByScore: false, remainingMs: 60_000 },
          { cardType: "blue", expirableByScore: true, startsAtGameTimeMs: 120_000 },
        ],
      },
    ]);

    const afterBlueStarts = deriveLivePenaltyProjection(
      [
        card("red-card", 1, 0, "red"),
        card("blue-card", 1, 0, "blue"),
        fact("goal", "late-goal", "home", 120_000, { points: 10, sportingOrder: 120_000 }),
      ],
      120_000,
    );

    expect(afterBlueStarts.releases).toMatchObject([
      { id: "penalty-expiration:late-goal", playerKey: "away:1", releaseCause: "score" },
    ]);
  });

  test("starts the next assessed blue segment at the early score sporting time", () => {
    const projection = deriveLivePenaltyProjection(
      [
        card("red", 20, 0, "red"),
        card("blue-one", 20, 0, "blue"),
        card("blue-two", 20, 0, "blue"),
        fact("goal", "release-blue-one", "home", 150_000, { points: 10 }),
      ],
      150_000,
    );

    expect(projection.releases).toMatchObject([
      { scoreFactId: "release-blue-one", playerKey: "away:20" },
    ]);
    expect(projection.players).toMatchObject([
      {
        playerNumber: 20,
        segments: [{ cardFactId: "blue-two", startsAtGameTimeMs: 150_000 }],
      },
    ]);
  });

  test("compaction respects a deferred seeker floor through mixed red and repeated blue service", () => {
    const projection = deriveLivePenaltyProjection(
      [
        card("red-floor", 22, 0, "red"),
        card("blue-active", 22, 0, "blue"),
        card("blue-deferred", 22, 19 * LIVE_PENALTY_MINUTE_MS + 30_000, "blue", {
          penaltyStart: "seeker-release",
        }),
        card("blue-after-floor", 22, LIVE_SEEKER_RELEASE_MS, "blue"),
        fact("goal", "release-active", "home", 150_000, { points: 10 }),
      ],
      150_000,
    );

    expect(projection.releases).toMatchObject([
      { scoreFactId: "release-active", playerKey: "away:22", releaseCause: "score" },
    ]);
    const deferred = projection.players
      .find((player) => player.playerKey === "away:22")
      ?.segments.find((segment) => segment.cardFactId === "blue-deferred");
    expect(deferred).toMatchObject({
      startsAtGameTimeMs: LIVE_SEEKER_RELEASE_MS,
      notBeforeGameTimeMs: LIVE_SEEKER_RELEASE_MS,
    });
  });

  test("opposing score chooses the least remaining eligible minute and records complete ties", () => {
    const projection = deriveLivePenaltyProjection(
      [
        card("one", 2, 0, "blue"),
        card("tie", 3, 20_000, "blue"),
        fact("goal", "goal-1", "home", 30_000, { points: 10, sportingOrder: 30_000 }),
      ],
      30_000,
    );

    expect(projection.releases).toMatchObject([
      { scoreFactId: "goal-1", playerKey: "away:2", releaseCause: "score" },
    ]);

    const tieProjection = deriveLivePenaltyProjection(
      [
        card("tie-a", 4, 0, "blue"),
        card("tie-b", 5, 0, "blue"),
        fact("goal", "goal-tie", "home", 0, { points: 10, sportingOrder: 0 }),
      ],
      0,
    );
    expect(tieProjection.pendingExpirations[0]).toMatchObject({
      candidatePlayerKeys: ["away:4", "away:5"],
      requiresOfficialChoice: true,
    });
  });

  test("counts queued expirable minutes for priority but releases only an active minute", () => {
    const projection = deriveLivePenaltyProjection(
      [
        card("two-first", 14, 0, "blue"),
        card("two-second", 14, 0, "yellow"),
        card("one", 15, 0, "blue"),
        fact("goal", "two-versus-one", "home", 30_000, {
          points: 10,
          sportingOrder: 30_000,
        }),
      ],
      30_000,
    );

    expect(projection.releases).toMatchObject([
      { scoreFactId: "two-versus-one", playerKey: "away:15", releaseCause: "score" },
    ]);
    expect(
      projection.players.find((player) => player.playerKey === "away:14")?.segments,
    ).toMatchObject([{ cardFactId: "two-first" }, { cardFactId: "two-second" }]);
  });

  test("counts queued red minutes for priority while requiring an active expirable segment", () => {
    const projection = deriveLivePenaltyProjection(
      [
        card("blue-before-red", 16, 0, "blue"),
        card("queued-red", 16, 0, "red"),
        card("single-blue", 17, 0, "blue"),
        fact("goal", "red-blue-priority", "home", 30_000, { points: 10 }),
      ],
      30_000,
    );

    expect(projection.releases).toMatchObject([
      { scoreFactId: "red-blue-priority", playerKey: "away:17" },
    ]);
    expect(
      projection.players.find((player) => player.playerKey === "away:16")?.segments,
    ).toHaveLength(3);
  });

  test("a foul-before-score one-minute penalty expires immediately", () => {
    const projection = deriveLivePenaltyProjection(
      [card("foul-card", 8, 40_000, "blue", { foulBeforeScore: true })],
      40_000,
    );

    expect(projection.players).toHaveLength(0);
    expect(projection.releases).toMatchObject([
      { playerKey: "away:8", releaseCause: "foul-before-score", releasedMs: 40_000 },
    ]);
  });

  test("a skipped reason can be replaced later by one fixed category", () => {
    const projection = deriveLivePenaltyProjection(
      [
        card("reason-card", 13, 0, "blue"),
        fact("penalty-reason", "later-reason", null, 1, {
          targetCardFactId: "reason-card",
          reason: "conduct",
        }),
      ],
      0,
    );

    expect(projection.cards).toMatchObject([{ factId: "reason-card", reason: "conduct" }]);
  });

  test("durable automatic releases can be corrected without removing the source fact", () => {
    const facts = [
      card("durable-card", 21, 0, "blue"),
      fact("goal", "durable-goal", "home", 10_000, { points: 10 }),
      fact("penalty-release-consequence", "durable-release", "away", 10_000, {
        sourceFactId: "durable-goal",
        playerKey: "away:21",
        releaseCause: "score",
        serviceDurationMs: 50_000,
        releasedMs: 10_000,
      }),
    ];
    expect(deriveLivePenaltyProjection(facts, 10_000).releases).toMatchObject([
      { id: "durable-release", sourceFactId: "durable-goal" },
    ]);
    expect(
      deriveLivePenaltyProjection(
        facts.map((candidate) =>
          candidate.factId === "durable-release" ? { ...candidate, effective: false } : candidate,
        ),
        10_000,
      ).releases,
    ).toHaveLength(0);
  });

  test("pregame penalties start at sticks up and seeker-floor penalties start at 20:00", () => {
    const projection = deriveLivePenaltyProjection(
      [
        card("pregame", 9, 0, "blue", { penaltyStart: "sticks-up" }),
        fact("goal", "early-goal", "home", 19 * LIVE_PENALTY_MINUTE_MS + 30_000, {
          points: 10,
          sportingOrder: 19 * LIVE_PENALTY_MINUTE_MS + 30_000,
        }),
        card("seeker-floor", 10, 19 * LIVE_PENALTY_MINUTE_MS + 30_000, "blue", {
          penaltyStart: "seeker-release",
        }),
      ],
      LIVE_SEEKER_RELEASE_MS + 30_000,
    );

    expect(projection.players).toMatchObject([
      { playerNumber: 10, segments: [{ remainingMs: 30_000 }] },
    ]);
    expect(projection.pendingExpirations).toHaveLength(0);

    const delayedRecordCard = deriveLivePenaltyProjection(
      [
        card("pregame-recorded-late", 11, 90_000, "blue", { penaltyStart: "sticks-up" }),
        fact("goal", "post-sticks-up-goal", "home", 30_000, {
          points: 10,
          sportingOrder: 30_000,
        }),
      ],
      90_000,
    );
    expect(delayedRecordCard.releases).toMatchObject([
      {
        scoreFactId: "post-sticks-up-goal",
        playerKey: "away:11",
        releasedMs: 30_000,
      },
    ]);

    const adjudicatedLater = deriveLivePenaltyProjection(
      [
        {
          ...card("adjudicated-pregame", 12, 90_000, "blue", {
            penaltyStart: "sticks-up",
          }),
          sportingOrder: 60_000,
        },
        fact("goal", "before-adjudicated-card", "home", 30_000, {
          points: 10,
          sportingOrder: 30_000,
        }),
      ],
      90_000,
    );
    expect(adjudicatedLater.releases).toHaveLength(0);
  });

  test("defers only a confirmed seeker while an ordinary player serves during 19:00-20:00", () => {
    const cardTime = 19 * LIVE_PENALTY_MINUTE_MS + 30_000;
    const projection = deriveLivePenaltyProjection(
      [
        card("ordinary-floor-card", 30, cardTime, "blue", { penaltyStart: "immediate" }),
        card("seeker-floor-card", 31, cardTime, "blue", { penaltyStart: "seeker-release" }),
      ],
      cardTime + 15_000,
    );

    expect(projection.players).toMatchObject([
      { playerNumber: 30, segments: [{ startsAtGameTimeMs: cardTime, remainingMs: 45_000 }] },
      {
        playerNumber: 31,
        segments: [{ startsAtGameTimeMs: LIVE_SEEKER_RELEASE_MS, remainingMs: 60_000 }],
      },
    ]);
  });

  test("a selected score release is an auditable fact and removes only the chosen player penalty", () => {
    const projection = deriveLivePenaltyProjection(
      [
        card("release-a", 11, 0, "blue"),
        card("release-b", 12, 0, "blue"),
        fact("goal", "goal-release", "home", 10_000, { points: 10, sportingOrder: 10_000 }),
        fact("penalty-release", "release-choice", null, 10_000, {
          pendingId: "penalty-expiration:goal-release",
          scoreFactId: "goal-release",
          playerKey: "away:12",
        }),
      ],
      10_000,
    );

    expect(projection.pendingExpirations).toHaveLength(0);
    expect(projection.releases).toMatchObject([
      { id: "release-choice", scoreFactId: "goal-release", playerKey: "away:12" },
    ]);
    expect(projection.players.map((player) => player.playerKey)).toEqual(["away:11"]);
  });

  test("a delayed complete-tie choice releases at the exact score sporting time", () => {
    const unresolved = deriveLivePenaltyProjection(
      [
        card("delayed-release-a", 40, 0, "blue"),
        card("delayed-release-b", 41, 0, "blue"),
        fact("goal", "delayed-release-goal", "home", 10_000, { points: 10 }),
      ],
      90_000,
    );
    expect(unresolved.pendingExpirations).toMatchObject([
      {
        id: "penalty-expiration:delayed-release-goal",
        scoreFactId: "delayed-release-goal",
        candidatePlayerKeys: ["away:40", "away:41"],
      },
    ]);

    const projection = deriveLivePenaltyProjection(
      [
        card("delayed-release-a", 40, 0, "blue"),
        card("delayed-release-b", 41, 0, "blue"),
        fact("goal", "delayed-release-goal", "home", 10_000, { points: 10 }),
        fact("penalty-release", "delayed-release-choice", null, 90_000, {
          pendingId: "penalty-expiration:delayed-release-goal",
          scoreFactId: "delayed-release-goal",
          playerKey: "away:41",
        }),
      ],
      90_000,
    );

    expect(projection.pendingExpirations).toHaveLength(0);
    expect(projection.releases).toMatchObject([
      {
        id: "delayed-release-choice",
        scoreFactId: "delayed-release-goal",
        playerKey: "away:41",
        releasedMs: 10_000,
      },
    ]);
  });
});
