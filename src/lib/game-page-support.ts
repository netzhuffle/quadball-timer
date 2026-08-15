import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getAdHocControllerSessionStorageKey,
  parseAdHocControllerSession,
  serializeAdHocControllerSession,
  type AdHocPendingOperation,
} from "@/lib/ad-hoc-controller-session";
import { applyGameCommand } from "@/lib/game-engine";
import type {
  ControllerRole,
  GameCommand,
  GameState,
  GameView,
  PlayerPenaltyState,
  TeamId,
} from "@/lib/game-types";
import { orderControllerOperations } from "@/lib/controller-synchronization";
import type { ServerWsMessage } from "@/lib/ws-protocol";

export type ConnectionState = "connecting" | "online" | "offline" | "local-only";
export type PendingReleaseAction = {
  pendingId: string;
  reason: "score" | "flag-catch";
  expireMs: number;
};

export const LOCAL_ONLY_MESSAGE =
  "Server does not know this game. Continuing locally on this device.";
const NORMAL_RECONNECT_DELAY_MS = 1_000;
const LOCAL_ONLY_RETRY_DELAY_MS = 60_000;
export const ONE_MINUTE_MS = 60_000;
export const SEEKER_RELEASE_MS = 20 * ONE_MINUTE_MS;
export const SEEKER_STATUS_SHOW_FROM_MS = 18 * ONE_MINUTE_MS;
export const SEEKER_STATUS_HIDE_AFTER_MS = 21 * ONE_MINUTE_MS;
export const FLAG_RELEASE_MS = 19 * ONE_MINUTE_MS;
export const FLAG_STATUS_SHOW_FROM_MS = 18 * ONE_MINUTE_MS;
export const FLAG_STATUS_HIDE_AFTER_MS = FLAG_RELEASE_MS + 30_000;
const RELEASE_EVENT_VISIBLE_MS = 30_000;

export function useGameConnection({ gameId, role }: { gameId: string; role: ControllerRole }) {
  const wsUrl = useMemo(createWebSocketUrl, []);
  const [baseState, setBaseState] = useState<GameState | null>(null);
  const authoritativeStateRef = useRef<GameState | null>(null);
  const [controlQr, setControlQr] = useState<string | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [pendingCommandsCount, setPendingCommandsCount] = useState(0);
  const [localOnlyMode, setLocalOnlyMode] = useState(false);
  const pendingRef = useRef<AdHocPendingOperation[]>([]);
  const outcomesRef = useRef<AdHocControllerOutcomes>({});
  const reconnectTimeoutRef = useRef<number | null>(null);
  const replayRetryTimeoutRef = useRef<number | null>(null);
  const replayInFlightRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const commandCounterRef = useRef(0);
  const clientInstanceId = useRef(crypto.randomUUID());
  const subscribedToServerGameRef = useRef(false);
  const localOnlyModeRef = useRef(false);

  const setLocalOnlyState = useCallback((value: boolean) => {
    localOnlyModeRef.current = value;
    setLocalOnlyMode(value);
  }, []);
  const setPendingCommands = useCallback((commands: AdHocPendingOperation[]) => {
    pendingRef.current = commands;
    setPendingCommandsCount(commands.length);
  }, []);
  const persistControllerSession = useCallback(
    (state: GameState, pendingOperations: AdHocPendingOperation[], operationCounter: number) => {
      if (role !== "controller") return;
      try {
        window.localStorage.setItem(
          getAdHocControllerSessionStorageKey(gameId),
          serializeAdHocControllerSession({
            version: "ad-hoc-controller-session-v1",
            workflow: "ad-hoc",
            gameId,
            state,
            authoritativeState: authoritativeStateRef.current ?? state,
            pendingOperations,
            outcomes: outcomesRef.current,
            operationCounter,
            savedAtMs: Date.now(),
          }),
        );
      } catch {
        // Keep the in-memory replica useful when browser storage is unavailable.
      }
    },
    [gameId, role],
  );
  const flushPendingCommands = useCallback(() => {
    if (
      role !== "controller" ||
      localOnlyModeRef.current ||
      !subscribedToServerGameRef.current ||
      wsRef.current?.readyState !== WebSocket.OPEN ||
      replayInFlightRef.current ||
      pendingRef.current.length === 0
    )
      return;
    replayInFlightRef.current = true;
    wsRef.current.send(
      JSON.stringify({
        type: "apply-commands",
        gameId,
        commands: pendingRef.current.slice(0, 100),
      }),
    );
  }, [gameId, role]);
  const reconcileWithServer = useCallback(
    ({
      state,
      serverNowMs,
      ackedCommandIds,
      operationOutcomes = [],
    }: {
      state: GameState;
      serverNowMs: number;
      ackedCommandIds: string[];
      operationOutcomes?: readonly AdHocOutcome[];
    }) => {
      for (const outcome of operationOutcomes)
        outcomesRef.current[outcome.operationId] = outcome.status;
      const settled = new Set([
        ...ackedCommandIds,
        ...operationOutcomes.map((outcome) => outcome.operationId),
      ]);
      const pending = pendingRef.current.filter((operation) => !settled.has(operation.id));
      setPendingCommands(pending);
      setClockOffsetMs(serverNowMs - Date.now());
      authoritativeStateRef.current = state;
      const reconciled = applyPendingOperations(state, pending, outcomesRef.current);
      setBaseState(reconciled);
      persistControllerSession(reconciled, pending, commandCounterRef.current);
    },
    [persistControllerSession, setPendingCommands],
  );

  useEffect(() => {
    let cancelled = false;
    let recoveredFromLocal = false;
    if (role === "controller") {
      const persisted = loadPersistedControllerSession(gameId);
      if (persisted !== null) {
        recoveredFromLocal = true;
        setPendingCommands(persisted.pendingOperations);
        outcomesRef.current = persisted.outcomes;
        commandCounterRef.current = persisted.operationCounter;
        authoritativeStateRef.current = persisted.authoritativeState ?? persisted.state;
        setBaseState(
          applyPendingOperations(
            authoritativeStateRef.current,
            persisted.pendingOperations,
            persisted.outcomes,
          ),
        );
        setConnectionState("offline");
        setError("Recovered local game state. Reconnecting server...");
      }
    }
    const fetchInitialSnapshot = async () => {
      try {
        const response = await fetch(`/api/games/${gameId}`);
        if (!response.ok) {
          if (role === "controller" && recoveredFromLocal) {
            setLocalOnlyState(true);
            setConnectionState("local-only");
            setError(LOCAL_ONLY_MESSAGE);
          } else setError("Ad Hoc Game unavailable.");
          return;
        }
        const payload = (await response.json()) as {
          game?: GameView & { controlQr?: string | null };
        };
        if (!cancelled && payload.game !== undefined) {
          setError(null);
          setControlQr(payload.game.controlQr ?? null);
          authoritativeStateRef.current = payload.game.state;
          const reconciled = applyPendingOperations(
            authoritativeStateRef.current,
            pendingRef.current,
            outcomesRef.current,
          );
          setLocalOnlyState(false);
          setBaseState(reconciled);
          persistControllerSession(reconciled, pendingRef.current, commandCounterRef.current);
        }
      } catch {
        if (!cancelled) {
          if (role === "controller" && recoveredFromLocal)
            setError("Unable to reach server. Continuing locally on this device.");
          else setError("Ad Hoc Game unavailable.");
        }
      }
    };
    const connect = () => {
      if (cancelled) return;
      setConnectionState(localOnlyModeRef.current ? "local-only" : "connecting");
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      subscribedToServerGameRef.current = false;
      ws.onopen = () => {
        if (!localOnlyModeRef.current) setConnectionState("online");
        ws.send(JSON.stringify({ type: "subscribe-game", gameId }));
      };
      ws.onmessage = (event) => {
        const parsed = parseServerMessage(event.data);
        if (parsed === null) return;
        if (parsed.type === "error") {
          replayInFlightRef.current = false;
          if (role === "controller" && isServerGameUnavailableError(parsed.message)) {
            subscribedToServerGameRef.current = false;
            setLocalOnlyState(true);
            setConnectionState("local-only");
            setError(LOCAL_ONLY_MESSAGE);
            ws.close();
          } else if (parsed.retryAfterMs !== undefined) {
            const delayMs = Math.min(30_000, Math.max(1, parsed.retryAfterMs));
            replayInFlightRef.current = false;
            if (!subscribedToServerGameRef.current) {
              if (reconnectTimeoutRef.current !== null)
                window.clearTimeout(reconnectTimeoutRef.current);
              reconnectTimeoutRef.current = window.setTimeout(() => {
                reconnectTimeoutRef.current = null;
                connect();
              }, delayMs);
              setError(`Ad Hoc connection busy. Retrying in ${Math.ceil(delayMs / 1_000)}s.`);
              ws.close(1013, "Ad Hoc subscription retry.");
              return;
            }
            if (replayRetryTimeoutRef.current !== null)
              window.clearTimeout(replayRetryTimeoutRef.current);
            setError(`Ad Hoc busy. Retrying in ${Math.ceil(delayMs / 1_000)}s.`);
            replayRetryTimeoutRef.current = window.setTimeout(() => {
              replayRetryTimeoutRef.current = null;
              flushPendingCommands();
            }, delayMs);
          } else setError(parsed.message);
          return;
        }
        if (parsed.type === "game-snapshot") {
          replayInFlightRef.current = false;
          subscribedToServerGameRef.current = true;
          setLocalOnlyState(false);
          setConnectionState("online");
          setError(null);
          setControlQr(parsed.game.controlQr ?? null);
          reconcileWithServer({
            state: parsed.game.state,
            serverNowMs: parsed.serverNowMs,
            ackedCommandIds: parsed.ackedCommandIds,
            operationOutcomes: parsed.operationOutcomes,
          });
          flushPendingCommands();
        }
      };
      ws.onclose = (event) => {
        replayInFlightRef.current = false;
        setConnectionState(localOnlyModeRef.current ? "local-only" : "offline");
        wsRef.current = null;
        subscribedToServerGameRef.current = false;
        if (event.code === 1013 && !cancelled) setError("Ad Hoc connection busy. Retrying in 1s.");
        if (!cancelled && reconnectTimeoutRef.current === null) {
          reconnectTimeoutRef.current = window.setTimeout(
            connect,
            localOnlyModeRef.current ? LOCAL_ONLY_RETRY_DELAY_MS : NORMAL_RECONNECT_DELAY_MS,
          );
        }
      };
      ws.onerror = () => {
        if (!cancelled && !localOnlyModeRef.current)
          setError("Ad Hoc connection busy. Retrying in 1s.");
        ws.close();
      };
    };
    void fetchInitialSnapshot();
    connect();
    return () => {
      cancelled = true;
      subscribedToServerGameRef.current = false;
      wsRef.current?.close();
      if (reconnectTimeoutRef.current !== null) window.clearTimeout(reconnectTimeoutRef.current);
      if (replayRetryTimeoutRef.current !== null)
        window.clearTimeout(replayRetryTimeoutRef.current);
    };
  }, [
    flushPendingCommands,
    gameId,
    persistControllerSession,
    reconcileWithServer,
    role,
    setLocalOnlyState,
    setPendingCommands,
    wsUrl,
  ]);

  const dispatchCommand = useCallback(
    (command: GameCommand) => {
      if (role !== "controller") return;
      setBaseState((previous) => {
        if (authoritativeStateRef.current === null && previous === null) return previous;
        commandCounterRef.current += 1;
        const operation: AdHocPendingOperation = {
          id: `${clientInstanceId.current}-${commandCounterRef.current}`,
          clientSentAtMs: Date.now() + clockOffsetMs,
          command,
          workflow: "ad-hoc",
          causalPredecessorIds: pendingRef.current.at(-1)?.id
            ? [pendingRef.current.at(-1)!.id]
            : [],
        };
        const pending = [...pendingRef.current, operation];
        setPendingCommands(pending);
        const authoritative = authoritativeStateRef.current ?? previous;
        if (authoritative === null) return previous;
        const next = applyPendingOperations(authoritative, pending, outcomesRef.current);
        persistControllerSession(next, pending, commandCounterRef.current);
        window.setTimeout(flushPendingCommands, 0);
        return next;
      });
    },
    [clockOffsetMs, flushPendingCommands, persistControllerSession, role, setPendingCommands],
  );
  return {
    baseState,
    controlQr,
    clockOffsetMs,
    dispatchCommand,
    connectionState,
    pendingCommands: pendingCommandsCount,
    error,
    localOnlyMode,
  };
}

export function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, intervalMs);

    return () => window.clearInterval(interval);
  }, [intervalMs]);

  return now;
}

function createWebSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function parseServerMessage(input: unknown): ServerWsMessage | null {
  if (typeof input !== "string") {
    return null;
  }

  try {
    return JSON.parse(input) as ServerWsMessage;
  } catch {
    return null;
  }
}

function isServerGameUnavailableError(message: string) {
  return (
    message === "Ad Hoc Game unavailable." ||
    message === "Game not found." ||
    message === "Not subscribed to a game." ||
    message === "Command gameId mismatch."
  );
}

function loadPersistedControllerSession(gameId: string) {
  try {
    const raw = window.localStorage.getItem(getAdHocControllerSessionStorageKey(gameId));
    if (raw === null) {
      return null;
    }

    const parsed = parseAdHocControllerSession(raw, gameId);
    if (parsed === null)
      window.localStorage.removeItem(getAdHocControllerSessionStorageKey(gameId));
    return parsed;
  } catch {
    try {
      window.localStorage.removeItem(getAdHocControllerSessionStorageKey(gameId));
    } catch {
      /* best effort */
    }
    return null;
  }
}

type AdHocOutcome = {
  operationId: string;
  workflow: "ad-hoc" | "event";
  status: "accepted" | "duplicate" | "rejected" | "causally-blocked";
  detail?: string;
};
type AdHocControllerOutcomes = Record<string, AdHocOutcome["status"]>;

function applyPendingOperations(
  state: GameState,
  pending: readonly AdHocPendingOperation[],
  outcomes: Readonly<AdHocControllerOutcomes>,
): GameState {
  const pendingIds = new Set(pending.map((operation) => operation.id));
  const operations = pending
    .filter((operation) => outcomes[operation.id] === undefined)
    .filter((operation) =>
      operation.causalPredecessorIds.every((predecessor) => {
        if (pendingIds.has(predecessor)) return true;
        const outcome = outcomes[predecessor];
        return outcome === "accepted" || outcome === "duplicate";
      }),
    )
    .map((operation) => ({
      operationId: operation.id,
      workflow: "ad-hoc" as const,
      clientOriginAtMs: operation.clientSentAtMs,
      causalPredecessorIds: operation.causalPredecessorIds.filter((predecessor) =>
        pendingIds.has(predecessor),
      ),
      payload: operation.command,
    }));
  const ordered = orderControllerOperations(operations);
  if (!ordered.ok) return state;
  return ordered.operations.reduce((current, operation) => {
    let generated = 0;
    return applyGameCommand({
      state: current,
      command: operation.payload,
      nowMs: operation.clientOriginAtMs,
      idGenerator: () => `${operation.operationId}:${++generated}`,
    });
  }, state);
}

export function deriveAdHocOptimisticState(
  authoritative: GameState,
  pending: readonly AdHocPendingOperation[],
  outcomes: Readonly<AdHocControllerOutcomes> = {},
) {
  return applyPendingOperations(authoritative, pending, outcomes);
}

export function navigateTo(path: string) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function willFlagCatchWin(state: GameState, team: TeamId) {
  const opposingTeam = team === "home" ? "away" : "home";
  return state.score[team] + 30 > state.score[opposingTeam];
}

export function formatFinishReason(reason: GameState["finishReason"]) {
  switch (reason) {
    case "forfeit":
      return "forfeit";
    case "double-forfeit":
      return "double forfeit";
    case "flag-catch":
      return "flag catch";
    case "target-score":
      return "target score";
    case "concede":
      return "concession";
    default:
      return "result";
  }
}

export function formatClock(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatRemaining(ms: number) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1_000));

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatPenaltySlice(ms: number) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export type PlayerPenaltyView = {
  playerKey: string;
  label: string;
  remaining: string;
  remainingMs: number;
  highlight: boolean;
};

export type ReleasedPenaltyView = {
  id: string;
  label: string;
  releasedAtMs: number;
  remainingMs: number;
};

export function getTeamPenalties(
  state: GameState | null | undefined,
  team: TeamId,
): PlayerPenaltyView[] {
  if (state === undefined || state === null) {
    return [];
  }

  return Object.values(state.players)
    .filter((player) => player.team === team)
    .map((player) => {
      const remainingMs = player.segments.reduce(
        (total, segment) => total + segment.remainingMs,
        0,
      );

      return {
        playerKey: player.key,
        label: formatPlayerLabel(player),
        remaining: formatRemaining(remainingMs),
        remainingMs,
        highlight: remainingMs > 0 && remainingMs <= 10_000,
      };
    })
    .sort((a, b) => a.remainingMs - b.remainingMs || a.label.localeCompare(b.label));
}

export function selectVisiblePenalties(
  penalties: PlayerPenaltyView[],
  pendingReleaseByPlayer: Record<string, PendingReleaseAction[]>,
  limit: number,
) {
  const pendingFirst = penalties.filter((entry) => {
    const pending = pendingReleaseByPlayer[entry.playerKey];
    return pending !== undefined && pending.length > 0;
  });
  const normal = penalties.filter((entry) => {
    const pending = pendingReleaseByPlayer[entry.playerKey];
    return pending === undefined || pending.length === 0;
  });

  return [...pendingFirst, ...normal].slice(0, limit);
}

export function hasServingPenalty(player: PlayerPenaltyState | null | undefined) {
  if (player === null || player === undefined) {
    return false;
  }

  return player.segments.some((segment) => segment.remainingMs > 0);
}

function willPendingReleaseNow(
  action: PendingReleaseAction,
  player: PlayerPenaltyState | null | undefined,
) {
  if (player === null || player === undefined) {
    return false;
  }

  const totalRemainingMs = player.segments.reduce(
    (total, segment) => total + Math.max(0, segment.remainingMs),
    0,
  );
  const expirableRemainingMs = player.segments.reduce(
    (total, segment) => total + (segment.expirableByScore ? Math.max(0, segment.remainingMs) : 0),
    0,
  );
  if (totalRemainingMs <= 0 || expirableRemainingMs <= 0) {
    return false;
  }

  const removedMs = Math.min(expirableRemainingMs, Math.max(0, action.expireMs));
  return totalRemainingMs - removedMs <= 0;
}

export function formatPendingReleaseActionLabel(
  action: PendingReleaseAction,
  player: PlayerPenaltyState | null | undefined,
) {
  const source = action.reason === "score" ? "Goal" : "Flag";
  if (willPendingReleaseNow(action, player)) {
    return `${source} release`;
  }

  return `${source} -${formatPenaltySlice(action.expireMs)}`;
}

export function getTeamRecentReleases(
  state: GameState | null | undefined,
  team: TeamId,
  nowMs: number,
): ReleasedPenaltyView[] {
  if (state === undefined || state === null) {
    return [];
  }

  const releases = Array.isArray(state.recentReleases) ? state.recentReleases : [];

  return releases
    .filter((entry) => entry.team === team)
    .map((entry): ReleasedPenaltyView | null => {
      const remainingMs = RELEASE_EVENT_VISIBLE_MS - Math.max(0, nowMs - entry.releasedAtMs);
      if (remainingMs <= 0) {
        return null;
      }

      return {
        id: entry.id,
        label:
          entry.playerNumber === null
            ? `Unknown (${entry.playerKey.split(":").slice(2).join(":") || "penalty"})`
            : `#${entry.playerNumber}`,
        releasedAtMs: entry.releasedAtMs,
        remainingMs,
      };
    })
    .filter((entry): entry is ReleasedPenaltyView => entry !== null)
    .sort((a, b) => b.releasedAtMs - a.releasedAtMs);
}

function formatPlayerLabel(player: PlayerPenaltyState | null | undefined) {
  if (player === null || player === undefined) {
    return "Unknown player";
  }

  if (player.playerNumber === null) {
    return `Unknown (${player.key.split(":").slice(2).join(":") || "penalty"})`;
  }

  return `#${player.playerNumber}`;
}
