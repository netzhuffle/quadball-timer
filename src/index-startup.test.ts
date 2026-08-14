import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("server startup", () => {
  test("starts a Production server from a read-only release with explicit writable state", async () => {
    const root = await mkdtemp(join(tmpdir(), "quadball-timer-startup-"));
    const releaseDirectory = join(root, "release");
    const stateDirectory = join(root, "state");
    await mkdir(releaseDirectory, { mode: 0o750 });
    await mkdir(stateDirectory, { mode: 0o750 });
    await chmod(releaseDirectory, 0o550);
    const port = 39_000 + Math.floor(Math.random() * 500);
    const server = Bun.spawn(["bun", "run", join(process.cwd(), "src/index.ts")], {
      cwd: releaseDirectory,
      env: {
        ...process.env,
        NODE_ENV: "production",
        QUADBALL_ENVIRONMENT: "production",
        PUBLIC_ORIGIN: "https://timer.quadball.app",
        TECHNICAL_ADMIN_DATABASE: join(stateDirectory, "technical-admin.sqlite"),
        FOUNDATION_DATABASE: join(stateDirectory, "foundation.sqlite"),
        HOST: "127.0.0.1",
        PORT: String(port),
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      let response: Response | null = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await Bun.sleep(25);
        response = await fetch(`http://127.0.0.1:${port}/internal/healthz`, {
          headers: { host: `127.0.0.1:${port}` },
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
});
