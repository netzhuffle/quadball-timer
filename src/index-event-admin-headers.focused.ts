import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { createGrantKeyRingDocument, writeGrantKeyRingFile } from "@/lib/grant-key-ring-custody";
import { SHARED_LIMITS } from "@/lib/validation-policy";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import { createEventCatalog, createFoundationEventCatalogStorage } from "@/lib/event-catalog";
import { createGrantAuthority } from "@/lib/grant-authority";
import { readGrantAuthorityOptions } from "@/lib/grant-runtime";
import { createEventAdministration } from "@/lib/event-administration";
import {
  createTechnicalAdminAuth,
  MemoryTechnicalAdminAuthRepository,
} from "@/lib/technical-admin-auth";
import {
  deriveGrantSessionCsrfToken,
  EVENT_ADMIN_CSRF_HEADER,
  PITCH_MANAGER_CSRF_HEADER,
  type GrantSessionCsrfRole,
} from "@/lib/grant-session-csrf";

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

describe("Event mutation request binding and CSRF", () => {
  test("admission issues role-separated readable CSRF companions beside HttpOnly bearers", async () => {
    await withServer({ seedGrants: true }, async (serverUrl, credentials) => {
      if (credentials === null) throw new Error("Expected seeded Grant credentials.");
      for (const role of ["event-admin", "pitch-manager"] as const) {
        const response = await fetch(new URL(`/api/${role}/admit`, serverUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ qrCredential: credentials[role] }),
        });
        expect(response.status).toBe(200);
        const cookies = response.headers.getAll("set-cookie");
        const bearer = cookies.find((cookie) => cookie.startsWith(`__Host-${role}-session=`));
        const csrf = cookies.find((cookie) => cookie.startsWith(`__Host-${role}-csrf=`));
        expect(bearer).toContain("HttpOnly");
        expect(csrf).not.toContain("HttpOnly");
        expect(csrf).toContain("Path=/");
        expect(csrf).toContain("Secure");
        expect(csrf).toContain("SameSite=Strict");
        const bearerValue = bearer?.split(";", 1)[0]?.split("=").slice(1).join("=");
        expect(csrf).not.toContain(bearerValue ?? "missing-bearer");
      }
    });
  });

  for (const role of ["event-admin", "pitch-manager"] as const) {
    test(`${role} mutations fail closed for missing or sibling Origin and invalid CSRF`, async () => {
      await withServer({}, async (serverUrl) => {
        const bearer = `${role}-session-a`;
        const validToken = deriveGrantSessionCsrfToken(role, bearer);
        const validHeaders = mutationHeaders(role, bearer, validToken);

        await expectGenericMutationFailure(
          await fetch(mutationUrl(serverUrl, role), {
            method: "POST",
            headers: withoutHeader(validHeaders, "origin"),
          }),
        );
        await expectGenericMutationFailure(
          await fetch(mutationUrl(serverUrl, role), {
            method: "POST",
            headers: { ...validHeaders, origin: "https://test.localhost" },
          }),
        );
        await expectGenericMutationFailure(
          await fetch(mutationUrl(serverUrl, role), {
            method: "POST",
            headers: withoutHeader(validHeaders, csrfHeader(role)),
          }),
        );
        await expectGenericMutationFailure(
          await fetch(mutationUrl(serverUrl, role), {
            method: "POST",
            headers: {
              ...validHeaders,
              [csrfHeader(role)]: deriveGrantSessionCsrfToken(role, `${role}-session-b`),
            },
          }),
        );
        await expectGenericMutationFailure(
          await fetch(mutationUrl(serverUrl, role), {
            method: "POST",
            headers: {
              ...validHeaders,
              [csrfHeader(role)]: deriveGrantSessionCsrfToken(otherRole(role), bearer),
            },
          }),
        );

        const authorityLayer = await fetch(mutationUrl(serverUrl, role), {
          method: "POST",
          headers: validHeaders,
        });
        expect(authorityLayer.status).toBe(404);
        expect(await authorityLayer.json()).toMatchObject({
          status: "rejected",
          reason: "not-found",
        });

        const readResponse = await fetch(readUrl(serverUrl, role), {
          headers: { cookie: `__Host-${role}-session=${bearer}` },
        });
        expect(await readResponse.json()).not.toEqual({ error: "Authentication failed." });
      });
    });
  }

  test("a weak Technical Admin fallback cannot use a valid Grant Session proof", async () => {
    await withServer({}, async (serverUrl) => {
      const bearer = "event-admin-session";
      await expectGenericMutationFailure(
        await fetch(mutationUrl(serverUrl, "event-admin"), {
          method: "POST",
          headers: {
            ...mutationHeaders(
              "event-admin",
              bearer,
              deriveGrantSessionCsrfToken("event-admin", bearer),
            ),
            cookie: `__Host-technical-admin=invalid-technical-session; __Host-event-admin-session=${bearer}`,
          },
        }),
      );
    });
  });

  test("Leave clears bearer and CSRF cookies together after the request boundary", async () => {
    await withServer({}, async (serverUrl) => {
      for (const role of ["event-admin", "pitch-manager"] as const) {
        const bearer = `${role}-session`;
        const response = await fetch(new URL(`/api/${role}/leave`, serverUrl), {
          method: "POST",
          headers: mutationHeaders(role, bearer, deriveGrantSessionCsrfToken(role, bearer)),
        });
        expect(response.status).toBe(401);
        const cookies = response.headers.getAll("set-cookie");
        expect(cookies).toHaveLength(2);
        expect(cookies.every((cookie) => cookie.includes("Path=/"))).toBe(true);
        expect(cookies.every((cookie) => cookie.includes("Max-Age=0"))).toBe(true);
        expect(cookies.every((cookie) => cookie.includes("Secure"))).toBe(true);
        expect(cookies.every((cookie) => cookie.includes("SameSite=Strict"))).toBe(true);
        expect(cookies.some((cookie) => cookie.includes(`__Host-${role}-session=`))).toBe(true);
        expect(cookies.some((cookie) => cookie.includes(`__Host-${role}-csrf=`))).toBe(true);
      }
    });
  });
});

function mutationUrl(serverUrl: URL, role: GrantSessionCsrfRole): URL {
  return new URL(
    role === "event-admin"
      ? "/api/event-admin/events/event/game-days/day/pitches/pitch/pitch-manager-grant"
      : "/api/pitch-manager/events/event/game-days/day/pitches/pitch/pitch-slots/slot/control-grant",
    serverUrl,
  );
}

function readUrl(serverUrl: URL, role: GrantSessionCsrfRole): URL {
  return new URL(
    role === "event-admin"
      ? "/api/event-admin/hub?eventId=event"
      : "/api/pitch-manager/view?eventId=event&gameDayId=day&pitchId=pitch",
    serverUrl,
  );
}

function mutationHeaders(
  role: GrantSessionCsrfRole,
  bearer: string,
  csrfToken: string,
): Record<string, string> {
  return {
    host: "localhost",
    origin: "https://localhost",
    cookie: `__Host-${role}-session=${bearer}`,
    [csrfHeader(role)]: csrfToken,
  };
}

function csrfHeader(role: GrantSessionCsrfRole): string {
  return role === "event-admin" ? EVENT_ADMIN_CSRF_HEADER : PITCH_MANAGER_CSRF_HEADER;
}

function otherRole(role: GrantSessionCsrfRole): GrantSessionCsrfRole {
  return role === "event-admin" ? "pitch-manager" : "event-admin";
}

function withoutHeader(headers: Record<string, string>, omitted: string): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name !== omitted));
}

async function expectGenericMutationFailure(response: Response) {
  await expectSensitiveFailure(response, 401, { error: "Authentication failed." });
}

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
  options: { incompleteGrantKeys?: boolean; seedGrants?: boolean },
  work: (
    serverUrl: URL,
    credentials: { "event-admin": string; "pitch-manager": string } | null,
  ) => Promise<void>,
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
  const credentials = options.seedGrants
    ? await seedGrantCredentials(directory, environment)
    : null;
  if (!options.seedGrants) delete environment.FOUNDATION_DATABASE;
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
    const serverUrl = await readServerUrl(server.stdout).catch(async (error) => {
      const stderr = await new Response(server.stderr).text();
      throw new Error(`${String(error)}\n${stderr}`);
    });
    await work(serverUrl, credentials);
  } finally {
    server.kill();
    await server.exited;
    rmSync(directory, { recursive: true, force: true });
  }
}

async function seedGrantCredentials(
  directory: string,
  environment: Record<string, string>,
): Promise<{ "event-admin": string; "pitch-manager": string }> {
  const databasePath = join(directory, "foundation.sqlite");
  environment.FOUNDATION_DATABASE = databasePath;
  const grantOptions = readGrantAuthorityOptions("test", environment);
  const storage = openSqliteFoundationStorage(databasePath, {
    grantKeyRing: grantOptions.keyRing,
  });
  try {
    await storage.applyMigrations({ requireCandidate: false });
    const technicalAdminAuth = createTechnicalAdminAuth(
      { environment: "test", origin: "https://localhost", rpId: "localhost" },
      new MemoryTechnicalAdminAuthRepository(),
    );
    const technical = technicalAdminAuth.resolveHostLocalAuthority();
    const catalog = createEventCatalog(createFoundationEventCatalogStorage(storage), {});
    const grants = createGrantAuthority(storage, grantOptions);
    const administration = createEventAdministration({ storage, grants, catalog });
    const event = await catalog.createEvent({ name: "CSRF fixture", timeZone: "UTC" }, technical);
    if (event.status !== "accepted") throw new Error("Expected seeded Event.");
    const day = await catalog.addGameDay(event.value.eventId, { date: "2026-08-24" }, technical);
    const pitch = await catalog.createPitch(event.value.eventId, { name: "Pitch" }, technical);
    if (day.status !== "accepted" || pitch.status !== "accepted")
      throw new Error("Expected seeded Event structure.");
    const eventAdmin = await administration.createEventAdminGrant(event.value.eventId, technical);
    const pitchManager = await administration.createPitchManagerGrant(
      event.value.eventId,
      day.value.gameDayId,
      pitch.value.pitchId,
      technical,
    );
    if (eventAdmin.status !== "accepted" || pitchManager.status !== "accepted")
      throw new Error("Expected seeded Grants.");
    const eventAdminSecret = await grants.revealGrant(eventAdmin.value.grantId, technical);
    const pitchManagerSecret = await grants.revealGrant(pitchManager.value.grantId, technical);
    if (eventAdminSecret.status !== "revealed" || pitchManagerSecret.status !== "revealed")
      throw new Error("Expected seeded Grant credentials.");
    technicalAdminAuth.close();
    return {
      "event-admin": eventAdminSecret.qrCredential,
      "pitch-manager": pitchManagerSecret.qrCredential,
    };
  } finally {
    storage.close();
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
