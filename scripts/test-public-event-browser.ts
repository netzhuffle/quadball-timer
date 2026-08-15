import { chromium, type Page } from "playwright";
import tailwind from "bun-plugin-tailwind";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
  createEventCatalog,
  createFoundationEventCatalogStorage,
  type EventGame,
} from "@/lib/event-catalog";
import { createEventGameRecord, type ExternalScopeResolver } from "@/lib/event-game-record";
import type { ControlActionInput } from "@/lib/event-game-actions";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import { createGrantKeyRingDocument, writeGrantKeyRingFile } from "@/lib/grant-key-ring-custody";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import { readGrantAuthorityOptions } from "@/lib/grant-runtime";
import { createLiveEventGameIqaInterpreter } from "@/lib/live-event-game-control";
import {
  MemoryTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
  type TechnicalAdminAuthority,
} from "@/lib/technical-admin-auth";
import type { PublicAudienceClockProjection } from "@/lib/audience-projection";

const directory = mkdtempSync(join(tmpdir(), "quadball-timer-public-browser-"));
const foundationDatabase = join(directory, "foundation.sqlite");
const technicalAdminDatabase = join(directory, "technical-admin.sqlite");
const grantKeyRingFile = join(directory, "grant-key-ring.json");
writeGrantKeyRingFile(grantKeyRingFile, createGrantKeyRingDocument("test"));
const port = 38_000 + Math.floor(Math.random() * 1_000);
const origin = `http://127.0.0.1:${port}`;
const environment = {
  ...process.env,
  NODE_ENV: "test",
  QUADBALL_ENVIRONMENT: "test",
  PUBLIC_ORIGIN: "https://timer.example",
  FOUNDATION_DATABASE: foundationDatabase,
  TECHNICAL_ADMIN_DATABASE: technicalAdminDatabase,
  GRANT_KEY_RING_FILE: grantKeyRingFile,
  PORT: String(port),
  HOST: "127.0.0.1",
};

let server: Bun.Subprocess | null = null;
let serverStderr: Promise<string> | null = null;
let harnessServer: ReturnType<typeof Bun.serve> | null = null;
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
  await seedCommittedGameRecords(seeded);

  const harnessDirectory = join(directory, "timeline-harness");
  mkdirSync(harnessDirectory);
  const harnessBuild = await Bun.build({
    entrypoints: [join(process.cwd(), "scripts/public-game-timeline-browser-harness.tsx")],
    outdir: harnessDirectory,
    plugins: [tailwind],
    target: "browser",
    format: "esm",
    sourcemap: "none",
  });
  if (!harnessBuild.success) {
    throw new Error(
      `Timeline browser harness build failed: ${harnessBuild.logs.map((log) => log.message).join("; ")}`,
    );
  }
  const harnessEntry = harnessBuild.outputs.find((output) => output.kind === "entry-point");
  if (harnessEntry === undefined) throw new Error("Timeline browser harness entry is missing.");
  const harnessAssets = new Map(
    harnessBuild.outputs.map((output) => [basename(output.path), output.path]),
  );
  const harnessScript = basename(harnessEntry.path);
  const harnessStylesheet = [...harnessAssets.keys()].find((name) => name.endsWith(".css"));
  harnessServer = Bun.serve({
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/") {
        return new Response(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">${
            harnessStylesheet === undefined
              ? ""
              : `<link rel="stylesheet" href="/${harnessStylesheet}">`
          }</head><body><div id="root"></div><script type="module" src="/${harnessScript}"></script></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      const assetPath = harnessAssets.get(pathname.slice(1));
      return assetPath === undefined
        ? new Response("Not found", { status: 404 })
        : new Response(Bun.file(assetPath));
    },
  });
  const harnessOrigin = `http://127.0.0.1:${harnessServer.port}`;

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
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

  const eventResponse = await context.request.get(
    `${origin}/api/audience/events/${encodeURIComponent(seeded.currentId)}`,
  );
  assert(eventResponse.status() === 200, "seeded Audience Event was unavailable");
  const denseEvent = structuredClone((await eventResponse.json()) as PublicEventResponseFixture);
  const denseGame = denseEvent.value.schedule.scheduleGames.find(
    (game) => game.gameCode === "BUSY-1",
  );
  if (denseGame === undefined) throw new Error("seeded finished Game was not projected");
  const longReason =
    "A deliberately long public penalty reason that must wrap inside the narrow Timeline without horizontal overflow";
  denseGame.timeline = [
    ...Array.from(
      { length: 24 },
      (_, index) =>
        ({
          kind: "card",
          gameTimeMs: 90_000 - index * 1_000,
          lane: "side-a",
          teamName: "A deliberately long public Event Team name for wrapping",
          player: {
            number: 7,
            name: "A deliberately long roster-resolved player name for wrapping",
          },
          cardColor: "yellow",
          penaltyReason: longReason,
        }) satisfies PublicTimelineFixtureEntry,
    ),
    {
      kind: "card",
      gameTimeMs: 88_000,
      lane: "side-b",
      teamName: "The other long public Event Team",
      player: { number: 12, name: "Side B roster-resolved player" },
      cardColor: "blue",
      penaltyReason: "Side B lane coverage",
    },
    {
      kind: "suspension",
      gameTimeMs: 87_000,
      lane: "center",
      teamName: null,
      player: null,
      action: "start",
    },
    ...denseGame.timeline,
  ];
  await page.route(
    `${origin}/api/audience/events/${encodeURIComponent(seeded.currentId)}`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(denseEvent),
      });
    },
  );

  await page.goto(`${origin}/events`);
  await page.waitForURL(`${origin}${current.canonicalPath}`);
  await page.getByRole("heading", { name: "Published Current" }).waitFor();
  await page.getByRole("heading", { name: "Coming up" }).waitFor();
  await page.getByRole("heading", { name: "Event schedule" }).waitFor();
  const liveNow = page.locator('[data-schedule-group="live-now"]');
  await liveNow.locator('[data-game-code="BUSY-2"]').waitFor();
  await liveNow.locator('[data-game-code="BUSY-3"]').waitFor();
  assert(
    (await liveNow.locator('[data-schedule-card][data-schedule-status="running"]').count()) === 2,
    "both committed running Games were not shown in Live now",
  );
  const liveCardClasses = await liveNow
    .locator("[data-schedule-card]")
    .evaluateAll((cards) =>
      cards.map((card) => card.firstElementChild?.getAttribute("class") ?? ""),
    );
  assert(new Set(liveCardClasses).size === 1, "running Games did not receive equal card treatment");
  const schedule = page.locator('[data-schedule-group="event-schedule"]');
  for (const [code, status] of [
    ["BUSY-1", "past"],
    ["BUSY-2", "running"],
    ["BUSY-4", "awaiting-start"],
    ["BUSY-5", "future"],
  ] as const) {
    assert(
      (await schedule
        .locator(`[data-game-code="${code}"][data-schedule-status="${status}"]`)
        .count()) === 1,
      `${code} did not retain chronological status ${status}`,
    );
  }
  const finishedTimeline = schedule.locator(
    '[data-game-code="BUSY-1"][data-schedule-status="past"] [data-game-timeline]',
  );
  await finishedTimeline.waitFor();
  assert(
    (await finishedTimeline.locator('[data-timeline-kind="finish"]').count()) === 1,
    "finished Game did not render its effective public Timeline",
  );
  await finishedTimeline.getByText("Game Timeline").waitFor();
  assert(
    (await finishedTimeline.locator('[data-timeline-kind="card"]').count()) >= 24,
    "dense public Timeline content was not rendered",
  );
  assert(
    (await finishedTimeline.locator('[data-timeline-lane="side-a"]').count()) >= 24,
    "side A Timeline events were not rendered in their lane",
  );
  assert(
    (await finishedTimeline.locator('[data-timeline-lane="side-b"]').count()) >= 1,
    "side B Timeline events were not rendered in their lane",
  );
  assert(
    (await finishedTimeline
      .locator('[data-timeline-lane="center"][data-timeline-kind="suspension"]')
      .count()) === 1,
    "centered lifecycle Timeline event was not rendered",
  );
  await finishedTimeline.getByText(longReason).first().waitFor();
  const timelineScroll = finishedTimeline.locator("[data-timeline-scroll-region]");
  const scrollMetrics = await timelineScroll.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  assert(
    scrollMetrics.scrollHeight > scrollMetrics.clientHeight,
    "Timeline did not become scrollable",
  );

  assert(
    (await page.locator('[data-schedule-group="coming-up"] h3').count()) === 1,
    "Coming up Games were not grouped by Expected Start",
  );
  await page.getByText("Pitch Pitch 1").first().waitFor();
  await page.getByText("Pitch Pitch 2").first().waitFor();
  await page.getByText("Scheduled Start").first().waitFor();
  assert(
    (await page.locator("body").innerText()).includes("Expected Start"),
    "Expected Start was not rendered",
  );
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
    "phone-sized Event schedule overflows horizontally",
  );

  const harnessPage = await context.newPage();
  harnessPage.setDefaultTimeout(5_000);
  harnessPage.on("pageerror", (error) => consoleErrors.push(error.message));
  harnessPage.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await harnessPage.goto(`${harnessOrigin}/`);
  const harnessTimeline = harnessPage.locator("[data-game-timeline]");
  await harnessTimeline.waitFor();
  const harnessScroll = harnessTimeline.locator("[data-timeline-scroll-region]");
  await harnessScroll.evaluate((element) => {
    element.scrollTop = Math.floor(element.scrollHeight / 2);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  const harnessBeforeNewPlay = await harnessScroll.evaluate((element) => ({
    bottomDistance: element.scrollHeight - element.clientHeight - element.scrollTop,
    scrollTop: element.scrollTop,
  }));
  assert(harnessBeforeNewPlay.scrollTop > 0, "Timeline harness could not leave the live edge");
  await harnessPage.getByRole("button", { name: "Deliver newer play while away" }).click();
  await harnessPage.getByRole("button", { name: "New play" }).waitFor();
  const harnessAfterNewPlay = await harnessScroll.evaluate((element) => ({
    bottomDistance: element.scrollHeight - element.clientHeight - element.scrollTop,
    scrollTop: element.scrollTop,
  }));
  assert(
    Math.abs(harnessAfterNewPlay.bottomDistance - harnessBeforeNewPlay.bottomDistance) <= 4,
    "Timeline harness changed the older-entry viewport position",
  );
  await harnessPage.getByRole("button", { name: "New play" }).click();
  await harnessPage.waitForFunction(
    (selector) => ((document.querySelector(selector) as HTMLElement | null)?.scrollTop ?? 0) <= 8,
    "[data-timeline-scroll-region]",
  );
  await harnessPage.getByRole("button", { name: "Deliver newer play at live edge" }).click();
  await harnessPage.waitForFunction(
    (selector) => ((document.querySelector(selector) as HTMLElement | null)?.scrollTop ?? 0) <= 8,
    "[data-timeline-scroll-region]",
  );
  assert(
    (await harnessPage.getByRole("button", { name: "New play" }).count()) === 0,
    "Timeline harness exposed New play at the live edge",
  );

  const spectatorGamePath = `/events/${encodeURIComponent(current.eventId)}/games/browser-fixture`;
  let browserClockFreshness: PublicAudienceClockProjection["synchronization"] = "stale";
  await page.route(
    `${origin}/api/audience/events/${encodeURIComponent(current.eventId)}/games/browser-fixture`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "accepted",
          value: publicGameFixture(current.eventId, browserClockFreshness),
        }),
      });
    },
  );
  await page.goto(`${origin}${spectatorGamePath}`);
  await page.getByRole("heading", { name: "Live Final" }).waitFor();
  await page.locator("[data-scoreboard-expanded]").waitFor();
  await page.getByText("Last synchronized:").waitFor();
  await page.getByText("Target 40").waitFor();
  await page.getByText("Suspended").first().waitFor();
  await page.getByText("started · 0:30 remaining · decision pending").waitFor();
  await page.getByText("Team Timeout").waitFor();
  await page.getByText("Game Suspension").waitFor();
  await page.getByText("Heat Stoppage").waitFor();
  await page.getByText("Winner Side A · Locked").waitFor();
  await page.getByText("Roster-resolved spectator").waitFor();
  assert(
    (await page.locator('[data-game-timeline] [data-timeline-kind="goal"]').count()) === 1,
    "dedicated spectator Game did not render its roster-resolved Timeline",
  );
  const expandedSides = page.locator("[data-scoreboard-expanded] [data-side-id]");
  assert((await expandedSides.count()) === 2, "expanded scoreboard did not render two sides");
  assert(
    (await expandedSides.nth(0).getAttribute("data-side-id")) === "side-b" &&
      (await expandedSides.nth(1).getAttribute("data-side-id")) === "side-a",
    "expanded scoreboard reordered sides without stable IDs",
  );
  assert(
    (await expandedSides.nth(0).innerText()).includes("FLAG CATCH") &&
      !(await expandedSides.nth(1).innerText()).includes("FLAG CATCH"),
    "expanded scoreboard marked the wrong catching side",
  );
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
    "phone-sized spectator Game overflows horizontally",
  );
  assert(
    !(await page.locator("[data-scoreboard-expanded]").getAttribute("class"))?.includes("sticky"),
    "expanded spectator scoreboard remained sticky",
  );
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.locator("[data-scoreboard-compact]").waitFor();
  const compactText = await page.locator("[data-scoreboard-compact]").innerText();
  for (const value of [
    "A Very Long Team Name That Must Wrap On A Phone",
    "Another Very Long Team Name For A Narrow Phone",
    "40",
    "30",
    "2:05",
    "Stale clock",
    "Game Phase: Overtime",
    "Operational status: Suspended",
    "Schedule: Past",
    "FLAG CATCH",
  ]) {
    assert(compactText.includes(value), `compact scoreboard omitted ${value}`);
  }
  assert(
    (await page.locator("[data-scoreboard-compact]").getAttribute("class"))?.includes("sticky") ===
      true,
    "compact spectator scoreboard did not become sticky after scrolling",
  );
  const compactSides = page.locator("[data-scoreboard-compact] [data-side-id]");
  assert((await compactSides.count()) === 2, "compact scoreboard did not render two sides");
  assert(
    (await compactSides.nth(0).getAttribute("data-side-id")) === "side-b" &&
      (await compactSides.nth(1).getAttribute("data-side-id")) === "side-a",
    "compact scoreboard reordered sides without stable IDs",
  );
  assert(
    (await compactSides.nth(0).innerText()).includes("FLAG CATCH") &&
      !(await compactSides.nth(1).innerText()).includes("FLAG CATCH"),
    "compact scoreboard marked the wrong catching side",
  );
  for (const [status, label] of [
    ["synchronized", "Synchronized clock"],
    ["estimated", "Estimated clock"],
    ["stale", "Stale clock"],
    ["unavailable", "Clock unavailable"],
  ] as const) {
    browserClockFreshness = status;
    await page.reload();
    await page.getByText(label).first().waitFor();
  }
  await page.unroute(
    `${origin}/api/audience/events/${encodeURIComponent(current.eventId)}/games/browser-fixture`,
  );
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
      busyPhoneSchedule: true,
      spectatorGamePhone: true,
      spectatorScoreboardCompaction: true,
      spectatorSportingProjection: true,
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
  if (harnessServer) await harnessServer.stop(true);
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

function publicGameFixture(
  eventId: string,
  synchronization: PublicAudienceClockProjection["synchronization"] = "stale",
) {
  return {
    eventId,
    gameCode: "BROWSER-1",
    gameDesignation: "Live Final",
    scheduledStartMs: Date.now() - 20 * 60_000,
    expectedStartMs: Date.now() - 18 * 60_000,
    scheduleStatus: "past",
    phase: "overtime",
    operationalStatus: "suspended",
    pitch: "Pitch 1",
    sideA: {
      name: "A Very Long Team Name That Must Wrap On A Phone",
      color: "#112233",
      score: 40,
    },
    sideB: {
      name: "Another Very Long Team Name For A Narrow Phone",
      color: "#445566",
      score: 30,
    },
    overtimeTarget: 40,
    clock: {
      gameTimeMs: 125_000,
      activePenaltyTimeMs: 0,
      running: false,
      projectedAtMs: Date.now(),
      synchronization,
      lastSynchronizedAtMs: synchronization === "unavailable" ? null : Date.now() - 30_000,
      cues: {
        flagRunnerEntry: "passed",
        seekerWarning: "passed",
        seekerCountdownMs: null,
        seekerRelease: "released",
      },
    },
    teamTimeout: { status: "started", side: "side-a", remainingMs: 30_000 },
    gameSuspension: "suspended",
    heatStoppage: {
      status: "started",
      mode: "enabled",
      pending: true,
      allowedDurationMs: 120_000,
      actualDurationMs: 90_000,
      remainingMs: 30_000,
    },
    flagState: { catchingSide: "side-b" },
    result: { status: "finished", winner: "side-a", locked: true },
    presentation: {
      pitchOrientation: "side-b-left",
      displayedTeamColors: { sideA: "#112233", sideB: "#445566" },
    },
    canonicalPath: `/events/${encodeURIComponent(eventId)}/games/browser-fixture`,
    timeline: [
      {
        kind: "goal",
        gameTimeMs: 124_000,
        lane: "side-b",
        teamName: "Another Very Long Team Name For A Narrow Phone",
        player: { number: 7, name: "Roster-resolved spectator" },
        points: 10,
      },
    ],
  };
}

type PublicTimelineFixtureEntry = {
  kind: string;
  gameTimeMs: number | null;
  lane: string;
  teamName: string | null;
  player: { number: number; name: string | null } | null;
  cardColor?: string | null;
  penaltyReason?: string | null;
  [key: string]: unknown;
};

type PublicGameProjectionFixture = {
  gameCode: string | null;
  timeline: PublicTimelineFixtureEntry[];
  [key: string]: unknown;
};

type PublicEventResponseFixture = {
  status: string;
  value: {
    schedule: {
      scheduleGames: PublicGameProjectionFixture[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
};

async function seedDatabase() {
  const foundation = openSqliteFoundationStorage(foundationDatabase, {
    grantKeyRing: readGrantAuthorityOptions("test", environment).keyRing,
  });
  await foundation.applyMigrations();
  const catalog = createEventCatalog(createFoundationEventCatalogStorage(foundation), {});
  const hostAuth = createTechnicalAdminAuth(
    { environment: "test", origin: "https://timer.example", rpId: "timer.example" },
    new MemoryTechnicalAdminAuthRepository(),
  );
  const authority = hostAuth.resolveHostLocalAuthority();
  try {
    const current = await createPublishedEvent(catalog, authority, "Published Current", 0, true);
    await createPublishedEvent(catalog, authority, "Published Future", 1);
    await createPublishedEvent(catalog, authority, "Published Past", -1);
    const hidden = await catalog.createEvent({ name: "Hidden Event", timeZone: "UTC" }, authority);
    if (hidden.status !== "accepted") throw new Error("hidden Event creation failed");
    return {
      currentId: current.eventId,
      currentGameDayId: current.gameDayId,
      currentGames: current.games,
      hiddenId: hidden.value.eventId,
    };
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
  withSchedule = false,
) {
  const event = await catalog.createEvent({ name, timeZone: "UTC" }, authority);
  if (event.status !== "accepted") throw new Error(`${name} creation failed`);
  const day = await catalog.addGameDay(
    event.value.eventId,
    { date: dateOffset(dayOffset) },
    authority,
  );
  if (day.status !== "accepted") throw new Error(`${name} Game Day creation failed`);
  const games = withSchedule
    ? await createBusySchedule(catalog, authority, event.value.eventId, day.value.gameDayId)
    : [];
  const published = await catalog.changePublicationStatus(
    event.value.eventId,
    { status: "published", impactConfirmed: true },
    authority,
  );
  if (published.status !== "accepted") throw new Error(`${name} publication failed`);
  return { eventId: event.value.eventId, gameDayId: day.value.gameDayId, games };
}

async function createBusySchedule(
  catalog: ReturnType<typeof createEventCatalog>,
  authority: TechnicalAdminAuthority,
  eventId: string,
  gameDayId: string,
) {
  const firstPitch = await catalog.createPitch(eventId, { name: "Pitch 1" }, authority);
  const secondPitch = await catalog.createPitch(eventId, { name: "Pitch 2" }, authority);
  if (firstPitch.status !== "accepted" || secondPitch.status !== "accepted") {
    throw new Error("busy Event Pitch creation failed");
  }
  const now = Date.now();
  const starts = [
    now - 90 * 60_000,
    now - 30 * 60_000,
    now - 30 * 60_000,
    now - 5 * 60_000,
    now + 20 * 60_000,
    now + 90 * 60_000,
  ];
  const created: Array<{ game: EventGame; pitchId: string; pitchSlotId: string }> = [];
  for (const [index, startMs] of starts.entries()) {
    const slot = await catalog.createGameplaySlot(
      eventId,
      gameDayId,
      { sequence: index + 1, scheduledStart: new Date(startMs).toISOString().slice(0, 16) },
      authority,
    );
    if (slot.status !== "accepted") throw new Error("busy Event Gameplay Slot creation failed");
    if (index === 2) {
      const delayed = await catalog.setGameplaySlotExpectedDelay(
        eventId,
        gameDayId,
        slot.value.gameplaySlotId,
        { expectedDelayMs: 5 * 60_000 },
        authority,
      );
      if (delayed.status !== "accepted") throw new Error("busy Event delay change failed");
    }
    const inspected = await catalog.inspectEvent(eventId, authority);
    if (inspected.status !== "accepted") throw new Error("busy Event inspection failed");
    const pitchSlots = inspected.value.pitchSlots.filter(
      (candidate) => candidate.gameplaySlotId === slot.value.gameplaySlotId,
    );
    const pitchSlot = pitchSlots[index % pitchSlots.length];
    if (pitchSlot === undefined) throw new Error("busy Event Pitch Slot creation failed");
    const game = await catalog.createEventGame(
      eventId,
      gameDayId,
      {
        gameplaySlotId: slot.value.gameplaySlotId,
        pitchSlotId: pitchSlot.pitchSlotId,
        gameCode: `BUSY-${index + 1}`,
        gameDesignation: `Busy Game ${index + 1}`,
        sideA: { sourceLabel: `Blue ${index + 1}` },
        sideB: { sourceLabel: `Red ${index + 1}` },
      },
      authority,
    );
    if (game.status !== "accepted") throw new Error("busy Event Game creation failed");
    created.push({
      game: game.value,
      pitchId: pitchSlot.pitchId,
      pitchSlotId: pitchSlot.pitchSlotId,
    });
  }

  return created;
}

async function seedCommittedGameRecords(seeded: {
  currentId: string;
  currentGameDayId: string;
  currentGames: readonly { game: EventGame; pitchId: string; pitchSlotId: string }[];
}) {
  const foundation = openSqliteFoundationStorage(foundationDatabase, {
    grantKeyRing: readGrantAuthorityOptions("test", environment).keyRing,
  });
  const resolver = createSeedScopeResolver();
  for (const [index, entry] of seeded.currentGames.entries()) {
    if (index > 2) continue;
    const root = createSeedRoot(
      seeded.currentId,
      seeded.currentGameDayId,
      entry.game.eventGameId,
      entry.pitchId,
      entry.pitchSlotId,
    );
    const record = createEventGameRecord(foundation, {
      externalScopeResolver: resolver,
      interpreter: createLiveEventGameIqaInterpreter(),
      clock: () => Date.now(),
    });
    const registered = await record.registerRoot(root);
    if (registered.status !== "registered") throw new Error("busy Event root registration failed");
    const action = await record.acceptAction(
      index === 0 ? createSeedForfeitAction(root) : createSeedClockAction(root),
    );
    if (action.status !== "accepted") throw new Error("busy Event action commit failed");
    if (index === 0) {
      const finished = await record.transitionLifecycle({
        ...root.lifecycle,
        phase: "finished",
        finishedAtMs: Date.now(),
      });
      if (finished.status !== "updated") throw new Error("busy Event finish commit failed");
    }
  }
  foundation.close();
}

function createSeedScopeResolver(): ExternalScopeResolver {
  return {
    resolve(scope, snapshot) {
      const pitchSlot = snapshot.findPitchSlot?.(scope.pitchSlotId) ?? null;
      return pitchSlot !== null &&
        pitchSlot.eventId === scope.eventId &&
        pitchSlot.gameDayId === scope.gameDayId &&
        pitchSlot.pitchId === scope.pitchId
        ? { status: "resolved", scope: structuredClone(scope) }
        : { status: "mismatch", detail: "Seed Event Game Pitch Slot is unavailable." };
    },
    resolveEventTeam(eventId, eventTeamId) {
      return eventId.length > 0 && eventTeamId.length > 0
        ? { status: "resolved" }
        : { status: "missing", detail: "Seed Event Team is unavailable." };
    },
  };
}

function createSeedRoot(
  eventId: string,
  gameDayId: string,
  eventGameId: string,
  pitchId: string,
  pitchSlotId: string,
): EventGameRecordRoot {
  const createdAtMs = Date.now();
  return {
    recordId: `seed-record-${eventGameId}`,
    eventId,
    eventGameId,
    ownership: { eventId, eventGameId },
    externalScope: {
      eventId,
      gameDayId,
      pitchId,
      pitchSlotId,
    },
    gameSides: [
      {
        id: `seed-side-${eventGameId}-a`,
        eventTeamId: `seed-team-${eventGameId}-a`,
        teamInterpretationRef: "seed-team-a-v1",
      },
      {
        id: `seed-side-${eventGameId}-b`,
        eventTeamId: `seed-team-${eventGameId}-b`,
        teamInterpretationRef: "seed-team-b-v1",
      },
    ],
    lifecycle: {
      phase: "in-progress",
      commencedAtMs: createdAtMs,
      finishedAtMs: null,
      lockedAtMs: null,
      lockReason: null,
    },
    compatibility: {
      recordVersion: "event-game-record-v1",
      schemaVersion: "event-game-record-v1",
      interpreterVersion: "live-event-iqa-v1",
    },
    creationEvidence: {
      operationId: `seed-create-${eventGameId}`,
      actorReference: "public-browser-test",
      source: "event-game-registration",
      createdAtMs,
    },
  };
}

function createSeedClockAction(root: EventGameRecordRoot): ControlActionInput {
  return createSeedAction(root, `seed-clock-${root.eventGameId}`, "clock", null, {
    command: "set-running",
    running: true,
    gameTimeMs: 0,
    sportingOrder: 0,
  });
}

function createSeedForfeitAction(root: EventGameRecordRoot): ControlActionInput {
  return createSeedAction(
    root,
    `seed-forfeit-${root.eventGameId}`,
    "forfeit",
    root.gameSides[1].id,
    { resultKind: "forfeit", sportingOrder: 0 },
  );
}

function createSeedAction(
  root: EventGameRecordRoot,
  operationId: string,
  factType: string,
  gameSideId: string | null,
  data: Record<string, unknown>,
): ControlActionInput {
  const trustedAtMs = Date.now();
  return {
    recordId: root.recordId,
    eventGameId: root.eventGameId,
    operationId,
    kind: { id: "game-fact", version: "1" },
    payload: {
      factId: operationId,
      factType,
      gameSideId,
      gameTimeMs: 0,
      data,
    },
    causalPredecessorIds: [],
    occurrence: { trustedAtMs, clientOriginAtMs: trustedAtMs, source: "online" },
    grant: { sessionId: "public-browser-seed", versionId: "public-browser-seed-v1" },
    lifecycle: structuredClone(root.lifecycle),
  };
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
