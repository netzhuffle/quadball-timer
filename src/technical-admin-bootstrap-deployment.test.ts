import { describe, expect, test } from "bun:test";
import {
  chmod,
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELEASE_BUNDLE_ALLOWLIST } from "@/lib/release-manifest";

const repositoryRoot = process.cwd();

describe("Technical Admin bootstrap deployment contract", () => {
  test("ships one fixed root-owned runner in the immutable release", () => {
    expect(RELEASE_BUNDLE_ALLOWLIST).toContain("deploy/technical-admin-bootstrap-root.sh");
    const runner = readFileSync(
      join(repositoryRoot, "deploy/technical-admin-bootstrap-root.sh"),
      "utf8",
    );
    const productionActivation = readFileSync(
      join(repositoryRoot, "deploy/activate-release.sh"),
      "utf8",
    );
    const testActivation = readFileSync(
      join(repositoryRoot, "deploy/activate-test-release.sh"),
      "utf8",
    );
    const maintenance = readFileSync(
      join(repositoryRoot, "deploy/activation-maintenance-root.sh"),
      "utf8",
    );
    const trustedDigest = new Bun.CryptoHasher("sha256").update(runner).digest("hex");
    expect(runner).toContain('service_name="quadball-timer"');
    expect(runner).toContain('service_name="quadball-timer-test"');
    expect(runner).toContain('release_base="/srv/quadball-timer"');
    expect(runner).toContain('release_base="/srv/quadball-timer-test"');
    expect(runner).toContain('state_directory="/var/lib/quadball-timer"');
    expect(runner).toContain('state_directory="/var/lib/quadball-timer-test"');
    expect(runner).toContain('PUBLIC_ORIGIN="$public_origin"');
    expect(runner).toContain('WEBAUTHN_RP_ID="$rp_id"');
    expect(runner).toContain('TECHNICAL_ADMIN_DATABASE="$technical_admin_database"');
    expect(runner).toContain("trap finish EXIT");
    expect(runner).toContain('systemctl_command="/usr/bin/systemctl"');
    expect(runner).toContain('runuser_command="/usr/sbin/runuser"');
    expect(runner).toContain("[[ -t 0 && -t 1 ]]");
    expect(runner).toContain(
      'echo "Technical Admin bootstrap requires a human operator through sudo."',
    );
    expect(productionActivation).toContain('"deploy/technical-admin-bootstrap-root.sh"');
    expect(testActivation).toContain('"deploy/technical-admin-bootstrap-root.sh"');
    expect(productionActivation).toContain(
      'sudo "$maintenance_wrapper" "$expected_environment" "$release_dir" install-technical-admin-bootstrap',
    );
    expect(testActivation).toContain(
      'sudo "$maintenance_wrapper" "$expected_environment" "$release_dir" install-technical-admin-bootstrap',
    );
    expect(maintenance).toContain(`TECHNICAL_ADMIN_BOOTSTRAP_SHA256="${trustedDigest}"`);
    expect(runner).not.toContain("$3");
    expect(runner).not.toContain("$4");
  });

  test("keeps bootstrap outside deployment sudo authority and removes source-only commands", () => {
    const readme = readFileSync(join(repositoryRoot, "README.md"), "utf8");
    const testProvisioning = readFileSync(
      join(repositoryRoot, "deploy/test-environment-provisioning.md"),
      "utf8",
    );
    expect(readme).toContain("quadball-timer-technical-admin-bootstrap");
    expect(readme).not.toContain("quadball-timer-technical-admin-bootstrap, /usr");
    expect(testProvisioning).toContain("quadball-timer-technical-admin-bootstrap");
    expect(testProvisioning).not.toContain(
      "NOPASSWD: /usr/local/sbin/quadball-timer-technical-admin-bootstrap",
    );
  });

  test("executes the root activation boundary to install the fixed runner", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "quadball-bootstrap-activation-")));
    try {
      const realpathCommand = join(root, "bin/realpath");
      await mkdir(join(root, "bin"), { recursive: true });
      await writeFile(
        realpathCommand,
        '#!/bin/sh\nif test "$1" = -e; then shift; fi\nif test "$1" = --; then shift; fi\nexec /bin/realpath "$@"\n',
      );
      await chmod(realpathCommand, 0o755);
      const sha256sumCommand = join(root, "bin/sha256sum");
      await writeFile(sha256sumCommand, '#!/bin/sh\nexec /usr/bin/shasum -a 256 "$1"\n');
      await chmod(sha256sumCommand, 0o755);

      for (const environment of ["production", "test"] as const) {
        const baseName = environment === "production" ? "quadball-timer" : "quadball-timer-test";
        const releaseId =
          environment === "production"
            ? "sha-test-run-production-attempt-1"
            : "sha-test-run-test-attempt-1";
        const release = join(root, `srv/${baseName}/releases/${releaseId}`);
        const current = join(root, `srv/${baseName}/current`);
        const runnerSource = join(release, "deploy/technical-admin-bootstrap-root.sh");
        await mkdir(join(release, "deploy"), { recursive: true });
        await writeFile(
          runnerSource,
          await readFile(join(repositoryRoot, "deploy/technical-admin-bootstrap-root.sh")),
        );
        await chmod(runnerSource, 0o755);
        await writeFile(join(release, "quadball-timer"), "#!/bin/sh\n");
        await chmod(join(release, "quadball-timer"), 0o555);
        await writeFile(
          join(release, "release-manifest.json"),
          `{"releaseAttemptId":"${releaseId}","schemaCompatibility":"31"}\n`,
        );
        await symlink(release, current);

        const result = Bun.spawnSync({
          cmd: [
            "bash",
            join(repositoryRoot, "deploy/activation-maintenance-root.sh"),
            environment,
            release,
            "install-technical-admin-bootstrap",
          ],
          env: {
            ...process.env,
            QBT_FOCUSED_TEST_MODE: "1",
            QBT_FOCUSED_TEST_REALPATH: realpathCommand,
            QBT_FOCUSED_TEST_ROOT: root,
            QBT_FOCUSED_TEST_SHA256SUM: sha256sumCommand,
          },
          stderr: "pipe",
          stdout: "pipe",
        });
        const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
        expect(result.exitCode, `${environment}: ${output}`).toBe(0);

        const installed = join(root, "usr/local/sbin/quadball-timer-technical-admin-bootstrap");
        const acceptedRunner = await readFile(runnerSource, "utf8");
        expect(await readFile(installed, "utf8")).toBe(acceptedRunner);
        expect((await lstat(installed)).mode & 0o777).toBe(0o755);

        await writeFile(runnerSource, "#!/bin/sh\necho forged\n");
        await chmod(runnerSource, 0o755);
        const forged = Bun.spawnSync({
          cmd: [
            "bash",
            join(repositoryRoot, "deploy/activation-maintenance-root.sh"),
            environment,
            release,
            "install-technical-admin-bootstrap",
          ],
          env: {
            ...process.env,
            QBT_FOCUSED_TEST_MODE: "1",
            QBT_FOCUSED_TEST_REALPATH: realpathCommand,
            QBT_FOCUSED_TEST_ROOT: root,
            QBT_FOCUSED_TEST_SHA256SUM: sha256sumCommand,
          },
          stderr: "pipe",
          stdout: "pipe",
        });
        expect(forged.exitCode).not.toBe(0);
        expect(await readFile(installed, "utf8")).toBe(acceptedRunner);
        expect(await pathExists(join(root, "run"))).toBe(false);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
