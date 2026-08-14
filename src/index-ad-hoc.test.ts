import { describe, expect, test } from "bun:test";
import { applyAdHocCommand, createGame, readAdHocGame } from "./index";

describe("Ad Hoc HTTP route persistence", () => {
  test("keeps the existing create, command, and read path working", async () => {
    const createdResponse = await createGame(
      new Request("http://localhost/api/games", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ homeName: "A", awayName: "B" }),
      }),
    );
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { gameId: string };

    expect(
      applyAdHocCommand({
        gameId: created.gameId,
        id: "ad-hoc-command-1",
        clientSentAtMs: Date.now(),
        command: { type: "set-running", running: true },
      }),
    ).toBe(true);
    expect(readAdHocGame(created.gameId)).toMatchObject({
      state: { isRunning: true },
    });
  });
});
