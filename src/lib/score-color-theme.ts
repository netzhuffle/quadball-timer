import type { CSSProperties } from "react";
import {
  DEFAULT_AWAY_TEAM_COLOR,
  DEFAULT_HOME_TEAM_COLOR,
  getReadableTextColor,
  hexToOklch,
  mixHexColors,
  normalizeTeamColor,
  oklchToCss,
  oklchToHex,
  type OklchColor,
  shiftOklch,
} from "@/lib/team-colors";

export type ActionPanelTabKind = "card" | "timeout" | "game";
type ThemeFamily = "home" | "away";

type ColorShift = {
  dl: number;
  dc: number;
  dh: number;
};

type ThemeProfile = {
  base: ColorShift;
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

const HOME_PROFILE: ThemeProfile = {
  base: { dl: -0.022146216048, dc: 0.005844541628, dh: 6.597722026138 },
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

const AWAY_PROFILE: ThemeProfile = {
  base: { dl: 0.034660517055, dc: -0.031250483754, dh: 16.652347502065 },
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

const GAME_PROFILE = {
  lead: { dl: 0.015163126, dc: 0.195453798, dh: -118.546895753 },
  trail: { dl: -0.038397437, dc: 0.236926392, dh: -172.090080395 },
  glow: { dl: 0.015163126, dc: 0.195453798, dh: -118.546895753 },
};

const DEFAULT_HOME_OKLCH = requireValidOklch(DEFAULT_HOME_TEAM_COLOR);
const DEFAULT_AWAY_OKLCH = requireValidOklch(DEFAULT_AWAY_TEAM_COLOR);

export function buildScoreUpButtonStyle(
  teamColor: string,
  side: "left" | "right" = "left",
): CSSProperties {
  const { themeBase, profile } = resolveTheme(teamColor);
  const leadColor = shiftOklch(themeBase, profile.upLead);
  const trailColor = shiftOklch(themeBase, profile.upTrail);
  const [darkerColor, brighterColor] =
    leadColor.l <= trailColor.l ? [leadColor, trailColor] : [trailColor, leadColor];
  const startColor = side === "left" ? darkerColor : brighterColor;
  const endColor = side === "left" ? brighterColor : darkerColor;
  const lead = oklchToCss(startColor);
  const trail = oklchToCss(endColor);
  const border = shiftColorCss(themeBase, profile.upBorder);
  const leadHex = oklchToHex(startColor);
  const trailHex = oklchToHex(endColor);

  return {
    borderColor: border,
    backgroundImage: `linear-gradient(to bottom right in oklab, ${lead}, ${trail})`,
    color: getReadableTextColor(mixHexColors(leadHex, trailHex, 0.56)),
  };
}

export function buildScoreValueStyle(teamColor: string): CSSProperties {
  const { themeBase, profile } = resolveTheme(teamColor);
  return {
    borderColor: shiftColorCss(themeBase, profile.downBorder),
    boxShadow: `inset 0 0 12px ${baseColorCss(themeBase, profile.scoreGlowAlpha)}`,
  };
}

export function buildScoreDownButtonStyle(teamColor: string): CSSProperties {
  const { themeBase, profile } = resolveTheme(teamColor);
  return {
    borderColor: shiftColorCss(themeBase, profile.downBorder),
    backgroundColor: "#ffffff",
    color: shiftColorCss(themeBase, profile.downText),
    boxShadow: "none",
  };
}

export function buildPenaltyPanelBorderStyle(teamColor: string): CSSProperties {
  const { themeBase, profile } = resolveTheme(teamColor);
  return {
    borderColor: shiftColorCss(themeBase, profile.downBorder),
  };
}

export function buildPenaltyHeaderStyle(teamColor: string): CSSProperties {
  const { themeBase, profile } = resolveTheme(teamColor);
  return {
    color: shiftColorCss(themeBase, profile.header),
  };
}

export function buildPenaltyNeutralChipStyle(teamColor: string): CSSProperties {
  const { themeBase, profile } = resolveTheme(teamColor);
  return {
    borderColor: shiftColorCss(themeBase, profile.downBorder),
    backgroundColor: shiftColorCss(themeBase, profile.panelTop, profile.chipBackgroundAlpha),
    color: "#0f172a",
  };
}

export function buildPenaltyPanelTintStyle(
  teamColor: string,
  side: "left" | "right",
): CSSProperties {
  const { themeBase, profile } = resolveTheme(teamColor);
  const anchor = side === "left" ? "12%" : "88%";
  const tintStart = baseColorCss(themeBase, profile.tintStartAlpha);
  const tintMid = baseColorCss(themeBase, profile.tintMidAlpha);
  const topTone = shiftColorCss(themeBase, profile.panelTop, profile.topToneAlpha);

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
    const primaryTheme = shiftColorHex(resolveTheme(normalizedPrimary).themeBase, {
      dl: 0,
      dc: 0,
      dh: 0,
    });
    const secondaryTheme = shiftColorHex(resolveTheme(normalizedSecondary).themeBase, {
      dl: 0,
      dc: 0,
      dh: 0,
    });
    const blend = mixHexColors(primaryTheme, secondaryTheme, 0.5);
    const blendOklch = toOklchOrDefault(blend);
    lead = shiftColorCss(blendOklch, GAME_PROFILE.lead);
    trail = shiftColorCss(blendOklch, GAME_PROFILE.trail);
    glow = shiftColorCss(blendOklch, GAME_PROFILE.glow, 0.55);
    leadHex = shiftColorHex(blendOklch, GAME_PROFILE.lead);
    trailHex = shiftColorHex(blendOklch, GAME_PROFILE.trail);
  } else {
    const { themeBase, profile } = resolveTheme(normalizedPrimary);
    if (kind === "card") {
      lead = shiftColorCss(themeBase, profile.upTrail);
      trail = shiftColorCss(themeBase, profile.tabCardTrail);
      glow = shiftColorCss(themeBase, profile.tabCardGlow, 0.55);
      leadHex = shiftColorHex(themeBase, profile.upTrail);
      trailHex = shiftColorHex(themeBase, profile.tabCardTrail);
    } else {
      lead = shiftColorCss(themeBase, profile.upLead);
      trail = shiftColorCss(themeBase, profile.tabTimeoutTrail);
      glow = shiftColorCss(themeBase, profile.tabTimeoutGlow, 0.5);
      leadHex = shiftColorHex(themeBase, profile.upLead);
      trailHex = shiftColorHex(themeBase, profile.tabTimeoutTrail);
    }
  }

  return {
    backgroundImage: `linear-gradient(to bottom right in oklab, ${lead}, ${trail})`,
    color: getReadableTextColor(mixHexColors(leadHex, trailHex, 0.5)),
    boxShadow: `0 0 14px ${glow}`,
  };
}

function resolveTheme(teamColor: string) {
  const source = toOklchOrDefault(teamColor);
  const family = getThemeFamily(source);
  const profile = getThemeProfile(family);
  return {
    themeBase: shiftOklch(source, profile.base),
    profile,
  };
}

function getThemeFamily(color: OklchColor): ThemeFamily {
  const homeDistance = getHueDistance(color.h, DEFAULT_HOME_OKLCH.h);
  const awayDistance = getHueDistance(color.h, DEFAULT_AWAY_OKLCH.h);
  return homeDistance <= awayDistance ? "home" : "away";
}

function getThemeProfile(family: ThemeFamily) {
  return family === "home" ? HOME_PROFILE : AWAY_PROFILE;
}

function baseColorCss(color: OklchColor, alpha?: number) {
  return oklchToCss(color, alpha);
}

function shiftColorCss(color: OklchColor, shift: ColorShift, alpha?: number) {
  return oklchToCss(shiftOklch(color, shift), alpha);
}

function shiftColorHex(color: OklchColor, shift: ColorShift) {
  return oklchToHex(shiftOklch(color, shift));
}

function toOklchOrDefault(color: string) {
  const normalized = normalizeTeamColor(color, DEFAULT_HOME_TEAM_COLOR);
  return hexToOklch(normalized) ?? DEFAULT_HOME_OKLCH;
}

function requireValidOklch(color: string) {
  const oklch = hexToOklch(color);
  if (oklch !== null) {
    return oklch;
  }

  throw new Error(`Invalid default team color: ${color}`);
}

function getHueDistance(a: number, b: number) {
  const direct = Math.abs(a - b);
  return Math.min(direct, 360 - direct);
}
