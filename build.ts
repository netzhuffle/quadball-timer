#!/usr/bin/env bun
import plugin from "bun-plugin-tailwind";
import { existsSync } from "fs";
import { rm } from "fs/promises";
import path from "path";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
🏗️  Bun Build Script

Usage: bun run build.ts [options]

Common Options:
  --compile               Generate a standalone executable
  --compile-target <name> Compile target for executable builds (default: bun-linux-x64-modern)
  --outfile <path>        Executable output path when compiling (default: dist/quadball-timer)
  --outdir <path>          Output directory (default: "dist")
  --minify                 Enable minification (or --minify.whitespace, --minify.syntax, etc)
  --sourcemap <type>      Sourcemap type: none|linked|inline|external
  --target <target>        Build target: bun|browser|node
  --format <format>        Output format: esm|cjs|iife
  --splitting              Enable code splitting
  --packages <type>        Package handling: bundle|external
  --public-path <path>     Public path for assets
  --env <mode>             Environment handling: inline|disable|prefix*
  --conditions <list>      Package.json export conditions (comma separated)
  --external <list>        External packages (comma separated)
  --banner <text>          Add banner text to output
  --footer <text>          Add footer text to output
  --define <obj>           Define global constants (e.g. --define.VERSION=1.0.0)
  --help, -h               Show this help message

Examples:
  bun run build.ts --outdir=dist --target=bun --minify --sourcemap=linked
  bun run build.ts --compile --compile-target=bun-linux-x64-modern --outfile=dist/quadball-timer
`);
  process.exit(0);
}

type ParsedBuildConfig = Partial<Bun.BuildConfig> & {
  compileTarget?: Bun.Build.CompileTarget;
  outfile?: string;
  outdir?: string;
};

const toCamelCase = (str: string): string =>
  str.replace(/-([a-z])/g, (_fullMatch, letter: string) => letter.toUpperCase());

const parseValue = (value: string): unknown => {
  if (value === "true") return true;
  if (value === "false") return false;

  if (/^\d+$/.test(value)) return parseInt(value, 10);
  if (/^\d*\.\d+$/.test(value)) return parseFloat(value);

  if (value.includes(",")) return value.split(",").map((v) => v.trim());

  return value;
};

function parseArgs(): ParsedBuildConfig {
  const config: Record<string, unknown> = {};
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) continue;

    if (arg.startsWith("--no-")) {
      const key = toCamelCase(arg.slice(5));
      config[key] = false;
      continue;
    }

    if (!arg.includes("=") && (i === args.length - 1 || args[i + 1]?.startsWith("--"))) {
      const key = toCamelCase(arg.slice(2));
      config[key] = true;
      continue;
    }

    let key: string;
    let value: string;

    if (arg.includes("=")) {
      [key, value] = arg.slice(2).split("=", 2) as [string, string];
    } else {
      key = arg.slice(2);
      value = args[++i] ?? "";
    }

    key = toCamelCase(key);

    if (key.includes(".")) {
      const [parentKey, childKey] = key.split(".", 2);
      if (parentKey === undefined || childKey === undefined) {
        continue;
      }

      const parent =
        typeof config[parentKey] === "object" &&
        config[parentKey] !== null &&
        !Array.isArray(config[parentKey])
          ? (config[parentKey] as Record<string, unknown>)
          : {};
      parent[childKey] = parseValue(value);
      config[parentKey] = parent;
    } else {
      config[key] = parseValue(value);
    }
  }

  return config as ParsedBuildConfig;
}

const formatFileSize = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
};

console.log("\n🚀 Starting build process...\n");

const cliConfig = parseArgs();
const {
  compile: compileOption,
  compileTarget,
  outdir: cliOutdir,
  outfile: cliOutfile,
  ...buildConfigOverrides
} = cliConfig;
const shouldCompile = compileOption !== undefined && compileOption !== false;
const outputPath =
  shouldCompile && typeof cliOutfile === "string"
    ? path.resolve(cliOutfile)
    : path.join(process.cwd(), "dist", "quadball-timer");
const outdir = shouldCompile
  ? path.dirname(outputPath)
  : typeof cliOutdir === "string"
    ? cliOutdir
    : path.join(process.cwd(), "dist");

if (existsSync(outdir)) {
  console.log(`🗑️ Cleaning previous build at ${outdir}`);
  await rm(outdir, { recursive: true, force: true });
}

const start = performance.now();
const serverEntrypoint = path.resolve("src", "index.ts");
const entrypoints = [serverEntrypoint];
console.log(
  `📄 Bundling full-stack entrypoint ${path.relative(process.cwd(), serverEntrypoint)}\n`,
);

const compileConfig =
  typeof compileOption === "object" && compileOption !== null && !Array.isArray(compileOption)
    ? (compileOption as Bun.CompileBuildOptions)
    : {};
const executableTarget = compileTarget ?? compileConfig.target ?? "bun-linux-x64-modern";

const buildConfig: Bun.BuildConfig = {
  entrypoints,
  plugins: [plugin],
  minify: true,
  bytecode: shouldCompile,
  target: "bun",
  sourcemap: shouldCompile ? "none" : "linked",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  ...(shouldCompile
    ? {
        compile: {
          ...compileConfig,
          target: executableTarget,
          outfile: outputPath,
          autoloadDotenv: false,
          autoloadBunfig: false,
        },
      }
    : {
        outdir,
      }),
  ...buildConfigOverrides,
};

const result = await Bun.build(buildConfig);

const end = performance.now();

const outputTable = result.outputs.map((output) => ({
  File: path.relative(process.cwd(), output.path),
  Type: output.kind,
  Size: formatFileSize(output.size),
}));

console.table(outputTable);
const buildTime = (end - start).toFixed(2);

console.log(`\n✅ Build completed in ${buildTime}ms\n`);
