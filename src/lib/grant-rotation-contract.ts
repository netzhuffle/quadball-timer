import { expect } from "bun:test";

import {
  type ControlGrantScope,
  type GrantKeyRing,
  type GrantRandomness,
} from "@/lib/grant-authority";
import type { GrantAuthority } from "@/lib/grant-authority-types";
import type {
  GrantAuthorityContractFactory,
  GrantAuthorityContractRegistrar,
} from "@/lib/grant-authority-contract";
import type { FoundationStorage } from "@/lib/foundation-storage";
import {
  createGrantTestAuthorityVerifier,
  createLegacyControlGrantTestAuthority,
} from "@/lib/grant-authority-test-support";

export function registerGrantRotationContract(
  register: GrantAuthorityContractRegistrar,
  createStorage: GrantAuthorityContractFactory,
): void {
  register("atomically rotates retained credential key material and audit evidence", async () => {
    await withStorage(createStorage, async (storage) => {
      const randomness = createDeterministicRandomness();
      const originalKeyRing = createKeyRing();
      const original = createAuthority(storage, { randomness, keyRing: originalKeyRing });
      const created = await createGrant(original);
      const before = await findGrant(storage, created.grantId);
      const rotatedKeyRing = createRotatedKeyRing(originalKeyRing);
      const rotated = createAuthority(storage, { randomness, keyRing: rotatedKeyRing });

      expect(
        await rotated.rotateControlGrantCredentialKeys(created.grantId, createActor()),
      ).toMatchObject({
        status: "rotated",
        grantId: created.grantId,
        encryptionKeyVersion: "encryption-v2",
        lookupKeyVersion: "lookup-v2",
      });

      const after = await findGrant(storage, created.grantId);
      expect(after?.credential).toMatchObject({
        materialState: "present",
        encryptionKeyVersion: "encryption-v2",
        lookupKeyVersion: "lookup-v2",
      });
      expect(after?.credential.ciphertext).not.toBe(before?.credential.ciphertext);
      expect(after?.credential.lookupDigest).not.toBe(before?.credential.lookupDigest);
      expect(after?.credential.fingerprint).not.toBe(after?.credential.lookupDigest);
      const audit = await readAudit(storage, created.grantId);
      expect(audit.filter((entry) => entry.action === "credential-rotated")).toEqual([
        expect.objectContaining({
          credentialFingerprint: after?.credential.fingerprint,
          beforeStatus: "active",
          afterStatus: "active",
        }),
      ]);
      expect(JSON.stringify({ after, audit })).not.toContain(created.qrCredential);

      const currentOnly = createAuthority(storage, {
        randomness,
        keyRing: keepOnlyCurrentKeys(rotatedKeyRing),
      });
      const admitted = await admit(currentOnly, created.qrCredential, "browser-a");
      expect(
        await currentOnly.authorizeControlGrant({ sessionBearer: admitted.sessionBearer }),
      ).toMatchObject({ status: "authorized" });
    });
  });

  register(
    "fails closed on corrupt Grant state and rolls back audit or crypto failures",
    async () => {
      await verifyCorruptGrantState(createStorage);
      await verifyAuditRollback(createStorage);
      await verifyCryptographicRollback(createStorage);
    },
  );

  register("rotates retained credentials without changing disabled or revoked status", async () => {
    for (const status of ["disabled", "revoked"] as const) {
      await withStorage(createStorage, async (storage) => {
        const randomness = createDeterministicRandomness();
        const originalKeyRing = createKeyRing();
        const original = createAuthority(storage, { randomness, keyRing: originalKeyRing });
        const created = await createGrant(original);
        await original[status === "disabled" ? "disableControlGrant" : "revokeControlGrant"](
          created.grantId,
          createActor(),
        );
        const before = await findGrant(storage, created.grantId);
        const rotated = createAuthority(storage, {
          randomness,
          keyRing: createRotatedKeyRing(originalKeyRing),
        });

        expect(
          await rotated.rotateControlGrantCredentialKeys(created.grantId, createActor()),
        ).toMatchObject({ status: "rotated", grantId: created.grantId });
        const after = await findGrant(storage, created.grantId);
        expect(after).toMatchObject({
          status,
          credential: { materialState: "present", lookupKeyVersion: "lookup-v2" },
        });
        expect(after?.credential.lookupDigest).not.toBe(before?.credential.lookupDigest);
        expect((await readAudit(storage, created.grantId)).filter(isRotationAudit)).toEqual([
          expect.objectContaining({ beforeStatus: status, afterStatus: status }),
        ]);
      });
    }
  });

  register("refuses rotation after atomic expiry erases the credential", async () => {
    await withStorage(createStorage, async (storage) => {
      let nowMs = 1_000;
      const originalKeyRing = createKeyRing();
      const original = createAuthority(storage, {
        keyRing: originalKeyRing,
        nowMs: () => nowMs,
      });
      const created = await createGrant(original, 1_100);
      nowMs = 1_100;
      const rotated = createAuthority(storage, {
        keyRing: createRotatedKeyRing(originalKeyRing),
        nowMs: () => nowMs,
      });

      expect(
        await rotated.rotateControlGrantCredentialKeys(created.grantId, createActor()),
      ).toEqual(rotationFailure);
      expect(await findGrant(storage, created.grantId)).toMatchObject({
        status: "expired",
        credential: {
          materialState: "erased",
          encryptionKeyVersion: null,
          lookupKeyVersion: null,
          lookupDigest: null,
        },
      });
      expect((await readAudit(storage, created.grantId)).filter(isExpiryAudit)).toHaveLength(1);
      expect(
        await rotated.rotateControlGrantCredentialKeys(created.grantId, createActor()),
      ).toEqual(rotationFailure);
      expect((await readAudit(storage, created.grantId)).filter(isExpiryAudit)).toHaveLength(1);
    });
  });
}

async function verifyCorruptGrantState(
  createStorage: GrantAuthorityContractFactory,
): Promise<void> {
  await withStorage(createStorage, async (storage) => {
    const originalKeyRing = createKeyRing();
    const randomness = createDeterministicRandomness();
    const original = createAuthority(storage, { randomness, keyRing: originalKeyRing });
    const created = await createGrant(original);
    await storage.transaction((transaction) => {
      const grant = transaction.findGrantById(created.grantId);
      if (grant === null) throw new Error("Expected the stored Grant.");
      transaction.insertGrant({
        ...grant,
        grantId: "grant-rotation-collision",
        grantVersion: "grant-version-rotation-collision",
        scope: { ...grant.scope, pitchSlotId: "slot-rotation-collision" },
        credential: {
          ...grant.credential,
          lookupDigest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          fingerprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      });
    });
    expect(await storage.readiness()).toMatchObject({
      ok: false,
      status: "integrity-failure",
    });
    expect(
      await original.createControlGrant({
        scope: { ...createScope(), pitchSlotId: "slot-unrelated" },
        actor: createActor(),
      }),
    ).toEqual(expect.objectContaining({ status: "rejected", reason: "unavailable" }));
  });
}

async function verifyAuditRollback(createStorage: GrantAuthorityContractFactory): Promise<void> {
  await withStorage(createStorage, async (storage) => {
    const originalKeyRing = createKeyRing();
    const randomness = createDeterministicRandomness();
    const original = createAuthority(storage, { randomness, keyRing: originalKeyRing });
    const created = await createGrant(original);
    const before = await findGrant(storage, created.grantId);
    const rotated = createAuthority(createRotationAuditFailingStorage(storage), {
      randomness,
      keyRing: createRotatedKeyRing(originalKeyRing),
    });
    expect(await rotated.rotateControlGrantCredentialKeys(created.grantId, createActor())).toEqual(
      rotationFailure,
    );
    expect(await findGrant(storage, created.grantId)).toEqual(before);
    expect((await readAudit(storage, created.grantId)).some(isRotationAudit)).toBe(false);
    expect(await admit(original, created.qrCredential, "browser-audit-failure")).toMatchObject({
      grantId: created.grantId,
    });
  });
}

async function verifyCryptographicRollback(
  createStorage: GrantAuthorityContractFactory,
): Promise<void> {
  await withStorage(createStorage, async (storage) => {
    const originalKeyRing = createKeyRing();
    const original = createAuthority(storage, { keyRing: originalKeyRing });
    const created = await createGrant(original);
    const before = await findGrant(storage, created.grantId);
    const rotatedKeyRing = createRotatedKeyRing(originalKeyRing);
    const withoutOldKey = createAuthority(storage, {
      keyRing: keepOnlyCurrentKeys(rotatedKeyRing),
    });
    expect(
      await withoutOldKey.rotateControlGrantCredentialKeys(created.grantId, createActor()),
    ).toEqual(rotationFailure);

    const invalidRandomness = createAuthority(storage, {
      keyRing: rotatedKeyRing,
      randomness: { bytes: (length) => new Uint8Array(length === 12 ? 11 : length) },
    });
    expect(
      await invalidRandomness.rotateControlGrantCredentialKeys(created.grantId, createActor()),
    ).toEqual(rotationFailure);
    expect(await findGrant(storage, created.grantId)).toEqual(before);
    expect(await admit(original, created.qrCredential, "browser-crypto-failure")).toMatchObject({
      grantId: created.grantId,
    });
  });
}

const rotationFailure = {
  status: "rejected",
  reason: "unavailable",
  detail: "The Grant credential cannot be rotated.",
} as const;

async function withStorage(
  createStorage: GrantAuthorityContractFactory,
  work: (storage: FoundationStorage) => Promise<void>,
): Promise<void> {
  const handle = await createStorage();
  try {
    await work(handle.storage);
  } finally {
    await handle.cleanup();
  }
}

function createRotationAuditFailingStorage(storage: FoundationStorage): FoundationStorage {
  return {
    transaction(work) {
      return storage.transaction((transaction) => {
        const wrapped = Object.create(transaction) as typeof transaction;
        wrapped.appendGrantAudit = (entry) => {
          if (entry.action === "credential-rotated") {
            throw new Error("sqlite rotation audit failure must not escape");
          }
          transaction.appendGrantAudit(entry);
        };
        return work(wrapped);
      });
    },
    readRoot: (recordId) => storage.readRoot(recordId),
    readActions: (recordId) => storage.readActions(recordId),
    readIdempotencyEntries: (recordId) => storage.readIdempotencyEntries(recordId),
    readRecordMetadata: (recordId) => storage.readRecordMetadata(recordId),
    readAuditEntries: (recordId) => storage.readAuditEntries(recordId),
    readiness: () => storage.readiness(),
    close: () => storage.close(),
  };
}

function createAuthority(
  storage: FoundationStorage,
  configuration: {
    keyRing?: GrantKeyRing;
    randomness?: GrantRandomness;
    nowMs?: () => number;
  } = {},
): GrantAuthority {
  return createLegacyControlGrantTestAuthority(storage, {
    environmentId: "test-environment",
    clock: { nowMs: configuration.nowMs ?? (() => 1_000) },
    randomness: configuration.randomness ?? createDeterministicRandomness(),
    keyRing: configuration.keyRing ?? createKeyRing(),
    privilegedAuthorityVerifier: createGrantTestAuthorityVerifier(),
    controlScopeResolver: {
      resolve(scope) {
        expect(scope).toEqual(createScope());
        return { status: "eligible", eventGameId: "game-1" };
      },
    },
  });
}

async function createGrant(authority: GrantAuthority, expiresAtMs?: number) {
  const result = await authority.createControlGrant({
    scope: createScope(),
    actor: createActor(),
    expiresAtMs,
  });
  if (result.status !== "created") throw new Error("Expected a created Control Grant.");
  return result;
}

async function admit(authority: GrantAuthority, qrCredential: string, browserContext: string) {
  const result = await authority.admitControlGrant({ qrCredential, browserContext });
  if (result.status !== "admitted") throw new Error("Expected an admitted Grant Session.");
  return result;
}

function findGrant(storage: FoundationStorage, grantId: string) {
  return storage.transaction((transaction) => transaction.findGrantById(grantId));
}

function readAudit(storage: FoundationStorage, grantId: string) {
  return storage.transaction((transaction) => transaction.listGrantAudit(grantId));
}

function isRotationAudit(entry: { action: string }): boolean {
  return entry.action === "credential-rotated";
}

function isExpiryAudit(entry: { action: string }): boolean {
  return entry.action === "grant-expired";
}

function createScope(): ControlGrantScope {
  return {
    eventId: "event-1",
    gameDayId: "day-1",
    pitchId: "pitch-1",
    pitchSlotId: "slot-1",
  };
}

function createActor() {
  return { kind: "fixture", id: "fixture-authority" } as const;
}

function createDeterministicRandomness(): GrantRandomness {
  let randomCall = 0;
  return {
    bytes(length) {
      randomCall += 1;
      return Uint8Array.from({ length }, (_, index) => (index + length + randomCall) % 256);
    },
  };
}

function createKeyRing(): GrantKeyRing {
  return {
    encryption: {
      currentVersion: "encryption-v1",
      keys: new Map([["encryption-v1", Uint8Array.from({ length: 32 }, (_, index) => index + 1)]]),
    },
    lookup: {
      currentVersion: "lookup-v1",
      keys: new Map([["lookup-v1", Uint8Array.from({ length: 32 }, (_, index) => index + 33)]]),
    },
    audit: {
      currentVersion: "audit-v1",
      keys: new Map([["audit-v1", Uint8Array.from({ length: 32 }, (_, index) => index + 65)]]),
    },
  };
}

function createRotatedKeyRing(original: GrantKeyRing): GrantKeyRing {
  return {
    encryption: {
      currentVersion: "encryption-v2",
      keys: new Map([
        ...original.encryption.keys,
        ["encryption-v2", Uint8Array.from({ length: 32 }, (_, index) => index + 97)],
      ]),
    },
    lookup: {
      currentVersion: "lookup-v2",
      keys: new Map([
        ...original.lookup.keys,
        ["lookup-v2", Uint8Array.from({ length: 32 }, (_, index) => index + 65)],
      ]),
    },
    audit: original.audit,
  };
}

function keepOnlyCurrentKeys(keyRing: GrantKeyRing): GrantKeyRing {
  const encryptionKey = keyRing.encryption.keys.get(keyRing.encryption.currentVersion);
  const lookupKey = keyRing.lookup.keys.get(keyRing.lookup.currentVersion);
  if (encryptionKey === undefined || lookupKey === undefined) {
    throw new Error("Expected current Grant test keys.");
  }
  return {
    encryption: {
      currentVersion: keyRing.encryption.currentVersion,
      keys: new Map([[keyRing.encryption.currentVersion, encryptionKey]]),
    },
    lookup: {
      currentVersion: keyRing.lookup.currentVersion,
      keys: new Map([[keyRing.lookup.currentVersion, lookupKey]]),
    },
    audit: keyRing.audit,
  };
}
