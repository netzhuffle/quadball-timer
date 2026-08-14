#!/usr/bin/env bun
import {
  createSqliteTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
} from "@/lib/technical-admin-auth";
import { readTechnicalAdminConfig } from "@/lib/technical-admin-config";

const config = readTechnicalAdminConfig();
const { environment } = config;
const databasePath = config.databasePath ?? `data/${environment}/technical-admin.sqlite`;

const auth = createTechnicalAdminAuth(
  config,
  createSqliteTechnicalAdminAuthRepository(databasePath, {
    environment,
    origin: config.origin,
    rpId: config.rpId,
  }),
);
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
