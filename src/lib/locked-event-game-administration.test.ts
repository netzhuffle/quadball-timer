import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFoundationAcceptance } from "@/lib/foundation-acceptance";
import { createAudienceProjection } from "@/lib/audience-projection";
import { createEventAdministration } from "@/lib/event-administration";
import { createEventCatalog, createFoundationEventCatalogStorage } from "@/lib/event-catalog";
import { createEventGameRecord } from "@/lib/event-game-record";
import {
  canonicalizeEventGameRecordRoot,
  validateEventGameRecordRoot,
  type EventGameRecordRoot,
} from "@/lib/foundation-record-types";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import type { FoundationStorage } from "@/lib/foundation-storage";
import { openSqliteFoundationStorage } from "@/lib/foundation-storage-sqlite";
import { readAudienceProjectionGameInput } from "@/lib/live-event-game-runtime";
import { createGrantAuthorityVerifier } from "@/lib/grant-authority";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import { createTypedGrantAuthority } from "@/lib/grant-management";
import {
  createLiveEventGameIqaInterpreter,
  createLiveEventGameControl,
  EVENT_GAME_LOCK_DELAY_MS,
  projectLiveEventGameDerivedState,
  validateLiveEventGameActionInTransaction,
} from "@/lib/live-event-game-control";
import type { GrantKeyRing } from "@/lib/grant-types";
import {
  MemoryTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
  isTechnicalAdminAuthority,
} from "@/lib/technical-admin-auth";

const keyRing: GrantKeyRing = {
  encryption: { currentVersion: "v1", keys: new Map([["v1", bytes(32)]]) },
  lookup: { currentVersion: "v1", keys: new Map([["v1", bytes(32)]]) },
  audit: { currentVersion: "v1", keys: new Map([["v1", bytes(32)]]) },
};

describe("locked Event Game administration", () => {
  test("preserves locked correction value-change links in memory and SQLite after reopen", async () => {
    const memoryFixture = await createFixture();
    const memoryResult = await memoryFixture.administration.correctLockedEventGame(
      memoryFixture.eventId,
      memoryFixture.eventGameId,
      {
        operationId: "locked-correction-audit-parity",
        endState: { scoreByGameSide: { "side-a": 30, "side-b": 20 } },
      },
      memoryFixture.technical,
    );
    expect(memoryResult).toMatchObject({ status: "accepted" });
    const memoryAudit = await memoryFixture.storage.transaction((transaction) =>
      transaction.listAuditEntries(memoryFixture.recordId),
    );

    const directory = await mkdtemp(join(tmpdir(), "quadball-locked-audit-parity-"));
    const databasePath = join(directory, "foundation.sqlite");
    const sqliteStorage = openSqliteFoundationStorage(databasePath, {
      grantKeyRing: keyRing,
      grantValidationContext: { environmentId: "test", keyRing },
    });
    try {
      await sqliteStorage.applyMigrations({ requireCandidate: false });
      const sqliteFixture = await createFixture(sqliteStorage);
      const sqliteResult = await sqliteFixture.administration.correctLockedEventGame(
        sqliteFixture.eventId,
        sqliteFixture.eventGameId,
        {
          operationId: "locked-correction-audit-parity",
          endState: { scoreByGameSide: { "side-a": 30, "side-b": 20 } },
        },
        sqliteFixture.technical,
      );
      expect(sqliteResult).toMatchObject({ status: "accepted" });
      const sqliteAudit = await sqliteStorage.transaction((transaction) =>
        transaction.listAuditEntries(sqliteFixture.recordId),
      );
      const memoryLinks = memoryAudit.find(
        (audit) => audit.operationId === "locked-correction-audit-parity",
      )?.links;
      const sqliteLinks = sqliteAudit.find(
        (audit) => audit.operationId === "locked-correction-audit-parity",
      )?.links;
      expect(sqliteLinks).toMatchObject({
        actionId: memoryLinks?.actionId,
        valueChange: memoryLinks?.valueChange,
      });

      sqliteStorage.close();
      const reopened = openSqliteFoundationStorage(databasePath, {
        requireReplayContext: false,
        grantKeyRing: keyRing,
      });
      try {
        const reopenedAudit = await reopened.readAuditEntries(sqliteFixture.recordId);
        expect(
          reopenedAudit.find((audit) => audit.operationId === "locked-correction-audit-parity")
            ?.links,
        ).toMatchObject({
          actionId: memoryLinks?.actionId,
          valueChange: memoryLinks?.valueChange,
        });
      } finally {
        reopened.close();
      }
    } finally {
      try {
        sqliteStorage.close();
      } catch {
        // The SQLite storage is already closed after the reopen transition.
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("previews bounded correction and reopening impact before requiring confirmation", async () => {
    const fixture = await createFixture();
    const correctionInput = {
      operationId: "preview-correction",
      endState: { scoreByGameSide: { "side-a": 30, "side-b": 20 } },
    };
    const correctionPreview = await fixture.administration.previewLockedEventGameCorrection(
      fixture.eventId,
      fixture.eventGameId,
      correctionInput,
      fixture.technical,
    );
    expect(correctionPreview).toMatchObject({
      status: "accepted",
      value: {
        operation: "locked-game-correction",
        eventGameId: fixture.eventGameId,
        impact: {
          facts: "corrected",
          lifecycle: { lock: "retained" },
          authority: { controlGrant: "preserved" },
          queuedDiscard: { category: "locked-replay", count: 0 },
        },
      },
    });
    if (correctionPreview.status !== "accepted") throw new Error("Expected correction preview.");
    expect(JSON.stringify(correctionPreview.value)).not.toContain(fixture.oldQrCredential);
    expect(JSON.stringify(correctionPreview.value)).not.toContain(fixture.oldGrantCode);
    expect(
      await fixture.rawAdministration.correctLockedEventGame(
        fixture.eventId,
        fixture.eventGameId,
        correctionInput,
        fixture.technical,
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });
    const acceptedCorrection = await fixture.rawAdministration.correctLockedEventGame(
      fixture.eventId,
      fixture.eventGameId,
      { ...correctionInput, previewFingerprint: correctionPreview.value.fingerprint },
      fixture.technical,
    );
    expect(acceptedCorrection).toMatchObject({ status: "accepted" });

    const reopenPreview = await fixture.administration.previewEventGameReopening(
      fixture.eventId,
      fixture.eventGameId,
      { operationId: "preview-reopen" },
      fixture.technical,
    );
    expect(reopenPreview).toMatchObject({
      status: "accepted",
      value: {
        operation: "game-reopening",
        impact: {
          facts: "preserved",
          lifecycle: { lock: "removed" },
          timer: "restarted",
          authority: { controlGrant: "preserved" },
        },
      },
    });
  });

  test("applies an authorized locked correction atomically and retains Game Lock", async () => {
    const fixture = await createFixture();
    const result = await fixture.administration.correctLockedEventGame(
      fixture.eventId,
      fixture.eventGameId,
      {
        operationId: "locked-correction-1",
        endState: {
          scoreByGameSide: { "side-a": 30, "side-b": 20 },
          winnerGameSideId: "side-a",
          flagCatchingGameSideId: "side-a",
          catchTimeMs: 1_500,
          endTimeMs: 2_000,
        },
      },
      fixture.technical,
    );

    expect(result).toMatchObject({
      status: "accepted",
      value: {
        eventGameId: fixture.eventGameId,
        lockRetained: true,
        overrideApplied: false,
        after: {
          scoreByGameSide: { "side-a": 30, "side-b": 20 },
          winnerGameSideId: "side-a",
        },
      },
    });

    const state = await fixture.storage.transaction((transaction) => ({
      root: transaction.findRootByEventGameId(fixture.eventGameId),
      actions: transaction.listActions(fixture.recordId),
      controlAudit: transaction.listAuditEntries(fixture.recordId),
      eventAudit: transaction.listEventAuditTrail(fixture.eventId),
    }));
    expect(state.root?.lifecycle).toMatchObject({
      phase: "finished",
      lockedAtMs: 3_000,
      lockReason: "finished-inactivity",
    });
    expect(state.actions).toHaveLength(1);
    expect(state.actions[0]?.action.origin).toBe("event-admin");
    expect(state.controlAudit).toHaveLength(1);
    expect(state.eventAudit).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "locked-game-corrected" })]),
    );
    const duplicate = await fixture.administration.correctLockedEventGame(
      fixture.eventId,
      fixture.eventGameId,
      {
        operationId: "locked-correction-1",
        endState: { scoreByGameSide: { "side-a": 31 } },
      },
      fixture.technical,
    );
    expect(duplicate).toMatchObject({ status: "rejected", reason: "invalid-input" });
    const projection = projectLiveEventGameDerivedState(
      state.root!,
      state.actions.map((stored) => ({
        action: stored.action,
        canonicalContent: stored.canonicalContent,
        contentFingerprint: stored.contentFingerprint,
      })),
    );
    expect(projection).toMatchObject({
      scoreByGameSide: { "side-a": 30, "side-b": 20 },
      winnerGameSideId: "side-a",
      catch: { catchingGameSideId: "side-a", gameTimeMs: 1_500 },
      result: { data: { endTimeMs: 2_000 } },
    });
    if (projection === null) throw new Error("Expected a public Event Game projection.");
    expect(projection.gameFacts).toEqual(
      expect.arrayContaining([expect.objectContaining({ factType: "result" })]),
    );
    expect(projection.gameFacts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ factType: "locked-game-correction" })]),
    );
    expect(JSON.stringify(projection)).not.toContain("locked-game-correction");
  });

  test("projects accepted locked correction and reopening through the public Audience seam", async () => {
    const fixture = await createFixture();
    const catalogStorage = createFoundationEventCatalogStorage(fixture.storage);
    const catalog = createEventCatalog(catalogStorage, { clock: { nowMs: () => 3_000 } });
    expect(
      await catalog.changePublicationStatus(
        fixture.eventId,
        { status: "published" },
        fixture.technical,
      ),
    ).toMatchObject({ status: "accepted" });
    const control = fixture.createControl();
    const audience = createAudienceProjection(catalogStorage, {
      now: () => 3_000,
      gameInput: {
        read: async (eventGameId) => {
          const root = await fixture.storage.readRoot(fixture.recordId);
          return readAudienceProjectionGameInput(
            root,
            await control.readControllerProjection(eventGameId),
          );
        },
      },
    });
    const correctionOperationId = "audience-seam-locked-correction";
    const correction = await fixture.administration.correctLockedEventGame(
      fixture.eventId,
      fixture.eventGameId,
      {
        operationId: correctionOperationId,
        endState: {
          scoreByGameSide: { "side-a": 30, "side-b": 20 },
          winnerGameSideId: "side-a",
          flagCatchingGameSideId: "side-a",
          catchTimeMs: 1_500,
          endTimeMs: 2_000,
        },
      },
      fixture.technical,
    );
    expect(correction).toMatchObject({ status: "accepted", value: { lockRetained: true } });

    const locked = await audience.readGame(fixture.eventId, fixture.eventGameId);
    expect(locked).toMatchObject({
      status: "accepted",
      value: {
        sideA: { score: 30 },
        sideB: { score: 20 },
        flagState: { catchingSide: "side-a" },
        result: { status: "finished", winner: "side-a", locked: true },
      },
    });
    if (locked.status !== "accepted") throw new Error("Expected locked public projection.");
    expect(locked.value.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "flag-catch", gameTimeMs: 1_500 }),
        expect.objectContaining({ kind: "finish", outcome: "result" }),
      ]),
    );
    const lockedTimeline = locked.value.timeline;
    const lockedPublicJson = JSON.stringify(locked.value);
    expect(lockedPublicJson).not.toContain(correctionOperationId);
    expect(lockedPublicJson).not.toContain("locked-game-correction");
    expect(lockedPublicJson).not.toContain("event-admin");

    const reopenOperationId = "audience-seam-game-reopening";
    expect(
      await fixture.administration.reopenEventGame(
        fixture.eventId,
        fixture.eventGameId,
        { operationId: reopenOperationId },
        fixture.technical,
      ),
    ).toMatchObject({ status: "accepted", value: { lockRemoved: true } });

    const reopened = await audience.readGame(fixture.eventId, fixture.eventGameId);
    expect(reopened).toMatchObject({
      status: "accepted",
      value: { result: { status: "finished", winner: "side-a", locked: false } },
    });
    if (reopened.status !== "accepted") throw new Error("Expected reopened public projection.");
    expect(reopened.value.sideA.score).toBe(30);
    expect(reopened.value.sideB.score).toBe(20);
    expect(reopened.value.flagState).toEqual({ catchingSide: "side-a" });
    expect(reopened.value.timeline).toEqual(lockedTimeline);
    const reopenedPublicJson = JSON.stringify(reopened.value);
    expect(reopenedPublicJson).not.toContain(correctionOperationId);
    expect(reopenedPublicJson).not.toContain(reopenOperationId);
    expect(reopenedPublicJson).not.toContain("game-reopening");
    expect(reopenedPublicJson).not.toContain("event-admin");
  });

  test("requires one confirmation for an inconsistent correction and records Official Override", async () => {
    const fixture = await createFixture();
    const input = {
      operationId: "locked-correction-inconsistent",
      endState: { scoreByGameSide: { "side-a": 25, "side-b": 20 } },
    };
    expect(
      await fixture.administration.correctLockedEventGame(
        fixture.eventId,
        fixture.eventGameId,
        input,
        fixture.technical,
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });
    const result = await fixture.administration.correctLockedEventGame(
      fixture.eventId,
      fixture.eventGameId,
      { ...input, overrideConfirmed: true },
      fixture.technical,
    );
    expect(result).toMatchObject({ status: "accepted", value: { overrideApplied: true } });
    const action = await fixture.storage.transaction((transaction) =>
      transaction.listActions(fixture.recordId),
    );
    expect(action[0]?.action.override).toMatchObject({
      guardrail: "locked-game-end-state-consistency",
      confirmation: "event-admin-confirmed",
    });
  });

  test("uses canonical result relationships for the single override confirmation", async () => {
    const fixture = await createFixture();
    const input = {
      operationId: "locked-correction-result-relationship",
      endState: {
        scoreByGameSide: { "side-a": 30, "side-b": 20 },
        winnerGameSideId: "side-b",
        flagCatchingGameSideId: "side-a",
        catchTimeMs: 2_500,
        endTimeMs: 2_000,
      },
    };
    expect(
      await fixture.administration.correctLockedEventGame(
        fixture.eventId,
        fixture.eventGameId,
        input,
        fixture.technical,
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });
    expect(
      await fixture.administration.correctLockedEventGame(
        fixture.eventId,
        fixture.eventGameId,
        { ...input, overrideConfirmed: true },
        fixture.technical,
      ),
    ).toMatchObject({ status: "accepted", value: { overrideApplied: true } });
  });

  test("rejects a stale concurrent correction without overwriting the accepted one", async () => {
    const fixture = await createFixture();
    const results = await Promise.all([
      fixture.administration.correctLockedEventGame(
        fixture.eventId,
        fixture.eventGameId,
        { operationId: "concurrent-correction-a", endState: { scoreByGameSide: { "side-a": 30 } } },
        fixture.technical,
      ),
      fixture.administration.correctLockedEventGame(
        fixture.eventId,
        fixture.eventGameId,
        { operationId: "concurrent-correction-b", endState: { scoreByGameSide: { "side-a": 40 } } },
        fixture.technical,
      ),
    ]);
    expect(results.filter((result) => result.status === "accepted")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const actions = await fixture.storage.transaction((transaction) =>
      transaction.listActions(fixture.recordId),
    );
    expect(actions).toHaveLength(1);
  });

  test("rejects an acceptance submitted with a stale preview fingerprint", async () => {
    const fixture = await createFixture();
    const preview = await fixture.rawAdministration.previewLockedEventGameCorrection(
      fixture.eventId,
      fixture.eventGameId,
      { operationId: "stale-preview", endState: { scoreByGameSide: { "side-a": 30 } } },
      fixture.technical,
    );
    if (preview.status !== "accepted") throw new Error("Expected stale preview.");
    expect(
      await fixture.administration.correctLockedEventGame(
        fixture.eventId,
        fixture.eventGameId,
        { operationId: "fresh-correction", endState: { scoreByGameSide: { "side-a": 40 } } },
        fixture.technical,
      ),
    ).toMatchObject({ status: "accepted" });
    expect(
      await fixture.rawAdministration.correctLockedEventGame(
        fixture.eventId,
        fixture.eventGameId,
        {
          operationId: "stale-preview",
          endState: { scoreByGameSide: { "side-a": 30 } },
          previewFingerprint: preview.value.fingerprint,
        },
        fixture.technical,
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-input" });
  });

  test("reopens a locked game without changing facts", async () => {
    const fixture = await createFixture();
    const correction = await fixture.administration.correctLockedEventGame(
      fixture.eventId,
      fixture.eventGameId,
      {
        operationId: "locked-correction-before-reopen",
        endState: { scoreByGameSide: { "side-a": 30, "side-b": 20 } },
      },
      fixture.technical,
    );
    expect(correction.status).toBe("accepted");
    const result = await fixture.administration.reopenEventGame(
      fixture.eventId,
      fixture.eventGameId,
      { operationId: "reopen-1" },
      fixture.technical,
    );
    expect(result).toMatchObject({
      status: "accepted",
      value: {
        eventGameId: fixture.eventGameId,
        lockRemoved: true,
        lifecycle: { lockedAtMs: null },
      },
    });
    const state = await fixture.storage.transaction((transaction) => ({
      root: transaction.findRootByEventGameId(fixture.eventGameId),
      actions: transaction.listActions(fixture.recordId),
      audit: transaction.listEventAuditTrail(fixture.eventId),
    }));
    expect(state.root?.lifecycle).toMatchObject({
      phase: "finished",
      lockedAtMs: null,
      lockReason: null,
    });
    expect(state.actions).toHaveLength(2);
    expect(state.audit).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "game-reopened" })]),
    );
  });

  test("reopening is idempotent for sequential and concurrent identical retries", async () => {
    const fixture = await createFixture();
    const preview = await fixture.rawAdministration.previewEventGameReopening(
      fixture.eventId,
      fixture.eventGameId,
      { operationId: "reopen-idempotent" },
      fixture.technical,
    );
    if (preview.status !== "accepted") throw new Error("Expected reopening preview.");
    const input = {
      operationId: "reopen-idempotent",
      previewFingerprint: preview.value.fingerprint,
    };
    const first = await fixture.rawAdministration.reopenEventGame(
      fixture.eventId,
      fixture.eventGameId,
      input,
      fixture.technical,
    );
    const firstState = await fixture.storage.transaction((transaction) => ({
      root: transaction.findRootByEventGameId(fixture.eventGameId),
      action: transaction.findActionByOperationId(fixture.recordId, "reopen-idempotent"),
    }));
    expect(firstState.root?.lifecycle.lockedAtMs).toBe(null);
    expect(firstState.action?.action.interpretation).toMatchObject({
      type: "fact",
      factType: "game-reopening",
    });
    const retry = await fixture.rawAdministration.reopenEventGame(
      fixture.eventId,
      fixture.eventGameId,
      input,
      fixture.technical,
    );
    expect(first).toMatchObject({ status: "accepted" });
    expect(retry).toEqual(first);

    const concurrentFixture = await createFixture();
    const concurrentPreview = await concurrentFixture.rawAdministration.previewEventGameReopening(
      concurrentFixture.eventId,
      concurrentFixture.eventGameId,
      { operationId: "reopen-concurrent-idempotent" },
      concurrentFixture.technical,
    );
    if (concurrentPreview.status !== "accepted") throw new Error("Expected concurrent preview.");
    const concurrentInput = {
      operationId: "reopen-concurrent-idempotent",
      previewFingerprint: concurrentPreview.value.fingerprint,
    };
    const concurrent = await Promise.all([
      concurrentFixture.rawAdministration.reopenEventGame(
        concurrentFixture.eventId,
        concurrentFixture.eventGameId,
        concurrentInput,
        concurrentFixture.technical,
      ),
      concurrentFixture.rawAdministration.reopenEventGame(
        concurrentFixture.eventId,
        concurrentFixture.eventGameId,
        concurrentInput,
        concurrentFixture.technical,
      ),
    ]);
    expect(concurrent[0]).toEqual(concurrent[1]);
    const state = await concurrentFixture.storage.transaction((transaction) => ({
      actions: transaction.listActions(concurrentFixture.recordId),
      audits: transaction.listEventAuditTrail(concurrentFixture.eventId),
    }));
    expect(state.actions).toHaveLength(1);
    expect(state.audits.filter((audit) => audit.action === "game-reopened")).toHaveLength(1);
  });

  test("stops the closing timer when reopening a corrected unfinished state", async () => {
    const fixture = await createFixture();
    const correction = await fixture.administration.correctLockedEventGame(
      fixture.eventId,
      fixture.eventGameId,
      {
        operationId: "locked-correction-unfinished",
        endState: {
          winnerGameSideId: null,
          flagCatchingGameSideId: null,
          catchTimeMs: null,
          endTimeMs: null,
        },
      },
      fixture.technical,
    );
    expect(correction).toMatchObject({ status: "accepted", value: { lockRetained: true } });
    const reopened = await fixture.administration.reopenEventGame(
      fixture.eventId,
      fixture.eventGameId,
      { operationId: "reopen-unfinished" },
      fixture.technical,
    );
    expect(reopened).toMatchObject({
      status: "accepted",
      value: { lifecycle: { phase: "in-progress", finishedAtMs: null, lockedAtMs: null } },
    });
  });

  test("reopens from the fresh deadline and restarts ordinary finish timing", async () => {
    const fixture = await createFixture();
    const firstReopenAt = 3_000;
    fixture.setNow(firstReopenAt);
    fixture.setGrantEligible(true);
    expect(
      await fixture.administration.reopenEventGame(
        fixture.eventId,
        fixture.eventGameId,
        { operationId: "reopen-fresh-deadline" },
        fixture.technical,
      ),
    ).toMatchObject({ status: "accepted", value: { lifecycle: { lockedAtMs: null } } });
    const firstReopenMetadata = await fixture.storage.readRecordMetadata(fixture.recordId);
    expect(firstReopenMetadata?.lastAcceptedAtMs).toBe(firstReopenAt);
    const firstQr = await fixture.grants.revealGrant(fixture.controlGrantId, {
      kind: "technical-admin",
      id: "fixture-technical",
    });
    const firstSession = await fixture.grants.admitGrant({
      qrCredential: firstQr.status === "revealed" ? firstQr.qrCredential : "invalid",
      browserContext: "fresh-deadline-controller",
    });
    if (firstSession.status !== "admitted") throw new Error("Expected fresh Controller admission.");
    const control = fixture.createControl();

    fixture.setNow(firstReopenAt + EVENT_GAME_LOCK_DELAY_MS - 1);
    expect(
      await control.refreshController({
        sessionBearer: firstSession.sessionBearer,
        eventGameId: fixture.eventGameId,
      }),
    ).toMatchObject({ status: "authorized" });
    expect((await fixture.storage.readRoot(fixture.recordId))?.lifecycle.lockedAtMs).toBe(null);

    fixture.setNow(firstReopenAt + EVENT_GAME_LOCK_DELAY_MS);
    expect(
      await control.refreshController({
        sessionBearer: firstSession.sessionBearer,
        eventGameId: fixture.eventGameId,
      }),
    ).toMatchObject({ status: "rejected" });
    expect((await fixture.storage.readRoot(fixture.recordId))?.lifecycle).toMatchObject({
      phase: "finished",
      lockedAtMs: firstReopenAt + EVENT_GAME_LOCK_DELAY_MS,
    });

    const correction = await fixture.administration.correctLockedEventGame(
      fixture.eventId,
      fixture.eventGameId,
      {
        operationId: "correct-to-unfinished-for-deadline",
        endState: {
          winnerGameSideId: null,
          flagCatchingGameSideId: null,
          catchTimeMs: null,
          endTimeMs: null,
        },
      },
      fixture.technical,
    );
    expect(correction).toMatchObject({ status: "accepted", value: { lockRetained: true } });
    const unfinishedReopenAt = firstReopenAt + EVENT_GAME_LOCK_DELAY_MS + 1_000;
    fixture.setNow(unfinishedReopenAt);
    expect(
      await fixture.administration.reopenEventGame(
        fixture.eventId,
        fixture.eventGameId,
        { operationId: "reopen-unfinished-deadline" },
        fixture.technical,
      ),
    ).toMatchObject({
      status: "accepted",
      value: { lifecycle: { phase: "in-progress", finishedAtMs: null, lockedAtMs: null } },
    });
    fixture.setNow(unfinishedReopenAt + EVENT_GAME_LOCK_DELAY_MS + 1);
    const unfinishedSession = await fixture.grants.admitGrant({
      qrCredential: fixture.oldQrCredential,
      browserContext: "unfinished-controller",
    });
    if (unfinishedSession.status !== "admitted")
      throw new Error("Expected unfinished Controller admission.");
    expect(
      await control.refreshController({
        sessionBearer: unfinishedSession.sessionBearer,
        eventGameId: fixture.eventGameId,
      }),
    ).toMatchObject({ status: "authorized" });
    expect((await fixture.storage.readRoot(fixture.recordId))?.lifecycle).toMatchObject({
      phase: "in-progress",
      finishedAtMs: null,
      lockedAtMs: null,
    });

    const ordinaryFinishAt = unfinishedReopenAt + EVENT_GAME_LOCK_DELAY_MS + 2_000;
    fixture.setNow(ordinaryFinishAt);
    expect(
      await control.submitControllerIntent({
        sessionBearer: unfinishedSession.sessionBearer,
        eventGameId: fixture.eventGameId,
        intent: {
          version: "live-event-control-intent-v1",
          type: "record-forfeit",
          operationId: "ordinary-refinish-after-reopen",
          factId: "ordinary-refinish-after-reopen-fact",
          gameSideId: "side-a",
          gameTimeMs: 0,
          occurrence: { clientOriginAtMs: 0 },
        },
      }),
    ).toMatchObject({ status: "accepted" });
    const finishMetadata = await fixture.storage.readRecordMetadata(fixture.recordId);
    expect(finishMetadata?.lastAcceptedAtMs).toBe(ordinaryFinishAt);
    fixture.setNow(ordinaryFinishAt + EVENT_GAME_LOCK_DELAY_MS - 1);
    expect((await fixture.storage.readRoot(fixture.recordId))?.lifecycle.lockedAtMs).toBe(null);
    fixture.setNow(ordinaryFinishAt + EVENT_GAME_LOCK_DELAY_MS);
    expect(
      await control.refreshController({
        sessionBearer: unfinishedSession.sessionBearer,
        eventGameId: fixture.eventGameId,
      }),
    ).toMatchObject({ status: "rejected" });
    expect((await fixture.storage.readRoot(fixture.recordId))?.lifecycle.lockedAtMs).toBe(
      ordinaryFinishAt + EVENT_GAME_LOCK_DELAY_MS,
    );
  });

  test("keeps locked queued work as bounded discard evidence after fresh reopen replay", async () => {
    const fixture = await createFixture();
    fixture.setGrantEligible(true);
    fixture.setNow(3_000);
    expect(
      await fixture.administration.correctLockedEventGame(
        fixture.eventId,
        fixture.eventGameId,
        {
          operationId: "correction-before-queued-discard",
          endState: {
            scoreByGameSide: { "side-a": 30, "side-b": 20 },
            winnerGameSideId: "side-a",
            endTimeMs: 2_000,
          },
        },
        fixture.technical,
      ),
    ).toMatchObject({ status: "accepted" });
    expect(
      await fixture.administration.reopenEventGame(
        fixture.eventId,
        fixture.eventGameId,
        { operationId: "reopen-before-queued-discard" },
        fixture.technical,
      ),
    ).toMatchObject({ status: "accepted" });
    const queuedQr = await fixture.grants.revealGrant(fixture.controlGrantId, {
      kind: "technical-admin",
      id: "fixture-technical",
    });
    const admitted = await fixture.grants.admitGrant({
      qrCredential: queuedQr.status === "revealed" ? queuedQr.qrCredential : "invalid",
      browserContext: "queued-discard-controller",
    });
    if (admitted.status !== "admitted") throw new Error("Expected queued-work admission.");
    const control = fixture.createControl();
    const replayInput = {
      sessionBearer: admitted.sessionBearer,
      eventGameId: fixture.eventGameId,
      batchId: "queued-discard-batch",
      replicaGeneration: "queued-discard-generation",
      expectedGrantSessionId: admitted.grantSessionId,
      expectedGrantVersion: admitted.grantVersion,
      actions: [
        {
          eventGameId: fixture.eventGameId,
          intent: {
            version: "live-event-control-intent-v1" as const,
            type: "record-goal" as const,
            operationId: "queued-discard-goal",
            factId: "queued-discard-goal-fact",
            gameSideId: "side-a",
            gameTimeMs: 0,
            occurrence: { clientOriginAtMs: 0 },
          },
          causalPredecessorIds: [],
        },
      ],
    };
    fixture.setNow(3_000 + EVENT_GAME_LOCK_DELAY_MS - 1);
    expect(await control.replayControllerActions(replayInput)).toMatchObject({
      status: "synchronized",
      outcomes: [{ operationId: "queued-discard-goal", status: "held-for-correction" }],
    });
    const rejectedAtMs = 3_000 + EVENT_GAME_LOCK_DELAY_MS;
    fixture.setNow(rejectedAtMs);
    expect(await control.replayControllerActions(replayInput)).toMatchObject({
      status: "synchronized",
      discardedCount: 1,
      outcomes: [{ operationId: "queued-discard-goal", status: "locked-discarded" }],
    });
    expect(await fixture.storage.readActions(fixture.recordId)).toHaveLength(2);
    const discardEvidence = await fixture.storage.transaction((transaction) =>
      transaction.listAuditEntries(fixture.recordId),
    );
    expect(discardEvidence.filter((audit) => audit.lockedReplay !== undefined)).toEqual([
      expect.objectContaining({
        lockedReplay: {
          count: 1,
          eventGameId: fixture.eventGameId,
          originatingSessionId: admitted.grantSessionId,
          rejectedAtMs,
        },
      }),
    ]);

    fixture.setNow(rejectedAtMs + 1_000);
    expect(
      await fixture.administration.reopenEventGame(
        fixture.eventId,
        fixture.eventGameId,
        { operationId: "reopen-after-queued-discard" },
        fixture.technical,
      ),
    ).toMatchObject({ status: "accepted" });
    const fresh = await fixture.grants.admitGrant({
      qrCredential: fixture.oldQrCredential,
      browserContext: "queued-discard-fresh-controller",
    });
    if (fresh.status !== "admitted") throw new Error("Expected fresh replay admission.");
    fixture.setNow(rejectedAtMs + 2_000);
    const freshReplay = await control.replayControllerActions({
      ...replayInput,
      sessionBearer: fresh.sessionBearer,
      expectedGrantSessionId: fresh.grantSessionId,
    });
    expect(freshReplay).toMatchObject({ status: "synchronized" });
    expect(await fixture.storage.readActions(fixture.recordId)).toHaveLength(3);
    expect(
      (await fixture.storage.readActions(fixture.recordId)).some(
        (stored) => stored.action.operationId === "queued-discard-goal",
      ),
    ).toBe(false);
    expect(
      (
        await fixture.storage.transaction((transaction) =>
          transaction.listAuditEntries(fixture.recordId),
        )
      ).filter((audit) => audit.lockedReplay !== undefined),
    ).toHaveLength(1);
  });

  test("preserves the existing QR while old sessions and code stay invalid after reopening", async () => {
    const fixture = await createFixture();
    const result = await fixture.administration.reopenEventGame(
      fixture.eventId,
      fixture.eventGameId,
      { operationId: "reopen-rotate-authority" },
      fixture.technical,
    );
    expect(result).toMatchObject({ status: "accepted", value: { lockRemoved: true } });
    if (result.status !== "accepted") throw new Error("Expected reopening acceptance.");
    const preservedQr = await fixture.grants.revealGrant(fixture.controlGrantId, {
      kind: "technical-admin",
      id: "fixture-technical",
    });
    expect(preservedQr).toMatchObject({
      status: "revealed",
      qrCredential: fixture.oldQrCredential,
    });

    expect(
      await fixture.grants.admitGrant({
        qrCredential: preservedQr.status === "revealed" ? preservedQr.qrCredential : "invalid",
        browserContext: "fresh-qr-after-reopen",
      }),
    ).toMatchObject({ status: "admitted", eventGameId: fixture.eventGameId });
    expect(
      await fixture.grants.admitGrantCode({
        grantCode: fixture.oldGrantCode,
        browserContext: "old-code-after-reopen",
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      await fixture.grants.authorizeGrant({
        sessionBearer: fixture.oldSessionBearer,
        eventGameId: fixture.eventGameId,
      }),
    ).toMatchObject({ status: "rejected" });

    fixture.setGrantEligible(true);
    const freshCode = await fixture.grants.createGrantCode(fixture.controlGrantId, {
      kind: "technical-admin",
      id: "fixture-technical",
    });
    expect(freshCode).toMatchObject({ status: "created" });
    expect(result.value.controlGrantVersion).toBe(fixture.oldGrantVersion);
  });

  test("denies a Control session generically without refreshing its authority", async () => {
    const fixture = await createFixture();
    const before = await fixture.storage.transaction((transaction) => ({
      sessions: transaction.listGrantSessions(fixture.controlGrantId),
      audits: transaction.listGrantAudit(fixture.controlGrantId),
    }));
    const denied = await fixture.administration.reopenEventGame(
      fixture.eventId,
      fixture.eventGameId,
      { operationId: "reopen-control-denied" },
      { kind: "grant-session", sessionBearer: fixture.oldSessionBearer },
    );
    expect(denied).toMatchObject({ status: "rejected", reason: "unauthorized" });
    const after = await fixture.storage.transaction((transaction) => ({
      sessions: transaction.listGrantSessions(fixture.controlGrantId),
      audits: transaction.listGrantAudit(fixture.controlGrantId),
    }));
    expect(after).toEqual(before);
  });

  test("allows a delegated Event Admin to reopen through its scoped session", async () => {
    const fixture = await createFixture();
    const adminGrant = await fixture.grants.createEventAdminGrant({
      scope: {
        eventId: fixture.eventId,
        eventTimeZone: "UTC",
        finalGameDayDate: "2026-08-15",
      },
      authority: { kind: "technical-admin", id: "fixture-technical" },
    });
    expect(adminGrant.status).toBe("created");
    if (adminGrant.status !== "created") throw new Error("Expected Event Admin Grant.");
    const adminSession = await fixture.grants.admitGrant({
      qrCredential: adminGrant.qrCredential,
      browserContext: "event-admin-browser",
    });
    expect(adminSession.status).toBe("admitted");
    if (adminSession.status !== "admitted") throw new Error("Expected Event Admin Session.");
    expect(
      await fixture.administration.reopenEventGame(
        fixture.eventId,
        fixture.eventGameId,
        { operationId: "reopen-event-admin" },
        { kind: "grant-session", sessionBearer: adminSession.sessionBearer },
      ),
    ).toMatchObject({ status: "accepted", value: { lockRemoved: true } });
    const linked = await fixture.storage.transaction((transaction) => ({
      control: transaction
        .listAuditEntries(fixture.recordId)
        .filter((audit) => audit.outcome === "accepted"),
      grant: transaction
        .listGrantAudit(adminGrant.grantId)
        .filter((audit) => audit.action === "control-action-accepted"),
    }));
    expect(linked.grant).toHaveLength(1);
    expect(linked.control).toHaveLength(1);
    expect(linked.control[0]?.links?.grantAuditId).toBe(linked.grant[0]?.auditId);
    expect(linked.grant[0]?.controlAuditId).toBe(linked.control[0]?.auditId);
  });

  test("links delegated Event Admin correction authority use to its Control audit", async () => {
    const fixture = await createFixture();
    const adminGrant = await fixture.grants.createEventAdminGrant({
      scope: {
        eventId: fixture.eventId,
        eventTimeZone: "UTC",
        finalGameDayDate: "2026-08-15",
      },
      authority: { kind: "technical-admin", id: "fixture-technical" },
    });
    if (adminGrant.status !== "created") throw new Error("Expected Event Admin Grant.");
    const adminSession = await fixture.grants.admitGrant({
      qrCredential: adminGrant.qrCredential,
      browserContext: "event-admin-correction-browser",
    });
    if (adminSession.status !== "admitted") throw new Error("Expected Event Admin Session.");
    expect(
      await fixture.administration.correctLockedEventGame(
        fixture.eventId,
        fixture.eventGameId,
        { operationId: "correct-event-admin", endState: { scoreByGameSide: { "side-a": 30 } } },
        { kind: "grant-session", sessionBearer: adminSession.sessionBearer },
      ),
    ).toMatchObject({ status: "accepted" });
    const linked = await fixture.storage.transaction((transaction) => ({
      control: transaction
        .listAuditEntries(fixture.recordId)
        .filter((audit) => audit.outcome === "accepted"),
      grant: transaction
        .listGrantAudit(adminGrant.grantId)
        .filter((audit) => audit.action === "control-action-accepted"),
    }));
    expect(linked.grant).toHaveLength(1);
    expect(linked.control).toHaveLength(1);
    expect(linked.control[0]?.links?.grantAuditId).toBe(linked.grant[0]?.auditId);
    expect(linked.grant[0]?.controlAuditId).toBe(linked.control[0]?.auditId);
  });

  test("rolls back the root, action, linked audits, and Grant state on injected failure", async () => {
    const fixture = await createFixture();
    const failingAdministration = createEventAdministration({
      storage: fixture.storage,
      grants: {
        ...fixture.grants,
      },
      nowMs: () => 3_000,
      lockedGameFailureInjector: () => {
        throw new Error("injected-grant-audit-failure");
      },
    });
    const preview = await failingAdministration.previewEventGameReopening(
      fixture.eventId,
      fixture.eventGameId,
      { operationId: "reopen-injected-failure" },
      fixture.technical,
    );
    if (preview.status !== "accepted") throw new Error("Expected reopening preview.");
    const result = await failingAdministration.reopenEventGame(
      fixture.eventId,
      fixture.eventGameId,
      {
        operationId: "reopen-injected-failure",
        previewFingerprint: preview.value.fingerprint,
      },
      fixture.technical,
    );
    expect(result).toMatchObject({ status: "retryable-failure" });
    const state = await fixture.storage.transaction((transaction) => ({
      root: transaction.findRootByEventGameId(fixture.eventGameId),
      actions: transaction.listActions(fixture.recordId),
      controlAudits: transaction.listAuditEntries(fixture.recordId),
      eventAudits: transaction.listEventAuditTrail(fixture.eventId),
      grant: transaction.findGrantById(fixture.controlGrantId),
      grantAudits: transaction.listGrantAudit(fixture.controlGrantId),
    }));
    expect(state.root?.lifecycle).toMatchObject({ lockedAtMs: 3_000 });
    expect(state.actions).toHaveLength(0);
    expect(state.controlAudits).toHaveLength(0);
    expect(
      state.eventAudits.filter((audit) => audit.operationId === "reopen-injected-failure"),
    ).toHaveLength(0);
    expect(state.grant?.grantVersion).toBe(fixture.oldGrantVersion);
    expect(state.grantAudits).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "control-action-accepted" })]),
    );
  });
});

async function createFixture(storage: FoundationStorage = createInMemoryFoundationStorage()) {
  let nowMs = 3_000;
  let grantRandomCounter = 0;
  const technical = createTechnicalAdminAuth(
    { environment: "test", origin: "https://timer.example", rpId: "timer.example" },
    new MemoryTechnicalAdminAuthRepository(),
  ).resolveHostLocalAuthority();
  const catalog = createEventCatalog(createFoundationEventCatalogStorage(storage), {
    clock: { nowMs: () => nowMs },
  });
  const event = await catalog.createEvent({ name: "Locked Game", timeZone: "UTC" }, technical);
  if (event.status !== "accepted") throw new Error("Expected Event.");
  const day = await catalog.addGameDay(event.value.eventId, { date: "2026-08-15" }, technical);
  if (day.status !== "accepted") throw new Error("Expected Game Day.");
  const pitch = await catalog.createPitch(event.value.eventId, { name: "Pitch 1" }, technical);
  if (pitch.status !== "accepted") throw new Error("Expected Pitch.");
  const slot = await catalog.createGameplaySlot(
    event.value.eventId,
    day.value.gameDayId,
    { sequence: 1, scheduledStart: "2026-08-15T10:00" },
    technical,
  );
  if (slot.status !== "accepted")
    throw new Error(`Expected Gameplay Slot: ${JSON.stringify(slot)}`);
  const pitchSlot = (
    await storage.transaction((transaction) =>
      transaction.listPitchSlots(day.value.gameDayId, pitch.value.pitchId),
    )
  )[0];
  if (pitchSlot === undefined) throw new Error("Expected Pitch Slot.");
  const game = await catalog.createEventGame(
    event.value.eventId,
    day.value.gameDayId,
    {
      gameplaySlotId: slot.value.gameplaySlotId,
      pitchSlotId: pitchSlot.pitchSlotId,
      sideA: { sourceLabel: "A" },
      sideB: { sourceLabel: "B" },
    },
    technical,
  );
  if (game.status !== "accepted") throw new Error(`Expected Event Game: ${JSON.stringify(game)}`);

  const root: EventGameRecordRoot = {
    recordId: "record-122",
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
      { id: "side-a", eventTeamId: "team-a", teamInterpretationRef: "team-a" },
      { id: "side-b", eventTeamId: "team-b", teamInterpretationRef: "team-b" },
    ],
    lifecycle: {
      phase: "finished",
      commencedAtMs: 1_000,
      finishedAtMs: 2_000,
      lockedAtMs: 3_000,
      lockReason: "finished-inactivity",
    },
    compatibility: {
      recordVersion: "event-game-record-v1",
      schemaVersion: "event-game-record-v1",
      interpreterVersion: "live-event-iqa-v1",
    },
    creationEvidence: {
      operationId: "register-122",
      actorReference: "event-admin:test",
      source: "event-game-registration",
      createdAtMs: 500,
    },
  };
  const grantableRoot = {
    ...root,
    lifecycle: { ...root.lifecycle, lockedAtMs: null, lockReason: null },
  } satisfies EventGameRecordRoot;
  await storage.transaction((transaction) => {
    transaction.insertRoot({
      root: grantableRoot,
      canonicalContent: canonicalizeEventGameRecordRoot(grantableRoot),
    });
    transaction.upsertRecordMetadata({
      recordId: root.recordId,
      actionCount: 0,
      orderingVersion: "causal-occurrence-operation-v1",
      lastAcceptedAtMs: null,
      updatedAtMs: root.creationEvidence.createdAtMs,
    });
  });

  const record = createEventGameRecord(storage, {
    externalScopeResolver: {
      resolve: (scope) => ({ status: "resolved" as const, scope }),
      resolveEventTeam: () => ({ status: "resolved" as const }),
    },
    interpreter: createLiveEventGameIqaInterpreter(),
    clock: () => nowMs,
    auditAuthorityVerifier: { verify: () => true },
  });
  if ((await record.registerRoot(grantableRoot)).status !== "idempotent")
    throw new Error("Expected the fixture Event Game Record root to be present.");

  let grantEligible = true;
  const grantOptions: GrantAuthorityOptions = {
    environmentId: "test",
    clock: { nowMs: () => nowMs },
    randomness: {
      bytes: (length: number) => {
        const result = new Uint8Array(length);
        for (let index = 0; index < length; index += 1)
          result[index] = (grantRandomCounter + index) % 256;
        grantRandomCounter += length;
        return result;
      },
    },
    keyRing,
    controlScopeResolver: {
      resolve: (scope, snapshot) => {
        const current = snapshot?.findRootByPitchSlotId(scope.pitchSlotId);
        if (snapshot === undefined) {
          return grantEligible
            ? { status: "eligible" as const, eventGameId: root.eventGameId }
            : {
                status: "terminal" as const,
                reason: "game-locked" as const,
                eventGameId: root.eventGameId,
              };
        }
        if (current === null || current === undefined) return { status: "empty" as const };
        return current.lifecycle.lockedAtMs === null
          ? { status: "eligible" as const, eventGameId: current.eventGameId }
          : {
              status: "terminal" as const,
              reason: "game-locked" as const,
              eventGameId: current.eventGameId,
            };
      },
    },
    privilegedAuthorityVerifier: createGrantAuthorityVerifier((input) =>
      isTechnicalAdminAuthority(input)
        ? { kind: "technical-admin", id: input.sessionId }
        : isRecord(input) && input.kind === "technical-admin" && typeof input.id === "string"
          ? { kind: "technical-admin", id: input.id }
          : isRecord(input) &&
              input.kind === "grant-session" &&
              typeof input.sessionBearer === "string"
            ? {
                kind: "grant-session",
                sessionBearer: input.sessionBearer,
                sessionId: "fixture-session",
              }
            : null,
    ),
  };
  const grants = createTypedGrantAuthority(storage, grantOptions);
  const controlGrant = await grants.createControlGrant({
    scope: root.externalScope,
    authority: { kind: "technical-admin", id: "fixture-technical" },
  });
  if (controlGrant.status !== "created")
    throw new Error(`Expected Control Grant: ${JSON.stringify(controlGrant)}`);
  const oldCode = await grants.createGrantCode(controlGrant.grantId, {
    kind: "technical-admin",
    id: "fixture-technical",
  });
  if (oldCode.status !== "created")
    throw new Error(`Expected Grant Code: ${JSON.stringify(oldCode)}`);
  const oldSession = await grants.admitGrant({
    qrCredential: controlGrant.qrCredential,
    browserContext: "old-qr-before-reopen",
  });
  if (oldSession.status !== "admitted")
    throw new Error(`Expected Grant Session: ${JSON.stringify(oldSession)}`);
  const oldCodeSession = await grants.admitGrantCode({
    grantCode: oldCode.code,
    browserContext: "old-code-before-reopen",
  });
  if (oldCodeSession.status !== "admitted")
    throw new Error(`Expected Grant Code Session: ${JSON.stringify(oldCodeSession)}`);
  await grants.disableGrantCode(controlGrant.grantId, technical);
  await grants.leaveGrantSession(oldSession.sessionBearer);
  await grants.leaveGrantSession(oldCodeSession.sessionBearer);
  grantEligible = false;
  await storage.transaction((transaction) => {
    transaction.updateRoot({
      root,
      canonicalContent: canonicalizeEventGameRecordRoot(root),
    });
  });
  const rawAdministration = createEventAdministration({ storage, grants, nowMs: () => nowMs });
  const administration = {
    ...rawAdministration,
    async correctLockedEventGame(
      eventIdInput: unknown,
      eventGameIdInput: unknown,
      input: Parameters<typeof rawAdministration.correctLockedEventGame>[2],
      authority: Parameters<typeof rawAdministration.correctLockedEventGame>[3],
    ) {
      const preview = await rawAdministration.previewLockedEventGameCorrection(
        eventIdInput,
        eventGameIdInput,
        input,
        authority,
      );
      if (preview.status !== "accepted") return preview;
      return rawAdministration.correctLockedEventGame(
        eventIdInput,
        eventGameIdInput,
        { ...input, previewFingerprint: preview.value.fingerprint },
        authority,
      );
    },
    async reopenEventGame(
      eventIdInput: unknown,
      eventGameIdInput: unknown,
      input: Parameters<typeof rawAdministration.reopenEventGame>[2],
      authority: Parameters<typeof rawAdministration.reopenEventGame>[3],
    ) {
      const preview = await rawAdministration.previewEventGameReopening(
        eventIdInput,
        eventGameIdInput,
        input,
        authority,
      );
      if (preview.status !== "accepted") return preview;
      return rawAdministration.reopenEventGame(
        eventIdInput,
        eventGameIdInput,
        { ...input, previewFingerprint: preview.value.fingerprint },
        authority,
      );
    },
  };
  const createControl = () => {
    const replayCapabilities = new Map<
      string,
      { replayDigest: string; reservationId: string | null; authorized: boolean }
    >();
    const lockedReplayCapability = {
      issue(replayDigest: string) {
        const evidence = `replay-evidence-${replayCapabilities.size + 1}`;
        replayCapabilities.set(evidence, { replayDigest, reservationId: null, authorized: false });
        return evidence;
      },
      remember(input: { evidence: string; replayDigest: string; reservationId: string }) {
        const current = replayCapabilities.get(input.evidence);
        if (current?.replayDigest === input.replayDigest)
          replayCapabilities.set(input.evidence, {
            ...current,
            reservationId: input.reservationId,
          });
      },
      find(replayDigest: string) {
        for (const [evidence, current] of replayCapabilities) {
          if (current.replayDigest === replayDigest && current.reservationId !== null)
            return evidence;
        }
        return null;
      },
      authorize(replayDigest: string) {
        for (const [evidence, current] of replayCapabilities) {
          if (current.replayDigest === replayDigest)
            replayCapabilities.set(evidence, { ...current, authorized: true });
        }
      },
      authorized(evidence: string) {
        return replayCapabilities.get(evidence)?.authorized === true;
      },
      reservationId(evidence: string) {
        return replayCapabilities.get(evidence)?.reservationId ?? null;
      },
    };
    const acceptance = createFoundationAcceptance(storage, {
      grant: grantOptions,
      externalScopeResolver: {
        resolve: (scope) => ({ status: "resolved" as const, scope }),
        resolveEventTeam: () => ({ status: "resolved" as const }),
      },
      clock: () => nowMs,
      interpreter: createLiveEventGameIqaInterpreter(),
      verifyLockedReplay: ({ evidence }) =>
        typeof evidence === "string" &&
        lockedReplayCapability.reservationId(evidence) !== null &&
        lockedReplayCapability.authorized(evidence),
      authorizeLockedReplay: ({ evidence }) => lockedReplayCapability.authorized(evidence),
      lockedReplayReservationId: (evidence) =>
        typeof evidence === "string" ? lockedReplayCapability.reservationId(evidence) : null,
      replayEligibility: ({ replayEvidenceId }) =>
        lockedReplayCapability.reservationId(replayEvidenceId) !== null
          ? { status: "eligible" as const }
          : { status: "ineligible" as const },
      validateActionInTransaction: ({ transaction, root: currentRoot, action }) =>
        validateLiveEventGameActionInTransaction(
          transaction.listActions(currentRoot.recordId),
          currentRoot,
          action,
          null,
        ),
    });
    return createLiveEventGameControl({
      resolveEventGameRecord: async (eventGameId) =>
        eventGameId === root.eventGameId ? { recordId: root.recordId, record } : null,
      acceptance,
      lockedReplayCapability,
      grantAuthority: grants,
      clock: () => nowMs,
      listEventGameRoots: async () =>
        storage.transaction((transaction) => transaction.listRoots?.() ?? []),
      authorizeLockedReplay: async ({
        sessionBearer,
        eventGameId,
        grantSessionId,
        grantVersion,
      }) => {
        const authorized = await grants.authorizeGrant({
          sessionBearer,
          eventGameId,
          readOnly: true,
        });
        return (
          authorized.status === "authorized" &&
          authorized.grantType === "control" &&
          authorized.grantSessionId === grantSessionId &&
          authorized.grantVersion === grantVersion
        );
      },
      lockEventGame: (eventGameId, lockedAtMs) =>
        storage.transaction((transaction) => {
          const current = transaction.findRootByEventGameId(eventGameId);
          if (
            current === null ||
            current.lifecycle.phase !== "finished" ||
            current.lifecycle.finishedAtMs === null ||
            current.lifecycle.lockedAtMs !== null
          )
            return { status: "rejected" as const, reason: "invalid-state" };
          const locked = validateEventGameRecordRoot({
            ...current,
            lifecycle: { ...current.lifecycle, lockedAtMs, lockReason: "finished-inactivity" },
          });
          if (!locked.ok) return { status: "rejected" as const, reason: "invalid-state" };
          transaction.updateRoot({
            root: locked.value,
            canonicalContent: canonicalizeEventGameRecordRoot(locked.value),
          });
          return {
            status: "locked" as const,
            eventGameId,
            terminatedSessionCount: 0,
          };
        }),
    });
  };
  return {
    storage,
    technical,
    eventId: event.value.eventId,
    eventGameId: game.value.eventGameId,
    recordId: root.recordId,
    record,
    grants,
    grantOptions,
    createControl,
    setNow: (value: number) => {
      nowMs = value;
    },
    setGrantEligible: (eligible: boolean) => {
      grantEligible = eligible;
    },
    controlGrantId: controlGrant.grantId,
    oldGrantVersion: controlGrant.grantVersion,
    oldQrCredential: controlGrant.qrCredential,
    oldGrantCode: oldCode.code,
    oldSessionBearer: oldSession.sessionBearer,
    administration,
    rawAdministration,
  };
}

function bytes(length: number): Uint8Array {
  return new Uint8Array(length).fill(7);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
