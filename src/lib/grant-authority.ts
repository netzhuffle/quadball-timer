import type { FoundationStorage, FoundationStorageTransaction } from "@/lib/foundation-storage";
import type { GrantAuthorityVerifier } from "@/lib/grant-authority-trust";
import { createTypedGrantAuthority, type TypedGrantAuthority } from "@/lib/grant-management";
import type {
  ControlGrantScopeResolver,
  GrantClock,
  GrantKeyRing,
  GrantRandomness,
} from "@/lib/grant-types";

export { createGrantAuthorityVerifier } from "@/lib/grant-authority-trust";
export {
  createTypedGrantAuthority,
  type CreateTypedGrantInput,
  type GrantManagementAuthority,
  type TypedGrantAuthority,
  type TypedControlGrantSwitch,
  type TypedGrantReplayAuthorization,
  type TypedGrantRotated,
} from "@/lib/grant-management";
export type { GrantAuthorityVerification } from "@/lib/grant-authority-trust";
export { EVENT_ADMIN_GRANT_TYPE, GRANT_TYPE, PITCH_MANAGER_GRANT_TYPE } from "@/lib/grant-types";
export type {
  ControlGrantScope,
  ControlGrantScopeResolution,
  ControlGrantScopeResolver,
  ControlGrantSessionResolution,
  ControlGrantReplayResolution,
  ControlGrantSessionDecision,
  GrantClock,
  GrantAuthorityActor,
  GrantKeyRing,
  GrantRandomness,
} from "@/lib/grant-types";
export {
  GENERIC_GRANT_ADMISSION_FAILURE,
  GENERIC_GRANT_STORAGE_FAILURE,
} from "@/lib/grant-authority-types";

export type GrantAuthorityOptions = {
  environmentId: string;
  clock: GrantClock;
  randomness: GrantRandomness;
  keyRing: GrantKeyRing;
  controlScopeResolver: ControlGrantScopeResolver;
  controlGrantLifecycle?: {
    /** Trusted Event Game lifecycle seam for atomic Game Lock transitions. */
    resolveEventGameLock: (
      evidence: unknown,
    ) => { eventGameId: string; apply(transaction: FoundationStorageTransaction): void } | null;
  };
  privilegedAuthorityVerifier: GrantAuthorityVerifier;
  /** Refresh cheap Event capacity snapshots after lifecycle mutations. */
  onLifecycleChange?: () => void;
};

/** The single public Grant facade. All Grant types use the trusted typed lifecycle. */
export function createGrantAuthority(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
): TypedGrantAuthority {
  return createTypedGrantAuthority(storage, options);
}
