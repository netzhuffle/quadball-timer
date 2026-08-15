import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = process.cwd();

describe("Test Environment deployment contract", () => {
  test("uses a distinct service, port, state, and public identity", () => {
    const unit = readFileSync(
      join(repositoryRoot, "deploy/systemd/quadball-timer-test.service"),
      "utf8",
    );

    expect(unit).toContain("User=quadball-timer-test");
    expect(unit).toContain("WorkingDirectory=/srv/quadball-timer-test/current");
    expect(unit).toContain("Environment=PORT=3001");
    expect(unit).toContain("Environment=PUBLIC_ORIGIN=https://test.timer.quadball.app");
    expect(unit).toContain("StateDirectory=quadball-timer-test");
    expect(unit).toContain("EnvironmentFile=/etc/quadball-timer/test.env");
    expect(unit).not.toContain("/var/lib/quadball-timer/");
    expect(unit).not.toContain("quadball-timer.service");
  });

  test("ships the Test service and digest manifest without Production credentials", () => {
    const workflow = readFileSync(
      join(repositoryRoot, ".github/workflows/deploy-test.yml"),
      "utf8",
    );

    expect(workflow).toContain("TEST_SSH_KEY");
    expect(workflow).toContain("TEST_HOST");
    expect(workflow).toContain("release-manifest.json");
    expect(workflow).toContain("executableSha256");
    expect(workflow).toContain("quadball-timer-test");
    expect(workflow).not.toContain("PROD_SSH_KEY");
    expect(workflow).not.toContain("timer-production-deploy");
  });

  test("activates only a Test release and checks its visible marker", () => {
    const activation = readFileSync(
      join(repositoryRoot, "deploy/activate-test-release.sh"),
      "utf8",
    );

    expect(activation).toContain('base_dir="/srv/quadball-timer-test"');
    expect(activation).toContain('service_name="quadball-timer-test"');
    expect(activation).toContain("Test environment — not for live games");
    expect(activation).toContain("executableSha256");
    expect(activation).toContain("${release_dir}/deploy/quadball-timer-test.service");
    expect(activation).not.toContain("${release_dir}/deploy/systemd/");
    expect(activation).not.toContain("quadball-timer.service");
    expect(activation).not.toContain("/srv/quadball-timer/current");
  });

  test("provisions and verifies the dedicated Test group before either user", () => {
    const provisioning = readFileSync(
      join(repositoryRoot, "deploy/test-environment-provisioning.md"),
      "utf8",
    );

    expect(provisioning).toContain("groupadd --system $group");
    expect(provisioning).toContain("--gid $group");
    expect(provisioning).toContain("test (id -gn $app) = $group");
    expect(provisioning).toContain("test (id -gn $deploy_user) = $group");
    expect(provisioning.indexOf("groupadd --system $group")).toBeLessThan(
      provisioning.indexOf("useradd --system --home-dir $base_dir"),
    );
    expect(provisioning).not.toContain("--gid $app");
    expect(provisioning).toContain("/releases/$release_id/deploy/quadball-timer-test.service");
    expect(provisioning).not.toContain("/releases/$release_id/deploy/systemd/");
    expect(provisioning).toContain("NOPASSWD: /usr/bin/systemctl restart quadball-timer-test");
    expect(provisioning).not.toContain("NOPASSWD: /bin/systemctl");
  });
});
