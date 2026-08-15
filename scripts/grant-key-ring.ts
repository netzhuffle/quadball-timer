import { parseGrantKeyRingCli, runGrantKeyRingCli } from "@/lib/grant-key-ring-cli";

const invocation = parseGrantKeyRingCli(["--grant-key-ring", ...process.argv.slice(2)]);

if (invocation.kind === "none") {
  console.error(
    "Usage: bun scripts/grant-key-ring.ts <create|convert|verify|rotate|remove-legacy> ...",
  );
  process.exitCode = 1;
} else if (invocation.kind === "invalid") {
  console.error(invocation.error);
  process.exitCode = 1;
} else {
  process.exitCode = runGrantKeyRingCli(invocation, process.getuid?.() ?? 0);
}
