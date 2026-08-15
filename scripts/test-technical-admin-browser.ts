#!/usr/bin/env bun
import { chromium, type Page } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const directory = mkdtempSync(join(tmpdir(), "quadball-timer-admin-browser-"));
const certificatePath = join(directory, "localhost.crt");
const keyPath = join(directory, "localhost.key");
const databasePath = join(directory, "technical-admin.sqlite");
const port = 38_000 + Math.floor(Math.random() * 1_000);
const origin = `https://localhost:${port}`;
const environment = {
  ...process.env,
  NODE_ENV: "test",
  QUADBALL_ENVIRONMENT: "test",
  PUBLIC_ORIGIN: origin,
  WEBAUTHN_RP_ID: "localhost",
  TECHNICAL_ADMIN_DATABASE: databasePath,
  TLS_CERT_FILE: certificatePath,
  TLS_KEY_FILE: keyPath,
  PORT: String(port),
};

let server: Bun.Subprocess | null = null;
let serverStderr: Promise<string> | null = null;
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let browserPage: Page | null = null;

try {
  const certificate = Bun.spawnSync([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost",
    "-days",
    "1",
    "-keyout",
    keyPath,
    "-out",
    certificatePath,
  ]);
  if (certificate.exitCode !== 0)
    throw new Error("openssl could not create a temporary certificate.");

  server = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: process.cwd(),
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  serverStderr = new Response(server.stderr as unknown as BodyInit).text();
  await waitForServer(`${origin}/internal/healthz`);

  const enrollmentProcess = Bun.spawn(["bun", "scripts/enroll-technical-admin.ts"], {
    cwd: process.cwd(),
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (typeof enrollmentProcess.stdout === "number" || enrollmentProcess.stdout === undefined) {
    throw new Error("Enrollment command did not expose stdout.");
  }
  const enrollmentOutput = await new Response(
    enrollmentProcess.stdout as unknown as BodyInit,
  ).text();
  const enrollmentExitCode = await enrollmentProcess.exited;
  if (enrollmentExitCode !== 0) throw new Error("Host-local enrollment command failed.");
  const enrollmentUrl = enrollmentOutput
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.startsWith(`${origin}/admin/enroll#token=`));
  if (!enrollmentUrl) throw new Error("Enrollment command did not return an HTTPS fragment URL.");
  const enrollmentToken = new URL(enrollmentUrl).hash.slice("#token=".length);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  browserPage = page;
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await page.goto(enrollmentUrl);
  await page.getByRole("button", { name: "Register passkey" }).waitFor();
  assert(
    page.url() === `${origin}/admin/enroll`,
    "enrollment fragment was scrubbed before registration",
  );
  await page.getByRole("button", { name: "Register passkey" }).click();
  await page.waitForURL(`${origin}/admin`);
  await page.getByRole("button", { name: "Sign in with passkey" }).waitFor();
  assert(
    (await page.evaluate(() => window.location.hash)) === "",
    "enrollment fragment was scrubbed",
  );

  const replayStatus = await page.evaluate(async (token) => {
    const response = await fetch("/api/admin/enrollment/options", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    return response.status;
  }, enrollmentToken);
  assert(replayStatus === 401 || replayStatus === 409, "enrollment replay was rejected");

  await page.getByRole("button", { name: "Sign in with passkey" }).click();
  await page.getByText("Technical Admin administration").waitFor();
  const csrfFailureStatus = await page.evaluate(async () => {
    const response = await fetch("/api/admin/logout", { method: "POST" });
    return response.status;
  });
  assert(csrfFailureStatus === 401, "logout without the custom CSRF header was accepted");
  const cookies = await context.cookies();
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  const csrfToken = cookies.find((cookie) => cookie.name === "__Host-technical-admin-csrf")?.value;
  if (!csrfToken) throw new Error("Technical Admin CSRF cookie was not issued.");
  const recoveryOptions = {
    method: "POST" as const,
    data: { purpose: "revoke-other-sessions" },
    headers: {
      cookie: cookieHeader,
      "x-technical-admin-csrf": csrfToken,
    },
  };
  const wrongOriginResponse = await context.request.post(`${origin}/api/admin/step-up/options`, {
    ...recoveryOptions,
    headers: { ...recoveryOptions.headers, origin: "https://evil.example" },
  });
  assert(wrongOriginResponse.status() === 401, "wrong-Origin recovery mutation was accepted");
  const wrongContentTypeResponse = await context.request.post(
    `${origin}/api/admin/step-up/options`,
    {
      ...recoveryOptions,
      headers: { ...recoveryOptions.headers, "content-type": "text/plain" },
    },
  );
  assert(
    wrongContentTypeResponse.status() === 401,
    "wrong-content-type recovery mutation was accepted",
  );
  const missingCsrfResponse = await context.request.post(`${origin}/api/admin/step-up/options`, {
    data: { purpose: "revoke-other-sessions" },
    headers: { cookie: cookieHeader, "content-type": "application/json" },
  });
  assert(missingCsrfResponse.status() === 401, "missing-CSRF recovery mutation was accepted");
  await page.getByRole("button", { name: "Log out other sessions" }).click();
  await page.getByText("Active browser sessions: 1").waitFor();
  await page.getByRole("button", { name: "Replace passkey" }).click();
  await page.getByText("Active browser sessions: 1").waitFor();
  await page.getByLabel("Event name").fill("Browser Event");
  await page.getByLabel("Event timezone").fill("Europe/Zurich");
  await page.getByRole("button", { name: "Create Event" }).click();
  await page.getByText("Browser Event").waitFor();
  await page.getByRole("button", { name: /Browser Event/ }).click();
  await page.getByLabel("Add Game Day").fill("2026-08-14");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const gameDayDate = page.locator('input[id^="game-day-date-"]');
  await expectValue(gameDayDate, "2026-08-14");
  await page.getByLabel("Add Game Day").fill("2026-08-15");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.locator('input[id^="game-day-date-"]').nth(1).waitFor();
  assert(
    (await page.locator('input[id^="game-day-date-"]').count()) === 2,
    "browser flow did not create two Game Days",
  );
  await expectValue(page.locator('input[id^="game-day-date-"]').nth(0), "2026-08-14");
  await expectValue(page.locator('input[id^="game-day-date-"]').nth(1), "2026-08-15");
  await page.locator("#selected-event-name").fill("Browser Event Updated");
  await page.getByRole("button", { name: "Save Event" }).click();
  await page.getByRole("heading", { name: "Browser Event Updated" }).waitFor();
  const eventsPayload = (await (
    await context.request.get(`${origin}/api/admin/events`)
  ).json()) as {
    status: string;
    value: Array<{ eventId: string; name: string }>;
  };
  const eventId = eventsPayload.value.find(
    (event) => event.name === "Browser Event Updated",
  )?.eventId;
  if (!eventId) throw new Error("Browser Event was not returned by the catalog.");
  await page.getByRole("button", { name: /Browser Event Updated/ }).click();
  await page.getByRole("button", { name: "Create Grant" }).click();
  const revealResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/admin/events/${eventId}/event-admin-grant/reveal`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Reveal QR credential" }).click();
  const revealResponse = await revealResponsePromise;
  const revealPayload = (await revealResponse.json()) as {
    status: string;
    value?: { qrCredential?: string };
  };
  const revealedCredential = revealPayload.value?.qrCredential ?? "";
  assert(revealResponse.status() === 200 && revealedCredential.length > 0, "QR reveal succeeded");
  const qrCode = page.getByAltText("Event Admin Grant QR code");
  await qrCode.waitFor();
  const qrSource = await qrCode.getAttribute("src");
  assert(
    qrSource?.startsWith("data:image/png;base64,") === true,
    "browser reveal rendered a PNG QR code",
  );
  await page.getByRole("button", { name: "Open Event Hub" }).click();
  await page.getByText("Event Hub", { exact: true }).waitFor();
  await page.getByLabel("Game Day").selectOption({ index: 1 });
  const eventAdminContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const eventAdminPage = await eventAdminContext.newPage();
  eventAdminPage.setDefaultTimeout(5_000);
  await eventAdminPage.goto(`${origin}/event-admin?eventId=${eventId}`);
  await eventAdminPage.getByLabel("Scanned Event Admin QR value").fill(revealedCredential);
  await eventAdminPage.getByRole("button", { name: "Admit Event Admin" }).click();
  await eventAdminPage.getByText(/event-admin/u).waitFor();
  const eventAdminGameDaySelector = eventAdminPage.getByLabel("Game Day");
  await eventAdminGameDaySelector.selectOption({ index: 1 });
  const firstSelectedGameDay = await expectSelectValue(eventAdminGameDaySelector, 1);
  await eventAdminGameDaySelector.selectOption({ index: 2 });
  const secondSelectedGameDay = await expectSelectValue(eventAdminGameDaySelector, 2);
  assert(firstSelectedGameDay !== secondSelectedGameDay, "Game Day selector reused one option");
  await eventAdminPage.getByLabel("New Event Team name").fill("Blue");
  await eventAdminPage.getByRole("button", { name: "Add Team" }).click();
  await eventAdminPage.getByText("Blue", { exact: true }).first().waitFor();
  await eventAdminPage.getByLabel("Event Team Blue name").fill("Blue Updated");
  await eventAdminPage.getByLabel("Event Team Blue color").fill("#123456");
  await eventAdminPage.getByRole("button", { name: "Save Event Team" }).click();
  await eventAdminPage.getByText("Blue Updated", { exact: true }).first().waitFor();
  await expectValue(eventAdminPage.getByLabel("Event Team Blue Updated color"), "#123456");
  await eventAdminPage.getByLabel("Roster Event Team").selectOption({ label: "Blue Updated" });
  await eventAdminPage.getByLabel("Player number").fill("7");
  await eventAdminPage.getByLabel("Player public name").fill("Player Seven");
  await eventAdminPage.getByRole("button", { name: "Save Roster" }).click();
  await eventAdminPage.getByText("#7 Player Seven", { exact: true }).waitFor();
  await eventAdminPage.getByLabel("New Pitch name").fill("Pitch One");
  const createPitchResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().includes(`/api/event-admin/events/${eventId}/pitches`) &&
      response.request().method() === "POST",
  );
  await eventAdminPage.getByRole("button", { name: "Add Pitch" }).click();
  assert((await createPitchResponsePromise).status() === 201, "Pitch creation failed");
  await eventAdminPage.getByLabel("Pitch Pitch One name").waitFor();
  await eventAdminPage.getByLabel("Pitch Pitch One name").fill("Pitch Main");
  await eventAdminPage.getByRole("button", { name: "Save Pitch" }).click();
  await eventAdminPage.getByLabel("Pitch Pitch Main name").waitFor();
  await eventAdminPage.getByLabel("New Event Team name").fill("Red");
  await eventAdminPage.getByRole("button", { name: "Add Team" }).click();
  await eventAdminPage.getByText("Red", { exact: true }).first().waitFor();
  await eventAdminPage.getByLabel("Gameplay Slot sequence").fill("1");
  await eventAdminPage.getByLabel("Gameplay Slot scheduled start").fill("2026-08-15T10:00");
  const createGameplaySlotResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().includes(`/api/event-admin/events/${eventId}/game-days/`) &&
      response.url().endsWith("/gameplay-slots") &&
      response.request().method() === "POST",
  );
  await eventAdminPage.getByRole("button", { name: "Add Gameplay Slot" }).click();
  assert(
    (await createGameplaySlotResponsePromise).status() === 201,
    "Gameplay Slot creation failed",
  );
  await eventAdminPage.getByLabel("Gameplay Slot for Event Game").selectOption({ index: 1 });
  await eventAdminPage.getByLabel("Pitch Slot for Event Game").selectOption({ index: 1 });
  await eventAdminPage.getByLabel("Game Code").fill("G-01");
  await eventAdminPage.getByLabel("Game Designation").fill("Opening");
  await eventAdminPage.getByLabel("Side A source label").fill("Winner A");
  await eventAdminPage.getByLabel("Side B source label").fill("Winner B");
  const createEventGameResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().includes(`/api/event-admin/events/${eventId}/game-days/`) &&
      response.url().endsWith("/event-games") &&
      response.request().method() === "POST",
  );
  await eventAdminPage.getByRole("button", { name: "Add unresolved Event Game" }).click();
  assert((await createEventGameResponsePromise).status() === 201, "Event Game creation failed");
  await eventAdminPage
    .locator('select[aria-label$="Side A"]')
    .selectOption({ label: "Blue Updated" });
  await eventAdminPage.locator('select[aria-label$="Side B"]').selectOption({ label: "Red" });
  const confirmGameplaySlotResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().includes(`/api/event-admin/events/${eventId}/game-days/`) &&
      response.url().endsWith("/confirm-teams") &&
      response.request().method() === "POST",
  );
  await eventAdminPage.getByRole("button", { name: "Confirm teams for Slot" }).click();
  assert(
    (await confirmGameplaySlotResponsePromise).status() === 200,
    "Gameplay Slot confirmation failed",
  );
  await eventAdminPage.getByRole("button", { name: "Refresh Slot setup" }).click();
  await eventAdminPage.getByText("Opening", { exact: true }).waitFor();
  await eventAdminPage
    .getByText(/Slot 1.*10:00/u)
    .last()
    .waitFor();
  await eventAdminPage.getByRole("button", { name: "Pitch Main" }).click();
  await eventAdminPage
    .getByText(/Slot 1/)
    .last()
    .waitFor();
  const sessionCookieBeforeRefresh = (await eventAdminContext.cookies()).find(
    (cookie) => cookie.name === "__Host-event-admin-session",
  );
  const projectionResponse = await eventAdminContext.request.get(
    `${origin}/api/event-admin/hub?eventId=${eventId}`,
  );
  assert(
    projectionResponse.status() === 200 && projectionResponse.headers()["set-cookie"] === undefined,
    "Event Admin projection emitted a session refresh header",
  );
  await eventAdminPage.reload();
  await eventAdminPage.getByText(/event-admin/u).waitFor();
  const sessionCookieAfterRefresh = (await eventAdminContext.cookies()).find(
    (cookie) => cookie.name === "__Host-event-admin-session",
  );
  assert(
    sessionCookieBeforeRefresh !== undefined &&
      sessionCookieAfterRefresh !== undefined &&
      sessionCookieAfterRefresh.expires === sessionCookieBeforeRefresh.expires &&
      sessionCookieAfterRefresh.value === sessionCookieBeforeRefresh.value,
    "Event Admin projection changed the rolling session cookie",
  );
  const wrongEventResponse = await fetchFromPage(
    eventAdminPage,
    `${origin}/api/event-admin/hub?eventId=wrong-event`,
  );
  assert(wrongEventResponse.status === 401, "wrong-Event Event Admin authority was accepted");
  await page.goto(`${origin}/admin`);
  await page.getByRole("button", { name: /Browser Event Updated/ }).click();
  const rotateResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/admin/events/${eventId}/event-admin-grant/rotate`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Rotate Grant" }).click();
  assert((await rotateResponsePromise).status() === 200, "Grant rotation failed");
  const staleAfterRotation = await fetchFromPage(
    eventAdminPage,
    `${origin}/api/event-admin/hub?eventId=${eventId}`,
  );
  assert(staleAfterRotation.status === 401, "rotated Event Admin session remained live");
  const freshRevealResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/admin/events/${eventId}/event-admin-grant/reveal`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Reveal QR credential" }).click();
  const freshRevealResponse = await freshRevealResponsePromise;
  const freshRevealPayload = (await freshRevealResponse.json()) as {
    status: string;
    value?: { qrCredential?: string };
  };
  const freshCredential = freshRevealPayload.value?.qrCredential ?? "";
  assert(
    freshRevealResponse.status() === 200 && freshCredential.length > 0,
    "fresh QR reveal failed",
  );
  const revokedEventAdminContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const revokedEventAdminPage = await revokedEventAdminContext.newPage();
  revokedEventAdminPage.setDefaultTimeout(5_000);
  await revokedEventAdminPage.goto(`${origin}/event-admin?eventId=${eventId}`);
  await revokedEventAdminPage.getByLabel("Scanned Event Admin QR value").fill(freshCredential);
  await revokedEventAdminPage.getByRole("button", { name: "Admit Event Admin" }).click();
  await revokedEventAdminPage.getByText(/event-admin/u).waitFor();
  const validFreshSession = await fetchFromPage(
    revokedEventAdminPage,
    `${origin}/api/event-admin/hub?eventId=${eventId}`,
  );
  assert(validFreshSession.status === 200, "newly admitted Event Admin session was not live");
  assert(validFreshSession.cacheControl === "no-store", "private Event Hub response was cacheable");
  const revokeResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/admin/events/${eventId}/event-admin-grant/revoke`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Revoke Grant" }).click();
  assert((await revokeResponsePromise).status() === 200, "Grant revocation failed");
  const revokedFreshSession = await fetchFromPage(
    revokedEventAdminPage,
    `${origin}/api/event-admin/hub?eventId=${eventId}`,
  );
  assert(
    revokedFreshSession.status === 401,
    "explicitly revoked live Event Admin session remained live",
  );
  await eventAdminContext.close();
  await revokedEventAdminContext.close();
  const removeButtons = page.getByRole("button", { name: "Remove", exact: true });
  await removeButtons.nth(0).click();
  const attachedGrantRemoval = await page.evaluate(async (url) => {
    const csrf = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("__Host-technical-admin-csrf="))
      ?.slice("__Host-technical-admin-csrf=".length);
    return (
      await fetch(url, {
        method: "DELETE",
        headers: { "x-technical-admin-csrf": csrf ?? "" },
      })
    ).status;
  }, `${origin}/api/admin/events/${eventId}`);
  assert(
    attachedGrantRemoval === 409,
    `attached Event Admin Grant removal returned ${attachedGrantRemoval}`,
  );
  const staleCookies = await context.cookies();
  const staleCookieHeader = staleCookies
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  const staleCsrf = staleCookies.find(
    (cookie) => cookie.name === "__Host-technical-admin-csrf",
  )?.value;
  if (!staleCsrf) throw new Error("Technical Admin CSRF cookie was not retained.");
  await page.getByRole("button", { name: "Sign out" }).click();
  const forgedResponse = await context.request.post(`${origin}/api/admin/events`, {
    data: { name: "Forged", timeZone: "UTC" },
    headers: {
      cookie: "__Host-technical-admin=forged-json-token",
      "content-type": "application/json",
      "x-technical-admin-csrf": "1",
    },
  });
  assert(forgedResponse.status() === 401, "forged/raw authority was accepted");
  const revokedResponse = await context.request.post(`${origin}/api/admin/events`, {
    data: { name: "Revoked", timeZone: "UTC" },
    headers: {
      cookie: staleCookieHeader,
      "content-type": "application/json",
      "x-technical-admin-csrf": staleCsrf,
    },
  });
  assert(revokedResponse.status() === 401, "revoked authority was cached or accepted");
  console.log(
    JSON.stringify({
      status: "passed",
      enrollment: true,
      authentication: true,
      replayRejected: true,
      csrfRejected: true,
      recoveryBindingRejected: true,
      recoveryContentTypeRejected: true,
      recoveryCsrfRejected: true,
      sessionRevocation: true,
      replacement: true,
      eventCatalog: true,
      eventAdminGrantHandoff: true,
      qrRender: true,
      eventHubDelegation: true,
      eventAdminRotationRevocationIsolation: true,
      forgedAuthorityRejected: true,
      revocationRevalidated: true,
    }),
  );
} catch (error) {
  console.error(
    redactDiagnosticText(
      error instanceof Error
        ? (error.stack ?? error.message)
        : JSON.stringify(error) || "Technical Admin browser test failed.",
    ),
  );
  if (browserPage) {
    console.error(`browser_url=${redactBrowserUrl(browserPage.url())}`);
    console.error(
      `browser_text=${redactDiagnosticText(
        (await browserPage.locator("body").innerText()).slice(0, 1_000),
      )}`,
    );
  }
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) {
    server.kill();
    await server.exited;
    const diagnostics = serverStderr ? await serverStderr : "";
    if (diagnostics.trim().length > 0) console.error(redactDiagnosticText(diagnostics.trim()));
  }
  rmSync(directory, { recursive: true, force: true });
}

async function waitForServer(url: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = Bun.spawnSync(["curl", "-k", "-sSf", "-H", `host: localhost:${port}`, url]);
    if (response.exitCode === 0) return;
    await Bun.sleep(100);
  }
  throw new Error("Technical Admin browser server did not become ready.");
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectValue(locator: ReturnType<Page["locator"]>, expected: string) {
  const actual = await locator.inputValue();
  assert(actual === expected, `Expected input value ${expected}, got ${actual}.`);
}

async function expectSelectValue(locator: ReturnType<Page["getByLabel"]>, index: number) {
  const value = await locator.inputValue();
  assert(value.length > 0, `Game Day selector option ${index} was not selected.`);
  return value;
}

async function fetchFromPage(page: Page, url: string) {
  return page.evaluate(async (requestUrl) => {
    const response = await fetch(requestUrl);
    return { status: response.status, cacheControl: response.headers.get("cache-control") };
  }, url);
}

function redactBrowserUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value.replace(/#.*$/u, "");
  }
}

function redactDiagnosticText(value: string) {
  return value.replace(/(https?:\/\/[^\s"'<>#]+)#\S+/giu, "$1");
}
