import { describe, expect, test } from "bun:test";
import {
  createAdHocGamesService,
  createInMemoryAdHocStore,
  type AdHocGamesService,
} from "@/lib/ad-hoc-games";
import {
  adHocFallbackRoute,
  createGame,
  leaveGame,
  readAdHocSession,
  readAuthorizedAdHocGame,
  readGame,
  resolveAdHocWebSocketSubscription,
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

async function createViaHttp(games: AdHocGamesService, homeName: string) {
  const response = await createGame(
    new Request("http://localhost/api/games", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ homeName, awayName: "Away" }),
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
});

function parseCookieHeaderForGame(setCookie: string, gameId: string) {
  return readAdHocSession(setCookie.split(";")[0]!, gameId);
}
