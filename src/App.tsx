import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertTriangle,
  Clock3,
  CloudOff,
  Eye,
  Flag,
  Info,
  Minus,
  Pause,
  Play,
  Plus,
  Settings,
  Timer,
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
const LOCAL_ONLY_MESSAGE = "Server does not know this game. Continuing locally on this device.";
const NORMAL_RECONNECT_DELAY_MS = 1_000;
const LOCAL_ONLY_RETRY_DELAY_MS = 60_000;
const ONE_MINUTE_MS = 60_000;
const SEEKER_RELEASE_MS = 20 * ONE_MINUTE_MS;
const SEEKER_STATUS_SHOW_FROM_MS = 18 * ONE_MINUTE_MS;
const SEEKER_STATUS_HIDE_AFTER_MS = 21 * ONE_MINUTE_MS;

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
  const [activePanel, setActivePanel] = useState<
    "overview" | "card" | "expire" | "timeout" | "admin"
  >("overview");
  const [homeName, setHomeName] = useState("Home");
  const [awayName, setAwayName] = useState("Away");
  const [cardTeam, setCardTeam] = useState<TeamId>("home");
  const [cardType, setCardType] = useState<CardType>("blue");
  const [playerNumberInput, setPlayerNumberInput] = useState("");
  const [clockAdjustOpen, setClockAdjustOpen] = useState(false);
  const [renamingTeam, setRenamingTeam] = useState<TeamId | null>(null);
  const [pendingSelections, setPendingSelections] = useState<Record<string, string>>({});

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

  const submitCard = useCallback(() => {
    if (!controller) {
      return;
    }

    const playerNumber = parsePlayerNumber(playerNumberInput);
    dispatchCommand({
      type: "add-card",
      team: cardTeam,
      cardType,
      playerNumber,
    });

    setPlayerNumberInput("");
  }, [cardTeam, cardType, controller, dispatchCommand, playerNumberInput]);

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
  const visibleHomePenalties = homePenalties.slice(0, 1);
  const visibleAwayPenalties = awayPenalties.slice(0, 1);
  const activeTimeoutTeamName =
    activeTimeout === null ? null : activeTimeout.team === "home" ? state.homeName : state.awayName;
  const showSeekerStatus =
    state.gameClockMs >= SEEKER_STATUS_SHOW_FROM_MS &&
    state.gameClockMs <= SEEKER_STATUS_HIDE_AFTER_MS;
  const seekerRemainingMs = Math.max(0, SEEKER_RELEASE_MS - state.gameClockMs);

  return (
    <div className="h-[100dvh] overflow-hidden bg-background p-2">
      <div className="mx-auto grid h-full w-full max-w-[460px] grid-rows-[auto_auto_minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
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
          {showSeekerStatus || activeTimeout !== null || pendingCount > 0 ? (
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
              {pendingCount > 0 ? (
                <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1 font-semibold text-amber-800">
                  <span className="inline-flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    Expire {pendingCount}
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
                  visibleHomePenalties.map((entry) => (
                    <div
                      key={entry.playerKey}
                      className={`flex items-center justify-between rounded border px-2 py-1 text-[10px] ${
                        entry.highlight ? "border-amber-300 bg-amber-50 text-amber-900" : ""
                      }`}
                    >
                      <span>{entry.label}</span>
                      <span className="font-semibold tabular-nums">{entry.remaining}</span>
                    </div>
                  ))
                )}
                {homePenalties.length > visibleHomePenalties.length ? (
                  <p className="text-[10px] text-muted-foreground">
                    +{homePenalties.length - visibleHomePenalties.length} more
                  </p>
                ) : null}
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
                  visibleAwayPenalties.map((entry) => (
                    <div
                      key={entry.playerKey}
                      className={`flex items-center justify-between rounded border px-2 py-1 text-[10px] ${
                        entry.highlight ? "border-amber-300 bg-amber-50 text-amber-900" : ""
                      }`}
                    >
                      <span>{entry.label}</span>
                      <span className="font-semibold tabular-nums">{entry.remaining}</span>
                    </div>
                  ))
                )}
                {awayPenalties.length > visibleAwayPenalties.length ? (
                  <p className="text-[10px] text-muted-foreground">
                    +{awayPenalties.length - visibleAwayPenalties.length} more
                  </p>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </section>

        <Card className="min-h-0 py-2">
          <CardContent className="flex h-full flex-col gap-2 overflow-hidden px-2.5">
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
                </div>
                {error !== null && !localOnlyMode ? (
                  <p className="mt-auto text-[10px] font-medium text-destructive">{error}</p>
                ) : null}
              </>
            ) : null}

            {activePanel === "card" ? (
              <>
                <div className="grid grid-cols-2 gap-1">
                  <Select
                    value={cardTeam}
                    onValueChange={(value) => setCardTeam(value as TeamId)}
                    disabled={!controller}
                  >
                    <SelectTrigger className="h-8 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="home">{state.homeName}</SelectItem>
                      <SelectItem value="away">{state.awayName}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={cardType}
                    onValueChange={(value) => setCardType(value as CardType)}
                    disabled={!controller}
                  >
                    <SelectTrigger className="h-8 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="blue">Blue</SelectItem>
                      <SelectItem value="yellow">Yellow</SelectItem>
                      <SelectItem value="red">Red</SelectItem>
                      <SelectItem value="ejection">Ejection</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Input
                  value={playerNumberInput}
                  onChange={(event) => setPlayerNumberInput(event.target.value)}
                  placeholder="Player # (optional)"
                  inputMode="numeric"
                  className="h-8"
                  disabled={!controller}
                />
                <Button
                  className="h-9"
                  onClick={submitCard}
                  disabled={!controller || state.isFinished}
                >
                  <Plus className="h-4 w-4" />
                  Add card
                </Button>
              </>
            ) : null}

            {activePanel === "expire" ? (
              <>
                {pendingExpirations.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">Nothing pending.</p>
                ) : (
                  pendingExpirations.slice(0, 2).map((expiration) => {
                    const candidates = expiration.candidatePlayerKeys.filter(
                      (playerKey) => state.players[playerKey] !== undefined,
                    );
                    const selected = pendingSelections[expiration.id] ?? "";
                    const auto = candidates.length === 1 ? (candidates[0] ?? "") : "";
                    const effective = selected.length > 0 ? selected : auto;

                    return (
                      <div key={expiration.id} className="rounded border p-2 text-[10px]">
                        <p className="font-medium">
                          {expiration.reason === "score" ? "Goal" : "Flag"} •{" "}
                          {expiration.penalizedTeam === "home" ? state.homeName : state.awayName}
                        </p>
                        {candidates.length > 1 ? (
                          <Select
                            value={effective}
                            onValueChange={(playerKey) =>
                              setPendingSelections((previous) => ({
                                ...previous,
                                [expiration.id]: playerKey,
                              }))
                            }
                            disabled={!controller}
                          >
                            <SelectTrigger className="mt-1 h-7 w-full">
                              <SelectValue placeholder="Choose player" />
                            </SelectTrigger>
                            <SelectContent>
                              {candidates.map((playerKey) => (
                                <SelectItem key={playerKey} value={playerKey}>
                                  {formatPlayerLabel(state.players[playerKey])}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <p className="mt-1 truncate">
                            {formatPlayerLabel(state.players[candidates[0] ?? ""])}
                          </p>
                        )}
                        <div className="mt-1 grid grid-cols-2 gap-1">
                          <Button
                            size="sm"
                            onClick={() =>
                              dispatchCommand({
                                type: "confirm-penalty-expiration",
                                pendingId: expiration.id,
                                playerKey: effective.length > 0 ? effective : null,
                              })
                            }
                            disabled={
                              !controller || (candidates.length > 1 && effective.length === 0)
                            }
                          >
                            Confirm
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              dispatchCommand({
                                type: "dismiss-penalty-expiration",
                                pendingId: expiration.id,
                              })
                            }
                            disabled={!controller}
                          >
                            Dismiss
                          </Button>
                        </div>
                      </div>
                    );
                  })
                )}
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

        <section className="grid grid-cols-5 gap-1">
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
            variant={activePanel === "expire" ? "default" : "outline"}
            size="sm"
            className="h-8 gap-1 px-1 text-[11px]"
            onClick={() => setActivePanel("expire")}
          >
            <Timer className="h-3.5 w-3.5" />
            Exp {pendingCount > 0 ? pendingCount : ""}
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

function parsePlayerNumber(value: string): number | null {
  if (value.trim().length === 0) {
    return null;
  }

  const number = Number(value.trim());
  if (!Number.isInteger(number) || number < 0 || number > 99) {
    return null;
  }

  return number;
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
