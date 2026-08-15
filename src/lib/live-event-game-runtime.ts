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
  validateLiveEventGameActionInTransaction,
} from "@/lib/live-event-game-control";
import { createTypedGrantAuthority } from "@/lib/grant-management";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import type { ControlGrantScope, GrantKeyRing } from "@/lib/grant-types";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import {
  canonicalizeEventGameRecordRoot,
  validateEventGameRecordRoot,
} from "@/lib/foundation-record-types";
import type {
  FoundationStorageSnapshot,
  FoundationStorageTransaction,
} from "@/lib/foundation-storage";

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
    let refreshEventCapacitySnapshot = () => {};
    const grantOptions = createGrantOptions(input.environmentId, input.keyRing, clock, () =>
      refreshEventCapacitySnapshot(),
    );
    const authority = createTypedGrantAuthority(storage, grantOptions);
    const scopeResolver = createExternalScopeResolver();
    const acceptance = createFoundationAcceptance(storage, {
      grant: grantOptions,
      externalScopeResolver: scopeResolver,
      interpreter: createLiveEventGameIqaInterpreter(),
      clock,
      validateActionInTransaction: ({ transaction, root, action }) =>
        validateLiveEventGameActionInTransaction(
          transaction.listActions(root.recordId),
          root,
          action,
        ),
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
    const control = createLiveEventGameControl({
      resolveEventGameRecord,
      acceptance,
      grantAuthority: authority,
      clock,
    });
    refreshEventCapacitySnapshot = () => {
      void control.reconcileActiveControllerSessions();
    };
    return {
      control,
      close() {
        control.close();
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
  onLifecycleChange?: () => void,
): GrantAuthorityOptions {
  return {
    environmentId,
    clock: { nowMs: clock },
    randomness: { bytes: (length) => new Uint8Array(randomBytes(length)) },
    keyRing,
    controlScopeResolver: createControlScopeResolver(clock),
    privilegedAuthorityVerifier: { verify: () => null },
    onLifecycleChange,
  };
}

export function createControlScopeResolver(
  clock: () => number = () => Date.now(),
): GrantAuthorityOptions["controlScopeResolver"] {
  return {
    resolve(scope, snapshot) {
      if (snapshot === undefined) return { status: "unavailable" };
      const current = resolveCurrentRootForSlot(scope, snapshot, clock());
      if (current.status === "conflict") return current;
      const root = current.root;
      if (root === null) return { status: "empty" };
      if (root.lifecycle.lockedAtMs !== null) {
        return { status: "terminal", reason: "game-locked", eventGameId: root.eventGameId };
      }
      return { status: "eligible", eventGameId: root.eventGameId };
    },
    resolveSession(scope, sessionEventGameId, snapshot) {
      if (snapshot === undefined) return { status: "unavailable" };
      const resolvedCurrent = resolveCurrentRootForSlot(scope, snapshot, clock());
      if (resolvedCurrent.status === "conflict") return resolvedCurrent;
      const current = resolvedCurrent.root;
      if (current === null) {
        const sessionRootValue = snapshot.findRootByEventGameId(sessionEventGameId);
        const sessionRoot =
          sessionRootValue === null
            ? null
            : materializeCommencement(sessionRootValue, snapshot, clock());
        if (sessionRoot !== null && sessionRoot.lifecycle.commencedAtMs !== null) {
          return {
            status: "pinned",
            sessionEventGameId,
            currentEventGameId: sessionEventGameId,
          };
        }
        return { status: "empty" };
      }
      if (current.lifecycle.lockedAtMs !== null) {
        return { status: "game-locked", eventGameId: current.eventGameId };
      }
      if (current.eventGameId === sessionEventGameId) {
        return { status: "current", eventGameId: current.eventGameId };
      }
      const sessionRootValue = snapshot.findRootByEventGameId(sessionEventGameId);
      const sessionRoot =
        sessionRootValue === null
          ? null
          : materializeCommencement(sessionRootValue, snapshot, clock());
      return sessionRoot !== null && sessionRoot.lifecycle.commencedAtMs !== null
        ? {
            status: "pinned",
            sessionEventGameId,
            currentEventGameId: current.eventGameId,
          }
        : {
            status: "switchable",
            previousEventGameId: sessionEventGameId,
            currentEventGameId: current.eventGameId,
          };
    },
  };
}

function resolveCurrentRootForSlot(
  scope: ControlGrantScope,
  snapshot: FoundationStorageSnapshot,
  nowMs: number,
): { status: "resolved"; root: EventGameRecordRoot | null } | { status: "conflict" } {
  const catalogGames = snapshot
    .listEventGames?.(scope.gameDayId)
    ?.filter((game) => game.pitchSlotId === scope.pitchSlotId);
  if (catalogGames !== undefined) {
    if (catalogGames.length > 1) return { status: "conflict" };
    const game = catalogGames[0];
    if (game === undefined) {
      const legacyRoot = snapshot.findRootByPitchSlotId(scope.pitchSlotId);
      if (
        legacyRoot === null ||
        (snapshot.findEventGame !== undefined &&
          snapshot.findEventGame(legacyRoot.eventGameId) !== null)
      ) {
        return { status: "resolved", root: null };
      }
      if (!sameScope(legacyRoot.externalScope, scope)) return { status: "conflict" };
      return {
        status: "resolved",
        root: materializeCommencement(legacyRoot, snapshot, nowMs),
      };
    }
    const pitch = snapshot.findPitchSlot?.(game.pitchSlotId);
    if (
      game.eventId !== scope.eventId ||
      game.gameDayId !== scope.gameDayId ||
      pitch === null ||
      pitch === undefined ||
      pitch.pitchId !== scope.pitchId
    )
      return { status: "conflict" };
    const storedRoot = snapshot.findRootByEventGameId(game.eventGameId);
    return {
      status: "resolved",
      root: storedRoot === null ? null : materializeCommencement(storedRoot, snapshot, nowMs),
    };
  }
  const storedRoot = snapshot.findRootByPitchSlotId(scope.pitchSlotId);
  if (storedRoot === null) return { status: "resolved", root: null };
  if (!sameScope(storedRoot.externalScope, scope)) return { status: "conflict" };
  return { status: "resolved", root: materializeCommencement(storedRoot, snapshot, nowMs) };
}

function materializeCommencement(
  root: EventGameRecordRoot,
  snapshot: FoundationStorageSnapshot,
  nowMs: number,
): EventGameRecordRoot {
  if (root.lifecycle.phase !== "scheduled" || root.lifecycle.commencedAtMs !== null) return root;
  if (typeof snapshot.listActions !== "function") return root;
  const runningSinceMs = latestRunningClockStart(snapshot.listActions(root.recordId));
  if (runningSinceMs === null || nowMs < runningSinceMs + 10_000) return root;
  const candidate = {
    ...root,
    lifecycle: {
      ...root.lifecycle,
      phase: "in-progress" as const,
      commencedAtMs: runningSinceMs + 10_000,
    },
  };
  const validated = validateEventGameRecordRoot(candidate);
  if (!validated.ok) return root;
  const transaction = snapshot as FoundationStorageTransaction;
  if (typeof transaction.updateRoot === "function") {
    transaction.updateRoot({
      root: validated.value,
      canonicalContent: canonicalizeEventGameRecordRoot(validated.value),
    });
  }
  return validated.value;
}

function latestRunningClockStart(
  actions: readonly { action: { interpretation: unknown } }[],
): number | null {
  for (const stored of [...actions].reverse()) {
    const interpretation = stored.action.interpretation;
    if (
      !isRecord(interpretation) ||
      interpretation.type !== "fact" ||
      interpretation.factType !== "clock"
    )
      continue;
    const payload = interpretation.payload;
    if (!isRecord(payload) || !isRecord(payload.data)) return null;
    if (payload.data.running !== true) return null;
    return typeof payload.data.startedAtMs === "number" ? payload.data.startedAtMs : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
