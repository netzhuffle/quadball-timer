import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CloudOff, Eye, OctagonX, Shield, TriangleAlert, UserX, Wifi, WifiOff } from "lucide-react";
import { projectGameView } from "@/lib/game-engine";
import type { CardType, ControllerRole, GameCommand, TeamId } from "@/lib/game-types";
import { GameControllerActionPanels } from "@/components/game-controller-action-panels";
import { ControllerTopSection, PenaltyColumnsSection } from "@/components/game-controller-sections";
import {
  FLAG_RELEASE_MS,
  FLAG_STATUS_HIDE_AFTER_MS,
  FLAG_STATUS_SHOW_FROM_MS,
  LOCAL_ONLY_MESSAGE,
  ONE_MINUTE_MS,
  SEEKER_RELEASE_MS,
  SEEKER_STATUS_HIDE_AFTER_MS,
  SEEKER_STATUS_SHOW_FROM_MS,
  type PendingReleaseAction,
  type PlayerPenaltyView,
  type ReleasedPenaltyView,
  formatClock,
  formatFinishReason,
  formatPendingReleaseActionLabel,
  formatPenaltySlice,
  formatRemaining,
  getTeamPenalties,
  getTeamRecentReleases,
  hasServingPenalty,
  navigateTo,
  selectVisiblePenalties,
  useGameConnection,
  useNow,
  willFlagCatchWin,
} from "@/lib/game-page-support";
import "../index.css";

type PendingWinConfirmation = {
  label: string;
  command: GameCommand;
};

export function GamePage({ gameId, role }: { gameId: string; role: ControllerRole }) {
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
      panelBorderClassName: string;
      panelTintClassName: string;
      headerTextClassName: string;
      neutralChipClassName: string;
    }
  > = {
    home: {
      team: "home",
      penalties: homePenalties,
      visiblePenalties: visibleHomePenalties,
      recentReleases: homeRecentReleases,
      panelBorderClassName: "border-sky-200",
      panelTintClassName:
        "bg-[radial-gradient(circle_at_12%_18%,rgba(14,165,233,0.14),rgba(14,165,233,0.05)_34%,rgba(255,255,255,0)_68%),linear-gradient(180deg,rgba(240,249,255,0.9),rgba(255,255,255,0.95)_32%,rgba(255,255,255,0.98))]",
      headerTextClassName: "text-sky-800",
      neutralChipClassName: "border-sky-200 bg-sky-50/80 text-slate-900",
    },
    away: {
      team: "away",
      penalties: awayPenalties,
      visiblePenalties: visibleAwayPenalties,
      recentReleases: awayRecentReleases,
      panelBorderClassName: "border-orange-200",
      panelTintClassName:
        "bg-[radial-gradient(circle_at_88%_18%,rgba(249,115,22,0.16),rgba(249,115,22,0.05)_34%,rgba(255,255,255,0)_68%),linear-gradient(180deg,rgba(255,247,237,0.88),rgba(255,255,255,0.95)_32%,rgba(255,255,255,0.98))]",
      headerTextClassName: "text-orange-800",
      neutralChipClassName: "border-orange-200 bg-orange-50/75 text-slate-900",
    },
  };
  const penaltyColumns: Array<{
    team: TeamId;
    penalties: PlayerPenaltyView[];
    visiblePenalties: PlayerPenaltyView[];
    recentReleases: ReleasedPenaltyView[];
    panelBorderClassName: string;
    panelTintClassName: string;
    headerTextClassName: string;
    neutralChipClassName: string;
  }> = displayTeamOrder.map((team) => penaltyColumnsByTeam[team]);
  const displayTeamName = (team: TeamId) => (team === "home" ? state.homeName : state.awayName);
  const timeoutReminder =
    activeTimeout !== null && gameView.timeoutReminderActive
      ? {
          warningActive: gameView.timeoutWarningActive,
          text:
            "Reminder: tell head referee to blow their whistle at 15 seconds remaining." +
            (activeTimeoutTeamName !== null
              ? ` (${activeTimeoutTeamName}: ${formatRemaining(activeTimeout.remainingMs)})`
              : ""),
        }
      : null;
  const flagStatus = showFlagStatus
    ? {
        label: "Flag",
        value: flagReleased ? "Released" : formatRemaining(flagRemainingMs),
        positionClassName: "-left-3 -bottom-0.5",
        className:
          !flagReleased && flagRemainingMs <= 10_000
            ? "border-amber-300 bg-amber-100 text-amber-900"
            : "border-sky-300 bg-white text-slate-800",
      }
    : null;
  const seekersStatus = showSeekerStatus
    ? {
        label: "Seekers",
        value: gameView.seekerReleased ? "Released" : formatRemaining(seekerCountdownMs),
        positionClassName: "-right-3 -bottom-0.5",
        className: seekerWarningRed
          ? "animate-pulse border-red-300 bg-red-100 text-red-900"
          : seekerWarningYellow
            ? "border-amber-300 bg-amber-100 text-amber-900"
            : "border-sky-300 bg-white text-slate-800",
      }
    : null;

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

        <ControllerTopSection
          controller={controller}
          stateIsRunning={state.isRunning}
          stateIsFinished={state.isFinished}
          stateIsSuspended={state.isSuspended}
          statusLabel={statusLabel}
          gameClockText={formatClock(gameView.state.gameClockMs)}
          leftScoreColumn={homeScoreColumn}
          rightScoreColumn={awayScoreColumn}
          scorePulse={scorePulse}
          teamNameEditor={{
            controller,
            renamingTeam,
            homeName,
            awayName,
            activeTeamRenameInputRef,
            leftTeamNameButtonRef,
            rightTeamNameButtonRef,
            displayTeamNameHeightPx,
            onOpenRename: (team) => {
              if (!controller) {
                return;
              }

              setHomeName(state.homeName);
              setAwayName(state.awayName);
              setRenamingTeam(team);
            },
            onRenameInputChange: (team, value) => {
              if (team === "home") {
                setHomeName(value);
              } else {
                setAwayName(value);
              }
            },
            onRenameInputKeyDown: handleTeamRenameInputKeyDown,
            onSaveRename: saveTeamRename,
            onSwapDisplayedTeamSides: swapDisplayedTeamSides,
          }}
          onAddScore={(team) =>
            dispatchCommand({
              type: "change-score",
              team,
              delta: 10,
              reason: "goal",
            })
          }
          onUndoScore={(team) => dispatchCommand({ type: "undo-last-score", team })}
          onToggleClockAdjust={() => setClockAdjustOpen((previous) => !previous)}
          onToggleRunning={() =>
            dispatchCommand({
              type: "set-running",
              running: !state.isRunning,
            })
          }
          clockAdjustOpen={clockAdjustOpen}
          onAdjustGameClock={adjustGameClock}
          finishSummary={finishSummary}
          timeoutReminder={timeoutReminder}
          flagStatus={flagStatus}
          seekersStatus={seekersStatus}
        />

        <PenaltyColumnsSection
          penaltyColumns={penaltyColumns}
          displayTeamName={displayTeamName}
          pendingReleaseByPlayer={pendingReleaseByPlayer}
          controller={controller}
          onConfirmPenaltyExpiration={(pendingId, playerKey) =>
            dispatchCommand({
              type: "confirm-penalty-expiration",
              pendingId,
              playerKey,
            })
          }
          getPendingReleaseActionLabel={(action, playerKey) =>
            formatPendingReleaseActionLabel(action, state.players[playerKey] ?? null)
          }
          formatRemaining={formatRemaining}
        />

        <GameControllerActionPanels
          activePanel={activePanel}
          setActivePanel={setActivePanel}
          controller={controller}
          state={state}
          gameView={{
            timeoutFinalCountdown: gameView.timeoutFinalCountdown,
            timeoutWarningActive: gameView.timeoutWarningActive,
          }}
          displayTeamOrder={displayTeamOrder}
          displayTeamName={displayTeamName}
          cardTypeOptions={cardTypeOptions}
          cardDraft={cardDraft}
          setCardDraft={setCardDraft}
          canSelectCardType={canSelectCardType}
          canSelectCardTeam={canSelectCardTeam}
          cardPlayerLabel={cardPlayerLabel}
          cardEntryStarted={cardEntryStarted}
          cardAddStatusText={cardAddStatusText}
          canEditCardDigits={canEditCardDigits}
          appendCardDigit={appendCardDigit}
          canSubmitCard={canSubmitCard}
          submitCard={submitCard}
          activeTimeout={activeTimeout}
          formatRemaining={formatRemaining}
          pendingWinConfirmation={
            pendingWinConfirmation === null ? null : { label: pendingWinConfirmation.label }
          }
          confirmWinAction={confirmWinAction}
          clearPendingWinConfirmation={() => setPendingWinConfirmation(null)}
          finishSummary={finishSummary}
          canResumeGame={canResumeGame}
          canSuspendGame={canSuspendGame}
          canUseEndingActions={canUseEndingActions}
          canRecordFlagCatch={canRecordFlagCatch}
          startTimeout={(team) => dispatchCommand({ type: "start-timeout", team })}
          setTimeoutRunning={(running) =>
            dispatchCommand({
              type: "set-timeout-running",
              running,
            })
          }
          undoTimeoutStart={() => dispatchCommand({ type: "undo-timeout-start" })}
          cancelTimeout={() => dispatchCommand({ type: "cancel-timeout" })}
          resumeGame={() => dispatchCommand({ type: "resume-game" })}
          suspendGame={() => dispatchCommand({ type: "suspend-game" })}
          requestForfeitWin={(team) => {
            const winner = team === "home" ? "away" : "home";
            requestWinConfirmation(`${displayTeamName(winner)} wins by forfeit penalty.`, {
              type: "record-forfeit",
              team,
            });
          }}
          recordDoubleForfeit={() => dispatchCommand({ type: "record-double-forfeit" })}
          requestTargetScoreWin={(team) =>
            requestWinConfirmation(`${displayTeamName(team)} reached target score and wins.`, {
              type: "record-target-score",
              team,
            })
          }
          requestConcedeWin={(team) => {
            const winner = team === "home" ? "away" : "home";
            requestWinConfirmation(
              `${displayTeamName(team)} conceded. ${displayTeamName(winner)} wins.`,
              {
                type: "record-concede",
                team,
              },
            );
          }}
          recordOrConfirmFlagCatch={(team) => {
            if (willFlagCatchWin(state, team)) {
              requestWinConfirmation(`${displayTeamName(team)} wins on flag catch.`, {
                type: "record-flag-catch",
                team,
              });
              return;
            }

            dispatchCommand({ type: "record-flag-catch", team });
          }}
        />
      </div>
    </div>
  );
}
