import { ArrowLeft, ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export type PrototypeVariant = "A" | "B" | "C";

const VARIANTS: PrototypeVariant[] = ["A", "B", "C"];

const VARIANT_NAMES: Record<PrototypeVariant, string> = {
  A: "Run sheet",
  B: "Now + next",
  C: "Pitch board",
};

function readVariant(): PrototypeVariant {
  const variant = new URLSearchParams(window.location.search).get("variant");
  return variant === "B" || variant === "C" ? variant : "A";
}

export function usePrototypeVariant() {
  const [variant, setVariant] = useState<PrototypeVariant>(readVariant);

  const selectVariant = (nextVariant: PrototypeVariant) => {
    const searchParams = new URLSearchParams(window.location.search);
    searchParams.set("variant", nextVariant);
    window.history.replaceState(null, "", `${window.location.pathname}?${searchParams}`);
    setVariant(nextVariant);
  };

  useEffect(() => {
    const cycle = (direction: -1 | 1) => {
      setVariant((current) => {
        const currentIndex = VARIANTS.indexOf(current);
        const nextIndex = (currentIndex + direction + VARIANTS.length) % VARIANTS.length;
        const nextVariant = VARIANTS[nextIndex] ?? "A";
        const searchParams = new URLSearchParams(window.location.search);
        searchParams.set("variant", nextVariant);
        window.history.replaceState(null, "", `${window.location.pathname}?${searchParams}`);
        return nextVariant;
      });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      if (event.key === "ArrowLeft") {
        cycle(-1);
      } else if (event.key === "ArrowRight") {
        cycle(1);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return { variant, selectVariant };
}

export function PrototypeSwitcher({
  variant,
  onChange,
}: {
  variant: PrototypeVariant;
  onChange: (variant: PrototypeVariant) => void;
}) {
  if (!import.meta.hot) {
    return null;
  }

  const currentIndex = VARIANTS.indexOf(variant);
  const previous = VARIANTS[(currentIndex - 1 + VARIANTS.length) % VARIANTS.length] ?? "A";
  const next = VARIANTS[(currentIndex + 1) % VARIANTS.length] ?? "A";

  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full border border-slate-700 bg-slate-950 p-1 text-white shadow-2xl">
      <Button
        aria-label="Previous prototype variant"
        className="rounded-full text-white hover:bg-white/15 hover:text-white"
        size="icon-sm"
        variant="ghost"
        onClick={() => onChange(previous)}
      >
        <ArrowLeft />
      </Button>
      <p className="min-w-32 px-2 text-center text-xs font-semibold tracking-wide">
        {variant} — {VARIANT_NAMES[variant]}
      </p>
      <Button
        aria-label="Next prototype variant"
        className="rounded-full text-white hover:bg-white/15 hover:text-white"
        size="icon-sm"
        variant="ghost"
        onClick={() => onChange(next)}
      >
        <ArrowRight />
      </Button>
    </div>
  );
}
