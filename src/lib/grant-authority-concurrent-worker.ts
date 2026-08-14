import { existsSync } from "node:fs";
import { createGrantAuthority } from "@/lib/grant-authority";
import { createGrantTestKeyRing, createGrantTestRandomness } from "@/lib/grant-authority-contract";
import { readPrivateGrantCredential } from "@/lib/grant-concurrency-process";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";

const [databasePath, readyPath, startPath, credentialPath, seedValue] = Bun.argv.slice(2);
if (
  databasePath === undefined ||
  readyPath === undefined ||
  startPath === undefined ||
  credentialPath === undefined ||
  seedValue === undefined
) {
  process.exit(2);
}

const storage = openSqliteFoundationStorage(databasePath);
const authority = createGrantAuthority(storage, {
  environmentId: "test-environment",
  clock: { nowMs: () => 1_000 },
  randomness: createGrantTestRandomness(Number(seedValue)),
  keyRing: createGrantTestKeyRing(),
  controlScopeResolver: {
    resolve() {
      return { status: "eligible", eventGameId: "game-1" };
    },
  },
});

try {
  await Bun.write(readyPath, "ready");
  const deadline = Date.now() + 5_000;
  while (!existsSync(startPath)) {
    if (Date.now() >= deadline) {
      process.stdout.write(JSON.stringify({ status: "worker-timeout" }));
      process.exitCode = 1;
      break;
    }
    await Bun.sleep(2);
  }
  if (process.exitCode !== 1) {
    const qrCredential = await readPrivateGrantCredential(credentialPath);
    const result = await authority.admitControlGrant({
      qrCredential,
      browserContext: "browser-process-barrier",
    });
    process.stdout.write(
      JSON.stringify(
        result.status === "admitted"
          ? { status: result.status, grantSessionId: result.grantSessionId }
          : { status: result.status },
      ),
    );
  }
} catch {
  process.stdout.write(JSON.stringify({ status: "worker-failed" }));
  process.exitCode = 1;
} finally {
  storage.close();
}
