import path from "node:path";

export function importChains(meta: Bun.BuildMetafile, entry: string) {
  const chains = new Map<string, string[]>([[entry, [entry]]]);
  for (const [source, chain] of chains) {
    for (const edge of meta.inputs[source]?.imports ?? []) {
      // Bun marks split dynamic imports as external and rewrites their paths to
      // emitted chunks. Recover only known source entrypoints, not true externals.
      const chunkEntry =
        edge.kind === "dynamic-import" ? meta.outputs[edge.path]?.entryPoint : undefined;
      const target =
        chunkEntry && meta.inputs[chunkEntry] ? chunkEntry : edge.external ? undefined : edge.path;
      if (target && !chains.has(target)) chains.set(target, [...chain, target]);
    }
  }
  return chains;
}

export function summarizeBundle(
  meta: Bun.BuildMetafile,
  emitted: Record<string, number>,
  html: string,
) {
  const htmlEntry = "src/index.html";
  const chains = importChains(meta, htmlEntry);
  if (!chains.has("src/frontend.tsx"))
    throw new Error("Full-stack metadata is missing the browser graph");
  const outputs = meta.outputs;
  const resolveOutput = (source: string, target: string) => {
    if (outputs[target]) return target;
    const resolved = `./${path.posix.normalize(path.posix.join(path.posix.dirname(source), target))}`;
    return outputs[resolved] ? resolved : target;
  };
  const initial = new Set<string>();
  // Actual generated HTML identifies initial scripts/styles; dynamic entries are not roots.
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/gu)) {
    const target = match[1];
    if (target) {
      const key = resolveOutput("./index.html", target);
      if (outputs[key]) initial.add(key);
    }
  }
  for (const key of initial) {
    const output = outputs[key];
    if (!output) continue;
    if (output.cssBundle) initial.add(resolveOutput(key, output.cssBundle));
    for (const edge of output.imports) {
      if (edge.kind !== "dynamic-import") {
        const target = resolveOutput(key, edge.path);
        if (outputs[target]) initial.add(target);
      }
    }
  }
  const browser = new Set(
    Object.entries(outputs)
      .filter(([, o]) => o.entryPoint === htmlEntry || (o.entryPoint && chains.has(o.entryPoint)))
      .map(([key]) => key),
  );
  for (const key of initial) browser.add(key);
  for (const key of browser) {
    const output = outputs[key];
    if (output?.cssBundle) browser.add(resolveOutput(key, output.cssBundle));
    for (const edge of output?.imports ?? []) {
      const target = resolveOutput(key, edge.path);
      if (outputs[target]) browser.add(target);
    }
  }
  const files = Object.entries(outputs)
    .map(([file, output]) => ({
      file,
      scope: browser.has(file) ? "browser" : "server",
      role: file.endsWith(".html") ? "html" : output.entryPoint ? "entry" : "shared-chunk",
      entryPoint: output.entryPoint ?? null,
      initial: initial.has(file),
      emittedBytes: emitted[file] ?? null,
      metadataBytes: output.bytes,
      imports: output.imports,
      modules: Object.entries(output.inputs)
        .map(([module, info]) => ({
          module,
          inputBytes: meta.inputs[module]?.bytes ?? null,
          bytesInOutput: info.bytesInOutput,
          importChain: browser.has(file) ? (chains.get(module) ?? null) : null,
        }))
        .sort((a, b) => b.bytesInOutput - a.bytesInOutput || a.module.localeCompare(b.module)),
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
  const initialFiles = files.filter((file) => file.initial);
  if (!initialFiles.some((file) => file.file.endsWith(".js")))
    throw new Error("No initial browser JavaScript found in generated HTML");
  if (initialFiles.some((file) => file.emittedBytes === null))
    throw new Error("Initial browser artifact size is unavailable");
  return {
    files,
    initialAssetEmittedBytes: initialFiles.reduce((sum, file) => sum + (file.emittedBytes ?? 0), 0),
  };
}

export async function writeBundleAnalysis(
  result: Bun.BuildOutput,
  outdir: string,
  directory: string,
) {
  if (!result.metafile) throw new Error("Bun did not return build metadata");
  const html = result.outputs.find((output) => output.path.endsWith("/index.html"));
  if (!html)
    throw new Error("Bundle analysis requires the ordinary full-stack build (without --compile)");
  const emitted = Object.fromEntries(
    result.outputs.map((output) => [
      `./${path.relative(path.resolve(outdir), output.path)}`,
      output.size,
    ]),
  );
  const summary = summarizeBundle(result.metafile, emitted, await html.text());
  const report = {
    schemaVersion: 1,
    bunVersion: Bun.version,
    sourceCommit: Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim(),
    sourceDirty:
      Bun.spawnSync(["git", "status", "--porcelain"]).stdout.toString().trim().length > 0,
    command: process.argv.slice(2),
    metrics: {
      emittedBytes:
        "Uncompressed artifact bytes, including source-map references; not HTTP transfer bytes",
      metadataBytes: "Bun metafile output bytes; may exclude generated HTML or source-map overhead",
      bytesInOutput:
        "Bun attributed module bytes, not exclusive savings; shared dependencies overlap",
      inputBytes: "Original source bytes before minification/tree shaking",
    },
    ...summary,
  };
  const rows = summary.files.map(
    (file) =>
      `| ${file.scope} | ${file.file} | ${file.role} | ${file.initial ? "yes" : "no"} | ${file.emittedBytes ?? "unavailable"} | ${file.metadataBytes} |`,
  );
  const modules = summary.files
    .filter((file) => file.scope === "browser")
    .flatMap((file) => file.modules.map((module) => ({ ...module, file: file.file })))
    .sort((a, b) => b.bytesInOutput - a.bytesInOutput);
  const markdown = [
    "# Browser bundle analysis",
    "",
    `Bun ${Bun.version}; source ${report.sourceCommit}; dirty: ${report.sourceDirty}.`,
    "",
    `Initial JS/CSS/assets: **${summary.initialAssetEmittedBytes} uncompressed emitted bytes** (HTML and source maps excluded).`,
    "",
    "| Scope | Output | Role | Initial | Emitted bytes | Metadata bytes |",
    "|---|---|---|---|---:|---:|",
    ...rows,
    "",
    "## Largest browser module contributions",
    "",
    ...modules
      .slice(0, 25)
      .map(
        (module) =>
          `- ${module.module}: ${module.bytesInOutput} attributed bytes in ${module.file}; chain: ${(module.importChain ?? []).join(" → ") || "unavailable"}`,
      ),
    "",
    "All module contributions and import chains are in report.json; raw Bun metadata is in metafile.json.",
    "",
    ...Object.entries(report.metrics).map(([name, description]) => `- ${name}: ${description}`),
    "",
  ].join("\n");
  await Bun.write(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  await Bun.write(path.join(directory, "metafile.json"), JSON.stringify(result.metafile, null, 2));
  await Bun.write(path.join(directory, "report.md"), markdown);
  console.log(markdown);
  console.log(`Bundle reports written outside public assets: ${directory}`);
}
