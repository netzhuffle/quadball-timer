import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { lstatSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  convertLegacyGrantKeyRingFile,
  createGrantKeyRingDocument,
  createGrantKeyRingRecoveryHandoff,
  loadGrantKeyRingFile,
  preflightGrantKeyRingFile,
  removeLegacyGrantKeyRingEntries,
  rotateGrantKeyRingDocument,
  writeGrantKeyRingFile,
  writeGrantKeyRingRecoveryHandoff,
} from "@/lib/grant-key-ring-custody";

describe("Grant key-ring custody", () => {
  test("loads a synthetic environment-bound versioned ring and exposes metadata only in preflight", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-grant-ring-"));
    const path = join(directory, "grant-key-ring.json");
    try {
      const document = createGrantKeyRingDocument("test", new Date("2026-08-15T00:00:00.000Z"));
      writeGrantKeyRingFile(path, document);
      const loaded = loadGrantKeyRingFile(path, "test", {
        requiredOwnerUid: process.getuid?.() ?? 0,
        requiredVersions: {
          encryption: ["v1"],
          lookup: ["v1"],
          audit: ["v1"],
        },
      });
      expect(loaded.metadata).toMatchObject({
        environment: "test",
        currentVersions: { encryption: "v1", lookup: "v1", audit: "v1" },
        retainedVersions: { encryption: 1, lookup: 1, audit: 1 },
      });
      expect([...loaded.keyRing.encryption.keys.keys()]).toEqual(["v1"]);
      const preflight = preflightGrantKeyRingFile(path, "test", {
        requiredOwnerUid: process.getuid?.() ?? 0,
      });
      expect(preflight).toMatchObject({ ok: true, environment: "test" });
      expect(JSON.stringify(preflight)).not.toContain(Object.values(document.encryption.keys)[0]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects environment mismatch, malformed values, missing versions, and unsafe permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-grant-ring-"));
    const path = join(directory, "grant-key-ring.json");
    const ownerUid = process.getuid?.() ?? 0;
    try {
      const document = createGrantKeyRingDocument("production");
      writeGrantKeyRingFile(path, document);
      expect(preflightGrantKeyRingFile(path, "test", { requiredOwnerUid: ownerUid })).toEqual({
        ok: false,
        category: "environment-mismatch",
      });

      const malformed = { ...document, lookup: { ...document.lookup, keys: { v1: "not-a-key" } } };
      await writeFile(path, `${JSON.stringify(malformed)}\n`);
      expect(preflightGrantKeyRingFile(path, "production", { requiredOwnerUid: ownerUid })).toEqual(
        {
          ok: false,
          category: "malformed",
        },
      );

      writeGrantKeyRingFile(path, document);
      expect(
        preflightGrantKeyRingFile(path, "production", {
          requiredOwnerUid: ownerUid,
          requiredVersions: { audit: ["v2"] },
        }),
      ).toEqual({ ok: false, category: "missing-key-version" });

      await chmod(path, 0o660);
      expect(preflightGrantKeyRingFile(path, "production", { requiredOwnerUid: ownerUid })).toEqual(
        {
          ok: false,
          category: "unsafe-permissions",
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rotates every category while retaining old versions and creates a separate recovery handoff", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-grant-ring-"));
    const activePath = join(directory, "grant-key-ring.json");
    const handoffPath = join(directory, "1password-recovery.json");
    try {
      const initial = createGrantKeyRingDocument("production");
      const rotated = rotateGrantKeyRingDocument(
        initial,
        "v2",
        new Date("2026-08-16T00:00:00.000Z"),
        (length) => new Uint8Array(length).fill(7),
      );
      expect(rotated.encryption.currentVersion).toBe("v2");
      expect(Object.keys(rotated.encryption.keys)).toEqual(["v1", "v2"]);
      expect(Object.keys(rotated.lookup.keys)).toEqual(["v1", "v2"]);
      expect(Object.keys(rotated.audit.keys)).toEqual(["v1", "v2"]);
      writeGrantKeyRingFile(activePath, rotated);
      writeGrantKeyRingRecoveryHandoff(handoffPath, rotated);
      const handoff = JSON.parse(await readFile(handoffPath, "utf8")) as ReturnType<
        typeof createGrantKeyRingRecoveryHandoff
      >;
      expect(handoff.itemTitle).toBe("Quadball Timer Production Grant Key Ring Recovery");
      expect(handoff.currentVersions).toEqual({ encryption: "v2", lookup: "v2", audit: "v2" });
      expect(handoff.keyRing).toEqual(rotated);
      expect(await readFile(activePath, "utf8")).toContain('"environment":"production"');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not include raw values in custody failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-grant-ring-"));
    const path = join(directory, "grant-key-ring.json");
    try {
      const document = createGrantKeyRingDocument("test");
      const secret = Object.values(document.audit.keys)[0]!;
      await writeFile(path, "{}\n", { mode: 0o600 });
      let failure: Error | undefined;
      try {
        loadGrantKeyRingFile(path, "test", { requiredOwnerUid: process.getuid?.() ?? 0 });
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
      expect(failure).toBeDefined();
      expect(failure?.message).not.toContain(secret);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("converts root-controlled legacy Grant variables for both Environments and removes only those entries after verification", async () => {
    const ownerUid = process.getuid?.() ?? 0;
    for (const environment of ["production", "test"] as const) {
      const directory = await mkdtemp(join(tmpdir(), "quadball-grant-ring-legacy-"));
      const legacyPath = join(directory, "environment.env");
      const activePath = join(directory, "grant-key-ring.json");
      try {
        const legacy = {
          encryption: Buffer.alloc(32, 1).toString("hex"),
          lookup: Buffer.alloc(32, 2).toString("hex"),
          audit: Buffer.alloc(32, 3).toString("hex"),
        };
        await writeFile(
          legacyPath,
          `EVENT_GAME_LOOKUP_KEY=${Buffer.alloc(32, 9).toString("hex")}\nGRANT_ENCRYPTION_KEY=${legacy.encryption}\nGRANT_LOOKUP_KEY=${legacy.lookup}\nGRANT_AUDIT_KEY=${legacy.audit}\n`,
          { mode: 0o640 },
        );
        const before = lstatSync(legacyPath);
        const predictableTemporaryPath = join(directory, ".environment.env.tmp");
        const canaryPath = join(directory, "canary.txt");
        writeFileSync(canaryPath, "do-not-follow\n", { mode: 0o600 });
        symlinkSync(canaryPath, predictableTemporaryPath);
        const converted = convertLegacyGrantKeyRingFile(legacyPath, environment, {
          requiredOwnerUid: ownerUid,
          now: new Date("2026-08-15T00:00:00.000Z"),
        });
        writeGrantKeyRingFile(activePath, converted);
        const verified = loadGrantKeyRingFile(activePath, environment, {
          requiredOwnerUid: ownerUid,
          requiredVersions: { encryption: ["v1"], lookup: ["v1"], audit: ["v1"] },
        });
        expect(Buffer.from(verified.keyRing.encryption.keys.get("v1")!).toString("hex")).toBe(
          legacy.encryption,
        );
        expect(Buffer.from(verified.keyRing.lookup.keys.get("v1")!).toString("hex")).toBe(
          legacy.lookup,
        );
        expect(Buffer.from(verified.keyRing.audit.keys.get("v1")!).toString("hex")).toBe(
          legacy.audit,
        );
        removeLegacyGrantKeyRingEntries(legacyPath, { requiredOwnerUid: ownerUid });
        const after = lstatSync(legacyPath);
        expect(after.mode & 0o777).toBe(before.mode & 0o777);
        expect(after.uid).toBe(before.uid);
        expect(after.gid).toBe(before.gid);
        const remaining = await readFile(legacyPath, "utf8");
        expect(remaining).toContain("EVENT_GAME_LOOKUP_KEY=");
        expect(remaining).not.toContain("GRANT_ENCRYPTION_KEY=");
        expect(remaining).not.toContain("GRANT_LOOKUP_KEY=");
        expect(remaining).not.toContain("GRANT_AUDIT_KEY=");
        expect(readlinkSync(predictableTemporaryPath)).toBe(canaryPath);
        expect(await readFile(canaryPath, "utf8")).toBe("do-not-follow\n");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  test("uses a randomized exclusive temporary instead of the predictable temporary name", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-grant-ring-atomic-"));
    const path = join(directory, "grant-key-ring.json");
    const predictableTemporaryPath = join(directory, ".grant-key-ring.json.tmp");
    const canaryPath = join(directory, "canary.txt");
    try {
      writeFileSync(canaryPath, "unchanged\n", { mode: 0o600 });
      symlinkSync(canaryPath, predictableTemporaryPath);
      writeGrantKeyRingFile(path, createGrantKeyRingDocument("test"));
      expect(readlinkSync(predictableTemporaryPath)).toBe(canaryPath);
      expect(await readFile(canaryPath, "utf8")).toBe("unchanged\n");
      expect(lstatSync(path).isFile()).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects a pre-created output owned by a different invoking identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-grant-ring-owner-"));
    const path = join(directory, "grant-key-ring.json");
    const ownerUid = process.getuid?.() ?? 0;
    try {
      const original = createGrantKeyRingDocument("test");
      writeGrantKeyRingFile(path, original);
      expect(() =>
        writeGrantKeyRingFile(path, createGrantKeyRingDocument("test"), {
          requiredOwnerUid: ownerUid + 1,
        }),
      ).toThrow("unsafe-permissions");
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
