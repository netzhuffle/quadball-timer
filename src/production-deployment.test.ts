import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAdHocEnvironmentIdentity } from "@/lib/ad-hoc-games";

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

  test("uses the fixed root maintenance boundary for schema operations", () => {
    const wrapper = readFileSync(
      join(repositoryRoot, "deploy/activation-maintenance-root.sh"),
      "utf8",
    );
    expect(wrapper).toContain('QUADBALL_ENVIRONMENT="$environment"');
    expect(wrapper).toContain('GRANT_KEY_RING_FILE="$key_ring_file"');
    expect(wrapper).toContain('backup_directory="/var/backups/quadball-timer"');
    expect(wrapper).toContain('PUBLIC_ORIGIN="$public_origin"');
    expect(wrapper).toContain("backup|verify-backup|promote");
    expect(wrapper).not.toContain("eval ");
  });

  test("documents the host-observed Production sudoers command path", () => {
    const readme = readFileSync(join(repositoryRoot, "README.md"), "utf8");

    expect(readme).toContain(
      "deploy-quadball-timer ALL=(root) NOPASSWD: /usr/bin/systemctl stop quadball-timer, /usr/bin/systemctl restart quadball-timer, /usr/local/sbin/quadball-timer-activation-maintenance",
    );
    expect(readme).not.toContain("NOPASSWD: /bin/systemctl");
  });

  test("keeps the privileged pre-merge handoff single-session and fail-fast", () => {
    const handoff = readFileSync(
      join(repositoryRoot, "docs/agents/issue-165-pre-merge-handoff.md"),
      "utf8",
    );

    expect(handoff).not.toContain("wc -l < /etc/sudoers.d");
    expect(handoff).toContain("wc -l /etc/sudoers.d/deploy-quadball-timer");
    expect(handoff).toContain("wc -l /etc/sudoers.d/deploy-quadball-timer-test");
    expect(handoff).toContain("set privileged_command (string join ' '");
    expect(handoff.match(/ssh -tt jannis@jannis\.rocks \$privileged_command/gu)).toHaveLength(1);
    expect(handoff.match(/\/usr\/bin\/sudo -v/gu)).toHaveLength(1);
    expect(handoff).toContain("rm -rf -- $remote_dir");
    expect(handoff).toContain("test ! -e $remote_dir");
  });

  test("includes the canonical Production Ad Hoc database in backup verification", () => {
    const activationCli = readFileSync(
      join(repositoryRoot, "src/lib/production-activation-cli.ts"),
      "utf8",
    );
    const recoveryCreation = activationCli.indexOf(
      "const recovery = createFoundationRecovery(storage, {",
    );

    expect(activationCli).toContain("createSqliteAdHocRecoveryAdapter");
    expect(activationCli).toContain("dirname(storagePaths.foundationDatabase)");
    expect(activationCli).toContain('"ad-hoc.sqlite"');
    expect(activationCli).toContain(
      'throw new Error("Production Ad Hoc database must share the Environment database directory.")',
    );
    expect(activationCli).toContain("requireProductionAdHocBackup(manifest)");
    const adHocOption = activationCli.indexOf(
      "adHoc: createSqliteAdHocRecoveryAdapter(adHocDatabasePath, adHocEnvironmentIdentity),",
    );
    expect(recoveryCreation).toBeGreaterThanOrEqual(0);
    expect(adHocOption).toBeGreaterThan(recoveryCreation);
    const wrapper = readFileSync(
      join(repositoryRoot, "deploy/activation-maintenance-root.sh"),
      "utf8",
    );
    expect(wrapper).toContain('AD_HOC_DATABASE="$ad_hoc_database"');
    expect(wrapper).toContain('AD_HOC_ENVIRONMENT_ID="$ad_hoc_environment_identity"');
  });

  test("keeps Production Ad Hoc identity canonical across startup and maintenance", () => {
    const normalIdentity = resolveAdHocEnvironmentIdentity(
      "production",
      "https://timer.quadball.app",
    );
    const focusedIdentity = resolveAdHocEnvironmentIdentity(
      "production",
      "https://timer.quadball.app",
      normalIdentity,
    );
    expect(normalIdentity).toBe("production:https://timer.quadball.app");
    expect(focusedIdentity).toBe(normalIdentity);
    expect(() =>
      resolveAdHocEnvironmentIdentity(
        "production",
        "https://timer.quadball.app",
        "production:https://other.example",
      ),
    ).toThrow("canonical value");
    expect(
      resolveAdHocEnvironmentIdentity("test", "https://test.timer.quadball.app", "test:local"),
    ).toBe("test:local");
  });

  test("checks rollback schema compatibility with the candidate maintenance executable", () => {
    const activation = readFileSync(join(repositoryRoot, "deploy/activate-release.sh"), "utf8");

    expect(activation).toContain("preflight");
    expect(activation).toContain("supportedFoundationSchemaVersions");
    expect(activation).not.toContain("disabled_legacy_compatible_previous_release");
    expect(activation).not.toContain(
      'sudo "$maintenance_wrapper" production "$previous_release" readiness',
    );
  });

  test("reports Production migration only after backup promotion", () => {
    const activation = readFileSync(join(repositoryRoot, "deploy/activate-release.sh"), "utf8");
    const promotion = activation.indexOf('production "$release_dir" promote');
    const migrationMarker = activation.indexOf("ACTIVATION_PHASE=migration", promotion);
    const candidateValidation = activation.indexOf('production "$release_dir" validate-migration');
    expect(promotion).toBeGreaterThanOrEqual(0);
    expect(migrationMarker).toBeGreaterThan(promotion);
    expect(candidateValidation).toBeGreaterThan(migrationMarker);
  });
});
