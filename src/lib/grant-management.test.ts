import { describe, expect, test } from "bun:test";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import {
  createGrantAuthority,
  createTypedGrantAuthority,
  createGrantAuthorityVerifier,
  EVENT_ADMIN_GRANT_TYPE,
  PITCH_MANAGER_GRANT_TYPE,
  GRANT_TYPE,
  type GrantAuthorityOptions,
} from "@/lib/grant-authority";
import { type GrantManagementAuthority } from "@/lib/grant-management";
import {
  GENERIC_GRANT_ADMISSION_FAILURE,
  GENERIC_GRANT_AUTHORIZATION_FAILURE,
} from "@/lib/grant-authority-types";
import type { GrantKeyRing } from "@/lib/grant-types";
import { createGrantTestAuthorityVerifier } from "@/lib/grant-authority-test-support";

describe("typed Grant management", () => {
  test("rejects repeated status and session revocation transitions without mutation", async () => {
    const storage = createInMemoryFoundationStorage();
    const authority = createGrantAuthority(
      storage,
      createOptions(() => 1_000),
    );
    try {
      const eventAdmin = await authority.createEventAdminGrant({
        authority: { kind: "technical-admin", id: "tech" },
        scope: { eventId: "event-repeat", eventTimeZone: "UTC", finalGameDayDate: "2026-03-20" },
      });
      if (eventAdmin.status !== "created") throw new Error("Expected Event Admin Grant.");
      const session = await authority.admitGrant({
        qrCredential: eventAdmin.qrCredential,
        browserContext: "repeat-manager",
      });
      if (session.status !== "admitted") throw new Error("Expected Event Admin Session.");
      const control = await authority.createControlGrant({
        authority: { kind: "grant-session", sessionBearer: session.sessionBearer },
        scope: {
          eventId: "event-repeat",
          gameDayId: "day-1",
          pitchId: "pitch-1",
          pitchSlotId: "slot-repeat",
        },
      });
      if (control.status !== "created") throw new Error("Expected Control Grant.");

      expect(
        await authority.disableGrant(control.grantId, {
          kind: "grant-session",
          sessionBearer: session.sessionBearer,
        }),
      ).toMatchObject({ status: "updated" });
      const afterDisable = await storage.transaction((transaction) => ({
        grant: transaction.findGrantById(control.grantId),
        audit: transaction.listGrantAudit(control.grantId),
      }));
      expect(
        await authority.disableGrant(control.grantId, {
          kind: "grant-session",
          sessionBearer: session.sessionBearer,
        }),
      ).toMatchObject({ status: "rejected", reason: "invalid-state" });
      expect(
        await storage.transaction((transaction) => ({
          grant: transaction.findGrantById(control.grantId),
          audit: transaction.listGrantAudit(control.grantId),
        })),
      ).toEqual(afterDisable);

      expect(
        await authority.revokeGrant(control.grantId, {
          kind: "grant-session",
          sessionBearer: session.sessionBearer,
        }),
      ).toMatchObject({ status: "updated" });
      const afterRevoke = await storage.transaction((transaction) => ({
        grant: transaction.findGrantById(control.grantId),
        audit: transaction.listGrantAudit(control.grantId),
      }));
      expect(
        await authority.revokeGrant(control.grantId, {
          kind: "grant-session",
          sessionBearer: session.sessionBearer,
        }),
      ).toMatchObject({ status: "rejected", reason: "invalid-state" });
      expect(
        await storage.transaction((transaction) => ({
          grant: transaction.findGrantById(control.grantId),
          audit: transaction.listGrantAudit(control.grantId),
        })),
      ).toEqual(afterRevoke);

      expect(
        await authority.reactivateGrant(control.grantId, {
          kind: "grant-session",
          sessionBearer: session.sessionBearer,
        }),
      ).toMatchObject({ status: "updated" });
      const afterReactivate = await storage.transaction((transaction) => ({
        grant: transaction.findGrantById(control.grantId),
        audit: transaction.listGrantAudit(control.grantId),
      }));
      expect(
        await authority.reactivateGrant(control.grantId, {
          kind: "grant-session",
          sessionBearer: session.sessionBearer,
        }),
      ).toMatchObject({ status: "rejected", reason: "invalid-state" });
      expect(
        await storage.transaction((transaction) => ({
          grant: transaction.findGrantById(control.grantId),
          audit: transaction.listGrantAudit(control.grantId),
        })),
      ).toEqual(afterReactivate);

      const revealed = await authority.revealGrant(control.grantId, {
        kind: "grant-session",
        sessionBearer: session.sessionBearer,
      });
      if (revealed.status !== "revealed") throw new Error("Expected reactivated credential.");
      const controlSession = await authority.admitGrant({
        qrCredential: revealed.qrCredential,
        browserContext: "repeat-control",
      });
      if (controlSession.status !== "admitted") throw new Error("Expected Control Session.");
      const summaries = await authority.listGrantSessions(control.grantId, {
        kind: "grant-session",
        sessionBearer: session.sessionBearer,
      });
      if (summaries.status !== "ok") throw new Error("Expected session summaries.");
      const label = summaries.value.find((summary) => summary.status === "active")?.label;
      if (label === undefined) throw new Error("Expected active session label.");
      expect(
        await authority.revokeGrantSession(control.grantId, label, {
          kind: "grant-session",
          sessionBearer: session.sessionBearer,
        }),
      ).toMatchObject({ status: "updated" });
      const afterSessionRevoke = await storage.transaction((transaction) =>
        transaction.listGrantAudit(control.grantId),
      );
      expect(
        await authority.revokeGrantSession(control.grantId, label, {
          kind: "grant-session",
          sessionBearer: session.sessionBearer,
        }),
      ).toMatchObject({ status: "rejected", reason: "invalid-state" });
      expect(
        await storage.transaction((transaction) => transaction.listGrantAudit(control.grantId)),
      ).toEqual(afterSessionRevoke);
    } finally {
      storage.close();
    }
  });

  test("uses the typed trusted lifecycle through the primary public facade", async () => {
    const storage = createInMemoryFoundationStorage();
    const authority = createGrantAuthority(
      storage,
      createOptions(() => 1_000),
    );

    expect("admitControlGrant" in authority).toBe(false);
    expect("authorizeControlGrant" in authority).toBe(false);
    const eventAdmin = await authority.createEventAdminGrant({
      authority: { kind: "technical-admin", id: "tech" },
      scope: { eventId: "event-public", eventTimeZone: "UTC", finalGameDayDate: "2026-03-20" },
    });
    expect(eventAdmin.status).toBe("created");
    if (eventAdmin.status !== "created") throw new Error("Expected Event Admin Grant.");
    const eventSession = await authority.admitGrant({
      qrCredential: eventAdmin.qrCredential,
      browserContext: "public-admin",
    });
    expect(eventSession.status).toBe("admitted");
    if (eventSession.status !== "admitted") throw new Error("Expected Event Admin Session.");
    expect(
      await authority.createControlGrant({
        authority: { kind: "grant-session", sessionBearer: eventSession.sessionBearer },
        scope: {
          eventId: "event-public",
          gameDayId: "day-1",
          pitchId: "pitch-1",
          pitchSlotId: "slot-public",
        },
      }),
    ).toMatchObject({ status: "created", grantType: GRANT_TYPE });
    storage.close();
  });

  test("enforces the three typed scopes and privileged management matrix", async () => {
    const storage = createInMemoryFoundationStorage();
    let nowMs = Date.parse("2026-03-20T12:00:00Z");
    const authority = createTypedGrantAuthority(
      storage,
      createOptions(() => nowMs),
    );
    const technical: GrantManagementAuthority = { kind: "technical-admin", id: "tech" };

    const eventAdmin = await authority.createEventAdminGrant({
      authority: technical,
      scope: { eventId: "event-1", eventTimeZone: "Europe/Zurich", finalGameDayDate: "2026-03-20" },
    });
    expect(eventAdmin).toMatchObject({ status: "created", grantType: EVENT_ADMIN_GRANT_TYPE });
    if (eventAdmin.status !== "created") throw new Error("Expected Event Admin Grant.");

    const eventSession = await authority.admitGrant({
      qrCredential: eventAdmin.qrCredential,
      browserContext: "admin",
      deviceClass: "tablet",
      browserClass: "safari",
    });
    expect(eventSession).toMatchObject({
      status: "admitted",
      grantType: EVENT_ADMIN_GRANT_TYPE,
      eventGameId: null,
    });
    if (eventSession.status !== "admitted") throw new Error("Expected Event Admin session.");

    const pitchManager = await authority.createPitchManagerGrant({
      authority: { kind: "grant-session", sessionBearer: eventSession.sessionBearer },
      scope: {
        eventId: "event-1",
        gameDayId: "day-1",
        gameDayDate: "2026-03-20",
        eventTimeZone: "Europe/Zurich",
        pitchId: "pitch-1",
      },
    });
    expect(pitchManager).toMatchObject({ status: "created", grantType: PITCH_MANAGER_GRANT_TYPE });
    if (pitchManager.status !== "created") throw new Error("Expected Pitch Manager Grant.");

    const control = await authority.createControlGrant({
      authority: { kind: "grant-session", sessionBearer: eventSession.sessionBearer },
      scope: { eventId: "event-1", gameDayId: "day-1", pitchId: "pitch-1", pitchSlotId: "slot-1" },
    });
    expect(control).toMatchObject({ status: "created", grantType: GRANT_TYPE });
    if (control.status !== "created") throw new Error("Expected Control Grant.");

    const eventSessionsBefore = await storage.transaction((transaction) =>
      transaction.listGrantSessions(eventAdmin.grantId),
    );
    expect(
      await authority.admitPitchManagerGrant({
        qrCredential: eventAdmin.qrCredential,
        browserContext: "wrong-event-admin",
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      await storage.transaction((transaction) => transaction.listGrantSessions(eventAdmin.grantId)),
    ).toEqual(eventSessionsBefore);
    const pitchManagerSessionsBeforeEventAdminAdmission = await storage.transaction((transaction) =>
      transaction.listGrantSessions(pitchManager.grantId),
    );
    expect(
      await authority.admitEventAdminGrant({
        qrCredential: pitchManager.qrCredential,
        browserContext: "wrong-pitch-manager-for-event-admin",
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      await storage.transaction((transaction) =>
        transaction.listGrantSessions(pitchManager.grantId),
      ),
    ).toEqual(pitchManagerSessionsBeforeEventAdminAdmission);
    const controlCredential = await authority.revealGrant(control.grantId, {
      kind: "grant-session",
      sessionBearer: eventSession.sessionBearer,
    });
    if (controlCredential.status !== "revealed") throw new Error("Expected Control QR.");
    const controlSessionsBefore = await storage.transaction((transaction) =>
      transaction.listGrantSessions(control.grantId),
    );
    expect(
      await authority.admitEventAdminGrant({
        qrCredential: controlCredential.qrCredential,
        browserContext: "wrong-control-for-event-admin",
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      await storage.transaction((transaction) => transaction.listGrantSessions(control.grantId)),
    ).toEqual(controlSessionsBefore);
    expect(
      await authority.admitPitchManagerGrant({
        qrCredential: controlCredential.qrCredential,
        browserContext: "wrong-control",
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      await storage.transaction((transaction) => transaction.listGrantSessions(control.grantId)),
    ).toEqual(controlSessionsBefore);

    const pitchSession = await authority.admitGrant({
      qrCredential: pitchManager.qrCredential,
      browserContext: "manager",
    });
    expect(pitchSession).toMatchObject({ status: "admitted", grantType: PITCH_MANAGER_GRANT_TYPE });
    if (pitchSession.status !== "admitted") throw new Error("Expected Pitch Manager session.");
    expect(
      await authority.revealGrant(control.grantId, {
        kind: "grant-session",
        sessionBearer: pitchSession.sessionBearer,
      }),
    ).toMatchObject({ status: "revealed", grantType: GRANT_TYPE });

    const controllerSession = await authority.admitGrant({
      qrCredential: control.qrCredential,
      browserContext: "controller",
    });
    expect(controllerSession).toMatchObject({ status: "admitted", grantType: GRANT_TYPE });
    if (controllerSession.status !== "admitted") throw new Error("Expected Controller session.");
    const managerSummaries = await authority.listGrantSessions(control.grantId, {
      kind: "grant-session",
      sessionBearer: pitchSession.sessionBearer,
    });
    expect(managerSummaries.status).toBe("ok");
    if (managerSummaries.status !== "ok") throw new Error("Expected manager session summaries.");
    const managerControllerSummary = managerSummaries.value.find(
      (summary) => summary.status === "active",
    );
    if (managerControllerSummary === undefined)
      throw new Error("Expected a manager-visible controller summary.");
    expect(JSON.stringify(managerSummaries)).not.toContain(controllerSession.sessionBearer);
    expect(
      await authority.listGrantAudit(control.grantId, {
        kind: "grant-session",
        sessionBearer: pitchSession.sessionBearer,
      }),
    ).toMatchObject({ status: "unavailable" });
    expect(
      await authority.createGrant({
        grantType: EVENT_ADMIN_GRANT_TYPE,
        authority: { kind: "grant-session", sessionBearer: controllerSession.sessionBearer },
        scope: { eventId: "event-2", eventTimeZone: "UTC", finalGameDayDate: "2026-03-20" },
      }),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });

    const leaver = await authority.admitGrant({
      qrCredential: control.qrCredential,
      browserContext: "leaver",
    });
    expect(leaver).toMatchObject({ status: "admitted" });
    if (leaver.status !== "admitted") throw new Error("Expected leave-test session.");

    const listedBeforeTargetedRevoke = await authority.listGrantSessions(
      control.grantId,
      technical,
    );
    expect(listedBeforeTargetedRevoke.status).toBe("ok");
    if (listedBeforeTargetedRevoke.status !== "ok") throw new Error("Expected session summaries.");
    const controllerSummary = listedBeforeTargetedRevoke.value.find(
      (summary) => summary.label === managerControllerSummary.label,
    );
    if (controllerSummary === undefined) throw new Error("Expected a revocable session summary.");
    expect(
      await authority.revokeGrantSession(control.grantId, controllerSession.grantSessionId, {
        kind: "grant-session",
        sessionBearer: pitchSession.sessionBearer,
      }),
    ).toMatchObject({ status: "rejected", reason: "not-found" });
    expect(
      await authority.revokeGrantSession(eventAdmin.grantId, controllerSummary.label, technical),
    ).toMatchObject({ status: "rejected", reason: "not-found" });
    expect(
      await authority.revokeGrantSession(control.grantId, controllerSummary.label, {
        kind: "grant-session",
        sessionBearer: pitchSession.sessionBearer,
      }),
    ).toMatchObject({ status: "updated" });
    expect(
      await authority.authorizeGrant({
        sessionBearer: controllerSession.sessionBearer,
        eventGameId: "game-1",
      }),
    ).toMatchObject({ status: "rejected" });
    expect(await authority.leaveGrantSession(leaver.sessionBearer)).toMatchObject({
      status: "updated",
    });
    expect(
      await authority.authorizeGrant({
        sessionBearer: leaver.sessionBearer,
        eventGameId: "game-1",
      }),
    ).toMatchObject({
      status: "rejected",
    });
    expect(
      await authority.revokeGrant(control.grantId, {
        kind: "grant-session",
        sessionBearer: pitchSession.sessionBearer,
      }),
    ).toMatchObject({ status: "updated" });
    expect(
      await authority.authorizeGrant({ sessionBearer: pitchSession.sessionBearer }),
    ).toMatchObject({ status: "authorized", grantType: PITCH_MANAGER_GRANT_TYPE });

    const sessions = await authority.listGrantSessions(control.grantId, technical);
    expect(sessions).toMatchObject({ status: "ok" });
    if (sessions.status !== "ok") throw new Error("Expected session summaries.");
    expect(sessions.value[0]).toMatchObject({ deviceClass: "unknown", browserClass: "unknown" });
    expect(JSON.stringify(sessions)).not.toContain(controllerSession.sessionBearer);
    storage.close();
  });

  test("derives Event-time expiry across DST and never revives an expired Grant", async () => {
    const storage = createInMemoryFoundationStorage();
    let nowMs = Date.parse("2026-03-28T12:00:00Z");
    const authority = createTypedGrantAuthority(
      storage,
      createOptions(() => nowMs),
    );
    const created = await authority.createEventAdminGrant({
      authority: { kind: "technical-admin", id: "tech" },
      scope: { eventId: "event-1", eventTimeZone: "Europe/Zurich", finalGameDayDate: "2026-03-28" },
    });
    expect(created.status).toBe("created");
    if (created.status !== "created") throw new Error("Expected Event Admin Grant.");
    if (created.expiresAtMs === null) throw new Error("Expected Event Admin expiry.");
    expect(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Zurich",
        dateStyle: "short",
        timeStyle: "short",
      }).format(created.expiresAtMs),
    ).toContain("04:30");
    nowMs = created.expiresAtMs ?? nowMs;
    const session = await authority.admitGrant({
      qrCredential: created.qrCredential,
      browserContext: "admin",
    });
    expect(session).toMatchObject({ status: "rejected" });
    expect(
      await authority.reactivateGrant(created.grantId, { kind: "technical-admin", id: "tech" }),
    ).toMatchObject({ status: "rejected" });
    storage.close();
  });

  test("rejects forged privileged authority and keeps mandatory caps after null correction", async () => {
    const storage = createInMemoryFoundationStorage();
    let nowMs = Date.parse("2026-03-20T12:00:00Z");
    const options = createOptions(() => nowMs);
    const authority = createTypedGrantAuthority(storage, options);
    const forged = createTypedGrantAuthority(storage, {
      ...options,
      privilegedAuthorityVerifier: { verify: () => null },
    });
    expect(
      await forged.createEventAdminGrant({
        authority: { kind: "technical-admin", id: "tech" },
        scope: { eventId: "event-forged", eventTimeZone: "UTC", finalGameDayDate: "2026-03-20" },
      }),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
    const forgeableVerifier = {
      verify: () => ({ kind: "technical-admin", id: "tech" }),
    } as unknown as GrantAuthorityOptions["privilegedAuthorityVerifier"];
    const unbranded = createTypedGrantAuthority(storage, {
      ...options,
      privilegedAuthorityVerifier: forgeableVerifier,
    });
    expect(
      await unbranded.createEventAdminGrant({
        authority: { kind: "technical-admin", id: "tech" },
        scope: { eventId: "event-unbranded", eventTimeZone: "UTC", finalGameDayDate: "2026-03-20" },
      }),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
    const composed = createGrantAuthorityVerifier((input) =>
      input && typeof input === "object" && (input as { kind?: unknown }).kind === "technical-admin"
        ? { kind: "technical-admin", id: "tech" }
        : null,
    );
    const composedAuthority = createTypedGrantAuthority(storage, {
      ...options,
      privilegedAuthorityVerifier: composed,
    });
    expect(
      await composedAuthority.createEventAdminGrant({
        authority: { kind: "technical-admin", id: "tech" },
        scope: { eventId: "event-composed", eventTimeZone: "UTC", finalGameDayDate: "2026-03-20" },
      }),
    ).toMatchObject({ status: "created" });

    const eventAdmin = await authority.createEventAdminGrant({
      authority: { kind: "technical-admin", id: "tech" },
      scope: { eventId: "event-1", eventTimeZone: "Europe/Zurich", finalGameDayDate: "2026-03-20" },
    });
    expect(eventAdmin.status).toBe("created");
    if (eventAdmin.status !== "created") throw new Error("Expected Event Admin Grant.");
    const eventSession = await authority.admitGrant({
      qrCredential: eventAdmin.qrCredential,
      browserContext: "mandatory-cap-test",
    });
    expect(eventSession.status).toBe("admitted");
    if (eventSession.status !== "admitted") throw new Error("Expected Event Admin Session.");

    const created = await authority.createPitchManagerGrant({
      authority: { kind: "grant-session", sessionBearer: eventSession.sessionBearer },
      scope: {
        eventId: "event-1",
        gameDayId: "day-1",
        gameDayDate: "2026-03-20",
        eventTimeZone: "Europe/Zurich",
        pitchId: "pitch-1",
      },
    });
    expect(created.status).toBe("created");
    if (created.status !== "created") throw new Error("Expected Pitch Manager Grant.");
    expect(
      await authority.recalculateGrantExpiry(
        created.grantId,
        { gameDayDate: "2026-03-21", expiresAtMs: null },
        {
          kind: "grant-session",
          sessionBearer: eventSession.sessionBearer,
        },
      ),
    ).toMatchObject({ status: "updated" });
    const stored = await storage.transaction((transaction) =>
      transaction.findGrantById(created.grantId),
    );
    expect(stored?.expiresAtMs).toBe(Date.parse("2026-03-22T03:30:00Z"));
    expect(
      await authority.recalculateGrantExpiry(
        created.grantId,
        { expiresAtMs: Number.POSITIVE_INFINITY },
        {
          kind: "grant-session",
          sessionBearer: eventSession.sessionBearer,
        },
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });
    nowMs = stored?.expiresAtMs ?? nowMs;
    expect(
      await authority.recalculateGrantExpiry(
        created.grantId,
        { gameDayDate: "2026-03-21" },
        {
          kind: "grant-session",
          sessionBearer: eventSession.sessionBearer,
        },
      ),
    ).toMatchObject({ status: "rejected" });
    storage.close();
  });

  test("rebinds a future metadata correction to a fresh credential and sessions", async () => {
    const storage = createInMemoryFoundationStorage();
    const authority = createGrantAuthority(
      storage,
      createOptions(() => Date.parse("2026-03-20T12:00:00Z")),
    );
    const eventAdmin = await authority.createEventAdminGrant({
      authority: { kind: "technical-admin", id: "tech" },
      scope: { eventId: "event-rebind", eventTimeZone: "UTC", finalGameDayDate: "2026-03-22" },
    });
    if (eventAdmin.status !== "created") throw new Error("Expected Event Admin Grant.");
    const manager = await authority.admitGrant({
      qrCredential: eventAdmin.qrCredential,
      browserContext: "rebind-manager",
    });
    if (manager.status !== "admitted") throw new Error("Expected Event Admin Session.");
    const pitch = await authority.createPitchManagerGrant({
      authority: { kind: "grant-session", sessionBearer: manager.sessionBearer },
      scope: {
        eventId: "event-rebind",
        gameDayId: "day-1",
        gameDayDate: "2026-03-21",
        eventTimeZone: "UTC",
        pitchId: "pitch-1",
      },
    });
    if (pitch.status !== "created") throw new Error("Expected Pitch Manager Grant.");
    const beforeNoOp = await storage.transaction((transaction) => ({
      grant: transaction.findGrantById(pitch.grantId),
      auditCount: transaction.listGrantAudit(pitch.grantId).length,
    }));
    expect(
      await authority.recalculateGrantExpiry(
        pitch.grantId,
        { gameDayDate: "2026-03-21" },
        { kind: "grant-session", sessionBearer: manager.sessionBearer },
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });
    const afterNoOp = await storage.transaction((transaction) => ({
      grant: transaction.findGrantById(pitch.grantId),
      auditCount: transaction.listGrantAudit(pitch.grantId).length,
    }));
    expect(afterNoOp).toEqual(beforeNoOp);
    const oldSession = await authority.admitGrant({
      qrCredential: pitch.qrCredential,
      browserContext: "old-pitch-session",
    });
    if (oldSession.status !== "admitted") throw new Error("Expected Pitch Manager Session.");

    const corrected = await authority.recalculateGrantExpiry(
      pitch.grantId,
      { gameDayDate: "2026-03-23" },
      { kind: "grant-session", sessionBearer: manager.sessionBearer },
    );
    expect(corrected).toMatchObject({ status: "updated" });
    if (corrected.status !== "updated") throw new Error("Expected metadata correction.");
    expect(corrected.grantVersion).not.toBe(pitch.grantVersion);
    expect(
      await authority.admitGrant({
        qrCredential: pitch.qrCredential,
        browserContext: "old-credential",
      }),
    ).toEqual(GENERIC_GRANT_ADMISSION_FAILURE);
    expect(await authority.authorizeGrant({ sessionBearer: oldSession.sessionBearer })).toEqual(
      GENERIC_GRANT_AUTHORIZATION_FAILURE,
    );

    const revealed = await authority.revealGrant(pitch.grantId, {
      kind: "grant-session",
      sessionBearer: manager.sessionBearer,
    });
    expect(revealed.status).toBe("revealed");
    if (revealed.status !== "revealed") throw new Error("Expected rebound credential.");
    expect(revealed.qrCredential).not.toBe(pitch.qrCredential);
    expect(
      await authority.admitGrant({
        qrCredential: revealed.qrCredential,
        browserContext: "fresh-pitch-session",
      }),
    ).toMatchObject({ status: "admitted", grantVersion: corrected.grantVersion });
    storage.close();
  });

  test("terminates Control Sessions on typed terminal scope outcomes and preserves audit provenance", async () => {
    const storage = createInMemoryFoundationStorage();
    let resolution: ReturnType<
      NonNullable<GrantAuthorityOptions["controlScopeResolver"]>["resolve"]
    > = {
      status: "eligible",
      eventGameId: "game-1",
    };
    const options = createOptions(() => 1_000);
    options.controlScopeResolver = { resolve: () => resolution };
    const authority = createTypedGrantAuthority(storage, options);
    const eventAdmin = await authority.createEventAdminGrant({
      authority: { kind: "technical-admin", id: "tech" },
      scope: { eventId: "event-1", eventTimeZone: "UTC", finalGameDayDate: "2026-03-20" },
    });
    if (eventAdmin.status !== "created") throw new Error("Expected Event Admin Grant.");
    const eventSession = await authority.admitGrant({
      qrCredential: eventAdmin.qrCredential,
      browserContext: "terminal-creation",
    });
    if (eventSession.status !== "admitted") throw new Error("Expected Event Admin Session.");
    const control = await authority.createControlGrant({
      authority: { kind: "grant-session", sessionBearer: eventSession.sessionBearer },
      scope: {
        eventId: "event-1",
        gameDayId: "day-1",
        pitchId: "pitch-1",
        pitchSlotId: "slot-terminal",
      },
    });
    if (control.status !== "created") throw new Error("Expected Control Grant.");
    const session = await authority.admitGrant({
      qrCredential: control.qrCredential,
      browserContext: "terminal",
    });
    if (session.status !== "admitted") throw new Error("Expected Control Session.");
    const secondSession = await authority.admitGrant({
      qrCredential: control.qrCredential,
      browserContext: "terminal-2",
    });
    if (secondSession.status !== "admitted") throw new Error("Expected second Control Session.");
    resolution = { status: "terminal", reason: "game-locked", eventGameId: "game-1" };
    expect(
      await authority.authorizeGrant({
        sessionBearer: session.sessionBearer,
        eventGameId: "game-1",
      }),
    ).toMatchObject({
      status: "rejected",
    });
    resolution = { status: "eligible", eventGameId: "game-1" };
    expect(
      await authority.authorizeGrant({
        sessionBearer: session.sessionBearer,
        eventGameId: "game-1",
      }),
    ).toMatchObject({
      status: "rejected",
    });
    const stored = await storage.transaction((transaction) =>
      transaction.listGrantSessions(control.grantId),
    );
    expect(stored).toHaveLength(2);
    expect(stored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "expired",
          bearerMaterialState: "erased",
          bearerLookupVerifier: null,
        }),
        expect.objectContaining({
          status: "expired",
          bearerMaterialState: "erased",
          bearerLookupVerifier: null,
        }),
      ]),
    );
    const audit = await authority.listGrantAudit(control.grantId, {
      kind: "technical-admin",
      id: "tech",
    });
    expect(audit).toMatchObject({ status: "ok" });
    if (audit.status !== "ok") throw new Error("Expected audit evidence.");
    expect(audit.value.filter((entry) => entry.action === "session-terminated")).toEqual([
      expect.objectContaining({ terminalReason: "game-locked", sessionId: session.grantSessionId }),
      expect.objectContaining({
        terminalReason: "game-locked",
        sessionId: secondSession.grantSessionId,
      }),
    ]);
    storage.close();
  });

  test("uses distinct pseudonymous provenance for distinct Grant Sessions and allowlists summaries", async () => {
    const storage = createInMemoryFoundationStorage();
    const authority = createTypedGrantAuthority(
      storage,
      createOptions(() => 1_000),
    );
    const eventAdmin = await authority.createEventAdminGrant({
      authority: { kind: "technical-admin", id: "tech" },
      scope: { eventId: "event-1", eventTimeZone: "UTC", finalGameDayDate: "2026-03-20" },
    });
    if (eventAdmin.status !== "created") throw new Error("Expected Event Admin Grant.");
    const first = await authority.admitGrant({
      qrCredential: eventAdmin.qrCredential,
      browserContext: "admin-1",
    });
    const second = await authority.admitGrant({
      qrCredential: eventAdmin.qrCredential,
      browserContext: "admin-2",
    });
    if (first.status !== "admitted" || second.status !== "admitted")
      throw new Error("Expected Event Admin Sessions.");
    const control = await authority.createControlGrant({
      authority: { kind: "grant-session", sessionBearer: first.sessionBearer },
      scope: {
        eventId: "event-1",
        gameDayId: "day-1",
        pitchId: "pitch-1",
        pitchSlotId: "slot-audit",
      },
    });
    if (control.status !== "created") throw new Error("Expected Control Grant.");
    await authority.revealGrant(control.grantId, {
      kind: "grant-session",
      sessionBearer: first.sessionBearer,
    });
    await authority.revealGrant(control.grantId, {
      kind: "grant-session",
      sessionBearer: second.sessionBearer,
    });
    const audit = await authority.listGrantAudit(control.grantId, {
      kind: "technical-admin",
      id: "tech",
    });
    if (audit.status !== "ok") throw new Error("Expected audit evidence.");
    const revealed = audit.value.filter((entry) => entry.action === "credential-revealed");
    expect(new Set(revealed.map((entry) => entry.actorReference)).size).toBe(2);
    const sessions = await authority.listGrantSessions(eventAdmin.grantId, {
      kind: "technical-admin",
      id: "tech",
    });
    if (sessions.status !== "ok") throw new Error("Expected session summaries.");
    expect(Object.keys(sessions.value[0] ?? {}).sort()).toEqual([
      "browserClass",
      "createdAtMs",
      "deviceClass",
      "label",
      "lastActiveAtMs",
      "revokedAtMs",
      "status",
    ]);
    expect(JSON.stringify(sessions)).not.toMatch(
      /bearer|digest|verifier|keyVersion|grantId|sessionId/i,
    );
    storage.close();
  });

  test("keeps management labels and session audit provenance stable across key rotation", async () => {
    const storage = createInMemoryFoundationStorage();
    const initialOptions = createOptions(() => 1_000);
    const initial = createGrantAuthority(storage, initialOptions);
    const eventAdmin = await initial.createEventAdminGrant({
      authority: { kind: "technical-admin", id: "tech" },
      scope: { eventId: "event-stable", eventTimeZone: "UTC", finalGameDayDate: "2026-03-20" },
    });
    if (eventAdmin.status !== "created") throw new Error("Expected Event Admin Grant.");
    const first = await initial.admitGrant({
      qrCredential: eventAdmin.qrCredential,
      browserContext: "stable-first",
    });
    const second = await initial.admitGrant({
      qrCredential: eventAdmin.qrCredential,
      browserContext: "stable-second",
    });
    if (first.status !== "admitted" || second.status !== "admitted")
      throw new Error("Expected Event Admin Sessions.");
    const control = await initial.createControlGrant({
      authority: { kind: "grant-session", sessionBearer: first.sessionBearer },
      scope: {
        eventId: "event-stable",
        gameDayId: "day-1",
        pitchId: "pitch-1",
        pitchSlotId: "slot-stable",
      },
    });
    if (control.status !== "created") throw new Error("Expected Control Grant.");
    await initial.revealGrant(control.grantId, {
      kind: "grant-session",
      sessionBearer: first.sessionBearer,
    });
    const beforeSessions = await initial.listGrantSessions(eventAdmin.grantId, {
      kind: "technical-admin",
      id: "tech",
    });
    if (beforeSessions.status !== "ok") throw new Error("Expected session summaries.");
    const secondLabel = beforeSessions.value[1]?.label;
    if (secondLabel === undefined) throw new Error("Expected second session label.");

    const rotatedOptions = {
      ...initialOptions,
      keyRing: rotateTestKeyRing(initialOptions.keyRing),
    };
    const rotated = createGrantAuthority(storage, rotatedOptions);
    expect(
      await rotated.rotateGrantCredentialKeys(eventAdmin.grantId, {
        kind: "technical-admin",
        id: "tech",
      }),
    ).toMatchObject({ status: "updated" });
    const afterSessions = await rotated.listGrantSessions(eventAdmin.grantId, {
      kind: "technical-admin",
      id: "tech",
    });
    if (afterSessions.status !== "ok") throw new Error("Expected rotated session summaries.");
    expect(afterSessions.value.map(({ label }) => label)).toEqual(
      beforeSessions.value.map(({ label }) => label),
    );
    await rotated.revealGrant(control.grantId, {
      kind: "grant-session",
      sessionBearer: first.sessionBearer,
    });
    const audit = await rotated.listGrantAudit(control.grantId, {
      kind: "technical-admin",
      id: "tech",
    });
    if (audit.status !== "ok") throw new Error("Expected audit evidence.");
    const references = audit.value
      .filter((entry) => entry.action === "credential-revealed")
      .map((entry) => entry.actorReference);
    expect(references).toHaveLength(2);
    expect(new Set(references).size).toBe(1);
    expect(
      await rotated.revokeGrantSession(eventAdmin.grantId, secondLabel, {
        kind: "technical-admin",
        id: "tech",
      }),
    ).toMatchObject({ status: "updated" });
    expect(await rotated.authorizeGrant({ sessionBearer: second.sessionBearer })).toEqual(
      GENERIC_GRANT_AUTHORIZATION_FAILURE,
    );
    storage.close();
  });
});

function createOptions(nowMs: () => number): GrantAuthorityOptions {
  let call = 0;
  return {
    environmentId: "test-environment",
    clock: { nowMs },
    randomness: {
      bytes: (length) => {
        call += 1;
        return Uint8Array.from({ length }, (_, index) => (index + length + call) % 256);
      },
    },
    keyRing: createKeyRing(),
    controlScopeResolver: { resolve: () => ({ status: "eligible", eventGameId: "game-1" }) },
    privilegedAuthorityVerifier: createGrantTestAuthorityVerifier(),
  };
}

function createKeyRing(): GrantKeyRing {
  return {
    encryption: {
      currentVersion: "encryption-v1",
      keys: new Map([["encryption-v1", Uint8Array.from({ length: 32 }, (_, index) => index + 1)]]),
    },
    lookup: {
      currentVersion: "lookup-v1",
      keys: new Map([["lookup-v1", Uint8Array.from({ length: 32 }, (_, index) => index + 33)]]),
    },
    audit: {
      currentVersion: "audit-v1",
      keys: new Map([["audit-v1", Uint8Array.from({ length: 32 }, (_, index) => index + 65)]]),
    },
  };
}

function rotateTestKeyRing(original: GrantKeyRing): GrantKeyRing {
  return {
    encryption: {
      currentVersion: "encryption-v2",
      keys: new Map([
        ...original.encryption.keys,
        ["encryption-v2", Uint8Array.from({ length: 32 }, (_, index) => 255 - index)],
      ]),
    },
    lookup: {
      currentVersion: "lookup-v2",
      keys: new Map([
        ...original.lookup.keys,
        ["lookup-v2", Uint8Array.from({ length: 32 }, (_, index) => 223 - index)],
      ]),
    },
    audit: original.audit,
  };
}
