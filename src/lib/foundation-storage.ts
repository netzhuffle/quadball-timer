import type { EventGameRecordRoot } from "@/lib/foundation-record-types";

export type StoredEventGameRecordRoot = {
  root: EventGameRecordRoot;
  canonicalContent: string;
};

export type FoundationStorageReadiness =
  | {
      ok: true;
      schemaVersion: string;
      storage: "memory" | "sqlite";
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
        | "not-writeable";
      detail: string;
      storage: "memory" | "sqlite";
    };

export type FoundationStorageSnapshot = {
  findRootByRecordId(recordId: string): EventGameRecordRoot | null;
  findRootByEventGameId(eventGameId: string): EventGameRecordRoot | null;
  findRootByPitchSlotId(pitchSlotId: string): EventGameRecordRoot | null;
  findRootByGameSideId(gameSideId: string): EventGameRecordRoot | null;
};

export type FoundationStorageTransaction = FoundationStorageSnapshot & {
  insertRoot(root: StoredEventGameRecordRoot): void;
};

export type FoundationStorageTransactionWork<T> = (transaction: FoundationStorageTransaction) => T;

export interface FoundationStorage {
  transaction<T>(work: FoundationStorageTransactionWork<T>): Promise<T>;
  readRoot(recordId: string): Promise<EventGameRecordRoot | null>;
  readiness(): Promise<FoundationStorageReadiness>;
  close(): void;
}

export type FoundationStorageConstraint =
  | "record-id"
  | "event-game-id"
  | "pitch-slot-id"
  | "game-side-id";

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
