import {
  ProbeInterruptedError,
  ProbeReapTimeoutError,
  ProbeTimeoutError,
  ProbeWorkerFailureError,
} from "@/lib/sqlite-foundation-probe-process";
import {
  DockerAdmissionError,
  DockerCleanupError,
  DockerExecutionError,
  DockerOwnershipError,
  DockerResourceLimitError,
} from "@/lib/sqlite-foundation-probe-docker";

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
    error instanceof DockerAdmissionError ||
    error instanceof DockerCleanupError ||
    error instanceof DockerExecutionError ||
    error instanceof DockerOwnershipError ||
    error instanceof DockerResourceLimitError
  ) {
    return new SqliteFoundationGateError(error.message);
  }
  return new SqliteFoundationGateError(
    "SQLite integrity probe could not complete. Return the database choice to a human; do not substitute a canary or custom Bun build.",
  );
}
