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
    admitGrant: (input) => admitGrant(storage, options, input),
    admitPitchManagerGrant: (input) =>
      admitGrant(storage, options, input, PITCH_MANAGER_GRANT_TYPE),
    admitEventAdminGrant: (input) => admitGrant(storage, options, input, EVENT_ADMIN_GRANT_TYPE),
    authorizeGrant: (input) => authorizeGrant(storage, options, input),
    authorizeGrantInTransaction: (transaction, input) =>
      authorizeGrantInTransaction(transaction, options, input),
    acceptControlGrantSessionSwitch: (input) =>
      acceptControlGrantSessionSwitch(storage, options, input.sessionBearer),
    authorizeControlGrantReplay: (input) => authorizeControlGrantReplay(storage, options, input),
    revealGrant: (grantId, authority) => revealGrant(storage, options, grantId, authority),
    revealGrantInTransaction: (transaction, grantId, authority) =>
      revealGrantInTransaction(transaction, options, grantId, authority),
    disableGrant: (grantId, authority) =>
      updateGrantStatus(storage, options, grantId, authority, "disabled", "grant-disabled"),
    revokeGrant: (grantId, authority) =>
      updateGrantStatus(storage, options, grantId, authority, "revoked", "grant-revoked"),
    reactivateGrant: (grantId, authority) => reactivateGrant(storage, options, grantId, authority),
    rotateGrant: (grantId, authority) => rotateGrant(storage, options, grantId, authority),
    rotateGrantInTransaction: (transaction, grantId, authority) =>
      rotateGrantInTransaction(transaction, options, grantId, authority),
    rotateGrantCredentialKeys: (grantId, authority) =>
      rotateGrantCredentialKeys(storage, options, grantId, authority),
    recalculateGrantExpiry: (grantId, correction, authority) =>
      recalculateExpiry(storage, options, grantId, correction, authority),
    revokeGrantSession: (grantId, sessionReference, authority) =>
      revokeGrantSession(storage, options, grantId, sessionReference, authority),
    revokeGrantSessionInTransaction: (transaction, grantId, sessionReference, authority) =>
      revokeGrantSessionInTransaction(transaction, options, grantId, sessionReference, authority),
    retireGrantInTransaction: (transaction, input) =>
      retireGrantInTransaction(transaction, options, input),
    leaveGrantSession: (sessionBearer) => leaveGrantSession(storage, options, sessionBearer),
    listGrantSessions: (grantId, authority) => listSessions(storage, options, grantId, authority),
    listGrantSessionsInTransaction: (transaction, grantId, authority) =>
      listSessionsInTransaction(transaction, options, grantId, authority),
    listGrantAudit: (grantId, authority) => listAudit(storage, options, grantId, authority),
  };
}
