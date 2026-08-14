import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import {
  EVENT_ADMIN_GRANT_TYPE,
  GRANT_TYPE,
  PITCH_MANAGER_GRANT_TYPE,
  type GrantType,
} from "@/lib/grant-types";
import type { TypedGrantMutation } from "@/lib/grant-management-types";

export function readGrantNow(options: GrantAuthorityOptions): number {
  const now = options.clock.nowMs();
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error("Grant clock returned an invalid timestamp.");
  return now;
}

export function requireGrantBytes(
  randomness: GrantAuthorityOptions["randomness"],
  length: number,
): Uint8Array {
  const bytes = randomness.bytes(length);
  if (bytes.byteLength !== length) throw new Error("Injected randomness has an invalid size.");
  return bytes;
}

export function isGrantType(value: unknown): value is GrantType {
  return (
    value === EVENT_ADMIN_GRANT_TYPE || value === PITCH_MANAGER_GRANT_TYPE || value === GRANT_TYPE
  );
}

export function isValidGrantSecret(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

export function invalidGrant(detail: string): TypedGrantMutation {
  return { status: "rejected", reason: "invalid-input", detail };
}

export function unauthorizedGrant(): TypedGrantMutation {
  return {
    status: "rejected",
    reason: "unauthorized",
    detail: "Grant authority is not permitted for this operation.",
  };
}

export function unavailableGrant(): TypedGrantMutation {
  return {
    status: "rejected",
    reason: "unavailable",
    detail: "Grant authority storage is temporarily unavailable.",
  };
}

export function isGrantRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class GrantUnauthorizedError extends Error {}
