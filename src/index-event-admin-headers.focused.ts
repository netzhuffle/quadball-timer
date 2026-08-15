import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Event Hub early response headers", () => {
  test("marks unauthenticated and unavailable early responses as sensitive", async () => {
    await withServer({}, async (serverUrl) => {
      const response = await fetch(new URL("/api/event-admin/hub?eventId=event", serverUrl));
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(await response.json()).toEqual({ error: "Authentication failed." });
    });

    await withServer({ incompleteGrantKeys: true }, async (serverUrl) => {
      const response = await fetch(new URL("/api/event-admin/hub?eventId=event", serverUrl));
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(await response.json()).toEqual({ error: "Authentication failed." });
    });
  });
});

describe("Pitch Manager early response headers", () => {
  test("keeps malformed, missing-credential, and missing-session failures sensitive", async () => {
    await withServer({}, async (serverUrl) => {
      const malformed = await fetch(new URL("/api/pitch-manager/admit", serverUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      await expectSensitiveFailure(malformed, 400, { error: "Unable to admit this Grant." });

      const missingCredential = await fetch(new URL("/api/pitch-manager/admit", serverUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      await expectSensitiveFailure(missingCredential, 400, {
        error: "Unable to admit this Grant.",
      });

      const missingBody = await fetch(new URL("/api/pitch-manager/admit", serverUrl), {
        method: "POST",
      });
      await expectSensitiveFailure(missingBody, 400, { error: "Unable to admit this Grant." });

      const missingSessionLeave = await fetch(new URL("/api/pitch-manager/leave", serverUrl), {
        method: "POST",
      });
      await expectSensitiveFailure(missingSessionLeave, 401, { error: "Authentication failed." });
    });

    await withServer({ incompleteGrantKeys: true }, async (serverUrl) => {
      const unavailableAdmit = await fetch(new URL("/api/pitch-manager/admit", serverUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ qrCredential: "opaque" }),
      });
      await expectSensitiveFailure(unavailableAdmit, 503, { error: "Authentication failed." });

      const unavailableLeave = await fetch(new URL("/api/pitch-manager/leave", serverUrl), {
        method: "POST",
      });
      await expectSensitiveFailure(unavailableLeave, 503, { error: "Authentication failed." });
    });
  });
});

async function expectSensitiveFailure(
  response: Response,
  status: number,
  body: Record<string, string>,
) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await response.json()).toEqual(body);
}

async function withServer(
  options: { incompleteGrantKeys?: boolean },
  work: (serverUrl: URL) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "quadball-event-admin-headers-"));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  Object.assign(environment, {
    NODE_ENV: "test",
    QUADBALL_ENVIRONMENT: "test",
    PUBLIC_ORIGIN: "https://localhost",
    WEBAUTHN_RP_ID: "localhost",
    PORT: "0",
    TECHNICAL_ADMIN_DATABASE: join(directory, "technical-admin.sqlite"),
  });
  delete environment.FOUNDATION_DATABASE;
  delete environment.GRANT_LOOKUP_KEY;
  delete environment.GRANT_AUDIT_KEY;
  delete environment.GRANT_ENCRYPTION_KEY;
  if (options.incompleteGrantKeys) environment.GRANT_ENCRYPTION_KEY = "00".repeat(32);

  const server = Bun.spawn([process.execPath, "run", "src/index.ts"], {
    cwd: process.cwd(),
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const serverUrl = await readServerUrl(server.stdout);
    await work(serverUrl);
  } finally {
    server.kill();
    await server.exited;
    rmSync(directory, { recursive: true, force: true });
  }
}

async function readServerUrl(stdout: ReadableStream<Uint8Array>): Promise<URL> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("Server exited before reporting its bound URL.");
      output += decoder.decode(value, { stream: true });
      const match = output.match(/Server running at (http:\/\/[^\s]+)/u);
      if (match?.[1]) return new URL(match[1]);
    }
  } finally {
    reader.releaseLock();
  }
}
