import type { FoundationStorage, FoundationStorageTransaction } from "@/lib/foundation-storage";
import {
  createEventCatalog,
  createFoundationEventCatalogStorage,
  projectEventProjection,
  type CatalogOutcome,
  type EventCatalog,
  type EventCatalogMutationOperations,
  type EventTeamProjection,
  type EventProjection,
  type StoredPitch,
  type StoredRosterEntry,
  type GameplaySlot,
  type EventGame,
  type PitchSlot,
} from "@/lib/event-catalog";
import type { TechnicalAdminAuthority } from "@/lib/technical-admin-auth";
import type {
  TypedGrantAdmission,
  TypedGrantAdmissionThrottled,
  TypedGrantAuthority,
  TypedGrantMutation,
  TypedGrantReveal,
} from "@/lib/grant-management";
import { EVENT_ADMIN_GRANT_TYPE, type StoredGrant } from "@/lib/grant-types";
import { isTechnicalAdminAuthority } from "@/lib/technical-admin-auth";
import { validateOpaqueIdentifier } from "@/lib/validation-policy";

export const GENERIC_EVENT_HUB_AUTHORIZATION_FAILURE = Object.freeze({
  status: "rejected",
  code: "event-hub-authorization-failed",
  message: "Unable to authorize the Event Hub.",
} as const);

export type EventAdministrationAuthority =
  | TechnicalAdminAuthority
  | { kind: "grant-session"; sessionBearer: string };

export type EventAdminGrantProjection = {
  grantId: string;
  grantVersion: string;
  grantType: typeof EVENT_ADMIN_GRANT_TYPE;
  eventId: string;
  status: StoredGrant["status"];
  createdAtMs: number;
  expiresAtMs: number | null;
};

export type EventHubProjection = {
  event: EventProjection;
  selectedGameDayId: string | null;
  authority: "technical-admin" | "event-admin";
  grantSessionId: string | null;
  grantSessionExpiresAtMs: number | null;
};

export type SlotSetupProjection = {
  gameDayId: string;
  gameplaySlots: readonly GameplaySlot[];
  pitchSlots: readonly PitchSlot[];
  eventGames: readonly EventGame[];
  pitches: readonly { pitchId: string; name: string }[];
};

export type PitchViewProjection = {
  gameDayId: string;
  pitchId: string;
  pitch: { pitchId: string; name: string };
  gameplaySlots: readonly GameplaySlot[];
  pitchSlots: readonly PitchSlot[];
  eventGames: readonly EventGame[];
};

export type EventAdministrationOutcome<T> =
  | { status: "accepted"; value: T }
  | { status: "rejected"; reason: "invalid-input" | "unauthorized" | "not-found"; detail: string }
  | { status: "retryable-failure"; detail: string };

export type EventAdministrationMutationOutcome<T> = EventAdministrationOutcome<T> & {
  sessionExpiresAtMs?: number | null;
};

export type EventAdministrationOptions = {
  storage: FoundationStorage;
  grants: TypedGrantAuthority;
  catalog?: EventCatalog;
  nowMs?: () => number;
};

export type EventAdministration = {
  createEventAdminGrant(
    eventId: unknown,
    authority: TechnicalAdminAuthority,
  ): Promise<EventAdministrationOutcome<EventAdminGrantProjection>>;
  inspectEventAdminGrant(
    eventId: unknown,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationOutcome<EventAdminGrantProjection | null>>;
  revealEventAdminGrant(
    eventId: unknown,
    authority: TechnicalAdminAuthority,
  ): Promise<EventAdministrationOutcome<TypedGrantReveal>>;
  rotateEventAdminGrant(
    eventId: unknown,
    authority: TechnicalAdminAuthority,
  ): Promise<EventAdministrationOutcome<TypedGrantMutation>>;
  disableEventAdminGrant(
    eventId: unknown,
    authority: TechnicalAdminAuthority,
  ): Promise<EventAdministrationOutcome<TypedGrantMutation>>;
  revokeEventAdminGrant(
    eventId: unknown,
    authority: TechnicalAdminAuthority,
  ): Promise<EventAdministrationOutcome<TypedGrantMutation>>;
  reactivateEventAdminGrant(
    eventId: unknown,
    authority: TechnicalAdminAuthority,
  ): Promise<EventAdministrationOutcome<TypedGrantMutation>>;
  admitEventAdmin(input: {
    qrCredential: unknown;
    browserContext: unknown;
    deviceClass?: unknown;
    browserClass?: unknown;
  }): Promise<TypedGrantAdmission | TypedGrantAdmissionThrottled>;
  leaveEventAdminSession(sessionBearer: unknown): Promise<TypedGrantMutation>;
  openEventHub(input: {
    eventId: unknown;
    gameDayId?: unknown;
    authority: EventAdministrationAuthority;
  }): Promise<EventAdministrationOutcome<EventHubProjection>>;
  createEventTeam(
    eventId: unknown,
    input: { name: unknown; defaultColor?: unknown },
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<EventTeamProjection>>;
  updateEventTeam(
    eventId: unknown,
    eventTeamId: unknown,
    input: { name?: unknown; defaultColor?: unknown },
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<EventTeamProjection>>;
  upsertEventTeamRoster(
    eventId: unknown,
    eventTeamId: unknown,
    input: { playerNumber: unknown; publicName: unknown },
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<StoredRosterEntry>>;
  createPitch(
    eventId: unknown,
    input: { name: unknown },
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<StoredPitch>>;
  updatePitch(
    eventId: unknown,
    pitchId: unknown,
    input: { name: unknown },
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<StoredPitch>>;
  createGameplaySlot(
    eventId: unknown,
    gameDayId: unknown,
    input: { sequence: unknown; scheduledStart?: unknown; scheduledStartMs?: unknown },
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<GameplaySlot>>;
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
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<EventGame>>;
  confirmGameplaySlotTeams(
    eventId: unknown,
    gameDayId: unknown,
    gameplaySlotId: unknown,
    input: { games: unknown },
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<readonly EventGame[]>>;
  openSlotSetup(
    eventId: unknown,
    gameDayId: unknown,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationOutcome<SlotSetupProjection>>;
  openPitchView(
    eventId: unknown,
    gameDayId: unknown,
    pitchId: unknown,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationOutcome<PitchViewProjection>>;
};

export function createEventAdministration(
  options: EventAdministrationOptions,
): EventAdministration {
  const nowMs = options.nowMs ?? (() => Date.now());
  const catalog =
    options.catalog ??
    createEventCatalog(createFoundationEventCatalogStorage(options.storage), {
      clock: { nowMs },
    });

  return {
    async createEventAdminGrant(eventIdInput, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      const eventId = validateEventId(eventIdInput);
      if (!eventId.ok) return invalid(eventId.error);
      try {
        return await options.storage.transaction((transaction) => {
          const event = transaction.findEvent(eventId.value);
          if (event === null) return notFound("Event was not found.");
          const finalGameDay = transaction
            .listGameDays(event.eventId)
            .sort((left, right) => left.date.localeCompare(right.date))
            .at(-1);
          if (finalGameDay === undefined) return invalid("The Event needs a Game Day first.");
          const result = options.grants.createEventAdminGrantInTransaction(transaction, {
            authority,
            scope: {
              eventId: event.eventId,
              eventTimeZone: event.timeZone,
              finalGameDayDate: finalGameDay.date,
            },
          });
          if (result.status !== "created") return grantMutationRejection(result);
          const stored = transaction.findGrantById(result.grantId);
          if (stored === null) return unavailable();
          return accepted(projectGrant(stored));
        });
      } catch {
        return unavailable();
      }
    },

    async inspectEventAdminGrant(eventIdInput, authority) {
      const eventId = validateEventId(eventIdInput);
      if (!eventId.ok) return invalid(eventId.error);
      try {
        return await options.storage.transaction((transaction) => {
          if (
            authorizeEventScopeInTransaction(
              options,
              transaction,
              eventId.value,
              authority,
              true,
            ) === null
          )
            return unauthorized();
          const grant =
            transaction
              .listGrants()
              .filter(
                (candidate) =>
                  candidate.grantType === EVENT_ADMIN_GRANT_TYPE &&
                  candidate.scope.eventId === eventId.value,
              )
              .sort((left, right) => right.createdAtMs - left.createdAtMs)[0] ?? null;
          return accepted(grant === null ? null : projectGrant(grant));
        });
      } catch {
        return unavailable();
      }
    },

    async revealEventAdminGrant(eventIdInput, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      const grant = await findEventAdminGrant(options, eventIdInput);
      if (grant.status !== "accepted") return grant;
      if (grant.value === null) return notFound("Event Admin Grant was not found.");
      const result = await options.grants.revealGrant(grant.value.grantId, authority);
      if (result.status === "revealed") return accepted(result);
      if (result.reason === "unauthorized") return unauthorized();
      if (result.reason === "not-found") return notFound(result.detail);
      return unavailable();
    },

    async rotateEventAdminGrant(eventIdInput, authority) {
      return manageEventAdminGrant(options, eventIdInput, authority, "rotateGrant");
    },
    async disableEventAdminGrant(eventIdInput, authority) {
      return manageEventAdminGrant(options, eventIdInput, authority, "disableGrant");
    },
    async revokeEventAdminGrant(eventIdInput, authority) {
      return manageEventAdminGrant(options, eventIdInput, authority, "revokeGrant");
    },
    async reactivateEventAdminGrant(eventIdInput, authority) {
      return manageEventAdminGrant(options, eventIdInput, authority, "reactivateGrant");
    },

    async admitEventAdmin(input) {
      if (
        typeof input.qrCredential !== "string" ||
        typeof input.browserContext !== "string" ||
        input.qrCredential.length === 0 ||
        input.browserContext.length === 0
      )
        return options.grants.admitGrant({ qrCredential: "", browserContext: "" });
      return options.grants.admitGrant({
        qrCredential: input.qrCredential,
        browserContext: input.browserContext,
        deviceClass: typeof input.deviceClass === "string" ? input.deviceClass : undefined,
        browserClass: typeof input.browserClass === "string" ? input.browserClass : undefined,
      });
    },

    async leaveEventAdminSession(sessionBearer) {
      if (typeof sessionBearer !== "string")
        return { status: "rejected", reason: "invalid-input", detail: "Grant Session is invalid." };
      return options.grants.leaveGrantSession(sessionBearer);
    },

    async openEventHub(input) {
      const eventId = validateEventId(input.eventId);
      if (!eventId.ok) return unauthorized();
      let gameDayId: string | null = null;
      if (input.gameDayId !== undefined) {
        const validatedGameDayId = validateEventId(input.gameDayId);
        if (!validatedGameDayId.ok) return unauthorized();
        gameDayId = validatedGameDayId.value;
      }
      try {
        return await options.storage.transaction((transaction) => {
          const authorized = authorizeEventScopeInTransaction(
            options,
            transaction,
            eventId.value,
            input.authority,
            true,
          );
          if (authorized === null) return unauthorized();
          const stored = transaction.findEvent(eventId.value);
          if (stored === null) return unauthorized();
          const event = projectEventProjection(
            stored,
            transaction.listGameDays(eventId.value),
            transaction.listEventAuditTrail(eventId.value),
            validNow(nowMs),
            transaction.listEventTeams(eventId.value),
            transaction
              .listEventTeams(eventId.value)
              .flatMap((team) => transaction.listRoster(team.eventTeamId)),
            transaction.listPitches(eventId.value),
            transaction
              .listGameDays(eventId.value)
              .flatMap((day) => transaction.listGameplaySlots(day.gameDayId)),
            transaction
              .listGameDays(eventId.value)
              .flatMap((day) => transaction.listPitchSlots(day.gameDayId)),
            transaction
              .listGameDays(eventId.value)
              .flatMap((day) => transaction.listEventGames(day.gameDayId)),
          );
          if (gameDayId !== null && !event.gameDays.some((day) => day.gameDayId === gameDayId))
            return unauthorized();
          return accepted({
            event,
            selectedGameDayId: gameDayId,
            authority: authorized.kind,
            grantSessionId: authorized.sessionId,
            grantSessionExpiresAtMs: authorized.sessionExpiresAtMs,
          });
        });
      } catch {
        return unavailable();
      }
    },

    async createEventTeam(eventId, input, authority) {
      return runCatalogMutation(catalog, options, eventId, authority, (operations) =>
        operations.createEventTeam(eventId, input),
      );
    },

    async updateEventTeam(eventId, eventTeamId, input, authority) {
      return runCatalogMutation(catalog, options, eventId, authority, (operations) =>
        operations.updateEventTeam(eventId, eventTeamId, input),
      );
    },

    async upsertEventTeamRoster(eventId, eventTeamId, input, authority) {
      return runCatalogMutation(catalog, options, eventId, authority, (operations) =>
        operations.upsertEventTeamRoster(eventId, eventTeamId, input),
      );
    },

    async createPitch(eventId, input, authority) {
      return runCatalogMutation(catalog, options, eventId, authority, (operations) =>
        operations.createPitch(eventId, input),
      );
    },

    async updatePitch(eventId, pitchId, input, authority) {
      return runCatalogMutation(catalog, options, eventId, authority, (operations) =>
        operations.updatePitch(eventId, pitchId, input),
      );
    },

    async createGameplaySlot(eventId, gameDayId, input, authority) {
      return runCatalogMutation(catalog, options, eventId, authority, (operations) =>
        operations.createGameplaySlot(eventId, gameDayId, input),
      );
    },

    async createEventGame(eventId, gameDayId, input, authority) {
      return runCatalogMutation(catalog, options, eventId, authority, (operations) =>
        operations.createEventGame(eventId, gameDayId, input),
      );
    },

    async confirmGameplaySlotTeams(eventId, gameDayId, gameplaySlotId, input, authority) {
      return runCatalogMutation(catalog, options, eventId, authority, (operations) =>
        operations.confirmGameplaySlotTeams(eventId, gameDayId, gameplaySlotId, input),
      );
    },

    async openSlotSetup(eventIdInput, gameDayIdInput, authority) {
      return openScheduleProjection<SlotSetupProjection>(
        options,
        eventIdInput,
        gameDayIdInput,
        authority,
        "slot",
      );
    },

    async openPitchView(eventIdInput, gameDayIdInput, pitchIdInput, authority) {
      return openScheduleProjection<PitchViewProjection>(
        options,
        eventIdInput,
        gameDayIdInput,
        authority,
        "pitch",
        pitchIdInput,
      );
    },
  };
}

function authorizeEventScopeInTransaction(
  options: EventAdministrationOptions,
  transaction: FoundationStorageTransaction,
  eventId: string,
  authority: EventAdministrationAuthority,
  readOnly = false,
): {
  kind: "technical-admin" | "event-admin";
  sessionId: string | null;
  sessionExpiresAtMs: number | null;
  actorReference: string;
} | null {
  if (isTechnicalAdminAuthority(authority))
    return {
      kind: "technical-admin",
      sessionId: null,
      sessionExpiresAtMs: null,
      actorReference: `technical-admin:${authority.environment}:${authority.sessionId}`,
    };
  if (
    !isRecord(authority) ||
    authority.kind !== "grant-session" ||
    typeof authority.sessionBearer !== "string" ||
    authority.sessionBearer.length === 0
  )
    return null;
  const result = options.grants.authorizeGrantInTransaction(transaction, {
    sessionBearer: authority.sessionBearer,
    readOnly,
  });
  if (
    result.status !== "authorized" ||
    result.grantType !== EVENT_ADMIN_GRANT_TYPE ||
    result.scope.eventId !== eventId
  )
    return null;
  return {
    kind: "event-admin",
    sessionId: result.grantSessionId,
    sessionExpiresAtMs: result.sessionExpiresAtMs ?? null,
    actorReference: `event-admin:${result.grantSessionId}`,
  };
}

async function openScheduleProjection<T extends SlotSetupProjection | PitchViewProjection>(
  options: EventAdministrationOptions,
  eventIdInput: unknown,
  gameDayIdInput: unknown,
  authority: EventAdministrationAuthority,
  mode: "slot" | "pitch",
  pitchIdInput?: unknown,
): Promise<EventAdministrationOutcome<T>> {
  const eventId = validateEventId(eventIdInput);
  const gameDayId = validateEventId(gameDayIdInput);
  if (!eventId.ok || !gameDayId.ok) return unauthorized();
  const pitchId = mode === "pitch" ? validateEventId(pitchIdInput) : null;
  if (pitchId !== null && !pitchId.ok) return unauthorized();
  try {
    return await options.storage.transaction((transaction) => {
      if (
        authorizeEventScopeInTransaction(options, transaction, eventId.value, authority, true) ===
        null
      )
        return unauthorized();
      const event = transaction.findEvent(eventId.value);
      const day = transaction
        .listGameDays(eventId.value)
        .find((candidate) => candidate.gameDayId === gameDayId.value);
      if (event === null || day === undefined) return notFound("Game Day was not found.");
      const games = transaction.listEventGames(day.gameDayId);
      if (mode === "slot")
        return accepted({
          gameDayId: day.gameDayId,
          gameplaySlots: transaction.listGameplaySlots(day.gameDayId),
          pitchSlots: transaction.listPitchSlots(day.gameDayId),
          eventGames: games,
          pitches: transaction
            .listPitches(event.eventId)
            .map(({ pitchId: id, name }) => ({ pitchId: id, name })),
        } as unknown as T);
      const pitch = transaction.findPitch(pitchId?.value ?? "");
      if (pitch === null || pitch.eventId !== event.eventId)
        return notFound("Pitch was not found.");
      return accepted({
        gameDayId: day.gameDayId,
        pitchId: pitch.pitchId,
        pitch: { pitchId: pitch.pitchId, name: pitch.name },
        gameplaySlots: transaction.listGameplaySlots(day.gameDayId),
        pitchSlots: transaction.listPitchSlots(day.gameDayId, pitch.pitchId),
        eventGames: games.filter(
          (game) => transaction.findPitchSlot(game.pitchSlotId)?.pitchId === pitch.pitchId,
        ),
      } as unknown as T);
    });
  } catch {
    return unavailable();
  }
}

async function runCatalogMutation<T>(
  catalog: EventCatalog,
  options: EventAdministrationOptions,
  eventIdInput: unknown,
  authority: EventAdministrationAuthority,
  operation: (operations: EventCatalogMutationOperations) => CatalogOutcome<T>,
): Promise<EventAdministrationMutationOutcome<T>> {
  const eventId = validateEventId(eventIdInput);
  if (!eventId.ok) return invalid(eventId.error);
  try {
    return await options.storage.transaction((transaction) => {
      const authorized = authorizeEventScopeInTransaction(
        options,
        transaction,
        eventId.value,
        authority,
      );
      if (authorized === null) return unauthorized();
      const result = catalog.runMutationInTransaction(
        transaction,
        eventId.value,
        authorized.actorReference,
        operation,
      );
      if (result.status === "accepted")
        return { ...accepted(result.value), sessionExpiresAtMs: authorized.sessionExpiresAtMs };
      if (result.status === "retryable-failure") return unavailable();
      if (result.reason === "unauthorized") return unauthorized();
      if (result.reason === "not-found") return notFound(result.detail);
      return invalid(result.detail);
    });
  } catch {
    return unavailable();
  }
}

async function findEventAdminGrant(
  options: EventAdministrationOptions,
  eventIdInput: unknown,
): Promise<EventAdministrationOutcome<StoredGrant | null>> {
  const eventId = validateEventId(eventIdInput);
  if (!eventId.ok) return invalid(eventId.error);
  try {
    return accepted(
      await options.storage.transaction(
        (transaction) =>
          transaction
            .listGrants()
            .filter(
              (candidate) =>
                candidate.grantType === EVENT_ADMIN_GRANT_TYPE &&
                candidate.scope.eventId === eventId.value,
            )
            .sort((left, right) => right.createdAtMs - left.createdAtMs)[0] ?? null,
      ),
    );
  } catch {
    return unavailable();
  }
}

function grantMutationRejection(result: TypedGrantMutation): EventAdministrationOutcome<never> {
  if (result.status === "updated") return invalid("Grant creation returned an invalid outcome.");
  if (result.reason === "unauthorized") return unauthorized();
  if (result.reason === "not-found") return notFound(result.detail ?? "Grant was not found.");
  if (result.reason === "unavailable") return unavailable();
  return invalid(result.detail ?? "Grant operation was rejected.");
}

async function manageEventAdminGrant(
  options: EventAdministrationOptions,
  eventIdInput: unknown,
  authority: TechnicalAdminAuthority,
  operation: "rotateGrant" | "disableGrant" | "revokeGrant" | "reactivateGrant",
): Promise<EventAdministrationOutcome<TypedGrantMutation>> {
  if (!isTechnicalAdminAuthority(authority)) return unauthorized();
  const grant = await findEventAdminGrant(options, eventIdInput);
  if (grant.status !== "accepted") return grant;
  if (grant.value === null) return notFound("Event Admin Grant was not found.");
  const result = await options.grants[operation](grant.value.grantId, authority);
  return result.status === "updated" ? accepted(result) : grantMutationRejection(result);
}

function projectGrant(grant: StoredGrant): EventAdminGrantProjection {
  return {
    grantId: grant.grantId,
    grantVersion: grant.grantVersion,
    grantType: EVENT_ADMIN_GRANT_TYPE,
    eventId: grant.scope.eventId,
    status: grant.status,
    createdAtMs: grant.createdAtMs,
    expiresAtMs: grant.expiresAtMs,
  };
}

function validateEventId(
  value: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  return validateOpaqueIdentifier(value, "eventId");
}

function validNow(read: () => number): number {
  const value = read();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Event clock is invalid.");
  return value;
}

function accepted<T>(value: T): EventAdministrationOutcome<T> {
  return { status: "accepted", value };
}

function invalid(detail: string): EventAdministrationOutcome<never> {
  return { status: "rejected", reason: "invalid-input", detail };
}

function unauthorized(): EventAdministrationOutcome<never> {
  return {
    status: "rejected",
    reason: "unauthorized",
    detail: "Unable to authorize Event Administration.",
  };
}

function notFound(detail: string): EventAdministrationOutcome<never> {
  return { status: "rejected", reason: "not-found", detail };
}

function unavailable(): EventAdministrationOutcome<never> {
  return {
    status: "retryable-failure",
    detail: "Event Administration is temporarily unavailable.",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
