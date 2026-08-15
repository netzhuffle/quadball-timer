import {
  createReleaseManifest,
  type ReleaseBundleMember,
  type ReleaseManifest,
  type ReleaseRuntimeIdentity,
} from "./release-manifest";

export type ReleaseEnvironment = "production" | "test";

export type ReleaseEnvironmentAdapter = {
  environment: ReleaseEnvironment;
  acquireLock(): Promise<() => Promise<void> | void>;
  verifyConfiguration(manifest: ReleaseManifest): Promise<void>;
  stage(manifest: ReleaseManifest): Promise<void>;
  finalize(manifest: ReleaseManifest): Promise<void>;
  activate(manifest: ReleaseManifest): Promise<void>;
  verify(manifest: ReleaseManifest): Promise<void>;
  currentRelease(): Promise<{ releaseAttemptId: string; schemaCompatibility: string } | null>;
  rollback(releaseAttemptId: string): Promise<void>;
  prune(protectedReleaseAttemptIds: readonly string[]): Promise<void>;
  preserveFailure?(manifest: ReleaseManifest, error: unknown): Promise<void>;
};

export type ReleaseAttemptInput = {
  sourceCommit: string;
  workflowRunId: string;
  workflowAttempt: string;
  runtime: ReleaseRuntimeIdentity;
  buildTime: string;
  schemaCompatibility: string;
  bundleMembers: readonly ReleaseBundleMember[];
};

export type ReleaseEnvironmentOutcome = {
  environment: ReleaseEnvironment;
  status: "succeeded" | "failed";
  phases: string[];
  errorCode: string | null;
  rollbackReleaseAttemptId: string | null;
};

export type ReleaseDeploymentReport = {
  releaseAttemptId: string;
  status: "succeeded" | "failed";
  environments: Record<ReleaseEnvironment, ReleaseEnvironmentOutcome>;
};

export async function runReleaseAttempt(input: {
  manifest: ReleaseManifest;
  environments: readonly ReleaseEnvironmentAdapter[];
}): Promise<ReleaseDeploymentReport> {
  const environmentNames = new Set(
    input.environments.map((environment) => environment.environment),
  );
  if (!environmentNames.has("production") || !environmentNames.has("test")) {
    throw new Error("Both Production and Test release adapters are required.");
  }
  if (input.environments.length !== 2) {
    throw new Error("Each release environment must have exactly one adapter.");
  }

  const outcomes = await Promise.all(
    input.environments.map((environment) => runEnvironmentAttempt(environment, input.manifest)),
  );
  const byEnvironment = Object.fromEntries(
    outcomes.map((outcome) => [outcome.environment, outcome]),
  ) as Record<ReleaseEnvironment, ReleaseEnvironmentOutcome>;
  return {
    releaseAttemptId: input.manifest.releaseAttemptId,
    status: outcomes.every((outcome) => outcome.status === "succeeded") ? "succeeded" : "failed",
    environments: byEnvironment,
  };
}

export function makeReleaseManifest(input: ReleaseAttemptInput): ReleaseManifest {
  return createReleaseManifest(input);
}

async function runEnvironmentAttempt(
  environment: ReleaseEnvironmentAdapter,
  manifest: ReleaseManifest,
): Promise<ReleaseEnvironmentOutcome> {
  const phases: string[] = [];
  let releaseLock: (() => Promise<void> | void) | undefined;
  let previousRelease: { releaseAttemptId: string; schemaCompatibility: string } | null = null;
  try {
    releaseLock = await environment.acquireLock();
    phases.push("lock-acquired");
    await environment.verifyConfiguration(manifest);
    phases.push("configuration-verified");
    previousRelease = await environment.currentRelease();
    await environment.stage(manifest);
    phases.push("staged");
    await environment.finalize(manifest);
    phases.push("finalized");
    await environment.activate(manifest);
    phases.push("activated");
    await environment.verify(manifest);
    phases.push("verified");
    await environment.prune(
      [manifest.releaseAttemptId, previousRelease?.releaseAttemptId].filter(
        (value): value is string => value !== undefined,
      ),
    );
    phases.push("pruned");
    return {
      environment: environment.environment,
      status: "succeeded",
      phases,
      errorCode: null,
      rollbackReleaseAttemptId: null,
    };
  } catch (error) {
    const errorCode = boundedErrorCode(error);
    if (environment.preserveFailure !== undefined) {
      await environment.preserveFailure(manifest, error).catch(() => undefined);
      phases.push("failure-preserved");
    }
    let rollbackReleaseAttemptId: string | null = null;
    if (
      previousRelease !== null &&
      previousRelease.schemaCompatibility === manifest.schemaCompatibility
    ) {
      await environment.rollback(previousRelease.releaseAttemptId).then(
        () => {
          rollbackReleaseAttemptId = previousRelease?.releaseAttemptId ?? null;
          phases.push("rolled-back");
        },
        () => phases.push("rollback-failed"),
      );
    } else {
      phases.push("rollback-ineligible");
    }
    return {
      environment: environment.environment,
      status: "failed",
      phases,
      errorCode,
      rollbackReleaseAttemptId,
    };
  } finally {
    if (releaseLock !== undefined) {
      await Promise.resolve(releaseLock()).catch(() => undefined);
    }
  }
}

function boundedErrorCode(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) return error.name.slice(0, 64);
  return "release-operation-failed";
}
