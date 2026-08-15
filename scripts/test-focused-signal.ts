import { runSqliteRuntimeEntrypoint } from "@/lib/sqlite-foundation-probe-cli";

const CHILD_ARGUMENT = "--focused-signal-child";
const GRANDCHILD_ARGUMENT = "--focused-signal-grandchild";
const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const TIMEOUT_MS = 2_000;
const MAX_OUTPUT_BYTES = 1_024;

if (process.argv.includes(GRANDCHILD_ARGUMENT)) {
  process.on("SIGTERM", () => {});
  const keepAlive = setInterval(() => {}, 1_000);
  await new Promise<void>(() => {});
  clearInterval(keepAlive);
} else if (process.argv.includes(CHILD_ARGUMENT)) {
  await runSignalChild();
} else {
  await runDirectChildExitCase();
  const measurements: SignalMeasurement[] = [];
  for (const signal of SIGNALS) {
    measurements.push(await runSignalCase(signal));
  }
  const maxStartupMs = Math.max(...measurements.map((measurement) => measurement.startupMs));
  const maxSignalCleanupMs = Math.max(
    ...measurements.map((measurement) => measurement.signalCleanupMs),
  );
  console.log(
    `Focused signal integration test passed for SIGINT, SIGTERM, and SIGHUP; no retry was attempted. measurements=${JSON.stringify({ maxStartupMs, maxSignalCleanupMs })}`,
  );
}

async function runSignalChild(): Promise<void> {
  const directExit = process.argv.includes("--direct-exit");
  const grandchild = Bun.spawn(
    [process.execPath, process.argv[1] ?? import.meta.filename, GRANDCHILD_ARGUMENT],
    {
      detached: !directExit,
      env: allowlistedEnvironment(),
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  if (directExit) {
    process.stdout.write("READY\n");
    process.exit(0);
  }
  const expectedSignal = process.argv[3] as NodeJS.Signals;
  const receivedSignals: NodeJS.Signals[] = [];
  const recordSignal = () => receivedSignals.push(expectedSignal);
  process.on(expectedSignal, recordSignal);
  let aborted = false;
  const emittedPhases: string[] = [];
  try {
    await runSqliteRuntimeEntrypoint("/focused/synthetic-artifact", {
      timeoutMs: TIMEOUT_MS,
      emitResult: (result) => {
        emittedPhases.push(result.phase);
      },
      createExecution: async () => {
        process.stdout.write("READY\n");
        process.stderr.write("diagnostic\n");
        return {
          container: {
            id: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            name: "focused",
            capability: "focused",
            artifactPath: "/focused/synthetic-artifact",
            identityVerified: true,
          },
          run: async () => new Promise<never>(() => {}),
          stop: async () => {
            grandchild.kill("SIGTERM");
            const exited = await Promise.race([grandchild.exited, Bun.sleep(100).then(() => null)]);
            if (exited === null) grandchild.kill("SIGKILL");
            if (!(await waitForProcessGone(grandchild.pid, TIMEOUT_MS)))
              throw new Error("focused signal grandchild did not exit after bounded KILL");
          },
          cleanup: async () => ({
            identityVerified: true,
            removed: true,
            descendantsTerminated: true,
            descendantsReaped: true,
            temporaryDataRemoved: true,
          }),
        };
      },
    });
  } catch {
    aborted = true;
  } finally {
    process.off(expectedSignal, recordSignal);
  }
  if (!aborted) throw new Error("outer runtime entrypoint did not abort on signal");
  if (!receivedSignals.includes(expectedSignal))
    throw new Error(`focused child did not receive ${expectedSignal}`);
  if (emittedPhases.join(",") !== "pre-cleanup,final")
    throw new Error(
      `signal cleanup did not emit both bounded evidence records: ${emittedPhases.join(",")}`,
    );
  {
    process.stdout.write("ABORTED\nREAPED\n");
  }
}

async function runDirectChildExitCase(): Promise<void> {
  const child = Bun.spawn(
    [process.execPath, process.argv[1] ?? import.meta.filename, CHILD_ARGUMENT, "--direct-exit"],
    {
      detached: true,
      env: allowlistedEnvironment(),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdout = readBoundedOutput(child.stdout, true);
  const stderr = readBoundedOutput(child.stderr, false);
  try {
    if (!(await waitForReady(stdout.ready, TIMEOUT_MS))) {
      throw new Error("direct-exit signal child did not become ready");
    }
    await Promise.race([
      Promise.all([child.exited, stdout.completed, stderr.completed]),
      Bun.sleep(TIMEOUT_MS).then(() => {
        throw new Error("direct-exit signal child did not exit within its bound");
      }),
    ]);
    await assertProcessGroupExists(child.pid);
  } finally {
    await terminateOwnedProcessGroup(child.pid);
  }
}

type SignalMeasurement = {
  signal: NodeJS.Signals;
  startupMs: number;
  signalCleanupMs: number;
};

async function runSignalCase(signal: NodeJS.Signals): Promise<SignalMeasurement> {
  const startedAt = performance.now();
  const child = Bun.spawn(
    [process.execPath, process.argv[1] ?? import.meta.filename, CHILD_ARGUMENT, signal],
    {
      detached: true,
      env: allowlistedEnvironment(),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdout = readBoundedOutput(child.stdout, true);
  const stderr = readBoundedOutput(child.stderr, false);
  let failure: unknown;
  let processGroupVerifiedGone = false;
  try {
    const ready = await waitForReady(stdout.ready, TIMEOUT_MS);
    if (!ready) throw new Error(`${signal} child did not become ready`);
    const readyAt = performance.now();
    child.kill(signal);
    const [exitCode, stdoutText, stderrText] = await waitForExit(
      child,
      stdout.completed,
      stderr.completed,
      TIMEOUT_MS,
    );
    if (
      exitCode !== 0 ||
      !stdoutText.includes("READY\n") ||
      !stdoutText.includes("REAPED\n") ||
      !stdoutText.includes("ABORTED") ||
      !stderrText.includes("diagnostic\n") ||
      performance.now() - readyAt >= TIMEOUT_MS - 250
    ) {
      throw new Error(
        `${signal} child did not complete installed-signal cleanup (exitCode=${exitCode}, stdout=${JSON.stringify(stdoutText)}, stderr=${JSON.stringify(stderrText)})`,
      );
    }
    await assertProcessGroupGone(child.pid);
    processGroupVerifiedGone = true;
    return {
      signal,
      startupMs: Math.ceil(readyAt - startedAt),
      signalCleanupMs: Math.ceil(performance.now() - readyAt),
    };
  } catch (error) {
    failure = error;
  } finally {
    if (!processGroupVerifiedGone) {
      try {
        await terminateOwnedProcessGroup(child.pid);
      } catch (cleanupError) {
        failure ??= cleanupError;
      }
    }
  }
  throw failure ?? new Error(`${signal} signal case failed without an error`);
}

function allowlistedEnvironment(): Record<string, string> {
  const environment: Record<string, string> = { NODE_ENV: "test" };
  for (const key of ["PATH", "LANG", "LC_ALL", "TZ"]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

type BoundedOutput = {
  ready: Promise<boolean>;
  completed: Promise<string>;
};

function readBoundedOutput(
  stream: ReadableStream<Uint8Array<ArrayBuffer>>,
  detectsReady: boolean,
): BoundedOutput {
  let resolveReady: (ready: boolean) => void = () => {};
  let readyResolved = false;
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });
  const completed = (async () => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_OUTPUT_BYTES) throw new Error("focused signal output exceeded its bound");
        chunks.push(value);
        text += decoder.decode(value, { stream: true });
        if (detectsReady && !readyResolved && text.includes("READY\n")) {
          readyResolved = true;
          resolveReady(true);
        }
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    if (detectsReady && !readyResolved) resolveReady(false);
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(output);
  })();
  completed.catch(() => {
    if (detectsReady && !readyResolved) resolveReady(false);
  });
  return { ready, completed };
}

async function waitForReady(ready: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  return await Promise.race([ready, Bun.sleep(timeoutMs).then(() => false)]);
}

async function waitForExit(
  child: ReturnType<typeof Bun.spawn>,
  stdout: Promise<string>,
  stderr: Promise<string>,
  timeoutMs: number,
): Promise<[number, string, string]> {
  return await Promise.race([
    Promise.all([child.exited, stdout, stderr]),
    Bun.sleep(timeoutMs).then(() => {
      throw new Error("focused signal child exceeded its bounded cleanup timeout");
    }),
  ]);
}

async function assertProcessGroupGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      process.kill(-pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("focused signal process group was not reaped");
}

async function assertProcessGroupExists(pid: number): Promise<void> {
  try {
    process.kill(-pid, 0);
  } catch {
    throw new Error("direct-exit signal grandchild did not remain in the owned group");
  }
}

async function waitForProcessGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(10);
  }
  return false;
}

async function terminateOwnedProcessGroup(pid: number): Promise<void> {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return await assertProcessGroupGone(pid);
  }
  if (await waitForGroupGone(pid, 250)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group may have exited between the grace check and KILL.
  }
  if (!(await waitForGroupGone(pid, 1_000))) {
    throw new Error("focused signal process group exceeded bounded TERM/KILL cleanup");
  }
}

async function waitForGroupGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(10);
  }
  return false;
}
