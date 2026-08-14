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
  test("keeps accepted migrations 001 through 022 byte-for-byte immutable and pins 023", () => {
    expect(FOUNDATION_MIGRATIONS.map(({ id, checksum }) => ({ id, checksum }))).toEqual([
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
      {
        id: "006-grant-cryptographic-erasure",
        checksum: "d0e63544b2b8b14b0f0c2211424184debe46be696add32e3f4ed19994cd83038",
      },
      {
        id: "007-anchor-control-action-audit-versions",
        checksum: "6dfdad1244dac6c4cfd2f146e7effdb08d0b29c3262e5b8a95ea2454cea8df39",
      },
      {
        id: "008-anchor-current-evidence-format",
        checksum: "16581ea580393ff887537edf34f161531574e1052fed6092c640df3adbe1ec6f",
      },
      {
        id: "009-immutable-control-evidence-provenance",
        checksum: "1d41bf9ff707085fc664afce00216ae9ed2616ec8abdc0c1556ec3d1cf51f3ca",
      },
      {
        id: "010-typed-grant-storage",
        checksum: "ee6bdc5330749e5af8abc307daa67e1ce3b5ff5c381d06d5fd05f109c42ed8dc",
      },
      {
        id: "011-persist-session-summary-labels",
        checksum: "6a02139efa6089a2f0062242533bd9b34c8e5c712579b149d4b044dc3f71bab0",
      },
      {
        id: "012-terminal-grant-session-audit",
        checksum: "b4a3f9da03ac6f941e12cde618c88f4847255644a1b7e95af03333779aa7204c",
      },
      {
        id: "013-grant-audit-evidence-fields",
        checksum: "3fa42994a30c57cafd5b370f9cc1ba821a1576adbc2c2a15929a834428e4033a",
      },
      {
        id: "014-grant-provenance-integrity",
        checksum: "2dbb23e24340a998baeb48c77365781763e42ef8c47f10b0097b3df4c1e9d2d8",
      },
      {
        id: "015-control-session-binding",
        checksum: "844f8d804dc6a243090de9f5c8cf9c9d04170cfbea7443c23e9403eebc0be73f",
      },
      {
        id: "016-replay-content-provenance",
        checksum: "ec5b1d9dbead810498648018572b87635c034da1f9fbe291a31519230e1d80ee",
      },
      {
        id: "017-composed-acceptance-state",
        checksum: "4d5c4f3f93dd2c6e7e338b1be1138b709e23c3f750799cf05835e3a3b81b44e4",
      },
      {
        id: "018-acceptance-integrity-history",
        checksum: "e31684910a8a7303e037c54683f5c541d90c2a992a69695161a187f9974cab94",
      },
      {
        id: "019-event-catalog",
        checksum: "04c7e444beab018acfab2baac67cfb8d1e641f57336345fc067c34c8dc456d86",
      },
      {
        id: "020-grant-codes-and-admission-telemetry",
        checksum: "a201f58429d60e21f2baefc13786980a76354f4095b01f7a5b4dd445c18e97f0",
      },
      {
        id: "021-grant-code-game-lock-erasure-evidence",
        checksum: "d91853426ecc62a0b5a6341536fc788753604b75aef6d515de770624d403fec0",
      },
      {
        id: "022-control-session-stay-binding",
        checksum: "88c2b77d65542cc3310c268389e9ad5693a7f87bc0815cb1209be7db49e2cf6e",
      },
      {
        id: "023-event-teams-rosters-and-pitches",
        checksum: "cba4dc52a3eff2bd982091112a65bafeb5bbc62965974d7eec4fdf869072042f",
      },
    ]);
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
