import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("server startup", () => {
  test("keeps shipped configuration available when the default catalog is not ready", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-timer-startup-"));
    const port = 39_000 + Math.floor(Math.random() * 500);
    const server = Bun.spawn(["bun", "run", join(process.cwd(), "src/index.ts")], {
      cwd: directory,
      env: {
        ...process.env,
        NODE_ENV: "production",
        QUADBALL_ENVIRONMENT: "production",
        PUBLIC_ORIGIN: "https://timer.quadball.app",
        TECHNICAL_ADMIN_DATABASE: join(directory, "technical-admin.sqlite"),
        HOST: "127.0.0.1",
        PORT: String(port),
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      let response: Response | null = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await Bun.sleep(50);
        response = await fetch(`http://127.0.0.1:${port}/internal/healthz`, {
          headers: { host: `127.0.0.1:${port}` },
        }).catch(() => null);
        if (response?.status === 200) break;
      }
      expect(response?.status).toBe(200);
    } finally {
      server.kill();
      await server.exited;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
