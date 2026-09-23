import { expect, test } from "bun:test";
import { sqmGoalPlayers } from "./sqm-goal-scorers";
import type { ControllerGameFact } from "./live-event-game-control";

const goal: ControllerGameFact = {
  factId: "7c6d1dce-524c-4ad7-b494-91d7b8a1b17f-4:1",
  factType: "goal",
  gameTimeMs: 82803,
  gameSideId: "away",
  data: { points: 10 },
  effective: true,
  sportingOrder: 1,
  synchronizationOrder: 1,
};

test("approved name-only scorer requires the exact effective SQM goal", () => {
  expect(sqmGoalPlayers("secret3", [goal]).get(goal.factId)).toEqual({
    number: null,
    name: "Leon",
  });
  for (const fixture of [undefined, "secret1", "secret2", "secret4"]) {
    expect(sqmGoalPlayers(fixture, [goal]).size).toBe(0);
  }
  for (const changed of [
    { ...goal, effective: false },
    { ...goal, gameTimeMs: 82804 },
    { ...goal, gameSideId: "home" },
    { ...goal, factType: "flag-catch" },
    { ...goal, data: { points: 30 } },
    { ...goal, factId: "unrelated" },
  ])
    expect(sqmGoalPlayers("secret3", [changed]).size).toBe(0);
});

test("unidentified scorer at paper score 20:50 stays empty", () => {
  const unknown = {
    ...goal,
    factId: "7c6d1dce-524c-4ad7-b494-91d7b8a1b17f-17:1",
    gameSideId: "home",
    gameTimeMs: 559787,
  };
  expect(sqmGoalPlayers("secret3", [unknown]).size).toBe(0);
});
