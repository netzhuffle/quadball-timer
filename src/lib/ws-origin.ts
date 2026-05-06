const PRODUCTION_ORIGIN = "https://timer.quadball.app";
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isAllowedWebSocketOrigin(originHeader: string | null, hostHeader: string | null) {
  if (originHeader === null || hostHeader === null) {
    return false;
  }

  const origin = parseUrl(originHeader);
  const host = parseHost(hostHeader);

  if (origin === null || host === null) {
    return false;
  }

  if (origin.origin === PRODUCTION_ORIGIN) {
    return host.hostname === "timer.quadball.app";
  }

  if (!LOCAL_HOSTNAMES.has(origin.hostname) || !LOCAL_HOSTNAMES.has(host.hostname)) {
    return false;
  }

  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    return false;
  }

  return origin.port === host.port;
}

function parseUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function parseHost(value: string) {
  return parseUrl(`http://${value}`);
}
