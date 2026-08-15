import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import type {
  ControlAction,
  ControlAuditEntry,
  EventGameRecordMetadata,
  ControlActionCodecRegistry,
  IqaGameRulesInterpreter,
} from "@/lib/event-game-actions";
import type {
  GrantKeyRing,
  StoredGrant,
  GrantAdmissionGlobalWindow,
  GrantAdmissionMode,
  GrantAdmissionTelemetry,
  StoredGrantAuditEntry,
  StoredGrantSession,
} from "@/lib/grant-types";
import type { GrantStateValidationContext } from "@/lib/grant-state-validation";

export type StoredEventGameRecordRoot = {
  root: EventGameRecordRoot;
  canonicalContent: string;
};

export type DurableEvidenceFormat = "current" | "legacy";

export type GrantAdmissionStateAnchor = {
  anchorVersion: 1;
  stateDigest: string;
  integrityTag: string;
};

export const GRANT_STORAGE_CAPABILITY_NAME = "authenticated-grant-storage" as const;
export const GRANT_STORAGE_CAPABILITY_VERSION = 2 as const;
export const GRANT_STORAGE_CAPABILITY_IMPLEMENTATION = "hmac-anchored-atomic-v2" as const;
export type GrantStorageCapability = {
  name: typeof GRANT_STORAGE_CAPABILITY_NAME;
  version: typeof GRANT_STORAGE_CAPABILITY_VERSION;
  implementation: typeof GRANT_STORAGE_CAPABILITY_IMPLEMENTATION;
  transaction: readonly string[];
  maintenance: readonly string[];
  anchors: readonly string[];
};

export const REQUIRED_GRANT_STORAGE_TRANSACTION_METHODS = Object.freeze([
  "findGrantByCodeLookupDigest",
  "readGrantAdmissionTelemetry",
  "readGrantAdmissionGlobalWindow",
  "writeGrantAdmissionTelemetry",
  "writeGrantAdmissionGlobalWindow",
  "pruneGrantAdmissionTelemetry",
  "readGrantAdmissionStateAnchor",
  "writeGrantAdmissionStateAnchor",
] as const);
export const REQUIRED_GRANT_STORAGE_MAINTENANCE_METHODS = Object.freeze([
  "pruneGrantAdmissionTelemetry",
  "writeGrantAdmissionStateAnchor",
] as const);
export const REQUIRED_GRANT_STORAGE_ANCHOR_METHODS = Object.freeze([
  "readGrantAdmissionStateAnchor",
  "writeGrantAdmissionStateAnchor",
] as const);

export const EVENT_CATALOG_STORAGE_CAPABILITY_NAME = "event-catalog-storage" as const;
export const EVENT_CATALOG_STORAGE_CAPABILITY_VERSION = 1 as const;
export const EVENT_CATALOG_STORAGE_CAPABILITY_IMPLEMENTATION =
  "event-teams-rosters-pitches-transaction-v1" as const;
export type EventCatalogStorageCapability = {
  name: typeof EVENT_CATALOG_STORAGE_CAPABILITY_NAME;
  version: typeof EVENT_CATALOG_STORAGE_CAPABILITY_VERSION;
  implementation: typeof EVENT_CATALOG_STORAGE_CAPABILITY_IMPLEMENTATION;
  transaction: readonly string[];
};
export const REQUIRED_EVENT_CATALOG_STORAGE_TRANSACTION_METHODS = Object.freeze([
  "findEventTeam",
  "listEventTeams",
  "listRoster",
  "findRosterEntry",
  "findPitch",
  "listPitches",
  "insertEventTeam",
  "updateEventTeam",
  "insertRosterEntry",
  "updateRosterEntry",
  "insertPitch",
  "updatePitch",
  "findGameplaySlot",
  "listGameplaySlots",
  "findPitchSlot",
  "listPitchSlots",
  "findEventGame",
  "listEventGames",
  "insertGameplaySlot",
  "insertPitchSlot",
  "insertEventGame",
  "updateEventGame",
] as const);

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
  publicationStatus: "unpublished" | "published" | "cancelled";
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

export type StoredEventCatalogTeam = {
  eventTeamId: string;
  eventId: string;
  name: string;
  defaultColor: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type StoredEventCatalogRosterEntry = {
  rosterEntryId: string;
  eventId: string;
  eventTeamId: string;
  playerNumber: number;
  publicName: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type StoredEventCatalogPitch = {
  pitchId: string;
  eventId: string;
  name: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type StoredGameplaySlot = {
  gameplaySlotId: string;
  eventId: string;
  gameDayId: string;
  sequence: number;
  scheduledStartMs: number;
  createdAtMs: number;
  updatedAtMs: number;
};

export type StoredPitchSlot = {
  pitchSlotId: string;
  eventId: string;
  gameDayId: string;
  pitchId: string;
  gameplaySlotId: string;
  sequence: number;
  createdAtMs: number;
  updatedAtMs: number;
};

export type StoredEventGameSide = {
  sideId: string;
  eventTeamId: string | null;
  eventTeamName: string | null;
  sourceLabel: string | null;
  confirmedAtMs: number | null;
};

export type StoredEventCatalogGame = {
  eventGameId: string;
  eventId: string;
  gameDayId: string;
  gameplaySlotId: string;
  pitchSlotId: string;
  gameCode: string | null;
  gameDesignation: string | null;
  sideA: StoredEventGameSide;
  sideB: StoredEventGameSide;
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
    | "game-day-removed"
    | "event-team-created"
    | "event-team-updated"
    | "roster-updated"
    | "pitch-created"
    | "pitch-updated"
    | "gameplay-slot-created"
    | "pitch-slot-created"
    | "event-game-created"
    | "event-game-teams-confirmed"
    | "event-publication-changed";
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
      evidence?: FoundationStorageEvidence;
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
        | "quarantine-failure"
        | "not-writeable";
      detail: string;
      storage: "memory" | "sqlite";
      evidence?: FoundationStorageEvidence;
    };

export type FoundationStorageFailureCategory =
  | "busy"
  | "readonly"
  | "full"
  | "io-error"
  | "commit-failure"
  | "corruption";

export type FoundationStorageKeyCategory = "encryption" | "lookup" | "audit";

export type FoundationStorageKeyCounts = Record<FoundationStorageKeyCategory, number>;

export type FoundationStorageEvidence = {
  runtime: { engine: "bun"; version: string; sqliteVersion: string | null };
  transaction: {
    lastLatencyMs: number | null;
    rejectionCount: number;
    rejectionCategories: Record<FoundationStorageFailureCategory, number>;
    writePressure: "unknown" | "normal" | "unsafe";
  };
  sqlite: {
    journalMode: "wal" | "unknown";
    synchronous: number | null;
    foreignKeys: boolean | null;
    walBytes: number | null;
    checkpoint: "not-attempted" | "ok" | "busy" | "failed";
    diskBytes: number | null;
    diskFreeBytes: number | null;
    failureCategory: FoundationStorageFailureCategory | null;
  };
  migration: {
    state: "unknown" | "ready" | "unsafe";
    schemaVersion: string | null;
    appliedCount: number | null;
  };
  keys: {
    requiredCount: number;
    availableCount: number;
    missingCount: number;
    requiredCategories: FoundationStorageKeyCounts;
    availableCategories: FoundationStorageKeyCounts;
    missingCategories: FoundationStorageKeyCounts;
  };
  replay: {
    result: "not-configured" | "passed" | "failed";
    rootCount: number;
    actionCount: number;
    durationMs: number | null;
  };
};

export type FoundationStorageReadinessContext = {
  actionCodecRegistry: ControlActionCodecRegistry;
  interpreter: IqaGameRulesInterpreter;
};

export type FoundationStorageLiveness = { ok: true; process: "available" };

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
  findGrantByCodeLookupDigest?(lookupDigest: string): StoredGrant | null;
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
  findEventTeam(eventTeamId: string): StoredEventCatalogTeam | null;
  listEventTeams(eventId: string): StoredEventCatalogTeam[];
  listRoster(eventTeamId: string): StoredEventCatalogRosterEntry[];
  findRosterEntry(eventTeamId: string, playerNumber: number): StoredEventCatalogRosterEntry | null;
  findPitch(pitchId: string): StoredEventCatalogPitch | null;
  listPitches(eventId: string): StoredEventCatalogPitch[];
  findGameplaySlot?(gameplaySlotId: string): StoredGameplaySlot | null;
  listGameplaySlots?(gameDayId: string): StoredGameplaySlot[];
  findPitchSlot?(pitchSlotId: string): StoredPitchSlot | null;
  listPitchSlots?(gameDayId: string, pitchId?: string): StoredPitchSlot[];
  findEventGame?(eventGameId: string): StoredEventCatalogGame | null;
  listEventGames?(gameDayId: string): StoredEventCatalogGame[];
  listEventAuditTrail(eventId: string): EventCatalogAuditEntry[];
  readGrantAdmissionTelemetry?(
    mode: GrantAdmissionMode,
    sourceDigest: string,
  ): GrantAdmissionTelemetry | null;
  readGrantAdmissionGlobalWindow?(mode: GrantAdmissionMode): GrantAdmissionGlobalWindow | null;
  readGrantAdmissionStateAnchor?(): GrantAdmissionStateAnchor | null;
};

export type FoundationStorageTransaction = FoundationStorageSnapshot & {
  findGameplaySlot(gameplaySlotId: string): StoredGameplaySlot | null;
  listGameplaySlots(gameDayId: string): StoredGameplaySlot[];
  findPitchSlot(pitchSlotId: string): StoredPitchSlot | null;
  listPitchSlots(gameDayId: string, pitchId?: string): StoredPitchSlot[];
  findEventGame(eventGameId: string): StoredEventCatalogGame | null;
  listEventGames(gameDayId: string): StoredEventCatalogGame[];
  insertRoot(root: StoredEventGameRecordRoot): void;
  updateRoot(root: StoredEventGameRecordRoot): void;
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
  insertEventTeam(team: StoredEventCatalogTeam): void;
  updateEventTeam(team: StoredEventCatalogTeam): void;
  insertRosterEntry(entry: StoredEventCatalogRosterEntry): void;
  updateRosterEntry(entry: StoredEventCatalogRosterEntry): void;
  insertPitch(pitch: StoredEventCatalogPitch): void;
  updatePitch(pitch: StoredEventCatalogPitch): void;
  insertGameplaySlot(slot: StoredGameplaySlot): void;
  insertPitchSlot(slot: StoredPitchSlot): void;
  insertEventGame(game: StoredEventCatalogGame): void;
  updateEventGame(game: StoredEventCatalogGame): void;
  appendEventAudit(entry: EventCatalogAuditEntry): void;
  writeGrantAdmissionTelemetry?(value: GrantAdmissionTelemetry): void;
  writeGrantAdmissionGlobalWindow?(value: GrantAdmissionGlobalWindow): void;
  pruneGrantAdmissionTelemetry?(beforeMs: number): void;
  readGrantAdmissionStateAnchor?(): GrantAdmissionStateAnchor | null;
  writeGrantAdmissionStateAnchor?(): void;
};

export type FoundationStorageTransactionWork<T> = (transaction: FoundationStorageTransaction) => T;

export type CatalogCapableFoundationStorage = FoundationStorage & {
  eventCatalogStorageCapability(): EventCatalogStorageCapability;
};

export class FoundationEventCatalogCapabilityError extends Error {
  constructor() {
    super("Foundation storage does not implement the Event Catalog contract.");
    this.name = "FoundationEventCatalogCapabilityError";
  }
}

export function assertEventCatalogStorageCapability(
  capability: EventCatalogStorageCapability,
): void {
  if (
    capability.name !== EVENT_CATALOG_STORAGE_CAPABILITY_NAME ||
    capability.version !== EVENT_CATALOG_STORAGE_CAPABILITY_VERSION ||
    capability.implementation !== EVENT_CATALOG_STORAGE_CAPABILITY_IMPLEMENTATION ||
    !sameMethods(capability.transaction, REQUIRED_EVENT_CATALOG_STORAGE_TRANSACTION_METHODS)
  ) {
    throw new FoundationEventCatalogCapabilityError();
  }
}

export function requireEventCatalogStorageCapabilities(
  storage: FoundationStorage,
): asserts storage is CatalogCapableFoundationStorage {
  if (typeof storage.eventCatalogStorageCapability !== "function")
    throw new FoundationEventCatalogCapabilityError();
  assertEventCatalogStorageCapability(storage.eventCatalogStorageCapability());
}

/** The storage surface required by the Grant-Code authority. */
export type GrantStorageTransaction = FoundationStorageTransaction & {
  findGrantByCodeLookupDigest(lookupDigest: string): StoredGrant | null;
  readGrantAdmissionTelemetry(
    mode: GrantAdmissionMode,
    sourceDigest: string,
  ): GrantAdmissionTelemetry | null;
  readGrantAdmissionGlobalWindow(mode: GrantAdmissionMode): GrantAdmissionGlobalWindow | null;
  writeGrantAdmissionTelemetry(value: GrantAdmissionTelemetry): void;
  writeGrantAdmissionGlobalWindow(value: GrantAdmissionGlobalWindow): void;
  pruneGrantAdmissionTelemetry(beforeMs: number): void;
  readGrantAdmissionStateAnchor(): GrantAdmissionStateAnchor | null;
  writeGrantAdmissionStateAnchor(): void;
};

export type GrantCapableFoundationStorage = FoundationStorage & {
  grantStorageCapability(): GrantStorageCapability;
  setGrantKeyRing(keyRing: GrantKeyRing): void;
  setGrantValidationContext(context: GrantStateValidationContext): void;
};

export class FoundationStorageCapabilityError extends Error {
  constructor() {
    super("Foundation storage does not implement the authenticated Grant-Code contract.");
    this.name = "FoundationStorageCapabilityError";
  }
}

export function requireGrantStorageCapabilities(
  storage: FoundationStorage,
): asserts storage is GrantCapableFoundationStorage {
  if (
    typeof storage.grantStorageCapability !== "function" ||
    typeof storage.setGrantKeyRing !== "function" ||
    typeof storage.setGrantValidationContext !== "function"
  ) {
    throw new FoundationStorageCapabilityError();
  }
  const capability = storage.grantStorageCapability();
  if (
    capability.name !== GRANT_STORAGE_CAPABILITY_NAME ||
    capability.version !== GRANT_STORAGE_CAPABILITY_VERSION ||
    capability.implementation !== GRANT_STORAGE_CAPABILITY_IMPLEMENTATION ||
    !sameMethods(capability.transaction, REQUIRED_GRANT_STORAGE_TRANSACTION_METHODS) ||
    !sameMethods(capability.maintenance, REQUIRED_GRANT_STORAGE_MAINTENANCE_METHODS) ||
    !sameMethods(capability.anchors, REQUIRED_GRANT_STORAGE_ANCHOR_METHODS)
  ) {
    throw new FoundationStorageCapabilityError();
  }
}

export function requireGrantStorageTransaction(
  transaction: FoundationStorageTransaction,
): GrantStorageTransaction {
  if (
    typeof transaction.findGrantByCodeLookupDigest !== "function" ||
    typeof transaction.readGrantAdmissionTelemetry !== "function" ||
    typeof transaction.readGrantAdmissionGlobalWindow !== "function" ||
    typeof transaction.writeGrantAdmissionTelemetry !== "function" ||
    typeof transaction.writeGrantAdmissionGlobalWindow !== "function" ||
    typeof transaction.pruneGrantAdmissionTelemetry !== "function" ||
    typeof transaction.readGrantAdmissionStateAnchor !== "function" ||
    typeof transaction.writeGrantAdmissionStateAnchor !== "function"
  ) {
    throw new FoundationStorageCapabilityError();
  }
  return transaction as GrantStorageTransaction;
}

function sameMethods(actual: readonly string[], required: readonly string[]): boolean {
  return actual.length === required.length && required.every((method) => actual.includes(method));
}

export interface FoundationStorage {
  transaction<T>(work: FoundationStorageTransactionWork<T>): Promise<T>;
  readRoot(recordId: string): Promise<EventGameRecordRoot | null>;
  readActions(recordId: string): Promise<StoredControlAction[]>;
  readIdempotencyEntries(recordId: string): Promise<StoredControlIdempotencyEntry[]>;
  readRecordMetadata(recordId: string): Promise<StoredEventGameRecordMetadata | null>;
  readAuditEntries(recordId: string): Promise<StoredControlAuditEntry[]>;
  readiness(): Promise<FoundationStorageReadiness>;
  liveness?(): FoundationStorageLiveness;
  setReadinessContext?(context: FoundationStorageReadinessContext): void;
  /** Configure the key material required to validate persisted Grant state. */
  setGrantKeyRing?(keyRing: GrantKeyRing): void;
  /** Configure the environment and key material required for deep Grant validation. */
  setGrantValidationContext?(context: GrantStateValidationContext): void;
  grantStorageCapability?(): GrantStorageCapability;
  eventCatalogStorageCapability?(): EventCatalogStorageCapability;
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
  | "event-team-id"
  | "event-team-name"
  | "event-team-name-snapshot"
  | "roster-entry-id"
  | "roster-player-number"
  | "pitch-id"
  | "pitch-name"
  | "gameplay-slot-id"
  | "gameplay-slot-sequence"
  | "pitch-slot-identity"
  | "pitch-slot-game"
  | "event-game-side-id"
  | "event-game-code"
  | "event-audit-id"
  | "event-operation-id"
  | "grant-code-digest";

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
