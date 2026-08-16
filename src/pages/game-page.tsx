import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import QRCode from "qrcode/lib/browser";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Eye, OctagonX, Shield, TriangleAlert, UserX } from "lucide-react";
import { projectGameView } from "@/lib/game-engine";
import type { CardType, ControllerRole, GameCommand, TeamId } from "@/lib/game-types";
import { GameControllerActionPanels } from "@/components/game-controller-action-panels";
import { ControllerTopSection, PenaltyColumnsSection } from "@/components/game-controller-sections";
import { ControllerHeader } from "@/components/controller-header";
import type { ControllerActionPanel } from "@/lib/controller-action-sheet";
import {
  FLAG_RELEASE_MS,
  FLAG_STATUS_HIDE_AFTER_MS,
  FLAG_STATUS_SHOW_FROM_MS,
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
import { buildAdHocControlQrPayload } from "@/lib/ad-hoc-handoff";
import {
  ControllerLeaveDialog,
  controllerDepartureReference,
  useControllerDepartureEntry,
} from "@/components/controller-departure";
import {
  controllerDepartureBlocksGame,
  getBrowserControllerDeparture,
} from "@/lib/controller-departure";
import {
  DEFAULT_AWAY_TEAM_COLOR,
  DEFAULT_HOME_TEAM_COLOR,
  hexToOklch,
  normalizeTeamColor,
  oklchToHex,
  shiftOklch,
  withColorAlpha,
} from "@/lib/team-colors";
import {
  buildActionPanelTabStyle,
  buildPenaltyHeaderStyle,
  buildPenaltyNeutralChipStyle,
  buildPenaltyPanelBorderStyle,
  buildPenaltyPanelTintStyle,
  buildScoreDownButtonStyle,
  buildScoreUpButtonStyle,
  buildScoreValueStyle,
} from "@/lib/score-color-theme";
import "../index.css";

type PendingWinConfirmation = {
  label: string;
  command: GameCommand;
};

export function GamePage({ gameId, role }: { gameId: string; role: ControllerRole }) {
  const controller = role === "controller";
  const [activePanel, setActivePanel] = useState<ControllerActionPanel | null>(null);
  const [homeName, setHomeName] = useState("Home");
  const [awayName, setAwayName] = useState("Away");
  const [homeColor, setHomeColor] = useState(DEFAULT_HOME_TEAM_COLOR);
  const [awayColor, setAwayColor] = useState(DEFAULT_AWAY_TEAM_COLOR);
  const [cardDraft, setCardDraft] = useState<{
    cardType: CardType | null;
    team: TeamId | null;
    digits: string;
    startedGameClockMs: number | null;
    editingCardId: string | null;
    wizardStep: "type" | "team" | "number";
  }>({
    cardType: null,
    team: null,
    digits: "",
    startedGameClockMs: null,
    editingCardId: null,
    wizardStep: "type",
  });
  const [cardCreationPending, setCardCreationPending] = useState(false);
  const pendingCardCreationIdsRef = useRef<Set<string> | null>(null);
  const [clockAdjustOpen, setClockAdjustOpen] = useState(false);
  const [renamingTeam, setRenamingTeam] = useState<TeamId | null>(null);
  const [pendingWinConfirmation, setPendingWinConfirmation] =
    useState<PendingWinConfirmation | null>(null);
  const handleActionPanelChange = useCallback((panel: ControllerActionPanel | null) => {
    setCardDraft({
      cardType: null,
      team: null,
      digits: "",
      startedGameClockMs: null,
      editingCardId: null,
      wizardStep: "type",
    });
    setCardCreationPending(false);
    pendingCardCreationIdsRef.current = null;
    setPendingWinConfirmation(null);
    setActivePanel(panel);
  }, []);
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const [leavePending, setLeavePending] = useState(false);
  const [adHocQrOpen, setAdHocQrOpen] = useState(false);
  const [entryReady, setEntryReady] = useState(role !== "controller");
  const [entryError, setEntryError] = useState<string | null>(null);
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
  const controllerTopSectionRef = useRef<HTMLDivElement | null>(null);
  const [displayTeamNameHeightPx, setDisplayTeamNameHeightPx] = useState<number | null>(null);
  const [controllerTopSectionHeightPx, setControllerTopSectionHeightPx] = useState<number | null>(
    null,
  );
  const leaveTriggerRef = useRef<HTMLButtonElement | null>(null);
  const adHocQrTriggerRef = useRef<HTMLButtonElement | null>(null);
  const entryTriggerRef = useRef<HTMLButtonElement | null>(null);
  const entryStartedForRef = useRef<string | null>(null);
  const departureModule = getBrowserControllerDeparture();

  const nowMs = useNow(250);

  const departureProjection = departureModule.project();
  const departureBlocked =
    role === "controller" && controllerDepartureBlocksGame(departureProjection, "ad-hoc", gameId);

  const {
    baseState,
    controlQr,
    clockOffsetMs,
    dispatchCommand,
    connectionState,
    error,
    pendingCommands,
    localOnlyMode,
  } = useGameConnection({
    gameId,
    role,
    blocked: departureBlocked || !entryReady,
  });
  const controllerWarningRetryDetail = localOnlyMode
    ? "Server does not know this game; retry when the server returns."
    : error !== null && /busy|retry|reconnect|reach server/iu.test(error)
      ? error
      : undefined;
  const [leaveMessage, setLeaveMessage] = useState<string | null>(null);
  const entry = useControllerDepartureEntry({
    destination: { kind: "resume-ad-hoc", gameId },
    triggerRef: entryTriggerRef,
    onCommitted: () => {
      setEntryError(null);
      setEntryReady(true);
    },
    onUnavailable: () => {
      setEntryReady(false);
      setEntryError("Ad Hoc Game unavailable.");
    },
    onCancelled: () => {
      setEntryReady(false);
      setEntryError("Entry cancelled. Your Controller return is still available.");
    },
  });

  useEffect(() => {
    if (role !== "controller") {
      setEntryReady(true);
      return;
    }
    if (entryStartedForRef.current === gameId) return;
    entryStartedForRef.current = gameId;
    setEntryReady(false);
    void entry.begin();
  }, [entry, gameId, role]);

  useEffect(
    () =>
      departureModule.subscribe(() => {
        const projection = departureModule.project();
        if (controllerDepartureBlocksGame(projection, "ad-hoc", gameId)) {
          setEntryReady(false);
          setEntryError("Ad Hoc Game unavailable.");
        }
      }),
    [departureModule, gameId],
  );

  const leaveAdHocGame = useCallback(async () => {
    setLeaveMessage(null);
    setLeavePending(true);
    const outcome = await departureModule.transition({
      type: "leave",
      departure: controllerDepartureReference({
        workflow: "ad-hoc",
        gameId,
        homeName,
        awayName,
      }),
    });
    setLeavePending(false);
    if (outcome.status === "left") {
      setLeaveDialogOpen(false);
      navigateTo("/");
    } else {
      setLeaveMessage("Ad Hoc Game unavailable.");
    }
  }, [awayName, departureModule, gameId, homeName]);

  useEffect(() => {
    if (baseState !== null) {
      if (renamingTeam === null) {
        setHomeName(baseState.homeName);
        setAwayName(baseState.awayName);
        setHomeColor(baseState.homeColor);
        setAwayColor(baseState.awayColor);
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
      return false;
    }

    const playerNumber = cardDraft.digits.length === 0 ? null : Number(cardDraft.digits);
    dispatchCommand(
      cardDraft.editingCardId === null
        ? {
            type: "add-card",
            team: cardDraft.team,
            cardType: cardDraft.cardType,
            playerNumber,
            startedGameClockMs: cardDraft.startedGameClockMs ?? liveState.gameClockMs,
          }
        : {
            type: "update-card",
            cardId: cardDraft.editingCardId,
            team: cardDraft.team,
            cardType: cardDraft.cardType,
            playerNumber,
          },
    );

    setCardDraft({
      cardType: null,
      team: null,
      digits: "",
      startedGameClockMs: null,
      editingCardId: null,
      wizardStep: "type",
    });
    setCardCreationPending(false);
    pendingCardCreationIdsRef.current = null;
    return true;
  }, [cardDraft, controller, dispatchCommand, liveState]);

  const commitCardWithoutNumber = useCallback(
    (team: TeamId) => {
      if (!controller || liveState === null || cardDraft.cardType === null) return;
      pendingCardCreationIdsRef.current = new Set(liveState.cardEvents.map((event) => event.id));
      dispatchCommand({
        type: "add-card",
        team,
        cardType: cardDraft.cardType,
        playerNumber: null,
        startedGameClockMs: cardDraft.startedGameClockMs ?? liveState.gameClockMs,
      });
      setCardDraft((previous) => ({ ...previous, team, digits: "" }));
      setCardCreationPending(true);
    },
    [cardDraft.cardType, cardDraft.startedGameClockMs, controller, dispatchCommand, liveState],
  );

  useEffect(() => {
    const previousIds = pendingCardCreationIdsRef.current;
    if (!cardCreationPending || previousIds === null || liveState === null) return;
    const created = [...liveState.cardEvents].reverse().find((event) => !previousIds.has(event.id));
    if (created === undefined) return;
    setCardDraft((previous) => ({
      ...previous,
      cardType: created.cardType,
      team: created.team,
      editingCardId: created.id,
      digits: created.playerNumber === null ? "" : String(created.playerNumber),
      wizardStep: "number",
    }));
    setCardCreationPending(false);
    pendingCardCreationIdsRef.current = null;
  }, [cardCreationPending, liveState]);

  const openCardEditor = useCallback(
    (cardEventId: string) => {
      if (!controller || liveState === null) return;
      const event = liveState.cardEvents.find((candidate) => candidate.id === cardEventId);
      if (event === undefined) return;
      setCardDraft({
        cardType: event.cardType,
        team: event.team,
        digits: event.playerNumber === null ? "" : String(event.playerNumber),
        startedGameClockMs: event.gameClockMs,
        editingCardId: event.id,
        wizardStep: "number",
      });
      setCardCreationPending(false);
      pendingCardCreationIdsRef.current = null;
      setPendingWinConfirmation(null);
      setActivePanel("card");
    },
    [controller, liveState],
  );

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
      homeColor,
      awayColor,
    });
    setRenamingTeam(null);
  }, [awayColor, awayName, controller, dispatchCommand, homeColor, homeName]);

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
      renamingTeam !== null &&
      (homeName !== liveState.homeName ||
        awayName !== liveState.awayName ||
        homeColor !== liveState.homeColor ||
        awayColor !== liveState.awayColor);
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
  }, [
    awayColor,
    awayName,
    controller,
    dispatchCommand,
    homeColor,
    homeName,
    liveState,
    renamingTeam,
  ]);

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

  useEffect(() => {
    const element = controllerTopSectionRef.current;
    if (element === null || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      const nextHeight = entry === undefined ? null : Math.ceil(entry.contentRect.height);
      setControllerTopSectionHeightPx((previous) =>
        previous === nextHeight ? previous : nextHeight,
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [liveState?.homeName, liveState?.awayName, liveState?.displaySidesSwapped]);

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
      <>
        {entry.dialog}
        <div className="mx-auto flex min-h-screen w-full max-w-3xl items-center justify-center p-6">
          <Card className="w-full">
            <CardHeader>
              <CardTitle>{entryError ?? error ?? "Loading game"}</CardTitle>
              <CardDescription>
                {entryError === null && error === null
                  ? "Waiting for snapshot from server."
                  : "Return to the Games page."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button ref={entryTriggerRef} variant="outline" onClick={() => navigateTo("/")}>
                Back to games
              </Button>
            </CardContent>
          </Card>
        </div>
      </>
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
    cardDraft.team !== null &&
    (cardDraft.editingCardId !== null || cardDraft.digits.length > 0) &&
    !cardCreationPending;
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
      ? "Choose a card type and team."
      : cardDraft.digits.length === 0
        ? cardDraft.editingCardId === null
          ? "Waiting for the card to be committed."
          : "No player number — OK keeps this card unknown."
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
  const teamColorsByTeam: Record<TeamId, string> = {
    home: normalizeTeamColor(state.homeColor, DEFAULT_HOME_TEAM_COLOR),
    away: normalizeTeamColor(state.awayColor, DEFAULT_AWAY_TEAM_COLOR),
  };
  const scoreColumnsByTeam: Record<
    TeamId,
    {
      team: TeamId;
      name: string;
      score: number;
    }
  > = {
    home: {
      team: "home",
      name: state.homeName,
      score: state.score.home,
    },
    away: {
      team: "away",
      name: state.awayName,
      score: state.score.away,
    },
  };
  const leftTeam: TeamId = state.displaySidesSwapped ? "away" : "home";
  const rightTeam: TeamId = state.displaySidesSwapped ? "home" : "away";
  const displayTeamOrder: [TeamId, TeamId] = [leftTeam, rightTeam];
  const scoreColumnsWithStyles: Array<{
    team: TeamId;
    name: string;
    score: number;
    scoreBoxStyle: CSSProperties;
    scoreValueStyle: CSSProperties;
    scoreDownButtonStyle: CSSProperties;
  }> = displayTeamOrder.map((team, index) => {
    const side = index === 0 ? "left" : "right";
    return {
      ...scoreColumnsByTeam[team],
      scoreBoxStyle: buildScoreUpButtonStyle(teamColorsByTeam[team], side),
      scoreValueStyle: buildScoreValueStyle(teamColorsByTeam[team]),
      scoreDownButtonStyle: buildScoreDownButtonStyle(teamColorsByTeam[team]),
    };
  });
  const homeScoreColumn = scoreColumnsWithStyles[0]!;
  const awayScoreColumn = scoreColumnsWithStyles[1]!;
  const clockTheme = buildClockTheme(teamColorsByTeam[leftTeam], teamColorsByTeam[rightTeam]);
  const homeTabTheme = { activeStyle: buildActionPanelTabStyle("card", teamColorsByTeam.home) };
  const awayTabTheme = {
    activeStyle: buildActionPanelTabStyle("timeout", teamColorsByTeam.away),
  };
  const penaltyColumnsByTeam: Record<
    TeamId,
    {
      team: TeamId;
      penalties: PlayerPenaltyView[];
      visiblePenalties: PlayerPenaltyView[];
      recentReleases: ReleasedPenaltyView[];
      panelBorderStyle: CSSProperties;
      panelTintStyle: CSSProperties;
      headerTextStyle: CSSProperties;
      neutralChipStyle: CSSProperties;
    }
  > = {
    home: {
      team: "home",
      penalties: homePenalties,
      visiblePenalties: visibleHomePenalties,
      recentReleases: homeRecentReleases,
      panelBorderStyle: buildPenaltyPanelBorderStyle(teamColorsByTeam.home),
      panelTintStyle: buildPenaltyPanelTintStyle(teamColorsByTeam.home, "left"),
      headerTextStyle: buildPenaltyHeaderStyle(teamColorsByTeam.home),
      neutralChipStyle: buildPenaltyNeutralChipStyle(teamColorsByTeam.home),
    },
    away: {
      team: "away",
      penalties: awayPenalties,
      visiblePenalties: visibleAwayPenalties,
      recentReleases: awayRecentReleases,
      panelBorderStyle: buildPenaltyPanelBorderStyle(teamColorsByTeam.away),
      panelTintStyle: buildPenaltyPanelTintStyle(teamColorsByTeam.away, "right"),
      headerTextStyle: buildPenaltyHeaderStyle(teamColorsByTeam.away),
      neutralChipStyle: buildPenaltyNeutralChipStyle(teamColorsByTeam.away),
    },
  };
  const penaltyColumns: Array<{
    team: TeamId;
    penalties: PlayerPenaltyView[];
    visiblePenalties: PlayerPenaltyView[];
    recentReleases: ReleasedPenaltyView[];
    panelBorderStyle: CSSProperties;
    panelTintStyle: CSSProperties;
    headerTextStyle: CSSProperties;
    neutralChipStyle: CSSProperties;
  }> = displayTeamOrder.map((team, index) => {
    const side = index === 0 ? "left" : "right";

    return {
      ...penaltyColumnsByTeam[team],
      panelTintStyle: buildPenaltyPanelTintStyle(teamColorsByTeam[team], side),
    };
  });
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
    <div className="relative h-[100dvh] overflow-hidden bg-slate-100 p-2 text-slate-900">
      {entry.dialog}
      {leaveDialogOpen ? (
        <ControllerLeaveDialog
          triggerRef={leaveTriggerRef}
          busy={leavePending}
          onCancel={() => {
            setLeaveDialogOpen(false);
          }}
          onConfirm={() => void leaveAdHocGame()}
        />
      ) : null}
      <div className="mx-auto grid h-full w-full max-w-[460px] grid-rows-[auto_minmax(0,1fr)] gap-2">
        <ControllerHeader
          identity={{
            eyebrow: "Ad Hoc Game",
            title: `${state.homeName} vs ${state.awayName}`,
          }}
          warning={
            controller && connectionState !== "online"
              ? {
                  kind: "offline",
                  queuedActions: pendingCommands,
                  retryDetail: controllerWarningRetryDetail,
                }
              : null
          }
          qr={
            controller && controlQr !== null && !state.isFinished
              ? {
                  label: "Show Ad Hoc Control QR",
                  expanded: adHocQrOpen,
                  controls: "ad-hoc-control-qr-dialog",
                  triggerRef: adHocQrTriggerRef,
                  onClick: () => setAdHocQrOpen(true),
                }
              : undefined
          }
          onLeave={controller ? () => setLeaveDialogOpen(true) : undefined}
          leaveTriggerRef={controller ? leaveTriggerRef : undefined}
          leaveLabel="Leave Ad Hoc Game Controller"
        >
          {leaveMessage ? (
            <p className="mt-1 text-[10px] font-medium text-rose-700">{leaveMessage}</p>
          ) : null}
          {!controller && error === null ? (
            <p className="mt-1 inline-flex items-center gap-1 text-[10px] text-slate-500">
              <Eye className="size-3" aria-hidden="true" /> Read only
            </p>
          ) : null}
          {controller && error !== null && connectionState === "online" ? (
            <p className="mt-1 text-[10px] font-medium text-amber-700" role="status">
              {error}
            </p>
          ) : null}
        </ControllerHeader>

        <div className="relative min-h-0 grid grid-rows-[auto_minmax(0,1fr)] gap-2">
          {controller ? (
            <AdHocControlHandoff
              gameId={gameId}
              controlQr={controlQr}
              qrOpen={adHocQrOpen}
              triggerRef={adHocQrTriggerRef}
              onClose={() => setAdHocQrOpen(false)}
            />
          ) : null}

          <div ref={controllerTopSectionRef} className="min-h-0">
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
                homeColor,
                awayColor,
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
                  setHomeColor(state.homeColor);
                  setAwayColor(state.awayColor);
                  setRenamingTeam(team);
                },
                onRenameInputChange: (team, value) => {
                  if (team === "home") {
                    setHomeName(value);
                  } else {
                    setAwayName(value);
                  }
                },
                onRenameColorChange: (team, value) => {
                  if (team === "home") {
                    setHomeColor(value);
                  } else {
                    setAwayColor(value);
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
              clockTheme={clockTheme}
            />
          </div>

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
            onEditPenalty={openCardEditor}
          />

          <GameControllerActionPanels
            activePanel={activePanel}
            setActivePanel={handleActionPanelChange}
            topOffsetPx={controllerTopSectionHeightPx ?? undefined}
            controller={controller}
            state={state}
            gameView={{
              timeoutFinalCountdown: gameView.timeoutFinalCountdown,
              timeoutWarningActive: gameView.timeoutWarningActive,
            }}
            displayTeamOrder={displayTeamOrder}
            displayTeamName={displayTeamName}
            tabThemes={{
              card: homeTabTheme,
              timeout: awayTabTheme,
              game: {
                activeStyle: buildActionPanelTabStyle(
                  "game",
                  teamColorsByTeam.home,
                  teamColorsByTeam.away,
                ),
              },
            }}
            cardTypeOptions={cardTypeOptions}
            cardDraft={cardDraft}
            setCardDraft={setCardDraft}
            canSelectCardType={canSelectCardType}
            canSelectCardTeam={canSelectCardTeam}
            cardPlayerLabel={cardPlayerLabel}
            cardAddStatusText={cardAddStatusText}
            canEditCardDigits={canEditCardDigits}
            cardCreationPending={cardCreationPending}
            commitCardWithoutNumber={commitCardWithoutNumber}
            appendCardDigit={appendCardDigit}
            canSubmitCard={canSubmitCard}
            submitCard={() => {
              if (submitCard()) handleActionPanelChange(null);
            }}
            activeTimeout={activeTimeout}
            formatRemaining={formatRemaining}
            pendingWinConfirmation={
              pendingWinConfirmation === null ? null : { label: pendingWinConfirmation.label }
            }
            confirmWinAction={() => {
              confirmWinAction();
              handleActionPanelChange(null);
            }}
            clearPendingWinConfirmation={() => setPendingWinConfirmation(null)}
            finishSummary={finishSummary}
            canResumeGame={canResumeGame}
            canSuspendGame={canSuspendGame}
            canUseEndingActions={canUseEndingActions}
            canRecordFlagCatch={canRecordFlagCatch}
            startTimeout={(team) => {
              dispatchCommand({ type: "start-timeout", team });
            }}
            setTimeoutRunning={(running) => {
              dispatchCommand({
                type: "set-timeout-running",
                running,
              });
              handleActionPanelChange(null);
            }}
            undoTimeoutStart={() => {
              dispatchCommand({ type: "undo-timeout-start" });
              handleActionPanelChange(null);
            }}
            cancelTimeout={() => {
              dispatchCommand({ type: "cancel-timeout" });
              handleActionPanelChange(null);
            }}
            resumeGame={() => {
              dispatchCommand({ type: "resume-game" });
              handleActionPanelChange(null);
            }}
            suspendGame={() => {
              dispatchCommand({ type: "suspend-game" });
              handleActionPanelChange(null);
            }}
            requestForfeitWin={(team) => {
              const winner = team === "home" ? "away" : "home";
              requestWinConfirmation(`${displayTeamName(winner)} wins by forfeit penalty.`, {
                type: "record-forfeit",
                team,
              });
            }}
            recordDoubleForfeit={() => {
              dispatchCommand({ type: "record-double-forfeit" });
              handleActionPanelChange(null);
            }}
            correctBackToUnfinished={() => {
              dispatchCommand({ type: "correct-to-unfinished" });
              handleActionPanelChange(null);
            }}
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
              handleActionPanelChange(null);
            }}
          />
        </div>
      </div>
    </div>
  );
}

function AdHocControlHandoff({
  gameId,
  controlQr,
  qrOpen,
  triggerRef,
  onClose,
}: {
  gameId: string;
  controlQr: string | null;
  qrOpen: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeQrButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogWasOpenRef = useRef(false);
  const payload = controlQr === null ? null : buildAdHocControlQrPayload(gameId, controlQr);

  useEffect(() => {
    if (!qrOpen) return;
    closeQrButtonRef.current?.focus();
    const dialog = dialogRef.current;
    if (dialog === null) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("disabled"));
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };

    dialog.addEventListener("keydown", onKeyDown);
    return () => dialog.removeEventListener("keydown", onKeyDown);
  }, [onClose, qrOpen]);

  useEffect(() => {
    if (qrOpen) {
      dialogWasOpenRef.current = true;
      return;
    }
    if (!dialogWasOpenRef.current) return;
    dialogWasOpenRef.current = false;
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, [qrOpen, triggerRef]);

  useEffect(() => {
    if (payload === null) {
      setQrDataUrl(null);
      setQrError(false);
      return;
    }

    let cancelled = false;
    setQrError(false);
    void QRCode.toDataURL(payload, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 320,
    })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQrError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [payload]);

  if (!qrOpen) return null;
  return (
    <div
      id="ad-hoc-control-qr-dialog"
      aria-label="Ad Hoc Control QR dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"
      aria-modal="true"
      ref={dialogRef}
      role="dialog"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-4 shadow-xl">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-slate-900">Ad Hoc Control QR</p>
          <Button ref={closeQrButtonRef} size="sm" variant="outline" onClick={onClose}>
            Close Control QR
          </Button>
        </div>
        {qrError ? (
          <p className="text-[11px] text-rose-700">Unable to display the Control QR.</p>
        ) : qrDataUrl !== null ? (
          <>
            <img
              alt="Ad Hoc Control QR code"
              className="mx-auto size-64 max-w-full rounded border border-slate-200"
              src={qrDataUrl}
            />
            <p className="text-center text-[11px] text-slate-600">
              Scan this QR on another device to join directly as an equal Controller.
            </p>
          </>
        ) : (
          <p className="text-[11px] text-slate-600">Preparing the reusable Control QR…</p>
        )}
      </div>
    </div>
  );
}

function buildClockTheme(leftTeamColor: string, rightTeamColor: string) {
  const left = normalizeTeamColor(leftTeamColor, DEFAULT_HOME_TEAM_COLOR);
  const right = normalizeTeamColor(rightTeamColor, DEFAULT_AWAY_TEAM_COLOR);
  const shellBorder = shiftColorHex(left, { dl: 0.142899263, dc: -0.046591806, dh: -7.004624547 });
  const shellMid = shiftColorHex(left, { dl: 0.247230661, dc: -0.116277213, dh: 18.262960722 });
  const shellOuter = shiftColorHex(left, { dl: 0.197656183, dc: -0.090811681, dh: 16.805863076 });
  const rotorHotspot = shiftColorHex(right, { dl: 0.052768544, dc: -0.027683619, dh: 8.329994208 });

  return {
    shellStyle: {
      borderColor: withColorAlpha(shellBorder, 0.6),
      backgroundImage: `radial-gradient(circle,#ffffff 34%,${shellMid} 70%,${shellOuter} 100%)`,
      boxShadow: `0 0 0 1px ${withColorAlpha(shellBorder, 0.5)}, 0 0 24px ${withColorAlpha(left, 0.22)}`,
    } satisfies CSSProperties,
    rotorStyle: {
      backgroundImage: `conic-gradient(from 0deg, ${withColorAlpha(left, 0.22)}, ${withColorAlpha(rotorHotspot, 0.18)}, ${withColorAlpha(left, 0.22)})`,
    } satisfies CSSProperties,
    rotorInnerStyle: {
      backgroundImage: `conic-gradient(from 180deg, rgba(255,255,255,0.8), ${withColorAlpha(left, 0.14)}, rgba(255,255,255,0.8))`,
    } satisfies CSSProperties,
    ringStyle: {
      borderColor: withColorAlpha(shellBorder, 0.5),
    } satisfies CSSProperties,
  };
}

function shiftColorHex(color: string, shift: { dl: number; dc: number; dh: number }) {
  const oklch = hexToOklch(color);
  if (oklch === null) {
    return color;
  }

  return oklchToHex(shiftOklch(oklch, shift));
}
