import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventCatalog, createFoundationEventCatalogStorage } from "@/lib/event-catalog";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import {
  MemoryTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
} from "@/lib/technical-admin-auth";

const authority = createTechnicalAdminAuth(
  { environment: "test", origin: "https://timer.example", rpId: "timer.example" },
  new MemoryTechnicalAdminAuthRepository(),
).resolveHostLocalAuthority();

describe("SQLite Event schedule adapter", () => {
  test("round-trips ordered Slots and unresolved Event Games", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-timer-schedule-"));
    const storage = openSqliteFoundationStorage(join(directory, "foundation.sqlite"));
    try {
      await storage.applyMigrations();
      let nextId = 0;
      const catalog = createEventCatalog(createFoundationEventCatalogStorage(storage), {
        clock: { nowMs: () => 1_000 },
        ids: { next: (kind) => `${kind}-${++nextId}` },
      });
      const event = await catalog.createEvent(
        { name: "SQLite Schedule", timeZone: "UTC" },
        authority,
      );
      if (event.status !== "accepted") throw new Error("Expected Event.");
      const day = await catalog.addGameDay(event.value.eventId, { date: "2026-08-14" }, authority);
      if (day.status !== "accepted") throw new Error("Expected Game Day.");
      const pitch = await catalog.createPitch(event.value.eventId, { name: "Pitch A" }, authority);
      if (pitch.status !== "accepted") throw new Error("Expected Pitch.");
      const firstTeam = await catalog.createEventTeam(
        event.value.eventId,
        { name: "Blue" },
        authority,
      );
      const secondTeam = await catalog.createEventTeam(
        event.value.eventId,
        { name: "Red" },
        authority,
      );
      if (firstTeam.status !== "accepted" || secondTeam.status !== "accepted")
        throw new Error("Expected Event Teams.");
      const slot = await catalog.createGameplaySlot(
        event.value.eventId,
        day.value.gameDayId,
        { sequence: 1, scheduledStart: "2026-08-14T10:00" },
        authority,
      );
      if (slot.status !== "accepted") throw new Error("Expected Gameplay Slot.");
      const snapshot = await storage.transaction((transaction) =>
        transaction.listPitchSlots(day.value.gameDayId),
      );
      const pitchSlot = snapshot[0];
      if (pitchSlot === undefined) throw new Error("Expected Pitch Slot.");
      const game = await catalog.createEventGame(
        event.value.eventId,
        day.value.gameDayId,
        {
          gameplaySlotId: slot.value.gameplaySlotId,
          pitchSlotId: pitchSlot.pitchSlotId,
          sideA: { sourceLabel: "Winner A" },
          sideB: { sourceLabel: "Winner B" },
        },
        authority,
      );
      expect(game).toMatchObject({ status: "accepted" });
      if (game.status !== "accepted") throw new Error("Expected Event Game.");
      expect(
        await catalog.confirmGameplaySlotTeams(
          event.value.eventId,
          day.value.gameDayId,
          slot.value.gameplaySlotId,
          {
            games: [
              {
                eventGameId: game.value.eventGameId,
                sideAEventTeamId: firstTeam.value.eventTeamId,
                sideBEventTeamId: secondTeam.value.eventTeamId,
              },
            ],
          },
          authority,
        ),
      ).toMatchObject({ status: "accepted", value: [{ sideA: { eventTeamName: "Blue" } }] });
      expect(
        await catalog.updateEventTeam(
          event.value.eventId,
          firstTeam.value.eventTeamId,
          { name: "Blue Renamed" },
          authority,
        ),
      ).toMatchObject({ status: "accepted" });
      const laterSlot = await catalog.createGameplaySlot(
        event.value.eventId,
        day.value.gameDayId,
        { sequence: 2, scheduledStart: "2026-08-14T11:00" },
        authority,
      );
      if (laterSlot.status !== "accepted") throw new Error("Expected later Gameplay Slot.");
      const laterPitchSlot = (
        await storage.transaction((transaction) =>
          transaction.listPitchSlots(day.value.gameDayId, pitch.value.pitchId),
        )
      ).find((candidate) => candidate.gameplaySlotId === laterSlot.value.gameplaySlotId);
      if (laterPitchSlot === undefined) throw new Error("Expected later Pitch Slot.");
      const laterGame = await catalog.createEventGame(
        event.value.eventId,
        day.value.gameDayId,
        {
          gameplaySlotId: laterSlot.value.gameplaySlotId,
          pitchSlotId: laterPitchSlot.pitchSlotId,
          sideA: { sourceLabel: "Later A" },
          sideB: { sourceLabel: "Later B" },
        },
        authority,
      );
      if (laterGame.status !== "accepted") throw new Error("Expected later Event Game.");
      expect(
        await catalog.confirmGameplaySlotTeams(
          event.value.eventId,
          day.value.gameDayId,
          laterSlot.value.gameplaySlotId,
          {
            games: [
              {
                eventGameId: laterGame.value.eventGameId,
                sideAEventTeamId: firstTeam.value.eventTeamId,
                sideBEventTeamId: secondTeam.value.eventTeamId,
              },
            ],
          },
          authority,
        ),
      ).toMatchObject({ status: "accepted" });
      expect(
        await catalog.setGameplaySlotExpectedDelay(
          event.value.eventId,
          day.value.gameDayId,
          slot.value.gameplaySlotId,
          { expectedDelayMs: 60_000 },
          authority,
        ),
      ).toMatchObject({ status: "accepted" });
      expect(
        await catalog.setPitchSlotExpectedDelay(
          event.value.eventId,
          day.value.gameDayId,
          pitchSlot.pitchSlotId,
          { expectedDelayMs: 120_000 },
          authority,
        ),
      ).toMatchObject({ status: "accepted" });
      expect(
        await catalog.reassignEventGame(
          event.value.eventId,
          day.value.gameDayId,
          laterGame.value.eventGameId,
          { targetPitchSlotId: pitchSlot.pitchSlotId, mode: "move" },
          authority,
        ),
      ).toMatchObject({ status: "accepted", value: { scheduleConflict: true } });
      storage.close();
      const reopened = openSqliteFoundationStorage(join(directory, "foundation.sqlite"));
      try {
        const restartedCatalog = createEventCatalog(createFoundationEventCatalogStorage(reopened), {
          clock: { nowMs: () => 2_000 },
        });
        const restarted = await restartedCatalog.inspectEvent(event.value.eventId, authority);
        expect(restarted).toMatchObject({ status: "accepted" });
        if (restarted.status === "accepted") {
          const restartedFirstSlot = restarted.value.gameplaySlots.find(
            (candidate) => candidate.gameplaySlotId === slot.value.gameplaySlotId,
          );
          const restartedFirstPitchSlot = restarted.value.pitchSlots.find(
            (candidate) => candidate.pitchSlotId === pitchSlot.pitchSlotId,
          );
          const restartedLater = restarted.value.eventGames.find(
            (candidate) => candidate.eventGameId === laterGame.value.eventGameId,
          );
          expect(restartedFirstSlot).toMatchObject({ expectedDelayMs: 60_000 });
          expect(restartedFirstPitchSlot).toMatchObject({ expectedDelayMs: 120_000 });
          expect(restartedLater).toMatchObject({
            pitchSlotId: pitchSlot.pitchSlotId,
            scheduleConflict: true,
            teamScheduleConflict: true,
          });
        }
      } finally {
        reopened.close();
      }
    } finally {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
