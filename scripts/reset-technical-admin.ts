#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { stdin, stderr } from "node:process";
import {
  createSqliteTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
  type TechnicalAdminAuthRepository,
} from "@/lib/technical-admin-auth";
import { readTechnicalAdminConfig } from "@/lib/technical-admin-config";

const config = readTechnicalAdminConfig();
const databasePath = config.databasePath ?? `data/${config.environment}/technical-admin.sqlite`;
let repository: TechnicalAdminAuthRepository | undefined;
let statusPrinted = false;

try {
  repository = createSqliteTechnicalAdminAuthRepository(databasePath, {
    environment: config.environment,
    origin: config.origin,
    rpId: config.rpId,
  });
  const auth = createTechnicalAdminAuth(config, repository);
  const status = auth.storageStatus();
  console.log(
    JSON.stringify({
      environment: config.environment,
      origin: config.origin,
      rpId: config.rpId,
      credentialPresent: status.credentialPresent,
      activeSessionCount: status.activeSessionCount,
      storage: status.state,
    }),
  );
  statusPrinted = true;
  if (status.state !== "ready") {
    console.error("Technical Admin storage is not safe to reset.");
    process.exitCode = 1;
  } else {
    const readline = createInterface({ input: stdin, output: stderr });
    const answer = await readline.question(
      `Type ${config.environment} to reset Technical Admin access for ${config.origin} (RP ID ${config.rpId}): `,
    );
    readline.close();
    if (answer.trim() !== config.environment) {
      console.error("Reset cancelled.");
      process.exitCode = 1;
    } else {
      const result = auth.emergencyReset();
      if (!result.ok) {
        console.error("Technical Admin reset failed; no enrollment URL was issued.");
        process.exitCode = 1;
      } else {
        console.log(result.value.url);
        console.error(
          `Enrollment authorization expires at ${new Date(result.value.expiresAtMs).toISOString()}.`,
        );
      }
    }
  }
} catch {
  if (!statusPrinted) {
    console.log(
      JSON.stringify({
        environment: config.environment,
        origin: config.origin,
        rpId: config.rpId,
        storage: "unavailable",
      }),
    );
  }
  console.error("Technical Admin reset failed; no enrollment URL was issued.");
  process.exitCode = 1;
} finally {
  repository?.close();
}
