import { describe, expect, test } from "bun:test";
import { createStartupCleanup } from "@/lib/startup-resources";

describe("startup resource cleanup", () => {
  test("closes opened resources in reverse order exactly once", () => {
    const cleanup = createStartupCleanup();
    const closed: string[] = [];
    cleanup.add(() => closed.push("repository"));
    cleanup.add(() => closed.push("auth"));
    cleanup.add(() => closed.push("foundation"));

    cleanup.run();
    cleanup.run();

    expect(closed).toEqual(["foundation", "auth", "repository"]);
    expect(closed.filter((resource) => resource === "auth")).toHaveLength(1);
    expect(closed.filter((resource) => resource === "repository")).toHaveLength(1);
  });

  test("cleans a resource added after initialization failed", () => {
    const cleanup = createStartupCleanup();
    const closed: string[] = [];
    cleanup.run();

    cleanup.add(() => closed.push("late-resource"));

    expect(closed).toEqual(["late-resource"]);
  });
});
