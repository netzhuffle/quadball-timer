import { describe, expect, test } from "bun:test";
import { createInitialGameState } from "@/lib/game-engine";
import {
  createPersistedControllerSession,
  parsePersistedControllerSession,
} from "@/lib/controller-session";

describe("controller-session", () => {
  test("parses a valid persisted controller session", () => {
    const state = createInitialGameState({ id: "game-1", nowMs: 100 });
    const session = createPersistedControllerSession({
      gameId: "game-1",
      state,
      pendingCommands: [
        {
          id: "cmd-1",
          clientSentAtMs: 120,
          command: {
            type: "set-running",
            running: true,
          },
        },
      ],
      commandCounter: 1,
      savedAtMs: 130,
    });

    const parsed = parsePersistedControllerSession(JSON.stringify(session), "game-1");

    expect(parsed).not.toBeNull();
    expect(parsed?.state.id).toBe("game-1");
    expect(parsed?.pendingCommands).toHaveLength(1);
  });

  test("rejects mismatched game id", () => {
    const state = createInitialGameState({ id: "game-1", nowMs: 0 });
    const session = createPersistedControllerSession({
      gameId: "game-1",
      state,
      pendingCommands: [],
      commandCounter: 0,
      savedAtMs: 0,
    });

    const parsed = parsePersistedControllerSession(JSON.stringify(session), "game-2");

    expect(parsed).toBeNull();
  });

  test("rejects invalid pending command envelopes", () => {
    const state = createInitialGameState({ id: "game-1", nowMs: 0 });

    const parsed = parsePersistedControllerSession(
      JSON.stringify({
        version: 1,
        gameId: "game-1",
        state,
        pendingCommands: [
          {
            id: "",
            clientSentAtMs: 1,
            command: {
              type: "set-running",
              running: true,
            },
          },
        ],
        commandCounter: 1,
        savedAtMs: 1,
      }),
      "game-1",
    );

    expect(parsed).toBeNull();
  });
});
