import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createPersistedControllerSession,
  getControllerSessionStorageKey,
  parsePersistedControllerSession,
} from "@/lib/controller-session";
import { applyGameCommand } from "@/lib/game-engine";
import type {
  ControllerRole,
  GameCommand,
  GameState,
  GameView,
  PlayerPenaltyState,
  TeamId,
} from "@/lib/game-types";
import type { ClientCommandEnvelope, ServerWsMessage } from "@/lib/ws-protocol";

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
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [pendingCommandsCount, setPendingCommandsCount] = useState(0);
  const [localOnlyMode, setLocalOnlyMode] = useState(false);

  const pendingRef = useRef<ClientCommandEnvelope[]>([]);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const commandCounterRef = useRef(0);
  const clientInstanceId = useRef(crypto.randomUUID());
  const subscribedToServerGameRef = useRef(false);
  const localOnlyModeRef = useRef(false);

  const setLocalOnlyState = useCallback((value: boolean) => {
    localOnlyModeRef.current = value;
    setLocalOnlyMode(value);
  }, []);

  const setPendingCommands = useCallback((commands: ClientCommandEnvelope[]) => {
    pendingRef.current = commands;
    setPendingCommandsCount(commands.length);
  }, []);

  const persistControllerSession = useCallback(
    (state: GameState, pendingCommands: ClientCommandEnvelope[], commandCounter: number) => {
      if (role !== "controller") {
        return;
      }

      savePersistedControllerSession({
        gameId,
        state,
        pendingCommands,
        commandCounter,
      });
    },
    [gameId, role],
  );

  const flushPendingCommands = useCallback(() => {
    if (role !== "controller") {
      return;
    }

    if (localOnlyModeRef.current) {
      return;
    }

    if (!subscribedToServerGameRef.current) {
      return;
    }

    const ws = wsRef.current;
    if (ws === null || ws.readyState !== WebSocket.OPEN || pendingRef.current.length === 0) {
      return;
    }

    ws.send(
      JSON.stringify({
        type: "apply-commands",
        gameId,
        commands: pendingRef.current,
      }),
    );
  }, [gameId, role]);

  const reconcileWithServer = useCallback(
    ({
      state,
      serverNowMs,
      ackedCommandIds,
    }: {
      state: GameState;
      serverNowMs: number;
      ackedCommandIds: string[];
    }) => {
      if (ackedCommandIds.length > 0) {
        const ackedSet = new Set(ackedCommandIds);
        setPendingCommands(pendingRef.current.filter((command) => !ackedSet.has(command.id)));
      }

      setClockOffsetMs(serverNowMs - Date.now());

      let reconciled = state;

      for (const command of pendingRef.current) {
        reconciled = applyLocalEnvelope(reconciled, command);
      }

      setBaseState(reconciled);
      persistControllerSession(reconciled, pendingRef.current, commandCounterRef.current);
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
        setPendingCommands(persisted.pendingCommands);
        commandCounterRef.current = Math.max(commandCounterRef.current, persisted.commandCounter);
        setBaseState(persisted.state);
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
            return;
          }

          setError("Game not found.");
          return;
        }

        const payload = (await response.json()) as { game?: GameView };
        if (!cancelled && payload.game !== undefined) {
          setError(null);

          let reconciled = payload.game.state;
          for (const command of pendingRef.current) {
            reconciled = applyLocalEnvelope(reconciled, command);
          }

          setLocalOnlyState(false);
          setBaseState(reconciled);
          persistControllerSession(reconciled, pendingRef.current, commandCounterRef.current);
        }
      } catch {
        if (!cancelled) {
          if (role === "controller" && recoveredFromLocal) {
            setError("Unable to reach server. Continuing locally on this device.");
            return;
          }

          setError("Unable to fetch game snapshot.");
        }
      }
    };

    const connect = () => {
      if (cancelled) {
        return;
      }

      if (localOnlyModeRef.current) {
        setConnectionState("local-only");
      } else {
        setConnectionState("connecting");
      }

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      subscribedToServerGameRef.current = false;

      ws.onopen = () => {
        if (!localOnlyModeRef.current) {
          setConnectionState("online");
        }

        ws.send(
          JSON.stringify({
            type: "subscribe-game",
            gameId,
            role,
          }),
        );
      };

      ws.onmessage = (event) => {
        const parsed = parseServerMessage(event.data);
        if (parsed === null) {
          return;
        }

        if (parsed.type === "error") {
          if (role === "controller" && isServerGameUnavailableError(parsed.message)) {
            subscribedToServerGameRef.current = false;
            setLocalOnlyState(true);
            setConnectionState("local-only");
            setError(LOCAL_ONLY_MESSAGE);
            ws.close();
            return;
          }

          setError(parsed.message);
          return;
        }

        if (parsed.type === "game-snapshot") {
          subscribedToServerGameRef.current = true;
          setLocalOnlyState(false);
          setConnectionState("online");
          setError(null);
          reconcileWithServer({
            state: parsed.game.state,
            serverNowMs: parsed.serverNowMs,
            ackedCommandIds: parsed.ackedCommandIds,
          });
          flushPendingCommands();
        }
      };

      ws.onclose = () => {
        if (localOnlyModeRef.current) {
          setConnectionState("local-only");
        } else {
          setConnectionState("offline");
        }

        wsRef.current = null;
        subscribedToServerGameRef.current = false;
        if (!cancelled) {
          const retryDelay = localOnlyModeRef.current
            ? LOCAL_ONLY_RETRY_DELAY_MS
            : NORMAL_RECONNECT_DELAY_MS;
          reconnectTimeoutRef.current = window.setTimeout(connect, retryDelay);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    void fetchInitialSnapshot();
    connect();

    return () => {
      cancelled = true;
      subscribedToServerGameRef.current = false;
      if (wsRef.current !== null) {
        wsRef.current.close();
      }
      if (reconnectTimeoutRef.current !== null) {
        window.clearTimeout(reconnectTimeoutRef.current);
      }
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
      if (role !== "controller") {
        return;
      }

      setBaseState((previous) => {
        if (previous === null) {
          return previous;
        }

        commandCounterRef.current += 1;
        const envelope: ClientCommandEnvelope = {
          id: `${clientInstanceId.current}-${commandCounterRef.current}`,
          clientSentAtMs: Date.now() + clockOffsetMs,
          command,
        };

        const nextPendingCommands = [...pendingRef.current, envelope];
        setPendingCommands(nextPendingCommands);
        const next = applyLocalEnvelope(previous, envelope);
        persistControllerSession(next, nextPendingCommands, commandCounterRef.current);

        window.setTimeout(flushPendingCommands, 0);

        return next;
      });
    },
    [clockOffsetMs, flushPendingCommands, persistControllerSession, role, setPendingCommands],
  );

  return {
    baseState,
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
    message === "Game not found." ||
    message === "Not subscribed to a game." ||
    message === "Command gameId mismatch."
  );
}

function loadPersistedControllerSession(gameId: string) {
  try {
    const raw = window.localStorage.getItem(getControllerSessionStorageKey(gameId));
    if (raw === null) {
      return null;
    }

    return parsePersistedControllerSession(raw, gameId);
  } catch {
    return null;
  }
}

function savePersistedControllerSession({
  gameId,
  state,
  pendingCommands,
  commandCounter,
}: {
  gameId: string;
  state: GameState;
  pendingCommands: ClientCommandEnvelope[];
  commandCounter: number;
}) {
  try {
    const payload = createPersistedControllerSession({
      gameId,
      state,
      pendingCommands,
      commandCounter,
      savedAtMs: Date.now(),
    });

    window.localStorage.setItem(getControllerSessionStorageKey(gameId), JSON.stringify(payload));
  } catch {
    // Best-effort persistence only; keep runtime behavior even if storage is unavailable.
  }
}

function applyLocalEnvelope(state: GameState, envelope: ClientCommandEnvelope): GameState {
  let idCounter = 0;
  return applyGameCommand({
    state,
    command: envelope.command,
    nowMs: envelope.clientSentAtMs,
    idGenerator: () => {
      idCounter += 1;
      return `${envelope.id}:${idCounter}`;
    },
  });
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
