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
      join(repositoryRoot, ".github/workflows/deploy-production.yml"),
      "utf8",
    );

    expect(workflow).toContain("TEST_SSH_KEY");
    expect(workflow).toContain("TEST_HOST");
    expect(workflow).toContain("test -s release/release-manifest.json");
    expect(workflow).toContain("Prepare and verify immutable release bundle");
    expect(workflow).toContain("deploy-test:");
    expect(workflow).toContain("${stage_dir}/deploy/activate-test-release.sh");
    expect(workflow).toContain("quadball-timer-test");
    const testJob = workflow.slice(
      workflow.indexOf("  deploy-test:"),
      workflow.indexOf("  deploy-production:"),
    );
    expect(testJob).not.toContain("PROD_SSH_KEY");
    expect(testJob).not.toContain("timer-production-deploy");
  });

  test("extracts the shared archive with executable modes before Test transfer", () => {
    const workflow = readFileSync(
      join(repositoryRoot, ".github/workflows/deploy-production.yml"),
      "utf8",
    );
    const testJob = workflow.slice(
      workflow.indexOf("  deploy-test:"),
      workflow.indexOf("  deploy-production:"),
    );

    expect(testJob).toContain("Safely extract and verify release bundle modes");
    expect(testJob).toContain("--no-same-owner");
    expect(testJob).toContain("test -x release/deploy/activate-test-release.sh");
    expect(testJob).toContain(
      "test \"$(stat -c '%a' release/deploy/activate-test-release.sh)\" = 555",
    );
    expect(testJob).toContain("chmod -R u+w -- '${stage_dir}' 2>/dev/null || true");
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
    expect(activation).toContain("--staged-dir");
    expect(activation).toContain("release-attempt identity");
    expect(activation).toContain('check_health "$release_id" "$release_dir"');
    expect(activation).toContain('check_health "$previous_release_id" "$previous_release"');
    expect(activation).toContain(
      'check_release_identity "$selected_release_id" "$selected_release_dir"',
    );
    expect(activation).toContain("${release_dir}/deploy/systemd/quadball-timer-test.service");
    expect(activation).not.toContain("${release_dir}/deploy/quadball-timer.service");
    expect(activation).not.toContain("/srv/quadball-timer/current");
  });

  test("restores Test staging write permission before failed-stage cleanup", () => {
    const activation = readFileSync(
      join(repositoryRoot, "deploy/activate-test-release.sh"),
      "utf8",
    );

    expect(activation).toContain('chmod -R u+w -- "$staged_dir" 2>/dev/null || true');
    expect(activation).toContain('rm -rf -- "$staged_dir"');
    expect(activation).toContain('chmod -R a-w -- "$release_dir"');
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
    expect(provisioning).toContain(
      "/releases/$release_id/deploy/systemd/quadball-timer-test.service",
    );
    expect(provisioning).toContain("NOPASSWD: /usr/bin/systemctl restart quadball-timer-test");
    expect(provisioning).not.toContain("NOPASSWD: /bin/systemctl");
  });
});
