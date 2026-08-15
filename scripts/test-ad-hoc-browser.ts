#!/usr/bin/env bun
import { chromium, type Page } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let directory = "";
let certificatePath = "";
let keyPath = "";
let databasePath = "";
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
  certificatePath = join(directory, "localhost.crt");
  keyPath = join(directory, "localhost.key");
  databasePath = join(directory, "ad-hoc.sqlite");
  port = 39_000 + Math.floor(Math.random() * 1_000);
  origin = `https://localhost:${port}`;
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
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
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

    await raceWithDeadline(startServer(), lifecycleController.signal);
    browser = await raceWithDeadline(
      chromium.launch({ headless: true }),
      lifecycleController.signal,
    );
    await raceWithDeadline(
      (async () => {
        const firstContext = await browser!.newContext({ ignoreHTTPSErrors: true });
        let secondContext = await browser!.newContext({ ignoreHTTPSErrors: true });
        const first = await firstContext.newPage();
        let second = await secondContext.newPage();
        first.setDefaultTimeout(15_000);
        second.setDefaultTimeout(15_000);

        await first.goto(origin);
        await first.getByRole("button", { name: /Start an Ad Hoc Game/ }).click();
        await first.waitForURL(/\/game\/adhoc-/u);
        await assertAccessibleQr(first, "creator");

        const gameId = new URL(first.url()).pathname.split("/").at(-1);
        if (gameId === undefined) throw new Error("Game route did not contain a Game ID.");
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
        await second.getByText(/Offline 2/u).waitFor();
        await startServer();
        await second.getByText("Live", { exact: true }).waitFor();
        await first.getByText("Running", { exact: true }).waitFor();
        await second.getByRole("button", { name: "Pause game" }).click();
        await second.getByRole("button", { name: "Game end" }).click();
        await second.getByRole("button", { name: "Double forfeit" }).click();
        await second.getByText("Finished", { exact: true }).waitFor();
        await first.getByText("new admission is paused.", { exact: false }).waitFor();
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

        await second.getByRole("button", { name: "Start game" }).click();
        await first.getByText("Running", { exact: true }).waitFor();
        await second.getByRole("button", { name: "Pause game" }).click();
        await second.getByRole("button", { name: "Leave", exact: true }).click();
        if (new URL(second.url()).pathname !== "/") await second.waitForURL(`${origin}/`);
        await first.getByText("Paused", { exact: true }).waitFor();

        await second.goto(handoffUrl);
        await waitForGameRoute(second, gameId);
        await assertAccessibleQr(second, "readmitted second browser");

        await stopServer();
        rmSync(databasePath, { force: true });
        await startServer();
        await second.reload();
        await waitForGameRoute(second, gameId);
        await second.getByText("Local", { exact: true }).waitFor();
        await second.getByText("Server does not know this game", { exact: false }).waitFor();
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
      `${origin}/internal/healthz`,
    ]);
    if (response.exitCode === 0) return;
    await Bun.sleep(50);
  }
  throw new Error("Ad Hoc browser server did not become ready.");
}

async function waitForGameRoute(page: Page, gameId: string) {
  if (page.url() !== `${origin}/game/${gameId}`) await page.waitForURL(`${origin}/game/${gameId}`);
}

async function assertAccessibleQr(page: Page, stage: string) {
  try {
    const trigger = page.getByRole("button", { name: "Show Ad Hoc Control QR" });
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
        document.activeElement?.textContent?.trim() === "Show Ad Hoc Control QR",
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
        document.activeElement?.textContent?.trim() === "Show Ad Hoc Control QR",
    );
    if (!(await trigger.evaluate((element) => element === document.activeElement))) {
      throw new Error("Close did not restore focus to the QR trigger");
    }
  } catch (error) {
    throw new Error(`${stage} QR display failed at ${page.url()}.`, { cause: error });
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
