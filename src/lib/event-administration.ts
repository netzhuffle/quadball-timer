import type { FoundationStorage, FoundationStorageTransaction } from "@/lib/foundation-storage";
import type { EventGameRecordTransactionSeam } from "@/lib/event-game-record";
import type { GamePresentation } from "@/lib/game-presentation";
import {
  createEventCatalog,
  createFoundationEventCatalogStorage,
  projectExpectedStartMs,
  projectEventProjection,
  type CatalogOutcome,
  type EventCatalog,
  type EventCatalogRemovalPreview,
  type EventCatalogRemovalResult,
  type EventCatalogRemovalTargetInput,
  type EventCatalogMutationOperations,
  type EventTeamProjection,
  type EventProjection,
  type EventPublicationStatusChange,
  type StoredPitch,
  type StoredRosterEntry,
  type GameplaySlot,
  type EventGame,
  type PitchSlot,
  type ProjectedEventGame,
  type ScheduleDelayPreview,
  type PitchReassignmentResult,
  type EventGameIdentityCorrection,
  type EventGameIdentityCorrectionInput,
  correctEventGameIdentityInTransaction,
  reconcileEventGameIdentityInTransaction,
  projectScheduleGames,
} from "@/lib/event-catalog";
import type { TechnicalAdminAuthority } from "@/lib/technical-admin-auth";
import type {
  TypedGrantAdmission,
  TypedGrantAdmissionThrottled,
  TypedGrantAuthority,
  TypedGrantCodeCreated,
  TypedGrantMutation,
  TypedGrantReveal,
  TypedGrantRotated,
  TypedSessionSummary,
} from "@/lib/grant-management";
import {
  EVENT_ADMIN_GRANT_TYPE,
  GRANT_TYPE,
  PITCH_MANAGER_GRANT_TYPE,
  type ControlGrantScope,
  type ControlGrantScopeResolver,
  type PitchManagerGrantScope,
  type StoredGrant,
  validateControlGrantScope,
  validateEventAdminGrantScope,
  validatePitchManagerGrantScope,
} from "@/lib/grant-types";
import { isTechnicalAdminAuthority } from "@/lib/technical-admin-auth";
import { canonicalizeJson, sha256 } from "@/lib/event-game-action-json";
import { validateOpaqueIdentifier } from "@/lib/validation-policy";
import {
  generateAccessSheetInTransaction,
  type AccessSheetArtifact,
  type AccessSheetRenderer,
  type AccessSheetRequest,
  type AccessSheetIds,
} from "@/lib/access-sheet";
import {
  createLockedEventGameAdministration,
  type GameReopeningInput,
  type GameReopeningResult,
  type GameReopeningPreviewInput,
  type LockedGamePreview,
  type LockedGameCorrectionInput,
  type LockedGameCorrectionResult,
} from "@/lib/locked-event-game-administration";
import type { EventOperationsHealth } from "@/lib/event-operations-health";

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

export type ControlGrantProjection = {
  grantId: string;
  grantVersion: string;
  grantType: typeof GRANT_TYPE;
  eventId: string;
  gameDayId: string;
  pitchId: string;
  pitchSlotId: string;
  status: StoredGrant["status"];
  createdAtMs: number;
  expiresAtMs: number | null;
  eligibility: "eligible" | "empty" | "conflict" | "mismatch" | "unavailable" | "terminal";
  eventGameId: string | null;
};

export type GrantCodeProjection = {
  grantId: string;
  grantVersion: string;
  state: "absent" | "present" | "disabled" | "erased";
  formatVersion: 1 | null;
};

export type EventHubProjection = {
  event: EventProjection;
  health: EventOperationsHealth;
  selectedGameDayId: string | null;
  authority: "technical-admin" | "event-admin";
  grantSessionId: string | null;
  grantSessionExpiresAtMs: number | null;
};

export type SlotSetupProjection = {
  gameDayId: string;
  gameplaySlots: readonly GameplaySlot[];
  pitchSlots: readonly PitchSlot[];
  eventGames: readonly ProjectedEventGame[];
  pitches: readonly { pitchId: string; name: string }[];
};

export type PitchViewProjection = {
  gameDayId: string;
  pitchId: string;
  pitch: { pitchId: string; name: string };
  gameplaySlots: readonly GameplaySlot[];
  pitchSlots: readonly PitchSlot[];
  eventGames: readonly ProjectedEventGame[];
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
  | {
      status: "rejected";
      reason: "invalid-input" | "unauthorized" | "not-found" | "in-use";
      detail: string;
    }
  | { status: "retryable-failure"; detail: string };

export type EventGamePresentationChangeInput = {
  operationId?: unknown;
  presentationChangeId?: unknown;
  causalPredecessorIds?: unknown;
  change: unknown;
};

export type EventAdministrationMutationOutcome<T> = EventAdministrationOutcome<T> & {
  sessionExpiresAtMs?: number | null;
};

export type EventAdministrationOptions = {
  storage: FoundationStorage;
  grants: TypedGrantAuthority;
  catalog?: EventCatalog;
  nowMs?: () => number;
  controlScopeResolver?: ControlGrantScopeResolver;
  /** Test-only composition seam for proving rollback after typed retirement. */
  removalFailureInjector?: () => void;
  /** Test-only composition seam for proving locked-game audit rollback. */
  lockedGameFailureInjector?: () => void;
  environmentId?: string;
  accessSheetRenderer?: AccessSheetRenderer;
  accessSheetIds?: AccessSheetIds;
  eventGameRecordTransaction?: (
    transaction: FoundationStorageTransaction,
  ) => EventGameRecordTransactionSeam;
};

class EventAdministrationTransactionRejection extends Error {
  constructor(
    readonly outcome:
      | {
          status: "rejected";
          reason: "invalid-input" | "unauthorized" | "not-found";
          detail: string;
        }
      | { status: "retryable-failure"; detail: string },
  ) {
    super(outcome.detail);
  }
}

export type EventAdministration = {
  previewEventCatalogRemoval(
    target: EventCatalogRemovalTargetInput,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationOutcome<EventCatalogRemovalPreview>>;
  removeEventCatalogEntry(
    target: EventCatalogRemovalTargetInput & { previewFingerprint?: unknown },
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<EventCatalogRemovalResult>>;
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
  ): Promise<EventAdministrationMutationOutcome<TypedGrantRotated | TypedGrantMutation>>;
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
  createControlGrant(
    eventId: unknown,
    gameDayId: unknown,
    pitchId: unknown,
    pitchSlotId: unknown,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<ControlGrantProjection>>;
  inspectControlGrant(
    eventId: unknown,
    gameDayId: unknown,
    pitchId: unknown,
    pitchSlotId: unknown,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationOutcome<ControlGrantProjection | null>>;
  revealControlGrant(
    eventId: unknown,
    gameDayId: unknown,
    pitchId: unknown,
    pitchSlotId: unknown,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<TypedGrantReveal>>;
  listControlGrantSessions(
    eventId: unknown,
    gameDayId: unknown,
    pitchId: unknown,
    pitchSlotId: unknown,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationOutcome<readonly TypedSessionSummary[]>>;
  revokeControlGrantSession(
    eventId: unknown,
    gameDayId: unknown,
    pitchId: unknown,
    pitchSlotId: unknown,
    sessionReference: unknown,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<TypedGrantMutation>>;
  rotateControlGrant(
    eventId: unknown,
    gameDayId: unknown,
    pitchId: unknown,
    pitchSlotId: unknown,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<TypedGrantRotated | TypedGrantMutation>>;
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
  ): Promise<EventAdministrationMutationOutcome<TypedGrantRotated | TypedGrantMutation>>;
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
  inspectEventAdminGrantCode(
    eventId: unknown,
    authority: TechnicalAdminAuthority,
  ): Promise<EventAdministrationOutcome<GrantCodeProjection | null>>;
  createEventAdminGrantCode(
    eventId: unknown,
    authority: TechnicalAdminAuthority,
  ): Promise<EventAdministrationMutationOutcome<TypedGrantCodeCreated>>;
  replaceEventAdminGrantCode(
    eventId: unknown,
    authority: TechnicalAdminAuthority,
  ): Promise<EventAdministrationMutationOutcome<TypedGrantCodeCreated>>;
  disableEventAdminGrantCode(
    eventId: unknown,
    authority: TechnicalAdminAuthority,
  ): Promise<EventAdministrationMutationOutcome<TypedGrantMutation>>;
  inspectPitchManagerGrantCode(
    eventId: unknown,
    gameDayId: unknown,
    pitchId: unknown,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationOutcome<GrantCodeProjection | null>>;
  createPitchManagerGrantCode(
    eventId: unknown,
    gameDayId: unknown,
    pitchId: unknown,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<TypedGrantCodeCreated>>;
  replacePitchManagerGrantCode(
    eventId: unknown,
    gameDayId: unknown,
    pitchId: unknown,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<TypedGrantCodeCreated>>;
  disablePitchManagerGrantCode(
    eventId: unknown,
    gameDayId: unknown,
    pitchId: unknown,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<TypedGrantMutation>>;
  inspectControlGrantCode(
    eventId: unknown,
    gameDayId: unknown,
    pitchId: unknown,
    pitchSlotId: unknown,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationOutcome<GrantCodeProjection | null>>;
  createControlGrantCode(
    eventId: unknown,
    gameDayId: unknown,
    pitchId: unknown,
    pitchSlotId: unknown,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<TypedGrantCodeCreated>>;
  replaceControlGrantCode(
    eventId: unknown,
    gameDayId: unknown,
    pitchId: unknown,
    pitchSlotId: unknown,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<TypedGrantCodeCreated>>;
  disableControlGrantCode(
    eventId: unknown,
    gameDayId: unknown,
    pitchId: unknown,
    pitchSlotId: unknown,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<TypedGrantMutation>>;
  admitEventAdmin(input: {
    qrCredential: unknown;
    browserContext: unknown;
    deviceClass?: unknown;
    browserClass?: unknown;
  }): Promise<TypedGrantAdmission | TypedGrantAdmissionThrottled>;
  admitEventAdminCode(input: {
    grantCode: unknown;
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
  admitPitchManagerCode(input: {
    grantCode: unknown;
    browserContext: unknown;
    deviceClass?: unknown;
    browserClass?: unknown;
  }): Promise<TypedGrantAdmission | TypedGrantAdmissionThrottled>;
  admitControlGrant(input: {
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
  generateAccessSheet(
    input: AccessSheetRequest,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<AccessSheetArtifact>>;
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
  setGameDayHeatStoppageConfiguration(
    eventId: unknown,
    gameDayId: unknown,
    input: { configuration: unknown },
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<import("@/lib/event-catalog").EventGameDay>>;
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
  setGameplaySlotExpectedDelay(
    eventId: unknown,
    gameDayId: unknown,
    gameplaySlotId: unknown,
    input: { expectedDelayMs: unknown; cascade?: unknown },
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<ScheduleDelayPreview>>;
  previewGameplaySlotExpectedDelay(
    eventId: unknown,
    gameDayId: unknown,
    gameplaySlotId: unknown,
    input: { expectedDelayMs: unknown; cascade?: unknown },
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationOutcome<ScheduleDelayPreview>>;
  setPitchSlotExpectedDelay(
    eventId: unknown,
    gameDayId: unknown,
    pitchSlotId: unknown,
    input: { expectedDelayMs: unknown; cascade?: unknown },
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<ScheduleDelayPreview>>;
  previewPitchSlotExpectedDelay(
    eventId: unknown,
    gameDayId: unknown,
    pitchSlotId: unknown,
    input: { expectedDelayMs: unknown; cascade?: unknown },
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationOutcome<ScheduleDelayPreview>>;
  reassignEventGame(
    eventId: unknown,
    gameDayId: unknown,
    eventGameId: unknown,
    input: { targetPitchSlotId: unknown; mode?: unknown },
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<PitchReassignmentResult>>;
  correctEventGameIdentity(
    eventId: unknown,
    gameDayId: unknown,
    eventGameId: unknown,
    input: EventGameIdentityCorrectionInput,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<EventGameIdentityCorrection>>;
  changeEventGamePresentation(
    eventId: unknown,
    eventGameId: unknown,
    input: EventGamePresentationChangeInput,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationMutationOutcome<GamePresentation>>;
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
  correctLockedEventGame(
    eventId: unknown,
    eventGameId: unknown,
    input: LockedGameCorrectionInput,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationOutcome<LockedGameCorrectionResult>>;
  previewLockedEventGameCorrection(
    eventId: unknown,
    eventGameId: unknown,
    input: LockedGameCorrectionInput,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationOutcome<LockedGamePreview>>;
  reopenEventGame(
    eventId: unknown,
    eventGameId: unknown,
    input: GameReopeningInput,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationOutcome<GameReopeningResult>>;
  previewEventGameReopening(
    eventId: unknown,
    eventGameId: unknown,
    input: GameReopeningPreviewInput,
    authority: EventAdministrationAuthority,
  ): Promise<EventAdministrationOutcome<LockedGamePreview>>;
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
  const lockedEventGames = createLockedEventGameAdministration({
    storage: options.storage,
    failureInjector: options.lockedGameFailureInjector,
    nowMs,
    authorize: (transaction, eventId, authority, readOnly) =>
      authorizeEventScopeInTransaction(options, transaction, eventId, authority, readOnly),
  });

  return {
    async previewEventCatalogRemoval(target, authority) {
      const eventId = validateEventId(target.eventId);
      if (!eventId.ok) return invalid(eventId.error);
      if (!removalAllowedForAuthority(target.kind, authority)) return unauthorized();
      try {
        return await options.storage.transaction((transaction) => {
          const authorized = authorizeEventScopeInTransaction(
            options,
            transaction,
            eventId.value,
            authority,
            true,
          );
          if (authorized === null) return unauthorized();
          const result = catalog.runMutationInTransaction(
            transaction,
            eventId.value,
            authorized.actorReference,
            (operations) => operations.previewEventCatalogRemoval(target),
          );
          if (result.status !== "accepted") return catalogOutcomeToAdministration(result);
          return accepted(addAuthorityImpact(transaction, result.value));
        });
      } catch {
        return unavailable();
      }
    },

    async removeEventCatalogEntry(target, authority) {
      const eventId = validateEventId(target.eventId);
      if (!eventId.ok) return invalid(eventId.error);
      if (!removalAllowedForAuthority(target.kind, authority)) return unauthorized();
      if (!isValidRemovalFingerprint(target.previewFingerprint))
        return invalid("Event Catalog removal preview is invalid.");
      try {
        return await options.storage.transaction((transaction) => {
          const authorized = authorizeEventScopeInTransaction(
            options,
            transaction,
            eventId.value,
            authority,
          );
          if (authorized === null) return rollbackRemovalMutation(unauthorized());
          const preview = catalog.runMutationInTransaction(
            transaction,
            eventId.value,
            authorized.actorReference,
            (operations) => operations.previewEventCatalogRemoval(target),
          );
          if (preview.status !== "accepted")
            return rollbackRemovalMutation(catalogOutcomeToAdministration(preview));
          const impacted = addAuthorityImpact(transaction, preview.value);
          if (target.previewFingerprint !== impacted.fingerprint)
            return rollbackRemovalMutation(invalid("Event Catalog removal preview is stale."));
          if (!impacted.eligible)
            return rollbackRemovalMutation({
              status: "rejected" as const,
              reason: "in-use" as const,
              detail: impacted.repairWorkflow ?? "Event Catalog removal is not eligible.",
            });
          const grants = grantsOwnedByRemovalTarget(transaction, impacted.target);
          for (const grant of grants) {
            const retired = options.grants.retireGrantInTransaction(transaction, {
              grantId: grant.grantId,
              actorReference: authorized.actorReference,
              reason: "event-catalog-removal",
            });
            if (retired.status !== "updated")
              return rollbackRemovalMutation(grantRetirementRejection(retired));
          }
          options.removalFailureInjector?.();
          const result = catalog.runMutationInTransaction(
            transaction,
            eventId.value,
            authorized.actorReference,
            (operations) =>
              operations.removeEventCatalogEntry(target, preview.value.fingerprint, grants.length),
          );
          if (result.status !== "accepted")
            return rollbackRemovalMutation(catalogOutcomeToAdministration(result));
          return { ...accepted(result.value), sessionExpiresAtMs: authorized.sessionExpiresAtMs };
        });
      } catch (error) {
        if (error instanceof EventAdministrationRollback)
          return error.outcome as EventAdministrationMutationOutcome<EventCatalogRemovalResult>;
        return unavailable();
      }
    },

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

    async inspectPitchManagerGrantCode(eventIdInput, gameDayIdInput, pitchIdInput, authority) {
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
          return accepted(grant === null ? null : projectGrantCode(grant));
        });
      } catch {
        return unavailable();
      }
    },

    async createPitchManagerGrantCode(eventIdInput, gameDayIdInput, pitchIdInput, authority) {
      return managePitchManagerGrantCode(
        options,
        eventIdInput,
        gameDayIdInput,
        pitchIdInput,
        authority,
        "createGrantCode",
      );
    },
    async replacePitchManagerGrantCode(eventIdInput, gameDayIdInput, pitchIdInput, authority) {
      return managePitchManagerGrantCode(
        options,
        eventIdInput,
        gameDayIdInput,
        pitchIdInput,
        authority,
        "replaceGrantCode",
      );
    },
    async disablePitchManagerGrantCode(eventIdInput, gameDayIdInput, pitchIdInput, authority) {
      return (await managePitchManagerGrantCode(
        options,
        eventIdInput,
        gameDayIdInput,
        pitchIdInput,
        authority,
        "disableGrantCode",
      )) as EventAdministrationMutationOutcome<TypedGrantMutation>;
    },

    async createControlGrant(
      eventIdInput,
      gameDayIdInput,
      pitchIdInput,
      pitchSlotIdInput,
      authority,
    ) {
      const ids = validateControlScopeIds(
        eventIdInput,
        gameDayIdInput,
        pitchIdInput,
        pitchSlotIdInput,
      );
      if (!ids.ok) return invalid(ids.error);
      try {
        return await options.storage.transaction((transaction) => {
          const scope = readControlGrantScope(transaction, ids.value);
          if (scope === null) return notFound("Pitch Slot was not found.");
          const authorized = authorizeControlManagementInTransaction(
            options,
            transaction,
            ids.value,
            authority,
          );
          if (authorized === null) return unauthorized();
          if (findControlGrantInTransaction(transaction, scope) !== null)
            return invalid("A Control Grant already exists for this Pitch Slot.");
          const result = options.grants.createControlGrantInTransaction(transaction, {
            authority,
            scope,
          });
          if (result.status !== "created") return grantMutationRejection(result);
          const stored = transaction.findGrantById(result.grantId);
          if (stored === null) return unavailable();
          return {
            ...accepted(projectControlGrant(stored, options, transaction)),
            sessionExpiresAtMs: authorized.sessionExpiresAtMs,
          };
        });
      } catch {
        return unavailable();
      }
    },

    async inspectControlGrant(
      eventIdInput,
      gameDayIdInput,
      pitchIdInput,
      pitchSlotIdInput,
      authority,
    ) {
      const ids = validateControlScopeIds(
        eventIdInput,
        gameDayIdInput,
        pitchIdInput,
        pitchSlotIdInput,
      );
      if (!ids.ok) return invalid(ids.error);
      try {
        return await options.storage.transaction((transaction) => {
          const scope = readControlGrantScope(transaction, ids.value);
          if (scope === null) return notFound("Pitch Slot was not found.");
          if (
            authorizeControlManagementInTransaction(
              options,
              transaction,
              ids.value,
              authority,
              true,
            ) === null
          )
            return unauthorized();
          const grant = findControlGrantInTransaction(transaction, scope);
          return accepted(grant === null ? null : projectControlGrant(grant, options, transaction));
        });
      } catch {
        return unavailable();
      }
    },

    async revealControlGrant(
      eventIdInput,
      gameDayIdInput,
      pitchIdInput,
      pitchSlotIdInput,
      authority,
    ) {
      const ids = validateControlScopeIds(
        eventIdInput,
        gameDayIdInput,
        pitchIdInput,
        pitchSlotIdInput,
      );
      if (!ids.ok) return invalid(ids.error);
      try {
        return await options.storage.transaction((transaction) => {
          const scope = readControlGrantScope(transaction, ids.value);
          if (scope === null) return notFound("Pitch Slot was not found.");
          const grant = findControlGrantInTransaction(transaction, scope);
          if (grant === null) return notFound("Control Grant was not found.");
          const authorization = authorizeControlManagementInTransaction(
            options,
            transaction,
            ids.value,
            authority,
            true,
          );
          if (authorization === null) return unauthorized();
          const result = options.grants.revealGrantInTransaction(
            transaction,
            grant.grantId,
            authority,
          );
          if (result.status !== "revealed") return grantRevealRejection(result);
          const refreshed = authorizeControlManagementInTransaction(
            options,
            transaction,
            ids.value,
            authority,
            true,
          );
          return {
            ...accepted(result),
            sessionExpiresAtMs: refreshed?.sessionExpiresAtMs ?? authorization.sessionExpiresAtMs,
          };
        });
      } catch {
        return unavailable();
      }
    },

    async listControlGrantSessions(
      eventIdInput,
      gameDayIdInput,
      pitchIdInput,
      pitchSlotIdInput,
      authority,
    ) {
      const ids = validateControlScopeIds(
        eventIdInput,
        gameDayIdInput,
        pitchIdInput,
        pitchSlotIdInput,
      );
      if (!ids.ok) return invalid(ids.error);
      try {
        return await options.storage.transaction((transaction) => {
          const scope = readControlGrantScope(transaction, ids.value);
          if (scope === null) return notFound("Pitch Slot was not found.");
          const grant = findControlGrantInTransaction(transaction, scope);
          if (grant === null) return notFound("Control Grant was not found.");
          if (
            authorizeControlManagementInTransaction(
              options,
              transaction,
              ids.value,
              authority,
              true,
            ) === null
          )
            return unauthorized();
          const result = options.grants.listGrantSessionsInTransaction(
            transaction,
            grant.grantId,
            authority,
          );
          return result.status === "ok" ? accepted(result.value) : unavailable();
        });
      } catch {
        return unavailable();
      }
    },

    async revokeControlGrantSession(
      eventIdInput,
      gameDayIdInput,
      pitchIdInput,
      pitchSlotIdInput,
      sessionReference,
      authority,
    ) {
      if (typeof sessionReference !== "string" || sessionReference.length === 0)
        return invalid("Grant Session reference is invalid.");
      const ids = validateControlScopeIds(
        eventIdInput,
        gameDayIdInput,
        pitchIdInput,
        pitchSlotIdInput,
      );
      if (!ids.ok) return invalid(ids.error);
      try {
        return await options.storage.transaction((transaction) => {
          const scope = readControlGrantScope(transaction, ids.value);
          if (scope === null) return notFound("Pitch Slot was not found.");
          const grant = findControlGrantInTransaction(transaction, scope);
          if (grant === null) return notFound("Control Grant was not found.");
          const authorization = authorizeControlManagementInTransaction(
            options,
            transaction,
            ids.value,
            authority,
            true,
          );
          if (authorization === null) return unauthorized();
          const result = options.grants.revokeGrantSessionInTransaction(
            transaction,
            grant.grantId,
            sessionReference,
            authority,
          );
          if (result.status !== "updated") return grantMutationRejection(result);
          const refreshed = authorizeControlManagementInTransaction(
            options,
            transaction,
            ids.value,
            authority,
            true,
          );
          return {
            ...accepted(result),
            sessionExpiresAtMs: refreshed?.sessionExpiresAtMs ?? authorization.sessionExpiresAtMs,
          };
        });
      } catch {
        return unavailable();
      }
    },

    async rotateControlGrant(
      eventIdInput,
      gameDayIdInput,
      pitchIdInput,
      pitchSlotIdInput,
      authority,
    ) {
      const ids = validateControlScopeIds(
        eventIdInput,
        gameDayIdInput,
        pitchIdInput,
        pitchSlotIdInput,
      );
      if (!ids.ok) return invalid(ids.error);
      try {
        return await options.storage.transaction((transaction) => {
          const scope = readControlGrantScope(transaction, ids.value);
          if (scope === null) return notFound("Pitch Slot was not found.");
          const grant = findControlGrantInTransaction(transaction, scope);
          if (grant === null) return notFound("Control Grant was not found.");
          const authorization = authorizeControlManagementInTransaction(
            options,
            transaction,
            ids.value,
            authority,
            true,
          );
          if (authorization === null) return unauthorized();
          const result = options.grants.rotateGrantInTransaction(
            transaction,
            grant.grantId,
            authority,
          );
          if (result.status !== "updated") return grantMutationRejection(result);
          const refreshed = authorizeControlManagementInTransaction(
            options,
            transaction,
            ids.value,
            authority,
            true,
          );
          return {
            ...accepted(result),
            sessionExpiresAtMs: refreshed?.sessionExpiresAtMs ?? authorization.sessionExpiresAtMs,
          };
        });
      } catch {
        return unavailable();
      }
    },

    async inspectControlGrantCode(
      eventIdInput,
      gameDayIdInput,
      pitchIdInput,
      pitchSlotIdInput,
      authority,
    ) {
      const ids = validateControlScopeIds(
        eventIdInput,
        gameDayIdInput,
        pitchIdInput,
        pitchSlotIdInput,
      );
      if (!ids.ok) return invalid(ids.error);
      try {
        return await options.storage.transaction((transaction) => {
          const scope = readControlGrantScope(transaction, ids.value);
          if (scope === null) return notFound("Pitch Slot was not found.");
          if (
            authorizeControlManagementInTransaction(
              options,
              transaction,
              ids.value,
              authority,
              true,
            ) === null
          )
            return unauthorized();
          const grant = findControlGrantInTransaction(transaction, scope);
          return accepted(grant === null ? null : projectGrantCode(grant));
        });
      } catch {
        return unavailable();
      }
    },

    async createControlGrantCode(
      eventIdInput,
      gameDayIdInput,
      pitchIdInput,
      pitchSlotIdInput,
      authority,
    ) {
      return manageControlGrantCode(
        options,
        eventIdInput,
        gameDayIdInput,
        pitchIdInput,
        pitchSlotIdInput,
        authority,
        "createGrantCode",
      );
    },
    async replaceControlGrantCode(
      eventIdInput,
      gameDayIdInput,
      pitchIdInput,
      pitchSlotIdInput,
      authority,
    ) {
      return manageControlGrantCode(
        options,
        eventIdInput,
        gameDayIdInput,
        pitchIdInput,
        pitchSlotIdInput,
        authority,
        "replaceGrantCode",
      );
    },
    async disableControlGrantCode(
      eventIdInput,
      gameDayIdInput,
      pitchIdInput,
      pitchSlotIdInput,
      authority,
    ) {
      return (await manageControlGrantCode(
        options,
        eventIdInput,
        gameDayIdInput,
        pitchIdInput,
        pitchSlotIdInput,
        authority,
        "disableGrantCode",
      )) as EventAdministrationOutcome<TypedGrantMutation>;
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

    async inspectEventAdminGrantCode(eventIdInput, authority) {
      if (!isTechnicalAdminAuthority(authority)) return unauthorized();
      const grant = await findEventAdminGrant(options, eventIdInput);
      if (grant.status !== "accepted") return grant;
      return accepted(grant.value === null ? null : projectGrantCode(grant.value));
    },

    async createEventAdminGrantCode(eventIdInput, authority) {
      return manageEventAdminGrantCode(options, eventIdInput, authority, "createGrantCode");
    },
    async replaceEventAdminGrantCode(eventIdInput, authority) {
      return manageEventAdminGrantCode(options, eventIdInput, authority, "replaceGrantCode");
    },
    async disableEventAdminGrantCode(eventIdInput, authority) {
      return (await manageEventAdminGrantCode(
        options,
        eventIdInput,
        authority,
        "disableGrantCode",
      )) as EventAdministrationOutcome<TypedGrantMutation>;
    },

    async admitEventAdmin(input) {
      if (
        typeof input.qrCredential !== "string" ||
        typeof input.browserContext !== "string" ||
        input.qrCredential.length === 0 ||
        input.browserContext.length === 0
      )
        return options.grants.admitEventAdminGrant({ qrCredential: "", browserContext: "" });
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
        return options.grants.admitPitchManagerGrant({ qrCredential: "", browserContext: "" });
      return options.grants.admitPitchManagerGrant({
        qrCredential: input.qrCredential,
        browserContext: input.browserContext,
        deviceClass: typeof input.deviceClass === "string" ? input.deviceClass : undefined,
        browserClass: typeof input.browserClass === "string" ? input.browserClass : undefined,
      });
    },

    async admitEventAdminCode(input) {
      if (
        typeof input.grantCode !== "string" ||
        typeof input.browserContext !== "string" ||
        input.grantCode.length === 0 ||
        input.browserContext.length === 0
      )
        return options.grants.admitEventAdminGrantCode({ grantCode: "", browserContext: "" });
      return options.grants.admitEventAdminGrantCode({
        grantCode: input.grantCode,
        browserContext: input.browserContext,
        deviceClass: typeof input.deviceClass === "string" ? input.deviceClass : undefined,
        browserClass: typeof input.browserClass === "string" ? input.browserClass : undefined,
      });
    },

    async admitPitchManagerCode(input) {
      if (
        typeof input.grantCode !== "string" ||
        typeof input.browserContext !== "string" ||
        input.grantCode.length === 0 ||
        input.browserContext.length === 0
      )
        return options.grants.admitPitchManagerGrantCode({ grantCode: "", browserContext: "" });
      return options.grants.admitPitchManagerGrantCode({
        grantCode: input.grantCode,
        browserContext: input.browserContext,
        deviceClass: typeof input.deviceClass === "string" ? input.deviceClass : undefined,
        browserClass: typeof input.browserClass === "string" ? input.browserClass : undefined,
      });
    },

    async admitControlGrant(input) {
      if (
        typeof input.qrCredential !== "string" ||
        typeof input.browserContext !== "string" ||
        input.qrCredential.length === 0 ||
        input.browserContext.length === 0
      )
        return options.grants.admitGrant({ qrCredential: "", browserContext: "" }, GRANT_TYPE);
      return options.grants.admitGrant(
        {
          qrCredential: input.qrCredential,
          browserContext: input.browserContext,
          deviceClass: typeof input.deviceClass === "string" ? input.deviceClass : undefined,
          browserClass: typeof input.browserClass === "string" ? input.browserClass : undefined,
        },
        GRANT_TYPE,
      );
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
            health: projectEventOperationsHealth(event, transaction, options),
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

    async generateAccessSheet(input, authority) {
      const eventId = validateEventId(input.scope.eventId);
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
          const result = generateAccessSheetInTransaction(
            transaction,
            input,
            authorized.actorReference,
            {
              environmentId: options.environmentId ?? "test",
              nowMs,
              grants: options.grants,
              authority,
              renderer: options.accessSheetRenderer,
              ids: options.accessSheetIds,
            },
          );
          if (result.status !== "accepted") return result;
          return { ...result, sessionExpiresAtMs: authorized.sessionExpiresAtMs };
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

    async setGameDayHeatStoppageConfiguration(eventId, gameDayId, input, authority) {
      return runCatalogMutation(catalog, options, eventId, authority, (operations) =>
        operations.setGameDayHeatStoppageConfiguration(eventId, gameDayId, input),
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

    async setGameplaySlotExpectedDelay(eventId, gameDayId, gameplaySlotId, input, authority) {
      return runCatalogMutation(catalog, options, eventId, authority, (operations) =>
        operations.setGameplaySlotExpectedDelay(eventId, gameDayId, gameplaySlotId, input),
      );
    },

    async previewGameplaySlotExpectedDelay(eventId, gameDayId, gameplaySlotId, input, authority) {
      return runCatalogPreview(catalog, options, eventId, authority, (operations) =>
        operations.previewGameplaySlotExpectedDelay(eventId, gameDayId, gameplaySlotId, input),
      );
    },

    async setPitchSlotExpectedDelay(eventId, gameDayId, pitchSlotId, input, authority) {
      return runCatalogMutation(catalog, options, eventId, authority, (operations) =>
        operations.setPitchSlotExpectedDelay(eventId, gameDayId, pitchSlotId, input),
      );
    },

    async previewPitchSlotExpectedDelay(eventId, gameDayId, pitchSlotId, input, authority) {
      return runCatalogPreview(catalog, options, eventId, authority, (operations) =>
        operations.previewPitchSlotExpectedDelay(eventId, gameDayId, pitchSlotId, input),
      );
    },

    async reassignEventGame(eventId, gameDayId, eventGameId, input, authority) {
      return runCatalogMutation(catalog, options, eventId, authority, (operations) =>
        operations.reassignEventGame(eventId, gameDayId, eventGameId, input),
      );
    },

    async correctEventGameIdentity(eventId, gameDayId, eventGameId, input, authority) {
      if (options.eventGameRecordTransaction === undefined) return unavailable();
      const eventIdResult = validateEventId(eventId);
      const gameDayIdResult = validateEventId(gameDayId);
      const eventGameIdResult = validateEventId(eventGameId);
      if (!eventIdResult.ok || !gameDayIdResult.ok || !eventGameIdResult.ok)
        return invalid("Event Game identity correction identifier is invalid.");
      try {
        return await options.storage.transaction((transaction) => {
          const authorized = authorizeEventScopeInTransaction(
            options,
            transaction,
            eventIdResult.value,
            authority,
          );
          if (authorized === null) return unauthorized();
          const event = transaction.findEvent(eventIdResult.value);
          const game = transaction.findEventGame(eventGameIdResult.value);
          const root = transaction.findRootByEventGameId(eventGameIdResult.value);
          if (event === null || game === null || root === null)
            return notFound("Event Game was not found.");
          if (root.eventId !== event.eventId || game.eventId !== event.eventId)
            return unauthorized();
          const catalogResult = correctEventGameIdentityInTransaction(
            transaction,
            { nowMs },
            { next: (kind) => `${kind}-${crypto.randomUUID()}` },
            eventIdResult.value,
            gameDayIdResult.value,
            eventGameIdResult.value,
            input,
            authorized.actorReference,
          );
          if (catalogResult.status !== "accepted") return mapCatalogOutcome(catalogResult);
          const record = options.eventGameRecordTransaction!(transaction);
          const correction = record.correctTeamAssignment({
            recordId: root.recordId,
            eventGameId: root.eventGameId,
            operationId: catalogResult.value.operationId,
            gameSideId: catalogResult.value.gameSideId,
            eventTeamId: catalogResult.value.eventTeamId,
            teamInterpretationRef: `event-team:${catalogResult.value.eventTeamId}`,
            eventTeamName: catalogResult.value.eventTeamName,
            trustedAtMs: nowMs(),
            grant: {
              sessionId: authorized.sessionId ?? authorized.actorReference,
              versionId: "event-admin",
            },
          });
          if (correction.status === "rejected")
            throw new EventAdministrationTransactionRejection({
              status: "rejected",
              reason: "invalid-input",
              detail: correction.detail,
            });
          const duplicate = correction.status === "duplicate-accepted";
          const effective = correction.effectiveTeamAssignments?.find(
            (assignment) => assignment.gameSideId === catalogResult.value.gameSideId,
          );
          if (effective === undefined)
            throw new EventAdministrationTransactionRejection({
              status: "retryable-failure",
              detail: "The Event Game Record did not return the corrected Game Side.",
            });
          const reconciled = reconcileEventGameIdentityInTransaction(
            transaction,
            { next: (kind) => `${kind}-${crypto.randomUUID()}` },
            eventIdResult.value,
            gameDayIdResult.value,
            eventGameIdResult.value,
            effective.gameSideId,
            effective.eventTeamId,
            authorized.actorReference,
          );
          if (reconciled.status !== "accepted")
            throw new EventAdministrationTransactionRejection(
              reconciled.status === "retryable-failure"
                ? reconciled
                : {
                    status: "rejected",
                    reason: reconciled.reason === "cross-event" ? "unauthorized" : "invalid-input",
                    detail: reconciled.detail,
                  },
            );
          const currentSide =
            reconciled.value.sideA.sideId === catalogResult.value.gameSideId
              ? reconciled.value.sideA
              : reconciled.value.sideB;
          return {
            ...accepted({
              ...catalogResult.value,
              ...(duplicate
                ? {}
                : {
                    eventTeamId: currentSide.eventTeamId ?? catalogResult.value.eventTeamId,
                    eventTeamName: currentSide.eventTeamName ?? catalogResult.value.eventTeamName,
                  }),
              commenced: root.lifecycle.commencedAtMs !== null,
              controllerAcknowledgementRequired: root.lifecycle.commencedAtMs !== null,
            }),
            sessionExpiresAtMs: authorized.sessionExpiresAtMs,
          };
        });
      } catch (error) {
        if (error instanceof EventAdministrationTransactionRejection) return error.outcome;
        return unavailable();
      }
    },

    async changeEventGamePresentation(eventIdInput, eventGameIdInput, input, authority) {
      if (options.eventGameRecordTransaction === undefined) return unavailable();
      const eventId = validateEventId(eventIdInput);
      const eventGameId = validateEventId(eventGameIdInput);
      if (!eventId.ok || !eventGameId.ok)
        return invalid("Event Game presentation identifier is invalid.");
      try {
        return await options.storage.transaction((transaction) => {
          const authorized = authorizeEventScopeInTransaction(
            options,
            transaction,
            eventId.value,
            authority,
          );
          if (authorized === null) return unauthorized();
          const event = transaction.findEvent(eventId.value);
          const game = transaction.findEventGame(eventGameId.value);
          const root = transaction.findRootByEventGameId(eventGameId.value);
          if (event === null || game === null || root === null)
            return notFound("Event Game was not found.");
          if (game.eventId !== event.eventId || root.eventId !== event.eventId)
            return unauthorized();
          const operationId = validateEventId(
            input.operationId ?? `event-admin-presentation-${crypto.randomUUID()}`,
          );
          const presentationChangeId = validateEventId(
            input.presentationChangeId ?? `presentation-${crypto.randomUUID()}`,
          );
          if (!operationId.ok || !presentationChangeId.ok)
            return invalid("Presentation identity is invalid.");
          const record = options.eventGameRecordTransaction!(transaction);
          const result = record.acceptPresentationChange({
            recordId: root.recordId,
            eventGameId: root.eventGameId,
            operationId: operationId.value,
            presentationChangeId: presentationChangeId.value,
            change: input.change,
            causalPredecessorIds: Array.isArray(input.causalPredecessorIds)
              ? input.causalPredecessorIds
              : [],
            occurrence: { trustedAtMs: nowMs(), clientOriginAtMs: null, source: "online" },
            grant: {
              sessionId: authorized.sessionId ?? authorized.actorReference,
              versionId: "event-admin",
            },
            acceptedAtMs: nowMs(),
          });
          if (result.status === "rejected")
            return result.reason === "storage-not-ready" ? unavailable() : invalid(result.detail);
          return {
            ...accepted(record.readPresentation(root.recordId)),
            sessionExpiresAtMs: authorized.sessionExpiresAtMs,
          };
        });
      } catch {
        return unavailable();
      }
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

    async correctLockedEventGame(eventId, eventGameId, input, authority) {
      return lockedEventGames.correctLockedEventGame(eventId, eventGameId, input, authority);
    },

    async previewLockedEventGameCorrection(eventId, eventGameId, input, authority) {
      return lockedEventGames.previewLockedEventGameCorrection(
        eventId,
        eventGameId,
        input,
        authority,
      );
    },

    async reopenEventGame(eventId, eventGameId, input, authority) {
      return lockedEventGames.reopenEventGame(eventId, eventGameId, input, authority);
    },

    async previewEventGameReopening(eventId, eventGameId, input, authority) {
      return lockedEventGames.previewEventGameReopening(eventId, eventGameId, input, authority);
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
  grantVersion: string | null;
  actorReference: string;
} | null {
  if (isTechnicalAdminAuthority(authority))
    return {
      kind: "technical-admin",
      sessionId: null,
      sessionExpiresAtMs: null,
      grantVersion: null,
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
    grantVersion: result.grantVersion,
    actorReference: `event-admin:${result.grantSessionId}`,
  };
}

function removalAllowedForAuthority(
  kind: unknown,
  authority: EventAdministrationAuthority,
): boolean {
  const isEventRemoval = kind === "event";
  return isTechnicalAdminAuthority(authority) ? isEventRemoval : !isEventRemoval;
}

function addAuthorityImpact(
  transaction: FoundationStorageTransaction,
  preview: EventCatalogRemovalPreview,
): EventCatalogRemovalPreview {
  const authorityImpact = readRemovalAuthorityImpact(transaction, preview.target);
  const malformed = authorityImpact.state !== "available";
  return {
    ...preview,
    eligible: preview.eligible && !malformed,
    rejectionCategory: malformed ? null : preview.rejectionCategory,
    repairWorkflow: malformed ? "Event Catalog removal is unavailable." : preview.repairWorkflow,
    impact: {
      ...preview.impact,
      retiredAuthorityCount: authorityImpact.grants.length,
      retiredAuthorityCategories: authorityImpact.categories,
    },
    fingerprint: removalFingerprint(preview, authorityImpact),
  };
}

type RemovalAuthorityDescriptor = {
  grantId: string;
  grantType: string;
  grantVersion: string;
  status: string;
  expiresAtMs: number | null;
  scopeState: "valid" | "malformed";
  scope: unknown;
  credentialMaterialState: string;
  credentialFingerprint: string;
  codeState: string | null;
  codeFingerprint: string | null;
  sessions: Array<{
    sessionId: string;
    grantVersion: string;
    status: string;
    bearerMaterialState: string;
    revokedAtMs: number | null;
  }>;
};

type RemovalAuthorityImpact = {
  state: "available" | "malformed" | "unavailable";
  descriptors: RemovalAuthorityDescriptor[];
  grants: StoredGrant[];
  categories: {
    eventAdmin: number;
    pitchManager: number;
    control: number;
  };
};

function readRemovalAuthorityImpact(
  transaction: FoundationStorageTransaction,
  target: EventCatalogRemovalPreview["target"],
): RemovalAuthorityImpact {
  const descriptors: RemovalAuthorityDescriptor[] = [];
  const grants: StoredGrant[] = [];
  try {
    let malformed = false;
    for (const grant of transaction.listGrants()) {
      const ownership = classifyRemovalGrant(grant, target);
      if (ownership === null) continue;
      const scopeState = ownership === "malformed" ? "malformed" : "valid";
      if (scopeState === "malformed") malformed = true;
      else if (!hasReadableRemovalCredentialMaterial(grant)) malformed = true;
      else grants.push(grant);
      descriptors.push(removalGrantDescriptor(transaction, grant, scopeState));
    }
    descriptors.sort((left, right) => left.grantId.localeCompare(right.grantId));
    const retiringGrants = grants.filter((grant) => grant.status !== "expired");
    return {
      state: malformed ? "malformed" : "available",
      descriptors,
      grants: retiringGrants,
      categories: {
        eventAdmin: retiringGrants.filter((grant) => grant.grantType === EVENT_ADMIN_GRANT_TYPE)
          .length,
        pitchManager: retiringGrants.filter((grant) => grant.grantType === PITCH_MANAGER_GRANT_TYPE)
          .length,
        control: retiringGrants.filter((grant) => grant.grantType === GRANT_TYPE).length,
      },
    };
  } catch {
    return {
      state: "unavailable",
      descriptors: [],
      grants: [],
      categories: { eventAdmin: 0, pitchManager: 0, control: 0 },
    };
  }
}

function hasReadableRemovalCredentialMaterial(grant: StoredGrant): boolean {
  if (
    typeof grant.credential?.fingerprint !== "string" ||
    grant.credential.fingerprint.length === 0
  )
    return false;
  if (grant.code === undefined || grant.code === null) return true;
  return typeof grant.code.fingerprint === "string" && grant.code.fingerprint.length > 0;
}

function rawScopeMatchesRemovalTarget(
  grant: StoredGrant,
  target: EventCatalogRemovalPreview["target"],
): boolean {
  if (target.kind === "event") return true;
  const rawScope = grant.scope as Record<string, unknown>;
  if (target.kind === "game-day") return rawScope.gameDayId === target.targetId;
  if (target.kind === "pitch") return rawScope.pitchId === target.targetId;
  if (target.kind === "pitch-slot") return rawScope.pitchSlotId === target.targetId;
  return false;
}

function classifyRemovalGrant(
  grant: StoredGrant,
  target: EventCatalogRemovalPreview["target"],
): "valid" | "malformed" | null {
  if (!isRecord(grant.scope)) return null;
  const rawScope = grant.scope;
  if (rawScope.eventId !== target.eventId || !rawScopeMatchesRemovalTarget(grant, target))
    return null;
  const scope =
    target.kind === "event" && grant.grantType === EVENT_ADMIN_GRANT_TYPE
      ? validateEventAdminGrantScope(grant.scope)
      : grant.grantType === PITCH_MANAGER_GRANT_TYPE
        ? validatePitchManagerGrantScope(grant.scope)
        : grant.grantType === GRANT_TYPE
          ? validateControlGrantScope(grant.scope)
          : null;
  if (scope !== null && scope.ok && scope.value.eventId === target.eventId) {
    const scopeValue = scope.value as {
      eventId: string;
      gameDayId?: string;
      pitchId?: string;
      pitchSlotId?: string;
    };
    if (target.kind === "event") return "valid";
    if (target.kind === "game-day" && scopeValue.gameDayId === target.targetId) return "valid";
    if (target.kind === "pitch" && scopeValue.pitchId === target.targetId) return "valid";
    if (target.kind === "pitch-slot" && scopeValue.pitchSlotId === target.targetId) return "valid";
  }
  return "malformed";
}

function removalGrantDescriptor(
  transaction: FoundationStorageTransaction,
  grant: StoredGrant,
  scopeState: "valid" | "malformed",
): RemovalAuthorityDescriptor {
  const sessions = transaction
    .listGrantSessions(grant.grantId)
    .map((session) => ({
      sessionId: session.sessionId,
      grantVersion: session.grantVersion,
      status: session.status,
      bearerMaterialState: session.bearerMaterialState,
      revokedAtMs: session.revokedAtMs,
    }))
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  return {
    grantId: grant.grantId,
    grantType: grant.grantType,
    grantVersion: grant.grantVersion,
    status: grant.status,
    expiresAtMs: grant.expiresAtMs,
    scopeState,
    scope: scopeState === "valid" ? grant.scope : null,
    credentialMaterialState: grant.credential.materialState,
    credentialFingerprint: grant.credential.fingerprint,
    codeState: grant.code?.state ?? null,
    codeFingerprint: grant.code?.fingerprint ?? null,
    sessions,
  };
}

function removalFingerprint(
  preview: EventCatalogRemovalPreview,
  authorityImpact: RemovalAuthorityImpact,
): string {
  return `event-catalog-removal-v1:${sha256(
    canonicalizeJson({
      catalogFingerprint: preview.fingerprint,
      authorityImpact: {
        state: authorityImpact.state,
        descriptors: authorityImpact.descriptors,
      },
    }),
  )}`;
}

function isValidRemovalFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^event-catalog-removal-v1:[0-9a-f]{64}$/u.test(value);
}

function grantsOwnedByRemovalTarget(
  transaction: FoundationStorageTransaction,
  target: EventCatalogRemovalPreview["target"],
): StoredGrant[] {
  return transaction.listGrants().filter((grant) => {
    if (grant.status === "expired") return false;
    const scope =
      target.kind === "event" && grant.grantType === EVENT_ADMIN_GRANT_TYPE
        ? validateEventAdminGrantScope(grant.scope)
        : grant.grantType === PITCH_MANAGER_GRANT_TYPE
          ? validatePitchManagerGrantScope(grant.scope)
          : grant.grantType === GRANT_TYPE
            ? validateControlGrantScope(grant.scope)
            : null;
    if (scope === null || !scope.ok || scope.value.eventId !== target.eventId) return false;
    const scopeValue = scope.value as {
      eventId: string;
      gameDayId?: string;
      pitchId?: string;
      pitchSlotId?: string;
    };
    if (target.kind === "event") return true;
    if (target.kind === "game-day")
      return (
        (grant.grantType === PITCH_MANAGER_GRANT_TYPE &&
          scopeValue.gameDayId === target.targetId) ||
        (grant.grantType === GRANT_TYPE && scopeValue.gameDayId === target.targetId)
      );
    if (target.kind === "pitch")
      return (
        (grant.grantType === PITCH_MANAGER_GRANT_TYPE && scopeValue.pitchId === target.targetId) ||
        (grant.grantType === GRANT_TYPE && scopeValue.pitchId === target.targetId)
      );
    if (target.kind === "pitch-slot")
      return grant.grantType === GRANT_TYPE && scopeValue.pitchSlotId === target.targetId;
    return false;
  });
}

function catalogOutcomeToAdministration<T>(
  result: CatalogOutcome<T>,
): EventAdministrationOutcome<T> {
  if (result.status === "accepted") return accepted(result.value);
  if (result.status === "retryable-failure") return unavailable();
  if (result.reason === "unauthorized") return unauthorized();
  if (result.reason === "not-found") return notFound(result.detail);
  if (result.reason === "in-use")
    return { status: "rejected", reason: "in-use", detail: result.detail };
  return invalid(result.detail);
}

function grantRetirementRejection(result: TypedGrantMutation): EventAdministrationOutcome<never> {
  if (result.status === "updated") return invalid("Grant retirement returned an invalid outcome.");
  if (result.reason === "unauthorized") return unauthorized();
  if (result.reason === "not-found") return notFound(result.detail ?? "Grant was not found.");
  if (result.reason === "unavailable") return unavailable();
  return invalid(result.detail ?? "Grant retirement was rejected.");
}

class EventAdministrationRollback extends Error {
  constructor(readonly outcome: EventAdministrationOutcome<never>) {
    super("Event Administration mutation rolled back.");
  }
}

function rollbackRemovalMutation<T>(outcome: EventAdministrationOutcome<T>): never {
  throw new EventAdministrationRollback(outcome as EventAdministrationOutcome<never>);
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
          eventGames: projectScheduleGames(transaction, games),
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
        eventGames: projectScheduleGames(transaction, games).filter(
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

type ControlScopeIds = ScopeIds & { pitchSlotId: string };

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

function validateControlScopeIds(
  eventIdInput: unknown,
  gameDayIdInput: unknown,
  pitchIdInput: unknown,
  pitchSlotIdInput: unknown,
): { ok: true; value: ControlScopeIds } | { ok: false; error: string } {
  const ids = validateScopeIds(eventIdInput, gameDayIdInput, pitchIdInput);
  const pitchSlotId = validateEventId(pitchSlotIdInput);
  if (!ids.ok) return ids;
  if (!pitchSlotId.ok) return pitchSlotId;
  return { ok: true, value: { ...ids.value, pitchSlotId: pitchSlotId.value } };
}

function readControlGrantScope(
  transaction: FoundationStorageTransaction,
  ids: ControlScopeIds,
): ControlGrantScope | null {
  const event = transaction.findEvent(ids.eventId);
  const gameDay = transaction
    .listGameDays(ids.eventId)
    .find((candidate) => candidate.gameDayId === ids.gameDayId);
  const pitch = transaction.findPitch(ids.pitchId);
  const pitchSlot = transaction.findPitchSlot(ids.pitchSlotId);
  if (
    event === null ||
    gameDay === undefined ||
    pitch === null ||
    pitchSlot === null ||
    pitch.eventId !== event.eventId ||
    pitchSlot.eventId !== event.eventId ||
    pitchSlot.gameDayId !== gameDay.gameDayId ||
    pitchSlot.pitchId !== pitch.pitchId
  )
    return null;
  return {
    eventId: event.eventId,
    gameDayId: gameDay.gameDayId,
    pitchId: pitch.pitchId,
    pitchSlotId: pitchSlot.pitchSlotId,
  };
}

function sameControlGrantScope(value: unknown, expected: ControlGrantScope): boolean {
  const scope = validateControlGrantScope(value);
  return (
    scope.ok &&
    scope.value.eventId === expected.eventId &&
    scope.value.gameDayId === expected.gameDayId &&
    scope.value.pitchId === expected.pitchId &&
    scope.value.pitchSlotId === expected.pitchSlotId
  );
}

function findControlGrantInTransaction(
  transaction: FoundationStorageTransaction,
  scope: ControlGrantScope,
): StoredGrant | null {
  return (
    transaction
      .listGrants()
      .filter(
        (grant) => grant.grantType === GRANT_TYPE && sameControlGrantScope(grant.scope, scope),
      )
      .sort((left, right) => right.createdAtMs - left.createdAtMs)[0] ?? null
  );
}

function authorizeControlManagementInTransaction(
  options: EventAdministrationOptions,
  transaction: FoundationStorageTransaction,
  ids: ControlScopeIds,
  authority: EventAdministrationAuthority,
  readOnly = false,
): { sessionExpiresAtMs: number | null } | null {
  const eventAuthority = authorizeEventScopeInTransaction(
    options,
    transaction,
    ids.eventId,
    authority,
    readOnly,
  );
  if (eventAuthority !== null) return { sessionExpiresAtMs: eventAuthority.sessionExpiresAtMs };
  if (
    !isRecord(authority) ||
    authority.kind !== "grant-session" ||
    typeof authority.sessionBearer !== "string"
  )
    return null;
  const result = options.grants.authorizeGrantInTransaction(transaction, {
    sessionBearer: authority.sessionBearer,
    readOnly,
  });
  if (result.status !== "authorized" || result.grantType !== PITCH_MANAGER_GRANT_TYPE) return null;
  const scope = validatePitchManagerGrantScope(result.scope);
  if (
    !scope.ok ||
    scope.value.eventId !== ids.eventId ||
    scope.value.gameDayId !== ids.gameDayId ||
    scope.value.pitchId !== ids.pitchId
  )
    return null;
  return { sessionExpiresAtMs: result.sessionExpiresAtMs ?? null };
}

function projectEventOperationsHealth(
  event: EventProjection,
  transaction: FoundationStorageTransaction,
  options: EventAdministrationOptions,
): EventOperationsHealth {
  let unresolvedTeamCount = 0;
  let scheduleConflictCount = 0;
  let teamScheduleConflictCount = 0;
  let grantProblemCount = 0;

  for (const game of event.eventGames) {
    if (game.sideA.eventTeamId === null || game.sideB.eventTeamId === null)
      unresolvedTeamCount += 1;
    if (game.scheduleConflict) scheduleConflictCount += 1;
    if (game.teamScheduleConflict) teamScheduleConflictCount += 1;

    const pitchSlot = transaction.findPitchSlot(game.pitchSlotId);
    const pitch = pitchSlot === null ? null : transaction.findPitch(pitchSlot.pitchId);
    const grant =
      pitchSlot === null || pitch === null
        ? null
        : findControlGrantInTransaction(transaction, {
            eventId: event.eventId,
            gameDayId: game.gameDayId,
            pitchId: pitch.pitchId,
            pitchSlotId: pitchSlot.pitchSlotId,
          });
    if (grant === null || !options.grants.isGrantCurrentlyUsableInTransaction(transaction, grant))
      grantProblemCount += 1;
  }

  return {
    unresolvedTeamCount,
    scheduleConflictCount,
    teamScheduleConflictCount,
    grantProblemCount,
  };
}

function projectControlGrant(
  grant: StoredGrant,
  options: EventAdministrationOptions,
  transaction: FoundationStorageTransaction,
): ControlGrantProjection {
  const scope = validateControlGrantScope(grant.scope);
  if (!scope.ok) throw new Error("Control Grant scope is invalid.");
  let eligibility: ControlGrantProjection["eligibility"] = "unavailable";
  let eventGameId: string | null = null;
  try {
    const current = options.controlScopeResolver?.resolve(scope.value, transaction);
    if (current?.status === "eligible") {
      eligibility = "eligible";
      eventGameId = current.eventGameId;
    } else if (current?.status === "terminal") {
      eligibility = "terminal";
      eventGameId = current.eventGameId ?? null;
    } else if (current !== undefined) {
      eligibility = current.status;
    }
  } catch {
    // The projection remains generic when the live resolver is unavailable.
  }
  return {
    grantId: grant.grantId,
    grantVersion: grant.grantVersion,
    grantType: GRANT_TYPE,
    eventId: scope.value.eventId,
    gameDayId: scope.value.gameDayId,
    pitchId: scope.value.pitchId,
    pitchSlotId: scope.value.pitchSlotId,
    status: grant.status,
    createdAtMs: grant.createdAtMs,
    expiresAtMs: grant.expiresAtMs,
    eligibility,
    eventGameId,
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
): Promise<EventAdministrationMutationOutcome<TypedGrantRotated | TypedGrantMutation>> {
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

async function runCatalogPreview<T>(
  catalog: EventCatalog,
  options: EventAdministrationOptions,
  eventIdInput: unknown,
  authority: EventAdministrationAuthority,
  operation: (operations: EventCatalogMutationOperations) => CatalogOutcome<T>,
): Promise<EventAdministrationOutcome<T>> {
  const eventId = validateEventId(eventIdInput);
  if (!eventId.ok) return invalid(eventId.error);
  try {
    return await options.storage.transaction((transaction) => {
      const authorized = authorizeEventScopeInTransaction(
        options,
        transaction,
        eventId.value,
        authority,
        true,
      );
      if (authorized === null) return unauthorized();
      const result = catalog.runMutationInTransaction(
        transaction,
        eventId.value,
        authorized.actorReference,
        operation,
      );
      if (result.status === "accepted") return accepted(result.value);
      if (result.status === "retryable-failure") return unavailable();
      if (result.reason === "unauthorized") return unauthorized();
      if (result.reason === "not-found") return notFound(result.detail);
      return invalid(result.detail);
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

function grantMutationRejection<T = never>(
  result: TypedGrantMutation,
): EventAdministrationOutcome<T> {
  if (result.status === "updated") return invalid("Grant creation returned an invalid outcome.");
  if (result.reason === "unauthorized") return unauthorized();
  if (result.reason === "not-found") return notFound(result.detail ?? "Grant was not found.");
  if (result.reason === "unavailable") return unavailable();
  return invalid(result.detail ?? "Grant operation was rejected.");
}

function grantRevealRejection(result: TypedGrantReveal): EventAdministrationOutcome<never> {
  if (result.status === "revealed") return invalid("Grant reveal returned an invalid outcome.");
  if (result.reason === "unauthorized") return unauthorized();
  if (result.reason === "not-found") return notFound(result.detail);
  return unavailable();
}

async function manageEventAdminGrant(
  options: EventAdministrationOptions,
  eventIdInput: unknown,
  authority: TechnicalAdminAuthority,
  operation: "rotateGrant" | "disableGrant" | "revokeGrant" | "reactivateGrant",
): Promise<EventAdministrationMutationOutcome<TypedGrantRotated | TypedGrantMutation>> {
  if (!isTechnicalAdminAuthority(authority)) return unauthorized();
  const grant = await findEventAdminGrant(options, eventIdInput);
  if (grant.status !== "accepted") return grant;
  if (grant.value === null) return notFound("Event Admin Grant was not found.");
  const result = await options.grants[operation](grant.value.grantId, authority);
  return result.status === "updated" ? accepted(result) : grantMutationRejection(result);
}

async function manageEventAdminGrantCode(
  options: EventAdministrationOptions,
  eventIdInput: unknown,
  authority: TechnicalAdminAuthority,
  operation: "createGrantCode" | "replaceGrantCode" | "disableGrantCode",
): Promise<EventAdministrationMutationOutcome<TypedGrantCodeCreated>> {
  if (!isTechnicalAdminAuthority(authority)) return mutationFailure(unauthorized());
  const grant = await findEventAdminGrant(options, eventIdInput);
  if (grant.status !== "accepted") return mutationFailure(grant);
  if (grant.value === null) return mutationFailure(notFound("Event Admin Grant was not found."));
  if (operation === "disableGrantCode")
    return (await disableGrantCodeMutation(
      options.grants,
      grant.value.grantId,
      authority,
      null,
    )) as EventAdministrationMutationOutcome<TypedGrantCodeCreated>;
  return createGrantCodeMutation(options.grants, grant.value.grantId, authority, operation);
}

async function managePitchManagerGrantCode(
  options: EventAdministrationOptions,
  eventIdInput: unknown,
  gameDayIdInput: unknown,
  pitchIdInput: unknown,
  authority: EventAdministrationAuthority,
  operation: "createGrantCode" | "replaceGrantCode" | "disableGrantCode",
): Promise<EventAdministrationMutationOutcome<TypedGrantCodeCreated>> {
  const grant = await findPitchManagerGrant(options, eventIdInput, gameDayIdInput, pitchIdInput);
  if (grant.status !== "accepted") return mutationFailure(grant);
  if (grant.value === null) return mutationFailure(notFound("Pitch Manager Grant was not found."));
  const authorization = await authorizePitchManagerManagement(options, grant.value, authority);
  if (authorization === null) return mutationFailure(unauthorized());
  if (operation === "disableGrantCode")
    return (await disableGrantCodeMutation(
      options.grants,
      grant.value.grantId,
      authority,
      authorization.sessionExpiresAtMs,
    )) as EventAdministrationMutationOutcome<TypedGrantCodeCreated>;
  return createGrantCodeMutation(
    options.grants,
    grant.value.grantId,
    authority,
    operation,
    authorization.sessionExpiresAtMs,
  );
}

async function manageControlGrantCode(
  options: EventAdministrationOptions,
  eventIdInput: unknown,
  gameDayIdInput: unknown,
  pitchIdInput: unknown,
  pitchSlotIdInput: unknown,
  authority: EventAdministrationAuthority,
  operation: "createGrantCode" | "replaceGrantCode" | "disableGrantCode",
): Promise<EventAdministrationMutationOutcome<TypedGrantCodeCreated>> {
  const ids = validateControlScopeIds(eventIdInput, gameDayIdInput, pitchIdInput, pitchSlotIdInput);
  if (!ids.ok) return mutationFailure(invalid(ids.error));
  const grant = await findControlGrant(options, ids.value);
  if (grant.status !== "accepted") return mutationFailure(grant);
  if (grant.value === null) return mutationFailure(notFound("Control Grant was not found."));
  const authorization = await authorizeControlGrantManagement(options, ids.value, authority);
  if (authorization === null) return mutationFailure(unauthorized());
  if (operation === "disableGrantCode")
    return (await disableGrantCodeMutation(
      options.grants,
      grant.value.grantId,
      authority,
      authorization.sessionExpiresAtMs,
    )) as EventAdministrationMutationOutcome<TypedGrantCodeCreated>;
  return createGrantCodeMutation(
    options.grants,
    grant.value.grantId,
    authority,
    operation,
    authorization.sessionExpiresAtMs,
  );
}

async function createGrantCodeMutation(
  grants: TypedGrantAuthority,
  grantId: string,
  authority: EventAdministrationAuthority,
  operation: "createGrantCode" | "replaceGrantCode",
  sessionExpiresAtMs: number | null = null,
): Promise<EventAdministrationMutationOutcome<TypedGrantCodeCreated>> {
  const result = await grants[operation](grantId, authority);
  if (result.status === "created" || result.status === "replaced")
    return { ...accepted(result), sessionExpiresAtMs };
  return grantMutationRejection<TypedGrantCodeCreated>(result as TypedGrantMutation);
}

function mutationFailure<T>(
  result: EventAdministrationOutcome<unknown>,
): EventAdministrationMutationOutcome<T> {
  if (result.status === "accepted")
    return {
      status: "retryable-failure",
      detail: "Event Administration is temporarily unavailable.",
    };
  return result;
}

async function disableGrantCodeMutation(
  grants: TypedGrantAuthority,
  grantId: string,
  authority: EventAdministrationAuthority,
  sessionExpiresAtMs: number | null,
): Promise<EventAdministrationMutationOutcome<TypedGrantMutation>> {
  const result = await grants.disableGrantCode(grantId, authority);
  return result.status === "updated"
    ? { ...accepted(result), sessionExpiresAtMs }
    : grantMutationRejection(result);
}

async function findControlGrant(
  options: EventAdministrationOptions,
  ids: ControlScopeIds,
): Promise<EventAdministrationOutcome<StoredGrant | null>> {
  try {
    return await options.storage.transaction((transaction) => {
      const scope = readControlGrantScope(transaction, ids);
      return accepted(scope === null ? null : findControlGrantInTransaction(transaction, scope));
    });
  } catch {
    return unavailable();
  }
}

async function authorizeControlGrantManagement(
  options: EventAdministrationOptions,
  ids: ControlScopeIds,
  authority: EventAdministrationAuthority,
): Promise<{ sessionExpiresAtMs: number | null } | null> {
  try {
    return await options.storage.transaction((transaction) =>
      authorizeControlManagementInTransaction(options, transaction, ids, authority),
    );
  } catch {
    return null;
  }
}

function projectGrantCode(grant: StoredGrant): GrantCodeProjection {
  return {
    grantId: grant.grantId,
    grantVersion: grant.grantVersion,
    state: grant.code?.state ?? "absent",
    formatVersion: grant.code?.formatVersion ?? null,
  };
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

function mapCatalogOutcome<T>(result: CatalogOutcome<T>): EventAdministrationOutcome<T> {
  if (result.status === "accepted") return result;
  if (result.status === "retryable-failure") return result;
  return {
    status: "rejected",
    reason: result.reason === "not-found" ? "not-found" : "invalid-input",
    detail: result.detail,
  };
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
