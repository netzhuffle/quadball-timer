import { randomBytes } from "node:crypto";
import { createFoundationAcceptance } from "@/lib/foundation-acceptance";
import { createEventGameRecord, type ExternalScopeResolver } from "@/lib/event-game-record";
import type { EventGameRecord } from "@/lib/event-game-record";
import {
  openSqliteFoundationStorage,
  readSqliteFoundationStorageReadiness,
} from "@/lib/foundation-storage-sqlite";
import {
  createLiveEventGameControl,
  createLiveEventGameIqaInterpreter,
} from "@/lib/live-event-game-control";
import { createTypedGrantAuthority } from "@/lib/grant-management";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import type { GrantKeyRing } from "@/lib/grant-types";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";

export type LiveEventGameRuntime = {
  control: ReturnType<typeof createLiveEventGameControl>;
  close(): void;
};

export async function openLiveEventGameRuntime(input: {
  databasePath: string;
  environmentId: string;
  keyRing: GrantKeyRing;
  clock?: () => number;
}): Promise<LiveEventGameRuntime> {
  const readiness = await readSqliteFoundationStorageReadiness(input.databasePath, {
    grantKeyRing: input.keyRing,
  });
  if (!readiness.ok) {
    throw new Error("Durable Event Game storage is not ready.");
  }

  const storage = openSqliteFoundationStorage(input.databasePath, { grantKeyRing: input.keyRing });
  try {
    const clock = input.clock ?? (() => Date.now());
    const grantOptions = createGrantOptions(input.environmentId, input.keyRing, clock);
    const authority = createTypedGrantAuthority(storage, grantOptions);
    const scopeResolver = createExternalScopeResolver();
    const acceptance = createFoundationAcceptance(storage, {
      grant: grantOptions,
      externalScopeResolver: scopeResolver,
      interpreter: createLiveEventGameIqaInterpreter(),
      clock,
    });
    const records = new Map<string, EventGameRecord>();
    const resolveEventGameRecord = async (eventGameId: string) => {
      const root = await storage.transaction((transaction) =>
        transaction.findRootByEventGameId(eventGameId),
      );
      if (root === null) return null;
      let record = records.get(root.recordId);
      if (record === undefined) {
        record = createEventGameRecord(storage, {
          externalScopeResolver: scopeResolver,
          interpreter: createLiveEventGameIqaInterpreter(),
        });
        records.set(root.recordId, record);
      }
      const activation = await record.registerRoot(root);
      if (activation.status !== "registered" && activation.status !== "idempotent") {
        return null;
      }
      return { recordId: root.recordId, record };
    };
    return {
      control: createLiveEventGameControl({
        resolveEventGameRecord,
        acceptance,
        grantAuthority: authority,
        clock,
      }),
      close() {
        storage.close();
      },
    };
  } catch (error) {
    storage.close();
    throw error;
  }
}

export function readLiveEventGrantKeyRing(
  environmentVariables: Record<string, string | undefined> = process.env,
): GrantKeyRing | null {
  const encryption = readKey(environmentVariables.EVENT_GAME_ENCRYPTION_KEY, 32);
  const lookup = readKey(environmentVariables.EVENT_GAME_LOOKUP_KEY, 32);
  const audit = readKey(environmentVariables.EVENT_GAME_AUDIT_KEY, 32);
  if (encryption === null || lookup === null || audit === null) return null;
  return {
    encryption: { currentVersion: "encryption-v1", keys: new Map([["encryption-v1", encryption]]) },
    lookup: { currentVersion: "lookup-v1", keys: new Map([["lookup-v1", lookup]]) },
    audit: { currentVersion: "audit-v1", keys: new Map([["audit-v1", audit]]) },
  };
}

function createGrantOptions(
  environmentId: string,
  keyRing: GrantKeyRing,
  clock: () => number,
): GrantAuthorityOptions {
  return {
    environmentId,
    clock: { nowMs: clock },
    randomness: { bytes: (length) => new Uint8Array(randomBytes(length)) },
    keyRing,
    controlScopeResolver: createControlScopeResolver(),
    privilegedAuthorityVerifier: { verify: () => null },
  };
}

function createControlScopeResolver(): GrantAuthorityOptions["controlScopeResolver"] {
  return {
    resolve(scope, snapshot) {
      if (snapshot === undefined) return { status: "unavailable" };
      const root = snapshot.findRootByPitchSlotId(scope.pitchSlotId);
      if (root === null) return { status: "empty" };
      if (
        root.externalScope.eventId !== scope.eventId ||
        root.externalScope.gameDayId !== scope.gameDayId ||
        root.externalScope.pitchId !== scope.pitchId
      )
        return { status: "conflict" };
      if (root.lifecycle.lockedAtMs !== null) {
        return { status: "terminal", reason: "game-locked", eventGameId: root.eventGameId };
      }
      return { status: "eligible", eventGameId: root.eventGameId };
    },
  };
}

function createExternalScopeResolver(): ExternalScopeResolver {
  return {
    resolve(scope, snapshot) {
      const root = snapshot.findRootByPitchSlotId(scope.pitchSlotId);
      return root !== null && sameScope(root.externalScope, scope)
        ? { status: "resolved", scope: structuredClone(scope) }
        : { status: "mismatch", detail: "Event Game Pitch Slot is unavailable." };
    },
    resolveEventTeam(eventId, eventTeamId, _snapshot) {
      return eventId.length > 0 && eventTeamId.length > 0
        ? { status: "resolved" }
        : { status: "missing", detail: "Event Team is unavailable." };
    },
  };
}

function readKey(value: string | undefined, bytes: number): Uint8Array | null {
  if (value === undefined) return null;
  try {
    const decoded = new Uint8Array(Buffer.from(value, "base64url"));
    return decoded.byteLength === bytes && Buffer.from(decoded).toString("base64url") === value
      ? decoded
      : null;
  } catch {
    return null;
  }
}

function sameScope(
  left: EventGameRecordRoot["externalScope"],
  right: EventGameRecordRoot["externalScope"],
) {
  return (
    left.eventId === right.eventId &&
    left.gameDayId === right.gameDayId &&
    left.pitchId === right.pitchId &&
    left.pitchSlotId === right.pitchSlotId
  );
}
