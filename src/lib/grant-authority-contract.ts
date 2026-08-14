import { expect } from "bun:test";
import { parseCredentialToken } from "@/lib/grant-crypto";
import { validateGrantState } from "@/lib/grant-state-validation";
import { registerGrantRotationContract } from "@/lib/grant-rotation-contract";
import {
  GENERIC_GRANT_ADMISSION_FAILURE,
  type ControlGrantScope,
  type ControlGrantScopeResolution,
  type GrantAuthorityActor,
  type GrantKeyRing,
  type GrantRandomness,
} from "@/lib/grant-authority";
import type { GrantAuthority } from "@/lib/grant-authority-types";
import type { FoundationStorage } from "@/lib/foundation-storage";
import { FoundationStorageConstraintError } from "@/lib/foundation-storage";
import {
  createGrantTestAuthorityVerifier,
  createLegacyControlGrantTestAuthority,
} from "@/lib/grant-authority-test-support";

export type GrantAuthorityContractStorage = {
  storage: FoundationStorage;
  cleanup(): Promise<void> | void;
};

export type GrantAuthorityContractFactory = () =>
  | GrantAuthorityContractStorage
  | Promise<GrantAuthorityContractStorage>;

export type GrantAuthorityContractRegistrar = (
  name: string,
  callback: () => void | Promise<void>,
) => unknown;

export function registerGrantAuthorityContract(
  register: GrantAuthorityContractRegistrar,
  createStorage: GrantAuthorityContractFactory,
): void {
  register(
    "creates a scoped Control Grant, admits a device, and authorizes its session",
    async () => {
      await withStorage(createStorage, async (storage) => {
        await runGrantScenario(storage);
      });
    },
  );

  register("rejects a Grant Audit Trail with deleted mandatory creation evidence", async () => {
    await withStorage(createStorage, async (storage) => {
      const authority = createAuthority(storage);
      const created = await createGrant(authority);
      const snapshot = await storage.transaction((transaction) => ({
        grant: transaction.findGrantById(created.grantId),
        sessions: transaction.listGrantSessions(created.grantId),
        audits: transaction.listGrantAudit(created.grantId),
      }));
      expect(snapshot.grant).not.toBeNull();
      expect(
        validateGrantState(
          snapshot.grant === null ? [] : [snapshot.grant],
          snapshot.sessions,
          snapshot.audits.filter((audit) => audit.action !== "grant-created"),
        ),
      ).not.toBeNull();
    });
  });

  register("derives pseudonymous audit actors from structured authority input", async () => {
    await withStorage(createStorage, async (storage) => {
      const authority = createAuthority(storage);
      const bearerShapedActor = `session-${"a".repeat(43)}`;
      const created = await authority.createControlGrant({
        scope: createScope(),
        actor: { kind: "fixture", id: bearerShapedActor },
      });
      expect(created.status).toBe("created");
      if (created.status !== "created") throw new Error("Expected a created Control Grant.");

      const audit = await readGrantAudit(authority, created.grantId);
      const serialized = JSON.stringify(audit);
      expect(serialized).not.toContain(bearerShapedActor);
      expect(serialized).not.toContain("fixture-authority");
      expect(audit[0]?.actorReference).toMatch(/^actor-[A-Za-z0-9_-]+$/);
    });
  });

  register("replaces only the same browser context and redacts session evidence", async () => {
    await withStorage(createStorage, async (storage) => {
      const authority = createAuthority(storage);
      const created = await createGrant(authority);
      const stored = await storage.transaction((transaction) =>
        transaction.findGrantById(created.grantId),
      );
      expect(stored?.credential.fingerprint).not.toBe(stored?.credential.lookupDigest);
      const first = await admit(authority, created.qrCredential, "browser-a");
      const otherContext = await admit(authority, created.qrCredential, "browser-b");
      const replacement = await admit(authority, created.qrCredential, "browser-a");

      expect(await authority.authorizeControlGrant({ sessionBearer: first.sessionBearer })).toEqual(
        {
          status: "rejected",
          code: "grant-authorization-failed",
          message: "Unable to authorize this Grant Session.",
        },
      );
      expect(
        await authority.authorizeControlGrant({ sessionBearer: otherContext.sessionBearer }),
      ).toMatchObject({ status: "authorized", grantSessionId: otherContext.grantSessionId });
      expect(
        await authority.authorizeControlGrant({ sessionBearer: replacement.sessionBearer }),
      ).toMatchObject({ status: "authorized", grantSessionId: replacement.grantSessionId });

      const sessions = await readGrantSessions(authority, created.grantId);
      expect(sessions).toHaveLength(3);
      expect(sessions.filter((session) => session.status === "revoked")).toHaveLength(1);
      expect(sessions.filter((session) => session.status === "active")).toHaveLength(2);
      expect(sessions.every((session) => /^session-[A-Za-z0-9_-]{12}$/.test(session.label))).toBe(
        true,
      );
      const audit = await readGrantAudit(authority, created.grantId);
      expect(audit).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "session-replaced",
            replacedSessionId: first.grantSessionId,
          }),
        ]),
      );
      const redacted = JSON.stringify({ audit, sessions });
      expect(redacted).not.toContain(created.qrCredential);
      expect(redacted).not.toContain(first.sessionBearer);
      expect(redacted).not.toContain(otherContext.sessionBearer);
      expect(redacted).not.toContain(replacement.sessionBearer);
      await expectAtomicAuditRollback(storage, created.grantId);
    });
  });

  register("uses generic failures and atomically expires the Grant lifecycle", async () => {
    await withStorage(createStorage, async (storage) => {
      const authority = createAuthority(storage);
      const created = await createGrant(authority);
      const wrongEnvironment = createAuthority(storage, { environmentId: "other-environment" });
      const wrongScope = createAuthority(storage, {
        resolve: () => ({ status: "mismatch", detail: "wrong scope" }),
      });
      const failures = await Promise.all([
        authority.admitControlGrant({ qrCredential: "malformed", browserContext: "browser-a" }),
        wrongEnvironment.admitControlGrant({
          qrCredential: created.qrCredential,
          browserContext: "browser-a",
        }),
        wrongScope.admitControlGrant({
          qrCredential: created.qrCredential,
          browserContext: "browser-a",
        }),
      ]);
      for (const failure of failures) expect(failure).toEqual(GENERIC_GRANT_ADMISSION_FAILURE);

      expect(await authority.disableControlGrant(created.grantId, createActor())).toMatchObject({
        status: "updated",
      });
      expect(
        await authority.admitControlGrant({
          qrCredential: created.qrCredential,
          browserContext: "browser-a",
        }),
      ).toEqual(GENERIC_GRANT_ADMISSION_FAILURE);
      expect(await authority.revokeControlGrant(created.grantId, createActor())).toMatchObject({
        status: "updated",
      });
    });

    await withStorage(createStorage, async (storage) => {
      let nowMs = 1_000;
      const authority = createAuthority(storage, { nowMs: () => nowMs });
      const expired = await authority.createControlGrant({
        scope: createScope(),
        actor: createActor(),
        expiresAtMs: 1_100,
      });
      expect(expired.status).toBe("created");
      if (expired.status !== "created") throw new Error("Expected an expiring Control Grant.");
      const admitted = await admit(authority, expired.qrCredential, "browser-a");
      nowMs = 1_100;
      expect(
        await authority.admitControlGrant({
          qrCredential: expired.qrCredential,
          browserContext: "browser-a",
        }),
      ).toEqual(GENERIC_GRANT_ADMISSION_FAILURE);
      expect(
        await authority.authorizeControlGrant({ sessionBearer: admitted.sessionBearer }),
      ).toMatchObject({ status: "rejected" });

      const lifecycle = await storage.transaction((transaction) => ({
        grant: transaction.findGrantById(expired.grantId),
        sessions: transaction.listGrantSessions(expired.grantId),
        audit: transaction.listGrantAudit(expired.grantId),
      }));
      expect(lifecycle.grant?.status).toBe("expired");
      expect(lifecycle.sessions).toEqual([
        expect.objectContaining({ sessionId: admitted.grantSessionId, status: "expired" }),
      ]);
      expect(lifecycle.audit).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: "grant-expired", afterStatus: "expired" }),
        ]),
      );
    });
  });

  register("rejects repeated Grant status transitions without audit mutation", async () => {
    await withStorage(createStorage, async (storage) => {
      const authority = createAuthority(storage);
      const created = await createGrant(authority);
      const disabled = await authority.disableControlGrant(created.grantId, createActor());
      expect(disabled).toMatchObject({ status: "updated" });
      const afterDisable = await readGrantAudit(authority, created.grantId);
      expect(await authority.disableControlGrant(created.grantId, createActor())).toMatchObject({
        status: "rejected",
        reason: "invalid-state",
      });
      expect(await readGrantAudit(authority, created.grantId)).toEqual(afterDisable);

      const revoked = await authority.revokeControlGrant(created.grantId, createActor());
      expect(revoked).toMatchObject({ status: "updated" });
      const afterRevoke = await readGrantAudit(authority, created.grantId);
      expect(await authority.revokeControlGrant(created.grantId, createActor())).toMatchObject({
        status: "rejected",
        reason: "invalid-state",
      });
      expect(await readGrantAudit(authority, created.grantId)).toEqual(afterRevoke);
    });
  });

  register(
    "freezes writes when current Grant material is downgraded to migration-shaped data",
    async () => {
      await withStorage(createStorage, async (storage) => {
        const authority = createAuthority(storage);
        const created = await createGrant(authority);
        await storage.transaction((transaction) => {
          const grant = transaction.findGrantById(created.grantId);
          if (grant === null) throw new Error("Expected the stored Grant.");
          transaction.updateGrant({
            ...grant,
            credential: {
              ...grant.credential,
              iv: "iv-current-downgrade",
              ciphertext: "ciphertext-current-downgrade",
              tag: "tag-current-downgrade",
              lookupDigest: "digest-current-downgrade",
              fingerprint: `opaque-migration-reference-v1:${"a".repeat(64)}`,
            },
          });
        });
        expect(await storage.readiness()).toMatchObject({
          ok: false,
          status: "integrity-failure",
        });
        expect(
          await authority.createControlGrant({
            scope: { ...createScope(), pitchSlotId: "slot-after-active-downgrade" },
            actor: createActor(),
          }),
        ).toMatchObject({ status: "rejected", reason: "unavailable" });
      });

      await withStorage(createStorage, async (storage) => {
        const authority = createAuthority(storage);
        const created = await createGrant(authority);
        await storage.transaction((transaction) => {
          const grant = transaction.findGrantById(created.grantId);
          if (grant === null) throw new Error("Expected the stored Grant.");
          transaction.updateGrant({
            ...grant,
            status: "expired",
            credential: {
              ...grant.credential,
              materialState: "erased",
              encryptionKeyVersion: null,
              lookupKeyVersion: null,
              iv: null,
              ciphertext: null,
              tag: null,
              lookupDigest: null,
              fingerprint: `opaque-migration-reference-v1:${"b".repeat(64)}`,
            },
          });
        });
        expect(await storage.readiness()).toMatchObject({
          ok: false,
          status: "integrity-failure",
        });
        expect(
          await authority.createControlGrant({
            scope: { ...createScope(), pitchSlotId: "slot-after-erased-downgrade" },
            actor: createActor(),
          }),
        ).toMatchObject({ status: "rejected", reason: "unavailable" });
      });
    },
  );

  register(
    "erases every capability secret across terminal expiry states exactly once",
    async () => {
      await withStorage(createStorage, async (storage) => {
        let nowMs = 1_000;
        const authority = createAuthority(storage, { nowMs: () => nowMs });
        const created = await authority.createControlGrant({
          scope: createScope(),
          actor: createActor(),
          expiresAtMs: 1_100,
        });
        expect(created.status).toBe("created");
        if (created.status !== "created") throw new Error("Expected an expiring Control Grant.");
        const admitted = await admit(authority, created.qrCredential, "browser-a");
        expect(await authority.disableControlGrant(created.grantId, createActor())).toMatchObject({
          status: "updated",
        });
        nowMs = 1_100;

        const firstAudit = await readGrantAudit(authority, created.grantId);
        const secondAudit = await readGrantAudit(authority, created.grantId);
        expect(secondAudit.filter((entry) => entry.action === "grant-expired")).toHaveLength(1);
        expect(firstAudit.filter((entry) => entry.action === "grant-expired")).toHaveLength(1);
        const stored = await storage.transaction((transaction) => ({
          grant: transaction.findGrantById(created.grantId),
          sessions: transaction.listGrantSessions(created.grantId),
        }));
        expect(stored.grant?.status).toBe("expired");
        expect(stored.grant?.credential).toMatchObject({
          materialState: "erased",
          encryptionKeyVersion: null,
          lookupKeyVersion: null,
          iv: null,
          ciphertext: null,
          tag: null,
          lookupDigest: null,
        });
        expect(stored.grant?.credential.fingerprint).toEqual(
          expect.stringMatching(/^[A-Za-z0-9_-]+$/),
        );
        expect(stored.sessions).toEqual([
          expect.objectContaining({
            sessionId: admitted.grantSessionId,
            status: "expired",
            bearerMaterialState: "erased",
            bearerLookupVerifier: null,
            bearerLookupKeyVersion: null,
          }),
        ]);
        expect(
          await authority.rotateControlGrantCredentialKeys(created.grantId, createActor()),
        ).toEqual({
          status: "rejected",
          reason: "unavailable",
          detail: "The Grant credential cannot be rotated.",
        });
      });

      await withStorage(createStorage, async (storage) => {
        let nowMs = 1_000;
        const authority = createAuthority(storage, { nowMs: () => nowMs });
        const revoked = await authority.createControlGrant({
          scope: createScope(),
          actor: createActor(),
          expiresAtMs: 1_100,
        });
        expect(revoked.status).toBe("created");
        if (revoked.status !== "created") throw new Error("Expected an expiring Control Grant.");
        expect(await authority.revokeControlGrant(revoked.grantId, createActor())).toMatchObject({
          status: "updated",
        });
        nowMs = 1_100;
        const audit = await readGrantAudit(authority, revoked.grantId);
        const stored = await storage.transaction((transaction) =>
          transaction.findGrantById(revoked.grantId),
        );
        expect(stored?.status).toBe("expired");
        expect(audit.filter((entry) => entry.action === "grant-expired")).toHaveLength(1);
      });
    },
  );

  register("returns the typed session-context constraint from both adapter paths", async () => {
    await withStorage(createStorage, async (storage) => {
      const authority = createAuthority(storage);
      const created = await createGrant(authority);
      const admitted = await admit(authority, created.qrCredential, "browser-a");
      const first = await storage.transaction((transaction) => {
        const session = transaction.findSessionByBearerVerifier("unused", "unused");
        return transaction.listGrantSessions(created.grantId)[0] ?? session;
      });
      if (first === null || first === undefined) throw new Error("Expected a stored session.");

      let insertFailure: unknown;
      try {
        await storage.transaction((transaction) => {
          transaction.insertGrantSession({
            ...first,
            sessionId: `${admitted.grantSessionId}-insert-conflict`,
            bearerLookupVerifier: "different-verifier",
            status: "active",
            revokedAtMs: null,
          });
        });
      } catch (error) {
        insertFailure = error;
      }
      expect(insertFailure).toBeInstanceOf(FoundationStorageConstraintError);
      expect((insertFailure as FoundationStorageConstraintError).constraint).toBe(
        "grant-session-context",
      );

      let updateFailure: unknown;
      try {
        await storage.transaction((transaction) => {
          transaction.insertGrantSession({
            ...first,
            sessionId: `${admitted.grantSessionId}-update-conflict`,
            browserContextDigest: "different-context",
            bearerLookupVerifier: "another-verifier",
            status: "active",
            revokedAtMs: null,
          });
          transaction.updateGrantSession({
            ...first,
            sessionId: `${admitted.grantSessionId}-update-conflict`,
            bearerLookupVerifier: "another-verifier",
            status: "active",
            revokedAtMs: null,
          });
        });
      } catch (error) {
        updateFailure = error;
      }
      expect(updateFailure).toBeInstanceOf(FoundationStorageConstraintError);
      expect((updateFailure as FoundationStorageConstraintError).constraint).toBe(
        "grant-session-context",
      );
    });
  });

  register("contains storage failures behind typed redacted authority outcomes", async () => {
    await withStorage(createStorage, async (storage) => {
      const authority = createAuthority(createFailingStorage(storage));
      const input = { scope: createScope(), actor: createActor() };
      expect(await authority.createControlGrant(input)).toEqual({
        status: "rejected",
        reason: "unavailable",
        detail: "Grant authority storage is temporarily unavailable.",
      });
      expect(await authority.revealControlGrant("grant-failure", createActor())).toEqual({
        status: "rejected",
        reason: "unavailable",
        detail: "The Grant cannot be revealed.",
      });
      expect(await authority.disableControlGrant("grant-failure", createActor())).toEqual({
        status: "rejected",
        reason: "unavailable",
        detail: "Grant authority storage is temporarily unavailable.",
      });
      expect(await authority.revokeControlGrant("grant-failure", createActor())).toEqual({
        status: "rejected",
        reason: "unavailable",
        detail: "Grant authority storage is temporarily unavailable.",
      });
      expect(
        await authority.rotateControlGrantCredentialKeys("grant-failure", createActor()),
      ).toEqual({
        status: "rejected",
        reason: "unavailable",
        detail: "The Grant credential cannot be rotated.",
      });
      expect(await authority.listGrantSessions("grant-failure", createActor())).toEqual({
        status: "unavailable",
        code: "grant-storage-unavailable",
        message: "Grant authority storage is temporarily unavailable.",
      });
      expect(await authority.listGrantAudit("grant-failure", createActor())).toEqual({
        status: "unavailable",
        code: "grant-storage-unavailable",
        message: "Grant authority storage is temporarily unavailable.",
      });
    });
  });

  registerGrantRotationContract(register, createStorage);
}

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

function createFailingStorage(storage: FoundationStorage): FoundationStorage {
  return {
    transaction<T>(): Promise<T> {
      return Promise.reject(new Error("sqlite secret failure must not escape"));
    },
    readRoot(): Promise<null> {
      return Promise.reject(new Error("sqlite secret failure must not escape"));
    },
    readActions(): Promise<never> {
      return Promise.reject(new Error("sqlite secret failure must not escape"));
    },
    readIdempotencyEntries(): Promise<never> {
      return Promise.reject(new Error("sqlite secret failure must not escape"));
    },
    readRecordMetadata(): Promise<never> {
      return Promise.reject(new Error("sqlite secret failure must not escape"));
    },
    readAuditEntries(): Promise<never> {
      return Promise.reject(new Error("sqlite secret failure must not escape"));
    },
    readiness() {
      return storage.readiness();
    },
    close() {
      storage.close();
    },
  };
}

async function runGrantScenario(storage: FoundationStorage): Promise<void> {
  const authority = createAuthority(storage);
  const created = await createGrant(authority);
  const parsedCredential = parseCredentialToken(created.qrCredential);
  expect(parsedCredential).not.toBeNull();
  if (parsedCredential === null) throw new Error("Expected a parseable QR credential.");
  expect(Buffer.from(parsedCredential.entropy, "base64url").byteLength).toBe(32);

  const admitted = await admit(authority, created.qrCredential, "browser-a");
  expect(admitted.grantId).toBe(created.grantId);
  expect(admitted.eventGameId).toBe("game-1");
  expect(admitted.sessionBearer).toEqual(expect.any(String));
  expect(
    await authority.authorizeControlGrant({ sessionBearer: admitted.sessionBearer }),
  ).toMatchObject({
    status: "authorized",
    grantId: created.grantId,
    eventGameId: "game-1",
    scope: createScope(),
  });
}

async function createGrant(authority: GrantAuthority) {
  const result = await authority.createControlGrant({ scope: createScope(), actor: createActor() });
  expect(result.status).toBe("created");
  if (result.status !== "created") throw new Error("Expected a created Control Grant.");
  return result;
}

async function admit(authority: GrantAuthority, qrCredential: string, browserContext: string) {
  const result = await authority.admitControlGrant({ qrCredential, browserContext });
  expect(result.status).toBe("admitted");
  if (result.status !== "admitted") throw new Error("Expected an admitted Grant Session.");
  return result;
}

async function readGrantSessions(authority: GrantAuthority, grantId: string) {
  const result = await authority.listGrantSessions(grantId, createActor());
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error("Expected Grant Session read evidence.");
  return result.value;
}

async function readGrantAudit(authority: GrantAuthority, grantId: string) {
  const result = await authority.listGrantAudit(grantId, createActor());
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error("Expected Grant Audit read evidence.");
  return result.value;
}

function createAuthority(
  storage: FoundationStorage,
  configuration: {
    environmentId?: string;
    keyRing?: GrantKeyRing;
    randomness?: GrantRandomness;
    nowMs?: () => number;
    resolve?: (scope: ControlGrantScope) => ControlGrantScopeResolution;
  } = {},
): GrantAuthority {
  return createLegacyControlGrantTestAuthority(storage, {
    environmentId: configuration.environmentId ?? "test-environment",
    clock: { nowMs: configuration.nowMs ?? (() => 1_000) },
    randomness: configuration.randomness ?? createDeterministicRandomness(),
    keyRing: configuration.keyRing ?? createKeyRing(),
    privilegedAuthorityVerifier: createGrantTestAuthorityVerifier(),
    controlScopeResolver: {
      resolve(scope) {
        if (configuration.resolve !== undefined) return configuration.resolve(scope);
        expect(scope).toEqual(createScope());
        return { status: "eligible", eventGameId: "game-1" };
      },
    },
  });
}

export function createGrantTestScope(): ControlGrantScope {
  return createScope();
}

export function createGrantTestKeyRing(): GrantKeyRing {
  return createKeyRing();
}

export function createGrantTestRotatedKeyRing(original: GrantKeyRing): GrantKeyRing {
  return createRotatedKeyRing(original);
}

export function createGrantTestCurrentOnlyKeyRing(keyRing: GrantKeyRing): GrantKeyRing {
  return keepOnlyCurrentKeys(keyRing);
}

export function createGrantTestRandomness(seed = 0): GrantRandomness {
  return createDeterministicRandomness(seed);
}

function createScope(): ControlGrantScope {
  return {
    eventId: "event-1",
    gameDayId: "day-1",
    pitchId: "pitch-1",
    pitchSlotId: "slot-1",
  };
}

function createActor(): GrantAuthorityActor {
  return { kind: "fixture", id: "fixture-authority" };
}

function createDeterministicRandomness(seed = 0): GrantRandomness {
  let randomCall = 0;
  return {
    bytes(length) {
      randomCall += 1;
      return Uint8Array.from({ length }, (_, index) => (index + length + randomCall + seed) % 256);
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

async function expectAtomicAuditRollback(storage: FoundationStorage, grantId: string) {
  const audit = await storage.transaction((transaction) => transaction.listGrantAudit(grantId));
  const firstAudit = audit[0];
  if (firstAudit === undefined) throw new Error("Expected Grant audit evidence.");
  let failure: unknown;
  try {
    await storage.transaction((transaction) => {
      const grant = transaction.findGrantById(grantId);
      if (grant === null) throw new Error("Expected the Grant.");
      transaction.updateGrant({ ...grant, status: "disabled" });
      transaction.appendGrantAudit(firstAudit);
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(
    (await storage.transaction((transaction) => transaction.findGrantById(grantId)))?.status,
  ).toBe("active");
  expect(
    (await storage.transaction((transaction) => transaction.listGrantAudit(grantId))).length,
  ).toBe(audit.length);
}
