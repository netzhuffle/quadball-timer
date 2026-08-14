import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertProductionStateBoundary,
  readRuntimeStoragePaths,
} from "@/lib/runtime-storage-config";

describe("runtime storage configuration", () => {
  test("keeps both Production databases in the canonical systemd state directory", () => {
    expect(readRuntimeStoragePaths("production", {})).toEqual({
      technicalAdminDatabase: "/var/lib/quadball-timer/technical-admin.sqlite",
      foundationDatabase: "/var/lib/quadball-timer/foundation.sqlite",
    });
  });

  test("keeps Test defaults isolated from Production state", () => {
    expect(readRuntimeStoragePaths("test", {})).toEqual({
      technicalAdminDatabase: "data/test/technical-admin.sqlite",
      foundationDatabase: "data/test/foundation.sqlite",
    });
  });

  test("rejects Production storage overrides outside the canonical state directory", () => {
    expect(() =>
      readRuntimeStoragePaths("production", {
        TECHNICAL_ADMIN_DATABASE: "/tmp/timer-test/technical-admin.sqlite",
        FOUNDATION_DATABASE: "/tmp/timer-test/foundation.sqlite",
      }),
    ).toThrow("canonical path");
  });

  test("honors explicit storage paths for disposable Test environments", () => {
    expect(
      readRuntimeStoragePaths("test", {
        TECHNICAL_ADMIN_DATABASE: "/tmp/timer-test/technical-admin.sqlite",
        FOUNDATION_DATABASE: "/tmp/timer-test/foundation.sqlite",
      }),
    ).toEqual({
      technicalAdminDatabase: "/tmp/timer-test/technical-admin.sqlite",
      foundationDatabase: "/tmp/timer-test/foundation.sqlite",
    });
  });

  test("accepts one private writable Production state directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "quadball-timer-state-"));
    chmodSync(directory, 0o750);

    try {
      expect(() =>
        assertProductionStateBoundary("production", {
          technicalAdminDatabase: join(directory, "technical-admin.sqlite"),
          foundationDatabase: join(directory, "foundation.sqlite"),
        }),
      ).not.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects absent, shared, or symlinked Production state directories", () => {
    const root = mkdtempSync(join(tmpdir(), "quadball-timer-state-"));
    const missing = join(root, "missing");
    const shared = join(root, "shared");
    const privateDirectory = join(root, "private");
    const linked = join(root, "linked");
    mkdirSync(shared, { mode: 0o770 });
    chmodSync(shared, 0o770);
    mkdirSync(privateDirectory, { mode: 0o750 });
    symlinkSync(privateDirectory, linked);

    try {
      for (const directory of [missing, shared, linked]) {
        expect(() =>
          assertProductionStateBoundary("production", {
            technicalAdminDatabase: join(directory, "technical-admin.sqlite"),
            foundationDatabase: join(directory, "foundation.sqlite"),
          }),
        ).toThrow("Production state directory");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("requires both Production databases to share one absolute state directory", () => {
    expect(() =>
      assertProductionStateBoundary("production", {
        technicalAdminDatabase: "/var/lib/quadball-timer/technical-admin.sqlite",
        foundationDatabase: "/srv/quadball-timer/foundation.sqlite",
      }),
    ).toThrow("one state directory");
  });

  test("rejects an unsafe existing Technical Admin database before startup", () => {
    const root = mkdtempSync(join(tmpdir(), "quadball-timer-state-"));
    const unsafeDatabase = join(root, "unsafe.sqlite");
    const linkedDatabase = join(root, "linked.sqlite");
    const linkTarget = join(root, "target.sqlite");
    chmodSync(root, 0o750);
    writeFileSync(unsafeDatabase, "");
    chmodSync(unsafeDatabase, 0o660);
    writeFileSync(linkTarget, "");
    chmodSync(linkTarget, 0o640);
    symlinkSync(linkTarget, linkedDatabase);

    try {
      for (const technicalAdminDatabase of [unsafeDatabase, linkedDatabase]) {
        expect(() =>
          assertProductionStateBoundary("production", {
            technicalAdminDatabase,
            foundationDatabase: join(root, "foundation.sqlite"),
          }),
        ).toThrow("Technical Admin database");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
