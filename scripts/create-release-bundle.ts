#!/usr/bin/env bun

import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assertAllowedReleaseBundle,
  createReleaseManifest,
  RELEASE_BUNDLE_ALLOWLIST,
  serializeReleaseManifest,
  sha256,
  type ReleaseBundleMember,
} from "@/lib/release-manifest";

const repositoryRoot = process.cwd();
const outputDirectory = join(repositoryRoot, process.env.RELEASE_OUTPUT?.trim() || "release");
const sourceExecutable = join(repositoryRoot, "dist/quadball-timer");

const sourceByBundlePath: Record<string, string> = {
  "quadball-timer": sourceExecutable,
  "deploy/activate-release.sh": "deploy/activate-release.sh",
  "deploy/activate-test-release.sh": "deploy/activate-test-release.sh",
  "deploy/activation-maintenance-root.sh": "deploy/activation-maintenance-root.sh",
  "deploy/restore-production.sh": "deploy/restore-production.sh",
  "deploy/systemd/quadball-timer.service": "deploy/systemd/quadball-timer.service",
  "deploy/systemd/quadball-timer-test.service": "deploy/systemd/quadball-timer-test.service",
};

const sourceCommit = requiredEnvironment("SOURCE_COMMIT");
const workflowRunId = requiredEnvironment("WORKFLOW_RUN_ID");
const workflowAttempt = requiredEnvironment("WORKFLOW_ATTEMPT");
const schemaCompatibility = process.env.SCHEMA_COMPATIBILITY?.trim() || "foundation-v1";
const buildTime = process.env.BUILD_TIME?.trim() || new Date().toISOString();

const outputParent = dirname(outputDirectory);
await mkdir(outputParent, { recursive: true });
try {
  await stat(outputDirectory);
  throw new Error(`Refusing to overwrite existing release output: ${outputDirectory}`);
} catch (error) {
  if (isPresent(error)) throw error;
}

const stagingDirectory = await mkdtemp(join(outputParent, ".release-attempt-"));
try {
  for (const bundlePath of RELEASE_BUNDLE_ALLOWLIST) {
    const source = sourceByBundlePath[bundlePath];
    if (source === undefined) throw new Error(`No source is configured for ${bundlePath}.`);
    const sourcePath = source.startsWith("/") ? source : join(repositoryRoot, source);
    const destinationPath = join(stagingDirectory, bundlePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }

  let runtimeProcess: ReturnType<typeof Bun.spawnSync>;
  try {
    runtimeProcess = Bun.spawnSync(
      [join(stagingDirectory, "quadball-timer"), "--release-runtime-identity"],
      {
        cwd: stagingDirectory,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
  } catch (error) {
    if (process.platform === "linux") throw error;
    runtimeProcess = Bun.spawnSync(
      [process.execPath, "run", join(repositoryRoot, "src/index.ts"), "--release-runtime-identity"],
      { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" },
    );
  }
  if (runtimeProcess.exitCode !== 0) {
    throw new Error(
      `Compiled executable did not report runtime identity: ${decode(runtimeProcess.stderr ?? new Uint8Array())}`,
    );
  }
  const runtime = JSON.parse(decode(runtimeProcess.stdout ?? new Uint8Array())) as {
    bunVersion?: string;
    bunRevision?: string;
    sqliteVersion?: string;
  };

  const bundleMembers: ReleaseBundleMember[] = [];
  for (const bundlePath of RELEASE_BUNDLE_ALLOWLIST) {
    const bytes = await readFile(join(stagingDirectory, bundlePath));
    bundleMembers.push({ path: bundlePath, sha256: sha256(bytes) });
  }
  assertAllowedReleaseBundle(bundleMembers);

  const manifest = createReleaseManifest({
    sourceCommit,
    workflowRunId,
    workflowAttempt,
    runtime: {
      bunVersion: runtime.bunVersion ?? "",
      bunRevision: runtime.bunRevision ?? "",
      sqliteVersion: runtime.sqliteVersion ?? "",
    },
    buildTime,
    schemaCompatibility,
    bundleMembers,
  });
  await writeFile(
    join(stagingDirectory, "release-manifest.json"),
    serializeReleaseManifest(manifest),
    {
      mode: 0o444,
    },
  );

  await makeReadOnly(stagingDirectory);
  await rename(stagingDirectory, outputDirectory);
  console.log(JSON.stringify({ outputDirectory, releaseAttemptId: manifest.releaseAttemptId }));
} catch (error) {
  await rm(stagingDirectory, { recursive: true, force: true });
  throw error;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value).trim();
}

function isPresent(error: unknown): boolean {
  return !(error instanceof Error && "code" in error && error.code === "ENOENT");
}

async function makeReadOnly(directory: string): Promise<void> {
  const entries = await Array.fromAsync(
    new Bun.Glob("**/*").scan({ cwd: directory, onlyFiles: false }),
  );
  for (const entry of entries.sort((left, right) => right.length - left.length)) {
    const path = join(directory, entry);
    const entryStat = await stat(path);
    await chmod(
      path,
      entryStat.isDirectory()
        ? 0o555
        : entry === "quadball-timer" || entry.endsWith(".sh")
          ? 0o555
          : 0o444,
    );
  }
  await chmod(directory, 0o555);
}
