// PROTOTYPE — C direction tested against a 96-game, six-pitch event.
import {
  ArrowLeft,
  CalendarClock,
  Check,
  CircleAlert,
  Copy,
  MapPin,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EventHub, type GameDayName } from "@/pages/event-operations-event-hub-prototype";
import { OperationsLensSwitch } from "@/pages/event-operations-lens-switch-prototype";
import { SlotSetupBoard } from "@/pages/event-operations-slot-setup-prototype";
import {
  PitchReassignmentPanel,
  type PitchReassignmentMode,
} from "@/pages/event-operations-pitch-reassignment-prototype";
import {
  ScheduleShiftPanel,
  shiftClockTime,
} from "@/pages/event-operations-schedule-shift-prototype";

type PrototypeRole = "event-admin" | "pitch-manager";
type BoardScreen = "hub" | "operations";
type OperationsLens = "slot" | "pitch";
type LargeGameStatus = "finished" | "live" | "ready" | "handoff" | "upcoming";

type LargeEventGame = {
  id: string;
  time: string;
  pitch: string;
  home: string;
  away: string;
  status: LargeGameStatus;
  controllers: number;
  code: string;
};

const PITCHES = ["Pitch 1", "Pitch 2", "Pitch 3", "Pitch 4", "Pitch 5", "Pitch 6"];
const SLOT_TIMES = ["09:00", "10:00", "11:00", "12:00", "14:00", "15:00", "16:00", "17:00"];
const TEAMS = [
  "Amsterdam Werewolves",
  "Antwerp Quidditch Club",
  "Basel Basilisks",
  "Berlin Bluecaps",
  "Brussels Qwaffles",
  "Darmstadt Athenas",
  "Eindhoven Panthers",
  "Groningen Griffins",
  "Hamburg Werewolves",
  "Lausanne Lumieres",
  "Paris Titans",
  "Turicum Thunderbirds",
];

const LARGE_EVENT_GAMES: LargeEventGame[] = PITCHES.flatMap((pitch, pitchIndex) =>
  SLOT_TIMES.map((time, slotIndex) => {
    const status: LargeGameStatus =
      slotIndex < 2
        ? "finished"
        : slotIndex === 2
          ? "live"
          : slotIndex === 3 && pitchIndex === 3
            ? "handoff"
            : slotIndex === 3
              ? "ready"
              : "upcoming";

    return {
      id: `pitch-${pitchIndex + 1}-slot-${slotIndex + 1}`,
      time,
      pitch,
      home: TEAMS[(pitchIndex * 2 + slotIndex) % TEAMS.length] ?? "Home team",
      away: TEAMS[(pitchIndex * 2 + slotIndex + 5) % TEAMS.length] ?? "Away team",
      status,
      controllers: status === "live" ? 2 : status === "ready" ? 1 : 0,
      code: `${["MINT", "FORK", "LAKE", "NOVA", "PINE", "WAVE"][pitchIndex]}-${20 + slotIndex * 7}`,
    };
  }),
);

const STATUS_LABELS: Record<LargeGameStatus, string> = {
  finished: "Finished",
  live: "Live · 18:24",
  ready: "Ready",
  handoff: "Needs handoff",
  upcoming: "Upcoming",
};

export function LargeEventOperationsVariant({
  role,
  setRole,
}: {
  role: PrototypeRole;
  setRole: (role: PrototypeRole) => void;
}) {
  const [screen, setScreen] = useState<BoardScreen>("hub");
  const [gameDay, setGameDay] = useState<GameDayName>("Saturday");
  const [lens, setLens] = useState<OperationsLens>("slot");
  const [pitch, setPitch] = useState("Pitch 4");
  const [selectedGameId, setSelectedGameId] = useState("pitch-4-slot-4");
  const [revealedGameId, setRevealedGameId] = useState<string | null>(null);
  const [rotatedGames, setRotatedGames] = useState<Set<string>>(() => new Set());
  const [slotOffsets, setSlotOffsets] = useState<number[]>(() => SLOT_TIMES.map(() => 0));
  const [gameOffsets, setGameOffsets] = useState<Record<string, number>>({});
  const [gamePitches, setGamePitches] = useState<Record<string, string>>({});

  const effectiveScreen = role === "pitch-manager" ? "operations" : screen;
  const assignedGames = LARGE_EVENT_GAMES.map((game) => ({
    ...game,
    pitch: gamePitches[game.id] ?? game.pitch,
  }));
  const pitchGames = assignedGames
    .filter((game) => game.pitch === pitch)
    .sort((first, second) => SLOT_TIMES.indexOf(first.time) - SLOT_TIMES.indexOf(second.time));
  const selectedGame =
    pitchGames.find((game) => game.id === selectedGameId) ??
    pitchGames.find((game) => game.status === "handoff") ??
    pitchGames.find((game) => game.status === "live") ??
    pitchGames[0]!;
  const shiftedSlotTimes = SLOT_TIMES.map((time, index) =>
    shiftClockTime(time, slotOffsets[index] ?? 0),
  );
  const gameTimes = Object.fromEntries(
    assignedGames.map((game) => {
      const slotIndex = SLOT_TIMES.indexOf(game.time);
      const totalOffset = (slotOffsets[slotIndex] ?? 0) + (gameOffsets[game.id] ?? 0);
      return [game.id, shiftClockTime(game.time, totalOffset)];
    }),
  );
  const conflictGameIds = findScheduleConflictGameIds(assignedGames);

  const shiftSlot = (slotIndex: number, minutes: number, cascade: boolean) => {
    setSlotOffsets((current) =>
      current.map((offset, index) =>
        index === slotIndex || (cascade && index > slotIndex) ? offset + minutes : offset,
      ),
    );
  };

  const shiftGame = (gameId: string, minutes: number, cascade: boolean) => {
    const game = assignedGames.find((candidate) => candidate.id === gameId);
    if (game === undefined) {
      return;
    }

    const gamesOnPitch = assignedGames
      .filter((candidate) => candidate.pitch === game.pitch)
      .sort((first, second) => SLOT_TIMES.indexOf(first.time) - SLOT_TIMES.indexOf(second.time));
    const gameIndex = gamesOnPitch.findIndex((candidate) => candidate.id === gameId);
    const affectedIds = new Set(
      gamesOnPitch
        .filter((_, index) => index === gameIndex || (cascade && index > gameIndex))
        .map((candidate) => candidate.id),
    );

    setGameOffsets((current) => {
      const next = { ...current };
      for (const affectedId of affectedIds) {
        next[affectedId] = (next[affectedId] ?? 0) + minutes;
      }
      return next;
    });
  };

  const reassignGame = (gameId: string, targetPitch: string, mode: PitchReassignmentMode) => {
    const game = assignedGames.find((candidate) => candidate.id === gameId);
    if (game === undefined || game.pitch === targetPitch) {
      return;
    }

    const targetGame = assignedGames.find(
      (candidate) =>
        candidate.id !== gameId && candidate.pitch === targetPitch && candidate.time === game.time,
    );

    setGamePitches((current) => ({
      ...current,
      [game.id]: targetPitch,
      ...(mode === "swap" && targetGame !== undefined ? { [targetGame.id]: game.pitch } : {}),
    }));
    setPitch(targetPitch);
    setSelectedGameId(game.id);
    setRevealedGameId(null);
  };

  const selectPitch = (nextPitch: string) => {
    const nextGames = assignedGames
      .filter((game) => game.pitch === nextPitch)
      .sort((first, second) => SLOT_TIMES.indexOf(first.time) - SLOT_TIMES.indexOf(second.time));
    const nextSelected =
      nextGames.find((game) => game.status === "handoff") ??
      nextGames.find((game) => game.status === "live") ??
      nextGames[0];
    setPitch(nextPitch);
    if (nextSelected !== undefined) {
      setSelectedGameId(nextSelected.id);
    }
    setRevealedGameId(null);
  };

  return (
    <LargeEventShell
      role={role}
      setRole={setRole}
      title={
        effectiveScreen === "hub" ? "EQC 2026" : role === "event-admin" ? "Live operations" : pitch
      }
      subtitle={
        effectiveScreen === "hub"
          ? "2 days · 96 games · 6 pitches"
          : role === "event-admin"
            ? lens === "slot"
              ? `${gameDay} · Preparing Slot 4 of 8`
              : `${gameDay} · Slot 3 of 8`
            : `EQC 2026 · ${gameDay}`
      }
      onBack={
        effectiveScreen === "operations" && role === "event-admin"
          ? () => setScreen("hub")
          : undefined
      }
    >
      {effectiveScreen === "hub" ? (
        <EventHub
          day={gameDay}
          setDay={setGameDay}
          onOpenOperations={() => setScreen("operations")}
        />
      ) : (
        <OperationsBoard
          role={role}
          lens={lens}
          setLens={setLens}
          pitch={pitch}
          selectPitch={selectPitch}
          games={pitchGames}
          allGames={assignedGames}
          gameTimes={gameTimes}
          conflictGameIds={conflictGameIds}
          day={gameDay}
          selectedGame={selectedGame}
          selectGame={(gameId) => {
            setSelectedGameId(gameId);
            setRevealedGameId(null);
          }}
          revealedGameId={revealedGameId}
          revealGame={setRevealedGameId}
          rotatedGames={rotatedGames}
          rotateGrant={(gameId) => {
            setRotatedGames((current) => new Set(current).add(gameId));
            setRevealedGameId(gameId);
          }}
          slotTimes={shiftedSlotTimes}
          shiftSlot={shiftSlot}
          shiftGame={shiftGame}
          reassignGame={reassignGame}
        />
      )}
    </LargeEventShell>
  );
}

function OperationsBoard({
  role,
  lens,
  setLens,
  pitch,
  selectPitch,
  games,
  allGames,
  gameTimes,
  conflictGameIds,
  day,
  selectedGame,
  selectGame,
  revealedGameId,
  revealGame,
  rotatedGames,
  rotateGrant,
  slotTimes,
  shiftSlot,
  shiftGame,
  reassignGame,
}: {
  role: PrototypeRole;
  lens: OperationsLens;
  setLens: (lens: OperationsLens) => void;
  pitch: string;
  selectPitch: (pitch: string) => void;
  games: LargeEventGame[];
  allGames: LargeEventGame[];
  gameTimes: Record<string, string>;
  conflictGameIds: Set<string>;
  day: GameDayName;
  selectedGame: LargeEventGame;
  selectGame: (gameId: string) => void;
  revealedGameId: string | null;
  revealGame: (gameId: string | null) => void;
  rotatedGames: Set<string>;
  rotateGrant: (gameId: string) => void;
  slotTimes: string[];
  shiftSlot: (slotIndex: number, minutes: number, cascade: boolean) => void;
  shiftGame: (gameId: string, minutes: number, cascade: boolean) => void;
  reassignGame: (gameId: string, targetPitch: string, mode: PitchReassignmentMode) => void;
}) {
  const [adjustingGameId, setAdjustingGameId] = useState<string | null>(null);
  const [reassigningGameId, setReassigningGameId] = useState<string | null>(null);
  const conflictingPitches = new Set(
    allGames.filter((game) => conflictGameIds.has(game.id)).map((game) => game.pitch),
  );

  if (role === "event-admin" && lens === "slot") {
    return (
      <main className="px-4 py-4">
        <OperationsLensSwitch lens={lens} setLens={setLens} />
        <SlotSetupBoard
          day={day}
          slotTimes={slotTimes}
          games={allGames}
          gameTimes={gameTimes}
          conflictGameIds={conflictGameIds}
          onOpenPitch={(nextPitch) => {
            selectPitch(nextPitch);
            setLens("pitch");
          }}
          onShiftSlot={shiftSlot}
          onShiftGame={shiftGame}
        />
      </main>
    );
  }

  return (
    <main className="px-4 py-4">
      {role === "event-admin" ? <OperationsLensSwitch lens={lens} setLens={setLens} /> : null}
      {role === "event-admin" ? (
        <section className="mb-4">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <p className="text-xs font-bold tracking-wider text-slate-500 uppercase">
                Pitch health
              </p>
              <p className="text-xs text-slate-500">
                {conflictingPitches.size === 0
                  ? "No schedule conflicts"
                  : `${conflictingPitches.size} schedule conflict${conflictingPitches.size === 1 ? "" : "s"}`}{" "}
                · 1 handoff
              </p>
            </div>
            <span
              className={cn(
                "rounded-full px-2 py-1 text-[10px] font-bold",
                conflictGameIds.size > 0
                  ? "bg-red-100 text-red-800"
                  : "bg-amber-100 text-amber-800",
              )}
            >
              {conflictGameIds.size > 0 ? "Conflict" : "1 alert"}
            </span>
          </div>
          <div className="grid grid-cols-6 gap-1.5">
            {PITCHES.map((pitchName, index) => {
              const active = pitchName === pitch;
              const alert = allGames.some(
                (game) => game.pitch === pitchName && game.status === "handoff",
              );
              const conflict = conflictingPitches.has(pitchName);
              return (
                <button
                  key={pitchName}
                  aria-label={`${pitchName}${conflict ? ", schedule conflict" : alert ? ", handoff needed" : ", live"}`}
                  className={cn(
                    "relative min-h-12 rounded-xl border text-xs font-bold",
                    active ? "border-emerald-700 bg-emerald-950 text-white" : "bg-white",
                  )}
                  onClick={() => selectPitch(pitchName)}
                >
                  P{index + 1}
                  <span
                    className={cn(
                      "absolute top-1.5 right-1.5 size-1.5 rounded-full",
                      conflict ? "bg-red-500" : alert ? "bg-amber-500" : "bg-emerald-500",
                    )}
                  />
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      <div className="mb-3 flex items-end justify-between">
        <div>
          <p className="text-xs font-bold tracking-wider text-slate-500 uppercase">{pitch}</p>
          <h2 className="text-lg font-semibold">
            {games.length} scheduled games
            {games.some((game) => conflictGameIds.has(game.id)) ? (
              <span className="ml-2 text-xs font-bold text-red-700">Conflict</span>
            ) : null}
          </h2>
        </div>
        <p className="text-xs text-slate-500">48 games today</p>
      </div>

      <div className="relative ml-2 border-l-2 border-dashed border-slate-300 pb-10">
        {games.map((game, index) => {
          const selected = selectedGame.id === game.id;
          const conflict = conflictGameIds.has(game.id);
          return (
            <section key={game.id} className="relative mb-2.5 pl-5 last:mb-0">
              <span
                className={cn(
                  "absolute top-4 -left-[7px] size-3 rounded-full border-[3px] border-slate-50",
                  game.status === "live" && "bg-emerald-500",
                  game.status === "handoff" && "bg-amber-500",
                  game.status === "finished" && "bg-slate-300",
                  (game.status === "ready" || game.status === "upcoming") && "bg-slate-500",
                )}
              />
              <button
                className={cn(
                  "w-full rounded-xl border bg-white px-3 py-2.5 text-left shadow-sm",
                  selected && "border-emerald-500 ring-2 ring-emerald-100",
                  conflict && "border-red-400 bg-red-50 ring-2 ring-red-100",
                )}
                onClick={() => {
                  setAdjustingGameId(null);
                  setReassigningGameId(null);
                  selectGame(game.id);
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-bold tabular-nums">
                    {gameTimes[game.id] ?? game.time} · Game {index + 1}
                  </p>
                  <LargeStatusLabel status={game.status} />
                </div>
                <p className="mt-1 truncate text-sm font-semibold">
                  {game.home} <span className="font-normal text-slate-400">vs</span> {game.away}
                </p>
                <p className="mt-1 flex items-center gap-1 text-[11px] text-slate-500">
                  <Smartphone className="size-3" /> {game.controllers || "No"} controllers
                </p>
                {conflict ? (
                  <p className="mt-1 flex items-center gap-1 text-[10px] font-bold text-red-700">
                    <CircleAlert className="size-3" /> Schedule Conflict · another game uses this
                    Pitch in Slot {SLOT_TIMES.indexOf(game.time) + 1}
                  </p>
                ) : null}
              </button>
            </section>
          );
        })}
      </div>

      <section className="sticky bottom-16 rounded-2xl border border-emerald-700 bg-emerald-950 p-3 text-white shadow-2xl">
        <div className="flex items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-emerald-700">
            <ShieldCheck className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">
              {gameTimes[selectedGame.id] ?? selectedGame.time} · {selectedGame.home} vs{" "}
              {selectedGame.away}
            </p>
            <p className="text-xs text-emerald-200">{STATUS_LABELS[selectedGame.status]}</p>
          </div>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Button
            className="border-emerald-700 bg-emerald-900 text-white hover:bg-emerald-800"
            variant="outline"
            onClick={() => revealGame(selectedGame.id)}
          >
            <QrCode /> Share
          </Button>
          <Button className="bg-white text-emerald-950 hover:bg-emerald-50">Open game</Button>
        </div>
        {role === "event-admin" ? (
          <div className="mt-2 grid grid-cols-2 gap-1">
            <button
              className="flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold text-emerald-200 hover:bg-white/5"
              onClick={() => {
                revealGame(null);
                setReassigningGameId(null);
                setAdjustingGameId(selectedGame.id);
              }}
            >
              <CalendarClock className="size-3.5" /> Adjust time
            </button>
            <button
              className="flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold text-emerald-200 hover:bg-white/5"
              onClick={() => {
                revealGame(null);
                setAdjustingGameId(null);
                setReassigningGameId(selectedGame.id);
              }}
            >
              <MapPin className="size-3.5" /> Change pitch
            </button>
          </div>
        ) : null}
        {revealedGameId === selectedGame.id ? (
          <GrantPanel
            role={role}
            game={selectedGame}
            rotated={rotatedGames.has(selectedGame.id)}
            onRotate={() => rotateGrant(selectedGame.id)}
          />
        ) : null}
      </section>

      {adjustingGameId === selectedGame.id ? (
        <ScheduleShiftPanel
          targetKind="Event Game"
          targetName={`${selectedGame.pitch} · ${selectedGame.home} vs ${selectedGame.away}`}
          currentTime={gameTimes[selectedGame.id] ?? selectedGame.time}
          cascadeLabel={`Also move later games on ${selectedGame.pitch}`}
          cascadeDetail={`${Math.max(0, games.length - games.findIndex((game) => game.id === selectedGame.id) - 1)} later games will move with the same spacing`}
          onApply={(minutes, cascade) => {
            shiftGame(selectedGame.id, minutes, cascade);
            setAdjustingGameId(null);
          }}
          onClose={() => setAdjustingGameId(null)}
        />
      ) : null}
      {reassigningGameId === selectedGame.id ? (
        <PitchReassignmentPanel
          currentPitch={selectedGame.pitch}
          gameName={`${selectedGame.home} vs ${selectedGame.away}`}
          currentTime={gameTimes[selectedGame.id] ?? selectedGame.time}
          slotNumber={SLOT_TIMES.indexOf(selectedGame.time) + 1}
          options={PITCHES.filter((pitchName) => pitchName !== selectedGame.pitch).map(
            (pitchName) => {
              const occupant = allGames.find(
                (game) => game.pitch === pitchName && game.time === selectedGame.time,
              );
              return {
                pitch: pitchName,
                isLivestream: pitchName === "Pitch 1",
                occupant:
                  occupant === undefined
                    ? null
                    : {
                        home: occupant.home,
                        away: occupant.away,
                        currentTime: gameTimes[occupant.id] ?? occupant.time,
                      },
              };
            },
          )}
          onApply={(targetPitch, mode) => {
            reassignGame(selectedGame.id, targetPitch, mode);
            setReassigningGameId(null);
          }}
          onClose={() => setReassigningGameId(null)}
        />
      ) : null}
    </main>
  );
}

function LargeEventShell({
  title,
  subtitle,
  role,
  setRole,
  onBack,
  children,
}: {
  title: string;
  subtitle: string;
  role: PrototypeRole;
  setRole: (role: PrototypeRole) => void;
  onBack?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto min-h-screen w-full max-w-md bg-slate-50 pb-24 shadow-2xl">
      <header className="border-b border-emerald-900 bg-emerald-950 px-4 pt-5 pb-4 text-white">
        <div className="flex items-start gap-2">
          {onBack !== undefined ? (
            <Button
              aria-label="Back to event setup"
              className="-ml-2 text-white hover:bg-white/10 hover:text-white"
              size="icon-sm"
              variant="ghost"
              onClick={onBack}
            >
              <ArrowLeft />
            </Button>
          ) : null}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold tracking-tight">{title}</h1>
            <p className="mt-0.5 text-xs text-white/70">{subtitle}</p>
          </div>
          <span className="rounded-md border border-white/20 px-2 py-1 text-[10px] font-bold tracking-wider uppercase text-white/70">
            Prototype
          </span>
        </div>
        <div className="mt-4 grid grid-cols-2 rounded-xl bg-black/20 p-1">
          <RoleButton
            active={role === "event-admin"}
            label="Event Admin"
            onClick={() => setRole("event-admin")}
          />
          <RoleButton
            active={role === "pitch-manager"}
            label="Pitch Manager"
            onClick={() => setRole("pitch-manager")}
          />
        </div>
        <p className="mt-1.5 text-center text-[10px] font-medium text-white/50">
          Prototype access lens · real access comes from separate grants
        </p>
      </header>
      {children}
    </div>
  );
}

function RoleButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "min-h-9 rounded-lg px-3 text-xs font-semibold transition-colors",
        active ? "bg-white text-slate-950 shadow-sm" : "text-white/70 hover:text-white",
      )}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function LargeStatusLabel({ status }: { status: LargeGameStatus }) {
  return (
    <span
      className={cn(
        "whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold",
        status === "finished" && "bg-slate-100 text-slate-500",
        status === "live" && "bg-emerald-100 text-emerald-800",
        status === "handoff" && "bg-amber-100 text-amber-800",
        status === "ready" && "bg-blue-100 text-blue-800",
        status === "upcoming" && "bg-slate-100 text-slate-600",
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

function GrantPanel({
  role,
  game,
  rotated,
  onRotate,
}: {
  role: PrototypeRole;
  game: LargeEventGame;
  rotated: boolean;
  onRotate: () => void;
}) {
  return (
    <div className="mt-2 rounded-xl border border-white/20 bg-white/10 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold text-white/60 uppercase">Verbal control code</p>
          <p className="mt-0.5 text-xl font-black tracking-[0.2em]">
            {rotated ? "NOVA-64" : game.code}
          </p>
        </div>
        <Button aria-label="Copy control code" size="icon-sm" variant="secondary">
          <Copy />
        </Button>
      </div>
      {role === "event-admin" ? (
        <button
          className="mt-2 flex items-center gap-2 text-xs font-semibold text-white/80"
          onClick={onRotate}
        >
          {rotated ? <Check className="size-3.5" /> : <RefreshCw className="size-3.5" />}
          {rotated ? "Rotated for this handoff" : "Rotate compromised grant"}
        </button>
      ) : (
        <p className="mt-2 text-xs text-white/60">Event Admins manage and rotate this grant.</p>
      )}
    </div>
  );
}

function findScheduleConflictGameIds(games: LargeEventGame[]) {
  const gamesByPosition = new Map<string, LargeEventGame[]>();
  for (const game of games) {
    const key = `${game.pitch}:${game.time}`;
    const positionGames = gamesByPosition.get(key) ?? [];
    positionGames.push(game);
    gamesByPosition.set(key, positionGames);
  }

  return new Set(
    [...gamesByPosition.values()]
      .filter((positionGames) => positionGames.length > 1)
      .flatMap((positionGames) => positionGames.map((game) => game.id)),
  );
}
