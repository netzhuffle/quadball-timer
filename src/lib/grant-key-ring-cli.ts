import {
  convertLegacyGrantKeyRingFile,
  createGrantKeyRingDocument,
  grantKeyRingToDocument,
  loadGrantKeyRingFile,
  removeLegacyGrantKeyRingEntries,
  rotateGrantKeyRingDocument,
  writeGrantKeyRingFile,
  writeGrantKeyRingRecoveryHandoff,
  type GrantEnvironment,
  type GrantKeyRingDocument,
} from "@/lib/grant-key-ring-custody";

export type GrantKeyRingCliInvocation =
  | { kind: "none" }
  | { kind: "invalid"; error: string }
  | {
      kind: "operation";
      command: "create" | "convert" | "verify" | "rotate" | "remove-legacy";
      environment: GrantEnvironment;
      activeFile: string;
      handoffFile?: string;
      inputFile?: string;
      legacyFile?: string;
      nextVersion: string;
      requiredVersions: readonly string[];
    };

export function parseGrantKeyRingCli(args: readonly string[]): GrantKeyRingCliInvocation {
  const marker = args.indexOf("--grant-key-ring");
  if (marker === -1) return { kind: "none" };
  const offset = marker + 1;
  const command = args[offset];
  if (
    command !== "create" &&
    command !== "convert" &&
    command !== "verify" &&
    command !== "rotate" &&
    command !== "remove-legacy"
  ) {
    return { kind: "invalid", error: "Unknown Grant key-ring command." };
  }
  const environment = valueFor(args, "--environment", offset + 1) as GrantEnvironment | undefined;
  const activeFile = valueFor(args, "--active-file", offset + 1);
  if (environment !== "production" && environment !== "test") {
    return { kind: "invalid", error: "Grant key-ring Environment must be production or test." };
  }
  if (activeFile === undefined || !activeFile.startsWith("/")) {
    return { kind: "invalid", error: "Grant key-ring active file must be an absolute path." };
  }
  const handoffFile = valueFor(args, "--handoff-file", offset + 1);
  const inputFile = valueFor(args, "--input", offset + 1);
  const legacyFile = valueFor(args, "--legacy-file", offset + 1);
  const nextVersion = valueFor(args, "--next-version", offset + 1) ?? "v2";
  const requiredVersions = args
    .map((value, index) => (value === "--required-version" ? args[index + 1] : undefined))
    .filter((value): value is string => value !== undefined);
  if (
    (command === "create" || command === "convert" || command === "rotate") &&
    handoffFile === undefined
  ) {
    return { kind: "invalid", error: "This Grant key-ring command requires --handoff-file." };
  }
  if (command === "convert" && legacyFile === undefined) {
    return { kind: "invalid", error: "Grant key-ring conversion requires --legacy-file." };
  }
  if (
    (command === "rotate" || command === "remove-legacy") &&
    inputFile === undefined &&
    command === "rotate"
  ) {
    return { kind: "invalid", error: "Grant key-ring rotation requires --input." };
  }
  if (command === "remove-legacy" && legacyFile === undefined) {
    return { kind: "invalid", error: "Legacy cleanup requires --legacy-file." };
  }
  return {
    kind: "operation",
    command,
    environment,
    activeFile,
    ...(handoffFile === undefined ? {} : { handoffFile }),
    ...(inputFile === undefined ? {} : { inputFile }),
    ...(legacyFile === undefined ? {} : { legacyFile }),
    nextVersion,
    requiredVersions,
  };
}

export function runGrantKeyRingCli(
  invocation: Extract<GrantKeyRingCliInvocation, { kind: "operation" }>,
  requiredOwnerUid: number,
): number {
  try {
    if (invocation.command === "verify") {
      const loaded = loadGrantKeyRingFile(invocation.activeFile, invocation.environment, {
        requiredOwnerUid,
        requiredVersions: requiredVersions(invocation.requiredVersions),
      });
      console.log(JSON.stringify(loaded.metadata));
      return 0;
    }
    if (invocation.command === "remove-legacy") {
      loadGrantKeyRingFile(invocation.activeFile, invocation.environment, {
        requiredOwnerUid,
        requiredVersions: requiredVersions(invocation.requiredVersions),
      });
      removeLegacyGrantKeyRingEntries(invocation.legacyFile!, { requiredOwnerUid });
      console.log(JSON.stringify({ status: "legacy-entries-removed" }));
      return 0;
    }
    const document = createOrTransformDocument(invocation, requiredOwnerUid);
    writeGrantKeyRingFile(invocation.activeFile, document, { requiredOwnerUid });
    writeGrantKeyRingRecoveryHandoff(invocation.handoffFile!, document);
    const verified = loadGrantKeyRingFile(invocation.activeFile, invocation.environment, {
      requiredOwnerUid,
      requiredVersions: requiredVersions(invocation.requiredVersions),
    });
    console.log(JSON.stringify({ status: "written", ...verified.metadata }));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Grant key-ring operation failed.");
    return 1;
  }
}

function createOrTransformDocument(
  invocation: Extract<GrantKeyRingCliInvocation, { kind: "operation" }>,
  requiredOwnerUid: number,
): GrantKeyRingDocument {
  switch (invocation.command) {
    case "create":
      return createGrantKeyRingDocument(invocation.environment);
    case "convert":
      return convertLegacyGrantKeyRingFile(invocation.legacyFile!, invocation.environment, {
        requiredOwnerUid,
      });
    case "rotate":
      return rotateGrantKeyRingDocument(
        grantKeyRingToDocument(
          invocation.environment,
          loadGrantKeyRingFile(invocation.inputFile!, invocation.environment, { requiredOwnerUid })
            .keyRing,
        ),
        invocation.nextVersion,
      );
    default:
      throw new Error("Unsupported Grant key-ring write command.");
  }
}

function requiredVersions(
  versions: readonly string[],
):
  | { encryption: readonly string[]; lookup: readonly string[]; audit: readonly string[] }
  | undefined {
  return versions.length === 0
    ? undefined
    : { encryption: versions, lookup: versions, audit: versions };
}

function valueFor(args: readonly string[], name: string, start: number): string | undefined {
  const index = args.findIndex((value, offset) => offset >= start && value === name);
  return index === -1 ? undefined : args[index + 1];
}
