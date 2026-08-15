import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventGameRecord } from "@/lib/event-game-record";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import type { FoundationStorageSnapshot } from "@/lib/foundation-storage";
import { FOUNDATION_MIGRATIONS } from "@/lib/foundation-migrations";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import { createGrantTestAuthorityVerifier } from "@/lib/grant-authority-test-support";
import { createTypedGrantAuthority } from "@/lib/grant-management";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import type { GrantKeyRing } from "@/lib/grant-types";
import {
  createControlScopeResolver,
  openLiveEventGameRuntime,
  readLiveEventGrantKeyRing,
} from "@/lib/live-event-game-runtime";
import {
  createLiveEventGameIqaInterpreter,
  LIVE_EVENT_CONTROL_INTENT_VERSION,
} from "@/lib/live-event-game-control";

describe("Live Event Game SQLite runtime", () => {
  test("fails closed when any required runtime secret is absent", () => {
    expect(
      readLiveEventGrantKeyRing({
        EVENT_GAME_ENCRYPTION_KEY: "missing-lookup-and-audit",
      }),
    ).toBeNull();
  });

  test("fails closed without creating a missing database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-event-game-runtime-"));
    const databasePath = join(directory, "event-game.sqlite");
    try {
      expect(existsSync(databasePath)).toBe(false);
      expect(
        openLiveEventGameRuntime({
          databasePath,
          environmentId: "runtime-test",
          keyRing: createKeyRing(),
        }),
      ).rejects.toThrow("Durable Event Game storage is not ready.");
      expect(existsSync(databasePath)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails closed without migrating an unprepared database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-event-game-runtime-"));
    const databasePath = join(directory, "event-game.sqlite");
    const keyRing = createKeyRing();
    const initialStorage = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
    const journalMode = initialStorage.getSettings().journalMode;
    initialStorage.close();
    try {
      expect(
        openLiveEventGameRuntime({
          databasePath,
          environmentId: "runtime-test",
          keyRing,
        }),
      ).rejects.toThrow("Durable Event Game storage is not ready.");

      expect(existsSync(databasePath)).toBe(true);
      const database = new Database(databasePath, { readonly: true });
      try {
        expect(
          database
            .query("SELECT name FROM sqlite_master WHERE name = 'foundation_migration_ledger'")
            .get(),
        ).toBeNull();
        expect(database.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: journalMode });
      } finally {
        database.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails closed without migrating an incompatible database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-event-game-runtime-"));
    const databasePath = join(directory, "event-game.sqlite");
    const keyRing = createKeyRing();
    const migration = FOUNDATION_MIGRATIONS[0];
    if (migration === undefined) throw new Error("Expected the foundation migrations.");
    const setupStorage = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
    try {
      await setupStorage.applyMigrations({ requireCandidate: false });
    } finally {
      setupStorage.close();
    }
    const database = new Database(databasePath);
    database
      .query("UPDATE foundation_migration_ledger SET checksum = ? WHERE migration_id = ?")
      .run("incompatible", migration.id);
    const ledgerBefore = database
      .query(
        "SELECT migration_id, ordinal, schema_version, checksum, status FROM foundation_migration_ledger ORDER BY ordinal",
      )
      .all();
    const journalMode = database.query("PRAGMA journal_mode").get();
    database.close();

    try {
      expect(
        openLiveEventGameRuntime({
          databasePath,
          environmentId: "runtime-test",
          keyRing,
        }),
      ).rejects.toThrow("Durable Event Game storage is not ready.");

      const database = new Database(databasePath, { readonly: true });
      try {
        expect(
          database
            .query(
              "SELECT migration_id, ordinal, schema_version, checksum, status FROM foundation_migration_ledger ORDER BY ordinal",
            )
            .all(),
        ).toEqual(ledgerBefore);
        expect(database.query("PRAGMA journal_mode").get()).toEqual(journalMode);
      } finally {
        database.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("activates a configured persisted Game and accepts a goal through the runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-event-game-runtime-"));
    const databasePath = join(directory, "event-game.sqlite");
    const environmentId = "runtime-test";
    const keyRing = createKeyRing();
    const configured = readLiveEventGrantKeyRing({
      EVENT_GAME_ENCRYPTION_KEY: encodeKey(keyRing.encryption.keys.get("encryption-v1")),
      EVENT_GAME_LOOKUP_KEY: encodeKey(keyRing.lookup.keys.get("lookup-v1")),
      EVENT_GAME_AUDIT_KEY: encodeKey(keyRing.audit.keys.get("audit-v1")),
    });
    expect(configured).not.toBeNull();

    const root = createRoot();
    const setupStorage = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
    let qrCredential: string;
    try {
      await setupStorage.applyMigrations({ requireCandidate: false });
      const setupRecord = createEventGameRecord(setupStorage, {
        externalScopeResolver: createExternalScopeResolver(root),
        interpreter: createLiveEventGameIqaInterpreter(),
        auditAuthorityVerifier: { verify: () => true },
      });
      expect(await setupRecord.registerRoot(root)).toMatchObject({ status: "registered" });
      const authority = createTypedGrantAuthority(
        setupStorage,
        createGrantOptions(environmentId, keyRing),
      );
      const created = await authority.createControlGrant({
        scope: root.externalScope,
        authority: { kind: "fixture", id: "runtime-fixture" },
      });
      if (created.status !== "created") throw new Error("Expected a runtime Control Grant.");
      qrCredential = created.qrCredential;
    } finally {
      setupStorage.close();
    }

    const runtime = await openLiveEventGameRuntime({
      databasePath,
      environmentId,
      keyRing: configured ?? keyRing,
      clock: () => 10_000,
    });
    try {
      const opened = await runtime.control.openController({
        qrCredential,
        browserContext: "runtime-test-device",
      });
      expect(opened).toMatchObject({
        status: "opened",
        eventGameId: root.eventGameId,
        projectionStatus: "available",
        projection: { scoreByGameSide: { "side-a": 0, "side-b": 0 } },
      });
      if (opened.status !== "opened") throw new Error("Expected the runtime Controller to open.");

      const accepted = await runtime.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: opened.eventGameId,
        intent: {
          version: LIVE_EVENT_CONTROL_INTENT_VERSION,
          type: "record-goal",
          operationId: "runtime-operation-1",
          factId: "runtime-fact-1",
          gameSideId: "side-a",
          gameTimeMs: 0,
          occurrence: { clientOriginAtMs: 1234 },
        },
      });
      expect(accepted).toMatchObject({
        status: "accepted",
        projectionStatus: "available",
        projection: {
          scoreByGameSide: { "side-a": 10, "side-b": 0 },
          goalCount: 1,
          commencement: { status: "commenced", commencedAtMs: 10_000 },
        },
      });

      const duplicate = await runtime.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: opened.eventGameId,
        intent: {
          version: LIVE_EVENT_CONTROL_INTENT_VERSION,
          type: "record-goal",
          operationId: "runtime-operation-1",
          factId: "runtime-fact-1",
          gameSideId: "side-a",
          gameTimeMs: 0,
          occurrence: { clientOriginAtMs: 1234 },
        },
      });
      expect(duplicate).toMatchObject({
        status: "duplicate-accepted",
        projection: { scoreByGameSide: { "side-a": 10, "side-b": 0 }, goalCount: 1 },
      });

      const mismatchedSelector = await runtime.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: "wrong-runtime-game",
        intent: { version: "untrusted", operationId: "untrusted-operation" },
      });
      expect(mismatchedSelector).toEqual({
        status: "rejected",
        message: "Unable to perform that Controller action.",
        operationId: null,
      });

      const secondDevice = await runtime.control.openController({
        qrCredential,
        browserContext: "runtime-test-device-2",
      });
      expect(secondDevice).toMatchObject({
        status: "opened",
        eventGameId: root.eventGameId,
        projectionStatus: "available",
        projection: { scoreByGameSide: { "side-a": 10, "side-b": 0 }, goalCount: 1 },
      });
    } finally {
      runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("production scope resolver switches before commencement and pins after it", () => {
    const previous = createRoot();
    const current: EventGameRecordRoot = {
      ...previous,
      recordId: "runtime-record-current",
      eventGameId: "runtime-game-current",
      ownership: { eventId: previous.eventId, eventGameId: "runtime-game-current" },
      lifecycle: { ...previous.lifecycle },
    };
    const previousCommenced: EventGameRecordRoot = {
      ...previous,
      recordId: "runtime-record-previous-commenced",
      eventGameId: "runtime-game-previous-commenced",
      ownership: { eventId: previous.eventId, eventGameId: "runtime-game-previous-commenced" },
      lifecycle: { ...previous.lifecycle, phase: "in-progress", commencedAtMs: 10_000 },
    };
    const snapshot = {
      findRootByPitchSlotId: () => current,
      findRootByEventGameId: (eventGameId: string) =>
        eventGameId === previous.eventGameId
          ? previous
          : eventGameId === previousCommenced.eventGameId
            ? previousCommenced
            : current,
    } as unknown as FoundationStorageSnapshot;
    const resolver = createControlScopeResolver();

    expect(
      resolver.resolveSession?.(current.externalScope, previous.eventGameId, snapshot),
    ).toEqual({
      status: "switchable",
      previousEventGameId: previous.eventGameId,
      currentEventGameId: current.eventGameId,
    });
    expect(
      resolver.resolveSession?.(current.externalScope, previousCommenced.eventGameId, snapshot),
    ).toEqual({
      status: "pinned",
      sessionEventGameId: previousCommenced.eventGameId,
      currentEventGameId: current.eventGameId,
    });
  });

  test("keeps a commenced session pinned when its catalog placement leaves the scanned slot", () => {
    const previous = createRoot();
    const commenced: EventGameRecordRoot = {
      ...previous,
      recordId: "runtime-record-commenced-moved",
      eventGameId: "runtime-game-commenced-moved",
      ownership: { eventId: previous.eventId, eventGameId: "runtime-game-commenced-moved" },
      lifecycle: { ...previous.lifecycle, phase: "in-progress", commencedAtMs: 10_000 },
    };
    const current: EventGameRecordRoot = {
      ...previous,
      recordId: "runtime-record-current-after-move",
      eventGameId: "runtime-game-current-after-move",
      ownership: { eventId: previous.eventId, eventGameId: "runtime-game-current-after-move" },
    };
    const snapshot = {
      findRootByPitchSlotId: () => current,
      findRootByEventGameId: (eventGameId: string) =>
        eventGameId === commenced.eventGameId ? commenced : current,
      listEventGames: () => [],
      findEventGame: () => ({}) as never,
    } as unknown as FoundationStorageSnapshot;

    expect(
      createControlScopeResolver().resolveSession?.(
        current.externalScope,
        commenced.eventGameId,
        snapshot,
      ),
    ).toEqual({
      status: "pinned",
      sessionEventGameId: commenced.eventGameId,
      currentEventGameId: commenced.eventGameId,
    });
  });

  test("production reassignment resolution persists passive commencement without refresh", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quadball-event-game-runtime-"));
    const databasePath = join(directory, "event-game.sqlite");
    const keyRing = createKeyRing();
    let nowMs = 0;
    const previous = createRoot();
    const current: EventGameRecordRoot = {
      ...previous,
      recordId: "runtime-record-reassigned",
      eventGameId: "runtime-game-reassigned",
      ownership: { eventId: previous.eventId, eventGameId: "runtime-game-reassigned" },
      externalScope: { ...previous.externalScope, pitchSlotId: "runtime-slot-2" },
      gameSides: [
        { id: "side-c", eventTeamId: "team-c", teamInterpretationRef: "team-c-v1" },
        { id: "side-d", eventTeamId: "team-d", teamInterpretationRef: "team-d-v1" },
      ],
      creationEvidence: { ...previous.creationEvidence, operationId: "runtime-register-2" },
    };
    const setupStorage = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
    let qrCredential: string;
    try {
      await setupStorage.applyMigrations({ requireCandidate: false });
      for (const root of [previous, current]) {
        const record = createEventGameRecord(setupStorage, {
          externalScopeResolver: createExternalScopeResolver(root),
          interpreter: createLiveEventGameIqaInterpreter(),
          auditAuthorityVerifier: { verify: () => true },
        });
        expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
      }
      const authority = createTypedGrantAuthority(
        setupStorage,
        createGrantOptions("runtime-test", keyRing),
      );
      const created = await authority.createControlGrant({
        scope: previous.externalScope,
        authority: { kind: "fixture", id: "runtime-fixture" },
      });
      if (created.status !== "created") throw new Error("Expected a runtime Control Grant.");
      qrCredential = created.qrCredential;
    } finally {
      setupStorage.close();
    }

    const runtime = await openLiveEventGameRuntime({
      databasePath,
      environmentId: "runtime-test",
      keyRing,
      clock: () => nowMs,
    });
    try {
      const opened = await runtime.control.openController({
        qrCredential,
        browserContext: "runtime-reassignment-device",
      });
      if (opened.status !== "opened") throw new Error("Expected the runtime Controller to open.");
      const clock = await runtime.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: previous.eventGameId,
        intent: {
          version: LIVE_EVENT_CONTROL_INTENT_VERSION,
          type: "clock",
          operationId: "runtime-clock-start",
          factId: "runtime-clock-fact",
          running: true,
          gameTimeMs: 0,
          occurrence: { clientOriginAtMs: 0 },
        },
      });
      expect(clock).toMatchObject({ status: "accepted" });
      nowMs = 10_001;

      const storage = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
      try {
        createEventGameRecord(storage, {
          externalScopeResolver: createExternalScopeResolver(previous),
          interpreter: createLiveEventGameIqaInterpreter(),
        });
        const result = await storage.transaction((transaction) =>
          createControlScopeResolver(() => nowMs).resolveSession?.(
            current.externalScope,
            previous.eventGameId,
            transaction,
          ),
        );
        expect(result).toEqual({
          status: "pinned",
          sessionEventGameId: previous.eventGameId,
          currentEventGameId: current.eventGameId,
        });
        expect(await storage.readRoot(previous.recordId)).toMatchObject({
          lifecycle: { phase: "in-progress", commencedAtMs: 10_000 },
        });
      } finally {
        storage.close();
      }
    } finally {
      runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function createGrantOptions(environmentId: string, keyRing: GrantKeyRing): GrantAuthorityOptions {
  return {
    environmentId,
    clock: { nowMs: () => 10_000 },
    randomness: { bytes: (length) => crypto.getRandomValues(new Uint8Array(length)) },
    keyRing,
    controlScopeResolver: {
      resolve(scope, snapshot) {
        if (snapshot === undefined) return { status: "unavailable" };
        const candidate = snapshot.findRootByPitchSlotId(scope.pitchSlotId);
        return candidate !== null && sameScope(candidate.externalScope, scope)
          ? { status: "eligible", eventGameId: candidate.eventGameId }
          : { status: "empty" };
      },
    },
    privilegedAuthorityVerifier: createGrantTestAuthorityVerifier(),
  };
}

function createExternalScopeResolver(root: EventGameRecordRoot) {
  return {
    resolve(scope: EventGameRecordRoot["externalScope"]) {
      return sameScope(scope, root.externalScope)
        ? { status: "resolved" as const, scope: structuredClone(scope) }
        : { status: "mismatch" as const, detail: "scope mismatch" };
    },
    resolveEventTeam() {
      return { status: "resolved" as const };
    },
  };
}

function createRoot(): EventGameRecordRoot {
  return {
    recordId: "runtime-record-1",
    eventId: "runtime-event-1",
    eventGameId: "runtime-game-1",
    ownership: { eventId: "runtime-event-1", eventGameId: "runtime-game-1" },
    externalScope: {
      eventId: "runtime-event-1",
      gameDayId: "runtime-day-1",
      pitchId: "runtime-pitch-1",
      pitchSlotId: "runtime-slot-1",
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
      interpreterVersion: "live-event-iqa-v1",
    },
    creationEvidence: {
      operationId: "runtime-register-1",
      actorReference: "runtime-test",
      source: "event-game-registration",
      createdAtMs: 1_000,
    },
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

function encodeKey(value: Uint8Array | undefined): string {
  if (value === undefined) throw new Error("Expected a test key.");
  return Buffer.from(value).toString("base64url");
}

function sameScope(
  left: EventGameRecordRoot["externalScope"],
  right: EventGameRecordRoot["externalScope"],
): boolean {
  return (
    left.eventId === right.eventId &&
    left.gameDayId === right.gameDayId &&
    left.pitchId === right.pitchId &&
    left.pitchSlotId === right.pitchSlotId
  );
}
