import type { GameCommand, GameSummary, GameView } from "@/lib/game-types";
import {
  SHARED_LIMITS,
  validateClockAdjustmentMs,
  validateGameClockMs,
  validateIntegerInRange,
  validateOnlineOccurrenceMs,
  validateOpaqueIdentifier,
  validatePlayerNumber,
  normalizeBoundedText,
  utf8ByteLength,
} from "@/lib/validation-policy";

export type ClientCommandEnvelope = {
  id: string;
  clientSentAtMs: number;
  command: GameCommand;
  workflow?: "ad-hoc";
  causalPredecessorIds?: string[];
};

export type SubscribeLobbyMessage = {
  type: "subscribe-lobby";
};

export type SubscribeGameMessage = {
  type: "subscribe-game";
  gameId: string;
};

export type SubscribePublicEventMessage = {
  type: "subscribe-public-event";
  eventId: string;
};

export type ApplyCommandsMessage = {
  type: "apply-commands";
  gameId: string;
  commands: ClientCommandEnvelope[];
};

export type ClientWsMessage =
  | SubscribeLobbyMessage
  | SubscribeGameMessage
  | SubscribePublicEventMessage
  | ApplyCommandsMessage;

export type ParseClientWsMessageOptions = {
  serverNowMs?: number;
};

export type ServerWsMessage =
  | {
      type: "error";
      message: string;
      retryAfterMs?: number;
    }
  | {
      type: "lobby-snapshot";
      games: GameSummary[];
      serverNowMs: number;
    }
  | {
      type: "game-snapshot";
      game: GameView & {
        gameId?: string;
        sessionId?: string | null;
        controlQr?: string | null;
      };
      serverNowMs: number;
      ackedCommandIds: string[];
      operationOutcomes?: readonly {
        operationId: string;
        workflow: "ad-hoc" | "event";
        status: "accepted" | "duplicate" | "rejected" | "causally-blocked";
        detail?: string;
      }[];
    };

export function parseClientWsMessage(
  raw: string,
  options: ParseClientWsMessageOptions = {},
):
  | {
      ok: true;
      message: ClientWsMessage;
    }
  | {
      ok: false;
      error: string;
    } {
  if (utf8ByteLength(raw) > SHARED_LIMITS.transport.websocketTextFrameBytes) {
    return {
      ok: false,
      error: "WebSocket text frame exceeds the configured byte limit.",
    };
  }

  const serverNowMs = options.serverNowMs ?? Date.now();
  let payload: unknown;

  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    return {
      ok: false,
      error: "Message must be valid JSON.",
    };
  }

  if (!isRecord(payload)) {
    return {
      ok: false,
      error: "Message must be an object.",
    };
  }

  if (payload.type === "subscribe-lobby") {
    return {
      ok: true,
      message: {
        type: "subscribe-lobby",
      },
    };
  }

  if (payload.type === "subscribe-game") {
    const gameId = validateOpaqueIdentifier(payload.gameId, "gameId");
    if (!gameId.ok) {
      return {
        ok: false,
        error: `subscribe-game ${gameId.error}`,
      };
    }

    if ("role" in payload) {
      return {
        ok: false,
        error: "subscribe-game does not accept a role.",
      };
    }

    return {
      ok: true,
      message: {
        type: "subscribe-game",
        gameId: gameId.value,
      },
    };
  }

  if (payload.type === "subscribe-public-event") {
    const eventId = validateOpaqueIdentifier(payload.eventId, "eventId");
    if (!eventId.ok) {
      return {
        ok: false,
        error: `subscribe-public-event ${eventId.error}`,
      };
    }
    return {
      ok: true,
      message: {
        type: "subscribe-public-event",
        eventId: eventId.value,
      },
    };
  }

  if (payload.type === "apply-commands") {
    const gameId = validateOpaqueIdentifier(payload.gameId, "gameId");
    if (!gameId.ok) {
      return {
        ok: false,
        error: `apply-commands ${gameId.error}`,
      };
    }

    if (!Array.isArray(payload.commands)) {
      return {
        ok: false,
        error: "apply-commands requires commands array.",
      };
    }

    if (payload.commands.length === 0) {
      return {
        ok: false,
        error: "apply-commands requires at least one command.",
      };
    }

    if (payload.commands.length > SHARED_LIMITS.replay.maxControlActions) {
      return {
        ok: false,
        error: `apply-commands accepts at most ${SHARED_LIMITS.replay.maxControlActions} commands.`,
      };
    }

    const commands: ClientCommandEnvelope[] = [];
    const commandIds = new Set<string>();
    for (const entry of payload.commands) {
      if (
        !isRecord(entry) ||
        typeof entry.id !== "string" ||
        entry.id.length === 0 ||
        typeof entry.clientSentAtMs !== "number" ||
        !isRecord(entry.command)
      ) {
        return {
          ok: false,
          error: "Invalid command envelope.",
        };
      }

      const commandId = validateOpaqueIdentifier(entry.id, "command id");
      if (!commandId.ok) {
        return {
          ok: false,
          error: commandId.error,
        };
      }

      if (commandIds.has(commandId.value)) {
        return {
          ok: false,
          error: "apply-commands requires unique command identities.",
        };
      }

      const clientSentAtMs = validateOnlineOccurrenceMs(entry.clientSentAtMs, serverNowMs);
      if (!clientSentAtMs.ok) {
        return {
          ok: false,
          error: clientSentAtMs.error,
        };
      }

      const parsedCommand = parseGameCommand(entry.command);
      if (!parsedCommand.ok) {
        return {
          ok: false,
          error: parsedCommand.error,
        };
      }

      if (entry.workflow !== undefined && entry.workflow !== "ad-hoc") {
        return { ok: false, error: "Unsupported Controller workflow." };
      }
      if (
        entry.causalPredecessorIds !== undefined &&
        (!Array.isArray(entry.causalPredecessorIds) ||
          entry.causalPredecessorIds.some((predecessor) => typeof predecessor !== "string"))
      ) {
        return { ok: false, error: "Invalid causal predecessor identities." };
      }

      commands.push({
        id: commandId.value,
        clientSentAtMs: clientSentAtMs.value,
        command: parsedCommand.command,
        ...(entry.workflow === undefined
          ? {}
          : { workflow: entry.workflow === "ad-hoc" ? "ad-hoc" : undefined }),
        ...(entry.causalPredecessorIds === undefined
          ? {}
          : { causalPredecessorIds: entry.causalPredecessorIds as string[] }),
      });
      commandIds.add(commandId.value);
    }

    return {
      ok: true,
      message: {
        type: "apply-commands",
        gameId: gameId.value,
        commands,
      },
    };
  }

  return {
    ok: false,
    error: "Unsupported event type.",
  };
}

export function parseGameCommand(payload: Record<string, unknown>):
  | {
      ok: true;
      command: GameCommand;
    }
  | {
      ok: false;
      error: string;
    } {
  if (payload.type === "set-running") {
    if (typeof payload.running !== "boolean") {
      return {
        ok: false,
        error: "set-running requires running boolean.",
      };
    }

    return {
      ok: true,
      command: {
        type: "set-running",
        running: payload.running,
      },
    };
  }

  if (payload.type === "correct-to-unfinished") {
    if (Object.keys(payload).some((key) => key !== "type")) {
      return {
        ok: false,
        error: "correct-to-unfinished does not accept fields.",
      };
    }

    return {
      ok: true,
      command: { type: "correct-to-unfinished" },
    };
  }

  if (payload.type === "adjust-game-clock") {
    if (typeof payload.deltaMs !== "number") {
      return {
        ok: false,
        error: "adjust-game-clock requires deltaMs number.",
      };
    }

    const deltaMs = validateClockAdjustmentMs(payload.deltaMs);
    if (!deltaMs.ok) {
      return {
        ok: false,
        error: deltaMs.error,
      };
    }

    return {
      ok: true,
      command: {
        type: "adjust-game-clock",
        deltaMs: deltaMs.value,
      },
    };
  }

  if (payload.type === "set-game-clock") {
    if (typeof payload.gameClockMs !== "number") {
      return {
        ok: false,
        error: "set-game-clock requires gameClockMs number.",
      };
    }

    const gameClockMs = validateGameClockMs(payload.gameClockMs);
    if (!gameClockMs.ok) {
      return {
        ok: false,
        error: gameClockMs.error,
      };
    }

    return {
      ok: true,
      command: {
        type: "set-game-clock",
        gameClockMs: gameClockMs.value,
      },
    };
  }

  if (payload.type === "set-display-sides-swapped") {
    if (typeof payload.swapped !== "boolean") {
      return {
        ok: false,
        error: "set-display-sides-swapped requires swapped boolean.",
      };
    }

    return {
      ok: true,
      command: {
        type: "set-display-sides-swapped",
        swapped: payload.swapped,
      },
    };
  }

  if (payload.type === "change-score") {
    if (
      !isTeam(payload.team) ||
      typeof payload.delta !== "number" ||
      !isScoreReason(payload.reason)
    ) {
      return {
        ok: false,
        error: "change-score requires team, delta, and reason.",
      };
    }

    const delta = validateIntegerInRange(
      payload.delta,
      -SHARED_LIMITS.score.max,
      SHARED_LIMITS.score.max,
      "score delta",
    );
    if (!delta.ok) {
      return {
        ok: false,
        error: delta.error,
      };
    }

    return {
      ok: true,
      command: {
        type: "change-score",
        team: payload.team,
        delta: delta.value,
        reason: payload.reason,
      },
    };
  }

  if (payload.type === "undo-last-score") {
    if (!isTeam(payload.team)) {
      return {
        ok: false,
        error: "undo-last-score requires team.",
      };
    }

    return {
      ok: true,
      command: {
        type: "undo-last-score",
        team: payload.team,
      },
    };
  }

  if (payload.type === "add-card") {
    if (!isTeam(payload.team) || !isCardType(payload.cardType)) {
      return {
        ok: false,
        error: "add-card requires team and cardType.",
      };
    }

    if (payload.playerNumber !== null && typeof payload.playerNumber !== "number") {
      return {
        ok: false,
        error: "add-card playerNumber must be number or null.",
      };
    }

    const playerNumber =
      payload.playerNumber === null ? null : validatePlayerNumber(payload.playerNumber);
    if (playerNumber !== null && !playerNumber.ok) {
      return {
        ok: false,
        error: playerNumber.error,
      };
    }

    if (
      payload.startedGameClockMs !== undefined &&
      typeof payload.startedGameClockMs !== "number"
    ) {
      return {
        ok: false,
        error: "add-card startedGameClockMs must be number when provided.",
      };
    }

    const startedGameClockMs =
      payload.startedGameClockMs === undefined
        ? undefined
        : validateGameClockMs(payload.startedGameClockMs);
    if (startedGameClockMs !== undefined && !startedGameClockMs.ok) {
      return {
        ok: false,
        error: startedGameClockMs.error,
      };
    }

    return {
      ok: true,
      command: {
        type: "add-card",
        team: payload.team,
        playerNumber: playerNumber === null ? null : playerNumber.value,
        cardType: payload.cardType,
        startedGameClockMs: startedGameClockMs === undefined ? undefined : startedGameClockMs.value,
      },
    };
  }

  if (payload.type === "confirm-penalty-expiration") {
    const pendingId = validateOpaqueIdentifier(payload.pendingId, "pendingId");
    if (!pendingId.ok) {
      return {
        ok: false,
        error: `confirm-penalty-expiration ${pendingId.error}`,
      };
    }

    if (payload.playerKey !== null && typeof payload.playerKey !== "string") {
      return {
        ok: false,
        error: "confirm-penalty-expiration playerKey must be string or null.",
      };
    }

    const playerKey =
      payload.playerKey === null ? null : validateOpaqueIdentifier(payload.playerKey, "playerKey");
    if (playerKey !== null && !playerKey.ok) {
      return {
        ok: false,
        error: playerKey.error,
      };
    }

    return {
      ok: true,
      command: {
        type: "confirm-penalty-expiration",
        pendingId: pendingId.value,
        playerKey: playerKey === null ? null : playerKey.value,
      },
    };
  }

  if (payload.type === "start-timeout") {
    if (!isTeam(payload.team)) {
      return {
        ok: false,
        error: "start-timeout requires team.",
      };
    }

    return {
      ok: true,
      command: {
        type: "start-timeout",
        team: payload.team,
      },
    };
  }

  if (payload.type === "set-timeout-running") {
    if (typeof payload.running !== "boolean") {
      return {
        ok: false,
        error: "set-timeout-running requires running boolean.",
      };
    }

    return {
      ok: true,
      command: {
        type: "set-timeout-running",
        running: payload.running,
      },
    };
  }

  if (payload.type === "undo-timeout-start") {
    return {
      ok: true,
      command: {
        type: "undo-timeout-start",
      },
    };
  }

  if (payload.type === "cancel-timeout") {
    return {
      ok: true,
      command: {
        type: "cancel-timeout",
      },
    };
  }

  if (payload.type === "record-flag-catch") {
    if (!isTeam(payload.team)) {
      return {
        ok: false,
        error: "record-flag-catch requires team.",
      };
    }

    return {
      ok: true,
      command: {
        type: "record-flag-catch",
        team: payload.team,
      },
    };
  }

  if (payload.type === "record-target-score") {
    if (!isTeam(payload.team)) {
      return {
        ok: false,
        error: "record-target-score requires team.",
      };
    }

    return {
      ok: true,
      command: {
        type: "record-target-score",
        team: payload.team,
      },
    };
  }

  if (payload.type === "record-concede") {
    if (!isTeam(payload.team)) {
      return {
        ok: false,
        error: "record-concede requires team.",
      };
    }

    return {
      ok: true,
      command: {
        type: "record-concede",
        team: payload.team,
      },
    };
  }

  if (payload.type === "record-forfeit") {
    if (!isTeam(payload.team)) {
      return {
        ok: false,
        error: "record-forfeit requires team.",
      };
    }

    return {
      ok: true,
      command: {
        type: "record-forfeit",
        team: payload.team,
      },
    };
  }

  if (payload.type === "record-double-forfeit") {
    return {
      ok: true,
      command: {
        type: "record-double-forfeit",
      },
    };
  }

  if (payload.type === "suspend-game") {
    return {
      ok: true,
      command: {
        type: "suspend-game",
      },
    };
  }

  if (payload.type === "resume-game") {
    return {
      ok: true,
      command: {
        type: "resume-game",
      },
    };
  }

  if (payload.type === "rename-teams") {
    if (typeof payload.homeName !== "string" || typeof payload.awayName !== "string") {
      return {
        ok: false,
        error: "rename-teams requires homeName and awayName.",
      };
    }

    const homeName = normalizeBoundedText(
      payload.homeName,
      SHARED_LIMITS.names.teamAndPitchMaxCodePoints,
      "homeName",
    );
    const awayName = normalizeBoundedText(
      payload.awayName,
      SHARED_LIMITS.names.teamAndPitchMaxCodePoints,
      "awayName",
    );
    if (!homeName.ok) {
      return {
        ok: false,
        error: `rename-teams ${homeName.error}`,
      };
    }
    if (!awayName.ok) {
      return {
        ok: false,
        error: `rename-teams ${awayName.error}`,
      };
    }

    if (payload.homeColor !== undefined && !isHexTeamColor(payload.homeColor)) {
      return {
        ok: false,
        error: "rename-teams homeColor must be 6-digit hex when provided.",
      };
    }
    if (payload.awayColor !== undefined && !isHexTeamColor(payload.awayColor)) {
      return {
        ok: false,
        error: "rename-teams awayColor must be 6-digit hex when provided.",
      };
    }
    const homeColor = isHexTeamColor(payload.homeColor) ? payload.homeColor : undefined;
    const awayColor = isHexTeamColor(payload.awayColor) ? payload.awayColor : undefined;

    return {
      ok: true,
      command: {
        type: "rename-teams",
        homeName: homeName.value,
        awayName: awayName.value,
        homeColor,
        awayColor,
      },
    };
  }

  return {
    ok: false,
    error: "Unsupported command type.",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTeam(value: unknown): value is "home" | "away" {
  return value === "home" || value === "away";
}

function isScoreReason(value: unknown): value is "goal" | "manual" {
  return value === "goal" || value === "manual";
}

function isCardType(value: unknown): value is "blue" | "yellow" | "red" | "ejection" {
  return value === "blue" || value === "yellow" || value === "red" || value === "ejection";
}

function isHexTeamColor(value: unknown): value is string {
  return typeof value === "string" && /^#?[0-9a-fA-F]{6}$/.test(value.trim());
}
