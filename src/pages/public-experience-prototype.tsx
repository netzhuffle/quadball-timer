// PROTOTYPE — one approved, throwaway public experience direction on
// `/prototype/public-experience`. Rewrite or delete after the Wayfinder decision.
import {
  ArrowLeft,
  CalendarDays,
  Check,
  ChevronRight,
  Flag,
  Plus,
  Shield,
  Timer,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import "./public-experience-prototype.css";

type Screen = "current" | "schedule" | "events" | "game" | "create";
type GamePhase = "Seeker Floor" | "Seekers Released" | "Overtime";
type TeamSide = "home" | "away";
type TimelineKind = "flag" | "goal" | "yellow-card" | "blue-card" | "phase" | "overtime";

type ArenaGame = {
  id: string;
  pitch: string;
  home: string;
  homeShort: string;
  away: string;
  awayShort: string;
  homeScore: number;
  awayScore: number;
  clock: string;
  phase: GamePhase;
  homeColor: string;
  awayColor: string;
  flagCatch?: TeamSide;
};

type ScheduleGame = {
  id: string;
  time: string;
  pitch: string;
  home: string;
  away: string;
  homeScore?: number;
  awayScore?: number;
  status: "completed" | "live" | "upcoming";
  flagCatch?: TeamSide;
};

type TimelineEvent = {
  id: string;
  time: string;
  kind: TimelineKind;
  side?: TeamSide;
  title: string;
  team?: string;
  person?: string;
  score?: string;
  detail?: string;
};

const arenaGames: ArenaGame[] = [
  {
    id: "pitch-1",
    pitch: "Pitch 1",
    home: "London Lions",
    homeShort: "LL",
    away: "Bristol Badgers",
    awayShort: "BB",
    homeScore: 80,
    awayScore: 60,
    clock: "09:41",
    phase: "Seeker Floor",
    homeColor: "#e63d35",
    awayColor: "#2f72b8",
    flagCatch: "home",
  },
  {
    id: "pitch-2",
    pitch: "Pitch 2",
    home: "Manchester Marauders",
    homeShort: "MM",
    away: "Oxford Owls",
    awayShort: "OO",
    homeScore: 50,
    awayScore: 40,
    clock: "07:12",
    phase: "Seekers Released",
    homeColor: "#1c7a45",
    awayColor: "#075493",
  },
  {
    id: "pitch-3",
    pitch: "Pitch 3",
    home: "Leeds Llamas",
    homeShort: "LL",
    away: "Cambridge Capybaras",
    awayShort: "CC",
    homeScore: 20,
    awayScore: 30,
    clock: "05:33",
    phase: "Seeker Floor",
    homeColor: "#7250a3",
    awayColor: "#ec6d31",
  },
];

const scheduleGames: ScheduleGame[] = [
  {
    id: "past-1",
    time: "09:00",
    pitch: "Pitch 1",
    home: "St. Gallen Unicorns",
    away: "Winterthur Warriors",
    homeScore: 60,
    awayScore: 40,
    status: "completed",
  },
  {
    id: "past-2",
    time: "11:45",
    pitch: "Pitch 2",
    home: "Berne Bears",
    away: "Fribourg Falcons",
    homeScore: 70,
    awayScore: 50,
    status: "completed",
  },
  ...arenaGames.map<ScheduleGame>((game) => ({
    id: `live-${game.id}`,
    time: "14:00",
    pitch: game.pitch,
    home: game.home,
    away: game.away,
    homeScore: game.homeScore,
    awayScore: game.awayScore,
    status: "live",
    flagCatch: game.flagCatch,
  })),
  {
    id: "next-1",
    time: "15:30",
    pitch: "Pitch 1",
    home: "Nottingham Knights",
    away: "Birmingham Titans",
    status: "upcoming",
  },
  {
    id: "next-2",
    time: "15:30",
    pitch: "Pitch 2",
    home: "Sheffield Sharks",
    away: "Cardiff Crows",
    status: "upcoming",
  },
  {
    id: "next-3",
    time: "15:30",
    pitch: "Pitch 3",
    home: "Exeter Eagles",
    away: "Durham Dolphins",
    status: "upcoming",
  },
  {
    id: "later-1",
    time: "16:30",
    pitch: "Pitch 1",
    home: "Coventry Comets",
    away: "Reading Raptors",
    status: "upcoming",
  },
  {
    id: "later-2",
    time: "16:30",
    pitch: "Pitch 2",
    home: "Bath Bulls",
    away: "Lancaster Lynx",
    status: "upcoming",
  },
  {
    id: "later-3",
    time: "16:30",
    pitch: "Pitch 3",
    home: "York Valkyries",
    away: "Liverpool Legends",
    status: "upcoming",
  },
];

const timeline: TimelineEvent[] = [
  {
    id: "flag",
    time: "27:18",
    kind: "flag",
    side: "home",
    title: "Flag catch",
    team: "Basel Basilisks",
    person: "#15 Jonas Meier",
    score: "110* : 100",
  },
  {
    id: "goal-home",
    time: "26:24",
    kind: "goal",
    side: "home",
    title: "Goal",
    team: "Basel Basilisks",
    person: "#17 Lukas Vogel",
    score: "110 : 100",
  },
  {
    id: "goal-away",
    time: "24:31",
    kind: "goal",
    side: "away",
    title: "Goal",
    team: "Bern Krakens",
    person: "#4 M. Keller",
    score: "100 : 100",
  },
  {
    id: "yellow-away",
    time: "22:05",
    kind: "yellow-card",
    side: "away",
    title: "Yellow card",
    team: "Bern Krakens",
    person: "#12 Simon Schmidt",
  },
  {
    id: "blue-home",
    time: "21:47",
    kind: "blue-card",
    side: "home",
    title: "Blue card",
    team: "Basel Basilisks",
    person: "#8 Mara Bieri",
  },
  {
    id: "overtime",
    time: "20:00",
    kind: "overtime",
    title: "Overtime started",
    detail: "Target score 130",
  },
  {
    id: "release",
    time: "20:00",
    kind: "phase",
    title: "Seekers released",
  },
  {
    id: "goal-away-2",
    time: "19:58",
    kind: "goal",
    side: "away",
    title: "Goal",
    team: "Bern Krakens",
    person: "#11 Noa Gasser",
    score: "90 : 100",
  },
  {
    id: "goal-home-2",
    time: "17:10",
    kind: "goal",
    side: "home",
    title: "Goal",
    team: "Basel Basilisks",
    person: "#21 Tim Schmid",
    score: "90 : 90",
  },
];

const palette = ["#e43d36", "#0e4e83", "#1b7a43", "#efaa16", "#7251a3", "#89939c"] as const;

export function PublicExperiencePrototype() {
  const initialScreen = useMemo(readScreen, []);
  const [screen, setScreen] = useState<Screen>(initialScreen);

  const navigate = (next: Screen) => {
    setScreen(next);
    const params = new URLSearchParams(window.location.search);
    params.set("screen", next);
    window.history.pushState(null, "", `${window.location.pathname}?${params.toString()}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  useEffect(() => {
    const onPopState = () => setScreen(readScreen());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return (
    <main className="arena-prototype">
      <div className="arena-phone">
        {screen === "current" ? <CurrentEvent navigate={navigate} /> : null}
        {screen === "schedule" ? <EventSchedule navigate={navigate} /> : null}
        {screen === "events" ? <EventsHome navigate={navigate} /> : null}
        {screen === "game" ? <SpectatorGame navigate={navigate} /> : null}
        {screen === "create" ? <CreateAdHocGame navigate={navigate} /> : null}
      </div>
    </main>
  );
}

function CurrentEvent({ navigate }: { navigate: (screen: Screen) => void }) {
  const nextGames = scheduleGames.filter((game) => game.time === "15:30");

  return (
    <div className="arena-screen current-event-screen">
      <BackButton label="All events" onClick={() => navigate("events")} />
      <PageHeading title="SQM 2026" subtitle="Sunday, 16 August 2026" calendar />

      <section className="live-arena" aria-labelledby="live-arena-title">
        <div className="live-arena-heading">
          <h2 id="live-arena-title">Live arena</h2>
          <span>
            <i /> 3 games running
          </span>
        </div>
        <div className="arena-game-stack">
          {arenaGames.map((game) => (
            <ArenaGameLane key={game.id} game={game} onClick={() => navigate("game")} />
          ))}
        </div>
        <p className="arena-flag-legend">
          <FlagMark /> Flag catch
        </p>
      </section>

      <section className="up-next" aria-labelledby="up-next-title">
        <div className="up-next-heading">
          <h2 id="up-next-title">Up next · 15:30</h2>
          <span>3 games</span>
        </div>
        <div className="up-next-grid">
          {nextGames.map((game) => (
            <UpcomingMiniGame key={game.id} game={game} />
          ))}
        </div>
      </section>

      <button className="schedule-link" onClick={() => navigate("schedule")}>
        View complete event schedule <ChevronRight />
      </button>
    </div>
  );
}

function ArenaGameLane({ game, onClick }: { game: ArenaGame; onClick: () => void }) {
  const style = { "--home-team": game.homeColor, "--away-team": game.awayColor } as CSSProperties;

  return (
    <button className="arena-game-lane" style={style} onClick={onClick}>
      <span className="arena-pitch">{game.pitch}</span>
      <span className="arena-side home-side">
        <TeamCrest label={game.homeShort} />
        <b>{game.home}</b>
      </span>
      <span className="arena-game-center">
        <time>{game.clock}</time>
        <small>{game.phase}</small>
        <span className="arena-score">
          <strong>
            {game.homeScore}
            {game.flagCatch === "home" ? <FlagMark /> : null}
          </strong>
          <i>vs</i>
          <strong>
            {game.awayScore}
            {game.flagCatch === "away" ? <FlagMark /> : null}
          </strong>
        </span>
      </span>
      <span className="arena-side away-side">
        <TeamCrest label={game.awayShort} />
        <b>{game.away}</b>
      </span>
    </button>
  );
}

function UpcomingMiniGame({ game }: { game: ScheduleGame }) {
  return (
    <article className="upcoming-mini-game">
      <small>{game.pitch}</small>
      <div>
        <TeamCrest label={initials(game.home)} compact />
        <span>vs</span>
        <TeamCrest label={initials(game.away)} compact />
      </div>
      <p>
        {game.home}
        <br />
        {game.away}
      </p>
    </article>
  );
}

function EventSchedule({ navigate }: { navigate: (screen: Screen) => void }) {
  const past = scheduleGames.filter((game) => game.status === "completed");
  const live = scheduleGames.filter((game) => game.status === "live");
  const upcoming = scheduleGames.filter((game) => game.status === "upcoming");

  return (
    <div className="arena-screen schedule-screen">
      <BackButton label="SQM 2026" onClick={() => navigate("current")} />
      <PageHeading title="Sunday, 16 August" subtitle="3 Pitches · chronological schedule" />
      <div className="event-time-rail">
        <ScheduleSlot time="Past" games={past} />
        <div className="rail-now">
          <span>Now</span>
        </div>
        <ScheduleSlot time="14:00" games={live} live onGame={() => navigate("game")} />
        <ScheduleSlot
          time="15:30"
          games={upcoming.filter((game) => game.time === "15:30")}
          label="Up next"
        />
        <ScheduleSlot time="16:30" games={upcoming.filter((game) => game.time === "16:30")} />
      </div>
    </div>
  );
}

function ScheduleSlot({
  time,
  games: slotGames,
  label,
  live = false,
  onGame,
}: {
  time: string;
  games: ScheduleGame[];
  label?: string;
  live?: boolean;
  onGame?: () => void;
}) {
  return (
    <section className={`schedule-slot ${live ? "is-live" : ""}`}>
      <header>
        <time>{time}</time>
        {label ? <span>{label}</span> : null}
      </header>
      <div className="schedule-branches">
        {slotGames.map((game) => (
          <button key={game.id} onClick={live ? onGame : undefined}>
            <span className="schedule-pitch">{game.pitch}</span>
            <span className="schedule-matchup">
              <b>{game.home}</b>
              <b>{game.away}</b>
            </span>
            <span className="schedule-score">
              {game.homeScore === undefined ? null : (
                <>
                  <b>
                    {game.homeScore}
                    {game.flagCatch === "home" ? <FlagMark /> : null}
                  </b>
                  <b>
                    {game.awayScore}
                    {game.flagCatch === "away" ? <FlagMark /> : null}
                  </b>
                </>
              )}
            </span>
            {live ? <span className="schedule-live-label">Live</span> : null}
          </button>
        ))}
      </div>
    </section>
  );
}

function EventsHome({ navigate }: { navigate: (screen: Screen) => void }) {
  return (
    <div className="arena-screen events-home-screen">
      <PageHeading title="Events" />
      <div className="events-rail">
        <EventStop
          month="Aug"
          day="16"
          title="SQM 2026"
          detail="Basel, Switzerland"
          date="14–16 August 2026"
          status="3 games running"
          current
          onClick={() => navigate("current")}
        />
        <EventStop
          month="Sep"
          day="5–6"
          title="Swiss Quadball Cup 2026"
          detail="Zürich, Switzerland"
        />
        <EventStop month="Sep" day="26–27" title="Alpine Cup 2026" detail="Innsbruck, Austria" />
        <EventStop month="Jun" day="6–7" title="Nordic Games 2026" detail="Gothenburg, Sweden" />
        <button className="ad-hoc-action" onClick={() => navigate("create")}>
          <Plus /> Start an Ad Hoc Game
        </button>
        <EventStop month="Jul" day="18–20" title="EQC 2026" detail="Brno, Czechia" past />
        <EventStop
          month="May"
          day="23–24"
          title="Central European Cup 2026"
          detail="Vienna, Austria"
          past
        />
      </div>
    </div>
  );
}

function EventStop({
  month,
  day,
  title,
  detail,
  date,
  status,
  current = false,
  past = false,
  onClick,
}: {
  month: string;
  day: string;
  title: string;
  detail: string;
  date?: string;
  status?: string;
  current?: boolean;
  past?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      className={`event-stop ${current ? "current" : ""} ${past ? "past" : ""}`}
      onClick={onClick}
    >
      <span className="event-node" />
      <span className="event-date">
        <small>{month}</small>
        <b>{day}</b>
      </span>
      <span className="event-copy">
        <strong>{title}</strong>
        <small>{detail}</small>
        {date ? <small>{date}</small> : null}
        {status ? (
          <em>
            <i /> {status}
          </em>
        ) : null}
      </span>
      {onClick ? <ChevronRight /> : null}
    </button>
  );
}

function SpectatorGame({ navigate }: { navigate: (screen: Screen) => void }) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 310);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="arena-screen spectator-game-screen">
      <CompactScore visible={scrolled} navigate={navigate} />
      <div className="game-topbar">
        <BackButton label="SQM 2026" onClick={() => navigate("current")} />
        <span>
          <Shield /> Pitch 2
        </span>
      </div>
      <section className="arena-scoreboard" aria-label="Basel Basilisks 110, Bern Krakens 100">
        <div className="scoreboard-team scoreboard-home">
          <TeamCrest label="BB" />
          <b>
            Basel
            <br />
            Basilisks
          </b>
          <strong>
            110
            <FlagMark />
          </strong>
        </div>
        <div className="scoreboard-clock">
          <time>27:18</time>
        </div>
        <div className="scoreboard-team scoreboard-away">
          <TeamCrest label="BK" />
          <b>
            Bern
            <br />
            Krakens
          </b>
          <strong>100</strong>
        </div>
      </section>
      <div className="scoreboard-facts">
        <b>Running</b>
        <span>Overtime</span>
        <span>Target 130</span>
      </div>

      <section className="sided-timeline" aria-labelledby="game-timeline-title">
        <h1 id="game-timeline-title">Game Timeline</h1>
        <div className="timeline-spine">
          {timeline.map((event) =>
            event.side ? (
              <TeamPlay key={event.id} event={event} />
            ) : (
              <PhasePlay key={event.id} event={event} />
            ),
          )}
        </div>
        <p className="game-flag-legend">
          <FlagMark /> Flag catch
        </p>
      </section>
      {scrolled ? (
        <button
          className="new-play-button"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        >
          ↑ 2 new plays
        </button>
      ) : null}
    </div>
  );
}

function CompactScore({
  visible,
  navigate,
}: {
  visible: boolean;
  navigate: (screen: Screen) => void;
}) {
  return (
    <div className={`compact-score ${visible ? "visible" : ""}`}>
      <button aria-label="Back to SQM 2026" onClick={() => navigate("current")}>
        <ArrowLeft />
      </button>
      <span className="compact-home">
        <TeamCrest label="BB" compact />
        <strong>
          110
          <FlagMark />
        </strong>
      </span>
      <span className="compact-clock">
        <b>27:18</b>
        <small>OT · 130</small>
      </span>
      <span className="compact-away">
        <strong>100</strong>
        <TeamCrest label="BK" compact />
      </span>
    </div>
  );
}

function TeamPlay({ event }: { event: TimelineEvent }) {
  const side = event.side ?? "home";
  return (
    <article className={`team-play ${side} ${event.kind}`}>
      <time>{event.time}</time>
      <EventGlyph kind={event.kind} />
      <div className="play-copy">
        <strong>{event.title}</strong>
        <b>{event.team}</b>
        <span>{event.person}</span>
        {event.score ? <em>{event.score}</em> : null}
      </div>
    </article>
  );
}

function PhasePlay({ event }: { event: TimelineEvent }) {
  const Icon: LucideIcon = event.kind === "overtime" ? Timer : Users;
  return (
    <article className={`phase-play ${event.kind}`}>
      <time>{event.time}</time>
      <span className="phase-icon">
        <Icon />
      </span>
      <div>
        <strong>{event.title}</strong>
        {event.detail ? <span>{event.detail}</span> : null}
      </div>
    </article>
  );
}

function EventGlyph({ kind }: { kind: TimelineKind }) {
  if (kind === "flag")
    return (
      <span className="event-glyph">
        <Flag />
      </span>
    );
  if (kind === "goal")
    return (
      <span className="event-glyph goal-glyph" aria-label="Goal">
        <i />
        <i />
        <i />
      </span>
    );
  return (
    <span
      className={`event-glyph card-glyph ${kind}`}
      aria-label={kind === "yellow-card" ? "Yellow card" : "Blue card"}
    />
  );
}

function CreateAdHocGame({ navigate }: { navigate: (screen: Screen) => void }) {
  const [created, setCreated] = useState(false);
  const [homeName, setHomeName] = useState("Home");
  const [awayName, setAwayName] = useState("Away");
  const [homeColor, setHomeColor] = useState<string>(palette[0]);
  const [awayColor, setAwayColor] = useState<string>(palette[1]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setCreated(true);
  };

  if (created) {
    return (
      <div className="arena-screen created-state">
        <Check />
        <h1>Ad Hoc Game ready</h1>
        <p>
          {homeName} vs {awayName}
        </p>
        <button onClick={() => navigate("game")}>Open game</button>
      </div>
    );
  }

  return (
    <div className="arena-screen create-game-screen">
      <BackButton label="Events" onClick={() => navigate("events")} />
      <PageHeading
        title="Ad Hoc Game"
        subtitle="Create a quick game. Perfect for practice or friendly matches."
      />
      <form onSubmit={submit}>
        <TeamSetup
          label="Team 1 (Home)"
          name={homeName}
          setName={setHomeName}
          color={homeColor}
          setColor={setHomeColor}
        />
        <TeamSetup
          label="Team 2 (Away)"
          name={awayName}
          setName={setAwayName}
          color={awayColor}
          setColor={setAwayColor}
        />
        <button className="create-game-action" type="submit">
          Create game
        </button>
      </form>
    </div>
  );
}

function TeamSetup({
  label,
  name,
  setName,
  color,
  setColor,
}: {
  label: string;
  name: string;
  setName: (name: string) => void;
  color: string;
  setColor: (color: string) => void;
}) {
  return (
    <fieldset className="team-setup" style={{ "--team-color": color } as CSSProperties}>
      <legend>{label}</legend>
      <label className="team-name-field">
        <span className="sr-only">{label} name</span>
        <input value={name} onChange={(event) => setName(event.target.value)} />
        <Shield />
      </label>
      <span className="color-label">Team color</span>
      <div className="color-swatches">
        {palette.map((swatch) => (
          <button
            key={swatch}
            type="button"
            className={swatch === color ? "selected" : ""}
            style={{ backgroundColor: swatch }}
            aria-label={`Use ${swatch}`}
            aria-pressed={swatch === color}
            onClick={() => setColor(swatch)}
          >
            {swatch === color ? <Check /> : null}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function PageHeading({
  title,
  subtitle,
  calendar = false,
}: {
  title: string;
  subtitle?: string;
  calendar?: boolean;
}) {
  return (
    <header className="arena-page-heading">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {calendar ? <CalendarDays /> : null}
    </header>
  );
}

function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="arena-back" onClick={onClick}>
      <ArrowLeft /> {label}
    </button>
  );
}

function TeamCrest({ label, compact = false }: { label: string; compact?: boolean }) {
  return (
    <span className={`team-crest ${compact ? "compact" : ""}`} aria-hidden="true">
      {label}
    </span>
  );
}

function FlagMark() {
  return (
    <sup className="flag-mark" aria-label="Flag catch">
      *
    </sup>
  );
}

function initials(name: string) {
  return name
    .split(" ")
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function readScreen(): Screen {
  const value = new URLSearchParams(window.location.search).get("screen");
  return value === "schedule" || value === "events" || value === "game" || value === "create"
    ? value
    : "current";
}
