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
import { applyGameCommand, projectGameView } from "@/lib/game-engine";
import type {
  CardType,
  ControllerRole,
  GameCommand,
  GameState,
  GameSummary,
  GameView,
  PendingPenaltyExpiration,
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

type ConnectionState = "connecting" | "online" | "offline";

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
  const [homeName, setHomeName] = useState("Home");
  const [awayName, setAwayName] = useState("Away");
  const [cardTeam, setCardTeam] = useState<TeamId>("home");
  const [cardType, setCardType] = useState<CardType>("blue");
  const [playerNumberInput, setPlayerNumberInput] = useState("");
  const [setTimeInput, setSetTimeInput] = useState("00:00");
  const [pendingSelections, setPendingSelections] = useState<Record<string, string>>({});

  const nowMs = useNow(250);

  const { baseState, clockOffsetMs, dispatchCommand, connectionState, pendingCommands, error } =
    useGameConnection({
      gameId,
      role,
    });

  useEffect(() => {
    if (baseState !== null) {
      setHomeName(baseState.homeName);
      setAwayName(baseState.awayName);
      setSetTimeInput(formatClock(baseState.gameClockMs));
    }
  }, [baseState]);

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

  const applySetClock = useCallback(() => {
    if (!controller) {
      return;
    }

    const parsedMs = parseClockInput(setTimeInput);
    if (parsedMs === null) {
      return;
    }

    dispatchCommand({
      type: "set-game-clock",
      gameClockMs: parsedMs,
    });
  }, [controller, dispatchCommand, setTimeInput]);

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

  return (
    <div className="mx-auto w-full max-w-5xl p-3 pb-20 sm:p-6">
      <header className="sticky top-0 z-40 -mx-3 mb-4 border-b bg-background/96 px-3 py-3 shadow-sm backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {role}
            </p>
            <h1 className="text-lg font-semibold leading-tight">
              {state.homeName} vs {state.awayName}
            </h1>
          </div>
          <Button variant="outline" size="sm" onClick={() => navigateTo("/")}>
            Games
          </Button>
        </div>

        <div className="mt-3 grid grid-cols-[1fr_auto] items-center gap-3 rounded-xl border bg-card p-3 shadow-sm">
          <div>
            <p className="text-xs text-muted-foreground">Game time</p>
            <p className="text-4xl font-semibold tabular-nums sm:text-5xl">
              {formatClock(gameView.state.gameClockMs)}
            </p>
            <p className="text-xs text-muted-foreground">
              {state.isFinished ? "Finished" : state.isRunning ? "Play running" : "Play paused"}
            </p>
          </div>
          <div className="grid gap-2">
            <Button
              size="lg"
              className="min-w-28"
              onClick={() => dispatchCommand({ type: "set-running", running: !state.isRunning })}
              disabled={!controller || state.isFinished}
            >
              {state.isRunning ? "Pause" : "Play"}
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => dispatchCommand({ type: "adjust-game-clock", deltaMs: -10_000 })}
                disabled={!controller}
              >
                -10s
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => dispatchCommand({ type: "adjust-game-clock", deltaMs: 10_000 })}
                disabled={!controller}
              >
                +10s
              </Button>
            </div>
          </div>
        </div>

        {controller && connectionState !== "online" ? (
          <p className="mt-2 text-xs font-medium text-amber-600">
            Offline mode active. {pendingCommands} local change(s) will sync automatically.
          </p>
        ) : null}
      </header>

      <div className="grid gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Scoreboard</CardTitle>
            <CardDescription>Fast score controls with undo per team.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2">
              {(["home", "away"] as const).map((team) => (
                <div key={team} className="rounded-xl border p-3">
                  <p className="text-sm font-medium">
                    {team === "home" ? state.homeName : state.awayName}
                  </p>
                  <p className="my-2 text-4xl font-semibold tabular-nums">{state.score[team]}</p>
                  <div className="grid grid-cols-3 gap-2">
                    <Button
                      size="sm"
                      onClick={() =>
                        dispatchCommand({ type: "change-score", team, delta: 10, reason: "goal" })
                      }
                      disabled={!controller || state.isFinished}
                    >
                      +10
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        dispatchCommand({
                          type: "change-score",
                          team,
                          delta: -10,
                          reason: "manual",
                        })
                      }
                      disabled={!controller}
                    >
                      -10
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => dispatchCommand({ type: "undo-last-score", team })}
                      disabled={!controller}
                    >
                      Undo
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            {canRecordFlagCatch ? (
              <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50/70 p-3">
                <p className="text-sm font-medium text-emerald-800">
                  Flag catch available while paused.
                </p>
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => dispatchCommand({ type: "record-flag-catch", team: "home" })}
                    disabled={!controller}
                  >
                    {state.homeName} flag catch (+30)
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => dispatchCommand({ type: "record-flag-catch", team: "away" })}
                    disabled={!controller}
                  >
                    {state.awayName} flag catch (+30)
                  </Button>
                </div>
              </div>
            ) : null}

            {state.flagCatch !== null ? (
              <p className="mt-4 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm font-medium text-emerald-800">
                Flag caught by {state.flagCatch.team === "home" ? state.homeName : state.awayName}.
                Game finished.
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Seeker Release</CardTitle>
            <CardDescription>Countdown starts at 19:00 and ends at 20:00.</CardDescription>
          </CardHeader>
          <CardContent>
            {gameView.seekerReleaseCountdownMs === null ? (
              <p className="text-sm text-muted-foreground">
                Countdown becomes visible at game time 19:00.
              </p>
            ) : (
              <p
                className={`text-2xl font-semibold tabular-nums ${
                  gameView.seekerReleaseCountdownMs > 0 &&
                  gameView.seekerReleaseCountdownMs <= 10_000
                    ? "text-amber-600"
                    : ""
                }`}
              >
                {gameView.seekerReleased
                  ? "Seekers released"
                  : formatRemaining(gameView.seekerReleaseCountdownMs)}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Pending Penalty Expirations</CardTitle>
            <CardDescription>
              Confirm each score/flag-triggered expiration explicitly before removing a penalty
              minute.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {pendingExpirations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No pending expirations.</p>
            ) : (
              pendingExpirations.map((expiration) => (
                <PendingExpirationRow
                  key={expiration.id}
                  expiration={expiration}
                  players={state.players}
                  disabled={!controller}
                  selectedPlayerKey={pendingSelections[expiration.id] ?? ""}
                  onSelect={(playerKey) =>
                    setPendingSelections((previous) => ({
                      ...previous,
                      [expiration.id]: playerKey,
                    }))
                  }
                  onConfirm={(playerKey) =>
                    dispatchCommand({
                      type: "confirm-penalty-expiration",
                      pendingId: expiration.id,
                      playerKey,
                    })
                  }
                  onDismiss={() =>
                    dispatchCommand({
                      type: "dismiss-penalty-expiration",
                      pendingId: expiration.id,
                    })
                  }
                  teamNames={{ home: state.homeName, away: state.awayName }}
                />
              ))
            )}
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Penalty Box</CardTitle>
              <CardDescription>Clock only runs while play is running.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <PenaltyList title={state.homeName} entries={homePenalties} />
              <PenaltyList title={state.awayName} entries={awayPenalties} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Cards</CardTitle>
              <CardDescription>
                Blue/yellow add 1 minute, red adds 2 minutes, ejection adds no penalty time.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label>Team</Label>
                  <Select
                    value={cardTeam}
                    onValueChange={(value) => setCardTeam(value as TeamId)}
                    disabled={!controller}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="home">{state.homeName}</SelectItem>
                      <SelectItem value="away">{state.awayName}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Card</Label>
                  <Select
                    value={cardType}
                    onValueChange={(value) => setCardType(value as CardType)}
                    disabled={!controller}
                  >
                    <SelectTrigger className="w-full">
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
              </div>

              <div className="space-y-1">
                <Label htmlFor="player-number">Player number (0-99, optional)</Label>
                <Input
                  id="player-number"
                  value={playerNumberInput}
                  onChange={(event) => setPlayerNumberInput(event.target.value)}
                  placeholder="e.g. 42"
                  inputMode="numeric"
                  disabled={!controller}
                />
              </div>

              <Button
                className="w-full"
                onClick={submitCard}
                disabled={!controller || state.isFinished}
              >
                Add card
              </Button>

              <div className="space-y-2 border-t pt-3">
                <p className="text-xs font-medium text-muted-foreground">Latest cards</p>
                <div className="max-h-44 space-y-1 overflow-auto">
                  {state.cardEvents
                    .slice(-12)
                    .reverse()
                    .map((card) => (
                      <p key={card.id} className="text-xs">
                        <span className="font-medium">
                          {card.team === "home" ? state.homeName : state.awayName}
                        </span>{" "}
                        • {card.playerNumber === null ? "Unknown" : `#${card.playerNumber}`} •{" "}
                        {card.cardType}
                      </p>
                    ))}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Timeouts</CardTitle>
            <CardDescription>Timeout clock runs only while game clock is paused.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {activeTimeout === null ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => dispatchCommand({ type: "start-timeout", team: "home" })}
                  disabled={
                    !controller || state.isRunning || state.timeouts.home.used || state.isFinished
                  }
                >
                  {state.homeName} timeout {state.timeouts.home.used ? "(used)" : "(start)"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => dispatchCommand({ type: "start-timeout", team: "away" })}
                  disabled={
                    !controller || state.isRunning || state.timeouts.away.used || state.isFinished
                  }
                >
                  {state.awayName} timeout {state.timeouts.away.used ? "(used)" : "(start)"}
                </Button>
              </div>
            ) : (
              <div className="rounded-xl border p-3">
                <p className="text-sm">
                  Active timeout:{" "}
                  <strong>{activeTimeout.team === "home" ? state.homeName : state.awayName}</strong>
                </p>
                <p
                  className={`text-3xl font-semibold tabular-nums ${
                    gameView.timeoutFinalCountdown
                      ? "text-red-700"
                      : gameView.timeoutWarningActive
                        ? "text-red-600"
                        : ""
                  }`}
                >
                  {formatRemaining(activeTimeout.remainingMs)}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {!activeTimeout.running ? (
                    <>
                      <Button
                        size="sm"
                        onClick={() =>
                          dispatchCommand({
                            type: "set-timeout-running",
                            running: true,
                          })
                        }
                        disabled={!controller || state.isRunning || activeTimeout.remainingMs <= 0}
                      >
                        Start timeout
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => dispatchCommand({ type: "undo-timeout-start" })}
                        disabled={!controller}
                      >
                        Undo timeout start
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => dispatchCommand({ type: "cancel-timeout" })}
                        disabled={!controller}
                      >
                        End timeout early
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => dispatchCommand({ type: "undo-timeout-start" })}
                        disabled={!controller}
                      >
                        Undo timeout start
                      </Button>
                    </>
                  )}
                </div>
                {gameView.timeoutReminderActive ? (
                  <p
                    className={`mt-2 rounded-md border p-2 text-xs font-medium ${
                      gameView.timeoutFinalCountdown
                        ? "border-red-400 bg-red-100 text-red-900"
                        : gameView.timeoutWarningActive
                          ? "border-red-300 bg-red-50 text-red-800"
                          : "border-sky-300 bg-sky-50 text-sky-800"
                    }`}
                  >
                    Reminder: tell head referee to blow their whistle at 15 seconds remaining.
                  </p>
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Manual Clock + Team Names</CardTitle>
            <CardDescription>For corrections after timing or naming mistakes.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="set-clock">Set game time (MM:SS)</Label>
              <div className="flex gap-2">
                <Input
                  id="set-clock"
                  value={setTimeInput}
                  onChange={(event) => setSetTimeInput(event.target.value)}
                  disabled={!controller}
                />
                <Button variant="outline" onClick={applySetClock} disabled={!controller}>
                  Apply
                </Button>
              </div>
            </div>

            <div className="space-y-1">
              <Label>Rename teams</Label>
              <div className="grid gap-2">
                <Input
                  value={homeName}
                  onChange={(event) => setHomeName(event.target.value)}
                  disabled={!controller}
                />
                <Input
                  value={awayName}
                  onChange={(event) => setAwayName(event.target.value)}
                  disabled={!controller}
                />
                <Button
                  variant="outline"
                  onClick={() => dispatchCommand({ type: "rename-teams", homeName, awayName })}
                  disabled={!controller}
                >
                  Save names
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {controller ? (
          <div className="flex justify-end">
            <Button variant="ghost" onClick={() => dispatchCommand({ type: "finish-game" })}>
              Mark game as finished
            </Button>
          </div>
        ) : null}

        {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}

function PendingExpirationRow({
  expiration,
  players,
  selectedPlayerKey,
  onSelect,
  onConfirm,
  onDismiss,
  disabled,
  teamNames,
}: {
  expiration: PendingPenaltyExpiration;
  players: Record<string, PlayerPenaltyState>;
  selectedPlayerKey: string;
  onSelect: (playerKey: string) => void;
  onConfirm: (playerKey: string | null) => void;
  onDismiss: () => void;
  disabled: boolean;
  teamNames: Record<TeamId, string>;
}) {
  const candidates = expiration.candidatePlayerKeys.filter(
    (playerKey) => players[playerKey] !== undefined,
  );
  const defaultPlayerKey = candidates.length === 1 ? (candidates[0] ?? "") : "";
  const effectiveSelection = selectedPlayerKey.length > 0 ? selectedPlayerKey : defaultPlayerKey;

  return (
    <div className="rounded-xl border p-3">
      <p className="text-sm font-medium">
        {expiration.reason === "score" ? "Goal" : "Flag catch"} by{" "}
        {teamNames[expiration.benefitingTeam]} against {teamNames[expiration.penalizedTeam]}
      </p>

      {candidates.length > 1 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Select value={effectiveSelection} onValueChange={onSelect} disabled={disabled}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Choose player" />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((playerKey) => (
                <SelectItem key={playerKey} value={playerKey}>
                  {formatPlayerLabel(players[playerKey])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            onClick={() => onConfirm(effectiveSelection.length > 0 ? effectiveSelection : null)}
            disabled={disabled || effectiveSelection.length === 0}
          >
            Confirm expiration
          </Button>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => onConfirm(candidates[0] ?? null)}
            disabled={disabled || candidates.length === 0}
          >
            Confirm expiration{" "}
            {candidates[0] !== undefined
              ? `(${formatPlayerLabel(players[candidates[0]] ?? null)})`
              : ""}
          </Button>
          <Button size="sm" variant="outline" onClick={onDismiss} disabled={disabled}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}

function PenaltyList({ title, entries }: { title: string; entries: PlayerPenaltyView[] }) {
  return (
    <div>
      <p className="mb-2 text-sm font-semibold">{title}</p>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No active penalties.</p>
      ) : (
        <div className="space-y-1">
          {entries.map((entry) => (
            <div
              key={entry.playerKey}
              className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm ${
                entry.highlight ? "border-amber-300 bg-amber-50/70 text-amber-900" : ""
              }`}
            >
              <span>{entry.label}</span>
              <span className="font-semibold tabular-nums">{entry.remaining}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function useGameConnection({ gameId, role }: { gameId: string; role: ControllerRole }) {
  const wsUrl = useMemo(createWebSocketUrl, []);
  const [baseState, setBaseState] = useState<GameState | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);

  const pendingRef = useRef<ClientCommandEnvelope[]>([]);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const commandCounterRef = useRef(0);
  const clientInstanceId = useRef(crypto.randomUUID());

  const flushPendingCommands = useCallback(() => {
    if (role !== "controller") {
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
        pendingRef.current = pendingRef.current.filter((command) => !ackedSet.has(command.id));
      }

      setClockOffsetMs(serverNowMs - Date.now());

      let reconciled = state;

      for (const command of pendingRef.current) {
        reconciled = applyLocalEnvelope(reconciled, command);
      }

      setBaseState(reconciled);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;

    const fetchInitialSnapshot = async () => {
      try {
        const response = await fetch(`/api/games/${gameId}`);
        if (!response.ok) {
          setError("Game not found.");
          return;
        }

        const payload = (await response.json()) as { game?: GameView };
        if (!cancelled && payload.game !== undefined) {
          setBaseState(payload.game.state);
        }
      } catch {
        if (!cancelled) {
          setError("Unable to fetch game snapshot.");
        }
      }
    };

    const connect = () => {
      if (cancelled) {
        return;
      }

      setConnectionState("connecting");
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnectionState("online");
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
          setError(parsed.message);
          return;
        }

        if (parsed.type === "game-snapshot") {
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
        setConnectionState("offline");
        wsRef.current = null;
        if (!cancelled) {
          reconnectTimeoutRef.current = window.setTimeout(connect, 1_000);
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
      if (wsRef.current !== null) {
        wsRef.current.close();
      }
      if (reconnectTimeoutRef.current !== null) {
        window.clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [flushPendingCommands, gameId, reconcileWithServer, role, wsUrl]);

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

        pendingRef.current = [...pendingRef.current, envelope];
        const next = applyLocalEnvelope(previous, envelope);

        window.setTimeout(flushPendingCommands, 0);

        return next;
      });
    },
    [clockOffsetMs, flushPendingCommands, role],
  );

  return {
    baseState,
    clockOffsetMs,
    dispatchCommand,
    connectionState,
    pendingCommands: pendingRef.current.length,
    error,
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

function parseClockInput(value: string): number | null {
  const parts = value.trim().split(":");
  if (parts.length !== 2) {
    return null;
  }

  const minutes = Number(parts[0]);
  const seconds = Number(parts[1]);
  if (
    !Number.isInteger(minutes) ||
    !Number.isInteger(seconds) ||
    minutes < 0 ||
    seconds < 0 ||
    seconds >= 60
  ) {
    return null;
  }

  return (minutes * 60 + seconds) * 1_000;
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
