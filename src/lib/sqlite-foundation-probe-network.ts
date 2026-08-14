import { readlinkSync } from "node:fs";

export type ProbeNetworkBoundary = {
  commandPrefix?: readonly string[];
  namespace: string;
  unshare?: string;
  shell?: string;
  verified: true;
};

export type ProbeNetworkBoundaryOptions = {
  platform?: NodeJS.Platform;
  which?: (command: string) => string | undefined;
  parentNamespace?: () => string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export async function createProbeNetworkBoundary(
  options: ProbeNetworkBoundaryOptions = {},
): Promise<ProbeNetworkBoundary> {
  if (options.signal?.aborted) {
    throw new ProbeNetworkBoundaryError("Linux no-network boundary admission was interrupted.");
  }
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") {
    throw new ProbeNetworkBoundaryError(
      "SQLite runtime qualification requires Linux network namespaces.",
    );
  }

  const which = options.which ?? ((command: string) => Bun.which(command) ?? undefined);
  const unshare = which("unshare");
  const shell = which("sh");
  const parentNamespace = (options.parentNamespace ?? readParentNetworkNamespace)();
  if (unshare === undefined || shell === undefined || parentNamespace === null) {
    throw new ProbeNetworkBoundaryError("Linux no-network boundary controls are unavailable.");
  }
  if (options.signal?.aborted) {
    throw new ProbeNetworkBoundaryError("Linux no-network boundary admission was interrupted.");
  }

  return {
    namespace: parentNamespace,
    unshare,
    shell,
    verified: true,
  };
}

export function buildNoNetworkProbeCommand(
  boundary: ProbeNetworkBoundary,
  executablePath: string,
  arguments_: readonly string[],
): string[] {
  if (boundary.verified !== true || boundary.namespace.length === 0) {
    throw new ProbeNetworkBoundaryError("Verified no-network boundary is required before launch.");
  }
  return [executablePath, ...arguments_];
}

function readParentNetworkNamespace(): string | null {
  try {
    return readlinkSync("/proc/self/ns/net");
  } catch {
    return null;
  }
}

export class ProbeNetworkBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeNetworkBoundaryError";
  }
}
