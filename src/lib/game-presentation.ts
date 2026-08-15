import { canonicalizeJson, sha256 } from "@/lib/event-game-action-json";

export type PitchOrientation = "side-a-left" | "side-b-left";

export type GamePresentation = {
  readonly gameSideIds: readonly string[];
  readonly pitchOrientation: PitchOrientation;
  readonly displayedTeamColors: Readonly<Record<string, string>>;
};

export type GamePresentationChange =
  | { type: "pitch-orientation"; pitchOrientation: PitchOrientation }
  | { type: "displayed-team-color"; gameSideId: string; color: string };

export type GamePresentationOccurrence = {
  trustedAtMs: number;
  clientOriginAtMs: number | null;
  source: "online" | "offline";
};

export type GamePresentationGrantProvenance = {
  sessionId: string;
  versionId: string;
};

export type StoredGamePresentationChange = {
  recordId: string;
  eventGameId: string;
  operationId: string;
  presentationChangeId: string;
  change: GamePresentationChange;
  causalPredecessorIds: readonly string[];
  occurrence: GamePresentationOccurrence;
  grant: GamePresentationGrantProvenance;
  acceptedAtMs: number;
  canonicalContent: string;
  contentFingerprint: string;
};

export type GamePresentationAuditKind =
  | "presentation-accepted"
  | "presentation-duplicate"
  | "presentation-conflict"
  | "presentation-rejected";

export type StoredGamePresentationAuditEntry = {
  auditVersion: "control-audit-v1";
  auditId: string;
  recordId: string;
  eventGameId: string;
  operationId: string | null;
  presentationChangeId: string | null;
  kind: GamePresentationAuditKind;
  classification: "game-presentation-change";
  outcome: "accepted" | "duplicate-accepted" | "rejected";
  createdAtMs: number;
  redactedDetail: string;
  previousPresentation: GamePresentation | null;
  resultingPresentation: GamePresentation | null;
  change: GamePresentationChange | null;
  grant: GamePresentationGrantProvenance | null;
  /** Append-only revision linkage for repaired canonical snapshots. */
  supersedesAuditId?: string;
  links?: { targetFactId?: string; grantAuditId?: string };
};

export type StoredGamePresentationAuditRevision = StoredGamePresentationAuditEntry & {
  supersedesAuditId: string;
};

export function canonicalizeGamePresentationChange(
  input: Pick<
    StoredGamePresentationChange,
    | "recordId"
    | "eventGameId"
    | "operationId"
    | "presentationChangeId"
    | "change"
    | "causalPredecessorIds"
    | "occurrence"
    | "grant"
  >,
): string {
  return canonicalizeJson({
    recordId: input.recordId,
    eventGameId: input.eventGameId,
    operationId: input.operationId,
    presentationChangeId: input.presentationChangeId,
    change: input.change,
    causalPredecessorIds: [...input.causalPredecessorIds].sort(),
    occurrence: {
      clientOriginAtMs: input.occurrence.clientOriginAtMs,
      source: input.occurrence.source,
    },
    grant: input.grant,
  });
}

export function fingerprintGamePresentationChange(
  input: Pick<
    StoredGamePresentationChange,
    | "recordId"
    | "eventGameId"
    | "operationId"
    | "presentationChangeId"
    | "change"
    | "causalPredecessorIds"
    | "occurrence"
    | "grant"
  >,
): string {
  return sha256(canonicalizeGamePresentationChange(input));
}

export function isValidHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#?[0-9a-fA-F]{6}$/.test(value.trim());
}

export function applyGamePresentationChange(
  presentation: GamePresentation,
  change: GamePresentationChange,
): GamePresentation {
  if (change.type === "pitch-orientation") {
    return { ...presentation, pitchOrientation: change.pitchOrientation };
  }
  return {
    ...presentation,
    displayedTeamColors: {
      ...presentation.displayedTeamColors,
      [change.gameSideId]: change.color,
    },
  };
}

export function orderGamePresentationChanges(
  changes: readonly StoredGamePresentationChange[],
): StoredGamePresentationChange[] {
  const byOperationId = new Map(changes.map((change) => [change.operationId, change] as const));
  if (byOperationId.size !== changes.length) {
    throw new Error("Game Presentation Change operation identities must be unique.");
  }
  const dependants = new Map<string, StoredGamePresentationChange[]>();
  const indegree = new Map<string, number>(
    changes.map((change) => [change.operationId, 0] as const),
  );
  for (const change of changes) {
    for (const predecessorId of new Set(change.causalPredecessorIds)) {
      if (!byOperationId.has(predecessorId)) continue;
      indegree.set(change.operationId, (indegree.get(change.operationId) ?? 0) + 1);
      const current = dependants.get(predecessorId) ?? [];
      current.push(change);
      dependants.set(predecessorId, current);
    }
  }
  const ready = changes
    .filter((change) => indegree.get(change.operationId) === 0)
    .sort(compareGamePresentationChanges);
  const ordered: StoredGamePresentationChange[] = [];
  while (ready.length > 0) {
    const next = ready.shift()!;
    ordered.push(next);
    for (const dependant of dependants.get(next.operationId) ?? []) {
      const remaining = (indegree.get(dependant.operationId) ?? 0) - 1;
      indegree.set(dependant.operationId, remaining);
      if (remaining === 0) {
        ready.push(dependant);
        ready.sort(compareGamePresentationChanges);
      }
    }
  }
  if (ordered.length !== changes.length) {
    throw new Error("Game Presentation Change causal history contains a cycle.");
  }
  return ordered;
}

export function compareGamePresentationChanges(
  left: StoredGamePresentationChange,
  right: StoredGamePresentationChange,
): number {
  return (
    left.occurrence.trustedAtMs - right.occurrence.trustedAtMs ||
    (left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0)
  );
}
