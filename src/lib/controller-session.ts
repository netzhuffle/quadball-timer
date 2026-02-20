import type { GameState } from "@/lib/game-types";
import type { ClientCommandEnvelope } from "@/lib/ws-protocol";

export const CONTROLLER_SESSION_VERSION = 1 as const;

export type PersistedControllerSession = {
  version: typeof CONTROLLER_SESSION_VERSION;
  gameId: string;
  state: GameState;
  pendingCommands: ClientCommandEnvelope[];
  commandCounter: number;
  savedAtMs: number;
};

export function getControllerSessionStorageKey(gameId: string) {
  return `quadball:controller-session:${gameId}`;
}

export function createPersistedControllerSession({
  gameId,
  state,
  pendingCommands,
  commandCounter,
  savedAtMs,
}: {
  gameId: string;
  state: GameState;
  pendingCommands: ClientCommandEnvelope[];
  commandCounter: number;
  savedAtMs: number;
}): PersistedControllerSession {
  return {
    version: CONTROLLER_SESSION_VERSION,
    gameId,
    state,
    pendingCommands,
    commandCounter,
    savedAtMs,
  };
}

export function parsePersistedControllerSession(
  raw: string,
  expectedGameId: string,
): PersistedControllerSession | null {
  let payload: unknown;

  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }

  if (!isRecord(payload)) {
    return null;
  }

  if (payload.version !== CONTROLLER_SESSION_VERSION) {
    return null;
  }

  if (payload.gameId !== expectedGameId) {
    return null;
  }

  if (!isRecord(payload.state) || payload.state.id !== expectedGameId) {
    return null;
  }

  if (
    !Array.isArray(payload.pendingCommands) ||
    !payload.pendingCommands.every(isClientCommandEnvelope)
  ) {
    return null;
  }

  const commandCounter = payload.commandCounter;
  if (
    typeof commandCounter !== "number" ||
    !Number.isInteger(commandCounter) ||
    commandCounter < 0
  ) {
    return null;
  }

  if (typeof payload.savedAtMs !== "number") {
    return null;
  }

  return payload as PersistedControllerSession;
}

function isClientCommandEnvelope(value: unknown): value is ClientCommandEnvelope {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.clientSentAtMs === "number" &&
    isRecord(value.command) &&
    typeof value.command.type === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
