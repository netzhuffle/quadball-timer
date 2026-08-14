import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import type {
  ControlAction,
  ControlAuditEntry,
  EventGameRecordMetadata,
} from "@/lib/event-game-actions";
import type {
  GrantKeyRing,
  StoredGrant,
  StoredGrantAuditEntry,
  StoredGrantSession,
} from "@/lib/grant-types";
import type { GrantStateValidationContext } from "@/lib/grant-state-validation";

export type StoredEventGameRecordRoot = {
  root: EventGameRecordRoot;
  canonicalContent: string;
};

export type DurableEvidenceFormat = "current" | "legacy";

export const DURABLE_EVIDENCE_PROVENANCE = Symbol("durable-evidence-provenance");

export type StoredControlAction = {
  action: ControlAction;
  canonicalContent: string;
  contentFingerprint: string;
  /** Storage-owned provenance; unlike action JSON, this marker is not supplied by callers. */
  durableFormat?: DurableEvidenceFormat;
  [DURABLE_EVIDENCE_PROVENANCE]?: DurableEvidenceFormat;
};

export type StoredControlIdempotencyEntry = {
  actionId: string;
  recordId: string;
  operationId: string;
  contentFingerprint: string;
  acceptedAtMs: number;
};

export type StoredControlAuditEntry = ControlAuditEntry & {
  /** Storage-owned provenance; unlike audit JSON, this marker is not supplied by callers. */
  durableFormat?: DurableEvidenceFormat;
  [DURABLE_EVIDENCE_PROVENANCE]?: DurableEvidenceFormat;
};

export type StoredEventGameRecordMetadata = EventGameRecordMetadata;

export type StoredEventCatalogEvent = {
  eventId: string;
  name: string;
  timeZone: string;
  publicationStatus: "unpublished";
  createdAtMs: number;
  updatedAtMs: number;
};

export type StoredEventCatalogGameDay = {
  gameDayId: string;
  eventId: string;
  date: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type EventCatalogAuditEntry = {
  auditId: string;
  operationId: string;
  action:
    | "event-created"
    | "event-updated"
    | "event-removed"
    | "game-day-added"
    | "game-day-updated"
    | "game-day-removed";
  eventId: string;
  gameDayId: string | null;
  actorReference: string;
  occurredAtMs: number;
  before: unknown;
  after: unknown;
};

export type StoredAcceptanceBudget = {
  bucketId: string;
  bucketKind: "online-session" | "online-event" | "replay-session";
  subjectId: string;
  capacity: number;
  refillPerSecond: number;
  tokens: number;
  updatedAtMs: number;
  stateRevision: number;
};

export type StoredReplayReservation = {
  reservationId: string;
  recordId: string;
  eventGameId: string;
  originatingSessionId: string;
  replacementSessionId: string | null;
  actionCount: number;
  status: "reserved" | "committing" | "committed" | "partial" | "discarded" | "acknowledged";
  batchDigest: string | null;
  createdAtMs: number;
  committedAtMs: number | null;
  acknowledgedAtMs: number | null;
  stateRevision: number;
};

export type StoredReplayAttempt = {
  attemptId: string;
  reservationId: string;
  operationId: string;
  status: "pending" | "accepted" | "duplicate-accepted" | "rejected" | "retry-later";
  actionFingerprint: string | null;
  resultJson: string | null;
  controlAuditId: string | null;
  grantAuditId: string | null;
  createdAtMs: number;
  completedAtMs: number | null;
  stateRevision: number;
};

export type StoredReplayReceipt = {
  receiptId: string;
  reservationId: string;
  receiptDigest: string;
  receiptKeyVersion: string;
  status: "committed" | "acknowledged";
  actionCount: number;
  createdAtMs: number;
  acknowledgedAtMs: number | null;
  stateRevision: number;
};

export type FoundationStorageReadiness =
  | {
      ok: true;
      schemaVersion: string;
      storage: "memory" | "sqlite";
    }
  | {
      ok: false;
      status:
        | "closed"
        | "pending"
        | "missing"
        | "reordered"
        | "changed-checksum"
        | "incomplete"
        | "future"
        | "unsafe-settings"
        | "integrity-failure"
        | "not-writeable";
      detail: string;
      storage: "memory" | "sqlite";
    };

export type FoundationStorageSnapshot = {
  revision: number;
  findRootByRecordId(recordId: string): EventGameRecordRoot | null;
  findRootByEventGameId(eventGameId: string): EventGameRecordRoot | null;
  findRootByPitchSlotId(pitchSlotId: string): EventGameRecordRoot | null;
  findRootByGameSideId(gameSideId: string): EventGameRecordRoot | null;
  findActionByOperationId(recordId: string, operationId: string): StoredControlAction | null;
  listActions(recordId: string): StoredControlAction[];
  listIdempotencyEntries(recordId: string): StoredControlIdempotencyEntry[];
  readRecordMetadata(recordId: string): StoredEventGameRecordMetadata | null;
  listAuditEntries(recordId: string): StoredControlAuditEntry[];
  findGrantById(grantId: string): StoredGrant | null;
  listGrants(): StoredGrant[];
  findGrantByCredentialLookupDigest(lookupDigest: string): StoredGrant | null;
  findActiveSessionByGrantAndContext(
    grantId: string,
    browserContextDigest: string,
  ): StoredGrantSession | null;
  findSessionByBearerVerifier(
    bearerLookupVerifier: string,
    bearerLookupKeyVersion: string,
  ): StoredGrantSession | null;
  listGrantSessions(grantId: string): StoredGrantSession[];
  listGrantAudit(grantId: string): StoredGrantAuditEntry[];
  findAcceptanceBudget(bucketId: string): StoredAcceptanceBudget | null;
  findReplayReservation(reservationId: string): StoredReplayReservation | null;
  findReplayReservationByTuple(
    recordId: string,
    eventGameId: string,
    originatingSessionId: string,
    actionCount: number,
    batchDigest: string,
  ): StoredReplayReservation | null;
  findReplayReservationByOriginTuple(
    recordId: string,
    eventGameId: string,
    originatingSessionId: string,
    actionCount: number,
  ): StoredReplayReservation | null;
  listReplayAttempts(reservationId: string): StoredReplayAttempt[];
  findReplayReceiptByDigest(receiptDigest: string): StoredReplayReceipt | null;
  findReplayReceiptByReservationId(reservationId: string): StoredReplayReceipt | null;
  listAcceptanceIntegrityAnchors(
    subjectKind: import("@/lib/foundation-acceptance-integrity").AcceptanceIntegritySubject,
    subjectId: string,
  ): import("@/lib/foundation-acceptance-integrity").AcceptanceIntegrityAnchor[];
  findEvent(eventId: string): StoredEventCatalogEvent | null;
  listEvents(): StoredEventCatalogEvent[];
  listGameDays(eventId: string): StoredEventCatalogGameDay[];
  listEventAuditTrail(eventId: string): EventCatalogAuditEntry[];
};

export type FoundationStorageTransaction = FoundationStorageSnapshot & {
  insertRoot(root: StoredEventGameRecordRoot): void;
  insertAction(action: StoredControlAction): void;
  upsertRecordMetadata(metadata: StoredEventGameRecordMetadata): void;
  appendAuditEntry(entry: StoredControlAuditEntry): void;
  insertGrant(grant: StoredGrant): void;
  updateGrant(grant: StoredGrant): void;
  insertGrantSession(session: StoredGrantSession): void;
  updateGrantSession(session: StoredGrantSession): void;
  appendGrantAudit(entry: StoredGrantAuditEntry): void;
  upsertAcceptanceBudget(budget: StoredAcceptanceBudget): void;
  insertReplayReservation(reservation: StoredReplayReservation): void;
  updateReplayReservation(reservation: StoredReplayReservation): void;
  insertReplayAttempt(attempt: StoredReplayAttempt): void;
  updateReplayAttempt(attempt: StoredReplayAttempt): void;
  discardReplayAttempts(reservationId: string): void;
  discardReplayReservation(reservationId: string): void;
  insertReplayReceipt(receipt: StoredReplayReceipt): void;
  updateReplayReceipt(receipt: StoredReplayReceipt): void;
  insertAcceptanceIntegrityAnchor(
    anchor: import("@/lib/foundation-acceptance-integrity").AcceptanceIntegrityAnchor,
  ): void;
  insertEvent(event: StoredEventCatalogEvent): void;
  updateEvent(event: StoredEventCatalogEvent): void;
  deleteEvent(eventId: string): void;
  insertGameDay(gameDay: StoredEventCatalogGameDay): void;
  updateGameDay(gameDay: StoredEventCatalogGameDay): void;
  deleteGameDay(gameDayId: string): void;
  appendEventAudit(entry: EventCatalogAuditEntry): void;
};

export type FoundationStorageTransactionWork<T> = (transaction: FoundationStorageTransaction) => T;

export interface FoundationStorage {
  transaction<T>(work: FoundationStorageTransactionWork<T>): Promise<T>;
  readRoot(recordId: string): Promise<EventGameRecordRoot | null>;
  readActions(recordId: string): Promise<StoredControlAction[]>;
  readIdempotencyEntries(recordId: string): Promise<StoredControlIdempotencyEntry[]>;
  readRecordMetadata(recordId: string): Promise<StoredEventGameRecordMetadata | null>;
  readAuditEntries(recordId: string): Promise<StoredControlAuditEntry[]>;
  readiness(): Promise<FoundationStorageReadiness>;
  /** Configure the key material required to validate persisted Grant state. */
  setGrantKeyRing?(keyRing: GrantKeyRing): void;
  /** Configure the environment and key material required for deep Grant validation. */
  setGrantValidationContext?(context: GrantStateValidationContext): void;
  close(): void;
}

export type FoundationStorageConstraint =
  | "record-id"
  | "event-game-id"
  | "pitch-slot-id"
  | "game-side-id"
  | "operation-id"
  | "audit-id"
  | "grant-id"
  | "grant-version"
  | "grant-pitch-slot-id"
  | "grant-credential-digest"
  | "grant-session-id"
  | "grant-session-verifier"
  | "grant-session-context"
  | "grant-audit-id"
  | "acceptance-budget-id"
  | "replay-reservation-id"
  | "replay-attempt-id"
  | "replay-receipt-id"
  | "replay-receipt-digest"
  | "integrity-anchor-id"
  | "event-id"
  | "game-day-id"
  | "game-day-date"
  | "event-audit-id"
  | "event-operation-id";

export class FoundationStorageConstraintError extends Error {
  readonly constraint: FoundationStorageConstraint;

  constructor(constraint: FoundationStorageConstraint) {
    super(`Foundation storage rejected a duplicate ${constraint}.`);
    this.name = "FoundationStorageConstraintError";
    this.constraint = constraint;
  }
}

export class FoundationStorageNotReadyError extends Error {
  readonly readiness: FoundationStorageReadiness;

  constructor(readiness: FoundationStorageReadiness) {
    super("Foundation storage is not ready for authoritative writes.");
    this.name = "FoundationStorageNotReadyError";
    this.readiness = readiness;
  }
}

export class FoundationStorageClosedError extends Error {
  constructor() {
    super("Foundation storage is closed.");
    this.name = "FoundationStorageClosedError";
  }
}

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}
