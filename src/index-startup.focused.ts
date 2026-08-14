import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("server startup", () => {
  test("starts from a read-only release while an unready Foundation leaves health available", async () => {
    const root = await mkdtemp(join(tmpdir(), "quadball-timer-startup-"));
    const releaseDirectory = join(root, "release");
    const stateDirectory = join(root, "state");
    await mkdir(releaseDirectory, { mode: 0o750 });
    await mkdir(stateDirectory, { mode: 0o750 });
    await chmod(releaseDirectory, 0o550);
    const server = Bun.spawn([process.execPath, "run", join(process.cwd(), "src/index.ts")], {
      cwd: releaseDirectory,
      env: {
        NODE_ENV: "production",
        QUADBALL_ENVIRONMENT: "test",
        PUBLIC_ORIGIN: "https://localhost.test",
        TECHNICAL_ADMIN_DATABASE: join(stateDirectory, "technical-admin.sqlite"),
        FOUNDATION_DATABASE: join(stateDirectory, "foundation.sqlite"),
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
      await chmod(releaseDirectory, 0o750);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps unrelated routes available when Foundation storage cannot be opened", async () => {
    const root = await mkdtemp(join(tmpdir(), "quadball-timer-startup-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o750 });
    const server = Bun.spawn([process.execPath, "run", join(process.cwd(), "src/index.ts")], {
      cwd: root,
      env: {
        NODE_ENV: "production",
        QUADBALL_ENVIRONMENT: "test",
        PUBLIC_ORIGIN: "https://localhost.test",
        TECHNICAL_ADMIN_DATABASE: join(stateDirectory, "technical-admin.sqlite"),
        FOUNDATION_DATABASE: join(root, "absent", "foundation.sqlite"),
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
      expect(games.status).toBe(200);
    } finally {
      server.kill();
      await server.exited;
      await rm(root, { recursive: true, force: true });
    }
  });
});

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
