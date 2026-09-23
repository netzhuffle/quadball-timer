import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  createGrantKeyRingDocument,
  loadGrantKeyRingFile,
  writeGrantKeyRingFile,
} from "../src/lib/grant-key-ring-custody";

type DevelopmentState = {
  version: 1;
  adHocEnvironmentId: string;
  /** Preserve catalog-only behavior when importing older presentation previews. */
  liveEventGames?: boolean;
};

export function developmentDirectory(worktree: string): string {
  return join(resolve(worktree), ".local", "dev");
}

export function readDevelopmentState(directory: string): DevelopmentState {
  const state: DevelopmentState = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
  if (
    state.version !== 1 ||
    typeof state.adHocEnvironmentId !== "string" ||
    !state.adHocEnvironmentId.startsWith("test:") ||
    (state.liveEventGames !== undefined && typeof state.liveEventGames !== "boolean")
  ) {
    throw new Error(
      "Invalid development state; preserve the existing files and restore their matching keys.",
    );
  }
  loadGrantKeyRingFile(join(directory, "grant-key-ring.json"), "test", {
    requiredOwnerUid: process.getuid?.() ?? 0,
  });
  return state;
}

/** Initialize once; never replace existing databases or keys on startup. Copy only a stopped dev instance. */
export function initializeDevelopmentState(worktree: string, copyFrom?: string): string {
  const directory = developmentDirectory(worktree);
  if (existsSync(directory)) {
    if (copyFrom)
      throw new Error("Destination development state already exists; refusing to overwrite it.");
    readDevelopmentState(directory);
    return directory;
  }
  mkdirSync(join(resolve(worktree), ".local"), { recursive: true, mode: 0o700 });
  const staging = `${directory}.initializing-${randomUUID()}`;
  mkdirSync(staging, { mode: 0o700 });
  try {
    if (copyFrom) {
      const source = developmentDirectory(copyFrom);
      readDevelopmentState(source);
      const sourceLock = join(source, "runtime.lock");
      try {
        mkdirSync(sourceLock);
      } catch {
        throw new Error("Stop the source development server before copying its data.");
      }
      try {
        writeFileSync(join(sourceLock, "pid"), String(process.pid));
        for (const entry of readdirSync(source)) {
          // Passkeys and browser sessions belong to this worktree's own HTTPS enrollment.
          if (entry === "technical-admin" || entry === "runtime.lock") continue;
          cpSync(join(source, entry), join(staging, entry), {
            recursive: true,
            errorOnExist: true,
            force: false,
          });
        }
      } finally {
        rmSync(sourceLock, { recursive: true, force: true });
      }
    } else {
      const ring = createGrantKeyRingDocument("test");
      writeGrantKeyRingFile(join(staging, "grant-key-ring.json"), ring);
      const state: DevelopmentState = {
        version: 1,
        adHocEnvironmentId: `test:dev:${randomUUID()}`,
        liveEventGames: true,
      };
      writeFileSync(join(staging, "state.json"), JSON.stringify(state, null, 2) + "\n", {
        mode: 0o600,
      });
    }
    readDevelopmentState(staging);
    renameSync(staging, directory);
    return directory;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function developmentEnvironment(
  directory: string,
  port: number,
  origin: string,
): Record<string, string> {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Port must be between 1 and 65535.");
  const url = new URL(origin);
  if (url.origin !== origin || !["http:", "https:"].includes(url.protocol))
    throw new Error("Use an exact HTTP or HTTPS public origin.");
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error(
      "HTTP development must use a loopback origin; use an HTTPS preview for other devices.",
    );
  const state = readDevelopmentState(directory);
  const adminDirectory = join(directory, "technical-admin");
  mkdirSync(adminDirectory, { recursive: true, mode: 0o700 });
  return {
    NODE_ENV: "development",
    QUADBALL_ENVIRONMENT: "test",
    HOST: "127.0.0.1",
    PORT: String(port),
    PUBLIC_ORIGIN: origin,
    WEBAUTHN_RP_ID: url.hostname,
    LOCAL_HTTP_DEV: url.protocol === "http:" ? "1" : "0",
    AD_HOC_ENVIRONMENT_ID: state.adHocEnvironmentId,
    AD_HOC_DATABASE: join(directory, "ad-hoc.sqlite"),
    FOUNDATION_DATABASE: join(directory, "foundation.sqlite"),
    EVENT_GAME_DATABASE: join(directory, "event-game.sqlite"),
    TECHNICAL_ADMIN_DATABASE: join(
      adminDirectory,
      `${createHash("sha256").update(origin).digest("hex")}.sqlite`,
    ),
    GRANT_KEY_RING_FILE: join(directory, "grant-key-ring.json"),
    DEV_EVENT_GAME_KEY_RING_FILE:
      state.liveEventGames === false ? "" : join(directory, "grant-key-ring.json"),
    // Never inherit a different live reader's keys when restoring catalog-only previews.
    EVENT_GAME_ENCRYPTION_KEY: "",
    EVENT_GAME_LOOKUP_KEY: "",
    EVENT_GAME_AUDIT_KEY: "",
  };
}
