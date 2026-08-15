#!/usr/bin/env bun
import { chromium, type BrowserContext, type Page } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGrantKeyRingDocument, writeGrantKeyRingFile } from "@/lib/grant-key-ring-custody";
import { createInitialClockBaseline, projectClockBaseline } from "@/lib/clock-authority";
import type { ControllerProjection, LiveSuspensionSnapshot } from "@/lib/live-event-game-control";
import type { LivePenaltyProjection } from "@/lib/live-event-penalties";

const directory = mkdtempSync(join(tmpdir(), "quadball-timer-controller-browser-"));
const certificatePath = join(directory, "localhost.crt");
const keyPath = join(directory, "localhost.key");
const grantKeyRingPath = join(directory, "grant-key-ring.json");
const port = 39_000 + Math.floor(Math.random() * 500);
const origin = `https://localhost:${port}`;
const environment = {
  ...process.env,
  NODE_ENV: "test",
  QUADBALL_ENVIRONMENT: "test",
  PUBLIC_ORIGIN: origin,
  WEBAUTHN_RP_ID: "localhost",
  PORT: String(port),
  TECHNICAL_ADMIN_DATABASE: join(directory, "technical-admin.sqlite"),
  FOUNDATION_DATABASE: join(directory, "foundation.sqlite"),
  EVENT_GAME_DATABASE: join(directory, "event-game.sqlite"),
  AD_HOC_DATABASE: join(directory, "ad-hoc.sqlite"),
  TLS_CERT_FILE: certificatePath,
  TLS_KEY_FILE: keyPath,
  GRANT_KEY_RING_FILE: grantKeyRingPath,
};

let server: Bun.Subprocess | null = null;
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let currentProjection = createProjection();

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
  writeGrantKeyRingFile(grantKeyRingPath, createGrantKeyRingDocument("test"));
  server = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: process.cwd(),
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForServer(`${origin}/internal/healthz`);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await installControllerApi(context);
  const controller = await context.newPage();
  await completeSuspendReviewResume(controller);

  const secondContext = await browser.newContext({ ignoreHTTPSErrors: true });
  await installControllerApi(secondContext);
  const reviewingController = await secondContext.newPage();
  await reviewAndResume(reviewingController);

  console.log(
    "Focused Integration Test passed: 360x640 suspend/review/resume with two known balls.",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (server !== null) {
    server.kill("SIGTERM");
    const stderr = await new Response(server.stderr as unknown as BodyInit).text();
    if (stderr.trim() !== "") console.error(stderr.slice(-2_000));
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server !== null) {
    server.kill("SIGTERM");
    await server.exited;
  }
  rmSync(directory, { recursive: true, force: true });
}

async function completeSuspendReviewResume(page: Page) {
  page.setDefaultTimeout(5_000);
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto(`${origin}/event-control`);
  await page.getByLabel("Active Pitch Slot Control Grant QR").fill("disposable-grant");
  await page.getByRole("button", { name: "Open Controller Device" }).click();
  await page.getByRole("button", { name: "Review suspension recovery" }).click();
  await page.locator("#volleyball-possession").selectOption("side-a");
  await page.locator("#dodgeball-possession-ball-1").selectOption("side-b");
  await page.locator("#dodgeball-possession-ball-2").selectOption("side-a");
  await page.getByRole("button", { name: "Suspend with verified snapshot" }).click();
  const snapshot = page.locator('[data-suspension-snapshot="effective"]');
  await snapshot.waitFor();
  const snapshotText = await snapshot.innerText();
  assert(
    (await page.locator("[data-dodgeball-id]").count()) === 2,
    "configured ball set was incomplete",
  );
  assert(snapshotText.includes("ball-1=side-b"), "ball-1 recovery was not shown");
  assert(snapshotText.includes("ball-2=side-a"), "ball-2 recovery was not shown");
  await assertNoDocumentScroll(page);
}

async function reviewAndResume(page: Page) {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto(`${origin}/event-control`);
  await page.getByLabel("Active Pitch Slot Control Grant QR").fill("disposable-grant");
  await page.getByRole("button", { name: "Open Controller Device" }).click();
  await page.locator('[data-suspension-snapshot="effective"]').waitFor();
  const snapshotText = await page.locator('[data-suspension-snapshot="effective"]').innerText();
  assert(snapshotText.includes("Volleyball: side-a"), "volleyball recovery was not shown");
  assert(snapshotText.includes("ball-1=side-b"), "review missed ball-1");
  assert(snapshotText.includes("ball-2=side-a"), "review missed ball-2");
  const resumeResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/event-control/replay"),
  );
  await page.getByRole("button", { name: "Resume verified suspension" }).click();
  const resumed = (await (await resumeResponse).json()) as {
    projection?: { suspension?: { status?: string } };
  };
  assert(resumed.projection?.suspension?.status === "none", "resume did not clear suspension");
  await assertNoDocumentScroll(page);
}

async function installControllerApi(context: BrowserContext) {
  await context.route("**/api/event-control/**", async (route) => {
    const url = new URL(route.request().url());
    const body = route.request().postDataJSON() as Record<string, unknown> | null;
    if (url.pathname.endsWith("/open")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          status: "opened",
          eventGameId: "game-browser-focused",
          session: {
            sessionBearer: "bearer",
            grantSessionId: "session",
            grantVersion: "version",
          },
          projection: currentProjection,
          projectionStatus: "available",
        }),
      });
      return;
    }
    if (url.pathname.endsWith("/refresh")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          status: "authorized",
          session: {
            eventGameId: "game-browser-focused",
            grantSessionId: "session",
            grantVersion: "version",
          },
          projection: currentProjection,
          projectionStatus: "available",
        }),
      });
      return;
    }
    if (url.pathname.endsWith("/replay")) {
      const actions = Array.isArray(body?.actions) ? body.actions.filter(isRecord) : [];
      for (const action of actions) {
        const intent = isRecord(action.intent) ? action.intent : undefined;
        if (intent?.suspensionAction === "start") {
          const snapshot = intent.suspensionSnapshot as LiveSuspensionSnapshot;
          currentProjection = {
            ...currentProjection,
            phase: "suspended",
            suspension: { status: "suspended", factId: "fact-focused-suspension", snapshot },
            stoppage: { status: "suspension", factId: "fact-focused-suspension" },
          };
        } else if (intent?.suspensionAction === "resume") {
          currentProjection = {
            ...currentProjection,
            phase: "in-progress",
            suspension: { status: "none", factId: null, snapshot: null },
            stoppage: { status: "none", factId: null },
          };
        }
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          status: "synchronized",
          batchId: body?.batchId,
          replicaGeneration: body?.replicaGeneration,
          eventGameId: "game-browser-focused",
          session: {
            eventGameId: "game-browser-focused",
            grantSessionId: "session",
            grantVersion: "version",
          },
          outcomes: actions.flatMap((action) =>
            isRecord(action.intent) && typeof action.intent.operationId === "string"
              ? [{ operationId: action.intent.operationId, status: "accepted" as const }]
              : [],
          ),
          projection: currentProjection,
        }),
      });
      return;
    }
    if (url.pathname.endsWith("/intent")) {
      const intent = isRecord(body?.intent) ? body.intent : undefined;
      if (intent?.suspensionAction === "start") {
        const snapshot = intent.suspensionSnapshot as LiveSuspensionSnapshot;
        currentProjection = {
          ...currentProjection,
          phase: "suspended",
          suspension: { status: "suspended", factId: "fact-focused-suspension", snapshot },
          stoppage: { status: "suspension", factId: "fact-focused-suspension" },
        };
      } else if (intent?.suspensionAction === "resume") {
        currentProjection = {
          ...currentProjection,
          phase: "in-progress",
          suspension: { status: "none", factId: null, snapshot: null },
          stoppage: { status: "none", factId: null },
        };
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          status: "accepted",
          acknowledgement: { status: "acknowledged", operationId: intent?.operationId },
          projection: currentProjection,
          projectionStatus: "available",
          synchronization: { status: "synchronized", pendingCount: 0 },
          auditReference: { kind: "control", id: "audit-focused" },
        }),
      });
      return;
    }
    await route.fulfill({ status: 404, body: "not found" });
  });
}

async function assertNoDocumentScroll(page: Page) {
  const metrics = await page.evaluate(() => ({
    scrollTop: document.scrollingElement?.scrollTop ?? 0,
    scrollHeight: document.scrollingElement?.scrollHeight ?? 0,
    clientHeight: document.scrollingElement?.clientHeight ?? 0,
  }));
  assert(
    metrics.scrollTop === 0,
    `document was scrolled during the phone workflow (${JSON.stringify(metrics)})`,
  );
  assert(
    metrics.scrollHeight <= metrics.clientHeight,
    `document overflowed the viewport (${JSON.stringify(metrics)})`,
  );
}

function createProjection(): ControllerProjection {
  const baseline = createInitialClockBaseline();
  baseline.holderGrantSessionId = "session";
  baseline.holderGeneration = 1;
  baseline.authorityGeneration = 1;
  return {
    eventGameId: "game-browser-focused",
    phase: "in-progress",
    scoreByGameSide: { "side-a": 0, "side-b": 0 },
    goalCount: 0,
    knownDodgeballIds: ["ball-1", "ball-2"],
    penalties: {
      cards: [],
      players: [],
      pendingExpirations: [],
      releases: [],
    } satisfies LivePenaltyProjection,
    timeout: {
      status: "inactive",
      factId: null,
      gameSideId: null,
      usedGameSideIds: [],
      startedAtMs: null,
      remainingMs: null,
      longWhistleCue: "not-applicable",
    },
    suspension: { status: "none", factId: null, snapshot: null },
    stoppage: { status: "none", factId: null },
    heat: { status: "inactive", factId: null, startedAtGameTimeMs: null, nominalDurationMs: null },
    result: null,
    gameFacts: [],
    guardrails: [],
    commencement: {
      status: "commenced",
      commencedAtMs: 0,
      provisionalRunningSinceMs: null,
      provisionalElapsedMs: 0,
    },
    clock: projectClockBaseline(baseline, 0),
  };
}

async function waitForServer(url: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = Bun.spawnSync(["curl", "-k", "-sSf", "-H", `host: localhost:${port}`, url]);
    if (response.exitCode === 0) return;
    await Bun.sleep(50);
  }
  throw new Error("Focused browser server did not become ready.");
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
