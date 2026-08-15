import { describe, expect, test } from "bun:test";
import type { ControllerGameFact } from "@/lib/live-event-game-control";
import { projectPublicGameTimeline } from "@/lib/game-timeline-projection";

const sideA = { sideId: "side-a", eventTeamId: "team-a", teamName: "Blue" } as const;
const sideB = { sideId: "side-b", eventTeamId: "team-b", teamName: "Red" } as const;

describe("public Game Timeline projection", () => {
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
