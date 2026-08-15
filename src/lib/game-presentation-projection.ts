import {
  DEFAULT_AWAY_TEAM_COLOR,
  DEFAULT_HOME_TEAM_COLOR,
  normalizeTeamColor,
} from "@/lib/team-colors";
import { canonicalizeJson, sha256 } from "@/lib/event-game-action-json";
import {
  applyGamePresentationChange,
  orderGamePresentationChanges,
  type GamePresentation,
  type StoredGamePresentationAuditEntry,
  type StoredGamePresentationAuditRevision,
  type StoredGamePresentationChange,
} from "@/lib/game-presentation";

export type GamePresentationAcceptanceInput = Pick<
  StoredGamePresentationChange,
  | "recordId"
  | "eventGameId"
  | "operationId"
  | "presentationChangeId"
  | "change"
  | "causalPredecessorIds"
  | "occurrence"
  | "grant"
  | "acceptedAtMs"
>;

export function createInitialGamePresentation(
  gameSideIds: readonly string[],
  defaultColors: Readonly<Record<string, string>> = {},
): GamePresentation {
  return {
    gameSideIds: [...gameSideIds],
    pitchOrientation: "side-a-left",
    displayedTeamColors: Object.fromEntries(
      gameSideIds.map((gameSideId, index) => [
        gameSideId,
        normalizeTeamColor(
          defaultColors[gameSideId],
          index === 0 ? DEFAULT_HOME_TEAM_COLOR : DEFAULT_AWAY_TEAM_COLOR,
        ),
      ]),
    ),
  };
}

export function deriveGamePresentation(
  gameSideIds: readonly string[],
  changes: readonly StoredGamePresentationChange[],
  defaultColors: Readonly<Record<string, string>> = {},
): GamePresentation {
  return orderGamePresentationChanges(changes).reduce(
    (presentation, storedChange) => applyGamePresentationChange(presentation, storedChange.change),
    createInitialGamePresentation(gameSideIds, defaultColors),
  );
}

export function collapseGamePresentationAuditEntries(
  entries: readonly StoredGamePresentationAuditEntry[],
): StoredGamePresentationAuditEntry[] {
  const superseded = new Set(
    entries.flatMap((entry) =>
      entry.supersedesAuditId === undefined ? [] : [entry.supersedesAuditId],
    ),
  );
  return [...entries]
    .filter((entry) => !superseded.has(entry.auditId))
    .map((entry) => structuredClone(entry))
    .sort((left, right) =>
      left.createdAtMs === right.createdAtMs
        ? left.auditId.localeCompare(right.auditId)
        : left.createdAtMs - right.createdAtMs,
    );
}

export function revisionGamePresentationAuditEntry(
  entry: StoredGamePresentationAuditEntry,
): StoredGamePresentationAuditRevision {
  const revision = sha256(
    canonicalizeJson({
      supersedesAuditId: entry.auditId,
      previousPresentation: entry.previousPresentation,
      resultingPresentation: entry.resultingPresentation,
    }),
  ).slice(0, 16);
  const baseAuditId = entry.auditId.split(":revision:")[0] ?? entry.auditId;
  return {
    ...structuredClone(entry),
    auditId: `${baseAuditId}:revision:${revision}`,
    supersedesAuditId: entry.auditId,
  };
}
