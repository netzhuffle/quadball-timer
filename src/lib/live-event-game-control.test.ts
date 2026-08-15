import { describe, expect, test } from "bun:test";
import { applyGameCommand, createInitialGameState } from "@/lib/game-engine";
import { createFoundationAcceptance, type AcceptanceLimits } from "@/lib/foundation-acceptance";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import { createEventGameRecord } from "@/lib/event-game-record";
import { createGrantTestAuthorityVerifier } from "@/lib/grant-authority-test-support";
import { createTypedGrantAuthority } from "@/lib/grant-management";
import type { GrantAuthorityOptions } from "@/lib/grant-authority";
import type { ControlGrantSessionResolution, GrantKeyRing } from "@/lib/grant-types";
import type { EventGameRecordRoot } from "@/lib/foundation-record-types";
import {
  createLiveEventGameControl,
  createLiveEventGameIqaInterpreter,
  LIVE_EVENT_CONTROL_INTENT_VERSION,
  LIVE_SUSPENSION_SNAPSHOT_VERSION,
  parseLiveEventControllerIntent,
  suspensionPenaltyStateFromProjection,
  type LiveEventControllerIntent,
  validateLiveEventGameActionInTransaction,
} from "@/lib/live-event-game-control";
import { createLiveEventGameControlTransport } from "@/lib/live-event-game-transport";
import { LIVE_SEEKER_RELEASE_MS } from "@/lib/live-event-penalties";
import { createAdHocGamesService } from "@/lib/ad-hoc-games";
import { createControlScopeResolver as createRuntimeControlScopeResolver } from "@/lib/live-event-game-runtime";

describe("Live Event Game control", () => {
  test("keeps Penalty Reason values fixed while skip remains a Controller-only absence", () => {
    expect(
      parseLiveEventControllerIntent({
        ...reasonIntent(),
        reason: "skip",
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseLiveEventControllerIntent({
        ...reasonIntent(),
        reason: "free text",
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseLiveEventControllerIntent({
        ...cardIntent(),
        seekerPenalty: "controller-guessed",
      }),
    ).toMatchObject({ ok: false });
  });

  test("derives sticks-up and seeker-floor timing from the real Controller seam", async () => {
    const pregame = await createHarness();
    const pregameOpened = await pregame.control.openController({
      qrCredential: pregame.qrCredential,
      browserContext: "pregame-card-controller",
    });
    if (pregameOpened.status !== "opened") throw new Error("Expected the Controller to open.");
    await pregame.control.submitControllerIntent({
      sessionBearer: pregameOpened.session.sessionBearer,
      eventGameId: pregame.root.eventGameId,
      intent: clockCorrectionIntent("pregame-clock", 90_000),
    });
    const pregameCard = await pregame.control.submitControllerIntent({
      sessionBearer: pregameOpened.session.sessionBearer,
      eventGameId: pregame.root.eventGameId,
      intent: cardIntent(),
    });
    expect(pregameCard).toMatchObject({
      status: "accepted",
      projection: { phase: "in-progress" },
    });
    expect((await pregame.record.readActions()).at(-1)?.action.interpretation).toMatchObject({
      type: "fact",
      factType: "card",
      payload: { gameTimeMs: 90_000, data: { penaltyStart: "sticks-up" } },
    });

    const inGame = await createHarness();
    const opened = await inGame.control.openController({
      qrCredential: inGame.qrCredential,
      browserContext: "seeker-floor-controller",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    await inGame.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: inGame.root.eventGameId,
      intent: goalIntent({ operationId: "commence-game", factId: "commence-game" }),
    });
    const seekerGameTime = 19 * 60_000 + 30_000;
    await inGame.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: inGame.root.eventGameId,
      intent: clockCorrectionIntent("seeker-clock", seekerGameTime),
    });
    const ordinaryCard = await inGame.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: inGame.root.eventGameId,
      intent: cardIntent({
        operationId: "ordinary-floor-card",
        factId: "ordinary-floor-card",
        playerNumber: 8,
      }),
    });
    expect(ordinaryCard).toMatchObject({ status: "accepted" });
    const seekerCard = await inGame.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: inGame.root.eventGameId,
      intent: cardIntent({
        operationId: "seeker-card",
        factId: "seeker-card",
        seekerPenalty: "head-referee-confirmed",
      }),
    });
    expect(seekerCard).toMatchObject({ status: "accepted" });
    expect((await inGame.record.readActions()).at(-1)?.action.interpretation).toMatchObject({
      type: "fact",
      factType: "card",
      payload: {
        gameTimeMs: seekerGameTime,
        data: {
          penaltyStart: "seeker-release",
          seekerPenalty: "head-referee-confirmed",
        },
      },
    });
    expect(
      (await inGame.record.readActions()).find(
        ({ action }) => action.operationId === "ordinary-floor-card",
      )?.action.interpretation,
    ).toMatchObject({
      type: "fact",
      payload: { data: { penaltyStart: "immediate" } },
    });

    const earlierGoal = await inGame.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: inGame.root.eventGameId,
      intent: {
        ...goalIntent({
          operationId: "before-seeker-floor",
          factId: "before-seeker-floor",
          gameTimeMs: seekerGameTime + 1,
        }),
        occurrence: { clientOriginAtMs: 10_000, source: "offline" as const },
      },
    });
    expect(earlierGoal).toMatchObject({
      status: "accepted",
      projection: {
        penalties: {
          pendingExpirations: [],
          releases: [{ playerKey: "side-b:8", releasedMs: seekerGameTime + 1 }],
        },
      },
    });
    if (earlierGoal.status !== "accepted" || earlierGoal.projection?.penalties === undefined) {
      throw new Error("Expected the pre-floor score projection.");
    }
    expect(
      earlierGoal.projection.penalties.players.some((player) => player.playerNumber === 7),
    ).toBe(true);
    expect(
      earlierGoal.projection.penalties.releases.some((release) => release.playerKey === "side-b:7"),
    ).toBe(false);
    await inGame.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: inGame.root.eventGameId,
      intent: clockCorrectionIntent("seeker-release-clock", 20 * 60_000),
    });
    const releasedAtFloor = await inGame.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: inGame.root.eventGameId,
      intent: goalIntent({
        operationId: "at-seeker-floor",
        factId: "at-seeker-floor",
        gameTimeMs: 0,
      }),
    });
    expect(releasedAtFloor).toMatchObject({ status: "accepted" });
    if (
      releasedAtFloor.status !== "accepted" ||
      releasedAtFloor.projection?.penalties === undefined
    ) {
      throw new Error("Expected the seeker-floor score projection.");
    }
    expect(
      releasedAtFloor.projection.penalties.releases.some(
        (release) =>
          release.scoreFactId === "at-seeker-floor" &&
          release.playerKey === "side-b:7" &&
          release.releasedMs === LIVE_SEEKER_RELEASE_MS,
      ),
    ).toBe(true);
  });

  test("uses every queued penalty minute including red for Controller score priority", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "queued-priority-controller",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const submit = (intent: unknown) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
      });

    await submit(substantiveIntent("commence-priority", "card"));
    await submit(
      cardIntent({
        operationId: "two-first-controller",
        factId: "two-first-controller",
        playerNumber: 7,
      }),
    );
    await submit(
      cardIntent({
        operationId: "queued-red-controller",
        factId: "queued-red-controller",
        playerNumber: 7,
        cardType: "red",
      }),
    );
    await submit(
      cardIntent({ operationId: "one-controller", factId: "one-controller", playerNumber: 8 }),
    );
    const scored = await submit(
      goalIntent({ operationId: "queued-priority-goal", factId: "queued-priority-goal" }),
    );

    expect(scored).toMatchObject({
      status: "accepted",
      projection: {
        penalties: {
          releases: [{ playerKey: "side-b:8", releaseCause: "score" }],
          pendingExpirations: [],
        },
      },
    });
  });

  test("keeps tie choice, red-to-blue gating, foul expiry, and reason follow-up on the Controller seam", async () => {
    const tieHarness = await createHarness();
    const tieOpened = await tieHarness.control.openController({
      qrCredential: tieHarness.qrCredential,
      browserContext: "tie-controller",
    });
    if (tieOpened.status !== "opened") throw new Error("Expected the Controller to open.");
    const tieSubmit = (intent: unknown) =>
      tieHarness.control.submitControllerIntent({
        sessionBearer: tieOpened.session.sessionBearer,
        eventGameId: tieHarness.root.eventGameId,
        intent,
      });
    await tieSubmit(substantiveIntent("tie-commence", "card"));
    await tieSubmit(
      cardIntent({ operationId: "tie-card-a", factId: "tie-card-a", playerNumber: 7 }),
    );
    await tieSubmit(
      cardIntent({ operationId: "tie-card-b", factId: "tie-card-b", playerNumber: 8 }),
    );
    const tie = await tieSubmit(
      goalIntent({ operationId: "tie-goal", factId: "tie-goal", gameTimeMs: 0 }),
    );
    expect(tie).toMatchObject({
      status: "accepted",
      projection: {
        penalties: {
          pendingExpirations: [
            {
              candidatePlayerKeys: ["side-b:7", "side-b:8"],
              requiresOfficialChoice: true,
            },
          ],
        },
      },
    });
    const selected = await tieSubmit({
      ...releaseIntent("penalty-expiration:tie-goal", "tie-goal", "side-b:8"),
    });
    expect(selected).toMatchObject({
      status: "accepted",
      projection: { penalties: { pendingExpirations: [], players: [{ playerNumber: 7 }] } },
    });

    const redBlueHarness = await createHarness();
    const redBlueOpened = await redBlueHarness.control.openController({
      qrCredential: redBlueHarness.qrCredential,
      browserContext: "red-blue-controller",
    });
    if (redBlueOpened.status !== "opened") throw new Error("Expected the Controller to open.");
    const redBlueSubmit = (intent: unknown) =>
      redBlueHarness.control.submitControllerIntent({
        sessionBearer: redBlueOpened.session.sessionBearer,
        eventGameId: redBlueHarness.root.eventGameId,
        intent,
      });
    await redBlueSubmit(substantiveIntent("red-blue-commence", "card"));
    await redBlueSubmit(
      cardIntent({
        operationId: "a-red-controller",
        factId: "a-red-controller",
        playerNumber: 7,
        cardType: "red",
      }),
    );
    await redBlueSubmit(
      cardIntent({
        operationId: "b-blue-controller",
        factId: "b-blue-controller",
        playerNumber: 7,
      }),
    );
    await redBlueSubmit(
      cardIntent({
        operationId: "c-blue-controller",
        factId: "c-blue-controller",
        playerNumber: 7,
      }),
    );
    await redBlueSubmit(clockCorrectionIntent("a-red-blue-clock-30", 30_000));
    const beforeBlue = await redBlueSubmit(
      goalIntent({
        operationId: "red-blue-early-goal",
        factId: "red-blue-early-goal",
        gameTimeMs: 0,
      }),
    );
    expect(beforeBlue).toMatchObject({
      status: "accepted",
      projection: { penalties: { releases: [], pendingExpirations: [] } },
    });
    await redBlueSubmit(clockCorrectionIntent("b-red-blue-clock-120", 120_000));
    const afterBlue = await redBlueSubmit(
      goalIntent({
        operationId: "red-blue-late-goal",
        factId: "red-blue-late-goal",
        gameTimeMs: 0,
      }),
    );
    expect(afterBlue).toMatchObject({
      status: "accepted",
      projection: { penalties: { releases: [{ playerKey: "side-b:7", releaseCause: "score" }] } },
    });
    const afterFirstRelease = await redBlueSubmit(
      goalIntent({
        operationId: "red-blue-repeated-goal",
        factId: "red-blue-repeated-goal",
        gameTimeMs: 0,
      }),
    );
    if (
      afterFirstRelease.status !== "accepted" &&
      afterFirstRelease.status !== "duplicate-accepted"
    ) {
      throw new Error("Expected the repeated score to be accepted.");
    }
    if (
      afterFirstRelease.projection === null ||
      afterFirstRelease.projection.penalties === undefined
    ) {
      throw new Error("Expected the repeated score projection.");
    }
    expect(
      afterFirstRelease.projection.penalties.releases.some(
        (release) =>
          release.scoreFactId === "red-blue-repeated-goal" &&
          release.playerKey === "side-b:7" &&
          release.releaseCause === "score",
      ),
    ).toBe(true);

    const foulHarness = await createHarness();
    const foulOpened = await foulHarness.control.openController({
      qrCredential: foulHarness.qrCredential,
      browserContext: "foul-controller",
    });
    if (foulOpened.status !== "opened") throw new Error("Expected the Controller to open.");
    const foulSubmit = (intent: unknown) =>
      foulHarness.control.submitControllerIntent({
        sessionBearer: foulOpened.session.sessionBearer,
        eventGameId: foulHarness.root.eventGameId,
        intent,
      });
    await foulSubmit(goalIntent({ operationId: "foul-commence", factId: "foul-commence" }));
    const foul = await foulSubmit(
      cardIntent({
        operationId: "foul-card-controller",
        factId: "foul-card-controller",
        playerNumber: 9,
        foulBeforeScore: true,
      }),
    );
    expect(foul).toMatchObject({
      status: "accepted",
      projection: {
        penalties: {
          players: [],
          releases: [{ playerKey: "side-b:9", releaseCause: "foul-before-score" }],
        },
      },
    });
    const foulRelease = (await foulHarness.record.readActions()).find(
      ({ action }) =>
        action.interpretation.type === "fact" &&
        action.interpretation.factType === "penalty-release-consequence",
    );
    expect(foulRelease?.action.interpretation).toMatchObject({
      type: "fact",
      factType: "penalty-release-consequence",
      payload: {
        data: { releaseCause: "foul-before-score", sourceFactId: "foul-card-controller" },
      },
    });
    const foulCorrection = await foulSubmit(
      correctionIntent(
        "correct-foul-release",
        "correct-foul-release-fact",
        false,
        "foul-card-controller-penalty-release",
      ),
    );
    expect(foulCorrection).toMatchObject({
      status: "accepted",
      projection: {
        penalties: {
          releases: [{ scoreFactId: "foul-commence", releaseCause: "score" }],
          players: [{ playerNumber: 9 }],
        },
      },
    });

    const reasonHarness = await createHarness();
    const reasonOpened = await reasonHarness.control.openController({
      qrCredential: reasonHarness.qrCredential,
      browserContext: "reason-controller",
    });
    if (reasonOpened.status !== "opened") throw new Error("Expected the Controller to open.");
    const reasonSubmit = (intent: unknown) =>
      reasonHarness.control.submitControllerIntent({
        sessionBearer: reasonOpened.session.sessionBearer,
        eventGameId: reasonHarness.root.eventGameId,
        intent,
      });
    await reasonSubmit(cardIntent());
    const laterReason = await reasonSubmit(
      reasonIntent({
        operationId: "zz-later-reason",
        factId: "zz-later-reason",
        reason: "conduct",
      }),
    );
    expect(laterReason).toMatchObject({
      status: "accepted",
      projection: { penalties: { cards: [{ factId: "fact-card", reason: "conduct" }] } },
    });
  });

  test("strips foul-before-score from ejection cards at the Controller boundary", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "ejection-foul-boundary",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const result = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: cardIntent({
        operationId: "ejection-foul-card",
        factId: "ejection-foul-card",
        cardType: "ejection",
        foulBeforeScore: true,
      }),
    });
    expect(result).toMatchObject({
      status: "accepted",
      projection: { penalties: { releases: [] } },
    });
    const actions = await harness.record.readActions();
    expect(actions).toHaveLength(1);
    const interpretation = actions[0]?.action.interpretation;
    expect(interpretation).toMatchObject({ factType: "card" });
    if (
      interpretation?.type !== "fact" ||
      typeof interpretation.payload !== "object" ||
      interpretation.payload === null
    ) {
      throw new Error("Expected a durable ejection card fact.");
    }
    if (Array.isArray(interpretation.payload) || !("data" in interpretation.payload)) {
      throw new Error("Expected card payload data.");
    }
    expect(interpretation.payload.data).not.toHaveProperty("foulBeforeScore");
  });

  test("accepts a delayed tie choice after natural expiry and anchors it to the score fact", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "delayed-tie-controller",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const submit = (intent: unknown) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
      });

    await submit(substantiveIntent("delayed-tie-commence", "card"));
    await submit(cardIntent({ operationId: "delayed-tie-card-7", factId: "delayed-tie-card-7" }));
    await submit(
      cardIntent({
        operationId: "delayed-tie-card-8",
        factId: "delayed-tie-card-8",
        playerNumber: 8,
      }),
    );
    await submit(clockCorrectionIntent("delayed-tie-score-clock", 10_000));
    const score = await submit(
      goalIntent({
        operationId: "delayed-tie-score",
        factId: "delayed-tie-score",
        gameTimeMs: 10_000,
      }),
    );
    expect(score).toMatchObject({
      status: "accepted",
      projection: {
        penalties: {
          pendingExpirations: [{ scoreFactId: "delayed-tie-score", requiresOfficialChoice: true }],
        },
      },
    });

    await submit(clockCorrectionIntent("delayed-tie-clock-after-expiry", 90_000));
    const selected = await submit(
      releaseIntent(
        "penalty-expiration:delayed-tie-score",
        "delayed-tie-score",
        "side-b:8",
        90_000,
      ),
    );
    expect(selected).toMatchObject({
      status: "accepted",
      projection: {
        penalties: {
          releases: [
            {
              scoreFactId: "delayed-tie-score",
              playerKey: "side-b:8",
              releasedMs: 10_000,
            },
          ],
        },
      },
    });
    const release = (await harness.record.readActions()).find(
      ({ action }) => action.operationId === "zz-release-side-b:8",
    );
    expect(release?.action.interpretation).toMatchObject({
      type: "fact",
      factType: "penalty-release",
      payload: {
        gameTimeMs: 10_000,
        data: {
          pendingId: "penalty-expiration:delayed-tie-score",
          scoreFactId: "delayed-tie-score",
        },
      },
    });
    expect(
      await submit(
        releaseIntent(
          "penalty-expiration:delayed-tie-score",
          "delayed-tie-score",
          "side-b:8",
          90_000,
        ),
      ),
    ).toMatchObject({ status: "duplicate-accepted" });
    expect(
      await submit({
        ...releaseIntent(
          "penalty-expiration:delayed-tie-score",
          "delayed-tie-score",
          "side-b:7",
          90_000,
        ),
        operationId: "competing-delayed-release",
        factId: "competing-delayed-release",
      }),
    ).toMatchObject({ status: "rejected" });
  });

  test("accepts cards before optional fixed reasons, applies score release choice, and rebuilds corrections", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "penalty-control",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const submit = (intent: unknown) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
      });

    expect(
      await submit({
        ...reasonIntent(),
        operationId: "orphan-reason",
        factId: "orphan-reason-fact",
      }),
    ).toMatchObject({ status: "rejected" });
    const acceptedCard = await submit(cardIntent());
    expect(acceptedCard).toMatchObject({
      status: "accepted",
      projection: {
        penalties: {
          cards: [{ factId: "fact-card", reason: null }],
          pendingExpirations: [],
        },
      },
    });
    const reason = await submit(reasonIntent());
    expect(reason).toMatchObject({
      status: "accepted",
      projection: { penalties: { cards: [{ reason: "contact-safety" }] } },
    });

    const goal = await submit(goalIntent({ gameSideId: "side-a", gameTimeMs: 0 }));
    expect(goal).toMatchObject({
      status: "accepted",
      projection: {
        penalties: {
          pendingExpirations: [],
          players: [],
          releases: [
            {
              id: "fact-goal-penalty-release",
              scoreFactId: "fact-goal",
              playerKey: "side-b:7",
            },
          ],
        },
      },
    });
    expect(await submit(goalIntent({ gameSideId: "side-a", gameTimeMs: 0 }))).toMatchObject({
      status: "duplicate-accepted",
      projection: { penalties: { releases: [{ id: "fact-goal-penalty-release" }] } },
    });
    expect(
      (await harness.record.readActions()).some(
        ({ action }) =>
          action.interpretation.type === "fact" &&
          action.interpretation.factType === "penalty-release-consequence" &&
          action.interpretation.factId === "fact-goal-penalty-release",
      ),
    ).toBe(true);
    const correctedRelease = await submit(
      correctionIntent(
        "correct-release-consequence",
        "correction-release-consequence",
        false,
        "fact-goal-penalty-release",
      ),
    );
    expect(correctedRelease).toMatchObject({
      status: "accepted",
      projection: {
        scoreByGameSide: { "side-a": 10 },
        penalties: { players: [{ playerNumber: 7 }], releases: [] },
      },
    });
    const reinstatedRelease = await submit(
      correctionIntent(
        "reinstate-release-consequence",
        "reinstate-release-consequence",
        true,
        "fact-goal-penalty-release",
      ),
    );
    expect(reinstatedRelease).toMatchObject({
      status: "accepted",
      projection: {
        scoreByGameSide: { "side-a": 10 },
        penalties: { releases: [{ id: "fact-goal-penalty-release" }] },
      },
    });

    const corrected = await submit(
      correctionIntent("correct-card", "correction-card", false, "fact-card"),
    );
    expect(corrected).toMatchObject({
      status: "accepted",
      projection: { penalties: { cards: [], players: [], pendingExpirations: [] } },
    });
  });

  test("Event authority, storage, and control remain accepted after Ad Hoc pressure", async () => {
    const adHoc = createAdHocGamesService({
      now: () => 1_000,
      maxConnectedSockets: 1,
      eventCapacity: { totalConnections: 2, reservedConnections: 1, activeConnections: () => 0 },
    });
    const created = await adHoc.create({
      homeName: "Ad Hoc",
      awayName: "Pressure",
      sourceKey: "pressure-source",
    });
    if (created.status !== "accepted") throw new Error("Expected Ad Hoc Game.");
    expect(
      await adHoc.setConnection({
        gameId: created.gameId,
        sessionId: created.sessionId,
        connected: true,
        connectionId: "pressure-socket",
      }),
    ).toBe(true);
    const operations = Array.from({ length: 40 }, (_, index) => ({
      id: `pressure-${index}`,
      clientSentAtMs: 1_000,
      command: { type: "set-running", running: index % 2 === 0 },
    })) as never[];
    expect(
      (await adHoc.apply({ gameId: created.gameId, sessionId: created.sessionId, operations }))
        .status,
    ).toBe("accepted");
    for (let index = 0; index < 4; index += 1)
      expect(
        (
          await adHoc.create({
            homeName: `Pressure ${index}`,
            awayName: "Away",
            sourceKey: "pressure-source",
          })
        ).status,
      ).toBe("accepted");
    expect(
      (await adHoc.create({ homeName: "Delayed", awayName: "Away", sourceKey: "pressure-source" }))
        .status,
    ).toBe("rejected");

    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "event-after-ad-hoc-pressure",
    });
    if (opened.status !== "opened") throw new Error("Expected the Event Controller to open.");
    const eventResult = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent({
        operationId: "event-after-ad-hoc-pressure",
        factId: "event-after-ad-hoc-pressure",
      }),
    });
    expect(eventResult).toMatchObject({ status: "accepted" });
    expect(await harness.record.readActions()).toHaveLength(1);
  });

  test("reconciles invalidated Event Grant Sessions before reporting connection capacity", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "capacity-expiry",
    });
    expect(opened.status).toBe("opened");
    expect(harness.control.activeControllerSessions()).toBe(1);
    await harness.authority.revokeGrant(harness.grantId, { kind: "fixture", id: "fixture" });
    expect(await harness.control.reconcileActiveControllerSessions()).toBe(0);
    harness.control.close();
    expect(harness.control.activeControllerSessions()).toBe(0);
  });

  test("does not scan Event storage for authorization reads or known expiry", async () => {
    const harness = await createHarness({ grantExpiresAtMs: 10_500 });
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "capacity-read-boundary",
    });
    expect(opened.status).toBe("opened");
    const notifications = harness.lifecycleNotifications;
    harness.setNow(11_000);
    expect(harness.control.activeControllerSessions()).toBe(0);
    expect(harness.lifecycleNotifications).toBe(notifications);
    expect(
      await harness.control.refreshController({
        sessionBearer: harness.sessionBearer,
        eventGameId: harness.root.eventGameId,
      }),
    ).toMatchObject({ status: "authorized" });
    expect(harness.lifecycleNotifications).toBe(notifications);
  });

  test("reruns one dirty Event capacity scan after a lifecycle change arrives", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "capacity-dirty-scan",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const originalAuthorize = harness.authority.authorizeGrant.bind(harness.authority);
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let authorizeCalls = 0;
    harness.authority.authorizeGrant = async (input) => {
      authorizeCalls += 1;
      if (authorizeCalls === 1) {
        markStarted();
        await gate;
      }
      return originalAuthorize(input);
    };
    const scan = harness.control.reconcileActiveControllerSessions();
    await started;
    harness.triggerLifecycleChange();
    release();
    expect(await scan).toBe(1);
    expect(authorizeCalls).toBe(2);
  });

  test("does not repopulate Event capacity after close during reconciliation", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "capacity-close-scan",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const originalAuthorize = harness.authority.authorizeGrant.bind(harness.authority);
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.authority.authorizeGrant = async (input) => {
      markStarted();
      await gate;
      return originalAuthorize(input);
    };
    const scan = harness.control.reconcileActiveControllerSessions();
    await started;
    harness.control.close();
    release();
    expect(await scan).toBe(0);
    expect(harness.control.activeControllerSessions()).toBe(0);
  });

  test("expires a switched post-restart Event session from synchronous capacity", async () => {
    const harness = await createHarness({ grantExpiresAtMs: 10_500 });
    harness.setSessionResolution({
      status: "switchable",
      previousEventGameId: harness.root.eventGameId,
      currentEventGameId: "game-reassigned",
    });
    expect(
      await harness.control.refreshController({
        sessionBearer: harness.sessionBearer,
        eventGameId: harness.root.eventGameId,
      }),
    ).toMatchObject({ status: "switch-required" });
    expect(
      await harness.control.switchController({ sessionBearer: harness.sessionBearer }),
    ).toMatchObject({ status: "authorized", session: { eventGameId: "game-reassigned" } });
    expect(harness.control.activeControllerSessions()).toBe(1);
    harness.setNow(11_000);
    expect(harness.control.activeControllerSessions()).toBe(0);
  });

  test("scores a released stopped flag catch, fixes overtime target, and finishes at target", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "iqa-overtime",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const submit = (intent: unknown, causalPredecessorIds?: string[]) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
        causalPredecessorIds,
      });

    await submit(
      goalIntent({
        operationId: "goal-b",
        factId: "fact-goal-b",
        gameSideId: "side-b",
        gameTimeMs: 10_000,
      }),
    );
    await submit(
      goalIntent({
        operationId: "goal-b-2",
        factId: "fact-goal-b-2",
        gameSideId: "side-b",
        gameTimeMs: 20_000,
      }),
    );
    await submit(
      goalIntent({
        operationId: "goal-b-3",
        factId: "fact-goal-b-3",
        gameSideId: "side-b",
        gameTimeMs: 30_000,
      }),
    );
    const caught = await submit(flagCatchIntent("catch-a", "catch-fact-a", "side-a"));
    expect(caught).toMatchObject({
      status: "accepted",
      projection: {
        scoreByGameSide: { "side-a": 30, "side-b": 30 },
        overtime: true,
        overtimeTarget: 60,
        targetScore: 60,
        winnerGameSideId: null,
        catch: {
          catchingGameSideId: "side-a",
          nonCatchingGameSideId: "side-b",
          targetScore: 60,
        },
        phase: "in-progress",
      },
    });

    const postCatch = await submit(
      goalIntent({
        operationId: "post-catch-goal",
        factId: "post-catch-fact",
        gameSideId: "side-b",
        gameTimeMs: 1_300_000,
      }),
    );
    expect(postCatch).toMatchObject({
      projection: { scoreByGameSide: { "side-a": 30, "side-b": 40 }, overtimeTarget: 60 },
    });
    const finish = await submit(
      goalIntent({
        operationId: "target-goal",
        factId: "target-fact",
        gameSideId: "side-a",
        gameTimeMs: 1_400_000,
      }),
    );
    expect(finish).toMatchObject({
      status: "accepted",
      projection: {
        scoreByGameSide: { "side-a": 40, "side-b": 40 },
        overtimeTarget: 60,
        winnerGameSideId: null,
        phase: "in-progress",
      },
    });
    const final = await submit(
      goalIntent({
        operationId: "target-goal-2",
        factId: "target-fact-2",
        gameSideId: "side-a",
        gameTimeMs: 1_500_000,
      }),
    );
    expect(final).toMatchObject({
      projection: {
        scoreByGameSide: { "side-a": 50, "side-b": 40 },
        overtimeTarget: 60,
        winnerGameSideId: null,
        phase: "in-progress",
      },
    });
    expect(
      await submit(
        goalIntent({
          operationId: "target-goal-3",
          factId: "target-fact-3",
          gameSideId: "side-a",
          gameTimeMs: 1_600_000,
        }),
      ),
    ).toMatchObject({
      projection: {
        scoreByGameSide: { "side-a": 60, "side-b": 40 },
        winnerGameSideId: "side-a",
        phase: "finished",
      },
    });
  });

  test("rebuilds catch target and winner from a corrected pre-catch goal, while retaining audit facts", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "iqa-late-correction",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const submit = (intent: unknown, causalPredecessorIds?: string[]) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
        causalPredecessorIds,
      });
    await submit(
      goalIntent({
        operationId: "pre-catch-goal",
        factId: "pre-catch-fact",
        gameSideId: "side-b",
        gameTimeMs: 100_000,
      }),
    );
    await submit(
      goalIntent({
        operationId: "pre-catch-goal-2",
        factId: "pre-catch-fact-2",
        gameSideId: "side-b",
        gameTimeMs: 110_000,
      }),
    );
    await submit(
      goalIntent({
        operationId: "pre-catch-goal-3",
        factId: "pre-catch-fact-3",
        gameSideId: "side-b",
        gameTimeMs: 120_000,
      }),
    );
    const caught = await submit(flagCatchIntent("late-catch", "late-catch-fact", "side-a"));
    expect(caught).toMatchObject({ projection: { overtime: true, overtimeTarget: 60 } });
    const corrected = await submit(
      correctionIntent("correct-pre-catch", "correct-pre-catch-fact", false, "pre-catch-fact"),
      ["pre-catch-goal"],
    );
    expect(corrected).toMatchObject({
      status: "accepted",
      projection: {
        scoreByGameSide: { "side-a": 30, "side-b": 20 },
        overtime: false,
        overtimeTarget: null,
        winnerGameSideId: "side-a",
        phase: "finished",
      },
    });
    expect((await harness.record.readActions()).map((stored) => stored.action.operationId)).toEqual(
      ["pre-catch-goal", "pre-catch-goal-2", "pre-catch-goal-3", "late-catch", "correct-pre-catch"],
    );
  });

  test("applies concession score rules and keeps forfeits as directed results", async () => {
    const preOvertimeHarness = await createHarness();
    const preOvertimeOpened = await preOvertimeHarness.control.openController({
      qrCredential: preOvertimeHarness.qrCredential,
      browserContext: "iqa-pre-overtime-concession",
    });
    if (preOvertimeOpened.status !== "opened") throw new Error("Expected the Controller to open.");
    expect(
      await preOvertimeHarness.control.submitControllerIntent({
        sessionBearer: preOvertimeOpened.session.sessionBearer,
        eventGameId: preOvertimeHarness.root.eventGameId,
        intent: concessionIntent("pre-overtime-concede", "pre-overtime-concede-fact", "side-a"),
      }),
    ).toMatchObject({ status: "rejected" });
    expect(await preOvertimeHarness.record.readActions()).toHaveLength(0);

    const tiedHarness = await createHarness();
    const tiedOpened = await tiedHarness.control.openController({
      qrCredential: tiedHarness.qrCredential,
      browserContext: "iqa-tied-concession",
    });
    if (tiedOpened.status !== "opened") throw new Error("Expected the Controller to open.");
    const tiedSubmit = (intent: unknown) =>
      tiedHarness.control.submitControllerIntent({
        sessionBearer: tiedOpened.session.sessionBearer,
        eventGameId: tiedHarness.root.eventGameId,
        intent,
      });
    await tiedSubmit(goalIntent({ operationId: "tie-a", factId: "tie-a", gameSideId: "side-a" }));
    for (let index = 0; index < 4; index += 1) {
      await tiedSubmit(
        goalIntent({
          operationId: `tie-b-${index}`,
          factId: `tie-b-${index}`,
          gameSideId: "side-b",
          gameTimeMs: 20_000 + index,
        }),
      );
    }
    await tiedSubmit(flagCatchIntent("tie-catch", "tie-catch", "side-a"));
    expect(
      await tiedSubmit(concessionIntent("concede-a", "concede-a-fact", "side-a")),
    ).toMatchObject({
      projection: {
        scoreByGameSide: { "side-a": 40, "side-b": 50 },
        winnerGameSideId: "side-b",
        phase: "finished",
      },
    });

    const forfeitHarness = await createHarness();
    const forfeitOpened = await forfeitHarness.control.openController({
      qrCredential: forfeitHarness.qrCredential,
      browserContext: "iqa-forfeit",
    });
    if (forfeitOpened.status !== "opened") throw new Error("Expected the Controller to open.");
    expect(
      await forfeitHarness.control.submitControllerIntent({
        sessionBearer: forfeitOpened.session.sessionBearer,
        eventGameId: forfeitHarness.root.eventGameId,
        intent: forfeitIntent("forfeit-a", "forfeit-a-fact", "side-a"),
      }),
    ).toMatchObject({
      projection: {
        scoreByGameSide: { "side-a": 0, "side-b": 0 },
        winnerGameSideId: "side-b",
        phase: "finished",
      },
    });
  });

  test("covers trailing, leading, and double-forfeit outcomes", async () => {
    const trailingHarness = await createHarness();
    const trailingOpened = await trailingHarness.control.openController({
      qrCredential: trailingHarness.qrCredential,
      browserContext: "iqa-trailing-concession",
    });
    if (trailingOpened.status !== "opened") throw new Error("Expected the Controller to open.");
    const trailingSubmit = (intent: unknown) =>
      trailingHarness.control.submitControllerIntent({
        sessionBearer: trailingOpened.session.sessionBearer,
        eventGameId: trailingHarness.root.eventGameId,
        intent,
      });
    for (let index = 0; index < 5; index += 1) {
      await trailingSubmit(
        goalIntent({
          operationId: `trailing-lead-${index}`,
          factId: `trailing-lead-${index}`,
          gameSideId: "side-b",
          gameTimeMs: 20_000 + index,
        }),
      );
    }
    await trailingSubmit(
      goalIntent({ operationId: "trailing-a", factId: "trailing-a", gameSideId: "side-a" }),
    );
    await trailingSubmit(flagCatchIntent("trailing-catch", "trailing-catch", "side-a"));
    expect(
      await trailingSubmit(concessionIntent("trailing-concede", "trailing-concede-fact", "side-a")),
    ).toMatchObject({
      projection: { scoreByGameSide: { "side-a": 40, "side-b": 50 }, winnerGameSideId: "side-b" },
    });

    const leadingHarness = await createHarness();
    const leadingOpened = await leadingHarness.control.openController({
      qrCredential: leadingHarness.qrCredential,
      browserContext: "iqa-leading-concession",
    });
    if (leadingOpened.status !== "opened") throw new Error("Expected the Controller to open.");
    const leadingSubmit = (intent: unknown) =>
      leadingHarness.control.submitControllerIntent({
        sessionBearer: leadingOpened.session.sessionBearer,
        eventGameId: leadingHarness.root.eventGameId,
        intent,
      });
    await leadingSubmit(
      goalIntent({ operationId: "leading-a", factId: "leading-a", gameSideId: "side-a" }),
    );
    for (let index = 0; index < 4; index += 1) {
      await leadingSubmit(
        goalIntent({
          operationId: `leading-b-${index}`,
          factId: `leading-b-${index}`,
          gameSideId: "side-b",
          gameTimeMs: 20_000 + index,
        }),
      );
    }
    await leadingSubmit(flagCatchIntent("leading-catch", "leading-catch", "side-a"));
    await leadingSubmit(
      goalIntent({
        operationId: "leading-overtime-goal",
        factId: "leading-overtime-goal",
        gameSideId: "side-a",
        gameTimeMs: 1_300_000,
      }),
    );
    expect(
      await leadingSubmit(concessionIntent("leading-concede", "leading-concede-fact", "side-a")),
    ).toMatchObject({
      projection: { scoreByGameSide: { "side-a": 50, "side-b": 60 }, winnerGameSideId: "side-b" },
    });

    const doubleForfeitHarness = await createHarness();
    const doubleForfeitOpened = await doubleForfeitHarness.control.openController({
      qrCredential: doubleForfeitHarness.qrCredential,
      browserContext: "iqa-double-forfeit",
    });
    if (doubleForfeitOpened.status !== "opened")
      throw new Error("Expected the Controller to open.");
    expect(
      await doubleForfeitHarness.control.submitControllerIntent({
        sessionBearer: doubleForfeitOpened.session.sessionBearer,
        eventGameId: doubleForfeitHarness.root.eventGameId,
        intent: {
          version: LIVE_EVENT_CONTROL_INTENT_VERSION,
          type: "record-double-forfeit",
          operationId: "double-forfeit",
          factId: "double-forfeit-fact",
          gameTimeMs: 30_000,
          sportingOrder: 30_000,
          occurrence: { clientOriginAtMs: 30_000 },
        },
      }),
    ).toMatchObject({
      projection: {
        winnerGameSideId: null,
        result: { data: { resultKind: "double-forfeit" } },
        phase: "finished",
      },
    });
  });

  test("rejects concession reinstatement after its overtime catch becomes ineffective", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "iqa-concession-reinstatement-precondition",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const submit = (intent: unknown) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
      });
    for (let index = 0; index < 3; index += 1) {
      await submit(
        goalIntent({
          operationId: `concession-precondition-goal-${index}`,
          factId: `concession-precondition-goal-${index}`,
          gameSideId: "side-b",
          gameTimeMs: 10_000 + index,
        }),
      );
    }
    await submit(
      flagCatchIntent("concession-precondition-catch", "concession-precondition-catch", "side-a"),
    );
    expect(
      await submit(
        concessionIntent(
          "concession-precondition-result",
          "concession-precondition-result",
          "side-a",
        ),
      ),
    ).toMatchObject({ status: "accepted", projection: { phase: "finished" } });
    expect(
      await submit(
        correctionIntent(
          "concession-precondition-disable-result",
          "concession-precondition-disable-result",
          false,
          "concession-precondition-result",
        ),
      ),
    ).toMatchObject({ status: "accepted", projection: { overtime: true, phase: "in-progress" } });
    expect(
      await submit(
        correctionIntent(
          "concession-precondition-disable-catch",
          "concession-precondition-disable-catch",
          false,
          "concession-precondition-catch",
        ),
      ),
    ).toMatchObject({ status: "accepted", projection: { overtime: false, catch: null } });

    const beforeReinstatement = await harness.record.readActions();
    expect(
      await submit(
        correctionIntent(
          "concession-precondition-reinstate-result",
          "concession-precondition-reinstate-result",
          true,
          "concession-precondition-result",
        ),
      ),
    ).toMatchObject({ status: "rejected" });
    expect(await harness.record.readActions()).toHaveLength(beforeReinstatement.length);
    expect(
      await harness.control.refreshController({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
      }),
    ).toMatchObject({
      projection: {
        scoreByGameSide: { "side-a": 0, "side-b": 30 },
        overtime: false,
        catch: null,
        result: null,
        phase: "in-progress",
        gameFacts: [
          expect.anything(),
          expect.anything(),
          expect.anything(),
          expect.objectContaining({ factId: "concession-precondition-catch", effective: false }),
          expect.objectContaining({ factId: "concession-precondition-result", effective: false }),
        ],
      },
    });
  });

  test("rejects generic result reinstatement during unfinished overtime", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "iqa-generic-result-reinstatement",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const submit = (intent: unknown) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
      });
    expect(await submit(substantiveIntent("early-generic-result", "result"))).toMatchObject({
      status: "accepted",
    });
    expect(
      await submit(
        correctionIntent(
          "disable-early-generic-result",
          "disable-early-generic-result-fact",
          false,
          "fact-early-generic-result",
        ),
      ),
    ).toMatchObject({ status: "accepted" });
    for (let index = 0; index < 3; index += 1) {
      await submit(
        goalIntent({
          operationId: `generic-result-goal-${index}`,
          factId: `generic-result-goal-${index}`,
          gameSideId: "side-b",
          gameTimeMs: 10_000 + index,
        }),
      );
    }
    expect(
      await submit(flagCatchIntent("generic-result-catch", "generic-result-catch", "side-a")),
    ).toMatchObject({ projection: { overtime: true, phase: "in-progress" } });
    const beforeReinstatement = await harness.record.readActions();
    expect(
      await submit(
        correctionIntent(
          "reinstate-early-generic-result",
          "reinstate-early-generic-result-fact",
          true,
          "fact-early-generic-result",
        ),
      ),
    ).toMatchObject({ status: "rejected" });
    expect(await harness.record.readActions()).toHaveLength(beforeReinstatement.length);
  });

  test("rejects score overflow before durable acceptance", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "iqa-score-bound",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const submit = (intent: unknown) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
      });
    for (let index = 0; index < 100; index += 1) {
      harness.setNow(11_000 + index * 1_000);
      expect(
        await submit(
          goalIntent({
            operationId: `bound-${index}`,
            factId: `bound-fact-${index}`,
            gameTimeMs: index + 1,
          }),
        ),
      ).toMatchObject({ status: "accepted" });
    }
    expect(
      await submit(
        goalIntent({ operationId: "bound-over", factId: "bound-over-fact", gameTimeMs: 101 }),
      ),
    ).toMatchObject({ status: "rejected" });
    expect(await submit(flagCatchIntent("catch-over", "catch-over-fact", "side-a"))).toMatchObject({
      status: "rejected",
    });
    expect(
      await submit(concessionIntent("concession-over", "concession-over-fact", "side-a")),
    ).toMatchObject({ status: "rejected" });
    expect((await harness.record.readActions()).length).toBe(100);
  });

  test("rejects a correction reinstatement that would overflow without losing projection state", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "iqa-correction-score-bound",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const submit = (intent: unknown) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
      });

    await submit(
      goalIntent({
        operationId: "correction-boundary-goal",
        factId: "correction-boundary-goal",
        gameTimeMs: 1_000,
      }),
    );
    expect(
      await submit(
        correctionIntent(
          "correction-boundary-disable",
          "correction-boundary-disable-fact",
          false,
          "correction-boundary-goal",
        ),
      ),
    ).toMatchObject({ status: "accepted" });
    for (let index = 0; index < 96; index += 1) {
      harness.setNow(20_000 + index * 1_000);
      expect(
        await submit(
          goalIntent({
            operationId: `correction-bound-${index}`,
            factId: `correction-bound-fact-${index}`,
            gameTimeMs: 20_000 + index,
          }),
        ),
      ).toMatchObject({ status: "accepted" });
    }
    expect(
      await submit(
        flagCatchIntent("correction-boundary-catch", "correction-boundary-catch", "side-a"),
      ),
    ).toMatchObject({ status: "accepted" });
    expect(
      await submit(
        goalIntent({
          operationId: "correction-boundary-late-goal",
          factId: "correction-boundary-late-goal",
          gameTimeMs: 1_100_000,
        }),
      ),
    ).toMatchObject({ status: "accepted" });

    const actionsBeforeReinstatement = await harness.record.readActions();
    const reinstated = await submit(
      correctionIntent(
        "correction-boundary-reinstate",
        "correction-boundary-reinstate-fact",
        true,
        "correction-boundary-goal",
      ),
    );
    expect(reinstated).toMatchObject({ status: "rejected" });
    expect(await harness.record.readActions()).toHaveLength(actionsBeforeReinstatement.length);
    const refreshed = await harness.control.refreshController({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
    });
    expect(refreshed).toMatchObject({ status: "authorized" });
    if (refreshed.status !== "authorized" || refreshed.projection === null) {
      throw new Error("Expected the retained Controller projection.");
    }
    expect(refreshed.projection.scoreByGameSide).toEqual({ "side-a": 1000, "side-b": 0 });
    expect(refreshed.projection.gameFacts).toContainEqual(
      expect.objectContaining({ factId: "correction-boundary-goal", effective: false }),
    );
  });

  test("rejects a catch whose overtime target would exceed the derived score bound", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "iqa-catch-target-bound",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const submit = (intent: unknown) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
      });
    for (let index = 0; index < 98; index += 1) {
      harness.setNow(30_000 + index * 1_000);
      expect(
        await submit(
          goalIntent({
            operationId: `catch-target-bound-${index}`,
            factId: `catch-target-bound-fact-${index}`,
            gameSideId: "side-b",
            gameTimeMs: 30_000 + index,
          }),
        ),
      ).toMatchObject({ status: "accepted" });
    }

    const rejectedCatch = await submit(
      flagCatchIntent("catch-target-bound", "catch-target-bound-fact", "side-a"),
    );
    expect(rejectedCatch).toMatchObject({ status: "rejected" });
    expect(await harness.record.readActions()).toHaveLength(98);
    const refreshed = await harness.control.refreshController({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
    });
    expect(refreshed).toMatchObject({
      projection: {
        scoreByGameSide: { "side-a": 0, "side-b": 980 },
        catch: null,
        phase: "in-progress",
      },
    });
  });

  test("accepts and replays a late pre-catch goal after a temporary finished catch", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "iqa-late-pre-catch",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const submit = (intent: unknown) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
      });
    await submit(
      goalIntent({
        operationId: "before-catch-a",
        factId: "before-catch-a",
        gameSideId: "side-b",
        gameTimeMs: 100,
      }),
    );
    await submit(
      goalIntent({
        operationId: "before-catch-b",
        factId: "before-catch-b",
        gameSideId: "side-b",
        gameTimeMs: 200,
      }),
    );
    expect(
      await submit(flagCatchIntent("temporary-catch", "temporary-catch-fact", "side-a")),
    ).toMatchObject({ projection: { phase: "finished", winnerGameSideId: "side-a" } });
    expect(
      await submit(
        goalIntent({
          operationId: "dangerous-post-catch",
          factId: "dangerous-post-catch-fact",
          gameSideId: "side-b",
          gameTimeMs: 1_300_000,
        }),
      ),
    ).toMatchObject({ status: "rejected" });
    expect(
      await submit({
        ...goalIntent({
          operationId: "late-pre-catch",
          factId: "late-pre-catch-fact",
          gameSideId: "side-b",
          gameTimeMs: 150,
        }),
        occurrence: { clientOriginAtMs: 1_301_000, source: "offline" as const },
      }),
    ).toMatchObject({
      status: "accepted",
      projection: {
        scoreByGameSide: { "side-a": 30, "side-b": 30 },
        overtime: true,
        overtimeTarget: 60,
        winnerGameSideId: null,
        phase: "in-progress",
      },
    });
    const replay = await harness.control.replayControllerActions({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      batchId: "late-pre-catch-replay",
      replicaGeneration: "late-pre-catch-generation",
      expectedGrantSessionId: opened.session.grantSessionId,
      expectedGrantVersion: opened.session.grantVersion,
      actions: [
        {
          eventGameId: harness.root.eventGameId,
          intent: {
            ...goalIntent({
              operationId: "late-pre-catch-replay-goal",
              factId: "late-pre-catch-replay-fact",
              gameSideId: "side-b",
              gameTimeMs: 175,
            }),
            occurrence: { clientOriginAtMs: 1_302_000, source: "offline" as const },
          },
          causalPredecessorIds: [],
        },
      ],
    });
    expect(replay.outcomes).toEqual([
      { operationId: "late-pre-catch-replay-goal", status: "accepted" },
    ]);
    expect(replay.projection).toMatchObject({
      scoreByGameSide: { "side-a": 30, "side-b": 40 },
      overtimeTarget: 70,
      phase: "in-progress",
    });
  });

  test("refreshes replay state for a same-batch paired late goal after a catch", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "iqa-same-batch-close-play-replay",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const replay = await harness.control.replayControllerActions({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      batchId: "same-batch-close-play-replay",
      replicaGeneration: "same-batch-close-play-generation",
      expectedGrantSessionId: opened.session.grantSessionId,
      expectedGrantVersion: opened.session.grantVersion,
      actions: [
        {
          eventGameId: harness.root.eventGameId,
          intent: goalIntent({
            operationId: "same-batch-before-catch-a",
            factId: "same-batch-before-catch-a",
            gameSideId: "side-b",
            gameTimeMs: 10_000,
          }),
          causalPredecessorIds: [],
        },
        {
          eventGameId: harness.root.eventGameId,
          intent: goalIntent({
            operationId: "same-batch-before-catch-b",
            factId: "same-batch-before-catch-b",
            gameSideId: "side-b",
            gameTimeMs: 20_000,
          }),
          causalPredecessorIds: [],
        },
        {
          eventGameId: harness.root.eventGameId,
          intent: flagCatchIntent("same-batch-catch", "same-batch-catch-fact", "side-a"),
          causalPredecessorIds: [],
        },
        {
          eventGameId: harness.root.eventGameId,
          intent: {
            ...goalIntent({
              operationId: "same-batch-late-goal",
              factId: "same-batch-late-goal-fact",
              gameSideId: "side-b",
              gameTimeMs: 1_200_000,
            }),
            sportingOrderAdjudication: {
              relatedFactId: "same-batch-catch-fact",
              relation: "before",
            },
            override: closePlayAdjudicationOverride(
              1_200_000,
              "same-batch-catch-fact",
              1_200_000,
              "before",
            ),
            occurrence: { clientOriginAtMs: 1_201_000, source: "offline" as const },
          },
          causalPredecessorIds: [],
        },
      ],
    });
    expect(replay.outcomes).toEqual([
      { operationId: "same-batch-before-catch-a", status: "accepted" },
      { operationId: "same-batch-before-catch-b", status: "accepted" },
      { operationId: "same-batch-catch", status: "accepted" },
      { operationId: "same-batch-late-goal", status: "accepted" },
    ]);
    expect(replay.projection).toMatchObject({
      scoreByGameSide: { "side-a": 30, "side-b": 30 },
      overtime: true,
      overtimeTarget: 60,
      targetScore: 60,
      winnerGameSideId: null,
      phase: "in-progress",
      gameFacts: [
        expect.objectContaining({ factId: "same-batch-before-catch-a" }),
        expect.objectContaining({ factId: "same-batch-before-catch-b" }),
        expect.objectContaining({ factId: "same-batch-late-goal-fact" }),
        expect.objectContaining({ factId: "same-batch-catch-fact" }),
      ],
    });
  });

  test("atomically reconciles durable finish lifecycle through late scoring and catch Correction", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "iqa-lifecycle-reconciliation",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const submit = (intent: unknown) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
      });
    await submit(
      goalIntent({ operationId: "lifecycle-a", factId: "lifecycle-a", gameSideId: "side-a" }),
    );
    for (let index = 0; index < 3; index += 1) {
      await submit(
        goalIntent({
          operationId: `lifecycle-b-${index}`,
          factId: `lifecycle-b-${index}`,
          gameSideId: "side-b",
          gameTimeMs: 20_000 + index,
        }),
      );
    }
    await submit(flagCatchIntent("lifecycle-catch", "lifecycle-catch-fact", "side-a"));
    expect((await harness.record.readRoot(harness.root.recordId))?.lifecycle).toMatchObject({
      phase: "finished",
      finishedAtMs: expect.any(Number),
    });

    harness.failureBoundary = "after-lifecycle";
    expect(
      await submit(
        goalIntent({
          operationId: "lifecycle-late-failed",
          factId: "lifecycle-late-failed-fact",
          gameSideId: "side-b",
          gameTimeMs: 1_100_000,
        }),
      ),
    ).toMatchObject({ status: "retryable" });
    expect((await harness.record.readRoot(harness.root.recordId))?.lifecycle.phase).toBe(
      "finished",
    );
    expect(await harness.record.readActions()).toHaveLength(5);

    harness.failureBoundary = undefined;
    const late = await submit(
      goalIntent({
        operationId: "lifecycle-late",
        factId: "lifecycle-late-fact",
        gameSideId: "side-b",
        gameTimeMs: 1_100_000,
      }),
    );
    expect(late).toMatchObject({
      projection: {
        phase: "in-progress",
        overtime: true,
        overtimeTarget: 70,
        winnerGameSideId: null,
      },
    });
    expect((await harness.record.readRoot(harness.root.recordId))?.lifecycle).toMatchObject({
      phase: "in-progress",
      finishedAtMs: null,
    });
    expect(
      await harness.control.revealControllerQr({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
      }),
    ).toMatchObject({ status: "revealed" });

    const correction = await submit(
      correctionIntent(
        "lifecycle-correct-catch",
        "lifecycle-correct-catch-fact",
        false,
        "lifecycle-catch-fact",
      ),
    );
    expect(correction).toMatchObject({ projection: { phase: "in-progress", catch: null } });
    expect((await harness.record.readRoot(harness.root.recordId))?.lifecycle).toMatchObject({
      phase: "in-progress",
      finishedAtMs: null,
    });

    expect(
      await submit(
        correctionIntent(
          "lifecycle-correct-late-goal",
          "lifecycle-correct-late-goal-fact",
          false,
          "lifecycle-late-fact",
        ),
      ),
    ).toMatchObject({ status: "accepted" });
    const reinstated = await submit(
      correctionIntent(
        "lifecycle-reinstate-catch",
        "lifecycle-reinstate-catch-fact",
        true,
        "lifecycle-catch-fact",
      ),
    );
    expect(reinstated).toMatchObject({
      projection: { phase: "finished", winnerGameSideId: "side-a" },
    });
    expect((await harness.record.readRoot(harness.root.recordId))?.lifecycle).toMatchObject({
      phase: "finished",
      finishedAtMs: expect.any(Number),
    });
  });

  test("does not re-finish a repaired Game when a corrected scoring operation is retried", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "duplicate-corrected-finish",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const submit = (intent: unknown) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
      });
    await submit(
      goalIntent({
        operationId: "duplicate-finish-goal",
        factId: "duplicate-finish-goal",
        gameSideId: "side-a",
      }),
    );
    const winningCatch = flagCatchIntent(
      "duplicate-finish-catch",
      "duplicate-finish-catch",
      "side-a",
    );
    expect(await submit(winningCatch)).toMatchObject({
      status: "accepted",
      projection: { phase: "finished", winnerGameSideId: "side-a" },
    });
    expect(
      await submit(
        correctionIntent(
          "duplicate-finish-correction",
          "duplicate-finish-correction",
          false,
          "duplicate-finish-catch",
        ),
      ),
    ).toMatchObject({ status: "accepted", projection: { phase: "in-progress", catch: null } });
    expect(await submit(winningCatch)).toMatchObject({
      status: "duplicate-accepted",
      projection: { phase: "in-progress", catch: null, winnerGameSideId: null },
    });
    expect((await harness.record.readRoot(harness.root.recordId))?.lifecycle).toMatchObject({
      phase: "in-progress",
      finishedAtMs: null,
    });
  });

  test("rejects a late pre-catch goal whose rebuilt overtime target exceeds 1,000", async () => {
    const harness = await createHarness({
      acceptanceLimits: { onlineSessionCapacity: 120, onlineEventCapacity: 120 },
    });
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "iqa-late-target-bound",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const submit = (intent: unknown) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
      });
    for (let index = 0; index < 97; index += 1) {
      expect(
        await submit(
          goalIntent({
            operationId: `late-bound-${index}`,
            factId: `late-bound-fact-${index}`,
            gameSideId: "side-b",
            gameTimeMs: 30_000 + index,
          }),
        ),
      ).toMatchObject({ status: "accepted" });
    }
    expect(
      await submit(flagCatchIntent("late-bound-catch", "late-bound-catch-fact", "side-a")),
    ).toMatchObject({ projection: { overtime: true, overtimeTarget: 1_000 } });
    const before = await harness.record.readActions();
    const lateGoal = {
      ...goalIntent({
        operationId: "late-bound-overflow",
        factId: "late-bound-overflow-fact",
        gameSideId: "side-b",
        gameTimeMs: 1_100_000,
      }),
      occurrence: { clientOriginAtMs: 1_301_000, source: "offline" as const },
    };
    expect(await submit(lateGoal)).toMatchObject({ status: "rejected" });
    expect(await harness.record.readActions()).toHaveLength(before.length);
    expect(
      await harness.control.replayControllerActions({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        batchId: "late-bound-replay",
        replicaGeneration: "late-bound-generation",
        expectedGrantSessionId: opened.session.grantSessionId,
        expectedGrantVersion: opened.session.grantVersion,
        actions: [
          { eventGameId: harness.root.eventGameId, intent: lateGoal, causalPredecessorIds: [] },
        ],
      }),
    ).toMatchObject({
      outcomes: [{ operationId: "late-bound-overflow", status: "terminally-rejected" }],
    });
    expect(await harness.record.readActions()).toHaveLength(before.length);
  });

  test("exposes stable Game Facts and rebuilds score through contextual correction and reinstatement", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "facts-and-corrections",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    expect(
      await harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: goalIntent({ gameTimeMs: 12_000 }),
      }),
    ).toMatchObject({
      status: "accepted",
      projection: {
        gameFacts: [
          expect.objectContaining({
            factId: "fact-goal",
            factType: "goal",
            effective: true,
            sportingOrder: 12_000,
            synchronizationOrder: 1,
          }),
        ],
      },
    });

    const corrected = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      causalPredecessorIds: ["operation-goal"],
      intent: correctionIntent("correction-goal", "correction-fact", false),
    });
    expect(corrected).toMatchObject({
      status: "accepted",
      projection: {
        scoreByGameSide: { "side-a": 0, "side-b": 0 },
        goalCount: 0,
        gameFacts: [expect.objectContaining({ factId: "fact-goal", effective: false })],
      },
    });

    const reinstated = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      causalPredecessorIds: ["correction-goal"],
      intent: correctionIntent("reinstate-goal", "reinstate-fact", true),
    });
    expect(reinstated).toMatchObject({
      status: "accepted",
      projection: {
        scoreByGameSide: { "side-a": 10, "side-b": 0 },
        goalCount: 1,
        gameFacts: [expect.objectContaining({ factId: "fact-goal", effective: true })],
      },
    });
    expect(await harness.record.readActions()).toHaveLength(3);
    expect((await harness.record.readActions())[1]?.action.interpretation).toMatchObject({
      type: "correction",
      targetFactId: "fact-goal",
      effective: false,
    });
  });

  test("keeps sporting order distinct from synchronization order for late Controller information", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "sporting-order",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent({
        operationId: "operation-late",
        factId: "fact-late",
        gameTimeMs: 20_000,
      }),
    });
    harness.setNow(11_000);
    const result = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent({
        operationId: "operation-early",
        factId: "fact-early",
        gameTimeMs: 10_000,
      }),
    });
    const facts = (result as unknown as { projection: { gameFacts: any[] } }).projection.gameFacts;
    const synchronizationOrders = facts.map((fact) => fact.synchronizationOrder);
    expect(synchronizationOrders[0]).toBeGreaterThan(synchronizationOrders[1] ?? 0);
    expect(facts).toMatchObject([
      expect.objectContaining({ factId: "fact-early", sportingOrder: 10_000 }),
      expect.objectContaining({ factId: "fact-late", sportingOrder: 20_000 }),
    ]);

    const unadjudicated = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...goalIntent({ operationId: "operation-unadjudicated", factId: "fact-unadjudicated" }),
        sportingOrder: 1_000,
      },
    });
    expect(unadjudicated).toMatchObject({ status: "rejected" });

    const adjudicated = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...goalIntent({ operationId: "operation-adjudicated", factId: "fact-adjudicated" }),
        sportingOrder: 1_000,
        override: {
          guardrail: "sporting-order-adjudication",
          direction: "head-referee-adjudicated-sporting-order",
          confirmation: "head-referee-confirmed",
          authorityReference: "head-referee",
          gameTimeMs: 12_000,
          beforeValue: { sportingOrder: 12_000 },
          afterValue: { sportingOrder: 1_000 },
          reason: "head-referee-direction",
        },
      },
    });
    expect(adjudicated).toMatchObject({ status: "accepted" });
    expect((await harness.record.readActions()).at(-1)?.action.override).toMatchObject({
      guardrail: "sporting-order-adjudication",
    });
  });

  test("keeps close-play order authority separate from the flag-catch boundary override", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "close-play-separate-catch-boundary",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const submit = (intent: unknown) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
      });
    await submit(
      goalIntent({
        operationId: "boundary-close-goal",
        factId: "boundary-close-goal",
        gameSideId: "side-b",
        gameTimeMs: 11_500,
      }),
    );
    const closeOrderOverride = closePlayAdjudicationOverride(
      12_000,
      "boundary-close-goal",
      11_500,
      "after",
    );
    const catchIntent = {
      ...flagCatchIntent("boundary-close-catch", "boundary-close-catch", "side-a"),
      gameTimeMs: 12_000,
      sportingOrderAdjudication: {
        relatedFactId: "boundary-close-goal",
        relation: "after" as const,
      },
    };
    expect(
      await submit({
        ...catchIntent,
        operationId: "boundary-close-catch-order-only",
        factId: "boundary-close-catch-order-only",
        override: closeOrderOverride,
      }),
    ).toMatchObject({ status: "rejected" });
    expect(await harness.record.readActions()).toHaveLength(1);

    expect(
      await submit({
        ...catchIntent,
        sportingOrderOverride: closeOrderOverride,
        override: flagCatchBoundaryOverride(12_000),
      }),
    ).toMatchObject({
      status: "accepted",
      projection: { scoreByGameSide: { "side-a": 30, "side-b": 10 } },
    });
    const storedCatch = (await harness.record.readActions()).at(-1)?.action;
    expect(storedCatch?.override).toMatchObject({
      guardrail: "flag-catch-requires-seeker-release-and-stopped-play",
    });
    expect(storedCatch?.interpretation).toMatchObject({
      type: "fact",
      payload: {
        data: {
          sportingOrderAdjudication: {
            relatedFactId: "boundary-close-goal",
            relation: "after",
          },
          sportingOrderOverride: { guardrail: "sporting-order-adjudication" },
        },
      },
    });

    const runningHarness = await createHarness();
    const runningOpened = await runningHarness.control.openController({
      qrCredential: runningHarness.qrCredential,
      browserContext: "close-play-running-catch-boundary",
    });
    if (runningOpened.status !== "opened") throw new Error("Expected the Controller to open.");
    const runningSubmit = (intent: unknown) =>
      runningHarness.control.submitControllerIntent({
        sessionBearer: runningOpened.session.sessionBearer,
        eventGameId: runningHarness.root.eventGameId,
        intent,
      });
    await runningSubmit(clockIntent("running-boundary-clock", true));
    await runningSubmit(
      goalIntent({
        operationId: "running-boundary-goal",
        factId: "running-boundary-goal",
        gameSideId: "side-b",
        gameTimeMs: 1_199_500,
      }),
    );
    expect(
      await runningSubmit({
        ...flagCatchIntent("running-boundary-catch", "running-boundary-catch", "side-a"),
        sportingOrderAdjudication: {
          relatedFactId: "running-boundary-goal",
          relation: "after",
        },
        override: closePlayAdjudicationOverride(
          1_200_000,
          "running-boundary-goal",
          1_199_500,
          "after",
        ),
      }),
    ).toMatchObject({ status: "rejected" });
    expect(await runningHarness.record.readActions()).toHaveLength(2);
  });

  test("rejects a second effective catch before considering a boundary override", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "second-catch-boundary-override",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const submit = (intent: unknown) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
      });
    for (let index = 0; index < 3; index += 1) {
      await submit(
        goalIntent({
          operationId: `second-catch-goal-${index}`,
          factId: `second-catch-goal-${index}`,
          gameSideId: "side-b",
          gameTimeMs: 100_000 + index * 100_000,
        }),
      );
    }
    expect(
      await submit(flagCatchIntent("first-effective-catch", "first-effective-catch", "side-a")),
    ).toMatchObject({ status: "accepted", projection: { overtime: true, phase: "in-progress" } });
    const beforeSecondCatch = await harness.record.readActions();
    expect(
      await submit({
        ...flagCatchIntent("second-effective-catch", "second-effective-catch", "side-a"),
        gameTimeMs: 12_000,
        override: flagCatchBoundaryOverride(12_000),
      }),
    ).toMatchObject({ status: "rejected" });
    expect(await harness.record.readActions()).toHaveLength(beforeSecondCatch.length);

    expect(
      await submit(
        correctionIntent(
          "correct-first-effective-catch",
          "correct-first-effective-catch-fact",
          false,
          "first-effective-catch",
        ),
      ),
    ).toMatchObject({ status: "accepted" });
    expect(
      await submit(
        flagCatchIntent("replacement-effective-catch", "replacement-effective-catch", "side-a"),
      ),
    ).toMatchObject({ status: "accepted" });
    const beforeReinstatement = await harness.record.readActions();
    expect(
      await submit(
        correctionIntent(
          "reinstate-first-effective-catch",
          "reinstate-first-effective-catch-fact",
          true,
          "first-effective-catch",
        ),
      ),
    ).toMatchObject({ status: "rejected" });
    expect(await harness.record.readActions()).toHaveLength(beforeReinstatement.length);
  });

  test("requires Head Referee order for close-play goal and catch and follows the chosen order", async () => {
    const createClosePlayHarness = async (browserContext: string) => {
      const harness = await createHarness();
      const opened = await harness.control.openController({
        qrCredential: harness.qrCredential,
        browserContext,
      });
      if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
      return { harness, sessionBearer: opened.session.sessionBearer };
    };
    const closePlayGameTime = 1_200_000;
    const relatedGameTime = closePlayGameTime - 500;

    const afterOrder = await createClosePlayHarness("close-play-after");
    const submitAfter = (intent: unknown) =>
      afterOrder.harness.control.submitControllerIntent({
        sessionBearer: afterOrder.sessionBearer,
        eventGameId: afterOrder.harness.root.eventGameId,
        intent,
      });
    await submitAfter(
      goalIntent({
        operationId: "close-play-before-1",
        factId: "close-play-before-1",
        gameSideId: "side-b",
        gameTimeMs: 10_000,
      }),
    );
    await submitAfter(
      goalIntent({
        operationId: "close-play-before-2",
        factId: "close-play-before-2",
        gameSideId: "side-b",
        gameTimeMs: 20_000,
      }),
    );
    await submitAfter(
      goalIntent({
        operationId: "close-play-goal",
        factId: "close-play-goal",
        gameSideId: "side-b",
        gameTimeMs: relatedGameTime,
      }),
    );
    expect(
      await submitAfter(
        flagCatchIntent(
          "close-play-catch-unadjudicated",
          "close-play-catch-unadjudicated",
          "side-a",
        ),
      ),
    ).toMatchObject({ status: "rejected" });
    expect(await afterOrder.harness.record.readActions()).toHaveLength(3);
    expect(
      await submitAfter({
        ...flagCatchIntent("close-play-catch-after", "close-play-catch-after", "side-a"),
        sportingOrderAdjudication: {
          relatedFactId: "close-play-goal",
          relation: "after",
        },
        override: closePlayAdjudicationOverride(
          closePlayGameTime,
          "close-play-goal",
          relatedGameTime,
          "after",
        ),
      }),
    ).toMatchObject({
      status: "accepted",
      projection: {
        scoreByGameSide: { "side-a": 30, "side-b": 30 },
        overtime: true,
        overtimeTarget: 60,
        winnerGameSideId: null,
        phase: "in-progress",
      },
    });

    const beforeOrder = await createClosePlayHarness("close-play-before");
    const submitBefore = (intent: unknown) =>
      beforeOrder.harness.control.submitControllerIntent({
        sessionBearer: beforeOrder.sessionBearer,
        eventGameId: beforeOrder.harness.root.eventGameId,
        intent,
      });
    await submitBefore(
      goalIntent({
        operationId: "close-play-before-order-1",
        factId: "close-play-before-order-1",
        gameSideId: "side-b",
        gameTimeMs: 10_000,
      }),
    );
    await submitBefore(
      goalIntent({
        operationId: "close-play-before-order-2",
        factId: "close-play-before-order-2",
        gameSideId: "side-b",
        gameTimeMs: 20_000,
      }),
    );
    await submitBefore(
      goalIntent({
        operationId: "close-play-before-order-goal",
        factId: "close-play-before-order-goal",
        gameSideId: "side-b",
        gameTimeMs: relatedGameTime,
      }),
    );
    expect(
      await submitBefore({
        ...flagCatchIntent("close-play-catch-before", "close-play-catch-before", "side-a"),
        sportingOrderAdjudication: {
          relatedFactId: "close-play-before-order-goal",
          relation: "before",
        },
        override: closePlayAdjudicationOverride(
          closePlayGameTime,
          "close-play-before-order-goal",
          relatedGameTime,
          "before",
        ),
      }),
    ).toMatchObject({
      status: "accepted",
      projection: {
        scoreByGameSide: { "side-a": 30, "side-b": 30 },
        overtime: false,
        overtimeTarget: null,
        winnerGameSideId: "side-a",
        phase: "finished",
      },
    });
  });

  test("selects one close goal across goals-first and catch-first replay permutations", async () => {
    const catchGameTimeMs = 1_200_000;
    const pairedGoalTimeMs = 1_199_500;
    const unrelatedGoalTimeMs = 1_199_750;
    const expectedOrder = [
      "multi-close-catch",
      "multi-close-unrelated-goal",
      "multi-close-paired-goal",
    ];

    const goalsFirst = await createHarness();
    const goalsFirstOpened = await goalsFirst.control.openController({
      qrCredential: goalsFirst.qrCredential,
      browserContext: "multi-close-goals-first",
    });
    if (goalsFirstOpened.status !== "opened") throw new Error("Expected the Controller to open.");
    const submitGoalsFirst = (intent: unknown) =>
      goalsFirst.control.submitControllerIntent({
        sessionBearer: goalsFirstOpened.session.sessionBearer,
        eventGameId: goalsFirst.root.eventGameId,
        intent,
      });
    await submitGoalsFirst(
      goalIntent({
        operationId: "multi-close-paired-goal",
        factId: "multi-close-paired-goal",
        gameSideId: "side-b",
        gameTimeMs: pairedGoalTimeMs,
      }),
    );
    await submitGoalsFirst(
      goalIntent({
        operationId: "multi-close-unrelated-goal",
        factId: "multi-close-unrelated-goal",
        gameSideId: "side-b",
        gameTimeMs: unrelatedGoalTimeMs,
      }),
    );
    expect(
      await submitGoalsFirst({
        ...flagCatchIntent("multi-close-ambiguous", "multi-close-ambiguous", "side-a"),
        gameTimeMs: catchGameTimeMs,
      }),
    ).toMatchObject({ status: "rejected" });
    const goalsFirstResult = await submitGoalsFirst({
      ...flagCatchIntent("multi-close-catch", "multi-close-catch", "side-a"),
      sportingOrderAdjudication: {
        relatedFactId: "multi-close-paired-goal",
        relation: "before",
      },
      override: closePlayAdjudicationOverride(
        catchGameTimeMs,
        "multi-close-paired-goal",
        pairedGoalTimeMs,
        "before",
      ),
    });
    expect(goalsFirstResult).toMatchObject({
      status: "accepted",
      projection: {
        scoreByGameSide: { "side-a": 30, "side-b": 20 },
        overtime: false,
        overtimeTarget: null,
        winnerGameSideId: "side-a",
        phase: "finished",
      },
    });
    if (
      goalsFirstResult.status !== "accepted" ||
      goalsFirstResult.projection?.gameFacts === undefined
    ) {
      throw new Error("Expected the goals-first projection.");
    }
    expect(
      goalsFirstResult.projection.gameFacts
        .filter((fact) => fact.effective)
        .map((fact) => fact.factId),
    ).toEqual(expectedOrder);

    const catchFirst = await createHarness();
    const catchFirstOpened = await catchFirst.control.openController({
      qrCredential: catchFirst.qrCredential,
      browserContext: "multi-close-catch-first-replay",
    });
    if (catchFirstOpened.status !== "opened") throw new Error("Expected the Controller to open.");
    const catchFirstReplay = await catchFirst.control.replayControllerActions({
      sessionBearer: catchFirstOpened.session.sessionBearer,
      eventGameId: catchFirst.root.eventGameId,
      batchId: "multi-close-catch-first-batch",
      replicaGeneration: "multi-close-catch-first-generation",
      expectedGrantSessionId: catchFirstOpened.session.grantSessionId,
      expectedGrantVersion: catchFirstOpened.session.grantVersion,
      actions: [
        {
          eventGameId: catchFirst.root.eventGameId,
          intent: flagCatchIntent("multi-close-catch", "multi-close-catch", "side-a"),
          causalPredecessorIds: [],
        },
        {
          eventGameId: catchFirst.root.eventGameId,
          intent: {
            ...goalIntent({
              operationId: "multi-close-paired-goal",
              factId: "multi-close-paired-goal",
              gameSideId: "side-b",
              gameTimeMs: pairedGoalTimeMs,
            }),
            sportingOrderAdjudication: {
              relatedFactId: "multi-close-catch",
              relation: "after",
            },
            override: closePlayAdjudicationOverride(
              pairedGoalTimeMs,
              "multi-close-catch",
              catchGameTimeMs,
              "after",
            ),
            occurrence: { clientOriginAtMs: catchGameTimeMs + 1, source: "offline" as const },
          },
          causalPredecessorIds: [],
        },
        {
          eventGameId: catchFirst.root.eventGameId,
          intent: {
            ...goalIntent({
              operationId: "multi-close-unrelated-goal",
              factId: "multi-close-unrelated-goal",
              gameSideId: "side-b",
              gameTimeMs: unrelatedGoalTimeMs,
            }),
            occurrence: { clientOriginAtMs: catchGameTimeMs + 2, source: "offline" as const },
          },
          causalPredecessorIds: [],
        },
      ],
    });
    expect(catchFirstReplay).toMatchObject({
      outcomes: [
        { operationId: "multi-close-catch", status: "accepted" },
        { operationId: "multi-close-paired-goal", status: "accepted" },
        { operationId: "multi-close-unrelated-goal", status: "accepted" },
      ],
      projection: {
        scoreByGameSide: { "side-a": 30, "side-b": 20 },
        overtime: false,
        overtimeTarget: null,
        winnerGameSideId: "side-a",
        phase: "finished",
      },
    });
    expect(
      catchFirstReplay.projection?.gameFacts
        ?.filter((fact) => fact.effective)
        .map((fact) => fact.factId),
    ).toEqual(expectedOrder);
  });

  test("rejects unknown, non-close, and conflicting explicit close-play pair evidence", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "multi-close-invalid-pair-evidence",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const submit = (intent: unknown) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
      });
    await submit(
      goalIntent({
        operationId: "invalid-pair-close-goal",
        factId: "invalid-pair-close-goal",
        gameSideId: "side-b",
        gameTimeMs: 1_199_500,
      }),
    );
    await submit(
      goalIntent({
        operationId: "invalid-pair-far-goal",
        factId: "invalid-pair-far-goal",
        gameSideId: "side-b",
        gameTimeMs: 1_100_000,
      }),
    );
    const invalidCatch = (
      operationId: string,
      relatedFactId: string,
      relatedGameTimeMs: number,
    ) => ({
      ...flagCatchIntent(operationId, operationId, "side-a"),
      sportingOrderAdjudication: { relatedFactId, relation: "before" as const },
      override: closePlayAdjudicationOverride(
        1_200_000,
        relatedFactId,
        relatedGameTimeMs,
        "before",
      ),
    });
    expect(
      await submit(invalidCatch("invalid-pair-unknown", "unknown-goal", 1_199_500)),
    ).toMatchObject({
      status: "rejected",
    });
    expect(
      await submit(invalidCatch("invalid-pair-non-close", "invalid-pair-far-goal", 1_100_000)),
    ).toMatchObject({ status: "rejected" });
    expect(
      await submit(
        invalidCatch("invalid-pair-accepted-catch", "invalid-pair-close-goal", 1_199_500),
      ),
    ).toMatchObject({ status: "accepted" });
    expect(
      await submit({
        ...goalIntent({
          operationId: "invalid-pair-conflicting-goal",
          factId: "invalid-pair-conflicting-goal",
          gameSideId: "side-b",
          gameTimeMs: 1_199_750,
        }),
        sportingOrderAdjudication: {
          relatedFactId: "invalid-pair-accepted-catch",
          relation: "before",
        },
        override: closePlayAdjudicationOverride(
          1_199_750,
          "invalid-pair-accepted-catch",
          1_200_000,
          "before",
        ),
      }),
    ).toMatchObject({ status: "rejected" });
    expect(await harness.record.readActions()).toHaveLength(3);
  });

  test("swaps only an adjudicated pair around unrelated endpoint facts across replay", async () => {
    const closePlayGameTime = 1_200_000;
    const relatedGameTime = closePlayGameTime - 500;
    const submitScenario = async (unrelatedGameTime: number, browserContext: string) => {
      const harness = await createHarness();
      const opened = await harness.control.openController({
        qrCredential: harness.qrCredential,
        browserContext,
      });
      if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
      const submit = (intent: unknown) =>
        harness.control.submitControllerIntent({
          sessionBearer: opened.session.sessionBearer,
          eventGameId: harness.root.eventGameId,
          intent,
        });
      await submit(
        goalIntent({
          operationId: `${browserContext}-goal`,
          factId: `${browserContext}-goal`,
          gameSideId: "side-b",
          gameTimeMs: relatedGameTime,
        }),
      );
      await submit(substantiveIntent(`${browserContext}-card`, "card", unrelatedGameTime));
      const caught = await submit({
        ...flagCatchIntent(`${browserContext}-catch`, `${browserContext}-catch`, "side-a"),
        sportingOrderAdjudication: {
          relatedFactId: `${browserContext}-goal`,
          relation: "before",
        },
        override: closePlayAdjudicationOverride(
          closePlayGameTime,
          `${browserContext}-goal`,
          relatedGameTime,
          "before",
        ),
      });
      expect(caught).toMatchObject({
        projection: { phase: "finished", winnerGameSideId: "side-a" },
      });
      return caught;
    };

    for (const [unrelatedGameTime, browserContext] of [
      [relatedGameTime, "close-play-lower-endpoint"],
      [closePlayGameTime, "close-play-upper-endpoint"],
    ] as const) {
      const caught = await submitScenario(unrelatedGameTime, browserContext);
      const expectedFactTypes =
        unrelatedGameTime === relatedGameTime
          ? (["card", "flag-catch", "goal"] as const)
          : (["flag-catch", "card", "goal"] as const);
      expect(caught).toMatchObject({
        projection: {
          gameFacts: expectedFactTypes.map((factType) =>
            expect.objectContaining({
              factType,
              gameTimeMs:
                factType === "card"
                  ? unrelatedGameTime
                  : factType === "goal"
                    ? relatedGameTime
                    : closePlayGameTime,
            }),
          ),
        },
      });
    }

    const replayHarness = await createHarness();
    const replayOpened = await replayHarness.control.openController({
      qrCredential: replayHarness.qrCredential,
      browserContext: "close-play-reordered-replay",
    });
    if (replayOpened.status !== "opened") throw new Error("Expected the Controller to open.");
    const submitReplaySetup = (intent: unknown) =>
      replayHarness.control.submitControllerIntent({
        sessionBearer: replayOpened.session.sessionBearer,
        eventGameId: replayHarness.root.eventGameId,
        intent,
      });
    await submitReplaySetup(substantiveIntent("close-play-replay-card", "card", closePlayGameTime));
    await submitReplaySetup(
      goalIntent({
        operationId: "close-play-replay-goal",
        factId: "close-play-replay-goal",
        gameSideId: "side-b",
        gameTimeMs: relatedGameTime,
      }),
    );
    const replay = await replayHarness.control.replayControllerActions({
      sessionBearer: replayOpened.session.sessionBearer,
      eventGameId: replayHarness.root.eventGameId,
      batchId: "close-play-reordered-batch",
      replicaGeneration: "close-play-reordered-generation",
      expectedGrantSessionId: replayOpened.session.grantSessionId,
      expectedGrantVersion: replayOpened.session.grantVersion,
      actions: [
        {
          eventGameId: replayHarness.root.eventGameId,
          intent: {
            ...flagCatchIntent("close-play-replay-catch", "close-play-replay-catch", "side-a"),
            sportingOrderAdjudication: {
              relatedFactId: "close-play-replay-goal",
              relation: "before",
            },
            override: closePlayAdjudicationOverride(
              closePlayGameTime,
              "close-play-replay-goal",
              relatedGameTime,
              "before",
            ),
            occurrence: { clientOriginAtMs: closePlayGameTime, source: "offline" as const },
          },
          causalPredecessorIds: [],
        },
      ],
    });
    expect(replay).toMatchObject({
      outcomes: [{ operationId: "close-play-replay-catch", status: "accepted" }],
      projection: {
        phase: "finished",
        winnerGameSideId: "side-a",
        gameFacts: [
          expect.objectContaining({ factType: "flag-catch", gameTimeMs: closePlayGameTime }),
          expect.objectContaining({ factType: "card", gameTimeMs: closePlayGameTime }),
          expect.objectContaining({ factType: "goal", gameTimeMs: relatedGameTime }),
        ],
      },
    });
    const refreshed = await replayHarness.control.refreshController({
      sessionBearer: replayOpened.session.sessionBearer,
      eventGameId: replayHarness.root.eventGameId,
    });
    expect(refreshed).toMatchObject({
      projection: {
        gameFacts: [
          expect.objectContaining({ factType: "flag-catch", gameTimeMs: closePlayGameTime }),
          expect.objectContaining({ factType: "card", gameTimeMs: closePlayGameTime }),
          expect.objectContaining({ factType: "goal", gameTimeMs: relatedGameTime }),
        ],
      },
    });
  });

  test("does not move a surviving endpoint across unrelated facts after correction and reinstatement", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "close-play-corrected-endpoint-order",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const submit = (intent: unknown) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
      });
    await submit(
      goalIntent({
        operationId: "corrected-endpoint-goal",
        factId: "corrected-endpoint-goal",
        gameSideId: "side-b",
        gameTimeMs: 1_199_500,
      }),
    );
    await submit(substantiveIntent("corrected-endpoint-card", "card", 1_200_000));
    expect(
      await submit({
        ...flagCatchIntent("corrected-endpoint-catch", "corrected-endpoint-catch", "side-a"),
        gameTimeMs: 1_200_000,
        sportingOrderAdjudication: {
          relatedFactId: "corrected-endpoint-goal",
          relation: "before",
        },
        override: closePlayAdjudicationOverride(
          1_200_000,
          "corrected-endpoint-goal",
          1_199_500,
          "before",
        ),
      }),
    ).toMatchObject({ projection: { phase: "finished", winnerGameSideId: "side-a" } });

    const corrected = await submit(
      correctionIntent(
        "corrected-endpoint-disable-catch",
        "corrected-endpoint-disable-catch",
        false,
        "corrected-endpoint-catch",
      ),
    );
    expect(corrected).toMatchObject({
      projection: {
        scoreByGameSide: { "side-a": 0, "side-b": 10 },
        phase: "in-progress",
        winnerGameSideId: null,
      },
    });
    if (corrected.status !== "accepted" || corrected.projection === null) {
      throw new Error("Expected the corrected projection.");
    }
    if (corrected.projection.gameFacts === undefined) {
      throw new Error("Expected corrected Game Facts.");
    }
    expect(
      corrected.projection.gameFacts.filter((fact) => fact.effective).map((fact) => fact.factId),
    ).toEqual(["corrected-endpoint-goal", "fact-corrected-endpoint-card"]);

    const reinstated = await submit(
      correctionIntent(
        "corrected-endpoint-reinstate-catch",
        "corrected-endpoint-reinstate-catch",
        true,
        "corrected-endpoint-catch",
      ),
    );
    expect(reinstated).toMatchObject({
      projection: {
        scoreByGameSide: { "side-a": 30, "side-b": 10 },
        phase: "finished",
        winnerGameSideId: "side-a",
      },
    });
    if (reinstated.status !== "accepted" || reinstated.projection === null) {
      throw new Error("Expected the reinstated projection.");
    }
    if (reinstated.projection.gameFacts === undefined) {
      throw new Error("Expected reinstated Game Facts.");
    }
    expect(
      reinstated.projection.gameFacts.filter((fact) => fact.effective).map((fact) => fact.factId),
    ).toEqual([
      "corrected-endpoint-catch",
      "fact-corrected-endpoint-card",
      "corrected-endpoint-goal",
    ]);
  });

  test("rejects a catch reinstatement that creates an unresolved close pair", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "close-play-correction-reinstatement",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const submit = (intent: unknown) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
      });
    await submit(flagCatchIntent("unpaired-catch", "unpaired-catch-fact", "side-a"));
    expect(
      await submit(
        correctionIntent("disable-catch", "disable-catch-fact", false, "unpaired-catch-fact"),
      ),
    ).toMatchObject({ status: "accepted", projection: { catch: null, phase: "in-progress" } });
    expect(
      await submit(
        goalIntent({
          operationId: "close-goal-after-correction",
          factId: "close-goal-after-correction-fact",
          gameSideId: "side-b",
          gameTimeMs: 1_199_500,
        }),
      ),
    ).toMatchObject({ status: "accepted", projection: { catch: null } });
    const beforeReinstatement = await harness.record.readActions();
    expect(
      await submit(
        correctionIntent(
          "reinstate-unpaired-catch",
          "reinstate-unpaired-catch-fact",
          true,
          "unpaired-catch-fact",
        ),
      ),
    ).toMatchObject({ status: "rejected" });
    expect(await harness.record.readActions()).toHaveLength(beforeReinstatement.length);
    expect(
      await harness.control.refreshController({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
      }),
    ).toMatchObject({ projection: { catch: null, phase: "in-progress" } });
  });

  test("accepts an equal-time late goal only with explicit paired sporting order", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "close-play-equal-time-late-goal",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const submit = (intent: unknown) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
      });
    await submit(flagCatchIntent("equal-time-catch", "equal-time-catch-fact", "side-a"));
    expect(
      await submit(
        goalIntent({
          operationId: "equal-time-unrelated-late-goal",
          factId: "equal-time-unrelated-late-goal-fact",
          gameSideId: "side-b",
          gameTimeMs: 1_200_000,
        }),
      ),
    ).toMatchObject({ status: "rejected" });
    const accepted = await submit({
      ...goalIntent({
        operationId: "equal-time-adjudicated-late-goal",
        factId: "equal-time-adjudicated-late-goal-fact",
        gameSideId: "side-b",
        gameTimeMs: 1_200_000,
      }),
      sportingOrderAdjudication: {
        relatedFactId: "equal-time-catch-fact",
        relation: "before",
      },
      override: closePlayAdjudicationOverride(
        1_200_000,
        "equal-time-catch-fact",
        1_200_000,
        "before",
      ),
      occurrence: { clientOriginAtMs: 1_201_000, source: "offline" as const },
    });
    expect(accepted).toMatchObject({
      status: "accepted",
      projection: {
        phase: "finished",
        winnerGameSideId: "side-a",
        gameFacts: [
          expect.objectContaining({
            factId: "equal-time-adjudicated-late-goal-fact",
            gameTimeMs: 1_200_000,
          }),
          expect.objectContaining({ factId: "equal-time-catch-fact", gameTimeMs: 1_200_000 }),
        ],
      },
    });
  });

  test("rebuilds penalty, timeout, stoppage, heat, and result state through Corrections", async () => {
    const harness = await createHarness({ knownDodgeballIds: ["ball-1"] });
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "dependent-state-corrections",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    const submit = (intent: unknown) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
      });
    await submit(clockIntent("dependent-clock-start", true));
    harness.setNow(11_000);
    await submit(
      cardIntent({ operationId: "card-state", factId: "fact-card-state", gameTimeMs: 0 }),
    );
    harness.setNow(12_000);
    const pausedState = await submit(clockIntent("dependent-clock-pause", false));
    if (pausedState.status !== "accepted" || pausedState.projection === null) {
      throw new Error("Expected the paused projection.");
    }
    await submit({
      ...substantiveIntent("timeout-stoppage-state", "timeout"),
      timeoutAction: "stoppage",
      timeoutGameSideId: "side-a",
    });
    await submit({
      ...substantiveIntent("timeout-state", "timeout"),
      timeoutAction: "start",
      timeoutGameSideId: "side-a",
    });
    await submit({
      ...substantiveIntent("suspension-state", "suspension"),
      suspensionAction: "start",
      suspensionSnapshot: {
        version: LIVE_SUSPENSION_SNAPSHOT_VERSION,
        gameTimeMs: pausedState.projection.clock.gameTimeMs,
        scoreByGameSide: pausedState.projection.scoreByGameSide,
        penalties: suspensionPenaltyStateFromProjection(pausedState.projection.penalties!),
        volleyballPossession: "side-a",
        dodgeballPossession: { "ball-1": "side-a" },
      },
    });
    await submit({
      ...substantiveIntent("heat-state", "heat-stoppage"),
      heatAction: "start",
    });
    await submit(substantiveIntent("result-state", "result"));

    const finished = await harness.control.refreshController({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
    });
    expect(finished).toMatchObject({
      projection: {
        phase: "finished",
        timeout: { status: "started", factId: "fact-timeout-state" },
        stoppage: { status: "suspension", factId: "fact-suspension-state" },
        heat: { status: "started", factId: "fact-heat-state" },
        result: { factId: "fact-result-state" },
      },
    });
    if (finished.status !== "authorized" || finished.projection === null) {
      throw new Error("Expected the finished Controller projection.");
    }
    expect(finished.projection.clock.activePenaltyTimeMs).toBe(0);

    await submit(
      correctionIntent("correct-card-state", "correction-card-state", false, "fact-card-state"),
    );
    await submit(
      correctionIntent(
        "correct-timeout-state",
        "correction-timeout-state",
        false,
        "fact-timeout-state",
      ),
    );
    await submit(
      correctionIntent(
        "correct-timeout-stoppage-state",
        "correction-timeout-stoppage-state",
        false,
        "fact-timeout-stoppage-state",
      ),
    );
    await submit(
      correctionIntent(
        "correct-suspension-state",
        "correction-suspension-state",
        false,
        "fact-suspension-state",
      ),
    );
    await submit(
      correctionIntent("correct-heat-state", "correction-heat-state", false, "fact-heat-state"),
    );
    const corrected = await submit(
      correctionIntent(
        "correct-result-state",
        "correction-result-state",
        false,
        "fact-result-state",
      ),
    );
    expect(corrected).toMatchObject({
      status: "accepted",
      projection: {
        phase: "in-progress",
        timeout: { status: "inactive", factId: null },
        stoppage: { status: "none", factId: null },
        heat: { status: "inactive", factId: null },
        result: null,
      },
    });
    if (corrected.status !== "accepted" || corrected.projection === null) {
      throw new Error("Expected the corrected Controller projection.");
    }
    expect(corrected.projection.clock.activePenaltyTimeMs).toBe(0);

    const continued = await submit(
      goalIntent({ operationId: "post-result-goal", factId: "fact-post-result" }),
    );
    expect(continued).toMatchObject({
      status: "accepted",
      projection: {
        phase: "in-progress",
        scoreByGameSide: { "side-a": 10, "side-b": 0 },
      },
    });

    const reinstated = await submit(
      correctionIntent(
        "reinstate-result-state",
        "reinstate-result-state",
        true,
        "fact-result-state",
      ),
    );
    expect(reinstated).toMatchObject({
      status: "accepted",
      projection: {
        phase: "finished",
        result: { factId: "fact-result-state" },
      },
    });
  });

  test("records explainable Head Referee Official Override evidence and rejects clock misclassification", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "official-override",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    const running = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: clockIntent("timeout-running", true),
    });
    expect(running).toMatchObject({ status: "accepted" });

    const normalTimeout = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: substantiveIntent("timeout-without-override", "timeout"),
    });
    expect(normalTimeout).toMatchObject({ status: "rejected" });

    const overridden = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...substantiveIntent("timeout-override", "timeout"),
        gameTimeMs: 15_000,
        override: {
          guardrail: "timeout-requires-paused-play",
          direction: "head-referee-directed-timeout-while-running",
          confirmation: "head-referee-confirmed",
          authorityReference: "head-referee",
          gameTimeMs: 15_000,
          reason: "head-referee-direction",
          beforeValue: { running: true },
          afterValue: { timeout: "stoppage" },
        },
      },
    });
    expect(overridden).toMatchObject({ status: "accepted" });
    const acceptedAction = (await harness.record.readActions())[1]?.action;
    expect(acceptedAction?.override).toMatchObject({
      guardrail: "timeout-requires-paused-play",
      confirmation: "head-referee-confirmed",
      authorityReference: "head-referee",
      reason: "head-referee-direction",
      beforeValue: { running: true },
      afterValue: { timeout: "stoppage" },
    });
    expect(acceptedAction?.grant.sessionId).toBe(opened.session.grantSessionId);

    const invalidEvidence = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...substantiveIntent("timeout-invalid-evidence", "timeout"),
        override: {
          guardrail: "timeout-requires-paused-play",
          direction: "head-referee-directed-timeout-while-running",
          confirmation: "head-referee-confirmed",
          authorityReference: "head-referee",
          gameTimeMs: 0,
          reason: "head-referee-direction",
          beforeValue: { running: false },
          afterValue: { timeout: "stoppage" },
        },
      },
    });
    expect(invalidEvidence).toMatchObject({ status: "rejected" });

    const validHeat = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...substantiveIntent("heat-skip", "result"),
        trigger: "heat-stoppage",
        heatAction: "skip-required",
      },
    });
    expect(validHeat).toMatchObject({ status: "accepted" });
    expect((await harness.record.readActions())[2]?.action.override).toBeUndefined();

    const fabricatedHeatOverride = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...substantiveIntent("fabricated-heat-override", "heat-stoppage"),
        heatAction: "skip-required",
        override: {
          guardrail: "heat-stoppage-rule-deviation",
          direction: "head-referee-directed-heat-stoppage",
          confirmation: "head-referee-confirmed",
          authorityReference: "head-referee",
          gameTimeMs: 0,
          beforeValue: { heat: "inactive" },
          afterValue: { heat: "skipped" },
          reason: "head-referee-direction",
        },
      },
    });
    expect(fabricatedHeatOverride).toMatchObject({ status: "rejected" });

    const paused = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: clockIntent("timeout-pause", false),
    });
    expect(paused).toMatchObject({ status: "accepted" });

    const unnecessaryTimeoutOverride = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...substantiveIntent("unnecessary-timeout-override", "timeout"),
        override: {
          guardrail: "timeout-requires-paused-play",
          direction: "head-referee-directed-timeout-while-running",
          confirmation: "head-referee-confirmed",
          authorityReference: "head-referee",
          gameTimeMs: 0,
          beforeValue: { running: false },
          afterValue: { timeout: "started" },
          reason: "head-referee-direction",
        },
      },
    });
    expect(unnecessaryTimeoutOverride).toMatchObject({ status: "rejected" });

    const clockWithOverride = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...clockCorrectionIntent("clock-with-override"),
        override: {
          guardrail: "normal-event-game-operation",
          direction: "head-referee-directed",
          confirmation: "head-referee-confirmed",
          authorityReference: "head-referee",
          gameTimeMs: 1_000,
          reason: "head-referee-direction",
        },
      },
    });
    expect(clockWithOverride).toMatchObject({ status: "rejected" });
    expect(await harness.record.readActions()).toHaveLength(4);
  });

  test("keeps a failed live Correction atomic and safely retryable", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "correction-atomicity",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });

    harness.failureBoundary = "after-action";
    const failed = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: correctionIntent("atomic-correction", "atomic-correction-id", false),
    });
    expect(failed).toMatchObject({ status: "retryable", operationId: "atomic-correction" });
    expect(await harness.record.readActions()).toHaveLength(1);
    expect(await harness.record.rebuild()).toMatchObject({ status: "ready" });

    harness.failureBoundary = undefined;
    const retried = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: correctionIntent("atomic-correction", "atomic-correction-id", false),
    });
    expect(retried).toMatchObject({
      status: "accepted",
      projection: { scoreByGameSide: { "side-a": 0, "side-b": 0 } },
    });
  });

  test("opens from a Control Grant and durably acknowledges a ten-point goal with a rebuilt projection", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-phone",
    });

    expect(opened).toMatchObject({
      status: "opened",
      eventGameId: harness.root.eventGameId,
      projection: {
        eventGameId: harness.root.eventGameId,
        scoreByGameSide: { "side-a": 0, "side-b": 0 },
      },
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    const result = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });

    expect(result).toMatchObject({
      status: "accepted",
      acknowledgement: { status: "acknowledged", operationId: "operation-goal" },
      projection: {
        eventGameId: harness.root.eventGameId,
        scoreByGameSide: { "side-a": 10, "side-b": 0 },
        goalCount: 1,
      },
      synchronization: { status: "synchronized", pendingCount: 0 },
    });
    expect(JSON.stringify(result)).not.toContain(harness.sessionBearer);
    expect(await harness.record.readActions()).toHaveLength(1);

    const secondDevice = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-device-b",
    });
    expect(secondDevice).toMatchObject({
      status: "opened",
      eventGameId: harness.root.eventGameId,
      projection: {
        eventGameId: harness.root.eventGameId,
        scoreByGameSide: { "side-a": 10, "side-b": 0 },
        goalCount: 1,
      },
    });
  });

  test("keeps invalid, empty, conflicted, expired, revoked, rotated, and wrong-scope authority generic", async () => {
    const harness = await createHarness();
    const invalid = await harness.control.openController({
      qrCredential: "not-a-grant",
      browserContext: "controller-phone",
    });
    expect(invalid).toEqual({
      status: "rejected",
      message: "Unable to open Controller experience.",
    });

    const wrongScope = await createHarness({ grantEventGameId: "different-game" });
    const wrong = await wrongScope.control.openController({
      qrCredential: wrongScope.qrCredential,
      browserContext: "controller-phone",
    });
    expect(wrong).toEqual({
      status: "rejected",
      message: "Unable to open Controller experience.",
    });

    const expired = await createHarness({ grantExpiresAtMs: 20_000 });
    expired.setNow(20_000);
    expect(
      await expired.control.openController({
        qrCredential: expired.qrCredential,
        browserContext: "controller-phone",
      }),
    ).toEqual({
      status: "rejected",
      message: "Unable to open Controller experience.",
    });
    expect(await harness.record.readActions()).toHaveLength(0);

    for (const scopeStatus of ["empty", "conflict"] as const) {
      const unresolved = await createHarness({ scopeStatus });
      expect(
        await unresolved.control.openController({
          qrCredential: unresolved.qrCredential,
          browserContext: "controller-phone",
        }),
      ).toEqual({ status: "rejected", message: "Unable to open Controller experience." });
    }

    const revoked = await createHarness();
    await revoked.authority.revokeGrant(revoked.grantId, { kind: "fixture", id: "fixture" });
    expect(
      await revoked.control.openController({
        qrCredential: revoked.qrCredential,
        browserContext: "controller-phone",
      }),
    ).toEqual({ status: "rejected", message: "Unable to open Controller experience." });

    const rotated = await createHarness();
    await rotated.authority.rotateGrant(rotated.grantId, { kind: "fixture", id: "fixture" });
    expect(
      await rotated.control.openController({
        qrCredential: rotated.qrCredential,
        browserContext: "controller-phone",
      }),
    ).toEqual({ status: "rejected", message: "Unable to open Controller experience." });
  });

  test("keeps a short clock test provisional, then commences after ten active seconds", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "clock-boundary",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    const start = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: clockIntent("clock-start", true),
    });
    expect(start).toMatchObject({
      status: "accepted",
      projection: { commencement: { status: "provisional" } },
    });

    harness.setNow(19_000);
    const shortRunningUpdate = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: clockIntent("clock-short-update", true),
    });
    expect(shortRunningUpdate).toMatchObject({
      projection: { commencement: { status: "provisional" } },
    });
    expect(
      (await harness.record.readRoot(harness.root.recordId))?.lifecycle.commencedAtMs,
    ).toBeNull();

    harness.setNow(20_000);
    const longPause = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: clockIntent("clock-long-pause", false),
    });
    expect(longPause).toMatchObject({ projection: { commencement: { status: "commenced" } } });
    expect((await harness.record.readRoot(harness.root.recordId))?.lifecycle).toMatchObject({
      phase: "in-progress",
      commencedAtMs: 20_000,
    });
  });

  test("persists passive clock commencement at the ten-second boundary during refresh", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "passive-commencement",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: clockIntent("passive-clock-start", true),
    });
    harness.setNow(20_000);
    expect(
      await harness.control.refreshController({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
      }),
    ).toMatchObject({
      status: "authorized",
      projection: { commencement: { status: "commenced", commencedAtMs: 20_000 } },
    });
    expect((await harness.record.readRoot(harness.root.recordId))?.lifecycle).toMatchObject({
      phase: "in-progress",
      commencedAtMs: 20_000,
    });

    harness.setNow(25_000);
    await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: substantiveIntent("passive-card", "card"),
    });
    expect((await harness.record.readRoot(harness.root.recordId))?.lifecycle.commencedAtMs).toBe(
      20_000,
    );
  });

  test.each(["card", "timeout", "suspension", "result"] as const)(
    "commences irreversibly on the first %s trigger",
    async (trigger) => {
      const harness = await createHarness(
        trigger === "suspension" ? { knownDodgeballIds: ["ball-1"] } : {},
      );
      const opened = await harness.control.openController({
        qrCredential: harness.qrCredential,
        browserContext: `trigger-${trigger}`,
      });
      if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
      const result = await harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: substantiveIntent(`trigger-${trigger}`, trigger),
      });
      if (result.status !== "accepted")
        throw new Error(`trigger rejected: ${JSON.stringify(result)}`);
      expect(result.status).toBe("accepted");
      expect((await harness.record.readRoot(harness.root.recordId))?.lifecycle.commencedAtMs).toBe(
        10_000,
      );
      if (trigger === "result") {
        expect((await harness.record.readRoot(harness.root.recordId))?.lifecycle.phase).toBe(
          "finished",
        );
      }
    },
  );

  test("reset and undo do not reverse commencement, and QR reveal stops after finish", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "qr-and-leave",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    expect(
      await harness.control.revealControllerQr({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
      }),
    ).toMatchObject({ status: "revealed", qrCredential: harness.qrCredential });
    await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });
    await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: simpleIntent("reset-1", "reset"),
    });
    await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: simpleIntent("undo-1", "undo"),
    });
    expect(
      (await harness.record.readRoot(harness.root.recordId))?.lifecycle.commencedAtMs,
    ).not.toBeNull();
    const finishIntent = substantiveIntent("finish-1", "result");
    expect(
      await harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: finishIntent,
      }),
    ).toMatchObject({ status: "accepted" });
    expect(
      await harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: finishIntent,
      }),
    ).toMatchObject({ status: "duplicate-accepted" });
    expect(
      await harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: substantiveIntent("post-finish", "card"),
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      (await ownerState(harness)).grantSessions.find(
        (session) => session.sessionId === opened.session.grantSessionId,
      )?.stayedOnEventGameId,
    ).toBeNull();
    expect(
      await harness.control.revealControllerQr({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
      }),
    ).toEqual({ status: "rejected", message: "Unable to reveal the active Control Grant QR." });
    expect(
      await harness.control.leaveController({ sessionBearer: opened.session.sessionBearer }),
    ).toEqual({
      status: "left",
    });
    expect(
      await harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: simpleIntent("after-leave", "undo"),
      }),
    ).toMatchObject({ status: "rejected" });
  });

  test("returns a pre-commencement switch prompt and pins a commenced session", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "switch-boundary",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    harness.setSessionResolution({
      status: "switchable",
      previousEventGameId: harness.root.eventGameId,
      currentEventGameId: "game-reassigned",
    });
    const prompt = await harness.control.refreshController({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
    });
    expect(prompt).toMatchObject({
      status: "switch-required",
      previousEventGameId: harness.root.eventGameId,
      currentEventGameId: "game-reassigned",
    });
    expect(
      await harness.control.revealControllerQr({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      (await ownerState(harness)).grantSessions.find(
        (session) => session.sessionId === opened.session.grantSessionId,
      )?.stayedOnEventGameId,
    ).toBeNull();
    expect(
      await harness.control.stayController({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
      }),
    ).toMatchObject({ status: "authorized", session: { eventGameId: harness.root.eventGameId } });
    expect(
      await harness.control.refreshController({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
      }),
    ).toMatchObject({ status: "authorized", session: { eventGameId: harness.root.eventGameId } });
    expect(
      await harness.control.switchController({ sessionBearer: opened.session.sessionBearer }),
    ).toMatchObject({ status: "authorized" });
  });

  test("authorizes the Controller session before inspecting untrusted intent content", async () => {
    const harness = await createHarness();
    expect(
      await harness.control.submitControllerIntent({
        sessionBearer: "invalid-session-bearer",
        eventGameId: harness.root.eventGameId,
        intent: {
          operationId: "untrusted-operation-id",
          version: "unsupported-version",
          payload: { gameSideId: "untrusted-side" },
        },
      }),
    ).toEqual({
      status: "rejected",
      message: "Unable to perform that Controller action.",
      operationId: null,
    });

    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-phone",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    expect(
      await harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: "wrong-event-game",
        intent: {
          operationId: "untrusted-operation-id",
          version: "unsupported-version",
          payload: { gameSideId: "untrusted-side" },
        },
      }),
    ).toEqual({
      status: "rejected",
      message: "Unable to perform that Controller action.",
      operationId: null,
    });
  });

  test("rejects a changed Pitch Slot target without synthesizing a session switch", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-phone",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const before = await ownerState(harness);

    harness.setScopeEventGameId("reassigned-game");
    expect(
      await harness.authority.authorizeGrant({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: "reassigned-game",
        controlSessionDecision: "stay",
      }),
    ).toEqual({
      status: "rejected",
      code: "grant-authorization-failed",
      message: "Unable to authorize this Grant Session.",
    });
    expect(await ownerState(harness)).toEqual(before);
  });

  test("idempotently acknowledges a resend and rejects conflicting content under one identity", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-phone",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    const first = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });
    const duplicate = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });
    const conflict = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent({ gameSideId: "side-b" }),
    });

    expect(first.status).toBe("accepted");
    expect(duplicate).toMatchObject({
      status: "duplicate-accepted",
      acknowledgement: { status: "acknowledged", operationId: "operation-goal" },
      projection: { scoreByGameSide: { "side-a": 10, "side-b": 0 } },
    });
    expect(conflict).toEqual({
      status: "rejected",
      message: "Unable to perform that Controller action.",
      operationId: "operation-goal",
    });
    expect(await harness.record.readActions()).toHaveLength(1);
  });

  test("duplicate-acknowledges an identical retry after the server clock advances", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-phone",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    const accepted = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });
    expect(accepted.status).toBe("accepted");

    harness.setNow(20_000);
    const duplicate = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });

    expect(duplicate).toMatchObject({
      status: "duplicate-accepted",
      acknowledgement: { status: "acknowledged", operationId: "operation-goal" },
    });
    expect((await harness.record.readActions())[0]?.action.occurrence.trustedAtMs).toBe(10_000);
  });

  test("concurrent identical submissions share one trusted occurrence and one action", async () => {
    let nowMs = 10_000;
    const harness = await createHarness({
      controlClock: () => {
        nowMs += 1_000;
        return nowMs;
      },
    });
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-phone",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    const results = await Promise.all(
      [0, 1].map(() =>
        harness.control.submitControllerIntent({
          sessionBearer: opened.session.sessionBearer,
          eventGameId: harness.root.eventGameId,
          intent: goalIntent(),
        }),
      ),
    );

    expect(results.map((result) => result.status).sort()).toEqual([
      "accepted",
      "duplicate-accepted",
    ]);
    const actions = await harness.record.readActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]?.action.occurrence.trustedAtMs).toBeGreaterThan(10_000);
  });

  test("replays one bounded batch with per-action outcomes and causal blocking", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "reconnect-device",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const result = await harness.control.replayControllerActions({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      batchId: "batch-replay-test",
      replicaGeneration: "generation-replay-test",
      expectedGrantSessionId: opened.session.grantSessionId,
      expectedGrantVersion: opened.session.grantVersion,
      actions: [
        {
          eventGameId: harness.root.eventGameId,
          intent: {
            ...goalIntent({ gameSideId: "side-a" }),
            operationId: "blocked-goal",
            factId: "blocked-fact",
          },
          causalPredecessorIds: ["operation-goal"],
        },
        {
          eventGameId: harness.root.eventGameId,
          intent: goalIntent({ gameSideId: "missing-side" }),
        },
        {
          eventGameId: harness.root.eventGameId,
          intent: { ...goalIntent(), operationId: "unrelated-goal", factId: "unrelated-fact" },
        },
        {
          eventGameId: harness.root.eventGameId,
          intent: { ...goalIntent(), operationId: "unresolved-goal", factId: "unresolved-fact" },
          causalPredecessorIds: ["not-retained"],
        },
      ],
    });
    expect(result.status).toBe("synchronized");
    expect(
      Object.fromEntries(result.outcomes.map((outcome) => [outcome.operationId, outcome.status])),
    ).toEqual({
      "operation-goal": "terminally-rejected",
      "blocked-goal": "causally-blocked",
      "unrelated-goal": "accepted",
      "unresolved-goal": "terminally-rejected",
    });
    expect((await harness.record.readActions()).map((stored) => stored.action.operationId)).toEqual(
      ["unrelated-goal"],
    );
  });

  test("holds new replay evidence for a finished but unlocked Game", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "finished-reconnect-device",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const finish = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: substantiveIntent("finish-before-replay", "result"),
    });
    expect(finish.status).toBe("accepted");
    const replay = await harness.control.replayControllerActions({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      batchId: "batch-finished-hold",
      replicaGeneration: "generation-finished-hold",
      expectedGrantSessionId: opened.session.grantSessionId,
      expectedGrantVersion: opened.session.grantVersion,
      actions: [
        {
          eventGameId: harness.root.eventGameId,
          intent: goalIntent({ operationId: "held-goal", factId: "held-fact" }),
          causalPredecessorIds: [],
        },
      ],
    });
    expect(replay.outcomes).toEqual([{ operationId: "held-goal", status: "held-for-correction" }]);
    expect(await harness.record.readActions()).toHaveLength(1);
  });

  test("holds actions that follow an accepted result in the same replay batch", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "same-batch-finish-device",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const replay = await harness.control.replayControllerActions({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      batchId: "batch-same-batch-finish",
      replicaGeneration: "generation-same-batch-finish",
      expectedGrantSessionId: opened.session.grantSessionId,
      expectedGrantVersion: opened.session.grantVersion,
      actions: [
        {
          eventGameId: harness.root.eventGameId,
          intent: substantiveIntent("same-batch-result", "result"),
          causalPredecessorIds: [],
        },
        {
          eventGameId: harness.root.eventGameId,
          intent: goalIntent({ operationId: "post-result-goal", factId: "post-result-fact" }),
          causalPredecessorIds: [],
        },
      ],
    });
    expect(replay.outcomes).toEqual([
      { operationId: "same-batch-result", status: "accepted" },
      { operationId: "post-result-goal", status: "held-for-correction" },
    ]);
    expect((await harness.record.readActions()).map((stored) => stored.action.operationId)).toEqual(
      ["same-batch-result"],
    );
  });

  test("replays a reversed result Correction chain against rebuilt effective phase", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "reversed-result-correction-chain",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const finish = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: substantiveIntent("replay-order-result", "result"),
    });
    expect(finish.status).toBe("accepted");

    const replay = await harness.control.replayControllerActions({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      batchId: "batch-reversed-result-correction",
      replicaGeneration: "generation-reversed-result-correction",
      expectedGrantSessionId: opened.session.grantSessionId,
      expectedGrantVersion: opened.session.grantVersion,
      actions: [
        {
          eventGameId: harness.root.eventGameId,
          intent: goalIntent({
            operationId: "after-reinstatement-goal",
            factId: "fact-after-reinstatement",
          }),
          causalPredecessorIds: ["replay-order-reinstate"],
        },
        {
          eventGameId: harness.root.eventGameId,
          intent: correctionIntent(
            "replay-order-reinstate",
            "correction-replay-order-reinstate",
            true,
            "fact-replay-order-result",
          ),
          causalPredecessorIds: ["replay-order-goal"],
        },
        {
          eventGameId: harness.root.eventGameId,
          intent: goalIntent({
            operationId: "replay-order-goal",
            factId: "fact-replay-order-goal",
          }),
          causalPredecessorIds: ["replay-order-correct-result"],
        },
        {
          eventGameId: harness.root.eventGameId,
          intent: correctionIntent(
            "replay-order-correct-result",
            "correction-replay-order-result",
            false,
            "fact-replay-order-result",
          ),
          causalPredecessorIds: ["replay-order-result"],
        },
      ],
    });

    expect(replay.outcomes).toEqual([
      { operationId: "replay-order-correct-result", status: "accepted" },
      { operationId: "replay-order-goal", status: "accepted" },
      { operationId: "replay-order-reinstate", status: "accepted" },
      { operationId: "after-reinstatement-goal", status: "held-for-correction" },
    ]);
    expect(replay.projection).toMatchObject({
      phase: "finished",
      scoreByGameSide: { "side-a": 10, "side-b": 0 },
      result: { factId: "fact-replay-order-result" },
      gameFacts: expect.arrayContaining([
        expect.objectContaining({ factId: "fact-replay-order-goal", effective: true }),
      ]),
    });
    expect((await harness.record.readActions()).map((stored) => stored.action.operationId)).toEqual(
      [
        "replay-order-result",
        "replay-order-correct-result",
        "replay-order-goal",
        "replay-order-reinstate",
      ],
    );
  });

  test("rejects replay authority mismatches and malformed causal evidence without submission", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "malformed-reconnect-device",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const mismatch = await harness.control.replayControllerActions({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      batchId: "batch-mismatch",
      replicaGeneration: "generation-mismatch",
      expectedGrantSessionId: opened.session.grantSessionId,
      expectedGrantVersion: "expired-version",
      actions: [{ eventGameId: harness.root.eventGameId, intent: goalIntent() }],
    });
    expect(mismatch.status).toBe("rejected");
    expect(await harness.record.readActions()).toHaveLength(0);
    const malformed = await harness.control.replayControllerActions({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      batchId: "batch-malformed",
      replicaGeneration: "generation-malformed",
      expectedGrantSessionId: opened.session.grantSessionId,
      expectedGrantVersion: opened.session.grantVersion,
      actions: [
        {
          eventGameId: harness.root.eventGameId,
          intent: { ...goalIntent(), operationId: "bad-dependency" },
          causalPredecessorIds: [42],
        },
        {
          eventGameId: harness.root.eventGameId,
          intent: { ...goalIntent(), operationId: "duplicate-dependency" },
          causalPredecessorIds: ["same", "same"],
        },
        {
          eventGameId: "another-game",
          intent: { ...goalIntent(), operationId: "cross-game" },
          causalPredecessorIds: [],
        },
      ],
    });
    expect(malformed.outcomes.map((outcome) => outcome.status)).toEqual([
      "terminally-rejected",
      "terminally-rejected",
      "terminally-rejected",
    ]);
    expect(await harness.record.readActions()).toHaveLength(0);
  });

  test("keeps distinct Controller Devices active while reopening one device replaces only itself", async () => {
    const harness = await createHarness();
    const first = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-device-a",
    });
    const second = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-device-b",
    });
    if (first.status !== "opened" || second.status !== "opened") {
      throw new Error("Expected both Controller Devices to open.");
    }

    const reopened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-device-a",
    });
    if (reopened.status !== "opened")
      throw new Error("Expected the first Controller Device to reopen.");

    const sessions = (await ownerState(harness)).grantSessions;
    expect(
      sessions.find((session) => session.sessionId === first.session.grantSessionId)?.status,
    ).toBe("revoked");
    expect(
      sessions.find((session) => session.sessionId === second.session.grantSessionId)?.status,
    ).toBe("active");
    expect(
      sessions.find((session) => session.sessionId === reopened.session.grantSessionId)?.status,
    ).toBe("active");
  });

  test("does not acknowledge or project an action when the durable transaction fails", async () => {
    const harness = await createHarness({ failureBoundary: "after-action" });
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-phone",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    const failed = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });

    expect(failed).toEqual({
      status: "retryable",
      message: "Controller action was not committed; retry is safe.",
      operationId: "operation-goal",
    });
    expect(await harness.record.readActions()).toHaveLength(0);

    harness.failureBoundary = undefined;
    const recovered = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });
    expect(recovered).toMatchObject({
      status: "accepted",
      projection: { scoreByGameSide: { "side-a": 10 } },
    });
  });

  test("atomically rolls back the action and commencement at the lifecycle boundary", async () => {
    const harness = await createHarness({ failureBoundary: "after-lifecycle" });
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-phone",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    expect(
      await harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: substantiveIntent("atomic-card", "card"),
      }),
    ).toMatchObject({ status: "retryable" });
    expect(await harness.record.readActions()).toHaveLength(0);
    expect((await harness.record.readRoot(harness.root.recordId))?.lifecycle).toMatchObject({
      phase: "scheduled",
      commencedAtMs: null,
    });
  });

  test("assigns trusted occurrence time at the server seam and leaves Ad Hoc commands separate", async () => {
    expect(
      parseLiveEventControllerIntent({
        version: LIVE_EVENT_CONTROL_INTENT_VERSION,
        type: "record-goal",
        operationId: "operation-goal",
        factId: "fact-goal",
        gameSideId: "side-a",
        gameTimeMs: 12_000,
        occurrence: { trustedAtMs: 1, clientOriginAtMs: 10_000, source: "offline" },
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseLiveEventControllerIntent({
        version: LIVE_EVENT_CONTROL_INTENT_VERSION,
        type: "record-goal",
      }),
    ).toMatchObject({ ok: false });

    const adHoc = createInitialGameState({ id: "ad-hoc-regression", nowMs: 10_000 });
    const running = applyGameCommand({
      state: adHoc,
      command: { type: "set-running", running: true },
      nowMs: 10_001,
    });
    expect(running.isRunning).toBe(true);

    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-phone",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });
    const action = (await harness.record.readActions())[0];
    expect(action?.action.occurrence).toMatchObject({
      trustedAtMs: 10_000,
      clientOriginAtMs: 10_000,
      source: "online",
    });
  });

  test("distinguishes direct online provenance from later offline replay evidence", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "provenance-device",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...goalIntent({ operationId: "online-provenance", factId: "online-fact" }),
        occurrence: { clientOriginAtMs: 1_000, source: "online" as const },
      },
    });
    const offline = {
      ...goalIntent({ operationId: "offline-provenance", factId: "offline-fact" }),
      occurrence: { clientOriginAtMs: 2_000, source: "offline" as const },
    };
    const replay = await harness.control.replayControllerActions({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      batchId: "provenance-batch",
      replicaGeneration: "provenance-generation",
      expectedGrantSessionId: opened.session.grantSessionId,
      expectedGrantVersion: opened.session.grantVersion,
      actions: [
        { eventGameId: harness.root.eventGameId, intent: offline, causalPredecessorIds: [] },
      ],
    });
    expect(replay.outcomes).toEqual([{ operationId: "offline-provenance", status: "accepted" }]);
    const actions = await harness.record.readActions();
    expect(
      actions.map((stored) => ({
        operationId: stored.action.operationId,
        clientOriginAtMs: stored.action.occurrence.clientOriginAtMs,
        source: stored.action.occurrence.source,
      })),
    ).toEqual([
      { operationId: "online-provenance", clientOriginAtMs: 1_000, source: "online" },
      { operationId: "offline-provenance", clientOriginAtMs: 2_000, source: "offline" },
    ]);
  });

  test("acknowledges a committed goal when projection rebuild is unavailable", async () => {
    let projectionUnavailable = false;
    const harness = await createHarness({ projectionFailure: () => projectionUnavailable });
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-phone",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    projectionUnavailable = true;

    const result = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });

    expect(result).toMatchObject({
      status: "accepted",
      acknowledgement: { status: "acknowledged" },
      projection: null,
      projectionStatus: "unavailable",
    });
    expect(JSON.stringify(result)).not.toContain("not committed");
    expect(await harness.record.readActions()).toHaveLength(1);
  });

  test("keeps every owning module unchanged when durable acceptance fails", async () => {
    const harness = await createHarness({ failureBoundary: "after-action" });
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "controller-phone",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const before = await ownerState(harness);

    const result = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });

    expect(result.status).toBe("retryable");
    expect(await ownerState(harness)).toEqual(before);
  });

  test("serializes simultaneous clock transitions, transfers the holder, and ignores goal transfer", async () => {
    const harness = await createHarness();
    const first = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "clock-device-a",
    });
    const second = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "clock-device-b",
    });
    if (first.status !== "opened" || second.status !== "opened") {
      throw new Error("Expected two Controller Devices.");
    }

    const [start, pause] = await Promise.all([
      harness.control.submitControllerIntent({
        sessionBearer: first.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: clockIntent("z-start", true),
      }),
      harness.control.submitControllerIntent({
        sessionBearer: second.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: clockIntent("a-pause", false),
      }),
    ]);
    expect(start.status).toBe("accepted");
    expect(pause.status).toBe("accepted");

    const afterSimultaneous = await harness.control.refreshController({
      sessionBearer: second.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
    });
    expect(afterSimultaneous).toMatchObject({
      projection: {
        clock: {
          running: true,
          offlineClockHolderGrantSessionId: first.session.grantSessionId,
        },
      },
    });

    harness.setNow(15_000);
    const transferred = await harness.control.submitControllerIntent({
      sessionBearer: second.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: clockIntent("b-pause", false),
    });
    expect(transferred).toMatchObject({
      projection: {
        clock: {
          running: false,
          gameTimeMs: 5_000,
          offlineClockHolderGrantSessionId: second.session.grantSessionId,
        },
      },
    });

    const goal = await harness.control.submitControllerIntent({
      sessionBearer: first.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });
    expect(goal).toMatchObject({
      projection: {
        clock: { offlineClockHolderGrantSessionId: second.session.grantSessionId },
      },
    });
    const duplicateGoal = await harness.control.submitControllerIntent({
      sessionBearer: first.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: goalIntent(),
    });
    expect(duplicateGoal).toMatchObject({
      status: "duplicate-accepted",
      projection: {
        clock: { offlineClockHolderGrantSessionId: second.session.grantSessionId },
      },
    });
  });

  test("atomically rejects one concurrent bounded adjustment without dropping an accepted Clock action", async () => {
    const harness = await createHarness();
    const first = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "clock-bounds-a",
    });
    const second = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "clock-bounds-b",
    });
    if (first.status !== "opened" || second.status !== "opened") {
      throw new Error("Expected two Controller Devices.");
    }
    const correction = {
      ...clockIntent("clock-correction-105", false),
      type: "clock-correction" as const,
      clockTimeMs: 105 * 60 * 1000,
    };
    expect(
      await harness.control.submitControllerIntent({
        sessionBearer: first.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: correction,
      }),
    ).toMatchObject({ status: "accepted" });
    harness.setNow(20_000);

    const adjustA = clockAdjustmentIntent("clock-bounded-a", 10 * 60 * 1000);
    const adjustB = clockAdjustmentIntent("clock-bounded-b", 10 * 60 * 1000);
    const [resultA, resultB] = await Promise.all([
      harness.control.submitControllerIntent({
        sessionBearer: first.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: adjustA,
      }),
      harness.control.submitControllerIntent({
        sessionBearer: second.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: adjustB,
      }),
    ]);
    expect([resultA.status, resultB.status].sort()).toEqual(["accepted", "rejected"]);
    expect(await harness.record.readActions()).toHaveLength(2);

    const rejected =
      resultA.status === "rejected"
        ? { intent: adjustA, sessionBearer: first.session.sessionBearer }
        : { intent: adjustB, sessionBearer: second.session.sessionBearer };
    expect(
      await harness.control.submitControllerIntent({
        sessionBearer: rejected.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: rejected.intent,
      }),
    ).toMatchObject({ status: "rejected" });
    expect(await harness.record.readActions()).toHaveLength(2);

    const final = await harness.control.refreshController({
      sessionBearer: first.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
    });
    expect(final).toMatchObject({ projection: { clock: { gameTimeMs: 115 * 60 * 1000 } } });

    const accepted =
      resultA.status === "accepted"
        ? { intent: adjustA, sessionBearer: first.session.sessionBearer }
        : { intent: adjustB, sessionBearer: second.session.sessionBearer };
    expect(
      await harness.control.submitControllerIntent({
        sessionBearer: accepted.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: accepted.intent,
      }),
    ).toMatchObject({ status: "duplicate-accepted" });
    expect(await harness.record.readActions()).toHaveLength(2);
  });

  test("composes valid concurrent bounded adjustments at the durable limit", async () => {
    const harness = await createHarness();
    const first = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "clock-compose-a",
    });
    const second = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "clock-compose-b",
    });
    if (first.status !== "opened" || second.status !== "opened") {
      throw new Error("Expected two Controller Devices.");
    }
    expect(
      await harness.control.submitControllerIntent({
        sessionBearer: first.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: {
          ...clockIntent("clock-correction-100", false),
          type: "clock-correction",
          clockTimeMs: 100 * 60 * 1000,
        },
      }),
    ).toMatchObject({ status: "accepted" });
    harness.setNow(20_000);
    const [left, right] = await Promise.all([
      harness.control.submitControllerIntent({
        sessionBearer: first.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: clockAdjustmentIntent("clock-compose-left", 10 * 60 * 1000),
      }),
      harness.control.submitControllerIntent({
        sessionBearer: second.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent: clockAdjustmentIntent("clock-compose-right", 10 * 60 * 1000),
      }),
    ]);
    expect(left.status).toBe("accepted");
    expect(right.status).toBe("accepted");
    expect(
      await harness.control.refreshController({
        sessionBearer: first.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
      }),
    ).toMatchObject({ projection: { clock: { gameTimeMs: 120 * 60 * 1000 } } });
  });

  test("projects clock time between snapshots, emits distinct cues, and enforces adjustment bounds", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "clock-projection",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...clockIntent("clock-correct-19", false),
        type: "clock-correction",
        clockTimeMs: 19 * 60 * 1000,
      },
    });
    const warning = await harness.control.refreshController({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
    });
    expect(warning).toMatchObject({
      projection: {
        clock: {
          gameTimeMs: 19 * 60 * 1000,
          activePenaltyTimeMs: 0,
          cues: {
            flagRunnerEntry: "due",
            seekerWarning: "due",
            seekerRelease: "pending",
            seekerCountdownMs: 60_000,
          },
        },
      },
    });

    const adjusted = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...clockIntent("z-clock-adjust-one-second", false),
        type: "clock-adjust",
        adjustmentMs: 1_000,
      },
    });
    expect(adjusted).toMatchObject({
      status: "accepted",
      projection: { clock: { gameTimeMs: 19 * 60 * 1000 + 1_000 } },
    });

    await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...clockIntent("zz-clock-correct-20", false),
        type: "clock-correction",
        clockTimeMs: 20 * 60 * 1000,
      },
    });
    const release = await harness.control.refreshController({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
    });
    expect(release).toMatchObject({
      projection: { clock: { cues: { seekerWarning: "passed", seekerRelease: "released" } } },
    });

    for (const invalid of [Number.NaN, 1.5, 10 * 60 * 1000 + 1]) {
      expect(
        parseLiveEventControllerIntent({
          ...clockIntent(`invalid-${String(invalid)}`, true),
          type: "clock-adjust",
          adjustmentMs: invalid,
        }),
      ).toMatchObject({ ok: false });
    }
    expect(
      parseLiveEventControllerIntent({
        ...clockIntent("invalid-correction", true),
        type: "clock-correction",
        clockTimeMs: 120 * 60 * 1000 + 1,
      }),
    ).toMatchObject({ ok: false });
  });

  test("projects an independent active penalty from a card fact through pause and resume", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "clock-penalty",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    const submit = (intent: LiveEventControllerIntent) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
      });

    await submit(substantiveIntent("penalty-card", "card"));
    const noPlay = await harness.control.refreshController({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
    });
    expect(noPlay).toMatchObject({
      projection: { clock: { gameTimeMs: 0, activePenaltyTimeMs: 0 } },
    });

    harness.setNow(11_000);
    await submit(clockIntent("penalty-start-clock", true));
    harness.setNow(14_000);
    const live = await harness.control.refreshController({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
    });
    expect(live).toMatchObject({
      projection: { clock: { gameTimeMs: 3_000, activePenaltyTimeMs: 3_000 } },
    });

    harness.setNow(15_000);
    await submit(clockIntent("penalty-pause", false));
    harness.setNow(20_000);
    const paused = await harness.control.refreshController({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
    });
    expect(paused).toMatchObject({
      projection: { clock: { gameTimeMs: 4_000, activePenaltyTimeMs: 4_000 } },
    });

    harness.setNow(25_000);
    await submit(clockIntent("penalty-resume", true));
    harness.setNow(27_000);
    const resumed = await harness.control.refreshController({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
    });
    expect(resumed).toMatchObject({
      projection: { clock: { gameTimeMs: 6_000, activePenaltyTimeMs: 6_000 } },
    });
  });

  test("does not acknowledge a clock transition when durable commit fails", async () => {
    const harness = await createHarness({ failureBoundary: "after-action" });
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "clock-commit-failure",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    const failed = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: clockIntent("clock-failure", true),
    });
    expect(failed).toMatchObject({ status: "retryable", operationId: "clock-failure" });
    expect(await harness.record.readActions()).toHaveLength(0);
  });

  test("keeps offline holder continuity, accepts deliberate takeover, and ignores stale generation evidence", async () => {
    const harness = await createHarness();
    const first = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "holder-phone",
    });
    if (first.status !== "opened") throw new Error("Expected the holder Controller to open.");
    const started = await harness.control.submitControllerIntent({
      sessionBearer: first.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: clockIntent("holder-start", true),
    });
    expect(started).toMatchObject({ status: "accepted" });

    const second = await harness.authority.admitGrant({
      qrCredential: harness.qrCredential,
      browserContext: "replacement-phone",
    });
    if (second.status !== "admitted")
      throw new Error("Expected the replacement Controller to open.");
    const rejectedNonHolder = await harness.control.submitControllerIntent({
      sessionBearer: second.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: clockIntent("non-holder-offline", false, {
        source: "offline",
        clockGeneration: 1,
      }),
    });
    expect(rejectedNonHolder.status).toBe("rejected");

    harness.setNow(11_000);
    const takeover = await harness.control.submitControllerIntent({
      sessionBearer: second.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...clockIntent("emergency-takeover", false, { source: "offline" }),
        type: "clock-takeover" as const,
        clockTimeMs: 5_000,
        authorityGeneration: 1,
        confirmation: "physical-timekeeper-or-head-referee" as const,
      },
    });
    expect(takeover).toMatchObject({
      status: "accepted",
      projection: {
        clock: {
          gameTimeMs: 5_000,
          running: false,
          baseline: { authorityGeneration: 2, holderGrantSessionId: second.grantSessionId },
        },
      },
    });

    harness.setNow(12_000);
    const stale = await harness.control.submitControllerIntent({
      sessionBearer: first.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: clockIntent("stale-holder-action", true, {
        source: "offline",
        clockGeneration: 1,
      }),
    });
    expect(stale).toMatchObject({
      status: "accepted",
      projection: {
        clock: {
          gameTimeMs: 5_000,
          running: false,
          baseline: { staleGenerationOperationIds: ["stale-holder-action"] },
        },
      },
    });
    expect(await harness.record.readActions()).toHaveLength(3);
  });

  test("rejects an ordinary offline clock action before any Offline Clock Holder exists", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "fresh-offline-phone",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");

    const rejected = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: clockIntent("no-offline-holder", true, { source: "offline" }),
    });

    expect(rejected).toMatchObject({ status: "rejected", operationId: "no-offline-holder" });
    expect(await harness.record.readActions()).toHaveLength(0);
    const refreshed = await harness.control.refreshController({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
    });
    if (refreshed.status !== "authorized" || refreshed.projection === null) {
      throw new Error("Expected an authorized Controller projection.");
    }
    expect(refreshed.projection.clock).toMatchObject({
      gameTimeMs: 0,
      running: false,
      offlineClockHolderGrantSessionId: null,
      baseline: { authorityGeneration: 0, holderGrantSessionId: null },
    });
  });

  test("exposes the Controller through its HTTP transport without changing Ad Hoc routes", async () => {
    const harness = await createHarness();
    const allowedOrigin = "https://timer.quadball.app";
    const transport = createLiveEventGameControlTransport(
      () => harness.control,
      (request) =>
        request.headers.get("origin") === allowedOrigin &&
        request.headers.get("host") === "timer.quadball.app",
    );
    const rejectedOpen = await transport.openController(
      new Request("https://timer.quadball.app/api/event-control/open", {
        method: "POST",
        headers: { origin: "https://attacker.invalid", host: "timer.quadball.app" },
        body: JSON.stringify({ qrCredential: harness.qrCredential, browserContext: "phone" }),
      }),
    );
    expect(rejectedOpen.status).toBe(404);

    const openedResponse = await transport.openController(
      new Request("https://timer.quadball.app/api/event-control/open", {
        method: "POST",
        headers: { origin: allowedOrigin, host: "timer.quadball.app" },
        body: JSON.stringify({ qrCredential: harness.qrCredential, browserContext: "phone" }),
      }),
    );
    expect(openedResponse.status).toBe(200);
    const opened = (await openedResponse.json()) as {
      eventGameId: string;
      session: { sessionBearer: string };
    };
    expect(opened.session.sessionBearer).toBeString();

    const refreshResponse = await transport.refreshController(
      new Request("https://timer.quadball.app/api/event-control/refresh", {
        method: "POST",
        headers: { origin: allowedOrigin, host: "timer.quadball.app" },
        body: JSON.stringify({
          sessionBearer: opened.session.sessionBearer,
          eventGameId: opened.eventGameId,
        }),
      }),
    );
    expect(refreshResponse.status).toBe(200);
    expect(await refreshResponse.json()).toMatchObject({ status: "authorized" });

    const revealResponse = await transport.revealControllerQr(
      new Request("https://timer.quadball.app/api/event-control/reveal-qr", {
        method: "POST",
        headers: { origin: allowedOrigin, host: "timer.quadball.app" },
        body: JSON.stringify({
          sessionBearer: opened.session.sessionBearer,
          eventGameId: opened.eventGameId,
        }),
      }),
    );
    expect(revealResponse.status).toBe(200);
    expect(await revealResponse.json()).toMatchObject({
      status: "revealed",
      qrCredential: harness.qrCredential,
    });

    const actionResponse = await transport.submitControllerIntent(
      new Request("https://timer.quadball.app/api/event-control/intent", {
        method: "POST",
        headers: { origin: allowedOrigin, host: "timer.quadball.app" },
        body: JSON.stringify({
          sessionBearer: opened.session.sessionBearer,
          eventGameId: opened.eventGameId,
          intent: goalIntent(),
        }),
      }),
    );
    expect(actionResponse.status).toBe(200);
    expect(await actionResponse.json()).toMatchObject({ status: "accepted" });

    const rejectedAction = await transport.submitControllerIntent(
      new Request("https://timer.quadball.app/api/event-control/intent", {
        method: "POST",
        headers: { origin: "https://attacker.invalid", host: "timer.quadball.app" },
        body: JSON.stringify({
          sessionBearer: opened.session.sessionBearer,
          eventGameId: opened.eventGameId,
          intent: goalIntent(),
        }),
      }),
    );
    expect(rejectedAction.status).toBe(404);

    const leaveResponse = await transport.leaveController(
      new Request("https://timer.quadball.app/api/event-control/leave", {
        method: "POST",
        headers: { origin: allowedOrigin, host: "timer.quadball.app" },
        body: JSON.stringify({ sessionBearer: opened.session.sessionBearer }),
      }),
    );
    expect(leaveResponse.status).toBe(200);
    expect(await leaveResponse.json()).toEqual({ status: "left" });
  });

  test("admits a Controller through the independent Grant Code path without exposing code material", async () => {
    const harness = await createHarness();
    const created = await harness.authority.createGrantCode(harness.grantId, {
      kind: "fixture",
      id: "fixture",
    });
    if (created.status !== "created") throw new Error("Expected a Control Grant Code.");
    const allowedOrigin = "https://timer.quadball.app";
    const transport = createLiveEventGameControlTransport(
      () => harness.control,
      (request) =>
        request.headers.get("origin") === allowedOrigin &&
        request.headers.get("host") === "timer.quadball.app",
    );
    const response = await transport.openController(
      new Request("https://timer.quadball.app/api/event-control/open", {
        method: "POST",
        headers: { origin: allowedOrigin, host: "timer.quadball.app" },
        body: JSON.stringify({ grantCode: created.code, browserContext: "code-controller" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    const opened = await response.json();
    expect(opened).toMatchObject({ status: "opened", eventGameId: harness.root.eventGameId });
    expect(opened).toMatchObject({ sessionExpiresAtMs: null });
    expect(JSON.stringify(opened)).not.toContain(created.code);

    const refreshResponse = await transport.refreshController(
      new Request("https://timer.quadball.app/api/event-control/refresh", {
        method: "POST",
        headers: { origin: allowedOrigin, host: "timer.quadball.app" },
        body: JSON.stringify({
          sessionBearer: opened.session.sessionBearer,
          eventGameId: opened.eventGameId,
        }),
      }),
    );
    expect(refreshResponse.status).toBe(200);
    expect(await refreshResponse.json()).toMatchObject({ status: "authorized" });
  });

  test("uses the production Control scope resolver transaction for typed code admission", async () => {
    const harness = await createHarness();
    const created = await harness.authority.createGrantCode(harness.grantId, {
      kind: "fixture",
      id: "fixture",
    });
    if (created.status !== "created") throw new Error("Expected a Control Grant Code.");
    const wrongScope = await harness.authority.createControlGrant({
      authority: { kind: "fixture", id: "fixture" },
      scope: { ...harness.root.externalScope, pitchSlotId: "wrong-slot" },
    });
    if (wrongScope.status !== "created") throw new Error("Expected wrong-scope Control Grant.");
    const wrongCode = await harness.authority.createGrantCode(wrongScope.grantId, {
      kind: "fixture",
      id: "fixture",
    });
    if (wrongCode.status !== "created") throw new Error("Expected wrong-scope Grant Code.");
    harness.grantOptions.controlScopeResolver = createRuntimeControlScopeResolver(() => 10_000);
    expect(
      await harness.authority.admitControlGrantCode({
        grantCode: created.code,
        browserContext: "production-resolver-controller",
      }),
    ).toMatchObject({ status: "admitted", eventGameId: harness.root.eventGameId });
    expect(
      await harness.authority.admitControlGrantCode({
        grantCode: wrongCode.code,
        browserContext: "production-resolver-wrong-scope",
      }),
    ).toEqual({
      status: "rejected",
      code: "grant-admission-failed",
      message: "Unable to admit this Grant.",
    });
  });

  test("rejects a non-Control Grant Code before Controller session admission", async () => {
    const harness = await createHarness();
    const eventAdmin = await harness.authority.createEventAdminGrant({
      authority: { kind: "fixture", id: "fixture" },
      scope: {
        eventId: harness.root.eventId,
        eventTimeZone: "UTC",
        finalGameDayDate: "2026-08-14",
      },
    });
    if (eventAdmin.status !== "created") throw new Error("Expected Event Admin Grant.");
    const code = await harness.authority.createGrantCode(eventAdmin.grantId, {
      kind: "fixture",
      id: "fixture",
    });
    if (code.status !== "created") throw new Error("Expected Event Admin Grant Code.");

    const opened = await harness.control.openController({
      grantCode: code.code,
      browserContext: "wrong-controller-type",
    });
    expect(opened).toEqual({
      status: "rejected",
      message: "Unable to open Controller experience.",
    });
    expect(
      await harness.authority.listGrantSessions(eventAdmin.grantId, {
        kind: "fixture",
        id: "fixture",
      }),
    ).toMatchObject({ status: "ok", value: [] });
  });
  test("keeps a retryable card ahead of its reason while unrelated replay work progresses", async () => {
    const harness = await createHarness({ failureAfterActionNumber: 1 });
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "card-reason-causal-replay",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const card = cardIntent({
      operationId: "retryable-card",
      factId: "retryable-card-fact",
      cardType: "ejection",
    });
    const reason = reasonIntent({
      operationId: "card-dependent-reason",
      factId: "card-dependent-reason-fact",
      targetCardFactId: "retryable-card-fact",
    });
    const replayInput = {
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      batchId: "card-reason-causal-batch",
      replicaGeneration: "card-reason-causal-generation",
      expectedGrantSessionId: opened.session.grantSessionId,
      expectedGrantVersion: opened.session.grantVersion,
      actions: [
        { eventGameId: harness.root.eventGameId, intent: card, causalPredecessorIds: [] },
        {
          eventGameId: harness.root.eventGameId,
          intent: reason,
          causalPredecessorIds: ["retryable-card"],
        },
        {
          eventGameId: harness.root.eventGameId,
          intent: goalIntent({
            operationId: "unrelated-replay-goal",
            factId: "unrelated-replay-goal-fact",
          }),
          causalPredecessorIds: [],
        },
      ],
    };
    const first = await harness.control.replayControllerActions(replayInput);
    expect(
      Object.fromEntries(first.outcomes.map((outcome) => [outcome.operationId, outcome.status])),
    ).toEqual({
      "retryable-card": "retryable",
      "unrelated-replay-goal": "accepted",
      "card-dependent-reason": "causally-blocked",
    });

    harness.failureAfterActionNumber = undefined;
    const converged = await harness.control.replayControllerActions({
      ...replayInput,
      batchId: "card-reason-causal-retry",
      actions: replayInput.actions.slice(0, 2),
    });
    expect(converged.outcomes).toEqual([
      { operationId: "retryable-card", status: "accepted" },
      { operationId: "card-dependent-reason", status: "accepted" },
    ]);
    expect(converged.projection).toMatchObject({
      penalties: { cards: [{ factId: "retryable-card-fact", reason: "contact-safety" }] },
    });
  });

  test("retains a complete-tie choice behind a retryable score during replay", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "score-choice-causal-replay",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const submit = (intent: unknown) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
      });
    await submit(
      cardIntent({ operationId: "choice-card-7", factId: "choice-card-7", playerNumber: 7 }),
    );
    await submit(
      cardIntent({ operationId: "choice-card-8", factId: "choice-card-8", playerNumber: 8 }),
    );
    harness.failureAfterActionNumber = 3;
    const score = goalIntent({
      operationId: "choice-score",
      factId: "choice-score",
      gameTimeMs: 12_000,
    });
    const choice = releaseIntent(
      "penalty-expiration:choice-score",
      "choice-score",
      "side-b:8",
      12_000,
    );
    const replayInput = {
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      batchId: "score-choice-causal-batch",
      replicaGeneration: "score-choice-causal-generation",
      expectedGrantSessionId: opened.session.grantSessionId,
      expectedGrantVersion: opened.session.grantVersion,
      actions: [
        { eventGameId: harness.root.eventGameId, intent: score, causalPredecessorIds: [] },
        {
          eventGameId: harness.root.eventGameId,
          intent: choice,
          causalPredecessorIds: ["choice-score"],
        },
      ],
    };
    const first = await harness.control.replayControllerActions(replayInput);
    expect(first.outcomes).toEqual([
      { operationId: "choice-score", status: "retryable", detail: "retryable server outcome" },
      { operationId: choice.operationId, status: "causally-blocked" },
    ]);
    expect(await harness.record.readActions()).toHaveLength(2);

    harness.failureAfterActionNumber = undefined;
    const second = await harness.control.replayControllerActions({
      ...replayInput,
      batchId: "score-choice-causal-retry",
    });
    expect(second.outcomes).toEqual([
      { operationId: "choice-score", status: "accepted" },
      { operationId: choice.operationId, status: "accepted" },
    ]);
    expect(second.projection).toMatchObject({
      penalties: { releases: [{ scoreFactId: "choice-score", playerKey: "side-b:8" }] },
    });
  });

  test("repairs a missing automatic release consequence after a source-only batch commit", async () => {
    const harness = await createHarness({ failureAfterActionNumber: 3 });
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "automatic-release-repair",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const submit = (intent: unknown) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
      });
    await submit(cardIntent({ operationId: "repair-card", factId: "repair-card" }));
    const firstGoal = await submit(
      goalIntent({
        operationId: "repair-goal",
        factId: "repair-goal",
        sportingOrder: 7_000,
        override: {
          guardrail: "sporting-order-adjudication",
          direction: "head-referee-adjudicated-sporting-order",
          confirmation: "head-referee-confirmed",
          authorityReference: "head-referee",
          gameTimeMs: 12_000,
          beforeValue: { sportingOrder: 12_000 },
          afterValue: { sportingOrder: 7_000 },
          reason: "head-referee-direction",
        },
      }),
    );
    expect(firstGoal).toMatchObject({ status: "retryable", operationId: "repair-goal" });
    expect(await harness.record.readActions()).toHaveLength(2);

    harness.failureAfterActionNumber = undefined;
    const repaired = await submit(
      goalIntent({
        operationId: "repair-goal",
        factId: "repair-goal",
        sportingOrder: 7_000,
        override: {
          guardrail: "sporting-order-adjudication",
          direction: "head-referee-adjudicated-sporting-order",
          confirmation: "head-referee-confirmed",
          authorityReference: "head-referee",
          gameTimeMs: 12_000,
          beforeValue: { sportingOrder: 12_000 },
          afterValue: { sportingOrder: 7_000 },
          reason: "head-referee-direction",
        },
      }),
    );
    expect(repaired).toMatchObject({
      status: "duplicate-accepted",
      projection: { penalties: { releases: [{ releaseCause: "score" }] } },
    });
    expect(await harness.record.readActions()).toHaveLength(3);
    const releaseConsequences = (await harness.record.readActions()).filter(
      ({ action }) =>
        action.interpretation.type === "fact" &&
        action.interpretation.factType === "penalty-release-consequence",
    );
    expect(releaseConsequences).toHaveLength(1);
    expect(releaseConsequences[0]?.action.causalPredecessorIds).toContain("repair-goal");
    expect(releaseConsequences[0]?.action.interpretation).toMatchObject({
      payload: { data: { sportingOrder: 7_000 } },
    });
    expect(
      (await harness.record.readActions()).find(
        ({ action }) => action.operationId === "repair-goal",
      )?.action.interpretation,
    ).toMatchObject({ payload: { data: { sportingOrder: 7_000 } } });

    const duplicate = await submit(
      goalIntent({
        operationId: "repair-goal",
        factId: "repair-goal",
        sportingOrder: 7_000,
        override: {
          guardrail: "sporting-order-adjudication",
          direction: "head-referee-adjudicated-sporting-order",
          confirmation: "head-referee-confirmed",
          authorityReference: "head-referee",
          gameTimeMs: 12_000,
          beforeValue: { sportingOrder: 12_000 },
          afterValue: { sportingOrder: 7_000 },
          reason: "head-referee-direction",
        },
      }),
    );
    expect(duplicate).toMatchObject({ status: "duplicate-accepted" });
    expect(await harness.record.readActions()).toHaveLength(3);
  });

  test("keeps direct and repaired release consequences on the source sporting order", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "direct-sporting-order-release",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const submit = (intent: unknown) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
      });
    await submit(cardIntent({ operationId: "direct-order-card", factId: "direct-order-card" }));
    await submit(
      goalIntent({
        operationId: "direct-order-goal",
        factId: "direct-order-goal",
        sportingOrder: 7_000,
        override: {
          guardrail: "sporting-order-adjudication",
          direction: "head-referee-adjudicated-sporting-order",
          confirmation: "head-referee-confirmed",
          authorityReference: "head-referee",
          gameTimeMs: 12_000,
          beforeValue: { sportingOrder: 12_000 },
          afterValue: { sportingOrder: 7_000 },
          reason: "head-referee-direction",
        },
      }),
    );
    const consequence = (await harness.record.readActions()).find(
      ({ action }) =>
        action.interpretation.type === "fact" &&
        action.interpretation.factType === "penalty-release-consequence",
    );
    expect(consequence?.action.interpretation).toMatchObject({
      payload: { data: { sourceFactId: "direct-order-goal", sportingOrder: 7_000 } },
    });
  });

  test("materializes an automatic consequence when a late card precedes an accepted score", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "late-card-consequence",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const submit = (intent: unknown) =>
      harness.control.submitControllerIntent({
        sessionBearer: opened.session.sessionBearer,
        eventGameId: harness.root.eventGameId,
        intent,
      });
    expect(
      await submit(
        goalIntent({
          operationId: "late-card-score",
          factId: "late-card-score",
          gameTimeMs: 10_000,
          sportingOrder: 7_000,
          override: {
            guardrail: "sporting-order-adjudication",
            direction: "head-referee-adjudicated-sporting-order",
            confirmation: "head-referee-confirmed",
            authorityReference: "head-referee",
            gameTimeMs: 10_000,
            beforeValue: { sportingOrder: 10_000 },
            afterValue: { sportingOrder: 7_000 },
            reason: "head-referee-direction",
          },
        }),
      ),
    ).toMatchObject({ status: "accepted" });
    expect(
      await submit({
        ...cardIntent({
          operationId: "late-card",
          factId: "late-card",
          gameTimeMs: 0,
        }),
        occurrence: { clientOriginAtMs: 0, source: "offline" as const },
      }),
    ).toMatchObject({
      status: "accepted",
      projection: {
        penalties: {
          players: [{ playerNumber: 7 }],
          releases: [{ sourceFactId: "late-card-score" }],
        },
      },
    });
    const consequence = (await harness.record.readActions()).find(
      ({ action }) =>
        action.interpretation.type === "fact" &&
        action.interpretation.factType === "penalty-release-consequence",
    );
    expect(consequence?.action.interpretation).toMatchObject({
      payload: { data: { sourceFactId: "late-card-score", sportingOrder: 7_000 } },
    });
    expect(consequence?.action.causalPredecessorIds).toEqual(
      expect.arrayContaining(["late-card-score", "late-card"]),
    );
  });

  test("preserves offline sporting time while delayed replay records current acceptance evidence", async () => {
    const harness = await createHarness();
    const opened = await harness.control.openController({
      qrCredential: harness.qrCredential,
      browserContext: "delayed-offline-device",
    });
    if (opened.status !== "opened") throw new Error("Expected the Controller to open.");
    const serverClock = await harness.control.submitControllerIntent({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      intent: {
        ...clockCorrectionIntent("delayed-server-clock", 60_000),
        occurrence: { clientOriginAtMs: 60_000, source: "online" as const },
      },
    });
    expect(serverClock).toMatchObject({ status: "accepted" });
    const offlineCard = {
      ...cardIntent({
        operationId: "delayed-offline-card",
        factId: "delayed-offline-card",
        gameTimeMs: 0,
      }),
      occurrence: { clientOriginAtMs: 1_000, source: "offline" as const },
    };
    const offlineGoal = {
      ...goalIntent({
        operationId: "delayed-offline-goal",
        factId: "delayed-offline-goal",
        gameTimeMs: 15_000,
      }),
      occurrence: { clientOriginAtMs: 2_000, source: "offline" as const },
    };
    const replay = await harness.control.replayControllerActions({
      sessionBearer: opened.session.sessionBearer,
      eventGameId: harness.root.eventGameId,
      batchId: "delayed-offline-batch",
      replicaGeneration: "delayed-offline-generation",
      expectedGrantSessionId: opened.session.grantSessionId,
      expectedGrantVersion: opened.session.grantVersion,
      actions: [
        { eventGameId: harness.root.eventGameId, intent: offlineCard, causalPredecessorIds: [] },
        {
          eventGameId: harness.root.eventGameId,
          intent: offlineGoal,
          causalPredecessorIds: ["delayed-offline-card"],
        },
      ],
    });
    expect(replay.outcomes).toEqual([
      { operationId: "delayed-offline-card", status: "accepted" },
      { operationId: "delayed-offline-goal", status: "accepted" },
    ]);
    const stored = await harness.record.readActions();
    expect(
      stored
        .filter(({ action }) =>
          ["delayed-offline-card", "delayed-offline-goal"].includes(action.operationId),
        )
        .map(({ action }) => {
          const payload =
            action.interpretation.type === "fact" ? action.interpretation.payload : null;
          const gameTimeMs =
            payload !== null &&
            typeof payload === "object" &&
            !Array.isArray(payload) &&
            "gameTimeMs" in payload
              ? payload.gameTimeMs
              : null;
          return {
            operationId: action.operationId,
            gameTimeMs,
            source: action.occurrence.source,
            trustedAtMs: action.occurrence.trustedAtMs,
          };
        }),
    ).toEqual([
      {
        operationId: "delayed-offline-card",
        gameTimeMs: 0,
        source: "offline",
        trustedAtMs: 10_000,
      },
      {
        operationId: "delayed-offline-goal",
        gameTimeMs: 15_000,
        source: "offline",
        trustedAtMs: 10_000,
      },
    ]);
    expect(
      stored.some(({ action }) => action.operationId === "delayed-offline-goal-penalty-release"),
    ).toBe(true);
  });
});

async function createHarness(
  overrides: {
    eventGameId?: string;
    grantEventGameId?: string;
    grantExpiresAtMs?: number | null;
    failureBoundary?: "after-action" | "after-lifecycle";
    failureAfterActionNumber?: number;
    projectionFailure?: () => boolean;
    scopeStatus?: "empty" | "conflict";
    controlClock?: () => number;
    knownDodgeballIds?: readonly string[];
    sessionResolution?: ControlGrantSessionResolution;
    acceptanceLimits?: AcceptanceLimits;
  } = {},
) {
  const root = createRoot(overrides.eventGameId ?? "game-live-control");
  const reassignedRoot = createRoot("game-reassigned", "reassigned");
  const storage = createInMemoryFoundationStorage();
  const grantOptions = createGrantOptions(overrides.grantEventGameId ?? root.eventGameId);
  const authority = createTypedGrantAuthority(storage, grantOptions);
  const created = await authority.createControlGrant({
    scope: root.externalScope,
    authority: { kind: "fixture", id: "fixture" },
    expiresAtMs: overrides.grantExpiresAtMs,
  });
  if (created.status !== "created") throw new Error("Expected a Control Grant.");
  const admitted = await authority.admitGrant({
    qrCredential: created.qrCredential,
    browserContext: "controller-phone",
  });
  if (admitted.status !== "admitted") throw new Error("Expected a Grant Session.");
  if (overrides.scopeStatus !== undefined) grantOptions.setScopeStatus(overrides.scopeStatus);
  if (overrides.sessionResolution !== undefined)
    grantOptions.setSessionResolution(overrides.sessionResolution);
  let lifecycleNotifications = 0;
  let triggerLifecycleChange = () => {};
  grantOptions.onLifecycleChange = () => {
    lifecycleNotifications += 1;
    triggerLifecycleChange();
  };

  let failureBoundary = overrides.failureBoundary;
  let failureAfterActionNumber = overrides.failureAfterActionNumber;
  let afterActionCount = 0;
  const record = createEventGameRecord(storage, {
    externalScopeResolver: createScopeResolver(root),
    interpreter: createLiveEventGameIqaInterpreter(),
    clock: () => grantOptions.clock.nowMs(),
    auditAuthorityVerifier: { verify: () => true },
  });
  if ((await record.registerRoot(root)).status !== "registered") {
    throw new Error("Expected the Event Game Record root to register.");
  }
  const reassignedRecord = createEventGameRecord(storage, {
    externalScopeResolver: createScopeResolver(reassignedRoot),
    interpreter: createLiveEventGameIqaInterpreter(),
    clock: () => grantOptions.clock.nowMs(),
    auditAuthorityVerifier: { verify: () => true },
  });
  if ((await reassignedRecord.registerRoot(reassignedRoot)).status !== "registered") {
    throw new Error("Expected the reassigned Event Game Record root to register.");
  }
  const acceptance = createFoundationAcceptance(storage, {
    grant: grantOptions,
    externalScopeResolver: createScopeResolver(root),
    clock: () => grantOptions.clock.nowMs(),
    interpreter: createLiveEventGameIqaInterpreter(),
    failureInjector: (boundary) => {
      if (boundary === "after-action") afterActionCount += 1;
      if (
        boundary === failureBoundary ||
        (boundary === "after-action" && afterActionCount === failureAfterActionNumber)
      )
        throw new Error("simulated durable failure");
    },
    validateActionInTransaction: ({ transaction, root, action }) =>
      validateLiveEventGameActionInTransaction(
        transaction.listActions(root.recordId),
        root,
        action,
        overrides.knownDodgeballIds ?? null,
      ),
    limits: overrides.acceptanceLimits,
  });
  const control = createLiveEventGameControl({
    resolveEventGameRecord: async (eventGameId) =>
      eventGameId === root.eventGameId
        ? { recordId: root.recordId, record }
        : eventGameId === reassignedRoot.eventGameId
          ? { recordId: reassignedRoot.recordId, record: reassignedRecord }
          : null,
    acceptance,
    grantAuthority: authority,
    clock: overrides.controlClock ?? (() => grantOptions.clock.nowMs()),
    listEventGameRoots: async () => [root, reassignedRoot],
    knownDodgeballIdsForEventGame:
      overrides.knownDodgeballIds === undefined ? undefined : () => overrides.knownDodgeballIds!,
    projectionFailure: overrides.projectionFailure,
  });
  triggerLifecycleChange = () => {
    void control.reconcileActiveControllerSessions();
  };
  return {
    root,
    storage,
    record,
    control,
    authority,
    grantOptions,
    grantId: created.grantId,
    qrCredential: created.qrCredential,
    sessionBearer: admitted.sessionBearer,
    get lifecycleNotifications() {
      return lifecycleNotifications;
    },
    triggerLifecycleChange() {
      grantOptions.onLifecycleChange?.();
    },
    set failureBoundary(value: typeof failureBoundary) {
      failureBoundary = value;
    },
    set failureAfterActionNumber(value: number | undefined) {
      failureAfterActionNumber = value;
    },
    setNow(value: number) {
      grantOptions.setNow(value);
    },
    setScopeStatus(value: "empty" | "conflict" | undefined) {
      grantOptions.setScopeStatus(value);
    },
    setScopeEventGameId(value: string) {
      grantOptions.setScopeEventGameId(value);
    },
    setSessionResolution(value: ControlGrantSessionResolution | undefined) {
      grantOptions.setSessionResolution(value);
    },
  };
}

function goalIntent(
  overrides: {
    gameSideId?: string;
    operationId?: string;
    factId?: string;
    gameTimeMs?: number;
    sportingOrder?: number;
    override?: Record<string, unknown>;
  } = {},
) {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "record-goal",
    operationId: overrides.operationId ?? "operation-goal",
    factId: overrides.factId ?? "fact-goal",
    gameSideId: overrides.gameSideId ?? "side-a",
    gameTimeMs: overrides.gameTimeMs ?? 12_000,
    ...(overrides.sportingOrder === undefined ? {} : { sportingOrder: overrides.sportingOrder }),
    ...(overrides.override === undefined ? {} : { override: overrides.override }),
    occurrence: { clientOriginAtMs: 10_000 },
  };
}

function cardIntent(
  overrides: {
    operationId?: string;
    factId?: string;
    gameSideId?: string;
    playerNumber?: number | null;
    cardType?: "blue" | "yellow" | "red" | "ejection";
    foulBeforeScore?: boolean;
    seekerPenalty?: "head-referee-confirmed";
    gameTimeMs?: number;
  } = {},
) {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "record-card" as const,
    operationId: overrides.operationId ?? "operation-card",
    factId: overrides.factId ?? "fact-card",
    gameSideId: overrides.gameSideId ?? "side-b",
    playerNumber: overrides.playerNumber ?? 7,
    cardType: overrides.cardType ?? ("blue" as const),
    ...(overrides.foulBeforeScore === undefined
      ? {}
      : { foulBeforeScore: overrides.foulBeforeScore }),
    ...(overrides.seekerPenalty === undefined ? {} : { seekerPenalty: overrides.seekerPenalty }),
    gameTimeMs: overrides.gameTimeMs ?? 0,
    occurrence: { clientOriginAtMs: 10_000 },
  };
}

function reasonIntent(
  overrides: {
    operationId?: string;
    factId?: string;
    targetCardFactId?: string;
    reason?:
      | "contact-safety"
      | "ball-interaction"
      | "position-boundary"
      | "procedure-substitution"
      | "conduct";
  } = {},
) {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "record-penalty-reason" as const,
    operationId: overrides.operationId ?? "operation-reason",
    factId: overrides.factId ?? "fact-reason",
    targetCardFactId: overrides.targetCardFactId ?? "fact-card",
    reason: overrides.reason ?? ("contact-safety" as const),
    gameTimeMs: 0,
    occurrence: { clientOriginAtMs: 10_000 },
  };
}

function releaseIntent(pendingId: string, scoreFactId: string, playerKey: string, gameTimeMs = 0) {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "resolve-penalty-expiration" as const,
    operationId: `zz-release-${playerKey}`,
    factId: `zz-release-${playerKey}`,
    pendingId,
    scoreFactId,
    playerKey,
    gameTimeMs,
    occurrence: { clientOriginAtMs: 10_000 },
  };
}

function flagCatchIntent(operationId: string, factId: string, gameSideId: string) {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "record-flag-catch" as const,
    operationId,
    factId,
    gameSideId,
    gameTimeMs: 1_200_000,
    occurrence: { clientOriginAtMs: 1_200_000 },
  };
}

function closePlayAdjudicationOverride(
  gameTimeMs: number,
  relatedFactId: string,
  relatedGameTimeMs: number,
  relation: "before" | "after",
) {
  return {
    guardrail: "sporting-order-adjudication" as const,
    direction: "head-referee-adjudicated-sporting-order" as const,
    confirmation: "head-referee-confirmed" as const,
    authorityReference: "head-referee",
    gameTimeMs,
    beforeValue: { candidateGameTimeMs: gameTimeMs, relatedFactId, relatedGameTimeMs },
    afterValue: { relation, sportingOrder: "explicit-pair-order" },
    reason: "head-referee-direction" as const,
  };
}

function flagCatchBoundaryOverride(gameTimeMs: number, running = false) {
  return {
    guardrail: "flag-catch-requires-seeker-release-and-stopped-play" as const,
    direction: "head-referee-directed-flag-catch-boundary" as const,
    confirmation: "head-referee-confirmed" as const,
    authorityReference: "head-referee",
    gameTimeMs,
    beforeValue: { seekerReleased: gameTimeMs >= 1_200_000, running },
    afterValue: { flagCatch: "accepted" },
    reason: "head-referee-direction" as const,
  };
}

function concessionIntent(operationId: string, factId: string, gameSideId: string) {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "record-concession" as const,
    operationId,
    factId,
    gameSideId,
    gameTimeMs: 1_400_000,
    occurrence: { clientOriginAtMs: 1_400_000 },
  };
}

function forfeitIntent(operationId: string, factId: string, gameSideId: string) {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "record-forfeit" as const,
    operationId,
    factId,
    gameSideId,
    gameTimeMs: 30_000,
    occurrence: { clientOriginAtMs: 30_000 },
  };
}

function correctionIntent(
  operationId: string,
  factId: string,
  effective: boolean,
  targetFactId = "fact-goal",
) {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "correct-fact" as const,
    operationId,
    factId,
    targetFactId,
    effective,
    gameTimeMs: 13_000,
    occurrence: { clientOriginAtMs: 13_000, source: "offline" as const },
  };
}

function clockCorrectionIntent(operationId: string, clockTimeMs = 1_000) {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "clock-correction" as const,
    operationId,
    factId: `fact-${operationId}`,
    clockTimeMs,
    gameTimeMs: 0,
    occurrence: { clientOriginAtMs: null },
  };
}

function clockIntent(
  operationId: string,
  running: boolean,
  options: { source?: "online" | "offline"; clockGeneration?: number } = {},
) {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "clock" as const,
    operationId,
    factId: `fact-${operationId}`,
    running,
    gameTimeMs: 0,
    occurrence: {
      clientOriginAtMs: null,
      ...(options.source === undefined ? {} : { source: options.source }),
    },
    ...(options.clockGeneration === undefined ? {} : { clockGeneration: options.clockGeneration }),
  };
}

function clockAdjustmentIntent(operationId: string, adjustmentMs: number) {
  return {
    ...clockIntent(operationId, false),
    type: "clock-adjust" as const,
    adjustmentMs,
  };
}

function substantiveIntent(
  operationId: string,
  trigger: "card" | "timeout" | "suspension" | "result" | "heat-stoppage",
  gameTimeMs = 0,
) {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type: "substantive" as const,
    trigger,
    operationId,
    factId: `fact-${operationId}`,
    gameTimeMs,
    ...(trigger === "timeout"
      ? { timeoutAction: "stoppage" as const, timeoutGameSideId: "side-a" }
      : {}),
    ...(trigger === "suspension"
      ? {
          suspensionAction: "start" as const,
          suspensionSnapshot: {
            version: LIVE_SUSPENSION_SNAPSHOT_VERSION,
            gameTimeMs,
            scoreByGameSide: { "side-a": 0, "side-b": 0 },
            penalties: { segments: [] },
            volleyballPossession: "side-a",
            dodgeballPossession: { "ball-1": "side-a" },
          },
        }
      : {}),
    occurrence: { clientOriginAtMs: null },
  };
}

function simpleIntent(operationId: string, type: "reset" | "undo") {
  return {
    version: LIVE_EVENT_CONTROL_INTENT_VERSION,
    type,
    operationId,
    factId: `fact-${operationId}`,
    gameTimeMs: 0,
    occurrence: { clientOriginAtMs: null },
  } as const;
}

type TestGrantOptions = GrantAuthorityOptions & {
  setNow: (value: number) => void;
  setScopeStatus: (value: "empty" | "conflict" | undefined) => void;
  setScopeEventGameId: (value: string) => void;
  setSessionResolution: (value: ControlGrantSessionResolution | undefined) => void;
};

function createGrantOptions(eventGameId: string): TestGrantOptions {
  let call = 0;
  let nowMs = 10_000;
  let scopeStatus: "empty" | "conflict" | undefined;
  let resolvedEventGameId = eventGameId;
  let sessionResolution: ControlGrantSessionResolution | undefined;
  return {
    environmentId: "live-control-test",
    clock: { nowMs: () => nowMs },
    randomness: {
      bytes: (length) => {
        call += 1;
        return Uint8Array.from({ length }, (_, index) => (index + call + length) % 256);
      },
    },
    keyRing: createKeyRing(),
    controlScopeResolver: {
      resolve: () =>
        scopeStatus === undefined
          ? { status: "eligible", eventGameId: resolvedEventGameId }
          : { status: scopeStatus },
      resolveSession: (_scope, sessionEventGameId) =>
        sessionResolution ??
        (sessionEventGameId === resolvedEventGameId
          ? { status: "current", eventGameId: resolvedEventGameId }
          : { status: "mismatch" }),
    },
    privilegedAuthorityVerifier: createGrantTestAuthorityVerifier(),
    setNow(value: number) {
      nowMs = value;
    },
    setScopeStatus(value) {
      scopeStatus = value;
    },
    setScopeEventGameId(value) {
      resolvedEventGameId = value;
    },
    setSessionResolution(value) {
      sessionResolution = value;
    },
  };
}

async function ownerState(harness: Awaited<ReturnType<typeof createHarness>>) {
  return harness.storage.transaction((transaction) => ({
    actions: transaction.listActions(harness.root.recordId),
    metadata: transaction.readRecordMetadata(harness.root.recordId),
    recordAudits: transaction.listAuditEntries(harness.root.recordId),
    grantAudits: transaction.listGrantAudit(harness.grantId),
    grantSessions: transaction.listGrantSessions(harness.grantId),
  }));
}

function createKeyRing(): GrantKeyRing {
  return {
    encryption: { currentVersion: "encryption-v1", keys: new Map([["encryption-v1", bytes(1)]]) },
    lookup: { currentVersion: "lookup-v1", keys: new Map([["lookup-v1", bytes(33)]]) },
    audit: { currentVersion: "audit-v1", keys: new Map([["audit-v1", bytes(65)]]) },
  };
}

function bytes(start: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => start + index);
}

function createRoot(eventGameId: string, sideSuffix = ""): EventGameRecordRoot {
  return {
    recordId: `record-${eventGameId}`,
    eventId: "event-live-control",
    eventGameId,
    ownership: { eventId: "event-live-control", eventGameId },
    externalScope: {
      eventId: "event-live-control",
      gameDayId: "day-1",
      pitchId: "pitch-1",
      pitchSlotId: `slot-${eventGameId}`,
    },
    gameSides: [
      {
        id: `side-a${sideSuffix}`,
        eventTeamId: `team-a${sideSuffix}`,
        teamInterpretationRef: `team-a${sideSuffix}-v1`,
      },
      {
        id: `side-b${sideSuffix}`,
        eventTeamId: `team-b${sideSuffix}`,
        teamInterpretationRef: `team-b${sideSuffix}-v1`,
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
      operationId: `register-${eventGameId}`,
      actorReference: "actor-test",
      source: "event-game-registration",
      createdAtMs: 500,
    },
  };
}

function createScopeResolver(root: EventGameRecordRoot) {
  return {
    resolve(scope: EventGameRecordRoot["externalScope"]) {
      return JSON.stringify(scope) === JSON.stringify(root.externalScope)
        ? { status: "resolved" as const, scope: structuredClone(scope) }
        : { status: "mismatch" as const, detail: "scope mismatch" };
    },
    resolveEventTeam() {
      return { status: "resolved" as const };
    },
  };
}
