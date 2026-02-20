export type TeamId = "home" | "away";

export type CardType = "blue" | "yellow" | "red" | "ejection";

export type PendingExpirationReason = "score" | "flag-catch";

export type ControllerRole = "controller" | "spectator";

export type PenaltySegment = {
  id: string;
  cardType: Exclude<CardType, "ejection">;
  remainingMs: number;
  expirableByScore: boolean;
};

export type PlayerPenaltyState = {
  key: string;
  team: TeamId;
  playerNumber: number | null;
  segments: PenaltySegment[];
};

export type PendingPenaltyExpiration = {
  id: string;
  penalizedTeam: TeamId;
  benefitingTeam: TeamId;
  reason: PendingExpirationReason;
  createdAtMs: number;
  candidatePlayerKeys: string[];
  expireMs: number;
  resolvedAtMs: number | null;
  resolvedPlayerKey: string | null;
};

export type ScoreEvent = {
  id: string;
  team: TeamId;
  points: number;
  createdAtMs: number;
  reason: "goal" | "flag-catch";
  pendingExpirationId: string | null;
  undoneAtMs: number | null;
};

export type CardEvent = {
  id: string;
  team: TeamId;
  playerKey: string | null;
  playerNumber: number | null;
  cardType: CardType;
  createdAtMs: number;
};

export type TeamTimeoutState = {
  used: boolean;
};

export type ActiveTimeout = {
  team: TeamId;
  running: boolean;
  remainingMs: number;
};

export type ReleasedPenaltyEvent = {
  id: string;
  team: TeamId;
  playerKey: string;
  playerNumber: number | null;
  releasedAtMs: number;
  reason: "served" | "expired";
};

export type GameState = {
  id: string;
  createdAtMs: number;
  updatedAtMs: number;
  homeName: string;
  awayName: string;
  gameClockMs: number;
  isRunning: boolean;
  isFinished: boolean;
  score: Record<TeamId, number>;
  scoreEvents: ScoreEvent[];
  cardEvents: CardEvent[];
  players: Record<string, PlayerPenaltyState>;
  pendingExpirations: PendingPenaltyExpiration[];
  recentReleases: ReleasedPenaltyEvent[];
  flagCatch: {
    team: TeamId;
    createdAtMs: number;
  } | null;
  timeouts: {
    home: TeamTimeoutState;
    away: TeamTimeoutState;
    active: ActiveTimeout | null;
  };
  nextUnknownPlayerId: Record<TeamId, number>;
};

export type GameSummary = {
  id: string;
  homeName: string;
  awayName: string;
  score: Record<TeamId, number>;
  gameClockMs: number;
  isRunning: boolean;
  isFinished: boolean;
  updatedAtMs: number;
};

export type GameCommand =
  | {
      type: "set-running";
      running: boolean;
    }
  | {
      type: "adjust-game-clock";
      deltaMs: number;
    }
  | {
      type: "set-game-clock";
      gameClockMs: number;
    }
  | {
      type: "change-score";
      team: TeamId;
      delta: number;
      reason: "goal" | "manual";
    }
  | {
      type: "undo-last-score";
      team: TeamId;
    }
  | {
      type: "add-card";
      team: TeamId;
      playerNumber: number | null;
      cardType: CardType;
      startedGameClockMs?: number;
    }
  | {
      type: "confirm-penalty-expiration";
      pendingId: string;
      playerKey: string | null;
    }
  | {
      type: "start-timeout";
      team: TeamId;
    }
  | {
      type: "set-timeout-running";
      running: boolean;
    }
  | {
      type: "undo-timeout-start";
    }
  | {
      type: "cancel-timeout";
    }
  | {
      type: "record-flag-catch";
      team: TeamId;
    }
  | {
      type: "rename-teams";
      homeName: string;
      awayName: string;
    }
  | {
      type: "finish-game";
    };

export type GameView = {
  state: GameState;
  seekerReleaseCountdownMs: number | null;
  seekerReleased: boolean;
  timeoutReminderActive: boolean;
  timeoutWarningActive: boolean;
  timeoutFinalCountdown: boolean;
};
