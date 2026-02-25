import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ChevronDown,
  ChevronUp,
  Check,
  Clock3,
  CloudOff,
  Delete,
  Eye,
  Flag,
  ArrowLeftRight,
  OctagonX,
  Shield,
  Trophy,
  TriangleAlert,
  UserX,
  Wifi,
  WifiOff,
} from "lucide-react";
import {
  createPersistedControllerSession,
  getControllerSessionStorageKey,
  parsePersistedControllerSession,
} from "@/lib/controller-session";
import { applyGameCommand, projectGameView } from "@/lib/game-engine";
import type {
  CardType,
  ControllerRole,
  GameCommand,
  GameState,
  GameSummary,
  GameView,
  PlayerPenaltyState,
  TeamId,
} from "@/lib/game-types";
import type { ClientCommandEnvelope, ServerWsMessage } from "@/lib/ws-protocol";
import "./index.css";

type Route =
  | {
      type: "home";
    }
  | {
      type: "game";
      gameId: string;
      role: ControllerRole;
    };

type ConnectionState = "connecting" | "online" | "offline" | "local-only";
type PendingReleaseAction = {
  pendingId: string;
  reason: "score" | "flag-catch";
  expireMs: number;
};

type PendingWinConfirmation = {
  label: string;
  command: GameCommand;
};

const LOCAL_ONLY_MESSAGE = "Server does not know this game. Continuing locally on this device.";
const NORMAL_RECONNECT_DELAY_MS = 1_000;
const LOCAL_ONLY_RETRY_DELAY_MS = 60_000;
const ONE_MINUTE_MS = 60_000;
const SEEKER_RELEASE_MS = 20 * ONE_MINUTE_MS;
const SEEKER_STATUS_SHOW_FROM_MS = 18 * ONE_MINUTE_MS;
const SEEKER_STATUS_HIDE_AFTER_MS = 21 * ONE_MINUTE_MS;
const FLAG_RELEASE_MS = 19 * ONE_MINUTE_MS;
const FLAG_STATUS_SHOW_FROM_MS = 18 * ONE_MINUTE_MS;
const FLAG_STATUS_HIDE_AFTER_MS = FLAG_RELEASE_MS + 30_000;
const RELEASE_EVENT_VISIBLE_MS = 30_000;

export function App() {
  const route = useRoute();

  if (route.type === "home") {
    return <HomePage />;
  }

  return <GamePage gameId={route.gameId} role={route.role} />;
}

function HomePage() {
  const nowMs = useNow(500);
  const [games, setGames] = useState<GameSummary[]>([]);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [homeName, setHomeName] = useState("Home");
  const [awayName, setAwayName] = useState("Away");
  const reconnectTimeoutRef = useRef<number | null>(null);

  const wsUrl = useMemo(createWebSocketUrl, []);

  useEffect(() => {
    let cancelled = false;
    let currentWs: WebSocket | null = null;

    const fetchGames = async () => {
      try {
        const response = await fetch("/api/games");
        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as { games?: GameSummary[] };
        if (!cancelled && Array.isArray(payload.games)) {
          setGames(payload.games);
        }
      } catch {
        // Ignore startup fetch errors; websocket reconnect handles updates.
      }
    };

    const connect = () => {
      if (cancelled) {
        return;
      }

      setConnectionState("connecting");
      const ws = new WebSocket(wsUrl);
      currentWs = ws;

      ws.onopen = () => {
        setConnectionState("online");
        ws.send(JSON.stringify({ type: "subscribe-lobby" }));
      };

      ws.onmessage = (event) => {
        const parsed = parseServerMessage(event.data);
        if (parsed === null || parsed.type !== "lobby-snapshot") {
          return;
        }

        setClockOffsetMs(parsed.serverNowMs - Date.now());
        setGames(parsed.games);
      };

      ws.onclose = () => {
        setConnectionState("offline");
        if (!cancelled) {
          reconnectTimeoutRef.current = window.setTimeout(connect, 1_000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    void fetchGames();
    connect();

    return () => {
      cancelled = true;
      currentWs?.close();
      if (reconnectTimeoutRef.current !== null) {
        window.clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [wsUrl]);

  const nowWithOffsetMs = nowMs + clockOffsetMs;

  const handleCreateGame = useCallback(async () => {
    const response = await fetch("/api/games", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        homeName,
        awayName,
      }),
    });

    if (!response.ok) {
      return;
    }

    const payload = (await response.json()) as { gameId?: string };
    if (typeof payload.gameId === "string") {
      navigateTo(`/game/${payload.gameId}?mode=controller`);
    }
  }, [awayName, homeName]);

  return (
    <div className="mx-auto w-full max-w-5xl p-4 pb-12 sm:p-6">
      <header className="mb-6 rounded-2xl border bg-card/80 p-5 shadow-sm backdrop-blur">
        <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
          Quadball Timer
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Live Scorekeeper + Timekeeper
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Mobile-first control for game time, scores, cards, penalty timers, and spectator sync.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-[1fr_2fr]">
        <Card>
          <CardHeader>
            <CardTitle>Create Game</CardTitle>
            <CardDescription>The creator joins in controller mode.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="home-name">Home team</Label>
              <Input
                id="home-name"
                value={homeName}
                onChange={(event) => setHomeName(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="away-name">Away team</Label>
              <Input
                id="away-name"
                value={awayName}
                onChange={(event) => setAwayName(event.target.value)}
              />
            </div>
            <Button className="w-full" onClick={handleCreateGame}>
              Create new game
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Running and Past Games</CardTitle>
            <CardDescription>
              {connectionState === "online"
                ? "Live updates connected"
                : "Reconnecting live updates"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {games.length === 0 ? (
              <p className="text-sm text-muted-foreground">No games yet.</p>
            ) : (
              games.map((game) => {
                const displayClock = deriveLiveClockMs(game, nowWithOffsetMs);

                return (
                  <div
                    key={game.id}
                    className="rounded-xl border bg-background/80 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold">
                          {game.homeName} vs {game.awayName}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {game.isFinished
                            ? "Past"
                            : game.isSuspended
                              ? "Suspended"
                              : game.isRunning
                                ? "Running"
                                : "Paused"}{" "}
                          • {formatClock(displayClock)}
                        </p>
                      </div>
                      <p className="text-lg font-semibold tabular-nums">
                        {game.score.home}:{game.score.away}
                      </p>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => navigateTo(`/game/${game.id}?mode=spectator`)}
                      >
                        Spectate
                      </Button>
                      {!game.isFinished ? (
                        <Button
                          size="sm"
                          onClick={() => navigateTo(`/game/${game.id}?mode=controller`)}
                        >
                          Control
                        </Button>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function GamePage({ gameId, role }: { gameId: string; role: ControllerRole }) {
  const controller = role === "controller";
  const [activePanel, setActivePanel] = useState<"card" | "timeout" | "game">("card");
  const [homeName, setHomeName] = useState("Home");
  const [awayName, setAwayName] = useState("Away");
  const [cardDraft, setCardDraft] = useState<{
    cardType: CardType | null;
    team: TeamId | null;
    digits: string;
    startedGameClockMs: number | null;
  }>({
    cardType: null,
    team: null,
    digits: "",
    startedGameClockMs: null,
  });
  const [clockAdjustOpen, setClockAdjustOpen] = useState(false);
  const [renamingTeam, setRenamingTeam] = useState<TeamId | null>(null);
  const [pendingWinConfirmation, setPendingWinConfirmation] =
    useState<PendingWinConfirmation | null>(null);
  const [scorePulse, setScorePulse] = useState<{ home: -1 | 0 | 1; away: -1 | 0 | 1 }>({
    home: 0,
    away: 0,
  });
  const previousScoreRef = useRef<{ home: number; away: number } | null>(null);
  const scorePulseTimersRef = useRef<{ home: number | null; away: number | null }>({
    home: null,
    away: null,
  });
  const activeTeamRenameInputRef = useRef<HTMLInputElement | null>(null);
  const refocusRenameInputAfterSideSwapRef = useRef(false);
  const renameInputSelectionAfterSideSwapRef = useRef<{
    start: number | null;
    end: number | null;
    direction: "forward" | "backward" | "none" | null;
  } | null>(null);
  const leftTeamNameButtonRef = useRef<HTMLButtonElement | null>(null);
  const rightTeamNameButtonRef = useRef<HTMLButtonElement | null>(null);
  const [displayTeamNameHeightPx, setDisplayTeamNameHeightPx] = useState<number | null>(null);

  const nowMs = useNow(250);

  const {
    baseState,
    clockOffsetMs,
    dispatchCommand,
    connectionState,
    pendingCommands,
    localOnlyMode,
  } = useGameConnection({
    gameId,
    role,
  });

  useEffect(() => {
    if (baseState !== null) {
      if (renamingTeam === null) {
        setHomeName(baseState.homeName);
        setAwayName(baseState.awayName);
      }
    }
  }, [baseState, renamingTeam]);

  const syncedState = baseState;

  const gameView = useMemo(() => {
    if (syncedState === null) {
      return null;
    }

    return projectGameView(syncedState, nowMs + clockOffsetMs);
  }, [clockOffsetMs, nowMs, syncedState]);

  const liveState = gameView?.state ?? syncedState;

  const pendingExpirations = useMemo(
    () =>
      liveState?.pendingExpirations
        .filter((expiration) => expiration.resolvedAtMs === null)
        .sort((a, b) => a.createdAtMs - b.createdAtMs) ?? [],
    [liveState],
  );

  const homePenalties = useMemo(() => getTeamPenalties(liveState, "home"), [liveState]);
  const awayPenalties = useMemo(() => getTeamPenalties(liveState, "away"), [liveState]);

  const activeTimeout = gameView?.state.timeouts.active ?? null;
  const canRecordFlagCatch =
    controller &&
    gameView !== null &&
    !gameView.state.isRunning &&
    !gameView.state.isFinished &&
    !gameView.state.isSuspended &&
    !gameView.state.isOvertime &&
    gameView.seekerReleased &&
    gameView.state.flagCatch === null;
  const pendingReleaseByPlayer = useMemo(() => {
    const byPlayer: Record<string, PendingReleaseAction[]> = {};

    if (liveState === null) {
      return byPlayer;
    }

    for (const pending of pendingExpirations) {
      for (const playerKey of pending.candidatePlayerKeys) {
        const player = liveState.players[playerKey];
        if (player === undefined || player.team !== pending.penalizedTeam) {
          continue;
        }

        byPlayer[playerKey] ??= [];
        byPlayer[playerKey]?.push({
          pendingId: pending.id,
          reason: pending.reason,
          expireMs: pending.expireMs,
        });
      }
    }

    return byPlayer;
  }, [liveState, pendingExpirations]);

  const submitCard = useCallback(() => {
    if (
      !controller ||
      cardDraft.cardType === null ||
      cardDraft.team === null ||
      liveState === null
    ) {
      return;
    }

    const playerNumber = cardDraft.digits.length === 0 ? null : Number(cardDraft.digits);
    dispatchCommand({
      type: "add-card",
      team: cardDraft.team,
      cardType: cardDraft.cardType,
      playerNumber,
      startedGameClockMs: cardDraft.startedGameClockMs ?? liveState.gameClockMs,
    });

    setCardDraft({
      cardType: null,
      team: null,
      digits: "",
      startedGameClockMs: null,
    });
  }, [cardDraft, controller, dispatchCommand, liveState]);

  const adjustGameClock = useCallback(
    (deltaMs: number) => {
      if (!controller) {
        return;
      }

      dispatchCommand({
        type: "adjust-game-clock",
        deltaMs,
      });
    },
    [controller, dispatchCommand],
  );

  const saveTeamRename = useCallback(() => {
    if (!controller) {
      return;
    }

    dispatchCommand({
      type: "rename-teams",
      homeName,
      awayName,
    });
    setRenamingTeam(null);
  }, [awayName, controller, dispatchCommand, homeName]);

  const handleTeamRenameInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter") {
        return;
      }

      event.preventDefault();
      saveTeamRename();
    },
    [saveTeamRename],
  );

  const swapDisplayedTeamSides = useCallback(() => {
    if (!controller || liveState === null) {
      return;
    }

    const hasUnsavedRenameDraft =
      renamingTeam !== null && (homeName !== liveState.homeName || awayName !== liveState.awayName);
    refocusRenameInputAfterSideSwapRef.current = hasUnsavedRenameDraft;
    if (hasUnsavedRenameDraft) {
      const input = activeTeamRenameInputRef.current;
      renameInputSelectionAfterSideSwapRef.current =
        input === null
          ? null
          : {
              start: input.selectionStart,
              end: input.selectionEnd,
              direction: input.selectionDirection,
            };
    } else {
      renameInputSelectionAfterSideSwapRef.current = null;
    }
    if (!hasUnsavedRenameDraft) {
      setRenamingTeam(null);
    }

    dispatchCommand({
      type: "set-display-sides-swapped",
      swapped: !liveState.displaySidesSwapped,
    });
  }, [awayName, controller, dispatchCommand, homeName, liveState, renamingTeam]);

  const requestWinConfirmation = useCallback((label: string, command: GameCommand) => {
    setPendingWinConfirmation({ label, command });
  }, []);

  const confirmWinAction = useCallback(() => {
    if (pendingWinConfirmation === null) {
      return;
    }

    dispatchCommand(pendingWinConfirmation.command);
    setPendingWinConfirmation(null);
  }, [dispatchCommand, pendingWinConfirmation]);

  const wallNowMs = nowMs + clockOffsetMs;
  const homeRecentReleases = useMemo(
    () => getTeamRecentReleases(liveState, "home", wallNowMs),
    [liveState, wallNowMs],
  );
  const awayRecentReleases = useMemo(
    () => getTeamRecentReleases(liveState, "away", wallNowMs),
    [liveState, wallNowMs],
  );

  useEffect(() => {
    if (pendingWinConfirmation === null) {
      return;
    }

    if (liveState?.isFinished || liveState?.isSuspended) {
      setPendingWinConfirmation(null);
    }
  }, [pendingWinConfirmation, liveState?.isFinished, liveState?.isSuspended]);

  useEffect(() => {
    if (liveState === null) {
      return;
    }

    const previous = previousScoreRef.current;
    previousScoreRef.current = { home: liveState.score.home, away: liveState.score.away };

    if (previous === null) {
      return;
    }

    const updates: Partial<{ home: -1 | 0 | 1; away: -1 | 0 | 1 }> = {};
    const teams: TeamId[] = ["home", "away"];
    for (const team of teams) {
      const delta = liveState.score[team] - previous[team];
      if (delta === 0) {
        continue;
      }

      updates[team] = delta > 0 ? 1 : -1;
      const currentTimer = scorePulseTimersRef.current[team];
      if (currentTimer !== null) {
        window.clearTimeout(currentTimer);
      }

      scorePulseTimersRef.current[team] = window.setTimeout(() => {
        setScorePulse((current) => ({ ...current, [team]: 0 }));
        scorePulseTimersRef.current[team] = null;
      }, 420);
    }

    if (Object.keys(updates).length > 0) {
      setScorePulse((current) => ({ ...current, ...updates }));
    }
  }, [liveState]);

  useEffect(() => {
    return () => {
      const teams: TeamId[] = ["home", "away"];
      for (const team of teams) {
        const timer = scorePulseTimersRef.current[team];
        if (timer !== null) {
          window.clearTimeout(timer);
          scorePulseTimersRef.current[team] = null;
        }
      }
    };
  }, []);

  useEffect(() => {
    if (!clockAdjustOpen) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        setClockAdjustOpen(false);
        return;
      }

      if (target.closest('[data-clock-adjust-keep="true"]') !== null) {
        return;
      }

      setClockAdjustOpen(false);
    };

    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [clockAdjustOpen]);

  useEffect(() => {
    if (!refocusRenameInputAfterSideSwapRef.current) {
      return;
    }

    if (renamingTeam === null) {
      refocusRenameInputAfterSideSwapRef.current = false;
      return;
    }

    const input = activeTeamRenameInputRef.current;
    if (input === null) {
      return;
    }

    input.focus();
    if (typeof input.setSelectionRange === "function") {
      const savedSelection = renameInputSelectionAfterSideSwapRef.current;
      if (savedSelection !== null && savedSelection.start !== null && savedSelection.end !== null) {
        const maxPosition = input.value.length;
        const start = Math.min(savedSelection.start, maxPosition);
        const end = Math.min(savedSelection.end, maxPosition);
        input.setSelectionRange(start, end, savedSelection.direction ?? "none");
      } else {
        const cursorPosition = input.value.length;
        input.setSelectionRange(cursorPosition, cursorPosition);
      }
    }
    renameInputSelectionAfterSideSwapRef.current = null;
    refocusRenameInputAfterSideSwapRef.current = false;
  }, [liveState?.displaySidesSwapped, renamingTeam]);

  useEffect(() => {
    if (liveState === null) {
      return;
    }

    let frameId: number | null = null;

    const measure = () => {
      const left = leftTeamNameButtonRef.current;
      const right = rightTeamNameButtonRef.current;
      if (left === null || right === null) {
        return;
      }

      // Measure intrinsic clamped text height, not the previously synchronized inline height.
      const previousLeftHeight = left.style.height;
      const previousRightHeight = right.style.height;
      left.style.height = "auto";
      right.style.height = "auto";
      const nextHeight = Math.ceil(
        Math.max(left.getBoundingClientRect().height, right.getBoundingClientRect().height),
      );
      left.style.height = previousLeftHeight;
      right.style.height = previousRightHeight;
      setDisplayTeamNameHeightPx((previous) => (previous === nextHeight ? previous : nextHeight));
    };

    const scheduleMeasure = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(measure);
    };

    scheduleMeasure();
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [liveState?.awayName, liveState?.displaySidesSwapped, liveState?.homeName, renamingTeam]);

  const appendCardDigit = useCallback((digit: string) => {
    setCardDraft((previous) => {
      if (previous.digits.length >= 2) {
        return previous;
      }

      return {
        ...previous,
        digits: `${previous.digits}${digit}`,
      };
    });
  }, []);

  if (gameView === null || liveState === null) {
    return (
      <div className="mx-auto flex min-h-screen w-full max-w-3xl items-center justify-center p-6">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Loading game</CardTitle>
            <CardDescription>Waiting for snapshot from server.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => navigateTo("/")}>
              Back to games
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const state = liveState;
  const visibleHomePenalties = selectVisiblePenalties(homePenalties, pendingReleaseByPlayer, 2);
  const visibleAwayPenalties = selectVisiblePenalties(awayPenalties, pendingReleaseByPlayer, 2);
  const activeTimeoutTeamName =
    activeTimeout === null ? null : activeTimeout.team === "home" ? state.homeName : state.awayName;
  const showSeekerStatus =
    state.gameClockMs >= SEEKER_STATUS_SHOW_FROM_MS &&
    state.gameClockMs <= SEEKER_STATUS_HIDE_AFTER_MS;
  const showFlagStatus =
    state.gameClockMs >= FLAG_STATUS_SHOW_FROM_MS && state.gameClockMs <= FLAG_STATUS_HIDE_AFTER_MS;
  const flagReleased = state.gameClockMs >= FLAG_RELEASE_MS;
  const seekerRemainingMs = Math.max(0, SEEKER_RELEASE_MS - state.gameClockMs);
  const flagRemainingMs = Math.max(0, FLAG_RELEASE_MS - state.gameClockMs);
  const seekerCountdownMs = gameView.seekerReleaseCountdownMs ?? seekerRemainingMs;
  const seekerWarningRed =
    !gameView.seekerReleased && seekerCountdownMs > 0 && seekerCountdownMs <= 10_000;
  const seekerWarningYellow =
    !gameView.seekerReleased && seekerCountdownMs > 10_000 && seekerCountdownMs <= 30_000;
  const statusLabel = state.isFinished
    ? "Finished"
    : state.isSuspended
      ? "Suspended"
      : state.isRunning
        ? "Running"
        : state.isOvertime
          ? "Overtime paused"
          : "Paused";
  const winnerName =
    state.winner === null ? null : state.winner === "home" ? state.homeName : state.awayName;
  const finishSummary =
    !state.isFinished || state.finishReason === null
      ? null
      : state.finishReason === "double-forfeit"
        ? "Double forfeit"
        : winnerName === null
          ? "Game ended"
          : `${winnerName} won by ${formatFinishReason(state.finishReason)}`;
  const canSuspendGame = controller && !state.isFinished && !state.isSuspended && !state.isRunning;
  const canResumeGame = controller && !state.isFinished && state.isSuspended;
  const winConfirmationActive = pendingWinConfirmation !== null;
  const canUseEndingActions =
    controller &&
    !state.isFinished &&
    !state.isSuspended &&
    !state.isRunning &&
    !winConfirmationActive;

  const cardEntryStarted =
    cardDraft.cardType !== null ||
    cardDraft.team !== null ||
    cardDraft.digits.length > 0 ||
    cardDraft.startedGameClockMs !== null;
  const canSelectCardType =
    controller && !state.isFinished && !state.isSuspended && (!state.isRunning || cardEntryStarted);
  const canSelectCardTeam = canSelectCardType && cardDraft.cardType !== null;
  const canEditCardDigits = canSelectCardTeam;
  const canSubmitCard =
    controller &&
    !state.isFinished &&
    !state.isSuspended &&
    cardDraft.cardType !== null &&
    cardDraft.team !== null;
  const cardPlayerLabel = cardDraft.digits.length > 0 ? `#${cardDraft.digits}` : "No #";
  const cardBasePenaltyMs =
    cardDraft.cardType === "red"
      ? 2 * ONE_MINUTE_MS
      : cardDraft.cardType === "blue" || cardDraft.cardType === "yellow"
        ? ONE_MINUTE_MS
        : cardDraft.cardType === "ejection"
          ? 0
          : null;
  const elapsedCardEntryGameMs =
    cardDraft.startedGameClockMs === null
      ? 0
      : Math.max(0, state.gameClockMs - cardDraft.startedGameClockMs);
  const predictedCardRemainingMs =
    cardBasePenaltyMs === null ? null : Math.max(0, cardBasePenaltyMs - elapsedCardEntryGameMs);
  const selectedCardPlayerKey =
    cardDraft.team !== null && cardDraft.digits.length > 0
      ? `${cardDraft.team}:${Number(cardDraft.digits)}`
      : null;
  const selectedCardPlayer =
    selectedCardPlayerKey === null ? null : (state.players[selectedCardPlayerKey] ?? null);
  const selectedCardPlayerServingPenalty = hasServingPenalty(selectedCardPlayer);
  const cardAddStatusText =
    cardDraft.cardType === null || cardDraft.team === null
      ? "Remaining on add: --"
      : cardDraft.cardType === "ejection"
        ? "Remaining on add: n/a"
        : selectedCardPlayerServingPenalty
          ? `Adds on confirm: +${formatPenaltySlice(cardBasePenaltyMs ?? ONE_MINUTE_MS)}`
          : `Remaining on add: ${formatRemaining(predictedCardRemainingMs ?? ONE_MINUTE_MS)}${state.isRunning ? " (live)" : ""}`;
  const cardTypeOptions: Array<{
    type: CardType;
    label: string;
    icon: typeof Shield;
    activeClassName: string;
    idleClassName: string;
  }> = [
    {
      type: "blue",
      label: "Blue",
      icon: Shield,
      activeClassName: "border-sky-600 bg-sky-600 text-white",
      idleClassName: "border-sky-200 bg-sky-50 text-sky-800",
    },
    {
      type: "yellow",
      label: "Yellow",
      icon: TriangleAlert,
      activeClassName: "border-amber-500 bg-amber-500 text-white",
      idleClassName: "border-amber-200 bg-amber-50 text-amber-900",
    },
    {
      type: "red",
      label: "Red",
      icon: OctagonX,
      activeClassName: "border-rose-600 bg-rose-600 text-white",
      idleClassName: "border-rose-200 bg-rose-50 text-rose-800",
    },
    {
      type: "ejection",
      label: "Ejection",
      icon: UserX,
      activeClassName: "border-violet-600 bg-violet-600 text-white",
      idleClassName: "border-violet-200 bg-violet-50 text-violet-800",
    },
  ];
  const scoreColumnsByTeam: Record<
    TeamId,
    {
      team: TeamId;
      name: string;
      score: number;
      accentClassName: string;
      borderClassName: string;
      scoreBoxClassName: string;
      scoreValueBorderClassName: string;
      scoreValueGlowClassName: string;
      scoreDownButtonClassName: string;
    }
  > = {
    home: {
      team: "home",
      name: state.homeName,
      score: state.score.home,
      accentClassName: "from-sky-500/80 to-cyan-400/80",
      borderClassName: "border-cyan-300/50",
      scoreBoxClassName:
        "h-8 w-full rounded-2xl border border-sky-300 bg-gradient-to-br from-sky-500 to-cyan-500 text-white shadow-sm",
      scoreValueBorderClassName: "border-sky-200",
      scoreValueGlowClassName: "shadow-[inset_0_0_12px_rgba(14,165,233,0.18)]",
      scoreDownButtonClassName:
        "h-8 w-full rounded-2xl border-sky-200 bg-white text-sky-700 hover:bg-sky-50",
    },
    away: {
      team: "away",
      name: state.awayName,
      score: state.score.away,
      accentClassName: "from-orange-500/80 to-rose-500/80",
      borderClassName: "border-amber-300/50",
      scoreBoxClassName:
        "h-8 w-full rounded-2xl border border-orange-300 bg-gradient-to-br from-orange-500 to-rose-500 text-white shadow-sm",
      scoreValueBorderClassName: "border-orange-200",
      scoreValueGlowClassName: "shadow-[inset_0_0_12px_rgba(249,115,22,0.16)]",
      scoreDownButtonClassName:
        "h-8 w-full rounded-2xl border-orange-200 bg-white text-orange-700 hover:bg-orange-50",
    },
  };
  const leftTeam: TeamId = state.displaySidesSwapped ? "away" : "home";
  const rightTeam: TeamId = state.displaySidesSwapped ? "home" : "away";
  const displayTeamOrder: [TeamId, TeamId] = [leftTeam, rightTeam];
  const scoreColumns: Array<{
    team: TeamId;
    name: string;
    score: number;
    accentClassName: string;
    borderClassName: string;
    scoreBoxClassName: string;
    scoreValueBorderClassName: string;
    scoreValueGlowClassName: string;
    scoreDownButtonClassName: string;
  }> = displayTeamOrder.map((team) => scoreColumnsByTeam[team]);
  const homeScoreColumn = scoreColumns[0]!;
  const awayScoreColumn = scoreColumns[1]!;
  const penaltyColumnsByTeam: Record<
    TeamId,
    {
      team: TeamId;
      penalties: PlayerPenaltyView[];
      visiblePenalties: PlayerPenaltyView[];
      recentReleases: ReleasedPenaltyView[];
    }
  > = {
    home: {
      team: "home",
      penalties: homePenalties,
      visiblePenalties: visibleHomePenalties,
      recentReleases: homeRecentReleases,
    },
    away: {
      team: "away",
      penalties: awayPenalties,
      visiblePenalties: visibleAwayPenalties,
      recentReleases: awayRecentReleases,
    },
  };
  const penaltyColumns: Array<{
    team: TeamId;
    penalties: PlayerPenaltyView[];
    visiblePenalties: PlayerPenaltyView[];
    recentReleases: ReleasedPenaltyView[];
  }> = displayTeamOrder.map((team) => penaltyColumnsByTeam[team]);
  const displayTeamName = (team: TeamId) => (team === "home" ? state.homeName : state.awayName);

  return (
    <div className="h-[100dvh] overflow-hidden bg-slate-100 p-2 text-slate-900">
      <div className="mx-auto grid h-full w-full max-w-[460px] grid-rows-[auto_auto_minmax(0,1fr)_auto_auto] gap-2">
        <section className="rounded-2xl border border-slate-300 bg-white px-3 py-2 shadow-[0_8px_18px_rgba(15,23,42,0.08)]">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold tracking-wide text-slate-900">
                {state.homeName} vs {state.awayName}
              </p>
              <p className="text-[10px] text-slate-500">{role}</p>
            </div>
            <div className="flex items-center gap-1.5">
              {controller ? (
                localOnlyMode ? (
                  <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-1 text-[10px] font-semibold text-amber-800">
                    <CloudOff className="h-3 w-3" />
                    Local
                  </span>
                ) : connectionState !== "online" ? (
                  <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-1 text-[10px] font-semibold text-amber-800">
                    <WifiOff className="h-3 w-3" />
                    Offline {pendingCommands}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-2 py-1 text-[10px] font-semibold text-emerald-800">
                    <Wifi className="h-3 w-3" />
                    Live
                  </span>
                )
              ) : (
                <span className="inline-flex items-center gap-1 rounded bg-sky-100 px-2 py-1 text-[10px] font-semibold text-sky-800">
                  <Eye className="h-3 w-3" />
                  Read only
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-7 border-slate-300 bg-white px-2 text-[11px] text-slate-800 hover:bg-slate-100"
                onClick={() => navigateTo("/")}
              >
                Games
              </Button>
            </div>
          </div>
          {controller ? (
            localOnlyMode ? (
              <p className="mt-1 text-[10px] font-medium text-amber-700">{LOCAL_ONLY_MESSAGE}</p>
            ) : connectionState !== "online" ? (
              <p className="mt-1 text-[10px] font-medium text-amber-700">
                Offline mode active. {pendingCommands} local change(s) queued.
              </p>
            ) : null
          ) : null}
        </section>

        <section className="relative overflow-visible rounded-[1.75rem] border border-slate-300 bg-[radial-gradient(circle_at_50%_28%,#dbeafe_0%,#eff6ff_38%,#ffffff_76%)] px-2 py-2 shadow-[0_10px_24px_rgba(15,23,42,0.12)]">
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-1">
            <div className="flex min-w-0 flex-col items-center gap-1">
              {controller && renamingTeam === homeScoreColumn.team ? (
                <div className="grid w-full gap-1">
                  <Input
                    ref={activeTeamRenameInputRef}
                    value={homeScoreColumn.team === "home" ? homeName : awayName}
                    onChange={(event) => {
                      if (homeScoreColumn.team === "home") {
                        setHomeName(event.target.value);
                      } else {
                        setAwayName(event.target.value);
                      }
                    }}
                    onKeyDown={handleTeamRenameInputKeyDown}
                    className="h-7 border-slate-300 bg-white text-[10px] text-slate-900"
                    maxLength={40}
                  />
                  <div className="grid grid-cols-[minmax(0,1fr)_2rem] gap-1">
                    <Button
                      size="sm"
                      className="h-6 min-w-0 px-1 text-[10px]"
                      onClick={saveTeamRename}
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 w-8 min-w-0 border-slate-300 bg-white px-0 text-slate-800"
                      onClick={swapDisplayedTeamSides}
                      aria-label="Swap team sides"
                      title="Swap team sides"
                    >
                      <ArrowLeftRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  ref={leftTeamNameButtonRef}
                  style={
                    displayTeamNameHeightPx === null
                      ? undefined
                      : { height: `${displayTeamNameHeightPx}px` }
                  }
                  className="w-[calc(100%+0.75rem)] min-h-[2.6rem] max-w-none overflow-hidden whitespace-normal px-1 pt-0.5 pb-0 text-center text-[clamp(1.05rem,3.8vw,1.35rem)] leading-[1.03] font-extrabold tracking-tight text-slate-900 [display:-webkit-box] [overflow-wrap:normal] [word-break:keep-all] [-webkit-box-orient:vertical] [-webkit-line-clamp:3] transition-opacity hover:opacity-70"
                  onClick={() => {
                    if (!controller) {
                      return;
                    }

                    setHomeName(state.homeName);
                    setAwayName(state.awayName);
                    setRenamingTeam(homeScoreColumn.team);
                  }}
                >
                  {homeScoreColumn.name}
                </button>
              )}

              <Button
                size="sm"
                className={homeScoreColumn.scoreBoxClassName}
                onClick={() =>
                  dispatchCommand({
                    type: "change-score",
                    team: homeScoreColumn.team,
                    delta: 10,
                    reason: "goal",
                  })
                }
                disabled={!controller || state.isFinished}
              >
                <ChevronUp className="h-4 w-4" />
              </Button>
              <div
                className={`w-full rounded-2xl border bg-white px-2 py-2 text-center ${homeScoreColumn.scoreValueBorderClassName} ${homeScoreColumn.scoreValueGlowClassName}`}
              >
                <p
                  className={`text-[clamp(1.75rem,9.4vw,2.45rem)] leading-none font-semibold tabular-nums transition-all duration-300 ${
                    scorePulse[homeScoreColumn.team] === 1
                      ? "score-pop-up text-emerald-700"
                      : scorePulse[homeScoreColumn.team] === -1
                        ? "score-pop-down text-rose-700"
                        : "text-slate-900"
                  }`}
                >
                  {homeScoreColumn.score}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className={homeScoreColumn.scoreDownButtonClassName}
                onClick={() =>
                  dispatchCommand({ type: "undo-last-score", team: homeScoreColumn.team })
                }
                disabled={!controller}
              >
                <ChevronDown className="h-4 w-4" />
              </Button>
            </div>

            <div className="relative">
              <div className="relative flex aspect-square w-[min(47vw,206px)] flex-col items-center overflow-hidden rounded-full border border-sky-300/60 bg-[radial-gradient(circle,#ffffff_34%,#dbeafe_70%,#bfdbfe_100%)] p-2 pt-3 shadow-[0_0_0_1px_rgba(125,211,252,0.5),0_0_24px_rgba(14,165,233,0.22)]">
                <div
                  className="clock-rotor pointer-events-none absolute inset-0 rounded-full bg-[conic-gradient(from_0deg,rgba(14,165,233,0.22),rgba(251,146,60,0.18),rgba(14,165,233,0.22))]"
                  style={{ animationPlayState: state.isRunning ? "running" : "paused" }}
                />
                <div
                  className="clock-rotor-slow pointer-events-none absolute inset-3 rounded-full bg-[conic-gradient(from_180deg,rgba(255,255,255,0.8),rgba(14,165,233,0.14),rgba(255,255,255,0.8))]"
                  style={{ animationPlayState: state.isRunning ? "running" : "paused" }}
                />
                <div className="pointer-events-none absolute inset-2 rounded-full border border-sky-300/50" />

                <div className="relative z-10 mt-6 text-center">
                  <p className="text-[10px] font-semibold tracking-[0.18em] text-slate-700 uppercase">
                    {statusLabel}
                  </p>
                  <button
                    type="button"
                    className="mt-1 text-center"
                    data-clock-adjust-keep="true"
                    disabled={!controller}
                    onClick={() => setClockAdjustOpen((previous) => !previous)}
                  >
                    <p className="text-[clamp(2.55rem,14vw,3.5rem)] leading-none font-semibold tabular-nums text-slate-950">
                      {formatClock(gameView.state.gameClockMs)}
                    </p>
                  </button>
                </div>

                <button
                  type="button"
                  aria-label={state.isRunning ? "Pause game" : "Start game"}
                  className="absolute inset-x-2 top-[53%] bottom-2 flex items-center justify-center rounded-b-full rounded-t-[42%] transition disabled:opacity-35"
                  onClick={() =>
                    dispatchCommand({
                      type: "set-running",
                      running: !state.isRunning,
                    })
                  }
                  disabled={!controller || state.isFinished || state.isSuspended}
                >
                  <span className="relative h-20 w-20">
                    <PauseFilledGlyph
                      className={`absolute inset-0 h-20 w-20 fill-slate-900 transition-all duration-200 ${
                        state.isRunning
                          ? "scale-100 rotate-0 opacity-100"
                          : "scale-70 -rotate-10 opacity-0"
                      }`}
                    />
                    <PlayFilledGlyph
                      className={`absolute inset-0 h-20 w-20 fill-slate-900 transition-all duration-200 ${
                        state.isRunning
                          ? "scale-70 rotate-10 opacity-0"
                          : "scale-100 rotate-0 opacity-100"
                      }`}
                    />
                  </span>
                </button>
              </div>

              {showFlagStatus ? (
                <div
                  className={`pointer-events-none absolute -left-3 -bottom-0.5 w-[94px] rounded-2xl border px-2 py-1 text-center shadow-[0_6px_14px_rgba(15,23,42,0.18)] ${
                    !flagReleased && flagRemainingMs <= 10_000
                      ? "border-amber-300 bg-amber-100 text-amber-900"
                      : "border-sky-300 bg-white text-slate-800"
                  }`}
                >
                  <p className="text-[9px] font-semibold tracking-[0.14em] uppercase">Flag</p>
                  <p className="text-xs font-semibold tabular-nums">
                    {flagReleased ? "Released" : formatRemaining(flagRemainingMs)}
                  </p>
                </div>
              ) : null}

              {showSeekerStatus ? (
                <div
                  className={`pointer-events-none absolute -right-3 -bottom-0.5 w-[94px] rounded-2xl border px-2 py-1 text-center shadow-[0_6px_14px_rgba(15,23,42,0.18)] ${
                    seekerWarningRed
                      ? "animate-pulse border-red-300 bg-red-100 text-red-900"
                      : seekerWarningYellow
                        ? "border-amber-300 bg-amber-100 text-amber-900"
                        : "border-sky-300 bg-white text-slate-800"
                  }`}
                >
                  <p className="text-[9px] font-semibold tracking-[0.14em] uppercase">Seekers</p>
                  <p className="text-xs font-semibold tabular-nums">
                    {gameView.seekerReleased ? "Released" : formatRemaining(seekerCountdownMs)}
                  </p>
                </div>
              ) : null}
            </div>

            <div className="flex min-w-0 flex-col items-center gap-1">
              {controller && renamingTeam === awayScoreColumn.team ? (
                <div className="grid w-full gap-1">
                  <Input
                    ref={activeTeamRenameInputRef}
                    value={awayScoreColumn.team === "home" ? homeName : awayName}
                    onChange={(event) => {
                      if (awayScoreColumn.team === "home") {
                        setHomeName(event.target.value);
                      } else {
                        setAwayName(event.target.value);
                      }
                    }}
                    onKeyDown={handleTeamRenameInputKeyDown}
                    className="h-7 border-slate-300 bg-white text-[10px] text-slate-900"
                    maxLength={40}
                  />
                  <div className="grid grid-cols-[minmax(0,1fr)_2rem] gap-1">
                    <Button
                      size="sm"
                      className="h-6 min-w-0 px-1 text-[10px]"
                      onClick={saveTeamRename}
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 w-8 min-w-0 border-slate-300 bg-white px-0 text-slate-800"
                      onClick={swapDisplayedTeamSides}
                      aria-label="Swap team sides"
                      title="Swap team sides"
                    >
                      <ArrowLeftRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  ref={rightTeamNameButtonRef}
                  style={
                    displayTeamNameHeightPx === null
                      ? undefined
                      : { height: `${displayTeamNameHeightPx}px` }
                  }
                  className="w-[calc(100%+0.75rem)] min-h-[2.6rem] max-w-none overflow-hidden whitespace-normal px-1 pt-0.5 pb-0 text-center text-[clamp(1.05rem,3.8vw,1.35rem)] leading-[1.03] font-extrabold tracking-tight text-slate-900 [display:-webkit-box] [overflow-wrap:normal] [word-break:keep-all] [-webkit-box-orient:vertical] [-webkit-line-clamp:3] transition-opacity hover:opacity-70"
                  onClick={() => {
                    if (!controller) {
                      return;
                    }

                    setHomeName(state.homeName);
                    setAwayName(state.awayName);
                    setRenamingTeam(awayScoreColumn.team);
                  }}
                >
                  {awayScoreColumn.name}
                </button>
              )}

              <Button
                size="sm"
                className={awayScoreColumn.scoreBoxClassName}
                onClick={() =>
                  dispatchCommand({
                    type: "change-score",
                    team: awayScoreColumn.team,
                    delta: 10,
                    reason: "goal",
                  })
                }
                disabled={!controller || state.isFinished}
              >
                <ChevronUp className="h-4 w-4" />
              </Button>
              <div
                className={`w-full rounded-2xl border bg-white px-2 py-2 text-center ${awayScoreColumn.scoreValueBorderClassName} ${awayScoreColumn.scoreValueGlowClassName}`}
              >
                <p
                  className={`text-[clamp(1.75rem,9.4vw,2.45rem)] leading-none font-semibold tabular-nums transition-all duration-300 ${
                    scorePulse[awayScoreColumn.team] === 1
                      ? "score-pop-up text-emerald-700"
                      : scorePulse[awayScoreColumn.team] === -1
                        ? "score-pop-down text-rose-700"
                        : "text-slate-900"
                  }`}
                >
                  {awayScoreColumn.score}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className={awayScoreColumn.scoreDownButtonClassName}
                onClick={() =>
                  dispatchCommand({ type: "undo-last-score", team: awayScoreColumn.team })
                }
                disabled={!controller}
              >
                <ChevronDown className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {finishSummary !== null ? (
            <p className="mt-1 text-center text-[10px] font-medium text-slate-600">
              {finishSummary}
            </p>
          ) : null}
          {controller ? (
            clockAdjustOpen ? (
              <div
                className="mt-2 grid grid-cols-6 gap-1 text-[11px] animate-in fade-in-0 slide-in-from-bottom-2"
                data-clock-adjust-keep="true"
              >
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 border-slate-300 bg-white text-slate-800"
                  onClick={() => adjustGameClock(-60_000)}
                >
                  -1m
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 border-slate-300 bg-white text-slate-800"
                  onClick={() => adjustGameClock(-10_000)}
                >
                  -10s
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 border-slate-300 bg-white text-slate-800"
                  onClick={() => adjustGameClock(-1_000)}
                >
                  -1s
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 border-slate-300 bg-white text-slate-800"
                  onClick={() => adjustGameClock(1_000)}
                >
                  +1s
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 border-slate-300 bg-white text-slate-800"
                  onClick={() => adjustGameClock(10_000)}
                >
                  +10s
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 border-slate-300 bg-white text-slate-800"
                  onClick={() => adjustGameClock(60_000)}
                >
                  +1m
                </Button>
              </div>
            ) : (
              <p className="mt-2 text-center text-[11px] font-medium text-slate-600">
                Tap game time or team names to adjust.
              </p>
            )
          ) : null}
          {activeTimeout !== null && gameView.timeoutReminderActive ? (
            <p
              className={`mt-2 rounded-xl border px-2 py-1 text-[10px] font-medium ${
                gameView.timeoutWarningActive
                  ? "border-red-300 bg-red-100 text-red-900"
                  : "border-sky-300 bg-sky-100 text-sky-900"
              }`}
            >
              Reminder: tell head referee to blow their whistle at 15 seconds remaining.
              {activeTimeoutTeamName !== null
                ? ` (${activeTimeoutTeamName}: ${formatRemaining(activeTimeout.remainingMs)})`
                : null}
            </p>
          ) : null}
        </section>

        <section className="grid min-h-0 grid-cols-2 gap-2">
          {penaltyColumns.map((column) => (
            <Card
              key={column.team}
              className="h-full min-h-0 rounded-2xl border-slate-300 bg-white py-1 shadow-[0_8px_20px_rgba(15,23,42,0.1)]"
            >
              <CardContent className="flex h-full min-h-0 flex-col gap-1 overflow-hidden px-2">
                <p className="truncate text-[10px] font-semibold tracking-[0.14em] text-slate-700 uppercase">
                  {displayTeamName(column.team)} penalties
                </p>
                <div className="grid min-h-0 gap-1 overflow-hidden">
                  {column.visiblePenalties.length === 0 ? (
                    <p className="text-[10px] text-slate-500">No penalties</p>
                  ) : (
                    column.visiblePenalties.map((entry) => {
                      const releaseActions = pendingReleaseByPlayer[entry.playerKey] ?? [];
                      const playerState = state.players[entry.playerKey] ?? null;

                      return (
                        <div
                          key={entry.playerKey}
                          className={`rounded-xl border px-2 py-1 text-[10px] ${
                            releaseActions.length > 0
                              ? "animate-pulse border-red-300 bg-red-100 text-red-900"
                              : entry.highlight
                                ? "border-amber-300 bg-amber-100 text-amber-900"
                                : "border-slate-300 bg-slate-50 text-slate-900"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span>{entry.label}</span>
                            <span className="font-semibold tabular-nums">{entry.remaining}</span>
                          </div>
                          {releaseActions.length > 0 ? (
                            <div className="mt-1 grid gap-1">
                              {releaseActions.map((action) => (
                                <Button
                                  key={action.pendingId}
                                  size="sm"
                                  className="h-6 justify-start rounded-lg bg-red-500 px-1.5 text-[10px] text-white hover:bg-red-600"
                                  onClick={() =>
                                    dispatchCommand({
                                      type: "confirm-penalty-expiration",
                                      pendingId: action.pendingId,
                                      playerKey: entry.playerKey,
                                    })
                                  }
                                  disabled={!controller}
                                >
                                  {formatPendingReleaseActionLabel(action, playerState)}
                                </Button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                  {column.penalties.length > column.visiblePenalties.length ? (
                    <p className="text-[10px] text-slate-500">
                      +{column.penalties.length - column.visiblePenalties.length} more
                    </p>
                  ) : null}
                  {column.recentReleases.slice(0, 2).map((release) => (
                    <div
                      key={release.id}
                      className="rounded-xl border border-emerald-300 bg-emerald-100 px-2 py-1 text-[10px] text-emerald-900"
                    >
                      <span>
                        {release.label} released ({formatRemaining(release.remainingMs)})
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </section>

        <Card className="relative min-h-0 overflow-hidden rounded-[1.5rem] border border-slate-300 bg-white py-1 shadow-[0_12px_26px_rgba(15,23,42,0.1)]">
          <CardContent className="overflow-hidden px-2">
            <div
              className={`flex min-h-0 flex-col gap-1.5 rounded-2xl border border-slate-200 bg-slate-50 p-2 ${
                activePanel === "card" ? "animate-in fade-in-0 slide-in-from-bottom-2" : "hidden"
              }`}
            >
              <div className="grid grid-cols-2 gap-1">
                {cardTypeOptions.map((option) => {
                  const Icon = option.icon;
                  const active = cardDraft.cardType === option.type;

                  return (
                    <Button
                      key={option.type}
                      size="sm"
                      variant="outline"
                      className={`h-7 justify-start gap-1.5 rounded-xl px-2 text-[10px] ${
                        active ? option.activeClassName : option.idleClassName
                      }`}
                      onClick={() =>
                        setCardDraft((previous) => ({
                          ...previous,
                          cardType: option.type,
                          startedGameClockMs:
                            previous.startedGameClockMs === null
                              ? state.gameClockMs
                              : previous.startedGameClockMs,
                        }))
                      }
                      disabled={!canSelectCardType}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {option.label}
                    </Button>
                  );
                })}
              </div>
              <div className="grid grid-cols-2 gap-1">
                {displayTeamOrder.map((team) => (
                  <Button
                    key={team}
                    size="sm"
                    variant={cardDraft.team === team ? "default" : "outline"}
                    className="h-7 rounded-xl text-[10px]"
                    onClick={() =>
                      setCardDraft((previous) => ({
                        ...previous,
                        team,
                      }))
                    }
                    disabled={!canSelectCardTeam}
                  >
                    {displayTeamName(team)}
                  </Button>
                ))}
              </div>
              <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-xl border border-slate-300 bg-white px-2 py-1 text-[10px] font-medium">
                {cardDraft.cardType === null ? (
                  <span className="text-slate-500">Card?</span>
                ) : (
                  <>
                    <span className="uppercase">{cardDraft.cardType}</span>
                    <span className="truncate text-slate-600">
                      {cardDraft.team === null
                        ? "team?"
                        : cardDraft.team === "home"
                          ? state.homeName
                          : state.awayName}{" "}
                      • {cardPlayerLabel}
                    </span>
                  </>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 px-1.5 text-[10px] text-slate-700"
                  onClick={() =>
                    setCardDraft({
                      cardType: null,
                      team: null,
                      digits: "",
                      startedGameClockMs: null,
                    })
                  }
                  disabled={!controller || !cardEntryStarted}
                >
                  Reset
                </Button>
              </div>
              <p className="h-4 text-[10px] text-slate-600">{cardAddStatusText}</p>
              <div className="grid grid-cols-3 gap-1">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
                  <Button
                    key={digit}
                    size="sm"
                    variant="outline"
                    className="h-7 rounded-xl border-slate-300 bg-white text-sm text-slate-900"
                    onClick={() => appendCardDigit(digit)}
                    disabled={!canEditCardDigits}
                  >
                    {digit}
                  </Button>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-xl border-slate-300 bg-white text-slate-900"
                  onClick={() =>
                    setCardDraft((previous) => ({
                      ...previous,
                      digits: previous.digits.slice(0, -1),
                    }))
                  }
                  disabled={!canEditCardDigits || cardDraft.digits.length === 0}
                >
                  <Delete className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-xl border-slate-300 bg-white text-sm text-slate-900"
                  onClick={() => appendCardDigit("0")}
                  disabled={!canEditCardDigits}
                >
                  0
                </Button>
                <Button
                  size="sm"
                  className="h-7 gap-1 rounded-xl bg-emerald-600 text-white hover:bg-emerald-500"
                  onClick={submitCard}
                  disabled={!canSubmitCard}
                >
                  <Check className="h-4 w-4" />
                  OK
                </Button>
              </div>
            </div>

            <div
              className={`flex min-h-0 flex-col gap-1.5 rounded-2xl border border-slate-200 bg-slate-50 p-2 ${
                activePanel === "timeout" ? "animate-in fade-in-0 slide-in-from-bottom-2" : "hidden"
              }`}
            >
              {activeTimeout === null ? (
                <div className="grid gap-1">
                  {displayTeamOrder.map((team) => (
                    <Button
                      key={team}
                      variant="outline"
                      size="sm"
                      className="h-9 rounded-xl border-slate-300 bg-white text-slate-900"
                      onClick={() => dispatchCommand({ type: "start-timeout", team })}
                      disabled={
                        !controller ||
                        state.isRunning ||
                        state.isSuspended ||
                        state.timeouts[team].used ||
                        state.isFinished
                      }
                    >
                      {displayTeamName(team)} timeout
                    </Button>
                  ))}
                </div>
              ) : (
                <>
                  <p
                    className={`text-center text-3xl font-semibold tabular-nums ${
                      gameView.timeoutFinalCountdown
                        ? "text-red-700"
                        : gameView.timeoutWarningActive
                          ? "text-red-600"
                          : "text-slate-900"
                    }`}
                  >
                    {formatRemaining(activeTimeout.remainingMs)}
                  </p>
                  {!activeTimeout.running ? (
                    <div className="grid grid-cols-2 gap-1">
                      <Button
                        size="sm"
                        className="h-9 rounded-xl bg-emerald-600 text-white hover:bg-emerald-500"
                        onClick={() =>
                          dispatchCommand({
                            type: "set-timeout-running",
                            running: true,
                          })
                        }
                        disabled={!controller}
                      >
                        Start
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-9 rounded-xl border-slate-300 bg-white text-slate-900"
                        onClick={() => dispatchCommand({ type: "undo-timeout-start" })}
                        disabled={!controller}
                      >
                        Undo
                      </Button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-9 rounded-xl border-slate-300 bg-white text-slate-900"
                        onClick={() => dispatchCommand({ type: "cancel-timeout" })}
                        disabled={!controller}
                      >
                        End early
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-9 rounded-xl border-slate-300 bg-white text-slate-900"
                        onClick={() => dispatchCommand({ type: "undo-timeout-start" })}
                        disabled={!controller}
                      >
                        Undo
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>

            <div
              className={`flex min-h-0 flex-col gap-1.5 rounded-2xl border border-slate-200 bg-slate-50 p-2 ${
                activePanel === "game" ? "animate-in fade-in-0 slide-in-from-bottom-2" : "hidden"
              }`}
            >
              {pendingWinConfirmation !== null ? (
                <div className="mb-1 rounded-xl border border-amber-300 bg-amber-100 p-2 text-[10px] text-amber-900">
                  <p className="font-semibold">Confirm result</p>
                  <p className="mt-0.5">{pendingWinConfirmation.label}</p>
                  <div className="mt-2 grid grid-cols-2 gap-1">
                    <Button
                      size="sm"
                      className="h-7 rounded-xl"
                      onClick={confirmWinAction}
                      disabled={!controller}
                    >
                      Confirm
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 rounded-xl border-slate-300 bg-white text-slate-900"
                      onClick={() => setPendingWinConfirmation(null)}
                      disabled={!controller}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
              {state.isFinished ? (
                <p className="text-[11px] text-slate-600">{finishSummary ?? "Game finished."}</p>
              ) : state.isSuspended ? (
                <>
                  <p className="text-[11px] text-slate-600">
                    Game suspended. Resume when continuing this game.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 rounded-xl border-slate-300 bg-white text-slate-900"
                    onClick={() => dispatchCommand({ type: "resume-game" })}
                    disabled={!canResumeGame}
                  >
                    Resume game
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 rounded-xl border-slate-300 bg-white text-slate-900"
                    onClick={() => dispatchCommand({ type: "suspend-game" })}
                    disabled={!canSuspendGame}
                  >
                    Suspend game
                  </Button>
                  <div className="grid grid-cols-2 gap-1">
                    {displayTeamOrder.map((team) => {
                      const winner = team === "home" ? "away" : "home";
                      return (
                        <Button
                          key={`forfeit-${team}`}
                          size="sm"
                          variant="outline"
                          className="h-8 rounded-xl border-slate-300 bg-white text-slate-900"
                          onClick={() =>
                            requestWinConfirmation(
                              `${displayTeamName(winner)} wins by forfeit penalty.`,
                              {
                                type: "record-forfeit",
                                team,
                              },
                            )
                          }
                          disabled={!canUseEndingActions}
                        >
                          {displayTeamName(team)} forfeit
                        </Button>
                      );
                    })}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 rounded-xl border-slate-300 bg-white text-slate-900"
                    onClick={() => dispatchCommand({ type: "record-double-forfeit" })}
                    disabled={!canUseEndingActions}
                  >
                    Double forfeit
                  </Button>

                  {state.isOvertime ? (
                    <>
                      <div className="grid grid-cols-2 gap-1">
                        {displayTeamOrder.map((team) => (
                          <Button
                            key={`target-${team}`}
                            size="sm"
                            className="h-8 rounded-xl"
                            onClick={() =>
                              requestWinConfirmation(
                                `${displayTeamName(team)} reached target score and wins.`,
                                {
                                  type: "record-target-score",
                                  team,
                                },
                              )
                            }
                            disabled={!canUseEndingActions}
                          >
                            {displayTeamName(team)} reached target
                          </Button>
                        ))}
                      </div>
                      <div className="grid grid-cols-2 gap-1">
                        {displayTeamOrder.map((team) => {
                          const winner = team === "home" ? "away" : "home";
                          return (
                            <Button
                              key={`concede-${team}`}
                              size="sm"
                              variant="outline"
                              className="h-8 rounded-xl border-slate-300 bg-white text-slate-900"
                              onClick={() =>
                                requestWinConfirmation(
                                  `${displayTeamName(team)} conceded. ${displayTeamName(winner)} wins.`,
                                  {
                                    type: "record-concede",
                                    team,
                                  },
                                )
                              }
                              disabled={!canUseEndingActions}
                            >
                              {displayTeamName(team)} concedes
                            </Button>
                          );
                        })}
                      </div>
                    </>
                  ) : canRecordFlagCatch ? (
                    <div className="grid grid-cols-2 gap-1">
                      {displayTeamOrder.map((team) => (
                        <Button
                          key={`flag-catch-${team}`}
                          size="sm"
                          className="h-8 rounded-xl"
                          onClick={() => {
                            if (willFlagCatchWin(state, team)) {
                              requestWinConfirmation(
                                `${displayTeamName(team)} wins on flag catch.`,
                                {
                                  type: "record-flag-catch",
                                  team,
                                },
                              );
                              return;
                            }

                            dispatchCommand({ type: "record-flag-catch", team });
                          }}
                          disabled={!canUseEndingActions}
                        >
                          {displayTeamName(team)} flag +30
                        </Button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[11px] text-slate-600">
                      Flag catch appears after seeker release while play is paused.
                    </p>
                  )}
                </>
              )}
            </div>
          </CardContent>
        </Card>

        <section className="rounded-2xl border border-slate-300 bg-white p-1 shadow-[0_8px_20px_rgba(15,23,42,0.1)]">
          <div className="grid grid-cols-3 gap-1">
            <Button
              variant="ghost"
              size="sm"
              className={`h-10 gap-1 rounded-xl px-1 text-[11px] transition-all ${
                activePanel === "card"
                  ? "bg-gradient-to-br from-cyan-500 to-sky-600 text-white shadow-[0_0_14px_rgba(56,189,248,0.55)]"
                  : "bg-slate-100 text-slate-700"
              }`}
              onClick={() => setActivePanel("card")}
            >
              <Flag className={`h-3.5 w-3.5 ${activePanel === "card" ? "animate-pulse" : ""}`} />
              Cards
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={`h-10 gap-1 rounded-xl px-1 text-[11px] transition-all ${
                activePanel === "timeout"
                  ? "bg-gradient-to-br from-orange-500 to-amber-500 text-white shadow-[0_0_14px_rgba(251,146,60,0.5)]"
                  : "bg-slate-100 text-slate-700"
              }`}
              onClick={() => setActivePanel("timeout")}
            >
              <Clock3
                className={`h-3.5 w-3.5 ${activePanel === "timeout" ? "animate-pulse" : ""}`}
              />
              Timeout
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={`h-10 gap-1 rounded-xl px-1 text-[11px] transition-all ${
                activePanel === "game"
                  ? "bg-gradient-to-br from-rose-500 to-fuchsia-600 text-white shadow-[0_0_14px_rgba(244,63,94,0.55)]"
                  : "bg-slate-100 text-slate-700"
              }`}
              onClick={() => setActivePanel("game")}
            >
              <Trophy className={`h-3.5 w-3.5 ${activePanel === "game" ? "animate-pulse" : ""}`} />
              Game end
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}

function useGameConnection({ gameId, role }: { gameId: string; role: ControllerRole }) {
  const wsUrl = useMemo(createWebSocketUrl, []);
  const [baseState, setBaseState] = useState<GameState | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [pendingCommandsCount, setPendingCommandsCount] = useState(0);
  const [localOnlyMode, setLocalOnlyMode] = useState(false);

  const pendingRef = useRef<ClientCommandEnvelope[]>([]);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const commandCounterRef = useRef(0);
  const clientInstanceId = useRef(crypto.randomUUID());
  const subscribedToServerGameRef = useRef(false);
  const localOnlyModeRef = useRef(false);

  const setLocalOnlyState = useCallback((value: boolean) => {
    localOnlyModeRef.current = value;
    setLocalOnlyMode(value);
  }, []);

  const setPendingCommands = useCallback((commands: ClientCommandEnvelope[]) => {
    pendingRef.current = commands;
    setPendingCommandsCount(commands.length);
  }, []);

  const persistControllerSession = useCallback(
    (state: GameState, pendingCommands: ClientCommandEnvelope[], commandCounter: number) => {
      if (role !== "controller") {
        return;
      }

      savePersistedControllerSession({
        gameId,
        state,
        pendingCommands,
        commandCounter,
      });
    },
    [gameId, role],
  );

  const flushPendingCommands = useCallback(() => {
    if (role !== "controller") {
      return;
    }

    if (localOnlyModeRef.current) {
      return;
    }

    if (!subscribedToServerGameRef.current) {
      return;
    }

    const ws = wsRef.current;
    if (ws === null || ws.readyState !== WebSocket.OPEN || pendingRef.current.length === 0) {
      return;
    }

    ws.send(
      JSON.stringify({
        type: "apply-commands",
        gameId,
        commands: pendingRef.current,
      }),
    );
  }, [gameId, role]);

  const reconcileWithServer = useCallback(
    ({
      state,
      serverNowMs,
      ackedCommandIds,
    }: {
      state: GameState;
      serverNowMs: number;
      ackedCommandIds: string[];
    }) => {
      if (ackedCommandIds.length > 0) {
        const ackedSet = new Set(ackedCommandIds);
        setPendingCommands(pendingRef.current.filter((command) => !ackedSet.has(command.id)));
      }

      setClockOffsetMs(serverNowMs - Date.now());

      let reconciled = state;

      for (const command of pendingRef.current) {
        reconciled = applyLocalEnvelope(reconciled, command);
      }

      setBaseState(reconciled);
      persistControllerSession(reconciled, pendingRef.current, commandCounterRef.current);
    },
    [persistControllerSession, setPendingCommands],
  );

  useEffect(() => {
    let cancelled = false;
    let recoveredFromLocal = false;

    if (role === "controller") {
      const persisted = loadPersistedControllerSession(gameId);
      if (persisted !== null) {
        recoveredFromLocal = true;
        setPendingCommands(persisted.pendingCommands);
        commandCounterRef.current = Math.max(commandCounterRef.current, persisted.commandCounter);
        setBaseState(persisted.state);
        setConnectionState("offline");
        setError("Recovered local game state. Reconnecting server...");
      }
    }

    const fetchInitialSnapshot = async () => {
      try {
        const response = await fetch(`/api/games/${gameId}`);
        if (!response.ok) {
          if (role === "controller" && recoveredFromLocal) {
            setLocalOnlyState(true);
            setConnectionState("local-only");
            setError(LOCAL_ONLY_MESSAGE);
            return;
          }

          setError("Game not found.");
          return;
        }

        const payload = (await response.json()) as { game?: GameView };
        if (!cancelled && payload.game !== undefined) {
          setError(null);

          let reconciled = payload.game.state;
          for (const command of pendingRef.current) {
            reconciled = applyLocalEnvelope(reconciled, command);
          }

          setLocalOnlyState(false);
          setBaseState(reconciled);
          persistControllerSession(reconciled, pendingRef.current, commandCounterRef.current);
        }
      } catch {
        if (!cancelled) {
          if (role === "controller" && recoveredFromLocal) {
            setError("Unable to reach server. Continuing locally on this device.");
            return;
          }

          setError("Unable to fetch game snapshot.");
        }
      }
    };

    const connect = () => {
      if (cancelled) {
        return;
      }

      if (localOnlyModeRef.current) {
        setConnectionState("local-only");
      } else {
        setConnectionState("connecting");
      }

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      subscribedToServerGameRef.current = false;

      ws.onopen = () => {
        if (!localOnlyModeRef.current) {
          setConnectionState("online");
        }

        ws.send(
          JSON.stringify({
            type: "subscribe-game",
            gameId,
            role,
          }),
        );
      };

      ws.onmessage = (event) => {
        const parsed = parseServerMessage(event.data);
        if (parsed === null) {
          return;
        }

        if (parsed.type === "error") {
          if (role === "controller" && isServerGameUnavailableError(parsed.message)) {
            subscribedToServerGameRef.current = false;
            setLocalOnlyState(true);
            setConnectionState("local-only");
            setError(LOCAL_ONLY_MESSAGE);
            ws.close();
            return;
          }

          setError(parsed.message);
          return;
        }

        if (parsed.type === "game-snapshot") {
          subscribedToServerGameRef.current = true;
          setLocalOnlyState(false);
          setConnectionState("online");
          setError(null);
          reconcileWithServer({
            state: parsed.game.state,
            serverNowMs: parsed.serverNowMs,
            ackedCommandIds: parsed.ackedCommandIds,
          });
          flushPendingCommands();
        }
      };

      ws.onclose = () => {
        if (localOnlyModeRef.current) {
          setConnectionState("local-only");
        } else {
          setConnectionState("offline");
        }

        wsRef.current = null;
        subscribedToServerGameRef.current = false;
        if (!cancelled) {
          const retryDelay = localOnlyModeRef.current
            ? LOCAL_ONLY_RETRY_DELAY_MS
            : NORMAL_RECONNECT_DELAY_MS;
          reconnectTimeoutRef.current = window.setTimeout(connect, retryDelay);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    void fetchInitialSnapshot();
    connect();

    return () => {
      cancelled = true;
      subscribedToServerGameRef.current = false;
      if (wsRef.current !== null) {
        wsRef.current.close();
      }
      if (reconnectTimeoutRef.current !== null) {
        window.clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [
    flushPendingCommands,
    gameId,
    persistControllerSession,
    reconcileWithServer,
    role,
    setLocalOnlyState,
    setPendingCommands,
    wsUrl,
  ]);

  const dispatchCommand = useCallback(
    (command: GameCommand) => {
      if (role !== "controller") {
        return;
      }

      setBaseState((previous) => {
        if (previous === null) {
          return previous;
        }

        commandCounterRef.current += 1;
        const envelope: ClientCommandEnvelope = {
          id: `${clientInstanceId.current}-${commandCounterRef.current}`,
          clientSentAtMs: Date.now() + clockOffsetMs,
          command,
        };

        const nextPendingCommands = [...pendingRef.current, envelope];
        setPendingCommands(nextPendingCommands);
        const next = applyLocalEnvelope(previous, envelope);
        persistControllerSession(next, nextPendingCommands, commandCounterRef.current);

        window.setTimeout(flushPendingCommands, 0);

        return next;
      });
    },
    [clockOffsetMs, flushPendingCommands, persistControllerSession, role, setPendingCommands],
  );

  return {
    baseState,
    clockOffsetMs,
    dispatchCommand,
    connectionState,
    pendingCommands: pendingCommandsCount,
    error,
    localOnlyMode,
  };
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.pathname, window.location.search),
  );

  useEffect(() => {
    const onPopState = () => {
      setRoute(parseRoute(window.location.pathname, window.location.search));
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return route;
}

function parseRoute(pathname: string, search: string): Route {
  const match = pathname.match(/^\/game\/([a-zA-Z0-9-]+)$/);
  if (match === null) {
    return { type: "home" };
  }

  const params = new URLSearchParams(search);
  const mode = params.get("mode") === "controller" ? "controller" : "spectator";

  return {
    type: "game",
    gameId: match[1] ?? "",
    role: mode,
  };
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, intervalMs);

    return () => window.clearInterval(interval);
  }, [intervalMs]);

  return now;
}

function createWebSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function parseServerMessage(input: unknown): ServerWsMessage | null {
  if (typeof input !== "string") {
    return null;
  }

  try {
    return JSON.parse(input) as ServerWsMessage;
  } catch {
    return null;
  }
}

function isServerGameUnavailableError(message: string) {
  return (
    message === "Game not found." ||
    message === "Not subscribed to a game." ||
    message === "Command gameId mismatch."
  );
}

function loadPersistedControllerSession(gameId: string) {
  try {
    const raw = window.localStorage.getItem(getControllerSessionStorageKey(gameId));
    if (raw === null) {
      return null;
    }

    return parsePersistedControllerSession(raw, gameId);
  } catch {
    return null;
  }
}

function savePersistedControllerSession({
  gameId,
  state,
  pendingCommands,
  commandCounter,
}: {
  gameId: string;
  state: GameState;
  pendingCommands: ClientCommandEnvelope[];
  commandCounter: number;
}) {
  try {
    const payload = createPersistedControllerSession({
      gameId,
      state,
      pendingCommands,
      commandCounter,
      savedAtMs: Date.now(),
    });

    window.localStorage.setItem(getControllerSessionStorageKey(gameId), JSON.stringify(payload));
  } catch {
    // Best-effort persistence only; keep runtime behavior even if storage is unavailable.
  }
}

function applyLocalEnvelope(state: GameState, envelope: ClientCommandEnvelope): GameState {
  let idCounter = 0;
  return applyGameCommand({
    state,
    command: envelope.command,
    nowMs: envelope.clientSentAtMs,
    idGenerator: () => {
      idCounter += 1;
      return `${envelope.id}:${idCounter}`;
    },
  });
}

function navigateTo(path: string) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function willFlagCatchWin(state: GameState, team: TeamId) {
  const opposingTeam = team === "home" ? "away" : "home";
  return state.score[team] + 30 > state.score[opposingTeam];
}

function formatFinishReason(reason: GameState["finishReason"]) {
  switch (reason) {
    case "forfeit":
      return "forfeit";
    case "double-forfeit":
      return "double forfeit";
    case "flag-catch":
      return "flag catch";
    case "target-score":
      return "target score";
    case "concede":
      return "concession";
    default:
      return "result";
  }
}

function formatClock(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatRemaining(ms: number) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1_000));

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatPenaltySlice(ms: number) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function deriveLiveClockMs(game: GameSummary, nowMs: number) {
  if (!game.isRunning || game.isFinished) {
    return game.gameClockMs;
  }

  return game.gameClockMs + Math.max(0, nowMs - game.updatedAtMs);
}

type PlayerPenaltyView = {
  playerKey: string;
  label: string;
  remaining: string;
  remainingMs: number;
  highlight: boolean;
};

type ReleasedPenaltyView = {
  id: string;
  label: string;
  releasedAtMs: number;
  remainingMs: number;
};

function getTeamPenalties(state: GameState | null | undefined, team: TeamId): PlayerPenaltyView[] {
  if (state === undefined || state === null) {
    return [];
  }

  return Object.values(state.players)
    .filter((player) => player.team === team)
    .map((player) => {
      const remainingMs = player.segments.reduce(
        (total, segment) => total + segment.remainingMs,
        0,
      );

      return {
        playerKey: player.key,
        label: formatPlayerLabel(player),
        remaining: formatRemaining(remainingMs),
        remainingMs,
        highlight: remainingMs > 0 && remainingMs <= 10_000,
      };
    })
    .sort((a, b) => a.remainingMs - b.remainingMs || a.label.localeCompare(b.label));
}

function selectVisiblePenalties(
  penalties: PlayerPenaltyView[],
  pendingReleaseByPlayer: Record<string, PendingReleaseAction[]>,
  limit: number,
) {
  const pendingFirst = penalties.filter((entry) => {
    const pending = pendingReleaseByPlayer[entry.playerKey];
    return pending !== undefined && pending.length > 0;
  });
  const normal = penalties.filter((entry) => {
    const pending = pendingReleaseByPlayer[entry.playerKey];
    return pending === undefined || pending.length === 0;
  });

  return [...pendingFirst, ...normal].slice(0, limit);
}

function hasServingPenalty(player: PlayerPenaltyState | null | undefined) {
  if (player === null || player === undefined) {
    return false;
  }

  return player.segments.some((segment) => segment.remainingMs > 0);
}

function willPendingReleaseNow(
  action: PendingReleaseAction,
  player: PlayerPenaltyState | null | undefined,
) {
  if (player === null || player === undefined) {
    return false;
  }

  const totalRemainingMs = player.segments.reduce(
    (total, segment) => total + Math.max(0, segment.remainingMs),
    0,
  );
  const expirableRemainingMs = player.segments.reduce(
    (total, segment) => total + (segment.expirableByScore ? Math.max(0, segment.remainingMs) : 0),
    0,
  );
  if (totalRemainingMs <= 0 || expirableRemainingMs <= 0) {
    return false;
  }

  const removedMs = Math.min(expirableRemainingMs, Math.max(0, action.expireMs));
  return totalRemainingMs - removedMs <= 0;
}

function formatPendingReleaseActionLabel(
  action: PendingReleaseAction,
  player: PlayerPenaltyState | null | undefined,
) {
  const source = action.reason === "score" ? "Goal" : "Flag";
  if (willPendingReleaseNow(action, player)) {
    return `${source} release`;
  }

  return `${source} -${formatPenaltySlice(action.expireMs)}`;
}

function getTeamRecentReleases(
  state: GameState | null | undefined,
  team: TeamId,
  nowMs: number,
): ReleasedPenaltyView[] {
  if (state === undefined || state === null) {
    return [];
  }

  const releases = Array.isArray(state.recentReleases) ? state.recentReleases : [];

  return releases
    .filter((entry) => entry.team === team)
    .map((entry): ReleasedPenaltyView | null => {
      const remainingMs = RELEASE_EVENT_VISIBLE_MS - Math.max(0, nowMs - entry.releasedAtMs);
      if (remainingMs <= 0) {
        return null;
      }

      return {
        id: entry.id,
        label:
          entry.playerNumber === null
            ? `Unknown (${entry.playerKey.split(":").slice(2).join(":") || "penalty"})`
            : `#${entry.playerNumber}`,
        releasedAtMs: entry.releasedAtMs,
        remainingMs,
      };
    })
    .filter((entry): entry is ReleasedPenaltyView => entry !== null)
    .sort((a, b) => b.releasedAtMs - a.releasedAtMs);
}

function formatPlayerLabel(player: PlayerPenaltyState | null | undefined) {
  if (player === null || player === undefined) {
    return "Unknown player";
  }

  if (player.playerNumber === null) {
    return `Unknown (${player.key.split(":").slice(2).join(":") || "penalty"})`;
  }

  return `#${player.playerNumber}`;
}

function PlayFilledGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path d="M8 5.5C8 4.7 8.9 4.2 9.6 4.7L19.2 11.2C19.9 11.7 19.9 12.8 19.2 13.3L9.6 19.8C8.9 20.3 8 19.8 8 19V5.5Z" />
    </svg>
  );
}

function PauseFilledGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <rect x="6.5" y="4.5" width="4.8" height="15" rx="1.6" />
      <rect x="12.7" y="4.5" width="4.8" height="15" rx="1.6" />
    </svg>
  );
}

export default App;
