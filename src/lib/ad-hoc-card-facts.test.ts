import { describe, expect, test } from "bun:test";
import { applyAdHocCardMutation } from "@/lib/ad-hoc-card-facts";
import { createInitialGameState } from "@/lib/game-engine";

function ids() {
  let next = 0;
  return () => `card-fact-${++next}`;
}

describe("Ad Hoc card facts", () => {
  test("records an unknown-number card at its original Game Clock time", () => {
    const state = createInitialGameState({ id: "adhoc-facts", nowMs: 0 });
    state.gameClockMs = 45_000;

    expect(
      applyAdHocCardMutation({
        state,
        mutation: {
          type: "add-card",
          team: "home",
          cardType: "blue",
          playerNumber: null,
          startedGameClockMs: 30_000,
        },
        nowMs: 50_000,
        idGenerator: ids(),
      }),
    ).toBe(true);

    const event = state.cardEvents[0];
    expect(event?.gameClockMs).toBe(30_000);
    expect(event?.playerNumber).toBeNull();
    expect(event?.id).toBe("card-fact-1");
    expect(Object.values(state.players)[0]?.segments[0]?.remainingMs).toBe(45_000);
  });

  test("updates one exact card while preserving its entry time", () => {
    const state = createInitialGameState({ id: "adhoc-facts", nowMs: 0 });
    const makeId = ids();
    applyAdHocCardMutation({
      state,
      mutation: { type: "add-card", team: "home", cardType: "blue", playerNumber: 7 },
      nowMs: 1_000,
      idGenerator: makeId,
    });
    applyAdHocCardMutation({
      state,
      mutation: { type: "add-card", team: "away", cardType: "yellow", playerNumber: 8 },
      nowMs: 2_000,
      idGenerator: makeId,
    });
    state.gameClockMs = 20_000;
    const first = state.cardEvents[0];
    const second = state.cardEvents[1];
    if (first === undefined || second === undefined) throw new Error("Expected two cards.");

    expect(
      applyAdHocCardMutation({
        state,
        mutation: {
          type: "update-card",
          cardId: first.id,
          team: "away",
          cardType: "red",
          playerNumber: null,
        },
        nowMs: 21_000,
        idGenerator: makeId,
      }),
    ).toBe(true);

    expect(state.cardEvents[0]).toMatchObject({
      id: first.id,
      createdAtMs: first.createdAtMs,
      gameClockMs: first.gameClockMs,
      team: "away",
      cardType: "red",
      playerNumber: null,
    });
    expect(state.cardEvents[1]).toEqual(second);
    expect(Object.values(state.players).flatMap((player) => player.segments)).toHaveLength(3);
    const segments = Object.values(state.players).flatMap((player) => player.segments);
    expect(segments.filter((segment) => segment.cardEventId === first.id)).toHaveLength(2);
    expect(segments.filter((segment) => segment.cardEventId === second.id)).toHaveLength(1);
  });

  test("rejects an update for an unknown or legacy penalty without mutation", () => {
    const state = createInitialGameState({ id: "adhoc-facts", nowMs: 0 });
    state.cardEvents.push({
      id: "legacy-card",
      team: "home",
      playerKey: "home:7",
      playerNumber: 7,
      cardType: "blue",
      createdAtMs: 1,
      gameClockMs: 0,
    });
    const before = structuredClone(state);

    expect(
      applyAdHocCardMutation({
        state,
        mutation: {
          type: "update-card",
          cardId: "legacy-card",
          team: "away",
          cardType: "yellow",
          playerNumber: 9,
        },
        nowMs: 2,
        idGenerator: ids(),
      }),
    ).toBe(false);
    expect(state).toEqual(before);
  });
});
