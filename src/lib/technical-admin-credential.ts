export const TECHNICAL_ADMIN_CREDENTIAL_ID_MIN_BYTES = 1;
export const TECHNICAL_ADMIN_CREDENTIAL_ID_MAX_BYTES = 1023;

export function parseTechnicalAdminCredentialId(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (
    bytes.length < TECHNICAL_ADMIN_CREDENTIAL_ID_MIN_BYTES ||
    bytes.length > TECHNICAL_ADMIN_CREDENTIAL_ID_MAX_BYTES
  ) {
    return null;
  }
  return encodeTechnicalAdminCredentialId(bytes) === value ? bytes : null;
}

export function decodeTechnicalAdminCredentialId(value: string): Uint8Array {
  const parsed = parseTechnicalAdminCredentialId(value);
  if (parsed === null) throw new Error("Invalid Technical Admin credential ID.");
  return parsed;
}

export function encodeTechnicalAdminCredentialId(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}
