import { describe, expect, test } from "bun:test";
import { deriveGrantSessionCsrfToken, verifyGrantSessionCsrfToken } from "@/lib/grant-session-csrf";

describe("Grant Session CSRF", () => {
  test("derives deterministic opaque tokens separated by session and role", () => {
    const bearer = "event-admin-session-bearer";
    const first = deriveGrantSessionCsrfToken("event-admin", bearer);

    expect(deriveGrantSessionCsrfToken("event-admin", bearer)).toBe(first);
    expect(deriveGrantSessionCsrfToken("event-admin", "another-session-bearer")).not.toBe(first);
    expect(deriveGrantSessionCsrfToken("pitch-manager", bearer)).not.toBe(first);
    expect(first).not.toContain(bearer);
  });

  test("rejects missing, malformed, wrong-session, and wrong-role proofs", () => {
    const token = deriveGrantSessionCsrfToken("event-admin", "session-a");

    expect(verifyGrantSessionCsrfToken("event-admin", "session-a", token)).toBe(true);
    expect(verifyGrantSessionCsrfToken("event-admin", "session-b", token)).toBe(false);
    expect(verifyGrantSessionCsrfToken("pitch-manager", "session-a", token)).toBe(false);
    expect(verifyGrantSessionCsrfToken("event-admin", "session-a", null)).toBe(false);
    expect(verifyGrantSessionCsrfToken("event-admin", "session-a", "not-base64url")).toBe(false);
    expect(verifyGrantSessionCsrfToken("event-admin", null, token)).toBe(false);
    expect(verifyGrantSessionCsrfToken("event-admin", "", token)).toBe(false);
    expect(() => deriveGrantSessionCsrfToken("event-admin", "")).toThrow();
  });
});
