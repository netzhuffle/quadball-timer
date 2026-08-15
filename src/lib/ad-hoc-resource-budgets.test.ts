import { describe, expect, test } from "bun:test";
import {
  AD_HOC_CREATION_IMMEDIATE_ATTEMPTS,
  AD_HOC_CREATION_MAX_DELAY_MS,
  AD_HOC_CONTROLLER_BURST,
  AD_HOC_CONTROLLER_SUSTAINED_PER_SECOND,
  AD_HOC_GAME_BURST,
  AD_HOC_GAME_SUSTAINED_PER_SECOND,
  AD_HOC_REPLAY_BURST,
  AD_HOC_REPLAY_SUSTAINED_PER_SECOND,
  adHocCreationDelayMs,
  consumeAdHocTokens,
} from "@/lib/ad-hoc-resource-budgets";
import { createAdHocGamesService, type AdHocGamesService } from "@/lib/ad-hoc-games";

async function drainScheduled<T>(promise: Promise<T>, queue: (() => void)[]): Promise<T> {
  let settled = false;
  void promise.finally(() => {
    settled = true;
  });
  while (!settled) {
    const task = queue.shift();
    if (task === undefined) {
      await Promise.resolve();
      continue;
    }
    task();
    await Promise.resolve();
    await Promise.resolve();
  }
  return promise;
}

describe("Ad Hoc resource budgets", () => {
  test("delays only later source attempts and caps the retry guidance", () => {
    expect(adHocCreationDelayMs(AD_HOC_CREATION_IMMEDIATE_ATTEMPTS - 1)).toBe(0);
    expect(adHocCreationDelayMs(AD_HOC_CREATION_IMMEDIATE_ATTEMPTS)).toBe(1_000);
    expect(adHocCreationDelayMs(AD_HOC_CREATION_IMMEDIATE_ATTEMPTS + 1)).toBe(2_000);
    expect(adHocCreationDelayMs(100)).toBe(AD_HOC_CREATION_MAX_DELAY_MS);
  });

  test("keeps Controller, Game, and replay buckets distinct with burst and refill semantics", () => {
    const controller = consumeAdHocTokens(
      undefined,
      1_000,
      AD_HOC_CONTROLLER_BURST,
      AD_HOC_CONTROLLER_SUSTAINED_PER_SECOND,
      AD_HOC_CONTROLLER_BURST,
    );
    const game = consumeAdHocTokens(
      undefined,
      1_000,
      AD_HOC_GAME_BURST,
      AD_HOC_GAME_SUSTAINED_PER_SECOND,
      AD_HOC_GAME_BURST,
    );
    const replay = consumeAdHocTokens(
      undefined,
      1_000,
      AD_HOC_REPLAY_BURST,
      AD_HOC_REPLAY_SUSTAINED_PER_SECOND,
      AD_HOC_REPLAY_BURST,
    );

    expect(controller.accepted).toBe(true);
    expect(game.accepted).toBe(true);
    expect(replay.accepted).toBe(true);
    expect(
      consumeAdHocTokens(
        controller.accepted ? controller.bucket : undefined,
        1_000,
        AD_HOC_CONTROLLER_BURST,
        AD_HOC_CONTROLLER_SUSTAINED_PER_SECOND,
        1,
      ),
    ).toMatchObject({ accepted: false });
    expect(
      consumeAdHocTokens(
        controller.accepted ? controller.bucket : undefined,
        2_000,
        AD_HOC_CONTROLLER_BURST,
        AD_HOC_CONTROLLER_SUSTAINED_PER_SECOND,
        AD_HOC_CONTROLLER_SUSTAINED_PER_SECOND,
      ),
    ).toMatchObject({ accepted: true });
  });

  test("does not retain delayed or globally exhausted creation attempts", async () => {
    let nowMs = 1_000;
    const service = createAdHocGamesService({ now: () => nowMs });
    for (let index = 0; index < AD_HOC_CREATION_IMMEDIATE_ATTEMPTS; index += 1) {
      expect(
        (await service.create({ homeName: `Home ${index}`, awayName: "Away", sourceKey: "same" }))
          .status,
      ).toBe("accepted");
    }
    const beforeDelayed = service.store.listGames().length;
    const delayed = await service.create({
      homeName: "Delayed",
      awayName: "Away",
      sourceKey: "same",
    });
    expect(delayed).toMatchObject({ status: "rejected", reason: "rate-limited" });
    if (delayed.status === "rejected") {
      expect(delayed.detail).toBe("Try again later.");
      expect(delayed.retryAfterMs).toBeGreaterThan(0);
      expect(delayed.retryAfterMs).toBeLessThanOrEqual(AD_HOC_CREATION_MAX_DELAY_MS);
    }
    expect(service.store.listGames()).toHaveLength(beforeDelayed);

    nowMs += 10 * 60_000;
    expect(
      (await service.create({ homeName: "New window", awayName: "Away", sourceKey: "same" }))
        .status,
    ).toBe("accepted");

    for (let index = 0; index < 24; index += 1) {
      expect(
        (
          await service.create({
            homeName: `Global ${index}`,
            awayName: "Away",
            sourceKey: `source-${index}`,
          })
        ).status,
      ).toBe("accepted");
    }
    const beforeGlobal = service.store.listGames().length;
    const global = await service.create({
      homeName: "Global limit",
      awayName: "Away",
      sourceKey: "source-global-limit",
    });
    expect(global).toMatchObject({ status: "rejected", reason: "rate-limited" });
    expect(service.store.listGames()).toHaveLength(beforeGlobal);
  });

  test("requires a retry window and then admits the same anonymous source", async () => {
    let nowMs = 1_000;
    const service = createAdHocGamesService({ now: () => nowMs });
    for (let index = 0; index < AD_HOC_CREATION_IMMEDIATE_ATTEMPTS; index += 1)
      await service.create({ homeName: `Home ${index}`, awayName: "Away", sourceKey: "cookie-a" });
    const limited = await service.create({
      homeName: "Busy",
      awayName: "Away",
      sourceKey: "cookie-a",
    });
    expect(limited).toMatchObject({ status: "rejected", retryAfterMs: 1_000 });
    nowMs += 1_000;
    expect(
      (await service.create({ homeName: "Retry", awayName: "Away", sourceKey: "cookie-a" })).status,
    ).toBe("accepted");
  });

  test("rejects Ad Hoc action saturation without sharing Event capacity", async () => {
    const service = createAdHocGamesService({ now: () => 1_000 });
    const created = await service.create({ homeName: "Home", awayName: "Away" });
    if (created.status !== "accepted") throw new Error("creation failed");
    const operations = Array.from({ length: AD_HOC_CONTROLLER_BURST }, (_, index) => ({
      id: `burst-${index}`,
      clientSentAtMs: 1_000,
      command: { type: "set-running", running: index % 2 === 0 },
    })) as never[];
    expect(
      (await service.apply({ gameId: created.gameId, sessionId: created.sessionId, operations }))
        .status,
    ).toBe("accepted");
    const rejected = await service.apply({
      gameId: created.gameId,
      sessionId: created.sessionId,
      operations: [
        {
          id: "over-burst",
          clientSentAtMs: 1_000,
          command: { type: "set-running", running: true },
        },
      ],
    });
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: "rate-limited",
      detail: "Try again later.",
    });
    expect(service.getResourceMetrics().actionRateExhausted).toBeGreaterThan(0);

    const second = await service.create({ homeName: "Second", awayName: "Away" });
    if (second.status !== "accepted") throw new Error("second creation failed");
    expect(
      (
        await service.apply({
          gameId: second.gameId,
          sessionId: second.sessionId,
          operations: [
            {
              id: "independent-game-operation",
              clientSentAtMs: 1_000,
              command: { type: "set-running", running: true },
            },
          ],
        })
      ).status,
    ).toBe("accepted");
  });

  test("charges accepted operations only and keeps replay acknowledgement explicit", async () => {
    let nowMs = 1_000;
    const scheduled: (() => void)[] = [];
    const service = createAdHocGamesService({
      now: () => nowMs,
      deferReplayAcknowledgement: true,
      schedule: (_delayMs, task) => scheduled.push(task),
    });
    const created = await service.create({ homeName: "Home", awayName: "Away" });
    if (created.status !== "accepted") throw new Error("creation failed");
    const admitted = await service.admit({ gameId: created.gameId, controlQr: created.controlQr });
    if (admitted.status !== "accepted") throw new Error("admission failed");
    const firstControllerOperations = Array.from({ length: 20 }, (_, index) => ({
      id: `accepted-${index}`,
      clientSentAtMs: 1_000,
      command: { type: "set-running", running: index % 2 === 0 },
    })) as never[];
    const first = await drainScheduled(
      service.apply({
        gameId: created.gameId,
        sessionId: created.sessionId,
        operations: firstControllerOperations,
      }),
      scheduled,
    );
    expect(first.status).toBe("accepted");
    if (first.status !== "accepted" || first.replayId === undefined)
      throw new Error("replay missing");
    await service.acknowledgeReplay({
      sessionId: created.sessionId,
      replayId: first.replayId,
      delivered: true,
    });
    nowMs += 1_000;
    const secondFirstController = await drainScheduled(
      service.apply({
        gameId: created.gameId,
        sessionId: created.sessionId,
        operations: Array.from({ length: 20 }, (_, index) => ({
          id: `accepted-again-${index}`,
          clientSentAtMs: 1_000,
          command: { type: "set-running", running: index % 2 === 0 },
        })) as never[],
      }),
      scheduled,
    );
    expect(secondFirstController.status).toBe("accepted");
    if (secondFirstController.status !== "accepted" || secondFirstController.replayId === undefined)
      throw new Error("second replay missing");
    await service.acknowledgeReplay({
      sessionId: created.sessionId,
      replayId: secondFirstController.replayId,
      delivered: true,
    });
    const blocked = await drainScheduled(
      service.apply({
        gameId: created.gameId,
        sessionId: created.sessionId,
        operations: [
          {
            id: "blocked",
            clientSentAtMs: 1_000,
            causalPredecessorIds: ["missing"],
            command: { type: "set-running", running: true },
          },
        ],
      }),
      scheduled,
    );
    expect(blocked.status).toBe("accepted");
    if (blocked.status === "accepted") {
      expect(blocked.outcomes.find((outcome) => outcome.operationId === "blocked")?.status).toBe(
        "rejected",
      );
      if (blocked.replayId !== undefined)
        await service.acknowledgeReplay({
          sessionId: created.sessionId,
          replayId: blocked.replayId,
          delivered: true,
        });
    }
    await service.acknowledgeReplay({
      sessionId: created.sessionId,
      replayId: secondFirstController.replayId,
      delivered: true,
    });
    const second = await drainScheduled(
      service.apply({
        gameId: created.gameId,
        sessionId: admitted.game.sessionId,
        operations: Array.from({ length: 10 }, (_, index) => ({
          id: `second-${index}`,
          clientSentAtMs: 1_000,
          command: { type: "set-running", running: index % 2 === 0 },
        })) as never[],
      }),
      scheduled,
    );
    expect(second.status).toBe("accepted");
  });

  test("accepts a 100-operation replay and schedules durable chunks at 20 per second", async () => {
    const scheduled: (() => void)[] = [];
    const delays: number[] = [];
    const service = createAdHocGamesService({
      now: () => 1_000,
      deferReplayAcknowledgement: true,
      schedule: (delayMs, task) => {
        delays.push(delayMs);
        scheduled.push(task);
      },
    });
    const created = await service.create({ homeName: "Home", awayName: "Away" });
    if (created.status !== "accepted") throw new Error("creation failed");
    const operations = Array.from({ length: 100 }, (_, index) => ({
      id: `scheduled-${index}`,
      clientSentAtMs: 1_000,
      command: { type: "set-running", running: index % 2 === 0 },
    })) as never[];
    const pending = service.apply({
      gameId: created.gameId,
      sessionId: created.sessionId,
      operations,
    });
    expect(scheduled).toHaveLength(1);
    const result = await drainScheduled(pending, scheduled);
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") {
      expect(result.ackedOperationIds).toHaveLength(100);
      expect(result.outcomes).toHaveLength(100);
    }
    expect(delays).toEqual([0, 1_000, 1_000, 1_000, 1_000]);
  });

  test("prevalidates a malformed later operation without scheduling or mutating", async () => {
    const scheduled: (() => void)[] = [];
    const service = createAdHocGamesService({
      now: () => 1_000,
      deferReplayAcknowledgement: true,
      schedule: (_delayMs, task) => scheduled.push(task),
    });
    const created = await service.create({ homeName: "Home", awayName: "Away" });
    if (created.status !== "accepted") throw new Error("creation failed");
    const before = service.store.readGame(created.gameId);
    const rejected = await service.apply({
      gameId: created.gameId,
      sessionId: created.sessionId,
      operations: [
        {
          id: "valid-before-malformed",
          clientSentAtMs: 1_000,
          command: { type: "set-running", running: true },
        },
        {
          id: "malformed-later",
          clientSentAtMs: 1_001,
          command: { type: "not-a-game-command" },
        },
      ] as never[],
    });
    expect(rejected).toMatchObject({ status: "rejected", reason: "invalid-operation" });
    expect(scheduled).toHaveLength(0);
    expect(service.store.readGame(created.gameId)).toEqual(before);
  });

  test("causally orders a later-position predecessor across scheduled chunks", async () => {
    const scheduled: (() => void)[] = [];
    const service = createAdHocGamesService({
      now: () => 1_000,
      deferReplayAcknowledgement: true,
      schedule: (_delayMs, task) => scheduled.push(task),
    });
    const created = await service.create({ homeName: "Home", awayName: "Away" });
    if (created.status !== "accepted") throw new Error("creation failed");
    const operations = [
      {
        id: "dependent-first",
        clientSentAtMs: 2_001,
        causalPredecessorIds: ["predecessor-later"],
        command: { type: "change-score", team: "home", delta: 10, reason: "goal" },
      },
      ...Array.from({ length: 19 }, (_, index) => ({
        id: `before-${index}`,
        clientSentAtMs: 1_000 + index,
        command: { type: "change-score", team: "home", delta: 10, reason: "goal" },
      })),
      {
        id: "predecessor-later",
        clientSentAtMs: 2_000,
        command: { type: "change-score", team: "home", delta: 10, reason: "goal" },
      },
      ...Array.from({ length: 19 }, (_, index) => ({
        id: `after-${index}`,
        clientSentAtMs: 3_000 + index,
        command: { type: "change-score", team: "home", delta: 10, reason: "goal" },
      })),
    ] as never[];
    const pending = service.apply({
      gameId: created.gameId,
      sessionId: created.sessionId,
      operations,
    });
    const result = await drainScheduled(pending, scheduled);
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") {
      expect(result.ackedOperationIds).toHaveLength(40);
      expect(
        result.outcomes.find((outcome) => outcome.operationId === "dependent-first")?.status,
      ).toBe("accepted");
      expect(result.game.state.score.home).toBe(400);
    }
  });

  test("preserves whole-batch causal blocking across scheduled chunks", async () => {
    const scheduled: (() => void)[] = [];
    const service = createAdHocGamesService({
      now: () => 1_000,
      deferReplayAcknowledgement: true,
      schedule: (_delayMs, task) => scheduled.push(task),
    });
    const created = await service.create({ homeName: "Home", awayName: "Away" });
    if (created.status !== "accepted") throw new Error("creation failed");
    const operations = [
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `causal-before-${index}`,
        clientSentAtMs: 1_000 + index,
        command: { type: "change-score", team: "home", delta: 10, reason: "goal" },
      })),
      {
        id: "missing-predecessor",
        clientSentAtMs: 2_000,
        causalPredecessorIds: ["not-retained"],
        command: { type: "change-score", team: "home", delta: 10, reason: "goal" },
      },
      {
        id: "blocked-dependent",
        clientSentAtMs: 2_001,
        causalPredecessorIds: ["missing-predecessor"],
        command: { type: "change-score", team: "home", delta: 10, reason: "goal" },
      },
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `causal-after-${index}`,
        clientSentAtMs: 3_000 + index,
        command: { type: "change-score", team: "home", delta: 10, reason: "goal" },
      })),
    ] as never[];
    const result = await drainScheduled(
      service.apply({
        gameId: created.gameId,
        sessionId: created.sessionId,
        operations,
      }),
      scheduled,
    );
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") {
      expect(
        result.outcomes.find((outcome) => outcome.operationId === "missing-predecessor")?.status,
      ).toBe("rejected");
      expect(
        result.outcomes.find((outcome) => outcome.operationId === "blocked-dependent")?.status,
      ).toBe("causally-blocked");
      expect(result.game.state.score.home).toBe(400);
    }
  });

  test("reconciles a concurrent rejected predecessor before applying a dependent chunk", async () => {
    const scheduled: { delayMs: number; task: () => void }[] = [];
    const service = createAdHocGamesService({
      now: () => 1_000,
      deferReplayAcknowledgement: true,
      schedule: (delayMs, task) => scheduled.push({ delayMs, task }),
    });
    const created = await service.create({ homeName: "Home", awayName: "Away" });
    if (created.status !== "accepted") throw new Error("creation failed");
    const second = await service.admit({ gameId: created.gameId, controlQr: created.controlQr });
    if (second.status !== "accepted") throw new Error("second admission failed");
    const predecessor = {
      id: "same-fingerprint-predecessor",
      clientSentAtMs: 2_000,
      causalPredecessorIds: ["batch-root"],
      command: { type: "set-running", running: true },
    };
    const dependent = {
      id: "dependent-after-concurrent-rejection",
      clientSentAtMs: 2_001,
      causalPredecessorIds: [predecessor.id],
      command: { type: "set-running", running: false },
    };
    const pending = service.apply({
      gameId: created.gameId,
      sessionId: created.sessionId,
      operations: [
        ...Array.from({ length: 20 }, (_, index) => ({
          id: `batch-unrelated-${index}`,
          clientSentAtMs: 1_000 + index,
          command: { type: "set-running", running: index % 2 === 0 },
        })),
        {
          id: "batch-root",
          clientSentAtMs: 2_000,
          command: { type: "set-running", running: true },
        },
        predecessor,
        dependent,
      ] as never[],
    });
    const initial = scheduled.shift();
    expect(initial?.delayMs).toBe(0);
    initial?.task();
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduled[0]?.delayMs).toBe(1_000);

    const competing = service.apply({
      gameId: created.gameId,
      sessionId: second.game.sessionId,
      operations: [predecessor] as never[],
    });
    const competingTask = scheduled.pop();
    expect(competingTask?.delayMs).toBe(0);
    competingTask?.task();
    await Promise.resolve();
    await Promise.resolve();
    const competingResult = await competing;
    expect(competingResult.status).toBe("accepted");
    if (competingResult.status === "accepted" && competingResult.replayId !== undefined) {
      await service.acknowledgeReplay({
        sessionId: second.game.sessionId,
        replayId: competingResult.replayId,
        delivered: true,
      });
    }

    scheduled.shift()?.task();
    await Promise.resolve();
    await Promise.resolve();
    const result = await pending;
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") {
      expect(
        result.outcomes.find((outcome) => outcome.operationId === predecessor.id)?.status,
      ).toBe("rejected");
      expect(result.outcomes.find((outcome) => outcome.operationId === dependent.id)?.status).toBe(
        "causally-blocked",
      );
    }
    const retained = service.store.readGame(created.gameId);
    expect(retained?.operations[predecessor.id]?.status).toBe("rejected");
    expect(retained?.operations[dependent.id]?.status).toBe("causally-blocked");
  });

  test("cancels pending replay work on service close without acknowledging it", async () => {
    const scheduled: (() => void)[] = [];
    const service = createAdHocGamesService({
      deferReplayAcknowledgement: true,
      schedule: (_delayMs, task) => scheduled.push(task),
    });
    const created = await service.create({ homeName: "Home", awayName: "Away" });
    if (created.status !== "accepted") throw new Error("creation failed");
    const pending = service.apply({
      gameId: created.gameId,
      sessionId: created.sessionId,
      operations: [
        {
          id: "close-before-apply",
          clientSentAtMs: 1_000,
          command: { type: "set-running", running: true },
        },
      ],
    });
    service.close();
    expect(await pending).toMatchObject({ status: "rejected", reason: "unavailable" });
    scheduled.shift()?.();
    expect(scheduled).toHaveLength(0);
    expect(service.store.listGames()).toHaveLength(1);
  });

  test("does not schedule a later replay chunk after an in-flight close", async () => {
    const scheduled: { delayMs: number; task: () => void }[] = [];
    let service!: AdHocGamesService;
    service = createAdHocGamesService({
      deferReplayAcknowledgement: true,
      schedule: (delayMs, task) => scheduled.push({ delayMs, task }),
    });
    const created = await service.create({ homeName: "Home", awayName: "Away" });
    if (created.status !== "accepted") throw new Error("creation failed");
    const pending = service.apply({
      gameId: created.gameId,
      sessionId: created.sessionId,
      operations: Array.from({ length: 40 }, (_, index) => ({
        id: `close-in-flight-${index}`,
        clientSentAtMs: 1_000,
        command: { type: "set-running", running: index % 2 === 0 },
      })) as never[],
    });
    expect(scheduled).toHaveLength(1);
    scheduled.shift()!.task();
    service.close();
    expect(await pending).toMatchObject({ status: "rejected", reason: "unavailable" });
    await Promise.resolve();
    expect(scheduled).toHaveLength(0);
  });

  test("counts socket instances before ownership and exposes Event reserve pressure", async () => {
    let activeEventConnections = 0;
    const service = createAdHocGamesService({
      now: () => 1_000,
      maxConnectedSockets: 2,
      eventCapacity: {
        totalConnections: 3,
        reservedConnections: 1,
        activeConnections: () => activeEventConnections,
      },
    });
    const first = await service.create({ homeName: "One", awayName: "Away" });
    const second = await service.create({ homeName: "Two", awayName: "Away" });
    if (first.status !== "accepted" || second.status !== "accepted")
      throw new Error("creation failed");
    expect(
      await service.setConnection({
        gameId: first.gameId,
        sessionId: first.sessionId,
        connected: true,
        connectionId: "socket-1",
      }),
    ).toBe(true);
    expect(
      await service.setConnection({
        gameId: first.gameId,
        sessionId: first.sessionId,
        connected: true,
        connectionId: "socket-2",
      }),
    ).toBe(true);
    expect(
      await service.setConnection({
        gameId: second.gameId,
        sessionId: second.sessionId,
        connected: true,
        connectionId: "socket-3",
      }),
    ).toBe(false);
    expect(service.getResourceMetrics()).toMatchObject({
      connectedControllers: 2,
      eventReservedCapacity: { configured: 1, active: 0, availableForAdHoc: 2 },
    });
    expect(
      await service.setConnection({
        gameId: first.gameId,
        sessionId: first.sessionId,
        connected: false,
        connectionId: "socket-1",
      }),
    ).toBe(true);
    expect(service.getResourceMetrics().connectedControllers).toBe(1);
    activeEventConnections = 1;
    expect(service.getResourceMetrics().eventReservedCapacity).toMatchObject({
      active: 1,
      availableForAdHoc: 2,
    });
  });
});
