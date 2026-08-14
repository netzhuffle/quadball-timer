import { describe, expect, test } from "bun:test";
import { routeQualificationRequest, type QualificationEntry } from "@/lib/testing-policy";

const registeredEntry: QualificationEntry = {
  complete: true,
  riskStillExists: true,
  safe: true,
};

describe("testing policy routing", () => {
  test("invokes exactly one named registered qualification request", () => {
    expect(
      routeQualificationRequest(
        {
          kind: "qualification",
          mode: "run",
          name: "sqlite-artifact-gate",
        },
        { "sqlite-artifact-gate": registeredEntry },
      ),
    ).toBe("invoke-once");
  });

  test.each(["test", "check", "build", "implementation", "review"])(
    "keeps ordinary %s requests on the ordinary boundary",
    () => {
      expect(routeQualificationRequest({ kind: "ordinary" }, {})).toBe("ordinary-boundary");
    },
  );

  test.each(["validate", "review"])(
    "inspects a registered qualification for %s without invoking it",
    (mode) => {
      expect(
        routeQualificationRequest(
          {
            kind: "qualification",
            mode: mode as "validate" | "review",
            name: "sqlite-artifact-gate",
          },
          { "sqlite-artifact-gate": registeredEntry },
        ),
      ).toBe("inspect-without-invocation");
    },
  );

  test("refuses an empty registry without invoking a workload", () => {
    expect(
      routeQualificationRequest(
        {
          kind: "qualification",
          mode: "run",
          name: "sqlite-artifact-gate",
        },
        {},
      ),
    ).toBe("refuse-unregistered");
  });

  test("refuses ambiguous, unsafe, incomplete, and mismatched requests", () => {
    expect(
      routeQualificationRequest(
        { kind: "qualification", mode: "run" },
        { "sqlite-artifact-gate": registeredEntry },
      ),
    ).toBe("refuse-ambiguous");
    expect(
      routeQualificationRequest(
        {
          kind: "qualification",
          mode: "run",
          name: "sqlite-artifact-gate",
          parametersMatch: false,
        },
        { "sqlite-artifact-gate": registeredEntry },
      ),
    ).toBe("refuse-parameter-mismatch");
    expect(
      routeQualificationRequest(
        { kind: "qualification", mode: "run", name: "unsafe" },
        { unsafe: { ...registeredEntry, safe: false } },
      ),
    ).toBe("refuse-unsafe");
    expect(
      routeQualificationRequest(
        { kind: "qualification", mode: "run", name: "incomplete" },
        { incomplete: { ...registeredEntry, complete: false } },
      ),
    ).toBe("refuse-incomplete");
  });

  test("deployment workflow contains no automatic qualification trigger", async () => {
    const workflow = await Bun.file(".github/workflows/deploy-production.yml").text();
    expect(workflow).not.toMatch(/qualification/i);
  });
});
