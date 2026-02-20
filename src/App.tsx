import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Check,
  Clock3,
  CloudOff,
  Delete,
  Eye,
  Flag,
  Info,
  Minus,
  OctagonX,
  Pause,
  Play,
  Plus,
  Settings,
  Shield,
  TriangleAlert,
  UserX,
  Wifi,
  WifiOff,
} from "lucide-react";
import {
  createPersistedControllerSession,
  getControllerSessionStorageKey,
  parsePersistedControllerSession,
} from "@/lib/controller-session";
import { applyGameCommand, projectGameView } from "@/lib/game-engine";
import type {
  CardType,
  ControllerRole,
  GameCommand,
  GameState,
  GameSummary,
  GameView,
  PlayerPenaltyState,
  TeamId,
} from "@/lib/game-types";
import type { ClientCommandEnvelope, ServerWsMessage } from "@/lib/ws-protocol";
import "./index.css";

type Route =
  | {
      type: "home";
    }
  | {
      type: "game";
      gameId: string;
      role: ControllerRole;
    };

type ConnectionState = "connecting" | "online" | "offline" | "local-only";
type PendingReleaseAction = {
  pendingId: string;
  reason: "score" | "flag-catch";
  expireMs: number;
};

const LOCAL_ONLY_MESSAGE = "Server does not know this game. Continuing locally on this device.";
const NORMAL_RECONNECT_DELAY_MS = 1_000;
const LOCAL_ONLY_RETRY_DELAY_MS = 60_000;
const ONE_MINUTE_MS = 60_000;
const SEEKER_RELEASE_MS = 20 * ONE_MINUTE_MS;
const SEEKER_STATUS_SHOW_FROM_MS = 18 * ONE_MINUTE_MS;
const SEEKER_STATUS_HIDE_AFTER_MS = 21 * ONE_MINUTE_MS;
const RELEASE_EVENT_VISIBLE_MS = 30_000;

export function App() {
  const route = useRoute();

  if (route.type === "home") {
    return <HomePage />;
  }

  return <GamePage gameId={route.gameId} role={route.role} />;
}

function HomePage() {
  const nowMs = useNow(500);
  const [games, setGames] = useState<GameSummary[]>([]);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [homeName, setHomeName] = useState("Home");
  const [awayName, setAwayName] = useState("Away");
  const reconnectTimeoutRef = useRef<number | null>(null);

  const wsUrl = useMemo(createWebSocketUrl, []);

  useEffect(() => {
    let cancelled = false;
    let currentWs: WebSocket | null = null;

    const fetchGames = async () => {
      try {
        const response = await fetch("/api/games");
        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as { games?: GameSummary[] };
        if (!cancelled && Array.isArray(payload.games)) {
          setGames(payload.games);
        }
      } catch {
        // Ignore startup fetch errors; websocket reconnect handles updates.
      }
    };

    const connect = () => {
      if (cancelled) {
        return;
      }

      setConnectionState("connecting");
      const ws = new WebSocket(wsUrl);
      currentWs = ws;

      ws.onopen = () => {
        setConnectionState("online");
        ws.send(JSON.stringify({ type: "subscribe-lobby" }));
      };

      ws.onmessage = (event) => {
        const parsed = parseServerMessage(event.data);
        if (parsed === null || parsed.type !== "lobby-snapshot") {
          return;
        }

        setClockOffsetMs(parsed.serverNowMs - Date.now());
        setGames(parsed.games);
      };

      ws.onclose = () => {
        setConnectionState("offline");
        if (!cancelled) {
          reconnectTimeoutRef.current = window.setTimeout(connect, 1_000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    void fetchGames();
    connect();

    return () => {
      cancelled = true;
      currentWs?.close();
      if (reconnectTimeoutRef.current !== null) {
        window.clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [wsUrl]);

  const nowWithOffsetMs = nowMs + clockOffsetMs;

  const handleCreateGame = useCallback(async () => {
    const response = await fetch("/api/games", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        homeName,
        awayName,
      }),
    });

    if (!response.ok) {
      return;
    }

    const payload = (await response.json()) as { gameId?: string };
    if (typeof payload.gameId === "string") {
      navigateTo(`/game/${payload.gameId}?mode=controller`);
    }
  }, [awayName, homeName]);

  return (
    <div className="mx-auto w-full max-w-5xl p-4 pb-12 sm:p-6">
      <header className="mb-6 rounded-2xl border bg-card/80 p-5 shadow-sm backdrop-blur">
        <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
          Quadball Timer
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Live Scorekeeper + Timekeeper
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Mobile-first control for game time, scores, cards, penalty timers, and spectator sync.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-[1fr_2fr]">
        <Card>
          <CardHeader>
            <CardTitle>Create Game</CardTitle>
            <CardDescription>The creator joins in controller mode.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="home-name">Home team</Label>
              <Input
                id="home-name"
                value={homeName}
                onChange={(event) => setHomeName(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="away-name">Away team</Label>
              <Input
                id="away-name"
                value={awayName}
                onChange={(event) => setAwayName(event.target.value)}
              />
            </div>
            <Button className="w-full" onClick={handleCreateGame}>
              Create new game
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Running and Past Games</CardTitle>
            <CardDescription>
              {connectionState === "online"
                ? "Live updates connected"
                : "Reconnecting live updates"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {games.length === 0 ? (
              <p className="text-sm text-muted-foreground">No games yet.</p>
            ) : (
              games.map((game) => {
                const displayClock = deriveLiveClockMs(game, nowWithOffsetMs);

                return (
                  <div
                    key={game.id}
                    className="rounded-xl border bg-background/80 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold">
                          {game.homeName} vs {game.awayName}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {game.isFinished ? "Past" : "Running"} • {formatClock(displayClock)}
                        </p>
                      </div>
                      <p className="text-lg font-semibold tabular-nums">
                        {game.score.home}:{game.score.away}
                      </p>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => navigateTo(`/game/${game.id}?mode=spectator`)}
                      >
                        Spectate
                      </Button>
                      {!game.isFinished ? (
                        <Button
                          size="sm"
                          onClick={() => navigateTo(`/game/${game.id}?mode=controller`)}
                        >
                          Control
                        </Button>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function GamePage({ gameId, role }: { gameId: string; role: ControllerRole }) {
  const controller = role === "controller";
  const [activePanel, setActivePanel] = useState<"overview" | "card" | "timeout" | "admin">(
    "overview",
  );
  const [homeName, setHomeName] = useState("Home");
  const [awayName, setAwayName] = useState("Away");
  const [cardDraft, setCardDraft] = useState<{
    cardType: CardType | null;
    team: TeamId | null;
    digits: string;
    startedGameClockMs: number | null;
  }>({
    cardType: null,
    team: null,
    digits: "",
    startedGameClockMs: null,
  });
  const [clockAdjustOpen, setClockAdjustOpen] = useState(false);
  const [renamingTeam, setRenamingTeam] = useState<TeamId | null>(null);

  const nowMs = useNow(250);

  const {
    baseState,
    clockOffsetMs,
    dispatchCommand,
    connectionState,
    pendingCommands,
    error,
    localOnlyMode,
  } = useGameConnection({
    gameId,
    role,
  });

  useEffect(() => {
    if (baseState !== null) {
      if (renamingTeam === null) {
        setHomeName(baseState.homeName);
        setAwayName(baseState.awayName);
      }
    }
  }, [baseState, renamingTeam]);

  const syncedState = baseState;

  const gameView = useMemo(() => {
    if (syncedState === null) {
      return null;
    }

    return projectGameView(syncedState, nowMs + clockOffsetMs);
  }, [clockOffsetMs, nowMs, syncedState]);

  const liveState = gameView?.state ?? syncedState;

  const pendingExpirations = useMemo(
    () =>
      liveState?.pendingExpirations
        .filter((expiration) => expiration.resolvedAtMs === null)
        .sort((a, b) => a.createdAtMs - b.createdAtMs) ?? [],
    [liveState],
  );

  const homePenalties = useMemo(() => getTeamPenalties(liveState, "home"), [liveState]);
  const awayPenalties = useMemo(() => getTeamPenalties(liveState, "away"), [liveState]);

  const activeTimeout = gameView?.state.timeouts.active ?? null;
  const canRecordFlagCatch =
    controller &&
    gameView !== null &&
    !gameView.state.isRunning &&
    !gameView.state.isFinished &&
    gameView.seekerReleased &&
    gameView.state.flagCatch === null;
  const pendingCount = pendingExpirations.length;
  const pendingReleaseByPlayer = useMemo(() => {
    const byPlayer: Record<string, PendingReleaseAction[]> = {};

    if (liveState === null) {
      return byPlayer;
    }

    for (const pending of pendingExpirations) {
      for (const playerKey of pending.candidatePlayerKeys) {
        const player = liveState.players[playerKey];
        if (player === undefined || player.team !== pending.penalizedTeam) {
          continue;
        }

        byPlayer[playerKey] ??= [];
        byPlayer[playerKey]?.push({
          pendingId: pending.id,
          reason: pending.reason,
          expireMs: pending.expireMs,
        });
      }
    }

    return byPlayer;
  }, [liveState, pendingExpirations]);
  const unresolvedPendingExpirations = useMemo(
    () =>
      pendingExpirations.filter((pending) =>
        pending.candidatePlayerKeys.every(
          (playerKey) => liveState?.players[playerKey] === undefined,
        ),
      ),
    [liveState, pendingExpirations],
  );

  const submitCard = useCallback(() => {
    if (
      !controller ||
      cardDraft.cardType === null ||
      cardDraft.team === null ||
      liveState === null
    ) {
      return;
    }

    const playerNumber = cardDraft.digits.length === 0 ? null : Number(cardDraft.digits);
    dispatchCommand({
      type: "add-card",
      team: cardDraft.team,
      cardType: cardDraft.cardType,
      playerNumber,
      startedGameClockMs: cardDraft.startedGameClockMs ?? liveState.gameClockMs,
    });

    setCardDraft({
      cardType: null,
      team: null,
      digits: "",
      startedGameClockMs: null,
    });
  }, [cardDraft, controller, dispatchCommand, liveState]);

  const adjustGameClock = useCallback(
    (deltaMs: number) => {
      if (!controller) {
        return;
      }

      dispatchCommand({
        type: "adjust-game-clock",
        deltaMs,
      });
    },
    [controller, dispatchCommand],
  );

  const saveTeamRename = useCallback(() => {
    if (!controller) {
      return;
    }

    dispatchCommand({
      type: "rename-teams",
      homeName,
      awayName,
    });
    setRenamingTeam(null);
  }, [awayName, controller, dispatchCommand, homeName]);

  const wallNowMs = nowMs + clockOffsetMs;
  const homeRecentReleases = useMemo(
    () => getTeamRecentReleases(liveState, "home", wallNowMs),
    [liveState, wallNowMs],
  );
  const awayRecentReleases = useMemo(
    () => getTeamRecentReleases(liveState, "away", wallNowMs),
    [liveState, wallNowMs],
  );

  const appendCardDigit = useCallback((digit: string) => {
    setCardDraft((previous) => {
      if (previous.digits.length >= 2) {
        return previous;
      }

      return {
        ...previous,
        digits: `${previous.digits}${digit}`,
      };
    });
  }, []);

  if (gameView === null || liveState === null) {
    return (
      <div className="mx-auto flex min-h-screen w-full max-w-3xl items-center justify-center p-6">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Loading game</CardTitle>
            <CardDescription>Waiting for snapshot from server.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => navigateTo("/")}>
              Back to games
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const state = liveState;
  const recentCards = state.cardEvents.slice(-3).reverse();
  const visibleHomePenalties = selectVisiblePenalties(homePenalties, pendingReleaseByPlayer, 2);
  const visibleAwayPenalties = selectVisiblePenalties(awayPenalties, pendingReleaseByPlayer, 2);
  const activeTimeoutTeamName =
    activeTimeout === null ? null : activeTimeout.team === "home" ? state.homeName : state.awayName;
  const showSeekerStatus =
    state.gameClockMs >= SEEKER_STATUS_SHOW_FROM_MS &&
    state.gameClockMs <= SEEKER_STATUS_HIDE_AFTER_MS;
  const seekerRemainingMs = Math.max(0, SEEKER_RELEASE_MS - state.gameClockMs);
  const cardEntryStarted =
    cardDraft.cardType !== null ||
    cardDraft.team !== null ||
    cardDraft.digits.length > 0 ||
    cardDraft.startedGameClockMs !== null;
  const canSelectCardType =
    controller && !state.isFinished && (!state.isRunning || cardEntryStarted);
  const canSelectCardTeam = canSelectCardType && cardDraft.cardType !== null;
  const canEditCardDigits = canSelectCardTeam;
  const canSubmitCard =
    controller && !state.isFinished && cardDraft.cardType !== null && cardDraft.team !== null;
  const cardPlayerLabel = cardDraft.digits.length > 0 ? `#${cardDraft.digits}` : "No #";
  const cardBasePenaltyMs =
    cardDraft.cardType === "red"
      ? 2 * ONE_MINUTE_MS
      : cardDraft.cardType === "blue" || cardDraft.cardType === "yellow"
        ? ONE_MINUTE_MS
        : cardDraft.cardType === "ejection"
          ? 0
          : null;
  const elapsedCardEntryGameMs =
    cardDraft.startedGameClockMs === null
      ? 0
      : Math.max(0, state.gameClockMs - cardDraft.startedGameClockMs);
  const predictedCardRemainingMs =
    cardBasePenaltyMs === null ? null : Math.max(0, cardBasePenaltyMs - elapsedCardEntryGameMs);
  const selectedCardPlayerKey =
    cardDraft.team !== null && cardDraft.digits.length > 0
      ? `${cardDraft.team}:${Number(cardDraft.digits)}`
      : null;
  const selectedCardPlayer =
    selectedCardPlayerKey === null ? null : (state.players[selectedCardPlayerKey] ?? null);
  const selectedCardPlayerServingPenalty = hasServingPenalty(selectedCardPlayer);
  const cardAddStatusText =
    cardDraft.cardType === null || cardDraft.team === null
      ? "Remaining on add: --"
      : cardDraft.cardType === "ejection"
        ? "Remaining on add: n/a"
        : selectedCardPlayerServingPenalty
          ? `Adds on confirm: +${formatPenaltySlice(cardBasePenaltyMs ?? ONE_MINUTE_MS)}`
          : `Remaining on add: ${formatRemaining(predictedCardRemainingMs ?? ONE_MINUTE_MS)}${state.isRunning ? " (live)" : ""}`;
  const cardTypeOptions: Array<{
    type: CardType;
    label: string;
    icon: typeof Shield;
    activeClassName: string;
    idleClassName: string;
  }> = [
    {
      type: "blue",
      label: "Blue",
      icon: Shield,
      activeClassName: "border-sky-600 bg-sky-600 text-white",
      idleClassName: "border-sky-200 bg-sky-50 text-sky-800",
    },
    {
      type: "yellow",
      label: "Yellow",
      icon: TriangleAlert,
      activeClassName: "border-amber-500 bg-amber-500 text-white",
      idleClassName: "border-amber-200 bg-amber-50 text-amber-900",
    },
    {
      type: "red",
      label: "Red",
      icon: OctagonX,
      activeClassName: "border-rose-600 bg-rose-600 text-white",
      idleClassName: "border-rose-200 bg-rose-50 text-rose-800",
    },
    {
      type: "ejection",
      label: "Ejection",
      icon: UserX,
      activeClassName: "border-violet-600 bg-violet-600 text-white",
      idleClassName: "border-violet-200 bg-violet-50 text-violet-800",
    },
  ];

  return (
    <div className="h-[100dvh] overflow-hidden bg-background p-2">
      <div className="mx-auto grid h-full w-full max-w-[460px] grid-rows-[auto_auto_minmax(0,0.9fr)_minmax(0,1.1fr)_auto] gap-2">
        <section className="rounded-xl border bg-card px-3 py-2 shadow-sm">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-[11px] font-semibold">
                {state.homeName} vs {state.awayName}
              </p>
              <p className="text-[10px] text-muted-foreground">{role}</p>
            </div>
            <div className="flex items-center gap-1.5">
              {controller ? (
                localOnlyMode ? (
                  <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-1 text-[10px] font-semibold text-amber-800">
                    <CloudOff className="h-3 w-3" />
                    Local
                  </span>
                ) : connectionState !== "online" ? (
                  <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-1 text-[10px] font-semibold text-amber-800">
                    <WifiOff className="h-3 w-3" />
                    Offline {pendingCommands}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-2 py-1 text-[10px] font-semibold text-emerald-800">
                    <Wifi className="h-3 w-3" />
                    Live
                  </span>
                )
              ) : (
                <span className="inline-flex items-center gap-1 rounded bg-sky-100 px-2 py-1 text-[10px] font-semibold text-sky-800">
                  <Eye className="h-3 w-3" />
                  Read only
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => navigateTo("/")}
              >
                Games
              </Button>
            </div>
          </div>
          {controller ? (
            localOnlyMode ? (
              <p className="mt-1 text-[10px] font-medium text-amber-700">{LOCAL_ONLY_MESSAGE}</p>
            ) : connectionState !== "online" ? (
              <p className="mt-1 text-[10px] font-medium text-amber-700">
                Offline mode active. {pendingCommands} local change(s) queued.
              </p>
            ) : null
          ) : null}
        </section>

        <section className="rounded-xl border bg-card px-3 py-2 shadow-sm">
          <div className="grid grid-cols-[1fr_auto] items-center gap-2">
            <div>
              <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                {state.isFinished ? "Finished" : state.isRunning ? "Running" : "Paused"}
              </p>
              <button
                type="button"
                className="text-left"
                disabled={!controller}
                onClick={() => setClockAdjustOpen((previous) => !previous)}
              >
                <p className="text-[clamp(2.45rem,14vw,3.2rem)] leading-none font-semibold tabular-nums">
                  {formatClock(gameView.state.gameClockMs)}
                </p>
              </button>
              {controller ? (
                <p className="text-[10px] text-muted-foreground">Tap game time to adjust</p>
              ) : null}
            </div>
            <div>
              <Button
                size="lg"
                className="h-11 min-w-24 gap-1.5 text-base"
                onClick={() =>
                  dispatchCommand({
                    type: "set-running",
                    running: !state.isRunning,
                  })
                }
                disabled={!controller || state.isFinished}
              >
                {state.isRunning ? (
                  <>
                    <Pause className="h-4 w-4" />
                    Pause
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4" />
                    Play
                  </>
                )}
              </Button>
            </div>
          </div>
          {clockAdjustOpen && controller ? (
            <div className="mt-2 grid grid-cols-3 gap-1 text-[11px]">
              <Button
                size="sm"
                variant="outline"
                className="h-8 px-1"
                onClick={() => adjustGameClock(-60_000)}
              >
                -1m
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 px-1"
                onClick={() => adjustGameClock(-10_000)}
              >
                -10s
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 px-1"
                onClick={() => adjustGameClock(-1_000)}
              >
                -1s
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 px-1"
                onClick={() => adjustGameClock(1_000)}
              >
                +1s
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 px-1"
                onClick={() => adjustGameClock(10_000)}
              >
                +10s
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 px-1"
                onClick={() => adjustGameClock(60_000)}
              >
                +1m
              </Button>
            </div>
          ) : null}
          {showSeekerStatus || activeTimeout !== null ? (
            <div className="mt-2 flex flex-wrap gap-1 text-[10px]">
              {showSeekerStatus ? (
                <div
                  className={`rounded border px-2 py-1 font-semibold tabular-nums ${
                    !gameView.seekerReleased &&
                    gameView.seekerReleaseCountdownMs !== null &&
                    gameView.seekerReleaseCountdownMs > 0 &&
                    gameView.seekerReleaseCountdownMs <= 10_000
                      ? "border-amber-300 bg-amber-50 text-amber-800"
                      : ""
                  }`}
                >
                  <span className="inline-flex items-center gap-1">
                    <Flag className="h-3 w-3" />
                    {gameView.seekerReleased
                      ? "Seek released"
                      : `Seek ${formatRemaining(gameView.seekerReleaseCountdownMs ?? seekerRemainingMs)}`}
                  </span>
                </div>
              ) : null}
              {activeTimeout !== null ? (
                <div
                  className={`rounded border px-2 py-1 font-semibold tabular-nums ${
                    gameView.timeoutWarningActive ? "border-red-300 bg-red-50 text-red-800" : ""
                  }`}
                >
                  <span className="inline-flex items-center gap-1">
                    <Clock3 className="h-3 w-3" />
                    {activeTimeoutTeamName} {formatRemaining(activeTimeout.remainingMs)}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}
          {activeTimeout !== null && gameView.timeoutReminderActive ? (
            <p
              className={`mt-2 rounded border px-2 py-1 text-[10px] font-medium ${
                gameView.timeoutWarningActive
                  ? "border-red-300 bg-red-50 text-red-800"
                  : "border-sky-300 bg-sky-50 text-sky-800"
              }`}
            >
              Reminder: tell head referee to blow their whistle at 15 seconds remaining.
            </p>
          ) : null}
        </section>

        <section className="grid min-h-0 grid-cols-2 gap-2">
          <Card className="h-full min-h-0 py-2">
            <CardContent className="flex h-full min-h-0 flex-col gap-1 overflow-hidden px-2.5">
              {controller && renamingTeam === "home" ? (
                <div className="grid gap-1">
                  <Input
                    value={homeName}
                    onChange={(event) => setHomeName(event.target.value)}
                    className="h-8 text-xs"
                    maxLength={40}
                  />
                  <div className="grid grid-cols-2 gap-1">
                    <Button size="sm" className="h-7 text-[11px]" onClick={saveTeamRename}>
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[11px]"
                      onClick={() => {
                        setHomeName(state.homeName);
                        setAwayName(state.awayName);
                        setRenamingTeam(null);
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="truncate text-left text-[11px] font-semibold"
                  onClick={() => {
                    if (!controller) {
                      return;
                    }
                    setHomeName(state.homeName);
                    setAwayName(state.awayName);
                    setRenamingTeam("home");
                  }}
                >
                  {state.homeName}
                </button>
              )}
              <p className="text-[clamp(2rem,11vw,3rem)] leading-none font-semibold tabular-nums">
                {state.score.home}
              </p>
              <div className="grid grid-cols-2 gap-1">
                <Button
                  size="sm"
                  className="h-8 gap-1 px-0 text-sm"
                  onClick={() =>
                    dispatchCommand({
                      type: "change-score",
                      team: "home",
                      delta: 10,
                      reason: "goal",
                    })
                  }
                  disabled={!controller || state.isFinished}
                >
                  <Plus className="h-3.5 w-3.5" />
                  10
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1 px-0 text-sm"
                  onClick={() => dispatchCommand({ type: "undo-last-score", team: "home" })}
                  disabled={!controller}
                >
                  <Minus className="h-3.5 w-3.5" />
                  10
                </Button>
              </div>
              <div className="mt-auto grid gap-1">
                {visibleHomePenalties.length === 0 ? (
                  <p className="text-[10px] text-muted-foreground">No penalties</p>
                ) : (
                  visibleHomePenalties.map((entry) => {
                    const releaseActions = pendingReleaseByPlayer[entry.playerKey] ?? [];
                    const playerState = state.players[entry.playerKey] ?? null;

                    return (
                      <div
                        key={entry.playerKey}
                        className={`rounded border px-2 py-1 text-[10px] ${
                          releaseActions.length > 0
                            ? "animate-pulse border-red-300 bg-red-50 text-red-900"
                            : entry.highlight
                              ? "border-amber-300 bg-amber-50 text-amber-900"
                              : ""
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span>{entry.label}</span>
                          <span className="font-semibold tabular-nums">{entry.remaining}</span>
                        </div>
                        {releaseActions.length > 0 ? (
                          <div className="mt-1 grid gap-1">
                            {releaseActions.map((action) => (
                              <Button
                                key={action.pendingId}
                                size="sm"
                                className="h-6 justify-start px-1.5 text-[10px]"
                                onClick={() =>
                                  dispatchCommand({
                                    type: "confirm-penalty-expiration",
                                    pendingId: action.pendingId,
                                    playerKey: entry.playerKey,
                                  })
                                }
                                disabled={!controller}
                              >
                                {formatPendingReleaseActionLabel(action, playerState)}
                              </Button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                )}
                {homePenalties.length > visibleHomePenalties.length ? (
                  <p className="text-[10px] text-muted-foreground">
                    +{homePenalties.length - visibleHomePenalties.length} more
                  </p>
                ) : null}
                {homeRecentReleases.slice(0, 2).map((release) => (
                  <div
                    key={release.id}
                    className="rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-[10px] text-emerald-900"
                  >
                    <span>{release.label} released</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="h-full min-h-0 py-2">
            <CardContent className="flex h-full min-h-0 flex-col gap-1 overflow-hidden px-2.5">
              {controller && renamingTeam === "away" ? (
                <div className="grid gap-1">
                  <Input
                    value={awayName}
                    onChange={(event) => setAwayName(event.target.value)}
                    className="h-8 text-xs"
                    maxLength={40}
                  />
                  <div className="grid grid-cols-2 gap-1">
                    <Button size="sm" className="h-7 text-[11px]" onClick={saveTeamRename}>
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[11px]"
                      onClick={() => {
                        setHomeName(state.homeName);
                        setAwayName(state.awayName);
                        setRenamingTeam(null);
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="truncate text-left text-[11px] font-semibold"
                  onClick={() => {
                    if (!controller) {
                      return;
                    }
                    setHomeName(state.homeName);
                    setAwayName(state.awayName);
                    setRenamingTeam("away");
                  }}
                >
                  {state.awayName}
                </button>
              )}
              <p className="text-[clamp(2rem,11vw,3rem)] leading-none font-semibold tabular-nums">
                {state.score.away}
              </p>
              <div className="grid grid-cols-2 gap-1">
                <Button
                  size="sm"
                  className="h-8 gap-1 px-0 text-sm"
                  onClick={() =>
                    dispatchCommand({
                      type: "change-score",
                      team: "away",
                      delta: 10,
                      reason: "goal",
                    })
                  }
                  disabled={!controller || state.isFinished}
                >
                  <Plus className="h-3.5 w-3.5" />
                  10
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1 px-0 text-sm"
                  onClick={() => dispatchCommand({ type: "undo-last-score", team: "away" })}
                  disabled={!controller}
                >
                  <Minus className="h-3.5 w-3.5" />
                  10
                </Button>
              </div>
              <div className="mt-auto grid gap-1">
                {visibleAwayPenalties.length === 0 ? (
                  <p className="text-[10px] text-muted-foreground">No penalties</p>
                ) : (
                  visibleAwayPenalties.map((entry) => {
                    const releaseActions = pendingReleaseByPlayer[entry.playerKey] ?? [];
                    const playerState = state.players[entry.playerKey] ?? null;

                    return (
                      <div
                        key={entry.playerKey}
                        className={`rounded border px-2 py-1 text-[10px] ${
                          releaseActions.length > 0
                            ? "animate-pulse border-red-300 bg-red-50 text-red-900"
                            : entry.highlight
                              ? "border-amber-300 bg-amber-50 text-amber-900"
                              : ""
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span>{entry.label}</span>
                          <span className="font-semibold tabular-nums">{entry.remaining}</span>
                        </div>
                        {releaseActions.length > 0 ? (
                          <div className="mt-1 grid gap-1">
                            {releaseActions.map((action) => (
                              <Button
                                key={action.pendingId}
                                size="sm"
                                className="h-6 justify-start px-1.5 text-[10px]"
                                onClick={() =>
                                  dispatchCommand({
                                    type: "confirm-penalty-expiration",
                                    pendingId: action.pendingId,
                                    playerKey: entry.playerKey,
                                  })
                                }
                                disabled={!controller}
                              >
                                {formatPendingReleaseActionLabel(action, playerState)}
                              </Button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                )}
                {awayPenalties.length > visibleAwayPenalties.length ? (
                  <p className="text-[10px] text-muted-foreground">
                    +{awayPenalties.length - visibleAwayPenalties.length} more
                  </p>
                ) : null}
                {awayRecentReleases.slice(0, 2).map((release) => (
                  <div
                    key={release.id}
                    className="rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-[10px] text-emerald-900"
                  >
                    <span>{release.label} released</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </section>

        <Card className="min-h-0 py-2">
          <CardContent className="flex h-full flex-col gap-1 overflow-hidden px-2.5">
            {activePanel === "overview" ? (
              <>
                <div className="grid gap-1 text-[10px]">
                  {pendingCount > 0 ? (
                    <p className="rounded border border-amber-300 bg-amber-50 px-2 py-1 font-medium text-amber-800">
                      {pendingCount} pending expiration{pendingCount > 1 ? "s" : ""}.
                    </p>
                  ) : null}
                  {state.flagCatch !== null ? (
                    <p className="rounded border border-emerald-300 bg-emerald-50 px-2 py-1 font-medium text-emerald-800">
                      Flag catch:{" "}
                      {state.flagCatch.team === "home" ? state.homeName : state.awayName}
                    </p>
                  ) : null}
                  {recentCards.length > 0 ? (
                    recentCards.map((card) => (
                      <p key={card.id} className="truncate">
                        {card.team === "home" ? state.homeName : state.awayName} •{" "}
                        {card.playerNumber === null ? "Unknown" : `#${card.playerNumber}`} •{" "}
                        {card.cardType}
                      </p>
                    ))
                  ) : pendingCount === 0 && state.flagCatch === null ? (
                    <p className="text-muted-foreground">No active alerts.</p>
                  ) : null}
                  {unresolvedPendingExpirations.length > 0
                    ? unresolvedPendingExpirations.map((pending) => (
                        <div
                          key={pending.id}
                          className="flex items-center justify-between rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-900"
                        >
                          <span>
                            {pending.reason === "score" ? "Goal" : "Flag"} pending without player
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-5 px-1.5 text-[10px]"
                            onClick={() =>
                              dispatchCommand({
                                type: "dismiss-penalty-expiration",
                                pendingId: pending.id,
                              })
                            }
                            disabled={!controller}
                          >
                            Dismiss
                          </Button>
                        </div>
                      ))
                    : null}
                </div>
                {error !== null && !localOnlyMode ? (
                  <p className="mt-auto text-[10px] font-medium text-destructive">{error}</p>
                ) : null}
              </>
            ) : null}

            {activePanel === "card" ? (
              <>
                <div className="grid grid-cols-2 gap-1">
                  {cardTypeOptions.map((option) => {
                    const Icon = option.icon;
                    const active = cardDraft.cardType === option.type;

                    return (
                      <Button
                        key={option.type}
                        size="sm"
                        variant="outline"
                        className={`h-6 justify-start gap-1.5 px-2 text-[10px] ${
                          active ? option.activeClassName : option.idleClassName
                        }`}
                        onClick={() =>
                          setCardDraft((previous) => ({
                            ...previous,
                            cardType: option.type,
                            startedGameClockMs:
                              previous.startedGameClockMs === null
                                ? state.gameClockMs
                                : previous.startedGameClockMs,
                          }))
                        }
                        disabled={!canSelectCardType}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        {option.label}
                      </Button>
                    );
                  })}
                </div>
                <div className="grid grid-cols-2 gap-1">
                  <Button
                    size="sm"
                    variant={cardDraft.team === "home" ? "default" : "outline"}
                    className="h-6 text-[10px]"
                    onClick={() =>
                      setCardDraft((previous) => ({
                        ...previous,
                        team: "home",
                      }))
                    }
                    disabled={!canSelectCardTeam}
                  >
                    {state.homeName}
                  </Button>
                  <Button
                    size="sm"
                    variant={cardDraft.team === "away" ? "default" : "outline"}
                    className="h-6 text-[10px]"
                    onClick={() =>
                      setCardDraft((previous) => ({
                        ...previous,
                        team: "away",
                      }))
                    }
                    disabled={!canSelectCardTeam}
                  >
                    {state.awayName}
                  </Button>
                </div>
                <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded border px-2 py-1 text-[10px] font-medium">
                  {cardDraft.cardType === null ? (
                    <span className="text-muted-foreground">Card?</span>
                  ) : (
                    <>
                      <span className="uppercase">{cardDraft.cardType}</span>
                      <span className="truncate text-muted-foreground">
                        •{" "}
                        {cardDraft.team === null
                          ? "team?"
                          : cardDraft.team === "home"
                            ? state.homeName
                            : state.awayName}{" "}
                        • {cardPlayerLabel}
                      </span>
                    </>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 px-1.5 text-[10px]"
                    onClick={() =>
                      setCardDraft({
                        cardType: null,
                        team: null,
                        digits: "",
                        startedGameClockMs: null,
                      })
                    }
                    disabled={!controller || !cardEntryStarted}
                  >
                    Reset
                  </Button>
                </div>
                <p className="h-4 text-[10px] text-muted-foreground">{cardAddStatusText}</p>
                <div className="grid grid-cols-3 gap-1">
                  {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
                    <Button
                      key={digit}
                      size="sm"
                      variant="outline"
                      className="h-6 text-sm"
                      onClick={() => appendCardDigit(digit)}
                      disabled={!canEditCardDigits}
                    >
                      {digit}
                    </Button>
                  ))}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6"
                    onClick={() =>
                      setCardDraft((previous) => ({
                        ...previous,
                        digits: previous.digits.slice(0, -1),
                      }))
                    }
                    disabled={!canEditCardDigits || cardDraft.digits.length === 0}
                  >
                    <Delete className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-sm"
                    onClick={() => appendCardDigit("0")}
                    disabled={!canEditCardDigits}
                  >
                    0
                  </Button>
                  <Button
                    size="sm"
                    className="h-6 gap-1"
                    onClick={submitCard}
                    disabled={!canSubmitCard}
                  >
                    <Check className="h-4 w-4" />
                    OK
                  </Button>
                </div>
                {state.isRunning && !cardEntryStarted ? (
                  <p className="text-[10px] text-muted-foreground">
                    Pause play to start card entry.
                  </p>
                ) : null}
              </>
            ) : null}

            {activePanel === "timeout" ? (
              <>
                {activeTimeout === null ? (
                  <div className="grid gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8"
                      onClick={() => dispatchCommand({ type: "start-timeout", team: "home" })}
                      disabled={
                        !controller ||
                        state.isRunning ||
                        state.timeouts.home.used ||
                        state.isFinished
                      }
                    >
                      {state.homeName} timeout
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8"
                      onClick={() => dispatchCommand({ type: "start-timeout", team: "away" })}
                      disabled={
                        !controller ||
                        state.isRunning ||
                        state.timeouts.away.used ||
                        state.isFinished
                      }
                    >
                      {state.awayName} timeout
                    </Button>
                  </div>
                ) : (
                  <>
                    <p
                      className={`text-2xl font-semibold tabular-nums ${
                        gameView.timeoutFinalCountdown
                          ? "text-red-700"
                          : gameView.timeoutWarningActive
                            ? "text-red-600"
                            : ""
                      }`}
                    >
                      {formatRemaining(activeTimeout.remainingMs)}
                    </p>
                    {!activeTimeout.running ? (
                      <div className="grid grid-cols-2 gap-1">
                        <Button
                          size="sm"
                          onClick={() =>
                            dispatchCommand({
                              type: "set-timeout-running",
                              running: true,
                            })
                          }
                          disabled={!controller}
                        >
                          Start
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => dispatchCommand({ type: "undo-timeout-start" })}
                          disabled={!controller}
                        >
                          Undo
                        </Button>
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => dispatchCommand({ type: "cancel-timeout" })}
                          disabled={!controller}
                        >
                          End early
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => dispatchCommand({ type: "undo-timeout-start" })}
                          disabled={!controller}
                        >
                          Undo
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </>
            ) : null}

            {activePanel === "admin" ? (
              <>
                {canRecordFlagCatch ? (
                  <div className="grid grid-cols-2 gap-1">
                    <Button
                      size="sm"
                      onClick={() => dispatchCommand({ type: "record-flag-catch", team: "home" })}
                      disabled={!controller}
                    >
                      Home flag +30
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => dispatchCommand({ type: "record-flag-catch", team: "away" })}
                      disabled={!controller}
                    >
                      Away flag +30
                    </Button>
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    Flag catch appears here once seeker release has happened and play is paused.
                  </p>
                )}
                {controller ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => dispatchCommand({ type: "finish-game" })}
                  >
                    Finish game
                  </Button>
                ) : null}
              </>
            ) : null}
          </CardContent>
        </Card>

        <section className="grid grid-cols-4 gap-1">
          <Button
            variant={activePanel === "overview" ? "default" : "outline"}
            size="sm"
            className="h-8 gap-1 px-1 text-[11px]"
            onClick={() => setActivePanel("overview")}
          >
            <Info className="h-3.5 w-3.5" />
            Info
          </Button>
          <Button
            variant={activePanel === "card" ? "default" : "outline"}
            size="sm"
            className="h-8 gap-1 px-1 text-[11px]"
            onClick={() => setActivePanel("card")}
          >
            <Flag className="h-3.5 w-3.5" />
            Card
          </Button>
          <Button
            variant={activePanel === "timeout" ? "default" : "outline"}
            size="sm"
            className="h-8 gap-1 px-1 text-[11px]"
            onClick={() => setActivePanel("timeout")}
          >
            <Clock3 className="h-3.5 w-3.5" />
            TO
          </Button>
          <Button
            variant={activePanel === "admin" ? "default" : "outline"}
            size="sm"
            className="h-8 gap-1 px-1 text-[11px]"
            onClick={() => setActivePanel("admin")}
          >
            <Settings className="h-3.5 w-3.5" />
            Admin
          </Button>
        </section>
      </div>
    </div>
  );
}

function useGameConnection({ gameId, role }: { gameId: string; role: ControllerRole }) {
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

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.pathname, window.location.search),
  );

  useEffect(() => {
    const onPopState = () => {
      setRoute(parseRoute(window.location.pathname, window.location.search));
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return route;
}

function parseRoute(pathname: string, search: string): Route {
  const match = pathname.match(/^\/game\/([a-zA-Z0-9-]+)$/);
  if (match === null) {
    return { type: "home" };
  }

  const params = new URLSearchParams(search);
  const mode = params.get("mode") === "controller" ? "controller" : "spectator";

  return {
    type: "game",
    gameId: match[1] ?? "",
    role: mode,
  };
}

function useNow(intervalMs: number) {
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

function navigateTo(path: string) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function formatClock(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatRemaining(ms: number) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1_000));

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatPenaltySlice(ms: number) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function deriveLiveClockMs(game: GameSummary, nowMs: number) {
  if (!game.isRunning || game.isFinished) {
    return game.gameClockMs;
  }

  return game.gameClockMs + Math.max(0, nowMs - game.updatedAtMs);
}

type PlayerPenaltyView = {
  playerKey: string;
  label: string;
  remaining: string;
  remainingMs: number;
  highlight: boolean;
};

type ReleasedPenaltyView = {
  id: string;
  label: string;
  releasedAtMs: number;
};

function getTeamPenalties(state: GameState | null | undefined, team: TeamId): PlayerPenaltyView[] {
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

function selectVisiblePenalties(
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

function hasServingPenalty(player: PlayerPenaltyState | null | undefined) {
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

function formatPendingReleaseActionLabel(
  action: PendingReleaseAction,
  player: PlayerPenaltyState | null | undefined,
) {
  const source = action.reason === "score" ? "Goal" : "Flag";
  if (willPendingReleaseNow(action, player)) {
    return `${source} release`;
  }

  return `${source} -${formatPenaltySlice(action.expireMs)}`;
}

function getTeamRecentReleases(
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

export default App;
