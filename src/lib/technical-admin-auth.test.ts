import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MemoryTechnicalAdminAuthRepository,
  NativeWebAuthnVerifier,
  SqliteTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
  type TechnicalAdminAuthRepository,
  technicalAdminCookie,
  technicalAdminSessionTtls,
  type WebAuthnVerifier,
} from "@/lib/technical-admin-auth";

const binding = { origin: "https://timer.example", host: "timer.example" };

function createFixture() {
  let nowMs = 1_000;
  const repository = new MemoryTechnicalAdminAuthRepository();
  const verifier: WebAuthnVerifier = {
    async verifyRegistration() {
      return {
        credentialId: "credential-1",
        publicKey: { kty: "OKP", crv: "Ed25519", x: "public-key" },
        signCount: 1,
      };
    },
    async verifyAuthentication() {
      return { signCount: 2 };
    },
  };
  const auth = createTechnicalAdminAuth(
    { environment: "production", origin: binding.origin, rpId: "timer.example" },
    repository,
    verifier,
    () => nowMs,
  );
  return { auth, repository, verifier, advance: (amount: number) => (nowMs += amount) };
}

describe("Technical Admin authentication", () => {
  test("issues a bounded enrollment URL and consumes its authorization once", async () => {
    const fixture = createFixture();
    const issued = fixture.auth.issueEnrollmentAuthorization();
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.value.url).toMatch(/^https:\/\/timer\.example\/admin\/enroll#token=[^&]+$/u);
    const token = decodeURIComponent(issued.value.url.split("token=")[1] ?? "");

    expect(
      fixture.auth.beginEnrollment(token, { ...binding, origin: "https://other.example" }).ok,
    ).toBe(false);
    const options = fixture.auth.beginEnrollment(token, binding);
    expect(options).toMatchObject({
      ok: true,
      value: {
        rp: { id: "timer.example" },
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      },
    });
    expect(fixture.auth.beginEnrollment(token, binding)).toEqual({
      ok: false,
      error: "invalid-enrollment",
    });

    if (!options.ok) return;
    expect(await fixture.auth.completeEnrollment(options.value.challengeId, {}, binding)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(fixture.repository.getCredential()?.credentialId).toBe("credential-1");
    expect(fixture.auth.issueEnrollmentAuthorization()).toEqual({
      ok: false,
      error: "not-enrollable",
    });
  });

  test("requires the exact host and origin for authentication ceremonies", async () => {
    const fixture = createFixture();
    const issued = fixture.auth.issueEnrollmentAuthorization();
    if (!issued.ok) throw new Error("Expected enrollment authorization.");
    const token = decodeURIComponent(issued.value.url.split("token=")[1] ?? "");
    const enrollment = fixture.auth.beginEnrollment(token, binding);
    if (!enrollment.ok) throw new Error("Expected enrollment options.");
    expect(fixture.auth.beginAuthentication(binding)).toEqual({
      ok: false,
      error: "invalid-credentials",
    });
    const wrongBindingResult = await fixture.auth.completeEnrollment(
      enrollment.value.challengeId,
      {},
      { ...binding, host: "evil.example" },
    );
    expect(wrongBindingResult).toEqual({ ok: false, error: "invalid-ceremony" });
  });

  test("creates a rotated nonpersistent session and enforces idle and absolute expiry", async () => {
    const fixture = createFixture();
    const issued = fixture.auth.issueEnrollmentAuthorization();
    if (!issued.ok) throw new Error("Expected enrollment authorization.");
    const token = decodeURIComponent(issued.value.url.split("token=")[1] ?? "");
    const enrollment = fixture.auth.beginEnrollment(token, binding);
    if (!enrollment.ok) throw new Error("Expected enrollment options.");
    await fixture.auth.completeEnrollment(enrollment.value.challengeId, {}, binding);

    const authentication = fixture.auth.beginAuthentication(binding);
    if (!authentication.ok) throw new Error("Expected authentication options.");
    const session = await fixture.auth.completeAuthentication(
      authentication.value.challengeId,
      {},
      binding,
    );
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    expect(technicalAdminCookie(session.value.token)).toContain("__Host-technical-admin=");
    expect(technicalAdminCookie(session.value.token)).toContain(
      "Secure; HttpOnly; SameSite=Strict",
    );
    expect(fixture.auth.authenticateSession(session.value.token)).toBe(true);

    fixture.advance(technicalAdminSessionTtls().idleMs);
    expect(fixture.auth.authenticateSession(session.value.token)).toBe(false);
  });

  test("rejects authentication replay and enforces the absolute deadline despite activity", async () => {
    const fixture = createFixture();
    await enroll(fixture);
    const options = fixture.auth.beginAuthentication(binding);
    if (!options.ok) throw new Error("Expected authentication options.");
    const first = await fixture.auth.completeAuthentication(options.value.challengeId, {}, binding);
    expect(first.ok).toBe(true);
    expect(
      await fixture.auth.completeAuthentication(options.value.challengeId, {}, binding),
    ).toEqual({
      ok: false,
      error: "invalid-ceremony",
    });
    if (!first.ok) return;
    const hour = 60 * 60 * 1_000;
    for (let elapsed = 0; elapsed < 11 * hour; elapsed += hour) {
      fixture.advance(hour);
      expect(fixture.auth.authenticateSession(first.value.token)).toBe(true);
    }
    fixture.advance(hour - 1_000);
    expect(fixture.auth.authenticateSession(first.value.token)).toBe(true);
    fixture.advance(1_000);
    expect(fixture.auth.authenticateSession(first.value.token)).toBe(false);
  });

  test("rejects an HTTP origin and an RP ID that is not the exact origin host", () => {
    expect(() =>
      createTechnicalAdminAuth(
        { environment: "test", origin: "http://localhost:3000", rpId: "localhost" },
        new MemoryTechnicalAdminAuthRepository(),
      ),
    ).toThrow();
    expect(() =>
      createTechnicalAdminAuth(
        { environment: "test", origin: binding.origin, rpId: "example" },
        new MemoryTechnicalAdminAuthRepository(),
      ),
    ).toThrow();
  });

  test("binds SQLite state to one environment, origin, and RP identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "technical-admin-auth-"));
    const databasePath = join(directory, "auth.sqlite");
    const first = new SqliteTechnicalAdminAuthRepository(databasePath, {
      environment: "test",
      origin: "https://localhost:3000",
      rpId: "localhost",
    });
    first.database.close();
    expect(
      () =>
        new SqliteTechnicalAdminAuthRepository(databasePath, {
          environment: "production",
          origin: "https://timer.example",
          rpId: "timer.example",
        }),
    ).toThrow();
    rmSync(directory, { recursive: true, force: true });
  });

  test("native verification rejects missing UV and a wrong RP hash", async () => {
    const verifier = new NativeWebAuthnVerifier();
    const challenge = "Y2hhbGxlbmdl";
    const clientDataJSON = encodeBase64Url(
      JSON.stringify({ type: "webauthn.get", challenge, origin: binding.origin }),
    );
    const validRpHash = new Uint8Array(
      new Bun.CryptoHasher("sha256").update("timer.example").digest(),
    );
    const missingUvAuthData = new Uint8Array(37);
    missingUvAuthData.set(validRpHash);
    missingUvAuthData[32] = 0x01;
    let missingUvError: unknown;
    try {
      await verifier.verifyAuthentication(
        {
          id: "credential-1",
          response: {
            clientDataJSON,
            authenticatorData: encodeBase64Url(missingUvAuthData),
            signature: encodeBase64Url(new Uint8Array()),
          },
        },
        {
          challenge,
          origin: binding.origin,
          rpId: "timer.example",
          credential: {
            credentialId: "credential-1",
            publicKey: { kty: "OKP", crv: "Ed25519", x: "AA" },
            signCount: 0,
            createdAtMs: 0,
          },
          requireUserVerification: true,
        },
      );
    } catch (error) {
      missingUvError = error;
    }
    expect(String(missingUvError)).toContain("User verification required");
    const wrongRpAuthData = new Uint8Array(missingUvAuthData);
    wrongRpAuthData[0] = (wrongRpAuthData[0] ?? 0) ^ 0xff;
    let wrongRpError: unknown;
    try {
      await verifier.verifyAuthentication(
        {
          id: "credential-1",
          response: {
            clientDataJSON,
            authenticatorData: encodeBase64Url(wrongRpAuthData),
            signature: encodeBase64Url(new Uint8Array()),
          },
        },
        {
          challenge,
          origin: binding.origin,
          rpId: "timer.example",
          credential: {
            credentialId: "credential-1",
            publicKey: { kty: "OKP", crv: "Ed25519", x: "AA" },
            signCount: 0,
            createdAtMs: 0,
          },
          requireUserVerification: true,
        },
      );
    } catch (error) {
      wrongRpError = error;
    }
    expect(String(wrongRpError)).toContain("Invalid RP ID");
  });

  test("contains storage and commit failures without acknowledging state", async () => {
    const issueFailure = createTechnicalAdminAuth(
      { environment: "test", origin: binding.origin, rpId: "timer.example" },
      throwingRepository("hasCredential"),
    );
    expect(issueFailure.issueEnrollmentAuthorization()).toEqual({
      ok: false,
      error: "storage-failure",
    });

    const fixture = createFixture();
    await enroll(fixture);
    const enrolledOptions = fixture.auth.beginAuthentication(binding);
    if (!enrolledOptions.ok) throw new Error("Expected authentication options.");
    const enrolledSession = await fixture.auth.completeAuthentication(
      enrolledOptions.value.challengeId,
      {},
      binding,
    );
    if (!enrolledSession.ok) throw new Error("Expected session.");
    const credentialReadFailure = createTechnicalAdminAuth(
      { environment: "test", origin: binding.origin, rpId: "timer.example" },
      throwingRepository("getCredential", fixture.repository),
      fixture.verifier,
    );
    expect(credentialReadFailure.beginAuthentication(binding)).toEqual({
      ok: false,
      error: "storage-failure",
    });
    const commitFailure = createTechnicalAdminAuth(
      { environment: "test", origin: binding.origin, rpId: "timer.example" },
      throwingRepository("commitAuthentication", fixture.repository),
      fixture.verifier,
    );
    const authentication = commitFailure.beginAuthentication(binding);
    if (!authentication.ok) throw new Error("Expected authentication options.");
    expect(
      await commitFailure.completeAuthentication(authentication.value.challengeId, {}, binding),
    ).toEqual({ ok: false, error: "invalid-ceremony" });
    const readFailure = createTechnicalAdminAuth(
      { environment: "test", origin: binding.origin, rpId: "timer.example" },
      throwingRepository("getSession", fixture.repository),
      fixture.verifier,
    );
    expect(readFailure.authenticateSession("missing")).toBe(false);
    const touchFailure = createTechnicalAdminAuth(
      { environment: "test", origin: binding.origin, rpId: "timer.example" },
      throwingRepository("touchSession", fixture.repository),
      fixture.verifier,
    );
    expect(touchFailure.authenticateSession(enrolledSession.value.token)).toBe(false);
    const revokeFailure = createTechnicalAdminAuth(
      { environment: "test", origin: binding.origin, rpId: "timer.example" },
      throwingRepository("revokeSession", fixture.repository),
      fixture.verifier,
    );
    expect(() => revokeFailure.logout(enrolledSession.value.token)).not.toThrow();
  });
});

async function enroll(fixture: ReturnType<typeof createFixture>) {
  const issued = fixture.auth.issueEnrollmentAuthorization();
  if (!issued.ok) throw new Error("Expected enrollment authorization.");
  const token = decodeURIComponent(issued.value.url.split("token=")[1] ?? "");
  const options = fixture.auth.beginEnrollment(token, binding);
  if (!options.ok) throw new Error("Expected enrollment options.");
  expect(await fixture.auth.completeEnrollment(options.value.challengeId, {}, binding)).toEqual({
    ok: true,
    value: undefined,
  });
}

function encodeBase64Url(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Buffer.from(bytes).toString("base64url");
}

function throwingRepository(
  failure: string,
  base = new MemoryTechnicalAdminAuthRepository(),
): TechnicalAdminAuthRepository {
  const fail = () => {
    throw new Error(`injected ${failure} failure`);
  };
  return {
    hasCredential: failure === "hasCredential" ? fail : () => base.hasCredential(),
    getCredential: failure === "getCredential" ? fail : () => base.getCredential(),
    issueEnrollment:
      failure === "issueEnrollment" ? fail : (...args) => base.issueEnrollment(...args),
    consumeEnrollment:
      failure === "consumeEnrollment" ? fail : (...args) => base.consumeEnrollment(...args),
    createChallenge:
      failure === "createChallenge" ? fail : (...args) => base.createChallenge(...args),
    consumeChallenge:
      failure === "consumeChallenge" ? fail : (...args) => base.consumeChallenge(...args),
    commitEnrollment:
      failure === "commitEnrollment" ? fail : (...args) => base.commitEnrollment(...args),
    commitAuthentication:
      failure === "commitAuthentication" ? fail : (...args) => base.commitAuthentication(...args),
    getSession: failure === "getSession" ? fail : (...args) => base.getSession(...args),
    touchSession: failure === "touchSession" ? fail : (...args) => base.touchSession(...args),
    revokeSession: failure === "revokeSession" ? fail : (...args) => base.revokeSession(...args),
  };
}
