import {
  canonicalizeEventGameRecordRoot,
  cloneEventGameRecordRoot,
  validateEventGameRecordRoot,
  type EventGameRecordRoot,
} from "@/lib/foundation-record-types";
import {
  computeAcceptanceIntegrityTag,
  computeGrantAdmissionStateAnchor,
  computeGrantAuditIntegrityTag,
  computeGrantStateAnchor,
} from "@/lib/grant-crypto";
import {
  cloneStoredGrant,
  cloneStoredGrantAuditEntry,
  cloneStoredGrantSession,
  type GrantKeyRing,
  type GrantAdmissionGlobalWindow,
  type GrantAdmissionMode,
  type GrantAdmissionTelemetry,
  type ControlGrantScope,
  type StoredGrant,
  type StoredGrantAuditEntry,
  type StoredGrantSession,
} from "@/lib/grant-types";
import {
  FoundationStorageClosedError,
  FoundationStorageConstraintError,
  FoundationStorageNotReadyError,
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
  type EventCatalogAuditEntry,
  type GrantAdmissionStateAnchor,
  isThenable,
  DURABLE_EVIDENCE_PROVENANCE,
} from "@/lib/foundation-storage";
import type {
  AcceptanceIntegrityAnchor,
  AcceptanceIntegritySubject,
} from "@/lib/foundation-acceptance-integrity";
import {
  anchorFor,
  acceptanceAuditPairFailure,
  replayAttemptResultFailure,
} from "@/lib/foundation-acceptance-integrity";
import {
  CONTROL_AUDIT_VERSION,
  CONTROL_ACTION_VERSION,
  LEGACY_CONTROL_AUDIT_VERSION,
  LEGACY_CONTROL_ACTION_VERSION,
  actionIdentity,
  canonicalizeJson,
  parseStoredControlAction,
} from "@/lib/event-game-actions";
import {
  grantAdmissionStateMaterial,
  grantStateMaterial,
  orderGrantAudits,
  validateGrantState,
  type GrantStateValidationContext,
} from "@/lib/grant-state-validation";
import { bindGrantAuditChain } from "@/lib/grant-audit-chain";

type MemoryState = {
  roots: Map<string, StoredEventGameRecordRoot>;
  actions: Map<string, Map<string, StoredControlAction>>;
  idempotency: Map<string, Map<string, StoredControlIdempotencyEntry>>;
  metadata: Map<string, StoredEventGameRecordMetadata>;
  controlAudits: Map<string, Map<string, StoredControlAuditEntry>>;
  actionProvenance: Map<string, Map<string, "current" | "legacy">>;
  auditProvenance: Map<string, Map<string, "current" | "legacy">>;
  grants: Map<string, StoredGrant>;
  sessions: Map<string, StoredGrantSession>;
  grantAudits: Map<string, StoredGrantAuditEntry>;
  grantAuditProvenance: Map<string, StoredGrantAuditEntry>;
  grantAuditIntegrityTags: Map<string, string>;
  acceptanceBudgets: Map<string, StoredAcceptanceBudget>;
  replayReservations: Map<string, StoredReplayReservation>;
  replayAttempts: Map<string, StoredReplayAttempt>;
  replayReceipts: Map<string, StoredReplayReceipt>;
  integrityAnchors: Map<string, AcceptanceIntegrityAnchor>;
  events: Map<string, StoredEventCatalogEvent>;
  gameDays: Map<string, StoredEventCatalogGameDay>;
  eventAudits: Map<string, EventCatalogAuditEntry>;
  grantStateAnchors: Map<string, MemoryGrantStateAnchor>;
  grantAdmissionTelemetry: Map<string, GrantAdmissionTelemetry>;
  grantAdmissionGlobalWindows: Map<GrantAdmissionMode, GrantAdmissionGlobalWindow>;
  grantAdmissionStateAnchor: GrantAdmissionStateAnchor | null;
  grantAdmissionAnchorInstalled: boolean;
};

type MemoryGrantStateAnchor = {
  auditCount: number;
  auditHeadId: string;
  stateDigest: string;
  integrityTag: string;
};

export function createInMemoryFoundationStorage(): FoundationStorage {
  return new InMemoryFoundationStorage();
}

class InMemoryFoundationStorage implements FoundationStorage {
  private readonly state: MemoryState = {
    roots: new Map(),
    actions: new Map(),
    idempotency: new Map(),
    metadata: new Map(),
    controlAudits: new Map(),
    actionProvenance: new Map(),
    auditProvenance: new Map(),
    grants: new Map(),
    sessions: new Map(),
    grantAudits: new Map(),
    grantAuditProvenance: new Map(),
    grantAuditIntegrityTags: new Map(),
    acceptanceBudgets: new Map(),
    replayReservations: new Map(),
    replayAttempts: new Map(),
    replayReceipts: new Map(),
    integrityAnchors: new Map(),
    events: new Map(),
    gameDays: new Map(),
    eventAudits: new Map(),
    grantStateAnchors: new Map(),
    grantAdmissionTelemetry: new Map(),
    grantAdmissionGlobalWindows: new Map(),
    grantAdmissionStateAnchor: null,
    grantAdmissionAnchorInstalled: false,
  };
  private writerTail: Promise<void> = Promise.resolve();
  private closed = false;
  private revision = 0;
  private grantValidationContext: GrantStateValidationContext = {};

  transaction<T>(work: FoundationStorageTransactionWork<T>): Promise<T> {
    const operation = this.writerTail.then(() => {
      this.assertOpen();
      const acceptanceFailure = acceptanceStateFailure(
        this.state,
        this.grantValidationContext.keyRing,
      );
      if (acceptanceFailure !== null) {
        throw new FoundationStorageNotReadyError({
          ok: false,
          status: "integrity-failure",
          detail: acceptanceFailure,
          storage: "memory",
        });
      }
      const grantFailure = this.grantStateFailure();
      if (grantFailure !== null) {
        throw new FoundationStorageNotReadyError({
          ok: false,
          status: "integrity-failure",
          detail: grantFailure,
          storage: "memory",
        });
      }
      const undo: (() => void)[] = [];
      const previousAnchors = new Map(this.state.grantStateAnchors);
      const previousAdmissionAnchor = this.state.grantAdmissionStateAnchor;
      const previousAdmissionAnchorInstalled = this.state.grantAdmissionAnchorInstalled;
      try {
        const result = work(
          createTransaction(this.state, undo, this.revision, this.grantValidationContext.keyRing),
        );
        if (isThenable(result)) {
          throw new TypeError("Foundation storage transactions must complete synchronously.");
        }
        const semanticFailure = validateGrantState(
          this.state.grants.values(),
          this.state.sessions.values(),
          this.state.grantAudits.values(),
          {
            ...this.grantValidationContext,
            auditProvenance: this.state.grantAuditProvenance,
            auditIntegrityTags: this.state.grantAuditIntegrityTags,
            admissionTelemetry: this.state.grantAdmissionTelemetry.values(),
            admissionGlobalWindows: this.state.grantAdmissionGlobalWindows.values(),
          },
        );
        if (semanticFailure !== null) throw new Error(semanticFailure);
        this.rebuildGrantStateAnchors();
        this.rebuildGrantAdmissionStateAnchor();
        this.revision += 1;
        return result;
      } catch (error) {
        for (const revert of undo.reverse()) revert();
        this.state.grantStateAnchors.clear();
        for (const [grantId, anchor] of previousAnchors)
          this.state.grantStateAnchors.set(grantId, anchor);
        this.state.grantAdmissionStateAnchor = previousAdmissionAnchor;
        this.state.grantAdmissionAnchorInstalled = previousAdmissionAnchorInstalled;
        throw error;
      }
    });
    this.writerTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  readRoot(recordId: string): Promise<EventGameRecordRoot | null> {
    return this.writerTail.then(() => {
      this.assertOpen();
      const stored = this.state.roots.get(recordId);
      return stored === undefined ? null : cloneEventGameRecordRoot(stored.root);
    });
  }

  readActions(recordId: string): Promise<StoredControlAction[]> {
    return this.writerTail.then(() => {
      this.assertOpen();
      return cloneActions(
        this.state.actions.get(recordId),
        this.state.actionProvenance.get(recordId),
      );
    });
  }

  readRecordMetadata(recordId: string): Promise<StoredEventGameRecordMetadata | null> {
    return this.writerTail.then(() => {
      this.assertOpen();
      const metadata = this.state.metadata.get(recordId);
      return metadata === undefined ? null : structuredClone(metadata);
    });
  }

  readIdempotencyEntries(recordId: string): Promise<StoredControlIdempotencyEntry[]> {
    return this.writerTail.then(() => {
      this.assertOpen();
      return [...(this.state.idempotency.get(recordId)?.values() ?? [])].map((entry) =>
        structuredClone(entry),
      );
    });
  }

  readAuditEntries(recordId: string): Promise<StoredControlAuditEntry[]> {
    return this.writerTail.then(() => {
      this.assertOpen();
      return cloneAudits(
        this.state.controlAudits.get(recordId),
        this.state.auditProvenance.get(recordId),
      );
    });
  }

  readiness(): Promise<FoundationStorageReadiness> {
    return this.writerTail.then(() => {
      if (this.closed) {
        return {
          ok: false,
          status: "closed",
          detail: "In-memory foundation storage is closed.",
          storage: "memory",
        } satisfies FoundationStorageReadiness;
      }
      for (const stored of this.state.roots.values()) {
        const validated = validateEventGameRecordRoot(stored.root);
        if (
          !validated.ok ||
          canonicalizeEventGameRecordRoot(validated.value) !== stored.canonicalContent
        ) {
          return {
            ok: false,
            status: "integrity-failure",
            detail: "An in-memory Event Game Record root failed semantic validation.",
            storage: "memory",
          } satisfies FoundationStorageReadiness;
        }
      }
      for (const [recordId, actions] of this.state.actions) {
        for (const stored of actions.values()) {
          if (!parseStoredControlAction(stored.action).ok) {
            return {
              ok: false,
              status: "integrity-failure",
              detail: "An in-memory Control Action failed structural validation.",
              storage: "memory",
            } satisfies FoundationStorageReadiness;
          }
          const provenance = this.state.actionProvenance
            .get(recordId)
            ?.get(stored.action.operationId);
          if (provenance !== "current" && provenance !== "legacy") {
            return {
              ok: false,
              status: "integrity-failure",
              detail: "In-memory evidence provenance is missing.",
              storage: "memory",
            } satisfies FoundationStorageReadiness;
          }
          if (
            provenance === "current" &&
            stored.action.controlActionVersion !== CONTROL_ACTION_VERSION
          ) {
            return {
              ok: false,
              status: "integrity-failure",
              detail: "Current in-memory action evidence was downgraded.",
              storage: "memory",
            } satisfies FoundationStorageReadiness;
          }
          if (
            provenance === "legacy" &&
            stored.action.controlActionVersion !== LEGACY_CONTROL_ACTION_VERSION
          ) {
            return {
              ok: false,
              status: "integrity-failure",
              detail: "Legacy in-memory action evidence is inconsistent.",
              storage: "memory",
            } satisfies FoundationStorageReadiness;
          }
        }
      }
      for (const [recordId, actions] of this.state.actions) {
        const idempotency = this.state.idempotency.get(recordId);
        if (idempotency === undefined || idempotency.size !== actions.size) {
          return {
            ok: false,
            status: "integrity-failure",
            detail: "In-memory action and idempotency state is inconsistent.",
            storage: "memory",
          } satisfies FoundationStorageReadiness;
        }
        for (const stored of actions.values()) {
          const expectedId = actionIdentity(stored.action.recordId, stored.action.operationId);
          const entry = idempotency.get(expectedId);
          if (
            entry === undefined ||
            entry.actionId !== expectedId ||
            entry.recordId !== stored.action.recordId ||
            entry.operationId !== stored.action.operationId ||
            entry.contentFingerprint !== stored.contentFingerprint ||
            entry.acceptedAtMs !== stored.action.acceptedAtMs
          ) {
            return {
              ok: false,
              status: "integrity-failure",
              detail: "In-memory action and idempotency state is inconsistent.",
              storage: "memory",
            } satisfies FoundationStorageReadiness;
          }
        }
      }
      for (const [recordId, audits] of this.state.controlAudits) {
        for (const entry of audits.values()) {
          const provenance = this.state.auditProvenance.get(recordId)?.get(entry.auditId);
          if (
            (provenance === "current" && entry.auditVersion !== CONTROL_AUDIT_VERSION) ||
            (provenance === "legacy" && entry.auditVersion !== LEGACY_CONTROL_AUDIT_VERSION)
          ) {
            return {
              ok: false,
              status: "integrity-failure",
              detail: "In-memory audit evidence format is inconsistent.",
              storage: "memory",
            } satisfies FoundationStorageReadiness;
          }
        }
      }
      for (const [recordId, entries] of this.state.idempotency) {
        if (!this.state.actions.has(recordId) && entries.size > 0) {
          return {
            ok: false,
            status: "integrity-failure",
            detail: "In-memory idempotency state has entries without actions.",
            storage: "memory",
          } satisfies FoundationStorageReadiness;
        }
      }
      const grantFailure = this.grantStateFailure();
      if (grantFailure !== null) {
        return {
          ok: false,
          status: "integrity-failure",
          detail: grantFailure,
          storage: "memory",
        } satisfies FoundationStorageReadiness;
      }
      const acceptanceFailure = acceptanceStateFailure(
        this.state,
        this.grantValidationContext.keyRing,
      );
      if (acceptanceFailure !== null) {
        return {
          ok: false,
          status: "integrity-failure",
          detail: acceptanceFailure,
          storage: "memory",
        } satisfies FoundationStorageReadiness;
      }
      return {
        ok: true,
        schemaVersion: "memory",
        storage: "memory",
      } satisfies FoundationStorageReadiness;
    });
  }

  close(): void {
    this.closed = true;
  }

  setGrantKeyRing(keyRing: GrantKeyRing): void {
    if (
      !this.state.grantAdmissionAnchorInstalled &&
      (this.state.grantAdmissionTelemetry.size > 0 ||
        this.state.grantAdmissionGlobalWindows.size > 0)
    ) {
      throw new Error(
        "Pending schema-17 Grant admission state cannot be keyed after rows were installed.",
      );
    }
    const previousContext = this.grantValidationContext;
    this.grantValidationContext = { ...this.grantValidationContext, keyRing };
    try {
      if (!this.state.grantAdmissionAnchorInstalled) this.rebuildGrantAdmissionStateAnchor();
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

  setGrantValidationContext(context: GrantStateValidationContext): void {
    this.grantValidationContext = {
      ...this.grantValidationContext,
      ...context,
      ...(context.migrationProvenance === undefined
        ? {}
        : { migrationProvenance: new Map(context.migrationProvenance) }),
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new FoundationStorageClosedError();
  }

  private grantStateFailure(): string | null {
    if (
      (this.state.grants.size > 0 ||
        this.state.grantAdmissionTelemetry.size > 0 ||
        this.state.grantAdmissionGlobalWindows.size > 0) &&
      this.grantValidationContext.keyRing === undefined
    ) {
      return "Grant key material is required for authoritative Grant state.";
    }
    const failure = validateGrantState(
      this.state.grants.values(),
      this.state.sessions.values(),
      this.state.grantAudits.values(),
      {
        ...this.grantValidationContext,
        auditProvenance: this.state.grantAuditProvenance,
        auditIntegrityTags: this.state.grantAuditIntegrityTags,
        admissionTelemetry: this.state.grantAdmissionTelemetry.values(),
        admissionGlobalWindows: this.state.grantAdmissionGlobalWindows.values(),
      },
    );
    if (failure !== null) return failure;
    const keyRing = this.grantValidationContext.keyRing;
    if (keyRing === undefined) {
      if (this.state.grantAdmissionStateAnchor !== null)
        return "Grant admission state anchor requires the Grant key ring.";
      return this.state.grants.size === 0
        ? null
        : "Grant key material is required for authoritative Grant state.";
    }
    const admissionAnchor = this.state.grantAdmissionStateAnchor;
    if (admissionAnchor === null) return "Grant admission state anchor evidence is incomplete.";
    const admissionMaterial = grantAdmissionStateMaterial(
      this.state.grantAdmissionTelemetry.values(),
      this.state.grantAdmissionGlobalWindows.values(),
    );
    const keyVersion = admissionAnchor.integrityTag.split(":")[1];
    const computedAdmission = computeGrantAdmissionStateAnchor(
      admissionMaterial,
      keyRing,
      keyVersion,
    );
    if (
      admissionAnchor.anchorVersion !== 1 ||
      admissionAnchor.stateDigest !== computedAdmission.stateDigest ||
      admissionAnchor.integrityTag !== computedAdmission.integrityTag
    )
      return "Grant admission state anchor integrity is invalid.";
    if (this.state.grants.size === 0) return null;
    const material = grantStateMaterial(
      this.state.grants.values(),
      this.state.sessions.values(),
      this.state.grantAudits.values(),
      this.state.grantAdmissionTelemetry.values(),
      this.state.grantAdmissionGlobalWindows.values(),
    );
    for (const grant of this.state.grants.values()) {
      const audits = orderGrantAudits(
        [...this.state.grantAudits.values()].filter((entry) => entry.grantId === grant.grantId),
      );
      const head = audits.at(-1);
      const stored = this.state.grantStateAnchors.get(grant.grantId);
      if (head === undefined || stored === undefined)
        return "Grant state anchor evidence is incomplete.";
      const keyVersion = stored.integrityTag.split(":")[1];
      const computed = computeGrantStateAnchor(material, keyRing, keyVersion);
      if (
        stored.auditCount !== audits.length ||
        stored.auditHeadId !== head.auditId ||
        stored.stateDigest !== computed.stateDigest ||
        stored.integrityTag !== computed.integrityTag
      )
        return "Grant state anchor integrity is invalid.";
    }
    return null;
  }

  private rebuildGrantStateAnchors(): void {
    if (this.state.grants.size === 0) return;
    const keyRing = this.grantValidationContext.keyRing;
    if (keyRing === undefined) throw new Error("Grant state anchors require the Grant key ring.");
    const material = grantStateMaterial(
      this.state.grants.values(),
      this.state.sessions.values(),
      this.state.grantAudits.values(),
      this.state.grantAdmissionTelemetry.values(),
      this.state.grantAdmissionGlobalWindows.values(),
    );
    for (const grant of this.state.grants.values()) {
      const audits = orderGrantAudits(
        [...this.state.grantAudits.values()].filter((entry) => entry.grantId === grant.grantId),
      );
      const head = audits.at(-1);
      if (head === undefined) continue;
      const computed = computeGrantStateAnchor(material, keyRing);
      this.state.grantStateAnchors.set(grant.grantId, {
        auditCount: audits.length,
        auditHeadId: head.auditId,
        stateDigest: computed.stateDigest,
        integrityTag: computed.integrityTag,
      });
    }
  }

  private rebuildGrantAdmissionStateAnchor(): void {
    const keyRing = this.grantValidationContext.keyRing;
    if (keyRing === undefined) return;
    const computed = computeGrantAdmissionStateAnchor(
      grantAdmissionStateMaterial(
        this.state.grantAdmissionTelemetry.values(),
        this.state.grantAdmissionGlobalWindows.values(),
      ),
      keyRing,
    );
    this.state.grantAdmissionStateAnchor = {
      anchorVersion: 1,
      ...computed,
    };
    this.state.grantAdmissionAnchorInstalled = true;
  }
}

function acceptanceStateFailure(
  state: MemoryState,
  keyRing: GrantKeyRing | undefined,
): string | null {
  if (
    keyRing === undefined &&
    (state.integrityAnchors.size > 0 ||
      state.acceptanceBudgets.size > 0 ||
      state.replayReservations.size > 0 ||
      state.replayAttempts.size > 0 ||
      state.replayReceipts.size > 0)
  )
    return "Acceptance integrity key material is unavailable.";
  if (keyRing === undefined) return null;
  for (const budget of state.acceptanceBudgets.values()) {
    if (
      budget.bucketId !== `budget-${budget.bucketKind}:${budget.subjectId}` ||
      !Number.isFinite(budget.tokens) ||
      budget.capacity <= 0 ||
      budget.refillPerSecond <= 0 ||
      budget.tokens < 0 ||
      budget.tokens > budget.capacity ||
      !Number.isSafeInteger(budget.updatedAtMs) ||
      !Number.isSafeInteger(budget.stateRevision) ||
      !hasCurrentIntegrityAnchor(state, "budget", budget.bucketId, budget, keyRing)
    )
      return "In-memory acceptance budget state is inconsistent.";
  }
  const attemptsByReservation = new Map<string, StoredReplayAttempt[]>();
  for (const attempt of state.replayAttempts.values()) {
    const list = attemptsByReservation.get(attempt.reservationId) ?? [];
    list.push(attempt);
    attemptsByReservation.set(attempt.reservationId, list);
  }
  const receiptsByReservation = new Map<string, StoredReplayReceipt[]>();
  for (const receipt of state.replayReceipts.values()) {
    const list = receiptsByReservation.get(receipt.reservationId) ?? [];
    list.push(receipt);
    receiptsByReservation.set(receipt.reservationId, list);
  }
  for (const reservation of state.replayReservations.values()) {
    const root = state.roots.get(reservation.recordId);
    if (
      root === undefined ||
      root.root.eventGameId !== reservation.eventGameId ||
      reservation.actionCount <= 0 ||
      !Number.isSafeInteger(reservation.createdAtMs) ||
      (reservation.committedAtMs !== null && !Number.isSafeInteger(reservation.committedAtMs)) ||
      (reservation.acknowledgedAtMs !== null &&
        !Number.isSafeInteger(reservation.acknowledgedAtMs)) ||
      reservation.batchDigest === null ||
      !/^[a-f0-9]{64}$/.test(reservation.batchDigest) ||
      !Number.isSafeInteger(reservation.stateRevision) ||
      !hasCurrentIntegrityAnchor(
        state,
        "reservation",
        reservation.reservationId,
        reservation,
        keyRing,
      ) ||
      !["reserved", "committing", "committed", "partial", "discarded", "acknowledged"].includes(
        reservation.status,
      )
    )
      return "In-memory replay reservation state is inconsistent.";
    if (
      reservation.status === "discarded" &&
      (reservation.batchDigest !== null || reservation.replacementSessionId !== null)
    )
      return "In-memory discarded replay retained authorization provenance.";
    if (
      (reservation.status === "committed" || reservation.status === "acknowledged") &&
      reservation.committedAtMs === null
    )
      return "In-memory committed replay lacks a commit timestamp.";
    if (reservation.status === "acknowledged" && reservation.acknowledgedAtMs === null)
      return "In-memory acknowledged replay lacks an acknowledgement timestamp.";
    const attempts = attemptsByReservation.get(reservation.reservationId) ?? [];
    const receipts = receiptsByReservation.get(reservation.reservationId) ?? [];
    if (
      (reservation.status === "reserved" && (attempts.length !== 0 || receipts.length !== 0)) ||
      (reservation.status === "partial" &&
        (attempts.length === 0 ||
          attempts.length > reservation.actionCount ||
          receipts.length !== 0)) ||
      ((reservation.status === "committed" || reservation.status === "acknowledged") &&
        (attempts.length !== reservation.actionCount ||
          attempts.some((attempt) => attempt.status === "retry-later") ||
          receipts.length !== 1)) ||
      (reservation.status === "discarded" && (attempts.length !== 0 || receipts.length !== 0))
    )
      return "In-memory replay evidence cardinality is inconsistent.";
  }
  const grantsByAudit = state.grantAudits;
  for (const attempt of state.replayAttempts.values()) {
    const controlAudit = [...state.controlAudits.values()]
      .flatMap((audits) => [...audits.values()])
      .find((audit) => audit.auditId === attempt.controlAuditId);
    const grantAudit = grantsByAudit.get(attempt.grantAuditId ?? "");
    const pairFailure =
      controlAudit === undefined || grantAudit === undefined
        ? "missing"
        : acceptanceAuditPairFailure(controlAudit, grantAudit, attempt);
    const expectedAction =
      controlAudit === undefined ||
      (controlAudit.kind !== "action-accepted" && controlAudit.kind !== "action-duplicate")
        ? undefined
        : state.actions.get(controlAudit.recordId)?.get(controlAudit.operationId ?? "")?.action;
    const durableFingerprint =
      controlAudit === undefined || grantAudit === undefined
        ? null
        : acceptanceFingerprintFailure(state, controlAudit, grantAudit, attempt);
    if (
      !state.replayReservations.has(attempt.reservationId) ||
      attempt.operationId.length === 0 ||
      (attempt.actionFingerprint !== null && !/^[a-f0-9]{64}$/.test(attempt.actionFingerprint)) ||
      attempt.resultJson === null ||
      replayAttemptResultFailure(attempt, expectedAction, controlAudit?.links?.reason) !== null ||
      attempt.controlAuditId === null ||
      attempt.grantAuditId === null ||
      controlAudit === undefined ||
      grantAudit === undefined ||
      grantAudit.controlAuditId !== controlAudit.auditId ||
      controlAudit.links?.grantAuditId !== grantAudit.auditId ||
      grantAudit.acceptanceId !== controlAudit.links?.acceptanceId ||
      grantAudit.contentFingerprint === null ||
      (attempt.actionFingerprint !== null &&
        attempt.actionFingerprint !== grantAudit.contentFingerprint) ||
      pairFailure !== null ||
      durableFingerprint !== null
    )
      return "In-memory replay attempt state is inconsistent.";
    if (
      !Number.isSafeInteger(attempt.createdAtMs) ||
      (attempt.completedAtMs !== null && !Number.isSafeInteger(attempt.completedAtMs)) ||
      !Number.isSafeInteger(attempt.stateRevision) ||
      !hasCurrentIntegrityAnchor(state, "attempt", attempt.attemptId, attempt, keyRing) ||
      (attempt.status === "retry-later") !== (attempt.completedAtMs === null)
    )
      return "In-memory replay attempt timestamps are inconsistent.";
  }
  for (const receipt of state.replayReceipts.values()) {
    const reservation = state.replayReservations.get(receipt.reservationId);
    if (
      reservation === undefined ||
      receipt.actionCount !== reservation.actionCount ||
      !/^[a-f0-9]{64}$/.test(receipt.receiptDigest) ||
      !["committed", "acknowledged"].includes(receipt.status) ||
      !Number.isSafeInteger(receipt.stateRevision) ||
      !hasCurrentIntegrityAnchor(state, "receipt", receipt.receiptId, receipt, keyRing)
    )
      return "In-memory replay receipt state is inconsistent.";
    if (
      !Number.isSafeInteger(receipt.createdAtMs) ||
      (receipt.acknowledgedAtMs !== null && !Number.isSafeInteger(receipt.acknowledgedAtMs)) ||
      (receipt.status === "acknowledged") !== (receipt.acknowledgedAtMs !== null)
    )
      return "In-memory replay receipt timestamps are inconsistent.";
    if (reservation.status !== "committed" && reservation.status !== "acknowledged")
      return "In-memory replay receipt points to an uncommitted reservation.";
  }
  for (const audits of state.controlAudits.values()) {
    for (const audit of audits.values()) {
      const grantAuditId = audit.links?.grantAuditId;
      if (typeof grantAuditId === "string") {
        const grantAudit = grantsByAudit.get(grantAuditId);
        if (
          grantAudit === undefined ||
          acceptanceAuditPairFailure(audit, grantAudit) !== null ||
          acceptanceFingerprintFailure(state, audit, grantAudit) !== null
        )
          return "In-memory Control and Grant audit linkage is inconsistent.";
      }
    }
  }
  for (const grantAudit of grantsByAudit.values()) {
    const hasAcceptanceFields =
      (grantAudit.acceptanceId !== null && grantAudit.acceptanceId !== undefined) ||
      (grantAudit.controlAuditId !== null && grantAudit.controlAuditId !== undefined) ||
      (grantAudit.controlActionId !== null && grantAudit.controlActionId !== undefined) ||
      (grantAudit.contentFingerprint !== null && grantAudit.contentFingerprint !== undefined) ||
      (grantAudit.outcomeDetail !== null && grantAudit.outcomeDetail !== undefined);
    if (hasAcceptanceFields) {
      const control = [...state.controlAudits.values()]
        .flatMap((audits) => [...audits.values()])
        .find((audit) => audit.auditId === grantAudit.controlAuditId);
      if (
        control === undefined ||
        acceptanceAuditPairFailure(control, grantAudit) !== null ||
        acceptanceFingerprintFailure(state, control, grantAudit) !== null
      )
        return "In-memory Grant acceptance evidence has no paired Control audit.";
    }
  }
  const currentRevisions = new Map<string, number>();
  for (const budget of state.acceptanceBudgets.values())
    currentRevisions.set(`budget:${budget.bucketId}`, budget.stateRevision);
  for (const reservation of state.replayReservations.values())
    currentRevisions.set(`reservation:${reservation.reservationId}`, reservation.stateRevision);
  for (const attempt of state.replayAttempts.values())
    currentRevisions.set(
      `attempt:${attempt.reservationId}:${attempt.attemptId}`,
      attempt.stateRevision,
    );
  for (const receipt of state.replayReceipts.values())
    currentRevisions.set(`receipt:${receipt.receiptId}`, receipt.stateRevision);

  const anchorGroups = new Map<string, AcceptanceIntegrityAnchor[]>();
  for (const anchor of state.integrityAnchors.values()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(anchor.canonicalValue) as unknown;
    } catch {
      return "In-memory acceptance integrity anchor evidence is not valid JSON.";
    }
    if (
      canonicalizeJson(parsed) !== anchor.canonicalValue ||
      anchor.anchorId !== `${anchor.subjectKind}:${anchor.subjectId}:${anchor.stateRevision}`
    )
      return "In-memory acceptance integrity anchor identity is inconsistent.";
    let expectedTag: string;
    try {
      expectedTag = computeAcceptanceIntegrityTag(
        canonicalizeJson({
          domain: "foundation-acceptance-state-v1",
          subjectKind: anchor.subjectKind,
          subjectId: anchor.subjectId,
          stateRevision: anchor.stateRevision,
          value: parsed,
        }),
        keyRing,
        anchor.keyVersion,
      );
    } catch {
      return "In-memory acceptance integrity anchor key material is unavailable.";
    }
    if (anchor.integrityTag !== expectedTag)
      return "In-memory acceptance integrity anchor authentication failed.";
    const key = `${anchor.subjectKind}:${anchor.subjectId}`;
    const group = anchorGroups.get(key) ?? [];
    group.push(anchor);
    anchorGroups.set(key, group);
  }
  for (const [key, group] of anchorGroups) {
    const currentRevision = currentRevisions.get(key);
    if (currentRevision === undefined || group.length !== currentRevision)
      return "In-memory acceptance integrity anchor history is missing or orphaned.";
    const revisions = group.map((anchor) => anchor.stateRevision).sort((a, b) => a - b);
    if (revisions.some((revision, index) => revision !== index + 1))
      return "In-memory acceptance integrity anchor history is not contiguous.";
  }
  if (anchorGroups.size !== currentRevisions.size)
    return "In-memory acceptance integrity anchor history has an extra or missing subject.";

  const maximumAnchorRevision = new Map<string, number>();
  for (const anchor of state.integrityAnchors.values()) {
    const key = `${anchor.subjectKind}:${anchor.subjectId}`;
    maximumAnchorRevision.set(
      key,
      Math.max(maximumAnchorRevision.get(key) ?? 0, anchor.stateRevision),
    );
  }
  for (const [subjectId, budget] of state.acceptanceBudgets) {
    if (maximumAnchorRevision.get(`budget:${subjectId}`) !== budget.stateRevision)
      return "In-memory acceptance integrity history is not monotonic.";
  }
  for (const [subjectId, reservation] of state.replayReservations) {
    if (maximumAnchorRevision.get(`reservation:${subjectId}`) !== reservation.stateRevision)
      return "In-memory acceptance integrity history is not monotonic.";
  }
  for (const attempt of state.replayAttempts.values()) {
    const anchorSubjectId = anchorFor("attempt", attempt, keyRing).subjectId;
    if (maximumAnchorRevision.get(`attempt:${anchorSubjectId}`) !== attempt.stateRevision)
      return "In-memory acceptance integrity history is not monotonic.";
  }
  for (const [subjectId, receipt] of state.replayReceipts) {
    if (maximumAnchorRevision.get(`receipt:${subjectId}`) !== receipt.stateRevision)
      return "In-memory acceptance integrity history is not monotonic.";
  }
  for (const anchor of state.integrityAnchors.values()) {
    const currentRevision =
      anchor.subjectKind === "budget"
        ? state.acceptanceBudgets.get(anchor.subjectId)?.stateRevision
        : anchor.subjectKind === "reservation"
          ? state.replayReservations.get(anchor.subjectId)?.stateRevision
          : anchor.subjectKind === "attempt"
            ? state.replayAttempts.get(
                anchor.subjectId.slice(anchor.subjectId.lastIndexOf(":") + 1),
              )?.stateRevision
            : state.replayReceipts.get(anchor.subjectId)?.stateRevision;
    if (currentRevision === undefined) return "In-memory acceptance integrity anchor is orphaned.";
    if (anchor.stateRevision > currentRevision)
      return "In-memory acceptance integrity anchor is orphaned.";
  }
  return null;
}

function acceptanceFingerprintFailure(
  state: MemoryState,
  control: StoredControlAuditEntry,
  grant: StoredGrantAuditEntry,
  attempt?: StoredReplayAttempt,
): string | null {
  const operationId = control.operationId;
  if (operationId === null || grant.contentFingerprint === null) return "missing";
  const accepted = control.kind === "action-accepted" || control.kind === "action-duplicate";
  const durableAction = state.actions.get(control.recordId)?.get(operationId);
  const collisionFingerprint = control.links?.collision?.rejectedAttempt?.contentFingerprint;
  const candidateFingerprint =
    collisionFingerprint ?? control.links?.rejectedCandidate?.contentFingerprint;
  const expectedFingerprint = accepted ? durableAction?.contentFingerprint : candidateFingerprint;
  if (
    expectedFingerprint === undefined ||
    control.links?.contentFingerprint !== expectedFingerprint ||
    expectedFingerprint !== grant.contentFingerprint
  )
    return "fingerprint";
  if (attempt !== undefined && attempt.actionFingerprint !== expectedFingerprint)
    return "fingerprint";
  if (accepted) {
    const idempotency = [...(state.idempotency.get(control.recordId)?.values() ?? [])].find(
      (entry) => entry.operationId === operationId,
    );
    if (
      durableAction === undefined ||
      idempotency === undefined ||
      idempotency.contentFingerprint !== expectedFingerprint ||
      idempotency.contentFingerprint !== grant.contentFingerprint
    )
      return "fingerprint";
  }
  return null;
}

function hasCurrentIntegrityAnchor(
  state: MemoryState,
  subjectKind: AcceptanceIntegritySubject,
  subjectId: string,
  value:
    | StoredAcceptanceBudget
    | StoredReplayReservation
    | StoredReplayAttempt
    | StoredReplayReceipt,
  keyRing: GrantKeyRing | undefined,
): boolean {
  if (keyRing === undefined) return false;
  const expected = anchorFor(subjectKind, value, keyRing);
  const anchor = state.integrityAnchors.get(
    `${subjectKind}:${expected.subjectId}:${value.stateRevision}`,
  );
  if (anchor === undefined) return false;
  const keyedExpected = anchorFor(subjectKind, value, keyRing, anchor.keyVersion);
  return (
    anchor.subjectId === keyedExpected.subjectId &&
    anchor.stateRevision === keyedExpected.stateRevision &&
    anchor.keyVersion === keyedExpected.keyVersion &&
    anchor.canonicalValue === keyedExpected.canonicalValue &&
    anchor.integrityTag === keyedExpected.integrityTag
  );
}

function createTransaction(
  state: MemoryState,
  undo: (() => void)[],
  revision: number,
  keyRing: GrantKeyRing | undefined,
): FoundationStorageTransaction {
  return {
    revision,
    findRootByRecordId(recordId) {
      return cloneRoot(state.roots.get(recordId));
    },
    findRootByEventGameId(eventGameId) {
      return findRoot(state.roots, (stored) => stored.root.eventGameId === eventGameId);
    },
    findRootByPitchSlotId(pitchSlotId) {
      return findRoot(
        state.roots,
        (stored) => stored.root.externalScope.pitchSlotId === pitchSlotId,
      );
    },
    findRootByGameSideId(gameSideId) {
      return findRoot(state.roots, (stored) =>
        stored.root.gameSides.some((side) => side.id === gameSideId),
      );
    },
    findActionByOperationId(recordId, operationId) {
      return cloneAction(
        state.actions.get(recordId)?.get(operationId),
        state.actionProvenance.get(recordId)?.get(operationId),
      );
    },
    listActions(recordId) {
      return cloneActions(state.actions.get(recordId), state.actionProvenance.get(recordId));
    },
    listIdempotencyEntries(recordId) {
      return [...(state.idempotency.get(recordId)?.values() ?? [])].map((entry) =>
        structuredClone(entry),
      );
    },
    readRecordMetadata(recordId) {
      const metadata = state.metadata.get(recordId);
      return metadata === undefined ? null : structuredClone(metadata);
    },
    listAuditEntries(recordId) {
      return cloneAudits(state.controlAudits.get(recordId), state.auditProvenance.get(recordId));
    },
    findEvent(eventId) {
      const event = state.events.get(eventId);
      return event === undefined ? null : structuredClone(event);
    },
    listEvents() {
      return [...state.events.values()]
        .sort((left, right) => left.eventId.localeCompare(right.eventId))
        .map((event) => structuredClone(event));
    },
    listGameDays(eventId) {
      return [...state.gameDays.values()]
        .filter((gameDay) => gameDay.eventId === eventId)
        .sort((left, right) =>
          left.date === right.date
            ? left.gameDayId.localeCompare(right.gameDayId)
            : left.date.localeCompare(right.date),
        )
        .map((gameDay) => structuredClone(gameDay));
    },
    listEventAuditTrail(eventId) {
      return [...state.eventAudits.values()]
        .filter((audit) => audit.eventId === eventId)
        .sort((left, right) =>
          left.occurredAtMs === right.occurredAtMs
            ? left.auditId.localeCompare(right.auditId)
            : left.occurredAtMs - right.occurredAtMs,
        )
        .map((audit) => structuredClone(audit));
    },
    insertEvent(event) {
      if (state.events.has(event.eventId)) {
        throw new FoundationStorageConstraintError("event-id");
      }
      state.events.set(event.eventId, structuredClone(event));
      undo.push(() => state.events.delete(event.eventId));
    },
    updateEvent(event) {
      if (!state.events.has(event.eventId)) {
        throw new FoundationStorageConstraintError("event-id");
      }
      const previous = state.events.get(event.eventId);
      state.events.set(event.eventId, structuredClone(event));
      undo.push(() => {
        if (previous === undefined) state.events.delete(event.eventId);
        else state.events.set(event.eventId, previous);
      });
    },
    deleteEvent(eventId) {
      const previous = state.events.get(eventId);
      if (previous === undefined) throw new FoundationStorageConstraintError("event-id");
      state.events.delete(eventId);
      undo.push(() => state.events.set(eventId, previous));
    },
    insertGameDay(gameDay) {
      if (!state.events.has(gameDay.eventId)) {
        throw new FoundationStorageConstraintError("event-id");
      }
      if (state.gameDays.has(gameDay.gameDayId)) {
        throw new FoundationStorageConstraintError("game-day-id");
      }
      if (
        [...state.gameDays.values()].some(
          (candidate) => candidate.eventId === gameDay.eventId && candidate.date === gameDay.date,
        )
      ) {
        throw new FoundationStorageConstraintError("game-day-date");
      }
      state.gameDays.set(gameDay.gameDayId, structuredClone(gameDay));
      undo.push(() => state.gameDays.delete(gameDay.gameDayId));
    },
    updateGameDay(gameDay) {
      const previous = state.gameDays.get(gameDay.gameDayId);
      if (previous === undefined) throw new FoundationStorageConstraintError("game-day-id");
      if (
        [...state.gameDays.values()].some(
          (candidate) =>
            candidate.gameDayId !== gameDay.gameDayId &&
            candidate.eventId === gameDay.eventId &&
            candidate.date === gameDay.date,
        )
      ) {
        throw new FoundationStorageConstraintError("game-day-date");
      }
      state.gameDays.set(gameDay.gameDayId, structuredClone(gameDay));
      undo.push(() => state.gameDays.set(gameDay.gameDayId, previous));
    },
    deleteGameDay(gameDayId) {
      const previous = state.gameDays.get(gameDayId);
      if (previous === undefined) throw new FoundationStorageConstraintError("game-day-id");
      state.gameDays.delete(gameDayId);
      undo.push(() => state.gameDays.set(gameDayId, previous));
    },
    appendEventAudit(entry) {
      if (state.eventAudits.has(entry.auditId)) {
        throw new FoundationStorageConstraintError("event-audit-id");
      }
      if (
        [...state.eventAudits.values()].some(
          (candidate) => candidate.operationId === entry.operationId,
        )
      ) {
        throw new FoundationStorageConstraintError("event-operation-id");
      }
      state.eventAudits.set(entry.auditId, structuredClone(entry));
      undo.push(() => state.eventAudits.delete(entry.auditId));
    },
    insertRoot(storedRoot) {
      if (state.roots.has(storedRoot.root.recordId)) {
        throw new FoundationStorageConstraintError("record-id");
      }
      if (
        findRoot(state.roots, (stored) => stored.root.eventGameId === storedRoot.root.eventGameId)
      ) {
        throw new FoundationStorageConstraintError("event-game-id");
      }
      if (
        findRoot(
          state.roots,
          (stored) =>
            stored.root.externalScope.pitchSlotId === storedRoot.root.externalScope.pitchSlotId,
        )
      ) {
        throw new FoundationStorageConstraintError("pitch-slot-id");
      }
      for (const side of storedRoot.root.gameSides) {
        if (
          findRoot(state.roots, (stored) =>
            stored.root.gameSides.some((candidate) => candidate.id === side.id),
          )
        ) {
          throw new FoundationStorageConstraintError("game-side-id");
        }
      }
      state.roots.set(storedRoot.root.recordId, {
        root: cloneEventGameRecordRoot(storedRoot.root),
        canonicalContent: storedRoot.canonicalContent,
      });
      undo.push(() => state.roots.delete(storedRoot.root.recordId));
    },
    insertAction(storedAction) {
      const { action } = storedAction;
      if (!state.roots.has(action.recordId)) {
        throw new FoundationStorageConstraintError("record-id");
      }
      let actions = state.actions.get(action.recordId);
      if (actions === undefined) {
        actions = new Map();
        state.actions.set(action.recordId, actions);
        undo.push(() => state.actions.delete(action.recordId));
      }
      if (actions.has(action.operationId)) {
        throw new FoundationStorageConstraintError("operation-id");
      }
      actions.set(action.operationId, {
        ...structuredClone(storedAction),
        durableFormat: "current",
      });
      let provenance = state.actionProvenance.get(action.recordId);
      if (provenance === undefined) {
        provenance = new Map();
        state.actionProvenance.set(action.recordId, provenance);
        undo.push(() => state.actionProvenance.delete(action.recordId));
      }
      provenance.set(action.operationId, "current");
      undo.push(() => provenance?.delete(action.operationId));
      undo.push(() => actions?.delete(action.operationId));
      const actionId = actionIdentity(action.recordId, action.operationId);
      let idempotency = state.idempotency.get(action.recordId);
      if (idempotency === undefined) {
        idempotency = new Map();
        state.idempotency.set(action.recordId, idempotency);
        undo.push(() => state.idempotency.delete(action.recordId));
      }
      if (idempotency.has(actionId)) {
        throw new FoundationStorageConstraintError("operation-id");
      }
      idempotency.set(actionId, {
        actionId,
        recordId: action.recordId,
        operationId: action.operationId,
        contentFingerprint: storedAction.contentFingerprint,
        acceptedAtMs: action.acceptedAtMs,
      });
      undo.push(() => idempotency?.delete(actionId));
    },
    upsertRecordMetadata(metadata) {
      const previous = state.metadata.get(metadata.recordId);
      state.metadata.set(metadata.recordId, structuredClone(metadata));
      undo.push(() => {
        if (previous === undefined) state.metadata.delete(metadata.recordId);
        else state.metadata.set(metadata.recordId, previous);
      });
    },
    appendAuditEntry(entry) {
      let audits = state.controlAudits.get(entry.recordId);
      if (audits === undefined) {
        audits = new Map();
        state.controlAudits.set(entry.recordId, audits);
        undo.push(() => state.controlAudits.delete(entry.recordId));
      }
      if (audits.has(entry.auditId)) {
        throw new FoundationStorageConstraintError("audit-id");
      }
      audits.set(entry.auditId, {
        ...structuredClone(entry),
        durableFormat: "current",
      });
      let provenance = state.auditProvenance.get(entry.recordId);
      if (provenance === undefined) {
        provenance = new Map();
        state.auditProvenance.set(entry.recordId, provenance);
        undo.push(() => state.auditProvenance.delete(entry.recordId));
      }
      provenance.set(entry.auditId, "current");
      undo.push(() => provenance?.delete(entry.auditId));
      undo.push(() => audits?.delete(entry.auditId));
    },
    findGrantById(grantId) {
      const grant = state.grants.get(grantId);
      return grant === undefined ? null : cloneStoredGrant(grant);
    },
    listGrants() {
      return [...state.grants.values()]
        .sort((left, right) => left.grantId.localeCompare(right.grantId))
        .map(cloneStoredGrant);
    },
    findGrantByCredentialLookupDigest(lookupDigest) {
      return findGrant(state.grants, (grant) => grant.credential.lookupDigest === lookupDigest);
    },
    findGrantByCodeLookupDigest(lookupDigest) {
      return findGrant(state.grants, (grant) => grant.code?.lookupDigest === lookupDigest);
    },
    findActiveSessionByGrantAndContext(grantId, browserContextDigest) {
      return findSession(
        state.sessions,
        (session) =>
          session.grantId === grantId &&
          session.browserContextDigest === browserContextDigest &&
          session.status === "active",
      );
    },
    findSessionByBearerVerifier(bearerLookupVerifier, bearerLookupKeyVersion) {
      return findSession(
        state.sessions,
        (session) =>
          session.bearerLookupVerifier === bearerLookupVerifier &&
          session.bearerLookupKeyVersion === bearerLookupKeyVersion,
      );
    },
    listGrantSessions(grantId) {
      return [...state.sessions.values()]
        .filter((session) => session.grantId === grantId)
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
        .map(cloneStoredGrantSession);
    },
    listGrantAudit(grantId) {
      return orderGrantAudits(
        [...state.grantAudits.values()].filter((entry) => entry.grantId === grantId),
      ).map(cloneStoredGrantAuditEntry);
    },
    readGrantAdmissionTelemetry(mode, sourceDigest) {
      const value = state.grantAdmissionTelemetry.get(`${mode}:${sourceDigest}`);
      return value === undefined ? null : structuredClone(value);
    },
    readGrantAdmissionGlobalWindow(mode) {
      const value = state.grantAdmissionGlobalWindows.get(mode);
      return value === undefined ? null : structuredClone(value);
    },
    readGrantAdmissionStateAnchor() {
      return state.grantAdmissionStateAnchor === null
        ? null
        : structuredClone(state.grantAdmissionStateAnchor);
    },
    findAcceptanceBudget(bucketId) {
      const budget = state.acceptanceBudgets.get(bucketId);
      return budget === undefined ? null : structuredClone(budget);
    },
    findReplayReservation(reservationId) {
      const reservation = state.replayReservations.get(reservationId);
      return reservation === undefined ? null : structuredClone(reservation);
    },
    findReplayReservationByTuple(
      recordId,
      eventGameId,
      originatingSessionId,
      actionCount,
      batchDigest,
    ) {
      let match: StoredReplayReservation | undefined;
      for (const reservation of state.replayReservations.values()) {
        if (
          reservation.recordId === recordId &&
          reservation.eventGameId === eventGameId &&
          reservation.originatingSessionId === originatingSessionId &&
          reservation.actionCount === actionCount &&
          reservation.batchDigest === batchDigest
        )
          if (match !== undefined) return null;
          else match = reservation;
      }
      return match === undefined ? null : structuredClone(match);
    },
    findReplayReservationByOriginTuple(recordId, eventGameId, originatingSessionId, actionCount) {
      return (
        [...state.replayReservations.values()]
          .filter(
            (reservation) =>
              reservation.recordId === recordId &&
              reservation.eventGameId === eventGameId &&
              reservation.originatingSessionId === originatingSessionId &&
              reservation.actionCount === actionCount,
          )
          .sort((left, right) => right.stateRevision - left.stateRevision)
          .map((reservation) => structuredClone(reservation))[0] ?? null
      );
    },
    listReplayAttempts(reservationId) {
      return [...state.replayAttempts.values()]
        .filter((attempt) => attempt.reservationId === reservationId)
        .sort((left, right) => left.attemptId.localeCompare(right.attemptId))
        .map((attempt) => structuredClone(attempt));
    },
    findReplayReceiptByDigest(receiptDigest) {
      for (const receipt of state.replayReceipts.values()) {
        if (receipt.receiptDigest === receiptDigest) return structuredClone(receipt);
      }
      return null;
    },
    findReplayReceiptByReservationId(reservationId) {
      for (const receipt of state.replayReceipts.values()) {
        if (receipt.reservationId === reservationId) return structuredClone(receipt);
      }
      return null;
    },
    listAcceptanceIntegrityAnchors(subjectKind: AcceptanceIntegritySubject, subjectId: string) {
      return [...state.integrityAnchors.values()]
        .filter((anchor) => anchor.subjectKind === subjectKind && anchor.subjectId === subjectId)
        .sort((left, right) => left.stateRevision - right.stateRevision)
        .map((anchor) => structuredClone(anchor));
    },
    insertGrant(grant) {
      if (state.grants.has(grant.grantId)) {
        throw new FoundationStorageConstraintError("grant-id");
      }
      if (findGrant(state.grants, (candidate) => candidate.grantVersion === grant.grantVersion)) {
        throw new FoundationStorageConstraintError("grant-version");
      }
      if (
        findGrant(
          state.grants,
          (candidate) =>
            grant.credential.lookupDigest !== null &&
            candidate.credential.lookupDigest === grant.credential.lookupDigest,
        )
      ) {
        throw new FoundationStorageConstraintError("grant-credential-digest");
      }
      if (
        grant.grantType === "control" &&
        findGrant(
          state.grants,
          (candidate) =>
            (candidate.scope as ControlGrantScope).pitchSlotId ===
            (grant.scope as ControlGrantScope).pitchSlotId,
        )
      ) {
        throw new FoundationStorageConstraintError("grant-pitch-slot-id");
      }
      if (
        grant.code?.lookupDigest !== null &&
        grant.code?.lookupDigest !== undefined &&
        findGrant(
          state.grants,
          (candidate) => candidate.code?.lookupDigest === grant.code?.lookupDigest,
        )
      )
        throw new FoundationStorageConstraintError("grant-code-digest");
      state.grants.set(grant.grantId, cloneStoredGrant(grant));
      undo.push(() => state.grants.delete(grant.grantId));
    },
    updateGrant(grant) {
      if (!state.grants.has(grant.grantId)) {
        throw new FoundationStorageConstraintError("grant-id");
      }
      if (
        findGrant(
          state.grants,
          (candidate) =>
            candidate.grantId !== grant.grantId && candidate.grantVersion === grant.grantVersion,
        )
      ) {
        throw new FoundationStorageConstraintError("grant-version");
      }
      if (
        grant.grantType === "control" &&
        findGrant(
          state.grants,
          (candidate) =>
            candidate.grantId !== grant.grantId &&
            (candidate.scope as ControlGrantScope).pitchSlotId ===
              (grant.scope as ControlGrantScope).pitchSlotId,
        )
      ) {
        throw new FoundationStorageConstraintError("grant-pitch-slot-id");
      }
      if (
        findGrant(
          state.grants,
          (candidate) =>
            candidate.grantId !== grant.grantId &&
            grant.credential.lookupDigest !== null &&
            candidate.credential.lookupDigest === grant.credential.lookupDigest,
        )
      ) {
        throw new FoundationStorageConstraintError("grant-credential-digest");
      }
      if (
        grant.code?.lookupDigest !== null &&
        grant.code?.lookupDigest !== undefined &&
        findGrant(
          state.grants,
          (candidate) =>
            candidate.grantId !== grant.grantId &&
            candidate.code?.lookupDigest === grant.code?.lookupDigest,
        )
      )
        throw new FoundationStorageConstraintError("grant-code-digest");
      const previous = state.grants.get(grant.grantId);
      state.grants.set(grant.grantId, cloneStoredGrant(grant));
      undo.push(() => {
        if (previous !== undefined) state.grants.set(grant.grantId, previous);
      });
    },
    insertGrantSession(session) {
      if (state.sessions.has(session.sessionId)) {
        throw new FoundationStorageConstraintError("grant-session-id");
      }
      if (
        findSession(
          state.sessions,
          (candidate) =>
            session.bearerLookupVerifier !== null &&
            candidate.bearerLookupVerifier === session.bearerLookupVerifier,
        )
      ) {
        throw new FoundationStorageConstraintError("grant-session-verifier");
      }
      if (
        session.status === "active" &&
        findSession(
          state.sessions,
          (candidate) =>
            candidate.grantId === session.grantId &&
            candidate.browserContextDigest === session.browserContextDigest &&
            candidate.status === "active",
        )
      ) {
        throw new FoundationStorageConstraintError("grant-session-context");
      }
      if (!state.grants.has(session.grantId)) {
        throw new FoundationStorageConstraintError("grant-id");
      }
      state.sessions.set(session.sessionId, cloneStoredGrantSession(session));
      undo.push(() => state.sessions.delete(session.sessionId));
    },
    updateGrantSession(session) {
      if (!state.sessions.has(session.sessionId)) {
        throw new FoundationStorageConstraintError("grant-session-id");
      }
      if (!state.grants.has(session.grantId)) {
        throw new FoundationStorageConstraintError("grant-id");
      }
      if (
        findSession(
          state.sessions,
          (candidate) =>
            candidate.sessionId !== session.sessionId &&
            session.bearerLookupVerifier !== null &&
            candidate.bearerLookupVerifier === session.bearerLookupVerifier,
        )
      ) {
        throw new FoundationStorageConstraintError("grant-session-verifier");
      }
      if (
        session.status === "active" &&
        findSession(
          state.sessions,
          (candidate) =>
            candidate.sessionId !== session.sessionId &&
            candidate.grantId === session.grantId &&
            candidate.browserContextDigest === session.browserContextDigest &&
            candidate.status === "active",
        )
      ) {
        throw new FoundationStorageConstraintError("grant-session-context");
      }
      const previous = state.sessions.get(session.sessionId);
      state.sessions.set(session.sessionId, cloneStoredGrantSession(session));
      undo.push(() => {
        if (previous !== undefined) state.sessions.set(session.sessionId, previous);
      });
    },
    appendGrantAudit(entry) {
      if (keyRing === undefined) {
        throw new Error("Grant Audit Trail integrity requires the Grant key ring.");
      }
      if (state.grantAudits.has(entry.auditId)) {
        throw new FoundationStorageConstraintError("grant-audit-id");
      }
      if (!state.grants.has(entry.grantId)) {
        throw new FoundationStorageConstraintError("grant-id");
      }
      const chained = bindGrantAuditChain(
        entry,
        [...state.grantAudits.values()].filter((candidate) => candidate.grantId === entry.grantId),
      );
      state.grantAudits.set(entry.auditId, cloneStoredGrantAuditEntry(chained));
      undo.push(() => state.grantAudits.delete(entry.auditId));
      state.grantAuditProvenance.set(entry.auditId, cloneStoredGrantAuditEntry(chained));
      undo.push(() => state.grantAuditProvenance.delete(entry.auditId));
      state.grantAuditIntegrityTags.set(
        entry.auditId,
        computeGrantAuditIntegrityTag(chained, keyRing),
      );
      undo.push(() => state.grantAuditIntegrityTags.delete(entry.auditId));
    },
    upsertAcceptanceBudget(budget) {
      const previous = state.acceptanceBudgets.get(budget.bucketId);
      state.acceptanceBudgets.set(budget.bucketId, structuredClone(budget));
      undo.push(() => {
        if (previous === undefined) state.acceptanceBudgets.delete(budget.bucketId);
        else state.acceptanceBudgets.set(budget.bucketId, previous);
      });
    },
    insertReplayReservation(reservation) {
      if (state.replayReservations.has(reservation.reservationId))
        throw new FoundationStorageConstraintError("replay-reservation-id");
      state.replayReservations.set(reservation.reservationId, structuredClone(reservation));
      undo.push(() => state.replayReservations.delete(reservation.reservationId));
    },
    updateReplayReservation(reservation) {
      if (!state.replayReservations.has(reservation.reservationId))
        throw new FoundationStorageConstraintError("replay-reservation-id");
      const previous = state.replayReservations.get(reservation.reservationId);
      state.replayReservations.set(reservation.reservationId, structuredClone(reservation));
      undo.push(() => {
        if (previous !== undefined)
          state.replayReservations.set(reservation.reservationId, previous);
      });
    },
    insertReplayAttempt(attempt) {
      if (state.replayAttempts.has(attempt.attemptId))
        throw new FoundationStorageConstraintError("integrity-anchor-id");
      state.replayAttempts.set(attempt.attemptId, structuredClone(attempt));
      undo.push(() => state.replayAttempts.delete(attempt.attemptId));
    },
    updateReplayAttempt(attempt) {
      if (!state.replayAttempts.has(attempt.attemptId))
        throw new FoundationStorageConstraintError("replay-attempt-id");
      const previous = state.replayAttempts.get(attempt.attemptId);
      state.replayAttempts.set(attempt.attemptId, structuredClone(attempt));
      undo.push(() => {
        if (previous !== undefined) state.replayAttempts.set(attempt.attemptId, previous);
      });
    },
    discardReplayAttempts(reservationId) {
      const previous = [...state.replayAttempts.entries()].filter(
        ([, attempt]) => attempt.reservationId === reservationId,
      );
      for (const [attemptId] of previous) state.replayAttempts.delete(attemptId);
      const previousAnchors = [...state.integrityAnchors.entries()].filter(
        ([, anchor]) =>
          anchor.subjectKind === "attempt" && anchor.subjectId.startsWith(`${reservationId}:`),
      );
      for (const [anchorId] of previousAnchors) state.integrityAnchors.delete(anchorId);
      undo.push(() => {
        for (const [attemptId, attempt] of previous) state.replayAttempts.set(attemptId, attempt);
        for (const [anchorId, anchor] of previousAnchors)
          state.integrityAnchors.set(anchorId, anchor);
      });
    },
    discardReplayReservation(reservationId) {
      const reservation = state.replayReservations.get(reservationId);
      if (reservation === undefined) return;
      const attempts = [...state.replayAttempts.entries()].filter(
        ([, attempt]) => attempt.reservationId === reservationId,
      );
      const receipts = [...state.replayReceipts.entries()].filter(
        ([, receipt]) => receipt.reservationId === reservationId,
      );
      const anchors = [...state.integrityAnchors.entries()].filter(([, anchor]) =>
        anchor.subjectKind === "reservation"
          ? anchor.subjectId === reservationId
          : anchor.subjectKind === "attempt"
            ? anchor.subjectId.startsWith(`${reservationId}:`)
            : anchor.subjectKind === "receipt"
              ? receipts.some(([, receipt]) => receipt.receiptId === anchor.subjectId)
              : false,
      );
      state.replayReservations.delete(reservationId);
      for (const [attemptId] of attempts) state.replayAttempts.delete(attemptId);
      for (const [receiptId] of receipts) state.replayReceipts.delete(receiptId);
      for (const [anchorId] of anchors) state.integrityAnchors.delete(anchorId);
      undo.push(() => {
        state.replayReservations.set(reservationId, reservation);
        for (const [attemptId, attempt] of attempts) state.replayAttempts.set(attemptId, attempt);
        for (const [receiptId, receipt] of receipts) state.replayReceipts.set(receiptId, receipt);
        for (const [anchorId, anchor] of anchors) state.integrityAnchors.set(anchorId, anchor);
      });
    },
    insertReplayReceipt(receipt) {
      if (state.replayReceipts.has(receipt.receiptId))
        throw new FoundationStorageConstraintError("replay-receipt-id");
      if (
        [...state.replayReceipts.values()].some(
          (candidate) => candidate.receiptDigest === receipt.receiptDigest,
        )
      )
        throw new FoundationStorageConstraintError("replay-receipt-digest");
      state.replayReceipts.set(receipt.receiptId, structuredClone(receipt));
      undo.push(() => state.replayReceipts.delete(receipt.receiptId));
    },
    updateReplayReceipt(receipt) {
      if (!state.replayReceipts.has(receipt.receiptId))
        throw new FoundationStorageConstraintError("replay-receipt-id");
      const previous = state.replayReceipts.get(receipt.receiptId);
      state.replayReceipts.set(receipt.receiptId, structuredClone(receipt));
      undo.push(() => {
        if (previous !== undefined) state.replayReceipts.set(receipt.receiptId, previous);
      });
    },
    insertAcceptanceIntegrityAnchor(anchor: AcceptanceIntegrityAnchor) {
      if (state.integrityAnchors.has(anchor.anchorId))
        throw new FoundationStorageConstraintError("replay-attempt-id");
      state.integrityAnchors.set(anchor.anchorId, structuredClone(anchor));
      undo.push(() => state.integrityAnchors.delete(anchor.anchorId));
    },
    writeGrantAdmissionTelemetry(value) {
      const key = `${value.mode}:${value.sourceDigest}`;
      const previous = state.grantAdmissionTelemetry.get(key);
      state.grantAdmissionTelemetry.set(key, structuredClone(value));
      undo.push(() => {
        if (previous === undefined) state.grantAdmissionTelemetry.delete(key);
        else state.grantAdmissionTelemetry.set(key, previous);
      });
    },
    writeGrantAdmissionGlobalWindow(value) {
      const previous = state.grantAdmissionGlobalWindows.get(value.mode);
      state.grantAdmissionGlobalWindows.set(value.mode, structuredClone(value));
      undo.push(() => {
        if (previous === undefined) state.grantAdmissionGlobalWindows.delete(value.mode);
        else state.grantAdmissionGlobalWindows.set(value.mode, previous);
      });
    },
    pruneGrantAdmissionTelemetry(beforeMs) {
      for (const [key, value] of state.grantAdmissionTelemetry) {
        if (value.lastAttemptAtMs < beforeMs) {
          state.grantAdmissionTelemetry.delete(key);
          undo.push(() => state.grantAdmissionTelemetry.set(key, value));
        }
      }
    },
    writeGrantAdmissionStateAnchor() {
      if (keyRing === undefined)
        throw new Error("Grant admission anchors require the Grant key ring.");
      const computed = computeGrantAdmissionStateAnchor(
        grantAdmissionStateMaterial(
          state.grantAdmissionTelemetry.values(),
          state.grantAdmissionGlobalWindows.values(),
        ),
        keyRing,
      );
      const previous = state.grantAdmissionStateAnchor;
      const previousInstalled = state.grantAdmissionAnchorInstalled;
      state.grantAdmissionStateAnchor = { anchorVersion: 1, ...computed };
      state.grantAdmissionAnchorInstalled = true;
      undo.push(() => {
        state.grantAdmissionStateAnchor = previous;
        state.grantAdmissionAnchorInstalled = previousInstalled;
      });
    },
  };
}

function findRoot(
  roots: Map<string, StoredEventGameRecordRoot>,
  predicate: (stored: StoredEventGameRecordRoot) => boolean,
): EventGameRecordRoot | null {
  for (const stored of roots.values()) {
    if (predicate(stored)) return cloneEventGameRecordRoot(stored.root);
  }
  return null;
}

function cloneRoot(stored: StoredEventGameRecordRoot | undefined): EventGameRecordRoot | null {
  return stored === undefined ? null : cloneEventGameRecordRoot(stored.root);
}

function cloneAction(
  stored: StoredControlAction | undefined,
  provenance: "current" | "legacy" | undefined,
): StoredControlAction | null {
  return stored === undefined
    ? null
    : {
        ...structuredClone(stored),
        durableFormat: provenance ?? stored.durableFormat,
        [DURABLE_EVIDENCE_PROVENANCE]: provenance ?? stored[DURABLE_EVIDENCE_PROVENANCE],
      };
}

function cloneActions(
  actions: Map<string, StoredControlAction> | undefined,
  provenance: Map<string, "current" | "legacy"> | undefined,
): StoredControlAction[] {
  return [...(actions?.values() ?? [])].map((stored) =>
    cloneAction(stored, provenance?.get(stored.action.operationId))!,
  );
}

function cloneAudits(
  audits: Map<string, StoredControlAuditEntry> | undefined,
  provenance: Map<string, "current" | "legacy"> | undefined,
): StoredControlAuditEntry[] {
  return [...(audits?.values() ?? [])].map((entry) => ({
    ...structuredClone(entry),
    durableFormat: provenance?.get(entry.auditId) ?? entry.durableFormat,
    [DURABLE_EVIDENCE_PROVENANCE]:
      provenance?.get(entry.auditId) ?? entry[DURABLE_EVIDENCE_PROVENANCE],
  }));
}

function findGrant(
  state: Map<string, StoredGrant>,
  predicate: (grant: StoredGrant) => boolean,
): StoredGrant | null {
  for (const grant of state.values()) {
    if (predicate(grant)) return cloneStoredGrant(grant);
  }
  return null;
}

function findSession(
  state: Map<string, StoredGrantSession>,
  predicate: (session: StoredGrantSession) => boolean,
): StoredGrantSession | null {
  for (const session of state.values()) {
    if (predicate(session)) return cloneStoredGrantSession(session);
  }
  return null;
}
