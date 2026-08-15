import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
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
    expect(unit).toContain(
      "Environment=GRANT_KEY_RING_FILE=/etc/quadball-timer/production-grant-key-ring.json",
    );
    expect(unit).toContain("EnvironmentFile=-/etc/quadball-timer/production.env");
  });

  test("builds one shared immutable artifact for independent environment jobs", () => {
    const workflow = readFileSync(
      join(repositoryRoot, ".github/workflows/deploy-production.yml"),
      "utf8",
    );

    expect(workflow).toContain("bun run build:executable");
    expect(workflow).toContain("bun scripts/create-release-bundle.ts");
    expect(workflow).toContain("Upload one shared release artifact");
    expect(workflow).toContain("deploy-test:");
    expect(workflow).toContain("deploy-production:");
    expect(workflow).toContain("needs: [deploy-test, deploy-production]");
  });

  test("reports each environment outcome with release identity and bounded phase", () => {
    const workflow = readFileSync(
      join(repositoryRoot, ".github/workflows/deploy-production.yml"),
      "utf8",
    );

    expect(workflow).toContain("Record Test deployment outcome");
    expect(workflow).toContain("Record Production deployment outcome");
    expect(workflow).toContain('echo "releaseAttemptId=$RELEASE_ATTEMPT"');
    expect(workflow).toContain('echo "failureCategory=$failure_category"');
    expect(workflow).toContain('"releaseAttemptId": "${RELEASE_ATTEMPT_ID}"');
    expect(workflow).toContain('"phase": "${TEST_PHASE}"');
    expect(workflow).toContain('"phase": "${PRODUCTION_PHASE}"');
    expect(workflow).toContain(
      'if [[ "$TEST_STATUS" != "success" || "$PRODUCTION_STATUS" != "success" ]]; then',
    );
  });

  test("preserves executable modes across the GitHub artifact boundary", () => {
    const workflow = readFileSync(
      join(repositoryRoot, ".github/workflows/deploy-production.yml"),
      "utf8",
    );

    expect(workflow).toContain("tar --create --gzip --file=release-bundle.tar.gz");
    expect(workflow).toContain("path: release-bundle.tar.gz");
    expect(workflow).toContain(
      'tar --extract --gzip --file="$archive" --directory=release --no-same-owner',
    );
    expect(workflow).toContain("test \"$(stat -c '%a' release/quadball-timer)\" = 555");
    expect(workflow).toContain("test \"$(stat -c '%a' release/deploy/activate-release.sh)\" = 555");
    expect(workflow).toContain("chmod -R u+w -- '${stage_dir}' 2>/dev/null || true");
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
    expect(activation).toContain("--staged-dir");
    expect(activation).toContain(
      "Release-attempt identity already exists and cannot be overwritten",
    );
    expect(activation).toContain("check_release_identity");
    expect(activation).toContain('check_health "$release_id" "$release_dir"');
    expect(activation).toContain("check_representative_behavior");
    expect(activation).toContain("/api/audience/events");
    const websocketKeys = [
      ...activation.matchAll(/Sec-WebSocket-Key:\s*([A-Za-z0-9+/]+={0,2})/gu),
    ].map((match) => match[1]);
    expect(websocketKeys).toHaveLength(1);
    const [websocketKey] = websocketKeys;
    expect(websocketKey).toBeDefined();
    if (websocketKey === undefined) return;
    const decodedWebSocketKey = Buffer.from(websocketKey, "base64");
    expect(decodedWebSocketKey.byteLength).toBe(16);
    expect(decodedWebSocketKey.toString("base64")).toBe(websocketKey);
    expect(activation).toContain('check_health "$previous_release_id" "$previous_release"');
    expect(activation).toContain(
      'check_release_identity "$selected_release_id" "$selected_release_dir"',
    );
    expect(activation).toContain("chmod -R a-w");
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
    expect(activation).toContain(
      "GRANT_KEY_RING_FILE=/etc/quadball-timer/production-grant-key-ring.json",
    );
  });

  test("restores staging write permission before failed-stage cleanup", () => {
    const activation = readFileSync(join(repositoryRoot, "deploy/activate-release.sh"), "utf8");

    expect(activation).toContain('chmod -R u+w -- "$staged_dir" 2>/dev/null || true');
    expect(activation).toContain('rm -rf -- "$staged_dir"');
    expect(activation).toContain('chmod -R a-w -- "$release_dir"');
  });

  test("restores the validated staging root write bit before promotion", () => {
    const activation = readFileSync(join(repositoryRoot, "deploy/activate-release.sh"), "utf8");
    const verification = activation.indexOf('verify_bundle "$staged_dir"');
    const rootWrite = activation.indexOf('chmod u+w -- "$staged_dir"', verification);
    const promotion = activation.indexOf('mv -- "$staged_dir" "$release_dir"', rootWrite);
    const finalization = activation.indexOf('chmod -R a-w -- "$release_dir"', promotion);

    expect(verification).toBeGreaterThanOrEqual(0);
    expect(rootWrite).toBeGreaterThan(verification);
    expect(promotion).toBeGreaterThan(rootWrite);
    expect(finalization).toBeGreaterThan(promotion);
  });
});
