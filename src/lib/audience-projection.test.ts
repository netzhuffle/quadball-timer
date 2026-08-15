import { describe, expect, test } from "bun:test";
import { createAudienceProjection, PUBLIC_AUDIENCE_ABSENCE } from "@/lib/audience-projection";
import {
  createControlActionCodecRegistry,
  materializeControlAction,
  prepareControlAction,
  type ControlActionInput,
} from "@/lib/event-game-actions";
import {
  createEventCatalog,
  createFoundationEventCatalogStorage,
  createUnavailableEventCatalogStorage,
  type EventCatalogFoundationStorage,
  type EventCatalogStorageSnapshot,
  type EventGame,
  type GameplaySlot,
  type PitchSlot,
  type StoredEvent,
} from "@/lib/event-catalog";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import {
  MemoryTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
} from "@/lib/technical-admin-auth";
import { readAudienceEvent, readAudienceEvents, readAudienceSitemap } from "@/index";

const authority = createTechnicalAdminAuth(
  { environment: "test", origin: "https://timer.example", rpId: "timer.example" },
  new MemoryTechnicalAdminAuthRepository(),
).resolveHostLocalAuthority();

describe("Audience Publication Projection", () => {
  test("groups every running Game, uses a half-open one-hour horizon, and orders the schedule", async () => {
    const now = Date.parse("2026-08-14T10:00:00.000Z");
    const snapshot = createScheduleSnapshot({
      pitches: ["Pitch 1", "Pitch 2"],
      games: [
        createScheduleGame("past", "2026-08-14T08:00:00.000Z", "Pitch 1"),
        createScheduleGame("running-a", "2026-08-14T09:00:00.000Z", "Pitch 1"),
        createScheduleGame("running-b", "2026-08-14T09:00:00.000Z", "Pitch 2"),
        createScheduleGame("awaiting", "2026-08-14T09:30:00.000Z", "Pitch 1"),
        createScheduleGame("upcoming", "2026-08-14T10:30:00.000Z", "Pitch 2"),
        createScheduleGame("boundary", "2026-08-14T11:00:00.000Z", "Pitch 1"),
      ],
      roots: new Map([
        ["past", createScheduleRoot("past", "finished")],
        ["running-a", createScheduleRoot("running-a", "in-progress")],
        ["running-b", createScheduleRoot("running-b", "in-progress")],
      ]),
    });
    const audience = createAudienceProjection(
      { snapshot: async () => snapshot } as unknown as EventCatalogFoundationStorage,
      { now: () => now },
    );

    const result = await audience.read("event-schedule");
    expect(result).toMatchObject({ status: "accepted" });
    if (result.status !== "accepted") return;
    const schedule = result.value.schedule;
    expect(schedule).toBeDefined();
    if (schedule === undefined) return;
    expect(schedule.runningGames.map((game) => game.gameCode)).toEqual(["running-a", "running-b"]);
    expect(schedule.upcomingGames.map((game) => game.gameCode)).toEqual(["upcoming"]);
    expect(schedule.scheduleGames.map((game) => game.gameCode)).toEqual([
      "past",
      "running-a",
      "running-b",
      "awaiting",
      "upcoming",
      "boundary",
    ]);
    expect(schedule.scheduleGames.map((game) => game.scheduleStatus)).toEqual([
      "past",
      "running",
      "running",
      "awaiting-start",
      "future",
      "future",
    ]);
    expect(schedule.focusIndex).toBe(1);
    expect(schedule.runningGames[0]?.pitch).toBe("Pitch 1");
    expect(schedule.runningGames[1]?.pitch).toBe("Pitch 2");
    expect(schedule.runningGames.map((game) => game.phase)).toEqual([
      "seeker-floor",
      "seeker-floor",
    ]);
    expect(schedule.runningGames.map((game) => game.operationalStatus)).toEqual([
      "paused",
      "paused",
    ]);
  });

  test("projects sporting Game Phase separately from operational status", async () => {
    const roots = new Map([
      ["floor", createScheduleRoot("floor", "in-progress")],
      ["released", createScheduleRoot("released", "in-progress")],
      ["overtime", createScheduleRoot("overtime", "in-progress")],
    ]);
    const snapshot = createScheduleSnapshot({
      pitches: ["Pitch 1"],
      games: [
        createScheduleGame("floor", "2026-08-14T10:00:00.000Z", "Pitch 1"),
        createScheduleGame("released", "2026-08-14T10:01:00.000Z", "Pitch 1"),
        createScheduleGame("overtime", "2026-08-14T10:02:00.000Z", "Pitch 1"),
      ],
      roots,
      actions: (root) => {
        if (root.eventGameId === "released") return [createClockAction(root)];
        if (root.eventGameId === "overtime") {
          return [
            ...Array.from({ length: 4 }, (_, index) =>
              createGoalAction(root, root.gameSides[1].id, `opponent-goal-${index}`),
            ),
            createFlagCatchAction(root),
          ];
        }
        return [];
      },
    });
    const audience = createAudienceProjection(
      { snapshot: async () => snapshot } as unknown as EventCatalogFoundationStorage,
      { now: () => Date.parse("2026-08-14T10:00:00.000Z") },
    );

    const result = await audience.read("event-schedule");
    expect(result).toMatchObject({ status: "accepted" });
    if (result.status !== "accepted") return;
    expect(result.value.schedule.scheduleGames.map((game) => [game.gameCode, game.phase])).toEqual([
      ["floor", "seeker-floor"],
      ["released", "seekers-released"],
      ["overtime", "overtime"],
    ]);
    expect(result.value.schedule.scheduleGames.map((game) => game.operationalStatus)).toEqual([
      "paused",
      "paused",
      "paused",
    ]);
  });

  test("regenerates Expected Start and omits redundant single-Pitch labels", async () => {
    let expectedDelayMs = 0;
    const base = createScheduleGame("changed", "2026-08-14T10:30:00.000Z", "Pitch 1");
    const snapshot = createScheduleSnapshot({
      pitches: ["Pitch 1"],
      games: [base],
      expectedDelay: () => expectedDelayMs,
    });
    const audience = createAudienceProjection(
      { snapshot: async () => snapshot } as unknown as EventCatalogFoundationStorage,
      { now: () => Date.parse("2026-08-14T10:00:00.000Z") },
    );

    const before = await audience.read("event-schedule");
    expect(before).toMatchObject({
      status: "accepted",
      value: {
        schedule: {
          scheduleGames: [
            {
              scheduledStartMs: Date.parse("2026-08-14T10:30:00.000Z"),
              expectedStartMs: Date.parse("2026-08-14T10:30:00.000Z"),
              pitch: null,
            },
          ],
        },
      },
    });

    expectedDelayMs = 20 * 60_000;
    const after = await audience.read("event-schedule");
    expect(after).toMatchObject({
      status: "accepted",
      value: {
        schedule: {
          scheduleGames: [
            {
              scheduledStartMs: Date.parse("2026-08-14T10:30:00.000Z"),
              expectedStartMs: Date.parse("2026-08-14T10:50:00.000Z"),
              pitch: null,
            },
          ],
        },
      },
    });
  });

  test("regenerates committed Game State and Pitch reassignment", async () => {
    let includeGoal = false;
    let reassigned = false;
    const game = createScheduleGame("mutable", "2026-08-14T10:30:00.000Z", "Pitch 1");
    const root = createScheduleRoot("mutable", "in-progress");
    const snapshot = createScheduleSnapshot({
      pitches: ["Pitch 1", "Pitch 2"],
      games: () => [game],
      roots: new Map([["mutable", root]]),
      placement: () => ({
        pitchSlotId: reassigned ? `${game.pitchSlotId}-2` : game.pitchSlotId,
      }),
      actions: (currentRoot) => (includeGoal ? [createGoalAction(currentRoot)] : []),
    });
    const audience = createAudienceProjection(
      { snapshot: async () => snapshot } as unknown as EventCatalogFoundationStorage,
      { now: () => Date.parse("2026-08-14T10:00:00.000Z") },
    );

    const before = await audience.read("event-schedule");
    expect(before).toMatchObject({
      status: "accepted",
      value: {
        schedule: {
          scheduleGames: [
            {
              pitch: "Pitch 1",
              expectedStartMs: Date.parse("2026-08-14T10:30:00.000Z"),
              sideA: { score: 0 },
            },
          ],
        },
      },
    });

    includeGoal = true;
    reassigned = true;
    const after = await audience.read("event-schedule");
    expect(after).toMatchObject({
      status: "accepted",
      value: {
        schedule: {
          scheduleGames: [
            {
              pitch: "Pitch 2",
              expectedStartMs: Date.parse("2026-08-14T10:30:00.000Z"),
              sideA: { score: 10 },
            },
          ],
        },
      },
    });
  });

  test("returns empty running and upcoming groups while retaining an all-past schedule", async () => {
    const snapshot = createScheduleSnapshot({
      pitches: ["Pitch 1"],
      games: [createScheduleGame("finished", "2026-08-14T08:00:00.000Z", "Pitch 1")],
      roots: new Map([["finished", createScheduleRoot("finished", "finished")]]),
    });
    const audience = createAudienceProjection(
      { snapshot: async () => snapshot } as unknown as EventCatalogFoundationStorage,
      { now: () => Date.parse("2026-08-14T12:00:00.000Z") },
    );

    const result = await audience.read("event-schedule");
    expect(result).toMatchObject({
      status: "accepted",
      value: {
        schedule: {
          runningGames: [],
          upcomingGames: [],
          scheduleGames: [{ gameCode: "finished", scheduleStatus: "past" }],
        },
      },
    });
  });

  test("keeps a zero-Day Published Event explicitly unscheduled", async () => {
    const event: StoredEvent = {
      eventId: "event-unscheduled",
      name: "Unscheduled",
      timeZone: "UTC",
      publicationStatus: "published",
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const snapshot = {
      listEvents: () => [event],
      findEvent: () => event,
      listGameDays: () => [],
      listEventTeams: () => [],
      listPitches: () => [],
    } as unknown as EventCatalogStorageSnapshot;
    const audience = createAudienceProjection(
      { snapshot: async () => snapshot } as unknown as EventCatalogFoundationStorage,
      { now: () => Date.parse("2026-08-14T12:00:00.000Z") },
    );

    const result = await audience.list();
    expect(result).toMatchObject({
      status: "accepted",
      value: { events: [{ name: "Unscheduled", lifecycle: "unscheduled" }] },
    });
  });

  test("lists only Published Events and classifies them in each Event timezone", async () => {
    const foundation = createInMemoryFoundationStorage();
    const storage = createFoundationEventCatalogStorage(foundation);
    const catalog = createEventCatalog(storage, {});
    const audience = createAudienceProjection(storage, {
      now: () => Date.parse("2026-08-14T00:30:00.000Z"),
    });
    const current = await catalog.createEvent(
      { name: "Current", timeZone: "Europe/Zurich" },
      authority,
    );
    const future = await catalog.createEvent({ name: "Future", timeZone: "UTC" }, authority);
    const past = await catalog.createEvent({ name: "Past", timeZone: "UTC" }, authority);
    if (current.status !== "accepted" || future.status !== "accepted" || past.status !== "accepted")
      throw new Error("Expected Events.");
    await catalog.addGameDay(current.value.eventId, { date: "2026-08-14" }, authority);
    await catalog.addGameDay(future.value.eventId, { date: "2026-08-15" }, authority);
    await catalog.addGameDay(past.value.eventId, { date: "2026-08-13" }, authority);
    await catalog.changePublicationStatus(
      current.value.eventId,
      { status: "published" },
      authority,
    );
    await catalog.changePublicationStatus(future.value.eventId, { status: "published" }, authority);
    await catalog.changePublicationStatus(past.value.eventId, { status: "published" }, authority);

    const result = await audience.list();
    expect(result).toMatchObject({ status: "accepted" });
    if (result.status !== "accepted") return;
    expect(result.value.events.map((event) => [event.name, event.lifecycle])).toEqual([
      ["Current", "current"],
      ["Future", "future"],
      ["Past", "past"],
    ]);
    expect(result.value.events[0]).toMatchObject({
      canonicalPath: `/events/${encodeURIComponent(current.value.eventId)}`,
      teams: [],
      pitches: [],
    });
    foundation.close();
  });

  test("adapts the allowlisted list and sitemap without exposing hidden Event names", async () => {
    const projection = {
      list: async () => ({
        status: "accepted" as const,
        value: {
          events: [
            {
              eventId: "event-public",
              name: "Public Event",
              timeZone: "UTC",
              publicationStatus: "published" as const,
              gameDays: ["2026-08-14"],
              lifecycle: "current" as const,
              canonicalPath: "/events/event-public",
              teams: [],
              pitches: [],
              schedule: {
                asOfMs: 0,
                runningGames: [],
                upcomingGames: [],
                scheduleGames: [],
                focusIndex: null,
              },
            },
          ],
        },
      }),
    };
    const listResponse = await readAudienceEvents(
      new Request("https://timer.example/api/audience/events"),
      projection,
    );
    expect(listResponse.status).toBe(200);
    expect(await listResponse.text()).toContain("Public Event");

    const sitemapResponse = await readAudienceSitemap(
      new Request("https://timer.example/sitemap.xml"),
      projection,
    );
    const sitemap = await sitemapResponse.text();
    expect(sitemapResponse.status).toBe(200);
    expect(sitemap).toContain("https://timer.example/events/event-public");
    expect(sitemap).not.toContain("unpublished");
  });

  test("excludes a real Unpublished Event from discovery and its sitemap", async () => {
    const foundation = createInMemoryFoundationStorage();
    const storage = createFoundationEventCatalogStorage(foundation);
    const catalog = createEventCatalog(storage, {});
    const audience = createAudienceProjection(storage, {
      now: () => Date.parse("2026-08-14T12:00:00.000Z"),
    });
    const hidden = await catalog.createEvent({ name: "Hidden Event", timeZone: "UTC" }, authority);
    const visible = await catalog.createEvent(
      { name: "Visible Event", timeZone: "UTC" },
      authority,
    );
    if (hidden.status !== "accepted" || visible.status !== "accepted")
      throw new Error("Expected Events.");
    await catalog.addGameDay(hidden.value.eventId, { date: "2026-08-14" }, authority);
    await catalog.addGameDay(visible.value.eventId, { date: "2026-08-14" }, authority);
    await catalog.changePublicationStatus(
      visible.value.eventId,
      { status: "published" },
      authority,
    );

    const list = await audience.list();
    if (list.status !== "accepted") throw new Error("Expected discovery list.");
    expect(list.value.events.map((event) => event.name)).toEqual(["Visible Event"]);

    const sitemap = await readAudienceSitemap(
      new Request("https://timer.example/sitemap.xml"),
      audience,
    );
    const sitemapBody = await sitemap.text();
    expect(sitemapBody).toContain(encodeURIComponent(visible.value.eventId));
    expect(sitemapBody).not.toContain(encodeURIComponent(hidden.value.eventId));
    foundation.close();
  });

  test("uses identical anonymous absence for unpublished, cancelled, nonexistent, and unknown Events", async () => {
    const foundation = createInMemoryFoundationStorage();
    const storage = createFoundationEventCatalogStorage(foundation);
    const catalog = createEventCatalog(storage, {});
    const audience = createAudienceProjection(storage);
    const event = await catalog.createEvent({ name: "Private", timeZone: "UTC" }, authority);
    if (event.status !== "accepted") throw new Error("Expected Event.");
    await catalog.addGameDay(event.value.eventId, { date: "2026-08-14" }, authority);

    const unpublished = await audience.read(event.value.eventId);
    const unknown = await audience.read("event-does-not-exist");
    expect(unpublished).toEqual(unknown);
    expect(unpublished).toEqual({ status: "unavailable" });

    await catalog.changePublicationStatus(event.value.eventId, { status: "published" }, authority);
    await catalog.changePublicationStatus(
      event.value.eventId,
      { status: "cancelled", impactConfirmed: true },
      authority,
    );
    expect(await audience.read(event.value.eventId)).toEqual(PUBLIC_AUDIENCE_ABSENCE);
    expect(await audience.read("" as unknown)).toEqual({ status: "unavailable" });
    const anonymousResponses = await Promise.all(
      [event.value.eventId, "event-does-not-exist", ""].map((eventId) =>
        readAudienceEvent(
          new Request(`https://timer.example/api/audience/events/${eventId}`),
          audience,
        ),
      ),
    );
    expect(anonymousResponses.map((response) => response.status)).toEqual([404, 404, 404]);
    expect(await Promise.all(anonymousResponses.map((response) => response.text()))).toEqual([
      '{"status":"unavailable"}',
      '{"status":"unavailable"}',
      '{"status":"unavailable"}',
    ]);
    foundation.close();
  });

  test("projects only current allowlisted state and has no publication history", async () => {
    const foundation = createInMemoryFoundationStorage();
    const storage = createFoundationEventCatalogStorage(foundation);
    const catalog = createEventCatalog(storage, {});
    const audience = createAudienceProjection(storage);
    const event = await catalog.createEvent({ name: "Current", timeZone: "UTC" }, authority);
    if (event.status !== "accepted") throw new Error("Expected Event.");
    const day = await catalog.addGameDay(event.value.eventId, { date: "2026-08-14" }, authority);
    if (day.status !== "accepted") throw new Error("Expected Game Day.");
    await catalog.changePublicationStatus(event.value.eventId, { status: "published" }, authority);
    await catalog.changePublicationStatus(
      event.value.eventId,
      { status: "cancelled", impactConfirmed: true },
      authority,
    );
    await catalog.updateEvent(event.value.eventId, { name: "Current Renamed" }, authority);
    await catalog.changePublicationStatus(event.value.eventId, { status: "published" }, authority);

    const current = await audience.read(event.value.eventId);
    expect(current).toMatchObject({
      status: "accepted",
      value: {
        eventId: event.value.eventId,
        name: "Current Renamed",
        publicationStatus: "published",
        gameDays: ["2026-08-14"],
      },
    });
    if (current.status !== "accepted") return;
    expect(current.value).not.toHaveProperty("auditTrail");
    expect(current.value).not.toHaveProperty("createdAtMs");
    expect(JSON.stringify(current.value)).not.toContain("event-publication-changed");
    foundation.close();
  });

  test("collapses authoritative storage failure to the same public HTTP absence", async () => {
    const projection = createAudienceProjection(
      createUnavailableEventCatalogStorage("private storage detail"),
    );
    expect(await projection.read("published-event")).toEqual({ status: "retryable-failure" });

    const failureResponse = await readAudienceEvent(
      new Request("https://timer.example/api/audience/events/published-event"),
      projection,
    );
    const absenceResponse = await readAudienceEvent(
      new Request("https://timer.example/api/audience/events/unknown-event"),
      { read: async () => PUBLIC_AUDIENCE_ABSENCE },
    );
    expect(failureResponse.status).toBe(404);
    const failureBody = await failureResponse.text();
    expect(failureBody).toBe(await absenceResponse.text());
    expect(failureBody).not.toContain("private storage detail");
  });
});

function createScheduleSnapshot(input: {
  pitches: string[];
  games: EventGame[] | (() => EventGame[]);
  roots?: Map<string, EventGameRecordRoot>;
  expectedDelay?: () => number;
  placement?: (game: EventGame) => { pitchSlotId?: string; gameplaySlotId?: string };
  actions?: (root: EventGameRecordRoot) => ReturnType<typeof createFinishedAction>[];
}): EventCatalogStorageSnapshot {
  const event: StoredEvent = {
    eventId: "event-schedule",
    name: "Schedule Event",
    timeZone: "UTC",
    publicationStatus: "published",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  const gameDay = {
    gameDayId: "day-1",
    eventId: event.eventId,
    date: "2026-08-14",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  const pitchRows = input.pitches.map((name, index) => ({
    pitchId: `pitch-${index + 1}`,
    eventId: event.eventId,
    name,
    createdAtMs: 1,
    updatedAtMs: 1,
  }));
  const initialGames = typeof input.games === "function" ? input.games() : input.games;
  const currentGames = () =>
    (typeof input.games === "function" ? input.games() : input.games).map((game) => ({
      ...game,
      ...input.placement?.(game),
    }));
  const gameplaySlots = new Map(
    initialGames.map((game) => [
      game.gameplaySlotId,
      {
        gameplaySlotId: game.gameplaySlotId,
        eventId: event.eventId,
        gameDayId: gameDay.gameDayId,
        sequence: Number(game.gameCode?.replace(/\\D/g, "")) || 1,
        scheduledStartMs: Date.parse(game.gameDesignation ?? "2026-08-14T10:00:00.000Z"),
        expectedDelayMs: input.expectedDelay?.() ?? 0,
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    ]),
  );
  const pitchSlots = new Map(
    initialGames.flatMap((game) =>
      pitchRows.map((pitch, index) => {
        const pitchSlotId =
          index === pitchRows.findIndex((candidate) => candidate.name === game.sideA.sourceLabel)
            ? game.pitchSlotId
            : `${game.pitchSlotId}-${index + 1}`;
        return [
          pitchSlotId,
          {
            pitchSlotId,
            eventId: event.eventId,
            gameDayId: gameDay.gameDayId,
            pitchId: pitch.pitchId,
            gameplaySlotId: game.gameplaySlotId,
            sequence: 1,
            expectedDelayMs: 0,
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        ];
      }),
    ),
  );
  return {
    findEvent: (eventId: string) => (eventId === event.eventId ? event : null),
    listEvents: () => [event],
    listGameDays: () => [gameDay],
    findEventTeam: () => null,
    listEventTeams: () => [],
    listRoster: () => [],
    findRosterEntry: () => null,
    findPitch: (pitchId: string) => pitchRows.find((pitch) => pitch.pitchId === pitchId) ?? null,
    listPitches: () => pitchRows,
    findGameplaySlot: (slotId: string): GameplaySlot | null => {
      const slot = gameplaySlots.get(slotId);
      return slot === undefined
        ? null
        : { ...slot, expectedDelayMs: input.expectedDelay?.() ?? slot.expectedDelayMs };
    },
    listGameplaySlots: () =>
      [...gameplaySlots.values()].map((slot) => ({
        ...slot,
        expectedDelayMs: input.expectedDelay?.() ?? slot.expectedDelayMs,
      })),
    findPitchSlot: (slotId: string): PitchSlot | null => pitchSlots.get(slotId) ?? null,
    listPitchSlots: () => [...pitchSlots.values()],
    findEventGame: (gameId: string) =>
      currentGames().find((game) => game.eventGameId === gameId) ?? null,
    listEventGames: () => currentGames(),
    findRootByEventGameId: (gameId: string) => input.roots?.get(gameId) ?? null,
    listActions: (recordId: string) => {
      const root = [...(input.roots?.values() ?? [])].find(
        (candidate) => candidate.recordId === recordId,
      );
      if (root === undefined) return [];
      return (
        input.actions?.(root) ??
        (root.lifecycle.phase === "finished" ? [createFinishedAction(root)] : [])
      );
    },
    listAuditTrail: () => [],
  } as unknown as EventCatalogStorageSnapshot;
}

function createGoalAction(
  root: EventGameRecordRoot,
  gameSideId = root.gameSides[0]?.id ?? "side-a",
  suffix = "goal",
) {
  return createStoredAction(root, `${suffix}-${root.eventGameId}`, {
    factId: `${suffix}-fact-${root.eventGameId}`,
    factType: "goal",
    gameSideId,
    gameTimeMs: 1,
    data: { points: 10, sportingOrder: 1 },
  });
}

function createClockAction(root: EventGameRecordRoot) {
  return createStoredAction(root, `clock-${root.eventGameId}`, {
    factId: `clock-fact-${root.eventGameId}`,
    factType: "clock",
    gameSideId: null,
    gameTimeMs: 20 * 60 * 1000,
    data: {
      command: "correct",
      gameTimeMs: 20 * 60 * 1000,
      running: false,
      sportingOrder: 20 * 60 * 1000,
    },
  });
}

function createFlagCatchAction(root: EventGameRecordRoot) {
  return createStoredAction(root, `catch-${root.eventGameId}`, {
    factId: `catch-fact-${root.eventGameId}`,
    factType: "flag-catch",
    gameSideId: root.gameSides[0]?.id ?? "side-a",
    gameTimeMs: 20 * 60 * 1000,
    data: { points: 30, sportingOrder: 5 },
  });
}

function createFinishedAction(root: EventGameRecordRoot) {
  return createStoredAction(root, `finish-${root.eventGameId}`, {
    factId: `finish-fact-${root.eventGameId}`,
    factType: "result",
    gameSideId: root.gameSides[0]?.id ?? "side-a",
    gameTimeMs: 0,
    data: { resultKind: "concession", sportingOrder: 0 },
  });
}

function createStoredAction(
  root: EventGameRecordRoot,
  operationId: string,
  payload: Record<string, unknown>,
) {
  const input: ControlActionInput = {
    recordId: root.recordId,
    eventGameId: root.eventGameId,
    operationId,
    kind: { id: "game-fact", version: "1" },
    payload,
    causalPredecessorIds: [],
    occurrence: { trustedAtMs: 3, clientOriginAtMs: 3, source: "online" },
    grant: { sessionId: "test-session", versionId: "test-version" },
    lifecycle: structuredClone(root.lifecycle),
  };
  const prepared = prepareControlAction(input, root, createControlActionCodecRegistry(), 3);
  if (!prepared.ok) throw new Error(`Could not prepare finished fixture: ${prepared.error}`);
  return {
    action: materializeControlAction(prepared.value, 3),
    canonicalContent: prepared.value.canonicalContent,
    contentFingerprint: prepared.value.contentFingerprint,
  };
}

function createScheduleGame(code: string, scheduledStart: string, pitchName: string): EventGame {
  return {
    eventGameId: code,
    eventId: "event-schedule",
    gameDayId: "day-1",
    gameplaySlotId: `gameplay-${code}`,
    pitchSlotId: `pitch-slot-${code}`,
    gameCode: code,
    gameDesignation: scheduledStart,
    sideA: {
      sideId: `${code}-a`,
      eventTeamId: null,
      eventTeamName: "Blue",
      sourceLabel: pitchName,
      confirmedAtMs: null,
    },
    sideB: {
      sideId: `${code}-b`,
      eventTeamId: null,
      eventTeamName: "Red",
      sourceLabel: null,
      confirmedAtMs: null,
    },
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function createScheduleRoot(
  eventGameId: string,
  phase: EventGameRecordRoot["lifecycle"]["phase"],
): EventGameRecordRoot {
  return {
    recordId: `record-${eventGameId}`,
    eventId: "event-schedule",
    eventGameId,
    ownership: { eventId: "event-schedule", eventGameId },
    externalScope: {
      eventId: "event-schedule",
      gameDayId: "day-1",
      pitchId: "pitch-1",
      pitchSlotId: `pitch-slot-${eventGameId}`,
    },
    gameSides: [
      { id: `${eventGameId}-a`, eventTeamId: "team-a", teamInterpretationRef: "team-a-v1" },
      { id: `${eventGameId}-b`, eventTeamId: "team-b", teamInterpretationRef: "team-b-v1" },
    ],
    lifecycle: {
      phase,
      commencedAtMs: phase === "scheduled" ? null : 2,
      finishedAtMs: phase === "finished" ? 3 : null,
      lockedAtMs: null,
      lockReason: null,
    },
    compatibility: {
      recordVersion: "event-game-record-v1",
      schemaVersion: "event-game-record-v1",
      interpreterVersion: "live-event-iqa-v1",
    },
    creationEvidence: {
      operationId: `create-${eventGameId}`,
      actorReference: "test",
      source: "event-game-registration",
      createdAtMs: 1,
    },
  };
}
