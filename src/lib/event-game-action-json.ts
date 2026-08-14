import { createHash } from "node:crypto";
import type { ActionJsonValue } from "@/lib/event-game-actions";

export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value, "value"));
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sortJsonValue(value: unknown, field: string): ActionJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new TypeError(`${field} contains a non-safe number.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => sortJsonValue(item, `${field}[${index}]`));
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${field} contains a non-plain object.`);
    }
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortJsonValue(record[key], `${field}.${key}`)]),
    );
  }
  throw new TypeError(`${field} contains an unsupported JSON value.`);
}
