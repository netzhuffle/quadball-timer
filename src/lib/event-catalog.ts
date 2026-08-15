import {
  normalizeBoundedText,
  SHARED_LIMITS,
  validatePlayerNumber,
  validateOpaqueIdentifier,
} from "@/lib/validation-policy";
import { DEFAULT_HOME_TEAM_COLOR, parseHexColor } from "@/lib/team-colors";
import {
  isTechnicalAdminAuthority,
  type TechnicalAdminAuthority,
} from "@/lib/technical-admin-auth";
import {
  EVENT_CATALOG_STORAGE_CAPABILITY_IMPLEMENTATION,
  EVENT_CATALOG_STORAGE_CAPABILITY_NAME,
  EVENT_CATALOG_STORAGE_CAPABILITY_VERSION,
  REQUIRED_EVENT_CATALOG_STORAGE_TRANSACTION_METHODS,
  assertEventCatalogStorageCapability,
  requireEventCatalogStorageCapabilities,
} from "@/lib/foundation-storage";
import type {
  EventCatalogAuditEntry,
  FoundationStorage,
  FoundationStorageSnapshot,
  FoundationStorageTransaction,
  EventCatalogStorageCapability,
  StoredEventCatalogEvent,
  StoredEventCatalogGameDay,
  StoredEventCatalogTeam,
  StoredEventCatalogRosterEntry,
  StoredEventCatalogPitch,
  StoredGameplaySlot,
  StoredPitchSlot,
  StoredEventCatalogGame,
  StoredEventGameSide,
  StoredControlAction,
} from "@/lib/foundation-storage";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import { canonicalizeJson, sha256 } from "@/lib/event-game-action-json";
import { DEFAULT_HEAT_STOPPAGE_CONFIGURATION } from "@/lib/heat-stoppage-configuration";

export type EventPublicationStatus = "unpublished" | "published" | "cancelled";
export type EventPublicationWarning =
  | "missing-event-teams"
  | "missing-pitches"
  | "missing-gameplay-slots"
  | "missing-pitch-slots"
  | "missing-event-games"
  | "unresolved-matchups";
export type EventLifecycle = "unscheduled" | "future" | "current" | "past";
export type GameDayClassification = "future" | "current" | "past";

export type StoredEvent = StoredEventCatalogEvent;
export type StoredGameDay = StoredEventCatalogGameDay;
export type StoredEventTeam = StoredEventCatalogTeam;
export type StoredRosterEntry = StoredEventCatalogRosterEntry;
export type StoredPitch = StoredEventCatalogPitch;
export type GameplaySlot = StoredGameplaySlot;
export type PitchSlot = StoredPitchSlot;
export type EventGame = StoredEventCatalogGame;
export type EventGameSide = StoredEventGameSide;
export type EventAdministrationAuditEntry = EventCatalogAuditEntry;

/** Bounded scheduled playing period used until a commenced Game supplies actual timing. */
export const DEFAULT_EVENT_GAME_PLAYING_DURATION_MS = 30 * 60 * 1000;

export type EventGamePlayingPeriod = {
  startMs: number;
  endMs: number;
};

/** Canonical Expected Start projection shared by schedule and handoff views. */
export function projectExpectedStartMs(
  gameplaySlot: Pick<GameplaySlot, "scheduledStartMs" | "expectedDelayMs"> | null,
  pitchSlot: Pick<PitchSlot, "expectedDelayMs"> | null,
): number {
  const scheduledStartMs = gameplaySlot?.scheduledStartMs ?? 0;
  const gameplayDelayMs = gameplaySlot?.expectedDelayMs ?? 0;
  const pitchDelayMs = pitchSlot?.expectedDelayMs ?? 0;
  return scheduledStartMs + Math.max(gameplayDelayMs, pitchDelayMs);
}

export type ProjectedEventGame = EventGame & {
  expectedStartMs: number;
  expectedPlayingPeriod: EventGamePlayingPeriod;
  scheduleConflict: boolean;
  teamScheduleConflict: boolean;
};

export type EventGameDay = StoredGameDay & {
  classification: GameDayClassification;
};

export type EventTeamProjection = StoredEventTeam & {
  roster: readonly StoredRosterEntry[];
};

export type AudienceRosterProjection = {
  playerNumber: number;
  publicName: string | null;
};

export type EventProjection = StoredEvent & {
  lifecycle: EventLifecycle;
  gameDays: readonly EventGameDay[];
  teams: readonly EventTeamProjection[];
  pitches: readonly StoredPitch[];
  gameplaySlots: readonly GameplaySlot[];
  pitchSlots: readonly PitchSlot[];
  eventGames: readonly ProjectedEventGame[];
  auditTrail: readonly EventAdministrationAuditEntry[];
};

export type EventPublicationStatusChange = {
  event: EventProjection;
  previousStatus: EventPublicationStatus;
  publicationStatus: EventPublicationStatus;
  warnings: readonly EventPublicationWarning[];
};

/** Shared projection seam for composed Event Administration workflows. */
export function projectEventProjection(
  event: StoredEvent,
  gameDays: readonly StoredGameDay[],
  auditTrail: readonly EventAdministrationAuditEntry[],
  nowMs: number,
  teams: readonly StoredEventTeam[] = [],
  roster: readonly StoredEventCatalogRosterEntry[] = [],
  pitches: readonly StoredEventCatalogPitch[] = [],
  gameplaySlots: readonly StoredGameplaySlot[] = [],
  pitchSlots: readonly StoredPitchSlot[] = [],
  eventGames: readonly StoredEventCatalogGame[] = [],
): EventProjection {
  return project(
    event,
    gameDays,
    auditTrail,
    nowMs,
    teams,
    roster,
    pitches,
    gameplaySlots,
    pitchSlots,
    eventGames,
  );
}

export type CatalogRejectedReason =
  | "invalid-input"
  | "unauthorized"
  | "not-found"
  | "cross-event"
  | "duplicate"
  | "no-change"
  | "in-use";

export type EventCatalogRemovalKind =
  | "event"
  | "event-team"
  | "game-day"
  | "pitch"
  | "gameplay-slot"
  | "pitch-slot"
  | "event-game";

export type EventCatalogRemovalTargetInput = {
  kind: unknown;
  eventId: unknown;
  targetId: unknown;
};

export type EventCatalogRemovalTarget = {
  kind: EventCatalogRemovalKind;
  eventId: string;
  targetId: string;
};

export type EventCatalogRemovalImpact = {
  descendantCount: number;
  retiredAuthorityCount: number;
  retiredAuthorityCategories: {
    eventAdmin: number;
    pitchManager: number;
    control: number;
  };
  retainedEventGameCount: number;
  retainedControlActionCount: number;
};

export type EventCatalogRemovalPreview = {
  target: EventCatalogRemovalTarget;
  eligible: boolean;
  rejectionCategory: "referenced" | "commenced" | "accepted-control-action" | null;
  repairWorkflow: string | null;
  impact: EventCatalogRemovalImpact;
  fingerprint: string;
};

export type EventCatalogRemovalResult = {
  removed: true;
  target: EventCatalogRemovalTarget;
  retiredAuthorityCount: number;
  retainedEventGameCount: number;
  retainedControlActionCount: number;
};

export type CatalogOutcome<T> =
  | { status: "accepted"; value: T }
  | { status: "rejected"; reason: CatalogRejectedReason; detail: string }
  | { status: "retryable-failure"; detail: string };

export type EventCatalogClock = {
  nowMs(): number;
};

export type EventCatalogIds = {
  next(
    kind:
      | "event"
      | "game-day"
      | "audit"
      | "operation"
      | "gameplay-slot"
      | "pitch-slot"
      | "event-game"
      | "event-game-side",
  ): string;
};

export type EventCatalogOptions = {
  clock?: EventCatalogClock;
  ids?: EventCatalogIds;
};

/** Trusted transaction-local catalog seam used when a record and catalog mutation must commit together. */
export function correctEventGameIdentityInTransaction(
  transaction: FoundationStorageTransaction,
  clock: EventCatalogClock,
  ids: EventCatalogIds,
  eventId: unknown,
  gameDayId: unknown,
  eventGameId: unknown,
  input: EventGameIdentityCorrectionInput,
  actorReference: string,
): CatalogOutcome<EventGameIdentityCorrection> {
  return correctEventGameIdentityOperation(
    eventCatalogTransaction(transaction),
    clock,
    ids,
    eventId,
    gameDayId,
    eventGameId,
    input,
    actorReference,
  );
}

/**
 * Reconciles the catalog projection with the already-canonical Record winner.
 * The Record decides lifecycle, ordering, and conflicts; the catalog only keeps
 * its public Event Team identity in step and records the resulting catalog edit.
 */
export function reconcileEventGameIdentityInTransaction(
  transaction: FoundationStorageTransaction,
  ids: EventCatalogIds,
  eventIdInput: unknown,
  gameDayIdInput: unknown,
  eventGameIdInput: unknown,
  gameSideIdInput: unknown,
  eventTeamIdInput: unknown,
  actorReference: string,
): CatalogOutcome<EventGame> {
  const eventId = validateId(eventIdInput, "eventId");
  const gameDayId = validateId(gameDayIdInput, "gameDayId");
  const eventGameId = validateId(eventGameIdInput, "eventGameId");
  const gameSideId = validateId(gameSideIdInput, "gameSideId");
  const eventTeamId = validateId(eventTeamIdInput, "eventTeamId");
  if (!eventId.ok || !gameDayId.ok || !eventGameId.ok || !gameSideId.ok || !eventTeamId.ok)
    return invalid("Event Game identity reconciliation identifier is invalid.");
  const event = transaction.findEvent(eventId.value);
  const game = transaction.findEventGame(eventGameId.value);
  const team = transaction.findEventTeam(eventTeamId.value);
  if (event === null || game === null || team === null)
    return notFound("Event Game was not found.");
  if (game.eventId !== event.eventId || game.gameDayId !== gameDayId.value)
    return crossEvent("Event Game does not belong to the selected Event and Game Day.");
  const side =
    game.sideA.sideId === gameSideId.value
      ? "sideA"
      : game.sideB.sideId === gameSideId.value
        ? "sideB"
        : null;
  if (side === null)
    return invalid("Event Game identity reconciliation references an unknown Game Side.");
  if (team.eventId !== event.eventId) return crossEvent("Event Team belongs to another Event.");
  const otherSide = side === "sideA" ? game.sideB : game.sideA;
  if (otherSide.eventTeamId === team.eventTeamId)
    return invalid("Event Game sides must use distinct Event Teams.");
  const previous = side === "sideA" ? game.sideA : game.sideB;
  if (previous.eventTeamId === team.eventTeamId) return accepted(game);
  const nextSide = {
    ...previous,
    eventTeamId: team.eventTeamId,
    eventTeamName: team.name,
    sourceLabel: null,
    confirmedAtMs: game.updatedAtMs,
  };
  const next: EventGame = {
    ...game,
    ...(side === "sideA" ? { sideA: nextSide } : { sideB: nextSide }),
  };
  transaction.updateEventGame(next);
  transaction.appendEventAudit(
    createAudit(
      ids,
      "event-game-teams-confirmed",
      event.eventId,
      gameDayId.value,
      actorReference,
      next.updatedAtMs,
      { eventGame: game, correction: { gameSideId: gameSideId.value, reason: null } },
      { eventGame: next, correction: { gameSideId: gameSideId.value, reason: null } },
    ),
  );
  return accepted(next);
}

export type EventCatalogMutationOperations = {
  previewEventCatalogRemoval(
    target: EventCatalogRemovalTargetInput,
  ): CatalogOutcome<EventCatalogRemovalPreview>;
  removeEventCatalogEntry(
    target: EventCatalogRemovalTargetInput,
    previewFingerprint: unknown,
    retiredAuthorityCount: number,
  ): CatalogOutcome<EventCatalogRemovalResult>;
  changePublicationStatus(
    eventId: unknown,
    input: { status: unknown; impactConfirmed?: unknown },
  ): CatalogOutcome<EventPublicationStatusChange>;
  createEventTeam(
    eventId: unknown,
    input: { name: unknown; defaultColor?: unknown },
  ): CatalogOutcome<EventTeamProjection>;
  updateEventTeam(
    eventId: unknown,
    eventTeamId: unknown,
    input: { name?: unknown; defaultColor?: unknown },
  ): CatalogOutcome<EventTeamProjection>;
  setGameDayHeatStoppageConfiguration(
    eventId: unknown,
    gameDayId: unknown,
    input: { configuration: unknown },
  ): CatalogOutcome<EventGameDay>;
  upsertEventTeamRoster(
    eventId: unknown,
    eventTeamId: unknown,
    input: { playerNumber: unknown; publicName: unknown },
  ): CatalogOutcome<StoredRosterEntry>;
  createPitch(eventId: unknown, input: { name: unknown }): CatalogOutcome<StoredPitch>;
  updatePitch(
    eventId: unknown,
    pitchId: unknown,
    input: { name: unknown },
  ): CatalogOutcome<StoredPitch>;
  createGameplaySlot(
    eventId: unknown,
    gameDayId: unknown,
    input: { sequence: unknown; scheduledStart?: unknown; scheduledStartMs?: unknown },
  ): CatalogOutcome<GameplaySlot>;
  createEventGame(
    eventId: unknown,
    gameDayId: unknown,
    input: {
      gameplaySlotId: unknown;
      pitchSlotId: unknown;
      gameCode?: unknown;
      gameDesignation?: unknown;
      sideA?: unknown;
      sideB?: unknown;
    },
  ): CatalogOutcome<EventGame>;
  confirmGameplaySlotTeams(
    eventId: unknown,
    gameDayId: unknown,
    gameplaySlotId: unknown,
    input: {
      games: unknown;
    },
  ): CatalogOutcome<readonly EventGame[]>;
  previewGameplaySlotExpectedDelay(
    eventId: unknown,
    gameDayId: unknown,
    gameplaySlotId: unknown,
    input: { expectedDelayMs: unknown; cascade?: unknown },
  ): CatalogOutcome<ScheduleDelayPreview>;
  previewPitchSlotExpectedDelay(
    eventId: unknown,
    gameDayId: unknown,
    pitchSlotId: unknown,
    input: { expectedDelayMs: unknown; cascade?: unknown },
  ): CatalogOutcome<ScheduleDelayPreview>;
  setGameplaySlotExpectedDelay(
    eventId: unknown,
    gameDayId: unknown,
    gameplaySlotId: unknown,
    input: { expectedDelayMs: unknown; cascade?: unknown },
  ): CatalogOutcome<ScheduleDelayPreview>;
  setPitchSlotExpectedDelay(
    eventId: unknown,
    gameDayId: unknown,
    pitchSlotId: unknown,
    input: { expectedDelayMs: unknown; cascade?: unknown },
  ): CatalogOutcome<ScheduleDelayPreview>;
  reassignEventGame(
    eventId: unknown,
    gameDayId: unknown,
    eventGameId: unknown,
    input: { targetPitchSlotId: unknown; mode?: unknown },
  ): CatalogOutcome<PitchReassignmentResult>;
  correctEventGameIdentity(
    eventId: unknown,
    gameDayId: unknown,
    eventGameId: unknown,
    input: EventGameIdentityCorrectionInput,
  ): CatalogOutcome<EventGameIdentityCorrection>;
};

export type ScheduleDelayChange = {
  slotId: string;
  beforeDelayMs: number;
  afterDelayMs: number;
  beforeExpectedStartMs: number;
  afterExpectedStartMs: number;
  eventGames: readonly {
    eventGameId: string;
    beforeExpectedStartMs: number;
    afterExpectedStartMs: number;
    beforeExpectedPlayingPeriod: EventGamePlayingPeriod;
    afterExpectedPlayingPeriod: EventGamePlayingPeriod;
  }[];
};

export type ScheduleDelayPreview = {
  dimension: "gameplay-slot" | "pitch-slot";
  targetSlotId: string;
  cascade: boolean;
  changes: readonly ScheduleDelayChange[];
};

export type PitchReassignmentResult = {
  mode: "move" | "swap";
  eventGame: EventGame;
  swappedEventGame: EventGame | null;
  scheduleConflict: boolean;
  teamScheduleConflicts: readonly string[];
};

export type EventGameIdentityCorrectionInput = {
  gameSideId: unknown;
  eventTeamId: unknown;
  operationId?: unknown;
  confirmation?: unknown;
  reason?: unknown;
};

export type EventGameIdentityCorrection = {
  operationId: string;
  eventGameId: string;
  gameSideId: string;
  previousEventTeamId: string;
  previousEventTeamName: string;
  eventTeamId: string;
  eventTeamName: string;
  commenced: boolean;
  reason: string | null;
  controllerAcknowledgementRequired: boolean;
};

export type EventCatalogStorageSnapshot = {
  findEvent(eventId: string): StoredEvent | null;
  listEvents(): StoredEvent[];
  listGameDays(eventId: string): StoredGameDay[];
  findEventTeam(eventTeamId: string): StoredEventTeam | null;
  listEventTeams(eventId: string): StoredEventTeam[];
  listRoster(eventTeamId: string): StoredRosterEntry[];
  findRosterEntry(eventTeamId: string, playerNumber: number): StoredRosterEntry | null;
  findPitch(pitchId: string): StoredPitch | null;
  listPitches(eventId: string): StoredPitch[];
  findGameplaySlot(gameplaySlotId: string): GameplaySlot | null;
  listGameplaySlots(gameDayId: string): GameplaySlot[];
  findPitchSlot(pitchSlotId: string): PitchSlot | null;
  listPitchSlots(gameDayId: string, pitchId?: string): PitchSlot[];
  findEventGame(eventGameId: string): EventGame | null;
  listEventGames(gameDayId: string): EventGame[];
  findRootByEventGameId(eventGameId: string): EventGameRecordRoot | null;
  listActions(recordId: string): StoredControlAction[];
  listAuditTrail(eventId: string): EventAdministrationAuditEntry[];
};

export type EventCatalogStorageTransaction = EventCatalogStorageSnapshot & {
  insertEvent(event: StoredEvent): void;
  updateEvent(event: StoredEvent): void;
  deleteEvent(eventId: string): void;
  insertGameDay(gameDay: StoredGameDay): void;
  updateGameDay(gameDay: StoredGameDay): void;
  deleteGameDay(gameDayId: string): void;
  insertEventTeam(team: StoredEventTeam): void;
  updateEventTeam(team: StoredEventTeam): void;
  deleteEventTeam(eventTeamId: string): void;
  insertRosterEntry(entry: StoredRosterEntry): void;
  updateRosterEntry(entry: StoredRosterEntry): void;
  insertPitch(pitch: StoredPitch): void;
  updatePitch(pitch: StoredPitch): void;
  deletePitch(pitchId: string): void;
  insertGameplaySlot(slot: GameplaySlot): void;
  insertPitchSlot(slot: PitchSlot): void;
  updateGameplaySlot(slot: GameplaySlot): void;
  updatePitchSlot(slot: PitchSlot): void;
  deleteGameplaySlot(gameplaySlotId: string): void;
  deletePitchSlot(pitchSlotId: string): void;
  insertEventGame(game: EventGame): void;
  updateEventGame(game: EventGame): void;
  deleteEventGame(eventGameId: string): void;
  appendAudit(entry: EventAdministrationAuditEntry): void;
};

export interface EventCatalogStorage {
  transaction<T>(work: (transaction: EventCatalogStorageTransaction) => T): Promise<T>;
  snapshot(): Promise<EventCatalogStorageSnapshot>;
  eventCatalogStorageCapability(): EventCatalogStorageCapability;
  close(): void;
}

export interface EventCatalogFoundationStorage {
  /** Thin catalog projection over the foundation's shared transaction boundary. */
  transaction<T>(work: (transaction: EventCatalogStorageTransaction) => T): Promise<T>;
  snapshot(): Promise<EventCatalogStorageSnapshot>;
  eventCatalogStorageCapability(): EventCatalogStorageCapability;
}

export type InMemoryEventCatalogStorage = EventCatalogStorage & {
  failNextTransaction(error: unknown): void;
};

export type EventCatalog = {
  createEvent(
    input: { name: unknown; timeZone: unknown },
    authority: TechnicalAdminAuthority,
  ): Promise<CatalogOutcome<EventProjection>>;
  listEvents(
    authority: TechnicalAdminAuthority,
  ): Promise<CatalogOutcome<readonly EventProjection[]>>;
  inspectEvent(
    eventId: unknown,
    authority: TechnicalAdminAuthority,
  ): Promise<CatalogOutcome<EventProjection>>;
  updateEvent(
    eventId: unknown,
    input: { name?: unknown; timeZone?: unknown },
    authority: TechnicalAdminAuthority,
  ): Promise<CatalogOutcome<EventProjection>>;
  changePublicationStatus(
    eventId: unknown,
    input: { status: unknown; impactConfirmed?: unknown },
    authority: TechnicalAdminAuthority,
  ): Promise<CatalogOutcome<EventPublicationStatusChange>>;
  addGameDay(
    eventId: unknown,
    input: { date: unknown },
    authority: TechnicalAdminAuthority,
  ): Promise<CatalogOutcome<EventGameDay>>;
  updateGameDay(
    eventId: unknown,
    gameDayId: unknown,
    input: { date: unknown },
    authority: TechnicalAdminAuthority,
  ): Promise<CatalogOutcome<EventGameDay>>;
  setGameDayHeatStoppageConfiguration(
    eventId: unknown,
    gameDayId: unknown,
    input: { configuration: unknown },
    authority: TechnicalAdminAuthority,
  ): Promise<CatalogOutcome<EventGameDay>>;
  createEventTeam(
    eventId: unknown,
    input: { name: unknown; defaultColor?: unknown },
    authority: TechnicalAdminAuthority,
  ): Promise<CatalogOutcome<EventTeamProjection>>;
  updateEventTeam(
    eventId: unknown,
    eventTeamId: unknown,
    input: { name?: unknown; defaultColor?: unknown },
    authority: TechnicalAdminAuthority,
  ): Promise<CatalogOutcome<EventTeamProjection>>;
  upsertEventTeamRoster(
    eventId: unknown,
    eventTeamId: unknown,
    input: { playerNumber: unknown; publicName: unknown },
    authority: TechnicalAdminAuthority,
  ): Promise<CatalogOutcome<StoredRosterEntry>>;
  createPitch(
    eventId: unknown,
    input: { name: unknown },
    authority: TechnicalAdminAuthority,
  ): Promise<CatalogOutcome<StoredPitch>>;
  updatePitch(
    eventId: unknown,
    pitchId: unknown,
    input: { name: unknown },
    authority: TechnicalAdminAuthority,
  ): Promise<CatalogOutcome<StoredPitch>>;
  createGameplaySlot(
    eventId: unknown,
    gameDayId: unknown,
    input: { sequence: unknown; scheduledStart?: unknown; scheduledStartMs?: unknown },
    authority: TechnicalAdminAuthority,
  ): Promise<CatalogOutcome<GameplaySlot>>;
  createEventGame(
    eventId: unknown,
    gameDayId: unknown,
    input: {
      gameplaySlotId: unknown;
      pitchSlotId: unknown;
      gameCode?: unknown;
      gameDesignation?: unknown;
      sideA?: unknown;
      sideB?: unknown;
    },
    authority: TechnicalAdminAuthority,
  ): Promise<CatalogOutcome<EventGame>>;
  confirmGameplaySlotTeams(
    eventId: unknown,
    gameDayId: unknown,
    gameplaySlotId: unknown,
    input: { games: unknown },
    authority: TechnicalAdminAuthority,
  ): Promise<CatalogOutcome<readonly EventGame[]>>;
  setGameplaySlotExpectedDelay(
    eventId: unknown,
    gameDayId: unknown,
    gameplaySlotId: unknown,
    input: { expectedDelayMs: unknown; cascade?: unknown },
    authority: TechnicalAdminAuthority,
  ): Promise<CatalogOutcome<ScheduleDelayPreview>>;
  previewGameplaySlotExpectedDelay(
    eventId: unknown,
    gameDayId: unknown,
    gameplaySlotId: unknown,
    input: { expectedDelayMs: unknown; cascade?: unknown },
    authority: TechnicalAdminAuthority,
  ): Promise<CatalogOutcome<ScheduleDelayPreview>>;
  setPitchSlotExpectedDelay(
    eventId: unknown,
    gameDayId: unknown,
    pitchSlotId: unknown,
    input: { expectedDelayMs: unknown; cascade?: unknown },
    authority: TechnicalAdminAuthority,
  ): Promise<CatalogOutcome<ScheduleDelayPreview>>;
  previewPitchSlotExpectedDelay(
    eventId: unknown,
    gameDayId: unknown,
    pitchSlotId: unknown,
    input: { expectedDelayMs: unknown; cascade?: unknown },
    authority: TechnicalAdminAuthority,
  ): Promise<CatalogOutcome<ScheduleDelayPreview>>;
  reassignEventGame(
    eventId: unknown,
    gameDayId: unknown,
    eventGameId: unknown,
    input: { targetPitchSlotId: unknown; mode?: unknown },
    authority: TechnicalAdminAuthority,
  ): Promise<CatalogOutcome<PitchReassignmentResult>>;
  correctEventGameIdentity(
    eventId: unknown,
    gameDayId: unknown,
    eventGameId: unknown,
    input: EventGameIdentityCorrectionInput,
    authority: TechnicalAdminAuthority,
  ): Promise<CatalogOutcome<EventGameIdentityCorrection>>;
  lookupAudienceRoster(
    eventId: unknown,
    eventTeamId: unknown,
    playerNumber: unknown,
  ): Promise<CatalogOutcome<AudienceRosterProjection>>;
  runMutationInTransaction<T>(
    transaction: FoundationStorageTransaction,
    eventId: unknown,
    actorReference: string,
    work: (operations: EventCatalogMutationOperations) => CatalogOutcome<T>,
  ): CatalogOutcome<T>;
  previewEventCatalogRemoval(
    target: EventCatalogRemovalTargetInput,
    authority: TechnicalAdminAuthority,
  ): Promise<CatalogOutcome<EventCatalogRemovalPreview>>;
  listAuditTrail(
    eventId: unknown,
    authority: TechnicalAdminAuthority,
  ): Promise<CatalogOutcome<readonly EventAdministrationAuditEntry[]>>;
};

export function createEventCatalog(
  storage: EventCatalogFoundationStorage,
  options: EventCatalogOptions,
): EventCatalog {
  assertEventCatalogStorageCapability(storage.eventCatalogStorageCapability());
  const clock = options.clock ?? { nowMs: () => Date.now() };
  const ids = options.ids ?? { next: (kind) => `${kind}-${crypto.randomUUID()}` };

  return {
    async createEvent(input, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      const actor = authorityActor(authority);
      const name = validateEventName(input.name);
      if (!name.ok) return invalid(name.error);
      const timeZone = validateTimeZone(input.timeZone);
      if (!timeZone.ok) return invalid(timeZone.error);
      const nowMs = validNow(clock);
      if (nowMs === null) return invalid("Event clock returned an invalid timestamp.");
      const event: StoredEvent = {
        eventId: ids.next("event"),
        name: name.value,
        timeZone: timeZone.value,
        publicationStatus: "unpublished",
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      const audit = createAudit(
        ids,
        "event-created",
        event.eventId,
        null,
        actor,
        nowMs,
        null,
        event,
      );
      return commit(storage, (transaction) => {
        if (transaction.findEvent(event.eventId) !== null)
          return duplicate("Event identity already exists.");
        transaction.insertEvent(event);
        transaction.appendAudit(audit);
        return accepted(project(event, [], [audit], nowMs));
      });
    },

    async listEvents(authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      try {
        const snapshot = await storage.snapshot();
        const nowMs = validNow(clock);
        if (nowMs === null) return invalid("Event clock returned an invalid timestamp.");
        return accepted(
          snapshot.listEvents().map((event) =>
            project(
              event,
              snapshot.listGameDays(event.eventId),
              snapshot.listAuditTrail(event.eventId),
              nowMs,
              snapshot.listEventTeams(event.eventId),
              snapshot
                .listEventTeams(event.eventId)
                .flatMap((team) => snapshot.listRoster(team.eventTeamId)),
              snapshot.listPitches(event.eventId),
              snapshot
                .listGameDays(event.eventId)
                .flatMap((day) => snapshot.listGameplaySlots(day.gameDayId)),
              snapshot
                .listGameDays(event.eventId)
                .flatMap((day) => snapshot.listPitchSlots(day.gameDayId)),
              snapshot
                .listGameDays(event.eventId)
                .flatMap((day) => snapshot.listEventGames(day.gameDayId)),
            ),
          ),
        );
      } catch {
        return unavailable();
      }
    },

    async inspectEvent(eventIdInput, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      const eventId = validateId(eventIdInput, "eventId");
      if (!eventId.ok) return invalid(eventId.error);
      try {
        const snapshot = await storage.snapshot();
        const event = snapshot.findEvent(eventId.value);
        if (event === null) return notFound("Event was not found.");
        const nowMs = validNow(clock);
        if (nowMs === null) return invalid("Event clock returned an invalid timestamp.");
        return accepted(
          project(
            event,
            snapshot.listGameDays(event.eventId),
            snapshot.listAuditTrail(event.eventId),
            nowMs,
            snapshot.listEventTeams(event.eventId),
            snapshot
              .listEventTeams(event.eventId)
              .flatMap((team) => snapshot.listRoster(team.eventTeamId)),
            snapshot.listPitches(event.eventId),
            snapshot
              .listGameDays(event.eventId)
              .flatMap((day) => snapshot.listGameplaySlots(day.gameDayId)),
            snapshot
              .listGameDays(event.eventId)
              .flatMap((day) => snapshot.listPitchSlots(day.gameDayId)),
            snapshot
              .listGameDays(event.eventId)
              .flatMap((day) => snapshot.listEventGames(day.gameDayId)),
          ),
        );
      } catch {
        return unavailable();
      }
    },

    async updateEvent(eventIdInput, input, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      const actor = authorityActor(authority);
      const eventId = validateId(eventIdInput, "eventId");
      if (!eventId.ok) return invalid(eventId.error);
      if (input.name === undefined && input.timeZone === undefined) {
        return invalid("At least one Event field must be supplied.");
      }
      const name = input.name === undefined ? null : validateEventName(input.name);
      if (name !== null && !name.ok) return invalid(name.error);
      const timeZone = input.timeZone === undefined ? null : validateTimeZone(input.timeZone);
      if (timeZone !== null && !timeZone.ok) return invalid(timeZone.error);
      const nowMs = validNow(clock);
      if (nowMs === null) return invalid("Event clock returned an invalid timestamp.");
      return commit(storage, (transaction) => {
        const existing = transaction.findEvent(eventId.value);
        if (existing === null) return notFound("Event was not found.");
        const updated: StoredEvent = {
          ...existing,
          name: name === null ? existing.name : name.value,
          timeZone: timeZone === null ? existing.timeZone : timeZone.value,
          updatedAtMs: nowMs,
        };
        if (updated.name === existing.name && updated.timeZone === existing.timeZone) {
          return noChange("The Event already has these values.");
        }
        const audit = createAudit(
          ids,
          "event-updated",
          existing.eventId,
          null,
          actor,
          nowMs,
          existing,
          updated,
        );
        transaction.updateEvent(updated);
        transaction.appendAudit(audit);
        return accepted(
          project(
            updated,
            transaction.listGameDays(updated.eventId),
            transaction.listAuditTrail(updated.eventId),
            nowMs,
            transaction.listEventTeams(updated.eventId),
            transaction
              .listEventTeams(updated.eventId)
              .flatMap((team) => transaction.listRoster(team.eventTeamId)),
            transaction.listPitches(updated.eventId),
            transaction
              .listGameDays(updated.eventId)
              .flatMap((day) => transaction.listGameplaySlots(day.gameDayId)),
            transaction
              .listGameDays(updated.eventId)
              .flatMap((day) => transaction.listPitchSlots(day.gameDayId)),
            transaction
              .listGameDays(updated.eventId)
              .flatMap((day) => transaction.listEventGames(day.gameDayId)),
          ),
        );
      });
    },

    async changePublicationStatus(eventIdInput, input, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      return commit(storage, (transaction) =>
        changePublicationStatusOperation(
          transaction,
          clock,
          ids,
          eventIdInput,
          input,
          authorityActor(authority),
        ),
      );
    },

    async addGameDay(eventIdInput, input, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      const actor = authorityActor(authority);
      const eventId = validateId(eventIdInput, "eventId");
      if (!eventId.ok) return invalid(eventId.error);
      const date = validateDate(input.date);
      if (!date.ok) return invalid(date.error);
      const nowMs = validNow(clock);
      if (nowMs === null) return invalid("Event clock returned an invalid timestamp.");
      return commit(storage, (transaction) => {
        const event = transaction.findEvent(eventId.value);
        if (event === null) return notFound("Event was not found.");
        if (transaction.listGameDays(event.eventId).some((day) => day.date === date.value)) {
          return duplicate("The Event already has a Game Day on that date.");
        }
        const gameDay: StoredGameDay = {
          gameDayId: ids.next("game-day"),
          eventId: event.eventId,
          date: date.value,
          heatStoppageConfiguration: DEFAULT_HEAT_STOPPAGE_CONFIGURATION,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        };
        const audit = createAudit(
          ids,
          "game-day-added",
          event.eventId,
          gameDay.gameDayId,
          actor,
          nowMs,
          null,
          gameDay,
        );
        transaction.insertGameDay(gameDay);
        transaction.appendAudit(audit);
        return accepted(projectDay(gameDay, event.timeZone, nowMs));
      });
    },

    async updateGameDay(eventIdInput, gameDayIdInput, input, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      const actor = authorityActor(authority);
      const eventId = validateId(eventIdInput, "eventId");
      if (!eventId.ok) return invalid(eventId.error);
      const gameDayId = validateId(gameDayIdInput, "gameDayId");
      if (!gameDayId.ok) return invalid(gameDayId.error);
      const date = validateDate(input.date);
      if (!date.ok) return invalid(date.error);
      const nowMs = validNow(clock);
      if (nowMs === null) return invalid("Event clock returned an invalid timestamp.");
      return commit(storage, (transaction) => {
        const event = transaction.findEvent(eventId.value);
        if (event === null) return notFound("Event was not found.");
        const existing = transaction
          .listGameDays(eventId.value)
          .find((day) => day.gameDayId === gameDayId.value);
        if (existing === undefined) {
          const elsewhere = transaction
            .listEvents()
            .some((candidate) =>
              transaction
                .listGameDays(candidate.eventId)
                .some((day) => day.gameDayId === gameDayId.value),
            );
          return elsewhere
            ? crossEvent("Game Day belongs to another Event.")
            : notFound("Game Day was not found.");
        }
        if (
          transaction
            .listGameDays(event.eventId)
            .some((day) => day.gameDayId !== existing.gameDayId && day.date === date.value)
        ) {
          return duplicate("The Event already has a Game Day on that date.");
        }
        const updated = { ...existing, date: date.value, updatedAtMs: nowMs };
        if (updated.date === existing.date) {
          return noChange("The Game Day already has this date.");
        }
        const audit = createAudit(
          ids,
          "game-day-updated",
          event.eventId,
          existing.gameDayId,
          actor,
          nowMs,
          existing,
          updated,
        );
        transaction.updateGameDay(updated);
        transaction.appendAudit(audit);
        return accepted(projectDay(updated, event.timeZone, nowMs));
      });
    },

    async setGameDayHeatStoppageConfiguration(eventIdInput, gameDayIdInput, input, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      const actor = authorityActor(authority);
      const nowMs = validNow(clock);
      if (nowMs === null) return invalid("Event clock returned an invalid timestamp.");
      return commit(storage, (transaction) =>
        setGameDayHeatStoppageConfigurationOperation(
          transaction,
          clock,
          ids,
          eventIdInput,
          gameDayIdInput,
          input,
          actor,
        ),
      );
    },

    async createEventTeam(eventId, input, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      return commit(storage, (transaction) =>
        createEventTeamOperation(
          transaction,
          clock,
          ids,
          eventId,
          input,
          authorityActor(authority),
        ),
      );
    },

    async updateEventTeam(eventId, eventTeamId, input, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      return commit(storage, (transaction) =>
        updateEventTeamOperation(
          transaction,
          clock,
          ids,
          eventId,
          eventTeamId,
          input,
          authorityActor(authority),
        ),
      );
    },

    async upsertEventTeamRoster(eventId, eventTeamId, input, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      return commit(storage, (transaction) =>
        upsertRosterOperation(
          transaction,
          clock,
          ids,
          eventId,
          eventTeamId,
          input,
          authorityActor(authority),
        ),
      );
    },

    async createPitch(eventId, input, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      return commit(storage, (transaction) =>
        createPitchOperation(transaction, clock, ids, eventId, input, authorityActor(authority)),
      );
    },

    async updatePitch(eventId, pitchId, input, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      return commit(storage, (transaction) =>
        updatePitchOperation(
          transaction,
          clock,
          ids,
          eventId,
          pitchId,
          input,
          authorityActor(authority),
        ),
      );
    },

    async createGameplaySlot(eventId, gameDayId, input, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      return commit(storage, (transaction) =>
        createGameplaySlotOperation(
          transaction,
          clock,
          ids,
          eventId,
          gameDayId,
          input,
          authorityActor(authority),
        ),
      );
    },

    async createEventGame(eventId, gameDayId, input, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      return commit(storage, (transaction) =>
        createEventGameOperation(
          transaction,
          clock,
          ids,
          eventId,
          gameDayId,
          input,
          authorityActor(authority),
        ),
      );
    },

    async confirmGameplaySlotTeams(eventId, gameDayId, gameplaySlotId, input, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      return commit(storage, (transaction) =>
        confirmGameplaySlotTeamsOperation(
          transaction,
          clock,
          ids,
          eventId,
          gameDayId,
          gameplaySlotId,
          input,
          authorityActor(authority),
        ),
      );
    },

    async setGameplaySlotExpectedDelay(eventId, gameDayId, gameplaySlotId, input, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      return commit(storage, (transaction) =>
        setGameplaySlotExpectedDelayOperation(
          transaction,
          clock,
          ids,
          eventId,
          gameDayId,
          gameplaySlotId,
          input,
          authorityActor(authority),
        ),
      );
    },

    async previewGameplaySlotExpectedDelay(eventId, gameDayId, gameplaySlotId, input, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      return commit(storage, (transaction) =>
        previewGameplaySlotExpectedDelayOperation(
          transaction,
          eventId,
          gameDayId,
          gameplaySlotId,
          input,
        ),
      );
    },

    async setPitchSlotExpectedDelay(eventId, gameDayId, pitchSlotId, input, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      return commit(storage, (transaction) =>
        setPitchSlotExpectedDelayOperation(
          transaction,
          clock,
          ids,
          eventId,
          gameDayId,
          pitchSlotId,
          input,
          authorityActor(authority),
        ),
      );
    },

    async previewPitchSlotExpectedDelay(eventId, gameDayId, pitchSlotId, input, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      return commit(storage, (transaction) =>
        previewPitchSlotExpectedDelayOperation(transaction, eventId, gameDayId, pitchSlotId, input),
      );
    },

    async reassignEventGame(eventId, gameDayId, eventGameId, input, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      return commit(storage, (transaction) =>
        reassignEventGameOperation(
          transaction,
          clock,
          ids,
          eventId,
          gameDayId,
          eventGameId,
          input,
          authorityActor(authority),
        ),
      );
    },

    async correctEventGameIdentity(eventId, gameDayId, eventGameId, input, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      return commit(storage, (transaction) =>
        correctEventGameIdentityOperation(
          transaction,
          clock,
          ids,
          eventId,
          gameDayId,
          eventGameId,
          input,
          authorityActor(authority),
        ),
      );
    },

    async lookupAudienceRoster(eventIdInput, eventTeamIdInput, playerNumberInput) {
      const eventId = validateId(eventIdInput, "eventId");
      const eventTeamId = validateId(eventTeamIdInput, "eventTeamId");
      const playerNumber = validatePlayerNumber(playerNumberInput);
      if (!eventId.ok) return invalid(eventId.error);
      if (!eventTeamId.ok) return invalid(eventTeamId.error);
      if (!playerNumber.ok) return invalid(playerNumber.error);
      try {
        const snapshot = await storage.snapshot();
        const team = snapshot.findEventTeam(eventTeamId.value);
        const entry =
          team?.eventId === eventId.value
            ? snapshot.findRosterEntry(team.eventTeamId, playerNumber.value)
            : null;
        return accepted({
          playerNumber: playerNumber.value,
          publicName: entry?.publicName ?? null,
        });
      } catch {
        return unavailable();
      }
    },

    runMutationInTransaction(transaction, eventIdInput, actorReference, work) {
      const eventId = validateId(eventIdInput, "eventId");
      if (!eventId.ok) return invalid(eventId.error);
      return work(
        createMutationOperations(eventCatalogTransaction(transaction), clock, ids, actorReference),
      );
    },

    async previewEventCatalogRemoval(target, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      try {
        const snapshot = await storage.snapshot();
        return previewEventCatalogRemovalOperation(snapshot, target);
      } catch {
        return unavailable();
      }
    },

    async listAuditTrail(eventIdInput, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      const eventId = validateId(eventIdInput, "eventId");
      if (!eventId.ok) return invalid(eventId.error);
      try {
        const snapshot = await storage.snapshot();
        const trail = snapshot.listAuditTrail(eventId.value);
        if (snapshot.findEvent(eventId.value) === null && trail.length === 0) {
          return notFound("Event was not found.");
        }
        return accepted(trail);
      } catch {
        return unavailable();
      }
    },
  };
}

/**
 * Storage adapters invoke the catalog callback with their transaction object. This wrapper keeps
 * mutation result mapping in the deep module while allowing the callback to return explicit outcomes.
 */
function commit<T>(
  storage: EventCatalogFoundationStorage,
  work: (transaction: EventCatalogStorageTransaction) => CatalogOutcome<T>,
): Promise<CatalogOutcome<T>> {
  return storage.transaction((transaction) => work(transaction)).catch(() => unavailable());
}

function accepted<T>(value: T): CatalogOutcome<T> {
  return { status: "accepted", value };
}

function invalid(detail: string): CatalogOutcome<never> {
  return { status: "rejected", reason: "invalid-input", detail };
}

function unauthorized(): CatalogOutcome<never> {
  return {
    status: "rejected",
    reason: "unauthorized",
    detail: "Technical Admin authority is required for this operation.",
  };
}

function notFound(detail: string): CatalogOutcome<never> {
  return { status: "rejected", reason: "not-found", detail };
}

function crossEvent(detail: string): CatalogOutcome<never> {
  return { status: "rejected", reason: "cross-event", detail };
}

function duplicate(detail: string): CatalogOutcome<never> {
  return { status: "rejected", reason: "duplicate", detail };
}

function noChange(detail: string): CatalogOutcome<never> {
  return { status: "rejected", reason: "no-change", detail };
}

function inUse(detail: string): CatalogOutcome<never> {
  return { status: "rejected", reason: "in-use", detail };
}

function unavailable(): CatalogOutcome<never> {
  return {
    status: "retryable-failure",
    detail: "Event catalog storage is temporarily unavailable.",
  };
}

function authorityActor(authority: TechnicalAdminAuthority): string {
  return `technical-admin:${authority.environment}:${authority.sessionId}`;
}

function validNow(clock: EventCatalogClock): number | null {
  const value = clock.nowMs();
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function validateEventName(value: unknown) {
  return normalizeBoundedText(
    value,
    SHARED_LIMITS.names.eventAndGameDesignationMaxCodePoints,
    "Event name",
  );
}

function validatePublicationStatus(
  value: unknown,
): { ok: true; value: EventPublicationStatus } | { ok: false; error: string } {
  if (value === "unpublished" || value === "published" || value === "cancelled")
    return { ok: true, value };
  return { ok: false, error: "Publication Status must be unpublished, published, or cancelled." };
}

function validateId(value: unknown, field: string) {
  return validateOpaqueIdentifier(value, field);
}

function validateTimeZone(
  value: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, error: "Event timezone must be a valid IANA timezone." };
  }
  const timeZone = value.trim();
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
    return resolved === undefined
      ? { ok: false, error: "Event timezone must be a valid IANA timezone." }
      : { ok: true, value: resolved };
  } catch {
    return { ok: false, error: "Event timezone must be a valid IANA timezone." };
  }
}

function validateDate(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return { ok: false, error: "Game Day date must use YYYY-MM-DD." };
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day ?? 0));
  if (
    !Number.isFinite(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== (month ?? 0) - 1 ||
    date.getUTCDate() !== day
  ) {
    return { ok: false, error: "Game Day date is not a real calendar date." };
  }
  return { ok: true, value };
}

function createAudit(
  ids: EventCatalogIds,
  action: EventAdministrationAuditEntry["action"],
  eventId: string,
  gameDayId: string | null,
  actorReference: string,
  occurredAtMs: number,
  before: unknown,
  after: unknown,
  operationId?: string,
): EventAdministrationAuditEntry {
  return {
    auditId: ids.next("audit"),
    operationId: operationId ?? ids.next("operation"),
    action,
    eventId,
    gameDayId,
    actorReference,
    occurredAtMs,
    before: before === null ? null : structuredClone(before),
    after: after === null ? null : structuredClone(after),
  };
}

function project(
  event: StoredEvent,
  gameDays: readonly StoredGameDay[],
  auditTrail: readonly EventAdministrationAuditEntry[],
  nowMs: number,
  teams: readonly StoredEventTeam[] = [],
  roster: readonly StoredRosterEntry[] = [],
  pitches: readonly StoredPitch[] = [],
  gameplaySlots: readonly GameplaySlot[] = [],
  pitchSlots: readonly PitchSlot[] = [],
  eventGames: readonly EventGame[] = [],
): EventProjection {
  const projectedDays = gameDays
    .map((day) => projectDay(day, event.timeZone, nowMs))
    .sort((left, right) => left.date.localeCompare(right.date));
  const today = localDate(nowMs, event.timeZone);
  const currentDay = projectedDays.find((day) => day.date === today);
  const lifecycle: EventLifecycle =
    projectedDays.length === 0
      ? "unscheduled"
      : currentDay !== undefined
        ? "current"
        : projectedDays.some((day) => day.date > today)
          ? "future"
          : "past";
  return {
    ...structuredClone(event),
    lifecycle,
    gameDays: projectedDays,
    teams: teams
      .map((team) => ({
        ...structuredClone(team),
        roster: roster
          .filter((entry) => entry.eventTeamId === team.eventTeamId)
          .sort((left, right) => left.playerNumber - right.playerNumber)
          .map((entry) => structuredClone(entry)),
      }))
      .sort((left, right) => left.eventTeamId.localeCompare(right.eventTeamId)),
    pitches: pitches
      .map((pitch) => structuredClone(pitch))
      .sort((left, right) => left.pitchId.localeCompare(right.pitchId)),
    gameplaySlots: gameplaySlots
      .map((slot) => structuredClone(slot))
      .sort((left, right) =>
        left.sequence === right.sequence
          ? left.gameplaySlotId.localeCompare(right.gameplaySlotId)
          : left.sequence - right.sequence,
      ),
    pitchSlots: pitchSlots
      .map((slot) => structuredClone(slot))
      .sort((left, right) =>
        left.gameDayId === right.gameDayId
          ? left.pitchId === right.pitchId
            ? left.sequence === right.sequence
              ? left.pitchSlotId.localeCompare(right.pitchSlotId)
              : left.sequence - right.sequence
            : left.pitchId.localeCompare(right.pitchId)
          : left.gameDayId.localeCompare(right.gameDayId),
      ),
    eventGames: projectScheduleGames(
      {
        findGameplaySlot: (gameplaySlotId) =>
          gameplaySlots.find((slot) => slot.gameplaySlotId === gameplaySlotId) ?? null,
        findPitchSlot: (pitchSlotId) =>
          pitchSlots.find((slot) => slot.pitchSlotId === pitchSlotId) ?? null,
      },
      eventGames,
    ).sort((left, right) => left.eventGameId.localeCompare(right.eventGameId)),
    auditTrail: [...structuredClone(auditTrail)].sort((left, right) =>
      left.occurredAtMs === right.occurredAtMs
        ? left.auditId.localeCompare(right.auditId)
        : left.occurredAtMs - right.occurredAtMs,
    ),
  };
}

function projectEventFromTransaction(
  transaction: EventCatalogStorageTransaction,
  event: StoredEvent,
  nowMs: number,
): EventProjection {
  const gameDays = transaction.listGameDays(event.eventId);
  return project(
    event,
    gameDays,
    transaction.listAuditTrail(event.eventId),
    nowMs,
    transaction.listEventTeams(event.eventId),
    transaction
      .listEventTeams(event.eventId)
      .flatMap((team) => transaction.listRoster(team.eventTeamId)),
    transaction.listPitches(event.eventId),
    gameDays.flatMap((day) => transaction.listGameplaySlots(day.gameDayId)),
    gameDays.flatMap((day) => transaction.listPitchSlots(day.gameDayId)),
    gameDays.flatMap((day) => transaction.listEventGames(day.gameDayId)),
  );
}

function projectDay(day: StoredGameDay, timeZone: string, nowMs: number): EventGameDay {
  const today = localDate(nowMs, timeZone);
  return {
    ...structuredClone(day),
    classification: day.date < today ? "past" : day.date > today ? "future" : "current",
  };
}

function localDate(nowMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function projectTeam(
  transaction: Pick<EventCatalogStorageSnapshot, "listRoster">,
  team: StoredEventTeam,
): EventTeamProjection {
  return { ...structuredClone(team), roster: transaction.listRoster(team.eventTeamId) };
}

function validateTeamOrPitchName(value: unknown, field: string) {
  return normalizeBoundedText(value, SHARED_LIMITS.names.teamAndPitchMaxCodePoints, field);
}

function validateEventTeamColor(
  value: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: DEFAULT_HOME_TEAM_COLOR };
  if (typeof value !== "string" || parseHexColor(value) === null)
    return { ok: false, error: "Event Team default color must be a six-digit hexadecimal color." };
  const normalized = value.trim().replace(/^#/, "").toLowerCase();
  return { ok: true, value: `#${normalized}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createMutationOperations(
  transaction: EventCatalogStorageTransaction,
  clock: EventCatalogClock,
  ids: EventCatalogIds,
  actorReference: string,
): EventCatalogMutationOperations {
  return {
    previewEventCatalogRemoval: (target) =>
      previewEventCatalogRemovalOperation(transaction, target),
    removeEventCatalogEntry: (target, previewFingerprint, retiredAuthorityCount) =>
      removeEventCatalogEntryOperation(
        transaction,
        clock,
        ids,
        actorReference,
        target,
        previewFingerprint,
        retiredAuthorityCount,
      ),
    changePublicationStatus: (eventId, input) =>
      changePublicationStatusOperation(transaction, clock, ids, eventId, input, actorReference),
    createEventTeam: (eventId, input) =>
      createEventTeamOperation(transaction, clock, ids, eventId, input, actorReference),
    updateEventTeam: (eventId, eventTeamId, input) =>
      updateEventTeamOperation(
        transaction,
        clock,
        ids,
        eventId,
        eventTeamId,
        input,
        actorReference,
      ),
    setGameDayHeatStoppageConfiguration: (eventId, gameDayId, input) =>
      setGameDayHeatStoppageConfigurationOperation(
        transaction,
        clock,
        ids,
        eventId,
        gameDayId,
        input,
        actorReference,
      ),
    upsertEventTeamRoster: (eventId, eventTeamId, input) =>
      upsertRosterOperation(transaction, clock, ids, eventId, eventTeamId, input, actorReference),
    createPitch: (eventId, input) =>
      createPitchOperation(transaction, clock, ids, eventId, input, actorReference),
    updatePitch: (eventId, pitchId, input) =>
      updatePitchOperation(transaction, clock, ids, eventId, pitchId, input, actorReference),
    createGameplaySlot: (eventId, gameDayId, input) =>
      createGameplaySlotOperation(
        transaction,
        clock,
        ids,
        eventId,
        gameDayId,
        input,
        actorReference,
      ),
    createEventGame: (eventId, gameDayId, input) =>
      createEventGameOperation(transaction, clock, ids, eventId, gameDayId, input, actorReference),
    confirmGameplaySlotTeams: (eventId, gameDayId, gameplaySlotId, input) =>
      confirmGameplaySlotTeamsOperation(
        transaction,
        clock,
        ids,
        eventId,
        gameDayId,
        gameplaySlotId,
        input,
        actorReference,
      ),
    previewGameplaySlotExpectedDelay: (eventId, gameDayId, gameplaySlotId, input) =>
      previewGameplaySlotExpectedDelayOperation(
        transaction,
        eventId,
        gameDayId,
        gameplaySlotId,
        input,
      ),
    setGameplaySlotExpectedDelay: (eventId, gameDayId, gameplaySlotId, input) =>
      setGameplaySlotExpectedDelayOperation(
        transaction,
        clock,
        ids,
        eventId,
        gameDayId,
        gameplaySlotId,
        input,
        actorReference,
      ),
    previewPitchSlotExpectedDelay: (eventId, gameDayId, pitchSlotId, input) =>
      previewPitchSlotExpectedDelayOperation(transaction, eventId, gameDayId, pitchSlotId, input),
    setPitchSlotExpectedDelay: (eventId, gameDayId, pitchSlotId, input) =>
      setPitchSlotExpectedDelayOperation(
        transaction,
        clock,
        ids,
        eventId,
        gameDayId,
        pitchSlotId,
        input,
        actorReference,
      ),
    reassignEventGame: (eventId, gameDayId, eventGameId, input) =>
      reassignEventGameOperation(
        transaction,
        clock,
        ids,
        eventId,
        gameDayId,
        eventGameId,
        input,
        actorReference,
      ),
    correctEventGameIdentity: (eventId, gameDayId, eventGameId, input) =>
      correctEventGameIdentityOperation(
        transaction,
        clock,
        ids,
        eventId,
        gameDayId,
        eventGameId,
        input,
        actorReference,
      ),
  };
}

function previewEventCatalogRemovalOperation(
  transaction: EventCatalogStorageSnapshot,
  input: EventCatalogRemovalTargetInput,
): CatalogOutcome<EventCatalogRemovalPreview> {
  const target = parseRemovalTarget(input);
  if (!target.ok) return invalid(target.error);
  const event = transaction.findEvent(target.value.eventId);
  if (event === null) return notFound("Event Catalog removal target was not found.");
  const targetRecord = readRemovalTarget(transaction, target.value);
  if (targetRecord === null) return notFound("Event Catalog removal target was not found.");

  let eligible = true;
  let rejectionCategory: EventCatalogRemovalPreview["rejectionCategory"] = null;
  let repairWorkflow: string | null = null;
  let descendantCount = 0;
  let retainedEventGameCount = 0;
  let retainedControlActionCount = 0;

  if (target.value.kind === "event") {
    descendantCount =
      transaction.listGameDays(event.eventId).length +
      transaction.listEventTeams(event.eventId).length +
      transaction.listPitches(event.eventId).length;
    for (const day of transaction.listGameDays(event.eventId)) {
      descendantCount +=
        transaction.listGameplaySlots(day.gameDayId).length +
        transaction.listPitchSlots(day.gameDayId).length +
        transaction.listEventGames(day.gameDayId).length;
    }
    if (descendantCount > 0) {
      eligible = false;
      rejectionCategory = "referenced";
      repairWorkflow = "Remove or repair the remaining Event Catalog structure first.";
    }
  } else if (target.value.kind === "event-team") {
    const team = transaction.findEventTeam(target.value.targetId);
    if (team === null || team.eventId !== event.eventId)
      return notFound("Event Catalog removal target was not found.");
    descendantCount = transaction.listRoster(team.eventTeamId).length;
    const referenced = transaction
      .listGameDays(event.eventId)
      .flatMap((day) => transaction.listEventGames(day.gameDayId))
      .some(
        (game) =>
          game.sideA.eventTeamId === team.eventTeamId ||
          game.sideB.eventTeamId === team.eventTeamId,
      );
    if (descendantCount > 0 || referenced) {
      eligible = false;
      rejectionCategory = "referenced";
      repairWorkflow =
        descendantCount > 0
          ? "Remove the Event Team roster entries before removing the Event Team."
          : "Use Event Team Assignment Correction or the ordinary schedule repair workflow.";
    }
  } else if (target.value.kind === "game-day") {
    const day = transaction
      .listGameDays(event.eventId)
      .find((candidate) => candidate.gameDayId === target.value.targetId);
    if (day === undefined) return notFound("Event Catalog removal target was not found.");
    const childCount =
      transaction.listGameplaySlots(day.gameDayId).length +
      transaction.listPitchSlots(day.gameDayId).length +
      transaction.listEventGames(day.gameDayId).length;
    descendantCount = childCount;
    if (childCount > 0) {
      eligible = false;
      rejectionCategory = "referenced";
      repairWorkflow = "Repair or remove the Game Day's schedule structure first.";
    }
  } else if (target.value.kind === "pitch") {
    const pitch = transaction.findPitch(target.value.targetId);
    if (pitch === null || pitch.eventId !== event.eventId)
      return notFound("Event Catalog removal target was not found.");
    const slots = transaction
      .listGameDays(event.eventId)
      .flatMap((day) => transaction.listPitchSlots(day.gameDayId, pitch.pitchId));
    descendantCount = slots.length;
    if (slots.length > 0) {
      eligible = false;
      rejectionCategory = "referenced";
      repairWorkflow = "Repair or remove the Pitch Schedule structure first.";
    }
  } else if (target.value.kind === "gameplay-slot") {
    const slot = transaction.findGameplaySlot(target.value.targetId);
    if (slot === null || slot.eventId !== event.eventId)
      return notFound("Event Catalog removal target was not found.");
    const pitchSlots = transaction
      .listPitchSlots(slot.gameDayId)
      .filter((pitchSlot) => pitchSlot.gameplaySlotId === slot.gameplaySlotId);
    const games = transaction
      .listEventGames(slot.gameDayId)
      .filter((game) => game.gameplaySlotId === slot.gameplaySlotId);
    descendantCount = pitchSlots.length + games.length;
    if (descendantCount > 0) {
      eligible = false;
      rejectionCategory = "referenced";
      repairWorkflow = "Repair or remove the Gameplay Slot's schedule structure first.";
    }
  } else if (target.value.kind === "pitch-slot") {
    const slot = transaction.findPitchSlot(target.value.targetId);
    if (slot === null || slot.eventId !== event.eventId)
      return notFound("Event Catalog removal target was not found.");
    const games = transaction
      .listEventGames(slot.gameDayId)
      .filter((game) => game.pitchSlotId === slot.pitchSlotId);
    descendantCount = games.length;
    if (games.length > 0) {
      eligible = false;
      rejectionCategory = "referenced";
      repairWorkflow = "Use Pitch Reassignment or the ordinary Event Game repair workflow.";
    }
  } else {
    const game = transaction.findEventGame(target.value.targetId);
    if (game === null || game.eventId !== event.eventId)
      return notFound("Event Catalog removal target was not found.");
    const root = transaction.findRootByEventGameId(game.eventGameId);
    retainedEventGameCount = root === null ? 0 : 1;
    retainedControlActionCount = root === null ? 0 : transaction.listActions(root.recordId).length;
    if (root?.lifecycle.commencedAtMs !== null && root !== null) {
      eligible = false;
      rejectionCategory = "commenced";
      repairWorkflow = "Use the ordinary Event Game correction or reopening workflow.";
    } else if (retainedControlActionCount > 0) {
      eligible = false;
      rejectionCategory = "accepted-control-action";
      repairWorkflow =
        "Use the ordinary Event Game correction workflow; accepted Control Actions remain durable.";
    }
  }

  return accepted({
    target: target.value,
    eligible,
    rejectionCategory,
    repairWorkflow,
    impact: {
      descendantCount,
      retiredAuthorityCount: 0,
      retiredAuthorityCategories: { eventAdmin: 0, pitchManager: 0, control: 0 },
      retainedEventGameCount,
      retainedControlActionCount,
    },
    fingerprint: removalFingerprint(
      target.value,
      {
        descendantCount,
        retainedEventGameCount,
        retainedControlActionCount,
      },
      targetRecord,
    ),
  });
}

function removeEventCatalogEntryOperation(
  transaction: EventCatalogStorageTransaction,
  clock: EventCatalogClock,
  ids: EventCatalogIds,
  actorReference: string,
  input: EventCatalogRemovalTargetInput,
  previewFingerprint: unknown,
  retiredAuthorityCount: number,
): CatalogOutcome<EventCatalogRemovalResult> {
  if (typeof previewFingerprint !== "string")
    return invalid("Event Catalog removal preview is required.");
  const preview = previewEventCatalogRemovalOperation(transaction, input);
  if (preview.status !== "accepted") return preview;
  if (preview.value.fingerprint !== previewFingerprint)
    return invalid("Event Catalog removal preview is stale.");
  if (!preview.value.eligible)
    return inUse(preview.value.repairWorkflow ?? "Event Catalog removal is not eligible.");
  if (!Number.isSafeInteger(retiredAuthorityCount) || retiredAuthorityCount < 0)
    return invalid("Event Catalog authority impact is invalid.");
  const nowMs = validNow(clock);
  if (nowMs === null) return invalid("Event clock returned an invalid timestamp.");
  const target = preview.value.target;
  const before = readRemovalTarget(transaction, target);
  if (before === null) return notFound("Event Catalog removal target was not found.");
  switch (target.kind) {
    case "event":
      transaction.deleteEvent(target.eventId);
      break;
    case "event-team":
      transaction.deleteEventTeam(target.targetId);
      break;
    case "game-day":
      transaction.deleteGameDay(target.targetId);
      break;
    case "pitch":
      transaction.deletePitch(target.targetId);
      break;
    case "gameplay-slot":
      transaction.deleteGameplaySlot(target.targetId);
      break;
    case "pitch-slot":
      transaction.deletePitchSlot(target.targetId);
      break;
    case "event-game":
      transaction.deleteEventGame(target.targetId);
      break;
  }
  transaction.appendAudit(
    createAudit(
      ids,
      "event-catalog-entry-removed",
      target.eventId,
      target.kind === "game-day" ? target.targetId : null,
      actorReference,
      nowMs,
      removalAuditPayload(target),
      null,
    ),
  );
  return accepted({
    removed: true,
    target,
    retiredAuthorityCount,
    retainedEventGameCount: preview.value.impact.retainedEventGameCount,
    retainedControlActionCount: preview.value.impact.retainedControlActionCount,
  });
}

function removalAuditPayload(target: EventCatalogRemovalTarget): {
  kind: EventCatalogRemovalKind;
  eventId: string;
  targetId: string;
} {
  return {
    kind: target.kind,
    eventId: target.eventId,
    targetId: target.targetId,
  };
}

function parseRemovalTarget(
  input: EventCatalogRemovalTargetInput,
): { ok: true; value: EventCatalogRemovalTarget } | { ok: false; error: string } {
  if (!isRecord(input)) return { ok: false, error: "Event Catalog removal target is invalid." };
  const kinds: readonly EventCatalogRemovalKind[] = [
    "event",
    "event-team",
    "game-day",
    "pitch",
    "gameplay-slot",
    "pitch-slot",
    "event-game",
  ];
  if (!kinds.includes(input.kind as EventCatalogRemovalKind))
    return { ok: false, error: "Event Catalog removal target is invalid." };
  const eventId = validateId(input.eventId, "eventId");
  const targetId = validateId(input.targetId, "targetId");
  if (!eventId.ok || !targetId.ok)
    return { ok: false, error: "Event Catalog removal target is invalid." };
  if (input.kind === "event" && eventId.value !== targetId.value)
    return { ok: false, error: "Event Catalog removal target is invalid." };
  return {
    ok: true,
    value: {
      kind: input.kind as EventCatalogRemovalKind,
      eventId: eventId.value,
      targetId: targetId.value,
    },
  };
}

function readRemovalTarget(
  transaction: EventCatalogStorageSnapshot,
  target: EventCatalogRemovalTarget,
): unknown {
  if (target.kind === "event") return transaction.findEvent(target.eventId);
  if (target.kind === "event-team") return transaction.findEventTeam(target.targetId);
  if (target.kind === "game-day")
    return (
      transaction.listGameDays(target.eventId).find((day) => day.gameDayId === target.targetId) ??
      null
    );
  if (target.kind === "pitch") return transaction.findPitch(target.targetId);
  if (target.kind === "gameplay-slot") return transaction.findGameplaySlot(target.targetId);
  if (target.kind === "pitch-slot") return transaction.findPitchSlot(target.targetId);
  return transaction.findEventGame(target.targetId);
}

function removalFingerprint(
  target: EventCatalogRemovalTarget,
  impact: Pick<
    EventCatalogRemovalImpact,
    "descendantCount" | "retainedEventGameCount" | "retainedControlActionCount"
  >,
  targetRecord: unknown,
): string {
  return `event-catalog-target-v1:${sha256(
    canonicalizeJson({ version: 1, target, targetRecord, ...impact }),
  )}`;
}

function changePublicationStatusOperation(
  transaction: EventCatalogStorageTransaction,
  clock: EventCatalogClock,
  ids: EventCatalogIds,
  eventIdInput: unknown,
  input: { status: unknown; impactConfirmed?: unknown },
  actorReference: string,
): CatalogOutcome<EventPublicationStatusChange> {
  const eventId = validateId(eventIdInput, "eventId");
  if (!eventId.ok) return invalid(eventId.error);
  const status = validatePublicationStatus(input.status);
  if (!status.ok) return invalid(status.error);
  if (input.impactConfirmed !== undefined && typeof input.impactConfirmed !== "boolean")
    return invalid("Publication impact confirmation must be a boolean.");
  const nowMs = validNow(clock);
  if (nowMs === null) return invalid("Event clock returned an invalid timestamp.");
  const existing = transaction.findEvent(eventId.value);
  if (existing === null) return notFound("Event was not found.");
  if (existing.publicationStatus === status.value)
    return noChange("Publication Status is unchanged.");
  if (
    existing.publicationStatus === "published" &&
    status.value !== "published" &&
    input.impactConfirmed !== true
  )
    return invalid("Impact confirmation is required before leaving Published.");
  const gameDays = transaction.listGameDays(existing.eventId);
  if (status.value === "published") {
    if (existing.name.trim().length === 0 || existing.timeZone.trim().length === 0)
      return invalid("Publishing requires an Event name and timezone.");
    if (gameDays.length === 0) return invalid("Publishing requires at least one Game Day.");
  }
  const teams = transaction.listEventTeams(existing.eventId);
  const pitches = transaction.listPitches(existing.eventId);
  const daySchedules = gameDays.map((day) => ({
    gameplaySlots: transaction.listGameplaySlots(day.gameDayId),
    pitchSlots: transaction.listPitchSlots(day.gameDayId),
    eventGames: transaction.listEventGames(day.gameDayId),
  }));
  const gameplaySlots = daySchedules.flatMap((day) => day.gameplaySlots);
  const pitchSlots = daySchedules.flatMap((day) => day.pitchSlots);
  const eventGames = daySchedules.flatMap((day) => day.eventGames);
  const warnings: EventPublicationWarning[] = [];
  if (teams.length === 0) warnings.push("missing-event-teams");
  if (pitches.length === 0) warnings.push("missing-pitches");
  if (gameplaySlots.length === 0 || daySchedules.some((day) => day.gameplaySlots.length === 0))
    warnings.push("missing-gameplay-slots");
  if (pitchSlots.length === 0 || daySchedules.some((day) => day.pitchSlots.length === 0))
    warnings.push("missing-pitch-slots");
  if (eventGames.length === 0 || daySchedules.some((day) => day.eventGames.length === 0))
    warnings.push("missing-event-games");
  if (
    eventGames.some(
      (game) =>
        game.sideA.eventTeamId === null ||
        game.sideB.eventTeamId === null ||
        game.sideA.confirmedAtMs === null ||
        game.sideB.confirmedAtMs === null,
    )
  )
    warnings.push("unresolved-matchups");
  const updated: StoredEvent = {
    ...existing,
    publicationStatus: status.value,
    updatedAtMs: nowMs,
  };
  const audit = createAudit(
    ids,
    "event-publication-changed",
    existing.eventId,
    null,
    actorReference,
    nowMs,
    existing,
    updated,
  );
  transaction.updateEvent(updated);
  transaction.appendAudit(audit);
  const event = projectEventFromTransaction(transaction, updated, nowMs);
  return accepted({
    event,
    previousStatus: existing.publicationStatus,
    publicationStatus: updated.publicationStatus,
    warnings: status.value === "published" ? warnings : [],
  });
}

function createEventTeamOperation(
  transaction: EventCatalogStorageTransaction,
  clock: EventCatalogClock,
  ids: EventCatalogIds,
  eventIdInput: unknown,
  input: { name: unknown; defaultColor?: unknown },
  actorReference: string,
): CatalogOutcome<EventTeamProjection> {
  const eventId = validateId(eventIdInput, "eventId");
  if (!eventId.ok) return invalid(eventId.error);
  const name = validateTeamOrPitchName(input.name, "Event Team name");
  if (!name.ok) return invalid(name.error);
  const color = validateEventTeamColor(input.defaultColor);
  if (!color.ok) return invalid(color.error);
  const nowMs = validNow(clock);
  if (nowMs === null) return invalid("Event clock returned an invalid timestamp.");
  const event = transaction.findEvent(eventId.value);
  if (event === null) return notFound("Event was not found.");
  if (transaction.listEventTeams(event.eventId).some((team) => team.name === name.value))
    return duplicate("The Event already has a Team with this name.");
  const team: StoredEventTeam = {
    eventTeamId: ids.next("event"),
    eventId: event.eventId,
    name: name.value,
    defaultColor: color.value,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  const audit = createAudit(
    ids,
    "event-team-created",
    event.eventId,
    null,
    actorReference,
    nowMs,
    null,
    team,
  );
  transaction.insertEventTeam(team);
  transaction.appendAudit(audit);
  return accepted(projectTeam(transaction, team));
}

function updateEventTeamOperation(
  transaction: EventCatalogStorageTransaction,
  clock: EventCatalogClock,
  ids: EventCatalogIds,
  eventIdInput: unknown,
  eventTeamIdInput: unknown,
  input: { name?: unknown; defaultColor?: unknown },
  actorReference: string,
): CatalogOutcome<EventTeamProjection> {
  const eventId = validateId(eventIdInput, "eventId");
  const eventTeamId = validateId(eventTeamIdInput, "eventTeamId");
  if (!eventId.ok) return invalid(eventId.error);
  if (!eventTeamId.ok) return invalid(eventTeamId.error);
  if (input.name === undefined && input.defaultColor === undefined)
    return invalid("At least one Event Team field must be supplied.");
  const name =
    input.name === undefined ? null : validateTeamOrPitchName(input.name, "Event Team name");
  if (name !== null && !name.ok) return invalid(name.error);
  const color =
    input.defaultColor === undefined ? null : validateEventTeamColor(input.defaultColor);
  if (color !== null && !color.ok) return invalid(color.error);
  const nowMs = validNow(clock);
  if (nowMs === null) return invalid("Event clock returned an invalid timestamp.");
  const event = transaction.findEvent(eventId.value);
  if (event === null) return notFound("Event was not found.");
  const existing = transaction.findEventTeam(eventTeamId.value);
  if (existing === null) return notFound("Event Team was not found.");
  if (existing.eventId !== event.eventId) return crossEvent("Event Team belongs to another Event.");
  const updated: StoredEventTeam = {
    ...existing,
    name: name === null ? existing.name : name.value,
    defaultColor: color === null ? existing.defaultColor : color.value,
    updatedAtMs: nowMs,
  };
  if (updated.name === existing.name && updated.defaultColor === existing.defaultColor)
    return noChange("The Event Team already has these values.");
  if (
    transaction
      .listEventTeams(event.eventId)
      .some((team) => team.eventTeamId !== existing.eventTeamId && team.name === updated.name)
  )
    return duplicate("The Event already has a Team with this name.");
  const audit = createAudit(
    ids,
    "event-team-updated",
    event.eventId,
    null,
    actorReference,
    nowMs,
    existing,
    updated,
  );
  transaction.updateEventTeam(updated);
  transaction.appendAudit(audit);
  return accepted(projectTeam(transaction, updated));
}

function upsertRosterOperation(
  transaction: EventCatalogStorageTransaction,
  clock: EventCatalogClock,
  ids: EventCatalogIds,
  eventIdInput: unknown,
  eventTeamIdInput: unknown,
  input: { playerNumber: unknown; publicName: unknown },
  actorReference: string,
): CatalogOutcome<StoredRosterEntry> {
  const eventId = validateId(eventIdInput, "eventId");
  const eventTeamId = validateId(eventTeamIdInput, "eventTeamId");
  if (!eventId.ok) return invalid(eventId.error);
  if (!eventTeamId.ok) return invalid(eventTeamId.error);
  const playerNumber = validatePlayerNumber(input.playerNumber);
  if (!playerNumber.ok) return invalid(playerNumber.error);
  const publicName = normalizeBoundedText(
    input.publicName,
    SHARED_LIMITS.names.teamAndPitchMaxCodePoints,
    "Player public name",
  );
  if (!publicName.ok) return invalid(publicName.error);
  const nowMs = validNow(clock);
  if (nowMs === null) return invalid("Event clock returned an invalid timestamp.");
  const event = transaction.findEvent(eventId.value);
  if (event === null) return notFound("Event was not found.");
  const team = transaction.findEventTeam(eventTeamId.value);
  if (team === null) return notFound("Event Team was not found.");
  if (team.eventId !== event.eventId) return crossEvent("Event Team belongs to another Event.");
  const existing = transaction.findRosterEntry(team.eventTeamId, playerNumber.value);
  const entry: StoredRosterEntry =
    existing === null
      ? {
          rosterEntryId: ids.next("event"),
          eventId: event.eventId,
          eventTeamId: team.eventTeamId,
          playerNumber: playerNumber.value,
          publicName: publicName.value,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        }
      : { ...existing, publicName: publicName.value, updatedAtMs: nowMs };
  if (existing !== null && existing.publicName === entry.publicName)
    return noChange("The roster entry already has this public name.");
  const audit = createAudit(
    ids,
    "roster-updated",
    event.eventId,
    null,
    actorReference,
    nowMs,
    existing,
    entry,
  );
  if (existing === null) transaction.insertRosterEntry(entry);
  else transaction.updateRosterEntry(entry);
  transaction.appendAudit(audit);
  return accepted(entry);
}

function createPitchOperation(
  transaction: EventCatalogStorageTransaction,
  clock: EventCatalogClock,
  ids: EventCatalogIds,
  eventIdInput: unknown,
  input: { name: unknown },
  actorReference: string,
): CatalogOutcome<StoredPitch> {
  const eventId = validateId(eventIdInput, "eventId");
  if (!eventId.ok) return invalid(eventId.error);
  const name = validateTeamOrPitchName(input.name, "Pitch name");
  if (!name.ok) return invalid(name.error);
  const nowMs = validNow(clock);
  if (nowMs === null) return invalid("Event clock returned an invalid timestamp.");
  const event = transaction.findEvent(eventId.value);
  if (event === null) return notFound("Event was not found.");
  if (transaction.listPitches(event.eventId).some((pitch) => pitch.name === name.value))
    return duplicate("The Event already has a Pitch with this name.");
  const pitch: StoredPitch = {
    pitchId: ids.next("event"),
    eventId: event.eventId,
    name: name.value,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  const audit = createAudit(
    ids,
    "pitch-created",
    event.eventId,
    null,
    actorReference,
    nowMs,
    null,
    pitch,
  );
  transaction.insertPitch(pitch);
  for (const day of transaction.listGameDays(event.eventId)) {
    for (const gameplaySlot of transaction.listGameplaySlots(day.gameDayId)) {
      const pitchSlot: PitchSlot = {
        pitchSlotId: ids.next("pitch-slot"),
        eventId: event.eventId,
        gameDayId: day.gameDayId,
        pitchId: pitch.pitchId,
        gameplaySlotId: gameplaySlot.gameplaySlotId,
        sequence: gameplaySlot.sequence,
        expectedDelayMs: 0,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      transaction.insertPitchSlot(pitchSlot);
      transaction.appendAudit(
        createAudit(
          ids,
          "pitch-slot-created",
          event.eventId,
          day.gameDayId,
          actorReference,
          nowMs,
          null,
          pitchSlot,
        ),
      );
    }
  }
  transaction.appendAudit(audit);
  return accepted(pitch);
}

function createGameplaySlotOperation(
  transaction: EventCatalogStorageTransaction,
  clock: EventCatalogClock,
  ids: EventCatalogIds,
  eventIdInput: unknown,
  gameDayIdInput: unknown,
  input: { sequence: unknown; scheduledStart?: unknown; scheduledStartMs?: unknown },
  actorReference: string,
): CatalogOutcome<GameplaySlot> {
  const eventId = validateId(eventIdInput, "eventId");
  const gameDayId = validateId(gameDayIdInput, "gameDayId");
  if (!eventId.ok) return invalid(eventId.error);
  if (!gameDayId.ok) return invalid(gameDayId.error);
  const sequence = validatePositiveSequence(input.sequence);
  if (!sequence.ok) return invalid(sequence.error);
  const nowMs = validNow(clock);
  if (nowMs === null) return invalid("Event clock returned an invalid timestamp.");
  const event = transaction.findEvent(eventId.value);
  if (event === null) return notFound("Event was not found.");
  const day = transaction
    .listGameDays(event.eventId)
    .find((candidate) => candidate.gameDayId === gameDayId.value);
  if (day === undefined) {
    const elsewhere = transaction
      .listEvents()
      .some((candidate) =>
        transaction
          .listGameDays(candidate.eventId)
          .some((candidateDay) => candidateDay.gameDayId === gameDayId.value),
      );
    return elsewhere
      ? crossEvent("Game Day belongs to another Event.")
      : notFound("Game Day was not found.");
  }
  const scheduledStartMs = validateScheduledStart(
    input.scheduledStart ?? input.scheduledStartMs,
    event.timeZone,
    day.date,
  );
  if (!scheduledStartMs.ok) return invalid(scheduledStartMs.error);
  if (transaction.listGameplaySlots(day.gameDayId).some((slot) => slot.sequence === sequence.value))
    return duplicate("The Game Day already has a Gameplay Slot with this sequence.");
  const slot: GameplaySlot = {
    gameplaySlotId: ids.next("gameplay-slot"),
    eventId: event.eventId,
    gameDayId: day.gameDayId,
    sequence: sequence.value,
    scheduledStartMs: scheduledStartMs.value,
    expectedDelayMs: 0,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  transaction.insertGameplaySlot(slot);
  for (const pitch of transaction.listPitches(event.eventId)) {
    const pitchSlot: PitchSlot = {
      pitchSlotId: ids.next("pitch-slot"),
      eventId: event.eventId,
      gameDayId: day.gameDayId,
      pitchId: pitch.pitchId,
      gameplaySlotId: slot.gameplaySlotId,
      sequence: slot.sequence,
      expectedDelayMs: 0,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    transaction.insertPitchSlot(pitchSlot);
    transaction.appendAudit(
      createAudit(
        ids,
        "pitch-slot-created",
        event.eventId,
        day.gameDayId,
        actorReference,
        nowMs,
        null,
        pitchSlot,
      ),
    );
  }
  transaction.appendAudit(
    createAudit(
      ids,
      "gameplay-slot-created",
      event.eventId,
      day.gameDayId,
      actorReference,
      nowMs,
      null,
      slot,
    ),
  );
  return accepted(slot);
}

function createEventGameOperation(
  transaction: EventCatalogStorageTransaction,
  clock: EventCatalogClock,
  ids: EventCatalogIds,
  eventIdInput: unknown,
  gameDayIdInput: unknown,
  input: {
    gameplaySlotId: unknown;
    pitchSlotId: unknown;
    gameCode?: unknown;
    gameDesignation?: unknown;
    sideA?: unknown;
    sideB?: unknown;
  },
  actorReference: string,
): CatalogOutcome<EventGame> {
  const eventId = validateId(eventIdInput, "eventId");
  const gameDayId = validateId(gameDayIdInput, "gameDayId");
  const gameplaySlotId = validateId(input.gameplaySlotId, "gameplaySlotId");
  const pitchSlotId = validateId(input.pitchSlotId, "pitchSlotId");
  if (!eventId.ok) return invalid(eventId.error);
  if (!gameDayId.ok) return invalid(gameDayId.error);
  if (!gameplaySlotId.ok) return invalid(gameplaySlotId.error);
  if (!pitchSlotId.ok) return invalid(pitchSlotId.error);
  const gameCode = validateOptionalText(input.gameCode, 32, "Game Code");
  const gameDesignation = validateOptionalText(
    input.gameDesignation,
    SHARED_LIMITS.names.eventAndGameDesignationMaxCodePoints,
    "Game Designation",
  );
  if (!gameCode.ok) return invalid(gameCode.error);
  if (!gameDesignation.ok) return invalid(gameDesignation.error);
  const nowMs = validNow(clock);
  if (nowMs === null) return invalid("Event clock returned an invalid timestamp.");
  const event = transaction.findEvent(eventId.value);
  if (event === null) return notFound("Event was not found.");
  const day = transaction
    .listGameDays(event.eventId)
    .find((candidate) => candidate.gameDayId === gameDayId.value);
  if (day === undefined) return notFound("Game Day was not found.");
  const gameplaySlot = transaction.findGameplaySlot(gameplaySlotId.value);
  const pitchSlot = transaction.findPitchSlot(pitchSlotId.value);
  if (gameplaySlot === null || pitchSlot === null) return notFound("Schedule Slot was not found.");
  if (gameplaySlot.eventId !== event.eventId || pitchSlot.eventId !== event.eventId)
    return crossEvent("Schedule Slot belongs to another Event.");
  if (gameplaySlot.gameDayId !== day.gameDayId || pitchSlot.gameDayId !== day.gameDayId)
    return invalid("Event Game must use Slots from the selected Game Day.");
  if (pitchSlot.gameplaySlotId !== gameplaySlot.gameplaySlotId)
    return invalid("Pitch Slot must belong to the selected Gameplay Slot.");
  if (
    transaction
      .listEventGames(day.gameDayId)
      .some((game) => game.pitchSlotId === pitchSlot.pitchSlotId)
  ) {
    return duplicate("The Pitch Slot already contains an Event Game.");
  }
  if (
    gameCode.value !== null &&
    transaction
      .listGameDays(event.eventId)
      .flatMap((candidateDay) => transaction.listEventGames(candidateDay.gameDayId))
      .some((game) => game.gameCode === gameCode.value)
  )
    return duplicate("The Event already has an Event Game with this Game Code.");
  const rawSideA =
    input.sideA ??
    ((input as { sideAEventTeamId?: unknown }).sideAEventTeamId === undefined
      ? undefined
      : { eventTeamId: (input as { sideAEventTeamId?: unknown }).sideAEventTeamId });
  const rawSideB =
    input.sideB ??
    ((input as { sideBEventTeamId?: unknown }).sideBEventTeamId === undefined
      ? undefined
      : { eventTeamId: (input as { sideBEventTeamId?: unknown }).sideBEventTeamId });
  const sideA = parseEventGameSide(transaction, event.eventId, rawSideA, "sideA", nowMs);
  if (!sideA.ok) return invalid(sideA.error);
  const sideB = parseEventGameSide(transaction, event.eventId, rawSideB, "sideB", nowMs);
  if (!sideB.ok) return invalid(sideB.error);
  if (sideA.value.eventTeamId !== null && sideA.value.eventTeamId === sideB.value.eventTeamId)
    return invalid("Event Game sides must use distinct Event Teams.");
  if (sideA.value.eventTeamId !== null || sideB.value.eventTeamId !== null)
    return invalid(
      "Create Event Games with source labels, then confirm actual teams by Gameplay Slot.",
    );
  const game: EventGame = {
    eventGameId: ids.next("event-game"),
    eventId: event.eventId,
    gameDayId: day.gameDayId,
    gameplaySlotId: gameplaySlot.gameplaySlotId,
    pitchSlotId: pitchSlot.pitchSlotId,
    gameCode: gameCode.value,
    gameDesignation: gameDesignation.value,
    sideA: { ...sideA.value, sideId: ids.next("event-game-side") },
    sideB: { ...sideB.value, sideId: ids.next("event-game-side") },
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  transaction.insertEventGame(game);
  transaction.appendAudit(
    createAudit(
      ids,
      "event-game-created",
      event.eventId,
      day.gameDayId,
      actorReference,
      nowMs,
      null,
      game,
    ),
  );
  return accepted(game);
}

function confirmGameplaySlotTeamsOperation(
  transaction: EventCatalogStorageTransaction,
  clock: EventCatalogClock,
  ids: EventCatalogIds,
  eventIdInput: unknown,
  gameDayIdInput: unknown,
  gameplaySlotIdInput: unknown,
  input: { games: unknown },
  actorReference: string,
): CatalogOutcome<readonly EventGame[]> {
  const eventId = validateId(eventIdInput, "eventId");
  const gameDayId = validateId(gameDayIdInput, "gameDayId");
  const gameplaySlotId = validateId(gameplaySlotIdInput, "gameplaySlotId");
  if (!eventId.ok) return invalid(eventId.error);
  if (!gameDayId.ok) return invalid(gameDayId.error);
  if (!gameplaySlotId.ok) return invalid(gameplaySlotId.error);
  if (!Array.isArray(input.games))
    return invalid("Gameplay Slot confirmation requires a games array.");
  const nowMs = validNow(clock);
  if (nowMs === null) return invalid("Event clock returned an invalid timestamp.");
  const event = transaction.findEvent(eventId.value);
  const slot = transaction.findGameplaySlot(gameplaySlotId.value);
  if (event === null || slot === null) return notFound("Event or Gameplay Slot was not found.");
  if (slot.eventId !== event.eventId || slot.gameDayId !== gameDayId.value)
    return crossEvent("Gameplay Slot does not belong to the selected Event and Game Day.");
  const games = transaction
    .listEventGames(gameDayId.value)
    .filter((game) => game.gameplaySlotId === slot.gameplaySlotId);
  if (games.length === 0) return invalid("Gameplay Slot has no Event Games to confirm.");
  if (games.length !== input.games.length)
    return invalid("Confirm every Event Game in one Gameplay Slot together.");
  const assignments = new Map<string, { sideA: string; sideB: string }>();
  for (const value of input.games) {
    if (!isRecord(value)) return invalid("Each Gameplay Slot confirmation must be an object.");
    const gameId = validateId(value.eventGameId, "eventGameId");
    const sideA = validateId(value.sideAEventTeamId, "sideAEventTeamId");
    const sideB = validateId(value.sideBEventTeamId, "sideBEventTeamId");
    if (!gameId.ok) return invalid(gameId.error);
    if (!sideA.ok) return invalid(sideA.error);
    if (!sideB.ok) return invalid(sideB.error);
    if (sideA.value === sideB.value)
      return invalid("Event Game sides must use distinct Event Teams.");
    if (assignments.has(gameId.value))
      return invalid("Gameplay Slot confirmation contains a duplicate Event Game.");
    assignments.set(gameId.value, { sideA: sideA.value, sideB: sideB.value });
  }
  if (games.some((game) => !assignments.has(game.eventGameId)))
    return invalid("Confirm every Event Game in one Gameplay Slot together.");
  const teams = new Map(
    transaction.listEventTeams(event.eventId).map((team) => [team.eventTeamId, team]),
  );
  const prepared = new Map<string, { game: EventGame; next: EventGame | null }>();
  let changed = false;
  for (const game of games) {
    const assignment = assignments.get(game.eventGameId);
    if (assignment === undefined)
      return invalid("Confirm every Event Game in one Gameplay Slot together.");
    const sideATeam = teams.get(assignment.sideA);
    const sideBTeam = teams.get(assignment.sideB);
    if (sideATeam === undefined || sideBTeam === undefined)
      return crossEvent("Confirmed Event Teams must belong to the selected Event.");
    const root = transaction.findRootByEventGameId(game.eventGameId);
    if (
      root !== null &&
      (root.lifecycle.phase !== "scheduled" || root.lifecycle.commencedAtMs !== null)
    )
      return invalid("Gameplay Slot teams cannot change after Game commencement.");
    if (
      (game.sideA.eventTeamId !== null && game.sideA.eventTeamId !== assignment.sideA) ||
      (game.sideB.eventTeamId !== null && game.sideB.eventTeamId !== assignment.sideB)
    )
      return invalid("Confirmed Event Game teams cannot be changed here.");
    if (
      (game.sideA.eventTeamId !== null && game.sideA.eventTeamName === null) ||
      (game.sideB.eventTeamId !== null && game.sideB.eventTeamName === null)
    )
      return invalid("Confirmed Event Game teams are missing required name snapshots.");
    if (
      game.sideA.eventTeamId === assignment.sideA &&
      game.sideB.eventTeamId === assignment.sideB
    ) {
      prepared.set(game.eventGameId, { game, next: null });
      continue;
    }
    const next: EventGame = {
      ...game,
      sideA: {
        ...game.sideA,
        eventTeamId: assignment.sideA,
        eventTeamName: sideATeam.name,
        sourceLabel: null,
        confirmedAtMs: nowMs,
      },
      sideB: {
        ...game.sideB,
        eventTeamId: assignment.sideB,
        eventTeamName: sideBTeam.name,
        sourceLabel: null,
        confirmedAtMs: nowMs,
      },
      updatedAtMs: nowMs,
    };
    prepared.set(game.eventGameId, { game, next });
    changed = true;
  }
  const updated: EventGame[] = [];
  for (const { game, next } of prepared.values()) {
    if (next === null) updated.push(game);
    else {
      transaction.updateEventGame(next);
      updated.push(next);
    }
  }
  for (const { game, next } of prepared.values()) {
    if (next !== null)
      transaction.appendAudit(
        createAudit(
          ids,
          "event-game-teams-confirmed",
          event.eventId,
          gameDayId.value,
          actorReference,
          nowMs,
          game,
          next,
        ),
      );
  }
  return changed ? accepted(updated) : noChange("Gameplay Slot teams are already confirmed.");
}

function setGameplaySlotExpectedDelayOperation(
  transaction: EventCatalogStorageTransaction,
  clock: EventCatalogClock,
  ids: EventCatalogIds,
  eventIdInput: unknown,
  gameDayIdInput: unknown,
  gameplaySlotIdInput: unknown,
  input: { expectedDelayMs: unknown; cascade?: unknown },
  actorReference: string,
): CatalogOutcome<ScheduleDelayPreview> {
  const eventId = validateId(eventIdInput, "eventId");
  const gameDayId = validateId(gameDayIdInput, "gameDayId");
  const slotId = validateId(gameplaySlotIdInput, "gameplaySlotId");
  const delay = validateDelay(input.expectedDelayMs);
  if (!eventId.ok || !gameDayId.ok || !slotId.ok)
    return invalid("Schedule Slot identifier is invalid.");
  if (!delay.ok) return invalid(delay.error);
  const event = transaction.findEvent(eventId.value);
  const slot = transaction.findGameplaySlot(slotId.value);
  if (event === null || slot === null) return notFound("Gameplay Slot was not found.");
  if (slot.eventId !== event.eventId || slot.gameDayId !== gameDayId.value)
    return crossEvent("Gameplay Slot does not belong to the selected Event and Game Day.");
  const cascade = input.cascade === true;
  const slots = transaction
    .listGameplaySlots(gameDayId.value)
    .filter(
      (candidate) =>
        candidate.sequence >= slot.sequence && (cascade || candidate.sequence === slot.sequence),
    );
  const changedSlots = slots.filter((candidate) => candidate.expectedDelayMs !== delay.value);
  if (changedSlots.length === 0)
    return noChange("Gameplay Slot Expected Delay is already applied.");
  const preview = createDelayPreview(
    transaction,
    "gameplay-slot",
    slot.gameplaySlotId,
    changedSlots,
    delay.value,
    cascade,
  );
  const nowMs = validNow(clock);
  if (nowMs === null) return invalid("Event clock returned an invalid timestamp.");
  for (const candidate of changedSlots) {
    transaction.updateGameplaySlot({
      ...candidate,
      expectedDelayMs: delay.value,
      updatedAtMs: nowMs,
    });
  }
  transaction.appendAudit(
    createAudit(
      ids,
      "event-updated",
      event.eventId,
      gameDayId.value,
      actorReference,
      nowMs,
      null,
      preview,
    ),
  );
  return accepted(preview);
}

function previewGameplaySlotExpectedDelayOperation(
  transaction: EventCatalogStorageTransaction,
  eventIdInput: unknown,
  gameDayIdInput: unknown,
  gameplaySlotIdInput: unknown,
  input: { expectedDelayMs: unknown; cascade?: unknown },
): CatalogOutcome<ScheduleDelayPreview> {
  const eventId = validateId(eventIdInput, "eventId");
  const gameDayId = validateId(gameDayIdInput, "gameDayId");
  const slotId = validateId(gameplaySlotIdInput, "gameplaySlotId");
  const delay = validateDelay(input.expectedDelayMs);
  if (!eventId.ok || !gameDayId.ok || !slotId.ok)
    return invalid("Schedule Slot identifier is invalid.");
  if (!delay.ok) return invalid(delay.error);
  const event = transaction.findEvent(eventId.value);
  const slot = transaction.findGameplaySlot(slotId.value);
  if (event === null || slot === null) return notFound("Gameplay Slot was not found.");
  if (slot.eventId !== event.eventId || slot.gameDayId !== gameDayId.value)
    return crossEvent("Gameplay Slot does not belong to the selected Event and Game Day.");
  const cascade = input.cascade === true;
  const slots = transaction
    .listGameplaySlots(gameDayId.value)
    .filter(
      (candidate) =>
        candidate.sequence >= slot.sequence && (cascade || candidate.sequence === slot.sequence),
    );
  if (slots.every((candidate) => candidate.expectedDelayMs === delay.value))
    return noChange("Gameplay Slot Expected Delay is already applied.");
  return accepted(
    createDelayPreview(
      transaction,
      "gameplay-slot",
      slot.gameplaySlotId,
      slots,
      delay.value,
      cascade,
    ),
  );
}

function setPitchSlotExpectedDelayOperation(
  transaction: EventCatalogStorageTransaction,
  clock: EventCatalogClock,
  ids: EventCatalogIds,
  eventIdInput: unknown,
  gameDayIdInput: unknown,
  pitchSlotIdInput: unknown,
  input: { expectedDelayMs: unknown; cascade?: unknown },
  actorReference: string,
): CatalogOutcome<ScheduleDelayPreview> {
  const eventId = validateId(eventIdInput, "eventId");
  const gameDayId = validateId(gameDayIdInput, "gameDayId");
  const slotId = validateId(pitchSlotIdInput, "pitchSlotId");
  const delay = validateDelay(input.expectedDelayMs);
  if (!eventId.ok || !gameDayId.ok || !slotId.ok)
    return invalid("Schedule Slot identifier is invalid.");
  if (!delay.ok) return invalid(delay.error);
  const event = transaction.findEvent(eventId.value);
  const slot = transaction.findPitchSlot(slotId.value);
  if (event === null || slot === null) return notFound("Pitch Slot was not found.");
  if (slot.eventId !== event.eventId || slot.gameDayId !== gameDayId.value)
    return crossEvent("Pitch Slot does not belong to the selected Event and Game Day.");
  const cascade = input.cascade === true;
  const slots = transaction
    .listPitchSlots(gameDayId.value, slot.pitchId)
    .filter(
      (candidate) =>
        candidate.sequence >= slot.sequence && (cascade || candidate.sequence === slot.sequence),
    );
  const changedSlots = slots.filter((candidate) => candidate.expectedDelayMs !== delay.value);
  if (changedSlots.length === 0) return noChange("Pitch Slot Expected Delay is already applied.");
  const preview = createDelayPreview(
    transaction,
    "pitch-slot",
    slot.pitchSlotId,
    changedSlots,
    delay.value,
    cascade,
  );
  const nowMs = validNow(clock);
  if (nowMs === null) return invalid("Event clock returned an invalid timestamp.");
  for (const candidate of changedSlots) {
    transaction.updatePitchSlot({ ...candidate, expectedDelayMs: delay.value, updatedAtMs: nowMs });
  }
  transaction.appendAudit(
    createAudit(
      ids,
      "event-updated",
      event.eventId,
      gameDayId.value,
      actorReference,
      nowMs,
      null,
      preview,
    ),
  );
  return accepted(preview);
}

function previewPitchSlotExpectedDelayOperation(
  transaction: EventCatalogStorageTransaction,
  eventIdInput: unknown,
  gameDayIdInput: unknown,
  pitchSlotIdInput: unknown,
  input: { expectedDelayMs: unknown; cascade?: unknown },
): CatalogOutcome<ScheduleDelayPreview> {
  const eventId = validateId(eventIdInput, "eventId");
  const gameDayId = validateId(gameDayIdInput, "gameDayId");
  const slotId = validateId(pitchSlotIdInput, "pitchSlotId");
  const delay = validateDelay(input.expectedDelayMs);
  if (!eventId.ok || !gameDayId.ok || !slotId.ok)
    return invalid("Schedule Slot identifier is invalid.");
  if (!delay.ok) return invalid(delay.error);
  const event = transaction.findEvent(eventId.value);
  const slot = transaction.findPitchSlot(slotId.value);
  if (event === null || slot === null) return notFound("Pitch Slot was not found.");
  if (slot.eventId !== event.eventId || slot.gameDayId !== gameDayId.value)
    return crossEvent("Pitch Slot does not belong to the selected Event and Game Day.");
  const cascade = input.cascade === true;
  const slots = transaction
    .listPitchSlots(gameDayId.value, slot.pitchId)
    .filter(
      (candidate) =>
        candidate.sequence >= slot.sequence && (cascade || candidate.sequence === slot.sequence),
    );
  if (slots.every((candidate) => candidate.expectedDelayMs === delay.value))
    return noChange("Pitch Slot Expected Delay is already applied.");
  return accepted(
    createDelayPreview(transaction, "pitch-slot", slot.pitchSlotId, slots, delay.value, cascade),
  );
}

function correctEventGameIdentityOperation(
  transaction: EventCatalogStorageTransaction,
  clock: EventCatalogClock,
  ids: EventCatalogIds,
  eventIdInput: unknown,
  gameDayIdInput: unknown,
  eventGameIdInput: unknown,
  input: EventGameIdentityCorrectionInput,
  actorReference: string,
): CatalogOutcome<EventGameIdentityCorrection> {
  const eventId = validateId(eventIdInput, "eventId");
  const gameDayId = validateId(gameDayIdInput, "gameDayId");
  const eventGameId = validateId(eventGameIdInput, "eventGameId");
  const gameSideId = validateId(input.gameSideId, "gameSideId");
  const targetEventTeamId = validateId(input.eventTeamId, "eventTeamId");
  const operationId =
    input.operationId === undefined
      ? { ok: true as const, value: ids.next("operation") }
      : validateId(input.operationId, "operationId");
  if (
    !eventId.ok ||
    !gameDayId.ok ||
    !eventGameId.ok ||
    !gameSideId.ok ||
    !targetEventTeamId.ok ||
    !operationId.ok
  )
    return invalid("Event Game identity correction identifier is invalid.");
  if (input.confirmation !== undefined && typeof input.confirmation !== "boolean")
    return invalid("Event Game identity correction confirmation must be a boolean.");
  const reasonResult =
    input.reason === undefined || input.reason === null
      ? { ok: true as const, value: null }
      : normalizeBoundedText(
          input.reason,
          SHARED_LIMITS.names.operatorNoteMaxCodePoints,
          "Event Game identity correction reason",
        );
  if (!reasonResult.ok) return invalid(reasonResult.error);
  const reason = reasonResult.value;
  if (reason !== null && reason.length === 0)
    return invalid("Event Game identity correction reason must not be empty.");
  const nowMs = validNow(clock);
  if (nowMs === null) return invalid("Event clock returned an invalid timestamp.");
  const event = transaction.findEvent(eventId.value);
  const game = transaction.findEventGame(eventGameId.value);
  if (event === null || game === null) return notFound("Event Game was not found.");
  const priorRoot = transaction.findRootByEventGameId(game.eventGameId);
  const commenced =
    priorRoot?.lifecycle.commencedAtMs !== null && priorRoot?.lifecycle.commencedAtMs !== undefined;
  const previousAttempt = transaction
    .listAuditTrail(event.eventId)
    .find(
      (entry) =>
        entry.operationId === operationId.value && entry.action === "event-game-teams-confirmed",
    );
  if (previousAttempt !== undefined) {
    const before = isRecord(previousAttempt.before) ? previousAttempt.before : null;
    const beforeGame = before !== null && isRecord(before.eventGame) ? before.eventGame : null;
    const beforeSideCandidate = beforeGame?.[sideKey(game, gameSideId.value)];
    const beforeSide = isRecord(beforeSideCandidate) ? beforeSideCandidate : null;
    const after = isRecord(previousAttempt.after) ? previousAttempt.after : null;
    const afterGame = after !== null && isRecord(after.eventGame) ? after.eventGame : null;
    const afterSideCandidate = afterGame?.[sideKey(game, gameSideId.value)];
    const afterSide = isRecord(afterSideCandidate) ? afterSideCandidate : null;
    const originalCorrection =
      after !== null && isRecord(after.correction) ? after.correction : null;
    if (afterSide !== null && afterSide.eventTeamId === targetEventTeamId.value) {
      return accepted({
        operationId: operationId.value,
        eventGameId: game.eventGameId,
        gameSideId: gameSideId.value,
        previousEventTeamId:
          typeof beforeSide?.eventTeamId === "string" ? beforeSide.eventTeamId : "",
        previousEventTeamName:
          typeof beforeSide?.eventTeamName === "string" ? beforeSide.eventTeamName : "",
        eventTeamId: afterSide.eventTeamId,
        eventTeamName: typeof afterSide.eventTeamName === "string" ? afterSide.eventTeamName : "",
        commenced,
        reason: typeof originalCorrection?.reason === "string" ? originalCorrection.reason : null,
        controllerAcknowledgementRequired: commenced,
      });
    }
    return {
      status: "rejected",
      reason: "duplicate",
      detail: "The identity correction operation is already bound to another Event Team.",
    };
  }
  if (game.eventId !== event.eventId || game.gameDayId !== gameDayId.value)
    return crossEvent("Event Game does not belong to the selected Event and Game Day.");
  const side =
    game.sideA.sideId === gameSideId.value
      ? "sideA"
      : game.sideB.sideId === gameSideId.value
        ? "sideB"
        : null;
  if (side === null)
    return invalid("Event Game identity correction references an unknown Game Side.");
  const target = transaction.findEventTeam(targetEventTeamId.value);
  if (target === null) return notFound("Event Team was not found.");
  if (target.eventId !== event.eventId) return crossEvent("Event Team belongs to another Event.");
  const otherSide = side === "sideA" ? game.sideB : game.sideA;
  if (otherSide.eventTeamId === target.eventTeamId)
    return invalid("Event Game sides must use distinct Event Teams.");
  if (commenced && input.confirmation !== true)
    return invalid("Post-commencement Event Game identity correction requires confirmation.");
  if (commenced && reason === null)
    return invalid("Post-commencement Event Game identity correction requires a reason.");
  const previous = side === "sideA" ? game.sideA : game.sideB;
  if (previous.eventTeamId === null || previous.eventTeamName === null)
    return invalid("Only an assigned Event Team identity can be corrected.");
  if (previous.eventTeamId === target.eventTeamId)
    return noChange("Event Game identity is unchanged.");
  const nextSide = {
    ...previous,
    eventTeamId: target.eventTeamId,
    eventTeamName: target.name,
    sourceLabel: null,
    confirmedAtMs: nowMs,
  };
  const next: EventGame = {
    ...game,
    ...(side === "sideA" ? { sideA: nextSide } : { sideB: nextSide }),
    updatedAtMs: nowMs,
  };
  transaction.updateEventGame(next);
  transaction.appendAudit(
    createAudit(
      ids,
      "event-game-teams-confirmed",
      event.eventId,
      gameDayId.value,
      actorReference,
      nowMs,
      { eventGame: game, correction: { gameSideId: gameSideId.value, reason } },
      { eventGame: next, correction: { gameSideId: gameSideId.value, reason } },
      operationId.value,
    ),
  );
  return accepted({
    operationId: operationId.value,
    eventGameId: game.eventGameId,
    gameSideId: gameSideId.value,
    previousEventTeamId: previous.eventTeamId ?? "",
    previousEventTeamName: previous.eventTeamName ?? "",
    eventTeamId: target.eventTeamId,
    eventTeamName: target.name,
    commenced,
    reason,
    controllerAcknowledgementRequired: commenced,
  });
}

function sideKey(game: EventGame, gameSideId: string): "sideA" | "sideB" {
  return game.sideA.sideId === gameSideId ? "sideA" : "sideB";
}

function reassignEventGameOperation(
  transaction: EventCatalogStorageTransaction,
  clock: EventCatalogClock,
  ids: EventCatalogIds,
  eventIdInput: unknown,
  gameDayIdInput: unknown,
  eventGameIdInput: unknown,
  input: { targetPitchSlotId: unknown; mode?: unknown },
  actorReference: string,
): CatalogOutcome<PitchReassignmentResult> {
  const eventId = validateId(eventIdInput, "eventId");
  const gameDayId = validateId(gameDayIdInput, "gameDayId");
  const gameId = validateId(eventGameIdInput, "eventGameId");
  const targetId = validateId(input.targetPitchSlotId, "targetPitchSlotId");
  if (!eventId.ok || !gameDayId.ok || !gameId.ok || !targetId.ok)
    return invalid("Pitch Reassignment identifier is invalid.");
  const mode = input.mode === undefined ? "move" : input.mode;
  if (mode !== "move" && mode !== "swap") return invalid("Pitch Reassignment mode is invalid.");
  const event = transaction.findEvent(eventId.value);
  const game = transaction.findEventGame(gameId.value);
  const target = transaction.findPitchSlot(targetId.value);
  if (event === null || game === null || target === null)
    return notFound("Schedule item was not found.");
  if (
    game.eventId !== event.eventId ||
    target.eventId !== event.eventId ||
    game.gameDayId !== gameDayId.value ||
    target.gameDayId !== gameDayId.value
  )
    return crossEvent("Pitch Reassignment belongs to another Event or Game Day.");
  if (game.pitchSlotId === target.pitchSlotId)
    return noChange("Event Game is already on this Pitch Slot.");
  const occupants = transaction
    .listEventGames(gameDayId.value)
    .filter(
      (candidate) =>
        candidate.pitchSlotId === target.pitchSlotId && candidate.eventGameId !== game.eventGameId,
    );
  if (mode === "swap" && occupants.length !== 1)
    return invalid(
      occupants.length === 0
        ? "Swap requires exactly one occupied target Pitch Slot."
        : "Swap requires exactly one target occupant; the target is already conflicted.",
    );
  const occupant = occupants[0] ?? null;
  const source = transaction.findPitchSlot(game.pitchSlotId);
  if (source === null) return notFound("Current Pitch Slot was not found.");
  const nowMs = validNow(clock);
  if (nowMs === null) return invalid("Event clock returned an invalid timestamp.");
  const updatedGame: EventGame = {
    ...game,
    gameplaySlotId: target.gameplaySlotId,
    pitchSlotId: target.pitchSlotId,
    updatedAtMs: nowMs,
  };
  let updatedOccupant: EventGame | null = null;
  if (occupant !== null && mode === "swap") {
    updatedOccupant = {
      ...occupant,
      gameplaySlotId: source.gameplaySlotId,
      pitchSlotId: source.pitchSlotId,
      updatedAtMs: nowMs,
    };
    transaction.updateEventGame(updatedOccupant);
  }
  transaction.updateEventGame(updatedGame);
  const projectedGames = projectScheduleGames(
    transaction,
    transaction.listEventGames(gameDayId.value),
  );
  const updatedProjection = projectedGames.find(
    (candidate) => candidate.eventGameId === updatedGame.eventGameId,
  );
  const result: PitchReassignmentResult = {
    mode,
    eventGame: updatedGame,
    swappedEventGame: updatedOccupant,
    scheduleConflict: updatedProjection?.scheduleConflict ?? false,
    teamScheduleConflicts: projectedGames
      .filter((candidate) => candidate.teamScheduleConflict)
      .map((candidate) => candidate.eventGameId),
  };
  transaction.appendAudit(
    createAudit(
      ids,
      "event-updated",
      event.eventId,
      gameDayId.value,
      actorReference,
      nowMs,
      { game, occupant },
      result,
    ),
  );
  return accepted(result);
}

function createDelayPreview(
  transaction: EventCatalogStorageTransaction,
  dimension: ScheduleDelayPreview["dimension"],
  targetSlotId: string,
  slots: readonly (GameplaySlot | PitchSlot)[],
  nextDelayMs: number,
  cascade: boolean,
): ScheduleDelayPreview {
  const changedSlots = slots.filter((slot) => slot.expectedDelayMs !== nextDelayMs);
  const changedIds = new Set(
    changedSlots.map((slot) =>
      dimension === "gameplay-slot"
        ? (slot as GameplaySlot).gameplaySlotId
        : (slot as PitchSlot).pitchSlotId,
    ),
  );
  const dayId = changedSlots[0]?.gameDayId ?? slots[0]?.gameDayId ?? "";
  const affectedGames = transaction
    .listEventGames(dayId)
    .filter((game) =>
      dimension === "gameplay-slot"
        ? changedIds.has(game.gameplaySlotId)
        : changedIds.has(game.pitchSlotId),
    );
  const afterTransaction = {
    findGameplaySlot: (gameplaySlotId: string) => {
      const current = transaction.findGameplaySlot(gameplaySlotId);
      return current !== null && dimension === "gameplay-slot" && changedIds.has(gameplaySlotId)
        ? { ...current, expectedDelayMs: nextDelayMs }
        : current;
    },
    findPitchSlot: (pitchSlotId: string) => {
      const current = transaction.findPitchSlot(pitchSlotId);
      return current !== null && dimension === "pitch-slot" && changedIds.has(pitchSlotId)
        ? { ...current, expectedDelayMs: nextDelayMs }
        : current;
    },
  };
  const beforeGames = projectScheduleGames(transaction, affectedGames);
  const afterGames = projectScheduleGames(afterTransaction, affectedGames);
  const beforeById = new Map(beforeGames.map((game) => [game.eventGameId, game]));
  const afterById = new Map(afterGames.map((game) => [game.eventGameId, game]));
  return {
    dimension,
    targetSlotId,
    cascade,
    changes: changedSlots.map((slot) => {
      const slotId =
        dimension === "gameplay-slot"
          ? (slot as GameplaySlot).gameplaySlotId
          : (slot as PitchSlot).pitchSlotId;
      return {
        slotId,
        beforeDelayMs: slot.expectedDelayMs,
        afterDelayMs: nextDelayMs,
        beforeExpectedStartMs: expectedStartForSlot(transaction, slot),
        afterExpectedStartMs: expectedStartForSlot(afterTransaction, {
          ...slot,
          expectedDelayMs: nextDelayMs,
        }),
        eventGames: affectedGames
          .filter((game) =>
            dimension === "gameplay-slot"
              ? game.gameplaySlotId === slotId
              : game.pitchSlotId === slotId,
          )
          .flatMap((game) => {
            const before = beforeById.get(game.eventGameId);
            const after = afterById.get(game.eventGameId);
            return before === undefined || after === undefined
              ? []
              : [
                  {
                    eventGameId: game.eventGameId,
                    beforeExpectedStartMs: before.expectedStartMs,
                    afterExpectedStartMs: after.expectedStartMs,
                    beforeExpectedPlayingPeriod: before.expectedPlayingPeriod,
                    afterExpectedPlayingPeriod: after.expectedPlayingPeriod,
                  },
                ];
          }),
      };
    }),
  };
}

function expectedStartForSlot(
  transaction: Pick<EventCatalogStorageSnapshot, "findGameplaySlot" | "findPitchSlot">,
  slot: GameplaySlot | PitchSlot,
): number {
  if ("scheduledStartMs" in slot) return slot.scheduledStartMs + slot.expectedDelayMs;
  const gameplaySlot = transaction.findGameplaySlot(slot.gameplaySlotId);
  return (
    (gameplaySlot?.scheduledStartMs ?? 0) +
    Math.max(gameplaySlot?.expectedDelayMs ?? 0, slot.expectedDelayMs)
  );
}

function validateDelay(value: unknown): { ok: true; value: number } | { ok: false; error: string } {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > 24 * 60 * 60 * 1000
  )
    return {
      ok: false,
      error: "Expected Delay must be a non-negative duration of at most 24 hours.",
    };
  return { ok: true, value: value as number };
}

export function projectScheduleGames(
  transaction: Pick<EventCatalogStorageSnapshot, "findGameplaySlot" | "findPitchSlot">,
  games: readonly EventGame[],
): ProjectedEventGame[] {
  const projected = games.map((game) => {
    const gameplay = transaction.findGameplaySlot(game.gameplaySlotId);
    const pitch = transaction.findPitchSlot(game.pitchSlotId);
    const pitchGameplay =
      pitch === null ? null : transaction.findGameplaySlot(pitch.gameplaySlotId);
    const expectedStartMs = Math.max(
      (gameplay?.scheduledStartMs ?? 0) + (gameplay?.expectedDelayMs ?? 0),
      (pitchGameplay?.scheduledStartMs ?? gameplay?.scheduledStartMs ?? 0) +
        Math.max(gameplay?.expectedDelayMs ?? 0, pitch?.expectedDelayMs ?? 0),
    );
    const expectedPlayingPeriod = {
      startMs: expectedStartMs,
      endMs: expectedStartMs + DEFAULT_EVENT_GAME_PLAYING_DURATION_MS,
    };
    const scheduleConflict = games.some(
      (other) => other.eventGameId !== game.eventGameId && other.pitchSlotId === game.pitchSlotId,
    );
    const teamIds = [game.sideA.eventTeamId, game.sideB.eventTeamId].filter(
      (id): id is string => id !== null,
    );
    return {
      ...structuredClone(game),
      expectedStartMs,
      expectedPlayingPeriod,
      scheduleConflict,
      teamIds,
    };
  });
  return projected.map(({ teamIds, ...game }) => ({
    ...game,
    teamScheduleConflict: projected.some(
      (other) =>
        other.eventGameId !== game.eventGameId &&
        other.gameDayId === game.gameDayId &&
        other.teamIds.some((otherTeamId) => teamIds.includes(otherTeamId)) &&
        other.expectedPlayingPeriod.startMs < game.expectedPlayingPeriod.endMs &&
        game.expectedPlayingPeriod.startMs < other.expectedPlayingPeriod.endMs,
    ),
  }));
}

function parseEventGameSide(
  transaction: EventCatalogStorageSnapshot,
  eventId: string,
  value: unknown,
  field: string,
  nowMs: number,
): { ok: true; value: Omit<EventGameSide, "sideId"> } | { ok: false; error: string } {
  if (typeof value === "string") value = { eventTeamId: value };
  if (!isRecord(value))
    return { ok: false, error: `${field} must specify an Event Team or source label.` };
  if (value.eventTeamId !== undefined) {
    const eventTeamId = validateId(value.eventTeamId, `${field}.eventTeamId`);
    if (!eventTeamId.ok) return eventTeamId;
    const team = transaction.findEventTeam(eventTeamId.value);
    if (team === null) return { ok: false, error: `${field} Event Team was not found.` };
    if (team.eventId !== eventId)
      return { ok: false, error: `${field} Event Team belongs to another Event.` };
    return {
      ok: true,
      value: {
        eventTeamId: team.eventTeamId,
        eventTeamName: team.name,
        sourceLabel: null,
        confirmedAtMs: nowMs,
      },
    };
  }
  const sourceLabel = normalizeBoundedText(
    value.sourceLabel,
    SHARED_LIMITS.names.eventAndGameDesignationMaxCodePoints,
    `${field} source label`,
  );
  if (!sourceLabel.ok) return sourceLabel;
  return {
    ok: true,
    value: {
      eventTeamId: null,
      eventTeamName: null,
      sourceLabel: sourceLabel.value,
      confirmedAtMs: null,
    },
  };
}

function validatePositiveSequence(
  value: unknown,
): { ok: true; value: number } | { ok: false; error: string } {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10_000)
    return { ok: false, error: "Gameplay Slot sequence must be a positive integer." };
  return { ok: true, value: value as number };
}

function validateScheduledStart(
  value: unknown,
  timeZone: string,
  gameDayDate: string,
): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof value !== "string")
    return { ok: false, error: "Scheduled Start must be a local Event time." };
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (match === null) return { ok: false, error: "Scheduled Start must be a local Event time." };
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = "00"] = match;
  const localDate = `${yearText}-${monthText}-${dayText}`;
  if (localDate !== gameDayDate)
    return { ok: false, error: "Scheduled Start must be on the selected Game Day." };
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== localDate
  )
    return { ok: false, error: "Scheduled Start must be a valid local Event time." };
  const wallUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  let candidateMs = wallUtcMs;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(candidateMs)).map((part) => [part.type, part.value]),
    );
    const representedWallUtcMs = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    candidateMs += wallUtcMs - representedWallUtcMs;
  }
  const localPartsMatch = (instantMs: number) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(instantMs)).map((part) => [part.type, part.value]),
    );
    return (
      `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}` ===
      `${localDate}T${hourText}:${minuteText}:${secondText}`
    );
  };
  const offsetAt = (instantMs: number) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(instantMs)).map((part) => [part.type, part.value]),
    );
    return (
      Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute),
        Number(parts.second),
      ) - instantMs
    );
  };
  const dayMs = 24 * 60 * 60 * 1000;
  const candidates = new Set<number>();
  for (const probeMs of [candidateMs - dayMs, candidateMs, candidateMs + dayMs])
    candidates.add(wallUtcMs - offsetAt(probeMs));
  const validCandidates = [...candidates].filter(localPartsMatch);
  if (validCandidates.length === 0)
    return { ok: false, error: "Scheduled Start is not a real local Event time." };
  if (validCandidates.length > 1)
    return { ok: false, error: "Scheduled Start is ambiguous during the Event timezone fallback." };
  return { ok: true, value: validCandidates[0] as number };
}

function validateOptionalText(
  value: unknown,
  maxCodePoints: number,
  field: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  const result = normalizeBoundedText(value, maxCodePoints, field);
  return result.ok ? { ok: true, value: result.value } : result;
}

function setGameDayHeatStoppageConfigurationOperation(
  transaction: EventCatalogStorageTransaction,
  clock: EventCatalogClock,
  ids: EventCatalogIds,
  eventIdInput: unknown,
  gameDayIdInput: unknown,
  input: { configuration: unknown },
  actorReference: string,
): CatalogOutcome<EventGameDay> {
  const eventId = validateId(eventIdInput, "eventId");
  const gameDayId = validateId(gameDayIdInput, "gameDayId");
  if (!eventId.ok) return invalid(eventId.error);
  if (!gameDayId.ok) return invalid(gameDayId.error);
  if (input.configuration !== "enabled" && input.configuration !== "disabled")
    return invalid("Heat Stoppage Configuration must be enabled or disabled.");
  const nowMs = validNow(clock);
  if (nowMs === null) return invalid("Event clock returned an invalid timestamp.");
  const event = transaction.findEvent(eventId.value);
  if (event === null) return notFound("Event was not found.");
  const existing = transaction
    .listGameDays(event.eventId)
    .find((day) => day.gameDayId === gameDayId.value);
  if (existing === undefined) {
    const elsewhere = transaction
      .listEvents()
      .some((candidate) =>
        transaction
          .listGameDays(candidate.eventId)
          .some((day) => day.gameDayId === gameDayId.value),
      );
    return elsewhere
      ? crossEvent("Game Day belongs to another Event.")
      : notFound("Game Day was not found.");
  }
  if (existing.heatStoppageConfiguration === input.configuration)
    return noChange("The Game Day already has this Heat Stoppage Configuration.");
  const updated: StoredGameDay = {
    ...existing,
    heatStoppageConfiguration: input.configuration,
    updatedAtMs: nowMs,
  };
  const audit = createAudit(
    ids,
    "game-day-heat-stoppage-configured",
    event.eventId,
    existing.gameDayId,
    actorReference,
    nowMs,
    { heatStoppageConfiguration: existing.heatStoppageConfiguration },
    { heatStoppageConfiguration: updated.heatStoppageConfiguration },
  );
  transaction.updateGameDay(updated);
  transaction.appendAudit(audit);
  return accepted(projectDay(updated, event.timeZone, nowMs));
}

function updatePitchOperation(
  transaction: EventCatalogStorageTransaction,
  clock: EventCatalogClock,
  ids: EventCatalogIds,
  eventIdInput: unknown,
  pitchIdInput: unknown,
  input: { name: unknown },
  actorReference: string,
): CatalogOutcome<StoredPitch> {
  const eventId = validateId(eventIdInput, "eventId");
  const pitchId = validateId(pitchIdInput, "pitchId");
  if (!eventId.ok) return invalid(eventId.error);
  if (!pitchId.ok) return invalid(pitchId.error);
  const name = validateTeamOrPitchName(input.name, "Pitch name");
  if (!name.ok) return invalid(name.error);
  const nowMs = validNow(clock);
  if (nowMs === null) return invalid("Event clock returned an invalid timestamp.");
  const event = transaction.findEvent(eventId.value);
  if (event === null) return notFound("Event was not found.");
  const existing = transaction.findPitch(pitchId.value);
  if (existing === null) return notFound("Pitch was not found.");
  if (existing.eventId !== event.eventId) return crossEvent("Pitch belongs to another Event.");
  if (existing.name === name.value) return noChange("The Pitch already has this name.");
  if (
    transaction
      .listPitches(event.eventId)
      .some((pitch) => pitch.pitchId !== existing.pitchId && pitch.name === name.value)
  )
    return duplicate("The Event already has a Pitch with this name.");
  const updated = { ...existing, name: name.value, updatedAtMs: nowMs };
  const audit = createAudit(
    ids,
    "pitch-updated",
    event.eventId,
    null,
    actorReference,
    nowMs,
    existing,
    updated,
  );
  transaction.updatePitch(updated);
  transaction.appendAudit(audit);
  return accepted(updated);
}

class InMemoryEventCatalogStorageImpl implements InMemoryEventCatalogStorage {
  private readonly foundation = createInMemoryFoundationStorage();
  private nextFailure: unknown = null;

  transaction<T>(work: (transaction: EventCatalogStorageTransaction) => T): Promise<T> {
    if (this.nextFailure !== null) {
      const failure = this.nextFailure;
      this.nextFailure = null;
      return Promise.reject(failure);
    }
    return this.foundation.transaction((transaction) => work(eventCatalogTransaction(transaction)));
  }

  snapshot(): Promise<EventCatalogStorageSnapshot> {
    return this.foundation.transaction((transaction) => eventCatalogSnapshot(transaction));
  }

  eventCatalogStorageCapability(): EventCatalogStorageCapability {
    requireEventCatalogStorageCapabilities(this.foundation);
    return this.foundation.eventCatalogStorageCapability();
  }

  close(): void {
    this.foundation.close();
  }

  failNextTransaction(error: unknown): void {
    this.nextFailure = error;
  }
}

export function createInMemoryEventCatalogStorage(): InMemoryEventCatalogStorage {
  return new InMemoryEventCatalogStorageImpl();
}

export function createFoundationEventCatalogStorage(
  storage: FoundationStorage,
): EventCatalogFoundationStorage {
  requireEventCatalogStorageCapabilities(storage);
  const capability = storage.eventCatalogStorageCapability();
  return {
    transaction<T>(work: (transaction: EventCatalogStorageTransaction) => T): Promise<T> {
      return storage.transaction((transaction) => work(eventCatalogTransaction(transaction)));
    },
    snapshot(): Promise<EventCatalogStorageSnapshot> {
      return storage.transaction((transaction) => eventCatalogSnapshot(transaction));
    },
    eventCatalogStorageCapability: () => capability,
  };
}

export function createUnavailableEventCatalogStorage(
  detail = "Event catalog foundation storage is unavailable.",
): EventCatalogFoundationStorage {
  const unavailable = async (): Promise<never> => {
    throw new Error(detail);
  };
  return {
    transaction: unavailable,
    snapshot: unavailable,
    eventCatalogStorageCapability: () => ({
      name: EVENT_CATALOG_STORAGE_CAPABILITY_NAME,
      version: EVENT_CATALOG_STORAGE_CAPABILITY_VERSION,
      implementation: EVENT_CATALOG_STORAGE_CAPABILITY_IMPLEMENTATION,
      transaction: REQUIRED_EVENT_CATALOG_STORAGE_TRANSACTION_METHODS,
    }),
  };
}

function eventCatalogSnapshot(transaction: FoundationStorageSnapshot): EventCatalogStorageSnapshot {
  return {
    findEvent: (eventId) => transaction.findEvent(eventId),
    listEvents: () => transaction.listEvents(),
    listGameDays: (eventId) => transaction.listGameDays(eventId),
    findEventTeam: (eventTeamId) => transaction.findEventTeam(eventTeamId),
    listEventTeams: (eventId) => transaction.listEventTeams(eventId),
    listRoster: (eventTeamId) => transaction.listRoster(eventTeamId),
    findRosterEntry: (eventTeamId, playerNumber) =>
      transaction.findRosterEntry(eventTeamId, playerNumber),
    findPitch: (pitchId) => transaction.findPitch(pitchId),
    listPitches: (eventId) => transaction.listPitches(eventId),
    findGameplaySlot: (gameplaySlotId) => transaction.findGameplaySlot?.(gameplaySlotId) ?? null,
    listGameplaySlots: (gameDayId) => transaction.listGameplaySlots?.(gameDayId) ?? [],
    findPitchSlot: (pitchSlotId) => transaction.findPitchSlot?.(pitchSlotId) ?? null,
    listPitchSlots: (gameDayId, pitchId) => transaction.listPitchSlots?.(gameDayId, pitchId) ?? [],
    findEventGame: (eventGameId) => transaction.findEventGame?.(eventGameId) ?? null,
    listEventGames: (gameDayId) => transaction.listEventGames?.(gameDayId) ?? [],
    findRootByEventGameId: (eventGameId) => transaction.findRootByEventGameId(eventGameId),
    listActions: (recordId) => transaction.listActions(recordId),
    listAuditTrail: (eventId) => transaction.listEventAuditTrail(eventId),
  };
}

function eventCatalogTransaction(
  transaction: FoundationStorageTransaction,
): EventCatalogStorageTransaction {
  return {
    ...eventCatalogSnapshot(transaction),
    insertEvent: (event) => transaction.insertEvent(event),
    updateEvent: (event) => transaction.updateEvent(event),
    deleteEvent: (eventId) => transaction.deleteEvent(eventId),
    insertGameDay: (gameDay) => transaction.insertGameDay(gameDay),
    updateGameDay: (gameDay) => transaction.updateGameDay(gameDay),
    deleteGameDay: (gameDayId) => transaction.deleteGameDay(gameDayId),
    insertEventTeam: (team) => transaction.insertEventTeam(team),
    updateEventTeam: (team) => transaction.updateEventTeam(team),
    deleteEventTeam: (eventTeamId) => transaction.deleteEventTeam(eventTeamId),
    insertRosterEntry: (entry) => transaction.insertRosterEntry(entry),
    updateRosterEntry: (entry) => transaction.updateRosterEntry(entry),
    insertPitch: (pitch) => transaction.insertPitch(pitch),
    updatePitch: (pitch) => transaction.updatePitch(pitch),
    deletePitch: (pitchId) => transaction.deletePitch(pitchId),
    insertGameplaySlot: (slot) => transaction.insertGameplaySlot(slot),
    insertPitchSlot: (slot) => transaction.insertPitchSlot(slot),
    updateGameplaySlot: (slot) => transaction.updateGameplaySlot(slot),
    updatePitchSlot: (slot) => transaction.updatePitchSlot(slot),
    deleteGameplaySlot: (gameplaySlotId) => transaction.deleteGameplaySlot(gameplaySlotId),
    deletePitchSlot: (pitchSlotId) => transaction.deletePitchSlot(pitchSlotId),
    insertEventGame: (game) => transaction.insertEventGame(game),
    updateEventGame: (game) => transaction.updateEventGame(game),
    deleteEventGame: (eventGameId) => transaction.deleteEventGame(eventGameId),
    appendAudit: (entry) => transaction.appendEventAudit(entry),
  };
}
