// Intentional bounded browser experiment; run from repository root after building.
// Reuses the existing disposable Controller API fixture and lifecycle cleanup unchanged.
import { resolve } from "node:path";
const [entry, output, browserName = "chromium", compiled = "false"] = process.argv.slice(2);
if (!entry || !output) throw new Error("Expected entry and JSON output paths");
const fixture = await Bun.file("scripts/test-event-game-controller-browser.ts").text();
let source = fixture
  .replace('NODE_ENV: "test",', 'NODE_ENV: "production", QBT_FOCUSED_TEST_MODE: "1",')
  .replace(
    'Bun.spawn(["bun", "run", "src/index.ts"],',
    `Bun.spawn(${JSON.stringify(compiled === "true" ? [resolve(entry)] : [process.execPath, resolve(entry)])},`,
  )
  .replace("cwd: process.cwd(),", `cwd: ${JSON.stringify(resolve(entry, ".."))},`)
  .replace(
    "for (const browserType of [chromium, webkit])",
    `for (const browserType of [${browserName}])`,
  );
source = source.replace(
  "function applyIntent(intent: Record<string, unknown>) {",
  `function applyIntent(intent: Record<string, unknown>) {
  if (intent.type === "clock-correction") currentProjection = { ...currentProjection, clock: { ...currentProjection.clock, gameTimeMs: intent.clockTimeMs as number, baseline: { ...currentProjection.clock.baseline, gameTimeMs: intent.clockTimeMs as number } } };
`,
);
const begin = source.indexOf("        const context = await browser.newContext");
const end = source.indexOf("        await browser.close();", begin);
source =
  source.slice(0, begin) +
  `
        const samples = [];
        for (let sample = 0; sample < 3; sample++) {
          currentProjection = createProjection();
          const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 1000 } });
          await installControllerApi(context);
          await context.addInitScript(() => {
            const w = window as any;
            w.measure = { commits: 0, renderedFibers: 0 };
            w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, inject: () => 1, onCommitFiberUnmount() {}, onCommitFiberRoot(_id: number, root: any) {
              w.measure.commits++;
              const visit = (fiber: any) => { if (!fiber) return; if ((fiber.flags & 1) && typeof fiber.type === "function") w.measure.renderedFibers++; visit(fiber.child); visit(fiber.sibling); }; visit(root.current);
            }};
          });
          const page = await context.newPage(); page.setDefaultTimeout(4000);
          let refreshes = 0; page.on("request", r => { if (new URL(r.url()).pathname.endsWith("/refresh")) refreshes++; });
          const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
          await page.goto(origin + "/event-control");
          await page.getByLabel("Active Pitch Slot Control Grant QR").fill("disposable-grant");
          await page.getByRole("button", { name: "Open Event Game Controller" }).click();
          await page.getByText("Controller Device: game-browser-focused").waitFor();
          const phases = [];
          async function measure(name: string, action: () => Promise<void>) {
            await page.evaluate(() => { (window as any).measure = { commits: 0, renderedFibers: 0 }; });
            const start = performance.now(); await action();
            await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
            phases.push({ name, elapsedMs: performance.now() - start, ...await page.evaluate(() => (window as any).measure) });
          }
          await measure("clock", async () => {
            await page.getByRole("button", { name: "Start game clock", exact: true }).click();
            await page.getByRole("button", { name: "Pause game clock", exact: true }).waitFor();
            await page.waitForTimeout(1200);
            await page.getByRole("button", { name: "Pause game clock", exact: true }).click();
          });
          await measure("correction", async () => {
            await page.getByLabel("Set game clock (milliseconds)").fill("123000");
            await page.getByRole("button", { name: "Correct Event Game clock", exact: true }).click();
            await page.waitForTimeout(100);
            assert(currentProjection.clock.gameTimeMs === 123000, "correction callback did not set expected clock");
          });
          await measure("dialog", async () => {
            await page.getByRole("button", { name: "Reveal active Grant QR" }).click();
            const dialog = page.getByRole("dialog", { name: "Active Grant QR" }); await dialog.waitFor();
            await page.mouse.click(2, 2); await dialog.waitFor({ state: "hidden" });
            await page.waitForTimeout(50);
            assert(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")) === "Show active Grant QR", "dialog focus restore");
          });
          await measure("reconnect", async () => {
            const before = refreshes;
            await context.setOffline(true);
            await page.evaluate(() => window.dispatchEvent(new Event("offline")));
            await page.waitForTimeout(100);
            await context.setOffline(false);
            await page.evaluate(() => window.dispatchEvent(new Event("online")));
            await page.waitForTimeout(300);
            await page.getByText("Controller Device: game-browser-focused").waitFor();
            assert(await page.getByRole("button", { name: "Start game clock", exact: true }).isEnabled(), "reconnect disabled clock");
            assert(refreshes > before, "reconnect did not refresh authority");
          });
          const scripts = await page.evaluate(() => performance.getEntriesByType("resource").filter(e => /\\.js$/.test(e.name)).map(e => e.name));
          const assets = [];
          for (const url of scripts) { const text = await (await context.request.get(url)).text(); assets.push({ name: new URL(url).pathname, bytes: Buffer.byteLength(text), memoCacheSymbolOccurrences: text.split("react.memo_cache_sentinel").length - 1, sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex") }); }
          assert(errors.length === 0, errors.join("; "));
          samples.push({ sample, phases, assets, refreshes, errors });
          await context.close();
        }
        await Bun.write(${JSON.stringify(resolve(output))}, JSON.stringify({ browser: browserType.name(), samples }, null, 2));
` +
  source.slice(end);
source = source
  .replaceAll('from "@/lib/', `from "${process.cwd()}/src/lib/`)
  .replace(
    'from "./controller-action-sheet-browser-assertions"',
    `from "${process.cwd()}/scripts/controller-action-sheet-browser-assertions"`,
  );
source = source.replace(
  "Focused Integration Test passed: Chromium/WebKit 390x844 and 412x915 Controller interactions and suspend/review/resume.",
  "React Compiler probe passed: selected browser, desktop fixture, three clock/correction/dialog/reconnect samples.",
);
const generated = resolve("docs/research/react-compiler/.probe.tmp.ts");
await Bun.write(generated, source);
try {
  const child = Bun.spawn([process.execPath, generated], { stdout: "inherit", stderr: "inherit" });
  const status = await child.exited;
  if (status !== 0) throw new Error(`Probe exited ${status}`);
} finally {
  await Bun.file(generated).delete();
}
