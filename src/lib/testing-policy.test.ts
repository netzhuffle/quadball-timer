import { describe, expect, test } from "bun:test";
import {
  isCompleteQualificationEntry,
  parseQualificationRegistry,
  routeQualificationRequest,
} from "@/lib/testing-policy";

const policyMarkdown = await Bun.file("docs/agents/testing.md").text();
const registry = parseQualificationRegistry(policyMarkdown);
const registeredEntry = Object.values(registry)[0];
if (registeredEntry === undefined) throw new Error("Canonical SQLite qualification is missing.");

describe("testing policy routing", () => {
  test("registers the exact compiled SQLite workload with every admission field", () => {
    expect(Object.keys(registry)).toEqual([registeredEntry.command]);
    expect(registeredEntry.command).toMatch(/^bun run [^ ]+ \[compiled-executable\]$/);
    expect(registeredEntry.resourceLimits).toEqual({
      timeoutMs: 15_000,
      processCount: 7,
      memoryBytes: 512 * 1024 * 1024,
      diskBytes: 16 * 1024 * 1024,
      outputBytes: 4 * 1024,
      descendantCleanupMs: 1_000,
    });
    for (const value of Object.values(registeredEntry)) {
      if (typeof value === "string") expect(value.length).toBeGreaterThan(0);
    }
    expect(isCompleteQualificationEntry(registeredEntry)).toBe(true);
  });

  test("invokes exactly one named registered qualification request", () => {
    expect(
      routeQualificationRequest(
        {
          kind: "qualification",
          mode: "run",
          name: registeredEntry.command,
        },
        { [registeredEntry.command]: registeredEntry },
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
            name: registeredEntry.command,
          },
          { [registeredEntry.command]: registeredEntry },
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
          name: registeredEntry.command,
        },
        {},
      ),
    ).toBe("refuse-unregistered");
  });

  test("refuses ambiguous, incomplete, and mismatched requests", () => {
    expect(
      routeQualificationRequest(
        { kind: "qualification", mode: "run" },
        { [registeredEntry.command]: registeredEntry },
      ),
    ).toBe("refuse-ambiguous");
    expect(
      routeQualificationRequest(
        {
          kind: "qualification",
          mode: "run",
          name: registeredEntry.command,
          parametersMatch: false,
        },
        { [registeredEntry.command]: registeredEntry },
      ),
    ).toBe("refuse-parameter-mismatch");
    expect(
      routeQualificationRequest(
        { kind: "qualification", mode: "run", name: "incomplete" },
        { incomplete: { ...registeredEntry, owner: "" } },
      ),
    ).toBe("refuse-incomplete");
    expect(
      routeQualificationRequest(
        { kind: "qualification", mode: "run", name: "incomplete" },
        { incomplete: { ...registeredEntry, owner: "" } },
      ),
    ).toBe("refuse-incomplete");
  });

  test("literal qualification command is absent from ordinary workflow and script chains", async () => {
    const workflow = await Bun.file(".github/workflows/deploy-production.yml").text();
    expect(workflow).not.toContain(registeredEntry.command.split(" ")[2]);
    const packageJson = (await Bun.file("package.json").json()) as {
      scripts: Record<string, string>;
    };
    const qualificationScriptName = registeredEntry.command.split(" ")[2];
    for (const [name, command] of Object.entries(packageJson.scripts)) {
      if (name !== qualificationScriptName) {
        expect(command).not.toContain(registeredEntry.command.split(" ")[2]);
      }
    }
  });
});
