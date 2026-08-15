import { applyGameCommand, projectGameView } from "@/lib/game-engine";
import type { GameCommand, GameState, GameView } from "@/lib/game-types";

/** Policy-neutral sporting interpretation shared by live Event and Ad Hoc Controllers. */
export type IqaSportingRules = {
  version: string;
  apply(input: {
    state: GameState;
    command: GameCommand;
    nowMs: number;
    idGenerator: () => string;
  }): GameState;
  project(state: GameState, nowMs: number): GameView;
};

export const DEFAULT_IQA_SPORTING_RULES: IqaSportingRules = {
  version: "iqa-game-rules-v1",
  apply: applyGameCommand,
  project: projectGameView,
};
