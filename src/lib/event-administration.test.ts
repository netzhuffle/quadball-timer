import { describe, expect, test } from "bun:test";
import { createEventAdministration } from "@/lib/event-administration";
import { createEventCatalog, createFoundationEventCatalogStorage } from "@/lib/event-catalog";
import type { FoundationStorage } from "@/lib/foundation-storage";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import { createGrantAuthority, createGrantAuthorityVerifier } from "@/lib/grant-authority";
import type { GrantKeyRing } from "@/lib/grant-types";
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

describe("Event Administration handoff", () => {
  test("creates a secret-free handoff, admits a pseudonymous session, and opens the same Hub", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Two Day Event", timeZone: "Europe/Zurich" },
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

    const created = await fixture.administration.createEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    expect(created).toMatchObject({ status: "accepted", value: { status: "active" } });
    expect(JSON.stringify(created)).not.toContain("qrCredential");
    if (created.status !== "accepted") throw new Error("Expected Grant.");

    const grant = await fixture.grants.revealGrant(created.value.grantId, fixture.technical);
    if (grant.status !== "revealed") throw new Error("Expected Grant reveal.");
    const admission = await fixture.administration.admitEventAdmin({
      qrCredential: grant.qrCredential,
      browserContext: "browser-a",
      deviceClass: "mobile",
      browserClass: "safari",
    });
    expect(admission).toMatchObject({ status: "admitted", eventGameId: null });
    if (admission.status !== "admitted") return;

    const eventAdminHub = await fixture.administration.openEventHub({
      eventId: event.value.eventId,
      authority: { kind: "grant-session", sessionBearer: admission.sessionBearer },
    });
    expect(eventAdminHub).toMatchObject({
      status: "accepted",
      value: { authority: "event-admin", event: { eventId: event.value.eventId } },
    });
    const sessionBefore = await fixture.storage.transaction(
      (transaction) => transaction.listGrantSessions(created.value.grantId)[0],
    );
    expect(sessionBefore).not.toBeUndefined();
    if (sessionBefore === undefined) throw new Error("Expected Event Admin session.");
    const persistedExpiry = Math.min(
      created.value.expiresAtMs ?? Number.MAX_SAFE_INTEGER,
      sessionBefore.lastActiveAtMs + 30 * 24 * 60 * 60 * 1000,
    );
    fixture.setNow(sessionBefore.lastActiveAtMs + 60 * 60 * 1000);
    const advancedHub = await fixture.administration.openEventHub({
      eventId: event.value.eventId,
      authority: { kind: "grant-session", sessionBearer: admission.sessionBearer },
    });
    expect(advancedHub).toMatchObject({
      status: "accepted",
      value: { grantSessionExpiresAtMs: persistedExpiry },
    });
    const slotProjection = await fixture.administration.openSlotSetup(
      event.value.eventId,
      (
        await fixture.storage.transaction(
          (transaction) => transaction.listGameDays(event.value.eventId)[0],
        )
      )?.gameDayId ?? "",
      { kind: "grant-session", sessionBearer: admission.sessionBearer },
    );
    expect(slotProjection).toMatchObject({ status: "accepted" });
    const sessionAfter = await fixture.storage.transaction(
      (transaction) => transaction.listGrantSessions(created.value.grantId)[0],
    );
    expect(sessionAfter).toEqual(sessionBefore);
    const mutationNow = sessionBefore.lastActiveAtMs + 2 * 60 * 60 * 1000;
    fixture.setNow(mutationNow);
    const mutation = await fixture.administration.createEventTeam(
      event.value.eventId,
      { name: "Renewed by Mutation" },
      { kind: "grant-session", sessionBearer: admission.sessionBearer },
    );
    expect(mutation).toMatchObject({
      status: "accepted",
      sessionExpiresAtMs: Math.min(
        created.value.expiresAtMs ?? Number.MAX_SAFE_INTEGER,
        mutationNow + 30 * 24 * 60 * 60 * 1000,
      ),
    });
    const sessionAfterMutation = await fixture.storage.transaction(
      (transaction) => transaction.listGrantSessions(created.value.grantId)[0],
    );
    expect(sessionAfterMutation?.lastActiveAtMs).toBe(mutationNow);
    const technicalHub = await fixture.administration.openEventHub({
      eventId: event.value.eventId,
      authority: fixture.technical,
    });
    expect(technicalHub).toMatchObject({
      status: "accepted",
      value: { authority: "technical-admin", event: { eventId: event.value.eventId } },
    });
  });

  test("keeps delay previews read-only while revalidating the persisted Event Admin session", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Preview Event", timeZone: "UTC" },
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
      throw new Error("Expected schedule setup.");
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
    const game = await fixture.catalog.createEventGame(
      event.value.eventId,
      day.value.gameDayId,
      {
        gameplaySlotId: slot.value.gameplaySlotId,
        pitchSlotId: pitchSlot.pitchSlotId,
        sideA: { sourceLabel: "A" },
        sideB: { sourceLabel: "B" },
      },
      fixture.technical,
    );
    if (game.status !== "accepted") throw new Error("Expected Event Game.");
    const created = await fixture.administration.createEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    if (created.status !== "accepted") throw new Error("Expected Grant.");
    const revealed = await fixture.grants.revealGrant(created.value.grantId, fixture.technical);
    if (revealed.status !== "revealed") throw new Error("Expected Grant reveal.");
    const admitted = await fixture.administration.admitEventAdmin({
      qrCredential: revealed.qrCredential,
      browserContext: "preview-browser",
      deviceClass: "desktop",
      browserClass: "chromium",
    });
    if (admitted.status !== "admitted") throw new Error("Expected Event Admin admission.");
    const authority = { kind: "grant-session" as const, sessionBearer: admitted.sessionBearer };
    const beforeSession = await fixture.storage.transaction(
      (transaction) => transaction.listGrantSessions(created.value.grantId)[0],
    );
    const beforeAudit = await fixture.catalog.listAuditTrail(
      event.value.eventId,
      fixture.technical,
    );
    expect(
      await fixture.administration.previewGameplaySlotExpectedDelay(
        event.value.eventId,
        day.value.gameDayId,
        slot.value.gameplaySlotId,
        { expectedDelayMs: 5 * 60_000 },
        authority,
      ),
    ).toMatchObject({
      status: "accepted",
      value: {
        changes: [
          {
            eventGames: [
              { eventGameId: game.value.eventGameId, beforeExpectedStartMs: expect.any(Number) },
            ],
          },
        ],
      },
    });
    const afterSession = await fixture.storage.transaction(
      (transaction) => transaction.listGrantSessions(created.value.grantId)[0],
    );
    const afterAudit = await fixture.catalog.listAuditTrail(event.value.eventId, fixture.technical);
    expect(afterSession).toEqual(beforeSession);
    if (beforeAudit.status === "accepted" && afterAudit.status === "accepted")
      expect(afterAudit.value.length).toBe(beforeAudit.value.length);
    expect(
      await fixture.administration.previewPitchSlotExpectedDelay(
        event.value.eventId,
        day.value.gameDayId,
        pitchSlot.pitchSlotId,
        { expectedDelayMs: 3 * 60_000 },
        authority,
      ),
    ).toMatchObject({ status: "accepted", value: { changes: [{ afterDelayMs: 3 * 60_000 }] } });
  });

  test("rejects duplicate Event Admin creation without creating another authority", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Singular Event", timeZone: "UTC" },
      fixture.technical,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-14" },
      fixture.technical,
    );

    const first = await fixture.administration.createEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    const duplicate = await fixture.administration.createEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    expect(first).toMatchObject({ status: "accepted", value: { status: "active" } });
    expect(duplicate).toMatchObject({
      status: "rejected",
      reason: "invalid-input",
      detail: "An Event Admin Grant already exists for this Event.",
    });
    expect(
      await fixture.storage.transaction((transaction) =>
        transaction
          .listGrants()
          .filter(
            (grant) =>
              grant.grantType === "event-admin" && grant.scope.eventId === event.value.eventId,
          ),
      ),
    ).toHaveLength(1);
  });

  test("revokes stale sessions across disable/reactivate and expiry", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Lifecycle Event", timeZone: "UTC" },
      fixture.technical,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-14" },
      fixture.technical,
    );
    const created = await fixture.administration.createEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    if (created.status !== "accepted") throw new Error("Expected Grant.");
    const firstCredential = await fixture.grants.revealGrant(
      created.value.grantId,
      fixture.technical,
    );
    if (firstCredential.status !== "revealed") throw new Error("Expected reveal.");
    const firstAdmission = await fixture.administration.admitEventAdmin({
      qrCredential: firstCredential.qrCredential,
      browserContext: "lifecycle-browser",
    });
    if (firstAdmission.status !== "admitted") throw new Error("Expected admission.");

    expect(
      await fixture.administration.disableEventAdminGrant(event.value.eventId, fixture.technical),
    ).toMatchObject({ status: "accepted", value: { status: "updated" } });
    expect(
      await fixture.administration.openEventHub({
        eventId: event.value.eventId,
        authority: { kind: "grant-session", sessionBearer: firstAdmission.sessionBearer },
      }),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });

    expect(
      await fixture.administration.reactivateEventAdminGrant(
        event.value.eventId,
        fixture.technical,
      ),
    ).toMatchObject({ status: "accepted", value: { status: "updated" } });
    expect(
      await fixture.administration.openEventHub({
        eventId: event.value.eventId,
        authority: { kind: "grant-session", sessionBearer: firstAdmission.sessionBearer },
      }),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });

    const freshCredential = await fixture.grants.revealGrant(
      created.value.grantId,
      fixture.technical,
    );
    if (freshCredential.status !== "revealed") throw new Error("Expected fresh reveal.");
    const freshAdmission = await fixture.administration.admitEventAdmin({
      qrCredential: freshCredential.qrCredential,
      browserContext: "fresh-lifecycle-browser",
    });
    if (freshAdmission.status !== "admitted") throw new Error("Expected fresh admission.");
    expect(
      await fixture.administration.openEventHub({
        eventId: event.value.eventId,
        authority: { kind: "grant-session", sessionBearer: freshAdmission.sessionBearer },
      }),
    ).toMatchObject({ status: "accepted" });
    fixture.setNow(Date.parse("2026-09-20T12:00:00Z"));
    expect(
      await fixture.administration.openEventHub({
        eventId: event.value.eventId,
        authority: { kind: "grant-session", sessionBearer: freshAdmission.sessionBearer },
      }),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
  });

  test("rejects wrong-Event sessions and invalidates a rotated Grant before projection", async () => {
    const fixture = createFixture();
    const first = await fixture.catalog.createEvent(
      { name: "First", timeZone: "UTC" },
      fixture.technical,
    );
    const second = await fixture.catalog.createEvent(
      { name: "Second", timeZone: "UTC" },
      fixture.technical,
    );
    if (first.status !== "accepted" || second.status !== "accepted")
      throw new Error("Expected Events.");
    await fixture.catalog.addGameDay(
      first.value.eventId,
      { date: "2026-08-14" },
      fixture.technical,
    );
    await fixture.catalog.addGameDay(
      second.value.eventId,
      { date: "2026-08-14" },
      fixture.technical,
    );
    const grant = await fixture.grants.createEventAdminGrant({
      authority: fixture.technical,
      scope: { eventId: first.value.eventId, eventTimeZone: "UTC", finalGameDayDate: "2026-08-14" },
    });
    if (grant.status !== "created") throw new Error("Expected Grant.");
    const admission = await fixture.administration.admitEventAdmin({
      qrCredential: grant.qrCredential,
      browserContext: "browser-b",
    });
    if (admission.status !== "admitted") throw new Error("Expected admission.");

    expect(
      await fixture.administration.openEventHub({
        eventId: second.value.eventId,
        authority: { kind: "grant-session", sessionBearer: admission.sessionBearer },
      }),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
    expect(
      await fixture.administration.rotateEventAdminGrant(first.value.eventId, fixture.technical),
    ).toMatchObject({
      status: "accepted",
      value: { status: "updated" },
    });
    expect(
      await fixture.administration.openEventHub({
        eventId: first.value.eventId,
        authority: { kind: "grant-session", sessionBearer: admission.sessionBearer },
      }),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
  });

  test("explicitly revokes a newly admitted currently valid session", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Revoke Event", timeZone: "UTC" },
      fixture.technical,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-14" },
      fixture.technical,
    );
    const grant = await fixture.administration.createEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    if (grant.status !== "accepted") throw new Error("Expected Grant.");
    const reveal = await fixture.grants.revealGrant(grant.value.grantId, fixture.technical);
    if (reveal.status !== "revealed") throw new Error("Expected reveal.");
    const admission = await fixture.administration.admitEventAdmin({
      qrCredential: reveal.qrCredential,
      browserContext: "revoke-browser",
    });
    if (admission.status !== "admitted") throw new Error("Expected admission.");
    expect(
      await fixture.administration.openEventHub({
        eventId: event.value.eventId,
        authority: { kind: "grant-session", sessionBearer: admission.sessionBearer },
      }),
    ).toMatchObject({ status: "accepted" });
    expect(
      await fixture.administration.revokeEventAdminGrant(event.value.eventId, fixture.technical),
    ).toMatchObject({ status: "accepted", value: { status: "updated" } });
    expect(
      await fixture.administration.openEventHub({
        eventId: event.value.eventId,
        authority: { kind: "grant-session", sessionBearer: admission.sessionBearer },
      }),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
  });

  test("keeps Grant, session, audit, and catalog state unchanged on an injected transaction failure", async () => {
    const baseStorage = createInMemoryFoundationStorage();
    let failNext = false;
    const storage = new Proxy(baseStorage, {
      get(target, property, receiver) {
        if (property === "transaction") {
          return (work: Parameters<FoundationStorage["transaction"]>[0]) =>
            target.transaction((transaction) => {
              const result = work(transaction);
              if (failNext) {
                failNext = false;
                throw new Error("injected transaction failure");
              }
              return result;
            });
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as FoundationStorage;
    const fixture = createFixture(storage);
    const event = await fixture.catalog.createEvent(
      { name: "Failure Event", timeZone: "UTC" },
      fixture.technical,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-14" },
      fixture.technical,
    );
    const grant = await fixture.administration.createEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    if (grant.status !== "accepted") throw new Error("Expected Grant.");
    const reveal = await fixture.grants.revealGrant(grant.value.grantId, fixture.technical);
    if (reveal.status !== "revealed") throw new Error("Expected reveal.");
    const admission = await fixture.administration.admitEventAdmin({
      qrCredential: reveal.qrCredential,
      browserContext: "failure-browser",
    });
    if (admission.status !== "admitted") throw new Error("Expected admission.");
    const readState = () =>
      baseStorage.transaction((transaction) => ({
        grants: transaction.listGrants(),
        sessions: transaction.listGrantSessions(grant.value.grantId),
        grantAudit: transaction.listGrantAudit(grant.value.grantId),
        event: transaction.findEvent(event.value.eventId),
        gameDays: transaction.listGameDays(event.value.eventId),
        teams: transaction.listEventTeams(event.value.eventId),
        roster: transaction
          .listEventTeams(event.value.eventId)
          .flatMap((team) => transaction.listRoster(team.eventTeamId)),
        pitches: transaction.listPitches(event.value.eventId),
        eventAudit: transaction.listEventAuditTrail(event.value.eventId),
      }));
    const before = await readState();
    failNext = true;
    expect(
      await fixture.administration.createEventTeam(
        event.value.eventId,
        { name: "Should Roll Back" },
        { kind: "grant-session", sessionBearer: admission.sessionBearer },
      ),
    ).toMatchObject({ status: "retryable-failure" });
    expect(await readState()).toEqual(before);
  });

  test("does not retain a Pitch Manager Grant after its atomic handoff fails", async () => {
    const baseStorage = createInMemoryFoundationStorage();
    let failNext = false;
    const storage = new Proxy(baseStorage, {
      get(target, property, receiver) {
        if (property === "transaction") {
          return (work: Parameters<FoundationStorage["transaction"]>[0]) =>
            target.transaction((transaction) => {
              const result = work(transaction);
              if (failNext) {
                failNext = false;
                throw new Error("injected Pitch Manager handoff failure");
              }
              return result;
            });
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as FoundationStorage;
    const fixture = createFixture(storage);
    const event = await fixture.catalog.createEvent(
      { name: "Pitch Manager Failure Event", timeZone: "UTC" },
      fixture.technical,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    const day = await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-14" },
      fixture.technical,
    );
    const pitch = await fixture.administration.createPitch(
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
      browserContext: "pitch-manager-failure-browser",
    });
    if (eventSession.status !== "admitted") throw new Error("Expected Event Admin session.");
    const before = await baseStorage.transaction((transaction) => ({
      grants: transaction.listGrants(),
      sessions: transaction.listGrantSessions(eventGrant.value.grantId),
      audit: transaction.listGrantAudit(eventGrant.value.grantId),
    }));
    failNext = true;
    expect(
      await fixture.administration.createPitchManagerGrant(
        event.value.eventId,
        day.value.gameDayId,
        pitch.value.pitchId,
        { kind: "grant-session", sessionBearer: eventSession.sessionBearer },
      ),
    ).toMatchObject({ status: "retryable-failure" });
    expect(
      await baseStorage.transaction((transaction) => ({
        grants: transaction.listGrants(),
        sessions: transaction.listGrantSessions(eventGrant.value.grantId),
        audit: transaction.listGrantAudit(eventGrant.value.grantId),
      })),
    ).toEqual(before);
  });

  test("rejects forged Event Admin catalog authority and serializes revocation with mutation", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Authority Event", timeZone: "UTC" },
      fixture.technical,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-14" },
      fixture.technical,
    );
    const grant = await fixture.administration.createEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    if (grant.status !== "accepted") throw new Error("Expected Grant.");
    const reveal = await fixture.grants.revealGrant(grant.value.grantId, fixture.technical);
    if (reveal.status !== "revealed") throw new Error("Expected reveal.");
    const admission = await fixture.administration.admitEventAdmin({
      qrCredential: reveal.qrCredential,
      browserContext: "authority-browser",
    });
    if (admission.status !== "admitted") throw new Error("Expected admission.");
    const forged = {
      kind: "event-admin",
      eventId: event.value.eventId,
      sessionId: "forged-session",
    } as never;
    expect(
      await fixture.administration.createEventTeam(event.value.eventId, { name: "Forged" }, forged),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
    const sessionAuthority = {
      kind: "grant-session",
      sessionBearer: admission.sessionBearer,
    } as const;
    const mutation = await fixture.administration.createEventTeam(
      event.value.eventId,
      { name: "Race Team" },
      sessionAuthority,
    );
    const revoked = await fixture.administration.revokeEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    expect(revoked).toMatchObject({ status: "accepted" });
    expect(mutation).toMatchObject({ status: "accepted" });
    expect(
      await fixture.catalog.inspectEvent(event.value.eventId, fixture.technical),
    ).toMatchObject({
      status: "accepted",
      value: { teams: [{ name: "Race Team" }] },
    });
    expect(
      await fixture.administration.createEventTeam(
        event.value.eventId,
        { name: "After Revoke" },
        sessionAuthority,
      ),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });

    const rotatedEvent = await fixture.catalog.createEvent(
      { name: "Rotation Event", timeZone: "UTC" },
      fixture.technical,
    );
    if (rotatedEvent.status !== "accepted") throw new Error("Expected rotation Event.");
    await fixture.catalog.addGameDay(
      rotatedEvent.value.eventId,
      { date: "2026-08-14" },
      fixture.technical,
    );
    const rotatedGrant = await fixture.administration.createEventAdminGrant(
      rotatedEvent.value.eventId,
      fixture.technical,
    );
    if (rotatedGrant.status !== "accepted") throw new Error("Expected rotation Grant.");
    const rotatedReveal = await fixture.grants.revealGrant(
      rotatedGrant.value.grantId,
      fixture.technical,
    );
    if (rotatedReveal.status !== "revealed") throw new Error("Expected rotation reveal.");
    const rotatedAdmission = await fixture.administration.admitEventAdmin({
      qrCredential: rotatedReveal.qrCredential,
      browserContext: "rotation-browser",
    });
    if (rotatedAdmission.status !== "admitted") throw new Error("Expected rotation admission.");
    const rotationAuthority = {
      kind: "grant-session",
      sessionBearer: rotatedAdmission.sessionBearer,
    } as const;
    const rotated = await fixture.administration.rotateEventAdminGrant(
      rotatedEvent.value.eventId,
      fixture.technical,
    );
    const rotationMutation = await fixture.administration.createEventTeam(
      rotatedEvent.value.eventId,
      { name: "Rotation Race Team" },
      rotationAuthority,
    );
    expect(rotated).toMatchObject({ status: "accepted" });
    expect(rotationMutation).toMatchObject({ status: "rejected", reason: "unauthorized" });
    expect(
      await fixture.catalog.inspectEvent(rotatedEvent.value.eventId, fixture.technical),
    ).toMatchObject({
      status: "accepted",
      value: { teams: [] },
    });
    expect(
      await fixture.administration.createEventTeam(
        rotatedEvent.value.eventId,
        { name: "After Rotate" },
        rotationAuthority,
      ),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
  });

  test("preserves empty Event removal while rejecting removal of an attached Grant", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Attached Grant Event", timeZone: "UTC" },
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
    expect(
      await fixture.catalog.removeGameDay(
        event.value.eventId,
        day.value.gameDayId,
        fixture.technical,
      ),
    ).toMatchObject({ status: "accepted" });
    expect(await fixture.catalog.removeEvent(event.value.eventId, fixture.technical)).toMatchObject(
      {
        status: "rejected",
        reason: "in-use",
        detail: "Event has an attached Event Admin Grant.",
      },
    );
    const empty = await fixture.catalog.createEvent(
      { name: "No Grant Event", timeZone: "UTC" },
      fixture.technical,
    );
    if (empty.status !== "accepted") throw new Error("Expected empty Event.");
    expect(await fixture.catalog.removeEvent(empty.value.eventId, fixture.technical)).toMatchObject(
      {
        status: "accepted",
      },
    );
  });

  test("lets Event Administration configure Teams, public roster mappings, and Pitches", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Configured Event", timeZone: "UTC" },
      fixture.technical,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    const team = await fixture.administration.createEventTeam(
      event.value.eventId,
      { name: "Blue", defaultColor: "#123456" },
      fixture.technical,
    );
    expect(team).toMatchObject({ status: "accepted", value: { name: "Blue", roster: [] } });
    if (team.status !== "accepted") return;
    expect(
      await fixture.administration.upsertEventTeamRoster(
        event.value.eventId,
        team.value.eventTeamId,
        { playerNumber: 4, publicName: "Public Player" },
        fixture.technical,
      ),
    ).toMatchObject({
      status: "accepted",
      value: { playerNumber: 4, publicName: "Public Player" },
    });
    expect(
      await fixture.administration.createPitch(
        event.value.eventId,
        { name: "Pitch 1" },
        fixture.technical,
      ),
    ).toMatchObject({ status: "accepted", value: { name: "Pitch 1" } });
    const hub = await fixture.administration.openEventHub({
      eventId: event.value.eventId,
      authority: fixture.technical,
    });
    expect(hub).toMatchObject({
      status: "accepted",
      value: {
        event: {
          teams: [{ name: "Blue", roster: [{ playerNumber: 4 }] }],
          pitches: [{ name: "Pitch 1" }],
        },
      },
    });
  });

  test("configures ordered schedule projections and confirms one Gameplay Slot", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Scheduled Event", timeZone: "UTC" },
      fixture.technical,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    const day = await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-14" },
      fixture.technical,
    );
    if (day.status !== "accepted") throw new Error("Expected Game Day.");
    const pitch = await fixture.administration.createPitch(
      event.value.eventId,
      { name: "Pitch A" },
      fixture.technical,
    );
    if (pitch.status !== "accepted") throw new Error("Expected Pitch.");
    const firstTeam = await fixture.administration.createEventTeam(
      event.value.eventId,
      { name: "First" },
      fixture.technical,
    );
    const secondTeam = await fixture.administration.createEventTeam(
      event.value.eventId,
      { name: "Second" },
      fixture.technical,
    );
    if (firstTeam.status !== "accepted" || secondTeam.status !== "accepted")
      throw new Error("Expected Event Teams.");
    const later = await fixture.administration.createGameplaySlot(
      event.value.eventId,
      day.value.gameDayId,
      { sequence: 2, scheduledStart: "2026-08-14T10:30" },
      fixture.technical,
    );
    const earlier = await fixture.administration.createGameplaySlot(
      event.value.eventId,
      day.value.gameDayId,
      { sequence: 1, scheduledStart: "2026-08-14T10:00" },
      fixture.technical,
    );
    expect(later).toMatchObject({ status: "accepted" });
    expect(earlier).toMatchObject({ status: "accepted" });
    if (later.status !== "accepted" || earlier.status !== "accepted")
      throw new Error("Expected Gameplay Slots.");
    const pitchSlots = await fixture.storage.transaction((transaction) =>
      transaction.listPitchSlots(day.value.gameDayId, pitch.value.pitchId),
    );
    const earlierPitchSlot = pitchSlots.find(
      (pitchSlot) => pitchSlot.gameplaySlotId === earlier.value.gameplaySlotId,
    );
    if (earlierPitchSlot === undefined) throw new Error("Expected Pitch Slot.");
    const game = await fixture.administration.createEventGame(
      event.value.eventId,
      day.value.gameDayId,
      {
        gameplaySlotId: earlier.value.gameplaySlotId,
        pitchSlotId: earlierPitchSlot.pitchSlotId,
        gameCode: "G-01",
        gameDesignation: "Opening",
        sideA: { sourceLabel: "Winner of A" },
        sideB: { sourceLabel: "Winner of B" },
      },
      fixture.technical,
    );
    expect(game).toMatchObject({
      status: "accepted",
      value: { sideA: { sourceLabel: "Winner of A" } },
    });
    if (game.status !== "accepted") throw new Error("Expected Event Game.");
    const setup = await fixture.administration.openSlotSetup(
      event.value.eventId,
      day.value.gameDayId,
      fixture.technical,
    );
    expect(setup).toMatchObject({
      status: "accepted",
      value: {
        gameplaySlots: [{ sequence: 1 }, { sequence: 2 }],
        eventGames: [{ gameCode: "G-01", sideA: { sourceLabel: "Winner of A" } }],
        pitches: [{ pitchId: pitch.value.pitchId, name: "Pitch A" }],
      },
    });
    expect(JSON.stringify(setup)).not.toContain("actorReference");
    const pitchView = await fixture.administration.openPitchView(
      event.value.eventId,
      day.value.gameDayId,
      pitch.value.pitchId,
      fixture.technical,
    );
    expect(pitchView).toMatchObject({
      status: "accepted",
      value: {
        pitchId: pitch.value.pitchId,
        pitchSlots: [
          { gameplaySlotId: earlier.value.gameplaySlotId },
          { gameplaySlotId: later.value.gameplaySlotId },
        ],
        eventGames: [{ eventGameId: game.value.eventGameId }],
      },
    });
    const confirmed = await fixture.administration.confirmGameplaySlotTeams(
      event.value.eventId,
      day.value.gameDayId,
      earlier.value.gameplaySlotId,
      {
        games: [
          {
            eventGameId: game.value.eventGameId,
            sideAEventTeamId: firstTeam.value.eventTeamId,
            sideBEventTeamId: secondTeam.value.eventTeamId,
          },
        ],
      },
      fixture.technical,
    );
    expect(confirmed).toMatchObject({
      status: "accepted",
      value: [
        {
          sideA: { eventTeamId: firstTeam.value.eventTeamId },
          sideB: { eventTeamId: secondTeam.value.eventTeamId },
        },
      ],
    });
  });

  test("hands one Pitch and Game Day to a persistent, narrow Pitch Manager session", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Pitch Handoff", timeZone: "Europe/Zurich" },
      fixture.technical,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    const firstDay = await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-14" },
      fixture.technical,
    );
    const secondDay = await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-15" },
      fixture.technical,
    );
    const pitch = await fixture.administration.createPitch(
      event.value.eventId,
      { name: "Pitch A" },
      fixture.technical,
    );
    if (
      firstDay.status !== "accepted" ||
      secondDay.status !== "accepted" ||
      pitch.status !== "accepted"
    )
      throw new Error("Expected schedule structure.");
    const eventGrant = await fixture.administration.createEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    if (eventGrant.status !== "accepted") throw new Error("Expected Event Admin Grant.");
    const eventCredential = await fixture.grants.revealGrant(
      eventGrant.value.grantId,
      fixture.technical,
    );
    if (eventCredential.status !== "revealed") throw new Error("Expected Event Admin QR.");
    const eventAdmission = await fixture.administration.admitEventAdmin({
      qrCredential: eventCredential.qrCredential,
      browserContext: "event-admin-phone",
    });
    if (eventAdmission.status !== "admitted") throw new Error("Expected Event Admin session.");
    const eventAuthority = {
      kind: "grant-session",
      sessionBearer: eventAdmission.sessionBearer,
    } as const;

    const created = await fixture.administration.createPitchManagerGrant(
      event.value.eventId,
      firstDay.value.gameDayId,
      pitch.value.pitchId,
      eventAuthority,
    );
    expect(created).toMatchObject({
      status: "accepted",
      value: {
        gameDayId: firstDay.value.gameDayId,
        pitchId: pitch.value.pitchId,
        status: "active",
      },
    });
    if (created.status !== "accepted") throw new Error("Expected Pitch Manager Grant.");
    expect(
      await fixture.administration.createPitchManagerGrant(
        event.value.eventId,
        firstDay.value.gameDayId,
        pitch.value.pitchId,
        eventAuthority,
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });
    const pitchCredential = await fixture.administration.revealPitchManagerGrant(
      event.value.eventId,
      firstDay.value.gameDayId,
      pitch.value.pitchId,
      eventAuthority,
    );
    if (pitchCredential.status !== "accepted" || pitchCredential.value.status !== "revealed")
      throw new Error("Expected Pitch Manager QR.");
    const managerAdmission = await fixture.administration.admitPitchManager({
      qrCredential: pitchCredential.value.qrCredential,
      browserContext: "manager-phone",
    });
    if (managerAdmission.status !== "admitted") throw new Error("Expected Pitch Manager session.");

    const slot = await fixture.administration.createGameplaySlot(
      event.value.eventId,
      firstDay.value.gameDayId,
      { sequence: 1, scheduledStart: "2026-08-14T10:00" },
      fixture.technical,
    );
    if (slot.status !== "accepted") throw new Error("Expected Gameplay Slot.");
    const pitchSlot = await fixture.storage.transaction(
      (transaction) => transaction.listPitchSlots(firstDay.value.gameDayId, pitch.value.pitchId)[0],
    );
    if (pitchSlot === undefined) throw new Error("Expected Pitch Slot.");
    const game = await fixture.administration.createEventGame(
      event.value.eventId,
      firstDay.value.gameDayId,
      {
        gameplaySlotId: slot.value.gameplaySlotId,
        pitchSlotId: pitchSlot.pitchSlotId,
        sideA: { sourceLabel: "A" },
        sideB: { sourceLabel: "B" },
      },
      fixture.technical,
    );
    if (game.status !== "accepted") throw new Error("Expected Event Game.");
    const control = await fixture.grants.createControlGrant({
      authority: { kind: "grant-session", sessionBearer: managerAdmission.sessionBearer },
      scope: {
        eventId: event.value.eventId,
        gameDayId: firstDay.value.gameDayId,
        pitchId: pitch.value.pitchId,
        pitchSlotId: pitchSlot.pitchSlotId,
      },
    });
    expect(control).toMatchObject({ status: "created", grantType: "control" });

    const view = await fixture.administration.openPitchManagerView({
      eventId: event.value.eventId,
      gameDayId: firstDay.value.gameDayId,
      pitchId: pitch.value.pitchId,
      authority: { kind: "grant-session", sessionBearer: managerAdmission.sessionBearer },
    });
    expect(view).toMatchObject({
      status: "accepted",
      value: {
        eventId: event.value.eventId,
        gameDayId: firstDay.value.gameDayId,
        eventTimeZone: "Europe/Zurich",
        pitch: { pitchId: pitch.value.pitchId },
        schedule: [
          {
            expectedStart: "2026-08-14 10:00 Europe/Zurich",
            eventGame: {
              eventGameId: game.value.eventGameId,
              sideA: { displayName: "A" },
              sideB: { displayName: "B" },
            },
            conflictEventGameIds: [game.value.eventGameId],
            controlGrantStatus: "active",
          },
        ],
        grantSessionExpiresAt: "2026-08-15 04:30 Europe/Zurich",
      },
    });
    if (view.status === "accepted") {
      expect(view.value).not.toHaveProperty("eventGames");
      expect(view.value).not.toHaveProperty("createdAtMs");
      expect(view.value).not.toHaveProperty("updatedAtMs");
    }
    expect(
      await fixture.administration.openPitchManagerCurrentView({
        authority: { kind: "grant-session", sessionBearer: managerAdmission.sessionBearer },
      }),
    ).toMatchObject({
      status: "accepted",
      value: {
        eventId: event.value.eventId,
        gameDayId: firstDay.value.gameDayId,
        pitch: { pitchId: pitch.value.pitchId },
      },
    });
    expect(
      await fixture.administration.openPitchManagerView({
        eventId: event.value.eventId,
        gameDayId: secondDay.value.gameDayId,
        pitchId: pitch.value.pitchId,
        authority: { kind: "grant-session", sessionBearer: managerAdmission.sessionBearer },
      }),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });

    fixture.setNow(created.value.expiresAtMs ?? 0);
    expect(
      await fixture.administration.openPitchManagerView({
        eventId: event.value.eventId,
        gameDayId: firstDay.value.gameDayId,
        pitchId: pitch.value.pitchId,
        authority: { kind: "grant-session", sessionBearer: managerAdmission.sessionBearer },
      }),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
    expect(
      await fixture.administration.reactivatePitchManagerGrant(
        event.value.eventId,
        firstDay.value.gameDayId,
        pitch.value.pitchId,
        fixture.technical,
      ),
    ).toMatchObject({ status: "rejected" });
    const laterDayGrant = await fixture.administration.createPitchManagerGrant(
      event.value.eventId,
      secondDay.value.gameDayId,
      pitch.value.pitchId,
      eventAuthority,
    );
    expect(laterDayGrant).toMatchObject({
      status: "accepted",
      value: { gameDayId: secondDay.value.gameDayId, pitchId: pitch.value.pitchId },
    });
    if (laterDayGrant.status !== "accepted") throw new Error("Expected later-day Grant.");
    const laterQr = await fixture.administration.revealPitchManagerGrant(
      event.value.eventId,
      secondDay.value.gameDayId,
      pitch.value.pitchId,
      eventAuthority,
    );
    if (laterQr.status !== "accepted" || laterQr.value.status !== "revealed")
      throw new Error("Expected later-day QR.");
    const oldLaterSession = await fixture.administration.admitPitchManager({
      qrCredential: laterQr.value.qrCredential,
      browserContext: "later-manager",
    });
    if (oldLaterSession.status !== "admitted") throw new Error("Expected later-day session.");
    const rotated = await fixture.administration.rotatePitchManagerGrant(
      event.value.eventId,
      secondDay.value.gameDayId,
      pitch.value.pitchId,
      eventAuthority,
    );
    expect(rotated).toMatchObject({ status: "accepted", value: { status: "updated" } });
    expect(
      await fixture.administration.openPitchManagerView({
        eventId: event.value.eventId,
        gameDayId: secondDay.value.gameDayId,
        pitchId: pitch.value.pitchId,
        authority: { kind: "grant-session", sessionBearer: oldLaterSession.sessionBearer },
      }),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
    const revoked = await fixture.administration.revokePitchManagerGrant(
      event.value.eventId,
      secondDay.value.gameDayId,
      pitch.value.pitchId,
      eventAuthority,
    );
    expect(revoked).toMatchObject({ status: "accepted", value: { status: "updated" } });
    const reactivated = await fixture.administration.reactivatePitchManagerGrant(
      event.value.eventId,
      secondDay.value.gameDayId,
      pitch.value.pitchId,
      eventAuthority,
    );
    expect(reactivated).toMatchObject({ status: "accepted", value: { status: "updated" } });
    const reactivatedQr = await fixture.administration.revealPitchManagerGrant(
      event.value.eventId,
      secondDay.value.gameDayId,
      pitch.value.pitchId,
      eventAuthority,
    );
    expect(reactivatedQr).toMatchObject({ status: "accepted", value: { status: "revealed" } });
  });

  test("lets Technical and Event Admin authority publish and hide without revoking the Grant", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Publication Event", timeZone: "UTC" },
      fixture.technical,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-14" },
      fixture.technical,
    );
    const grant = await fixture.administration.createEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    if (grant.status !== "accepted") throw new Error("Expected Grant.");
    const revealed = await fixture.grants.revealGrant(grant.value.grantId, fixture.technical);
    if (revealed.status !== "revealed") throw new Error("Expected Grant reveal.");
    const admission = await fixture.administration.admitEventAdmin({
      qrCredential: revealed.qrCredential,
      browserContext: "publication-browser",
    });
    if (admission.status !== "admitted") throw new Error("Expected Event Admin admission.");
    const eventAdmin = { kind: "grant-session" as const, sessionBearer: admission.sessionBearer };

    expect(
      await fixture.administration.changePublicationStatus(
        event.value.eventId,
        { status: "published" },
        eventAdmin,
      ),
    ).toMatchObject({ status: "accepted", value: { publicationStatus: "published" } });
    expect(
      await fixture.administration.changePublicationStatus(
        event.value.eventId,
        { status: "cancelled" },
        eventAdmin,
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });
    expect(
      await fixture.administration.changePublicationStatus(
        event.value.eventId,
        { status: "cancelled", impactConfirmed: true },
        eventAdmin,
      ),
    ).toMatchObject({ status: "accepted", value: { publicationStatus: "cancelled" } });
    expect(
      await fixture.administration.openEventHub({
        eventId: event.value.eventId,
        authority: eventAdmin,
      }),
    ).toMatchObject({ status: "accepted", value: { event: { publicationStatus: "cancelled" } } });
    expect(
      await fixture.administration.inspectEventAdminGrant(event.value.eventId, fixture.technical),
    ).toMatchObject({ status: "accepted", value: { status: "active" } });
  });

  test("keeps Grant Code management on the canonical matrix and never projects plaintext", async () => {
    const fixture = createFixture(undefined, {
      resolve: () => ({ status: "eligible" as const, eventGameId: "event-game-code" }),
    });
    const event = await fixture.catalog.createEvent(
      { name: "Grant Code Event", timeZone: "UTC" },
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
      throw new Error("Expected schedule setup.");
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
    const game = await fixture.catalog.createEventGame(
      event.value.eventId,
      day.value.gameDayId,
      {
        gameplaySlotId: slot.value.gameplaySlotId,
        pitchSlotId: pitchSlot.pitchSlotId,
        sideA: { sourceLabel: "A" },
        sideB: { sourceLabel: "B" },
      },
      fixture.technical,
    );
    if (game.status !== "accepted") throw new Error("Expected Event Game.");

    const eventAdminGrant = await fixture.administration.createEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    if (eventAdminGrant.status !== "accepted") throw new Error("Expected Event Admin Grant.");
    const eventAdminQr = await fixture.grants.revealGrant(
      eventAdminGrant.value.grantId,
      fixture.technical,
    );
    if (eventAdminQr.status !== "revealed") throw new Error("Expected Event Admin QR.");
    const eventAdminAdmission = await fixture.administration.admitEventAdmin({
      qrCredential: eventAdminQr.qrCredential,
      browserContext: "code-event-admin",
    });
    if (eventAdminAdmission.status !== "admitted")
      throw new Error("Expected Event Admin admission.");
    const eventAdmin = {
      kind: "grant-session" as const,
      sessionBearer: eventAdminAdmission.sessionBearer,
    };

    expect(
      await fixture.administration.createEventAdminGrantCode(
        event.value.eventId,
        eventAdmin as never,
      ),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
    const eventAdminCode = await fixture.administration.createEventAdminGrantCode(
      event.value.eventId,
      fixture.technical,
    );
    expect(eventAdminCode).toMatchObject({ status: "accepted", value: { status: "created" } });
    if (eventAdminCode.status !== "accepted") throw new Error("Expected Event Admin code.");
    expect(JSON.stringify(eventAdminCode)).toMatch(/^[\s\S]*[a-z]+-[a-z]+-\d{3}[\s\S]*$/u);
    expect(
      await fixture.administration.inspectEventAdminGrantCode(
        event.value.eventId,
        fixture.technical,
      ),
    ).toMatchObject({ status: "accepted", value: { state: "present", formatVersion: 1 } });
    expect(
      JSON.stringify(
        await fixture.administration.inspectEventAdminGrantCode(
          event.value.eventId,
          fixture.technical,
        ),
      ),
    ).not.toContain(eventAdminCode.value.code);
    expect(
      await fixture.grants.admitGrantCode({
        grantCode: eventAdminCode.value.code,
        browserContext: "code-admission",
      }),
    ).toMatchObject({ status: "admitted", grantType: "event-admin" });

    const pitchManagerGrant = await fixture.administration.createPitchManagerGrant(
      event.value.eventId,
      day.value.gameDayId,
      pitch.value.pitchId,
      eventAdmin,
    );
    if (pitchManagerGrant.status !== "accepted") throw new Error("Expected Pitch Manager Grant.");
    const pitchManagerCode = await fixture.administration.createPitchManagerGrantCode(
      event.value.eventId,
      day.value.gameDayId,
      pitch.value.pitchId,
      eventAdmin,
    );
    expect(pitchManagerCode).toMatchObject({ status: "accepted", value: { status: "created" } });
    expect(
      await fixture.administration.createPitchManagerGrantCode(
        event.value.eventId,
        day.value.gameDayId,
        pitch.value.pitchId,
        eventAdmin,
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });

    const pitchManagerQr = await fixture.grants.revealGrant(
      pitchManagerGrant.value.grantId,
      eventAdmin,
    );
    if (pitchManagerQr.status !== "revealed") throw new Error("Expected Pitch Manager QR.");
    const pitchManagerAdmission = await fixture.administration.admitPitchManager({
      qrCredential: pitchManagerQr.qrCredential,
      browserContext: "code-pitch-manager",
    });
    if (pitchManagerAdmission.status !== "admitted")
      throw new Error("Expected Pitch Manager admission.");
    const pitchManager = {
      kind: "grant-session" as const,
      sessionBearer: pitchManagerAdmission.sessionBearer,
    };
    expect(
      await fixture.administration.inspectPitchManagerGrantCode(
        event.value.eventId,
        day.value.gameDayId,
        pitch.value.pitchId,
        pitchManager,
      ),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });

    const controlGrant = await fixture.administration.createControlGrant(
      event.value.eventId,
      day.value.gameDayId,
      pitch.value.pitchId,
      pitchSlot.pitchSlotId,
      eventAdmin,
    );
    if (controlGrant.status !== "accepted") throw new Error("Expected Control Grant.");
    const controlCode = await fixture.administration.createControlGrantCode(
      event.value.eventId,
      day.value.gameDayId,
      pitch.value.pitchId,
      pitchSlot.pitchSlotId,
      pitchManager,
    );
    expect(controlCode).toMatchObject({ status: "accepted", value: { status: "created" } });
    if (controlCode.status !== "accepted") throw new Error("Expected Control code.");
    expect(
      await fixture.administration.createControlGrantCode(
        event.value.eventId,
        day.value.gameDayId,
        pitch.value.pitchId,
        pitchSlot.pitchSlotId,
        eventAdmin,
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });
    const disabledControlCode = await fixture.administration.disableControlGrantCode(
      event.value.eventId,
      day.value.gameDayId,
      pitch.value.pitchId,
      pitchSlot.pitchSlotId,
      pitchManager,
    );
    expect(disabledControlCode).toMatchObject({
      status: "accepted",
      value: { status: "updated" },
      sessionExpiresAtMs: pitchManagerAdmission.sessionExpiresAtMs,
    });
    expect(
      await fixture.administration.inspectControlGrantCode(
        event.value.eventId,
        day.value.gameDayId,
        pitch.value.pitchId,
        pitchSlot.pitchSlotId,
        pitchManager,
      ),
    ).toMatchObject({ status: "accepted", value: { state: "disabled" } });
  });

  test("binds Grant Code admission to the typed Event Administration seam", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Typed code admission", timeZone: "UTC" },
      fixture.technical,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-14" },
      fixture.technical,
    );
    const eventAdmin = await fixture.administration.createEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    if (eventAdmin.status !== "accepted") throw new Error("Expected Event Admin Grant.");
    const code = await fixture.administration.createEventAdminGrantCode(
      event.value.eventId,
      fixture.technical,
    );
    if (code.status !== "accepted") throw new Error("Expected Event Admin code.");

    const wrongType = await fixture.administration.admitPitchManagerCode({
      grantCode: code.value.code,
      browserContext: "wrong-type",
    });
    expect(wrongType).toMatchObject({
      status: "rejected",
      code: "grant-admission-failed",
      message: "Unable to admit this Grant.",
    });
    const sessions = await fixture.storage.transaction((transaction) =>
      transaction.listGrantSessions(eventAdmin.value.grantId),
    );
    expect(sessions).toHaveLength(0);

    const accepted = await fixture.administration.admitEventAdminCode({
      grantCode: code.value.code,
      browserContext: "right-type",
    });
    expect(accepted).toMatchObject({ status: "admitted", grantType: "event-admin" });
  });
});

function createFixture(
  storage: FoundationStorage = createInMemoryFoundationStorage(),
  controlScopeResolver: {
    resolve: () => { status: "eligible"; eventGameId: string } | { status: "unavailable" };
  } = {
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
  const options = {
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
        isRecord(input) &&
        input.kind === "grant-session" &&
        typeof input.sessionBearer === "string"
      )
        return { kind: "grant-session", sessionBearer: input.sessionBearer, sessionId: "session" };
      return null;
    }),
  };
  const grants = createGrantAuthority(storage, options);
  const administration = createEventAdministration({
    storage,
    grants,
    nowMs: () => nowMs,
    controlScopeResolver,
  });
  return {
    storage,
    technical,
    catalog,
    grants,
    administration,
    setNow: (value: number) => (nowMs = value),
  };
}

function bytes(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
