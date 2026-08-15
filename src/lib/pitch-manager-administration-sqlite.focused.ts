import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEventAdministration } from "@/lib/event-administration";
import { createEventCatalog, createFoundationEventCatalogStorage } from "@/lib/event-catalog";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import { createGrantAuthority, createGrantAuthorityVerifier } from "@/lib/grant-authority";
import type { FoundationStorage } from "@/lib/foundation-storage";
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

test("SQLite persists a Pitch Manager handoff across restart and expires it at Event time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quadball-timer-pitch-manager-"));
  const databasePath = join(directory, "foundation.sqlite");
  let nowMs = Date.parse("2026-08-14T10:00:00Z");
  const technical = createTechnicalAdminAuth(
    { environment: "test", origin: "https://timer.example", rpId: "timer.example" },
    new MemoryTechnicalAdminAuthRepository(),
  ).resolveHostLocalAuthority();
  let storage: FoundationStorage | undefined;
  try {
    const initial = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
    storage = initial;
    await initial.applyMigrations();
    const first = createFixture(storage, () => nowMs);
    const event = await first.catalog.createEvent(
      { name: "SQLite Pitch Manager", timeZone: "Europe/Zurich" },
      technical,
    );
    if (event.status !== "accepted") throw new Error("Expected Event.");
    const day = await first.catalog.addGameDay(
      event.value.eventId,
      { date: "2026-08-14" },
      technical,
    );
    const pitch = await first.administration.createPitch(
      event.value.eventId,
      { name: "Pitch A" },
      technical,
    );
    if (day.status !== "accepted" || pitch.status !== "accepted")
      throw new Error("Expected Event schedule.");
    const eventGrant = await first.administration.createEventAdminGrant(
      event.value.eventId,
      technical,
    );
    if (eventGrant.status !== "accepted") throw new Error("Expected Event Admin Grant.");
    const eventQr = await first.grants.revealGrant(eventGrant.value.grantId, technical);
    if (eventQr.status !== "revealed") throw new Error("Expected Event Admin QR.");
    const eventSession = await first.administration.admitEventAdmin({
      qrCredential: eventQr.qrCredential,
      browserContext: "sqlite-event-admin",
    });
    if (eventSession.status !== "admitted") throw new Error("Expected Event Admin session.");
    const managerGrant = await first.administration.createPitchManagerGrant(
      event.value.eventId,
      day.value.gameDayId,
      pitch.value.pitchId,
      { kind: "grant-session", sessionBearer: eventSession.sessionBearer },
    );
    if (managerGrant.status !== "accepted") throw new Error("Expected Pitch Manager Grant.");
    const managerQr = await first.administration.revealPitchManagerGrant(
      event.value.eventId,
      day.value.gameDayId,
      pitch.value.pitchId,
      { kind: "grant-session", sessionBearer: eventSession.sessionBearer },
    );
    if (managerQr.status !== "accepted" || managerQr.value.status !== "revealed")
      throw new Error("Expected Pitch Manager QR.");
    const managerSession = await first.administration.admitPitchManager({
      qrCredential: managerQr.value.qrCredential,
      browserContext: "sqlite-manager",
    });
    if (managerSession.status !== "admitted") throw new Error("Expected Manager session.");
    const expiry = managerGrant.value.expiresAtMs;
    storage.close();
    storage = undefined;

    const reopened = openSqliteFoundationStorage(databasePath, { grantKeyRing: keyRing });
    storage = reopened;
    const afterRestart = createFixture(reopened, () => nowMs);
    const view = await afterRestart.administration.openPitchManagerCurrentView({
      authority: { kind: "grant-session", sessionBearer: managerSession.sessionBearer },
    });
    expect(view).toMatchObject({
      status: "accepted",
      value: { eventId: event.value.eventId, gameDayId: day.value.gameDayId },
    });
    if (expiry === null) throw new Error("Expected Pitch Manager expiry.");
    nowMs = expiry;
    expect(
      await afterRestart.administration.openPitchManagerCurrentView({
        authority: { kind: "grant-session", sessionBearer: managerSession.sessionBearer },
      }),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
    const state = await reopened.transaction((transaction) => ({
      grant: transaction.findGrantById(managerGrant.value.grantId),
      session: transaction.listGrantSessions(managerGrant.value.grantId)[0],
      audit: transaction.listGrantAudit(managerGrant.value.grantId),
    }));
    expect(state.grant?.status).toBe("expired");
    expect(state.session?.status).toBe("expired");
    expect(state.audit.some((entry) => entry.action === "grant-expired")).toBe(true);
  } finally {
    storage?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function createFixture(storage: FoundationStorage, nowMs: () => number) {
  const catalog = createEventCatalog(createFoundationEventCatalogStorage(storage), {
    clock: { nowMs },
  });
  const grants = createGrantAuthority(storage, {
    environmentId: "test",
    clock: { nowMs },
    randomness: { bytes: (length) => crypto.getRandomValues(new Uint8Array(length)) },
    keyRing,
    controlScopeResolver: { resolve: () => ({ status: "unavailable" as const }) },
    privilegedAuthorityVerifier: createGrantAuthorityVerifier((input) => {
      if (isTechnicalAdminAuthority(input)) return { kind: "technical-admin", id: input.sessionId };
      if (
        typeof input === "object" &&
        input !== null &&
        "kind" in input &&
        input.kind === "grant-session" &&
        "sessionBearer" in input &&
        typeof input.sessionBearer === "string"
      )
        return { kind: "grant-session", sessionBearer: input.sessionBearer, sessionId: "session" };
      return null;
    }),
  });
  return { catalog, grants, administration: createEventAdministration({ storage, grants, nowMs }) };
}

function bytes(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}
