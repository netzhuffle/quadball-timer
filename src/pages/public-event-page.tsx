import "@/pages/public-game-daylight.css";
import { PublicTeamArtwork } from "@/components/public-team-artwork";
import { parseHexColor } from "@/lib/team-colors";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, CalendarDays, Check, ChevronRight, CirclePlus, Shield } from "lucide-react";
import "./public-discovery.css";
import "./public-event-daylight.css";
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
          navigateTo(publicEventEntryPath(current[0]!));
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
    <DiscoveryShell title="Events" footer={<StartAdHocGame />}>
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
        </div>
      ) : (
        <div className="space-y-6">
          <ControllerDepartureReturnCard />
          <EventDiscovery events={events ?? []} />
        </div>
      )}
    </DiscoveryShell>
  );
}

function eventScheduledToday(event: PublicAudienceEventProjection): boolean {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: event.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(Date.now());
  return event.gameDays.includes(today);
}

function publicEventEntryPath(event: PublicAudienceEventProjection): string {
  return eventScheduledToday(event) ? event.canonicalPath : `${event.canonicalPath}?view=schedule`;
}

export function PublicEventPage({
  eventId,
  showSchedule = false,
}: {
  eventId: string;
  showSchedule?: boolean;
}) {
  const { event, unavailable, connectionStatus } = usePublicEventProjection(eventId);
  const scheduledToday = event !== null && eventScheduledToday(event);
  const scheduleView = showSchedule || !scheduledToday;
  useEffect(() => {
    if (event === null || scheduledToday || showSchedule) return;
    window.history.replaceState(null, "", `${event.canonicalPath}?view=schedule`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, [event, scheduledToday, showSchedule]);

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
    <div className="daylight-event">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 z-50"
      >
        Skip to main content
      </a>
      <header
        className={`event-heading ${scheduleView && scheduledToday ? "event-schedule-heading" : ""}`}
      >
        <EventNavigationLink
          href={scheduleView && scheduledToday ? event.canonicalPath : "/events?view=all"}
          className="event-back"
        >
          <ArrowLeft size={18} aria-hidden="true" />
          {scheduleView && scheduledToday
            ? ((event as PublicAudienceEventProjection & { shortName?: string }).shortName ??
              event.name)
            : "All events"}
        </EventNavigationLink>
        {!scheduleView || !scheduledToday ? (
          <h1>
            {(event as PublicAudienceEventProjection & { shortName?: string }).shortName ??
              event.name}
          </h1>
        ) : (
          <h1 className="sr-only">Event schedule</h1>
        )}
        <p>
          {event.gameDays
            .map((date) =>
              new Intl.DateTimeFormat(undefined, {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric",
                timeZone: "UTC",
              }).format(new Date(`${date}T12:00:00Z`)),
            )
            .join(" · ")}
        </p>
        {scheduledToday ? (
          <EventNavigationLink
            href={`${event.canonicalPath}?view=schedule`}
            className="event-calendar"
            label="View Event schedule"
          >
            <CalendarDays aria-hidden="true" size={23} />
          </EventNavigationLink>
        ) : null}
      </header>
      <main id="main-content" tabIndex={-1}>
        {event.teamAssignmentNotice !== undefined ? <TeamAssignmentCorrectionNotice /> : null}
        <LiveProjectionStatus status={connectionStatus} message={eventAnnouncement(event)} />
        {connectionStatus === "reconnecting" ? (
          <p role="status">Reconnecting live updates… Showing the last received games.</p>
        ) : null}
        {scheduleView ? (
          <ScheduleBoard schedule={schedule} timeZone={event.timeZone} />
        ) : (
          <EventArena schedule={schedule} timeZone={event.timeZone} />
        )}
      </main>
    </div>
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

function measureExpandedScoreboard(scoreboard: HTMLElement): number {
  const nativeScroll = scoreboard.hasAttribute("data-scoreboard-native-scroll");
  scoreboard.removeAttribute("data-scoreboard-native-scroll");
  const progress = scoreboard.style.getPropertyValue("--score-collapse");
  scoreboard.style.setProperty("--score-collapse", "0");
  const names = [...scoreboard.querySelectorAll<HTMLElement>(".daylight-team-name")];
  // Measure natural wrapping before reserving each name's shrinking footprint.
  // Text may reflow during the morph, but must not move the scores in a jump.
  for (const name of names) name.style.removeProperty("--expanded-name-height");
  const heights = names.map((name) => name.getBoundingClientRect().height);
  names.forEach((name, index) =>
    name.style.setProperty("--expanded-name-height", `${heights[index]}px`),
  );
  const height = scoreboard.getBoundingClientRect().height;
  scoreboard.style.setProperty("--score-collapse", progress);
  scoreboard.toggleAttribute("data-scoreboard-native-scroll", nativeScroll);
  return height;
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
  const scoreboardLayoutRef = useRef<HTMLDivElement | null>(null);
  const scoreboardSentinelRef = useRef<HTMLDivElement | null>(null);
  const scoreboardRef = useRef<HTMLElement | null>(null);
  const scoreboardContentRef = useRef<HTMLDivElement | null>(null);
  const expandedHeightRef = useRef(0);
  const recalibrateScoreboardRef = useRef<(() => void) | null>(null);
  const hasGame = game !== null && game.spectatorAvailable !== false;

  useEffect(() => {
    const sentinel = scoreboardSentinelRef.current;
    const scoreboard = scoreboardRef.current;
    const content = scoreboardContentRef.current;
    const layout = scoreboardLayoutRef.current;
    if (!sentinel || !scoreboard || !content || !layout || !hasGame) return;
    const page = sentinel.closest<HTMLElement>(".daylight-game")!;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const supportsNativeScroll =
      window.CSS?.supports?.("animation-timeline", "scroll(root)") === true;
    let start = 0;
    let maximumScroll = 0;
    let nativeScroll = false;
    let active = true;
    const update = () => {
      const scrollY = Math.max(0, Math.min(window.scrollY, maximumScroll));
      const distance = maximumScroll > 0 ? Math.max(0, scrollY - start) : 0;
      const progress = reducedMotion?.matches ? Number(distance > 0) : Math.min(1, distance / 180);
      // Native CSS samples the scroll timeline directly. The fallback also stays
      // local to this element; neither path rerenders the timeline while scrolling.
      if (!nativeScroll) scoreboard.style.setProperty("--score-collapse", String(progress));
      scoreboard.dataset.collapseProgress = String(progress);
      scoreboard.toggleAttribute("data-scoreboard-compact", progress > 0);
    };
    const refreshRange = () => {
      const bottomPadding = Number.parseFloat(window.getComputedStyle(page).paddingBottom) || 0;
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      start = sentinel.offsetTop;
      // Only the expanded content extent can enable the morph, never viewport minimum height.
      maximumScroll = Math.max(
        0,
        start + expandedHeightRef.current + content.offsetHeight + bottomPadding - viewportHeight,
      );
      nativeScroll = supportsNativeScroll && !reducedMotion?.matches && maximumScroll > 0;
      scoreboard.style.setProperty("--score-collapse-start", `${start}px`);
      scoreboard.style.setProperty("--score-collapse-end", `${start + 180}px`);
      scoreboard.toggleAttribute("data-scoreboard-native-scroll", nativeScroll);
      update();
    };
    const resize = () => {
      expandedHeightRef.current = measureExpandedScoreboard(scoreboard);
      layout.style.setProperty("--scoreboard-expanded-height", `${expandedHeightRef.current}px`);
      refreshRange();
    };
    recalibrateScoreboardRef.current = resize;
    const contentObserver = new window.ResizeObserver(refreshRange);
    contentObserver.observe(content);
    resize();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", resize);
    scoreboard.addEventListener("load", resize, true);
    document.fonts?.addEventListener("loadingdone", resize);
    void document.fonts?.ready.then(() => {
      if (active) resize();
    });
    reducedMotion?.addEventListener("change", refreshRange);
    return () => {
      active = false;
      recalibrateScoreboardRef.current = null;
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", resize);
      scoreboard.removeEventListener("load", resize, true);
      document.fonts?.removeEventListener("loadingdone", resize);
      contentObserver.disconnect();
      reducedMotion?.removeEventListener("change", refreshRange);
    };
  }, [hasGame, eventId, eventGameId]);

  useEffect(() => {
    recalibrateScoreboardRef.current?.();
  }, [
    game?.sideA.name,
    game?.sideB.name,
    game?.pitchName,
    game?.pitch,
    game?.phase,
    game?.operationalStatus,
    game?.result.status,
    game?.overtimeTarget,
    game?.clock?.synchronization,
    game?.startedAtMs,
    event?.shortName,
    event?.name,
    connectionStatus,
  ]);

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
  const finished = isGameFinished(game);
  const hasExceptionalDetails =
    !finished &&
    (game.teamTimeout.status !== "inactive" ||
      game.gameSuspension === "suspended" ||
      game.heatStoppage.status !== "inactive" ||
      game.heatStoppage.pending);

  const scoreSide = (index: number) => {
    const item = sides[index]!;
    const color =
      item.sideId === "side-a"
        ? game.presentation.displayedTeamColors.sideA
        : game.presentation.displayedTeamColors.sideB;
    return (
      <PublicScoreSide
        key={item.sideId}
        side={{ ...item.side, color }}
        label={item.label}
        sideId={item.sideId}
        isCatching={game.flagState.catchingSide === item.sideId}
      />
    );
  };
  return (
    <div className="daylight-game">
      <a href="#main-content" className="sr-only focus:not-sr-only">
        Skip to main content
      </a>
      <header className="daylight-game-header">
        <a
          href={`/events/${encodeURIComponent(eventId)}`}
          aria-label="Back to Event"
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
            navigateTo(`/events/${encodeURIComponent(eventId)}`);
          }}
        >
          <ArrowLeft size={18} aria-hidden="true" />
          <span>{event?.shortName?.trim() || event?.name || "Event"}</span>
        </a>
      </header>
      <main id="main-content" tabIndex={-1}>
        <h1 className="sr-only">
          {game.gameDesignation ?? game.gameCode ?? "Game"}: {game.sideA.name ?? "Side A"} vs{" "}
          {game.sideB.name ?? "Side B"} — Game scoreboard
        </h1>
        {game.teamAssignmentNotice !== undefined ? <TeamAssignmentCorrectionNotice /> : null}
        <LiveProjectionStatus status={connectionStatus} message={gameAnnouncement(game)} />
        {connectionStatus === "reconnecting" ? (
          <p role="status" className="daylight-meta">
            Reconnecting live updates… Showing the last received score.
          </p>
        ) : null}
        <div ref={scoreboardSentinelRef} aria-hidden="true" data-scoreboard-sentinel />
        <div ref={scoreboardLayoutRef} className="daylight-scoreboard-layout">
          <section
            ref={scoreboardRef}
            aria-label="Live scoreboard"
            className="daylight-morph-scoreboard"
            data-scoreboard-expanded
            data-collapse-progress="0"
            style={{ "--score-collapse": 0 } as CSSProperties}
          >
            <button
              type="button"
              className="daylight-score-return"
              aria-label="Return to full scoreboard"
              onClick={() => {
                document.getElementById("main-content")?.focus({ preventScroll: true });
                window.scrollTo({
                  top: 0,
                  behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
                    ? "auto"
                    : "smooth",
                });
              }}
            />
            <div className="daylight-start-strip" aria-label="Game start and Pitch">
              <span>
                {game.startedAtMs === undefined ? "Scheduled" : "Started"}{" "}
                <time dateTime={new Date(game.startedAtMs ?? game.scheduledStartMs).toISOString()}>
                  {formatScheduleTime(
                    game.startedAtMs ?? game.scheduledStartMs,
                    event?.timeZone ?? "UTC",
                  )}
                </time>
              </span>
              {game.startedAtMs === undefined && game.expectedStartMs !== game.scheduledStartMs ? (
                <span>
                  Expected{" "}
                  <time dateTime={new Date(game.expectedStartMs).toISOString()}>
                    {formatScheduleTime(game.expectedStartMs, event?.timeZone ?? "UTC")}
                  </time>
                </span>
              ) : null}
              {(game.pitchName ?? game.pitch) ? <span>{game.pitchName ?? game.pitch}</span> : null}
            </div>
            <div className="daylight-arena">
              {scoreSide(0)}
              {scoreSide(1)}
              <div className="daylight-clock" role="timer" aria-label="Game clock">
                {game.clock ? formatClock(game.clock.gameTimeMs) : "—:—"}
              </div>
            </div>
            <div className="daylight-status">
              {gameStatusLabels(game).map((label) => (
                <span key={label}>{label}</span>
              ))}
              {!finished &&
              game.operationalStatus !== "scheduled" &&
              game.clock?.synchronization !== "synchronized" ? (
                <span className="daylight-clock-freshness">
                  {clockFreshnessLabel(game.clock?.synchronization ?? "unavailable")}
                </span>
              ) : null}
            </div>
          </section>
          <div ref={scoreboardContentRef} data-scoreboard-content>
            {hasExceptionalDetails ? (
              <dl className="daylight-details">
                {game.teamTimeout.status !== "inactive" ? (
                  <StatusValue label="Team Timeout" value={timeoutLabel(game.teamTimeout)} />
                ) : null}
                {game.gameSuspension === "suspended" ? (
                  <StatusValue label="Game Suspension" value="Suspended" />
                ) : null}
                {game.heatStoppage.status !== "inactive" || game.heatStoppage.pending ? (
                  <StatusValue label="Heat Stoppage" value={heatLabel(game.heatStoppage)} />
                ) : null}
              </dl>
            ) : null}
            <section className="daylight-history" aria-label="Game history">
              {game.timeline.length > 0 ? (
                <PublicGameTimeline
                  entries={game.timeline}
                  presentation={game.presentation}
                  game={game}
                  connected={
                    connectionStatus === "connected" &&
                    game.clock?.synchronization === "synchronized"
                  }
                />
              ) : (
                <>
                  <h2>Game Timeline</h2>
                  <p>No public play history is available yet.</p>
                </>
              )}
              {game.flagState.catchingSide !== null ? (
                <p className="mt-4 text-sm">* Flag catch</p>
              ) : null}
            </section>
          </div>
        </div>
      </main>
    </div>
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
}: {
  side: PublicAudienceGameProjection["sideA"];
  label: string;
  sideId: "side-a" | "side-b";
  isCatching: boolean;
}) {
  const color = side.color ?? "#34465e";
  return (
    <div
      className="daylight-side"
      style={{ "--team-color": color, "--team-ink": scoreTextColor(color) } as CSSProperties}
      data-side-id={sideId}
      role="group"
      aria-label={`${label}: ${side.name ?? "Unassigned Team"}, score ${side.score ?? "unavailable"}${isCatching ? ", flag catch" : ""}`}
    >
      <PublicTeamArtwork name={side.name} />
      <p className="daylight-team-name break-words">{side.name ?? "Unassigned Team"}</p>
      <p className="daylight-score">
        <span aria-label={`${label} score`}>{side.score ?? "—"}</span>
        {isCatching ? (
          <sup>
            <span aria-hidden="true">*</span>
            <span className="sr-only">Flag catch</span>
          </sup>
        ) : null}
      </p>
    </div>
  );
}

function scoreTextColor(color: string) {
  const rgb = parseHexColor(color);
  if (rgb === null) return "#ffffff";
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b);
  return luminance > 0.179 ? "#000000" : "#ffffff";
}

function StatusValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
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
            <ArrowLeft size={18} aria-hidden="true" />
            Back to Event
          </Button>
        </CardContent>
      </Card>
    </PublicShell>
  );
}

function EventNavigationLink({
  href,
  children,
  className,
  label,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <a
      href={href}
      className={className}
      aria-label={label}
      onClick={(click) => {
        if (click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey)
          return;
        click.preventDefault();
        navigateTo(href);
      }}
    >
      {children}
    </a>
  );
}

function nextUnstartedGames(schedule: PublicAudienceScheduleProjection) {
  const unstartedGames = schedule.scheduleGames.filter(
    (game) => game.scheduleStatus === "future" || game.scheduleStatus === "awaiting-start",
  );
  const nextExpectedStart = Math.min(...unstartedGames.map((game) => game.expectedStartMs));
  return unstartedGames.filter((game) => game.expectedStartMs === nextExpectedStart);
}

function EventArena({
  schedule,
  timeZone,
}: {
  schedule: PublicAudienceScheduleProjection;
  timeZone: string;
}) {
  const runningGames = [...schedule.runningGames].sort(
    (left, right) =>
      left.expectedStartMs - right.expectedStartMs ||
      (left.pitchName ?? left.pitch ?? "").localeCompare(
        right.pitchName ?? right.pitch ?? "",
        "en",
        { numeric: true },
      ) ||
      left.eventGameId.localeCompare(right.eventGameId, "en"),
  );
  const upcoming = nextUnstartedGames(schedule);
  return (
    <>
      <section
        className="event-horizon"
        data-schedule-group="live-now"
        aria-labelledby="event-arena-heading"
      >
        <div className="event-section-heading">
          <h2 id="event-arena-heading">Live now</h2>
          <span className="event-running-count">{schedule.runningGames.length} games running</span>
        </div>
        {schedule.runningGames.length ? (
          <div className="event-live-grid">
            {runningGames.map((game) => (
              <GameCard key={game.eventGameId} game={game} timeZone={timeZone} mode="live" />
            ))}
          </div>
        ) : (
          <p className="event-empty">{upcoming.length ? "Next games below" : "No games running"}</p>
        )}
        {schedule.runningGames.some((game) => game.flagState.catchingSide) ? (
          <p className="event-catch-legend">* Flag catch</p>
        ) : null}
      </section>
      <section data-schedule-group="coming-up" className="event-upcoming" aria-label="Up next">
        {groupEventGames(upcoming, "expectedStartMs").map((group) => (
          <div key={group.time} className="event-upcoming-group">
            <div className="event-section-heading">
              <h2>
                Up next · <time>{formatScheduleTime(group.time, timeZone)}</time>
              </h2>
              <span>
                {group.games.length} {group.games.length === 1 ? "game" : "games"}
              </span>
            </div>
            <div className="event-upcoming-grid">
              {group.games.map((game) => (
                <GameCard key={game.eventGameId} game={game} timeZone={timeZone} mode="upcoming" />
              ))}
            </div>
          </div>
        ))}
        {!upcoming.length && !schedule.runningGames.length ? (
          <p className="event-empty">No upcoming games scheduled.</p>
        ) : null}
      </section>
    </>
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
  const positioned = useRef(false);
  const groups = groupEventGames(schedule.scheduleGames, "expectedStartMs");
  const focusGame =
    schedule.focusIndex === null ? null : schedule.scheduleGames[schedule.focusIndex];
  useEffect(() => {
    if (positioned.current || !focusRef.current) return;
    focusRef.current.scrollIntoView({ block: "start" });
    positioned.current = true;
  }, [schedule.focusIndex, schedule.asOfMs]);
  return (
    <section
      className="event-chronology"
      data-schedule-group="event-schedule"
      aria-label="Event schedule"
    >
      {!groups.length ? (
        <p className="event-empty">No games have been scheduled.</p>
      ) : (
        <ol className="event-time-rail" aria-label="Chronological Event schedule">
          {groups.map((group, index) => {
            const running = group.games.some((game) => game.scheduleStatus === "running");
            const past = group.games.every((game) => game.scheduleStatus === "past");
            const label = running ? "Now" : past ? "Past" : "Up next";
            const previous = groups[index - 1];
            const previousLabel = previous?.games.some((game) => game.scheduleStatus === "running")
              ? "Now"
              : previous?.games.every((game) => game.scheduleStatus === "past")
                ? "Past"
                : previous
                  ? "Up next"
                  : null;
            return (
              <li
                key={group.time}
                ref={group.time === focusGame?.expectedStartMs ? focusRef : undefined}
                data-time-group
                data-current={running || undefined}
              >
                <div className="event-rail-time">
                  <span>{label !== previousLabel ? label : null}</span>
                  <time>{formatScheduleTime(group.time, timeZone)}</time>
                </div>
                <div className="event-time-group">
                  {group.games.map((game) => (
                    <GameCard
                      key={game.eventGameId}
                      game={game}
                      timeZone={timeZone}
                      mode="schedule"
                    />
                  ))}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function groupEventGames(
  games: readonly PublicAudienceGameProjection[],
  key: "expectedStartMs" | "scheduledStartMs",
) {
  const groups = new Map<number, PublicAudienceGameProjection[]>();
  for (const game of games) {
    const group = groups.get(game[key]) ?? [];
    group.push(game);
    groups.set(game[key], group);
  }
  return [...groups].map(([time, games]) => ({ time, games }));
}

function GameCard({
  game,
  timeZone,
  mode,
}: {
  game: PublicAudienceGameProjection;
  timeZone: string;
  mode: "live" | "upcoming" | "schedule";
}) {
  const sides =
    game.presentation.pitchOrientation === "side-b-left"
      ? [
          { side: game.sideB, id: "side-b" as const, label: "Side B" },
          { side: game.sideA, id: "side-a" as const, label: "Side A" },
        ]
      : [
          { side: game.sideA, id: "side-a" as const, label: "Side A" },
          { side: game.sideB, id: "side-b" as const, label: "Side B" },
        ];
  const pitch =
    game.pitch === null
      ? null
      : ((game as PublicAudienceGameProjection & { pitchName?: string | null }).pitchName ??
        game.pitch);
  const warnings = [
    game.operationalStatus === "paused" || game.operationalStatus === "suspended"
      ? operationalStatusLabel(game.operationalStatus)
      : null,
    game.phase === "overtime" ? `Target ${game.overtimeTarget ?? "—"}` : null,
    game.clock && game.clock.synchronization !== "synchronized"
      ? clockFreshnessLabel(game.clock.synchronization)
      : null,
    game.teamTimeout.status !== "inactive" ? `Timeout: ${timeoutLabel(game.teamTimeout)}` : null,
    game.heatStoppage.status !== "inactive" || game.heatStoppage.pending
      ? `Heat stoppage: ${heatLabel(game.heatStoppage)}`
      : null,
  ].filter(Boolean);
  const upcoming = game.scheduleStatus === "future" || game.scheduleStatus === "awaiting-start";
  const artworkOnly = mode === "upcoming" || (mode === "schedule" && upcoming);
  const title = `${game.gameDesignation ?? game.gameCode ?? "Game"}: ${game.sideA.name ?? "TBD"} vs ${game.sideB.name ?? "TBD"}`;
  const card = (
    <article
      className={`event-game-card event-${mode}-card${mode === "schedule" && upcoming ? " event-schedule-upcoming" : ""}`}
      data-schedule-card
      data-game-code={game.gameCode ?? undefined}
      data-schedule-status={game.scheduleStatus}
    >
      <span className="sr-only">
        {title}. Scheduled Start {formatScheduleTime(game.scheduledStartMs, timeZone)}. Expected
        Start {formatScheduleTime(game.expectedStartMs, timeZone)}.
      </span>
      {pitch ? <span className="event-pitch-chip">{pitch}</span> : null}
      {mode === "schedule" && game.scheduleStatus === "running" ? (
        <span className="event-live-label">Live</span>
      ) : null}
      <div className="event-card-arena">
        {sides.map(({ side, id, label }) => {
          const color =
            (id === "side-a"
              ? game.presentation.displayedTeamColors.sideA
              : game.presentation.displayedTeamColors.sideB) ?? "#52647a";
          return (
            <div
              key={id}
              className="event-card-side"
              style={
                { "--team-color": color, "--team-ink": scoreTextColor(color) } as CSSProperties
              }
            >
              <div className="event-card-identity">
                <PublicTeamArtwork name={side.name} />
                <span className={artworkOnly ? "sr-only" : undefined}>{side.name ?? "TBD"}</span>
              </div>
              {!artworkOnly ? (
                <strong aria-label={`${label} score`}>
                  {side.score ?? "—"}
                  {game.flagState.catchingSide === id ? <sup aria-label="Flag catch">*</sup> : null}
                </strong>
              ) : null}
            </div>
          );
        })}
        {mode !== "schedule" || artworkOnly ? (
          <span className="event-card-versus" aria-hidden="true">
            vs
          </span>
        ) : null}
        {mode === "live" ? (
          <div className="event-card-clock">
            <strong>
              {game.clock && game.clock.synchronization !== "unavailable"
                ? formatClock(game.clock.gameTimeMs)
                : "—:—"}
            </strong>
            <span>{gamePhaseLabel(game.phase)}</span>
          </div>
        ) : null}
      </div>
      {game.expectedStartMs !== game.scheduledStartMs && mode !== "live" ? (
        <p className="event-time-change">
          Expected {formatScheduleTime(game.expectedStartMs, timeZone)} · Scheduled{" "}
          {formatScheduleTime(game.scheduledStartMs, timeZone)}
        </p>
      ) : null}
      {warnings.length ? <p className="event-card-warning">{warnings.join(" · ")}</p> : null}
    </article>
  );
  return game.spectatorAvailable === false ? (
    card
  ) : (
    <EventNavigationLink
      href={game.canonicalPath}
      className="event-game-link"
      label={`${title}. ${pitch ?? ""}. ${artworkOnly ? `Expected ${formatScheduleTime(game.expectedStartMs, timeZone)}` : `${game.sideA.score ?? "—"} to ${game.sideB.score ?? "—"}. ${gamePhaseLabel(game.phase)}${game.flagState.catchingSide ? ". Flag catch" : ""}`}. ${warnings.join(". ")}. Open spectator Game`}
    >
      {card}
    </EventNavigationLink>
  );
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

function timeoutLabel(timeout: PublicAudienceGameProjection["teamTimeout"]) {
  return timeout.status === "inactive"
    ? "None"
    : timeout.status === "started"
      ? `Started${timeout.remainingMs === null ? "" : ` · ${Math.ceil(timeout.remainingMs / 1_000)}s`}`
      : timeout.status[0]!.toUpperCase() + timeout.status.slice(1);
}

function heatLabel(heat: PublicAudienceGameProjection["heatStoppage"]) {
  return heat.status === "inactive"
    ? `Inactive${heat.pending ? " · decision pending" : ""}`
    : `${heat.status}${heat.remainingMs === null ? "" : ` · ${formatDuration(heat.remainingMs)} remaining`}${heat.pending ? " · decision pending" : ""}`;
}

function formatDuration(milliseconds: number) {
  const seconds = Math.ceil(Math.max(0, milliseconds) / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function EventDiscovery({ events }: { events: readonly PublicAudienceEventProjection[] }) {
  const current = events.filter((event) => event.lifecycle === "current");
  const future = events.filter((event) => event.lifecycle === "future");
  const past = events.filter((event) => event.lifecycle === "past");

  return (
    <div className="space-y-6">
      <EventGroup title="Current Events" events={current} empty="No Event is current today." />
      <div className="discovery-timeline">
        <EventGroup title="Upcoming Events" events={future} empty="No upcoming Published Events." />
        <EventGroup title="Past Events" events={past} empty="No past Published Events." />
      </div>
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
      <h2 id={title.toLowerCase().replaceAll(" ", "-")} className="discovery-section-title">
        {title}
      </h2>
      {events.length === 0 ? (
        <p className="rounded-2xl border border-dashed p-4 text-sm text-muted-foreground">
          {empty}
        </p>
      ) : (
        <div className="discovery-event-list">
          {events.map((event) => (
            <a
              key={event.eventId}
              href={publicEventEntryPath(event)}
              className={`discovery-event ${event.lifecycle === "current" ? "discovery-current" : ""}`}
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
                navigateTo(publicEventEntryPath(event));
              }}
            >
              <EventDate event={event} />
              <span className="discovery-event-details">
                <span className="discovery-event-name">{event.name}</span>
                {event.location?.trim() && (
                  <span className="discovery-event-location">{event.location}</span>
                )}
                <span className="discovery-event-dates">
                  {event.gameDays.length > 0
                    ? event.gameDays.map(formatDiscoveryDate).join(" · ")
                    : "Unscheduled"}
                </span>
                {event.lifecycle === "current" && (
                  <span className="discovery-running">
                    {event.schedule.runningGames.length > 0
                      ? `${event.schedule.runningGames.length} ${event.schedule.runningGames.length === 1 ? "game" : "games"} running`
                      : "Current Event"}
                  </span>
                )}
              </span>
              {event.lifecycle === "current" && <ChevronRight aria-hidden="true" size={22} />}
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

function StartAdHocGame() {
  return (
    <a
      href="/ad-hoc/new"
      className="discovery-primary"
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        navigateTo("/ad-hoc/new");
      }}
    >
      <CirclePlus aria-hidden="true" />
      Start an Ad Hoc Game
    </a>
  );
}

function formatDiscoveryDate(date: string) {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

function EventDate({ event }: { event: PublicAudienceEventProjection }) {
  const date = event.gameDays[0];
  if (!date) return <span className="discovery-date">TBD</span>;
  const parsed = new Date(`${date}T12:00:00Z`);
  return (
    <span className="discovery-date" aria-hidden="true">
      <span>
        {new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" }).format(parsed)}
      </span>
      <strong>{parsed.getUTCDate()}</strong>
    </span>
  );
}

function DiscoveryShell({
  title,
  children,
  back = false,
  footer,
}: {
  title: string;
  children: ReactNode;
  back?: boolean;
  footer?: ReactNode;
}) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (back) headingRef.current?.focus();
  }, [back]);
  return (
    <div className="discovery-surface">
      <div className={`discovery-shell${footer ? " discovery-with-footer" : ""}`}>
        <a className="discovery-skip" href="#discovery-main">
          Skip to main content
        </a>
        {back && (
          <a
            className="discovery-back"
            href="/events?view=all"
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              navigateTo("/events?view=all");
            }}
          >
            <ArrowLeft aria-hidden="true" size={18} />
            Events
          </a>
        )}
        <header>
          <h1 ref={headingRef} tabIndex={-1}>
            {title}
          </h1>
        </header>
        <main id="discovery-main" tabIndex={-1}>
          {children}
        </main>
        {footer && <footer className="discovery-footer">{footer}</footer>}
      </div>
    </div>
  );
}

export function AdHocCreationPage() {
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

    const payload = (await response.json().catch(() => ({}))) as { gameId?: string };
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
    <DiscoveryShell title="Ad Hoc Game" back>
      <p className="creation-description">
        Create a quick game.
        <br />
        Perfect for practice or friendly matches.
      </p>
      <form
        className="creation-form"
        onSubmit={(event) => {
          event.preventDefault();
          void beginCreateGame();
        }}
      >
        <CreationTeam
          side="home"
          name={homeName}
          color={homeColor}
          onName={setHomeName}
          onColor={setHomeColor}
        />
        <CreationTeam
          side="away"
          name={awayName}
          color={awayColor}
          onName={setAwayName}
          onColor={setAwayColor}
        />
        <button
          ref={replacementTriggerRef}
          type="submit"
          className="discovery-primary"
          disabled={creationPending || entry.busy}
        >
          Create game
        </button>
        {creationStatus !== null ? (
          <p
            className={creationAlert ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
            role={creationAlert ? "alert" : "status"}
            aria-live="polite"
          >
            {creationStatus}
          </p>
        ) : null}
      </form>
      {entry.dialog}
    </DiscoveryShell>
  );
}

const CREATION_SWATCHES = [
  { name: "Red", color: "#ff4d35" },
  { name: "Blue", color: "#00afe8" },
  { name: "Green", color: "#21823b" },
  { name: "Yellow", color: "#f4bc00" },
  { name: "Purple", color: "#7956a8" },
  { name: "Grey", color: "#92989c" },
];

function CreationTeam({
  side,
  name,
  color,
  onName,
  onColor,
}: {
  side: "home" | "away";
  name: string;
  color: string;
  onName: (value: string) => void;
  onColor: (value: string) => void;
}) {
  const title = side === "home" ? "Home" : "Away";
  return (
    <fieldset className="creation-team">
      <legend>Team {side === "home" ? "1 (Home)" : "2 (Away)"}</legend>
      <div className="creation-name" style={{ borderColor: color }}>
        <Label className="sr-only" htmlFor={`${side}-name`}>
          {title} team
        </Label>
        <Input
          id={`${side}-name`}
          value={name}
          required
          onChange={(event) => onName(event.target.value)}
        />
        <Shield aria-hidden="true" style={{ color }} size={34} />
      </div>
      <p className="creation-color-label">Team color</p>
      <div className="creation-swatches" role="group" aria-label={`${title} team color presets`}>
        {CREATION_SWATCHES.map((swatch) => (
          <button
            key={swatch.color}
            type="button"
            aria-label={`${title} ${swatch.name}`}
            aria-pressed={color.toLowerCase() === swatch.color}
            style={{ backgroundColor: swatch.color }}
            onClick={() => onColor(swatch.color)}
          >
            {color.toLowerCase() === swatch.color && <Check aria-hidden="true" />}
          </button>
        ))}
      </div>
      <div className="creation-custom">
        <Label htmlFor={`${side}-color`}>Custom {side} color</Label>
        <input
          id={`${side}-color`}
          aria-label={`${title} color`}
          type="color"
          value={color}
          onChange={(event) => onColor(event.target.value)}
        />
      </div>
    </fieldset>
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

function isGameFinished(game: PublicAudienceGameProjection): boolean {
  return game.operationalStatus === "finished" || game.result.status === "finished";
}

function gameStatusLabels(game: PublicAudienceGameProjection): string[] {
  if (isGameFinished(game)) return ["Finished"];
  const labels = [
    game.operationalStatus === "scheduled" ? "Not started" : gamePhaseLabel(game.phase),
  ];
  if (game.operationalStatus === "paused" || game.operationalStatus === "suspended")
    labels.push(operationalStatusLabel(game.operationalStatus));
  if (game.operationalStatus !== "scheduled" && game.phase === "overtime")
    labels.push(`Target ${game.overtimeTarget ?? "—"}`);
  return labels;
}

function gameAnnouncement(game: PublicAudienceGameProjection): string {
  return `${formatScoreAnnouncement(game)}. ${gameStatusLabels(game).join(". ")}.`;
}

function eventAnnouncement(event: PublicAudienceEventProjection): string {
  const upcomingCount = nextUnstartedGames(event.schedule).length;
  const liveScores = event.schedule.runningGames.map(formatScoreAnnouncement).join("; ");
  const liveSummary =
    liveScores.length === 0
      ? "There are no running Games."
      : `${event.schedule.runningGames.length} running Game${event.schedule.runningGames.length === 1 ? "" : "s"}: ${liveScores}.`;
  const timelineCount = event.schedule.scheduleGames.reduce(
    (count, game) => count + game.timeline.length,
    0,
  );
  return `${liveSummary} ${upcomingCount} upcoming Game${upcomingCount === 1 ? "" : "s"}. ${timelineCount} public Timeline entr${timelineCount === 1 ? "y" : "ies"}.`;
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
          <Button onClick={() => navigateTo("/events?view=all")}>
            <ArrowLeft size={18} aria-hidden="true" />
            Back to Home
          </Button>
        </CardContent>
      </Card>
    </PublicShell>
  );
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
