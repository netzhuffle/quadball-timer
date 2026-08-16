import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getAdHocBrowserId } from "@/lib/ad-hoc-handoff";
import type {
  PublicAudienceEventProjection,
  PublicAudienceGameProjection,
  PublicAudienceScheduleProjection,
} from "@/lib/audience-projection";
import {
  applyPublicEventStreamMessage,
  createPublicEventStreamReplica,
  PUBLIC_EVENT_STREAM_PROTOCOL,
  type PublicAudienceProjectionMessage,
} from "@/lib/public-event-stream";
import { DEFAULT_AWAY_TEAM_COLOR, DEFAULT_HOME_TEAM_COLOR } from "@/lib/team-colors";
import { PublicGameTimeline } from "@/pages/public-game-timeline";
import {
  ControllerDepartureReturnCard,
  useControllerDepartureEntry,
} from "@/components/controller-departure";
import { getBrowserControllerDeparture } from "@/lib/controller-departure";

export function PublicEventHomePage({ showAll = false }: { showAll?: boolean }) {
  const [events, setEvents] = useState<readonly PublicAudienceEventProjection[] | null>(null);
  const [discoveryUnavailable, setDiscoveryUnavailable] = useState(false);
  const departureModule = getBrowserControllerDeparture();

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
        if (!showAll && current.length === 1 && departureModule.project().status !== "returnable") {
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
  }, [departureModule, showAll]);

  return (
    <PublicShell
      title="Public Event discovery"
      description="Find a Published Event and follow its public schedule. No sign-in is required."
    >
      {events === null && !discoveryUnavailable ? (
        <div className="space-y-6">
          <ControllerDepartureReturnCard />
          <p
            className="rounded-2xl border bg-card/80 p-5 text-sm text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            Loading Published Events…
          </p>
          <StartAdHocGame />
        </div>
      ) : discoveryUnavailable ? (
        <div className="space-y-6">
          <ControllerDepartureReturnCard />
          <p
            className="rounded-2xl border bg-card/80 p-5 text-sm text-muted-foreground"
            role="alert"
          >
            Event discovery is unavailable.
          </p>
          <StartAdHocGame />
        </div>
      ) : (
        <div className="space-y-6">
          <ControllerDepartureReturnCard />
          <EventDiscovery events={events ?? []} />
        </div>
      )}
    </PublicShell>
  );
}

export function PublicEventPage({ eventId }: { eventId: string }) {
  const { event, unavailable, connectionStatus } = usePublicEventProjection(eventId);

  if (unavailable) return <UnavailablePanel />;
  if (event === null) {
    return (
      <PublicShell title="Published Event" description="Loading public Event information…">
        <p
          className="rounded-2xl border bg-card/80 p-5 text-sm text-muted-foreground"
          role="status"
        >
          Loading…
        </p>
      </PublicShell>
    );
  }

  const schedule = event.schedule;

  return (
    <PublicShell title={event.name} description={`Published Event · ${event.timeZone}`}>
      <div className="space-y-4">
        {event.teamAssignmentNotice !== undefined ? <TeamAssignmentCorrectionNotice /> : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{lifecycleLabel(event.lifecycle)}</p>
          <Button variant="outline" onClick={() => navigateTo("/events?view=all")}>
            All events
          </Button>
        </div>
        <LiveProjectionStatus status={connectionStatus} message={eventAnnouncement(event)} />
        <ScheduleBoard schedule={schedule} timeZone={event.timeZone} />
        <Card>
          <CardHeader>
            <h2 className="text-base leading-none font-semibold">Game Days</h2>
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
                <h3 className="text-sm font-semibold">Event Teams</h3>
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
            {event.pitches.length > 1 && (
              <div>
                <h3 className="text-sm font-semibold">Pitches</h3>
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

function usePublicEventProjection(eventId: string) {
  const [event, setEvent] = useState<PublicAudienceEventProjection | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<
    "loading" | "connected" | "reconnecting" | "unavailable"
  >("loading");

  useEffect(() => {
    let active = true;
    let socket: WebSocket | null = null;
    let reconnectAttempts = 0;
    let recovering = false;
    let terminalUnavailable = false;
    setEvent(null);
    setUnavailable(false);
    setConnectionStatus("loading");

    const readAuthoritativeEvent = async () => {
      const response = await fetch(`/api/audience/events/${encodeURIComponent(eventId)}`);
      if (!response.ok) throw new Error("Event unavailable");
      const payload = (await response.json()) as AudienceEventResponse;
      if (payload.status !== "accepted") throw new Error("Event unavailable");
      return payload.value;
    };

    const makeReplica = (nextEvent: PublicAudienceEventProjection) => {
      const nextReplica = createPublicEventStreamReplica<PublicAudienceEventProjection>(eventId);
      applyPublicEventStreamMessage(nextReplica, {
        protocol: PUBLIC_EVENT_STREAM_PROTOCOL,
        type: "snapshot",
        eventId,
        version: 0,
        projection: nextEvent,
      });
      return nextReplica;
    };

    let recoverFromDisconnect: () => Promise<void>;
    const connect = (replica: ReturnType<typeof makeReplica>) => {
      if (!active || terminalUnavailable) return;
      const connection = new WebSocket(publicEventWebSocketUrl());
      socket = connection;
      connection.onopen = () => {
        setConnectionStatus("connected");
        connection.send(JSON.stringify({ type: "subscribe-public-event", eventId }));
      };
      connection.onmessage = (message) => {
        if (!active || socket !== connection) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(message.data);
        } catch {
          return;
        }
        if (!isPublicAudienceProjectionMessage(parsed, eventId)) return;
        const result = applyPublicEventStreamMessage(replica, parsed);
        if (result.status === "unavailable" && parsed.type === "event-unavailable") {
          terminalUnavailable = true;
          setEvent(null);
          setUnavailable(true);
          setConnectionStatus("unavailable");
          connection.close();
          return;
        }
        if (result.status !== "applied" || replica.projection === null) return;
        setEvent(replica.projection);
        setConnectionStatus("connected");
      };
      connection.onclose = () => {
        if (!active || terminalUnavailable || socket !== connection) return;
        socket = null;
        setConnectionStatus("reconnecting");
        void recoverFromDisconnect();
      };
    };

    recoverFromDisconnect = async () => {
      if (!active || terminalUnavailable || recovering) return;
      if (reconnectAttempts >= PUBLIC_EVENT_MAX_RECONNECT_ATTEMPTS) {
        setUnavailable(true);
        setConnectionStatus("unavailable");
        return;
      }
      recovering = true;
      reconnectAttempts += 1;
      try {
        const nextEvent = await readAuthoritativeEvent();
        if (!active || terminalUnavailable) return;
        setEvent(nextEvent);
        reconnectAttempts = 0;
        connect(makeReplica(nextEvent));
      } catch {
        if (active) {
          setUnavailable(true);
          setConnectionStatus("unavailable");
        }
      } finally {
        recovering = false;
      }
    };

    void readAuthoritativeEvent()
      .then((nextEvent) => {
        if (!active) return;
        setEvent(nextEvent);
        reconnectAttempts = 0;
        connect(makeReplica(nextEvent));
      })
      .catch(() => {
        if (active) {
          setEvent(null);
          setUnavailable(true);
          setConnectionStatus("unavailable");
        }
      });
    return () => {
      active = false;
      terminalUnavailable = true;
      socket?.close();
    };
  }, [eventId]);

  return { event, unavailable, connectionStatus };
}

const PUBLIC_EVENT_MAX_RECONNECT_ATTEMPTS = 2;

function publicEventWebSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function isPublicAudienceProjectionMessage(
  value: unknown,
  eventId: string,
): value is PublicAudienceProjectionMessage<PublicAudienceEventProjection> {
  if (value === null || typeof value !== "object") return false;
  const message = value as { protocol?: unknown; eventId?: unknown; type?: unknown };
  return (
    message.protocol === PUBLIC_EVENT_STREAM_PROTOCOL &&
    message.eventId === eventId &&
    (message.type === "snapshot" ||
      message.type === "projection-replaced" ||
      message.type === "event-unavailable")
  );
}

export function PublicEventGamePage({
  eventId,
  eventGameId,
}: {
  eventId: string;
  eventGameId: string;
}) {
  const { event, unavailable, connectionStatus } = usePublicEventProjection(eventId);
  const game =
    event?.schedule.scheduleGames.find((candidate) => candidate.eventGameId === eventGameId) ??
    null;
  const [compactScoreboard, setCompactScoreboard] = useState(false);
  const scoreboardSentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const sentinel = scoreboardSentinelRef.current;
    if (sentinel === null) return;
    if (typeof IntersectionObserver === "function") {
      const observer = new IntersectionObserver(([entry]) => {
        setCompactScoreboard(entry?.isIntersecting === false);
      });
      observer.observe(sentinel);
      return () => observer.disconnect();
    }
    const update = () => setCompactScoreboard(window.scrollY > 120);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, [game]);

  if (unavailable) return <GameUnavailablePanel eventId={eventId} />;
  if (game === null || game.spectatorAvailable === false) {
    if (event !== null) return <GameUnavailablePanel eventId={eventId} />;
    return (
      <PublicShell title="Live spectator Game" description="Loading public Game information…">
        <p
          className="rounded-2xl border bg-card/80 p-5 text-sm text-muted-foreground"
          role="status"
        >
          Loading…
        </p>
      </PublicShell>
    );
  }

  const sides =
    game.presentation.pitchOrientation === "side-b-left"
      ? [
          { sideId: "side-b" as const, side: game.sideB, label: "Side B" },
          { sideId: "side-a" as const, side: game.sideA, label: "Side A" },
        ]
      : [
          { sideId: "side-a" as const, side: game.sideA, label: "Side A" },
          { sideId: "side-b" as const, side: game.sideB, label: "Side B" },
        ];
  const title = game.gameDesignation ?? game.gameCode ?? "Live spectator Game";

  return (
    <PublicShell title={title} description="Public Audience Projection · no sign-in required">
      <div className="space-y-4">
        {game.teamAssignmentNotice !== undefined ? <TeamAssignmentCorrectionNotice /> : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button
            variant="outline"
            onClick={() => navigateTo(`/events/${encodeURIComponent(eventId)}`)}
          >
            Back to Event
          </Button>
          <p className="text-sm text-muted-foreground">{game.pitch ?? "Event Game"}</p>
        </div>
        <LiveProjectionStatus status={connectionStatus} message={gameAnnouncement(game)} />
        <div
          ref={scoreboardSentinelRef}
          aria-hidden="true"
          className="h-px"
          data-scoreboard-sentinel
        />
        {compactScoreboard ? (
          <section
            aria-label="Compact live scoreboard"
            className="sticky top-2 z-10 rounded-2xl border bg-background/95 p-2 shadow-lg backdrop-blur"
            data-scoreboard-compact
          >
            <div className="mb-1 flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-[0.65rem] text-muted-foreground">
              <span>Game Phase: {gamePhaseLabel(game.phase)}</span>
              <span>Operational status: {operationalStatusLabel(game.operationalStatus)}</span>
              <span>Schedule: {scheduleStatusLabel(game.scheduleStatus)}</span>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
              <CompactScoreSide
                side={sides[0]!.side}
                label={sides[0]!.label}
                sideId={sides[0]!.sideId}
                isCatching={game.flagState.catchingSide === sides[0]!.sideId}
              />
              <div className="flex flex-col items-center">
                <span className="font-mono text-lg font-bold tabular-nums">
                  {formatClock(game.clock?.gameTimeMs ?? 0)}
                </span>
                <span className="text-[0.65rem] text-muted-foreground">
                  {clockFreshnessLabel(game.clock?.synchronization ?? "unavailable")}
                </span>
              </div>
              <CompactScoreSide
                side={sides[1]!.side}
                label={sides[1]!.label}
                align="right"
                sideId={sides[1]!.sideId}
                isCatching={game.flagState.catchingSide === sides[1]!.sideId}
              />
            </div>
          </section>
        ) : null}
        <section
          aria-label="Live scoreboard"
          className="rounded-3xl border bg-background/95 p-3 shadow-lg sm:p-5"
          data-scoreboard-expanded
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="font-semibold">{scheduleStatusLabel(game.scheduleStatus)}</span>
            <span className="text-muted-foreground">
              Game Phase: {gamePhaseLabel(game.phase)} · Operational status:{" "}
              {operationalStatusLabel(game.operationalStatus)}
            </span>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-stretch gap-2 sm:gap-4">
            <PublicScoreSide
              side={sides[0]!.side}
              label={sides[0]!.label}
              sideId={sides[0]!.sideId}
              isCatching={game.flagState.catchingSide === sides[0]!.sideId}
            />
            <div className="flex min-w-20 flex-col items-center justify-center rounded-2xl bg-muted/60 px-2 py-3">
              <span className="font-mono text-3xl font-bold tabular-nums sm:text-4xl">
                {formatClock(game.clock?.gameTimeMs ?? 0)}
              </span>
              <span className="mt-1 text-center text-xs text-muted-foreground">
                {clockFreshnessLabel(game.clock?.synchronization ?? "unavailable")}
              </span>
            </div>
            <PublicScoreSide
              side={sides[1]!.side}
              label={sides[1]!.label}
              align="right"
              sideId={sides[1]!.sideId}
              isCatching={game.flagState.catchingSide === sides[1]!.sideId}
            />
          </div>
          <div className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              Last synchronized:{" "}
              {formatLastSynchronization(game.clock?.lastSynchronizedAtMs ?? null)}
            </span>
            <span>Expected start: {formatDateTime(game.expectedStartMs)}</span>
          </div>
        </section>
        <Card>
          <CardHeader>
            <h2 className="text-base leading-none font-semibold">
              Game Phase and operational status
            </h2>
            <CardDescription>
              Committed public information from the Event Game&apos;s Audience Projection.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <dl className="grid gap-3 sm:grid-cols-2">
              <StatusValue label="Game Phase" value={gamePhaseLabel(game.phase)} />
              <StatusValue
                label="Operational status"
                value={operationalStatusLabel(game.operationalStatus)}
              />
              <StatusValue
                label="Overtime target"
                value={game.phase === "overtime" ? `Target ${game.overtimeTarget ?? "—"}` : "No"}
              />
              <StatusValue
                label="Flag"
                value={
                  game.flagState.catchingSide !== null
                    ? `Caught by ${game.flagState.catchingSide}`
                    : "Not caught"
                }
              />
              <StatusValue label="Team Timeout" value={timeoutLabel(game.teamTimeout)} />
              <StatusValue
                label="Game Suspension"
                value={game.gameSuspension === "suspended" ? "Suspended" : "None"}
              />
              <StatusValue label="Heat Stoppage" value={heatLabel(game.heatStoppage)} />
              <StatusValue label="Result" value={resultLabel(game.result)} />
            </dl>
            {game.timeline.length > 0 ? (
              <PublicGameTimeline entries={game.timeline} />
            ) : (
              <p className="rounded-xl border border-dashed p-3 text-muted-foreground">
                No public play history is available yet.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </PublicShell>
  );
}

function TeamAssignmentCorrectionNotice() {
  return (
    <p
      className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
      role="status"
    >
      An Event Team assignment was corrected. Current team identities are shown.
    </p>
  );
}

function PublicScoreSide({
  side,
  label,
  sideId,
  isCatching,
  align = "left",
}: {
  side: PublicAudienceGameProjection["sideA"];
  label: string;
  sideId: "side-a" | "side-b";
  isCatching: boolean;
  align?: "left" | "right";
}) {
  return (
    <div
      className={`min-w-0 rounded-2xl border-2 bg-card p-3 ${align === "right" ? "text-right" : "text-left"}`}
      style={{ borderColor: side.color ?? "hsl(var(--border))" }}
      data-side-id={sideId}
      role="group"
      aria-label={`${label}: ${side.name ?? "Unassigned Team"}, score ${side.score ?? "unavailable"}${isCatching ? ", flag catch" : ""}`}
    >
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="mt-1 break-words text-base font-semibold leading-tight sm:text-xl">
        {side.name ?? "Unassigned Team"}
      </p>
      <p className="mt-2 text-4xl font-bold tabular-nums sm:text-5xl">
        <span aria-label={`${label} score`}>{side.score ?? "—"}</span>
        {isCatching ? (
          <span className="mt-1 block text-xs font-semibold tracking-wide text-foreground uppercase">
            Flag catch
          </span>
        ) : null}
      </p>
    </div>
  );
}

function CompactScoreSide({
  side,
  label,
  sideId,
  isCatching,
  align = "left",
}: {
  side: PublicAudienceGameProjection["sideA"];
  label: string;
  sideId: "side-a" | "side-b";
  isCatching: boolean;
  align?: "left" | "right";
}) {
  return (
    <div
      className={`min-w-0 ${align === "right" ? "text-right" : "text-left"}`}
      data-side-id={sideId}
    >
      <p className="truncate text-xs font-semibold">{side.name ?? "Unassigned Team"}</p>
      <p className="truncate text-sm font-semibold">
        <span aria-label={`${label} score`}>{side.score ?? "—"}</span>
        {isCatching ? <span className="ml-1 text-[0.65rem] uppercase">Flag catch</span> : null}
      </p>
    </div>
  );
}

function StatusValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border p-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-medium">{value}</dd>
    </div>
  );
}

function GameUnavailablePanel({ eventId }: { eventId: string }) {
  return (
    <PublicShell title="Game unavailable" description="This public Game is not available.">
      <Card>
        <CardContent className="space-y-4 pt-6">
          <p className="text-sm text-muted-foreground">
            The Game may be hidden, unknown, or temporarily unavailable.
          </p>
          <Button onClick={() => navigateTo(`/events/${encodeURIComponent(eventId)}`)}>
            Back to Event
          </Button>
        </CardContent>
      </Card>
    </PublicShell>
  );
}

function ScheduleBoard({
  schedule,
  timeZone,
}: {
  schedule: PublicAudienceScheduleProjection;
  timeZone: string;
}) {
  const focusRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (schedule.focusIndex === null) return;
    focusRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [schedule.asOfMs, schedule.focusIndex]);

  return (
    <div className="space-y-6">
      <ScheduleGroup
        title="Live now"
        description="Every running Game has equal prominence."
        games={schedule.runningGames}
        timeZone={timeZone}
        empty="No Games are running now."
        dataGroup="live-now"
      />
      <ScheduleGroup
        title="Coming up"
        description="Games with an Expected Start in the next hour."
        games={schedule.upcomingGames}
        timeZone={timeZone}
        empty="No Games are expected in the next hour."
        dataGroup="coming-up"
        groupByExpectedStart
      />
      <section
        aria-labelledby="event-schedule-heading"
        className="space-y-3"
        data-schedule-group="event-schedule"
      >
        <div>
          <h2 id="event-schedule-heading" className="text-xl font-semibold">
            Event schedule
          </h2>
          <p className="text-sm text-muted-foreground">
            Chronological schedule positioned around the Event&apos;s current time.
          </p>
        </div>
        {schedule.scheduleGames.length === 0 ? (
          <p className="rounded-2xl border border-dashed p-4 text-sm text-muted-foreground">
            No Games have been scheduled.
          </p>
        ) : (
          <ol className="space-y-3">
            {schedule.scheduleGames.map((game, index) => (
              <li
                key={scheduleGameKey(game, index)}
                ref={index === schedule.focusIndex ? focusRef : undefined}
                data-schedule-card
                data-game-code={game.gameCode ?? undefined}
                data-schedule-status={game.scheduleStatus}
              >
                <GameCard game={game} timeZone={timeZone} compact />
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function ScheduleGroup({
  title,
  description,
  games,
  timeZone,
  empty,
  dataGroup,
  groupByExpectedStart = false,
}: {
  title: string;
  description: string;
  games: readonly PublicAudienceGameProjection[];
  timeZone: string;
  empty: string;
  dataGroup: string;
  groupByExpectedStart?: boolean;
}) {
  return (
    <section
      aria-labelledby={title.toLowerCase().replaceAll(" ", "-")}
      className="space-y-3"
      data-schedule-group={dataGroup}
    >
      <div>
        <h2 id={title.toLowerCase().replaceAll(" ", "-")} className="text-xl font-semibold">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {games.length === 0 ? (
        <p className="rounded-2xl border border-dashed p-4 text-sm text-muted-foreground">
          {empty}
        </p>
      ) : groupByExpectedStart ? (
        <div className="space-y-4">
          {groupGamesByExpectedStart(games).map((group) => (
            <section
              key={group.expectedStartMs}
              aria-labelledby={`expected-${group.expectedStartMs}`}
            >
              <h3
                id={`expected-${group.expectedStartMs}`}
                className="text-sm font-semibold text-muted-foreground"
              >
                Expected Start {formatScheduleTime(group.expectedStartMs, timeZone)}
              </h3>
              <div className="mt-2 grid gap-3 md:grid-cols-2">
                {group.games.map((game, index) => (
                  <div
                    key={scheduleGameKey(game, index)}
                    data-schedule-card
                    data-game-code={game.gameCode ?? undefined}
                    data-schedule-status={game.scheduleStatus}
                  >
                    <GameCard game={game} timeZone={timeZone} />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {games.map((game, index) => (
            <div
              key={scheduleGameKey(game, index)}
              data-schedule-card
              data-game-code={game.gameCode ?? undefined}
              data-schedule-status={game.scheduleStatus}
            >
              <GameCard game={game} timeZone={timeZone} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function GameCard({
  game,
  timeZone,
  compact = false,
}: {
  game: PublicAudienceGameProjection;
  timeZone: string;
  compact?: boolean;
}) {
  const winnerName =
    game.result.winner === "side-a"
      ? game.sideA.name
      : game.result.winner === "side-b"
        ? game.sideB.name
        : null;
  return (
    <Card className={compact ? "bg-card/70" : "border-primary/40 bg-card shadow-md"}>
      <CardHeader className={compact ? "pb-3" : undefined}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className={compact ? "text-base font-semibold" : "text-lg font-semibold"}>
              {game.spectatorAvailable === false ? (
                <span>{game.gameDesignation ?? game.gameCode ?? "Scheduled Game"}</span>
              ) : (
                <a
                  href={game.canonicalPath}
                  className="rounded-sm underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
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
                    navigateTo(game.canonicalPath);
                  }}
                >
                  {game.gameDesignation ?? game.gameCode ?? "Scheduled Game"}
                  <span className="sr-only"> Open spectator Game</span>
                </a>
              )}
            </h3>
            {game.gameDesignation !== null && game.gameCode !== null ? (
              <CardDescription>Game {game.gameCode}</CardDescription>
            ) : null}
          </div>
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-semibold ${scheduleStatusClass(game.scheduleStatus)}`}
          >
            {scheduleStatusLabel(game.scheduleStatus)}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2">
          <GameSideRow
            side={game.sideA}
            label="Side A"
            isCatching={game.flagState.catchingSide === "side-a"}
          />
          <GameSideRow
            side={game.sideB}
            label="Side B"
            isCatching={game.flagState.catchingSide === "side-b"}
          />
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>Scheduled Start {formatScheduleTime(game.scheduledStartMs, timeZone)}</span>
          {game.expectedStartMs !== game.scheduledStartMs ? (
            <span>Expected Start {formatScheduleTime(game.expectedStartMs, timeZone)}</span>
          ) : null}
          {game.pitch !== null ? <span>Pitch {game.pitch}</span> : null}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>Game Phase: {gamePhaseLabel(game.phase)}</span>
          <span>Operational status: {operationalStatusLabel(game.operationalStatus)}</span>
          {game.overtimeTarget !== null ? (
            <span>Overtime target: {game.overtimeTarget}</span>
          ) : null}
          {winnerName !== null ? <span>Winner: {winnerName}</span> : null}
          {game.clock !== null ? (
            game.clock.synchronization === "unavailable" ? (
              <span>Clock unavailable · manual timing required</span>
            ) : (
              <span>
                Clock {formatClock(game.clock.gameTimeMs)} ·{" "}
                {clockStatusLabel(game.clock.synchronization)}
              </span>
            )
          ) : null}
        </div>
        {(!compact || game.scheduleStatus === "past") && game.timeline.length > 0 ? (
          <PublicGameTimeline entries={game.timeline} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function GameSideRow({
  side,
  label,
  isCatching,
}: {
  side: PublicAudienceGameProjection["sideA"];
  label: string;
  isCatching: boolean;
}) {
  return (
    <>
      <span
        className="min-w-0 truncate"
        style={
          side.color === null
            ? undefined
            : { borderInlineStart: `0.3rem solid ${side.color}`, paddingInlineStart: "0.5rem" }
        }
      >
        <span className="sr-only">{label}: </span>
        {side.name ?? "TBD"}
        {isCatching ? <span className="ml-2 text-xs font-semibold">Flag catch</span> : null}
      </span>
      <span
        className="text-right text-2xl font-semibold tabular-nums"
        aria-label={`${label} score`}
      >
        {side.score ?? "—"}
      </span>
    </>
  );
}

function scheduleGameKey(game: PublicAudienceGameProjection, index: number) {
  return `${game.gameCode ?? game.gameDesignation ?? "game"}-${index}`;
}

function groupGamesByExpectedStart(games: readonly PublicAudienceGameProjection[]) {
  const groups = new Map<number, PublicAudienceGameProjection[]>();
  for (const game of games) {
    const group = groups.get(game.expectedStartMs) ?? [];
    group.push(game);
    groups.set(game.expectedStartMs, group);
  }
  return [...groups.entries()].map(([expectedStartMs, groupedGames]) => ({
    expectedStartMs,
    games: groupedGames,
  }));
}

function scheduleStatusClass(status: PublicAudienceGameProjection["scheduleStatus"]) {
  return GAME_SCHEDULE_STATUS_META[status].className;
}

function scheduleStatusLabel(status: PublicAudienceGameProjection["scheduleStatus"]) {
  return GAME_SCHEDULE_STATUS_META[status].label;
}

function gamePhaseLabel(phase: PublicAudienceGameProjection["phase"]) {
  return phase === "seeker-floor"
    ? "Seeker Floor"
    : phase === "seekers-released"
      ? "Seekers Released"
      : "Overtime";
}

function operationalStatusLabel(status: PublicAudienceGameProjection["operationalStatus"]) {
  return status === "paused"
    ? "Paused"
    : status === "suspended"
      ? "Suspended"
      : status === "finished"
        ? "Finished"
        : status === "running"
          ? "Running"
          : "Scheduled";
}

const GAME_SCHEDULE_STATUS_META = {
  running: { label: "Running", className: "bg-primary text-primary-foreground" },
  "awaiting-start": {
    label: "Awaiting start",
    className: "bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-100",
  },
  past: { label: "Past", className: "bg-muted text-muted-foreground" },
  future: { label: "Future", className: "bg-secondary text-secondary-foreground" },
} satisfies Record<
  PublicAudienceGameProjection["scheduleStatus"],
  { label: string; className: string }
>;

function formatScheduleTime(milliseconds: number, timeZone: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(milliseconds));
}

function formatClock(milliseconds: number) {
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatDateTime(milliseconds: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(milliseconds));
}

function clockFreshnessLabel(
  status: NonNullable<PublicAudienceGameProjection["clock"]>["synchronization"],
) {
  return status === "synchronized"
    ? "Synchronized clock"
    : status === "estimated"
      ? "Estimated clock"
      : status === "stale"
        ? "Stale clock"
        : "Clock unavailable";
}

function formatLastSynchronization(milliseconds: number | null) {
  return milliseconds === null ? "unavailable" : formatDateTime(milliseconds);
}

function timeoutLabel(timeout: PublicAudienceGameProjection["teamTimeout"]) {
  return timeout.status === "inactive"
    ? "None"
    : timeout.status === "started"
      ? `Started${timeout.remainingMs === null ? "" : ` · ${Math.ceil(timeout.remainingMs / 1_000)}s`}`
      : timeout.status[0]!.toUpperCase() + timeout.status.slice(1);
}

function heatLabel(heat: PublicAudienceGameProjection["heatStoppage"]) {
  return heat.status === "inactive"
    ? "Inactive"
    : `${heat.status}${heat.remainingMs === null ? "" : ` · ${formatDuration(heat.remainingMs)} remaining`}${heat.pending ? " · decision pending" : ""}`;
}

function formatDuration(milliseconds: number) {
  const seconds = Math.ceil(Math.max(0, milliseconds) / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function resultLabel(result: PublicAudienceGameProjection["result"]) {
  if (result.status === "unfinished") return "In progress";
  return `${result.winner === null ? "Finished" : `Winner ${result.winner === "side-a" ? "Side A" : "Side B"}`}${result.locked ? " · Locked" : ""}`;
}

function clockStatusLabel(
  status: NonNullable<PublicAudienceGameProjection["clock"]>["synchronization"],
) {
  return status === "synchronized" ? "synced" : status;
}

function EventDiscovery({ events }: { events: readonly PublicAudienceEventProjection[] }) {
  const current = events.filter((event) => event.lifecycle === "current");
  const future = events.filter((event) => event.lifecycle === "future");
  const past = events.filter((event) => event.lifecycle === "past");

  return (
    <div className="space-y-6">
      <EventGroup title="Current Events" events={current} empty="No Event is current today." />
      <EventGroup title="Upcoming Events" events={future} empty="No upcoming Published Events." />
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
  const creationAttemptRef = useRef(0);
  const creationRetryTimerRef = useRef<number | null>(null);
  const beginCreateGameRef = useRef<((attempt?: number) => Promise<void>) | null>(null);
  const mountedRef = useRef(true);
  const replacementTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (creationRetryTimerRef.current !== null)
        window.clearTimeout(creationRetryTimerRef.current);
      creationRetryTimerRef.current = null;
      creationPendingRef.current = false;
    };
  }, []);

  const createGame = useCallback(async () => {
    const attempt = creationAttemptRef.current;
    if (!mountedRef.current) return false;
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
      return false;
    }
    if (!mountedRef.current) return false;

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
        setCreationStatus(`Ad Hoc creation busy. Retrying in ${Math.ceil(retryAfterMs / 1_000)}s.`);
        creationPendingRef.current = false;
        setCreationPending(false);
        if (creationRetryTimerRef.current !== null)
          window.clearTimeout(creationRetryTimerRef.current);
        creationRetryTimerRef.current = window.setTimeout(() => {
          creationRetryTimerRef.current = null;
          void beginCreateGameRef.current?.(attempt + 1);
        }, retryAfterMs);
        return false;
      }
      setCreationAlert(true);
      setCreationStatus(capacityMessage ?? "Ad Hoc Game unavailable. Try again later.");
      creationPendingRef.current = false;
      setCreationPending(false);
      return false;
    }

    const payload = (await response.json()) as { gameId?: string };
    if (typeof payload.gameId === "string") {
      creationPendingRef.current = false;
      setCreationPending(false);
      navigateTo(`/game/${payload.gameId}`);
      return true;
    }
    setCreationAlert(true);
    setCreationStatus("Ad Hoc Game unavailable. Try again later.");
    creationPendingRef.current = false;
    setCreationPending(false);
    return false;
  }, [awayColor, awayName, homeColor, homeName]);
  const entry = useControllerDepartureEntry({
    destination: { kind: "new-ad-hoc" },
    triggerRef: replacementTriggerRef,
    onCommitted: async () => {
      creationPendingRef.current = true;
      setCreationPending(true);
      return await createGame();
    },
    onUnavailable: () => {
      setCreationAlert(true);
      setCreationStatus("The previous Controller return is no longer available.");
      creationPendingRef.current = false;
      setCreationPending(false);
    },
    onCancelled: () => {
      creationPendingRef.current = false;
      setCreationPending(false);
    },
  });
  const beginCreateGame = useCallback(
    async (attempt = 0) => {
      if (!mountedRef.current || creationPendingRef.current) return;
      creationAttemptRef.current = attempt;
      await entry.begin();
    },
    [entry],
  );
  beginCreateGameRef.current = beginCreateGame;

  return (
    <Card>
      <CardHeader>
        <h2 className="text-base leading-none font-semibold">Start Ad Hoc Game</h2>
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
          ref={replacementTriggerRef}
          type="button"
          className="w-full"
          disabled={creationPending || entry.busy}
          onClick={() => void beginCreateGame()}
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
      {entry.dialog}
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
      <a
        href="#main-content"
        className="sr-only z-50 rounded-md bg-background px-3 py-2 text-sm font-semibold focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus-visible:ring-2 focus-visible:ring-ring"
      >
        Skip to main content
      </a>
      <header className="mb-6 rounded-2xl border bg-card/80 p-5 shadow-sm backdrop-blur">
        <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
          Quadball Timer
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      </header>
      <main id="main-content" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}

function LiveProjectionStatus({
  status,
  message,
}: {
  status: "loading" | "connected" | "reconnecting" | "unavailable";
  message: string;
}) {
  const connectionMessage =
    status === "reconnecting"
      ? "Live updates reconnecting; the last committed view remains visible."
      : status === "unavailable"
        ? "Live updates are unavailable."
        : status === "loading"
          ? "Loading live updates."
          : "Live updates connected.";
  return (
    <p
      className="sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-live-projection-status
    >
      {connectionMessage} {message}
    </p>
  );
}

function gameAnnouncement(game: PublicAudienceGameProjection): string {
  return `${formatScoreAnnouncement(game)}. ${gamePhaseLabel(game.phase)}. ${operationalStatusLabel(game.operationalStatus)}.`;
}

function eventAnnouncement(event: PublicAudienceEventProjection): string {
  const liveScores = event.schedule.runningGames.map(formatScoreAnnouncement).join("; ");
  const liveSummary =
    liveScores.length === 0
      ? "There are no running Games."
      : `${event.schedule.runningGames.length} running Game${event.schedule.runningGames.length === 1 ? "" : "s"}: ${liveScores}.`;
  const timelineCount = event.schedule.scheduleGames.reduce(
    (count, game) => count + game.timeline.length,
    0,
  );
  return `${liveSummary} ${event.schedule.upcomingGames.length} upcoming Game${event.schedule.upcomingGames.length === 1 ? "" : "s"}. ${timelineCount} public Timeline entr${timelineCount === 1 ? "y" : "ies"}.`;
}

function formatScoreAnnouncement(game: PublicAudienceGameProjection): string {
  const sideA = game.sideA.name ?? "Side A";
  const sideB = game.sideB.name ?? "Side B";
  return `${sideA} ${game.sideA.score ?? "unavailable"}, ${sideB} ${game.sideB.score ?? "unavailable"}`;
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
