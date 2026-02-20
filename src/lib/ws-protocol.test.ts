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
