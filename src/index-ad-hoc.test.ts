import { describe, expect, test } from "bun:test";
import {
  createAdHocLiveSessionTracker,
  createAdHocGamesService,
  createInMemoryAdHocStore,
  type AdHocGamesService,
} from "@/lib/ad-hoc-games";
import {
  adHocFallbackRoute,
  admitGame,
  broadcastGameSnapshot,
  calculateAdHocUpgradeCapacity,
  createGame,
  leaveGame,
  readAdHocSession,
  readAuthorizedAdHocGame,
  readGame,
  resolveAdHocWebSocketSubscription,
  type AdHocBroadcastSocket,
} from "./index";

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

async function createViaHttp(games: AdHocGamesService, homeName: string, browserId?: string) {
  const response = await createGame(
    new Request("http://localhost/api/games", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ homeName, awayName: "Away", browserId }),
    }),
    games,
  );
  expect(response.status).toBe(201);
  const payload = (await response.json()) as { gameId: string; controlQr: string };
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null) throw new Error("creation did not return authority");
  return { ...payload, setCookie, cookie: setCookie.split(";")[0]! };
}

describe("Ad Hoc HTTP and WebSocket authority boundaries", () => {
  test("reuses ordinary broadcast serialization while isolating sender acknowledgement and queue failure", async () => {
    const games = service();
    const created = await games.create({ homeName: "Home", awayName: "Away" });
    if (created.status !== "accepted") throw new Error("creation failed");
    const admitted = await games.admit({
      gameId: created.gameId,
      controlQr: created.controlQr,
    });
    if (admitted.status !== "accepted") throw new Error("admission failed");

    const socket = (sessionId: string, sendResult: "success" | "failure" = "success") => {
      const messages: string[] = [];
      const closes: Array<{ code: number; reason: string }> = [];
      const candidate: AdHocBroadcastSocket = {
        data: { subscription: { type: "game", gameId: created.gameId, sessionId } },
        send(serialized) {
          messages.push(serialized);
          return sendResult === "success" ? new TextEncoder().encode(serialized).byteLength : 0;
        },
        close(code, reason) {
          closes.push({ code, reason });
        },
      };
      return { candidate, messages, closes };
    };
    const sender = socket(created.sessionId);
    const ordinary = socket(admitted.game.sessionId);
    const pressured = socket(admitted.game.sessionId, "failure");
    const removed = socket("removed-session-abcdefghijklmnopqrstuvwxyz");
    let serializations = 0;
    const serialize = (payload: Parameters<typeof JSON.stringify>[0]) => {
      serializations += 1;
      return JSON.stringify(payload);
    };

    const delivered = await broadcastGameSnapshot({
      gameId: created.gameId,
      service: games,
      sender: sender.candidate,
      candidates: [sender.candidate, ordinary.candidate, pressured.candidate, removed.candidate],
      senderAckedCommandIds: ["accepted-command"],
      operationOutcomes: [
        { operationId: "accepted-command", workflow: "ad-hoc", status: "accepted" },
      ],
      serverNowMs: 2_000,
      serialize,
    });

    expect(delivered).toBe(true);
    expect(serializations).toBe(2);
    expect(ordinary.messages).toEqual(pressured.messages);
    expect(removed.messages).toEqual([]);
    expect(sender.messages).toHaveLength(1);
    expect(JSON.parse(sender.messages[0]!).ackedCommandIds).toEqual(["accepted-command"]);
    expect(JSON.parse(ordinary.messages[0]!).ackedCommandIds).toEqual([]);
    expect(pressured.closes).toEqual([{ code: 1013, reason: "Ad Hoc output backpressure." }]);
    expect(games.getResourceMetrics().queuePressure).toBe(1);
    expect([...sender.messages, ...ordinary.messages].join("")).not.toContain(created.sessionId);

    await games.leave({ gameId: created.gameId, sessionId: created.sessionId });
    serializations = 0;
    sender.messages.length = 0;
    ordinary.messages.length = 0;
    expect(
      await broadcastGameSnapshot({
        gameId: created.gameId,
        service: games,
        sender: sender.candidate,
        candidates: [sender.candidate, ordinary.candidate],
        senderAckedCommandIds: ["must-not-be-acknowledged"],
        operationOutcomes: [],
        serverNowMs: 3_000,
        serialize,
      }),
    ).toBe(false);
    expect(sender.messages).toEqual([]);
    expect(ordinary.messages).toHaveLength(1);
    expect(JSON.parse(ordinary.messages[0]!).ackedCommandIds).toEqual([]);
    expect(serializations).toBe(1);
  });

  test("caps pre-upgrade Ad Hoc capacity below the configured Event reserve", () => {
    expect(
      calculateAdHocUpgradeCapacity({
        totalConnections: 5,
        reservedConnections: 2,
        activeControllerSessions: 0,
        maxConnectedSockets: 10,
      }),
    ).toBe(3);
    expect(
      calculateAdHocUpgradeCapacity({
        totalConnections: 5,
        reservedConnections: 2,
        activeControllerSessions: 4,
        maxConnectedSockets: 10,
      }),
    ).toBe(1);
    expect(
      calculateAdHocUpgradeCapacity({
        totalConnections: 5,
        reservedConnections: 8,
        activeControllerSessions: 0,
        maxConnectedSockets: 10,
      }),
    ).toBe(0);
  });

  test("deduplicates concurrent socket subscriptions and retries a failed final disconnect", async () => {
    const disconnected: string[] = [];
    let durable = false;
    const scheduled: Array<{ delayMs: number; task: () => void }> = [];
    const tracker = createAdHocLiveSessionTracker(
      async (identity) => {
        disconnected.push(`${identity.gameId}:${identity.sessionId}`);
        return durable;
      },
      {
        scheduleRetry: (delayMs, task) => scheduled.push({ delayMs, task }),
      },
    );
    const identity = { gameId: "adhoc-game", sessionId: "session-token" };

    const subscriptions = await Promise.all([
      tracker.subscribe("socket-1", identity),
      tracker.subscribe("socket-1", identity),
    ]);
    expect(subscriptions.map((result) => result.attached)).toEqual([true, true]);
    expect(tracker.count(identity)).toBe(1);
    expect(await tracker.disconnect("socket-1")).toBe(false);
    expect(tracker.count(identity)).toBe(0);
    expect(disconnected).toEqual(["adhoc-game:session-token"]);
    expect(tracker.pendingCount()).toBe(1);
    expect(scheduled.map((item) => item.delayMs)).toEqual([100]);

    durable = true;
    scheduled.shift()!.task();
    expect(await tracker.retryPending()).toBe(true);
    expect(tracker.pendingCount()).toBe(0);
    expect(disconnected).toEqual(["adhoc-game:session-token", "adhoc-game:session-token"]);
  });

  test("bounds pending disconnect work per injected retry tick and releases socket tombstones", async () => {
    const scheduled: Array<{ delayMs: number; task: () => void }> = [];
    let durable = false;
    let disconnectAttempts = 0;
    const tracker = createAdHocLiveSessionTracker(
      async () => {
        disconnectAttempts += 1;
        return durable;
      },
      {
        retryBatchSize: 2,
        retryBaseDelayMs: 40,
        retryMaxDelayMs: 160,
        scheduleRetry: (delayMs, task) => scheduled.push({ delayMs, task }),
      },
    );

    for (let index = 0; index < 5; index += 1) {
      const identity = { gameId: `game-${index}`, sessionId: `session-${index}` };
      await tracker.subscribe(`socket-${index}`, identity);
      expect(await tracker.disconnect(`socket-${index}`)).toBe(false);
    }
    expect(tracker.pendingCount()).toBe(5);
    expect(scheduled.map((item) => item.delayMs)).toEqual([40]);
    expect(disconnectAttempts).toBe(5);

    scheduled.shift()!.task();
    expect(await tracker.retryPending()).toBe(false);
    expect(disconnectAttempts).toBe(7);
    expect(tracker.pendingCount()).toBe(5);
    expect(scheduled.map((item) => item.delayMs)).toEqual([80]);

    durable = true;
    while (tracker.pendingCount() > 0) {
      scheduled.shift()!.task();
      await tracker.retryPending();
    }
    expect(tracker.pendingCount()).toBe(0);
    expect(tracker.tombstoneCount()).toBe(0);
  });

  test("rotates failed retry entries so a later transient disconnect is not starved", async () => {
    const scheduled: Array<{ delayMs: number; task: () => void }> = [];
    let transientAttempts = 0;
    const tracker = createAdHocLiveSessionTracker(
      async (identity) => {
        if (identity.gameId === "transient") {
          transientAttempts += 1;
          return transientAttempts > 1;
        }
        return false;
      },
      {
        retryBatchSize: 2,
        scheduleRetry: (delayMs, task) => scheduled.push({ delayMs, task }),
      },
    );

    for (const gameId of ["permanent-1", "permanent-2", "permanent-3", "transient"]) {
      const identity = { gameId, sessionId: `${gameId}-session` };
      await tracker.subscribe(gameId, identity);
      expect(await tracker.disconnect(gameId)).toBe(false);
    }
    expect(transientAttempts).toBe(1);
    expect(tracker.pendingCount()).toBe(4);

    scheduled.shift()!.task();
    await tracker.retryPending();
    expect(transientAttempts).toBe(1);

    scheduled.shift()!.task();
    await tracker.retryPending();
    expect(transientAttempts).toBe(2);
    expect(tracker.pendingCount()).toBe(3);
  });

  test("retains a closed socket tombstone until queued disconnect durability drains", async () => {
    let releaseDisconnect!: (durable: boolean) => void;
    let markCallbackStarted!: () => void;
    const callbackStarted = new Promise<void>((resolve) => {
      markCallbackStarted = resolve;
    });
    const tracker = createAdHocLiveSessionTracker(
      async () =>
        await new Promise<boolean>((resolve) => {
          markCallbackStarted();
          releaseDisconnect = resolve;
        }),
      { scheduleRetry: () => undefined },
    );
    const identity = { gameId: "game", sessionId: "session" };
    await tracker.subscribe("socket", identity);
    const disconnect = tracker.disconnect("socket");
    await callbackStarted;
    expect(tracker.tombstoneCount()).toBe(1);
    releaseDisconnect(true);
    expect(await disconnect).toBe(true);
    expect(tracker.tombstoneCount()).toBe(0);
  });

  test("retains two Games in one browser authority set and leaving one preserves the other", async () => {
    const games = service();
    const first = await createViaHttp(games, "First");
    const second = await createViaHttp(games, "Second");
    const authoritySet = `${first.cookie}; ${second.cookie}`;
    expect(first.setCookie).toContain("Max-Age=31536000");
    expect(second.setCookie).toContain("Max-Age=31536000");

    expect(readAdHocSession(authoritySet, first.gameId)).toBeTruthy();
    expect(readAdHocSession(authoritySet, second.gameId)).toBeTruthy();
    expect(
      (
        await readGame(
          new Request(`http://localhost/api/games/${first.gameId}`, {
            headers: { cookie: authoritySet },
          }),
          games,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await readGame(
          new Request(`http://localhost/api/games/${second.gameId}`, {
            headers: { cookie: authoritySet },
          }),
          games,
        )
      ).status,
    ).toBe(200);

    const left = await leaveGame(
      new Request(`http://localhost/api/games/${first.gameId}/leave`, {
        method: "POST",
        headers: { cookie: authoritySet },
      }),
      games,
    );
    expect(left.status).toBe(200);
    expect(
      (
        await readGame(
          new Request(`http://localhost/api/games/${first.gameId}`, {
            headers: { cookie: authoritySet },
          }),
          games,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await readGame(
          new Request(`http://localhost/api/games/${second.gameId}`, {
            headers: { cookie: authoritySet },
          }),
          games,
        )
      ).status,
    ).toBe(200);
    expect(left.headers.get("set-cookie")).toContain(`adhoc_session_${first.gameId}=`);
    expect(left.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("lets an admitted Ad Hoc Controller operate with equal authority", async () => {
    const games = service();
    const created = await games.create({ homeName: "Home", awayName: "Away" });
    if (created.status !== "accepted") throw new Error("creation failed");
    const admitted = await games.admit({ gameId: created.gameId, controlQr: created.controlQr });
    if (admitted.status !== "accepted") throw new Error("admission failed");

    const applied = await games.apply({
      gameId: created.gameId,
      sessionId: admitted.game.sessionId,
      operations: [
        {
          id: "admitted-controller-operation",
          clientSentAtMs: 1_000,
          command: { type: "set-running", running: true },
        },
      ],
    });
    expect(applied.status).toBe("accepted");
    const creatorView = await readAuthorizedAdHocGame(games, created.gameId, created.sessionId);
    const admittedView = await readAuthorizedAdHocGame(
      games,
      created.gameId,
      admitted.game.sessionId,
    );
    expect(creatorView?.state.isRunning).toBe(true);
    expect(admittedView?.state.isRunning).toBe(true);
    expect(admittedView?.sessionId).toBe(admitted.game.sessionId);
    expect(admittedView?.sessionId).not.toBe(creatorView?.sessionId);
  });

  test("admits a second browser directly and replaces only its prior persistent session", async () => {
    const games = service();
    const created = await createViaHttp(games, "Home", "device-a");
    const firstAdmission = await admitGame(
      new Request(`http://localhost/api/games/${created.gameId}/admit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ controlQr: created.controlQr, browserId: "device-b" }),
      }),
      games,
    );
    expect(firstAdmission.status).toBe(200);
    const firstCookie = firstAdmission.headers.get("set-cookie");
    if (firstCookie === null) throw new Error("first admission did not return a session");

    const secondAdmission = await admitGame(
      new Request(`http://localhost/api/games/${created.gameId}/admit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ controlQr: created.controlQr, browserId: "device-b" }),
      }),
      games,
    );
    expect(secondAdmission.status).toBe(200);
    const secondCookie = secondAdmission.headers.get("set-cookie");
    if (secondCookie === null) throw new Error("second admission did not return a session");
    expect(
      (
        await readGame(
          new Request(`http://localhost/api/games/${created.gameId}`, {
            headers: { cookie: firstCookie },
          }),
          games,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await readGame(
          new Request(`http://localhost/api/games/${created.gameId}`, {
            headers: { cookie: secondCookie },
          }),
          games,
        )
      ).status,
    ).toBe(200);
  });

  test("keeps copied QR admission generic when the runtime environment differs", async () => {
    const store = createInMemoryAdHocStore();
    const field = createAdHocGamesService({
      store,
      environmentIdentity: "field-a",
      now: () => 1_000,
    });
    const copiedField = createAdHocGamesService({
      store,
      environmentIdentity: "field-b",
      now: () => 1_000,
    });
    const created = await createViaHttp(field, "Home");
    const response = await admitGame(
      new Request(`http://localhost/api/games/${created.gameId}/admit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ controlQr: created.controlQr }),
      }),
      copiedField,
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('{"error":"Ad Hoc Game unavailable."}');
  });

  test("uses the current HttpOnly Game cookie to replace a session without browser storage", async () => {
    const games = service();
    const created = await createViaHttp(games, "Home");
    const firstAdmission = await admitGame(
      new Request(`http://localhost/api/games/${created.gameId}/admit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ controlQr: created.controlQr }),
      }),
      games,
    );
    const firstCookie = firstAdmission.headers.get("set-cookie");
    if (firstCookie === null) throw new Error("first admission did not return a session");
    const secondAdmission = await admitGame(
      new Request(`http://localhost/api/games/${created.gameId}/admit`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: firstCookie.split(";")[0]!,
        },
        body: JSON.stringify({ controlQr: created.controlQr }),
      }),
      games,
    );
    const secondCookie = secondAdmission.headers.get("set-cookie");
    if (secondCookie === null) throw new Error("second admission did not return a session");

    expect(
      (
        await readGame(
          new Request(`http://localhost/api/games/${created.gameId}`, {
            headers: { cookie: firstCookie },
          }),
          games,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await readGame(
          new Request(`http://localhost/api/games/${created.gameId}`, {
            headers: { cookie: secondCookie },
          }),
          games,
        )
      ).status,
    ).toBe(200);
  });

  test("returns one generic HTTP outcome for known, unknown, malformed, and unauthorized Games", async () => {
    const games = service();
    const known = await createViaHttp(games, "Known");
    const paths = [
      `/api/games/${known.gameId}`,
      "/api/games/adhoc-missing",
      "/api/games/not-a-game-id",
    ];
    const responses = await Promise.all(
      paths.map((path) => readGame(new Request(`http://localhost${path}`), games)),
    );
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404]);
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual([
      '{"error":"Ad Hoc Game unavailable."}',
      '{"error":"Ad Hoc Game unavailable."}',
      '{"error":"Ad Hoc Game unavailable."}',
    ]);
  });

  test("returns one generic WebSocket outcome for known, unknown, and malformed Games", async () => {
    const games = service();
    const known = await createViaHttp(games, "Known");
    const results = await Promise.all(
      [known.gameId, "adhoc-missing", "not-a-game-id"].map((gameId) =>
        resolveAdHocWebSocketSubscription({ service: games, cookieHeader: null, gameId }),
      ),
    );
    expect(results).toEqual([
      { status: "unavailable" },
      { status: "unavailable" },
      { status: "unavailable" },
    ]);
  });

  test("keeps malformed live Ad Hoc route shapes generic instead of serving the SPA", async () => {
    const paths = ["/game/adhoc-x/extra", "/api/games/adhoc-x/extra", "/api/games//leave"];
    const responses = paths.map((path) => {
      const response = adHocFallbackRoute(new Request(`http://localhost${path}`));
      if (!(response instanceof Response)) throw new Error("malformed Ad Hoc path served the SPA");
      return response;
    });

    expect(responses.map((response) => response.status)).toEqual([404, 404, 404]);
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual([
      '{"error":"Ad Hoc Game unavailable."}',
      '{"error":"Ad Hoc Game unavailable."}',
      '{"error":"Ad Hoc Game unavailable."}',
    ]);
  });

  test("accepts underscore-containing Game IDs through the authorized HTTP and WebSocket seams", async () => {
    let next = 0;
    const games = createAdHocGamesService({
      store: createInMemoryAdHocStore(),
      now: () => 1_000,
      random: () =>
        [
          "id_with_underscore",
          "session-token-abcdefghijklmnopqrstuvwxyz",
          "qr-token-abcdefghijklmnopqrstuvwxyz",
        ][next++]!,
    });
    const created = await createViaHttp(games, "Underscore");
    expect(created.gameId).toBe("adhoc-id_with_underscore");
    expect(parseCookieHeaderForGame(created.setCookie, created.gameId)).toBeTruthy();

    expect(
      (
        await readGame(
          new Request(`http://localhost/api/games/${created.gameId}`, {
            headers: { cookie: created.cookie },
          }),
          games,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await resolveAdHocWebSocketSubscription({
          service: games,
          cookieHeader: created.cookie,
          gameId: created.gameId,
        })
      ).status,
    ).toBe("accepted");
  });

  test("resolves each WebSocket subscription from the requested Game cookie", async () => {
    const games = service();
    const first = await createViaHttp(games, "First");
    const second = await createViaHttp(games, "Second");
    const cookieHeader = `${first.cookie}; ${second.cookie}`;
    const [firstResult, secondResult] = await Promise.all([
      resolveAdHocWebSocketSubscription({ service: games, cookieHeader, gameId: first.gameId }),
      resolveAdHocWebSocketSubscription({ service: games, cookieHeader, gameId: second.gameId }),
    ]);

    expect(firstResult.status).toBe("accepted");
    expect(secondResult.status).toBe("accepted");
    if (firstResult.status !== "accepted" || secondResult.status !== "accepted") return;
    expect(firstResult.game.gameId).toBe(first.gameId);
    expect(secondResult.game.gameId).toBe(second.gameId);
    expect(firstResult.sessionId).not.toBe(secondResult.sessionId);
  });

  test("authorizes and protects a WebSocket subscription in one durable mutation", async () => {
    const baseStore = createInMemoryAdHocStore();
    const creator = createAdHocGamesService({ store: baseStore, now: () => 1_000 });
    const created = await creator.create({ homeName: "Home", awayName: "Away" });
    if (created.status !== "accepted") throw new Error("creation failed");

    const failingStore = {
      ...baseStore,
      mutateGame: () => null,
    };
    const unavailable = await resolveAdHocWebSocketSubscription({
      service: createAdHocGamesService({ store: failingStore, now: () => 1_001 }),
      cookieHeader: `adhoc_session_${created.gameId}=${created.sessionId}`,
      gameId: created.gameId,
    });
    expect(unavailable).toEqual({ status: "unavailable" });
    expect(baseStore.readGame(created.gameId)?.sessions[0]?.connected).toBe(false);

    const accepted = await resolveAdHocWebSocketSubscription({
      service: creator,
      cookieHeader: `adhoc_session_${created.gameId}=${created.sessionId}`,
      gameId: created.gameId,
    });
    expect(accepted.status).toBe("accepted");
    expect(baseStore.readGame(created.gameId)?.sessions[0]?.connected).toBe(true);
  });

  test("fails creation unavailable without committing a Game when storage is contended", async () => {
    const store = {
      ...createInMemoryAdHocStore(),
      createGame() {
        throw new Error("database is locked");
      },
    };
    const games = createAdHocGamesService({ store, now: () => 1_000 });
    const result = await games.create({ homeName: "Home", awayName: "Away" });
    expect(result).toMatchObject({ status: "rejected", reason: "unavailable" });
    expect(store.listGames()).toHaveLength(0);
  });

  test("presents delayed anonymous creation with bounded generic retry guidance", async () => {
    const games = service();
    for (let index = 0; index < 5; index += 1) {
      const response = await createGame(
        new Request("http://localhost/api/games", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ homeName: `Home ${index}`, awayName: "Away" }),
        }),
        games,
        "stable-anonymous-source",
      );
      expect(response.status).toBe(201);
    }
    const delayed = await createGame(
      new Request("http://localhost/api/games", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ homeName: "Delayed", awayName: "Away" }),
      }),
      games,
      "stable-anonymous-source",
    );
    expect(delayed.status).toBe(429);
    expect(Number(delayed.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(delayed.headers.get("retry-after"))).toBeLessThanOrEqual(30);
    expect(await delayed.json()).toEqual({
      error: "Try again later.",
      retryAfterMs: 1_000,
    });
    expect(games.store.listGames()).toHaveLength(5);
  });

  test("uses a private browser source cookie instead of venue request material", async () => {
    const games = service();
    const first = await createGame(
      new Request("http://localhost/api/games", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "same-browser-material",
          "x-forwarded-for": "198.51.100.10",
        },
        body: JSON.stringify({ homeName: "First", awayName: "Away" }),
      }),
      games,
    );
    expect(first.status).toBe(201);
    const setCookie = first.headers.get("set-cookie") ?? "";
    const sourceCookie = setCookie.match(/adhoc_source=[^;, ]+/u)?.[0];
    expect(sourceCookie).toBeDefined();
    if (sourceCookie === undefined) return;
    for (let index = 1; index < 5; index += 1) {
      const response = await createGame(
        new Request("http://localhost/api/games", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: sourceCookie,
            "user-agent": "same-browser-material",
            "x-forwarded-for": "198.51.100.10",
          },
          body: JSON.stringify({ homeName: `Same source ${index}`, awayName: "Away" }),
        }),
        games,
      );
      expect(response.status).toBe(201);
    }
    const delayed = await createGame(
      new Request("http://localhost/api/games", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: sourceCookie,
          "user-agent": "same-browser-material",
          "x-forwarded-for": "198.51.100.10",
        },
        body: JSON.stringify({ homeName: "Delayed", awayName: "Away" }),
      }),
      games,
    );
    expect(delayed.status).toBe(429);
    const differentSource = await createGame(
      new Request("http://localhost/api/games", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "adhoc_source=different-private-browser-source-1234567890123456",
          "user-agent": "same-browser-material",
          "x-forwarded-for": "198.51.100.10",
        },
        body: JSON.stringify({ homeName: "Different source", awayName: "Away" }),
      }),
      games,
    );
    expect(differentSource.status).toBe(201);
  });

  test("returns a generic HTTP capacity outcome without exposing or removing a Game", async () => {
    let nowMs = 1_000;
    const store = createInMemoryAdHocStore();
    const games = createAdHocGamesService({ store, now: () => nowMs });
    const created: Array<{ gameId: string; sessionId: string }> = [];

    for (let index = 0; index < 50; index += 1) {
      nowMs += 60 * 60_000;
      const result = await games.create({
        homeName: `Home ${index}`,
        awayName: "Away",
        sourceKey: `capacity-source-${index}`,
      });
      if (result.status !== "accepted") throw new Error("capacity setup failed");
      created.push(result);
      expect(
        await games.setConnection({
          gameId: result.gameId,
          sessionId: result.sessionId,
          connected: true,
          nowMs,
        }),
      ).toBe(true);
    }

    const response = await createGame(
      new Request("http://localhost/api/games", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ homeName: "New", awayName: "Game" }),
      }),
      games,
    );

    expect(response.status).toBe(429);
    expect(await response.text()).toBe(
      '{"error":"Ad Hoc capacity is currently full; no game was changed."}',
    );
    expect(store.listGames()).toHaveLength(50);
    expect(store.readGame(created[0]!.gameId)).not.toBeNull();
  });
});

function parseCookieHeaderForGame(setCookie: string, gameId: string) {
  return readAdHocSession(setCookie.split(";")[0]!, gameId);
}
