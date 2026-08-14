import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventGameRecord, type ExternalScopeResolver } from "@/lib/event-game-record";
import { createDeterministicTestIqaInterpreter } from "@/lib/event-game-actions";
import {
  canonicalizeEventGameRecordRoot,
  type EventGameRecordRoot,
} from "@/lib/foundation-record-types";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import { FoundationStorageConstraintError, type FoundationStorage } from "@/lib/foundation-storage";

type StorageHarness = {
  storage: FoundationStorage;
  cleanup(): Promise<void>;
};

type StorageFactory = () => Promise<StorageHarness>;

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

const memoryFactory: StorageFactory = async () => {
  const storage = createInMemoryFoundationStorage();
  return {
    storage,
    cleanup: async () => storage.close(),
  };
};

const sqliteFactory: StorageFactory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "quadball-timer-storage-contract-"));
  const databasePath = join(directory, "foundation.sqlite");
  const storage = openSqliteFoundationStorage(databasePath);
  await storage.applyMigrations();
  return {
    storage,
    cleanup: async () => {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
};

function runStorageContract(name: string, factory: StorageFactory): void {
  describe(`${name} foundation storage contract`, () => {
    test("registers and reads a semantic Event Game Record root", async () => {
      const harness = await factory();
      try {
        const root = createRoot();
        const record = createEventGameRecord(harness.storage, {
          externalScopeResolver: createScopeResolver(root),
          interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
        });
        expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
        expect(await record.readRoot(root.recordId)).toEqual(root);
      } finally {
        await harness.cleanup();
      }
    });

    test("exposes duplicate identity and external scope conflicts without rows", async () => {
      const harness = await factory();
      try {
        const root = createRoot();
        const record = createEventGameRecord(harness.storage, {
          externalScopeResolver: createScopeResolver(root),
          interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
        });
        expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
        expect(await record.registerRoot(structuredClone(root))).toMatchObject({
          status: "idempotent",
        });

        expect(
          await record.registerRoot({
            ...createRoot({
              recordId: "record-2",
              eventGameId: "event-game-2",
              ownership: { eventId: "event-1", eventGameId: "event-game-2" },
              gameSides: [
                { ...root.gameSides[0], id: "side-3", eventTeamId: "team-3" },
                { ...root.gameSides[1], id: "side-4", eventTeamId: "team-4" },
              ],
            }),
            externalScope: {
              ...root.externalScope,
              pitchSlotId: root.externalScope.pitchSlotId,
            },
          }),
        ).toMatchObject({
          status: "rejected",
          reason: "external-scope-conflict",
        });
      } finally {
        await harness.cleanup();
      }
    });

    test("keeps an identical retry idempotent when external scope resolution later fails", async () => {
      const harness = await factory();
      try {
        const root = createRoot();
        let resolutionCount = 0;
        const resolver: ExternalScopeResolver = {
          resolve(scope) {
            resolutionCount += 1;
            return resolutionCount === 1
              ? { status: "resolved", scope: structuredClone(scope) }
              : {
                  status: "missing",
                  detail: "missing: the external scope catalog is temporarily unavailable.",
                };
          },
          resolveEventTeam() {
            return { status: "resolved" };
          },
        };
        const record = createEventGameRecord(harness.storage, {
          externalScopeResolver: resolver,
          interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
        });

        expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
        expect(await record.registerRoot(structuredClone(root))).toMatchObject({
          status: "idempotent",
        });
        expect(resolutionCount).toBe(1);
        expect(await record.readRoot(root.recordId)).toEqual(root);
        expect(await record.readRoot("record-2")).toBeNull();
      } finally {
        await harness.cleanup();
      }
    });

    test("serializes concurrent identical registrations into one commit", async () => {
      const harness = await factory();
      try {
        const root = createRoot();
        const record = createEventGameRecord(harness.storage, {
          externalScopeResolver: createScopeResolver(root),
          interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
        });
        const outcomes = await Promise.all([record.registerRoot(root), record.registerRoot(root)]);
        expect(outcomes.filter((outcome) => outcome.status === "registered")).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.status === "idempotent")).toHaveLength(1);
        expect(await record.readRoot(root.recordId)).toEqual(root);
      } finally {
        await harness.cleanup();
      }
    });

    test("resolves every external scope relationship inside the storage transaction", async () => {
      const root = createRoot();
      const knownValues = new Set([
        "event-1",
        "event-2",
        "game-day-1",
        "game-day-2",
        "pitch-1",
        "pitch-2",
        "pitch-slot-1",
        "pitch-slot-2",
      ]);
      const resolver: ExternalScopeResolver = {
        resolve(scope, transaction) {
          expect(transaction.findRootByRecordId("not-yet-committed")).toBeNull();
          if (
            ![scope.eventId, scope.gameDayId, scope.pitchId, scope.pitchSlotId].every((value) =>
              knownValues.has(value),
            )
          ) {
            return {
              status: "missing",
              detail: "missing: the external scope reference does not exist.",
            };
          }
          if (JSON.stringify(scope) !== JSON.stringify(root.externalScope)) {
            return {
              status: "mismatch",
              detail: "mismatch: the external scope references do not belong to one hierarchy.",
            };
          }
          return { status: "resolved", scope: structuredClone(scope) };
        },
        resolveEventTeam() {
          return { status: "resolved" };
        },
      };
      const cases: readonly [string, Partial<EventGameRecordRoot["externalScope"]>, string][] = [
        ["missing Event", { eventId: "missing-event" }, "missing"],
        ["missing Game Day", { gameDayId: "missing-game-day" }, "missing"],
        ["missing Pitch", { pitchId: "missing-pitch" }, "missing"],
        ["missing Pitch Slot", { pitchSlotId: "missing-pitch-slot" }, "missing"],
        ["mismatched Event", { eventId: "event-2" }, "mismatch"],
        ["mismatched Game Day", { gameDayId: "game-day-2" }, "mismatch"],
        ["mismatched Pitch", { pitchId: "pitch-2" }, "mismatch"],
        ["mismatched Pitch Slot", { pitchSlotId: "pitch-slot-2" }, "mismatch"],
      ];

      for (const [label, patch, expectedStatus] of cases) {
        const harness = await factory();
        try {
          const externalScope = { ...root.externalScope, ...patch };
          const caseEventId = externalScope.eventId;
          const caseEventGameId = `event-game-${label.replaceAll(" ", "-").toLowerCase()}`;
          const record = createEventGameRecord(harness.storage, {
            externalScopeResolver: resolver,
            interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
          });
          const outcome = await record.registerRoot(
            createRoot({
              recordId: `record-${label.replaceAll(" ", "-").toLowerCase()}`,
              eventId: caseEventId,
              eventGameId: caseEventGameId,
              ownership: { eventId: caseEventId, eventGameId: caseEventGameId },
              externalScope,
            }),
          );
          expect(outcome).toMatchObject({
            status: "rejected",
            reason: "external-scope-conflict",
          });
          if (outcome.status === "rejected") {
            expect(outcome.detail).toContain(expectedStatus);
          }
        } finally {
          await harness.cleanup();
        }
      }

      const harness = await factory();
      try {
        const record = createEventGameRecord(harness.storage, {
          externalScopeResolver: resolver,
          interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
        });
        expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
      } finally {
        await harness.cleanup();
      }
    });

    test("rejects unpaired lock timestamp and reason before reaching either adapter", async () => {
      const invalidLifecycles: readonly EventGameRecordRoot["lifecycle"][] = [
        {
          phase: "finished",
          commencedAtMs: 100,
          finishedAtMs: 200,
          lockedAtMs: 300,
          lockReason: null,
        },
        {
          phase: "finished",
          commencedAtMs: 100,
          finishedAtMs: 200,
          lockedAtMs: null,
          lockReason: "administrative",
        },
      ];

      for (const [index, lifecycle] of invalidLifecycles.entries()) {
        const harness = await factory();
        try {
          const root = createRoot({
            recordId: `invalid-lock-record-${index}`,
            eventGameId: `invalid-lock-game-${index}`,
            ownership: {
              eventId: "event-1",
              eventGameId: `invalid-lock-game-${index}`,
            },
            externalScope: {
              ...createRoot().externalScope,
              pitchSlotId: `invalid-lock-slot-${index}`,
            },
            lifecycle,
          });
          const record = createEventGameRecord(harness.storage, {
            externalScopeResolver: createScopeResolver(root),
            interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
          });
          const outcome = await record.registerRoot(root);
          expect(outcome).toMatchObject({ status: "rejected", reason: "invalid-root" });
          if (outcome.status === "rejected") {
            expect(outcome.detail).not.toContain("CHECK");
            expect(outcome.detail).not.toContain("constraint");
          }
          expect(await record.readRoot(root.recordId)).toBeNull();
        } finally {
          await harness.cleanup();
        }
      }
    });

    test("enforces global Game Side identity uniqueness in both positions", async () => {
      const orientations: readonly [string, 0 | 1][] = [
        ["incoming-side-a-reuses-existing-side-b", 0],
        ["incoming-side-b-reuses-existing-side-a", 1],
      ];
      for (const [label, incomingPosition] of orientations) {
        const harness = await factory();
        try {
          const first = createRoot();
          const firstSideId = first.gameSides[incomingPosition === 0 ? 1 : 0]?.id;
          if (firstSideId === undefined) throw new Error("Expected a first Game Side.");
          const secondGameId = `game-${label}`;
          const secondSides = [
            {
              id: `new-side-a-${label}`,
              eventTeamId: `new-team-a-${label}`,
              teamInterpretationRef: "interpretation-a",
            },
            {
              id: `new-side-b-${label}`,
              eventTeamId: `new-team-b-${label}`,
              teamInterpretationRef: "interpretation-b",
            },
          ] as [EventGameRecordRoot["gameSides"][0], EventGameRecordRoot["gameSides"][1]];
          secondSides[incomingPosition].id = firstSideId;
          const second = createRoot({
            recordId: `record-${label}`,
            eventGameId: secondGameId,
            ownership: { eventId: "event-1", eventGameId: secondGameId },
            externalScope: { ...first.externalScope, pitchSlotId: `slot-${label}` },
            gameSides: secondSides,
          });

          let failure: unknown;
          try {
            await harness.storage.transaction((transaction) => {
              transaction.insertRoot({
                root: first,
                canonicalContent: canonicalizeEventGameRecordRoot(first),
              });
              transaction.insertRoot({
                root: second,
                canonicalContent: canonicalizeEventGameRecordRoot(second),
              });
            });
          } catch (error) {
            failure = error;
          }
          expect(failure).toBeInstanceOf(FoundationStorageConstraintError);
          if (failure instanceof FoundationStorageConstraintError) {
            expect(failure.constraint).toBe("game-side-id");
          }
          expect(await harness.storage.readRoot(first.recordId)).toBeNull();
          expect(await harness.storage.readRoot(second.recordId)).toBeNull();
        } finally {
          await harness.cleanup();
        }
      }
    });

    test("rolls back a failed transaction and leaves no root behind", async () => {
      const harness = await factory();
      try {
        const root = createRoot();
        let failure: unknown;
        try {
          await harness.storage.transaction((transaction) => {
            transaction.insertRoot({
              root,
              canonicalContent: JSON.stringify(root),
            });
            throw new Error("contract rollback");
          });
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        if (failure instanceof Error) {
          expect(failure.message).toContain("contract rollback");
        }
        expect(await harness.storage.readRoot(root.recordId)).toBeNull();
      } finally {
        await harness.cleanup();
      }
    });
  });
}

function createScopeResolver(root: EventGameRecordRoot): ExternalScopeResolver {
  return {
    resolve(scope) {
      return JSON.stringify(scope) === JSON.stringify(root.externalScope)
        ? { status: "resolved", scope: structuredClone(scope) }
        : {
            status: "mismatch",
            detail: "The external scope does not match the registered hierarchy.",
          };
    },
    resolveEventTeam(eventId, eventTeamId) {
      return eventId === root.eventId && eventTeamId.length > 0
        ? { status: "resolved" }
        : { status: "mismatch", detail: "The Event Team is outside the Event scope." };
    },
  };
}

runStorageContract("in-memory", memoryFactory);
runStorageContract("SQLite", sqliteFactory);
