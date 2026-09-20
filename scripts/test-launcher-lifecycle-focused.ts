/** Disposable OS process-boundary check; intentionally outside Fast Tests. */
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform !== "darwin" && process.platform !== "linux") {
  throw new Error("Launcher lifecycle verification requires macOS or Linux (POSIX signals).");
}
const directory = mkdtempSync(join(tmpdir(), "quadball-launchers-"));
const owned = new Set<number>();
const children: Bun.Subprocess[] = [];
const records: string[] = [];
const sleep = (ms: number) => Bun.sleep(ms);
const watchdog = setTimeout(() => {
  cleanup();
  rmSync(directory, { recursive: true, force: true });
  console.error("Launcher lifecycle exceeded its 25-second deadline.");
  process.exit(1);
}, 25_000);
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
async function until(check: () => boolean, description: string) {
  const deadline = performance.now() + 3_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${description}`);
    await sleep(20);
  }
}
function cleanup() {
  for (const record of records) {
    for (const line of read(record).trim().split("\n")) {
      const pid = Number(line.split(":")[1]);
      if (Number.isSafeInteger(pid) && pid > 0) owned.add(pid);
    }
  }
  for (const pid of owned) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") console.error(error);
    }
  }
}
function launch(args: string[]) {
  const child = Bun.spawn([process.execPath, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  owned.add(child.pid);
  children.push(child);
  return child;
}
function read(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
try {
  // Sibling canary must survive every tree teardown; never signal process groups.
  const unrelated = launch(["-e", "setTimeout(() => {}, 20000)"]);
  const fixture = join(directory, "fixture.ts");
  writeFileSync(
    fixture,
    `
import { appendFileSync, existsSync } from "node:fs";
const [mode, record, stop] = process.argv.slice(2);
const note = (text) => appendFileSync(record, text + "\\n");
note(mode + ":" + process.pid);
setTimeout(() => process.exit(99), 15000);
if (mode === "supervisor") {
  Bun.spawn([process.execPath, "--no-orphans", import.meta.path, "launcher", record, stop], { stdout: "inherit", stderr: "inherit" });
} else if (mode === "launcher") {
  Bun.spawn([process.execPath, import.meta.path, "child", record, stop], { stdout: "inherit", stderr: "inherit" });
  const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 15000)"], { stdout: "inherit", stderr: "inherit" });
  note("graceful-child:" + child.pid);
  // Explicit cleanup still runs before Bun's descendant safety net.
  const finish = async (code) => {
    child.kill("SIGTERM");
    await child.exited;
    console.log("explicit cleanup");
    console.error("retained diagnostic");
    process.exit(code);
  };
  process.on("SIGINT", () => void finish(130));
  process.on("SIGTERM", () => void finish(143));
  setInterval(() => { if (existsSync(stop)) void finish(23); }, 20);
} else {
  const grandchild = Bun.spawn(["sleep", "15"], { stdout: "ignore", stderr: "ignore" });
  note("grandchild:" + grandchild.pid);
  // Keep the grandchild parented until Bun's recursive fallback kills this tree.
  process.on("SIGTERM", () => { console.log("child cleanup"); });
}
`,
  );
  for (const scenario of ["normal", "SIGINT", "SIGTERM", "parent-loss"] as const) {
    const record = join(directory, `${scenario}.pids`);
    const stop = join(directory, `${scenario}.stop`);
    records.push(record);
    const parent = scenario === "parent-loss";
    const child = launch(
      parent
        ? [fixture, "supervisor", record, stop]
        : ["--no-orphans", fixture, "launcher", record, stop],
    );
    const output = new Response(child.stdout).text();
    const diagnostic = new Response(child.stderr).text();
    await until(() => read(record).includes("grandchild:"), `${scenario} ready`);
    const pids = read(record)
      .trim()
      .split("\n")
      .map((line) => Number(line.split(":")[1]));
    for (const pid of pids) owned.add(pid);
    if (scenario === "normal") writeFileSync(stop, "stop");
    else child.kill(parent ? "SIGKILL" : scenario);
    await until(
      () => child.exitCode !== null || child.signalCode !== null,
      `${scenario} launcher exit`,
    );
    const code = await child.exited;
    await until(() => pids.every((pid) => !alive(pid)), `${scenario} descendants removed`);
    const stdout = await output;
    const stderr = await diagnostic;
    if (!parent) {
      assert.equal(code, scenario === "normal" ? 23 : scenario === "SIGINT" ? 130 : 143);
      assert.match(stdout, /explicit cleanup/);
      assert.match(stderr, /retained diagnostic/);
    }
    assert(alive(unrelated.pid), "unrelated sibling was terminated");
    for (const pid of pids) owned.delete(pid);
    owned.delete(child.pid);
    records.splice(records.indexOf(record), 1);
    console.log(JSON.stringify({ scenario, code, descendantsRemoved: true, unrelatedAlive: true }));
  }
  const hot = join(directory, "hot.ts");
  const reloads = join(directory, "reloads");
  const hotSource = `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(reloads)}, process.pid + "\\n"); setInterval(() => {}, 1000);`;
  writeFileSync(hot, hotSource);
  const dev = launch(["--no-orphans", "--hot", hot]);
  await until(() => read(reloads).trim().length > 0, "hot initial load");
  appendFileSync(hot, "\n// reload\n");
  await until(() => read(reloads).trim().split("\n").length >= 2, "hot reload");
  assert(
    read(reloads)
      .trim()
      .split("\n")
      .every((pid) => Number(pid) === dev.pid),
  );
  dev.kill("SIGTERM");
  await dev.exited;
  owned.delete(dev.pid);
  assert(alive(unrelated.pid));
  console.log(JSON.stringify({ scenario: "hot-reload", samePid: true, unrelatedAlive: true }));
} finally {
  cleanup();
  await Promise.all(children.map((child) => child.exited));
  await until(() => [...owned].every((pid) => !alive(pid)), "final fixture cleanup");
  clearTimeout(watchdog);
  rmSync(directory, { recursive: true, force: true });
}
