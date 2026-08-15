import {
  GRANT_CREDENTIAL_FORMAT_VERSION,
  type ControlGrantScope,
  type ControlGrantSessionDecision,
  type EventAdminGrantScope,
  type GrantScope,
  type GrantType,
  type PitchManagerGrantScope,
  type StoredGrantAuditEntry,
} from "@/lib/grant-types";
import {
  GENERIC_GRANT_ADMISSION_FAILURE,
  GENERIC_GRANT_AUTHORIZATION_FAILURE,
  GENERIC_GRANT_STORAGE_FAILURE,
} from "@/lib/grant-authority-types";
import type { GrantAuthorityInput } from "@/lib/grant-authority-trust";
import type { FoundationStorageTransaction } from "@/lib/foundation-storage";
import type { GrantLifecycleMetadataCorrection } from "@/lib/grant-management-lifecycle";

export type GrantManagementAuthority = GrantAuthorityInput;

export type CreateTypedGrantInput = {
  grantType: GrantType;
  scope: GrantScope;
  authority: GrantManagementAuthority;
  expiresAtMs?: number | null;
};

export type TypedGrantCreated = {
  status: "created";
  grantId: string;
  grantVersion: string;
  grantType: GrantType;
  scope: GrantScope;
  qrCredential: string;
  credentialFormatVersion: typeof GRANT_CREDENTIAL_FORMAT_VERSION;
  expiresAtMs: number | null;
};

export type TypedGrantAdmission =
  | {
      status: "admitted";
      grantId: string;
      grantVersion: string;
      grantType: GrantType;
      scope: GrantScope;
      eventGameId: string | null;
      grantSessionId: string;
      sessionBearer: string;
      sessionExpiresAtMs?: number | null;
    }
  | typeof GENERIC_GRANT_ADMISSION_FAILURE;

export type TypedGrantAdmissionThrottled = {
  status: "rejected";
  code: "grant-admission-throttled";
  message: "Retry Grant admission later.";
  retryAfterMs: number;
};

export type TypedGrantCodeCreated = {
  status: "created" | "replaced";
  grantId: string;
  grantVersion: string;
  code: string;
  formatVersion: 1;
};

/** Secret-bearing full rotation material is returned once and is never durable. */
export type TypedGrantRotated = {
  status: "updated";
  grantId: string;
  grantVersion: string;
  qrCredential: string;
  credentialFormatVersion: typeof GRANT_CREDENTIAL_FORMAT_VERSION;
  code: string;
  codeFormatVersion: 1;
  oneTime: true;
  noStore: true;
  affectedSessionCount: number;
};

export type TypedGrantAuthorization =
  | {
      status: "authorized";
      grantId: string;
      grantVersion: string;
      grantType: GrantType;
      scope: GrantScope;
      eventGameId: string | null;
      grantSessionId: string;
      sessionExpiresAtMs?: number | null;
    }
  | {
      status: "switch-required";
      grantId: string;
      grantVersion: string;
      grantType: "control";
      scope: ControlGrantScope;
      grantSessionId: string;
      previousEventGameId: string;
      currentEventGameId: string;
    }
  | typeof GENERIC_GRANT_AUTHORIZATION_FAILURE;

export type TypedControlGrantSwitch =
  | {
      status: "switched";
      grantId: string;
      grantVersion: string;
      grantSessionId: string;
      previousEventGameId: string;
      eventGameId: string;
    }
  | typeof GENERIC_GRANT_AUTHORIZATION_FAILURE;

export type TypedGrantReplayAuthorization =
  | {
      status: "authorized";
      grantId: string;
      grantVersion: string;
      grantSessionId: string;
      originatingSessionId: string;
      eventGameId: string;
      replayEvidenceId: string;
    }
  | typeof GENERIC_GRANT_AUTHORIZATION_FAILURE;

export type TypedGrantMutation =
  | { status: "updated"; grantId: string; grantVersion?: string }
  | {
      status: "rejected";
      reason: "not-found" | "invalid-input" | "invalid-state" | "unauthorized" | "unavailable";
      detail?: string;
    };

export type TypedGrantReveal =
  | {
      status: "revealed";
      grantId: string;
      grantVersion: string;
      grantType: GrantType;
      qrCredential: string;
      credentialFormatVersion: typeof GRANT_CREDENTIAL_FORMAT_VERSION;
    }
  | { status: "rejected"; reason: "not-found" | "unauthorized" | "unavailable"; detail: string };

export type TypedSessionSummary = {
  label: string;
  createdAtMs: number;
  lastActiveAtMs: number;
  deviceClass: string;
  browserClass: string;
};

export type TypedGrantAuthority = {
  createGrant(input: CreateTypedGrantInput): Promise<TypedGrantCreated | TypedGrantMutation>;
  createEventAdminGrant(
    input: Omit<CreateTypedGrantInput, "grantType"> & { scope: EventAdminGrantScope },
  ): Promise<TypedGrantCreated | TypedGrantMutation>;
  /**
   * The composed Event Administration seam. Callers must invoke this inside the Foundation
   * transaction that revalidates Event membership and Game Day state.
   */
  createEventAdminGrantInTransaction(
    transaction: FoundationStorageTransaction,
    input: Omit<CreateTypedGrantInput, "grantType"> & { scope: EventAdminGrantScope },
  ): TypedGrantCreated | TypedGrantMutation;
  createPitchManagerGrant(
    input: Omit<CreateTypedGrantInput, "grantType"> & { scope: PitchManagerGrantScope },
  ): Promise<TypedGrantCreated | TypedGrantMutation>;
  createPitchManagerGrantInTransaction(
    transaction: FoundationStorageTransaction,
    input: Omit<CreateTypedGrantInput, "grantType"> & { scope: PitchManagerGrantScope },
  ): TypedGrantCreated | TypedGrantMutation;
  createControlGrant(
    input: Omit<CreateTypedGrantInput, "grantType"> & { scope: ControlGrantScope },
  ): Promise<TypedGrantCreated | TypedGrantMutation>;
  createControlGrantInTransaction(
    transaction: FoundationStorageTransaction,
    input: Omit<CreateTypedGrantInput, "grantType"> & { scope: ControlGrantScope },
  ): TypedGrantCreated | TypedGrantMutation;
  createGrantCode(
    grantId: string,
    authority: GrantManagementAuthority,
  ): Promise<TypedGrantCodeCreated | TypedGrantMutation>;
  replaceGrantCode(
    grantId: string,
    authority: GrantManagementAuthority,
  ): Promise<TypedGrantCodeCreated | TypedGrantMutation>;
  disableGrantCode(
    grantId: string,
    authority: GrantManagementAuthority,
  ): Promise<TypedGrantMutation>;
  admitGrantCode(input: {
    grantCode: string;
    browserContext: string;
    deviceClass?: string;
    browserClass?: string;
  }): Promise<TypedGrantAdmission | TypedGrantAdmissionThrottled>;
  admitGrant(input: {
    qrCredential: string;
    browserContext: string;
    deviceClass?: string;
    browserClass?: string;
  }): Promise<TypedGrantAdmission | TypedGrantAdmissionThrottled>;
  admitPitchManagerGrant(input: {
    qrCredential: string;
    browserContext: string;
    deviceClass?: string;
    browserClass?: string;
  }): Promise<TypedGrantAdmission | TypedGrantAdmissionThrottled>;
  admitEventAdminGrant(input: {
    qrCredential: string;
    browserContext: string;
    deviceClass?: string;
    browserClass?: string;
  }): Promise<TypedGrantAdmission | TypedGrantAdmissionThrottled>;
  authorizeGrant(input: {
    sessionBearer: string;
    eventGameId?: string;
    controlSessionDecision?: ControlGrantSessionDecision;
    readOnly?: boolean;
  }): Promise<TypedGrantAuthorization>;
  /** Revalidates and refreshes a Grant Session on the caller's existing transaction. */
  authorizeGrantInTransaction(
    transaction: FoundationStorageTransaction,
    input: { sessionBearer: string; readOnly?: boolean },
  ): TypedGrantAuthorization;
  acceptControlGrantSessionSwitch(input: {
    sessionBearer: string;
  }): Promise<TypedControlGrantSwitch>;
  authorizeControlGrantReplay(input: {
    sessionBearer: string;
    originatingSessionId: string;
    eventGameId: string;
    replayEvidenceId: string;
  }): Promise<TypedGrantReplayAuthorization>;
  revealGrant(grantId: string, authority: GrantManagementAuthority): Promise<TypedGrantReveal>;
  revealGrantInTransaction(
    transaction: FoundationStorageTransaction,
    grantId: string,
    authority: GrantManagementAuthority,
  ): TypedGrantReveal;
  disableGrant(grantId: string, authority: GrantManagementAuthority): Promise<TypedGrantMutation>;
  revokeGrant(grantId: string, authority: GrantManagementAuthority): Promise<TypedGrantMutation>;
  reactivateGrant(
    grantId: string,
    authority: GrantManagementAuthority,
  ): Promise<TypedGrantMutation>;
  rotateGrant(
    grantId: string,
    authority: GrantManagementAuthority,
  ): Promise<TypedGrantRotated | TypedGrantMutation>;
  rotateGrantInTransaction(
    transaction: FoundationStorageTransaction,
    grantId: string,
    authority: GrantManagementAuthority,
  ): TypedGrantRotated | TypedGrantMutation;
  rotateGrantCredentialKeys(
    grantId: string,
    authority: GrantManagementAuthority,
  ): Promise<TypedGrantMutation>;
  recalculateGrantExpiry(
    grantId: string,
    correction: GrantLifecycleMetadataCorrection,
    authority: GrantManagementAuthority,
  ): Promise<TypedGrantMutation>;
  revokeGrantSession(
    grantId: string,
    sessionReference: string,
    authority: GrantManagementAuthority,
  ): Promise<TypedGrantMutation>;
  revokeGrantSessionInTransaction(
    transaction: FoundationStorageTransaction,
    grantId: string,
    sessionReference: string,
    authority: GrantManagementAuthority,
  ): TypedGrantMutation;
  leaveGrantSession(sessionBearer: string): Promise<TypedGrantMutation>;
  listGrantSessions(
    grantId: string,
    authority: GrantManagementAuthority,
  ): Promise<{ status: "ok"; value: TypedSessionSummary[] } | typeof GENERIC_GRANT_STORAGE_FAILURE>;
  listGrantSessionsInTransaction(
    transaction: FoundationStorageTransaction,
    grantId: string,
    authority: GrantManagementAuthority,
  ): { status: "ok"; value: TypedSessionSummary[] } | typeof GENERIC_GRANT_STORAGE_FAILURE;
  listGrantAudit(
    grantId: string,
    authority: GrantManagementAuthority,
  ): Promise<
    { status: "ok"; value: StoredGrantAuditEntry[] } | typeof GENERIC_GRANT_STORAGE_FAILURE
  >;
};
