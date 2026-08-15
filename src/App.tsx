import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ControllerRole } from "@/lib/game-types";
import { DEFAULT_AWAY_TEAM_COLOR, DEFAULT_HOME_TEAM_COLOR } from "@/lib/team-colors";
import { ColorTestPage } from "@/pages/color-test-page";
import { EventOperationsPrototypePage } from "@/pages/event-operations-prototype-page";
import { EventAdminPage } from "@/pages/event-admin-page";
import { PitchManagerPage } from "@/pages/pitch-manager-page";
import { EventGameControllerPage } from "@/pages/event-game-controller-page";
import { GamePage } from "@/pages/game-page";
import { TechnicalAdminPage } from "@/pages/technical-admin-page";
import "./index.css";

type Route =
  | {
      type: "home";
    }
  | {
      type: "color-test";
    }
  | {
      type: "event-operations-prototype";
    }
  | {
      type: "event-admin";
    }
  | {
      type: "pitch-manager";
    }
  | {
      type: "event-game-controller";
    }
  | {
      type: "technical-admin";
      enrollment: boolean;
    }
  | {
      type: "game";
      gameId: string;
      role: ControllerRole;
    };

export function App() {
  const route = useRoute();

  if (route.type === "home") {
    return <HomePage />;
  }

  if (route.type === "color-test") {
    return <ColorTestPage />;
  }

  if (route.type === "event-operations-prototype") {
    return <EventOperationsPrototypePage />;
  }

  if (route.type === "event-admin") {
    return <EventAdminPage />;
  }

  if (route.type === "pitch-manager") {
    return <PitchManagerPage />;
  }

  if (route.type === "event-game-controller") {
    return <EventGameControllerPage />;
  }

  if (route.type === "technical-admin") {
    return <TechnicalAdminPage enrollment={route.enrollment} />;
  }

  return <GamePage gameId={route.gameId} role={route.role} />;
}

function HomePage() {
  const [homeName, setHomeName] = useState("Home");
  const [awayName, setAwayName] = useState("Away");
  const [homeColor, setHomeColor] = useState(DEFAULT_HOME_TEAM_COLOR);
  const [awayColor, setAwayColor] = useState(DEFAULT_AWAY_TEAM_COLOR);

  const handleCreateGame = useCallback(async () => {
    const response = await fetch("/api/games", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        homeName,
        awayName,
        homeColor,
        awayColor,
      }),
    });

    if (!response.ok) {
      return;
    }

    const payload = (await response.json()) as { gameId?: string };
    if (typeof payload.gameId === "string") {
      navigateTo(`/game/${payload.gameId}`);
    }
  }, [awayColor, awayName, homeColor, homeName]);

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
        <div className="mt-3">
          <Button size="sm" variant="outline" onClick={() => navigateTo("/color-test")}>
            Open color test page
          </Button>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[1fr_2fr]">
        <Card>
          <CardHeader>
            <CardTitle>Start an Ad Hoc Game</CardTitle>
            <CardDescription>
              You are admitted as the initially admitted Ad Hoc Controller.
            </CardDescription>
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
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="home-color">Home color</Label>
                <Input
                  id="home-color"
                  type="color"
                  value={homeColor}
                  onChange={(event) => setHomeColor(event.target.value)}
                  className="h-10 cursor-pointer p-1"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="away-color">Away color</Label>
                <Input
                  id="away-color"
                  type="color"
                  value={awayColor}
                  onChange={(event) => setAwayColor(event.target.value)}
                  className="h-10 cursor-pointer p-1"
                />
              </div>
            </div>
            <Button className="w-full" onClick={handleCreateGame}>
              Start an Ad Hoc Game <span className="sr-only">Create new game</span>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Private Controller access</CardTitle>
            <CardDescription>
              Retained Ad Hoc Games are never listed or spectated publicly.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Control starts immediately after atomic creation and admission.
            </p>
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

export function parseRoute(pathname: string, _search: string): Route {
  if (pathname === "/admin" || pathname === "/admin/") {
    return { type: "technical-admin", enrollment: false };
  }

  if (pathname === "/admin/enroll" || pathname === "/admin/enroll/") {
    return { type: "technical-admin", enrollment: true };
  }

  if (pathname === "/events" || pathname === "/events/") {
    return { type: "home" };
  }

  if (pathname === "/color-test") {
    return { type: "color-test" };
  }

  if (pathname === "/prototype/event-operations") {
    return { type: "event-operations-prototype" };
  }

  if (pathname === "/event-admin" || pathname === "/event-admin/") {
    return { type: "event-admin" };
  }
  if (pathname === "/pitch-manager" || pathname === "/pitch-manager/") {
    return { type: "pitch-manager" };
  }

  if (pathname === "/event-control" || pathname === "/event-control/") {
    return { type: "event-game-controller" };
  }

  const match = pathname.match(/^\/game\/([a-zA-Z0-9_-]+)$/);
  if (match === null) {
    return { type: "home" };
  }

  return {
    type: "game",
    gameId: match[1] ?? "",
    role: "controller",
  };
}

function navigateTo(path: string) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export default App;
