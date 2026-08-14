import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = process.cwd();

describe("Production deployment contract", () => {
  test("gives the service one private persistent state directory", () => {
    const unit = readFileSync(
      join(repositoryRoot, "deploy/systemd/quadball-timer.service"),
      "utf8",
    );

    expect(unit).toContain("StateDirectory=quadball-timer");
    expect(unit).toContain("StateDirectoryMode=0750");
    expect(unit).toContain(
      "Environment=TECHNICAL_ADMIN_DATABASE=/var/lib/quadball-timer/technical-admin.sqlite",
    );
    expect(unit).toContain(
      "Environment=FOUNDATION_DATABASE=/var/lib/quadball-timer/foundation.sqlite",
    );
  });

  test("ships the canonical unit with every release", () => {
    const workflow = readFileSync(
      join(repositoryRoot, ".github/workflows/deploy-production.yml"),
      "utf8",
    );

    expect(workflow).toContain(
      "install -m 644 deploy/systemd/quadball-timer.service release/deploy/systemd/quadball-timer.service",
    );
  });

  test("reports bounded non-secret service state when activation fails", () => {
    const activation = readFileSync(join(repositoryRoot, "deploy/activate-release.sh"), "utf8");

    expect(activation).toContain("for property in ActiveState SubState Result ExecMainStatus");
    expect(activation).toContain('--property="$property"');
    expect(activation).not.toContain("journalctl");
  });

  test("refuses activation until the installed unit owns Production state", () => {
    const activation = readFileSync(join(repositoryRoot, "deploy/activate-release.sh"), "utf8");

    expect(activation).toContain("check_service_state_contract");
    expect(activation).toContain(
      'systemctl show "$service_name" --property=StateDirectory --value',
    );
    expect(activation).toContain(
      'systemctl show "$service_name" --property=StateDirectoryMode --value',
    );
    expect(activation).toContain('systemctl show "$service_name" --property=Environment --value');
    expect(activation).not.toContain('systemctl cat "$service_name"');
    expect(activation).toContain("does not provide the required Production state contract");
    expect(activation).toContain(
      "Install ${release_dir}/deploy/systemd/quadball-timer.service and run systemctl daemon-reload before activation.",
    );
  });
});
