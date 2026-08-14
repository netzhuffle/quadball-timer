import type {
  ControlAction,
  ControlActionCodec,
  ControlActionCodecRegistry,
  ControlActionInput,
  ControlAuditEntry,
  ControlActionEnvelope,
  PreparedControlAction,
} from "@/lib/event-game-actions";
import {
  CONTROL_ACTION_ORDERING_VERSION,
  actionIdentity,
  canonicalizeJson,
  controlActionCodecIdentity,
  createControlActionCodecRegistry,
  materializeControlAction,
  prepareControlAction,
  sha256,
  validateControlActionEnvelope,
} from "@/lib/event-game-actions";
import { appendConcurrentCorrectionAudits } from "@/lib/event-game-record";
import {
  ACCEPTED_AUDIT_DETAIL,
  createAuditEntry as createControlAudit,
  findFactById,
  validateDependencies,
} from "@/lib/event-game-record-helpers";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import type {
  FoundationStorage,
  FoundationStorageSnapshot,
  FoundationStorageTransaction,
  StoredAcceptanceBudget,
  StoredReplayAttempt,
  StoredReplayReservation,
} from "@/lib/foundation-storage";
import { authorizeGrantInTransaction } from "@/lib/grant-management-sessions";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import { auditInput } from "@/lib/grant-management-audit";
import { createAuditEntry as createGrantAudit } from "@/lib/grant-lifecycle";
import { GENERIC_GRANT_AUTHORIZATION_FAILURE } from "@/lib/grant-authority-types";
import type { StoredGrant, StoredGrantSession } from "@/lib/grant-types";
import { computeLookupDigest } from "@/lib/grant-crypto";
import { validateOpaqueIdentifier } from "@/lib/validation-policy";
import {
  acceptanceAuditPairFailure,
  anchorFor,
  replayAttemptResultFailure,
} from "@/lib/foundation-acceptance-integrity";
import {
  normalizeFoundationRejectionReason,
  type FoundationRejectionReason,
} from "@/lib/foundation-acceptance-contract";

export const ACCEPTANCE_LIMITS = Object.freeze({
  maxBatchActions: 100,
  maxBatchBytes: 64 * 1024,
  onlineSessionCapacity: 40,
  onlineSessionRefillPerSecond: 20,
  onlineEventCapacity: 100,
  onlineEventRefillPerSecond: 50,
  replaySessionCapacity: 40,
  replaySessionRefillPerSecond: 20,
});

export type AcceptanceLimits = Partial<Record<keyof typeof ACCEPTANCE_LIMITS, number>>;

export type ControlActionBatchInput = {
  recordId: string;
  eventGameId: string;
  actions: readonly unknown[];
  sessionBearer?: string;
  mode?: "online" | "replay";
  replay?: {
    sessionBearer: string;
    originatingSessionId: string;
    replayEvidenceId: string;
  };
};

export type FoundationActionResult =
  | {
      status: "accepted" | "duplicate-accepted";
      action?: ControlAction;
      auditId: string;
      grantAuditId: string;
    }
  | {
      status: "rejected" | "dependency-blocked" | "authority-expired" | "retry-later";
      reason: FoundationRejectionReason;
      detail: string;
      auditId?: string;
      grantAuditId?: string;
    }
  | { status: "locked-discarded"; count: number; eventGameId: string; rejectedAtMs: number };

export type FoundationBatchOutcome = {
  status: "committed" | "partial" | "rejected";
  results: readonly FoundationActionResult[];
  receipt?: string;
  reservationId?: string;
};

export type FoundationAcceptanceOptions = {
  grant: GrantAuthorityOptions;
  externalScopeResolver: {
    resolve(
      scope: EventGameRecordRoot["externalScope"],
      snapshot: FoundationStorageSnapshot,
    ):
      | { status: "resolved"; scope: EventGameRecordRoot["externalScope"] }
      | { status: "missing" | "mismatch"; detail: string };
    resolveEventTeam(
      eventId: string,
      eventTeamId: string,
      snapshot: FoundationStorageSnapshot,
    ): { status: "resolved" } | { status: "missing" | "mismatch"; detail: string };
  };
  clock?: () => number;
  actionCodecs?: readonly ControlActionCodec[];
  actionCodecRegistry?: ControlActionCodecRegistry;
  interpreter: import("@/lib/event-game-actions").IqaGameRulesInterpreter;
  verifyLockedReplay?: (input: {
    eventGameId: string;
    originatingSessionId: string;
    evidence: unknown;
    actionCount: number;
    batchDigest: string;
  }) => boolean;
  replayEligibility?: (input: {
    transaction: FoundationStorageSnapshot;
    root: EventGameRecordRoot;
    action: PreparedControlAction;
    originatingSessionId: string;
    replayEvidenceId: string;
  }) => { status: "eligible" } | { status: "ineligible"; reason?: unknown; detail?: unknown };
  failureInjector?: (
    boundary:
      | "after-action"
      | "after-metadata"
      | "after-control-audit"
      | "after-grant-audit"
      | "before-receipt",
  ) => void;
  /** Test-only barrier between read-only preflight and the first write transaction. */
  afterReadOnlyPreflight?: () => void | Promise<void>;
  limits?: AcceptanceLimits;
};

const GENERIC_REPLAY_INELIGIBILITY_DETAIL = "Replay authorization is unavailable.";

type StructuralAction = { raw: unknown; envelope: ControlActionEnvelope };
type PreparedBatch = {
  input: ControlActionBatchInput;
  actions: readonly StructuralAction[];
  order: readonly number[];
  size: number;
  digest: string;
};
type BatchPreflight = {
  authorized: boolean;
  root: EventGameRecordRoot | null;
  trustedLockedReplay: boolean;
  actions: readonly { prepared: PreparedControlAction | null; error: string | null }[];
};
type OneOutcome = { result: FoundationActionResult; reservationId?: string; receipt?: string };
type AuthorizedControl = {
  grant: StoredGrant;
  session: StoredGrantSession;
  grantId: string;
  grantVersion: string;
  grantSessionId: string;
};

export type FoundationAcceptance = {
  submitBatch(input: unknown): Promise<FoundationBatchOutcome>;
  acknowledgeReplay(receipt: unknown): Promise<{ status: "acknowledged" | "rejected" }>;
};

export function createFoundationAcceptance(
  storage: FoundationStorage,
  options: FoundationAcceptanceOptions,
): FoundationAcceptance {
  const clock = options.clock ?? (() => Date.now());
  const registry =
    options.actionCodecRegistry ?? createControlActionCodecRegistry(options.actionCodecs);
  storage.setReadinessContext?.({
    actionCodecRegistry: registry,
    interpreter: options.interpreter,
  });
  const limits = { ...ACCEPTANCE_LIMITS, ...options.limits };
  storage.setGrantValidationContext?.({
    environmentId: options.grant.environmentId,
    keyRing: options.grant.keyRing,
  });

  async function submitBatch(raw: unknown): Promise<FoundationBatchOutcome> {
    const batch = structurallyValidateBatch(raw);
    if (batch === null) return { status: "rejected", results: [] };
    let preflight: BatchPreflight;
    try {
      preflight = await storage.transaction((transaction) => preflightBatch(transaction, batch));
    } catch {
      return {
        status: "partial",
        results: batch.actions.map(() => ({
          status: "retry-later",
          reason: "storage-unavailable",
          detail: "Retry this action after authoritative storage recovers.",
        })),
      };
    }
    // Authorization failure is intentionally indistinguishable from an
    // unavailable/unknown batch. In particular, do not disclose root, scope,
    // lock, codec, payload, or reservation state to an unauthorised bearer.
    if (!preflight.authorized)
      return {
        status: "rejected",
        results: batch.actions.map(() => authorityFailure().result),
      };
    await options.afterReadOnlyPreflight?.();
    // An authorized batch whose root is absent or belongs to another Event
    // Game is a read-only structural outcome. Do not enter an accepting
    // transaction: the normal authorization path refreshes session activity,
    // which would make an unavailable root observable as a lifecycle write.
    if (preflight.root === null || preflight.root.eventGameId !== batch.input.eventGameId)
      return {
        status: "committed",
        results: batch.actions.map(() => ({
          status: "rejected",
          reason: "record-not-found",
          detail: "The Event Game Record is unavailable.",
        })),
      };
    const results: FoundationActionResult[] = Array.from({ length: batch.actions.length });
    let reservationId: string | undefined;
    let receipt: string | undefined;
    for (const index of batch.order) {
      const action = batch.actions[index];
      if (action === undefined) continue;
      const predecessors = predecessorResultsFor(batch, results, index);
      let one: OneOutcome;
      try {
        one = await storage.transaction((transaction) =>
          acceptOne(transaction, batch, index, predecessors, preflight.actions[index]),
        );
      } catch {
        one = {
          result: {
            status: "retry-later",
            reason: "storage-unavailable",
            detail: "Retry this action after authoritative storage recovers.",
          },
        };
      }
      results[index] = one.result;
      reservationId ??= one.reservationId;
      receipt ??= one.receipt;
    }
    const hasRetry = results.some((result) => result?.status === "retry-later");
    if (batch.input.mode === "replay" && receipt !== undefined)
      return { status: "committed", results, receipt, reservationId };
    return {
      status:
        results.every((result) => result !== undefined) && !hasRetry ? "committed" : "partial",
      results,
      ...(reservationId === undefined ? {} : { reservationId }),
    };
  }

  async function acknowledgeReplay(
    rawReceipt: unknown,
  ): Promise<{ status: "acknowledged" | "rejected" }> {
    if (typeof rawReceipt !== "string" || rawReceipt.length < 32) return { status: "rejected" };
    try {
      await storage.transaction((transaction) => {
        const stored = transaction.findReplayReceiptByDigest(sha256(rawReceipt));
        if (stored === null) throw new Error("Receipt unavailable.");
        const reservation = transaction.findReplayReservation(stored.reservationId);
        if (
          reservation === null ||
          (reservation.status !== "committed" && reservation.status !== "acknowledged")
        )
          throw new Error("Receipt reservation is not committed.");
        if (stored.status === "acknowledged") return;
        const acknowledgedAtMs = readNow(clock);
        const acknowledgedReceipt = {
          ...stored,
          status: "acknowledged" as const,
          acknowledgedAtMs,
          stateRevision: stored.stateRevision + 1,
        };
        transaction.updateReplayReceipt(acknowledgedReceipt);
        transaction.insertAcceptanceIntegrityAnchor(
          anchorFor("receipt", acknowledgedReceipt, options.grant.keyRing),
        );
        const acknowledgedReservation = {
          ...reservation,
          status: "acknowledged" as const,
          acknowledgedAtMs,
          stateRevision: reservation.stateRevision + 1,
        };
        transaction.updateReplayReservation(acknowledgedReservation);
        transaction.insertAcceptanceIntegrityAnchor(
          anchorFor("reservation", acknowledgedReservation, options.grant.keyRing),
        );
      });
      return { status: "acknowledged" };
    } catch {
      return { status: "rejected" };
    }
  }

  return { submitBatch, acknowledgeReplay };

  function preflightBatch(
    transaction: FoundationStorageTransaction,
    batch: PreparedBatch,
  ): BatchPreflight {
    const first = batch.actions[0];
    if (first === undefined)
      return { authorized: false, root: null, trustedLockedReplay: false, actions: [] };
    const replay = batch.input.replay;
    const trustedLockedReplay = replay !== undefined && verifyTrustedLockedReplay(batch);
    if (trustedLockedReplay) {
      const root = transaction.findRootByRecordId(batch.input.recordId);
      if (
        root === null ||
        root.eventGameId !== batch.input.eventGameId ||
        root.lifecycle.lockedAtMs === null
      )
        return { authorized: false, root: null, trustedLockedReplay: false, actions: [] };
      return {
        authorized: true,
        root,
        trustedLockedReplay: true,
        // Locked discard validates codec/envelope/payload evidence but does
        // not execute root-dependent sporting semantics.
        actions: prepareBatchActions(batch, null),
      };
    }
    const bearer = replay?.sessionBearer ?? batch.input.sessionBearer;
    if (typeof bearer !== "string")
      return { authorized: false, root: null, trustedLockedReplay: false, actions: [] };
    const authorization = authorizeGrantInTransaction(transaction, options.grant, {
      sessionBearer: bearer,
      eventGameId: batch.input.eventGameId,
      controlSessionDecision: "stay",
      readOnly: true,
    });
    if (
      authorization === GENERIC_GRANT_AUTHORIZATION_FAILURE ||
      authorization.status !== "authorized" ||
      authorization.grantType !== "control" ||
      authorization.eventGameId !== batch.input.eventGameId ||
      authorization.grantSessionId !== first.envelope.grant.sessionId ||
      authorization.grantVersion !== first.envelope.grant.versionId
    )
      return { authorized: false, root: null, trustedLockedReplay: false, actions: [] };
    if (
      batch.actions.some(
        ({ envelope }) =>
          envelope.grant.sessionId !== authorization.grantSessionId ||
          envelope.grant.versionId !== authorization.grantVersion,
      )
    )
      return { authorized: false, root: null, trustedLockedReplay: false, actions: [] };
    const root = transaction.findRootByRecordId(batch.input.recordId);
    if (root === null || root.eventGameId !== batch.input.eventGameId)
      return {
        authorized: true,
        root: null,
        trustedLockedReplay: false,
        actions: prepareBatchActions(batch, null),
      };
    return {
      authorized: true,
      root,
      trustedLockedReplay: false,
      actions: prepareBatchActions(batch, root),
    };
  }

  function prepareBatchActions(
    batch: PreparedBatch,
    root: EventGameRecordRoot | null,
  ): readonly { prepared: PreparedControlAction | null; error: string | null }[] {
    return batch.actions.map(({ raw }) => {
      try {
        const prepared = prepareControlAction(raw, root, registry, readNow(clock), {
          allowConcurrentTeamAssignment: true,
        });
        return prepared.ok
          ? { prepared: prepared.value, error: null }
          : { prepared: null, error: prepared.error };
      } catch {
        return { prepared: null, error: "The Control Action is invalid." };
      }
    });
  }

  function verifyTrustedLockedReplay(batch: PreparedBatch): boolean {
    const replay = batch.input.replay;
    if (replay === undefined || options.verifyLockedReplay === undefined) return false;
    try {
      return (
        options.verifyLockedReplay({
          eventGameId: batch.input.eventGameId,
          originatingSessionId: replay.originatingSessionId,
          evidence: replay.replayEvidenceId,
          actionCount: batch.actions.length,
          batchDigest: batch.digest,
        }) === true
      );
    } catch {
      return false;
    }
  }

  function prepareCurrentAction(
    raw: unknown,
    root: EventGameRecordRoot | null,
  ): { prepared: PreparedControlAction | null; error: string | null } {
    try {
      const prepared = prepareControlAction(raw, root, registry, readNow(clock), {
        allowConcurrentTeamAssignment: true,
      });
      return prepared.ok
        ? { prepared: prepared.value, error: null }
        : { prepared: null, error: prepared.error };
    } catch {
      return { prepared: null, error: "The Control Action is invalid." };
    }
  }

  function acceptOne(
    transaction: FoundationStorageTransaction,
    batch: PreparedBatch,
    index: number,
    predecessorResults: readonly FoundationActionResult[],
    preflightAction: { prepared: PreparedControlAction | null; error: string | null } | undefined,
  ): OneOutcome {
    const structural = batch.actions[index];
    if (structural === undefined) throw new Error("Missing structural action.");
    const mode = batch.input.mode ?? (batch.input.replay === undefined ? "online" : "replay");
    const replay = batch.input.replay;
    const bearer = replay?.sessionBearer ?? batch.input.sessionBearer;

    if (replay !== undefined && verifyTrustedLockedReplay(batch)) {
      const root = transaction.findRootByRecordId(batch.input.recordId);
      if (
        root === null ||
        root.eventGameId !== batch.input.eventGameId ||
        root.lifecycle.lockedAtMs === null
      )
        return authorityFailure();
      const currentPreparation = prepareCurrentAction(structural.raw, null);
      if (
        currentPreparation.prepared === null ||
        !samePreparedAction(currentPreparation.prepared, preflightAction?.prepared)
      )
        return one({
          status: "authority-expired",
          reason: "game-locked",
          detail: "The Event Game is locked.",
        });
      const reservation = transaction.findReplayReservationByTuple(
        root.recordId,
        root.eventGameId,
        replay.originatingSessionId,
        batch.actions.length,
        batch.digest,
      );
      if (
        reservation !== null &&
        (reservation.status === "committed" || reservation.status === "acknowledged")
      ) {
        const attempt = transaction
          .listReplayAttempts(reservation.reservationId)
          .find((item) => item.operationId === structural.envelope.operationId);
        if (attempt === undefined) throw new Error("Committed replay evidence is incomplete.");
        return recoverCommittedReplay(transaction, reservation, attempt, options.grant.keyRing);
      }
      const otherReservation =
        reservation === null
          ? transaction.findReplayReservationByOriginTuple(
              root.recordId,
              root.eventGameId,
              replay.originatingSessionId,
              batch.actions.length,
            )
          : null;
      if (
        reservation === null &&
        otherReservation !== null &&
        ["reserved", "partial", "committing", "committed", "acknowledged"].includes(
          otherReservation.status,
        )
      )
        return one({
          status: "authority-expired",
          reason: "replay-reservation-mismatch",
          detail: "The replay batch does not match the live reservation.",
        });
      return discardLockedReplay(
        transaction,
        root,
        batch,
        reservation ?? undefined,
        replay.originatingSessionId,
        readNow(clock),
      );
    }

    // No scope, lock, catalog, codec, or payload inspection may happen before
    // this current bearer/session check.
    if (typeof bearer !== "string") return authorityFailure();
    const authorization = authorizeGrantInTransaction(transaction, options.grant, {
      sessionBearer: bearer,
      eventGameId: batch.input.eventGameId,
      controlSessionDecision: "stay",
      readOnly: true,
    });
    if (
      authorization === GENERIC_GRANT_AUTHORIZATION_FAILURE ||
      authorization.status !== "authorized" ||
      authorization.grantType !== "control" ||
      authorization.eventGameId !== batch.input.eventGameId ||
      authorization.grantSessionId !== structural.envelope.grant.sessionId ||
      authorization.grantVersion !== structural.envelope.grant.versionId
    )
      return authorityFailure();
    const root = transaction.findRootByRecordId(batch.input.recordId);
    if (root === null || root.eventGameId !== batch.input.eventGameId)
      return one({
        status: "rejected",
        reason: "record-not-found",
        detail: "The Event Game Record is unavailable.",
      });
    const reservation =
      mode === "replay" && replay !== undefined
        ? replayReservation(transaction, batch, authorization.grantSessionId)
        : undefined;
    if (reservation?.mismatch === true)
      return one({
        status: "retry-later",
        reason: "replay-session-mismatch",
        detail: "Retry with the Grant Session that owns this replay reservation.",
      });
    const existingReplayReservation = reservation?.value;

    if (root.lifecycle.lockedAtMs !== null) {
      return one({
        status: "authority-expired",
        reason: "game-locked",
        detail: "The Event Game is locked.",
      });
    }
    const scope = options.externalScopeResolver.resolve(root.externalScope, transaction);
    if (
      scope.status !== "resolved" ||
      canonicalizeJson(scope.scope) !== canonicalizeJson(root.externalScope)
    )
      return one({
        status: "retry-later",
        reason: "scope-unavailable",
        detail: "Retry after the Event scope is available.",
      });

    const currentPreparation = prepareCurrentAction(structural.raw, root);
    const prepared = currentPreparation.prepared;
    if (preflightAction !== undefined && !samePreparationResult(prepared, preflightAction.prepared))
      return one({
        status: "retry-later",
        reason: "stale-preflight",
        detail: "The Event Game changed while this action was being accepted.",
      });

    const currentAuthorization = authorizeGrantInTransaction(transaction, options.grant, {
      sessionBearer: bearer,
      eventGameId: batch.input.eventGameId,
      controlSessionDecision: "stay",
    });
    if (
      currentAuthorization === GENERIC_GRANT_AUTHORIZATION_FAILURE ||
      currentAuthorization.status !== "authorized" ||
      currentAuthorization.grantType !== "control" ||
      currentAuthorization.eventGameId !== batch.input.eventGameId ||
      currentAuthorization.grantSessionId !== structural.envelope.grant.sessionId ||
      currentAuthorization.grantVersion !== structural.envelope.grant.versionId
    )
      return authorityFailure();
    const grant = transaction.findGrantById(currentAuthorization.grantId);
    const session =
      grant === null
        ? null
        : (transaction
            .listGrantSessions(grant.grantId)
            .find((candidate) => candidate.sessionId === currentAuthorization.grantSessionId) ??
          null);
    if (grant === null || session === null) return authorityFailure();
    const current: AuthorizedControl = {
      grant,
      session,
      grantId: currentAuthorization.grantId,
      grantVersion: currentAuthorization.grantVersion,
      grantSessionId: currentAuthorization.grantSessionId,
    };
    if (mode === "online" && replay === undefined) {
      const recovered = recoverExistingOutcome(
        transaction,
        root,
        structural,
        prepared,
        current,
        false,
      );
      if (recovered !== null) return recovered;
    }
    let replayEligibility: { status: "eligible" } | { status: "ineligible" } | undefined;
    if (mode === "replay" && replay !== undefined && prepared !== null) {
      try {
        const decision = options.replayEligibility?.({
          transaction,
          root,
          action: prepared,
          originatingSessionId: replay.originatingSessionId,
          replayEvidenceId: replay.replayEvidenceId,
        });
        replayEligibility = decision?.status === "eligible" ? decision : { status: "ineligible" };
      } catch {
        replayEligibility = { status: "ineligible" };
      }
    }

    if (mode === "replay" && replay !== undefined) {
      const exact = recoverReplayAttempt(transaction, existingReplayReservation, structural);
      if (exact !== null) return exact;
      if (existingReplayReservation === undefined) {
        const recovered = recoverExistingOutcome(
          transaction,
          root,
          structural,
          prepared,
          current,
          false,
        );
        if (recovered !== null) return recovered;
      }
    }
    if (prepared === null)
      return writeOutcome(
        transaction,
        root,
        structural.envelope,
        undefined,
        current,
        mode,
        existingReplayReservation,
        "rejected",
        "invalid-action",
        currentPreparation.error ?? "The Control Action is invalid.",
      );
    if (replayEligibility?.status === "ineligible")
      return writeOutcome(
        transaction,
        root,
        prepared.input,
        prepared,
        current,
        mode,
        existingReplayReservation,
        "authority-expired",
        "replay-ineligible",
        GENERIC_REPLAY_INELIGIBILITY_DETAIL,
      );

    const ensured =
      mode === "replay" && replay !== undefined
        ? ensureReservation(transaction, batch, current.grantSessionId, reservation?.value)
        : undefined;
    if (ensured?.mismatch === true)
      return one({
        status: "retry-later",
        reason: "replay-session-mismatch",
        detail: "Retry with the Grant Session that owns this replay reservation.",
      });
    const replayState = ensured?.value;

    const previousAttempt =
      replayState === undefined
        ? undefined
        : transaction
            .listReplayAttempts(replayState.reservationId)
            .find((attempt) => attempt.operationId === structural.envelope.operationId);
    if (previousAttempt !== undefined && previousAttempt.status !== "retry-later") {
      const previousControlAudit = transaction
        .listAuditEntries(root.recordId)
        .find((entry) => entry.auditId === previousAttempt.controlAuditId);
      const result = readAttemptResult(
        previousAttempt,
        transaction.findActionByOperationId(root.recordId, previousAttempt.operationId)?.action,
        previousControlAudit?.links?.reason,
      );
      const receipt =
        replayState === undefined
          ? null
          : transaction.findReplayReceiptByReservationId(replayState.reservationId);
      return {
        result,
        reservationId: replayState?.reservationId,
        ...(receipt !== null
          ? {
              receipt: encodeReceipt(
                replayState!.reservationId,
                options.grant.keyRing,
                receipt.receiptKeyVersion,
              ),
            }
          : {}),
      };
    }

    const sessionBudget = takeBudget(
      transaction,
      mode === "replay" ? "replay-session" : "online-session",
      current.grantSessionId,
      mode === "replay" ? limits.replaySessionCapacity : limits.onlineSessionCapacity,
      mode === "replay" ? limits.replaySessionRefillPerSecond : limits.onlineSessionRefillPerSecond,
      readNow(clock),
      options.grant.keyRing,
    );
    const eventBudget =
      mode === "online"
        ? takeBudget(
            transaction,
            "online-event",
            root.eventGameId,
            limits.onlineEventCapacity,
            limits.onlineEventRefillPerSecond,
            readNow(clock),
            options.grant.keyRing,
          )
        : true;
    if (!sessionBudget || !eventBudget) {
      if (mode === "online" && replay === undefined) {
        const recovered = recoverExistingOutcome(
          transaction,
          root,
          structural,
          prepared,
          current,
          true,
        );
        if (recovered !== null) return recovered;
      }
      return writeOutcome(
        transaction,
        root,
        prepared.input,
        prepared,
        current,
        mode,
        replayState,
        "retry-later",
        "rate-budget",
        "Retry after the acceptance budget resets.",
      );
    }

    if (
      previousAttempt !== undefined &&
      previousAttempt.actionFingerprint !== null &&
      previousAttempt.actionFingerprint !== prepared.contentFingerprint
    )
      throw new Error("Replay attempt fingerprint mismatch.");

    const dependency = dependencyOutcome(predecessorResults);
    if (dependency !== undefined)
      return writeOutcome(
        transaction,
        root,
        prepared.input,
        prepared,
        current,
        mode,
        replayState,
        dependency.status,
        normalizeFoundationRejectionReason(dependency.reason),
        dependency.detail,
      );
    const existing = transaction.findActionByOperationId(root.recordId, prepared.input.operationId);
    if (existing !== null && existing.contentFingerprint === prepared.contentFingerprint)
      return writeDuplicateOutcome(
        transaction,
        root,
        prepared,
        current,
        mode,
        replayState,
        existing.action,
      );
    if (existing !== null)
      return writeOutcome(
        transaction,
        root,
        prepared.input,
        prepared,
        current,
        mode,
        replayState,
        "rejected",
        "operation-conflict",
        "The operation identity is already bound to different content.",
        existing.action,
        existing,
      );
    const validation = validateCurrentAction(transaction, root, prepared, options);
    if (validation !== null)
      return writeOutcome(
        transaction,
        root,
        prepared.input,
        prepared,
        current,
        mode,
        replayState,
        "rejected",
        normalizeFoundationRejectionReason(validation.reason),
        validation.detail,
      );

    const action = materializeControlAction(prepared, readNow(clock));
    transaction.insertAction({
      action,
      canonicalContent: prepared.canonicalContent,
      contentFingerprint: prepared.contentFingerprint,
    });
    options.failureInjector?.("after-action");
    const metadata = transaction.readRecordMetadata(root.recordId);
    transaction.upsertRecordMetadata({
      recordId: root.recordId,
      actionCount: (metadata?.actionCount ?? 0) + 1,
      orderingVersion: CONTROL_ACTION_ORDERING_VERSION,
      lastAcceptedAtMs:
        metadata?.lastAcceptedAtMs === null || metadata?.lastAcceptedAtMs === undefined
          ? action.acceptedAtMs
          : Math.max(metadata.lastAcceptedAtMs, action.acceptedAtMs),
      updatedAtMs: action.acceptedAtMs,
    });
    options.failureInjector?.("after-metadata");
    const controlAudit = createControlAudit(
      prepared.input,
      "action-accepted",
      ACCEPTED_AUDIT_DETAIL,
      action.acceptedAtMs,
      { interpretation: prepared.interpretation, relatedOperationIds: [] },
    );
    return writeAcceptedOutcome(
      transaction,
      root,
      action,
      prepared.contentFingerprint,
      controlAudit,
      current,
      mode,
      replayState,
    );
  }

  function writeAcceptedOutcome(
    transaction: FoundationStorageTransaction,
    root: EventGameRecordRoot,
    action: ControlAction,
    fingerprint: string,
    controlAudit: ControlAuditEntry,
    current: AuthorizedControl,
    mode: "online" | "replay",
    reservation: StoredReplayReservation | undefined,
  ): OneOutcome {
    const acceptanceId = `accept-${sha256(`${root.recordId}:${action.operationId}:${action.grant.sessionId}`)}`;
    const grantAudit = linkedGrantAudit(
      options.grant,
      current.grant,
      current.session,
      acceptanceId,
      controlAudit.auditId,
      actionIdentity(action.recordId, action.operationId),
      "accepted",
      fingerprint,
      action.acceptedAtMs,
      null,
      ACCEPTED_AUDIT_DETAIL,
    );
    controlAudit.links = {
      ...controlAudit.links!,
      acceptanceId,
      grantAuditId: grantAudit.auditId,
      contentFingerprint: fingerprint,
    };
    transaction.appendAuditEntry(controlAudit);
    options.failureInjector?.("after-control-audit");
    transaction.appendGrantAudit(grantAudit);
    options.failureInjector?.("after-grant-audit");
    if (
      action.interpretation.type === "correction" ||
      action.interpretation.type === "team-assignment-correction"
    )
      appendConcurrentCorrectionAudits(transaction, root.recordId, action.acceptedAtMs);
    return finishReplay(
      transaction,
      reservation,
      action.operationId,
      {
        status: "accepted",
        action,
        auditId: controlAudit.auditId,
        grantAuditId: grantAudit.auditId,
      },
      fingerprint,
      controlAudit.auditId,
      grantAudit.auditId,
    );
  }

  function recoverExistingOutcome(
    transaction: FoundationStorageTransaction,
    root: EventGameRecordRoot,
    structural: StructuralAction,
    prepared: PreparedControlAction | null,
    current: AuthorizedControl,
    reuseRateBudget: boolean,
  ): OneOutcome | null {
    const candidate = rejectionCandidate(
      prepared ?? undefined,
      prepared?.input ?? structural.envelope,
      registry,
    );
    const existingAction = transaction.findActionByOperationId(
      root.recordId,
      structural.envelope.operationId,
    );
    const grantAudits = transaction.listGrantAudit(current.grantId);
    for (const control of transaction.listAuditEntries(root.recordId).reverse()) {
      if (
        control.kind !== "action-duplicate" &&
        control.kind !== "action-rejected" &&
        control.kind !== "action-conflict"
      )
        continue;
      if (
        control.operationId !== structural.envelope.operationId ||
        control.links?.grantAuditId === undefined ||
        control.links.grantAuditId === null
      )
        continue;
      const grant = grantAudits.find((entry) => entry.auditId === control.links?.grantAuditId);
      if (grant === undefined) continue;
      const pairFailure = acceptanceAuditPairFailure(control, grant);
      if (pairFailure !== null)
        throw new Error(
          `Existing Control and Grant acceptance evidence is inconsistent: ${pairFailure}`,
        );
      const outcome = parseGrantOutcomeDetail(grant.outcomeDetail);
      if (outcome === null) throw new Error("Existing Grant acceptance outcome is invalid.");
      if (
        outcome.status === "retry-later" &&
        (!reuseRateBudget || control.links.reason !== "rate-budget")
      )
        continue;
      if (outcome.status === "duplicate-accepted") {
        if (
          existingAction === null ||
          control.links.contentFingerprint !== candidate.contentFingerprint
        )
          continue;
        return {
          result: {
            status: "duplicate-accepted",
            action: existingAction.action,
            auditId: control.auditId,
            grantAuditId: grant.auditId,
          },
        };
      }
      if (
        outcome.status !== "rejected" &&
        outcome.status !== "dependency-blocked" &&
        outcome.status !== "authority-expired" &&
        outcome.status !== "retry-later"
      )
        continue;
      if (!sameRejectedCandidate(control.links, candidate)) continue;
      return {
        result: {
          status: outcome.status,
          reason: normalizeFoundationRejectionReason(control.links.reason),
          detail: control.redactedDetail,
          auditId: control.auditId,
          grantAuditId: grant.auditId,
        },
      };
    }
    return null;
  }

  function recoverReplayAttempt(
    transaction: FoundationStorageTransaction,
    reservation: StoredReplayReservation | undefined,
    structural: StructuralAction,
  ): OneOutcome | null {
    if (reservation === undefined) return null;
    const attempt = transaction
      .listReplayAttempts(reservation.reservationId)
      .find((item) => item.operationId === structural.envelope.operationId);
    if (attempt === undefined || attempt.status === "retry-later") return null;
    if (reservation.status === "committed" || reservation.status === "acknowledged")
      return recoverCommittedReplay(transaction, reservation, attempt, options.grant.keyRing);
    const controlAudit = transaction
      .listAuditEntries(reservation.recordId)
      .find((entry) => entry.auditId === attempt.controlAuditId);
    return {
      result: readAttemptResult(
        attempt,
        transaction.findActionByOperationId(reservation.recordId, attempt.operationId)?.action,
        controlAudit?.links?.reason,
      ),
      reservationId: reservation.reservationId,
    };
  }

  function writeDuplicateOutcome(
    transaction: FoundationStorageTransaction,
    root: EventGameRecordRoot,
    prepared: PreparedControlAction,
    current: AuthorizedControl,
    mode: "online" | "replay",
    reservation: StoredReplayReservation | undefined,
    existing: ControlAction,
  ): OneOutcome {
    const nowMs = readNow(clock);
    const controlAudit = createControlAudit(
      prepared.input,
      "action-duplicate",
      "The Control Action was already committed.",
      nowMs,
      { interpretation: existing.interpretation },
    );
    controlAudit.outcome = "accepted";
    const acceptanceId = `accept-${sha256(`${root.recordId}:${prepared.input.operationId}:duplicate`)}`;
    const grantAudit = linkedGrantAudit(
      options.grant,
      current.grant,
      current.session,
      acceptanceId,
      controlAudit.auditId,
      actionIdentity(existing.recordId, existing.operationId),
      "duplicate-accepted",
      prepared.contentFingerprint,
      nowMs,
      null,
      "The Control Action was already committed.",
    );
    controlAudit.links = {
      ...controlAudit.links!,
      acceptanceId,
      grantAuditId: grantAudit.auditId,
      contentFingerprint: prepared.contentFingerprint,
    };
    transaction.appendAuditEntry(controlAudit);
    options.failureInjector?.("after-control-audit");
    transaction.appendGrantAudit(grantAudit);
    options.failureInjector?.("after-grant-audit");
    return finishReplay(
      transaction,
      reservation,
      existing.operationId,
      {
        status: "duplicate-accepted",
        action: existing,
        auditId: controlAudit.auditId,
        grantAuditId: grantAudit.auditId,
      },
      prepared.contentFingerprint,
      controlAudit.auditId,
      grantAudit.auditId,
    );
  }

  function writeOutcome(
    transaction: FoundationStorageTransaction,
    root: EventGameRecordRoot,
    input: ControlActionEnvelope | ControlActionInput,
    prepared: PreparedControlAction | undefined,
    current: AuthorizedControl,
    mode: "online" | "replay",
    reservation: StoredReplayReservation | undefined,
    status: Exclude<
      FoundationActionResult["status"],
      "accepted" | "duplicate-accepted" | "locked-discarded"
    >,
    reason: FoundationRejectionReason,
    detail: string,
    duplicateAction?: ControlAction,
    collision?: { contentFingerprint?: string },
  ): OneOutcome {
    const nowMs = readNow(clock);
    const controlInput = prepared?.input ?? input;
    const candidate = rejectionCandidate(prepared, controlInput, registry);
    const controlAudit = createControlAudit(
      controlInput,
      reason === "operation-conflict" ? "action-conflict" : "action-rejected",
      detail,
      nowMs,
      duplicateAction === undefined
        ? { interpretation: prepared?.interpretation }
        : {
            interpretation: prepared?.interpretation,
            collision: {
              acceptedAction: duplicateAction,
              acceptedContentFingerprint: collision?.contentFingerprint ?? "",
              rejectedAttempt: prepared!,
            },
          },
    );
    const acceptanceId = `accept-${sha256(`${root.recordId}:${controlInput.operationId}:${reason}`)}`;
    const grantAudit = linkedGrantAudit(
      options.grant,
      current.grant,
      current.session,
      acceptanceId,
      controlAudit.auditId,
      actionIdentity(controlInput.recordId, controlInput.operationId),
      status === "retry-later" ? "retry-later" : status,
      candidate.contentFingerprint,
      nowMs,
      reason,
      detail,
    );
    controlAudit.links = {
      ...controlAudit.links!,
      acceptanceId,
      grantAuditId: grantAudit.auditId,
      contentFingerprint: candidate.contentFingerprint,
      reason,
      rejectedCandidate: candidate,
    };
    transaction.appendAuditEntry(controlAudit);
    options.failureInjector?.("after-control-audit");
    transaction.appendGrantAudit(grantAudit);
    options.failureInjector?.("after-grant-audit");
    return finishReplay(
      transaction,
      reservation,
      controlInput.operationId,
      { status, reason, detail, auditId: controlAudit.auditId, grantAuditId: grantAudit.auditId },
      candidate.contentFingerprint,
      controlAudit.auditId,
      grantAudit.auditId,
    );
  }

  function finishReplay(
    transaction: FoundationStorageTransaction,
    reservation: StoredReplayReservation | undefined,
    operationId: string,
    result: FoundationActionResult,
    fingerprint: string | null,
    controlAuditId: string,
    grantAuditId: string,
  ): OneOutcome {
    if (reservation === undefined) return { result };
    const existing = transaction
      .listReplayAttempts(reservation.reservationId)
      .find((attempt) => attempt.operationId === operationId);
    const status: StoredReplayAttempt["status"] =
      result.status === "accepted" || result.status === "duplicate-accepted"
        ? result.status
        : result.status === "retry-later"
          ? "retry-later"
          : "rejected";
    const attempt: StoredReplayAttempt = {
      attemptId:
        existing?.attemptId ?? `attempt-${sha256(`${reservation.reservationId}:${operationId}`)}`,
      reservationId: reservation.reservationId,
      operationId,
      status,
      actionFingerprint: fingerprint,
      resultJson: canonicalizeJson(result),
      controlAuditId,
      grantAuditId,
      createdAtMs: existing?.createdAtMs ?? readNow(clock),
      completedAtMs: status === "retry-later" ? null : readNow(clock),
      stateRevision: (existing?.stateRevision ?? 0) + 1,
    };
    if (existing === undefined) transaction.insertReplayAttempt(attempt);
    else transaction.updateReplayAttempt(attempt);
    transaction.insertAcceptanceIntegrityAnchor(
      anchorFor("attempt", attempt, options.grant.keyRing),
    );
    if (status === "retry-later") {
      const partial = {
        ...reservation,
        status: "partial" as const,
        stateRevision: reservation.stateRevision + 1,
      };
      transaction.updateReplayReservation(partial);
      transaction.insertAcceptanceIntegrityAnchor(
        anchorFor("reservation", partial, options.grant.keyRing),
      );
      return { result, reservationId: reservation.reservationId };
    }
    const attempts = transaction.listReplayAttempts(reservation.reservationId);
    if (
      attempts.length !== reservation.actionCount ||
      attempts.some((item) => item.status === "retry-later")
    ) {
      const partial = {
        ...reservation,
        status: "partial" as const,
        stateRevision: reservation.stateRevision + 1,
      };
      transaction.updateReplayReservation(partial);
      transaction.insertAcceptanceIntegrityAnchor(
        anchorFor("reservation", partial, options.grant.keyRing),
      );
      return { result, reservationId: reservation.reservationId };
    }
    options.failureInjector?.("before-receipt");
    const committed = {
      ...reservation,
      status: "committed" as const,
      committedAtMs: readNow(clock),
      stateRevision: reservation.stateRevision + 1,
    };
    transaction.updateReplayReservation(committed);
    transaction.insertAcceptanceIntegrityAnchor(
      anchorFor("reservation", committed, options.grant.keyRing),
    );
    const existingReceipt = transaction.findReplayReceiptByReservationId(reservation.reservationId);
    const receiptKeyVersion =
      existingReceipt?.receiptKeyVersion ?? options.grant.keyRing.lookup.currentVersion;
    const receipt = encodeReceipt(
      reservation.reservationId,
      options.grant.keyRing,
      receiptKeyVersion,
    );
    if (existingReceipt === null) {
      const storedReceipt = {
        receiptId: `receipt-${sha256(reservation.reservationId)}`,
        reservationId: reservation.reservationId,
        receiptDigest: sha256(receipt),
        receiptKeyVersion,
        status: "committed" as const,
        actionCount: reservation.actionCount,
        createdAtMs: readNow(clock),
        acknowledgedAtMs: null,
        stateRevision: 1,
      };
      transaction.insertReplayReceipt(storedReceipt);
      transaction.insertAcceptanceIntegrityAnchor(
        anchorFor("receipt", storedReceipt, options.grant.keyRing),
      );
    }
    return { result, reservationId: reservation.reservationId, receipt };
  }

  function discardLockedReplay(
    transaction: FoundationStorageTransaction,
    root: EventGameRecordRoot,
    batch: PreparedBatch,
    reservation: StoredReplayReservation | undefined,
    originatingSessionId: string,
    rejectedAtMs: number,
  ): OneOutcome {
    if (reservation === undefined) {
      const existingAudit = transaction.listAuditEntries(root.recordId).find((entry) => {
        const locked = entry.lockedReplay;
        return (
          locked?.count === batch.actions.length &&
          locked.originatingSessionId === originatingSessionId &&
          locked.eventGameId === root.eventGameId
        );
      });
      if (existingAudit?.lockedReplay !== undefined)
        return {
          result: {
            status: "locked-discarded",
            count: existingAudit.lockedReplay.count,
            eventGameId: existingAudit.lockedReplay.eventGameId,
            rejectedAtMs: existingAudit.lockedReplay.rejectedAtMs,
          },
        };
    }
    if (reservation === undefined || !["reserved", "partial"].includes(reservation.status))
      return one({
        status: "authority-expired",
        reason: "game-locked",
        detail: "The Event Game is locked.",
      });
    transaction.appendAuditEntry({
      auditVersion: "control-audit-v1",
      auditId: `audit-${sha256(`${root.recordId}:locked-replay:${originatingSessionId}:${rejectedAtMs}:${batch.actions.length}`)}`,
      recordId: root.recordId,
      eventGameId: root.eventGameId,
      operationId: null,
      kind: "action-rejected",
      outcome: "rejected",
      createdAtMs: rejectedAtMs,
      redactedDetail: "Offline replay was discarded after the Event Game locked.",
      links: {
        actionId: null,
        targetFactId: null,
        causalPredecessorIds: [],
        relatedOperationIds: [],
        ordering: null,
      },
      provenance: {
        occurrence: null,
        grant: null,
        lifecycle: null,
        override: null,
        recoveryProvenance: null,
      },
      lockedReplay: {
        count: batch.actions.length,
        originatingSessionId,
        eventGameId: root.eventGameId,
        rejectedAtMs,
      },
    });
    // The trusted lock path erases the replay slot after recording only the
    // redacted tuple above. In particular, no reservation identity or
    // historical timestamp survives as discard evidence.
    transaction.discardReplayReservation(reservation.reservationId);
    return {
      result: {
        status: "locked-discarded",
        count: reservation?.actionCount ?? batch.actions.length,
        eventGameId: root.eventGameId,
        rejectedAtMs,
      },
    };
  }

  function structurallyValidateBatch(raw: unknown): PreparedBatch | null {
    if (
      !isRecord(raw) ||
      !Array.isArray(raw.actions) ||
      raw.actions.length === 0 ||
      raw.actions.length > limits.maxBatchActions
    )
      return null;
    const recordId = typeof raw.recordId === "string" ? raw.recordId : "";
    const eventGameId = typeof raw.eventGameId === "string" ? raw.eventGameId : "";
    if (
      !validateOpaqueIdentifier(recordId, "recordId").ok ||
      !validateOpaqueIdentifier(eventGameId, "eventGameId").ok
    )
      return null;
    const mode = raw.mode === "replay" ? "replay" : raw.mode === "online" ? "online" : undefined;
    const replay =
      isRecord(raw.replay) &&
      typeof raw.replay.sessionBearer === "string" &&
      typeof raw.replay.originatingSessionId === "string" &&
      typeof raw.replay.replayEvidenceId === "string"
        ? {
            sessionBearer: raw.replay.sessionBearer,
            originatingSessionId: raw.replay.originatingSessionId,
            replayEvidenceId: raw.replay.replayEvidenceId,
          }
        : undefined;
    if ((mode === "online" && replay !== undefined) || (mode === "replay" && replay === undefined))
      return null;
    const effectiveMode = mode ?? (replay === undefined ? "online" : "replay");
    let size: number;
    try {
      size = Buffer.byteLength(JSON.stringify(raw), "utf8");
    } catch {
      return null;
    }
    if (size > limits.maxBatchBytes) return null;
    const actions: StructuralAction[] = [];
    const operationIds = new Set<string>();
    let grantEnvelope: string | undefined;
    let lifecycleEnvelope: string | undefined;
    for (const value of raw.actions) {
      const envelope = validateControlActionEnvelope(value, readNow(clock));
      if (
        !envelope.ok ||
        envelope.value.recordId !== recordId ||
        envelope.value.eventGameId !== eventGameId ||
        operationIds.has(envelope.value.operationId)
      )
        return null;
      const grant = canonicalizeJson(envelope.value.grant);
      const lifecycle = canonicalizeJson(envelope.value.lifecycle);
      if (
        (grantEnvelope !== undefined && grantEnvelope !== grant) ||
        (lifecycleEnvelope !== undefined && lifecycleEnvelope !== lifecycle)
      )
        return null;
      grantEnvelope ??= grant;
      lifecycleEnvelope ??= lifecycle;
      if (
        envelope.value.recoveryProvenance !== undefined &&
        (envelope.value.recoveryProvenance.sourceRecordId !== recordId ||
          envelope.value.recoveryProvenance.sourceEventGameId !== eventGameId ||
          envelope.value.recoveryProvenance.sourceOperationId !== envelope.value.operationId)
      )
        return null;
      operationIds.add(envelope.value.operationId);
      actions.push({ raw: structuredClone(value), envelope: envelope.value });
    }
    const order = topologicalOrder(
      actions.map((item) => ({
        operationId: item.envelope.operationId,
        predecessors: item.envelope.causalPredecessorIds,
      })),
    );
    if (order === null) return null;
    const normalized = {
      recordId,
      eventGameId,
      mode: effectiveMode,
      replay: replay
        ? {
            originatingSessionId: replay.originatingSessionId,
            replayEvidenceId: replay.replayEvidenceId,
          }
        : null,
      actions: raw.actions,
    };
    return {
      input: {
        recordId,
        eventGameId,
        actions: raw.actions,
        sessionBearer: typeof raw.sessionBearer === "string" ? raw.sessionBearer : undefined,
        mode: effectiveMode,
        replay,
      },
      actions,
      order,
      size,
      digest: sha256(JSON.stringify(normalized)),
    };
  }

  function replayReservation(
    transaction: FoundationStorageTransaction,
    batch: PreparedBatch,
    sessionId: string,
  ): { value?: StoredReplayReservation; mismatch: boolean } {
    const id = reservationIdFor(batch, sessionId);
    const value = transaction.findReplayReservation(id);
    if (value === null) return { mismatch: false };
    return {
      value:
        value.replacementSessionId === sessionId || value.replacementSessionId === null
          ? value
          : undefined,
      mismatch: value.replacementSessionId !== sessionId && value.replacementSessionId !== null,
    };
  }

  function ensureReservation(
    transaction: FoundationStorageTransaction,
    batch: PreparedBatch,
    sessionId: string,
    existing: StoredReplayReservation | undefined,
  ): { value?: StoredReplayReservation; mismatch: boolean } {
    const replay = batch.input.replay;
    if (replay === undefined) return { mismatch: false };
    const id = reservationIdFor(batch, sessionId);
    const value = existing ?? transaction.findReplayReservation(id);
    if (value !== null && value !== undefined) {
      if (
        value.recordId !== batch.input.recordId ||
        value.eventGameId !== batch.input.eventGameId ||
        value.originatingSessionId !== replay.originatingSessionId ||
        value.actionCount !== batch.actions.length ||
        (value.batchDigest !== null && value.batchDigest !== batch.digest) ||
        (value.replacementSessionId !== null && value.replacementSessionId !== sessionId)
      )
        return { mismatch: true };
      if (value.replacementSessionId === null && value.status !== "discarded") {
        const updated = {
          ...value,
          replacementSessionId: sessionId,
          batchDigest: batch.digest,
          stateRevision: value.stateRevision + 1,
        };
        transaction.updateReplayReservation(updated);
        transaction.insertAcceptanceIntegrityAnchor(
          anchorFor("reservation", updated, options.grant.keyRing),
        );
        return { value: updated, mismatch: false };
      }
      return { value, mismatch: false };
    }
    const created: StoredReplayReservation = {
      reservationId: id,
      recordId: batch.input.recordId,
      eventGameId: batch.input.eventGameId,
      originatingSessionId: replay.originatingSessionId,
      replacementSessionId: sessionId,
      actionCount: batch.actions.length,
      status: "reserved",
      batchDigest: batch.digest,
      createdAtMs: readNow(clock),
      committedAtMs: null,
      acknowledgedAtMs: null,
      stateRevision: 1,
    };
    transaction.insertReplayReservation(created);
    transaction.insertAcceptanceIntegrityAnchor(
      anchorFor("reservation", created, options.grant.keyRing),
    );
    return { value: created, mismatch: false };
  }
}

function recoverCommittedReplay(
  transaction: FoundationStorageTransaction,
  reservation: StoredReplayReservation,
  attempt: StoredReplayAttempt,
  keyRing: GrantAuthorityOptions["keyRing"],
): OneOutcome {
  const expectedAction = transaction.findActionByOperationId(
    reservation.recordId,
    attempt.operationId,
  )?.action;
  const controlAudit = transaction
    .listAuditEntries(reservation.recordId)
    .find((entry) => entry.auditId === attempt.controlAuditId);
  const result = readAttemptResult(attempt, expectedAction, controlAudit?.links?.reason);
  const receipt = transaction.findReplayReceiptByReservationId(reservation.reservationId);
  if (receipt === null) throw new Error("Committed replay receipt is missing.");
  return {
    result,
    reservationId: reservation.reservationId,
    receipt: encodeReceipt(reservation.reservationId, keyRing, receipt.receiptKeyVersion),
  };
}

function authorityFailure(): OneOutcome {
  return {
    result: {
      status: "authority-expired",
      reason: "grant-session",
      detail: "The Grant Session is no longer current.",
    },
  };
}

function samePreparedAction(
  left: PreparedControlAction,
  right: PreparedControlAction | null | undefined,
): boolean {
  return (
    right !== null &&
    right !== undefined &&
    left.codecIdentity === right.codecIdentity &&
    left.canonicalContent === right.canonicalContent &&
    left.contentFingerprint === right.contentFingerprint &&
    canonicalizeJson(left.interpretation) === canonicalizeJson(right.interpretation) &&
    canonicalizeJson(left.input.lifecycle) === canonicalizeJson(right.input.lifecycle)
  );
}

function samePreparationResult(
  left: PreparedControlAction | null,
  right: PreparedControlAction | null,
): boolean {
  if (left === null || right === null) return left === right;
  return samePreparedAction(left, right);
}

function one(result: FoundationActionResult): OneOutcome {
  return { result };
}

function validateCurrentAction(
  transaction: FoundationStorageTransaction,
  root: EventGameRecordRoot,
  prepared: PreparedControlAction,
  options: FoundationAcceptanceOptions,
): { reason: string; detail: string } | null {
  const dependency = validateDependencies(transaction, prepared.input);
  if (dependency !== null) return dependency;
  if (
    prepared.interpretation.type === "correction" &&
    findFactById(transaction.listActions(root.recordId), prepared.interpretation.targetFactId) ===
      null
  )
    return { reason: "fact-target-missing", detail: "The Correction target is not retained." };
  if (
    prepared.interpretation.type === "team-assignment-correction" &&
    options.externalScopeResolver.resolveEventTeam(
      root.eventId,
      prepared.interpretation.eventTeamId,
      transaction,
    ).status !== "resolved"
  )
    return { reason: "invalid-action", detail: "The Event Team is unavailable." };
  return null;
}

function dependencyOutcome(
  predecessorResults: readonly FoundationActionResult[],
): { status: "dependency-blocked" | "retry-later"; reason: string; detail: string } | undefined {
  if (
    predecessorResults.some(
      (result) => result.status === "retry-later" || result.status === "authority-expired",
    )
  )
    return {
      status: "retry-later",
      reason: "causal-predecessor-retry",
      detail: "Retry after the causal predecessor reaches a definitive outcome.",
    };
  if (
    predecessorResults.some(
      (result) => result.status !== "accepted" && result.status !== "duplicate-accepted",
    )
  )
    return {
      status: "dependency-blocked",
      reason: "causal-dependency-rejected",
      detail: "A causal predecessor did not commit.",
    };
  return undefined;
}

function readAttemptResult(
  attempt: StoredReplayAttempt,
  expectedAction?: ControlAction,
  expectedReason?: string,
): FoundationActionResult {
  const failure = replayAttemptResultFailure(attempt, expectedAction, expectedReason);
  if (failure !== null) throw new Error(failure);
  return JSON.parse(attempt.resultJson!) as FoundationActionResult;
}
function reservationIdFor(batch: PreparedBatch, sessionId: string): string {
  // The reservation identifies the authenticated replay slot, not its
  // contents. The batch digest remains authenticated mutable evidence and is
  // checked by ensureReservation, while a locked delivery can still find and
  // discard an existing reserved/partial slot without retaining content-derived
  // identifiers.
  return `reservation-${sha256(`${batch.input.recordId}:${batch.input.eventGameId}:${batch.input.replay?.originatingSessionId ?? ""}:${sessionId}`)}`;
}

function rejectionCandidate(
  prepared: PreparedControlAction | undefined,
  input: ControlActionEnvelope | ControlActionInput,
  registry: ControlActionCodecRegistry,
): {
  codecIdentity: string;
  codecFingerprint: string;
  canonicalContent: string;
  contentFingerprint: string;
} {
  if (prepared !== undefined) {
    return {
      codecIdentity: prepared.codecIdentity,
      codecFingerprint: prepared.codecFingerprint,
      canonicalContent: prepared.canonicalContent,
      contentFingerprint: prepared.contentFingerprint,
    };
  }
  const codecIdentity = controlActionCodecIdentity(input.kind, registry);
  const canonicalContent = canonicalizeJson(input);
  return {
    codecIdentity,
    codecFingerprint: codecIdentity,
    canonicalContent,
    contentFingerprint: sha256(`${codecIdentity}:${canonicalContent}`),
  };
}

function sameRejectedCandidate(
  links: NonNullable<ControlAuditEntry["links"]>,
  candidate: ReturnType<typeof rejectionCandidate>,
): boolean {
  const rejected = links.rejectedCandidate;
  if (
    rejected === undefined ||
    rejected.codecIdentity !== candidate.codecIdentity ||
    rejected.codecFingerprint !== candidate.codecFingerprint ||
    rejected.canonicalContent !== candidate.canonicalContent ||
    rejected.contentFingerprint !== candidate.contentFingerprint
  )
    return false;
  const collision = links.collision?.rejectedAttempt;
  return (
    collision === undefined ||
    (collision.codecIdentity === candidate.codecIdentity &&
      collision.codecFingerprint === candidate.codecFingerprint &&
      collision.canonicalContent === candidate.canonicalContent &&
      collision.contentFingerprint === candidate.contentFingerprint)
  );
}

function parseGrantOutcomeDetail(value: string | null | undefined): {
  status: FoundationActionResult["status"];
  reason: FoundationRejectionReason | null;
} | null {
  if (value === null || value === undefined) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof parsed.status !== "string" ||
      ![
        "accepted",
        "duplicate-accepted",
        "rejected",
        "dependency-blocked",
        "authority-expired",
        "retry-later",
      ].includes(parsed.status) ||
      (parsed.reason !== null && typeof parsed.reason !== "string")
    )
      return null;
    return {
      status: parsed.status as FoundationActionResult["status"],
      reason: parsed.reason === null ? null : normalizeFoundationRejectionReason(parsed.reason),
    };
  } catch {
    return null;
  }
}

function linkedGrantAudit(
  options: GrantAuthorityOptions,
  grant: StoredGrant,
  session: StoredGrantSession,
  acceptanceId: string,
  controlAuditId: string,
  controlActionId: string,
  outcome: string,
  contentFingerprint: string,
  createdAtMs: number,
  reason: FoundationRejectionReason | null,
  detail: string | null = null,
) {
  const action =
    outcome === "accepted"
      ? "control-action-accepted"
      : outcome === "duplicate-accepted"
        ? "control-action-duplicate"
        : outcome === "retry-later"
          ? "control-action-retry-later"
          : outcome === "dependency-blocked"
            ? "control-action-dependency-blocked"
            : "control-action-rejected";
  return {
    ...createGrantAudit(
      options,
      auditInput(
        action,
        grant,
        {
          kind: "session",
          sessionId: session.sessionId,
          pseudonymKeyVersion: session.browserContextKeyVersion,
        },
        grant.status,
        session.sessionId,
        null,
        session.eventGameId,
        grant.status,
        null,
        null,
        null,
        null,
        null,
      ),
    ),
    acceptanceId,
    controlAuditId,
    controlActionId,
    contentFingerprint,
    outcomeDetail: canonicalizeJson({
      status: outcome,
      reason,
      detail: detail ?? "",
    }),
    createdAtMs,
  };
}

function takeBudget(
  transaction: FoundationStorageTransaction,
  kind: StoredAcceptanceBudget["bucketKind"],
  subjectId: string,
  capacity: number,
  refillPerSecond: number,
  nowMs: number,
  keyRing: GrantAuthorityOptions["keyRing"],
): boolean {
  const bucketId = `budget-${kind}:${subjectId}`;
  const previous = transaction.findAcceptanceBudget(bucketId);
  const elapsed = previous === null ? 0 : Math.max(0, nowMs - previous.updatedAtMs) / 1000;
  const tokens = Math.min(capacity, (previous?.tokens ?? capacity) + elapsed * refillPerSecond);
  const allowed = tokens >= 1;
  transaction.upsertAcceptanceBudget({
    bucketId,
    bucketKind: kind,
    subjectId,
    capacity,
    refillPerSecond,
    tokens: allowed ? tokens - 1 : tokens,
    updatedAtMs: nowMs,
    stateRevision: (previous?.stateRevision ?? 0) + 1,
  });
  transaction.insertAcceptanceIntegrityAnchor(
    anchorFor(
      "budget",
      {
        bucketId,
        bucketKind: kind,
        subjectId,
        capacity,
        refillPerSecond,
        tokens: allowed ? tokens - 1 : tokens,
        updatedAtMs: nowMs,
        stateRevision: (previous?.stateRevision ?? 0) + 1,
      },
      keyRing,
    ),
  );
  return allowed;
}

function topologicalOrder(
  actions: readonly { operationId: string; predecessors: readonly string[] }[],
): number[] | null {
  const byOperation = new Map(actions.map((item, index) => [item.operationId, index]));
  const indegree = actions.map(
    (item) => item.predecessors.filter((id) => byOperation.has(id)).length,
  );
  const order: number[] = [];
  while (order.length < actions.length) {
    const next = actions.findIndex((_, index) => indegree[index] === 0 && !order.includes(index));
    if (next < 0) return null;
    order.push(next);
    const operation = actions[next]?.operationId;
    for (const [index, item] of actions.entries())
      if (item.predecessors.includes(operation ?? "")) indegree[index] = (indegree[index] ?? 0) - 1;
    indegree[next] = -1;
  }
  return order;
}
function predecessorResultsFor(
  batch: PreparedBatch,
  results: readonly FoundationActionResult[],
  index: number,
): FoundationActionResult[] {
  const predecessorResults: FoundationActionResult[] = [];
  for (const predecessor of batch.actions[index]?.envelope.causalPredecessorIds ?? []) {
    const predecessorIndex = batch.actions.findIndex(
      (candidate) => candidate.envelope.operationId === predecessor,
    );
    if (predecessorIndex >= 0 && results[predecessorIndex] !== undefined)
      predecessorResults.push(results[predecessorIndex]);
  }
  return predecessorResults;
}
function encodeReceipt(
  reservationId: string,
  keyRing: GrantAuthorityOptions["keyRing"],
  keyVersion = keyRing.lookup.currentVersion,
): string {
  return `${reservationId}.${computeLookupDigest(
    `acceptance-receipt:${reservationId}`,
    keyRing,
    keyVersion,
  )}`;
}
function readNow(clock: () => number): number {
  const nowMs = clock();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0)
    throw new Error("Acceptance clock returned an invalid timestamp.");
  return nowMs;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
