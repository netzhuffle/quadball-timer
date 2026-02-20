import { describe, expect, test } from "bun:test";
import { applyGameCommand, createInitialGameState, projectGameView } from "@/lib/game-engine";
import type { GameState } from "@/lib/game-types";

function createIdGenerator() {
  let counter = 0;
  return () => {
    counter += 1;
    return `id-${counter}`;
  };
}

function getPlayerRemainingMs(state: GameState, key: string) {
  const player = state.players[key];
  if (player === undefined) {
    return 0;
  }

  return player.segments.reduce((total, segment) => total + segment.remainingMs, 0);
}

describe("game-engine", () => {
  test("penalties tick only while game is running", () => {
    const makeId = createIdGenerator();
    let state = createInitialGameState({ id: "game-1", nowMs: 0 });

    state = applyGameCommand({
      state,
      command: {
        type: "add-card",
        team: "home",
        playerNumber: 7,
        cardType: "blue",
      },
      nowMs: 0,
      idGenerator: makeId,
    });

    state = applyGameCommand({
      state,
      command: { type: "set-running", running: true },
      nowMs: 0,
      idGenerator: makeId,
    });

    const runningView = projectGameView(state, 30_000);
    expect(getPlayerRemainingMs(runningView.state, "home:7")).toBe(30_000);

    state = applyGameCommand({
      state: runningView.state,
      command: { type: "set-running", running: false },
      nowMs: 30_000,
      idGenerator: makeId,
    });

    const pausedView = projectGameView(state, 50_000);
    expect(getPlayerRemainingMs(pausedView.state, "home:7")).toBe(30_000);
  });

  test("score expiration targets player with fewest remaining expirable minutes", () => {
    const makeId = createIdGenerator();
    let state = createInitialGameState({ id: "game-2", nowMs: 0 });

    state = applyGameCommand({
      state,
      command: { type: "add-card", team: "away", playerNumber: 1, cardType: "blue" },
      nowMs: 0,
      idGenerator: makeId,
    });

    state = applyGameCommand({
      state,
      command: { type: "add-card", team: "away", playerNumber: 1, cardType: "yellow" },
      nowMs: 0,
      idGenerator: makeId,
    });

    state = applyGameCommand({
      state,
      command: { type: "add-card", team: "away", playerNumber: 2, cardType: "blue" },
      nowMs: 0,
      idGenerator: makeId,
    });

    state = applyGameCommand({
      state,
      command: { type: "change-score", team: "home", delta: 10, reason: "goal" },
      nowMs: 0,
      idGenerator: makeId,
    });

    expect(state.pendingExpirations).toHaveLength(1);
    expect(state.pendingExpirations[0]?.candidatePlayerKeys).toEqual(["away:2"]);
  });

  test("tie on count resolves to least remaining first-minute time", () => {
    const makeId = createIdGenerator();
    let state = createInitialGameState({ id: "game-3", nowMs: 0 });

    state = applyGameCommand({
      state,
      command: { type: "add-card", team: "away", playerNumber: 1, cardType: "blue" },
      nowMs: 0,
      idGenerator: makeId,
    });

    state = applyGameCommand({
      state,
      command: { type: "set-running", running: true },
      nowMs: 0,
      idGenerator: makeId,
    });

    state = projectGameView(state, 20_000).state;

    state = applyGameCommand({
      state,
      command: { type: "set-running", running: false },
      nowMs: 20_000,
      idGenerator: makeId,
    });

    state = applyGameCommand({
      state,
      command: { type: "add-card", team: "away", playerNumber: 2, cardType: "blue" },
      nowMs: 20_000,
      idGenerator: makeId,
    });

    state = applyGameCommand({
      state,
      command: { type: "change-score", team: "home", delta: 10, reason: "goal" },
      nowMs: 20_000,
      idGenerator: makeId,
    });

    expect(state.pendingExpirations).toHaveLength(1);
    expect(state.pendingExpirations[0]?.candidatePlayerKeys).toEqual(["away:1"]);
  });

  test("confirming a pending expiration drops the active expirable minute first", () => {
    const makeId = createIdGenerator();
    let state = createInitialGameState({ id: "game-4", nowMs: 0 });

    state = applyGameCommand({
      state,
      command: { type: "add-card", team: "away", playerNumber: 5, cardType: "yellow" },
      nowMs: 0,
      idGenerator: makeId,
    });

    state = applyGameCommand({
      state,
      command: { type: "add-card", team: "away", playerNumber: 5, cardType: "blue" },
      nowMs: 0,
      idGenerator: makeId,
    });

    state = applyGameCommand({
      state,
      command: { type: "set-running", running: true },
      nowMs: 0,
      idGenerator: makeId,
    });

    state = projectGameView(state, 50_000).state;

    state = applyGameCommand({
      state,
      command: { type: "set-running", running: false },
      nowMs: 50_000,
      idGenerator: makeId,
    });

    state = applyGameCommand({
      state,
      command: { type: "change-score", team: "home", delta: 10, reason: "goal" },
      nowMs: 50_000,
      idGenerator: makeId,
    });

    const pending = state.pendingExpirations[0];
    expect(pending).toBeDefined();

    state = applyGameCommand({
      state,
      command: {
        type: "confirm-penalty-expiration",
        pendingId: pending?.id ?? "",
        playerKey: null,
      },
      nowMs: 50_000,
      idGenerator: makeId,
    });

    expect(getPlayerRemainingMs(state, "away:5")).toBe(60_000);
  });

  test("red-card penalties never create score-based expiration candidates", () => {
    const makeId = createIdGenerator();
    let state = createInitialGameState({ id: "game-5", nowMs: 0 });

    state = applyGameCommand({
      state,
      command: { type: "add-card", team: "away", playerNumber: 9, cardType: "red" },
      nowMs: 0,
      idGenerator: makeId,
    });

    state = applyGameCommand({
      state,
      command: { type: "change-score", team: "home", delta: 10, reason: "goal" },
      nowMs: 0,
      idGenerator: makeId,
    });

    expect(state.pendingExpirations).toHaveLength(0);
  });

  test("timeouts tick only while paused and whistle reminder highlights at 20 seconds", () => {
    const makeId = createIdGenerator();
    let state = createInitialGameState({ id: "game-6", nowMs: 0 });

    state = applyGameCommand({
      state,
      command: { type: "start-timeout", team: "home" },
      nowMs: 0,
      idGenerator: makeId,
    });

    state = applyGameCommand({
      state,
      command: { type: "set-timeout-running", running: true },
      nowMs: 0,
      idGenerator: makeId,
    });

    let view = projectGameView(state, 20_000);
    expect(view.timeoutReminderActive).toBe(true);
    expect(view.timeoutWarningActive).toBe(false);
    expect(view.timeoutFinalCountdown).toBe(false);

    view = projectGameView(state, 40_000);
    expect(view.state.timeouts.active?.remainingMs).toBe(20_000);
    expect(view.timeoutReminderActive).toBe(true);
    expect(view.timeoutWarningActive).toBe(true);
    expect(view.timeoutFinalCountdown).toBe(false);

    view = projectGameView(state, 50_000);
    expect(view.state.timeouts.active?.remainingMs).toBe(10_000);
    expect(view.timeoutReminderActive).toBe(true);
    expect(view.timeoutWarningActive).toBe(true);
    expect(view.timeoutFinalCountdown).toBe(true);

    state = applyGameCommand({
      state: view.state,
      command: { type: "set-running", running: true },
      nowMs: 50_000,
      idGenerator: makeId,
    });

    view = projectGameView(state, 60_000);
    expect(view.state.timeouts.active?.remainingMs).toBe(10_000);
  });

  test("undo timeout start restores team timeout even if timeout is running", () => {
    const makeId = createIdGenerator();
    let state = createInitialGameState({ id: "game-8", nowMs: 0 });

    state = applyGameCommand({
      state,
      command: { type: "start-timeout", team: "home" },
      nowMs: 0,
      idGenerator: makeId,
    });

    expect(state.timeouts.home.used).toBe(true);
    expect(state.timeouts.active).not.toBeNull();

    state = applyGameCommand({
      state,
      command: { type: "set-timeout-running", running: true },
      nowMs: 0,
      idGenerator: makeId,
    });

    state = applyGameCommand({
      state,
      command: { type: "undo-timeout-start" },
      nowMs: 0,
      idGenerator: makeId,
    });

    expect(state.timeouts.home.used).toBe(false);
    expect(state.timeouts.active).toBeNull();
  });

  test("timeout auto-clears once it reaches zero", () => {
    const makeId = createIdGenerator();
    let state = createInitialGameState({ id: "game-9", nowMs: 0 });

    state = applyGameCommand({
      state,
      command: { type: "start-timeout", team: "away" },
      nowMs: 0,
      idGenerator: makeId,
    });

    state = applyGameCommand({
      state,
      command: { type: "set-timeout-running", running: true },
      nowMs: 0,
      idGenerator: makeId,
    });

    const view = projectGameView(state, 61_000);
    expect(view.state.timeouts.active).toBeNull();
    expect(view.state.timeouts.away.used).toBe(true);
  });

  test("timeout cannot be paused once started", () => {
    const makeId = createIdGenerator();
    let state = createInitialGameState({ id: "game-10", nowMs: 0 });

    state = applyGameCommand({
      state,
      command: { type: "start-timeout", team: "home" },
      nowMs: 0,
      idGenerator: makeId,
    });

    state = applyGameCommand({
      state,
      command: { type: "set-timeout-running", running: true },
      nowMs: 0,
      idGenerator: makeId,
    });

    state = applyGameCommand({
      state,
      command: { type: "set-timeout-running", running: false },
      nowMs: 10_000,
      idGenerator: makeId,
    });

    const view = projectGameView(state, 20_000);
    expect(view.state.timeouts.active?.remainingMs).toBe(40_000);
  });

  test("tied penalty expiration requires explicit player selection", () => {
    const makeId = createIdGenerator();
    let state = createInitialGameState({ id: "game-11", nowMs: 0 });

    state = applyGameCommand({
      state,
      command: { type: "add-card", team: "away", playerNumber: 1, cardType: "blue" },
      nowMs: 0,
      idGenerator: makeId,
    });
    state = applyGameCommand({
      state,
      command: { type: "add-card", team: "away", playerNumber: 2, cardType: "yellow" },
      nowMs: 0,
      idGenerator: makeId,
    });

    state = applyGameCommand({
      state,
      command: { type: "change-score", team: "home", delta: 10, reason: "goal" },
      nowMs: 0,
      idGenerator: makeId,
    });

    const pendingId = state.pendingExpirations[0]?.id ?? "";
    expect(state.pendingExpirations[0]?.candidatePlayerKeys).toEqual(["away:1", "away:2"]);

    state = applyGameCommand({
      state,
      command: { type: "confirm-penalty-expiration", pendingId, playerKey: null },
      nowMs: 0,
      idGenerator: makeId,
    });
    expect(getPlayerRemainingMs(state, "away:1")).toBe(60_000);
    expect(getPlayerRemainingMs(state, "away:2")).toBe(60_000);

    state = applyGameCommand({
      state,
      command: { type: "confirm-penalty-expiration", pendingId, playerKey: "away:2" },
      nowMs: 0,
      idGenerator: makeId,
    });
    expect(getPlayerRemainingMs(state, "away:1")).toBe(60_000);
    expect(getPlayerRemainingMs(state, "away:2")).toBe(0);
  });

  test("flag catch is only accepted after seeker release while paused", () => {
    const makeId = createIdGenerator();
    let state = createInitialGameState({ id: "game-7", nowMs: 0 });

    state = applyGameCommand({
      state,
      command: { type: "set-running", running: true },
      nowMs: 0,
      idGenerator: makeId,
    });

    state = projectGameView(state, 1_200_000).state;

    state = applyGameCommand({
      state,
      command: { type: "set-running", running: false },
      nowMs: 1_200_000,
      idGenerator: makeId,
    });

    state = applyGameCommand({
      state,
      command: { type: "add-card", team: "away", playerNumber: 4, cardType: "blue" },
      nowMs: 1_200_000,
      idGenerator: makeId,
    });

    state = applyGameCommand({
      state,
      command: { type: "record-flag-catch", team: "home" },
      nowMs: 1_200_000,
      idGenerator: makeId,
    });

    expect(state.score.home).toBe(30);
    expect(state.flagCatch?.team).toBe("home");
    expect(state.pendingExpirations).toHaveLength(1);
    expect(state.isFinished).toBe(true);
  });
});
