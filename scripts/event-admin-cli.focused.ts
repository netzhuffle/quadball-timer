import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEventCatalog, createFoundationEventCatalogStorage } from "@/lib/event-catalog";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import {
  MemoryTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
} from "@/lib/technical-admin-auth";

describe("Event Admin CLI", () => {
  test("manages a Grant without accepting or exposing its raw credential", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-event-admin-cli-"));
    const databasePath = join(directory, "foundation.sqlite");
    try {
      const foundation = openSqliteFoundationStorage(databasePath);
      await foundation.applyMigrations();
      const technical = createTechnicalAdminAuth(
        { environment: "test", origin: "https://timer.example", rpId: "timer.example" },
        new MemoryTechnicalAdminAuthRepository(),
      ).resolveHostLocalAuthority();
      const catalog = createEventCatalog(createFoundationEventCatalogStorage(foundation), {});
      const event = await catalog.createEvent({ name: "CLI Event", timeZone: "UTC" }, technical);
      if (event.status !== "accepted") throw new Error("Expected Event.");
      await catalog.addGameDay(event.value.eventId, { date: "2026-08-14" }, technical);
      foundation.close();

      const created = await runCli(databasePath, "create", "--event-id", event.value.eventId);
      expect(created.exitCode).toBe(0);
      expect(created.output).toMatchObject({ status: "accepted", value: { status: "active" } });
      expect(JSON.stringify(created.output)).not.toContain("qrCredential");

      const status = await runCli(databasePath, "status", "--event-id", event.value.eventId);
      expect(status).toMatchObject({
        exitCode: 0,
        output: { status: "accepted", value: { status: "active" } },
      });

      const reveal = await runCli(databasePath, "reveal", "--event-id", event.value.eventId);
      expect(reveal.exitCode).not.toBe(0);
      expect(reveal.output).toMatchObject({ status: "rejected", reason: "invalid-input" });
      expect(JSON.stringify(reveal.output)).not.toContain("qrCredential");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function runCli(databasePath: string, ...args: string[]) {
  const child = Bun.spawn(["bun", "run", "event:admin", "--", "--db", databasePath, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "test", QUADBALL_ENVIRONMENT: "test" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout as unknown as BodyInit).text();
  const stderr = await new Response(child.stderr as unknown as BodyInit).text();
  const exitCode = await child.exited;
  return { exitCode, stderr, output: JSON.parse(stdout.trim()) as Record<string, unknown> };
}
