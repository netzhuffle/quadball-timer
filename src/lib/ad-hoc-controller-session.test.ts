import { describe, expect, test } from "bun:test";
import {
  parseAdHocControllerSession,
  serializeAdHocControllerSession,
  type AdHocControllerSession,
} from "@/lib/ad-hoc-controller-session";
import { createInitialGameState } from "@/lib/game-engine";

function session(): AdHocControllerSession {
  return {
    version: "ad-hoc-controller-session-v1",
    workflow: "ad-hoc",
    gameId: "adhoc-codec-test",
    state: createInitialGameState({ id: "adhoc-codec-test", nowMs: 1_000 }),
    authoritativeState: createInitialGameState({ id: "adhoc-codec-test", nowMs: 1_000 }),
    pendingOperations: [
      {
        id: "offline-1",
        clientSentAtMs: 1_001,
        command: { type: "set-running", running: true },
        workflow: "ad-hoc",
        causalPredecessorIds: [],
      },
    ],
    outcomes: {},
    operationCounter: 1,
    savedAtMs: 1_001,
  };
}

describe("Ad Hoc Controller session codecs", () => {
  test("round-trips the deep GameState and authoritative base", () => {
    const parsed = parseAdHocControllerSession(
      serializeAdHocControllerSession(session()),
      "adhoc-codec-test",
    );
    expect(parsed?.authoritativeState?.id).toBe("adhoc-codec-test");
  });

  test("rejects corrupt branches, unsafe counters, and causal self references", () => {
    const value = JSON.parse(serializeAdHocControllerSession(session())) as Record<string, unknown>;
    (value.state as Record<string, unknown>).score = null;
    expect(parseAdHocControllerSession(JSON.stringify(value), "adhoc-codec-test")).toBeNull();

    const counterCorrupt = JSON.parse(serializeAdHocControllerSession(session())) as Record<
      string,
      unknown
    >;
    counterCorrupt.operationCounter = Number.MAX_SAFE_INTEGER + 1;
    expect(
      parseAdHocControllerSession(JSON.stringify(counterCorrupt), "adhoc-codec-test"),
    ).toBeNull();

    const causalCorrupt = JSON.parse(serializeAdHocControllerSession(session())) as Record<
      string,
      unknown
    >;
    const pending = causalCorrupt.pendingOperations as Array<Record<string, unknown>>;
    pending[0]!.causalPredecessorIds = ["offline-1"];
    expect(
      parseAdHocControllerSession(JSON.stringify(causalCorrupt), "adhoc-codec-test"),
    ).toBeNull();
  });
});
