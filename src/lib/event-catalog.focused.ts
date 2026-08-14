import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createEventCatalog,
  createFoundationEventCatalogStorage,
  type EventCatalogFoundationStorage,
} from "@/lib/event-catalog";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import {
  MemoryTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
} from "@/lib/technical-admin-auth";

const authority = createTechnicalAdminAuth(
  { environment: "test", origin: "https://timer.example", rpId: "timer.example" },
  new MemoryTechnicalAdminAuthRepository(),
).resolveHostLocalAuthority();

describe("Event operations catalog through foundation SQLite", () => {
  test("persists stable Event/Game Day identities and audit history across restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-event-catalog-"));
    const databasePath = join(directory, "catalog.sqlite");
    let nowMs = Date.UTC(2026, 7, 14, 12);
    let idCounter = 0;
    const options = {
      clock: { nowMs: () => nowMs },
      ids: {
        next: (kind: "event" | "game-day" | "audit" | "operation") =>
          `${kind}-sqlite-${++idCounter}`,
      },
    };
    try {
      const foundation = openSqliteFoundationStorage(databasePath);
      await foundation.applyMigrations();
      const catalog = createEventCatalog(createFoundationEventCatalogStorage(foundation), options);
      const created = await catalog.createEvent(
        { name: "SQLite Event", timeZone: "Europe/Zurich" },
        authority,
      );
      expect(created.status).toBe("accepted");
      if (created.status !== "accepted") return;
      const day = await catalog.addGameDay(
        created.value.eventId,
        { date: "2026-08-14" },
        authority,
      );
      expect(day.status).toBe("accepted");
      if (day.status !== "accepted") return;
      foundation.close();

      const reopenedFoundation = openSqliteFoundationStorage(databasePath);
      const reopened = createEventCatalog(
        createFoundationEventCatalogStorage(reopenedFoundation),
        options,
      );
      const inspected = await reopened.inspectEvent(created.value.eventId, authority);
      expect(inspected.status).toBe("accepted");
      if (inspected.status !== "accepted") return;
      expect(inspected.value.gameDays[0]).toMatchObject({
        gameDayId: day.value.gameDayId,
        eventId: created.value.eventId,
        date: "2026-08-14",
        classification: "current",
      });
      expect(inspected.value.auditTrail).toHaveLength(2);

      nowMs += 24 * 60 * 60 * 1_000;
      const moved = await reopened.updateGameDay(
        created.value.eventId,
        day.value.gameDayId,
        { date: "2026-08-15" },
        authority,
      );
      expect(moved.status).toBe("accepted");
      const after = await reopened.inspectEvent(created.value.eventId, authority);
      expect(after.status).toBe("accepted");
      if (after.status !== "accepted") return;
      expect(after.value.gameDays[0]?.classification).toBe("current");
      expect(after.value.auditTrail).toHaveLength(3);
      reopenedFoundation.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rolls back a catalog mutation when its audit append fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-event-catalog-atomic-"));
    const databasePath = join(directory, "catalog.sqlite");
    let idCounter = 0;
    const foundation = openSqliteFoundationStorage(databasePath);
    await foundation.applyMigrations();
    const catalog = createEventCatalog(createFoundationEventCatalogStorage(foundation), {
      clock: { nowMs: () => Date.UTC(2026, 7, 14, 12) },
      ids: {
        next: (kind: "event" | "game-day" | "audit" | "operation") =>
          kind === "audit" ? "audit-reused" : `${kind}-atomic-${++idCounter}`,
      },
    });
    try {
      const created = await catalog.createEvent(
        { name: "Atomic SQLite Event", timeZone: "UTC" },
        authority,
      );
      expect(created.status).toBe("accepted");
      if (created.status !== "accepted") return;
      expect(
        await catalog.addGameDay(created.value.eventId, { date: "2026-08-14" }, authority),
      ).toMatchObject({ status: "retryable-failure" });
      const inspected = await catalog.inspectEvent(created.value.eventId, authority);
      expect(inspected.status).toBe("accepted");
      if (inspected.status !== "accepted") return;
      expect(inspected.value.gameDays).toHaveLength(0);
      expect(inspected.value.auditTrail).toHaveLength(1);
      foundation.close();
      const reopenedFoundation = openSqliteFoundationStorage(databasePath);
      const reopened = createEventCatalog(createFoundationEventCatalogStorage(reopenedFoundation), {
        clock: { nowMs: () => Date.UTC(2026, 7, 14, 12) },
        ids: {
          next: (kind: "event" | "game-day" | "audit" | "operation") =>
            `${kind}-atomic-reopen-${++idCounter}`,
        },
      });
      const reopenedInspection = await reopened.inspectEvent(created.value.eventId, authority);
      expect(reopenedInspection.status).toBe("accepted");
      if (reopenedInspection.status !== "accepted") return;
      expect(reopenedInspection.value.gameDays).toHaveLength(0);
      expect(reopenedInspection.value.auditTrail).toHaveLength(1);
      reopenedFoundation.close();
    } finally {
      foundation.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps injected transaction failures unchanged after close and reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-event-catalog-injected-"));
    const databasePath = join(directory, "catalog.sqlite");
    const durableFoundation = openSqliteFoundationStorage(databasePath);
    await durableFoundation.applyMigrations();
    const durable = createFoundationEventCatalogStorage(durableFoundation);
    let failNext = true;
    const injected: EventCatalogFoundationStorage = {
      transaction: (work) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("injected transaction failure"));
        }
        return durable.transaction(work);
      },
      snapshot: () => durable.snapshot(),
    };
    const catalog = createEventCatalog(injected, {
      clock: { nowMs: () => Date.UTC(2026, 7, 14, 12) },
      ids: {
        next: (kind: "event" | "game-day" | "audit" | "operation") =>
          `${kind}-injected-${crypto.randomUUID()}`,
      },
    });
    try {
      const created = await catalog.createEvent(
        { name: "Injected failure", timeZone: "UTC" },
        authority,
      );
      expect(created.status).toBe("retryable-failure");
      durableFoundation.close();

      const reopenedFoundation = openSqliteFoundationStorage(databasePath);
      const reopened = createEventCatalog(createFoundationEventCatalogStorage(reopenedFoundation), {
        clock: { nowMs: () => Date.UTC(2026, 7, 14, 12) },
        ids: {
          next: (kind: "event" | "game-day" | "audit" | "operation") =>
            `${kind}-injected-reopen-${crypto.randomUUID()}`,
        },
      });
      expect(await reopened.listEvents(authority)).toMatchObject({ status: "accepted", value: [] });
      reopenedFoundation.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("leaves borrowed foundation lifecycle ownership with the composition root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-event-catalog-borrowed-"));
    const foundation = openSqliteFoundationStorage(join(directory, "catalog.sqlite"));
    try {
      await foundation.applyMigrations();
      const catalog = createEventCatalog(createFoundationEventCatalogStorage(foundation), {});

      expect(await catalog.listEvents(authority)).toMatchObject({ status: "accepted", value: [] });
      expect((await foundation.readiness()).ok).toBe(true);
    } finally {
      foundation.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
