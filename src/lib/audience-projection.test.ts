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
  type StoredEventTeam,
  type StoredRosterEntry,
  type StoredEvent,
} from "@/lib/event-catalog";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import type { ControllerGameFact, ControllerProjection } from "@/lib/live-event-game-control";
import { readAudienceProjectionGameInput } from "@/lib/live-event-game-runtime";
import {
  MemoryTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
} from "@/lib/technical-admin-auth";
import {
  readAudienceEvent,
  readAudienceEvents,
  readAudienceGame,
  readAudienceSitemap,
} from "@/index";
import { createInitialClockBaseline, projectClockBaseline } from "@/lib/clock-authority";
import type { ClockProjection } from "@/lib/clock-authority";
import { createInitialGamePresentation } from "@/lib/game-presentation-projection";

const authority = createTechnicalAdminAuth(
  { environment: "test", origin: "https://timer.example", rpId: "timer.example" },
  new MemoryTechnicalAdminAuthRepository(),
).resolveHostLocalAuthority();

describe("Audience Publication Projection", () => {
  test("keeps correction-time Event Game identity names while exposing neutral allowlisted state", async () => {
    const event: StoredEvent = {
      eventId: "event-identity",
      name: "Identity Event",
      timeZone: "UTC",
      publicationStatus: "published",
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const game = createScheduleGame("identity-game", "2026-08-14T10:00:00.000Z", "Pitch 1");
    game.sideA = {
      ...game.sideA,
      eventTeamId: "team-correction",
      eventTeamName: "Correction-time Team",
    };
    game.sideB = { ...game.sideB, eventTeamId: "team-other", eventTeamName: "Other Team" };
    const snapshot = {
      listEvents: () => [event],
      findEvent: () => event,
      listGameDays: () => [
        { gameDayId: "day-identity", eventId: event.eventId, date: "2026-08-14" },
      ],
      listEventGames: () => [game],
      listEventTeams: () => [
        {
          eventTeamId: "team-correction",
          eventId: event.eventId,
          name: "Renamed Later",
          defaultColor: "#123456",
        },
        {
          eventTeamId: "team-other",
          eventId: event.eventId,
          name: "Other Team",
          defaultColor: "#654321",
        },
      ],
      listPitches: () => [{ pitchId: "pitch-identity", eventId: event.eventId, name: "Pitch 1" }],
      listPitchSlots: () => [],
      listGameplaySlots: () => [],
      findEventGame: () => game,
      findEventTeam: () => null,
      listEventAuditTrail: () => [],
    } as unknown as EventCatalogStorageSnapshot;
    const audience = createAudienceProjection(
      { snapshot: async () => snapshot } as unknown as EventCatalogFoundationStorage,
      { now: () => Date.parse("2026-08-14T10:00:00.000Z") },
    );

    const result = await audience.read(event.eventId);
    expect(result).toMatchObject({
      status: "accepted",
      value: {
        eventGames: [
          {
            eventGameId: game.eventGameId,
            sides: [
              { eventTeamId: "team-correction", eventTeamName: "Correction-time Team" },
              { eventTeamId: "team-other", eventTeamName: "Other Team" },
            ],
          },
        ],
      },
    });
    if (result.status !== "accepted") return;
    expect(result.value).not.toHaveProperty("auditTrail");
    expect(result.value).not.toHaveProperty("reason");
  });

  test("fails closed on an injected live reader failure while preserving catalog-only projection", async () => {
    const game = createScheduleGame("live-failure", "2026-08-14T10:00:00.000Z", "Pitch 1");
    const root = createScheduleRoot("live-failure", "in-progress");
    const snapshot = createScheduleSnapshot({
      pitches: ["Pitch 1"],
      games: [game],
      roots: new Map([[game.eventGameId, root]]),
      actions: () => [createGoalAction(root)],
    });
    const storage = {
      snapshot: async () => snapshot,
    } as unknown as EventCatalogFoundationStorage;

    expect((await createAudienceProjection(storage).read("event-schedule")).status).toBe(
      "accepted",
    );
    for (const status of ["unavailable", "retryable-failure"] as const) {
      const audience = createAudienceProjection(storage, {
        gameInput: { read: async () => ({ status }) },
      });
      expect((await audience.read("event-schedule")).status).toBe(status);
    }
  });

  test("uses one runtime snapshot for Timeline semantics and scopes the neutral correction notice", async () => {
    const correctedGame = createScheduleGame(
      "runtime-corrected",
      "2026-08-14T10:00:00.000Z",
      "Pitch 1",
    );
    const ordinaryGame = createScheduleGame(
      "runtime-ordinary",
      "2026-08-14T11:00:00.000Z",
      "Pitch 1",
    );
    const correctedRoot = createScheduleRoot("runtime-corrected", "in-progress");
    const ordinaryRoot = createScheduleRoot("runtime-ordinary", "scheduled");
    const snapshot = createScheduleSnapshot({
      pitches: ["Pitch 1"],
      games: [correctedGame, ordinaryGame],
      roots: new Map([
        [correctedGame.eventGameId, correctedRoot],
        [ordinaryGame.eventGameId, ordinaryRoot],
      ]),
    });
    const runtimeProjection = createAudienceControllerProjection({
      overtime: true,
      overtimeTarget: 70,
      catch: {
        factId: "runtime-catch",
        catchingGameSideId: correctedRoot.gameSides[0]!.id,
        nonCatchingGameSideId: correctedRoot.gameSides[1]!.id,
        gameTimeMs: 1_000,
        targetScore: 70,
      },
      presentation: createInitialGamePresentation(
        [correctedRoot.gameSides[0]!.id, correctedRoot.gameSides[1]!.id],
        {
          [correctedRoot.gameSides[0]!.id]: "#123abc",
          [correctedRoot.gameSides[1]!.id]: "#456def",
        },
      ),
      gameFacts: [
        {
          factId: "runtime-catch",
          factType: "flag-catch",
          gameSideId: correctedRoot.gameSides[0]!.id,
          gameTimeMs: 1_000,
          sportingOrder: 1,
          synchronizationOrder: 1,
          effective: true,
          data: { points: 30 },
        },
      ],
      teamAssignmentCorrections: [
        {
          operationId: "private-correction-operation",
          gameSideId: correctedRoot.gameSides[0]!.id,
          eventTeamId: "team-current",
          eventTeamName: "Current Team",
          teamInterpretationRef: "private-interpretation",
        },
      ],
    });
    const correctedInput = readAudienceProjectionGameInput(correctedRoot, runtimeProjection);
    const ordinaryInput = readAudienceProjectionGameInput(
      ordinaryRoot,
      createAudienceControllerProjection({ phase: "scheduled" }),
    );
    const audience = createAudienceProjection(
      { snapshot: async () => snapshot } as unknown as EventCatalogFoundationStorage,
      {
        now: () => Date.parse("2026-08-14T10:00:00.000Z"),
        gameInput: {
          read: async (eventGameId) =>
            eventGameId === correctedGame.eventGameId ? correctedInput : ordinaryInput,
        },
      },
    );

    const result = await audience.read("event-schedule");
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.value.teamAssignmentNotice).toBe("event-team-assignment-corrected");
    const corrected = result.value.schedule.scheduleGames.find(
      (game) => game.eventGameId === correctedGame.eventGameId,
    );
    const ordinary = result.value.schedule.scheduleGames.find(
      (game) => game.eventGameId === ordinaryGame.eventGameId,
    );
    expect(corrected).toMatchObject({
      teamAssignmentNotice: "event-team-assignment-corrected",
      phase: "overtime",
      overtimeTarget: 70,
      presentation: { displayedTeamColors: { sideA: "#123abc", sideB: "#456def" } },
    });
    expect(corrected?.timeline.map((entry) => entry.kind)).toEqual(["overtime", "flag-catch"]);
    expect(ordinary).not.toHaveProperty("teamAssignmentNotice");
    expect(JSON.stringify(result.value)).not.toContain("private-correction-operation");
    expect(JSON.stringify(result.value)).not.toContain("private-interpretation");
  });

  test("embeds a roster-resolved Timeline and isolates roster reads by Event", async () => {
    const game = createScheduleGame("timeline", "2026-08-14T08:00:00.000Z", "Pitch 1");
    game.sideA = {
      ...game.sideA,
      eventTeamId: "team-corrected",
      eventTeamName: "Correction-time Blue",
    };
    const root = createScheduleRoot("timeline", "finished");
    const snapshot = createScheduleSnapshot({
      pitches: ["Pitch 1"],
      games: [game],
      roots: new Map([[game.eventGameId, root]]),
      actions: () => [createGoalAction(root)],
      eventTeams: [
        eventTeam("team-a", "event-schedule", "Original Team"),
        eventTeam("team-corrected", "event-schedule", "Renamed After Correction"),
        eventTeam("team-other-event", "other-event", "Wrong Event Team"),
      ],
      roster: [
        rosterEntry("roster-original", "event-schedule", "team-a", 3, "Wrong Original Player"),
        rosterEntry(
          "roster-corrected",
          "event-schedule",
          "team-corrected",
          3,
          "Current Goal Player",
        ),
        rosterEntry(
          "roster-other",
          "other-event",
          "team-other-event",
          3,
          "Private Other Event Name",
        ),
      ],
    });
    const audience = createAudienceProjection(
      { snapshot: async () => snapshot } as unknown as EventCatalogFoundationStorage,
      {
        now: () => Date.parse("2026-08-14T10:00:00.000Z"),
        gameInput: {
          read: async () => ({
            status: "accepted" as const,
            value: {
              gameSideIds: [root.gameSides[0]!.id, root.gameSides[1]!.id] as const,
              phase: "seeker-floor" as const,
              operationalStatus: "finished" as const,
              scoreByGameSide: {},
              clock: null,
              presentation: null,
              overtimeTarget: null,
              teamTimeout: { status: "inactive" as const, gameSideId: null, remainingMs: null },
              heatStoppage: {
                status: "inactive" as const,
                mode: null,
                pending: false,
                allowedDurationMs: null,
                actualDurationMs: null,
                remainingMs: null,
              },
              winnerGameSideId: null,
              catchingGameSideId: null,
              locked: true,
              gameFacts: [
                {
                  factId: `goal-fact-${root.eventGameId}`,
                  factType: "goal",
                  gameSideId: root.gameSides[0]!.id,
                  gameTimeMs: 1,
                  sportingOrder: 1,
                  synchronizationOrder: 1,
                  effective: true,
                  data: { points: 10, playerNumber: 3 },
                },
              ],
              timelineState: {
                catch: null,
                overtime: false,
                overtimeTarget: null,
                result: null,
              },
              teamAssignmentCorrected: false,
            },
          }),
        },
      },
    );

    const result = await audience.read("event-schedule");
    expect(result).toMatchObject({ status: "accepted" });
    if (result.status !== "accepted") return;
    const timeline = result.value.schedule.scheduleGames[0]?.timeline ?? [];
    expect(timeline).toContainEqual(
      expect.objectContaining({
        kind: "goal",
        teamName: "Correction-time Blue",
        player: { number: 3, name: "Current Goal Player" },
      }),
    );
    expect(JSON.stringify(timeline)).not.toContain("Private Other Event Name");

    const dedicatedGame = await audience.readGame("event-schedule", game.eventGameId);
    expect(dedicatedGame).toMatchObject({ status: "accepted" });
    if (dedicatedGame.status !== "accepted") return;
    expect(dedicatedGame.value.timeline).toContainEqual(
      expect.objectContaining({
        kind: "goal",
        teamName: "Correction-time Blue",
        player: { number: 3, name: "Current Goal Player" },
      }),
    );
  });

  test("keeps effective locked-correction history across reopening without public provenance", async () => {
    const game = createScheduleGame("locked-reopen", "2026-08-14T08:00:00.000Z", "Pitch 1");
    const root = createScheduleRoot("locked-reopen", "finished");
    const snapshot = createScheduleSnapshot({
      pitches: ["Pitch 1"],
      games: [game],
      roots: new Map([[game.eventGameId, root]]),
    });
    const publicFacts: readonly ControllerGameFact[] = [
      {
        factId: "corrected-goal",
        factType: "goal",
        gameSideId: root.gameSides[0]!.id,
        gameTimeMs: 1_000,
        sportingOrder: 1,
        synchronizationOrder: 1,
        effective: true,
        data: { points: 30, playerNumber: 3 },
      },
      {
        factId: "corrected-result",
        factType: "result",
        gameSideId: root.gameSides[0]!.id,
        gameTimeMs: 2_000,
        sportingOrder: 2,
        synchronizationOrder: 2,
        effective: true,
        data: { resultKind: "corrected-result" },
      },
      {
        factId: "private-locked-correction",
        factType: "locked-game-correction",
        gameSideId: null,
        gameTimeMs: null,
        sportingOrder: 3,
        synchronizationOrder: 3,
        effective: true,
        data: { reason: "PRIVATE_LOCKED_CORRECTION_REASON" },
      },
      {
        factId: "private-game-reopening",
        factType: "game-reopening",
        gameSideId: null,
        gameTimeMs: null,
        sportingOrder: 4,
        synchronizationOrder: 4,
        effective: true,
        data: { operationId: "PRIVATE_REOPEN_OPERATION" },
      },
    ];
    let locked = true;
    const audience = createAudienceProjection(
      { snapshot: async () => snapshot } as unknown as EventCatalogFoundationStorage,
      {
        now: () => Date.parse("2026-08-14T10:00:00.000Z"),
        gameInput: {
          read: async () => ({
            status: "accepted" as const,
            value: {
              gameSideIds: [root.gameSides[0]!.id, root.gameSides[1]!.id] as const,
              phase: "seeker-floor" as const,
              operationalStatus: "finished" as const,
              scoreByGameSide: { [root.gameSides[0]!.id]: 30, [root.gameSides[1]!.id]: 20 },
              clock: null,
              presentation: null,
              overtimeTarget: null,
              teamTimeout: { status: "inactive" as const, gameSideId: null, remainingMs: null },
              heatStoppage: {
                status: "inactive" as const,
                mode: null,
                pending: false,
                allowedDurationMs: null,
                actualDurationMs: null,
                remainingMs: null,
              },
              winnerGameSideId: root.gameSides[0]!.id,
              catchingGameSideId: root.gameSides[0]!.id,
              locked,
              gameFacts: publicFacts,
              timelineState: {
                catch: null,
                overtime: false,
                overtimeTarget: null,
                result: { factId: "corrected-result" },
              },
              teamAssignmentCorrected: false,
            },
          }),
        },
      },
    );

    const beforeReopen = await audience.readGame("event-schedule", game.eventGameId);
    expect(beforeReopen).toMatchObject({
      status: "accepted",
      value: {
        result: { status: "finished", winner: "side-a", locked: true },
        flagState: { catchingSide: "side-a" },
      },
    });
    if (beforeReopen.status !== "accepted") return;
    locked = false;
    const afterReopen = await audience.readGame("event-schedule", game.eventGameId);
    expect(afterReopen).toMatchObject({
      status: "accepted",
      value: { result: { status: "finished", winner: "side-a", locked: false } },
    });
    if (afterReopen.status !== "accepted") return;
    expect(afterReopen.value.timeline).toEqual(beforeReopen.value.timeline);
    expect(afterReopen.value.timeline.map((entry) => entry.kind)).toEqual(["finish", "goal"]);
    const serialized = JSON.stringify(afterReopen.value);
    expect(serialized).not.toContain("locked-game-correction");
    expect(serialized).not.toContain("game-reopening");
    expect(serialized).not.toContain("PRIVATE_LOCKED_CORRECTION_REASON");
    expect(serialized).not.toContain("PRIVATE_REOPEN_OPERATION");
  });

  test("projects concession, forfeit, and double-forfeit outcomes", async () => {
    const games = [
      createScheduleGame("concession", "2026-08-14T08:00:00.000Z", "Pitch 1"),
      createScheduleGame("forfeit", "2026-08-14T08:01:00.000Z", "Pitch 1"),
      createScheduleGame("double-forfeit", "2026-08-14T08:02:00.000Z", "Pitch 1"),
    ];
    const roots = new Map(
      games.map((game) => [game.eventGameId, createScheduleRoot(game.eventGameId, "finished")]),
    );
    const outcomeByGame: Record<string, "concession" | "forfeit" | "double-forfeit"> = {
      concession: "concession",
      forfeit: "forfeit",
      "double-forfeit": "double-forfeit",
    };
    const snapshot = createScheduleSnapshot({
      pitches: ["Pitch 1"],
      games,
      roots,
      actions: (root) => [createOutcomeAction(root, outcomeByGame[root.eventGameId]!)],
    });
    const audience = createAudienceProjection(
      { snapshot: async () => snapshot } as unknown as EventCatalogFoundationStorage,
      { now: () => Date.parse("2026-08-14T10:00:00.000Z") },
    );

    const result = await audience.read("event-schedule");
    expect(result).toMatchObject({ status: "accepted" });
    if (result.status !== "accepted") return;
    expect(
      result.value.schedule.scheduleGames.map(
        (game) => game.timeline.find((entry) => entry.kind === "finish")?.outcome,
      ),
    ).toEqual(["concession", "forfeit", "double-forfeit"]);
    expect(result.value.schedule.scheduleGames[2]?.timeline).toContainEqual(
      expect.objectContaining({ kind: "finish", lane: "center", teamName: null }),
    );
  });

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
    expect(schedule.scheduleGames.find((game) => game.gameCode === "awaiting")).toMatchObject({
      scheduleStatus: "awaiting-start",
      operationalStatus: "scheduled",
    });
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

  test("regenerates committed sporting input and Pitch reassignment", async () => {
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

  test("projects one Published Event Game through the strict public allowlist", async () => {
    const event = {
      eventId: "event-public",
      name: "Public Event",
      timeZone: "UTC",
      publicationStatus: "published" as const,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const game = {
      eventGameId: "event-game-public",
      eventId: event.eventId,
      gameDayId: "day-public",
      gameplaySlotId: "slot-public",
      pitchSlotId: "pitch-slot-public",
      gameCode: "A1",
      gameDesignation: "Semi-final",
      sideA: {
        sideId: "catalog-side-a",
        eventTeamId: "team-a",
        eventTeamName: "Very Long Home Team Name",
        sourceLabel: null,
        confirmedAtMs: 1,
      },
      sideB: {
        sideId: "catalog-side-b",
        eventTeamId: "team-b",
        eventTeamName: "Very Long Away Team Name",
        sourceLabel: null,
        confirmedAtMs: 1,
      },
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const snapshot = {
      findEvent: (eventId: string) => (eventId === event.eventId ? event : null),
      findEventGame: (eventGameId: string) => (eventGameId === game.eventGameId ? game : null),
      findRootByEventGameId: () => null,
      findGameplaySlot: () => ({
        gameplaySlotId: "slot-public",
        eventId: event.eventId,
        gameDayId: "day-public",
        sequence: 1,
        scheduledStartMs: 10_000,
        expectedDelayMs: 2_000,
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
      findPitchSlot: () => ({
        pitchSlotId: "pitch-slot-public",
        eventId: event.eventId,
        gameDayId: "day-public",
        pitchId: "pitch-public",
        gameplaySlotId: "slot-public",
        sequence: 1,
        expectedDelayMs: 5_000,
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
      findPitch: () => ({
        pitchId: "pitch-public",
        eventId: event.eventId,
        name: "Pitch A",
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
      listPitches: () => [
        {
          pitchId: "pitch-public",
          eventId: event.eventId,
          name: "Pitch A",
          createdAtMs: 1,
          updatedAtMs: 1,
        },
        {
          pitchId: "pitch-public-b",
          eventId: event.eventId,
          name: "Pitch B",
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      ],
      findEventTeam: (eventTeamId: string) => ({
        eventTeamId,
        eventId: event.eventId,
        name: eventTeamId === "team-a" ? "Very Long Home Team Name" : "Very Long Away Team Name",
        defaultColor: eventTeamId === "team-a" ? "#112233" : "#445566",
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
    } as unknown as EventCatalogStorageSnapshot;
    const clock = projectClockBaseline(
      { ...createInitialClockBaseline(), gameTimeMs: 12_000, lastAcceptedAtMs: 12_000 },
      12_000,
    );
    const audience = createAudienceProjection(
      { snapshot: async () => snapshot } as unknown as EventCatalogFoundationStorage,
      {
        now: () => 12_000,
        gameInput: {
          read: async () => ({
            status: "accepted" as const,
            value: {
              gameSideIds: ["stable-side-a", "stable-side-b"] as const,
              phase: "seekers-released" as const,
              operationalStatus: "paused" as const,
              scoreByGameSide: { "stable-side-a": 10, "stable-side-b": 20 },
              clock,
              presentation: {
                ...createInitialGamePresentation(["stable-side-a", "stable-side-b"], {
                  "stable-side-a": "#abcdef",
                  "stable-side-b": "#fedcba",
                }),
                pitchOrientation: "side-b-left" as const,
              },
              overtimeTarget: null,
              teamTimeout: { status: "inactive" as const, gameSideId: null, remainingMs: null },
              heatStoppage: {
                status: "started" as const,
                mode: "enabled" as const,
                pending: true,
                allowedDurationMs: 120_000,
                actualDurationMs: 90_000,
                remainingMs: 30_000,
              },
              winnerGameSideId: null,
              catchingGameSideId: null,
              locked: false,
              gameFacts: [],
              timelineState: {
                catch: null,
                overtime: false,
                overtimeTarget: null,
                result: null,
              },
              teamAssignmentCorrected: false,
            },
          }),
        },
      },
    );

    const result = await audience.readGame(event.eventId, game.eventGameId);
    expect(result).toMatchObject({
      status: "accepted",
      value: {
        eventId: event.eventId,
        gameCode: "A1",
        operationalStatus: "paused",
        phase: "seekers-released",
        scheduledStartMs: 10_000,
        expectedStartMs: 15_000,
        pitch: "Pitch A",
        sideA: { name: "Very Long Home Team Name", color: "#abcdef", score: 10 },
        sideB: { name: "Very Long Away Team Name", color: "#fedcba", score: 20 },
        presentation: {
          pitchOrientation: "side-b-left",
          displayedTeamColors: { sideA: "#abcdef", sideB: "#fedcba" },
        },
        teamTimeout: { status: "inactive", side: null, remainingMs: null },
        heatStoppage: {
          status: "started",
          mode: "enabled",
          pending: true,
          allowedDurationMs: 120_000,
          actualDurationMs: 90_000,
          remainingMs: 30_000,
        },
        flagState: { catchingSide: null },
        result: { status: "unfinished", winner: null, locked: false },
      },
    });
    if (result.status !== "accepted") return;
    const serialized = JSON.stringify(result.value);
    expect(Object.keys(result.value)).not.toContain("timeout");
    expect(Object.keys(result.value)).not.toContain("suspension");
    expect(Object.keys(result.value)).not.toContain("stoppage");
    expect(Object.keys(result.value)).not.toContain("heat");
    expect(Object.keys(result.value)).not.toContain("winner");
    expect(serialized).not.toContain('"caught"');
    expect(serialized).not.toContain('"flagCatch"');
    expect(serialized).not.toContain("grant");
    expect(serialized).not.toContain("session");
    expect(serialized).not.toContain("action");
    expect(serialized).not.toContain("audit");
    expect(serialized).not.toContain("correction");
    expect(serialized).not.toContain("provenance");
    expect(serialized).not.toContain("authority");
    const gameUrl = `https://timer.example/api/audience/events/${event.eventId}/games/${game.eventGameId}`;
    const httpResponse = await readAudienceGame(new Request(gameUrl), audience);
    expect(httpResponse.status).toBe(200);
    expect(httpResponse.headers.get("cache-control")).toBe("no-cache");
    const etag = httpResponse.headers.get("etag");
    expect(etag).not.toBeNull();
    const revalidated = await readAudienceGame(
      new Request(gameUrl, { headers: { "if-none-match": etag ?? "" } }),
      audience,
    );
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");
    expect(await httpResponse.text()).toContain('"status":"accepted"');
  });

  test("keeps hidden and unknown Event Game routes anonymously absent", async () => {
    const projection = {
      readGame: async () => ({ status: "unavailable" as const }),
    };
    const responses = await Promise.all(
      ["hidden", "unknown"].map((eventId) =>
        readAudienceGame(
          new Request(`https://timer.example/api/audience/events/${eventId}/games/game-1`),
          projection,
        ),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([404, 404]);
    const bodies = await Promise.all(responses.map((response) => response.text()));
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[0]).toBe('{"status":"unavailable"}');
    expect(responses[0]?.headers.get("cache-control")).toBe("no-store");
    expect(responses[0]?.headers.get("x-robots-tag")).toBe("noindex");
  });

  test("table-drives the runtime adapter through the one public projector", async () => {
    const nowMs = Date.parse("2026-08-14T10:00:00.000Z");
    const game = createScheduleGame("adapter", "2026-08-14T09:30:00.000Z", "Pitch 1");
    const baseRoot = createScheduleRoot("adapter", "in-progress");
    const baseSnapshot = createScheduleSnapshot({
      pitches: ["Pitch 1"],
      games: [game],
      roots: new Map([["adapter", baseRoot]]),
    });
    const sentinel = {
      grant: "PRIVATE_GRANT_SENTINEL_135",
      session: "PRIVATE_SESSION_SENTINEL_135",
      action: "PRIVATE_ACTION_SENTINEL_135",
      audit: "PRIVATE_AUDIT_SENTINEL_135",
      correction: "PRIVATE_CORRECTION_SENTINEL_135",
      authority: "PRIVATE_AUTHORITY_SENTINEL_135",
      provenance: "PRIVATE_PROVENANCE_SENTINEL_135",
    } as const;
    const cases: readonly {
      name: string;
      root?: EventGameRecordRoot;
      projection: ControllerProjection;
      expected: Record<string, unknown>;
      sentinels?: readonly string[];
    }[] = [
      {
        name: "awaiting-start",
        root: { ...baseRoot, lifecycle: { ...baseRoot.lifecycle, phase: "scheduled" } },
        projection: createAudienceControllerProjection({ phase: "scheduled" }),
        expected: { scheduleStatus: "awaiting-start", operationalStatus: "scheduled" },
      },
      {
        name: "running",
        projection: createAudienceControllerProjection({
          clock: createAudienceClock({ running: true, synchronization: "synchronized" }),
        }),
        expected: { scheduleStatus: "running", operationalStatus: "running" },
      },
      {
        name: "paused-stale",
        projection: createAudienceControllerProjection({
          clock: createAudienceClock({ synchronization: "stale" }),
        }),
        expected: { operationalStatus: "paused", clock: { synchronization: "stale" } },
      },
      {
        name: "paused-estimated",
        projection: createAudienceControllerProjection({
          clock: createAudienceClock({ synchronization: "estimated" }),
        }),
        expected: { operationalStatus: "paused", clock: { synchronization: "estimated" } },
      },
      {
        name: "disconnected-clock",
        projection: createAudienceControllerProjection({
          clock: createAudienceClock({
            synchronization: "unavailable",
            lastSynchronizedAtMs: null,
          }),
        }),
        expected: {
          operationalStatus: "paused",
          clock: { synchronization: "unavailable", lastSynchronizedAtMs: null },
        },
      },
      {
        name: "overtime-target",
        projection: createAudienceControllerProjection({
          overtime: true,
          overtimeTarget: 60,
        }),
        expected: { phase: "overtime", overtimeTarget: 60 },
      },
      {
        name: "flag-catch",
        projection: createAudienceControllerProjection({
          scoreByGameSide: { "adapter-a": 30, "adapter-b": 20 },
          winnerGameSideId: "adapter-a",
          catch: {
            factId: "catch-fact",
            catchingGameSideId: "adapter-a",
            nonCatchingGameSideId: "adapter-b",
            gameTimeMs: 20 * 60 * 1000,
            targetScore: 40,
          },
        }),
        expected: {
          sideA: { score: 30 },
          sideB: { score: 20 },
          flagState: { catchingSide: "side-a" },
          result: { winner: "side-a" },
        },
      },
      {
        name: "team-timeout",
        projection: createAudienceControllerProjection({
          timeout: {
            status: "started",
            factId: "timeout-fact",
            gameSideId: "adapter-b",
            remainingMs: 15_000,
          },
        }),
        expected: { teamTimeout: { status: "started", side: "side-b", remainingMs: 15_000 } },
      },
      {
        name: "game-suspension",
        projection: createAudienceControllerProjection({ phase: "suspended" }),
        expected: {
          operationalStatus: "suspended",
          gameSuspension: "suspended",
        },
      },
      {
        name: "heat-stoppage",
        projection: createAudienceControllerProjection({
          heat: {
            status: "started",
            factId: "heat-fact",
            startedAtGameTimeMs: 90_000,
            nominalDurationMs: 120_000,
            allowedDurationMs: 120_000,
            actualDurationMs: 90_000,
            completionAtTrustedAtMs: nowMs + 30_000,
            mode: "enabled",
            pendingTriggerGameTimeMs: null,
          },
        }),
        expected: {
          heatStoppage: { status: "started", remainingMs: 30_000 },
        },
      },
      {
        name: "finished-locked",
        root: {
          ...baseRoot,
          lifecycle: { ...baseRoot.lifecycle, phase: "finished", lockedAtMs: nowMs },
        },
        projection: createAudienceControllerProjection({
          phase: "finished",
          winnerGameSideId: "adapter-b",
          result: {
            factId: "result-fact",
            data: { resultKind: "concession", private: sentinel.correction },
          },
        }),
        expected: {
          operationalStatus: "finished",
          result: { status: "finished", winner: "side-b", locked: true },
        },
      },
      {
        name: "private-source-sentinels",
        projection: createAudienceControllerProjection({
          clock: createAudienceClock({
            baseline: {
              ...createInitialClockBaseline(),
              holderGrantSessionId: sentinel.session,
              lastTransitionOperationId: sentinel.action,
              staleGenerationOperationIds: [sentinel.authority],
            },
          }),
          timeout: {
            status: "started",
            factId: sentinel.grant,
            gameSideId: "adapter-a",
            remainingMs: 10_000,
          },
          suspension: { status: "suspended", factId: sentinel.correction, snapshot: null },
          stoppage: { status: "suspension", factId: sentinel.provenance },
          heat: {
            status: "started",
            factId: sentinel.action,
            startedAtGameTimeMs: 1,
            nominalDurationMs: 120_000,
            allowedDurationMs: 120_000,
            actualDurationMs: 90_000,
            completionAtTrustedAtMs: nowMs + 30_000,
            mode: "enabled",
            pendingTriggerGameTimeMs: null,
          },
          result: { factId: sentinel.audit, data: { private: sentinel.authority } },
          catch: {
            factId: sentinel.action,
            catchingGameSideId: "adapter-a",
            nonCatchingGameSideId: "adapter-b",
            gameTimeMs: 1,
            targetScore: 40,
          },
          gameFacts: [
            {
              factId: sentinel.audit,
              factType: "private",
              gameSideId: null,
              gameTimeMs: null,
              sportingOrder: 0,
              synchronizationOrder: 0,
              effective: true,
              data: { private: sentinel.session },
            },
          ],
        }),
        expected: {
          operationalStatus: "paused",
          heatStoppage: { remainingMs: 30_000 },
        },
        sentinels: Object.values(sentinel),
      },
    ];

    for (const scenario of cases) {
      const input = readAudienceProjectionGameInput(scenario.root ?? baseRoot, scenario.projection);
      expect(input.status, scenario.name).toBe("accepted");
      if (input.status !== "accepted") continue;
      const audience = createAudienceProjection(
        { snapshot: async () => baseSnapshot } as unknown as EventCatalogFoundationStorage,
        {
          now: () => nowMs,
          gameInput: { read: async () => input },
        },
      );
      const result = await audience.readGame("event-schedule", "adapter");
      expect(result.status, scenario.name).toBe("accepted");
      if (result.status !== "accepted") continue;
      expect(result.value, scenario.name).toMatchObject(scenario.expected);
      for (const privateSentinel of scenario.sentinels ?? []) {
        expect(JSON.stringify(scenario.projection)).toContain(privateSentinel);
        expect(JSON.stringify(result.value)).not.toContain(privateSentinel);
      }
    }
  });
});

function createAudienceClock(overrides: Partial<ClockProjection> = {}): ClockProjection {
  const baseline = createInitialClockBaseline();
  const projection = projectClockBaseline(baseline, 12_000);
  return {
    ...projection,
    ...overrides,
    baseline: { ...projection.baseline, ...overrides.baseline },
    cues: { ...projection.cues, ...overrides.cues },
  };
}

function createAudienceControllerProjection(
  overrides: Partial<ControllerProjection> = {},
): ControllerProjection {
  return {
    eventGameId: "adapter",
    phase: "in-progress",
    scoreByGameSide: { "adapter-a": 0, "adapter-b": 0 },
    goalCount: 0,
    timeout: {
      status: "inactive",
      factId: null,
      gameSideId: null,
      remainingMs: null,
    },
    suspension: { status: "none", factId: null, snapshot: null },
    stoppage: { status: "none", factId: null },
    heat: {
      status: "inactive",
      factId: null,
      startedAtGameTimeMs: null,
      nominalDurationMs: null,
      mode: "enabled",
      pendingTriggerGameTimeMs: null,
    },
    result: null,
    overtime: false,
    overtimeTarget: null,
    winnerGameSideId: null,
    catch: null,
    commencement: {
      status: "commenced",
      commencedAtMs: 1,
      provisionalRunningSinceMs: null,
      provisionalElapsedMs: 0,
    },
    clock: createAudienceClock(),
    presentation: {
      gameSideIds: ["adapter-a", "adapter-b"],
      pitchOrientation: "side-a-left",
      displayedTeamColors: { "adapter-a": "#112233", "adapter-b": "#445566" },
    },
    ...overrides,
  };
}

function createScheduleSnapshot(input: {
  pitches: string[];
  games: EventGame[] | (() => EventGame[]);
  roots?: Map<string, EventGameRecordRoot>;
  expectedDelay?: () => number;
  placement?: (game: EventGame) => { pitchSlotId?: string; gameplaySlotId?: string };
  actions?: (root: EventGameRecordRoot) => ReturnType<typeof createFinishedAction>[];
  eventTeams?: StoredEventTeam[];
  roster?: StoredRosterEntry[];
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
    findEventTeam: (eventTeamId: string) =>
      input.eventTeams?.find((team) => team.eventTeamId === eventTeamId) ?? null,
    listEventTeams: (eventId: string) =>
      input.eventTeams?.filter((team) => team.eventId === eventId) ?? [],
    listRoster: (eventTeamId: string) =>
      input.roster?.filter((entry) => entry.eventTeamId === eventTeamId) ?? [],
    findRosterEntry: (eventTeamId: string, playerNumber: number) =>
      input.roster?.find(
        (entry) => entry.eventTeamId === eventTeamId && entry.playerNumber === playerNumber,
      ) ?? null,
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
    data: { points: 10, playerNumber: 3, sportingOrder: 1 },
  });
}

function eventTeam(eventTeamId: string, eventId: string, name: string): StoredEventTeam {
  return { eventTeamId, eventId, name, defaultColor: "#112233", createdAtMs: 1, updatedAtMs: 1 };
}

function rosterEntry(
  rosterEntryId: string,
  eventId: string,
  eventTeamId: string,
  playerNumber: number,
  publicName: string,
): StoredRosterEntry {
  return {
    rosterEntryId,
    eventId,
    eventTeamId,
    playerNumber,
    publicName,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
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

function createOutcomeAction(
  root: EventGameRecordRoot,
  factType: "concession" | "forfeit" | "double-forfeit",
) {
  return createStoredAction(root, `${factType}-${root.eventGameId}`, {
    factId: `${factType}-fact-${root.eventGameId}`,
    factType,
    gameSideId: factType === "double-forfeit" ? null : (root.gameSides[0]?.id ?? "side-a"),
    gameTimeMs: 0,
    data: { resultKind: factType, sportingOrder: 0 },
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
