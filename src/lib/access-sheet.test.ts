import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import QRCode from "qrcode";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventAdministration } from "@/lib/event-administration";
import { createEventCatalog, createFoundationEventCatalogStorage } from "@/lib/event-catalog";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import type { FoundationStorage } from "@/lib/foundation-storage";
import {
  openSqliteFoundationStorage,
  SqliteFoundationFault,
} from "@/lib/foundation-storage-sqlite";
import { createPrintableAccessSheetRenderer } from "@/lib/access-sheet";
import {
  createGrantAuthority,
  createGrantAuthorityVerifier,
  type ControlGrantScopeResolver,
} from "@/lib/grant-authority";
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

describe("Grant Access Sheets", () => {
  test("generates all three QR-only sheets from one catalog snapshot", async () => {
    const fixture = await createFixture();
    const eventAdmin = await fixture.administration.createEventAdminGrant(
      fixture.eventId,
      fixture.technical,
    );
    if (eventAdmin.status !== "accepted") throw new Error("Expected Event Admin Grant.");
    const pitchManager = await fixture.administration.createPitchManagerGrant(
      fixture.eventId,
      fixture.gameDayId,
      fixture.pitchId,
      fixture.technical,
    );
    if (pitchManager.status !== "accepted") throw new Error("Expected Pitch Manager Grant.");
    const secondPitchManager = await fixture.administration.createPitchManagerGrant(
      fixture.eventId,
      fixture.gameDayId,
      fixture.secondPitchId,
      fixture.technical,
    );
    expect(secondPitchManager.status).toBe("accepted");
    const secondDayPitchManager = await fixture.administration.createPitchManagerGrant(
      fixture.eventId,
      fixture.secondGameDayId,
      fixture.pitchId,
      fixture.technical,
    );
    const secondDaySecondPitchManager = await fixture.administration.createPitchManagerGrant(
      fixture.eventId,
      fixture.secondGameDayId,
      fixture.secondPitchId,
      fixture.technical,
    );
    expect(secondDayPitchManager.status).toBe("accepted");
    expect(secondDaySecondPitchManager.status).toBe("accepted");
    const slots = await fixture.storage.transaction((transaction) =>
      transaction.listPitchSlots(fixture.gameDayId, fixture.pitchId),
    );
    const firstPitchSlot = slots[0];
    if (firstPitchSlot === undefined) throw new Error("Expected a first Pitch Slot.");
    await fixture.storage.transaction((transaction) => {
      const existing = transaction
        .listEventGames(fixture.gameDayId)
        .find((game) => game.pitchSlotId === firstPitchSlot.pitchSlotId);
      if (existing === undefined) throw new Error("Expected the fixture Event Game.");
      transaction.insertEventGame({
        ...existing,
        eventGameId: "conflicting-event-game",
        gameCode: "G-CONFLICT",
        gameDesignation: "Conflicting snapshot",
        sideA: { ...existing.sideA, sideId: "conflicting-event-game-side-a" },
        sideB: { ...existing.sideB, sideId: "conflicting-event-game-side-b" },
      });
    });
    for (const slot of slots) {
      const control = await fixture.administration.createControlGrant(
        fixture.eventId,
        fixture.gameDayId,
        fixture.pitchId,
        slot.pitchSlotId,
        fixture.technical,
      );
      expect(control.status).toBe("accepted");
    }

    const eventSheet = await fixture.administration.generateAccessSheet(
      { type: "event-admin", scope: { eventId: fixture.eventId } },
      fixture.technical,
    );
    const pitchSheet = await fixture.administration.generateAccessSheet(
      {
        type: "pitch-manager",
        scope: { eventId: fixture.eventId },
      },
      fixture.technical,
    );
    const controlSheet = await fixture.administration.generateAccessSheet(
      {
        type: "control-grant",
        scope: {
          eventId: fixture.eventId,
          gameDayId: fixture.gameDayId,
          pitchId: fixture.pitchId,
        },
      },
      fixture.technical,
    );

    expect(eventSheet).toMatchObject({
      status: "accepted",
      value: { version: { environmentId: "test", type: "event-admin", testMark: true } },
    });
    expect(pitchSheet).toMatchObject({
      status: "accepted",
      value: { version: { type: "pitch-manager" } },
    });
    expect(controlSheet).toMatchObject({
      status: "accepted",
      value: { version: { type: "control-grant" } },
    });
    if (
      eventSheet.status !== "accepted" ||
      pitchSheet.status !== "accepted" ||
      controlSheet.status !== "accepted"
    )
      throw new Error("Expected all sheets.");
    expect(eventSheet.value.body).toContain("TEST ENVIRONMENT");
    expect((pitchSheet.value.body.match(/class="entry"/g) ?? []).length).toBe(4);
    expect((controlSheet.value.body.match(/class="entry"/g) ?? []).length).toBe(slots.length);
    expect(controlSheet.value.body).toContain("Pitch A · Pitch Slot 1");
    expect(controlSheet.value.body).toContain("Pitch A · Pitch Slot 2");
    expect(controlSheet.value.body).toContain("North");
    expect(controlSheet.value.body).toContain("South");
    expect(controlSheet.value.body).toContain("Conflicting snapshot");
    expect(controlSheet.value.body).not.toContain("grant-code");
    expect(controlSheet.value.body).not.toContain("Grant Code");

    const credentials = await fixture.storage.transaction((transaction) =>
      transaction.listGrants().map((grant) => grant.grantId),
    );
    for (const grantId of credentials) {
      const reveal = await fixture.grants.revealGrant(grantId, fixture.technical);
      if (reveal.status === "revealed")
        expect(controlSheet.value.body).not.toContain(reveal.qrCredential);
    }
    const audits = await fixture.catalog.listAuditTrail(fixture.eventId, fixture.technical);
    expect(audits).toMatchObject({ status: "accepted" });
    if (audits.status !== "accepted") throw new Error("Expected audit trail.");
    const sheetAudits = audits.value.filter((audit) => audit.action === "access-sheet-generated");
    expect(sheetAudits).toHaveLength(3);
    expect(JSON.stringify(sheetAudits)).not.toContain("qrCredential");
    expect(eventSheet.value.body).toContain('role="img" aria-label="QR credential"');
    expect(eventSheet.value.body).toContain(
      '<main class="sheet" aria-labelledby="access-sheet-title">',
    );
    expect(eventSheet.value.body).toContain('lang="en"');
  });

  test("rotation invalidates only the embedded QR for the rotated Grant", async () => {
    const renderedCredentials = new Map<string, string[]>();
    const renderer = createPrintableAccessSheetRenderer();
    const fixture = await createFixture({
      accessSheetRenderer: {
        render(input) {
          renderedCredentials.set(
            input.version.type,
            input.entries.map((entry) => entry.qrCredential),
          );
          return renderer.render(input);
        },
      },
    });
    const eventAdmin = await fixture.administration.createEventAdminGrant(
      fixture.eventId,
      fixture.technical,
    );
    const pitchManager = await fixture.administration.createPitchManagerGrant(
      fixture.eventId,
      fixture.gameDayId,
      fixture.pitchId,
      fixture.technical,
    );
    const secondPitchManager = await fixture.administration.createPitchManagerGrant(
      fixture.eventId,
      fixture.gameDayId,
      fixture.secondPitchId,
      fixture.technical,
    );
    expect(eventAdmin.status).toBe("accepted");
    expect(pitchManager.status).toBe("accepted");
    expect(secondPitchManager.status).toBe("accepted");
    const secondDayPitchManager = await fixture.administration.createPitchManagerGrant(
      fixture.eventId,
      fixture.secondGameDayId,
      fixture.pitchId,
      fixture.technical,
    );
    expect(secondDayPitchManager.status).toBe("accepted");
    const secondDaySecondPitchManager = await fixture.administration.createPitchManagerGrant(
      fixture.eventId,
      fixture.secondGameDayId,
      fixture.secondPitchId,
      fixture.technical,
    );
    expect(secondDaySecondPitchManager.status).toBe("accepted");
    expect(
      await fixture.administration.generateAccessSheet(
        { type: "event-admin", scope: { eventId: fixture.eventId } },
        fixture.technical,
      ),
    ).toMatchObject({ status: "accepted" });
    expect(
      await fixture.administration.generateAccessSheet(
        { type: "pitch-manager", scope: { eventId: fixture.eventId } },
        fixture.technical,
      ),
    ).toMatchObject({ status: "accepted" });
    const oldEventCredential = renderedCredentials.get("event-admin")?.[0];
    const unaffectedPitchCredential = renderedCredentials.get("pitch-manager")?.[0];
    if (oldEventCredential === undefined || unaffectedPitchCredential === undefined)
      throw new Error("Expected generated sheet credentials.");
    const rotated = await fixture.administration.rotateEventAdminGrant(
      fixture.eventId,
      fixture.technical,
    );
    expect(rotated).toMatchObject({ status: "accepted" });
    expect(
      await fixture.administration.admitEventAdmin({
        qrCredential: oldEventCredential,
        browserContext: "rotated-sheet-credential",
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      await fixture.administration.admitPitchManager({
        qrCredential: unaffectedPitchCredential,
        browserContext: "unaffected-sheet-credential",
      }),
    ).toMatchObject({ status: "admitted" });
  });

  test("includes empty and conflicted Control QRs while canonical admission rejects them", async () => {
    let emptySlotId: string | undefined;
    let conflictedSlotId: string | undefined;
    const renderedCredentials: string[] = [];
    const renderer = createPrintableAccessSheetRenderer();
    const controlScopeResolver: ControlGrantScopeResolver = {
      resolve(scope) {
        if (scope.pitchSlotId === emptySlotId) return { status: "empty" };
        if (scope.pitchSlotId === conflictedSlotId) return { status: "conflict" };
        return { status: "eligible", eventGameId: "game-1" };
      },
    };
    const fixture = await createFixture({
      controlScopeResolver,
      accessSheetRenderer: {
        render(input) {
          if (input.version.type === "control-grant")
            renderedCredentials.push(...input.entries.map((entry) => entry.qrCredential));
          return renderer.render(input);
        },
      },
    });
    const slots = await fixture.storage.transaction((transaction) =>
      transaction.listPitchSlots(fixture.gameDayId, fixture.pitchId),
    );
    const emptySlot = slots[1];
    const conflictedSlot = slots[0];
    if (emptySlot === undefined || conflictedSlot === undefined)
      throw new Error("Expected empty and conflicted Pitch Slots.");
    emptySlotId = emptySlot.pitchSlotId;
    conflictedSlotId = conflictedSlot.pitchSlotId;
    await fixture.storage.transaction((transaction) => {
      const existing = transaction
        .listEventGames(fixture.gameDayId)
        .find((game) => game.pitchSlotId === conflictedSlotId);
      if (existing === undefined) throw new Error("Expected the conflicted fixture Event Game.");
      transaction.insertEventGame({
        ...existing,
        eventGameId: "access-sheet-conflict",
        gameCode: "G-CONFLICT-ACCESS-SHEET",
        gameDesignation: "Access Sheet conflict snapshot",
        sideA: { ...existing.sideA, sideId: "access-sheet-conflict-side-a" },
        sideB: { ...existing.sideB, sideId: "access-sheet-conflict-side-b" },
      });
    });
    for (const slot of slots) {
      const grant = await fixture.administration.createControlGrant(
        fixture.eventId,
        fixture.gameDayId,
        fixture.pitchId,
        slot.pitchSlotId,
        fixture.technical,
      );
      expect(grant.status).toBe("accepted");
    }

    const beforeAudit = await fixture.catalog.listAuditTrail(fixture.eventId, fixture.technical);
    const result = await fixture.administration.generateAccessSheet(
      {
        type: "control-grant",
        scope: {
          eventId: fixture.eventId,
          gameDayId: fixture.gameDayId,
          pitchId: fixture.pitchId,
        },
      },
      fixture.technical,
    );
    expect(result).toMatchObject({ status: "accepted" });
    expect(renderedCredentials).toHaveLength(slots.length);
    const emptyIndex = slots.findIndex((slot) => slot.pitchSlotId === emptySlotId);
    const conflictIndex = slots.findIndex((slot) => slot.pitchSlotId === conflictedSlotId);
    expect(emptyIndex).toBeGreaterThanOrEqual(0);
    expect(conflictIndex).toBeGreaterThanOrEqual(0);
    for (const credential of renderedCredentials) {
      expect(
        await fixture.administration.admitControlGrant({
          qrCredential: credential,
          browserContext: `unavailable-control-${credential.slice(0, 8)}`,
        }),
      ).toMatchObject({ status: "rejected" });
    }
    const afterAudit = await fixture.catalog.listAuditTrail(fixture.eventId, fixture.technical);
    expect(afterAudit).not.toEqual(beforeAudit);
  });

  test("does not resolve a disabled Grant into an Access Sheet", async () => {
    const fixture = await createFixture();
    const grant = await fixture.administration.createEventAdminGrant(
      fixture.eventId,
      fixture.technical,
    );
    expect(grant.status).toBe("accepted");
    const disabled = await fixture.administration.disableEventAdminGrant(
      fixture.eventId,
      fixture.technical,
    );
    expect(disabled.status).toBe("accepted");
    const beforeAudit = await fixture.catalog.listAuditTrail(fixture.eventId, fixture.technical);
    expect(
      await fixture.administration.generateAccessSheet(
        { type: "event-admin", scope: { eventId: fixture.eventId } },
        fixture.technical,
      ),
    ).toMatchObject({ status: "rejected" });
    const afterAudit = await fixture.catalog.listAuditTrail(fixture.eventId, fixture.technical);
    expect(afterAudit).toEqual(beforeAudit);
  });

  test("expires an Access Sheet Grant before resolution without an artifact or sheet audit", async () => {
    const fixture = await createFixture();
    const grant = await fixture.administration.createEventAdminGrant(
      fixture.eventId,
      fixture.technical,
    );
    expect(grant.status).toBe("accepted");
    fixture.setNow(Date.parse("2026-08-23T14:00:00Z"));
    const beforeAudit = await fixture.catalog.listAuditTrail(fixture.eventId, fixture.technical);
    const result = await fixture.administration.generateAccessSheet(
      { type: "event-admin", scope: { eventId: fixture.eventId } },
      fixture.technical,
    );
    expect(result).toMatchObject({ status: "rejected" });
    const afterAudit = await fixture.catalog.listAuditTrail(fixture.eventId, fixture.technical);
    expect(afterAudit).toEqual(beforeAudit);
  });

  test("rolls back authority and catalog race mutations before returning a sheet", async () => {
    const authorityRace = await createFixture();
    const eventAdmin = await authorityRace.administration.createEventAdminGrant(
      authorityRace.eventId,
      authorityRace.technical,
    );
    expect(eventAdmin.status).toBe("accepted");
    const beforeAuthorityRace = await authorityRace.storage.transaction((transaction) => ({
      grant: transaction.findGrantById(
        eventAdmin.status === "accepted" ? eventAdmin.value.grantId : "",
      ),
      audits: transaction.listEventAuditTrail(authorityRace.eventId),
    }));
    authorityRace.grants.resolveAccessSheetQrCredentialInTransaction = (transaction, input) => {
      const grantId = input.grantId;
      const grant = transaction.findGrantById(grantId);
      if (grant !== null) transaction.updateGrant({ ...grant, status: "revoked" });
      throw new Error("authority race");
    };
    expect(
      await authorityRace.administration.generateAccessSheet(
        { type: "event-admin", scope: { eventId: authorityRace.eventId } },
        authorityRace.technical,
      ),
    ).toMatchObject({ status: "retryable-failure" });
    const afterAuthorityRace = await authorityRace.storage.transaction((transaction) => ({
      grant: transaction.findGrantById(
        eventAdmin.status === "accepted" ? eventAdmin.value.grantId : "",
      ),
      audits: transaction.listEventAuditTrail(authorityRace.eventId),
    }));
    expect(afterAuthorityRace.grant?.status).toBe("active");
    expect(afterAuthorityRace.audits).toEqual(beforeAuthorityRace.audits);

    const catalogRace = await createFixture();
    const catalogGrant = await catalogRace.administration.createEventAdminGrant(
      catalogRace.eventId,
      catalogRace.technical,
    );
    expect(catalogGrant.status).toBe("accepted");
    const beforeCatalogRace = await catalogRace.storage.transaction((transaction) => ({
      pitch: transaction.findPitch(catalogRace.pitchId),
      audits: transaction.listEventAuditTrail(catalogRace.eventId),
    }));
    const racedPitch = beforeCatalogRace.pitch;
    if (racedPitch === null) throw new Error("Expected catalog Pitch.");
    catalogRace.grants.resolveAccessSheetQrCredentialInTransaction = (transaction) => {
      transaction.updatePitch({ ...racedPitch, name: "Raced Pitch" });
      throw new Error("catalog race");
    };
    expect(
      await catalogRace.administration.generateAccessSheet(
        { type: "event-admin", scope: { eventId: catalogRace.eventId } },
        catalogRace.technical,
      ),
    ).toMatchObject({ status: "retryable-failure" });
    const afterCatalogRace = await catalogRace.storage.transaction((transaction) => ({
      pitch: transaction.findPitch(catalogRace.pitchId),
      audits: transaction.listEventAuditTrail(catalogRace.eventId),
    }));
    expect(afterCatalogRace.pitch?.name).toBe(racedPitch.name);
    expect(afterCatalogRace.audits).toEqual(beforeCatalogRace.audits);
  });

  test("serializes concurrent generations without sharing version or audit identities", async () => {
    const fixture = await createFixture();
    const grant = await fixture.administration.createEventAdminGrant(
      fixture.eventId,
      fixture.technical,
    );
    expect(grant.status).toBe("accepted");
    const results = await Promise.all([
      fixture.administration.generateAccessSheet(
        { type: "event-admin", scope: { eventId: fixture.eventId } },
        fixture.technical,
      ),
      fixture.administration.generateAccessSheet(
        { type: "event-admin", scope: { eventId: fixture.eventId } },
        fixture.technical,
      ),
    ]);
    expect(results.every((result) => result.status === "accepted")).toBe(true);
    if (results[0]?.status !== "accepted" || results[1]?.status !== "accepted")
      throw new Error("Expected concurrent Access Sheet generations.");
    expect(results[0].value.version.versionId).not.toBe(results[1].value.version.versionId);
    const audits = await fixture.catalog.listAuditTrail(fixture.eventId, fixture.technical);
    if (audits.status !== "accepted") throw new Error("Expected audit trail.");
    expect(audits.value.filter((audit) => audit.action === "access-sheet-generated")).toHaveLength(
      2,
    );
  });

  test("escapes structure and keeps the production QR matrix inside the printable SVG", () => {
    const credential = "qr-credential-for-structural-decode";
    const expected = QRCode.create(credential, { errorCorrectionLevel: "M" });
    const rendered = createPrintableAccessSheetRenderer().render({
      version: {
        versionId: "version-qr-structure",
        environmentId: "test",
        type: "event-admin",
        scope: { eventId: "event-qr-structure" },
        generatedAtMs: 1_000,
        testMark: true,
      },
      title: "<script>bad</script>",
      entries: [{ label: "<img src=x>", qrCredential: credential }],
    });
    expect(rendered.body).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(rendered.body).not.toContain("<script>bad</script>");
    expect(rendered.body).toContain("&lt;img src=x&gt;");
    expect(rendered.body).toContain(
      `viewBox="0 0 ${expected.modules.size} ${expected.modules.size}"`,
    );
    expect(rendered.body).toContain('aria-label="QR credential"');
    expect(rendered.body).toContain("@media print");
  });

  test("allows an Event Admin session and rejects a wrong Event scope", async () => {
    const fixture = await createFixture();
    const grant = await fixture.administration.createEventAdminGrant(
      fixture.eventId,
      fixture.technical,
    );
    if (grant.status !== "accepted") throw new Error("Expected Event Admin Grant.");
    const reveal = await fixture.grants.revealGrant(grant.value.grantId, fixture.technical);
    if (reveal.status !== "revealed") throw new Error("Expected QR.");
    const admitted = await fixture.administration.admitEventAdmin({
      qrCredential: reveal.qrCredential,
      browserContext: "access-sheet-browser",
    });
    if (admitted.status !== "admitted") throw new Error("Expected Event Admin Session.");
    expect(
      await fixture.grants.revealGrant(grant.value.grantId, {
        kind: "grant-session",
        sessionBearer: admitted.sessionBearer,
      }),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
    const sessionResult = await fixture.administration.generateAccessSheet(
      { type: "event-admin", scope: { eventId: fixture.eventId } },
      { kind: "grant-session", sessionBearer: admitted.sessionBearer },
    );
    expect(sessionResult.status).toBe("accepted");
    expect(
      await fixture.administration.generateAccessSheet(
        { type: "event-admin", scope: { eventId: "wrong-event" } },
        { kind: "grant-session", sessionBearer: admitted.sessionBearer },
      ),
    ).toMatchObject({ status: "rejected", reason: "unauthorized" });
  });

  test("returns no artifact or audit when rendering fails", async () => {
    const fixture = await createFixture({
      accessSheetRenderer: {
        render() {
          throw new Error("renderer failed");
        },
      },
    });
    const grant = await fixture.administration.createEventAdminGrant(
      fixture.eventId,
      fixture.technical,
    );
    expect(grant.status).toBe("accepted");
    const before = await fixture.catalog.listAuditTrail(fixture.eventId, fixture.technical);
    const result = await fixture.administration.generateAccessSheet(
      { type: "event-admin", scope: { eventId: fixture.eventId } },
      fixture.technical,
    );
    expect(result).toMatchObject({ status: "retryable-failure" });
    const after = await fixture.catalog.listAuditTrail(fixture.eventId, fixture.technical);
    expect(after).toEqual(before);
  });

  test("does not return an artifact when the redacted audit commit fails", async () => {
    const fixture = await createFixture({
      accessSheetIds: {
        next(kind) {
          return kind === "audit" ? "existing-audit-id" : `new-${kind}`;
        },
      },
    });
    const grant = await fixture.administration.createEventAdminGrant(
      fixture.eventId,
      fixture.technical,
    );
    expect(grant.status).toBe("accepted");
    await fixture.storage.transaction((transaction) => {
      transaction.appendEventAudit({
        auditId: "existing-audit-id",
        operationId: "existing-operation-id",
        action: "event-updated",
        eventId: fixture.eventId,
        gameDayId: null,
        actorReference: "technical-admin:test",
        occurredAtMs: 1,
        before: null,
        after: null,
      });
    });
    const result = await fixture.administration.generateAccessSheet(
      { type: "event-admin", scope: { eventId: fixture.eventId } },
      fixture.technical,
    );
    expect(result).toMatchObject({ status: "retryable-failure" });
    const audits = await fixture.catalog.listAuditTrail(fixture.eventId, fixture.technical);
    if (audits.status !== "accepted") throw new Error("Expected audit trail.");
    expect(audits.value.filter((audit) => audit.action === "access-sheet-generated")).toHaveLength(
      0,
    );
  });

  test("uses SQLite transaction boundaries for success and every failure path", async () => {
    await withSqliteStorage(async (storage) => {
      const successful = await createFixture({}, storage);
      const grant = await successful.administration.createEventAdminGrant(
        successful.eventId,
        successful.technical,
      );
      expect(grant.status).toBe("accepted");
      const artifact = await successful.administration.generateAccessSheet(
        { type: "event-admin", scope: { eventId: successful.eventId } },
        successful.technical,
      );
      expect(artifact).toMatchObject({ status: "accepted", value: { contentType: "text/html" } });
      const audit = await successful.catalog.listAuditTrail(
        successful.eventId,
        successful.technical,
      );
      expect(audit).toMatchObject({ status: "accepted" });
      if (audit.status !== "accepted") throw new Error("Expected SQLite audit trail.");
      expect(audit.value.filter((entry) => entry.action === "access-sheet-generated")).toHaveLength(
        1,
      );
    });

    await withSqliteStorage(async (storage) => {
      const failedRender = await createFixture(
        {
          accessSheetRenderer: {
            render() {
              throw new Error("renderer failed");
            },
          },
        },
        storage,
      );
      const grant = await failedRender.administration.createEventAdminGrant(
        failedRender.eventId,
        failedRender.technical,
      );
      expect(grant.status).toBe("accepted");
      const result = await failedRender.administration.generateAccessSheet(
        { type: "event-admin", scope: { eventId: failedRender.eventId } },
        failedRender.technical,
      );
      expect(result).toMatchObject({ status: "retryable-failure" });
      const audit = await failedRender.catalog.listAuditTrail(
        failedRender.eventId,
        failedRender.technical,
      );
      if (audit.status !== "accepted") throw new Error("Expected SQLite audit trail.");
      expect(audit.value.filter((entry) => entry.action === "access-sheet-generated")).toHaveLength(
        0,
      );
    });

    await withSqliteStorage(async (storage) => {
      const failedAudit = await createFixture(
        {
          accessSheetIds: {
            next(kind) {
              return kind === "audit" ? "existing-audit-id" : `new-${kind}`;
            },
          },
        },
        storage,
      );
      const grant = await failedAudit.administration.createEventAdminGrant(
        failedAudit.eventId,
        failedAudit.technical,
      );
      expect(grant.status).toBe("accepted");
      await storage.transaction((transaction) => {
        transaction.appendEventAudit({
          auditId: "existing-audit-id",
          operationId: "existing-operation-id",
          action: "event-updated",
          eventId: failedAudit.eventId,
          gameDayId: null,
          actorReference: "technical-admin:test",
          occurredAtMs: 1,
          before: null,
          after: null,
        });
      });
      const result = await failedAudit.administration.generateAccessSheet(
        { type: "event-admin", scope: { eventId: failedAudit.eventId } },
        failedAudit.technical,
      );
      expect(result).toMatchObject({ status: "retryable-failure" });
      const audit = await failedAudit.catalog.listAuditTrail(
        failedAudit.eventId,
        failedAudit.technical,
      );
      if (audit.status !== "accepted") throw new Error("Expected SQLite audit trail.");
      expect(audit.value.filter((entry) => entry.action === "access-sheet-generated")).toHaveLength(
        0,
      );
    });

    let injectCommitFailure = false;
    await withSqliteStorage(
      async (storage, databasePath) => {
        const failedCommit = await createFixture({}, storage);
        const grant = await failedCommit.administration.createEventAdminGrant(
          failedCommit.eventId,
          failedCommit.technical,
        );
        expect(grant.status).toBe("accepted");
        injectCommitFailure = true;
        const result = await failedCommit.administration.generateAccessSheet(
          { type: "event-admin", scope: { eventId: failedCommit.eventId } },
          failedCommit.technical,
        );
        expect(result).toMatchObject({ status: "retryable-failure" });
        const database = new Database(databasePath);
        expect(
          database
            .query(
              "SELECT COUNT(*) AS count FROM foundation_event_catalog_audit WHERE action = 'access-sheet-generated'",
            )
            .get(),
        ).toEqual({ count: 0 });
        database.close();
      },
      () => injectCommitFailure,
    );
  });
});

async function withSqliteStorage<T>(
  work: (storage: FoundationStorage, databasePath: string) => Promise<T>,
  shouldFailCommit: () => boolean = () => false,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "quadball-timer-access-sheet-"));
  const databasePath = join(directory, "foundation.sqlite");
  const storage = openSqliteFoundationStorage(databasePath, {
    grantKeyRing: keyRing,
    faultInjector(phase) {
      if (shouldFailCommit() && phase === "before-commit")
        throw new SqliteFoundationFault("commit-failure");
    },
  });
  try {
    await storage.applyMigrations({ requireCandidate: false });
    return await work(storage, databasePath);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function createFixture(
  options: {
    controlScopeResolver?: Parameters<typeof createGrantAuthority>[1]["controlScopeResolver"];
    accessSheetRenderer?: Parameters<typeof createEventAdministration>[0]["accessSheetRenderer"];
    accessSheetIds?: Parameters<typeof createEventAdministration>[0]["accessSheetIds"];
  } = {},
  storage: FoundationStorage = createInMemoryFoundationStorage(),
) {
  let nowMs = Date.parse("2026-08-14T12:00:00Z");
  let entropy = 9;
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
      bytes: (length) => {
        const seed = entropy++;
        return Uint8Array.from({ length }, (_, index) => ((seed + index * 31) % 240) + 1);
      },
    },
    keyRing,
    controlScopeResolver: options.controlScopeResolver ?? {
      resolve: () => ({ status: "eligible", eventGameId: "game-1" }),
    },
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
  const administration = createEventAdministration({
    storage,
    grants,
    catalog,
    nowMs: () => nowMs,
    environmentId: "test",
    ...options,
  });
  const event = await catalog.createEvent(
    { name: "Access Sheet Event", timeZone: "UTC" },
    technical,
  );
  if (event.status !== "accepted") throw new Error("Expected Event.");
  const day = await catalog.addGameDay(event.value.eventId, { date: "2026-08-14" }, technical);
  const secondDay = await catalog.addGameDay(
    event.value.eventId,
    { date: "2026-08-15" },
    technical,
  );
  const pitchA = await catalog.createPitch(event.value.eventId, { name: "Pitch A" }, technical);
  const pitchB = await catalog.createPitch(event.value.eventId, { name: "Pitch B" }, technical);
  const slotA = await catalog.createGameplaySlot(
    event.value.eventId,
    day.status === "accepted" ? day.value.gameDayId : "",
    { sequence: 1, scheduledStart: "2026-08-14T10:00" },
    technical,
  );
  const slotB = await catalog.createGameplaySlot(
    event.value.eventId,
    day.status === "accepted" ? day.value.gameDayId : "",
    { sequence: 2, scheduledStart: "2026-08-14T10:30" },
    technical,
  );
  if (
    day.status !== "accepted" ||
    secondDay.status !== "accepted" ||
    pitchA.status !== "accepted" ||
    pitchB.status !== "accepted" ||
    slotA.status !== "accepted" ||
    slotB.status !== "accepted"
  )
    throw new Error("Expected schedule.");
  const teams = await Promise.all([
    catalog.createEventTeam(event.value.eventId, { name: "North" }, technical),
    catalog.createEventTeam(event.value.eventId, { name: "South" }, technical),
  ]);
  if (teams.some((team) => team.status !== "accepted")) throw new Error("Expected teams.");
  const slots = await storage.transaction((transaction) =>
    transaction.listPitchSlots(day.value.gameDayId, pitchA.value.pitchId),
  );
  const firstSlot = slots[0];
  if (firstSlot === undefined) throw new Error("Expected Pitch Slot.");
  const game = await catalog.createEventGame(
    event.value.eventId,
    day.value.gameDayId,
    {
      gameplaySlotId: slotA.value.gameplaySlotId,
      pitchSlotId: firstSlot.pitchSlotId,
      gameCode: "G-1",
      gameDesignation: "Opening Game",
      sideA: { sourceLabel: "North" },
      sideB: { sourceLabel: "South" },
    },
    technical,
  );
  if (game.status !== "accepted") throw new Error("Expected Event Game.");
  const confirmed = await catalog.confirmGameplaySlotTeams(
    event.value.eventId,
    day.value.gameDayId,
    slotA.value.gameplaySlotId,
    {
      games: [
        {
          eventGameId: game.value.eventGameId,
          sideAEventTeamId: teams[0].status === "accepted" ? teams[0].value.eventTeamId : "",
          sideBEventTeamId: teams[1].status === "accepted" ? teams[1].value.eventTeamId : "",
        },
      ],
    },
    technical,
  );
  if (confirmed.status !== "accepted") throw new Error("Expected confirmed teams.");
  return {
    storage,
    catalog,
    grants,
    administration,
    technical,
    eventId: event.value.eventId,
    gameDayId: day.value.gameDayId,
    secondGameDayId: secondDay.value.gameDayId,
    pitchId: pitchA.value.pitchId,
    secondPitchId: pitchB.value.pitchId,
    setNow(value: number) {
      nowMs = value;
    },
  };
}

function bytes(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
