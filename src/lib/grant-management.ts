import type { FoundationStorage } from "@/lib/foundation-storage";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import { EVENT_ADMIN_GRANT_TYPE, GRANT_TYPE, PITCH_MANAGER_GRANT_TYPE } from "@/lib/grant-types";
import { createGrant, reactivateGrant, updateGrantStatus } from "@/lib/grant-management-commands";
import {
  revealGrant,
  rotateGrant,
  rotateGrantCredentialKeys,
} from "@/lib/grant-management-credentials";
import { recalculateExpiry } from "@/lib/grant-management-lifecycle";
import { listAudit, listSessions } from "@/lib/grant-management-queries";
import {
  admitGrant,
  authorizeGrant,
  leaveGrantSession,
  revokeGrantSession,
} from "@/lib/grant-management-sessions";
import type { TypedGrantAuthority } from "@/lib/grant-management-types";

export type {
  CreateTypedGrantInput,
  GrantManagementAuthority,
  TypedGrantAdmission,
  TypedGrantAuthorization,
  TypedGrantAuthority,
  TypedGrantCreated,
  TypedGrantMutation,
  TypedGrantReveal,
  TypedSessionSummary,
} from "@/lib/grant-management-types";
export type { GrantLifecycleMetadataCorrection } from "@/lib/grant-management-lifecycle";

/** Narrow composition root for typed Grant commands, credentials, sessions, and queries. */
export function createTypedGrantAuthority(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
): TypedGrantAuthority {
  storage.setGrantValidationContext?.({
    environmentId: options.environmentId,
    keyRing: options.keyRing,
  });
  storage.setGrantKeyRing?.(options.keyRing);
  return {
    createGrant: (input) => createGrant(storage, options, input),
    createEventAdminGrant: (input) =>
      createGrant(storage, options, { ...input, grantType: EVENT_ADMIN_GRANT_TYPE }),
    createPitchManagerGrant: (input) =>
      createGrant(storage, options, { ...input, grantType: PITCH_MANAGER_GRANT_TYPE }),
    createControlGrant: (input) =>
      createGrant(storage, options, { ...input, grantType: GRANT_TYPE }),
    admitGrant: (input) => admitGrant(storage, options, input),
    authorizeGrant: (input) => authorizeGrant(storage, options, input.sessionBearer),
    revealGrant: (grantId, authority) => revealGrant(storage, options, grantId, authority),
    disableGrant: (grantId, authority) =>
      updateGrantStatus(storage, options, grantId, authority, "disabled", "grant-disabled"),
    revokeGrant: (grantId, authority) =>
      updateGrantStatus(storage, options, grantId, authority, "revoked", "grant-revoked"),
    reactivateGrant: (grantId, authority) => reactivateGrant(storage, options, grantId, authority),
    rotateGrant: (grantId, authority) => rotateGrant(storage, options, grantId, authority),
    rotateGrantCredentialKeys: (grantId, authority) =>
      rotateGrantCredentialKeys(storage, options, grantId, authority),
    recalculateGrantExpiry: (grantId, correction, authority) =>
      recalculateExpiry(storage, options, grantId, correction, authority),
    revokeGrantSession: (grantId, sessionReference, authority) =>
      revokeGrantSession(storage, options, grantId, sessionReference, authority),
    leaveGrantSession: (sessionBearer) => leaveGrantSession(storage, options, sessionBearer),
    listGrantSessions: (grantId, authority) => listSessions(storage, options, grantId, authority),
    listGrantAudit: (grantId, authority) => listAudit(storage, options, grantId, authority),
  };
}
