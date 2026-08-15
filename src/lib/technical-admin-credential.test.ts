import { describe, expect, test } from "bun:test";
import {
  decodeTechnicalAdminCredentialId,
  parseTechnicalAdminCredentialId,
} from "@/lib/technical-admin-credential";

describe("Technical Admin credential ID codec", () => {
  test("accepts current canonical enrollment IDs and browser-decodes the same bytes", () => {
    const value = "credential-1";
    const parsed = parseTechnicalAdminCredentialId(value);

    expect(parsed).not.toBeNull();
    if (parsed === null) throw new Error("Expected a canonical credential ID.");
    expect(decodeTechnicalAdminCredentialId(value)).toEqual(parsed);
  });

  test("rejects empty, padded, noncanonical, illegal, and over-bound IDs", () => {
    const overBound = "A".repeat(1_368);
    for (const value of ["", "=", "AA=", "credential-live", "a!", overBound]) {
      expect(parseTechnicalAdminCredentialId(value)).toBeNull();
      expect(() => decodeTechnicalAdminCredentialId(value)).toThrow();
    }
  });
});
