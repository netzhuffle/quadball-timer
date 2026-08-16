import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyGameCommand, createInitialGameState } from "@/lib/game-engine";
import {
  createControlActionCodecRegistry,
  createDeterministicTestIqaInterpreter,
} from "@/lib/event-game-actions";
import { createEventCatalog, createInMemoryEventCatalogStorage } from "@/lib/event-catalog";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import { createGrantTestKeyRing, createGrantTestRandomness } from "@/lib/grant-authority-contract";
import { createGrantTestAuthorityVerifier } from "@/lib/grant-authority-test-support";
import {
  createFoundationRecovery,
  type FoundationRecoveryOptions,
} from "@/lib/foundation-recovery";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import {
  MemoryTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
} from "@/lib/technical-admin-auth";
import {
  AD_HOC_DISCONNECTED_GRACE_MS,
  createAdHocGamesService,
  createSqliteAdHocRecoveryAdapter,
  createInMemoryAdHocStore,
  openSqliteAdHocStore,
} from "@/lib/ad-hoc-games";

describe("Ad Hoc SQLite focused integration", () => {
  test("persists a protected SQM fixture game and its public lookup across restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "quadball-timer-adhoc-sqm-restart-"));
    const databasePath = join(root, "ad-hoc.sqlite");
    const nowMs = Date.parse("2026-08-16T10:00:00.000Z");
    try {
      const store = openSqliteAdHocStore(databasePath, "sqm-test");
      const games = createAdHocGamesService({
        store,
        environmentIdentity: "sqm-test",
        now: () => nowMs,
      });
      const created = await games.create({
        homeName: "secret4",
        awayName: "ignored",
        homeColor: "ignored",
        awayColor: "ignored",
      });
      expect(created).toMatchObject({ status: "accepted" });
      if (created.status !== "accepted") return;
      games.close();

      const reopenedStore = openSqliteAdHocStore(databasePath, "sqm-test");
      const reopened = createAdHocGamesService({
        store: reopenedStore,
        environmentIdentity: "sqm-test",
        now: () => nowMs + 24 * 60 * 60_000,
      });
      const publicRead = await reopened.readFixture({ fixtureKey: "secret4" });
      expect(publicRead).toMatchObject({
        status: "accepted",
        gameId: created.gameId,
        fixtureKey: "secret4",
        game: {
          state: {
            homeName: "Friendlies",
            awayName: "Kidditch",
          },
        },
      });
      expect(reopenedStore.listGames()).toHaveLength(1);
      expect(reopenedStore.listGames()[0]?.fixtureKey).toBe("secret4");
      reopened.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

  test("rejects mixed-environment recovery images before publication or activation", async () => {
    const root = await mkdtemp(join(tmpdir(), "quadball-timer-adhoc-recovery-focused-"));
    const livePath = join(root, "ad-hoc.sqlite");
    const validSnapshotPath = join(root, "valid-snapshot.sqlite");
    const contaminatedPath = join(root, "contaminated.sqlite");
    const rejectedPublicationPath = join(root, "rejected-publication.sqlite");
    const environmentIdentity = "sqm-test";
    try {
      const store = openSqliteAdHocStore(livePath, environmentIdentity);
      const service = createAdHocGamesService({
        store,
        environmentIdentity,
        now: () => 2_000,
      });
      const created = await service.create({
        homeName: "Home",
        awayName: "Away",
        sourceKey: "recovery-focused-source",
        nowMs: 1_000,
      });
      if (created.status !== "accepted") throw new Error("recovery setup creation failed");
      const secondCreated = await service.create({
        homeName: "Second Home",
        awayName: "Second Away",
        sourceKey: "recovery-focused-second-source",
        nowMs: 1_001,
      });
      if (secondCreated.status !== "accepted")
        throw new Error("second recovery setup creation failed");
      const recovery = store.recovery;
      if (recovery === undefined) throw new Error("SQLite recovery adapter is unavailable");
      const validFacts = await recovery.createRecoveryVacuumSnapshot(validSnapshotPath);
      expect(validFacts).toMatchObject({
        environmentIdentity,
        retainedGameCount: 2,
        unfinishedGameCount: 2,
        creationEventCount: 2,
      });
      await recovery.quiesceForRecovery();
      service.close();

      copyFileSync(validSnapshotPath, contaminatedPath);
      const otherStore = openSqliteAdHocStore(contaminatedPath, "other-environment");
      const otherService = createAdHocGamesService({
        store: otherStore,
        environmentIdentity: "other-environment",
        now: () => 2_000,
      });
      const otherCreated = await otherService.create({
        homeName: "Other Home",
        awayName: "Other Away",
        sourceKey: "other-recovery-focused-source",
        nowMs: 1_001,
      });
      if (otherCreated.status !== "accepted") throw new Error("mixed-environment setup failed");
      otherService.close();
      const contaminatedRecovery = createSqliteAdHocRecoveryAdapter(
        contaminatedPath,
        environmentIdentity,
      );
      await expectRejected(
        contaminatedRecovery.createRecoveryVacuumSnapshot(rejectedPublicationPath),
      );
      expect(existsSync(rejectedPublicationPath)).toBe(false);
      await expectRejected(
        contaminatedRecovery.verifyRecoverySnapshot(contaminatedPath, validFacts),
      );
      expect(contaminatedRecovery.readiness(contaminatedPath)).toMatchObject({
        ok: false,
        status: "integrity-failure",
      });

      const validLiveFacts = createSqliteAdHocRecoveryAdapter(
        livePath,
        environmentIdentity,
      ).inspectRecoveryDatabase(livePath);
      expect(validLiveFacts).toEqual(validFacts);
      expect(validLiveFacts.retainedGameCount).toBe(2);
      expect(validLiveFacts.creationEventCount).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("backs up a previous compatible schema before the next activation migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "quadball-timer-adhoc-legacy-recovery-focused-"));
    const databasePath = join(root, "ad-hoc.sqlite");
    const snapshotPath = join(root, "snapshot.sqlite");
    try {
      const database = new Database(databasePath, { create: true, strict: true });
      database.exec(`
        CREATE TABLE adhoc_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
        INSERT INTO adhoc_schema (id, version) VALUES (1, 4);
        CREATE TABLE adhoc_games (
          game_id TEXT PRIMARY KEY,
          environment_identity TEXT NOT NULL DEFAULT '',
          created_at_ms INTEGER NOT NULL,
          state_json TEXT NOT NULL,
          initial_state_json TEXT NOT NULL,
          replay_baseline_operation_ids_json TEXT NOT NULL DEFAULT '[]',
          control_qr TEXT NOT NULL,
          control_qr_hash TEXT NOT NULL,
          sessions_json TEXT NOT NULL,
          operations_json TEXT NOT NULL
        );
        CREATE TABLE adhoc_creation_events (
          source_hash TEXT NOT NULL,
          successful INTEGER NOT NULL,
          occurred_at_ms INTEGER NOT NULL,
          retry_until_ms INTEGER
        );
      `);
      database.close();

      const recovery = createSqliteAdHocRecoveryAdapter(databasePath, "production");
      const facts = await recovery.createRecoveryVacuumSnapshot(snapshotPath);
      expect(facts).toMatchObject({
        schemaVersion: 4,
        environmentIdentity: "production",
        retainedGameCount: 0,
        creationEventCount: 0,
      });
      await expect(recovery.verifyRecoverySnapshot(snapshotPath, facts)).resolves.toEqual(facts);

      const futureDatabase = new Database(databasePath, { create: false, strict: true });
      futureDatabase.run("UPDATE adhoc_schema SET version = 6 WHERE id = 1");
      futureDatabase.close();
      await expect(
        recovery.createRecoveryVacuumSnapshot(join(root, "future.sqlite")),
      ).rejects.toThrow("Ad Hoc recovery database schema is incompatible.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires authoritative Ad Hoc writeability for readiness", async () => {
    const root = await mkdtemp(join(tmpdir(), "quadball-timer-adhoc-readiness-focused-"));
    const databasePath = join(root, "ad-hoc.sqlite");
    try {
      const store = openSqliteAdHocStore(databasePath, "sqm-test");
      const service = createAdHocGamesService({
        store,
        environmentIdentity: "sqm-test",
        now: () => 3_000,
      });
      expect((await service.create({ homeName: "Home", awayName: "Away" })).status).toBe(
        "accepted",
      );
      service.close();

      const adapter = createSqliteAdHocRecoveryAdapter(databasePath, "sqm-test");
      chmodSync(databasePath, 0o444);
      expect(adapter.readiness()).toMatchObject({ ok: false, status: "unavailable" });
      chmodSync(databasePath, 0o600);
      for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
        if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
      }

      const locker = new Database(databasePath, { create: false, strict: true });
      locker.run("PRAGMA busy_timeout = 0");
      locker.run("BEGIN IMMEDIATE");
      try {
        expect(adapter.readiness()).toMatchObject({ ok: false, status: "unavailable" });
      } finally {
        locker.run("ROLLBACK");
        locker.close();
      }

      const injected = createSqliteAdHocRecoveryAdapter(databasePath, "sqm-test", {
        recoveryWriteabilityProbe: () => {
          throw new Error("ENOSPC injected for readiness probe");
        },
      });
      expect(injected.readiness()).toMatchObject({ ok: false, status: "unavailable" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("restores Ad Hoc through the composed Foundation recovery boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "quadball-timer-adhoc-foundation-focused-"));
    const liveDirectory = join(root, "live");
    await mkdir(liveDirectory, { recursive: true });
    const foundationPath = join(liveDirectory, "foundation.sqlite");
    const adHocPath = join(liveDirectory, "ad-hoc.sqlite");
    const backupDirectory = join(root, "backup");
    const technicalAdminPath = join(root, "technical-admin.sqlite");
    let foundationStorage: ReturnType<typeof openSqliteFoundationStorage> | null = null;
    let adHocService: ReturnType<typeof createAdHocGamesService> | null = null;
    try {
      const keyRing = createGrantTestKeyRing();
      const readinessContext = {
        actionCodecRegistry: createControlActionCodecRegistry(),
        interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      };
      const grant: GrantAuthorityOptions = {
        environmentId: "test",
        clock: { nowMs: () => 10 },
        randomness: createGrantTestRandomness(),
        keyRing,
        controlScopeResolver: {
          resolve: () => ({ status: "eligible", eventGameId: "game-1" }),
          resolveSession: (_scope, sessionEventGameId) => ({
            status: "current",
            eventGameId: sessionEventGameId,
          }),
        },
        privilegedAuthorityVerifier: createGrantTestAuthorityVerifier(),
      };
      foundationStorage = openSqliteFoundationStorage(foundationPath, {
        grantKeyRing: keyRing,
        grantValidationContext: { environmentId: "test", keyRing },
      });
      await foundationStorage.applyMigrations({ requireCandidate: false });
      foundationStorage.setReadinessContext(readinessContext);

      const adHocStore = openSqliteAdHocStore(adHocPath, "sqm-test");
      adHocService = createAdHocGamesService({
        store: adHocStore,
        environmentIdentity: "sqm-test",
        now: () => 2_000,
      });
      const created = await adHocService.create({
        homeName: "Home",
        awayName: "Away",
        sourceKey: "foundation-composed-source",
        nowMs: 1_000,
      });
      if (created.status !== "accepted") throw new Error("composed setup creation failed");
      const snapshotOperation = await adHocService.apply({
        gameId: created.gameId,
        sessionId: created.sessionId,
        operations: [
          {
            id: "snapshot-operation",
            clientSentAtMs: 1_100,
            command: { type: "change-score", team: "home", delta: 1, reason: "goal" },
          },
        ],
      });
      expect(snapshotOperation.status).toBe("accepted");

      const foundationOptions: FoundationRecoveryOptions = {
        backupDirectory,
        keyRing,
        readinessContext,
        grant,
        acceptance: {
          externalScopeResolver: {
            resolve: (scope) => ({ status: "resolved" as const, scope: structuredClone(scope) }),
            resolveEventTeam: () => ({ status: "resolved" as const }),
          },
          clock: () => 10,
          interpreter: readinessContext.interpreter,
        },
        technicalAdminAuth: {
          databasePath: technicalAdminPath,
          async quiesce() {},
          adapter: {
            async prepareForFoundationRestore() {
              return { outcome: "preserved-transients-invalidated" as const };
            },
          },
        },
        nowMs: () => 10,
      };
      let recovery = createFoundationRecovery(foundationStorage, {
        ...foundationOptions,
        adHoc: adHocStore.recovery,
        createId: () => "composed-snapshot",
      });
      const manifest = await recovery.createPreDeploymentBackup();
      const manifestPath = join(backupDirectory, `${manifest.snapshotId}.manifest.json`);
      expect(manifest.adHoc).toBeDefined();
      expect(await recovery.verifyBackup(manifestPath)).toEqual(manifest);
      const adHocBackupPath = join(backupDirectory, manifest.adHoc!.databaseFile);
      const validAdHocBackup = readFileSync(adHocBackupPath);

      const finished = await adHocService.apply({
        gameId: created.gameId,
        sessionId: created.sessionId,
        operations: [
          {
            id: "finish-after-snapshot",
            clientSentAtMs: 1_200,
            command: { type: "record-double-forfeit" },
          },
        ],
      });
      expect(finished.status).toBe("accepted");
      if (finished.status === "accepted") expect(finished.game.state.isFinished).toBe(true);
      expect(
        await adHocService.leave({ gameId: created.gameId, sessionId: created.sessionId }),
      ).toBe(true);

      const tampered = Buffer.from(validAdHocBackup);
      writeFileSync(adHocBackupPath, tampered);
      const invalidDatabase = new Database(adHocBackupPath, { create: false, strict: true });
      invalidDatabase.run("UPDATE adhoc_games SET control_qr_hash = ?", ["0".repeat(64)]);
      invalidDatabase.close();
      await expectRejected(recovery.restore(manifestPath));
      expect(adHocStore.readGame(created.gameId)?.state.isFinished).toBe(true);
      writeFileSync(adHocBackupPath, validAdHocBackup);

      const rollbackRecovery = createFoundationRecovery(foundationStorage, {
        ...foundationOptions,
        adHoc: adHocStore.recovery,
        createId: () => "composed-rollback",
        faultInjector(phase) {
          if (phase === "before-live-replacement") throw new Error("composed rollback");
        },
      });
      await expectRejected(rollbackRecovery.restore(manifestPath), "composed rollback");
      expect(existsSync(adHocPath)).toBe(true);
      expect(existsSync(`${adHocPath}.failed-composed-rollback`)).toBe(false);
      expect(existsSync(foundationPath)).toBe(true);
      expect(existsSync(`${foundationPath}.failed-composed-rollback`)).toBe(false);

      adHocService = null;
      foundationStorage = null;
      const reopenedAdHocStore = openSqliteAdHocStore(adHocPath, "sqm-test");
      const reopenedAdHoc = createAdHocGamesService({
        store: reopenedAdHocStore,
        environmentIdentity: "sqm-test",
        now: () => 2_001,
      });
      const reopenedFoundation = openSqliteFoundationStorage(foundationPath, {
        grantKeyRing: keyRing,
        grantValidationContext: { environmentId: "test", keyRing },
      });
      reopenedFoundation.setReadinessContext(readinessContext);
      recovery = createFoundationRecovery(reopenedFoundation, {
        ...foundationOptions,
        adHoc: reopenedAdHocStore.recovery,
        createId: () => "composed-restore",
      });
      const restored = await recovery.restore(manifestPath);
      expect(restored.failedAdHocDatabasePath).not.toBeNull();
      reopenedAdHoc.close();
      reopenedFoundation.close();

      const restoredAdHocStore = openSqliteAdHocStore(adHocPath, "sqm-test");
      const restoredAdHoc = createAdHocGamesService({
        store: restoredAdHocStore,
        environmentIdentity: "sqm-test",
        now: () => 2_002,
      });
      const resumed = await restoredAdHoc.read({
        gameId: created.gameId,
        sessionId: created.sessionId,
        nowMs: 2_002,
      });
      expect(resumed).toMatchObject({
        status: "accepted",
        game: { gameId: created.gameId, controlQr: created.controlQr },
      });
      if (resumed.status !== "accepted") throw new Error("restored session did not resume");
      expect(resumed.game.state.isFinished).toBe(false);
      expect(
        (
          await restoredAdHoc.admit({
            gameId: created.gameId,
            controlQr: created.controlQr,
            browserId: "restored-browser",
            nowMs: 2_003,
          })
        ).status,
      ).toBe("accepted");
      const postSnapshot = await restoredAdHoc.apply({
        gameId: created.gameId,
        sessionId: created.sessionId,
        operations: [
          {
            id: "finish-after-snapshot",
            clientSentAtMs: 1_200,
            command: { type: "record-double-forfeit" },
          },
        ],
      });
      expect(postSnapshot.status).toBe("accepted");
      restoredAdHoc.close();
    } finally {
      adHocService?.close();
      foundationStorage?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function expectRejected(promise: Promise<unknown>, message?: string): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  if (message !== undefined) expect((failure as Error).message).toContain(message);
}

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
