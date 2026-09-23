import { prepareDevelopmentDatabases } from "./development-databases";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { developmentEnvironment, initializeDevelopmentState } from "./development-state";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: "string" },
    "public-origin": { type: "string" },
    setup: { type: "boolean" },
    "copy-from": { type: "string" },
    "admin-enroll": { type: "boolean" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "bun run dev [--port 3000] [--public-origin https://host:8443] [--admin-enroll]\nbun run dev:setup [--copy-from /path/to/main-worktree]\nCopy only from a stopped development instance. Existing state is never overwritten.",
  );
  process.exit(0);
}
if (process.env.NODE_ENV === "production" || process.env.QUADBALL_ENVIRONMENT === "production")
  throw new Error("The development launcher cannot run in Production.");
if (values["copy-from"] && !values.setup)
  throw new Error("Use dev:setup for copying development data.");
const directory = initializeDevelopmentState(process.cwd(), values["copy-from"]);
if (values.setup) {
  console.log(`Development state ready: ${directory}`);
  process.exit(0);
}
const port = Number(values.port ?? process.env.PORT ?? 3000);
const origin = values["public-origin"] ?? process.env.PUBLIC_ORIGIN ?? `http://localhost:${port}`;
const environment = {
  ...process.env,
  ...developmentEnvironment(directory, port, origin),
  TLS_CERT_FILE: "",
  TLS_KEY_FILE: "",
};
if (values["admin-enroll"] && !origin.startsWith("https://"))
  throw new Error("Use the HTTPS preview origin to enroll Technical Admin.");
const lock = join(directory, "runtime.lock");
if (!values["admin-enroll"]) {
  try {
    mkdirSync(lock);
  } catch {
    throw new Error(
      `Development server already owns ${lock}. Stop it first. After an unclean exit, verify its recorded PID is gone before removing this lock.`,
    );
  }
  writeFileSync(join(lock, "pid"), String(process.pid));
}
try {
  console.log(`Development URL: ${origin}\nData: ${directory}`);
  const args = values["admin-enroll"]
    ? ["src/index.ts", "--technical-admin-bootstrap", "enroll"]
    : ["--hot", "src/index.ts"];
  if (!values["admin-enroll"]) await prepareDevelopmentDatabases(directory);
  const child = Bun.spawn([process.execPath, ...args], {
    env: environment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  let stopDeadline: ReturnType<typeof setTimeout> | undefined;
  const stop = (signal: "SIGINT" | "SIGTERM") => {
    child.kill(signal);
    // Bun hot reload may retain prior listeners; bound shutdown of this owned child.
    stopDeadline ??= setTimeout(() => child.kill("SIGKILL"), 3_000);
  };
  const interrupt = () => stop("SIGINT");
  const terminate = () => stop("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  process.exitCode = await child.exited;
  clearTimeout(stopDeadline);
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
} finally {
  if (!values["admin-enroll"]) rmSync(lock, { recursive: true, force: true });
}
