import type { ControllerRole, GameCommand, GameSummary, GameView } from "@/lib/game-types";

export type ClientCommandEnvelope = {
  id: string;
  clientSentAtMs: number;
  command: GameCommand;
};

export type SubscribeLobbyMessage = {
  type: "subscribe-lobby";
};

export type SubscribeGameMessage = {
  type: "subscribe-game";
  gameId: string;
  role: ControllerRole;
};

export type ApplyCommandsMessage = {
  type: "apply-commands";
  gameId: string;
  commands: ClientCommandEnvelope[];
};

export type ClientWsMessage = SubscribeLobbyMessage | SubscribeGameMessage | ApplyCommandsMessage;

export type ServerWsMessage =
  | {
      type: "error";
      message: string;
    }
  | {
      type: "lobby-snapshot";
      games: GameSummary[];
      serverNowMs: number;
    }
  | {
      type: "game-snapshot";
      game: GameView;
      serverNowMs: number;
      ackedCommandIds: string[];
    };

export function parseClientWsMessage(raw: string):
  | {
      ok: true;
      message: ClientWsMessage;
    }
  | {
      ok: false;
      error: string;
    } {
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
    if (typeof payload.gameId !== "string" || payload.gameId.length === 0) {
      return {
        ok: false,
        error: "subscribe-game requires a non-empty gameId.",
      };
    }

    if (payload.role !== "controller" && payload.role !== "spectator") {
      return {
        ok: false,
        error: "subscribe-game requires role controller or spectator.",
      };
    }

    return {
      ok: true,
      message: {
        type: "subscribe-game",
        gameId: payload.gameId,
        role: payload.role,
      },
    };
  }

  if (payload.type === "apply-commands") {
    if (typeof payload.gameId !== "string" || payload.gameId.length === 0) {
      return {
        ok: false,
        error: "apply-commands requires a non-empty gameId.",
      };
    }

    if (!Array.isArray(payload.commands)) {
      return {
        ok: false,
        error: "apply-commands requires commands array.",
      };
    }

    const commands: ClientCommandEnvelope[] = [];
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

      const parsedCommand = parseGameCommand(entry.command);
      if (!parsedCommand.ok) {
        return {
          ok: false,
          error: parsedCommand.error,
        };
      }

      commands.push({
        id: entry.id,
        clientSentAtMs: entry.clientSentAtMs,
        command: parsedCommand.command,
      });
    }

    return {
      ok: true,
      message: {
        type: "apply-commands",
        gameId: payload.gameId,
        commands,
      },
    };
  }

  return {
    ok: false,
    error: "Unsupported event type.",
  };
}

function parseGameCommand(payload: Record<string, unknown>):
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

  if (payload.type === "adjust-game-clock") {
    if (typeof payload.deltaMs !== "number") {
      return {
        ok: false,
        error: "adjust-game-clock requires deltaMs number.",
      };
    }

    return {
      ok: true,
      command: {
        type: "adjust-game-clock",
        deltaMs: payload.deltaMs,
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

    return {
      ok: true,
      command: {
        type: "set-game-clock",
        gameClockMs: payload.gameClockMs,
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

    return {
      ok: true,
      command: {
        type: "change-score",
        team: payload.team,
        delta: payload.delta,
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

    if (
      payload.startedGameClockMs !== undefined &&
      typeof payload.startedGameClockMs !== "number"
    ) {
      return {
        ok: false,
        error: "add-card startedGameClockMs must be number when provided.",
      };
    }

    return {
      ok: true,
      command: {
        type: "add-card",
        team: payload.team,
        playerNumber: payload.playerNumber,
        cardType: payload.cardType,
        startedGameClockMs:
          typeof payload.startedGameClockMs === "number" ? payload.startedGameClockMs : undefined,
      },
    };
  }

  if (payload.type === "confirm-penalty-expiration") {
    if (typeof payload.pendingId !== "string") {
      return {
        ok: false,
        error: "confirm-penalty-expiration requires pendingId.",
      };
    }

    if (payload.playerKey !== null && typeof payload.playerKey !== "string") {
      return {
        ok: false,
        error: "confirm-penalty-expiration playerKey must be string or null.",
      };
    }

    return {
      ok: true,
      command: {
        type: "confirm-penalty-expiration",
        pendingId: payload.pendingId,
        playerKey: payload.playerKey,
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

    return {
      ok: true,
      command: {
        type: "rename-teams",
        homeName: payload.homeName,
        awayName: payload.awayName,
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
