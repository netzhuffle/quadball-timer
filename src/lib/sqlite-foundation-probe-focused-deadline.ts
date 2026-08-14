export type FocusedAdmissionDeadline = {
  workSignal: AbortSignal;
  overallSignal: AbortSignal;
  cleanup(): void;
};

export function createFocusedAdmissionDeadline(
  totalMs: number,
  cleanupReserveMs: number,
  schedule: (callback: () => void, milliseconds: number) => unknown = setTimeout,
  clear: (handle: unknown) => void = (handle) => clearTimeout(handle as NodeJS.Timeout),
): FocusedAdmissionDeadline {
  if (
    !Number.isSafeInteger(totalMs) ||
    !Number.isSafeInteger(cleanupReserveMs) ||
    totalMs <= 0 ||
    cleanupReserveMs <= 0 ||
    cleanupReserveMs >= totalMs
  ) {
    throw new Error("Invalid focused admission deadline.");
  }
  const overall = new AbortController();
  const work = new AbortController();
  const workTimer = schedule(() => work.abort(), totalMs - cleanupReserveMs);
  const overallTimer = schedule(() => overall.abort(), totalMs);
  const abortWork = () => work.abort();
  overall.signal.addEventListener("abort", abortWork, { once: true });
  return {
    workSignal: work.signal,
    overallSignal: overall.signal,
    cleanup() {
      clear(workTimer);
      clear(overallTimer);
      overall.signal.removeEventListener("abort", abortWork);
      work.abort();
      overall.abort();
    },
  };
}
