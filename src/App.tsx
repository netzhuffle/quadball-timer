import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ControllerRole, GameSummary } from "@/lib/game-types";
import { GamePage } from "@/pages/game-page";
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
        if (
          parsed === null ||
          parsed.type !== "lobby-snapshot" ||
          !Array.isArray(parsed.games) ||
          typeof parsed.serverNowMs !== "number"
        ) {
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
                          {game.isFinished
                            ? "Past"
                            : game.isSuspended
                              ? "Suspended"
                              : game.isRunning
                                ? "Running"
                                : "Paused"}{" "}
                          • {formatClock(displayClock)}
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

function parseServerMessage(
  input: unknown,
): { type?: string; games?: GameSummary[]; serverNowMs?: number } | null {
  if (typeof input !== "string") {
    return null;
  }

  try {
    return JSON.parse(input) as { type?: string; games?: GameSummary[]; serverNowMs?: number };
  } catch {
    return null;
  }
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

function deriveLiveClockMs(game: GameSummary, nowMs: number) {
  if (!game.isRunning || game.isFinished) {
    return game.gameClockMs;
  }

  return game.gameClockMs + Math.max(0, nowMs - game.updatedAtMs);
}

export default App;
