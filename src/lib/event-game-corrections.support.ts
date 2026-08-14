import { expect } from "bun:test";
import {
  canonicalizeJson,
  createDeterministicTestIqaInterpreter,
  LEGACY_CONTROL_ACTION_VERSION,
  LEGACY_CONTROL_AUDIT_VERSION,
  type ControlActionInput,
} from "@/lib/event-game-actions";
import { createEventGameRecord } from "@/lib/event-game-record";
import { DURABLE_EVIDENCE_PROVENANCE } from "@/lib/foundation-storage";
import type {
  FoundationStorage,
  FoundationStorageTransaction,
  FoundationStorageTransactionWork,
} from "@/lib/foundation-storage";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import {
  projectAcceptanceOutcomeForConvergence,
  projectControlAuditEntryForConvergence,
  projectRebuildForConvergence,
} from "@/lib/event-game-convergence";

export async function snapshot(record: Awaited<ReturnType<typeof createRecord>>) {
  const rebuild = await record.rebuild();
  if (rebuild.status !== "ready") {
    throw new Error(`rebuild:${rebuild.reason}:${rebuild.detail}`);
  }
  const audit = await record.readAudit(auditCredential);
  const projectedRebuild = projectRebuildForConvergence(rebuild);
  return {
    rebuild: {
      canonicalActions: projectedRebuild.canonicalActions,
      effectiveFacts: projectedRebuild.effectiveFacts,
      effectiveTeamAssignments: projectedRebuild.effectiveTeamAssignments,
      derivedGameState: projectedRebuild.derivedGameState,
      conflicts: projectedRebuild.conflicts,
    },
    audit: audit.map(projectControlAuditEntryForConvergence),
  };
}

export const auditCredential = Object.freeze({ role: "event-admin" });

export type CorrectionSpec = {
  operationId: string;
  effective: boolean;
  causalPredecessorIds: readonly string[];
  kind?: "correction" | "team-assignment";
  gameSideId?: "side-a" | "side-b";
  eventTeamId?: string;
  teamInterpretationRef?: string;
};

export const OVERLAPPING_TEAM_COMPONENT: readonly CorrectionSpec[] = [
  {
    operationId: "team-component-a-1",
    effective: false,
    causalPredecessorIds: [],
    kind: "team-assignment",
    gameSideId: "side-a",
    eventTeamId: "team-c",
    teamInterpretationRef: "interpretation-a-c-1",
  },
  {
    operationId: "team-component-b",
    effective: false,
    causalPredecessorIds: [],
    kind: "team-assignment",
    gameSideId: "side-b",
    eventTeamId: "team-c",
    teamInterpretationRef: "interpretation-b-c",
  },
  {
    operationId: "team-component-a-2",
    effective: false,
    causalPredecessorIds: [],
    kind: "team-assignment",
    gameSideId: "side-a",
    eventTeamId: "team-c",
    teamInterpretationRef: "interpretation-a-c-2",
  },
];

export const REGISTERED_CORRECTION_SHAPES: readonly {
  name: string;
  actions: readonly CorrectionSpec[];
}[] = [
  {
    name: "opposing-pair",
    actions: [
      { operationId: "correction-false", effective: false, causalPredecessorIds: [] },
      { operationId: "correction-true", effective: true, causalPredecessorIds: [] },
    ],
  },
  {
    name: "three-chain-reinstatement",
    actions: [
      { operationId: "correction-first", effective: false, causalPredecessorIds: [] },
      {
        operationId: "correction-reinstate",
        effective: true,
        causalPredecessorIds: ["correction-first"],
      },
      {
        operationId: "correction-reverse",
        effective: false,
        causalPredecessorIds: ["correction-reinstate"],
      },
    ],
  },
  {
    name: "three-fan-in-repair",
    actions: [
      { operationId: "correction-left", effective: false, causalPredecessorIds: [] },
      { operationId: "correction-right", effective: true, causalPredecessorIds: [] },
      {
        operationId: "correction-repair",
        effective: false,
        causalPredecessorIds: ["correction-left", "correction-right"],
      },
    ],
  },
  {
    name: "three-branch",
    actions: [
      { operationId: "correction-root", effective: false, causalPredecessorIds: [] },
      {
        operationId: "correction-child",
        effective: true,
        causalPredecessorIds: ["correction-root"],
      },
      { operationId: "correction-independent", effective: false, causalPredecessorIds: [] },
    ],
  },
  {
    name: "three-team",
    actions: [
      {
        operationId: "team-assignment-a-first",
        effective: false,
        causalPredecessorIds: [],
        kind: "team-assignment",
        gameSideId: "side-a",
        eventTeamId: "team-c",
        teamInterpretationRef: "interpretation-a-c",
      },
      {
        operationId: "team-assignment-b-first",
        effective: false,
        causalPredecessorIds: [],
        kind: "team-assignment",
        gameSideId: "side-b",
        eventTeamId: "team-d",
        teamInterpretationRef: "interpretation-b-d",
      },
      {
        operationId: "team-assignment-a-repair",
        effective: false,
        causalPredecessorIds: ["team-assignment-a-first"],
        kind: "team-assignment",
        gameSideId: "side-a",
        eventTeamId: "team-e",
        teamInterpretationRef: "interpretation-a-e",
      },
    ],
  },
  {
    name: "three-team-conflict-repair",
    actions: [
      {
        operationId: "team-conflict-a",
        effective: false,
        causalPredecessorIds: [],
        kind: "team-assignment",
        gameSideId: "side-a",
        eventTeamId: "team-c",
        teamInterpretationRef: "interpretation-a-c",
      },
      {
        operationId: "team-conflict-b",
        effective: false,
        causalPredecessorIds: [],
        kind: "team-assignment",
        gameSideId: "side-b",
        eventTeamId: "team-c",
        teamInterpretationRef: "interpretation-b-c",
      },
      {
        operationId: "team-conflict-repair",
        effective: false,
        causalPredecessorIds: ["team-conflict-a", "team-conflict-b"],
        kind: "team-assignment",
        gameSideId: "side-a",
        eventTeamId: "team-e",
        teamInterpretationRef: "interpretation-a-e",
      },
    ],
  },
  {
    name: "three-team-overlapping-component",
    actions: OVERLAPPING_TEAM_COMPONENT,
  },
  {
    name: "four-team-overlapping-component-repair",
    actions: [
      ...OVERLAPPING_TEAM_COMPONENT,
      {
        operationId: "team-component-repair",
        effective: false,
        causalPredecessorIds: ["team-component-a-1", "team-component-b", "team-component-a-2"],
        kind: "team-assignment",
        gameSideId: "side-b",
        eventTeamId: "team-d",
        teamInterpretationRef: "interpretation-b-d-repair",
      },
    ],
  },
];

export function createCorrectionActions(
  root: EventGameRecordRoot,
  specs: readonly CorrectionSpec[],
): ControlActionInput[] {
  return specs.map((spec, index) => {
    if (spec.kind === "team-assignment") {
      if (
        spec.gameSideId === undefined ||
        spec.eventTeamId === undefined ||
        spec.teamInterpretationRef === undefined
      ) {
        throw new Error(`Incomplete team assignment specification: ${spec.operationId}`);
      }
      return createTeamAssignmentCorrection(
        root,
        spec.operationId,
        spec.gameSideId,
        spec.eventTeamId,
        spec.teamInterpretationRef,
        2_000 + index,
        spec.causalPredecessorIds,
        `controller-${index % 2 === 0 ? "a" : "b"}`,
      );
    }
    return createCorrection(
      root,
      spec.operationId,
      spec.effective,
      2_000 + index,
      spec.causalPredecessorIds,
      "fact-goal",
      `controller-${index % 2 === 0 ? "a" : "b"}`,
    );
  });
}

export function topologicalPermutations(specs: readonly CorrectionSpec[]): string[][] {
  const results: string[][] = [];
  const visit = (prefix: string[], remaining: readonly CorrectionSpec[]) => {
    if (remaining.length === 0) {
      results.push(prefix);
      return;
    }
    for (const candidate of remaining) {
      if (!candidate.causalPredecessorIds.every((predecessor) => prefix.includes(predecessor))) {
        continue;
      }
      visit(
        [...prefix, candidate.operationId],
        remaining.filter((item) => item.operationId !== candidate.operationId),
      );
    }
  };
  visit([], specs);
  return results;
}

export function resolveActionOrder(
  actions: readonly ControlActionInput[],
  operationIds: readonly string[],
): ControlActionInput[] {
  return operationIds.map((operationId) => {
    const action = actions.find((candidate) => candidate.operationId === operationId);
    if (action === undefined) throw new Error(`Unknown generated operation ${operationId}.`);
    return action;
  });
}

export async function acceptScenario(
  record: Awaited<ReturnType<typeof createRecord>>,
  actions: readonly ControlActionInput[],
): Promise<unknown[]> {
  const acknowledgements: unknown[] = [];
  for (const action of actions) {
    const acknowledgement = await record.acceptAction(action);
    expect(acknowledgement).toMatchObject({ status: "accepted" });
    acknowledgements.push(projectAcceptanceOutcomeForConvergence(acknowledgement));
  }
  return acknowledgements;
}

type ScenarioRun = "left" | "right" | "comparison";

export type ScenarioFailure = {
  kind: "boolean-mismatch" | "rejected-action" | "thrown" | "readiness-failure";
  run: ScenarioRun;
  arrivalOrder: readonly string[];
  fingerprint: string;
  reason?: string;
  requiredOperationIds: readonly string[];
  requiredEdges: readonly (readonly [string, string])[];
  detail: string;
};

type ShrinkPredicateResult = ScenarioFailure | null;

type ObserverOptions = {
  recordFactory?: (
    root: EventGameRecordRoot,
    run: Exclude<ScenarioRun, "comparison">,
  ) => Promise<Awaited<ReturnType<typeof createRecord>>>;
  snapshotRecord?: (
    record: Awaited<ReturnType<typeof createRecord>>,
    run: Exclude<ScenarioRun, "comparison">,
  ) => Promise<unknown>;
  transformAcknowledgement?: (
    acknowledgement: unknown,
    action: ControlActionInput,
    run: Exclude<ScenarioRun, "comparison">,
  ) => unknown;
};

type ExactDifference = {
  path: string;
  left: unknown;
  right: unknown;
  operationIds: readonly string[];
};

export async function observePermutation(
  root: EventGameRecordRoot,
  actions: readonly ControlActionInput[],
  arrivalOrder: readonly string[],
  options: ObserverOptions = {},
): Promise<ScenarioFailure | null> {
  const recordFactory = options.recordFactory ?? ((candidateRoot) => createRecord(candidateRoot));
  const left = await recordFactory(root, "left");
  const right = await recordFactory(root, "right");
  const fact = createFact(root, "fact-generated", 1_000, "fact-goal");
  const rightOrder = resolveActionOrder(actions, arrivalOrder);
  const run = async (
    record: Awaited<ReturnType<typeof createRecord>>,
    sequence: readonly ControlActionInput[],
    runName: Exclude<ScenarioRun, "comparison">,
    runArrivalOrder: readonly string[],
  ): Promise<{ failure: ScenarioFailure | null; acknowledgements: unknown[] }> => {
    const acknowledgements: unknown[] = [];
    for (const action of sequence) {
      try {
        const acknowledgement = await record.acceptAction(action);
        if (acknowledgement.status !== "accepted") {
          const relationship = causalFailureRelationship([action.operationId], actions);
          return {
            failure: {
              kind: "rejected-action",
              run: runName,
              arrivalOrder: [...runArrivalOrder],
              fingerprint: `rejected:${action.operationId}:${failureValue(acknowledgement)}`,
              ...relationship,
              detail: JSON.stringify(acknowledgement),
            },
            acknowledgements,
          };
        }
        const projectedAcknowledgement = projectAcceptanceOutcomeForConvergence(acknowledgement);
        acknowledgements.push(
          options.transformAcknowledgement?.(projectedAcknowledgement, action, runName) ??
            projectedAcknowledgement,
        );
      } catch (error) {
        const relationship = causalFailureRelationship([action.operationId], actions);
        return {
          failure: {
            kind: "thrown",
            run: runName,
            arrivalOrder: [...runArrivalOrder],
            fingerprint: `thrown:${action.operationId}:${errorSignature(error)}`,
            ...relationship,
            detail: error instanceof Error ? error.message : String(error),
          },
          acknowledgements,
        };
      }
    }
    return { failure: null, acknowledgements };
  };
  const leftOrder = actions.map((action) => action.operationId);
  const leftRun = await run(left, [fact, ...actions], "left", leftOrder);
  if (leftRun.failure !== null) return leftRun.failure;
  const rightRun = await run(right, [fact, ...rightOrder], "right", arrivalOrder);
  if (rightRun.failure !== null) return rightRun.failure;

  const observeSnapshot = async (
    record: Awaited<ReturnType<typeof createRecord>>,
    runName: Exclude<ScenarioRun, "comparison">,
    runArrivalOrder: readonly string[],
  ): Promise<{ snapshot?: unknown; failure?: ScenarioFailure }> => {
    const rebuild = await record.rebuild();
    if (rebuild.status !== "ready") {
      const relationship = readinessFailureRelationship(rebuild.detail, actions);
      return {
        failure: {
          kind: "readiness-failure",
          run: runName,
          arrivalOrder: [...runArrivalOrder],
          reason: rebuild.reason,
          fingerprint: `readiness:${runName}:${rebuild.reason}:${failureValue(rebuild.detail)}:operations=${relationship.requiredOperationIds.join(",")}:edges=${failureValue(relationship.requiredEdges)}`,
          ...relationship,
          detail: rebuild.detail,
        },
      };
    }
    try {
      return {
        snapshot: options.snapshotRecord
          ? await options.snapshotRecord(record, runName)
          : await snapshotFromRebuild(record, rebuild),
      };
    } catch (error) {
      return {
        failure: {
          kind: "readiness-failure",
          run: runName,
          arrivalOrder: [...runArrivalOrder],
          fingerprint: `readiness:${runName}:${errorSignature(error)}`,
          ...causalFailureRelationship(
            actions.map((action) => action.operationId),
            actions,
          ),
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }
  };
  const leftObservation = await observeSnapshot(left, "left", leftOrder);
  if (leftObservation.failure !== undefined) return leftObservation.failure;
  const rightObservation = await observeSnapshot(right, "right", arrivalOrder);
  if (rightObservation.failure !== undefined) return rightObservation.failure;

  const acknowledgementDifference = findAcknowledgementDifference(
    leftRun.acknowledgements,
    rightRun.acknowledgements,
  );
  if (acknowledgementDifference !== null) {
    return mismatchFailure("acknowledgements", acknowledgementDifference, actions, arrivalOrder);
  }
  const snapshotDifference = findExactDifference(
    leftObservation.snapshot,
    rightObservation.snapshot,
  );
  if (snapshotDifference !== null) {
    return mismatchFailure("snapshot", snapshotDifference, actions, arrivalOrder);
  }
  return null;
}

async function snapshotFromRebuild(
  record: Awaited<ReturnType<typeof createRecord>>,
  rebuild: Extract<Awaited<ReturnType<typeof record.rebuild>>, { status: "ready" }>,
) {
  const audit = await record.readAudit(auditCredential);
  const projectedRebuild = projectRebuildForConvergence(rebuild);
  return {
    rebuild: {
      canonicalActions: projectedRebuild.canonicalActions,
      effectiveFacts: projectedRebuild.effectiveFacts,
      effectiveTeamAssignments: projectedRebuild.effectiveTeamAssignments,
      derivedGameState: projectedRebuild.derivedGameState,
      conflicts: projectedRebuild.conflicts,
    },
    audit: audit.map(projectControlAuditEntryForConvergence),
  };
}

function mismatchFailure(
  surface: "acknowledgements" | "snapshot",
  difference: ExactDifference,
  actions: readonly ControlActionInput[],
  arrivalOrder: readonly string[],
): ScenarioFailure {
  const relationship = causalFailureRelationship(difference.operationIds, actions);
  return {
    kind: "boolean-mismatch",
    run: "comparison",
    arrivalOrder: [...arrivalOrder],
    fingerprint: `${surface}:${difference.path}:${failureValue(difference.left)}=>${failureValue(difference.right)}:operations=${difference.operationIds.join(",")}:required=${relationship.requiredOperationIds.join(",")}:edges=${failureValue(relationship.requiredEdges)}`,
    ...relationship,
    detail: `${surface} differ at ${difference.path}.`,
  };
}

function findAcknowledgementDifference(
  leftAcknowledgements: readonly unknown[],
  rightAcknowledgements: readonly unknown[],
): ExactDifference | null {
  const left = sortAcknowledgements(leftAcknowledgements);
  const right = sortAcknowledgements(rightAcknowledgements);
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const leftAcknowledgement = left[index];
    const rightAcknowledgement = right[index];
    const operationId =
      acknowledgementOperationId(leftAcknowledgement) ??
      acknowledgementOperationId(rightAcknowledgement);
    const difference = findExactDifference(leftAcknowledgement, rightAcknowledgement);
    if (difference === null) continue;
    return {
      ...difference,
      operationIds:
        operationId === undefined
          ? difference.operationIds
          : [...new Set([operationId, ...difference.operationIds])],
    };
  }
  return null;
}

function findExactDifference(
  left: unknown,
  right: unknown,
  path = "$",
  inheritedOperationIds: readonly string[] = [],
): ExactDifference | null {
  if (Object.is(left, right)) return null;
  if (path === "$" && JSON.stringify(left) === JSON.stringify(right)) return null;
  const operationIds = [
    ...new Set([
      ...inheritedOperationIds,
      ...directOperationIds(left),
      ...directOperationIds(right),
    ]),
  ];
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return {
        path: `${path}.length`,
        left: left.length,
        right: right.length,
        operationIds: [
          ...new Set([...operationIds, ...arrayOperationIds(left), ...arrayOperationIds(right)]),
        ],
      };
    }
    for (let index = 0; index < left.length; index += 1) {
      const leftOperationIds = directOperationIds(left[index]);
      const rightOperationIds = new Set(directOperationIds(right[index]));
      const stableOperationId = leftOperationIds.find((operationId) =>
        rightOperationIds.has(operationId),
      );
      const difference = findExactDifference(
        left[index],
        right[index],
        stableOperationId === undefined
          ? `${path}[${index}]`
          : `${path}[operationId=${stableOperationId}]`,
        operationIds,
      );
      if (difference !== null) return difference;
    }
    return null;
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      const difference = findExactDifference(left[key], right[key], `${path}.${key}`, operationIds);
      if (difference !== null) return difference;
    }
    return null;
  }
  return { path, left, right, operationIds };
}

function directOperationIds(value: unknown): string[] {
  if (!isPlainObject(value)) return [];
  const operationIds: string[] = [];
  if (typeof value.operationId === "string") operationIds.push(value.operationId);
  if (Array.isArray(value.relatedOperationIds)) {
    for (const operationId of value.relatedOperationIds) {
      if (typeof operationId === "string") operationIds.push(operationId);
    }
  }
  return operationIds;
}

function arrayOperationIds(values: readonly unknown[]): string[] {
  return values.flatMap((value) => [
    ...directOperationIds(value),
    ...(Array.isArray(value) ? arrayOperationIds(value) : []),
  ]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function acknowledgementOperationId(acknowledgement: unknown): string | undefined {
  if (!isPlainObject(acknowledgement) || !isPlainObject(acknowledgement.action)) return undefined;
  return typeof acknowledgement.action.operationId === "string"
    ? acknowledgement.action.operationId
    : undefined;
}

function causalFailureRelationship(
  targetOperationIds: readonly string[],
  actions: readonly ControlActionInput[],
): Pick<ScenarioFailure, "requiredOperationIds" | "requiredEdges"> {
  const actionsByOperationId = new Map(actions.map((action) => [action.operationId, action]));
  const required = new Set<string>();
  const visit = (operationId: string) => {
    const action = actionsByOperationId.get(operationId);
    if (action === undefined || required.has(operationId)) return;
    required.add(operationId);
    for (const predecessor of action.causalPredecessorIds) visit(predecessor);
  };
  for (const operationId of targetOperationIds) visit(operationId);
  const requiredOperationIds = actions
    .map((action) => action.operationId)
    .filter((operationId) => required.has(operationId));
  const requiredEdges = actions.flatMap((action) =>
    required.has(action.operationId)
      ? action.causalPredecessorIds
          .filter((predecessor) => required.has(predecessor))
          .map((predecessor): readonly [string, string] => [predecessor, action.operationId])
      : [],
  );
  return { requiredOperationIds, requiredEdges };
}

function readinessFailureRelationship(
  detail: string,
  actions: readonly ControlActionInput[],
): Pick<ScenarioFailure, "requiredOperationIds" | "requiredEdges"> {
  const mentionedOperationIds = actions
    .map((action) => action.operationId)
    .filter((operationId) => detail.includes(operationId));
  return causalFailureRelationship(
    mentionedOperationIds.length === 0
      ? actions.map((action) => action.operationId)
      : mentionedOperationIds,
    actions,
  );
}

function failureValue(value: unknown): string {
  if (value === undefined) return "<undefined>";
  try {
    return canonicalizeJson(value);
  } catch {
    return `<noncanonical:${typeof value}>`;
  }
}

export async function minimizeFailingSequence(
  sequence: readonly CorrectionSpec[],
  failingPermutation: readonly string[],
  fails: (
    candidate: readonly CorrectionSpec[],
    candidatePermutation: readonly string[],
  ) => Promise<ShrinkPredicateResult>,
  seed?: number | string,
): Promise<{
  seed: number | string | undefined;
  sequence: CorrectionSpec[];
  arrivalOrder: string[];
  failure: ScenarioFailure | undefined;
}> {
  let minimized = [...sequence];
  const initial = await evaluateShrinkCandidate(fails, sequence, failingPermutation);
  let failure = initial;
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < minimized.length; index += 1) {
      const candidate = minimized.filter((_, candidateIndex) => candidateIndex !== index);
      const candidateIds = new Set(candidate.map((action) => action.operationId));
      const candidatePermutation = failingPermutation.filter((operationId) =>
        candidateIds.has(operationId),
      );
      const candidateFailure = await evaluateShrinkCandidate(
        fails,
        candidate,
        candidatePermutation,
      );
      if (
        candidateFailure !== null &&
        failure !== null &&
        reproducesFailure(failure, candidateFailure, candidatePermutation)
      ) {
        minimized = candidate;
        failure = candidateFailure;
        changed = true;
        break;
      }
    }
  }
  return {
    seed,
    sequence: minimized,
    arrivalOrder: [...(failure?.arrivalOrder ?? [])],
    failure: failure ?? undefined,
  };
}

async function evaluateShrinkCandidate(
  fails: (
    candidate: readonly CorrectionSpec[],
    candidatePermutation: readonly string[],
  ) => Promise<ShrinkPredicateResult>,
  candidate: readonly CorrectionSpec[],
  candidatePermutation: readonly string[],
): Promise<ScenarioFailure | null> {
  try {
    return await fails(candidate, candidatePermutation);
  } catch (error) {
    return {
      kind: "thrown",
      run: "comparison",
      arrivalOrder: [...candidatePermutation],
      fingerprint: `thrown:shrink:${errorSignature(error)}`,
      requiredOperationIds: [],
      requiredEdges: [],
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function reproducesFailure(
  expected: ScenarioFailure,
  candidate: ScenarioFailure,
  candidatePermutation: readonly string[],
): boolean {
  if (
    candidate.kind !== expected.kind ||
    candidate.run !== expected.run ||
    candidate.fingerprint !== expected.fingerprint ||
    candidate.reason !== expected.reason ||
    candidate.detail !== expected.detail
  ) {
    return false;
  }
  if (
    JSON.stringify(candidate.requiredOperationIds) !==
      JSON.stringify(expected.requiredOperationIds) ||
    JSON.stringify(candidate.requiredEdges) !== JSON.stringify(expected.requiredEdges)
  ) {
    return false;
  }
  if (
    !expected.requiredOperationIds.every((operationId) =>
      candidatePermutation.includes(operationId),
    )
  ) {
    return false;
  }
  if (
    !expected.requiredEdges.every(
      ([predecessor, operationId]) =>
        candidatePermutation.includes(predecessor) && candidatePermutation.includes(operationId),
    )
  ) {
    return false;
  }
  const expectedArrivalOrder = expected.arrivalOrder.filter((operationId) =>
    candidatePermutation.includes(operationId),
  );
  return JSON.stringify(candidate.arrivalOrder) === JSON.stringify(expectedArrivalOrder);
}

function errorSignature(error: unknown): string {
  if (error instanceof Error) return `${error.name}:${error.message}`;
  return String(error);
}

export function sortAcknowledgements(acknowledgements: readonly unknown[]): unknown[] {
  return [...acknowledgements].sort((left, right) => {
    const leftOperationId =
      typeof left === "object" &&
      left !== null &&
      "action" in left &&
      typeof left.action === "object" &&
      left.action !== null &&
      "operationId" in left.action
        ? String(left.action.operationId)
        : JSON.stringify(left);
    const rightOperationId =
      typeof right === "object" &&
      right !== null &&
      "action" in right &&
      typeof right.action === "object" &&
      right.action !== null &&
      "operationId" in right.action
        ? String(right.action.operationId)
        : JSON.stringify(right);
    return leftOperationId.localeCompare(rightOperationId);
  });
}

export function corruptMemoryAudit(
  storage: FoundationStorage,
  mutate: (entry: Awaited<ReturnType<FoundationStorage["readAuditEntries"]>>[number]) => void,
  mutateDuringTransactions = true,
): FoundationStorage {
  return {
    transaction<T>(work: FoundationStorageTransactionWork<T>) {
      return storage.transaction((transaction) =>
        mutateDuringTransactions
          ? work({
              ...transaction,
              listAuditEntries(recordId) {
                const entries = transaction.listAuditEntries(recordId);
                for (const entry of entries) mutate(entry);
                return entries;
              },
            } satisfies FoundationStorageTransaction)
          : work(transaction),
      );
    },
    readRoot: (recordId) => storage.readRoot(recordId),
    readActions: (recordId) => storage.readActions(recordId),
    readIdempotencyEntries: (recordId) => storage.readIdempotencyEntries(recordId),
    readRecordMetadata: (recordId) => storage.readRecordMetadata(recordId),
    readAuditEntries: async (recordId) => {
      const entries = await storage.readAuditEntries(recordId);
      for (const entry of entries) mutate(entry);
      return entries;
    },
    readiness: () => storage.readiness(),
    close: () => storage.close(),
  };
}

export function removeMemoryAudit(
  storage: FoundationStorage,
  shouldRemove: (
    entry: Awaited<ReturnType<FoundationStorage["readAuditEntries"]>>[number],
  ) => boolean,
): FoundationStorage {
  return {
    transaction<T>(work: FoundationStorageTransactionWork<T>) {
      return storage.transaction((transaction) =>
        work({
          ...transaction,
          listAuditEntries(recordId) {
            return transaction.listAuditEntries(recordId).filter((entry) => !shouldRemove(entry));
          },
        } satisfies FoundationStorageTransaction),
      );
    },
    readRoot: (recordId) => storage.readRoot(recordId),
    readActions: (recordId) => storage.readActions(recordId),
    readIdempotencyEntries: (recordId) => storage.readIdempotencyEntries(recordId),
    readRecordMetadata: (recordId) => storage.readRecordMetadata(recordId),
    readAuditEntries: async (recordId) =>
      (await storage.readAuditEntries(recordId)).filter((entry) => !shouldRemove(entry)),
    readiness: () => storage.readiness(),
    close: () => storage.close(),
  };
}

export function legacyMemoryEvidenceView(
  storage: FoundationStorage,
  legacyOperationIds: ReadonlySet<string>,
): FoundationStorage {
  const projectAction = (stored: Awaited<ReturnType<FoundationStorage["readActions"]>>[number]) => {
    if (!legacyOperationIds.has(stored.action.operationId)) return stored;
    const action = structuredClone(stored.action);
    action.controlActionVersion = LEGACY_CONTROL_ACTION_VERSION;
    return {
      ...stored,
      action,
      durableFormat: "legacy" as const,
      [DURABLE_EVIDENCE_PROVENANCE]: "legacy" as const,
    };
  };
  const projectAudit = (
    entry: Awaited<ReturnType<FoundationStorage["readAuditEntries"]>>[number],
  ) => {
    const relatedOperationIds = entry.links?.relatedOperationIds ?? [];
    const legacy =
      (entry.operationId !== null && legacyOperationIds.has(entry.operationId)) ||
      (entry.operationId === null &&
        relatedOperationIds.length > 0 &&
        relatedOperationIds.every((id) => legacyOperationIds.has(id)));
    if (!legacy) return entry;
    const projected = structuredClone(entry);
    projected.auditVersion = LEGACY_CONTROL_AUDIT_VERSION;
    delete projected.links;
    delete projected.provenance;
    return {
      ...projected,
      durableFormat: "legacy" as const,
      [DURABLE_EVIDENCE_PROVENANCE]: "legacy" as const,
    };
  };
  return {
    transaction<T>(work: FoundationStorageTransactionWork<T>) {
      return storage.transaction((transaction) =>
        work({
          ...transaction,
          findActionByOperationId(recordId, operationId) {
            const action = transaction.findActionByOperationId(recordId, operationId);
            return action === null ? null : projectAction(action);
          },
          listActions(recordId) {
            return transaction.listActions(recordId).map(projectAction);
          },
          listAuditEntries(recordId) {
            return transaction.listAuditEntries(recordId).map(projectAudit);
          },
        } satisfies FoundationStorageTransaction),
      );
    },
    readRoot: (recordId) => storage.readRoot(recordId),
    readActions: async (recordId) => (await storage.readActions(recordId)).map(projectAction),
    readIdempotencyEntries: (recordId) => storage.readIdempotencyEntries(recordId),
    readRecordMetadata: (recordId) => storage.readRecordMetadata(recordId),
    readAuditEntries: async (recordId) =>
      (await storage.readAuditEntries(recordId)).map(projectAudit),
    readiness: () => storage.readiness(),
    close: () => storage.close(),
  };
}

export async function createRecord(
  root: EventGameRecordRoot,
  interpreter = createDeterministicTestIqaInterpreter("rules-v1"),
  clock: () => number = () => 10_000,
  storage: FoundationStorage = createInMemoryFoundationStorage(),
) {
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
    clock,
    interpreter,
    auditAuthorityVerifier: { verify: (candidate) => candidate === auditCredential },
  });
  const registration = await record.registerRoot(root);
  expect(["registered", "idempotent"]).toContain(registration.status);
  return record;
}

export function createFact(
  root: EventGameRecordRoot,
  operationId: string,
  trustedAtMs: number,
  factId: string,
  override?: ControlActionInput["override"],
  sessionId = "session-1",
): ControlActionInput {
  return {
    recordId: root.recordId,
    eventGameId: root.eventGameId,
    operationId,
    kind: { id: "game-fact", version: "1" },
    payload: {
      factId,
      factType: "deterministic-test-fact",
      gameSideId: "side-a",
      gameTimeMs: trustedAtMs,
      data: { operationId },
    },
    causalPredecessorIds: [],
    occurrence: { trustedAtMs, clientOriginAtMs: trustedAtMs, source: "offline" },
    grant: { sessionId, versionId: "grant-version-1" },
    lifecycle: structuredClone(root.lifecycle),
    ...(override === undefined ? {} : { override }),
  };
}

export function createCorrection(
  root: EventGameRecordRoot,
  operationId: string,
  effective: boolean,
  trustedAtMs: number,
  causalPredecessorIds: readonly string[] = [],
  targetFactId = "fact-goal",
  sessionId = "session-1",
): ControlActionInput {
  return {
    ...createFact(root, operationId, trustedAtMs, `fact-${operationId}`),
    kind: { id: "correction", version: "1" },
    payload: {
      correctionId: operationId,
      targetFactId,
      effective,
    },
    causalPredecessorIds,
    grant: { sessionId, versionId: "grant-version-1" },
  };
}

export function createTeamAssignmentCorrection(
  root: EventGameRecordRoot,
  operationId: string,
  gameSideId: string,
  eventTeamId: string,
  teamInterpretationRef: string,
  trustedAtMs: number,
  causalPredecessorIds: readonly string[] = [],
  sessionId = "session-team-assignment",
): ControlActionInput {
  return {
    recordId: root.recordId,
    eventGameId: root.eventGameId,
    operationId,
    kind: { id: "team-assignment-correction", version: "1" },
    payload: {
      correctionId: operationId,
      gameSideId,
      eventTeamId,
      teamInterpretationRef,
    },
    causalPredecessorIds,
    occurrence: { trustedAtMs, clientOriginAtMs: trustedAtMs, source: "offline" },
    grant: { sessionId, versionId: "grant-version-1" },
    lifecycle: structuredClone(root.lifecycle),
  };
}

export function createRoot(recordId: string): EventGameRecordRoot {
  return {
    recordId,
    eventId: `event-${recordId}`,
    eventGameId: `event-game-${recordId}`,
    ownership: { eventId: `event-${recordId}`, eventGameId: `event-game-${recordId}` },
    externalScope: {
      eventId: `event-${recordId}`,
      gameDayId: `day-${recordId}`,
      pitchId: `pitch-${recordId}`,
      pitchSlotId: `slot-${recordId}`,
    },
    gameSides: [
      { id: "side-a", eventTeamId: "team-a", teamInterpretationRef: "interpretation-a" },
      { id: "side-b", eventTeamId: "team-b", teamInterpretationRef: "interpretation-b" },
    ],
    lifecycle: {
      phase: "in-progress",
      commencedAtMs: 0,
      finishedAtMs: null,
      lockedAtMs: null,
      lockReason: null,
    },
    compatibility: {
      recordVersion: "record-v1",
      schemaVersion: "schema-v1",
      interpreterVersion: "rules-v1",
    },
    creationEvidence: {
      operationId: `register-${recordId}`,
      actorReference: "event-admin-session-1",
      source: "event-game-registration",
      createdAtMs: 0,
    },
  };
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

export function randomInt(random: () => number, maximum: number): number {
  return Math.floor(random() * maximum);
}
