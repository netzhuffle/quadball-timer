import { open, readFile, rm, stat } from "node:fs/promises";
import {
  superviseProbeWorkers,
  type ProbeSupervisionOptions,
  type ProbeWorkerHandle,
  type ProbeWorkerResult,
} from "@/lib/sqlite-foundation-probe-process";

export const GRANT_ADMISSION_OVERALL_TIMEOUT_MS = 5_000;
export const GRANT_ADMISSION_TERMINATION_GRACE_MS = 100;
export const GRANT_ADMISSION_REAP_TIMEOUT_MS = 300;
export const GRANT_ADMISSION_ARTIFACT_CLEANUP_MS = 100;
export const GRANT_ADMISSION_CREDENTIAL_MAX_BYTES = 4_096;

type WorkerCommandInput = {
  executablePath: string;
  workerPath: string;
  databasePath: string;
  readyPath: string;
  startPath: string;
  credentialPath: string;
  seed: number;
};

export type GrantAdmissionWorkerDependencies = {
  nowMs(): number;
  sleep(milliseconds: number): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  writeStart(path: string): Promise<unknown>;
  cleanupArtifacts(paths: readonly string[]): Promise<void>;
  superviseWorkers(
    workers: readonly ProbeWorkerHandle[],
    options: ProbeSupervisionOptions,
  ): Promise<ProbeWorkerResult[]>;
};

type SuperviseGrantAdmissionWorkersInput = {
  workers: readonly ProbeWorkerHandle[];
  readyPaths: readonly string[];
  startPath: string;
  artifactPaths?: readonly string[];
  signal?: AbortSignal;
  overallTimeoutMs?: number;
  terminationGraceMs?: number;
  reapTimeoutMs?: number;
  artifactCleanupMs?: number;
  dependencies?: GrantAdmissionWorkerDependencies;
};

export function createGrantAdmissionWorkerEnvironment(
  temporaryDirectory: string,
): Record<string, string> {
  return {
    LANG: "C",
    NO_COLOR: "1",
    TMPDIR: temporaryDirectory,
    TZ: "UTC",
  };
}

export function buildGrantAdmissionWorkerCommand(input: WorkerCommandInput): string[] {
  return [
    input.executablePath,
    "--no-env-file",
    input.workerPath,
    input.databasePath,
    input.readyPath,
    input.startPath,
    input.credentialPath,
    String(input.seed),
  ];
}

export async function writePrivateGrantCredential(path: string, credential: string): Promise<void> {
  const byteLength = Buffer.byteLength(credential, "utf8");
  if (byteLength === 0 || byteLength > GRANT_ADMISSION_CREDENTIAL_MAX_BYTES) {
    throw new Error("Grant credential channel content is invalid.");
  }
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(credential, "utf8");
    await handle.sync();
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
  await assertPrivateCredentialFile(path);
}

export async function readPrivateGrantCredential(path: string): Promise<string> {
  const metadata = await assertPrivateCredentialFile(path);
  if (metadata.size === 0 || metadata.size > GRANT_ADMISSION_CREDENTIAL_MAX_BYTES) {
    throw new Error("Grant credential channel content is invalid.");
  }
  const credential = await readFile(path, "utf8");
  if (Buffer.byteLength(credential, "utf8") !== metadata.size) {
    throw new Error("Grant credential channel changed while being read.");
  }
  return credential;
}

export async function superviseGrantAdmissionWorkers(
  input: SuperviseGrantAdmissionWorkersInput,
): Promise<ProbeWorkerResult[]> {
  const dependencies = input.dependencies ?? defaultDependencies;
  const overallTimeoutMs = input.overallTimeoutMs ?? GRANT_ADMISSION_OVERALL_TIMEOUT_MS;
  const terminationGraceMs = input.terminationGraceMs ?? GRANT_ADMISSION_TERMINATION_GRACE_MS;
  const reapTimeoutMs = input.reapTimeoutMs ?? GRANT_ADMISSION_REAP_TIMEOUT_MS;
  const artifactCleanupMs = input.artifactCleanupMs ?? GRANT_ADMISSION_ARTIFACT_CLEANUP_MS;
  const operationBudgetMs =
    overallTimeoutMs - terminationGraceMs - 2 * reapTimeoutMs - artifactCleanupMs;
  if (input.workers.length === 0 || operationBudgetMs <= 0) {
    throw new Error("Grant admission worker supervision limits are invalid.");
  }

  const startedAtMs = dependencies.nowMs();
  const operationDeadlineMs = startedAtMs + operationBudgetMs;
  const overallDeadlineMs = startedAtMs + overallTimeoutMs;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (input.signal?.aborted) abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  const supervision = dependencies.superviseWorkers(input.workers, {
    signal: controller.signal,
    timeoutMs: operationBudgetMs,
    terminationGraceMs,
    reapTimeoutMs,
    sleep: (milliseconds) => dependencies.sleep(milliseconds),
  });
  let operationError: unknown;
  let results: ProbeWorkerResult[] | undefined;
  try {
    await racePhaseAgainstWorkers(
      waitForBarrier(input.readyPaths, operationDeadlineMs, controller.signal, dependencies),
      supervision,
      "Concurrent Grant workers exited before reaching the barrier.",
    );
    await racePhaseAgainstWorkers(
      dependencies.writeStart(input.startPath),
      supervision,
      "Concurrent Grant workers exited before the start barrier was released.",
    );
    results = await supervision;
  } catch (error) {
    operationError = error;
    controller.abort();
    try {
      await supervision;
    } catch {
      // The operation error remains the primary failure after bounded worker cleanup.
    }
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }

  const cleanupPaths = input.artifactPaths ?? [...input.readyPaths, input.startPath];
  const cleanupBudgetMs = Math.max(0, overallDeadlineMs - dependencies.nowMs());
  const cleaned = await waitWithin(
    dependencies.cleanupArtifacts(cleanupPaths),
    cleanupBudgetMs,
    (milliseconds) => dependencies.sleep(milliseconds),
  );
  if (!cleaned) {
    throw new Error("Concurrent Grant worker artifact cleanup exceeded the overall deadline.");
  }
  if (operationError !== undefined) throw operationError;
  if (results === undefined) throw new Error("Concurrent Grant workers produced no result.");
  return results;
}

async function assertPrivateCredentialFile(path: string) {
  const metadata = await stat(path);
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("Grant credential channel permissions are unsafe.");
  }
  const getuid = process.getuid;
  if (getuid !== undefined && metadata.uid !== getuid.call(process)) {
    throw new Error("Grant credential channel ownership is unsafe.");
  }
  return metadata;
}

async function waitForBarrier(
  paths: readonly string[],
  deadlineMs: number,
  signal: AbortSignal,
  dependencies: GrantAdmissionWorkerDependencies,
): Promise<void> {
  while (!signal.aborted) {
    const ready = await Promise.all(paths.map((path) => dependencies.fileExists(path)));
    if (ready.every(Boolean)) return;
    const remainingMs = deadlineMs - dependencies.nowMs();
    if (remainingMs <= 0) break;
    await dependencies.sleep(Math.min(2, remainingMs));
  }
  throw new Error(
    "Concurrent Grant workers did not reach the barrier within the overall deadline.",
  );
}

async function racePhaseAgainstWorkers(
  phase: Promise<unknown>,
  supervision: Promise<ProbeWorkerResult[]>,
  earlyExitMessage: string,
): Promise<void> {
  const outcome = await Promise.race([
    phase.then(() => "phase" as const),
    supervision.then(() => "workers" as const),
  ]);
  if (outcome === "workers") throw new Error(earlyExitMessage);
}

async function waitWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  return Promise.race([promise.then(() => true), sleep(timeoutMs).then(() => false)]);
}

const defaultDependencies: GrantAdmissionWorkerDependencies = {
  nowMs: Date.now,
  sleep: Bun.sleep,
  fileExists: (path) => Bun.file(path).exists(),
  writeStart: (path) => Bun.write(path, "start"),
  async cleanupArtifacts(paths) {
    await Promise.all(paths.map((path) => rm(path, { force: true })));
  },
  superviseWorkers: superviseProbeWorkers,
};
