import {
  createEventAdministration,
  type EventAdministration,
  type EventAdministrationOutcome,
} from "@/lib/event-administration";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import { FoundationStorageNotReadyError } from "@/lib/foundation-storage";
import {
  MemoryTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
  type TechnicalAdminAuthority,
} from "@/lib/technical-admin-auth";
import { readTechnicalAdminConfig } from "@/lib/technical-admin-config";
import { createGrantAuthority } from "@/lib/grant-authority";
import { readGrantAuthorityOptions } from "@/lib/grant-runtime";

const args = process.argv.slice(2);
const databasePath = option("--db") ?? process.env.EVENT_CATALOG_DATABASE?.trim() ?? null;
const command = args.find((arg) =>
  ["status", "create", "rotate", "disable", "revoke", "reactivate", "reveal", "admit"].includes(
    arg,
  ),
);
let foundationStorage: ReturnType<typeof openSqliteFoundationStorage> | null = null;
let hostAuth: ReturnType<typeof createTechnicalAdminAuth> | null = null;

class InvalidCliInput extends Error {}

try {
  if (databasePath === null || databasePath.length === 0)
    throw new InvalidCliInput(
      "A foundation database path is required via --db or EVENT_CATALOG_DATABASE.",
    );
  if (command === "reveal" || command === "admit")
    throw new InvalidCliInput(
      "This machine-readable CLI never accepts or reveals a raw Grant credential; use the browser handoff.",
    );
  if (command === undefined) throw new InvalidCliInput(usage());

  foundationStorage = openSqliteFoundationStorage(databasePath);
  const config = readTechnicalAdminConfig();
  const grants = createGrantAuthority(
    foundationStorage,
    readGrantAuthorityOptions(config.environment),
  );
  const readiness = await foundationStorage.readiness();
  if (!readiness.ok) throw new FoundationStorageNotReadyError(readiness);
  hostAuth = createTechnicalAdminAuth(config, new MemoryTechnicalAdminAuthRepository());
  const administration = createEventAdministration({
    storage: foundationStorage,
    grants,
  });
  const result = await run(administration, command, hostAuth.resolveHostLocalAuthority());
  console.log(JSON.stringify(result));
  if (result.status !== "accepted") process.exitCode = 1;
} catch (error) {
  const result =
    error instanceof InvalidCliInput
      ? { status: "rejected", reason: "invalid-input", detail: error.message }
      : {
          status: "retryable-failure",
          detail: error instanceof Error ? error.message : "Event Admin CLI failed.",
        };
  console.log(JSON.stringify(result));
  process.exitCode = 1;
} finally {
  hostAuth?.close();
  foundationStorage?.close();
}

async function run(
  administration: EventAdministration,
  name: string,
  authority: TechnicalAdminAuthority,
): Promise<EventAdministrationOutcome<unknown>> {
  const eventId = required("event-id");
  switch (name) {
    case "status":
      return administration.inspectEventAdminGrant(eventId, authority);
    case "create":
      return administration.createEventAdminGrant(eventId, authority);
    case "rotate":
      return administration.rotateEventAdminGrant(eventId, authority);
    case "disable":
      return administration.disableEventAdminGrant(eventId, authority);
    case "revoke":
      return administration.revokeEventAdminGrant(eventId, authority);
    case "reactivate":
      return administration.reactivateEventAdminGrant(eventId, authority);
    default:
      return { status: "rejected", reason: "invalid-input", detail: usage() };
  }
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

function required(name: string): string {
  const value = option(`--${name}`);
  if (value === undefined) throw new InvalidCliInput(`Missing --${name}.`);
  return value;
}

function usage(): string {
  return "Usage: status|create|rotate|disable|revoke|reactivate --event-id ID; reveal/admit require the browser handoff.";
}
