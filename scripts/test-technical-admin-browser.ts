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
  await page.getByText("current", { exact: true }).waitFor();
  await gameDayDate.fill("2026-08-15");
  await page.getByRole("button", { name: "Save Game Day" }).click();
  await expectValue(gameDayDate, "2026-08-15");
  await page.getByText("future", { exact: true }).waitFor();
  await page.locator("#selected-event-name").fill("Browser Event Updated");
  await page.getByRole("button", { name: "Save Event" }).click();
  await page.getByRole("heading", { name: "Browser Event Updated" }).waitFor();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByText("No Game Days.").waitFor();
  await page.getByRole("button", { name: "Remove empty Event" }).click();
  await page.getByText("No Events yet.").waitFor();
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
      forgedAuthorityRejected: true,
      revocationRevalidated: true,
    }),
  );
} catch (error) {
  console.error(
    redactDiagnosticText(
      error instanceof Error ? error.message : "Technical Admin browser test failed.",
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
