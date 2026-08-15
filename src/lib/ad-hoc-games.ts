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
import {
  AD_HOC_CONTROLLER_BURST,
  AD_HOC_CONTROLLER_SUSTAINED_PER_SECOND,
  AD_HOC_GAME_BURST,
  AD_HOC_GAME_SUSTAINED_PER_SECOND,
  AD_HOC_EVENT_RESERVED_CONNECTION_CAPACITY,
  AD_HOC_EVENT_TOTAL_CONNECTION_CAPACITY,
  AD_HOC_MAX_CONNECTED_CONTROLLERS,
  AD_HOC_REPLAY_BURST,
  AD_HOC_REPLAY_MAX_OPERATIONS_PER_BATCH,
  AD_HOC_REPLAY_SUSTAINED_PER_SECOND,
  adHocCreationDelayMs,
  consumeAdHocTokens,
  emptyAdHocResourceMetrics,
  type AdHocResourceMetric,
  type AdHocResourceMetrics,
  type AdHocTokenBucket,
} from "@/lib/ad-hoc-resource-budgets";

export const AD_HOC_MAX_RETAINED_GAMES = 50;
export const AD_HOC_DISCONNECTED_GRACE_MS = 5 * 60_000;
export const AD_HOC_CREATION_SOURCE_WINDOW_MS = 10 * 60_000;
export const AD_HOC_CREATION_GLOBAL_WINDOW_MS = 60 * 60_000;
export const AD_HOC_MAX_CREATIONS_PER_SOURCE = 5;
export const AD_HOC_MAX_CREATIONS_PER_HOUR = 30;
export const AD_HOC_MAX_OPERATIONS_PER_SECOND_PER_CONTROLLER = AD_HOC_CONTROLLER_BURST;
export const AD_HOC_MAX_OPERATIONS_PER_SECOND_PER_GAME = AD_HOC_GAME_BURST;

const SCHEMA_VERSION = 4;
const GENERIC_UNAVAILABLE = "Ad Hoc Game unavailable.";
const GENERIC_CAPACITY = "Ad Hoc capacity is currently full; no game was changed.";

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
      replayId?: string;
    }
  | {
      status: "rejected";
      reason: "unavailable" | "invalid-operation" | "conflict" | "rate-limited";
      detail?: string;
      retryAfterMs?: number;
      outcomes?: readonly ControllerOperationOutcome[];
    };

export type AdHocAccessResult =
  | { status: "accepted"; game: AdHocGameView }
  | { status: "unavailable"; detail: string };

export type AdHocSubscriptionResult =
  | AdHocAccessResult
  | { status: "capacity"; retryAfterMs: number };

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
  | { rateLimited: true; retryAfterMs: number }
  | {
      acknowledged: string[];
      duplicate: boolean;
      outcomes: readonly ControllerOperationOutcome[];
    };

type PreparedReplayEntry = {
  operation: ControllerSynchronizationOperation<GameCommand>;
  status: "accepted" | "rejected" | "causally-blocked" | "duplicate";
  detail?: string;
};

export type AdHocStore = {
  close(): void;
  listGames(): StoredAdHocGame[];
  readGame(gameId: string): StoredAdHocGame | null;
  createGame(input: {
    game: StoredAdHocGame;
    sourceHash: string;
    nowMs: number;
  }):
    | "rate-limited"
    | "capacity"
    | "unavailable"
    | { status: "rate-limited"; retryAfterMs: number }
    | { status: "accepted"; removedGameId: string | null };
  mutateGame<T>(gameId: string, mutation: (game: StoredAdHocGame) => T): T | null;
};

export type AdHocLiveSessionIdentity = {
  gameId: string;
  sessionId: string;
};

export type AdHocLiveSessionSubscribeResult = {
  attached: boolean;
  previousDisconnectDurable: boolean;
};

export type AdHocLiveSessionTrackerOptions = {
  retryBatchSize?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  scheduleRetry?: (delayMs: number, task: () => void) => void;
};

export function createAdHocLiveSessionTracker(
  onLastSocketClosed: (identity: AdHocLiveSessionIdentity) => Promise<boolean>,
  options: AdHocLiveSessionTrackerOptions = {},
) {
  const socketOwners = new Map<string, AdHocLiveSessionIdentity>();
  const sessionSockets = new Map<string, Set<string>>();
  const pendingDisconnects = new Map<string, AdHocLiveSessionIdentity>();
  const closedSockets = new Set<string>();
  const socketTasks = new Map<string, Promise<unknown>>();
  const sessionTasks = new Map<string, Promise<unknown>>();
  const retryBatchSize = Math.max(1, Math.floor(options.retryBatchSize ?? 8));
  const retryBaseDelayMs = Math.max(1, Math.floor(options.retryBaseDelayMs ?? 100));
  const retryMaxDelayMs = Math.max(retryBaseDelayMs, Math.floor(options.retryMaxDelayMs ?? 10_000));
  const schedule =
    options.scheduleRetry ??
    ((delayMs: number, task: () => void) => {
      const timer = setTimeout(task, delayMs);
      (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    });
  let retryScheduled = false;
  let retryDelayMs = retryBaseDelayMs;
  let retryInFlight: Promise<boolean> | null = null;
  let retryPending: () => Promise<boolean> = async () => true;
  const keyFor = (identity: AdHocLiveSessionIdentity) =>
    JSON.stringify([identity.gameId, identity.sessionId]);
  const enqueue = <T>(
    tasks: Map<string, Promise<unknown>>,
    key: string,
    work: () => Promise<T>,
  ) => {
    const previous = tasks.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    tasks.set(key, next);
    void next.then(
      () => {
        if (tasks.get(key) === next) tasks.delete(key);
        if (tasks === socketTasks && closedSockets.has(key) && !socketTasks.has(key)) {
          closedSockets.delete(key);
        }
      },
      () => {
        if (tasks.get(key) === next) tasks.delete(key);
        if (tasks === socketTasks && closedSockets.has(key) && !socketTasks.has(key)) {
          closedSockets.delete(key);
        }
      },
    );
    return next;
  };
  const scheduleRetry = () => {
    if (retryScheduled || pendingDisconnects.size === 0) return;
    retryScheduled = true;
    schedule(retryDelayMs, () => {
      retryScheduled = false;
      void retryPending();
    });
  };
  const disconnectIfLast = (identity: AdHocLiveSessionIdentity) => {
    const key = keyFor(identity);
    return enqueue(sessionTasks, key, async () => {
      if (sessionSockets.has(key)) {
        pendingDisconnects.delete(key);
        return true;
      }
      let durable = false;
      try {
        durable = await onLastSocketClosed(identity);
      } catch {
        durable = false;
      }
      if (sessionSockets.has(key)) {
        pendingDisconnects.delete(key);
        return true;
      }
      if (durable) pendingDisconnects.delete(key);
      else pendingDisconnects.set(key, identity);
      return durable;
    });
  };
  const performRetry = async (): Promise<boolean> => {
    const batch = [...pendingDisconnects.values()].slice(0, retryBatchSize);
    if (batch.length === 0) {
      retryDelayMs = retryBaseDelayMs;
      return true;
    }
    const results = await Promise.all(batch.map((identity) => disconnectIfLast(identity)));
    for (let index = 0; index < batch.length; index += 1) {
      if (results[index] === true) continue;
      const identity = batch[index]!;
      const key = keyFor(identity);
      const pending = pendingDisconnects.get(key);
      if (pending !== undefined) {
        pendingDisconnects.delete(key);
        pendingDisconnects.set(key, pending);
      }
    }
    if (pendingDisconnects.size === 0) retryDelayMs = retryBaseDelayMs;
    else {
      retryDelayMs = Math.min(retryMaxDelayMs, retryDelayMs * 2);
      scheduleRetry();
    }
    return pendingDisconnects.size === 0 && results.every(Boolean);
  };
  const tracker = {
    async subscribe(
      socketId: string,
      identity: AdHocLiveSessionIdentity,
    ): Promise<AdHocLiveSessionSubscribeResult> {
      return await enqueue(socketTasks, socketId, async () => {
        if (closedSockets.has(socketId)) {
          const durable = await disconnectIfLast(identity);
          if (!durable) scheduleRetry();
          return { attached: false, previousDisconnectDurable: durable };
        }
        const previous = socketOwners.get(socketId);
        if (previous !== undefined && keyFor(previous) === keyFor(identity)) {
          pendingDisconnects.delete(keyFor(identity));
          return { attached: true, previousDisconnectDurable: true };
        }
        let previousDisconnectDurable = true;
        if (previous !== undefined) {
          socketOwners.delete(socketId);
          const previousKey = keyFor(previous);
          const previousSockets = sessionSockets.get(previousKey);
          previousSockets?.delete(socketId);
          if (previousSockets?.size === 0) {
            sessionSockets.delete(previousKey);
            previousDisconnectDurable = await disconnectIfLast(previous);
          }
        }
        const key = keyFor(identity);
        socketOwners.set(socketId, identity);
        const socketsForSession = sessionSockets.get(key) ?? new Set<string>();
        socketsForSession.add(socketId);
        sessionSockets.set(key, socketsForSession);
        pendingDisconnects.delete(key);
        if (!previousDisconnectDurable) scheduleRetry();
        return { attached: true, previousDisconnectDurable };
      });
    },
    async disconnect(socketId: string): Promise<boolean> {
      closedSockets.add(socketId);
      const durable = await enqueue(socketTasks, socketId, async () => {
        const identity = socketOwners.get(socketId);
        if (identity === undefined) return true;
        socketOwners.delete(socketId);
        const key = keyFor(identity);
        const socketsForSession = sessionSockets.get(key);
        socketsForSession?.delete(socketId);
        if (socketsForSession?.size !== 0) return true;
        sessionSockets.delete(key);
        return await disconnectIfLast(identity);
      });
      if (!durable) scheduleRetry();
      return durable;
    },
    count(identity: AdHocLiveSessionIdentity) {
      return sessionSockets.get(keyFor(identity))?.size ?? 0;
    },
    pendingCount() {
      return pendingDisconnects.size;
    },
    tombstoneCount() {
      return closedSockets.size;
    },
    async retryPending(): Promise<boolean> {
      if (retryInFlight !== null) return await retryInFlight;
      const current = performRetry();
      retryInFlight = current;
      void current.then(
        () => {
          if (retryInFlight === current) retryInFlight = null;
        },
        () => {
          if (retryInFlight === current) retryInFlight = null;
        },
      );
      return await current;
    },
  };
  retryPending = () => tracker.retryPending();
  return tracker;
}

export type AdHocSqliteStoreOptions = {
  reconcileConnectionsAtStartup?: boolean;
  startupNowMs?: number;
  beforeCapacityCommit?: () => void;
};

export type AdHocGamesServiceOptions = {
  store?: AdHocStore;
  now?: () => number;
  random?: () => string;
  environmentIdentity?: string;
  iqaRules?: AdHocIqaGameRules;
  deferReplayAcknowledgement?: boolean;
  maxConnectedSockets?: number;
  eventCapacity?: {
    totalConnections?: number;
    reservedConnections?: number;
    activeConnections?: () => number;
  };
  schedule?: (delayMs: number, task: () => void) => unknown;
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
  const deferReplayAcknowledgement = options.deferReplayAcknowledgement ?? false;
  const maxConnectedSockets = options.maxConnectedSockets ?? AD_HOC_MAX_CONNECTED_CONTROLLERS;
  const eventCapacity = {
    totalConnections:
      options.eventCapacity?.totalConnections ?? AD_HOC_EVENT_TOTAL_CONNECTION_CAPACITY,
    reservedConnections:
      options.eventCapacity?.reservedConnections ?? AD_HOC_EVENT_RESERVED_CONNECTION_CAPACITY,
    activeConnections: options.eventCapacity?.activeConnections ?? (() => 0),
  };
  const schedule =
    options.schedule ??
    ((delayMs: number, task: () => void) => {
      const timer = setTimeout(task, delayMs);
      return () => clearTimeout(timer);
    });
  const controllerActionBuckets = new Map<string, AdHocTokenBucket>();
  const gameActionBuckets = new Map<string, AdHocTokenBucket>();
  const replayBuckets = new Map<string, AdHocTokenBucket>();
  const replayInFlight = new Set<string>();
  const pendingReplays = new Map<string, string>();
  const replayJobs = new Map<
    string,
    { cancel: () => void; resolve: (result: AdHocActionResult) => void }
  >();
  const connections = new Map<string, string>();
  const metrics = emptyAdHocResourceMetrics();
  let closed = false;
  const preparedReplayChunk = Symbol("preparedReplayChunk");
  const scheduleReplayTask = (delayMs: number, task: () => void) => {
    let active = true;
    let cancelUnderlying: (() => void) | undefined;
    const cancel = () => {
      active = false;
      cancelUnderlying?.();
    };
    const scheduled = schedule(delayMs, () => {
      if (active) task();
    });
    if (typeof scheduled === "function") cancelUnderlying = scheduled as () => void;
    return cancel;
  };

  const updateConnection = (input: {
    gameId: string;
    sessionId: string;
    connected: boolean;
    connectionId: string;
    nowMs: number;
  }): { status: "accepted"; game: StoredAdHocGame } | { status: "capacity" } | null => {
    const sessionKey = digest(input.sessionId);
    let connectionChange: "add" | "remove" | null = null;
    let outcome: StoredAdHocGame | false | { capacity: true; rollback: true } | null;
    try {
      outcome = store.mutateGame(input.gameId, (game) => {
        if (game.environmentIdentity !== environmentIdentity) return false;
        const session = game.sessions.find((candidate) => candidate.sessionHash === sessionKey);
        if (session === undefined) return false;
        if (input.connected && !connections.has(input.connectionId)) {
          const activeEventConnections = Math.max(0, eventCapacity.activeConnections());
          const availableForAdHoc = Math.max(
            0,
            Math.min(
              maxConnectedSockets,
              eventCapacity.totalConnections -
                Math.max(eventCapacity.reservedConnections, activeEventConnections),
            ),
          );
          if (connections.size >= availableForAdHoc) {
            return { capacity: true, rollback: true } as const;
          }
          connectionChange = "add";
        }
        if (!input.connected && connections.has(input.connectionId)) {
          connectionChange = "remove";
        }
        const hasOtherConnection = [...connections].some(
          ([candidateId, candidateSessionKey]) =>
            candidateId !== input.connectionId && candidateSessionKey === sessionKey,
        );
        session.connected = input.connected || hasOtherConnection;
        if (input.connected) session.lastConnectedAtMs = input.nowMs;
        else if (!hasOtherConnection) session.lastDisconnectedAtMs = input.nowMs;
        return game;
      });
    } catch {
      return null;
    }
    if (outcome === null || outcome === false) return null;
    if ("capacity" in outcome) return { status: "capacity" };
    if (connectionChange === "add") connections.set(input.connectionId, sessionKey);
    if (connectionChange === "remove") connections.delete(input.connectionId);
    return { status: "accepted", game: outcome };
  };

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
      if (
        outcome === "rate-limited" ||
        (typeof outcome === "object" && outcome.status === "rate-limited")
      ) {
        const retryAfterMs = typeof outcome === "object" ? outcome.retryAfterMs : 60 * 60_000;
        metrics.creationDelay += retryAfterMs <= 30_000 ? 1 : 0;
        metrics.creationRateExhausted += retryAfterMs > 30_000 ? 1 : 0;
        return {
          status: "rejected",
          reason: "rate-limited",
          detail: "Try again later.",
          retryAfterMs,
        };
      }
      if (outcome === "capacity") {
        return { status: "rejected", reason: "capacity", detail: GENERIC_CAPACITY };
      }
      if (outcome === "unavailable") return { status: "rejected", reason: "unavailable" };

      if (outcome.removedGameId !== null) {
        gameActionBuckets.delete(outcome.removedGameId);
        const prefix = `${outcome.removedGameId}:`;
        for (const key of controllerActionBuckets.keys()) {
          if (key.startsWith(prefix)) controllerActionBuckets.delete(key);
        }
        for (const key of replayBuckets.keys()) {
          if (key.startsWith(prefix)) replayBuckets.delete(key);
        }
      }

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

    async subscribe(input: {
      gameId: unknown;
      sessionId: unknown;
      nowMs?: number;
    }): Promise<AdHocSubscriptionResult> {
      const gameId = validateGameId(input.gameId);
      const sessionId = validateBearer(input.sessionId);
      if (gameId === null || sessionId === null) return unavailable();
      const nowMs = input.nowMs ?? now();
      if (!isSafeTimestamp(nowMs)) return unavailable();
      const outcome = updateConnection({
        gameId,
        sessionId,
        connected: true,
        connectionId: digest(sessionId),
        nowMs,
      });
      if (outcome === null) return unavailable();
      if (outcome.status === "capacity") return { status: "capacity", retryAfterMs: 1_000 };
      return {
        status: "accepted",
        game: projectAuthorizedGame(outcome.game, sessionId, null, nowMs, iqaRules),
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
      if (closed) return { status: "rejected", reason: "unavailable" };
      const preparedChunk = (
        input as typeof input & {
          [preparedReplayChunk]?: readonly PreparedReplayEntry[];
        }
      )[preparedReplayChunk];
      if (deferReplayAcknowledgement && preparedChunk === undefined) {
        const sessionId = validateBearer(input.sessionId);
        const gameId = validateGameId(input.gameId);
        const nowMs = input.nowMs ?? now();
        if (
          sessionId !== null &&
          gameId !== null &&
          isSafeTimestamp(nowMs) &&
          Array.isArray(input.operations) &&
          input.operations.length > 0 &&
          input.operations.length <= AD_HOC_REPLAY_MAX_OPERATIONS_PER_BATCH
        ) {
          const replaySessionKey = digest(sessionId);
          if (pendingReplays.has(replaySessionKey)) {
            metrics.replayPressure += 1;
            return {
              status: "rejected",
              reason: "rate-limited",
              detail: "Try again later.",
              retryAfterMs: 1_000,
            };
          }
          let game: StoredAdHocGame | null;
          try {
            game = store.readGame(gameId);
          } catch {
            return { status: "rejected", reason: "unavailable" };
          }
          if (game === null || game.environmentIdentity !== environmentIdentity) {
            return { status: "rejected", reason: "unavailable" };
          }
          if (!hasSession(game, sessionId)) return { status: "rejected", reason: "unavailable" };
          const parsed = parseAdHocOperations(input.operations);
          if (!parsed.ok) return { status: "rejected", reason: "invalid-operation" };
          for (const operation of parsed.operations) {
            const existing = game.operations[operation.operationId];
            if (
              existing !== undefined &&
              existing.fingerprint !== operationFingerprint(operation)
            ) {
              return {
                status: "rejected",
                reason: "conflict",
                outcomes: [
                  {
                    operationId: operation.operationId,
                    workflow: "ad-hoc",
                    status: "rejected",
                    detail: "The operation identity is already bound to different content.",
                  },
                ],
              };
            }
          }
          const retainedStatuses = new Map(
            Object.entries(game.operations).map(
              ([operationId, operation]) => [operationId, operation.status] as const,
            ),
          );
          const incoming = parsed.operations;
          const resolution = resolveControllerBatch({
            operations: incoming.filter(
              (operation) => game.operations[operation.operationId] === undefined,
            ),
            retainedStatuses,
          });
          const plannedEntries: PreparedReplayEntry[] = orderReplayPlan(incoming).map(
            (operation) => {
              const existing = game.operations[operation.operationId];
              if (existing !== undefined) {
                return {
                  operation,
                  status: existing.status === "accepted" ? "duplicate" : existing.status,
                  ...(existing.detail === undefined ? {} : { detail: existing.detail }),
                };
              }
              return {
                operation,
                status: resolution.statuses.get(operation.operationId) ?? "rejected",
                ...(resolution.details.has(operation.operationId)
                  ? { detail: resolution.details.get(operation.operationId) }
                  : {}),
              };
            },
          );
          const replayId = random();
          pendingReplays.set(replaySessionKey, replayId);
          const chunks = Array.from({ length: Math.ceil(plannedEntries.length / 20) }, (_, index) =>
            plannedEntries.slice(index * 20, (index + 1) * 20),
          );
          return new Promise<AdHocActionResult>((resolve) => {
            const acknowledgedOperationIds: string[] = [];
            const outcomes: ControllerOperationOutcome[] = [];
            let projectedGame: AdHocGameView | null = null;
            let duplicate = true;
            let retryCount = 0;
            const deadlineMs = nowMs + 30_000;
            const isCurrentJob = () =>
              !closed && replayJobs.get(replaySessionKey)?.resolve === resolve;
            const rejectJob = (result: AdHocActionResult) => {
              pendingReplays.delete(replaySessionKey);
              replayJobs.delete(replaySessionKey);
              resolve(result);
            };
            const runChunk = (index: number, scheduledAtMs: number) => {
              if (!isCurrentJob()) {
                rejectJob({ status: "rejected", reason: "unavailable" });
                return;
              }
              void this.apply({
                gameId,
                sessionId,
                operations: chunks[index]!.map((entry) => fromControllerOperation(entry.operation)),
                nowMs: scheduledAtMs,
                [preparedReplayChunk]: chunks[index]!,
              } as typeof input & { [preparedReplayChunk]: readonly PreparedReplayEntry[] }).then(
                (result) => {
                  if (!isCurrentJob()) return;
                  if (result.status === "rejected") {
                    if (result.reason === "rate-limited") {
                      const delayMs = Math.max(1, result.retryAfterMs ?? 1_000);
                      retryCount += 1;
                      if (retryCount > 5 || scheduledAtMs + delayMs > deadlineMs) {
                        rejectJob({
                          status: "rejected",
                          reason: "rate-limited",
                          retryAfterMs: delayMs,
                        });
                        return;
                      }
                      if (!isCurrentJob()) return;
                      const cancel = scheduleReplayTask(delayMs, () =>
                        runChunk(index, scheduledAtMs + delayMs),
                      );
                      const job = replayJobs.get(replaySessionKey);
                      if (job !== undefined) job.cancel = cancel;
                      return;
                    }
                    rejectJob(result);
                    return;
                  }
                  acknowledgedOperationIds.push(...result.ackedOperationIds);
                  outcomes.push(...result.outcomes);
                  projectedGame = result.game;
                  duplicate &&= result.status === "duplicate";
                  if (index + 1 < chunks.length) {
                    if (!isCurrentJob()) return;
                    const cancel = scheduleReplayTask(1_000, () =>
                      runChunk(index + 1, scheduledAtMs + 1_000),
                    );
                    const job = replayJobs.get(replaySessionKey);
                    if (job !== undefined) job.cancel = cancel;
                    return;
                  }
                  replayJobs.delete(replaySessionKey);
                  resolve({
                    status: duplicate ? "duplicate" : "accepted",
                    game: projectedGame,
                    ackedOperationIds: acknowledgedOperationIds,
                    outcomes,
                    replayId,
                  });
                },
              );
            };
            const job = { cancel: () => {}, resolve };
            replayJobs.set(replaySessionKey, job);
            job.cancel = scheduleReplayTask(0, () => runChunk(0, nowMs));
          });
        }
      }
      const gameId = validateGameId(input.gameId);
      const sessionId = validateBearer(input.sessionId);
      if (
        gameId === null ||
        sessionId === null ||
        !Array.isArray(input.operations) ||
        input.operations.length === 0 ||
        input.operations.length > AD_HOC_REPLAY_MAX_OPERATIONS_PER_BATCH
      ) {
        return { status: "rejected", reason: "invalid-operation" };
      }
      const nowMs = input.nowMs ?? now();
      if (!isSafeTimestamp(nowMs)) return { status: "rejected", reason: "invalid-operation" };
      let outcome: AdHocApplyMutationResult | null;
      const replaySessionKey = digest(sessionId);
      const sessionBucketKey = `${gameId}:${replaySessionKey}`;
      if (
        preparedChunk === undefined &&
        (replayInFlight.has(replaySessionKey) || pendingReplays.has(replaySessionKey))
      ) {
        metrics.replayPressure += 1;
        return {
          status: "rejected",
          reason: "rate-limited",
          detail: "Try again later.",
          retryAfterMs: 1_000,
        };
      }
      replayInFlight.add(replaySessionKey);
      let nextControllerBucket: AdHocTokenBucket | undefined;
      let nextGameBucket: AdHocTokenBucket | undefined;
      let nextReplayBucket: AdHocTokenBucket | undefined;
      try {
        outcome = store.mutateGame<AdHocApplyMutationResult>(gameId, (game) => {
          if (game.environmentIdentity !== environmentIdentity || !hasSession(game, sessionId))
            return false;
          const next = structuredClone(game) as StoredAdHocGame;
          const acknowledged: string[] = [];
          let duplicate = false;
          const parsed =
            preparedChunk === undefined ? parseAdHocOperations(input.operations) : null;
          if (preparedChunk === undefined && (parsed === null || !parsed.ok))
            return { invalid: true, rollback: true } as const;
          const incoming =
            preparedChunk?.map((entry) => entry.operation) ??
            (parsed as Extract<typeof parsed, { ok: true }>).operations;
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
          const reconciledPreparedChunk =
            preparedChunk === undefined
              ? undefined
              : reconcilePreparedReplayChunk(preparedChunk, next.operations);
          const acceptedNewOperationCount =
            preparedChunk === undefined
              ? (() => {
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
                  return resolution.ordered.filter(
                    (operation) => resolution.statuses.get(operation.operationId) === "accepted",
                  ).length;
                })()
              : reconciledPreparedChunk!.filter(
                  (entry) =>
                    entry.status === "accepted" &&
                    next.operations[entry.operation.operationId] === undefined,
                ).length;
          if (acceptedNewOperationCount > 0) {
            const controller = consumeAdHocTokens(
              controllerActionBuckets.get(sessionBucketKey),
              nowMs,
              AD_HOC_CONTROLLER_BURST,
              AD_HOC_CONTROLLER_SUSTAINED_PER_SECOND,
              acceptedNewOperationCount,
            );
            const gameBucket = consumeAdHocTokens(
              gameActionBuckets.get(gameId),
              nowMs,
              AD_HOC_GAME_BURST,
              AD_HOC_GAME_SUSTAINED_PER_SECOND,
              acceptedNewOperationCount,
            );
            const replay = consumeAdHocTokens(
              replayBuckets.get(sessionBucketKey),
              nowMs,
              deferReplayAcknowledgement
                ? AD_HOC_REPLAY_BURST
                : AD_HOC_REPLAY_MAX_OPERATIONS_PER_BATCH,
              AD_HOC_REPLAY_SUSTAINED_PER_SECOND,
              acceptedNewOperationCount,
            );
            if (!controller.accepted || !gameBucket.accepted || !replay.accepted) {
              const retryAfterMs = Math.max(
                controller.accepted ? 0 : controller.retryAfterMs,
                gameBucket.accepted ? 0 : gameBucket.retryAfterMs,
                replay.accepted ? 0 : replay.retryAfterMs,
              );
              return { rateLimited: true, retryAfterMs } as const;
            }
            nextControllerBucket = controller.bucket;
            nextGameBucket = gameBucket.bucket;
            nextReplayBucket = replay.bucket;
          }
          if (preparedChunk !== undefined) {
            for (const entry of reconciledPreparedChunk!) {
              const operation = entry.operation;
              if (next.operations[operation.operationId] !== undefined) continue;
              const status = entry.status === "duplicate" ? "rejected" : entry.status;
              const detail = entry.detail;
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
          } else {
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
          }
          const rebuilt = rebuildAdHocState(next, iqaRules);
          if (rebuilt === null) return { invalid: true, rollback: true } as const;
          next.state = rebuilt;
          next.state.updatedAtMs = nowMs;
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
      } finally {
        replayInFlight.delete(replaySessionKey);
      }
      if (outcome === null || outcome === false)
        return { status: "rejected", reason: "unavailable" };
      if ("rateLimited" in outcome) {
        metrics.actionRateExhausted += 1;
        metrics.replayPressure += outcome.retryAfterMs > 0 ? 1 : 0;
        return {
          status: "rejected",
          reason: "rate-limited",
          detail: "Try again later.",
          retryAfterMs: outcome.retryAfterMs,
        };
      }
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
      if (nextControllerBucket !== undefined)
        controllerActionBuckets.set(sessionBucketKey, nextControllerBucket);
      if (nextGameBucket !== undefined) gameActionBuckets.set(gameId, nextGameBucket);
      if (nextReplayBucket !== undefined) replayBuckets.set(sessionBucketKey, nextReplayBucket);
      return {
        status: outcome.duplicate ? "duplicate" : "accepted",
        ackedOperationIds: outcome.acknowledged,
        outcomes: outcome.outcomes,
        game: projectAuthorizedGame(game, sessionId, null, nowMs, iqaRules),
      };
    },

    async acknowledgeReplay(input: {
      sessionId: unknown;
      replayId: unknown;
      delivered: boolean;
    }): Promise<boolean> {
      const sessionId = validateBearer(input.sessionId);
      const replayId = validateBearer(input.replayId);
      if (sessionId === null || replayId === null) return false;
      const sessionKey = digest(sessionId);
      if (pendingReplays.get(sessionKey) !== replayId) return false;
      // A failed transport delivery releases the reservation without
      // acknowledging operations; the browser can safely resend them.
      pendingReplays.delete(sessionKey);
      return true;
    },

    async setConnection(input: {
      gameId: unknown;
      sessionId: unknown;
      connected: boolean;
      connectionId?: string;
      nowMs?: number;
    }): Promise<boolean> {
      const gameId = validateGameId(input.gameId);
      const sessionId = validateBearer(input.sessionId);
      if (gameId === null || sessionId === null) return false;
      const nowMs = input.nowMs ?? now();
      if (!isSafeTimestamp(nowMs)) return false;
      const connectionId = input.connectionId?.trim() || digest(sessionId);
      const outcome = updateConnection({
        gameId,
        sessionId,
        connected: input.connected,
        connectionId,
        nowMs,
      });
      if (outcome?.status === "capacity") metrics.connectionShed += 1;
      return outcome?.status === "accepted";
    },

    async leave(input: { gameId: unknown; sessionId: unknown; nowMs?: number }): Promise<boolean> {
      const gameId = validateGameId(input.gameId);
      const sessionId = validateBearer(input.sessionId);
      if (gameId === null || sessionId === null) return false;
      try {
        const changed =
          store.mutateGame(gameId, (game) => {
            if (game.environmentIdentity !== environmentIdentity) return false;
            const before = game.sessions.length;
            game.sessions = game.sessions.filter(
              (session) => session.sessionHash !== digest(sessionId),
            );
            return game.sessions.length !== before;
          }) === true;
        if (changed) {
          for (const [connectionId, connectionSessionKey] of connections) {
            if (connectionSessionKey === digest(sessionId)) connections.delete(connectionId);
          }
        }
        return changed;
      } catch {
        return false;
      }
    },

    genericUnavailableMessage: GENERIC_UNAVAILABLE,
    getResourceMetrics(): AdHocResourceMetrics {
      metrics.connectedControllers = connections.size;
      const activeEventConnections = Math.max(0, eventCapacity.activeConnections());
      metrics.eventReservedCapacity = {
        configured: eventCapacity.reservedConnections,
        active: activeEventConnections,
        availableForAdHoc: Math.max(
          0,
          Math.min(
            maxConnectedSockets,
            eventCapacity.totalConnections -
              Math.max(eventCapacity.reservedConnections, activeEventConnections),
          ),
        ),
      };
      return { ...metrics };
    },
    recordResourcePressure(metric: AdHocResourceMetric) {
      if (metric === "creation-delay") metrics.creationDelay += 1;
      if (metric === "creation-rate-exhausted") metrics.creationRateExhausted += 1;
      if (metric === "action-rate-exhausted") metrics.actionRateExhausted += 1;
      if (metric === "replay-pressure") metrics.replayPressure += 1;
      if (metric === "connection-shed") metrics.connectionShed += 1;
      if (metric === "queue-pressure") metrics.queuePressure += 1;
    },
    store,
    close() {
      if (closed) return;
      closed = true;
      for (const job of replayJobs.values()) {
        job.cancel();
        job.resolve({ status: "rejected", reason: "unavailable" });
      }
      replayJobs.clear();
      pendingReplays.clear();
      replayInFlight.clear();
      connections.clear();
      store.close();
    },
  };
}

export function createInMemoryAdHocStore(): AdHocStore {
  const games = new Map<string, StoredAdHocGame>();
  const attempts = new Map<
    string,
    { occurredAtMs: number; successful: boolean; retryUntilMs?: number }[]
  >();
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
        (attempt) => attempt.occurredAtMs > nowMs - AD_HOC_CREATION_SOURCE_WINDOW_MS,
      );
      const latest = sourceAttempts.at(-1);
      if (latest?.successful === false && (latest.retryUntilMs ?? 0) > nowMs) {
        return {
          status: "rate-limited",
          retryAfterMs: (latest.retryUntilMs ?? nowMs) - nowMs,
        };
      }
      const sourceSuccesses = sourceAttempts.filter((attempt) => attempt.successful);
      const expiredDelay = latest?.successful === false && (latest.retryUntilMs ?? 0) <= nowMs;
      if (sourceSuccesses.length >= AD_HOC_MAX_CREATIONS_PER_SOURCE && !expiredDelay) {
        const retryAfterMs = adHocCreationDelayMs(sourceSuccesses.length);
        attempts.set(sourceHash, [
          ...sourceAttempts,
          { occurredAtMs: nowMs, successful: false, retryUntilMs: nowMs + retryAfterMs },
        ]);
        return {
          status: "rate-limited",
          retryAfterMs,
        };
      }
      const recentSuccesses = successes.filter(
        (value) => value > nowMs - AD_HOC_CREATION_GLOBAL_WINDOW_MS,
      );
      if (recentSuccesses.length >= AD_HOC_MAX_CREATIONS_PER_HOUR) {
        const retryAfterMs = Math.max(
          1_000,
          (recentSuccesses[0] ?? nowMs) + AD_HOC_CREATION_GLOBAL_WINDOW_MS - nowMs,
        );
        attempts.set(sourceHash, [
          ...sourceAttempts,
          { occurredAtMs: nowMs, successful: false, retryUntilMs: nowMs + retryAfterMs },
        ]);
        return {
          status: "rate-limited",
          retryAfterMs,
        };
      }
      let removedGameId: string | null = null;
      const retainedCount = games.size;
      if (retainedCount >= AD_HOC_MAX_RETAINED_GAMES) {
        const victim = [...games.values()]
          .filter(
            (candidate) =>
              candidate.environmentIdentity === game.environmentIdentity &&
              candidate.sessions.every((session) => isCleanupEligible(session, nowMs)),
          )
          .sort((a, b) => a.createdAtMs - b.createdAtMs || a.gameId.localeCompare(b.gameId))[0];
        if (victim === undefined) return "capacity";
        games.delete(victim.gameId);
        removedGameId = victim.gameId;
      }
      games.set(game.gameId, cloneStoredGame(game));
      successes.push(nowMs);
      attempts.set(sourceHash, [...sourceAttempts, { occurredAtMs: nowMs, successful: true }]);
      return { status: "accepted", removedGameId };
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
  options: AdHocSqliteStoreOptions = {},
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
    "CREATE TABLE IF NOT EXISTS adhoc_creation_events (source_hash TEXT NOT NULL, successful INTEGER NOT NULL, occurred_at_ms INTEGER NOT NULL, retry_until_ms INTEGER)",
  );
  const creationEventColumns = db.query("PRAGMA table_info(adhoc_creation_events)").all() as {
    name?: string;
  }[];
  if (!creationEventColumns.some((column) => column.name === "retry_until_ms")) {
    db.run("ALTER TABLE adhoc_creation_events ADD COLUMN retry_until_ms INTEGER");
  }

  if (options.reconcileConnectionsAtStartup === true) {
    const startupNowMs = options.startupNowMs ?? Date.now();
    if (!isSafeTimestamp(startupNowMs)) throw new Error("Startup timestamp is invalid.");
    const reconcile = db.transaction(() => {
      const rows = db
        .query("SELECT game_id, sessions_json FROM adhoc_games WHERE environment_identity = ?")
        .all(environmentIdentity) as { game_id: string; sessions_json: string }[];
      for (const row of rows) {
        const sessions = JSON.parse(row.sessions_json) as StoredSession[];
        let changed = false;
        for (const session of sessions) {
          if (!session.connected) continue;
          session.connected = false;
          session.lastDisconnectedAtMs = startupNowMs;
          changed = true;
        }
        if (changed) {
          db.run("UPDATE adhoc_games SET sessions_json = ? WHERE game_id = ?", [
            JSON.stringify(sessions),
            row.game_id,
          ]);
        }
      }
    });
    reconcile.immediate();
  }

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
      return transaction.immediate(() => {
        const pendingRow = db
          .query(
            "SELECT retry_until_ms FROM adhoc_creation_events WHERE source_hash = ? AND successful = 0 AND retry_until_ms IS NOT NULL AND occurred_at_ms > ? ORDER BY occurred_at_ms DESC LIMIT 1",
          )
          .get(sourceHash, nowMs - AD_HOC_CREATION_GLOBAL_WINDOW_MS) as {
          retry_until_ms?: number | string;
        } | null;
        const pendingUntilMs = Number(pendingRow?.retry_until_ms ?? 0);
        if (pendingUntilMs > nowMs) {
          return { status: "rate-limited", retryAfterMs: pendingUntilMs - nowMs } as const;
        }
        const sourceCountRow = db
          .query(
            "SELECT COUNT(*) AS count FROM adhoc_creation_events WHERE source_hash = ? AND successful = 1 AND occurred_at_ms > ?",
          )
          .get(sourceHash, nowMs - AD_HOC_CREATION_SOURCE_WINDOW_MS) as {
          count?: number | string;
        } | null;
        const sourceCount = Number(sourceCountRow?.count ?? 0);
        const expiredPendingDelay = pendingUntilMs > 0 && pendingUntilMs <= nowMs;
        if (sourceCount >= AD_HOC_MAX_CREATIONS_PER_SOURCE && !expiredPendingDelay) {
          const retryAfterMs = adHocCreationDelayMs(sourceCount);
          db.run(
            "INSERT INTO adhoc_creation_events (source_hash, successful, occurred_at_ms, retry_until_ms) VALUES (?, 0, ?, ?)",
            [sourceHash, nowMs, nowMs + retryAfterMs],
          );
          return {
            status: "rate-limited",
            retryAfterMs,
          } as const;
        }
        const globalCountRow = db
          .query(
            "SELECT COUNT(*) AS count FROM adhoc_creation_events WHERE successful = 1 AND occurred_at_ms > ?",
          )
          .get(nowMs - AD_HOC_CREATION_GLOBAL_WINDOW_MS) as {
          count?: number | string;
        } | null;
        const globalCount = Number(globalCountRow?.count ?? 0);
        if (globalCount >= AD_HOC_MAX_CREATIONS_PER_HOUR) {
          const firstSuccessRow = db
            .query(
              "SELECT MIN(occurred_at_ms) AS occurred_at_ms FROM adhoc_creation_events WHERE successful = 1 AND occurred_at_ms > ?",
            )
            .get(nowMs - AD_HOC_CREATION_GLOBAL_WINDOW_MS) as {
            occurred_at_ms?: number | string;
          } | null;
          const retryAfterMs = Math.max(
            1_000,
            Number(firstSuccessRow?.occurred_at_ms ?? nowMs) +
              AD_HOC_CREATION_GLOBAL_WINDOW_MS -
              nowMs,
          );
          db.run(
            "INSERT INTO adhoc_creation_events (source_hash, successful, occurred_at_ms, retry_until_ms) VALUES (?, 0, ?, ?)",
            [sourceHash, nowMs, nowMs + retryAfterMs],
          );
          return {
            status: "rate-limited",
            retryAfterMs,
          } as const;
        }
        const countRow = db.query("SELECT COUNT(*) AS count FROM adhoc_games").get() as {
          count?: number | string;
        } | null;
        const count = Number(countRow?.count ?? 0);
        let removedGameId: string | null = null;
        if (count >= AD_HOC_MAX_RETAINED_GAMES) {
          const victim = db
            .query(`SELECT game_id FROM adhoc_games WHERE environment_identity = ? AND NOT EXISTS (
            SELECT 1 FROM json_each(sessions_json) AS session
            WHERE json_extract(session.value, '$.connected') = 1
               OR COALESCE(
                    json_extract(session.value, '$.lastDisconnectedAtMs'),
                    json_extract(session.value, '$.lastConnectedAtMs')
                  ) > ?
          ) ORDER BY created_at_ms ASC, game_id ASC LIMIT 1`)
            .get(game.environmentIdentity, nowMs - AD_HOC_DISCONNECTED_GRACE_MS) as {
            game_id?: string;
          } | null;
          if (victim?.game_id === undefined) return "capacity" as const;
          options.beforeCapacityCommit?.();
          db.run("DELETE FROM adhoc_games WHERE game_id = ? AND environment_identity = ?", [
            victim.game_id,
            game.environmentIdentity,
          ]);
          removedGameId = victim.game_id;
        }
        db.run("DELETE FROM adhoc_creation_events WHERE occurred_at_ms <= ?", [
          nowMs - AD_HOC_CREATION_GLOBAL_WINDOW_MS,
        ]);
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
          "INSERT INTO adhoc_creation_events (source_hash, successful, occurred_at_ms, retry_until_ms) VALUES (?, 1, ?, NULL)",
          [sourceHash, nowMs],
        );
        return { status: "accepted", removedGameId } as const;
      }) as ReturnType<AdHocStore["createGame"]>;
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

function isCleanupEligible(session: StoredSession, nowMs: number): boolean {
  if (session.connected) return false;
  const lastEvidenceMs = session.lastDisconnectedAtMs ?? session.lastConnectedAtMs;
  return lastEvidenceMs <= nowMs - AD_HOC_DISCONNECTED_GRACE_MS;
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

function fromControllerOperation(
  operation: ControllerSynchronizationOperation<GameCommand>,
): AdHocOperation {
  return {
    id: operation.operationId,
    workflow: "ad-hoc",
    clientSentAtMs: operation.clientOriginAtMs,
    causalPredecessorIds: [...operation.causalPredecessorIds],
    command: operation.payload,
  };
}

function orderReplayPlan(
  operations: readonly ControllerSynchronizationOperation<GameCommand>[],
): readonly ControllerSynchronizationOperation<GameCommand>[] {
  const byId = new Map(operations.map((operation) => [operation.operationId, operation]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const operation of operations) {
    const retainedPredecessors = operation.causalPredecessorIds.filter((id) => byId.has(id));
    indegree.set(operation.operationId, retainedPredecessors.length);
    for (const predecessor of retainedPredecessors) {
      dependents.set(predecessor, [...(dependents.get(predecessor) ?? []), operation.operationId]);
    }
  }
  const compare = (
    left: ControllerSynchronizationOperation<GameCommand>,
    right: ControllerSynchronizationOperation<GameCommand>,
  ) =>
    left.clientOriginAtMs - right.clientOriginAtMs ||
    left.operationId.localeCompare(right.operationId);
  const ready = operations
    .filter((operation) => indegree.get(operation.operationId) === 0)
    .sort(compare);
  const ordered: ControllerSynchronizationOperation<GameCommand>[] = [];
  while (ready.length > 0) {
    const operation = ready.shift();
    if (operation === undefined) break;
    ordered.push(operation);
    for (const dependentId of dependents.get(operation.operationId) ?? []) {
      const nextIndegree = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, nextIndegree);
      if (nextIndegree === 0) {
        const dependent = byId.get(dependentId);
        if (dependent !== undefined) ready.push(dependent);
        ready.sort(compare);
      }
    }
  }
  const orderedIds = new Set(ordered.map((operation) => operation.operationId));
  return [...ordered, ...operations.filter((operation) => !orderedIds.has(operation.operationId))];
}

function reconcilePreparedReplayChunk(
  entries: readonly PreparedReplayEntry[],
  retainedOperations: Readonly<Record<string, StoredOperation>>,
): PreparedReplayEntry[] {
  const statuses = new Map(
    Object.entries(retainedOperations).map(([operationId, operation]) => [
      operationId,
      operation.status,
    ]),
  );
  return entries.map((entry) => {
    const existing = retainedOperations[entry.operation.operationId];
    if (existing !== undefined) {
      statuses.set(entry.operation.operationId, existing.status);
      return entry;
    }
    let status = entry.status;
    let detail = entry.detail;
    if (
      status === "accepted" &&
      entry.operation.causalPredecessorIds.some(
        (predecessorId) =>
          statuses.get(predecessorId) !== undefined && statuses.get(predecessorId) !== "accepted",
      )
    ) {
      status = "causally-blocked";
      detail = "Causal predecessor was rejected.";
    }
    statuses.set(entry.operation.operationId, status === "duplicate" ? "rejected" : status);
    return { ...entry, status, ...(detail === undefined ? {} : { detail }) };
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
