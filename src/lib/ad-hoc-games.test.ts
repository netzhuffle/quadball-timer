import { describe, expect, test } from "bun:test";
import {
  createAdHocGamesService,
  createInMemoryAdHocStore,
  type AdHocGamesService,
} from "@/lib/ad-hoc-games";

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
    expect(rejected).toMatchObject({ status: "rejected", reason: "capacity" });

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
});
