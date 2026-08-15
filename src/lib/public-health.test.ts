import { describe, expect, test } from "bun:test";
import type { FoundationStorage, FoundationStorageReadiness } from "@/lib/foundation-storage";
import { createPublicHealthRoute, isPubliclyHealthy, readPublicHealth } from "@/lib/public-health";

const readyTechnicalAdmin = {
  storageStatus: () => ({
    state: "ready" as const,
    credentialPresent: true,
    activeSessionCount: 0,
    generation: 1,
  }),
};

function sqliteReadiness(
  writePressure: "unknown" | "normal" | "unsafe",
): FoundationStorageReadiness {
  return {
    ok: true as const,
    schemaVersion: "26",
    storage: "sqlite" as const,
    evidence: {
      runtime: { engine: "bun", version: "test", sqliteVersion: "3" },
      transaction: {
        lastLatencyMs: null,
        rejectionCount: 0,
        rejectionCategories: {
          busy: 0,
          readonly: 0,
          full: 0,
          "io-error": 0,
          "commit-failure": 0,
          corruption: 0,
        },
        writePressure,
      },
      sqlite: {
        journalMode: "wal",
        synchronous: 2,
        foreignKeys: true,
        walBytes: 0,
        checkpoint: "ok",
        diskBytes: 0,
        diskFreeBytes: 1,
        failureCategory: null,
      },
      migration: { state: "ready", schemaVersion: "26", appliedCount: 26 },
      keys: {
        requiredCount: 0,
        availableCount: 0,
        missingCount: 0,
        requiredCategories: { encryption: 0, lookup: 0, audit: 0 },
        availableCategories: { encryption: 0, lookup: 0, audit: 0 },
        missingCategories: { encryption: 0, lookup: 0, audit: 0 },
      },
      replay: { result: "not-configured", rootCount: 0, actionCount: 0, durationMs: null },
    },
  };
}

const readyFoundation: Pick<FoundationStorage, "readiness"> = {
  readiness: async () => sqliteReadiness("normal"),
};

const sensitiveReadinessFailure: Pick<FoundationStorage, "readiness"> = {
  readiness: async () => ({
    ok: false as const,
    status: "integrity-failure" as const,
    detail:
      "database path, schema version, release identity, credential detail, object counts, and stack diagnostics stay private",
    storage: "sqlite" as const,
  }),
};

const PUBLIC_INFORMATION_EXCLUSION =
  /release|commit|source|workflow|sha|digest|hash|bun|runtime|schema|migration|database|sqlite|credential|secret|object|count|dependency|host|port|diagnostic|detail|stack|token|password/i;

async function expectPublicHealthResponse(
  response: Response,
  status: number,
  body: "healthy\n" | "unhealthy\n",
) {
  expect(response.status).toBe(status);
  expect(await response.text()).toBe(body);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(`${body}\n${JSON.stringify([...response.headers])}`).not.toMatch(
    PUBLIC_INFORMATION_EXCLUSION,
  );
}

describe("public health contract", () => {
  test("mounts the literal /healthz route and serves its HTTP contract", async () => {
    const server = Bun.serve({
      port: 0,
      routes: {
        "/healthz": createPublicHealthRoute({
          foundationStorage: readyFoundation,
          technicalAdminAuth: readyTechnicalAdmin,
        }),
      },
    });

    try {
      const response = await fetch(new URL("/healthz", server.url));
      await expectPublicHealthResponse(response, 200, "healthy\n");
      expect((await fetch(new URL("/not-healthz", server.url))).status).toBe(404);
    } finally {
      await server.stop(true);
    }
  });

  test("returns only unhealthy when any core readiness boundary is unavailable", async () => {
    const unavailableTechnicalAdmin = {
      storageStatus: () => ({
        ...readyTechnicalAdmin.storageStatus(),
        state: "unavailable" as const,
      }),
    };
    const throwingTechnicalAdmin = {
      storageStatus: () => {
        throw new Error("credential database stack diagnostic");
      },
    };
    const throwingFoundation: Pick<FoundationStorage, "readiness"> = {
      readiness: async () => {
        throw new Error("database schema release object diagnostic");
      },
    };

    for (const dependencies of [
      {
        foundationStorage: undefined,
        technicalAdminAuth: readyTechnicalAdmin,
      },
      {
        foundationStorage: sensitiveReadinessFailure,
        technicalAdminAuth: readyTechnicalAdmin,
      },
      {
        foundationStorage: readyFoundation,
        technicalAdminAuth: unavailableTechnicalAdmin,
      },
      {
        foundationStorage: readyFoundation,
        technicalAdminAuth: throwingTechnicalAdmin,
      },
      {
        foundationStorage: throwingFoundation,
        technicalAdminAuth: readyTechnicalAdmin,
      },
    ]) {
      const response = await readPublicHealth(dependencies);
      await expectPublicHealthResponse(response, 503, "unhealthy\n");
    }
  });

  test("ignores caller authority and query/header variations for both outcomes", async () => {
    const requests = [
      new Request("https://timer.quadball.app/healthz"),
      new Request("https://timer.quadball.app/healthz?eventId=private-event", {
        headers: {
          authorization: "Bearer caller-supplied-authority",
          cookie: "session=caller-supplied-secret",
          host: "attacker.example",
          "x-forwarded-for": "203.0.113.7",
        },
      }),
    ];
    const healthyRoute = createPublicHealthRoute({
      foundationStorage: readyFoundation,
      technicalAdminAuth: readyTechnicalAdmin,
    });
    const unhealthyRoute = createPublicHealthRoute({
      foundationStorage: sensitiveReadinessFailure,
      technicalAdminAuth: readyTechnicalAdmin,
    });

    for (const request of requests) {
      await expectPublicHealthResponse(await healthyRoute.GET(request), 200, "healthy\n");
      await expectPublicHealthResponse(await unhealthyRoute.GET(request), 503, "unhealthy\n");
    }
  });

  test("does not require the optional Live Event runtime for core service readiness", async () => {
    expect(
      await isPubliclyHealthy({
        foundationStorage: readyFoundation,
        technicalAdminAuth: readyTechnicalAdmin,
      }),
    ).toBe(true);
  });

  test("does not treat unsafe authoritative write pressure as healthy", async () => {
    expect(
      await isPubliclyHealthy({
        foundationStorage: {
          readiness: async () => sqliteReadiness("unsafe"),
        },
        technicalAdminAuth: readyTechnicalAdmin,
      }),
    ).toBe(false);
  });

  test("fails closed when SQLite write pressure is unknown or absent", async () => {
    const readinessResults: FoundationStorageReadiness[] = [
      sqliteReadiness("unknown"),
      { ok: true, schemaVersion: "26", storage: "sqlite" },
    ];
    for (const readiness of readinessResults) {
      expect(
        await isPubliclyHealthy({
          foundationStorage: {
            readiness: async () => readiness,
          },
          technicalAdminAuth: readyTechnicalAdmin,
        }),
      ).toBe(false);
    }
  });
});
