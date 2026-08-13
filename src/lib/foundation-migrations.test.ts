import { describe, expect, test } from "bun:test";
import {
  assessMigrationReadiness,
  checksumMigrationSql,
  type FoundationMigration,
  type MigrationLedgerEntry,
} from "@/lib/foundation-migrations";

const migrations: readonly FoundationMigration[] = [
  createMigration("001-first", 1, 1, "CREATE TABLE first (id TEXT) STRICT;"),
  createMigration("002-second", 2, 2, "CREATE TABLE second (id TEXT) STRICT;"),
];

describe("foundation migration ledger compatibility", () => {
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
