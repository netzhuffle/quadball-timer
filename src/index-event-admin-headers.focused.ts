import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { createGrantKeyRingDocument, writeGrantKeyRingFile } from "@/lib/grant-key-ring-custody";
import { SHARED_LIMITS } from "@/lib/validation-policy";

const OVERSIZED_CREDENTIAL = "credential-must-not-be-echoed";

describe("Event Hub early response headers", () => {
  test("marks unauthenticated and unavailable early responses as sensitive", async () => {
    await withServer({}, async (serverUrl) => {
      const response = await fetch(new URL("/api/event-admin/hub?eventId=event", serverUrl));
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(await response.json()).toEqual({ error: "Authentication failed." });
    });

    await withServer({ incompleteGrantKeys: true }, async () => {});
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

  test("rejects an oversized admission body without echoing credentials", async () => {
    await withServer({}, async (serverUrl) => {
      const response = await fetch(new URL("/api/pitch-manager/admit", serverUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: credentialBodyWithByteLength(SHARED_LIMITS.transport.httpJsonBodyBytes + 1),
      });

      await expectOversizedCredentialFailure(response);
    });
  });
});

describe("Event Admin admission response headers", () => {
  test("keeps malformed and unavailable admission failures sensitive", async () => {
    await withServer({}, async (serverUrl) => {
      const malformed = await fetch(new URL("/api/event-admin/admit", serverUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      await expectSensitiveFailure(malformed, 400, { error: "Unable to admit this Grant." });

      const missingCredential = await fetch(new URL("/api/event-admin/admit", serverUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      await expectSensitiveFailure(missingCredential, 400, {
        error: "Unable to admit this Grant.",
      });
    });

    await withServer({ incompleteGrantKeys: true }, async (serverUrl) => {
      const unavailable = await fetch(new URL("/api/event-admin/admit", serverUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ qrCredential: "opaque" }),
      });
      await expectSensitiveFailure(unavailable, 503, { error: "Authentication failed." });
    });
  });

  test("accepts the exact body limit and rejects limit plus one without echoing credentials", async () => {
    await withServer({}, async (serverUrl) => {
      const exactLimit = await fetch(new URL("/api/event-admin/admit", serverUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: credentialBodyWithByteLength(SHARED_LIMITS.transport.httpJsonBodyBytes),
      });
      expect(exactLimit.status).toBe(401);
      expect(exactLimit.headers.get("cache-control")).toBe("no-store");
      expect(exactLimit.headers.get("referrer-policy")).toBe("no-referrer");
      expect(await exactLimit.text()).not.toContain(OVERSIZED_CREDENTIAL);

      const oversized = await fetch(new URL("/api/event-admin/admit", serverUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: credentialBodyWithByteLength(SHARED_LIMITS.transport.httpJsonBodyBytes + 1),
      });

      await expectOversizedCredentialFailure(oversized);
    });
  });
});

async function expectOversizedCredentialFailure(response: Response) {
  expect(response.status).toBe(413);
  expect(await response.text()).not.toContain(OVERSIZED_CREDENTIAL);
}

function credentialBodyWithByteLength(byteLength: number): string {
  const prefix = `{"qrCredential":"${OVERSIZED_CREDENTIAL}","padding":"`;
  const suffix = '"}';
  const body = `${prefix}${"x".repeat(byteLength - prefix.length - suffix.length)}${suffix}`;
  expect(new TextEncoder().encode(body).byteLength).toBe(byteLength);
  return body;
}

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
    GRANT_KEY_RING_FILE: join(directory, "grant-key-ring.json"),
  });
  const grantKeyRingPath = environment.GRANT_KEY_RING_FILE!;
  if (options.incompleteGrantKeys) {
    writeFileSync(grantKeyRingPath, "{}\n", { mode: 0o600 });
  } else {
    writeGrantKeyRingFile(grantKeyRingPath, createGrantKeyRingDocument("test"));
  }
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
    if (options.incompleteGrantKeys) {
      const exitCode = await Promise.race([server.exited, Bun.sleep(2_500).then(() => null)]);
      if (exitCode === null) server.kill();
      expect(exitCode).not.toBe(null);
      expect(exitCode).not.toBe(0);
      return;
    }
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
