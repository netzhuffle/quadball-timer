import type { FoundationStorage } from "@/lib/foundation-storage";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import { GENERIC_GRANT_STORAGE_FAILURE } from "@/lib/grant-authority-types";
import type { GrantManagementAuthority, TypedSessionSummary } from "@/lib/grant-management-types";
import type { StoredGrantAuditEntry } from "@/lib/grant-types";
import { expireGrantIfDue } from "@/lib/grant-lifecycle";
import { sessionLabel } from "@/lib/grant-management-audit";
import {
  canInspectInTransaction,
  canInspectSessionSummariesInTransaction,
  refreshEventAdminSession,
} from "@/lib/grant-management-policy";
import { verifyGrantAuthority } from "@/lib/grant-authority-trust";

export async function listSessions(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  grantId: string,
  authority: GrantManagementAuthority,
): Promise<{ status: "ok"; value: TypedSessionSummary[] } | typeof GENERIC_GRANT_STORAGE_FAILURE> {
  const trustedAuthority = verifyGrantAuthority(options.privilegedAuthorityVerifier, authority);
  if (trustedAuthority === null) return GENERIC_GRANT_STORAGE_FAILURE;
  try {
    return await storage.transaction((transaction) => {
      const grant = transaction.findGrantById(grantId);
      if (
        grant === null ||
        !canInspectSessionSummariesInTransaction(transaction, options, grant, trustedAuthority)
      )
        return GENERIC_GRANT_STORAGE_FAILURE;
      expireGrantIfDue(transaction, options, grant);
      const result = {
        status: "ok" as const,
        value: transaction.listGrantSessions(grantId).map((session) => ({
          label: sessionLabel(options, session),
          status: session.status,
          createdAtMs: session.createdAtMs,
          lastActiveAtMs: session.lastActiveAtMs,
          revokedAtMs: session.revokedAtMs,
          deviceClass: session.deviceClass ?? "unknown",
          browserClass: session.browserClass ?? "unknown",
        })),
      };
      refreshEventAdminSession(transaction, options, trustedAuthority);
      return result;
    });
  } catch {
    return GENERIC_GRANT_STORAGE_FAILURE;
  }
}

export async function listAudit(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  grantId: string,
  authority: GrantManagementAuthority,
): Promise<
  { status: "ok"; value: StoredGrantAuditEntry[] } | typeof GENERIC_GRANT_STORAGE_FAILURE
> {
  const trustedAuthority = verifyGrantAuthority(options.privilegedAuthorityVerifier, authority);
  if (trustedAuthority === null) return GENERIC_GRANT_STORAGE_FAILURE;
  try {
    return await storage.transaction((transaction) => {
      const grant = transaction.findGrantById(grantId);
      if (grant === null || !canInspectInTransaction(transaction, options, grant, trustedAuthority))
        return GENERIC_GRANT_STORAGE_FAILURE;
      expireGrantIfDue(transaction, options, grant);
      const result = { status: "ok" as const, value: transaction.listGrantAudit(grantId) };
      refreshEventAdminSession(transaction, options, trustedAuthority);
      return result;
    });
  } catch {
    return GENERIC_GRANT_STORAGE_FAILURE;
  }
}
