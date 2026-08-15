import {
  constants as fsConstants,
  chmodSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  fsyncSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { GrantKeyRing, GrantKeySet } from "@/lib/grant-types";

export const GRANT_KEY_RING_FORMAT_VERSION = 1 as const;
const KEY_BYTES = 32;
const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;
const SAFE_FILE_MODE_MASK = 0o137;

export type GrantEnvironment = "production" | "test";

export type GrantKeyRingDocument = {
  formatVersion: typeof GRANT_KEY_RING_FORMAT_VERSION;
  environment: GrantEnvironment;
  generatedAt: string;
  encryption: GrantKeyRingDocumentSet;
  lookup: GrantKeyRingDocumentSet;
  audit: GrantKeyRingDocumentSet;
};

export type GrantKeyRingDocumentSet = {
  currentVersion: string;
  keys: Record<string, string>;
};

export type GrantKeyRingMetadata = {
  formatVersion: typeof GRANT_KEY_RING_FORMAT_VERSION;
  environment: GrantEnvironment;
  generatedAt: string;
  currentVersions: {
    encryption: string;
    lookup: string;
    audit: string;
  };
  retainedVersions: {
    encryption: number;
    lookup: number;
    audit: number;
  };
};

export type GrantKeyRingLoad = {
  keyRing: GrantKeyRing;
  metadata: GrantKeyRingMetadata;
};

export type GrantKeyRingFailureCategory =
  | "missing"
  | "unreadable"
  | "unsafe-permissions"
  | "malformed"
  | "environment-mismatch"
  | "missing-key-version";

export class GrantKeyRingCustodyError extends Error {
  readonly category: GrantKeyRingFailureCategory;

  constructor(category: GrantKeyRingFailureCategory) {
    super(`Grant key ring preflight failed: ${category}.`);
    this.name = "GrantKeyRingCustodyError";
    this.category = category;
  }
}

export type GrantKeyRingLoadOptions = {
  /** Production uses uid 0. Tests may use their disposable fixture owner. */
  requiredOwnerUid?: number;
  /** Required versions discovered from retained durable Grant material. */
  requiredVersions?: Partial<Record<GrantKeyRingCategory, readonly string[]>>;
};

export type GrantKeyRingCategory = keyof Pick<GrantKeyRing, "encryption" | "lookup" | "audit">;

export type GrantKeyRingPreflight =
  | ({ ok: true } & GrantKeyRingMetadata)
  | { ok: false; category: GrantKeyRingFailureCategory };

export type LegacyGrantKeyRingConversionOptions = {
  requiredOwnerUid?: number;
  now?: Date;
};

export type GrantKeyRingWriteOptions = {
  /** Reject an existing output unless it is owned by this invoking identity. */
  requiredOwnerUid?: number;
};

export function createGrantKeyRingDocument(
  environment: GrantEnvironment,
  now = new Date(),
  bytes: (length: number) => Uint8Array = (length) => new Uint8Array(randomBytes(length)),
): GrantKeyRingDocument {
  return {
    formatVersion: GRANT_KEY_RING_FORMAT_VERSION,
    environment,
    generatedAt: now.toISOString(),
    encryption: createDocumentSet("v1", bytes),
    lookup: createDocumentSet("v1", bytes),
    audit: createDocumentSet("v1", bytes),
  };
}

export function rotateGrantKeyRingDocument(
  current: GrantKeyRingDocument,
  nextVersion: string,
  now = new Date(),
  bytes: (length: number) => Uint8Array = (length) => new Uint8Array(randomBytes(length)),
): GrantKeyRingDocument {
  assertVersion(nextVersion);
  if (current.formatVersion !== GRANT_KEY_RING_FORMAT_VERSION) throw malformed();
  if (
    nextVersion in current.encryption.keys ||
    nextVersion in current.lookup.keys ||
    nextVersion in current.audit.keys
  ) {
    throw malformed();
  }
  return {
    ...current,
    generatedAt: now.toISOString(),
    encryption: rotatedDocumentSet(current.encryption, nextVersion, bytes),
    lookup: rotatedDocumentSet(current.lookup, nextVersion, bytes),
    audit: rotatedDocumentSet(current.audit, nextVersion, bytes),
  };
}

export function grantKeyRingDocumentToKeyRing(document: GrantKeyRingDocument): GrantKeyRing {
  validateDocument(document);
  return {
    encryption: documentSetToKeySet(document.encryption),
    lookup: documentSetToKeySet(document.lookup),
    audit: documentSetToKeySet(document.audit),
  };
}

export function grantKeyRingToDocument(
  environment: GrantEnvironment,
  keyRing: GrantKeyRing,
  generatedAt = new Date().toISOString(),
): GrantKeyRingDocument {
  const document: GrantKeyRingDocument = {
    formatVersion: GRANT_KEY_RING_FORMAT_VERSION,
    environment,
    generatedAt,
    encryption: keySetToDocumentSet(keyRing.encryption),
    lookup: keySetToDocumentSet(keyRing.lookup),
    audit: keySetToDocumentSet(keyRing.audit),
  };
  validateDocument(document);
  return document;
}

export function createGrantKeyRingRecoveryHandoff(document: GrantKeyRingDocument): {
  itemTitle: string;
  environment: GrantEnvironment;
  formatVersion: typeof GRANT_KEY_RING_FORMAT_VERSION;
  generatedAt: string;
  currentVersions: GrantKeyRingMetadata["currentVersions"];
  retainedVersions: GrantKeyRingMetadata["retainedVersions"];
  keyRing: GrantKeyRingDocument;
} {
  validateDocument(document);
  const metadata = metadataFromDocument(document);
  return {
    itemTitle: `Quadball Timer ${capitalize(document.environment)} Grant Key Ring Recovery`,
    environment: document.environment,
    formatVersion: document.formatVersion,
    generatedAt: document.generatedAt,
    currentVersions: metadata.currentVersions,
    retainedVersions: metadata.retainedVersions,
    keyRing: document,
  };
}

export function loadGrantKeyRingFile(
  path: string,
  expectedEnvironment: GrantEnvironment,
  options: GrantKeyRingLoadOptions = {},
): GrantKeyRingLoad {
  assertSafeFileMetadata(path, options.requiredOwnerUid ?? 0);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new GrantKeyRingCustodyError("unreadable");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw malformed();
  }
  if (!isRecord(parsed)) throw malformed();
  if (parsed.environment !== expectedEnvironment) {
    throw new GrantKeyRingCustodyError("environment-mismatch");
  }

  const document = parseDocument(parsed);
  const keyRing = grantKeyRingDocumentToKeyRing(document);
  assertRequiredVersions(keyRing, options.requiredVersions);
  return { keyRing, metadata: metadataFromDocument(document) };
}

export function preflightGrantKeyRingFile(
  path: string,
  expectedEnvironment: GrantEnvironment,
  options: GrantKeyRingLoadOptions = {},
): GrantKeyRingPreflight {
  try {
    const loaded = loadGrantKeyRingFile(path, expectedEnvironment, options);
    return { ok: true, ...loaded.metadata };
  } catch (error) {
    if (error instanceof GrantKeyRingCustodyError) {
      return { ok: false, category: error.category };
    }
    return { ok: false, category: "unreadable" };
  }
}

export function convertLegacyGrantKeyRingFile(
  legacyPath: string,
  environment: GrantEnvironment,
  options: LegacyGrantKeyRingConversionOptions = {},
): GrantKeyRingDocument {
  const ownerUid = options.requiredOwnerUid ?? 0;
  assertSafeFileMetadata(legacyPath, ownerUid);
  let raw: string;
  try {
    raw = readFileSync(legacyPath, "utf8");
  } catch {
    throw new GrantKeyRingCustodyError("unreadable");
  }
  const values = readLegacyValues(raw);
  const keyRing: GrantKeyRing = {
    encryption: { currentVersion: "v1", keys: new Map([["v1", values.encryption]]) },
    lookup: { currentVersion: "v1", keys: new Map([["v1", values.lookup]]) },
    audit: { currentVersion: "v1", keys: new Map([["v1", values.audit]]) },
  };
  return grantKeyRingToDocument(environment, keyRing, (options.now ?? new Date()).toISOString());
}

/** Remove only the legacy Grant entries after the converted file is installed and verified. */
export function removeLegacyGrantKeyRingEntries(
  legacyPath: string,
  options: { requiredOwnerUid?: number } = {},
): void {
  const ownerUid = options.requiredOwnerUid ?? 0;
  const metadata = assertSafeFileMetadata(legacyPath, ownerUid);
  let raw: string;
  try {
    raw = readFileSync(legacyPath, "utf8");
  } catch {
    throw new GrantKeyRingCustodyError("unreadable");
  }
  const filtered = raw
    .split(/(?<=\n)/u)
    .filter((line) => !/^\s*GRANT_(?:ENCRYPTION|LOOKUP|AUDIT)_KEY\s*=/u.test(line))
    .join("");
  atomicReplaceFile(legacyPath, filtered, {
    mode: metadata.mode & 0o777,
    uid: metadata.uid,
    gid: metadata.gid,
  });
}

/** Atomic writer used by the local rotation tool; it never prints the ring. */
export function writeGrantKeyRingFile(
  path: string,
  document: GrantKeyRingDocument,
  options: GrantKeyRingWriteOptions = {},
): void {
  if (!isAbsolute(path)) throw new GrantKeyRingCustodyError("unreadable");
  validateDocument(document);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  atomicReplaceFile(
    path,
    `${JSON.stringify(document)}\n`,
    replacementMetadata(path, options.requiredOwnerUid ?? process.getuid?.() ?? 0),
  );
}

export function writeGrantKeyRingRecoveryHandoff(
  path: string,
  document: GrantKeyRingDocument,
): void {
  const handoff = createGrantKeyRingRecoveryHandoff(document);
  if (!isAbsolute(path)) throw new GrantKeyRingCustodyError("unreadable");
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(handoff, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}

function createDocumentSet(
  version: string,
  bytes: (length: number) => Uint8Array,
): GrantKeyRingDocumentSet {
  return { currentVersion: version, keys: { [version]: encodeKey(bytes(KEY_BYTES)) } };
}

function rotatedDocumentSet(
  current: GrantKeyRingDocumentSet,
  nextVersion: string,
  bytes: (length: number) => Uint8Array,
): GrantKeyRingDocumentSet {
  return {
    currentVersion: nextVersion,
    keys: { ...current.keys, [nextVersion]: encodeKey(bytes(KEY_BYTES)) },
  };
}

function documentSetToKeySet(value: GrantKeyRingDocumentSet): GrantKeySet {
  return {
    currentVersion: value.currentVersion,
    keys: new Map(
      Object.entries(value.keys).map(([version, encoded]) => [version, decodeKey(encoded)]),
    ),
  };
}

function keySetToDocumentSet(value: GrantKeySet): GrantKeyRingDocumentSet {
  const keys: Record<string, string> = {};
  for (const [version, key] of value.keys) keys[version] = encodeKey(key);
  return { currentVersion: value.currentVersion, keys };
}

function parseDocument(value: Record<string, unknown>): GrantKeyRingDocument {
  const document = value as Partial<GrantKeyRingDocument>;
  if (
    document.formatVersion !== GRANT_KEY_RING_FORMAT_VERSION ||
    (document.environment !== "production" && document.environment !== "test") ||
    typeof document.generatedAt !== "string"
  )
    throw malformed();
  const parsed = {
    formatVersion: document.formatVersion,
    environment: document.environment,
    generatedAt: document.generatedAt,
    encryption: parseDocumentSet(document.encryption),
    lookup: parseDocumentSet(document.lookup),
    audit: parseDocumentSet(document.audit),
  } satisfies GrantKeyRingDocument;
  validateDocument(parsed);
  return parsed;
}

function parseDocumentSet(value: unknown): GrantKeyRingDocumentSet {
  if (!isRecord(value) || typeof value.currentVersion !== "string" || !isRecord(value.keys)) {
    throw malformed();
  }
  const keys: Record<string, string> = {};
  for (const [version, encoded] of Object.entries(value.keys)) {
    if (!VERSION_PATTERN.test(version) || typeof encoded !== "string") throw malformed();
    decodeKey(encoded);
    keys[version] = encoded;
  }
  return { currentVersion: value.currentVersion, keys };
}

function readLegacyValues(raw: string): {
  encryption: Uint8Array;
  lookup: Uint8Array;
  audit: Uint8Array;
} {
  const values = new Map<string, string>();
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const match = /^(GRANT_(?:ENCRYPTION|LOOKUP|AUDIT)_KEY)\s*=\s*(\S+)$/u.exec(trimmed);
    if (match === null) {
      if (trimmed.startsWith("GRANT_")) throw malformed();
      continue;
    }
    if (values.has(match[1]!)) throw malformed();
    values.set(match[1]!, match[2]!);
  }
  const encryption = values.get("GRANT_ENCRYPTION_KEY");
  const lookup = values.get("GRANT_LOOKUP_KEY");
  const audit = values.get("GRANT_AUDIT_KEY");
  if (encryption === undefined || lookup === undefined || audit === undefined) throw malformed();
  return {
    encryption: decodeLegacyKey(encryption),
    lookup: decodeLegacyKey(lookup),
    audit: decodeLegacyKey(audit),
  };
}

function validateDocument(document: GrantKeyRingDocument): void {
  if (
    document.formatVersion !== GRANT_KEY_RING_FORMAT_VERSION ||
    (document.environment !== "production" && document.environment !== "test") ||
    Number.isNaN(Date.parse(document.generatedAt))
  ) {
    throw malformed();
  }
  for (const value of [document.encryption, document.lookup, document.audit]) {
    if (!VERSION_PATTERN.test(value.currentVersion) || Object.keys(value.keys).length === 0) {
      throw malformed();
    }
    for (const [version, encoded] of Object.entries(value.keys)) {
      if (!VERSION_PATTERN.test(version)) throw malformed();
      decodeKey(encoded);
    }
    if (!(value.currentVersion in value.keys))
      throw new GrantKeyRingCustodyError("missing-key-version");
  }
}

function assertRequiredVersions(
  keyRing: GrantKeyRing,
  requiredVersions: GrantKeyRingLoadOptions["requiredVersions"],
): void {
  for (const category of ["encryption", "lookup", "audit"] as const) {
    for (const version of requiredVersions?.[category] ?? []) {
      if (!keyRing[category].keys.has(version)) {
        throw new GrantKeyRingCustodyError("missing-key-version");
      }
    }
  }
}

function assertSafeFileMetadata(path: string, requiredOwnerUid: number) {
  if (!isAbsolute(path)) throw new GrantKeyRingCustodyError("unreadable");
  let file;
  try {
    file = lstatSync(path);
  } catch {
    throw new GrantKeyRingCustodyError("missing");
  }
  if (!file.isFile() || file.isSymbolicLink() || file.uid !== requiredOwnerUid) {
    throw new GrantKeyRingCustodyError("unsafe-permissions");
  }
  if ((file.mode & SAFE_FILE_MODE_MASK) !== 0) {
    throw new GrantKeyRingCustodyError("unsafe-permissions");
  }
  let parent;
  try {
    parent = lstatSync(dirname(path));
  } catch {
    throw new GrantKeyRingCustodyError("unreadable");
  }
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== requiredOwnerUid) {
    throw new GrantKeyRingCustodyError("unsafe-permissions");
  }
  if ((parent.mode & 0o022) !== 0) throw new GrantKeyRingCustodyError("unsafe-permissions");
  return file;
}

function metadataFromDocument(document: GrantKeyRingDocument): GrantKeyRingMetadata {
  return {
    formatVersion: document.formatVersion,
    environment: document.environment,
    generatedAt: document.generatedAt,
    currentVersions: {
      encryption: document.encryption.currentVersion,
      lookup: document.lookup.currentVersion,
      audit: document.audit.currentVersion,
    },
    retainedVersions: {
      encryption: Object.keys(document.encryption.keys).length,
      lookup: Object.keys(document.lookup.keys).length,
      audit: Object.keys(document.audit.keys).length,
    },
  };
}

function encodeKey(value: Uint8Array): string {
  if (value.byteLength !== KEY_BYTES) throw malformed();
  return Buffer.from(value).toString("base64url");
}

function decodeKey(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+={0,2}$/u.test(value)) throw malformed();
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    throw malformed();
  }
  if (decoded.byteLength !== KEY_BYTES) throw malformed();
  return new Uint8Array(decoded);
}

function assertVersion(value: string): void {
  if (!VERSION_PATTERN.test(value)) throw malformed();
}

function decodeLegacyKey(value: string): Uint8Array {
  if (/^[0-9a-f]{64}$/u.test(value)) return new Uint8Array(Buffer.from(value, "hex"));
  return decodeKey(value);
}

function atomicReplaceFile(
  path: string,
  content: string,
  metadata: { mode: number; uid: number; gid: number },
): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const baseName = path.split("/").at(-1) ?? "grant-ring";
  const flags =
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const temporaryPath = join(directory, `.${baseName}.tmp-${randomBytes(16).toString("hex")}`);
    let descriptor: number;
    try {
      descriptor = openSync(temporaryPath, flags, metadata.mode);
    } catch (error) {
      if (isErrno(error, "EEXIST")) continue;
      throw error;
    }
    const openedFile = fstatSync(descriptor);
    try {
      fchmodSync(descriptor, metadata.mode);
      fchownSync(descriptor, metadata.uid, metadata.gid);
      writeFileSync(descriptor, content, { encoding: "utf8" });
      fsyncSync(descriptor);
      renameSync(temporaryPath, path);
      fsyncDirectory(directory);
      return;
    } finally {
      closeSync(descriptor);
      if (existsAsOpenedFile(temporaryPath, openedFile)) unlinkSync(temporaryPath);
    }
  }
  throw new GrantKeyRingCustodyError("unreadable");
}

function replacementMetadata(
  path: string,
  requiredOwnerUid: number,
): { mode: number; uid: number; gid: number } {
  let existing;
  try {
    existing = lstatSync(path);
  } catch {
    // A new output file uses the invoking operator's private ownership.
    return {
      mode: 0o600,
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
    };
  }
  if (existing.uid !== requiredOwnerUid) {
    throw new GrantKeyRingCustodyError("unsafe-permissions");
  }
  if (existing.isFile() && !existing.isSymbolicLink()) {
    return { mode: existing.mode & 0o777, uid: existing.uid, gid: existing.gid };
  }
  return {
    mode: 0o600,
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
  };
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, fsConstants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function existsAsOpenedFile(path: string, openedFile: ReturnType<typeof fstatSync>): boolean {
  try {
    const current = lstatSync(path);
    return current.dev === openedFile.dev && current.ino === openedFile.ino;
  } catch {
    return false;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function malformed(): GrantKeyRingCustodyError {
  return new GrantKeyRingCustodyError("malformed");
}

function capitalize(value: string): string {
  return value[0]!.toUpperCase() + value.slice(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
