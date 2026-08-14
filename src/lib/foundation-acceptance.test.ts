import { describe, expect, test } from "bun:test";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import { createFoundationAcceptance } from "@/lib/foundation-acceptance";
import { createEventGameRecord } from "@/lib/event-game-record";
import {
  createDeterministicTestIqaInterpreter,
  type ControlActionInput,
} from "@/lib/event-game-actions";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import {
  createGrantTestAuthorityVerifier,
  createLegacyControlGrantTestAuthority,
} from "@/lib/grant-authority-test-support";
import type { GrantKeyRing } from "@/lib/grant-types";

describe("composed Control Action acceptance", () => {
  test("validates the batch before mutation, commits paired audits, and preserves caller order", async () => {
    const storage = createInMemoryFoundationStorage();
    const root = createRoot();
    const grantOptions = createGrantOptions(root.eventGameId);
    const authority = createLegacyControlGrantTestAuthority(storage, grantOptions);
    const created = await authority.createControlGrant({
      scope: root.externalScope,
      actor: { kind: "fixture", id: "fixture" },
    });
    if (created.status !== "created")
      throw new Error(`Expected a Control Grant: ${JSON.stringify(created)}`);
    const admitted = await authority.admitControlGrant({
      qrCredential: created.qrCredential,
      browserContext: "controller-a",
    });
    if (admitted.status !== "admitted") throw new Error("Expected a Control Session.");

    const record = createEventGameRecord(storage, {
      externalScopeResolver: createScopeResolver(root),
      interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      clock: () => 1_000,
      auditAuthorityVerifier: { verify: () => true },
    });
    expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
    const acceptance = createFoundationAcceptance(storage, {
      grant: grantOptions,
      externalScopeResolver: createScopeResolver(root),
      clock: () => 1_000,
      interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
    });
    const first = createFact(
      root,
      "operation-first",
      admitted.grantSessionId,
      created.grantVersion,
    );
    const second = {
      ...createFact(root, "operation-second", admitted.grantSessionId, created.grantVersion),
      causalPredecessorIds: [first.operationId],
    };

    const outcome = await acceptance.submitBatch({
      recordId: root.recordId,
      eventGameId: root.eventGameId,
      sessionBearer: admitted.sessionBearer,
      actions: [second, first],
    });
    expect(outcome.status).toBe("committed");
    expect(outcome.results.map((result) => result.status)).toEqual(["accepted", "accepted"]);
    expect((await record.readActions()).map((stored) => stored.action.operationId)).toEqual([
      "operation-first",
      "operation-second",
    ]);
    const grantAudit = await storage.transaction((transaction) =>
      transaction
        .listGrantAudit(created.grantId)
        .filter((entry) => entry.acceptanceId !== undefined),
    );
    expect(grantAudit).toHaveLength(2);
    const controlAudit = await record.readAudit({});
    expect(controlAudit.filter((entry) => entry.links?.grantAuditId !== undefined)).toHaveLength(2);
  });
});

function createGrantOptions(eventGameId: string): GrantAuthorityOptions {
  let call = 0;
  return {
    environmentId: "acceptance-test",
    clock: { nowMs: () => 1_000 },
    randomness: {
      bytes: (length) => {
        call += 1;
        return Uint8Array.from({ length }, (_, index) => (index + call + length) % 256);
      },
    },
    keyRing: createKeyRing(),
    controlScopeResolver: { resolve: () => ({ status: "eligible", eventGameId }) },
    privilegedAuthorityVerifier: createGrantTestAuthorityVerifier(),
  };
}

function createKeyRing(): GrantKeyRing {
  return {
    encryption: { currentVersion: "encryption-v1", keys: new Map([["encryption-v1", bytes(1)]]) },
    lookup: { currentVersion: "lookup-v1", keys: new Map([["lookup-v1", bytes(33)]]) },
    audit: { currentVersion: "audit-v1", keys: new Map([["audit-v1", bytes(65)]]) },
  };
}

function bytes(start: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => start + index);
}

function createRoot(): EventGameRecordRoot {
  return {
    recordId: "record-acceptance",
    eventId: "event-acceptance",
    eventGameId: "game-acceptance",
    ownership: { eventId: "event-acceptance", eventGameId: "game-acceptance" },
    externalScope: {
      eventId: "event-acceptance",
      gameDayId: "day-1",
      pitchId: "pitch-1",
      pitchSlotId: "slot-1",
    },
    gameSides: [
      { id: "side-a", eventTeamId: "team-a", teamInterpretationRef: "team-a-v1" },
      { id: "side-b", eventTeamId: "team-b", teamInterpretationRef: "team-b-v1" },
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
      operationId: "register-acceptance",
      actorReference: "actor-test",
      source: "event-game-registration",
      createdAtMs: 500,
    },
  };
}

function createScopeResolver(root: EventGameRecordRoot) {
  return {
    resolve(scope: EventGameRecordRoot["externalScope"]) {
      return JSON.stringify(scope) === JSON.stringify(root.externalScope)
        ? { status: "resolved" as const, scope: structuredClone(scope) }
        : { status: "mismatch" as const, detail: "scope mismatch" };
    },
    resolveEventTeam() {
      return { status: "resolved" as const };
    },
  };
}

function createFact(
  root: EventGameRecordRoot,
  operationId: string,
  sessionId: string,
  versionId: string,
): ControlActionInput {
  return {
    recordId: root.recordId,
    eventGameId: root.eventGameId,
    operationId,
    kind: { id: "game-fact", version: "1" },
    payload: {
      factId: `fact-${operationId}`,
      factType: "test",
      gameSideId: "side-a",
      gameTimeMs: 1,
      data: { operationId },
    },
    causalPredecessorIds: [],
    occurrence: { trustedAtMs: 1_000, clientOriginAtMs: 1_000, source: "online" },
    grant: { sessionId, versionId },
    lifecycle: structuredClone(root.lifecycle),
  };
}
