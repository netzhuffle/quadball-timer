import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeJson } from "@/lib/event-game-action-json";
import { createDeterministicTestIqaInterpreter } from "@/lib/event-game-actions";
import { createEventGameRecord } from "@/lib/event-game-record";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import { createGrantTestKeyRing, createGrantTestRandomness } from "@/lib/grant-authority-contract";
import {
  createGrantTestAuthorityVerifier,
  createLegacyControlGrantTestAuthority,
} from "@/lib/grant-authority-test-support";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import type { FoundationStorage } from "@/lib/foundation-storage";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import {
  applyGamePresentationChange,
  canonicalizeGamePresentationChange,
  fingerprintGamePresentationChange,
  type GamePresentation,
  type StoredGamePresentationAuditEntry,
  type StoredGamePresentationChange,
} from "@/lib/game-presentation";
import {
  presentationEvidenceFailure,
  presentationIntegrityAnchorFor,
} from "@/lib/presentation-integrity";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import type { GrantKeyRing, StoredGrantSession } from "@/lib/grant-types";

const root: EventGameRecordRoot = {
  recordId: "record-1",
  eventId: "event-1",
  eventGameId: "game-1",
  ownership: { eventId: "event-1", eventGameId: "game-1" },
  externalScope: {
    eventId: "event-1",
    gameDayId: "day-1",
    pitchId: "pitch-1",
    pitchSlotId: "slot-1",
  },
  gameSides: [
    { id: "side-a", eventTeamId: "team-a", teamInterpretationRef: "team-a" },
    { id: "side-b", eventTeamId: "team-b", teamInterpretationRef: "team-b" },
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
    operationId: "register-1",
    actorReference: "test",
    source: "event-game-registration",
    createdAtMs: 1,
  },
};

const keyRing: GrantKeyRing = {
  encryption: {
    currentVersion: "enc-v1",
    keys: new Map([["enc-v1", new Uint8Array(32).fill(1)]]),
  },
  lookup: {
    currentVersion: "lookup-v1",
    keys: new Map([["lookup-v1", new Uint8Array(32).fill(2)]]),
  },
  audit: {
    currentVersion: "audit-v1",
    keys: new Map([["audit-v1", new Uint8Array(32).fill(3)]]),
  },
};

const session: StoredGrantSession = {
  sessionId: "session-1",
  grantId: "grant-1",
  grantVersion: "grant-version-1",
  eventGameId: root.eventGameId,
  browserContextDigest: "browser-digest",
  browserContextKeyVersion: "lookup-v1",
  bearerMaterialState: "present",
  bearerLookupVerifier: "origin-proof",
  bearerLookupKeyVersion: "lookup-v1",
  status: "active",
  createdAtMs: 1,
  lastActiveAtMs: 1,
  revokedAtMs: null,
};

const initialPresentation: GamePresentation = {
  gameSideIds: root.gameSides.map((side) => side.id),
  pitchOrientation: "side-a-left",
  displayedTeamColors: { "side-a": "#112233", "side-b": "#445566" },
};

function createEvidence(
  grant = { sessionId: session.sessionId, versionId: session.grantVersion },
  evidenceKeyRing = keyRing,
  causalPredecessorIds = ["control-op-1"],
) {
  const changeWithoutIntegrity = {
    recordId: root.recordId,
    eventGameId: root.eventGameId,
    operationId: "presentation-op-1",
    presentationChangeId: "presentation-change-1",
    change: { type: "pitch-orientation", pitchOrientation: "side-b-left" } as const,
    causalPredecessorIds,
    occurrence: { trustedAtMs: 2, clientOriginAtMs: 2, source: "online" as const },
    grant,
  };
  const change: StoredGamePresentationChange = {
    ...changeWithoutIntegrity,
    acceptedAtMs: 3,
    canonicalContent: canonicalizeGamePresentationChange(changeWithoutIntegrity),
    contentFingerprint: fingerprintGamePresentationChange(changeWithoutIntegrity),
  };
  const resultingPresentation = applyGamePresentationChange(initialPresentation, change.change);
  const audit: StoredGamePresentationAuditEntry = {
    auditVersion: "control-audit-v1",
    auditId: "presentation-audit-1",
    recordId: root.recordId,
    eventGameId: root.eventGameId,
    operationId: change.operationId,
    presentationChangeId: change.presentationChangeId,
    kind: "presentation-accepted",
    classification: "game-presentation-change",
    outcome: "accepted",
    createdAtMs: 3,
    redactedDetail: "accepted",
    previousPresentation: initialPresentation,
    resultingPresentation,
    change: change.change,
    grant: change.grant,
  };
  const evidence = { recordId: root.recordId, changes: [change], audits: [audit] };
  return {
    change,
    audit,
    anchor: presentationIntegrityAnchorFor(evidence, 1, evidenceKeyRing),
    actionOperationIds: new Set(["control-op-1"]),
  };
}

describe("Game Presentation integrity", () => {
  test("accepts anchored evidence linked to the exact Grant Session and action causal predecessor", () => {
    const evidence = createEvidence();
    expect(
      presentationEvidenceFailure({
        root,
        changes: [evidence.change],
        audits: [evidence.audit],
        anchors: [evidence.anchor],
        sessions: [session],
        actionOperationIds: evidence.actionOperationIds,
        keyRing,
      }),
    ).toBeNull();
  });

  test("rejects altered snapshots and cross-session Grant provenance", () => {
    const evidence = createEvidence();
    const alteredAudit = {
      ...evidence.audit,
      resultingPresentation: {
        ...evidence.audit.resultingPresentation!,
        pitchOrientation: "side-a-left",
      } satisfies GamePresentation,
    };
    expect(
      presentationEvidenceFailure({
        root,
        changes: [evidence.change],
        audits: [alteredAudit],
        anchors: [evidence.anchor],
        sessions: [session],
        actionOperationIds: evidence.actionOperationIds,
        keyRing,
      }),
    ).not.toBeNull();

    const crossSession = {
      ...session,
      sessionId: "session-2",
      eventGameId: "other-game",
    };
    expect(
      presentationEvidenceFailure({
        root,
        changes: [evidence.change],
        audits: [evidence.audit],
        anchors: [evidence.anchor],
        sessions: [crossSession],
        actionOperationIds: evidence.actionOperationIds,
        keyRing,
      }),
    ).not.toBeNull();
  });

  test("anchors the complete immutable evidence set", () => {
    const evidence = createEvidence();
    expect(JSON.parse(evidence.anchor.canonicalValue)).toEqual({
      audits: [evidence.audit],
      changes: [evidence.change],
      domain: "game-presentation-evidence-v1",
      recordId: root.recordId,
      stateRevision: 1,
    });
    expect(canonicalizeJson(JSON.parse(evidence.anchor.canonicalValue))).toBe(
      evidence.anchor.canonicalValue,
    );
  });

  test("rejects impossible audit kind and outcome combinations and causal cycles", () => {
    const evidence = createEvidence();
    expect(
      presentationEvidenceFailure({
        root,
        changes: [evidence.change],
        audits: [{ ...evidence.audit, outcome: "rejected" }],
        anchors: [evidence.anchor],
        sessions: [session],
        actionOperationIds: evidence.actionOperationIds,
        keyRing,
      }),
    ).not.toBeNull();

    const second = {
      ...evidence.change,
      operationId: "presentation-op-2",
      presentationChangeId: "presentation-change-2",
      causalPredecessorIds: [evidence.change.operationId],
      occurrence: { ...evidence.change.occurrence, trustedAtMs: 1 },
    };
    const first = {
      ...evidence.change,
      causalPredecessorIds: [second.operationId],
    };
    expect(
      presentationEvidenceFailure({
        root,
        changes: [first, second],
        audits: [evidence.audit],
        anchors: [evidence.anchor],
        sessions: [session],
        actionOperationIds: evidence.actionOperationIds,
        keyRing,
      }),
    ).not.toBeNull();
  });

  test.each(["memory", "sqlite"] as const)(
    "%s validates presentation evidence after work and rolls back malformed transactions",
    async (kind) => {
      const harness = await createPresentationStorage(kind);
      try {
        const grant = harness.grant;
        const evidence = createEvidence(
          { sessionId: grant.grantSessionId, versionId: grant.grantVersion },
          harness.keyRing,
          [],
        );
        await harness.storage.transaction((transaction) => {
          transaction.insertPresentationChange!(evidence.change);
          transaction.appendPresentationAuditEntry!(evidence.audit);
          transaction.sealPresentationEvidence!(root.recordId);
        });
        expect(await harness.storage.readiness()).toMatchObject({ ok: true });
        expect(
          await harness.storage.transaction((transaction) =>
            transaction.listPresentationChanges!(root.recordId),
          ),
        ).toHaveLength(1);

        let malformedTransactionRejected = false;
        try {
          await harness.storage.transaction((transaction) => {
            const malformed = createEvidence(
              {
                sessionId: grant.grantSessionId,
                versionId: grant.grantVersion,
              },
              harness.keyRing,
              [],
            );
            const malformedChange = {
              ...malformed.change,
              operationId: "presentation-op-malformed",
              presentationChangeId: "presentation-change-malformed",
            };
            malformedChange.canonicalContent = canonicalizeGamePresentationChange(malformedChange);
            malformedChange.contentFingerprint = fingerprintGamePresentationChange(malformedChange);
            transaction.insertPresentationChange!(malformedChange);
            transaction.appendPresentationAuditEntry!({
              ...malformed.audit,
              auditId: "presentation-audit-malformed",
              operationId: malformedChange.operationId,
              presentationChangeId: malformedChange.presentationChangeId,
              change: malformedChange.change,
              outcome: "rejected",
            });
            const prior = transaction.listPresentationAuditEntries!(root.recordId).find(
              (audit) => audit.kind === "presentation-accepted",
            );
            if (prior === undefined) throw new Error("Expected the prior accepted audit.");
            transaction.appendPresentationAuditRevision!({
              ...prior,
              auditId: "presentation-audit-unsealed-revision",
              supersedesAuditId: prior.auditId,
            });
          });
        } catch {
          malformedTransactionRejected = true;
        }
        expect(malformedTransactionRejected).toBe(true);
        expect(
          await harness.storage.transaction((transaction) =>
            transaction.listPresentationChanges!(root.recordId),
          ),
        ).toHaveLength(1);
        expect(
          await harness.storage.transaction((transaction) =>
            transaction.listPresentationAuditEntries!(root.recordId),
          ),
        ).toHaveLength(1);
        expect(await harness.storage.readiness()).toMatchObject({ ok: true });
      } finally {
        await harness.cleanup();
      }
    },
  );

  test("keeps healthy SQLite presentation evidence ready across restart and freezes after raw anchor deletion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-timer-presentation-integrity-"));
    const databasePath = join(directory, "foundation.sqlite");
    try {
      const first = await createPresentationStorage("sqlite", databasePath);
      const grant = first.grant;
      const evidence = createEvidence(
        { sessionId: grant.grantSessionId, versionId: grant.grantVersion },
        first.keyRing,
        [],
      );
      await first.storage.transaction((transaction) => {
        transaction.insertPresentationChange!(evidence.change);
        transaction.appendPresentationAuditEntry!(evidence.audit);
        transaction.sealPresentationEvidence!(root.recordId);
      });
      expect(await first.storage.readiness()).toMatchObject({ ok: true });
      first.storage.close();

      const restarted = openSqliteFoundationStorage(databasePath, {
        grantKeyRing: first.keyRing,
        requireReplayContext: false,
      });
      expect(await restarted.readiness()).toMatchObject({ ok: true });
      restarted.close();

      const raw = new Database(databasePath);
      raw.exec("DROP TRIGGER foundation_event_game_presentation_integrity_no_delete");
      raw
        .query("DELETE FROM foundation_event_game_presentation_integrity WHERE record_id = ?")
        .run(root.recordId);
      raw.close();

      const frozen = openSqliteFoundationStorage(databasePath, {
        grantKeyRing: first.keyRing,
        requireReplayContext: false,
      });
      expect(await frozen.readiness()).toMatchObject({
        ok: false,
        status: "integrity-failure",
      });
      frozen.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(["memory", "sqlite"] as const)(
    "%s repairs a same-time z-first/a-later presentation audit with an append-only revision",
    async (kind) => {
      const harness = await createPresentationStorage(kind);
      try {
        await installSameTimeRepair(harness);
        expect(await harness.storage.readiness()).toMatchObject({ ok: true });
        const audits = await harness.storage.transaction((transaction) =>
          transaction.listPresentationAuditEntries!(root.recordId),
        );
        expect(audits).toHaveLength(3);
        expect(audits.filter((audit) => audit.supersedesAuditId !== undefined)).toHaveLength(1);
      } finally {
        await harness.cleanup();
      }
    },
  );

  test("freezes SQLite readiness when a presentation audit revision is deleted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-timer-presentation-revision-"));
    const databasePath = join(directory, "foundation.sqlite");
    try {
      const first = await createPresentationStorage("sqlite", databasePath);
      await installSameTimeRepair(first);
      expect(await first.storage.readiness()).toMatchObject({ ok: true });
      first.storage.close();
      const raw = new Database(databasePath);
      raw.exec("DROP TRIGGER foundation_event_game_presentation_audit_no_delete");
      raw
        .query(
          "DELETE FROM foundation_event_game_presentation_audit WHERE supersedes_audit_id IS NOT NULL",
        )
        .run();
      raw.close();
      const frozen = openSqliteFoundationStorage(databasePath, {
        grantKeyRing: first.keyRing,
        requireReplayContext: false,
      });
      expect(await frozen.readiness()).toMatchObject({
        ok: false,
        status: "integrity-failure",
      });
      frozen.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("freezes SQLite readiness when a presentation audit revision is altered", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-timer-presentation-revision-alter-"));
    const databasePath = join(directory, "foundation.sqlite");
    try {
      const first = await createPresentationStorage("sqlite", databasePath);
      await installSameTimeRepair(first);
      expect(await first.storage.readiness()).toMatchObject({ ok: true });
      first.storage.close();
      const raw = new Database(databasePath);
      raw.exec("DROP TRIGGER foundation_event_game_presentation_audit_no_update");
      raw
        .query(
          "UPDATE foundation_event_game_presentation_audit SET supersedes_audit_id = NULL WHERE supersedes_audit_id IS NOT NULL",
        )
        .run();
      raw.close();
      const frozen = openSqliteFoundationStorage(databasePath, {
        grantKeyRing: first.keyRing,
        requireReplayContext: false,
      });
      expect(await frozen.readiness()).toMatchObject({
        ok: false,
        status: "integrity-failure",
      });
      frozen.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function installSameTimeRepair(harness: {
  storage: FoundationStorage;
  keyRing: GrantKeyRing;
  grant: { grantSessionId: string; grantVersion: string };
}) {
  const grant = { sessionId: harness.grant.grantSessionId, versionId: harness.grant.grantVersion };
  const base = createEvidence(grant, harness.keyRing, []);
  const zChange = {
    ...base.change,
    operationId: "z-presentation-operation",
    presentationChangeId: "z-presentation-change",
    occurrence: { ...base.change.occurrence, trustedAtMs: 2 },
  };
  zChange.canonicalContent = canonicalizeGamePresentationChange(zChange);
  zChange.contentFingerprint = fingerprintGamePresentationChange(zChange);
  const zAudit = {
    ...base.audit,
    auditId: "z-presentation-audit",
    operationId: zChange.operationId,
    presentationChangeId: zChange.presentationChangeId,
    change: zChange.change,
  };
  await harness.storage.transaction((transaction) => {
    transaction.insertPresentationChange!(zChange);
    transaction.appendPresentationAuditEntry!(zAudit);
    transaction.sealPresentationEvidence!(root.recordId);
  });

  const aChange = {
    ...zChange,
    operationId: "a-presentation-operation",
    presentationChangeId: "a-presentation-change",
    change: { type: "displayed-team-color", gameSideId: "side-a", color: "#778899" } as const,
  };
  aChange.canonicalContent = canonicalizeGamePresentationChange(aChange);
  aChange.contentFingerprint = fingerprintGamePresentationChange(aChange);
  const aResult = applyGamePresentationChange(initialPresentation, aChange.change);
  const aAudit = {
    ...zAudit,
    auditId: "a-presentation-audit",
    operationId: aChange.operationId,
    presentationChangeId: aChange.presentationChangeId,
    change: aChange.change,
    resultingPresentation: aResult,
  };
  const repairedZAudit = {
    ...zAudit,
    auditId: "z-presentation-audit-revision-1",
    supersedesAuditId: zAudit.auditId,
    previousPresentation: aResult,
    resultingPresentation: applyGamePresentationChange(aResult, zChange.change),
  };
  await harness.storage.transaction((transaction) => {
    transaction.insertPresentationChange!(aChange);
    transaction.appendPresentationAuditEntry!(aAudit);
    transaction.appendPresentationAuditRevision!(repairedZAudit);
    transaction.sealPresentationEvidence!(root.recordId);
  });
}

async function createPresentationStorage(
  kind: "memory" | "sqlite",
  databasePath?: string,
): Promise<{
  storage: FoundationStorage;
  keyRing: GrantKeyRing;
  grant: { grantSessionId: string; grantVersion: string };
  cleanup(): Promise<void>;
}> {
  const keyRing = createGrantTestKeyRing();
  if (kind === "memory") {
    const storage = createInMemoryFoundationStorage();
    const cleanup = async () => storage.close();
    const grant = await preparePresentationStorage(storage, keyRing);
    return { storage, keyRing, grant, cleanup };
  }
  let ownedDirectory: string | undefined;
  if (databasePath === undefined) {
    ownedDirectory = await mkdtemp(join(tmpdir(), "quadball-timer-presentation-sqlite-"));
    databasePath = join(ownedDirectory, "foundation.sqlite");
  }
  const storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
  await storage.applyMigrations();
  const grant = await preparePresentationStorage(storage, keyRing);
  return {
    storage,
    keyRing,
    grant,
    cleanup: async () => {
      storage.close();
      if (ownedDirectory !== undefined) await rm(ownedDirectory, { recursive: true, force: true });
    },
  };
}

async function preparePresentationStorage(
  storage: FoundationStorage,
  keyRing: GrantKeyRing,
): Promise<{ grantSessionId: string; grantVersion: string }> {
  const record = createEventGameRecord(storage, {
    externalScopeResolver: {
      resolve(scope) {
        return JSON.stringify(scope) === JSON.stringify(root.externalScope)
          ? { status: "resolved", scope: structuredClone(scope) }
          : { status: "mismatch", detail: "scope mismatch" };
      },
      resolveEventTeam() {
        return { status: "resolved" };
      },
    },
    interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
  });
  const authority = createLegacyControlGrantTestAuthority(storage, {
    environmentId: "presentation-integrity-test",
    clock: { nowMs: () => 1_000 },
    randomness: createGrantTestRandomness(7),
    keyRing,
    controlScopeResolver: {
      resolve: () => ({ status: "eligible", eventGameId: root.eventGameId }),
    },
    privilegedAuthorityVerifier: createGrantTestAuthorityVerifier(),
  } satisfies GrantAuthorityOptions);
  const created = await authority.createControlGrant({
    scope: root.externalScope,
    actor: { kind: "fixture", id: "presentation-integrity" },
  });
  if (created.status !== "created") throw new Error("Expected a presentation test Grant.");
  const admitted = await authority.admitControlGrant({
    qrCredential: created.qrCredential,
    browserContext: "presentation-integrity-browser",
  });
  if (admitted.status !== "admitted") throw new Error("Expected a presentation test Session.");
  if ((await record.registerRoot(root)).status !== "registered") {
    throw new Error("Expected a presentation test root.");
  }
  return {
    grantSessionId: admitted.grantSessionId,
    grantVersion: created.grantVersion,
  };
}
