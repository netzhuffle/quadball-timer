import { describe, expect, test } from "bun:test";
import {
  access,
  chmod,
  constants,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGrantKeyRingDocument, writeGrantKeyRingFile } from "@/lib/grant-key-ring-custody";

describe("server startup", () => {
  test("keeps explicit writable state across an immutable-release restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "quadball-timer-startup-persistence-"));
    const releaseDirectory = await buildReadOnlyRelease(root);
    const stateDirectory = join(root, "state");
    const technicalAdminDirectory = join(stateDirectory, "technical-admin");
    const foundationDirectory = join(stateDirectory, "foundation");
    const credentialsDirectory = join(stateDirectory, "credentials");
    await mkdir(technicalAdminDirectory, { recursive: true, mode: 0o750 });
    await mkdir(foundationDirectory, { recursive: true, mode: 0o750 });
    await mkdir(credentialsDirectory, { recursive: true, mode: 0o750 });
    await chmod(stateDirectory, 0o550);
    const grantKeyRingPath = join(credentialsDirectory, "grant-key-ring.json");
    const technicalAdminDatabase = join(technicalAdminDirectory, "technical-admin.sqlite");
    const foundationDatabase = join(foundationDirectory, "foundation.sqlite");
    writeGrantKeyRingFile(grantKeyRingPath, createGrantKeyRingDocument("test"));
    await chmod(credentialsDirectory, 0o550);
    const environment = {
      NODE_ENV: "test",
      QUADBALL_ENVIRONMENT: "test",
      PUBLIC_ORIGIN: "https://test.timer.quadball.app",
      TECHNICAL_ADMIN_DATABASE: technicalAdminDatabase,
      FOUNDATION_DATABASE: foundationDatabase,
      GRANT_KEY_RING_FILE: grantKeyRingPath,
      HOST: "127.0.0.1",
      PORT: "0",
    };
    const start = () =>
      Bun.spawn([process.execPath, "run", "index.js"], {
        cwd: releaseDirectory,
        env: environment,
        stdout: "pipe",
        stderr: "pipe",
      });
    let server = start();
    try {
      const firstUrl = await readServerUrl(server.stdout);
      expect(
        (await fetch(new URL("/internal/healthz", firstUrl), { headers: { host: firstUrl.host } }))
          .status,
      ).toBe(200);
      await access(technicalAdminDatabase, constants.W_OK);
      await access(foundationDatabase, constants.W_OK);
      await expectRejected(() => access(join(releaseDirectory, "index.js"), constants.W_OK));
      await expectRejected(() =>
        writeFile(join(releaseDirectory, "invalid-write-target"), "blocked"),
      );
      const firstState = await Promise.all([
        stat(technicalAdminDatabase),
        stat(foundationDatabase),
      ]);
      expect(firstState.every((entry) => entry.isFile() && entry.size > 0)).toBe(true);

      server.kill();
      await server.exited;
      server = start();
      const secondUrl = await readServerUrl(server.stdout);
      expect(
        (
          await fetch(new URL("/internal/healthz", secondUrl), {
            headers: { host: secondUrl.host },
          })
        ).status,
      ).toBe(200);
      const secondState = await Promise.all([
        stat(technicalAdminDatabase),
        stat(foundationDatabase),
      ]);
      expect(secondState.map((entry) => entry.ino)).toEqual(firstState.map((entry) => entry.ino));
      expect(secondState.every((entry) => entry.isFile() && entry.size > 0)).toBe(true);
    } finally {
      server.kill();
      await server.exited;
      await restoreReleaseAccess(releaseDirectory);
      await chmod(credentialsDirectory, 0o750);
      await chmod(stateDirectory, 0o750);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("starts from a read-only release while an unready Foundation leaves health available", async () => {
    const root = await mkdtemp(join(tmpdir(), "quadball-timer-startup-"));
    const releaseDirectory = await buildReadOnlyRelease(root);
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o750 });
    const grantKeyRingPath = join(stateDirectory, "grant-key-ring.json");
    writeGrantKeyRingFile(grantKeyRingPath, createGrantKeyRingDocument("test"));
    const server = Bun.spawn([process.execPath, "run", "index.js"], {
      cwd: releaseDirectory,
      env: {
        NODE_ENV: "test",
        QUADBALL_ENVIRONMENT: "test",
        PUBLIC_ORIGIN: "https://test.timer.quadball.app",
        TECHNICAL_ADMIN_DATABASE: join(stateDirectory, "technical-admin.sqlite"),
        FOUNDATION_DATABASE: join(stateDirectory, "foundation.sqlite"),
        GRANT_KEY_RING_FILE: grantKeyRingPath,
        HOST: "127.0.0.1",
        PORT: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const serverUrl = await readServerUrl(server.stdout);
      let response: Response | null = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await Bun.sleep(25);
        response = await fetch(new URL("/internal/healthz", serverUrl), {
          headers: { host: serverUrl.host },
        }).catch(() => null);
        if (response?.status === 200) break;
      }
      expect(response?.status).toBe(200);
    } finally {
      server.kill();
      await server.exited;
      await restoreReleaseAccess(releaseDirectory);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps unrelated routes available when Foundation storage cannot be opened", async () => {
    const root = await mkdtemp(join(tmpdir(), "quadball-timer-startup-"));
    const releaseDirectory = await buildReadOnlyRelease(root);
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o750 });
    const grantKeyRingPath = join(stateDirectory, "grant-key-ring.json");
    writeGrantKeyRingFile(grantKeyRingPath, createGrantKeyRingDocument("test"));
    const server = Bun.spawn([process.execPath, "run", "index.js"], {
      cwd: releaseDirectory,
      env: {
        NODE_ENV: "test",
        QUADBALL_ENVIRONMENT: "test",
        PUBLIC_ORIGIN: "https://test.timer.quadball.app",
        TECHNICAL_ADMIN_DATABASE: join(stateDirectory, "technical-admin.sqlite"),
        FOUNDATION_DATABASE: join(root, "absent", "foundation.sqlite"),
        GRANT_KEY_RING_FILE: grantKeyRingPath,
        HOST: "127.0.0.1",
        PORT: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const serverUrl = await readServerUrl(server.stdout);
      const health = await fetch(new URL("/internal/healthz", serverUrl), {
        headers: { host: serverUrl.host },
      });
      const games = await fetch(new URL("/api/games", serverUrl));
      expect(health.status).toBe(200);
      expect(games.status).toBe(404);
    } finally {
      server.kill();
      await server.exited;
      await restoreReleaseAccess(releaseDirectory);
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function buildReadOnlyRelease(root: string): Promise<string> {
  const releaseDirectory = join(root, "release");
  await mkdir(releaseDirectory, { mode: 0o750 });
  const build = Bun.spawn(
    [process.execPath, "run", join(process.cwd(), "build.ts"), "--outdir", releaseDirectory],
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
  );
  const stdout = new Response(build.stdout as unknown as BodyInit).text();
  const stderr = new Response(build.stderr as unknown as BodyInit).text();
  const exitCode = await build.exited;
  if (exitCode !== 0)
    throw new Error(`Release build failed (${exitCode}).\n${await stdout}\n${await stderr}`);
  const entry = join(releaseDirectory, "index.js");
  const entryStat = await stat(entry);
  expect(entryStat.isFile()).toBe(true);
  for (const file of await readdir(releaseDirectory, { withFileTypes: true })) {
    await chmod(join(releaseDirectory, file.name), file.isDirectory() ? 0o550 : 0o440);
  }
  await chmod(releaseDirectory, 0o550);
  return releaseDirectory;
}

async function restoreReleaseAccess(releaseDirectory: string): Promise<void> {
  await chmod(releaseDirectory, 0o750);
}

async function expectRejected(operation: () => Promise<unknown>): Promise<void> {
  let rejected = false;
  try {
    await operation();
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
}

async function readServerUrl(stdout: ReadableStream<Uint8Array>): Promise<URL> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  const readUrl = (async () => {
    let output = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("Server exited before reporting its bound URL.");
      output += decoder.decode(value, { stream: true });
      const match = output.match(/Server running at (http:\/\/[^\s]+)/);
      if (match?.[1]) return new URL(match[1]);
    }
  })();

  try {
    return await Promise.race([
      readUrl,
      Bun.sleep(2_500).then(() => {
        throw new Error("Server did not report its bound URL within 2.5 seconds.");
      }),
    ]);
  } finally {
    reader.releaseLock();
  }
}
