import { expect, test } from "bun:test";
import { adHocGoalPlayers } from "./ad-hoc-goal-scorers";
import type { ControllerGameFact } from "./live-event-game-control";
import { createHash } from "node:crypto";
import { openSqliteAdHocStore, type StoredAdHocGame } from "./ad-hoc-games";
import { createInitialGameState } from "./game-engine";
import { DEFAULT_IQA_SPORTING_RULES as rules } from "./iqa-game-rules";
import { projectAdHocGameTimeline } from "./ad-hoc-timeline-projection";

const goal: ControllerGameFact = {
  factId: "score-action-1",
  factType: "goal",
  gameTimeMs: 82803,
  gameSideId: "away",
  data: { points: 10 },
  effective: true,
  sportingOrder: 1,
  synchronizationOrder: 1,
};

test("SQLite stores scorer edits independently from the original sporting commands", () => {
  const store = openSqliteAdHocStore(":memory:", "test");
  const initialState = createInitialGameState({
    id: "adhoc-scorer-test",
    nowMs: 1000,
    homeName: "A",
    awayName: "B",
  });
  const command = { type: "change-score", team: "home", delta: 10, reason: "goal" } as const;
  const state = rules.apply({
    state: initialState,
    command,
    nowMs: 1001,
    idGenerator: () => "goal-op:1",
  });
  const game: StoredAdHocGame = {
    gameId: state.id,
    environmentIdentity: "test",
    createdAtMs: 1000,
    initialState,
    state,
    controlQr: "test-control",
    controlQrHash: createHash("sha256").update("test-control").digest("hex"),
    sessions: [],
    replayBaselineOperationIds: [],
    operations: {
      "goal-op": {
        fingerprint: JSON.stringify(["ad-hoc", 1001, command, []]),
        command,
        acceptedAtMs: 1001,
        clientSentAtMs: 1001,
        causalPredecessorIds: [],
        status: "accepted",
      },
    },
    goalScorers: [
      {
        scoreActionId: "goal-op:1",
        gameTimeMs: 0,
        side: "home",
        player: { number: null, name: "Alex" },
      },
    ],
  };
  try {
    expect(store.createGame({ game, sourceHash: "test", nowMs: 1001 })).toMatchObject({
      status: "accepted",
    });
    const before = store.readGame(game.gameId)!;
    expect(projectAdHocGameTimeline(before).find((e) => e.kind === "goal")).toMatchObject({
      player: { number: null, name: "Alex" },
    });
    store.mutateGame(game.gameId, (current) => {
      current.goalScorers = [{ ...game.goalScorers![0]!, player: { number: 10, name: null } }];
      return true;
    });
    const after = store.readGame(game.gameId)!;
    expect(after.state).toEqual(before.state);
    expect(after.operations).toEqual(before.operations);
    expect(projectAdHocGameTimeline(after).find((e) => e.kind === "goal")).toMatchObject({
      player: { number: 10, name: null },
    });
    expect(() =>
      store.mutateGame(game.gameId, (current) => {
        current.goalScorers = [{ ...game.goalScorers![0]!, player: { number: 100, name: null } }];
        return true;
      }),
    ).toThrow();
  } finally {
    store.close();
  }
});

const annotation = {
  scoreActionId: goal.factId,
  gameTimeMs: 82803,
  side: "away" as const,
  player: { number: null, name: "Alex" },
};

test("stored name-only scorer requires the exact effective goal", () => {
  expect(adHocGoalPlayers([annotation], [goal]).get(goal.factId)).toEqual({
    number: null,
    name: "Alex",
  });
  expect(adHocGoalPlayers([], [goal]).size).toBe(0);
  for (const changed of [
    { ...goal, effective: false },
    { ...goal, gameTimeMs: 82804 },
    { ...goal, gameSideId: "home" },
    { ...goal, factType: "flag-catch" },
    { ...goal, data: { points: 30 } },
    { ...goal, factId: "unrelated" },
  ])
    expect(adHocGoalPlayers([annotation], [changed]).size).toBe(0);
});

test("unknown scorer stays empty and database edits supply the new label", () => {
  expect(adHocGoalPlayers([{ ...annotation, player: null }], [goal]).size).toBe(0);
  expect(
    adHocGoalPlayers([{ ...annotation, player: { number: 10, name: null } }], [goal]).get(
      goal.factId,
    ),
  ).toEqual({ number: 10, name: null });
});
