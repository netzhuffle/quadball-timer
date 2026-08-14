import { describe, expect, test } from "bun:test";
import {
  REGISTERED_CORRECTION_SHAPES,
  acceptScenario,
  corruptMemoryAudit,
  createFact,
  createRecord,
  createRoot,
  createCorrectionActions,
  minimizeFailingSequence,
  observePermutation,
  randomInt,
  resolveActionOrder,
  seededRandom,
  snapshot,
  sortAcknowledgements,
  topologicalPermutations,
  type CorrectionSpec,
  type ScenarioFailure,
} from "@/lib/event-game-corrections.support";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";

describe("Generated Event Game correction convergence", () => {
  test("enumerates every registered noncommutative pair and causal-shape permutation", async () => {
    for (const [shapeIndex, shape] of REGISTERED_CORRECTION_SHAPES.entries()) {
      const permutations = topologicalPermutations(shape.actions);
      for (const [permutationIndex, permutation] of permutations.entries()) {
        const root = createRoot(`permutation-${shapeIndex}-${permutationIndex}`);
        const left = await createRecord(root);
        const right = await createRecord(root);
        const fact = createFact(root, "fact-permutation", 1_000, "fact-goal");
        const actions = createCorrectionActions(root, shape.actions);
        const leftOrder = actions;
        const rightOrder = resolveActionOrder(actions, permutation);
        const leftAcks = await acceptScenario(left, [fact, ...leftOrder]);
        const rightAcks = await acceptScenario(right, [fact, ...rightOrder]);
        expect(sortAcknowledgements(rightAcks)).toEqual(sortAcknowledgements(leftAcks));
        expect(await snapshot(right)).toEqual(await snapshot(left));
      }
    }
  });

  test("covers 1,000 fixed-seed multi-controller sequences with deterministic shrinking", async () => {
    const seed = 0x75c0ffee;
    const random = seededRandom(seed);
    for (let sequence = 0; sequence < 1_000; sequence += 1) {
      const shape =
        REGISTERED_CORRECTION_SHAPES[randomInt(random, REGISTERED_CORRECTION_SHAPES.length)];
      if (shape === undefined) throw new Error(`seed=${seed} sequence=${sequence}`);
      const permutations = topologicalPermutations(shape.actions);
      const selected = permutations[randomInt(random, permutations.length)];
      if (selected === undefined) throw new Error(`seed=${seed} sequence=${sequence}`);
      const root = createRoot(`generated-${sequence}`);
      const actions = createCorrectionActions(root, shape.actions);
      const failure = await observePermutation(root, actions, selected);
      if (failure !== null) {
        const minimized = await minimizeFailingSequence(
          shape.actions,
          selected,
          async (candidate, candidatePermutation) => {
            const candidateRoot = createRoot(`shrink-${sequence}`);
            const candidateActions = createCorrectionActions(candidateRoot, candidate);
            return observePermutation(candidateRoot, candidateActions, candidatePermutation);
          },
          seed,
        );
        const minimizedFailure = minimized.failure ?? failure;
        throw new Error(
          `seed=${minimized.seed} sequence=${sequence} shape=${shape.name} failure=${minimizedFailure.kind} minimized=${JSON.stringify(
            minimized.sequence.map((action) => action.operationId),
          )} arrivalOrder=${JSON.stringify(minimized.arrivalOrder)}: ${minimizedFailure.detail}`,
        );
      }
    }
  }, 30_000);

  test("shrinking preserves the failing arrival relationship while removing irrelevant actions", async () => {
    const sequence = [
      { operationId: "first", effective: false, causalPredecessorIds: [] },
      { operationId: "second", effective: true, causalPredecessorIds: [] },
      { operationId: "irrelevant", effective: false, causalPredecessorIds: [] },
    ] satisfies readonly CorrectionSpec[];
    const failingPermutation = ["second", "first", "irrelevant"];
    const minimized = await minimizeFailingSequence(
      sequence,
      failingPermutation,
      async (candidate, candidatePermutation) =>
        candidate.length >= 2 && candidatePermutation.slice(0, 2).join(",") === "second,first"
          ? {
              kind: "boolean-mismatch",
              run: "comparison",
              arrivalOrder: candidatePermutation,
              fingerprint: "boolean-mismatch:second-before-first",
              requiredOperationIds: ["first", "second"],
              requiredEdges: [],
              detail: "Second arrived before first.",
            }
          : null,
    );
    expect(minimized.sequence.map((action) => action.operationId)).toEqual(["first", "second"]);
    expect(minimized.arrivalOrder).toEqual(["second", "first"]);
  });

  test("real observer attributes left and right readiness failures to their actual run order", async () => {
    const specs = [
      { operationId: "first", effective: false, causalPredecessorIds: [] },
      { operationId: "second", effective: true, causalPredecessorIds: [] },
    ] satisfies readonly CorrectionSpec[];
    const root = createRoot("observer-readiness-runs");
    const actions = createCorrectionActions(root, specs);
    const rightOrder = ["second", "first"];
    for (const failingRun of ["left", "right"] as const) {
      const failure = await observePermutation(root, actions, rightOrder, {
        async snapshotRecord(record, run) {
          if (run === failingRun) throw new Error(`${run} readiness failure`);
          return snapshot(record);
        },
      });
      expect(failure).toMatchObject({
        kind: "readiness-failure",
        run: failingRun,
        arrivalOrder: failingRun === "left" ? ["first", "second"] : rightOrder,
        fingerprint: `readiness:${failingRun}:Error:${failingRun} readiness failure`,
      });
    }
  });

  test("real rebuild failures retain reason, detail, identity, and causal closure while shrinking", async () => {
    const specs = [
      { operationId: "predecessor", effective: false, causalPredecessorIds: [] },
      { operationId: "first", effective: true, causalPredecessorIds: ["predecessor"] },
    ] satisfies readonly CorrectionSpec[];
    const observe = async (
      candidate: readonly CorrectionSpec[],
      candidateOrder: readonly string[],
    ) => {
      const root = createRoot("observer-real-readiness");
      const actions = createCorrectionActions(root, candidate);
      return observePermutation(root, actions, candidateOrder, {
        recordFactory(candidateRoot, run) {
          if (run !== "right") return createRecord(candidateRoot);
          const corrupted = corruptMemoryAudit(
            createInMemoryFoundationStorage(),
            (entry) => {
              if (entry.kind === "action-accepted" && entry.operationId === "first") {
                entry.redactedDetail = "different readiness defect";
              }
            },
            false,
          );
          return createRecord(candidateRoot, undefined, undefined, corrupted);
        },
      });
    };
    const initial = await observe(specs, ["predecessor", "first"]);
    expect(initial).toMatchObject({
      kind: "readiness-failure",
      run: "right",
      reason: "invalid-history",
      detail: "Control Audit Trail accepted-action evidence is inconsistent.",
      requiredOperationIds: ["predecessor", "first"],
      requiredEdges: [["predecessor", "first"]],
    });
    expect(initial?.fingerprint).toContain(
      'readiness:right:invalid-history:"Control Audit Trail accepted-action evidence is inconsistent."',
    );
    const minimized = await minimizeFailingSequence(
      specs,
      ["predecessor", "first"],
      observe,
      0x75c0ffee,
    );
    expect(minimized.sequence.map((action) => action.operationId)).toEqual([
      "predecessor",
      "first",
    ]);
    expect(minimized.failure?.fingerprint).toBe(initial?.fingerprint);
  });

  test("real observer shrinks an exact acknowledgement diff and rejects another operation's diff", async () => {
    const specs = [
      { operationId: "predecessor", effective: false, causalPredecessorIds: [] },
      { operationId: "first", effective: true, causalPredecessorIds: ["predecessor"] },
      { operationId: "second", effective: true, causalPredecessorIds: [] },
      { operationId: "irrelevant", effective: false, causalPredecessorIds: [] },
    ] satisfies readonly CorrectionSpec[];
    const rightOrder = ["predecessor", "second", "first", "irrelevant"];
    const observe = async (
      candidate: readonly CorrectionSpec[],
      candidateOrder: readonly string[],
    ) => {
      const root = createRoot("observer-ack-diff");
      const actions = createCorrectionActions(root, candidate);
      return observePermutation(root, actions, candidateOrder, {
        transformAcknowledgement(acknowledgement, action, run) {
          if (run !== "right") return acknowledgement;
          const changedAuditId =
            action.operationId === "first"
              ? "audit-first-difference"
              : action.operationId === "second"
                ? "audit-second-difference"
                : undefined;
          return changedAuditId === undefined ||
            typeof acknowledgement !== "object" ||
            acknowledgement === null
            ? acknowledgement
            : { ...acknowledgement, auditId: changedAuditId };
        },
      });
    };
    const initial = await observe(specs, rightOrder);
    expect(initial).toMatchObject({
      kind: "boolean-mismatch",
      run: "comparison",
      requiredOperationIds: ["predecessor", "first"],
    });
    expect(initial?.fingerprint).toContain("acknowledgements:$.auditId");
    const minimized = await minimizeFailingSequence(specs, rightOrder, observe, 0x75c0ffee);
    expect(minimized.sequence.map((action) => action.operationId)).toEqual([
      "predecessor",
      "first",
    ]);
    expect(minimized.arrivalOrder).toEqual(["predecessor", "first"]);
    expect(minimized.failure?.fingerprint).toBe(initial?.fingerprint);
  });

  test("real observer fingerprints the precise snapshot field and removes unrelated actions", async () => {
    const specs = [
      { operationId: "irrelevant", effective: true, causalPredecessorIds: [] },
      { operationId: "first", effective: false, causalPredecessorIds: [] },
    ] satisfies readonly CorrectionSpec[];
    const rightOrder = ["first", "irrelevant"];
    const observe = async (
      candidate: readonly CorrectionSpec[],
      candidateOrder: readonly string[],
    ) => {
      const root = createRoot(`observer-snapshot-${candidate.length}`);
      const actions = createCorrectionActions(root, candidate);
      return observePermutation(root, actions, candidateOrder, {
        async snapshotRecord(record, run) {
          const observed = await snapshot(record);
          if (run !== "right") return observed;
          const changed = structuredClone(observed);
          const entry = changed.audit.find((audit) => audit.operationId === "first");
          if (entry !== undefined) entry.redactedDetail = "precise changed detail";
          return changed;
        },
      });
    };
    const initial = await observe(specs, rightOrder);
    expect(initial).toMatchObject({
      kind: "boolean-mismatch",
      requiredOperationIds: ["first"],
    });
    expect(initial?.fingerprint).toContain("snapshot:$.audit[operationId=first]");
    expect(initial?.fingerprint).toContain("redactedDetail");
    const minimized = await minimizeFailingSequence(specs, rightOrder, observe);
    expect(minimized.sequence.map((action) => action.operationId)).toEqual(["first"]);
    expect(minimized.arrivalOrder).toEqual(["first"]);
    expect(minimized.failure?.fingerprint).toBe(initial?.fingerprint);
  });

  test("shrinks and emits each deterministic failure class with the actual arrival relation", async () => {
    const sequence = [
      { operationId: "first", effective: false, causalPredecessorIds: [] },
      { operationId: "second", effective: true, causalPredecessorIds: [] },
      { operationId: "irrelevant", effective: false, causalPredecessorIds: [] },
    ] satisfies readonly CorrectionSpec[];
    const arrivalOrder = ["second", "first", "irrelevant"];
    for (const kind of [
      "boolean-mismatch",
      "rejected-action",
      "thrown",
      "readiness-failure",
    ] as const) {
      const minimized = await minimizeFailingSequence(
        sequence,
        arrivalOrder,
        async (candidate, candidatePermutation) =>
          candidate.length >= 2 && candidatePermutation.slice(0, 2).join(",") === "second,first"
            ? {
                kind,
                run: "right",
                arrivalOrder: candidatePermutation,
                fingerprint: `${kind}:second:first`,
                requiredOperationIds: ["second", "first"],
                requiredEdges: [],
                detail: kind,
              }
            : null,
        0x75c0ffee,
      );
      expect(minimized.seed).toBe(0x75c0ffee);
      expect(minimized.failure?.kind).toBe(kind);
      expect(minimized.sequence.map((action) => action.operationId)).toEqual(["first", "second"]);
      expect(minimized.arrivalOrder).toEqual(["second", "first"]);
      expect(
        `seed=${minimized.seed} minimized=${JSON.stringify(minimized.sequence.map((action) => action.operationId))} arrivalOrder=${JSON.stringify(minimized.arrivalOrder)}`,
      ).toContain('arrivalOrder=["second","first"]');
    }
  });

  test("shrinker preserves the failing comparison run and exact failure relationship", async () => {
    const sequence = [
      { operationId: "predecessor", effective: false, causalPredecessorIds: [] },
      { operationId: "first", effective: false, causalPredecessorIds: ["predecessor"] },
      { operationId: "second", effective: true, causalPredecessorIds: [] },
      { operationId: "irrelevant", effective: false, causalPredecessorIds: [] },
    ] satisfies readonly CorrectionSpec[];
    const rightOrder = ["second", "predecessor", "first", "irrelevant"];
    const minimized = await minimizeFailingSequence(
      sequence,
      rightOrder,
      async (candidate, candidatePermutation) =>
        candidate.some((action) => action.operationId === "first")
          ? {
              kind: "rejected-action",
              run: "right",
              arrivalOrder: candidatePermutation,
              fingerprint: "rejected:first:invalid-action",
              requiredOperationIds: ["first", "predecessor"],
              requiredEdges: [["predecessor", "first"]],
              detail: "right-run rejection",
            }
          : null,
    );
    expect(minimized.sequence.map((action) => action.operationId)).toEqual([
      "predecessor",
      "first",
    ]);
    expect(minimized.arrivalOrder).toEqual(["predecessor", "first"]);
    expect(minimized.failure).toMatchObject({
      run: "right",
      fingerprint: "rejected:first:invalid-action",
      requiredEdges: [["predecessor", "first"]],
    });
  });

  test("shrinker emits the actual left comparison run when that run fails", async () => {
    const sequence = [
      { operationId: "first", effective: false, causalPredecessorIds: [] },
      { operationId: "second", effective: true, causalPredecessorIds: [] },
      { operationId: "irrelevant", effective: false, causalPredecessorIds: [] },
    ] satisfies readonly CorrectionSpec[];
    const minimized = await minimizeFailingSequence(
      sequence,
      ["second", "first", "irrelevant"],
      async (candidate, _candidatePermutation) =>
        candidate.length >= 2
          ? {
              kind: "thrown",
              run: "left",
              arrivalOrder: candidate.map((action) => action.operationId),
              fingerprint: "thrown:first:Error:synthetic",
              requiredOperationIds: ["first", "second"],
              requiredEdges: [],
              detail: "left-run throw",
            }
          : null,
    );
    expect(minimized.sequence.map((action) => action.operationId)).toEqual(["first", "second"]);
    expect(minimized.arrivalOrder).toEqual(["first", "second"]);
    expect(minimized.failure).toMatchObject({
      run: "left",
      fingerprint: "thrown:first:Error:synthetic",
    });
  });

  test("shrinker retains thrown outcomes instead of treating them as non-failures", async () => {
    const sequence = [
      { operationId: "first", effective: false, causalPredecessorIds: [] },
      { operationId: "second", effective: true, causalPredecessorIds: [] },
      { operationId: "irrelevant", effective: false, causalPredecessorIds: [] },
    ] satisfies readonly CorrectionSpec[];
    const minimized = await minimizeFailingSequence(
      sequence,
      ["second", "first", "irrelevant"],
      async (candidate, _candidatePermutation) => {
        if (candidate.length >= 2) throw new Error("synthetic acceptance failure");
        return null;
      },
      0x75c0ffee,
    );
    expect(minimized.seed).toBe(0x75c0ffee);
    expect(minimized.sequence.map((action) => action.operationId)).toEqual([
      "second",
      "irrelevant",
    ]);
    expect(minimized.arrivalOrder).toEqual(["second", "irrelevant"]);
    expect(minimized.failure).toMatchObject({
      kind: "thrown",
      fingerprint: "thrown:shrink:Error:synthetic acceptance failure",
    });
  });

  test("does not confuse same-kind failures or removed predecessors while shrinking", async () => {
    const sequence = [
      { operationId: "predecessor", effective: false, causalPredecessorIds: [] },
      { operationId: "first", effective: false, causalPredecessorIds: ["predecessor"] },
      { operationId: "second", effective: true, causalPredecessorIds: [] },
    ] satisfies readonly CorrectionSpec[];
    const failingOrder = ["second", "predecessor", "first"];
    const minimized = await minimizeFailingSequence(
      sequence,
      failingOrder,
      async (candidate, candidatePermutation) => {
        const ids = new Set(candidate.map((action) => action.operationId));
        if (ids.has("first") && ids.has("predecessor")) {
          return {
            kind: "rejected-action",
            run: "right",
            arrivalOrder: candidatePermutation,
            fingerprint: "rejected:first:invalid-action",
            requiredOperationIds: ["first", "predecessor"],
            requiredEdges: [["predecessor", "first"]],
            detail: "original cause",
          } satisfies ScenarioFailure;
        }
        if (ids.has("first")) {
          return {
            kind: "rejected-action",
            run: "right",
            arrivalOrder: candidatePermutation,
            fingerprint: "rejected:first:missing-predecessor",
            requiredOperationIds: ["first"],
            requiredEdges: [],
            detail: "different cause",
          } satisfies ScenarioFailure;
        }
        return null;
      },
    );
    expect(minimized.sequence.map((action) => action.operationId)).toEqual([
      "predecessor",
      "first",
    ]);
    expect(minimized.failure).toMatchObject({
      fingerprint: "rejected:first:invalid-action",
      requiredEdges: [["predecessor", "first"]],
    });
  });

  test("repairs late pre-catch scoring and preserves a shortened-stoppage override", async () => {
    const root = createRoot("dangerous-scenarios");
    const record = await createRecord(root, {
      version: "rules-v1",
      rebuild({ effectiveFacts }) {
        const facts = effectiveFacts.map((fact) => ({ type: fact.interpretation.factType }));
        return {
          overtimeTarget: facts.some((fact) => fact.type === "goal") ? 90 : 80,
          order: facts.map((fact) => fact.type),
        };
      },
    });
    const catchFact = createFact(root, "catch", 80_000, "fact-catch");
    const lateGoal = createFact(root, "late-goal", 79_000, "fact-goal");
    (lateGoal.payload as Record<string, unknown>).factType = "goal";
    (catchFact.payload as Record<string, unknown>).factType = "catch";
    expect(await record.acceptAction(catchFact)).toMatchObject({ status: "accepted" });
    expect(await record.acceptAction(lateGoal)).toMatchObject({ status: "accepted" });
    const rebuild = await record.rebuild();
    expect(rebuild).toMatchObject({ status: "ready" });
    if (rebuild.status !== "ready") throw new Error("Expected a ready rebuild.");
    expect(rebuild.derivedGameState).toEqual({
      overtimeTarget: 90,
      order: ["goal", "catch"],
    });
  });
});
