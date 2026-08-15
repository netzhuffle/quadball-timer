import {
  createEventCatalog,
  createFoundationEventCatalogStorage,
  type EventCatalog,
  type CatalogOutcome,
} from "@/lib/event-catalog";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import { FoundationStorageNotReadyError } from "@/lib/foundation-storage";
import {
  MemoryTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
  type TechnicalAdminAuthority,
} from "@/lib/technical-admin-auth";
import { readRuntimeConfig } from "@/lib/runtime-config";

const args = process.argv.slice(2);
const databasePath = option("--db") ?? process.env.EVENT_CATALOG_DATABASE?.trim() ?? null;
const commands = new Set(["list", "inspect", "create", "update", "add-day", "update-day", "audit"]);
const command = args.find((arg) => commands.has(arg)) ?? "help";
let foundationStorage: ReturnType<typeof openSqliteFoundationStorage> | null = null;
let hostAuth: ReturnType<typeof createTechnicalAdminAuth> | null = null;

class InvalidCliInput extends Error {}

try {
  if (databasePath === null || databasePath.length === 0) {
    throw new InvalidCliInput(
      "A foundation database path is required via --db or EVENT_CATALOG_DATABASE.",
    );
  }
  foundationStorage = openSqliteFoundationStorage(databasePath);
  const readiness = await foundationStorage.readiness();
  if (!readiness.ok) throw new FoundationStorageNotReadyError(readiness);
  const catalog = createEventCatalog(createFoundationEventCatalogStorage(foundationStorage), {});
  hostAuth = createTechnicalAdminAuth(
    readRuntimeConfig().technicalAdmin,
    new MemoryTechnicalAdminAuthRepository(),
  );
  const result = await run(catalog, command, hostAuth);
  console.log(JSON.stringify(result));
  if (result.status !== "accepted") process.exitCode = 1;
} catch (error) {
  const result =
    error instanceof InvalidCliInput
      ? { status: "rejected", reason: "invalid-input", detail: error.message }
      : {
          status: "retryable-failure",
          detail: error instanceof Error ? error.message : "Event catalog CLI failed.",
        };
  console.log(JSON.stringify(result));
  process.exitCode = 1;
} finally {
  hostAuth?.close();
  foundationStorage?.close();
}

async function run(
  catalog: EventCatalog,
  name: string,
  hostAuth: ReturnType<typeof createTechnicalAdminAuth>,
): Promise<CatalogOutcome<unknown>> {
  const authority: TechnicalAdminAuthority = hostAuth.resolveHostLocalAuthority();
  switch (name) {
    case "list":
      return catalog.listEvents(authority);
    case "inspect":
      return catalog.inspectEvent(required("event-id"), authority);
    case "create":
      return catalog.createEvent(
        { name: required("name"), timeZone: required("timezone") },
        authority,
      );
    case "update":
      return catalog.updateEvent(
        required("event-id"),
        { name: option("--name"), timeZone: option("--timezone") },
        authority,
      );
    case "add-day":
      return catalog.addGameDay(required("event-id"), { date: required("date") }, authority);
    case "update-day":
      return catalog.updateGameDay(
        required("event-id"),
        required("game-day-id"),
        { date: required("date") },
        authority,
      );
    case "audit":
      return catalog.listAuditTrail(required("event-id"), authority);
    default:
      return {
        status: "rejected",
        reason: "invalid-input",
        detail:
          "Usage: list | inspect --event-id ID | create --name NAME --timezone ZONE | update --event-id ID [--name NAME] [--timezone ZONE] | add-day --event-id ID --date YYYY-MM-DD | update-day --event-id ID --game-day-id ID --date YYYY-MM-DD | audit --event-id ID",
      };
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
