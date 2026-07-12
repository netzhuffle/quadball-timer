// PROTOTYPE — Event Admin setup of bracket-dependent games by Game Slot.
import { CalendarClock, Check, ChevronRight, CircleAlert, Clock3, MapPin, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ScheduleShiftPanel } from "@/pages/event-operations-schedule-shift-prototype";

type SlotAssignment = {
  id: string;
  pitch: string;
  bracket: string;
  home: string | null;
  away: string | null;
  homeSource: string;
  awaySource: string;
};

type SlotOperationalGame = {
  id: string;
  time: string;
  pitch: string;
};

const SLOT_FOUR_ASSIGNMENTS: SlotAssignment[] = [
  {
    id: "pitch-1-slot-4",
    pitch: "Pitch 1",
    bracket: "Cup semifinal A",
    home: "Basel Basilisks",
    away: "Paris Titans",
    homeSource: "Winner Quarterfinal 1",
    awaySource: "Winner Quarterfinal 2",
  },
  {
    id: "pitch-2-slot-4",
    pitch: "Pitch 2",
    bracket: "Cup semifinal B",
    home: "Berlin Bluecaps",
    away: "Brussels Qwaffles",
    homeSource: "Winner Quarterfinal 3",
    awaySource: "Winner Quarterfinal 4",
  },
  {
    id: "pitch-3-slot-4",
    pitch: "Pitch 3",
    bracket: "Consolation semifinal A",
    home: "Amsterdam Werewolves",
    away: "Lausanne Lumieres",
    homeSource: "Loser Quarterfinal 1",
    awaySource: "Loser Quarterfinal 2",
  },
  {
    id: "pitch-4-slot-4",
    pitch: "Pitch 4",
    bracket: "Consolation semifinal B",
    home: null,
    away: null,
    homeSource: "Loser Quarterfinal 3",
    awaySource: "Loser Quarterfinal 4",
  },
  {
    id: "pitch-5-slot-4",
    pitch: "Pitch 5",
    bracket: "Plate semifinal A",
    home: "Eindhoven Panthers",
    away: "Groningen Griffins",
    homeSource: "Winner Plate Quarterfinal 1",
    awaySource: "Winner Plate Quarterfinal 2",
  },
  {
    id: "pitch-6-slot-4",
    pitch: "Pitch 6",
    bracket: "Plate semifinal B",
    home: null,
    away: null,
    homeSource: "Winner Plate Quarterfinal 3",
    awaySource: "Winner Plate Quarterfinal 4",
  },
];

export function SlotSetupBoard({
  day,
  slotTimes,
  games,
  gameTimes,
  conflictGameIds,
  onOpenPitch,
  onShiftSlot,
  onShiftGame,
}: {
  day: string;
  slotTimes: string[];
  games: SlotOperationalGame[];
  gameTimes: Record<string, string>;
  conflictGameIds: Set<string>;
  onOpenPitch: (pitch: string) => void;
  onShiftSlot: (slotIndex: number, minutes: number, cascade: boolean) => void;
  onShiftGame: (gameId: string, minutes: number, cascade: boolean) => void;
}) {
  const [slotIndex, setSlotIndex] = useState(3);
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<string | null>(null);
  const [confirmedAssignments, setConfirmedAssignments] = useState<Set<string>>(() => new Set());
  const [adjustingSlotTime, setAdjustingSlotTime] = useState(false);
  const [adjustingGameId, setAdjustingGameId] = useState<string | null>(null);

  const focusSlot = slotIndex === 3;
  const assignments = focusSlot ? SLOT_FOUR_ASSIGNMENTS : createPreviewAssignments(slotIndex);
  const selectedAssignment = assignments.find(
    (assignment) => assignment.id === selectedAssignmentId,
  );
  const readyCount = assignments.filter(isResolved).length;
  const waitingCount = assignments.length - readyCount;
  const selectedGame = games.find((game) => game.id === selectedAssignment?.id);
  const selectedPitch = selectedGame?.pitch ?? selectedAssignment?.pitch ?? "Pitch";
  const selectedTime =
    (selectedGame === undefined ? undefined : gameTimes[selectedGame.id]) ??
    slotTimes[slotIndex] ??
    "00:00";
  const adjustingAssignment = assignments.find((assignment) => assignment.id === adjustingGameId);
  const adjustingGame = games.find((game) => game.id === adjustingGameId);
  const currentSlotConflictCount = assignments.filter((assignment) =>
    conflictGameIds.has(assignment.id),
  ).length;

  const selectSlot = (nextSlotIndex: number) => {
    setSlotIndex(nextSlotIndex);
    setSelectedAssignmentId(null);
  };

  return (
    <>
      <section className="mb-4">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <p className="text-xs font-bold tracking-wider text-slate-500 uppercase">Game Slots</p>
            <p className="text-xs text-slate-500">{day} · 48 games</p>
          </div>
          <span className="rounded-full bg-amber-100 px-2 py-1 text-[10px] font-bold text-amber-800">
            Next: Slot 4
          </span>
        </div>
        <div className="grid grid-cols-8 gap-1">
          {slotTimes.map((time, index) => (
            <button
              key={time}
              aria-label={`Slot ${index + 1}, ${time}`}
              className={cn(
                "relative min-h-12 rounded-lg border bg-white text-xs font-bold",
                index === slotIndex && "border-emerald-700 bg-emerald-950 text-white",
              )}
              onClick={() => selectSlot(index)}
            >
              {index + 1}
              <span
                className={cn(
                  "absolute right-1 bottom-1 left-1 h-1 rounded-full",
                  index < 2 && "bg-slate-300",
                  index === 2 && "bg-emerald-500",
                  index === 3 && "bg-amber-500",
                  index > 3 && "bg-slate-200",
                )}
              />
            </button>
          ))}
        </div>
      </section>

      <section className="mb-3 flex items-end justify-between">
        <div>
          <p className="text-xs font-bold tracking-wider text-slate-500 uppercase">
            Slot {slotIndex + 1} · {slotTimes[slotIndex]}
          </p>
          <h2 className="text-lg font-semibold">Set teams across 6 pitches</h2>
        </div>
        <div className="flex items-center gap-2">
          <p className="text-right text-[10px] text-slate-500">
            {readyCount} resolved
            <br />
            {waitingCount} waiting
          </p>
          <Button
            aria-label={`Adjust Slot ${slotIndex + 1} time`}
            size="sm"
            variant="outline"
            onClick={() => {
              setSelectedAssignmentId(null);
              setAdjustingGameId(null);
              setAdjustingSlotTime(true);
            }}
          >
            <CalendarClock /> Move slot
          </Button>
        </div>
      </section>

      {!focusSlot ? (
        <div className="mb-3 flex gap-2 rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
          <Clock3 className="size-4 shrink-0" />
          Slot 4 is the detailed bracket-dependent setup example in this prototype.
        </div>
      ) : null}

      {currentSlotConflictCount > 0 ? (
        <div className="mb-3 flex gap-2 rounded-xl border border-red-300 bg-red-50 p-3 text-xs font-semibold text-red-900">
          <CircleAlert className="size-4 shrink-0" />
          Schedule Conflict: {currentSlotConflictCount} games share a Pitch in this Game Slot.
        </div>
      ) : null}

      <div className="space-y-2.5 pb-40">
        {assignments.map((assignment) => {
          const operationalGame = games.find((game) => game.id === assignment.id);
          const displayPitch = operationalGame?.pitch ?? assignment.pitch;
          const displayTime = gameTimes[assignment.id] ?? slotTimes[slotIndex] ?? "00:00";
          const shifted = displayTime !== slotTimes[slotIndex];
          const conflict = conflictGameIds.has(assignment.id);
          const resolved = isResolved(assignment);
          const confirmed = confirmedAssignments.has(assignment.id);
          const selected = selectedAssignment?.id === assignment.id;
          return (
            <button
              key={assignment.id}
              className={cn(
                "w-full rounded-xl border bg-white p-3 text-left shadow-sm",
                selected && "border-emerald-500 ring-2 ring-emerald-100",
                conflict && "border-red-400 bg-red-50 ring-2 ring-red-100",
              )}
              onClick={() => {
                setAdjustingGameId(null);
                setSelectedAssignmentId(assignment.id);
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-xs font-bold">
                  <MapPin className="size-3" /> {displayPitch}
                </p>
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold tabular-nums",
                      shifted && "bg-blue-100 text-blue-800",
                    )}
                  >
                    {displayTime}
                  </span>
                  <AssignmentStatus resolved={resolved} confirmed={confirmed} />
                </div>
              </div>
              <p className="mt-1 text-[11px] font-semibold text-slate-500">{assignment.bracket}</p>
              <p className="mt-1 truncate text-sm font-semibold">
                {assignment.home ?? assignment.homeSource}
                <span className="font-normal text-slate-400"> vs </span>
                {assignment.away ?? assignment.awaySource}
              </p>
              {conflict ? (
                <p className="mt-2 flex items-center gap-1 text-[10px] font-bold text-red-700">
                  <CircleAlert className="size-3" /> Schedule Conflict on {displayPitch}
                </p>
              ) : null}
            </button>
          );
        })}
      </div>

      {selectedAssignment !== undefined ? (
        <section className="fixed bottom-16 left-1/2 z-20 w-[calc(100%-2rem)] max-w-[26rem] -translate-x-1/2 rounded-2xl border border-emerald-700 bg-emerald-950 p-3 text-white shadow-2xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold tracking-wider text-emerald-300 uppercase">
                Set teams · {selectedPitch} · {selectedTime}
              </p>
              <p className="mt-0.5 text-sm font-semibold">{selectedAssignment.bracket}</p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                aria-label="Close team setup"
                className="text-white hover:bg-white/10 hover:text-white"
                size="icon-sm"
                variant="ghost"
                onClick={() => setSelectedAssignmentId(null)}
              >
                <X />
              </Button>
            </div>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              className="flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-white/10 text-xs font-semibold"
              onClick={() => {
                setAdjustingSlotTime(false);
                setAdjustingGameId(selectedAssignment.id);
              }}
            >
              <CalendarClock className="size-3.5" /> Adjust game time
            </button>
            <button
              className="flex min-h-9 items-center justify-center gap-1 text-xs font-semibold text-emerald-200"
              onClick={() => onOpenPitch(selectedPitch)}
            >
              Open {selectedPitch.replace("Pitch ", "P")} <ChevronRight className="size-3" />
            </button>
          </div>
          {conflictGameIds.has(selectedAssignment.id) ? (
            <div className="mt-2 flex items-center gap-2 rounded-lg bg-red-500/20 px-3 py-2 text-[11px] text-red-100">
              <CircleAlert className="size-3.5 shrink-0" /> Another game uses {selectedPitch} in
              this Game Slot.
            </div>
          ) : null}
          <AssignmentSource
            label="First side"
            source={selectedAssignment.homeSource}
            team={selectedAssignment.home}
          />
          <AssignmentSource
            label="Second side"
            source={selectedAssignment.awaySource}
            team={selectedAssignment.away}
          />
          {isResolved(selectedAssignment) ? (
            <Button
              className="mt-2 w-full bg-white text-emerald-950 hover:bg-emerald-50"
              onClick={() =>
                setConfirmedAssignments((current) => new Set(current).add(selectedAssignment.id))
              }
            >
              {confirmedAssignments.has(selectedAssignment.id) ? <Check /> : null}
              {confirmedAssignments.has(selectedAssignment.id)
                ? "Teams set"
                : "Confirm teams for this game"}
            </Button>
          ) : (
            <Button className="mt-2 w-full" disabled variant="secondary">
              <CircleAlert /> Waiting for earlier results
            </Button>
          )}
        </section>
      ) : null}

      {adjustingSlotTime ? (
        <ScheduleShiftPanel
          targetKind="Game Slot"
          targetName={`Slot ${slotIndex + 1} · 6 concurrent games`}
          currentTime={slotTimes[slotIndex] ?? "00:00"}
          cascadeLabel="Also move later Game Slots"
          cascadeDetail={`${Math.max(0, slotTimes.length - slotIndex - 1)} later slots will move with the same spacing`}
          onApply={(minutes, cascade) => {
            onShiftSlot(slotIndex, minutes, cascade);
            setAdjustingSlotTime(false);
          }}
          onClose={() => setAdjustingSlotTime(false)}
        />
      ) : null}
      {adjustingGameId !== null &&
      adjustingAssignment !== undefined &&
      adjustingGame !== undefined ? (
        <ScheduleShiftPanel
          targetKind="Event Game"
          targetName={`${adjustingGame.pitch} · ${adjustingAssignment.home ?? adjustingAssignment.homeSource} vs ${adjustingAssignment.away ?? adjustingAssignment.awaySource}`}
          currentTime={gameTimes[adjustingGame.id] ?? slotTimes[slotIndex] ?? "00:00"}
          cascadeLabel={`Also move later games on ${adjustingGame.pitch}`}
          cascadeDetail={`${countLaterGames(games, adjustingGame)} later games will move with the same spacing`}
          onApply={(minutes, cascade) => {
            onShiftGame(adjustingGame.id, minutes, cascade);
            setAdjustingGameId(null);
          }}
          onClose={() => setAdjustingGameId(null)}
        />
      ) : null}
    </>
  );
}

function AssignmentSource({
  label,
  source,
  team,
}: {
  label: string;
  source: string;
  team: string | null;
}) {
  return (
    <div className="mt-2 rounded-lg border border-white/15 bg-white/10 px-3 py-2">
      <p className="text-[10px] font-bold text-white/50 uppercase">{label}</p>
      <p className="truncate text-xs text-emerald-200">{source}</p>
      <p className="truncate text-sm font-semibold">{team ?? "Result not known yet"}</p>
    </div>
  );
}

function AssignmentStatus({ resolved, confirmed }: { resolved: boolean; confirmed: boolean }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[10px] font-bold",
        confirmed && "bg-emerald-100 text-emerald-800",
        resolved && !confirmed && "bg-blue-100 text-blue-800",
        !resolved && "bg-amber-100 text-amber-800",
      )}
    >
      {confirmed ? "Teams set" : resolved ? "Ready to set" : "Waiting for result"}
    </span>
  );
}

function isResolved(assignment: SlotAssignment) {
  return assignment.home !== null && assignment.away !== null;
}

function createPreviewAssignments(slotIndex: number): SlotAssignment[] {
  return Array.from({ length: 6 }, (_, pitchIndex) => ({
    id: `pitch-${pitchIndex + 1}-slot-${slotIndex + 1}`,
    pitch: `Pitch ${pitchIndex + 1}`,
    bracket: slotIndex < 3 ? "Scheduled group game" : "Later bracket game",
    home: slotIndex < 3 ? `Team ${pitchIndex * 2 + 1}` : null,
    away: slotIndex < 3 ? `Team ${pitchIndex * 2 + 2}` : null,
    homeSource: slotIndex < 3 ? "Scheduled team" : "Earlier game result",
    awaySource: slotIndex < 3 ? "Scheduled team" : "Earlier game result",
  }));
}

function countLaterGames(games: SlotOperationalGame[], selectedGame: SlotOperationalGame) {
  return games.filter((game) => game.pitch === selectedGame.pitch && game.time > selectedGame.time)
    .length;
}
