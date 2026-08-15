#!/usr/bin/env bun
import { webkit } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import { createEventCatalog, createFoundationEventCatalogStorage } from "@/lib/event-catalog";
import { createGrantAuthority } from "@/lib/grant-authority";
import { readGrantAuthorityOptions } from "@/lib/grant-runtime";
import {
  MemoryTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
} from "@/lib/technical-admin-auth";
import { createGrantKeyRingDocument, writeGrantKeyRingFile } from "@/lib/grant-key-ring-custody";

const directory = mkdtempSync(join(tmpdir(), "quadball-timer-event-admin-webkit-"));
const foundationPath = join(directory, "foundation.sqlite");
const grantKeyRingPath = join(directory, "grant-key-ring.json");
const port = 39_000 + Math.floor(Math.random() * 1_000);
const origin = `https://localhost:${port}`;
const environment = {
  ...process.env,
  NODE_ENV: "test",
  QUADBALL_ENVIRONMENT: "test",
  PUBLIC_ORIGIN: origin,
  WEBAUTHN_RP_ID: "localhost",
  TECHNICAL_ADMIN_DATABASE: join(directory, "technical-admin.sqlite"),
  FOUNDATION_DATABASE: foundationPath,
  GRANT_KEY_RING_FILE: grantKeyRingPath,
  TLS_CERT_FILE: join(directory, "localhost.crt"),
  TLS_KEY_FILE: join(directory, "localhost.key"),
  PORT: String(port),
};

let server: Bun.Subprocess | null = null;
let serverStderr: Promise<string> | null = null;
let browser: Awaited<ReturnType<typeof webkit.launch>> | null = null;

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
    environment.TLS_KEY_FILE,
    "-out",
    environment.TLS_CERT_FILE,
  ]);
  if (certificate.exitCode !== 0)
    throw new Error("openssl could not create a temporary certificate.");

  writeGrantKeyRingFile(grantKeyRingPath, createGrantKeyRingDocument("test"));
  const grantOptions = readGrantAuthorityOptions("test", environment);
  const foundation = openSqliteFoundationStorage(foundationPath, {
    grantKeyRing: grantOptions.keyRing,
  });
  await foundation.applyMigrations();
  const technical = createTechnicalAdminAuth(
    { environment: "test", origin, rpId: "localhost" },
    new MemoryTechnicalAdminAuthRepository(),
  ).resolveHostLocalAuthority();
  const catalog = createEventCatalog(createFoundationEventCatalogStorage(foundation), {});
  const event = await catalog.createEvent({ name: "WebKit Event", timeZone: "UTC" }, technical);
  if (event.status !== "accepted") throw new Error("WebKit setup Event creation failed.");
  const day = await catalog.addGameDay(event.value.eventId, { date: "2026-08-14" }, technical);
  if (day.status !== "accepted") throw new Error("WebKit setup Game Day creation failed.");
  const grants = createGrantAuthority(foundation, grantOptions);
  const created = await grants.createEventAdminGrant({
    authority: technical,
    scope: {
      eventId: event.value.eventId,
      eventTimeZone: "UTC",
      finalGameDayDate: "2026-08-14",
    },
  });
  if (created.status !== "created") throw new Error("WebKit setup Event Admin Grant failed.");
  const revealed = await grants.revealGrant(created.grantId, technical);
  if (revealed.status !== "revealed") throw new Error("WebKit setup Grant reveal failed.");
  const admission = await grants.admitEventAdminGrant({
    qrCredential: revealed.qrCredential,
    browserContext: "webkit-critical-path",
  });
  if (admission.status !== "admitted") throw new Error("WebKit setup Grant admission failed.");
  foundation.close();

  server = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: process.cwd(),
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  serverStderr = new Response(server.stderr as unknown as BodyInit).text();
  try {
    await waitForServer(server.stdout as unknown as ReadableStream<Uint8Array>);
  } catch (error) {
    server.kill();
    await server.exited;
    const detail = serverStderr === null ? "" : await serverStderr;
    throw new Error(
      `${error instanceof Error ? error.message : "WebKit test server failed."}\n${detail}`,
    );
  }
  browser = await webkit.launch({ headless: true, timeout: 5_000 });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addCookies([
    {
      name: "__Host-event-admin-session",
      value: admission.sessionBearer,
      url: origin,
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
    },
  ]);
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  await page.goto(`${origin}/event-admin?eventId=${event.value.eventId}`);
  await page.getByText("Event Hub", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "Operations health" }).waitFor();
  await page.getByText("Grant problems: 0", { exact: true }).waitFor();

  await page.getByLabel("New Event Team name").fill("WebKit Blue");
  await page.getByRole("button", { name: "Add Team" }).click();
  await page.getByText("WebKit Blue", { exact: true }).first().waitFor();
  await page.getByLabel("Roster Event Team").selectOption({ label: "WebKit Blue" });
  await page.getByLabel("Player number").fill("7");
  await page.getByLabel("Player public name").fill("WebKit Player");
  await page.getByRole("button", { name: "Save Roster" }).click();
  await page.getByText("#7 WebKit Player", { exact: true }).waitFor();
  await page.getByLabel("New Pitch name").fill("WebKit Pitch");
  await page.getByRole("button", { name: "Add Pitch" }).click();
  await page.getByLabel("Pitch WebKit Pitch name").waitFor();
  await page.getByLabel("Game Day", { exact: true }).selectOption({ index: 1 });
  await page.getByLabel("Gameplay Slot sequence").fill("1");
  await page.getByLabel("Gameplay Slot scheduled start").fill("2026-08-14T10:00");
  await page.getByRole("button", { name: "Add Gameplay Slot" }).click();
  await page
    .getByText(/Slot 1.*10:00/u)
    .last()
    .waitFor();
  await page.getByLabel("Gameplay Slot for Event Game").selectOption({ index: 1 });
  await page.getByLabel("Pitch Slot for Event Game").selectOption({ index: 1 });
  await page.getByLabel("Game Code").fill("WK-01");
  await page.getByLabel("Game Designation").fill("WebKit Critical");
  await page.getByLabel("Side A source label").fill("Winner A");
  await page.getByLabel("Side B source label").fill("Winner B");
  await page.getByRole("button", { name: "Add unresolved Event Game" }).click();
  await page.getByText("Unresolved team assignments: 1", { exact: true }).waitFor();
  await page.getByText("Grant problems: 1", { exact: true }).waitFor();

  await page.setViewportSize({ width: 360, height: 900 });
  const layout = await page.evaluate(() => {
    const health = document.querySelector("section[aria-labelledby='operations-health-title']");
    return {
      healthFits: health !== null && health.scrollWidth <= health.clientWidth,
      controlsFit: Array.from(document.querySelectorAll("button, input, select"))
        .filter((element) => getComputedStyle(element).display !== "none")
        .every((element) => {
          const rect = element.getBoundingClientRect();
          return rect.left >= -1 && rect.right <= window.innerWidth + 1;
        }),
    };
  });
  if (!layout.healthFits || !layout.controlsFit)
    throw new Error(`WebKit critical path was not 360px-safe: ${JSON.stringify(layout)}`);
  await page.setViewportSize({ width: 1280, height: 900 });
  const focusTarget = page.getByRole("button", { name: "Refresh Slot setup" });
  await focusTarget.focus();
  const focusIndicator = await page.evaluate(() => {
    const target = Array.from(document.querySelectorAll("button")).find(
      (element) =>
        element.textContent?.trim() === "Refresh Slot setup" ||
        element.getAttribute("aria-label") === "Refresh Slot setup",
    );
    if (!(target instanceof HTMLElement)) return null;
    const style = getComputedStyle(target);
    return {
      active: document.activeElement === target,
      outline: `${style.outlineStyle}/${style.outlineWidth}`,
      boxShadow: style.boxShadow,
    };
  });
  if (
    focusIndicator?.active !== true ||
    (focusIndicator.outline === "none/0px" && focusIndicator.boxShadow === "none")
  )
    throw new Error(`WebKit focus indicator was not rendered: ${JSON.stringify(focusIndicator)}`);
  await page.keyboard.press("Enter");
  await page.getByRole("option", { name: "WebKit Critical", exact: true }).waitFor({
    state: "attached",
  });
  console.log(JSON.stringify({ status: "passed", browser: "webkit", criticalAdminPath: true }));
} finally {
  if (browser !== null) await browser.close().catch(() => undefined);
  if (server !== null) {
    server.kill();
    await server.exited;
  }
  rmSync(directory, { recursive: true, force: true });
}

async function waitForServer(stdout: ReadableStream<Uint8Array>) {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("WebKit test server exited before becoming ready.");
      output += decoder.decode(value, { stream: true });
      if (output.includes("Server running at")) return;
    }
  } finally {
    reader.releaseLock();
  }
}
