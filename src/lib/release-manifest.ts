import { createHash } from "node:crypto";

export const RELEASE_MANIFEST_SCHEMA_VERSION = 1 as const;
export const RELEASE_EXECUTABLE_PATH = "quadball-timer" as const;

export const RELEASE_BUNDLE_ALLOWLIST = [
  RELEASE_EXECUTABLE_PATH,
  "deploy/activate-release.sh",
  "deploy/activate-test-release.sh",
  "deploy/systemd/quadball-timer.service",
  "deploy/systemd/quadball-timer-test.service",
] as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9._-]+$/u;

export type ReleaseRuntimeIdentity = {
  bunVersion: string;
  bunRevision: string;
  sqliteVersion: string;
};

export type ReleaseBundleMember = {
  path: string;
  sha256: string;
};

export type ReleaseManifest = {
  schemaVersion: typeof RELEASE_MANIFEST_SCHEMA_VERSION;
  sourceCommit: string;
  workflowRunId: string;
  workflowAttempt: string;
  releaseAttemptId: string;
  executablePath: typeof RELEASE_EXECUTABLE_PATH;
  executableSha256: string;
  bundleMembers: ReleaseBundleMember[];
  bunVersion: string;
  bunRevision: string;
  sqliteVersion: string;
  buildTime: string;
  schemaCompatibility: string;
};

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createReleaseAttemptId(input: {
  sourceCommit: string;
  workflowRunId: string;
  workflowAttempt: string;
}): string {
  for (const [name, value] of Object.entries({
    sourceCommit: input.sourceCommit,
    workflowRunId: input.workflowRunId,
    workflowAttempt: input.workflowAttempt,
  })) {
    if (!value || !ID_PATTERN.test(value)) {
      throw new Error(`Invalid release identity component: ${name}.`);
    }
  }

  return `sha-${input.sourceCommit}-run-${input.workflowRunId}-attempt-${input.workflowAttempt}`;
}

export function assertAllowedReleaseBundle(members: readonly ReleaseBundleMember[]): void {
  const expected = new Set<string>(RELEASE_BUNDLE_ALLOWLIST);
  const seen = new Set<string>();
  for (const member of members) {
    if (!expected.has(member.path)) {
      throw new Error(`Unexpected release bundle member: ${member.path}.`);
    }
    if (seen.has(member.path)) {
      throw new Error(`Duplicate release bundle member: ${member.path}.`);
    }
    if (!SHA256_PATTERN.test(member.sha256)) {
      throw new Error(`Invalid release bundle digest for ${member.path}.`);
    }
    seen.add(member.path);
  }

  if (seen.size !== expected.size) {
    const missing = [...expected].filter((path) => !seen.has(path));
    throw new Error(`Release bundle is missing required members: ${missing.join(", ")}.`);
  }
}

export function createReleaseManifest(input: {
  sourceCommit: string;
  workflowRunId: string;
  workflowAttempt: string;
  runtime: ReleaseRuntimeIdentity;
  buildTime: string;
  schemaCompatibility: string;
  bundleMembers: readonly ReleaseBundleMember[];
}): ReleaseManifest {
  assertAllowedReleaseBundle(input.bundleMembers);
  const executable = input.bundleMembers.find((member) => member.path === RELEASE_EXECUTABLE_PATH);
  if (executable === undefined) {
    throw new Error("Release bundle executable is missing.");
  }

  const manifest: ReleaseManifest = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    sourceCommit: requireIdentity(input.sourceCommit, "sourceCommit"),
    workflowRunId: requireIdentity(input.workflowRunId, "workflowRunId"),
    workflowAttempt: requireIdentity(input.workflowAttempt, "workflowAttempt"),
    releaseAttemptId: createReleaseAttemptId(input),
    executablePath: RELEASE_EXECUTABLE_PATH,
    executableSha256: executable.sha256,
    bundleMembers: [...input.bundleMembers].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    bunVersion: requireText(input.runtime.bunVersion, "bunVersion"),
    bunRevision: requireText(input.runtime.bunRevision, "bunRevision"),
    sqliteVersion: requireText(input.runtime.sqliteVersion, "sqliteVersion"),
    buildTime: requireText(input.buildTime, "buildTime"),
    schemaCompatibility: requireText(input.schemaCompatibility, "schemaCompatibility"),
  };

  return manifest;
}

export function serializeReleaseManifest(manifest: ReleaseManifest): string {
  validateReleaseManifest(manifest);
  return `${JSON.stringify(manifest)}\n`;
}

export function parseReleaseManifest(serialized: string): ReleaseManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("Release manifest is not valid JSON.");
  }
  validateReleaseManifest(parsed);
  return parsed;
}

export function validateReleaseManifest(value: unknown): asserts value is ReleaseManifest {
  if (typeof value !== "object" || value === null) {
    throw new Error("Release manifest must be an object.");
  }
  const manifest = value as Partial<ReleaseManifest>;
  if (manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    throw new Error("Release manifest schema version is unsupported.");
  }
  requireIdentity(manifest.sourceCommit, "sourceCommit");
  requireIdentity(manifest.workflowRunId, "workflowRunId");
  requireIdentity(manifest.workflowAttempt, "workflowAttempt");
  const expectedId = createReleaseAttemptId({
    sourceCommit: manifest.sourceCommit ?? "",
    workflowRunId: manifest.workflowRunId ?? "",
    workflowAttempt: manifest.workflowAttempt ?? "",
  });
  if (manifest.releaseAttemptId !== expectedId) {
    throw new Error("Release manifest attempt identity is inconsistent.");
  }
  if (manifest.executablePath !== RELEASE_EXECUTABLE_PATH) {
    throw new Error("Release manifest executable path is unsupported.");
  }
  if (
    typeof manifest.executableSha256 !== "string" ||
    !SHA256_PATTERN.test(manifest.executableSha256)
  ) {
    throw new Error("Release manifest executable digest is invalid.");
  }
  if (!Array.isArray(manifest.bundleMembers)) {
    throw new Error("Release manifest bundle members are invalid.");
  }
  assertAllowedReleaseBundle(manifest.bundleMembers);
  const executable = manifest.bundleMembers.find(
    (member) => member.path === RELEASE_EXECUTABLE_PATH,
  );
  if (executable?.sha256 !== manifest.executableSha256) {
    throw new Error("Release manifest executable digest does not match its member digest.");
  }
  requireText(manifest.bunVersion, "bunVersion");
  requireText(manifest.bunRevision, "bunRevision");
  requireText(manifest.sqliteVersion, "sqliteVersion");
  requireText(manifest.buildTime, "buildTime");
  requireText(manifest.schemaCompatibility, "schemaCompatibility");
}

export function verifyReleaseBundle(
  manifest: ReleaseManifest,
  actualMembers: readonly ReleaseBundleMember[],
): void {
  validateReleaseManifest(manifest);
  assertAllowedReleaseBundle(actualMembers);
  const expected = new Map(manifest.bundleMembers.map((member) => [member.path, member.sha256]));
  for (const member of actualMembers) {
    if (expected.get(member.path) !== member.sha256) {
      throw new Error(`Release bundle digest mismatch for ${member.path}.`);
    }
  }
}

function requireIdentity(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || !ID_PATTERN.test(value)) {
    throw new Error(`Invalid release manifest identity: ${name}.`);
  }
  return value;
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Release manifest field ${name} is required.`);
  }
  return value;
}
