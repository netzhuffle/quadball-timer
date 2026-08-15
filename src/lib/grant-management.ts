import { requireGrantStorageCapabilities, type FoundationStorage } from "@/lib/foundation-storage";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import { EVENT_ADMIN_GRANT_TYPE, GRANT_TYPE, PITCH_MANAGER_GRANT_TYPE } from "@/lib/grant-types";
import {
  createGrant,
  createGrantInTransaction,
  reactivateGrant,
  updateGrantStatus,
} from "@/lib/grant-management-commands";
import {
  revealGrant,
  revealGrantInTransaction,
  rotateGrant,
  rotateGrantInTransaction,
  rotateGrantCredentialKeys,
} from "@/lib/grant-management-credentials";
import { recalculateExpiry, retireGrantInTransaction } from "@/lib/grant-management-lifecycle";
import { listAudit, listSessions, listSessionsInTransaction } from "@/lib/grant-management-queries";
import { admitGrantCode, createGrantCode, disableGrantCode } from "@/lib/grant-management-code";
import {
  admitGrant,
  acceptControlGrantSessionSwitch,
  authorizeGrant,
  authorizeGrantInTransaction,
  authorizeControlGrantReplay,
  leaveGrantSession,
  revokeGrantSession,
  revokeGrantSessionInTransaction,
} from "@/lib/grant-management-sessions";
import type { TypedGrantAuthority } from "@/lib/grant-management-types";

export type {
  CreateTypedGrantInput,
  GrantManagementAuthority,
  TypedGrantAdmission,
  TypedGrantAuthorization,
  TypedGrantAuthority,
  TypedGrantCreated,
  TypedControlGrantSwitch,
  TypedGrantReplayAuthorization,
  TypedGrantMutation,
  TypedGrantReveal,
  TypedGrantRotated,
  TypedGrantAdmissionThrottled,
  TypedGrantCodeCreated,
  TypedSessionSummary,
} from "@/lib/grant-management-types";
export type { GrantLifecycleMetadataCorrection } from "@/lib/grant-management-lifecycle";

/** Narrow composition root for typed Grant commands, credentials, sessions, and queries. */
export function createTypedGrantAuthority(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
): TypedGrantAuthority {
  requireGrantStorageCapabilities(storage);
  const notifyLifecycleChange = <T>(
    operation: Promise<T>,
    changedStatuses: readonly string[] = ["admitted", "switched", "updated"],
  ): Promise<T> =>
    operation.then((result) => {
      if (
        typeof result === "object" &&
        result !== null &&
        "status" in result &&
        changedStatuses.includes(String(result.status))
      ) {
        options.onLifecycleChange?.();
      }
      return result;
    });
  storage.setGrantValidationContext({
    environmentId: options.environmentId,
    keyRing: options.keyRing,
  });
  storage.setGrantKeyRing(options.keyRing);
  return {
    createGrant: (input) => createGrant(storage, options, input),
    createEventAdminGrant: (input) =>
      createGrant(storage, options, { ...input, grantType: EVENT_ADMIN_GRANT_TYPE }),
    createEventAdminGrantInTransaction: (transaction, input) =>
      createGrantInTransaction(transaction, options, {
        ...input,
        grantType: EVENT_ADMIN_GRANT_TYPE,
      }),
    createPitchManagerGrant: (input) =>
      createGrant(storage, options, { ...input, grantType: PITCH_MANAGER_GRANT_TYPE }),
    createPitchManagerGrantInTransaction: (transaction, input) =>
      createGrantInTransaction(transaction, options, {
        ...input,
        grantType: PITCH_MANAGER_GRANT_TYPE,
      }),
    createControlGrant: (input) =>
      createGrant(storage, options, { ...input, grantType: GRANT_TYPE }),
    createControlGrantInTransaction: (transaction, input) =>
      createGrantInTransaction(transaction, options, {
        ...input,
        grantType: GRANT_TYPE,
      }),
    createGrantCode: (grantId, authority) =>
      createGrantCode(storage, options, grantId, authority, false),
    replaceGrantCode: (grantId, authority) =>
      createGrantCode(storage, options, grantId, authority, true),
    disableGrantCode: (grantId, authority) =>
      disableGrantCode(storage, options, grantId, authority),
    admitGrantCode: (input) => admitGrantCode(storage, options, input),
    admitEventAdminGrantCode: (input) =>
      notifyLifecycleChange(admitGrantCode(storage, options, input, EVENT_ADMIN_GRANT_TYPE)),
    admitPitchManagerGrantCode: (input) =>
      notifyLifecycleChange(admitGrantCode(storage, options, input, PITCH_MANAGER_GRANT_TYPE)),
    admitControlGrantCode: (input) =>
      notifyLifecycleChange(admitGrantCode(storage, options, input, GRANT_TYPE)),
    admitGrant: (input, expectedGrantType) =>
      notifyLifecycleChange(admitGrant(storage, options, input, expectedGrantType)),
    admitPitchManagerGrant: (input) =>
      notifyLifecycleChange(admitGrant(storage, options, input, PITCH_MANAGER_GRANT_TYPE)),
    admitEventAdminGrant: (input) =>
      notifyLifecycleChange(admitGrant(storage, options, input, EVENT_ADMIN_GRANT_TYPE)),
    authorizeGrant: (input) =>
      input.readOnly === true
        ? authorizeGrant(storage, options, input)
        : notifyLifecycleChange(authorizeGrant(storage, options, input), ["authorized"]),
    authorizeGrantInTransaction: (transaction, input) =>
      authorizeGrantInTransaction(transaction, options, input),
    acceptControlGrantSessionSwitch: (input) =>
      notifyLifecycleChange(acceptControlGrantSessionSwitch(storage, options, input.sessionBearer)),
    authorizeControlGrantReplay: (input) => authorizeControlGrantReplay(storage, options, input),
    revealGrant: (grantId, authority) => revealGrant(storage, options, grantId, authority),
    revealGrantInTransaction: (transaction, grantId, authority) =>
      revealGrantInTransaction(transaction, options, grantId, authority),
    disableGrant: (grantId, authority) =>
      notifyLifecycleChange(
        updateGrantStatus(storage, options, grantId, authority, "disabled", "grant-disabled"),
      ),
    revokeGrant: (grantId, authority) =>
      notifyLifecycleChange(
        updateGrantStatus(storage, options, grantId, authority, "revoked", "grant-revoked"),
      ),
    reactivateGrant: (grantId, authority) =>
      notifyLifecycleChange(reactivateGrant(storage, options, grantId, authority)),
    rotateGrant: (grantId, authority) =>
      notifyLifecycleChange(rotateGrant(storage, options, grantId, authority)),
    rotateGrantInTransaction: (transaction, grantId, authority) =>
      rotateGrantInTransaction(transaction, options, grantId, authority),
    rotateGrantCredentialKeys: (grantId, authority) =>
      notifyLifecycleChange(rotateGrantCredentialKeys(storage, options, grantId, authority)),
    recalculateGrantExpiry: (grantId, correction, authority) =>
      notifyLifecycleChange(recalculateExpiry(storage, options, grantId, correction, authority)),
    revokeGrantSession: (grantId, sessionReference, authority) =>
      notifyLifecycleChange(
        revokeGrantSession(storage, options, grantId, sessionReference, authority),
      ),
    revokeGrantSessionInTransaction: (transaction, grantId, sessionReference, authority) =>
      revokeGrantSessionInTransaction(transaction, options, grantId, sessionReference, authority),
    retireGrantInTransaction: (transaction, input) =>
      retireGrantInTransaction(transaction, options, input),
    leaveGrantSession: (sessionBearer) =>
      notifyLifecycleChange(leaveGrantSession(storage, options, sessionBearer)),
    listGrantSessions: (grantId, authority) => listSessions(storage, options, grantId, authority),
    listGrantSessionsInTransaction: (transaction, grantId, authority) =>
      listSessionsInTransaction(transaction, options, grantId, authority),
    listGrantAudit: (grantId, authority) => listAudit(storage, options, grantId, authority),
  };
}
