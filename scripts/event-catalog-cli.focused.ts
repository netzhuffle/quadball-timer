import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import { FOUNDATION_MIGRATIONS } from "@/lib/foundation-migrations";

describe("Event catalog CLI", () => {
  test("requires an explicit foundation database path", async () => {
    const result = await runCliWithoutDatabase();
    expect(result).toMatchObject({
      status: "rejected",
      reason: "invalid-input",
      detail: "A foundation database path is required via --db or EVENT_CATALOG_DATABASE.",
    });
  });

  test("lists and inspects catalog state as machine-readable outcomes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-event-catalog-cli-"));
    const databasePath = join(directory, "catalog.sqlite");
    try {
      await prepareFixture(databasePath);
      const created = await runCli(
        databasePath,
        "create",
        "--name",
        "CLI Event",
        "--timezone",
        "UTC",
      );
      expect(created.status).toBe("accepted");
      if (created.status !== "accepted") return;
      const eventId = (created.value as { eventId: string }).eventId;
      const listed = await runCli(databasePath, "list");
      expect(listed.status).toBe("accepted");
      if (listed.status !== "accepted") return;
      expect((listed.value as Array<{ eventId: string; lifecycle: string }>)[0]).toMatchObject({
        eventId,
        lifecycle: "unscheduled",
      });
      const inspected = await runCli(databasePath, "inspect", "--event-id", eventId);
      expect(inspected.status).toBe("accepted");
      expect(JSON.stringify(inspected)).toContain("technical-admin:test:host-local-cli");
      expect(JSON.stringify(inspected)).not.toContain("raw-session-token");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not migrate a foundation database during CLI invocation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-event-catalog-cli-pending-"));
    const databasePath = join(directory, "catalog.sqlite");
    try {
      await preparePartialFixture(databasePath);
      const result = await runCliAllowFailure(databasePath, "list");
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toMatchObject({ status: "retryable-failure" });

      const foundation = openSqliteFoundationStorage(databasePath);
      try {
        expect((await foundation.readiness()).ok).toBe(false);
      } finally {
        foundation.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function runCli(databasePath: string, ...args: string[]) {
  const result = await runCliAllowFailure(databasePath, ...args);
  if (result.exitCode !== 0) throw new Error(result.stderr || JSON.stringify(result.output));
  return result.output as { status: string; value?: unknown };
}

async function runCliAllowFailure(databasePath: string, ...args: string[]) {
  const child = Bun.spawn(["bun", "run", "event:catalog", "--", "--db", databasePath, ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout as unknown as BodyInit).text();
  const stderr = await new Response(child.stderr as unknown as BodyInit).text();
  const exitCode = await child.exited;
  return {
    exitCode,
    stderr,
    output: JSON.parse(stdout.trim()) as { status: string; value?: unknown },
  };
}

async function runCliWithoutDatabase() {
  const child = Bun.spawn(["bun", "run", "event:catalog", "--", "list"], {
    cwd: process.cwd(),
    env: { ...process.env, EVENT_CATALOG_DATABASE: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout as unknown as BodyInit).text();
  await child.exited;
  return JSON.parse(stdout.trim()) as { status: string; reason?: string; detail?: string };
}

async function prepareFixture(databasePath: string) {
  const foundation = openSqliteFoundationStorage(databasePath);
  await foundation.applyMigrations();
  foundation.close();
}

async function preparePartialFixture(databasePath: string) {
  const foundation = openSqliteFoundationStorage(databasePath, {
    migrations: FOUNDATION_MIGRATIONS.slice(0, -1),
  });
  await foundation.applyMigrations({ requireCandidate: false });
  foundation.close();
}
