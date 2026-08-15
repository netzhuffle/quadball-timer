import type { TechnicalAdminAuthConfig } from "@/lib/technical-admin-auth";
import { readTechnicalAdminConfig } from "@/lib/technical-admin-config";
import {
  assertEnvironmentStorageBoundary,
  readRuntimeStoragePaths,
  type RuntimeStoragePaths,
} from "@/lib/runtime-storage-config";

export type RuntimeConfig = {
  technicalAdmin: TechnicalAdminAuthConfig;
  storagePaths: RuntimeStoragePaths;
};

export function readRuntimeConfig(
  environmentVariables: Record<string, string | undefined> = process.env,
): RuntimeConfig {
  const technicalAdmin = readTechnicalAdminConfig(environmentVariables);
  const storagePaths = readRuntimeStoragePaths(technicalAdmin.environment, environmentVariables);
  assertEnvironmentStorageBoundary(technicalAdmin.environment, storagePaths);
  return { technicalAdmin, storagePaths };
}
