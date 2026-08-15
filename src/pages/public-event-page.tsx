import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getAdHocBrowserId } from "@/lib/ad-hoc-handoff";
import type { PublicAudienceEventProjection } from "@/lib/audience-projection";
import { DEFAULT_AWAY_TEAM_COLOR, DEFAULT_HOME_TEAM_COLOR } from "@/lib/team-colors";

export function PublicEventHomePage({ showAll = false }: { showAll?: boolean }) {
  const [events, setEvents] = useState<readonly PublicAudienceEventProjection[] | null>(null);
  const [discoveryUnavailable, setDiscoveryUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    void fetch("/api/audience/events")
      .then(async (response) => {
        if (!response.ok) throw new Error("Audience discovery unavailable");
        const payload = (await response.json()) as AudienceEventsResponse;
        if (payload.status !== "accepted") throw new Error("Audience discovery unavailable");
        return payload.value.events;
      })
      .then((nextEvents) => {
        if (!active) return;
        const current = nextEvents.filter((event) => event.lifecycle === "current");
        if (!showAll && current.length === 1) {
          navigateTo(current[0]!.canonicalPath);
          return;
        }
        setEvents(nextEvents);
      })
      .catch(() => {
        if (active) setDiscoveryUnavailable(true);
      });
    return () => {
      active = false;
    };
  }, [showAll]);

  return (
    <PublicShell
      title="Public Event discovery"
      description="Find a Published Event and follow its public schedule. No sign-in is required."
    >
      {events === null && !discoveryUnavailable ? (
        <div className="space-y-6">
          <p className="rounded-2xl border bg-card/80 p-5 text-sm text-muted-foreground">
            Loading Published Events…
          </p>
          <StartAdHocGame />
        </div>
      ) : discoveryUnavailable ? (
        <div className="space-y-6">
          <p className="rounded-2xl border bg-card/80 p-5 text-sm text-muted-foreground">
            Event discovery is unavailable.
          </p>
          <StartAdHocGame />
        </div>
      ) : (
        <EventDiscovery events={events ?? []} />
      )}
    </PublicShell>
  );
}

export function PublicEventPage({ eventId }: { eventId: string }) {
  const [event, setEvent] = useState<PublicAudienceEventProjection | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    setEvent(null);
    setUnavailable(false);
    void fetch(`/api/audience/events/${encodeURIComponent(eventId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Event unavailable");
        const payload = (await response.json()) as AudienceEventResponse;
        if (payload.status !== "accepted") throw new Error("Event unavailable");
        return payload.value;
      })
      .then((nextEvent) => {
        if (active) setEvent(nextEvent);
      })
      .catch(() => {
        if (active) setUnavailable(true);
      });
    return () => {
      active = false;
    };
  }, [eventId]);

  if (unavailable) return <UnavailablePanel />;
  if (event === null) {
    return (
      <PublicShell title="Published Event" description="Loading public Event information…">
        <p className="rounded-2xl border bg-card/80 p-5 text-sm text-muted-foreground">Loading…</p>
      </PublicShell>
    );
  }

  return (
    <PublicShell title={event.name} description={`Published Event · ${event.timeZone}`}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{lifecycleLabel(event.lifecycle)}</p>
          <Button variant="outline" onClick={() => navigateTo("/events?view=all")}>
            All events
          </Button>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Game Days</CardTitle>
            <CardDescription>
              Published Event information from the authoritative catalog.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {event.gameDays.length === 0 ? (
              <p className="text-sm text-muted-foreground">No Game Days have been scheduled.</p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {event.gameDays.map((date) => (
                  <li key={date} className="rounded-xl border px-3 py-2 text-sm">
                    {date}
                  </li>
                ))}
              </ul>
            )}
            {event.teams.length > 0 && (
              <div>
                <h2 className="text-sm font-semibold">Event Teams</h2>
                <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                  {event.teams.map((team) => (
                    <li
                      key={`${team.name}-${team.color}`}
                      className="rounded-xl border px-3 py-2 text-sm"
                    >
                      {team.name}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {event.pitches.length > 0 && (
              <div>
                <h2 className="text-sm font-semibold">Pitches</h2>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {event.pitches.map((pitch) => (
                    <li key={pitch.name} className="rounded-full border px-3 py-1 text-sm">
                      {pitch.name}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </PublicShell>
  );
}

function EventDiscovery({ events }: { events: readonly PublicAudienceEventProjection[] }) {
  const current = events.filter((event) => event.lifecycle === "current");
  const future = events.filter((event) => event.lifecycle === "future");
  const unscheduled = events.filter((event) => event.lifecycle === "unscheduled");
  const past = events.filter((event) => event.lifecycle === "past");

  return (
    <div className="space-y-6">
      <EventGroup title="Current Events" events={current} empty="No Event is current today." />
      <EventGroup title="Upcoming Events" events={future} empty="No upcoming Published Events." />
      <EventGroup
        title="Unscheduled Events"
        events={unscheduled}
        empty="No unscheduled Published Events."
      />
      <StartAdHocGame />
      <EventGroup title="Past Events" events={past} empty="No past Published Events." />
    </div>
  );
}

function EventGroup({
  title,
  events,
  empty,
}: {
  title: string;
  events: readonly PublicAudienceEventProjection[];
  empty: string;
}) {
  return (
    <section aria-labelledby={title.toLowerCase().replaceAll(" ", "-")}>
      <h2 id={title.toLowerCase().replaceAll(" ", "-")} className="mb-3 text-xl font-semibold">
        {title}
      </h2>
      {events.length === 0 ? (
        <p className="rounded-2xl border border-dashed p-4 text-sm text-muted-foreground">
          {empty}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {events.map((event) => (
            <a
              key={event.eventId}
              href={event.canonicalPath}
              className="rounded-2xl border bg-card/80 p-4 shadow-sm transition hover:border-primary focus:outline-none focus:ring-2 focus:ring-ring"
              onClick={(click) => {
                if (
                  click.button !== 0 ||
                  click.metaKey ||
                  click.ctrlKey ||
                  click.shiftKey ||
                  click.altKey
                )
                  return;
                click.preventDefault();
                navigateTo(event.canonicalPath);
              }}
            >
              <span className="font-semibold">{event.name}</span>
              <span className="mt-1 block text-sm text-muted-foreground">
                {event.gameDays.length > 0 ? event.gameDays.join(" · ") : "Unscheduled"}
              </span>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

function StartAdHocGame() {
  const [homeName, setHomeName] = useState("Home");
  const [awayName, setAwayName] = useState("Away");
  const [homeColor, setHomeColor] = useState(DEFAULT_HOME_TEAM_COLOR);
  const [awayColor, setAwayColor] = useState(DEFAULT_AWAY_TEAM_COLOR);
  const [creationStatus, setCreationStatus] = useState<string | null>(null);
  const [creationAlert, setCreationAlert] = useState(false);
  const [creationPending, setCreationPending] = useState(false);
  const creationPendingRef = useRef(false);
  const creationRetryTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
      if (creationRetryTimerRef.current !== null)
        window.clearTimeout(creationRetryTimerRef.current);
      creationRetryTimerRef.current = null;
      creationPendingRef.current = false;
    },
    [],
  );

  const handleCreateGame = useCallback(
    async (attempt = 0) => {
      if (!mountedRef.current) return;
      if (attempt === 0) {
        if (creationPendingRef.current) return;
        creationPendingRef.current = true;
        setCreationPending(true);
      }
      setCreationAlert(false);
      setCreationStatus(attempt === 0 ? "Creating Ad Hoc Game…" : "Retrying Ad Hoc Game…");

      let response: Response;
      try {
        response = await fetch("/api/games", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            homeName,
            awayName,
            homeColor,
            awayColor,
            browserId: getAdHocBrowserId(),
          }),
        });
      } catch {
        if (mountedRef.current) {
          setCreationAlert(true);
          setCreationStatus("Ad Hoc Game unavailable. Try again later.");
        }
        creationPendingRef.current = false;
        setCreationPending(false);
        return;
      }
      if (!mountedRef.current) return;

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: unknown;
          retryAfterMs?: unknown;
        } | null;
        const capacityMessage =
          typeof payload?.error === "string" && payload.error.startsWith("Ad Hoc capacity")
            ? payload.error
            : null;
        if (response.status === 429 && attempt < 3 && capacityMessage === null) {
          const headerDelayMs = Number(response.headers.get("retry-after")) * 1_000;
          const retryAfterMs = Math.min(
            30_000,
            Math.max(
              1_000,
              typeof payload?.retryAfterMs === "number" ? payload.retryAfterMs : headerDelayMs,
            ),
          );
          setCreationStatus(
            `Ad Hoc creation busy. Retrying in ${Math.ceil(retryAfterMs / 1_000)}s.`,
          );
          if (creationRetryTimerRef.current !== null)
            window.clearTimeout(creationRetryTimerRef.current);
          creationRetryTimerRef.current = window.setTimeout(() => {
            creationRetryTimerRef.current = null;
            void handleCreateGame(attempt + 1);
          }, retryAfterMs);
          return;
        }
        setCreationAlert(true);
        setCreationStatus(capacityMessage ?? "Ad Hoc Game unavailable. Try again later.");
        creationPendingRef.current = false;
        setCreationPending(false);
        return;
      }

      const payload = (await response.json()) as { gameId?: string };
      if (typeof payload.gameId === "string") {
        creationPendingRef.current = false;
        setCreationPending(false);
        navigateTo(`/game/${payload.gameId}`);
        return;
      }
      setCreationAlert(true);
      setCreationStatus("Ad Hoc Game unavailable. Try again later.");
      creationPendingRef.current = false;
      setCreationPending(false);
    },
    [awayColor, awayName, homeColor, homeName],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Start Ad Hoc Game</CardTitle>
        <CardDescription>
          Need an unscheduled Game? Start one here as an equal Ad Hoc Controller.
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
        <Button
          className="w-full"
          disabled={creationPending}
          onClick={() => void handleCreateGame()}
        >
          Start an Ad Hoc Game <span className="sr-only">Create new game</span>
        </Button>
        {creationStatus !== null ? (
          <p
            className={creationAlert ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
            role={creationAlert ? "alert" : "status"}
            aria-live="polite"
          >
            {creationStatus}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function PublicShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-5xl p-4 pb-12 sm:p-6">
      <header className="mb-6 rounded-2xl border bg-card/80 p-5 shadow-sm backdrop-blur">
        <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
          Quadball Timer
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      </header>
      {children}
    </div>
  );
}

function UnavailablePanel() {
  return (
    <PublicShell title="Event unavailable" description="This Published Event is not available.">
      <Card>
        <CardContent className="space-y-4 pt-6">
          <p className="text-sm text-muted-foreground">
            The Event may be hidden, unknown, or temporarily unavailable.
          </p>
          <Button onClick={() => navigateTo("/events?view=all")}>Back to Home</Button>
        </CardContent>
      </Card>
    </PublicShell>
  );
}

function lifecycleLabel(lifecycle: PublicAudienceEventProjection["lifecycle"]): string {
  return lifecycle === "current"
    ? "Current Event"
    : lifecycle === "future"
      ? "Upcoming Event"
      : lifecycle === "unscheduled"
        ? "Unscheduled Event"
        : "Past Event";
}

type AudienceEventResponse =
  | { status: "accepted"; value: PublicAudienceEventProjection }
  | { status: "unavailable" };
type AudienceEventsResponse =
  | { status: "accepted"; value: { events: readonly PublicAudienceEventProjection[] } }
  | { status: "unavailable" };

function navigateTo(path: string) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
