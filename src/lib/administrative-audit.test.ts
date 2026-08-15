import { describe, expect, test } from "bun:test";
import { createAdministrativeAuditProjection } from "@/lib/administrative-audit";
import { createEventAdministration } from "@/lib/event-administration";
import { createEventCatalog, createFoundationEventCatalogStorage } from "@/lib/event-catalog";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import { createGrantAuthority, createGrantAuthorityVerifier } from "@/lib/grant-authority";
import type { FoundationStorage } from "@/lib/foundation-storage";
import type { ControlGrantScopeResolver, GrantKeyRing } from "@/lib/grant-types";
import {
  MemoryTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
  isTechnicalAdminAuthority,
} from "@/lib/technical-admin-auth";

const keyRing: GrantKeyRing = {
  encryption: { currentVersion: "v1", keys: new Map([["v1", bytes(1)]]) },
  lookup: { currentVersion: "v1", keys: new Map([["v1", bytes(2)]]) },
  audit: { currentVersion: "v1", keys: new Map([["v1", bytes(3)]]) },
};

describe("privileged administrative audit projections", () => {
  test("exposes separate allowlisted Event and Grant evidence without secrets", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Audit Event", timeZone: "Europe/Zurich" },
      fixture.technical,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    const day = await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-14" },
      fixture.technical,
    );
    if (day.status !== "accepted") throw new Error("Expected Game Day.");
    await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-15" },
      fixture.technical,
    );
    const created = await fixture.administration.createEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    if (created.status !== "accepted") throw new Error("Expected Event Admin Grant.");
    const revealed = await fixture.grants.revealGrant(created.value.grantId, fixture.technical);
    if (revealed.status !== "revealed")
      throw new Error(`Expected Grant reveal: ${JSON.stringify(revealed)}`);
    const admitted = await fixture.administration.admitEventAdmin({
      qrCredential: revealed.qrCredential,
      browserContext: "audit-browser",
    });
    if (admitted.status !== "admitted") throw new Error("Expected Event Admin session.");

    const eventAudit = await fixture.projection.read({
      projection: "event-administration",
      eventId: event.value.eventId,
      authority: fixture.technical,
    });
    expect(eventAudit.status).toBe("accepted");
    if (eventAudit.status !== "accepted") throw new Error("Expected Event audit.");
    expect(eventAudit.value.entries.length).toBeGreaterThan(0);
    expect(eventAudit.value.entries[0]?.evidenceType).toBe("event-administration");
    expect(JSON.stringify(eventAudit)).not.toContain("qrCredential");
    expect(JSON.stringify(eventAudit)).not.toContain("ciphertext");
    expect(eventAudit.value.entries[0]).toHaveProperty("before");
    expect(eventAudit.value.entries[0]).toHaveProperty("after");

    const grantAudit = await fixture.projection.read({
      projection: "grant",
      eventId: event.value.eventId,
      authority: { kind: "grant-session", sessionBearer: admitted.sessionBearer },
    });
    expect(grantAudit.status).toBe("accepted");
    if (grantAudit.status !== "accepted") throw new Error("Expected Grant audit.");
    expect(grantAudit.value.entries.length).toBeGreaterThan(0);
    expect(grantAudit.value.entries[0]).toMatchObject({
      evidenceType: "grant",
      grantId: created.value.grantId,
    });
    expect(JSON.stringify(grantAudit)).not.toContain(revealed.qrCredential);
    expect(JSON.stringify(grantAudit)).not.toContain("lookupDigest");
    expect(JSON.stringify(grantAudit)).not.toContain("encryptionKeyVersion");
    expect(grantAudit.value.entries[0]).toHaveProperty("links");

    const stateBefore = await snapshotGrantState(fixture.storage, created.value.grantId);
    fixture.setNow(Date.parse("2026-08-14T12:00:05Z"));
    const readAfterClockAdvance = await fixture.projection.read({
      projection: "grant",
      eventId: event.value.eventId,
      authority: { kind: "grant-session", sessionBearer: admitted.sessionBearer },
    });
    expect(readAfterClockAdvance.status).toBe("accepted");
    const stateAfter = await snapshotGrantState(fixture.storage, created.value.grantId);
    expect(stateAfter).toEqual(stateBefore);
    expect(stateAfter.sessions[0]?.lastActiveAtMs).toBe(stateBefore.sessions[0]?.lastActiveAtMs);
  });

  test("keeps pagination stable and rejects lower audiences without evidence enumeration", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Paged Audit Event", timeZone: "UTC" },
      fixture.technical,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    const day = await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-14" },
      fixture.technical,
    );
    if (day.status !== "accepted") throw new Error("Expected Game Day.");
    const grant = await fixture.administration.createEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    if (grant.status !== "accepted") throw new Error("Expected Grant.");
    await fixture.catalog.changePublicationStatus(
      event.value.eventId,
      { status: "published" },
      fixture.technical,
    );

    const first = await fixture.projection.read({
      projection: "event-administration",
      eventId: event.value.eventId,
      authority: fixture.technical,
      limit: 1,
    });
    expect(first).toMatchObject({ status: "accepted", value: { entries: [{}], hasMore: true } });
    if (first.status !== "accepted" || first.value.nextCursor === null)
      throw new Error("Expected an opaque next cursor.");
    expect(first.value.nextCursor).not.toContain(event.value.eventId);
    const second = await fixture.projection.read({
      projection: "event-administration",
      eventId: event.value.eventId,
      authority: fixture.technical,
      limit: 1,
      cursor: first.value.nextCursor,
    });
    expect(second).toMatchObject({ status: "accepted", value: { entries: [{}] } });
    if (second.status !== "accepted") throw new Error("Expected second page.");
    expect(second.value.entries[0]?.evidenceId).not.toBe(first.value.entries[0]?.evidenceId);
    const cursor = first.value.nextCursor;
    if (cursor === null) throw new Error("Expected an opaque cursor.");
    for (const mismatchedQuery of [
      { eventId: "different-event" },
      { eventId: event.value.eventId, action: "event-created" },
      { eventId: event.value.eventId, direction: "ascending" },
    ]) {
      expect(
        await fixture.projection.read({
          projection: "event-administration",
          eventId: mismatchedQuery.eventId,
          authority: fixture.technical,
          limit: 1,
          cursor,
          action: mismatchedQuery.action,
          direction: mismatchedQuery.direction,
        }),
      ).toEqual({
        status: "rejected",
        reason: "invalid-input",
        detail: "Audit cursor is invalid.",
      });
    }
    expect(
      await fixture.projection.read({
        projection: "grant",
        eventId: event.value.eventId,
        authority: fixture.technical,
        limit: 1,
        cursor,
      }),
    ).toEqual({
      status: "rejected",
      reason: "invalid-input",
      detail: "Audit cursor is invalid.",
    });

    const filtered = await fixture.projection.read({
      projection: "event-administration",
      eventId: event.value.eventId,
      authority: fixture.technical,
      action: "event-created",
      limit: "100",
    });
    expect(filtered).toMatchObject({
      status: "accepted",
      value: { entries: [{ action: "event-created" }] },
    });
    const bounded = await fixture.projection.read({
      projection: "event-administration",
      eventId: event.value.eventId,
      authority: fixture.technical,
      limit: 101,
    });
    expect(bounded).toEqual({
      status: "rejected",
      reason: "invalid-input",
      detail: "Audit page size is invalid.",
    });
    expect(
      await fixture.projection.read({
        projection: "event-administration",
        eventId: event.value.eventId,
        authority: fixture.technical,
        grantId: "unsupported",
      }),
    ).toEqual({
      status: "rejected",
      reason: "invalid-input",
      detail: "Audit filter is unsupported for this projection.",
    });

    const completeAscending = await fixture.projection.read({
      projection: "event-administration",
      eventId: event.value.eventId,
      authority: fixture.technical,
      direction: "ascending",
      limit: 100,
    });
    expect(completeAscending.status).toBe("accepted");
    if (completeAscending.status !== "accepted") throw new Error("Expected complete page.");
    expect(new Set(completeAscending.value.entries.map((entry) => entry.occurredAtMs)).size).toBe(
      1,
    );
    const pagedAscending: string[] = [];
    let ascendingCursor: string | null = null;
    do {
      const page = await fixture.projection.read({
        projection: "event-administration",
        eventId: event.value.eventId,
        authority: fixture.technical,
        direction: "ascending",
        limit: 1,
        cursor: ascendingCursor ?? undefined,
      });
      expect(page.status).toBe("accepted");
      if (page.status !== "accepted") throw new Error("Expected ascending page.");
      pagedAscending.push(...page.value.entries.map((entry) => entry.evidenceId));
      ascendingCursor = page.value.nextCursor;
    } while (ascendingCursor !== null);
    expect(pagedAscending).toEqual(
      completeAscending.value.entries.map((entry) => entry.evidenceId),
    );

    const rejected = await fixture.projection.read({
      projection: "event-administration",
      eventId: event.value.eventId,
      authority: { kind: "grant-session", sessionBearer: "pitch-manager-bearer" },
    });
    expect(rejected).toEqual({
      status: "rejected",
      reason: "unauthorized",
      detail: "Unable to read administrative evidence.",
    });
  });

  test("collapses stale authority and read failures to safe outcomes", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Stale Audit Event", timeZone: "Europe/Zurich" },
      fixture.technical,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-14" },
      fixture.technical,
    );
    await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-15" },
      fixture.technical,
    );
    const grant = await fixture.administration.createEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    if (grant.status !== "accepted") throw new Error("Expected Grant.");
    const qr = await fixture.grants.revealGrant(grant.value.grantId, fixture.technical);
    if (qr.status !== "revealed") throw new Error("Expected Grant reveal.");
    const session = await fixture.administration.admitEventAdmin({
      qrCredential: qr.qrCredential,
      browserContext: "stale-audit-browser",
    });
    if (session.status !== "admitted") throw new Error("Expected session.");
    fixture.setNow(Date.parse("2026-08-22T03:00:00Z"));
    expect(
      await fixture.projection.read({
        projection: "grant",
        eventId: event.value.eventId,
        authority: { kind: "grant-session", sessionBearer: session.sessionBearer },
      }),
    ).toEqual({
      status: "rejected",
      reason: "unauthorized",
      detail: "Unable to read administrative evidence.",
    });

    const failedFixture = createFixture();
    failedFixture.storage.close();
    expect(
      await failedFixture.projection.read({
        projection: "event-administration",
        eventId: "event-read-failure",
        authority: failedFixture.technical,
      }),
    ).toEqual({ status: "unavailable", detail: "Administrative evidence is unavailable." });
  });

  test("denies real admitted Pitch Manager and Controller authorities generically", async () => {
    const fixture = createFixture(undefined, {
      resolve: () => ({ status: "eligible", eventGameId: "controller-game" }),
    });
    const event = await fixture.catalog.createEvent(
      { name: "Authority Boundary Event", timeZone: "UTC" },
      fixture.technical,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    const day = await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-14" },
      fixture.technical,
    );
    const pitch = await fixture.catalog.createPitch(
      event.value.eventId,
      { name: "Pitch A" },
      fixture.technical,
    );
    if (day.status !== "accepted" || pitch.status !== "accepted")
      throw new Error("Expected schedule structure.");
    const eventGrant = await fixture.administration.createEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    if (eventGrant.status !== "accepted") throw new Error("Expected Event Admin Grant.");
    const eventQr = await fixture.grants.revealGrant(eventGrant.value.grantId, fixture.technical);
    if (eventQr.status !== "revealed") throw new Error("Expected Event Admin QR.");
    const eventSession = await fixture.administration.admitEventAdmin({
      qrCredential: eventQr.qrCredential,
      browserContext: "authority-event-admin",
    });
    if (eventSession.status !== "admitted") throw new Error("Expected Event Admin session.");
    const eventAuthority = {
      kind: "grant-session" as const,
      sessionBearer: eventSession.sessionBearer,
    };
    const managerGrant = await fixture.administration.createPitchManagerGrant(
      event.value.eventId,
      day.value.gameDayId,
      pitch.value.pitchId,
      eventAuthority,
    );
    if (managerGrant.status !== "accepted") throw new Error("Expected Pitch Manager Grant.");
    const managerQr = await fixture.grants.revealGrant(managerGrant.value.grantId, eventAuthority);
    if (managerQr.status !== "revealed") throw new Error("Expected Pitch Manager QR.");
    const managerSession = await fixture.administration.admitPitchManager({
      qrCredential: managerQr.qrCredential,
      browserContext: "authority-pitch-manager",
    });
    if (managerSession.status !== "admitted") throw new Error("Expected Pitch Manager session.");
    const slot = await fixture.catalog.createGameplaySlot(
      event.value.eventId,
      day.value.gameDayId,
      { sequence: 1, scheduledStart: "2026-08-14T10:00" },
      fixture.technical,
    );
    if (slot.status !== "accepted") throw new Error("Expected Gameplay Slot.");
    const pitchSlot = await fixture.storage.transaction(
      (transaction) => transaction.listPitchSlots(day.value.gameDayId, pitch.value.pitchId)[0],
    );
    if (pitchSlot === undefined) throw new Error("Expected Pitch Slot.");
    const control = await fixture.grants.createControlGrant({
      authority: { kind: "grant-session", sessionBearer: managerSession.sessionBearer },
      scope: {
        eventId: event.value.eventId,
        gameDayId: day.value.gameDayId,
        pitchId: pitch.value.pitchId,
        pitchSlotId: pitchSlot.pitchSlotId,
      },
    });
    if (control.status !== "created") throw new Error("Expected Control Grant.");
    const controlQr = await fixture.grants.revealGrant(control.grantId, fixture.technical);
    if (controlQr.status !== "revealed") throw new Error("Expected Control Grant QR.");
    const controllerSession = await fixture.administration.admitControlGrant({
      qrCredential: controlQr.qrCredential,
      browserContext: "authority-controller",
    });
    if (controllerSession.status !== "admitted") throw new Error("Expected Controller session.");
    for (const authority of [managerSession.sessionBearer, controllerSession.sessionBearer]) {
      expect(
        await fixture.projection.read({
          projection: "grant",
          eventId: event.value.eventId,
          authority: { kind: "grant-session", sessionBearer: authority },
        }),
      ).toEqual({
        status: "rejected",
        reason: "unauthorized",
        detail: "Unable to read administrative evidence.",
      });
    }
  });
});

function createFixture(
  storage: FoundationStorage = createInMemoryFoundationStorage(),
  controlScopeResolver: ControlGrantScopeResolver = {
    resolve: () => ({ status: "unavailable" as const }),
  },
) {
  let nowMs = Date.parse("2026-08-14T12:00:00Z");
  let entropy = 7;
  const technical = createTechnicalAdminAuth(
    { environment: "test", origin: "https://timer.example", rpId: "timer.example" },
    new MemoryTechnicalAdminAuthRepository(),
  ).resolveHostLocalAuthority();
  const catalog = createEventCatalog(createFoundationEventCatalogStorage(storage), {
    clock: { nowMs: () => nowMs },
  });
  const grants = createGrantAuthority(storage, {
    environmentId: "test",
    clock: { nowMs: () => nowMs },
    randomness: {
      bytes: (length: number) => {
        const seed = entropy++;
        return Uint8Array.from({ length }, (_, index) => ((seed + index * 37) % 240) + 1);
      },
    },
    keyRing,
    controlScopeResolver,
    privilegedAuthorityVerifier: createGrantAuthorityVerifier((input) => {
      if (isTechnicalAdminAuthority(input)) return { kind: "technical-admin", id: input.sessionId };
      if (
        typeof input === "object" &&
        input !== null &&
        (input as { kind?: unknown }).kind === "grant-session" &&
        typeof (input as { sessionBearer?: unknown }).sessionBearer === "string"
      )
        return {
          kind: "grant-session",
          sessionBearer: (input as { sessionBearer: string }).sessionBearer,
          sessionId: "audit-session",
        };
      return null;
    }),
  });
  const administration = createEventAdministration({ storage, grants });
  const projection = createAdministrativeAuditProjection({ storage, grants });
  return {
    storage,
    technical,
    catalog,
    grants,
    administration,
    projection,
    setNow: (value: number) => (nowMs = value),
  };
}

function bytes(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}

async function snapshotGrantState(storage: FoundationStorage, grantId: string) {
  return storage.transaction((transaction) => ({
    grants: transaction.listGrants().filter((grant) => grant.grantId === grantId),
    sessions: transaction.listGrantSessions(grantId),
    audit: transaction.listGrantAudit(grantId),
  }));
}
