const INTERNAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isInternalHealthHost(hostHeader: string | null) {
  if (hostHeader === null) {
    return false;
  }

  const host = hostHeader.trim().toLowerCase();
  if (host.length === 0) {
    return false;
  }

  const hostWithoutPort = stripPort(host);
  return INTERNAL_HOSTS.has(hostWithoutPort);
}

function stripPort(host: string) {
  if (host.startsWith("[::1]")) {
    return "[::1]";
  }

  const lastColonIndex = host.lastIndexOf(":");
  if (lastColonIndex === -1) {
    return host;
  }

  if (host.indexOf(":") !== lastColonIndex) {
    return host;
  }

  return host.slice(0, lastColonIndex);
}
