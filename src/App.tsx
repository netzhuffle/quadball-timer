import { lazy, useCallback, useEffect, useRef, useState } from "react";
import { DeferredRoute } from "@/components/deferred-route";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ControllerRole } from "@/lib/game-types";
import { EventGameControllerPage } from "@/pages/event-game-controller-page";
import { GamePage } from "@/pages/game-page";
import {
  getAdHocBrowserId,
  hasAdHocHandoffAttempt,
  parseAdHocHandoffHash,
  type AdHocHandoff,
} from "@/lib/ad-hoc-handoff";
import {
  PublicEventGamePage,
  PublicEventHomePage,
  PublicEventPage,
} from "@/pages/public-event-page";
import { useControllerDepartureEntry } from "@/components/controller-departure";
import "./index.css";

// Controllers and their action panels stay in the initial graph, including offline actions.
const ColorTestPage = lazy(() =>
  import("@/pages/color-test-page").then((module) => ({ default: module.ColorTestPage })),
);
const EventOperationsPrototypePage = lazy(() =>
  import("@/pages/event-operations-prototype-page").then((module) => ({
    default: module.EventOperationsPrototypePage,
  })),
);
const EventAdminPage = lazy(() =>
  import("@/pages/event-admin-page").then((module) => ({ default: module.EventAdminPage })),
);
const PitchManagerPage = lazy(() =>
  import("@/pages/pitch-manager-page").then((module) => ({ default: module.PitchManagerPage })),
);
const TechnicalAdminPage = lazy(() =>
  import("@/pages/technical-admin-page").then((module) => ({ default: module.TechnicalAdminPage })),
);

type Route =
  | {
      type: "home";
      showAll?: boolean;
    }
  | {
      type: "event";
      showSchedule?: boolean;
      eventId: string;
    }
  | {
      type: "event-game";
      eventId: string;
      eventGameId: string;
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
    return <PublicEventPage eventId={route.eventId} showSchedule={route.showSchedule} />;
  }

  if (route.type === "event-game") {
    return <PublicEventGamePage eventId={route.eventId} eventGameId={route.eventGameId} />;
  }

  if (route.type === "color-test") {
    return (
      <DeferredRoute key={route.type} name="Color test">
        <ColorTestPage />
      </DeferredRoute>
    );
  }

  if (route.type === "event-operations-prototype") {
    return (
      <DeferredRoute key={route.type} name="Event operations prototype">
        <EventOperationsPrototypePage />
      </DeferredRoute>
    );
  }

  if (route.type === "event-admin") {
    return (
      <DeferredRoute key={route.type} name="Event administration">
        <EventAdminPage />
      </DeferredRoute>
    );
  }

  if (route.type === "pitch-manager") {
    return (
      <DeferredRoute key={route.type} name="Pitch management">
        <PitchManagerPage />
      </DeferredRoute>
    );
  }

  if (route.type === "event-game-controller") {
    return <EventGameControllerPage />;
  }

  if (route.type === "technical-admin") {
    return (
      <DeferredRoute key={route.type} name="Technical administration">
        <TechnicalAdminPage enrollment={route.enrollment} />
      </DeferredRoute>
    );
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
  const handoffTriggerRef = useRef<HTMLButtonElement | null>(null);
  const startedRef = useRef(false);

  const admit = useCallback(async () => {
    setMessage("Joining Ad Hoc Game…");
    try {
      const response = await fetch(`/api/games/${handoff.gameId}/admit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ controlQr: handoff.controlQr, browserId: getAdHocBrowserId() }),
      });
      if (!response.ok) throw new Error("unavailable");
      navigateTo(`/game/${handoff.gameId}`);
      return true;
    } catch {
      setMessage("Ad Hoc Game unavailable.");
      return false;
    }
  }, [handoff.controlQr, handoff.gameId]);
  const entry = useControllerDepartureEntry({
    destination: { kind: "admit-ad-hoc", gameId: handoff.gameId },
    triggerRef: handoffTriggerRef,
    onCommitted: admit,
    onUnavailable: () => setMessage("Ad Hoc Game unavailable."),
    onCancelled: () => setMessage("Join cancelled. Your Controller return is still available."),
  });

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void entry.begin().catch(() => setMessage("Ad Hoc Game unavailable."));
  }, [entry]);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-xl items-center p-6">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Ad Hoc Controller handoff</CardTitle>
          <CardDescription>{message}</CardDescription>
          <button
            ref={handoffTriggerRef}
            type="button"
            className="mt-4 rounded-md border px-3 py-2 text-sm font-medium"
            disabled={entry.busy}
            onClick={() => void entry.begin()}
          >
            Join this Ad Hoc Game
          </button>
        </CardHeader>
      </Card>
      {entry.dialog}
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

  const eventGameMatch = pathname.match(/^\/events\/([^/]+)\/games\/([^/]+)$/);
  if (eventGameMatch !== null) {
    try {
      return {
        type: "event-game",
        eventId: decodeURIComponent(eventGameMatch[1] ?? ""),
        eventGameId: decodeURIComponent(eventGameMatch[2] ?? ""),
      };
    } catch {
      return { type: "home" };
    }
  }

  const eventMatch = pathname.match(/^\/events\/([^/]+)$/);
  if (eventMatch !== null) {
    try {
      return {
        type: "event",
        eventId: decodeURIComponent(eventMatch[1] ?? ""),
        ...(new URLSearchParams(search).get("view") === "schedule" ? { showSchedule: true } : {}),
      };
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
