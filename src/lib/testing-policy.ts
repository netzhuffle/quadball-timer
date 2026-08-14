export type QualificationEntry = {
  command: string;
  owner: string;
  protectedRisk: string;
  cheaperEvidence: string;
  platform: string;
  artifact: string;
  isolation: string;
  expectedDuration: string;
  resourceLimits: {
    timeoutMs: number;
    processCount: number;
    memoryBytes: number;
    diskBytes: number;
    outputBytes: number;
    descendantCleanupMs: number;
  };
  occasions: string;
  network: string;
  credentials: string;
  filesystem: string;
  productionExclusions: string;
  result: string;
  retention: string;
  replacementCondition: string;
};

export type QualificationRegistry = Readonly<Record<string, QualificationEntry>>;

const REGISTRY_LABELS = {
  Owner: "owner",
  "Protected risk": "protectedRisk",
  "Why cheaper evidence is insufficient": "cheaperEvidence",
  "Platform and artifact": "platformArtifact",
  "Isolation and filesystem": "isolationFilesystem",
  "Expected duration and resource envelope": "expectedDurationAndResources",
  "Approved occasions and venue": "occasions",
  "Network and credentials": "networkCredentials",
  "Production exclusions": "productionExclusions",
  "Result and diagnostics": "resultDiagnostics",
  Retention: "retention",
  "Replacement/removal condition": "replacementCondition",
} as const;

export function parseQualificationRegistry(markdown: string): QualificationRegistry {
  const lines = markdown.split(/\r?\n/);
  const registry: Record<string, QualificationEntry> = {};
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^#### `([^`]+)`$/.exec(lines[index] ?? "");
    if (heading === null) continue;
    const fields: Partial<Record<(typeof REGISTRY_LABELS)[keyof typeof REGISTRY_LABELS], string>> =
      {};
    index += 1;
    for (; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (/^#{1,4} /.test(line)) {
        index -= 1;
        break;
      }
      const field = /^- \*\*([^*]+):\*\* (.+)$/.exec(line);
      if (field === null) continue;
      const key = REGISTRY_LABELS[field[1] as keyof typeof REGISTRY_LABELS];
      if (key !== undefined) fields[key] = field[2];
    }

    const required = Object.values(fields);
    if (
      required.length !== Object.keys(REGISTRY_LABELS).length ||
      required.some((value) => !value)
    ) {
      throw new Error(`Qualification registry entry is incomplete: ${heading[1]}`);
    }
    const resources = parseResourceLimits(fields.expectedDurationAndResources ?? "");
    const command = heading[1];
    if (command === undefined) throw new Error("Qualification registry command is missing.");
    const [platform, artifact] = splitField(fields.platformArtifact, ", using ");
    const [isolation, filesystem] = splitField(fields.isolationFilesystem, "; ");
    const [network, credentials] = splitField(fields.networkCredentials, ". No credential");
    registry[command] = {
      command,
      owner: fields.owner ?? "",
      protectedRisk: fields.protectedRisk ?? "",
      cheaperEvidence: fields.cheaperEvidence ?? "",
      platform,
      artifact,
      isolation,
      expectedDuration: fields.expectedDurationAndResources ?? "",
      resourceLimits: resources,
      occasions: fields.occasions ?? "",
      network,
      credentials: credentials === "" ? "none stated" : `No credential${credentials}`,
      filesystem,
      productionExclusions: fields.productionExclusions ?? "",
      result: fields.resultDiagnostics ?? "",
      retention: fields.retention ?? "",
      replacementCondition: fields.replacementCondition ?? "",
    };
  }
  return registry;
}

function splitField(value: string | undefined, separator: string): [string, string] {
  const [first, ...rest] = (value ?? "").split(separator);
  return [first?.trim() ?? "", rest.length === 0 ? "" : rest.join(separator).trim()];
}

export function isCompleteQualificationEntry(entry: QualificationEntry): boolean {
  return (
    Object.entries(entry).every(([key, value]) => {
      if (key === "resourceLimits") return true;
      return typeof value === "string" && value.trim().length > 0;
    }) &&
    Object.values(entry.resourceLimits).every((value) => Number.isSafeInteger(value) && value > 0)
  );
}

export type QualificationRequest =
  | { kind: "ordinary" }
  | {
      kind: "qualification";
      mode: "run" | "validate" | "review";
      name?: string;
      parametersMatch?: boolean;
    };

export type RoutingDecision =
  | "ordinary-boundary"
  | "inspect-without-invocation"
  | "invoke-once"
  | "refuse-ambiguous"
  | "refuse-unregistered"
  | "refuse-incomplete"
  | "refuse-parameter-mismatch";

export function routeQualificationRequest(
  request: QualificationRequest,
  registry: QualificationRegistry,
): RoutingDecision {
  if (request.kind === "ordinary") return "ordinary-boundary";
  if (!request.name) return "refuse-ambiguous";

  const entry = registry[request.name];
  if (!entry) return "refuse-unregistered";
  if (!isCompleteQualificationEntry(entry)) return "refuse-incomplete";
  if (request.parametersMatch === false) return "refuse-parameter-mismatch";
  if (request.mode !== "run") return "inspect-without-invocation";
  return "invoke-once";
}

function parseResourceLimits(value: string): QualificationEntry["resourceLimits"] {
  const read = (pattern: RegExp, label: string) => {
    const match = pattern.exec(value);
    if (match === null) throw new Error(`Qualification registry resource is missing: ${label}`);
    return Number(match[1]);
  };
  return {
    timeoutMs: read(/hard outer timeout (\d+) seconds/, "timeout") * 1_000,
    processCount: read(
      /at most (\d+) (?:observed )?workload (?:processes|descendants)/,
      "process count",
    ),
    memoryBytes: read(/at most (\d+) MiB .*peak memory/, "memory") * 1024 * 1024,
    diskBytes:
      read(/at most (\d+) MiB (?:(?:OS-enforced|monitored) )?temporary (?:`tmpfs` )?disk/, "disk") *
      1024 *
      1024,
    outputBytes: read(/at most (\d+) KiB raw-byte captured diagnostics/, "output") * 1024,
    descendantCleanupMs: read(/within (\d+) second after forced termination/, "cleanup") * 1_000,
  };
}
