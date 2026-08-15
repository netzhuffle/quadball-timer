import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGrantTestKeyRing } from "@/lib/grant-authority-contract";
import {
  createGrantTestAuthorityVerifier,
  createLegacyControlGrantTestAuthority,
} from "@/lib/grant-authority-test-support";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import { grantKeyRingToDocument, writeGrantKeyRingFile } from "@/lib/grant-key-ring-custody";

describe("Grant custody startup boundary", () => {
  test("does not publish health when the required Grant ring is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-grant-startup-"));
    const server = Bun.spawn([process.execPath, "run", join(process.cwd(), "src/index.ts")], {
      cwd: process.cwd(),
      env: {
        NODE_ENV: "test",
        QUADBALL_ENVIRONMENT: "test",
        PUBLIC_ORIGIN: "https://localhost",
        WEBAUTHN_RP_ID: "localhost",
        TECHNICAL_ADMIN_DATABASE: join(directory, "technical-admin.sqlite"),
        PORT: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const exitCode = await Promise.race([server.exited, Bun.sleep(2_500).then(() => null)]);
      if (exitCode === null) server.kill();
      expect(exitCode).not.toBe(null);
      expect(exitCode).not.toBe(0);
    } finally {
      if (server.exitCode === null) server.kill();
      await server.exited;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not publish health when a stored non-audit key version is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-grant-startup-"));
    const foundationPath = join(directory, "foundation.sqlite");
    const ringPath = join(directory, "grant-key-ring.json");
    const keyRing = createGrantTestKeyRing();
    const foundation = openSqliteFoundationStorage(foundationPath, { grantKeyRing: keyRing });
    await foundation.applyMigrations();
    const authority = createLegacyControlGrantTestAuthority(foundation, {
      environmentId: "test",
      clock: { nowMs: () => 1_000 },
      randomness: { bytes: (length) => new Uint8Array(length).fill(7) },
      keyRing,
      controlScopeResolver: {
        resolve: () => ({ status: "eligible", eventGameId: "startup-missing-version" }),
      },
      privilegedAuthorityVerifier: createGrantTestAuthorityVerifier(),
    });
    expect(
      await authority.createControlGrant({
        scope: {
          eventId: "event-startup-missing-version",
          gameDayId: "day-startup-missing-version",
          pitchId: "pitch-startup-missing-version",
          pitchSlotId: "slot-startup-missing-version",
        },
        actor: { kind: "fixture", id: "startup-missing-version" },
      }),
    ).toMatchObject({ status: "created" });
    foundation.close();

    const missingEncryptionRing = {
      ...keyRing,
      encryption: {
        currentVersion: "v2",
        keys: new Map([["v2", keyRing.encryption.keys.get(keyRing.encryption.currentVersion)!]]),
      },
    };
    writeGrantKeyRingFile(
      ringPath,
      grantKeyRingToDocument("test", missingEncryptionRing, new Date(0).toISOString()),
    );
    const server = Bun.spawn([process.execPath, "run", join(process.cwd(), "src/index.ts")], {
      cwd: process.cwd(),
      env: {
        NODE_ENV: "test",
        QUADBALL_ENVIRONMENT: "test",
        PUBLIC_ORIGIN: "https://localhost",
        WEBAUTHN_RP_ID: "localhost",
        TECHNICAL_ADMIN_DATABASE: join(directory, "technical-admin.sqlite"),
        FOUNDATION_DATABASE: foundationPath,
        GRANT_KEY_RING_FILE: ringPath,
        PORT: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const exitCode = await Promise.race([server.exited, Bun.sleep(2_500).then(() => null)]);
      if (exitCode === null) server.kill();
      expect(exitCode).not.toBe(null);
      expect(exitCode).not.toBe(0);
    } finally {
      if (server.exitCode === null) server.kill();
      await server.exited;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
