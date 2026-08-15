#!/usr/bin/env bun
import { chromium, type Page } from "playwright";
import { expect } from "playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import { readGrantAuthorityOptions } from "@/lib/grant-runtime";

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
  FOUNDATION_DATABASE: join(directory, "foundation.sqlite"),
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

  const grantOptions = readGrantAuthorityOptions("test", environment);
  const foundation = openSqliteFoundationStorage(join(directory, "foundation.sqlite"), {
    grantKeyRing: grantOptions.keyRing,
  });
  await foundation.applyMigrations();
  foundation.close();

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
  const currentCsrfToken = (await context.cookies()).find(
    (cookie) => cookie.name === "__Host-technical-admin-csrf",
  )?.value;
  if (!currentCsrfToken) throw new Error("Technical Admin CSRF cookie was not retained.");

  assert(
    (await page.getByRole("button", { name: "Remove", exact: true }).count()) === 0 &&
      (await page.getByRole("button", { name: "Remove empty Event", exact: true }).count()) === 1,
    "Technical Admin exposed child-structure removal UI",
  );
  const eventProjectionResponse = await context.request.get(
    `${origin}/api/admin/events/${eventId}`,
  );
  const eventProjectionPayload = (await eventProjectionResponse.json()) as {
    value?: { gameDays?: Array<{ gameDayId: string }> };
  };
  const technicalGameDayId = eventProjectionPayload.value?.gameDays?.[0]?.gameDayId;
  if (!technicalGameDayId) throw new Error("Technical browser Event has no Game Day.");
  const technicalChildPreview = await context.request.post(
    `${origin}/api/admin/events/${eventId}/catalog-removal/preview`,
    { data: { kind: "game-day", targetId: technicalGameDayId } },
  );
  assert(
    technicalChildPreview.status() === 401,
    "Technical Admin child-removal preview was not unauthorized",
  );
  const technicalChildRemoval = await context.request.delete(
    `${origin}/api/admin/events/${eventId}/catalog-removal`,
    {
      data: {
        kind: "game-day",
        targetId: technicalGameDayId,
        previewFingerprint: "event-catalog-removal-v1:" + "0".repeat(64),
      },
      headers: { "x-technical-admin-csrf": currentCsrfToken ?? "" },
    },
  );
  assert(
    technicalChildRemoval.status() === 401,
    "Technical Admin child-removal acceptance was not unauthorized",
  );

  const removalDayResponse = await context.request.post(
    `${origin}/api/admin/events/${eventId}/game-days`,
    {
      data: { date: "2026-08-16" },
      headers: { origin, "x-technical-admin-csrf": currentCsrfToken },
    },
  );
  const removalDayPayload = (await removalDayResponse.json()) as {
    status: string;
    value?: { gameDayId?: string };
  };
  const removalGameDayId = removalDayPayload.value?.gameDayId;
  assert(
    removalDayResponse.status() === 201 && removalGameDayId !== undefined,
    "removal browser Game Day creation failed",
  );

  const zeroDayResponse = await context.request.post(`${origin}/api/admin/events`, {
    data: { name: "Zero Day Browser Event", timeZone: "UTC" },
    headers: { origin, "x-technical-admin-csrf": currentCsrfToken },
  });
  const zeroDayPayload = (await zeroDayResponse.json()) as {
    status: string;
    value?: { eventId?: string };
  };
  const zeroDayEventId = zeroDayPayload.value?.eventId;
  assert(
    zeroDayResponse.status() === 201 && zeroDayEventId !== undefined,
    "zero-Day browser Event creation failed",
  );
  await page.goto(`${origin}/event-admin?eventId=${zeroDayEventId}`);
  await page.getByText("Event Hub", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Published Event", exact: true }).click();
  await page.getByText("Publishing requires at least one Game Day.", { exact: true }).waitFor();
  await page.goto(`${origin}/admin`);
  await page.getByText("Technical Admin administration").waitFor();
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
  await page.getByLabel("Game Day", { exact: true }).selectOption({ index: 1 });
  const eventAdminContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const eventAdminPage = await eventAdminContext.newPage();
  eventAdminPage.setDefaultTimeout(5_000);
  await eventAdminPage.goto(`${origin}/event-admin?eventId=${eventId}`);
  await eventAdminPage.getByLabel("Scanned Event Admin QR value").fill(revealedCredential);
  await eventAdminPage.getByRole("button", { name: "Admit Event Admin" }).click();
  await eventAdminPage.getByText(/event-admin/u).waitFor();
  const eventAdminGameDaySelector = eventAdminPage.getByLabel("Game Day", { exact: true });
  const firstDayHubResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().includes("/api/event-admin/hub?") && response.request().method() === "GET",
  );
  await eventAdminGameDaySelector.selectOption({ index: 1 });
  await firstDayHubResponsePromise;
  const firstSelectedGameDay = await expectSelectValue(eventAdminGameDaySelector, 1);
  const secondDayHubResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().includes("/api/event-admin/hub?") && response.request().method() === "GET",
  );
  await eventAdminGameDaySelector.selectOption({ index: 2 });
  await secondDayHubResponsePromise;
  const secondSelectedGameDay = await expectSelectValue(eventAdminGameDaySelector, 2);
  assert(firstSelectedGameDay !== secondSelectedGameDay, "Game Day selector reused one option");
  const removalPreviewResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().endsWith("/catalog-removal/preview") && response.request().method() === "POST",
  );
  const removalDayHubResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().includes("/api/event-admin/hub?") && response.request().method() === "GET",
  );
  await eventAdminGameDaySelector.selectOption({ index: 3 });
  await removalDayHubResponsePromise;
  await eventAdminPage.getByLabel("Preview removal Game Day 2026-08-16").click();
  const removalPreviewResponse = await removalPreviewResponsePromise;
  const removalPreviewPayload = (await removalPreviewResponse.json()) as {
    status: string;
    value?: {
      eligible: boolean;
      fingerprint?: string;
      impact?: {
        descendantCount: number;
        retainedEventGameCount: number;
        retainedControlActionCount: number;
        retiredAuthorityCount: number;
        retiredAuthorityCategories: {
          eventAdmin: number;
          pitchManager: number;
          control: number;
        };
      };
    };
  };
  assert(
    removalPreviewResponse.status() === 200 &&
      removalPreviewPayload.status === "accepted" &&
      removalPreviewPayload.value?.eligible === true &&
      removalPreviewPayload.value.fingerprint?.startsWith("event-catalog-removal-v1:") === true,
    "Event Admin Game Day removal preview failed",
  );
  const removalStatusText = await eventAdminPage.getByRole("status").innerText();
  assert(
    removalStatusText.includes("catalog descendants 0") &&
      removalStatusText.includes("retained Event Game Records 0") &&
      removalStatusText.includes("accepted Control Actions 0") &&
      removalStatusText.includes("retiring 0 authority item") &&
      removalStatusText.includes("Authority categories") &&
      !/grantId|session|credential|secret|code/iu.test(removalStatusText),
    "removal preview did not show only bounded safe impact",
  );
  const eventAdminCookieBeforeRemoval = (await eventAdminContext.cookies()).find(
    (cookie) => cookie.name === "__Host-event-admin-session",
  );
  const missingFingerprintResponse = await eventAdminContext.request.delete(
    `${origin}/api/event-admin/events/${eventId}/catalog-removal`,
    { data: { kind: "game-day", targetId: removalGameDayId } },
  );
  assert(
    missingFingerprintResponse.status() === 400 &&
      missingFingerprintResponse.headers()["set-cookie"] === undefined,
    "missing removal fingerprint was accepted or refreshed the Event Admin session",
  );
  const eventAdminCookieAfterRejectedRemoval = (await eventAdminContext.cookies()).find(
    (cookie) => cookie.name === "__Host-event-admin-session",
  );
  assert(
    eventAdminCookieBeforeRemoval?.value === eventAdminCookieAfterRejectedRemoval?.value &&
      eventAdminCookieBeforeRemoval?.expires === eventAdminCookieAfterRejectedRemoval?.expires,
    "rejected removal changed the Event Admin session",
  );
  const removalAcceptedResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().endsWith("/catalog-removal") && response.request().method() === "DELETE",
  );
  const repairedGameDayHubResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().includes("/api/event-admin/hub?") &&
      response.url().includes("gameDayId=") &&
      response.request().method() === "GET",
  );
  await eventAdminPage.getByRole("button", { name: "Confirm", exact: true }).click();
  const removalAcceptedResponse = await removalAcceptedResponsePromise;
  await repairedGameDayHubResponsePromise;
  const removalAcceptedPayload = (await removalAcceptedResponse.json()) as {
    status: string;
    sessionExpiresAtMs?: number;
  };
  assert(
    removalAcceptedResponse.status() === 200 &&
      removalAcceptedPayload.status === "accepted" &&
      typeof removalAcceptedPayload.sessionExpiresAtMs === "number",
    "Event Admin Game Day removal was not accepted with session activity",
  );
  const refreshedEventAdminCookie = (await eventAdminContext.cookies()).find(
    (cookie) => cookie.name === "__Host-event-admin-session",
  );
  assert(
    refreshedEventAdminCookie !== undefined &&
      refreshedEventAdminCookie.expires > 0 &&
      Math.abs(
        refreshedEventAdminCookie.expires * 1_000 -
          (removalAcceptedPayload.sessionExpiresAtMs ?? 0),
      ) < 2_000,
    "Event Admin removal cookie expiry did not match the returned capped expiry",
  );
  await eventAdminPage.getByText("Event Hub", { exact: true }).waitFor();
  const repairedGameDayValue = await eventAdminGameDaySelector.inputValue();
  const repairedGameDayOptions = await eventAdminGameDaySelector
    .locator("option")
    .allTextContents();
  assert(
    repairedGameDayValue.length > 0 &&
      repairedGameDayValue !== removalGameDayId &&
      repairedGameDayOptions.includes("2026-08-14 · past"),
    `selected Game Day was not repaired to a surviving scope (value=${repairedGameDayValue}, options=${repairedGameDayOptions.join("|")})`,
  );
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
  await eventAdminPage.getByLabel("New Pitch name").fill("Pitch Temporary");
  const temporaryPitchResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().includes(`/api/event-admin/events/${eventId}/pitches`) &&
      response.request().method() === "POST",
  );
  await eventAdminPage.getByRole("button", { name: "Add Pitch" }).click();
  assert(
    (await temporaryPitchResponsePromise).status() === 201,
    "temporary removal Pitch creation failed",
  );
  await eventAdminPage.getByLabel("Pitch Pitch Temporary name").waitFor();
  const removalHubPayload = (await (
    await eventAdminContext.request.get(`${origin}/api/event-admin/hub?eventId=${eventId}`)
  ).json()) as {
    status: string;
    value?: { event?: { pitches?: Array<{ pitchId: string; name: string }> } };
  };
  const removalPitchId = removalHubPayload.value?.event?.pitches?.find(
    (pitch) => pitch.name === "Pitch Temporary",
  )?.pitchId;
  assert(removalPitchId !== undefined, "temporary removal Pitch was not projected");
  const temporaryPitchViewResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().includes("/api/event-admin/pitch-view?") &&
      response.request().method() === "GET",
  );
  await eventAdminPage.getByRole("button", { name: "Pitch Temporary", exact: true }).click();
  await temporaryPitchViewResponsePromise;
  await eventAdminPage.getByLabel("Preview removal Pitch Pitch Temporary").click();
  await eventAdminPage.getByRole("status").filter({ hasText: "catalog descendants 0" }).waitFor();
  const pitchRemovalResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().endsWith("/catalog-removal") && response.request().method() === "DELETE",
  );
  const survivingPitchViewResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().includes("/api/event-admin/pitch-view?") &&
      response.request().method() === "GET",
  );
  await eventAdminPage.getByRole("button", { name: "Confirm", exact: true }).click();
  const pitchRemovalResponse = await pitchRemovalResponsePromise;
  const pitchRemovalPayload = (await pitchRemovalResponse.json()) as {
    status: string;
    sessionExpiresAtMs?: number;
  };
  assert(
    pitchRemovalResponse.status() === 200 &&
      pitchRemovalPayload.status === "accepted" &&
      typeof pitchRemovalPayload.sessionExpiresAtMs === "number",
    "Event Admin Pitch removal was not accepted with session activity",
  );
  const refreshedPitchEventAdminCookie = (await eventAdminContext.cookies()).find(
    (cookie) => cookie.name === "__Host-event-admin-session",
  );
  assert(
    refreshedPitchEventAdminCookie !== undefined &&
      refreshedPitchEventAdminCookie.expires > 0 &&
      Math.abs(
        refreshedPitchEventAdminCookie.expires * 1_000 -
          (pitchRemovalPayload.sessionExpiresAtMs ?? 0),
      ) < 2_000,
    "Pitch removal did not refresh the Event Admin session cookie",
  );
  const survivingPitchViewResponse = await survivingPitchViewResponsePromise;
  assert(
    !survivingPitchViewResponse.url().includes(removalPitchId),
    "Pitch removal refetched the deleted Pitch view",
  );
  await eventAdminPage.getByRole("button", { name: "Pitch Main", exact: true }).waitFor();
  assert(
    (await eventAdminPage.getByRole("button", { name: "Pitch Temporary", exact: true }).count()) ===
      0,
    "removed Pitch remained selected or visible",
  );
  const firstDayScheduleHubResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().includes("/api/event-admin/hub?") && response.request().method() === "GET",
  );
  await eventAdminGameDaySelector.selectOption({ index: 1 });
  await firstDayScheduleHubResponsePromise;
  await eventAdminPage.getByLabel("Gameplay Slot sequence").fill("1");
  await eventAdminPage.getByLabel("Gameplay Slot scheduled start").fill("2026-08-14T10:00");
  const firstDaySlotResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().includes(`/api/event-admin/events/${eventId}/game-days/`) &&
      response.url().endsWith("/gameplay-slots") &&
      response.request().method() === "POST",
  );
  await eventAdminPage.getByRole("button", { name: "Add Gameplay Slot" }).click();
  assert(
    (await firstDaySlotResponsePromise).status() === 201,
    "first Game Day slot creation failed",
  );
  await eventAdminPage
    .getByText(/Slot 1.*10:00/u)
    .last()
    .waitFor();
  await eventAdminPage.getByLabel("Gameplay Slot 1 Expected Delay minutes").fill("2");
  const firstDayPreviewResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().endsWith("/expected-delay/preview") && response.request().method() === "POST",
  );
  await eventAdminPage.getByRole("button", { name: "Preview Delay" }).click();
  const firstDayPreviewResponse = await firstDayPreviewResponsePromise;
  assert(
    firstDayPreviewResponse.status() === 200 &&
      firstDayPreviewResponse.headers()["set-cookie"] === undefined,
    "first Game Day preview was not a read-only response",
  );
  await eventAdminPage
    .getByText(/Slot .*→/u)
    .last()
    .waitFor();
  await eventAdminPage.getByRole("button", { name: "Apply Delay" }).click();
  await eventAdminPage
    .getByText(/Expected Delay 2m/u)
    .last()
    .waitFor();
  const secondDayScheduleHubResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().includes("/api/event-admin/hub?") && response.request().method() === "GET",
  );
  await eventAdminGameDaySelector.selectOption({ index: 2 });
  await secondDayScheduleHubResponsePromise;
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
  await eventAdminPage.getByLabel("Gameplay Slot sequence").fill("2");
  await eventAdminPage.getByLabel("Gameplay Slot scheduled start").fill("2026-08-15T10:30");
  const secondDaySlotResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().includes(`/api/event-admin/events/${eventId}/game-days/`) &&
      response.url().endsWith("/gameplay-slots") &&
      response.request().method() === "POST",
  );
  await eventAdminPage.getByRole("button", { name: "Add Gameplay Slot" }).click();
  assert(
    (await secondDaySlotResponsePromise).status() === 201,
    "second Gameplay Slot creation failed",
  );
  await eventAdminPage
    .getByText(/Slot 2.*10:30/u)
    .last()
    .waitFor();
  await eventAdminPage.getByLabel("Gameplay Slot for Event Game").selectOption({ index: 2 });
  await eventAdminPage.getByLabel("Pitch Slot for Event Game").selectOption({ index: 2 });
  await eventAdminPage.getByLabel("Game Code").fill("G-02");
  await eventAdminPage.getByLabel("Game Designation").fill("Second");
  await eventAdminPage.getByLabel("Side A source label").fill("Winner C");
  await eventAdminPage.getByLabel("Side B source label").fill("Winner D");
  const secondGameResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().includes(`/api/event-admin/events/${eventId}/game-days/`) &&
      response.url().endsWith("/event-games") &&
      response.request().method() === "POST",
  );
  await eventAdminPage.getByRole("button", { name: "Add unresolved Event Game" }).click();
  assert((await secondGameResponsePromise).status() === 201, "second Event Game creation failed");
  await eventAdminPage.getByRole("button", { name: "Refresh Slot setup" }).click();
  await eventAdminPage.getByText("Opening", { exact: true }).waitFor();
  await eventAdminPage.getByRole("button", { name: "Published Event", exact: true }).click();
  const publicationWarning = eventAdminPage.getByText(/Published with incomplete schedule:/u);
  await publicationWarning.waitFor();
  const publicationWarningText = await publicationWarning.innerText();
  assert(
    publicationWarningText.includes("Event Games") &&
      publicationWarningText.includes("unresolved matchups"),
    "publication warning did not identify incomplete Event Game content",
  );
  const publishedAudience = await eventAdminContext.request.get(
    `${origin}/api/audience/events/${eventId}`,
  );
  assert(publishedAudience.status() === 200, "published Event was not anonymously available");
  const publishedAudiencePayload = await publishedAudience.json();
  assert(
    publishedAudiencePayload.value?.auditTrail === undefined &&
      publishedAudiencePayload.value?.publicationStatus === "published",
    "anonymous projection leaked private publication history",
  );
  const unpublishedButton = eventAdminPage.getByRole("button", {
    name: "Unpublished Event",
    exact: true,
  });
  assert(await unpublishedButton.isDisabled(), "leaving Published was not gated by confirmation");
  await eventAdminPage.getByLabel("Confirm leaving Published").check();
  assert(!(await unpublishedButton.isDisabled()), "impact confirmation did not enable hiding");
  await unpublishedButton.click();
  await eventAdminPage.getByText("Publication Status updated.", { exact: true }).waitFor();
  const unpublishedAudience = await eventAdminContext.request.get(
    `${origin}/api/audience/events/${eventId}`,
  );
  assert(unpublishedAudience.status() === 404, "unpublished Event remained anonymously available");
  await eventAdminPage.getByRole("button", { name: "Published Event", exact: true }).click();
  await eventAdminPage.getByLabel("Confirm leaving Published").check();
  await eventAdminPage.getByRole("button", { name: "Cancel Event", exact: true }).click();
  const cancelledAudience = await eventAdminContext.request.get(
    `${origin}/api/audience/events/${eventId}`,
  );
  assert(cancelledAudience.status() === 404, "cancelled Event remained anonymously available");
  const unknownAudience = await eventAdminContext.request.get(
    `${origin}/api/audience/events/unknown-event`,
  );
  assert(
    unknownAudience.status() === cancelledAudience.status() &&
      (await unknownAudience.text()) === (await cancelledAudience.text()),
    "unknown Event did not use the same anonymous absence response",
  );
  await eventAdminPage
    .getByText(/Slot 1.*10:00/u)
    .last()
    .waitFor();
  const sessionCookieBeforeDelayPreview = (await eventAdminContext.cookies()).find(
    (cookie) => cookie.name === "__Host-event-admin-session",
  );
  await eventAdminPage.getByLabel("Gameplay Slot 1 Expected Delay minutes").fill("1");
  const secondDayPreviewResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().endsWith("/expected-delay/preview") && response.request().method() === "POST",
  );
  await eventAdminPage.getByRole("button", { name: "Preview Delay" }).first().click();
  const secondDayPreviewResponse = await secondDayPreviewResponsePromise;
  assert(
    secondDayPreviewResponse.status() === 200 &&
      secondDayPreviewResponse.headers()["set-cookie"] === undefined,
    "second Game Day preview emitted a session refresh header",
  );
  await eventAdminPage
    .getByText(/Slot .*→/u)
    .last()
    .waitFor();
  await eventAdminPage.getByLabel("Pitch Manager Game Day").selectOption({ index: 2 });
  await eventAdminPage.getByLabel("Pitch Manager Pitch").selectOption({ label: "Pitch Main" });
  const pitchManagerGameDayId = await eventAdminPage
    .getByLabel("Pitch Manager Game Day")
    .inputValue();
  const pitchManagerPitchId = await eventAdminPage.getByLabel("Pitch Manager Pitch").inputValue();
  const pitchManagerCreateResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().includes("/pitch-manager-grant") && response.request().method() === "POST",
  );
  await eventAdminPage.getByRole("button", { name: "Create Grant" }).last().click();
  const pitchManagerCreateResponse = await pitchManagerCreateResponsePromise;
  assert(pitchManagerCreateResponse.status() === 201, "Pitch Manager Grant creation failed");
  assertCappedEventAdminCookie(
    (await pitchManagerCreateResponse.headersArray()).find((header) => header.name === "set-cookie")
      ?.value,
  );
  const duplicatePitchManagerGrant = await eventAdminContext.request.post(
    `${origin}/api/event-admin/events/${eventId}/game-days/${await eventAdminPage.getByLabel("Pitch Manager Game Day").inputValue()}/pitches/${await eventAdminPage.getByLabel("Pitch Manager Pitch").inputValue()}/pitch-manager-grant`,
  );
  assert(
    duplicatePitchManagerGrant.status() === 400 &&
      duplicatePitchManagerGrant.headers()["cache-control"] === "no-store" &&
      duplicatePitchManagerGrant.headers()["referrer-policy"] === "no-referrer" &&
      duplicatePitchManagerGrant.headers()["set-cookie"] === undefined,
    "invalid duplicate Pitch Manager Grant response was not generic and uncached",
  );
  await eventAdminPage.getByText(/active.*expires/u).waitFor();
  const pitchManagerRevealResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().includes("/pitch-manager-grant/reveal") &&
      response.request().method() === "POST",
  );
  await eventAdminPage.getByRole("button", { name: "Reveal QR" }).click();
  const pitchManagerRevealResponse = await pitchManagerRevealResponsePromise;
  assertCappedEventAdminCookie(
    (await pitchManagerRevealResponse.headersArray()).find((header) => header.name === "set-cookie")
      ?.value,
  );
  const pitchManagerRevealPayload = (await pitchManagerRevealResponse.json()) as {
    status: string;
    value?: { qrCredential?: string };
  };
  const pitchManagerCredential = pitchManagerRevealPayload.value?.qrCredential ?? "";
  assert(
    pitchManagerRevealResponse.status() === 200 && pitchManagerCredential.length > 0,
    "Pitch Manager QR reveal failed",
  );
  const pitchManagerContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    timezoneId: "UTC",
  });
  const pitchManagerPage = await pitchManagerContext.newPage();
  pitchManagerPage.setDefaultTimeout(5_000);
  browserPage = pitchManagerPage;
  await pitchManagerPage.goto(`${origin}/pitch-manager`);
  const wrongPitchManagerAdmission = await postJsonFromPage(
    pitchManagerPage,
    `${origin}/api/pitch-manager/admit`,
    { qrCredential: revealedCredential },
  );
  assert(
    wrongPitchManagerAdmission.status === 401 &&
      wrongPitchManagerAdmission.cacheControl === "no-store" &&
      wrongPitchManagerAdmission.referrerPolicy === "no-referrer" &&
      wrongPitchManagerAdmission.setCookie === null,
    "wrong Grant type was admitted or disclosed by Pitch Manager admission",
  );
  const eventAdminSessionBeforeWrongType = (await eventAdminContext.cookies()).find(
    (cookie) => cookie.name === "__Host-event-admin-session",
  );
  const wrongEventAdminAdmission = await postJsonFromPage(
    eventAdminPage,
    `${origin}/api/event-admin/admit`,
    { qrCredential: pitchManagerCredential },
  );
  const eventAdminSessionAfterWrongType = (await eventAdminContext.cookies()).find(
    (cookie) => cookie.name === "__Host-event-admin-session",
  );
  assert(
    wrongEventAdminAdmission.status === 401 &&
      wrongEventAdminAdmission.cacheControl === "no-store" &&
      wrongEventAdminAdmission.referrerPolicy === "no-referrer" &&
      wrongEventAdminAdmission.setCookie === null &&
      eventAdminSessionBeforeWrongType?.value === eventAdminSessionAfterWrongType?.value,
    "wrong Grant type was admitted or disclosed by Event Admin admission",
  );
  await pitchManagerPage.getByLabel("Scanned Pitch Manager QR value").fill(pitchManagerCredential);
  await pitchManagerPage.getByRole("button", { name: "Open Pitch" }).click();
  await pitchManagerPage.getByText("Pitch Main", { exact: true }).waitFor();
  await pitchManagerPage.getByText(/Pitch Manager.*Game Day/u).waitFor();
  await pitchManagerPage.getByText(/2026-08-15 10:00 Europe\/Zurich/u).waitFor();
  await pitchManagerPage
    .getByText(/Control Grant:/u)
    .first()
    .waitFor();

  const controlSetupResponse = await eventAdminContext.request.get(
    `${origin}/api/event-admin/slot-setup?eventId=${eventId}&gameDayId=${pitchManagerGameDayId}`,
  );
  const controlSetupPayload = (await controlSetupResponse.json()) as {
    value?: {
      pitchSlots?: Array<{ pitchSlotId: string; pitchId: string; gameDayId: string }>;
    };
  };
  const controlSlot = controlSetupPayload.value?.pitchSlots?.find(
    (slot) => slot.pitchId === pitchManagerPitchId && slot.gameDayId === pitchManagerGameDayId,
  );
  const pitchManagerControlSlot = controlSetupPayload.value?.pitchSlots?.find(
    (slot) =>
      slot.pitchId === pitchManagerPitchId &&
      slot.gameDayId === pitchManagerGameDayId &&
      slot.pitchSlotId !== controlSlot?.pitchSlotId,
  );
  assert(
    controlSetupResponse.status() === 200 &&
      controlSlot !== undefined &&
      pitchManagerControlSlot !== undefined,
    "Control Slot setup failed",
  );
  const controlGrantPath = `/api/event-admin/events/${eventId}/game-days/${pitchManagerGameDayId}/pitches/${pitchManagerPitchId}/pitch-slots/${controlSlot.pitchSlotId}/control-grant`;
  const controlCreateResponse = await postJsonBodyFromPage(
    eventAdminPage,
    `${origin}${controlGrantPath}`,
    {},
  );
  const controlCreatePayload = JSON.parse(controlCreateResponse.body) as {
    value?: Record<string, unknown>;
  };
  assert(
    controlCreateResponse.status === 201 &&
      controlCreatePayload.value?.grantId !== undefined &&
      controlCreatePayload.value?.qrCredential === undefined,
    "Control Grant creation disclosed a credential or failed",
  );
  const eventAdminCookieBeforePitchManagerMutation = (await eventAdminContext.cookies()).find(
    (cookie) => cookie.name === "__Host-event-admin-session",
  );
  if (eventAdminCookieBeforePitchManagerMutation === undefined)
    throw new Error("Event Admin session cookie was not available for cookie isolation evidence.");
  await pitchManagerContext.addCookies([eventAdminCookieBeforePitchManagerMutation]);
  const pitchManagerControlPath = `/api/pitch-manager/events/${eventId}/game-days/${pitchManagerGameDayId}/pitches/${pitchManagerPitchId}/pitch-slots/${pitchManagerControlSlot.pitchSlotId}/control-grant`;
  const pitchManagerControlCreateResponsePromise = pitchManagerPage.waitForResponse(
    (response) =>
      response
        .url()
        .endsWith(`/pitch-slots/${pitchManagerControlSlot.pitchSlotId}/control-grant`) &&
      response.request().method() === "POST",
  );
  const pitchManagerControlCreateResponse = await pitchManagerPage.evaluate(async (requestUrl) => {
    const response = await fetch(requestUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    return response.status;
  }, `${origin}${pitchManagerControlPath}`);
  const pitchManagerControlCreateResponseHeaders = await pitchManagerControlCreateResponsePromise;
  const pitchManagerControlCreateCookie = (
    await pitchManagerControlCreateResponseHeaders.headersArray()
  ).find((header) => header.name === "set-cookie")?.value;
  assert(
    pitchManagerControlCreateResponse === 201 &&
      pitchManagerControlCreateCookie?.includes("__Host-pitch-manager-session=") === true &&
      pitchManagerControlCreateCookie?.includes("__Host-event-admin-session=") !== true,
    "Pitch Manager Control Grant creation did not refresh only its own cookie",
  );
  const eventAdminCookieAfterPitchManagerMutation = (await pitchManagerContext.cookies()).find(
    (cookie) => cookie.name === "__Host-event-admin-session",
  );
  assert(
    eventAdminCookieAfterPitchManagerMutation?.value ===
      eventAdminCookieBeforePitchManagerMutation.value,
    "Pitch Manager Control Grant mutation overwrote the Event Admin cookie",
  );
  const pitchManagerCreatedControlInspect = await pitchManagerContext.request.get(
    `${origin}${pitchManagerControlPath}`,
  );
  assert(
    pitchManagerCreatedControlInspect.status() === 200,
    "Pitch Manager Control Grant inspection failed",
  );
  const pitchManagerControlSessions = await pitchManagerContext.request.get(
    `${origin}${pitchManagerControlPath}/sessions`,
  );
  assert(
    pitchManagerControlSessions.status() === 200 &&
      pitchManagerControlSessions.headers()["set-cookie"] === undefined,
    "Pitch Manager Control Grant session listing was not read-only",
  );
  const wrongPitchManagerControl = await pitchManagerContext.request.get(
    `${origin}/api/pitch-manager/events/${eventId}/game-days/${pitchManagerGameDayId}/pitches/wrong-pitch/pitch-slots/${pitchManagerControlSlot.pitchSlotId}/control-grant`,
  );
  const wrongGameDayPitchManagerControl = await pitchManagerContext.request.get(
    `${origin}/api/pitch-manager/events/${eventId}/game-days/wrong-game-day/pitches/${pitchManagerPitchId}/pitch-slots/${pitchManagerControlSlot.pitchSlotId}/control-grant`,
  );
  assert(
    (wrongPitchManagerControl.status() === 401 || wrongPitchManagerControl.status() === 404) &&
      (wrongGameDayPitchManagerControl.status() === 401 ||
        wrongGameDayPitchManagerControl.status() === 404),
    "Pitch Manager Control Grant scope accepted a wrong Pitch or Game Day",
  );
  await eventAdminPage.reload();
  await eventAdminPage
    .getByLabel("Game Day", { exact: true })
    .selectOption({ value: pitchManagerGameDayId });
  await eventAdminPage.getByRole("button", { name: "Pitch Main", exact: true }).click();
  const controlInspectResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().endsWith(`/pitch-slots/${controlSlot.pitchSlotId}/control-grant`) &&
      response.request().method() === "GET",
  );
  await eventAdminPage.getByRole("button", { name: "Inspect Control Grant" }).first().click();
  assert((await controlInspectResponsePromise).status() === 200, "Control Grant inspection failed");
  const pitchManagerControlInspect = await pitchManagerContext.request.get(
    `${origin}/api/pitch-manager${controlGrantPath}`,
  );
  assert(
    pitchManagerControlInspect.status() === 200,
    "Pitch Manager could not inspect its exact Pitch and Game Day Control Grant",
  );
  const wrongPitchManagerControlInspect = await pitchManagerContext.request.get(
    `${origin}/api/pitch-manager/events/${eventId}/game-days/wrong-game-day/pitches/${pitchManagerPitchId}/pitch-slots/${controlSlot.pitchSlotId}/control-grant`,
  );
  assert(
    wrongPitchManagerControlInspect.status() === 401 ||
      wrongPitchManagerControlInspect.status() === 404,
    "Pitch Manager Control Grant scope was broader than its exact Game Day",
  );
  const controlRevealResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().endsWith(`/pitch-slots/${controlSlot.pitchSlotId}/control-grant/reveal`) &&
      response.request().method() === "POST",
  );
  await eventAdminPage.getByRole("button", { name: "Reveal QR" }).first().click();
  const controlRevealResponse = await controlRevealResponsePromise;
  const controlRevealPayload = (await controlRevealResponse.json()) as {
    status?: string;
    reason?: string;
    value?: { qrCredential?: string };
  };
  assert(
    controlRevealResponse.status() === 401 &&
      controlRevealPayload.value?.qrCredential === undefined &&
      controlRevealPayload.reason === "unauthorized",
    "ineligible Control Grant reveal was not generic and redacted",
  );
  const controlSessionsResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().endsWith(`/pitch-slots/${controlSlot.pitchSlotId}/control-grant/sessions`) &&
      response.request().method() === "GET",
  );
  await eventAdminPage.getByRole("button", { name: "Sessions" }).first().click();
  const controlSessionsResponse = await controlSessionsResponsePromise;
  assert(controlSessionsResponse.status() === 200, "Control Grant session listing failed");
  const controlRotateResponse = await postJsonFromPage(
    eventAdminPage,
    `${origin}${controlGrantPath}/rotate`,
    {},
  );
  assert(
    controlRotateResponse.status === 400 || controlRotateResponse.status === 401,
    "ineligible Control Grant rotation did not fail generically",
  );
  await pitchManagerPage.reload();
  await pitchManagerPage.getByText("Pitch Main", { exact: true }).waitFor();
  await pitchManagerPage.getByText(/2026-08-15 10:00 Europe\/Zurich/u).waitFor();
  await eventAdminPage.reload();
  await eventAdminPage.getByLabel("Pitch Manager Game Day").waitFor();
  await eventAdminPage
    .getByLabel("Pitch Manager Game Day")
    .selectOption({ value: pitchManagerGameDayId });
  await eventAdminPage
    .getByLabel("Pitch Manager Pitch")
    .selectOption({ value: pitchManagerPitchId });
  const pitchManagerInspectAfterRestartResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url() ===
        `${origin}/api/event-admin/events/${eventId}/game-days/${pitchManagerGameDayId}/pitches/${pitchManagerPitchId}/pitch-manager-grant` &&
      response.request().method() === "GET",
  );
  await eventAdminPage.getByRole("button", { name: "Inspect Grant" }).click();
  assert(
    (await pitchManagerInspectAfterRestartResponsePromise).status() === 200,
    "Pitch Manager Grant inspection failed after server restart",
  );
  await restartServerProcess(origin, environment);
  const currentAfterRestart = await fetchFromPage(
    pitchManagerPage,
    `${origin}/api/pitch-manager/current`,
  );
  assert(
    currentAfterRestart.status === 200,
    `Pitch Manager current projection failed after restart (${currentAfterRestart.status})`,
  );
  await pitchManagerPage.reload();
  await pitchManagerPage.getByText("Pitch Main", { exact: true }).waitFor();
  await pitchManagerPage.getByText(/2026-08-15 10:00 Europe\/Zurich/u).waitFor();
  const pitchManagerInspectBeforeRotation = await eventAdminContext.request.get(
    `${origin}/api/event-admin/events/${eventId}/game-days/${await eventAdminPage.getByLabel("Pitch Manager Game Day").inputValue()}/pitches/${await eventAdminPage.getByLabel("Pitch Manager Pitch").inputValue()}/pitch-manager-grant`,
  );
  const pitchManagerInspectBeforeRotationPayload =
    (await pitchManagerInspectBeforeRotation.json()) as {
      status: string;
      value?: { grantVersion?: string };
    };
  const originalPitchManagerVersion =
    pitchManagerInspectBeforeRotationPayload.value?.grantVersion ?? "";
  assert(originalPitchManagerVersion.length > 0, "Pitch Manager Grant version was not inspectable");
  const pitchManagerRotateResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().includes("/pitch-manager-grant/rotate") &&
      response.request().method() === "POST",
  );
  await eventAdminPage.getByRole("button", { name: "Rotate Pitch Manager Grant" }).click();
  assert(
    (await pitchManagerRotateResponsePromise).status() === 200,
    "Pitch Manager Grant rotation failed",
  );
  const rotatedPitchManagerInspect = await eventAdminContext.request.get(
    `${origin}/api/event-admin/events/${eventId}/game-days/${await eventAdminPage.getByLabel("Pitch Manager Game Day").inputValue()}/pitches/${await eventAdminPage.getByLabel("Pitch Manager Pitch").inputValue()}/pitch-manager-grant`,
  );
  const rotatedPitchManagerPayload = (await rotatedPitchManagerInspect.json()) as {
    status: string;
    value?: { grantVersion?: string };
  };
  const rotatedPitchManagerVersion = rotatedPitchManagerPayload.value?.grantVersion ?? "";
  assert(
    rotatedPitchManagerVersion.length > 0 &&
      rotatedPitchManagerVersion !== originalPitchManagerVersion,
    "Pitch Manager rotation did not create a new Grant version",
  );
  const stalePitchManagerAfterRotation = await fetchFromPage(
    pitchManagerPage,
    `${origin}/api/pitch-manager/current`,
  );
  assert(
    stalePitchManagerAfterRotation.status === 401,
    "rotated Pitch Manager session remained live",
  );
  const pitchManagerDisableResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().includes("/pitch-manager-grant/disable") &&
      response.request().method() === "POST",
  );
  const pitchManagerDisableInspectResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url() ===
        `${origin}/api/event-admin/events/${eventId}/game-days/${pitchManagerGameDayId}/pitches/${pitchManagerPitchId}/pitch-manager-grant` &&
      response.request().method() === "GET",
  );
  await eventAdminPage.getByRole("button", { name: "Disable Pitch Manager Grant" }).click();
  assert(
    (await pitchManagerDisableResponsePromise).status() === 200,
    "Pitch Manager Grant disable failed",
  );
  assert(
    (await pitchManagerDisableInspectResponsePromise).status() === 200,
    "Pitch Manager Grant disable inspection failed",
  );
  await expect(eventAdminPage.getByText(/disabled.*expires/u)).toBeVisible();
  await expect(
    eventAdminPage.getByRole("button", { name: "Reactivate Pitch Manager Grant" }),
  ).toBeEnabled();
  const pitchManagerReactivateInspectResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url() ===
        `${origin}/api/event-admin/events/${eventId}/game-days/${pitchManagerGameDayId}/pitches/${pitchManagerPitchId}/pitch-manager-grant` &&
      response.request().method() === "GET",
  );
  const pitchManagerReactivateResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().includes("/pitch-manager-grant/reactivate") &&
      response.request().method() === "POST",
  );
  await eventAdminPage.getByRole("button", { name: "Reactivate Pitch Manager Grant" }).click();
  assert(
    (await pitchManagerReactivateResponsePromise).status() === 200,
    "Pitch Manager Grant reactivation failed",
  );
  const pitchManagerReactivateInspectResponse = await pitchManagerReactivateInspectResponsePromise;
  const pitchManagerReactivateInspectPayload =
    (await pitchManagerReactivateInspectResponse.json()) as {
      status: string;
      value?: { grantVersion?: string; status?: string };
    };
  const reactivatedPitchManagerVersion =
    pitchManagerReactivateInspectPayload.value?.grantVersion ?? "";
  assert(
    pitchManagerReactivateInspectResponse.status() === 200 &&
      pitchManagerReactivateInspectPayload.status === "accepted" &&
      pitchManagerReactivateInspectPayload.value?.status === "active" &&
      reactivatedPitchManagerVersion.length > 0 &&
      reactivatedPitchManagerVersion !== rotatedPitchManagerVersion,
    "Pitch Manager reactivation did not settle an active new Grant version",
  );
  await expect(eventAdminPage.getByText(/active.*expires/u)).toBeVisible();
  const reactivatedPitchManagerRevealResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().includes("/pitch-manager-grant/reveal") &&
      response.request().method() === "POST",
  );
  await expect(eventAdminPage.getByRole("button", { name: "Reveal QR" })).toBeEnabled();
  await eventAdminPage.getByRole("button", { name: "Reveal QR" }).click();
  const reactivatedPitchManagerReveal = await reactivatedPitchManagerRevealResponsePromise;
  const reactivatedPitchManagerRevealPayload = (await reactivatedPitchManagerReveal.json()) as {
    status: string;
    value?: { qrCredential?: string };
  };
  const reactivatedPitchManagerCredential =
    reactivatedPitchManagerRevealPayload.value?.qrCredential ?? "";
  assert(
    reactivatedPitchManagerReveal.status() === 200 &&
      reactivatedPitchManagerCredential.length > 0 &&
      reactivatedPitchManagerCredential !== pitchManagerCredential,
    "Pitch Manager reactivation did not reveal a new QR credential",
  );
  const reactivatedPitchManagerAdmission = await postJsonFromPage(
    pitchManagerPage,
    `${origin}/api/pitch-manager/admit`,
    { qrCredential: reactivatedPitchManagerCredential },
  );
  assert(
    reactivatedPitchManagerAdmission.status === 200 &&
      reactivatedPitchManagerAdmission.cacheControl === "no-store" &&
      reactivatedPitchManagerAdmission.referrerPolicy === "no-referrer",
    "Pitch Manager reactivation did not admit a new session",
  );
  const reactivatedPitchManagerCurrent = await fetchFromPage(
    pitchManagerPage,
    `${origin}/api/pitch-manager/current`,
  );
  assert(
    reactivatedPitchManagerCurrent.status === 200,
    "reactivated Pitch Manager session was not live",
  );
  assert(
    reactivatedPitchManagerCurrent.cacheControl === "no-store",
    "reactivated Pitch Manager projection was cacheable",
  );
  const sessionCookieAfterDelayPreview = (await eventAdminContext.cookies()).find(
    (cookie) => cookie.name === "__Host-event-admin-session",
  );
  assert(
    sessionCookieBeforeDelayPreview !== undefined &&
      sessionCookieAfterDelayPreview !== undefined &&
      sessionCookieAfterDelayPreview.value === sessionCookieBeforeDelayPreview.value,
    "delay preview changed the persisted browser session",
  );
  await eventAdminGameDaySelector.selectOption({ index: 2 });
  await eventAdminPage.getByLabel("Gameplay Slot 1 Expected Delay minutes").fill("1");
  await eventAdminPage.getByRole("button", { name: "Apply Delay" }).first().click();
  await eventAdminPage
    .getByText(/Expected Delay 1m/u)
    .last()
    .waitFor();
  await eventAdminPage.getByRole("button", { name: "Pitch Main", exact: true }).click();
  await eventAdminPage.getByLabel("Pitch Slot 1 Expected Delay minutes").waitFor();
  await eventAdminPage.getByLabel("Pitch Slot 1 Expected Delay minutes").fill("3");
  const pitchPreviewResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().endsWith("/expected-delay/preview") && response.request().method() === "POST",
  );
  await eventAdminPage.getByRole("button", { name: "Preview Pitch Delay" }).first().click();
  const pitchPreviewResponse = await pitchPreviewResponsePromise;
  assert(
    pitchPreviewResponse.status() === 200 &&
      pitchPreviewResponse.headers()["set-cookie"] === undefined,
    "Pitch Slot preview emitted a session refresh header",
  );
  await eventAdminPage.getByText(/Preview · Pitch/u).waitFor();
  await eventAdminPage
    .getByRole("button", { name: "Apply Pitch Delay" })
    .first()
    .click({ force: true });
  await expectValue(eventAdminPage.getByLabel("Pitch Slot 1 Expected Delay minutes"), "3");
  const targetSelectors = eventAdminPage.locator('select[aria-label$="target Pitch Slot"]');
  await targetSelectors.first().selectOption({ index: 2 });
  await eventAdminPage.locator('select[aria-label$="mode"]').first().selectOption("move");
  const moveResponsePromise = eventAdminPage.waitForResponse(
    (response) => response.url().endsWith("/reassign") && response.request().method() === "POST",
  );
  await eventAdminPage.getByRole("button", { name: "Reassign Game" }).first().click();
  assert((await moveResponsePromise).status() === 200, "Pitch move request failed");
  await eventAdminPage
    .getByText(/Schedule Conflict/u)
    .first()
    .waitFor();
  await eventAdminPage.getByLabel("Gameplay Slot for Event Game").selectOption({ index: 1 });
  await eventAdminPage.getByLabel("Pitch Slot for Event Game").selectOption({ index: 1 });
  await eventAdminPage.getByLabel("Game Code").fill("G-03");
  await eventAdminPage.getByLabel("Game Designation").fill("Third");
  await eventAdminPage.getByLabel("Side A source label").fill("Winner E");
  await eventAdminPage.getByLabel("Side B source label").fill("Winner F");
  const thirdGameResponsePromise = eventAdminPage.waitForResponse(
    (response) =>
      response.url().includes(`/api/event-admin/events/${eventId}/game-days/`) &&
      response.url().endsWith("/event-games") &&
      response.request().method() === "POST",
  );
  await eventAdminPage.getByRole("button", { name: "Add unresolved Event Game" }).click();
  assert((await thirdGameResponsePromise).status() === 201, "third Event Game creation failed");
  await eventAdminPage.getByRole("button", { name: "Refresh Slot setup" }).click();
  await eventAdminPage.getByText("Third", { exact: true }).waitFor();
  await eventAdminPage.getByRole("button", { name: "Pitch Main", exact: true }).click();
  await eventAdminPage.getByLabel("Pitch Slot 1 Expected Delay minutes").waitFor();
  const lastTargetSelector = eventAdminPage
    .locator('select[aria-label$="target Pitch Slot"]')
    .last();
  await lastTargetSelector.selectOption({ index: 2 });
  await eventAdminPage.locator('select[aria-label$="mode"]').last().selectOption("swap");
  const multiOccupantSwapResponsePromise = eventAdminPage.waitForResponse(
    (response) => response.url().endsWith("/reassign") && response.request().method() === "POST",
  );
  await eventAdminPage.getByRole("button", { name: "Reassign Game" }).last().click();
  const multiOccupantSwapResponse = await multiOccupantSwapResponsePromise;
  assert(
    multiOccupantSwapResponse.status() === 400,
    `multi-occupant swap returned ${multiOccupantSwapResponse.status()}`,
  );
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
  const finalRemovalEventResponse = await context.request.post(`${origin}/api/admin/events`, {
    data: { name: "Final Removal Browser Event", timeZone: "UTC" },
    headers: { origin, "x-technical-admin-csrf": currentCsrfToken },
  });
  const finalRemovalEventPayload = (await finalRemovalEventResponse.json()) as {
    status: string;
    value?: { eventId?: string };
  };
  const finalRemovalEventId = finalRemovalEventPayload.value?.eventId;
  assert(
    finalRemovalEventResponse.status() === 201 && finalRemovalEventId !== undefined,
    "final removal browser Event creation failed",
  );
  for (const date of ["2026-08-17", "2026-08-18"]) {
    const finalRemovalDayResponse = await context.request.post(
      `${origin}/api/admin/events/${finalRemovalEventId}/game-days`,
      {
        data: { date },
        headers: { origin, "x-technical-admin-csrf": currentCsrfToken },
      },
    );
    assert(finalRemovalDayResponse.status() === 201, `final removal Game Day ${date} failed`);
  }
  await page.goto(`${origin}/admin`);
  await page.getByText("Technical Admin administration").waitFor();
  await page.getByRole("button", { name: /Final Removal Browser Event/ }).click();
  await page.getByRole("button", { name: "Create Grant" }).click();
  const finalRevealResponsePromise = page.waitForResponse(
    (response) =>
      response
        .url()
        .includes(`/api/admin/events/${finalRemovalEventId}/event-admin-grant/reveal`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Reveal QR credential" }).click();
  const finalRevealResponse = await finalRevealResponsePromise;
  const finalRevealPayload = (await finalRevealResponse.json()) as {
    status: string;
    value?: { qrCredential?: string };
  };
  const finalCredential = finalRevealPayload.value?.qrCredential ?? "";
  assert(
    finalRevealResponse.status() === 200 && finalCredential.length > 0,
    "final QR reveal failed",
  );
  const finalRemovalContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const finalRemovalPage = await finalRemovalContext.newPage();
  finalRemovalPage.setDefaultTimeout(5_000);
  await finalRemovalPage.goto(`${origin}/event-admin?eventId=${finalRemovalEventId}`);
  await finalRemovalPage.getByLabel("Scanned Event Admin QR value").fill(finalCredential);
  await finalRemovalPage.getByRole("button", { name: "Admit Event Admin" }).click();
  await finalRemovalPage.getByText(/event-admin/u).waitFor();
  const finalRemovalSelector = finalRemovalPage.getByLabel("Game Day", { exact: true });
  const finalFirstDayHubResponsePromise = finalRemovalPage.waitForResponse(
    (response) =>
      response.url().includes("/api/event-admin/hub?") && response.request().method() === "GET",
  );
  await finalRemovalSelector.selectOption({ index: 1 });
  await finalFirstDayHubResponsePromise;
  assert(
    (await finalRemovalSelector.inputValue()).length > 0,
    "final removal Game Day was not selected",
  );
  await finalRemovalPage.getByLabel("New Pitch name").fill("Final Pitch");
  await finalRemovalPage.getByRole("button", { name: "Add Pitch" }).click();
  await finalRemovalPage.getByRole("button", { name: "Final Pitch", exact: true }).waitFor();
  await finalRemovalPage.getByLabel("Preview removal Pitch Final Pitch").click();
  const finalPitchHubResponsePromise = finalRemovalPage.waitForResponse(
    (response) =>
      response.url().includes("/api/event-admin/hub?") &&
      response.url().includes("gameDayId=") &&
      response.request().method() === "GET",
  );
  await finalRemovalPage.getByRole("button", { name: "Confirm", exact: true }).click();
  await finalRemovalPage.getByRole("button", { name: "Final Pitch", exact: true }).waitFor({
    state: "detached",
  });
  await finalPitchHubResponsePromise;
  assert(
    (await finalRemovalPage.getByRole("button", { name: "Final Pitch", exact: true }).count()) ===
      0,
    "final Pitch removal did not leave the UI in an empty state",
  );
  const firstFinalDayValue = await finalRemovalSelector.inputValue();
  await finalRemovalPage.getByLabel(/Preview removal Game Day 2026-08-17/u).click();
  const survivingFinalDayHubResponsePromise = finalRemovalPage.waitForResponse(
    (response) =>
      response.url().includes("/api/event-admin/hub?") &&
      response.url().includes("gameDayId=") &&
      response.request().method() === "GET",
  );
  await finalRemovalPage.getByRole("button", { name: "Confirm", exact: true }).click();
  await survivingFinalDayHubResponsePromise;
  assert(
    (await finalRemovalSelector.inputValue()) !== firstFinalDayValue,
    "selected Game Day was not changed after removing it",
  );
  await finalRemovalPage.getByLabel(/Preview removal Game Day 2026-08-18/u).click();
  await finalRemovalPage.getByRole("button", { name: "Confirm", exact: true }).click();
  await expectValue(finalRemovalSelector, "");
  await finalRemovalPage
    .getByText("Choose a Game Day to schedule Games.", { exact: true })
    .waitFor();
  await finalRemovalContext.close();
  await pitchManagerContext.close();
  await eventAdminContext.close();
  await revokedEventAdminContext.close();
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
      pitchManagerHandoff: true,
      pitchManagerScopedView: true,
      controlGrantManagement: true,
      controlGrantRedaction: true,
      controlGrantScopedView: true,
      pitchManagerControlCookieIsolation: true,
      pitchManagerControlReadOnly: true,
      pitchManagerControlScopedView: true,
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

async function restartServerProcess(serverOrigin: string, serverEnvironment: NodeJS.ProcessEnv) {
  if (server !== null) {
    server.kill();
    await server.exited;
    await Bun.sleep(250);
  }
  server = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: process.cwd(),
    env: serverEnvironment,
    stdout: "pipe",
    stderr: "pipe",
  });
  serverStderr = new Response(server.stderr as unknown as BodyInit).text();
  await waitForServer(`${serverOrigin}/internal/healthz`);
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

async function postJsonFromPage(page: Page, url: string, body: Record<string, string>) {
  return page.evaluate(
    async ({ requestUrl, requestBody }) => {
      const response = await fetch(requestUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      return {
        status: response.status,
        cacheControl: response.headers.get("cache-control"),
        referrerPolicy: response.headers.get("referrer-policy"),
        setCookie: response.headers.get("set-cookie"),
      };
    },
    { requestUrl: url, requestBody: body },
  );
}

async function postJsonBodyFromPage(page: Page, url: string, body: Record<string, string>) {
  return page.evaluate(
    async ({ requestUrl, requestBody }) => {
      const response = await fetch(requestUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      return {
        status: response.status,
        body: await response.text(),
        setCookie: response.headers.get("set-cookie"),
      };
    },
    { requestUrl: url, requestBody: body },
  );
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

function assertCappedEventAdminCookie(setCookie: string | undefined) {
  const match = setCookie?.match(/__Host-event-admin-session=[^;]+;[^\n]*Max-Age=(\d+)/u);
  const maxAge = match?.[1] === undefined ? null : Number(match[1]);
  assert(
    maxAge !== null && maxAge > 0 && maxAge < 2_592_000,
    `Event Admin session cap was reset (maxAge=${maxAge ?? "missing"})`,
  );
}
