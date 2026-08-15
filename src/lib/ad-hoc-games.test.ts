import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAdHocGamesService,
  createInMemoryAdHocStore,
  openSqliteAdHocStore,
  type AdHocGamesService,
} from "@/lib/ad-hoc-games";
import { createInitialGameState } from "@/lib/game-engine";

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

  test("migrates a retained #152 SQLite Game into the upgrading environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "quadball-timer-adhoc-migration-"));
    const databasePath = join(root, "ad-hoc.sqlite");
    const gameId = "adhoc-legacy-game-1234567890";
    const sessionId = "legacy-session-1234567890-abcdefghijklmnopqrstuvwxyz";
    const controlQr = "legacy-control-qr-1234567890-abcdefghijklmnopqrstuvwxyz";
    const state = createInitialGameState({
      id: gameId,
      nowMs: 1_000,
      homeName: "Home",
      awayName: "Away",
      homeColor: "#0f172a",
      awayColor: "#f8fafc",
    });
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const legacyDb = new Database(databasePath, { create: true, strict: true });
    legacyDb.run(
      "CREATE TABLE adhoc_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
    );
    legacyDb.run("INSERT INTO adhoc_schema (id, version) VALUES (1, 1)");
    legacyDb.run(`CREATE TABLE adhoc_games (
      game_id TEXT PRIMARY KEY,
      created_at_ms INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      control_qr TEXT NOT NULL,
      control_qr_hash TEXT NOT NULL,
      sessions_json TEXT NOT NULL,
      operations_json TEXT NOT NULL
    )`);
    legacyDb.run(`CREATE TABLE adhoc_creation_events (
      source_hash TEXT NOT NULL,
      successful INTEGER NOT NULL,
      occurred_at_ms INTEGER NOT NULL
    )`);
    legacyDb.run(
      "INSERT INTO adhoc_games (game_id, created_at_ms, state_json, control_qr, control_qr_hash, sessions_json, operations_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        gameId,
        1_000,
        JSON.stringify(state),
        controlQr,
        digest(controlQr),
        JSON.stringify([
          {
            sessionHash: digest(sessionId),
            browserId: null,
            connected: false,
            lastConnectedAtMs: 1_000,
            lastDisconnectedAtMs: null,
          },
        ]),
        JSON.stringify({}),
      ],
    );
    legacyDb.close();

    try {
      const firstStore = openSqliteAdHocStore(databasePath, "field-a");
      const first = createAdHocGamesService({
        store: firstStore,
        environmentIdentity: "field-a",
        now: () => 1_000,
      });
      const firstRead = await first.read({ gameId, sessionId });
      expect(firstRead.status).toBe("accepted");
      if (firstRead.status !== "accepted") return;
      expect(firstRead.game.controlQr).toBe(controlQr);
      first.close();

      const secondStore = openSqliteAdHocStore(databasePath, "field-a");
      const restarted = createAdHocGamesService({
        store: secondStore,
        environmentIdentity: "field-a",
        now: () => 1_000,
      });
      const restartedRead = await restarted.read({ gameId, sessionId });
      expect(restartedRead.status).toBe("accepted");
      if (restartedRead.status === "accepted") {
        expect(restartedRead.game.controlQr).toBe(controlQr);
      }
      const admitted = await restarted.admit({ gameId, controlQr });
      expect(admitted.status).toBe("accepted");
      restarted.close();

      const copiedStore = openSqliteAdHocStore(databasePath, "field-b");
      const copied = createAdHocGamesService({
        store: copiedStore,
        environmentIdentity: "field-b",
        now: () => 1_000,
      });
      expect((await copied.read({ gameId, sessionId })).status).toBe("unavailable");
      copied.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
