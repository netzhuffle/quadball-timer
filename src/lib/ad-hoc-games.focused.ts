import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyGameCommand, createInitialGameState } from "@/lib/game-engine";
import { createAdHocGamesService, openSqliteAdHocStore } from "@/lib/ad-hoc-games";

describe("Ad Hoc SQLite focused integration", () => {
  test("migrates accepted history as a replay baseline and preserves duplicate/conflict outcomes after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "quadball-timer-adhoc-migration-focused-"));
    const databasePath = join(root, "ad-hoc.sqlite");
    const gameId = "adhoc-legacy-game-1234567890";
    const sessionId = "legacy-session-1234567890-abcdefghijklmnopqrstuvwxyz";
    const controlQr = "legacy-control-qr-1234567890-abcdefghijklmnopqrstuvwxyz";
    const state = createInitialGameState({ id: gameId, nowMs: 1_000 });
    const legacyOperation = {
      fingerprint: JSON.stringify([
        "ad-hoc",
        1_001,
        { type: "change-score", team: "home", delta: 10, reason: "goal" },
        [],
      ]),
      command: { type: "change-score", team: "home", delta: 10, reason: "goal" } as const,
      acceptedAtMs: 1_001,
      status: "accepted",
    };
    const acceptedState = applyGameCommand({
      state,
      command: legacyOperation.command,
      nowMs: legacyOperation.acceptedAtMs,
      idGenerator: () => "legacy-generated",
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
    legacyDb.run(
      "CREATE TABLE adhoc_creation_events (source_hash TEXT NOT NULL, successful INTEGER NOT NULL, occurred_at_ms INTEGER NOT NULL)",
    );
    legacyDb.run(
      "INSERT INTO adhoc_games (game_id, created_at_ms, state_json, control_qr, control_qr_hash, sessions_json, operations_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        gameId,
        1_000,
        JSON.stringify(acceptedState),
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
        JSON.stringify({ "legacy-operation": legacyOperation }),
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
      const applied = await first.apply({
        gameId,
        sessionId,
        operations: [
          {
            id: "new-operation",
            clientSentAtMs: 1_002,
            command: { type: "change-score", team: "home", delta: 10, reason: "goal" },
          },
        ],
      });
      expect(applied.status).toBe("accepted");
      if (applied.status === "accepted")
        expect(applied.game.state.score).toEqual({ home: 20, away: 0 });
      first.close();
      const restartedStore = openSqliteAdHocStore(databasePath, "field-a");
      const restarted = createAdHocGamesService({
        store: restartedStore,
        environmentIdentity: "field-a",
        now: () => 1_003,
      });
      const recovered = await restarted.read({ gameId, sessionId });
      expect(recovered.status).toBe("accepted");
      if (recovered.status === "accepted")
        expect(recovered.game.state.score).toEqual({ home: 20, away: 0 });
      expect(
        (
          await restarted.apply({
            gameId,
            sessionId,
            operations: [
              { id: "legacy-operation", clientSentAtMs: 1_001, command: legacyOperation.command },
            ],
          })
        ).status,
      ).toBe("duplicate");
      const conflict = await restarted.apply({
        gameId,
        sessionId,
        operations: [
          {
            id: "legacy-operation",
            clientSentAtMs: 1_001,
            command: { type: "set-running", running: true },
          },
        ],
      });
      expect(conflict).toMatchObject({ status: "rejected", reason: "conflict" });
      restarted.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed on corrupt retained SQLite state without acknowledgement", async () => {
    const root = await mkdtemp(join(tmpdir(), "quadball-timer-adhoc-corrupt-focused-"));
    const databasePath = join(root, "ad-hoc.sqlite");
    try {
      const store = openSqliteAdHocStore(databasePath);
      const games = createAdHocGamesService({ store, now: () => 1_000 });
      const created = await games.create({ homeName: "Home", awayName: "Away" });
      if (created.status !== "accepted") throw new Error("creation failed");
      store.close();
      const tamper = new Database(databasePath, { create: false, strict: true });
      tamper.run("UPDATE adhoc_games SET state_json = ? WHERE game_id = ?", [
        '{"score":null}',
        created.gameId,
      ]);
      tamper.close();
      const reopenedStore = openSqliteAdHocStore(databasePath);
      const reopened = createAdHocGamesService({ store: reopenedStore, now: () => 1_001 });
      expect(
        (await reopened.read({ gameId: created.gameId, sessionId: created.sessionId })).status,
      ).toBe("unavailable");
      const unavailable = await reopened.apply({
        gameId: created.gameId,
        sessionId: created.sessionId,
        operations: [
          {
            id: "must-not-ack",
            clientSentAtMs: 1_001,
            command: { type: "set-running", running: true },
          },
        ],
      });
      expect(unavailable).toMatchObject({ status: "rejected", reason: "unavailable" });
      reopenedStore.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when accepted SQLite history points at a missing predecessor", async () => {
    const root = await mkdtemp(join(tmpdir(), "quadball-timer-adhoc-causal-corrupt-focused-"));
    const databasePath = join(root, "ad-hoc.sqlite");
    try {
      const store = openSqliteAdHocStore(databasePath);
      const games = createAdHocGamesService({ store, now: () => 1_000 });
      const created = await games.create({ homeName: "Home", awayName: "Away" });
      if (created.status !== "accepted") throw new Error("creation failed");
      const applied = await games.apply({
        gameId: created.gameId,
        sessionId: created.sessionId,
        operations: [
          {
            id: "accepted",
            clientSentAtMs: 1_001,
            command: { type: "set-running", running: true },
          },
        ],
      });
      expect(applied.status).toBe("accepted");
      store.close();
      const tamper = new Database(databasePath, { create: false, strict: true });
      const row = tamper
        .query("SELECT operations_json FROM adhoc_games WHERE game_id = ?")
        .get(created.gameId) as { operations_json: string };
      const operations = JSON.parse(row.operations_json) as Record<string, Record<string, unknown>>;
      operations.accepted!.causalPredecessorIds = ["missing-predecessor"];
      tamper.run("UPDATE adhoc_games SET operations_json = ? WHERE game_id = ?", [
        JSON.stringify(operations),
        created.gameId,
      ]);
      tamper.close();
      const reopenedStore = openSqliteAdHocStore(databasePath);
      const reopened = createAdHocGamesService({ store: reopenedStore, now: () => 1_002 });
      expect(
        (await reopened.read({ gameId: created.gameId, sessionId: created.sessionId })).status,
      ).toBe("unavailable");
      reopenedStore.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when blocked SQLite history has no retained rejected predecessor", async () => {
    const root = await mkdtemp(join(tmpdir(), "quadball-timer-adhoc-blocked-corrupt-focused-"));
    const databasePath = join(root, "ad-hoc.sqlite");
    try {
      const store = openSqliteAdHocStore(databasePath);
      const games = createAdHocGamesService({ store, now: () => 1_000 });
      const created = await games.create({ homeName: "Home", awayName: "Away" });
      if (created.status !== "accepted") throw new Error("creation failed");
      const applied = await games.apply({
        gameId: created.gameId,
        sessionId: created.sessionId,
        operations: [
          {
            id: "missing-child",
            clientSentAtMs: 1_001,
            causalPredecessorIds: ["missing"],
            command: { type: "set-running", running: true },
          },
          {
            id: "blocked-child",
            clientSentAtMs: 1_002,
            causalPredecessorIds: ["missing-child"],
            command: { type: "set-running", running: false },
          },
        ],
      });
      expect(applied.status).toBe("accepted");
      store.close();

      const tamper = new Database(databasePath, { create: false, strict: true });
      const row = tamper
        .query("SELECT operations_json FROM adhoc_games WHERE game_id = ?")
        .get(created.gameId) as { operations_json: string };
      const operations = JSON.parse(row.operations_json) as Record<string, Record<string, unknown>>;
      operations["blocked-child"]!.causalPredecessorIds = ["missing-blocker"];
      tamper.run("UPDATE adhoc_games SET operations_json = ? WHERE game_id = ?", [
        JSON.stringify(operations),
        created.gameId,
      ]);
      tamper.close();

      const reopenedStore = openSqliteAdHocStore(databasePath);
      const reopened = createAdHocGamesService({ store: reopenedStore, now: () => 1_003 });
      expect(
        (await reopened.read({ gameId: created.gameId, sessionId: created.sessionId })).status,
      ).toBe("unavailable");
      reopenedStore.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("migration, state, and operation identity survive a bounded process-boundary restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "quadball-timer-adhoc-focused-"));
    const databasePath = join(root, "ad-hoc.sqlite");
    const worker = join(process.cwd(), "scripts/ad-hoc-restart-worker.ts");
    try {
      const created = await runWorker(worker, databasePath, "create");
      const identity = JSON.parse(created) as { gameId: string; sessionId: string };
      const applied = await runWorker(
        worker,
        databasePath,
        "apply",
        identity.gameId,
        identity.sessionId,
      );
      expect(JSON.parse(applied)).toEqual({
        gameId: identity.gameId,
        running: true,
        status: "accepted",
      });
      const duplicate = await runWorker(
        worker,
        databasePath,
        "duplicate",
        identity.gameId,
        identity.sessionId,
      );
      expect(JSON.parse(duplicate)).toEqual({
        gameId: identity.gameId,
        running: true,
        status: "duplicate",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function runWorker(worker: string, databasePath: string, mode: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, "run", worker, databasePath, mode, ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = Promise.all([
      readBounded(child.stdout, 16 * 1024),
      readBounded(child.stderr, 16 * 1024),
      child.exited,
    ]);
    const result = await Promise.race([
      output,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("focused worker exceeded 10 second deadline")),
          10_000,
        );
      }),
    ]);
    const [stdout, stderr, exitCode] = result;
    if (exitCode !== 0) throw new Error(`worker failed: ${stderr || stdout}`);
    return stdout.trim();
  } catch (error) {
    await terminateChild(child);
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function terminateChild(child: ReturnType<typeof Bun.spawn>) {
  child.kill("SIGTERM");
  if (await waitForExit(child, 250)) return;

  child.kill("SIGKILL");
  if (!(await waitForExit(child, 1_000))) {
    throw new Error("focused worker did not terminate within the final reap deadline");
  }
}

async function waitForExit(child: ReturnType<typeof Bun.spawn>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    return await Promise.race([child.exited.then(() => true), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return output;
    output += decoder.decode(chunk.value, { stream: true });
    if (Buffer.byteLength(output, "utf8") > limit) {
      throw new Error("focused worker output exceeded 16 KiB limit");
    }
  }
}
