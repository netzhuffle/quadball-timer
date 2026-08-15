import { describe, expect, test } from "bun:test";
import {
  retainControllerIntent,
  type PendingControllerIntent,
} from "@/lib/controller-intent-retry";
import type { LiveEventControllerIntent } from "@/lib/live-event-game-control";

describe("Controller tap retry identity", () => {
  test("reuses the pending operation and fact identity after an uncertain response", () => {
    const first = intent("record-goal", { gameSideId: "side-a" });
    const retry = retainControllerIntent(first, intent("record-goal", { gameSideId: "side-a" }));

    expect(retry).toEqual(first);
    expect(JSON.stringify(retry)).toBe(JSON.stringify(first));
    expect(
      retainControllerIntent(first, intent("record-goal", { gameSideId: "side-b" })),
    ).not.toEqual(first);
  });

  test("uses one immutable pending seam for every controller intent", () => {
    const cases: LiveEventControllerIntent[] = [
      intent("record-goal", { gameSideId: "side-a" }),
      intent("clock", { running: true }),
      intent("substantive", { trigger: "card" }),
      intent("substantive", { trigger: "timeout" }),
      intent("substantive", { trigger: "suspension" }),
      intent("substantive", { trigger: "result" }),
      intent("reset"),
      intent("undo"),
    ];
    for (const first of cases) {
      const retry = retainControllerIntent(first as PendingControllerIntent, {
        ...first,
        operationId: `${first.operationId}-new`,
        factId: `${first.factId}-new`,
      });
      expect(retry).toBe(first);
    }
    const scored = intent("record-flag-catch", {
      gameSideId: "side-a",
      sportingOrderAdjudication: { relatedFactId: "goal", relation: "before" },
    });
    expect(
      retainControllerIntent(scored, {
        ...scored,
        sportingOrderOverride: {
          guardrail: "sporting-order-adjudication",
          direction: "head-referee-adjudicated-sporting-order",
          confirmation: "head-referee-confirmed",
          authorityReference: "head-referee",
          gameTimeMs: 0,
          beforeValue: null,
          afterValue: null,
          reason: "head-referee-direction",
        },
      }),
    ).not.toBe(scored);
    const forfeit = intent("substantive", {
      trigger: "forfeit",
      gameSideId: "side-a",
    }) as Extract<LiveEventControllerIntent, { type: "substantive" }>;
    expect(retainControllerIntent(forfeit, { ...forfeit, gameSideId: "side-b" })).not.toBe(forfeit);
  });

  test("does not reuse identities when durable ordering or Clock authority semantics change", () => {
    const doubleForfeit = intent("record-double-forfeit", { sportingOrder: 10 });
    expect(retainControllerIntent(doubleForfeit, { ...doubleForfeit, sportingOrder: 11 })).not.toBe(
      doubleForfeit,
    );

    const clock = intent("clock-adjust", {
      adjustmentMs: 1_000,
      clockGeneration: 2,
      occurrence: { clientOriginAtMs: 1, source: "online" },
    });
    expect(retainControllerIntent(clock, { ...clock, clockGeneration: 3 })).not.toBe(clock);
    expect(
      retainControllerIntent(clock, {
        ...clock,
        occurrence: { clientOriginAtMs: 1, source: "offline" },
      }),
    ).not.toBe(clock);
  });
});

function intent(
  type: LiveEventControllerIntent["type"],
  extra: Record<string, unknown> = {},
): LiveEventControllerIntent {
  return {
    version: "live-event-control-intent-v1",
    type,
    operationId: crypto.randomUUID(),
    factId: crypto.randomUUID(),
    gameTimeMs: 0,
    occurrence: { clientOriginAtMs: Date.now() },
    ...extra,
  } as LiveEventControllerIntent;
}
