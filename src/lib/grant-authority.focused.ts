import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGrantAuthority,
  type ControlGrantScope,
  type GrantAuthority,
  type GrantKeyRing,
} from "@/lib/grant-authority";
import {
  createGrantTestKeyRing,
  createGrantTestCurrentOnlyKeyRing,
  createGrantTestRandomness,
  createGrantTestRotatedKeyRing,
  createGrantTestScope,
  registerGrantAuthorityContract,
  type GrantAuthorityContractStorage,
} from "@/lib/grant-authority-contract";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import {
  buildGrantAdmissionWorkerCommand,
  createGrantAdmissionWorkerEnvironment,
  superviseGrantAdmissionWorkers,
  writePrivateGrantCredential,
} from "@/lib/grant-concurrency-process";
import {
  installProbeSignalHandlers,
  spawnProbeCommand,
} from "@/lib/sqlite-foundation-probe-process";

describe("focused SQLite Grant authority boundary", () => {
  registerGrantAuthorityContract(test, createStorage);

  test("redacts credentials from SQLite and preserves lifecycle across restart", async () => {
    const handle = await createStorage();
    const databasePath = handle.databasePath;
    const first = handle.storage;
    try {
      const authority = createAuthority(first, createGrantTestRandomness());
      const created = await createGrant(authority);
      const admitted = await admit(authority, created.qrCredential, "browser-a");
      assertSQLiteSecretsAreRedacted(databasePath, created.qrCredential, admitted.sessionBearer);
      first.close();

      const reopened = openSqliteFoundationStorage(databasePath);
      try {
        const reopenedAuthority = createAuthority(reopened, createGrantTestRandomness());
        expect(
          await reopenedAuthority.revealControlGrant(created.grantId, createActor()),
        ).toMatchObject({ status: "revealed", grantId: created.grantId });
        const readmitted = await admit(reopenedAuthority, created.qrCredential, "browser-b");
        expect(
          await reopenedAuthority.authorizeControlGrant({
            sessionBearer: readmitted.sessionBearer,
          }),
        ).toMatchObject({ status: "authorized", grantId: created.grantId });
      } finally {
        reopened.close();
      }
    } finally {
      await handle.cleanup();
    }
  });

  test("persists cryptographic erasure through raw SQLite rows and restart", async () => {
    let nowMs = 1_000;
    const handle = await createStorage();
    const authority = createAuthority(
      handle.storage,
      createGrantTestRandomness(),
      createGrantTestKeyRing(),
      () => nowMs,
    );
    try {
      const created = await createGrant(authority, 1_100);
      const admitted = await admit(authority, created.qrCredential, "browser-erasure");
      nowMs = 1_100;
      const auditResult = await authority.listGrantAudit(created.grantId);
      expect(auditResult.status).toBe("ok");
      if (auditResult.status !== "ok") throw new Error("Expected audit read evidence.");
      expect(auditResult.value.filter((entry) => entry.action === "grant-expired")).toHaveLength(1);
      assertSQLiteGrantSecretsAreErased(
        handle.databasePath,
        created.grantId,
        admitted.grantSessionId,
      );
      handle.storage.close();

      const reopened = openSqliteFoundationStorage(handle.databasePath);
      try {
        const reopenedAuthority = createAuthority(
          reopened,
          createGrantTestRandomness(),
          createGrantTestKeyRing(),
          () => nowMs,
        );
        const reopenedAudit = await reopenedAuthority.listGrantAudit(created.grantId);
        expect(reopenedAudit.status).toBe("ok");
        if (reopenedAudit.status !== "ok") throw new Error("Expected restarted audit evidence.");
        expect(
          reopenedAudit.value.filter((entry) => entry.action === "grant-expired"),
        ).toHaveLength(1);
        assertSQLiteGrantSecretsAreErased(
          handle.databasePath,
          created.grantId,
          admitted.grantSessionId,
        );
      } finally {
        reopened.close();
      }
    } finally {
      await handle.cleanup();
    }
  });

  test("persists atomic credential key rotation across restart", async () => {
    const handle = await createStorage();
    const originalKeyRing = createGrantTestKeyRing();
    const rotatedKeyRing = createGrantTestRotatedKeyRing(originalKeyRing);
    try {
      const original = createAuthority(
        handle.storage,
        createGrantTestRandomness(),
        originalKeyRing,
      );
      const created = await createGrant(original);
      handle.storage.close();

      const rotatingStorage = openSqliteFoundationStorage(handle.databasePath);
      const rotating = createAuthority(
        rotatingStorage,
        createGrantTestRandomness(20),
        rotatedKeyRing,
      );
      expect(
        await rotating.rotateControlGrantCredentialKeys(created.grantId, createActor()),
      ).toMatchObject({
        status: "rotated",
        encryptionKeyVersion: "encryption-v2",
        lookupKeyVersion: "lookup-v2",
      });
      rotatingStorage.close();

      const reopened = openSqliteFoundationStorage(handle.databasePath);
      try {
        const currentOnly = createAuthority(
          reopened,
          createGrantTestRandomness(40),
          createGrantTestCurrentOnlyKeyRing(rotatedKeyRing),
        );
        expect(
          await admit(currentOnly, created.qrCredential, "browser-after-rotation"),
        ).toMatchObject({ grantId: created.grantId });
        const audit = await currentOnly.listGrantAudit(created.grantId);
        expect(audit.status).toBe("ok");
        if (audit.status !== "ok") throw new Error("Expected rotation audit evidence.");
        expect(audit.value.filter((entry) => entry.action === "credential-rotated")).toHaveLength(
          1,
        );
        expect(JSON.stringify(audit)).not.toContain(created.qrCredential);
        const database = new Database(handle.databasePath);
        try {
          expect(
            database
              .query(
                `SELECT encryption_key_version, lookup_key_version
                 FROM foundation_grant_roots WHERE grant_id = ?`,
              )
              .get(created.grantId),
          ).toEqual({ encryption_key_version: "encryption-v2", lookup_key_version: "lookup-v2" });
        } finally {
          database.close();
        }
      } finally {
        reopened.close();
      }
    } finally {
      await handle.cleanup();
    }
  });

  test("serializes concurrent same-context admission across independent SQLite instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-timer-grant-concurrent-"));
    const databasePath = join(directory, "foundation.sqlite");
    const creator = openSqliteFoundationStorage(databasePath);
    try {
      await creator.applyMigrations();
      const created = await createGrant(createAuthority(creator, createGrantTestRandomness(1)));
      creator.close();
      const readyPaths = [join(directory, "worker-a.ready"), join(directory, "worker-b.ready")];
      const startPath = join(directory, "workers.start");
      const credentialPath = join(directory, "credential.private");
      const workerPath = join(import.meta.dir, "grant-authority-concurrent-worker.ts");
      await writePrivateGrantCredential(credentialPath, created.qrCredential);
      const environment = createGrantAdmissionWorkerEnvironment(directory);
      const commands = [10, 20].map((seed, index) =>
        buildGrantAdmissionWorkerCommand({
          executablePath: process.execPath,
          workerPath,
          databasePath,
          readyPath: readyPaths[index] ?? join(directory, `worker-${index}.ready`),
          startPath,
          credentialPath,
          seed,
        }),
      );
      expect(JSON.stringify({ commands, environment })).not.toContain(created.qrCredential);
      const workers = commands.map((command) =>
        spawnProbeCommand(command, { env: environment, detached: true }),
      );
      const signals = installProbeSignalHandlers();
      try {
        const workerResults = await superviseGrantAdmissionWorkers({
          workers,
          readyPaths,
          startPath,
          artifactPaths: [...readyPaths, startPath, credentialPath],
          signal: signals.signal,
        });
        expect(workers.every((worker) => worker.process.exitCode !== null)).toBe(true);
        const results = workerResults.map(
          (result) => JSON.parse(result.stdout) as WorkerAdmissionResult,
        );
        expect(await Bun.file(credentialPath).exists()).toBe(false);
        const leftResult = results[0];
        const rightResult = results[1];
        expect(leftResult?.status).toBe("admitted");
        expect(rightResult?.status).toBe("admitted");
        if (leftResult?.status !== "admitted" || rightResult?.status !== "admitted") {
          throw new Error("Expected both concurrent admissions to commit.");
        }

        const reader = openSqliteFoundationStorage(databasePath);
        try {
          const readerAuthority = createAuthority(reader, createGrantTestRandomness(30));
          const sessionsResult = await readerAuthority.listGrantSessions(created.grantId);
          expect(sessionsResult.status).toBe("ok");
          if (sessionsResult.status !== "ok") throw new Error("Expected session read evidence.");
          const sessions = sessionsResult.value;
          const active = sessions.filter((session) => session.status === "active");
          expect(active).toHaveLength(1);
          const admittedIds = new Set([leftResult.grantSessionId, rightResult.grantSessionId]);
          expect(admittedIds).toHaveLength(2);
          expect(admittedIds.has(active[0]?.sessionId ?? "")).toBe(true);
          const revoked = sessions.find((session) => session.status === "revoked");
          expect(revoked).toBeDefined();
          const auditResult = await readerAuthority.listGrantAudit(created.grantId);
          expect(auditResult.status).toBe("ok");
          if (auditResult.status !== "ok") throw new Error("Expected audit read evidence.");
          const audit = auditResult.value;
          expect(audit).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ action: "session-admitted" }),
              expect.objectContaining({
                action: "session-replaced",
                replacedSessionId: revoked?.sessionId,
              }),
            ]),
          );
        } finally {
          reader.close();
        }
      } finally {
        signals.cleanup();
      }
    } finally {
      creator.close();
      await rm(directory, { recursive: true, force: true });
      expect(existsSync(directory)).toBe(false);
    }
  });
});

type WorkerAdmissionResult = { status: string; grantSessionId?: string };

type SqliteGrantStorage = GrantAuthorityContractStorage & { databasePath: string };

async function createStorage(): Promise<SqliteGrantStorage> {
  const directory = await mkdtemp(join(tmpdir(), "quadball-timer-grant-focused-"));
  const databasePath = join(directory, "foundation.sqlite");
  const storage = openSqliteFoundationStorage(databasePath);
  try {
    await storage.applyMigrations();
  } catch (error) {
    storage.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    storage,
    databasePath,
    cleanup: async () => {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function createAuthority(
  storage: SqliteGrantStorage["storage"],
  randomness: ReturnType<typeof createGrantTestRandomness>,
  keyRing: GrantKeyRing = createGrantTestKeyRing(),
  nowMs: () => number = () => 1_000,
): GrantAuthority {
  return createGrantAuthority(storage, {
    environmentId: "test-environment",
    clock: { nowMs },
    randomness,
    keyRing,
    controlScopeResolver: {
      resolve(scope: ControlGrantScope) {
        expect(scope).toEqual(createGrantTestScope());
        return { status: "eligible", eventGameId: "game-1" };
      },
    },
  });
}

async function createGrant(authority: GrantAuthority, expiresAtMs?: number) {
  const result = await authority.createControlGrant({
    scope: createGrantTestScope(),
    actor: createActor(),
    expiresAtMs,
  });
  expect(result.status).toBe("created");
  if (result.status !== "created") throw new Error("Expected a created Control Grant.");
  return result;
}

function assertSQLiteGrantSecretsAreErased(
  databasePath: string,
  grantId: string,
  sessionId: string,
): void {
  const database = new Database(databasePath);
  try {
    const grant = database
      .query(
        `SELECT credential_material_state, encryption_key_version, lookup_key_version,
                credential_iv, credential_ciphertext, credential_tag,
                credential_lookup_digest, credential_fingerprint
         FROM foundation_grant_roots WHERE grant_id = ?`,
      )
      .get(grantId) as Record<string, unknown> | null;
    expect(grant).toMatchObject({
      credential_material_state: "erased",
      encryption_key_version: null,
      lookup_key_version: null,
      credential_iv: null,
      credential_ciphertext: null,
      credential_tag: null,
      credential_lookup_digest: null,
    });
    expect(typeof grant?.credential_fingerprint).toBe("string");
    const session = database
      .query(
        `SELECT bearer_material_state, bearer_lookup_verifier, bearer_lookup_key_version
         FROM foundation_grant_sessions WHERE session_id = ?`,
      )
      .get(sessionId) as Record<string, unknown> | null;
    expect(session).toEqual({
      bearer_material_state: "erased",
      bearer_lookup_verifier: null,
      bearer_lookup_key_version: null,
    });
  } finally {
    database.close();
  }
}

async function admit(authority: GrantAuthority, qrCredential: string, browserContext: string) {
  const result = await authority.admitControlGrant({ qrCredential, browserContext });
  expect(result.status).toBe("admitted");
  if (result.status !== "admitted") throw new Error("Expected an admitted Grant Session.");
  return result;
}

function createActor() {
  return { kind: "fixture" as const, id: "fixture-authority" };
}

function assertSQLiteSecretsAreRedacted(
  databasePath: string,
  qrCredential: string,
  sessionBearer: string,
): void {
  const database = new Database(databasePath);
  try {
    const serialized = JSON.stringify({
      grants: database.query("SELECT * FROM foundation_grant_roots").all(),
      sessions: database.query("SELECT * FROM foundation_grant_sessions").all(),
      audit: database.query("SELECT * FROM foundation_grant_audit").all(),
    });
    expect(serialized).not.toContain(qrCredential);
    expect(serialized).not.toContain(sessionBearer);
  } finally {
    database.close();
  }
}
