import { describe, expect, test } from "bun:test";
import { parseClientWsMessage } from "@/lib/ws-protocol";

describe("ws-protocol", () => {
  test("rejects a WebSocket text frame over the UTF-8 byte boundary before JSON parsing", () => {
    const parsed = parseClientWsMessage(
      JSON.stringify({
        type: "subscribe-lobby",
        padding: "😀".repeat(70_000),
      }),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }

    expect(parsed.error).toContain("WebSocket text frame");
  });

  test("accepts an exact UTF-8 frame boundary and rejects one byte over", () => {
    const prefix = JSON.stringify({ type: "subscribe-lobby" });
    const exact = `${prefix}${" ".repeat(
      256 * 1024 - new TextEncoder().encode(prefix).byteLength,
    )}`;
    const oneOver = `${exact} `;

    expect(new TextEncoder().encode(exact).byteLength).toBe(256 * 1024);
    expect(parseClientWsMessage(exact).ok).toBe(true);

    const rejected = parseClientWsMessage(oneOver);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error).toContain("WebSocket text frame");
    }
  });

  test("accepts a replay batch at the shared action limit", () => {
    const parsed = parseClientWsMessage(
      JSON.stringify({
        type: "apply-commands",
        gameId: "game-123",
        commands: Array.from({ length: 100 }, (_, index) => ({
          id: `cmd-${index}`,
          clientSentAtMs: 123_456,
          command: {
            type: "set-running",
            running: index % 2 === 0,
          },
        })),
      }),
    );

    expect(parsed.ok).toBe(true);
  });

  test("rejects a replay batch one action over the shared limit", () => {
    const parsed = parseClientWsMessage(
      JSON.stringify({
        type: "apply-commands",
        gameId: "game-123",
        commands: Array.from({ length: 101 }, (_, index) => ({
          id: `cmd-${index}`,
          clientSentAtMs: 123_456,
          command: {
            type: "set-running",
            running: true,
          },
        })),
      }),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }

    expect(parsed.error).toContain("at most 100");
  });

  test("rejects duplicate command identities before a batch can mutate", () => {
    const parsed = parseClientWsMessage(
      JSON.stringify({
        type: "apply-commands",
        gameId: "game-123",
        commands: [
          {
            id: "duplicate",
            clientSentAtMs: 123_456,
            command: { type: "set-running", running: true },
          },
          {
            id: "duplicate",
            clientSentAtMs: 123_456,
            command: { type: "set-running", running: false },
          },
        ],
      }),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }

    expect(parsed.error).toContain("unique command identities");
  });

  test("normalizes and bounds team names at the protocol seam", () => {
    const normalized = parseClientWsMessage(
      JSON.stringify({
        type: "apply-commands",
        gameId: "game-123",
        commands: [
          {
            id: "cmd-rename",
            clientSentAtMs: 123_456,
            command: {
              type: "rename-teams",
              homeName: "  A\u0308 ",
              awayName: "Away",
            },
          },
        ],
      }),
    );

    expect(normalized.ok).toBe(true);
    if (normalized.ok && normalized.message.type === "apply-commands") {
      const command = normalized.message.commands[0]?.command;
      if (command?.type === "rename-teams") {
        expect(command.homeName).toBe("Ä");
      }
    }

    const oversized = parseClientWsMessage(
      JSON.stringify({
        type: "apply-commands",
        gameId: "game-123",
        commands: [
          {
            id: "cmd-rename-too-long",
            clientSentAtMs: 123_456,
            command: {
              type: "rename-teams",
              homeName: "a".repeat(81),
              awayName: "Away",
            },
          },
        ],
      }),
    );

    expect(oversized.ok).toBe(false);
    if (!oversized.ok) {
      expect(oversized.error).toContain("homeName");
    }
  });

  test("rejects unsafe, fractional, and out-of-domain command numbers", () => {
    const cases = [
      { field: "deltaMs", value: Number.NaN },
      { field: "deltaMs", value: 1.5 },
      { field: "deltaMs", value: 10 * 60 * 1000 + 1 },
      { field: "gameClockMs", value: 120 * 60 * 1000 + 1 },
      { field: "delta", value: Number.MAX_SAFE_INTEGER + 1 },
    ];

    for (const testCase of cases) {
      const command =
        testCase.field === "gameClockMs"
          ? { type: "set-game-clock", gameClockMs: testCase.value }
          : testCase.field === "delta"
            ? { type: "change-score", team: "home", delta: testCase.value, reason: "manual" }
            : { type: "adjust-game-clock", deltaMs: testCase.value };
      const parsed = parseClientWsMessage(
        JSON.stringify({
          type: "apply-commands",
          gameId: "game-123",
          commands: [{ id: `cmd-${testCase.field}`, clientSentAtMs: 123_456, command }],
        }),
      );

      expect(parsed.ok, testCase.field).toBe(false);
    }
  });

  test("rejects an online occurrence timestamp beyond the future skew limit", () => {
    const parsed = parseClientWsMessage(
      JSON.stringify({
        type: "apply-commands",
        gameId: "game-123",
        commands: [
          {
            id: "cmd-future",
            clientSentAtMs: 121_001,
            command: { type: "set-running", running: true },
          },
        ],
      }),
      { serverNowMs: 1_000 },
    );

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("future");
    }
  });

  test("parses subscribe-game without client-asserted authority", () => {
    const parsed = parseClientWsMessage(
      JSON.stringify({
        type: "subscribe-game",
        gameId: "game-123",
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
    expect(parsed.message).toEqual({ type: "subscribe-game", gameId: "game-123" });
  });

  test("rejects client-asserted subscribe-game roles", () => {
    expect(
      parseClientWsMessage(
        JSON.stringify({ type: "subscribe-game", gameId: "game-123", role: "controller" }),
      ),
    ).toEqual({ ok: false, error: "subscribe-game does not accept a role." });
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

  test("keeps Audience publication outside the existing game WebSocket contract", () => {
    expect(
      parseClientWsMessage(JSON.stringify({ type: "subscribe-audience-event", eventId: "event" })),
    ).toMatchObject({ ok: false });
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

  test("parses rename-teams with optional colors", () => {
    const parsed = parseClientWsMessage(
      JSON.stringify({
        type: "apply-commands",
        gameId: "game-123",
        commands: [
          {
            id: "cmd-rename-colors",
            clientSentAtMs: 42,
            command: {
              type: "rename-teams",
              homeName: "A",
              awayName: "B",
              homeColor: "#123abc",
              awayColor: "fedcba",
            },
          },
        ],
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.message.type !== "apply-commands") {
      return;
    }

    expect(parsed.message.commands[0]?.command.type).toBe("rename-teams");
    if (parsed.message.commands[0]?.command.type !== "rename-teams") {
      return;
    }
    expect(parsed.message.commands[0].command.homeColor).toBe("#123abc");
    expect(parsed.message.commands[0].command.awayColor).toBe("fedcba");
  });

  test("rejects rename-teams with invalid color", () => {
    const parsed = parseClientWsMessage(
      JSON.stringify({
        type: "apply-commands",
        gameId: "game-123",
        commands: [
          {
            id: "cmd-rename-colors-invalid",
            clientSentAtMs: 42,
            command: {
              type: "rename-teams",
              homeName: "A",
              awayName: "B",
              homeColor: "#12zzzz",
            },
          },
        ],
      }),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }

    expect(parsed.error).toContain("homeColor");
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
