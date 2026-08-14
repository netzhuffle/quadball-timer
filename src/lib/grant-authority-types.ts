import { GRANT_CREDENTIAL_FORMAT_VERSION, GRANT_TYPE } from "@/lib/grant-types";
import type {
  ControlGrantScope,
  ControlGrantSessionDecision,
  GrantAuthorityActor,
  GrantSessionSummary,
  StoredGrantAuditEntry,
} from "@/lib/grant-types";
import type { GrantAuthorityInput } from "@/lib/grant-authority-trust";

export const GENERIC_GRANT_ADMISSION_FAILURE = Object.freeze({
  status: "rejected",
  code: "grant-admission-failed",
  message: "Unable to admit this Grant.",
} as const);

export const GENERIC_GRANT_AUTHORIZATION_FAILURE = Object.freeze({
  status: "rejected",
  code: "grant-authorization-failed",
  message: "Unable to authorize this Grant Session.",
} as const);

export const GENERIC_GRANT_STORAGE_FAILURE = Object.freeze({
  status: "unavailable",
  code: "grant-storage-unavailable",
  message: "Grant authority storage is temporarily unavailable.",
} as const);

export type CreateControlGrantInput = {
  scope: ControlGrantScope;
  actor: GrantAuthorityActor;
  expiresAtMs?: number | null;
};

export type CreateControlGrantResult =
  | {
      status: "created";
      grantId: string;
      grantVersion: string;
      grantType: typeof GRANT_TYPE;
      scope: ControlGrantScope;
      qrCredential: string;
      credentialFormatVersion: typeof GRANT_CREDENTIAL_FORMAT_VERSION;
    }
  | { status: "rejected"; reason: "invalid-input" | "unavailable"; detail: string };

export type AdmitControlGrantInput = {
  qrCredential: string;
  browserContext: string;
};

export type AdmitControlGrantResult =
  | {
      status: "admitted";
      grantId: string;
      grantVersion: string;
      grantType: typeof GRANT_TYPE;
      scope: ControlGrantScope;
      eventGameId: string;
      grantSessionId: string;
      sessionBearer: string;
    }
  | typeof GENERIC_GRANT_ADMISSION_FAILURE;

export type AuthorizeControlGrantInput = {
  sessionBearer: string;
  eventGameId?: string;
  controlSessionDecision?: ControlGrantSessionDecision;
};

export type AuthorizeControlGrantResult =
  | {
      status: "authorized";
      grantId: string;
      grantVersion: string;
      grantType: typeof GRANT_TYPE;
      scope: ControlGrantScope;
      eventGameId: string;
      grantSessionId: string;
    }
  | typeof GENERIC_GRANT_AUTHORIZATION_FAILURE;

export type ControlGrantSessionSwitchResult =
  | {
      status: "switched";
      grantId: string;
      grantVersion: string;
      grantSessionId: string;
      previousEventGameId: string;
      eventGameId: string;
    }
  | typeof GENERIC_GRANT_AUTHORIZATION_FAILURE;

export type ControlGrantReplayAuthorizationResult =
  | {
      status: "authorized";
      grantId: string;
      grantVersion: string;
      grantSessionId: string;
      originatingSessionId: string;
      eventGameId: string;
    }
  | typeof GENERIC_GRANT_AUTHORIZATION_FAILURE;

export type GrantMutationResult =
  | { status: "updated"; grantId: string }
  | {
      status: "rejected";
      reason: "not-found" | "invalid-input" | "invalid-state" | "unavailable";
      detail?: string;
    };

export type RevealControlGrantResult =
  | {
      status: "revealed";
      grantId: string;
      grantVersion: string;
      qrCredential: string;
      credentialFormatVersion: typeof GRANT_CREDENTIAL_FORMAT_VERSION;
    }
  | { status: "rejected"; reason: "not-found" | "unavailable"; detail: string };

export type RotateControlGrantCredentialKeysResult =
  | {
      status: "rotated";
      grantId: string;
      encryptionKeyVersion: string;
      lookupKeyVersion: string;
    }
  | { status: "rejected"; reason: "not-found" | "unavailable"; detail: string };

export type GrantSessionListResult =
  | { status: "ok"; value: GrantSessionSummary[] }
  | typeof GENERIC_GRANT_STORAGE_FAILURE;

export type GrantAuditListResult =
  | { status: "ok"; value: StoredGrantAuditEntry[] }
  | typeof GENERIC_GRANT_STORAGE_FAILURE;

export type GrantAuthority = {
  createControlGrant(input: CreateControlGrantInput): Promise<CreateControlGrantResult>;
  revealControlGrant(
    grantId: string,
    actor: GrantAuthorityActor,
  ): Promise<RevealControlGrantResult>;
  rotateControlGrantCredentialKeys(
    grantId: string,
    actor: GrantAuthorityActor,
  ): Promise<RotateControlGrantCredentialKeysResult>;
  rotateControlGrant(grantId: string, actor: GrantAuthorityActor): Promise<GrantMutationResult>;
  admitControlGrant(input: AdmitControlGrantInput): Promise<AdmitControlGrantResult>;
  authorizeControlGrant(input: AuthorizeControlGrantInput): Promise<AuthorizeControlGrantResult>;
  acceptControlGrantSessionSwitch(input: {
    sessionBearer: string;
  }): Promise<ControlGrantSessionSwitchResult>;
  authorizeControlGrantReplay(input: {
    sessionBearer: string;
    originatingSessionId: string;
    eventGameId: string;
    replayEvidenceId: string;
  }): Promise<ControlGrantReplayAuthorizationResult>;
  disableControlGrant(grantId: string, actor: GrantAuthorityActor): Promise<GrantMutationResult>;
  revokeControlGrant(grantId: string, actor: GrantAuthorityActor): Promise<GrantMutationResult>;
  listGrantSessions(
    grantId: string,
    authority: GrantAuthorityInput,
  ): Promise<GrantSessionListResult>;
  listGrantAudit(grantId: string, authority: GrantAuthorityInput): Promise<GrantAuditListResult>;
};
