import {
  computeLookupDigest,
  decryptCredential,
  encryptCredential,
  parseCredentialToken,
  sameSecret,
} from "@/lib/grant-crypto";
import type { FoundationStorage } from "@/lib/foundation-storage";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import type { RotateControlGrantCredentialKeysResult } from "@/lib/grant-authority-types";
import { createAuditEntry, expireGrantIfDue, validateActor } from "@/lib/grant-lifecycle";
import type { ControlGrantScope, GrantAuthorityActor, StoredControlGrant } from "@/lib/grant-types";

export async function rotateControlGrantCredentialKeys(
  storage: FoundationStorage,
  options: GrantAuthorityOptions,
  environmentId: string,
  grantId: string,
  actorInput: GrantAuthorityActor,
): Promise<RotateControlGrantCredentialKeysResult> {
  const actor = validateActor(actorInput);
  if (!actor.ok) return rotationFailure();

  return storage
    .transaction<RotateControlGrantCredentialKeysResult>((transaction) => {
      const storedGrant = transaction.findGrantById(grantId);
      if (storedGrant === null) {
        return { status: "rejected", reason: "not-found", detail: "The Grant was not found." };
      }
      const grant = expireGrantIfDue(transaction, options, storedGrant);
      if (grant.status === "expired" || grant.credential.materialState !== "present") {
        return rotationFailure();
      }
      const binding = bindingForGrant(environmentId, grant);
      const token = decryptCredential(grant.credential, binding, options.keyRing);
      if (!credentialCanRotate(token, environmentId, grant, options)) return rotationFailure();

      const rotatedGrant: StoredControlGrant = {
        ...grant,
        credential: encryptCredential(token, binding, options.randomness, options.keyRing),
      };
      transaction.updateGrant(rotatedGrant);
      transaction.appendGrantAudit(
        createAuditEntry(options, {
          action: "credential-rotated",
          actor: { kind: "authority", value: actor.value },
          grant: rotatedGrant,
          sessionId: null,
          replacedSessionId: null,
          eventGameId: null,
          beforeStatus: grant.status,
          afterStatus: rotatedGrant.status,
        }),
      );
      return {
        status: "rotated",
        grantId: rotatedGrant.grantId,
        encryptionKeyVersion: options.keyRing.encryption.currentVersion,
        lookupKeyVersion: options.keyRing.lookup.currentVersion,
      };
    })
    .catch(rotationFailure);
}

function credentialCanRotate(
  token: string | null,
  environmentId: string,
  grant: StoredControlGrant,
  options: GrantAuthorityOptions,
): token is string {
  if (
    token === null ||
    grant.credential.lookupDigest === null ||
    grant.credential.lookupKeyVersion === null
  ) {
    return false;
  }
  const parsed = parseCredentialToken(token);
  return (
    parsed !== null &&
    parsed.environmentId === environmentId &&
    parsed.grantId === grant.grantId &&
    parsed.grantType === grant.grantType &&
    parsed.grantVersion === grant.grantVersion &&
    parsed.credentialKind === grant.credential.kind &&
    parsed.formatVersion === grant.credential.formatVersion &&
    sameScope(parsed.scope, grant.scope) &&
    sameSecret(
      grant.credential.lookupDigest,
      computeLookupDigest(token, options.keyRing, grant.credential.lookupKeyVersion),
    )
  );
}

function bindingForGrant(environmentId: string, grant: StoredControlGrant) {
  return {
    environmentId,
    grantId: grant.grantId,
    grantType: grant.grantType,
    grantVersion: grant.grantVersion,
    scope: grant.scope,
  } as const;
}

function sameScope(left: ControlGrantScope, right: ControlGrantScope): boolean {
  return (
    left.eventId === right.eventId &&
    left.gameDayId === right.gameDayId &&
    left.pitchId === right.pitchId &&
    left.pitchSlotId === right.pitchSlotId
  );
}

function rotationFailure(): RotateControlGrantCredentialKeysResult {
  return {
    status: "rejected",
    reason: "unavailable",
    detail: "The Grant credential cannot be rotated.",
  };
}
