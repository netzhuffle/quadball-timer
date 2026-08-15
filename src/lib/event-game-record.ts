import {
  canonicalizeEventGameRecordRoot,
  cloneEventGameRecordRoot,
  validateEventGameRecordRoot,
  type EventGameRecordRoot,
} from "@/lib/foundation-record-types";
import {
  FoundationStorageConstraintError,
  FoundationStorageNotReadyError,
  type FoundationStorage,
  type FoundationStorageSnapshot,
  type FoundationStorageTransaction,
  type EventCatalogAuditEntry,
  type StoredControlAction,
} from "@/lib/foundation-storage";
import type { StoredGrantAuditEntry } from "@/lib/grant-types";
import {
  ACCEPTED_AUDIT_DETAIL,
  acceptedAuditId,
  classifyRootConflict,
  constraintToConflict,
  createConflictAuditEntry,
  createTeamAssignmentConflictAuditEntry,
  createAuditEntry,
  ensureRecordMetadata,
  findFactById,
  readRecordId,
  sameExternalScope,
  validateAuditHistory,
  validateDependencies,
  validateIdempotencyHistory,
} from "@/lib/event-game-record-helpers";
import { validateId } from "@/lib/event-game-action-codecs";
import {
  CONTROL_ACTION_ORDERING_VERSION,
  createControlActionCodecRegistry,
  findConcurrentCorrectionConflicts,
  findConcurrentTeamAssignmentConflicts,
  materializeControlAction,
  prepareControlAction,
  rebuildControlActionHistory,
  type ActionRebuildResult,
  type ControlAction,
  type ControlActionInput,
  type ControlActionCodec,
  type ControlActionCodecRegistry,
  type ControlActionRecoveryProvenance,
  type ControlAuditEntry,
  type EventGameRecordMetadata,
  type EffectiveGameSideAssignment,
  type IqaGameRulesInterpreter,
  sha256,
  type PreparedControlAction,
} from "@/lib/event-game-actions";
import {
  canonicalizeGamePresentationChange,
  fingerprintGamePresentationChange,
  isValidHexColor,
  orderGamePresentationChanges,
  type GamePresentation,
  type GamePresentationAuditKind,
  type GamePresentationChange,
  type StoredGamePresentationAuditEntry,
  type StoredGamePresentationChange,
} from "@/lib/game-presentation";
import {
  collapseGamePresentationAuditEntries,
  deriveGamePresentation,
  type GamePresentationAcceptanceInput,
  revisionGamePresentationAuditEntry,
} from "@/lib/game-presentation-projection";
import { validateIntegerInRange, validateOpaqueIdentifier } from "@/lib/validation-policy";

/**
 * Trusted composition boundary for Control Audit Trail access.
 *
 * Runtime credentials remain opaque to this deep module. The adapter is
 * responsible for validating Event Admin or Technical Admin authority; the
 * record only asks that trusted adapter whether a supplied credential is
 * valid. No credential-minting helper is exported here.
 */
export type ControlAuditAuthorityVerifier = {
  verify(credential: unknown): boolean;
};

export type ExternalScopeResolution =
  | {
      status: "resolved";
      scope: EventGameRecordRoot["externalScope"];
    }
  | {
      status: "missing" | "mismatch";
      detail: string;
    };

export type ExternalEventTeamResolution =
  | { status: "resolved" }
  | { status: "missing" | "mismatch"; detail: string };

export type ExternalEventTeamColorResolver = {
  resolveDefaultColor(
    eventId: string,
    eventTeamId: string,
    snapshot: FoundationStorageSnapshot,
  ): string | null;
};

/**
 * Resolves the external Event hierarchy without exposing external storage rows.
 * The transaction capability is the same synchronous snapshot used to accept the owned root.
 */
export type ExternalScopeResolver = {
  resolve(
    scope: EventGameRecordRoot["externalScope"],
    snapshot: FoundationStorageSnapshot,
  ): ExternalScopeResolution;
  resolveEventTeam(
    eventId: string,
    eventTeamId: string,
    snapshot: FoundationStorageSnapshot,
  ): ExternalEventTeamResolution;
  resolveEventTeamDefaultColor?: ExternalEventTeamColorResolver["resolveDefaultColor"];
};

function sameLifecycleContext(
  left: EventGameRecordRoot["lifecycle"],
  right: EventGameRecordRoot["lifecycle"],
): boolean {
  return (
    left.phase === right.phase &&
    left.commencedAtMs === right.commencedAtMs &&
    left.finishedAtMs === right.finishedAtMs &&
    left.lockedAtMs === right.lockedAtMs &&
    left.lockReason === right.lockReason
  );
}

function isAllowedLifecycleTransition(
  current: EventGameRecordRoot["lifecycle"],
  next: EventGameRecordRoot["lifecycle"],
): boolean {
  if (current.lockedAtMs !== null || current.finishedAtMs !== null) return false;
  if (
    current.commencedAtMs !== null &&
    (next.commencedAtMs === null || next.commencedAtMs !== current.commencedAtMs)
  )
    return false;
  if (next.phase === "scheduled" && next.commencedAtMs !== null) return false;
  if (current.phase === "scheduled") {
    return (
      next.commencedAtMs !== null && (next.phase === "in-progress" || next.phase === "finished")
    );
  }
  if (current.phase === "in-progress" || current.phase === "suspended") {
    return (
      next.phase === current.phase || (next.phase === "finished" && next.finishedAtMs !== null)
    );
  }
  return false;
}

export type EventGameRecordOptions = {
  externalScopeResolver: ExternalScopeResolver;
  clock?: () => number;
  actionCodecs?: readonly ControlActionCodec[];
  actionCodecRegistry?: ControlActionCodecRegistry;
  interpreter?: IqaGameRulesInterpreter;
  auditAuthorityVerifier?: ControlAuditAuthorityVerifier;
  actionAcceptanceGuard?: (
    transaction: FoundationStorageTransaction,
    root: EventGameRecordRoot,
    input: unknown,
  ) =>
    | { status: "accepted" }
    | {
        status: "rejected";
        reason: Extract<ControlActionAcceptanceOutcome, { status: "rejected" }>["reason"];
        detail: string;
      };
  acceptedLifecycleTransition?: (input: {
    transaction: FoundationStorageTransaction;
    root: EventGameRecordRoot;
    action: ControlAction;
    audit: ControlAuditEntry;
  }) =>
    | {
        status: "updated";
        root: EventGameRecordRoot;
        applyAfterRootUpdate?: (transaction: FoundationStorageTransaction) => void;
        eventAudit?: EventCatalogAuditEntry;
        eventAuditId?: string;
        grantAudits?: readonly StoredGrantAuditEntry[];
      }
    | { status: "rejected"; detail: string };
  acceptedDuplicateActionResolver?: (
    transaction: FoundationStorageTransaction,
    root: EventGameRecordRoot,
    input: unknown,
    prepared: PreparedControlAction | null,
  ) => ControlActionAcceptanceOutcome | null;
  acceptedActionAuditContext?: (input: { root: EventGameRecordRoot; action: ControlAction }) => {
    linkAcceptance?: boolean;
    valueChange?: {
      before: import("@/lib/event-game-actions").ActionJsonValue;
      after: import("@/lib/event-game-actions").ActionJsonValue;
    };
  };
};

export type RootRegistrationOutcome =
  | {
      status: "registered" | "idempotent";
      root: EventGameRecordRoot;
    }
  | {
      status: "rejected";
      reason:
        | "invalid-root"
        | "content-conflict"
        | "ownership-conflict"
        | "external-scope-conflict"
        | "stable-side-conflict"
        | "storage-not-ready";
      detail: string;
    };

export type EventGameRecord = {
  registerRoot(root: unknown): Promise<RootRegistrationOutcome>;
  readRoot(recordId: string): Promise<EventGameRecordRoot | null>;
  transitionLifecycle(
    lifecycle: EventGameRecordRoot["lifecycle"],
  ): Promise<LifecycleTransitionOutcome>;
  acceptAction(input: unknown): Promise<ControlActionAcceptanceOutcome>;
  readActions(): Promise<StoredControlAction[]>;
  readRecoveryProvenance(): Promise<ControlActionRecoveryProvenance[]>;
  readAudit(credential: unknown): Promise<ControlAuditTrailEntry[]>;
  acceptPresentationChange(input: unknown): Promise<GamePresentationAcceptanceOutcome>;
  readPresentationHistory(): Promise<StoredGamePresentationChange[]>;
  readPresentation(): Promise<GamePresentation>;
  readPresentationAudit(credential: unknown): Promise<StoredGamePresentationAuditEntry[]>;
  readMetadata(): Promise<EventGameRecordMetadata | null>;
  rebuild(): Promise<ActionRebuildResult>;
  readiness(): Promise<EventGameRecordReadiness>;
};

export type ControlAuditTrailEntry = ControlAuditEntry | StoredGamePresentationAuditEntry;

export type LifecycleTransitionOutcome =
  | { status: "updated" | "idempotent"; root: EventGameRecordRoot }
  | { status: "rejected"; detail: string };

export type ControlActionAcceptanceOutcome =
  | {
      status: "accepted" | "duplicate-accepted";
      action: ControlAction;
      auditId: string;
      eventAuditId?: string;
    }
  | {
      status: "rejected";
      reason:
        | "invalid-action"
        | "unsupported-action"
        | "record-not-found"
        | "operation-conflict"
        | "missing-dependency"
        | "cyclic-dependency"
        | "fact-target-missing"
        | "storage-not-ready";
      detail: string;
    };

export type GamePresentationAcceptanceOutcome =
  | {
      status: "accepted" | "duplicate-accepted";
      change: StoredGamePresentationChange;
      auditId: string;
    }
  | {
      status: "rejected";
      reason: "invalid-change" | "record-not-found" | "operation-conflict" | "storage-not-ready";
      detail: string;
    };

export type EventGameRecordTeamAssignmentCorrectionRequest = {
  recordId: string;
  eventGameId: string;
  operationId: string;
  gameSideId: string;
  eventTeamId: string;
  teamInterpretationRef: string;
  eventTeamName?: string;
  trustedAtMs: number;
  grant: { sessionId: string; versionId: string };
};

export type EventGameRecordTransactionSeam = {
  correctTeamAssignment(
    input: EventGameRecordTeamAssignmentCorrectionRequest,
  ): ControlActionAcceptanceOutcome & {
    effectiveTeamAssignments?: readonly EffectiveGameSideAssignment[];
  };
  acceptPresentationChange(input: unknown): GamePresentationAcceptanceOutcome;
  readPresentation(recordId: string): GamePresentation;
};

export type EventGameRecordReadiness =
  | {
      ok: true;
      recordId: string;
      actionCount: number;
      storage: Awaited<ReturnType<FoundationStorage["readiness"]>>;
    }
  | {
      ok: false;
      status: "storage-not-ready" | "record-missing" | "rebuild-failure";
      detail: string;
      storage: Awaited<ReturnType<FoundationStorage["readiness"]>>;
    };

function rebuildRecordSnapshot(
  root: EventGameRecordRoot,
  snapshot: FoundationStorageSnapshot,
  registry: ControlActionCodecRegistry,
  interpreter: IqaGameRulesInterpreter | undefined,
): ActionRebuildResult {
  const storedActions = snapshot.listActions(root.recordId);
  const idempotencyEntries = snapshot.listIdempotencyEntries(root.recordId);
  const auditEntries = snapshot.listAuditEntries(root.recordId);
  const metadata = snapshot.readRecordMetadata(root.recordId);
  if (metadata === null) {
    return {
      status: "failed",
      reason: "invalid-history",
      detail: "Event Game Record action metadata is missing.",
    };
  }
  if (
    metadata.actionCount !== storedActions.length ||
    metadata.orderingVersion !== CONTROL_ACTION_ORDERING_VERSION
  ) {
    return {
      status: "failed",
      reason: "invalid-history",
      detail: "Event Game Record action metadata is inconsistent.",
    };
  }
  let lastAcceptedAtMs: number | null = null;
  for (const stored of storedActions) {
    if (lastAcceptedAtMs === null || stored.action.acceptedAtMs > lastAcceptedAtMs) {
      lastAcceptedAtMs = stored.action.acceptedAtMs;
    }
  }
  if (metadata.lastAcceptedAtMs !== lastAcceptedAtMs) {
    return {
      status: "failed",
      reason: "invalid-history",
      detail: "Event Game Record acceptance metadata is inconsistent.",
    };
  }
  const expectedUpdatedAtMs = lastAcceptedAtMs ?? root.creationEvidence.createdAtMs;
  if (metadata.updatedAtMs !== expectedUpdatedAtMs) {
    return {
      status: "failed",
      reason: "invalid-history",
      detail: "Event Game Record metadata update time is inconsistent.",
    };
  }
  const idempotencyFailure = validateIdempotencyHistory(root, storedActions, idempotencyEntries);
  if (idempotencyFailure !== null) {
    return { status: "failed", reason: "invalid-history", detail: idempotencyFailure };
  }
  const auditFailure = validateAuditHistory(root, storedActions, auditEntries, registry);
  if (auditFailure !== null) {
    return { status: "failed", reason: "invalid-history", detail: auditFailure };
  }
  if (interpreter === undefined) {
    return {
      status: "failed",
      reason: "missing-interpreter",
      detail: "An explicit IQA interpreter is required for Event Game Record replay.",
    };
  }
  return rebuildControlActionHistory(root, storedActions, registry, interpreter);
}

function hasCompatibleReplayContext(
  root: EventGameRecordRoot,
  interpreter: IqaGameRulesInterpreter | undefined,
): boolean {
  return (
    interpreter !== undefined &&
    typeof interpreter.version === "string" &&
    interpreter.version === root.compatibility.interpreterVersion &&
    typeof interpreter.rebuild === "function"
  );
}

function presentationDefaultColors(
  root: EventGameRecordRoot,
  snapshot: FoundationStorageSnapshot,
  resolver: ExternalScopeResolver,
  effectiveTeamAssignments: readonly EffectiveGameSideAssignment[] = [],
): Record<string, string> {
  const defaults: Record<string, string> = {};
  const effectiveBySide = new Map(
    effectiveTeamAssignments.map((assignment) => [assignment.gameSideId, assignment.eventTeamId]),
  );
  for (const side of root.gameSides) {
    const color = resolver.resolveEventTeamDefaultColor?.(
      root.eventId,
      effectiveBySide.get(side.id) ?? side.eventTeamId,
      snapshot,
    );
    if (color !== null && color !== undefined && isValidHexColor(color)) {
      defaults[side.id] = `#${color.trim().replace(/^#/, "").toLowerCase()}`;
    }
  }
  return defaults;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function presentationAuditId(
  root: EventGameRecordRoot,
  kind: GamePresentationAuditKind,
  operationId: string | null,
  detail: string,
): string {
  return `presentation:${kind}:${root.recordId}:${operationId ?? sha256(detail)}`;
}

function materializePresentationAuditSnapshots(
  root: EventGameRecordRoot,
  changes: readonly StoredGamePresentationChange[],
  audits: readonly StoredGamePresentationAuditEntry[],
  defaultColors: Readonly<Record<string, string>>,
): StoredGamePresentationAuditEntry[] {
  const ordered = orderGamePresentationChanges(changes);
  const indexByOperationId = new Map(
    ordered.map((change, index) => [change.operationId, index] as const),
  );
  const gameSideIds = root.gameSides.map((side) => side.id);
  return collapseGamePresentationAuditEntries(audits).map((audit) => {
    if (audit.kind !== "presentation-accepted" || audit.operationId === null) {
      return structuredClone(audit);
    }
    const index = indexByOperationId.get(audit.operationId);
    if (index === undefined) return structuredClone(audit);
    return {
      ...structuredClone(audit),
      previousPresentation: deriveGamePresentation(
        gameSideIds,
        ordered.slice(0, index),
        defaultColors,
      ),
      resultingPresentation: deriveGamePresentation(
        gameSideIds,
        ordered.slice(0, index + 1),
        defaultColors,
      ),
    };
  });
}

function readPresentationAcceptanceInput(value: unknown): GamePresentationAcceptanceInput | null {
  if (!isRecord(value)) return null;
  const change = value.change;
  if (
    !isRecord(change) ||
    typeof value.recordId !== "string" ||
    typeof value.eventGameId !== "string"
  ) {
    return null;
  }
  if (
    !validateOpaqueIdentifier(value.recordId, "recordId").ok ||
    !validateOpaqueIdentifier(value.eventGameId, "eventGameId").ok ||
    !validateOpaqueIdentifier(value.operationId, "operationId").ok ||
    !validateOpaqueIdentifier(value.presentationChangeId, "presentationChangeId").ok ||
    typeof value.operationId !== "string" ||
    typeof value.presentationChangeId !== "string" ||
    !Array.isArray(value.causalPredecessorIds) ||
    !isRecord(value.occurrence) ||
    !isRecord(value.grant) ||
    typeof value.acceptedAtMs !== "number"
  )
    return null;
  let normalizedChange: GamePresentationChange;
  if (
    change.type === "pitch-orientation" &&
    (change.pitchOrientation === "side-a-left" || change.pitchOrientation === "side-b-left")
  ) {
    normalizedChange = { type: "pitch-orientation", pitchOrientation: change.pitchOrientation };
  } else if (
    change.type === "displayed-team-color" &&
    validateOpaqueIdentifier(change.gameSideId, "gameSideId").ok &&
    typeof change.color === "string" &&
    isValidHexColor(change.color)
  ) {
    normalizedChange = {
      type: "displayed-team-color",
      gameSideId: change.gameSideId,
      color: `#${change.color.trim().replace(/^#/, "").toLowerCase()}`,
    };
  } else return null;
  if (
    !value.causalPredecessorIds.every(
      (id): id is string => validateOpaqueIdentifier(id, "causalPredecessorId").ok,
    ) ||
    new Set(value.causalPredecessorIds).size !== value.causalPredecessorIds.length ||
    value.causalPredecessorIds.includes(value.operationId) ||
    !validateIntegerInRange(
      value.occurrence.trustedAtMs,
      0,
      Number.MAX_SAFE_INTEGER,
      "occurrence.trustedAtMs",
    ).ok ||
    (value.occurrence.clientOriginAtMs !== null &&
      !validateIntegerInRange(
        value.occurrence.clientOriginAtMs,
        0,
        Number.MAX_SAFE_INTEGER,
        "occurrence.clientOriginAtMs",
      ).ok) ||
    (value.occurrence.source !== "online" && value.occurrence.source !== "offline") ||
    !validateOpaqueIdentifier(value.grant.sessionId, "grant.sessionId").ok ||
    !validateOpaqueIdentifier(value.grant.versionId, "grant.versionId").ok ||
    !validateIntegerInRange(value.acceptedAtMs, 0, Number.MAX_SAFE_INTEGER, "acceptedAtMs").ok
  )
    return null;
  return {
    recordId: value.recordId,
    eventGameId: value.eventGameId,
    operationId: value.operationId,
    presentationChangeId: value.presentationChangeId,
    change: normalizedChange,
    causalPredecessorIds: value.causalPredecessorIds,
    occurrence: {
      trustedAtMs: value.occurrence.trustedAtMs,
      clientOriginAtMs: value.occurrence.clientOriginAtMs,
      source: value.occurrence.source,
    },
    grant: { sessionId: value.grant.sessionId, versionId: value.grant.versionId },
    acceptedAtMs: value.acceptedAtMs,
  };
}

export function createEventGameRecord(
  storage: FoundationStorage,
  options: EventGameRecordOptions,
): EventGameRecord {
  const clock = options.clock ?? (() => Date.now());
  const codecRegistry =
    options.actionCodecRegistry ?? createControlActionCodecRegistry(options.actionCodecs);
  if (options.interpreter !== undefined) {
    storage.setReadinessContext?.({
      actionCodecRegistry: codecRegistry,
      interpreter: options.interpreter,
    });
  }
  let activeRecordId: string | undefined;
  let verifiedRevision: number | undefined;
  let stableIdentityRevision: number | undefined;
  const factIds = new Set<string>();
  const correctionIds = new Set<string>();

  function currentRecordId(): string {
    if (activeRecordId === undefined) {
      throw new Error("Event Game Record has not been registered.");
    }
    return activeRecordId;
  }

  function presentationDefaults(
    root: EventGameRecordRoot,
    transaction: FoundationStorageSnapshot,
  ): Record<string, string> {
    const rebuilt = rebuildRecordSnapshot(root, transaction, codecRegistry, options.interpreter);
    return presentationDefaultColors(
      root,
      transaction,
      options.externalScopeResolver,
      rebuilt.status === "ready" ? rebuilt.effectiveTeamAssignments : [],
    );
  }

  async function rebuildActiveRecord(): Promise<ActionRebuildResult> {
    try {
      const root = await storage.readRoot(currentRecordId());
      if (root === null) {
        return {
          status: "failed",
          reason: "invalid-history",
          detail: "The Event Game Record is not registered.",
        };
      }
      const [storedActions, idempotencyEntries, auditEntries, metadata] = await Promise.all([
        storage.readActions(root.recordId),
        storage.readIdempotencyEntries(root.recordId),
        storage.readAuditEntries(root.recordId),
        storage.readRecordMetadata(root.recordId),
      ]);
      const snapshot = {
        revision: 0,
        findRootByRecordId: () => root,
        findRootByEventGameId: () => root,
        findRootByPitchSlotId: () => root,
        findRootByGameSideId: () => root,
        findActionByOperationId: (_recordId: string, operationId: string) =>
          storedActions.find((stored) => stored.action.operationId === operationId) ?? null,
        listActions: () => storedActions,
        listIdempotencyEntries: () => idempotencyEntries,
        readRecordMetadata: () => metadata,
        listAuditEntries: () => auditEntries,
        findEvent: () => null,
        listEvents: () => [],
        listGameDays: () => [],
        listEventAuditTrail: () => [],
        findGrantById: () => null,
        listGrants: () => [],
        findGrantByCredentialLookupDigest: () => null,
        findActiveSessionByGrantAndContext: () => null,
        findSessionByBearerVerifier: () => null,
        listGrantSessions: () => [],
        listGrantAudit: () => [],
        findAcceptanceBudget: () => null,
        findReplayReservation: () => null,
        findReplayReservationByTuple: () => null,
        findReplayReservationByOriginTuple: () => null,
        listReplayAttempts: () => [],
        findReplayReceiptByDigest: () => null,
        findReplayReceiptByReservationId: () => null,
        listAcceptanceIntegrityAnchors: () => [],
      } as unknown as FoundationStorageSnapshot;
      return rebuildRecordSnapshot(root, snapshot, codecRegistry, options.interpreter);
    } catch (error) {
      if (error instanceof FoundationStorageNotReadyError) {
        return {
          status: "failed",
          reason: "invalid-history",
          detail: "Event Game Record storage is not ready for rebuild.",
        };
      }
      return {
        status: "failed",
        reason: "invalid-history",
        detail: "Event Game Record durable history could not be read.",
      };
    }
  }

  return {
    async registerRoot(input) {
      const validated = validateEventGameRecordRoot(input);
      if (!validated.ok) {
        return {
          status: "rejected",
          reason: "invalid-root",
          detail: validated.error,
        };
      }

      const root = validated.value;
      const canonicalContent = canonicalizeEventGameRecordRoot(root);

      if (!hasCompatibleReplayContext(root, options.interpreter)) {
        return {
          status: "rejected",
          reason: "storage-not-ready",
          detail: "The Event Game Record could not be durably registered.",
        };
      }

      try {
        const outcome = await storage.transaction((transaction) => {
          const existing = transaction.findRootByRecordId(root.recordId);
          if (existing !== null) {
            const existingCanonicalContent = canonicalizeEventGameRecordRoot(existing);
            if (existingCanonicalContent === canonicalContent) {
              ensureRecordMetadata(transaction, existing);
              return {
                status: "idempotent",
                root: cloneEventGameRecordRoot(existing),
              } satisfies RootRegistrationOutcome;
            }
          }

          const scopeResolution = options.externalScopeResolver.resolve(
            root.externalScope,
            transaction,
          );
          if (scopeResolution.status !== "resolved") {
            return {
              status: "rejected",
              reason: "external-scope-conflict",
              detail: scopeResolution.detail,
            } satisfies RootRegistrationOutcome;
          }
          if (!sameExternalScope(scopeResolution.scope, root.externalScope)) {
            return {
              status: "rejected",
              reason: "external-scope-conflict",
              detail: "The external scope resolver returned a mismatched hierarchy.",
            } satisfies RootRegistrationOutcome;
          }

          if (existing !== null) {
            return {
              status: "rejected",
              reason: classifyRootConflict(existing, root),
              detail: "The root identity is already registered with different content.",
            } satisfies RootRegistrationOutcome;
          }

          if (transaction.findRootByEventGameId(root.eventGameId) !== null) {
            return {
              status: "rejected",
              reason: "ownership-conflict",
              detail: "The Event Game identity belongs to another root.",
            } satisfies RootRegistrationOutcome;
          }
          if (transaction.findRootByPitchSlotId(root.externalScope.pitchSlotId) !== null) {
            return {
              status: "rejected",
              reason: "external-scope-conflict",
              detail: "The external Pitch Slot reference belongs to another root.",
            } satisfies RootRegistrationOutcome;
          }
          for (const side of root.gameSides) {
            if (transaction.findRootByGameSideId(side.id) !== null) {
              return {
                status: "rejected",
                reason: "stable-side-conflict",
                detail: "A stable Game Side identity belongs to another root.",
              } satisfies RootRegistrationOutcome;
            }
          }

          transaction.insertRoot({ root, canonicalContent });
          ensureRecordMetadata(transaction, root);
          return {
            status: "registered",
            root: cloneEventGameRecordRoot(root),
          } satisfies RootRegistrationOutcome;
        });
        if (outcome.status === "registered" || outcome.status === "idempotent") {
          activeRecordId = root.recordId;
          verifiedRevision = undefined;
          stableIdentityRevision = undefined;
          factIds.clear();
          correctionIds.clear();
        }
        return outcome;
      } catch (error) {
        if (error instanceof FoundationStorageNotReadyError) {
          return {
            status: "rejected",
            reason: "storage-not-ready",
            detail: error.readiness.ok
              ? "Foundation storage is not ready for authoritative writes."
              : error.readiness.detail,
          };
        }
        if (error instanceof FoundationStorageConstraintError) {
          return {
            status: "rejected",
            reason: constraintToConflict(error),
            detail: "The root conflicts with a concurrently committed identity.",
          };
        }
        return {
          status: "rejected",
          reason: "storage-not-ready",
          detail: "The Event Game Record could not be durably registered.",
        };
      }
    },

    readRoot(recordId) {
      return storage.readRoot(recordId);
    },

    async transitionLifecycle(lifecycle) {
      try {
        return await storage.transaction((transaction) => {
          const current = transaction.findRootByRecordId(currentRecordId());
          if (current === null) {
            return {
              status: "rejected",
              detail: "The Event Game Record is not registered.",
            } satisfies LifecycleTransitionOutcome;
          }
          if (sameLifecycleContext(current.lifecycle, lifecycle)) {
            return {
              status: "idempotent",
              root: cloneEventGameRecordRoot(current),
            } satisfies LifecycleTransitionOutcome;
          }
          const candidate = { ...current, lifecycle: structuredClone(lifecycle) };
          const validated = validateEventGameRecordRoot(candidate);
          if (!validated.ok) {
            return {
              status: "rejected",
              detail: validated.error,
            } satisfies LifecycleTransitionOutcome;
          }
          if (!isAllowedLifecycleTransition(current.lifecycle, validated.value.lifecycle)) {
            return {
              status: "rejected",
              detail: "Event Game lifecycle transitions are monotonic.",
            } satisfies LifecycleTransitionOutcome;
          }
          const storedRoot = {
            root: validated.value,
            canonicalContent: canonicalizeEventGameRecordRoot(validated.value),
          };
          transaction.updateRoot(storedRoot);
          return {
            status: "updated",
            root: cloneEventGameRecordRoot(validated.value),
          } satisfies LifecycleTransitionOutcome;
        });
      } catch {
        return {
          status: "rejected",
          detail: "The Event Game lifecycle could not be durably updated.",
        } satisfies LifecycleTransitionOutcome;
      }
    },

    async acceptAction(input) {
      const nowMs = clock();
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
        return {
          status: "rejected",
          reason: "invalid-action",
          detail: "The authoritative server time is invalid.",
        };
      }

      try {
        let nextVerifiedRevision: number | undefined;
        const outcome = await storage.transaction((transaction) => {
          const root = transaction.findRootByRecordId(readRecordId(input));
          if (root === null) {
            return {
              status: "rejected",
              reason: "record-not-found",
              detail: "The Event Game Record is not registered.",
            } satisfies ControlActionAcceptanceOutcome;
          }

          const earlyPreparation = prepareControlAction(input, root, codecRegistry, nowMs, {
            allowConcurrentTeamAssignment: true,
          });
          const earlyDuplicate = options.acceptedDuplicateActionResolver?.(
            transaction,
            root,
            input,
            earlyPreparation.ok ? earlyPreparation.value : null,
          );
          if (earlyDuplicate !== null && earlyDuplicate !== undefined) return earlyDuplicate;

          const guard = options.actionAcceptanceGuard?.(transaction, root, input);
          if (guard?.status === "rejected") return guard;

          const historyReady =
            verifiedRevision === transaction.revision ||
            rebuildRecordSnapshot(root, transaction, codecRegistry, options.interpreter).status ===
              "ready";
          if (!historyReady) {
            return {
              status: "rejected",
              reason: "storage-not-ready",
              detail: "The Event Game Record history is not ready for authoritative writes.",
            } satisfies ControlActionAcceptanceOutcome;
          }

          const prepared = prepareControlAction(input, root, codecRegistry, nowMs, {
            allowConcurrentTeamAssignment: true,
          });
          if (!prepared.ok) {
            return {
              status: "rejected",
              reason: prepared.error.includes("unsupported")
                ? "unsupported-action"
                : "invalid-action",
              detail: prepared.error,
            } satisfies ControlActionAcceptanceOutcome;
          }

          const existing = transaction.findActionByOperationId(
            root.recordId,
            prepared.value.input.operationId,
          );
          if (existing !== null) {
            if (existing.contentFingerprint === prepared.value.contentFingerprint) {
              return {
                status: "duplicate-accepted",
                action: structuredClone(existing.action),
                auditId: acceptedAuditId(existing.action),
              } satisfies ControlActionAcceptanceOutcome;
            }
            const audit = createAuditEntry(
              prepared.value.input,
              "action-conflict",
              "operation identity is already bound to different content",
              nowMs,
              {
                interpretation: prepared.value.interpretation,
                collision: {
                  acceptedAction: existing.action,
                  acceptedContentFingerprint: existing.contentFingerprint,
                  rejectedAttempt: prepared.value,
                },
              },
            );
            transaction.appendAuditEntry(audit);
            return {
              status: "rejected",
              reason: "operation-conflict",
              detail: "The operation identity is already bound to different content.",
            } satisfies ControlActionAcceptanceOutcome;
          }

          const dependencyReason = validateDependencies(transaction, prepared.value.input);
          if (dependencyReason !== null) {
            const audit = createAuditEntry(
              prepared.value.input,
              "action-rejected",
              dependencyReason.detail,
              nowMs,
              { interpretation: prepared.value.interpretation },
            );
            transaction.appendAuditEntry(audit);
            return {
              status: "rejected",
              reason: dependencyReason.reason,
              detail: dependencyReason.detail,
            } satisfies ControlActionAcceptanceOutcome;
          }

          let correctionTarget: StoredControlAction | null = null;
          const interpretation = prepared.value.interpretation;
          if (stableIdentityRevision !== transaction.revision) {
            factIds.clear();
            correctionIds.clear();
            for (const stored of transaction.listActions(root.recordId)) {
              if (stored.action.interpretation.type === "fact") {
                factIds.add(stored.action.interpretation.factId);
              } else if (
                stored.action.interpretation.type === "correction" ||
                stored.action.interpretation.type === "team-assignment-correction"
              ) {
                correctionIds.add(stored.action.interpretation.correctionId);
              }
            }
            stableIdentityRevision = transaction.revision;
          }
          const duplicateIdentity =
            interpretation.type === "fact"
              ? factIds.has(interpretation.factId)
              : interpretation.type === "correction"
                ? correctionIds.has(interpretation.correctionId)
                : interpretation.type === "team-assignment-correction"
                  ? correctionIds.has(interpretation.correctionId)
                  : false;
          if (duplicateIdentity) {
            const audit = createAuditEntry(
              prepared.value.input,
              "action-rejected",
              "stable Game Fact or Correction identity is already retained",
              nowMs,
              { interpretation: prepared.value.interpretation },
            );
            transaction.appendAuditEntry(audit);
            return {
              status: "rejected",
              reason: "invalid-action",
              detail: "The stable Game Fact or Correction identity is already retained.",
            } satisfies ControlActionAcceptanceOutcome;
          }
          if (prepared.value.interpretation.type === "correction") {
            const retainedActions = transaction.listActions(root.recordId);
            correctionTarget = findFactById(
              retainedActions,
              prepared.value.interpretation.targetFactId,
            );
            if (correctionTarget === null) {
              const audit = createAuditEntry(
                prepared.value.input,
                "action-rejected",
                "correction target is not a retained Game Fact",
                nowMs,
                { interpretation: prepared.value.interpretation },
              );
              transaction.appendAuditEntry(audit);
              return {
                status: "rejected",
                reason: "fact-target-missing",
                detail: "The Correction target is not a retained Game Fact.",
              } satisfies ControlActionAcceptanceOutcome;
            }
          }

          const action = materializeControlAction(prepared.value, nowMs);
          if (action.interpretation.type === "team-assignment-correction") {
            const teamInterpretation = action.interpretation;
            const teamResolution = options.externalScopeResolver.resolveEventTeam(
              root.eventId,
              teamInterpretation.eventTeamId,
              transaction,
            );
            if (teamResolution.status !== "resolved") {
              return {
                status: "rejected",
                reason: "invalid-action",
                detail: teamResolution.detail,
              } satisfies ControlActionAcceptanceOutcome;
            }
            const candidateHistory = rebuildControlActionHistory(
              root,
              [
                ...transaction.listActions(root.recordId),
                {
                  action,
                  canonicalContent: prepared.value.canonicalContent,
                  contentFingerprint: prepared.value.contentFingerprint,
                },
              ],
              codecRegistry,
              options.interpreter!,
            );
            if (candidateHistory.status !== "ready") {
              return {
                status: "rejected",
                reason:
                  candidateHistory.reason === "invalid-history"
                    ? "invalid-action"
                    : "storage-not-ready",
                detail: candidateHistory.detail,
              } satisfies ControlActionAcceptanceOutcome;
            }
          }
          const acceptedAuditContext = options.acceptedActionAuditContext?.({ root, action });
          const audit = createAuditEntry(
            prepared.value.input,
            "action-accepted",
            ACCEPTED_AUDIT_DETAIL,
            nowMs,
            {
              interpretation: prepared.value.interpretation,
              relatedOperationIds:
                correctionTarget === null ? [] : [correctionTarget.action.operationId],
              valueChange: acceptedAuditContext?.valueChange,
            },
          );
          if (acceptedAuditContext?.linkAcceptance === true) {
            audit.links ??= {
              actionId: null,
              targetFactId: null,
              causalPredecessorIds: [],
              relatedOperationIds: [],
              ordering: null,
            };
            audit.links.acceptanceId = `accept-${audit.auditId}`;
            audit.links.contentFingerprint = prepared.value.contentFingerprint;
          }
          const lifecycle = options.acceptedLifecycleTransition?.({
            transaction,
            root,
            action,
            audit,
          });
          if (lifecycle?.status === "rejected") {
            return {
              status: "rejected",
              reason: "invalid-action",
              detail: lifecycle.detail,
            } satisfies ControlActionAcceptanceOutcome;
          }
          if (lifecycle !== undefined) {
            const validatedRoot = validateEventGameRecordRoot(lifecycle.root);
            if (!validatedRoot.ok) {
              return {
                status: "rejected",
                reason: "invalid-action",
                detail: validatedRoot.error,
              } satisfies ControlActionAcceptanceOutcome;
            }
            if (!sameLifecycleContext(root.lifecycle, validatedRoot.value.lifecycle)) {
              transaction.updateRoot({
                root: validatedRoot.value,
                canonicalContent: canonicalizeEventGameRecordRoot(validatedRoot.value),
              });
            }
            lifecycle.applyAfterRootUpdate?.(transaction);
          }
          transaction.insertAction({
            action,
            canonicalContent: prepared.value.canonicalContent,
            contentFingerprint: prepared.value.contentFingerprint,
          });
          const previousMetadata = transaction.readRecordMetadata(root.recordId);
          const lastAcceptedAtMs =
            previousMetadata?.lastAcceptedAtMs === null ||
            previousMetadata?.lastAcceptedAtMs === undefined
              ? action.acceptedAtMs
              : Math.max(previousMetadata.lastAcceptedAtMs, action.acceptedAtMs);
          transaction.upsertRecordMetadata({
            recordId: root.recordId,
            actionCount: (previousMetadata?.actionCount ?? 0) + 1,
            orderingVersion: CONTROL_ACTION_ORDERING_VERSION,
            lastAcceptedAtMs,
            updatedAtMs: lastAcceptedAtMs,
          });
          transaction.appendAuditEntry(audit);
          if (lifecycle?.eventAudit !== undefined) {
            transaction.appendEventAudit(lifecycle.eventAudit);
          }
          for (const grantAudit of lifecycle?.grantAudits ?? []) {
            transaction.appendGrantAudit(grantAudit);
          }
          if (
            action.interpretation.type === "correction" ||
            action.interpretation.type === "team-assignment-correction"
          ) {
            appendConcurrentCorrectionAudits(transaction, root.recordId, nowMs);
          }
          nextVerifiedRevision = transaction.revision + 1;
          return {
            status: "accepted",
            action,
            auditId: audit.auditId,
            eventAuditId: lifecycle?.eventAuditId,
          } satisfies ControlActionAcceptanceOutcome;
        });
        if (outcome.status === "accepted" && nextVerifiedRevision !== undefined) {
          verifiedRevision = nextVerifiedRevision;
          stableIdentityRevision = nextVerifiedRevision;
          if (outcome.action.interpretation.type === "fact") {
            factIds.add(outcome.action.interpretation.factId);
          } else if (
            outcome.action.interpretation.type === "correction" ||
            outcome.action.interpretation.type === "team-assignment-correction"
          ) {
            correctionIds.add(outcome.action.interpretation.correctionId);
          }
        } else if (outcome.status !== "duplicate-accepted") {
          verifiedRevision = undefined;
          stableIdentityRevision = undefined;
        }
        return outcome;
      } catch (error) {
        verifiedRevision = undefined;
        if (error instanceof FoundationStorageNotReadyError) {
          return {
            status: "rejected",
            reason: "storage-not-ready",
            detail: "Foundation storage is not ready for authoritative writes.",
          };
        }
        if (error instanceof FoundationStorageConstraintError) {
          if (error.constraint === "audit-id") {
            return {
              status: "rejected",
              reason: "storage-not-ready",
              detail: "The Control Audit Trail could not be durably committed.",
            };
          }
          return {
            status: "rejected",
            reason: "operation-conflict",
            detail: "The operation identity conflicts with committed content.",
          };
        }
        return {
          status: "rejected",
          reason: "storage-not-ready",
          detail: "The Control Action could not be durably committed.",
        };
      }
    },

    readActions() {
      return storage.readActions(currentRecordId());
    },

    async readRecoveryProvenance() {
      const actions = await storage.readActions(currentRecordId());
      return actions.flatMap((stored) => {
        const provenance = stored.action.recoveryProvenance;
        return provenance === undefined ? [] : [structuredClone(provenance)];
      });
    },

    async readAudit(credential) {
      let verified = false;
      try {
        verified = options.auditAuthorityVerifier?.verify(credential) === true;
      } catch {
        verified = false;
      }
      if (!verified) {
        throw new Error("A trusted Event Admin or Technical Admin audit authority is required.");
      }
      const entries = await storage.readAuditEntries(currentRecordId());
      const presentationEntries = await storage.transaction((transaction) => {
        const root = transaction.findRootByRecordId(currentRecordId());
        if (root === null) return [];
        return materializePresentationAuditSnapshots(
          root,
          transaction.listPresentationChanges?.(root.recordId) ?? [],
          transaction.listPresentationAuditEntries?.(root.recordId) ?? [],
          presentationDefaults(root, transaction),
        );
      });
      const presentationRanks = await storage.transaction((transaction) => {
        const changes = transaction.listPresentationChanges?.(currentRecordId()) ?? [];
        return new Map(
          orderGamePresentationChanges(changes).map((change, index) => [change.operationId, index]),
        );
      });
      return [...entries, ...presentationEntries].sort((left, right) =>
        compareAuditEntries(left, right, presentationRanks),
      );
    },

    async acceptPresentationChange(input) {
      const parsed = readPresentationAcceptanceInput(input);
      if (parsed === null) {
        return {
          status: "rejected",
          reason: "invalid-change",
          detail: "Game Presentation Change is malformed.",
        } satisfies GamePresentationAcceptanceOutcome;
      }
      try {
        return await storage.transaction((transaction) => {
          const root = transaction.findRootByRecordId(parsed.recordId);
          if (root === null || root.eventGameId !== parsed.eventGameId) {
            return {
              status: "rejected",
              reason: "record-not-found",
              detail: "The Event Game Record is not registered for this Event Game.",
            } satisfies GamePresentationAcceptanceOutcome;
          }
          if (parsed.recordId !== currentRecordId()) {
            return {
              status: "rejected",
              reason: "record-not-found",
              detail: "The Event Game Record is not active.",
            } satisfies GamePresentationAcceptanceOutcome;
          }
          return createEventGameRecordTransactionSeam(
            transaction,
            options,
          ).acceptPresentationChange(parsed);
        });
      } catch (error) {
        if (error instanceof FoundationStorageNotReadyError) {
          return {
            status: "rejected",
            reason: "storage-not-ready",
            detail: "Presentation records are not durably available.",
          } satisfies GamePresentationAcceptanceOutcome;
        }
        return {
          status: "rejected",
          reason: "storage-not-ready",
          detail: "The Game Presentation Change could not be durably committed.",
        } satisfies GamePresentationAcceptanceOutcome;
      }
    },

    async readPresentation() {
      return storage.transaction((transaction) => {
        const root = transaction.findRootByRecordId(currentRecordId());
        if (root === null) throw new Error("The Event Game Record is not registered.");
        const changes = transaction.listPresentationChanges?.(root.recordId) ?? [];
        return deriveGamePresentation(
          root.gameSides.map((side) => side.id),
          changes,
          presentationDefaults(root, transaction),
        );
      });
    },

    async readPresentationHistory() {
      return storage.transaction((transaction) => {
        const root = transaction.findRootByRecordId(currentRecordId());
        if (root === null) throw new Error("The Event Game Record is not registered.");
        return orderGamePresentationChanges(
          transaction.listPresentationChanges?.(root.recordId) ?? [],
        ).map((change) => structuredClone(change));
      });
    },

    async readPresentationAudit(credential) {
      let verified = false;
      try {
        verified = options.auditAuthorityVerifier?.verify(credential) === true;
      } catch {
        verified = false;
      }
      if (!verified) {
        throw new Error("A trusted Event Admin or Technical Admin audit authority is required.");
      }
      return storage.transaction((transaction) => {
        const root = transaction.findRootByRecordId(currentRecordId());
        if (root === null) throw new Error("The Event Game Record is not registered.");
        const changes = transaction.listPresentationChanges?.(root.recordId) ?? [];
        const presentationRanks = new Map(
          orderGamePresentationChanges(changes).map((change, index) => [change.operationId, index]),
        );
        return materializePresentationAuditSnapshots(
          root,
          changes,
          transaction.listPresentationAuditEntries?.(root.recordId) ?? [],
          presentationDefaults(root, transaction),
        ).sort((left, right) => compareAuditEntries(left, right, presentationRanks));
      });
    },

    readMetadata() {
      return storage.readRecordMetadata(currentRecordId());
    },

    rebuild: rebuildActiveRecord,

    async readiness() {
      const storageReadiness = await storage.readiness();
      if (!storageReadiness.ok) {
        return {
          ok: false,
          status: "storage-not-ready",
          detail: storageReadiness.detail,
          storage: storageReadiness,
        } satisfies EventGameRecordReadiness;
      }
      if (activeRecordId === undefined) {
        return {
          ok: false,
          status: "record-missing",
          detail: "The Event Game Record is not registered.",
          storage: storageReadiness,
        } satisfies EventGameRecordReadiness;
      }
      let root: EventGameRecordRoot | null;
      try {
        root = await storage.readRoot(activeRecordId);
      } catch {
        return {
          ok: false,
          status: "storage-not-ready",
          detail: "The Event Game Record root could not be read.",
          storage: storageReadiness,
        } satisfies EventGameRecordReadiness;
      }
      if (root === null) {
        return {
          ok: false,
          status: "record-missing",
          detail: "The Event Game Record is not registered.",
          storage: storageReadiness,
        } satisfies EventGameRecordReadiness;
      }
      const rebuild = await rebuildActiveRecord();
      if (rebuild.status !== "ready") {
        return {
          ok: false,
          status: "rebuild-failure",
          detail: rebuild.detail,
          storage: storageReadiness,
        } satisfies EventGameRecordReadiness;
      }
      return {
        ok: true,
        recordId: root.recordId,
        actionCount: rebuild.canonicalActions.length,
        storage: storageReadiness,
      } satisfies EventGameRecordReadiness;
    },
  };
}

export function createEventGameRecordTransactionSeam(
  transaction: FoundationStorageTransaction,
  options: EventGameRecordOptions,
): EventGameRecordTransactionSeam {
  const clock = options.clock ?? (() => Date.now());
  const registry =
    options.actionCodecRegistry ?? createControlActionCodecRegistry(options.actionCodecs);

  function readReadyHistory(root: EventGameRecordRoot): ActionRebuildResult {
    return rebuildRecordSnapshot(root, transaction, registry, options.interpreter);
  }

  function presentationDefaults(
    root: EventGameRecordRoot,
    snapshot: FoundationStorageSnapshot,
  ): Record<string, string> {
    const rebuilt = readReadyHistory(root);
    return presentationDefaultColors(
      root,
      snapshot,
      options.externalScopeResolver,
      rebuilt.status === "ready" ? rebuilt.effectiveTeamAssignments : [],
    );
  }

  function correctTeamAssignment(
    input: EventGameRecordTeamAssignmentCorrectionRequest,
  ): ControlActionAcceptanceOutcome & {
    effectiveTeamAssignments?: readonly EffectiveGameSideAssignment[];
  } {
    const recordId = validateId(input.recordId, "recordId");
    const eventGameId = validateId(input.eventGameId, "eventGameId");
    const operationId = validateId(input.operationId, "operationId");
    const gameSideId = validateId(input.gameSideId, "gameSideId");
    const eventTeamId = validateId(input.eventTeamId, "eventTeamId");
    const teamInterpretationRef = validateId(input.teamInterpretationRef, "teamInterpretationRef");
    const eventTeamName =
      input.eventTeamName === undefined
        ? { ok: true as const, value: undefined }
        : validateId(input.eventTeamName, "eventTeamName");
    if (
      !recordId.ok ||
      !eventGameId.ok ||
      !operationId.ok ||
      !gameSideId.ok ||
      !eventTeamId.ok ||
      !teamInterpretationRef.ok ||
      !eventTeamName.ok
    )
      return {
        status: "rejected",
        reason: "invalid-action",
        detail: "Event Team Assignment Correction identity is invalid.",
      };
    const root = transaction.findRootByRecordId(recordId.value);
    if (root === null || root.eventGameId !== eventGameId.value)
      return {
        status: "rejected",
        reason: "record-not-found",
        detail: "The Event Game Record is not registered for this Event Game.",
      };
    if (!root.gameSides.some((side) => side.id === gameSideId.value))
      return {
        status: "rejected",
        reason: "invalid-action",
        detail: "Team Assignment Correction references an unknown stable Game Side.",
      };
    const scope = options.externalScopeResolver.resolve(root.externalScope, transaction);
    if (scope.status !== "resolved")
      return { status: "rejected", reason: "storage-not-ready", detail: scope.detail };
    const team = options.externalScopeResolver.resolveEventTeam(
      root.eventId,
      eventTeamId.value,
      transaction,
    );
    if (team.status !== "resolved")
      return { status: "rejected", reason: "invalid-action", detail: team.detail };
    const before = readReadyHistory(root);
    if (before.status !== "ready")
      return { status: "rejected", reason: "storage-not-ready", detail: before.detail };
    const actionInput: ControlActionInput = {
      recordId: recordId.value,
      eventGameId: eventGameId.value,
      operationId: operationId.value,
      kind: { id: "team-assignment-correction", version: "1" },
      payload: {
        correctionId: operationId.value,
        gameSideId: gameSideId.value,
        eventTeamId: eventTeamId.value,
        teamInterpretationRef: teamInterpretationRef.value,
        ...(eventTeamName.value === undefined ? {} : { eventTeamName: eventTeamName.value }),
      },
      causalPredecessorIds: [],
      occurrence: { trustedAtMs: input.trustedAtMs, clientOriginAtMs: null, source: "online" },
      grant: input.grant,
      lifecycle: structuredClone(root.lifecycle),
    };
    const prepared = prepareControlAction(actionInput, root, registry, clock(), {
      allowConcurrentTeamAssignment: true,
    });
    if (!prepared.ok)
      return { status: "rejected", reason: "invalid-action", detail: prepared.error };
    const existing = transaction.findActionByOperationId(root.recordId, operationId.value);
    if (existing !== null) {
      if (existing.contentFingerprint === prepared.value.contentFingerprint) {
        return {
          status: "duplicate-accepted",
          action: structuredClone(existing.action),
          auditId: acceptedAuditId(existing.action),
          effectiveTeamAssignments: structuredClone(before.effectiveTeamAssignments),
        };
      }
      transaction.appendAuditEntry(
        createAuditEntry(
          prepared.value.input,
          "action-conflict",
          "operation identity is already bound to different content",
          clock(),
          {
            interpretation: prepared.value.interpretation,
            collision: {
              acceptedAction: existing.action,
              acceptedContentFingerprint: existing.contentFingerprint,
              rejectedAttempt: prepared.value,
            },
          },
        ),
      );
      return {
        status: "rejected",
        reason: "operation-conflict",
        detail: "The operation identity is already bound to different content.",
      };
    }
    const action = materializeControlAction(prepared.value, clock());
    const candidate = rebuildControlActionHistory(
      root,
      [
        ...transaction.listActions(root.recordId),
        {
          action,
          canonicalContent: prepared.value.canonicalContent,
          contentFingerprint: prepared.value.contentFingerprint,
        },
      ],
      registry,
      options.interpreter!,
    );
    if (candidate.status !== "ready")
      return { status: "rejected", reason: "storage-not-ready", detail: candidate.detail };
    transaction.insertAction({
      action,
      canonicalContent: prepared.value.canonicalContent,
      contentFingerprint: prepared.value.contentFingerprint,
    });
    const metadata = transaction.readRecordMetadata(root.recordId);
    const acceptedAtMs = action.acceptedAtMs;
    transaction.upsertRecordMetadata({
      recordId: root.recordId,
      actionCount: (metadata?.actionCount ?? 0) + 1,
      orderingVersion: CONTROL_ACTION_ORDERING_VERSION,
      lastAcceptedAtMs: Math.max(metadata?.lastAcceptedAtMs ?? 0, acceptedAtMs),
      updatedAtMs: Math.max(
        metadata?.updatedAtMs ?? root.creationEvidence.createdAtMs,
        acceptedAtMs,
      ),
    });
    const audit = createAuditEntry(
      prepared.value.input,
      "action-accepted",
      ACCEPTED_AUDIT_DETAIL,
      acceptedAtMs,
      { interpretation: prepared.value.interpretation },
    );
    transaction.appendAuditEntry(audit);
    appendConcurrentCorrectionAudits(transaction, root.recordId, acceptedAtMs);
    const after = readReadyHistory(root);
    if (after.status !== "ready")
      return { status: "rejected", reason: "storage-not-ready", detail: after.detail };
    return {
      status: "accepted",
      action,
      auditId: audit.auditId,
      effectiveTeamAssignments: structuredClone(after.effectiveTeamAssignments),
    };
  }

  function acceptPresentationChange(input: unknown): GamePresentationAcceptanceOutcome {
    const parsed = readPresentationAcceptanceInput(input);
    if (parsed === null)
      return {
        status: "rejected",
        reason: "invalid-change",
        detail: "Game Presentation Change is malformed.",
      };
    if (
      transaction.findPresentationChangeByOperationId === undefined ||
      transaction.listPresentationChanges === undefined ||
      transaction.listPresentationAuditEntries === undefined ||
      transaction.insertPresentationChange === undefined ||
      transaction.appendPresentationAuditEntry === undefined ||
      transaction.appendPresentationAuditRevision === undefined ||
      transaction.sealPresentationEvidence === undefined
    )
      return {
        status: "rejected",
        reason: "storage-not-ready",
        detail: "The presentation record seam is not durably available.",
      };
    const root = transaction.findRootByRecordId(parsed.recordId);
    if (root === null || root.eventGameId !== parsed.eventGameId)
      return {
        status: "rejected",
        reason: "record-not-found",
        detail: "The Event Game Record is not registered for this Event Game.",
      };
    if (parsed.change.type === "displayed-team-color") {
      const gameSideId = parsed.change.gameSideId;
      if (!root.gameSides.some((side) => side.id === gameSideId))
        return {
          status: "rejected",
          reason: "invalid-change",
          detail: "Game Presentation Change references an unknown stable Game Side.",
        };
    }
    const retained = transaction.listPresentationChanges(root.recordId);
    const predecessorIds = new Set(parsed.causalPredecessorIds);
    const retainedOperationIds = new Set([
      ...transaction.listActions(root.recordId).map((stored) => stored.action.operationId),
      ...retained.map((change) => change.operationId),
    ]);
    if (
      predecessorIds.size !== parsed.causalPredecessorIds.length ||
      predecessorIds.has(parsed.operationId) ||
      parsed.causalPredecessorIds.some((predecessor) => !retainedOperationIds.has(predecessor))
    )
      return {
        status: "rejected",
        reason: "invalid-change",
        detail: "Game Presentation Change causal predecessors are not retained.",
      };
    const existing = transaction.findPresentationChangeByOperationId(
      root.recordId,
      parsed.operationId,
    );
    const fingerprint = fingerprintGamePresentationChange(parsed);
    const defaults = presentationDefaults(root, transaction);
    const previous = deriveGamePresentation(
      root.gameSides.map((side) => side.id),
      retained,
      defaults,
    );
    if (existing !== null) {
      if (existing.contentFingerprint === fingerprint) {
        const audit: StoredGamePresentationAuditEntry = {
          auditVersion: "control-audit-v1",
          auditId: presentationAuditId(root, "presentation-duplicate", parsed.operationId, ""),
          recordId: root.recordId,
          eventGameId: root.eventGameId,
          operationId: parsed.operationId,
          presentationChangeId: parsed.presentationChangeId,
          kind: "presentation-duplicate",
          classification: "game-presentation-change",
          outcome: "duplicate-accepted",
          createdAtMs: parsed.acceptedAtMs,
          redactedDetail: "Duplicate Game Presentation Change acknowledged idempotently.",
          previousPresentation: structuredClone(previous),
          resultingPresentation: structuredClone(previous),
          change: parsed.change,
          grant: parsed.grant,
        };
        if (
          !transaction
            .listPresentationAuditEntries(root.recordId)
            .some((entry) => entry.auditId === audit.auditId)
        )
          transaction.appendPresentationAuditEntry(audit);
        transaction.sealPresentationEvidence(root.recordId);
        return {
          status: "duplicate-accepted",
          change: structuredClone(existing),
          auditId: audit.auditId,
        };
      }
      return {
        status: "rejected",
        reason: "operation-conflict",
        detail: "The presentation operation identity is already bound to different content.",
      };
    }
    if (retained.some((change) => change.presentationChangeId === parsed.presentationChangeId))
      return {
        status: "rejected",
        reason: "operation-conflict",
        detail: "The presentation change identity is already retained.",
      };
    const stored: StoredGamePresentationChange = {
      ...parsed,
      causalPredecessorIds: [...parsed.causalPredecessorIds],
      canonicalContent: canonicalizeGamePresentationChange(parsed),
      contentFingerprint: fingerprint,
    };
    transaction.insertPresentationChange(stored);
    const ordered = orderGamePresentationChanges([...retained, stored]);
    const index = ordered.findIndex((change) => change.operationId === stored.operationId);
    const canonicalPrevious = deriveGamePresentation(
      root.gameSides.map((side) => side.id),
      ordered.slice(0, index),
      defaults,
    );
    const resulting = deriveGamePresentation(
      root.gameSides.map((side) => side.id),
      ordered.slice(0, index + 1),
      defaults,
    );
    const audit: StoredGamePresentationAuditEntry = {
      auditVersion: "control-audit-v1",
      auditId: presentationAuditId(root, "presentation-accepted", parsed.operationId, ""),
      recordId: root.recordId,
      eventGameId: root.eventGameId,
      operationId: parsed.operationId,
      presentationChangeId: parsed.presentationChangeId,
      kind: "presentation-accepted",
      classification: "game-presentation-change",
      outcome: "accepted",
      createdAtMs: parsed.acceptedAtMs,
      redactedDetail: "Game Presentation Change accepted and synchronized.",
      previousPresentation: structuredClone(canonicalPrevious),
      resultingPresentation: structuredClone(resulting),
      change: parsed.change,
      grant: parsed.grant,
    };
    transaction.appendPresentationAuditEntry(audit);
    const audits = transaction.listPresentationAuditEntries(root.recordId);
    const effectiveAudits = collapseGamePresentationAuditEntries(audits);
    for (const canonicalAudit of materializePresentationAuditSnapshots(
      root,
      ordered,
      audits,
      defaults,
    )) {
      if (canonicalAudit.kind !== "presentation-accepted") continue;
      const currentAudit = effectiveAudits.find(
        (entry) => entry.auditId === canonicalAudit.auditId,
      );
      if (
        currentAudit !== undefined &&
        (JSON.stringify(currentAudit.previousPresentation) !==
          JSON.stringify(canonicalAudit.previousPresentation) ||
          JSON.stringify(currentAudit.resultingPresentation) !==
            JSON.stringify(canonicalAudit.resultingPresentation))
      )
        transaction.appendPresentationAuditRevision(
          revisionGamePresentationAuditEntry(canonicalAudit),
        );
    }
    transaction.sealPresentationEvidence(root.recordId);
    return { status: "accepted", change: stored, auditId: audit.auditId };
  }

  function readPresentation(recordId: string): GamePresentation {
    const root = transaction.findRootByRecordId(recordId);
    if (root === null) throw new Error("The Event Game Record is not registered.");
    return deriveGamePresentation(
      root.gameSides.map((side) => side.id),
      transaction.listPresentationChanges?.(root.recordId) ?? [],
      presentationDefaults(root, transaction),
    );
  }

  return { correctTeamAssignment, acceptPresentationChange, readPresentation };
}

export function appendConcurrentCorrectionAudits(
  transaction: FoundationStorageTransaction,
  recordId: string,
  acceptedAtMs: number,
): void {
  const actions = transaction.listActions(recordId).map((stored) => stored.action);
  const audits = transaction.listAuditEntries(recordId);
  const auditIds = new Set(audits.map((entry) => entry.auditId));
  const actionsByOperationId = new Map(actions.map((action) => [action.operationId, action]));
  for (const conflict of findConcurrentCorrectionConflicts(actions)) {
    if (conflict.targetFactId === null) continue;
    const left = actionsByOperationId.get(conflict.operationIds[0]);
    const right = actionsByOperationId.get(conflict.operationIds[1]);
    if (left === undefined || right === undefined) continue;
    const entry = createConflictAuditEntry(
      left,
      right,
      conflict.targetFactId,
      conflict.winnerOperationId,
      acceptedAtMs,
    );
    if (auditIds.has(entry.auditId)) continue;
    transaction.appendAuditEntry(entry);
    auditIds.add(entry.auditId);
  }
  for (const conflict of findConcurrentTeamAssignmentConflicts(actions)) {
    const left = actionsByOperationId.get(conflict.operationIds[0]);
    const right = actionsByOperationId.get(conflict.operationIds[1]);
    if (left === undefined || right === undefined || conflict.eventTeamId === undefined) continue;
    const entry = createTeamAssignmentConflictAuditEntry(
      left,
      right,
      conflict.eventTeamId,
      conflict.winnerOperationId,
      acceptedAtMs,
    );
    if (auditIds.has(entry.auditId)) continue;
    transaction.appendAuditEntry(entry);
    auditIds.add(entry.auditId);
  }
}

function compareAuditEntries(
  left: ControlAuditTrailEntry,
  right: ControlAuditTrailEntry,
  presentationRanks: ReadonlyMap<string, number> = new Map(),
): number {
  if (
    isPresentationAuditEntry(left) &&
    isPresentationAuditEntry(right) &&
    left.operationId !== null &&
    right.operationId !== null
  ) {
    const leftRank = presentationRanks.get(left.operationId);
    const rightRank = presentationRanks.get(right.operationId);
    if (leftRank !== undefined && rightRank !== undefined && leftRank !== rightRank) {
      return leftRank - rightRank;
    }
  }
  const leftControl = left as ControlAuditEntry;
  const rightControl = right as ControlAuditEntry;
  const leftOccurrence = leftControl.provenance?.occurrence?.trustedAtMs ?? leftControl.createdAtMs;
  const rightOccurrence =
    rightControl.provenance?.occurrence?.trustedAtMs ?? rightControl.createdAtMs;
  const leftOperation =
    leftControl.operationId ?? leftControl.links?.relatedOperationIds.join(":") ?? "";
  const rightOperation =
    rightControl.operationId ?? rightControl.links?.relatedOperationIds.join(":") ?? "";
  return (
    (leftOccurrence === rightOccurrence ? 0 : leftOccurrence < rightOccurrence ? -1 : 1) ||
    compareOpaqueIdentifiers(leftOperation, rightOperation) ||
    compareOpaqueIdentifiers(left.kind, right.kind) ||
    compareOpaqueIdentifiers(left.auditId, right.auditId)
  );
}

function isPresentationAuditEntry(
  entry: ControlAuditTrailEntry,
): entry is ControlAuditTrailEntry & { classification: "game-presentation-change" } {
  return "classification" in entry && entry.classification === "game-presentation-change";
}

function compareOpaqueIdentifiers(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
