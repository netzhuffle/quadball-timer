import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyGameCommand, createInitialGameState } from "@/lib/game-engine";
import { createEventCatalog, createInMemoryEventCatalogStorage } from "@/lib/event-catalog";
import {
  MemoryTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
} from "@/lib/technical-admin-auth";
import {
  AD_HOC_DISCONNECTED_GRACE_MS,
  createAdHocGamesService,
  createInMemoryAdHocStore,
  openSqliteAdHocStore,
} from "@/lib/ad-hoc-games";

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

  test("leaves the complete SQLite snapshot unchanged when capacity is fully protected", async () => {
    const root = await mkdtemp(join(tmpdir(), "quadball-timer-adhoc-capacity-snapshot-"));
    const databasePath = join(root, "ad-hoc.sqlite");
    const nowMs = 10_000_000_000;
    const store = openSqliteAdHocStore(databasePath, "field-a");
    const games = createAdHocGamesService({
      store,
      environmentIdentity: "field-a",
      now: () => nowMs,
    });
    try {
      for (let index = 0; index < 50; index += 1) {
        const created = await games.create({
          homeName: `Home ${index}`,
          awayName: "Away",
          sourceKey: `protected-source-${index}`,
          nowMs: nowMs - (50 - index) * 2 * 60 * 60_000,
        });
        if (created.status !== "accepted") throw new Error("protected capacity setup failed");
        expect(
          await games.setConnection({
            gameId: created.gameId,
            sessionId: created.sessionId,
            connected: true,
            nowMs,
          }),
        ).toBe(true);
      }

      const seed = new Database(databasePath, { strict: true });
      seed.run(
        "INSERT INTO adhoc_creation_events (source_hash, successful, occurred_at_ms, retry_until_ms) VALUES (?, 1, ?, NULL)",
        ["expired-evidence", nowMs - 2 * 60 * 60_000],
      );
      seed.close();
      const snapshot = () => {
        const database = new Database(databasePath, { strict: true });
        const value = JSON.stringify({
          games: database.query("SELECT * FROM adhoc_games ORDER BY game_id").all(),
          creationEvents: database
            .query(
              "SELECT * FROM adhoc_creation_events ORDER BY occurred_at_ms, source_hash, successful, retry_until_ms",
            )
            .all(),
        });
        database.close();
        return value;
      };
      const before = snapshot();

      expect(
        await games.create({
          homeName: "Rejected",
          awayName: "Capacity",
          sourceKey: "new-protected-source",
          nowMs,
        }),
      ).toMatchObject({ status: "rejected", reason: "capacity" });
      expect(snapshot()).toBe(before);
    } finally {
      games.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("holds a real SQLite cleanup transaction across a competing connection and survives restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "quadball-timer-adhoc-capacity-focused-"));
    const databasePath = join(root, "ad-hoc.sqlite");
    const worker = join(process.cwd(), "scripts/ad-hoc-capacity-race-worker.ts");
    const seedStore = openSqliteAdHocStore(databasePath, "field-a");
    const first = createAdHocGamesService({
      store: seedStore,
      environmentIdentity: "field-a",
      now: () => 10_000_000_000,
    });
    const created: Array<{ gameId: string; sessionId: string }> = [];
    const nowMs = 10_000_000_000;
    let firstClosed = false;
    let connectWorker: ReturnType<typeof startWorker> | null = null;
    let createWorker: ReturnType<typeof startWorker> | null = null;
    let primaryError: unknown = null;

    try {
      for (let index = 0; index < 50; index += 1) {
        const result = await first.create({
          homeName: `Home ${index}`,
          awayName: "Away",
          sourceKey: `focused-source-${index}`,
          nowMs: nowMs - (50 - index) * 2 * 60 * 60_000,
        });
        if (result.status !== "accepted") throw new Error("focused capacity setup failed");
        created.push(result);
      }

      const oldest = created[0]!;
      const connectedBeforeRestart = await first.subscribe({
        gameId: created[1]!.gameId,
        sessionId: created[1]!.sessionId,
        nowMs,
      });
      expect(connectedBeforeRestart.status).toBe("accepted");
      first.close();
      firstClosed = true;

      const enteredPath = join(root, "create-entered");
      const releasePath = join(root, "create-release");
      const connectEnteredPath = join(root, "connect-entered");
      const connectProceedPath = join(root, "connect-proceed");
      connectWorker = startWorker(
        worker,
        databasePath,
        "connect",
        oldest.gameId,
        oldest.sessionId,
        String(nowMs),
        "field-a",
        connectEnteredPath,
        connectProceedPath,
      );
      await waitForFile(connectEnteredPath);
      createWorker = startWorker(
        worker,
        databasePath,
        "create",
        enteredPath,
        releasePath,
        String(nowMs),
        "field-a",
      );
      await waitForFile(enteredPath);
      writeFileSync(connectProceedPath, "proceed");
      const connectOutput = await connectWorker.result;
      expect(JSON.parse(connectOutput)).toEqual({ connected: false });
      writeFileSync(releasePath, "release");
      const createOutput = await createWorker.result;
      expect(JSON.parse(createOutput)).toMatchObject({ status: "accepted" });

      const verifyStore = openSqliteAdHocStore(databasePath, "field-a");
      const retained = verifyStore.listGames();
      expect(retained).toHaveLength(50);
      expect(
        retained.filter((game) => !created.some((item) => item.gameId === game.gameId)),
      ).toHaveLength(1);
      expect(verifyStore.readGame(oldest.gameId)).toBeNull();

      const collisionTarget = retained.at(-1)!;
      const collisionId = collisionTarget.gameId.replace(/^adhoc-/u, "");
      const collision = createAdHocGamesService({
        store: verifyStore,
        environmentIdentity: "field-a",
        now: () => nowMs,
        random: () => collisionId,
      });
      const failedReplacement = await collision.create({
        homeName: "Collision",
        awayName: "Away",
        sourceKey: "focused-collision",
        nowMs,
      });
      expect(failedReplacement).toMatchObject({ status: "rejected", reason: "unavailable" });
      expect(verifyStore.listGames()).toHaveLength(50);
      expect(verifyStore.readGame(collisionTarget.gameId)).not.toBeNull();

      collision.close();

      const replacementStore = openSqliteAdHocStore(databasePath, "field-a", {
        reconcileConnectionsAtStartup: true,
        startupNowMs: nowMs + 1,
      });
      const restarted = createAdHocGamesService({
        store: replacementStore,
        environmentIdentity: "field-a",
        now: () => nowMs + AD_HOC_DISCONNECTED_GRACE_MS + 1,
      });
      const restartedGame = replacementStore
        .listGames()
        .find((game) => game.gameId === created[1]!.gameId);
      expect(restartedGame).toBeDefined();
      expect(restartedGame?.sessions[0]?.connected).toBe(false);
      expect(restartedGame?.sessions[0]?.lastDisconnectedAtMs).toBe(nowMs + 1);
      restarted.close();
    } catch (error) {
      primaryError = error;
    }
    const cleanupResults = await Promise.allSettled(
      [createWorker, connectWorker]
        .filter((worker): worker is ReturnType<typeof startWorker> => worker !== null)
        .map((worker) => cleanupWorker(worker)),
    );
    if (!firstClosed) first.close();
    const cleanupErrors = cleanupResults
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (cleanupErrors.length > 0) {
      if (primaryError !== null) {
        throw new AggregateError(
          [primaryError, ...cleanupErrors],
          "Focused SQLite race failed and worker cleanup also failed.",
        );
      }
      throw cleanupErrors.length === 1
        ? cleanupErrors[0]
        : new AggregateError(cleanupErrors, "Focused SQLite worker cleanup failed.");
    }
    await rm(root, { recursive: true, force: true });
    if (primaryError !== null) throw primaryError;
  });

  test("keeps Event storage and authority work accepted while Ad Hoc capacity is protected", async () => {
    const eventAuth = createTechnicalAdminAuth(
      { environment: "test", origin: "https://timer.example", rpId: "timer.example" },
      new MemoryTechnicalAdminAuthRepository(),
    );
    const authority = eventAuth.resolveHostLocalAuthority();
    const eventStorage = createInMemoryEventCatalogStorage();
    let nextEventId = 0;
    const eventCatalog = createEventCatalog(eventStorage, {
      clock: { nowMs: () => 1_000 },
      ids: { next: (kind) => `${kind}-isolation-${++nextEventId}` },
    });
    const event = await eventCatalog.createEvent(
      { name: "SQM isolation", timeZone: "Europe/Zurich" },
      authority,
    );
    expect(event.status).toBe("accepted");
    if (event.status !== "accepted") return;

    let nowMs = 1_000;
    const adHocStore = createInMemoryAdHocStore();
    const adHoc = createAdHocGamesService({ store: adHocStore, now: () => nowMs });
    for (let index = 0; index < 50; index += 1) {
      nowMs += 60 * 60_000;
      const created = await adHoc.create({
        homeName: `Protected ${index}`,
        awayName: "Away",
        sourceKey: `protected-${index}`,
      });
      if (created.status !== "accepted") throw new Error("Event isolation setup failed");
      await adHoc.setConnection({
        gameId: created.gameId,
        sessionId: created.sessionId,
        connected: true,
        nowMs,
      });
    }

    const blocked = await adHoc.create({
      homeName: "Blocked",
      awayName: "Ad Hoc",
      sourceKey: "blocked-isolation",
      nowMs,
    });
    expect(blocked).toMatchObject({ status: "rejected", reason: "capacity" });
    expect(adHocStore.listGames()).toHaveLength(50);

    const updated = await eventCatalog.updateEvent(
      event.value.eventId,
      { name: "SQM isolation updated" },
      authority,
    );
    expect(updated).toMatchObject({ status: "accepted", value: { name: "SQM isolation updated" } });
    const inspected = await eventCatalog.inspectEvent(event.value.eventId, authority);
    expect(inspected).toMatchObject({
      status: "accepted",
      value: { eventId: event.value.eventId, name: "SQM isolation updated" },
    });
    eventAuth.close();
  });
});

async function runWorker(worker: string, databasePath: string, mode: string, ...args: string[]) {
  return await startWorker(worker, databasePath, mode, ...args).result;
}

async function cleanupWorker(worker: ReturnType<typeof startWorker>) {
  if (!(await waitForExit(worker.child, 0))) await terminateChild(worker.child);
}

function startWorker(worker: string, databasePath: string, mode: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, "run", worker, databasePath, mode, ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const result = (async () => {
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
  })();
  return { child, result };
}

async function waitForFile(path: string) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`focused barrier did not appear: ${path}`);
    await Bun.sleep(10);
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
