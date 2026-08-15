import {
  parseStoredControlAction,
  CONTROL_ACTION_VERSION,
  LEGACY_CONTROL_ACTION_VERSION,
  LEGACY_CONTROL_AUDIT_VERSION,
  CONTROL_AUDIT_VERSION,
  sha256,
  type ControlAuditLinkage,
  type ControlAuditProvenance,
} from "@/lib/event-game-actions";
import {
  validateGrant,
  validateLifecycle,
  validateOccurrenceWithoutClock,
  validateOverride,
  validatePredecessors,
  validateRecoveryProvenanceShape,
  validateId,
  validateTimestamp,
  validateInterpretation,
  validateStoredInput,
} from "@/lib/event-game-action-codecs";
import {
  FoundationStorageConstraintError,
  type StoredControlAction,
  type StoredControlAuditEntry,
  type StoredControlIdempotencyEntry,
  type StoredEventGameRecordMetadata,
} from "@/lib/foundation-storage";
import { DURABLE_EVIDENCE_PROVENANCE } from "@/lib/foundation-storage";

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
  if (message.includes("bucket_id")) {
    return new FoundationStorageConstraintError("acceptance-budget-id");
  }
  if (message.includes("reservation_id")) {
    return new FoundationStorageConstraintError("replay-reservation-id");
  }
  if (message.includes("attempt_id")) {
    return new FoundationStorageConstraintError("replay-attempt-id");
  }
  if (message.includes("receipt_digest")) {
    return new FoundationStorageConstraintError("replay-receipt-digest");
  }
  if (message.includes("receipt_id")) {
    return new FoundationStorageConstraintError("replay-receipt-id");
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
  if (action.value.controlActionVersion !== readText(row.control_action_version)) {
    throw new Error("Stored Control Action compatibility version is inconsistent.");
  }
  const durableFormat = readEvidenceFormat(row.action_evidence_format, "action");
  const provenanceFormat = readEvidenceFormat(row.action_provenance_format, "action");
  if (provenanceFormat !== durableFormat) {
    throw new Error("Stored Control Action immutable provenance is inconsistent.");
  }
  if (
    (durableFormat === "current" && action.value.controlActionVersion !== CONTROL_ACTION_VERSION) ||
    (durableFormat === "legacy" &&
      action.value.controlActionVersion !== LEGACY_CONTROL_ACTION_VERSION)
  ) {
    throw new Error("Stored Control Action durable format marker is inconsistent.");
  }
  return {
    action: action.value,
    canonicalContent: readText(row.canonical_content),
    contentFingerprint: readText(row.content_fingerprint),
    durableFormat,
    [DURABLE_EVIDENCE_PROVENANCE]: provenanceFormat,
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
  const durableAuditVersion = readText(row.audit_version);
  const durableFormat = readEvidenceFormat(row.audit_evidence_format, "audit");
  const provenanceFormat = readEvidenceFormat(row.audit_provenance_format, "audit");
  if (provenanceFormat !== durableFormat) {
    throw new Error("Stored Control Audit immutable provenance is inconsistent.");
  }
  const jsonAuditVersion =
    entry.auditVersion === undefined ? undefined : readText(entry.auditVersion);
  if (jsonAuditVersion !== undefined && jsonAuditVersion !== durableAuditVersion) {
    throw new Error("Stored Control Audit compatibility version is inconsistent.");
  }
  const auditVersion = durableAuditVersion;
  if (auditVersion !== CONTROL_AUDIT_VERSION && auditVersion !== LEGACY_CONTROL_AUDIT_VERSION) {
    throw new Error("Stored Control Audit version is invalid.");
  }
  if (
    (durableFormat === "current" && auditVersion !== CONTROL_AUDIT_VERSION) ||
    (durableFormat === "legacy" && auditVersion !== LEGACY_CONTROL_AUDIT_VERSION)
  ) {
    throw new Error("Stored Control Audit durable format marker is inconsistent.");
  }
  const lockedReplay = entry.lockedReplay !== undefined;
  if (
    lockedReplay &&
    (entry.redactedDetail !== undefined ||
      entry.links !== undefined ||
      entry.provenance !== undefined)
  ) {
    throw new Error("Stored locked replay evidence has unexpected fields.");
  }
  if (
    !lockedReplay &&
    auditVersion === CONTROL_AUDIT_VERSION &&
    (entry.links === undefined || entry.provenance === undefined)
  ) {
    throw new Error("Stored #75 Control Audit evidence is incomplete.");
  }
  const result = {
    auditVersion,
    durableFormat,
    [DURABLE_EVIDENCE_PROVENANCE]: provenanceFormat,
    auditId: readRequiredId(entry.auditId, "auditId"),
    recordId: readRequiredId(entry.recordId, "recordId"),
    eventGameId: readRequiredId(entry.eventGameId, "eventGameId"),
    operationId:
      entry.operationId === null ? null : readRequiredId(entry.operationId, "operationId"),
    kind,
    outcome: readText(entry.outcome),
    createdAtMs: readRequiredTimestamp(entry.createdAtMs, "createdAtMs"),
    ...(entry.redactedDetail === undefined
      ? {}
      : { redactedDetail: readText(entry.redactedDetail) }),
    ...(entry.links === undefined ? {} : { links: readAuditLinks(entry.links) }),
    ...(entry.provenance === undefined
      ? {}
      : { provenance: readAuditProvenance(entry.provenance) }),
    ...(entry.lockedReplay === undefined
      ? {}
      : { lockedReplay: readLockedReplay(entry.lockedReplay) }),
  } as StoredControlAuditEntry;
  if (
    result.auditId !== readText(row.audit_id) ||
    result.recordId !== readText(row.record_id) ||
    result.eventGameId !== readText(row.event_game_id) ||
    result.operationId !== (row.operation_id === null ? null : readText(row.operation_id)) ||
    result.kind !== readText(row.audit_kind) ||
    result.outcome !== readText(row.outcome) ||
    result.createdAtMs !== readInteger(row.created_at_ms) ||
    (result.redactedDetail === undefined
      ? readText(row.redacted_detail) !== ""
      : result.redactedDetail !== readText(row.redacted_detail))
  ) {
    throw new Error("Stored Control Audit entry projection is inconsistent.");
  }
  return result;
}

function readEvidenceFormat(value: unknown, kind: "action" | "audit"): "current" | "legacy" {
  if (value === "current" || value === "legacy") return value;
  throw new Error(`Stored Control ${kind} evidence format is invalid.`);
}

function readAuditLinks(value: unknown): ControlAuditLinkage {
  if (!isObject(value)) throw new Error("Stored Control Audit linkage is invalid.");
  const actionId = readValidatedNullableId(value.actionId, "actionId");
  const targetFactId = readValidatedNullableId(value.targetFactId, "targetFactId");
  const causalPredecessorIds = validatePredecessors(value.causalPredecessorIds);
  const relatedOperationIds = readValidatedIdArray(
    value.relatedOperationIds,
    "relatedOperationIds",
  );
  if (!causalPredecessorIds.ok)
    throw new Error("Stored Control Audit causal predecessors are invalid.");
  const collision = value.collision === undefined ? undefined : readAuditCollision(value.collision);
  const rejectedCandidate =
    value.rejectedCandidate === undefined
      ? undefined
      : readRejectedCandidate(value.rejectedCandidate);
  return {
    actionId,
    targetFactId,
    causalPredecessorIds: causalPredecessorIds.value,
    relatedOperationIds,
    ordering: readAuditOrdering(value.ordering),
    ...(value.grantAuditId === undefined
      ? {}
      : { grantAuditId: readValidatedNullableId(value.grantAuditId, "grantAuditId") }),
    ...(value.acceptanceId === undefined
      ? {}
      : { acceptanceId: readValidatedNullableId(value.acceptanceId, "acceptanceId") }),
    ...(value.contentFingerprint === undefined
      ? {}
      : { contentFingerprint: readFingerprint(value.contentFingerprint, "contentFingerprint") }),
    ...(value.reason === undefined ? {} : { reason: readNonEmptyText(value.reason, "reason") }),
    ...(rejectedCandidate === undefined ? {} : { rejectedCandidate }),
    ...(collision === undefined ? {} : { collision }),
  };
}

function readRejectedCandidate(
  value: unknown,
): NonNullable<ControlAuditLinkage["rejectedCandidate"]> {
  if (!isObject(value)) throw new Error("Stored Control Audit rejected candidate is invalid.");
  return {
    codecIdentity: readNonEmptyText(value.codecIdentity, "rejectedCodecIdentity"),
    codecFingerprint: readNonEmptyText(value.codecFingerprint, "rejectedCodecFingerprint"),
    canonicalContent: readText(value.canonicalContent),
    contentFingerprint: readFingerprint(value.contentFingerprint, "rejectedContentFingerprint"),
  };
}

function readLockedReplay(value: unknown): NonNullable<StoredControlAuditEntry["lockedReplay"]> {
  if (!isObject(value)) throw new Error("Stored locked replay evidence is invalid.");
  const count = typeof value.count === "number" ? value.count : NaN;
  const originatingSessionId = readRequiredId(value.originatingSessionId, "originatingSessionId");
  const eventGameId = readRequiredId(value.eventGameId, "eventGameId");
  const rejectedAtMs = validateTimestamp(value.rejectedAtMs, "rejectedAtMs");
  if (!Number.isSafeInteger(count) || count <= 0 || !rejectedAtMs.ok) {
    throw new Error("Stored locked replay evidence is invalid.");
  }
  return { count, originatingSessionId, eventGameId, rejectedAtMs: rejectedAtMs.value };
}

function readAuditCollision(value: unknown): ControlAuditLinkage["collision"] {
  if (!isObject(value)) throw new Error("Stored Control Audit collision is invalid.");
  const acceptedActionId = readRequiredId(value.acceptedActionId, "acceptedActionId");
  const acceptedOperationId = readRequiredId(value.acceptedOperationId, "acceptedOperationId");
  const acceptedContentFingerprint = readFingerprint(
    value.acceptedContentFingerprint,
    "acceptedContentFingerprint",
  );
  if (!isObject(value.rejectedAttempt)) {
    throw new Error("Stored Control Audit rejected attempt is invalid.");
  }
  const rejectedAttempt = value.rejectedAttempt;
  if (!isObject(rejectedAttempt.input)) {
    throw new Error("Stored Control Audit rejected attempt input is invalid.");
  }
  const input = validateStoredInput(rejectedAttempt.input);
  const interpretation = validateInterpretation(rejectedAttempt.interpretation);
  if (!input.ok || !interpretation.ok) {
    throw new Error("Stored Control Audit rejected attempt is invalid.");
  }
  return {
    acceptedActionId,
    acceptedOperationId,
    acceptedContentFingerprint,
    rejectedAttempt: {
      input: input.value,
      codecIdentity:
        rejectedAttempt.codecIdentity === undefined
          ? undefined
          : readNonEmptyText(rejectedAttempt.codecIdentity, "rejectedCodecIdentity"),
      codecFingerprint:
        rejectedAttempt.codecFingerprint === undefined
          ? undefined
          : readNonEmptyText(rejectedAttempt.codecFingerprint, "rejectedCodecFingerprint"),
      canonicalContent: readText(rejectedAttempt.canonicalContent),
      contentFingerprint: readFingerprint(
        rejectedAttempt.contentFingerprint,
        "rejectedContentFingerprint",
      ),
      interpretation: interpretation.value,
    },
  };
}

function readFingerprint(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`Stored Control Audit ${field} is invalid.`);
  }
  return value;
}

function readNonEmptyText(value: unknown, field: string): string {
  const text = readText(value);
  if (text.length === 0) throw new Error(`Stored Control Audit ${field} is invalid.`);
  return text;
}

function readAuditOrdering(value: unknown): ControlAuditLinkage["ordering"] {
  if (value === null) return null;
  if (!isObject(value)) {
    throw new Error("Stored Control Audit ordering is invalid.");
  }
  const trustedAtMs = validateTimestamp(value.trustedAtMs, "audit ordering trustedAtMs");
  const operationId = validateId(value.operationId, "audit ordering operationId");
  if (!trustedAtMs.ok || !operationId.ok)
    throw new Error("Stored Control Audit ordering is invalid.");
  return { trustedAtMs: trustedAtMs.value, operationId: operationId.value };
}

function readAuditProvenance(value: unknown): ControlAuditProvenance {
  if (!isObject(value)) throw new Error("Stored Control Audit provenance is invalid.");
  for (const field of ["occurrence", "grant", "lifecycle", "override", "recoveryProvenance"]) {
    if (!Object.hasOwn(value, field)) {
      throw new Error("Stored Control Audit provenance is incomplete.");
    }
  }
  const occurrence = validateOccurrenceWithoutClock(value.occurrence);
  const grant = validateGrant(value.grant);
  const lifecycle = validateLifecycle(value.lifecycle);
  const override = validateOverride(value.override === null ? undefined : value.override);
  const recoveryProvenance =
    value.recoveryProvenance === null
      ? { ok: true as const, value: null }
      : validateRecoveryProvenanceShape(value.recoveryProvenance);
  if (!occurrence.ok || !grant.ok || !lifecycle.ok || !override.ok || !recoveryProvenance.ok) {
    throw new Error("Stored Control Audit provenance is invalid.");
  }
  return {
    occurrence: occurrence.value,
    grant: grant.value,
    lifecycle: lifecycle.value,
    override: override.value ?? null,
    recoveryProvenance: recoveryProvenance.value ?? null,
  };
}

function readValidatedNullableId(value: unknown, field: string): string | null {
  if (value === null) return null;
  const result = validateId(value, `audit linkage ${field}`);
  if (!result.ok) throw new Error(`Stored Control Audit ${field} is invalid.`);
  return result.value;
}

function readRequiredId(value: unknown, field: string): string {
  const result = validateId(value, `audit ${field}`);
  if (!result.ok) throw new Error(`Stored Control Audit ${field} is invalid.`);
  return result.value;
}

function readRequiredTimestamp(value: unknown, field: string): number {
  const result = validateTimestamp(value, `audit ${field}`);
  if (!result.ok) throw new Error(`Stored Control Audit ${field} is invalid.`);
  return result.value;
}

function readValidatedIdArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 2) {
    throw new Error(`Stored Control Audit ${field} is invalid.`);
  }
  const result = value.map((item, index) => validateId(item, `audit ${field}[${index}]`));
  const values: string[] = [];
  for (const item of result) {
    if (!item.ok) throw new Error(`Stored Control Audit ${field} is invalid.`);
    values.push(item.value);
  }
  if (new Set(values).size !== values.length)
    throw new Error(`Stored Control Audit ${field} is invalid.`);
  return values;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
