const PRODUCTION_ORIGIN = "https://timer.quadball.app";
const TEST_HOSTNAME = "test.timer.quadball.app";
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

  if (origin.protocol === "https:" && origin.hostname === TEST_HOSTNAME) {
    return host.hostname === TEST_HOSTNAME && hasMatchingPort(origin, host);
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

function hasMatchingPort(origin: URL, host: URL) {
  const defaultPort = origin.protocol === "https:" ? "443" : "80";
  return (origin.port || defaultPort) === (host.port || defaultPort);
}
