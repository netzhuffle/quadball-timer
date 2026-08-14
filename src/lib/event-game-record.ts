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
  type StoredControlAction,
} from "@/lib/foundation-storage";
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
  type ControlActionCodec,
  type ControlActionCodecRegistry,
  type ControlActionRecoveryProvenance,
  type ControlAuditEntry,
  type EventGameRecordMetadata,
  type IqaGameRulesInterpreter,
} from "@/lib/event-game-actions";

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
};

export type EventGameRecordOptions = {
  externalScopeResolver: ExternalScopeResolver;
  clock?: () => number;
  actionCodecs?: readonly ControlActionCodec[];
  actionCodecRegistry?: ControlActionCodecRegistry;
  interpreter?: IqaGameRulesInterpreter;
  auditAuthorityVerifier?: ControlAuditAuthorityVerifier;
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
  acceptAction(input: unknown): Promise<ControlActionAcceptanceOutcome>;
  readActions(): Promise<StoredControlAction[]>;
  readRecoveryProvenance(): Promise<ControlActionRecoveryProvenance[]>;
  readAudit(credential: unknown): Promise<ControlAuditEntry[]>;
  readMetadata(): Promise<EventGameRecordMetadata | null>;
  rebuild(): Promise<ActionRebuildResult>;
  readiness(): Promise<EventGameRecordReadiness>;
};

export type ControlActionAcceptanceOutcome =
  | {
      status: "accepted" | "duplicate-accepted";
      action: ControlAction;
      auditId: string;
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
      const snapshot: FoundationStorageSnapshot = {
        revision: 0,
        findRootByRecordId: () => root,
        findRootByEventGameId: () => root,
        findRootByPitchSlotId: () => root,
        findRootByGameSideId: () => root,
        findActionByOperationId: (_recordId, operationId) =>
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
      };
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
          const audit = createAuditEntry(
            prepared.value.input,
            "action-accepted",
            ACCEPTED_AUDIT_DETAIL,
            nowMs,
            {
              interpretation: prepared.value.interpretation,
              relatedOperationIds:
                correctionTarget === null ? [] : [correctionTarget.action.operationId],
            },
          );
          transaction.appendAuditEntry(audit);
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
      return entries.sort(compareAuditEntries);
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

function compareAuditEntries(left: ControlAuditEntry, right: ControlAuditEntry): number {
  const leftOccurrence = left.provenance?.occurrence?.trustedAtMs ?? Number.MAX_SAFE_INTEGER;
  const rightOccurrence = right.provenance?.occurrence?.trustedAtMs ?? Number.MAX_SAFE_INTEGER;
  const leftOperation = left.operationId ?? left.links?.relatedOperationIds.join(":") ?? "";
  const rightOperation = right.operationId ?? right.links?.relatedOperationIds.join(":") ?? "";
  return (
    (leftOccurrence === rightOccurrence ? 0 : leftOccurrence < rightOccurrence ? -1 : 1) ||
    compareOpaqueIdentifiers(leftOperation, rightOperation) ||
    compareOpaqueIdentifiers(left.kind, right.kind) ||
    compareOpaqueIdentifiers(left.auditId, right.auditId)
  );
}

function compareOpaqueIdentifiers(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
