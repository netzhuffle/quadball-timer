import { describe, expect, test } from "bun:test";
import { createLiveEventGameIqaInterpreter } from "@/lib/live-event-game-control";
import { DEFAULT_AD_HOC_IQA_RULES } from "@/lib/ad-hoc-games";
import { createInitialGameState } from "@/lib/game-engine";

describe("shared IQA sporting rules contract", () => {
  test("Event and Ad Hoc use equivalent common sporting interpretations", () => {
    const eventRules = createLiveEventGameIqaInterpreter().sporting;
    if (eventRules === undefined) throw new Error("Event IQA sporting rules are missing");
    const commands = [
      { type: "change-score", team: "home", delta: 10, reason: "goal" } as const,
      { type: "set-running", running: true } as const,
      { type: "set-running", running: false } as const,
      { type: "correct-to-unfinished" } as const,
    ];
    for (const [index, command] of commands.entries()) {
      const state = createInitialGameState({ id: `adhoc-iqa-${index}`, nowMs: 1_000 });
      const input = { state, command, nowMs: 1_000 + index, idGenerator: () => `iqa-${index}` };
      expect(eventRules.apply(input)).toEqual(DEFAULT_AD_HOC_IQA_RULES.apply(input));
    }
  });
});
