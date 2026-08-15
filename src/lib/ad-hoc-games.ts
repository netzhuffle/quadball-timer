import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { applyGameCommand, createInitialGameState, projectGameView } from "@/lib/game-engine";
import type { GameCommand, GameState, GameView } from "@/lib/game-types";
import { parseGameCommand } from "@/lib/ws-protocol";
import { parseHexColor, DEFAULT_AWAY_TEAM_COLOR, DEFAULT_HOME_TEAM_COLOR } from "@/lib/team-colors";
import {
  normalizeBoundedText,
  SHARED_LIMITS,
  validateOpaqueIdentifier,
} from "@/lib/validation-policy";

export const AD_HOC_MAX_RETAINED_GAMES = 50;
export const AD_HOC_DISCONNECTED_GRACE_MS = 5 * 60_000;
export const AD_HOC_CREATION_SOURCE_WINDOW_MS = 10 * 60_000;
export const AD_HOC_CREATION_GLOBAL_WINDOW_MS = 60 * 60_000;
export const AD_HOC_MAX_CREATIONS_PER_SOURCE = 5;
export const AD_HOC_MAX_CREATIONS_PER_HOUR = 30;

const SCHEMA_VERSION = 1;
const GENERIC_UNAVAILABLE = "Ad Hoc Game unavailable.";

export type AdHocGameView = GameView & {
  gameId: string;
  sessionId: string;
  controlQr: string | null;
};

export type AdHocCreationInput = {
  homeName: unknown;
  awayName: unknown;
  homeColor?: unknown;
  awayColor?: unknown;
  sourceKey?: string;
  nowMs?: number;
};

export type AdHocCreateResult =
  | {
      status: "accepted";
      gameId: string;
      sessionId: string;
      controlQr: string;
      game: AdHocGameView;
    }
  | {
      status: "rejected";
      reason: "invalid-input" | "rate-limited" | "capacity" | "unavailable";
      detail?: string;
      retryAfterMs?: number;
    };

export type AdHocOperation = {
  id: string;
  clientSentAtMs: number;
  command: GameCommand;
};

export type AdHocActionResult =
  | { status: "accepted" | "duplicate"; game: AdHocGameView; ackedOperationIds: string[] }
  | {
      status: "rejected";
      reason: "unavailable" | "invalid-operation" | "conflict";
      detail?: string;
    };

export type AdHocAccessResult =
  | { status: "accepted"; game: AdHocGameView }
  | { status: "unavailable"; detail: string };

type StoredSession = {
  sessionHash: string;
  browserId: string;
  connected: boolean;
  lastConnectedAtMs: number;
  lastDisconnectedAtMs: number | null;
};

type StoredOperation = {
  fingerprint: string;
  command: GameCommand;
  acceptedAtMs: number;
};

export type StoredAdHocGame = {
  gameId: string;
  createdAtMs: number;
  state: GameState;
  controlQr: string;
  controlQrHash: string;
  sessions: StoredSession[];
  operations: Record<string, StoredOperation>;
};

type AdHocApplyMutationResult =
  | false
  | { invalid: true; rollback: true }
  | { conflict: true }
  | { acknowledged: string[]; duplicate: boolean };

export type AdHocStore = {
  close(): void;
  listGames(): StoredAdHocGame[];
  readGame(gameId: string): StoredAdHocGame | null;
  createGame(input: {
    game: StoredAdHocGame;
    sourceHash: string;
    nowMs: number;
  }): "accepted" | "rate-limited" | "capacity" | "unavailable";
  mutateGame<T>(gameId: string, mutation: (game: StoredAdHocGame) => T): T | null;
};

export type AdHocGamesServiceOptions = {
  store?: AdHocStore;
  now?: () => number;
  random?: () => string;
};

export type AdHocGamesService = ReturnType<typeof createAdHocGamesService>;

export function createAdHocGamesService(options: AdHocGamesServiceOptions = {}) {
  const store = options.store ?? createInMemoryAdHocStore();
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? (() => randomBytes(32).toString("base64url"));

  return {
    async create(input: AdHocCreationInput): Promise<AdHocCreateResult> {
      const home = normalizeTeamInput(input.homeName, "homeName");
      const away = normalizeTeamInput(input.awayName, "awayName");
      if (!home.ok) return { status: "rejected", reason: "invalid-input", detail: home.error };
      if (!away.ok) return { status: "rejected", reason: "invalid-input", detail: away.error };

      const homeColor = validateColor(input.homeColor, DEFAULT_HOME_TEAM_COLOR, "homeColor");
      const awayColor = validateColor(input.awayColor, DEFAULT_AWAY_TEAM_COLOR, "awayColor");
      if (!homeColor.ok)
        return { status: "rejected", reason: "invalid-input", detail: homeColor.error };
      if (!awayColor.ok)
        return { status: "rejected", reason: "invalid-input", detail: awayColor.error };

      const nowMs = input.nowMs ?? now();
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
        return {
          status: "rejected",
          reason: "invalid-input",
          detail: "nowMs must be a safe integer.",
        };
      }

      const sourceKey =
        typeof input.sourceKey === "string" ? input.sourceKey.trim() : "anonymous-browser";
      const sourceHash = digest(sourceKey || "anonymous-browser");
      const gameId = `adhoc-${random()}`;
      const sessionId = random();
      const controlQr = random();
      const state = createInitialGameState({
        id: gameId,
        nowMs,
        homeName: home.value,
        awayName: away.value,
        homeColor: homeColor.value,
        awayColor: awayColor.value,
      });
      const game: StoredAdHocGame = {
        gameId,
        createdAtMs: nowMs,
        state,
        controlQr,
        controlQrHash: digest(controlQr),
        sessions: [
          {
            sessionHash: digest(sessionId),
            browserId: sourceKey || "anonymous-browser",
            connected: false,
            lastConnectedAtMs: nowMs,
            lastDisconnectedAtMs: null,
          },
        ],
        operations: {},
      };

      let outcome: ReturnType<AdHocStore["createGame"]>;
      try {
        outcome = store.createGame({ game, sourceHash, nowMs });
      } catch {
        return { status: "rejected", reason: "unavailable" };
      }
      if (outcome === "rate-limited") {
        return {
          status: "rejected",
          reason: "rate-limited",
          retryAfterMs: 60 * 60_000,
        };
      }
      if (outcome === "capacity") {
        return { status: "rejected", reason: "capacity" };
      }
      if (outcome === "unavailable") return { status: "rejected", reason: "unavailable" };

      return {
        status: "accepted",
        gameId,
        sessionId,
        controlQr,
        game: projectAuthorizedGame(game, sessionId, controlQr, nowMs),
      };
    },

    async read(input: {
      gameId: unknown;
      sessionId: unknown;
      nowMs?: number;
    }): Promise<AdHocAccessResult> {
      const gameId = validateGameId(input.gameId);
      const sessionId = validateBearer(input.sessionId);
      if (gameId === null || sessionId === null) return unavailable();
      let game: StoredAdHocGame | null;
      try {
        game = store.readGame(gameId);
      } catch {
        return unavailable();
      }
      if (game === null || !hasSession(game, sessionId)) return unavailable();
      return {
        status: "accepted",
        game: projectAuthorizedGame(game, sessionId, null, input.nowMs ?? now()),
      };
    },

    async admit(input: {
      gameId: unknown;
      controlQr: unknown;
      browserId?: string;
      nowMs?: number;
    }): Promise<AdHocAccessResult> {
      const gameId = validateGameId(input.gameId);
      const qr = validateBearer(input.controlQr);
      if (gameId === null || qr === null) return unavailable();
      const nowMs = input.nowMs ?? now();
      if (!isSafeTimestamp(nowMs)) return unavailable();
      const sessionId = random();
      let outcome: boolean | null;
      try {
        outcome = store.mutateGame(gameId, (game) => {
          if (game.state.isFinished || digest(qr) !== game.controlQrHash) return false;
          game.sessions.push({
            sessionHash: digest(sessionId),
            browserId: input.browserId?.trim() || "anonymous-browser",
            connected: false,
            lastConnectedAtMs: nowMs,
            lastDisconnectedAtMs: null,
          });
          return true;
        });
      } catch {
        return unavailable();
      }
      if (outcome !== true) return unavailable();
      let game: StoredAdHocGame | null;
      try {
        game = store.readGame(gameId);
      } catch {
        return unavailable();
      }
      if (game === null) return unavailable();
      return { status: "accepted", game: projectAuthorizedGame(game, sessionId, qr, nowMs) };
    },

    async apply(input: {
      gameId: unknown;
      sessionId: unknown;
      operations: AdHocOperation[];
      nowMs?: number;
    }): Promise<AdHocActionResult> {
      const gameId = validateGameId(input.gameId);
      const sessionId = validateBearer(input.sessionId);
      if (
        gameId === null ||
        sessionId === null ||
        !Array.isArray(input.operations) ||
        input.operations.length === 0 ||
        input.operations.length > SHARED_LIMITS.replay.maxControlActions
      ) {
        return { status: "rejected", reason: "invalid-operation" };
      }
      const nowMs = input.nowMs ?? now();
      if (!isSafeTimestamp(nowMs)) return { status: "rejected", reason: "invalid-operation" };
      let outcome: AdHocApplyMutationResult | null;
      try {
        outcome = store.mutateGame<AdHocApplyMutationResult>(gameId, (game) => {
          if (!hasSession(game, sessionId)) return false;
          const next = structuredClone(game) as StoredAdHocGame;
          const acknowledged: string[] = [];
          let duplicate = false;
          for (const operation of input.operations) {
            if (typeof operation !== "object" || operation === null)
              return { invalid: true, rollback: true } as const;
            const operationId = validateOpaqueIdentifier(operation.id, "operationId");
            if (
              !operationId.ok ||
              !Number.isSafeInteger(operation.clientSentAtMs) ||
              operation.clientSentAtMs < 0
            )
              return { invalid: true, rollback: true } as const;
            const id = operationId.value;
            const parsedCommand =
              typeof operation.command === "object" && operation.command !== null
                ? parseGameCommand(operation.command as Record<string, unknown>)
                : { ok: false as const, error: "command must be an object." };
            if (!parsedCommand.ok) return { invalid: true, rollback: true } as const;
            const normalizedOperation = { ...operation, command: parsedCommand.command };
            const fingerprint = canonicalOperation(normalizedOperation);
            const existing = next.operations[id];
            if (existing !== undefined) {
              if (existing.fingerprint !== fingerprint) return { conflict: true } as const;
              acknowledged.push(id);
              duplicate = true;
              continue;
            }
            next.state = applyGameCommand({
              state: next.state,
              command: parsedCommand.command,
              nowMs: operation.clientSentAtMs,
            });
            next.operations[id] = {
              fingerprint,
              command: structuredClone(parsedCommand.command),
              acceptedAtMs: nowMs,
            };
            acknowledged.push(id);
          }
          next.state.updatedAtMs = nowMs;
          Object.assign(game, next);
          return { acknowledged, duplicate };
        });
      } catch {
        return { status: "rejected", reason: "unavailable" };
      }
      if (outcome === null || outcome === false)
        return { status: "rejected", reason: "unavailable" };
      if ("conflict" in outcome) return { status: "rejected", reason: "conflict" };
      if ("invalid" in outcome) return { status: "rejected", reason: "invalid-operation" };
      let game: StoredAdHocGame | null;
      try {
        game = store.readGame(gameId);
      } catch {
        return { status: "rejected", reason: "unavailable" };
      }
      if (game === null) return { status: "rejected", reason: "unavailable" };
      return {
        status: outcome.duplicate ? "duplicate" : "accepted",
        ackedOperationIds: outcome.acknowledged,
        game: projectAuthorizedGame(game, sessionId, null, nowMs),
      };
    },

    async setConnection(input: {
      gameId: unknown;
      sessionId: unknown;
      connected: boolean;
      nowMs?: number;
    }): Promise<boolean> {
      const gameId = validateGameId(input.gameId);
      const sessionId = validateBearer(input.sessionId);
      if (gameId === null || sessionId === null) return false;
      const nowMs = input.nowMs ?? now();
      if (!isSafeTimestamp(nowMs)) return false;
      try {
        return (
          store.mutateGame(gameId, (game) => {
            const session = game.sessions.find(
              (candidate) => candidate.sessionHash === digest(sessionId),
            );
            if (session === undefined) return false;
            session.connected = input.connected;
            if (input.connected) session.lastConnectedAtMs = nowMs;
            else session.lastDisconnectedAtMs = nowMs;
            return true;
          }) === true
        );
      } catch {
        return false;
      }
    },

    async leave(input: { gameId: unknown; sessionId: unknown; nowMs?: number }): Promise<boolean> {
      const gameId = validateGameId(input.gameId);
      const sessionId = validateBearer(input.sessionId);
      if (gameId === null || sessionId === null) return false;
      try {
        return (
          store.mutateGame(gameId, (game) => {
            const before = game.sessions.length;
            game.sessions = game.sessions.filter(
              (session) => session.sessionHash !== digest(sessionId),
            );
            return game.sessions.length !== before;
          }) === true
        );
      } catch {
        return false;
      }
    },

    genericUnavailableMessage: GENERIC_UNAVAILABLE,
    store,
    close() {
      store.close();
    },
  };
}

export function createInMemoryAdHocStore(): AdHocStore {
  const games = new Map<string, StoredAdHocGame>();
  const attempts = new Map<string, number[]>();
  const successes: number[] = [];
  return {
    close() {},
    listGames: () => [...games.values()].map(cloneStoredGame),
    readGame: (gameId) => {
      const game = games.get(gameId);
      return game === undefined ? null : cloneStoredGame(game);
    },
    createGame({ game, sourceHash, nowMs }) {
      const sourceAttempts = (attempts.get(sourceHash) ?? []).filter(
        (value) => value > nowMs - AD_HOC_CREATION_SOURCE_WINDOW_MS,
      );
      if (sourceAttempts.length >= AD_HOC_MAX_CREATIONS_PER_SOURCE) return "rate-limited";
      const recentSuccesses = successes.filter(
        (value) => value > nowMs - AD_HOC_CREATION_GLOBAL_WINDOW_MS,
      );
      if (recentSuccesses.length >= AD_HOC_MAX_CREATIONS_PER_HOUR) return "rate-limited";
      if (games.size >= AD_HOC_MAX_RETAINED_GAMES) {
        const victim = [...games.values()]
          .filter((candidate) =>
            candidate.sessions.every(
              (session) =>
                !session.connected &&
                session.lastDisconnectedAtMs !== null &&
                session.lastDisconnectedAtMs <= nowMs - AD_HOC_DISCONNECTED_GRACE_MS,
            ),
          )
          .sort((a, b) => a.createdAtMs - b.createdAtMs)[0];
        if (victim === undefined) return "capacity";
        games.delete(victim.gameId);
      }
      games.set(game.gameId, cloneStoredGame(game));
      attempts.set(sourceHash, [...sourceAttempts, nowMs]);
      successes.push(nowMs);
      return "accepted";
    },
    mutateGame(gameId, mutation) {
      const game = games.get(gameId);
      if (game === undefined) return null;
      const working = cloneStoredGame(game);
      const result = mutation(working);
      if (
        result !== null &&
        result !== false &&
        !(
          typeof result === "object" &&
          (("conflict" in result && result.conflict === true) ||
            ("rollback" in result && result.rollback === true))
        )
      ) {
        games.set(gameId, working);
      }
      return result;
    },
  };
}

export function openSqliteAdHocStore(databasePath: string): AdHocStore {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 0");
  db.run(
    "CREATE TABLE IF NOT EXISTS adhoc_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
  );
  db.run("INSERT OR IGNORE INTO adhoc_schema (id, version) VALUES (1, ?)", [SCHEMA_VERSION]);
  db.run(`CREATE TABLE IF NOT EXISTS adhoc_games (
    game_id TEXT PRIMARY KEY,
    created_at_ms INTEGER NOT NULL,
    state_json TEXT NOT NULL,
    control_qr TEXT NOT NULL,
    control_qr_hash TEXT NOT NULL,
    sessions_json TEXT NOT NULL,
    operations_json TEXT NOT NULL
  )`);
  db.run(
    "CREATE TABLE IF NOT EXISTS adhoc_creation_events (source_hash TEXT NOT NULL, successful INTEGER NOT NULL, occurred_at_ms INTEGER NOT NULL)",
  );

  const read = (gameId: string): StoredAdHocGame | null => {
    const row = db.query("SELECT * FROM adhoc_games WHERE game_id = ?").get(gameId) as Record<
      string,
      string | number
    > | null;
    return row === null ? null : parseStoredRow(row);
  };
  const transaction = db.transaction((work: () => unknown) => work());
  return {
    close() {
      db.close();
    },
    listGames() {
      return (
        db.query("SELECT * FROM adhoc_games ORDER BY created_at_ms ASC").all() as Record<
          string,
          string | number
        >[]
      ).map(parseStoredRow);
    },
    readGame: read,
    createGame({ game, sourceHash, nowMs }) {
      return transaction(() => {
        db.run("DELETE FROM adhoc_creation_events WHERE occurred_at_ms <= ?", [
          nowMs - AD_HOC_CREATION_GLOBAL_WINDOW_MS,
        ]);
        const sourceCountRow = db
          .query(
            "SELECT COUNT(*) AS count FROM adhoc_creation_events WHERE source_hash = ? AND occurred_at_ms > ?",
          )
          .get(sourceHash, nowMs - AD_HOC_CREATION_SOURCE_WINDOW_MS) as {
          count?: number | string;
        } | null;
        const sourceCount = Number(sourceCountRow?.count ?? 0);
        if (sourceCount >= AD_HOC_MAX_CREATIONS_PER_SOURCE) return "rate-limited" as const;
        const globalCountRow = db
          .query("SELECT COUNT(*) AS count FROM adhoc_creation_events WHERE successful = 1")
          .get() as { count?: number | string } | null;
        const globalCount = Number(globalCountRow?.count ?? 0);
        if (globalCount >= AD_HOC_MAX_CREATIONS_PER_HOUR) return "rate-limited" as const;
        const countRow = db.query("SELECT COUNT(*) AS count FROM adhoc_games").get() as {
          count?: number | string;
        } | null;
        const count = Number(countRow?.count ?? 0);
        if (count >= AD_HOC_MAX_RETAINED_GAMES) {
          const victim = db
            .query(`SELECT game_id FROM adhoc_games WHERE NOT EXISTS (
            SELECT 1 FROM json_each(sessions_json) AS session
            WHERE json_extract(session.value, '$.connected') = 1
               OR json_extract(session.value, '$.lastDisconnectedAtMs') IS NULL
               OR json_extract(session.value, '$.lastDisconnectedAtMs') > ?
          ) ORDER BY created_at_ms ASC LIMIT 1`)
            .get(nowMs - AD_HOC_DISCONNECTED_GRACE_MS) as { game_id?: string } | null;
          if (victim?.game_id === undefined) return "capacity" as const;
          db.run("DELETE FROM adhoc_games WHERE game_id = ?", [victim.game_id]);
        }
        db.run(
          "INSERT INTO adhoc_games (game_id, created_at_ms, state_json, control_qr, control_qr_hash, sessions_json, operations_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [
            game.gameId,
            game.createdAtMs,
            JSON.stringify(game.state),
            game.controlQr,
            game.controlQrHash,
            JSON.stringify(game.sessions),
            JSON.stringify(game.operations),
          ],
        );
        db.run(
          "INSERT INTO adhoc_creation_events (source_hash, successful, occurred_at_ms) VALUES (?, 1, ?)",
          [sourceHash, nowMs],
        );
        return "accepted" as const;
      }) as "accepted" | "rate-limited" | "capacity" | "unavailable";
    },
    mutateGame<T>(gameId: string, mutation: (game: StoredAdHocGame) => T): T | null {
      return transaction(() => {
        const game = read(gameId);
        if (game === null) return null;
        const result = mutation(game);
        if (
          result !== null &&
          result !== false &&
          !(
            typeof result === "object" &&
            (("conflict" in result && result.conflict === true) ||
              ("rollback" in result && result.rollback === true))
          )
        ) {
          db.run(
            "UPDATE adhoc_games SET state_json = ?, sessions_json = ?, operations_json = ? WHERE game_id = ?",
            [
              JSON.stringify(game.state),
              JSON.stringify(game.sessions),
              JSON.stringify(game.operations),
              gameId,
            ],
          );
        }
        return result;
      }) as T | null;
    },
  };
}

function parseStoredRow(row: Record<string, string | number>): StoredAdHocGame {
  return {
    gameId: String(row.game_id),
    createdAtMs: Number(row.created_at_ms),
    state: JSON.parse(String(row.state_json)) as GameState,
    controlQr: String(row.control_qr),
    controlQrHash: String(row.control_qr_hash),
    sessions: JSON.parse(String(row.sessions_json)) as StoredSession[],
    operations: JSON.parse(String(row.operations_json)) as Record<string, StoredOperation>,
  };
}

function projectAuthorizedGame(
  game: StoredAdHocGame,
  sessionId: string,
  controlQr: string | null,
  nowMs: number,
): AdHocGameView {
  const view = projectGameView(game.state, nowMs);
  return {
    ...view,
    gameId: game.gameId,
    sessionId,
    controlQr: view.state.isFinished ? null : (controlQr ?? game.controlQr),
  };
}

function hasSession(game: StoredAdHocGame, sessionId: string): boolean {
  return game.sessions.some((session) => session.sessionHash === digest(sessionId));
}

function validateGameId(value: unknown): string | null {
  const result = validateOpaqueIdentifier(value, "gameId");
  return result.ok && result.value.startsWith("adhoc-") ? result.value : null;
}

function validateBearer(value: unknown): string | null {
  return typeof value === "string" && value.length >= 32 && value.length <= 256 ? value : null;
}

function isSafeTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeTeamInput(value: unknown, field: string) {
  return normalizeBoundedText(value, SHARED_LIMITS.names.teamAndPitchMaxCodePoints, field);
}

function validateColor(value: unknown, fallback: string, field: string) {
  if (value === undefined) return { ok: true as const, value: fallback };
  if (typeof value !== "string" || parseHexColor(value) === null)
    return { ok: false as const, error: `${field} must be a hexadecimal color.` };
  return { ok: true as const, value: `#${value.replace(/^#/, "").toLowerCase()}` };
}

function canonicalOperation(operation: AdHocOperation): string {
  return JSON.stringify([operation.clientSentAtMs, operation.command]);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cloneStoredGame(game: StoredAdHocGame): StoredAdHocGame {
  return structuredClone(game) as StoredAdHocGame;
}

function unavailable(): AdHocAccessResult {
  return { status: "unavailable", detail: GENERIC_UNAVAILABLE };
}
