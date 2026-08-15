import { Database } from "bun:sqlite";
import {
  closeSync,
  chmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import {
  appendGrantAudit,
  createGrantSqliteStatements,
  insertGrant,
  insertGrantSession,
  listGrantAudit,
  listGrants,
  listGrantSessions,
  readGrantByStatement,
  readSessionByStatement,
  updateGrant,
  updateGrantSession,
  type GrantSqliteStatements,
  readGrantAdmissionGlobalWindow,
  readGrantAdmissionStateAnchor,
  readGrantAdmissionTelemetry,
  scanGrantState,
  writeGrantStateAnchor,
  writeGrantAdmissionStateAnchor,
} from "@/lib/grant-storage-sqlite";
import type { GrantKeyRing } from "@/lib/grant-types";
import type { GrantStateValidationContext } from "@/lib/grant-state-validation";
import {
  CONTROL_ACTION_ORDERING_VERSION,
  rebuildControlActionHistory,
} from "@/lib/event-game-actions";
import { validateIdempotencyHistory } from "@/lib/event-game-record-helpers";
import {
  presentationEvidenceFailure,
  presentationIntegrityAnchorFor,
  type PresentationIntegrityAnchor,
} from "@/lib/presentation-integrity";
import type {
  StoredGamePresentationAuditEntry,
  StoredGamePresentationAuditRevision,
  StoredGamePresentationChange,
} from "@/lib/game-presentation";
import {
  assessMigrationReadiness,
  FOUNDATION_MIGRATION_LEDGER_SQL,
  FOUNDATION_MIGRATIONS,
  type FoundationMigration,
  type MigrationLedgerEntry,
  type MigrationReadiness,
} from "@/lib/foundation-migrations";
import { verifyFoundationSchema, readValidatedFoundationRoot } from "@/lib/foundation-schema";
import {
  FOUNDATION_BACKUP_POLICY,
  inspectRecoveryDatabase,
  quoteRecoverySqliteString,
  type RecoverySnapshotFacts,
} from "@/lib/foundation-recovery-sqlite";
import {
  FoundationStorageClosedError,
  FoundationStorageConstraintError,
  FoundationStorageNotReadyError,
  type FoundationStorageEvidence,
  type FoundationStorageFailureCategory,
  type FoundationStorageKeyCategory,
  type FoundationStorageKeyCounts,
  type FoundationStorageReadinessContext,
  isThenable,
  type FoundationStorage,
  type FoundationStorageReadiness,
  type FoundationStorageTransaction,
  type FoundationStorageTransactionWork,
  type StoredControlAction,
  type StoredControlAuditEntry,
  type StoredControlIdempotencyEntry,
  type StoredAcceptanceBudget,
  type StoredReplayAttempt,
  type StoredReplayReceipt,
  type StoredReplayReservation,
  type StoredEventGameRecordMetadata,
  type StoredEventGameRecordRoot,
  type StoredEventCatalogEvent,
  type StoredEventCatalogGameDay,
  type StoredEventCatalogTeam,
  type StoredEventCatalogRosterEntry,
  type StoredEventCatalogPitch,
  type StoredGameplaySlot,
  type StoredPitchSlot,
  type StoredEventCatalogGame,
  type EventCatalogAuditEntry,
} from "@/lib/foundation-storage";
import type {
  AcceptanceIntegrityAnchor,
  AcceptanceIntegritySubject,
} from "@/lib/foundation-acceptance-integrity";
import {
  actionIdentity,
  asRecord,
  quoteSqliteString,
  readAudit,
  readIdempotency,
  readInteger,
  readNullableInteger,
  readMetadata,
  readStoredAction,
  readText,
  translateSqliteConstraint as translateControlSqliteConstraint,
  type RootRow,
} from "@/lib/foundation-storage-sqlite-helpers";

export type SqliteFoundationStorageOptions = {
  migrations?: readonly FoundationMigration[];
  busyTimeoutMs?: number;
  /** Read-only existing-database mode used by startup readiness preflight. */
  readOnly?: boolean;
  /** Test-only synchronization seam immediately before acquiring the writer lock. */
  beforeWriteTransactionLock?: () => void;
  grantKeyRing?: GrantKeyRing;
  grantValidationContext?: GrantStateValidationContext;
  /** Test-only fault injection at a durable transaction phase. */
  faultInjector?: (
    phase:
      | "begin"
      | "commit"
      | "before-commit"
      | "after-commit"
      | "readiness-write-probe"
      | "quarantine-write"
      | "quarantine-rename"
      | "quarantine-sync"
      | "quarantine-verify",
  ) => void;
  /** Migration candidates are not authoritative runtime composition boundaries. */
  requireReplayContext?: boolean;
};

const QUARANTINE_MARKER_CONTENT = "quadball-timer-foundation-quarantine-v1\ncategory=corruption\n";
const QUARANTINE_MARKER_MAX_BYTES = 128;

export type SqliteFoundationSettings = {
  journalMode: string;
  synchronous: number;
  foreignKeys: number;
  busyTimeoutMs: number;
};

export type FoundationMigrationReport = {
  appliedMigrationIds: string[];
  schemaVersion: number;
};

export type FoundationMigrationCandidateReport = {
  ready: boolean;
  candidatePath: string;
  migration: FoundationMigrationReport;
  readiness: FoundationStorageReadiness;
};

export class FoundationMigrationError extends Error {
  readonly readiness?: MigrationReadiness;

  constructor(message: string, readiness?: MigrationReadiness) {
    super(message);
    this.name = "FoundationMigrationError";
    this.readiness = readiness;
  }
}

export class SqliteFoundationFault extends Error {
  readonly category: FoundationStorageFailureCategory;

  constructor(category: FoundationStorageFailureCategory) {
    super("Injected SQLite foundation fault.");
    this.name = "SqliteFoundationFault";
    this.category = category;
  }
}

export class FoundationQuarantinePersistenceError extends Error {
  constructor() {
    super("SQLite corruption quarantine could not be durably persisted.");
    this.name = "FoundationQuarantinePersistenceError";
  }
}

function readBudget(value: unknown): StoredAcceptanceBudget | null {
  if (value === null || value === undefined) return null;
  const row = value as Record<string, unknown>;
  return {
    bucketId: String(row.bucket_id),
    bucketKind: String(row.bucket_kind) as StoredAcceptanceBudget["bucketKind"],
    subjectId: String(row.subject_id),
    capacity: Number(row.capacity),
    refillPerSecond: Number(row.refill_per_second),
    tokens: Number(row.tokens),
    updatedAtMs: Number(row.updated_at_ms),
    stateRevision: Number(row.state_revision),
  };
}

function readPresentationChange(value: unknown): StoredGamePresentationChange {
  const row = value as Record<string, unknown>;
  return {
    recordId: String(row.record_id),
    eventGameId: String(row.event_game_id),
    operationId: String(row.operation_id),
    presentationChangeId: String(row.presentation_change_id),
    change: JSON.parse(String(row.change_json)) as StoredGamePresentationChange["change"],
    causalPredecessorIds: JSON.parse(String(row.causal_predecessor_ids_json)) as string[],
    occurrence: JSON.parse(
      String(row.occurrence_json),
    ) as StoredGamePresentationChange["occurrence"],
    grant: JSON.parse(String(row.grant_json)) as StoredGamePresentationChange["grant"],
    acceptedAtMs: Number(row.accepted_at_ms),
    canonicalContent: String(row.canonical_content),
    contentFingerprint: String(row.content_fingerprint),
  };
}

function readPresentationAudit(value: unknown): StoredGamePresentationAuditEntry {
  const row = value as Record<string, unknown>;
  const audit = JSON.parse(String(row.audit_json)) as StoredGamePresentationAuditEntry;
  if (row.supersedes_audit_id === null || row.supersedes_audit_id === undefined) {
    delete audit.supersedesAuditId;
  } else {
    audit.supersedesAuditId = readText(row.supersedes_audit_id);
  }
  return audit;
}

function readReservation(value: unknown): StoredReplayReservation | null {
  if (value === null || value === undefined) return null;
  const row = value as Record<string, unknown>;
  return {
    reservationId: String(row.reservation_id),
    recordId: String(row.record_id),
    eventGameId: String(row.event_game_id),
    originatingSessionId: String(row.originating_session_id),
    replacementSessionId:
      row.replacement_session_id === null ? null : readText(row.replacement_session_id),
    actionCount: Number(row.action_count),
    status: String(row.status) as StoredReplayReservation["status"],
    batchDigest: row.batch_digest === null ? null : readText(row.batch_digest),
    createdAtMs: Number(row.created_at_ms),
    committedAtMs: row.committed_at_ms === null ? null : Number(row.committed_at_ms),
    acknowledgedAtMs: row.acknowledged_at_ms === null ? null : Number(row.acknowledged_at_ms),
    stateRevision: Number(row.state_revision),
  };
}

function readAttempt(value: unknown): StoredReplayAttempt {
  const row = value as Record<string, unknown>;
  return {
    attemptId: String(row.attempt_id),
    reservationId: String(row.reservation_id),
    operationId: String(row.operation_id),
    status: String(row.status) as StoredReplayAttempt["status"],
    actionFingerprint: row.action_fingerprint === null ? null : readText(row.action_fingerprint),
    resultJson: row.result_json === null ? null : readText(row.result_json),
    controlAuditId: row.control_audit_id === null ? null : readText(row.control_audit_id),
    grantAuditId: row.grant_audit_id === null ? null : readText(row.grant_audit_id),
    createdAtMs: Number(row.created_at_ms),
    completedAtMs: row.completed_at_ms === null ? null : Number(row.completed_at_ms),
    stateRevision: Number(row.state_revision),
  };
}

function readReceipt(value: unknown): StoredReplayReceipt | null {
  if (value === null || value === undefined) return null;
  const row = value as Record<string, unknown>;
  return {
    receiptId: String(row.receipt_id),
    reservationId: String(row.reservation_id),
    receiptDigest: String(row.receipt_digest),
    receiptKeyVersion: String(row.receipt_key_version),
    status: String(row.status) as StoredReplayReceipt["status"],
    actionCount: Number(row.action_count),
    createdAtMs: Number(row.created_at_ms),
    acknowledgedAtMs: row.acknowledged_at_ms === null ? null : Number(row.acknowledged_at_ms),
    stateRevision: Number(row.state_revision),
  };
}

function readIntegrityAnchor(value: unknown): AcceptanceIntegrityAnchor {
  const row = value as Record<string, unknown>;
  return {
    anchorId: String(row.anchor_id),
    subjectKind: String(row.subject_kind) as AcceptanceIntegritySubject,
    subjectId: String(row.subject_id),
    stateRevision: Number(row.state_revision),
    keyVersion: String(row.key_version),
    canonicalValue: String(row.canonical_value),
    integrityTag: String(row.integrity_tag),
  };
}

function readEvent(value: unknown): StoredEventCatalogEvent | null {
  if (value === null || value === undefined) return null;
  const row = value as Record<string, unknown>;
  return {
    eventId: String(row.eventId),
    name: String(row.name),
    timeZone: String(row.timeZone),
    publicationStatus: String(
      row.publicationStatus,
    ) as StoredEventCatalogEvent["publicationStatus"],
    createdAtMs: Number(row.createdAtMs),
    updatedAtMs: Number(row.updatedAtMs),
  };
}

function readGameDay(value: unknown): StoredEventCatalogGameDay {
  const row = value as Record<string, unknown>;
  return {
    gameDayId: String(row.gameDayId),
    eventId: String(row.eventId),
    date: String(row.date),
    heatStoppageConfiguration: String(
      row.heatStoppageConfiguration,
    ) as StoredEventCatalogGameDay["heatStoppageConfiguration"],
    createdAtMs: Number(row.createdAtMs),
    updatedAtMs: Number(row.updatedAtMs),
  };
}

function readEventTeam(value: unknown): StoredEventCatalogTeam {
  const row = value as Record<string, unknown>;
  return {
    eventTeamId: String(row.eventTeamId),
    eventId: String(row.eventId),
    name: String(row.name),
    defaultColor: String(row.defaultColor),
    createdAtMs: Number(row.createdAtMs),
    updatedAtMs: Number(row.updatedAtMs),
  };
}

function readRosterEntry(value: unknown): StoredEventCatalogRosterEntry {
  const row = value as Record<string, unknown>;
  return {
    rosterEntryId: String(row.rosterEntryId),
    eventId: String(row.eventId),
    eventTeamId: String(row.eventTeamId),
    playerNumber: Number(row.playerNumber),
    publicName: String(row.publicName),
    createdAtMs: Number(row.createdAtMs),
    updatedAtMs: Number(row.updatedAtMs),
  };
}

function readPitch(value: unknown): StoredEventCatalogPitch {
  const row = value as Record<string, unknown>;
  return {
    pitchId: String(row.pitchId),
    eventId: String(row.eventId),
    name: String(row.name),
    createdAtMs: Number(row.createdAtMs),
    updatedAtMs: Number(row.updatedAtMs),
  };
}

function readGameplaySlot(value: unknown): StoredGameplaySlot {
  const row = value as Record<string, unknown>;
  return {
    gameplaySlotId: String(row.gameplaySlotId),
    eventId: String(row.eventId),
    gameDayId: String(row.gameDayId),
    sequence: Number(row.sequence),
    scheduledStartMs: Number(row.scheduledStartMs),
    expectedDelayMs: Number(row.expectedDelayMs ?? 0),
    createdAtMs: Number(row.createdAtMs),
    updatedAtMs: Number(row.updatedAtMs),
  };
}

function readPitchSlot(value: unknown): StoredPitchSlot {
  const row = value as Record<string, unknown>;
  return {
    pitchSlotId: String(row.pitchSlotId),
    eventId: String(row.eventId),
    gameDayId: String(row.gameDayId),
    pitchId: String(row.pitchId),
    gameplaySlotId: String(row.gameplaySlotId),
    sequence: Number(row.sequence),
    expectedDelayMs: Number(row.expectedDelayMs ?? 0),
    createdAtMs: Number(row.createdAtMs),
    updatedAtMs: Number(row.updatedAtMs),
  };
}

function readEventGame(value: unknown): StoredEventCatalogGame {
  const row = value as Record<string, unknown>;
  const parseSide = (prefix: "a" | "b") => ({
    sideId: String(row[`${prefix}SideId`]),
    eventTeamId: row[`${prefix}EventTeamId`] === null ? null : String(row[`${prefix}EventTeamId`]),
    eventTeamName:
      row[`${prefix}EventTeamName`] === null ? null : String(row[`${prefix}EventTeamName`]),
    sourceLabel: row[`${prefix}SourceLabel`] === null ? null : String(row[`${prefix}SourceLabel`]),
    confirmedAtMs:
      row[`${prefix}ConfirmedAtMs`] === null ? null : Number(row[`${prefix}ConfirmedAtMs`]),
  });
  return {
    eventGameId: String(row.eventGameId),
    eventId: String(row.eventId),
    gameDayId: String(row.gameDayId),
    gameplaySlotId: String(row.gameplaySlotId),
    pitchSlotId: String(row.pitchSlotId),
    gameCode: row.gameCode === null ? null : readText(row.gameCode),
    gameDesignation: row.gameDesignation === null ? null : readText(row.gameDesignation),
    sideA: parseSide("a"),
    sideB: parseSide("b"),
    createdAtMs: Number(row.createdAtMs),
    updatedAtMs: Number(row.updatedAtMs),
  };
}

function readEventAudit(value: unknown): EventCatalogAuditEntry {
  const row = value as Record<string, unknown>;
  return {
    auditId: String(row.auditId),
    operationId: String(row.operationId),
    action: String(row.action) as EventCatalogAuditEntry["action"],
    eventId: String(row.eventId),
    gameDayId: row.gameDayId === null ? null : String(row.gameDayId as string),
    actorReference: String(row.actorReference),
    occurredAtMs: Number(row.occurredAtMs),
    before: row.beforeJson === null ? null : JSON.parse(String(row.beforeJson as string)),
    after: JSON.parse(String(row.afterJson)),
  };
}

type SqlStatement = ReturnType<Database["query"]>;

type RootStatements = {
  byRecordId: SqlStatement;
  byEventGameId: SqlStatement;
  byPitchSlotId: SqlStatement;
  byGameSideId: SqlStatement;
  insertRoot: SqlStatement;
  allRoots: SqlStatement;
  updateRoot: SqlStatement;
  insertSide: SqlStatement;
  actionByOperationId: SqlStatement;
  actionsByRecordId: SqlStatement;
  insertAction: SqlStatement;
  insertIdempotency: SqlStatement;
  metadataByRecordId: SqlStatement;
  upsertMetadata: SqlStatement;
  auditByRecordId: SqlStatement;
  idempotencyByRecordId: SqlStatement;
  insertAudit: SqlStatement;
  presentationChangeByOperationId: SqlStatement;
  presentationChangesByRecordId: SqlStatement;
  insertPresentationChange: SqlStatement;
  presentationAuditsByRecordId: SqlStatement;
  insertPresentationAudit: SqlStatement;
  presentationIntegrityByRecordId: SqlStatement;
  insertPresentationIntegrity: SqlStatement;
  insertEvidenceProvenance: SqlStatement;
  budgetById: SqlStatement;
  upsertBudget: SqlStatement;
  reservationById: SqlStatement;
  reservationByTuple: SqlStatement;
  reservationByOriginTuple: SqlStatement;
  insertReservation: SqlStatement;
  updateReservation: SqlStatement;
  attemptsByReservation: SqlStatement;
  insertAttempt: SqlStatement;
  updateAttempt: SqlStatement;
  discardAttempts: SqlStatement;
  discardAnchors: SqlStatement;
  discardReservation: SqlStatement;
  receiptByDigest: SqlStatement;
  receiptByReservationId: SqlStatement;
  anchorsBySubject: SqlStatement;
  insertReceipt: SqlStatement;
  updateReceipt: SqlStatement;
  insertAnchor: SqlStatement;
  eventById: SqlStatement;
  allEvents: SqlStatement;
  gameDaysByEventId: SqlStatement;
  eventAuditsByEventId: SqlStatement;
  eventTeamById: SqlStatement;
  eventTeamsByEventId: SqlStatement;
  rosterByTeamId: SqlStatement;
  rosterEntryByTeamAndNumber: SqlStatement;
  pitchById: SqlStatement;
  pitchesByEventId: SqlStatement;
  gameplaySlotById: SqlStatement;
  gameplaySlotsByGameDay: SqlStatement;
  pitchSlotById: SqlStatement;
  pitchSlotsByGameDay: SqlStatement;
  eventGameById: SqlStatement;
  eventGamesByGameDay: SqlStatement;
  insertEvent: SqlStatement;
  updateEvent: SqlStatement;
  deleteEvent: SqlStatement;
  insertGameDay: SqlStatement;
  updateGameDay: SqlStatement;
  deleteGameDay: SqlStatement;
  insertEventAudit: SqlStatement;
  insertEventTeam: SqlStatement;
  updateEventTeam: SqlStatement;
  deleteEventTeam: SqlStatement;
  insertRosterEntry: SqlStatement;
  updateRosterEntry: SqlStatement;
  insertPitch: SqlStatement;
  updatePitch: SqlStatement;
  deletePitch: SqlStatement;
  insertGameplaySlot: SqlStatement;
  insertPitchSlot: SqlStatement;
  updateGameplaySlot: SqlStatement;
  updatePitchSlot: SqlStatement;
  deleteGameplaySlot: SqlStatement;
  deletePitchSlot: SqlStatement;
  insertEventGame: SqlStatement;
  updateEventGame: SqlStatement;
  deleteEventGame: SqlStatement;
};

function assertGameplaySlotMembership(statements: RootStatements, slot: StoredGameplaySlot): void {
  assertGameDayMembership(statements, slot.eventId, slot.gameDayId);
}

function assertGameDayMembership(
  statements: RootStatements,
  eventId: string,
  gameDayId: string,
): void {
  const day = statements.gameDaysByEventId
    .all(eventId)
    .map(readGameDay)
    .find((candidate) => candidate.gameDayId === gameDayId);
  if (day === undefined) throw new FoundationStorageConstraintError("game-day-id");
}

function assertPitchSlotMembership(statements: RootStatements, slot: StoredPitchSlot): void {
  assertGameDayMembership(statements, slot.eventId, slot.gameDayId);
  const pitch = statements.pitchesByEventId
    .all(slot.eventId)
    .map(readPitch)
    .find((candidate) => candidate.pitchId === slot.pitchId);
  const gameplaySlot = statements.gameplaySlotById.get(slot.gameplaySlotId);
  if (pitch === undefined) throw new FoundationStorageConstraintError("pitch-id");
  if (gameplaySlot === null) throw new FoundationStorageConstraintError("gameplay-slot-id");
  const parsedGameplaySlot = readGameplaySlot(gameplaySlot);
  if (
    parsedGameplaySlot.eventId !== slot.eventId ||
    parsedGameplaySlot.gameDayId !== slot.gameDayId
  )
    throw new FoundationStorageConstraintError("gameplay-slot-id");
}

function assertEventGameMembership(statements: RootStatements, game: StoredEventCatalogGame): void {
  assertGameDayMembership(statements, game.eventId, game.gameDayId);
  const gameplaySlot = statements.gameplaySlotById.get(game.gameplaySlotId);
  const pitchSlot = statements.pitchSlotById.get(game.pitchSlotId);
  if (gameplaySlot === null) throw new FoundationStorageConstraintError("gameplay-slot-id");
  if (pitchSlot === null) throw new FoundationStorageConstraintError("pitch-slot-id");
  const parsedGameplaySlot = readGameplaySlot(gameplaySlot);
  const parsedPitchSlot = readPitchSlot(pitchSlot);
  if (
    parsedGameplaySlot.eventId !== game.eventId ||
    parsedGameplaySlot.gameDayId !== game.gameDayId
  )
    throw new FoundationStorageConstraintError("gameplay-slot-id");
  if (
    parsedPitchSlot.eventId !== game.eventId ||
    parsedPitchSlot.gameDayId !== game.gameDayId ||
    parsedPitchSlot.gameplaySlotId !== game.gameplaySlotId
  )
    throw new FoundationStorageConstraintError("pitch-slot-id");
  const teamIds = new Set(
    statements.eventTeamsByEventId
      .all(game.eventId)
      .map(readEventTeam)
      .map((team) => team.eventTeamId),
  );
  const teams = new Map(
    statements.eventTeamsByEventId
      .all(game.eventId)
      .map(readEventTeam)
      .map((team) => [team.eventTeamId, team]),
  );
  const existingRow = statements.eventGameById.get(game.eventGameId);
  const existing = existingRow === null ? null : readEventGame(existingRow);
  for (const side of [game.sideA, game.sideB]) {
    if (side.eventTeamId !== null && !teamIds.has(side.eventTeamId))
      throw new FoundationStorageConstraintError("event-team-id");
    if (
      (side.eventTeamId === null && side.eventTeamName !== null) ||
      (side.eventTeamId !== null && side.eventTeamName === null)
    )
      throw new FoundationStorageConstraintError("event-team-name-snapshot");
    if (side.eventTeamId !== null) {
      const previousSide =
        existing === null
          ? null
          : existing.sideA.sideId === side.sideId
            ? existing.sideA
            : existing.sideB.sideId === side.sideId
              ? existing.sideB
              : null;
      const expectedName =
        previousSide?.eventTeamId === side.eventTeamId
          ? previousSide.eventTeamName
          : teams.get(side.eventTeamId)?.name;
      if (side.eventTeamName !== expectedName)
        throw new FoundationStorageConstraintError("event-team-name-snapshot");
    }
  }
}

const ROOT_SELECT_COLUMNS = `
  roots.record_id AS record_id, roots.event_id AS event_id, roots.event_game_id AS event_game_id,
  roots.owner_event_id AS owner_event_id, roots.owner_event_game_id AS owner_event_game_id,
  roots.scope_event_id AS scope_event_id, roots.game_day_id AS game_day_id,
  roots.pitch_id AS pitch_id, roots.pitch_slot_id AS pitch_slot_id,
  roots.lifecycle_phase AS lifecycle_phase, roots.commenced_at_ms AS commenced_at_ms,
  roots.finished_at_ms AS finished_at_ms, roots.locked_at_ms AS locked_at_ms,
  roots.lock_reason AS lock_reason, roots.record_version AS record_version,
  roots.schema_version AS schema_version, roots.interpreter_version AS interpreter_version,
  roots.creation_operation_id AS creation_operation_id,
  roots.creation_actor_reference AS creation_actor_reference,
  roots.creation_source AS creation_source, roots.creation_created_at_ms AS creation_created_at_ms,
  roots.canonical_content AS canonical_content, roots.root_json AS root_json
`;

const OPAQUE_MIGRATION_REFERENCE_PATTERN = /^opaque-migration-reference-v1:[a-f0-9]{64}$/;

const KEY_CATEGORIES: readonly FoundationStorageKeyCategory[] = ["encryption", "lookup", "audit"];

function emptyKeyCounts(): FoundationStorageKeyCounts {
  return { encryption: 0, lookup: 0, audit: 0 };
}

function extractIntegrityKeyVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^hmac-sha256-v1:([^:]{1,64}):[^:]{1,256}$/.exec(value);
  return match?.[1] ?? null;
}

function readNullableTextValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export class SqliteFoundationStorage implements FoundationStorage {
  readonly databasePath: string;
  readonly quarantineMarkerPath: string | null;

  private readonly database: Database;
  private readonly migrations: readonly FoundationMigration[];
  private readonly busyTimeoutMs: number;
  private readonly readOnly: boolean;
  private readonly beforeWriteTransactionLock: (() => void) | undefined;
  private readonly faultInjector: SqliteFoundationStorageOptions["faultInjector"];
  private readonly requireReplayContext: boolean;
  private grantValidationContext: GrantStateValidationContext;
  private writerTail: Promise<void> = Promise.resolve();
  private statements: RootStatements | undefined;
  private grantStatements: GrantSqliteStatements | undefined;
  private closed = false;
  private revision = 0;
  private dataVersion: number;
  private readinessContext: FoundationStorageReadinessContext | undefined;
  private unsafeFailure: FoundationStorageFailureCategory | undefined;
  private quarantinePersistenceFailure = false;
  private lastTransactionLatencyMs: number | null = null;
  private rejectionCount = 0;
  private readonly rejectionCategories: Record<FoundationStorageFailureCategory, number> = {
    busy: 0,
    readonly: 0,
    full: 0,
    "io-error": 0,
    "commit-failure": 0,
    corruption: 0,
  };

  constructor(databasePath: string, options: SqliteFoundationStorageOptions = {}) {
    this.databasePath = databasePath;
    this.quarantineMarkerPath = databasePath === ":memory:" ? null : `${databasePath}.quarantine`;
    this.migrations = options.migrations ?? FOUNDATION_MIGRATIONS;
    this.busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    this.readOnly = options.readOnly === true;
    this.beforeWriteTransactionLock = options.beforeWriteTransactionLock;
    this.faultInjector = options.faultInjector;
    this.requireReplayContext = options.requireReplayContext ?? true;
    this.grantValidationContext = options.grantValidationContext ?? {
      keyRing: options.grantKeyRing,
    };
    this.unsafeFailure = readQuarantineMarker(this.quarantineMarkerPath) ? "corruption" : undefined;
    this.database = this.readOnly
      ? new Database(databasePath, { readonly: true })
      : new Database(databasePath, { create: true, readwrite: true });
    if (!this.readOnly && this.unsafeFailure !== "corruption") this.configureDatabase();
    this.dataVersion = this.readDataVersion();
  }

  transaction<T>(work: FoundationStorageTransactionWork<T>): Promise<T> {
    return this.enqueue(() => {
      this.beforeWriteTransactionLock?.();
      const startedAt = Date.now();
      let transactionStarted = false;
      let commitBoundary = false;
      try {
        if (this.unsafeFailure === "corruption") {
          throw new FoundationStorageNotReadyError(this.readinessSync());
        }
        this.faultInjector?.("begin");
        this.database.exec("BEGIN IMMEDIATE;");
        transactionStarted = true;
        // The write lock fixes the snapshot before both the external revision
        // token and semantic readiness are derived. A commit from another
        // connection cannot land between these operations and be hidden by
        // the verified-revision cache.
        this.refreshExternalRevision();
        const readiness = this.readinessSync();
        if (!readiness.ok) {
          throw new FoundationStorageNotReadyError(readiness);
        }
        const result = work(this.createTransaction());
        if (isThenable(result)) {
          throw new TypeError("Foundation storage transactions must complete synchronously.");
        }
        const presentationFailure = this.verifyPresentationEvidence();
        if (presentationFailure !== null) {
          throw new FoundationStorageNotReadyError({
            ok: false,
            status: "integrity-failure",
            detail: presentationFailure,
            storage: "sqlite",
          });
        }
        scanGrantState(this.database, this.grantValidationContext);
        const keyRing = this.grantValidationContext.keyRing;
        const grants = listGrants(this.getGrantStatements().allGrants);
        if (keyRing !== undefined) {
          const grantStatements = this.getGrantStatements();
          for (const grant of grants) {
            if (listGrantAudit(grantStatements.auditByGrant, grant.grantId).length === 0) continue;
            writeGrantStateAnchor(grantStatements, grant.grantId, keyRing);
          }
          writeGrantAdmissionStateAnchor(grantStatements, keyRing);
        }
        commitBoundary = true;
        this.faultInjector?.("before-commit");
        this.faultInjector?.("commit");
        this.database.exec("COMMIT;");
        transactionStarted = false;
        this.faultInjector?.("after-commit");
        this.lastTransactionLatencyMs = boundedMetric(Date.now() - startedAt);
        this.unsafeFailure = undefined;
        this.revision += 1;
        this.dataVersion = this.readDataVersion();
        return result;
      } catch (error) {
        if (transactionStarted) this.rollbackQuietly();
        this.lastTransactionLatencyMs = boundedMetric(Date.now() - startedAt);
        const category = classifySqliteFailure(
          error,
          commitBoundary ? "commit" : transactionStarted ? "transaction" : "commit",
        );
        if (category !== null) {
          if (category === "corruption") this.latchCorruption();
          else this.unsafeFailure = category;
          this.rejectionCount = boundedMetric(this.rejectionCount + 1);
          this.rejectionCategories[category] = boundedMetric(
            this.rejectionCategories[category] + 1,
          );
        }
        throw translateSqliteConstraint(error);
      }
    });
  }

  readRoot(recordId: string): Promise<EventGameRecordRoot | null> {
    return this.enqueue(() => {
      const readiness = this.readinessSync();
      if (!readiness.ok) {
        throw new FoundationStorageNotReadyError(readiness);
      }
      return this.readRootByStatement(this.getStatements().byRecordId, recordId);
    });
  }

  readActions(recordId: string): Promise<StoredControlAction[]> {
    return this.enqueue(() => {
      const readiness = this.readinessSync();
      if (!readiness.ok) throw new FoundationStorageNotReadyError(readiness);
      return this.readActionsByRecordId(this.getStatements().actionsByRecordId, recordId);
    });
  }

  readRecordMetadata(recordId: string): Promise<StoredEventGameRecordMetadata | null> {
    return this.enqueue(() => {
      const readiness = this.readinessSync();
      if (!readiness.ok) throw new FoundationStorageNotReadyError(readiness);
      const row = this.getStatements().metadataByRecordId.get(recordId) as RootRow | null;
      return row === null ? null : readMetadata(row);
    });
  }

  readIdempotencyEntries(recordId: string): Promise<StoredControlIdempotencyEntry[]> {
    return this.enqueue(() => {
      const readiness = this.readinessSync();
      if (!readiness.ok) throw new FoundationStorageNotReadyError(readiness);
      return this.readIdempotencyByRecordId(this.getStatements().idempotencyByRecordId, recordId);
    });
  }

  readAuditEntries(recordId: string): Promise<StoredControlAuditEntry[]> {
    return this.enqueue(() => {
      const readiness = this.readinessSync();
      if (!readiness.ok) throw new FoundationStorageNotReadyError(readiness);
      return this.readAuditByRecordId(this.getStatements().auditByRecordId, recordId);
    });
  }

  readiness(): Promise<FoundationStorageReadiness> {
    return this.enqueue(() => this.readinessSync(!this.readOnly));
  }

  liveness() {
    return { ok: true as const, process: "available" as const };
  }

  setReadinessContext(context: FoundationStorageReadinessContext): void {
    this.readinessContext = context;
  }

  getSettings(): SqliteFoundationSettings {
    this.assertOpen();
    return this.readSettings();
  }

  async applyMigrations(
    options: { requireCandidate?: boolean } = {},
  ): Promise<FoundationMigrationReport> {
    if (this.unsafeFailure === "corruption") {
      throw new FoundationMigrationError(
        "The SQLite foundation database is quarantined after suspected corruption.",
      );
    }
    if (options.requireCandidate !== false) {
      const candidate = await this.validateCandidate();
      if (!candidate.ready) {
        throw new FoundationMigrationError(
          "The disposable migration candidate did not reach readiness.",
        );
      }
    }

    return this.enqueue(() => this.applyMigrationsSync());
  }

  async validateCandidate(
    options: { retainCandidate?: boolean } = {},
  ): Promise<FoundationMigrationCandidateReport> {
    this.assertOpen();
    if (this.databasePath === ":memory:") {
      throw new FoundationMigrationError(
        "A file-backed database is required for candidate validation.",
      );
    }

    const temporaryDirectory = await mkdtemp(join(tmpdir(), "quadball-timer-foundation-"));
    const candidatePath = join(temporaryDirectory, "candidate.sqlite");
    let candidate: SqliteFoundationStorage | undefined;
    let retainCandidate = options.retainCandidate === true;
    try {
      await this.enqueue(() => {
        this.database.exec(`VACUUM INTO ${quoteSqliteString(candidatePath)};`);
      });

      candidate = new SqliteFoundationStorage(candidatePath, {
        migrations: this.migrations,
        busyTimeoutMs: this.busyTimeoutMs,
        grantValidationContext: this.grantValidationContext,
        requireReplayContext: false,
      });
      const migration = await candidate.applyMigrations({ requireCandidate: false });
      const readiness = await candidate.readiness();
      retainCandidate = options.retainCandidate === true;
      return {
        ready: readiness.ok,
        candidatePath,
        migration,
        readiness,
      };
    } finally {
      candidate?.close();
      if (!retainCandidate) {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  /**
   * Recovery-only seam. The writer queue drains before the snapshot and remains
   * held until VACUUM INTO has fixed the complete SQLite image.
   */
  createRecoveryVacuumSnapshot(destinationPath: string): Promise<RecoverySnapshotFacts> {
    return this.enqueue(() => {
      if (this.databasePath === ":memory:") {
        throw new Error("A file-backed database is required for recovery snapshots.");
      }
      if (this.unsafeFailure === "corruption") {
        throw new FoundationStorageNotReadyError(this.readinessSync());
      }
      const facts = inspectRecoveryDatabase(this.database, FOUNDATION_BACKUP_POLICY);
      const previousUmask = process.umask(0o177);
      try {
        this.database.exec(`VACUUM INTO ${quoteRecoverySqliteString(destinationPath)};`);
      } finally {
        process.umask(previousUmask);
      }
      // The destination lives in the recovery-owned 0700 workspace. Tighten
      // and verify the raw Foundation image before yielding the writer queue.
      chmodSync(destinationPath, 0o600);
      return facts;
    });
  }

  /** Drain authoritative work and close the handle before a staged replacement. */
  quiesceForRecovery(): Promise<void> {
    const queued = this.writerTail.then(() => {
      this.assertOpen();
      if (this.unsafeFailure !== "corruption") {
        const checkpoint = this.database.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
          busy?: number | bigint;
        } | null;
        if (Number(checkpoint?.busy ?? 0) !== 0) {
          throw new Error("SQLite recovery quiescence could not checkpoint the WAL.");
        }
        const journalMode = readText(this.database.query("PRAGMA journal_mode = DELETE").get());
        if (journalMode.toLowerCase() !== "delete") {
          throw new Error("SQLite recovery quiescence could not seal a portable database image.");
        }
      }
      this.closed = true;
      this.database.close();
    });
    this.writerTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  setGrantKeyRing(keyRing: GrantKeyRing): void {
    if (this.unsafeFailure === "corruption") {
      throw new FoundationStorageNotReadyError(this.readinessSync());
    }
    if (
      !this.hasInstalledGrantAdmissionAnchor() &&
      (this.countRows("foundation_grant_admission_telemetry") > 0 ||
        this.countRows("foundation_grant_admission_global_windows") > 0)
    ) {
      throw new Error(
        "Pending schema-17 Grant admission state cannot be keyed after rows were installed.",
      );
    }
    const previousContext = this.grantValidationContext;
    this.grantValidationContext = { ...previousContext, keyRing };
    try {
      this.initializePendingGrantStateAnchors();
    } catch (error) {
      this.grantValidationContext = previousContext;
      throw error;
    }
  }

  grantStorageCapability() {
    return {
      name: "authenticated-grant-storage",
      version: 2,
      implementation: "hmac-anchored-atomic-v2",
      transaction: [
        "findGrantByCodeLookupDigest",
        "readGrantAdmissionTelemetry",
        "readGrantAdmissionGlobalWindow",
        "writeGrantAdmissionTelemetry",
        "writeGrantAdmissionGlobalWindow",
        "pruneGrantAdmissionTelemetry",
        "readGrantAdmissionStateAnchor",
        "writeGrantAdmissionStateAnchor",
      ],
      maintenance: ["pruneGrantAdmissionTelemetry", "writeGrantAdmissionStateAnchor"],
      anchors: ["readGrantAdmissionStateAnchor", "writeGrantAdmissionStateAnchor"],
    } as const;
  }

  eventCatalogStorageCapability() {
    return {
      name: "event-catalog-storage",
      version: 2,
      implementation: "event-catalog-removal-transaction-v2",
      transaction: [
        "findEventTeam",
        "listEventTeams",
        "listRoster",
        "findRosterEntry",
        "findPitch",
        "listPitches",
        "insertEventTeam",
        "updateEventTeam",
        "deleteEventTeam",
        "insertRosterEntry",
        "updateRosterEntry",
        "insertPitch",
        "updatePitch",
        "deletePitch",
        "findGameplaySlot",
        "listGameplaySlots",
        "findPitchSlot",
        "listPitchSlots",
        "findEventGame",
        "listEventGames",
        "insertGameplaySlot",
        "insertPitchSlot",
        "updateGameplaySlot",
        "updatePitchSlot",
        "deleteGameplaySlot",
        "deletePitchSlot",
        "insertEventGame",
        "updateEventGame",
        "deleteEventGame",
      ],
    } as const;
  }

  setGrantValidationContext(context: GrantStateValidationContext): void {
    this.grantValidationContext = { ...this.grantValidationContext, ...context };
  }

  private applyMigrationsSync(): FoundationMigrationReport {
    this.assertOpen();
    const appliedMigrationIds: string[] = [];

    while (true) {
      this.database.exec("BEGIN IMMEDIATE;");
      try {
        this.database.exec(FOUNDATION_MIGRATION_LEDGER_SQL);
        const state = this.readMigrationState();
        const readiness = assessMigrationReadiness(true, state.entries, this.migrations);
        if (readiness.status === "ready") {
          if (appliedMigrationIds.includes("020-grant-codes-and-admission-telemetry")) {
            this.ensureGrantStateAnchors();
          }
          this.database.exec("COMMIT;");
          return {
            appliedMigrationIds,
            schemaVersion: readiness.schemaVersion,
          };
        }

        if (readiness.status !== "missing" && readiness.status !== "pending") {
          throw new FoundationMigrationError(
            "The migration ledger is incompatible with this executable.",
            readiness,
          );
        }

        const nextMigration = this.migrations[state.entries.length];
        if (nextMigration === undefined) {
          throw new FoundationMigrationError(
            "The migration ledger is missing a required migration.",
            readiness,
          );
        }
        this.database
          .query(
            `INSERT INTO foundation_migration_ledger
              (migration_id, ordinal, schema_version, checksum, status, applied_at_ms)
             VALUES (?, ?, ?, ?, 'applying', NULL)`,
          )
          .run(
            nextMigration.id,
            nextMigration.ordinal,
            nextMigration.schemaVersion,
            nextMigration.checksum,
          );
        this.database.exec(nextMigration.sql);
        this.database
          .query(
            `UPDATE foundation_migration_ledger
             SET status = 'complete', applied_at_ms = ?
             WHERE migration_id = ?`,
          )
          .run(Date.now(), nextMigration.id);
        this.database.exec("COMMIT;");
        appliedMigrationIds.push(nextMigration.id);
      } catch (error) {
        this.rollbackQuietly();
        if (error instanceof FoundationMigrationError) {
          throw error;
        }
        throw new FoundationMigrationError("The transactional foundation migration failed.");
      }
    }
  }

  private ensureGrantStateAnchors(): void {
    const grantStatements = this.getGrantStatements();
    const grants = listGrants(grantStatements.allGrants);
    const keyRing = this.grantValidationContext.keyRing;
    if (keyRing !== undefined) {
      for (const grant of grants) {
        writeGrantStateAnchor(grantStatements, grant.grantId, keyRing);
      }
      writeGrantAdmissionStateAnchor(grantStatements, keyRing);
      return;
    }
    for (const grant of grants) {
      const audits = listGrantAudit(grantStatements.auditByGrant, grant.grantId);
      const head = audits.at(-1);
      if (head === undefined) throw new Error("Grant state anchor requires Grant Audit evidence.");
      this.database
        .query(`
          INSERT OR IGNORE INTO foundation_grant_state_anchors
            (grant_id, anchor_version, audit_count, audit_head_id, state_digest, integrity_tag, created_at_ms)
          VALUES (?, 1, ?, ?, 'pending-schema-20-key', 'pending-schema-20-key', ?)
        `)
        .run(grant.grantId, audits.length, head.auditId, grant.createdAtMs);
    }
  }

  private initializePendingGrantStateAnchors(): void {
    if (!this.tableExists("foundation_grant_state_anchors")) return;
    const keyRing = this.grantValidationContext.keyRing;
    if (keyRing === undefined) return;
    const pending = this.database
      .query(
        "SELECT grant_id FROM foundation_grant_state_anchors WHERE integrity_tag = 'pending-schema-20-key'",
      )
      .all() as unknown[];
    const admissionPending = this.database
      .query(
        "SELECT anchor_id FROM foundation_grant_admission_state_anchors WHERE anchor_id = 1 AND integrity_tag = 'pending-schema-20-key'",
      )
      .all() as unknown[];
    if (pending.length === 0 && admissionPending.length === 0) return;
    if (
      admissionPending.length > 0 &&
      (this.countRows("foundation_grant_admission_telemetry") > 0 ||
        this.countRows("foundation_grant_admission_global_windows") > 0)
    ) {
      throw new Error(
        "Pending schema-19 Grant admission state cannot be keyed after rows were installed.",
      );
    }
    const statements = this.getGrantStatements();
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      if (this.tableExists("foundation_grant_migration_provenance_state")) {
        this.refreshGrantMigrationProvenance();
      }
      scanGrantState(this.database, this.grantValidationContext);
      for (const value of pending) {
        const row = asRecord(value);
        writeGrantStateAnchor(statements, readText(row.grant_id), keyRing);
      }
      if (admissionPending.length > 0) writeGrantAdmissionStateAnchor(statements, keyRing);
      this.database.exec("COMMIT;");
    } catch (error) {
      this.rollbackQuietly();
      throw error;
    }
  }

  private hasInstalledGrantAdmissionAnchor(): boolean {
    if (!this.tableExists("foundation_grant_admission_state_anchors")) return false;
    const row = this.database
      .query(
        "SELECT integrity_tag FROM foundation_grant_admission_state_anchors WHERE anchor_id = 1",
      )
      .get() as { integrity_tag?: unknown } | null;
    return row !== null && row.integrity_tag !== "pending-schema-20-key";
  }

  private countRows(table: string): number {
    if (!this.tableExists(table)) return 0;
    const row = this.database.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count?: unknown;
    } | null;
    return typeof row?.count === "number" ? row.count : Number(row?.count ?? 0);
  }

  private createTransaction(): FoundationStorageTransaction {
    const statements = this.getStatements();
    return {
      revision: this.revision,
      listRoots: () =>
        statements.allRoots
          .all()
          .map((value) => readValidatedFoundationRoot(this.database, asRecord(value))),
      findRootByRecordId: (recordId) => this.readRootByStatement(statements.byRecordId, recordId),
      findRootByEventGameId: (eventGameId) =>
        this.readRootByStatement(statements.byEventGameId, eventGameId),
      findRootByPitchSlotId: (pitchSlotId) =>
        this.readRootByStatement(statements.byPitchSlotId, pitchSlotId),
      findRootByGameSideId: (gameSideId) =>
        this.readRootByStatement(statements.byGameSideId, gameSideId),
      insertRoot: (storedRoot) => this.insertRoot(statements, storedRoot),
      updateRoot: (storedRoot) => this.updateRoot(statements, storedRoot),
      findActionByOperationId: (recordId, operationId) =>
        this.readActionByStatement(statements.actionByOperationId, recordId, operationId),
      listActions: (recordId) => this.readActionsByRecordId(statements.actionsByRecordId, recordId),
      listIdempotencyEntries: (recordId) =>
        this.readIdempotencyByRecordId(statements.idempotencyByRecordId, recordId),
      readRecordMetadata: (recordId) => {
        const row = statements.metadataByRecordId.get(recordId) as RootRow | null;
        return row === null ? null : readMetadata(row);
      },
      listAuditEntries: (recordId) =>
        this.readAuditByRecordId(statements.auditByRecordId, recordId),
      findPresentationChangeByOperationId: (recordId, operationId) => {
        const row = statements.presentationChangeByOperationId.get(recordId, operationId);
        return row === null ? null : readPresentationChange(row);
      },
      listPresentationChanges: (recordId) =>
        statements.presentationChangesByRecordId.all(recordId).map(readPresentationChange),
      listPresentationAuditEntries: (recordId) =>
        statements.presentationAuditsByRecordId.all(recordId).map(readPresentationAudit),
      findEvent: (eventId) => readEvent(statements.eventById.get(eventId)),
      listEvents: () =>
        statements.allEvents
          .all()
          .map(readEvent)
          .filter((event): event is StoredEventCatalogEvent => event !== null),
      listGameDays: (eventId) => statements.gameDaysByEventId.all(eventId).map(readGameDay),
      findEventTeam: (eventTeamId) => {
        const row = statements.eventTeamById.get(eventTeamId);
        return row === null ? null : readEventTeam(row);
      },
      listEventTeams: (eventId) => statements.eventTeamsByEventId.all(eventId).map(readEventTeam),
      listRoster: (eventTeamId) => statements.rosterByTeamId.all(eventTeamId).map(readRosterEntry),
      findRosterEntry: (eventTeamId, playerNumber) => {
        const row = statements.rosterEntryByTeamAndNumber.get(eventTeamId, playerNumber);
        return row === null ? null : readRosterEntry(row);
      },
      findPitch: (pitchId) => {
        const row = statements.pitchById.get(pitchId);
        return row === null ? null : readPitch(row);
      },
      listPitches: (eventId) => statements.pitchesByEventId.all(eventId).map(readPitch),
      findGameplaySlot: (gameplaySlotId) => {
        const row = statements.gameplaySlotById.get(gameplaySlotId);
        return row === null ? null : readGameplaySlot(row);
      },
      listGameplaySlots: (gameDayId) =>
        statements.gameplaySlotsByGameDay.all(gameDayId).map(readGameplaySlot),
      findPitchSlot: (pitchSlotId) => {
        const row = statements.pitchSlotById.get(pitchSlotId);
        return row === null ? null : readPitchSlot(row);
      },
      listPitchSlots: (gameDayId, pitchId) =>
        statements.pitchSlotsByGameDay
          .all(gameDayId, pitchId ?? null, pitchId ?? null)
          .map(readPitchSlot),
      findEventGame: (eventGameId) => {
        const row = statements.eventGameById.get(eventGameId);
        return row === null ? null : readEventGame(row);
      },
      listEventGames: (gameDayId) =>
        statements.eventGamesByGameDay.all(gameDayId).map(readEventGame),
      listEventAuditTrail: (eventId) =>
        statements.eventAuditsByEventId.all(eventId).map(readEventAudit),
      insertAction: (storedAction) => this.insertAction(statements, storedAction),
      upsertRecordMetadata: (metadata) => this.upsertRecordMetadata(statements, metadata),
      appendAuditEntry: (entry) => this.appendAuditEntry(statements, entry),
      insertPresentationChange: (change) => this.insertPresentationChange(statements, change),
      appendPresentationAuditEntry: (entry) => this.appendPresentationAuditEntry(statements, entry),
      appendPresentationAuditRevision: (entry) =>
        this.appendPresentationAuditRevision(statements, entry),
      sealPresentationEvidence: (recordId) => this.sealPresentationEvidence(statements, recordId),
      findGrantById: (grantId) =>
        readGrantByStatement(this.getGrantStatements().byGrantId, grantId),
      listGrants: () => listGrants(this.getGrantStatements().allGrants),
      findGrantByCredentialLookupDigest: (lookupDigest) =>
        readGrantByStatement(this.getGrantStatements().byCredentialDigest, lookupDigest),
      findGrantByCodeLookupDigest: (lookupDigest) =>
        readGrantByStatement(this.getGrantStatements().byCodeDigest, lookupDigest),
      findActiveSessionByGrantAndContext: (grantId, browserContextDigest) =>
        readSessionByStatement(
          this.getGrantStatements().activeSessionByContext,
          grantId,
          browserContextDigest,
        ),
      findSessionByBearerVerifier: (bearerLookupVerifier, bearerLookupKeyVersion) =>
        readSessionByStatement(
          this.getGrantStatements().sessionByBearer,
          bearerLookupVerifier,
          bearerLookupKeyVersion,
        ),
      listGrantSessions: (grantId) =>
        listGrantSessions(this.getGrantStatements().sessionsByGrant, grantId),
      listGrantAudit: (grantId) => listGrantAudit(this.getGrantStatements().auditByGrant, grantId),
      findAcceptanceBudget: (bucketId) => readBudget(statements.budgetById.get(bucketId)),
      findReplayReservation: (reservationId) =>
        readReservation(statements.reservationById.get(reservationId)),
      findReplayReservationByTuple: (
        recordId,
        eventGameId,
        originatingSessionId,
        actionCount,
        batchDigest,
      ) =>
        (() => {
          const matches = statements.reservationByTuple.all(
            recordId,
            eventGameId,
            originatingSessionId,
            actionCount,
            batchDigest,
          ) as unknown[];
          return matches.length === 1 ? readReservation(matches[0]) : null;
        })(),
      findReplayReservationByOriginTuple: (
        recordId,
        eventGameId,
        originatingSessionId,
        actionCount,
      ) =>
        readReservation(
          statements.reservationByOriginTuple.get(
            recordId,
            eventGameId,
            originatingSessionId,
            actionCount,
          ),
        ),
      listReplayAttempts: (reservationId) =>
        statements.attemptsByReservation.all(reservationId).map(readAttempt),
      findReplayReceiptByDigest: (receiptDigest) =>
        readReceipt(statements.receiptByDigest.get(receiptDigest)),
      findReplayReceiptByReservationId: (reservationId) =>
        readReceipt(statements.receiptByReservationId.get(reservationId)),
      listAcceptanceIntegrityAnchors: (subjectKind, subjectId) =>
        statements.anchorsBySubject.all(subjectKind, subjectId).map(readIntegrityAnchor),
      readGrantAdmissionTelemetry: (mode, sourceDigest) =>
        readGrantAdmissionTelemetry(
          this.getGrantStatements().telemetryBySource,
          mode,
          sourceDigest,
        ),
      readGrantAdmissionGlobalWindow: (mode) =>
        readGrantAdmissionGlobalWindow(this.getGrantStatements().globalWindowByMode, mode),
      readGrantAdmissionStateAnchor: () =>
        readGrantAdmissionStateAnchor(this.getGrantStatements().admissionStateAnchor),
      insertGrant: (grant) => insertGrant(this.getGrantStatements(), grant),
      updateGrant: (grant) => updateGrant(this.getGrantStatements(), grant),
      insertGrantSession: (session) => insertGrantSession(this.getGrantStatements(), session),
      updateGrantSession: (session) => updateGrantSession(this.getGrantStatements(), session),
      appendGrantAudit: (entry) =>
        appendGrantAudit(this.getGrantStatements(), entry, this.grantValidationContext.keyRing),
      upsertAcceptanceBudget: (budget) =>
        statements.upsertBudget.run(
          budget.bucketId,
          budget.bucketKind,
          budget.subjectId,
          budget.capacity,
          budget.refillPerSecond,
          budget.tokens,
          budget.updatedAtMs,
          budget.stateRevision,
        ),
      insertReplayReservation: (reservation) =>
        statements.insertReservation.run(
          reservation.reservationId,
          reservation.recordId,
          reservation.eventGameId,
          reservation.originatingSessionId,
          reservation.replacementSessionId,
          reservation.actionCount,
          reservation.status,
          reservation.batchDigest,
          reservation.createdAtMs,
          reservation.committedAtMs,
          reservation.acknowledgedAtMs,
          reservation.stateRevision,
        ),
      updateReplayReservation: (reservation) =>
        statements.updateReservation.run(
          reservation.recordId,
          reservation.eventGameId,
          reservation.originatingSessionId,
          reservation.replacementSessionId,
          reservation.actionCount,
          reservation.status,
          reservation.batchDigest,
          reservation.createdAtMs,
          reservation.committedAtMs,
          reservation.acknowledgedAtMs,
          reservation.stateRevision,
          reservation.reservationId,
        ),
      insertReplayAttempt: (attempt) =>
        statements.insertAttempt.run(
          attempt.attemptId,
          attempt.reservationId,
          attempt.operationId,
          attempt.status,
          attempt.actionFingerprint,
          attempt.resultJson,
          attempt.controlAuditId,
          attempt.grantAuditId,
          attempt.createdAtMs,
          attempt.completedAtMs,
          attempt.stateRevision,
        ),
      updateReplayAttempt: (attempt) =>
        statements.updateAttempt.run(
          attempt.reservationId,
          attempt.operationId,
          attempt.status,
          attempt.actionFingerprint,
          attempt.resultJson,
          attempt.controlAuditId,
          attempt.grantAuditId,
          attempt.createdAtMs,
          attempt.completedAtMs,
          attempt.stateRevision,
          attempt.attemptId,
        ),
      discardReplayAttempts: (reservationId) => statements.discardAttempts.run(reservationId),
      discardReplayReservation: (reservationId) => {
        statements.discardAnchors.run(reservationId, `${reservationId}:%`);
        statements.discardAttempts.run(reservationId);
        statements.discardReservation.run(reservationId);
      },
      insertReplayReceipt: (receipt) =>
        statements.insertReceipt.run(
          receipt.receiptId,
          receipt.reservationId,
          receipt.receiptDigest,
          receipt.receiptKeyVersion,
          receipt.status,
          receipt.actionCount,
          receipt.createdAtMs,
          receipt.acknowledgedAtMs,
          receipt.stateRevision,
        ),
      updateReplayReceipt: (receipt) =>
        statements.updateReceipt.run(
          receipt.reservationId,
          receipt.receiptDigest,
          receipt.receiptKeyVersion,
          receipt.status,
          receipt.actionCount,
          receipt.createdAtMs,
          receipt.acknowledgedAtMs,
          receipt.stateRevision,
          receipt.receiptId,
        ),
      insertAcceptanceIntegrityAnchor: (anchor) =>
        statements.insertAnchor.run(
          anchor.anchorId,
          anchor.subjectKind,
          anchor.subjectId,
          anchor.stateRevision,
          anchor.keyVersion,
          anchor.canonicalValue,
          anchor.integrityTag,
        ),
      insertEvent: (event) =>
        statements.insertEvent.run(
          event.eventId,
          event.name,
          event.timeZone,
          event.publicationStatus,
          event.createdAtMs,
          event.updatedAtMs,
        ),
      updateEvent: (event) =>
        statements.updateEvent.run(
          event.name,
          event.timeZone,
          event.publicationStatus,
          event.updatedAtMs,
          event.eventId,
        ),
      deleteEvent: (eventId) => statements.deleteEvent.run(eventId),
      insertGameDay: (gameDay) =>
        statements.insertGameDay.run(
          gameDay.gameDayId,
          gameDay.eventId,
          gameDay.date,
          gameDay.heatStoppageConfiguration,
          gameDay.createdAtMs,
          gameDay.updatedAtMs,
        ),
      updateGameDay: (gameDay) =>
        statements.updateGameDay.run(
          gameDay.eventId,
          gameDay.date,
          gameDay.heatStoppageConfiguration,
          gameDay.updatedAtMs,
          gameDay.gameDayId,
        ),
      deleteGameDay: (gameDayId) => statements.deleteGameDay.run(gameDayId),
      appendEventAudit: (entry) =>
        statements.insertEventAudit.run(
          entry.auditId,
          entry.operationId,
          entry.action,
          entry.eventId,
          entry.gameDayId,
          entry.actorReference,
          entry.occurredAtMs,
          entry.before === null ? null : JSON.stringify(entry.before),
          JSON.stringify(entry.after),
        ),
      insertEventTeam: (team) =>
        statements.insertEventTeam.run(
          team.eventTeamId,
          team.eventId,
          team.name,
          team.defaultColor,
          team.createdAtMs,
          team.updatedAtMs,
        ),
      updateEventTeam: (team) =>
        statements.updateEventTeam.run(
          team.name,
          team.defaultColor,
          team.updatedAtMs,
          team.eventTeamId,
        ),
      deleteEventTeam: (eventTeamId) => statements.deleteEventTeam.run(eventTeamId),
      insertRosterEntry: (entry) =>
        statements.insertRosterEntry.run(
          entry.rosterEntryId,
          entry.eventId,
          entry.eventTeamId,
          entry.playerNumber,
          entry.publicName,
          entry.createdAtMs,
          entry.updatedAtMs,
        ),
      updateRosterEntry: (entry) =>
        statements.updateRosterEntry.run(entry.publicName, entry.updatedAtMs, entry.rosterEntryId),
      insertPitch: (pitch) =>
        statements.insertPitch.run(
          pitch.pitchId,
          pitch.eventId,
          pitch.name,
          pitch.createdAtMs,
          pitch.updatedAtMs,
        ),
      updatePitch: (pitch) =>
        statements.updatePitch.run(pitch.name, pitch.updatedAtMs, pitch.pitchId),
      deletePitch: (pitchId) => statements.deletePitch.run(pitchId),
      insertGameplaySlot: (slot) => {
        assertGameplaySlotMembership(statements, slot);
        statements.insertGameplaySlot.run(
          slot.gameplaySlotId,
          slot.eventId,
          slot.gameDayId,
          slot.sequence,
          slot.scheduledStartMs,
          slot.expectedDelayMs,
          slot.createdAtMs,
          slot.updatedAtMs,
        );
      },
      insertPitchSlot: (slot) => {
        assertPitchSlotMembership(statements, slot);
        statements.insertPitchSlot.run(
          slot.pitchSlotId,
          slot.eventId,
          slot.gameDayId,
          slot.pitchId,
          slot.gameplaySlotId,
          slot.sequence,
          slot.expectedDelayMs,
          slot.createdAtMs,
          slot.updatedAtMs,
        );
      },
      updateGameplaySlot: (slot) => {
        statements.updateGameplaySlot.run(
          slot.expectedDelayMs,
          slot.updatedAtMs,
          slot.gameplaySlotId,
        );
      },
      updatePitchSlot: (slot) => {
        statements.updatePitchSlot.run(slot.expectedDelayMs, slot.updatedAtMs, slot.pitchSlotId);
      },
      deleteGameplaySlot: (gameplaySlotId) => statements.deleteGameplaySlot.run(gameplaySlotId),
      deletePitchSlot: (pitchSlotId) => statements.deletePitchSlot.run(pitchSlotId),
      insertEventGame: (game) => {
        assertEventGameMembership(statements, game);
        statements.insertEventGame.run(
          game.eventGameId,
          game.eventId,
          game.gameDayId,
          game.gameplaySlotId,
          game.pitchSlotId,
          game.gameCode,
          game.gameDesignation,
          game.sideA.sideId,
          game.sideA.eventTeamId,
          game.sideA.eventTeamName,
          game.sideA.sourceLabel,
          game.sideA.confirmedAtMs,
          game.sideB.sideId,
          game.sideB.eventTeamId,
          game.sideB.eventTeamName,
          game.sideB.sourceLabel,
          game.sideB.confirmedAtMs,
          game.createdAtMs,
          game.updatedAtMs,
        );
      },
      updateEventGame: (game) => {
        assertEventGameMembership(statements, game);
        statements.updateEventGame.run(
          game.gameplaySlotId,
          game.pitchSlotId,
          game.gameCode,
          game.gameDesignation,
          game.sideA.sideId,
          game.sideA.eventTeamId,
          game.sideA.eventTeamName,
          game.sideA.sourceLabel,
          game.sideA.confirmedAtMs,
          game.sideB.sideId,
          game.sideB.eventTeamId,
          game.sideB.eventTeamName,
          game.sideB.sourceLabel,
          game.sideB.confirmedAtMs,
          game.updatedAtMs,
          game.eventGameId,
        );
      },
      deleteEventGame: (eventGameId) => statements.deleteEventGame.run(eventGameId),
      writeGrantAdmissionTelemetry: (value) => {
        this.getGrantStatements().upsertTelemetry.run(
          value.mode,
          value.sourceDigest,
          value.failedAttempts,
          value.delayUntilMs,
          value.lastAttemptAtMs,
          value.lastSuccessAtMs,
        );
      },
      writeGrantAdmissionGlobalWindow: (value) => {
        this.getGrantStatements().upsertGlobalWindow.run(
          value.mode,
          value.windowStartedAtMs,
          value.attemptCount,
        );
      },
      pruneGrantAdmissionTelemetry: (beforeMs) =>
        this.getGrantStatements().pruneTelemetry.run(beforeMs),
      writeGrantAdmissionStateAnchor: () => {
        const keyRing = this.grantValidationContext.keyRing;
        if (keyRing === undefined)
          throw new Error("Grant admission anchors require the Grant key ring.");
        writeGrantAdmissionStateAnchor(this.getGrantStatements(), keyRing);
      },
    };
  }

  private insertRoot(statements: RootStatements, storedRoot: StoredEventGameRecordRoot): void {
    const { root } = storedRoot;
    statements.insertRoot.run(
      root.recordId,
      root.eventId,
      root.eventGameId,
      root.ownership.eventId,
      root.ownership.eventGameId,
      root.externalScope.eventId,
      root.externalScope.gameDayId,
      root.externalScope.pitchId,
      root.externalScope.pitchSlotId,
      root.lifecycle.phase,
      root.lifecycle.commencedAtMs,
      root.lifecycle.finishedAtMs,
      root.lifecycle.lockedAtMs,
      root.lifecycle.lockReason,
      root.compatibility.recordVersion,
      root.compatibility.schemaVersion,
      root.compatibility.interpreterVersion,
      root.creationEvidence.operationId,
      root.creationEvidence.actorReference,
      root.creationEvidence.source,
      root.creationEvidence.createdAtMs,
      storedRoot.canonicalContent,
      JSON.stringify(root),
    );
    const [sideA, sideB] = root.gameSides;
    statements.insertSide.run(
      sideA.id,
      root.recordId,
      "a",
      sideA.eventTeamId,
      sideA.teamInterpretationRef,
    );
    statements.insertSide.run(
      sideB.id,
      root.recordId,
      "b",
      sideB.eventTeamId,
      sideB.teamInterpretationRef,
    );
  }

  private updateRoot(statements: RootStatements, storedRoot: StoredEventGameRecordRoot): void {
    const { root } = storedRoot;
    const result = statements.updateRoot.run(
      root.lifecycle.phase,
      root.lifecycle.commencedAtMs,
      root.lifecycle.finishedAtMs,
      root.lifecycle.lockedAtMs,
      root.lifecycle.lockReason,
      storedRoot.canonicalContent,
      JSON.stringify(root),
      root.recordId,
    );
    if (result.changes !== 1) {
      throw new FoundationStorageConstraintError("record-id");
    }
  }

  private insertAction(statements: RootStatements, storedAction: StoredControlAction): void {
    const { action } = storedAction;
    const actionId = actionIdentity(action.recordId, action.operationId);
    statements.insertAction.run(
      actionId,
      action.recordId,
      action.eventGameId,
      action.operationId,
      action.kind.id,
      action.kind.version,
      action.acceptedAtMs,
      storedAction.contentFingerprint,
      storedAction.canonicalContent,
      JSON.stringify(action),
      action.controlActionVersion,
      "current",
    );
    statements.insertEvidenceProvenance.run("action", actionId);
    statements.insertIdempotency.run(
      actionId,
      action.recordId,
      action.operationId,
      storedAction.contentFingerprint,
      action.acceptedAtMs,
    );
  }

  private upsertRecordMetadata(
    statements: RootStatements,
    metadata: StoredEventGameRecordMetadata,
  ): void {
    statements.upsertMetadata.run(
      metadata.recordId,
      metadata.actionCount,
      metadata.orderingVersion,
      metadata.lastAcceptedAtMs,
      metadata.updatedAtMs,
    );
  }

  private appendAuditEntry(statements: RootStatements, entry: StoredControlAuditEntry): void {
    statements.insertAudit.run(
      entry.auditId,
      entry.recordId,
      entry.eventGameId,
      entry.operationId,
      entry.kind,
      entry.outcome,
      entry.createdAtMs,
      entry.redactedDetail ?? "",
      JSON.stringify(entry),
      entry.auditVersion,
      "current",
    );
    statements.insertEvidenceProvenance.run("audit", entry.auditId);
  }

  private insertPresentationChange(
    statements: RootStatements,
    change: StoredGamePresentationChange,
  ): void {
    statements.insertPresentationChange.run(
      change.recordId,
      change.eventGameId,
      change.operationId,
      change.presentationChangeId,
      JSON.stringify(change.change),
      JSON.stringify(change.causalPredecessorIds),
      JSON.stringify(change.occurrence),
      JSON.stringify(change.grant),
      change.acceptedAtMs,
      change.canonicalContent,
      change.contentFingerprint,
    );
  }

  private appendPresentationAuditEntry(
    statements: RootStatements,
    entry: StoredGamePresentationAuditEntry,
  ): void {
    statements.insertPresentationAudit.run(
      entry.auditId,
      entry.recordId,
      entry.eventGameId,
      entry.operationId,
      entry.presentationChangeId,
      entry.kind,
      entry.outcome,
      entry.createdAtMs,
      entry.redactedDetail,
      entry.change === null ? null : JSON.stringify(entry.change),
      entry.grant === null ? null : JSON.stringify(entry.grant),
      entry.supersedesAuditId ?? null,
      JSON.stringify(entry),
    );
  }

  private appendPresentationAuditRevision(
    statements: RootStatements,
    entry: StoredGamePresentationAuditRevision,
  ): void {
    this.appendPresentationAuditEntry(statements, entry);
  }

  private sealPresentationEvidence(statements: RootStatements, recordId: string): void {
    const keyRing = this.grantValidationContext.keyRing;
    if (keyRing === undefined)
      throw new Error("Presentation evidence key material is unavailable.");
    const changes = statements.presentationChangesByRecordId
      .all(recordId)
      .map(readPresentationChange);
    const audits = statements.presentationAuditsByRecordId.all(recordId).map(readPresentationAudit);
    const anchors = statements.presentationIntegrityByRecordId.all(recordId) as Array<
      Record<string, unknown>
    >;
    const anchor = presentationIntegrityAnchorFor(
      { recordId, changes, audits },
      anchors.length + 1,
      keyRing,
    );
    statements.insertPresentationIntegrity.run(
      anchor.recordId,
      anchor.stateRevision,
      anchor.keyVersion,
      anchor.canonicalValue,
      anchor.integrityTag,
    );
  }

  private readRootByStatement(
    statement: SqlStatement,
    ...parameters: string[]
  ): EventGameRecordRoot | null {
    const row = statement.get(...parameters) as RootRow | null;
    if (row === null) return null;
    return readValidatedFoundationRoot(this.database, row);
  }

  private readActionByStatement(
    statement: SqlStatement,
    recordId: string,
    operationId: string,
  ): StoredControlAction | null {
    const row = statement.get(recordId, operationId) as RootRow | null;
    return row === null ? null : readStoredAction(row);
  }

  private readActionsByRecordId(statement: SqlStatement, recordId: string): StoredControlAction[] {
    const rows = statement.all(recordId) as unknown[];
    return rows.map((value) => readStoredAction(asRecord(value)));
  }

  private readIdempotencyByRecordId(
    statement: SqlStatement,
    recordId: string,
  ): StoredControlIdempotencyEntry[] {
    const rows = statement.all(recordId) as unknown[];
    return rows.map((value) => readIdempotency(asRecord(value)));
  }

  private readAuditByRecordId(
    statement: SqlStatement,
    recordId: string,
  ): StoredControlAuditEntry[] {
    const rows = statement.all(recordId) as unknown[];
    return rows.map((value) => readAudit(asRecord(value)));
  }

  private getStatements(): RootStatements {
    if (this.statements !== undefined) return this.statements;
    this.statements = {
      allRoots: this.database.query(
        `SELECT ${ROOT_SELECT_COLUMNS} FROM foundation_event_game_record_roots AS roots ORDER BY roots.record_id`,
      ),
      byRecordId: this.database.query(
        `SELECT ${ROOT_SELECT_COLUMNS} FROM foundation_event_game_record_roots AS roots WHERE roots.record_id = ?`,
      ),
      byEventGameId: this.database.query(
        `SELECT ${ROOT_SELECT_COLUMNS} FROM foundation_event_game_record_roots AS roots WHERE roots.event_game_id = ?`,
      ),
      byPitchSlotId: this.database.query(
        `SELECT ${ROOT_SELECT_COLUMNS} FROM foundation_event_game_record_roots AS roots WHERE roots.pitch_slot_id = ?`,
      ),
      byGameSideId: this.database.query(
        `SELECT ${ROOT_SELECT_COLUMNS}
         FROM foundation_event_game_record_roots AS roots
         INNER JOIN foundation_event_game_record_sides AS sides
           ON sides.record_id = roots.record_id
         WHERE sides.side_id = ?`,
      ),
      insertRoot: this.database.query(`
        INSERT INTO foundation_event_game_record_roots (
          record_id, event_id, event_game_id, owner_event_id, owner_event_game_id,
          scope_event_id, game_day_id, pitch_id, pitch_slot_id,
          lifecycle_phase, commenced_at_ms, finished_at_ms, locked_at_ms, lock_reason,
          record_version, schema_version, interpreter_version,
          creation_operation_id, creation_actor_reference, creation_source,
          creation_created_at_ms, canonical_content, root_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updateRoot: this.database.query(`
        UPDATE foundation_event_game_record_roots
        SET lifecycle_phase = ?, commenced_at_ms = ?, finished_at_ms = ?,
            locked_at_ms = ?, lock_reason = ?, canonical_content = ?, root_json = ?
        WHERE record_id = ?
      `),
      insertSide: this.database.query(`
        INSERT INTO foundation_event_game_record_sides (
          side_id, record_id, side_position, event_team_id, team_interpretation_ref
        ) VALUES (?, ?, ?, ?, ?)
      `),
      actionByOperationId: this.database.query(`
        SELECT action_id, action_json, action_kind, action_version, accepted_at_ms,
               canonical_content, content_fingerprint, control_action_version,
               action_evidence_format,
               (SELECT evidence_format FROM foundation_control_evidence_provenance
                WHERE evidence_kind = 'action' AND evidence_id = foundation_event_game_record_actions.action_id) AS action_provenance_format
        FROM foundation_event_game_record_actions
        WHERE record_id = ? AND operation_id = ?
      `),
      actionsByRecordId: this.database.query(`
        SELECT action_id, action_json, action_kind, action_version, accepted_at_ms,
               canonical_content, content_fingerprint, control_action_version,
               action_evidence_format,
               (SELECT evidence_format FROM foundation_control_evidence_provenance
                WHERE evidence_kind = 'action' AND evidence_id = foundation_event_game_record_actions.action_id) AS action_provenance_format
        FROM foundation_event_game_record_actions
        WHERE record_id = ?
        ORDER BY rowid
      `),
      insertAction: this.database.query(`
        INSERT INTO foundation_event_game_record_actions (
          action_id, record_id, event_game_id, operation_id, action_kind, action_version,
          accepted_at_ms, content_fingerprint, canonical_content, action_json,
          control_action_version, action_evidence_format
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertIdempotency: this.database.query(`
        INSERT INTO foundation_event_game_record_idempotency (
          action_id, record_id, operation_id, content_fingerprint, accepted_at_ms
        ) VALUES (?, ?, ?, ?, ?)
      `),
      metadataByRecordId: this.database.query(`
        SELECT record_id, action_count, ordering_version, last_accepted_at_ms, updated_at_ms
        FROM foundation_event_game_record_metadata
        WHERE record_id = ?
      `),
      upsertMetadata: this.database.query(`
        INSERT INTO foundation_event_game_record_metadata (
          record_id, action_count, ordering_version, last_accepted_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(record_id) DO UPDATE SET
          action_count = excluded.action_count,
          ordering_version = excluded.ordering_version,
          last_accepted_at_ms = excluded.last_accepted_at_ms,
          updated_at_ms = excluded.updated_at_ms
      `),
      auditByRecordId: this.database.query(`
        SELECT audit_id, record_id, event_game_id, operation_id, audit_kind, outcome,
               created_at_ms, redacted_detail, audit_json, audit_version,
               audit_evidence_format,
               (SELECT evidence_format FROM foundation_control_evidence_provenance
                WHERE evidence_kind = 'audit' AND evidence_id = foundation_event_game_record_audit.audit_id) AS audit_provenance_format
        FROM foundation_event_game_record_audit
        WHERE record_id = ?
        ORDER BY rowid
      `),
      idempotencyByRecordId: this.database.query(`
        SELECT action_id, record_id, operation_id, content_fingerprint, accepted_at_ms
        FROM foundation_event_game_record_idempotency
        WHERE record_id = ?
        ORDER BY rowid
      `),
      insertAudit: this.database.query(`
        INSERT INTO foundation_event_game_record_audit (
          audit_id, record_id, event_game_id, operation_id, audit_kind, outcome,
               created_at_ms, redacted_detail, audit_json, audit_version,
               audit_evidence_format
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      presentationChangeByOperationId: this.database.query(`
        SELECT record_id, event_game_id, operation_id, presentation_change_id,
               change_json, causal_predecessor_ids_json, occurrence_json, grant_json,
               accepted_at_ms, canonical_content, content_fingerprint
        FROM foundation_event_game_presentation_changes
        WHERE record_id = ? AND operation_id = ?
      `),
      presentationChangesByRecordId: this.database.query(`
        SELECT record_id, event_game_id, operation_id, presentation_change_id,
               change_json, causal_predecessor_ids_json, occurrence_json, grant_json,
               accepted_at_ms, canonical_content, content_fingerprint
        FROM foundation_event_game_presentation_changes
        WHERE record_id = ? ORDER BY rowid
      `),
      insertPresentationChange: this.database.query(`
        INSERT INTO foundation_event_game_presentation_changes (
          record_id, event_game_id, operation_id, presentation_change_id, change_json,
          causal_predecessor_ids_json, occurrence_json, grant_json, accepted_at_ms,
          canonical_content, content_fingerprint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      presentationAuditsByRecordId: this.database.query(`
        SELECT audit_json, supersedes_audit_id
        FROM foundation_event_game_presentation_audit
        WHERE record_id = ? ORDER BY rowid
      `),
      insertPresentationAudit: this.database.query(`
        INSERT INTO foundation_event_game_presentation_audit (
          audit_id, record_id, event_game_id, operation_id, presentation_change_id,
          audit_kind, outcome, created_at_ms, redacted_detail, change_json, grant_json,
          supersedes_audit_id, audit_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      presentationIntegrityByRecordId: this.database.query(`
        SELECT record_id, state_revision, key_version, canonical_value, integrity_tag
        FROM foundation_event_game_presentation_integrity
        WHERE record_id = ? ORDER BY state_revision
      `),
      insertPresentationIntegrity: this.database.query(`
        INSERT INTO foundation_event_game_presentation_integrity
          (record_id, state_revision, key_version, canonical_value, integrity_tag)
        VALUES (?, ?, ?, ?, ?)
      `),
      insertEvidenceProvenance: this.database.query(`
        INSERT INTO foundation_control_evidence_provenance
          (evidence_kind, evidence_id, evidence_format, origin)
        VALUES (?, ?, 'current', 'post-75-current')
      `),
      eventById: this.database.query(`
        SELECT event_id AS eventId, name, time_zone AS timeZone,
               publication_status AS publicationStatus, created_at_ms AS createdAtMs,
               updated_at_ms AS updatedAtMs
        FROM foundation_event_catalog_events WHERE event_id = ?
      `),
      allEvents: this.database.query(`
        SELECT event_id AS eventId, name, time_zone AS timeZone,
               publication_status AS publicationStatus, created_at_ms AS createdAtMs,
               updated_at_ms AS updatedAtMs
        FROM foundation_event_catalog_events ORDER BY event_id
      `),
      gameDaysByEventId: this.database.query(`
        SELECT game_day_id AS gameDayId, event_id AS eventId, game_day_date AS date,
               heat_stoppage_configuration AS heatStoppageConfiguration,
               created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
        FROM foundation_event_catalog_game_days
        WHERE event_id = ? ORDER BY game_day_date, game_day_id
      `),
      eventTeamById: this.database.query(`
        SELECT event_team_id AS eventTeamId, event_id AS eventId, name,
               default_color AS defaultColor, created_at_ms AS createdAtMs,
               updated_at_ms AS updatedAtMs
        FROM foundation_event_catalog_teams WHERE event_team_id = ?
      `),
      eventTeamsByEventId: this.database.query(`
        SELECT event_team_id AS eventTeamId, event_id AS eventId, name,
               default_color AS defaultColor, created_at_ms AS createdAtMs,
               updated_at_ms AS updatedAtMs
        FROM foundation_event_catalog_teams WHERE event_id = ?
        ORDER BY event_team_id
      `),
      rosterByTeamId: this.database.query(`
        SELECT roster_entry_id AS rosterEntryId, event_id AS eventId,
               event_team_id AS eventTeamId, player_number AS playerNumber,
               public_name AS publicName, created_at_ms AS createdAtMs,
               updated_at_ms AS updatedAtMs
        FROM foundation_event_catalog_roster WHERE event_team_id = ?
        ORDER BY player_number
      `),
      rosterEntryByTeamAndNumber: this.database.query(`
        SELECT roster_entry_id AS rosterEntryId, event_id AS eventId,
               event_team_id AS eventTeamId, player_number AS playerNumber,
               public_name AS publicName, created_at_ms AS createdAtMs,
               updated_at_ms AS updatedAtMs
        FROM foundation_event_catalog_roster
        WHERE event_team_id = ? AND player_number = ?
      `),
      pitchById: this.database.query(`
        SELECT pitch_id AS pitchId, event_id AS eventId, name,
               created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
        FROM foundation_event_catalog_pitches WHERE pitch_id = ?
      `),
      pitchesByEventId: this.database.query(`
        SELECT pitch_id AS pitchId, event_id AS eventId, name,
               created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
        FROM foundation_event_catalog_pitches WHERE event_id = ?
        ORDER BY pitch_id
      `),
      gameplaySlotById: this.database.query(`
        SELECT gameplay_slot_id AS gameplaySlotId, event_id AS eventId, game_day_id AS gameDayId,
               sequence_number AS sequence, scheduled_start_ms AS scheduledStartMs,
               expected_delay_ms AS expectedDelayMs,
               created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
        FROM foundation_event_catalog_gameplay_slots WHERE gameplay_slot_id = ?
      `),
      gameplaySlotsByGameDay: this.database.query(`
        SELECT gameplay_slot_id AS gameplaySlotId, event_id AS eventId, game_day_id AS gameDayId,
               sequence_number AS sequence, scheduled_start_ms AS scheduledStartMs,
               expected_delay_ms AS expectedDelayMs,
               created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
        FROM foundation_event_catalog_gameplay_slots WHERE game_day_id = ?
        ORDER BY sequence_number, gameplay_slot_id
      `),
      pitchSlotById: this.database.query(`
        SELECT pitch_slot_id AS pitchSlotId, event_id AS eventId, game_day_id AS gameDayId,
               pitch_id AS pitchId, gameplay_slot_id AS gameplaySlotId, sequence_number AS sequence,
               expected_delay_ms AS expectedDelayMs,
               created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
        FROM foundation_event_catalog_pitch_slots WHERE pitch_slot_id = ?
      `),
      pitchSlotsByGameDay: this.database.query(`
        SELECT pitch_slot_id AS pitchSlotId, event_id AS eventId, game_day_id AS gameDayId,
               pitch_id AS pitchId, gameplay_slot_id AS gameplaySlotId, sequence_number AS sequence,
               expected_delay_ms AS expectedDelayMs,
               created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
        FROM foundation_event_catalog_pitch_slots
        WHERE game_day_id = ? AND (? IS NULL OR pitch_id = ?)
        ORDER BY pitch_id, sequence_number, pitch_slot_id
      `),
      eventGameById: this.database.query(`
        SELECT event_game_id AS eventGameId, event_id AS eventId, game_day_id AS gameDayId,
               gameplay_slot_id AS gameplaySlotId, pitch_slot_id AS pitchSlotId,
               game_code AS gameCode, game_designation AS gameDesignation,
               side_a_id AS aSideId, side_a_event_team_id AS aEventTeamId,
               side_a_event_team_name AS aEventTeamName, side_a_source_label AS aSourceLabel,
               side_a_confirmed_at_ms AS aConfirmedAtMs,
               side_b_id AS bSideId, side_b_event_team_id AS bEventTeamId,
               side_b_event_team_name AS bEventTeamName, side_b_source_label AS bSourceLabel,
               side_b_confirmed_at_ms AS bConfirmedAtMs,
               created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
        FROM foundation_event_catalog_games WHERE event_game_id = ?
      `),
      eventGamesByGameDay: this.database.query(`
        SELECT event_game_id AS eventGameId, event_id AS eventId, game_day_id AS gameDayId,
               gameplay_slot_id AS gameplaySlotId, pitch_slot_id AS pitchSlotId,
               game_code AS gameCode, game_designation AS gameDesignation,
               side_a_id AS aSideId, side_a_event_team_id AS aEventTeamId,
               side_a_event_team_name AS aEventTeamName, side_a_source_label AS aSourceLabel,
               side_a_confirmed_at_ms AS aConfirmedAtMs,
               side_b_id AS bSideId, side_b_event_team_id AS bEventTeamId,
               side_b_event_team_name AS bEventTeamName, side_b_source_label AS bSourceLabel,
               side_b_confirmed_at_ms AS bConfirmedAtMs,
               created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
        FROM foundation_event_catalog_games WHERE game_day_id = ?
        ORDER BY event_game_id
      `),
      eventAuditsByEventId: this.database.query(`
        SELECT audit_id AS auditId, operation_id AS operationId, action,
               event_id AS eventId, game_day_id AS gameDayId,
               actor_reference AS actorReference, occurred_at_ms AS occurredAtMs,
               before_json AS beforeJson, after_json AS afterJson
        FROM foundation_event_catalog_audit
        WHERE event_id = ? ORDER BY occurred_at_ms, audit_id
      `),
      insertEvent: this.database.query(`
        INSERT INTO foundation_event_catalog_events
          (event_id, name, time_zone, publication_status, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      updateEvent: this.database.query(`
        UPDATE foundation_event_catalog_events
        SET name = ?, time_zone = ?, publication_status = ?, updated_at_ms = ?
        WHERE event_id = ?
      `),
      deleteEvent: this.database.query(
        `DELETE FROM foundation_event_catalog_events WHERE event_id = ?`,
      ),
      insertGameDay: this.database.query(`
        INSERT INTO foundation_event_catalog_game_days
          (game_day_id, event_id, game_day_date, heat_stoppage_configuration, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      updateGameDay: this.database.query(`
        UPDATE foundation_event_catalog_game_days
        SET event_id = ?, game_day_date = ?, heat_stoppage_configuration = ?, updated_at_ms = ?
        WHERE game_day_id = ?
      `),
      deleteGameDay: this.database.query(
        `DELETE FROM foundation_event_catalog_game_days WHERE game_day_id = ?`,
      ),
      insertEventAudit: this.database.query(`
        INSERT INTO foundation_event_catalog_audit
          (audit_id, operation_id, action, event_id, game_day_id, actor_reference,
           occurred_at_ms, before_json, after_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertEventTeam: this.database.query(`
        INSERT INTO foundation_event_catalog_teams
          (event_team_id, event_id, name, default_color, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      updateEventTeam: this.database.query(`
        UPDATE foundation_event_catalog_teams
        SET name = ?, default_color = ?, updated_at_ms = ?
        WHERE event_team_id = ?
      `),
      deleteEventTeam: this.database.query(
        `DELETE FROM foundation_event_catalog_teams WHERE event_team_id = ?`,
      ),
      insertRosterEntry: this.database.query(`
        INSERT INTO foundation_event_catalog_roster
          (roster_entry_id, event_id, event_team_id, player_number, public_name, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
      updateRosterEntry: this.database.query(`
        UPDATE foundation_event_catalog_roster
        SET public_name = ?, updated_at_ms = ?
        WHERE roster_entry_id = ?
      `),
      insertPitch: this.database.query(`
        INSERT INTO foundation_event_catalog_pitches
          (pitch_id, event_id, name, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?)
      `),
      updatePitch: this.database.query(`
        UPDATE foundation_event_catalog_pitches
        SET name = ?, updated_at_ms = ?
        WHERE pitch_id = ?
      `),
      deletePitch: this.database.query(
        `DELETE FROM foundation_event_catalog_pitches WHERE pitch_id = ?`,
      ),
      insertGameplaySlot: this.database.query(`
        INSERT INTO foundation_event_catalog_gameplay_slots
          (gameplay_slot_id, event_id, game_day_id, sequence_number, scheduled_start_ms, expected_delay_ms, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertPitchSlot: this.database.query(`
        INSERT INTO foundation_event_catalog_pitch_slots
          (pitch_slot_id, event_id, game_day_id, pitch_id, gameplay_slot_id, sequence_number, expected_delay_ms, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updateGameplaySlot: this.database.query(`
        UPDATE foundation_event_catalog_gameplay_slots SET expected_delay_ms = ?, updated_at_ms = ?
        WHERE gameplay_slot_id = ?
      `),
      updatePitchSlot: this.database.query(`
        UPDATE foundation_event_catalog_pitch_slots SET expected_delay_ms = ?, updated_at_ms = ?
        WHERE pitch_slot_id = ?
      `),
      deleteGameplaySlot: this.database.query(
        `DELETE FROM foundation_event_catalog_gameplay_slots WHERE gameplay_slot_id = ?`,
      ),
      deletePitchSlot: this.database.query(
        `DELETE FROM foundation_event_catalog_pitch_slots WHERE pitch_slot_id = ?`,
      ),
      insertEventGame: this.database.query(`
        INSERT INTO foundation_event_catalog_games
          (event_game_id, event_id, game_day_id, gameplay_slot_id, pitch_slot_id,
           game_code, game_designation, side_a_id, side_a_event_team_id, side_a_event_team_name,
           side_a_source_label, side_a_confirmed_at_ms, side_b_id, side_b_event_team_id,
           side_b_event_team_name, side_b_source_label, side_b_confirmed_at_ms, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updateEventGame: this.database.query(`
        UPDATE foundation_event_catalog_games SET
          gameplay_slot_id = ?, pitch_slot_id = ?, game_code = ?, game_designation = ?, side_a_id = ?, side_a_event_team_id = ?,
          side_a_event_team_name = ?, side_a_source_label = ?, side_a_confirmed_at_ms = ?, side_b_id = ?,
          side_b_event_team_id = ?, side_b_event_team_name = ?, side_b_source_label = ?, side_b_confirmed_at_ms = ?,
          updated_at_ms = ? WHERE event_game_id = ?
      `),
      deleteEventGame: this.database.query(
        `DELETE FROM foundation_event_catalog_games WHERE event_game_id = ?`,
      ),
      budgetById: this.database.query(
        `SELECT * FROM foundation_acceptance_budgets WHERE bucket_id = ?`,
      ),
      upsertBudget: this.database.query(`
        INSERT INTO foundation_acceptance_budgets
          (bucket_id, bucket_kind, subject_id, capacity, refill_per_second, tokens, updated_at_ms, state_revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(bucket_id) DO UPDATE SET
          bucket_kind = excluded.bucket_kind, subject_id = excluded.subject_id,
          capacity = excluded.capacity, refill_per_second = excluded.refill_per_second,
          tokens = excluded.tokens, updated_at_ms = excluded.updated_at_ms,
          state_revision = excluded.state_revision
      `),
      reservationById: this.database.query(
        `SELECT * FROM foundation_replay_reservations WHERE reservation_id = ?`,
      ),
      reservationByTuple: this.database.query(
        `SELECT * FROM foundation_replay_reservations
         WHERE record_id = ? AND event_game_id = ? AND originating_session_id = ? AND action_count = ?
           AND batch_digest = ?
         ORDER BY state_revision DESC LIMIT 2`,
      ),
      reservationByOriginTuple: this.database.query(
        `SELECT * FROM foundation_replay_reservations
         WHERE record_id = ? AND event_game_id = ? AND originating_session_id = ? AND action_count = ?
         ORDER BY state_revision DESC LIMIT 1`,
      ),
      insertReservation: this.database.query(`
        INSERT INTO foundation_replay_reservations
          (reservation_id, record_id, event_game_id, originating_session_id, replacement_session_id,
           action_count, status, batch_digest, created_at_ms, committed_at_ms, acknowledged_at_ms, state_revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updateReservation: this.database.query(`
        UPDATE foundation_replay_reservations SET record_id = ?, event_game_id = ?,
          originating_session_id = ?, replacement_session_id = ?, action_count = ?, status = ?,
          batch_digest = ?, created_at_ms = ?, committed_at_ms = ?, acknowledged_at_ms = ?, state_revision = ?
        WHERE reservation_id = ?
      `),
      attemptsByReservation: this.database.query(
        `SELECT * FROM foundation_replay_attempts WHERE reservation_id = ? ORDER BY attempt_id`,
      ),
      insertAttempt: this.database.query(`
        INSERT INTO foundation_replay_attempts
          (attempt_id, reservation_id, operation_id, status, action_fingerprint, result_json,
           control_audit_id, grant_audit_id, created_at_ms, completed_at_ms, state_revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updateAttempt: this.database.query(`
        UPDATE foundation_replay_attempts SET reservation_id = ?, operation_id = ?, status = ?,
          action_fingerprint = ?, result_json = ?, control_audit_id = ?, grant_audit_id = ?,
          created_at_ms = ?, completed_at_ms = ?, state_revision = ? WHERE attempt_id = ?
      `),
      discardAttempts: this.database.query(
        `DELETE FROM foundation_replay_attempts WHERE reservation_id = ?`,
      ),
      discardAnchors: this.database.query(
        `DELETE FROM foundation_acceptance_integrity_anchors
         WHERE (subject_kind = 'reservation' AND subject_id = ?)
            OR (subject_kind = 'attempt' AND subject_id LIKE ?)`,
      ),
      discardReservation: this.database.query(
        `DELETE FROM foundation_replay_reservations WHERE reservation_id = ?`,
      ),
      receiptByDigest: this.database.query(
        `SELECT * FROM foundation_replay_receipts WHERE receipt_digest = ?`,
      ),
      receiptByReservationId: this.database.query(
        `SELECT * FROM foundation_replay_receipts WHERE reservation_id = ?`,
      ),
      anchorsBySubject: this.database.query(
        `SELECT * FROM foundation_acceptance_integrity_anchors
         WHERE subject_kind = ? AND subject_id = ? ORDER BY state_revision`,
      ),
      insertReceipt: this.database.query(`
        INSERT INTO foundation_replay_receipts
          (receipt_id, reservation_id, receipt_digest, receipt_key_version, status, action_count, created_at_ms, acknowledged_at_ms, state_revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updateReceipt: this.database.query(`
        UPDATE foundation_replay_receipts SET reservation_id = ?, receipt_digest = ?, receipt_key_version = ?, status = ?,
          action_count = ?, created_at_ms = ?, acknowledged_at_ms = ?, state_revision = ? WHERE receipt_id = ?
      `),
      insertAnchor: this.database.query(`
        INSERT INTO foundation_acceptance_integrity_anchors
          (anchor_id, subject_kind, subject_id, state_revision, key_version, canonical_value, integrity_tag)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
    };
    return this.statements;
  }

  private getGrantStatements(): GrantSqliteStatements {
    if (this.grantStatements !== undefined) return this.grantStatements;
    this.grantStatements = createGrantSqliteStatements(this.database);
    return this.grantStatements;
  }

  private readMigrationState(): { ledgerExists: boolean; entries: MigrationLedgerEntry[] } {
    const ledgerExists = this.tableExists("foundation_migration_ledger");
    if (!ledgerExists) return { ledgerExists: false, entries: [] };

    const entries = this.database
      .query(
        "SELECT migration_id, ordinal, schema_version, checksum, status FROM foundation_migration_ledger ORDER BY ordinal",
      )
      .all() as unknown[];
    return {
      ledgerExists: true,
      entries: entries.map((entry) => {
        const row = asRecord(entry);
        return {
          id: readText(row.migration_id),
          ordinal: readInteger(row.ordinal),
          schemaVersion: readInteger(row.schema_version),
          checksum: readText(row.checksum),
          status: readText(row.status) === "complete" ? "complete" : "applying",
        };
      }),
    };
  }

  private readinessSync(probeWriteability = false): FoundationStorageReadiness {
    const evidence = this.baseEvidence();
    try {
      this.assertOpen();
      if (this.unsafeFailure === "corruption") {
        evidence.transaction.writePressure = "unsafe";
        evidence.sqlite.failureCategory = "corruption";
        return {
          ok: false,
          status: this.quarantinePersistenceFailure ? "quarantine-failure" : "integrity-failure",
          detail: this.quarantinePersistenceFailure
            ? "SQLite corruption quarantine could not be durably persisted."
            : "SQLite durable authority is frozen after suspected corruption.",
          storage: "sqlite",
          evidence,
        };
      }
      if (this.unsafeFailure !== undefined && !probeWriteability) {
        evidence.transaction.writePressure = "unsafe";
        evidence.sqlite.failureCategory = this.unsafeFailure;
        return {
          ok: false,
          status: "not-writeable",
          detail: "SQLite durable authority is paused until a writeability proof succeeds.",
          storage: "sqlite",
          evidence,
        };
      }
      const settings = this.readSettings();
      evidence.sqlite.journalMode =
        settings.journalMode.toLowerCase() === "wal" ? "wal" : "unknown";
      evidence.sqlite.synchronous = settings.synchronous;
      evidence.sqlite.foreignKeys = settings.foreignKeys === 1;
      if (
        settings.journalMode.toLowerCase() !== "wal" ||
        (!this.readOnly && (settings.synchronous !== 2 || settings.foreignKeys !== 1))
      ) {
        evidence.transaction.writePressure = "unsafe";
        return {
          ok: false,
          status: "unsafe-settings",
          detail: "SQLite did not report the required WAL, FULL, and foreign-key settings.",
          storage: "sqlite",
          evidence,
        };
      }

      const migrationState = this.readMigrationState();
      const migrationReadiness = assessMigrationReadiness(
        migrationState.ledgerExists,
        migrationState.entries,
        this.migrations,
      );
      evidence.migration.state = migrationReadiness.status === "ready" ? "ready" : "unsafe";
      evidence.migration.schemaVersion = String(migrationReadiness.schemaVersion);
      evidence.migration.appliedCount = boundedMetric(migrationState.entries.length);
      if (migrationReadiness.status !== "ready") {
        return {
          ok: false,
          status: migrationReadiness.status,
          detail: migrationReadiness.detail,
          storage: "sqlite",
          evidence,
        };
      }
      if (
        migrationReadiness.schemaVersion >= 6 &&
        this.migrations.some((migration) => migration.id === "006-grant-cryptographic-erasure")
      )
        this.refreshGrantMigrationProvenance();
      this.updateKeyEvidence(evidence);
      const schemaVerification = verifyFoundationSchema(this.database, this.grantValidationContext);
      if (!schemaVerification.ok) {
        return { ...schemaVerification, storage: "sqlite", evidence };
      }
      const presentationFailure = this.verifyPresentationEvidence();
      if (presentationFailure !== null) {
        return {
          ok: false,
          status: "integrity-failure",
          detail: presentationFailure,
          storage: "sqlite",
          evidence,
        };
      }
      const idempotencyFailure = this.verifyIdempotencyParity();
      if (idempotencyFailure !== null) {
        return {
          ok: false,
          status: "integrity-failure",
          detail: idempotencyFailure,
          storage: "sqlite",
          evidence,
        };
      }
      const rootCount = this.countRows("foundation_event_game_record_roots");
      const actionCount = this.countRows("foundation_event_game_record_actions");
      if (
        this.requireReplayContext &&
        this.readinessContext === undefined &&
        (rootCount > 0 || actionCount > 0)
      ) {
        evidence.replay.rootCount = boundedMetric(rootCount);
        evidence.replay.actionCount = boundedMetric(actionCount);
        evidence.replay.result = "not-configured";
        evidence.transaction.writePressure = "unsafe";
        return {
          ok: false,
          status: "integrity-failure",
          detail: "Event Game replay context is not installed at the authoritative boundary.",
          storage: "sqlite",
          evidence,
        };
      }
      if (this.readinessContext !== undefined) {
        const replayFailure = this.verifyRegisteredReplay(evidence, this.readinessContext);
        if (replayFailure !== null)
          return {
            ok: false,
            status: "integrity-failure",
            detail: replayFailure,
            storage: "sqlite",
            evidence,
          };
      }
      if (probeWriteability) {
        this.probeWriteability(evidence);
        this.unsafeFailure = undefined;
        evidence.sqlite.failureCategory = null;
      }
      evidence.transaction.writePressure = "normal";
      return {
        ok: true,
        schemaVersion: String(migrationReadiness.schemaVersion),
        storage: "sqlite",
        evidence,
      };
    } catch (error) {
      const category = classifySqliteFailure(error, "readiness");
      if (category !== null) {
        if (category === "corruption") this.latchCorruption();
        else this.unsafeFailure = category;
        this.rejectionCount = boundedMetric(this.rejectionCount + 1);
        this.rejectionCategories[category] = boundedMetric(this.rejectionCategories[category] + 1);
        evidence.transaction.rejectionCount = this.rejectionCount;
        evidence.transaction.rejectionCategories = { ...this.rejectionCategories };
        evidence.transaction.writePressure = "unsafe";
        evidence.sqlite.failureCategory = category;
        return {
          ok: false,
          status:
            category === "corruption"
              ? this.quarantinePersistenceFailure
                ? "quarantine-failure"
                : "integrity-failure"
              : "not-writeable",
          detail:
            category === "corruption" && this.quarantinePersistenceFailure
              ? "SQLite corruption quarantine could not be durably persisted."
              : "SQLite durable authority is paused after a storage failure.",
          storage: "sqlite",
          evidence,
        };
      }
      if (error instanceof FoundationStorageClosedError) {
        return {
          ok: false,
          status: "closed",
          detail: "SQLite foundation storage is closed.",
          storage: "sqlite",
          evidence,
        };
      }
      evidence.transaction.writePressure = "unsafe";
      return {
        ok: false,
        status: "integrity-failure",
        detail: "SQLite readiness verification failed.",
        storage: "sqlite",
        evidence,
      };
    }
  }

  private readSettings(): SqliteFoundationSettings {
    return {
      journalMode: readText(this.database.query("PRAGMA journal_mode").get()),
      synchronous: readInteger(this.database.query("PRAGMA synchronous").get()),
      foreignKeys: readInteger(this.database.query("PRAGMA foreign_keys").get()),
      busyTimeoutMs: readInteger(this.database.query("PRAGMA busy_timeout").get()),
    };
  }

  private baseEvidence(): FoundationStorageEvidence {
    const databaseBytes = safeFileSize(this.databasePath);
    const walBytes = safeFileSize(`${this.databasePath}-wal`);
    return {
      runtime: {
        engine: "bun",
        version: boundedText(Bun.version),
        sqliteVersion: safeSqliteVersion(this.database),
      },
      transaction: {
        lastLatencyMs: this.lastTransactionLatencyMs,
        rejectionCount: this.rejectionCount,
        rejectionCategories: { ...this.rejectionCategories },
        writePressure: "unknown",
      },
      sqlite: {
        journalMode: "unknown",
        synchronous: null,
        foreignKeys: null,
        walBytes,
        checkpoint: "not-attempted",
        diskBytes: databaseBytes,
        diskFreeBytes: safeFreeBytes(this.databasePath),
        failureCategory: this.unsafeFailure ?? null,
      },
      migration: { state: "unknown", schemaVersion: null, appliedCount: null },
      keys: {
        requiredCount: 0,
        availableCount: 0,
        missingCount: 0,
        requiredCategories: emptyKeyCounts(),
        availableCategories: emptyKeyCounts(),
        missingCategories: emptyKeyCounts(),
      },
      replay: {
        result: this.readinessContext === undefined ? "not-configured" : "failed",
        rootCount: 0,
        actionCount: 0,
        durationMs: null,
      },
    };
  }

  private probeWriteability(evidence: FoundationStorageEvidence): void {
    const startedAt = Date.now();
    const originalUserVersion = readInteger(
      (this.database.query("PRAGMA user_version").get() as RootRow).user_version,
    );
    let transactionStarted = false;
    try {
      this.faultInjector?.("begin");
      this.database.exec("BEGIN IMMEDIATE;");
      transactionStarted = true;
      this.faultInjector?.("readiness-write-probe");
      this.database.exec(`PRAGMA user_version = ${originalUserVersion + 1};`);
      this.database.exec(`PRAGMA user_version = ${originalUserVersion};`);
      this.faultInjector?.("before-commit");
      this.faultInjector?.("commit");
      this.database.exec("COMMIT;");
      transactionStarted = false;
      this.faultInjector?.("after-commit");
      const verifiedUserVersion = readInteger(
        (this.database.query("PRAGMA user_version").get() as RootRow).user_version,
      );
      if (verifiedUserVersion !== originalUserVersion)
        throw new SqliteFoundationFault("corruption");
    } catch (error) {
      if (transactionStarted) this.rollbackQuietly();
      throw error;
    }
    evidence.transaction.lastLatencyMs = boundedMetric(Date.now() - startedAt);
    try {
      const row = this.database.query("PRAGMA wal_checkpoint(PASSIVE)").get() as Record<
        string,
        unknown
      > | null;
      const busy = readInteger(row?.busy ?? 0);
      evidence.sqlite.checkpoint = busy === 0 ? "ok" : "busy";
      if (busy !== 0) throw new SqliteFoundationFault("busy");
    } catch (error) {
      if (error instanceof SqliteFoundationFault) throw error;
      evidence.sqlite.checkpoint = "failed";
      throw new SqliteFoundationFault("io-error");
    }
  }

  private updateKeyEvidence(evidence: FoundationStorageEvidence): void {
    const keyRing = this.grantValidationContext.keyRing;
    const required = new Set<string>();
    const requiredCategories = emptyKeyCounts();
    const addRequired = (category: FoundationStorageKeyCategory, version: string | null): void => {
      if (
        typeof version !== "string" ||
        version.length === 0 ||
        version.length > 64 ||
        !/^[A-Za-z0-9._-]+$/.test(version)
      )
        return;
      const key = `${category}:${version}`;
      if (required.has(key)) return;
      required.add(key);
      requiredCategories[category] += 1;
    };
    for (const grant of listGrants(this.getGrantStatements().allGrants)) {
      if (grant.credential.materialState === "present") {
        addRequired("encryption", grant.credential.encryptionKeyVersion);
        addRequired("lookup", grant.credential.lookupKeyVersion);
      }
      if (grant.code !== null && grant.code !== undefined && grant.code.state !== "erased") {
        addRequired("encryption", grant.code.encryptionKeyVersion);
        addRequired("audit", grant.code.lookupKeyVersion);
      }
      for (const session of listGrantSessions(
        this.getGrantStatements().sessionsByGrant,
        grant.grantId,
      )) {
        addRequired("lookup", session.browserContextKeyVersion);
        if (session.bearerMaterialState === "present")
          addRequired("lookup", session.bearerLookupKeyVersion);
      }
    }
    for (const row of this.database
      .query("SELECT audit_integrity_tag FROM foundation_grant_audit")
      .all() as unknown[]) {
      addRequired("audit", extractIntegrityKeyVersion(asRecord(row).audit_integrity_tag));
    }
    for (const row of this.database
      .query("SELECT integrity_tag FROM foundation_grant_state_anchors")
      .all() as unknown[]) {
      addRequired("audit", extractIntegrityKeyVersion(asRecord(row).integrity_tag));
    }
    for (const row of this.database
      .query("SELECT integrity_tag FROM foundation_grant_admission_state_anchors")
      .all() as unknown[]) {
      addRequired("audit", extractIntegrityKeyVersion(asRecord(row).integrity_tag));
    }
    for (const row of this.database
      .query("SELECT key_version FROM foundation_acceptance_integrity_anchors")
      .all() as unknown[]) {
      addRequired("audit", readNullableTextValue(asRecord(row).key_version));
    }
    for (const row of this.database
      .query("SELECT receipt_key_version FROM foundation_replay_receipts")
      .all() as unknown[]) {
      addRequired("audit", readNullableTextValue(asRecord(row).receipt_key_version));
    }
    const availableCategories = emptyKeyCounts();
    const available = [...required].filter((key) => {
      const [category, version] = key.split(":") as [
        FoundationStorageKeyCategory,
        string | undefined,
      ];
      if (version === undefined) return false;
      const available = keyRing !== undefined && keyRing[category].keys.has(version);
      if (available) availableCategories[category] += 1;
      return available;
    }).length;
    const missingCategories = emptyKeyCounts();
    for (const category of KEY_CATEGORIES) {
      missingCategories[category] = requiredCategories[category] - availableCategories[category];
    }
    evidence.keys = {
      requiredCount: boundedMetric(required.size),
      availableCount: boundedMetric(available),
      missingCount: boundedMetric(required.size - available),
      requiredCategories,
      availableCategories,
      missingCategories,
    };
  }

  private verifyRegisteredReplay(
    evidence: FoundationStorageEvidence,
    context: FoundationStorageReadinessContext,
  ): string | null {
    const startedAt = Date.now();
    try {
      const rows = this.getStatements().allRoots.all() as unknown[];
      evidence.replay.rootCount = boundedMetric(rows.length);
      for (const value of rows) {
        const row = asRecord(value);
        const root = readValidatedFoundationRoot(this.database, row);
        const actions = this.readActionsByRecordId(
          this.getStatements().actionsByRecordId,
          root.recordId,
        );
        const idempotency = this.readIdempotencyByRecordId(
          this.getStatements().idempotencyByRecordId,
          root.recordId,
        );
        const metadataRow = this.getStatements().metadataByRecordId.get(
          root.recordId,
        ) as RootRow | null;
        const metadata = metadataRow === null ? null : readMetadata(metadataRow);
        evidence.replay.actionCount = boundedMetric(evidence.replay.actionCount + actions.length);
        if (
          metadata === null ||
          metadata.actionCount !== actions.length ||
          metadata.orderingVersion !== CONTROL_ACTION_ORDERING_VERSION
        )
          return "Event Game Record replay metadata is incomplete.";
        const idempotencyFailure = validateIdempotencyHistory(root, actions, idempotency);
        if (idempotencyFailure !== null) return idempotencyFailure;
        const historicalRoot =
          actions[0] === undefined
            ? root
            : {
                ...root,
                lifecycle: structuredClone(actions[0].action.lifecycle),
              };
        const replay = rebuildControlActionHistory(
          historicalRoot,
          actions,
          context.actionCodecRegistry,
          context.interpreter,
        );
        if (replay.status !== "ready") return replay.detail;
      }
      evidence.replay.result = "passed";
      return null;
    } catch {
      return "Event Game Record replay verification failed.";
    } finally {
      evidence.replay.durationMs = boundedMetric(Date.now() - startedAt);
      if (evidence.replay.result !== "passed") evidence.replay.result = "failed";
    }
  }

  private refreshGrantMigrationProvenance(): void {
    const state = this.database
      .query(
        "SELECT migration_id FROM foundation_grant_migration_provenance_state WHERE state_id = 1",
      )
      .get() as RootRow | null;
    if (state === null || readText(state.migration_id) !== "014-grant-provenance-integrity")
      throw new Error("Grant migration provenance is incomplete.");
    const provenance = new Map<string, string>();
    const expiryProvenance = new Map<string, number | null>();
    const rows = this.database
      .query(
        `SELECT grant_id, retained_opaque_reference, migration_id, original_expires_at_ms
         FROM foundation_grant_migration_provenance ORDER BY grant_id`,
      )
      .all() as unknown[];
    for (const value of rows) {
      const row = asRecord(value);
      const grantId = readText(row.grant_id);
      const fingerprint = readText(row.retained_opaque_reference);
      if (
        readText(row.migration_id) !== "006-grant-cryptographic-erasure" ||
        !OPAQUE_MIGRATION_REFERENCE_PATTERN.test(fingerprint) ||
        provenance.has(grantId)
      )
        throw new Error("Grant migration provenance is invalid.");
      provenance.set(grantId, fingerprint);
      expiryProvenance.set(grantId, readNullableInteger(row.original_expires_at_ms));
    }
    this.grantValidationContext = {
      ...this.grantValidationContext,
      migrationProvenance: provenance,
      migrationExpiryProvenance: expiryProvenance,
    };
  }

  private readDataVersion(): number {
    return readInteger(this.database.query("PRAGMA data_version").get());
  }

  private refreshExternalRevision(): void {
    const currentDataVersion = this.readDataVersion();
    if (currentDataVersion !== this.dataVersion) {
      this.revision += 1;
      this.dataVersion = currentDataVersion;
    }
  }

  private tableExists(name: string): boolean {
    const row = this.database
      .query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) as RootRow | null;
    return row !== null;
  }

  private verifyPresentationEvidence(): string | null {
    if (
      !this.tableExists("foundation_event_game_presentation_changes") ||
      !this.tableExists("foundation_event_game_presentation_audit") ||
      !this.tableExists("foundation_event_game_presentation_integrity")
    )
      return null;
    const recordIds = new Set<string>();
    for (const row of this.database
      .query(
        "SELECT DISTINCT record_id FROM foundation_event_game_presentation_changes UNION SELECT DISTINCT record_id FROM foundation_event_game_presentation_audit UNION SELECT DISTINCT record_id FROM foundation_event_game_presentation_integrity",
      )
      .all() as Array<Record<string, unknown>>) {
      recordIds.add(String(row.record_id));
    }
    if (recordIds.size === 0) return null;
    const transaction = this.createTransaction();
    const sessions = listGrants(this.getGrantStatements().allGrants).flatMap((grant) =>
      listGrantSessions(this.getGrantStatements().sessionsByGrant, grant.grantId),
    );
    for (const recordId of recordIds) {
      const failure = presentationEvidenceFailure({
        root: transaction.findRootByRecordId(recordId),
        changes: transaction.listPresentationChanges?.(recordId) ?? [],
        audits: transaction.listPresentationAuditEntries?.(recordId) ?? [],
        anchors: (
          this.getStatements().presentationIntegrityByRecordId.all(recordId) as unknown[]
        ).map((row) => {
          const value = row as Record<string, unknown>;
          return {
            recordId: String(value.record_id),
            stateRevision: Number(value.state_revision),
            keyVersion: String(value.key_version),
            canonicalValue: String(value.canonical_value),
            integrityTag: String(value.integrity_tag),
          } satisfies PresentationIntegrityAnchor;
        }),
        sessions,
        actionOperationIds: new Set(
          transaction.listActions(recordId).map((action) => action.action.operationId),
        ),
        keyRing: this.grantValidationContext.keyRing,
      });
      if (failure !== null) return failure;
    }
    return null;
  }

  private verifyIdempotencyParity(): string | null {
    const actionCount = readInteger(
      this.database
        .query("SELECT COUNT(*) AS count FROM foundation_event_game_record_actions")
        .get(),
    );
    const idempotencyCount = readInteger(
      this.database
        .query("SELECT COUNT(*) AS count FROM foundation_event_game_record_idempotency")
        .get(),
    );
    if (actionCount !== idempotencyCount) {
      return "SQLite action and idempotency row counts are inconsistent.";
    }
    const rows = this.database
      .query(`
        SELECT
          actions.action_id AS action_action_id,
          actions.record_id AS action_record_id,
          actions.operation_id AS action_operation_id,
          actions.content_fingerprint AS action_content_fingerprint,
          actions.accepted_at_ms AS action_accepted_at_ms,
          idempotency.action_id AS idempotency_action_id,
          idempotency.record_id AS idempotency_record_id,
          idempotency.operation_id AS idempotency_operation_id,
          idempotency.content_fingerprint AS idempotency_content_fingerprint,
          idempotency.accepted_at_ms AS idempotency_accepted_at_ms
        FROM foundation_event_game_record_actions AS actions
        LEFT JOIN foundation_event_game_record_idempotency AS idempotency
          ON idempotency.action_id = actions.action_id
      `)
      .all() as unknown[];
    for (const value of rows) {
      const row = asRecord(value);
      if (row.idempotency_action_id === null) {
        return "SQLite action and idempotency state is missing a paired row.";
      }
      if (
        readText(row.action_action_id) !== readText(row.idempotency_action_id) ||
        readText(row.action_record_id) !== readText(row.idempotency_record_id) ||
        readText(row.action_operation_id) !== readText(row.idempotency_operation_id) ||
        readText(row.action_content_fingerprint) !==
          readText(row.idempotency_content_fingerprint) ||
        readInteger(row.action_accepted_at_ms) !== readInteger(row.idempotency_accepted_at_ms)
      ) {
        return "SQLite action and idempotency columns are inconsistent.";
      }
    }
    const extra = this.database
      .query(`
        SELECT idempotency.action_id
        FROM foundation_event_game_record_idempotency AS idempotency
        LEFT JOIN foundation_event_game_record_actions AS actions
          ON actions.action_id = idempotency.action_id
        WHERE actions.action_id IS NULL
        LIMIT 1
      `)
      .get() as RootRow | null;
    return extra === null ? null : "SQLite idempotency state has an extra row.";
  }

  private configureDatabase(): void {
    this.database.exec(
      `PRAGMA busy_timeout = ${this.busyTimeoutMs};
       PRAGMA journal_mode = WAL;
       PRAGMA synchronous = FULL;
       PRAGMA foreign_keys = ON;`,
    );
  }

  private latchCorruption(): void {
    this.unsafeFailure = "corruption";
    try {
      persistQuarantineMarker(this.quarantineMarkerPath, this.faultInjector);
    } catch (error) {
      if (!(error instanceof FoundationQuarantinePersistenceError)) throw error;
      this.quarantinePersistenceFailure = true;
    }
  }

  private rollbackQuietly(): void {
    try {
      this.database.exec("ROLLBACK;");
    } catch {
      // The original transaction error is the useful one for callers.
    }
  }

  private enqueue<T>(operation: () => T): Promise<T> {
    const queued = this.writerTail.then(() => {
      this.assertOpen();
      return operation();
    });
    this.writerTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private assertOpen(): void {
    if (this.closed) throw new FoundationStorageClosedError();
  }
}

export function openSqliteFoundationStorage(
  databasePath: string,
  options: SqliteFoundationStorageOptions = {},
): SqliteFoundationStorage {
  return new SqliteFoundationStorage(databasePath, options);
}

export async function readSqliteFoundationStorageReadiness(
  databasePath: string,
  options: Omit<SqliteFoundationStorageOptions, "readOnly"> = {},
): Promise<FoundationStorageReadiness> {
  let storage: SqliteFoundationStorage | undefined;
  try {
    storage = new SqliteFoundationStorage(databasePath, {
      ...options,
      readOnly: true,
      requireReplayContext: false,
    });
    return await storage.readiness();
  } catch {
    return {
      ok: false,
      status: "missing",
      detail: "SQLite foundation database is unavailable.",
      storage: "sqlite",
    };
  } finally {
    storage?.close();
  }
}

export async function validateFoundationMigrationCandidate(
  storage: SqliteFoundationStorage,
  options: { retainCandidate?: boolean } = {},
): Promise<FoundationMigrationCandidateReport> {
  return storage.validateCandidate(options);
}

function translateSqliteConstraint(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const message = error.message.toLowerCase();
  if (message.includes("foundation_grant_roots.grant_id")) {
    return new FoundationStorageConstraintError("grant-id");
  }
  if (message.includes("foundation_grant_roots.grant_version")) {
    return new FoundationStorageConstraintError("grant-version");
  }
  if (message.includes("foundation_grant_roots.pitch_slot_id")) {
    return new FoundationStorageConstraintError("grant-pitch-slot-id");
  }
  if (message.includes("foundation_grant_roots.credential_lookup_digest")) {
    return new FoundationStorageConstraintError("grant-credential-digest");
  }
  if (
    message.includes("foundation_grant_sessions_active_context") ||
    (message.includes("foundation_grant_sessions.grant_id") &&
      message.includes("browser_context_digest"))
  ) {
    return new FoundationStorageConstraintError("grant-session-context");
  }
  if (message.includes("foundation_grant_sessions.session_id")) {
    return new FoundationStorageConstraintError("grant-session-id");
  }
  if (message.includes("foundation_grant_sessions.bearer_lookup_verifier")) {
    return new FoundationStorageConstraintError("grant-session-verifier");
  }
  if (message.includes("foundation_grant_audit.audit_id")) {
    return new FoundationStorageConstraintError("grant-audit-id");
  }
  if (message.includes("foundation_event_catalog_teams.event_team_id")) {
    return new FoundationStorageConstraintError("event-team-id");
  }
  if (message.includes("foundation_event_catalog_teams.event_id") && message.includes("name")) {
    return new FoundationStorageConstraintError("event-team-name");
  }
  if (message.includes("foundation_event_catalog_roster.roster_entry_id")) {
    return new FoundationStorageConstraintError("roster-entry-id");
  }
  if (message.includes("foundation_event_catalog_roster.event_team_id")) {
    return new FoundationStorageConstraintError("roster-player-number");
  }
  if (message.includes("foundation_event_catalog_pitches.pitch_id")) {
    return new FoundationStorageConstraintError("pitch-id");
  }
  if (message.includes("foundation_event_catalog_pitches.event_id") && message.includes("name")) {
    return new FoundationStorageConstraintError("pitch-name");
  }
  return translateControlSqliteConstraint(error);
}

function boundedMetric(value: number): number {
  return Number.isSafeInteger(value) ? Math.max(0, Math.min(value, 1_000_000_000)) : 0;
}

function boundedText(value: string): string {
  return value.length <= 32 ? value : value.slice(0, 32);
}

function readQuarantineMarker(path: string | null): boolean {
  if (path === null) return false;
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > QUARANTINE_MARKER_MAX_BYTES) return true;
  } catch (error) {
    return error instanceof Error && (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  return true;
}

function persistQuarantineMarker(
  path: string | null,
  faultInjector: SqliteFoundationStorageOptions["faultInjector"],
): void {
  if (path === null) throw new FoundationQuarantinePersistenceError();
  try {
    if (statSync(path).isFile()) {
      verifyQuarantineMarker(path);
      return;
    }
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new FoundationQuarantinePersistenceError();
    }
  }

  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    faultInjector?.("quarantine-write");
    writeFileSync(temporaryPath, QUARANTINE_MARKER_CONTENT, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const markerFd = openSync(temporaryPath, "r");
    try {
      faultInjector?.("quarantine-sync");
      fsyncSync(markerFd);
    } finally {
      closeSync(markerFd);
    }
    faultInjector?.("quarantine-rename");
    renameSync(temporaryPath, path);
    const parentFd = openSync(dirname(path), "r");
    try {
      faultInjector?.("quarantine-sync");
      fsyncSync(parentFd);
    } catch {
      closeSync(parentFd);
      throw new FoundationQuarantinePersistenceError();
    }
    closeSync(parentFd);
    faultInjector?.("quarantine-verify");
    verifyQuarantineMarker(path);
  } catch {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Preserve the bounded quarantine failure even if cleanup is unavailable.
    }
    throw new FoundationQuarantinePersistenceError();
  }
}

function verifyQuarantineMarker(path: string): void {
  const stats = lstatSync(path);
  if (
    !stats.isFile() ||
    stats.size > QUARANTINE_MARKER_MAX_BYTES ||
    (stats.mode & 0o777) !== 0o600
  ) {
    throw new FoundationQuarantinePersistenceError();
  }
  if (readFileSync(path, "utf8") !== QUARANTINE_MARKER_CONTENT) {
    throw new FoundationQuarantinePersistenceError();
  }
}

function safeFileSize(path: string): number | null {
  try {
    return boundedMetric(statSync(path).size);
  } catch {
    return null;
  }
}

function safeFreeBytes(path: string): number | null {
  try {
    const stats = statfsSync(path);
    return boundedMetric(stats.bavail * stats.bsize);
  } catch {
    return null;
  }
}

function safeSqliteVersion(database: Database): string | null {
  try {
    const row = database.query("SELECT sqlite_version() AS version").get() as Record<
      string,
      unknown
    >;
    const version = row.version;
    return typeof version === "string" ? boundedText(version) : null;
  } catch {
    return null;
  }
}

function classifySqliteFailure(
  error: unknown,
  phase: "transaction" | "commit" | "readiness",
): FoundationStorageFailureCategory | null {
  if (error instanceof SqliteFoundationFault) return error.category;
  if (!(error instanceof Error)) return null;
  const message = error.message.toLowerCase();
  if (message.includes("busy") || message.includes("locked")) return "busy";
  if (
    message.includes("readonly") ||
    message.includes("read-only") ||
    message.includes("permission denied")
  )
    return "readonly";
  if (message.includes("full") || message.includes("quota")) return "full";
  if (message.includes("ioerr") || message.includes("i/o") || message.includes("disk i/o"))
    return "io-error";
  if (phase === "commit" && message.includes("commit")) return "commit-failure";
  if (
    message.includes("malformed") ||
    message.includes("corrupt") ||
    message.includes("not a database")
  )
    return "corruption";
  return null;
}
