import { describe, expect, test } from "bun:test";
import { retainControllerGoalIntent } from "@/lib/controller-intent-retry";

describe("Controller tap retry identity", () => {
  test("reuses the pending operation and fact identity after an uncertain response", () => {
    const first = retainControllerGoalIntent(null, "side-a", 1234);
    const retry = retainControllerGoalIntent(first, "side-a", 9876);

    expect(retry).toEqual(first);
    expect(JSON.stringify(retry)).toBe(JSON.stringify(first));
    expect(retainControllerGoalIntent(first, "side-b")).not.toEqual(first);
  });
});
