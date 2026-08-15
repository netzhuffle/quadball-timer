import { describe, expect, test } from "bun:test";
import {
  createFoundationAcceptance,
  type FoundationAcceptanceOptions,
} from "@/lib/foundation-acceptance";
import {
  createDeterministicTestIqaInterpreter,
  createControlActionCodecRegistry,
  sha256,
  type ControlActionInput,
} from "@/lib/event-game-actions";
import { createEventGameRecord } from "@/lib/event-game-record";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import {
  createGrantTestAuthorityVerifier,
  createLegacyControlGrantTestAuthority,
} from "@/lib/grant-authority-test-support";
import type {
  FoundationStorage,
  FoundationStorageTransaction,
  FoundationStorageTransactionWork,
} from "@/lib/foundation-storage";
import type { GrantAuthority } from "@/lib/grant-authority-types";
import type { GrantKeyRing } from "@/lib/grant-types";
import { anchorFor } from "@/lib/foundation-acceptance-integrity";
import { computeGrantAuditIntegrityTag } from "@/lib/grant-crypto";

type FailureBoundary =
  | "after-action"
  | "after-metadata"
  | "after-control-audit"
  | "after-grant-audit"
  | "before-receipt";

describe("adversarial composed acceptance", () => {
  test("authorizes before codec or payload disclosure and records a valid replay rejection", async () => {
    const harness = await createHarness({ replay: true });
    const invalid = createFact(
      harness.root,
      "invalid-payload",
      harness.sessionId,
      harness.grantVersion,
    );
    invalid.kind = { id: "unsupported-codec", version: "999" };
    invalid.payload = { deliberately: "invalid" };
    const unauthorized = await harness.acceptance.submitBatch({
      recordId: harness.root.recordId,
      eventGameId: harness.root.eventGameId,
      sessionBearer: "not-a-current-session",
      actions: [invalid],
    });
    expect(unauthorized.results[0]).toMatchObject({
      status: "authority-expired",
      reason: "grant-session",
    });
    expect(await harness.storage.readActions(harness.root.recordId)).toHaveLength(0);

    const replay = await harness.acceptance.submitBatch({
      mode: "replay",
      recordId: harness.root.recordId,
      eventGameId: harness.root.eventGameId,
      replay: {
        sessionBearer: harness.sessionBearer,
        originatingSessionId: "origin-session",
        replayEvidenceId: "eligible-replay",
      },
      actions: [invalid],
    });
    expect(replay).toMatchObject({ status: "committed" });
    expect(replay.receipt).toBeUndefined();
    expect(replay.results[0]).toMatchObject({ status: "rejected", reason: "invalid-action" });
  });

  test("does not inspect the root before ordinary bearer authority", async () => {
    const harness = await createHarness();
    const guarded = guardRootReads(harness.storage);
    const acceptance = createFoundationAcceptance(guarded.storage, {
      grant: harness.grant,
      externalScopeResolver: createScopeResolver(harness.root),
      clock: () => 1_000,
      interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      verifyLockedReplay: () => false,
    });
    const result = await acceptance.submitBatch({
      recordId: harness.root.recordId,
      eventGameId: harness.root.eventGameId,
      sessionBearer: "invalid-ordinary-bearer",
      actions: [
        createFact(harness.root, "ordinary-root-spy", harness.sessionId, harness.grantVersion),
      ],
    });
    expect(result.results[0]).toMatchObject({
      status: "authority-expired",
      reason: "grant-session",
    });
    expect(guarded.rootReads()).toBe(0);
  });

  test("does not inspect the root when transaction-local authority expires", async () => {
    const harness = await createHarness();
    const guarded = guardRootReads(harness.storage, 1);
    const acceptance = createFoundationAcceptance(guarded.storage, {
      grant: harness.grant,
      externalScopeResolver: createScopeResolver(harness.root),
      clock: () => 1_000,
      interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      afterReadOnlyPreflight: async () => {
        await harness.authority.revokeControlGrant(harness.grantId, {
          kind: "fixture",
          id: "fixture",
        });
      },
    });
    const result = await acceptance.submitBatch({
      recordId: harness.root.recordId,
      eventGameId: harness.root.eventGameId,
      sessionBearer: harness.sessionBearer,
      actions: [
        createFact(harness.root, "transaction-root-spy", harness.sessionId, harness.grantVersion),
      ],
    });
    expect(result.results[0]).toMatchObject({
      status: "authority-expired",
      reason: "grant-session",
    });
    expect(guarded.rootReads()).toBe(1);
  });

  test("does not inspect the root for invalid trusted lock evidence", async () => {
    const harness = await createHarness();
    const guarded = guardRootReads(harness.storage);
    const acceptance = createFoundationAcceptance(guarded.storage, {
      grant: harness.grant,
      externalScopeResolver: createScopeResolver(harness.root),
      clock: () => 1_000,
      interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      verifyLockedReplay: () => false,
    });
    const result = await acceptance.submitBatch({
      mode: "replay",
      recordId: harness.root.recordId,
      eventGameId: "claimed-game",
      replay: {
        sessionBearer: "invalid-lock-bearer",
        originatingSessionId: "origin-session",
        replayEvidenceId: "invalid-lock-evidence",
      },
      actions: [
        createFact(
          { ...harness.root, eventGameId: "claimed-game" },
          "invalid-lock-root-spy",
          harness.sessionId,
          harness.grantVersion,
        ),
      ],
    });
    expect(result.results[0]).toMatchObject({
      status: "authority-expired",
      reason: "grant-session",
    });
    expect(guarded.rootReads()).toBe(0);
  });

  test("prepares every codec before returning a generic authorized missing-root outcome", async () => {
    const harness = await createHarness();
    const before = await readAuthorityBoundaryState(harness);
    let decodeCalls = 0;
    const throwingCodec = {
      kind: "throwing-codec",
      version: "1",
      decode() {
        decodeCalls += 1;
        throw new Error("codec must stay behind the read-only preparation seam");
      },
      canonicalize() {
        throw new Error("unreachable");
      },
      fingerprint() {
        throw new Error("unreachable");
      },
      interpret() {
        throw new Error("unreachable");
      },
    };
    const acceptance = createFoundationAcceptance(harness.storage, {
      grant: createGrantOptions(harness.root.eventGameId),
      externalScopeResolver: createScopeResolver(harness.root),
      clock: () => 1_000,
      interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      actionCodecRegistry: createControlActionCodecRegistry([throwingCodec]),
    });
    const action = createFact(
      harness.root,
      "missing-root-codec",
      harness.sessionId,
      harness.grantVersion,
    );
    action.recordId = "missing-record";
    action.kind = { id: "throwing-codec", version: "1" };
    const result = await acceptance.submitBatch({
      recordId: "missing-record",
      eventGameId: harness.root.eventGameId,
      sessionBearer: harness.sessionBearer,
      actions: [action],
    });
    expect(decodeCalls).toBe(1);
    expect(result.results[0]).toMatchObject({ status: "rejected", reason: "record-not-found" });
    expect(await harness.storage.readAuditEntries(harness.root.recordId)).toHaveLength(0);
    expect(await readAuthorityBoundaryState(harness)).toEqual(before);
  });

  test("rejects structural failures before mutation and blocks only causal dependants", async () => {
    const structural = await createHarness();
    const invalid = createFact(
      structural.root,
      "duplicate-id",
      structural.sessionId,
      structural.grantVersion,
    );
    const structuralResult = await structural.acceptance.submitBatch({
      recordId: structural.root.recordId,
      eventGameId: structural.root.eventGameId,
      sessionBearer: structural.sessionBearer,
      actions: [invalid, invalid],
    });
    expect(structuralResult).toEqual({ status: "rejected", results: [] });
    expect(await structural.storage.readActions(structural.root.recordId)).toHaveLength(0);
    expect(await structural.storage.readAuditEntries(structural.root.recordId)).toHaveLength(0);

    const causal = await createHarness();
    const rejected = {
      ...createFact(causal.root, "rejected", causal.sessionId, causal.grantVersion),
      causalPredecessorIds: ["outside-batch"],
    };
    const blocked = {
      ...createFact(causal.root, "blocked", causal.sessionId, causal.grantVersion),
      causalPredecessorIds: ["rejected"],
    };
    const unrelated = createFact(causal.root, "unrelated", causal.sessionId, causal.grantVersion);
    const outcome = await causal.acceptance.submitBatch({
      recordId: causal.root.recordId,
      eventGameId: causal.root.eventGameId,
      sessionBearer: causal.sessionBearer,
      actions: [blocked, rejected, unrelated],
    });
    expect(outcome.results.map((result) => result.status)).toEqual([
      "dependency-blocked",
      "rejected",
      "accepted",
    ]);
    expect(await causal.storage.readActions(causal.root.recordId)).toHaveLength(1);
    expect(
      (await causal.storage.readAuditEntries(causal.root.recordId)).filter(
        (entry) => entry.links?.grantAuditId !== undefined,
      ),
    ).toHaveLength(3);
  });

  test("rolls back each mutation boundary and retains evidence at the budget boundary", async () => {
    for (const boundary of [
      "after-action",
      "after-metadata",
      "after-control-audit",
      "after-grant-audit",
    ] as const) {
      const harness = await createHarness({ failureBoundary: boundary });
      const result = await harness.acceptance.submitBatch({
        recordId: harness.root.recordId,
        eventGameId: harness.root.eventGameId,
        sessionBearer: harness.sessionBearer,
        actions: [
          createFact(harness.root, `failure-${boundary}`, harness.sessionId, harness.grantVersion),
        ],
      });
      expect(result.results[0]).toMatchObject({
        status: "retry-later",
        reason: "storage-unavailable",
      });
      expect(await harness.storage.readActions(harness.root.recordId)).toHaveLength(0);
      expect(await harness.storage.readAuditEntries(harness.root.recordId)).toHaveLength(0);
    }

    const budget = await createHarness({
      limits: { onlineSessionCapacity: 1, onlineEventCapacity: 1 },
    });
    const first = createFact(budget.root, "budget-first", budget.sessionId, budget.grantVersion);
    const second = createFact(budget.root, "budget-second", budget.sessionId, budget.grantVersion);
    const result = await budget.acceptance.submitBatch({
      recordId: budget.root.recordId,
      eventGameId: budget.root.eventGameId,
      sessionBearer: budget.sessionBearer,
      actions: [first, second],
    });
    expect(result.results.map((item) => item.status)).toEqual(["accepted", "retry-later"]);
    expect(result.results[1]).toMatchObject({ reason: "rate-budget" });
    const budgets = await budget.storage.transaction((transaction) => ({
      session: transaction.findAcceptanceBudget(`budget-online-session:${budget.sessionId}`),
      event: transaction.findAcceptanceBudget(`budget-online-event:${budget.root.eventGameId}`),
    }));
    expect(budgets.session?.tokens).toBe(0);
    expect(budgets.event?.tokens).toBe(0);
    expect(
      (await budget.storage.readAuditEntries(budget.root.recordId)).filter(
        (entry) => entry.links?.grantAuditId,
      ),
    ).toHaveLength(2);

    const receiptFailure = await createHarness({
      failureBoundary: "before-receipt",
      replay: true,
    });
    const noReceipt = await receiptFailure.acceptance.submitBatch({
      mode: "replay",
      recordId: receiptFailure.root.recordId,
      eventGameId: receiptFailure.root.eventGameId,
      replay: {
        sessionBearer: receiptFailure.sessionBearer,
        originatingSessionId: "origin-session",
        replayEvidenceId: "eligible-replay",
      },
      actions: [
        createFact(
          receiptFailure.root,
          "receipt-failure",
          receiptFailure.sessionId,
          receiptFailure.grantVersion,
        ),
      ],
    });
    expect(noReceipt.receipt).toBeUndefined();
    expect(noReceipt.status).toBe("partial");
    expect(noReceipt.results[0]).toMatchObject({
      status: "retry-later",
      reason: "storage-unavailable",
    });
    expect(await receiptFailure.storage.readActions(receiptFailure.root.recordId)).toHaveLength(0);
  });

  test("uses the trusted lock discard seam and keeps replay acknowledgement independent of current authority", async () => {
    const locked = await createHarness({ locked: true });
    const lockedResult = await locked.acceptance.submitBatch({
      mode: "replay",
      recordId: locked.root.recordId,
      eventGameId: locked.root.eventGameId,
      replay: {
        sessionBearer: locked.sessionBearer,
        originatingSessionId: "origin-session",
        replayEvidenceId: "trusted-lock-evidence",
      },
      actions: [createFact(locked.root, "locked-action", locked.sessionId, locked.grantVersion)],
    });
    expect(lockedResult.results[0]).toMatchObject({
      status: "locked-discarded",
      count: 1,
      eventGameId: locked.root.eventGameId,
    });
    const lockedAudit = (await locked.storage.readAuditEntries(locked.root.recordId))[0];
    expect(lockedAudit?.redactedDetail).toBeUndefined();
    expect(lockedAudit?.links).toBeUndefined();
    expect(lockedAudit?.provenance).toBeUndefined();
    expect(lockedAudit?.lockedReplay).toEqual({
      count: 1,
      originatingSessionId: "origin-session",
      eventGameId: locked.root.eventGameId,
      rejectedAtMs: 1_000,
    });
    expect(await locked.storage.readActions(locked.root.recordId)).toHaveLength(0);
    expect(await locked.storage.readiness()).toMatchObject({ ok: true });

    const unreserved = await createHarness({ locked: true });
    await unreserved.storage.transaction((transaction) => {
      transaction.discardReplayReservation("seed-locked-reservation");
    });
    const unreservedResult = await unreserved.acceptance.submitBatch({
      mode: "replay",
      recordId: unreserved.root.recordId,
      eventGameId: unreserved.root.eventGameId,
      replay: {
        sessionBearer: unreserved.sessionBearer,
        originatingSessionId: "origin-session",
        replayEvidenceId: "trusted-lock-evidence",
      },
      actions: [
        createFact(unreserved.root, "locked-action", unreserved.sessionId, unreserved.grantVersion),
      ],
    });
    expect(unreservedResult.results[0]).toMatchObject({
      status: "authority-expired",
      reason: "game-locked",
    });
    expect(await unreserved.storage.readAuditEntries(unreserved.root.recordId)).toHaveLength(0);
    const differentContent = await locked.acceptance.submitBatch({
      mode: "replay",
      recordId: locked.root.recordId,
      eventGameId: locked.root.eventGameId,
      replay: {
        sessionBearer: locked.sessionBearer,
        originatingSessionId: "origin-session",
        replayEvidenceId: "trusted-lock-evidence",
      },
      actions: [
        createFact(locked.root, "different-locked-action", locked.sessionId, locked.grantVersion),
      ],
    });
    expect(differentContent.results[0]).toMatchObject({
      status: "authority-expired",
      reason: "game-locked",
    });
    const repeated = await locked.acceptance.submitBatch({
      mode: "replay",
      recordId: locked.root.recordId,
      eventGameId: locked.root.eventGameId,
      replay: {
        sessionBearer: locked.sessionBearer,
        originatingSessionId: "origin-session",
        replayEvidenceId: "trusted-lock-evidence",
      },
      actions: [createFact(locked.root, "locked-action", locked.sessionId, locked.grantVersion)],
    });
    expect(repeated.results[0]).toMatchObject({ status: "locked-discarded", count: 1 });

    const replay = await createHarness({ replay: true });
    const replayOutcome = await replay.acceptance.submitBatch({
      mode: "replay",
      recordId: replay.root.recordId,
      eventGameId: replay.root.eventGameId,
      replay: {
        sessionBearer: replay.sessionBearer,
        originatingSessionId: "origin-session",
        replayEvidenceId: "eligible-replay",
      },
      actions: [createFact(replay.root, "replay-action", replay.sessionId, replay.grantVersion)],
    });
    expect(replayOutcome.receipt).toEqual(expect.any(String));
    const replayBudgetBefore = await replay.storage.transaction((transaction) =>
      transaction.findAcceptanceBudget(`budget-replay-session:${replay.sessionId}`),
    );
    const replayRetry = await replay.acceptance.submitBatch({
      mode: "replay",
      recordId: replay.root.recordId,
      eventGameId: replay.root.eventGameId,
      replay: {
        sessionBearer: replay.sessionBearer,
        originatingSessionId: "origin-session",
        replayEvidenceId: "eligible-replay",
      },
      actions: [createFact(replay.root, "replay-action", replay.sessionId, replay.grantVersion)],
    });
    expect(replayRetry).toMatchObject({ status: "committed", receipt: replayOutcome.receipt });
    const replayBudgetAfter = await replay.storage.transaction((transaction) =>
      transaction.findAcceptanceBudget(`budget-replay-session:${replay.sessionId}`),
    );
    expect(replayBudgetAfter?.tokens).toBe(replayBudgetBefore?.tokens);
    expect(
      await replay.authority.revokeControlGrant(replay.grantId, { kind: "fixture", id: "fixture" }),
    ).toMatchObject({ status: "updated" });
    expect(await replay.acceptance.acknowledgeReplay(replayOutcome.receipt)).toEqual({
      status: "acknowledged",
    });
    expect(replayOutcome.receipt).not.toContain(replay.sessionBearer);
    const durable = await replay.storage.transaction((transaction) =>
      transaction.findReplayReservation(replayOutcome.reservationId ?? "missing"),
    );
    expect(durable?.batchDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(durable?.batchDigest).not.toContain("replay-action");
  });

  test("recovers an exact committed replay after a memory Game Lock", async () => {
    const harness = await createHarness({ replay: true });
    const evidence = "memory-lock-recovery-evidence";
    const action = createFact(
      harness.root,
      "memory-lock-recovery-operation",
      harness.sessionId,
      harness.grantVersion,
    );
    const committed = await harness.acceptance.submitBatch({
      mode: "replay",
      recordId: harness.root.recordId,
      eventGameId: harness.root.eventGameId,
      replay: {
        sessionBearer: harness.sessionBearer,
        originatingSessionId: "origin-session",
        replayEvidenceId: evidence,
      },
      actions: [action],
    });
    const receipt = committed.receipt;
    expect(committed).toMatchObject({ status: "committed", receipt: expect.any(String) });
    const lockedRoot = {
      ...harness.root,
      lifecycle: {
        phase: "finished" as const,
        commencedAtMs: 100,
        finishedAtMs: 800,
        lockedAtMs: 900,
        lockReason: "administrative" as const,
      },
    };
    const digest = sha256(
      JSON.stringify({
        recordId: harness.root.recordId,
        eventGameId: harness.root.eventGameId,
        mode: "replay",
        replay: { originatingSessionId: "origin-session", replayEvidenceId: evidence },
        actions: [action],
      }),
    );
    const lockedStorage = new Proxy(harness.storage, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return (work: FoundationStorageTransactionWork<unknown>) =>
          target.transaction((transaction) =>
            work({
              ...transaction,
              findRootByRecordId: () => lockedRoot,
              findRootByEventGameId: () => lockedRoot,
            } satisfies FoundationStorageTransaction),
          );
      },
    }) as FoundationStorage;
    const lockedAcceptance = createFoundationAcceptance(lockedStorage, {
      grant: createGrantOptions(harness.root.eventGameId),
      externalScopeResolver: createScopeResolver(harness.root),
      clock: () => 1_000,
      interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      verifyLockedReplay: ({ batchDigest }) => batchDigest === digest,
    });
    const recovered = await lockedAcceptance.submitBatch({
      mode: "replay",
      recordId: harness.root.recordId,
      eventGameId: harness.root.eventGameId,
      replay: {
        sessionBearer: "lost-response-bearer",
        originatingSessionId: "origin-session",
        replayEvidenceId: evidence,
      },
      actions: [action],
    });
    expect(recovered).toMatchObject({ status: "committed", receipt });
    expect(await lockedAcceptance.acknowledgeReplay(receipt!)).toEqual({ status: "acknowledged" });
  });

  test("recovers committed replay duplicate and rejection results after memory restart", async () => {
    for (const rejected of [false, true]) {
      const harness = await createHarness({ replay: true });
      const action = createFact(
        harness.root,
        rejected ? "memory-replay-rejected" : "memory-replay-duplicate",
        harness.sessionId,
        harness.grantVersion,
      );
      if (rejected) action.causalPredecessorIds = ["missing-replay-predecessor"];
      if (!rejected) {
        expect(
          await harness.acceptance.submitBatch({
            recordId: harness.root.recordId,
            eventGameId: harness.root.eventGameId,
            sessionBearer: harness.sessionBearer,
            actions: [action],
          }),
        ).toMatchObject({ results: [{ status: "accepted" }] });
      }
      const replayInput = {
        mode: "replay" as const,
        recordId: harness.root.recordId,
        eventGameId: harness.root.eventGameId,
        replay: {
          sessionBearer: harness.sessionBearer,
          originatingSessionId: rejected ? "memory-rejection-origin" : "memory-duplicate-origin",
          replayEvidenceId: "memory-restart-replay",
        },
        actions: [action],
      };
      const committed = await harness.acceptance.submitBatch(replayInput);
      const committedReservationId = committed.reservationId;
      const committedReceipt = committed.receipt;
      expect(committed).toMatchObject({
        status: "committed",
        receipt: expect.any(String),
        reservationId: expect.any(String),
      });
      const restartedAcceptance = createFoundationAcceptance(harness.storage, {
        grant: createGrantOptions(harness.root.eventGameId),
        externalScopeResolver: createScopeResolver(harness.root),
        clock: () => 1_000,
        interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
        replayEligibility: () => ({ status: "eligible" as const }),
      });
      const retried = await restartedAcceptance.submitBatch(replayInput);
      expect(retried.results[0]).toEqual(committed.results[0]);
      expect(retried.reservationId).toBe(committedReservationId);
      expect(retried.receipt).toBe(committedReceipt);
      expect(await restartedAcceptance.acknowledgeReplay(committedReceipt!)).toEqual({
        status: "acknowledged",
      });
    }
  });

  test("resumes a partial replay after memory restart without a premature receipt", async () => {
    const harness = await createHarness({
      replay: true,
      limits: { replaySessionCapacity: 1 },
    });
    const first = createFact(
      harness.root,
      "memory-partial-first",
      harness.sessionId,
      harness.grantVersion,
    );
    const second = {
      ...createFact(harness.root, "memory-partial-second", harness.sessionId, harness.grantVersion),
      causalPredecessorIds: [first.operationId],
    };
    const input = {
      mode: "replay" as const,
      recordId: harness.root.recordId,
      eventGameId: harness.root.eventGameId,
      replay: {
        sessionBearer: harness.sessionBearer,
        originatingSessionId: "memory-partial-origin",
        replayEvidenceId: "memory-partial-replay",
      },
      actions: [second, first],
    };
    const partial = await harness.acceptance.submitBatch(input);
    expect(partial.results.map((result) => result.status)).toEqual(["retry-later", "accepted"]);
    expect(partial.receipt).toBeUndefined();
    const partialReservationId = partial.reservationId;
    expect(partialReservationId).toEqual(expect.any(String));
    harness.nowMs.value = 2_000;
    const restartedAcceptance = createFoundationAcceptance(harness.storage, {
      grant: createGrantOptions(harness.root.eventGameId),
      externalScopeResolver: createScopeResolver(harness.root),
      clock: () => harness.nowMs.value,
      interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      limits: { replaySessionCapacity: 1 },
      replayEligibility: () => ({ status: "eligible" as const }),
    });
    const resumed = await restartedAcceptance.submitBatch(input);
    expect(resumed.results[1]).toEqual(partial.results[1]);
    expect(resumed.results[0]).toMatchObject({ status: "accepted" });
    expect(resumed.reservationId).toBe(partialReservationId);
    const resumedReceipt = resumed.receipt;
    expect(resumedReceipt).toEqual(expect.any(String));
    expect(
      (await harness.storage.readAuditEntries(harness.root.recordId)).filter(
        (entry) => entry.links?.grantAuditId !== undefined,
      ),
    ).toHaveLength(3);
    expect(await restartedAcceptance.acknowledgeReplay(resumedReceipt!)).toEqual({
      status: "acknowledged",
    });
  });

  test("persists definitive mixed replay outcomes under one reservation", async () => {
    for (const unsupported of [true, false]) {
      const harness = await createHarness({ replay: true });
      const first = createFact(
        harness.root,
        unsupported ? "memory-mixed-valid-codec" : "memory-mixed-valid-eligibility",
        harness.sessionId,
        harness.grantVersion,
      );
      const second = createFact(
        harness.root,
        unsupported ? "memory-mixed-unsupported" : "memory-mixed-ineligible",
        harness.sessionId,
        harness.grantVersion,
      );
      if (unsupported) second.kind = { id: "memory-mixed-unsupported-codec", version: "1" };
      const createReplayAcceptance = () =>
        createFoundationAcceptance(harness.storage, {
          grant: createGrantOptions(harness.root.eventGameId),
          externalScopeResolver: createScopeResolver(harness.root),
          clock: () => harness.nowMs.value,
          interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
          replayEligibility: ({ action }) => {
            if (!unsupported && action.input.operationId === second.operationId)
              throw new Error("adapter callback failure");
            return { status: "eligible" as const };
          },
        });
      const input = {
        mode: "replay" as const,
        recordId: harness.root.recordId,
        eventGameId: harness.root.eventGameId,
        replay: {
          sessionBearer: harness.sessionBearer,
          originatingSessionId: unsupported
            ? "memory-mixed-unsupported-origin"
            : "memory-mixed-ineligible-origin",
          replayEvidenceId: "memory-mixed-replay",
        },
        actions: [first, second],
      };
      const firstDelivery = await createReplayAcceptance().submitBatch(input);
      const reservationId = firstDelivery.reservationId;
      const receipt = firstDelivery.receipt;
      expect(firstDelivery.results[0]).toMatchObject({ status: "accepted" });
      expect(firstDelivery.results[1]).toMatchObject(
        unsupported
          ? { status: "rejected", reason: "invalid-action" }
          : { status: "authority-expired", reason: "replay-ineligible" },
      );
      expect(reservationId).toEqual(expect.any(String));
      expect(receipt).toEqual(expect.any(String));
      const attempts = await harness.storage.transaction((transaction) =>
        transaction.listReplayAttempts(reservationId!),
      );
      expect(attempts).toHaveLength(2);
      expect(attempts.every((attempt) => attempt.status !== "retry-later")).toBe(true);
      expect(
        (await harness.storage.readAuditEntries(harness.root.recordId)).filter(
          (entry) => entry.links?.grantAuditId !== undefined,
        ),
      ).toHaveLength(2);

      const restarted = await createReplayAcceptance().submitBatch(input);
      expect(restarted.results).toEqual(firstDelivery.results);
      expect(restarted.reservationId).toBe(reservationId);
      expect(restarted.receipt).toBe(receipt);
      expect(await createReplayAcceptance().acknowledgeReplay(receipt!)).toEqual({
        status: "acknowledged",
      });
    }
  });

  test("freezes an online memory pair when fingerprints are coordinated wrongly", async () => {
    const harness = await createHarness();
    const outcome = await harness.acceptance.submitBatch({
      recordId: harness.root.recordId,
      eventGameId: harness.root.eventGameId,
      sessionBearer: harness.sessionBearer,
      actions: [
        createFact(
          harness.root,
          "memory-online-fingerprint",
          harness.sessionId,
          harness.grantVersion,
        ),
      ],
    });
    expect(outcome).toMatchObject({ status: "committed" });
    type MemoryInternals = {
      state: {
        controlAudits: Map<
          string,
          Map<string, import("@/lib/foundation-storage").StoredControlAuditEntry>
        >;
        grantAudits: Map<string, import("@/lib/grant-types").StoredGrantAuditEntry>;
        grantAuditProvenance: Map<string, import("@/lib/grant-types").StoredGrantAuditEntry>;
        grantAuditIntegrityTags: Map<string, string>;
      };
    };
    const internals = harness.storage as unknown as MemoryInternals;
    const controls = internals.state.controlAudits.get(harness.root.recordId);
    const control = [...(controls?.values() ?? [])].find(
      (entry) => entry.links?.grantAuditId !== undefined,
    );
    if (control?.links?.grantAuditId === undefined || control.links.grantAuditId === null)
      throw new Error("Expected paired audits.");
    const grantAuditId = control.links.grantAuditId;
    const grant = internals.state.grantAudits.get(grantAuditId);
    if (grant === undefined) throw new Error("Expected Grant audit.");
    const wrongFingerprint = "f".repeat(64);
    const mutatedControl = {
      ...control,
      links: { ...control.links, contentFingerprint: wrongFingerprint },
    };
    const mutatedGrant = { ...grant, contentFingerprint: wrongFingerprint };
    controls!.set(control.auditId, mutatedControl);
    internals.state.grantAudits.set(grant.auditId, mutatedGrant);
    internals.state.grantAuditProvenance.set(grant.auditId, mutatedGrant);
    internals.state.grantAuditIntegrityTags.set(
      grant.auditId,
      computeGrantAuditIntegrityTag(mutatedGrant, createKeyRing()),
    );
    expect(await harness.storage.readiness()).toMatchObject({
      ok: false,
      status: "integrity-failure",
    });
  });

  test("fails closed when replay eligibility is omitted", async () => {
    const harness = await createHarness({ replay: true, omitReplayEligibility: true });
    const result = await harness.acceptance.submitBatch({
      mode: "replay",
      recordId: harness.root.recordId,
      eventGameId: harness.root.eventGameId,
      replay: {
        sessionBearer: harness.sessionBearer,
        originatingSessionId: harness.sessionId,
        replayEvidenceId: "missing-eligibility",
      },
      actions: [
        createFact(
          harness.root,
          "missing-eligibility-action",
          harness.sessionId,
          harness.grantVersion,
        ),
      ],
    });
    expect(result.results[0]).toMatchObject({
      status: "authority-expired",
      reason: "replay-ineligible",
    });
    expect(await harness.storage.readActions(harness.root.recordId)).toHaveLength(0);
  });

  test("normalizes adapter replay reasons before durable paired evidence", async () => {
    const harness = await createHarness({ replay: true, replayReason: "adapter-made-up" });
    const result = await harness.acceptance.submitBatch({
      mode: "replay",
      recordId: harness.root.recordId,
      eventGameId: harness.root.eventGameId,
      replay: {
        sessionBearer: harness.sessionBearer,
        originatingSessionId: harness.sessionId,
        replayEvidenceId: "adapter-reason",
      },
      actions: [
        createFact(harness.root, "adapter-reason-action", harness.sessionId, harness.grantVersion),
      ],
    });
    expect(result.results[0]).toMatchObject({
      status: "authority-expired",
      reason: "replay-ineligible",
    });
    expect(await harness.storage.readiness()).toMatchObject({ ok: true });
  });

  test("reuses exact online outcomes for repeated duplicates, rejections, and conflicts", async () => {
    const harness = await createHarness();
    const duplicate = createFact(
      harness.root,
      "memory-third-duplicate",
      harness.sessionId,
      harness.grantVersion,
    );
    const duplicateResults = [];
    for (let index = 0; index < 3; index += 1) {
      duplicateResults.push(
        await harness.acceptance.submitBatch({
          recordId: harness.root.recordId,
          eventGameId: harness.root.eventGameId,
          sessionBearer: harness.sessionBearer,
          actions: [duplicate],
        }),
      );
    }
    expect(duplicateResults.map((result) => result.results[0]?.status)).toEqual([
      "accepted",
      "duplicate-accepted",
      "duplicate-accepted",
    ]);
    expect(duplicateResults[1]?.results[0]).toEqual(duplicateResults[2]?.results[0]);

    const rejected = {
      ...createFact(
        harness.root,
        "memory-repeated-rejection",
        harness.sessionId,
        harness.grantVersion,
      ),
      causalPredecessorIds: ["missing-memory-predecessor"],
    };
    const firstRejected = await harness.acceptance.submitBatch({
      recordId: harness.root.recordId,
      eventGameId: harness.root.eventGameId,
      sessionBearer: harness.sessionBearer,
      actions: [rejected],
    });
    const secondRejected = await harness.acceptance.submitBatch({
      recordId: harness.root.recordId,
      eventGameId: harness.root.eventGameId,
      sessionBearer: harness.sessionBearer,
      actions: [rejected],
    });
    expect(firstRejected.results[0]).toMatchObject({
      status: "rejected",
      reason: "missing-dependency",
    });
    expect(secondRejected.results[0]).toEqual(firstRejected.results[0]);

    const conflictAccepted = createFact(
      harness.root,
      "memory-repeated-conflict",
      harness.sessionId,
      harness.grantVersion,
    );
    await harness.acceptance.submitBatch({
      recordId: harness.root.recordId,
      eventGameId: harness.root.eventGameId,
      sessionBearer: harness.sessionBearer,
      actions: [conflictAccepted],
    });
    const conflictRejected = structuredClone(conflictAccepted);
    conflictRejected.payload = {
      factId: "memory-repeated-conflict-other",
      factType: "test",
      gameSideId: harness.root.gameSides[0]?.id ?? "side-a",
      gameTimeMs: 1,
      data: { operationId: "memory-repeated-conflict" },
    };
    const firstConflict = await harness.acceptance.submitBatch({
      recordId: harness.root.recordId,
      eventGameId: harness.root.eventGameId,
      sessionBearer: harness.sessionBearer,
      actions: [conflictRejected],
    });
    const secondConflict = await harness.acceptance.submitBatch({
      recordId: harness.root.recordId,
      eventGameId: harness.root.eventGameId,
      sessionBearer: harness.sessionBearer,
      actions: [conflictRejected],
    });
    expect(firstConflict.results[0]).toMatchObject({
      status: "rejected",
      reason: "operation-conflict",
    });
    expect(secondConflict.results[0]).toEqual(firstConflict.results[0]);
    expect(await harness.storage.readiness()).toMatchObject({ ok: true });
    expect(
      (await harness.storage.readAuditEntries(harness.root.recordId)).filter(
        (entry) => entry.links?.grantAuditId !== undefined,
      ),
    ).toHaveLength(5);
  });

  test("retains a versioned claimed codec identity through unsupported preparation", async () => {
    const harness = await createHarness();
    const action = createFact(
      harness.root,
      "memory-unknown-codec",
      harness.sessionId,
      harness.grantVersion,
    );
    action.kind = { id: "unknown-codec", version: "7" };
    const result = await harness.acceptance.submitBatch({
      recordId: harness.root.recordId,
      eventGameId: harness.root.eventGameId,
      sessionBearer: harness.sessionBearer,
      actions: [action],
    });
    expect(result.results[0]).toMatchObject({ status: "rejected", reason: "invalid-action" });
    const audit = (await harness.storage.readAuditEntries(harness.root.recordId)).find(
      (entry) => entry.links?.rejectedCandidate !== undefined,
    );
    const candidate = audit?.links?.rejectedCandidate;
    if (candidate === undefined) throw new Error("Expected unsupported-codec evidence.");
    const identity = JSON.parse(candidate.codecIdentity) as {
      claimed: { id: string; version: string };
      registered: unknown;
    };
    expect(identity.claimed).toEqual({ id: "unknown-codec", version: "7" });
    expect(identity.registered).toBeNull();
    expect(candidate.codecIdentity).not.toBe("unprepared");
    expect(candidate.contentFingerprint).toBe(
      sha256(`${candidate.codecFingerprint}:${candidate.canonicalContent}`),
    );
    expect(await harness.storage.readiness()).toMatchObject({ ok: true });

    type MemoryAuditState = {
      state: {
        controlAudits: Map<
          string,
          Map<string, import("@/lib/foundation-storage").StoredControlAuditEntry>
        >;
      };
    };
    const internals = harness.storage as unknown as MemoryAuditState;
    const controls = internals.state.controlAudits.get(harness.root.recordId);
    const links = audit?.links;
    if (audit === undefined || controls === undefined || links === undefined)
      throw new Error("Expected audit state.");
    controls.set(audit.auditId, {
      ...audit,
      links: {
        ...links,
        rejectedCandidate: { ...candidate, codecIdentity: "unprepared" },
      },
    });
    expect(await harness.storage.readiness()).toMatchObject({
      ok: false,
      status: "integrity-failure",
    });
  });

  test("retries a prepared action after rate refill with the same candidate evidence", async () => {
    const harness = await createHarness({
      limits: { onlineSessionCapacity: 1, onlineEventCapacity: 1 },
    });
    const first = createFact(
      harness.root,
      "memory-budget-first",
      harness.sessionId,
      harness.grantVersion,
    );
    const retry = createFact(
      harness.root,
      "memory-budget-retry",
      harness.sessionId,
      harness.grantVersion,
    );
    expect(
      (
        await harness.acceptance.submitBatch({
          recordId: harness.root.recordId,
          eventGameId: harness.root.eventGameId,
          sessionBearer: harness.sessionBearer,
          actions: [first],
        })
      ).results[0],
    ).toMatchObject({ status: "accepted" });
    const exhausted = await harness.acceptance.submitBatch({
      recordId: harness.root.recordId,
      eventGameId: harness.root.eventGameId,
      sessionBearer: harness.sessionBearer,
      actions: [retry],
    });
    expect(exhausted.results[0]).toMatchObject({ status: "retry-later", reason: "rate-budget" });
    const retryAudit = (await harness.storage.readAuditEntries(harness.root.recordId)).find(
      (entry) => entry.links?.reason === "rate-budget",
    );
    const retryCandidate = retryAudit?.links?.rejectedCandidate;
    if (retryCandidate === undefined) throw new Error("Expected prepared rate-budget evidence.");
    expect(retryCandidate.codecIdentity).not.toBe("unprepared");
    expect(retryCandidate.contentFingerprint).toBe(
      sha256(`${retryCandidate.codecFingerprint}:${retryCandidate.canonicalContent}`),
    );
    harness.nowMs.value = 2_000;
    const resumed = await harness.acceptance.submitBatch({
      recordId: harness.root.recordId,
      eventGameId: harness.root.eventGameId,
      sessionBearer: harness.sessionBearer,
      actions: [retry],
    });
    expect(resumed.results[0]).toMatchObject({ status: "accepted" });
    expect(resumed.results[0]).not.toMatchObject({ reason: "storage-unavailable" });
    expect(await harness.storage.readiness()).toMatchObject({ ok: true });
  });

  test("normalizes every replay ineligibility callback outcome to bounded evidence", async () => {
    for (const input of [
      { replayReason: "game-locked", replayDetail: "sensitive-session-identifier" },
      { replayReason: "x".repeat(10_000), replayDetail: "authorization bearer secret" },
      { replayFailure: "throw" as const },
    ]) {
      const harness = await createHarness({ replay: true, ...input });
      const action = createFact(
        harness.root,
        "bounded-ineligibility-action",
        harness.sessionId,
        harness.grantVersion,
      );
      const submit = () =>
        harness.acceptance.submitBatch({
          mode: "replay",
          recordId: harness.root.recordId,
          eventGameId: harness.root.eventGameId,
          replay: {
            sessionBearer: harness.sessionBearer,
            originatingSessionId: harness.sessionId,
            replayEvidenceId: "bounded-ineligibility",
          },
          actions: [action],
        });
      const result = await submit();
      const repeated = await submit();
      expect(repeated.results[0]).toEqual(result.results[0]);
      expect(await harness.storage.readAuditEntries(harness.root.recordId)).toHaveLength(1);
      expect(result.results[0]).toEqual({
        status: "authority-expired",
        reason: "replay-ineligible",
        detail: "Replay authorization is unavailable.",
        auditId: expect.any(String),
        grantAuditId: expect.any(String),
      });
      const grants = await harness.storage.transaction((transaction) =>
        transaction.listGrantAudit(harness.grantId),
      );
      const acceptanceGrants = grants.filter((grant) => grant.action === "control-action-rejected");
      expect(acceptanceGrants).toHaveLength(1);
      expect(acceptanceGrants[0]?.outcomeDetail ?? "").not.toContain(
        "sensitive-session-identifier",
      );
      expect(acceptanceGrants[0]?.outcomeDetail ?? "").not.toContain("authorization bearer secret");
      expect(await harness.storage.readiness()).toMatchObject({ ok: true });
    }
  });

  test("reuses an unsupported replay outcome without a reservation", async () => {
    const harness = await createHarness({ replay: true });
    const action = createFact(
      harness.root,
      "unsupported-replay-action",
      harness.sessionId,
      harness.grantVersion,
    );
    action.kind = { id: "unsupported-replay-codec", version: "9" };
    const submit = () =>
      harness.acceptance.submitBatch({
        mode: "replay",
        recordId: harness.root.recordId,
        eventGameId: harness.root.eventGameId,
        replay: {
          sessionBearer: harness.sessionBearer,
          originatingSessionId: harness.sessionId,
          replayEvidenceId: "unsupported-replay",
        },
        actions: [action],
      });
    const first = await submit();
    const second = await submit();
    expect(first.results[0]).toMatchObject({ status: "rejected", reason: "invalid-action" });
    expect(second.results[0]).toEqual(first.results[0]);
    expect(await harness.storage.readAuditEntries(harness.root.recordId)).toHaveLength(1);
    const state = await harness.storage.transaction((transaction) => ({
      reservation: transaction.findReplayReservationByOriginTuple(
        harness.root.recordId,
        harness.root.eventGameId,
        harness.sessionId,
        1,
      ),
    }));
    expect(state.reservation).toBeNull();
    expect(await harness.storage.readiness()).toMatchObject({ ok: true });
  });

  test("freezes memory when rejected canonical candidate content is tampered", async () => {
    const harness = await createHarness();
    const action = {
      ...createFact(harness.root, "candidate-tamper", harness.sessionId, harness.grantVersion),
      causalPredecessorIds: ["missing-predecessor"],
    };
    const result = await harness.acceptance.submitBatch({
      recordId: harness.root.recordId,
      eventGameId: harness.root.eventGameId,
      sessionBearer: harness.sessionBearer,
      actions: [action],
    });
    expect(result.results[0]).toMatchObject({ status: "rejected", reason: "missing-dependency" });
    type MemoryInternals = {
      state: {
        controlAudits: Map<
          string,
          Map<string, import("@/lib/foundation-storage").StoredControlAuditEntry>
        >;
      };
    };
    const internals = harness.storage as unknown as MemoryInternals;
    const controls = internals.state.controlAudits.get(harness.root.recordId);
    const control = [...(controls?.values() ?? [])].find(
      (entry) => entry.links?.rejectedCandidate !== undefined,
    );
    if (control?.links?.rejectedCandidate === undefined)
      throw new Error("Expected rejection evidence.");
    controls!.set(control.auditId, {
      ...control,
      links: {
        ...control.links,
        rejectedCandidate: { ...control.links.rejectedCandidate, canonicalContent: "{}" },
      },
    });
    expect(await harness.storage.readiness()).toMatchObject({
      ok: false,
      status: "integrity-failure",
    });
  });
});

type Harness = {
  storage: FoundationStorage;
  root: EventGameRecordRoot;
  acceptance: ReturnType<typeof createFoundationAcceptance>;
  authority: GrantAuthority;
  grant: GrantAuthorityOptions;
  grantId: string;
  grantVersion: string;
  sessionId: string;
  sessionBearer: string;
  nowMs: { value: number };
};

async function createHarness(
  input: {
    locked?: boolean;
    failureBoundary?: FailureBoundary;
    limits?: FoundationAcceptanceOptions["limits"];
    replay?: boolean;
    omitReplayEligibility?: boolean;
    replayReason?: string;
    replayDetail?: unknown;
    replayFailure?: "throw";
  } = {},
): Promise<Harness> {
  const storage = createInMemoryFoundationStorage();
  const root = createRoot(input.locked === true);
  const grant = createGrantOptions(root.eventGameId);
  const authority = createLegacyControlGrantTestAuthority(storage, grant);
  const created = await authority.createControlGrant({
    scope: root.externalScope,
    actor: { kind: "fixture", id: "fixture" },
  });
  if (created.status !== "created") throw new Error("Expected a Grant.");
  const admitted = await authority.admitControlGrant({
    qrCredential: created.qrCredential,
    browserContext: "adversarial-controller",
  });
  if (admitted.status !== "admitted") throw new Error("Expected a Session.");
  const record = createEventGameRecord(storage, {
    externalScopeResolver: createScopeResolver(root),
    interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
    auditAuthorityVerifier: { verify: () => true },
  });
  const registration = await record.registerRoot(root);
  if (registration.status !== "registered")
    throw new Error(`Expected a Record: ${JSON.stringify(registration)}`);
  let lockedBatchDigest: string | undefined;
  if (input.locked === true) {
    const lockedAction = createFact(
      root,
      "locked-action",
      admitted.grantSessionId,
      created.grantVersion,
    );
    lockedBatchDigest = sha256(
      JSON.stringify({
        recordId: root.recordId,
        eventGameId: root.eventGameId,
        mode: "replay",
        replay: {
          originatingSessionId: "origin-session",
          replayEvidenceId: "trusted-lock-evidence",
        },
        actions: [lockedAction],
      }),
    );
    const reservation = {
      reservationId: "seed-locked-reservation",
      recordId: root.recordId,
      eventGameId: root.eventGameId,
      originatingSessionId: "origin-session",
      replacementSessionId: null,
      actionCount: 1,
      status: "reserved" as const,
      batchDigest: lockedBatchDigest,
      createdAtMs: 700,
      committedAtMs: null,
      acknowledgedAtMs: null,
      stateRevision: 1,
    };
    await storage.transaction((transaction) => {
      transaction.insertReplayReservation(reservation);
      transaction.insertAcceptanceIntegrityAnchor(
        anchorFor("reservation", reservation, grant.keyRing),
      );
    });
  }
  const nowMs = { value: 1_000 };
  const acceptance = createFoundationAcceptance(storage, {
    grant,
    externalScopeResolver: createScopeResolver(root),
    clock: () => nowMs.value,
    interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
    limits: input.limits,
    authorizeLockedReplay:
      input.locked === true
        ? ({ sessionBearer }) => sessionBearer === admitted.sessionBearer
        : undefined,
    failureInjector:
      input.failureBoundary === undefined
        ? undefined
        : (boundary) => {
            if (boundary === input.failureBoundary)
              throw new Error(`Injected failure at ${boundary}`);
          },
    verifyLockedReplay: ({ batchDigest }) =>
      input.locked === true && batchDigest === lockedBatchDigest,
    replayEligibility:
      input.replay === true && input.omitReplayEligibility !== true
        ? () =>
            input.replayFailure === "throw"
              ? (() => {
                  throw new Error("adapter detail must not escape");
                })()
              : input.replayReason === undefined
                ? { status: "eligible" }
                : {
                    status: "ineligible",
                    reason: input.replayReason,
                    detail: input.replayDetail ?? "Adapter supplied a replay decision.",
                  }
        : undefined,
  });
  return {
    storage,
    root,
    acceptance,
    authority,
    grant,
    grantId: created.grantId,
    grantVersion: created.grantVersion,
    sessionId: admitted.grantSessionId,
    sessionBearer: admitted.sessionBearer,
    nowMs,
  };
}

function createGrantOptions(eventGameId: string): GrantAuthorityOptions {
  let call = 0;
  return {
    environmentId: "acceptance-adversarial-test",
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

function createRoot(locked: boolean): EventGameRecordRoot {
  return {
    recordId: `record-adversarial-${locked ? "locked" : "open"}`,
    eventId: "event-adversarial",
    eventGameId: "game-adversarial",
    ownership: { eventId: "event-adversarial", eventGameId: "game-adversarial" },
    externalScope: {
      eventId: "event-adversarial",
      gameDayId: "day-1",
      pitchId: "pitch-1",
      pitchSlotId: "slot-1",
    },
    gameSides: [
      { id: "side-a", eventTeamId: "team-a", teamInterpretationRef: "team-a-v1" },
      { id: "side-b", eventTeamId: "team-b", teamInterpretationRef: "team-b-v1" },
    ],
    lifecycle: {
      phase: locked ? "finished" : "scheduled",
      commencedAtMs: locked ? 100 : null,
      finishedAtMs: locked ? 800 : null,
      lockedAtMs: locked ? 900 : null,
      lockReason: locked ? "administrative" : null,
    },
    compatibility: {
      recordVersion: "record-v1",
      schemaVersion: "schema-v1",
      interpreterVersion: "rules-v1",
    },
    creationEvidence: {
      operationId: "register-adversarial",
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

async function readAuthorityBoundaryState(harness: Harness): Promise<string> {
  const state = await harness.storage.transaction((transaction) => ({
    grant: transaction.findGrantById(harness.grantId),
    sessions: transaction.listGrantSessions(harness.grantId),
    controlAudits: transaction.listAuditEntries(harness.root.recordId),
    grantAudits: transaction.listGrantAudit(harness.grantId),
    budgets: [
      transaction.findAcceptanceBudget(`budget-online-session:${harness.sessionId}`),
      transaction.findAcceptanceBudget(`budget-online-event:${harness.root.eventGameId}`),
      transaction.findAcceptanceBudget(`budget-replay-session:${harness.sessionId}`),
    ],
    metadata: transaction.readRecordMetadata(harness.root.recordId),
  }));
  return JSON.stringify(state);
}

function guardRootReads(
  storage: FoundationStorage,
  allowedRootReads = 0,
): {
  storage: FoundationStorage;
  rootReads(): number;
} {
  let rootReadCount = 0;
  const guardedStorage = new Proxy(storage, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver);
      return <T>(work: (transaction: FoundationStorageTransaction) => T) =>
        target.transaction((transaction) =>
          work(
            new Proxy(transaction, {
              get(transactionTarget, transactionProperty, transactionReceiver) {
                if (transactionProperty === "findRootByRecordId") {
                  const rootReader = transactionTarget.findRootByRecordId.bind(transactionTarget);
                  return (recordId: string) => {
                    rootReadCount += 1;
                    if (rootReadCount <= allowedRootReads) return rootReader(recordId);
                    throw new Error("root read must remain behind authority");
                  };
                }
                return Reflect.get(transactionTarget, transactionProperty, transactionReceiver);
              },
            }),
          ),
        );
    },
  }) as FoundationStorage;
  return { storage: guardedStorage, rootReads: () => rootReadCount };
}
