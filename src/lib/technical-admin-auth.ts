import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type TechnicalAdminEnvironment = "production" | "test";

export type TechnicalAdminAuthConfig = {
  environment: TechnicalAdminEnvironment;
  origin: string;
  rpId: string;
  databasePath?: string;
};

export type CeremonyBinding = {
  origin: string;
  host: string;
};

export type EnrollmentAuthorization = {
  url: string;
  expiresAtMs: number;
};

export type RegistrationOptions = {
  challengeId: string;
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  timeout: number;
  attestation: "none";
  authenticatorSelection: { residentKey: "required"; userVerification: "required" };
};

export type AuthenticationOptions = {
  challengeId: string;
  challenge: string;
  rpId: string;
  allowCredentials: Array<{ id: string; type: "public-key" }>;
  timeout: number;
  userVerification: "required";
};

export type TechnicalAdminSession = {
  token: string;
  expiresAtMs: number;
};

export type AuthFailure =
  | "not-enrollable"
  | "invalid-enrollment"
  | "invalid-ceremony"
  | "invalid-credentials"
  | "not-authenticated"
  | "storage-failure";

export type AuthResult<T> = { ok: true; value: T } | { ok: false; error: AuthFailure };

export type CredentialRecord = {
  credentialId: string;
  publicKey: JsonWebKey;
  signCount: number;
  createdAtMs: number;
};

type ChallengeRecord = {
  id: string;
  value: string;
  purpose: "registration" | "authentication";
  expiresAtMs: number;
  usedAtMs: number | null;
};

type SessionRecord = {
  id: string;
  tokenHash: string;
  createdAtMs: number;
  lastSeenAtMs: number;
  absoluteExpiresAtMs: number;
  revokedAtMs: number | null;
};

type EnrollmentRecord = {
  tokenHash: string;
  expiresAtMs: number;
  usedAtMs: number | null;
};

export interface TechnicalAdminAuthRepository {
  hasCredential(): boolean;
  getCredential(): CredentialRecord | null;
  issueEnrollment(tokenHash: string, expiresAtMs: number): void;
  consumeEnrollment(tokenHash: string, nowMs: number): boolean;
  createChallenge(challenge: ChallengeRecord): void;
  consumeChallenge(id: string, purpose: ChallengeRecord["purpose"], nowMs: number): string | null;
  commitEnrollment(challengeId: string, credential: CredentialRecord): boolean;
  commitAuthentication(
    challengeId: string,
    credentialId: string,
    signCount: number,
    session: SessionRecord,
  ): boolean;
  getSession(tokenHash: string): SessionRecord | null;
  touchSession(id: string, nowMs: number): void;
  revokeSession(id: string, nowMs: number): void;
}

export type TechnicalAdminStorageIdentity = {
  environment: TechnicalAdminEnvironment;
  origin: string;
  rpId: string;
};

const ENROLLMENT_TTL_MS = 10 * 60 * 1_000;
const CHALLENGE_TTL_MS = 5 * 60 * 1_000;
const SESSION_IDLE_TTL_MS = 2 * 60 * 60 * 1_000;
const SESSION_ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1_000;
const TOKEN_BYTES = 32;

export function createTechnicalAdminAuth(
  config: TechnicalAdminAuthConfig,
  repository: TechnicalAdminAuthRepository,
  verifier: WebAuthnVerifier = new NativeWebAuthnVerifier(),
  now: () => number = () => Date.now(),
): TechnicalAdminAuth {
  const expectedOrigin = new URL(config.origin).origin;
  const expectedUrl = new URL(config.origin);
  const expectedHost = expectedUrl.host;
  if (
    expectedOrigin !== config.origin ||
    expectedUrl.protocol !== "https:" ||
    config.rpId !== expectedUrl.hostname
  ) {
    throw new Error("Technical Admin origin must be an exact origin.");
  }

  return {
    issueEnrollmentAuthorization(): AuthResult<EnrollmentAuthorization> {
      try {
        if (repository.hasCredential()) return { ok: false, error: "not-enrollable" };
        const secret = randomToken();
        const expiresAtMs = now() + ENROLLMENT_TTL_MS;
        repository.issueEnrollment(hashToken(secret), expiresAtMs);
        return {
          ok: true,
          value: {
            url: `${config.origin}/admin/enroll#token=${encodeURIComponent(secret)}`,
            expiresAtMs,
          },
        };
      } catch {
        return { ok: false, error: "storage-failure" };
      }
    },

    beginEnrollment(token: string, binding: CeremonyBinding): AuthResult<RegistrationOptions> {
      try {
        if (!isExactBinding(binding, expectedOrigin, expectedHost) || repository.hasCredential()) {
          return { ok: false, error: "invalid-enrollment" };
        }
        const current = now();
        if (!repository.consumeEnrollment(hashToken(token), current)) {
          return { ok: false, error: "invalid-enrollment" };
        }
        const challenge = createChallenge("registration", current);
        repository.createChallenge(challenge);
        return {
          ok: true,
          value: {
            challengeId: challenge.id,
            challenge: challenge.value,
            rp: { id: config.rpId, name: "Quadball Timer" },
            user: {
              id: base64UrlEncode(
                new TextEncoder().encode(`${config.environment}:technical-admin`),
              ),
              name: "technical-admin",
              displayName: "Technical Admin",
            },
            timeout: CHALLENGE_TTL_MS,
            attestation: "none",
            authenticatorSelection: { residentKey: "required", userVerification: "required" },
          },
        };
      } catch {
        return { ok: false, error: "storage-failure" };
      }
    },

    async completeEnrollment(
      challengeId: string,
      response: unknown,
      binding: CeremonyBinding,
    ): Promise<AuthResult<void>> {
      if (!isExactBinding(binding, expectedOrigin, expectedHost)) {
        return { ok: false, error: "invalid-ceremony" };
      }
      try {
        const challenge = consumeChallenge(repository, challengeId, "registration", now());
        if (challenge === null || repository.hasCredential()) {
          return { ok: false, error: "invalid-ceremony" };
        }
        const credential = await verifier.verifyRegistration(response, {
          challenge,
          origin: expectedOrigin,
          rpId: config.rpId,
          requireUserVerification: true,
        });
        if (
          !repository.commitEnrollment(challengeId, {
            ...credential,
            createdAtMs: now(),
          })
        ) {
          return { ok: false, error: "invalid-ceremony" };
        }
        return { ok: true, value: undefined };
      } catch {
        return { ok: false, error: "invalid-ceremony" };
      }
    },

    beginAuthentication(binding: CeremonyBinding): AuthResult<AuthenticationOptions> {
      if (!isExactBinding(binding, expectedOrigin, expectedHost)) {
        return { ok: false, error: "invalid-ceremony" };
      }
      try {
        const credential = repository.getCredential();
        if (credential === null) return { ok: false, error: "invalid-credentials" };
        const challenge = createChallenge("authentication", now());
        repository.createChallenge(challenge);
        return {
          ok: true,
          value: {
            challengeId: challenge.id,
            challenge: challenge.value,
            rpId: config.rpId,
            allowCredentials: [{ id: credential.credentialId, type: "public-key" }],
            timeout: CHALLENGE_TTL_MS,
            userVerification: "required",
          },
        };
      } catch {
        return { ok: false, error: "storage-failure" };
      }
    },

    async completeAuthentication(
      challengeId: string,
      response: unknown,
      binding: CeremonyBinding,
    ): Promise<AuthResult<TechnicalAdminSession>> {
      if (!isExactBinding(binding, expectedOrigin, expectedHost)) {
        return { ok: false, error: "invalid-ceremony" };
      }
      try {
        const credential = repository.getCredential();
        const challenge = consumeChallenge(repository, challengeId, "authentication", now());
        if (credential === null || challenge === null) {
          return { ok: false, error: "invalid-ceremony" };
        }
        const result = await verifier.verifyAuthentication(response, {
          challenge,
          origin: expectedOrigin,
          rpId: config.rpId,
          credential,
          requireUserVerification: true,
        });
        const nextSignCount = result.signCount === 0 ? credential.signCount : result.signCount;
        const current = now();
        const token = randomToken();
        const session: SessionRecord = {
          id: crypto.randomUUID(),
          tokenHash: hashToken(token),
          createdAtMs: current,
          lastSeenAtMs: current,
          absoluteExpiresAtMs: current + SESSION_ABSOLUTE_TTL_MS,
          revokedAtMs: null,
        };
        if (
          !repository.commitAuthentication(
            challengeId,
            credential.credentialId,
            nextSignCount,
            session,
          )
        ) {
          return { ok: false, error: "invalid-ceremony" };
        }
        return {
          ok: true,
          value: { token, expiresAtMs: session.absoluteExpiresAtMs },
        };
      } catch {
        return { ok: false, error: "invalid-ceremony" };
      }
    },

    authenticateSession(token: string): boolean {
      try {
        const current = now();
        const session = repository.getSession(hashToken(token));
        if (
          session === null ||
          session.revokedAtMs !== null ||
          current >= session.absoluteExpiresAtMs ||
          current - session.lastSeenAtMs >= SESSION_IDLE_TTL_MS
        ) {
          return false;
        }
        repository.touchSession(session.id, current);
        return true;
      } catch {
        return false;
      }
    },

    logout(token: string): void {
      try {
        const session = repository.getSession(hashToken(token));
        if (session !== null) repository.revokeSession(session.id, now());
      } catch {
        // Logout is intentionally idempotent and fail-closed.
      }
    },

    isExpectedBinding(binding: CeremonyBinding): boolean {
      return isExactBinding(binding, expectedOrigin, expectedHost);
    },

    config,
  };
}

export interface TechnicalAdminAuth {
  issueEnrollmentAuthorization(): AuthResult<EnrollmentAuthorization>;
  beginEnrollment(token: string, binding: CeremonyBinding): AuthResult<RegistrationOptions>;
  completeEnrollment(
    challengeId: string,
    response: unknown,
    binding: CeremonyBinding,
  ): Promise<AuthResult<void>>;
  beginAuthentication(binding: CeremonyBinding): AuthResult<AuthenticationOptions>;
  completeAuthentication(
    challengeId: string,
    response: unknown,
    binding: CeremonyBinding,
  ): Promise<AuthResult<TechnicalAdminSession>>;
  authenticateSession(token: string): boolean;
  logout(token: string): void;
  isExpectedBinding(binding: CeremonyBinding): boolean;
  config: TechnicalAdminAuthConfig;
}

export type WebAuthnRegistrationExpectation = {
  challenge: string;
  origin: string;
  rpId: string;
  requireUserVerification: boolean;
};

export type WebAuthnAuthenticationExpectation = WebAuthnRegistrationExpectation & {
  credential: CredentialRecord;
};

export interface WebAuthnVerifier {
  verifyRegistration(
    response: unknown,
    expectation: WebAuthnRegistrationExpectation,
  ): Promise<Omit<CredentialRecord, "createdAtMs">>;
  verifyAuthentication(
    response: unknown,
    expectation: WebAuthnAuthenticationExpectation,
  ): Promise<{ signCount: number }>;
}

export class NativeWebAuthnVerifier implements WebAuthnVerifier {
  async verifyRegistration(
    response: unknown,
    expectation: WebAuthnRegistrationExpectation,
  ): Promise<Omit<CredentialRecord, "createdAtMs">> {
    const parsed = parseCredentialResponse(response, "registration");
    parseClientData(parsed.clientDataJSON, "webauthn.create", expectation);
    const attestation = decodeCbor(parsed.attestationObject);
    if (!(attestation instanceof Map)) throw new Error("Invalid attestation object.");
    if (attestation.get("fmt") !== "none") throw new Error("Unsupported attestation format.");
    const authData = bytesFrom(attestation.get("authData"));
    const parsedAuthData = parseAuthenticatorData(authData, true, expectation.rpId);
    if (!parsedAuthData.credentialId || !parsedAuthData.publicKey) {
      throw new Error("Missing attested credential data.");
    }
    return {
      credentialId: base64UrlEncode(parsedAuthData.credentialId),
      publicKey: parsedAuthData.publicKey,
      signCount: parsedAuthData.signCount,
    };
  }

  async verifyAuthentication(
    response: unknown,
    expectation: WebAuthnAuthenticationExpectation,
  ): Promise<{ signCount: number }> {
    const parsed = parseCredentialResponse(response, "authentication");
    if (parsed.id !== expectation.credential.credentialId)
      throw new Error("Unexpected credential.");
    parseClientData(parsed.clientDataJSON, "webauthn.get", expectation);
    const authData = parseAuthenticatorData(parsed.authenticatorData, false, expectation.rpId);
    if (!authData.userVerification || !authData.userPresent) throw new Error("UV required.");
    const clientDataHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", parsed.clientDataJSON as BufferSource),
    );
    const signedData = concatBytes(parsed.authenticatorData, clientDataHash);
    const valid = await verifyWebAuthnSignature(
      expectation.credential.publicKey,
      parsed.signature,
      signedData,
    );
    if (!valid) throw new Error("Invalid signature.");
    if (
      expectation.credential.signCount !== 0 &&
      authData.signCount !== 0 &&
      authData.signCount <= expectation.credential.signCount
    ) {
      throw new Error("Authenticator counter did not advance.");
    }
    return { signCount: authData.signCount };
  }
}

export class MemoryTechnicalAdminAuthRepository implements TechnicalAdminAuthRepository {
  credential: CredentialRecord | null = null;
  enrollment: EnrollmentRecord | null = null;
  challenges = new Map<string, ChallengeRecord>();
  sessions = new Map<string, SessionRecord>();

  hasCredential() {
    return this.credential !== null;
  }
  getCredential() {
    return this.credential;
  }
  issueEnrollment(tokenHash: string, expiresAtMs: number) {
    this.enrollment = { tokenHash, expiresAtMs, usedAtMs: null };
  }
  consumeEnrollment(tokenHash: string, nowMs: number) {
    if (
      this.enrollment === null ||
      this.enrollment.tokenHash !== tokenHash ||
      this.enrollment.usedAtMs !== null ||
      nowMs >= this.enrollment.expiresAtMs
    )
      return false;
    this.enrollment.usedAtMs = nowMs;
    return true;
  }
  createChallenge(challenge: ChallengeRecord) {
    this.challenges.set(challenge.id, challenge);
  }
  consumeChallenge(id: string, purpose: ChallengeRecord["purpose"], nowMs: number) {
    const challenge = this.challenges.get(id);
    if (
      challenge === undefined ||
      challenge.purpose !== purpose ||
      challenge.usedAtMs !== null ||
      nowMs >= challenge.expiresAtMs
    )
      return null;
    challenge.usedAtMs = nowMs;
    return challenge.value;
  }
  commitEnrollment(challengeId: string, credential: CredentialRecord) {
    if (this.credential !== null || !this.challenges.has(challengeId)) return false;
    this.credential = credential;
    return true;
  }
  commitAuthentication(
    _challengeId: string,
    credentialId: string,
    signCount: number,
    session: SessionRecord,
  ) {
    if (this.credential === null || this.credential.credentialId !== credentialId) return false;
    this.credential = { ...this.credential, signCount };
    this.sessions.set(session.id, session);
    return true;
  }
  getSession(tokenHash: string) {
    return [...this.sessions.values()].find((session) => session.tokenHash === tokenHash) ?? null;
  }
  touchSession(id: string, nowMs: number) {
    const session = this.sessions.get(id);
    if (session) session.lastSeenAtMs = nowMs;
  }
  revokeSession(id: string, nowMs: number) {
    const session = this.sessions.get(id);
    if (session) session.revokedAtMs = nowMs;
  }
}

export class SqliteTechnicalAdminAuthRepository implements TechnicalAdminAuthRepository {
  readonly database: Database;
  constructor(databasePath: string, identity?: TechnicalAdminStorageIdentity) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath, { create: true, readwrite: true });
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS technical_admin_credentials (
        credential_id TEXT PRIMARY KEY, public_key_json TEXT NOT NULL, sign_count INTEGER NOT NULL, created_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS technical_admin_enrollment (
        token_hash TEXT PRIMARY KEY, expires_at_ms INTEGER NOT NULL, used_at_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS technical_admin_challenges (
        challenge_id TEXT PRIMARY KEY, challenge TEXT NOT NULL, purpose TEXT NOT NULL, expires_at_ms INTEGER NOT NULL, used_at_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS technical_admin_sessions (
        session_id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, created_at_ms INTEGER NOT NULL, last_seen_at_ms INTEGER NOT NULL,
        absolute_expires_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS technical_admin_storage_identity (
        id INTEGER PRIMARY KEY CHECK (id = 1), environment TEXT NOT NULL, origin TEXT NOT NULL, rp_id TEXT NOT NULL
      );
    `);
    if (identity) {
      const existing = this.database
        .query(
          "SELECT environment, origin, rp_id FROM technical_admin_storage_identity WHERE id = 1",
        )
        .get() as { environment: string; origin: string; rp_id: string } | null;
      if (
        existing &&
        (existing.environment !== identity.environment ||
          existing.origin !== identity.origin ||
          existing.rp_id !== identity.rpId)
      ) {
        throw new Error("Technical Admin storage identity does not match the environment.");
      }
      if (!existing)
        this.database
          .query("INSERT INTO technical_admin_storage_identity VALUES (1, ?, ?, ?)")
          .run(identity.environment, identity.origin, identity.rpId);
    }
  }
  hasCredential() {
    return this.database.query("SELECT 1 FROM technical_admin_credentials LIMIT 1").get() !== null;
  }
  getCredential() {
    const row = this.database.query("SELECT * FROM technical_admin_credentials LIMIT 1").get() as {
      credential_id: string;
      public_key_json: string;
      sign_count: number;
      created_at_ms: number;
    } | null;
    return row
      ? {
          credentialId: row.credential_id,
          publicKey: JSON.parse(row.public_key_json) as JsonWebKey,
          signCount: row.sign_count,
          createdAtMs: row.created_at_ms,
        }
      : null;
  }
  issueEnrollment(tokenHash: string, expiresAtMs: number) {
    this.database.exec(
      "DELETE FROM technical_admin_enrollment; DELETE FROM technical_admin_challenges WHERE expires_at_ms <= strftime('%s','now') * 1000;",
    );
    this.database
      .query("INSERT INTO technical_admin_enrollment (token_hash, expires_at_ms) VALUES (?, ?)")
      .run(tokenHash, expiresAtMs);
  }
  consumeEnrollment(tokenHash: string, nowMs: number) {
    const result = this.database
      .query(
        "UPDATE technical_admin_enrollment SET used_at_ms = ? WHERE token_hash = ? AND used_at_ms IS NULL AND expires_at_ms > ?",
      )
      .run(nowMs, tokenHash, nowMs);
    return result.changes === 1;
  }
  createChallenge(challenge: ChallengeRecord) {
    this.database
      .query("INSERT INTO technical_admin_challenges VALUES (?, ?, ?, ?, NULL)")
      .run(challenge.id, challenge.value, challenge.purpose, challenge.expiresAtMs);
  }
  consumeChallenge(id: string, purpose: ChallengeRecord["purpose"], nowMs: number) {
    const row = this.database
      .query(
        "SELECT challenge FROM technical_admin_challenges WHERE challenge_id = ? AND purpose = ? AND used_at_ms IS NULL AND expires_at_ms > ?",
      )
      .get(id, purpose, nowMs) as { challenge: string } | null;
    if (!row) return null;
    const result = this.database
      .query(
        "UPDATE technical_admin_challenges SET used_at_ms = ? WHERE challenge_id = ? AND used_at_ms IS NULL AND expires_at_ms > ?",
      )
      .run(nowMs, id, nowMs);
    return result.changes === 1 ? row.challenge : null;
  }
  commitEnrollment(challengeId: string, credential: CredentialRecord) {
    try {
      return this.database.transaction(() => {
        if (this.hasCredential()) return false;
        const challenge = this.database
          .query(
            "SELECT 1 FROM technical_admin_challenges WHERE challenge_id = ? AND used_at_ms IS NOT NULL",
          )
          .get(challengeId);
        if (!challenge) return false;
        this.database
          .query("INSERT INTO technical_admin_credentials VALUES (?, ?, ?, ?)")
          .run(
            credential.credentialId,
            JSON.stringify(credential.publicKey),
            credential.signCount,
            credential.createdAtMs,
          );
        return true;
      })();
    } catch {
      return false;
    }
  }
  commitAuthentication(
    challengeId: string,
    credentialId: string,
    signCount: number,
    session: SessionRecord,
  ) {
    try {
      return this.database.transaction(() => {
        const challenge = this.database
          .query(
            "SELECT 1 FROM technical_admin_challenges WHERE challenge_id = ? AND used_at_ms IS NOT NULL",
          )
          .get(challengeId);
        if (!challenge) return false;
        const update = this.database
          .query("UPDATE technical_admin_credentials SET sign_count = ? WHERE credential_id = ?")
          .run(signCount, credentialId);
        if (update.changes !== 1) return false;
        this.database
          .query("INSERT INTO technical_admin_sessions VALUES (?, ?, ?, ?, ?, NULL)")
          .run(
            session.id,
            session.tokenHash,
            session.createdAtMs,
            session.lastSeenAtMs,
            session.absoluteExpiresAtMs,
          );
        return true;
      })();
    } catch {
      return false;
    }
  }
  getSession(tokenHash: string) {
    const row = this.database
      .query("SELECT * FROM technical_admin_sessions WHERE token_hash = ?")
      .get(tokenHash) as Record<string, number | string | null> | null;
    return row
      ? {
          id: String(row.session_id),
          tokenHash: String(row.token_hash),
          createdAtMs: Number(row.created_at_ms),
          lastSeenAtMs: Number(row.last_seen_at_ms),
          absoluteExpiresAtMs: Number(row.absolute_expires_at_ms),
          revokedAtMs: row.revoked_at_ms === null ? null : Number(row.revoked_at_ms),
        }
      : null;
  }
  touchSession(id: string, nowMs: number) {
    this.database
      .query("UPDATE technical_admin_sessions SET last_seen_at_ms = ? WHERE session_id = ?")
      .run(nowMs, id);
  }
  revokeSession(id: string, nowMs: number) {
    this.database
      .query("UPDATE technical_admin_sessions SET revoked_at_ms = ? WHERE session_id = ?")
      .run(nowMs, id);
  }
}

function consumeChallenge(
  repository: TechnicalAdminAuthRepository,
  id: string,
  purpose: ChallengeRecord["purpose"],
  nowMs: number,
) {
  return repository.consumeChallenge(id, purpose, nowMs);
}

function createChallenge(purpose: ChallengeRecord["purpose"], nowMs: number): ChallengeRecord {
  return {
    id: crypto.randomUUID(),
    value: randomToken(),
    purpose,
    expiresAtMs: nowMs + CHALLENGE_TTL_MS,
    usedAtMs: null,
  };
}

function isExactBinding(binding: CeremonyBinding, origin: string, host: string) {
  return binding.origin === origin && binding.host === host;
}

function randomToken() {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}
function hashToken(token: string) {
  return bytesToHex(new Uint8Array(new Bun.CryptoHasher("sha256").update(token).digest()));
}

function parseCredentialResponse(
  value: unknown,
  kind: "registration",
): {
  id: string;
  clientDataJSON: Uint8Array;
  attestationObject: Uint8Array;
};
function parseCredentialResponse(
  value: unknown,
  kind: "authentication",
): {
  id: string;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  signature: Uint8Array;
};
function parseCredentialResponse(
  value: unknown,
  kind: "registration" | "authentication",
):
  | { id: string; clientDataJSON: Uint8Array; attestationObject: Uint8Array }
  | {
      id: string;
      clientDataJSON: Uint8Array;
      authenticatorData: Uint8Array;
      signature: Uint8Array;
    } {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.response))
    throw new Error("Invalid credential response.");
  const response = value.response;
  const parsed = {
    id: value.id,
    clientDataJSON: base64UrlDecode(requiredString(response.clientDataJSON)),
  };
  if (kind === "registration") {
    return {
      ...parsed,
      attestationObject: base64UrlDecode(
        requiredString(response.attestationObject, "attestationObject"),
      ),
    };
  }
  return {
    ...parsed,
    authenticatorData: base64UrlDecode(
      requiredString(response.authenticatorData, "authenticatorData"),
    ),
    signature: base64UrlDecode(requiredString(response.signature, "signature")),
  };
}

function parseClientData(
  bytes: Uint8Array,
  type: string,
  expectation: WebAuthnRegistrationExpectation,
) {
  const data = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  if (
    data.type !== type ||
    data.origin !== expectation.origin ||
    data.challenge !== expectation.challenge
  )
    throw new Error("Invalid client data.");
  return data;
}

function parseAuthenticatorData(bytes: Uint8Array, registration: boolean, rpId: string) {
  if (bytes.length < 37) throw new Error("Invalid authenticator data.");
  const expectedRpIdHash = new Uint8Array(new Bun.CryptoHasher("sha256").update(rpId).digest());
  if (!bytesEqual(bytes.slice(0, 32), expectedRpIdHash)) throw new Error("Invalid RP ID.");
  const flags = bytes[32] ?? 0;
  if ((flags & 0x01) === 0) throw new Error("User presence required.");
  if ((flags & 0x04) === 0) throw new Error("User verification required.");
  const signCount = new DataView(bytes.buffer, bytes.byteOffset + 33, 4).getUint32(0);
  if (!registration) return { signCount, userVerification: true, userPresent: true };
  if ((flags & 0x40) === 0 || bytes.length < 55)
    throw new Error("Missing attested credential data.");
  let offset = 37 + 16;
  const credentialLength = new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0);
  offset += 2;
  const credentialId = bytes.slice(offset, offset + credentialLength);
  offset += credentialLength;
  const key = decodeCbor(bytes.slice(offset));
  return {
    signCount,
    userVerification: true,
    userPresent: true,
    credentialId,
    publicKey: coseKeyToJwk(key),
  };
}

async function verifyWebAuthnSignature(
  publicKey: JsonWebKey,
  signature: Uint8Array,
  data: Uint8Array,
) {
  const algorithm =
    publicKey.kty === "EC" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "Ed25519" };
  const key = await crypto.subtle.importKey("jwk", publicKey, algorithm, false, ["verify"]);
  const normalizedSignature = publicKey.kty === "EC" ? derToP1363(signature) : signature;
  return crypto.subtle.verify(
    publicKey.kty === "EC" ? { name: "ECDSA", hash: "SHA-256" } : { name: "Ed25519" },
    key,
    normalizedSignature as BufferSource,
    data as BufferSource,
  );
}

function coseKeyToJwk(value: unknown): JsonWebKey {
  if (!(value instanceof Map)) throw new Error("Invalid COSE key.");
  const kty = Number(value.get(1));
  if (kty === 2)
    return {
      kty: "EC",
      crv: "P-256",
      x: base64UrlEncode(bytesFrom(value.get(-2))),
      y: base64UrlEncode(bytesFrom(value.get(-3))),
      alg: "ES256",
      ext: true,
    };
  if (kty === 1)
    return {
      kty: "OKP",
      crv: "Ed25519",
      x: base64UrlEncode(bytesFrom(value.get(-2))),
      alg: "EdDSA",
      ext: true,
    };
  if (kty === 3)
    return {
      kty: "RSA",
      n: base64UrlEncode(bytesFrom(value.get(-1))),
      e: base64UrlEncode(bytesFrom(value.get(-2))),
      alg: "RS256",
      ext: true,
    };
  throw new Error("Unsupported COSE key.");
}

function derToP1363(signature: Uint8Array) {
  if (signature[0] !== 0x30) return signature;
  let offset = 2;
  if (signature[offset] !== 0x02) throw new Error("Invalid ECDSA signature.");
  const rLength = signature[offset + 1] ?? 0;
  const r = signature.slice(offset + 2, offset + 2 + rLength);
  offset += 2 + rLength;
  if (signature[offset] !== 0x02) throw new Error("Invalid ECDSA signature.");
  const sLength = signature[offset + 1] ?? 0;
  const s = signature.slice(offset + 2, offset + 2 + sLength);
  return concatBytes(leftPad32(trimLeadingZeroes(r)), leftPad32(trimLeadingZeroes(s)));
}

function trimLeadingZeroes(bytes: Uint8Array) {
  return bytes.slice(
    Math.max(
      0,
      bytes.findIndex((byte) => byte !== 0),
    ),
  );
}
function leftPad32(bytes: Uint8Array) {
  const result = new Uint8Array(32);
  result.set(bytes.slice(-32), 32 - Math.min(32, bytes.length));
  return result;
}
function concatBytes(...values: Uint8Array[]) {
  const result = new Uint8Array(values.reduce((sum, value) => sum + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}
function bytesEqual(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function bytesFrom(value: unknown) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("Expected bytes.");
}
function requiredString(value: unknown, name = "clientDataJSON") {
  if (typeof value !== "string") throw new Error(`Missing ${name}.`);
  return value;
}
function base64UrlEncode(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url");
}
function base64UrlDecode(value: string) {
  return new Uint8Array(Buffer.from(value, "base64url"));
}
function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeCbor(bytes: Uint8Array): unknown {
  let offset = 0;
  const read = (): unknown => {
    const initial = bytes[offset++];
    if (initial === undefined) throw new Error("Invalid CBOR.");
    const major = initial >> 5;
    const additional = initial & 0x1f;
    const length = readLength(additional);
    if (major === 0) return length;
    if (major === 1) return -1 - length;
    if (major === 2) {
      const result = bytes.slice(offset, offset + length);
      offset += length;
      return result;
    }
    if (major === 3) {
      const result = new TextDecoder().decode(bytes.slice(offset, offset + length));
      offset += length;
      return result;
    }
    if (major === 4) return Array.from({ length }, () => read());
    if (major === 5) {
      const map = new Map<unknown, unknown>();
      for (let index = 0; index < length; index++) map.set(read(), read());
      return map;
    }
    throw new Error("Unsupported CBOR value.");
  };
  const readLength = (additional: number): number => {
    if (additional < 24) return additional;
    const width = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : 0;
    if (width === 0 || offset + width > bytes.length) throw new Error("Invalid CBOR length.");
    let value = 0;
    for (let index = 0; index < width; index++) value = value * 256 + (bytes[offset++] ?? 0);
    return value;
  };
  return read();
}

export function createSqliteTechnicalAdminAuthRepository(
  databasePath: string,
  identity?: TechnicalAdminStorageIdentity,
) {
  return new SqliteTechnicalAdminAuthRepository(databasePath, identity);
}
export function technicalAdminCookie(token: string) {
  return `__Host-technical-admin=${token}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}
export function clearTechnicalAdminCookie() {
  return "__Host-technical-admin=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0";
}
export function technicalAdminSessionTtls() {
  return { idleMs: SESSION_IDLE_TTL_MS, absoluteMs: SESSION_ABSOLUTE_TTL_MS };
}
