import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseReleaseManifest,
  type ReleaseManifest,
  type ReleaseRuntimeIdentity,
} from "./release-manifest";

export type RunningReleaseIdentity = ReleaseManifest & {
  runningExecutableSha256: string;
};

export function readBuiltRuntimeIdentity(): ReleaseRuntimeIdentity {
  const database = new Database(":memory:");
  try {
    const row = database.query<{ version: string }, []>("SELECT sqlite_version() AS version").get();
    if (row?.version === undefined) throw new Error("SQLite version was not observable.");
    return {
      bunVersion: Bun.version,
      bunRevision: Bun.revision,
      sqliteVersion: row.version,
    };
  } finally {
    database.close();
  }
}

export async function readRunningReleaseIdentity(
  manifestPath = process.env.RELEASE_MANIFEST_PATH?.trim() ||
    join(process.cwd(), "release-manifest.json"),
): Promise<RunningReleaseIdentity> {
  const manifest = parseReleaseManifest(await readFile(manifestPath, "utf8"));
  const runningExecutableSha256 = await digestFile(process.execPath);
  if (runningExecutableSha256 !== manifest.executableSha256) {
    throw new Error("Running executable does not match the selected release manifest.");
  }
  return { ...manifest, runningExecutableSha256 };
}

async function digestFile(path: string): Promise<string> {
  const digest = createHash("sha256");
  digest.update(await readFile(path));
  return digest.digest("hex");
}
