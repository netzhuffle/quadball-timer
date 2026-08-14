import {
  GRANT_CREDENTIAL_FORMAT_VERSION,
  type ControlGrantScope,
  type EventAdminGrantScope,
  type GrantScope,
  type GrantType,
  type PitchManagerGrantScope,
  type StoredGrantAuditEntry,
  type StoredGrantSession,
} from "@/lib/grant-types";
import {
  GENERIC_GRANT_ADMISSION_FAILURE,
  GENERIC_GRANT_AUTHORIZATION_FAILURE,
  GENERIC_GRANT_STORAGE_FAILURE,
} from "@/lib/grant-authority-types";
import type { GrantAuthorityInput } from "@/lib/grant-authority-trust";
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
    }
  | typeof GENERIC_GRANT_ADMISSION_FAILURE;

export type TypedGrantAuthorization =
  | {
      status: "authorized";
      grantId: string;
      grantVersion: string;
      grantType: GrantType;
      scope: GrantScope;
      eventGameId: string | null;
      grantSessionId: string;
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
  status: StoredGrantSession["status"];
  createdAtMs: number;
  lastActiveAtMs: number;
  revokedAtMs: number | null;
  deviceClass: string;
  browserClass: string;
};

export type TypedGrantAuthority = {
  createGrant(input: CreateTypedGrantInput): Promise<TypedGrantCreated | TypedGrantMutation>;
  createEventAdminGrant(
    input: Omit<CreateTypedGrantInput, "grantType"> & { scope: EventAdminGrantScope },
  ): Promise<TypedGrantCreated | TypedGrantMutation>;
  createPitchManagerGrant(
    input: Omit<CreateTypedGrantInput, "grantType"> & { scope: PitchManagerGrantScope },
  ): Promise<TypedGrantCreated | TypedGrantMutation>;
  createControlGrant(
    input: Omit<CreateTypedGrantInput, "grantType"> & { scope: ControlGrantScope },
  ): Promise<TypedGrantCreated | TypedGrantMutation>;
  admitGrant(input: {
    qrCredential: string;
    browserContext: string;
    deviceClass?: string;
    browserClass?: string;
  }): Promise<TypedGrantAdmission>;
  authorizeGrant(input: { sessionBearer: string }): Promise<TypedGrantAuthorization>;
  revealGrant(grantId: string, authority: GrantManagementAuthority): Promise<TypedGrantReveal>;
  disableGrant(grantId: string, authority: GrantManagementAuthority): Promise<TypedGrantMutation>;
  revokeGrant(grantId: string, authority: GrantManagementAuthority): Promise<TypedGrantMutation>;
  reactivateGrant(
    grantId: string,
    authority: GrantManagementAuthority,
  ): Promise<TypedGrantMutation>;
  rotateGrant(grantId: string, authority: GrantManagementAuthority): Promise<TypedGrantMutation>;
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
  leaveGrantSession(sessionBearer: string): Promise<TypedGrantMutation>;
  listGrantSessions(
    grantId: string,
    authority: GrantManagementAuthority,
  ): Promise<{ status: "ok"; value: TypedSessionSummary[] } | typeof GENERIC_GRANT_STORAGE_FAILURE>;
  listGrantAudit(
    grantId: string,
    authority: GrantManagementAuthority,
  ): Promise<
    { status: "ok"; value: StoredGrantAuditEntry[] } | typeof GENERIC_GRANT_STORAGE_FAILURE
  >;
};
