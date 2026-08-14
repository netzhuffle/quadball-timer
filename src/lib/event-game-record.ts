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
  type StoredControlAction,
} from "@/lib/foundation-storage";
import {
  ACCEPTED_AUDIT_DETAIL,
  acceptedAuditId,
  classifyRootConflict,
  constraintToConflict,
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

/**
 * Resolves the external Event hierarchy without exposing external storage rows.
 * The transaction capability is the same synchronous snapshot used to accept the owned root.
 */
export type ExternalScopeResolver = {
  resolve(
    scope: EventGameRecordRoot["externalScope"],
    snapshot: FoundationStorageSnapshot,
  ): ExternalScopeResolution;
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
  const auditFailure = validateAuditHistory(root, storedActions, auditEntries);
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

export function createEventGameRecord(
  storage: FoundationStorage,
  options: EventGameRecordOptions,
): EventGameRecord {
  const clock = options.clock ?? (() => Date.now());
  const codecRegistry =
    options.actionCodecRegistry ?? createControlActionCodecRegistry(options.actionCodecs);
  let activeRecordId: string | undefined;
  let verifiedRevision: number | undefined;

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

          const prepared = prepareControlAction(input, root, codecRegistry, nowMs);
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
            );
            transaction.appendAuditEntry(audit);
            return {
              status: "rejected",
              reason: dependencyReason.reason,
              detail: dependencyReason.detail,
            } satisfies ControlActionAcceptanceOutcome;
          }

          if (prepared.value.interpretation.type === "correction") {
            const target = findFactById(
              transaction.listActions(root.recordId),
              prepared.value.interpretation.targetFactId,
            );
            if (target === null) {
              const audit = createAuditEntry(
                prepared.value.input,
                "action-rejected",
                "correction target is not a retained Game Fact",
                nowMs,
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
          transaction.insertAction({
            action,
            canonicalContent: prepared.value.canonicalContent,
            contentFingerprint: prepared.value.contentFingerprint,
          });
          const previousMetadata = transaction.readRecordMetadata(root.recordId);
          const lastAcceptedAtMs =
            previousMetadata?.lastAcceptedAtMs === null ||
            previousMetadata?.lastAcceptedAtMs === undefined
              ? nowMs
              : Math.max(previousMetadata.lastAcceptedAtMs, nowMs);
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
          );
          transaction.appendAuditEntry(audit);
          nextVerifiedRevision = transaction.revision + 1;
          return {
            status: "accepted",
            action,
            auditId: audit.auditId,
          } satisfies ControlActionAcceptanceOutcome;
        });
        if (outcome.status === "accepted" && nextVerifiedRevision !== undefined) {
          verifiedRevision = nextVerifiedRevision;
        } else if (outcome.status !== "duplicate-accepted") {
          verifiedRevision = undefined;
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
      return storage.readAuditEntries(currentRecordId());
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
