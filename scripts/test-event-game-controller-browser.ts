#!/usr/bin/env bun
import { chromium, webkit, type BrowserContext, type Page } from "playwright";
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
let openCalls = 0;

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

  for (const browserType of [chromium, webkit]) {
    currentProjection = createProjection();
    browser = await browserType.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await installControllerApi(context);
    const controller = await context.newPage();
    await completeSuspendReviewResume(controller);
    await eventDepartureLifecycleEvidence(controller);

    const secondContext = await browser.newContext({ ignoreHTTPSErrors: true });
    await installControllerApi(secondContext);
    const reviewingController = await secondContext.newPage();
    await reviewAndResume(reviewingController);
    await browser.close();
    browser = null;
  }

  console.log(
    "Focused Integration Test passed: Chromium/WebKit 360x640 Controller interactions and suspend/review/resume.",
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
  await page.getByRole("button", { name: "Open Event Game Controller" }).click();
  await page.getByText("Controller Device: game-browser-focused").waitFor();
  await assertControllerSurface(page, "initial");
  await page.getByRole("button", { name: "Start game clock" }).click();
  await page.getByRole("button", { name: "Adjust game clock by plus 10 seconds" }).click();
  await page.getByLabel("Set game clock (milliseconds)").fill("123000");
  await page.getByRole("button", { name: "Correct Event Game clock" }).click();
  await page.locator("#penalty-game-side").selectOption("side-a");
  await page
    .getByRole("button", { name: "Accept penalty card for the selected Game Side" })
    .click();
  await page.getByRole("button", { name: "Timeout stoppage: side-a" }).click();
  await page.getByRole("button", { name: "Record 10-point goal for Game Side side-a" }).click();
  await page.getByRole("button", { name: "Flip Event Game physical ends" }).click();
  await page.getByRole("button", { name: "Reveal active Grant QR" }).click();
  await page.getByRole("dialog", { name: "Active Grant QR" }).waitFor();
  await page.mouse.click(2, 2);
  await page.getByRole("dialog", { name: "Active Grant QR" }).waitFor({ state: "hidden" });
  await page.waitForTimeout(50);
  assert(
    (await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))) ===
      "Show active Grant QR",
    "QR outside-pointer dismissal did not return focus",
  );
  await page.getByRole("button", { name: "Record final Event Game result" }).click();
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

async function eventDepartureLifecycleEvidence(page: Page) {
  const initialOpenCalls = openCalls;
  await page.getByRole("button", { name: "Leave Event Game Controller session" }).click();
  await page.getByRole("button", { name: "Leave game" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await page.getByRole("button", { name: "Return to game" }).click();
  await page.waitForURL((url) => url.pathname === "/event-control");
  await page.getByText("Controller Device: game-browser-focused").waitFor();
  await assertControllerSurface(page, "returned");

  // Admission into another Event Game must show the shared confirmation before
  // the Event open transport can mutate authority.
  await page.getByRole("button", { name: "Leave Event Game Controller session" }).click();
  await page.getByRole("button", { name: "Leave game" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await page.evaluate(() => {
    localStorage.removeItem("quadball:event-controller-session");
    sessionStorage.removeItem("quadball:event-controller-session");
  });
  await page.goto(`${origin}/event-control`);
  await page.getByLabel("Active Pitch Slot Control Grant QR").fill("replacement-grant");
  await page.getByRole("button", { name: "Open Event Game Controller" }).click();
  await page.getByRole("dialog", { name: "Leave the previous game?" }).waitFor();
  assert(openCalls === initialOpenCalls, "confirmation did not precede the Event admission seam");
  await page.getByRole("button", { name: "Cancel" }).click();
  assert(openCalls === initialOpenCalls, "cancel mutated Event admission");
  await page.getByRole("button", { name: "Open Event Game Controller" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  assert(openCalls === initialOpenCalls + 1, "confirmed Event admission did not reach transport");
  await page.getByText("Controller Device: game-browser-focused").waitFor();
  await assertControllerSurface(page, "replacement");

  // Event→Ad Hoc replacement must finalize the Event bearer before the new
  // Ad Hoc creation transport is allowed to run.
  await page.getByRole("button", { name: "Leave Event Game Controller session" }).click();
  await page.getByRole("button", { name: "Leave game" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  const replacementOrder: string[] = [];
  const recordReplacementRequest = (request: import("playwright").Request) => {
    if (request.method() !== "POST") return;
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("/leave")) replacementOrder.push("finalize");
    if (pathname === "/api/games") replacementOrder.push("create");
  };
  page.on("request", recordReplacementRequest);
  const startAdHoc = page.getByRole("button", { name: /Start an Ad Hoc Game/ });
  await startAdHoc.click();
  await page.getByRole("dialog", { name: "Leave the previous game?" }).waitFor();
  assert(
    replacementOrder.length === 0,
    "Event finalization started before replacement confirmation",
  );
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  assert(replacementOrder.length === 0, "Cancelling Event→Ad Hoc mutated transport");
  await startAdHoc.click();
  const createRequest = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/games",
  );
  await page.getByRole("dialog").getByRole("button", { name: "Continue" }).click();
  await createRequest;
  const createIndex = replacementOrder.indexOf("create");
  assert(
    createIndex > 0 &&
      replacementOrder.slice(0, createIndex).every((entry) => entry === "finalize"),
    `Event→Ad Hoc replacement order was ${replacementOrder.join(",")}`,
  );
  page.off("request", recordReplacementRequest);
}

async function assertControllerSurface(page: Page, label = "surface") {
  const controls = await page.locator("button").evaluateAll((buttons) =>
    buttons
      .map((button) => ({
        name: button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "",
        minHeight: Number.parseFloat(getComputedStyle(button).minHeight),
      }))
      .filter((control) => control.name.length > 0),
  );
  assert(
    controls.length > 15,
    `production Controller control inventory was unexpectedly small (${controls.length}) at ${page.url()} (${label})`,
  );
  for (const control of controls) {
    assert(control.minHeight >= 44, `Controller control was below 44px: ${control.name}`);
  }
  await page.getByRole("region", { name: "Event Game Clock" }).waitFor();
  await assertNoDocumentScroll(page);
}

async function reviewAndResume(page: Page) {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto(`${origin}/event-control`);
  await page.getByLabel("Active Pitch Slot Control Grant QR").fill("disposable-grant");
  await page.getByRole("button", { name: "Open Event Game Controller" }).click();
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
      openCalls += 1;
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
    if (url.pathname.endsWith("/reveal-qr")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ status: "revealed", qrCredential: "focused-revealed-qr" }),
      });
      return;
    }
    if (url.pathname.endsWith("/leave")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ status: "left" }),
      });
      return;
    }
    if (url.pathname.endsWith("/replay")) {
      const actions = Array.isArray(body?.actions) ? body.actions.filter(isRecord) : [];
      for (const action of actions) {
        const intent = isRecord(action.intent) ? action.intent : undefined;
        if (intent !== undefined) applyIntent(intent);
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
      if (intent !== undefined) applyIntent(intent);
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

function applyIntent(intent: Record<string, unknown>) {
  if (intent.type === "record-goal" && typeof intent.gameSideId === "string") {
    currentProjection = {
      ...currentProjection,
      goalCount: currentProjection.goalCount + 1,
      scoreByGameSide: {
        ...currentProjection.scoreByGameSide,
        [intent.gameSideId]: (currentProjection.scoreByGameSide[intent.gameSideId] ?? 0) + 10,
      },
    };
  }
  if (intent.type === "set-pitch-orientation" && typeof intent.pitchOrientation === "string") {
    currentProjection = {
      ...currentProjection,
      presentation: {
        ...(currentProjection.presentation ?? {
          gameSideIds: ["side-a", "side-b"],
          displayedTeamColors: { "side-a": "#00afe8", "side-b": "#ef4444" },
        }),
        pitchOrientation: intent.pitchOrientation as "side-a-left" | "side-b-left",
      },
    };
  }
  if (intent.type === "substantive" && intent.trigger === "result") {
    currentProjection = { ...currentProjection, phase: "finished" };
  }
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
    presentation: {
      gameSideIds: ["side-a", "side-b"],
      pitchOrientation: "side-a-left",
      displayedTeamColors: { "side-a": "#00afe8", "side-b": "#ef4444" },
    },
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
