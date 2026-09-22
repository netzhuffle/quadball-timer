import { describe, expect, test } from "bun:test";
import { projectAdHocGameTimeline } from "@/lib/ad-hoc-timeline-projection";
import {
  createAdHocGamesService,
  createInMemoryAdHocStore,
  type StoredAdHocGame,
} from "@/lib/ad-hoc-games";
import { createInitialGameState } from "@/lib/game-engine";
import type { GameCommand } from "@/lib/game-types";
import { DEFAULT_IQA_SPORTING_RULES as rules } from "@/lib/iqa-game-rules";
import { createSqmFixtureGameProjection, SQM_FIXTURE_GAMES } from "@/lib/sqm-fixture";
import { createAudienceProjection } from "@/lib/audience-projection";
import { createFoundationEventCatalogStorage } from "@/lib/event-catalog";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";

function recording() {
  const initialState = createInitialGameState({
    id: "synthetic-game",
    nowMs: 1000,
    homeName: "Alpha",
    awayName: "Beta",
  });
  const game: Pick<
    StoredAdHocGame,
    "initialState" | "state" | "operations" | "replayBaselineOperationIds"
  > = {
    initialState,
    state: structuredClone(initialState),
    operations: {},
    replayBaselineOperationIds: [],
  };
  let count = 0;
  return {
    game,
    apply(this: void, command: GameCommand, nowMs = 1000 + count) {
      const id = `synthetic-op-${++count}`;
      game.operations[id] = {
        fingerprint: "private-fingerprint",
        command,
        acceptedAtMs: nowMs,
        clientSentAtMs: nowMs,
        causalPredecessorIds: [],
        status: "accepted",
      };
      let generated = 0;
      game.state = rules.apply({
        state: game.state,
        command,
        nowMs,
        idGenerator: () => `${id}:${++generated}`,
      });
      return id;
    },
  };
}

describe("recorded Ad Hoc public timeline", () => {
  test("uses historical phases, final effective goals, catch overtime and authoritative winner", () => {
    const { game, apply } = recording();
    apply({ type: "set-running", running: true });
    apply({ type: "change-score", team: "home", delta: 100, reason: "goal" });
    apply({ type: "change-score", team: "away", delta: 10, reason: "goal" });
    apply({ type: "undo-last-score", team: "away" });
    apply({ type: "set-game-clock", gameClockMs: 1200000 });
    apply({ type: "change-score", team: "away", delta: 10, reason: "goal" });
    apply({ type: "set-running", running: false });
    apply({ type: "record-flag-catch", team: "away" });
    apply({ type: "record-concede", team: "away" });
    const timeline = projectAdHocGameTimeline(game);
    expect(timeline.find((entry) => entry.kind === "seeker-release")).toMatchObject({
      score: { sideA: 100, sideB: 0 },
    });
    expect(timeline.find((entry) => entry.kind === "overtime")).toMatchObject({
      score: { sideA: 100, sideB: 40 },
      targetScore: 130,
    });
    expect(timeline.find((entry) => entry.kind === "finish")).toMatchObject({
      lane: "center",
      teamName: "Alpha",
      outcome: "concession",
    });
    expect(timeline.filter((entry) => entry.kind === "goal")).toHaveLength(2);
    expect(timeline.filter((entry) => entry.kind === "game-start")).toHaveLength(1);
    expect(JSON.stringify(timeline)).not.toMatch(
      /private-fingerprint|synthetic-op|command|causalPredecessor/,
    );
  });

  test("keeps corrected cards and removes undone timeouts and corrected finish facts", () => {
    const { game, apply } = recording();
    apply({ type: "set-running", running: true });
    apply({ type: "add-card", team: "home", playerNumber: 7, cardType: "yellow" });
    const cardId = game.state.cardEvents[0]!.id;
    apply({ type: "update-card", cardId, team: "away", playerNumber: 8, cardType: "blue" });
    apply({ type: "start-timeout", team: "home" });
    apply({ type: "undo-timeout-start" });
    apply({ type: "record-forfeit", team: "home" });
    apply({ type: "correct-to-unfinished" });
    const timeline = projectAdHocGameTimeline(game);
    expect(timeline.find((entry) => entry.kind === "card")).toMatchObject({
      lane: "side-b",
      cardColor: "blue",
      player: { number: 8, name: null },
    });
    expect(timeline.some((entry) => entry.kind === "timeout" || entry.kind === "finish")).toBe(
      false,
    );
  });

  test("records timeout stoppage, minute start and explicit completion", () => {
    const { game, apply } = recording();
    apply({ type: "start-timeout", team: "home" });
    apply({ type: "set-timeout-running", running: true });
    apply({ type: "cancel-timeout" });
    expect(
      projectAdHocGameTimeline(game)
        .filter((entry) => entry.kind === "timeout")
        .map((entry) => entry.action),
    ).toEqual(["complete", "start", "stoppage"]);
  });

  test("records elapsed timeout completion during replay or at read time without another operation", () => {
    const { game, apply } = recording();
    apply({ type: "start-timeout", team: "home" }, 1000);
    apply({ type: "set-timeout-running", running: true }, 1001);
    const actions = (nowMs: number) =>
      projectAdHocGameTimeline(game, rules, nowMs)
        .filter((entry) => entry.kind === "timeout")
        .map((entry) => entry.action);
    expect(actions(61000)).toEqual(["start", "stoppage"]);
    expect(actions(61001)).toEqual(["complete", "start", "stoppage"]);
    apply({ type: "set-running", running: true }, 61001);
    expect(actions(61001)).toEqual(["complete", "start", "stoppage"]);
  });

  test("undo removes the entire timeout sequence and a replacement keeps only its own facts", () => {
    const { game, apply } = recording();
    apply({ type: "start-timeout", team: "away" });
    apply({ type: "set-timeout-running", running: true });
    apply({ type: "undo-timeout-start" });
    expect(projectAdHocGameTimeline(game).some((entry) => entry.kind === "timeout")).toBe(false);
    apply({ type: "start-timeout", team: "away" });
    expect(
      projectAdHocGameTimeline(game)
        .filter((entry) => entry.kind === "timeout")
        .map((entry) => entry.action),
    ).toEqual(["stoppage"]);
  });

  test("refuses history when timeout or suspension evidence disagrees with durable state", () => {
    const { game, apply } = recording();
    apply({ type: "start-timeout", team: "home" });
    expect(
      projectAdHocGameTimeline({
        ...game,
        state: { ...game.state, timeouts: { ...game.state.timeouts, active: null } },
      }),
    ).toEqual([]);
    expect(
      projectAdHocGameTimeline({ ...game, state: { ...game.state, isSuspended: true } }),
    ).toEqual([]);
  });

  test("does not publish invented history for incomplete, inconsistent, or unresolvable evidence", () => {
    const { game, apply } = recording();
    const id = apply({ type: "change-score", team: "home", delta: 10, reason: "goal" });
    expect(projectAdHocGameTimeline({ ...game, replayBaselineOperationIds: [id] })).toEqual([]);
    expect(
      projectAdHocGameTimeline({ ...game, state: { ...game.state, score: { home: 99, away: 0 } } }),
    ).toEqual([]);
    game.operations[id]!.causalPredecessorIds = ["missing-op"];
    expect(projectAdHocGameTimeline(game)).toEqual([]);
  });

  test("leaves phase scores unknown when manual adjustments have no goal provenance", () => {
    const { game, apply } = recording();
    apply({ type: "change-score", team: "home", delta: 100, reason: "manual" });
    apply({ type: "set-game-clock", gameClockMs: 1200000 });
    const timeline = projectAdHocGameTimeline(game);
    expect(timeline.find((entry) => entry.kind === "seeker-release")).toMatchObject({
      score: null,
    });
    expect(timeline.some((entry) => entry.kind === "goal")).toBe(false);
  });

  test("publishes durable fixture history through the runtime audience reader for all four games", async () => {
    const nowMs = Date.parse("2026-08-16T08:00:00Z");
    const service = createAdHocGamesService({
      store: createInMemoryAdHocStore(),
      now: () => nowMs,
    });
    const audience = createAudienceProjection(
      createFoundationEventCatalogStorage(createInMemoryFoundationStorage()),
      {
        now: () => nowMs,
        sqmFixtureGame: {
          async read(fixtureKey) {
            const result = await service.readFixture({ fixtureKey });
            return result.status === "accepted" ? result : null;
          },
        },
      },
    );
    for (const definition of SQM_FIXTURE_GAMES) {
      const created = await service.create({ homeName: definition.key, awayName: "ignored" });
      expect(created.status).toBe("accepted");
      if (created.status !== "accepted") throw new Error("fixture setup failed");
      const outcome = await service.apply({
        gameId: created.gameId,
        sessionId: created.sessionId,
        operations: [
          {
            id: `score-${definition.key}`,
            clientSentAtMs: nowMs,
            command: { type: "change-score", team: "home", delta: 10, reason: "goal" },
          },
        ],
      });
      expect(outcome.status).toBe("accepted");
      const projected = await audience.readGame("sqm-2026", definition.key);
      expect(projected).toMatchObject({
        status: "accepted",
        value: {
          sideA: { score: 10 },
          sideB: { score: 0 },
          timeline: [{ kind: "goal", points: 10, lane: "side-a" }],
        },
      });
    }
  });

  test("retains the first game's fixed result only while no backing fixture is bound", () => {
    const fallback = createSqmFixtureGameProjection(SQM_FIXTURE_GAMES[0]!, null, null, 1000);
    expect(fallback.sideA.score).toBe(40);
    expect(fallback.sideB.score).toBe(140);
    expect(fallback.clock?.gameTimeMs).toBe(1360000);
  });
});
