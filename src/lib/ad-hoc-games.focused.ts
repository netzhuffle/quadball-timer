import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Ad Hoc SQLite focused integration", () => {
  test("migration, state, and operation identity survive a bounded process-boundary restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "quadball-timer-adhoc-focused-"));
    const databasePath = join(root, "ad-hoc.sqlite");
    const worker = join(process.cwd(), "scripts/ad-hoc-restart-worker.ts");
    try {
      const created = await runWorker(worker, databasePath, "create");
      const identity = JSON.parse(created) as { gameId: string; sessionId: string };
      const applied = await runWorker(
        worker,
        databasePath,
        "apply",
        identity.gameId,
        identity.sessionId,
      );
      expect(JSON.parse(applied)).toEqual({
        gameId: identity.gameId,
        running: true,
        status: "accepted",
      });
      const duplicate = await runWorker(
        worker,
        databasePath,
        "duplicate",
        identity.gameId,
        identity.sessionId,
      );
      expect(JSON.parse(duplicate)).toEqual({
        gameId: identity.gameId,
        running: true,
        status: "duplicate",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function runWorker(worker: string, databasePath: string, mode: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, "run", worker, databasePath, mode, ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = Promise.all([
      readBounded(child.stdout, 16 * 1024),
      readBounded(child.stderr, 16 * 1024),
      child.exited,
    ]);
    const result = await Promise.race([
      output,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("focused worker exceeded 10 second deadline")),
          10_000,
        );
      }),
    ]);
    const [stdout, stderr, exitCode] = result;
    if (exitCode !== 0) throw new Error(`worker failed: ${stderr || stdout}`);
    return stdout.trim();
  } catch (error) {
    await terminateChild(child);
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function terminateChild(child: ReturnType<typeof Bun.spawn>) {
  child.kill("SIGTERM");
  if (await waitForExit(child, 250)) return;

  child.kill("SIGKILL");
  if (!(await waitForExit(child, 1_000))) {
    throw new Error("focused worker did not terminate within the final reap deadline");
  }
}

async function waitForExit(child: ReturnType<typeof Bun.spawn>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    return await Promise.race([child.exited.then(() => true), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return output;
    output += decoder.decode(chunk.value, { stream: true });
    if (Buffer.byteLength(output, "utf8") > limit) {
      throw new Error("focused worker output exceeded 16 KiB limit");
    }
  }
}
