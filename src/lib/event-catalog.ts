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
} from "@/lib/foundation-storage";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";

export type EventPublicationStatus = "unpublished";
export type EventLifecycle = "unscheduled" | "future" | "current" | "past";
export type GameDayClassification = "future" | "current" | "past";

export type StoredEvent = StoredEventCatalogEvent;
export type StoredGameDay = StoredEventCatalogGameDay;
export type StoredEventTeam = StoredEventCatalogTeam;
export type StoredRosterEntry = StoredEventCatalogRosterEntry;
export type StoredPitch = StoredEventCatalogPitch;
export type EventAdministrationAuditEntry = EventCatalogAuditEntry;

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
  auditTrail: readonly EventAdministrationAuditEntry[];
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
): EventProjection {
  return project(event, gameDays, auditTrail, nowMs, teams, roster, pitches);
}

export type CatalogRejectedReason =
  | "invalid-input"
  | "unauthorized"
  | "not-found"
  | "cross-event"
  | "duplicate"
  | "no-change"
  | "in-use";

export type CatalogOutcome<T> =
  | { status: "accepted"; value: T }
  | { status: "rejected"; reason: CatalogRejectedReason; detail: string }
  | { status: "retryable-failure"; detail: string };

export type EventCatalogClock = {
  nowMs(): number;
};

export type EventCatalogIds = {
  next(kind: "event" | "game-day" | "audit" | "operation"): string;
};

export type EventCatalogOptions = {
  clock?: EventCatalogClock;
  ids?: EventCatalogIds;
};

export type EventCatalogMutationOperations = {
  createEventTeam(
    eventId: unknown,
    input: { name: unknown; defaultColor?: unknown },
  ): CatalogOutcome<EventTeamProjection>;
  updateEventTeam(
    eventId: unknown,
    eventTeamId: unknown,
    input: { name?: unknown; defaultColor?: unknown },
  ): CatalogOutcome<EventTeamProjection>;
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
  listAuditTrail(eventId: string): EventAdministrationAuditEntry[];
};

export type EventCatalogStorageTransaction = EventCatalogStorageSnapshot & {
  hasAttachedEventAdminGrant(eventId: string): boolean;
  insertEvent(event: StoredEvent): void;
  updateEvent(event: StoredEvent): void;
  deleteEvent(eventId: string): void;
  insertGameDay(gameDay: StoredGameDay): void;
  updateGameDay(gameDay: StoredGameDay): void;
  deleteGameDay(gameDayId: string): void;
  insertEventTeam(team: StoredEventTeam): void;
  updateEventTeam(team: StoredEventTeam): void;
  insertRosterEntry(entry: StoredRosterEntry): void;
  updateRosterEntry(entry: StoredRosterEntry): void;
  insertPitch(pitch: StoredPitch): void;
  updatePitch(pitch: StoredPitch): void;
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
  removeGameDay(
    eventId: unknown,
    gameDayId: unknown,
    authority: TechnicalAdminAuthority,
  ): Promise<CatalogOutcome<{ gameDayId: string }>>;
  removeEvent(
    eventId: unknown,
    authority: TechnicalAdminAuthority,
  ): Promise<CatalogOutcome<{ eventId: string }>>;
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
          ),
        );
      });
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

    async removeGameDay(eventIdInput, gameDayIdInput, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      const actor = authorityActor(authority);
      const eventId = validateId(eventIdInput, "eventId");
      if (!eventId.ok) return invalid(eventId.error);
      const gameDayId = validateId(gameDayIdInput, "gameDayId");
      if (!gameDayId.ok) return invalid(gameDayId.error);
      const nowMs = validNow(clock);
      if (nowMs === null) return invalid("Event clock returned an invalid timestamp.");
      return commit(storage, (transaction) => {
        const event = transaction.findEvent(eventId.value);
        if (event === null) return notFound("Event was not found.");
        const gameDay = transaction
          .listGameDays(event.eventId)
          .find((day) => day.gameDayId === gameDayId.value);
        if (gameDay === undefined) {
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
        const audit = createAudit(
          ids,
          "game-day-removed",
          event.eventId,
          gameDay.gameDayId,
          actor,
          nowMs,
          gameDay,
          null,
        );
        transaction.deleteGameDay(gameDay.gameDayId);
        transaction.appendAudit(audit);
        return accepted({ gameDayId: gameDay.gameDayId });
      });
    },

    async removeEvent(eventIdInput, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      const actor = authorityActor(authority);
      const eventId = validateId(eventIdInput, "eventId");
      if (!eventId.ok) return invalid(eventId.error);
      const nowMs = validNow(clock);
      if (nowMs === null) return invalid("Event clock returned an invalid timestamp.");
      return commit(storage, (transaction) => {
        const event = transaction.findEvent(eventId.value);
        if (event === null) return notFound("Event was not found.");
        if (transaction.listGameDays(event.eventId).length > 0) {
          return inUse("Event still contains Game Days.");
        }
        if (
          transaction.listEventTeams(event.eventId).length > 0 ||
          transaction.listPitches(event.eventId).length > 0
        ) {
          return inUse("Event still contains Teams or Pitches.");
        }
        if (transaction.hasAttachedEventAdminGrant(event.eventId)) {
          return inUse("Event has an attached Event Admin Grant.");
        }
        const audit = createAudit(
          ids,
          "event-removed",
          event.eventId,
          null,
          actor,
          nowMs,
          event,
          null,
        );
        transaction.deleteEvent(event.eventId);
        transaction.appendAudit(audit);
        return accepted({ eventId: event.eventId });
      });
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
): EventAdministrationAuditEntry {
  return {
    auditId: ids.next("audit"),
    operationId: ids.next("operation"),
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
    auditTrail: [...structuredClone(auditTrail)].sort((left, right) =>
      left.occurredAtMs === right.occurredAtMs
        ? left.auditId.localeCompare(right.auditId)
        : left.occurredAtMs - right.occurredAtMs,
    ),
  };
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

function createMutationOperations(
  transaction: EventCatalogStorageTransaction,
  clock: EventCatalogClock,
  ids: EventCatalogIds,
  actorReference: string,
): EventCatalogMutationOperations {
  return {
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
    upsertEventTeamRoster: (eventId, eventTeamId, input) =>
      upsertRosterOperation(transaction, clock, ids, eventId, eventTeamId, input, actorReference),
    createPitch: (eventId, input) =>
      createPitchOperation(transaction, clock, ids, eventId, input, actorReference),
    updatePitch: (eventId, pitchId, input) =>
      updatePitchOperation(transaction, clock, ids, eventId, pitchId, input, actorReference),
  };
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
  transaction.appendAudit(audit);
  return accepted(pitch);
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
    listAuditTrail: (eventId) => transaction.listEventAuditTrail(eventId),
  };
}

function eventCatalogTransaction(
  transaction: FoundationStorageTransaction,
): EventCatalogStorageTransaction {
  return {
    ...eventCatalogSnapshot(transaction),
    hasAttachedEventAdminGrant: (eventId) =>
      transaction
        .listGrants()
        .some((grant) => grant.grantType === "event-admin" && grant.scope.eventId === eventId),
    insertEvent: (event) => transaction.insertEvent(event),
    updateEvent: (event) => transaction.updateEvent(event),
    deleteEvent: (eventId) => transaction.deleteEvent(eventId),
    insertGameDay: (gameDay) => transaction.insertGameDay(gameDay),
    updateGameDay: (gameDay) => transaction.updateGameDay(gameDay),
    deleteGameDay: (gameDayId) => transaction.deleteGameDay(gameDayId),
    insertEventTeam: (team) => transaction.insertEventTeam(team),
    updateEventTeam: (team) => transaction.updateEventTeam(team),
    insertRosterEntry: (entry) => transaction.insertRosterEntry(entry),
    updateRosterEntry: (entry) => transaction.updateRosterEntry(entry),
    insertPitch: (pitch) => transaction.insertPitch(pitch),
    updatePitch: (pitch) => transaction.updatePitch(pitch),
    appendAudit: (entry) => transaction.appendEventAudit(entry),
  };
}
