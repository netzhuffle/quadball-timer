import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGrantAdmissionWorkerCommand,
  createGrantAdmissionWorkerEnvironment,
  readPrivateGrantCredential,
  superviseGrantAdmissionWorkers,
  writePrivateGrantCredential,
  type GrantAdmissionWorkerDependencies,
} from "@/lib/grant-concurrency-process";
import type { ProbeWorkerHandle, ProbeWorkerResult } from "@/lib/sqlite-foundation-probe-process";

describe("Grant admission concurrency process safety", () => {
  test("uses an allowlisted environment and keeps the credential out of argv", () => {
    const environment = createGrantAdmissionWorkerEnvironment("/private/owned-grant-temp");
    expect(environment).toEqual({
      LANG: "C",
      NO_COLOR: "1",
      TMPDIR: "/private/owned-grant-temp",
      TZ: "UTC",
    });
    expect(JSON.stringify(environment)).not.toContain("HOST_CI_TOKEN");

    const command = buildGrantAdmissionWorkerCommand({
      executablePath: "/absolute/bun",
      workerPath: "/absolute/worker.ts",
      databasePath: "/private/owned-grant-temp/foundation.sqlite",
      readyPath: "/private/owned-grant-temp/worker.ready",
      startPath: "/private/owned-grant-temp/workers.start",
      credentialPath: "/private/owned-grant-temp/credential.private",
      seed: 10,
    });
    expect(command).toContain("--no-env-file");
    expect(command).not.toContain("qr-secret-must-not-be-an-argument");
  });

  test("writes and validates a bounded owner-only credential channel", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-grant-private-channel-"));
    const credentialPath = join(directory, "credential.private");
    try {
      await writePrivateGrantCredential(credentialPath, "qr-secret");
      expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
      expect(await readPrivateGrantCredential(credentialPath)).toBe("qr-secret");
      await chmod(credentialPath, 0o644);
      expect(await captureFailure(readPrivateGrantCredential(credentialPath))).toEqual(
        expect.objectContaining({ message: "Grant credential channel permissions are unsafe." }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reserves one deadline for TERM, KILL, reap, and artifact cleanup", async () => {
    const observed: { timeoutMs?: number; aborted?: boolean; cleaned?: boolean } = {};
    let nowMs = 0;
    const dependencies: GrantAdmissionWorkerDependencies = {
      nowMs: () => nowMs,
      sleep: async (milliseconds) => {
        nowMs += milliseconds;
      },
      fileExists: async () => false,
      writeStart: async () => undefined,
      cleanupArtifacts: async () => {
        observed.cleaned = true;
      },
      superviseWorkers: async (_workers, options) => {
        observed.timeoutMs = options.timeoutMs;
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              observed.aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return [];
      },
    };

    expect(
      await captureFailure(
        superviseGrantAdmissionWorkers({
          workers: [fakeWorker()],
          readyPaths: ["worker.ready"],
          startPath: "workers.start",
          overallTimeoutMs: 1_000,
          terminationGraceMs: 100,
          reapTimeoutMs: 200,
          artifactCleanupMs: 100,
          dependencies,
        }),
      ),
    ).toEqual(expect.objectContaining({ message: expect.stringContaining("did not reach") }));
    expect(observed).toEqual({ timeoutMs: 400, aborted: true, cleaned: true });
  });

  test("propagates interruption through the same cleanup path", async () => {
    const controller = new AbortController();
    controller.abort();
    let cleaned = false;
    const dependencies: GrantAdmissionWorkerDependencies = {
      nowMs: () => 0,
      sleep: async () => undefined,
      fileExists: async () => false,
      writeStart: async () => undefined,
      cleanupArtifacts: async () => {
        cleaned = true;
      },
      superviseWorkers: async () => {
        throw new Error("interrupted");
      },
    };
    expect(
      await captureFailure(
        superviseGrantAdmissionWorkers({
          workers: [fakeWorker()],
          readyPaths: ["worker.ready"],
          startPath: "workers.start",
          signal: controller.signal,
          dependencies,
        }),
      ),
    ).toBeInstanceOf(Error);
    expect(cleaned).toBe(true);
  });
});

function fakeWorker(): ProbeWorkerHandle {
  const result: ProbeWorkerResult = {
    exitCode: 0,
    stdout: "{}",
    stderr: "",
    outputExceeded: false,
  };
  return {
    process: {
      pid: 123,
      exitCode: 0,
      killed: false,
      exited: Promise.resolve(0),
      kill() {},
    },
    result: Promise.resolve(result),
  };
}

async function captureFailure(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
    return null;
  } catch (error) {
    return error;
  }
}
