import { chromium, type Locator, type Page, webkit } from "playwright";
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
import {
  createControlActionCodecRegistry,
  type ControlActionInput,
} from "@/lib/event-game-actions";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import {
  createGrantKeyRingDocument,
  loadGrantKeyRingFile,
  writeGrantKeyRingFile,
} from "@/lib/grant-key-ring-custody";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import { readGrantAuthorityOptions } from "@/lib/grant-runtime";
import { createLiveEventGameIqaInterpreter } from "@/lib/live-event-game-control";
import {
  MemoryTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
  type TechnicalAdminAuthority,
} from "@/lib/technical-admin-auth";

const directory = mkdtempSync(join(tmpdir(), "quadball-timer-public-browser-"));
const foundationDatabase = join(directory, "foundation.sqlite");
const eventGameDatabase = join(directory, "event-game.sqlite");
const technicalAdminDatabase = join(directory, "technical-admin.sqlite");
const grantKeyRingFile = join(directory, "grant-key-ring.json");
writeGrantKeyRingFile(grantKeyRingFile, createGrantKeyRingDocument("test"));
const liveEventKeyRing = loadGrantKeyRingFile(grantKeyRingFile, "test", {
  requiredOwnerUid: process.getuid?.() ?? 0,
}).keyRing;
const encodeLiveEventKey = (key: Uint8Array | undefined) =>
  key === undefined ? "" : Buffer.from(key).toString("base64url");
const port = 38_000 + Math.floor(Math.random() * 1_000);
const origin = `http://127.0.0.1:${port}`;
type DisconnectableWebSocketRoute = {
  close(options?: { code?: number; reason?: string }): Promise<void>;
};
const environment = {
  ...process.env,
  NODE_ENV: "test",
  QUADBALL_ENVIRONMENT: "test",
  PUBLIC_ORIGIN: "https://timer.example",
  FOUNDATION_DATABASE: foundationDatabase,
  TECHNICAL_ADMIN_DATABASE: technicalAdminDatabase,
  EVENT_GAME_DATABASE: eventGameDatabase,
  EVENT_GAME_ENCRYPTION_KEY: encodeLiveEventKey(
    liveEventKeyRing.encryption.keys.get("encryption-v1"),
  ),
  EVENT_GAME_LOOKUP_KEY: encodeLiveEventKey(liveEventKeyRing.lookup.keys.get("lookup-v1")),
  EVENT_GAME_AUDIT_KEY: encodeLiveEventKey(liveEventKeyRing.audit.keys.get("audit-v1")),
  GRANT_KEY_RING_FILE: grantKeyRingFile,
  PORT: String(port),
  HOST: "127.0.0.1",
};

let server: Bun.Subprocess | null = null;
let serverStderr: Promise<string> | null = null;
let harnessServer: ReturnType<typeof Bun.serve> | null = null;
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let webkitBrowser: Awaited<ReturnType<typeof webkit.launch>> | null = null;
let browserPage: Page | null = null;

try {
  const seeded = await seedDatabase();
  await seedCommittedGameRecords(seeded);
  server = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: process.cwd(),
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  serverStderr = new Response(server.stderr as unknown as BodyInit).text();
  await waitForServer(`${origin}/internal/healthz`);

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
  const context = await browser.newContext({ viewport: { width: 360, height: 844 } });
  const page = await context.newPage();
  browserPage = page;
  const consoleErrors = setupBrowserPage(page);

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
  await page.getByRole("heading", { name: "Coming up" }).waitFor();
  await page.getByRole("heading", { name: "Event schedule" }).waitFor();
  assert((await page.getByRole("main").count()) === 1, "public Event page has no main landmark");
  const skipLink = page.getByRole("link", { name: "Skip to main content" });
  await skipLink.focus();
  assert(
    await skipLink.evaluate((element) => document.activeElement === element),
    "skip link could not receive keyboard focus",
  );
  assert(
    (await skipLink.getAttribute("href")) === "#main-content" &&
      (await page.locator("#main-content").count()) === 1,
    "skip link did not provide a keyboard destination",
  );
  assert(
    (await page.locator('[data-live-projection-status][role="status"]').count()) === 1,
    "public Event did not expose a live-update status announcement",
  );
  const liveNow = page.locator('[data-schedule-group="live-now"]');
  await liveNow.locator('[data-game-code="BUSY-2"]').waitFor();
  await liveNow.locator('[data-game-code="BUSY-3"]').waitFor();
  assert(
    (await liveNow.locator('[data-schedule-card][data-schedule-status="running"]').count()) === 2,
    "both committed running Games were not shown in Live now",
  );
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
      `${code} did not retain chronological status ${status}; ${await schedule.innerText()}`,
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
  assert(
    (await page.locator('[data-schedule-group="coming-up"] h3[id^="expected-"]').count()) === 1,
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
    "360px phone-sized Event schedule overflows horizontally",
  );

  const harnessPage = await context.newPage();
  setupBrowserPage(harnessPage, consoleErrors);
  await harnessPage.goto(`${harnessOrigin}/`);
  const harnessTimeline = harnessPage.locator("[data-game-timeline]");
  await harnessTimeline.waitFor();
  const harnessScroll = harnessTimeline.locator("[data-timeline-scroll-region]");
  await harnessScroll.hover();
  await harnessPage.mouse.wheel(0, 600);
  await harnessPage.waitForFunction(
    (selector) => ((document.querySelector(selector) as HTMLElement | null)?.scrollTop ?? 0) > 8,
    "[data-timeline-scroll-region]",
  );
  const harnessBeforeNewPlay = await harnessScroll.evaluate((element) => ({
    bottomDistance: element.scrollHeight - element.clientHeight - element.scrollTop,
    scrollTop: element.scrollTop,
  }));
  assert(harnessBeforeNewPlay.scrollTop > 0, "Timeline harness could not leave the live edge");
  await harnessPage.getByRole("button", { name: "Deliver newer play while away" }).click();
  await harnessPage.getByRole("button", { name: "Show newest play" }).waitFor();
  const harnessAfterNewPlay = await harnessScroll.evaluate((element) => ({
    bottomDistance: element.scrollHeight - element.clientHeight - element.scrollTop,
    scrollTop: element.scrollTop,
  }));
  assert(
    Math.abs(harnessAfterNewPlay.bottomDistance - harnessBeforeNewPlay.bottomDistance) <= 4,
    "Timeline harness changed the older-entry viewport position",
  );
  await harnessPage.getByRole("button", { name: "Show newest play" }).click();
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
    (await harnessPage.getByRole("button", { name: "Show newest play" }).count()) === 0,
    "Timeline harness exposed New play at the live edge",
  );

  const stableGamePath = `/events/${encodeURIComponent(seeded.currentId)}/games/${encodeURIComponent(
    seeded.currentGames[1]!.game.eventGameId,
  )}`;
  await openEventAndActivateSpectatorGame(page, current, stableGamePath, {
    expectedScore: "0",
    expectedTimelineText: "Original Player",
    focusGameLink: async (keyboardGameLink) => {
      const keyboardAllEvents = page.getByRole("button", { name: "All events" });
      await keyboardAllEvents.focus();
      await page.keyboard.press("Shift+Tab");
      assert(
        await page.evaluate(
          () =>
            document.activeElement?.getAttribute("href") === "#main-content" &&
            document.activeElement?.matches(":focus-visible") === true,
        ),
        "skip navigation did not receive visible keyboard focus",
      );
      await page.keyboard.press("Tab");
      assert(
        await keyboardAllEvents.evaluate((element) => document.activeElement === element),
        "keyboard focus did not move from skip navigation to Event navigation",
      );
      await page.keyboard.press("Tab");
      assert(
        await keyboardGameLink.evaluate((element) => document.activeElement === element),
        "keyboard focus did not move into schedule Game navigation",
      );
      await page.keyboard.press("Shift+Tab");
      assert(
        await keyboardAllEvents.evaluate((element) => document.activeElement === element),
        "Shift-Tab did not return focus to Event navigation",
      );
      await page.keyboard.press("Tab");
      assert(
        await keyboardGameLink.evaluate((element) => document.activeElement === element),
        "Tab did not restore focus to the canonical spectator Game link",
      );
      assert(
        await keyboardGameLink.evaluate(
          (element) =>
            element.matches(":focus-visible") && getComputedStyle(element).boxShadow !== "none",
        ),
        "canonical spectator Game link did not expose visible keyboard focus styling",
      );
    },
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}${current.canonicalPath}`);
  await page.getByRole("heading", { name: "Published Current" }).waitFor();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
    "desktop Event schedule overflows horizontally",
  );
  assert(
    (await page.locator("[data-schedule-card]").count()) >= 5,
    "desktop Event journey did not render the schedule",
  );
  await page.setViewportSize({ width: 360, height: 844 });

  const streamedGame = schedule.locator('[data-game-code="BUSY-2"]');
  assert(
    (await streamedGame.getByRole("link", { name: /Open spectator Game/ }).count()) === 1,
    "schedule Game did not expose a keyboard-operable spectator link",
  );
  const initialScore = await streamedGame.locator('[aria-label="Side A score"]').innerText();
  assert(initialScore === "0", "canonical Event page did not render the initial scoreboard");
  assert(
    (await streamedGame.locator('[data-timeline-kind="goal"]').count()) === 0,
    "canonical Event page unexpectedly rendered the future goal",
  );

  await exerciseLiveSpectatorGameBehavior(page, seeded, current, stableGamePath, {
    engineLabel: "Chromium",
    initialRosterName: "Original Player",
    correctedRosterName: "Corrected Player",
    actionPrefix: "browser-convergence",
    sportingOrder: 1_000,
  });

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

  await page.goto(`${origin}${current.canonicalPath}`);
  await page.getByRole("heading", { name: "Published Current" }).waitFor();
  await page.getByText("Corrected Player").waitFor();
  webkitBrowser = await webkit.launch({ headless: true });
  try {
    await runWebKitCriticalPath(webkitBrowser, seeded, current, stableGamePath);
  } finally {
    await webkitBrowser.close();
    webkitBrowser = null;
  }
  await assertWithdrawnPublicEvent(page, current.name, "WebKit Corrected Player", "Chromium");
  await page.goto(`${origin}/events?view=all`);
  await page.getByRole("heading", { name: "Current Events" }).waitFor();
  const adHoc = page.getByRole("button", { name: /Start an Ad Hoc Game/ });
  await page.getByLabel("Away color").focus();
  await page.keyboard.press("Tab");
  assert(
    await adHoc.evaluate(
      (element) =>
        document.activeElement === element &&
        element.matches(":focus-visible") &&
        getComputedStyle(element).boxShadow !== "none",
    ),
    "Ad Hoc handoff did not expose visible focus styling",
  );
  await page.keyboard.press("Enter");
  await page.waitForURL(new RegExp(`${origin}/game/adhoc-[a-zA-Z0-9_-]+$`));
  assert(consoleErrors.length === 0, `browser console errors: ${consoleErrors.join(" | ")}`);
  console.log(
    JSON.stringify({
      status: "passed",
      zeroCurrent: true,
      oneCurrentAutoOpen: true,
      multipleCurrentDiscovery: true,
      busyPhoneSchedule: true,
      publicEventScheduleScoreTimelineConvergence: true,
      stableGameScheduleScoreTimelineConvergence: true,
      canonicalNavigation: true,
      unavailableHiddenUnknown: true,
      unavailableDatabaseFailure: true,
      publishedSitemapExclusion: true,
      adHocHandoff: true,
      keyboardAccessible: true,
      semanticLandmarks: true,
      liveUpdateAnnouncements: true,
      spectatorGameNavigation: true,
      keyboardTimeline: true,
      stickyCompactScore: true,
      timelineNewPlayPreservesContext: true,
      effectiveGameCorrection: true,
      reducedMotionTimeline: true,
      webkitPublicCriticalPath: true,
      webkitLiveConvergence: true,
      webkitRosterReconnectRecovery: true,
      webkitTimelineContextPreservation: true,
      webkitEffectiveGameCorrection: true,
      webkitPublicationWithdrawal: true,
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
  if (webkitBrowser) await webkitBrowser.close();
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

type SeededPublicEvent = Awaited<ReturnType<typeof seedDatabase>>;

function setupBrowserPage(page: Page, errors: string[] = []) {
  page.setDefaultTimeout(5_000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("Failed to load resource")) {
      errors.push(message.text());
    }
  });
  return errors;
}

async function openEventAndActivateSpectatorGame(
  page: Page,
  current: PublicEventFixture,
  stableGamePath: string,
  options: {
    expectedScore: string;
    expectedTimelineText: string;
    focusGameLink: (gameLink: Locator) => Promise<void>;
  },
) {
  await page.goto(`${origin}${current.canonicalPath}`);
  await page.getByRole("heading", { name: current.name }).waitFor();
  assert((await page.getByRole("main").count()) === 1, "public Event has no main landmark");
  await page.getByRole("heading", { name: "Event schedule" }).waitFor();
  await page.locator('[data-schedule-group="live-now"]').waitFor();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
    "360px public Event overflows horizontally",
  );
  const gameLink = page.locator('[data-game-code="BUSY-2"] a[href*="/games/"]').first();
  await options.focusGameLink(gameLink);
  assert(
    await gameLink.evaluate((element) => document.activeElement === element),
    "spectator Game link was not focused before keyboard activation",
  );
  await page.keyboard.press("Enter");
  await page.waitForURL(`${origin}${stableGamePath}`);
  await page.getByRole("heading", { name: "Busy Game 2" }).waitFor();
  assert(
    page.url() === `${origin}${stableGamePath}`,
    "keyboard activation did not navigate to the canonical spectator Game",
  );
  assert((await page.getByRole("main").count()) === 1, "spectator Game has no main landmark");
  await page.waitForFunction(
    (expectedScore) =>
      document.querySelector('[aria-label="Side A score"]')?.textContent?.trim() === expectedScore,
    options.expectedScore,
  );
  await page.getByText(options.expectedTimelineText).waitFor();
  await page.locator('[data-timeline-scroll-region][role="region"][tabindex="0"]').waitFor();
  await page.waitForFunction(
    () =>
      document
        .querySelector("[data-live-projection-status]")
        ?.textContent?.includes("connected") === true,
  );
}

async function exerciseLiveSpectatorGameBehavior(
  page: Page,
  seeded: SeededPublicEvent,
  current: PublicEventFixture,
  stableGamePath: string,
  options: {
    engineLabel: string;
    initialRosterName: string;
    correctedRosterName: string;
    actionPrefix: string;
    sportingOrder: number;
  },
) {
  const websocket = {
    routeCount: 0,
    activeRoute: null as DisconnectableWebSocketRoute | null,
  };
  await page.routeWebSocket(/\/ws$/, (route) => {
    const serverRoute = route.connectToServer();
    websocket.routeCount += 1;
    websocket.activeRoute = route;
    route.onMessage((message) => serverRoute.send(message));
    serverRoute.onMessage((message) => route.send(message));
  });
  await page.goto(`${origin}${stableGamePath}`);
  await page.getByRole("heading", { name: "Busy Game 2" }).waitFor();
  assert(
    (await page.getByRole("main").count()) === 1,
    `${options.engineLabel} spectator Game has no main landmark`,
  );
  assert(
    (await page.locator('[data-live-projection-status][role="status"]').count()) === 1,
    `${options.engineLabel} spectator Game did not expose a live-update status announcement`,
  );
  const stableGameScore = page.locator('[aria-label="Side A score"]');
  await stableGameScore.waitFor();
  assert(
    (await stableGameScore.innerText()) === "0",
    `${options.engineLabel} stable Game page did not render its snapshot`,
  );
  assert(
    (await page.locator('[data-timeline-kind="goal"]').count()) === 0,
    `${options.engineLabel} stable Game page unexpectedly rendered a future goal`,
  );
  await publicRosterTimelineEntry(page, options.initialRosterName).waitFor();
  const liveStatus = page.locator('[data-live-projection-status][role="status"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector("[data-live-projection-status]")
        ?.textContent?.includes("connected") === true,
  );
  const initialClock = await page.locator("[data-scoreboard-expanded] .font-mono").innerText();
  await page.waitForFunction(
    (initial) =>
      document.querySelector("[data-scoreboard-expanded] .font-mono")?.textContent?.trim() !==
      initial,
    initialClock,
  );
  assert(initialClock.length > 0, `${options.engineLabel} did not render its live Clock`);

  const firstWebSocketRoute = requireWebSocketRoute(websocket.activeRoute);
  const firstWebSocketCount = websocket.routeCount;
  await firstWebSocketRoute.close({
    code: 1000,
    reason: `${options.engineLabel} browser reconnect test`,
  });
  await liveStatus.waitFor({ state: "attached" });
  await page.waitForFunction(
    () =>
      document
        .querySelector("[data-live-projection-status]")
        ?.textContent?.includes("reconnecting") === true,
  );
  await updateRosterMapping(seeded, options.correctedRosterName);
  await page.waitForFunction(
    () =>
      document
        .querySelector("[data-live-projection-status]")
        ?.textContent?.includes("connected") === true,
  );
  const reconnectDeadline = Date.now() + 5_000;
  while (websocket.routeCount <= firstWebSocketCount && Date.now() < reconnectDeadline) {
    await Bun.sleep(50);
  }
  await publicRosterTimelineEntry(page, options.correctedRosterName).waitFor();
  assert(
    websocket.routeCount > firstWebSocketCount,
    `${options.engineLabel} did not establish a replacement WebSocket after disconnect`,
  );
  assert(
    (await publicRosterTimelineEntry(page, options.initialRosterName).count()) === 0,
    `${options.engineLabel} retained the superseded roster label after recovery`,
  );

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const compactScoreboard = page.locator(
    '[data-scoreboard-compact][aria-label="Compact live scoreboard"]',
  );
  await compactScoreboard.waitFor({ state: "visible" });
  assert(
    await compactScoreboard.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return (
        getComputedStyle(element).position === "sticky" &&
        rect.top >= 0 &&
        rect.top <= 16 &&
        rect.right <= document.documentElement.clientWidth
      );
    }),
    `${options.engineLabel} 360px Game did not expose a usable sticky compact score`,
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  const timelineRegion = page.locator('[data-timeline-scroll-region][role="region"][tabindex="0"]');
  await timelineRegion.scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Back to Event" }).focus();
  await page.keyboard.press("Tab");
  const timelineBefore = await timelineRegion.evaluate((element) => {
    const region = element as HTMLDivElement;
    const maximumScrollTop = region.scrollHeight - region.clientHeight;
    region.scrollTop = Math.min(200, maximumScrollTop);
    region.dispatchEvent(new Event("scroll", { bubbles: true }));
    const regionRect = region.getBoundingClientRect();
    const anchor = Array.from(region.querySelectorAll<HTMLElement>("[data-timeline-kind]")).find(
      (entry) => {
        const rect = entry.getBoundingClientRect();
        return rect.top >= regionRect.top && rect.bottom <= regionRect.bottom;
      },
    );
    return {
      scrollTop: region.scrollTop,
      scrollHeight: region.scrollHeight,
      clientHeight: region.clientHeight,
      focused: document.activeElement === region,
      focusVisible: region.matches(":focus-visible"),
      boxShadow: getComputedStyle(region).boxShadow,
      reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      scrollBehavior: getComputedStyle(region).scrollBehavior,
      anchorText: anchor?.textContent ?? null,
      anchorTop: anchor === undefined ? null : anchor.getBoundingClientRect().top - regionRect.top,
    };
  });
  assert(
    timelineBefore.scrollHeight > timelineBefore.clientHeight && timelineBefore.scrollTop > 8,
    `${options.engineLabel} Timeline could not start away from the live edge`,
  );
  assert(
    timelineBefore.focused &&
      timelineBefore.focusVisible &&
      timelineBefore.boxShadow !== "none" &&
      timelineBefore.reducedMotion &&
      timelineBefore.scrollBehavior === "auto",
    `${options.engineLabel} reduced-motion Timeline was not active and keyboard-focused`,
  );

  await acceptCommittedGoal(seeded, options.actionPrefix, options.sportingOrder);
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Side A score"]')?.textContent?.trim() === "10",
  );
  await page.locator('[data-timeline-kind="goal"]').first().waitFor();
  const newPlay = page.getByRole("button", { name: "Show newest play" });
  await newPlay.waitFor({ state: "visible" });
  const timelineAfter = await timelineRegion.evaluate((element, anchorText) => {
    const region = element as HTMLDivElement;
    const anchor = Array.from(region.querySelectorAll<HTMLElement>("[data-timeline-kind]")).find(
      (entry) => entry.textContent === anchorText,
    );
    return {
      scrollTop: region.scrollTop,
      scrollHeight: region.scrollHeight,
      focused: document.activeElement === region,
      anchorTop:
        anchor === undefined
          ? null
          : anchor.getBoundingClientRect().top - region.getBoundingClientRect().top,
    };
  }, timelineBefore.anchorText);
  const timelineHeightDelta = timelineAfter.scrollHeight - timelineBefore.scrollHeight;
  assert(
    timelineAfter.focused &&
      timelineHeightDelta > 0 &&
      timelineBefore.anchorText !== null &&
      timelineBefore.anchorTop !== null &&
      timelineAfter.anchorTop !== null &&
      timelineAfter.scrollTop > timelineBefore.scrollTop &&
      Math.abs(timelineAfter.anchorTop - timelineBefore.anchorTop) <= 10,
    `${options.engineLabel} new play did not preserve Timeline position and focus: ${JSON.stringify({ timelineBefore, timelineAfter, timelineHeightDelta })}`,
  );
  assert(
    (await newPlay.innerText()) === "New play",
    `${options.engineLabel} did not expose the accessible New play action`,
  );
  await newPlay.focus();
  await page.keyboard.press("Enter");
  const activatedTimeline = await timelineRegion.evaluate((element) => ({
    scrollTop: (element as HTMLDivElement).scrollTop,
    focused: document.activeElement === element,
    firstKind: element.querySelector("[data-timeline-kind]")?.getAttribute("data-timeline-kind"),
  }));
  assert(
    activatedTimeline.scrollTop <= 8 &&
      activatedTimeline.focused &&
      activatedTimeline.firstKind === "goal",
    `${options.engineLabel} reduced-motion New play activation lost the live edge or focus`,
  );

  await acceptCommittedGoalCorrection(seeded, options.actionPrefix);
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Side A score"]')?.textContent?.trim() === "0" &&
      document.querySelectorAll('[data-timeline-kind="goal"]').length === 0,
  );
  assert(
    await timelineRegion.evaluate((element) => document.activeElement === element),
    `${options.engineLabel} effective Game Correction stole Timeline focus`,
  );
  assert(
    page.url() === `${origin}${stableGamePath}`,
    `${options.engineLabel} stable Game update reloaded the page`,
  );

  await page.goto(`${origin}${current.canonicalPath}`);
  await page.getByRole("heading", { name: current.name }).waitFor();
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.textContent?.trim() === "0",
    '[data-game-code="BUSY-2"] [aria-label="Side A score"]',
  );
  assert(
    (await page.locator('[data-game-code="BUSY-2"] [data-timeline-kind="goal"]').count()) === 0,
    `${options.engineLabel} corrected Goal remained in the Event Timeline`,
  );
  await publicRosterTimelineEntry(page, options.correctedRosterName).waitFor();
  assert(
    (await page.locator('[data-game-code="BUSY-2"][data-schedule-status="running"]').count()) >= 1,
    `${options.engineLabel} stream update removed the canonical schedule card`,
  );
}

function publicRosterTimelineEntry(page: Page, publicName: string) {
  return page
    .locator('[data-timeline-kind="card"]')
    .filter({ hasText: `Player #7 · ${publicName}` });
}

async function assertWithdrawnPublicEvent(
  page: Page,
  eventName: string,
  rosterName: string,
  engineLabel: string,
) {
  await page.getByRole("heading", { name: "Event unavailable" }).waitFor();
  const withdrawnBody = await page.locator("body").innerText();
  assert(!withdrawnBody.includes(eventName), `${engineLabel} retained the withdrawn Event name`);
  assert(!withdrawnBody.includes(rosterName), `${engineLabel} retained withdrawn roster data`);
  assert(
    (await page.locator("[data-schedule-card]").count()) === 0,
    `${engineLabel} retained the withdrawn Event schedule`,
  );
}

async function runWebKitCriticalPath(
  webkitInstance: Awaited<ReturnType<typeof webkit.launch>>,
  seeded: SeededPublicEvent,
  current: PublicEventFixture,
  stableGamePath: string,
) {
  const context = await webkitInstance.newContext({ viewport: { width: 360, height: 844 } });
  const page = await context.newPage();
  const consoleErrors = setupBrowserPage(page);
  try {
    await openEventAndActivateSpectatorGame(page, current, stableGamePath, {
      expectedScore: "0",
      expectedTimelineText: "Corrected Player",
      focusGameLink: async (gameLink) => {
        await gameLink.focus();
        assert(
          await gameLink.evaluate(
            (element) =>
              document.activeElement === element && getComputedStyle(element).boxShadow !== "none",
          ),
          "WebKit spectator Game link did not expose visible keyboard focus",
        );
      },
    });
    await exerciseLiveSpectatorGameBehavior(page, seeded, current, stableGamePath, {
      engineLabel: "WebKit",
      initialRosterName: "Corrected Player",
      correctedRosterName: "WebKit Corrected Player",
      actionPrefix: "webkit-convergence",
      sportingOrder: 1_100,
    });
    await withdrawPublishedEvent(seeded.currentId);
    await assertWithdrawnPublicEvent(page, current.name, "WebKit Corrected Player", "WebKit");
    assert(
      consoleErrors.length === 0,
      `WebKit browser console errors: ${consoleErrors.join(" | ")}`,
    );
  } finally {
    await context.close();
  }
}

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
  if (withSchedule) {
    const rosterTeamId = games[1]?.game.sideB.eventTeamId;
    if (rosterTeamId === null || rosterTeamId === undefined) {
      throw new Error(`${name} roster Event Team was not confirmed`);
    }
    const roster = await catalog.upsertEventTeamRoster(
      event.value.eventId,
      rosterTeamId,
      { playerNumber: 7, publicName: "Original Player" },
      authority,
    );
    if (roster.status !== "accepted") throw new Error(`${name} roster creation failed`);
  }
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
  const blueTeam = await catalog.createEventTeam(
    eventId,
    { name: "Blue Team", defaultColor: "#2563eb" },
    authority,
  );
  const redTeam = await catalog.createEventTeam(
    eventId,
    { name: "Red Team", defaultColor: "#dc2626" },
    authority,
  );
  if (blueTeam.status !== "accepted" || redTeam.status !== "accepted") {
    throw new Error("busy Event Team creation failed");
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
    const confirmed = await catalog.confirmGameplaySlotTeams(
      eventId,
      gameDayId,
      slot.value.gameplaySlotId,
      {
        games: [
          {
            eventGameId: game.value.eventGameId,
            sideAEventTeamId: blueTeam.value.eventTeamId,
            sideBEventTeamId: redTeam.value.eventTeamId,
          },
        ],
      },
      authority,
    );
    if (confirmed.status !== "accepted") throw new Error("busy Event Team mapping failed");
    const confirmedGame = confirmed.value[0];
    if (confirmedGame === undefined) throw new Error("busy Event Team mapping returned no Game");
    created.push({
      game: confirmedGame,
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
  const eventGameStorage = openSqliteFoundationStorage(eventGameDatabase, {
    grantKeyRing: liveEventKeyRing,
  });
  await eventGameStorage.applyMigrations({ requireCandidate: false });
  try {
    for (const [index, entry] of seeded.currentGames.entries()) {
      if (index > 2) continue;
      const sideAEventTeamId = entry.game.sideA.eventTeamId;
      const sideBEventTeamId = entry.game.sideB.eventTeamId;
      if (sideAEventTeamId === null || sideBEventTeamId === null) {
        throw new Error(
          `confirmed Event Team identities are missing for ${entry.game.eventGameId}`,
        );
      }
      const root = createSeedRoot(
        seeded.currentId,
        seeded.currentGameDayId,
        entry.game.eventGameId,
        entry.pitchId,
        entry.pitchSlotId,
        sideAEventTeamId,
        sideBEventTeamId,
      );
      await seedEventGameRecord(foundation, root, createSeedScopeResolver(), index);
      await seedEventGameRecord(eventGameStorage, root, createEventGameSeedScopeResolver(), index);
    }
  } finally {
    eventGameStorage.close();
    foundation.close();
  }
}

async function seedEventGameRecord(
  storage: ReturnType<typeof openSqliteFoundationStorage>,
  root: EventGameRecordRoot,
  resolver: ExternalScopeResolver,
  index: number,
) {
  const record = createEventGameRecord(storage, {
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
  if (index === 1) {
    for (let playerNumber = 20; playerNumber < 30; playerNumber += 1) {
      const historyCard = await record.acceptAction(
        createSeedAction(
          root,
          `seed-history-card-${root.eventGameId}-${playerNumber}`,
          "card",
          root.gameSides[1].id,
          {
            cardType: "blue",
            playerNumber,
            penaltyStart: "immediate",
            sportingOrder: playerNumber,
          },
        ),
      );
      if (historyCard.status !== "accepted") {
        throw new Error("busy Event Timeline history commit failed");
      }
    }
    const card = await record.acceptAction(
      createSeedAction(root, `seed-card-${root.eventGameId}`, "card", root.gameSides[1].id, {
        cardType: "blue",
        playerNumber: 7,
        penaltyStart: "immediate",
        sportingOrder: 100,
      }),
    );
    if (card.status !== "accepted") throw new Error("busy Event card commit failed");
  }
  if (index === 0) {
    const finished = await record.transitionLifecycle({
      ...root.lifecycle,
      phase: "finished",
      finishedAtMs: Date.now(),
    });
    if (finished.status !== "updated") throw new Error("busy Event finish commit failed");
  }
}

async function acceptCommittedGoal(
  seeded: SeededPublicEvent,
  actionPrefix: string,
  sportingOrder: number,
) {
  await withCommittedGameStorages(
    seeded,
    "browser convergence Game is unavailable",
    async (storage, entry, resolver, storageKind) =>
      acceptGameRecordActionOnStorage(storage, entry, resolver, "browser convergence", (root) =>
        createSeedAction(
          root,
          `${actionPrefix}-goal-${storageKind}`,
          "goal",
          root.gameSides[0]?.id ?? null,
          { points: 10, sportingOrder },
        ),
      ),
  );
}

async function acceptCommittedGoalCorrection(seeded: SeededPublicEvent, actionPrefix: string) {
  await withCommittedGameStorages(
    seeded,
    "browser correction Game is unavailable",
    async (storage, entry, resolver, storageKind) =>
      acceptGameRecordActionOnStorage(storage, entry, resolver, "browser correction", (root) =>
        createSeedCorrectionAction(
          root,
          `${actionPrefix}-goal-correction-${storageKind}`,
          `${actionPrefix}-goal-${storageKind}`,
          false,
        ),
      ),
  );
}

async function withCommittedGameStorages(
  seeded: {
    currentGames: readonly { game: EventGame; pitchId: string; pitchSlotId: string }[];
  },
  unavailableMessage: string,
  operation: (
    storage: ReturnType<typeof openSqliteFoundationStorage>,
    entry: { game: EventGame; pitchId: string; pitchSlotId: string },
    resolver: ExternalScopeResolver,
    storageKind: "catalog" | "runtime",
  ) => Promise<void>,
) {
  const entry = seeded.currentGames[1];
  if (entry === undefined) throw new Error(unavailableMessage);
  const runtime = openSqliteFoundationStorage(eventGameDatabase, {
    grantKeyRing: liveEventKeyRing,
  });
  const catalog = openSqliteFoundationStorage(foundationDatabase, {
    grantKeyRing: readGrantAuthorityOptions("test", environment).keyRing,
  });
  try {
    const readinessContext = {
      actionCodecRegistry: createControlActionCodecRegistry(),
      interpreter: createLiveEventGameIqaInterpreter(),
    };
    runtime.setReadinessContext(readinessContext);
    catalog.setReadinessContext(readinessContext);
    await operation(catalog, entry, createSeedScopeResolver(), "catalog");
    await operation(runtime, entry, createEventGameSeedScopeResolver(), "runtime");
  } finally {
    catalog.close();
    runtime.close();
  }
}

async function updateRosterMapping(
  seeded: {
    currentId: string;
    currentGames: readonly { game: EventGame; pitchId: string; pitchSlotId: string }[];
  },
  publicName: string,
) {
  const entry = seeded.currentGames[1];
  const eventTeamId = entry?.game.sideB.eventTeamId;
  if (entry === undefined || eventTeamId === null || eventTeamId === undefined) {
    throw new Error("browser roster correction Event Team is unavailable");
  }
  await withCatalogMutation(async (catalog, authority) => {
    const result = await catalog.upsertEventTeamRoster(
      seeded.currentId,
      eventTeamId,
      { playerNumber: 7, publicName },
      authority,
    );
    if (result.status !== "accepted") {
      throw new Error(`browser roster correction was rejected: ${JSON.stringify(result)}`);
    }
  });
}

async function withdrawPublishedEvent(eventId: string) {
  await withCatalogMutation(async (catalog, authority) => {
    const result = await catalog.changePublicationStatus(
      eventId,
      { status: "unpublished", impactConfirmed: true },
      authority,
    );
    if (result.status !== "accepted") throw new Error("browser Event withdrawal was rejected");
  });
}

async function withCatalogMutation(
  operation: (
    catalog: ReturnType<typeof createEventCatalog>,
    authority: TechnicalAdminAuthority,
  ) => Promise<void>,
) {
  const foundation = openSqliteFoundationStorage(foundationDatabase, {
    grantKeyRing: readGrantAuthorityOptions("test", environment).keyRing,
  });
  await foundation.applyMigrations({ requireCandidate: false });
  foundation.setReadinessContext({
    actionCodecRegistry: createControlActionCodecRegistry(),
    interpreter: createLiveEventGameIqaInterpreter(),
  });
  const catalog = createEventCatalog(createFoundationEventCatalogStorage(foundation), {});
  const hostAuth = createTechnicalAdminAuth(
    { environment: "test", origin: "https://timer.example", rpId: "timer.example" },
    new MemoryTechnicalAdminAuthRepository(),
  );
  const authority = hostAuth.resolveHostLocalAuthority();
  try {
    await operation(catalog, authority);
  } finally {
    hostAuth.close();
    foundation.close();
  }
}

async function acceptGameRecordActionOnStorage(
  storage: ReturnType<typeof openSqliteFoundationStorage>,
  entry: { game: EventGame },
  resolver: ExternalScopeResolver,
  context: string,
  createAction: (root: EventGameRecordRoot) => ControlActionInput,
) {
  const root = await storage.transaction((transaction) =>
    transaction.findRootByEventGameId(entry.game.eventGameId),
  );
  if (root === null) throw new Error(`${context} Event Game root is unavailable`);
  const record = createEventGameRecord(storage, {
    externalScopeResolver: resolver,
    interpreter: createLiveEventGameIqaInterpreter(),
    clock: () => Date.now(),
  });
  const registered = await record.registerRoot(root);
  if (registered.status !== "registered" && registered.status !== "idempotent") {
    throw new Error(`${context} Event Game registration failed: ${registered.status}`);
  }
  const accepted = await record.acceptAction(createAction(root));
  if (accepted.status !== "accepted" && accepted.status !== "duplicate-accepted") {
    throw new Error(`${context} action was not accepted: ${accepted.status}`);
  }
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

function createEventGameSeedScopeResolver(): ExternalScopeResolver {
  return {
    resolve(scope) {
      return { status: "resolved", scope: structuredClone(scope) };
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
  sideAEventTeamId: string,
  sideBEventTeamId: string,
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
        eventTeamId: sideAEventTeamId,
        teamInterpretationRef: "seed-team-a-v1",
      },
      {
        id: `seed-side-${eventGameId}-b`,
        eventTeamId: sideBEventTeamId,
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

function createSeedCorrectionAction(
  root: EventGameRecordRoot,
  operationId: string,
  targetFactId: string,
  effective: boolean,
): ControlActionInput {
  const trustedAtMs = Date.now();
  return {
    recordId: root.recordId,
    eventGameId: root.eventGameId,
    operationId,
    kind: { id: "correction", version: "1" },
    payload: { correctionId: operationId, targetFactId, effective },
    causalPredecessorIds: [targetFactId],
    occurrence: { trustedAtMs, clientOriginAtMs: trustedAtMs, source: "online" },
    grant: { sessionId: "public-browser-seed", versionId: "public-browser-seed-v1" },
    lifecycle: structuredClone(root.lifecycle),
  };
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

function requireWebSocketRoute(
  route: DisconnectableWebSocketRoute | null,
): DisconnectableWebSocketRoute {
  if (route === null) throw new Error("public spectator Game did not open its WebSocket");
  return route;
}
