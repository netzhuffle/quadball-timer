import { describe, expect, test } from "bun:test";
import {
  DEFAULT_AWAY_TEAM_COLOR,
  DEFAULT_HOME_TEAM_COLOR,
  getReadableTextColor,
  hexToOklch,
  mixHexColors,
  normalizeTeamColor,
  oklchToHex,
  parseHexColor,
  shiftOklch,
  withColorAlpha,
} from "@/lib/team-colors";

describe("team-colors", () => {
  test("normalizes valid hex colors and falls back for invalid values", () => {
    expect(normalizeTeamColor("#ABCDEF", DEFAULT_HOME_TEAM_COLOR)).toBe("#abcdef");
    expect(normalizeTeamColor("f97316", DEFAULT_HOME_TEAM_COLOR)).toBe("#f97316");
    expect(normalizeTeamColor("bad", DEFAULT_AWAY_TEAM_COLOR)).toBe(DEFAULT_AWAY_TEAM_COLOR);
  });

  test("parses normalized hex color channels", () => {
    expect(parseHexColor("#0ea5e9")).toEqual({ r: 14, g: 165, b: 233 });
    expect(parseHexColor("nope")).toBeNull();
  });

  test("mixes colors and clamps mix ratio", () => {
    expect(mixHexColors("#ff0000", "#0000ff", 0.5)).toBe("#800080");
    expect(mixHexColors("#ffffff", "#000000", 1.4)).toBe("#ffffff");
    expect(mixHexColors("#ffffff", "#000000", -0.2)).toBe("#000000");
  });

  test("returns readable text color for dark and light backgrounds", () => {
    expect(getReadableTextColor("#0f172a")).toBe("#ffffff");
    expect(getReadableTextColor("#e2e8f0")).toBe("#0f172a");
  });

  test("builds rgba color strings", () => {
    expect(withColorAlpha("#0ea5e9", 0.25)).toBe("rgba(14,165,233,0.25)");
    expect(withColorAlpha("bad", 1.5)).toBe("rgba(15,23,42,1)");
  });

  test("round-trips default team colors through OKLCH conversion", () => {
    const homeOklch = hexToOklch(DEFAULT_HOME_TEAM_COLOR);
    const awayOklch = hexToOklch(DEFAULT_AWAY_TEAM_COLOR);
    if (homeOklch === null || awayOklch === null) {
      throw new Error("Expected default team colors to parse as OKLCH");
    }

    expect(oklchToHex(homeOklch)).toBe(DEFAULT_HOME_TEAM_COLOR);
    expect(oklchToHex(awayOklch)).toBe(DEFAULT_AWAY_TEAM_COLOR);
  });

  test("preserves calibrated OKLCH shifts for score-theme palette colors", () => {
    const homeOklch = hexToOklch(DEFAULT_HOME_TEAM_COLOR);
    if (homeOklch === null) {
      throw new Error("Expected home color to parse as OKLCH");
    }

    expect(
      oklchToHex(
        shiftOklch(homeOklch, {
          dl: 0.216312767,
          dc: -0.089868614,
          dh: -6.420517928,
        }),
      ),
    ).toBe("#b8e6fe");
  });
});
