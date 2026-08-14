#!/usr/bin/env bun
import {
  createSqliteTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
} from "@/lib/technical-admin-auth";
import { readRuntimeConfig } from "@/lib/runtime-config";

const { technicalAdmin: config, storagePaths } = readRuntimeConfig();
const { environment } = config;
const databasePath = storagePaths.technicalAdminDatabase;

const repository = createSqliteTechnicalAdminAuthRepository(databasePath, {
  environment,
  origin: config.origin,
  rpId: config.rpId,
});
try {
  const auth = createTechnicalAdminAuth(config, repository);
  const result = auth.issueEnrollmentAuthorization();
  if (!result.ok) {
    console.error(
      result.error === "not-enrollable"
        ? "Technical Admin enrollment is already complete."
        : "Unable to create enrollment authorization.",
    );
    process.exitCode = 1;
  } else {
    console.log(result.value.url);
    console.error(
      `Enrollment authorization expires at ${new Date(result.value.expiresAtMs).toISOString()}.`,
    );
  }
} finally {
  repository.close();
}
