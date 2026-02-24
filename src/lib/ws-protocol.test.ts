import { describe, expect, test } from "bun:test";
import { parseClientWsMessage } from "@/lib/ws-protocol";

describe("ws-protocol", () => {
  test("parses subscribe-game events", () => {
    const parsed = parseClientWsMessage(
      JSON.stringify({
        type: "subscribe-game",
        gameId: "game-123",
        role: "spectator",
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    expect(parsed.message.type).toBe("subscribe-game");
    if (parsed.message.type !== "subscribe-game") {
      return;
    }

    expect(parsed.message.gameId).toBe("game-123");
    expect(parsed.message.role).toBe("spectator");
  });

  test("parses apply-commands with valid command payload", () => {
    const parsed = parseClientWsMessage(
      JSON.stringify({
        type: "apply-commands",
        gameId: "game-123",
        commands: [
          {
            id: "cmd-1",
            clientSentAtMs: 123_456,
            command: {
              type: "add-card",
              team: "home",
              cardType: "yellow",
              playerNumber: 3,
              startedGameClockMs: 1_020_000,
            },
          },
        ],
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    expect(parsed.message.type).toBe("apply-commands");
    if (parsed.message.type !== "apply-commands") {
      return;
    }

    expect(parsed.message.commands).toHaveLength(1);
    expect(parsed.message.commands[0]?.command.type).toBe("add-card");
    if (parsed.message.commands[0]?.command.type !== "add-card") {
      return;
    }

    expect(parsed.message.commands[0].command.startedGameClockMs).toBe(1_020_000);
  });

  test("rejects add-card with non-numeric startedGameClockMs", () => {
    const parsed = parseClientWsMessage(
      JSON.stringify({
        type: "apply-commands",
        gameId: "game-123",
        commands: [
          {
            id: "cmd-1",
            clientSentAtMs: 123_456,
            command: {
              type: "add-card",
              team: "home",
              cardType: "yellow",
              playerNumber: 3,
              startedGameClockMs: "bad-value",
            },
          },
        ],
      }),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }

    expect(parsed.error).toContain("startedGameClockMs");
  });

  test("rejects unsupported websocket event types", () => {
    const parsed = parseClientWsMessage(
      JSON.stringify({
        type: "unknown-event",
      }),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }

    expect(parsed.error).toContain("Unsupported event type");
  });

  test("rejects unsupported command types in apply-commands", () => {
    const parsed = parseClientWsMessage(
      JSON.stringify({
        type: "apply-commands",
        gameId: "game-123",
        commands: [
          {
            id: "cmd-1",
            clientSentAtMs: 123_456,
            command: {
              type: "do-something-else",
            },
          },
        ],
      }),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }

    expect(parsed.error).toContain("Unsupported command type");
  });

  test("rejects removed dismiss-penalty-expiration command", () => {
    const parsed = parseClientWsMessage(
      JSON.stringify({
        type: "apply-commands",
        gameId: "game-123",
        commands: [
          {
            id: "cmd-legacy-dismiss",
            clientSentAtMs: 123_456,
            command: {
              type: "dismiss-penalty-expiration",
              pendingId: "pending-1",
            },
          },
        ],
      }),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }

    expect(parsed.error).toContain("Unsupported command type");
  });

  test("parses undo-timeout-start command", () => {
    const parsed = parseClientWsMessage(
      JSON.stringify({
        type: "apply-commands",
        gameId: "game-123",
        commands: [
          {
            id: "cmd-undo-timeout",
            clientSentAtMs: 1,
            command: {
              type: "undo-timeout-start",
            },
          },
        ],
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    expect(parsed.message.type).toBe("apply-commands");
    if (parsed.message.type !== "apply-commands") {
      return;
    }

    expect(parsed.message.commands[0]?.command.type).toBe("undo-timeout-start");
  });

  test("parses set-display-sides-swapped command", () => {
    const parsed = parseClientWsMessage(
      JSON.stringify({
        type: "apply-commands",
        gameId: "game-123",
        commands: [
          {
            id: "cmd-display-sides",
            clientSentAtMs: 1,
            command: {
              type: "set-display-sides-swapped",
              swapped: true,
            },
          },
        ],
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.message.type !== "apply-commands") {
      return;
    }

    expect(parsed.message.commands[0]?.command.type).toBe("set-display-sides-swapped");
    if (parsed.message.commands[0]?.command.type !== "set-display-sides-swapped") {
      return;
    }
    expect(parsed.message.commands[0].command.swapped).toBe(true);
  });

  test("parses suspend-game command", () => {
    const parsed = parseClientWsMessage(
      JSON.stringify({
        type: "apply-commands",
        gameId: "game-123",
        commands: [
          {
            id: "cmd-suspend",
            clientSentAtMs: 1,
            command: {
              type: "suspend-game",
            },
          },
        ],
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.message.type !== "apply-commands") {
      return;
    }

    expect(parsed.message.commands[0]?.command.type).toBe("suspend-game");
  });

  test("parses record-forfeit command", () => {
    const parsed = parseClientWsMessage(
      JSON.stringify({
        type: "apply-commands",
        gameId: "game-123",
        commands: [
          {
            id: "cmd-forfeit",
            clientSentAtMs: 1,
            command: {
              type: "record-forfeit",
              team: "home",
            },
          },
        ],
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.message.type !== "apply-commands") {
      return;
    }

    expect(parsed.message.commands[0]?.command.type).toBe("record-forfeit");
  });

  test("rejects removed finish-game command", () => {
    const parsed = parseClientWsMessage(
      JSON.stringify({
        type: "apply-commands",
        gameId: "game-123",
        commands: [
          {
            id: "cmd-legacy-finish",
            clientSentAtMs: 123_456,
            command: {
              type: "finish-game",
            },
          },
        ],
      }),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }

    expect(parsed.error).toContain("Unsupported command type");
  });

  test("rejects command envelopes without client timestamp", () => {
    const parsed = parseClientWsMessage(
      JSON.stringify({
        type: "apply-commands",
        gameId: "game-123",
        commands: [
          {
            id: "cmd-1",
            command: {
              type: "set-running",
              running: true,
            },
          },
        ],
      }),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }

    expect(parsed.error).toContain("Invalid command envelope");
  });
});
