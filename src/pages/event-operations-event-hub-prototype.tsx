// PROTOTYPE — Event Admin event-day selection and setup hub.
import { CalendarDays, ChevronRight, CircleAlert, KeyRound, MapPin, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type GameDayName = "Saturday" | "Sunday";

const HUB_LINKS: {
  label: string;
  detail: string;
  Icon: LucideIcon;
  target?: "operations";
}[] = [
  {
    label: "Schedule & live operations",
    detail: "48 games today · 6 currently live",
    Icon: CalendarDays,
    target: "operations",
  },
  { label: "Teams", detail: "24 registered teams", Icon: Users },
  { label: "Pitches", detail: "6 pitches configured", Icon: MapPin },
  { label: "Access grants", detail: "Event Admin + 6 Pitch Manager grants", Icon: KeyRound },
];

export function EventHub({
  day,
  setDay,
  onOpenOperations,
}: {
  day: GameDayName;
  setDay: (day: GameDayName) => void;
  onOpenOperations: () => void;
}) {
  return (
    <main className="space-y-4 p-4">
      <section>
        <h2 className="mb-2 text-xs font-bold tracking-wider text-slate-500 uppercase">
          Event days
        </h2>
        <div className="grid grid-cols-2 rounded-2xl bg-slate-200 p-1">
          {(["Saturday", "Sunday"] as const).map((dayName, index) => (
            <button
              key={dayName}
              aria-pressed={day === dayName}
              className={cn(
                "rounded-xl px-3 py-2.5 text-left",
                day === dayName ? "bg-white shadow-sm" : "text-slate-600",
              )}
              onClick={() => setDay(dayName)}
            >
              <span className="block text-xs font-bold">{dayName}</span>
              <span className="block text-[10px]">Day {index + 1} · 48 games</span>
            </button>
          ))}
        </div>
      </section>
      <button
        className={cn(
          "flex w-full items-center gap-3 rounded-2xl border p-4 text-left",
          day === "Saturday" ? "border-amber-300 bg-amber-50" : "border-emerald-300 bg-emerald-50",
        )}
        onClick={onOpenOperations}
      >
        <span
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-full",
            day === "Saturday" ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800",
          )}
        >
          {day === "Saturday" ? (
            <CircleAlert className="size-5" />
          ) : (
            <CalendarDays className="size-5" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block text-sm font-semibold",
              day === "Saturday" ? "text-amber-950" : "text-emerald-950",
            )}
          >
            {day === "Saturday" ? "Slot 4 needs team setup" : "Sunday schedule ready"}
          </span>
          <span
            className={cn(
              "block text-xs",
              day === "Saturday" ? "text-amber-800" : "text-emerald-800",
            )}
          >
            {day === "Saturday"
              ? "4 assignments ready · 2 waiting for quarterfinals"
              : "8 Game Slots · 6 Pitches · 48 Event Games"}
          </span>
        </span>
        <ChevronRight
          className={cn("size-4", day === "Saturday" ? "text-amber-700" : "text-emerald-700")}
        />
      </button>

      <section>
        <h2 className="mb-2 text-xs font-bold tracking-wider text-slate-500 uppercase">
          Event setup
        </h2>
        <div className="rounded-2xl border bg-white p-1 shadow-sm">
          {HUB_LINKS.map(({ label, detail, Icon, target }) => (
            <button
              key={label}
              className="flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-slate-50"
              onClick={target === "operations" ? onOpenOperations : undefined}
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-slate-100">
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">{label}</span>
                <span className="block truncate text-xs text-slate-500">
                  {target === "operations" ? `${day} · 48 games · 6 currently live` : detail}
                </span>
              </span>
              <ChevronRight className="size-4 text-slate-400" />
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}
