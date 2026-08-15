import { describe, expect, test } from "bun:test";
import { createAudienceProjection } from "@/lib/audience-projection";
import { createEventAdministration } from "@/lib/event-administration";
import { createEventCatalog, createFoundationEventCatalogStorage } from "@/lib/event-catalog";
import {
  createEventGameRecord,
  createEventGameRecordTransactionSeam,
} from "@/lib/event-game-record";
import { createLiveEventGameIqaInterpreter } from "@/lib/live-event-game-control";
import {
  canonicalizeEventGameRecordRoot,
  type EventGameRecordRoot,
} from "@/lib/foundation-record-types";
import type { FoundationStorage, FoundationStorageSnapshot } from "@/lib/foundation-storage";
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

describe("Event Administration handoff", () => {
  test("projects bounded operations health without exposing Grant details", async () => {
    let resolution: ControlGrantScopeResolution = {
      status: "eligible",
      eventGameId: "pending",
    };
    const fixture = createFixture(undefined, { resolve: () => resolution });
    const event = await fixture.catalog.createEvent(
      { name: "Operations Health Event", timeZone: "UTC" },
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
        sideA: { sourceLabel: "Winner A" },
        sideB: { sourceLabel: "Winner B" },
      },
      fixture.technical,
    );
    if (game.status !== "accepted") throw new Error("Expected Event Game.");

    resolution = { status: "eligible", eventGameId: game.value.eventGameId };
    const control = await fixture.grants.createControlGrant({
      authority: fixture.technical,
      expiresAtMs: Date.parse("2026-08-14T12:00:01Z"),
      scope: {
        eventId: event.value.eventId,
        gameDayId: day.value.gameDayId,
        pitchId: pitch.value.pitchId,
        pitchSlotId: pitchSlot.pitchSlotId,
      },
    });
    if (control.status !== "created") throw new Error("Expected Control Grant.");

    resolution = { status: "unavailable" };

    const hub = await fixture.administration.openEventHub({
      eventId: event.value.eventId,
      authority: fixture.technical,
    });
    expect(hub).toMatchObject({
      status: "accepted",
      value: {
        health: {
          unresolvedTeamCount: 1,
          scheduleConflictCount: 0,
          teamScheduleConflictCount: 0,
          grantProblemCount: 1,
        },
      },
    });
    if (hub.status === "accepted") {
      expect(JSON.stringify(hub.value.health)).not.toMatch(
        /grantId|grantVersion|credential|session|secret/iu,
      );
    }

    resolution = { status: "empty" };
    expect(
      await fixture.administration.openEventHub({
        eventId: event.value.eventId,
        authority: fixture.technical,
      }),
    ).toMatchObject({ value: { health: { grantProblemCount: 1 } } });

    resolution = { status: "eligible", eventGameId: game.value.eventGameId };
    expect(
      await fixture.administration.openEventHub({
        eventId: event.value.eventId,
        authority: fixture.technical,
      }),
    ).toMatchObject({ value: { health: { grantProblemCount: 0 } } });

    const malformedIsUsable = await fixture.storage.transaction((transaction) => {
      const grant = transaction.findGrantById(control.grantId);
      if (grant === null) throw new Error("Expected stored Control Grant.");
      return fixture.grants.isGrantCurrentlyUsableInTransaction(transaction, {
        ...grant,
        credential: { ...grant.credential, ciphertext: "malformed" },
      });
    });
    expect(malformedIsUsable).toBe(false);

    const beforeExpiredHealth = await fixture.storage.transaction((transaction) => ({
      grant: transaction.findGrantById(control.grantId),
      sessions: transaction.listGrantSessions(control.grantId),
      audit: transaction.listGrantAudit(control.grantId),
    }));
    fixture.setNow(control.expiresAtMs ?? 0);
    expect(
      await fixture.administration.openEventHub({
        eventId: event.value.eventId,
        authority: fixture.technical,
      }),
    ).toMatchObject({ value: { health: { grantProblemCount: 1 } } });
    const afterExpiredHealth = await fixture.storage.transaction((transaction) => ({
      grant: transaction.findGrantById(control.grantId),
      sessions: transaction.listGrantSessions(control.grantId),
      audit: transaction.listGrantAudit(control.grantId),
    }));
    expect(afterExpiredHealth).toEqual(beforeExpiredHealth);
  });

  test("previews and atomically removes an empty Event with its Event Admin authority", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Remove Event", timeZone: "UTC" },
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
    if (grant.status !== "accepted") throw new Error("Expected Event Admin Grant.");
    const revealed = await fixture.grants.revealGrant(grant.value.grantId, fixture.technical);
    if (revealed.status !== "revealed") throw new Error("Expected Grant reveal.");
    const admission = await fixture.administration.admitEventAdmin({
      qrCredential: revealed.qrCredential,
      browserContext: "removal-browser",
    });
    if (admission.status !== "admitted") throw new Error("Expected Grant Session.");
    const eventAdmin = { kind: "grant-session" as const, sessionBearer: admission.sessionBearer };
    const beforeAudit = await fixture.storage.transaction((transaction) =>
      transaction.listEventAuditTrail(event.value.eventId),
    );

    const preview = await fixture.administration.previewEventCatalogRemoval(
      { kind: "game-day", eventId: event.value.eventId, targetId: day.value.gameDayId },
      eventAdmin,
    );
    expect(preview).toMatchObject({
      status: "accepted",
      value: {
        eligible: true,
        target: { kind: "game-day", targetId: day.value.gameDayId },
        impact: { retiredAuthorityCount: 0 },
      },
    });
    if (preview.status !== "accepted") throw new Error("Expected removal preview.");
    const afterPreviewGrant = await fixture.storage.transaction((transaction) =>
      transaction.findGrantById(grant.value.grantId),
    );
    expect(afterPreviewGrant?.status).toBe("active");
    const sessionBeforeRemoval = await fixture.storage.transaction(
      (transaction) => transaction.listGrantSessions(grant.value.grantId)[0],
    );
    if (sessionBeforeRemoval === undefined)
      throw new Error("Expected persisted Event Admin session.");
    const removedDay = await fixture.administration.removeEventCatalogEntry(
      {
        kind: "game-day",
        eventId: event.value.eventId,
        targetId: day.value.gameDayId,
        previewFingerprint: preview.value.fingerprint,
      },
      eventAdmin,
    );
    expect(removedDay).toMatchObject({ status: "accepted", value: { removed: true } });
    expect(removedDay.sessionExpiresAtMs).toBeTypeOf("number");
    const sessionAfterRemoval = await fixture.storage.transaction(
      (transaction) => transaction.listGrantSessions(grant.value.grantId)[0],
    );
    expect(sessionAfterRemoval?.lastActiveAtMs).toBeGreaterThanOrEqual(
      sessionBeforeRemoval.lastActiveAtMs,
    );
    expect(removedDay.sessionExpiresAtMs).toBe(
      Math.min(
        afterPreviewGrant?.expiresAtMs ?? Number.MAX_SAFE_INTEGER,
        (sessionAfterRemoval?.lastActiveAtMs ?? 0) + 30 * 24 * 60 * 60 * 1000,
      ),
    );

    const eventRemovalPreview = await fixture.administration.previewEventCatalogRemoval(
      {
        kind: "event",
        eventId: event.value.eventId,
        targetId: event.value.eventId,
      },
      fixture.technical,
    );
    if (eventRemovalPreview.status !== "accepted") throw new Error("Expected Event preview.");
    const removed = await fixture.administration.removeEventCatalogEntry(
      {
        kind: "event",
        eventId: event.value.eventId,
        targetId: event.value.eventId,
        previewFingerprint: eventRemovalPreview.value.fingerprint,
      },
      fixture.technical,
    );
    expect(removed).toMatchObject({ status: "accepted", value: { removed: true } });
    const retiredGrant = await fixture.storage.transaction((transaction) =>
      transaction.findGrantById(grant.value.grantId),
    );
    expect(retiredGrant).toMatchObject({
      status: "expired",
      credential: { materialState: "erased", ciphertext: null, lookupDigest: null },
    });
    expect(
      (
        await fixture.storage.transaction((transaction) =>
          transaction.listGrantSessions(grant.value.grantId),
        )
      )[0],
    ).toMatchObject({ status: "expired", bearerMaterialState: "erased" });
    const afterAudit = await fixture.storage.transaction((transaction) =>
      transaction.listEventAuditTrail(event.value.eventId),
    );
    expect(afterAudit.length).toBeGreaterThan(beforeAudit.length);
    const removalAudit = afterAudit.find(
      (entry) =>
        entry.action === "event-catalog-entry-removed" &&
        entry.before !== null &&
        typeof entry.before === "object" &&
        "kind" in entry.before &&
        entry.before.kind === "event",
    );
    expect(removalAudit).toMatchObject({
      before: {
        kind: "event",
        eventId: event.value.eventId,
        targetId: event.value.eventId,
      },
      after: null,
    });
    expect(JSON.stringify(removalAudit)).not.toMatch(
      /credential|code|session|gameCode|gameDesignation|sideA|sideB/i,
    );
    expect(
      await fixture.administration.openEventHub({
        eventId: event.value.eventId,
        authority: fixture.technical,
      }),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
  });

  test("rejects a stale removal acceptance without changing the target", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Stale Removal", timeZone: "UTC" },
      fixture.technical,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    const first = event;
    const preview = await fixture.administration.previewEventCatalogRemoval(
      { kind: "event", eventId: event.value.eventId, targetId: first.value.eventId },
      fixture.technical,
    );
    if (preview.status !== "accepted") throw new Error("Expected preview.");
    await fixture.catalog.updateEvent(
      event.value.eventId,
      { name: "Stale Removal Updated" },
      fixture.technical,
    );
    expect(
      await fixture.administration.removeEventCatalogEntry(
        {
          kind: "event",
          eventId: event.value.eventId,
          targetId: first.value.eventId,
          previewFingerprint: preview.value.fingerprint,
        },
        fixture.technical,
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });
    expect(
      await fixture.catalog.inspectEvent(event.value.eventId, fixture.technical),
    ).toMatchObject({
      status: "accepted",
      value: { name: "Stale Removal Updated" },
    });
  });

  test("requires an opaque nonempty fingerprint and binds acceptance to complete authority impact", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Fingerprint Removal", timeZone: "UTC" },
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
      { name: "Fingerprint Pitch" },
      fixture.technical,
    );
    if (day.status !== "accepted" || pitch.status !== "accepted")
      throw new Error("Expected catalog structure.");
    const eventGrant = await fixture.administration.createEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    if (eventGrant.status !== "accepted") throw new Error("Expected Event Admin Grant.");
    const revealed = await fixture.grants.revealGrant(eventGrant.value.grantId, fixture.technical);
    if (revealed.status !== "revealed") throw new Error("Expected Event Admin credential.");
    const admission = await fixture.administration.admitEventAdmin({
      qrCredential: revealed.qrCredential,
      browserContext: "fingerprint-removal-browser",
    });
    if (admission.status !== "admitted") throw new Error("Expected Event Admin session.");
    const authority = { kind: "grant-session" as const, sessionBearer: admission.sessionBearer };
    const preview = await fixture.administration.previewEventCatalogRemoval(
      { kind: "pitch", eventId: event.value.eventId, targetId: pitch.value.pitchId },
      authority,
    );
    if (preview.status !== "accepted") throw new Error("Expected removal preview.");
    expect(preview.value.fingerprint).toMatch(/^event-catalog-removal-v1:[A-Za-z0-9_-]+$/u);
    const beforeMissing = await fixture.storage.transaction((transaction) => ({
      pitch: transaction.findPitch(pitch.value.pitchId),
      grants: transaction.listGrants(),
      grantAudit: transaction.listGrantAudit(eventGrant.value.grantId),
      catalogAudit: transaction.listEventAuditTrail(event.value.eventId),
    }));
    for (const suppliedFingerprint of [undefined, "", "not-a-valid-removal-fingerprint"]) {
      expect(
        await fixture.administration.removeEventCatalogEntry(
          {
            kind: "pitch",
            eventId: event.value.eventId,
            targetId: pitch.value.pitchId,
            ...(suppliedFingerprint === undefined
              ? {}
              : { previewFingerprint: suppliedFingerprint }),
          },
          authority,
        ),
      ).toMatchObject({ status: "rejected", reason: "invalid-input" });
    }
    const afterMissing = await fixture.storage.transaction((transaction) => ({
      pitch: transaction.findPitch(pitch.value.pitchId),
      grants: transaction.listGrants(),
      grantAudit: transaction.listGrantAudit(eventGrant.value.grantId),
      catalogAudit: transaction.listEventAuditTrail(event.value.eventId),
    }));
    expect(afterMissing).toEqual(beforeMissing);

    const pitchGrant = await fixture.administration.createPitchManagerGrant(
      event.value.eventId,
      day.value.gameDayId,
      pitch.value.pitchId,
      authority,
    );
    if (pitchGrant.status !== "accepted") throw new Error("Expected Pitch Manager Grant.");
    const beforeCreateRace = await fixture.storage.transaction((transaction) => ({
      sessions: transaction.listGrantSessions(eventGrant.value.grantId),
      grantAudit: transaction.listGrantAudit(eventGrant.value.grantId),
      catalogAudit: transaction.listEventAuditTrail(event.value.eventId),
    }));
    expect(
      await fixture.administration.removeEventCatalogEntry(
        {
          kind: "pitch",
          eventId: event.value.eventId,
          targetId: pitch.value.pitchId,
          previewFingerprint: preview.value.fingerprint,
        },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });
    expect(
      await fixture.storage.transaction((transaction) => ({
        pitch: transaction.findPitch(pitch.value.pitchId),
        grant: transaction.findGrantById(pitchGrant.value.grantId),
      })),
    ).toMatchObject({ pitch: { pitchId: pitch.value.pitchId }, grant: { status: "active" } });
    const afterCreateRace = await fixture.storage.transaction((transaction) => ({
      sessions: transaction.listGrantSessions(eventGrant.value.grantId),
      grantAudit: transaction.listGrantAudit(eventGrant.value.grantId),
      catalogAudit: transaction.listEventAuditTrail(event.value.eventId),
    }));
    expect(afterCreateRace).toEqual(beforeCreateRace);

    const changedPitch = await fixture.catalog.createPitch(
      event.value.eventId,
      { name: "Changed Fingerprint Pitch" },
      fixture.technical,
    );
    if (changedPitch.status !== "accepted") throw new Error("Expected changed Pitch.");
    const changedGrant = await fixture.administration.createPitchManagerGrant(
      event.value.eventId,
      day.value.gameDayId,
      changedPitch.value.pitchId,
      authority,
    );
    if (changedGrant.status !== "accepted") throw new Error("Expected changed Pitch Grant.");
    const changedPreview = await fixture.administration.previewEventCatalogRemoval(
      { kind: "pitch", eventId: event.value.eventId, targetId: changedPitch.value.pitchId },
      authority,
    );
    if (changedPreview.status !== "accepted") throw new Error("Expected changed Pitch preview.");
    expect(
      await fixture.administration.disablePitchManagerGrant(
        event.value.eventId,
        day.value.gameDayId,
        changedPitch.value.pitchId,
        authority,
      ),
    ).toMatchObject({ status: "accepted" });
    expect(
      await fixture.administration.removeEventCatalogEntry(
        {
          kind: "pitch",
          eventId: event.value.eventId,
          targetId: changedPitch.value.pitchId,
          previewFingerprint: changedPreview.value.fingerprint,
        },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });
    expect(
      await fixture.storage.transaction((transaction) => ({
        pitch: transaction.findPitch(changedPitch.value.pitchId),
        grant: transaction.findGrantById(changedGrant.value.grantId),
      })),
    ).toMatchObject({
      pitch: { pitchId: changedPitch.value.pitchId },
      grant: { status: "disabled" },
    });
  });

  test("limits removal roles and retires only authority owned by the removed structure", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Scoped Removal", timeZone: "UTC" },
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
      throw new Error("Expected catalog structure.");
    const eventGrant = await fixture.administration.createEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    if (eventGrant.status !== "accepted") throw new Error("Expected Event Admin Grant.");
    const eventReveal = await fixture.grants.revealGrant(
      eventGrant.value.grantId,
      fixture.technical,
    );
    if (eventReveal.status !== "revealed") throw new Error("Expected Event Admin credential.");
    const admission = await fixture.administration.admitEventAdmin({
      qrCredential: eventReveal.qrCredential,
      browserContext: "scoped-removal-browser",
    });
    if (admission.status !== "admitted") throw new Error("Expected Event Admin session.");
    const authority = { kind: "grant-session" as const, sessionBearer: admission.sessionBearer };
    expect(
      await fixture.administration.previewEventCatalogRemoval(
        { kind: "pitch", eventId: event.value.eventId, targetId: pitch.value.pitchId },
        fixture.technical,
      ),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
    expect(
      await fixture.administration.previewEventCatalogRemoval(
        { kind: "event", eventId: event.value.eventId, targetId: event.value.eventId },
        authority,
      ),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
    const pitchGrant = await fixture.administration.createPitchManagerGrant(
      event.value.eventId,
      day.value.gameDayId,
      pitch.value.pitchId,
      authority,
    );
    if (pitchGrant.status !== "accepted") throw new Error("Expected Pitch Manager Grant.");
    const preview = await fixture.administration.previewEventCatalogRemoval(
      { kind: "pitch", eventId: event.value.eventId, targetId: pitch.value.pitchId },
      authority,
    );
    expect(preview).toMatchObject({
      status: "accepted",
      value: { eligible: true, impact: { retiredAuthorityCount: 1 } },
    });
    if (preview.status !== "accepted") throw new Error("Expected pitch preview.");
    expect(
      await fixture.administration.removeEventCatalogEntry(
        {
          kind: "pitch",
          eventId: event.value.eventId,
          targetId: pitch.value.pitchId,
          previewFingerprint: preview.value.fingerprint,
        },
        authority,
      ),
    ).toMatchObject({ status: "accepted", value: { retiredAuthorityCount: 1 } });
    expect(
      await fixture.storage.transaction((transaction) => ({
        eventGrant: transaction.findGrantById(eventGrant.value.grantId)?.status,
        pitchGrant: transaction.findGrantById(pitchGrant.value.grantId)?.status,
      })),
    ).toEqual({ eventGrant: "active", pitchGrant: "expired" });
  });

  test("rejects removal after Grant Code or QR material changes without refreshing activity", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Credential fingerprint removal", timeZone: "UTC" },
      fixture.technical,
    );
    const day =
      event.status === "accepted"
        ? await fixture.catalog.addGameDay(
            event.value.eventId,
            { date: "2026-08-14" },
            fixture.technical,
          )
        : null;
    const pitch =
      event.status === "accepted"
        ? await fixture.catalog.createPitch(
            event.value.eventId,
            { name: "Fingerprint Pitch" },
            fixture.technical,
          )
        : null;
    if (event.status !== "accepted" || day?.status !== "accepted" || pitch?.status !== "accepted")
      throw new Error("Expected removal structure.");
    const eventGrant = await fixture.administration.createEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    if (eventGrant.status !== "accepted") throw new Error("Expected Event Admin Grant.");
    const reveal = await fixture.grants.revealGrant(eventGrant.value.grantId, fixture.technical);
    if (reveal.status !== "revealed") throw new Error("Expected Event Admin credential.");
    const admission = await fixture.administration.admitEventAdmin({
      qrCredential: reveal.qrCredential,
      browserContext: "credential-fingerprint-browser",
    });
    if (admission.status !== "admitted") throw new Error("Expected Event Admin session.");
    const eventAdmin = { kind: "grant-session" as const, sessionBearer: admission.sessionBearer };
    const manager = await fixture.administration.createPitchManagerGrant(
      event.value.eventId,
      day.value.gameDayId,
      pitch.value.pitchId,
      eventAdmin,
    );
    if (manager.status !== "accepted") throw new Error("Expected Pitch Manager Grant.");
    const code = await fixture.grants.createGrantCode(manager.value.grantId, eventAdmin);
    if (code.status !== "created") throw new Error("Expected Grant Code.");

    const codePreview = await fixture.administration.previewEventCatalogRemoval(
      { kind: "pitch", eventId: event.value.eventId, targetId: pitch.value.pitchId },
      eventAdmin,
    );
    if (codePreview.status !== "accepted") throw new Error("Expected code preview.");
    const replace = await fixture.grants.replaceGrantCode(manager.value.grantId, eventAdmin);
    expect(replace).toMatchObject({ status: "replaced" });
    const afterCodeChange = await removalState(fixture, event.value.eventId, manager.value.grantId);
    expect(
      await fixture.administration.removeEventCatalogEntry(
        {
          kind: "pitch",
          eventId: event.value.eventId,
          targetId: pitch.value.pitchId,
          previewFingerprint: codePreview.value.fingerprint,
        },
        eventAdmin,
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });
    expect(await removalState(fixture, event.value.eventId, manager.value.grantId)).toEqual(
      afterCodeChange,
    );

    const qrPreview = await fixture.administration.previewEventCatalogRemoval(
      { kind: "pitch", eventId: event.value.eventId, targetId: pitch.value.pitchId },
      eventAdmin,
    );
    if (qrPreview.status !== "accepted") throw new Error("Expected QR preview.");
    expect(await fixture.grants.rotateGrant(manager.value.grantId, eventAdmin)).toMatchObject({
      status: "updated",
    });
    const afterQrChange = await removalState(fixture, event.value.eventId, manager.value.grantId);
    expect(
      await fixture.administration.removeEventCatalogEntry(
        {
          kind: "pitch",
          eventId: event.value.eventId,
          targetId: pitch.value.pitchId,
          previewFingerprint: qrPreview.value.fingerprint,
        },
        eventAdmin,
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });
    expect(await removalState(fixture, event.value.eventId, manager.value.grantId)).toEqual(
      afterQrChange,
    );
  });

  test("rolls back typed retirement before catalog removal and allows a retry", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Removal rollback", timeZone: "UTC" },
      fixture.technical,
    );
    const day =
      event.status === "accepted"
        ? await fixture.catalog.addGameDay(
            event.value.eventId,
            { date: "2026-08-14" },
            fixture.technical,
          )
        : null;
    const pitch =
      event.status === "accepted"
        ? await fixture.catalog.createPitch(
            event.value.eventId,
            { name: "Rollback Pitch" },
            fixture.technical,
          )
        : null;
    if (event.status !== "accepted" || day?.status !== "accepted" || pitch?.status !== "accepted")
      throw new Error("Expected removal structure.");
    const eventGrant = await fixture.administration.createEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    if (eventGrant.status !== "accepted") throw new Error("Expected Event Admin Grant.");
    const reveal = await fixture.grants.revealGrant(eventGrant.value.grantId, fixture.technical);
    if (reveal.status !== "revealed") throw new Error("Expected Event Admin credential.");
    const admission = await fixture.administration.admitEventAdmin({
      qrCredential: reveal.qrCredential,
      browserContext: "rollback-removal-browser",
    });
    if (admission.status !== "admitted") throw new Error("Expected Event Admin session.");
    const eventAdmin = { kind: "grant-session" as const, sessionBearer: admission.sessionBearer };
    const manager = await fixture.administration.createPitchManagerGrant(
      event.value.eventId,
      day.value.gameDayId,
      pitch.value.pitchId,
      eventAdmin,
    );
    if (manager.status !== "accepted") throw new Error("Expected Pitch Manager Grant.");
    const code = await fixture.grants.createGrantCode(manager.value.grantId, eventAdmin);
    if (code.status !== "created") throw new Error("Expected Grant Code.");
    const preview = await fixture.administration.previewEventCatalogRemoval(
      { kind: "pitch", eventId: event.value.eventId, targetId: pitch.value.pitchId },
      eventAdmin,
    );
    if (preview.status !== "accepted") throw new Error("Expected removal preview.");
    const before = await removalState(fixture, event.value.eventId, manager.value.grantId);
    let inject = true;
    const injectedAdministration = createEventAdministration({
      storage: fixture.storage,
      grants: fixture.grants,
      nowMs: () => Date.parse("2026-08-14T12:00:00Z"),
      removalFailureInjector: () => {
        if (inject) {
          inject = false;
          throw new Error("injected removal failure after Grant retirement");
        }
      },
    });
    expect(
      await injectedAdministration.removeEventCatalogEntry(
        {
          kind: "pitch",
          eventId: event.value.eventId,
          targetId: pitch.value.pitchId,
          previewFingerprint: preview.value.fingerprint,
        },
        eventAdmin,
      ),
    ).toMatchObject({ status: "retryable-failure" });
    expect(await removalState(fixture, event.value.eventId, manager.value.grantId)).toEqual(before);
    expect(
      await injectedAdministration.removeEventCatalogEntry(
        {
          kind: "pitch",
          eventId: event.value.eventId,
          targetId: pitch.value.pitchId,
          previewFingerprint: preview.value.fingerprint,
        },
        eventAdmin,
      ),
    ).toMatchObject({ status: "accepted", value: { removed: true } });
    expect(await removalState(fixture, event.value.eventId, manager.value.grantId)).toMatchObject({
      event: { eventId: event.value.eventId },
      grant: { status: "expired" },
      pitches: [],
    });
  });

  test("refreshes existing private and public readers after accepted removal", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Projection removal", timeZone: "UTC" },
      fixture.technical,
    );
    const day =
      event.status === "accepted"
        ? await fixture.catalog.addGameDay(
            event.value.eventId,
            { date: "2026-08-14" },
            fixture.technical,
          )
        : null;
    const pitch =
      event.status === "accepted"
        ? await fixture.catalog.createPitch(
            event.value.eventId,
            { name: "Projection Pitch" },
            fixture.technical,
          )
        : null;
    if (event.status !== "accepted" || day?.status !== "accepted" || pitch?.status !== "accepted")
      throw new Error("Expected removal structure.");
    expect(
      await fixture.catalog.changePublicationStatus(
        event.value.eventId,
        { status: "published" },
        fixture.technical,
      ),
    ).toMatchObject({ status: "accepted" });
    const grant = await fixture.administration.createEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    if (grant.status !== "accepted") throw new Error("Expected Event Admin Grant.");
    const reveal = await fixture.grants.revealGrant(grant.value.grantId, fixture.technical);
    if (reveal.status !== "revealed") throw new Error("Expected Event Admin credential.");
    const admission = await fixture.administration.admitEventAdmin({
      qrCredential: reveal.qrCredential,
      browserContext: "projection-removal-browser",
    });
    if (admission.status !== "admitted") throw new Error("Expected Event Admin session.");
    const eventAdmin = { kind: "grant-session" as const, sessionBearer: admission.sessionBearer };
    const preview = await fixture.administration.previewEventCatalogRemoval(
      { kind: "pitch", eventId: event.value.eventId, targetId: pitch.value.pitchId },
      eventAdmin,
    );
    if (preview.status !== "accepted") throw new Error("Expected removal preview.");
    expect(
      await fixture.administration.removeEventCatalogEntry(
        {
          kind: "pitch",
          eventId: event.value.eventId,
          targetId: pitch.value.pitchId,
          previewFingerprint: preview.value.fingerprint,
        },
        eventAdmin,
      ),
    ).toMatchObject({ status: "accepted" });
    expect(
      await fixture.administration.openEventHub({
        eventId: event.value.eventId,
        gameDayId: day.value.gameDayId,
        authority: eventAdmin,
      }),
    ).toMatchObject({ status: "accepted", value: { event: { pitches: [] } } });
    expect(
      await fixture.administration.openSlotSetup(
        event.value.eventId,
        day.value.gameDayId,
        eventAdmin,
      ),
    ).toMatchObject({ status: "accepted", value: { pitches: [], eventGames: [] } });
    expect(
      await fixture.administration.openPitchView(
        event.value.eventId,
        day.value.gameDayId,
        pitch.value.pitchId,
        eventAdmin,
      ),
    ).toMatchObject({ status: "rejected", reason: "not-found" });
    const audience = createAudienceProjection(
      createFoundationEventCatalogStorage(fixture.storage),
      {
        now: () => Date.parse("2026-08-14T12:00:00Z"),
      },
    );
    expect(await audience.read(event.value.eventId)).toMatchObject({
      status: "accepted",
      value: { publicationStatus: "published", pitches: [] },
    });
  });

  test("fails closed when owned authority scope is malformed", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Malformed authority removal", timeZone: "UTC" },
      fixture.technical,
    );
    const day =
      event.status === "accepted"
        ? await fixture.catalog.addGameDay(
            event.value.eventId,
            { date: "2026-08-14" },
            fixture.technical,
          )
        : null;
    const pitch =
      event.status === "accepted"
        ? await fixture.catalog.createPitch(
            event.value.eventId,
            { name: "Malformed Pitch" },
            fixture.technical,
          )
        : null;
    if (event.status !== "accepted" || day?.status !== "accepted" || pitch?.status !== "accepted")
      throw new Error("Expected removal structure.");
    const eventGrant = await fixture.administration.createEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    if (eventGrant.status !== "accepted") throw new Error("Expected Event Admin Grant.");
    const reveal = await fixture.grants.revealGrant(eventGrant.value.grantId, fixture.technical);
    if (reveal.status !== "revealed") throw new Error("Expected Event Admin credential.");
    const admission = await fixture.administration.admitEventAdmin({
      qrCredential: reveal.qrCredential,
      browserContext: "malformed-authority-browser",
    });
    if (admission.status !== "admitted") throw new Error("Expected Event Admin session.");
    const eventAdmin = { kind: "grant-session" as const, sessionBearer: admission.sessionBearer };
    const manager = await fixture.administration.createPitchManagerGrant(
      event.value.eventId,
      day.value.gameDayId,
      pitch.value.pitchId,
      eventAdmin,
    );
    if (manager.status !== "accepted") throw new Error("Expected Pitch Manager Grant.");
    const malformedStorage = new Proxy(fixture.storage, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return (work: (transaction: unknown) => unknown) =>
          target.transaction((transaction) => {
            const wrapped = new Proxy(transaction, {
              get(transactionTarget, transactionProperty, transactionReceiver) {
                if (transactionProperty !== "listGrants")
                  return Reflect.get(transactionTarget, transactionProperty, transactionReceiver);
                return () => {
                  const grants = transactionTarget.listGrants();
                  const stored = grants.find((grant) => grant.grantId === manager.value.grantId);
                  if (stored === undefined) return grants;
                  return [
                    ...grants.filter((grant) => grant.grantId !== manager.value.grantId),
                    {
                      ...stored,
                      scope: { eventId: event.value.eventId, pitchId: pitch.value.pitchId },
                    },
                  ];
                };
              },
            });
            return work(wrapped);
          });
      },
    }) as FoundationStorage;
    const malformedAdministration = createEventAdministration({
      storage: malformedStorage,
      grants: fixture.grants,
      nowMs: () => Date.parse("2026-08-14T12:00:00Z"),
    });
    const preview = await malformedAdministration.previewEventCatalogRemoval(
      { kind: "pitch", eventId: event.value.eventId, targetId: pitch.value.pitchId },
      eventAdmin,
    );
    expect(preview).toMatchObject({
      status: "accepted",
      value: {
        eligible: false,
        repairWorkflow: "Event Catalog removal is unavailable.",
        impact: { retiredAuthorityCount: 0 },
      },
    });
    if (preview.status !== "accepted") return;
    const before = await fixture.storage.transaction((transaction) => ({
      pitch: transaction.findPitch(pitch.value.pitchId),
      grant: transaction.findGrantById(manager.value.grantId),
      session: transaction.listGrantSessions(eventGrant.value.grantId),
      audit: transaction.listEventAuditTrail(event.value.eventId),
    }));
    expect(
      await malformedAdministration.removeEventCatalogEntry(
        {
          kind: "pitch",
          eventId: event.value.eventId,
          targetId: pitch.value.pitchId,
          previewFingerprint: preview.value.fingerprint,
        },
        eventAdmin,
      ),
    ).toMatchObject({ status: "rejected", reason: "in-use" });
    expect(
      await fixture.storage.transaction((transaction) => ({
        pitch: transaction.findPitch(pitch.value.pitchId),
        grant: transaction.findGrantById(manager.value.grantId),
        session: transaction.listGrantSessions(eventGrant.value.grantId),
        audit: transaction.listEventAuditTrail(event.value.eventId),
      })),
    ).toEqual(before);
  });

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

  test("lets Event Admin authority configure a Game Day without forecast evidence", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Heat Administration Event", timeZone: "UTC" },
      fixture.technical,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    const day = await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-15" },
      fixture.technical,
    );
    if (day.status !== "accepted") throw new Error("Expected Game Day.");
    const grant = await fixture.administration.createEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    if (grant.status !== "accepted") throw new Error("Expected Event Admin Grant.");
    const reveal = await fixture.grants.revealGrant(grant.value.grantId, fixture.technical);
    if (reveal.status !== "revealed") throw new Error("Expected Grant reveal.");
    const admission = await fixture.administration.admitEventAdmin({
      qrCredential: reveal.qrCredential,
      browserContext: "heat-admin-browser",
    });
    if (admission.status !== "admitted") throw new Error("Expected Event Admin session.");
    const eventAdmin = { kind: "grant-session" as const, sessionBearer: admission.sessionBearer };

    expect(
      await fixture.administration.setGameDayHeatStoppageConfiguration(
        event.value.eventId,
        day.value.gameDayId,
        { configuration: "enabled" },
        eventAdmin,
      ),
    ).toMatchObject({
      status: "accepted",
      value: { heatStoppageConfiguration: "enabled" },
    });
    expect(
      await fixture.administration.setGameDayHeatStoppageConfiguration(
        event.value.eventId,
        day.value.gameDayId,
        { configuration: "disabled" },
        { kind: "grant-session", sessionBearer: "wrong-session" },
      ),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
    const hub = await fixture.administration.openEventHub({
      eventId: event.value.eventId,
      gameDayId: day.value.gameDayId,
      authority: eventAdmin,
    });
    expect(hub).toMatchObject({
      status: "accepted",
      value: { event: { gameDays: [{ heatStoppageConfiguration: "enabled" }] } },
    });
  });

  test("denies real Pitch Manager and Controller authorities without mutation", async () => {
    const fixture = createFixture(undefined, {
      resolve: () => ({ status: "eligible", eventGameId: "heat-controller-game" }),
    });
    const event = await fixture.catalog.createEvent(
      { name: "Heat Authority Boundary", timeZone: "UTC" },
      fixture.technical,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    const day = await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-15" },
      fixture.technical,
    );
    const pitch = await fixture.administration.createPitch(
      event.value.eventId,
      { name: "Heat Pitch" },
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
    const eventAdmission = await fixture.administration.admitEventAdmin({
      qrCredential: eventQr.qrCredential,
      browserContext: "heat-boundary-event-admin",
    });
    if (eventAdmission.status !== "admitted") throw new Error("Expected Event Admin session.");
    const eventAuthority = {
      kind: "grant-session" as const,
      sessionBearer: eventAdmission.sessionBearer,
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
    const managerAdmission = await fixture.administration.admitPitchManager({
      qrCredential: managerQr.qrCredential,
      browserContext: "heat-boundary-pitch-manager",
    });
    if (managerAdmission.status !== "admitted") throw new Error("Expected Pitch Manager session.");
    const slot = await fixture.administration.createGameplaySlot(
      event.value.eventId,
      day.value.gameDayId,
      { sequence: 1, scheduledStart: "2026-08-15T10:00" },
      fixture.technical,
    );
    if (slot.status !== "accepted") throw new Error("Expected Gameplay Slot.");
    const pitchSlot = await fixture.storage.transaction(
      (transaction) => transaction.listPitchSlots(day.value.gameDayId, pitch.value.pitchId)[0],
    );
    if (pitchSlot === undefined) throw new Error("Expected Pitch Slot.");
    const control = await fixture.grants.createControlGrant({
      authority: { kind: "grant-session", sessionBearer: managerAdmission.sessionBearer },
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
    const controllerAdmission = await fixture.administration.admitControlGrant({
      qrCredential: controlQr.qrCredential,
      browserContext: "heat-boundary-controller",
    });
    if (controllerAdmission.status !== "admitted") throw new Error("Expected Controller session.");

    const before = await fixture.storage.transaction((transaction) => ({
      gameDays: transaction.listGameDays(event.value.eventId),
      audit: transaction.listEventAuditTrail(event.value.eventId),
    }));
    for (const sessionBearer of [
      managerAdmission.sessionBearer,
      controllerAdmission.sessionBearer,
    ]) {
      expect(
        await fixture.administration.setGameDayHeatStoppageConfiguration(
          event.value.eventId,
          day.value.gameDayId,
          { configuration: "enabled" },
          { kind: "grant-session", sessionBearer },
        ),
      ).toMatchObject({
        status: "rejected",
        reason: "unauthorized",
        detail: "Unable to authorize Event Administration.",
      });
    }
    expect(
      await fixture.storage.transaction((transaction) => ({
        gameDays: transaction.listGameDays(event.value.eventId),
        audit: transaction.listEventAuditTrail(event.value.eventId),
      })),
    ).toEqual(before);
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

  test("composes identity retry, current winner, and transaction rollback through Event Admin", async () => {
    const fixture = createFixture();
    const event = await fixture.catalog.createEvent(
      { name: "Composed identity", timeZone: "UTC" },
      fixture.technical,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    const day = await fixture.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-14" },
      fixture.technical,
    );
    const home = await fixture.catalog.createEventTeam(
      event.value.eventId,
      { name: "Home" },
      fixture.technical,
    );
    const replacement = await fixture.catalog.createEventTeam(
      event.value.eventId,
      { name: "Replacement" },
      fixture.technical,
    );
    const later = await fixture.catalog.createEventTeam(
      event.value.eventId,
      { name: "Later" },
      fixture.technical,
    );
    const other = await fixture.catalog.createEventTeam(
      event.value.eventId,
      { name: "Other" },
      fixture.technical,
    );
    const pitch = await fixture.catalog.createPitch(
      event.value.eventId,
      { name: "Composed Pitch" },
      fixture.technical,
    );
    if (
      day.status !== "accepted" ||
      home.status !== "accepted" ||
      replacement.status !== "accepted" ||
      later.status !== "accepted" ||
      other.status !== "accepted" ||
      pitch.status !== "accepted"
    )
      throw new Error("Expected catalog structure.");
    const slot = await fixture.catalog.createGameplaySlot(
      event.value.eventId,
      day.value.gameDayId,
      { sequence: 1, scheduledStart: "2026-08-14T10:00" },
      fixture.technical,
    );
    if (slot.status !== "accepted") throw new Error("Expected Gameplay Slot.");
    const pitchSlot = (
      await fixture.storage.transaction((transaction) =>
        transaction.listPitchSlots(day.value.gameDayId, pitch.value.pitchId),
      )
    )[0];
    if (pitchSlot === undefined) throw new Error("Expected Pitch Slot.");
    const game = await fixture.catalog.createEventGame(
      event.value.eventId,
      day.value.gameDayId,
      {
        gameplaySlotId: slot.value.gameplaySlotId,
        pitchSlotId: pitchSlot.pitchSlotId,
        sideA: { sourceLabel: "Home" },
        sideB: { sourceLabel: "Other" },
      },
      fixture.technical,
    );
    if (game.status !== "accepted") throw new Error("Expected Event Game.");
    const confirmed = await fixture.catalog.confirmGameplaySlotTeams(
      event.value.eventId,
      day.value.gameDayId,
      slot.value.gameplaySlotId,
      {
        games: [
          {
            eventGameId: game.value.eventGameId,
            sideAEventTeamId: home.value.eventTeamId,
            sideBEventTeamId: other.value.eventTeamId,
          },
        ],
      },
      fixture.technical,
    );
    if (confirmed.status !== "accepted") throw new Error("Expected confirmed Game.");
    const assigned = confirmed.value[0];
    if (assigned === undefined) throw new Error("Expected assigned Game.");
    const root: EventGameRecordRoot = {
      recordId: `record-${game.value.eventGameId}`,
      eventId: event.value.eventId,
      eventGameId: game.value.eventGameId,
      ownership: { eventId: event.value.eventId, eventGameId: game.value.eventGameId },
      externalScope: {
        eventId: event.value.eventId,
        gameDayId: day.value.gameDayId,
        pitchId: pitch.value.pitchId,
        pitchSlotId: pitchSlot.pitchSlotId,
      },
      gameSides: [
        {
          id: assigned.sideA.sideId,
          eventTeamId: home.value.eventTeamId,
          teamInterpretationRef: `event-team:${home.value.eventTeamId}`,
        },
        {
          id: assigned.sideB.sideId,
          eventTeamId: other.value.eventTeamId,
          teamInterpretationRef: `event-team:${other.value.eventTeamId}`,
        },
      ],
      lifecycle: {
        phase: "scheduled",
        commencedAtMs: null,
        finishedAtMs: null,
        lockedAtMs: null,
        lockReason: null,
      },
      compatibility: {
        recordVersion: "record-v1",
        schemaVersion: "schema-v1",
        interpreterVersion: "live-event-iqa-v1",
      },
      creationEvidence: {
        operationId: "record-registration",
        actorReference: "technical-admin",
        source: "event-game-registration",
        createdAtMs: Date.parse("2026-08-14T12:00:00Z"),
      },
    };
    const externalScopeResolver = {
      resolve(scope: EventGameRecordRoot["externalScope"], snapshot: FoundationStorageSnapshot) {
        const pitchSlot = snapshot.findPitchSlot?.(scope.pitchSlotId);
        return pitchSlot === null || pitchSlot === undefined
          ? { status: "mismatch" as const, detail: "scope mismatch" }
          : pitchSlot.eventId === scope.eventId &&
              pitchSlot.gameDayId === scope.gameDayId &&
              pitchSlot.pitchId === scope.pitchId
            ? { status: "resolved" as const, scope: structuredClone(scope) }
            : { status: "mismatch" as const, detail: "scope mismatch" };
      },
      resolveEventTeam(eventId: string, eventTeamId: string, snapshot: FoundationStorageSnapshot) {
        const team = snapshot.findEventTeam(eventTeamId);
        return team === null || team.eventId !== eventId
          ? { status: "missing" as const, detail: "Event Team is unavailable." }
          : { status: "resolved" as const };
      },
    };
    const record = createEventGameRecord(fixture.storage, {
      externalScopeResolver,
      interpreter: createLiveEventGameIqaInterpreter(),
      clock: () => Date.parse("2026-08-14T12:00:00Z"),
    });
    expect(await record.registerRoot(root)).toMatchObject({ status: "registered" });
    const administration = createEventAdministration({
      storage: fixture.storage,
      grants: fixture.grants,
      nowMs: () => Date.parse("2026-08-14T12:00:00Z"),
      eventGameRecordTransaction: (transaction) =>
        createEventGameRecordTransactionSeam(transaction, {
          externalScopeResolver,
          interpreter: createLiveEventGameIqaInterpreter(),
          clock: () => Date.parse("2026-08-14T12:00:00Z"),
        }),
    });
    const grant = await administration.createEventAdminGrant(
      event.value.eventId,
      fixture.technical,
    );
    if (grant.status !== "accepted") throw new Error("Expected Event Admin Grant.");
    const revealed = await fixture.grants.revealGrant(grant.value.grantId, fixture.technical);
    if (revealed.status !== "revealed") throw new Error("Expected Event Admin QR.");
    const admission = await administration.admitEventAdmin({
      qrCredential: revealed.qrCredential,
      browserContext: "composed-identity-admin",
    });
    if (admission.status !== "admitted") throw new Error("Expected Event Admin session.");
    const eventAdmin = { kind: "grant-session" as const, sessionBearer: admission.sessionBearer };
    const identityInput = {
      gameSideId: assigned.sideA.sideId,
      eventTeamId: replacement.value.eventTeamId,
      operationId: "composed-auth-check",
    };
    expect(
      await administration.correctEventGameIdentity(
        "wrong-event",
        day.value.gameDayId,
        game.value.eventGameId,
        identityInput,
        eventAdmin,
      ),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
    expect(
      await administration.correctEventGameIdentity(
        event.value.eventId,
        "wrong-day",
        game.value.eventGameId,
        identityInput,
        eventAdmin,
      ),
    ).toMatchObject({ status: "rejected" });
    expect(
      await administration.correctEventGameIdentity(
        event.value.eventId,
        day.value.gameDayId,
        game.value.eventGameId,
        identityInput,
        { kind: "grant-session", sessionBearer: "wrong-session" },
      ),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
    expect(
      await administration.changePublicationStatus(
        event.value.eventId,
        { status: "published" },
        eventAdmin,
      ),
    ).toMatchObject({ status: "accepted" });

    const first = await administration.correctEventGameIdentity(
      event.value.eventId,
      day.value.gameDayId,
      game.value.eventGameId,
      {
        gameSideId: assigned.sideA.sideId,
        eventTeamId: replacement.value.eventTeamId,
        operationId: "composed-op-a",
      },
      fixture.technical,
    );
    expect(first).toMatchObject({
      status: "accepted",
      value: {
        operationId: "composed-op-a",
        eventTeamId: replacement.value.eventTeamId,
        eventTeamName: "Replacement",
      },
    });
    const second = await administration.correctEventGameIdentity(
      event.value.eventId,
      day.value.gameDayId,
      game.value.eventGameId,
      {
        gameSideId: assigned.sideA.sideId,
        eventTeamId: later.value.eventTeamId,
        operationId: "composed-op-b",
      },
      eventAdmin,
    );
    expect(second).toMatchObject({
      status: "accepted",
      value: { eventTeamId: later.value.eventTeamId },
    });
    const beforeRetry = await fixture.storage.transaction((transaction) => ({
      actions: transaction.listActions(root.recordId),
      recordAudit: transaction.listAuditEntries(root.recordId),
      eventAudit: transaction.listEventAuditTrail(event.value.eventId),
    }));
    const retry = await administration.correctEventGameIdentity(
      event.value.eventId,
      day.value.gameDayId,
      game.value.eventGameId,
      {
        gameSideId: assigned.sideA.sideId,
        eventTeamId: replacement.value.eventTeamId,
        operationId: "composed-op-a",
      },
      fixture.technical,
    );
    expect(retry).toMatchObject({
      status: "accepted",
      value: {
        operationId: "composed-op-a",
        eventTeamId: replacement.value.eventTeamId,
        eventTeamName: "Replacement",
      },
    });
    const afterRetry = await fixture.storage.transaction((transaction) => ({
      actions: transaction.listActions(root.recordId),
      recordAudit: transaction.listAuditEntries(root.recordId),
      eventAudit: transaction.listEventAuditTrail(event.value.eventId),
    }));
    expect(afterRetry).toEqual(beforeRetry);
    expect(
      await fixture.catalog.inspectEvent(event.value.eventId, fixture.technical),
    ).toMatchObject({
      value: {
        eventGames: [{ sideA: { eventTeamId: later.value.eventTeamId, eventTeamName: "Later" } }],
      },
    });

    await fixture.storage.transaction((transaction) => {
      const storedRoot = transaction.findRootByEventGameId(game.value.eventGameId);
      if (storedRoot === null) throw new Error("Expected stored root.");
      const nextRoot: EventGameRecordRoot = structuredClone(storedRoot);
      nextRoot.lifecycle = {
        ...nextRoot.lifecycle,
        phase: "in-progress",
        commencedAtMs: 1,
      };
      transaction.updateRoot({
        root: nextRoot,
        canonicalContent: canonicalizeEventGameRecordRoot(nextRoot),
      });
    });
    expect(
      await administration.correctEventGameIdentity(
        event.value.eventId,
        day.value.gameDayId,
        game.value.eventGameId,
        {
          gameSideId: assigned.sideA.sideId,
          eventTeamId: later.value.eventTeamId,
          operationId: "composed-post-no-confirmation",
        },
        eventAdmin,
      ),
    ).toMatchObject({ status: "rejected" });
    expect(
      await administration.correctEventGameIdentity(
        event.value.eventId,
        day.value.gameDayId,
        game.value.eventGameId,
        {
          gameSideId: assigned.sideA.sideId,
          eventTeamId: replacement.value.eventTeamId,
          operationId: "composed-post-no-reason",
          confirmation: true,
        },
        eventAdmin,
      ),
    ).toMatchObject({ status: "rejected" });
    expect(
      await administration.correctEventGameIdentity(
        event.value.eventId,
        day.value.gameDayId,
        game.value.eventGameId,
        {
          gameSideId: assigned.sideA.sideId,
          eventTeamId: replacement.value.eventTeamId,
          operationId: "composed-post-accepted",
          confirmation: true,
          reason: "Corrected after commencement",
        },
        eventAdmin,
      ),
    ).toMatchObject({
      status: "accepted",
      value: {
        eventTeamId: replacement.value.eventTeamId,
        eventTeamName: "Replacement",
        commenced: true,
        controllerAcknowledgementRequired: true,
      },
    });
    const beforeFailure = await fixture.storage.transaction((transaction) => ({
      actions: transaction.listActions(root.recordId),
      recordAudit: transaction.listAuditEntries(root.recordId),
      eventAudit: transaction.listEventAuditTrail(event.value.eventId),
    }));
    const audience = createAudienceProjection(
      createFoundationEventCatalogStorage(fixture.storage),
      { now: () => Date.parse("2026-08-14T12:00:00Z") },
    );
    const publicBeforeFailure = await audience.read(event.value.eventId);
    const failing = createEventAdministration({
      storage: fixture.storage,
      grants: fixture.grants,
      nowMs: () => Date.parse("2026-08-14T12:00:00Z"),
      eventGameRecordTransaction: () => {
        throw new Error("injected Record failure");
      },
    });
    expect(
      await failing.correctEventGameIdentity(
        event.value.eventId,
        day.value.gameDayId,
        game.value.eventGameId,
        {
          gameSideId: assigned.sideA.sideId,
          eventTeamId: later.value.eventTeamId,
          operationId: "composed-op-failure",
          confirmation: true,
          reason: "Injected failure rollback",
        },
        eventAdmin,
      ),
    ).toMatchObject({ status: "retryable-failure" });
    expect(
      await fixture.storage.transaction((transaction) => transaction.listActions(root.recordId)),
    ).toEqual(beforeFailure.actions);
    expect(
      await fixture.storage.transaction((transaction) =>
        transaction.listAuditEntries(root.recordId),
      ),
    ).toEqual(beforeFailure.recordAudit);
    expect(
      await fixture.storage.transaction((transaction) =>
        transaction.listEventAuditTrail(event.value.eventId),
      ),
    ).toEqual(beforeFailure.eventAudit);
    const publicAfterFailure = await audience.read(event.value.eventId);
    expect(publicAfterFailure).toEqual(publicBeforeFailure);
  });
});

function createFixture(
  storage: FoundationStorage = createInMemoryFoundationStorage(),
  controlScopeResolver: Pick<import("@/lib/grant-types").ControlGrantScopeResolver, "resolve"> = {
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

async function removalState(
  fixture: ReturnType<typeof createFixture>,
  eventId: string,
  grantId: string,
) {
  return fixture.storage.transaction((transaction) => ({
    event: transaction.findEvent(eventId),
    grant: transaction.findGrantById(grantId),
    grants: transaction.listGrants(),
    sessions: transaction.listGrantSessions(grantId),
    grantAudit: transaction.listGrantAudit(grantId),
    eventAudit: transaction.listEventAuditTrail(eventId),
    gameDays: transaction.listGameDays(eventId),
    pitches: transaction.listPitches(eventId),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
