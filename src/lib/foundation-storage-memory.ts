import {
  canonicalizeEventGameRecordRoot,
  cloneEventGameRecordRoot,
  validateEventGameRecordRoot,
  type EventGameRecordRoot,
} from "@/lib/foundation-record-types";
import {
  FoundationStorageClosedError,
  FoundationStorageConstraintError,
  type FoundationStorage,
  type FoundationStorageReadiness,
  type FoundationStorageTransaction,
  type FoundationStorageTransactionWork,
  type StoredEventGameRecordRoot,
  isThenable,
} from "@/lib/foundation-storage";

type MemoryState = Map<string, StoredEventGameRecordRoot>;

export function createInMemoryFoundationStorage(): FoundationStorage {
  return new InMemoryFoundationStorage();
}

class InMemoryFoundationStorage implements FoundationStorage {
  private state: MemoryState = new Map();
  private writerTail: Promise<void> = Promise.resolve();
  private closed = false;

  transaction<T>(work: FoundationStorageTransactionWork<T>): Promise<T> {
    const operation = this.writerTail.then(() => {
      this.assertOpen();
      const workingState = cloneState(this.state);
      const transaction = createTransaction(workingState);
      const result = work(transaction);
      if (isThenable(result)) {
        throw new TypeError("Foundation storage transactions must complete synchronously.");
      }

      this.state = workingState;
      return result;
    });
    this.writerTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async readRoot(recordId: string): Promise<EventGameRecordRoot | null> {
    return this.writerTail.then(() => {
      this.assertOpen();
      const stored = this.state.get(recordId);
      return stored === undefined ? null : cloneEventGameRecordRoot(stored.root);
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
      for (const stored of this.state.values()) {
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

  private assertOpen(): void {
    if (this.closed) {
      throw new FoundationStorageClosedError();
    }
  }
}

function createTransaction(state: MemoryState): FoundationStorageTransaction {
  return {
    findRootByRecordId(recordId) {
      return cloneStoredRoot(state.get(recordId));
    },
    findRootByEventGameId(eventGameId) {
      return findRoot(state, (stored) => stored.root.eventGameId === eventGameId);
    },
    findRootByPitchSlotId(pitchSlotId) {
      return findRoot(state, (stored) => stored.root.externalScope.pitchSlotId === pitchSlotId);
    },
    findRootByGameSideId(gameSideId) {
      return findRoot(state, (stored) =>
        stored.root.gameSides.some((side) => side.id === gameSideId),
      );
    },
    insertRoot(storedRoot) {
      if (state.has(storedRoot.root.recordId)) {
        throw new FoundationStorageConstraintError("record-id");
      }
      if (
        findRoot(state, (stored) => stored.root.eventGameId === storedRoot.root.eventGameId) !==
        null
      ) {
        throw new FoundationStorageConstraintError("event-game-id");
      }
      if (
        findRoot(
          state,
          (stored) =>
            stored.root.externalScope.pitchSlotId === storedRoot.root.externalScope.pitchSlotId,
        ) !== null
      ) {
        throw new FoundationStorageConstraintError("pitch-slot-id");
      }
      for (const side of storedRoot.root.gameSides) {
        if (
          findRoot(state, (stored) =>
            stored.root.gameSides.some((candidate) => candidate.id === side.id),
          ) !== null
        ) {
          throw new FoundationStorageConstraintError("game-side-id");
        }
      }

      state.set(storedRoot.root.recordId, {
        root: cloneEventGameRecordRoot(storedRoot.root),
        canonicalContent: storedRoot.canonicalContent,
      });
    },
  };
}

function findRoot(
  state: MemoryState,
  predicate: (stored: StoredEventGameRecordRoot) => boolean,
): EventGameRecordRoot | null {
  for (const stored of state.values()) {
    if (predicate(stored)) {
      return cloneEventGameRecordRoot(stored.root);
    }
  }

  return null;
}

function cloneStoredRoot(
  stored: StoredEventGameRecordRoot | undefined,
): EventGameRecordRoot | null {
  return stored === undefined ? null : cloneEventGameRecordRoot(stored.root);
}

function cloneState(state: MemoryState): MemoryState {
  return new Map(
    [...state.entries()].map(([recordId, stored]) => [
      recordId,
      {
        root: cloneEventGameRecordRoot(stored.root),
        canonicalContent: stored.canonicalContent,
      },
    ]),
  );
}
