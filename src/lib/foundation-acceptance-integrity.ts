import { canonicalizeJson } from "@/lib/event-game-action-json";
import { computeAcceptanceIntegrityTag } from "@/lib/grant-crypto";
import {
  actionIdentity,
  parseStoredControlAction,
  sha256,
  type ControlAction,
  type ControlAuditEntry,
} from "@/lib/event-game-actions";
import {
  isFoundationRejectionReason,
  type FoundationRejectionReason,
} from "@/lib/foundation-acceptance-contract";
import type {
  StoredAcceptanceBudget,
  StoredReplayAttempt,
  StoredReplayReceipt,
  StoredReplayReservation,
} from "@/lib/foundation-storage";
import type { GrantKeyRing, StoredGrantAuditEntry } from "@/lib/grant-types";

export type AcceptanceIntegritySubject = "budget" | "reservation" | "attempt" | "receipt";

export type AcceptanceIntegrityAnchor = {
  anchorId: string;
  subjectKind: AcceptanceIntegritySubject;
  subjectId: string;
  stateRevision: number;
  keyVersion: string;
  canonicalValue: string;
  integrityTag: string;
};

/**
 * Validate the complete, canonical result retained for a replay attempt.
 * Status alone is deliberately insufficient: a recovered result is a durable
 * response and must retain exactly the evidence shape that produced it.
 */
export function replayAttemptResultFailure(
  attempt: StoredReplayAttempt,
  expectedAction?: ControlAction,
  expectedReason?: string,
): string | null {
  if (attempt.resultJson === null) return "Replay attempt result is missing.";
  let value: unknown;
  try {
    value = JSON.parse(attempt.resultJson);
  } catch {
    return "Replay attempt result is invalid.";
  }
  if (!isRecord(value) || canonicalizeJson(value) !== attempt.resultJson)
    return "Replay attempt result is not canonical.";
  const keys = Object.keys(value).sort().join(",");
  const auditIds =
    typeof value.auditId === "string" &&
    typeof value.grantAuditId === "string" &&
    attempt.controlAuditId === value.auditId &&
    attempt.grantAuditId === value.grantAuditId;
  if (!auditIds) return "Replay attempt result audits are incomplete or altered.";

  if (attempt.status === "accepted" || attempt.status === "duplicate-accepted") {
    if (
      value.status !== attempt.status ||
      keys !== "action,auditId,grantAuditId,status" ||
      !isRecord(value.action)
    )
      return "Replay accepted result shape is inconsistent.";
    const parsed = parseStoredControlAction(value.action);
    if (!parsed.ok || parsed.value.operationId !== attempt.operationId)
      return "Replay accepted result action is invalid.";
    if (
      expectedAction !== undefined &&
      canonicalizeJson(parsed.value) !== canonicalizeJson(expectedAction)
    )
      return "Replay accepted result action was semantically altered.";
    return null;
  }

  if (attempt.status === "retry-later") {
    if (value.status !== "retry-later") return "Replay retry result status is inconsistent.";
  } else if (
    attempt.status !== "rejected" ||
    !["rejected", "dependency-blocked", "authority-expired"].includes(String(value.status))
  ) {
    return "Replay rejected result status is inconsistent.";
  }
  if (
    keys !== "auditId,detail,grantAuditId,reason,status" ||
    typeof value.reason !== "string" ||
    typeof value.detail !== "string" ||
    !isFoundationRejectionReason(value.reason) ||
    (expectedReason !== undefined && value.reason !== expectedReason)
  )
    return "Replay rejected result shape is inconsistent.";
  return null;
}

/** Validate the semantic contract shared by a Control/Grant acceptance pair. */
export function acceptanceAuditPairFailure(
  control: ControlAuditEntry,
  grant: StoredGrantAuditEntry,
  attempt?: StoredReplayAttempt,
): string | null {
  const links = control.links;
  if (
    links === undefined ||
    control.operationId === null ||
    grant.acceptanceId === null ||
    grant.acceptanceId === undefined ||
    links.acceptanceId !== grant.acceptanceId ||
    links.grantAuditId !== grant.auditId ||
    grant.controlAuditId !== control.auditId ||
    grant.controlActionId !== links.actionId ||
    links.actionId !== actionIdentity(control.recordId, control.operationId)
  )
    return "Control and Grant acceptance identities are inconsistent.";

  const expected = expectedGrantOutcome(grant.action);
  const outcomeDetail = grant.outcomeDetail;
  const contentFingerprint = grant.contentFingerprint;
  const linkedFingerprint = links?.contentFingerprint;
  const linkedReason = links?.reason;
  const rejectedCandidate = links?.rejectedCandidate;
  const collisionCandidate = links?.collision?.rejectedAttempt;
  const rejectedCandidateFingerprint = rejectedCandidate?.contentFingerprint;
  if (
    expected === null ||
    (expected.controlKind !== null && control.kind !== expected.controlKind) ||
    control.outcome !== expected.controlOutcome ||
    outcomeDetail === null ||
    outcomeDetail === undefined ||
    contentFingerprint === null ||
    contentFingerprint === undefined ||
    !/^[a-f0-9]{64}$/.test(contentFingerprint) ||
    linkedFingerprint !== contentFingerprint ||
    !/^[a-f0-9]{64}$/.test(linkedFingerprint)
  )
    return "Control and Grant acceptance semantics are inconsistent.";
  if (
    expected.actionRequiresReason &&
    (typeof linkedReason !== "string" ||
      !isFoundationRejectionReason(linkedReason) ||
      !supportedReason(grant.action, control.kind, readOutcomeStatus(outcomeDetail), linkedReason))
  )
    return "Control and Grant acceptance reason semantics are inconsistent.";
  if (
    expected.actionRequiresReason &&
    (rejectedCandidate === undefined ||
      rejectedCandidateFingerprint !== contentFingerprint ||
      rejectedCandidateFailure(rejectedCandidate) !== null ||
      (collisionCandidate !== undefined &&
        (collisionCandidate.contentFingerprint !== contentFingerprint ||
          rejectedCandidateFailure(collisionCandidate) !== null ||
          collisionCandidate.canonicalContent !== rejectedCandidate.canonicalContent)))
  )
    return "Control and Grant rejected candidate fingerprint is inconsistent.";
  if (
    expected.actionRequiresReason &&
    collisionCandidate !== undefined &&
    !/^[a-f0-9]{64}$/.test(links?.collision?.acceptedContentFingerprint ?? "")
  )
    return "Control and Grant accepted collision fingerprint is inconsistent.";
  if (
    !expected.actionRequiresReason &&
    (linkedReason !== undefined ||
      rejectedCandidate !== undefined ||
      collisionCandidate !== undefined)
  )
    return "Accepted Control and Grant evidence carries a rejection reason.";

  const evidence = parseOutcomeEvidence(outcomeDetail);
  if (
    evidence === null ||
    !expected.statuses.includes(evidence.status) ||
    evidence.detail !== control.redactedDetail ||
    (expected.actionRequiresReason ? evidence.reason !== linkedReason : evidence.reason !== null)
  )
    return "Control and Grant acceptance detail is inconsistent.";

  if (attempt !== undefined) {
    if (
      attempt.operationId !== control.operationId ||
      (attempt.actionFingerprint !== null && attempt.actionFingerprint !== contentFingerprint)
    )
      return "Replay attempt and Control/Grant content identity is inconsistent.";
    if (replayAttemptResultFailure(attempt, undefined, linkedReason) !== null)
      return "Replay attempt result is not paired with its Control/Grant audits.";
    let result: unknown;
    try {
      result = JSON.parse(attempt.resultJson!);
    } catch {
      return "Replay attempt result is invalid.";
    }
    if (!isRecord(result) || !expected.statuses.includes(String(result.status)))
      return "Replay attempt result status is not paired with its Control/Grant audits.";
    if (typeof result.detail === "string" && result.detail !== control.redactedDetail)
      return "Replay attempt result detail is not paired with its Control/Grant audits.";
  }
  return null;
}

function expectedGrantOutcome(action: StoredGrantAuditEntry["action"]): {
  controlKind: ControlAuditEntry["kind"] | null;
  controlOutcome: ControlAuditEntry["outcome"];
  statuses: readonly string[];
  actionRequiresReason: boolean;
} | null {
  switch (action) {
    case "control-action-accepted":
      return {
        controlKind: "action-accepted",
        controlOutcome: "accepted",
        statuses: ["accepted"],
        actionRequiresReason: false,
      };
    case "control-action-duplicate":
      return {
        controlKind: "action-duplicate",
        controlOutcome: "accepted",
        statuses: ["duplicate-accepted"],
        actionRequiresReason: false,
      };
    case "control-action-retry-later":
      return {
        controlKind: "action-rejected",
        controlOutcome: "rejected",
        statuses: ["retry-later"],
        actionRequiresReason: true,
      };
    case "control-action-dependency-blocked":
      return {
        controlKind: "action-rejected",
        controlOutcome: "rejected",
        statuses: ["dependency-blocked"],
        actionRequiresReason: true,
      };
    case "control-action-rejected":
      return {
        controlKind: null,
        controlOutcome: "rejected",
        statuses: ["rejected", "authority-expired"],
        actionRequiresReason: true,
      };
    default:
      return null;
  }
}

function supportedReason(
  action: StoredGrantAuditEntry["action"],
  controlKind: ControlAuditEntry["kind"],
  status: string,
  reason: FoundationRejectionReason,
): boolean {
  if (action === "control-action-retry-later")
    return (
      status === "retry-later" &&
      [
        "rate-budget",
        "causal-predecessor-retry",
        "replay-session-mismatch",
        "scope-unavailable",
        "stale-preflight",
        "storage-unavailable",
      ].includes(reason)
    );
  if (action === "control-action-dependency-blocked")
    return status === "dependency-blocked" && reason === "causal-dependency-rejected";
  if (action === "control-action-rejected")
    return controlKind === "action-conflict"
      ? status === "rejected" && reason === "operation-conflict"
      : status === "rejected"
        ? [
            "cyclic-dependency",
            "missing-dependency",
            "fact-target-missing",
            "invalid-action",
          ].includes(reason)
        : status === "authority-expired" &&
          [
            "game-locked",
            "grant-session",
            "replay-ineligible",
            "replay-reservation-mismatch",
          ].includes(reason);
  return false;
}

function rejectedCandidateFailure(candidate: {
  codecIdentity?: string;
  codecFingerprint?: string;
  canonicalContent: string;
  contentFingerprint: string;
}): string | null {
  if (
    typeof candidate.codecIdentity !== "string" ||
    candidate.codecIdentity.length === 0 ||
    typeof candidate.codecFingerprint !== "string" ||
    candidate.codecFingerprint.length === 0 ||
    !/^[a-f0-9]{64}$/.test(candidate.contentFingerprint)
  )
    return "Rejected candidate fingerprint is not a SHA-256 digest.";
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.canonicalContent);
  } catch {
    return "Rejected candidate canonical content is not JSON.";
  }
  if (canonicalizeJson(parsed) !== candidate.canonicalContent)
    return "Rejected candidate canonical content is not canonical.";
  if (codecIdentityFailure(candidate.codecIdentity, parsed) !== null)
    return "Rejected candidate codec identity is inconsistent.";
  if (
    sha256(`${candidate.codecFingerprint}:${candidate.canonicalContent}`) !==
    candidate.contentFingerprint
  )
    return "Rejected candidate fingerprint does not match canonical content.";
  return null;
}

function codecIdentityFailure(codecIdentity: string, canonicalContent: unknown): string | null {
  let parsedIdentity: unknown;
  try {
    parsedIdentity = JSON.parse(codecIdentity);
  } catch {
    return "Codec identity is not JSON.";
  }
  if (!isRecord(parsedIdentity) || canonicalizeJson(parsedIdentity) !== codecIdentity)
    return "Codec identity is not canonical.";
  if (
    parsedIdentity.schema !== "control-codec-identity-v1" ||
    !isRecord(parsedIdentity.claimed) ||
    typeof parsedIdentity.claimed.id !== "string" ||
    typeof parsedIdentity.claimed.version !== "string" ||
    (parsedIdentity.registered !== null && !isRecord(parsedIdentity.registered))
  )
    return "Codec identity shape is invalid.";
  if (!isRecord(canonicalContent) || !isRecord(canonicalContent.kind))
    return "Codec identity has no claimed action kind.";
  if (
    parsedIdentity.claimed.id !== canonicalContent.kind.id ||
    parsedIdentity.claimed.version !== canonicalContent.kind.version
  )
    return "Codec identity does not match the action kind.";
  if (
    parsedIdentity.registered !== null &&
    (parsedIdentity.registered.id !== parsedIdentity.claimed.id ||
      parsedIdentity.registered.version !== parsedIdentity.claimed.version)
  )
    return "Codec identity registered version is inconsistent.";
  return null;
}

function parseOutcomeEvidence(value: string): {
  status: string;
  reason: FoundationRejectionReason | null;
  detail: string;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || canonicalizeJson(parsed) !== value) return null;
  if (
    typeof parsed.status !== "string" ||
    (parsed.reason !== null && !isFoundationRejectionReason(parsed.reason)) ||
    typeof parsed.detail !== "string"
  )
    return null;
  return {
    status: parsed.status,
    reason: parsed.reason,
    detail: parsed.detail,
  };
}

function readOutcomeStatus(value: string): string {
  return parseOutcomeEvidence(value)?.status ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function anchorFor(
  subjectKind: AcceptanceIntegritySubject,
  value:
    | StoredAcceptanceBudget
    | StoredReplayReservation
    | StoredReplayAttempt
    | StoredReplayReceipt,
  keyRing: GrantKeyRing,
  keyVersion = keyRing.audit.currentVersion,
): AcceptanceIntegrityAnchor {
  const subjectId = subjectIdFor(subjectKind, value);
  const stateRevision = value.stateRevision;
  const canonicalValue = canonicalizeJson(integrityValue(subjectKind, value));
  return {
    anchorId: `${subjectKind}:${subjectId}:${stateRevision}`,
    subjectKind,
    subjectId,
    stateRevision,
    keyVersion,
    canonicalValue,
    integrityTag: computeAcceptanceIntegrityTag(
      canonicalizeJson({
        domain: "foundation-acceptance-state-v1",
        subjectKind,
        subjectId,
        stateRevision,
        value: JSON.parse(canonicalValue),
      }),
      keyRing,
      keyVersion,
    ),
  };
}

export function subjectIdFor(
  subjectKind: AcceptanceIntegritySubject,
  value:
    | StoredAcceptanceBudget
    | StoredReplayReservation
    | StoredReplayAttempt
    | StoredReplayReceipt,
): string {
  switch (subjectKind) {
    case "budget":
      return (value as StoredAcceptanceBudget).bucketId;
    case "reservation":
      return (value as StoredReplayReservation).reservationId;
    case "attempt":
      return `${(value as StoredReplayAttempt).reservationId}:${(value as StoredReplayAttempt).attemptId}`;
    case "receipt":
      return (value as StoredReplayReceipt).receiptId;
  }
}

export function integrityValue(
  subjectKind: AcceptanceIntegritySubject,
  value:
    | StoredAcceptanceBudget
    | StoredReplayReservation
    | StoredReplayAttempt
    | StoredReplayReceipt,
): unknown {
  switch (subjectKind) {
    case "budget":
      return value;
    case "reservation":
      return value;
    case "attempt":
      return value;
    case "receipt":
      return value;
  }
}
