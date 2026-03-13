import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  buildScoreDownButtonStyle,
  buildScoreUpButtonStyle,
  buildScoreValueStyle,
} from "@/lib/score-color-theme";
import { normalizeTeamColor } from "@/lib/team-colors";
import "../index.css";

export function ColorTestPage() {
  const colors = buildColorPalette();

  return (
    <div className="min-h-screen bg-slate-100 p-4 text-slate-900">
      <div className="mx-auto max-w-7xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Score Button Color Test</h1>
            <p className="text-sm text-slate-600">100 colors using the same up/down style logic.</p>
          </div>
          <Button variant="outline" onClick={() => navigateTo("/")}>
            Back
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {colors.map((color, index) => (
            <section
              key={`${color}-${index}`}
              data-color-preview="true"
              className="rounded-xl border border-slate-300 bg-white p-2 shadow-sm"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span
                  className="h-5 w-5 rounded border border-slate-300"
                  style={{ backgroundColor: color }}
                />
                <span className="truncate text-[11px] font-mono text-slate-700">
                  {normalizeTeamColor(color, "#0ea5e9")}
                </span>
              </div>

              <Button
                size="sm"
                className="mb-1 h-8 w-full rounded-2xl border shadow-sm"
                style={buildScoreUpButtonStyle(color)}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>

              <div
                className="mb-1 w-full rounded-2xl border bg-white px-2 py-1 text-center"
                style={buildScoreValueStyle(color)}
              >
                <p className="text-2xl leading-none font-semibold tabular-nums text-slate-900">
                  20
                </p>
              </div>

              <Button
                size="sm"
                variant="outline"
                className="h-8 w-full rounded-2xl bg-white"
                style={buildScoreDownButtonStyle(color)}
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function buildColorPalette() {
  const seeded: string[] = [
    "#0ea5e9",
    "#f97316",
    "#22c55e",
    "#000000",
    "#ffffff",
    "#fde047",
    "#ef4444",
    "#8b5cf6",
    "#06b6d4",
    "#64748b",
  ];

  const generated: string[] = [];
  for (let index = 0; index < 90; index += 1) {
    const hue = Math.round((index * 137.508) % 360);
    const saturation = 52 + ((index * 13) % 40);
    const lightness = 30 + ((index * 7) % 46);
    generated.push(hslToHex(hue, saturation, lightness));
  }

  return [...seeded, ...generated];
}

function hslToHex(h: number, s: number, l: number) {
  const hue = h / 360;
  const saturation = s / 100;
  const lightness = l / 100;

  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((hue * 6) % 2) - 1));
  const m = lightness - c / 2;

  let r = 0;
  let g = 0;
  let b = 0;

  if (hue < 1 / 6) {
    r = c;
    g = x;
  } else if (hue < 2 / 6) {
    r = x;
    g = c;
  } else if (hue < 3 / 6) {
    g = c;
    b = x;
  } else if (hue < 4 / 6) {
    g = x;
    b = c;
  } else if (hue < 5 / 6) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  const toHex = (value: number) =>
    Math.round((value + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function navigateTo(path: string) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
