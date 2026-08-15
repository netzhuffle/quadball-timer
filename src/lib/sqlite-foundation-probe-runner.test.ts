import { describe, expect, test } from "bun:test";
import { runCompiledSqliteFoundationProbe } from "@/lib/sqlite-foundation-probe-runner";
import {
  DockerAdmissionError,
  type DockerProbeExecution,
} from "@/lib/sqlite-foundation-probe-docker";

function fakeExecution(overrides: Partial<DockerProbeExecution> = {}): DockerProbeExecution {
  const result = {
    exitCode: 0,
    stdout: JSON.stringify({
      artifactIdentity: {
        os: "linux",
        architecture: "x64",
        bunVersion: "1.3.14",
        bunRevision: "abcdef12",
        sqliteVersion: "3.53.0",
      },
    }),
    stderr: "",
    stdoutBytes: 160,
    stderrBytes: 0,
    outputExceeded: false,
  };
  return {
    container: {
      id: "0123456789ab",
      name: "owned",
      capability: "capability",
      artifactPath: "/owned/artifact",
      identityVerified: true,
    },
    run: async () => result,
    stop: async () => {},
    cleanup: async () => ({ identityVerified: true, removed: true }),
    ...overrides,
  };
}

describe("Docker qualification orchestration", () => {
  test("emits pending then verified cleanup evidence and preserves artifact identity", async () => {
    const emitted: Array<{
      phase: string;
      cleanup: { temporaryDataRemoved: boolean };
      platform: { arch: string };
    }> = [];
    const result = await runCompiledSqliteFoundationProbe("/owned/artifact", {
      commit: "abcdef1",
      createExecution: async () => fakeExecution(),
      emitResult: (value) => {
        emitted.push(value);
      },
    });
    expect(emitted.map((value) => value.phase)).toEqual(["pre-cleanup", "final"]);
    expect(emitted[0]?.cleanup.temporaryDataRemoved).toBe(false);
    expect(emitted[1]?.cleanup.temporaryDataRemoved).toBe(true);
    expect(emitted[1]?.platform.arch).toBe("x64");
    expect(result.qualificationResult.outcome).toBe("passed");
  });

  test("does not retry a workload and reports cleanup failure without claiming removal", async () => {
    let runs = 0;
    const emitted: Array<{ cleanup: { status: string; temporaryDataRemoved: boolean } }> = [];
    const error = await runCompiledSqliteFoundationProbe("/owned/artifact", {
      createExecution: async () =>
        fakeExecution({
          run: async () => {
            runs += 1;
            throw new Error("workload failed");
          },
          cleanup: async () => {
            throw new Error("identity changed");
          },
        }),
      emitResult: (value) => {
        emitted.push(value);
      },
    }).catch((value) => value);
    expect(runs).toBe(1);
    expect(error).toBeInstanceOf(Error);
    expect(emitted.at(-1)?.cleanup.status).toBe("failed");
    expect(emitted.at(-1)?.cleanup.temporaryDataRemoved).toBe(false);
  });

  test("never creates or starts a Docker workload when admission rejects", async () => {
    let created = false;
    const emitted: Array<{ outcome: string }> = [];
    await expect(
      runCompiledSqliteFoundationProbe("/owned/artifact", {
        createExecution: async () => {
          created = true;
          throw new DockerAdmissionError("Docker admission failed");
        },
        emitResult: (value) => {
          emitted.push(value);
        },
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(created).toBe(true);
    expect(emitted[0]?.outcome).toBe("blocked");
  });

  test("awaits late admission cleanup before final evidence", async () => {
    const events: string[] = [];
    await expect(
      runCompiledSqliteFoundationProbe("/owned/artifact", {
        timeoutMs: 80,
        createExecution: async (_path, workSignal, _cleanupSignal) =>
          new Promise((resolve) => {
            workSignal?.addEventListener(
              "abort",
              () => {
                events.push("admission-resolved");
                resolve(
                  fakeExecution({
                    stop: async () => {
                      events.push("stop");
                    },
                    cleanup: async (signal) => {
                      events.push(`cleanup:${signal?.aborted === false}`);
                      return { identityVerified: true, removed: true };
                    },
                  }),
                );
              },
              { once: true },
            );
          }),
        emitResult: (value) => {
          events.push(value.phase);
        },
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(events).toEqual(["admission-resolved", "stop", "pre-cleanup", "cleanup:true", "final"]);
  });

  test("retains verified cleanup when late admission rejects after timeout", async () => {
    const emitted: Array<{
      phase: string;
      cleanup: {
        status: string;
        temporaryDataRemoved: boolean;
        containerRemoved: boolean | null;
        failures: string[];
      };
    }> = [];
    await expect(
      runCompiledSqliteFoundationProbe("/owned/artifact", {
        timeoutMs: 80,
        createExecution: async (_path, workSignal) =>
          new Promise((_resolve, reject) => {
            workSignal?.addEventListener(
              "abort",
              () => reject(new DockerAdmissionError("late create cleaned", "removed")),
              { once: true },
            );
          }),
        emitResult: (value) => {
          emitted.push({ phase: value.phase, cleanup: value.cleanup });
        },
      }),
    ).rejects.toThrow("timed out");
    expect(emitted.at(-1)?.cleanup).toMatchObject({
      status: "verified",
      temporaryDataRemoved: true,
      containerRemoved: true,
      failures: [],
    });
  });

  test("does not claim malformed admission cleanup when ownership removal was unverified", async () => {
    const emitted: Array<{
      cleanup: { status: string; temporaryDataRemoved: boolean };
      evidence: { emission: string };
    }> = [];
    await expect(
      runCompiledSqliteFoundationProbe("/owned/artifact", {
        createExecution: async () =>
          (() => {
            throw new DockerAdmissionError("malformed create", "unverified");
          })(),
        emitResult: (value) => {
          emitted.push(value);
        },
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(emitted.at(-1)?.cleanup.status).toBe("failed");
    expect(emitted.at(-1)?.cleanup.temporaryDataRemoved).toBe(false);
    expect(emitted.at(-1)?.evidence.emission).toBe("verified");
  });

  test("keeps pre-create blockers null for container facts and truthful for temporary data", async () => {
    const emitted: Array<{
      cleanup: {
        status: string;
        containerIdentityVerified: boolean | null;
        containerRemoved: boolean | null;
        temporaryDataRemoved: boolean;
        failures: string[];
      };
    }> = [];
    await expect(
      runCompiledSqliteFoundationProbe("/owned/artifact", {
        createExecution: async () => {
          throw new DockerAdmissionError("native platform unavailable");
        },
        emitResult: (value) => {
          emitted.push({ cleanup: value.cleanup });
        },
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(emitted.at(-1)?.cleanup).toMatchObject({
      status: "verified",
      containerIdentityVerified: null,
      containerRemoved: null,
      temporaryDataRemoved: true,
      failures: [],
    });
  });

  test("bounds a stalled evidence sink by the hard deadline", async () => {
    const fallback: Array<{ cleanup: { status: string } }> = [];
    const started = Date.now();
    await expect(
      runCompiledSqliteFoundationProbe("/owned/artifact", {
        timeoutMs: 40,
        commit: "abcdef1",
        createExecution: async () => fakeExecution(),
        emitResult: () => new Promise<void>(() => {}),
        emitResultFallback: (value) => fallback.push(value),
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(500);
    expect(fallback.at(-1)?.cleanup.status).toBe("failed");
  });

  test("keeps cleanup status independent from final evidence emission", async () => {
    let calls = 0;
    let fallback: { cleanup: { status: string }; evidence: { emission: string } } | undefined;
    const error = await runCompiledSqliteFoundationProbe("/owned/artifact", {
      createExecution: async () => fakeExecution(),
      emitResult: () => {
        calls += 1;
        if (calls === 2) throw new Error("sink closed");
      },
      emitResultFallback: (value) => {
        fallback = value;
      },
    }).catch((value) => value);
    expect(error).toBeInstanceOf(Error);
    expect(fallback?.cleanup.status).toBe("verified");
    expect(fallback?.evidence.emission).toBe("failed");
  });

  test("propagates interruption through bounded cleanup", async () => {
    const interruption = new AbortController();
    const emitted: Array<{ outcome: string }> = [];
    await expect(
      runCompiledSqliteFoundationProbe("/owned/artifact", {
        commit: "abcdef1",
        signal: interruption.signal,
        createExecution: async () => {
          interruption.abort();
          return fakeExecution({ run: async () => new Promise(() => {}) });
        },
        emitResult: (value) => {
          emitted.push(value);
        },
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(emitted[0]?.outcome).toBe("interrupted");
  });
});
