// Run from repository root. No executable is launched by this build measurement.
import { mkdir } from "node:fs/promises";
await mkdir("out/react-compiler", { recursive: true });
const samples = [];
for (let round = 0; round < 3; round++) {
  for (const enabled of round % 2 === 0 ? [false, true] : [true, false]) {
    const mode = enabled ? "on" : "off";
    const start = performance.now();
    const child = Bun.spawn(
      [
        process.execPath,
        "build.ts",
        `--react-compiler=${enabled}`,
        `--outdir=out/compiler-${mode}`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    if ((await child.exited) !== 0) throw new Error(await stderr);
    const log = await stdout;
    await Bun.write(`out/react-compiler/build-${mode}-${round}.log`, log);
    const assets = [];
    for (const path of new Bun.Glob("*.js").scanSync(`out/compiler-${mode}`)) {
      const file = Bun.file(`out/compiler-${mode}/${path}`);
      const text = await file.text();
      assets.push({
        path,
        bytes: file.size,
        sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
      });
    }
    samples.push({
      mode,
      round,
      wallMs: performance.now() - start,
      buildMs: Number(log.match(/completed in ([\d.]+)ms/)?.[1]),
      assets,
    });
  }
}
await Bun.write(
  "out/react-compiler/builds.json",
  JSON.stringify(
    { bun: Bun.version, platform: process.platform, arch: process.arch, samples },
    null,
    2,
  ),
);
