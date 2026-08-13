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
} from "@/lib/foundation-storage";

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
};

export function createEventGameRecord(
  storage: FoundationStorage,
  options: EventGameRecordOptions,
): EventGameRecord {
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
        return await storage.transaction((transaction) => {
          const existing = transaction.findRootByRecordId(root.recordId);
          if (existing !== null) {
            const existingCanonicalContent = canonicalizeEventGameRecordRoot(existing);
            if (existingCanonicalContent === canonicalContent) {
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
          return {
            status: "registered",
            root: cloneEventGameRecordRoot(root),
          } satisfies RootRegistrationOutcome;
        });
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
        throw error;
      }
    },

    readRoot(recordId) {
      return storage.readRoot(recordId);
    },
  };
}

function sameExternalScope(
  left: EventGameRecordRoot["externalScope"],
  right: EventGameRecordRoot["externalScope"],
): boolean {
  return (
    left.eventId === right.eventId &&
    left.gameDayId === right.gameDayId &&
    left.pitchId === right.pitchId &&
    left.pitchSlotId === right.pitchSlotId
  );
}

function classifyRootConflict(
  existing: EventGameRecordRoot,
  incoming: EventGameRecordRoot,
): Extract<RootRegistrationOutcome, { status: "rejected" }>["reason"] {
  if (
    existing.ownership.eventId !== incoming.ownership.eventId ||
    existing.ownership.eventGameId !== incoming.ownership.eventGameId
  ) {
    return "ownership-conflict";
  }
  if (
    existing.externalScope.eventId !== incoming.externalScope.eventId ||
    existing.externalScope.gameDayId !== incoming.externalScope.gameDayId ||
    existing.externalScope.pitchId !== incoming.externalScope.pitchId ||
    existing.externalScope.pitchSlotId !== incoming.externalScope.pitchSlotId
  ) {
    return "external-scope-conflict";
  }
  return "content-conflict";
}

function constraintToConflict(
  error: FoundationStorageConstraintError,
): Extract<RootRegistrationOutcome, { status: "rejected" }>["reason"] {
  switch (error.constraint) {
    case "event-game-id":
      return "ownership-conflict";
    case "pitch-slot-id":
      return "external-scope-conflict";
    case "game-side-id":
      return "stable-side-conflict";
    case "record-id":
      return "content-conflict";
  }
}
