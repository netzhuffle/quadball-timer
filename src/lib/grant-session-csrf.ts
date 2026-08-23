import { createHash, timingSafeEqual } from "node:crypto";

export type GrantSessionCsrfRole = "event-admin" | "pitch-manager";

export const EVENT_ADMIN_CSRF_COOKIE = "__Host-event-admin-csrf";
export const EVENT_ADMIN_CSRF_HEADER = "x-event-admin-csrf";
export const PITCH_MANAGER_CSRF_COOKIE = "__Host-pitch-manager-csrf";
export const PITCH_MANAGER_CSRF_HEADER = "x-pitch-manager-csrf";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const INVALID_TOKEN_BYTES = Buffer.alloc(32);

export function deriveGrantSessionCsrfToken(
  role: GrantSessionCsrfRole,
  sessionBearer: string,
): string {
  if (sessionBearer.length === 0) throw new Error("A Grant Session bearer is required.");
  return csrfDigest(role, sessionBearer).toString("base64url");
}

export function verifyGrantSessionCsrfToken(
  role: GrantSessionCsrfRole,
  sessionBearer: string | null,
  token: string | null,
): boolean {
  if (sessionBearer === null || sessionBearer.length === 0) return false;
  const expected = csrfDigest(role, sessionBearer);
  const wellFormed = token !== null && TOKEN_PATTERN.test(token);
  const supplied = wellFormed ? Buffer.from(token, "base64url") : INVALID_TOKEN_BYTES;
  return timingSafeEqual(expected, supplied) && wellFormed;
}

function csrfDigest(role: GrantSessionCsrfRole, sessionBearer: string): Buffer {
  return createHash("sha256")
    .update("quadball-timer:grant-session-csrf:v1\0", "utf8")
    .update(role, "utf8")
    .update("\0", "utf8")
    .update(sessionBearer, "utf8")
    .digest();
}
