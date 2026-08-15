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
import { lockControlGrantEventGame } from "@/lib/grant-management-sessions";
import type {
  FoundationStorageSnapshot,
  FoundationStorageTransaction,
} from "@/lib/foundation-storage";
import type { FoundationStorage } from "@/lib/foundation-storage";

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
    const grantOptions = createGrantOptions(
      input.environmentId,
      input.keyRing,
      clock,
      () => refreshEventCapacitySnapshot(),
      storage,
    );
    const authority = createTypedGrantAuthority(storage, grantOptions);
    const scopeResolver = createExternalScopeResolver();
    const lockedReplayCapabilities = new Map<
      string,
      { replayDigest: string; reservationId: string | null; authorized: boolean }
    >();
    const lockedReplayCapability = {
      issue(replayDigest: string) {
        const evidence = randomBytes(32).toString("base64url");
        lockedReplayCapabilities.set(evidence, {
          replayDigest,
          reservationId: null,
          authorized: false,
        });
        return evidence;
      },
      remember(input: { evidence: string; replayDigest: string; reservationId: string }) {
        const current = lockedReplayCapabilities.get(input.evidence);
        if (current?.replayDigest !== input.replayDigest) return;
        lockedReplayCapabilities.set(input.evidence, {
          replayDigest: input.replayDigest,
          reservationId: input.reservationId,
          authorized: current.authorized,
        });
      },
      find(replayDigest: string) {
        for (const [evidence, capability] of lockedReplayCapabilities) {
          if (capability.replayDigest === replayDigest && capability.reservationId !== null)
            return evidence;
        }
        return null;
      },
      authorize(replayDigest: string) {
        for (const [evidence, capability] of lockedReplayCapabilities) {
          if (capability.replayDigest === replayDigest) {
            lockedReplayCapabilities.set(evidence, { ...capability, authorized: true });
          }
        }
      },
      authorized(evidence: string) {
        return lockedReplayCapabilities.get(evidence)?.authorized === true;
      },
      reservationId(evidence: string) {
        return lockedReplayCapabilities.get(evidence)?.reservationId ?? null;
      },
    };
    const acceptance = createFoundationAcceptance(storage, {
      grant: grantOptions,
      externalScopeResolver: scopeResolver,
      interpreter: createLiveEventGameIqaInterpreter(),
      clock,
      verifyLockedReplay: ({ evidence }) =>
        typeof evidence === "string" &&
        lockedReplayCapability.reservationId(evidence) !== null &&
        lockedReplayCapability.authorized(evidence),
      authorizeLockedReplay: ({ evidence }) => lockedReplayCapability.authorized(evidence),
      lockedReplayReservationId: (evidence) =>
        typeof evidence === "string" ? lockedReplayCapability.reservationId(evidence) : null,
      replayEligibility: ({ replayEvidenceId }) =>
        lockedReplayCapability.reservationId(replayEvidenceId) !== null
          ? { status: "eligible" }
          : { status: "ineligible" },
      validateActionInTransaction: ({ transaction, root, action }) =>
        validateLiveEventGameActionInTransaction(
          transaction.listActions(root.recordId),
          root,
          action,
        ),
    });
    const hasLifecycleInventory = await storage.transaction(
      (transaction) => typeof transaction.listRoots === "function",
    );
    if (!hasLifecycleInventory)
      throw new Error("Durable Event Game lifecycle inventory is not available.");
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
      listEventGameRoots: async () =>
        storage.transaction((transaction) => {
          if (typeof transaction.listRoots !== "function")
            throw new Error("Durable Event Game lifecycle inventory is not available.");
          return transaction.listRoots();
        }),
      lockedReplayCapability,
      authorizeLockedReplay: async ({
        sessionBearer,
        eventGameId,
        grantSessionId,
        grantVersion,
      }) => {
        const authorized = await authority.authorizeGrant({
          sessionBearer,
          eventGameId,
          readOnly: true,
        });
        return (
          authorized.status === "authorized" &&
          authorized.grantType === "control" &&
          authorized.eventGameId === eventGameId &&
          authorized.grantSessionId === grantSessionId &&
          authorized.grantVersion === grantVersion
        );
      },
      lockEventGame: (eventGameId, lockedAtMs) =>
        lockControlGrantEventGame(storage, grantOptions, {
          kind: "event-game-lock",
          eventGameId,
          lockedAtMs,
        }),
    });
    const lockTimer = setInterval(() => {
      void control.reconcileEventGameLocks();
    }, 1_000);
    refreshEventCapacitySnapshot = () => {
      void control.reconcileActiveControllerSessions();
    };
    return {
      control,
      close() {
        clearInterval(lockTimer);
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
  storage?: FoundationStorage,
): GrantAuthorityOptions {
  const options: GrantAuthorityOptions = {
    environmentId,
    clock: { nowMs: clock },
    randomness: { bytes: (length) => new Uint8Array(randomBytes(length)) },
    keyRing,
    controlScopeResolver: createControlScopeResolver(clock),
    privilegedAuthorityVerifier: { verify: () => null },
    onLifecycleChange,
  };
  if (storage !== undefined) {
    options.controlGrantLifecycle = {
      resolveEventGameLock(evidence) {
        if (!isRecord(evidence) || evidence.kind !== "event-game-lock") return null;
        const eventGameId = evidence.eventGameId;
        const lockedAtMs = evidence.lockedAtMs;
        if (
          typeof eventGameId !== "string" ||
          typeof lockedAtMs !== "number" ||
          !Number.isSafeInteger(lockedAtMs) ||
          lockedAtMs < 0
        )
          return null;
        return {
          eventGameId,
          apply(transaction) {
            const current = transaction.findRootByEventGameId(eventGameId);
            if (
              current === null ||
              current.lifecycle.phase !== "finished" ||
              current.lifecycle.finishedAtMs === null ||
              current.lifecycle.lockedAtMs !== null
            )
              throw new Error("Only an unlocked finished Event Game may be locked.");
            const locked = validateEventGameRecordRoot({
              ...current,
              lifecycle: {
                ...current.lifecycle,
                lockedAtMs,
                lockReason: "finished-inactivity",
              },
            });
            if (!locked.ok) throw new Error(locked.error);
            transaction.updateRoot({
              root: locked.value,
              canonicalContent: canonicalizeEventGameRecordRoot(locked.value),
            });
          },
        };
      },
    };
  }
  return options;
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
