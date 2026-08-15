import type { FoundationStorage, FoundationStorageTransaction } from "@/lib/foundation-storage";
import {
  createEventCatalog,
  createFoundationEventCatalogStorage,
  projectExpectedStartMs,
  projectEventProjection,
  type CatalogOutcome,
  type EventCatalog,
  type EventCatalogMutationOperations,
  type EventTeamProjection,
  type EventProjection,
  type EventPublicationStatusChange,
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
import {
  EVENT_ADMIN_GRANT_TYPE,
  PITCH_MANAGER_GRANT_TYPE,
  type PitchManagerGrantScope,
  type StoredGrant,
  validateControlGrantScope,
  validatePitchManagerGrantScope,
} from "@/lib/grant-types";
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

export type PitchManagerGrantProjection = {
  grantId: string;
  grantVersion: string;
  grantType: typeof PITCH_MANAGER_GRANT_TYPE;
  eventId: string;
  gameDayId: string;
  gameDayDate: string;
  pitchId: string;
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

export type PitchManagerViewProjection = {
  eventId: string;
  gameDayId: string;
  gameDayDate: string;
  eventTimeZone: string;
  pitch: { pitchId: string; name: string };
  schedule: readonly {
    pitchSlotId: string;
    gameplaySlotId: string;
    sequence: number;
    expectedStart: string;
    eventGame: {
      eventGameId: string;
      gameCode: string | null;
      gameDesignation: string | null;
      sideA: { displayName: string };
      sideB: { displayName: string };
    } | null;
    conflictEventGameIds: readonly string[];
    controlGrantStatus: StoredGrant["status"] | "not-created";
  }[];
  grantSessionId: string | null;
  grantSessionExpiresAt: string | null;
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
  createPitchManagerGrant(
    eventId: unknown,
    gameDayId: unknown,
    pitchId: unknown,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<PitchManagerGrantProjection>>;
  inspectPitchManagerGrant(
    eventId: unknown,
    gameDayId: unknown,
    pitchId: unknown,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationOutcome<PitchManagerGrantProjection | null>>;
  revealPitchManagerGrant(
    eventId: unknown,
    gameDayId: unknown,
    pitchId: unknown,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<TypedGrantReveal>>;
  rotatePitchManagerGrant(
    eventId: unknown,
    gameDayId: unknown,
    pitchId: unknown,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<TypedGrantMutation>>;
  disablePitchManagerGrant(
    eventId: unknown,
    gameDayId: unknown,
    pitchId: unknown,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<TypedGrantMutation>>;
  revokePitchManagerGrant(
    eventId: unknown,
    gameDayId: unknown,
    pitchId: unknown,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<TypedGrantMutation>>;
  reactivatePitchManagerGrant(
    eventId: unknown,
    gameDayId: unknown,
    pitchId: unknown,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<TypedGrantMutation>>;
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
  admitPitchManager(input: {
    qrCredential: unknown;
    browserContext: unknown;
    deviceClass?: unknown;
    browserClass?: unknown;
  }): Promise<TypedGrantAdmission | TypedGrantAdmissionThrottled>;
  leaveEventAdminSession(sessionBearer: unknown): Promise<TypedGrantMutation>;
  leavePitchManagerSession(sessionBearer: unknown): Promise<TypedGrantMutation>;
  openEventHub(input: {
    eventId: unknown;
    gameDayId?: unknown;
    authority: EventAdministrationAuthority;
  }): Promise<EventAdministrationOutcome<EventHubProjection>>;
  changePublicationStatus(
    eventId: unknown,
    input: { status: unknown; impactConfirmed?: unknown },
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<EventPublicationStatusChange>>;
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
  openPitchManagerView(input: {
    eventId: unknown;
    gameDayId: unknown;
    pitchId: unknown;
    authority: EventAdministrationAuthority;
  }): Promise<EventAdministrationOutcome<PitchManagerViewProjection>>;
  openPitchManagerCurrentView(input: {
    authority: EventAdministrationAuthority;
  }): Promise<EventAdministrationOutcome<PitchManagerViewProjection>>;
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

    async createPitchManagerGrant(eventIdInput, gameDayIdInput, pitchIdInput, authority) {
      const ids = validateScopeIds(eventIdInput, gameDayIdInput, pitchIdInput);
      if (!ids.ok) return invalid(ids.error);
      try {
        return await options.storage.transaction((transaction) => {
          const scope = readPitchManagerScope(transaction, ids.value);
          if (scope === null) return notFound("Pitch or Game Day was not found.");
          const authorized = authorizeEventScopeInTransaction(
            options,
            transaction,
            ids.value.eventId,
            authority,
          );
          if (authorized === null) return unauthorized();
          if (
            transaction
              .listGrants()
              .some(
                (grant) =>
                  grant.grantType === PITCH_MANAGER_GRANT_TYPE &&
                  samePitchManagerScope(grant.scope, scope),
              )
          )
            return invalid("A Pitch Manager Grant already exists for this Pitch and Game Day.");
          const result = options.grants.createPitchManagerGrantInTransaction(transaction, {
            authority,
            scope,
          });
          if (result.status !== "created") return grantMutationRejection(result);
          const stored = transaction.findGrantById(result.grantId);
          if (stored === null) return unavailable();
          return {
            ...accepted(projectPitchManagerGrant(stored)),
            sessionExpiresAtMs: authorized.sessionExpiresAtMs,
          };
        });
      } catch {
        return unavailable();
      }
    },

    async inspectPitchManagerGrant(eventIdInput, gameDayIdInput, pitchIdInput, authority) {
      const ids = validateScopeIds(eventIdInput, gameDayIdInput, pitchIdInput);
      if (!ids.ok) return invalid(ids.error);
      try {
        return await options.storage.transaction((transaction) => {
          if (
            authorizeEventScopeInTransaction(
              options,
              transaction,
              ids.value.eventId,
              authority,
              true,
            ) === null
          )
            return unauthorized();
          const grant = findPitchManagerGrantInTransaction(transaction, ids.value);
          return accepted(grant === null ? null : projectPitchManagerGrant(grant));
        });
      } catch {
        return unavailable();
      }
    },

    async revealPitchManagerGrant(eventIdInput, gameDayIdInput, pitchIdInput, authority) {
      const grant = await findPitchManagerGrant(
        options,
        eventIdInput,
        gameDayIdInput,
        pitchIdInput,
      );
      if (grant.status !== "accepted") return grant;
      if (grant.value === null) return notFound("Pitch Manager Grant was not found.");
      const authorization = await authorizePitchManagerManagement(options, grant.value, authority);
      if (authorization !== null) {
        const result = await options.grants.revealGrant(grant.value.grantId, authority);
        if (result.status === "revealed")
          return { ...accepted(result), sessionExpiresAtMs: authorization.sessionExpiresAtMs };
        return grantMutationRejection(result);
      }
      return unauthorized();
    },

    async rotatePitchManagerGrant(eventIdInput, gameDayIdInput, pitchIdInput, authority) {
      return managePitchManagerGrant(
        options,
        eventIdInput,
        gameDayIdInput,
        pitchIdInput,
        authority,
        "rotateGrant",
      );
    },
    async disablePitchManagerGrant(eventIdInput, gameDayIdInput, pitchIdInput, authority) {
      return managePitchManagerGrant(
        options,
        eventIdInput,
        gameDayIdInput,
        pitchIdInput,
        authority,
        "disableGrant",
      );
    },
    async revokePitchManagerGrant(eventIdInput, gameDayIdInput, pitchIdInput, authority) {
      return managePitchManagerGrant(
        options,
        eventIdInput,
        gameDayIdInput,
        pitchIdInput,
        authority,
        "revokeGrant",
      );
    },
    async reactivatePitchManagerGrant(eventIdInput, gameDayIdInput, pitchIdInput, authority) {
      return managePitchManagerGrant(
        options,
        eventIdInput,
        gameDayIdInput,
        pitchIdInput,
        authority,
        "reactivateGrant",
      );
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
      return options.grants.admitEventAdminGrant({
        qrCredential: input.qrCredential,
        browserContext: input.browserContext,
        deviceClass: typeof input.deviceClass === "string" ? input.deviceClass : undefined,
        browserClass: typeof input.browserClass === "string" ? input.browserClass : undefined,
      });
    },

    async admitPitchManager(input) {
      if (
        typeof input.qrCredential !== "string" ||
        typeof input.browserContext !== "string" ||
        input.qrCredential.length === 0 ||
        input.browserContext.length === 0
      )
        return options.grants.admitGrant({ qrCredential: "", browserContext: "" });
      return options.grants.admitPitchManagerGrant({
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

    async leavePitchManagerSession(sessionBearer) {
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

    async changePublicationStatus(eventId, input, authority) {
      return runCatalogMutation(catalog, options, eventId, authority, (operations) =>
        operations.changePublicationStatus(eventId, input),
      );
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

    async openPitchManagerView(input) {
      return openPitchManagerProjection(options, input);
    },

    async openPitchManagerCurrentView(input) {
      return openPitchManagerCurrentProjection(options, input.authority);
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

type ScopeIds = { eventId: string; gameDayId: string; pitchId: string };

function validateScopeIds(
  eventIdInput: unknown,
  gameDayIdInput: unknown,
  pitchIdInput: unknown,
): { ok: true; value: ScopeIds } | { ok: false; error: string } {
  const eventId = validateEventId(eventIdInput);
  const gameDayId = validateEventId(gameDayIdInput);
  const pitchId = validateEventId(pitchIdInput);
  if (!eventId.ok) return eventId;
  if (!gameDayId.ok) return gameDayId;
  if (!pitchId.ok) return pitchId;
  return {
    ok: true,
    value: { eventId: eventId.value, gameDayId: gameDayId.value, pitchId: pitchId.value },
  };
}

function readPitchManagerScope(
  transaction: FoundationStorageTransaction,
  ids: ScopeIds,
): PitchManagerGrantScope | null {
  const event = transaction.findEvent(ids.eventId);
  const gameDay = transaction
    .listGameDays(ids.eventId)
    .find((day) => day.gameDayId === ids.gameDayId);
  const pitch = transaction.findPitch(ids.pitchId);
  if (event === null || gameDay === undefined || pitch === null || pitch.eventId !== event.eventId)
    return null;
  return {
    eventId: event.eventId,
    gameDayId: gameDay.gameDayId,
    gameDayDate: gameDay.date,
    eventTimeZone: event.timeZone,
    pitchId: pitch.pitchId,
  };
}

function samePitchManagerScope(value: unknown, expected: PitchManagerGrantScope): boolean {
  if (!isRecord(value)) return false;
  return (
    value.eventId === expected.eventId &&
    value.gameDayId === expected.gameDayId &&
    value.pitchId === expected.pitchId
  );
}

function findPitchManagerGrantInTransaction(
  transaction: FoundationStorageTransaction,
  ids: ScopeIds,
): StoredGrant | null {
  const scope = readPitchManagerScope(transaction, ids);
  if (scope === null) return null;
  return (
    transaction
      .listGrants()
      .filter(
        (grant) =>
          grant.grantType === PITCH_MANAGER_GRANT_TYPE && samePitchManagerScope(grant.scope, scope),
      )
      .sort((left, right) => right.createdAtMs - left.createdAtMs)[0] ?? null
  );
}

function projectPitchManagerGrant(grant: StoredGrant): PitchManagerGrantProjection {
  const scope = validatePitchManagerGrantScope(grant.scope);
  if (!scope.ok) throw new Error("Pitch Manager Grant scope is invalid.");
  return {
    grantId: grant.grantId,
    grantVersion: grant.grantVersion,
    grantType: PITCH_MANAGER_GRANT_TYPE,
    eventId: scope.value.eventId,
    gameDayId: scope.value.gameDayId,
    gameDayDate: scope.value.gameDayDate,
    pitchId: scope.value.pitchId,
    status: grant.status,
    createdAtMs: grant.createdAtMs,
    expiresAtMs: grant.expiresAtMs,
  };
}

async function findPitchManagerGrant(
  options: EventAdministrationOptions,
  eventIdInput: unknown,
  gameDayIdInput: unknown,
  pitchIdInput: unknown,
): Promise<EventAdministrationOutcome<StoredGrant | null>> {
  const ids = validateScopeIds(eventIdInput, gameDayIdInput, pitchIdInput);
  if (!ids.ok) return invalid(ids.error);
  try {
    return accepted(
      await options.storage.transaction((transaction) =>
        findPitchManagerGrantInTransaction(transaction, ids.value),
      ),
    );
  } catch {
    return unavailable();
  }
}

async function authorizePitchManagerManagement(
  options: EventAdministrationOptions,
  grant: StoredGrant,
  authority: EventAdministrationAuthority,
): Promise<{ sessionExpiresAtMs: number | null } | null> {
  try {
    return await options.storage.transaction((transaction) => {
      const scope = validatePitchManagerGrantScope(grant.scope);
      if (!scope.ok) return null;
      const authorized = authorizeEventScopeInTransaction(
        options,
        transaction,
        scope.value.eventId,
        authority,
      );
      if (authorized === null) return null;
      if (transaction.findGrantById(grant.grantId)?.grantVersion !== grant.grantVersion)
        return null;
      return { sessionExpiresAtMs: authorized.sessionExpiresAtMs };
    });
  } catch {
    return null;
  }
}

async function managePitchManagerGrant(
  options: EventAdministrationOptions,
  eventIdInput: unknown,
  gameDayIdInput: unknown,
  pitchIdInput: unknown,
  authority: EventAdministrationAuthority,
  operation: "rotateGrant" | "disableGrant" | "revokeGrant" | "reactivateGrant",
): Promise<EventAdministrationMutationOutcome<TypedGrantMutation>> {
  const grant = await findPitchManagerGrant(options, eventIdInput, gameDayIdInput, pitchIdInput);
  if (grant.status !== "accepted") return grant;
  if (grant.value === null) return notFound("Pitch Manager Grant was not found.");
  const authorization = await authorizePitchManagerManagement(options, grant.value, authority);
  if (authorization === null) return unauthorized();
  const result = await options.grants[operation](grant.value.grantId, authority);
  return result.status === "updated"
    ? { ...accepted(result), sessionExpiresAtMs: authorization.sessionExpiresAtMs }
    : grantMutationRejection(result);
}

async function openPitchManagerProjection(
  options: EventAdministrationOptions,
  input: {
    eventId: unknown;
    gameDayId: unknown;
    pitchId: unknown;
    authority: EventAdministrationAuthority;
  },
): Promise<EventAdministrationOutcome<PitchManagerViewProjection>> {
  const ids = validateScopeIds(input.eventId, input.gameDayId, input.pitchId);
  if (!ids.ok) return unauthorized();
  try {
    return await options.storage.transaction((transaction) => {
      if (isTechnicalAdminAuthority(input.authority))
        return projectPitchManagerView(transaction, ids.value, null, null, null);
      if (
        !isRecord(input.authority) ||
        input.authority.kind !== "grant-session" ||
        typeof input.authority.sessionBearer !== "string"
      )
        return unauthorized();
      const result = options.grants.authorizeGrantInTransaction(transaction, {
        sessionBearer: input.authority.sessionBearer,
      });
      if (result.status !== "authorized" || result.grantType !== PITCH_MANAGER_GRANT_TYPE)
        return unauthorized();
      const scope = validatePitchManagerGrantScope(result.scope);
      if (
        !scope.ok ||
        scope.value.eventId !== ids.value.eventId ||
        scope.value.gameDayId !== ids.value.gameDayId ||
        scope.value.pitchId !== ids.value.pitchId
      )
        return unauthorized();
      return projectPitchManagerView(
        transaction,
        ids.value,
        result.grantSessionId,
        result.sessionExpiresAtMs ?? null,
        scope.value,
      );
    });
  } catch {
    return unavailable();
  }
}

async function openPitchManagerCurrentProjection(
  options: EventAdministrationOptions,
  authority: EventAdministrationAuthority,
): Promise<EventAdministrationOutcome<PitchManagerViewProjection>> {
  if (
    !isRecord(authority) ||
    authority.kind !== "grant-session" ||
    typeof authority.sessionBearer !== "string"
  )
    return unauthorized();
  try {
    return await options.storage.transaction((transaction) => {
      const result = options.grants.authorizeGrantInTransaction(transaction, {
        sessionBearer: authority.sessionBearer,
      });
      if (result.status !== "authorized" || result.grantType !== PITCH_MANAGER_GRANT_TYPE)
        return unauthorized();
      const scope = validatePitchManagerGrantScope(result.scope);
      if (!scope.ok) return unauthorized();
      return projectPitchManagerView(
        transaction,
        {
          eventId: scope.value.eventId,
          gameDayId: scope.value.gameDayId,
          pitchId: scope.value.pitchId,
        },
        result.grantSessionId,
        result.sessionExpiresAtMs ?? null,
        scope.value,
      );
    });
  } catch {
    return unavailable();
  }
}

function projectPitchManagerView(
  transaction: FoundationStorageTransaction,
  ids: ScopeIds,
  grantSessionId: string | null,
  grantSessionExpiresAtMs: number | null,
  grantScope: PitchManagerGrantScope | null,
): EventAdministrationOutcome<PitchManagerViewProjection> {
  const event = transaction.findEvent(ids.eventId);
  const day = transaction
    .listGameDays(ids.eventId)
    .find((candidate) => candidate.gameDayId === ids.gameDayId);
  const pitch = transaction.findPitch(ids.pitchId);
  if (event === null || day === undefined || pitch === null || pitch.eventId !== event.eventId)
    return unauthorized();
  if (
    grantScope !== null &&
    (grantScope.eventId !== event.eventId ||
      grantScope.gameDayId !== day.gameDayId ||
      grantScope.pitchId !== pitch.pitchId ||
      grantScope.gameDayDate !== day.date ||
      grantScope.eventTimeZone !== event.timeZone)
  )
    return unauthorized();
  const pitchSlots = transaction
    .listPitchSlots(day.gameDayId, pitch.pitchId)
    .sort((left, right) => left.sequence - right.sequence);
  const eventGames = transaction
    .listEventGames(day.gameDayId)
    .filter((game) => pitchSlots.some((slot) => slot.pitchSlotId === game.pitchSlotId));
  const gamesByPitchSlot = new Map<string, EventGame[]>();
  for (const game of eventGames) {
    const games = gamesByPitchSlot.get(game.pitchSlotId) ?? [];
    games.push(game);
    gamesByPitchSlot.set(game.pitchSlotId, games);
  }
  const controlGrantStatuses = new Map<string, StoredGrant["status"]>();
  for (const grant of transaction.listGrants()) {
    if (grant.grantType !== "control") continue;
    const scope = validateControlGrantScope(grant.scope);
    if (
      !scope.ok ||
      scope.value.eventId !== event.eventId ||
      scope.value.gameDayId !== day.gameDayId ||
      scope.value.pitchId !== pitch.pitchId ||
      !pitchSlots.some((slot) => slot.pitchSlotId === scope.value.pitchSlotId)
    )
      continue;
    controlGrantStatuses.set(scope.value.pitchSlotId, grant.status);
  }
  const schedule: PitchManagerViewProjection["schedule"] = pitchSlots.map((slot) => {
    const gameplaySlot = transaction.findGameplaySlot(slot.gameplaySlotId);
    if (gameplaySlot === null) throw new Error("Pitch Slot references a missing Gameplay Slot.");
    const games = gamesByPitchSlot.get(slot.pitchSlotId) ?? [];
    const game = games[0] ?? null;
    return {
      pitchSlotId: slot.pitchSlotId,
      gameplaySlotId: slot.gameplaySlotId,
      sequence: slot.sequence,
      expectedStart: formatPitchManagerDateTime(
        projectExpectedStartMs(gameplaySlot, slot),
        event.timeZone,
      ),
      eventGame:
        game === null
          ? null
          : {
              eventGameId: game.eventGameId,
              gameCode: game.gameCode,
              gameDesignation: game.gameDesignation,
              sideA: { displayName: game.sideA.eventTeamName ?? game.sideA.sourceLabel ?? "TBD" },
              sideB: { displayName: game.sideB.eventTeamName ?? game.sideB.sourceLabel ?? "TBD" },
            },
      conflictEventGameIds: games.map((candidate) => candidate.eventGameId),
      controlGrantStatus: controlGrantStatuses.get(slot.pitchSlotId) ?? "not-created",
    };
  });
  return accepted({
    eventId: event.eventId,
    gameDayId: day.gameDayId,
    gameDayDate: day.date,
    eventTimeZone: event.timeZone,
    pitch: { pitchId: pitch.pitchId, name: pitch.name },
    schedule,
    grantSessionId,
    grantSessionExpiresAt:
      grantSessionExpiresAtMs === null
        ? null
        : formatPitchManagerDateTime(grantSessionExpiresAtMs, event.timeZone),
  });
}

function formatPitchManagerDateTime(instantMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instantMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute} ${timeZone}`;
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
