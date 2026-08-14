import { parseStoredControlAction, sha256 } from "@/lib/event-game-actions";
import {
  FoundationStorageConstraintError,
  type StoredControlAction,
  type StoredControlAuditEntry,
  type StoredControlIdempotencyEntry,
  type StoredEventGameRecordMetadata,
} from "@/lib/foundation-storage";

export type RootRow = Record<string, unknown>;

export function translateSqliteConstraint(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const message = error.message.toLowerCase();
  if (message.includes("record_id")) {
    return new FoundationStorageConstraintError("record-id");
  }
  if (message.includes("event_game_id")) {
    return new FoundationStorageConstraintError("event-game-id");
  }
  if (message.includes("pitch_slot_id")) {
    return new FoundationStorageConstraintError("pitch-slot-id");
  }
  if (message.includes("side_id")) {
    return new FoundationStorageConstraintError("game-side-id");
  }
  if (message.includes("operation_id")) {
    return new FoundationStorageConstraintError("operation-id");
  }
  if (message.includes("audit_id")) {
    return new FoundationStorageConstraintError("audit-id");
  }
  return error;
}

export function readStoredAction(row: RootRow): StoredControlAction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readText(row.action_json)) as unknown;
  } catch {
    throw new Error("Stored Control Action JSON is invalid.");
  }
  const action = parseStoredControlAction(parsed);
  if (!action.ok) throw new Error("Stored Control Action failed structural validation.");
  if (action.value.kind.id !== readText(row.action_kind)) {
    throw new Error("Stored Control Action kind projection is inconsistent.");
  }
  if (action.value.kind.version !== readText(row.action_version)) {
    throw new Error("Stored Control Action version projection is inconsistent.");
  }
  if (action.value.acceptedAtMs !== readInteger(row.accepted_at_ms)) {
    throw new Error("Stored Control Action acceptance time is inconsistent.");
  }
  return {
    action: action.value,
    canonicalContent: readText(row.canonical_content),
    contentFingerprint: readText(row.content_fingerprint),
  };
}

export function readMetadata(row: RootRow): StoredEventGameRecordMetadata {
  return {
    recordId: readText(row.record_id),
    actionCount: readInteger(row.action_count),
    orderingVersion: readText(row.ordering_version),
    lastAcceptedAtMs: readNullableInteger(row.last_accepted_at_ms),
    updatedAtMs: readInteger(row.updated_at_ms),
  };
}

export function readAudit(row: RootRow): StoredControlAuditEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readText(row.audit_json)) as unknown;
  } catch {
    throw new Error("Stored Control Audit entry JSON is invalid.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Stored Control Audit entry is invalid.");
  }
  const entry = parsed as Record<string, unknown>;
  const kind = entry.kind;
  if (
    kind !== "action-accepted" &&
    kind !== "action-conflict" &&
    kind !== "action-rejected" &&
    kind !== "action-duplicate"
  ) {
    throw new Error("Stored Control Audit entry kind is invalid.");
  }
  const result: StoredControlAuditEntry = {
    auditId: readText(entry.auditId),
    recordId: readText(entry.recordId),
    eventGameId: readText(entry.eventGameId),
    operationId: entry.operationId === null ? null : readText(entry.operationId),
    kind,
    outcome: readText(entry.outcome),
    createdAtMs: readInteger(entry.createdAtMs),
    redactedDetail: readText(entry.redactedDetail),
  };
  if (
    result.auditId !== readText(row.audit_id) ||
    result.recordId !== readText(row.record_id) ||
    result.eventGameId !== readText(row.event_game_id) ||
    result.operationId !== (row.operation_id === null ? null : readText(row.operation_id)) ||
    result.kind !== readText(row.audit_kind) ||
    result.outcome !== readText(row.outcome) ||
    result.createdAtMs !== readInteger(row.created_at_ms) ||
    result.redactedDetail !== readText(row.redacted_detail)
  ) {
    throw new Error("Stored Control Audit entry projection is inconsistent.");
  }
  return result;
}

export function readIdempotency(row: RootRow): StoredControlIdempotencyEntry {
  return {
    actionId: readText(row.action_id),
    recordId: readText(row.record_id),
    operationId: readText(row.operation_id),
    contentFingerprint: readText(row.content_fingerprint),
    acceptedAtMs: readInteger(row.accepted_at_ms),
  };
}

export function actionIdentity(recordId: string, operationId: string): string {
  return `action-${sha256(`${recordId}:${operationId}`)}`;
}

export function quoteSqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function asRecord(value: unknown): RootRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("SQLite returned an invalid row.");
  }
  return value as RootRow;
}

export function readText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "journal_mode" in value) {
    return readText(value.journal_mode);
  }
  if (typeof value === "object" && value !== null && "synchronous" in value) {
    return readText(value.synchronous);
  }
  if (typeof value === "object" && value !== null && "foreign_keys" in value) {
    return readText(value.foreign_keys);
  }
  if (typeof value === "object" && value !== null && "busy_timeout" in value) {
    return readText(value.busy_timeout);
  }
  if (typeof value === "object" && value !== null && "timeout" in value) {
    return readText(value.timeout);
  }
  if (typeof value === "object" && value !== null && "count" in value) {
    return readText(value.count);
  }
  if (typeof value === "object" && value !== null && "data_version" in value) {
    return readText(value.data_version);
  }
  if (typeof value === "object" && value !== null && "quick_check" in value) {
    return readText(value.quick_check);
  }
  if (typeof value === "object" && value !== null && "integrity_check" in value) {
    return readText(value.integrity_check);
  }
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  throw new Error("SQLite returned an invalid value.");
}

export function readInteger(value: unknown): number {
  const parsed = Number(readText(value));
  if (!Number.isSafeInteger(parsed)) throw new Error("SQLite returned an invalid integer.");
  return parsed;
}

export function readNullableInteger(value: unknown): number | null {
  return value === null ? null : readInteger(value);
}
