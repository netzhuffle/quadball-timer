import { mkdir, copyFile } from "node:fs/promises";
import { cpus, platform, arch, totalmem } from "node:os";
import { resolve } from "node:path";

// Ordinary Fast Tests only. Invoke from the repository root. Each matrix cell
// gets a fresh output table, so measurements cannot leak between schedules.
const output = resolve(process.argv[2] ?? ".cache/test-runner-measurements");
await mkdir(output, { recursive: true });
const metadata = {
  bun: Bun.version, revision: Bun.revision, platform: platform(), arch: arch(),
  cpus: cpus().map(cpu => cpu.model), totalMemoryBytes: totalmem(),
  sourceCommit: Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim(),
  runner: process.env.RUNNER_NAME ?? "native", image: process.env.ImageOS ?? null,
};
await Bun.write(`${output}/environment.json`, JSON.stringify(metadata, null, 2));
const results: unknown[] = [];
async function run(name: string, workers: number, scheduled: boolean) {
  const timings = `${output}/${name}.timings.json`;
  if (scheduled) await copyFile(`${output}/seed.timings.json`, timings);
  const command = [process.execPath, "test", "--timeout=10000", "--isolate",
    ...(workers === 1 ? [] : [`--parallel=${workers}`]),
    `--timings=${timings}`, "--update-timings"];
  const started = performance.now();
  const child = Bun.spawn(["/usr/bin/time", platform() === "darwin" ? "-l" : "-v", ...command], {
    stdout: Bun.file(`${output}/${name}.stdout.log`),
    stderr: Bun.file(`${output}/${name}.stderr.log`),
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  const exitCode = await child.exited;
  const result = { name, workers, scheduled, elapsedMs: performance.now() - started, exitCode,
    resourceUsage: child.resourceUsage(), command };
  results.push(result);
  await Bun.write(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(result));
  return exitCode;
}
if (await run("seed", 1, false)) process.exit(1);
// Rotate and reverse order to avoid attributing warmup or machine drift to one mode.
const modes = [[1, false], [2, false], [4, false], [1, true], [2, true], [4, true]] as const;
let failures = 0;
for (let round = 0; round < 3; round++) {
  const order = [...modes.slice(round * 2), ...modes.slice(0, round * 2)];
  if (round === 1) order.reverse();
  for (const [workers, scheduled] of order) {
    failures += await run(`r${round + 1}-w${workers}-${scheduled ? "timings" : "discovery"}`, workers, scheduled);
  }
}
process.exit(failures ? 1 : 0);
