import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import packageJson from "../../package.json" with { type: "json" };
import {
  SQLITE_FOUNDATION_PROBE_MAX_OUTPUT_BYTES,
  type ProbeWorkerResult,
} from "@/lib/sqlite-foundation-probe-process";
import {
  SQLITE_FOUNDATION_PROBE_MAX_DISK_BYTES,
  SQLITE_FOUNDATION_PROBE_MAX_MEMORY_BYTES,
  SQLITE_FOUNDATION_PROBE_MAX_PROCESS_COUNT,
  type ProbeResourceMeasurement,
} from "@/lib/sqlite-foundation-probe-result";

export const SQLITE_FOUNDATION_PROBE_DOCKER_IMAGE = "debian:bookworm-slim";
export const SQLITE_FOUNDATION_PROBE_DOCKER_LABEL = "com.quadball-timer.sqlite-probe";
export const SQLITE_FOUNDATION_PROBE_DOCKER_PLATFORM = "linux/amd64";
export const SQLITE_FOUNDATION_PROBE_DOCKER_PROCESS_LIMIT =
  SQLITE_FOUNDATION_PROBE_MAX_PROCESS_COUNT + 1;
export const SQLITE_FOUNDATION_PROBE_DOCKER_TMPFS = `/tmp:rw,size=${SQLITE_FOUNDATION_PROBE_MAX_DISK_BYTES},mode=1777`;
export const SQLITE_FOUNDATION_PROBE_DOCKER_LOG_MAX_SIZE = "4k";
export const SQLITE_FOUNDATION_PROBE_DOCKER_LOG_MAX_FILE = "1";
export const SQLITE_FOUNDATION_PROBE_DOCKER_CREATE_RECONCILIATION_MS = 250;
export const SQLITE_FOUNDATION_PROBE_DOCKER_RECONCILIATION_INTERVAL_MS = 25;
export const SQLITE_FOUNDATION_PROBE_DOCKER_FINAL_CLEANUP_SLICE_MS = 1_000;
export const SQLITE_FOUNDATION_PROBE_DOCKER_INFO_IDENTITY_FORMAT =
  '{"OSType":{{json .OSType}},"Architecture":{{json .Architecture}}}';
export const SQLITE_FOUNDATION_PROBE_DOCKER_VERSION_IDENTITY_FORMAT =
  '{"Os":{{json .Server.Os}},"Arch":{{json .Server.Arch}}}';

export type DockerCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  outputExceeded: boolean;
};

export type DockerCommandRunner = (
  arguments_: readonly string[],
  options?: { signal?: AbortSignal },
) => Promise<DockerCommandResult>;

export type DockerEngineIdentity = {
  os: "linux";
  serverArchitecture: "amd64";
  hostArchitecture: "x86_64";
};

export type DockerProbeContainer = {
  id: string;
  name: string;
  capability: string;
  artifactPath: string;
  identityVerified: boolean;
};

export type DockerAdmissionDisposition = "not-created" | "removed" | "unverified";

export type DockerArtifactIdentity = {
  os: "linux";
  architecture: "x64";
  bunVersion: string;
  bunRevision: string;
  sqliteVersion: string;
};

export type DockerProbeExecution = {
  container: DockerProbeContainer;
  run: (signal?: AbortSignal) => Promise<ProbeWorkerResult>;
  stop: (signal?: AbortSignal) => Promise<void>;
  cleanup: (signal?: AbortSignal) => Promise<{
    identityVerified: boolean;
    removed: boolean;
    descendantsTerminated?: boolean;
    descendantsReaped?: boolean;
    temporaryDataRemoved?: boolean;
  }>;
};

export type DockerProbeDependencies = {
  runCommand?: DockerCommandRunner;
  signal?: AbortSignal;
  admissionSignal?: AbortSignal;
  reconciliationSignal?: AbortSignal;
  platform?: NodeJS.Platform;
  architecture?: string;
  invocationId?: string;
  image?: string;
  cleanupSignal?: AbortSignal;
  expectedBunVersion?: string;
};

export type DockerProbeLifecycle = {
  workSignal: AbortSignal;
  admissionSignal: AbortSignal;
  reconciliationSignal: AbortSignal;
  cleanupSignal: AbortSignal;
};

export type DockerCleanupLifecycle = {
  cleanupSignal: AbortSignal;
  reconciliationSignal: AbortSignal;
  /** True only when the caller has proved create never reached the daemon. */
  preCreateConfirmed?: boolean;
};

export type DockerContainerArguments = {
  name: string;
  capability: string;
  artifactPath?: string;
  command: readonly string[];
  image?: string;
};

export function buildDockerContainerArguments(input: DockerContainerArguments): string[] {
  const image = input.image ?? SQLITE_FOUNDATION_PROBE_DOCKER_IMAGE;
  const arguments_ = [
    "create",
    "--name",
    input.name,
    "--label",
    `${SQLITE_FOUNDATION_PROBE_DOCKER_LABEL}=${input.capability}`,
    "--platform",
    SQLITE_FOUNDATION_PROBE_DOCKER_PLATFORM,
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    SQLITE_FOUNDATION_PROBE_DOCKER_TMPFS,
    "--memory",
    String(SQLITE_FOUNDATION_PROBE_MAX_MEMORY_BYTES),
    "--pids-limit",
    String(SQLITE_FOUNDATION_PROBE_DOCKER_PROCESS_LIMIT),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--log-driver",
    "json-file",
    "--log-opt",
    `max-size=${SQLITE_FOUNDATION_PROBE_DOCKER_LOG_MAX_SIZE}`,
    "--log-opt",
    `max-file=${SQLITE_FOUNDATION_PROBE_DOCKER_LOG_MAX_FILE}`,
    "--user",
    "65532:65532",
    "--env",
    "LANG=C",
    "--env",
    "LC_ALL=C",
    "--env",
    "NODE_ENV=test",
    "--env",
    "NO_COLOR=1",
    "--env",
    "TMPDIR=/tmp",
    "--env",
    "TZ=UTC",
    "--workdir",
    "/tmp",
  ];
  if (input.artifactPath !== undefined) {
    arguments_.push(
      "--mount",
      `type=bind,src=${input.artifactPath},dst=/opt/quadball-timer,readonly`,
    );
  }
  arguments_.push(image, ...input.command);
  return arguments_;
}

export function parseDockerEngineIdentity(
  infoOutput: string,
  versionOutput: string,
): DockerEngineIdentity | null {
  try {
    const info = JSON.parse(infoOutput) as Record<string, unknown>;
    const server = JSON.parse(versionOutput) as Record<string, unknown>;
    const os = info.OSType;
    const hostArchitecture = info.Architecture;
    const serverOs = server.Os;
    const serverArchitecture = server.Arch;
    if (
      os !== "linux" ||
      serverOs !== "linux" ||
      hostArchitecture !== "x86_64" ||
      serverArchitecture !== "amd64"
    ) {
      return null;
    }
    return { os: "linux", serverArchitecture: "amd64", hostArchitecture: "x86_64" };
  } catch {
    return null;
  }
}

export async function admitDockerEngine(
  dependencies: DockerProbeDependencies = {},
): Promise<DockerEngineIdentity> {
  const platform = dependencies.platform ?? process.platform;
  const architecture = dependencies.architecture ?? process.arch;
  if (platform !== "linux" || architecture !== "x64") {
    throw new DockerAdmissionError("Native Linux x86-64 is required for Docker qualification.");
  }
  const runCommand = dependencies.runCommand ?? runDockerCommand;
  const [info, version] = await Promise.all([
    runCommand(["info", "--format", SQLITE_FOUNDATION_PROBE_DOCKER_INFO_IDENTITY_FORMAT], {
      signal: dependencies.signal,
    }),
    runCommand(["version", "--format", SQLITE_FOUNDATION_PROBE_DOCKER_VERSION_IDENTITY_FORMAT], {
      signal: dependencies.signal,
    }),
  ]);
  if (
    info.exitCode !== 0 ||
    version.exitCode !== 0 ||
    info.outputExceeded ||
    version.outputExceeded
  ) {
    throw new DockerAdmissionError("The Docker engine is not reachable.");
  }
  const identity = parseDockerEngineIdentity(info.stdout, version.stdout);
  if (identity === null) {
    throw new DockerAdmissionError(
      "Docker engine architecture or operating system is not unambiguously native Linux x86-64.",
    );
  }
  return identity;
}

export async function createDockerProbeExecution(
  executablePath: string,
  dependencies: DockerProbeDependencies = {},
): Promise<DockerProbeExecution> {
  const runCommand = dependencies.runCommand ?? runDockerCommand;
  const cleanupSignal = dependencies.cleanupSignal ?? new AbortController().signal;
  const reconciliationSignal = dependencies.reconciliationSignal ?? cleanupSignal;
  const admissionSignal = dependencies.admissionSignal ?? dependencies.signal;
  await admitDockerEngine({ ...dependencies, runCommand });
  const artifactPath = await validateArtifactPath(executablePath);
  const expectedBunVersion = dependencies.expectedBunVersion ?? expectedPackageBunVersion();
  const capability = dependencies.invocationId ?? crypto.randomUUID();
  const name = `quadball-timer-sqlite-${capability}`;
  const create = await runCommand(
    buildDockerContainerArguments({
      name,
      capability,
      artifactPath,
      command: ["/opt/quadball-timer", "--sqlite-foundation-probe"],
      image: dependencies.image,
    }),
    // A work-timeout may race the daemon-side create request. Keep the Docker
    // client alive through the cleanup reserve so the daemon's create result is
    // reconciled before final evidence is emitted.
    { signal: cleanupSignal },
  ).catch(() => null);
  if (create === null || create.exitCode !== 0 || create.outputExceeded) {
    const cleanupDisposition = await cleanupMalformedCreateOutput(runCommand, name, capability, {
      cleanupSignal,
      reconciliationSignal,
    });
    throw new DockerAdmissionError(
      "Docker could not create the owned qualification container.",
      cleanupDisposition,
    );
  }
  const id = parseContainerId(create.stdout);
  if (id === null) {
    const cleanupDisposition = await cleanupMalformedCreateOutput(runCommand, name, capability, {
      cleanupSignal,
      reconciliationSignal,
    });
    throw new DockerAdmissionError(
      "Docker returned an invalid qualification container identity.",
      cleanupDisposition,
    );
  }
  const container: DockerProbeContainer = {
    id,
    name,
    capability,
    artifactPath,
    identityVerified: false,
  };
  if (admissionSignal?.aborted) {
    const disposition = await cleanupLateCreatedDockerContainer(
      runCommand,
      container,
      cleanupSignal,
    );
    throw new DockerAdmissionError(
      "Docker admission completed after its work deadline.",
      disposition,
    );
  }
  const admitted = await verifyDockerContainerConfiguration(
    runCommand,
    container,
    admissionSignal,
    artifactPath,
  );
  if (!admitted) {
    const cleanup = await cleanupOwnedDockerContainer(runCommand, container, cleanupSignal);
    throw new DockerAdmissionError(
      "Docker container containment admission could not be verified.",
      cleanup.identityVerified && cleanup.removed ? "removed" : "unverified",
    );
  }
  const execution: DockerProbeExecution = {
    container,
    run: async (signal) => {
      const start = await runCommand(["start", id], { signal });
      if (start.exitCode !== 0)
        throw new DockerExecutionError("Docker could not start the container.");
      const waitPromise = runCommand(["wait", id], { signal });
      const statsAbort = new AbortController();
      const removeStatsAbort = forwardAbort(signal, statsAbort);
      const statsPromise = runCommand(["stats", "--format", "{{json .}}", id], {
        signal: statsAbort.signal,
      });
      try {
        const wait = await waitPromise;
        statsAbort.abort();
        const stats = await statsPromise.catch(() => emptyDockerCommandResult());
        const logs = await runCommand(["logs", id], { signal });
        const stdout = {
          stdout: logs.stdout,
          stdoutBytes: logs.stdoutBytes,
          outputExceeded: logs.outputExceeded,
        };
        const stderr = {
          stderr: logs.stderr,
          stderrBytes: logs.stderrBytes,
          outputExceeded: logs.outputExceeded,
        };
        const measurement = parseDockerResourceMeasurement(stats.stdout, stdout, stderr);
        const exitCode = parseDockerWaitExitCode(wait);
        const result: ProbeWorkerResult = {
          exitCode,
          stdout: stdout.stdout,
          stderr: stderr.stderr,
          stdoutBytes: stdout.stdoutBytes,
          stderrBytes: stderr.stderrBytes,
          outputExceeded: stdout.outputExceeded || stderr.outputExceeded,
          observedOutputBytes: stdout.stdoutBytes + stderr.stderrBytes,
          measurement,
        };
        if (stats.outputExceeded || isDockerResourceViolation(measurement, stdout, stderr)) {
          throw new DockerResourceLimitError(measurement, result);
        }
        if (logs.exitCode !== 0)
          throw new DockerExecutionError("Docker logs did not complete successfully.", result);
        verifyArtifactIdentity(stdout.stdout, expectedBunVersion, result);
        if (exitCode !== 0)
          throw new DockerExecutionError("The SQLite qualification workload failed.", result);
        container.identityVerified = await verifyOwnedContainer(runCommand, container, signal);
        if (!container.identityVerified)
          throw new DockerExecutionError(
            "Owned Docker container identity could not be verified.",
            result,
          );
        return result;
      } finally {
        statsAbort.abort();
        await statsPromise.catch(() => {});
        removeStatsAbort();
      }
    },
    stop: async (signal) => {
      const stop = await runCommand(["stop", "--time", "1", id], { signal });
      if (stop.exitCode !== 0) {
        await runCommand(["kill", id], { signal });
      }
      const wait = await runCommand(["wait", id], { signal });
      parseDockerWaitExitCode(wait);
    },
    cleanup: async (signal) => {
      const cleanup = await cleanupOwnedDockerContainer(runCommand, container, signal);
      container.identityVerified = cleanup.identityVerified;
      if (!cleanup.identityVerified) throw new DockerOwnershipError();
      if (!cleanup.removed) throw new DockerCleanupError();
      return {
        ...cleanup,
        descendantsTerminated: true,
        descendantsReaped: true,
        temporaryDataRemoved: true,
      };
    },
  };
  return execution;
}

export async function runDockerCommand(
  arguments_: readonly string[],
  options: { signal?: AbortSignal } = {},
): Promise<DockerCommandResult> {
  const child = Bun.spawn(["docker", ...arguments_], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let outputKillTimer: ReturnType<typeof setTimeout> | undefined;
  const outputBudget = { observedBytes: 0, capturedBytes: 0, exceeded: false };
  const enforceOutput = () => {
    if (outputBudget.exceeded) return;
    outputBudget.exceeded = true;
    child.kill("SIGTERM");
    outputKillTimer = setTimeout(() => child.kill("SIGKILL"), 250);
  };
  const abort = () => {
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
  };
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readDockerOutput(child.stdout, outputBudget, enforceOutput),
      readDockerOutput(child.stderr, outputBudget, enforceOutput),
      child.exited,
    ]);
    return {
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutBytes: stdout.bytes,
      stderrBytes: stderr.bytes,
      outputExceeded: outputBudget.exceeded || stdout.truncated || stderr.truncated,
    };
  } finally {
    if (killTimer !== undefined) clearTimeout(killTimer);
    if (outputKillTimer !== undefined) clearTimeout(outputKillTimer);
    options.signal?.removeEventListener("abort", abort);
  }
}

export function buildFocusedDockerCommand(
  name: string,
  capability: string,
  image = SQLITE_FOUNDATION_PROBE_DOCKER_IMAGE,
): string[] {
  return buildDockerContainerArguments({
    name,
    capability,
    image,
    command: [
      "/bin/sh",
      "-eu",
      "-c",
      'test "$PWD" = /tmp; test "$TMPDIR" = /tmp; test ! -e /run/secrets; test ! -w /etc; test ! -w /; test ! -e /opt/quadball-timer; sleep 1',
    ],
  });
}

export function parseDockerResourceMeasurement(
  statsOutput: string,
  stdout: Pick<DockerCommandResult, "stdoutBytes" | "stdout">,
  stderr: Pick<DockerCommandResult, "stderrBytes" | "stderr">,
): ProbeResourceMeasurement {
  let processCount: number | null = null;
  let peakMemoryBytes: number | null = null;
  for (const line of statsOutput.split(/\r?\n/)) {
    try {
      const stats = JSON.parse(line) as Record<string, unknown>;
      const sampleProcessCount = parseInteger(stats.PIDs);
      const sampleMemoryBytes = parseByteQuantity(
        typeof stats.MemUsage === "string" ? (stats.MemUsage.split(" /")[0] ?? "") : "",
      );
      if (sampleProcessCount !== null)
        processCount = Math.max(processCount ?? 0, sampleProcessCount);
      if (sampleMemoryBytes !== null)
        peakMemoryBytes = Math.max(peakMemoryBytes ?? 0, sampleMemoryBytes);
    } catch {
      // Ignore the stream terminator and retain only complete, parseable samples.
    }
  }
  return {
    processCount: processCount === null ? null : Math.max(0, processCount - 1),
    peakMemoryBytes,
    diskBytes: parseObservedDiskBytes(stdout.stdout),
    resourceViolations: /(?:ENOSPC|no space left on device)/i.test(
      `${stdout.stdout}\n${stderr.stderr}`,
    )
      ? ["disk-lower-bound"]
      : [],
    outputBytes: stdout.stdoutBytes + stderr.stderrBytes,
  };
}

export function isDockerResourceViolation(
  measurement: ProbeResourceMeasurement,
  stdout: Pick<DockerCommandResult, "outputExceeded" | "stdout">,
  stderr: Pick<DockerCommandResult, "outputExceeded" | "stderr">,
): boolean {
  const outputViolation = stdout.outputExceeded || stderr.outputExceeded;
  const diskViolation = /(?:ENOSPC|no space left on device)/i.test(
    `${stdout.stdout}\n${stderr.stderr}`,
  );
  return (
    outputViolation ||
    diskViolation ||
    measurement.resourceViolations?.includes("disk-lower-bound") === true ||
    (measurement.processCount !== null &&
      measurement.processCount > SQLITE_FOUNDATION_PROBE_MAX_PROCESS_COUNT) ||
    (measurement.peakMemoryBytes !== null &&
      measurement.peakMemoryBytes > SQLITE_FOUNDATION_PROBE_MAX_MEMORY_BYTES) ||
    (measurement.diskBytes !== null &&
      measurement.diskBytes > SQLITE_FOUNDATION_PROBE_MAX_DISK_BYTES) ||
    (measurement.outputBytes !== null &&
      measurement.outputBytes > SQLITE_FOUNDATION_PROBE_MAX_OUTPUT_BYTES)
  );
}

export function parseContainerId(value: string): string | null {
  const candidate = value.trim();
  return /^[0-9a-f]{64}$/.test(candidate) ? candidate : null;
}

export async function verifyOwnedDockerContainerAbsence(
  runCommand: DockerCommandRunner,
  id: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(id)) return false;
  const result = await runCommand(
    ["ps", "--all", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}}"],
    { signal },
  ).catch(() => null);
  if (result === null || result.exitCode !== 0 || result.outputExceeded) return false;
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length === 0;
}

export async function cleanupOwnedDockerContainer(
  runCommand: DockerCommandRunner,
  container: Pick<DockerProbeContainer, "id" | "name" | "capability">,
  signal?: AbortSignal,
): Promise<{ identityVerified: boolean; removed: boolean }> {
  const identityVerified = await verifyOwnedContainer(runCommand, container, signal);
  if (!identityVerified) return { identityVerified: false, removed: false };
  const removed = await runCommand(["rm", "--force", container.id], { signal }).catch(() => null);
  if (removed === null || removed.exitCode !== 0 || removed.outputExceeded)
    return { identityVerified: true, removed: false };
  return {
    identityVerified: true,
    removed: await verifyOwnedDockerContainerAbsence(runCommand, container.id, signal),
  };
}

export async function cleanupLateCreatedDockerContainer(
  runCommand: DockerCommandRunner,
  container: Pick<DockerProbeContainer, "id" | "name" | "capability">,
  signal?: AbortSignal,
): Promise<DockerAdmissionDisposition> {
  const cleanup = await cleanupOwnedDockerContainer(runCommand, container, signal);
  return cleanup.identityVerified && cleanup.removed ? "removed" : "unverified";
}

async function verifyOwnedContainer(
  runCommand: DockerCommandRunner,
  container: Pick<DockerProbeContainer, "id" | "name" | "capability">,
  signal?: AbortSignal,
): Promise<boolean> {
  const inspected = await runCommand(["inspect", "--format", "{{json .}}", container.id], {
    signal,
  });
  if (inspected.exitCode !== 0 || inspected.outputExceeded) return false;
  return isOwnedDockerContainerInspection(
    inspected.stdout,
    container.id,
    container.name,
    container.capability,
  );
}

export async function verifyDockerContainerConfiguration(
  runCommand: DockerCommandRunner,
  container: Pick<DockerProbeContainer, "id" | "name" | "capability">,
  signal: AbortSignal | undefined,
  artifactPath: string | null,
): Promise<boolean> {
  const inspected = await runCommand(["inspect", "--format", "{{json .}}", container.id], {
    signal,
  }).catch(() => null);
  if (inspected === null || inspected.exitCode !== 0 || inspected.outputExceeded) return false;
  return isDockerContainerConfigurationAdmitted(
    inspected.stdout,
    container.id,
    container.name,
    container.capability,
    artifactPath,
  );
}

export function isDockerContainerConfigurationAdmitted(
  value: string,
  id: string,
  name: string,
  capability: string,
  artifactPath: string | null,
): boolean {
  try {
    const inspected = JSON.parse(value) as Record<string, unknown>;
    const config = inspected.Config as Record<string, unknown> | undefined;
    const hostConfig = inspected.HostConfig as Record<string, unknown> | undefined;
    const labels = config?.Labels as Record<string, unknown> | undefined;
    const mounts = Array.isArray(inspected.Mounts) ? inspected.Mounts : [];
    const tmpfs = hostConfig?.Tmpfs as Record<string, unknown> | undefined;
    const capDrop = Array.isArray(hostConfig?.CapDrop) ? hostConfig.CapDrop : [];
    const capAdd = Array.isArray(hostConfig?.CapAdd) ? hostConfig.CapAdd : [];
    const securityOptions = Array.isArray(hostConfig?.SecurityOpt) ? hostConfig.SecurityOpt : [];
    const logConfig = hostConfig?.LogConfig as Record<string, unknown> | undefined;
    const logOptions = logConfig?.Config as Record<string, unknown> | undefined;
    const environment = Array.isArray(config?.Env) ? config.Env : [];
    const devices = hostConfig?.Devices;
    const deviceRequests = hostConfig?.DeviceRequests;
    const artifactMount = mounts.find(
      (mount): mount is Record<string, unknown> =>
        typeof mount === "object" &&
        mount !== null &&
        (mount as Record<string, unknown>).Destination === "/opt/quadball-timer",
    );
    const tmpfsMounts = mounts.filter(
      (mount) =>
        typeof mount === "object" &&
        mount !== null &&
        (mount as Record<string, unknown>).Type === "tmpfs" &&
        (mount as Record<string, unknown>).Destination === "/tmp",
    );
    return (
      inspected.Id === id &&
      inspected.Name === `/${name}` &&
      labels?.[SQLITE_FOUNDATION_PROBE_DOCKER_LABEL] === capability &&
      hostConfig?.NetworkMode === "none" &&
      hostConfig.Privileged === false &&
      hostConfig.PidMode === "" &&
      hostConfig.IpcMode === "private" &&
      hostConfig.UsernsMode === "" &&
      hostConfig.CgroupnsMode === "private" &&
      hostConfig.CgroupParent === "" &&
      (devices === null || (Array.isArray(devices) && devices.length === 0)) &&
      (deviceRequests === null || (Array.isArray(deviceRequests) && deviceRequests.length === 0)) &&
      hostConfig.ReadonlyRootfs === true &&
      hostConfig.Memory === SQLITE_FOUNDATION_PROBE_MAX_MEMORY_BYTES &&
      hostConfig.PidsLimit === SQLITE_FOUNDATION_PROBE_DOCKER_PROCESS_LIMIT &&
      capDrop.includes("ALL") &&
      securityOptions.includes("no-new-privileges:true") &&
      logConfig?.Type === "json-file" &&
      logOptions?.["max-size"] === SQLITE_FOUNDATION_PROBE_DOCKER_LOG_MAX_SIZE &&
      logOptions?.["max-file"] === SQLITE_FOUNDATION_PROBE_DOCKER_LOG_MAX_FILE &&
      tmpfs?.["/tmp"] === `rw,size=${SQLITE_FOUNDATION_PROBE_MAX_DISK_BYTES},mode=1777` &&
      capAdd.length === 0 &&
      config?.User === "65532:65532" &&
      config.WorkingDir === "/tmp" &&
      environment.every(isAllowlistedDockerEnvironment) &&
      hasRequiredDockerEnvironment(environment) &&
      tmpfsMounts.length === 1 &&
      (tmpfsMounts[0] as Record<string, unknown>).RW === true &&
      (artifactPath === null
        ? artifactMount === undefined && mounts.length === 1
        : artifactMount?.Type === "bind" &&
          artifactMount.Source === artifactPath &&
          artifactMount.Destination === "/opt/quadball-timer" &&
          artifactMount.RW === false &&
          mounts.length === 2)
    );
  } catch {
    return false;
  }
}

export function isOwnedDockerContainerInspection(
  value: string,
  id: string,
  name: string,
  capability: string,
): boolean {
  try {
    const inspected = JSON.parse(value) as Record<string, unknown>;
    const labels = (inspected.Config as { Labels?: unknown } | undefined)?.Labels;
    const inspectedId = typeof inspected.Id === "string" ? inspected.Id : "";
    const inspectedName =
      typeof inspected.Name === "string" ? inspected.Name.replace(/^\//, "") : "";
    return (
      inspectedId === id &&
      inspectedName === name &&
      (labels as Record<string, unknown> | undefined)?.[SQLITE_FOUNDATION_PROBE_DOCKER_LABEL] ===
        capability
    );
  } catch {
    return false;
  }
}

async function validateArtifactPath(executablePath: string): Promise<string> {
  const resolved = path.resolve(executablePath);
  const metadata = await lstat(resolved).catch(() => null);
  if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw new DockerAdmissionError("The exact compiled artifact is not a regular file.");
  }
  const canonical = await realpath(resolved).catch(() => null);
  if (canonical === null)
    throw new DockerAdmissionError("The exact compiled artifact path is unavailable.");
  return canonical;
}

async function readDockerOutput(
  stream: ReadableStream<Uint8Array<ArrayBufferLike>>,
  budget: { observedBytes: number; capturedBytes: number; exceeded: boolean },
  onExceeded: () => void,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      budget.observedBytes += next.value.byteLength;
      const allowed = Math.max(0, SQLITE_FOUNDATION_PROBE_MAX_OUTPUT_BYTES - budget.capturedBytes);
      if (allowed > 0) chunks.push(next.value.slice(0, allowed));
      budget.capturedBytes += Math.min(allowed, next.value.byteLength);
      if (next.value.byteLength > allowed) {
        truncated = true;
        onExceeded();
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged), bytes, truncated };
}

function parseDockerWaitExitCode(result: Pick<DockerCommandResult, "exitCode" | "stdout">): number {
  if (result.exitCode !== 0 || !/^(?:0|[1-9][0-9]*)\n?$/.test(result.stdout))
    throw new DockerExecutionError("Docker wait did not return an exact exit code.");
  const exitCode = Number(result.stdout.trim());
  if (!Number.isSafeInteger(exitCode))
    throw new DockerExecutionError("Docker wait returned an unsafe exit code.");
  return exitCode;
}

function emptyDockerCommandResult(): DockerCommandResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    outputExceeded: false,
  };
}

function parseInteger(value: unknown): number | null {
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseByteQuantity(value: string): number | null {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*(B|KiB|MiB|GiB)?$/i.exec(value.trim());
  if (match === null) return null;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "B").toLowerCase();
  const multiplier =
    unit === "kib" ? 1024 : unit === "mib" ? 1024 ** 2 : unit === "gib" ? 1024 ** 3 : 1;
  const result = Math.ceil(amount * multiplier);
  return Number.isSafeInteger(result) ? result : null;
}

function parseObservedDiskBytes(stdout: string): number | null {
  try {
    const report = JSON.parse(stdout.trim()) as Record<string, unknown>;
    const value = report.temporaryDataBytes;
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function isAllowlistedDockerEnvironment(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const key = value.split("=", 1)[0];
  return ["LANG", "LC_ALL", "NODE_ENV", "NO_COLOR", "TMPDIR", "TZ", "PATH"].includes(key ?? "");
}

function hasRequiredDockerEnvironment(environment: readonly unknown[]): boolean {
  const values = new Map<string, string>();
  for (const entry of environment) {
    if (typeof entry !== "string") return false;
    const separator = entry.indexOf("=");
    if (separator <= 0) return false;
    const key = entry.slice(0, separator);
    if (values.has(key)) return false;
    values.set(key, entry.slice(separator + 1));
  }
  const required = [
    ["LANG", "C"],
    ["LC_ALL", "C"],
    ["NODE_ENV", "test"],
    ["NO_COLOR", "1"],
    ["TMPDIR", "/tmp"],
    ["TZ", "UTC"],
  ] as const satisfies ReadonlyArray<readonly [string, string]>;
  return required.every(([key, expected]) => values.get(key) === expected);
}

function forwardAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (source === undefined) return () => {};
  const abort = () => target.abort();
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

export async function cleanupMalformedCreateOutput(
  runCommand: DockerCommandRunner,
  name: string,
  capability: string,
  lifecycle: DockerCleanupLifecycle,
): Promise<DockerAdmissionDisposition> {
  let observedEmpty = false;
  let observedNonEmpty = false;
  while (!lifecycle.reconciliationSignal.aborted) {
    const discovery = await discoverMalformedCreateContainer(
      runCommand,
      name,
      capability,
      lifecycle.reconciliationSignal,
    );
    if (discovery.kind === "unverified") return "unverified";
    if (discovery.kind === "cutoff") break;
    if (discovery.kind === "empty") {
      observedEmpty = true;
    } else if (discovery.kind === "found") {
      const candidate: DockerProbeContainer = {
        id: discovery.id,
        name,
        capability,
        artifactPath: "",
        identityVerified: false,
      };
      const cleanup = await cleanupOwnedDockerContainer(
        runCommand,
        candidate,
        lifecycle.cleanupSignal,
      );
      return cleanup.identityVerified && cleanup.removed ? "removed" : "unverified";
    } else {
      observedNonEmpty = true;
    }
    if (!(await waitForDockerReconciliationInterval(lifecycle.reconciliationSignal))) break;
  }
  return observedEmpty && !observedNonEmpty && lifecycle.preCreateConfirmed === true
    ? "not-created"
    : "unverified";
}

async function discoverMalformedCreateContainer(
  runCommand: DockerCommandRunner,
  name: string,
  capability: string,
  signal?: AbortSignal,
): Promise<
  | { kind: "empty" }
  | { kind: "found"; id: string; atCutoff?: boolean }
  | { kind: "one-sided" }
  | { kind: "cutoff" }
  | { kind: "unverified" }
> {
  const byName = await discoverDockerContainerDimension(runCommand, ["name", `^/${name}$`], signal);
  if (byName.kind === "cutoff") return byName;
  if (byName.kind === "unverified") return byName;
  const byCapability = await discoverDockerContainerDimension(
    runCommand,
    ["label", `${SQLITE_FOUNDATION_PROBE_DOCKER_LABEL}=${capability}`],
    signal,
  );
  if (byCapability.kind === "cutoff")
    return byName.kind === "found" ? { kind: "found", id: byName.id } : byCapability;
  if (byCapability.kind === "unverified") return byCapability;
  if (byName.kind === "empty" && byCapability.kind === "empty") return { kind: "empty" };
  if (byName.kind === "found" && byCapability.kind === "found") {
    return byName.id === byCapability.id
      ? { kind: "found", id: byName.id }
      : { kind: "unverified" };
  }
  if (byCapability.kind === "found" && byCapability.atCutoff)
    return { kind: "found", id: byCapability.id };
  if (byName.kind === "found" && byName.atCutoff) return { kind: "found", id: byName.id };
  if (byName.kind === "found" || byCapability.kind === "found") return { kind: "one-sided" };
  return { kind: "unverified" };
}

async function discoverDockerContainerDimension(
  runCommand: DockerCommandRunner,
  filter: readonly ["name" | "label", string],
  signal?: AbortSignal,
): Promise<
  | { kind: "empty" }
  | { kind: "found"; id: string; atCutoff?: boolean }
  | { kind: "cutoff" }
  | { kind: "unverified" }
> {
  if (signal?.aborted) return { kind: "cutoff" };
  const discovered = await runCommand(
    ["ps", "--all", "--no-trunc", "--filter", `${filter[0]}=${filter[1]}`, "--format", "{{.ID}}"],
    { signal },
  ).catch(() => null);
  if (discovered === null) return signal?.aborted ? { kind: "cutoff" } : { kind: "unverified" };
  if (discovered.exitCode !== 0 || discovered.outputExceeded) return { kind: "unverified" };
  const completedAfterCutoff = signal?.aborted === true;
  const lines = discovered.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return completedAfterCutoff ? { kind: "cutoff" } : { kind: "empty" };
  const id = lines.length === 1 ? parseContainerId(lines[0] ?? "") : null;
  return id === null
    ? { kind: "unverified" }
    : { kind: "found", id, atCutoff: completedAfterCutoff };
}

async function waitForDockerReconciliationInterval(signal: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => finish(false);
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    timer = setTimeout(
      () => finish(true),
      SQLITE_FOUNDATION_PROBE_DOCKER_RECONCILIATION_INTERVAL_MS,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function parseDockerArtifactIdentity(
  stdout: string,
  expectedBunVersion = expectedPackageBunVersion(),
): DockerArtifactIdentity | null {
  try {
    const report = JSON.parse(stdout.trim()) as Record<string, unknown>;
    const identity = report.artifactIdentity;
    if (typeof identity !== "object" || identity === null) return null;
    const value = identity as Record<string, unknown>;
    if (
      value.os !== "linux" ||
      value.architecture !== "x64" ||
      value.bunVersion !== expectedBunVersion ||
      typeof value.bunRevision !== "string" ||
      !/^[0-9a-f]{8,64}$/i.test(value.bunRevision) ||
      typeof value.sqliteVersion !== "string" ||
      !isSupportedEmbeddedSqliteVersion(value.sqliteVersion)
    )
      return null;
    return {
      os: "linux",
      architecture: "x64",
      bunVersion: value.bunVersion,
      bunRevision: value.bunRevision,
      sqliteVersion: value.sqliteVersion,
    };
  } catch {
    return null;
  }
}

function verifyArtifactIdentity(
  stdout: string,
  expectedBunVersion: string,
  result: ProbeWorkerResult,
): void {
  if (parseDockerArtifactIdentity(stdout, expectedBunVersion) === null)
    throw new DockerExecutionError("The exact artifact identity was not verified.", result);
}

export function isSupportedEmbeddedSqliteVersion(value: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (match === null) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return (
    major !== undefined &&
    minor !== undefined &&
    patch !== undefined &&
    (major > 3 || (major === 3 && (minor > 51 || (minor === 51 && patch >= 3))))
  );
}

function expectedPackageBunVersion(): string {
  const packageManager = packageJson.packageManager;
  return typeof packageManager === "string" && packageManager.startsWith("bun@")
    ? packageManager.slice("bun@".length)
    : "";
}

export class DockerAdmissionError extends Error {
  readonly disposition: DockerAdmissionDisposition;

  constructor(message: string, disposition: DockerAdmissionDisposition = "not-created") {
    super(message);
    this.name = "DockerAdmissionError";
    this.disposition = disposition;
  }
}

export class DockerExecutionError extends Error {
  readonly result: ProbeWorkerResult | undefined;

  constructor(message: string, result?: ProbeWorkerResult) {
    super(message);
    this.name = "DockerExecutionError";
    this.result = result;
  }
}

export class DockerOwnershipError extends Error {
  constructor() {
    super("Owned Docker container identity could not be verified.");
    this.name = "DockerOwnershipError";
  }
}

export class DockerCleanupError extends Error {
  constructor() {
    super("Owned Docker container cleanup could not be verified.");
    this.name = "DockerCleanupError";
  }
}

export class DockerResourceLimitError extends Error {
  readonly measurement: ProbeResourceMeasurement;
  readonly result: ProbeWorkerResult;

  constructor(measurement: ProbeResourceMeasurement, result: ProbeWorkerResult) {
    super("Docker qualification exceeded an enforced resource or output limit.");
    this.name = "DockerResourceLimitError";
    this.measurement = measurement;
    this.result = result;
  }
}
