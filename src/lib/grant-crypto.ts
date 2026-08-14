import { createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from "node:crypto";
import {
  GRANT_CREDENTIAL_FORMAT_VERSION,
  GRANT_CREDENTIAL_KIND,
  GRANT_TYPE,
  validateGrantScope,
  type GrantScope,
  type GrantType,
  type GrantKeyRing,
  type GrantRandomness,
  type StoredGrant,
  type StoredGrantAuditEntry,
  type StoredGrantCredential,
} from "@/lib/grant-types";

const CREDENTIAL_ENTROPY_BYTES = 32;
const AES_KEY_BYTES = 32;
const HMAC_KEY_MIN_BYTES = 32;
const AES_IV_BYTES = 12;
const AES_TAG_BYTES = 16;

export type CredentialEnvelope = {
  formatVersion: typeof GRANT_CREDENTIAL_FORMAT_VERSION;
  environmentId: string;
  grantId: string;
  grantType: GrantType;
  scope: GrantScope;
  grantVersion: string;
  credentialKind: typeof GRANT_CREDENTIAL_KIND;
  entropy: string;
};

type CredentialBinding = Pick<StoredGrant, "grantId" | "grantType" | "grantVersion" | "scope"> & {
  environmentId: string;
};

export class GrantCryptoConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantCryptoConfigurationError";
  }
}

export function createCredentialToken(
  binding: CredentialBinding,
  randomness: GrantRandomness,
): string {
  const entropy = randomness.bytes(CREDENTIAL_ENTROPY_BYTES);
  if (entropy.byteLength !== CREDENTIAL_ENTROPY_BYTES) {
    throw new GrantCryptoConfigurationError("Injected credential randomness has an invalid size.");
  }

  return encodeBase64Url(
    new TextEncoder().encode(
      canonicalize({
        formatVersion: GRANT_CREDENTIAL_FORMAT_VERSION,
        environmentId: binding.environmentId,
        grantId: binding.grantId,
        grantType: binding.grantType,
        scope: binding.scope,
        grantVersion: binding.grantVersion,
        credentialKind: GRANT_CREDENTIAL_KIND,
        entropy: encodeBase64Url(entropy),
      } satisfies CredentialEnvelope),
    ),
  );
}

export function parseCredentialToken(value: unknown): CredentialEnvelope | null {
  if (typeof value !== "string") return null;
  const bytes = decodeBase64Url(value);
  if (bytes === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (
    parsed.formatVersion !== GRANT_CREDENTIAL_FORMAT_VERSION ||
    typeof parsed.environmentId !== "string" ||
    typeof parsed.grantId !== "string" ||
    (parsed.grantType !== GRANT_TYPE &&
      parsed.grantType !== "event-admin" &&
      parsed.grantType !== "pitch-manager") ||
    typeof parsed.grantVersion !== "string" ||
    parsed.credentialKind !== GRANT_CREDENTIAL_KIND ||
    typeof parsed.entropy !== "string"
  ) {
    return null;
  }

  const scope = validateGrantScope(parsed.grantType, parsed.scope);
  if (!scope.ok) return null;
  const entropy = decodeBase64Url(parsed.entropy);
  if (entropy === null || entropy.byteLength !== CREDENTIAL_ENTROPY_BYTES) return null;

  return {
    formatVersion: GRANT_CREDENTIAL_FORMAT_VERSION,
    environmentId: parsed.environmentId,
    grantId: parsed.grantId,
    grantType: parsed.grantType,
    scope: scope.value,
    grantVersion: parsed.grantVersion,
    credentialKind: GRANT_CREDENTIAL_KIND,
    entropy: parsed.entropy,
  };
}

export function encryptCredential(
  token: string,
  binding: CredentialBinding,
  randomness: GrantRandomness,
  keyRing: GrantKeyRing,
): StoredGrantCredential {
  const encryptionKeyVersion = keyRing.encryption.currentVersion;
  const encryptionKey = getAesKey(keyRing.encryption.keys, encryptionKeyVersion);
  const lookupKeyVersion = keyRing.lookup.currentVersion;
  const lookupKey = getKey(keyRing.lookup.keys, lookupKeyVersion, HMAC_KEY_MIN_BYTES);
  const iv = randomness.bytes(AES_IV_BYTES);
  if (iv.byteLength !== AES_IV_BYTES) {
    throw new GrantCryptoConfigurationError("Injected encryption randomness has an invalid size.");
  }

  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(new TextEncoder().encode(canonicalizeBinding(binding)));
  const ciphertext = new Uint8Array(
    Buffer.concat([cipher.update(Buffer.from(token, "utf8")), cipher.final()]),
  );
  const tag = new Uint8Array(cipher.getAuthTag());
  if (tag.byteLength !== AES_TAG_BYTES) {
    throw new GrantCryptoConfigurationError("AES-GCM returned an invalid authentication tag.");
  }
  const lookupDigest = hmac(lookupKey, token);

  return {
    materialState: "present",
    formatVersion: GRANT_CREDENTIAL_FORMAT_VERSION,
    kind: GRANT_CREDENTIAL_KIND,
    encryptionKeyVersion,
    lookupKeyVersion,
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(ciphertext),
    tag: encodeBase64Url(tag),
    lookupDigest: encodeBase64Url(lookupDigest),
    fingerprint: computeCredentialFingerprint(token, keyRing, lookupKeyVersion),
  };
}

export function computeCredentialFingerprint(
  token: string,
  keyRing: GrantKeyRing,
  keyVersion = keyRing.lookup.currentVersion,
): string {
  return encodeBase64Url(
    hmac(getKey(keyRing.lookup.keys, keyVersion, HMAC_KEY_MIN_BYTES), `grant-fingerprint:${token}`),
  );
}

export function decryptCredential(
  stored: StoredGrantCredential,
  binding: CredentialBinding,
  keyRing: GrantKeyRing,
): string | null {
  if (
    stored.materialState !== "present" ||
    stored.formatVersion !== GRANT_CREDENTIAL_FORMAT_VERSION ||
    stored.kind !== GRANT_CREDENTIAL_KIND ||
    typeof stored.encryptionKeyVersion !== "string" ||
    typeof stored.lookupKeyVersion !== "string" ||
    typeof stored.iv !== "string" ||
    typeof stored.ciphertext !== "string" ||
    typeof stored.tag !== "string" ||
    typeof stored.lookupDigest !== "string"
  ) {
    return null;
  }

  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  let tag: Uint8Array;
  try {
    iv = requireBase64Url(stored.iv);
    ciphertext = requireBase64Url(stored.ciphertext);
    tag = requireBase64Url(stored.tag);
  } catch {
    return null;
  }
  if (iv.byteLength !== AES_IV_BYTES || tag.byteLength !== AES_TAG_BYTES) return null;

  let encryptionKey: Uint8Array;
  try {
    encryptionKey = getAesKey(keyRing.encryption.keys, stored.encryptionKeyVersion);
  } catch {
    return null;
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
    decipher.setAAD(new TextEncoder().encode(canonicalizeBinding(binding)));
    decipher.setAuthTag(tag);
    const token = Buffer.concat([
      decipher.update(Buffer.from(ciphertext)),
      decipher.final(),
    ]).toString("utf8");
    return token;
  } catch {
    return null;
  }
}

export function computeLookupDigest(
  token: string,
  keyRing: GrantKeyRing,
  keyVersion = keyRing.lookup.currentVersion,
): string {
  const key = getKey(keyRing.lookup.keys, keyVersion, HMAC_KEY_MIN_BYTES);
  return encodeBase64Url(hmac(key, token));
}

export function computeSessionVerifier(
  bearer: string,
  keyRing: GrantKeyRing,
  keyVersion = keyRing.lookup.currentVersion,
): string {
  return computeLookupDigest(bearer, keyRing, keyVersion);
}

export function computeGrantAuditIntegrityTag(
  entry: StoredGrantAuditEntry,
  keyRing: GrantKeyRing,
  keyVersion = keyRing.audit.currentVersion,
): string {
  return computeGrantAuditIntegrityTagWithPreviousEventGameId(entry, keyRing, keyVersion, true);
}

/** Compatibility verifier for keyed audit rows written before migration 015. */
export function computeLegacyGrantAuditIntegrityTag(
  entry: StoredGrantAuditEntry,
  keyRing: GrantKeyRing,
  keyVersion = keyRing.audit.currentVersion,
): string {
  return computeGrantAuditIntegrityTagWithPreviousEventGameId(entry, keyRing, keyVersion, false);
}

function computeGrantAuditIntegrityTagWithPreviousEventGameId(
  entry: StoredGrantAuditEntry,
  keyRing: GrantKeyRing,
  keyVersion: string,
  includePreviousEventGameId: boolean,
): string {
  const payload = JSON.stringify({
    domain: "grant-audit-integrity-v1",
    auditId: entry.auditId,
    action: entry.action,
    outcome: entry.outcome,
    actorReference: entry.actorReference,
    grantId: entry.grantId,
    grantType: entry.grantType,
    grantVersion: entry.grantVersion,
    scope: entry.scope,
    sessionId: entry.sessionId,
    replacedSessionId: entry.replacedSessionId,
    eventGameId: entry.eventGameId,
    ...(includePreviousEventGameId
      ? { previousEventGameId: entry.previousEventGameId ?? null }
      : {}),
    ...(includePreviousEventGameId && entry.replayEvidenceId !== null
      ? { replayEvidenceId: entry.replayEvidenceId }
      : {}),
    credentialKind: entry.credentialKind,
    credentialFingerprint: entry.credentialFingerprint,
    beforeStatus: entry.beforeStatus,
    afterStatus: entry.afterStatus,
    beforeExpiresAtMs: entry.beforeExpiresAtMs,
    afterExpiresAtMs: entry.afterExpiresAtMs,
    terminalReason: entry.terminalReason,
    createdAtMs: entry.createdAtMs,
  });
  return `hmac-sha256-v1:${keyVersion}:${encodeBase64Url(
    hmac(getKey(keyRing.audit.keys, keyVersion, HMAC_KEY_MIN_BYTES), payload),
  )}`;
}

export function computeBrowserContextDigest(
  browserContext: string,
  keyRing: GrantKeyRing,
  keyVersion = keyRing.lookup.currentVersion,
): string {
  return computeLookupDigest(`browser-context:${browserContext}`, keyRing, keyVersion);
}

export function listLookupKeyVersions(keyRing: GrantKeyRing): string[] {
  return [...keyRing.lookup.keys.keys()];
}

export function createRandomIdentifier(prefix: string, randomness: GrantRandomness): string {
  const bytes = randomness.bytes(16);
  if (bytes.byteLength !== 16) {
    throw new GrantCryptoConfigurationError("Injected identifier randomness has an invalid size.");
  }
  return `${prefix}-${encodeBase64Url(bytes)}`;
}

export function sameSecret(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function canonicalize(value: unknown): string {
  return JSON.stringify(value);
}

function canonicalizeBinding(binding: CredentialBinding): string {
  return canonicalize({
    formatVersion: GRANT_CREDENTIAL_FORMAT_VERSION,
    environmentId: binding.environmentId,
    grantId: binding.grantId,
    grantType: binding.grantType,
    scope: binding.scope,
    grantVersion: binding.grantVersion,
    credentialKind: GRANT_CREDENTIAL_KIND,
  });
}

function hmac(key: Uint8Array, value: string): Uint8Array {
  return new Uint8Array(createHmac("sha256", key).update(value, "utf8").digest());
}

function getKey(
  keys: ReadonlyMap<string, Uint8Array>,
  version: string,
  minimumBytes: number,
): Uint8Array {
  const key = keys.get(version);
  if (key === undefined || key.byteLength < minimumBytes) {
    throw new GrantCryptoConfigurationError("The required Grant key version is unavailable.");
  }
  return key;
}

function getAesKey(keys: ReadonlyMap<string, Uint8Array>, version: string): Uint8Array {
  const key = keys.get(version);
  if (key === undefined || key.byteLength !== AES_KEY_BYTES) {
    throw new GrantCryptoConfigurationError("The required Grant encryption key is unavailable.");
  }
  return key;
}

function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const bytes = new Uint8Array(Buffer.from(value, "base64url"));
    return encodeBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function requireBase64Url(value: string): Uint8Array {
  const decoded = decodeBase64Url(value);
  if (decoded === null)
    throw new GrantCryptoConfigurationError("Stored Grant material is invalid.");
  return decoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
