import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveAdHocEnvironmentIdentity } from "@/lib/ad-hoc-games";

const repositoryRoot = process.cwd();

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

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

  test("keeps verified backup promotion in the root ownership boundary", () => {
    const wrapper = readFileSync(
      join(repositoryRoot, "deploy/activation-maintenance-root.sh"),
      "utf8",
    );

    expect(wrapper).toContain("configure_promotion_test_hooks()");
    expect(wrapper).toContain('mv_command="mv"');
    expect(wrapper).toContain('stat_command="stat"');
    expect(wrapper).toContain("skip_chown=0");
    expect(wrapper).toContain('before_previous_rm_command=""');
    expect(wrapper).toContain('QBT_ROOT_PROMOTION="$root_promotion"');
    expect(wrapper).toContain("promote_verified_backup_as_root");
    expect(wrapper).toContain('chown -R root:root -- "$candidate_directory"');
    expect(wrapper).toContain('mv -- "$candidate_directory" "$retained_version"');
    expect(wrapper).toContain('"$mv_command" -T -- "$temporary_pointer" "$retained_pointer"');
    expect(wrapper).toContain("local previous_cleanup_allowed=0");
    expect(wrapper).toContain('stat_command="${QBT_FOCUSED_TEST_STAT:-stat}"');
    expect(wrapper).toContain('[[ -n "$previous_target" && "$previous_cleanup_allowed" == 1 ]]');
    expect(wrapper).toContain('exec 8<"$previous_path"');
    expect(wrapper).toContain('"/proc/self/fd/8"');
    expect(wrapper).toContain("previous_fd_open=1");
    expect(wrapper).toContain(
      '[[ "$command" == "promote" ]] && foundation_backup_directory="$backup_directory"',
    );
    expect(wrapper).toContain('[[ "$focused_test_mode" != 1 ]]');
    expect(wrapper).toContain('"${maintenance_output:0:4096}"');
  });

  test("uses Linux mv -T to replace the retained pointer without following it", async () => {
    if (process.platform !== "linux") return;

    const wrapper = readFileSync(
      join(repositoryRoot, "deploy/activation-maintenance-root.sh"),
      "utf8",
    );
    const functionStart = wrapper.indexOf("configure_promotion_test_hooks() {");
    const functionEnd = wrapper.indexOf('\n}\n\nif [[ "$focused_test_mode" == 1 ]]', functionStart);
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);
    const functionSource = wrapper.slice(functionStart, functionEnd + 2);
    const root = await mkdtemp(join(tmpdir(), "quadball-backup-promotion-contract-"));
    const harness = join(root, "promote.sh");
    const ambientHarness = join(root, "ambient-hooks.sh");
    const run = async (
      backupDirectory: string,
      releaseAttemptId: string,
      mvOverride?: string,
      beforePreviousRmOverride?: string,
    ) => {
      const child = Bun.spawn(["bash", harness, backupDirectory, releaseAttemptId], {
        cwd: root,
        env: {
          ...process.env,
          QBT_FOCUSED_TEST_SKIP_CHOWN: "1",
          ...(mvOverride === undefined ? {} : { QBT_FOCUSED_TEST_MV: mvOverride }),
          ...(beforePreviousRmOverride === undefined
            ? {}
            : { QBT_FOCUSED_TEST_BEFORE_PREVIOUS_RM: beforePreviousRmOverride }),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        code: await child.exited,
        output: `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`,
      };
    };
    try {
      await writeFile(
        ambientHarness,
        `#!/usr/bin/env bash
set -euo pipefail
${functionSource}
focused_test_root="$PWD"
test_harness_mode=0
mv_command=mv
stat_command=stat
skip_chown=0
before_previous_rm_command=""
configure_promotion_test_hooks
printf '%s|%s|%s|%s\\n' "$mv_command" "$stat_command" "$skip_chown" "$before_previous_rm_command"
`,
      );
      await chmod(ambientHarness, 0o755);
      const ambient = Bun.spawn(["bash", ambientHarness], {
        cwd: root,
        env: {
          ...process.env,
          QBT_FOCUSED_TEST_MV: "/bin/false",
          QBT_FOCUSED_TEST_STAT: "/bin/false",
          QBT_FOCUSED_TEST_SKIP_CHOWN: "1",
          QBT_FOCUSED_TEST_BEFORE_PREVIOUS_RM: "/bin/false",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const ambientOutput = await new Response(ambient.stdout).text();
      const ambientError = await new Response(ambient.stderr).text();
      expect(await ambient.exited, ambientError).toBe(0);
      expect(ambientOutput).toBe("mv|stat|0|\n");

      await writeFile(
        harness,
        `#!/usr/bin/env bash
set -euo pipefail
${functionSource}
backup_directory="$1"
focused_test_mode=""
focused_test_root="$PWD"
test_harness_mode=1
mv_command=mv
stat_command=stat
skip_chown=0
before_previous_rm_command=""
realpath_command=realpath
configure_promotion_test_hooks
release_attempt_id="$2"
promote_verified_backup_as_root "$backup_directory/.candidate-$release_attempt_id" "$backup_directory/.candidate-$release_attempt_id/manifest.json" "$release_attempt_id"
`,
      );
      await chmod(harness, 0o755);

      const successRoot = join(root, "success");
      const successCandidate = join(successRoot, ".candidate-new");
      const successOld = join(successRoot, "verified-old");
      await mkdir(successCandidate, { recursive: true });
      await mkdir(successOld, { recursive: true });
      await writeFile(join(successCandidate, "manifest.json"), "candidate\n");
      await writeFile(join(successOld, "marker"), "old\n");
      await symlink("verified-old", join(successRoot, "retained"));
      const success = await run(successRoot, "new");
      expect(success.code, success.output).toBe(0);
      expect(await readlink(join(successRoot, "retained"))).toBe("verified-new");
      expect(await pathExists(join(successRoot, "verified-new"))).toBe(true);
      expect(await pathExists(successOld)).toBe(false);
      expect(await pathExists(successCandidate)).toBe(false);

      const invalidNamespaceRoot = join(root, "invalid-namespace");
      const invalidNamespaceCandidate = join(invalidNamespaceRoot, ".candidate-new");
      const invalidNamespaceOld = join(invalidNamespaceRoot, "unexpected-target");
      await mkdir(invalidNamespaceCandidate, { recursive: true });
      await mkdir(invalidNamespaceOld, { recursive: true });
      await writeFile(join(invalidNamespaceCandidate, "manifest.json"), "candidate\n");
      await writeFile(join(invalidNamespaceOld, "marker"), "must-retain\n");
      await symlink("unexpected-target", join(invalidNamespaceRoot, "retained"));
      const invalidNamespace = await run(invalidNamespaceRoot, "new");
      expect(invalidNamespace.code, invalidNamespace.output).toBe(0);
      expect(await readlink(join(invalidNamespaceRoot, "retained"))).toBe("verified-new");
      expect(await readFile(join(invalidNamespaceOld, "marker"), "utf8")).toBe("must-retain\n");

      const replacementRoot = join(root, "replacement-object");
      const replacementCandidate = join(replacementRoot, ".candidate-new");
      const replacementOld = join(replacementRoot, "verified-old");
      const replacementScript = join(root, "replace-old.sh");
      await mkdir(replacementCandidate, { recursive: true });
      await mkdir(replacementOld, { recursive: true });
      await writeFile(join(replacementCandidate, "manifest.json"), "candidate\n");
      await writeFile(join(replacementOld, "marker"), "old\n");
      await symlink("verified-old", join(replacementRoot, "retained"));
      await writeFile(
        replacementScript,
        '#!/usr/bin/env bash\nset -euo pipefail\nrm -rf -- "$1"\nmkdir -p -- "$1"\nprintf \'replacement\\n\' > "$1/marker"\n',
      );
      await chmod(replacementScript, 0o755);
      const replacement = await run(replacementRoot, "new", undefined, replacementScript);
      expect(replacement.code, replacement.output).toBe(0);
      expect(await readlink(join(replacementRoot, "retained"))).toBe("verified-new");
      expect(await readFile(join(replacementOld, "marker"), "utf8")).toBe("replacement\n");
      expect(replacement.output).toContain("cleanupWarning");

      const failureRoot = join(root, "failure");
      const failureCandidate = join(failureRoot, ".candidate-fail");
      const failureOld = join(failureRoot, "verified-old");
      const failureMv = join(root, "mv-fails.sh");
      await mkdir(failureCandidate, { recursive: true });
      await mkdir(failureOld, { recursive: true });
      await writeFile(join(failureCandidate, "manifest.json"), "candidate\n");
      await writeFile(join(failureOld, "marker"), "old\n");
      await symlink("verified-old", join(failureRoot, "retained"));
      await writeFile(
        failureMv,
        '#!/usr/bin/env bash\nif [[ "$1" == "-T" ]]; then exit 73; fi\nexec /bin/mv "$@"\n',
      );
      await chmod(failureMv, 0o755);
      const failure = await run(failureRoot, "fail", failureMv);
      expect(failure.code).not.toBe(0);
      expect(failure.output.length).toBeLessThan(4096);
      expect(await readlink(join(failureRoot, "retained"))).toBe("verified-old");
      expect(await readFile(join(failureOld, "marker"), "utf8")).toBe("old\n");
      expect(await pathExists(join(failureRoot, "verified-fail"))).toBe(false);
      expect(await pathExists(failureCandidate)).toBe(false);
      expect(await pathExists(join(failureRoot, ".retained-fail.tmp"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
