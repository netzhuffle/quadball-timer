import { describe, expect, test } from "bun:test";
import {
  createEventCatalog,
  createFoundationEventCatalogStorage,
  createInMemoryEventCatalogStorage,
  createUnavailableEventCatalogStorage,
  projectScheduleGames,
  projectExpectedStartMs,
  type EventCatalogStorageSnapshot,
  type EventGame,
  type InMemoryEventCatalogStorage,
} from "@/lib/event-catalog";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import {
  MemoryTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
  type WebAuthnVerifier,
} from "@/lib/technical-admin-auth";

const authority = createTechnicalAdminAuth(
  { environment: "test", origin: "https://timer.example", rpId: "timer.example" },
  new MemoryTechnicalAdminAuthRepository(),
).resolveHostLocalAuthority();
const untrustedAuthority = { kind: "event-admin" } as unknown as typeof authority;

function createFixture(storage: InMemoryEventCatalogStorage = createInMemoryEventCatalogStorage()) {
  let nowMs = Date.UTC(2026, 7, 14, 12);
  let nextId = 0;
  const catalog = createEventCatalog(storage, {
    clock: { nowMs: () => nowMs },
    ids: { next: (kind) => `${kind}-${++nextId}` },
  });
  return {
    catalog,
    advanceTo: (value: number) => (nowMs = value),
    storage,
  };
}

describe("Event operations catalog", () => {
  test("precomputes conflict indexes with the strict legacy overlap result", () => {
    const starts = new Map([
      ["slot-0", 0],
      ["slot-10", 10 * 60_000],
      ["slot-15", 15 * 60_000],
      ["slot-20", 20 * 60_000],
      ["slot-30", 30 * 60_000],
      ["slot-60", 60 * 60_000],
    ]);
    const snapshot = {
      findGameplaySlot(gameplaySlotId: string) {
        const scheduledStartMs = starts.get(gameplaySlotId);
        return scheduledStartMs === undefined
          ? null
          : { gameplaySlotId, scheduledStartMs, expectedDelayMs: 0 };
      },
      findPitchSlot(pitchSlotId: string) {
        const gameplaySlotId = pitchSlotId.split("@")[1];
        return gameplaySlotId === undefined
          ? null
          : { pitchSlotId, gameplaySlotId, expectedDelayMs: 0 };
      },
    } as Pick<EventCatalogStorageSnapshot, "findGameplaySlot" | "findPitchSlot">;
    const game = (
      eventGameId: string,
      slot: string,
      pitch: string,
      teams: readonly [string | null, string | null],
      gameDayId = "day-1",
    ): EventGame =>
      ({
        eventGameId,
        eventId: "event-1",
        gameDayId,
        gameplaySlotId: slot,
        pitchSlotId: `${pitch}@${slot}`,
        gameCode: null,
        gameDesignation: null,
        sideA: { sideId: `${eventGameId}-a`, eventTeamId: teams[0] },
        sideB: { sideId: `${eventGameId}-b`, eventTeamId: teams[1] },
        createdAtMs: 1,
        updatedAtMs: 1,
      }) as EventGame;
    const games = [
      game("multi-a", "slot-0", "pitch-a", ["team-multi", "team-x"]),
      game("multi-b", "slot-10", "pitch-b", ["team-multi", "team-y"]),
      game("multi-c", "slot-20", "pitch-c", ["team-multi", "team-z"]),
      game("touch-a", "slot-0", "pitch-d", ["team-touch", null]),
      game("touch-b", "slot-30", "pitch-e", ["team-touch", null]),
      game("pitch-a", "slot-0", "shared", ["team-p", null]),
      { ...game("pitch-b", "slot-60", "unused", ["team-q", null]), pitchSlotId: "shared@slot-0" },
      game("other-day", "slot-10", "pitch-f", ["team-multi", null], "day-2"),
    ];
    const oldResult = new Map(
      games.map((candidate) => {
        const start = starts.get(candidate.gameplaySlotId) ?? 0;
        const end = start + 30 * 60_000;
        const teamIds = [candidate.sideA.eventTeamId, candidate.sideB.eventTeamId].filter(
          (teamId): teamId is string => teamId !== null,
        );
        return [
          candidate.eventGameId,
          {
            scheduleConflict: games.some(
              (other) =>
                other.eventGameId !== candidate.eventGameId &&
                other.pitchSlotId === candidate.pitchSlotId,
            ),
            teamScheduleConflict: games.some((other) => {
              const otherStart = starts.get(other.gameplaySlotId) ?? 0;
              return (
                other.eventGameId !== candidate.eventGameId &&
                other.gameDayId === candidate.gameDayId &&
                [other.sideA.eventTeamId, other.sideB.eventTeamId].some(
                  (teamId) => teamId !== null && teamIds.includes(teamId),
                ) &&
                otherStart < end &&
                start < otherStart + 30 * 60_000
              );
            }),
          },
        ] as const;
      }),
    );
    const indexBuilds: string[] = [];
    const projected = projectScheduleGames(snapshot, games, {
      onConflictIndexBuilt: (kind) => indexBuilds.push(kind),
    });
    expect(indexBuilds).toEqual(["pitch", "team"]);
    expect(
      new Map(
        projected.map((candidate) => [
          candidate.eventGameId,
          {
            scheduleConflict: candidate.scheduleConflict,
            teamScheduleConflict: candidate.teamScheduleConflict,
          },
        ]),
      ),
    ).toEqual(oldResult);
  });

  test("defaults each new Game Day to disabled Heat Stoppage Configuration", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Heat default Event", timeZone: "UTC" },
      authority,
    );
    if (event.status !== "accepted") return;
    const day = await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-15" },
      authority,
    );
    expect(day).toMatchObject({
      status: "accepted",
      value: { heatStoppageConfiguration: "disabled" },
    });
  });

  test("lets the Technical Admin configure one Game Day and records before/after evidence", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Heat configuration Event", timeZone: "UTC" },
      authority,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    const day = await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-15" },
      authority,
    );
    if (day.status !== "accepted") throw new Error("Expected Game Day.");

    const enabled = await fixture.catalog.setGameDayHeatStoppageConfiguration(
      event.value.eventId,
      day.value.gameDayId,
      { configuration: "enabled" },
      authority,
    );

    expect(enabled).toMatchObject({
      status: "accepted",
      value: { heatStoppageConfiguration: "enabled" },
    });
    const inspected = await fixture.catalog.inspectEvent(event.value.eventId, authority);
    expect(inspected.status).toBe("accepted");
    if (inspected.status !== "accepted") throw new Error("Expected inspection.");
    expect(inspected.value.gameDays[0]).toMatchObject({
      heatStoppageConfiguration: "enabled",
    });
    expect(inspected.value.auditTrail.at(-1)).toMatchObject({
      action: "game-day-heat-stoppage-configured",
      before: { heatStoppageConfiguration: "disabled" },
      after: { heatStoppageConfiguration: "enabled" },
    });
  });

  test("rejects invalid or cross-Event heat configuration without mutation", async () => {
    const fixture = createFixture();
    const first = await fixture.catalog.createEvent({ name: "One", timeZone: "UTC" }, authority);
    const second = await fixture.catalog.createEvent({ name: "Two", timeZone: "UTC" }, authority);
    if (first.status !== "accepted" || second.status !== "accepted")
      throw new Error("Expected Events.");
    const day = await fixture.catalog.addGameDay(
      first.value.eventId,
      { date: "2026-08-15" },
      authority,
    );
    if (day.status !== "accepted") throw new Error("Expected Game Day.");

    expect(
      await fixture.catalog.setGameDayHeatStoppageConfiguration(
        first.value.eventId,
        day.value.gameDayId,
        { configuration: "maybe" },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });
    expect(
      await fixture.catalog.setGameDayHeatStoppageConfiguration(
        second.value.eventId,
        day.value.gameDayId,
        { configuration: "enabled" },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "cross-event" });
  });

  test("projects one current configuration for multiple uncommenced Event Games", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Multiple Heat Games", timeZone: "UTC" },
      authority,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    const day = await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-15" },
      authority,
    );
    const pitch = await fixture.catalog.createPitch(
      event.value.eventId,
      { name: "Heat Pitch" },
      authority,
    );
    if (day.status !== "accepted" || pitch.status !== "accepted")
      throw new Error("Expected schedule structure.");
    const firstSlot = await fixture.catalog.createGameplaySlot(
      event.value.eventId,
      day.value.gameDayId,
      { sequence: 1, scheduledStart: "2026-08-15T10:00" },
      authority,
    );
    const secondSlot = await fixture.catalog.createGameplaySlot(
      event.value.eventId,
      day.value.gameDayId,
      { sequence: 2, scheduledStart: "2026-08-15T11:00" },
      authority,
    );
    if (firstSlot.status !== "accepted" || secondSlot.status !== "accepted")
      throw new Error("Expected Gameplay Slots.");
    const pitchSlots = await fixture.storage
      .snapshot()
      .then((snapshot) => snapshot.listPitchSlots(day.value.gameDayId, pitch.value.pitchId));
    const firstPitchSlot = pitchSlots.find(
      (slot) => slot.gameplaySlotId === firstSlot.value.gameplaySlotId,
    );
    const secondPitchSlot = pitchSlots.find(
      (slot) => slot.gameplaySlotId === secondSlot.value.gameplaySlotId,
    );
    if (firstPitchSlot === undefined || secondPitchSlot === undefined)
      throw new Error("Expected one Pitch Slot per Gameplay Slot.");
    const firstGame = await fixture.catalog.createEventGame(
      event.value.eventId,
      day.value.gameDayId,
      {
        gameplaySlotId: firstSlot.value.gameplaySlotId,
        pitchSlotId: firstPitchSlot.pitchSlotId,
        gameCode: "HEAT-A",
        sideA: { sourceLabel: "A" },
        sideB: { sourceLabel: "B" },
      },
      authority,
    );
    const secondGame = await fixture.catalog.createEventGame(
      event.value.eventId,
      day.value.gameDayId,
      {
        gameplaySlotId: secondSlot.value.gameplaySlotId,
        pitchSlotId: secondPitchSlot.pitchSlotId,
        gameCode: "HEAT-B",
        sideA: { sourceLabel: "C" },
        sideB: { sourceLabel: "D" },
      },
      authority,
    );
    if (firstGame.status !== "accepted" || secondGame.status !== "accepted")
      throw new Error("Expected Event Games.");

    const configured = await fixture.catalog.setGameDayHeatStoppageConfiguration(
      event.value.eventId,
      day.value.gameDayId,
      { configuration: "enabled" },
      authority,
    );
    expect(configured).toMatchObject({
      status: "accepted",
      value: { heatStoppageConfiguration: "enabled" },
    });
    const inspected = await fixture.catalog.inspectEvent(event.value.eventId, authority);
    expect(inspected).toMatchObject({
      status: "accepted",
      value: {
        gameDays: [{ gameDayId: day.value.gameDayId, heatStoppageConfiguration: "enabled" }],
        eventGames: [
          { eventGameId: firstGame.value.eventGameId, gameDayId: day.value.gameDayId },
          { eventGameId: secondGame.value.eventGameId, gameDayId: day.value.gameDayId },
        ],
      },
    });
  });

  test("rolls back Game Day configuration, audit, and projection on an atomic failure", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Atomic Heat Failure", timeZone: "UTC" },
      authority,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    const day = await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-15" },
      authority,
    );
    if (day.status !== "accepted") throw new Error("Expected Game Day.");
    const before = await fixture.catalog.inspectEvent(event.value.eventId, authority);
    fixture.storage.failNextTransaction(new Error("injected heat configuration failure"));

    expect(
      await fixture.catalog.setGameDayHeatStoppageConfiguration(
        event.value.eventId,
        day.value.gameDayId,
        { configuration: "enabled" },
        authority,
      ),
    ).toMatchObject({ status: "retryable-failure" });
    expect(await fixture.catalog.inspectEvent(event.value.eventId, authority)).toEqual(before);
  });

  test("projects Expected Start from the greater Gameplay and Pitch Slot delay", () => {
    expect(
      projectExpectedStartMs(
        { scheduledStartMs: Date.parse("2026-08-14T10:00:00Z"), expectedDelayMs: 5 * 60_000 },
        { expectedDelayMs: 20 * 60_000 },
      ),
    ).toBe(Date.parse("2026-08-14T10:20:00Z"));
  });

  test("requires the complete Event Catalog adapter capability at composition", () => {
    const foundation = createInMemoryFoundationStorage();
    const incomplete = new Proxy(foundation, {
      get(target, property, receiver) {
        if (property === "eventCatalogStorageCapability") return undefined;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => createFoundationEventCatalogStorage(incomplete)).toThrow("Event Catalog contract");
    foundation.close();
  });

  test("keeps an unavailable catalog subsystem composable and fail-closed", async () => {
    const catalog = createEventCatalog(
      createUnavailableEventCatalogStorage("foundation readiness failed"),
      {},
    );
    expect(await catalog.listEvents(authority)).toMatchObject({
      status: "retryable-failure",
    });
  });

  test("covers eligibility and representative references for every catalog removal target kind", async () => {
    const fixture = createFixture();
    const emptyEvent = await fixture.catalog.createEvent(
      { name: "Empty removal Event", timeZone: "UTC" },
      authority,
    );
    expect(emptyEvent).toMatchObject({ status: "accepted" });
    if (emptyEvent.status !== "accepted") return;
    expect(
      await fixture.catalog.previewEventCatalogRemoval(
        { kind: "event", eventId: emptyEvent.value.eventId, targetId: emptyEvent.value.eventId },
        authority,
      ),
    ).toMatchObject({ status: "accepted", value: { eligible: true } });
    const event = await fixture.catalog.createEvent(
      { name: "Removal Matrix", timeZone: "UTC" },
      authority,
    );
    expect(event.status).toBe("accepted");
    if (event.status !== "accepted") return;
    const foreignEvent = await fixture.catalog.createEvent(
      { name: "Foreign removal Event", timeZone: "UTC" },
      authority,
    );
    if (foreignEvent.status !== "accepted") return;
    const foreignTeam = await fixture.catalog.createEventTeam(
      foreignEvent.value.eventId,
      { name: "Foreign Team" },
      authority,
    );
    if (foreignTeam.status !== "accepted") return;
    expect(
      await fixture.catalog.previewEventCatalogRemoval(
        {
          kind: "event-team",
          eventId: event.value.eventId,
          targetId: foreignTeam.value.eventTeamId,
        },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "not-found" });
    const scheduledDay = await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-14" },
      authority,
    );
    const emptyDay = await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-15" },
      authority,
    );
    const slotOnlyDay = await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-16" },
      authority,
    );
    if (
      scheduledDay.status !== "accepted" ||
      emptyDay.status !== "accepted" ||
      slotOnlyDay.status !== "accepted"
    )
      return;
    const rosteredTeam = await fixture.catalog.createEventTeam(
      event.value.eventId,
      { name: "Rostered" },
      authority,
    );
    const emptyTeam = await fixture.catalog.createEventTeam(
      event.value.eventId,
      { name: "Empty Team" },
      authority,
    );
    if (rosteredTeam.status !== "accepted" || emptyTeam.status !== "accepted") return;
    await fixture.catalog.upsertEventTeamRoster(
      event.value.eventId,
      rosteredTeam.value.eventTeamId,
      { playerNumber: 1, publicName: "Player" },
      authority,
    );
    expect(
      await fixture.catalog.previewEventCatalogRemoval(
        {
          kind: "event-team",
          eventId: event.value.eventId,
          targetId: rosteredTeam.value.eventTeamId,
        },
        authority,
      ),
    ).toMatchObject({
      status: "accepted",
      value: { eligible: false, rejectionCategory: "referenced" },
    });
    expect(
      await fixture.catalog.previewEventCatalogRemoval(
        { kind: "event-team", eventId: event.value.eventId, targetId: emptyTeam.value.eventTeamId },
        authority,
      ),
    ).toMatchObject({ status: "accepted", value: { eligible: true } });

    const scheduledPitch = await fixture.catalog.createPitch(
      event.value.eventId,
      { name: "Scheduled Pitch" },
      authority,
    );
    const sparePitch = await fixture.catalog.createPitch(
      event.value.eventId,
      { name: "Spare Pitch" },
      authority,
    );
    if (scheduledPitch.status !== "accepted") return;
    const scheduledSlot = await fixture.catalog.createGameplaySlot(
      event.value.eventId,
      scheduledDay.value.gameDayId,
      { sequence: 1, scheduledStart: "2026-08-14T10:00" },
      authority,
    );
    const slotOnlyEvent = await fixture.catalog.createEvent(
      { name: "Gameplay-only removal Event", timeZone: "UTC" },
      authority,
    );
    if (slotOnlyEvent.status !== "accepted") return;
    const slotOnlyEventDay = await fixture.catalog.addGameDay(
      slotOnlyEvent.value.eventId,
      { date: "2026-08-16" },
      authority,
    );
    if (slotOnlyEventDay.status !== "accepted") return;
    const eligibleGameplaySlot = await fixture.catalog.createGameplaySlot(
      slotOnlyEvent.value.eventId,
      slotOnlyEventDay.value.gameDayId,
      { sequence: 1, scheduledStart: "2026-08-16T10:00" },
      authority,
    );
    if (
      scheduledSlot.status !== "accepted" ||
      eligibleGameplaySlot.status !== "accepted" ||
      sparePitch.status !== "accepted"
    )
      return;
    const pitchSlots = await fixture.storage.snapshot();
    const scheduledPitchSlot = pitchSlots.listPitchSlots(
      scheduledDay.value.gameDayId,
      scheduledPitch.value.pitchId,
    )[0];
    const emptyPitchSlot = pitchSlots.listPitchSlots(
      scheduledDay.value.gameDayId,
      sparePitch.value.pitchId,
    )[0];
    if (scheduledPitchSlot === undefined || emptyPitchSlot === undefined) return;
    const eventGame = await fixture.catalog.createEventGame(
      event.value.eventId,
      scheduledDay.value.gameDayId,
      {
        gameplaySlotId: scheduledSlot.value.gameplaySlotId,
        pitchSlotId: scheduledPitchSlot.pitchSlotId,
        sideA: { sourceLabel: "A" },
        sideB: { sourceLabel: "B" },
      },
      authority,
    );
    if (eventGame.status !== "accepted") return;

    const preview = async (
      kind: "game-day" | "pitch" | "gameplay-slot" | "pitch-slot" | "event-game",
      targetId: string,
    ) =>
      fixture.catalog.previewEventCatalogRemoval(
        { kind, eventId: event.value.eventId, targetId },
        authority,
      );
    expect(await preview("game-day", emptyDay.value.gameDayId)).toMatchObject({
      status: "accepted",
      value: { eligible: true },
    });
    expect(await preview("game-day", scheduledDay.value.gameDayId)).toMatchObject({
      status: "accepted",
      value: { eligible: false, rejectionCategory: "referenced" },
    });
    const pitchOnlyEvent = await fixture.catalog.createEvent(
      { name: "Pitch-only removal Event", timeZone: "UTC" },
      authority,
    );
    if (pitchOnlyEvent.status !== "accepted") return;
    const emptyPitch = await fixture.catalog.createPitch(
      pitchOnlyEvent.value.eventId,
      { name: "Empty Pitch" },
      authority,
    );
    if (emptyPitch.status !== "accepted") return;
    expect(
      await fixture.catalog.previewEventCatalogRemoval(
        {
          kind: "pitch",
          eventId: pitchOnlyEvent.value.eventId,
          targetId: emptyPitch.value.pitchId,
        },
        authority,
      ),
    ).toMatchObject({
      status: "accepted",
      value: { eligible: true },
    });
    expect(await preview("pitch", scheduledPitch.value.pitchId)).toMatchObject({
      status: "accepted",
      value: { eligible: false, rejectionCategory: "referenced" },
    });
    expect(
      await fixture.catalog.previewEventCatalogRemoval(
        {
          kind: "gameplay-slot",
          eventId: slotOnlyEvent.value.eventId,
          targetId: eligibleGameplaySlot.value.gameplaySlotId,
        },
        authority,
      ),
    ).toMatchObject({ status: "accepted", value: { eligible: true } });
    expect(await preview("gameplay-slot", scheduledSlot.value.gameplaySlotId)).toMatchObject({
      status: "accepted",
      value: { eligible: false, rejectionCategory: "referenced" },
    });
    expect(await preview("pitch-slot", emptyPitchSlot.pitchSlotId)).toMatchObject({
      status: "accepted",
      value: { eligible: true },
    });
    expect(await preview("pitch-slot", scheduledPitchSlot.pitchSlotId)).toMatchObject({
      status: "accepted",
      value: { eligible: false, rejectionCategory: "referenced" },
    });
    expect(await preview("event-game", eventGame.value.eventGameId)).toMatchObject({
      status: "accepted",
      value: {
        eligible: true,
        impact: { retainedEventGameCount: 0, retainedControlActionCount: 0 },
      },
    });
  });

  test("fails closed for commenced and accepted-action Event Game roots", async () => {
    const foundation = createInMemoryFoundationStorage();
    const catalog = createEventCatalog(createFoundationEventCatalogStorage(foundation), {
      clock: { nowMs: () => Date.UTC(2026, 7, 14, 12) },
    });
    const event = await catalog.createEvent(
      { name: "Lifecycle removal", timeZone: "UTC" },
      authority,
    );
    if (event.status !== "accepted") return;
    const day = await catalog.addGameDay(event.value.eventId, { date: "2026-08-14" }, authority);
    const pitchA = await catalog.createPitch(event.value.eventId, { name: "A" }, authority);
    const pitchB = await catalog.createPitch(event.value.eventId, { name: "B" }, authority);
    if (day.status !== "accepted" || pitchA.status !== "accepted" || pitchB.status !== "accepted")
      return;
    const slot = await catalog.createGameplaySlot(
      event.value.eventId,
      day.value.gameDayId,
      { sequence: 1, scheduledStart: "2026-08-14T10:00" },
      authority,
    );
    if (slot.status !== "accepted") return;
    const pitchSlots = await foundation.transaction((transaction) => ({
      a: transaction.listPitchSlots(day.value.gameDayId, pitchA.value.pitchId)[0],
      b: transaction.listPitchSlots(day.value.gameDayId, pitchB.value.pitchId)[0],
    }));
    if (pitchSlots.a === undefined || pitchSlots.b === undefined) return;
    const commencedGame = await catalog.createEventGame(
      event.value.eventId,
      day.value.gameDayId,
      {
        gameplaySlotId: slot.value.gameplaySlotId,
        pitchSlotId: pitchSlots.a.pitchSlotId,
        sideA: { sourceLabel: "A" },
        sideB: { sourceLabel: "B" },
      },
      authority,
    );
    const actionGame = await catalog.createEventGame(
      event.value.eventId,
      day.value.gameDayId,
      {
        gameplaySlotId: slot.value.gameplaySlotId,
        pitchSlotId: pitchSlots.b.pitchSlotId,
        sideA: { sourceLabel: "C" },
        sideB: { sourceLabel: "D" },
      },
      authority,
    );
    if (commencedGame.status !== "accepted" || actionGame.status !== "accepted") return;
    await foundation.transaction((transaction) => {
      for (const [recordId, eventGameId, pitchId, pitchSlotId, commencedAtMs] of [
        [
          "commenced-record",
          commencedGame.value.eventGameId,
          pitchA.value.pitchId,
          pitchSlots.a!.pitchSlotId,
          1_500,
        ],
        [
          "action-record",
          actionGame.value.eventGameId,
          pitchB.value.pitchId,
          pitchSlots.b!.pitchSlotId,
          null,
        ],
      ] as const) {
        const root = {
          recordId,
          eventId: event.value.eventId,
          eventGameId,
          ownership: { eventId: event.value.eventId, eventGameId },
          externalScope: {
            eventId: event.value.eventId,
            gameDayId: day.value.gameDayId,
            pitchId,
            pitchSlotId,
          },
          gameSides: [],
          lifecycle: {
            phase: commencedAtMs === null ? "scheduled" : "in-progress",
            commencedAtMs,
            finishedAtMs: null,
            lockedAtMs: null,
            lockReason: null,
          },
          compatibility: { recordVersion: "v1", schemaVersion: "v1", interpreterVersion: "v1" },
          creationEvidence: {
            operationId: `operation-${recordId}`,
            actorReference: "test",
            source: "event-game-registration",
            createdAtMs: 1_000,
          },
        } as never;
        transaction.insertRoot({ root, canonicalContent: "{}" });
        if (commencedAtMs === null)
          transaction.insertAction({
            action: { recordId, eventGameId, operationId: "accepted" } as never,
            canonicalContent: "{}",
            contentFingerprint: "accepted-action",
          });
      }
    });
    expect(
      await catalog.previewEventCatalogRemoval(
        {
          kind: "event-game",
          eventId: event.value.eventId,
          targetId: commencedGame.value.eventGameId,
        },
        authority,
      ),
    ).toMatchObject({
      status: "accepted",
      value: { eligible: false, rejectionCategory: "commenced" },
    });
    expect(
      await catalog.previewEventCatalogRemoval(
        {
          kind: "event-game",
          eventId: event.value.eventId,
          targetId: actionGame.value.eventGameId,
        },
        authority,
      ),
    ).toMatchObject({
      status: "accepted",
      value: {
        eligible: false,
        rejectionCategory: "accepted-control-action",
        impact: { retainedEventGameCount: 1, retainedControlActionCount: 1 },
      },
    });
    foundation.close();
  });

  test("creates a blank Unpublished Event and classifies Game Days in the Event timezone", async () => {
    const fixture = createFixture();
    const created = await fixture.catalog.createEvent(
      { name: "SQM 2026", timeZone: "Europe/Zurich" },
      authority,
    );
    expect(created.status).toBe("accepted");
    if (created.status !== "accepted") return;
    expect(created.value).toMatchObject({
      eventId: "event-1",
      name: "SQM 2026",
      timeZone: "Europe/Zurich",
      publicationStatus: "unpublished",
      gameDays: [],
      lifecycle: "unscheduled",
    });

    const days = await fixture.catalog.addGameDay(
      created.value.eventId,
      { date: "2026-08-13" },
      authority,
    );
    expect(days.status).toBe("accepted");
    const second = await fixture.catalog.addGameDay(
      created.value.eventId,
      { date: "2026-08-14" },
      authority,
    );
    expect(second.status).toBe("accepted");
    const third = await fixture.catalog.addGameDay(
      created.value.eventId,
      { date: "2026-08-15" },
      authority,
    );
    expect(third.status).toBe("accepted");

    const inspected = await fixture.catalog.inspectEvent(created.value.eventId, authority);
    expect(inspected.status).toBe("accepted");
    if (inspected.status !== "accepted") return;
    expect(inspected.value.lifecycle).toBe("current");
    expect(inspected.value.gameDays.map((day) => day.classification)).toEqual([
      "past",
      "current",
      "future",
    ]);
  });

  test("publishes with a schedule warning, requires impact confirmation, and keeps private audit evidence", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Publication", timeZone: "UTC" },
      authority,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");

    expect(
      await fixture.catalog.changePublicationStatus(
        event.value.eventId,
        { status: "published" },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });
    await fixture.catalog.addGameDay(event.value.eventId, { date: "2026-08-14" }, authority);
    const published = await fixture.catalog.changePublicationStatus(
      event.value.eventId,
      { status: "published" },
      authority,
    );
    expect(published).toMatchObject({
      status: "accepted",
      value: {
        previousStatus: "unpublished",
        publicationStatus: "published",
        warnings: [
          "missing-event-teams",
          "missing-pitches",
          "missing-gameplay-slots",
          "missing-pitch-slots",
          "missing-event-games",
        ],
        event: { publicationStatus: "published" },
      },
    });
    expect(
      await fixture.catalog.changePublicationStatus(
        event.value.eventId,
        { status: "unpublished" },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });
    expect(
      await fixture.catalog.changePublicationStatus(
        event.value.eventId,
        { status: "unpublished", impactConfirmed: true },
        authority,
      ),
    ).toMatchObject({ status: "accepted", value: { event: { publicationStatus: "unpublished" } } });
    expect(
      await fixture.catalog.changePublicationStatus(
        event.value.eventId,
        { status: "cancelled" },
        authority,
      ),
    ).toMatchObject({ status: "accepted", value: { event: { publicationStatus: "cancelled" } } });

    const audit = await fixture.catalog.listAuditTrail(event.value.eventId, authority);
    if (audit.status !== "accepted") throw new Error("Expected audit trail.");
    const publicationAudits = audit.value.filter(
      (entry) => entry.action === "event-publication-changed",
    );
    expect(publicationAudits).toHaveLength(3);
    const firstPublication = publicationAudits.find(
      (entry) => (entry.after as { publicationStatus?: string }).publicationStatus === "published",
    );
    expect(firstPublication).toMatchObject({
      before: { publicationStatus: "unpublished" },
      after: { publicationStatus: "published" },
    });
    expect(firstPublication?.after).not.toHaveProperty("reason");
  });

  test("rolls back a publication transition when the catalog transaction fails", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent({ name: "Atomic", timeZone: "UTC" }, authority);
    if (event.status !== "accepted") throw new Error("Expected Event.");
    await fixture.catalog.addGameDay(event.value.eventId, { date: "2026-08-14" }, authority);
    fixture.storage.failNextTransaction(new Error("commit failed"));
    expect(
      await fixture.catalog.changePublicationStatus(
        event.value.eventId,
        { status: "published" },
        authority,
      ),
    ).toMatchObject({ status: "retryable-failure" });
    expect(await fixture.catalog.inspectEvent(event.value.eventId, authority)).toMatchObject({
      status: "accepted",
      value: { publicationStatus: "unpublished" },
    });
  });

  test("warns about unresolved matchups after the Event schedule categories exist", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Unresolved", timeZone: "UTC" },
      authority,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    const day = await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-14" },
      authority,
    );
    const pitch = await fixture.catalog.createPitch(
      event.value.eventId,
      { name: "Pitch" },
      authority,
    );
    const blue = await fixture.catalog.createEventTeam(
      event.value.eventId,
      { name: "Blue" },
      authority,
    );
    const red = await fixture.catalog.createEventTeam(
      event.value.eventId,
      { name: "Red" },
      authority,
    );
    if (
      day.status !== "accepted" ||
      pitch.status !== "accepted" ||
      blue.status !== "accepted" ||
      red.status !== "accepted"
    )
      throw new Error("Expected Event schedule setup.");
    const slot = await fixture.catalog.createGameplaySlot(
      event.value.eventId,
      day.value.gameDayId,
      { sequence: 1, scheduledStart: "2026-08-14T10:00" },
      authority,
    );
    if (slot.status !== "accepted") throw new Error("Expected Gameplay Slot.");
    const pitchSlot = (await fixture.storage.snapshot()).listPitchSlots(
      day.value.gameDayId,
      pitch.value.pitchId,
    )[0];
    if (pitchSlot === undefined) throw new Error("Expected Pitch Slot.");
    const game = await fixture.catalog.createEventGame(
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
    if (game.status !== "accepted") throw new Error("Expected Event Game.");
    expect(
      await fixture.catalog.changePublicationStatus(
        event.value.eventId,
        { status: "published" },
        authority,
      ),
    ).toMatchObject({
      status: "accepted",
      value: { warnings: ["unresolved-matchups"] },
    });
  });

  test("only the verified Technical Admin can mutate metadata and Game Days", async () => {
    const fixture = createFixture();
    expect(
      await fixture.catalog.createEvent({ name: "Private", timeZone: "UTC" }, untrustedAuthority),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });

    const created = await fixture.catalog.createEvent(
      { name: "Private", timeZone: "UTC" },
      authority,
    );
    if (created.status !== "accepted") throw new Error("Expected Event creation.");
    expect(
      await fixture.catalog.updateEvent(
        created.value.eventId,
        { name: "Changed" },
        untrustedAuthority,
      ),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
    expect(
      await fixture.catalog.addGameDay(
        created.value.eventId,
        { date: "2026-08-14" },
        untrustedAuthority,
      ),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
  });

  test("rejects forged authority JSON and raw session tokens at the catalog boundary", async () => {
    const fixture = createFixture();
    expect(
      await fixture.catalog.createEvent({ name: "Forged", timeZone: "UTC" }, {
        kind: "technical-admin",
        environment: "test",
        sessionId: "forged",
      } as never),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
    expect(
      await fixture.catalog.createEvent(
        { name: "Raw token", timeZone: "UTC" },
        "raw-session-token" as never,
      ),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
  });

  test("accepts a live authority minted by TechnicalAdminAuth", async () => {
    const binding = { origin: "https://timer.example", host: "timer.example" };
    const verifier: WebAuthnVerifier = {
      async verifyRegistration() {
        return {
          credentialId: "credential-1",
          publicKey: {
            kty: "OKP",
            crv: "Ed25519",
            x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            alg: "EdDSA",
            ext: true,
          },
          signCount: 1,
        };
      },
      async verifyAuthentication() {
        return { signCount: 2 };
      },
    };
    const auth = createTechnicalAdminAuth(
      { environment: "test", origin: binding.origin, rpId: "timer.example" },
      new MemoryTechnicalAdminAuthRepository({
        environment: "test",
        origin: binding.origin,
        rpId: "timer.example",
      }),
      verifier,
      () => 1_000,
    );
    const enrollment = auth.issueEnrollmentAuthorization();
    if (!enrollment.ok) throw new Error("Expected enrollment authorization.");
    const enrollmentToken = decodeURIComponent(enrollment.value.url.split("token=")[1] ?? "");
    const enrollmentOptions = auth.beginEnrollment(enrollmentToken, binding);
    if (!enrollmentOptions.ok) throw new Error("Expected enrollment options.");
    expect(await auth.completeEnrollment(enrollmentOptions.value.challengeId, {}, binding)).toEqual(
      {
        ok: true,
        value: undefined,
      },
    );
    const authenticationOptions = await auth.beginAuthentication(binding);
    if (!authenticationOptions.ok) throw new Error("Expected authentication options.");
    const session = await auth.completeAuthentication(
      authenticationOptions.value.challengeId,
      {},
      binding,
    );
    if (!session.ok) throw new Error("Expected live session.");
    const liveAuthority = auth.resolveCurrentAuthority(session.value.token);
    expect(liveAuthority).not.toBeNull();
    if (liveAuthority === null) return;

    const catalog = createEventCatalog(createInMemoryEventCatalogStorage(), {
      clock: { nowMs: () => 1_000 },
    });
    expect(
      await catalog.createEvent({ name: "Live authority", timeZone: "UTC" }, liveAuthority),
    ).toMatchObject({ status: "accepted" });
  });

  test("classifies the gap between Game Days and a zero-Day Event explicitly", async () => {
    const fixture = createFixture();
    const created = await fixture.catalog.createEvent(
      { name: "Gap", timeZone: "Europe/Zurich" },
      authority,
    );
    if (created.status !== "accepted") throw new Error("Expected Event.");
    const first = await fixture.catalog.addGameDay(
      created.value.eventId,
      { date: "2026-08-13" },
      authority,
    );
    const second = await fixture.catalog.addGameDay(
      created.value.eventId,
      { date: "2026-08-15" },
      authority,
    );
    if (first.status !== "accepted" || second.status !== "accepted") {
      throw new Error("Expected Game Days.");
    }
    const inGap = await fixture.catalog.inspectEvent(created.value.eventId, authority);
    expect(inGap.status).toBe("accepted");
    if (inGap.status !== "accepted") return;
    expect(inGap.value.lifecycle).toBe("future");
    expect(inGap.value.gameDays.map((day) => day.classification)).toEqual(["past", "future"]);

    fixture.advanceTo(Date.UTC(2026, 7, 16, 12));
    const after = await fixture.catalog.inspectEvent(created.value.eventId, authority);
    expect(after.status).toBe("accepted");
    if (after.status !== "accepted") return;
    expect(after.value.lifecycle).toBe("past");
  });

  test("keeps no-change updates out of state timestamps and audit", async () => {
    const fixture = createFixture();
    const created = await fixture.catalog.createEvent(
      { name: "Stable", timeZone: "UTC" },
      authority,
    );
    if (created.status !== "accepted") throw new Error("Expected Event.");
    const day = await fixture.catalog.addGameDay(
      created.value.eventId,
      { date: "2026-08-14" },
      authority,
    );
    if (day.status !== "accepted") throw new Error("Expected Game Day.");
    const before = await fixture.catalog.inspectEvent(created.value.eventId, authority);
    if (before.status !== "accepted") throw new Error("Expected inspection.");

    fixture.advanceTo(Date.UTC(2026, 7, 15, 12));
    expect(
      await fixture.catalog.updateEvent(
        created.value.eventId,
        { name: "Stable", timeZone: "UTC" },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "no-change" });
    expect(
      await fixture.catalog.updateGameDay(
        created.value.eventId,
        day.value.gameDayId,
        { date: "2026-08-14" },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "no-change" });
    const after = await fixture.catalog.inspectEvent(created.value.eventId, authority);
    expect(after.status).toBe("accepted");
    if (after.status !== "accepted") return;
    expect(after.value.createdAtMs).toBe(before.value.createdAtMs);
    expect(after.value.updatedAtMs).toBe(before.value.updatedAtMs);
    expect(after.value.gameDays[0]?.updatedAtMs).toBe(before.value.gameDays[0]?.updatedAtMs);
    expect(after.value.auditTrail).toEqual(before.value.auditTrail);
  });

  test("uses the configured timezone at a DST-relevant date boundary", async () => {
    const fixture = createFixture();
    const created = await fixture.catalog.createEvent(
      { name: "DST", timeZone: "America/New_York" },
      authority,
    );
    if (created.status !== "accepted") throw new Error("Expected Event.");
    const day = await fixture.catalog.addGameDay(
      created.value.eventId,
      { date: "2026-03-08" },
      authority,
    );
    if (day.status !== "accepted") throw new Error("Expected Game Day.");

    fixture.advanceTo(Date.UTC(2026, 2, 8, 4, 59));
    const beforeMidnight = await fixture.catalog.inspectEvent(created.value.eventId, authority);
    expect(beforeMidnight.status).toBe("accepted");
    if (beforeMidnight.status !== "accepted") return;
    expect(beforeMidnight.value.lifecycle).toBe("future");

    fixture.advanceTo(Date.UTC(2026, 2, 8, 5, 0));
    const afterMidnight = await fixture.catalog.inspectEvent(created.value.eventId, authority);
    expect(afterMidnight.status).toBe("accepted");
    if (afterMidnight.status !== "accepted") return;
    expect(afterMidnight.value.lifecycle).toBe("current");
    expect(afterMidnight.value.gameDays[0]?.classification).toBe("current");
  });

  test("rejects duplicates and cross-Event Game Day references without mutation", async () => {
    const fixture = createFixture();
    const first = await fixture.catalog.createEvent({ name: "One", timeZone: "UTC" }, authority);
    const second = await fixture.catalog.createEvent({ name: "Two", timeZone: "UTC" }, authority);
    if (first.status !== "accepted" || second.status !== "accepted") {
      throw new Error("Expected Events.");
    }
    const day = await fixture.catalog.addGameDay(
      first.value.eventId,
      { date: "2026-08-14" },
      authority,
    );
    if (day.status !== "accepted") throw new Error("Expected Game Day.");
    expect(
      await fixture.catalog.addGameDay(first.value.eventId, { date: "2026-08-14" }, authority),
    ).toMatchObject({ status: "rejected", reason: "duplicate" });
    expect(
      await fixture.catalog.updateGameDay(
        second.value.eventId,
        day.value.gameDayId,
        { date: "2026-08-15" },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "cross-event" });
    const inspected = await fixture.catalog.inspectEvent(first.value.eventId, authority);
    expect(inspected.status).toBe("accepted");
    if (inspected.status !== "accepted") return;
    expect(inspected.value.gameDays).toHaveLength(1);
    expect(inspected.value.gameDays[0]?.date).toBe("2026-08-14");
  });

  test("commits catalog state and its Event Administration Audit Trail atomically", async () => {
    const fixture = createFixture();
    const created = await fixture.catalog.createEvent(
      { name: "Atomic", timeZone: "UTC" },
      authority,
    );
    if (created.status !== "accepted") throw new Error("Expected Event creation.");
    const before = await fixture.catalog.inspectEvent(created.value.eventId, authority);
    expect(before.status).toBe("accepted");

    fixture.storage.failNextTransaction(new Error("disk full"));
    expect(
      await fixture.catalog.addGameDay(created.value.eventId, { date: "2026-08-14" }, authority),
    ).toMatchObject({ status: "retryable-failure" });

    const after = await fixture.catalog.inspectEvent(created.value.eventId, authority);
    expect(after.status).toBe("accepted");
    if (after.status !== "accepted") return;
    expect(after.value.gameDays).toHaveLength(0);
    expect(after.value.auditTrail).toHaveLength(1);
  });

  test("configures stable Teams, current public rosters, and Pitches atomically", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent({ name: "Teams", timeZone: "UTC" }, authority);
    const otherEvent = await fixture.catalog.createEvent(
      { name: "Other", timeZone: "UTC" },
      authority,
    );
    if (event.status !== "accepted" || otherEvent.status !== "accepted")
      throw new Error("Expected Events.");

    const team = await fixture.catalog.createEventTeam(
      event.value.eventId,
      { name: "Blue", defaultColor: "#123ABC" },
      authority,
    );
    const pitch = await fixture.catalog.createPitch(
      event.value.eventId,
      { name: "Pitch 1" },
      authority,
    );
    if (team.status !== "accepted" || pitch.status !== "accepted")
      throw new Error("Expected catalog entries.");

    expect(
      await fixture.catalog.lookupAudienceRoster(event.value.eventId, team.value.eventTeamId, 7),
    ).toMatchObject({ status: "accepted", value: { publicName: null } });
    expect(
      await fixture.catalog.upsertEventTeamRoster(
        event.value.eventId,
        team.value.eventTeamId,
        { playerNumber: 7, publicName: "Ada" },
        authority,
      ),
    ).toMatchObject({ status: "accepted", value: { playerNumber: 7, publicName: "Ada" } });
    expect(
      await fixture.catalog.lookupAudienceRoster(event.value.eventId, team.value.eventTeamId, 7),
    ).toMatchObject({ status: "accepted", value: { publicName: "Ada" } });
    await fixture.catalog.upsertEventTeamRoster(
      event.value.eventId,
      team.value.eventTeamId,
      { playerNumber: 7, publicName: "Ada Corrected" },
      authority,
    );
    expect(
      await fixture.catalog.lookupAudienceRoster(event.value.eventId, team.value.eventTeamId, 7),
    ).toMatchObject({ status: "accepted", value: { publicName: "Ada Corrected" } });
    expect(
      await fixture.catalog.updateEventTeam(
        event.value.eventId,
        team.value.eventTeamId,
        { name: "Blue Updated", defaultColor: "#ABCDEF" },
        authority,
      ),
    ).toMatchObject({ status: "accepted", value: { name: "Blue Updated" } });
    expect(
      await fixture.catalog.updatePitch(
        event.value.eventId,
        pitch.value.pitchId,
        { name: "Pitch Updated" },
        authority,
      ),
    ).toMatchObject({ status: "accepted", value: { name: "Pitch Updated" } });
    expect(
      await fixture.catalog.lookupAudienceRoster(
        otherEvent.value.eventId,
        team.value.eventTeamId,
        7,
      ),
    ).toEqual({ status: "accepted", value: { playerNumber: 7, publicName: null } });

    const otherTeam = await fixture.catalog.createEventTeam(
      otherEvent.value.eventId,
      { name: "Other Blue" },
      authority,
    );
    const otherPitch = await fixture.catalog.createPitch(
      otherEvent.value.eventId,
      { name: "Other Pitch" },
      authority,
    );
    if (otherTeam.status !== "accepted" || otherPitch.status !== "accepted")
      throw new Error("Expected isolated entries.");
    expect(
      await fixture.catalog.updateEventTeam(
        event.value.eventId,
        otherTeam.value.eventTeamId,
        { name: "Leaked Team" },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "cross-event" });
    expect(
      await fixture.catalog.updatePitch(
        event.value.eventId,
        otherPitch.value.pitchId,
        { name: "Leaked Pitch" },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "cross-event" });

    expect(
      await fixture.catalog.createEventTeam(
        event.value.eventId,
        { name: "Blue", defaultColor: "red" },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });
    expect(
      await fixture.catalog.upsertEventTeamRoster(
        event.value.eventId,
        team.value.eventTeamId,
        { playerNumber: 100, publicName: "Invalid" },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });
    fixture.storage.failNextTransaction(new Error("audit unavailable"));
    expect(
      await fixture.catalog.updatePitch(
        event.value.eventId,
        pitch.value.pitchId,
        { name: "Pitch A" },
        authority,
      ),
    ).toMatchObject({ status: "retryable-failure" });
    expect(await fixture.catalog.inspectEvent(event.value.eventId, authority)).toMatchObject({
      status: "accepted",
      value: {
        teams: [{ name: "Blue Updated", defaultColor: "#abcdef" }],
        pitches: [{ name: "Pitch Updated" }],
      },
    });
    const audit = await fixture.catalog.listAuditTrail(event.value.eventId, authority);
    expect(audit).toMatchObject({ status: "accepted" });
    if (audit.status !== "accepted") return;
    const rosterAudits = audit.value.filter((entry) => entry.action === "roster-updated");
    expect(rosterAudits).toHaveLength(2);
    expect(rosterAudits[0]).toMatchObject({ before: null, after: { publicName: "Ada" } });
    expect(rosterAudits[1]).toMatchObject({
      before: { publicName: "Ada" },
      after: { publicName: "Ada Corrected" },
    });
    expect(audit.value.find((entry) => entry.action === "event-team-created")).toMatchObject({
      before: null,
      after: { name: "Blue", defaultColor: "#123abc" },
    });
    expect(audit.value.find((entry) => entry.action === "event-team-updated")).toMatchObject({
      before: { name: "Blue", defaultColor: "#123abc" },
      after: { name: "Blue Updated", defaultColor: "#abcdef" },
    });
    expect(audit.value.find((entry) => entry.action === "pitch-created")).toMatchObject({
      before: null,
      after: { name: "Pitch 1" },
    });
    expect(audit.value.find((entry) => entry.action === "pitch-updated")).toMatchObject({
      before: { name: "Pitch 1" },
      after: { name: "Pitch Updated" },
    });
  });

  test("creates ordered Slots, unresolved Event Games, and confirms one Gameplay Slot atomically", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Schedule", timeZone: "UTC" },
      authority,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    const day = await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-14" },
      authority,
    );
    if (day.status !== "accepted") throw new Error("Expected Game Day.");
    const pitch = await fixture.catalog.createPitch(
      event.value.eventId,
      { name: "Pitch 1" },
      authority,
    );
    const firstTeam = await fixture.catalog.createEventTeam(
      event.value.eventId,
      { name: "Blue" },
      authority,
    );
    const secondTeam = await fixture.catalog.createEventTeam(
      event.value.eventId,
      { name: "Red" },
      authority,
    );
    if (
      pitch.status !== "accepted" ||
      firstTeam.status !== "accepted" ||
      secondTeam.status !== "accepted"
    )
      throw new Error("Expected schedule references.");
    const slot = await fixture.catalog.createGameplaySlot(
      event.value.eventId,
      day.value.gameDayId,
      { sequence: 1, scheduledStart: "2026-08-14T09:00" },
      authority,
    );
    if (slot.status !== "accepted") throw new Error("Expected Gameplay Slot.");
    const snapshot = await fixture.storage.snapshot();
    const pitchSlot = snapshot.listPitchSlots(day.value.gameDayId, pitch.value.pitchId)[0];
    if (pitchSlot === undefined) throw new Error("Expected Pitch Slot.");
    const game = await fixture.catalog.createEventGame(
      event.value.eventId,
      day.value.gameDayId,
      {
        gameplaySlotId: slot.value.gameplaySlotId,
        pitchSlotId: pitchSlot.pitchSlotId,
        sideA: { sourceLabel: "Winner QF 1" },
        sideB: { sourceLabel: "Winner QF 2" },
        gameCode: "SF.1",
      },
      authority,
    );
    expect(game).toMatchObject({ status: "accepted", value: { sideA: { eventTeamId: null } } });
    if (game.status !== "accepted") return;
    const confirmed = await fixture.catalog.confirmGameplaySlotTeams(
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
    );
    expect(confirmed).toMatchObject({
      status: "accepted",
      value: [{ sideA: { eventTeamId: firstTeam.value.eventTeamId, eventTeamName: "Blue" } }],
    });
    const auditBeforeNoChange = await fixture.catalog.listAuditTrail(
      event.value.eventId,
      authority,
    );
    const renamed = await fixture.catalog.updateEventTeam(
      event.value.eventId,
      firstTeam.value.eventTeamId,
      { name: "Blue Renamed" },
      authority,
    );
    expect(renamed).toMatchObject({ status: "accepted" });
    expect(
      await fixture.catalog.confirmGameplaySlotTeams(
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
    ).toMatchObject({ status: "rejected", reason: "no-change" });
    expect(
      await fixture.catalog.confirmGameplaySlotTeams(
        event.value.eventId,
        day.value.gameDayId,
        slot.value.gameplaySlotId,
        {
          games: [
            {
              eventGameId: game.value.eventGameId,
              sideAEventTeamId: secondTeam.value.eventTeamId,
              sideBEventTeamId: firstTeam.value.eventTeamId,
            },
          ],
        },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });
    const inspected = await fixture.catalog.inspectEvent(event.value.eventId, authority);
    expect(inspected).toMatchObject({
      status: "accepted",
      value: {
        gameplaySlots: [{ sequence: 1 }],
        pitchSlots: [{ pitchId: pitch.value.pitchId, gameplaySlotId: slot.value.gameplaySlotId }],
        eventGames: [{ gameCode: "SF.1", sideA: { eventTeamId: firstTeam.value.eventTeamId } }],
      },
    });
    expect(inspected).toMatchObject({
      value: {
        eventGames: [{ sideA: { eventTeamName: "Blue" }, sideB: { eventTeamName: "Red" } }],
      },
    });
    const audit = await fixture.catalog.listAuditTrail(event.value.eventId, authority);
    expect(audit).toMatchObject({ status: "accepted" });
    if (audit.status === "accepted") {
      expect(audit.value.some((entry) => entry.action === "event-game-teams-confirmed")).toBe(true);
      expect(
        audit.value.filter((entry) => entry.action === "event-game-teams-confirmed"),
      ).toHaveLength(1);
      if (auditBeforeNoChange.status !== "accepted") throw new Error("Expected audit trail.");
      expect(audit.value.length).toBe(auditBeforeNoChange.value.length + 1);
    }
  });

  test("interprets scheduled starts in the Event timezone and rejects malformed, wrong-day, and DST-gap times", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Zurich Schedule", timeZone: "Europe/Zurich" },
      authority,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    const day = await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-03-29" },
      authority,
    );
    if (day.status !== "accepted") throw new Error("Expected Game Day.");
    const before = await fixture.catalog.listAuditTrail(event.value.eventId, authority);
    expect(
      await fixture.catalog.createGameplaySlot(
        event.value.eventId,
        day.value.gameDayId,
        { sequence: 1, scheduledStart: "2026-03-29T02:30" },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });
    expect(
      await fixture.catalog.createGameplaySlot(
        event.value.eventId,
        day.value.gameDayId,
        { sequence: 1, scheduledStart: "2026-03-30T10:00" },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });
    expect(
      await fixture.catalog.createGameplaySlot(
        event.value.eventId,
        day.value.gameDayId,
        { sequence: 1, scheduledStart: "2026-03-29 10:00" },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });
    const after = await fixture.catalog.listAuditTrail(event.value.eventId, authority);
    expect(after).toMatchObject({
      status: "accepted",
      value: before.status === "accepted" ? before.value : [],
    });
    const valid = await fixture.catalog.createGameplaySlot(
      event.value.eventId,
      day.value.gameDayId,
      { sequence: 1, scheduledStart: "2026-03-29T10:00" },
      authority,
    );
    expect(valid).toMatchObject({
      status: "accepted",
      value: { scheduledStartMs: Date.parse("2026-03-29T08:00:00Z") },
    });
  });

  test("rejects an ambiguous Event-timezone fall-back wall time", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Zurich Fall Back", timeZone: "Europe/Zurich" },
      authority,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    const day = await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-10-25" },
      authority,
    );
    if (day.status !== "accepted") throw new Error("Expected Game Day.");
    const before = await fixture.catalog.listAuditTrail(event.value.eventId, authority);
    expect(
      await fixture.catalog.createGameplaySlot(
        event.value.eventId,
        day.value.gameDayId,
        { sequence: 1, scheduledStart: "2026-10-25T02:30" },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });
    expect(await fixture.catalog.inspectEvent(event.value.eventId, authority)).toMatchObject({
      status: "accepted",
      value: { gameplaySlots: [] },
    });
    const after = await fixture.catalog.listAuditTrail(event.value.eventId, authority);
    expect(after).toMatchObject({ status: "accepted" });
    if (before.status === "accepted" && after.status === "accepted")
      expect(after.value.length).toBe(before.value.length);
  });

  test("preflights every Game before rejecting a late-invalid multi-Game confirmation", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent({ name: "Batch", timeZone: "UTC" }, authority);
    const foreignEvent = await fixture.catalog.createEvent(
      { name: "Foreign", timeZone: "UTC" },
      authority,
    );
    if (event.status !== "accepted" || foreignEvent.status !== "accepted")
      throw new Error("Expected Events.");
    const day = await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-14" },
      authority,
    );
    const pitchA = await fixture.catalog.createPitch(event.value.eventId, { name: "A" }, authority);
    const pitchB = await fixture.catalog.createPitch(event.value.eventId, { name: "B" }, authority);
    const firstTeam = await fixture.catalog.createEventTeam(
      event.value.eventId,
      { name: "Blue" },
      authority,
    );
    const secondTeam = await fixture.catalog.createEventTeam(
      event.value.eventId,
      { name: "Red" },
      authority,
    );
    const foreignTeam = await fixture.catalog.createEventTeam(
      foreignEvent.value.eventId,
      { name: "Foreign" },
      authority,
    );
    if (
      day.status !== "accepted" ||
      pitchA.status !== "accepted" ||
      pitchB.status !== "accepted" ||
      firstTeam.status !== "accepted" ||
      secondTeam.status !== "accepted" ||
      foreignTeam.status !== "accepted"
    )
      throw new Error("Expected batch setup.");
    const slot = await fixture.catalog.createGameplaySlot(
      event.value.eventId,
      day.value.gameDayId,
      { sequence: 1, scheduledStart: "2026-08-14T10:00" },
      authority,
    );
    if (slot.status !== "accepted") throw new Error("Expected Gameplay Slot.");
    const pitchSlots = await fixture.storage.snapshot();
    const pitchSlotA = pitchSlots.listPitchSlots(day.value.gameDayId, pitchA.value.pitchId)[0];
    const pitchSlotB = pitchSlots.listPitchSlots(day.value.gameDayId, pitchB.value.pitchId)[0];
    if (pitchSlotA === undefined || pitchSlotB === undefined)
      throw new Error("Expected Pitch Slots.");
    const gameA = await fixture.catalog.createEventGame(
      event.value.eventId,
      day.value.gameDayId,
      {
        gameplaySlotId: slot.value.gameplaySlotId,
        pitchSlotId: pitchSlotA.pitchSlotId,
        sideA: { sourceLabel: "A" },
        sideB: { sourceLabel: "B" },
      },
      authority,
    );
    const gameB = await fixture.catalog.createEventGame(
      event.value.eventId,
      day.value.gameDayId,
      {
        gameplaySlotId: slot.value.gameplaySlotId,
        pitchSlotId: pitchSlotB.pitchSlotId,
        sideA: { sourceLabel: "C" },
        sideB: { sourceLabel: "D" },
      },
      authority,
    );
    if (gameA.status !== "accepted" || gameB.status !== "accepted")
      throw new Error("Expected Event Games.");
    const beforeAudit = await fixture.catalog.listAuditTrail(event.value.eventId, authority);
    const rejected = await fixture.catalog.confirmGameplaySlotTeams(
      event.value.eventId,
      day.value.gameDayId,
      slot.value.gameplaySlotId,
      {
        games: [
          {
            eventGameId: gameA.value.eventGameId,
            sideAEventTeamId: firstTeam.value.eventTeamId,
            sideBEventTeamId: secondTeam.value.eventTeamId,
          },
          {
            eventGameId: gameB.value.eventGameId,
            sideAEventTeamId: firstTeam.value.eventTeamId,
            sideBEventTeamId: foreignTeam.value.eventTeamId,
          },
        ],
      },
      authority,
    );
    expect(rejected).toMatchObject({ status: "rejected", reason: "cross-event" });
    const after = await fixture.catalog.inspectEvent(event.value.eventId, authority);
    expect(after).toMatchObject({
      status: "accepted",
      value: {
        eventGames: [
          { eventGameId: gameA.value.eventGameId, sideA: { eventTeamId: null } },
          { eventGameId: gameB.value.eventGameId, sideA: { eventTeamId: null } },
        ],
      },
    });
    const afterAudit = await fixture.catalog.listAuditTrail(event.value.eventId, authority);
    if (beforeAudit.status === "accepted" && afterAudit.status === "accepted")
      expect(afterAudit.value.length).toBe(beforeAudit.value.length);
  });

  test("rejects Gameplay Slot confirmation after the transaction-local Game Record has commenced", async () => {
    const foundation = createInMemoryFoundationStorage();
    let nextId = 0;
    const catalog = createEventCatalog(createFoundationEventCatalogStorage(foundation), {
      clock: { nowMs: () => 2_000 },
      ids: { next: (kind) => `${kind}-${++nextId}` },
    });
    const event = await catalog.createEvent({ name: "Lifecycle", timeZone: "UTC" }, authority);
    if (event.status !== "accepted") throw new Error("Expected Event.");
    const day = await catalog.addGameDay(event.value.eventId, { date: "2026-08-14" }, authority);
    const pitch = await catalog.createPitch(event.value.eventId, { name: "Pitch" }, authority);
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
    if (
      day.status !== "accepted" ||
      pitch.status !== "accepted" ||
      firstTeam.status !== "accepted" ||
      secondTeam.status !== "accepted"
    )
      throw new Error("Expected schedule setup.");
    const slot = await catalog.createGameplaySlot(
      event.value.eventId,
      day.value.gameDayId,
      { sequence: 1, scheduledStart: "2026-08-14T10:00" },
      authority,
    );
    if (slot.status !== "accepted") throw new Error("Expected Gameplay Slot.");
    const pitchSlot = await foundation.transaction(
      (transaction) => transaction.listPitchSlots(day.value.gameDayId, pitch.value.pitchId)[0],
    );
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
    if (game.status !== "accepted") throw new Error("Expected Event Game.");
    await foundation.transaction((transaction) =>
      transaction.insertRoot({
        root: {
          recordId: "record-1",
          eventId: event.value.eventId,
          eventGameId: game.value.eventGameId,
          ownership: { eventId: event.value.eventId, eventGameId: game.value.eventGameId },
          externalScope: {
            eventId: event.value.eventId,
            gameDayId: day.value.gameDayId,
            pitchId: pitch.value.pitchId,
            pitchSlotId: pitchSlot.pitchSlotId,
          },
          gameSides: [
            {
              id: "record-side-a",
              eventTeamId: firstTeam.value.eventTeamId,
              teamInterpretationRef: "team",
            },
            {
              id: "record-side-b",
              eventTeamId: secondTeam.value.eventTeamId,
              teamInterpretationRef: "team",
            },
          ],
          lifecycle: {
            phase: "in-progress",
            commencedAtMs: 1_500,
            finishedAtMs: null,
            lockedAtMs: null,
            lockReason: null,
          },
          compatibility: { recordVersion: "v1", schemaVersion: "v1", interpreterVersion: "v1" },
          creationEvidence: {
            operationId: "operation-1",
            actorReference: "test",
            source: "event-game-registration",
            createdAtMs: 1_000,
          },
        },
        canonicalContent: "{}",
      }),
    );
    const before = await catalog.listAuditTrail(event.value.eventId, authority);
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
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });
    const after = await catalog.listAuditTrail(event.value.eventId, authority);
    expect(after).toMatchObject({ status: "accepted" });
    if (before.status === "accepted" && after.status === "accepted")
      expect(after.value.length).toBe(before.value.length);
    foundation.close();
  });

  test("applies independent Expected Delays, cascades later slots, and moves stable games", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent({ name: "Shift", timeZone: "UTC" }, authority);
    if (event.status !== "accepted") throw new Error("Expected Event.");
    const day = await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-14" },
      authority,
    );
    if (day.status !== "accepted") throw new Error("Expected Game Day.");
    const pitch = await fixture.catalog.createPitch(
      event.value.eventId,
      { name: "Pitch A" },
      authority,
    );
    if (pitch.status !== "accepted") throw new Error("Expected Pitch.");
    const firstSlot = await fixture.catalog.createGameplaySlot(
      event.value.eventId,
      day.value.gameDayId,
      { sequence: 1, scheduledStart: "2026-08-14T10:00" },
      authority,
    );
    const secondSlot = await fixture.catalog.createGameplaySlot(
      event.value.eventId,
      day.value.gameDayId,
      { sequence: 2, scheduledStart: "2026-08-14T10:20" },
      authority,
    );
    if (firstSlot.status !== "accepted" || secondSlot.status !== "accepted")
      throw new Error("Expected Gameplay Slots.");
    const snapshot = await fixture.storage.snapshot();
    const pitchSlots = snapshot.listPitchSlots(day.value.gameDayId, pitch.value.pitchId);
    const firstPitchSlot = pitchSlots.find(
      (slot) => slot.gameplaySlotId === firstSlot.value.gameplaySlotId,
    );
    const secondPitchSlot = pitchSlots.find(
      (slot) => slot.gameplaySlotId === secondSlot.value.gameplaySlotId,
    );
    if (firstPitchSlot === undefined || secondPitchSlot === undefined)
      throw new Error("Expected Pitch Slots.");
    const firstGame = await fixture.catalog.createEventGame(
      event.value.eventId,
      day.value.gameDayId,
      {
        gameplaySlotId: firstSlot.value.gameplaySlotId,
        pitchSlotId: firstPitchSlot.pitchSlotId,
        sideA: { sourceLabel: "A" },
        sideB: { sourceLabel: "B" },
      },
      authority,
    );
    const secondGame = await fixture.catalog.createEventGame(
      event.value.eventId,
      day.value.gameDayId,
      {
        gameplaySlotId: secondSlot.value.gameplaySlotId,
        pitchSlotId: secondPitchSlot.pitchSlotId,
        sideA: { sourceLabel: "C" },
        sideB: { sourceLabel: "D" },
      },
      authority,
    );
    if (firstGame.status !== "accepted" || secondGame.status !== "accepted")
      throw new Error("Expected Event Games.");
    const blue = await fixture.catalog.createEventTeam(
      event.value.eventId,
      { name: "Blue" },
      authority,
    );
    const red = await fixture.catalog.createEventTeam(
      event.value.eventId,
      { name: "Red" },
      authority,
    );
    if (blue.status !== "accepted" || red.status !== "accepted")
      throw new Error("Expected Event Teams.");
    expect(
      await fixture.catalog.confirmGameplaySlotTeams(
        event.value.eventId,
        day.value.gameDayId,
        firstSlot.value.gameplaySlotId,
        {
          games: [
            {
              eventGameId: firstGame.value.eventGameId,
              sideAEventTeamId: blue.value.eventTeamId,
              sideBEventTeamId: red.value.eventTeamId,
            },
          ],
        },
        authority,
      ),
    ).toMatchObject({ status: "accepted" });
    expect(
      await fixture.catalog.confirmGameplaySlotTeams(
        event.value.eventId,
        day.value.gameDayId,
        secondSlot.value.gameplaySlotId,
        {
          games: [
            {
              eventGameId: secondGame.value.eventGameId,
              sideAEventTeamId: blue.value.eventTeamId,
              sideBEventTeamId: red.value.eventTeamId,
            },
          ],
        },
        authority,
      ),
    ).toMatchObject({ status: "accepted" });
    const staggeredOverlap = await fixture.catalog.inspectEvent(event.value.eventId, authority);
    expect(staggeredOverlap.status).toBe("accepted");
    if (staggeredOverlap.status === "accepted") {
      const firstProjected = staggeredOverlap.value.eventGames.find(
        (game) => game.eventGameId === firstGame.value.eventGameId,
      );
      const secondProjected = staggeredOverlap.value.eventGames.find(
        (game) => game.eventGameId === secondGame.value.eventGameId,
      );
      expect(firstProjected?.teamScheduleConflict).toBe(true);
      expect(secondProjected?.teamScheduleConflict).toBe(true);
    }
    expect(
      await fixture.catalog.setGameplaySlotExpectedDelay(
        event.value.eventId,
        day.value.gameDayId,
        secondSlot.value.gameplaySlotId,
        { expectedDelayMs: 20 * 60_000 },
        authority,
      ),
    ).toMatchObject({ status: "accepted" });
    const staggeredNonOverlap = await fixture.catalog.inspectEvent(event.value.eventId, authority);
    expect(staggeredNonOverlap.status).toBe("accepted");
    if (staggeredNonOverlap.status === "accepted") {
      const firstProjected = staggeredNonOverlap.value.eventGames.find(
        (game) => game.eventGameId === firstGame.value.eventGameId,
      );
      const secondProjected = staggeredNonOverlap.value.eventGames.find(
        (game) => game.eventGameId === secondGame.value.eventGameId,
      );
      expect(firstProjected?.teamScheduleConflict).toBe(false);
      expect(secondProjected?.teamScheduleConflict).toBe(false);
    }
    expect(
      await fixture.catalog.previewGameplaySlotExpectedDelay(
        event.value.eventId,
        day.value.gameDayId,
        firstSlot.value.gameplaySlotId,
        { expectedDelayMs: 20 * 60_000, cascade: true },
        authority,
      ),
    ).toMatchObject({
      status: "accepted",
      value: { changes: [{ beforeDelayMs: 0, afterDelayMs: 20 * 60_000 }] },
    });
    expect(
      await fixture.catalog.previewGameplaySlotExpectedDelay(
        event.value.eventId,
        day.value.gameDayId,
        firstSlot.value.gameplaySlotId,
        { expectedDelayMs: 60_000, cascade: true },
        authority,
      ),
    ).toMatchObject({
      status: "accepted",
      value: { changes: [{ beforeDelayMs: 0 }, { beforeDelayMs: 20 * 60_000 }] },
    });
    expect(
      (await fixture.storage.snapshot()).findGameplaySlot(firstSlot.value.gameplaySlotId),
    ).toMatchObject({ expectedDelayMs: 0 });
    fixture.storage.failNextTransaction(new Error("schedule unavailable"));
    expect(
      await fixture.catalog.setGameplaySlotExpectedDelay(
        event.value.eventId,
        day.value.gameDayId,
        firstSlot.value.gameplaySlotId,
        { expectedDelayMs: 60_000, cascade: true },
        authority,
      ),
    ).toMatchObject({ status: "retryable-failure" });
    expect(
      (await fixture.storage.snapshot()).findGameplaySlot(firstSlot.value.gameplaySlotId),
    ).toMatchObject({ expectedDelayMs: 0 });
    expect(
      await fixture.catalog.setGameplaySlotExpectedDelay(
        event.value.eventId,
        day.value.gameDayId,
        firstSlot.value.gameplaySlotId,
        { expectedDelayMs: 60_000, cascade: true },
        authority,
      ),
    ).toMatchObject({
      status: "accepted",
      value: { changes: [{ afterDelayMs: 60_000 }, { afterDelayMs: 60_000 }] },
    });
    expect(
      await fixture.catalog.setPitchSlotExpectedDelay(
        event.value.eventId,
        day.value.gameDayId,
        firstPitchSlot.pitchSlotId,
        { expectedDelayMs: 120_000 },
        authority,
      ),
    ).toMatchObject({ status: "accepted", value: { changes: [{ afterDelayMs: 120_000 }] } });
    const gameplayDominatedByPitch = await fixture.catalog.previewGameplaySlotExpectedDelay(
      event.value.eventId,
      day.value.gameDayId,
      firstSlot.value.gameplaySlotId,
      { expectedDelayMs: 30_000 },
      authority,
    );
    expect(gameplayDominatedByPitch).toMatchObject({
      status: "accepted",
      value: {
        changes: [
          {
            beforeDelayMs: 60_000,
            afterDelayMs: 30_000,
          },
        ],
      },
    });
    if (gameplayDominatedByPitch.status === "accepted") {
      const gamePreview = gameplayDominatedByPitch.value.changes[0]?.eventGames[0];
      if (gamePreview === undefined) throw new Error("Expected delayed Game preview.");
      expect(typeof gamePreview.beforeExpectedStartMs).toBe("number");
      expect(typeof gamePreview.afterExpectedStartMs).toBe("number");
      expect(gamePreview.afterExpectedStartMs - gamePreview.beforeExpectedStartMs).toBe(0);
    }
    const pitchDominatedByGameplay = await fixture.catalog.previewPitchSlotExpectedDelay(
      event.value.eventId,
      day.value.gameDayId,
      secondPitchSlot.pitchSlotId,
      { expectedDelayMs: 30_000 },
      authority,
    );
    expect(pitchDominatedByGameplay).toMatchObject({
      status: "accepted",
      value: {
        changes: [{}],
      },
    });
    if (pitchDominatedByGameplay.status === "accepted") {
      const gamePreview = pitchDominatedByGameplay.value.changes[0]?.eventGames[0];
      if (gamePreview === undefined) throw new Error("Expected Pitch Slot Game preview.");
      expect(typeof gamePreview.beforeExpectedStartMs).toBe("number");
      expect(typeof gamePreview.afterExpectedStartMs).toBe("number");
      expect(gamePreview.afterExpectedStartMs - gamePreview.beforeExpectedStartMs).toBe(0);
    }
    const auditBeforeNoChange = await fixture.catalog.listAuditTrail(
      event.value.eventId,
      authority,
    );
    expect(
      await fixture.catalog.previewGameplaySlotExpectedDelay(
        event.value.eventId,
        day.value.gameDayId,
        firstSlot.value.gameplaySlotId,
        { expectedDelayMs: 60_000, cascade: true },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "no-change" });
    expect(
      await fixture.catalog.setGameplaySlotExpectedDelay(
        event.value.eventId,
        day.value.gameDayId,
        firstSlot.value.gameplaySlotId,
        { expectedDelayMs: 60_000, cascade: true },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "no-change" });
    const auditAfterNoChange = await fixture.catalog.listAuditTrail(event.value.eventId, authority);
    if (auditBeforeNoChange.status === "accepted" && auditAfterNoChange.status === "accepted")
      expect(auditAfterNoChange.value.length).toBe(auditBeforeNoChange.value.length);
    if (firstGame.status !== "accepted" || secondGame.status !== "accepted") return;
    expect(
      await fixture.catalog.reassignEventGame(
        event.value.eventId,
        day.value.gameDayId,
        firstGame.value.eventGameId,
        { targetPitchSlotId: secondPitchSlot.pitchSlotId, mode: "swap" },
        authority,
      ),
    ).toMatchObject({
      status: "accepted",
      value: {
        scheduleConflict: false,
        eventGame: {
          eventGameId: firstGame.value.eventGameId,
          pitchSlotId: secondPitchSlot.pitchSlotId,
        },
        swappedEventGame: {
          eventGameId: secondGame.value.eventGameId,
          pitchSlotId: firstPitchSlot.pitchSlotId,
        },
      },
    });
    expect(
      await fixture.catalog.reassignEventGame(
        event.value.eventId,
        day.value.gameDayId,
        firstGame.value.eventGameId,
        { targetPitchSlotId: firstPitchSlot.pitchSlotId, mode: "move" },
        authority,
      ),
    ).toMatchObject({ status: "accepted", value: { scheduleConflict: true } });
    expect(await fixture.catalog.inspectEvent(event.value.eventId, authority)).toMatchObject({
      status: "accepted",
      value: {
        eventGames: [
          { eventGameId: firstGame.value.eventGameId, expectedStartMs: expect.any(Number) },
          { eventGameId: secondGame.value.eventGameId, expectedStartMs: expect.any(Number) },
        ],
      },
    });
    const thirdGame = await fixture.catalog.createEventGame(
      event.value.eventId,
      day.value.gameDayId,
      {
        gameplaySlotId: secondSlot.value.gameplaySlotId,
        pitchSlotId: secondPitchSlot.pitchSlotId,
        sideA: { sourceLabel: "E" },
        sideB: { sourceLabel: "F" },
      },
      authority,
    );
    if (thirdGame.status !== "accepted") throw new Error("Expected third Event Game.");
    const auditBeforeMultiOccupantSwap = await fixture.catalog.listAuditTrail(
      event.value.eventId,
      authority,
    );
    expect(
      await fixture.catalog.reassignEventGame(
        event.value.eventId,
        day.value.gameDayId,
        thirdGame.value.eventGameId,
        { targetPitchSlotId: firstPitchSlot.pitchSlotId, mode: "swap" },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });
    const unchangedAfterMultiOccupantSwap = await fixture.catalog.inspectEvent(
      event.value.eventId,
      authority,
    );
    expect(unchangedAfterMultiOccupantSwap.status).toBe("accepted");
    if (unchangedAfterMultiOccupantSwap.status === "accepted") {
      const unchangedThird = unchangedAfterMultiOccupantSwap.value.eventGames.find(
        (game) => game.eventGameId === thirdGame.value.eventGameId,
      );
      expect(unchangedThird).toMatchObject({ pitchSlotId: secondPitchSlot.pitchSlotId });
    }
    const auditAfterMultiOccupantSwap = await fixture.catalog.listAuditTrail(
      event.value.eventId,
      authority,
    );
    if (
      auditBeforeMultiOccupantSwap.status === "accepted" &&
      auditAfterMultiOccupantSwap.status === "accepted"
    )
      expect(auditAfterMultiOccupantSwap.value.length).toBe(
        auditBeforeMultiOccupantSwap.value.length,
      );
    const auditBeforeFailedReassignment = await fixture.catalog.listAuditTrail(
      event.value.eventId,
      authority,
    );
    fixture.storage.failNextTransaction(new Error("reassignment unavailable"));
    expect(
      await fixture.catalog.reassignEventGame(
        event.value.eventId,
        day.value.gameDayId,
        thirdGame.value.eventGameId,
        { targetPitchSlotId: firstPitchSlot.pitchSlotId, mode: "move" },
        authority,
      ),
    ).toMatchObject({ status: "retryable-failure" });
    const unchangedAfterFailedReassignment = await fixture.catalog.inspectEvent(
      event.value.eventId,
      authority,
    );
    expect(unchangedAfterFailedReassignment.status).toBe("accepted");
    if (unchangedAfterFailedReassignment.status === "accepted") {
      const unchangedThird = unchangedAfterFailedReassignment.value.eventGames.find(
        (game) => game.eventGameId === thirdGame.value.eventGameId,
      );
      expect(unchangedThird).toMatchObject({ pitchSlotId: secondPitchSlot.pitchSlotId });
    }
    const auditAfterFailedReassignment = await fixture.catalog.listAuditTrail(
      event.value.eventId,
      authority,
    );
    if (
      auditBeforeFailedReassignment.status === "accepted" &&
      auditAfterFailedReassignment.status === "accepted"
    )
      expect(auditAfterFailedReassignment.value.length).toBe(
        auditBeforeFailedReassignment.value.length,
      );
  });
  test("corrects one stable Game Side before commencement and preserves its stable identity", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Identity", timeZone: "UTC" },
      authority,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    const day = await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-14" },
      authority,
    );
    const home = await fixture.catalog.createEventTeam(
      event.value.eventId,
      { name: "Old" },
      authority,
    );
    const replacement = await fixture.catalog.createEventTeam(
      event.value.eventId,
      { name: "Replacement" },
      authority,
    );
    const other = await fixture.catalog.createEventTeam(
      event.value.eventId,
      { name: "Other" },
      authority,
    );
    const later = await fixture.catalog.createEventTeam(
      event.value.eventId,
      { name: "Later" },
      authority,
    );
    const pitch = await fixture.catalog.createPitch(
      event.value.eventId,
      { name: "Pitch A" },
      authority,
    );
    if (
      day.status !== "accepted" ||
      home.status !== "accepted" ||
      replacement.status !== "accepted" ||
      other.status !== "accepted" ||
      later.status !== "accepted" ||
      pitch.status !== "accepted"
    )
      throw new Error("Expected setup.");
    const slot = await fixture.catalog.createGameplaySlot(
      event.value.eventId,
      day.value.gameDayId,
      { sequence: 1, scheduledStart: "2026-08-14T10:00" },
      authority,
    );
    if (slot.status !== "accepted") throw new Error("Expected slot.");
    const pitchSlot = (await fixture.storage.snapshot()).listPitchSlots(
      day.value.gameDayId,
      pitch.value.pitchId,
    )[0];
    if (pitchSlot === undefined) throw new Error("Expected Pitch Slot.");
    const game = await fixture.catalog.createEventGame(
      event.value.eventId,
      day.value.gameDayId,
      {
        gameplaySlotId: slot.value.gameplaySlotId,
        pitchSlotId: pitchSlot.pitchSlotId,
        sideA: { sourceLabel: "Old" },
        sideB: { sourceLabel: "Other" },
      },
      authority,
    );
    if (game.status !== "accepted") throw new Error(`Expected Game: ${JSON.stringify(game)}`);
    const confirmed = await fixture.catalog.confirmGameplaySlotTeams(
      event.value.eventId,
      day.value.gameDayId,
      slot.value.gameplaySlotId,
      {
        games: [
          {
            eventGameId: game.value.eventGameId,
            sideAEventTeamId: home.value.eventTeamId,
            sideBEventTeamId: other.value.eventTeamId,
          },
        ],
      },
      authority,
    );
    if (confirmed.status !== "accepted")
      throw new Error(`Expected confirmed Game: ${JSON.stringify(confirmed)}`);
    const assignedGame = confirmed.value[0];
    if (assignedGame === undefined) throw new Error("Expected assigned Game.");

    expect(
      await fixture.catalog.correctEventGameIdentity(
        event.value.eventId,
        day.value.gameDayId,
        game.value.eventGameId,
        {
          gameSideId: assignedGame.sideA.sideId,
          eventTeamId: replacement.value.eventTeamId,
          operationId: "identity-op-a",
        },
        authority,
      ),
    ).toMatchObject({
      status: "accepted",
      value: {
        gameSideId: assignedGame.sideA.sideId,
        eventTeamName: "Replacement",
        commenced: false,
      },
    });
    const changed = await fixture.catalog.inspectEvent(event.value.eventId, authority);
    expect(changed).toMatchObject({
      value: {
        eventGames: [
          { sideA: { eventTeamId: replacement.value.eventTeamId, eventTeamName: "Replacement" } },
        ],
      },
    });

    expect(
      await fixture.catalog.updateEventTeam(
        event.value.eventId,
        replacement.value.eventTeamId,
        { name: "Replacement Renamed Later" },
        authority,
      ),
    ).toMatchObject({ status: "accepted" });
    expect(await fixture.catalog.inspectEvent(event.value.eventId, authority)).toMatchObject({
      value: {
        eventGames: [
          { sideA: { eventTeamId: replacement.value.eventTeamId, eventTeamName: "Replacement" } },
        ],
      },
    });

    const beforeRetryAudit = await fixture.catalog.listAuditTrail(event.value.eventId, authority);
    expect(
      await fixture.catalog.correctEventGameIdentity(
        event.value.eventId,
        day.value.gameDayId,
        game.value.eventGameId,
        {
          gameSideId: assignedGame.sideA.sideId,
          eventTeamId: later.value.eventTeamId,
          operationId: "identity-op-b",
        },
        authority,
      ),
    ).toMatchObject({ status: "accepted", value: { eventTeamId: later.value.eventTeamId } });
    const afterLaterCorrectionAudit = await fixture.catalog.listAuditTrail(
      event.value.eventId,
      authority,
    );
    if (afterLaterCorrectionAudit.status !== "accepted")
      throw new Error("Expected the later correction audit.");
    const retried = await fixture.catalog.correctEventGameIdentity(
      event.value.eventId,
      day.value.gameDayId,
      game.value.eventGameId,
      {
        gameSideId: assignedGame.sideA.sideId,
        eventTeamId: replacement.value.eventTeamId,
        operationId: "identity-op-a",
      },
      authority,
    );
    expect(retried).toMatchObject({
      status: "accepted",
      value: {
        operationId: "identity-op-a",
        eventTeamId: replacement.value.eventTeamId,
        eventTeamName: "Replacement",
      },
    });
    const retryAudit = await fixture.catalog.listAuditTrail(event.value.eventId, authority);
    if (retryAudit.status !== "accepted") throw new Error("Expected the retry audit.");
    expect(retryAudit.value).toHaveLength(afterLaterCorrectionAudit.value.length);
    expect(await fixture.catalog.inspectEvent(event.value.eventId, authority)).toMatchObject({
      value: {
        eventGames: [{ sideA: { eventTeamId: later.value.eventTeamId, eventTeamName: "Later" } }],
      },
    });
    const concurrentRetries = await Promise.all([
      fixture.catalog.correctEventGameIdentity(
        event.value.eventId,
        day.value.gameDayId,
        game.value.eventGameId,
        {
          gameSideId: assignedGame.sideA.sideId,
          eventTeamId: replacement.value.eventTeamId,
          operationId: "identity-op-a",
        },
        authority,
      ),
      fixture.catalog.correctEventGameIdentity(
        event.value.eventId,
        day.value.gameDayId,
        game.value.eventGameId,
        {
          gameSideId: assignedGame.sideA.sideId,
          eventTeamId: replacement.value.eventTeamId,
          operationId: "identity-op-a",
        },
        authority,
      ),
    ]);
    expect(concurrentRetries).toHaveLength(2);
    expect(concurrentRetries[0]).toMatchObject({
      status: "accepted",
      value: { eventTeamId: replacement.value.eventTeamId, eventTeamName: "Replacement" },
    });
    expect(concurrentRetries[1]).toMatchObject({
      status: "accepted",
      value: { eventTeamId: replacement.value.eventTeamId, eventTeamName: "Replacement" },
    });
    const afterConcurrentRetriesAudit = await fixture.catalog.listAuditTrail(
      event.value.eventId,
      authority,
    );
    if (afterConcurrentRetriesAudit.status !== "accepted")
      throw new Error("Expected the concurrent retry audit.");
    expect(afterConcurrentRetriesAudit.value).toHaveLength(afterLaterCorrectionAudit.value.length);
    expect(
      await fixture.catalog.correctEventGameIdentity(
        event.value.eventId,
        day.value.gameDayId,
        game.value.eventGameId,
        {
          gameSideId: assignedGame.sideA.sideId,
          eventTeamId: home.value.eventTeamId,
          operationId: "identity-op-a",
        },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "duplicate" });
    expect(beforeRetryAudit.status).toBe("accepted");

    const root = (await fixture.storage.snapshot()).findRootByEventGameId(game.value.eventGameId);
    if (root !== null) throw new Error("This catalog fixture has no commenced root.");
  });
});
