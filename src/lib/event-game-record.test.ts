import { describe, expect, test } from "bun:test";
import {
  canonicalizeEventGameRecordRoot,
  type EventGameRecordRoot,
} from "@/lib/foundation-record-types";
import { createEventGameRecord, type ExternalScopeResolver } from "@/lib/event-game-record";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";

function createRoot(overrides: Partial<EventGameRecordRoot> = {}): EventGameRecordRoot {
  return {
    recordId: "record-1",
    eventId: "event-1",
    eventGameId: "event-game-1",
    ownership: {
      eventId: "event-1",
      eventGameId: "event-game-1",
    },
    externalScope: {
      eventId: "event-1",
      gameDayId: "game-day-1",
      pitchId: "pitch-1",
      pitchSlotId: "pitch-slot-1",
    },
    gameSides: [
      {
        id: "side-1",
        eventTeamId: "team-1",
        teamInterpretationRef: "team-interpretation-1",
      },
      {
        id: "side-2",
        eventTeamId: "team-2",
        teamInterpretationRef: "team-interpretation-2",
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
      operationId: "register-1",
      actorReference: "event-admin-session-1",
      source: "event-game-registration",
      createdAtMs: 1_000,
    },
    ...overrides,
  };
}

describe("Event Game Record contract", () => {
  test("registers one root, makes identical registration idempotent, and rejects conflicting scope", async () => {
    const root = createRoot();
    const record = createEventGameRecord(createInMemoryFoundationStorage(), {
      externalScopeResolver: createScopeResolver(root),
    });

    expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
    expect(await record.registerRoot(structuredClone(root))).toMatchObject({
      status: "idempotent",
    });

    const conflict = createRoot({
      externalScope: {
        ...root.externalScope,
        pitchSlotId: "pitch-slot-2",
      },
    });
    expect(await record.registerRoot(conflict)).toMatchObject({
      status: "rejected",
      reason: "external-scope-conflict",
    });
  });

  test("stores canonical content rather than object insertion order", async () => {
    const root = createRoot();
    const record = createEventGameRecord(createInMemoryFoundationStorage(), {
      externalScopeResolver: createScopeResolver(root),
    });
    const reordered = JSON.parse(
      JSON.stringify({
        creationEvidence: root.creationEvidence,
        compatibility: root.compatibility,
        lifecycle: root.lifecycle,
        gameSides: root.gameSides,
        externalScope: root.externalScope,
        ownership: root.ownership,
        eventGameId: root.eventGameId,
        eventId: root.eventId,
        recordId: root.recordId,
      }),
    ) as EventGameRecordRoot;

    expect(canonicalizeEventGameRecordRoot(root)).toBe(canonicalizeEventGameRecordRoot(reordered));
    expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
    expect(await record.registerRoot(reordered)).toMatchObject({ status: "idempotent" });
  });

  test("rolls back a storage transaction when its work fails", async () => {
    const storage = createInMemoryFoundationStorage();
    const root = createRoot();

    let failure: unknown;
    try {
      await storage.transaction((transaction) => {
        transaction.insertRoot({
          root,
          canonicalContent: canonicalizeEventGameRecordRoot(root),
        });
        throw new Error("simulated failure");
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    if (failure instanceof Error) {
      expect(failure.message).toContain("simulated failure");
    }

    expect(await storage.readRoot(root.recordId)).toBeNull();
  });
});

function createScopeResolver(root: EventGameRecordRoot): ExternalScopeResolver {
  return {
    resolve(scope) {
      return JSON.stringify(scope) === JSON.stringify(root.externalScope)
        ? { status: "resolved", scope: structuredClone(scope) }
        : { status: "mismatch", detail: "The external scope does not match the root." };
    },
  };
}
