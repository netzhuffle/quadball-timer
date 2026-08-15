import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  lstat,
  readdir,
  access,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repositoryRoot = process.cwd();
const roots: string[] = [];
const releaseId = "sha-fast-run-matrix-attempt-1";
const previousReleaseId = "sha-prior-run-matrix-attempt-1";
const testActivationReleaseId = "sha-fast-run-test-activation-attempt-1";
const secretSentinel = "FAST_SECRET_MUST_NOT_LEAK";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      Bun.spawnSync({ cmd: ["chmod", "-R", "u+w", root] });
      await rm(root, { force: true, recursive: true });
    }),
  );
});

function digest(contents: string): string {
  return new Bun.CryptoHasher("sha256").update(contents).digest("hex");
}

async function executable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createRelease(base: string): Promise<string> {
  const release = join(base, "releases", releaseId);
  const members = [
    "deploy/activate-release.sh",
    "deploy/activate-test-release.sh",
    "deploy/activation-maintenance-root.sh",
    "deploy/systemd/quadball-timer.service",
    "deploy/systemd/quadball-timer-test.service",
    "quadball-timer",
  ];
  const records: Array<{ path: string; sha256: string }> = [];
  for (const member of members) {
    const contents = `fast fixture ${member}\n`;
    const path = join(release, member);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, contents);
    records.push({ path: member, sha256: digest(contents) });
  }
  await chmod(join(release, "quadball-timer"), 0o555);
  await writeFile(
    join(release, "release-manifest.json"),
    JSON.stringify({
      releaseAttemptId: releaseId,
      executableSha256: records.find((record) => record.path === "quadball-timer")?.sha256,
      schemaCompatibility: "26",
      supportedFoundationSchemaVersions: ["26"],
      members: records,
    }),
  );
  return release;
}

async function createHarness(): Promise<{
  base: string;
  bin: string;
  database: string;
  log: string;
  pointer: string;
  probe: string;
  root: string;
  state: string;
  testCanary: string;
  wrapper: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "quadball-activation-fast-")));
  roots.push(root);
  const base = join(root, "srv", "quadball-timer");
  const bin = join(root, "bin");
  const state = join(root, "state");
  const previous = join(base, "releases", previousReleaseId);
  const database = join(state, "foundation.sqlite");
  const log = join(state, "operations.log");
  const pointer = join(state, "retained-pointer");
  const probe = join(state, "probe-results");
  const testCanary = join(root, "srv", "quadball-timer-test", "canary");
  await Promise.all([
    mkdir(bin, { recursive: true }),
    mkdir(previous, { recursive: true }),
    mkdir(join(testCanary, ".."), { recursive: true }),
    mkdir(state, { recursive: true }),
  ]);
  await createRelease(base);
  const previousExecutable = "prior executable\n";
  await writeFile(join(previous, "quadball-timer"), previousExecutable);
  await chmod(join(previous, "quadball-timer"), 0o555);
  await writeFile(
    join(previous, "release-manifest.json"),
    JSON.stringify({
      releaseAttemptId: previousReleaseId,
      executableSha256: digest(previousExecutable),
      schemaCompatibility: "26",
      supportedFoundationSchemaVersions: ["26"],
    }),
  );
  await symlink(previous, join(base, "current"));
  await writeFile(database, "schema-before\n");
  await writeFile(pointer, "retained-before\n");
  await writeFile(log, "");
  await writeFile(probe, "");
  await writeFile(testCanary, "test-untouched\n");

  await executable(
    join(bin, "systemctl"),
    `#!/usr/bin/env bash
set -euo pipefail
echo "systemctl $*" >> "$QBT_FAST_LOG"
if [[ "$1" == show ]]; then
  property=""
  for argument in "$@"; do [[ "$argument" == --property=* ]] && property="\${argument#--property=}"; done
  case "$property" in
    Environment) echo "QUADBALL_ENVIRONMENT=production FOUNDATION_DATABASE=/var/lib/quadball-timer/foundation.sqlite TECHNICAL_ADMIN_DATABASE=/var/lib/quadball-timer/technical-admin.sqlite GRANT_KEY_RING_FILE=/etc/quadball-timer/production-grant-key-ring.json" ;;
    ExecStart) echo "$QBT_FAST_BASE/current/quadball-timer" ;;
    StateDirectory) echo "quadball-timer" ;;
    StateDirectoryMode) echo "0750" ;;
    ActiveState) echo "active" ;;
    SubState) echo "running" ;;
    Result) echo "success" ;;
    ExecMainStatus) echo "0" ;;
  esac
fi
`,
  );
  await executable(join(bin, "sudo"), '#!/usr/bin/env bash\nexec "$@"\n');
  await executable(join(bin, "flock"), "#!/usr/bin/env bash\nexit 0\n");
  await executable(
    join(bin, "df"),
    "#!/usr/bin/env bash\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nfast 999999 1 999998 1%% /fast\\n'\n",
  );
  await executable(
    join(bin, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
url="\${!#}"
case "$url" in
  */internal/release)
    manifest="$QBT_FAST_BASE/releases/\${QBT_FAST_RELEASE}/release-manifest.json"
    digest="$(sed -n 's/.*"executableSha256":"\\([0-9a-f]\\{64\\}\\)".*/\\1/p' "$manifest")"
    printf '{"releaseAttemptId":"%s","executableSha256":"%s","runningExecutableSha256":"%s","schemaCompatibility":"26"}\\n' "$QBT_FAST_RELEASE" "$digest" "$digest"
    ;;
  */ws) printf 'HTTP/1.1 101 Switching Protocols\\r\\n\\r\\n' ;;
  */api/audience/events|*/internal/healthz) printf '{}\\n' ;;
  */) printf '<!doctype html>\\n' ;;
esac
`,
  );
  const wrapper = join(bin, "maintenance");
  await executable(
    wrapper,
    `#!/usr/bin/env bash
set -euo pipefail
echo "maintenance $1 $3" >> "$QBT_FAST_LOG"
operation="$3"
case "$operation" in
  preflight) printf '{"schemaVersion":26}\\n' ;;
  backup)
    candidate="$QBT_FAST_STATE/backup-candidate"
    mkdir -p "$candidate"
    printf 'snapshot\\n' > "$candidate/foundation.sqlite"
    printf 'manifest\\n' > "$candidate/manifest.json"
    printf '{"manifestPath":"%s"}\\n' "$candidate/manifest.json"
    ;;
  verify-backup) test -f "$4" ;;
  promote)
    test -f "$4"
    printf 'retained-after\\n' > "$QBT_FAST_POINTER.next"
    mv "$QBT_FAST_POINTER.next" "$QBT_FAST_POINTER"
    ;;
  validate-migration) : ;;
  apply-migrations) printf 'schema-after\\n' > "$QBT_FAST_DATABASE" ;;
  *) exit 64 ;;
esac
`,
  );
  return { base, bin, database, log, pointer, probe, root, state, testCanary, wrapper };
}

describe("Production activation Fast phase matrix", () => {
  test("injects every shipped orchestration phase without false or cross-Environment success", async () => {
    const cases = [
      ["preflight", "migration", false, false],
      ["quiesce-stop", "backup", false, false],
      ["backup-create", "backup", false, false],
      ["backup-verify", "backup", false, false],
      ["backup-promote", "backup", false, false],
      ["candidate-validation", "migration", true, false],
      ["live-migration", "migration", true, false],
      ["release-switch", "activation", true, true],
      ["readiness", "activation", true, true],
      ["rollback-restart", "activation", true, true],
      ["final-report", "activation", true, true],
    ] as const;

    const harness = await createHarness();
    const linkedState = join(harness.root, "state-link");
    await symlink(harness.state, linkedState);
    const command = [
      "bash",
      join(repositoryRoot, "deploy/activate-release.sh"),
      "--base-dir",
      harness.base,
      "--release",
      releaseId,
      "--service",
      "quadball-timer",
      "--port",
      "3099",
    ];
    const environment = {
      ...process.env,
      PATH: `${harness.bin}:${process.env.PATH ?? ""}`,
      QBT_FAST_BASE: harness.base,
      QBT_FAST_DATABASE: harness.database,
      QBT_FAST_LOG: harness.log,
      QBT_FAST_POINTER: harness.pointer,
      QBT_FAST_PREVIOUS: join(harness.base, "releases", previousReleaseId),
      QBT_FAST_RELEASE: releaseId,
      QBT_FAST_STATE: harness.state,
      QBT_FOCUSED_TEST_BATCH: "1",
      QBT_FOCUSED_TEST_BATCH_OUTPUT: join(harness.root, "results"),
      QBT_FOCUSED_TEST_MAINTENANCE_WRAPPER: harness.wrapper,
      QBT_FOCUSED_TEST_MODE: "1",
      QBT_FOCUSED_TEST_PHASES: cases.map(([phase]) => phase).join(","),
      QBT_FOCUSED_TEST_RELEASE_VERIFIED: "1",
      QBT_FOCUSED_TEST_ROOT: harness.root,
      QBT_SECRET_SENTINEL: secretSentinel,
    };
    const batchOnlyRoot = await realpath(
      await mkdtemp(join(tmpdir(), "quadball-activation-batch-only-")),
    );
    roots.push(batchOnlyRoot);
    const batchOnlySentinels = join(batchOnlyRoot, "sentinels");
    const batchOnlyState = join(batchOnlySentinels, "state");
    const batchOnlyPrevious = join(batchOnlySentinels, "previous");
    const batchOnlyOutput = join(batchOnlySentinels, "output");
    const batchOnlyDatabase = join(batchOnlyState, "foundation.sqlite");
    const batchOnlyPointer = join(batchOnlyState, "retained-pointer");
    const batchOnlyLog = join(batchOnlyState, "operations.log");
    await mkdir(join(batchOnlyState, "backup-candidate"), { recursive: true });
    await mkdir(batchOnlyPrevious, { recursive: true });
    await mkdir(batchOnlyOutput, { recursive: true });
    await writeFile(join(batchOnlyState, "marker"), "state-marker\n");
    await writeFile(join(batchOnlyState, "backup-candidate", "marker"), "candidate-marker\n");
    await writeFile(batchOnlyDatabase, "database-marker\n");
    await writeFile(batchOnlyPointer, "pointer-marker\n");
    await writeFile(batchOnlyLog, "log-marker\n");
    await writeFile(join(batchOnlyPrevious, "marker"), "previous-marker\n");
    await writeFile(join(batchOnlyOutput, "marker"), "output-marker\n");
    const batchOnlyEnvironment = Object.fromEntries(
      Object.entries(environment).filter(
        ([key]) =>
          ![
            "QBT_FOCUSED_TEST_MAINTENANCE_WRAPPER",
            "QBT_FOCUSED_TEST_MODE",
            "QBT_FOCUSED_TEST_ROOT",
          ].includes(key),
      ),
    );
    const batchOnly = Bun.spawnSync({
      cmd: [
        "bash",
        join(repositoryRoot, "deploy/activate-release.sh"),
        "--base-dir",
        join(batchOnlyRoot, "base"),
        "--release",
        releaseId,
      ],
      env: {
        ...batchOnlyEnvironment,
        QBT_FAST_BASE: join(batchOnlyRoot, "base"),
        QBT_FAST_DATABASE: batchOnlyDatabase,
        QBT_FAST_LOG: batchOnlyLog,
        QBT_FAST_POINTER: batchOnlyPointer,
        QBT_FAST_PREVIOUS: batchOnlyPrevious,
        QBT_FAST_STATE: batchOnlyState,
        QBT_FOCUSED_TEST_BATCH: "1",
        QBT_FOCUSED_TEST_BATCH_OUTPUT: batchOnlyOutput,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(batchOnly.exitCode).not.toBe(0);
    expect(await exists(join(batchOnlyRoot, "base"))).toBe(false);
    expect(await readFile(join(batchOnlyState, "marker"), "utf8")).toBe("state-marker\n");
    expect(await readFile(join(batchOnlyState, "backup-candidate", "marker"), "utf8")).toBe(
      "candidate-marker\n",
    );
    expect(await readFile(batchOnlyDatabase, "utf8")).toBe("database-marker\n");
    expect(await readFile(batchOnlyPointer, "utf8")).toBe("pointer-marker\n");
    expect(await readFile(batchOnlyLog, "utf8")).toBe("log-marker\n");
    expect(await readFile(join(batchOnlyPrevious, "marker"), "utf8")).toBe("previous-marker\n");
    expect(await readFile(join(batchOnlyOutput, "marker"), "utf8")).toBe("output-marker\n");

    const incompleteOutput = join(harness.root, "incomplete-results");
    const incomplete = Bun.spawnSync({
      cmd: command,
      env: {
        ...environment,
        QBT_FOCUSED_TEST_BATCH_OUTPUT: incompleteOutput,
        QBT_FOCUSED_TEST_PHASES: "preflight",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(incomplete.exitCode).not.toBe(0);
    expect(await exists(incompleteOutput)).toBe(false);

    const symlinkOutput = join(harness.root, "symlink-results");
    const symlinkTarget = join(harness.root, "symlink-target");
    await mkdir(symlinkTarget, { recursive: true });
    await writeFile(join(symlinkTarget, "marker"), "symlink-target-marker\n");
    await mkdir(symlinkOutput, { recursive: true });
    await symlink(symlinkTarget, join(symlinkOutput, "preflight"));
    const symlinkChild = Bun.spawnSync({
      cmd: command,
      env: { ...environment, QBT_FOCUSED_TEST_BATCH_OUTPUT: symlinkOutput },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(symlinkChild.exitCode).not.toBe(0);
    expect(await readFile(join(symlinkTarget, "marker"), "utf8")).toBe("symlink-target-marker\n");
    expect(await realpath(join(symlinkOutput, "preflight"))).toBe(symlinkTarget);

    const safetyProbe = Bun.spawnSync({
      cmd: command,
      env: {
        ...environment,
        QBT_FOCUSED_TEST_PROBE_OUTPUT: harness.probe,
        QBT_FOCUSED_TEST_PROBE_PHASES: "preflight,../live-migration",
        QBT_FOCUSED_TEST_PROBE_POINTER: join(tmpdir(), "quadball-fast-external-pointer"),
        QBT_FOCUSED_TEST_PROBE_STATE: linkedState,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(safetyProbe.exitCode).not.toBe(0);
    expect(await readFile(harness.probe, "utf8")).toBe("0 1 1\n");
    const batch = Bun.spawnSync({ cmd: command, env: environment, stderr: "pipe", stdout: "pipe" });
    expect(batch.exitCode).not.toBe(0);

    for (const [failurePhase, reportedPhase, backupPromoted, migrationApplied] of cases) {
      const phaseDirectory = join(harness.root, "results", failurePhase);
      const output = await readFile(join(phaseDirectory, "output"), "utf8");
      const current = (await readFile(join(phaseDirectory, "current"), "utf8")).trim();
      const operations = output;
      const result = Number((await readFile(join(phaseDirectory, "status"), "utf8")).trim());

      expect(result, failurePhase).not.toBe(0);
      expect(output, failurePhase).toContain(`ACTIVATION_PHASE=${reportedPhase}`);
      expect(output, failurePhase).toContain(`Focused activation failure at ${failurePhase}.`);
      expect(output, failurePhase).not.toContain("Activated immutable release attempt");
      expect(output, failurePhase).not.toContain(secretSentinel);
      expect(await readFile(join(phaseDirectory, "pointer"), "utf8"), failurePhase).toBe(
        backupPromoted ? "retained-after\n" : "retained-before\n",
      );
      expect(await readFile(join(phaseDirectory, "database"), "utf8"), failurePhase).toBe(
        migrationApplied ? "schema-after\n" : "schema-before\n",
      );
      expect(await readFile(harness.testCanary, "utf8"), failurePhase).toBe("test-untouched\n");
      expect(operations, failurePhase).not.toContain("quadball-timer-test");
      expect(operations.includes("systemctl stop quadball-timer"), failurePhase).toBe(
        !["preflight", "quiesce-stop"].includes(failurePhase),
      );
      expect(operations.includes("systemctl restart quadball-timer"), failurePhase).toBe(
        [
          "backup-create",
          "backup-verify",
          "backup-promote",
          "candidate-validation",
          "readiness",
          "final-report",
        ].includes(failurePhase),
      );
      expect(current, failurePhase).toBe(
        failurePhase === "final-report"
          ? join(harness.base, "releases", releaseId)
          : join(harness.base, "releases", previousReleaseId),
      );
    }
    expect(await readFile(harness.probe, "utf8")).toBe("0 1 1\n");
  }, 30_000);

  test("uses one bounded semantic Test readiness deadline for delayed and unhealthy services", async () => {
    const script = join(repositoryRoot, "deploy/activate-test-release.sh");
    const delayed = await createTestActivationHarness();
    const delayedRun = runTestActivation(delayed, {
      QBT_TEST_DELAY_CALLS: "3",
    });
    expect(delayedRun.exitCode, delayedRun.output).toBe(0);
    expect(delayedRun.output).toContain("Activated immutable Test release attempt");
    expect(await realpath(join(delayed.base, "current"))).toBe(delayed.release);
    expect(await readFile(delayed.transitions, "utf8")).toBe("stop\nrestart\n");
    expectProbeBudget(parseProbeLog(await readFile(delayed.probeLog, "utf8")), 0, 60);
    expect(Number(await readFile(delayed.clock, "utf8"))).toBe(19);

    const unhealthy = await createTestActivationHarness();
    const unhealthyRun = runTestActivation(unhealthy, {
      QBT_FOCUSED_TEST_PROBE_SECONDS: "19",
      QBT_TEST_UNHEALTHY: "1",
    });
    expect(unhealthyRun.exitCode).not.toBe(0);
    expect(unhealthyRun.output).toContain("Test deployment failed");
    expect(await realpath(join(unhealthy.base, "current"))).toBe(unhealthy.previous);
    expect(unhealthyRun.output).not.toContain("Activated immutable Test release attempt");
    expect(unhealthyRun.output).toContain("stopping Test service fail-closed");
    expect(unhealthyRun.output).toContain("Test service stopped after failed activation");
    expect(await readFile(unhealthy.transitions, "utf8")).toBe("stop\nrestart\nrestart\nstop\n");
    const unhealthyProbes = parseProbeLog(await readFile(unhealthy.probeLog, "utf8"));
    expect(unhealthyProbes.some((probe) => probe.start >= 60)).toBe(true);
    expectProbeBudget(
      unhealthyProbes.filter((probe) => probe.start < 60),
      0,
      60,
    );
    expectProbeBudget(
      unhealthyProbes.filter((probe) => probe.start >= 60),
      60,
      120,
    );
    expect(unhealthyProbes.every((probe) => probe.start < 120 && probe.end <= 120)).toBe(true);
    expect(Number(await readFile(unhealthy.clock, "utf8"))).toBe(120);
    expect(await readFile(script, "utf8")).toContain("readiness_window_seconds=60");
  }, 10_000);

  test("detaches only validated stale releases before cleanup in Production and Test", async () => {
    for (const scriptName of ["activate-release.sh", "activate-test-release.sh"]) {
      const script = join(repositoryRoot, "deploy", scriptName);
      const fixture = await createPruneHarness();
      const failedPrune = runPruneProbe(script, fixture, fixture.stale, {
        QBT_FOCUSED_TEST_PRUNE_FAILURE: "after-rename",
      });
      expect(failedPrune.exitCode, failedPrune.output).not.toBe(0);
      expect(await pathExists(fixture.stale), failedPrune.output).toBe(false);
      const trashEntries = await readdir(join(fixture.base, ".staging"));
      expect(trashEntries.some((entry) => entry.startsWith(".prune-"))).toBe(true);
      expect((await lstat(fixture.current)).mode & 0o200).toBe(0);
      expect((await lstat(fixture.rollback)).mode & 0o200).toBe(0);

      const valid = await createPruneHarness();
      const validRun = runPruneProbe(script, valid, valid.stale);
      expect(validRun.exitCode, validRun.output).toBe(0);
      expect(await pathExists(valid.stale)).toBe(false);
      expect(await pathExists(valid.current)).toBe(true);
      expect(await pathExists(valid.rollback)).toBe(true);

      for (const invalidTarget of [
        valid.symlink,
        valid.nested,
        valid.outside,
        valid.noncanonical,
      ]) {
        const invalidRun = runPruneProbe(script, valid, invalidTarget);
        expect(invalidRun.exitCode).not.toBe(0);
      }
      expect(await pathExists(valid.symlink)).toBe(true);
      expect(await pathExists(valid.nested)).toBe(true);
      expect(await pathExists(valid.outside)).toBe(true);
      expect(await pathExists(valid.stale)).toBe(false);
      expect((await lstat(valid.current)).mode & 0o200).toBe(0);
      expect((await lstat(valid.rollback)).mode & 0o200).toBe(0);
    }
  }, 10_000);
});

async function createTestActivationHarness(): Promise<{
  base: string;
  bin: string;
  clock: string;
  count: string;
  maintenance: string;
  previous: string;
  probeLog: string;
  release: string;
  root: string;
  transitions: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "quadball-test-activation-fast-")));
  roots.push(root);
  const base = join(root, "srv", "quadball-timer-test");
  const bin = join(root, "bin");
  const count = join(root, "curl-count");
  const clock = join(root, "logical-clock");
  const probeLog = join(root, "probe-log");
  const transitions = join(root, "service-transitions");
  const previous = join(base, "releases", "sha-prior-test-activation-attempt-1");
  const release = join(base, "releases", testActivationReleaseId);
  const maintenance = join(root, "maintenance");
  await mkdir(join(release, "deploy/systemd"), { recursive: true });
  await mkdir(previous, { recursive: true });
  await mkdir(join(base, ".staging"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(release, "deploy/systemd/quadball-timer-test.service"), "[Unit]\n");
  await writeFile(join(release, "quadball-timer"), "test executable\n");
  await chmod(join(release, "quadball-timer"), 0o555);
  const executableDigest = digest("test executable\n");
  await writeFile(
    join(release, "release-manifest.json"),
    JSON.stringify({
      releaseAttemptId: testActivationReleaseId,
      executableSha256: executableDigest,
      schemaCompatibility: "31",
    }),
  );
  await writeFile(
    join(previous, "release-manifest.json"),
    '{"supportedFoundationSchemaVersions":["31"]}',
  );
  await symlink(previous, join(base, "current"));
  await writeFile(count, "0\n");
  await writeFile(clock, "0\n");
  await writeFile(probeLog, "");
  await writeFile(transitions, "");
  await executable(
    join(bin, "systemctl"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == stop || "$1" == restart ]]; then
  printf '%s\\n' "$1" >>"$QBT_TEST_SERVICE_TRANSITIONS"
  exit 0
fi
if [[ "$1" == show ]]; then
  property=""
  for argument in "$@"; do [[ "$argument" == --property=* ]] && property="\${argument#--property=}"; done
  case "$property" in
    Environment) echo "QUADBALL_ENVIRONMENT=test PUBLIC_ORIGIN=https://test.timer.quadball.app FOUNDATION_DATABASE=/var/lib/quadball-timer-test/foundation.sqlite TECHNICAL_ADMIN_DATABASE=/var/lib/quadball-timer-test/technical-admin.sqlite EVENT_GAME_DATABASE=/var/lib/quadball-timer-test/event-game.sqlite GRANT_KEY_RING_FILE=/etc/quadball-timer/test-grant-key-ring.json" ;;
    ExecStart) echo "$QBT_TEST_BASE/current/quadball-timer" ;;
    StateDirectory) echo "quadball-timer-test" ;;
    StateDirectoryMode) echo "0750" ;;
  esac
fi
`,
  );
  await executable(join(bin, "sudo"), '#!/usr/bin/env bash\nexec "$@"\n');
  await executable(join(bin, "flock"), "#!/usr/bin/env bash\nexit 0\n");
  await executable(
    join(bin, "df"),
    "#!/usr/bin/env bash\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nfast 999999 1 999998 1%% /fast\\n'\n",
  );
  await executable(
    join(bin, "grep"),
    `#!/usr/bin/env bash
if [[ "$*" == *"/proc/cpuinfo"* ]]; then exit 0; fi
exec /usr/bin/grep "$@"
`,
  );
  await executable(
    join(bin, "realpath"),
    `#!/usr/bin/env bash
if [[ "$1" == -e ]]; then shift; fi
if [[ "$1" == -- ]]; then shift; fi
exec /bin/realpath "$@"
`,
  );
  await executable(
    join(bin, "find"),
    `#!/usr/bin/env bash
if [[ "$*" == *"-printf"* ]]; then
  for path in "$QBT_TEST_BASE/releases"/*; do
    [[ -d "$path" ]] && printf '1.0 %s\\n' "$path"
  done
  exit 0
fi
exec /usr/bin/find "$@"
`,
  );
  await executable(
    join(bin, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
count="$(cat "$QBT_TEST_CURL_COUNT")"
count=$((count + 1))
printf '%s\\n' "$count" >"$QBT_TEST_CURL_COUNT"
url="\${!#}"
if [[ "\${QBT_TEST_UNHEALTHY:-}" == 1 || "$count" -le \${QBT_TEST_DELAY_CALLS:-0} ]]; then exit 7; fi
case "$url" in
  */internal/release) printf '{"releaseAttemptId":"%s","executableSha256":"%s","runningExecutableSha256":"%s","schemaCompatibility":"31"}\\n' "$QBT_TEST_RELEASE" "$QBT_TEST_DIGEST" "$QBT_TEST_DIGEST" ;;
  */ws) printf 'HTTP/1.1 101 Switching Protocols\\r\\n\\r\\n' ;;
  */api/audience/events|*/internal/healthz) printf '{}\\n' ;;
  */) printf 'Test environment — not for live games\\n' ;;
esac
`,
  );
  await executable(
    maintenance,
    `#!/usr/bin/env bash
set -euo pipefail
case "$3" in
  preflight) printf '{"schemaVersion":31}\\n' ;;
  validate-migration) printf '{"ready":true}\\n' ;;
  apply-migrations) printf '{"schemaVersion":31}\\n' ;;
  *) : ;;
esac
`,
  );
  return { base, bin, clock, count, maintenance, previous, probeLog, release, root, transitions };
}

function runTestActivation(
  fixture: Awaited<ReturnType<typeof createTestActivationHarness>>,
  extra: Record<string, string>,
) {
  const result = Bun.spawnSync({
    cmd: [
      "bash",
      join(repositoryRoot, "deploy/activate-test-release.sh"),
      "--base-dir",
      fixture.base,
      "--release",
      testActivationReleaseId,
    ],
    env: {
      ...process.env,
      ...extra,
      PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
      QBT_FOCUSED_TEST_CLOCK: "logical",
      QBT_FOCUSED_TEST_CLOCK_FILE: fixture.clock,
      QBT_FOCUSED_TEST_MAINTENANCE_WRAPPER: fixture.maintenance,
      QBT_FOCUSED_TEST_MODE: "1",
      QBT_FOCUSED_TEST_PROBE_LOG: fixture.probeLog,
      QBT_FOCUSED_TEST_PROBE_SECONDS: extra.QBT_FOCUSED_TEST_PROBE_SECONDS ?? "2",
      QBT_FOCUSED_TEST_RELEASE_VERIFIED: "1",
      QBT_FOCUSED_TEST_REALPATH: join(fixture.root, "bin", "realpath"),
      QBT_FOCUSED_TEST_ROOT: fixture.root,
      QBT_TEST_BASE: fixture.base,
      QBT_TEST_CURL_COUNT: fixture.count,
      QBT_TEST_DIGEST: digest("test executable\n"),
      QBT_TEST_RELEASE: testActivationReleaseId,
      QBT_TEST_SERVICE_TRANSITIONS: fixture.transitions,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    output: `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`,
  };
}

async function createPruneHarness(): Promise<{
  base: string;
  current: string;
  nested: string;
  noncanonical: string;
  outside: string;
  releaseRoot: string;
  rollback: string;
  root: string;
  stale: string;
  symlink: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "quadball-prune-fast-")));
  roots.push(root);
  const base = join(root, "srv", "quadball-timer");
  const releaseRoot = join(base, "releases");
  const staging = join(base, ".staging");
  const bin = join(root, "bin");
  const maintenance = join(root, "maintenance");
  const current = join(releaseRoot, "current-release");
  const rollback = join(releaseRoot, "rollback-release");
  const stale = join(releaseRoot, "stale-release");
  const nested = join(releaseRoot, "nested", "victim");
  const outside = join(root, "outside-release");
  const symlinkPath = join(releaseRoot, "symlink-victim");
  await mkdir(current, { recursive: true });
  await mkdir(rollback, { recursive: true });
  await mkdir(stale, { recursive: true });
  await mkdir(nested, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(staging, { recursive: true });
  await mkdir(bin, { recursive: true });
  await chmod(releaseRoot, 0o755);
  await chmod(staging, 0o755);
  await writeFile(join(current, "marker"), "current\n");
  await writeFile(join(rollback, "marker"), "rollback\n");
  await writeFile(join(stale, "marker"), "stale\n");
  await writeFile(join(nested, "marker"), "nested\n");
  await writeFile(join(outside, "marker"), "outside\n");
  await chmod(join(current, "marker"), 0o444);
  await chmod(join(rollback, "marker"), 0o444);
  await chmod(join(stale, "marker"), 0o444);
  await chmod(join(nested, "marker"), 0o444);
  await chmod(join(outside, "marker"), 0o444);
  await chmod(current, 0o555);
  await chmod(rollback, 0o555);
  // macOS rejects renaming a non-writable directory; keep its payload immutable
  // while allowing the cross-directory rename that the Linux deployment uses.
  await chmod(stale, process.platform === "darwin" ? 0o755 : 0o555);
  await chmod(nested, 0o555);
  await chmod(outside, 0o555);
  await symlink(outside, symlinkPath);
  await executable(maintenance, "#!/usr/bin/env bash\nexit 0\n");
  await executable(
    join(bin, "realpath"),
    `#!/usr/bin/env bash
if [[ "$1" == -e ]]; then shift; fi
if [[ "$1" == -- ]]; then shift; fi
exec /bin/realpath "$@"
`,
  );
  return {
    base,
    current,
    nested,
    noncanonical: join(releaseRoot, "..", "releases", "current-release"),
    outside,
    releaseRoot,
    rollback,
    root,
    stale,
    symlink: symlinkPath,
  };
}

function runPruneProbe(
  script: string,
  fixture: Awaited<ReturnType<typeof createPruneHarness>>,
  target: string,
  extra: Record<string, string> = {},
) {
  const result = Bun.spawnSync({
    cmd: ["bash", script, "--base-dir", fixture.base, "--release", releaseId],
    env: {
      ...process.env,
      ...extra,
      QBT_FOCUSED_TEST_MAINTENANCE_WRAPPER: join(fixture.root, "maintenance"),
      QBT_FOCUSED_TEST_MODE: "1",
      QBT_FOCUSED_TEST_PRUNE_PROBE: "1",
      QBT_FOCUSED_TEST_PRUNE_TARGET: target,
      QBT_FOCUSED_TEST_REALPATH: join(fixture.root, "bin", "realpath"),
      QBT_FOCUSED_TEST_ROOT: fixture.root,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    output: `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseProbeLog(contents: string): Array<{
  end: number;
  phase: string;
  probe: string;
  start: number;
}> {
  const records = contents
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [time, phase, probe, status] = line.split(" ");
      if (
        time === undefined ||
        phase === undefined ||
        probe === undefined ||
        status === undefined
      ) {
        throw new Error(`Malformed probe log record: ${line}`);
      }
      return { end: Number(time), phase, probe, start: Number(time), status };
    });
  const probes: Array<{ end: number; phase: string; probe: string; start: number }> = [];
  for (let index = 0; index < records.length; index += 2) {
    const start = records[index];
    const end = records[index + 1];
    if (start === undefined || end === undefined) throw new Error("Unpaired probe log record");
    expect(start?.phase).toBe("start");
    expect(end?.phase).toBe("end");
    expect(start?.probe).toBe(end?.probe);
    probes.push({ end: end.end, phase: end.status, probe: end.probe, start: start.start });
  }
  return probes;
}

function expectProbeBudget(
  probes: Array<{ end: number; start: number }>,
  minimum: number,
  deadline: number,
) {
  expect(probes.length).toBeGreaterThan(0);
  expect(probes.every((probe) => probe.start >= minimum && probe.start < deadline)).toBe(true);
  expect(probes.every((probe) => probe.end >= probe.start && probe.end <= deadline)).toBe(true);
}
