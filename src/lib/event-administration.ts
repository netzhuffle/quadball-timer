import type { FoundationStorage, FoundationStorageTransaction } from "@/lib/foundation-storage";
import { projectEventProjection, type EventProjection } from "@/lib/event-catalog";
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

export type EventAdministrationOutcome<T> =
  | { status: "accepted"; value: T }
  | { status: "rejected"; reason: "invalid-input" | "unauthorized" | "not-found"; detail: string }
  | { status: "retryable-failure"; detail: string };

export type EventAdministrationOptions = {
  storage: FoundationStorage;
  grants: TypedGrantAuthority;
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
};

export function createEventAdministration(
  options: EventAdministrationOptions,
): EventAdministration {
  const nowMs = options.nowMs ?? (() => Date.now());

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
            authorizeEventScopeInTransaction(options, transaction, eventId.value, authority) ===
            null
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
          );
          if (authorized === null) return unauthorized();
          const stored = transaction.findEvent(eventId.value);
          if (stored === null) return unauthorized();
          const event = projectEventProjection(
            stored,
            transaction.listGameDays(eventId.value),
            transaction.listEventAuditTrail(eventId.value),
            validNow(nowMs),
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
  };
}

function authorizeEventScopeInTransaction(
  options: EventAdministrationOptions,
  transaction: FoundationStorageTransaction,
  eventId: string,
  authority: EventAdministrationAuthority,
): {
  kind: "technical-admin" | "event-admin";
  sessionId: string | null;
  sessionExpiresAtMs: number | null;
} | null {
  if (isTechnicalAdminAuthority(authority))
    return { kind: "technical-admin", sessionId: null, sessionExpiresAtMs: null };
  if (
    !isRecord(authority) ||
    authority.kind !== "grant-session" ||
    typeof authority.sessionBearer !== "string" ||
    authority.sessionBearer.length === 0
  )
    return null;
  const result = options.grants.authorizeGrantInTransaction(transaction, {
    sessionBearer: authority.sessionBearer,
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
  };
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
