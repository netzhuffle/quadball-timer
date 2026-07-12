// PROTOTYPE — Low-frequency Event Admin schedule adjustment control.
import { Check, Clock3, Minus, Plus, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const SHIFT_OPTIONS = [-10, -5, 5, 10];

export function ScheduleShiftPanel({
  targetKind,
  targetName,
  currentTime,
  cascadeLabel,
  cascadeDetail,
  onApply,
  onClose,
}: {
  targetKind: "Game Slot" | "Event Game";
  targetName: string;
  currentTime: string;
  cascadeLabel: string;
  cascadeDetail: string;
  onApply: (minutes: number, cascade: boolean) => void;
  onClose: () => void;
}) {
  const [minutes, setMinutes] = useState(10);
  const [cascade, setCascade] = useState(false);
  const newTime = shiftClockTime(currentTime, minutes);

  return (
    <section className="fixed bottom-16 left-1/2 z-30 w-[calc(100%-2rem)] max-w-[26rem] -translate-x-1/2 rounded-2xl border border-slate-700 bg-slate-950 p-4 text-white shadow-2xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold tracking-wider text-slate-400 uppercase">
            Schedule Shift · {targetKind}
          </p>
          <h3 className="mt-0.5 text-sm font-semibold">{targetName}</h3>
        </div>
        <Button
          aria-label="Close schedule shift"
          className="text-white hover:bg-white/10 hover:text-white"
          size="icon-sm"
          variant="ghost"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>

      <div className="mt-3 flex items-center justify-between rounded-xl border border-white/15 bg-white/10 p-3">
        <div>
          <p className="text-[10px] font-bold text-white/50 uppercase">Current</p>
          <p className="text-lg font-bold tabular-nums">{currentTime}</p>
        </div>
        <Clock3 className="size-4 text-slate-400" />
        <div className="text-right">
          <p className="text-[10px] font-bold text-white/50 uppercase">New time</p>
          <p className="text-lg font-bold text-emerald-300 tabular-nums">{newTime}</p>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-2">
        {SHIFT_OPTIONS.map((option) => (
          <button
            key={option}
            aria-label={`Move ${Math.abs(option)} minutes ${option < 0 ? "earlier" : "later"}`}
            className={cn(
              "flex min-h-10 items-center justify-center gap-1 rounded-lg border border-white/15 text-xs font-bold",
              option === minutes ? "bg-white text-slate-950" : "bg-white/5 text-white",
            )}
            onClick={() => setMinutes(option)}
          >
            {option < 0 ? <Minus className="size-3" /> : <Plus className="size-3" />}
            {Math.abs(option)} min
          </button>
        ))}
      </div>

      <button
        aria-pressed={cascade}
        className="mt-3 flex w-full items-center gap-3 rounded-xl border border-white/15 bg-white/5 p-3 text-left"
        onClick={() => setCascade((current) => !current)}
      >
        <span
          className={cn(
            "grid size-5 shrink-0 place-items-center rounded border",
            cascade ? "border-emerald-400 bg-emerald-500 text-white" : "border-white/30",
          )}
        >
          {cascade ? <Check className="size-3.5" /> : null}
        </span>
        <span>
          <span className="block text-xs font-semibold">{cascadeLabel}</span>
          <span className="block text-[10px] text-slate-400">{cascadeDetail}</span>
        </span>
      </button>

      <Button
        className="mt-3 w-full bg-white text-slate-950 hover:bg-slate-100"
        onClick={() => onApply(minutes, cascade)}
      >
        Move to {newTime}
      </Button>
    </section>
  );
}

export function shiftClockTime(time: string, minutes: number) {
  const [hoursText = "0", minutesText = "0"] = time.split(":");
  const totalMinutes = Number(hoursText) * 60 + Number(minutesText) + minutes;
  const wrappedMinutes = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const hours = Math.floor(wrappedMinutes / 60);
  const remainingMinutes = wrappedMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(remainingMinutes).padStart(2, "0")}`;
}
