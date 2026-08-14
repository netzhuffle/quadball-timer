import { describe, expect, test } from "bun:test";
import {
  assessMigrationReadiness,
  checksumMigrationSql,
  FOUNDATION_MIGRATIONS,
  type FoundationMigration,
  type MigrationLedgerEntry,
} from "@/lib/foundation-migrations";

const migrations: readonly FoundationMigration[] = [
  createMigration("001-first", 1, 1, "CREATE TABLE first (id TEXT) STRICT;"),
  createMigration("002-second", 2, 2, "CREATE TABLE second (id TEXT) STRICT;"),
];

describe("foundation migration ledger compatibility", () => {
  test("keeps accepted migrations 001 through 005 byte-for-byte immutable", () => {
    expect(FOUNDATION_MIGRATIONS.slice(0, 5).map(({ id, checksum }) => ({ id, checksum }))).toEqual(
      [
        {
          id: "001-foundation-event-game-record-roots",
          checksum: "915727680c9142dc2bd5e6482b13879df1bcbfa779d6b5ad67160f7e6c3d0510",
        },
        {
          id: "002-normalize-event-game-record-sides",
          checksum: "c7f15ac99143c0968d6140cda6a1d0a7800c70754800d571a49cf487d89b62a3",
        },
        {
          id: "003-persist-event-game-actions",
          checksum: "0d7d827884408cbe8fc591b02c39d79b0eb9bbfd24e1e96eeef318073e2609a2",
        },
        {
          id: "004-foundation-control-grants",
          checksum: "ba3f4a44c36086e3f31f15da707e14e7ab9167ab85a76874566bc7ef5493210f",
        },
        {
          id: "005-grant-expiry-lifecycle",
          checksum: "8580876d7d4a490f6cf252cafc7be81cf3cc5a8769821b3bd82f760c0115b3d1",
        },
      ],
    );
  });

  test("distinguishes pending and missing migrations", () => {
    expect(assessMigrationReadiness(false, [], migrations)).toMatchObject({ status: "pending" });
    expect(assessMigrationReadiness(true, [], migrations)).toMatchObject({ status: "pending" });
  });

  test("rejects reordered, changed, incomplete, and future entries", () => {
    const second = migrations[1];
    if (second === undefined) throw new Error("Expected the second migration.");

    expect(assessMigrationReadiness(true, [ledgerEntry(second)], migrations)).toMatchObject({
      status: "reordered",
    });

    expect(
      assessMigrationReadiness(
        true,
        [{ ...ledgerEntry(migrations[0]), checksum: "changed" }],
        migrations,
      ),
    ).toMatchObject({ status: "changed-checksum" });

    expect(
      assessMigrationReadiness(
        true,
        [{ ...ledgerEntry(migrations[0]), status: "applying" }],
        migrations,
      ),
    ).toMatchObject({ status: "incomplete" });

    expect(
      assessMigrationReadiness(
        true,
        [
          ledgerEntry(migrations[0]),
          {
            id: "003-future",
            ordinal: 3,
            schemaVersion: 3,
            checksum: "future",
            status: "complete",
          },
        ],
        migrations,
      ),
    ).toMatchObject({ status: "future" });
  });

  test("accepts only a complete ordered prefix followed by the current release", () => {
    expect(assessMigrationReadiness(true, [ledgerEntry(migrations[0])], migrations)).toMatchObject({
      status: "missing",
    });
    expect(
      assessMigrationReadiness(
        true,
        [ledgerEntry(migrations[0]), ledgerEntry(migrations[1])],
        migrations,
      ),
    ).toMatchObject({ status: "ready", schemaVersion: 2 });
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

function ledgerEntry(migration: FoundationMigration | undefined): MigrationLedgerEntry {
  if (migration === undefined) throw new Error("Expected a migration.");
  return {
    id: migration.id,
    ordinal: migration.ordinal,
    schemaVersion: migration.schemaVersion,
    checksum: migration.checksum,
    status: "complete",
  };
}
