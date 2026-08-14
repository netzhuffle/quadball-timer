import { computeLookupDigest } from "@/lib/grant-crypto";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import { createAuditEntry } from "@/lib/grant-lifecycle";
import type { TrustedGrantAuthority } from "@/lib/grant-authority-trust";
import type {
  GrantAuthorityActor,
  StoredGrant,
  StoredGrantSession,
  TerminalGrantSessionReason,
} from "@/lib/grant-types";

export function auditInput(
  action: Parameters<typeof createAuditEntry>[1]["action"],
  grant: StoredGrant,
  authority:
    | TrustedGrantAuthority
    | GrantAuthorityActor
    | { kind: "session"; sessionId: string; pseudonymKeyVersion: string },
  afterStatus: StoredGrant["status"],
  sessionId: string | null = null,
  replacedSessionId: string | null = null,
  eventGameId: string | null = null,
  beforeStatus: StoredGrant["status"] | null = null,
  terminalReason: TerminalGrantSessionReason | null = null,
  beforeExpiresAtMs: number | null = null,
  afterExpiresAtMs: number | null = null,
  previousEventGameId: string | null = null,
  replayEvidenceId: string | null = null,
) {
  let actor:
    | { kind: "authority"; value: GrantAuthorityActor }
    | { kind: "session"; sessionId: string; pseudonymKeyVersion: string };
  if (authority.kind === "grant-session") {
    if (authority.sessionId === undefined || authority.pseudonymKeyVersion === undefined)
      throw new Error("Grant Session authority was not resolved.");
    actor = {
      kind: "session",
      sessionId: authority.sessionId,
      pseudonymKeyVersion: authority.pseudonymKeyVersion,
    };
  } else if (authority.kind === "session") {
    actor = authority;
  } else {
    actor = { kind: "authority", value: authorityToActor(authority) as GrantAuthorityActor };
  }
  return {
    action,
    actor,
    grant,
    sessionId,
    replacedSessionId,
    eventGameId,
    previousEventGameId,
    replayEvidenceId,
    beforeStatus,
    afterStatus,
    beforeExpiresAtMs,
    afterExpiresAtMs,
    terminalReason,
  };
}

export function sessionLabel(options: GrantAuthorityOptions, session: StoredGrantSession): string {
  return `session-${computeLookupDigest(
    JSON.stringify({ domain: "grant-session-management", sessionId: session.sessionId }),
    options.keyRing,
    session.browserContextKeyVersion,
  ).slice(0, 12)}`;
}

export function coarse(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 32) return "unknown";
  const normalized = value.trim().toLowerCase();
  return [
    "mobile",
    "desktop",
    "tablet",
    "unknown",
    "safari",
    "chrome",
    "firefox",
    "other",
  ].includes(normalized)
    ? normalized
    : "unknown";
}

function authorityToActor(
  authority: TrustedGrantAuthority | GrantAuthorityActor,
): GrantAuthorityActor | { kind: "session"; sessionId: string; pseudonymKeyVersion: string } {
  if (authority.kind === "grant-session") {
    if (authority.sessionId === undefined || authority.pseudonymKeyVersion === undefined)
      throw new Error("Grant Session authority was not resolved.");
    return {
      kind: "session",
      sessionId: authority.sessionId,
      pseudonymKeyVersion: authority.pseudonymKeyVersion,
    };
  }
  return authority.kind === "fixture" ? authority : { kind: "fixture", id: authority.id };
}
