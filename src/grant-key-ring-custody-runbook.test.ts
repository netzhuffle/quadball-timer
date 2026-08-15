import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = process.cwd();

function runbook(): string {
  return readFileSync(join(repositoryRoot, "deploy/grant-key-ring-custody.md"), "utf8");
}

describe("Grant key-ring custody runbook contract", () => {
  test("captures the old Production source before replacing its unit", () => {
    const document = runbook();
    const helperInstall = document.indexOf(
      "sudo install -d -o root -g root -m 0755 /usr/local/libexec",
    );
    const sourceInspection = document.indexOf("Before choosing the conversion branch");
    const handoffStorage = document.indexOf("Store each handoff's protected");
    const unitInstall = document.indexOf("Only after both handoffs are stored");
    const ringInstallation = document.indexOf("Now install and verify each ring");

    expect(helperInstall).toBeGreaterThanOrEqual(0);
    expect(sourceInspection).toBeGreaterThan(helperInstall);
    expect(handoffStorage).toBeGreaterThan(sourceInspection);
    expect(ringInstallation).toBeGreaterThan(sourceInspection);
    expect(unitInstall).toBeGreaterThan(ringInstallation);
    expect(unitInstall).toBeGreaterThan(handoffStorage);

    const helperSection = document.slice(helperInstall, sourceInspection);
    expect(helperSection).not.toContain("quadball-timer.service-162-candidate");
    expect(helperSection).not.toContain("daemon-reload");
    expect(document.slice(unitInstall)).toContain("sudo systemctl daemon-reload");
  });

  test("keeps the fresh Production SSH target in the workstation scope", () => {
    const document = runbook();
    const freshStart = document.indexOf("set fresh_production_dir");
    const freshEnd = document.indexOf("\n```", freshStart);
    const freshBlock = document.slice(freshStart, freshEnd);

    expect(freshBlock).toContain("set remote_bootstrap_dir /root/quadball-timer-grant-bootstrap");
    expect(freshBlock).toContain("$remote_bootstrap_dir/production-grant-key-ring.json");
    expect(freshBlock).not.toContain("$bootstrap_dir/production-grant-key-ring.json");
  });
});
