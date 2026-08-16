import { describe, expect, test } from "bun:test";
import { toggleControllerActionPanel } from "@/lib/controller-action-sheet";

describe("Controller action-sheet selection", () => {
  test("opens from a nullable selection", () => {
    expect(toggleControllerActionPanel(null, "card")).toBe("card");
  });

  test("selecting the same action closes it", () => {
    expect(toggleControllerActionPanel("card", "card")).toBeNull();
  });

  test("switching categories selects the new action", () => {
    expect(toggleControllerActionPanel("card", "timeout")).toBe("timeout");
  });
});
