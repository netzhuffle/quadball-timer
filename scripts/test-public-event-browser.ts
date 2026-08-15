import { chromium, type Page } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEventCatalog, createFoundationEventCatalogStorage } from "@/lib/event-catalog";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import {
  MemoryTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
  type TechnicalAdminAuthority,
} from "@/lib/technical-admin-auth";

const directory = mkdtempSync(join(tmpdir(), "quadball-timer-public-browser-"));
const foundationDatabase = join(directory, "foundation.sqlite");
const technicalAdminDatabase = join(directory, "technical-admin.sqlite");
const port = 38_000 + Math.floor(Math.random() * 1_000);
const origin = `http://127.0.0.1:${port}`;
const environment = {
  ...process.env,
  NODE_ENV: "test",
  QUADBALL_ENVIRONMENT: "test",
  PUBLIC_ORIGIN: "https://timer.example",
  FOUNDATION_DATABASE: foundationDatabase,
  TECHNICAL_ADMIN_DATABASE: technicalAdminDatabase,
  PORT: String(port),
  HOST: "127.0.0.1",
};

let server: Bun.Subprocess | null = null;
let serverStderr: Promise<string> | null = null;
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let browserPage: Page | null = null;

try {
  const seeded = await seedDatabase();
  server = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: process.cwd(),
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  serverStderr = new Response(server.stderr as unknown as BodyInit).text();
  await waitForServer(`${origin}/internal/healthz`);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  browserPage = page;
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("Failed to load resource")) {
      consoleErrors.push(message.text());
    }
  });

  const listResponse = await context.request.get(`${origin}/api/audience/events`);
  assert(listResponse.status() === 200, "seeded Audience list was unavailable");
  const listPayload = (await listResponse.json()) as {
    status: string;
    value: { events: Array<PublicEventFixture> };
  };
  assert(listPayload.status === "accepted", "seeded Audience list was not accepted");
  const current = listPayload.value.events.find((event) => event.eventId === seeded.currentId);
  if (!current) throw new Error("seeded current Event was not listed");

  await page.goto(`${origin}/events`);
  await page.waitForURL(`${origin}${current.canonicalPath}`);
  await page.getByRole("heading", { name: "Published Current" }).waitFor();

  const canonicalResponse = await page.goto(`${origin}${current.canonicalPath}`);
  await page.getByRole("heading", { name: "Published Current" }).waitFor();
  assert(
    canonicalResponse?.headers()["x-robots-tag"] === undefined,
    "Published canonical page was noindex",
  );

  await page.getByRole("button", { name: "All events" }).click();
  await page.waitForURL(`${origin}/events?view=all`);
  await page.getByRole("heading", { name: "Current Events" }).waitFor();
  await page.getByRole("link", { name: "Published Current" }).click();
  await page.waitForURL(`${origin}${current.canonicalPath}`);
  await page.getByRole("heading", { name: "Published Current" }).waitFor();
  await page.getByRole("button", { name: "All events" }).click();
  await page.waitForURL(`${origin}/events?view=all`);

  await page.route(`${origin}/api/audience/events`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "accepted",
        value: {
          events: [
            { ...current, lifecycle: "future", gameDays: [futureDate()] },
            {
              ...current,
              eventId: "event-unscheduled",
              name: "Unscheduled Event",
              lifecycle: "unscheduled",
              gameDays: [],
              canonicalPath: "/events/event-unscheduled",
            },
          ],
        },
      }),
    });
  });
  await page.goto(`${origin}/events`);
  await page.getByRole("heading", { name: "Current Events" }).waitFor();
  assert(page.url() === `${origin}/events`, "zero-current discovery auto-opened an Event");
  await page.getByText("No Event is current today.").waitFor();
  await page.unroute(`${origin}/api/audience/events`);

  await page.route(`${origin}/api/audience/events`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "accepted",
        value: {
          events: [
            current,
            {
              ...current,
              eventId: "event-current-two",
              name: "Second Current",
              canonicalPath: "/events/event-current-two",
            },
          ],
        },
      }),
    });
  });
  await page.goto(`${origin}/events`);
  await page.getByRole("heading", { name: "Current Events" }).waitFor();
  assert(page.url() === `${origin}/events`, "multiple-current discovery auto-opened an Event");
  await page.getByRole("link", { name: "Second Current" }).waitFor();
  await page.unroute(`${origin}/api/audience/events`);

  const sitemap = await context.request.get(`${origin}/sitemap.xml`);
  const sitemapBody = await sitemap.text();
  assert(sitemap.status() === 200, "sitemap was unavailable");
  assert(sitemapBody.includes(current.canonicalPath), "Published Event was omitted from sitemap");
  assert(!sitemapBody.includes(seeded.hiddenId), "hidden Event was included in sitemap");

  for (const eventId of [seeded.hiddenId, "unknown-event"]) {
    const response = await page.goto(`${origin}/events/${eventId}`);
    await page.getByRole("heading", { name: "Event unavailable" }).waitFor();
    assert(response?.headers()["x-robots-tag"] === "noindex", `${eventId} page was indexable`);
    assert(
      (await page
        .getByText("The Event may be hidden, unknown, or temporarily unavailable.")
        .count()) === 1,
      `${eventId} did not render the generic unavailable experience`,
    );
    await page.getByRole("button", { name: "Back to Home" }).click();
    await page.waitForURL(`${origin}/events?view=all`);
  }

  await page.route(`${origin}/api/audience/events/database-failure`, async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ status: "unavailable" }),
    });
  });
  const databaseFailureResponse = await page.goto(`${origin}/events/database-failure`);
  await page.getByRole("heading", { name: "Event unavailable" }).waitFor();
  assert(
    databaseFailureResponse?.headers()["x-robots-tag"] === "noindex",
    "database-failure page was indexable",
  );
  await page.getByRole("button", { name: "Back to Home" }).click();
  await page.waitForURL(`${origin}/events?view=all`);
  await page.unroute(`${origin}/api/audience/events/database-failure`);

  await page.getByRole("button", { name: /Start an Ad Hoc Game/ }).click();
  await page.waitForURL(new RegExp(`${origin}/game/adhoc-[a-zA-Z0-9_-]+$`));
  assert(consoleErrors.length === 0, `browser console errors: ${consoleErrors.join(" | ")}`);
  console.log(
    JSON.stringify({
      status: "passed",
      zeroCurrent: true,
      oneCurrentAutoOpen: true,
      multipleCurrentDiscovery: true,
      canonicalNavigation: true,
      unavailableHiddenUnknown: true,
      unavailableDatabaseFailure: true,
      publishedSitemapExclusion: true,
      adHocHandoff: true,
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  if (browserPage) {
    console.error(`browser_url=${browserPage.url()}`);
    console.error(
      `browser_text=${(await browserPage.locator("body").innerText()).slice(0, 1_000)}`,
    );
  }
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) {
    server.kill();
    await server.exited;
    const diagnostics = serverStderr ? await serverStderr : "";
    if (diagnostics.trim().length > 0) console.error(diagnostics.trim());
  }
  rmSync(directory, { recursive: true, force: true });
}

type PublicEventFixture = {
  eventId: string;
  name: string;
  lifecycle: "unscheduled" | "current" | "future" | "past";
  gameDays: string[];
  canonicalPath: string;
};

async function seedDatabase() {
  const foundation = openSqliteFoundationStorage(foundationDatabase);
  await foundation.applyMigrations();
  const catalog = createEventCatalog(createFoundationEventCatalogStorage(foundation), {});
  const hostAuth = createTechnicalAdminAuth(
    { environment: "test", origin: "https://timer.example", rpId: "timer.example" },
    new MemoryTechnicalAdminAuthRepository(),
  );
  const authority = hostAuth.resolveHostLocalAuthority();
  try {
    const current = await createPublishedEvent(catalog, authority, "Published Current", 0);
    await createPublishedEvent(catalog, authority, "Published Future", 1);
    await createPublishedEvent(catalog, authority, "Published Past", -1);
    const hidden = await catalog.createEvent({ name: "Hidden Event", timeZone: "UTC" }, authority);
    if (hidden.status !== "accepted") throw new Error("hidden Event creation failed");
    return { currentId: current, hiddenId: hidden.value.eventId };
  } finally {
    hostAuth.close();
    foundation.close();
  }
}

async function createPublishedEvent(
  catalog: ReturnType<typeof createEventCatalog>,
  authority: TechnicalAdminAuthority,
  name: string,
  dayOffset: number,
) {
  const event = await catalog.createEvent({ name, timeZone: "UTC" }, authority);
  if (event.status !== "accepted") throw new Error(`${name} creation failed`);
  const day = await catalog.addGameDay(
    event.value.eventId,
    { date: dateOffset(dayOffset) },
    authority,
  );
  if (day.status !== "accepted") throw new Error(`${name} Game Day creation failed`);
  const published = await catalog.changePublicationStatus(
    event.value.eventId,
    { status: "published", impactConfirmed: true },
    authority,
  );
  if (published.status !== "accepted") throw new Error(`${name} publication failed`);
  return event.value.eventId;
}

function dateOffset(offset: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function futureDate() {
  return dateOffset(1);
}

async function waitForServer(url: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = Bun.spawnSync(["curl", "-k", "-sSf", "-H", `host: localhost:${port}`, url]);
    if (response.exitCode === 0) return;
    await Bun.sleep(100);
  }
  throw new Error("Public Event browser server did not become ready.");
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
