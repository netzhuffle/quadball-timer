import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDeterministicTestIqaInterpreter,
  type ControlActionInput,
} from "@/lib/event-game-actions";
import { createEventGameRecord } from "@/lib/event-game-record";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
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

  test("persists Team roster corrections and stable Pitches across restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-event-teams-pitches-"));
    const databasePath = join(directory, "catalog.sqlite");
    let idCounter = 0;
    const options = {
      clock: { nowMs: () => Date.UTC(2026, 7, 14, 12) },
      ids: {
        next: (kind: "event" | "game-day" | "audit" | "operation") =>
          `${kind}-teams-${++idCounter}`,
      },
    };
    try {
      const foundation = openSqliteFoundationStorage(databasePath);
      await foundation.applyMigrations();
      const catalog = createEventCatalog(createFoundationEventCatalogStorage(foundation), options);
      const event = await catalog.createEvent({ name: "Roster Event", timeZone: "UTC" }, authority);
      if (event.status !== "accepted") throw new Error("Expected Event.");
      const team = await catalog.createEventTeam(event.value.eventId, { name: "Blue" }, authority);
      if (team.status !== "accepted") throw new Error("Expected Team.");
      expect(
        await catalog.lookupAudienceRoster(event.value.eventId, team.value.eventTeamId, 12),
      ).toMatchObject({
        status: "accepted",
        value: { playerNumber: 12, publicName: null },
      });
      await catalog.upsertEventTeamRoster(
        event.value.eventId,
        team.value.eventTeamId,
        { playerNumber: 12, publicName: "Before" },
        authority,
      );
      expect(
        await catalog.lookupAudienceRoster(event.value.eventId, team.value.eventTeamId, 12),
      ).toMatchObject({ status: "accepted", value: { publicName: "Before" } });
      const pitch = await catalog.createPitch(
        event.value.eventId,
        { name: "Pitch One" },
        authority,
      );
      if (pitch.status !== "accepted") throw new Error("Expected Pitch.");
      await catalog.upsertEventTeamRoster(
        event.value.eventId,
        team.value.eventTeamId,
        { playerNumber: 12, publicName: "After" },
        authority,
      );
      expect(
        await catalog.lookupAudienceRoster(event.value.eventId, team.value.eventTeamId, 12),
      ).toMatchObject({ status: "accepted", value: { publicName: "After" } });
      foundation.close();

      const reopenedFoundation = openSqliteFoundationStorage(databasePath);
      const reopened = createEventCatalog(
        createFoundationEventCatalogStorage(reopenedFoundation),
        options,
      );
      const inspected = await reopened.inspectEvent(event.value.eventId, authority);
      expect(inspected).toMatchObject({
        status: "accepted",
        value: {
          teams: [{ eventTeamId: team.value.eventTeamId, roster: [{ publicName: "After" }] }],
          pitches: [{ pitchId: pitch.value.pitchId, name: "Pitch One" }],
        },
      });
      const audit = await reopened.listAuditTrail(event.value.eventId, authority);
      expect(audit).toMatchObject({ status: "accepted" });
      if (audit.status !== "accepted") return;
      expect(audit.value.map((entry) => entry.action).sort()).toEqual([
        "event-created",
        "event-team-created",
        "pitch-created",
        "roster-updated",
        "roster-updated",
      ]);
      reopenedFoundation.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("covers the deterministic two-Day, six-Pitch, 96-Game production envelope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-event-envelope-"));
    const foundation = openSqliteFoundationStorage(join(directory, "catalog.sqlite"));
    await foundation.applyMigrations();
    try {
      const catalog = createEventCatalog(createFoundationEventCatalogStorage(foundation), {
        clock: { nowMs: () => Date.UTC(2026, 7, 14, 12) },
      });
      const event = await catalog.createEvent(
        { name: "Envelope Event", timeZone: "UTC" },
        authority,
      );
      if (event.status !== "accepted") throw new Error("Expected Event.");
      const days = [];
      for (const date of ["2026-08-14", "2026-08-15"]) {
        const day = await catalog.addGameDay(event.value.eventId, { date }, authority);
        if (day.status !== "accepted") throw new Error("Expected Game Day.");
        days.push(day.value);
      }
      for (let pitchIndex = 1; pitchIndex <= 6; pitchIndex += 1) {
        const pitch = await catalog.createPitch(
          event.value.eventId,
          { name: `Pitch ${pitchIndex}` },
          authority,
        );
        if (pitch.status !== "accepted") throw new Error("Expected Pitch.");
      }

      let gameCount = 0;
      for (const [dayIndex, day] of days.entries()) {
        for (let sequence = 1; sequence <= 8; sequence += 1) {
          const slot = await catalog.createGameplaySlot(
            event.value.eventId,
            day.gameDayId,
            {
              sequence,
              scheduledStart: `2026-08-${14 + dayIndex}T${String(10 + sequence).padStart(2, "0")}:00`,
            },
            authority,
          );
          if (slot.status !== "accepted") throw new Error("Expected Gameplay Slot.");
          const pitchSlots = await foundation.transaction((transaction) =>
            transaction.listPitchSlots(day.gameDayId),
          );
          for (const pitchSlot of pitchSlots.filter(
            (candidate) => candidate.gameplaySlotId === slot.value.gameplaySlotId,
          )) {
            const game = await catalog.createEventGame(
              event.value.eventId,
              day.gameDayId,
              {
                gameplaySlotId: slot.value.gameplaySlotId,
                pitchSlotId: pitchSlot.pitchSlotId,
                gameCode: `D${dayIndex + 1}-G${gameCount + 1}`,
                sideA: { sourceLabel: "Winner A" },
                sideB: { sourceLabel: "Winner B" },
              },
              authority,
            );
            if (game.status !== "accepted") throw new Error("Expected Event Game.");
            gameCount += 1;
          }
        }
      }

      const projection = await catalog.inspectEvent(event.value.eventId, authority);
      expect(projection.status).toBe("accepted");
      if (projection.status !== "accepted") return;
      expect(gameCount).toBe(96);
      expect(projection.value.gameDays).toHaveLength(2);
      expect(projection.value.gameDays.map((day) => day.date).sort()).toEqual([
        "2026-08-14",
        "2026-08-15",
      ]);
      expect(projection.value.pitches).toHaveLength(6);
      expect(projection.value.pitches.map((pitch) => pitch.name).sort()).toEqual([
        "Pitch 1",
        "Pitch 2",
        "Pitch 3",
        "Pitch 4",
        "Pitch 5",
        "Pitch 6",
      ]);
      expect(projection.value.pitchSlots).toHaveLength(96);
      expect(projection.value.eventGames).toHaveLength(96);
      expect(projection.value.eventGames.every((game) => !game.scheduleConflict)).toBe(true);
    } finally {
      foundation.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("removes an eligible Team through the SQLite catalog transaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-event-catalog-removal-"));
    const foundation = openSqliteFoundationStorage(join(directory, "catalog.sqlite"));
    await foundation.applyMigrations();
    try {
      const catalog = createEventCatalog(createFoundationEventCatalogStorage(foundation), {
        clock: { nowMs: () => Date.UTC(2026, 7, 14, 12) },
      });
      const event = await catalog.createEvent(
        { name: "Removal Event", timeZone: "UTC" },
        authority,
      );
      if (event.status !== "accepted") throw new Error("Expected Event.");
      const team = await catalog.createEventTeam(event.value.eventId, { name: "Blue" }, authority);
      if (team.status !== "accepted") throw new Error("Expected Team.");
      const preview = await catalog.previewEventCatalogRemoval(
        { kind: "event-team", eventId: event.value.eventId, targetId: team.value.eventTeamId },
        authority,
      );
      expect(preview).toMatchObject({ status: "accepted", value: { eligible: true } });
      if (preview.status !== "accepted") return;
      expect(
        await foundation.transaction((transaction) =>
          catalog.runMutationInTransaction(
            transaction,
            event.value.eventId,
            "technical-admin:test",
            (operations) =>
              operations.removeEventCatalogEntry(
                {
                  kind: "event-team",
                  eventId: event.value.eventId,
                  targetId: team.value.eventTeamId,
                },
                preview.value.fingerprint,
                0,
              ),
          ),
        ),
      ).toMatchObject({ status: "accepted", value: { removed: true } });
      expect(await catalog.inspectEvent(event.value.eventId, authority)).toMatchObject({
        status: "accepted",
        value: { teams: [] },
      });
    } finally {
      foundation.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps retained Game Facts unchanged across roster additions and corrections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-event-catalog-facts-"));
    const foundation = openSqliteFoundationStorage(join(directory, "catalog.sqlite"));
    await foundation.applyMigrations();
    try {
      const catalog = createEventCatalog(createFoundationEventCatalogStorage(foundation), {
        clock: { nowMs: () => Date.UTC(2026, 7, 14, 12) },
      });
      const event = await catalog.createEvent({ name: "Facts Event", timeZone: "UTC" }, authority);
      if (event.status !== "accepted") throw new Error("Expected Event.");
      const root = createFactRoot(event.value.eventId);
      const record = createEventGameRecord(foundation, {
        externalScopeResolver: {
          resolve: (scope) => ({ status: "resolved", scope: structuredClone(scope) }),
          resolveEventTeam: () => ({ status: "resolved" }),
        },
        clock: () => 1_000,
        interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
        auditAuthorityVerifier: { verify: () => true },
      });
      expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
      expect(await record.acceptAction(createFactInput(root))).toMatchObject({
        status: "accepted",
      });
      const before = {
        root: await foundation.readRoot(root.recordId),
        actions: await foundation.readActions(root.recordId),
        audits: await foundation.readAuditEntries(root.recordId),
      };
      const team = await catalog.createEventTeam(
        event.value.eventId,
        { name: "Facts Blue" },
        authority,
      );
      if (team.status !== "accepted") throw new Error("Expected Team.");
      await catalog.upsertEventTeamRoster(
        event.value.eventId,
        team.value.eventTeamId,
        { playerNumber: 8, publicName: "Fact Player" },
        authority,
      );
      await catalog.upsertEventTeamRoster(
        event.value.eventId,
        team.value.eventTeamId,
        { playerNumber: 8, publicName: "Corrected Fact Player" },
        authority,
      );
      const after = {
        root: await foundation.readRoot(root.recordId),
        actions: await foundation.readActions(root.recordId),
        audits: await foundation.readAuditEntries(root.recordId),
      };
      expect(after).toEqual(before);
    } finally {
      foundation.close();
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
      eventCatalogStorageCapability: () => durable.eventCatalogStorageCapability(),
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

function createFactRoot(eventId: string): EventGameRecordRoot {
  return {
    recordId: "facts-record",
    eventId,
    eventGameId: "facts-game",
    ownership: { eventId, eventGameId: "facts-game" },
    externalScope: {
      eventId,
      gameDayId: "facts-day",
      pitchId: "facts-pitch",
      pitchSlotId: "facts-slot",
    },
    gameSides: [
      { id: "side-a", eventTeamId: "team-a", teamInterpretationRef: "interpretation-a" },
      { id: "side-b", eventTeamId: "team-b", teamInterpretationRef: "interpretation-b" },
    ],
    lifecycle: {
      phase: "scheduled",
      commencedAtMs: null,
      finishedAtMs: null,
      lockedAtMs: null,
      lockReason: null,
    },
    compatibility: {
      recordVersion: "record-v1",
      schemaVersion: "schema-v1",
      interpreterVersion: "rules-v1",
    },
    creationEvidence: {
      operationId: "register-facts-record",
      actorReference: "event-admin-session-1",
      source: "event-game-registration",
      createdAtMs: 500,
    },
  };
}

function createFactInput(root: EventGameRecordRoot): ControlActionInput {
  return {
    recordId: root.recordId,
    eventGameId: root.eventGameId,
    operationId: "fact-operation",
    kind: { id: "game-fact", version: "1" },
    payload: {
      factId: "fact-one",
      factType: "deterministic-test-fact",
      gameSideId: "side-a",
      gameTimeMs: 1_000,
      data: { kind: "retained" },
    },
    causalPredecessorIds: [],
    occurrence: { trustedAtMs: 1_000, clientOriginAtMs: 1_000, source: "online" },
    grant: { sessionId: "session-1", versionId: "grant-version-1" },
    lifecycle: structuredClone(root.lifecycle),
  };
}
