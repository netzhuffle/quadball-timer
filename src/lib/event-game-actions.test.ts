import { describe, expect, test } from "bun:test";
import {
  createControlActionCodecRegistry,
  createDeterministicTestIqaInterpreter,
  prepareControlAction,
  sha256,
  type ControlActionInput,
  type ControlAuditEntry,
} from "@/lib/event-game-actions";
import {
  createEventGameRecord,
  type ControlAuditAuthorityVerifier,
  type ExternalScopeResolver,
} from "@/lib/event-game-record";
import type {
  FoundationStorage,
  FoundationStorageSnapshot,
  FoundationStorageTransaction,
  StoredControlAction,
} from "@/lib/foundation-storage";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";

describe("immutable Event Game actions", () => {
  test("retains an operation identity beyond 10,000 later actions and rebuilds through IQA", async () => {
    const root = createRoot("record-permanent");
    const storage = createInMemoryFoundationStorage();
    const record = createEventGameRecord(storage, {
      externalScopeResolver: createScopeResolver(root),
      clock: () => 10_000,
      interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      auditAuthorityVerifier: testAuditAuthorityVerifier,
    });

    expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
    const first = createFact(root, "operation-first", 1_000);
    expect(await record.acceptAction(first)).toMatchObject({ status: "accepted" });

    for (let index = 0; index < 10_001; index += 1) {
      const operationId = `operation-later-${index}`;
      expect(
        await record.acceptAction(createFact(root, operationId, 2_000 + index, `fact-${index}`)),
      ).toMatchObject({ status: "accepted" });
    }

    expect(await record.acceptAction(first)).toMatchObject({
      status: "duplicate-accepted",
      action: { operationId: "operation-first" },
    });

    const rebuild = await record.rebuild();
    expect(rebuild).toMatchObject({ status: "ready" });
    if (rebuild.status !== "ready") throw new Error("Expected a ready rebuild.");
    expect(rebuild.canonicalActions[0]?.operationId).toBe("operation-first");
    expect(rebuild.effectiveFacts[0]?.factId).toBe("fact-operation-first");
    expect(rebuild.derivedGameState).toMatchObject({ interpreterVersion: "rules-v1" });
    expect((await record.readAudit(createAuditAuthority())).length).toBe(10_002);
  }, 30_000);

  test("orders independent actions canonically and applies a correction without mutable history", async () => {
    const firstRoot = createRoot("record-order-a");
    const secondRoot = createRoot("record-order-b");
    const first = await createRecord(firstRoot);
    const second = await createRecord(secondRoot);
    const early = createFact(firstRoot, "operation-early", 1_000, "fact-early");
    const late = createFact(firstRoot, "operation-late", 2_000, "fact-late");
    const earlyOther = createFact(secondRoot, "operation-early", 1_000, "fact-early");
    const lateOther = createFact(secondRoot, "operation-late", 2_000, "fact-late");

    await first.acceptAction(late);
    await first.acceptAction(early);
    await second.acceptAction(earlyOther);
    await second.acceptAction(lateOther);
    const firstRebuild = await first.rebuild();
    const secondRebuild = await second.rebuild();
    expect(firstRebuild).toMatchObject({ status: "ready" });
    expect(secondRebuild).toMatchObject({ status: "ready" });
    if (firstRebuild.status !== "ready" || secondRebuild.status !== "ready") {
      throw new Error("Expected ready rebuilds.");
    }
    expect(firstRebuild.canonicalActions.map((action) => action.operationId)).toEqual(
      secondRebuild.canonicalActions.map((action) => action.operationId),
    );

    const correction: ControlActionInput = {
      ...createFact(firstRoot, "operation-correction", 3_000, "fact-late"),
      kind: { id: "correction", version: "1" },
      payload: {
        correctionId: "correction-1",
        targetFactId: "fact-late",
        effective: false,
      },
    };
    expect(await first.acceptAction(correction)).toMatchObject({ status: "accepted" });
    const correctedRebuild = await first.rebuild();
    expect(correctedRebuild.status).toBe("ready");
    if (correctedRebuild.status !== "ready") {
      throw new Error("Expected corrected action history to be ready");
    }
    expect(correctedRebuild.effectiveFacts.map((fact) => fact.factId)).toEqual(["fact-early"]);
    expect((await first.readActions()).map((stored) => stored.action.operationId)).toEqual([
      "operation-late",
      "operation-early",
      "operation-correction",
    ]);
  });

  test("rejects unsupported versions, invalid occurrence evidence, and broken references", async () => {
    const root = createRoot("record-validation");
    const record = await createRecord(root);
    const validAction = createFact(root, "operation-validation", 1_000);

    expect(
      await record.acceptAction({
        ...validAction,
        kind: { id: "game-fact", version: "2" },
      }),
    ).toMatchObject({ status: "rejected", reason: "unsupported-action" });
    expect(
      await record.acceptAction({
        ...validAction,
        occurrence: {
          trustedAtMs: 130_001,
          clientOriginAtMs: 130_001,
          source: "online",
        },
      }),
    ).toMatchObject({ status: "rejected", reason: "invalid-action" });
    expect(
      await record.acceptAction({
        ...validAction,
        operationId: "operation-missing-dependency",
        causalPredecessorIds: ["operation-not-retained"],
      }),
    ).toMatchObject({ status: "rejected", reason: "missing-dependency" });
    expect(
      await record.acceptAction({
        ...validAction,
        operationId: "operation-self-cycle",
        causalPredecessorIds: ["operation-self-cycle"],
      }),
    ).toMatchObject({ status: "rejected", reason: "cyclic-dependency" });
    expect(
      await record.acceptAction({
        ...validAction,
        eventGameId: "another-event-game",
      }),
    ).toMatchObject({ status: "rejected", reason: "invalid-action" });
    expect((await record.readActions()).length).toBe(0);
  });

  test("fails rebuild and readiness for incompatible or nondeterministic interpreters", async () => {
    const versionRoot = createRoot("record-interpreter-version");
    const versionRecord = createEventGameRecord(createInMemoryFoundationStorage(), {
      externalScopeResolver: createScopeResolver(versionRoot),
      interpreter: createDeterministicTestIqaInterpreter("rules-v2"),
    });
    expect(await versionRecord.registerRoot(versionRoot)).toMatchObject({ status: "registered" });
    expect(await versionRecord.rebuild()).toMatchObject({
      status: "failed",
      reason: "unknown-interpreter-version",
    });
    expect(await versionRecord.readiness()).toMatchObject({
      ok: false,
      status: "rebuild-failure",
    });
    expect(
      await versionRecord.acceptAction(
        createFact(versionRoot, "operation-after-version-failure", 2_000),
      ),
    ).toMatchObject({ status: "rejected", reason: "storage-not-ready" });

    const nondeterministicRoot = createRoot("record-interpreter-nondeterministic");
    let rebuildCount = 0;
    const nondeterministicRecord = createEventGameRecord(createInMemoryFoundationStorage(), {
      externalScopeResolver: createScopeResolver(nondeterministicRoot),
      interpreter: {
        version: "rules-v1",
        rebuild() {
          rebuildCount += 1;
          return { rebuildCount };
        },
      },
    });
    expect(await nondeterministicRecord.registerRoot(nondeterministicRoot)).toMatchObject({
      status: "registered",
    });
    expect(
      await nondeterministicRecord.acceptAction(
        createFact(nondeterministicRoot, "operation-nondeterministic", 1_000),
      ),
    ).toMatchObject({ status: "rejected", reason: "storage-not-ready" });
    expect(await nondeterministicRecord.readActions()).toHaveLength(0);
    expect(await nondeterministicRecord.rebuild()).toMatchObject({
      status: "failed",
      reason: "nondeterministic-interpreter",
    });
    expect(await nondeterministicRecord.readiness()).toMatchObject({
      ok: false,
      status: "rebuild-failure",
    });
  });

  test("requires an explicitly injected interpreter and rejects forgeable audit credentials", async () => {
    const root = createRoot("record-explicit-interpreter");
    const storage = createInMemoryFoundationStorage();
    const record = createEventGameRecord(storage, {
      externalScopeResolver: createScopeResolver(root),
    });
    expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
    expect(
      await record.acceptAction(createFact(root, "operation-no-interpreter", 1_000)),
    ).toMatchObject({
      status: "rejected",
      reason: "storage-not-ready",
    });
    expect(await record.readActions()).toHaveLength(0);
    expect(record.readAudit(createTestAuditAuthority("event-admin").credential)).rejects.toThrow(
      "trusted",
    );
    expect(record.readAudit({ verify: () => true })).rejects.toThrow("trusted");
    expect(record.readAudit(Object.freeze({ role: "event-admin" }))).rejects.toThrow("trusted");

    const trusted = createTestAuditAuthority("event-admin");
    const authorizedRecord = createEventGameRecord(storage, {
      externalScopeResolver: createScopeResolver(root),
      auditAuthorityVerifier: trusted.verifier,
      interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
    });
    expect(await authorizedRecord.registerRoot(root)).toMatchObject({ status: "idempotent" });
    expect(await authorizedRecord.readAudit(trusted.credential)).toHaveLength(0);
    expect(
      authorizedRecord.readAudit(createTestAuditAuthority("technical-admin").credential),
    ).rejects.toThrow("trusted");
    storage.close();
  });

  test("blocks authoritative writes when retained memory history is semantically corrupt", async () => {
    const corruptions: readonly [
      string,
      (snapshot: FoundationStorageSnapshot) => FoundationStorageSnapshot,
    ][] = [
      [
        "missing audit evidence",
        (snapshot) => ({
          ...snapshot,
          listAuditEntries: () => [],
        }),
      ],
      [
        "inconsistent metadata",
        (snapshot) => ({
          ...snapshot,
          readRecordMetadata: () => ({
            recordId: "record-corrupt",
            actionCount: 0,
            orderingVersion: "causal-occurrence-operation-v1",
            lastAcceptedAtMs: null,
            updatedAtMs: 500,
          }),
        }),
      ],
      [
        "unknown action version",
        (snapshot) => ({
          ...snapshot,
          listActions: (recordId) =>
            snapshot.listActions(recordId).map((stored) => ({
              ...stored,
              action: { ...stored.action, kind: { id: "game-fact", version: "99" } },
            })),
        }),
      ],
      [
        "missing dependency",
        (snapshot) => ({
          ...snapshot,
          listActions: (recordId) =>
            patchStoredActions(snapshot.listActions(recordId), {
              causalPredecessorIds: ["operation-not-retained"],
            }),
        }),
      ],
      [
        "causal cycle",
        (snapshot) => ({
          ...snapshot,
          listActions: (recordId) =>
            patchStoredActions(snapshot.listActions(recordId), {
              causalPredecessorIds: ["operation-corrupt"],
            }),
        }),
      ],
      [
        "idempotency mismatch",
        (snapshot) => ({
          ...snapshot,
          listIdempotencyEntries: () => [],
        }),
      ],
    ];

    for (const [label, corruption] of corruptions) {
      const root = createRoot(`record-corrupt-${label.replaceAll(" ", "-")}`);
      const baseStorage = createInMemoryFoundationStorage();
      const writer = createEventGameRecord(baseStorage, {
        externalScopeResolver: createScopeResolver(root),
        clock: () => 10_000,
        interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      });
      expect(await writer.registerRoot(root)).toMatchObject({ status: "registered" });
      expect(await writer.acceptAction(createFact(root, "operation-corrupt", 1_000))).toMatchObject(
        {
          status: "accepted",
        },
      );

      const corruptStorage = createCorruptingStorage(baseStorage, corruption);
      const record = createEventGameRecord(corruptStorage, {
        externalScopeResolver: createScopeResolver(root),
        clock: () => 10_000,
        interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      });
      expect(await record.registerRoot(root)).toMatchObject({ status: "idempotent" });
      expect(
        await record.acceptAction(
          createFact(root, `operation-after-${label.replaceAll(" ", "-")}`, 2_000),
        ),
      ).toMatchObject({ status: "rejected", reason: "storage-not-ready" });
      expect(await baseStorage.readActions(root.recordId)).toHaveLength(1);
      expect(await baseStorage.readAuditEntries(root.recordId)).toHaveLength(1);
      baseStorage.close();
    }
  });

  test("binds retained memory collision evidence to the rejected Control Action input", async () => {
    const root = createRoot("record-collision-evidence");
    const baseStorage = createInMemoryFoundationStorage();
    const writer = createEventGameRecord(baseStorage, {
      externalScopeResolver: createScopeResolver(root),
      clock: () => 10_000,
      interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
    });
    expect(await writer.registerRoot(root)).toMatchObject({ status: "registered" });
    const accepted = createFact(root, "operation-collision", 1_000);
    expect(await writer.acceptAction(accepted)).toMatchObject({ status: "accepted" });
    expect(
      await writer.acceptAction({
        ...accepted,
        payload: { ...(accepted.payload as Record<string, unknown>), data: { rejected: true } },
      }),
    ).toMatchObject({ status: "rejected", reason: "operation-conflict" });
    expect(await writer.readiness()).toMatchObject({ ok: true, actionCount: 1 });
    expect(
      await writer.acceptAction(createFact(root, "operation-after-collision", 2_000)),
    ).toMatchObject({ status: "accepted" });

    const corruptions: readonly [string, (entry: ControlAuditEntry) => void][] = [
      [
        "interpretation",
        (entry) => {
          const rejected = requiredCollision(entry).rejectedAttempt;
          if (rejected.interpretation.type !== "fact") throw new Error("Expected Fact evidence.");
          rejected.interpretation = {
            ...rejected.interpretation,
            factType: "tampered-fact-type",
          };
        },
      ],
      [
        "canonical-content",
        (entry) => {
          requiredCollision(entry).rejectedAttempt.canonicalContent = "{}";
        },
      ],
      [
        "fingerprint",
        (entry) => {
          const rejected = requiredCollision(entry).rejectedAttempt;
          rejected.contentFingerprint = "f".repeat(64);
          entry.auditId = `audit-${sha256(`${root.recordId}:operation-conflict:${entry.operationId}:${rejected.contentFingerprint}`)}`;
        },
      ],
    ];

    for (const [label, mutate] of corruptions) {
      const corruptStorage = createCorruptingStorage(baseStorage, (snapshot) => ({
        ...snapshot,
        listAuditEntries: (recordId) =>
          snapshot.listAuditEntries(recordId).map((entry) => {
            if (entry.kind !== "action-conflict") return entry;
            const corrupted = structuredClone(entry);
            mutate(corrupted);
            return corrupted;
          }),
      }));
      const record = createEventGameRecord(corruptStorage, {
        externalScopeResolver: createScopeResolver(root),
        clock: () => 10_000,
        interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      });
      expect(await record.registerRoot(root)).toMatchObject({ status: "idempotent" });
      expect(await record.readiness(), label).toMatchObject({
        ok: false,
        status: "rebuild-failure",
      });
    }
    baseStorage.close();
  });

  test("retains explicit recovery provenance with the immutable action", async () => {
    const root = createRoot("record-recovery-provenance");
    const record = await createRecord(root);
    const action = {
      ...createFact(root, "operation-recovered", 1_000),
      recoveryProvenance: {
        importId: "recovery-import-1",
        sourceRecordId: root.recordId,
        sourceEventGameId: root.eventGameId,
        sourceOperationId: "operation-recovered",
        sourceReference: "controller-queue-1",
        sourceAcceptedAtMs: null,
      },
    };
    expect(await record.acceptAction(action)).toMatchObject({ status: "accepted" });
    expect(await record.readRecoveryProvenance()).toEqual([action.recoveryProvenance]);
    expect(await record.rebuild()).toMatchObject({ status: "ready" });
  });
});

async function createRecord(root: EventGameRecordRoot) {
  const storage = createInMemoryFoundationStorage();
  const record = createEventGameRecord(storage, {
    externalScopeResolver: createScopeResolver(root),
    clock: () => 10_000,
    interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
    auditAuthorityVerifier: testAuditAuthorityVerifier,
  });
  expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
  return record;
}

function createAuditAuthority(): object {
  return testAuditAuthority.credential;
}

function createTestAuditAuthority(role: "event-admin" | "technical-admin"): {
  credential: object;
  verifier: ControlAuditAuthorityVerifier;
} {
  const credentials = new WeakSet<object>();
  const credential = Object.freeze({ role });
  credentials.add(credential);
  return {
    credential,
    verifier: {
      verify(candidate) {
        return typeof candidate === "object" && candidate !== null && credentials.has(candidate);
      },
    },
  };
}

const testAuditAuthority = createTestAuditAuthority("event-admin");
const testAuditAuthorityVerifier = testAuditAuthority.verifier;

function createCorruptingStorage(
  storage: FoundationStorage,
  corruption: (snapshot: FoundationStorageSnapshot) => FoundationStorageSnapshot,
): FoundationStorage {
  const snapshot = (base: FoundationStorageSnapshot): FoundationStorageSnapshot => corruption(base);
  return {
    transaction(work) {
      return storage.transaction((transaction) =>
        work(snapshot(transaction) as FoundationStorageTransaction),
      );
    },
    readRoot: (recordId) => storage.readRoot(recordId),
    readActions: async (recordId) =>
      snapshot(await readSnapshot(storage, recordId)).listActions(recordId),
    readIdempotencyEntries: async (recordId) =>
      snapshot(await readSnapshot(storage, recordId)).listIdempotencyEntries(recordId),
    readRecordMetadata: async (recordId) =>
      snapshot(await readSnapshot(storage, recordId)).readRecordMetadata(recordId),
    readAuditEntries: async (recordId) =>
      snapshot(await readSnapshot(storage, recordId)).listAuditEntries(recordId),
    readiness: () => storage.readiness(),
    close: () => storage.close(),
  };
}

function requiredCollision(entry: ControlAuditEntry) {
  const collision = entry.links?.collision;
  if (collision === undefined) throw new Error("Expected rejected collision evidence.");
  return collision;
}

async function readSnapshot(
  storage: FoundationStorage,
  recordId: string,
): Promise<FoundationStorageSnapshot> {
  const [root, actions, idempotency, metadata, audits] = await Promise.all([
    storage.readRoot(recordId),
    storage.readActions(recordId),
    storage.readIdempotencyEntries(recordId),
    storage.readRecordMetadata(recordId),
    storage.readAuditEntries(recordId),
  ]);
  return {
    revision: 0,
    findRootByRecordId: () => root,
    findRootByEventGameId: () => root,
    findRootByPitchSlotId: () => root,
    findRootByGameSideId: () => root,
    findActionByOperationId: (_recordId, operationId) =>
      actions.find((stored) => stored.action.operationId === operationId) ?? null,
    listActions: () => actions,
    listIdempotencyEntries: () => idempotency,
    readRecordMetadata: () => metadata,
    listAuditEntries: () => audits,
    findGrantById: () => null,
    listGrants: () => [],
    findGrantByCredentialLookupDigest: () => null,
    findActiveSessionByGrantAndContext: () => null,
    findSessionByBearerVerifier: () => null,
    listGrantSessions: () => [],
    listGrantAudit: () => [],
  };
}

function patchStoredActions(
  storedActions: readonly StoredControlAction[],
  patch: Partial<ControlActionInput>,
): StoredControlAction[] {
  const registry = createControlActionCodecRegistry();
  return storedActions.map((stored) => {
    const action = { ...stored.action, ...patch };
    const prepared = prepareControlAction(
      action,
      createRoot(action.recordId),
      registry,
      action.acceptedAtMs,
    );
    if (!prepared.ok) throw new Error(`Could not prepare corrupt action: ${prepared.error}`);
    return {
      action,
      canonicalContent: prepared.value.canonicalContent,
      contentFingerprint: prepared.value.contentFingerprint,
    };
  });
}

function createFact(
  root: EventGameRecordRoot,
  operationId: string,
  trustedAtMs: number,
  factId = `fact-${operationId}`,
): ControlActionInput {
  return {
    recordId: root.recordId,
    eventGameId: root.eventGameId,
    operationId,
    kind: { id: "game-fact", version: "1" },
    payload: {
      factId,
      factType: "deterministic-test-fact",
      gameSideId: "side-a",
      gameTimeMs: trustedAtMs,
      data: { operationId },
    },
    causalPredecessorIds: [],
    occurrence: {
      trustedAtMs,
      clientOriginAtMs: trustedAtMs,
      source: "online",
    },
    grant: {
      sessionId: "session-1",
      versionId: "grant-version-1",
    },
    lifecycle: structuredClone(root.lifecycle),
  };
}

function createRoot(recordId: string): EventGameRecordRoot {
  return {
    recordId,
    eventId: `event-${recordId}`,
    eventGameId: `event-game-${recordId}`,
    ownership: {
      eventId: `event-${recordId}`,
      eventGameId: `event-game-${recordId}`,
    },
    externalScope: {
      eventId: `event-${recordId}`,
      gameDayId: `day-${recordId}`,
      pitchId: `pitch-${recordId}`,
      pitchSlotId: `slot-${recordId}`,
    },
    gameSides: [
      {
        id: "side-a",
        eventTeamId: "team-a",
        teamInterpretationRef: "interpretation-a",
      },
      {
        id: "side-b",
        eventTeamId: "team-b",
        teamInterpretationRef: "interpretation-b",
      },
    ],
    lifecycle: {
      phase: "scheduled",
      commencedAtMs: null,
      finishedAtMs: null,
      lockedAtMs: null,
      lockReason: null,
    },
    compatibility: {
      recordVersion: "record-v1",
      schemaVersion: "schema-v1",
      interpreterVersion: "rules-v1",
    },
    creationEvidence: {
      operationId: `register-${recordId}`,
      actorReference: "event-admin-session-1",
      source: "event-game-registration",
      createdAtMs: 500,
    },
  };
}

function createScopeResolver(root: EventGameRecordRoot): ExternalScopeResolver {
  return {
    resolve(scope) {
      return JSON.stringify(scope) === JSON.stringify(root.externalScope)
        ? { status: "resolved", scope: structuredClone(scope) }
        : { status: "mismatch", detail: "The external scope does not match the root." };
    },
    resolveEventTeam(eventId, eventTeamId) {
      return eventId === root.eventId && eventTeamId.length > 0
        ? { status: "resolved" }
        : { status: "mismatch", detail: "The Event Team is outside the Event scope." };
    },
  };
}
