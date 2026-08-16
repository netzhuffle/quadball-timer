import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import {
  SqliteTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
  technicalAdminSessionTtls,
  type TechnicalAdminRetentionScheduler,
  type WebAuthnVerifier,
} from "@/lib/technical-admin-auth";
import { createTechnicalAdminBootstrapOperations } from "@/lib/technical-admin-bootstrap";

const binding = { origin: "https://localhost:39421", host: "localhost:39421" };
const identity = { environment: "test" as const, origin: binding.origin, rpId: "localhost" };
const validEd25519PublicKey: JsonWebKey = {
  kty: "OKP",
  crv: "Ed25519",
  x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  alg: "EdDSA",
  ext: true,
};

function createVerifier(): WebAuthnVerifier {
  let signCount = 1;
  return {
    async verifyRegistration() {
      return {
        credentialId: "credential-1",
        publicKey: { ...validEd25519PublicKey },
        signCount: signCount++,
      };
    },
    async verifyAuthentication() {
      return { signCount: signCount++ };
    },
  };
}

async function enrollAndAuthenticate(
  repository: SqliteTechnicalAdminAuthRepository,
  now: () => number,
) {
  const auth = createTechnicalAdminAuth(identity, repository, createVerifier(), now);
  const issued = auth.issueEnrollmentAuthorization();
  if (!issued.ok) throw new Error("Expected enrollment authorization.");
  const enrollmentToken = decodeURIComponent(issued.value.url.split("token=")[1] ?? "");
  const enrollment = auth.beginEnrollment(enrollmentToken, binding);
  if (!enrollment.ok) throw new Error("Expected enrollment options.");
  const completed = await auth.completeEnrollment(enrollment.value.challengeId, {}, binding);
  if (!completed.ok) throw new Error("Expected enrollment completion.");
  const options = await auth.beginAuthentication(binding);
  if (!options.ok) throw new Error("Expected authentication options.");
  const session = await auth.completeAuthentication(options.value.challengeId, {}, binding);
  if (!session.ok) throw new Error("Expected authenticated session.");
  return { auth, session: session.value };
}

function insertCredential(databasePath: string, count = 1) {
  const database = new Database(databasePath);
  for (let index = 0; index < count; index++) {
    database
      .query("INSERT INTO technical_admin_credentials VALUES (?, ?, ?, ?)")
      .run(`credential-${index}`, JSON.stringify({ ...validEd25519PublicKey }), 1, 0);
  }
  database.close();
}

function createManualRetentionScheduler(now: () => number) {
  let nextId = 0;
  const timers = new Map<number, { atMs: number; callback: () => void }>();
  const scheduler: TechnicalAdminRetentionScheduler = {
    schedule(callback, deadlineMs) {
      const id = ++nextId;
      timers.set(id, { atMs: deadlineMs, callback });
      return id;
    },
    cancel(timer) {
      timers.delete(timer as number);
    },
  };
  return {
    scheduler,
    pendingCount: () => timers.size,
    runDue: () => {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.atMs <= now())
        .sort(([, left], [, right]) => left.atMs - right.atMs);
      for (const [id, timer] of due) {
        if (!timers.delete(id)) continue;
        timer.callback();
      }
    },
  };
}

async function withTempDirectory<T>(
  prefix: string,
  work: (directory: string) => T | PromiseLike<T>,
): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await work(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("focused Technical Admin SQLite boundary", () => {
  test("preserves the credential across sanitation and restart while requiring fresh sign-in", async () => {
    await withTempDirectory("technical-admin-restore-focused-", async (directory) => {
      const databasePath = join(directory, "auth.sqlite");
      let repository: SqliteTechnicalAdminAuthRepository | undefined;
      let restarted: SqliteTechnicalAdminAuthRepository | undefined;
      try {
        repository = new SqliteTechnicalAdminAuthRepository(databasePath, identity);
        const { auth, session } = await enrollAndAuthenticate(repository, () => 1_000);
        const pending = await auth.beginAuthentication(binding);
        if (!pending.ok) throw new Error("Expected a pending authentication challenge.");
        repository.issueEnrollment("pending-enrollment", 61_000);
        const credentialBefore = structuredClone(repository.getCredential());

        expect(
          await auth.prepareForFoundationRestore({ mode: "preserve-compatible-credential" }),
        ).toEqual({ outcome: "preserved-transients-invalidated" });
        expect(repository.getCredential()).toEqual(credentialBefore);
        expect(auth.authenticateSession(session.token)).toBe(false);
        expect(auth.verifyCsrf(session.token, session.csrfToken)).toBe(false);
        expect(auth.resolveCurrentAuthority(session.token)).toBeNull();
        expect(await auth.beginAuthentication(binding)).toMatchObject({ ok: true });

        repository.close();
        repository = undefined;
        restarted = new SqliteTechnicalAdminAuthRepository(databasePath, identity);
        const restartedAuth = createTechnicalAdminAuth(
          identity,
          restarted,
          createVerifier(),
          () => 2_000,
        );
        expect(restarted.getCredential()).toMatchObject({
          credentialId: credentialBefore?.credentialId,
          publicKey: credentialBefore?.publicKey,
          createdAtMs: credentialBefore?.createdAtMs,
        });
        const freshOptions = await restartedAuth.beginAuthentication(binding);
        if (!freshOptions.ok) throw new Error("Expected fresh authentication options.");
        expect(
          await restartedAuth.completeAuthentication(freshOptions.value.challengeId, {}, binding),
        ).toMatchObject({ ok: true });
      } finally {
        repository?.close();
        restarted?.close();
      }
    });
  });

  test("classifies readable invalid state while sanitizing its old authority", async () => {
    await withTempDirectory("technical-admin-restore-invalid-focused-", async (directory) => {
      const databasePath = join(directory, "auth.sqlite");
      let repository: SqliteTechnicalAdminAuthRepository | undefined;
      let reopened: SqliteTechnicalAdminAuthRepository | undefined;
      try {
        repository = new SqliteTechnicalAdminAuthRepository(databasePath, identity);
        const { auth, session } = await enrollAndAuthenticate(repository, () => 1_000);
        const pending = await auth.beginAuthentication(binding);
        if (!pending.ok) throw new Error("Expected a pending authentication challenge.");
        repository.issueEnrollment("pending-enrollment", 61_000);
        repository.close();
        repository = undefined;

        const database = new Database(databasePath);
        database
          .query("UPDATE technical_admin_credentials SET public_key_json = ?, credential_id = ?")
          .run(JSON.stringify({ ...validEd25519PublicKey, key_ops: ["sign"] }), "credential-live");
        database.close();

        reopened = new SqliteTechnicalAdminAuthRepository(databasePath);
        const reopenedAuth = createTechnicalAdminAuth(
          identity,
          reopened,
          createVerifier(),
          () => 2_000,
        );
        const challengeCountBefore = Number(
          (
            reopened.database
              .query("SELECT COUNT(*) AS count FROM technical_admin_challenges")
              .get() as { count: number }
          ).count,
        );
        expect(await reopenedAuth.beginAuthentication(binding)).toEqual({
          ok: false,
          error: "invalid-credentials",
        });
        expect(
          Number(
            (
              reopened.database
                .query("SELECT COUNT(*) AS count FROM technical_admin_challenges")
                .get() as { count: number }
            ).count,
          ),
        ).toBe(challengeCountBefore);
        expect(
          await reopenedAuth.prepareForFoundationRestore({
            mode: "preserve-compatible-credential",
          }),
        ).toEqual({ outcome: "re-enrollment-required", reason: "invalid" });
        expect(reopenedAuth.authenticateSession(session.token)).toBe(false);
        expect(await reopenedAuth.beginAuthentication(binding)).toEqual({
          ok: false,
          error: "invalid-credentials",
        });
      } finally {
        repository?.close();
        reopened?.close();
      }
    });
  });

  test("classifies compatible explicit reset atomically and removes the credential", async () => {
    await withTempDirectory("technical-admin-restore-reset-focused-", async (directory) => {
      const databasePath = join(directory, "auth.sqlite");
      let repository: SqliteTechnicalAdminAuthRepository | undefined;
      try {
        repository = new SqliteTechnicalAdminAuthRepository(databasePath, identity);
        const { auth, session } = await enrollAndAuthenticate(repository, () => 1_000);
        const pending = await auth.beginAuthentication(binding);
        if (!pending.ok) throw new Error("Expected a pending authentication challenge.");
        repository.issueEnrollment("pending-enrollment", 61_000);

        expect(await auth.prepareForFoundationRestore({ mode: "explicit-reset" })).toEqual({
          outcome: "re-enrollment-required",
          reason: "explicit-reset",
        });
        expect(repository.getCredential()).toBeNull();
        expect(auth.authenticateSession(session.token)).toBe(false);
        expect(await auth.beginAuthentication(binding)).toEqual({
          ok: false,
          error: "invalid-credentials",
        });
      } finally {
        repository?.close();
      }
    });
  });

  test("explicit reset removes the credential when storage identity is incompatible", async () => {
    await withTempDirectory(
      "technical-admin-restore-reset-incompatible-focused-",
      async (directory) => {
        const databasePath = join(directory, "auth.sqlite");
        let repository: SqliteTechnicalAdminAuthRepository | undefined;
        try {
          repository = new SqliteTechnicalAdminAuthRepository(databasePath, identity);
          const { auth, session } = await enrollAndAuthenticate(repository, () => 1_000);
          repository.issueEnrollment("pending-enrollment", 61_000);
          const pending = await auth.beginAuthentication(binding);
          if (!pending.ok) throw new Error("Expected pending authentication challenge.");
          repository.close();
          repository = new SqliteTechnicalAdminAuthRepository(databasePath);
          const incompatibleAuth = createTechnicalAdminAuth(
            { environment: "test", origin: "https://localhost:49421", rpId: "localhost" },
            repository,
            createVerifier(),
            () => 2_000,
          );

          expect(
            await incompatibleAuth.prepareForFoundationRestore({ mode: "explicit-reset" }),
          ).toEqual({
            outcome: "re-enrollment-required",
            reason: "explicit-reset",
          });
          expect(repository.getCredential()).toBeNull();
          expect(incompatibleAuth.authenticateSession(session.token)).toBe(false);
          expect(incompatibleAuth.issueEnrollmentAuthorization().ok).toBe(true);
        } finally {
          repository?.close();
        }
      },
    );
  });

  test("rolls back an incompatible explicit reset when credential deletion fails", async () => {
    await withTempDirectory(
      "technical-admin-restore-reset-rollback-focused-",
      async (directory) => {
        const databasePath = join(directory, "auth.sqlite");
        let repository: SqliteTechnicalAdminAuthRepository | undefined;
        try {
          repository = new SqliteTechnicalAdminAuthRepository(databasePath, identity);
          const { auth, session } = await enrollAndAuthenticate(repository, () => 1_000);
          repository.issueEnrollment("pending-enrollment", 61_000);
          const pending = await auth.beginAuthentication(binding);
          if (!pending.ok) throw new Error("Expected pending authentication challenge.");
          repository.close();
          repository = new SqliteTechnicalAdminAuthRepository(databasePath);
          const incompatibleAuth = createTechnicalAdminAuth(
            { environment: "test", origin: "https://localhost:49421", rpId: "localhost" },
            repository,
            createVerifier(),
            () => 2_000,
          );
          repository.database.exec(
            "CREATE TRIGGER fail_restore_credential_delete BEFORE DELETE ON technical_admin_credentials BEGIN SELECT RAISE(ABORT, 'injected restore delete failure'); END",
          );

          expect(
            await incompatibleAuth.prepareForFoundationRestore({ mode: "explicit-reset" }),
          ).toEqual({
            outcome: "sanitation-failed",
          });
          expect(repository.getCredential()).not.toBeNull();
          expect(incompatibleAuth.authenticateSession(session.token)).toBe(true);
          expect(
            Number(
              (
                repository.database
                  .query("SELECT COUNT(*) AS count FROM technical_admin_challenges")
                  .get() as { count: number }
              ).count,
            ),
          ).toBeGreaterThan(0);
          expect(
            Number(
              (
                repository.database
                  .query("SELECT COUNT(*) AS count FROM technical_admin_enrollment")
                  .get() as { count: number }
              ).count,
            ),
          ).toBeGreaterThan(0);
        } finally {
          repository?.close();
        }
      },
    );
  });

  test("classifies readable incompatible storage without preserving authority", async () => {
    await withTempDirectory("technical-admin-restore-incompatible-focused-", async (directory) => {
      const databasePath = join(directory, "auth.sqlite");
      let repository: SqliteTechnicalAdminAuthRepository | undefined;
      try {
        repository = new SqliteTechnicalAdminAuthRepository(databasePath, identity);
        const { session } = await enrollAndAuthenticate(repository, () => 1_000);
        repository.close();
        repository = new SqliteTechnicalAdminAuthRepository(databasePath);
        const incompatibleAuth = createTechnicalAdminAuth(
          { environment: "test", origin: "https://localhost:49421", rpId: "localhost" },
          repository,
          createVerifier(),
          () => 2_000,
        );

        expect(
          await incompatibleAuth.prepareForFoundationRestore({
            mode: "preserve-compatible-credential",
          }),
        ).toEqual({ outcome: "re-enrollment-required", reason: "incompatible" });
        expect(incompatibleAuth.authenticateSession(session.token)).toBe(false);
      } finally {
        repository?.close();
      }
    });
  });

  test("does not adopt a missing storage identity for an existing credential store", async () => {
    await withTempDirectory(
      "technical-admin-restore-missing-identity-focused-",
      async (directory) => {
        const databasePath = join(directory, "auth.sqlite");
        let repository: SqliteTechnicalAdminAuthRepository | undefined;
        try {
          repository = new SqliteTechnicalAdminAuthRepository(databasePath, identity);
          await enrollAndAuthenticate(repository, () => 1_000);
          repository.close();
          const database = new Database(databasePath);
          database.query("DELETE FROM technical_admin_storage_identity").run();
          database.close();

          repository = new SqliteTechnicalAdminAuthRepository(databasePath, identity);
          const auth = createTechnicalAdminAuth(
            identity,
            repository,
            createVerifier(),
            () => 2_000,
          );
          expect(
            await auth.prepareForFoundationRestore({ mode: "preserve-compatible-credential" }),
          ).toEqual({ outcome: "re-enrollment-required", reason: "incompatible" });
        } finally {
          repository?.close();
        }
      },
    );
  });

  test("fails closed without mutation for read-only and unreadable stores", async () => {
    await withTempDirectory("technical-admin-restore-failure-focused-", async (directory) => {
      const readOnlyPath = join(directory, "readonly.sqlite");
      let writable: SqliteTechnicalAdminAuthRepository | undefined;
      let readOnly: SqliteTechnicalAdminAuthRepository | undefined;
      let unreadable: SqliteTechnicalAdminAuthRepository | undefined;
      try {
        writable = new SqliteTechnicalAdminAuthRepository(readOnlyPath, identity);
        await enrollAndAuthenticate(writable, () => 1_000);
        writable.close();
        writable = undefined;
        readOnly = new SqliteTechnicalAdminAuthRepository(readOnlyPath, undefined, {
          readwrite: false,
        });
        const readOnlyAuth = createTechnicalAdminAuth(
          identity,
          readOnly,
          createVerifier(),
          () => 2_000,
        );
        expect(
          await readOnlyAuth.prepareForFoundationRestore({
            mode: "preserve-compatible-credential",
          }),
        ).toEqual({ outcome: "sanitation-failed" });

        const unreadablePath = join(directory, "unreadable.sqlite");
        const initialized = new SqliteTechnicalAdminAuthRepository(unreadablePath, identity);
        initialized.close();
        const database = new Database(unreadablePath);
        database.exec("DROP TABLE technical_admin_credentials");
        database.close();
        unreadable = new SqliteTechnicalAdminAuthRepository(unreadablePath, undefined, {
          readwrite: false,
        });
        const unreadableAuth = createTechnicalAdminAuth(
          identity,
          unreadable,
          createVerifier(),
          () => 2_000,
        );
        expect(
          await unreadableAuth.prepareForFoundationRestore({
            mode: "preserve-compatible-credential",
          }),
        ).toEqual({ outcome: "sanitation-failed" });
      } finally {
        writable?.close();
        readOnly?.close();
        unreadable?.close();
      }
    });
  });

  test("persists purpose-bound step-up and its authenticator counter across restart", async () => {
    await withTempDirectory("technical-admin-focused-", async (directory) => {
      const databasePath = join(directory, "auth.sqlite");
      let nowMs = 1_000;
      let first: SqliteTechnicalAdminAuthRepository | undefined;
      let restarted: SqliteTechnicalAdminAuthRepository | undefined;
      try {
        first = new SqliteTechnicalAdminAuthRepository(databasePath, identity);
        const { auth, session } = await enrollAndAuthenticate(first, () => nowMs);
        const stepUp = auth.beginFreshVerification(session.token, "replace-credential", binding);
        if (!stepUp.ok) throw new Error("Expected replacement step-up options.");
        expect(
          await auth.completeFreshVerification(
            session.token,
            stepUp.value.challengeId,
            {},
            binding,
          ),
        ).toEqual({ ok: true, value: undefined });
        expect(first.getCredential()?.signCount).toBe(3);
        first.close();
        first = undefined;

        restarted = new SqliteTechnicalAdminAuthRepository(databasePath, identity);
        const restartedAuth = createTechnicalAdminAuth(
          identity,
          restarted,
          createVerifier(),
          () => nowMs,
        );
        expect(restarted.getCredential()?.signCount).toBe(3);
        expect(restartedAuth.authenticateSession(session.token)).toBe(true);
        expect(restartedAuth.beginReplacement(session.token, binding).ok).toBe(true);
      } finally {
        first?.close();
        restarted?.close();
      }
    });
  });

  test("rolls back the fresh counter when the session commit cannot complete", async () => {
    await withTempDirectory("technical-admin-counter-focused-", async (directory) => {
      const databasePath = join(directory, "auth.sqlite");
      let repository: SqliteTechnicalAdminAuthRepository | undefined;
      try {
        repository = new SqliteTechnicalAdminAuthRepository(databasePath, identity);
        const { auth, session } = await enrollAndAuthenticate(repository, () => 1_000);
        const stepUp = auth.beginFreshVerification(session.token, "replace-credential", binding);
        if (!stepUp.ok) throw new Error("Expected replacement step-up options.");
        const authority = auth.resolveCurrentAuthority(session.token);
        if (!authority) throw new Error("Expected current authority.");
        expect(
          repository.consumeChallenge(
            stepUp.value.challengeId,
            "fresh-verification",
            1_000,
            authority.sessionId,
          ),
        ).not.toBeNull();
        const before = repository.getCredential()?.signCount;
        repository.revokeSession(authority.sessionId, 1_000);
        expect(repository.commitFreshVerification(stepUp.value.challengeId, 3, 1_000)).toBe(false);
        expect(repository.getCredential()?.signCount).toBe(before);
      } finally {
        repository?.close();
      }
    });
  });

  test("fails closed for corrupt and read-only reset storage", () => {
    return withTempDirectory("technical-admin-corrupt-focused-", (directory) => {
      const corruptPath = join(directory, "corrupt.sqlite");
      let reopened: SqliteTechnicalAdminAuthRepository | undefined;
      let readOnly: SqliteTechnicalAdminAuthRepository | undefined;
      try {
        const corrupt = new SqliteTechnicalAdminAuthRepository(corruptPath, identity);
        corrupt.close();
        insertCredential(corruptPath, 2);
        reopened = new SqliteTechnicalAdminAuthRepository(corruptPath, identity);
        const auth = createTechnicalAdminAuth(identity, reopened, createVerifier(), () => 1_000);
        expect(auth.storageStatus().state).toBe("corrupt");
        expect(auth.emergencyReset()).toEqual({ ok: false, error: "storage-failure" });
        reopened.close();
        reopened = undefined;

        const readOnlyPath = join(directory, "readonly.sqlite");
        const writable = new SqliteTechnicalAdminAuthRepository(readOnlyPath, identity);
        writable.close();
        insertCredential(readOnlyPath);
        readOnly = new SqliteTechnicalAdminAuthRepository(readOnlyPath, identity, {
          readwrite: false,
        });
        expect(readOnly.getStorageStatus(1_000).state).toBe("read-only");
        const readOnlyAuth = createTechnicalAdminAuth(
          identity,
          readOnly,
          createVerifier(),
          () => 1_000,
        );
        expect(readOnlyAuth.emergencyReset()).toEqual({ ok: false, error: "storage-failure" });
      } finally {
        reopened?.close();
        readOnly?.close();
      }
    });
  });

  test("removes quiet-period telemetry past the 30-day boundary", () => {
    return withTempDirectory("technical-admin-retention-focused-", (directory) => {
      const databasePath = join(directory, "auth.sqlite");
      const repository = new SqliteTechnicalAdminAuthRepository(databasePath, identity);
      let nowMs = 1_000;
      const auth = createTechnicalAdminAuth(identity, repository, createVerifier(), () => nowMs);
      const manual = createManualRetentionScheduler(() => nowMs);
      try {
        repository.appendOperationalLog({
          atMs: 1_000,
          event: "logout",
          outcome: "accepted",
          environment: "test",
          generation: 0,
          sessionReference: null,
          sourceCorrelation: null,
        });
        repository.appendAlert({
          atMs: 1_000,
          event: "unsafe-storage",
          environment: "test",
          generation: 0,
          sourceCorrelation: null,
        });
        auth.startRetentionMaintenance(manual.scheduler);
        expect(manual.pendingCount()).toBe(1);
        nowMs += technicalAdminSessionTtls().logRetentionMs;
        manual.runDue();
        expect(
          repository.database
            .query("SELECT COUNT(*) AS count FROM technical_admin_operational_logs")
            .get(),
        ).toEqual({
          count: 0,
        });
        expect(
          repository.database.query("SELECT COUNT(*) AS count FROM technical_admin_alerts").get(),
        ).toEqual({
          count: 0,
        });
        expect(manual.pendingCount()).toBe(0);
      } finally {
        auth.close();
        repository.close();
      }
    });
  });

  test("bootstrap reset requires confirmation, fails safely, and emits URL only after commit", async () => {
    await withTempDirectory("technical-admin-cli-focused-", async (directory) => {
      const mismatchPath = join(directory, "mismatch.sqlite");
      const mismatchRepository = new SqliteTechnicalAdminAuthRepository(mismatchPath, identity);
      const mismatchAuth = createTechnicalAdminAuth(
        identity,
        mismatchRepository,
        createVerifier(),
        () => 1_000,
      );
      const mismatch = createTechnicalAdminBootstrapOperations(identity, mismatchAuth).reset(
        "wrong",
      );
      expect(mismatch).toEqual({ ok: false, error: "invalid-confirmation" });
      mismatchRepository.close();

      const successPath = join(directory, "success.sqlite");
      const successRepository = new SqliteTechnicalAdminAuthRepository(successPath, identity);
      successRepository.close();
      insertCredential(successPath);
      const afterSuccess = new SqliteTechnicalAdminAuthRepository(successPath, identity);
      const successAuth = createTechnicalAdminAuth(
        identity,
        afterSuccess,
        createVerifier(),
        () => 1_000,
      );
      const success = createTechnicalAdminBootstrapOperations(identity, successAuth).reset("test");
      expect(success.ok).toBe(true);
      if (success.ok)
        expect(success.value.url).toContain("https://localhost:39421/admin/enroll#token=");
      expect(afterSuccess.getCredential()).toBeNull();
      afterSuccess.close();

      const corruptPath = join(directory, "unsafe.sqlite");
      const unsafeRepository = new SqliteTechnicalAdminAuthRepository(corruptPath, identity);
      unsafeRepository.close();
      insertCredential(corruptPath, 2);
      const unsafe = new SqliteTechnicalAdminAuthRepository(corruptPath, identity);
      const unsafeAuth = createTechnicalAdminAuth(identity, unsafe, createVerifier(), () => 1_000);
      expect(createTechnicalAdminBootstrapOperations(identity, unsafeAuth).reset("test")).toEqual({
        ok: false,
        error: "storage-failure",
      });
      unsafe.close();

      const readOnlyPath = join(directory, "readonly-cli.sqlite");
      const readOnlyRepository = new SqliteTechnicalAdminAuthRepository(readOnlyPath, identity);
      readOnlyRepository.close();
      insertCredential(readOnlyPath);
      chmodSync(readOnlyPath, 0o444);
      try {
        const readOnly = new SqliteTechnicalAdminAuthRepository(readOnlyPath, identity, {
          readwrite: false,
        });
        const readOnlyAuth = createTechnicalAdminAuth(
          identity,
          readOnly,
          createVerifier(),
          () => 1_000,
        );
        expect(
          createTechnicalAdminBootstrapOperations(identity, readOnlyAuth).reset("test"),
        ).toEqual({ ok: false, error: "storage-failure" });
        readOnly.close();
      } finally {
        chmodSync(readOnlyPath, 0o600);
      }
    });
  });
});
