import { Database } from "bun:sqlite";
import {
  buildProbeWorkerCommand,
  capDiagnosticOutput,
  createProbeOutputBudget,
  installProbeSignalHandlers,
  readSingleValueFromWorker,
  spawnProbeWorker,
  SQLITE_FOUNDATION_PROBE_INNER_TIMEOUT_MS,
  SQLITE_FOUNDATION_PROBE_MAX_OUTPUT_BYTES,
  SQLITE_FOUNDATION_PROBE_TERMINATION_GRACE_MS,
  SQLITE_FOUNDATION_PROBE_TIMEOUT_MS,
  superviseProbeWorkers,
  type ProbeSupervisionOptions,
  type ProbeWorkerResult,
} from "@/lib/sqlite-foundation-probe-process";
import {
  SqliteFoundationGateError,
  translateProbeError,
} from "@/lib/sqlite-foundation-probe-errors";
import {
  cleanupOwnedProbeWorkspace,
  createProbeWorkspace,
  measureOwnedProbeWorkspaceBytes,
  parseSqliteProbeInvocation,
  ProbeOwnershipError,
  SQLITE_FOUNDATION_PROBE_WRITER_COUNT,
  validateOwnedProbeWorkspace,
  validateOwnedProbeWorkerWorkspace,
  type ProbeWorkspace,
} from "@/lib/sqlite-foundation-probe-containment";

export {
  buildProbeWorkerCommand,
  capDiagnosticOutput,
  createProbeOutputBudget,
  cleanupOwnedProbeWorkspace,
  createProbeWorkspace,
  measureOwnedProbeWorkspaceBytes,
  parseSqliteProbeInvocation,
  validateOwnedProbeWorkspace,
  validateOwnedProbeWorkerWorkspace,
  SQLITE_FOUNDATION_PROBE_MAX_OUTPUT_BYTES,
  SQLITE_FOUNDATION_PROBE_INNER_TIMEOUT_MS,
  SQLITE_FOUNDATION_PROBE_TERMINATION_GRACE_MS,
  SQLITE_FOUNDATION_PROBE_TIMEOUT_MS,
  superviseProbeWorkers,
};
export type {
  ProbeProcess,
  ProbeSupervisionOptions,
  ProbeWorkerHandle,
  ProbeWorkerResult,
} from "@/lib/sqlite-foundation-probe-process";
export type {
  ProbeWorkspace,
  ProbeWorkspaceState,
  SqliteProbeInvocation,
} from "@/lib/sqlite-foundation-probe-containment";
export {
  admitDockerEngine,
  buildDockerContainerArguments,
  buildFocusedDockerCommand,
  cleanupMalformedCreateOutput,
  cleanupOwnedDockerContainer,
  createDockerProbeExecution,
  isDockerResourceViolation,
  isSupportedEmbeddedSqliteVersion,
  parseContainerId,
  parseDockerArtifactIdentity,
  parseDockerEngineIdentity,
  verifyOwnedDockerContainerAbsence,
  verifyDockerContainerConfiguration,
  DockerAdmissionError,
  DockerCleanupError,
  DockerExecutionError,
  DockerOwnershipError,
  DockerResourceLimitError,
} from "@/lib/sqlite-foundation-probe-docker";
export type {
  DockerAdmissionDisposition,
  DockerCommandResult,
  DockerArtifactIdentity,
  DockerCleanupLifecycle,
  DockerProbeDependencies,
  DockerProbeLifecycle,
  DockerProbeExecution,
} from "@/lib/sqlite-foundation-probe-docker";
export {
  SQLITE_FOUNDATION_PROBE_COMMAND,
  SQLITE_FOUNDATION_PROBE_MAX_DISK_BYTES,
  SQLITE_FOUNDATION_PROBE_MAX_MEMORY_BYTES,
  SQLITE_FOUNDATION_PROBE_MAX_PROCESS_COUNT,
} from "@/lib/sqlite-foundation-probe-result";
export type { ProbeQualificationResult, ProbeOutcome } from "@/lib/sqlite-foundation-probe-result";
export { runCompiledSqliteFoundationProbe } from "@/lib/sqlite-foundation-probe-runner";
export type {
  CompiledSqliteFoundationProbeOptions,
  CompiledSqliteFoundationProbeResult,
} from "@/lib/sqlite-foundation-probe-runner";
export { SqliteFoundationGateError } from "@/lib/sqlite-foundation-probe-errors";

const SQLITE_MINIMUM_VERSION = [3, 51, 3] as const;
const SQLITE_OWNERSHIP_TABLE = "foundation_probe_ownership";
const SQLITE_WRITES_TABLE = "foundation_probe_writes";

export const SQLITE_FOUNDATION_PROBE_WORKLOAD = {
  writerCount: SQLITE_FOUNDATION_PROBE_WRITER_COUNT,
  rowsPerWriter: 1_000,
  passiveCheckpointAttempts: 5_000,
} as const;

type CheckpointRow = {
  busy: number;
  log: number;
  checkpointed: number;
};

export type SqliteFoundationProbeReport = {
  artifactIdentity: {
    os: string;
    architecture: string;
    bunVersion: string;
    bunRevision: string;
    sqliteVersion: string;
  };
  bunVersion: string;
  bunRevision: string;
  sqliteVersion: string;
  expectedRows: number;
  actualRows: number;
  passiveCheckpointAttempts: number;
  passiveCheckpointBusyCount: number;
  finalCheckpoint: CheckpointRow;
  integrityCheck: string;
  quickCheck: string;
  foreignKeyViolations: number;
  duplicateKeys: number;
  temporaryDataBytes: number;
};

export function isSupportedSqliteVersion(version: string): boolean {
  const parsed = parseSqliteVersion(version);
  if (parsed === null) {
    return false;
  }

  for (let index = 0; index < SQLITE_MINIMUM_VERSION.length; index += 1) {
    const minimumPart = SQLITE_MINIMUM_VERSION[index];
    const actualPart = parsed[index] ?? 0;
    if (minimumPart === undefined) {
      return false;
    }
    if (actualPart > minimumPart) {
      return true;
    }
    if (actualPart < minimumPart) {
      return false;
    }
  }

  return true;
}

export async function runSqliteFoundationProbe(
  executablePath = process.execPath,
  options: ProbeSupervisionOptions = {},
): Promise<SqliteFoundationProbeReport> {
  const signalScope = options.signal === undefined ? installProbeSignalHandlers() : null;
  const supervisionOptions = {
    ...options,
    timeoutMs: options.timeoutMs ?? SQLITE_FOUNDATION_PROBE_INNER_TIMEOUT_MS,
    ...(signalScope === null ? {} : { signal: signalScope.signal }),
  };
  let workspace: ProbeWorkspace | undefined;
  let report: SqliteFoundationProbeReport | undefined;
  let probeError: SqliteFoundationGateError | undefined;

  try {
    const probeWorkspace = await createProbeWorkspace();
    workspace = probeWorkspace;
    const runtime = await prepareProbeDatabase(probeWorkspace);
    if (!isSupportedSqliteVersion(runtime.sqliteVersion)) {
      throw new SqliteFoundationGateError(
        `SQLite delivery stopped: ${runtime.sqliteVersion} is earlier than the supported minimum 3.51.3. Return the database choice to a human; do not substitute a canary or custom Bun build.`,
      );
    }

    const outputBudget = createProbeOutputBudget();
    const workers = [
      ...Array.from({ length: SQLITE_FOUNDATION_PROBE_WORKLOAD.writerCount }, (_, writer) =>
        spawnProbeWorker(
          executablePath,
          "--sqlite-foundation-probe-writer",
          [probeWorkspace.directoryPath, probeWorkspace.capability, String(writer)],
          { outputBudget },
        ),
      ),
      spawnProbeWorker(
        executablePath,
        "--sqlite-foundation-probe-checkpoint",
        [probeWorkspace.directoryPath, probeWorkspace.capability],
        { outputBudget },
      ),
    ];
    const results = await superviseProbeWorkers(workers, supervisionOptions);
    report = await verifyProbeDatabase(probeWorkspace, runtime, results);
  } catch (error) {
    probeError = translateProbeError(error);
  }

  let cleanupError: SqliteFoundationGateError | undefined;
  if (workspace !== undefined) {
    try {
      await cleanupOwnedProbeWorkspace(workspace.directoryPath, workspace.capability);
    } catch {
      cleanupError = new SqliteFoundationGateError(
        "SQLite integrity probe cleanup could not be verified; return the database choice to a human.",
      );
    }
  }
  signalScope?.cleanup();

  if (probeError !== undefined) {
    throw probeError;
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
  if (report === undefined) {
    throw new SqliteFoundationGateError(
      "SQLite integrity probe could not complete. Return the database choice to a human; do not substitute a canary or custom Bun build.",
    );
  }
  return report;
}

export async function runSqliteFoundationProbeWorker(
  mode: "writer" | "checkpoint",
  directoryPath: string,
  capability: string,
  writerId?: number,
): Promise<void> {
  const workspace = await validateOwnedProbeWorkerWorkspace(directoryPath, capability, "database");
  const database = await openOwnedProbeDatabase(workspace);
  try {
    if (mode === "writer") {
      if (
        writerId === undefined ||
        !Number.isSafeInteger(writerId) ||
        writerId < 0 ||
        writerId >= SQLITE_FOUNDATION_PROBE_WORKLOAD.writerCount
      ) {
        throw new ProbeOwnershipError();
      }
      runWriter(database, writerId);
      return;
    }

    const busyCount = await runPassiveCheckpoints(database);
    console.log(JSON.stringify({ busyCount }));
  } finally {
    database.close();
  }
}

async function prepareProbeDatabase(workspace: ProbeWorkspace) {
  await validateOwnedProbeWorkspace(workspace.directoryPath, workspace.capability, "fresh");
  const database = new Database(workspace.databasePath, { create: true, readwrite: true });
  try {
    configureProbeDatabase(database);
    database.exec(`
      CREATE TABLE ${SQLITE_OWNERSHIP_TABLE} (
        capability TEXT NOT NULL PRIMARY KEY
      ) STRICT
    `);
    database.exec(`
      CREATE TABLE ${SQLITE_WRITES_TABLE} (
        writer INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        PRIMARY KEY (writer, sequence)
      ) STRICT
    `);
    database
      .query(`INSERT INTO ${SQLITE_OWNERSHIP_TABLE} (capability) VALUES (?)`)
      .run(workspace.capability);
    return readRuntimeIdentity(database);
  } finally {
    database.close();
  }
}

async function verifyProbeDatabase(
  workspace: ProbeWorkspace,
  runtime: { bunVersion: string; bunRevision: string; sqliteVersion: string },
  results: readonly ProbeWorkerResult[],
): Promise<SqliteFoundationProbeReport> {
  const database = await openOwnedProbeDatabase(workspace);
  try {
    const finalCheckpoint = readCheckpoint(database, "TRUNCATE");
    const integrityCheck = readSingleValue(database, "PRAGMA integrity_check") ?? "";
    const quickCheck = readSingleValue(database, "PRAGMA quick_check") ?? "";
    const foreignKeyViolations = database.query("PRAGMA foreign_key_check").all().length;
    const actualRows = readNumber(database, `SELECT COUNT(*) AS count FROM ${SQLITE_WRITES_TABLE}`);
    const duplicateKeys = database
      .query(
        `SELECT writer, sequence FROM ${SQLITE_WRITES_TABLE} GROUP BY writer, sequence HAVING COUNT(*) > 1`,
      )
      .all().length;
    const checkpointResult = results[SQLITE_FOUNDATION_PROBE_WORKLOAD.writerCount];
    const passiveCheckpointBusyCount = Number(
      readSingleValueFromWorker(checkpointResult?.stdout ?? "", "busyCount") ?? 0,
    );

    const report: SqliteFoundationProbeReport = {
      artifactIdentity: {
        os: process.platform,
        architecture: process.arch,
        bunVersion: runtime.bunVersion,
        bunRevision: runtime.bunRevision,
        sqliteVersion: runtime.sqliteVersion,
      },
      ...runtime,
      expectedRows:
        SQLITE_FOUNDATION_PROBE_WORKLOAD.writerCount *
        SQLITE_FOUNDATION_PROBE_WORKLOAD.rowsPerWriter,
      actualRows,
      passiveCheckpointAttempts: SQLITE_FOUNDATION_PROBE_WORKLOAD.passiveCheckpointAttempts,
      passiveCheckpointBusyCount,
      finalCheckpoint,
      integrityCheck,
      quickCheck,
      foreignKeyViolations,
      duplicateKeys,
      temporaryDataBytes: await measureOwnedProbeWorkspaceBytes(
        workspace.directoryPath,
        workspace.capability,
      ),
    };

    if (
      report.actualRows !== report.expectedRows ||
      report.finalCheckpoint.busy !== 0 ||
      report.finalCheckpoint.log !== 0 ||
      report.finalCheckpoint.checkpointed !== 0 ||
      report.integrityCheck !== "ok" ||
      report.quickCheck !== "ok" ||
      report.foreignKeyViolations !== 0 ||
      report.duplicateKeys !== 0
    ) {
      throw new SqliteFoundationGateError(
        `SQLite integrity probe failed: ${JSON.stringify(report)}. Return the database choice to a human; do not substitute a canary or custom Bun build.`,
      );
    }

    return report;
  } finally {
    database.close();
  }
}

async function openOwnedProbeDatabase(workspace: ProbeWorkspace): Promise<Database> {
  const validatedWorkspace = await validateOwnedProbeWorkspace(
    workspace.directoryPath,
    workspace.capability,
    "database",
  );
  const database = new Database(validatedWorkspace.databasePath, {
    create: false,
    readwrite: true,
  });
  try {
    const ownership = database
      .query(`SELECT 1 AS owned FROM ${SQLITE_OWNERSHIP_TABLE} WHERE capability = ?`)
      .get(validatedWorkspace.capability) as { owned: number } | null;
    if (ownership?.owned !== 1) {
      throw new ProbeOwnershipError();
    }
    configureProbeDatabase(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function configureProbeDatabase(database: Database): void {
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA wal_autocheckpoint = 0");
  database.exec("PRAGMA busy_timeout = 5000");
}

function readRuntimeIdentity(database: Database) {
  const sqliteVersion = readSingleValue(database, "SELECT sqlite_version()") ?? "";
  return {
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    sqliteVersion,
  };
}

function runWriter(database: Database, writerId: number): void {
  const insert = database.query(
    `INSERT INTO ${SQLITE_WRITES_TABLE} (writer, sequence) VALUES (?, ?)`,
  );

  for (let sequence = 0; sequence < SQLITE_FOUNDATION_PROBE_WORKLOAD.rowsPerWriter; sequence += 1) {
    let committed = false;
    for (let attempt = 0; attempt < 20 && !committed; attempt += 1) {
      try {
        database.exec("BEGIN IMMEDIATE");
        insert.run(writerId, sequence);
        database.exec("COMMIT");
        committed = true;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // The transaction may not have started when SQLite reported a busy connection.
        }
        if (!isBusyError(error) || attempt === 19) {
          throw error;
        }
        Bun.sleepSync(5);
      }
    }
  }
}

async function runPassiveCheckpoints(database: Database): Promise<number> {
  let busyCount = 0;
  for (
    let attempt = 0;
    attempt < SQLITE_FOUNDATION_PROBE_WORKLOAD.passiveCheckpointAttempts;
    attempt += 1
  ) {
    const result = readCheckpoint(database, "PASSIVE");
    if (result.busy !== 0) {
      busyCount += 1;
    }
    if (attempt % 100 === 0) {
      await Bun.sleep(0);
    }
  }
  return busyCount;
}

function readCheckpoint(database: Database, mode: "PASSIVE" | "TRUNCATE"): CheckpointRow {
  const row = database.query(`PRAGMA wal_checkpoint(${mode})`).get() as CheckpointRow | null;
  if (row === null) {
    throw new Error(`SQLite did not return a ${mode} checkpoint result.`);
  }
  return row;
}

function readSingleValue(database: Database, query: string): string | null {
  const row = database.query(query).get() as Record<string, unknown> | null;
  if (row === null) {
    return null;
  }
  const value = Object.values(row)[0];
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return value === undefined ? null : JSON.stringify(value);
}

function readNumber(database: Database, query: string): number {
  const value = readSingleValue(database, query);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new Error("SQLite query did not return a safe integer.");
  }
  return result;
}

function parseSqliteVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isBusyError(error: unknown): boolean {
  return error instanceof Error && /busy|locked/i.test(error.message);
}
