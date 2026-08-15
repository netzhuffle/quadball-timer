import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  buildDockerContainerArguments,
  SQLITE_FOUNDATION_PROBE_DOCKER_LOG_MAX_FILE,
  SQLITE_FOUNDATION_PROBE_DOCKER_LOG_MAX_SIZE,
  SQLITE_FOUNDATION_PROBE_DOCKER_PLATFORM,
  SQLITE_FOUNDATION_PROBE_DOCKER_PROCESS_LIMIT,
  SQLITE_FOUNDATION_PROBE_DOCKER_TMPFS,
} from "@/lib/sqlite-foundation-probe-docker";
import {
  isCompleteQualificationEntry,
  parseQualificationRegistry,
  routeQualificationRequest,
  type QualificationEntry,
  type QualificationRequest,
  type RoutingDecision,
} from "@/lib/testing-policy";
import {
  SQLITE_FOUNDATION_PROBE_COMMAND,
  SQLITE_FOUNDATION_PROBE_MAX_DISK_BYTES,
  SQLITE_FOUNDATION_PROBE_MAX_MEMORY_BYTES,
} from "@/lib/sqlite-foundation-probe-result";
import {
  SQLITE_FOUNDATION_PROBE_MAX_OUTPUT_BYTES,
  SQLITE_FOUNDATION_PROBE_MAX_PROCESS_COUNT,
  SQLITE_FOUNDATION_PROBE_REAP_TIMEOUT_MS,
  SQLITE_FOUNDATION_PROBE_TIMEOUT_MS,
} from "@/lib/sqlite-foundation-probe-process";

const policyMarkdown = await Bun.file("docs/agents/testing.md").text();
const registry = parseQualificationRegistry(policyMarkdown);
const registryEntries = Object.values(registry);
const registeredEntry = registryEntries[0];
if (
  registeredEntry === undefined ||
  registryEntries.some((entry) => !isCompleteQualificationEntry(entry))
) {
  throw new Error("The canonical Qualification Test registry is missing or incomplete.");
}

const dockerArguments = buildDockerContainerArguments({
  name: "policy-parity",
  capability: "policy-parity",
  artifactPath: "/policy/artifact",
  command: ["/opt/quadball-timer", "--sqlite-foundation-probe"],
});
const dockerCommand = dockerArguments.join(" ");
const dockerSource = await Bun.file("src/lib/sqlite-foundation-probe-docker.ts").text();
const runnerSource = await Bun.file("src/lib/sqlite-foundation-probe-runner.ts").text();
const requiredDockerParity: ReadonlyArray<[string, boolean]> = [
  [
    "network",
    registeredEntry.network.includes("--network=none") && dockerCommand.includes("--network none"),
  ],
  [
    "read-only root",
    registeredEntry.isolation.includes("--read-only") && dockerArguments.includes("--read-only"),
  ],
  [
    "tmpfs disk",
    registeredEntry.isolation.includes("16 MiB") &&
      dockerCommand.includes(`--tmpfs ${SQLITE_FOUNDATION_PROBE_DOCKER_TMPFS}`),
  ],
  [
    "memory",
    registeredEntry.expectedDuration.includes("512 MiB") &&
      dockerCommand.includes("--memory 536870912"),
  ],
  [
    "pids",
    registeredEntry.expectedDuration.includes("7 observed") &&
      dockerCommand.includes(`--pids-limit ${SQLITE_FOUNDATION_PROBE_DOCKER_PROCESS_LIMIT}`),
  ],
  [
    "capabilities",
    registeredEntry.isolation.includes("dropped capabilities") &&
      dockerCommand.includes("--cap-drop ALL"),
  ],
  [
    "no-new-privileges",
    registeredEntry.isolation.includes("no-new-privileges") &&
      dockerCommand.includes("no-new-privileges:true"),
  ],
  [
    "artifact/platform",
    registeredEntry.platform.includes("native Linux x86-64") &&
      registeredEntry.artifact.includes("exact executable") &&
      dockerCommand.includes(`--platform ${SQLITE_FOUNDATION_PROBE_DOCKER_PLATFORM}`),
  ],
  [
    "artifact mount/environment",
    registeredEntry.isolation.includes("read-only bind mount") &&
      registeredEntry.network.includes("sanitized environment") &&
      dockerCommand.includes("dst=/opt/quadball-timer,readonly") &&
      dockerCommand.includes("LANG=C") &&
      dockerCommand.includes("LC_ALL=C") &&
      dockerCommand.includes("NODE_ENV=test") &&
      dockerCommand.includes("TMPDIR=/tmp") &&
      !dockerCommand.includes("GITHUB_TOKEN") &&
      !dockerCommand.includes("DATABASE_URL"),
  ],
  [
    "bounded daemon logs",
    registeredEntry.expectedDuration.includes("4 KiB") &&
      dockerCommand.includes("--log-driver json-file") &&
      dockerCommand.includes(`--log-opt max-size=${SQLITE_FOUNDATION_PROBE_DOCKER_LOG_MAX_SIZE}`) &&
      dockerCommand.includes(`--log-opt max-file=${SQLITE_FOUNDATION_PROBE_DOCKER_LOG_MAX_FILE}`),
  ],
  [
    "deadline/output",
    registeredEntry.expectedDuration.includes("15 seconds") &&
      registeredEntry.expectedDuration.includes("5 seconds") &&
      registeredEntry.expectedDuration.includes("4 KiB") &&
      dockerSource.includes("SQLITE_FOUNDATION_PROBE_MAX_OUTPUT_BYTES") &&
      runnerSource.includes("SQLITE_FOUNDATION_PROBE_CLEANUP_RESERVE_MS"),
  ],
  [
    "routing",
    policyMarkdown.includes("test:focused-signal") &&
      policyMarkdown.includes("test:focused-admission") &&
      policyMarkdown.includes("Qualification Tests use distinct commands"),
  ],
];
for (const [label, matches] of requiredDockerParity) {
  if (!matches) throw new Error(`Canonical Docker registry parity is missing: ${label}`);
}
if (registeredEntry.command !== SQLITE_FOUNDATION_PROBE_COMMAND) {
  throw new Error("Canonical Qualification Test command diverges from the harness command.");
}
const limits = registeredEntry.resourceLimits;
if (
  limits.timeoutMs !== SQLITE_FOUNDATION_PROBE_TIMEOUT_MS ||
  limits.processCount !== SQLITE_FOUNDATION_PROBE_MAX_PROCESS_COUNT ||
  limits.memoryBytes !== SQLITE_FOUNDATION_PROBE_MAX_MEMORY_BYTES ||
  limits.diskBytes !== SQLITE_FOUNDATION_PROBE_MAX_DISK_BYTES ||
  limits.outputBytes !== SQLITE_FOUNDATION_PROBE_MAX_OUTPUT_BYTES ||
  limits.descendantCleanupMs !== SQLITE_FOUNDATION_PROBE_REAP_TIMEOUT_MS
) {
  throw new Error("Canonical Qualification Test resource limits diverge from the harness limits.");
}

const dryRunCases: ReadonlyArray<
  [string, QualificationRequest, Readonly<Record<string, QualificationEntry>>, RoutingDecision]
> = [
  [
    "explicit registered qualification request",
    { kind: "qualification", mode: "run", name: registeredEntry.command },
    registry,
    "invoke-once",
  ],
  ["ordinary test request", { kind: "ordinary" }, {}, "ordinary-boundary"],
  ["ordinary check request", { kind: "ordinary" }, {}, "ordinary-boundary"],
  ["ordinary build request", { kind: "ordinary" }, {}, "ordinary-boundary"],
  ["ordinary implementation request", { kind: "ordinary" }, {}, "ordinary-boundary"],
  ["ordinary review request", { kind: "ordinary" }, {}, "ordinary-boundary"],
  [
    "validate-only qualification request",
    { kind: "qualification", mode: "validate", name: registeredEntry.command },
    registry,
    "inspect-without-invocation",
  ],
  [
    "review-only qualification request",
    { kind: "qualification", mode: "review", name: registeredEntry.command },
    registry,
    "inspect-without-invocation",
  ],
  [
    "empty-registry qualification request",
    { kind: "qualification", mode: "run", name: registeredEntry.command },
    {},
    "refuse-unregistered",
  ],
];

function assertDecision(actual: RoutingDecision, expected: RoutingDecision, requestName: string) {
  if (actual !== expected) {
    throw new Error(`${requestName}: expected ${expected}, received ${actual}`);
  }
}

console.log("Testing policy routing dry-run:");
let simulatedLaunchCount = 0;
for (const [requestName, request, caseRegistry, expected] of dryRunCases) {
  const decision = routeQualificationRequest(request, caseRegistry);
  assertDecision(decision, expected, requestName);
  if (decision === "invoke-once") simulatedLaunchCount += 1;
  console.log(`- ${requestName}: ${decision}`);
}

if (simulatedLaunchCount !== 1) {
  throw new Error(`expected one simulated explicit invocation, received ${simulatedLaunchCount}`);
}

const commandToken = registeredEntry.command.split(" ")[2];
if (commandToken === undefined)
  throw new Error("Canonical Qualification Test command is malformed.");
const qualificationScript = path.join("scripts", `${commandToken.replaceAll(":", "-")}.ts`);
const packageJson = (await Bun.file("package.json").json()) as {
  scripts: Record<string, string>;
};
for (const [scriptName, command] of Object.entries(packageJson.scripts)) {
  if (scriptName !== commandToken && command.includes(commandToken)) {
    throw new Error(`Ordinary package script invokes the Qualification Test: ${scriptName}`);
  }
}

for (const filePath of [
  ...(await filesUnder(".github/workflows")),
  ...(await filesUnder("scripts")),
  ...(await filesUnder("deploy")),
  "build.ts",
]) {
  if (filePath === "scripts/check-testing-policy.ts") continue;
  if (filePath === qualificationScript) continue;
  const contents = await Bun.file(filePath).text();
  if (contents.includes(commandToken)) {
    throw new Error(`Ordinary workflow/script invokes the Qualification Test: ${filePath}`);
  }
}

console.log("Literal qualification command is absent from ordinary workflow/script chains.");
console.log("Dry-run passed; no qualification workload was launched.");

async function filesUnder(directoryPath: string): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const childPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(childPath)));
    else if (entry.isFile()) files.push(childPath);
  }
  return files;
}
