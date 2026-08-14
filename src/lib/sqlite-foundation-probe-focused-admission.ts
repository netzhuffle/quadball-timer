export type FocusedAdmissionOutcome = "passed" | "failed" | "blocked";

export function focusedAdmissionExitCode(outcome: FocusedAdmissionOutcome): number {
  return outcome === "failed" ? 1 : 0;
}

export function focusedAdmissionRecordByteLength(record: unknown): number {
  return new TextEncoder().encode(JSON.stringify(record)).byteLength;
}

export async function runFocusedBounded<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  label: string,
): Promise<T> {
  if (signal.aborted) throw new Error(`${label} exceeded the focused lifecycle deadline`);
  let removeAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const abort = () => reject(new Error(`${label} exceeded the focused lifecycle deadline`));
    signal.addEventListener("abort", abort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", abort);
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    removeAbort();
  }
}
