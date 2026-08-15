import { describe, expect, test } from "bun:test";
import { createEventAdministration } from "@/lib/event-administration";
import { createEventCatalog, createFoundationEventCatalogStorage } from "@/lib/event-catalog";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import { createGrantAuthority, createGrantAuthorityVerifier } from "@/lib/grant-authority";
import type { ControlGrantScopeResolution, GrantKeyRing } from "@/lib/grant-types";
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

describe("Control Grant management", () => {
  test("keeps creation separate from reveal and exposes only redacted session management", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Control Grant Event", timeZone: "UTC" },
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
    const wrongPitch = await fixture.catalog.createPitch(
      event.value.eventId,
      { name: "Pitch B" },
      fixture.technical,
    );
    const wrongDay = await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-15" },
      fixture.technical,
    );
    if (
      day.status !== "accepted" ||
      pitch.status !== "accepted" ||
      wrongPitch.status !== "accepted" ||
      wrongDay.status !== "accepted"
    )
      throw new Error("Expected schedule structure.");
    const gameplaySlot = await fixture.catalog.createGameplaySlot(
      event.value.eventId,
      day.value.gameDayId,
      { sequence: 1, scheduledStart: "2026-08-14T10:00" },
      fixture.technical,
    );
    if (gameplaySlot.status !== "accepted") throw new Error("Expected Gameplay Slot.");
    const pitchSlot = await fixture.storage.transaction(
      (transaction) => transaction.listPitchSlots(day.value.gameDayId, pitch.value.pitchId)[0],
    );
    if (pitchSlot === undefined) throw new Error("Expected Pitch Slot.");
    const game = await fixture.catalog.createEventGame(
      event.value.eventId,
      day.value.gameDayId,
      {
        gameplaySlotId: gameplaySlot.value.gameplaySlotId,
        pitchSlotId: pitchSlot.pitchSlotId,
        sideA: { sourceLabel: "A" },
        sideB: { sourceLabel: "B" },
      },
      fixture.technical,
    );
    if (game.status !== "accepted") throw new Error("Expected Event Game.");
    fixture.resolution = { status: "eligible", eventGameId: game.value.eventGameId };

    const eventGrant = await fixture.administration.createEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    if (eventGrant.status !== "accepted") throw new Error("Expected Event Admin Grant.");
    const eventQr = await fixture.grants.revealGrant(eventGrant.value.grantId, fixture.technical);
    if (eventQr.status !== "revealed") throw new Error("Expected Event Admin QR.");
    const eventSession = await fixture.administration.admitEventAdmin({
      qrCredential: eventQr.qrCredential,
      browserContext: "event-admin",
    });
    if (eventSession.status !== "admitted") throw new Error("Expected Event Admin session.");
    const eventAuthority = {
      kind: "grant-session" as const,
      sessionBearer: eventSession.sessionBearer,
    };
    const pitchManagerGrant = await fixture.administration.createPitchManagerGrant(
      event.value.eventId,
      day.value.gameDayId,
      pitch.value.pitchId,
      eventAuthority,
    );
    if (pitchManagerGrant.status !== "accepted") throw new Error("Expected Pitch Manager Grant.");
    const pitchManagerQr = await fixture.grants.revealGrant(
      pitchManagerGrant.value.grantId,
      eventAuthority,
    );
    if (pitchManagerQr.status !== "revealed") throw new Error("Expected Pitch Manager QR.");
    const pitchManagerSession = await fixture.administration.admitPitchManager({
      qrCredential: pitchManagerQr.qrCredential,
      browserContext: "pitch-manager",
    });
    if (pitchManagerSession.status !== "admitted")
      throw new Error("Expected Pitch Manager session.");
    const pitchManagerAuthority = {
      kind: "grant-session" as const,
      sessionBearer: pitchManagerSession.sessionBearer,
    };

    const created = await fixture.administration.createControlGrant(
      event.value.eventId,
      day.value.gameDayId,
      pitch.value.pitchId,
      pitchSlot.pitchSlotId,
      pitchManagerAuthority,
    );
    expect(created).toMatchObject({
      status: "accepted",
      value: { status: "active", pitchSlotId: pitchSlot.pitchSlotId },
    });
    if (created.status !== "accepted") throw new Error("Expected Control Grant.");
    expect(JSON.stringify(created)).not.toContain("qrCredential");
    expect(
      await fixture.administration.inspectControlGrant(
        event.value.eventId,
        day.value.gameDayId,
        pitch.value.pitchId,
        pitchSlot.pitchSlotId,
        eventAuthority,
      ),
    ).toMatchObject({ status: "accepted", value: { grantId: created.value.grantId } });
    expect(
      await fixture.administration.inspectControlGrant(
        event.value.eventId,
        day.value.gameDayId,
        wrongPitch.value.pitchId,
        pitchSlot.pitchSlotId,
        pitchManagerAuthority,
      ),
    ).toMatchObject({ status: "rejected", reason: "not-found" });
    expect(
      await fixture.administration.inspectControlGrant(
        event.value.eventId,
        wrongDay.value.gameDayId,
        pitch.value.pitchId,
        pitchSlot.pitchSlotId,
        pitchManagerAuthority,
      ),
    ).toMatchObject({ status: "rejected", reason: "not-found" });

    const inspected = await fixture.administration.inspectControlGrant(
      event.value.eventId,
      day.value.gameDayId,
      pitch.value.pitchId,
      pitchSlot.pitchSlotId,
      pitchManagerAuthority,
    );
    expect(inspected).toMatchObject({
      status: "accepted",
      value: { status: "active", eligibility: "eligible", eventGameId: game.value.eventGameId },
    });
    const revealed = await fixture.administration.revealControlGrant(
      event.value.eventId,
      day.value.gameDayId,
      pitch.value.pitchId,
      pitchSlot.pitchSlotId,
      pitchManagerAuthority,
    );
    if (revealed.status !== "accepted" || revealed.value.status !== "revealed")
      throw new Error("Expected Control Grant QR.");

    const firstController = await fixture.administration.admitControlGrant({
      qrCredential: revealed.value.qrCredential,
      browserContext: "controller-a",
      deviceClass: "mobile",
      browserClass: "safari",
    });
    const secondController = await fixture.administration.admitControlGrant({
      qrCredential: revealed.value.qrCredential,
      browserContext: "controller-b",
      deviceClass: "desktop",
      browserClass: "chrome",
    });
    if (firstController.status !== "admitted" || secondController.status !== "admitted")
      throw new Error("Expected Controller sessions.");

    const sessionStateBeforeList = await fixture.storage.transaction((transaction) =>
      transaction.listGrantSessions(created.value.grantId),
    );
    const sessions = await fixture.administration.listControlGrantSessions(
      event.value.eventId,
      day.value.gameDayId,
      pitch.value.pitchId,
      pitchSlot.pitchSlotId,
      pitchManagerAuthority,
    );
    expect(sessions).toMatchObject({ status: "accepted" });
    if (sessions.status !== "accepted") throw new Error("Expected session summaries.");
    expect(sessions.value).toEqual(
      expect.arrayContaining([expect.objectContaining({ deviceClass: "mobile" })]),
    );
    expect(
      await fixture.storage.transaction((transaction) =>
        transaction.listGrantSessions(created.value.grantId),
      ),
    ).toEqual(sessionStateBeforeList);
    expect(Object.keys(sessions.value[0] ?? {}).sort()).toEqual([
      "browserClass",
      "createdAtMs",
      "deviceClass",
      "label",
      "lastActiveAtMs",
    ]);
    expect(sessions.value[0]).toEqual({
      label: expect.stringMatching(/^session-/u),
      createdAtMs: expect.any(Number),
      lastActiveAtMs: expect.any(Number),
      deviceClass: expect.any(String),
      browserClass: expect.any(String),
    });

    const revoked = await fixture.administration.revokeControlGrantSession(
      event.value.eventId,
      day.value.gameDayId,
      pitch.value.pitchId,
      pitchSlot.pitchSlotId,
      sessions.value[0]!.label,
      pitchManagerAuthority,
    );
    expect(revoked).toMatchObject({ status: "accepted", value: { status: "updated" } });
    const activeSessionsAfterRevoke = await fixture.administration.listControlGrantSessions(
      event.value.eventId,
      day.value.gameDayId,
      pitch.value.pitchId,
      pitchSlot.pitchSlotId,
      pitchManagerAuthority,
    );
    expect(activeSessionsAfterRevoke).toMatchObject({
      status: "accepted",
      value: [{ label: expect.any(String) }],
    });
    if (activeSessionsAfterRevoke.status !== "accepted")
      throw new Error("Expected active sessions.");
    expect(activeSessionsAfterRevoke.value).toHaveLength(1);

    const rotated = await fixture.administration.rotateControlGrant(
      event.value.eventId,
      day.value.gameDayId,
      pitch.value.pitchId,
      pitchSlot.pitchSlotId,
      pitchManagerAuthority,
    );
    expect(rotated).toMatchObject({
      status: "accepted",
      value: { status: "updated", affectedSessionCount: 1 },
    });
    expect(
      await fixture.administration.openEventHub({
        eventId: event.value.eventId,
        authority: eventAuthority,
      }),
    ).toMatchObject({ status: "accepted" });
    expect(
      await fixture.grants.authorizeGrant({
        sessionBearer: secondController.sessionBearer,
        eventGameId: game.value.eventGameId,
      }),
    ).toMatchObject({ status: "rejected" });
  });

  test("keeps the Control Grant on its Pitch Slot through reassignment and fails reveal generically when ineligible", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Reassignment Event", timeZone: "UTC" },
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
    const firstSlot = await fixture.catalog.createGameplaySlot(
      event.value.eventId,
      day.value.gameDayId,
      { sequence: 1, scheduledStart: "2026-08-14T10:00" },
      fixture.technical,
    );
    const secondSlot = await fixture.catalog.createGameplaySlot(
      event.value.eventId,
      day.value.gameDayId,
      { sequence: 2, scheduledStart: "2026-08-14T11:00" },
      fixture.technical,
    );
    if (firstSlot.status !== "accepted" || secondSlot.status !== "accepted")
      throw new Error("Expected Gameplay Slots.");
    const slots = await fixture.storage.transaction((transaction) =>
      transaction.listPitchSlots(day.value.gameDayId, pitch.value.pitchId),
    );
    const source = slots.find((slot) => slot.gameplaySlotId === firstSlot.value.gameplaySlotId);
    const target = slots.find((slot) => slot.gameplaySlotId === secondSlot.value.gameplaySlotId);
    if (source === undefined || target === undefined) throw new Error("Expected Pitch Slots.");
    const game = await fixture.catalog.createEventGame(
      event.value.eventId,
      day.value.gameDayId,
      {
        gameplaySlotId: firstSlot.value.gameplaySlotId,
        pitchSlotId: source.pitchSlotId,
        sideA: { sourceLabel: "A" },
        sideB: { sourceLabel: "B" },
      },
      fixture.technical,
    );
    if (game.status !== "accepted") throw new Error("Expected Event Game.");
    fixture.resolution = { status: "eligible", eventGameId: game.value.eventGameId };
    const grant = await fixture.administration.createControlGrant(
      event.value.eventId,
      day.value.gameDayId,
      pitch.value.pitchId,
      source.pitchSlotId,
      fixture.technical,
    );
    if (grant.status !== "accepted") throw new Error("Expected Control Grant.");
    const reassigned = await fixture.administration.reassignEventGame(
      event.value.eventId,
      day.value.gameDayId,
      game.value.eventGameId,
      { targetPitchSlotId: target.pitchSlotId },
      fixture.technical,
    );
    expect(reassigned).toMatchObject({ status: "accepted" });
    fixture.resolution = { status: "empty" };
    const beforeRejectedReveal = await fixture.storage.transaction((transaction) => ({
      grants: transaction.listGrants(),
      sessions: transaction.listGrantSessions(grant.value.grantId),
      audit: transaction.listGrantAudit(grant.value.grantId),
    }));
    expect(
      await fixture.administration.revealControlGrant(
        event.value.eventId,
        day.value.gameDayId,
        pitch.value.pitchId,
        source.pitchSlotId,
        fixture.technical,
      ),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
    expect(
      await fixture.storage.transaction((transaction) => ({
        grants: transaction.listGrants(),
        sessions: transaction.listGrantSessions(grant.value.grantId),
        audit: transaction.listGrantAudit(grant.value.grantId),
      })),
    ).toEqual(beforeRejectedReveal);
    expect(
      await fixture.storage.transaction((transaction) =>
        transaction.findGrantById(grant.value.grantId),
      ),
    ).toMatchObject({ scope: { pitchSlotId: source.pitchSlotId } });
  });

  test("returns no session summaries for a disabled Control Grant without read mutation", async () => {
    const { fixture, grantId } = await createControlGrantWithSession();
    expect(await fixture.grants.disableGrant(grantId, fixture.technical)).toMatchObject({
      status: "updated",
    });
    const before = await fixture.storage.transaction((transaction) => ({
      grant: transaction.findGrantById(grantId),
      sessions: transaction.listGrantSessions(grantId),
      audit: transaction.listGrantAudit(grantId),
    }));

    expect(await fixture.grants.listGrantSessions(grantId, fixture.technical)).toEqual({
      status: "ok",
      value: [],
    });
    expect(
      await fixture.storage.transaction((transaction) => ({
        grant: transaction.findGrantById(grantId),
        sessions: transaction.listGrantSessions(grantId),
        audit: transaction.listGrantAudit(grantId),
      })),
    ).toEqual(before);
  });

  test("returns no session summaries at the exact Grant expiry boundary without read mutation", async () => {
    const expiryAtMs = Date.parse("2026-08-14T12:00:01Z");
    const { fixture, grantId } = await createControlGrantWithSession(expiryAtMs);
    fixture.setNow(expiryAtMs);
    const before = await fixture.storage.transaction((transaction) => ({
      grant: transaction.findGrantById(grantId),
      sessions: transaction.listGrantSessions(grantId),
      audit: transaction.listGrantAudit(grantId),
    }));

    expect(await fixture.grants.listGrantSessions(grantId, fixture.technical)).toEqual({
      status: "ok",
      value: [],
    });
    expect(
      await fixture.storage.transaction((transaction) => ({
        grant: transaction.findGrantById(grantId),
        sessions: transaction.listGrantSessions(grantId),
        audit: transaction.listGrantAudit(grantId),
      })),
    ).toEqual(before);
  });

  test("rolls back management authority and Grant evidence when rotation fails inside its transaction", async () => {
    const baseStorage = createInMemoryFoundationStorage();
    let failAfterGrantUpdate = false;
    const storage = new Proxy(baseStorage, {
      get(target, property, receiver) {
        if (property === "transaction") {
          return (work: Parameters<typeof baseStorage.transaction>[0]) =>
            target.transaction((transaction) => {
              const transactionWithFailure = new Proxy(transaction, {
                get(transactionTarget, transactionProperty, transactionReceiver) {
                  if (transactionProperty === "updateGrant") {
                    return (grant: Parameters<typeof transaction.updateGrant>[0]) => {
                      transactionTarget.updateGrant(grant);
                      if (failAfterGrantUpdate) {
                        failAfterGrantUpdate = false;
                        throw new Error("injected Control Grant rotation failure");
                      }
                    };
                  }
                  const value = Reflect.get(
                    transactionTarget,
                    transactionProperty,
                    transactionReceiver,
                  );
                  return typeof value === "function" ? value.bind(transactionTarget) : value;
                },
              });
              return work(transactionWithFailure);
            });
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof baseStorage;
    const fixture = createFixture(storage);
    const event = await fixture.catalog.createEvent(
      { name: "Atomic Control Grant Event", timeZone: "UTC" },
      fixture.technical,
    );
    if (event.status !== "accepted") throw new Error("Expected event structure.");
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
    if (event.status !== "accepted" || day.status !== "accepted" || pitch.status !== "accepted")
      throw new Error("Expected schedule structure.");
    const gameplaySlot = await fixture.catalog.createGameplaySlot(
      event.value.eventId,
      day.value.gameDayId,
      { sequence: 1, scheduledStart: "2026-08-14T10:00" },
      fixture.technical,
    );
    if (gameplaySlot.status !== "accepted") throw new Error("Expected Gameplay Slot.");
    const pitchSlot = await fixture.storage.transaction(
      (transaction) => transaction.listPitchSlots(day.value.gameDayId, pitch.value.pitchId)[0],
    );
    if (pitchSlot === undefined) throw new Error("Expected Pitch Slot.");
    const game = await fixture.catalog.createEventGame(
      event.value.eventId,
      day.value.gameDayId,
      {
        gameplaySlotId: gameplaySlot.value.gameplaySlotId,
        pitchSlotId: pitchSlot.pitchSlotId,
        sideA: { sourceLabel: "A" },
        sideB: { sourceLabel: "B" },
      },
      fixture.technical,
    );
    if (game.status !== "accepted") throw new Error("Expected Event Game.");
    fixture.resolution = { status: "eligible", eventGameId: game.value.eventGameId };
    const grant = await fixture.administration.createEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    if (grant.status !== "accepted") throw new Error("Expected Event Admin Grant.");
    const qr = await fixture.grants.revealGrant(grant.value.grantId, fixture.technical);
    if (qr.status !== "revealed") throw new Error("Expected Event Admin QR.");
    const admission = await fixture.administration.admitEventAdmin({
      qrCredential: qr.qrCredential,
      browserContext: "atomic-event-admin",
    });
    if (admission.status !== "admitted") throw new Error("Expected Event Admin session.");
    const authority = { kind: "grant-session" as const, sessionBearer: admission.sessionBearer };
    const control = await fixture.administration.createControlGrant(
      event.value.eventId,
      day.value.gameDayId,
      pitch.value.pitchId,
      pitchSlot.pitchSlotId,
      authority,
    );
    if (control.status !== "accepted") throw new Error("Expected Control Grant.");
    const before = await baseStorage.transaction((transaction) => ({
      grants: transaction.listGrants(),
      sessions: transaction
        .listGrantSessions(grant.value.grantId)
        .concat(transaction.listGrantSessions(control.value.grantId)),
      grantAudit: transaction.listGrantAudit(grant.value.grantId),
      controlAudit: transaction.listGrantAudit(control.value.grantId),
    }));
    failAfterGrantUpdate = true;
    expect(
      await fixture.administration.rotateControlGrant(
        event.value.eventId,
        day.value.gameDayId,
        pitch.value.pitchId,
        pitchSlot.pitchSlotId,
        authority,
      ),
    ).toMatchObject({ status: "retryable-failure" });
    expect(
      await baseStorage.transaction((transaction) => ({
        grants: transaction.listGrants(),
        sessions: transaction
          .listGrantSessions(grant.value.grantId)
          .concat(transaction.listGrantSessions(control.value.grantId)),
        grantAudit: transaction.listGrantAudit(grant.value.grantId),
        controlAudit: transaction.listGrantAudit(control.value.grantId),
      })),
    ).toEqual(before);
  });
});

function createFixture(storage = createInMemoryFoundationStorage()) {
  let nowMs = Date.parse("2026-08-14T12:00:00Z");
  let entropy = 9;
  let resolution: ControlGrantScopeResolution = { status: "unavailable" };
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
        return Uint8Array.from({ length }, (_, index) => ((seed + index * 31) % 240) + 1);
      },
    },
    keyRing,
    controlScopeResolver: { resolve: () => resolution },
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
  });
  return {
    storage,
    catalog,
    grants,
    technical,
    administration: createEventAdministration({
      storage,
      grants,
      catalog,
      nowMs: () => nowMs,
      controlScopeResolver: { resolve: () => resolution },
    }),
    set resolution(value: ControlGrantScopeResolution) {
      resolution = value;
    },
    setNow(value: number) {
      nowMs = value;
    },
  };
}

async function createControlGrantWithSession(expiresAtMs?: number) {
  const fixture = createFixture();
  fixture.resolution = { status: "eligible", eventGameId: "event-game-1" };
  const created = await fixture.grants.createControlGrant({
    scope: {
      eventId: "event-1",
      gameDayId: "game-day-1",
      pitchId: "pitch-1",
      pitchSlotId: "pitch-slot-1",
    },
    authority: fixture.technical,
    ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
  });
  if (created.status !== "created") throw new Error("Expected Control Grant.");
  const admitted = await fixture.grants.admitGrant({
    qrCredential: created.qrCredential,
    browserContext: "controller-1",
  });
  if (admitted.status !== "admitted") throw new Error("Expected Control Grant session.");
  return { fixture, grantId: created.grantId };
}

function bytes(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
