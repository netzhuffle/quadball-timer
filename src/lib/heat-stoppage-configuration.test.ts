import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOUNDATION_MIGRATIONS, type FoundationMigration } from "@/lib/foundation-migrations";
import type {
  FoundationStorage,
  FoundationStorageSnapshot,
  StoredEventCatalogEvent,
  StoredEventCatalogGameDay,
  StoredEventCatalogGame,
  StoredEventCatalogPitch,
  StoredGameplaySlot,
  StoredPitchSlot,
} from "@/lib/foundation-storage";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import {
  resolveHeatStoppageConfiguration,
  type HeatStoppageConfiguration,
} from "@/lib/heat-stoppage-configuration";

const scope = { eventId: "event-1", gameDayId: "day-1", eventGameId: "game-1" } as const;

const event: StoredEventCatalogEvent = {
  eventId: scope.eventId,
  name: "Heat Event",
  timeZone: "UTC",
  publicationStatus: "unpublished",
  createdAtMs: 1,
  updatedAtMs: 1,
};

const gameDay: StoredEventCatalogGameDay = {
  gameDayId: scope.gameDayId,
  eventId: scope.eventId,
  date: "2026-08-15",
  heatStoppageConfiguration: "disabled",
  createdAtMs: 1,
  updatedAtMs: 1,
};

const pitch: StoredEventCatalogPitch = {
  pitchId: "pitch-1",
  eventId: scope.eventId,
  name: "Pitch 1",
  createdAtMs: 1,
  updatedAtMs: 1,
};

const gameplaySlot: StoredGameplaySlot = {
  gameplaySlotId: "gameplay-slot-1",
  eventId: scope.eventId,
  gameDayId: scope.gameDayId,
  sequence: 1,
  scheduledStartMs: 1,
  expectedDelayMs: 0,
  createdAtMs: 1,
  updatedAtMs: 1,
};

const pitchSlot: StoredPitchSlot = {
  pitchSlotId: "pitch-slot-1",
  eventId: scope.eventId,
  gameDayId: scope.gameDayId,
  pitchId: pitch.pitchId,
  gameplaySlotId: gameplaySlot.gameplaySlotId,
  sequence: 1,
  expectedDelayMs: 0,
  createdAtMs: 1,
  updatedAtMs: 1,
};

const game: StoredEventCatalogGame = {
  eventGameId: scope.eventGameId,
  eventId: scope.eventId,
  gameDayId: scope.gameDayId,
  gameplaySlotId: gameplaySlot.gameplaySlotId,
  pitchSlotId: pitchSlot.pitchSlotId,
  gameCode: null,
  gameDesignation: null,
  sideA: {
    sideId: "side-a",
    eventTeamId: null,
    eventTeamName: null,
    sourceLabel: "A",
    confirmedAtMs: null,
  },
  sideB: {
    sideId: "side-b",
    eventTeamId: null,
    eventTeamName: null,
    sourceLabel: "B",
    confirmedAtMs: null,
  },
  createdAtMs: 1,
  updatedAtMs: 1,
};

async function seed(
  storage: FoundationStorage,
  configuration: HeatStoppageConfiguration = "disabled",
) {
  await storage.transaction((transaction) => {
    transaction.insertEvent(event);
    transaction.insertGameDay({ ...gameDay, heatStoppageConfiguration: configuration });
    transaction.insertPitch(pitch);
    transaction.insertGameplaySlot(gameplaySlot);
    transaction.insertPitchSlot(pitchSlot);
    transaction.insertEventGame(game);
  });
}

describe("Heat Stoppage Configuration resolver", () => {
  test("resolves the current enabled or disabled Game Day value only for the exact Event Game scope", async () => {
    const storage = createInMemoryFoundationStorage();
    try {
      await seed(storage, "enabled");
      await storage.transaction((transaction) => {
        expect(resolveHeatStoppageConfiguration(transaction, scope)).toBe("enabled");
        expect(
          resolveHeatStoppageConfiguration(transaction, { ...scope, eventGameId: "other-game" }),
        ).toBeNull();
        expect(
          resolveHeatStoppageConfiguration(transaction, { ...scope, gameDayId: "other-day" }),
        ).toBeNull();
        expect(
          resolveHeatStoppageConfiguration(transaction, { ...scope, eventId: "other-event" }),
        ).toBeNull();
      });
    } finally {
      storage.close();
    }
  });

  test("observes a configuration change and rolls it back with the caller transaction", async () => {
    const storage = createInMemoryFoundationStorage();
    try {
      await seed(storage);
      let failure: unknown;
      try {
        await storage.transaction((transaction) => {
          const current = transaction.listGameDays(scope.eventId)[0];
          if (current === undefined) throw new Error("Expected the fixture Game Day.");
          transaction.updateGameDay({ ...current, heatStoppageConfiguration: "enabled" });
          expect(resolveHeatStoppageConfiguration(transaction, scope)).toBe("enabled");
          throw new Error("rollback fixture");
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("rollback fixture");
      await storage.transaction((transaction) => {
        expect(resolveHeatStoppageConfiguration(transaction, scope)).toBe("disabled");
      });
    } finally {
      storage.close();
    }
  });

  test("fails closed for malformed, missing, and unavailable scope state", async () => {
    const storage = createInMemoryFoundationStorage();
    try {
      await seed(storage);
      await storage.transaction((transaction) => {
        const malformedSnapshot = {
          ...transaction,
          listGameDays: () => [{ ...gameDay, heatStoppageConfiguration: "maybe" }],
        } as unknown as FoundationStorageSnapshot;
        expect(resolveHeatStoppageConfiguration(malformedSnapshot, scope)).toBeNull();
      });

      await storage.transaction((transaction) => {
        expect(resolveHeatStoppageConfiguration(transaction, { ...scope, eventId: 42 })).toBeNull();
      });

      const unavailable = {
        listGameDays: () => {
          throw new Error("unavailable");
        },
      } as never;
      expect(resolveHeatStoppageConfiguration(unavailable, scope)).toBeNull();
    } finally {
      storage.close();
    }
  });
});

describe("Heat Stoppage Configuration SQLite persistence", () => {
  test("upgrades after migration 029, reopens with parity, and preserves rollback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-timer-heat-config-"));
    const databasePath = join(directory, "foundation.sqlite");
    const before = openSqliteFoundationStorage(databasePath, {
      migrations: FOUNDATION_MIGRATIONS.slice(0, -1) as readonly FoundationMigration[],
    });
    await before.applyMigrations();
    before.close();
    const legacy = new Database(databasePath);
    legacy
      .query(
        `INSERT INTO foundation_event_catalog_events
          (event_id, name, time_zone, publication_status, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("legacy-event", "Legacy Event", "UTC", "unpublished", 1, 1);
    legacy
      .query(
        `INSERT INTO foundation_event_catalog_game_days
          (game_day_id, event_id, game_day_date, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("legacy-day", "legacy-event", "2026-08-15", 1, 1);
    legacy.close();

    const storage = openSqliteFoundationStorage(databasePath);
    try {
      const migration = await storage.applyMigrations();
      expect(migration.appliedMigrationIds).toEqual(["030-heat-stoppage-configuration"]);
      await storage.transaction((transaction) => {
        expect(transaction.listGameDays("legacy-event")).toMatchObject([
          { gameDayId: "legacy-day", heatStoppageConfiguration: "disabled" },
        ]);
      });
      await seed(storage, "enabled");
      await storage.transaction((transaction) => {
        expect(resolveHeatStoppageConfiguration(transaction, scope)).toBe("enabled");
      });
      let failure: unknown;
      try {
        await storage.transaction((transaction) => {
          const current = transaction.listGameDays(scope.eventId)[0];
          if (current === undefined) throw new Error("Expected the fixture Game Day.");
          transaction.updateGameDay({ ...current, heatStoppageConfiguration: "disabled" });
          throw new Error("sqlite rollback fixture");
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("sqlite rollback fixture");
      await storage.transaction((transaction) => {
        expect(resolveHeatStoppageConfiguration(transaction, scope)).toBe("enabled");
      });
    } finally {
      storage.close();
      const reopened = openSqliteFoundationStorage(databasePath);
      try {
        await reopened.transaction((transaction) => {
          expect(resolveHeatStoppageConfiguration(transaction, scope)).toBe("enabled");
        });
      } finally {
        reopened.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
});
