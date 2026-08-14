import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checksumMigrationSql,
  FOUNDATION_MIGRATIONS,
  type FoundationMigration,
} from "@/lib/foundation-migrations";
import {
  FoundationMigrationError,
  openSqliteFoundationStorage,
} from "@/lib/foundation-storage-sqlite";

async function withDatabase<T>(work: (databasePath: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "quadball-timer-grant-migration-"));
  try {
    return await work(join(directory, "foundation.sqlite"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("Grant cryptographic erasure migration", () => {
  test("upgrades the accepted Grant schema while preserving legacy rows safely", async () => {
    await withDatabase(async (databasePath) => {
      const legacy = openSqliteFoundationStorage(databasePath, {
        migrations: FOUNDATION_MIGRATIONS.slice(0, 5),
      });
      await legacy.applyMigrations({ requireCandidate: false });
      legacy.close();

      const database = new Database(databasePath);
      database
        .query(
          `INSERT INTO foundation_grant_roots (
             grant_id, grant_type, grant_version, event_id, game_day_id, pitch_id, pitch_slot_id,
             status, created_at_ms, expires_at_ms, credential_format_version, credential_kind,
             encryption_key_version, lookup_key_version, credential_iv, credential_ciphertext,
             credential_tag, credential_lookup_digest, credential_fingerprint
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "grant-legacy",
          "control",
          "grant-version-legacy",
          "event-1",
          "day-1",
          "pitch-1",
          "slot-legacy",
          "active",
          1_000,
          null,
          1,
          "qr",
          "encryption-v1",
          "lookup-v1",
          "iv-legacy",
          "ciphertext-legacy",
          "tag-legacy",
          "lookup-legacy",
          "lookup-legacy",
        );
      database
        .query(
          `INSERT INTO foundation_grant_sessions (
             session_id, grant_id, grant_version, event_game_id, browser_context_digest,
             browser_context_key_version, bearer_lookup_verifier, bearer_lookup_key_version,
             status, created_at_ms, last_active_at_ms, revoked_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "session-legacy",
          "grant-legacy",
          "grant-version-legacy",
          "game-1",
          "browser-legacy",
          "lookup-v1",
          "bearer-legacy",
          "lookup-v1",
          "active",
          1_000,
          1_000,
          null,
        );
      database
        .query(
          `INSERT INTO foundation_grant_audit (
             audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
             event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
             event_game_id, credential_kind, credential_fingerprint, before_status, after_status,
             created_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "audit-legacy-created",
          "grant-created",
          "accepted",
          "actor-legacy",
          "grant-legacy",
          "control",
          "grant-version-legacy",
          "event-1",
          "day-1",
          "pitch-1",
          "slot-legacy",
          null,
          null,
          null,
          "qr",
          "lookup-legacy",
          null,
          "active",
          1_000,
        );
      database
        .query(
          `INSERT INTO foundation_grant_audit (
             audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
             event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
             event_game_id, credential_kind, credential_fingerprint, before_status, after_status,
             created_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "audit-legacy-session",
          "session-admitted",
          "accepted",
          "actor-legacy",
          "grant-legacy",
          "control",
          "grant-version-legacy",
          "event-1",
          "day-1",
          "pitch-1",
          "slot-legacy",
          "session-legacy",
          null,
          "game-1",
          "qr",
          null,
          null,
          null,
          1_000,
        );
      database.close();

      const current = openSqliteFoundationStorage(databasePath);
      await current.applyMigrations({ requireCandidate: false });
      const state = await current.transaction((transaction) => ({
        grant: transaction.findGrantById("grant-legacy"),
        sessions: transaction.listGrantSessions("grant-legacy"),
        audit: transaction.listGrantAudit("grant-legacy"),
      }));
      expect(state.grant?.credential.materialState).toBe("present");
      expect(state.grant?.credential.fingerprint).toMatch(
        /^opaque-migration-reference-v1:[a-f0-9]{64}$/,
      );
      expect(state.grant?.credential.fingerprint).not.toBe(state.grant?.credential.lookupDigest);
      expect(state.grant?.credential.fingerprint).not.toContain("lookup-legacy");
      expect(state.sessions[0]?.bearerMaterialState).toBe("present");
      expect(state.audit).toEqual([
        expect.objectContaining({
          auditId: "audit-legacy-created",
          action: "grant-created",
          actorReference: "actor-legacy",
          credentialFingerprint: null,
        }),
        expect.objectContaining({
          auditId: "audit-legacy-session",
          action: "session-admitted",
          sessionId: "session-legacy",
          eventGameId: "game-1",
        }),
      ]);
      current.close();
    });
  });

  test("erases due legacy Grants without losing or duplicating audit evidence", async () => {
    await withDatabase(async (databasePath) => {
      const legacy = openSqliteFoundationStorage(databasePath, {
        migrations: FOUNDATION_MIGRATIONS.slice(0, 5),
      });
      await legacy.applyMigrations({ requireCandidate: false });
      legacy.close();

      const database = new Database(databasePath);
      const seeds: LegacyGrantSeed[] = [
        { suffix: "active", status: "active", expiresAtMs: null },
        {
          suffix: "active-keyed",
          status: "active",
          expiresAtMs: null,
          credentialFingerprint: "keyed-fingerprint-active",
        },
        {
          suffix: "disabled-due-keyed",
          status: "disabled",
          expiresAtMs: 2_000,
          credentialFingerprint: "keyed-fingerprint-disabled-due",
        },
        { suffix: "disabled-due", status: "disabled", expiresAtMs: 2_000 },
        { suffix: "revoked-due", status: "revoked", expiresAtMs: 2_000 },
        { suffix: "expired", status: "expired", expiresAtMs: 2_000 },
      ];
      for (const seed of seeds) seedLegacyGrant(database, seed);
      database.close();

      const current = openSqliteFoundationStorage(databasePath);
      await current.applyMigrations({ requireCandidate: false });
      expect(await current.readiness()).toMatchObject({ ok: true, schemaVersion: "14" });
      current.close();

      const raw = new Database(databasePath);
      const grants = raw
        .query("SELECT * FROM foundation_grant_roots ORDER BY grant_id")
        .all() as Record<string, unknown>[];
      const sessions = raw
        .query("SELECT * FROM foundation_grant_sessions ORDER BY session_id")
        .all() as Record<string, unknown>[];
      const audit = raw
        .query("SELECT * FROM foundation_grant_audit ORDER BY grant_id, audit_id")
        .all() as Record<string, unknown>[];

      const active = grants.find((row) => row.grant_id === "grant-active");
      expect(active).toMatchObject({
        status: "active",
        credential_material_state: "present",
        credential_lookup_digest: "digest-active",
      });
      for (const suffix of ["disabled-due", "revoked-due", "expired"]) {
        const grant = grants.find((row) => row.grant_id === `grant-${suffix}`);
        expect(grant).toMatchObject({
          status: "expired",
          credential_material_state: "erased",
          encryption_key_version: null,
          lookup_key_version: null,
          credential_iv: null,
          credential_ciphertext: null,
          credential_tag: null,
          credential_lookup_digest: null,
        });
        const session = sessions.find((row) => row.grant_id === `grant-${suffix}`);
        expect(session).toMatchObject({
          status: "expired",
          bearer_material_state: "erased",
          bearer_lookup_verifier: null,
          bearer_lookup_key_version: null,
        });
        expect(JSON.stringify({ grant, session })).not.toContain(`digest-${suffix}`);
      }

      for (const seed of seeds) {
        const grant = grants.find((row) => row.grant_id === `grant-${seed.suffix}`);
        const grantAudit = audit.filter((row) => row.grant_id === `grant-${seed.suffix}`);
        expect(grantAudit.filter((row) => row.action === "grant-created")).toHaveLength(1);
        if (seed.credentialFingerprint === undefined) {
          const fingerprint = grant?.credential_fingerprint;
          expect(fingerprint).toMatch(/^opaque-migration-reference-v1:[a-f0-9]{64}$/);
          expect(String(fingerprint)).not.toContain(`digest-${seed.suffix}`);
          expect(grantAudit.every((row) => row.credential_fingerprint === null)).toBe(true);
        } else {
          expect(grant?.credential_fingerprint).toBe(seed.credentialFingerprint);
          expect(
            grantAudit
              .filter((row) => row.action !== "session-admitted")
              .every((row) => row.credential_fingerprint === seed.credentialFingerprint),
          ).toBe(true);
          if (seed.expiresAtMs !== null) {
            expect(grantAudit.find((row) => row.action === "grant-expired")).toMatchObject({
              session_id: null,
              replaced_session_id: null,
              event_game_id: null,
              credential_fingerprint: seed.credentialFingerprint,
            });
          }
        }
        expect(JSON.stringify(grantAudit)).not.toContain(`digest-${seed.suffix}`);
        expect(grantAudit.filter((row) => row.action === "grant-expired")).toHaveLength(
          seed.status === "active" && seed.expiresAtMs === null ? 0 : 1,
        );
      }
      expect(audit).toHaveLength(21);
      const provenanceColumns = raw
        .query("PRAGMA table_info('foundation_grant_migration_provenance')")
        .all() as { name?: string }[];
      expect(provenanceColumns.some((column) => column.name === "original_lookup_digest")).toBe(
        false,
      );
      expect(
        raw
          .query(
            "SELECT credential_lookup_digest FROM foundation_grant_roots WHERE grant_id = 'grant-expired'",
          )
          .get(),
      ).toEqual({ credential_lookup_digest: null });
      expect(
        JSON.stringify(
          raw
            .query(
              "SELECT retained_opaque_reference FROM foundation_grant_migration_provenance WHERE grant_id = 'grant-expired'",
            )
            .get(),
        ),
      ).not.toContain("digest-expired");
      expect(() =>
        raw
          .query(
            `UPDATE foundation_grant_roots SET
               credential_material_state = 'present', encryption_key_version = 'old',
               lookup_key_version = 'old', credential_iv = 'old',
               credential_ciphertext = 'old', credential_tag = 'old',
               credential_lookup_digest = 'old'
             WHERE grant_id = 'grant-expired'`,
          )
          .run(),
      ).toThrow();
      expect(() =>
        raw
          .query(
            `UPDATE foundation_grant_sessions SET
               bearer_material_state = 'present', bearer_lookup_verifier = 'old',
               bearer_lookup_key_version = 'old'
             WHERE session_id = 'session-expired'`,
          )
          .run(),
      ).toThrow();
      raw.close();

      const reopened = openSqliteFoundationStorage(databasePath);
      expect(await reopened.readiness()).toMatchObject({ ok: true, schemaVersion: "14" });
      const restartedAudit = await reopened.transaction((transaction) =>
        transaction.listGrantAudit("grant-expired"),
      );
      expect(restartedAudit.filter((entry) => entry.action === "grant-expired")).toHaveLength(1);
      reopened.close();
    });
  });

  test("rolls back migration 006 without losing legacy Grant evidence", async () => {
    await withDatabase(async (databasePath) => {
      const accepted = FOUNDATION_MIGRATIONS.slice(0, 5);
      const legacy = openSqliteFoundationStorage(databasePath, { migrations: accepted });
      await legacy.applyMigrations({ requireCandidate: false });
      legacy.close();

      const database = new Database(databasePath);
      for (const seed of legacyLifecycleSeeds()) seedLegacyGrant(database, seed);
      database.close();

      const migration006 = FOUNDATION_MIGRATIONS[5];
      if (migration006 === undefined) throw new Error("Expected migration 006.");
      const failing006 = createMigration(
        migration006.id,
        migration006.ordinal,
        migration006.schemaVersion,
        `${migration006.sql}; THIS IS NOT SQL;`,
      );
      const failing = openSqliteFoundationStorage(databasePath, {
        migrations: [...accepted, failing006],
      });
      const migrationFailure = await captureFailure(
        failing.applyMigrations({ requireCandidate: false }),
      );
      expect(migrationFailure).toBeInstanceOf(FoundationMigrationError);
      failing.close();

      const preserved = new Database(databasePath);
      expect(
        preserved.query("SELECT COUNT(*) AS count FROM foundation_migration_ledger").get(),
      ).toEqual({ count: 5 });
      expect(
        preserved
          .query(
            "SELECT COUNT(*) AS count FROM foundation_migration_ledger WHERE migration_id = '006-grant-cryptographic-erasure'",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        preserved
          .query(
            "SELECT COUNT(*) AS count FROM pragma_table_info('foundation_grant_roots') WHERE name = 'credential_material_state'",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(preserved.query("SELECT COUNT(*) AS count FROM foundation_grant_roots").get()).toEqual(
        { count: 4 },
      );
      expect(
        preserved.query("SELECT COUNT(*) AS count FROM foundation_grant_sessions").get(),
      ).toEqual({ count: 4 });
      expect(preserved.query("SELECT COUNT(*) AS count FROM foundation_grant_audit").get()).toEqual(
        { count: 12 },
      );
      expect(
        preserved
          .query(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE 'foundation_grant_%_copy' OR name = 'foundation_grant_erasure_mapping'",
          )
          .get(),
      ).toEqual({ count: 0 });
      preserved.close();
    });
  });
});

function createMigration(
  id: string,
  ordinal: number,
  schemaVersion: number,
  sql: string,
): FoundationMigration {
  return { id, ordinal, schemaVersion, sql, checksum: checksumMigrationSql(sql) };
}

async function captureFailure(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
    return null;
  } catch (error) {
    return error;
  }
}

type LegacyGrantSeed = {
  suffix: string;
  status: "active" | "disabled" | "revoked" | "expired";
  expiresAtMs: number | null;
  credentialFingerprint?: string;
};

function legacyLifecycleSeeds(): LegacyGrantSeed[] {
  return [
    { suffix: "active", status: "active", expiresAtMs: null },
    { suffix: "disabled-due", status: "disabled", expiresAtMs: 2_000 },
    { suffix: "revoked-due", status: "revoked", expiresAtMs: 2_000 },
    { suffix: "expired", status: "expired", expiresAtMs: 2_000 },
  ];
}

function seedLegacyGrant(database: Database, seed: LegacyGrantSeed): void {
  const grantId = `grant-${seed.suffix}`;
  const grantVersion = `grant-version-${seed.suffix}`;
  const fingerprint = `digest-${seed.suffix}`;
  database
    .query(
      `INSERT INTO foundation_grant_roots (
         grant_id, grant_type, grant_version, event_id, game_day_id, pitch_id, pitch_slot_id,
         status, created_at_ms, expires_at_ms, credential_format_version, credential_kind,
         encryption_key_version, lookup_key_version, credential_iv, credential_ciphertext,
         credential_tag, credential_lookup_digest, credential_fingerprint
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      grantId,
      "control",
      grantVersion,
      "event-legacy",
      "day-legacy",
      `pitch-${seed.suffix}`,
      `slot-${seed.suffix}`,
      seed.status,
      1_000,
      seed.expiresAtMs,
      1,
      "qr",
      "encryption-v1",
      "lookup-v1",
      `iv-${seed.suffix}`,
      `ciphertext-${seed.suffix}`,
      `tag-${seed.suffix}`,
      fingerprint,
      seed.credentialFingerprint ?? fingerprint,
    );
  database
    .query(
      `INSERT INTO foundation_grant_sessions (
         session_id, grant_id, grant_version, event_game_id, browser_context_digest,
         browser_context_key_version, bearer_lookup_verifier, bearer_lookup_key_version,
         status, created_at_ms, last_active_at_ms, revoked_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `session-${seed.suffix}`,
      grantId,
      grantVersion,
      `game-${seed.suffix}`,
      `browser-${seed.suffix}`,
      "lookup-v1",
      `bearer-${seed.suffix}`,
      "lookup-v1",
      seed.status === "active" ? "active" : "revoked",
      1_000,
      1_000,
      seed.status === "active" ? null : 1_500,
    );
  seedLegacyAudit(
    database,
    seed,
    "grant-created",
    `audit-${seed.suffix}-created`,
    null,
    seed.status === "expired" ? "active" : seed.status,
  );
  seedLegacyAudit(
    database,
    seed,
    seed.status === "expired" ? "grant-expired" : "credential-revealed",
    `audit-${seed.suffix}-second`,
    seed.status === "expired" ? "active" : seed.status,
    seed.status,
  );
  seedLegacySessionAdmission(database, seed);
}

function seedLegacySessionAdmission(database: Database, seed: LegacyGrantSeed): void {
  database
    .query(
      `INSERT INTO foundation_grant_audit (
         audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
         event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
         event_game_id, credential_kind, credential_fingerprint, before_status, after_status,
         created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `audit-${seed.suffix}-session`,
      "session-admitted",
      "accepted",
      `actor-${seed.suffix}`,
      `grant-${seed.suffix}`,
      "control",
      `grant-version-${seed.suffix}`,
      "event-legacy",
      "day-legacy",
      `pitch-${seed.suffix}`,
      `slot-${seed.suffix}`,
      `session-${seed.suffix}`,
      null,
      `game-${seed.suffix}`,
      "qr",
      null,
      null,
      null,
      1_000,
    );
}

function seedLegacyAudit(
  database: Database,
  seed: LegacyGrantSeed,
  action: "grant-created" | "credential-revealed" | "grant-expired",
  auditId: string,
  beforeStatus: LegacyGrantSeed["status"] | null,
  afterStatus: LegacyGrantSeed["status"],
): void {
  database
    .query(
      `INSERT INTO foundation_grant_audit (
         audit_id, action, outcome, actor_reference, grant_id, grant_type, grant_version,
         event_id, game_day_id, pitch_id, pitch_slot_id, session_id, replaced_session_id,
         event_game_id, credential_kind, credential_fingerprint, before_status, after_status,
         created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      auditId,
      action,
      "accepted",
      `actor-${seed.suffix}`,
      `grant-${seed.suffix}`,
      "control",
      `grant-version-${seed.suffix}`,
      "event-legacy",
      "day-legacy",
      `pitch-${seed.suffix}`,
      `slot-${seed.suffix}`,
      null,
      null,
      null,
      "qr",
      seed.credentialFingerprint ??
        (action === "grant-created" ? `digest-${seed.suffix}` : `alternate-${seed.suffix}`),
      beforeStatus,
      afterStatus,
      1_000,
    );
}
