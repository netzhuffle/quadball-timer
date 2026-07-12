// PROTOTYPE — Event Admin switch between slot-first and pitch-first operations.
import { cn } from "@/lib/utils";

type OperationsLens = "slot" | "pitch";

export function OperationsLensSwitch({
  lens,
  setLens,
}: {
  lens: OperationsLens;
  setLens: (lens: OperationsLens) => void;
}) {
  return (
    <div className="mb-4 grid grid-cols-2 rounded-xl bg-slate-200 p-1">
      <button
        className={cn(
          "min-h-10 rounded-lg px-3 text-xs font-semibold",
          lens === "slot" ? "bg-white shadow-sm" : "text-slate-600",
        )}
        onClick={() => setLens("slot")}
      >
        Slot setup
      </button>
      <button
        className={cn(
          "min-h-10 rounded-lg px-3 text-xs font-semibold",
          lens === "pitch" ? "bg-white shadow-sm" : "text-slate-600",
        )}
        onClick={() => setLens("pitch")}
      >
        Pitch view
      </button>
    </div>
  );
}
