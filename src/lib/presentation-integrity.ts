import { canonicalizeJson } from "@/lib/event-game-action-json";
import { computeAcceptanceIntegrityTag } from "@/lib/grant-crypto";
import {
  normalizeBoundedText,
  validateIntegerInRange,
  validateOpaqueIdentifier,
} from "@/lib/validation-policy";
import type { GrantKeyRing, StoredGrantSession } from "@/lib/grant-types";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import {
  canonicalizeGamePresentationChange,
  fingerprintGamePresentationChange,
  isValidHexColor,
  applyGamePresentationChange,
  orderGamePresentationChanges,
  type StoredGamePresentationAuditEntry,
  type StoredGamePresentationChange,
  type GamePresentationGrantProvenance,
  type GamePresentationOccurrence,
  type GamePresentation,
} from "@/lib/game-presentation";

export type PresentationIntegrityAnchor = {
  recordId: string;
  stateRevision: number;
  keyVersion: string;
  canonicalValue: string;
  integrityTag: string;
};

export type PresentationIntegrityEvidence = {
  recordId: string;
  changes: readonly StoredGamePresentationChange[];
  audits: readonly StoredGamePresentationAuditEntry[];
};

export function presentationIntegrityAnchorFor(
  evidence: PresentationIntegrityEvidence,
  stateRevision: number,
  keyRing: GrantKeyRing,
  keyVersion = keyRing.audit.currentVersion,
): PresentationIntegrityAnchor {
  const canonicalValue = canonicalizeJson({
    domain: "game-presentation-evidence-v1",
    recordId: evidence.recordId,
    stateRevision,
    changes: evidence.changes,
    audits: evidence.audits,
  });
  return {
    recordId: evidence.recordId,
    stateRevision,
    keyVersion,
    canonicalValue,
    integrityTag: computeAcceptanceIntegrityTag(
      canonicalizeJson({
        domain: "game-presentation-evidence-anchor-v1",
        recordId: evidence.recordId,
        stateRevision,
        value: JSON.parse(canonicalValue),
      }),
      keyRing,
      keyVersion,
    ),
  };
}

export function presentationEvidenceFailure(input: {
  root: EventGameRecordRoot | null;
  changes: readonly StoredGamePresentationChange[];
  audits: readonly StoredGamePresentationAuditEntry[];
  anchors: readonly PresentationIntegrityAnchor[];
  sessions: readonly StoredGrantSession[];
  actionOperationIds: ReadonlySet<string>;
  keyRing: GrantKeyRing | undefined;
}): string | null {
  const { root, changes, audits, anchors, sessions, actionOperationIds, keyRing } = input;
  if (changes.length === 0 && audits.length === 0 && anchors.length === 0) return null;
  if (root === null) return "Game Presentation evidence references an invalid root.";
  if (keyRing === undefined || anchors.length === 0)
    return "Game Presentation evidence is unanchored.";
  const sideIds = root.gameSides.map((side) => side.id);
  const operations = new Set(changes.map((change) => change.operationId));
  const sessionById = new Map(sessions.map((session) => [session.sessionId, session]));
  for (const change of changes) {
    if (
      change.recordId !== root.recordId ||
      change.eventGameId !== root.eventGameId ||
      !isValidIdentifier(change.recordId) ||
      !isValidIdentifier(change.eventGameId) ||
      !isValidIdentifier(change.operationId) ||
      !isValidIdentifier(change.presentationChangeId) ||
      !isValidTimestamp(change.acceptedAtMs) ||
      !Array.isArray(change.causalPredecessorIds) ||
      change.causalPredecessorIds.length > 100 ||
      new Set(change.causalPredecessorIds).size !== change.causalPredecessorIds.length ||
      change.causalPredecessorIds.some(
        (predecessor) => !isValidIdentifier(predecessor) || predecessor === change.operationId,
      ) ||
      !isValidPresentationChange(change.change, sideIds) ||
      !isValidOccurrence(change.occurrence) ||
      !isValidGrantProvenance(change.grant) ||
      change.canonicalContent !== canonicalizeGamePresentationChange(change) ||
      !/^[0-9a-f]{64}$/.test(change.contentFingerprint) ||
      change.contentFingerprint !== fingerprintGamePresentationChange(change)
    )
      return "Game Presentation Change evidence is inconsistent.";
    if (
      change.causalPredecessorIds.some(
        (predecessor) =>
          predecessor === change.operationId ||
          (predecessor !== change.operationId &&
            !operations.has(predecessor) &&
            !actionOperationIds.has(predecessor)),
      )
    )
      return "Game Presentation Change causal linkage is invalid.";
    const session = sessionById.get(change.grant.sessionId);
    if (
      session === undefined ||
      session.grantVersion !== change.grant.versionId ||
      session.eventGameId !== root.eventGameId
    )
      return "Game Presentation Change Grant Session linkage is invalid.";
  }
  let accepted: Map<string, StoredGamePresentationAuditEntry>;
  for (const audit of audits) {
    if (
      audit.auditVersion !== "control-audit-v1" ||
      audit.classification !== "game-presentation-change" ||
      !isValidIdentifier(audit.auditId) ||
      audit.recordId !== root.recordId ||
      audit.eventGameId !== root.eventGameId ||
      !isValidIdentifier(audit.recordId) ||
      !isValidIdentifier(audit.eventGameId) ||
      !isValidTimestamp(audit.createdAtMs) ||
      normalizeBoundedText(audit.redactedDetail, 240, "redactedDetail").ok === false ||
      (audit.operationId !== null &&
        (!isValidIdentifier(audit.operationId) || !operations.has(audit.operationId))) ||
      (audit.presentationChangeId !== null && !isValidIdentifier(audit.presentationChangeId)) ||
      (audit.supersedesAuditId !== undefined && !isValidIdentifier(audit.supersedesAuditId))
    )
      return "Game Presentation audit evidence is inconsistent.";
    if (!hasExactAuditShape(audit)) return "Game Presentation audit evidence is inconsistent.";
    if (audit.grant !== null) {
      if (!isValidIdentifier(audit.grant.sessionId) || !isValidIdentifier(audit.grant.versionId))
        return "Game Presentation audit Grant Session linkage is invalid.";
      const session = sessionById.get(audit.grant.sessionId);
      if (
        session === undefined ||
        session.grantVersion !== audit.grant.versionId ||
        session.eventGameId !== root.eventGameId
      )
        return "Game Presentation audit Grant Session linkage is invalid.";
    }
  }
  const effectiveAccepted = effectiveAcceptedAudits(audits);
  if (typeof effectiveAccepted === "string") return effectiveAccepted;
  accepted = effectiveAccepted;
  if (
    accepted.size !== changes.length ||
    changes.some((change) => !accepted.has(change.operationId))
  )
    return "Game Presentation accepted audit linkage is incomplete.";
  let orderedChanges: StoredGamePresentationChange[];
  try {
    orderedChanges = orderGamePresentationChanges(changes);
  } catch {
    return "Game Presentation Change causal history is not a valid order.";
  }
  const orderIndex = new Map(orderedChanges.map((change, index) => [change.operationId, index]));
  for (const change of orderedChanges) {
    const index = orderIndex.get(change.operationId)!;
    if (
      change.causalPredecessorIds.some(
        (predecessor) =>
          operations.has(predecessor) && (orderIndex.get(predecessor) ?? index) >= index,
      )
    )
      return "Game Presentation Change causal history is not ordered.";
  }
  let previousSnapshot: GamePresentation | null = null;
  for (const change of orderedChanges) {
    const audit = accepted.get(change.operationId)!;
    if (
      audit.presentationChangeId !== change.presentationChangeId ||
      canonicalizeJson(audit.change) !== canonicalizeJson(change.change) ||
      canonicalizeJson(audit.grant) !== canonicalizeJson(change.grant) ||
      audit.previousPresentation === null ||
      audit.resultingPresentation === null ||
      !isValidPresentation(audit.previousPresentation, sideIds) ||
      !isValidPresentation(audit.resultingPresentation, sideIds) ||
      canonicalizeJson(audit.previousPresentation.gameSideIds) !== canonicalizeJson(sideIds) ||
      canonicalizeJson(audit.resultingPresentation.gameSideIds) !== canonicalizeJson(sideIds)
    )
      return "Game Presentation accepted audit snapshots are inconsistent.";
    if (
      previousSnapshot !== null &&
      canonicalizeJson(audit.previousPresentation) !== canonicalizeJson(previousSnapshot)
    )
      return "Game Presentation accepted audit sequence is inconsistent.";
    if (
      canonicalizeJson(applyGamePresentationChange(audit.previousPresentation, change.change)) !==
      canonicalizeJson(audit.resultingPresentation)
    )
      return "Game Presentation accepted audit transition is inconsistent.";
    previousSnapshot = audit.resultingPresentation;
  }
  for (const [index, anchor] of anchors.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(anchor.canonicalValue);
    } catch {
      return "Game Presentation evidence anchor is not canonical JSON.";
    }
    if (
      anchor.recordId !== root.recordId ||
      !isValidIdentifier(anchor.recordId) ||
      !isValidIdentifier(anchor.keyVersion) ||
      typeof anchor.canonicalValue !== "string" ||
      anchor.canonicalValue.length > 256 * 1024 ||
      typeof anchor.integrityTag !== "string" ||
      anchor.integrityTag.length > 256 ||
      anchor.stateRevision !== index + 1 ||
      canonicalizeJson(parsed) !== anchor.canonicalValue
    )
      return "Game Presentation evidence anchor is inconsistent.";
    let expectedTag: string;
    try {
      expectedTag = computeAcceptanceIntegrityTag(
        canonicalizeJson({
          domain: "game-presentation-evidence-anchor-v1",
          recordId: root.recordId,
          stateRevision: anchor.stateRevision,
          value: parsed,
        }),
        keyRing,
        anchor.keyVersion,
      );
    } catch {
      return "Game Presentation evidence anchor key is unavailable.";
    }
    if (anchor.integrityTag !== expectedTag) return "Game Presentation evidence anchor is altered.";
  }
  const latest = anchors.at(-1)!;
  const expected = presentationIntegrityAnchorFor(
    { recordId: root.recordId, changes, audits },
    latest.stateRevision,
    keyRing,
    latest.keyVersion,
  );
  return expected.canonicalValue === latest.canonicalValue &&
    expected.integrityTag === latest.integrityTag
    ? null
    : "Game Presentation evidence anchor does not cover the current evidence.";
}

function isValidIdentifier(value: unknown): value is string {
  return validateOpaqueIdentifier(value).ok;
}

function isValidTimestamp(value: unknown): value is number {
  return validateIntegerInRange(value, 0, Number.MAX_SAFE_INTEGER, "timestamp").ok;
}

function isValidOccurrence(value: unknown): value is GamePresentationOccurrence {
  if (value === null || typeof value !== "object") return false;
  const occurrence = value as Partial<GamePresentationOccurrence>;
  return (
    isValidTimestamp(occurrence.trustedAtMs) &&
    (occurrence.clientOriginAtMs === null || isValidTimestamp(occurrence.clientOriginAtMs)) &&
    (occurrence.source === "online" || occurrence.source === "offline")
  );
}

function isValidGrantProvenance(value: unknown): value is GamePresentationGrantProvenance {
  if (value === null || typeof value !== "object") return false;
  const grant = value as Partial<GamePresentationGrantProvenance>;
  return isValidIdentifier(grant.sessionId) && isValidIdentifier(grant.versionId);
}

function isValidPresentationChange(
  change: StoredGamePresentationChange["change"],
  sideIds: readonly string[],
): boolean {
  if (change === null || typeof change !== "object") return false;
  if (change.type === "pitch-orientation") {
    return change.pitchOrientation === "side-a-left" || change.pitchOrientation === "side-b-left";
  }
  return (
    change.type === "displayed-team-color" &&
    isValidIdentifier(change.gameSideId) &&
    sideIds.includes(change.gameSideId) &&
    isValidHexColor(change.color)
  );
}

function isValidPresentation(presentation: GamePresentation, sideIds: readonly string[]): boolean {
  if (
    presentation === null ||
    typeof presentation !== "object" ||
    !Array.isArray(presentation.gameSideIds) ||
    presentation.gameSideIds.length !== sideIds.length ||
    new Set(presentation.gameSideIds).size !== sideIds.length ||
    presentation.gameSideIds.some((sideId) => !isValidIdentifier(sideId)) ||
    !presentation.gameSideIds.every((sideId, index) => sideId === sideIds[index]) ||
    (presentation.pitchOrientation !== "side-a-left" &&
      presentation.pitchOrientation !== "side-b-left") ||
    presentation.displayedTeamColors === null ||
    typeof presentation.displayedTeamColors !== "object"
  )
    return false;
  const colorEntries = Object.entries(presentation.displayedTeamColors);
  return (
    colorEntries.length === sideIds.length &&
    colorEntries.every(([sideId, color]) => sideIds.includes(sideId) && isValidHexColor(color))
  );
}

function hasExactAuditShape(audit: StoredGamePresentationAuditEntry): boolean {
  const linked =
    audit.operationId !== null &&
    audit.presentationChangeId !== null &&
    audit.previousPresentation !== null &&
    audit.resultingPresentation !== null &&
    audit.change !== null &&
    audit.grant !== null;
  if (audit.kind === "presentation-accepted") return audit.outcome === "accepted" && linked;
  if (audit.kind === "presentation-duplicate")
    return audit.outcome === "duplicate-accepted" && linked;
  if (audit.kind === "presentation-conflict") return audit.outcome === "rejected" && linked;
  return (
    audit.kind === "presentation-rejected" &&
    audit.outcome === "rejected" &&
    audit.operationId === null &&
    audit.presentationChangeId === null &&
    audit.previousPresentation === null &&
    audit.resultingPresentation === null &&
    audit.change === null &&
    audit.grant === null
  );
}

function effectiveAcceptedAudits(
  audits: readonly StoredGamePresentationAuditEntry[],
): Map<string, StoredGamePresentationAuditEntry> | string {
  const byId = new Map<string, StoredGamePresentationAuditEntry>();
  for (const audit of audits) {
    if (byId.has(audit.auditId)) return "Game Presentation audit identity is duplicated.";
    byId.set(audit.auditId, audit);
  }
  const supersededBy = new Map<string, string>();
  for (const revision of audits) {
    if (revision.supersedesAuditId === undefined) continue;
    if (revision.kind !== "presentation-accepted" || revision.operationId === null)
      return "Game Presentation audit revision has the wrong shape.";
    const prior = byId.get(revision.supersedesAuditId);
    if (prior === undefined || prior.kind !== "presentation-accepted")
      return "Game Presentation audit revision target is dangling.";
    if (
      prior.recordId !== revision.recordId ||
      prior.eventGameId !== revision.eventGameId ||
      prior.operationId !== revision.operationId ||
      prior.presentationChangeId !== revision.presentationChangeId ||
      canonicalizeJson(prior.change) !== canonicalizeJson(revision.change) ||
      canonicalizeJson(prior.grant) !== canonicalizeJson(revision.grant)
    )
      return "Game Presentation audit revision crosses its operation boundary.";
    if (supersededBy.has(revision.supersedesAuditId))
      return "Game Presentation audit revision fork is invalid.";
    supersededBy.set(revision.supersedesAuditId, revision.auditId);
  }
  const effective = new Map<string, StoredGamePresentationAuditEntry>();
  for (const audit of audits) {
    if (audit.kind !== "presentation-accepted" || audit.operationId === null) continue;
    if (supersededBy.has(audit.auditId)) continue;
    if (effective.has(audit.operationId)) return "Game Presentation accepted audit is duplicated.";
    effective.set(audit.operationId, audit);
  }
  for (const audit of audits) {
    if (audit.kind !== "presentation-accepted") continue;
    const seen = new Set<string>();
    let current = audit;
    while (supersededBy.has(current.auditId)) {
      if (seen.has(current.auditId))
        return "Game Presentation audit supersession cycle is invalid.";
      seen.add(current.auditId);
      const next = byId.get(supersededBy.get(current.auditId)!);
      if (next === undefined) return "Game Presentation audit revision target is dangling.";
      current = next;
    }
    if (current.operationId === null || !effective.has(current.operationId))
      return "Game Presentation audit supersession chain is incomplete.";
  }
  return effective;
}
