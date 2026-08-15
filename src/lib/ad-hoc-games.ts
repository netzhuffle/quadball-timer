import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createInitialGameState } from "@/lib/game-engine";
import type { GameCommand, GameState, GameView } from "@/lib/game-types";
import { parseGameCommand } from "@/lib/ws-protocol";
import { DEFAULT_IQA_SPORTING_RULES, type IqaSportingRules } from "@/lib/iqa-game-rules";
import {
  orderControllerOperations,
  createControllerReplayAcknowledgement,
  resolveControllerBatch,
  validateControllerReplay,
  type ControllerOperationOutcome,
  type ControllerSynchronizationOperation,
} from "@/lib/controller-synchronization";
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
export const AD_HOC_MAX_OPERATIONS_PER_SECOND_PER_CONTROLLER = 40;
export const AD_HOC_MAX_OPERATIONS_PER_SECOND_PER_GAME = 100;

const SCHEMA_VERSION = 3;
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
  browserId?: unknown;
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
  workflow?: "ad-hoc";
  causalPredecessorIds?: readonly string[];
};

export type AdHocActionResult =
  | {
      status: "accepted" | "duplicate";
      game: AdHocGameView;
      ackedOperationIds: string[];
      outcomes: readonly ControllerOperationOutcome[];
    }
  | {
      status: "rejected";
      reason: "unavailable" | "invalid-operation" | "conflict" | "rate-limited";
      detail?: string;
      outcomes?: readonly ControllerOperationOutcome[];
    };

export type AdHocAccessResult =
  | { status: "accepted"; game: AdHocGameView }
  | { status: "unavailable"; detail: string };

type StoredSession = {
  sessionHash: string;
  browserId: string | null;
  connected: boolean;
  lastConnectedAtMs: number;
  lastDisconnectedAtMs: number | null;
};

type StoredOperation = {
  fingerprint: string;
  command: GameCommand;
  acceptedAtMs: number;
  clientSentAtMs: number;
  causalPredecessorIds: readonly string[];
  status: "accepted" | "rejected" | "causally-blocked";
  detail?: string;
};

export type StoredAdHocGame = {
  gameId: string;
  environmentIdentity: string;
  createdAtMs: number;
  state: GameState;
  initialState?: GameState;
  replayBaselineOperationIds?: readonly string[];
  controlQr: string;
  controlQrHash: string;
  sessions: StoredSession[];
  operations: Record<string, StoredOperation>;
};

type AdHocApplyMutationResult =
  | false
  | { invalid: true; rollback: true }
  | { conflict: true; operationId: string }
  | { rateLimited: true }
  | {
      acknowledged: string[];
      duplicate: boolean;
      outcomes: readonly ControllerOperationOutcome[];
    };

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
  environmentIdentity?: string;
  iqaRules?: AdHocIqaGameRules;
};

/** Shared sporting interpretation consumed by both Controller workflows. */
export type AdHocIqaGameRules = IqaSportingRules;

export const DEFAULT_AD_HOC_IQA_RULES: AdHocIqaGameRules = DEFAULT_IQA_SPORTING_RULES;

export type AdHocGamesService = ReturnType<typeof createAdHocGamesService>;

export function createAdHocGamesService(options: AdHocGamesServiceOptions = {}) {
  const store = options.store ?? createInMemoryAdHocStore();
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? (() => randomBytes(32).toString("base64url"));
  const environmentIdentity = options.environmentIdentity?.trim() || "test";
  const iqaRules = options.iqaRules ?? DEFAULT_AD_HOC_IQA_RULES;
  const controllerActionTimes = new Map<string, number[]>();
  const gameActionTimes = new Map<string, number[]>();

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
      const browserId = validateBrowserId(input.browserId);
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
        environmentIdentity,
        createdAtMs: nowMs,
        state,
        initialState: structuredClone(state),
        replayBaselineOperationIds: [],
        controlQr,
        controlQrHash: digest(controlQr),
        sessions: [
          {
            sessionHash: digest(sessionId),
            browserId,
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
        game: projectAuthorizedGame(game, sessionId, controlQr, nowMs, iqaRules),
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
      if (
        game === null ||
        game.environmentIdentity !== environmentIdentity ||
        !hasSession(game, sessionId)
      )
        return unavailable();
      return {
        status: "accepted",
        game: projectAuthorizedGame(game, sessionId, null, input.nowMs ?? now(), iqaRules),
      };
    },

    async admit(input: {
      gameId: unknown;
      controlQr: unknown;
      browserId?: unknown;
      priorSessionId?: unknown;
      nowMs?: number;
    }): Promise<AdHocAccessResult> {
      const gameId = validateGameId(input.gameId);
      const qr = validateBearer(input.controlQr);
      if (gameId === null || qr === null) return unavailable();
      const nowMs = input.nowMs ?? now();
      if (!isSafeTimestamp(nowMs)) return unavailable();
      const browserId = validateBrowserId(input.browserId);
      const priorSessionId = validateBearer(input.priorSessionId);
      const sessionId = random();
      let outcome: boolean | null;
      try {
        outcome = store.mutateGame(gameId, (game) => {
          if (
            game.environmentIdentity !== environmentIdentity ||
            game.state.isFinished ||
            digest(qr) !== game.controlQrHash
          )
            return false;
          game.sessions = game.sessions.filter(
            (session) =>
              (priorSessionId === null || session.sessionHash !== digest(priorSessionId)) &&
              (browserId === null || session.browserId !== browserId),
          );
          game.sessions.push({
            sessionHash: digest(sessionId),
            browserId,
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
      return {
        status: "accepted",
        game: projectAuthorizedGame(game, sessionId, qr, nowMs, iqaRules),
      };
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
          if (game.environmentIdentity !== environmentIdentity || !hasSession(game, sessionId))
            return false;
          const next = structuredClone(game) as StoredAdHocGame;
          const acknowledged: string[] = [];
          let duplicate = false;
          const parsed = parseAdHocOperations(input.operations);
          if (!parsed.ok) return { invalid: true, rollback: true } as const;
          const incoming = parsed.operations;
          const newOperationCount = incoming.filter(
            (operation) => next.operations[operation.operationId] === undefined,
          ).length;
          const sessionKey = digest(sessionId);
          const sessionTimes = (controllerActionTimes.get(sessionKey) ?? []).filter(
            (timestamp) => timestamp > nowMs - 1_000,
          );
          const gameTimes = (gameActionTimes.get(gameId) ?? []).filter(
            (timestamp) => timestamp > nowMs - 1_000,
          );
          if (
            sessionTimes.length + newOperationCount >
              AD_HOC_MAX_OPERATIONS_PER_SECOND_PER_CONTROLLER ||
            gameTimes.length + newOperationCount > AD_HOC_MAX_OPERATIONS_PER_SECOND_PER_GAME
          ) {
            return { rateLimited: true } as const;
          }
          const outcomes: ControllerOperationOutcome[] = [];
          for (const operation of incoming) {
            const existing = next.operations[operation.operationId];
            if (existing !== undefined) {
              if (existing.fingerprint !== operationFingerprint(operation)) {
                return { conflict: true, operationId: operation.operationId } as const;
              }
              acknowledged.push(operation.operationId);
              duplicate = true;
              outcomes.push({
                operationId: operation.operationId,
                workflow: "ad-hoc",
                status: existing.status === "accepted" ? "duplicate" : existing.status,
                ...(existing.detail === undefined ? {} : { detail: existing.detail }),
              });
              continue;
            }
          }
          const retainedStatuses = new Map(
            Object.entries(next.operations).map(
              ([operationId, operation]) => [operationId, operation.status] as const,
            ),
          );
          const resolution = resolveControllerBatch({
            operations: incoming.filter(
              (operation) => next.operations[operation.operationId] === undefined,
            ),
            retainedStatuses,
          });
          for (const operation of resolution.ordered) {
            const status = resolution.statuses.get(operation.operationId) ?? "rejected";
            const detail = resolution.details.get(operation.operationId);
            next.operations[operation.operationId] =
              status === "accepted"
                ? {
                    fingerprint: operationFingerprint(operation),
                    command: structuredClone(operation.payload),
                    acceptedAtMs: nowMs,
                    clientSentAtMs: operation.clientOriginAtMs,
                    causalPredecessorIds: [...operation.causalPredecessorIds],
                    status: "accepted",
                  }
                : rejectedOperation(operation, nowMs, detail ?? "Causal cycle.", status);
            outcomes.push({
              operationId: operation.operationId,
              workflow: "ad-hoc",
              status,
              ...(detail === undefined ? {} : { detail }),
            });
            acknowledged.push(operation.operationId);
          }
          for (const operation of incoming) {
            if (
              next.operations[operation.operationId] !== undefined &&
              acknowledged.includes(operation.operationId)
            )
              continue;
            if (next.operations[operation.operationId] === undefined) {
              const status = resolution.statuses.get(operation.operationId) ?? "rejected";
              const detail = resolution.details.get(operation.operationId) ?? "Causal cycle.";
              next.operations[operation.operationId] = rejectedOperation(
                operation,
                nowMs,
                detail,
                status === "accepted" ? "rejected" : status,
              );
              outcomes.push({
                operationId: operation.operationId,
                workflow: "ad-hoc",
                status,
                detail,
              });
              acknowledged.push(operation.operationId);
            }
          }
          const rebuilt = rebuildAdHocState(next, iqaRules);
          if (rebuilt === null) return { invalid: true, rollback: true } as const;
          next.state = rebuilt;
          next.state.updatedAtMs = nowMs;
          if (newOperationCount > 0) {
            const acceptedTimes = Array.from({ length: newOperationCount }, () => nowMs);
            controllerActionTimes.set(sessionKey, [...sessionTimes, ...acceptedTimes]);
            gameActionTimes.set(gameId, [...gameTimes, ...acceptedTimes]);
          }
          Object.assign(game, next);
          const acknowledgement = createControllerReplayAcknowledgement({
            workflow: "ad-hoc",
            acknowledgedOperationIds: acknowledged,
            outcomes,
          });
          return {
            acknowledged: [...acknowledgement.acknowledgedOperationIds],
            duplicate,
            outcomes: acknowledgement.outcomes,
          };
        });
      } catch {
        return { status: "rejected", reason: "unavailable" };
      }
      if (outcome === null || outcome === false)
        return { status: "rejected", reason: "unavailable" };
      if ("rateLimited" in outcome) return { status: "rejected", reason: "rate-limited" };
      if ("conflict" in outcome) {
        return {
          status: "rejected",
          reason: "conflict",
          outcomes: [
            {
              operationId: outcome.operationId,
              workflow: "ad-hoc",
              status: "rejected",
              detail: "The operation identity is already bound to different content.",
            },
          ],
        };
      }
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
        outcomes: outcome.outcomes,
        game: projectAuthorizedGame(game, sessionId, null, nowMs, iqaRules),
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
            if (game.environmentIdentity !== environmentIdentity) return false;
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
            if (game.environmentIdentity !== environmentIdentity) return false;
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

export function openSqliteAdHocStore(
  databasePath: string,
  environmentIdentity = "test",
): AdHocStore {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 0");
  db.run(
    "CREATE TABLE IF NOT EXISTS adhoc_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
  );
  const schemaRow = db.query("SELECT version FROM adhoc_schema WHERE id = 1").get() as {
    version?: number | string;
  } | null;
  const previousSchemaVersion = Number(schemaRow?.version ?? SCHEMA_VERSION);
  db.run("INSERT OR IGNORE INTO adhoc_schema (id, version) VALUES (1, ?)", [SCHEMA_VERSION]);
  db.run(`CREATE TABLE IF NOT EXISTS adhoc_games (
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
  )`);
  const columns = db.query("PRAGMA table_info(adhoc_games)").all() as { name?: string }[];
  if (!columns.some((column) => column.name === "environment_identity")) {
    db.run("ALTER TABLE adhoc_games ADD COLUMN environment_identity TEXT NOT NULL DEFAULT ''");
  }
  const legacyStateColumnWasMissing = !columns.some(
    (column) => column.name === "initial_state_json",
  );
  if (legacyStateColumnWasMissing) {
    db.run("ALTER TABLE adhoc_games ADD COLUMN initial_state_json TEXT NOT NULL DEFAULT '{}'");
    db.run(
      "UPDATE adhoc_games SET initial_state_json = state_json WHERE initial_state_json = '{}' ",
    );
  }
  if (!columns.some((column) => column.name === "replay_baseline_operation_ids_json")) {
    db.run(
      "ALTER TABLE adhoc_games ADD COLUMN replay_baseline_operation_ids_json TEXT NOT NULL DEFAULT '[]'",
    );
    if (legacyStateColumnWasMissing) {
      db.run(
        "UPDATE adhoc_games SET replay_baseline_operation_ids_json = (SELECT json_group_array(key) FROM json_each(adhoc_games.operations_json))",
      );
    }
  }
  if (previousSchemaVersion < SCHEMA_VERSION) {
    const migrate = db.transaction(() => {
      db.run("UPDATE adhoc_games SET environment_identity = ? WHERE environment_identity = ''", [
        environmentIdentity.trim() || "test",
      ]);
      db.run("UPDATE adhoc_schema SET version = ? WHERE id = 1", [SCHEMA_VERSION]);
    });
    migrate();
  }
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
          "INSERT INTO adhoc_games (game_id, environment_identity, created_at_ms, state_json, initial_state_json, replay_baseline_operation_ids_json, control_qr, control_qr_hash, sessions_json, operations_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            game.gameId,
            game.environmentIdentity,
            game.createdAtMs,
            JSON.stringify(game.state),
            JSON.stringify(game.initialState ?? game.state),
            JSON.stringify(game.replayBaselineOperationIds ?? []),
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
            "UPDATE adhoc_games SET state_json = ?, sessions_json = ?, operations_json = ?, replay_baseline_operation_ids_json = ? WHERE game_id = ?",
            [
              JSON.stringify(game.state),
              JSON.stringify(game.sessions),
              JSON.stringify(game.operations),
              JSON.stringify(game.replayBaselineOperationIds ?? []),
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
  const operations = JSON.parse(String(row.operations_json)) as Record<string, StoredOperation>;
  for (const operation of Object.values(operations)) {
    operation.clientSentAtMs ??= operation.acceptedAtMs;
    operation.causalPredecessorIds ??= [];
    operation.status ??= "accepted";
  }
  const parsed = {
    gameId: String(row.game_id),
    environmentIdentity: String(row.environment_identity ?? ""),
    createdAtMs: Number(row.created_at_ms),
    state: JSON.parse(String(row.state_json)) as GameState,
    initialState: JSON.parse(String(row.initial_state_json ?? row.state_json)) as GameState,
    replayBaselineOperationIds: JSON.parse(
      String(row.replay_baseline_operation_ids_json ?? "[]"),
    ) as string[],
    controlQr: String(row.control_qr),
    controlQrHash: String(row.control_qr_hash),
    sessions: JSON.parse(String(row.sessions_json)) as StoredSession[],
    operations,
  };
  return validateStoredGame(parsed);
}

function projectAuthorizedGame(
  game: StoredAdHocGame,
  sessionId: string,
  controlQr: string | null,
  nowMs: number,
  rules: AdHocIqaGameRules = DEFAULT_AD_HOC_IQA_RULES,
): AdHocGameView {
  const view = rules.project(game.state, nowMs);
  return {
    ...view,
    gameId: game.gameId,
    sessionId,
    controlQr: view.state.isFinished ? null : (controlQr ?? game.controlQr),
  };
}

function validateStoredGame(game: StoredAdHocGame): StoredAdHocGame {
  if (!isRecord(game)) throw new Error("Stored Ad Hoc Game must be an object.");
  requireOpaque(game.gameId, "gameId");
  if (!game.gameId.startsWith("adhoc-")) throw new Error("Stored Ad Hoc Game identity is invalid.");
  if (typeof game.environmentIdentity !== "string" || game.environmentIdentity.length === 0)
    throw new Error("Stored Ad Hoc environment identity is invalid.");
  requireSafeNonNegative(game.createdAtMs, "createdAtMs");
  validateGameState(game.state, game.gameId);
  if (game.initialState !== undefined) validateGameState(game.initialState, game.gameId);
  if (!Array.isArray(game.replayBaselineOperationIds))
    throw new Error("Stored replay baseline is invalid.");
  const baselineIds = new Set<string>();
  for (const id of game.replayBaselineOperationIds) {
    requireOpaque(id, "replay baseline operationId");
    if (baselineIds.has(id)) throw new Error("Stored replay baseline contains duplicates.");
    baselineIds.add(id);
  }
  if (typeof game.controlQr !== "string" || game.controlQr.length === 0)
    throw new Error("Stored control QR is invalid.");
  if (!/^[a-f0-9]{64}$/u.test(game.controlQrHash))
    throw new Error("Stored control QR hash is invalid.");
  if (!Array.isArray(game.sessions)) throw new Error("Stored sessions are invalid.");
  for (const session of game.sessions) validateStoredSession(session);
  if (!isRecord(game.operations)) throw new Error("Stored operations are invalid.");
  const operationIds = new Set(Object.keys(game.operations));
  for (const [operationId, operation] of Object.entries(game.operations)) {
    requireOpaque(operationId, "operationId");
    validateStoredOperation(operationId, operation);
  }
  for (const operation of Object.values(game.operations)) {
    const predecessors = operation.causalPredecessorIds.map(
      (predecessor) => game.operations[predecessor],
    );
    if (
      operation.status === "accepted" &&
      predecessors.some((predecessor) => predecessor?.status !== "accepted")
    ) {
      throw new Error("Stored accepted operation has a non-accepted predecessor.");
    }
    if (
      operation.status === "causally-blocked" &&
      (predecessors.length === 0 ||
        predecessors.some((predecessor) => predecessor === undefined) ||
        predecessors.every((predecessor) => predecessor?.status === "accepted"))
    ) {
      throw new Error("Stored causally blocked operation has no rejected predecessor.");
    }
    if (
      operation.status === "rejected" &&
      predecessors.some((predecessor) => predecessor === undefined) &&
      operation.detail !== "Causal predecessor is not retained."
    ) {
      throw new Error("Stored rejected operation has inconsistent causal evidence.");
    }
  }
  for (const baselineId of baselineIds) {
    if (!operationIds.has(baselineId) || game.operations[baselineId]?.status !== "accepted")
      throw new Error("Stored replay baseline does not match accepted history.");
  }
  const graph = new Map(
    Object.entries(game.operations).map(([operationId, operation]) => [
      operationId,
      operation.causalPredecessorIds.filter((predecessor) => operationIds.has(predecessor)),
    ]),
  );
  for (const operationId of operationIds) {
    if (hasStoredCausalCycle(operationId, graph, new Set(), new Set()))
      throw new Error("Stored operation causal graph contains a cycle.");
  }
  return game;
}

function validateGameState(value: unknown, expectedId: string): asserts value is GameState {
  if (!isRecord(value) || value.id !== expectedId)
    throw new Error("Stored GameState identity is invalid.");
  requireSafeNonNegative(value.createdAtMs, "state.createdAtMs");
  requireSafeNonNegative(value.updatedAtMs, "state.updatedAtMs");
  requireText(value.homeName, SHARED_LIMITS.names.teamAndPitchMaxCodePoints, "state.homeName");
  requireText(value.awayName, SHARED_LIMITS.names.teamAndPitchMaxCodePoints, "state.awayName");
  if (typeof value.homeColor !== "string" || parseHexColor(value.homeColor) === null)
    throw new Error("Stored home color is invalid.");
  if (typeof value.awayColor !== "string" || parseHexColor(value.awayColor) === null)
    throw new Error("Stored away color is invalid.");
  for (const field of [
    "displaySidesSwapped",
    "isRunning",
    "isFinished",
    "isSuspended",
    "isOvertime",
  ])
    if (typeof value[field] !== "boolean") throw new Error(`Stored ${field} is invalid.`);
  if (value.suspendedAtMs !== null)
    requireSafeNonNegative(value.suspendedAtMs, "state.suspendedAtMs");
  if (value.winner !== null && value.winner !== "home" && value.winner !== "away")
    throw new Error("Stored winner is invalid.");
  if (
    value.finishReason !== null &&
    !["forfeit", "double-forfeit", "flag-catch", "target-score", "concede"].includes(
      value.finishReason,
    )
  )
    throw new Error("Stored finish reason is invalid.");
  requireInteger(
    value.gameClockMs,
    SHARED_LIMITS.clock.minMs,
    SHARED_LIMITS.clock.maxMs,
    "state.gameClockMs",
  );
  if (!isRecord(value.score)) throw new Error("Stored score is invalid.");
  requireInteger(
    value.score.home,
    SHARED_LIMITS.score.min,
    SHARED_LIMITS.score.max,
    "state.score.home",
  );
  requireInteger(
    value.score.away,
    SHARED_LIMITS.score.min,
    SHARED_LIMITS.score.max,
    "state.score.away",
  );
  if (
    !Array.isArray(value.scoreEvents) ||
    !Array.isArray(value.cardEvents) ||
    !Array.isArray(value.pendingExpirations) ||
    !Array.isArray(value.recentReleases)
  )
    throw new Error("Stored GameState collections are invalid.");
  for (const event of value.scoreEvents) {
    if (!isRecord(event)) throw new Error("Stored score event is invalid.");
    requireOpaque(event.id, "score event id");
    requireTeam(event.team);
    requireInteger(
      event.points,
      -SHARED_LIMITS.score.max,
      SHARED_LIMITS.score.max,
      "score event points",
    );
    requireSafeNonNegative(event.createdAtMs, "score event createdAtMs");
    if (event.reason !== "goal" && event.reason !== "flag-catch")
      throw new Error("Stored score event reason is invalid.");
    if (event.pendingExpirationId !== null)
      requireOpaque(event.pendingExpirationId, "pendingExpirationId");
    if (event.undoneAtMs !== null)
      requireSafeNonNegative(event.undoneAtMs, "score event undoneAtMs");
  }
  for (const event of value.cardEvents) {
    if (!isRecord(event)) throw new Error("Stored card event is invalid.");
    requireOpaque(event.id, "card event id");
    requireTeam(event.team);
    if (event.playerKey !== null) requireOpaque(event.playerKey, "card event playerKey");
    if (event.playerNumber !== null)
      requireInteger(event.playerNumber, 0, 99, "card event playerNumber");
    if (!["blue", "yellow", "red", "ejection"].includes(event.cardType))
      throw new Error("Stored card type is invalid.");
    requireSafeNonNegative(event.createdAtMs, "card event createdAtMs");
  }
  if (!isRecord(value.players)) throw new Error("Stored players are invalid.");
  for (const [key, player] of Object.entries(value.players)) {
    requireOpaque(key, "player key");
    if (!isRecord(player) || player.key !== key || !["home", "away"].includes(player.team))
      throw new Error("Stored player is invalid.");
    if (player.playerNumber !== null) requireInteger(player.playerNumber, 0, 99, "player number");
    if (!Array.isArray(player.segments)) throw new Error("Stored penalty segments are invalid.");
    for (const segment of player.segments) {
      if (!isRecord(segment)) throw new Error("Stored penalty segment is invalid.");
      requireOpaque(segment.id, "penalty segment id");
      if (!["blue", "yellow", "red"].includes(segment.cardType))
        throw new Error("Stored penalty card type is invalid.");
      requireInteger(segment.remainingMs, 0, SHARED_LIMITS.clock.maxMs, "penalty remainingMs");
      if (typeof segment.expirableByScore !== "boolean")
        throw new Error("Stored penalty expiration flag is invalid.");
    }
  }
  for (const pending of value.pendingExpirations) {
    if (
      !isRecord(pending) ||
      !["home", "away"].includes(pending.penalizedTeam) ||
      !["home", "away"].includes(pending.benefitingTeam)
    )
      throw new Error("Stored pending expiration is invalid.");
    requireOpaque(pending.id, "pending expiration id");
    if (pending.reason !== "score" && pending.reason !== "flag-catch")
      throw new Error("Stored pending expiration reason is invalid.");
    requireSafeNonNegative(pending.createdAtMs, "pending expiration createdAtMs");
    if (
      !Array.isArray(pending.candidatePlayerKeys) ||
      pending.candidatePlayerKeys.some(
        (key) => !validateOpaqueIdentifier(key, "candidatePlayerKey").ok,
      )
    )
      throw new Error("Stored candidate player keys are invalid.");
    requireInteger(pending.expireMs, 0, SHARED_LIMITS.clock.maxMs, "pending expiration expireMs");
    if (pending.resolvedAtMs !== null)
      requireSafeNonNegative(pending.resolvedAtMs, "pending resolvedAtMs");
    if (pending.resolvedPlayerKey !== null)
      requireOpaque(pending.resolvedPlayerKey, "resolvedPlayerKey");
  }
  for (const release of value.recentReleases) {
    if (!isRecord(release)) throw new Error("Stored release is invalid.");
    requireOpaque(release.id, "release id");
    requireTeam(release.team);
    requireOpaque(release.playerKey, "release playerKey");
    if (release.playerNumber !== null)
      requireInteger(release.playerNumber, 0, 99, "release playerNumber");
    requireSafeNonNegative(release.releasedAtMs, "release releasedAtMs");
    if (release.reason !== "served" && release.reason !== "expired")
      throw new Error("Stored release reason is invalid.");
  }
  if (value.flagCatch !== null) {
    if (!isRecord(value.flagCatch)) throw new Error("Stored flag catch is invalid.");
    requireTeam(value.flagCatch.team);
    requireSafeNonNegative(value.flagCatch.createdAtMs, "flagCatch.createdAtMs");
  }
  if (!isRecord(value.timeouts) || !isRecord(value.timeouts.home) || !isRecord(value.timeouts.away))
    throw new Error("Stored timeouts are invalid.");
  if (
    typeof value.timeouts.home.used !== "boolean" ||
    typeof value.timeouts.away.used !== "boolean"
  )
    throw new Error("Stored timeout usage is invalid.");
  if (value.timeouts.active !== null) {
    if (
      !isRecord(value.timeouts.active) ||
      !["home", "away"].includes(value.timeouts.active.team) ||
      typeof value.timeouts.active.running !== "boolean"
    )
      throw new Error("Stored active timeout is invalid.");
    requireInteger(
      value.timeouts.active.remainingMs,
      0,
      SHARED_LIMITS.clock.maxMs,
      "active timeout remainingMs",
    );
  }
  if (!isRecord(value.nextUnknownPlayerId)) throw new Error("Stored player counter is invalid.");
  requireInteger(value.nextUnknownPlayerId.home, 0, Number.MAX_SAFE_INTEGER, "next home player id");
  requireInteger(value.nextUnknownPlayerId.away, 0, Number.MAX_SAFE_INTEGER, "next away player id");
}

function validateStoredSession(value: unknown): asserts value is StoredSession {
  if (
    !isRecord(value) ||
    typeof value.sessionHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sessionHash) ||
    (value.browserId !== null && !validateOpaqueIdentifier(value.browserId, "browserId").ok) ||
    typeof value.connected !== "boolean"
  )
    throw new Error("Stored session is invalid.");
  requireSafeNonNegative(value.lastConnectedAtMs, "session lastConnectedAtMs");
  if (value.lastDisconnectedAtMs !== null)
    requireSafeNonNegative(value.lastDisconnectedAtMs, "session lastDisconnectedAtMs");
}

function validateStoredOperation(
  operationId: string,
  value: unknown,
): asserts value is StoredOperation {
  if (!isRecord(value) || typeof value.fingerprint !== "string" || value.fingerprint.length === 0)
    throw new Error("Stored operation is invalid.");
  if (
    value.status !== "accepted" &&
    value.status !== "rejected" &&
    value.status !== "causally-blocked"
  )
    throw new Error("Stored operation status is invalid.");
  const command = parseGameCommand(value.command);
  if (!command.ok) throw new Error(`Stored operation command is invalid: ${command.error}`);
  value.command = command.command;
  requireSafeNonNegative(value.acceptedAtMs, "operation acceptedAtMs");
  requireSafeNonNegative(value.clientSentAtMs, "operation clientSentAtMs");
  if (!Array.isArray(value.causalPredecessorIds))
    throw new Error("Stored operation causal references are invalid.");
  const seen = new Set<string>();
  for (const predecessor of value.causalPredecessorIds) {
    requireOpaque(predecessor, "causalPredecessorId");
    if (predecessor === operationId || seen.has(predecessor))
      throw new Error("Stored operation causal references are invalid.");
    seen.add(predecessor);
  }
  const expectedFingerprint = operationFingerprint({
    operationId,
    workflow: "ad-hoc",
    clientOriginAtMs: value.clientSentAtMs,
    causalPredecessorIds: value.causalPredecessorIds,
    payload: value.command,
  });
  if (value.fingerprint !== expectedFingerprint)
    throw new Error("Stored operation fingerprint is invalid.");
}

function hasStoredCausalCycle(
  id: string,
  graph: ReadonlyMap<string, readonly string[]>,
  active: Set<string>,
  visited: Set<string>,
): boolean {
  if (active.has(id)) return true;
  if (visited.has(id)) return false;
  active.add(id);
  for (const predecessor of graph.get(id) ?? [])
    if (graph.has(predecessor) && hasStoredCausalCycle(predecessor, graph, active, visited))
      return true;
  active.delete(id);
  visited.add(id);
  return false;
}

function requireOpaque(value: unknown, field: string): asserts value is string {
  const result = validateOpaqueIdentifier(value, field);
  if (!result.ok) throw new Error(result.error);
}
function requireSafeNonNegative(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${field} is invalid.`);
}
function requireInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new Error(`${field} is invalid.`);
}
function requireText(value: unknown, max: number, field: string): asserts value is string {
  if (!normalizeBoundedText(value, max, field).ok) throw new Error(`${field} is invalid.`);
}
function requireTeam(value: unknown): asserts value is "home" | "away" {
  if (value !== "home" && value !== "away") throw new Error("Stored team is invalid.");
}
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function validateBrowserId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const result = validateOpaqueIdentifier(value, "browserId");
  return result.ok ? result.value : null;
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
  return JSON.stringify([
    "ad-hoc",
    operation.clientSentAtMs,
    operation.command,
    [...(operation.causalPredecessorIds ?? [])],
  ]);
}

function operationFingerprint(operation: ControllerSynchronizationOperation<GameCommand>): string {
  return canonicalOperation({
    id: operation.operationId,
    clientSentAtMs: operation.clientOriginAtMs,
    command: operation.payload,
    workflow: "ad-hoc",
    causalPredecessorIds: operation.causalPredecessorIds,
  });
}

function parseAdHocOperations(
  operations: readonly AdHocOperation[],
):
  | { ok: true; operations: readonly ControllerSynchronizationOperation<GameCommand>[] }
  | { ok: false; error: string } {
  const transport = validateControllerReplay(operations, "ad-hoc");
  if (!transport.ok) return transport;
  const parsed: ControllerSynchronizationOperation<GameCommand>[] = [];
  for (const operation of transport.operations) {
    if (typeof operation.payload !== "object" || operation.payload === null) {
      return { ok: false, error: "Replay command must be an object." };
    }
    const command = parseGameCommand(operation.payload as Record<string, unknown>);
    if (!command.ok) return { ok: false, error: command.error };
    parsed.push({ ...operation, payload: command.command });
  }
  return { ok: true, operations: parsed };
}

function rejectedOperation(
  operation: ControllerSynchronizationOperation<GameCommand>,
  nowMs: number,
  detail: string,
  status: "rejected" | "causally-blocked",
): StoredOperation {
  return {
    fingerprint: operationFingerprint(operation),
    command: structuredClone(operation.payload),
    acceptedAtMs: nowMs,
    clientSentAtMs: operation.clientOriginAtMs,
    causalPredecessorIds: [...operation.causalPredecessorIds],
    status,
    detail,
  };
}

function rebuildAdHocState(game: StoredAdHocGame, rules: AdHocIqaGameRules): GameState | null {
  const baselineIds = new Set(game.replayBaselineOperationIds ?? []);
  const accepted = Object.entries(game.operations)
    .filter(([operationId]) => !baselineIds.has(operationId))
    .filter(([, operation]) => operation.status === undefined || operation.status === "accepted")
    .map(([operationId, operation]) => ({
      operationId,
      workflow: "ad-hoc" as const,
      clientOriginAtMs: operation.clientSentAtMs ?? operation.acceptedAtMs,
      causalPredecessorIds: [...(operation.causalPredecessorIds ?? [])],
      payload: operation.command,
    }));
  const acceptedIds = new Set([
    ...baselineIds,
    ...accepted.map((operation) => operation.operationId),
  ]);
  const eligible = accepted.filter((operation) =>
    operation.causalPredecessorIds.every((predecessor) => acceptedIds.has(predecessor)),
  );
  const ordered = orderControllerOperations(eligible);
  if (!ordered.ok) return null;
  let state = structuredClone(game.initialState ?? game.state) as GameState;
  for (const operation of ordered.operations) {
    let generated = 0;
    state = rules.apply({
      state,
      command: operation.payload,
      nowMs: operation.clientOriginAtMs,
      idGenerator: () => `${operation.operationId}:${++generated}`,
    });
  }
  return state;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cloneStoredGame(game: StoredAdHocGame): StoredAdHocGame {
  const cloned = structuredClone(game) as StoredAdHocGame;
  cloned.replayBaselineOperationIds ??= [];
  for (const [operationId, operation] of Object.entries(cloned.operations)) {
    operation.clientSentAtMs ??= operation.acceptedAtMs;
    operation.causalPredecessorIds ??= [];
    operation.status ??= "accepted";
    cloned.operations[operationId] = operation;
  }
  return validateStoredGame(cloned);
}

function unavailable(): AdHocAccessResult {
  return { status: "unavailable", detail: GENERIC_UNAVAILABLE };
}
