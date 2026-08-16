import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("compiled Technical Admin bootstrap maintenance", () => {
  test("uses disposable Technical Admin SQLite without starting HTTP", async () => {
    const root = await mkdtemp(join(tmpdir(), "quadball-technical-admin-bootstrap-focused-"));
    const outputDirectory = join(root, "build-output");
    const executable = join(outputDirectory, "quadball-timer");
    const databasePath = join(root, "technical-admin.sqlite");
    await mkdir(outputDirectory, { recursive: true });
    try {
      const build = Bun.spawn(
        [
          process.execPath,
          "run",
          join(process.cwd(), "build.ts"),
          "--compile",
          `--compile-target=${compileTarget()}`,
          `--outfile=${executable}`,
        ],
        { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
      );
      const [buildStdout, buildStderr, buildCode] = await Promise.all([
        new Response(build.stdout).text(),
        new Response(build.stderr).text(),
        build.exited,
      ]);
      expect(buildCode, `${buildStdout}\n${buildStderr}`).toBe(0);

      const status = await runCompiled(executable, databasePath, "status");
      expect(status.code, status.stderr).toBe(0);
      expect(JSON.parse(status.stdout)).toEqual({
        environment: "test",
        credentialPresent: false,
        activeSessionCount: 0,
        storage: "ready",
      });
      expect(status.stdout).not.toContain("Server running at");
      expect((await stat(databasePath)).isFile()).toBe(true);

      const enrollment = await runCompiled(executable, databasePath, "enroll");
      expect(enrollment.code, enrollment.stderr).toBe(0);
      expect(enrollment.stdout).toMatch(/^https:\/\/localhost\/admin\/enroll#token=[^\n]+\n$/u);
      const database = new Database(databasePath, { readonly: true });
      expect(
        database
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'technical_admin_enrollment'",
          )
          .get(),
      ).toBeTruthy();
      database.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function runCompiled(
  executable: string,
  databasePath: string,
  command: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([executable, "--", "--technical-admin-bootstrap", command], {
    env: {
      NODE_ENV: "production",
      QUADBALL_ENVIRONMENT: "test",
      PUBLIC_ORIGIN: "https://localhost",
      WEBAUTHN_RP_ID: "localhost",
      TECHNICAL_ADMIN_DATABASE: databasePath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

function compileTarget(): string {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "bun-linux-arm64" : "bun-linux-x64-modern";
  }
  throw new Error(`Unsupported focused compiled target: ${process.platform}/${process.arch}`);
}
