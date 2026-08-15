import { existsSync, writeFileSync } from "node:fs";
import { createAdHocGamesService, openSqliteAdHocStore } from "@/lib/ad-hoc-games";

const databasePath = process.argv[2];
const mode = process.argv[3];
if (databasePath === undefined || mode === undefined) {
  throw new Error("database path and mode required");
}

const environmentIdentity = process.argv[7] ?? "field-a";
const options =
  mode === "create"
    ? {
        beforeCapacityCommit: () => {
          const enteredPath = process.argv[4];
          const releasePath = process.argv[5];
          if (enteredPath === undefined || releasePath === undefined) {
            throw new Error("capacity barrier paths required");
          }
          writeFileSync(enteredPath, "entered");
          const deadline = Date.now() + 10_000;
          const waitCell = new Int32Array(new SharedArrayBuffer(4));
          while (!existsSync(releasePath)) {
            if (Date.now() >= deadline) throw new Error("capacity barrier timed out");
            Atomics.wait(waitCell, 0, 0, 10);
          }
        },
      }
    : {};
const startupNowMs = Number(process.argv[6] ?? "10_000_000_000");
const store = openSqliteAdHocStore(databasePath, environmentIdentity, options);
const service = createAdHocGamesService({
  store,
  environmentIdentity,
  now: () => startupNowMs,
});

try {
  if (mode === "create") {
    const result = await service.create({
      homeName: "Race Replacement",
      awayName: "Away",
      sourceKey: "focused-race-worker",
      nowMs: startupNowMs,
    });
    console.log(
      JSON.stringify(
        result.status === "accepted"
          ? { status: result.status, gameId: result.gameId }
          : { status: result.status, reason: result.reason },
      ),
    );
  } else if (mode === "connect") {
    const gameId = process.argv[4];
    const sessionId = process.argv[5];
    if (gameId === undefined || sessionId === undefined) {
      throw new Error("connection identity required");
    }
    const enteredPath = process.argv[8];
    if (enteredPath !== undefined) writeFileSync(enteredPath, "entered");
    const proceedPath = process.argv[9];
    if (proceedPath !== undefined) waitForFile(proceedPath);
    const connected = await service.setConnection({
      gameId,
      sessionId,
      connected: true,
      nowMs: startupNowMs,
    });
    console.log(JSON.stringify({ connected }));
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
} finally {
  service.close();
}

function waitForFile(path: string) {
  const deadline = Date.now() + 10_000;
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("connection barrier timed out");
    Atomics.wait(waitCell, 0, 0, 10);
  }
}
