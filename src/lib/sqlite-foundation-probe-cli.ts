import {
  runCompiledSqliteFoundationProbe,
  type CompiledSqliteFoundationProbeOptions,
  type CompiledSqliteFoundationProbeResult,
} from "@/lib/sqlite-foundation-probe-runner";
import { installProbeSignalHandlers } from "@/lib/sqlite-foundation-probe-process";

export async function runSqliteRuntimeEntrypoint(
  executablePath: string,
  options: Omit<CompiledSqliteFoundationProbeOptions, "signal"> = {},
): Promise<CompiledSqliteFoundationProbeResult> {
  const signalScope = installProbeSignalHandlers();
  try {
    return await runCompiledSqliteFoundationProbe(executablePath, {
      ...options,
      signal: signalScope.signal,
    });
  } finally {
    signalScope.cleanup();
  }
}
