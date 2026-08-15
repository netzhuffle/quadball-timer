import { SQLITE_FOUNDATION_PROBE_TIMEOUT_MS } from "@/lib/sqlite-foundation-probe";
import { runSqliteRuntimeEntrypoint } from "@/lib/sqlite-foundation-probe-cli";

/**
 * Intentional release-candidate diagnostic for #71/#70. It runs only when explicitly invoked,
 * outside the ordinary check/test suite and deployment workflows, because six writers, 6,000
 * committed rows, and 5,000 passive checkpoints prove the exact compiled SQLite integrity risk
 * that fast orchestration tests cannot. Native Linux should normally finish in under a second;
 * the 15-second watchdog bounds CPU, process, and temporary-disk use. Do not reduce, delete, or
 * fold this workload into automatic checks without an explicit acceptance decision. The outer
 * wrapper owns a private temporary container and process group; the inner writer supervision has
 * a 5-second deadline so cleanup completes inside the outer 15-second deadline.
 */
const cliArguments = process.argv.slice(2);
if (cliArguments.length > 1) {
  throw new Error("Usage: bun run check:sqlite-runtime [compiled-executable]");
}

const executablePath = cliArguments[0] ?? "dist/quadball-timer";
const result = await runSqliteRuntimeEntrypoint(executablePath, {
  timeoutMs: SQLITE_FOUNDATION_PROBE_TIMEOUT_MS,
  command: "bun run check:sqlite-runtime [compiled-executable]",
  emitResult: (qualificationResult) => {
    console.log(JSON.stringify(qualificationResult));
  },
});
const report = JSON.parse(result.stdout.trim()) as {
  bunVersion: string;
  bunRevision: string;
  sqliteVersion: string;
  actualRows: number;
  expectedRows: number;
  integrityCheck: string;
  quickCheck: string;
};
console.log(
  `SQLite runtime gate passed: Bun ${report.bunVersion} (${report.bunRevision}), SQLite ${report.sqliteVersion}, ${report.actualRows}/${report.expectedRows} rows, integrity=${report.integrityCheck}, quick=${report.quickCheck}.`,
);
