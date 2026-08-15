import { validateOpaqueIdentifier } from "@/lib/validation-policy";

export const AD_HOC_BROWSER_ID_STORAGE_KEY = "quadball:adhoc-browser-id";

export type AdHocHandoff = {
  gameId: string;
  controlQr: string;
};

export type AdHocHandoffCapture = {
  handoff: AdHocHandoff | null;
  attempted: boolean;
};

export function getAdHocBrowserId(): string {
  try {
    const existing = window.localStorage.getItem(AD_HOC_BROWSER_ID_STORAGE_KEY);
    if (existing !== null && validateOpaqueIdentifier(existing, "browserId").ok) {
      return existing;
    }

    const created = crypto.randomUUID();
    window.localStorage.setItem(AD_HOC_BROWSER_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

export function buildAdHocControlQrPayload(
  gameId: string,
  controlQr: string,
  origin = window.location.origin,
): string {
  const handoff = new URL(origin);
  handoff.pathname = "/";
  handoff.search = "";
  handoff.hash = new URLSearchParams({
    "adhoc-game": gameId,
    "adhoc-control": controlQr,
  }).toString();
  return handoff.toString();
}

export function parseAdHocHandoffHash(hash: string): AdHocHandoff | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const gameId = params.get("adhoc-game");
  const controlQr = params.get("adhoc-control");
  if (
    gameId === null ||
    !gameId.startsWith("adhoc-") ||
    !validateOpaqueIdentifier(gameId, "gameId").ok ||
    controlQr === null ||
    controlQr.length < 32 ||
    controlQr.length > 256
  ) {
    return null;
  }
  return { gameId, controlQr };
}

export function hasAdHocHandoffAttempt(hash: string): boolean {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  return params.has("adhoc-game") || params.has("adhoc-control");
}

export function captureAdHocHandoffFromLocation(
  location: Pick<Location, "pathname" | "search" | "hash">,
  history: Pick<History, "replaceState">,
): AdHocHandoffCapture {
  const handoff = parseAdHocHandoffHash(location.hash);
  const attempted = hasAdHocHandoffAttempt(location.hash);
  if (attempted) {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }
  return { handoff, attempted };
}
