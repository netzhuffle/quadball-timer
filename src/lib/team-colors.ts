export const DEFAULT_HOME_TEAM_COLOR = "#0ea5e9";
export const DEFAULT_AWAY_TEAM_COLOR = "#f97316";

const HEX_COLOR_PATTERN = /^#?([0-9a-fA-F]{6})$/;

type RgbColor = {
  r: number;
  g: number;
  b: number;
};

export type OklchColor = {
  l: number;
  c: number;
  h: number;
};

export function normalizeTeamColor(value: unknown, fallback: string): string {
  const normalizedFallback = normalizeHexColor(fallback) ?? DEFAULT_HOME_TEAM_COLOR;
  if (typeof value !== "string") {
    return normalizedFallback;
  }

  return normalizeHexColor(value) ?? normalizedFallback;
}

export function parseHexColor(value: string): RgbColor | null {
  const normalized = normalizeHexColor(value);
  if (normalized === null) {
    return null;
  }

  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

export function withColorAlpha(color: string, alpha: number): string {
  const parsed = parseHexColor(color);
  const safeAlpha = clamp(alpha, 0, 1);
  if (parsed === null) {
    return `rgba(15,23,42,${safeAlpha})`;
  }

  return `rgba(${parsed.r},${parsed.g},${parsed.b},${safeAlpha})`;
}

export function mixHexColors(primaryColor: string, secondaryColor: string, primaryWeight: number) {
  const primary = parseHexColor(primaryColor);
  const secondary = parseHexColor(secondaryColor);
  if (primary === null) {
    return normalizeTeamColor(secondaryColor, DEFAULT_HOME_TEAM_COLOR);
  }
  if (secondary === null) {
    return normalizeTeamColor(primaryColor, DEFAULT_HOME_TEAM_COLOR);
  }

  const weight = clamp(primaryWeight, 0, 1);
  return rgbToHex({
    r: Math.round(primary.r * weight + secondary.r * (1 - weight)),
    g: Math.round(primary.g * weight + secondary.g * (1 - weight)),
    b: Math.round(primary.b * weight + secondary.b * (1 - weight)),
  });
}

export function getReadableTextColor(backgroundColor: string) {
  const background = parseHexColor(backgroundColor);
  if (background === null) {
    return "#0f172a";
  }

  const luminance = getRelativeLuminance(background);
  return luminance >= 0.58 ? "#0f172a" : "#ffffff";
}

export function hexToOklch(value: string): OklchColor | null {
  const rgb = parseHexColor(value);
  if (rgb === null) {
    return null;
  }

  const red = toLinearSrgbChannel(rgb.r / 255);
  const green = toLinearSrgbChannel(rgb.g / 255);
  const blue = toLinearSrgbChannel(rgb.b / 255);

  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);

  const lLab = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const aLab = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bLab = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  const chroma = Math.hypot(aLab, bLab);
  const hueRaw = (Math.atan2(bLab, aLab) * 180) / Math.PI;
  const hue = normalizeHue(hueRaw);

  return {
    l: clamp(lLab, 0, 1),
    c: Math.max(0, chroma),
    h: hue,
  };
}

export function shiftOklch(
  color: OklchColor,
  shift: { dl?: number; dc?: number; dh?: number },
): OklchColor {
  const dl = shift.dl ?? 0;
  const dc = shift.dc ?? 0;
  const dh = shift.dh ?? 0;

  return {
    l: clamp(color.l + dl, 0, 1),
    c: Math.max(0, color.c + dc),
    h: normalizeHue(color.h + dh),
  };
}

export function oklchToCss(color: OklchColor, alpha?: number) {
  const lightness = trimNumber(color.l * 100, 3);
  const chroma = trimNumber(color.c, 3);
  const hue = trimNumber(normalizeHue(color.h), 3);
  if (alpha === undefined) {
    return `oklch(${lightness}% ${chroma} ${hue})`;
  }

  return `oklch(${lightness}% ${chroma} ${hue} / ${trimNumber(clamp(alpha, 0, 1), 3)})`;
}

export function oklchToHex(color: OklchColor): string {
  const hueRadians = (normalizeHue(color.h) * Math.PI) / 180;
  const lLab = clamp(color.l, 0, 1);
  const aLab = Math.max(0, color.c) * Math.cos(hueRadians);
  const bLab = Math.max(0, color.c) * Math.sin(hueRadians);

  const l = lLab + 0.3963377774 * aLab + 0.2158037573 * bLab;
  const m = lLab - 0.1055613458 * aLab - 0.0638541728 * bLab;
  const s = lLab - 0.0894841775 * aLab - 1.291485548 * bLab;

  const lLinear = l ** 3;
  const mLinear = m ** 3;
  const sLinear = s ** 3;

  const redLinear = 4.0767416621 * lLinear - 3.3077115913 * mLinear + 0.2309699292 * sLinear;
  const greenLinear = -1.2684380046 * lLinear + 2.6097574011 * mLinear - 0.3413193965 * sLinear;
  const blueLinear = -0.0041960863 * lLinear - 0.7034186147 * mLinear + 1.707614701 * sLinear;

  const red = toGammaSrgbChannel(clamp(redLinear, 0, 1));
  const green = toGammaSrgbChannel(clamp(greenLinear, 0, 1));
  const blue = toGammaSrgbChannel(clamp(blueLinear, 0, 1));

  return rgbToHex({
    r: Math.round(red * 255),
    g: Math.round(green * 255),
    b: Math.round(blue * 255),
  });
}

function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim();
  const match = HEX_COLOR_PATTERN.exec(trimmed);
  if (match === null) {
    return null;
  }
  const hex = match[1];
  if (hex === undefined) {
    return null;
  }

  return `#${hex.toLowerCase()}`;
}

function rgbToHex({ r, g, b }: RgbColor) {
  return `#${toHexChannel(r)}${toHexChannel(g)}${toHexChannel(b)}`;
}

function toHexChannel(value: number) {
  const bounded = Math.max(0, Math.min(255, Math.round(value)));
  return bounded.toString(16).padStart(2, "0");
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getRelativeLuminance({ r, g, b }: RgbColor) {
  const red = toLinearChannel(r / 255);
  const green = toLinearChannel(g / 255);
  const blue = toLinearChannel(b / 255);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function toLinearChannel(value: number) {
  if (value <= 0.03928) {
    return value / 12.92;
  }

  return ((value + 0.055) / 1.055) ** 2.4;
}

function toLinearSrgbChannel(value: number) {
  if (value <= 0.04045) {
    return value / 12.92;
  }

  return ((value + 0.055) / 1.055) ** 2.4;
}

function toGammaSrgbChannel(value: number) {
  if (value <= 0.0031308) {
    return value * 12.92;
  }

  return 1.055 * value ** (1 / 2.4) - 0.055;
}

function normalizeHue(value: number) {
  const wrapped = value % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

function trimNumber(value: number, digits: number) {
  const rounded = Number(value.toFixed(digits));
  if (!Number.isFinite(rounded)) {
    return "0";
  }

  return String(rounded);
}
