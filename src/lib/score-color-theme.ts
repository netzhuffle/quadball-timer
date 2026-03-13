import type { CSSProperties } from "react";
import {
  DEFAULT_HOME_TEAM_COLOR,
  getReadableTextColor,
  hexToOklch,
  mixHexColors,
  normalizeTeamColor,
  oklchToCss,
  oklchToHex,
  parseHexColor,
  shiftOklch,
} from "@/lib/team-colors";

export type ActionPanelTabKind = "card" | "timeout" | "game";
type ColorFamily = "neutral" | "cool" | "warm" | "green" | "yellow";

type ColorShift = {
  dl: number;
  dc: number;
  dh: number;
};

type ColorProfile = {
  upLead: ColorShift;
  upBorder: ColorShift;
  upTrail: ColorShift;
  downBorder: ColorShift;
  downText: ColorShift;
  header: ColorShift;
  panelTop: ColorShift;
  tabCardTrail: ColorShift;
  tabTimeoutTrail: ColorShift;
  tabCardGlow: ColorShift;
  tabTimeoutGlow: ColorShift;
  scoreGlowAlpha: number;
  tintStartAlpha: number;
  tintMidAlpha: number;
  topToneAlpha: number;
  chipBackgroundAlpha: number;
};

const COOL_PROFILE: ColorProfile = {
  upLead: { dl: 0.000312767, dc: 0.021131386, dh: 0.000482072 },
  upBorder: { dl: 0.143312767, dc: -0.036868614, dh: -7.004517928 },
  upTrail: { dl: 0.030312767, dc: -0.004868614, dh: -22.101517928 },
  downBorder: { dl: 0.216312767, dc: -0.089868614, dh: -6.420517928 },
  downText: { dl: -0.184687233, dc: -0.013868614, dh: 5.426482072 },
  header: { dl: -0.241687233, dc: -0.037868614, dh: 3.467482072 },
  panelTop: { dl: 0.292312767, dc: -0.134868614, dh: -0.702517928 },
  tabCardTrail: { dl: -0.096687233, dc: 0.010131386, dh: 4.643482072 },
  tabTimeoutTrail: { dl: 0.058, dc: -0.03, dh: 22 },
  tabCardGlow: { dl: 0.061312767, dc: 0.012131386, dh: -4.661517928 },
  tabTimeoutGlow: { dl: 0.05, dc: -0.02, dh: 10 },
  scoreGlowAlpha: 0.18,
  tintStartAlpha: 0.14,
  tintMidAlpha: 0.05,
  topToneAlpha: 0.9,
  chipBackgroundAlpha: 0.8,
};

const WARM_PROFILE: ColorProfile = {
  upLead: { dl: 0.000128747, dc: 0.026278916, dh: -0.000420862 },
  upBorder: { dl: 0.132128747, dc: -0.058721084, dh: 18.685579138 },
  upTrail: { dl: -0.059871253, dc: 0.059278916, dh: -31.165420862 },
  downBorder: { dl: 0.196128747, dc: -0.110721084, dh: 23.092579138 },
  downText: { dl: -0.151871253, dc: 0.008278916, dh: -9.202420862 },
  header: { dl: -0.234871253, dc: -0.029721084, dh: -10.300420862 },
  panelTop: { dl: 0.275128747, dc: -0.170721084, dh: 26.079579138 },
  tabCardTrail: { dl: -0.1, dc: -0.02, dh: 6 },
  tabTimeoutTrail: { dl: 0.064128747, dc: 0.001278916, dh: 22.475579138 },
  tabCardGlow: { dl: 0.06, dc: -0.01, dh: 0 },
  tabTimeoutGlow: { dl: 0.045128747, dc: -0.003721084, dh: 8.329579138 },
  scoreGlowAlpha: 0.16,
  tintStartAlpha: 0.16,
  tintMidAlpha: 0.05,
  topToneAlpha: 0.88,
  chipBackgroundAlpha: 0.75,
};

const GREEN_PROFILE: ColorProfile = {
  ...COOL_PROFILE,
  upLead: { dl: 0.001, dc: 0.02, dh: 0 },
  upBorder: { dl: 0.14, dc: -0.05, dh: 4 },
  upTrail: { dl: 0.03, dc: -0.02, dh: 16 },
  downBorder: { dl: 0.21, dc: -0.09, dh: 6 },
  downText: { dl: -0.17, dc: -0.02, dh: -4 },
  header: { dl: -0.24, dc: -0.045, dh: -7 },
  panelTop: { dl: 0.275, dc: -0.155, dh: 8 },
  tabCardTrail: { dl: -0.09, dc: -0.01, dh: 14 },
  tabTimeoutTrail: { dl: 0.055, dc: -0.02, dh: 18 },
  tabCardGlow: { dl: 0.07, dc: -0.01, dh: 8 },
  tabTimeoutGlow: { dl: 0.055, dc: -0.025, dh: 8 },
};

const YELLOW_PROFILE: ColorProfile = {
  ...WARM_PROFILE,
  upLead: { dl: 0.001, dc: 0.022, dh: 0 },
  upBorder: { dl: 0.13, dc: -0.06, dh: 12 },
  upTrail: { dl: 0.015, dc: -0.015, dh: -12 },
  downBorder: { dl: 0.2, dc: -0.11, dh: 18 },
  downText: { dl: -0.16, dc: -0.02, dh: -4 },
  header: { dl: -0.23, dc: -0.045, dh: -7 },
  panelTop: { dl: 0.28, dc: -0.16, dh: 18 },
  tabTimeoutTrail: { dl: 0.05, dc: -0.015, dh: 14 },
  tabTimeoutGlow: { dl: 0.055, dc: -0.025, dh: 8 },
};

const GAME_PROFILE = {
  lead: { dl: 0.015163126, dc: 0.195453798, dh: -118.546895753 },
  trail: { dl: -0.038397437, dc: 0.236926392, dh: -172.090080395 },
  glow: { dl: 0.015163126, dc: 0.195453798, dh: -118.546895753 },
};

export function buildScoreUpButtonStyle(teamColor: string): CSSProperties {
  const normalized = normalizeTeamColor(teamColor, DEFAULT_HOME_TEAM_COLOR);
  const family = getColorFamily(normalized);
  if (family === "neutral") {
    if (isDarkTone(normalized)) {
      return {
        borderColor: "rgba(100,116,139,0.58)",
        backgroundImage: "linear-gradient(135deg, #334155, #111827)",
        color: "#ffffff",
        boxShadow: "0 1px 2px rgba(15,23,42,0.2)",
      };
    }

    return {
      borderColor: "rgba(148,163,184,0.58)",
      backgroundImage: "linear-gradient(135deg, #f8fafc, #e2e8f0)",
      color: "#0f172a",
      boxShadow: "0 1px 2px rgba(15,23,42,0.08)",
    };
  }

  const profile = getFamilyProfile(family);
  const lead = shiftColorCss(normalized, profile.upLead);
  const trail = shiftColorCss(normalized, profile.upTrail);
  const border = shiftColorCss(normalized, profile.upBorder);
  const leadHex = shiftColorHex(normalized, profile.upLead);
  const trailHex = shiftColorHex(normalized, profile.upTrail);

  return {
    borderColor: border,
    backgroundImage: `linear-gradient(to bottom right in oklab, ${lead}, ${trail})`,
    color: getReadableTextColor(mixHexColors(leadHex, trailHex, 0.56)),
  };
}

export function buildScoreValueStyle(teamColor: string): CSSProperties {
  const normalized = normalizeTeamColor(teamColor, DEFAULT_HOME_TEAM_COLOR);
  const family = getColorFamily(normalized);
  if (family === "neutral") {
    if (isDarkTone(normalized)) {
      return {
        borderColor: "rgba(100,116,139,0.5)",
        boxShadow: "inset 0 0 10px rgba(30,41,59,0.16)",
      };
    }

    return {
      borderColor: "rgba(148,163,184,0.5)",
      boxShadow: "inset 0 0 10px rgba(148,163,184,0.12)",
    };
  }

  const profile = getFamilyProfile(family);
  return {
    borderColor: shiftColorCss(normalized, profile.downBorder),
    boxShadow: `inset 0 0 12px ${baseColorCss(normalized, profile.scoreGlowAlpha)}`,
  };
}

export function buildScoreDownButtonStyle(teamColor: string): CSSProperties {
  const normalized = normalizeTeamColor(teamColor, DEFAULT_HOME_TEAM_COLOR);
  const family = getColorFamily(normalized);
  if (family === "neutral") {
    if (isDarkTone(normalized)) {
      return {
        borderColor: "rgba(100,116,139,0.5)",
        backgroundColor: "rgba(241,245,249,0.7)",
        color: "#475569",
        boxShadow: "none",
      };
    }

    return {
      borderColor: "rgba(148,163,184,0.5)",
      backgroundColor: "rgba(248,250,252,0.92)",
      color: "#64748b",
      boxShadow: "none",
    };
  }

  const profile = getFamilyProfile(family);
  return {
    borderColor: shiftColorCss(normalized, profile.downBorder),
    backgroundColor: "#ffffff",
    color: shiftColorCss(normalized, profile.downText),
    boxShadow: "none",
  };
}

export function buildPenaltyPanelBorderStyle(teamColor: string): CSSProperties {
  const normalized = normalizeTeamColor(teamColor, DEFAULT_HOME_TEAM_COLOR);
  const family = getColorFamily(normalized);
  if (family === "neutral") {
    return {
      borderColor: "rgba(148,163,184,0.5)",
    };
  }

  const profile = getFamilyProfile(family);
  return {
    borderColor: shiftColorCss(normalized, profile.downBorder),
  };
}

export function buildPenaltyHeaderStyle(teamColor: string): CSSProperties {
  const normalized = normalizeTeamColor(teamColor, DEFAULT_HOME_TEAM_COLOR);
  const family = getColorFamily(normalized);
  if (family === "neutral") {
    return {
      color: "#334155",
    };
  }

  const profile = getFamilyProfile(family);
  return {
    color: shiftColorCss(normalized, profile.header),
  };
}

export function buildPenaltyNeutralChipStyle(teamColor: string): CSSProperties {
  const normalized = normalizeTeamColor(teamColor, DEFAULT_HOME_TEAM_COLOR);
  const family = getColorFamily(normalized);
  if (family === "neutral") {
    return {
      borderColor: "rgba(148,163,184,0.5)",
      backgroundColor: "rgba(248,250,252,0.85)",
      color: "#0f172a",
    };
  }

  const profile = getFamilyProfile(family);
  return {
    borderColor: shiftColorCss(normalized, profile.downBorder),
    backgroundColor: shiftColorCss(normalized, profile.panelTop, profile.chipBackgroundAlpha),
    color: "#0f172a",
  };
}

export function buildPenaltyPanelTintStyle(
  teamColor: string,
  side: "left" | "right",
): CSSProperties {
  const normalized = normalizeTeamColor(teamColor, DEFAULT_HOME_TEAM_COLOR);
  const family = getColorFamily(normalized);
  const anchor = side === "left" ? "12%" : "88%";

  if (family === "neutral") {
    return {
      backgroundImage: `radial-gradient(circle at ${anchor} 18%, rgba(148,163,184,0.14), rgba(148,163,184,0.05) 34%, rgba(255,255,255,0) 68%), linear-gradient(180deg, rgba(248,250,252,0.9), rgba(255,255,255,0.95) 32%, rgba(255,255,255,0.98))`,
    };
  }

  const profile = getFamilyProfile(family);
  const tintStart = baseColorCss(normalized, profile.tintStartAlpha);
  const tintMid = baseColorCss(normalized, profile.tintMidAlpha);
  const topTone = shiftColorCss(normalized, profile.panelTop, profile.topToneAlpha);

  return {
    backgroundImage: `radial-gradient(circle at ${anchor} 18%, ${tintStart}, ${tintMid} 34%, rgba(255,255,255,0) 68%), linear-gradient(180deg, ${topTone}, rgba(255,255,255,0.95) 32%, rgba(255,255,255,0.98))`,
  };
}

export function buildActionPanelTabStyle(
  kind: ActionPanelTabKind,
  primaryColor: string,
  secondaryColor?: string,
): CSSProperties {
  const normalizedPrimary = normalizeTeamColor(primaryColor, DEFAULT_HOME_TEAM_COLOR);
  const normalizedSecondary = normalizeTeamColor(secondaryColor, normalizedPrimary);

  let lead: string;
  let trail: string;
  let glow: string;
  let leadHex: string;
  let trailHex: string;

  if (kind === "game") {
    const blend = mixHexColors(normalizedPrimary, normalizedSecondary, 0.5);
    lead = shiftColorCss(blend, GAME_PROFILE.lead);
    trail = shiftColorCss(blend, GAME_PROFILE.trail);
    glow = shiftColorCss(blend, GAME_PROFILE.glow, 0.55);
    leadHex = shiftColorHex(blend, GAME_PROFILE.lead);
    trailHex = shiftColorHex(blend, GAME_PROFILE.trail);
  } else {
    const family = getColorFamily(normalizedPrimary);
    if (family === "neutral") {
      const neutralLead = isDarkTone(normalizedPrimary) ? "#334155" : "#64748b";
      const neutralTrail = isDarkTone(normalizedPrimary) ? "#1e293b" : "#475569";
      return {
        backgroundImage: `linear-gradient(135deg, ${neutralLead}, ${neutralTrail})`,
        color: "#ffffff",
        boxShadow: "0 0 12px rgba(15,23,42,0.18)",
      };
    }

    const profile = getFamilyProfile(family);
    if (kind === "card") {
      lead = shiftColorCss(normalizedPrimary, profile.upTrail);
      trail = shiftColorCss(normalizedPrimary, profile.tabCardTrail);
      glow = shiftColorCss(normalizedPrimary, profile.tabCardGlow, 0.55);
      leadHex = shiftColorHex(normalizedPrimary, profile.upTrail);
      trailHex = shiftColorHex(normalizedPrimary, profile.tabCardTrail);
    } else {
      lead = shiftColorCss(normalizedPrimary, profile.upLead);
      trail = shiftColorCss(normalizedPrimary, profile.tabTimeoutTrail);
      glow = shiftColorCss(normalizedPrimary, profile.tabTimeoutGlow, 0.5);
      leadHex = shiftColorHex(normalizedPrimary, profile.upLead);
      trailHex = shiftColorHex(normalizedPrimary, profile.tabTimeoutTrail);
    }
  }

  return {
    backgroundImage: `linear-gradient(to bottom right in oklab, ${lead}, ${trail})`,
    color: getReadableTextColor(mixHexColors(leadHex, trailHex, 0.5)),
    boxShadow: `0 0 14px ${glow}`,
  };
}

function getColorFamily(color: string): ColorFamily {
  const oklch = hexToOklch(color);
  if (oklch === null || oklch.c <= 0.03) {
    return "neutral";
  }

  const hue = oklch.h;
  if (isHueInRange(hue, 70, 115)) {
    return "yellow";
  }
  if (isHueInRange(hue, 115, 185)) {
    return "green";
  }
  if (isHueInRange(hue, 185, 305)) {
    return "cool";
  }

  return "warm";
}

function getFamilyProfile(family: Exclude<ColorFamily, "neutral">) {
  if (family === "cool") {
    return COOL_PROFILE;
  }
  if (family === "warm") {
    return WARM_PROFILE;
  }
  if (family === "yellow") {
    return YELLOW_PROFILE;
  }

  return GREEN_PROFILE;
}

function baseColorCss(color: string, alpha?: number) {
  const oklch = hexToOklch(color);
  if (oklch === null) {
    return alpha === undefined
      ? normalizeTeamColor(color, DEFAULT_HOME_TEAM_COLOR)
      : "rgba(15,23,42,0.2)";
  }

  return oklchToCss(oklch, alpha);
}

function shiftColorCss(color: string, shift: ColorShift, alpha?: number) {
  const oklch = hexToOklch(color);
  if (oklch === null) {
    return alpha === undefined
      ? normalizeTeamColor(color, DEFAULT_HOME_TEAM_COLOR)
      : "rgba(15,23,42,0.2)";
  }

  return oklchToCss(shiftOklch(oklch, shift), alpha);
}

function shiftColorHex(color: string, shift: ColorShift) {
  const oklch = hexToOklch(color);
  if (oklch === null) {
    return normalizeTeamColor(color, DEFAULT_HOME_TEAM_COLOR);
  }

  return oklchToHex(shiftOklch(oklch, shift));
}

function isDarkTone(color: string) {
  const parsed = parseHexColor(color);
  if (parsed === null) {
    return false;
  }

  const luma = 0.2126 * parsed.r + 0.7152 * parsed.g + 0.0722 * parsed.b;
  return luma < 90;
}

function isHueInRange(hue: number, start: number, end: number) {
  if (start <= end) {
    return hue >= start && hue < end;
  }

  return hue >= start || hue < end;
}
