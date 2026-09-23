import { join } from "node:path";
import { loadGrantKeyRingFile } from "../src/lib/grant-key-ring-custody";
import { openSqliteFoundationStorage } from "../src/lib/foundation-storage-sqlite";
import { createControlActionCodecRegistry } from "../src/lib/event-game-actions";
import { createLiveEventGameIqaInterpreter } from "../src/lib/live-event-game-control";

/** Development owns schema initialization; deployed migrations retain their existing workflow. */
export async function prepareDevelopmentDatabases(directory: string): Promise<void> {
  const { keyRing } = loadGrantKeyRingFile(join(directory, "grant-key-ring.json"), "test", {
    requiredOwnerUid: process.getuid?.() ?? 0,
  });
  for (const name of ["foundation.sqlite", "event-game.sqlite"]) {
    const storage = openSqliteFoundationStorage(join(directory, name), { grantKeyRing: keyRing });
    try {
      storage.setReadinessContext({
        actionCodecRegistry: createControlActionCodecRegistry(),
        interpreter: createLiveEventGameIqaInterpreter(),
      });
      await storage.applyMigrations();
      const readiness = await storage.readiness();
      if (!readiness.ok)
        throw new Error(`Development database ${name} is not ready: ${readiness.status}`);
    } finally {
      storage.close();
    }
  }
}
