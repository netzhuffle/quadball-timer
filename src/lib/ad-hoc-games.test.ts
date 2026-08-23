import { describe, expect, test } from "bun:test";
import {
  AD_HOC_DISCONNECTED_GRACE_MS,
  createAdHocGamesService,
  createInMemoryAdHocStore,
  type AdHocStore,
  type AdHocGamesService,
} from "@/lib/ad-hoc-games";
import { AD_HOC_MAX_RETAINED_REJECTED_OPERATIONS_PER_GAME } from "@/lib/ad-hoc-resource-budgets";
import { applyGameCommand, createInitialGameState } from "@/lib/game-engine";
import { deriveAdHocOptimisticState } from "@/lib/game-page-support";
import type { AdHocPendingOperation } from "@/lib/ad-hoc-controller-session";

function service(): AdHocGamesService {
  return createAdHocGamesService({
    store: createInMemoryAdHocStore(),
    now: () => 1_000,
    random: (() => {
      let counter = 0;
      return () => `secret-${String(++counter).padStart(2, "0")}-abcdefghijklmnopqrstuvwxyz`;
    })(),
  });
}

describe("Ad Hoc Games service", () => {
  test("creates and reuses date-gated protected SQM fixture games with canonical values", async () => {
    let nowMs = Date.parse("2026-08-16T10:00:00.000Z");
    const store = createInMemoryAdHocStore();
    const games = createAdHocGamesService({ store, now: () => nowMs });

    const first = await games.create({
      homeName: "secret1",
      awayName: null,
      homeColor: "not-a-color",
      awayColor: { ignored: true },
      browserId: "browser-1",
    });
    expect(first).toMatchObject({ status: "accepted" });
    if (first.status !== "accepted") return;
    expect(first.game.state).toMatchObject({
      homeName: "Basel Basilisks / Luzern",
      awayName: "Berner Boggarts",
      homeColor: "#16a34a",
      awayColor: "#7f1d1d",
    });

    const second = await games.create({
      homeName: "secret1",
      awayName: "ignored",
      homeColor: "ignored",
      awayColor: "ignored",
      browserId: "browser-2",
    });
    expect(second).toMatchObject({ status: "accepted", gameId: first.gameId });
    if (second.status === "accepted") {
      expect(
        await games.read({ gameId: second.gameId, sessionId: second.sessionId }),
      ).toMatchObject({
        status: "accepted",
      });
    }
    expect(store.listGames()).toHaveLength(1);
    expect(store.listGames()[0]?.fixtureKey).toBe("secret1");

    nowMs += 24 * 60 * 60_000;
    const publicRead = await games.readFixture({ fixtureKey: "secret1" });
    expect(publicRead).toMatchObject({ status: "accepted", gameId: first.gameId });
  });

  test("derives multiple offline operations once from the authoritative base and rebases on reconciliation", () => {
    const authoritative = createInitialGameState({ id: "adhoc-optimistic", nowMs: 1_000 });
    const pending: AdHocPendingOperation[] = [
      {
        id: "offline-1",
        clientSentAtMs: 1_001,
        workflow: "ad-hoc",
        causalPredecessorIds: [],
        command: { type: "change-score", team: "home", delta: 10, reason: "goal" },
      },
      {
        id: "offline-2",
        clientSentAtMs: 1_002,
        workflow: "ad-hoc",
        causalPredecessorIds: ["offline-1"],
        command: { type: "change-score", team: "home", delta: 10, reason: "goal" },
      },
    ];
    expect(deriveAdHocOptimisticState(authoritative, pending).score.home).toBe(20);
    const reconciledBase = applyGameCommand({
      state: authoritative,
      command: pending[0]!.command,
      nowMs: 1_001,
      idGenerator: () => "server-1",
    });
    expect(
      deriveAdHocOptimisticState(reconciledBase, pending.slice(1), { "offline-1": "accepted" })
        .score.home,
    ).toBe(20);
  });

  test("orders reordered causal batches, blocks only descendants, and rejects identity conflicts", async () => {
    const games = service();
    const created = await games.create({ homeName: "Home", awayName: "Away" });
    if (created.status !== "accepted") throw new Error("creation failed");
    const replay = await games.apply({
      gameId: created.gameId,
      sessionId: created.sessionId,
      operations: [
        {
          id: "child",
          clientSentAtMs: 1_002,
          causalPredecessorIds: ["parent"],
          command: { type: "change-score", team: "home", delta: 10, reason: "goal" },
        },
        {
          id: "unrelated",
          clientSentAtMs: 1_000,
          command: { type: "change-score", team: "away", delta: 10, reason: "goal" },
        },
        {
          id: "parent",
          clientSentAtMs: 1_001,
          command: { type: "change-score", team: "home", delta: 10, reason: "goal" },
        },
      ],
    });
    expect(replay.status).toBe("accepted");
    if (replay.status !== "accepted") return;
    expect(replay.game.state.score).toEqual({ home: 20, away: 10 });
    const missing = await games.apply({
      gameId: created.gameId,
      sessionId: created.sessionId,
      operations: [
        {
          id: "blocked-child",
          clientSentAtMs: 1_003,
          causalPredecessorIds: ["missing"],
          command: { type: "change-score", team: "home", delta: 10, reason: "goal" },
        },
        {
          id: "still-unrelated",
          clientSentAtMs: 1_004,
          command: { type: "change-score", team: "away", delta: 10, reason: "goal" },
        },
      ],
    });
    expect(missing.status).toBe("accepted");
    if (missing.status === "accepted") {
      expect(
        missing.outcomes.find((outcome) => outcome.operationId === "blocked-child")?.status,
      ).toBe("rejected");
      expect(missing.game.state.score).toEqual({ home: 20, away: 20 });
    }
    const conflict = await games.apply({
      gameId: created.gameId,
      sessionId: created.sessionId,
      operations: [
        { id: "parent", clientSentAtMs: 1_001, command: { type: "set-running", running: true } },
      ],
    });
    expect(conflict).toMatchObject({ status: "rejected", reason: "conflict" });
    const cyclic = await games.apply({
      gameId: created.gameId,
      sessionId: created.sessionId,
      operations: [
        {
          id: "cycle-a",
          clientSentAtMs: 1_005,
          causalPredecessorIds: ["cycle-b"],
          command: { type: "change-score", team: "home", delta: 10, reason: "goal" },
        },
        {
          id: "cycle-b",
          clientSentAtMs: 1_006,
          causalPredecessorIds: ["cycle-a"],
          command: { type: "change-score", team: "away", delta: 10, reason: "goal" },
        },
      ],
    });
    expect(cyclic).toMatchObject({ status: "rejected", reason: "invalid-operation" });
    const reusedAfterRejectedBatch = await games.apply({
      gameId: created.gameId,
      sessionId: created.sessionId,
      operations: [
        {
          id: "cycle-a",
          clientSentAtMs: 1_005,
          command: { type: "change-score", team: "home", delta: 10, reason: "goal" },
        },
      ],
    });
    expect(reusedAfterRejectedBatch.status).toBe("accepted");
    if (reusedAfterRejectedBatch.status === "accepted") {
      expect(reusedAfterRejectedBatch.game.state.score).toEqual({ home: 30, away: 20 });
    }
  });
  test("normalizes bounded names and atomically admits the initially admitted Ad Hoc Controller", async () => {
    const games = service();
    const result = await games.create({
      homeName: "  A\u0308 ",
      awayName: " Away ",
      sourceKey: "browser-a",
    });

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.game.state.homeName).toBe("Ä");
    expect(result.game.state.awayName).toBe("Away");
    expect(result.game.state.id).toBe(result.gameId);
    expect(result.sessionId.length).toBeGreaterThanOrEqual(32);
    expect(result.controlQr.length).toBeGreaterThanOrEqual(32);

    const authorized = await games.read({ gameId: result.gameId, sessionId: result.sessionId });
    expect(authorized.status).toBe("accepted");
  });

  test("rejects malformed and oversized creation without allocating state", async () => {
    const store = createInMemoryAdHocStore();
    const games = createAdHocGamesService({ store, now: () => 1_000 });

    const malformed = await games.create({ homeName: "", awayName: "Away" });
    const oversized = await games.create({ homeName: "x".repeat(81), awayName: "Away" });

    expect(malformed).toMatchObject({ status: "rejected", reason: "invalid-input" });
    expect(oversized).toMatchObject({ status: "rejected", reason: "invalid-input" });
    expect(store.listGames()).toHaveLength(0);
  });

  test("requires an admitted Ad Hoc Controller session and keeps operation identities durable in the service", async () => {
    const games = service();
    const created = await games.create({ homeName: "Home", awayName: "Away" });
    if (created.status !== "accepted") throw new Error("creation failed");

    const unauthorized = await games.read({ gameId: created.gameId, sessionId: "wrong" });
    expect(unauthorized).toMatchObject({ status: "unavailable" });

    const operation = {
      id: "operation-1",
      clientSentAtMs: 1_000,
      command: { type: "set-running", running: true } as const,
    };
    const accepted = await games.apply({
      gameId: created.gameId,
      sessionId: created.sessionId,
      operations: [operation],
    });
    const duplicate = await games.apply({
      gameId: created.gameId,
      sessionId: created.sessionId,
      operations: [operation],
    });

    expect(accepted.status).toBe("accepted");
    expect(duplicate.status).toBe("duplicate");
    expect(
      (await games.read({ gameId: created.gameId, sessionId: created.sessionId })).status,
    ).toBe("accepted");
  });

  test("returns duplicate acknowledgements without rewriting unchanged Game state", async () => {
    const base = createInMemoryAdHocStore();
    let mutationWrites = 0;
    const store: AdHocStore = {
      close: () => base.close(),
      listGames: () => base.listGames(),
      readGame: (gameId) => base.readGame(gameId),
      createGame: (input) => base.createGame(input),
      mutateGame: (gameId, mutation) =>
        base.mutateGame(gameId, (game) => {
          const result = mutation(game);
          const rollsBack =
            result !== null &&
            typeof result === "object" &&
            "rollback" in result &&
            result.rollback === true;
          if (result !== null && result !== false && !rollsBack) mutationWrites += 1;
          return result;
        }),
    };
    const games = createAdHocGamesService({ store, now: () => 1_000 });
    const created = await games.create({ homeName: "Home", awayName: "Away" });
    if (created.status !== "accepted") throw new Error("creation failed");
    const operation = {
      id: "no-write-duplicate",
      clientSentAtMs: 1_000,
      command: { type: "set-running", running: true } as const,
    };
    const accepted = await games.apply({
      gameId: created.gameId,
      sessionId: created.sessionId,
      operations: [operation],
    });
    expect(accepted.status).toBe("accepted");
    const beforeDuplicate = store.readGame(created.gameId);
    const writesBeforeDuplicate = mutationWrites;

    const duplicate = await games.apply({
      gameId: created.gameId,
      sessionId: created.sessionId,
      operations: [operation],
    });

    expect(duplicate).toMatchObject({
      status: "duplicate",
      ackedOperationIds: [operation.id],
      outcomes: [{ operationId: operation.id, status: "duplicate", workflow: "ad-hoc" }],
    });
    expect(mutationWrites).toBe(writesBeforeDuplicate);
    expect(store.readGame(created.gameId)).toEqual(beforeDuplicate);
    if (duplicate.status === "duplicate" && beforeDuplicate !== null)
      expect(duplicate.game.state.updatedAtMs).toBe(beforeDuplicate.state.updatedAtMs);
  });

  test("bounds retained rejected evidence atomically without blocking accepted replay", async () => {
    let nowMs = 1_000;
    const games = createAdHocGamesService({ now: () => nowMs });
    const created = await games.create({ homeName: "Home", awayName: "Away" });
    if (created.status !== "accepted") throw new Error("creation failed");
    const reject = (id: string, predecessorId: string) => ({
      id,
      clientSentAtMs: nowMs,
      causalPredecessorIds: [predecessorId],
      command: { type: "set-running", running: true } as const,
    });
    for (let offset = 0; offset < AD_HOC_MAX_RETAINED_REJECTED_OPERATIONS_PER_GAME; offset += 8) {
      const operations = Array.from({ length: 8 }, (_, index) => {
        const operationId = `retained-rejection-${offset + index}`;
        if (offset === 8 && index === 1)
          return {
            id: operationId,
            clientSentAtMs: nowMs,
            causalPredecessorIds: ["retained-rejection-8"],
            command: { type: "set-running", running: true } as const,
          };
        return reject(operationId, `missing-${offset + index}`);
      });
      const result = await games.apply({
        gameId: created.gameId,
        sessionId: created.sessionId,
        operations,
      });
      expect(result.status).toBe("accepted");
      nowMs += 1_000;
    }
    const atLimit = games.store.readGame(created.gameId);
    expect(
      Object.values(atLimit?.operations ?? {}).filter(
        (operation) => operation.status !== "accepted",
      ),
    ).toHaveLength(AD_HOC_MAX_RETAINED_REJECTED_OPERATIONS_PER_GAME);
    expect(atLimit?.operations["retained-rejection-9"]?.status).toBe("causally-blocked");

    const overLimit = await games.apply({
      gameId: created.gameId,
      sessionId: created.sessionId,
      operations: [reject("over-limit", "missing-over-limit")],
    });
    expect(overLimit).toMatchObject({ status: "rejected", reason: "rate-limited" });
    expect(games.store.readGame(created.gameId)).toEqual(atLimit);

    nowMs += 1_000;
    const duplicateAtLimit = await games.apply({
      gameId: created.gameId,
      sessionId: created.sessionId,
      operations: [
        {
          ...reject("retained-rejection-0", "missing-0"),
          clientSentAtMs: 1_000,
        },
      ],
    });
    expect(duplicateAtLimit).toMatchObject({
      status: "duplicate",
      outcomes: [{ operationId: "retained-rejection-0", status: "rejected" }],
    });

    nowMs += 1_000;
    const mixedBefore = games.store.readGame(created.gameId);
    const mixed = await games.apply({
      gameId: created.gameId,
      sessionId: created.sessionId,
      operations: [
        {
          id: "accepted-in-rejected-mix",
          clientSentAtMs: nowMs,
          command: { type: "set-running", running: true },
        },
        reject("rejected-in-mix", "missing-in-mix"),
      ],
    });
    expect(mixed).toMatchObject({ status: "rejected", reason: "rate-limited" });
    expect(games.store.readGame(created.gameId)).toEqual(mixedBefore);

    nowMs += 1_000;
    const accepted = await games.apply({
      gameId: created.gameId,
      sessionId: created.sessionId,
      operations: [
        {
          id: "accepted-at-rejected-limit",
          clientSentAtMs: nowMs,
          command: { type: "set-running", running: true },
        },
      ],
    });
    expect(accepted).toMatchObject({ status: "accepted" });
    expect(
      games.store.readGame(created.gameId)?.operations["accepted-at-rejected-limit"]?.status,
    ).toBe("accepted");
  });

  test("uses the explicit Ad Hoc workflow and converges concurrent operations deterministically", async () => {
    const first = service();
    const created = await first.create({ homeName: "Home", awayName: "Away" });
    if (created.status !== "accepted") throw new Error("creation failed");
    const second = await first.admit({ gameId: created.gameId, controlQr: created.controlQr });
    if (second.status !== "accepted") throw new Error("admission failed");
    const replay = await first.apply({
      gameId: created.gameId,
      sessionId: second.game.sessionId,
      operations: [
        {
          id: "later-operation",
          clientSentAtMs: 1_002,
          workflow: "ad-hoc",
          command: { type: "change-score", team: "home", delta: 10, reason: "goal" },
        },
        {
          id: "earlier-operation",
          clientSentAtMs: 1_001,
          workflow: "ad-hoc",
          command: { type: "change-score", team: "away", delta: 10, reason: "goal" },
        },
      ],
    });
    expect(replay.status).toBe("accepted");
    if (replay.status !== "accepted") return;
    expect(replay.outcomes.every((outcome) => outcome.workflow === "ad-hoc")).toBe(true);
    expect(replay.game.state.score).toEqual({ home: 10, away: 10 });
    const restarted = createAdHocGamesService({ store: first.store, now: () => 1_003 });
    const recovered = await restarted.read({
      gameId: created.gameId,
      sessionId: created.sessionId,
    });
    expect(recovered.status).toBe("accepted");
    if (recovered.status === "accepted")
      expect(recovered.game.state.score).toEqual({ home: 10, away: 10 });
  });

  test("binds QR admission and retained sessions to the configured environment", async () => {
    const store = createInMemoryAdHocStore();
    const field = createAdHocGamesService({
      store,
      environmentIdentity: "field-a",
      now: () => 1_000,
    });
    const restartedField = createAdHocGamesService({
      store,
      environmentIdentity: "field-a",
      now: () => 1_000,
    });
    const copiedField = createAdHocGamesService({
      store,
      environmentIdentity: "field-b",
      now: () => 1_000,
    });
    const created = await field.create({ homeName: "Home", awayName: "Away" });
    if (created.status !== "accepted") throw new Error("creation failed");

    expect(
      (await restartedField.read({ gameId: created.gameId, sessionId: created.sessionId })).status,
    ).toBe("accepted");
    expect(
      (await copiedField.read({ gameId: created.gameId, sessionId: created.sessionId })).status,
    ).toBe("unavailable");
    expect(
      (await copiedField.admit({ gameId: created.gameId, controlQr: created.controlQr })).status,
    ).toBe("unavailable");
  });

  test("hands the unchanged QR to every Controller and replaces only a re-admitting browser", async () => {
    const games = service();
    const created = await games.create({
      homeName: "Home",
      awayName: "Away",
      browserId: "device-a",
    });
    if (created.status !== "accepted") throw new Error("creation failed");

    const secondDevice = await games.admit({
      gameId: created.gameId,
      controlQr: created.controlQr,
      browserId: "device-b",
    });
    if (secondDevice.status !== "accepted") throw new Error("second admission failed");
    expect(secondDevice.game.controlQr).toBe(created.controlQr);

    const refreshedDevice = await games.admit({
      gameId: created.gameId,
      controlQr: created.controlQr,
      browserId: "device-b",
    });
    if (refreshedDevice.status !== "accepted") throw new Error("refresh admission failed");
    expect(refreshedDevice.game.controlQr).toBe(created.controlQr);
    expect(
      (await games.read({ gameId: created.gameId, sessionId: secondDevice.game.sessionId })).status,
    ).toBe("unavailable");
    expect(
      (await games.read({ gameId: created.gameId, sessionId: created.sessionId })).status,
    ).toBe("accepted");
    expect(
      (await games.read({ gameId: created.gameId, sessionId: refreshedDevice.game.sessionId }))
        .status,
    ).toBe("accepted");
  });

  test("finishing blocks new admission, preserves existing authority, and re-enables the same QR", async () => {
    const games = service();
    const created = await games.create({ homeName: "Home", awayName: "Away" });
    if (created.status !== "accepted") throw new Error("creation failed");
    const admitted = await games.admit({ gameId: created.gameId, controlQr: created.controlQr });
    if (admitted.status !== "accepted") throw new Error("admission failed");

    const finished = await games.apply({
      gameId: created.gameId,
      sessionId: created.sessionId,
      operations: [
        {
          id: "finish",
          clientSentAtMs: 1_000,
          command: { type: "record-double-forfeit" },
        },
      ],
    });
    expect(finished.status).toBe("accepted");
    if (finished.status !== "accepted") return;
    expect(finished.game.state.isFinished).toBe(true);
    expect(finished.game.controlQr).toBeNull();
    expect(
      (await games.admit({ gameId: created.gameId, controlQr: created.controlQr })).status,
    ).toBe("unavailable");
    expect(
      (
        await games.apply({
          gameId: created.gameId,
          sessionId: admitted.game.sessionId,
          operations: [
            {
              id: "correction",
              clientSentAtMs: 1_001,
              command: { type: "correct-to-unfinished" },
            },
          ],
        })
      ).status,
    ).toBe("accepted");

    const reopened = await games.read({ gameId: created.gameId, sessionId: created.sessionId });
    expect(reopened.status).toBe("accepted");
    if (reopened.status !== "accepted") return;
    expect(reopened.game.state.isFinished).toBe(false);
    expect(reopened.game.controlQr).toBe(created.controlQr);
    expect(
      (await games.admit({ gameId: created.gameId, controlQr: created.controlQr })).status,
    ).toBe("accepted");
  });

  test("leave revokes only the leaving browser and requires a fresh QR admission", async () => {
    const games = service();
    const created = await games.create({ homeName: "Home", awayName: "Away" });
    if (created.status !== "accepted") throw new Error("creation failed");
    const other = await games.admit({ gameId: created.gameId, controlQr: created.controlQr });
    if (other.status !== "accepted") throw new Error("admission failed");

    expect(await games.leave({ gameId: created.gameId, sessionId: created.sessionId })).toBe(true);
    expect(
      (await games.read({ gameId: created.gameId, sessionId: created.sessionId })).status,
    ).toBe("unavailable");
    expect(
      (await games.read({ gameId: created.gameId, sessionId: other.game.sessionId })).status,
    ).toBe("accepted");
    expect(
      (await games.admit({ gameId: created.gameId, controlQr: created.controlQr })).status,
    ).toBe("accepted");
  });

  test("does not remove connected resource accounting when leave durability fails", async () => {
    const base = createInMemoryAdHocStore();
    let failMutations = false;
    const store: AdHocStore = {
      close: () => base.close(),
      listGames: () => base.listGames(),
      readGame: (gameId) => base.readGame(gameId),
      createGame: (input) => base.createGame(input),
      mutateGame: (gameId, mutation) => (failMutations ? null : base.mutateGame(gameId, mutation)),
    };
    const games = createAdHocGamesService({ store, now: () => 1_000 });
    const created = await games.create({ homeName: "Home", awayName: "Away" });
    if (created.status !== "accepted") throw new Error("creation failed");
    expect(
      await games.setConnection({
        gameId: created.gameId,
        sessionId: created.sessionId,
        connected: true,
        connectionId: "socket-leave",
      }),
    ).toBe(true);
    failMutations = true;
    expect(await games.leave({ gameId: created.gameId, sessionId: created.sessionId })).toBe(false);
    expect(games.getResourceMetrics().connectedControllers).toBe(1);
  });

  test("rejects malformed commands without changing current state", async () => {
    const games = service();
    const created = await games.create({ homeName: "Home", awayName: "Away" });
    if (created.status !== "accepted") throw new Error("creation failed");

    const rejected = await games.apply({
      gameId: created.gameId,
      sessionId: created.sessionId,
      operations: [
        {
          id: "bad-command",
          clientSentAtMs: 1_000,
          command: { type: "not-a-game-command" } as never,
        },
      ],
    });
    const read = await games.read({ gameId: created.gameId, sessionId: created.sessionId });

    expect(rejected).toMatchObject({ status: "rejected", reason: "invalid-operation" });
    expect(read.status).toBe("accepted");
    if (read.status === "accepted") expect(read.game.state.isRunning).toBe(false);
  });

  test("retains pending work and emits no acknowledgement when durable mutation fails", async () => {
    const base = createInMemoryAdHocStore();
    const failingStore: AdHocStore = {
      close: () => base.close(),
      listGames: () => base.listGames(),
      readGame: (gameId) => base.readGame(gameId),
      createGame: (input) => base.createGame(input),
      mutateGame: () => null,
    };
    const games = createAdHocGamesService({ store: failingStore, now: () => 1_000 });
    expect(
      await games.apply({
        gameId: "adhoc-missing",
        sessionId: "session-that-is-long-enough-to-pass-validation-123456",
        operations: [
          {
            id: "durable-failure",
            clientSentAtMs: 1_000,
            command: { type: "set-running", running: true },
          },
        ],
      }),
    ).toMatchObject({ status: "rejected", reason: "unavailable" });
  });

  test("keeps capacity cleanup isolated and rejects protected saturation", async () => {
    let nowMs = 1_000;
    const store = createInMemoryAdHocStore();
    const games = createAdHocGamesService({ store, now: () => nowMs });
    const created: Array<{ gameId: string; sessionId: string }> = [];

    for (let index = 0; index < 50; index += 1) {
      nowMs += 60 * 60_000;
      const result = await games.create({
        homeName: `Home ${index}`,
        awayName: "Away",
        sourceKey: `source-${index}`,
      });
      if (result.status !== "accepted") throw new Error("capacity setup failed");
      created.push(result);
      await games.setConnection({
        gameId: result.gameId,
        sessionId: result.sessionId,
        connected: true,
      });
    }

    const rejected = await games.create({
      homeName: "New",
      awayName: "Game",
      sourceKey: "new-source",
    });
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: "capacity",
      detail: "Ad Hoc capacity is currently full; no game was changed.",
    });

    await games.setConnection({
      gameId: created[0]!.gameId,
      sessionId: created[0]!.sessionId,
      connected: false,
    });
    nowMs += 5 * 60_000;
    const replacement = await games.create({
      homeName: "New",
      awayName: "Game",
      sourceKey: "new-source-2",
    });
    expect(replacement.status).toBe("accepted");
    expect(store.listGames()).toHaveLength(50);
    expect(store.readGame(created[0]!.gameId)).toBeNull();
  });

  test("keeps the four protected SQM games in addition to the fifty-game Ad Hoc capacity", async () => {
    let nowMs = Date.parse("2026-08-16T00:00:00.000Z");
    const store = createInMemoryAdHocStore();
    const games = createAdHocGamesService({ store, now: () => nowMs });
    let firstOrdinary: { gameId: string; sessionId: string } | undefined;

    for (const fixtureKey of ["secret1", "secret2", "secret3", "secret4"] as const) {
      const result = await games.create({ homeName: fixtureKey, awayName: "ignored", nowMs });
      expect(result.status).toBe("accepted");
    }
    for (let index = 0; index < 50; index += 1) {
      nowMs += 60 * 60_000;
      const result = await games.create({
        homeName: `Home ${index}`,
        awayName: "Away",
        sourceKey: `ordinary-source-${index}`,
        nowMs,
      });
      if (result.status !== "accepted") throw new Error("ordinary capacity setup failed");
      firstOrdinary ??= result;
      await games.setConnection({
        gameId: result.gameId,
        sessionId: result.sessionId,
        connected: true,
        nowMs,
      });
    }

    const protectedIds = store
      .listGames()
      .filter((game) => game.fixtureKey !== undefined)
      .map((game) => game.gameId);
    expect(store.listGames()).toHaveLength(54);
    expect(protectedIds).toHaveLength(4);

    if (firstOrdinary === undefined) throw new Error("Expected an ordinary game.");
    expect(
      await games.setConnection({
        gameId: firstOrdinary.gameId,
        sessionId: firstOrdinary.sessionId,
        connected: false,
        nowMs,
      }),
    ).toBe(true);
    nowMs += AD_HOC_DISCONNECTED_GRACE_MS;
    const replacement = await games.create({
      homeName: "Replacement",
      awayName: "Game",
      sourceKey: "replacement-source",
      nowMs,
    });
    expect(replacement.status).toBe("accepted");
    expect(store.listGames()).toHaveLength(54);
    expect(
      store
        .listGames()
        .filter((game) => game.fixtureKey !== undefined)
        .map((game) => game.gameId),
    ).toEqual(expect.arrayContaining(protectedIds));
  });

  test("protects newly admitted sessions and enforces the exact five-minute boundary", async () => {
    let nowMs = 1_000;
    const store = createInMemoryAdHocStore();
    const games = createAdHocGamesService({ store, now: () => nowMs });

    for (let index = 0; index < 49; index += 1) {
      nowMs += 60 * 60_000;
      const result = await games.create({
        homeName: `Home ${index}`,
        awayName: "Away",
        sourceKey: `source-${index}`,
      });
      if (result.status !== "accepted") throw new Error("capacity setup failed");
      await games.setConnection({
        gameId: result.gameId,
        sessionId: result.sessionId,
        connected: true,
      });
    }

    const newlyAdmitted = await games.create({
      homeName: "Newly",
      awayName: "Admitted",
      sourceKey: "newly-admitted",
      nowMs,
    });
    expect(newlyAdmitted.status).toBe("accepted");
    if (newlyAdmitted.status !== "accepted") return;

    const immediatelyRejected = await games.create({
      homeName: "Immediate",
      awayName: "Attempt",
      sourceKey: "immediate-attempt",
      nowMs,
    });
    expect(immediatelyRejected).toMatchObject({ status: "rejected", reason: "capacity" });

    nowMs += AD_HOC_DISCONNECTED_GRACE_MS - 1;
    const beforeBoundary = await games.create({
      homeName: "Before",
      awayName: "Boundary",
      sourceKey: "before-boundary",
      nowMs,
    });
    expect(beforeBoundary).toMatchObject({ status: "rejected", reason: "capacity" });
    expect(store.readGame(newlyAdmitted.gameId)).not.toBeNull();

    nowMs += 1;
    const atBoundary = await games.create({
      homeName: "At",
      awayName: "Boundary",
      sourceKey: "at-boundary",
      nowMs,
    });
    expect(atBoundary.status).toBe("accepted");
    expect(store.readGame(newlyAdmitted.gameId)).toBeNull();
  });

  test("enforces one global cap without pruning another environment", async () => {
    let nowMs = 1_000;
    const store = createInMemoryAdHocStore();
    const fieldA = createAdHocGamesService({
      store,
      environmentIdentity: "field-a",
      now: () => nowMs,
    });
    const fieldB = createAdHocGamesService({
      store,
      environmentIdentity: "field-b",
      now: () => nowMs,
    });

    for (let index = 0; index < 49; index += 1) {
      nowMs += 60 * 60_000;
      const result = await fieldA.create({
        homeName: `Field A ${index}`,
        awayName: "Away",
        sourceKey: `field-a-${index}`,
      });
      if (result.status !== "accepted") throw new Error("mixed capacity setup failed");
      await fieldA.setConnection({
        gameId: result.gameId,
        sessionId: result.sessionId,
        connected: true,
      });
    }

    const otherEnvironment = await fieldB.create({
      homeName: "Field B",
      awayName: "Away",
      sourceKey: "field-b",
      nowMs,
    });
    if (otherEnvironment.status !== "accepted") throw new Error("mixed environment setup failed");
    await fieldB.setConnection({
      gameId: otherEnvironment.gameId,
      sessionId: otherEnvironment.sessionId,
      connected: true,
      nowMs,
    });

    const rejected = await fieldA.create({
      homeName: "Blocked",
      awayName: "Capacity",
      sourceKey: "field-a-new",
      nowMs,
    });
    expect(rejected).toMatchObject({ status: "rejected", reason: "capacity" });
    expect(store.listGames()).toHaveLength(50);
    expect(store.readGame(otherEnvironment.gameId)).not.toBeNull();
  });
});
