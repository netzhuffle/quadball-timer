import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath as fsRealpath,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveAdHocEnvironmentIdentity } from "@/lib/ad-hoc-games";
import {
  copyStableRestoreFile,
  prepareTechnicalAdminStorageForRestore,
} from "@/lib/production-activation-cli";

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
    expect(wrapper).toContain(
      '"$release_dir/quadball-timer" --production-activation "$command" --root-promotion 2>&1',
    );
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

  test("keeps service cleanup out of the root-owned promotion handoff", () => {
    const activationCli = readFileSync(
      join(repositoryRoot, "src/lib/production-activation-cli.ts"),
      "utf8",
    );
    const wrapper = readFileSync(
      join(repositoryRoot, "deploy/activation-maintenance-root.sh"),
      "utf8",
    );
    expect(activationCli).toContain(
      'process.env.QBT_ROOT_PROMOTION === "1" || argv.includes("--root-promotion")',
    );
    expect(activationCli).toContain("if (rootPromotionRequested)");
    expect(activationCli).toContain(
      "console.log(JSON.stringify({ verified: true, snapshotId: manifest.snapshotId }));",
    );
    expect(activationCli).toContain("const promotion = await promoteVerifiedBackup({");
    expect(wrapper).toContain("--root-promotion");
    expect(wrapper).toContain("promote_verified_backup_as_root");
    expect(wrapper).toContain("if (( rc != 0 )); then");
    expect(wrapper).toContain(
      'if (( rc != 0 )) && [[ "$command" == "backup" || "$command" == "verify-backup" || "$command" == "promote" ]]; then',
    );
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

  test("keeps Production restore host-local with an owned workspace and bounded readiness", () => {
    const wrapper = readFileSync(
      join(repositoryRoot, "deploy/activation-maintenance-root.sh"),
      "utf8",
    );
    const operator = readFileSync(join(repositoryRoot, "deploy/restore-production.sh"), "utf8");

    expect(wrapper).toContain('install_command="${QBT_FOCUSED_TEST_INSTALL:-/usr/bin/install}"');
    expect(wrapper).toContain('mktemp_command="${QBT_FOCUSED_TEST_MKTEMP:-mktemp}"');
    expect(wrapper).toContain(".restore-${release_attempt_id}-XXXXXX");
    expect(wrapper).toContain('install_command" -d -o root -g root -m 0700');
    expect(wrapper).toContain('RESTORE_WORKSPACE_DIRECTORY="$restore_workspace"');
    expect(wrapper).toContain('source_copy_path="/proc/self/fd/7"');
    expect(wrapper).toContain("== root:root:600");
    expect(wrapper).toContain("set -o noclobber");
    expect(wrapper).toContain('exec 6>"$destination_path"');
    expect(wrapper).toContain('exec 7<"$source_path"');
    expect(wrapper).toContain('cat <"$source_copy_path" >&6');
    expect(wrapper).toContain('sync -f -- "$destination_path"');
    expect(wrapper).toContain('chown "$service_user:$service_user" -- "$destination_path"');
    expect(wrapper).toContain('"${service_user}:${service_user}:600"');
    expect(wrapper).toContain("QBT_FOCUSED_TEST_OWNER_SEAM");
    expect(wrapper).toContain('"outcome":"cutover-completed-readiness-failed"');
    expect(operator).toContain('"$operator_identity" != deploy-quadball-timer');
    expect(operator).toContain('exec 9>"$base_dir/.activation.lock"');
    expect(operator).toContain('"$sudo_command" systemctl stop "$service_name"');
    expect(operator).toContain("check_release_identity");
    expect(operator).toContain("authoritative-operation");
    expect(operator).toContain('"technicalAdminAuth":{"outcome":"not-attempted"');
    expect(operator).toContain("/internal/healthz");
    expect(operator).toContain("https://timer.quadball.app");
    expect(operator).toContain("/healthz");
    expect(operator).toContain("/api/audience/events");
    expect(operator).toContain("check_authoritative_operation");
    expect(operator).not.toContain('"serviceRecovered"');
    expect(operator).not.toContain("systemctl restart");
    expect(operator).not.toContain("/api/games");
    expect(operator).not.toContain("activate-release.sh");
  });

  test("defers mutable Technical Admin restore access until snapshot verification", () => {
    const activationCli = readFileSync(
      join(repositoryRoot, "src/lib/production-activation-cli.ts"),
      "utf8",
    );
    const verification = activationCli.indexOf(
      "const verifiedManifest = await recovery.verifyBackup",
    );
    const authOpen = activationCli.indexOf(
      "technicalAdminRepository = createSqliteTechnicalAdminAuthRepository",
    );

    expect(verification).toBeGreaterThanOrEqual(0);
    expect(authOpen).toBeGreaterThan(verification);
    expect(activationCli).toContain('"failed-live-foundation.sqlite"');
    expect(activationCli.indexOf("prepareTechnicalAdminStorageForRestore(")).toBeGreaterThan(
      verification,
    );
    expect(activationCli).toContain("technicalAdminStoragePresent = technicalAdminStorage.present");
    expect(activationCli).toContain("reason: technicalAdminStorageReason");
  });

  test("keeps restore staging copies stable and no-follow at both boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "quadball-restore-copy-"));
    const source = join(root, "source.sqlite");
    const outside = join(root, "outside.sqlite");
    const destination = join(root, "destination.sqlite");
    const sourceReplacement = join(root, "source-replacement.sqlite");
    try {
      await writeFile(source, "candidate", { mode: 0o600 });
      await writeFile(outside, "outside", { mode: 0o600 });
      await symlink(outside, destination);
      await expect(copyStableRestoreFile(source, destination)).rejects.toThrow();
      expect(await readFile(outside, "utf8")).toBe("outside");

      await rm(destination, { force: true });
      await writeFile(sourceReplacement, "replacement", { mode: 0o600 });
      await rm(source, { force: true });
      await symlink(sourceReplacement, source);
      await expect(copyStableRestoreFile(source, destination)).rejects.toThrow("canonical");
      expect(await pathExists(destination)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("displaces invalid and incompatible Technical Admin storage before re-enrollment", async () => {
    const root = await fsRealpath(await mkdtemp(join(tmpdir(), "quadball-auth-restore-")));
    const expectedIdentity = {
      environment: "production" as const,
      origin: "https://timer.quadball.app",
      rpId: "timer.quadball.app",
    };
    const assertFreshIdentity = (databasePath: string) => {
      const database = new Database(databasePath, { readonly: true });
      const identity = database
        .query(
          "SELECT environment, origin, rp_id FROM technical_admin_storage_identity WHERE id = 1",
        )
        .get();
      database.close();
      expect(identity).toEqual({
        environment: "production",
        origin: "https://timer.quadball.app",
        rp_id: "timer.quadball.app",
      });
    };

    try {
      const incompatibleRoot = join(root, "incompatible");
      const incompatiblePath = join(incompatibleRoot, "technical-admin.sqlite");
      const incompatibleEvidence = join(incompatibleRoot, "evidence");
      await mkdir(incompatibleRoot, { recursive: true });
      const incompatible = new Database(incompatiblePath);
      incompatible.exec(
        "CREATE TABLE technical_admin_storage_identity (id INTEGER PRIMARY KEY, environment TEXT, origin TEXT, rp_id TEXT); INSERT INTO technical_admin_storage_identity VALUES (1, 'test', 'https://test.timer.quadball.app', 'test.timer.quadball.app');",
      );
      incompatible.close();
      await expect(
        prepareTechnicalAdminStorageForRestore(
          incompatiblePath,
          incompatibleEvidence,
          expectedIdentity,
        ),
      ).resolves.toEqual({ present: false, reason: "incompatible" });
      assertFreshIdentity(incompatiblePath);
      expect(await pathExists(join(incompatibleEvidence, "technical-admin.sqlite"))).toBe(true);

      const malformedRoot = join(root, "malformed");
      const malformedPath = join(malformedRoot, "technical-admin.sqlite");
      const malformedEvidence = join(malformedRoot, "evidence");
      await mkdir(malformedRoot, { recursive: true });
      const malformed = new Database(malformedPath);
      malformed.exec(
        "CREATE TABLE technical_admin_storage_identity (id INTEGER PRIMARY KEY, environment TEXT, origin TEXT, rp_id TEXT); INSERT INTO technical_admin_storage_identity VALUES (1, 'production', 'https://timer.quadball.app', 'timer.quadball.app'); CREATE TABLE technical_admin_credentials (credential_id TEXT PRIMARY KEY);",
      );
      malformed.close();
      await expect(
        prepareTechnicalAdminStorageForRestore(malformedPath, malformedEvidence, expectedIdentity),
      ).resolves.toEqual({ present: false, reason: "incompatible" });
      assertFreshIdentity(malformedPath);
      const preservedMalformed = new Database(join(malformedEvidence, "technical-admin.sqlite"), {
        readonly: true,
      });
      expect(
        preservedMalformed.query("PRAGMA table_info(technical_admin_credentials)").all(),
      ).toHaveLength(1);
      preservedMalformed.close();

      const symlinkRoot = join(root, "symlink");
      const symlinkPath = join(symlinkRoot, "technical-admin.sqlite");
      const symlinkEvidence = join(symlinkRoot, "evidence");
      const outsidePath = join(root, "outside.sqlite");
      await mkdir(symlinkRoot, { recursive: true });
      await writeFile(outsidePath, "outside evidence");
      await symlink(outsidePath, symlinkPath);
      await expect(
        prepareTechnicalAdminStorageForRestore(symlinkPath, symlinkEvidence, expectedIdentity),
      ).resolves.toEqual({ present: false, reason: "invalid" });
      assertFreshIdentity(symlinkPath);
      expect((await lstat(join(symlinkEvidence, "technical-admin.sqlite"))).isSymbolicLink()).toBe(
        true,
      );
      expect(await readFile(outsidePath, "utf8")).toBe("outside evidence");

      const directoryRoot = join(root, "directory");
      const directoryPath = join(directoryRoot, "technical-admin.sqlite");
      const directoryEvidence = join(directoryRoot, "evidence");
      await mkdir(directoryPath, { recursive: true });
      await writeFile(join(directoryPath, "marker"), "private evidence");
      await expect(
        prepareTechnicalAdminStorageForRestore(directoryPath, directoryEvidence, expectedIdentity),
      ).resolves.toEqual({ present: false, reason: "invalid" });
      assertFreshIdentity(directoryPath);
      expect(
        await readFile(join(directoryEvidence, "technical-admin.sqlite", "marker"), "utf8"),
      ).toBe("private evidence");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("executes the host-local restore orchestrator fail-closed across service states", async () => {
    const root = await fsRealpath(await mkdtemp(join(tmpdir(), "quadball-restore-operator-")));
    const binDirectory = join(root, "bin");
    const baseDirectory = join(root, "srv/quadball-timer");
    const releaseDirectory = join(baseDirectory, "releases/restore-attempt");
    const backupDirectory = join(root, "var/backups/quadball-timer");
    const verifiedDirectory = join(backupDirectory, "verified-snapshot");
    const manifestPath = join(verifiedDirectory, "snapshot.manifest.json");
    const serviceState = join(root, "service-active");
    const serviceLog = join(root, "service.log");
    const systemctlStub = join(binDirectory, "systemctl");
    const sudoStub = join(binDirectory, "sudo");
    const flockStub = join(binDirectory, "flock");
    const curlStub = join(binDirectory, "curl");
    const sleepStub = join(binDirectory, "sleep");
    const maintenanceStub = join(binDirectory, "maintenance-wrapper");
    const operator = join(repositoryRoot, "deploy/restore-production.sh");

    const run = async (outcome: string, active: boolean | "failed", curlFailure = false) => {
      if (active === "failed") await writeFile(serviceState, "failed\n");
      else if (active) await writeFile(serviceState, "active\n");
      else await rm(serviceState, { force: true });
      await writeFile(
        join(root, "operator-outcome"),
        `${outcome}\n${curlFailure ? "curl-failure" : "curl-ok"}\n`,
      );
      const child = Bun.spawn(["bash", operator, "--manifest", manifestPath], {
        env: {
          ...process.env,
          PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
          QBT_FOCUSED_TEST_MODE: "1",
          QBT_FOCUSED_TEST_ROOT: root,
          QBT_FOCUSED_TEST_OPERATOR: "deploy-quadball-timer",
          QBT_FOCUSED_TEST_SYSTEMCTL: systemctlStub,
          QBT_FOCUSED_TEST_SUDO: sudoStub,
          QBT_FOCUSED_TEST_FLOCK: flockStub,
          QBT_FOCUSED_TEST_CURL: curlStub,
          QBT_FOCUSED_TEST_SLEEP: sleepStub,
          QBT_FOCUSED_TEST_READINESS_ATTEMPTS: "1",
          QBT_FOCUSED_TEST_MAINTENANCE_WRAPPER: maintenanceStub,
          QBT_OPERATOR_SERVICE_STATE: serviceState,
          QBT_OPERATOR_SERVICE_LOG: serviceLog,
          QBT_OPERATOR_OUTCOME_FILE: join(root, "operator-outcome"),
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
      await mkdir(binDirectory, { recursive: true });
      await mkdir(releaseDirectory, { recursive: true });
      await mkdir(verifiedDirectory, { recursive: true });
      await symlink(releaseDirectory, join(baseDirectory, "current"));
      await writeFile(
        join(releaseDirectory, "release-manifest.json"),
        JSON.stringify({
          releaseAttemptId: "restore-attempt",
          executableSha256: "a".repeat(64),
          schemaCompatibility: "foundation-v1",
        }),
      );
      await writeFile(manifestPath, "{}\n");
      await writeFile(
        systemctlStub,
        `#!/bin/sh
set -eu
case "\${1:-}" in
  is-active) if [ -f "$QBT_OPERATOR_SERVICE_STATE" ]; then if grep -q failed "$QBT_OPERATOR_SERVICE_STATE"; then echo failed; else echo active; fi; else echo inactive; fi ;;
  stop) rm -f "$QBT_OPERATOR_SERVICE_STATE"; echo stop >> "$QBT_OPERATOR_SERVICE_LOG" ;;
  restart) if grep -q curl-failure "$QBT_OPERATOR_OUTCOME_FILE" && [ "\${QBT_OPERATOR_RESTART_FAIL:-0}" = 1 ]; then exit 1; fi; printf 'active\n' > "$QBT_OPERATOR_SERVICE_STATE"; echo restart >> "$QBT_OPERATOR_SERVICE_LOG" ;;
  *) exit 0 ;;
esac
`,
      );
      await writeFile(
        sudoStub,
        `#!/bin/sh
set -eu
if [ "\${1:-}" = systemctl ]; then shift; exec "$QBT_FOCUSED_TEST_SYSTEMCTL" "$@"; fi
exec "$@"
`,
      );
      await writeFile(flockStub, "#!/bin/sh\nexit 0\n");
      await writeFile(sleepStub, "#!/bin/sh\nexit 0\n");
      await writeFile(
        curlStub,
        `#!/bin/sh
set -eu
if grep -q curl-failure "$QBT_OPERATOR_OUTCOME_FILE"; then exit 1; fi
case "$*" in
  *internal/release*) printf '%s\\n' '{"releaseAttemptId":"restore-attempt","executableSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","runningExecutableSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","schemaCompatibility":"foundation-v1"}' ;;
  */healthz) printf 'healthy\\n' ;;
  */internal/healthz) printf '%s\\n' '{"ok":true}' ;;
  */api/audience/events) printf '%s\\n' '{"events":[]}' ;;
  */) printf '%s\\n' '<!doctype html>' ;;
  *) exit 1 ;;
esac
`,
      );
      await writeFile(
        maintenanceStub,
        `#!/bin/sh
set -eu
if [ "\${3:-}" = authoritative-operation ]; then printf '%s\\n' '{"ok":true}'; exit 0; fi
outcome="$(head -n1 "$QBT_OPERATOR_OUTCOME_FILE")"
case "$outcome" in
  success) touch "$QBT_OPERATOR_SERVICE_STATE"; printf '%s\\n' '{"restored":true,"restoreId":"restore-1","potentiallyNewerWork":false,"technicalAdminAuth":{"outcome":"preserved-transients-invalidated","credentialPreserved":true,"reEnrollmentRequired":false}}'; exit 0 ;;
  pre-failure) printf '%s\\n' '{"restored":false,"outcome":"restore-preparation-failed","cutoverCompleted":false,"technicalAdminAuth":{"outcome":"not-attempted","credentialPreserved":false,"reEnrollmentRequired":false}}'; exit 1 ;;
  post-failure) printf '%s\\n' '{"restored":false,"outcome":"foundation-replacement-failed","cutoverCompleted":true,"technicalAdminAuth":{"outcome":"preserved-transients-invalidated","credentialPreserved":true,"reEnrollmentRequired":false}}'; exit 1 ;;
  *) exit 1 ;;
esac
`,
      );
      for (const path of [
        systemctlStub,
        sudoStub,
        flockStub,
        curlStub,
        sleepStub,
        maintenanceStub,
      ]) {
        await chmod(path, 0o755);
      }

      const preFailure = await run("pre-failure", true);
      expect(preFailure.code, preFailure.output).toBe(1);
      expect(preFailure.output).toContain('"outcome":"restore-preparation-failed"');
      expect(preFailure.output).toContain('"outcome":"not-attempted"');
      expect(preFailure.output).toContain('"serviceStopped":true');
      expect(preFailure.output).not.toContain(root);
      expect(await pathExists(serviceState)).toBe(false);

      const initiallyInactive = await run("pre-failure", false);
      expect(initiallyInactive.code, initiallyInactive.output).toBe(1);
      expect(initiallyInactive.output).toContain('"serviceStopped":true');
      expect(await pathExists(serviceState)).toBe(false);

      const failedState = await run("pre-failure", "failed");
      expect(failedState.code, failedState.output).toBe(1);
      expect(failedState.output).toContain('"outcome":"restore-preparation-failed"');
      expect(failedState.output).toContain('"technicalAdminAuth":{"outcome":"not-attempted"');
      expect(failedState.output).toContain('"serviceStopped":true');
      expect(await pathExists(serviceState)).toBe(false);

      const postFailure = await run("post-failure", true);
      expect(postFailure.code, postFailure.output).toBe(12);
      expect(postFailure.output).toContain('"cutoverCompleted":true');
      expect(postFailure.output).toContain('"outcome":"preserved-transients-invalidated"');
      expect(await pathExists(serviceState)).toBe(false);

      const success = await run("success", true);
      expect(success.code, success.output).toBe(0);
      expect(success.output).toContain('"restored":true');
      expect(success.output).toContain('"outcome":"preserved-transients-invalidated"');
      expect(await pathExists(serviceState)).toBe(true);

      const verificationFailure = await run("success", true, true);
      expect(verificationFailure.code, verificationFailure.output).toBe(12);
      expect(verificationFailure.output).toContain('"postRestartVerified":false');
      expect(verificationFailure.output).toContain('"cutoverCompleted":true');
      expect(await pathExists(serviceState)).toBe(false);
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
