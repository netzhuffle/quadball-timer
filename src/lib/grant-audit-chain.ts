import type { StoredGrantAuditEntry } from "@/lib/grant-types";

export function bindGrantAuditChain(
  entry: StoredGrantAuditEntry,
  existing: readonly StoredGrantAuditEntry[],
): StoredGrantAuditEntry {
  if (entry.auditSequence !== undefined) return structuredClone(entry);
  const ordered = [...existing].sort(
    (left, right) =>
      (left.auditSequence ?? Number.MAX_SAFE_INTEGER) -
        (right.auditSequence ?? Number.MAX_SAFE_INTEGER) ||
      left.createdAtMs - right.createdAtMs ||
      left.auditId.localeCompare(right.auditId),
  );
  const predecessor = ordered.at(-1);
  return {
    ...structuredClone(entry),
    auditSequence: ordered.length + 1,
    predecessorAuditId: predecessor?.auditId ?? null,
  };
}
