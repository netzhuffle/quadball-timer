import type {
  EventAdministrationAuthority,
  EventAdministrationOutcome,
} from "@/lib/event-administration";
import {
  actionIdentity,
  type ControlAction,
  type ControlActionInput,
  type ControlAuditEntry,
} from "@/lib/event-game-actions";
import {
  createEventGameRecord,
  type ControlActionAcceptanceOutcome,
  type ExternalScopeResolver,
} from "@/lib/event-game-record";
import { ACCEPTED_AUDIT_DETAIL, acceptedAuditId } from "@/lib/event-game-record-helpers";
import {
  canonicalizeEventGameRecordRoot,
  type EventGameRecordRoot,
} from "@/lib/foundation-record-types";
import type {
  EventCatalogAuditEntry,
  FoundationStorage,
  FoundationStorageTransaction,
  StoredControlAction,
} from "@/lib/foundation-storage";
import {
  GRANT_CREDENTIAL_KIND,
  GRANT_TYPE,
  type StoredGrant,
  type StoredGrantAuditEntry,
  validateControlGrantScope,
} from "@/lib/grant-types";
import {
  createLiveEventGameIqaInterpreter,
  projectLiveEventGameDerivedState,
  validateLockedGameEndStateAgainstRules,
} from "@/lib/live-event-game-control";
import { canonicalizeJson, sha256 } from "@/lib/event-game-action-json";
import { SHARED_LIMITS, validateOpaqueIdentifier } from "@/lib/validation-policy";

export type LockedGameEndState = {
  scoreByGameSide: Readonly<Record<string, number>>;
  winnerGameSideId: string | null;
  flagCatchingGameSideId: string | null;
  catchTimeMs: number | null;
  endTimeMs: number | null;
};
export type LockedGameCorrectionInput = {
  operationId: unknown;
  endState: unknown;
  overrideConfirmed?: unknown;
  previewFingerprint?: unknown;
};
export type GameReopeningPreviewInput = { operationId: unknown };
export type LockedGamePreviewImpact = {
  facts: "preserved" | "corrected";
  lifecycle: { from: string; to: string; lock: "retained" | "removed" };
  timer: "restarted" | "stopped" | "unchanged";
  authority: { controlGrant: "preserved"; qr: "preserved"; grantVersion: "preserved" };
  sessions: { category: "terminated"; count: number };
  code: { category: "expired" | "create-after-reopen"; count: number };
  queuedDiscard: { category: "locked-replay"; count: number };
};
export type LockedGamePreview = {
  eventGameId: string;
  recordId: string;
  operation: "locked-game-correction" | "game-reopening";
  operationId: string;
  impact: LockedGamePreviewImpact;
  fingerprint: string;
};
export type LockedGameCorrectionResult = {
  eventGameId: string;
  recordId: string;
  actionId: string;
  controlAuditId: string;
  eventAuditId: string;
  before: LockedGameEndState;
  after: LockedGameEndState;
  lockRetained: true;
  overrideApplied: boolean;
};
export type GameReopeningInput = { operationId: unknown; previewFingerprint?: unknown };
export type GameReopeningResult = {
  eventGameId: string;
  recordId: string;
  actionId: string;
  controlAuditId: string;
  eventAuditId: string;
  controlGrantVersion: string;
  lockRemoved: true;
  lifecycle: EventGameRecordRoot["lifecycle"];
};

type AuthorizedActor = {
  actorReference: string;
  sessionId: string | null;
  grantVersion: string | null;
};
type Dependencies = {
  storage: FoundationStorage;
  failureInjector?: () => void;
  nowMs: () => number;
  authorize(
    transaction: FoundationStorageTransaction,
    eventId: string,
    authority: EventAdministrationAuthority,
    readOnly?: boolean,
  ): AuthorizedActor | null;
};

type GrantLifecycleSnapshot = {
  grantId: string;
  grantVersion: string;
  codeState: "absent" | "present" | "disabled" | "erased";
  terminatedSessionCount: number;
  activeSessionCount: number;
  codeFingerprint: string | null;
};

type LockedGameContext = {
  root: EventGameRecordRoot;
  before: LockedGameEndState;
  actor: AuthorizedActor;
  grant: GrantLifecycleSnapshot;
  queuedDiscardCount: number;
  rootRevision: {
    metadata: ReturnType<FoundationStorageTransaction["readRecordMetadata"]>;
  };
  duplicateAction?: ControlActionInput;
};

const externalScopeResolver: ExternalScopeResolver = {
  resolve(scope, snapshot) {
    const event = snapshot.findEvent(scope.eventId);
    const day = snapshot
      .listGameDays(scope.eventId)
      .find((candidate) => candidate.gameDayId === scope.gameDayId);
    const pitch = snapshot.findPitch(scope.pitchId);
    const pitchSlot = snapshot.findPitchSlot?.(scope.pitchSlotId);
    const gameplaySlot = snapshot.findGameplaySlot?.(pitchSlot?.gameplaySlotId ?? "");
    return event !== null &&
      day !== undefined &&
      pitch?.eventId === scope.eventId &&
      pitchSlot?.gameDayId === scope.gameDayId &&
      pitchSlot.pitchId === scope.pitchId &&
      gameplaySlot?.gameDayId === scope.gameDayId
      ? { status: "resolved", scope }
      : { status: "mismatch", detail: "Event Game external scope is unavailable." };
  },
  resolveEventTeam(eventId, eventTeamId, snapshot) {
    return snapshot.findEventTeam(eventTeamId)?.eventId === eventId
      ? { status: "resolved" }
      : { status: "mismatch", detail: "Event Team is unavailable." };
  },
};

export function createLockedEventGameAdministration(dependencies: Dependencies) {
  return {
    previewLockedEventGameCorrection(
      eventId: unknown,
      eventGameId: unknown,
      input: LockedGameCorrectionInput,
      authority: EventAdministrationAuthority,
    ) {
      return runCorrectionPreview(dependencies, eventId, eventGameId, input, authority);
    },
    correctLockedEventGame(
      eventId: unknown,
      eventGameId: unknown,
      input: LockedGameCorrectionInput,
      authority: EventAdministrationAuthority,
    ) {
      return runCorrection(dependencies, eventId, eventGameId, input, authority);
    },
    reopenEventGame(
      eventId: unknown,
      eventGameId: unknown,
      input: GameReopeningInput,
      authority: EventAdministrationAuthority,
    ) {
      return runReopening(dependencies, eventId, eventGameId, input, authority);
    },
    previewEventGameReopening(
      eventId: unknown,
      eventGameId: unknown,
      input: GameReopeningPreviewInput,
      authority: EventAdministrationAuthority,
    ) {
      return runReopeningPreview(dependencies, eventId, eventGameId, input, authority);
    },
  };
}

async function runCorrectionPreview(
  dependencies: Dependencies,
  eventIdInput: unknown,
  eventGameIdInput: unknown,
  input: LockedGameCorrectionInput,
  authority: EventAdministrationAuthority,
): Promise<EventAdministrationOutcome<LockedGamePreview>> {
  const ids = parseIds(eventIdInput, eventGameIdInput, input.operationId, "Locked Game Correction");
  if (!ids.ok) return invalid(ids.error);
  const parsed = parseEndState(input.endState);
  if (!parsed.ok) return invalid(parsed.error);
  const context = await readLockedContext(dependencies, ids.eventId, ids.eventGameId, authority);
  if (context.status !== "accepted") return context;
  const after = mergeEndState(context.value.before, parsed.value);
  return accepted(
    makePreview(
      context.value,
      "locked-game-correction",
      ids.operationId,
      after,
      context.value.root.lifecycle,
    ),
  );
}

async function runReopeningPreview(
  dependencies: Dependencies,
  eventIdInput: unknown,
  eventGameIdInput: unknown,
  input: GameReopeningPreviewInput,
  authority: EventAdministrationAuthority,
): Promise<EventAdministrationOutcome<LockedGamePreview>> {
  const ids = parseIds(eventIdInput, eventGameIdInput, input.operationId, "Game Reopening");
  if (!ids.ok) return invalid(ids.error);
  const context = await readLockedContext(dependencies, ids.eventId, ids.eventGameId, authority);
  if (context.status !== "accepted") return context;
  const reopenedRoot = reopeningRoot(context.value.root, context.value.before);
  return accepted(
    makePreview(
      context.value,
      "game-reopening",
      ids.operationId,
      context.value.before,
      reopenedRoot.lifecycle,
    ),
  );
}

async function runCorrection(
  dependencies: Dependencies,
  eventIdInput: unknown,
  eventGameIdInput: unknown,
  input: LockedGameCorrectionInput,
  authority: EventAdministrationAuthority,
): Promise<EventAdministrationOutcome<LockedGameCorrectionResult>> {
  const ids = parseIds(eventIdInput, eventGameIdInput, input.operationId, "Locked Game Correction");
  if (!ids.ok) return invalid(ids.error);
  const parsed = parseEndState(input.endState);
  if (!parsed.ok) return invalid(parsed.error);
  const context = await readLockedContext(dependencies, ids.eventId, ids.eventGameId, authority);
  if (context.status !== "accepted") return context;
  const after = mergeEndState(context.value.before, parsed.value);
  const preview = makePreview(
    context.value,
    "locked-game-correction",
    ids.operationId,
    after,
    context.value.root.lifecycle,
  );
  if (input.previewFingerprint !== preview.fingerprint)
    return invalid("A fresh Locked Game Correction preview is required.");
  const inconsistent =
    validateLockedGameEndStateAgainstRules(context.value.root, after).status === "rejected";
  if (inconsistent && input.overrideConfirmed !== true)
    return invalid("This Locked Game Correction requires one confirmation.");
  const nowMs = readNow(dependencies.nowMs);
  if (nowMs === null) return invalid("Event clock returned an invalid timestamp.");
  const actionInput = createAdminFactAction(
    context.value.root,
    ids.operationId,
    nowMs,
    context.value.actor,
    "locked-game-correction",
    { correction: after },
    inconsistent,
    context.value.before,
    after,
  );
  const eventAudit = createEventAuditWriter(
    "locked-game-corrected",
    ids.eventId,
    ids.operationId,
    context.value.root,
    context.value.actor.actorReference,
    nowMs,
  );
  const eventAuditId = eventAudit.id;
  const record = createRecord(dependencies, ids.eventId, authority, {
    requireLocked: true,
    actionInput,
    expectedBefore: context.value.before,
    previewGuard: (transaction, root, actor, input) =>
      previewFingerprintForInput(transaction, root, actor, input) === preview.fingerprint,
    auditContext: () => ({
      linkAcceptance: context.value.actor.sessionId !== null,
      valueChange: { before: context.value.before, after },
    }),
    lifecycleTransition: ({ transaction, root, action, audit }) => ({
      status: "updated",
      root,
      eventAudit: eventAudit(audit.auditId),
      eventAuditId,
      grantAudits: (() => {
        const audits = linkedGrantAudits(transaction, context.value, audit, action, nowMs);
        dependencies.failureInjector?.();
        return audits;
      })(),
    }),
  });
  const registration = await record.registerRoot(context.value.root);
  if (registration.status === "rejected")
    return registration.reason === "storage-not-ready"
      ? unavailable()
      : invalid(registration.detail);
  const outcome = await record.acceptAction(actionInput);
  if (outcome.status === "accepted" || outcome.status === "duplicate-accepted") {
    return accepted({
      eventGameId: ids.eventGameId,
      recordId: context.value.root.recordId,
      actionId: actionIdentity(context.value.root.recordId, outcome.action.operationId),
      controlAuditId: outcome.auditId,
      eventAuditId: outcome.eventAuditId ?? eventAuditId,
      before: context.value.before,
      after,
      lockRetained: true,
      overrideApplied: outcome.action.override !== undefined,
    });
  }
  return mapRecordOutcome(outcome);
}

async function runReopening(
  dependencies: Dependencies,
  eventIdInput: unknown,
  eventGameIdInput: unknown,
  input: GameReopeningInput,
  authority: EventAdministrationAuthority,
): Promise<EventAdministrationOutcome<GameReopeningResult>> {
  const ids = parseIds(eventIdInput, eventGameIdInput, input.operationId, "Game Reopening");
  if (!ids.ok) return invalid(ids.error);
  const context = await readLockedContext(
    dependencies,
    ids.eventId,
    ids.eventGameId,
    authority,
    ids.operationId,
  );
  if (context.status !== "accepted") return context;
  const reopenedRoot = reopeningRoot(context.value.root, context.value.before);
  const preview = makePreview(
    context.value,
    "game-reopening",
    ids.operationId,
    context.value.before,
    reopenedRoot.lifecycle,
  );
  const duplicateRetry = context.value.duplicateAction !== undefined;
  if (!duplicateRetry && input.previewFingerprint !== preview.fingerprint)
    return invalid("A fresh Game Reopening preview is required.");
  const nowMs = readNow(dependencies.nowMs);
  if (nowMs === null) return invalid("Event clock returned an invalid timestamp.");
  const actionInput =
    context.value.duplicateAction ??
    createAdminFactAction(
      context.value.root,
      ids.operationId,
      nowMs,
      context.value.actor,
      "game-reopening",
      { reopening: true },
      false,
    );
  const eventAudit = createEventAuditWriter(
    "game-reopened",
    ids.eventId,
    ids.operationId,
    context.value.root,
    context.value.actor.actorReference,
    nowMs,
  );
  const record = createRecord(dependencies, ids.eventId, authority, {
    requireLocked: true,
    actionInput,
    previewGuard: (transaction, root, actor, input) =>
      previewFingerprintForInput(transaction, root, actor, input) === preview.fingerprint,
    duplicateResolver: (transaction, root, input, prepared) =>
      resolveReopeningDuplicate(dependencies, transaction, root, input, prepared, authority),
    auditContext: () => ({ linkAcceptance: context.value.actor.sessionId !== null }),
    lifecycleTransition: ({ transaction, action, audit }) => {
      transaction.updateRoot({
        root: reopenedRoot,
        canonicalContent: canonicalizeEventGameRecordRoot(reopenedRoot),
      });
      return {
        status: "updated",
        root: reopenedRoot,
        eventAudit: eventAudit(audit.auditId),
        eventAuditId: eventAudit.id,
        grantAudits: (() => {
          const audits = linkedGrantAudits(transaction, context.value, audit, action, nowMs);
          dependencies.failureInjector?.();
          return audits;
        })(),
      };
    },
  });
  const registration = await record.registerRoot(context.value.root);
  if (registration.status === "rejected")
    return registration.reason === "storage-not-ready"
      ? unavailable()
      : invalid(registration.detail);
  const outcome = await record.acceptAction(actionInput);
  if (outcome.status === "accepted" || outcome.status === "duplicate-accepted") {
    return accepted({
      eventGameId: ids.eventGameId,
      recordId: context.value.root.recordId,
      actionId: actionIdentity(context.value.root.recordId, outcome.action.operationId),
      controlAuditId: outcome.auditId,
      eventAuditId: outcome.eventAuditId ?? eventAudit.id,
      controlGrantVersion: context.value.grant.grantVersion,
      lockRemoved: true,
      lifecycle: reopenedRoot.lifecycle,
    });
  }
  return mapRecordOutcome(outcome);
}

function createRecord(
  dependencies: Dependencies,
  eventId: string,
  authority: EventAdministrationAuthority,
  options: {
    requireLocked: boolean;
    actionInput: ControlActionInput;
    expectedBefore?: LockedGameEndState;
    previewGuard?: (
      transaction: FoundationStorageTransaction,
      root: EventGameRecordRoot,
      actor: AuthorizedActor,
      input: unknown,
    ) => boolean;
    duplicateResolver?: (
      transaction: FoundationStorageTransaction,
      root: EventGameRecordRoot,
      input: unknown,
      prepared: import("@/lib/event-game-actions").PreparedControlAction | null,
    ) => ControlActionAcceptanceOutcome | null;
    auditContext?: () => {
      linkAcceptance?: boolean;
      valueChange?: { before: LockedGameEndState; after: LockedGameEndState };
    };
    lifecycleTransition: (input: {
      transaction: FoundationStorageTransaction;
      root: EventGameRecordRoot;
      action: ControlAction;
      audit: ControlAuditEntry;
    }) => {
      status: "updated";
      root: EventGameRecordRoot;
      applyAfterRootUpdate?: (transaction: FoundationStorageTransaction) => void;
      eventAudit?: EventCatalogAuditEntry;
      eventAuditId?: string;
      grantAudits?: readonly StoredGrantAuditEntry[];
    };
  },
) {
  return createEventGameRecord(dependencies.storage, {
    externalScopeResolver,
    clock: dependencies.nowMs,
    interpreter: createLiveEventGameIqaInterpreter(),
    actionAcceptanceGuard: (transaction, root, input) => {
      const actor = dependencies.authorize(transaction, eventId, authority);
      if (actor === null)
        return { status: "rejected", reason: "invalid-action", detail: "event-admin-unauthorized" };
      if (options.requireLocked && root.lifecycle.lockedAtMs === null)
        return { status: "rejected", reason: "invalid-action", detail: "event-game-not-locked" };
      if (
        !isRecord(input) ||
        input.eventGameId !== root.eventGameId ||
        input.origin !== "event-admin"
      )
        return {
          status: "rejected",
          reason: "invalid-action",
          detail: "event-admin-action-context-invalid",
        };
      if (actor.sessionId === null && input.grant !== null)
        return {
          status: "rejected",
          reason: "invalid-action",
          detail: "event-admin-grant-context-invalid",
        };
      if (
        actor.sessionId !== null &&
        (!isRecord(input.grant) || input.grant.sessionId !== actor.sessionId)
      )
        return {
          status: "rejected",
          reason: "invalid-action",
          detail: "event-admin-grant-context-invalid",
        };
      if (
        options.previewGuard !== undefined &&
        !options.previewGuard(transaction, root, actor, input)
      )
        return {
          status: "rejected",
          reason: "invalid-action",
          detail: "The Event Game operation preview is stale.",
        };
      if (options.expectedBefore !== undefined) {
        const existing = transaction.findActionByOperationId(root.recordId, input.operationId);
        if (existing === null) {
          const current = projectEndState(root, transaction.listActions(root.recordId));
          if (!sameEndState(current, options.expectedBefore))
            return {
              status: "rejected",
              reason: "operation-conflict",
              detail: "event-game-concurrency-conflict",
            };
        }
      }
      return { status: "accepted" };
    },
    acceptedActionAuditContext: options.auditContext,
    acceptedDuplicateActionResolver: options.duplicateResolver,
    acceptedLifecycleTransition: options.lifecycleTransition,
  });
}

async function readLockedContext(
  dependencies: Dependencies,
  eventId: string,
  eventGameId: string,
  authority: EventAdministrationAuthority,
  duplicateOperationId?: string,
): Promise<
  EventAdministrationOutcome<{
    root: EventGameRecordRoot;
    before: LockedGameEndState;
    actor: AuthorizedActor;
    grant: GrantLifecycleSnapshot;
    queuedDiscardCount: number;
    rootRevision: LockedGameContext["rootRevision"];
    duplicateAction?: ControlActionInput;
  }>
> {
  try {
    return await dependencies.storage.transaction((transaction) => {
      const actor = dependencies.authorize(transaction, eventId, authority, true);
      if (actor === null) return unauthorized();
      const root = transaction.findRootByEventGameId(eventGameId);
      const game = transaction.findEventGame(eventGameId);
      if (root === null || game === null || game.eventId !== eventId) return notFound();
      const existing =
        duplicateOperationId === undefined
          ? null
          : transaction.findActionByOperationId(root.recordId, duplicateOperationId);
      const duplicateAction =
        existing?.action.interpretation.type === "fact" &&
        existing.action.interpretation.factType === "game-reopening"
          ? structuredClone(existing.action)
          : undefined;
      if (root.lifecycle.lockedAtMs === null && duplicateAction === undefined)
        return inUse("Event Game is not locked.");
      const context = contextForTransaction(transaction, root, actor);
      return accepted({
        ...context,
        ...(duplicateAction === undefined ? {} : { duplicateAction }),
      });
    });
  } catch {
    return unavailable();
  }
}

function findControlGrant(
  transaction: FoundationStorageTransaction,
  root: EventGameRecordRoot,
): StoredGrant | null {
  return (
    transaction
      .listGrants()
      .filter((candidate) => {
        if (candidate.grantType !== GRANT_TYPE) return false;
        const scope = validateControlGrantScope(candidate.scope);
        return (
          scope.ok &&
          scope.value.eventId === root.externalScope.eventId &&
          scope.value.gameDayId === root.externalScope.gameDayId &&
          scope.value.pitchId === root.externalScope.pitchId &&
          scope.value.pitchSlotId === root.externalScope.pitchSlotId
        );
      })
      .sort((left, right) => right.createdAtMs - left.createdAtMs)[0] ?? null
  );
}

function makePreview(
  context: LockedGameContext,
  operation: LockedGamePreview["operation"],
  operationId: string,
  after: LockedGameEndState,
  lifecycle: EventGameRecordRoot["lifecycle"],
): LockedGamePreview {
  const reopening = operation === "game-reopening";
  return {
    eventGameId: context.root.eventGameId,
    recordId: context.root.recordId,
    operation,
    operationId,
    impact: {
      facts: reopening ? "preserved" : "corrected",
      lifecycle: {
        from: context.root.lifecycle.phase,
        to: lifecycle.phase,
        lock: reopening ? "removed" : "retained",
      },
      timer: reopening
        ? context.before.endTimeMs === null
          ? "stopped"
          : "restarted"
        : "unchanged",
      authority: { controlGrant: "preserved", qr: "preserved", grantVersion: "preserved" },
      sessions: { category: "terminated", count: context.grant.terminatedSessionCount },
      code: {
        category: reopening ? "create-after-reopen" : "expired",
        count: reopening && context.grant.codeState === "erased" ? 1 : 0,
      },
      queuedDiscard: { category: "locked-replay", count: context.queuedDiscardCount },
    },
    fingerprint: operationFingerprint(context, operation, operationId, after, lifecycle),
  };
}

function operationFingerprint(
  context: LockedGameContext,
  operation: LockedGamePreview["operation"],
  operationId: string,
  after: LockedGameEndState,
  lifecycle: EventGameRecordRoot["lifecycle"],
): string {
  return sha256(
    canonicalizeJson({
      version: "locked-event-game-preview-v1",
      operation,
      operationId,
      eventId: context.root.eventId,
      eventGameId: context.root.eventGameId,
      recordId: context.root.recordId,
      root: canonicalizeEventGameRecordRoot(context.root),
      lifecycle,
      currentEndState: context.before,
      proposedEndState: after,
      authority: context.actor,
      grant: context.grant,
      rootRevision: context.rootRevision,
      queuedDiscardCount: context.queuedDiscardCount,
    }),
  );
}

function reopeningRoot(root: EventGameRecordRoot, before: LockedGameEndState): EventGameRecordRoot {
  const finished = before.endTimeMs !== null;
  return {
    ...root,
    lifecycle: {
      ...root.lifecycle,
      phase: finished ? "finished" : "in-progress",
      finishedAtMs: finished ? root.lifecycle.finishedAtMs : null,
      lockedAtMs: null,
      lockReason: null,
    },
  };
}

function previewFingerprintForInput(
  transaction: FoundationStorageTransaction,
  root: EventGameRecordRoot,
  actor: AuthorizedActor,
  input: unknown,
): string | null {
  if (!isRecord(input) || typeof input.operationId !== "string") return null;
  const context = contextForTransaction(transaction, root, actor);
  const payload = input.payload;
  if (!isRecord(payload) || !isRecord(payload.data)) return null;
  if (payload.factType === "game-reopening" && payload.data.reopening === true) {
    const reopened = reopeningRoot(
      root,
      projectEndState(root, transaction.listActions(root.recordId)),
    );
    return operationFingerprint(
      context,
      "game-reopening",
      input.operationId,
      context.before,
      reopened.lifecycle,
    );
  }
  if (payload.factType !== "locked-game-correction") return null;
  const parsed = parseEndState(payload.data.correction);
  if (!parsed.ok) return null;
  const before = projectEndState(root, transaction.listActions(root.recordId));
  return operationFingerprint(
    context,
    "locked-game-correction",
    input.operationId,
    mergeEndState(before, parsed.value),
    root.lifecycle,
  );
}

function contextForTransaction(
  transaction: FoundationStorageTransaction,
  root: EventGameRecordRoot,
  actor: AuthorizedActor,
): LockedGameContext {
  const grant = findControlGrant(transaction, root);
  if (grant === null) throw new Error("The Event Game Control Grant is unavailable.");
  const sessions = transaction.listGrantSessions(grant.grantId);
  return {
    root,
    before: projectEndState(root, transaction.listActions(root.recordId)),
    actor,
    grant: {
      grantId: grant.grantId,
      grantVersion: grant.grantVersion,
      codeState: grant.code?.state ?? "absent",
      terminatedSessionCount: sessions.filter((session) => session.status !== "active").length,
      activeSessionCount: sessions.filter((session) => session.status === "active").length,
      codeFingerprint: grant.code?.fingerprint ?? null,
    },
    rootRevision: {
      metadata: transaction.readRecordMetadata(root.recordId),
    },
    queuedDiscardCount: Math.min(
      1000,
      transaction
        .listAuditEntries(root.recordId)
        .reduce((count, audit) => count + (audit.lockedReplay?.count ?? 0), 0),
    ),
  };
}

function sameActionInput(input: Record<string, unknown>, action: ControlAction): boolean {
  const comparableInput = JSON.parse(
    JSON.stringify({
      recordId: input.recordId,
      eventGameId: input.eventGameId,
      operationId: input.operationId,
      kind: input.kind,
      payload: input.payload,
      causalPredecessorIds: input.causalPredecessorIds,
      occurrence: input.occurrence,
      grant: input.grant,
      origin: input.origin,
      lifecycle: input.lifecycle,
      override: input.override,
      recoveryProvenance: input.recoveryProvenance,
    }),
  );
  const comparableAction = JSON.parse(
    JSON.stringify({
      recordId: action.recordId,
      eventGameId: action.eventGameId,
      operationId: action.operationId,
      kind: action.kind,
      payload: action.payload,
      causalPredecessorIds: action.causalPredecessorIds,
      occurrence: action.occurrence,
      grant: action.grant,
      origin: action.origin,
      lifecycle: action.lifecycle,
      override: action.override,
      recoveryProvenance: action.recoveryProvenance,
    }),
  );
  return canonicalizeJson(comparableInput) === canonicalizeJson(comparableAction);
}

function resolveReopeningDuplicate(
  dependencies: Dependencies,
  transaction: FoundationStorageTransaction,
  root: EventGameRecordRoot,
  _input: unknown,
  prepared: import("@/lib/event-game-actions").PreparedControlAction | null,
  authority: EventAdministrationAuthority,
): ControlActionAcceptanceOutcome | null {
  const actor = dependencies.authorize(transaction, root.eventId, authority);
  if (actor === null || !isRecord(_input) || typeof _input.operationId !== "string") return null;
  const existing = transaction.findActionByOperationId(root.recordId, _input.operationId);
  if (existing === null) return null;
  const same =
    ((prepared !== null && existing.contentFingerprint === prepared.contentFingerprint) ||
      (prepared === null && sameActionInput(_input, existing.action))) &&
    existing.action.interpretation.type === "fact" &&
    existing.action.interpretation.factType === "game-reopening";
  if (same) {
    return {
      status: "duplicate-accepted",
      action: structuredClone(existing.action),
      auditId: acceptedAuditId(existing.action),
      eventAuditId: eventAuditIdFor(root.eventId, existing.action.operationId, "game-reopened"),
    };
  }
  return {
    status: "rejected",
    reason: "operation-conflict",
    detail: "The operation identity is already bound to different content.",
  };
}

function linkedGrantAudits(
  transaction: FoundationStorageTransaction,
  context: LockedGameContext,
  controlAudit: ControlAuditEntry,
  action: ControlAction,
  nowMs: number,
): readonly StoredGrantAuditEntry[] {
  if (context.actor.sessionId === null) return [];
  for (const grant of transaction.listGrants()) {
    const session = transaction
      .listGrantSessions(grant.grantId)
      .find((candidate) => candidate.sessionId === context.actor.sessionId);
    if (session === undefined) continue;
    const auditId = `grant-audit-${sha256(`${grant.grantId}:${action.operationId}:event-game`)}`;
    const contentFingerprint = controlAudit.links?.contentFingerprint;
    const acceptanceId = controlAudit.links?.acceptanceId;
    if (contentFingerprint === undefined || acceptanceId === undefined) return [];
    const actorReference = `actor-${sha256(`${grant.grantId}:${session.sessionId}`).slice(0, 32)}`;
    controlAudit.links ??= {
      actionId: null,
      targetFactId: null,
      causalPredecessorIds: [],
      relatedOperationIds: [],
      ordering: null,
    };
    controlAudit.links.grantAuditId = auditId;
    return [
      {
        auditId,
        action: "control-action-accepted",
        outcome: "accepted",
        actorReference,
        grantId: grant.grantId,
        grantType: grant.grantType,
        grantVersion: grant.grantVersion,
        scope: structuredClone(grant.scope),
        sessionId: session.sessionId,
        replacedSessionId: null,
        eventGameId: context.root.eventGameId,
        previousEventGameId: null,
        replayEvidenceId: null,
        credentialKind: GRANT_CREDENTIAL_KIND,
        credentialFingerprint: null,
        beforeStatus: grant.status,
        afterStatus: grant.status,
        beforeExpiresAtMs: grant.expiresAtMs,
        afterExpiresAtMs: grant.expiresAtMs,
        terminalReason: null,
        acceptanceId,
        controlAuditId: controlAudit.auditId,
        controlActionId: actionIdentity(action.recordId, action.operationId),
        contentFingerprint,
        outcomeDetail: canonicalizeJson({
          status: "accepted",
          reason: null,
          detail: ACCEPTED_AUDIT_DETAIL,
        }),
        createdAtMs: nowMs,
      },
    ];
  }
  return [];
}

function createEventAuditWriter(
  action: "locked-game-corrected" | "game-reopened",
  eventId: string,
  operationId: string,
  root: EventGameRecordRoot,
  actorReference: string,
  occurredAtMs: number,
) {
  const auditId = eventAuditIdFor(eventId, operationId, action);
  const writer = (controlAuditId: string): EventCatalogAuditEntry => {
    return {
      auditId,
      operationId,
      action,
      eventId,
      gameDayId: root.externalScope.gameDayId,
      actorReference,
      occurredAtMs,
      before: {
        eventGameId: root.eventGameId,
        controlAuditId,
        valueReference: "control-audit",
      },
      after: {
        eventGameId: root.eventGameId,
        controlAuditId,
        valueReference: "control-audit",
      },
    };
  };
  return Object.assign(writer, { id: auditId });
}

function eventAuditIdFor(
  eventId: string,
  operationId: string,
  action: "locked-game-corrected" | "game-reopened",
): string {
  return `event-audit-${sha256(`${eventId}:${operationId}:${action}`)}`;
}

function mapRecordOutcome(
  outcome: ControlActionAcceptanceOutcome,
): EventAdministrationOutcome<never> {
  if (outcome.status !== "rejected") return unavailable();
  if (outcome.detail === "event-admin-unauthorized") return unauthorized();
  if (outcome.detail === "event-game-not-locked") return inUse("Event Game is not locked.");
  if (outcome.reason === "operation-conflict") return conflict();
  if (outcome.reason === "storage-not-ready") return unavailable();
  return invalid(outcome.detail);
}

function createAdminFactAction(
  root: EventGameRecordRoot,
  operationId: string,
  nowMs: number,
  actor: AuthorizedActor,
  factType: "locked-game-correction" | "game-reopening",
  data: Record<string, unknown>,
  overrideApplied: boolean,
  before?: LockedGameEndState,
  after?: LockedGameEndState,
): ControlActionInput {
  return {
    recordId: root.recordId,
    eventGameId: root.eventGameId,
    operationId,
    kind: { id: "game-fact", version: "1" },
    payload: {
      factId: `${operationId}-fact`,
      factType,
      gameSideId: null,
      gameTimeMs: after?.endTimeMs ?? before?.endTimeMs ?? 0,
      data,
    },
    causalPredecessorIds: [],
    occurrence: { trustedAtMs: nowMs, clientOriginAtMs: null, source: "online" },
    grant:
      actor.sessionId === null
        ? null
        : {
            sessionId: actor.sessionId,
            versionId: actor.grantVersion ?? "event-admin-current",
            authorityReference: actor.actorReference,
          },
    origin: "event-admin",
    lifecycle: root.lifecycle,
    ...(overrideApplied && before !== undefined && after !== undefined
      ? {
          override: {
            guardrail: "locked-game-end-state-consistency",
            direction: "event-admin-directed-reconciliation",
            confirmation: "event-admin-confirmed",
            authorityReference: actor.actorReference,
            gameTimeMs: after.endTimeMs ?? root.lifecycle.finishedAtMs ?? nowMs,
            beforeValue: before,
            afterValue: after,
          },
        }
      : {}),
  };
}

function parseEndState(
  value: unknown,
): { ok: true; value: Partial<LockedGameEndState> } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "Locked Game end state must be an object." };
  const result: Partial<LockedGameEndState> = {};
  if (value.scoreByGameSide !== undefined) {
    if (!isRecord(value.scoreByGameSide)) return { ok: false, error: "Scores must be an object." };
    const scores: Record<string, number> = {};
    for (const [sideId, score] of Object.entries(value.scoreByGameSide)) {
      if (!validateOpaqueIdentifier(sideId, "scoreByGameSide side").ok || !isSafeScore(score))
        return { ok: false, error: "Scores are invalid." };
      scores[sideId] = score;
    }
    result.scoreByGameSide = scores;
  }
  const winner = nullableId(value.winnerGameSideId, "winnerGameSideId");
  const catcher = nullableId(value.flagCatchingGameSideId, "flagCatchingGameSideId");
  const catchTime = nullableTime(value.catchTimeMs, "catchTimeMs");
  const endTime = nullableTime(value.endTimeMs, "endTimeMs");
  if (!winner.ok) return winner;
  if (!catcher.ok) return catcher;
  if (!catchTime.ok) return catchTime;
  if (!endTime.ok) return endTime;
  if (winner.present) result.winnerGameSideId = winner.value;
  if (catcher.present) result.flagCatchingGameSideId = catcher.value;
  if (catchTime.present) result.catchTimeMs = catchTime.value;
  if (endTime.present) result.endTimeMs = endTime.value;
  return Object.keys(result).length === 0
    ? { ok: false, error: "End state must change a value." }
    : { ok: true, value: result };
}

function projectEndState(
  root: EventGameRecordRoot,
  actions: readonly StoredControlAction[],
): LockedGameEndState {
  const derived = projectLiveEventGameDerivedState(root, actions);
  const latest = actions
    .map(lockedCorrectionData)
    .filter((value): value is LockedGameEndState => value !== null)
    .at(-1);
  return (
    latest ?? {
      scoreByGameSide:
        derived?.scoreByGameSide ?? Object.fromEntries(root.gameSides.map((side) => [side.id, 0])),
      winnerGameSideId: derived?.winnerGameSideId ?? null,
      flagCatchingGameSideId: derived?.catch?.catchingGameSideId ?? null,
      catchTimeMs: derived?.catch?.gameTimeMs ?? null,
      endTimeMs: root.lifecycle.finishedAtMs,
    }
  );
}
function sameEndState(left: LockedGameEndState, right: LockedGameEndState): boolean {
  const leftScores = Object.entries(left.scoreByGameSide);
  const rightScores = Object.entries(right.scoreByGameSide);
  return (
    left.winnerGameSideId === right.winnerGameSideId &&
    left.flagCatchingGameSideId === right.flagCatchingGameSideId &&
    left.catchTimeMs === right.catchTimeMs &&
    left.endTimeMs === right.endTimeMs &&
    leftScores.length === rightScores.length &&
    leftScores.every(([sideId, score]) => right.scoreByGameSide[sideId] === score)
  );
}
function mergeEndState(
  before: LockedGameEndState,
  patch: Partial<LockedGameEndState>,
): LockedGameEndState {
  return {
    scoreByGameSide:
      patch.scoreByGameSide !== undefined
        ? { ...before.scoreByGameSide, ...patch.scoreByGameSide }
        : before.scoreByGameSide,
    winnerGameSideId:
      patch.winnerGameSideId !== undefined ? patch.winnerGameSideId : before.winnerGameSideId,
    flagCatchingGameSideId:
      patch.flagCatchingGameSideId !== undefined
        ? patch.flagCatchingGameSideId
        : before.flagCatchingGameSideId,
    catchTimeMs: patch.catchTimeMs !== undefined ? patch.catchTimeMs : before.catchTimeMs,
    endTimeMs: patch.endTimeMs !== undefined ? patch.endTimeMs : before.endTimeMs,
  };
}
function lockedCorrectionData(stored: StoredControlAction): LockedGameEndState | null {
  const interpretation = stored.action.interpretation;
  if (interpretation.type !== "fact" || interpretation.factType !== "locked-game-correction")
    return null;
  const payload = interpretation.payload;
  if (!isRecord(payload) || Array.isArray(payload)) return null;
  const data = payload.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const correction = (data as { correction?: unknown }).correction;
  if (!isRecord(correction)) return null;
  const parsed = parseEndState(correction);
  return parsed.ok &&
    parsed.value.scoreByGameSide !== undefined &&
    parsed.value.winnerGameSideId !== undefined &&
    parsed.value.flagCatchingGameSideId !== undefined &&
    parsed.value.catchTimeMs !== undefined &&
    parsed.value.endTimeMs !== undefined
    ? (parsed.value as LockedGameEndState)
    : null;
}
function parseIds(eventId: unknown, eventGameId: unknown, operationId: unknown, label: string) {
  const parsedEvent = validateOpaqueIdentifier(eventId, "eventId");
  const parsedGame = validateOpaqueIdentifier(eventGameId, "eventGameId");
  const parsedOperation = validateOpaqueIdentifier(operationId, "operationId");
  return parsedEvent.ok && parsedGame.ok && parsedOperation.ok
    ? {
        ok: true as const,
        eventId: parsedEvent.value,
        eventGameId: parsedGame.value,
        operationId: parsedOperation.value,
      }
    : { ok: false as const, error: `${label} identifiers are invalid.` };
}
function isSafeScore(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= SHARED_LIMITS.score.max
  );
}
function nullableId(
  value: unknown,
  field: string,
): { ok: true; present: boolean; value: string | null } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, present: false, value: null };
  if (value === null) return { ok: true, present: true, value: null };
  const parsed = validateOpaqueIdentifier(value, field);
  return parsed.ok ? { ok: true, present: true, value: parsed.value } : parsed;
}
function nullableTime(
  value: unknown,
  field: string,
): { ok: true; present: boolean; value: number | null } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, present: false, value: null };
  if (value === null) return { ok: true, present: true, value: null };
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return { ok: false, error: `${field} is invalid.` };
  return { ok: true, present: true, value };
}
function readNow(clock: () => number): number | null {
  const value = clock();
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function accepted<T>(value: T): EventAdministrationOutcome<T> {
  return { status: "accepted", value };
}
function invalid(detail: string): EventAdministrationOutcome<never> {
  return { status: "rejected", reason: "invalid-input", detail };
}
function unauthorized(): EventAdministrationOutcome<never> {
  return {
    status: "rejected",
    reason: "unauthorized",
    detail: "Unable to authorize Event administration.",
  };
}
function notFound(): EventAdministrationOutcome<never> {
  return { status: "rejected", reason: "not-found", detail: "Event Game was not found." };
}
function inUse(detail: string): EventAdministrationOutcome<never> {
  return { status: "rejected", reason: "in-use", detail };
}
function conflict(): EventAdministrationOutcome<never> {
  return invalid("Operation identity conflicts with committed content.");
}
function unavailable(): EventAdministrationOutcome<never> {
  return {
    status: "retryable-failure",
    detail: "Locked Event Game administration is unavailable.",
  };
}
