#!/usr/bin/env bun
import { chromium, type Page } from "playwright";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAdHocGamesService,
  createSqliteAdHocRecoveryAdapter,
  openSqliteAdHocStore,
} from "@/lib/ad-hoc-games";
import { createGrantKeyRingDocument, writeGrantKeyRingFile } from "@/lib/grant-key-ring-custody";

let directory = "";
let certificatePath = "";
let keyPath = "";
let databasePath = "";
let grantKeyRingPath = "";
let port = 0;
let origin = "";
let environment: NodeJS.ProcessEnv = {};

let server: Bun.Subprocess | null = null;
let serverDrains: Promise<unknown>[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let setupProcess: Bun.Subprocess | null = null;

const lifecycleController = new AbortController();
const lifecycleTimer = setTimeout(() => lifecycleController.abort(), 52_000);

async function run() {
  directory = mkdtempSync(join(tmpdir(), "quadball-timer-adhoc-browser-"));
  certificatePath = join(directory, "test.timer.quadball.app.crt");
  keyPath = join(directory, "test.timer.quadball.app.key");
  databasePath = join(directory, "ad-hoc.sqlite");
  grantKeyRingPath = join(directory, "grant-key-ring.json");
  port = 39_000 + Math.floor(Math.random() * 1_000);
  origin = `https://test.timer.quadball.app:${port}`;
  environment = {
    ...process.env,
    NODE_ENV: "test",
    QUADBALL_ENVIRONMENT: "test",
    AD_HOC_ENVIRONMENT_ID: "adhoc-browser-test",
    AD_HOC_DATABASE: databasePath,
    PUBLIC_ORIGIN: origin,
    TECHNICAL_ADMIN_DATABASE: join(directory, "technical-admin.sqlite"),
    TLS_CERT_FILE: certificatePath,
    TLS_KEY_FILE: keyPath,
    GRANT_KEY_RING_FILE: grantKeyRingPath,
    HOST: "127.0.0.1",
    PORT: String(port),
  };

  let runError: unknown = null;
  let cleanupError: Error | null = null;
  try {
    setupProcess = Bun.spawn(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-subj",
        "/CN=test.timer.quadball.app",
        "-addext",
        "subjectAltName=DNS:test.timer.quadball.app",
        "-days",
        "1",
        "-keyout",
        keyPath,
        "-out",
        certificatePath,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    const certificateExit = await raceWithDeadline(setupProcess.exited, lifecycleController.signal);
    setupProcess = null;
    if (certificateExit !== 0) throw new Error("openssl could not create a certificate.");
    writeGrantKeyRingFile(grantKeyRingPath, createGrantKeyRingDocument("test"));

    await raceWithDeadline(startServer(), lifecycleController.signal);
    browser = await raceWithDeadline(
      chromium.launch({
        headless: true,
        args: ["--host-resolver-rules=MAP test.timer.quadball.app 127.0.0.1"],
      }),
      lifecycleController.signal,
    );
    await raceWithDeadline(
      (async () => {
        let firstContext = await browser!.newContext({ ignoreHTTPSErrors: true });
        let secondContext = await browser!.newContext({ ignoreHTTPSErrors: true });
        let first = await firstContext.newPage();
        let second = await secondContext.newPage();
        first.setDefaultTimeout(15_000);
        second.setDefaultTimeout(15_000);

        await first.addInitScript(() => {
          const evidence = { sawBusy: false, sawOffline: false, sawInitialQrFocus: false };
          const inspect = () => {
            const text = document.body?.textContent ?? "";
            evidence.sawBusy ||= /Ad Hoc connection busy/u.test(text);
            evidence.sawOffline ||= /\bOffline(?:\s+\d+)?\b/u.test(text);
          };
          const install = () => {
            const observer = new MutationObserver(inspect);
            observer.observe(document.body, {
              childList: true,
              characterData: true,
              subtree: true,
            });
            inspect();
          };
          document.addEventListener("focusin", (event) => {
            if (
              event.target instanceof HTMLElement &&
              event.target.getAttribute("aria-label") === "Show Ad Hoc Control QR"
            ) {
              evidence.sawInitialQrFocus = true;
            }
          });
          if (document.body === null) {
            document.addEventListener("DOMContentLoaded", install, { once: true });
          } else {
            install();
          }
          (
            window as typeof window & {
              __quadballTimerInitialAdHocConnectionEvidence?: typeof evidence;
            }
          ).__quadballTimerInitialAdHocConnectionEvidence = evidence;
        });
        await first.goto(origin);
        await first.getByRole("button", { name: /Start an Ad Hoc Game/ }).click();
        await first.waitForURL(/\/game\/adhoc-/u);
        await waitForHealthyControllerHeader(first);
        const initialConnectionEvidence = await first.evaluate(() => {
          const evidence = (
            window as typeof window & {
              __quadballTimerInitialAdHocConnectionEvidence?: {
                sawBusy: boolean;
                sawOffline: boolean;
                sawInitialQrFocus: boolean;
              };
            }
          ).__quadballTimerInitialAdHocConnectionEvidence;
          if (evidence === undefined)
            throw new Error("Initial connection evidence was unavailable.");
          return evidence;
        });
        if (initialConnectionEvidence.sawBusy || initialConnectionEvidence.sawOffline) {
          throw new Error("Newly created Test-shaped Ad Hoc Game did not reach Live cleanly.");
        }
        if (initialConnectionEvidence.sawInitialQrFocus) {
          throw new Error("Ad Hoc Control QR trigger received focus during initial page load.");
        }
        await assertAccessibleQr(first, "creator");

        const gameId = new URL(first.url()).pathname.split("/").at(-1);
        if (gameId === undefined) throw new Error("Game route did not contain a Game ID.");
        for (let index = 0; index < 4; index += 1) {
          await first.goto(origin);
          await first.getByRole("button", { name: /Start an Ad Hoc Game/ }).click();
          await first.waitForURL(/\/game\/adhoc-/u);
        }
        await first.goto(origin);
        await first.getByRole("button", { name: /Start an Ad Hoc Game/ }).click();
        await first
          .getByRole("status")
          .filter({ hasText: /Retrying in/u })
          .waitFor();
        await first.waitForURL(/\/game\/adhoc-/u);
        const creationRetryGameId = new URL(first.url()).pathname.split("/").at(-1);
        if (creationRetryGameId === undefined)
          throw new Error("Rendered creation retry did not navigate to a Game.");
        await first.goto(`${origin}/game/${gameId}`);
        await waitForGameRoute(first, gameId);
        const replayRetryEvidence = await first.evaluate(async (id) => {
          const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
          const ws = new WebSocket(wsUrl);
          const messages: unknown[] = [];
          let notify: (() => void) | null = null;
          ws.onmessage = (event) => {
            messages.push(JSON.parse(String(event.data)) as unknown);
            notify?.();
          };
          const nextMessage = async () => {
            while (messages.length === 0) await new Promise<void>((resolve) => (notify = resolve));
            notify = null;
            return messages.shift() as {
              type?: string;
              retryAfterMs?: number;
              ackedCommandIds?: string[];
            };
          };
          await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error("Replay evidence WebSocket failed to open."));
          });
          ws.send(JSON.stringify({ type: "subscribe-game", gameId: id }));
          while ((await nextMessage()).type !== "game-snapshot") {}
          const batch = Array.from({ length: 100 }, (_, index) => ({
            id: `browser-replay-${index}`,
            clientSentAtMs: Date.now(),
            command: { type: "set-running", running: index % 2 === 0 },
          }));
          ws.send(JSON.stringify({ type: "apply-commands", gameId: id, commands: batch }));
          let acknowledged = false;
          for (;;) {
            const message = await nextMessage();
            if (message.type === "game-snapshot") {
              acknowledged = message.ackedCommandIds?.includes("browser-replay-99") ?? false;
              if (acknowledged) break;
            }
          }
          ws.close();
          if (!acknowledged) throw new Error("Scheduled replay was not eventually acknowledged.");
          return { batchSize: batch.length };
        }, creationRetryGameId);
        if (replayRetryEvidence.batchSize !== 100)
          throw new Error("Browser replay evidence did not use the full batch envelope.");
        const snapshot = (await first.evaluate(async (id) => {
          const response = await fetch(`/api/games/${id}`);
          return (await response.json()) as { game?: { controlQr?: string | null } };
        }, gameId)) as { game?: { controlQr?: string | null } };
        const controlQr = snapshot.game?.controlQr;
        if (typeof controlQr !== "string") throw new Error("Ad Hoc Control QR was not authorized.");

        const handoffUrl = `${origin}/#adhoc-game=${encodeURIComponent(gameId)}&adhoc-control=${encodeURIComponent(controlQr)}`;
        await second.goto(handoffUrl);
        await waitForGameRoute(second, gameId);
        await assertAccessibleQr(second, "second browser");

        await second.getByRole("button", { name: "Start game" }).click();
        await first.getByText("Running", { exact: true }).waitFor();
        await stopServer();
        await second.getByRole("button", { name: "Pause game" }).click();
        await second.getByRole("button", { name: "Start game" }).click();
        await second.getByText(/Offline · 2 queued actions/u).waitFor();
        await startServer();
        await waitForHealthyControllerHeader(second);
        await first.getByText("Running", { exact: true }).waitFor();
        await second.getByRole("button", { name: "Pause game" }).click();
        await second.getByRole("button", { name: "Game end" }).click();
        await second.getByRole("button", { name: "Double forfeit" }).click();
        await second.getByText("Finished", { exact: true }).waitFor();
        await first.waitForFunction(
          () =>
            document.querySelector('button[aria-label="Show Ad Hoc Control QR"]') === null &&
            !document.body.textContent?.includes("Share Ad Hoc Control"),
        );
        await second.getByRole("button", { name: "Correct back to unfinished" }).click();
        await waitForUnfinishedGame(second, gameId);

        const secondStorageState = await secondContext.storageState();
        await secondContext.close();
        await stopServer();
        await startServer();

        await first.reload();
        await waitForGameRoute(first, gameId);
        await first.getByText("Paused", { exact: true }).waitFor();
        secondContext = await browser.newContext({
          ignoreHTTPSErrors: true,
          storageState: secondStorageState,
        });
        second = await secondContext.newPage();
        second.setDefaultTimeout(15_000);
        await second.goto(`${origin}/game/${gameId}`);
        await waitForGameRoute(second, gameId);
        await second.getByText("Paused", { exact: true }).waitFor();
        await assertAccessibleQr(second, "recreated second browser after restart");

        const recoverySnapshotPath = join(directory, "ad-hoc-recovery.snapshot.sqlite");
        const recoveryAdapter = createSqliteAdHocRecoveryAdapter(
          databasePath,
          "adhoc-browser-test",
        );
        await recoveryAdapter.createRecoveryVacuumSnapshot(recoverySnapshotPath);
        await stopServer();
        await secondContext.setOffline(true);
        await second.getByRole("button", { name: "Start game" }).click();
        await second.getByText(/Offline · 1 queued action/u).waitFor();
        replaceAdHocDatabaseFromSnapshot(recoverySnapshotPath);
        await startServer();
        await first.reload();
        await waitForGameRoute(first, gameId);
        await first.waitForFunction(async (id) => {
          const response = await fetch(`/api/games/${id}`);
          if (!response.ok) return false;
          const payload = (await response.json()) as {
            game?: { state?: { isRunning?: unknown } };
          };
          return payload.game?.state?.isRunning === false;
        }, gameId);
        const restoredServerState = await first.evaluate(async (id) => {
          const response = await fetch(`/api/games/${id}`);
          return (await response.json()) as { game?: { state?: { isRunning?: boolean } } };
        }, gameId);
        if (restoredServerState.game?.state?.isRunning !== false) {
          throw new Error("Restored server state was silently overwritten by newer local state.");
        }
        await second.getByText(/Offline · 1 queued action/u).waitFor();
        await secondContext.setOffline(false);
        await second.reload();
        await waitForGameRoute(second, gameId);
        await waitForHealthyControllerHeader(second);
        await first.getByText("Running", { exact: true }).waitFor();
        await second.getByRole("button", { name: "Pause game" }).click();
        await first.getByText("Paused", { exact: true }).waitFor();

        await second.getByRole("button", { name: "Start game" }).click();
        await first.getByText("Running", { exact: true }).waitFor();
        await second.getByRole("button", { name: "Pause game" }).click();
        const leaveButton = second.getByRole("button", { name: "Leave Ad Hoc Game Controller" });
        await leaveButton.click();
        await second.getByRole("dialog").waitFor();
        await second.getByRole("dialog").press("Escape");
        await second.waitForFunction(() => document.activeElement?.textContent?.includes("Leave"));
        await leaveButton.click();
        await second.getByRole("dialog").getByRole("button", { name: "Stay in game" }).click();
        await second.waitForFunction(() => document.activeElement?.textContent?.includes("Leave"));
        await leaveButton.click();
        const leaveDialog = second.getByRole("dialog");
        await leaveDialog.locator("..").click({ position: { x: 1, y: 1 } });
        await second.waitForFunction(() => document.activeElement?.textContent?.includes("Leave"));
        await leaveButton.click();
        await second.getByRole("dialog").getByRole("button", { name: "Leave game" }).click();
        if (new URL(second.url()).pathname !== "/") await second.waitForURL(`${origin}/`);

        const postLeaveStorageState = await secondContext.storageState();
        await second.goto(origin);
        await second.getByRole("button", { name: "Return to game" }).click();
        await waitForGameRoute(second, gameId);
        await first.getByText("Paused", { exact: true }).waitFor();

        // An Ad Hoc returnable session must use the same shared replacement
        // confirmation before an Event admission transport is touched.
        await second.getByRole("button", { name: "Leave Ad Hoc Game Controller" }).click();
        await second.getByRole("dialog").getByRole("button", { name: "Leave game" }).click();
        await second.waitForURL(`${origin}/`);
        let eventOpenCalls = 0;
        const eventReplacementOrder: string[] = [];
        const recordEventOpen = (request: import("playwright").Request) => {
          if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/leave"))
            eventReplacementOrder.push("finalize");
          if (
            request.method() === "POST" &&
            new URL(request.url()).pathname.endsWith("/event-control/open")
          ) {
            eventOpenCalls += 1;
            eventReplacementOrder.push("admit");
          }
        };
        second.on("request", recordEventOpen);
        await second.goto(`${origin}/event-control`);
        await second.getByLabel("Active Pitch Slot Control Grant QR").fill("event-replacement");
        await second.getByRole("button", { name: "Open Event Game Controller" }).click();
        await second.getByRole("dialog", { name: "Leave the previous game?" }).waitFor();
        if (eventOpenCalls !== 0)
          throw new Error("Event admission started before the Ad Hoc replacement confirmation.");
        await second.getByRole("button", { name: "Cancel" }).click();
        if (eventOpenCalls !== 0)
          throw new Error("Cancelling Ad Hoc→Event mutated Event admission.");
        await second.getByRole("button", { name: "Open Event Game Controller" }).click();
        const eventAdmissionRequest = second.waitForRequest(
          (request) =>
            request.method() === "POST" &&
            new URL(request.url()).pathname.endsWith("/event-control/open"),
        );
        await second.getByRole("button", { name: "Continue" }).click();
        await eventAdmissionRequest;
        const eventAdmissionIndex = eventReplacementOrder.indexOf("admit");
        if (
          eventAdmissionIndex <= 0 ||
          eventReplacementOrder.slice(0, eventAdmissionIndex).some((entry) => entry !== "finalize")
        )
          throw new Error(`Ad Hoc→Event replacement order was ${eventReplacementOrder.join(",")}.`);
        second.off("request", recordEventOpen);

        const creationContext = await browser!.newContext({
          ignoreHTTPSErrors: true,
          storageState: postLeaveStorageState,
        });
        const creationPage = await creationContext.newPage();
        creationPage.setDefaultTimeout(15_000);
        const creationOrder: string[] = [];
        creationPage.on("request", (request) => {
          if (request.method() !== "POST") return;
          const pathname = new URL(request.url()).pathname;
          if (pathname === "/api/games") creationOrder.push("create");
          if (pathname.endsWith("/leave")) creationOrder.push("finalize");
        });
        await creationPage.goto(origin);
        const startButton = creationPage.getByRole("button", { name: /Start an Ad Hoc Game/ });
        await startButton.click();
        await creationPage.getByRole("dialog").waitFor();
        if (creationOrder.length !== 0)
          throw new Error(
            "Ad Hoc creation or finalization started before replacement confirmation.",
          );
        await creationPage.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
        await creationPage.waitForFunction(() =>
          document.activeElement?.textContent?.includes("Start an Ad Hoc Game"),
        );
        await startButton.click();
        await creationPage.getByRole("dialog").getByRole("button", { name: "Continue" }).click();
        try {
          await creationPage.waitForURL(/\/game\/adhoc-/u);
        } catch (error) {
          throw new Error(
            `Creation did not navigate; order=${creationOrder.join(",")}; url=${creationPage.url()}; text=${(await creationPage.locator("body").textContent()) ?? ""}; cause=${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const creationIndex = creationOrder.indexOf("create");
        if (
          creationIndex <= 0 ||
          creationOrder.slice(0, creationIndex).some((entry) => entry !== "finalize")
        )
          throw new Error(`Ad Hoc creation order was ${creationOrder.join(",")}.`);
        await creationPage.getByRole("button", { name: "Leave Ad Hoc Game Controller" }).click();
        await creationPage.getByRole("dialog").getByRole("button", { name: "Leave game" }).click();
        await creationPage.waitForURL(`${origin}/`);
        const admissionStorageState = await creationContext.storageState();
        await creationContext.close();

        const alternateSnapshot = await first.evaluate(async (id) => {
          const response = await fetch(`/api/games/${id}`);
          return (await response.json()) as { game?: { controlQr?: string | null } };
        }, creationRetryGameId);
        const alternateQr = alternateSnapshot.game?.controlQr;
        if (typeof alternateQr !== "string")
          throw new Error("Alternate Ad Hoc handoff QR was unavailable.");
        const admissionContext = await browser!.newContext({
          ignoreHTTPSErrors: true,
          storageState: admissionStorageState,
        });
        const admissionPage = await admissionContext.newPage();
        admissionPage.setDefaultTimeout(15_000);
        const admissionOrder: string[] = [];
        admissionPage.on("request", (request) => {
          if (request.method() !== "POST") return;
          const pathname = new URL(request.url()).pathname;
          if (pathname.endsWith("/admit")) admissionOrder.push("admit");
          if (pathname.endsWith("/leave")) admissionOrder.push("finalize");
        });
        await admissionPage.goto(
          `${origin}/#adhoc-game=${encodeURIComponent(creationRetryGameId)}&adhoc-control=${encodeURIComponent(alternateQr)}`,
        );
        await admissionPage.getByRole("dialog").waitFor();
        if (admissionOrder.length !== 0)
          throw new Error("Ad Hoc admission started before replacement confirmation.");
        await admissionPage.getByRole("dialog").getByRole("button", { name: "Continue" }).click();
        try {
          await waitForGameRoute(admissionPage, creationRetryGameId);
        } catch (error) {
          throw new Error(
            `Admission did not navigate; order=${admissionOrder.join(",")}; url=${admissionPage.url()}; text=${(await admissionPage.locator("body").textContent()) ?? ""}; cause=${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const admissionIndex = admissionOrder.indexOf("admit");
        if (
          admissionIndex <= 0 ||
          admissionOrder.slice(0, admissionIndex).some((entry) => entry !== "finalize")
        )
          throw new Error(`Ad Hoc admission order was ${admissionOrder.join(",")}.`);
        await admissionContext.close();

        environment.AD_HOC_MAX_CONNECTED_SOCKETS = "1";
        await stopServer();
        await startServer();
        await first.reload();
        await waitForGameRoute(first, gameId);
        await waitForHealthyControllerHeader(first);
        await first.waitForTimeout(250);
        const retryContext = await browser!.newContext({
          ignoreHTTPSErrors: true,
          storageState: secondStorageState,
        });
        const retryPage = await retryContext.newPage();
        retryPage.setDefaultTimeout(15_000);
        await retryPage.goto(handoffUrl);
        await waitForGameRoute(retryPage, gameId);
        const busyWarning = retryPage.locator('[data-controller-warning="true"]');
        await busyWarning.waitFor();
        const busyWarningText = (await busyWarning.textContent()) ?? "";
        if (
          !busyWarningText.includes("Offline") ||
          !busyWarningText.includes("Ad Hoc connection busy")
        ) {
          throw new Error(
            `Busy retry was not composed into the shared warning: ${busyWarningText}`,
          );
        }
        if (
          (await retryPage
            .locator('p[role="status"]')
            .filter({ hasText: /Ad Hoc connection busy/u })
            .count()) !== 0
        ) {
          throw new Error("Busy retry rendered a duplicate Ad Hoc connection status.");
        }
        await first.close();
        await waitForHealthyControllerHeader(retryPage);

        await stopServer();
        rmSync(databasePath, { force: true });
        await startServer();
        await retryPage.reload();
        await waitForGameRoute(retryPage, gameId);
        await retryPage.locator('[data-controller-warning="true"]').waitFor();
        await retryPage
          .getByText("Server does not know this game", { exact: false })
          .first()
          .waitFor();
        await retryContext.close();
        await secondContext.close();

        const setupContext = await browser!.newContext({ ignoreHTTPSErrors: true });
        const setup = await setupContext.newPage();
        setup.setDefaultTimeout(15_000);
        await setup.goto(`${origin}/events?view=all`);
        await setup.getByRole("button", { name: /Start an Ad Hoc Game/ }).click();
        await setup.waitForURL(/\/game\/adhoc-/u);
        const victimGameId = new URL(setup.url()).pathname.split("/").at(-1);
        if (victimGameId === undefined)
          throw new Error("Victim Game route did not contain a Game ID.");
        await setup.getByRole("button", { name: "Start game" }).click();
        await setup.getByText("Running", { exact: true }).waitFor();
        const victimStorageState = await setupContext.storageState();
        await setupContext.close();

        await stopServer();
        await seedAdditionalCapacity(victimGameId, 49);
        await startServer();
        const prunerContext = await browser!.newContext({ ignoreHTTPSErrors: true });
        const pruner = await prunerContext.newPage();
        pruner.setDefaultTimeout(15_000);
        await pruner.goto(`${origin}/events?view=all`);
        await pruner.getByRole("button", { name: /Start an Ad Hoc Game/ }).click();
        await pruner.waitForURL(/\/game\/adhoc-/u);
        await prunerContext.close();

        const victimContext = await browser!.newContext({
          ignoreHTTPSErrors: true,
          storageState: victimStorageState,
        });
        const victim = await victimContext.newPage();
        victim.setDefaultTimeout(15_000);
        await victim.goto(`${origin}/game/${victimGameId}`);
        await waitForGameRoute(victim, victimGameId);
        await victim.locator('[data-controller-warning="true"]').waitFor();
        await victim
          .getByText("Server does not know this game", { exact: false })
          .first()
          .waitFor();
        const removedProbe = await victim.evaluate(async (id) => {
          const response = await fetch(`/api/games/${id}`);
          return { status: response.status, url: location.pathname };
        }, victimGameId);
        if (removedProbe.status !== 404 || removedProbe.url !== `/game/${victimGameId}`) {
          throw new Error("Pruned Ad Hoc Game was silently recreated or recovered.");
        }
        await victim.reload();
        await waitForGameRoute(victim, victimGameId);
        await victim.locator('[data-controller-warning="true"]').waitFor();
        await victim
          .getByText("Server does not know this game", { exact: false })
          .first()
          .waitFor();
        await victimContext.close();

        await stopServer();
        await seedCapacity(true);
        await startServer();
        const capacityContext = await browser!.newContext({ ignoreHTTPSErrors: true });
        const capacityPage = await capacityContext.newPage();
        capacityPage.setDefaultTimeout(15_000);
        await capacityPage.goto(`${origin}/events?view=all`);
        await capacityPage.getByRole("button", { name: /Start an Ad Hoc Game/ }).click();
        await capacityPage.getByRole("alert").waitFor();
        await capacityPage
          .getByRole("alert")
          .getByText("Ad Hoc capacity is currently full; no game was changed.", { exact: true })
          .waitFor();
        await capacityContext.close();
      })(),
      lifecycleController.signal,
    );
  } catch (error) {
    runError = error;
  } finally {
    if (setupProcess !== null) {
      try {
        await terminateChild(setupProcess);
      } catch (error) {
        cleanupError = asError(error, "OpenSSL cleanup failed.");
      }
      setupProcess = null;
    }
    if (browser !== null) {
      const activeBrowser = browser;
      const closed = await Promise.race([
        activeBrowser.close().then(() => true),
        Bun.sleep(2_000).then(() => false),
      ]);
      if (!closed || activeBrowser.isConnected()) {
        cleanupError ??= new Error("Browser cleanup did not complete within its deadline.");
      }
      browser = null;
    }
    try {
      await stopServer();
    } catch (error) {
      cleanupError ??= asError(error, "Server cleanup failed.");
    }
    rmSync(directory, { recursive: true, force: true });
  }
  if (cleanupError !== null) throw cleanupError;
  if (runError !== null) throw runError;
}

try {
  await run();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  clearTimeout(lifecycleTimer);
}

function raceWithDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    return Promise.reject(new Error("Ad Hoc browser test exceeded 52 second work deadline."));
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("Ad Hoc browser test exceeded 52 second work deadline.")),
        { once: true },
      );
    }),
  ]);
}

async function startServer() {
  if (server !== null) throw new Error("Ad Hoc browser server is already running.");
  const child = Bun.spawn([process.execPath, "run", "src/index.ts"], {
    cwd: process.cwd(),
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  server = child;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let output = "";
  const stdoutDrain = drainBounded(child.stdout, 64 * 1024, (chunk) => {
    output += new TextDecoder().decode(chunk, { stream: true });
    const match = output.match(/Server running at https?:\/\/[^\s]+/u);
    if (
      match !== null &&
      new URL(match[0].replace("Server running at ", "")).port === String(port)
    ) {
      resolveReady();
    }
  }).catch((error) => {
    rejectReady(error instanceof Error ? error : new Error("server output failed"));
    throw error;
  });
  const stderrDrain = drainBounded(child.stderr, 64 * 1024);
  serverDrains = [stdoutDrain, stderrDrain];
  await Promise.race([
    ready,
    child.exited.then(() => {
      throw new Error("Ad Hoc browser server exited before readiness.");
    }),
  ]);
  await waitForServer();
}

async function stopServer() {
  const child = server;
  if (child === null) return;
  server = null;
  child.kill("SIGTERM");
  let exited = await waitForExit(child, 2_000);
  if (!exited) {
    child.kill("SIGKILL");
    exited = await waitForExit(child, 1_000);
  }
  await Promise.race([Promise.allSettled(serverDrains), Bun.sleep(500)]);
  serverDrains = [];
  if (!exited) throw new Error("Ad Hoc browser server did not exit after SIGKILL.");
}

async function terminateChild(child: Bun.Subprocess) {
  child.kill("SIGTERM");
  if (await waitForExit(child, 250)) return;
  child.kill("SIGKILL");
  if (!(await waitForExit(child, 1_000))) {
    throw new Error("OpenSSL did not exit after SIGKILL.");
  }
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

async function waitForExit(child: Bun.Subprocess, timeoutMs: number) {
  return await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(timeoutMs).then(() => false),
  ]);
}

async function drainBounded(
  stream: ReadableStream<Uint8Array> | number | undefined,
  limit: number,
  onChunk?: (chunk: Uint8Array) => void,
) {
  if (stream === undefined || typeof stream === "number")
    throw new Error("server output unavailable");
  const reader = stream.getReader();
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return;
    onChunk?.(chunk.value);
    length += chunk.value.byteLength;
    if (length > limit) throw new Error("server output exceeded cap");
  }
}

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = Bun.spawnSync([
      "curl",
      "-k",
      "-sSf",
      "-H",
      `host: localhost:${port}`,
      `https://127.0.0.1:${port}/internal/healthz`,
    ]);
    if (response.exitCode === 0) return;
    await Bun.sleep(50);
  }
  throw new Error("Ad Hoc browser server did not become ready.");
}

async function waitForGameRoute(page: Page, gameId: string) {
  if (page.url() !== `${origin}/game/${gameId}`) await page.waitForURL(`${origin}/game/${gameId}`);
}

async function waitForHealthyControllerHeader(page: Page) {
  const header = page.getByRole("region", { name: "Controller header" });
  await header.waitFor();
  await page.waitForFunction(() => document.querySelector("[data-controller-warning]") === null);
}

async function assertAccessibleQr(page: Page, stage: string) {
  try {
    const viewport = stage.includes("second")
      ? { width: 412, height: 915 }
      : { width: 390, height: 844 };
    await page.setViewportSize(viewport);
    const trigger = page.getByRole("button", { name: "Show Ad Hoc Control QR" });
    const leave = page.getByRole("button", { name: "Leave Ad Hoc Game Controller" });
    const triggerBox = await trigger.boundingBox();
    const leaveBox = await leave.boundingBox();
    if (triggerBox === null || leaveBox === null)
      throw new Error("header controls were not laid out");
    if (triggerBox.width < 44 || triggerBox.height < 44) throw new Error("QR target was too small");
    if (leaveBox.width < 44 || leaveBox.height < 44) throw new Error("Leave target was too small");
    if (Math.abs(triggerBox.x + triggerBox.width - leaveBox.x) < 8)
      throw new Error("QR and Leave controls were directly adjacent");
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Ad Hoc Control QR dialog" });
    if ((await dialog.getAttribute("aria-modal")) !== "true")
      throw new Error("dialog is not modal");
    const close = dialog.getByRole("button", { name: "Close Control QR" });
    if (!(await close.evaluate((element) => element === document.activeElement))) {
      throw new Error("dialog did not focus its close control");
    }
    await page.keyboard.press("Tab");
    if (!(await close.evaluate((element) => element === document.activeElement))) {
      throw new Error("dialog did not contain Tab focus");
    }
    await page.keyboard.press("Escape");
    await trigger.waitFor();
    await page.waitForFunction(
      () =>
        document.activeElement?.tagName === "BUTTON" &&
        document.activeElement?.getAttribute("aria-label") === "Show Ad Hoc Control QR",
    );
    if (!(await trigger.evaluate((element) => element === document.activeElement))) {
      throw new Error("Escape did not restore focus to the QR trigger");
    }
    await trigger.click();
    await page.getByAltText("Ad Hoc Control QR code").waitFor();
    await close.click();
    await trigger.waitFor();
    await page.waitForFunction(
      () =>
        document.activeElement?.tagName === "BUTTON" &&
        document.activeElement?.getAttribute("aria-label") === "Show Ad Hoc Control QR",
    );
    if (!(await trigger.evaluate((element) => element === document.activeElement))) {
      throw new Error("Close did not restore focus to the QR trigger");
    }
  } catch (error) {
    throw new Error(
      `${stage} QR display failed at ${page.url()}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function waitForUnfinishedGame(page: Page, gameId: string) {
  await page.waitForFunction(async (id) => {
    const response = await fetch(`/api/games/${id}`);
    if (!response.ok) return false;
    const payload = (await response.json()) as {
      game?: { controlQr?: unknown; state?: { isFinished?: unknown } };
    };
    return payload.game?.state?.isFinished === false && typeof payload.game.controlQr === "string";
  }, gameId);
}

function replaceAdHocDatabaseFromSnapshot(snapshotPath: string) {
  for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
    rmSync(sidecar, { force: true });
  }
  if (!existsSync(snapshotPath)) throw new Error("Ad Hoc recovery snapshot was not created.");
  copyFileSync(snapshotPath, databasePath);
}

async function seedCapacity(connected: boolean) {
  rmSync(databasePath, { force: true });
  let seedNowMs = Date.now() - 102 * 60 * 60_000;
  const store = openSqliteAdHocStore(databasePath, "adhoc-browser-test");
  const games = createAdHocGamesService({
    store,
    environmentIdentity: "adhoc-browser-test",
    now: () => seedNowMs,
  });
  try {
    for (let index = 0; index < 50; index += 1) {
      seedNowMs += 2 * 60 * 60_000;
      const result = await games.create({
        homeName: `Seed ${index}`,
        awayName: "Away",
        sourceKey: `browser-seed-${index}`,
        nowMs: seedNowMs,
      });
      if (result.status !== "accepted") throw new Error("browser capacity seed failed");
    }
  } finally {
    games.close();
  }

  if (!connected) return;
  const database = new Database(databasePath, { create: false, strict: true });
  try {
    const rows = database.query("SELECT game_id, sessions_json FROM adhoc_games").all() as {
      game_id: string;
      sessions_json: string;
    }[];
    for (const row of rows) {
      const sessions = JSON.parse(row.sessions_json) as {
        connected: boolean;
        lastConnectedAtMs: number;
        lastDisconnectedAtMs: number | null;
      }[];
      for (const session of sessions) {
        session.connected = true;
        session.lastConnectedAtMs = Date.now();
        session.lastDisconnectedAtMs = null;
      }
      database.run("UPDATE adhoc_games SET sessions_json = ? WHERE game_id = ?", [
        JSON.stringify(sessions),
        row.game_id,
      ]);
    }
  } finally {
    database.close();
  }
}

async function seedAdditionalCapacity(victimGameId: string, count: number) {
  const seedStartMs = Date.now() - 100 * 60 * 60_000;
  const store = openSqliteAdHocStore(databasePath, "adhoc-browser-test");
  const games = createAdHocGamesService({
    store,
    environmentIdentity: "adhoc-browser-test",
    now: () => seedStartMs,
  });
  try {
    for (let index = 0; index < count; index += 1) {
      const nowMs = seedStartMs + index * 2 * 60 * 60_000;
      const result = await games.create({
        homeName: `Additional seed ${index}`,
        awayName: "Away",
        sourceKey: `browser-additional-seed-${index}`,
        nowMs,
      });
      if (result.status !== "accepted") throw new Error("browser additional capacity seed failed");
    }
  } finally {
    games.close();
  }

  const database = new Database(databasePath, { create: false, strict: true });
  try {
    const row = database
      .query("SELECT sessions_json FROM adhoc_games WHERE game_id = ?")
      .get(victimGameId) as { sessions_json: string } | null;
    if (row === null) throw new Error("victim Game was not retained during capacity setup");
    const sessions = JSON.parse(row.sessions_json) as {
      connected: boolean;
      lastDisconnectedAtMs: number | null;
    }[];
    for (const session of sessions) {
      session.connected = false;
      session.lastDisconnectedAtMs = seedStartMs - 2 * 60 * 60_000;
    }
    database.run("UPDATE adhoc_games SET created_at_ms = ?, sessions_json = ? WHERE game_id = ?", [
      seedStartMs - 2 * 60 * 60_000,
      JSON.stringify(sessions),
      victimGameId,
    ]);
  } finally {
    database.close();
  }
}
