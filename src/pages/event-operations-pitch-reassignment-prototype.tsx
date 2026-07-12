// PROTOTYPE — Low-frequency Event Admin pitch reassignment control.
import { ArrowRight, CircleAlert, Clock3, MapPin, RadioTower, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PitchReassignmentMode = "move" | "swap";

export type PitchReassignmentOption = {
  pitch: string;
  isLivestream: boolean;
  occupant: null | {
    home: string;
    away: string;
    currentTime: string;
  };
};

export function PitchReassignmentPanel({
  currentPitch,
  gameName,
  currentTime,
  slotNumber,
  options,
  onApply,
  onClose,
}: {
  currentPitch: string;
  gameName: string;
  currentTime: string;
  slotNumber: number;
  options: PitchReassignmentOption[];
  onApply: (targetPitch: string, mode: PitchReassignmentMode) => void;
  onClose: () => void;
}) {
  const firstTarget = options.find((option) => option.pitch === "Pitch 1") ?? options[0];
  const [targetPitch, setTargetPitch] = useState(firstTarget?.pitch ?? currentPitch);
  const [mode, setMode] = useState<PitchReassignmentMode>("swap");
  const target = options.find((option) => option.pitch === targetPitch);
  const occupied = target?.occupant !== null && target?.occupant !== undefined;
  const effectiveMode: PitchReassignmentMode = occupied ? mode : "move";
  const createsConflict = occupied && effectiveMode === "move";

  return (
    <section className="fixed bottom-16 left-1/2 z-30 max-h-[calc(100vh-5rem)] w-[calc(100%-2rem)] max-w-[26rem] -translate-x-1/2 overflow-y-auto rounded-2xl border border-slate-700 bg-slate-950 p-4 text-white shadow-2xl">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-bold tracking-wider text-slate-400 uppercase">
            Pitch Reassignment · Slot {slotNumber}
          </p>
          <h3 className="mt-0.5 truncate text-sm font-semibold">{gameName}</h3>
        </div>
        <Button
          aria-label="Close pitch reassignment"
          className="text-white hover:bg-white/10 hover:text-white"
          size="icon-sm"
          variant="ghost"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        {options.map((option) => {
          const selected = option.pitch === targetPitch;
          return (
            <button
              key={option.pitch}
              aria-pressed={selected}
              className={cn(
                "min-h-12 rounded-xl border px-2 py-1.5 text-center",
                selected
                  ? "border-white bg-white text-slate-950"
                  : "border-white/15 bg-white/5 text-white",
              )}
              onClick={() => setTargetPitch(option.pitch)}
            >
              <span className="block text-xs font-bold">{shortPitch(option.pitch)}</span>
              <span
                className={cn(
                  "mt-0.5 block text-[9px]",
                  selected ? "text-slate-600" : "text-slate-400",
                )}
              >
                {option.isLivestream
                  ? "Livestream"
                  : option.occupant === null
                    ? "Available"
                    : "Occupied"}
              </span>
            </button>
          );
        })}
      </div>

      {occupied ? (
        <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-white/5 p-1">
          <button
            aria-pressed={effectiveMode === "swap"}
            className={cn(
              "rounded-lg px-2 py-2 text-left",
              effectiveMode === "swap" ? "bg-white text-slate-950" : "text-slate-300",
            )}
            onClick={() => setMode("swap")}
          >
            <span className="block text-xs font-bold">Swap games</span>
            <span className="block text-[9px] opacity-70">Keeps one game per pitch</span>
          </button>
          <button
            aria-pressed={effectiveMode === "move"}
            className={cn(
              "rounded-lg px-2 py-2 text-left",
              effectiveMode === "move" ? "bg-amber-400 text-amber-950" : "text-slate-300",
            )}
            onClick={() => setMode("move")}
          >
            <span className="block text-xs font-bold">Move only</span>
            <span className="block text-[9px] opacity-70">Resolve the conflict later</span>
          </button>
        </div>
      ) : null}

      <div className="mt-3 space-y-2">
        <GameMoveRow
          label="Selected game"
          gameName={gameName}
          beforePitch={currentPitch}
          afterPitch={targetPitch}
          beforeTime={currentTime}
          afterTime={currentTime}
          livestream={target?.isLivestream === true}
        />
        {target?.occupant !== null && target?.occupant !== undefined ? (
          <GameMoveRow
            label="Game already there"
            gameName={`${target.occupant.home} vs ${target.occupant.away}`}
            beforePitch={targetPitch}
            afterPitch={effectiveMode === "swap" ? currentPitch : targetPitch}
            beforeTime={target.occupant.currentTime}
            afterTime={target.occupant.currentTime}
          />
        ) : null}
      </div>

      <div
        className={cn(
          "mt-3 flex items-center gap-2 rounded-xl border px-3 py-2 text-[11px]",
          createsConflict
            ? "border-red-400/60 bg-red-500/15 text-red-100"
            : "border-emerald-400/30 bg-emerald-500/10 text-emerald-100",
        )}
      >
        {createsConflict ? (
          <CircleAlert className="size-4 shrink-0" />
        ) : (
          <Clock3 className="size-4 shrink-0" />
        )}
        {createsConflict
          ? `Creates a Schedule Conflict: two games on ${targetPitch} in Slot ${slotNumber}.`
          : "Start times stay unchanged for both Event Games."}
      </div>

      <Button
        className={cn(
          "mt-3 w-full",
          createsConflict
            ? "bg-amber-400 text-amber-950 hover:bg-amber-300"
            : "bg-white text-slate-950 hover:bg-slate-100",
        )}
        onClick={() => onApply(targetPitch, effectiveMode)}
      >
        {createsConflict
          ? `Move to ${targetPitch} anyway`
          : effectiveMode === "swap"
            ? `Swap games between ${shortPitch(currentPitch)} and ${shortPitch(targetPitch)}`
            : `Move game to ${targetPitch}`}
      </Button>
    </section>
  );
}

function GameMoveRow({
  label,
  gameName,
  beforePitch,
  afterPitch,
  beforeTime,
  afterTime,
  livestream = false,
}: {
  label: string;
  gameName: string;
  beforePitch: string;
  afterPitch: string;
  beforeTime: string;
  afterTime: string;
  livestream?: boolean;
}) {
  return (
    <div className="rounded-xl border border-white/15 bg-white/10 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[9px] font-bold tracking-wider text-slate-400 uppercase">{label}</p>
          <p className="truncate text-xs font-semibold">{gameName}</p>
        </div>
        {livestream ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-red-500/20 px-2 py-0.5 text-[9px] text-red-200">
            <RadioTower className="size-3" /> Live
          </span>
        ) : null}
      </div>
      <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-[11px]">
        <GamePosition pitch={beforePitch} time={beforeTime} />
        <ArrowRight className="size-3.5 text-slate-500" />
        <GamePosition pitch={afterPitch} time={afterTime} alignRight />
      </div>
    </div>
  );
}

function GamePosition({
  pitch,
  time,
  alignRight = false,
}: {
  pitch: string;
  time: string;
  alignRight?: boolean;
}) {
  return (
    <div className={cn("space-y-0.5", alignRight && "text-right")}>
      <p className={cn("flex items-center gap-1 font-bold", alignRight && "justify-end")}>
        <MapPin className="size-3" /> {shortPitch(pitch)}
      </p>
      <p
        className={cn(
          "flex items-center gap-1 text-slate-300 tabular-nums",
          alignRight && "justify-end",
        )}
      >
        <Clock3 className="size-3" /> {time}
      </p>
    </div>
  );
}

function shortPitch(pitch: string) {
  return pitch.replace("Pitch ", "P");
}
