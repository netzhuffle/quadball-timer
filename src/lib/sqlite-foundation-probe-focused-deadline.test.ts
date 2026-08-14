import { describe, expect, test } from "bun:test";
import { createFocusedAdmissionDeadline } from "@/lib/sqlite-foundation-probe-focused-deadline";

describe("focused admission lifecycle deadline", () => {
  test("reserves cleanup inside one overall deadline and aborts all work at the hard stop", () => {
    const scheduled: Array<{ callback: () => void; milliseconds: number }> = [];
    const cleared: unknown[] = [];
    const deadline = createFocusedAdmissionDeadline(
      5_000,
      2_000,
      (callback, milliseconds) => {
        const handle = { callback, milliseconds };
        scheduled.push(handle);
        return handle;
      },
      (handle) => cleared.push(handle),
    );

    expect(scheduled.map(({ milliseconds }) => milliseconds)).toEqual([3_000, 5_000]);
    scheduled[0]?.callback();
    expect(deadline.workSignal.aborted).toBe(true);
    expect(deadline.overallSignal.aborted).toBe(false);
    scheduled[1]?.callback();
    expect(deadline.overallSignal.aborted).toBe(true);
    deadline.cleanup();
    expect(cleared).toHaveLength(2);
  });
});
