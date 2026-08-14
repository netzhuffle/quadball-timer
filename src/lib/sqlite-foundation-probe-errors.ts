import {
  ProbeInterruptedError,
  ProbeReapTimeoutError,
  ProbeTimeoutError,
  ProbeWorkerFailureError,
} from "@/lib/sqlite-foundation-probe-process";
import { ProbeNetworkBoundaryError } from "@/lib/sqlite-foundation-probe-network";
import {
  ProbeResourceControlError,
  ProbeResourceLimitError,
} from "@/lib/sqlite-foundation-probe-resources";

export class SqliteFoundationGateError extends Error {
  readonly decisionRequired = true;

  constructor(message: string) {
    super(message);
    this.name = "SqliteFoundationGateError";
  }
}

export function translateProbeError(error: unknown): SqliteFoundationGateError {
  if (error instanceof SqliteFoundationGateError) return error;
  if (
    error instanceof ProbeTimeoutError ||
    error instanceof ProbeInterruptedError ||
    error instanceof ProbeReapTimeoutError ||
    error instanceof ProbeWorkerFailureError ||
    error instanceof ProbeNetworkBoundaryError ||
    error instanceof ProbeResourceControlError ||
    error instanceof ProbeResourceLimitError
  ) {
    return new SqliteFoundationGateError(error.message);
  }
  return new SqliteFoundationGateError(
    "SQLite integrity probe could not complete. Return the database choice to a human; do not substitute a canary or custom Bun build.",
  );
}
