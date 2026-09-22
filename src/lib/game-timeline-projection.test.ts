import { describe, expect, test } from "bun:test";
import type { ControllerGameFact } from "@/lib/live-event-game-control";
import { projectPublicGameTimeline } from "@/lib/game-timeline-projection";

const sideA = { sideId: "side-a", eventTeamId: "team-a", teamName: "Blue" } as const;
const sideB = { sideId: "side-b", eventTeamId: "team-b", teamName: "Red" } as const;

describe("public Game Timeline projection", () => {
  test("phase scores use effective historical goals and preserve same-clock catch ordering", () => {
    const facts = [
      fact("goal", "side-b", 60_000, { points: 10 }, "first", true, 1),
      fact("goal", "side-a", 90_000, { points: 10 }, "undone", false, 2),
      fact("clock", null, 1_200_000, {}, "release", true, 3),
      fact("goal", "side-b", 1_200_000, { points: 10 }, "after-release", true, 4),
      fact("flag-catch", "side-a", 1_300_000, { points: 30 }, "catch", true, 5),
      fact("goal", "side-b", 1_300_000, { points: 10 }, "after-catch", true, 6),
      fact("clock", null, 1_400_000, {}, "later-clock", true, 7),
    ];
    const input = {
      facts,
      sideA,
      sideB,
      lookupRosterName: () => null,
      derived: {
        catch: { factId: "catch", gameTimeMs: 1_300_000, catchingGameSideId: "side-a" },
        overtime: true,
        overtimeTarget: 50,
        result: null,
      },
    };
    const timeline = projectPublicGameTimeline(input);
    expect(timeline.find((entry) => entry.kind === "seeker-release")).toMatchObject({
      score: { sideA: 0, sideB: 10 },
    });
    expect(timeline.find((entry) => entry.kind === "overtime")).toMatchObject({
      score: { sideA: 30, sideB: 20 },
      targetScore: 50,
    });
    expect(timeline.slice(0, 3).map((entry) => entry.kind)).toEqual([
      "goal",
      "overtime",
      "flag-catch",
    ]);
    const closePlay = projectPublicGameTimeline({
      ...input,
      facts: facts.map((item) =>
        item.factId === "first" ? { ...item, gameTimeMs: 1_310_000 } : item,
      ),
    });
    expect(closePlay.find((entry) => entry.kind === "overtime")).toMatchObject({
      score: { sideA: 30, sideB: 20 },
    });
    const corrected = projectPublicGameTimeline({
      ...input,
      facts: facts.map((item) => (item.factId === "first" ? { ...item, effective: false } : item)),
    });
    expect(corrected.find((entry) => entry.kind === "seeker-release")).toMatchObject({
      score: { sideA: 0, sideB: 0 },
    });
    expect(corrected.find((entry) => entry.kind === "overtime")).toMatchObject({
      score: { sideA: 30, sideB: 10 },
    });
    expect(
      projectPublicGameTimeline({ ...input, derived: { ...input.derived, overtime: false } }).some(
        (entry) => entry.kind === "overtime",
      ),
    ).toBe(false);
  });

  test("omits phase scores when scoring history cannot be placed or a catch is only a fallback", () => {
    const input = {
      facts: [fact("goal", "side-a", null, {}), fact("clock", null, 1_200_000, {})],
      sideA,
      sideB,
      lookupRosterName: () => null,
      derived: {
        catch: { factId: "missing", gameTimeMs: 1_300_000, catchingGameSideId: "side-a" },
        overtime: true,
        overtimeTarget: 60,
        result: null,
      },
    };
    for (const entry of projectPublicGameTimeline(input)) {
      if (entry.kind === "seeker-release" || entry.kind === "overtime")
        expect(entry.score).toBeNull();
    }
  });

  test("centers finish entries on the authoritative winner rather than the action side", () => {
    for (const outcome of ["result", "concession", "forfeit"] as const) {
      const timeline = projectPublicGameTimeline({
        facts: [fact(outcome, "side-a", 1_323_000, { resultKind: outcome })],
        sideA,
        sideB,
        winnerGameSideId: "side-b",
        lookupRosterName: () => null,
        derived: { catch: null, overtime: false, overtimeTarget: null, result: null },
      });
      expect(timeline).toEqual([
        {
          kind: "finish",
          outcome,
          resultKind: outcome,
          gameTimeMs: 1_323_000,
          lane: "center",
          teamName: "Red",
        },
      ]);
    }
  });

  test("resolves automatic finish and corrected winners without exposing an old winner", () => {
    const input = {
      facts: [fact("goal", "side-a", 1_323_000, { points: 10 }, "winning-goal")],
      sideA,
      sideB,
      lookupRosterName: () => null,
      derived: {
        catch: null,
        overtime: false,
        overtimeTarget: null,
        result: { factId: "winning-goal" },
      },
    };
    expect(
      projectPublicGameTimeline({ ...input, winnerGameSideId: "side-a" }).find(
        (entry) => entry.kind === "finish",
      ),
    ).toMatchObject({ teamName: "Blue", lane: "center" });
    expect(
      projectPublicGameTimeline({ ...input, winnerGameSideId: "side-b" }).filter(
        (entry) => entry.kind === "finish",
      ),
    ).toEqual([
      {
        kind: "finish",
        gameTimeMs: 1_323_000,
        lane: "center",
        teamName: "Red",
        outcome: "result",
        resultKind: null,
      },
    ]);
  });

  test("does not invent a winner for ties, double forfeits or unavailable result ownership", () => {
    for (const winnerGameSideId of [null, undefined, "unknown-side"]) {
      const timeline = projectPublicGameTimeline({
        facts: [fact("result", "side-a", 1_323_000, { resultKind: "tie" })],
        sideA,
        sideB,
        winnerGameSideId,
        lookupRosterName: () => null,
        derived: { catch: null, overtime: false, overtimeTarget: null, result: null },
      });
      expect(timeline[0]).toMatchObject({ kind: "finish", lane: "center", teamName: null });
    }
    const doubleForfeit = projectPublicGameTimeline({
      facts: [fact("double-forfeit", "side-a", 1_323_000, {})],
      sideA,
      sideB,
      winnerGameSideId: null,
      lookupRosterName: () => null,
      derived: { catch: null, overtime: false, overtimeTarget: null, result: null },
    });
    expect(doubleForfeit[0]).toMatchObject({ kind: "finish", lane: "center", teamName: null });
  });

  test("shows one centered start at zero only after authoritative commencement", () => {
    const input = {
      facts: [],
      sideA,
      sideB,
      lookupRosterName: () => null,
      derived: { catch: null, overtime: false, overtimeTarget: null, result: null },
    };
    expect(projectPublicGameTimeline(input)).toEqual([]);
    expect(projectPublicGameTimeline({ ...input, commencedAtMs: null })).toEqual([]);
    expect(projectPublicGameTimeline({ ...input, commencedAtMs: 12345 })).toEqual([
      { kind: "game-start", gameTimeMs: 0, lane: "center", teamName: null },
    ]);
    // Even a clock tap or an unplayed forfeit cannot substitute for commencement.
    expect(
      projectPublicGameTimeline({
        ...input,
        facts: [
          fact("clock", null, 0, { command: "set-running", running: true }),
          fact("forfeit", "side-a", 0, {}),
        ],
      }).some((entry) => entry.kind === "game-start"),
    ).toBe(false);
    const played = projectPublicGameTimeline({
      ...input,
      commencedAtMs: 12345,
      facts: [fact("goal", "side-a", 0, { points: 10 })],
    });
    expect(played.map((entry) => entry.kind)).toEqual(["goal", "game-start"]);
  });

  test("omits routine clock controls while retaining meaningful stoppages and phase effects", () => {
    const facts = [
      fact("clock", null, 1_200_000, { command: "set-running", running: false }, "pause"),
      fact("clock", null, 1_210_000, { command: "set-running", running: true }, "resume"),
      fact("timeout", "side-a", 1_200_000, { timeoutAction: "start" }),
      fact("suspension", null, 1_200_000, { suspensionAction: "resume" }),
      fact("heat-stoppage", null, 1_200_000, { heatAction: "end" }),
    ];
    const original = structuredClone(facts);
    const timeline = projectPublicGameTimeline({
      facts,
      sideA,
      sideB,
      lookupRosterName: () => null,
      derived: { catch: null, overtime: false, overtimeTarget: null, result: null },
    });
    expect(timeline.map((entry) => entry.kind).sort()).toEqual([
      "heat-stoppage",
      "seeker-release",
      "suspension",
      "timeout",
    ]);
    expect(timeline.find((entry) => entry.kind === "seeker-release")?.gameTimeMs).toBe(1_200_000);
    expect(facts).toEqual(original);
  });

  test("projects every registered public kind, including penalty consequences and player data", () => {
    const facts = [
      fact("goal", "side-a", 1_000, { points: 10, playerNumber: 3 }),
      fact("card", "side-b", 2_000, { cardType: "yellow", playerNumber: 7 }),
      fact(
        "penalty-reason",
        "side-b",
        2_000,
        { targetCardFactId: "card-fact", reason: "conduct" },
        "reason-fact",
      ),
      fact("timeout", "side-a", 3_000, { timeoutAction: "stoppage" }),
      fact("suspension", null, 4_000, { suspensionAction: "start" }),
      fact("heat-stoppage", null, 5_000, { heatAction: "start" }),
      fact("flag-catch", "side-a", 6_000, { points: 30, playerNumber: 1 }),
      fact("penalty-release", "side-b", 7_000, {
        playerKey: "side-b:7",
        releaseCause: "score",
        serviceDurationMs: 60_000,
      }),
      fact(
        "penalty-release-consequence",
        "side-b",
        8_000,
        {
          playerKey: "side-b:7",
          releaseCause: "automatic",
          serviceDurationMs: 60_000,
          sourceFactId: "card-fact",
          privateOperationId: "private-operation",
        },
        "consequence-fact",
      ),
      fact("result", null, 9_000, { resultKind: "winner" }),
      fact("clock", null, 1_200_000, { command: "set-running", running: false }),
    ];
    const timeline = projectPublicGameTimeline({
      facts,
      sideA,
      sideB,
      lookupRosterName: (eventTeamId, playerNumber) =>
        eventTeamId === "team-a" && playerNumber === 3
          ? "Goal Player"
          : eventTeamId === "team-a" && playerNumber === 1
            ? "Catcher"
            : eventTeamId === "team-b" && playerNumber === 7
              ? "Card Player"
              : null,
      derived: {
        catch: {
          factId: "catch-fact",
          gameTimeMs: 6_000,
          catchingGameSideId: "side-a",
        },
        overtime: true,
        overtimeTarget: 60,
        result: null,
      },
    });

    expect(timeline.map((entry) => entry.kind)).toEqual([
      "seeker-release",
      "finish",
      "penalty",
      "penalty",
      "overtime",
      "flag-catch",
      "heat-stoppage",
      "suspension",
      "timeout",
      "card",
      "goal",
    ]);
    expect(timeline.find((entry) => entry.kind === "goal")).toMatchObject({
      gameTimeMs: 1_000,
      player: { number: 3, name: "Goal Player" },
      points: 10,
    });
    expect(timeline.find((entry) => entry.kind === "flag-catch")).toMatchObject({
      player: { number: 1, name: "Catcher" },
    });
    expect(timeline.filter((entry) => entry.kind === "penalty")).toHaveLength(2);
    expect(timeline.find((entry) => entry.kind === "card")).toMatchObject({
      player: { number: 7, name: "Card Player" },
      cardColor: "yellow",
      penaltyReason: "conduct",
    });
    expect(JSON.stringify(timeline)).not.toContain("private-operation");
  });

  test("keeps missing Game Clock time absent and does not call roster lookup for an unassigned side", () => {
    let lookupCalls = 0;
    const timeline = projectPublicGameTimeline({
      facts: [
        fact(
          "goal",
          "side-a",
          null,
          { points: 10, playerNumber: 4 },
          "untimed-goal",
          true,
          999_999,
        ),
      ],
      sideA: { sideId: "side-a", eventTeamId: null, teamName: "Unassigned" },
      sideB,
      lookupRosterName: () => {
        lookupCalls += 1;
        return "must-not-be-called";
      },
      derived: { catch: null, overtime: false, overtimeTarget: null, result: null },
    });

    expect(timeline[0]).toEqual({
      kind: "goal",
      gameTimeMs: null,
      lane: "side-a",
      teamName: "Unassigned",
      player: { number: 4, name: null },
      points: 10,
    });
    expect(lookupCalls).toBe(0);
    expect(JSON.stringify(timeline)).not.toContain("999999");
  });

  test("uses semantic Sporting Order before synchronization for equal Game Clock times", () => {
    const timeline = projectPublicGameTimeline({
      facts: [
        fact("goal", "side-a", 100, { points: 10 }, "arrived-late", true, 10, 99),
        fact("card", "side-b", 100, { cardType: "blue" }, "sporting-late", true, 20, 1),
      ],
      sideA,
      sideB,
      lookupRosterName: () => null,
      derived: { catch: null, overtime: false, overtimeTarget: null, result: null },
    });

    expect(timeline.map((entry) => entry.kind)).toEqual(["card", "goal"]);
  });

  test("uses explicit close-play Sporting Order before retained Game Clock times", () => {
    const timeline = projectPublicGameTimeline({
      facts: [
        fact("goal", "side-a", 100, { points: 10 }, "clock-later", true, 101, 1),
        fact(
          "flag-catch",
          "side-b",
          100,
          {
            points: 30,
            sportingOrderAdjudication: { relatedFactId: "clock-later", relation: "after" },
          },
          "sporting-later",
          true,
          100,
          2,
        ),
      ],
      sideA,
      sideB,
      lookupRosterName: () => null,
      derived: { catch: null, overtime: false, overtimeTarget: null, result: null },
    });

    expect(timeline.map((entry) => entry.kind)).toEqual(["flag-catch", "goal"]);
    expect(timeline.map((entry) => entry.gameTimeMs)).toEqual([100, 100]);
  });

  test("keeps newer Game Clock time ahead of a later Sporting Order", () => {
    const timeline = projectPublicGameTimeline({
      facts: [
        fact("goal", "side-a", 101, { points: 10 }, "clock-newer", true, 1, 1),
        fact(
          "flag-catch",
          "side-b",
          100,
          {
            points: 30,
            sportingOrderAdjudication: { relatedFactId: "clock-newer", relation: "after" },
          },
          "sporting-later",
          true,
          2,
          2,
        ),
      ],
      sideA,
      sideB,
      lookupRosterName: () => null,
      derived: { catch: null, overtime: false, overtimeTarget: null, result: null },
    });

    expect(timeline.map((entry) => entry.kind)).toEqual(["goal", "flag-catch"]);
    expect(timeline.map((entry) => entry.gameTimeMs)).toEqual([101, 100]);
  });

  test("includes a derived corrected flag catch when the correction replaces the fact", () => {
    const timeline = projectPublicGameTimeline({
      facts: [fact("result", "locked-correction", 1_500, { resultKind: "result" })],
      sideA,
      sideB,
      lookupRosterName: () => null,
      derived: {
        catch: {
          factId: "locked-correction",
          catchingGameSideId: "side-a",
          gameTimeMs: 1_500,
        },
        overtime: false,
        overtimeTarget: null,
        result: { factId: "locked-correction" },
      },
    });

    expect(timeline).toContainEqual(
      expect.objectContaining({
        kind: "flag-catch",
        gameTimeMs: 1_500,
        lane: "side-a",
        points: 30,
      }),
    );
  });

  test("re-resolves effective facts after supersession, reinstatement, and roster correction", () => {
    const facts = [
      fact("goal", "side-a", 100, { points: 10, playerNumber: 4 }, "superseded", false),
      fact("correction", null, 101, { privateReason: "private-correction" }, "private-correction"),
      fact(
        "locked-correction",
        null,
        102,
        { privateReason: "locked-private-reason" },
        "locked-correction",
      ),
      fact("goal", "side-a", 100, { points: 20, playerNumber: 4 }, "reinstated", true),
      fact("card", "side-a", 90, { cardType: "blue", playerNumber: 8 }, "unmapped-card"),
    ];
    const input = {
      facts,
      sideA,
      sideB,
      derived: { catch: null, overtime: false, overtimeTarget: null, result: null },
    } as const;
    const before = projectPublicGameTimeline({ ...input, lookupRosterName: () => null });
    const after = projectPublicGameTimeline({
      ...input,
      lookupRosterName: (eventTeamId, playerNumber) =>
        eventTeamId === "team-a" && playerNumber === 4 ? "Corrected Name" : null,
    });

    expect(before.map((entry) => entry.kind)).toEqual(["goal", "card"]);
    expect(before.find((entry) => entry.kind === "goal")).toMatchObject({
      points: 20,
      player: { number: 4, name: null },
    });
    expect(after.find((entry) => entry.kind === "goal")).toMatchObject({
      points: 20,
      player: { number: 4, name: "Corrected Name" },
    });
    expect(after.find((entry) => entry.kind === "card")).toMatchObject({
      player: { number: 8, name: null },
      penaltyReason: null,
    });
    expect(JSON.stringify(after)).not.toContain("private-correction");
    expect(JSON.stringify(after)).not.toContain("locked-private-reason");
  });

  test("follows a corrected stable Game Side assignment without copying identity into the fact", () => {
    const timeline = projectPublicGameTimeline({
      facts: [fact("goal", "side-a", 500, { points: 10, playerNumber: 9 })],
      sideA: { sideId: "side-a", eventTeamId: "corrected-team", teamName: "Corrected Team" },
      sideB,
      lookupRosterName: (eventTeamId, playerNumber) =>
        eventTeamId === "corrected-team" && playerNumber === 9 ? "Corrected Player" : null,
      derived: { catch: null, overtime: false, overtimeTarget: null, result: null },
    });

    expect(timeline[0]).toMatchObject({
      kind: "goal",
      lane: "side-a",
      teamName: "Corrected Team",
      player: { number: 9, name: "Corrected Player" },
    });
    expect(JSON.stringify(timeline)).not.toContain("corrected-team");
  });

  test("orders timed events first and keeps presentation out of Timeline history", () => {
    const timeline = projectPublicGameTimeline({
      facts: [fact("goal", "side-a", 500, { points: 10 })],
      sideA,
      sideB,
      lookupRosterName: () => null,
      derived: { catch: null, overtime: false, overtimeTarget: null, result: null },
    });

    expect(timeline.map((entry) => entry.kind)).toEqual(["goal"]);
    expect(JSON.stringify(timeline)).not.toContain("presentation");
  });

  test("keeps high-entropy private payloads outside the public allowlist", () => {
    const timeline = projectPublicGameTimeline({
      facts: [
        fact("unknown-private-fact", null, 99, {
          grantSessionId: "private-session-sentinel",
          auditTrailId: "private-audit-sentinel",
          credential: "private-credential-sentinel",
          internalId: "private-internal-id-sentinel",
        }),
        fact("correction", null, 98, { correctionReason: "private-reason-sentinel" }),
      ],
      sideA,
      sideB,
      lookupRosterName: () => null,
      derived: { catch: null, overtime: false, overtimeTarget: null, result: null },
    });

    expect(timeline).toEqual([]);
    expect(JSON.stringify(timeline)).not.toMatch(/sentinel/);
  });
});

function fact(
  factType: string,
  gameSideId: string | null,
  gameTimeMs: number | null,
  data: Record<string, unknown>,
  factId = `${factType}-fact`,
  effective = true,
  sportingOrder = gameTimeMs ?? 0,
  synchronizationOrder = sportingOrder,
): ControllerGameFact {
  return {
    factId,
    factType,
    gameSideId,
    gameTimeMs,
    sportingOrder,
    synchronizationOrder,
    effective,
    data: data as ControllerGameFact["data"],
  };
}
