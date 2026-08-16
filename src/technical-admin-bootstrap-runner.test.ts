/* eslint-disable no-useless-escape */
import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runner = join(process.cwd(), "deploy/technical-admin-bootstrap-root.sh");

describe("Technical Admin bootstrap root runner", () => {
  test("uses fixed cross-Environment mappings and restarts after a successful operation", async () => {
    const fixture = await createRunnerFixture();
    try {
      const testRun = await runRunner(fixture, "test", "status");
      expect(testRun.code, testRun.stderr).toBe(0);
      expect(JSON.parse(testRun.stdout)).toEqual({
        environment: "test",
        credentialPresent: false,
        activeSessionCount: 0,
        storage: "ready",
      });

      const productionRun = await runRunner(fixture, "production", "enroll");
      expect(productionRun.code, productionRun.stderr).toBe(0);
      expect(productionRun.stdout).toMatch(
        /^https:\/\/timer\.quadball\.app\/admin\/enroll#token=production-secret\n$/u,
      );

      const log = await readFile(fixture.logPath, "utf8");
      expect(log).toContain("stop quadball-timer-test");
      expect(log).toContain(
        `run test https://test.timer.quadball.app test.timer.quadball.app ${fixture.root}/var/lib/quadball-timer-test/technical-admin.sqlite`,
      );
      expect(log).toContain("restart quadball-timer-test");
      expect(log).toContain("stop quadball-timer");
      expect(log).toContain(
        `run production https://timer.quadball.app timer.quadball.app ${fixture.root}/var/lib/quadball-timer/technical-admin.sqlite`,
      );
      expect(log).toContain("restart quadball-timer");
      expect(log.indexOf("stop quadball-timer-test")).toBeLessThan(log.indexOf("run test"));
      expect(log.indexOf("run test")).toBeLessThan(log.indexOf("restart quadball-timer-test"));
    } finally {
      await fixture.close();
    }
  });

  test("does not run maintenance after a stop failure", async () => {
    const fixture = await createRunnerFixture();
    try {
      const result = await runRunner(fixture, "test", "status", { STOP_FAILURE: "1" });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("authentication was not changed");
      expect(await readFile(fixture.logPath, "utf8")).toBe(
        "stop quadball-timer-test\nrestart quadball-timer-test\nis-active --quiet\n",
      );
      expect(await readFile(join(fixture.root, "service-state"), "utf8")).toBe("active\n");
      expect(await readFile(fixture.logPath, "utf8")).not.toContain("run ");
    } finally {
      await fixture.close();
    }
  });

  test("restarts after maintenance failure and suppresses an enrollment secret on restart failure", async () => {
    const fixture = await createRunnerFixture({ failingRelease: true });
    try {
      const operationFailure = await runRunner(fixture, "test", "status");
      expect(operationFailure.code).not.toBe(0);
      expect(operationFailure.stderr).toContain("operation failed");
      expect(await readFile(fixture.logPath, "utf8")).toContain("restart quadball-timer-test");

      await fixture.useSuccessfulRelease();
      const restartFailure = await runRunner(fixture, "test", "enroll", {
        RESTART_FAILURE: "1",
      });
      expect(restartFailure.code).not.toBe(0);
      expect(restartFailure.stdout).toBe("");
      expect(restartFailure.stderr).toContain("authentication may already have changed");
      expect(restartFailure.stderr).not.toContain("test-secret");
    } finally {
      await fixture.close();
    }
  });

  test("rejects an enrollment URL outside the mapped origin", async () => {
    const fixture = await createRunnerFixture();
    try {
      await writeFile(join(fixture.root, "bad-url"), "1");
      const result = await runRunner(fixture, "test", "enroll");
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("output was invalid");
    } finally {
      await fixture.close();
    }
  });
});

type RunnerFixture = {
  root: string;
  logPath: string;
  useSuccessfulRelease(): Promise<void>;
  close(): Promise<void>;
};

async function createRunnerFixture(
  options: { failingRelease?: boolean } = {},
): Promise<RunnerFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "quadball-technical-admin-runner-")));
  const bin = join(root, "bin");
  const logPath = join(root, "runner.log");
  await mkdir(bin, { recursive: true });
  const systemctl = join(bin, "systemctl");
  const runuser = join(bin, "runuser");
  const realpathCommand = join(bin, "realpath");
  await writeFile(
    systemctl,
    `#!/bin/sh
printf '%s %s\\n' "$1" "$2" >> ${quoteShell(logPath)}
case "$1" in
  stop) printf 'stopped\\n' > ${quoteShell(join(root, "service-state"))}; test "${"$"}STOP_FAILURE" != 1 ;;
  restart) printf 'active\\n' > ${quoteShell(join(root, "service-state"))}; test "${"$"}RESTART_FAILURE" != 1 ;;
  is-active) test "${"$"}RESTART_FAILURE" != 1 ;;
  *) exit 2 ;;
esac
`,
  );
  await writeFile(
    runuser,
    `#!/bin/sh
shift 3
exec "${"$"}@"
`,
  );
  await writeFile(
    realpathCommand,
    `#!/bin/sh
test "$1" = -e && shift
test "$1" = -- && shift
cd "$1" && pwd -P
`,
  );
  await chmod(systemctl, 0o755);
  await chmod(runuser, 0o755);
  await chmod(realpathCommand, 0o755);

  const fixture: RunnerFixture = {
    root,
    logPath,
    async useSuccessfulRelease() {
      await installRelease(fixture, false);
    },
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
  await installRelease(fixture, options.failingRelease === true);
  return fixture;
}

async function installRelease(fixture: RunnerFixture, failing: boolean): Promise<void> {
  // eslint-disable-next-line no-useless-escape
  const operation = failing
    ? "exit 7"
    : `case \"$2\" in\n  status) printf '%s' \"{\\\"environment\\\":\\\"$QUADBALL_ENVIRONMENT\\\",\\\"credentialPresent\\\":false,\\\"activeSessionCount\\\":0,\\\"storage\\\":\\\"ready\\\"}\" ;;\n  enroll) if test -f ${quoteShell(join(fixture.root, "bad-url"))}; then printf '%s' \"https://wrong.example/admin/enroll#token=$QUADBALL_ENVIRONMENT-secret\"; else printf '%s' \"$PUBLIC_ORIGIN/admin/enroll#token=$QUADBALL_ENVIRONMENT-secret\"; fi ;;\n  *) exit 9 ;;\nesac`;
  for (const environment of ["production", "test"] as const) {
    const base = environment === "production" ? "srv/quadball-timer" : "srv/quadball-timer-test";
    const release = join(fixture.root, base, "releases", failing ? "failing" : "working");
    await mkdir(release, { recursive: true });
    await writeFile(join(release, "release-manifest.json"), "{}\n");
    await writeFile(
      join(release, "quadball-timer"),
      `#!/bin/sh
if test "$1" = --; then set -- "$2" "$3"; fi
printf 'run %s %s %s %s\\n' "$QUADBALL_ENVIRONMENT" "$PUBLIC_ORIGIN" "$WEBAUTHN_RP_ID" "$TECHNICAL_ADMIN_DATABASE" >> ${quoteShell(fixture.logPath)}
${operation}
`,
    );
    await chmod(join(release, "quadball-timer"), 0o755);
    const current = join(fixture.root, base, "current");
    await rm(current, { force: true });
    await symlink(release, current);
  }
}

async function runRunner(
  fixture: RunnerFixture,
  environment: string,
  command: string,
  overrides: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bash", runner, environment, command], {
    env: {
      ...process.env,
      PATH: `${join(fixture.root, "bin")}:${process.env.PATH ?? ""}`,
      QBT_FOCUSED_TEST_MODE: "1",
      QBT_FOCUSED_TEST_ROOT: fixture.root,
      QBT_FOCUSED_TEST_SYSTEMCTL: join(fixture.root, "bin/systemctl"),
      QBT_FOCUSED_TEST_RUNUSER: join(fixture.root, "bin/runuser"),
      QBT_FOCUSED_TEST_REALPATH: join(fixture.root, "bin/realpath"),
      ...overrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
