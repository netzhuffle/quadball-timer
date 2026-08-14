import { describe, expect, test } from "bun:test";
import {
  createEventCatalog,
  createInMemoryEventCatalogStorage,
  type InMemoryEventCatalogStorage,
} from "@/lib/event-catalog";
import {
  MemoryTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
  type WebAuthnVerifier,
} from "@/lib/technical-admin-auth";

const authority = createTechnicalAdminAuth(
  { environment: "test", origin: "https://timer.example", rpId: "timer.example" },
  new MemoryTechnicalAdminAuthRepository(),
).resolveHostLocalAuthority();
const untrustedAuthority = { kind: "event-admin" } as unknown as typeof authority;

function createFixture(storage: InMemoryEventCatalogStorage = createInMemoryEventCatalogStorage()) {
  let nowMs = Date.UTC(2026, 7, 14, 12);
  let nextId = 0;
  const catalog = createEventCatalog(storage, {
    clock: { nowMs: () => nowMs },
    ids: { next: (kind) => `${kind}-${++nextId}` },
  });
  return {
    catalog,
    advanceTo: (value: number) => (nowMs = value),
    storage,
  };
}

describe("Event operations catalog", () => {
  test("creates a blank Unpublished Event and classifies Game Days in the Event timezone", async () => {
    const fixture = createFixture();
    const created = await fixture.catalog.createEvent(
      { name: "SQM 2026", timeZone: "Europe/Zurich" },
      authority,
    );
    expect(created.status).toBe("accepted");
    if (created.status !== "accepted") return;
    expect(created.value).toMatchObject({
      eventId: "event-1",
      name: "SQM 2026",
      timeZone: "Europe/Zurich",
      publicationStatus: "unpublished",
      gameDays: [],
      lifecycle: "unscheduled",
    });

    const days = await fixture.catalog.addGameDay(
      created.value.eventId,
      { date: "2026-08-13" },
      authority,
    );
    expect(days.status).toBe("accepted");
    const second = await fixture.catalog.addGameDay(
      created.value.eventId,
      { date: "2026-08-14" },
      authority,
    );
    expect(second.status).toBe("accepted");
    const third = await fixture.catalog.addGameDay(
      created.value.eventId,
      { date: "2026-08-15" },
      authority,
    );
    expect(third.status).toBe("accepted");

    const inspected = await fixture.catalog.inspectEvent(created.value.eventId, authority);
    expect(inspected.status).toBe("accepted");
    if (inspected.status !== "accepted") return;
    expect(inspected.value.lifecycle).toBe("current");
    expect(inspected.value.gameDays.map((day) => day.classification)).toEqual([
      "past",
      "current",
      "future",
    ]);
  });

  test("only the verified Technical Admin can mutate metadata and Game Days", async () => {
    const fixture = createFixture();
    expect(
      await fixture.catalog.createEvent({ name: "Private", timeZone: "UTC" }, untrustedAuthority),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });

    const created = await fixture.catalog.createEvent(
      { name: "Private", timeZone: "UTC" },
      authority,
    );
    if (created.status !== "accepted") throw new Error("Expected Event creation.");
    expect(
      await fixture.catalog.updateEvent(
        created.value.eventId,
        { name: "Changed" },
        untrustedAuthority,
      ),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
    expect(
      await fixture.catalog.addGameDay(
        created.value.eventId,
        { date: "2026-08-14" },
        untrustedAuthority,
      ),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
  });

  test("rejects forged authority JSON and raw session tokens at the catalog boundary", async () => {
    const fixture = createFixture();
    expect(
      await fixture.catalog.createEvent({ name: "Forged", timeZone: "UTC" }, {
        kind: "technical-admin",
        environment: "test",
        sessionId: "forged",
      } as never),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
    expect(
      await fixture.catalog.createEvent(
        { name: "Raw token", timeZone: "UTC" },
        "raw-session-token" as never,
      ),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
  });

  test("accepts a live authority minted by TechnicalAdminAuth", async () => {
    const binding = { origin: "https://timer.example", host: "timer.example" };
    const verifier: WebAuthnVerifier = {
      async verifyRegistration() {
        return {
          credentialId: "credential-live",
          publicKey: { kty: "OKP", crv: "Ed25519", x: "public-key" },
          signCount: 1,
        };
      },
      async verifyAuthentication() {
        return { signCount: 2 };
      },
    };
    const auth = createTechnicalAdminAuth(
      { environment: "test", origin: binding.origin, rpId: "timer.example" },
      new MemoryTechnicalAdminAuthRepository(),
      verifier,
      () => 1_000,
    );
    const enrollment = auth.issueEnrollmentAuthorization();
    if (!enrollment.ok) throw new Error("Expected enrollment authorization.");
    const enrollmentToken = decodeURIComponent(enrollment.value.url.split("token=")[1] ?? "");
    const enrollmentOptions = auth.beginEnrollment(enrollmentToken, binding);
    if (!enrollmentOptions.ok) throw new Error("Expected enrollment options.");
    expect(await auth.completeEnrollment(enrollmentOptions.value.challengeId, {}, binding)).toEqual(
      {
        ok: true,
        value: undefined,
      },
    );
    const authenticationOptions = auth.beginAuthentication(binding);
    if (!authenticationOptions.ok) throw new Error("Expected authentication options.");
    const session = await auth.completeAuthentication(
      authenticationOptions.value.challengeId,
      {},
      binding,
    );
    if (!session.ok) throw new Error("Expected live session.");
    const liveAuthority = auth.resolveCurrentAuthority(session.value.token);
    expect(liveAuthority).not.toBeNull();
    if (liveAuthority === null) return;

    const catalog = createEventCatalog(createInMemoryEventCatalogStorage(), {
      clock: { nowMs: () => 1_000 },
    });
    expect(
      await catalog.createEvent({ name: "Live authority", timeZone: "UTC" }, liveAuthority),
    ).toMatchObject({ status: "accepted" });
  });

  test("classifies the gap between Game Days and a zero-Day Event explicitly", async () => {
    const fixture = createFixture();
    const created = await fixture.catalog.createEvent(
      { name: "Gap", timeZone: "Europe/Zurich" },
      authority,
    );
    if (created.status !== "accepted") throw new Error("Expected Event.");
    const first = await fixture.catalog.addGameDay(
      created.value.eventId,
      { date: "2026-08-13" },
      authority,
    );
    const second = await fixture.catalog.addGameDay(
      created.value.eventId,
      { date: "2026-08-15" },
      authority,
    );
    if (first.status !== "accepted" || second.status !== "accepted") {
      throw new Error("Expected Game Days.");
    }
    const inGap = await fixture.catalog.inspectEvent(created.value.eventId, authority);
    expect(inGap.status).toBe("accepted");
    if (inGap.status !== "accepted") return;
    expect(inGap.value.lifecycle).toBe("future");
    expect(inGap.value.gameDays.map((day) => day.classification)).toEqual(["past", "future"]);

    fixture.advanceTo(Date.UTC(2026, 7, 16, 12));
    const after = await fixture.catalog.inspectEvent(created.value.eventId, authority);
    expect(after.status).toBe("accepted");
    if (after.status !== "accepted") return;
    expect(after.value.lifecycle).toBe("past");
  });

  test("keeps no-change updates out of state timestamps and audit", async () => {
    const fixture = createFixture();
    const created = await fixture.catalog.createEvent(
      { name: "Stable", timeZone: "UTC" },
      authority,
    );
    if (created.status !== "accepted") throw new Error("Expected Event.");
    const day = await fixture.catalog.addGameDay(
      created.value.eventId,
      { date: "2026-08-14" },
      authority,
    );
    if (day.status !== "accepted") throw new Error("Expected Game Day.");
    const before = await fixture.catalog.inspectEvent(created.value.eventId, authority);
    if (before.status !== "accepted") throw new Error("Expected inspection.");

    fixture.advanceTo(Date.UTC(2026, 7, 15, 12));
    expect(
      await fixture.catalog.updateEvent(
        created.value.eventId,
        { name: "Stable", timeZone: "UTC" },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "no-change" });
    expect(
      await fixture.catalog.updateGameDay(
        created.value.eventId,
        day.value.gameDayId,
        { date: "2026-08-14" },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "no-change" });
    const after = await fixture.catalog.inspectEvent(created.value.eventId, authority);
    expect(after.status).toBe("accepted");
    if (after.status !== "accepted") return;
    expect(after.value.createdAtMs).toBe(before.value.createdAtMs);
    expect(after.value.updatedAtMs).toBe(before.value.updatedAtMs);
    expect(after.value.gameDays[0]?.updatedAtMs).toBe(before.value.gameDays[0]?.updatedAtMs);
    expect(after.value.auditTrail).toEqual(before.value.auditTrail);
  });

  test("uses the configured timezone at a DST-relevant date boundary", async () => {
    const fixture = createFixture();
    const created = await fixture.catalog.createEvent(
      { name: "DST", timeZone: "America/New_York" },
      authority,
    );
    if (created.status !== "accepted") throw new Error("Expected Event.");
    const day = await fixture.catalog.addGameDay(
      created.value.eventId,
      { date: "2026-03-08" },
      authority,
    );
    if (day.status !== "accepted") throw new Error("Expected Game Day.");

    fixture.advanceTo(Date.UTC(2026, 2, 8, 4, 59));
    const beforeMidnight = await fixture.catalog.inspectEvent(created.value.eventId, authority);
    expect(beforeMidnight.status).toBe("accepted");
    if (beforeMidnight.status !== "accepted") return;
    expect(beforeMidnight.value.lifecycle).toBe("future");

    fixture.advanceTo(Date.UTC(2026, 2, 8, 5, 0));
    const afterMidnight = await fixture.catalog.inspectEvent(created.value.eventId, authority);
    expect(afterMidnight.status).toBe("accepted");
    if (afterMidnight.status !== "accepted") return;
    expect(afterMidnight.value.lifecycle).toBe("current");
    expect(afterMidnight.value.gameDays[0]?.classification).toBe("current");
  });

  test("rejects duplicates and cross-Event Game Day references without mutation", async () => {
    const fixture = createFixture();
    const first = await fixture.catalog.createEvent({ name: "One", timeZone: "UTC" }, authority);
    const second = await fixture.catalog.createEvent({ name: "Two", timeZone: "UTC" }, authority);
    if (first.status !== "accepted" || second.status !== "accepted") {
      throw new Error("Expected Events.");
    }
    const day = await fixture.catalog.addGameDay(
      first.value.eventId,
      { date: "2026-08-14" },
      authority,
    );
    if (day.status !== "accepted") throw new Error("Expected Game Day.");
    expect(
      await fixture.catalog.addGameDay(first.value.eventId, { date: "2026-08-14" }, authority),
    ).toMatchObject({ status: "rejected", reason: "duplicate" });
    expect(
      await fixture.catalog.updateGameDay(
        second.value.eventId,
        day.value.gameDayId,
        { date: "2026-08-15" },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "cross-event" });
    const inspected = await fixture.catalog.inspectEvent(first.value.eventId, authority);
    expect(inspected.status).toBe("accepted");
    if (inspected.status !== "accepted") return;
    expect(inspected.value.gameDays).toHaveLength(1);
    expect(inspected.value.gameDays[0]?.date).toBe("2026-08-14");
  });

  test("commits catalog state and its Event Administration Audit Trail atomically", async () => {
    const fixture = createFixture();
    const created = await fixture.catalog.createEvent(
      { name: "Atomic", timeZone: "UTC" },
      authority,
    );
    if (created.status !== "accepted") throw new Error("Expected Event creation.");
    const before = await fixture.catalog.inspectEvent(created.value.eventId, authority);
    expect(before.status).toBe("accepted");

    fixture.storage.failNextTransaction(new Error("disk full"));
    expect(
      await fixture.catalog.addGameDay(created.value.eventId, { date: "2026-08-14" }, authority),
    ).toMatchObject({ status: "retryable-failure" });

    const after = await fixture.catalog.inspectEvent(created.value.eventId, authority);
    expect(after.status).toBe("accepted");
    if (after.status !== "accepted") return;
    expect(after.value.gameDays).toHaveLength(0);
    expect(after.value.auditTrail).toHaveLength(1);
  });

  test("removes only an empty Event and retains audit evidence", async () => {
    const fixture = createFixture();
    const created = await fixture.catalog.createEvent(
      { name: "Remove me", timeZone: "UTC" },
      authority,
    );
    if (created.status !== "accepted") throw new Error("Expected Event creation.");
    const day = await fixture.catalog.addGameDay(
      created.value.eventId,
      { date: "2026-08-14" },
      authority,
    );
    if (day.status !== "accepted") throw new Error("Expected Game Day.");
    expect(await fixture.catalog.removeEvent(created.value.eventId, authority)).toMatchObject({
      status: "rejected",
      reason: "in-use",
    });
    expect(
      await fixture.catalog.removeGameDay(created.value.eventId, day.value.gameDayId, authority),
    ).toMatchObject({
      status: "accepted",
    });
    expect(await fixture.catalog.removeEvent(created.value.eventId, authority)).toMatchObject({
      status: "accepted",
    });
    expect(await fixture.catalog.inspectEvent(created.value.eventId, authority)).toMatchObject({
      status: "rejected",
      reason: "not-found",
    });
  });
});
