import { openSqliteAdHocStore, createAdHocGamesService } from "@/lib/ad-hoc-games";

const databasePath = process.argv[2];
const mode = process.argv[3];
if (databasePath === undefined || mode === undefined)
  throw new Error("database path and mode required");

const service = createAdHocGamesService({
  store: openSqliteAdHocStore(databasePath),
  now: () => 10_000,
});
try {
  if (mode === "create") {
    const created = await service.create({
      homeName: "Restart Home",
      awayName: "Restart Away",
      sourceKey: "focused-source",
    });
    if (created.status !== "accepted") throw new Error(`create failed: ${created.reason}`);
    console.log(JSON.stringify({ gameId: created.gameId, sessionId: created.sessionId }));
  } else if (mode === "apply" || mode === "duplicate") {
    const gameId = process.argv[4];
    const sessionId = process.argv[5];
    if (gameId === undefined || sessionId === undefined)
      throw new Error("resume identity required");
    const applied = await service.apply({
      gameId,
      sessionId,
      operations: [
        {
          id: "restart-operation",
          clientSentAtMs: 10_000,
          command: { type: "set-running", running: true },
        },
      ],
    });
    const read = await service.read({ gameId, sessionId });
    if (applied.status === "rejected" || read.status !== "accepted")
      throw new Error("resume failed");
    if (mode === "apply" && applied.status !== "accepted")
      throw new Error("initial apply was not accepted");
    if (mode === "duplicate" && applied.status !== "duplicate")
      throw new Error("operation was not duplicate");
    console.log(
      JSON.stringify({
        running: read.game.state.isRunning,
        gameId: read.game.gameId,
        status: applied.status,
      }),
    );
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
} finally {
  service.close();
}
