import { useEffect, useState } from "react";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ControllerRole } from "@/lib/game-types";
import { ColorTestPage } from "@/pages/color-test-page";
import { EventOperationsPrototypePage } from "@/pages/event-operations-prototype-page";
import { EventAdminPage } from "@/pages/event-admin-page";
import { PitchManagerPage } from "@/pages/pitch-manager-page";
import { EventGameControllerPage } from "@/pages/event-game-controller-page";
import { GamePage } from "@/pages/game-page";
import {
  getAdHocBrowserId,
  hasAdHocHandoffAttempt,
  parseAdHocHandoffHash,
  type AdHocHandoff,
} from "@/lib/ad-hoc-handoff";
import { PublicEventHomePage, PublicEventPage } from "@/pages/public-event-page";
import { TechnicalAdminPage } from "@/pages/technical-admin-page";
import "./index.css";

type Route =
  | {
      type: "home";
      showAll?: boolean;
    }
  | {
      type: "event";
      eventId: string;
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
    }
  | {
      type: "ad-hoc-handoff";
      handoff: AdHocHandoff;
    }
  | {
      type: "ad-hoc-unavailable";
    };

export function App({
  initialAdHocHandoff = null,
  initialAdHocHandoffAttempted = false,
}: {
  initialAdHocHandoff?: AdHocHandoff | null;
  initialAdHocHandoffAttempted?: boolean;
}) {
  const route = useRoute(initialAdHocHandoff, initialAdHocHandoffAttempted);

  if (route.type === "home") {
    return <PublicEventHomePage showAll={route.showAll} />;
  }

  if (route.type === "event") {
    return <PublicEventPage eventId={route.eventId} />;
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

  if (route.type === "ad-hoc-handoff") {
    return <AdHocHandoffPage handoff={route.handoff} />;
  }

  if (route.type === "ad-hoc-unavailable") {
    return (
      <div className="mx-auto flex min-h-screen w-full max-w-xl items-center p-6">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Ad Hoc Game unavailable.</CardTitle>
            <CardDescription>
              This Ad Hoc handoff is invalid or no longer available.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return <GamePage gameId={route.gameId} role={route.role} />;
}

function AdHocHandoffPage({ handoff }: { handoff: AdHocHandoff }) {
  const [message, setMessage] = useState("Joining Ad Hoc Game…");

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/games/${handoff.gameId}/admit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ controlQr: handoff.controlQr, browserId: getAdHocBrowserId() }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("unavailable");
        if (cancelled) return;
        navigateTo(`/game/${handoff.gameId}`);
      })
      .catch(() => {
        if (!cancelled) setMessage("Ad Hoc Game unavailable.");
      });

    return () => {
      cancelled = true;
    };
  }, [handoff.controlQr, handoff.gameId]);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-xl items-center p-6">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Ad Hoc Controller handoff</CardTitle>
          <CardDescription>{message}</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

function useRoute(
  initialAdHocHandoff: AdHocHandoff | null,
  initialAdHocHandoffAttempted: boolean,
): Route {
  const [route, setRoute] = useState<Route>(() =>
    initialAdHocHandoff !== null
      ? { type: "ad-hoc-handoff", handoff: initialAdHocHandoff }
      : initialAdHocHandoffAttempted
        ? { type: "ad-hoc-unavailable" }
        : parseRoute(window.location.pathname, window.location.search, window.location.hash),
  );

  useEffect(() => {
    const onPopState = () => {
      setRoute(parseRoute(window.location.pathname, window.location.search, window.location.hash));
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return route;
}

export function parseRoute(pathname: string, search: string, hash = ""): Route {
  const handoff = parseAdHocHandoffHash(hash);
  if (handoff !== null) {
    return { type: "ad-hoc-handoff", handoff };
  }
  if (hasAdHocHandoffAttempt(hash)) {
    return { type: "ad-hoc-unavailable" };
  }
  if (pathname === "/admin" || pathname === "/admin/") {
    return { type: "technical-admin", enrollment: false };
  }

  if (pathname === "/admin/enroll" || pathname === "/admin/enroll/") {
    return { type: "technical-admin", enrollment: true };
  }

  if (pathname === "/events" || pathname === "/events/") {
    return {
      type: "home",
      ...(new URLSearchParams(search).get("view") === "all" ? { showAll: true } : {}),
    };
  }

  const eventMatch = pathname.match(/^\/events\/([^/]+)$/);
  if (eventMatch !== null) {
    try {
      return { type: "event", eventId: decodeURIComponent(eventMatch[1] ?? "") };
    } catch {
      return { type: "home" };
    }
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
