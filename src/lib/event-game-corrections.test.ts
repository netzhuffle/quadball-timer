import { describe, expect, test } from "bun:test";
import { createDeterministicTestIqaInterpreter } from "@/lib/event-game-actions";
import { createEventGameRecord } from "@/lib/event-game-record";
import { DURABLE_EVIDENCE_PROVENANCE } from "@/lib/foundation-storage";
import type {
  FoundationStorage,
  FoundationStorageTransaction,
  FoundationStorageTransactionWork,
} from "@/lib/foundation-storage";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import {
  OVERLAPPING_TEAM_COMPONENT,
  acceptScenario,
  auditCredential,
  corruptMemoryAudit,
  createCorrection,
  createCorrectionActions,
  createFact,
  legacyMemoryEvidenceView,
  createRecord,
  createRoot,
  removeMemoryAudit,
  createTeamAssignmentCorrection,
  resolveActionOrder,
  snapshot,
  sortAcknowledgements,
  topologicalPermutations,
} from "@/lib/event-game-corrections.support";

describe("Event Game corrections and Official Overrides", () => {
  test("converges opposing offline Corrections and records a canonical linked conflict", async () => {
    const firstRoot = createRoot("corrections-convergence");
    const secondRoot = firstRoot;
    const first = await createRecord(firstRoot);
    const second = await createRecord(secondRoot);

    const firstFact = createFact(firstRoot, "fact-operation", 1_000, "fact-goal");
    const secondFact = createFact(secondRoot, "fact-operation", 1_000, "fact-goal");
    const firstFalse = createCorrection(firstRoot, "correction-false", false, 2_000);
    const secondFalse = createCorrection(secondRoot, "correction-false", false, 2_000);
    const firstTrue = createCorrection(firstRoot, "correction-true", true, 2_000);
    const secondTrue = createCorrection(secondRoot, "correction-true", true, 2_000);

    expect(await first.acceptAction(firstFact)).toMatchObject({ status: "accepted" });
    expect(await second.acceptAction(secondFact)).toMatchObject({ status: "accepted" });
    expect(await first.acceptAction(firstTrue)).toMatchObject({ status: "accepted" });
    expect(await first.acceptAction(firstFalse)).toMatchObject({ status: "accepted" });
    expect(await second.acceptAction(secondFalse)).toMatchObject({ status: "accepted" });
    expect(await second.acceptAction(secondTrue)).toMatchObject({ status: "accepted" });

    const firstSnapshot = await snapshot(first);
    const secondSnapshot = await snapshot(second);
    expect(secondSnapshot).toEqual(firstSnapshot);
    expect(firstSnapshot.rebuild.conflicts).toEqual([
      {
        targetFactId: "fact-goal",
        operationIds: ["correction-false", "correction-true"],
        winnerOperationId: "correction-true",
        reason: "opposing-concurrent-corrections",
      },
    ]);
    expect(firstSnapshot.rebuild.effectiveFacts.map((fact) => fact.factId)).toEqual(["fact-goal"]);
    expect(firstSnapshot.audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "action-conflict",
          outcome: "conflict-resolved",
          links: expect.objectContaining({
            targetFactId: "fact-goal",
            relatedOperationIds: ["correction-false", "correction-true"],
          }),
        }),
      ]),
    );
  });

  test("lets a later causal Correction replace the automatic concurrent outcome", async () => {
    const root = createRoot("causal-repair");
    const record = await createRecord(root);
    const fact = createFact(root, "fact-operation", 1_000, "fact-goal");
    const falseCorrection = createCorrection(root, "correction-false", false, 2_000);
    const trueCorrection = createCorrection(root, "correction-true", true, 2_000);
    const repair = createCorrection(root, "correction-repair", false, 3_000, [
      "correction-false",
      "correction-true",
    ]);

    for (const action of [fact, falseCorrection, trueCorrection, repair]) {
      expect(await record.acceptAction(action)).toMatchObject({ status: "accepted" });
    }

    const rebuild = await record.rebuild();
    expect(rebuild).toMatchObject({ status: "ready" });
    if (rebuild.status !== "ready") throw new Error("Expected a ready rebuild.");
    expect(rebuild.effectiveFacts).toHaveLength(0);
    expect(rebuild.canonicalActions.map((action) => action.operationId)).toEqual([
      "fact-operation",
      "correction-false",
      "correction-true",
      "correction-repair",
    ]);
  });

  test("never labels causally related opposing Corrections as concurrent", async () => {
    const root = createRoot("causal-not-concurrent");
    const record = await createRecord(root);
    const fact = createFact(root, "fact-operation", 1_000, "fact-goal");
    const first = createCorrection(root, "correction-first", false, 2_000);
    const second = createCorrection(root, "correction-second", true, 3_000, ["correction-first"]);
    for (const action of [fact, first, second]) {
      expect(await record.acceptAction(action)).toMatchObject({ status: "accepted" });
    }
    const rebuild = await record.rebuild();
    expect(rebuild).toMatchObject({ status: "ready", conflicts: [] });
    expect(
      (await record.readAudit(auditCredential)).some((entry) => entry.kind === "action-conflict"),
    ).toBe(false);
  });

  test("exhausts both valid arrival permutations of the three-action causal repair shape", async () => {
    const operationOrders = [
      ["correction-false", "correction-true"],
      ["correction-true", "correction-false"],
    ] as const;
    const snapshots = [];
    for (const order of operationOrders) {
      const root = createRoot("causal-permutations");
      const record = await createRecord(root);
      const fact = createFact(root, "fact-operation", 1_000, "fact-goal");
      const corrections = new Map([
        ["correction-false", createCorrection(root, "correction-false", false, 2_000)],
        ["correction-true", createCorrection(root, "correction-true", true, 2_000)],
      ]);
      const repair = createCorrection(root, "correction-repair", false, 3_000, [
        "correction-false",
        "correction-true",
      ]);
      expect(await record.acceptAction(fact)).toMatchObject({ status: "accepted" });
      for (const operationId of order) {
        expect(await record.acceptAction(corrections.get(operationId))).toMatchObject({
          status: "accepted",
        });
      }
      expect(await record.acceptAction(repair)).toMatchObject({ status: "accepted" });
      snapshots.push(await snapshot(record));
    }
    expect(snapshots[1]).toEqual(snapshots[0]);
    expect(snapshots[0]?.rebuild.conflicts).toHaveLength(1);
  });

  test("rejects duplicate stable Game Fact and Correction identities before retention", async () => {
    const root = createRoot("stable-identities");
    const record = await createRecord(root);
    const fact = createFact(root, "fact-operation", 1_000, "fact-goal");
    expect(await record.acceptAction(fact)).toMatchObject({ status: "accepted" });
    expect(
      await record.acceptAction(createFact(root, "fact-operation-duplicate", 1_001, "fact-goal")),
    ).toMatchObject({ status: "rejected", reason: "invalid-action" });

    const correction = createCorrection(root, "correction-first", false, 2_000);
    expect(await record.acceptAction(correction)).toMatchObject({ status: "accepted" });
    const correctionPayload = correction.payload as Record<string, unknown>;
    expect(
      await record.acceptAction({
        ...createCorrection(root, "correction-second", true, 2_001),
        payload: { ...correctionPayload, effective: true },
      }),
    ).toMatchObject({ status: "rejected", reason: "invalid-action" });
    expect(await record.readActions()).toHaveLength(2);
    expect(await record.rebuild()).toMatchObject({ status: "ready" });
  });

  test("retains Official Override evidence when its Game Fact is corrected and reinstated", async () => {
    const root = createRoot("override-correction");
    const record = await createRecord(root);
    const stoppage = createFact(root, "stoppage-shortened", 12_000, "fact-stoppage", {
      guardrail: "nominal-four-minute-heat-stoppage",
      direction: "head-referee-end-after-two-minutes",
      confirmation: "head-referee-confirmed",
      authorityReference: "controller-session-referee",
      gameTimeMs: 12_000,
      reason: "Head Referee directed the shortened stoppage.",
    });
    (stoppage.payload as Record<string, unknown>).factType = "heat-stoppage";
    const reverse = createCorrection(
      root,
      "stoppage-reverse",
      false,
      13_000,
      ["stoppage-shortened"],
      "fact-stoppage",
    );
    const reinstate = createCorrection(
      root,
      "stoppage-reinstate",
      true,
      14_000,
      ["stoppage-reverse"],
      "fact-stoppage",
    );
    const invalidOverride = createFact(root, "invalid-override", 15_000, "fact-invalid", {
      guardrail: "guardrail",
      direction: "head-referee-direction",
      confirmation: "confirmed",
      authorityReference: "controller-session-referee",
      gameTimeMs: 15_000,
      reason: "x".repeat(241),
    });

    expect(await record.acceptAction(stoppage)).toMatchObject({ status: "accepted" });
    expect(await record.acceptAction(reverse)).toMatchObject({ status: "accepted" });
    expect(await record.acceptAction(reinstate)).toMatchObject({ status: "accepted" });
    expect(await record.acceptAction(invalidOverride)).toMatchObject({
      status: "rejected",
      reason: "invalid-action",
    });

    const actions = await record.readActions();
    expect(actions[0]?.action.override).toEqual(stoppage.override);
    expect(actions.map((stored) => stored.action.interpretation.type)).toEqual([
      "fact",
      "correction",
      "correction",
    ]);
    const audit = await record.readAudit(auditCredential);
    const overrideAudit = audit.find((entry) => entry.operationId === "stoppage-shortened");
    expect(overrideAudit).toEqual(
      expect.objectContaining({
        provenance: expect.objectContaining({ override: stoppage.override }),
      }),
    );
    expect(audit.filter((entry) => entry.links?.targetFactId === "fact-stoppage")).toHaveLength(2);
  });

  test("converges Event Team Assignment Corrections without rewriting stable Facts or Game Sides", async () => {
    const root = createRoot("team-assignment-correction");
    const originalGameSides = structuredClone(root.gameSides);
    const first = await createRecord(root);
    const second = await createRecord(root);
    const fact = createFact(root, "fact-team-assignment", 1_000, "fact-team-assignment");
    const firstAssignment = createTeamAssignmentCorrection(
      root,
      "team-assignment-a",
      "side-a",
      "team-c",
      "interpretation-a-corrected",
      2_000,
    );
    const secondAssignment = createTeamAssignmentCorrection(
      root,
      "team-assignment-b",
      "side-a",
      "team-d",
      "interpretation-a-reinstated",
      2_000,
    );
    expect(await first.acceptAction(fact)).toMatchObject({ status: "accepted" });
    expect(await first.acceptAction(firstAssignment)).toMatchObject({ status: "accepted" });
    expect(await first.acceptAction(secondAssignment)).toMatchObject({ status: "accepted" });
    expect(await second.acceptAction(fact)).toMatchObject({ status: "accepted" });
    expect(await second.acceptAction(secondAssignment)).toMatchObject({ status: "accepted" });
    expect(await second.acceptAction(firstAssignment)).toMatchObject({ status: "accepted" });
    expect(await snapshot(second)).toEqual(await snapshot(first));
    const rebuild = await first.rebuild();
    if (rebuild.status !== "ready") throw new Error("Expected a ready rebuild.");
    expect(rebuild.effectiveTeamAssignments).toEqual([
      {
        gameSideId: "side-a",
        eventTeamId: "team-d",
        teamInterpretationRef: "interpretation-a-reinstated",
      },
      {
        gameSideId: "side-b",
        eventTeamId: "team-b",
        teamInterpretationRef: "interpretation-b",
      },
    ]);
    const actions = await first.readActions();
    expect(actions[0]?.action).toMatchObject({
      operationId: fact.operationId,
      payload: fact.payload,
      causalPredecessorIds: fact.causalPredecessorIds,
      interpretation: {
        type: "fact",
        factId: "fact-team-assignment",
        gameSideId: "side-a",
      },
    });
    expect(actions[0]?.action.interpretation).toMatchObject({
      type: "fact",
      factId: "fact-team-assignment",
    });
    expect(actions.map((stored) => stored.action.interpretation.type)).toEqual([
      "fact",
      "team-assignment-correction",
      "team-assignment-correction",
    ]);
    expect(root.gameSides).toEqual(originalGameSides);
    const audit = await first.readAudit(auditCredential);
    for (const [operationId, eventTeamId] of [
      ["team-assignment-a", "team-c"],
      ["team-assignment-b", "team-d"],
    ] as const) {
      expect(
        actions.find((stored) => stored.action.operationId === operationId)?.action.interpretation,
      ).toMatchObject({ type: "team-assignment-correction", eventTeamId });
      expect(audit.find((entry) => entry.operationId === operationId)).toEqual(
        expect.objectContaining({
          kind: "action-accepted",
          links: expect.objectContaining({
            actionId: expect.stringContaining("action-"),
            targetFactId: null,
          }),
          provenance: expect.objectContaining({ grant: expect.any(Object) }),
        }),
      );
    }
  });

  test("rejects invalid corrected Event Team identities", async () => {
    const root = createRoot("invalid-team-assignment-correction");
    const record = await createRecord(root);
    for (const eventTeamId of ["", "équipe-c"]) {
      expect(
        await record.acceptAction(
          createTeamAssignmentCorrection(
            root,
            `team-assignment-${eventTeamId.length}`,
            "side-a",
            eventTeamId,
            "interpretation-a-corrected",
            2_000,
          ),
        ),
      ).toMatchObject({ status: "rejected", reason: "invalid-action" });
    }
    expect(await record.readActions()).toHaveLength(0);
  });

  test("converges opposite-side same-team assignments with a canonical conflict outcome", async () => {
    const root = createRoot("distinct-effective-teams");
    const left = await createRecord(root);
    const right = await createRecord(root);
    const assignmentA = createTeamAssignmentCorrection(
      root,
      "team-assignment-a",
      "side-a",
      "team-c",
      "interpretation-a-colliding",
      2_000,
    );
    const assignmentB = createTeamAssignmentCorrection(
      root,
      "team-assignment-b",
      "side-b",
      "team-c",
      "interpretation-b-colliding",
      2_000,
    );
    const leftAcks = await acceptScenario(left, [assignmentA, assignmentB]);
    const rightAcks = await acceptScenario(right, [assignmentB, assignmentA]);
    expect(sortAcknowledgements(leftAcks)).toEqual(sortAcknowledgements(rightAcks));
    expect(await snapshot(left)).toEqual(await snapshot(right));
    const rebuild = await left.rebuild();
    if (rebuild.status !== "ready") throw new Error("Expected a ready rebuild.");
    expect(rebuild.effectiveTeamAssignments).toEqual([
      { gameSideId: "side-a", eventTeamId: "team-a", teamInterpretationRef: "interpretation-a" },
      {
        gameSideId: "side-b",
        eventTeamId: "team-c",
        teamInterpretationRef: "interpretation-b-colliding",
      },
    ]);
    expect(rebuild.conflicts).toEqual([
      expect.objectContaining({
        reason: "opposing-concurrent-team-assignments",
        eventTeamId: "team-c",
        winnerOperationId: "team-assignment-b",
      }),
    ]);
  });

  test("converges every arrival permutation of an overlapping team-conflict component", async () => {
    const specs = OVERLAPPING_TEAM_COMPONENT;
    const permutations = topologicalPermutations(specs);
    expect(permutations).toHaveLength(6);
    let expectedAcknowledgements: unknown[] | undefined;
    let expectedSnapshot: Awaited<ReturnType<typeof snapshot>> | undefined;
    for (const permutation of permutations) {
      const root = createRoot("overlapping-team-component");
      const record = await createRecord(root);
      const actions = createCorrectionActions(root, specs);
      const acknowledgements = await acceptScenario(
        record,
        resolveActionOrder(actions, permutation),
      );
      const actualSnapshot = await snapshot(record);
      if (expectedSnapshot === undefined || expectedAcknowledgements === undefined) {
        expectedSnapshot = actualSnapshot;
        expectedAcknowledgements = sortAcknowledgements(acknowledgements);
      } else {
        expect(sortAcknowledgements(acknowledgements)).toEqual(expectedAcknowledgements);
        expect(actualSnapshot).toEqual(expectedSnapshot);
      }
    }
    expect(expectedSnapshot?.rebuild.effectiveTeamAssignments).toEqual([
      {
        gameSideId: "side-a",
        eventTeamId: "team-c",
        teamInterpretationRef: "interpretation-a-c-2",
      },
      { gameSideId: "side-b", eventTeamId: "team-b", teamInterpretationRef: "interpretation-b" },
    ]);
    expect(expectedSnapshot?.rebuild.conflicts).toHaveLength(2);
  });

  test("rejects a standalone correction that would make the effective sides share a team", async () => {
    const root = createRoot("standalone-team-collision");
    const record = await createRecord(root);
    expect(
      await record.acceptAction(
        createTeamAssignmentCorrection(
          root,
          "standalone-team-collision-action",
          "side-a",
          "team-b",
          "interpretation-a-b",
          2_000,
        ),
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-action" });
    expect(await record.readActions()).toHaveLength(0);
    expect(await record.rebuild()).toMatchObject({ status: "ready" });
  });

  test("derives team distinctness from the current canonical assignment history", async () => {
    const root = createRoot("team-assignment-history");
    const record = await createRecord(root);
    const moveSideB = createTeamAssignmentCorrection(
      root,
      "team-assignment-b-to-d",
      "side-b",
      "team-d",
      "interpretation-b-d",
      2_000,
    );
    const reuseFreedTeam = createTeamAssignmentCorrection(
      root,
      "team-assignment-a-to-b",
      "side-a",
      "team-b",
      "interpretation-a-b",
      3_000,
      ["team-assignment-b-to-d"],
    );
    expect(await record.acceptAction(moveSideB)).toMatchObject({ status: "accepted" });
    expect(await record.acceptAction(reuseFreedTeam)).toMatchObject({ status: "accepted" });
    const rebuild = await record.rebuild();
    expect(rebuild).toMatchObject({ status: "ready" });
    if (rebuild.status !== "ready") throw new Error("Expected a ready rebuild.");
    expect(rebuild.effectiveTeamAssignments).toEqual([
      {
        gameSideId: "side-a",
        eventTeamId: "team-b",
        teamInterpretationRef: "interpretation-a-b",
      },
      {
        gameSideId: "side-b",
        eventTeamId: "team-d",
        teamInterpretationRef: "interpretation-b-d",
      },
    ]);
  });

  test("rejects a causal duplicate team assignment without poisoning retained history", async () => {
    const root = createRoot("causal-team-assignment-duplicate");
    const record = await createRecord(root);
    const first = createTeamAssignmentCorrection(
      root,
      "team-assignment-a-to-c",
      "side-a",
      "team-c",
      "interpretation-a-c",
      2_000,
    );
    const duplicate = createTeamAssignmentCorrection(
      root,
      "team-assignment-b-to-c",
      "side-b",
      "team-c",
      "interpretation-b-c",
      3_000,
      ["team-assignment-a-to-c"],
    );
    expect(await record.acceptAction(first)).toMatchObject({ status: "accepted" });
    expect(await record.acceptAction(duplicate)).toMatchObject({
      status: "rejected",
      reason: "invalid-action",
    });
    expect((await record.readActions()).map((stored) => stored.action.operationId)).toEqual([
      "team-assignment-a-to-c",
    ]);
    expect(await record.rebuild()).toMatchObject({ status: "ready" });
    expect(await record.readiness()).toMatchObject({ ok: true });
  });

  test("rejects out-of-scope Event Team corrections without partial retention and retries stably", async () => {
    const root = createRoot("out-of-scope-team");
    let resolveCalls = 0;
    const record = createEventGameRecord(createInMemoryFoundationStorage(), {
      externalScopeResolver: {
        resolve(scope) {
          return { status: "resolved", scope: structuredClone(scope) };
        },
        resolveEventTeam(eventId, eventTeamId) {
          resolveCalls += 1;
          return eventId === root.eventId && eventTeamId === "team-c"
            ? { status: "resolved" }
            : { status: "mismatch", detail: "The Event Team is outside the Event scope." };
        },
      },
      interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      auditAuthorityVerifier: { verify: (candidate) => candidate === auditCredential },
    });
    expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
    const invalid = createTeamAssignmentCorrection(
      root,
      "out-of-scope",
      "side-a",
      "team-z",
      "x",
      2_000,
    );
    expect(await record.acceptAction(invalid)).toMatchObject({
      status: "rejected",
      reason: "invalid-action",
    });
    expect(await record.acceptAction(invalid)).toMatchObject({
      status: "rejected",
      reason: "invalid-action",
    });
    expect(resolveCalls).toBe(2);
    expect(await record.readActions()).toHaveLength(0);
    expect(await record.rebuild()).toMatchObject({ status: "ready" });
  });

  test("converges action acknowledgements and audit timestamps under nonconstant arrival clocks", async () => {
    const root = createRoot("canonical-arrival-times");
    const firstClock = [90_000, 10_000, 80_000, 20_000];
    const secondClock = [11_000, 99_000, 12_000, 98_000];
    const first = await createRecord(root, undefined, () => firstClock.shift() ?? 0);
    const second = await createRecord(root, undefined, () => secondClock.shift() ?? 0);
    const fact = createFact(root, "fact-canonical-time", 1_000, "fact-goal");
    const falseCorrection = createCorrection(root, "correction-canonical-false", false, 2_000);
    const trueCorrection = createCorrection(root, "correction-canonical-true", true, 2_000);

    const firstAcks = await acceptScenario(first, [fact, falseCorrection, trueCorrection]);
    const secondAcks = await acceptScenario(second, [fact, trueCorrection, falseCorrection]);
    expect(sortAcknowledgements(secondAcks)).toEqual(sortAcknowledgements(firstAcks));
    expect(await snapshot(second)).toEqual(await snapshot(first));
    expect(
      (await first.readActions()).map(({ action }) => [action.operationId, action.acceptedAtMs]),
    ).toEqual([
      ["fact-canonical-time", 90_000],
      ["correction-canonical-false", 10_000],
      ["correction-canonical-true", 80_000],
    ]);
    expect(
      (await second.readActions()).map(({ action }) => [action.operationId, action.acceptedAtMs]),
    ).toEqual([
      ["fact-canonical-time", 11_000],
      ["correction-canonical-true", 99_000],
      ["correction-canonical-false", 12_000],
    ]);
    expect(
      (await first.readAudit(auditCredential))
        .filter((entry) => entry.kind === "action-accepted")
        .map((entry) => [entry.operationId, entry.createdAtMs]),
    ).toEqual([
      ["fact-canonical-time", 90_000],
      ["correction-canonical-false", 10_000],
      ["correction-canonical-true", 80_000],
    ]);
    expect(
      (await first.readAudit(auditCredential)).find(
        (entry) => entry.outcome === "conflict-resolved",
      )?.createdAtMs,
    ).toBe(80_000);
    expect(
      (await second.readAudit(auditCredential)).find(
        (entry) => entry.outcome === "conflict-resolved",
      )?.createdAtMs,
    ).toBe(12_000);
  });

  test("fails memory readiness when collision linkage is retargeted", async () => {
    const root = createRoot("memory-collision-linkage");
    const baseStorage = createInMemoryFoundationStorage();
    const storage = corruptMemoryAudit(baseStorage, (entry) => {
      if (entry.kind !== "action-conflict" || entry.links?.collision === undefined) return;
      if (entry.links.ordering !== null) entry.links.ordering.operationId = "retargeted-order";
    });
    const record = createEventGameRecord(storage, {
      externalScopeResolver: {
        resolve(scope) {
          return { status: "resolved", scope: structuredClone(scope) };
        },
        resolveEventTeam(eventId, eventTeamId) {
          return eventId === root.eventId && eventTeamId.length > 0
            ? { status: "resolved" }
            : { status: "mismatch", detail: "The Event Team is outside the Event scope." };
        },
      },
      clock: () => 10_000,
      interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      auditAuthorityVerifier: { verify: (candidate) => candidate === auditCredential },
    });
    expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
    const accepted = createFact(root, "memory-collision", 1_000, "fact-memory-collision");
    expect(await record.acceptAction(accepted)).toMatchObject({ status: "accepted" });
    expect(
      await record.acceptAction({
        ...accepted,
        payload: { ...(accepted.payload as Record<string, unknown>), data: { rejected: true } },
      }),
    ).toMatchObject({ status: "rejected", reason: "operation-conflict" });
    expect(await record.readiness()).toMatchObject({ ok: false, status: "rebuild-failure" });
  });

  test("fails memory readiness when current action and audit evidence is jointly downgraded", async () => {
    const root = createRoot("memory-evidence-downgrade");
    const baseStorage = createInMemoryFoundationStorage();
    const storage: FoundationStorage = {
      transaction<T>(work: FoundationStorageTransactionWork<T>) {
        return baseStorage.transaction((transaction) =>
          work({
            ...transaction,
            listActions(recordId) {
              const actions = transaction.listActions(recordId);
              for (const stored of actions) {
                stored.action.controlActionVersion = "control-action-legacy-v0";
                stored.durableFormat = "legacy";
              }
              return actions;
            },
            listAuditEntries(recordId) {
              const entries = transaction.listAuditEntries(recordId);
              for (const entry of entries) {
                entry.auditVersion = "control-audit-legacy-v0";
                entry.durableFormat = "legacy";
                delete entry.links;
                delete entry.provenance;
              }
              return entries;
            },
          } satisfies FoundationStorageTransaction),
        );
      },
      readRoot: (recordId) => baseStorage.readRoot(recordId),
      readActions: async (recordId) => {
        const actions = await baseStorage.readActions(recordId);
        for (const stored of actions) {
          stored.action.controlActionVersion = "control-action-legacy-v0";
          stored.durableFormat = "legacy";
        }
        return actions;
      },
      readIdempotencyEntries: (recordId) => baseStorage.readIdempotencyEntries(recordId),
      readRecordMetadata: (recordId) => baseStorage.readRecordMetadata(recordId),
      readAuditEntries: async (recordId) => {
        const entries = await baseStorage.readAuditEntries(recordId);
        for (const entry of entries) {
          entry.auditVersion = "control-audit-legacy-v0";
          entry.durableFormat = "legacy";
          delete entry.links;
          delete entry.provenance;
        }
        return entries;
      },
      readiness: () => baseStorage.readiness(),
      close: () => baseStorage.close(),
    };
    const record = createEventGameRecord(storage, {
      externalScopeResolver: {
        resolve(scope) {
          return { status: "resolved", scope: structuredClone(scope) };
        },
        resolveEventTeam() {
          return { status: "resolved" };
        },
      },
      interpreter: createDeterministicTestIqaInterpreter("rules-v1"),
      auditAuthorityVerifier: { verify: (candidate) => candidate === auditCredential },
    });
    expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
    expect(
      await record.acceptAction(createFact(root, "memory-downgrade", 1_000, "fact")),
    ).toMatchObject({ status: "accepted" });
    expect(await record.readiness()).toMatchObject({ ok: false, status: "rebuild-failure" });
  });

  test("freezes memory writes when the canonical Correction conflict audit is deleted", async () => {
    const root = createRoot("memory-missing-correction-conflict");
    const storage = removeMemoryAudit(
      createInMemoryFoundationStorage(),
      (entry) =>
        entry.kind === "action-conflict" &&
        entry.outcome === "conflict-resolved" &&
        entry.redactedDetail.startsWith("Opposing Concurrent Corrections resolved"),
    );
    const record = await createRecord(root, undefined, () => 10_000, storage);
    expect(await record.acceptAction(createFact(root, "fact", 1_000, "fact-goal"))).toMatchObject({
      status: "accepted",
    });
    for (const action of [
      createCorrection(root, "correction-false", false, 2_000),
      createCorrection(root, "correction-true", true, 2_000),
    ]) {
      expect(await record.acceptAction(action)).toMatchObject({ status: "accepted" });
    }
    expect(await record.readiness()).toMatchObject({
      ok: false,
      status: "rebuild-failure",
      detail: "Control Audit Trail is missing canonical conflict evidence.",
    });
    const reopened = await createRecord(root, undefined, () => 10_000, storage);
    expect(
      await reopened.acceptAction(createFact(root, "after-missing-conflict", 3_000, "after-fact")),
    ).toMatchObject({ status: "rejected", reason: "storage-not-ready" });
  });

  test("freezes memory writes when the canonical team-assignment conflict audit is deleted", async () => {
    const root = createRoot("memory-missing-team-conflict");
    const storage = removeMemoryAudit(
      createInMemoryFoundationStorage(),
      (entry) =>
        entry.kind === "action-conflict" &&
        entry.outcome === "conflict-resolved" &&
        entry.redactedDetail.startsWith("Opposing Concurrent Team Assignments resolved"),
    );
    const record = await createRecord(root, undefined, () => 10_000, storage);
    for (const action of [
      createTeamAssignmentCorrection(
        root,
        "team-assignment-a",
        "side-a",
        "team-c",
        "interpretation-a-c",
        1_000,
      ),
      createTeamAssignmentCorrection(
        root,
        "team-assignment-b",
        "side-b",
        "team-c",
        "interpretation-b-c",
        1_000,
      ),
    ]) {
      expect(await record.acceptAction(action)).toMatchObject({ status: "accepted" });
    }
    expect(await record.readiness()).toMatchObject({
      ok: false,
      status: "rebuild-failure",
      detail: "Control Audit Trail is missing canonical conflict evidence.",
    });
    const reopened = await createRecord(root, undefined, () => 10_000, storage);
    expect(
      await reopened.acceptAction(
        createFact(root, "after-missing-team-conflict", 2_000, "after-fact"),
      ),
    ).toMatchObject({ status: "rejected", reason: "storage-not-ready" });
  });

  test("keeps a genuine legacy opposing pair ready after an unrelated current Fact", async () => {
    const root = createRoot("memory-legacy-conflict-unrelated-current");
    const baseStorage = createInMemoryFoundationStorage();
    const seeded = await createRecord(root, undefined, () => 10_000, baseStorage);
    for (const action of [
      createFact(root, "fact", 1_000, "fact-goal"),
      createCorrection(root, "correction-false", false, 2_000),
      createCorrection(root, "correction-true", true, 2_000),
    ]) {
      expect(await seeded.acceptAction(action)).toMatchObject({ status: "accepted" });
    }
    const legacyView = legacyMemoryEvidenceView(
      baseStorage,
      new Set(["fact", "correction-false", "correction-true"]),
    );
    const migrated = await createRecord(root, undefined, () => 10_000, legacyView);
    expect(await migrated.readiness()).toMatchObject({ ok: true, actionCount: 3 });
    expect(
      await migrated.acceptAction(createFact(root, "current-unrelated", 3_000, "fact-current")),
    ).toMatchObject({ status: "accepted" });
    expect(await migrated.readiness()).toMatchObject({ ok: true, actionCount: 4 });
    expect(
      await migrated.acceptAction(createFact(root, "current-after-legacy", 4_000, "fact-after")),
    ).toMatchObject({
      status: "accepted",
    });
  });

  test("requires and freezes on missing evidence for a current participant in legacy conflict history", async () => {
    const root = createRoot("memory-legacy-conflict-current-participant");
    const baseStorage = createInMemoryFoundationStorage();
    const seeded = await createRecord(root, undefined, () => 10_000, baseStorage);
    for (const action of [
      createFact(root, "fact", 1_000, "fact-goal"),
      createCorrection(root, "correction-false", false, 2_000),
      createCorrection(root, "correction-true", true, 2_000),
    ]) {
      expect(await seeded.acceptAction(action)).toMatchObject({ status: "accepted" });
    }
    const legacyView = legacyMemoryEvidenceView(
      baseStorage,
      new Set(["fact", "correction-false", "correction-true"]),
    );
    const migrated = await createRecord(root, undefined, () => 10_000, legacyView);
    expect(
      await migrated.acceptAction(createCorrection(root, "correction-z-current", false, 3_000)),
    ).toMatchObject({ status: "accepted" });
    expect(await migrated.readiness()).toMatchObject({ ok: true, actionCount: 4 });

    const deleted = removeMemoryAudit(
      legacyView,
      (entry) =>
        entry[DURABLE_EVIDENCE_PROVENANCE] === "current" &&
        entry.kind === "action-conflict" &&
        entry.outcome === "conflict-resolved",
    );
    const reopened = await createRecord(root, undefined, () => 10_000, deleted);
    expect(await reopened.readiness()).toMatchObject({
      ok: false,
      status: "rebuild-failure",
      detail: "Control Audit Trail is missing canonical conflict evidence.",
    });
    expect(
      await reopened.acceptAction(createFact(root, "current-after-delete", 4_000, "fact-after")),
    ).toMatchObject({ status: "rejected", reason: "storage-not-ready" });
  });
});
