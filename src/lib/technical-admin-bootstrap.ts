import { createInterface } from "node:readline/promises";
import { stderr, stdin } from "node:process";
import {
  createSqliteTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
  type AuthResult,
  type EnrollmentAuthorization,
  type TechnicalAdminAuth,
  type TechnicalAdminAuthConfig,
  type TechnicalAdminEnvironment,
  type TechnicalAdminStorageStatus,
} from "@/lib/technical-admin-auth";
import { readRuntimeConfig } from "@/lib/runtime-config";

export type TechnicalAdminBootstrapCommand = "status" | "enroll" | "reset";

export type TechnicalAdminBootstrapInvocation =
  | { kind: "none" }
  | { kind: "invalid"; error: string }
  | { kind: "operation"; command: TechnicalAdminBootstrapCommand };

export type TechnicalAdminBootstrapStatus = {
  environment: TechnicalAdminEnvironment;
  credentialPresent: boolean;
  activeSessionCount: number;
  storage: TechnicalAdminStorageStatus["state"];
};

export type TechnicalAdminBootstrapResetResult =
  | AuthResult<EnrollmentAuthorization>
  | { ok: false; error: "invalid-confirmation" };

export type TechnicalAdminBootstrapOperations = {
  status(): TechnicalAdminBootstrapStatus;
  enroll(): AuthResult<EnrollmentAuthorization>;
  reset(confirmation: string): TechnicalAdminBootstrapResetResult;
};

export function parseTechnicalAdminBootstrapCli(
  args: readonly string[],
): TechnicalAdminBootstrapInvocation {
  const marker = args.indexOf("--technical-admin-bootstrap");
  if (marker === -1) return { kind: "none" };
  const prefixIsRuntimeEntrypoint = (value: string | undefined): boolean =>
    value !== undefined && value.length > 0 && !value.startsWith("--") && value.includes("/");
  const validPrefix =
    marker === 0 ||
    (marker === 1 && prefixIsRuntimeEntrypoint(args[0])) ||
    (marker === 2 && args[1] === "--" && prefixIsRuntimeEntrypoint(args[0]));
  if (!validPrefix || args.length !== marker + 2) {
    return { kind: "invalid", error: "Incomplete Technical Admin bootstrap command." };
  }

  const command = args[marker + 1];
  if (command !== "status" && command !== "enroll" && command !== "reset") {
    return { kind: "invalid", error: "Unknown Technical Admin bootstrap command." };
  }
  return { kind: "operation", command };
}

export function createTechnicalAdminBootstrapOperations(
  config: Pick<TechnicalAdminAuthConfig, "environment">,
  auth: Pick<
    TechnicalAdminAuth,
    "storageStatus" | "issueEnrollmentAuthorization" | "emergencyReset"
  >,
): TechnicalAdminBootstrapOperations {
  return {
    status() {
      const status = auth.storageStatus();
      return redactTechnicalAdminStorageStatus(config.environment, status);
    },
    enroll() {
      return auth.issueEnrollmentAuthorization();
    },
    reset(confirmation) {
      if (confirmation !== config.environment) {
        return { ok: false, error: "invalid-confirmation" };
      }
      return auth.emergencyReset();
    },
  };
}

export async function runTechnicalAdminBootstrapCli(
  invocation: Extract<TechnicalAdminBootstrapInvocation, { kind: "operation" }>,
): Promise<number> {
  let repository: ReturnType<typeof createSqliteTechnicalAdminAuthRepository> | undefined;
  try {
    const { technicalAdmin: config, storagePaths } = readRuntimeConfig();
    repository = createSqliteTechnicalAdminAuthRepository(storagePaths.technicalAdminDatabase, {
      environment: config.environment,
      origin: config.origin,
      rpId: config.rpId,
    });
    const auth = createTechnicalAdminAuth(config, repository);
    const operations = createTechnicalAdminBootstrapOperations(config, auth);

    if (invocation.command === "status") {
      console.log(JSON.stringify(operations.status()));
      return 0;
    }

    if (invocation.command === "enroll") {
      return printEnrollmentResult(operations.enroll());
    }

    if (!stdin.isTTY) {
      console.error("Technical Admin reset requires an interactive terminal.");
      return 2;
    }
    const readline = createInterface({ input: stdin, output: stderr });
    let confirmation: string;
    try {
      confirmation = await readline.question(
        `Type ${config.environment} to reset Technical Admin access: `,
      );
    } finally {
      readline.close();
    }
    return printEnrollmentResult(operations.reset(confirmation));
  } catch {
    console.error("Technical Admin bootstrap maintenance failed.");
    return 1;
  } finally {
    repository?.close();
  }
}

function redactTechnicalAdminStorageStatus(
  environment: TechnicalAdminEnvironment,
  status: TechnicalAdminStorageStatus,
): TechnicalAdminBootstrapStatus {
  return {
    environment,
    credentialPresent: status.credentialPresent,
    activeSessionCount: status.activeSessionCount,
    storage: status.state,
  };
}

function printEnrollmentResult(
  result: AuthResult<EnrollmentAuthorization> | TechnicalAdminBootstrapResetResult,
): number {
  if (!result.ok) {
    if (result.error === "invalid-confirmation") {
      console.error("Technical Admin reset cancelled.");
      return 1;
    }
    console.error(
      result.error === "not-enrollable"
        ? "Technical Admin enrollment is already complete."
        : "Technical Admin enrollment authorization was not issued.",
    );
    return 1;
  }
  console.log(result.value.url);
  return 0;
}
