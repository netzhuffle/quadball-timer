import { describe, expect, test } from "bun:test";
import {
  focusedAdmissionExitCode,
  focusedAdmissionRecordByteLength,
  runFocusedBounded,
} from "@/lib/sqlite-foundation-probe-focused-admission";

describe("focused admission evidence boundary", () => {
  test("fails the process contract only for failed admission", () => {
    expect(focusedAdmissionExitCode("passed")).toBe(0);
    expect(focusedAdmissionExitCode("blocked")).toBe(0);
    expect(focusedAdmissionExitCode("failed")).toBe(1);
  });

  test("measures the complete record in UTF-8 bytes", () => {
    expect(focusedAdmissionRecordByteLength({ value: "😀" })).toBe(16);
  });

  test("does not wait for a never-settling cleanup operation after abort", async () => {
    const controller = new AbortController();
    const never = new Promise<void>(() => {});
    const result = runFocusedBounded(never, controller.signal, "cleanup");
    controller.abort();
    try {
      await result;
      throw new Error("expected cleanup to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("cleanup exceeded");
    }
  });
});
