import type {
  EventCatalogAuditEntry,
  FoundationStorage,
  FoundationStorageTransaction,
} from "@/lib/foundation-storage";
import type { EventAdministrationAuthority } from "@/lib/event-administration";
import type { TypedGrantAuthority } from "@/lib/grant-management";
import {
  EVENT_ADMIN_GRANT_TYPE,
  GRANT_TYPE,
  PITCH_MANAGER_GRANT_TYPE,
  type GrantAuditAction,
  type GrantScope,
  type StoredGrantAuditEntry,
} from "@/lib/grant-types";
import { isTechnicalAdminAuthority } from "@/lib/technical-admin-auth";
import { validateOpaqueIdentifier } from "@/lib/validation-policy";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_CURSOR_LENGTH = 2048;

export type AdministrativeAuditProjectionKind = "event-administration" | "grant";
export type AdministrativeAuditDirection = "ascending" | "descending";

export type AdministrativeAuditEntry = EventAdministrativeAuditProjection | GrantAuditProjection;

export type EventAdministrativeAuditProjection = {
  evidenceType: "event-administration";
  evidenceId: string;
  operationId: string;
  action: EventCatalogAuditEntry["action"];
  occurredAtMs: number;
  scope: { eventId: string; gameDayId: string | null };
  authority: { reference: string };
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  links: { eventGameId: string | null; grantId: string | null };
};

export type GrantAuditProjection = {
  evidenceType: "grant";
  evidenceId: string;
  action: GrantAuditAction;
  occurredAtMs: number;
  grantId: string;
  grantType: typeof EVENT_ADMIN_GRANT_TYPE | typeof PITCH_MANAGER_GRANT_TYPE | typeof GRANT_TYPE;
  grantVersion: string;
  scope: Record<string, string>;
  authority: { reference: string };
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason?: string;
  links: {
    eventGameId: string | null;
    previousEventGameId: string | null;
    controlAuditId: string | null;
    controlActionId: string | null;
    acceptanceId: string | null;
    replayEvidenceId: string | null;
  };
};

export type AdministrativeAuditPage = {
  entries: readonly AdministrativeAuditEntry[];
  direction: AdministrativeAuditDirection;
  hasMore: boolean;
  nextCursor: string | null;
};

export type AdministrativeAuditReadInput = {
  projection: AdministrativeAuditProjectionKind;
  eventId: unknown;
  authority: EventAdministrationAuthority;
  cursor?: unknown;
  limit?: unknown;
  direction?: unknown;
  action?: unknown;
  grantId?: unknown;
  eventGameId?: unknown;
  gameDayId?: unknown;
  pitchId?: unknown;
  pitchSlotId?: unknown;
};

export type AdministrativeAuditOutcome<T> =
  | { status: "accepted"; value: T }
  | { status: "rejected"; reason: "invalid-input" | "unauthorized"; detail: string }
  | { status: "unavailable"; detail: "Administrative evidence is unavailable." };

export type AdministrativeAuditProjection = {
  read(
    input: AdministrativeAuditReadInput,
  ): Promise<AdministrativeAuditOutcome<AdministrativeAuditPage>>;
};

type ParsedRead = {
  eventId: string;
  cursor: AuditCursor | null;
  limit: number;
  direction: AdministrativeAuditDirection;
  action: string | null;
  grantId: string | null;
  eventGameId: string | null;
  gameDayId: string | null;
  pitchId: string | null;
  pitchSlotId: string | null;
};

type SortKey = {
  occurredAtMs: number;
  evidenceType: AdministrativeAuditProjectionKind;
  evidenceId: string;
};

type AuditCursor = SortKey & {
  version: 1;
  direction: AdministrativeAuditDirection;
  projection: AdministrativeAuditProjectionKind;
  queryFingerprint: string;
};

export function createAdministrativeAuditProjection(options: {
  storage: FoundationStorage;
  grants: Pick<TypedGrantAuthority, "authorizeGrantInTransaction">;
}): AdministrativeAuditProjection {
  return {
    async read(input) {
      const parsed = parseRead(input);
      if (!parsed.ok) return parsed;
      try {
        return await options.storage.transaction((transaction) => {
          if (!authorize(transaction, parsed.value.eventId, input.authority, options.grants))
            return unauthorized();

          const entries =
            input.projection === "event-administration"
              ? readEventEntries(transaction, parsed.value)
              : readGrantEntries(transaction, parsed.value);
          return accepted(pageEntries(input.projection, entries, parsed.value));
        });
      } catch {
        return unavailable();
      }
    },
  };
}

function parseRead(
  input: AdministrativeAuditReadInput,
):
  | { ok: true; value: ParsedRead }
  | { ok: false; status: "rejected"; reason: "invalid-input"; detail: string } {
  if (input.projection !== "event-administration" && input.projection !== "grant")
    return invalid("Administrative evidence projection is invalid.");
  const eventId = validateOpaqueIdentifier(input.eventId, "eventId");
  if (!eventId.ok) return invalid("Event identifier is invalid.");
  const limit = parsePageSize(input.limit);
  if (limit === null) return invalid("Audit page size is invalid.");
  const direction =
    input.direction === undefined
      ? "descending"
      : input.direction === "ascending"
        ? "ascending"
        : input.direction === "descending"
          ? "descending"
          : null;
  if (direction === null) return invalid("Audit direction is invalid.");
  if (input.projection === "event-administration" && input.grantId !== undefined)
    return invalid("Audit filter is unsupported for this projection.");
  const fields = [
    ["action", input.action],
    ["grantId", input.grantId],
    ["eventGameId", input.eventGameId],
    ["gameDayId", input.gameDayId],
    ["pitchId", input.pitchId],
    ["pitchSlotId", input.pitchSlotId],
  ] as const;
  const values: Record<string, string | null> = {};
  for (const [name, value] of fields) {
    if (value === undefined) {
      values[name] = null;
      continue;
    }
    if (typeof value !== "string" || value.length === 0 || value.length > 128)
      return invalid("Audit filter is invalid.");
    values[name] = typeof value === "string" ? value : null;
  }
  const filters = {
    action: values.action ?? null,
    grantId: values.grantId ?? null,
    eventGameId: values.eventGameId ?? null,
    gameDayId: values.gameDayId ?? null,
    pitchId: values.pitchId ?? null,
    pitchSlotId: values.pitchSlotId ?? null,
  };
  const cursor = decodeCursor(
    input.cursor,
    input.projection,
    direction,
    queryFingerprint(eventId.value, input.projection, direction, filters),
  );
  if (!cursor.ok) return cursor;
  return {
    ok: true,
    value: {
      eventId: eventId.value,
      cursor: cursor.value,
      limit,
      direction,
      ...filters,
    },
  };
}

function parsePageSize(value: unknown): number | null {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 1 && value <= MAX_PAGE_SIZE ? value : null;
  if (typeof value !== "string" || !/^[0-9]{1,3}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_PAGE_SIZE ? parsed : null;
}

function decodeCursor(
  value: unknown,
  projection: AdministrativeAuditProjectionKind,
  direction: AdministrativeAuditDirection,
  expectedQueryFingerprint: string,
):
  | { ok: true; value: AuditCursor | null }
  | { ok: false; status: "rejected"; reason: "invalid-input"; detail: string } {
  if (value === undefined) return { ok: true, value: null };
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CURSOR_LENGTH)
    return invalid("Audit cursor is invalid.");
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!isRecord(decoded)) return invalid("Audit cursor is invalid.");
    if (
      decoded.version !== 1 ||
      decoded.projection !== projection ||
      decoded.direction !== direction ||
      decoded.queryFingerprint !== expectedQueryFingerprint ||
      !Number.isSafeInteger(decoded.occurredAtMs) ||
      (decoded.evidenceType !== "event-administration" && decoded.evidenceType !== "grant") ||
      typeof decoded.evidenceId !== "string" ||
      decoded.evidenceId.length === 0
    )
      return invalid("Audit cursor is invalid.");
    return { ok: true, value: decoded as unknown as AuditCursor };
  } catch {
    return invalid("Audit cursor is invalid.");
  }
}

function queryFingerprint(
  eventId: string,
  projection: AdministrativeAuditProjectionKind,
  direction: AdministrativeAuditDirection,
  filters: {
    action: string | null;
    grantId: string | null;
    eventGameId: string | null;
    gameDayId: string | null;
    pitchId: string | null;
    pitchSlotId: string | null;
  },
): string {
  return Buffer.from(JSON.stringify({ eventId, projection, direction, filters }), "utf8").toString(
    "base64url",
  );
}

function authorize(
  transaction: FoundationStorageTransaction,
  eventId: string,
  authority: EventAdministrationAuthority,
  grants: Pick<TypedGrantAuthority, "authorizeGrantInTransaction">,
): boolean {
  if (isTechnicalAdminAuthority(authority)) return true;
  if (
    !isRecord(authority) ||
    authority.kind !== "grant-session" ||
    typeof authority.sessionBearer !== "string" ||
    authority.sessionBearer.length === 0
  )
    return false;
  const result = grants.authorizeGrantInTransaction(transaction, {
    sessionBearer: authority.sessionBearer,
    readOnly: true,
  });
  return (
    result.status === "authorized" &&
    result.grantType === EVENT_ADMIN_GRANT_TYPE &&
    isRecord(result.scope) &&
    result.scope.eventId === eventId
  );
}

function readEventEntries(
  transaction: FoundationStorageTransaction,
  query: ParsedRead,
): EventAdministrativeAuditProjection[] {
  return transaction
    .listEventAuditTrail(query.eventId)
    .filter((entry) => query.action === null || entry.action === query.action)
    .filter((entry) => query.gameDayId === null || entry.gameDayId === query.gameDayId)
    .filter((entry) =>
      query.eventGameId === null
        ? true
        : containsValue(entry.before, query.eventGameId) ||
          containsValue(entry.after, query.eventGameId),
    )
    .filter((entry) =>
      query.pitchId === null
        ? true
        : containsValue(entry.before, query.pitchId) || containsValue(entry.after, query.pitchId),
    )
    .filter((entry) =>
      query.pitchSlotId === null
        ? true
        : containsValue(entry.before, query.pitchSlotId) ||
          containsValue(entry.after, query.pitchSlotId),
    )
    .map(projectEventEntry);
}

function readGrantEntries(
  transaction: FoundationStorageTransaction,
  query: ParsedRead,
): GrantAuditProjection[] {
  const grantIds = transaction
    .listGrants()
    .filter((grant) => grantBelongsToEvent(grant.scope, query.eventId))
    .filter((grant) => query.grantId === null || grant.grantId === query.grantId)
    .map((grant) => grant.grantId);
  return grantIds
    .flatMap((grantId) => transaction.listGrantAudit(grantId))
    .filter((entry) => query.action === null || entry.action === query.action)
    .filter((entry) => query.grantId === null || entry.grantId === query.grantId)
    .filter((entry) => query.eventGameId === null || entry.eventGameId === query.eventGameId)
    .filter((entry) => scopeMatches(entry.scope, query))
    .map(projectGrantEntry);
}

function projectEventEntry(entry: EventCatalogAuditEntry): EventAdministrativeAuditProjection {
  const before = redactCatalogSnapshot(entry.before);
  const after = redactCatalogSnapshot(entry.after);
  return {
    evidenceType: "event-administration",
    evidenceId: entry.auditId,
    operationId: entry.operationId,
    action: entry.action,
    occurredAtMs: entry.occurredAtMs,
    scope: { eventId: entry.eventId, gameDayId: entry.gameDayId },
    authority: { reference: entry.actorReference },
    before,
    after,
    links: {
      eventGameId: findString(after, "eventGameId") ?? findString(before, "eventGameId"),
      grantId: null,
    },
  };
}

function projectGrantEntry(entry: StoredGrantAuditEntry): GrantAuditProjection {
  const before = grantLifecycleSummary(
    entry.beforeStatus,
    entry.beforeExpiresAtMs,
    entry.codeStateBefore,
  );
  const after = grantLifecycleSummary(entry.afterStatus, entry.afterExpiresAtMs, entry.codeState);
  return {
    evidenceType: "grant",
    evidenceId: entry.auditId,
    action: entry.action,
    occurredAtMs: entry.createdAtMs,
    grantId: entry.grantId,
    grantType: entry.grantType,
    grantVersion: entry.grantVersion,
    scope: redactGrantScope(entry.scope),
    authority: { reference: entry.actorReference },
    before,
    after,
    ...(entry.terminalReason === null || entry.terminalReason === undefined
      ? {}
      : { reason: entry.terminalReason }),
    links: {
      eventGameId: entry.eventGameId,
      previousEventGameId: entry.previousEventGameId ?? null,
      controlAuditId: entry.controlAuditId ?? null,
      controlActionId: entry.controlActionId ?? null,
      acceptanceId: entry.acceptanceId ?? null,
      replayEvidenceId: entry.replayEvidenceId ?? null,
    },
  };
}

function pageEntries(
  projection: AdministrativeAuditProjectionKind,
  entries: readonly AdministrativeAuditEntry[],
  query: ParsedRead,
): AdministrativeAuditPage {
  const sorted = [...entries].sort((left, right) =>
    compareSortKey(sortKey(left), sortKey(right), query.direction),
  );
  const afterCursor =
    query.cursor === null
      ? sorted
      : sorted.filter((entry) =>
          isAfterCursor(sortKey(entry), query.cursor as AuditCursor, query.direction),
        );
  const page = afterCursor.slice(0, query.limit);
  const hasMore = afterCursor.length > query.limit;
  const last = page.at(-1);
  return {
    entries: page,
    direction: query.direction,
    hasMore,
    nextCursor:
      hasMore && last !== undefined
        ? encodeCursor({
            version: 1,
            projection,
            direction: query.direction,
            queryFingerprint: queryFingerprint(query.eventId, projection, query.direction, {
              action: query.action,
              grantId: query.grantId,
              eventGameId: query.eventGameId,
              gameDayId: query.gameDayId,
              pitchId: query.pitchId,
              pitchSlotId: query.pitchSlotId,
            }),
            ...sortKey(last),
          })
        : null,
  };
}

function sortKey(entry: AdministrativeAuditEntry): SortKey {
  return {
    occurredAtMs: entry.occurredAtMs,
    evidenceType: entry.evidenceType,
    evidenceId: entry.evidenceId,
  };
}

function compareSortKey(left: SortKey, right: SortKey, direction: AdministrativeAuditDirection) {
  const base =
    left.occurredAtMs - right.occurredAtMs ||
    left.evidenceType.localeCompare(right.evidenceType) ||
    left.evidenceId.localeCompare(right.evidenceId);
  return direction === "ascending" ? base : -base;
}

function isAfterCursor(
  value: SortKey,
  cursor: AuditCursor,
  direction: AdministrativeAuditDirection,
) {
  return compareSortKey(value, cursor, direction) > 0;
}

function encodeCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function redactCatalogSnapshot(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  if (!isRecord(value)) return {};
  const allowed = new Set([
    "eventId",
    "gameDayId",
    "eventTeamId",
    "rosterEntryId",
    "pitchId",
    "gameplaySlotId",
    "pitchSlotId",
    "eventGameId",
    "name",
    "timeZone",
    "publicationStatus",
    "date",
    "defaultColor",
    "playerNumber",
    "publicName",
    "sequence",
    "scheduledStartMs",
    "expectedDelayMs",
    "gameCode",
    "gameDesignation",
    "sideA",
    "sideB",
    "sideId",
    "eventTeamName",
    "sourceLabel",
    "confirmedAtMs",
    "scoreByGameSide",
    "winnerGameSideId",
    "flagCatchingGameSideId",
    "catchTimeMs",
    "endTimeMs",
    "lockRetained",
    "lockRemoved",
    "overrideApplied",
    "phase",
    "lockedAtMs",
    "lockReason",
  ]);
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    if (!(key in value)) continue;
    const current = value[key];
    if (key === "sideA" || key === "sideB") {
      result[key] = redactCatalogSnapshot(current);
    } else if (key === "scoreByGameSide" && isRecord(current)) {
      const scores = Object.entries(current);
      if (
        scores.every(
          ([sideId, score]) =>
            validateOpaqueIdentifier(sideId, "gameSideId").ok &&
            typeof score === "number" &&
            Number.isSafeInteger(score),
        )
      )
        result[key] = Object.fromEntries(scores);
    } else if (
      current === null ||
      typeof current === "string" ||
      typeof current === "number" ||
      typeof current === "boolean"
    ) {
      result[key] = current;
    }
  }
  return result;
}

function redactGrantScope(scope: GrantScope): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of [
    "eventId",
    "gameDayId",
    "gameDayDate",
    "eventTimeZone",
    "finalGameDayDate",
    "pitchId",
    "pitchSlotId",
  ]) {
    const value = scope[key as keyof GrantScope];
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

function grantLifecycleSummary(
  status: StoredGrantAuditEntry["beforeStatus"],
  expiresAtMs: number | null,
  codeState: StoredGrantAuditEntry["codeStateBefore"],
): Record<string, unknown> | null {
  if (status === null && expiresAtMs === null && codeState === undefined) return null;
  return {
    status,
    expiresAtMs,
    ...(codeState === undefined ? {} : { codeState }),
  };
}

function grantBelongsToEvent(scope: GrantScope, eventId: string): boolean {
  return "eventId" in scope && scope.eventId === eventId;
}

function scopeMatches(scope: GrantScope, query: ParsedRead): boolean {
  return (
    (query.gameDayId === null || ("gameDayId" in scope && scope.gameDayId === query.gameDayId)) &&
    (query.pitchId === null || ("pitchId" in scope && scope.pitchId === query.pitchId)) &&
    (query.pitchSlotId === null ||
      ("pitchSlotId" in scope && scope.pitchSlotId === query.pitchSlotId))
  );
}

function containsValue(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => containsValue(item, expected));
  if (!isRecord(value)) return false;
  return Object.values(value).some((item) => containsValue(item, expected));
}

function findString(value: Record<string, unknown> | null, key: string): string | null {
  const candidate = value?.[key];
  return typeof candidate === "string" ? candidate : null;
}

function accepted<T>(value: T): { status: "accepted"; value: T } {
  return { status: "accepted", value };
}

function invalid(detail: string): {
  ok: false;
  status: "rejected";
  reason: "invalid-input";
  detail: string;
};
function invalid(detail: string): {
  status: "rejected";
  reason: "invalid-input";
  detail: string;
};
function invalid(detail: string) {
  return { status: "rejected" as const, reason: "invalid-input" as const, detail };
}

function unauthorized(): AdministrativeAuditOutcome<never> {
  return {
    status: "rejected",
    reason: "unauthorized",
    detail: "Unable to read administrative evidence.",
  };
}

function unavailable(): AdministrativeAuditOutcome<never> {
  return { status: "unavailable", detail: "Administrative evidence is unavailable." };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
