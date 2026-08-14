import {
  normalizeBoundedText,
  SHARED_LIMITS,
  validateOpaqueIdentifier,
} from "@/lib/validation-policy";
import {
  isTechnicalAdminAuthority,
  type TechnicalAdminAuthority,
} from "@/lib/technical-admin-auth";
import type {
  EventCatalogAuditEntry,
  FoundationStorage,
  FoundationStorageSnapshot,
  FoundationStorageTransaction,
  StoredEventCatalogEvent,
  StoredEventCatalogGameDay,
} from "@/lib/foundation-storage";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";

export type EventPublicationStatus = "unpublished";
export type EventLifecycle = "unscheduled" | "future" | "current" | "past";
export type GameDayClassification = "future" | "current" | "past";

export type StoredEvent = StoredEventCatalogEvent;
export type StoredGameDay = StoredEventCatalogGameDay;
export type EventAdministrationAuditEntry = EventCatalogAuditEntry;

export type EventGameDay = StoredGameDay & {
  classification: GameDayClassification;
};

export type EventProjection = StoredEvent & {
  lifecycle: EventLifecycle;
  gameDays: readonly EventGameDay[];
  auditTrail: readonly EventAdministrationAuditEntry[];
};

/** Shared projection seam for composed Event Administration workflows. */
export function projectEventProjection(
  event: StoredEvent,
  gameDays: readonly StoredGameDay[],
  auditTrail: readonly EventAdministrationAuditEntry[],
  nowMs: number,
): EventProjection {
  return project(event, gameDays, auditTrail, nowMs);
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

export type EventCatalogStorageSnapshot = {
  findEvent(eventId: string): StoredEvent | null;
  listEvents(): StoredEvent[];
  listGameDays(eventId: string): StoredGameDay[];
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
  appendAudit(entry: EventAdministrationAuditEntry): void;
};

export interface EventCatalogStorage {
  transaction<T>(work: (transaction: EventCatalogStorageTransaction) => T): Promise<T>;
  snapshot(): Promise<EventCatalogStorageSnapshot>;
  close(): void;
}

export interface EventCatalogFoundationStorage {
  /** Thin catalog projection over the foundation's shared transaction boundary. */
  transaction<T>(work: (transaction: EventCatalogStorageTransaction) => T): Promise<T>;
  snapshot(): Promise<EventCatalogStorageSnapshot>;
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
          snapshot
            .listEvents()
            .map((event) =>
              project(
                event,
                snapshot.listGameDays(event.eventId),
                snapshot.listAuditTrail(event.eventId),
                nowMs,
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
  return {
    transaction<T>(work: (transaction: EventCatalogStorageTransaction) => T): Promise<T> {
      return storage.transaction((transaction) => work(eventCatalogTransaction(transaction)));
    },
    snapshot(): Promise<EventCatalogStorageSnapshot> {
      return storage.transaction((transaction) => eventCatalogSnapshot(transaction));
    },
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
  };
}

function eventCatalogSnapshot(transaction: FoundationStorageSnapshot): EventCatalogStorageSnapshot {
  return {
    findEvent: (eventId) => transaction.findEvent(eventId),
    listEvents: () => transaction.listEvents(),
    listGameDays: (eventId) => transaction.listGameDays(eventId),
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
    appendAudit: (entry) => transaction.appendEventAudit(entry),
  };
}
