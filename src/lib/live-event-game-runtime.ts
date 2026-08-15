import { randomBytes } from "node:crypto";
import type {
  AudienceProjectionGameInput,
  AudienceProjectionGameInputOutcome,
  PublicAudienceGamePhase,
  PublicAudienceGameOperationalStatus,
} from "@/lib/audience-projection";
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
  type ControllerProjection,
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
import { resolveHeatStoppageConfiguration as resolvePublishedHeatStoppageConfiguration } from "@/lib/heat-stoppage-configuration";
import type { FoundationStorage } from "@/lib/foundation-storage";

export type LiveEventGameRuntime = {
  control: ReturnType<typeof createLiveEventGameControl>;
  readAudienceProjectionGameInput(eventGameId: string): Promise<AudienceProjectionGameInputOutcome>;
  close(): void;
};

export function readAudienceProjectionGameInput(
  root: EventGameRecordRoot | null,
  projection: ControllerProjection | null,
): AudienceProjectionGameInputOutcome {
  if (root === null || projection === null || projection.presentation === undefined) {
    return { status: "unavailable" };
  }
  const gameSideIds = root.gameSides.map((side) => side.id);
  if (gameSideIds.length !== 2) return { status: "unavailable" };
  const phase: PublicAudienceGamePhase =
    projection.overtime === true
      ? "overtime"
      : projection.clock.cues.seekerRelease === "released"
        ? "seekers-released"
        : "seeker-floor";
  const operationalStatus: PublicAudienceGameOperationalStatus =
    projection.phase === "finished"
      ? "finished"
      : projection.phase === "suspended"
        ? "suspended"
        : projection.phase === "scheduled"
          ? "scheduled"
          : projection.clock.running
            ? "running"
            : "paused";
  const timeout = projection.timeout ?? {
    status: "inactive" as const,
    gameSideId: null,
    remainingMs: null,
  };
  const heat = projection.heat ?? {
    status: "inactive" as const,
    mode: null,
    pendingTriggerGameTimeMs: null,
    allowedDurationMs: null,
    actualDurationMs: null,
    completionAtTrustedAtMs: null,
  };
  const allowedDurationMs = heat.allowedDurationMs ?? null;
  const actualDurationMs = heat.actualDurationMs ?? null;
  const remainingMs =
    allowedDurationMs !== null && actualDurationMs !== null
      ? Math.max(0, allowedDurationMs - actualDurationMs)
      : heat.completionAtTrustedAtMs === null || heat.completionAtTrustedAtMs === undefined
        ? null
        : Math.max(0, heat.completionAtTrustedAtMs - projection.clock.projectedAtMs);
  const value: AudienceProjectionGameInput = {
    gameSideIds: [gameSideIds[0]!, gameSideIds[1]!] as const,
    phase,
    operationalStatus,
    scoreByGameSide: structuredClone(projection.scoreByGameSide),
    clock: structuredClone(projection.clock),
    presentation: structuredClone(projection.presentation),
    overtimeTarget: projection.overtimeTarget ?? null,
    teamTimeout: {
      status: timeout.status,
      gameSideId: timeout.gameSideId ?? null,
      remainingMs: timeout.remainingMs ?? null,
    },
    heatStoppage: {
      status: heat.status,
      mode: heat.mode ?? null,
      pending: (heat.pendingTriggerGameTimeMs ?? null) !== null,
      allowedDurationMs,
      actualDurationMs,
      remainingMs,
    },
    winnerGameSideId: projection.winnerGameSideId ?? null,
    catchingGameSideId: projection.catch?.catchingGameSideId ?? null,
    locked: root.lifecycle.lockedAtMs !== null,
  };
  return { status: "accepted", value };
}

export async function openLiveEventGameRuntime(input: {
  databasePath: string;
  environmentId: string;
  keyRing: GrantKeyRing;
  clock?: () => number;
  knownDodgeballIdsForEventGame?: (eventGameId: string) => readonly string[] | undefined;
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
        (() => {
          const validation = validateLiveEventGameActionInTransaction(
            transaction.listActions(root.recordId),
            root,
            action,
            input.knownDodgeballIdsForEventGame?.(root.eventGameId) ?? null,
          );
          if (validation.status === "rejected") return validation;
          if (
            action.interpretation.type !== "fact" ||
            action.interpretation.factType !== "heat-mode"
          )
            return validation;
          const payload = action.interpretation.payload;
          const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
          const configured = resolvePublishedHeatStoppageConfiguration(transaction, {
            eventId: root.externalScope.eventId,
            gameDayId: root.externalScope.gameDayId,
            eventGameId: root.eventGameId,
          });
          if (configured === null || data?.enabled !== (configured === "enabled")) {
            return {
              status: "rejected",
              reason: "invalid-action" as const,
              detail: "Heat Stoppage Configuration changed or is unavailable.",
            };
          }
          return validation;
        })(),
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
      resolveEventTeamName: async (eventId, eventTeamId) =>
        storage.transaction((transaction) => {
          const team = transaction.findEventTeam(eventTeamId);
          return team?.eventId === eventId ? team.name : null;
        }),
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
        evidence,
      }) => {
        if (evidence !== undefined && lockedReplayCapability.authorized(evidence)) return true;
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
      knownDodgeballIdsForEventGame: input.knownDodgeballIdsForEventGame,
      readHeatStoppageConfiguration: (scope: {
        eventId: string;
        gameDayId: string;
        eventGameId: string;
      }) =>
        storage.transaction((snapshot) =>
          resolvePublishedHeatStoppageConfiguration(snapshot, scope),
        ),
    });
    const lockTimer = setInterval(() => {
      void control.reconcileEventGameLocks();
    }, 1_000);
    refreshEventCapacitySnapshot = () => {
      void control.reconcileActiveControllerSessions();
    };
    return {
      control,
      async readAudienceProjectionGameInput(eventGameId) {
        const root = await storage.transaction((transaction) =>
          transaction.findRootByEventGameId(eventGameId),
        );
        const projection = await control.readControllerProjection(eventGameId);
        return readAudienceProjectionGameInput(root, projection);
      },
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
    controlScopeResolver: createControlScopeResolver(clock, false),
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

export function readLiveEventDodgeballIdsByEventGame(
  environmentVariables: Record<string, string | undefined> = process.env,
): ((eventGameId: string) => readonly string[] | undefined) | undefined {
  const configured = environmentVariables.EVENT_GAME_DODGEBALL_IDS_BY_EVENT_GAME?.trim();
  if (configured === undefined || configured === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(configured);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const entries = Object.entries(parsed);
    const map = new Map<string, readonly string[]>();
    for (const [eventGameId, value] of entries) {
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.some((ballId) => typeof ballId !== "string" || ballId.trim() === "")
      )
        return undefined;
      map.set(
        eventGameId,
        [...new Set(value)].sort((left, right) => left.localeCompare(right)),
      );
    }
    return (eventGameId) => map.get(eventGameId);
  } catch {
    return undefined;
  }
}

export function createControlScopeResolver(
  clock: () => number = () => Date.now(),
  persistPassiveCommencement = true,
): GrantAuthorityOptions["controlScopeResolver"] {
  return {
    resolve(scope, snapshot) {
      if (snapshot === undefined) return { status: "unavailable" };
      const current = resolveCurrentRootForSlot(
        scope,
        snapshot,
        clock(),
        persistPassiveCommencement,
      );
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
      const resolvedCurrent = resolveCurrentRootForSlot(
        scope,
        snapshot,
        clock(),
        persistPassiveCommencement,
      );
      if (resolvedCurrent.status === "conflict") return resolvedCurrent;
      const current = resolvedCurrent.root;
      if (current === null) {
        const sessionRootValue = snapshot.findRootByEventGameId(sessionEventGameId);
        const sessionRoot =
          sessionRootValue === null
            ? null
            : materializeCommencement(
                sessionRootValue,
                snapshot,
                clock(),
                persistPassiveCommencement,
              );
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
          : materializeCommencement(
              sessionRootValue,
              snapshot,
              clock(),
              persistPassiveCommencement,
            );
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
  persistPassiveCommencement: boolean,
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
        root: materializeCommencement(legacyRoot, snapshot, nowMs, persistPassiveCommencement),
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
      root:
        storedRoot === null
          ? null
          : materializeCommencement(storedRoot, snapshot, nowMs, persistPassiveCommencement),
    };
  }
  const storedRoot = snapshot.findRootByPitchSlotId(scope.pitchSlotId);
  if (storedRoot === null) return { status: "resolved", root: null };
  if (!sameScope(storedRoot.externalScope, scope)) return { status: "conflict" };
  return {
    status: "resolved",
    root: materializeCommencement(storedRoot, snapshot, nowMs, persistPassiveCommencement),
  };
}

function materializeCommencement(
  root: EventGameRecordRoot,
  snapshot: FoundationStorageSnapshot,
  nowMs: number,
  persist: boolean,
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
  if (persist && typeof transaction.updateRoot === "function") {
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

export function createExternalScopeResolver(): ExternalScopeResolver {
  return {
    resolve(scope, snapshot) {
      const root = snapshot.findRootByPitchSlotId(scope.pitchSlotId);
      return root !== null && sameScope(root.externalScope, scope)
        ? { status: "resolved", scope: structuredClone(scope) }
        : { status: "mismatch", detail: "Event Game Pitch Slot is unavailable." };
    },
    resolveEventTeam(eventId, eventTeamId, snapshot) {
      const team = snapshot.findEventTeam(eventTeamId);
      return eventId.length > 0 && team !== null && team.eventId === eventId
        ? { status: "resolved" }
        : { status: "missing", detail: "Event Team is unavailable." };
    },
    resolveEventTeamDefaultColor(eventId, eventTeamId, snapshot) {
      const team = snapshot.findEventTeam(eventTeamId);
      return team?.eventId === eventId ? team.defaultColor : null;
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
