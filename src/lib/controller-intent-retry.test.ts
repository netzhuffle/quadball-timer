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
