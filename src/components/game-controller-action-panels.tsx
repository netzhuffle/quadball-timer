import type { CSSProperties, ComponentType, Dispatch, SetStateAction } from "react";
import { Check, Delete } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ControllerActionSheet } from "@/components/controller-action-sheet";
import type { ControllerActionPanel } from "@/lib/controller-action-sheet";
import type { CardType, GameState, TeamId } from "@/lib/game-types";

type ActivePanel = ControllerActionPanel | null;

type CardDraft = {
  cardType: CardType | null;
  team: TeamId | null;
  digits: string;
  startedGameClockMs: number | null;
};

type CardTypeOption = {
  type: CardType;
  label: string;
  icon: ComponentType<{ className?: string }>;
  activeClassName: string;
  idleClassName: string;
};

type PendingWinConfirmationView = {
  label: string;
} | null;

type PanelTabTheme = {
  activeStyle: CSSProperties;
};

export function GameControllerActionPanels({
  activePanel,
  setActivePanel,
  topOffsetPx,
  controller,
  state,
  gameView,
  displayTeamOrder,
  displayTeamName,
  tabThemes,
  cardTypeOptions,
  cardDraft,
  setCardDraft,
  canSelectCardType,
  canSelectCardTeam,
  cardPlayerLabel,
  cardAddStatusText,
  canEditCardDigits,
  appendCardDigit,
  canSubmitCard,
  submitCard,
  activeTimeout,
  formatRemaining,
  pendingWinConfirmation,
  confirmWinAction,
  clearPendingWinConfirmation,
  finishSummary,
  canResumeGame,
  canSuspendGame,
  canUseEndingActions,
  canRecordFlagCatch,
  startTimeout,
  setTimeoutRunning,
  undoTimeoutStart,
  cancelTimeout,
  resumeGame,
  suspendGame,
  requestForfeitWin,
  recordDoubleForfeit,
  correctBackToUnfinished,
  requestTargetScoreWin,
  requestConcedeWin,
  recordOrConfirmFlagCatch,
}: {
  activePanel: ActivePanel;
  setActivePanel: (panel: ActivePanel) => void;
  topOffsetPx?: number;
  controller: boolean;
  state: GameState;
  gameView: {
    timeoutFinalCountdown: boolean;
    timeoutWarningActive: boolean;
  };
  displayTeamOrder: [TeamId, TeamId];
  displayTeamName: (team: TeamId) => string;
  tabThemes: {
    card: PanelTabTheme;
    timeout: PanelTabTheme;
    game: PanelTabTheme;
  };
  cardTypeOptions: CardTypeOption[];
  cardDraft: CardDraft;
  setCardDraft: Dispatch<SetStateAction<CardDraft>>;
  canSelectCardType: boolean;
  canSelectCardTeam: boolean;
  cardPlayerLabel: string;
  cardAddStatusText: string;
  canEditCardDigits: boolean;
  appendCardDigit: (digit: string) => void;
  canSubmitCard: boolean;
  submitCard: () => void;
  activeTimeout: GameState["timeouts"]["active"];
  formatRemaining: (ms: number) => string;
  pendingWinConfirmation: PendingWinConfirmationView;
  confirmWinAction: () => void;
  clearPendingWinConfirmation: () => void;
  finishSummary: string | null;
  canResumeGame: boolean;
  canSuspendGame: boolean;
  canUseEndingActions: boolean;
  canRecordFlagCatch: boolean;
  startTimeout: (team: TeamId) => void;
  setTimeoutRunning: (running: boolean) => void;
  undoTimeoutStart: () => void;
  cancelTimeout: () => void;
  resumeGame: () => void;
  suspendGame: () => void;
  requestForfeitWin: (penalizedTeam: TeamId) => void;
  recordDoubleForfeit: () => void;
  correctBackToUnfinished: () => void;
  requestTargetScoreWin: (team: TeamId) => void;
  requestConcedeWin: (team: TeamId) => void;
  recordOrConfirmFlagCatch: (team: TeamId) => void;
}) {
  return (
    <ControllerActionSheet
      activePanel={activePanel}
      onPanelChange={setActivePanel}
      tabThemes={tabThemes}
      topOffsetPx={topOffsetPx}
      panel={
        <Card className="relative min-h-0 overflow-hidden rounded-[1.5rem] border-0 bg-transparent py-0 shadow-none">
          <CardContent className="overflow-hidden px-2">
            <CardWizard
              active={activePanel === "card"}
              controller={controller}
              state={state}
              displayTeamOrder={displayTeamOrder}
              displayTeamName={displayTeamName}
              cardTypeOptions={cardTypeOptions}
              cardDraft={cardDraft}
              setCardDraft={setCardDraft}
              canSelectCardType={canSelectCardType}
              canSelectCardTeam={canSelectCardTeam}
              cardPlayerLabel={cardPlayerLabel}
              cardAddStatusText={cardAddStatusText}
              canEditCardDigits={canEditCardDigits}
              appendCardDigit={appendCardDigit}
              canSubmitCard={canSubmitCard}
              submitCard={submitCard}
              closePanel={() => setActivePanel(null)}
            />

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
                      onClick={() => startTimeout(team)}
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
                        onClick={() => setTimeoutRunning(true)}
                        disabled={!controller}
                      >
                        Start
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-9 rounded-xl border-slate-300 bg-white text-slate-900"
                        onClick={undoTimeoutStart}
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
                        onClick={cancelTimeout}
                        disabled={!controller}
                      >
                        End early
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-9 rounded-xl border-slate-300 bg-white text-slate-900"
                        onClick={undoTimeoutStart}
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
                      onClick={clearPendingWinConfirmation}
                      disabled={!controller}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
              {state.isFinished ? (
                <>
                  <p className="text-[11px] text-slate-600">{finishSummary ?? "Game finished."}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 rounded-xl border-slate-300 bg-white text-slate-900"
                    onClick={correctBackToUnfinished}
                    disabled={!controller}
                  >
                    Correct back to unfinished
                  </Button>
                </>
              ) : state.isSuspended ? (
                <>
                  <p className="text-[11px] text-slate-600">
                    Game suspended. Resume when continuing this game.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 rounded-xl border-slate-300 bg-white text-slate-900"
                    onClick={resumeGame}
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
                    onClick={suspendGame}
                    disabled={!canSuspendGame}
                  >
                    Suspend game
                  </Button>
                  <div className="grid grid-cols-2 gap-1">
                    {displayTeamOrder.map((team) => (
                      <Button
                        key={`forfeit-${team}`}
                        size="sm"
                        variant="outline"
                        className="h-8 rounded-xl border-slate-300 bg-white text-slate-900"
                        onClick={() => requestForfeitWin(team)}
                        disabled={!canUseEndingActions}
                      >
                        {displayTeamName(team)} forfeit
                      </Button>
                    ))}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 rounded-xl border-slate-300 bg-white text-slate-900"
                    onClick={recordDoubleForfeit}
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
                            onClick={() => requestTargetScoreWin(team)}
                            disabled={!canUseEndingActions}
                          >
                            {displayTeamName(team)} reached target
                          </Button>
                        ))}
                      </div>
                      <div className="grid grid-cols-2 gap-1">
                        {displayTeamOrder.map((team) => (
                          <Button
                            key={`concede-${team}`}
                            size="sm"
                            variant="outline"
                            className="h-8 rounded-xl border-slate-300 bg-white text-slate-900"
                            onClick={() => requestConcedeWin(team)}
                            disabled={!canUseEndingActions}
                          >
                            {displayTeamName(team)} concedes
                          </Button>
                        ))}
                      </div>
                    </>
                  ) : canRecordFlagCatch ? (
                    <div className="grid grid-cols-2 gap-1">
                      {displayTeamOrder.map((team) => (
                        <Button
                          key={`flag-catch-${team}`}
                          size="sm"
                          className="h-8 rounded-xl"
                          onClick={() => recordOrConfirmFlagCatch(team)}
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
      }
    />
  );
}

function CardWizard({
  active,
  controller,
  state,
  displayTeamOrder,
  displayTeamName,
  cardTypeOptions,
  cardDraft,
  setCardDraft,
  canSelectCardType,
  canSelectCardTeam,
  cardPlayerLabel,
  cardAddStatusText,
  canEditCardDigits,
  appendCardDigit,
  canSubmitCard,
  submitCard,
  closePanel,
}: {
  active: boolean;
  controller: boolean;
  state: GameState;
  displayTeamOrder: [TeamId, TeamId];
  displayTeamName: (team: TeamId) => string;
  cardTypeOptions: CardTypeOption[];
  cardDraft: CardDraft;
  setCardDraft: Dispatch<SetStateAction<CardDraft>>;
  canSelectCardType: boolean;
  canSelectCardTeam: boolean;
  cardPlayerLabel: string;
  cardAddStatusText: string;
  canEditCardDigits: boolean;
  appendCardDigit: (digit: string) => void;
  canSubmitCard: boolean;
  submitCard: () => void;
  closePanel: () => void;
}) {
  const step = cardDraft.cardType === null ? "type" : cardDraft.team === null ? "team" : "number";

  if (!active) {
    return null;
  }

  const undo = () => {
    if (step === "number") {
      setCardDraft((previous) => ({ ...previous, team: null, digits: "" }));
      return;
    }
    if (step === "team") {
      setCardDraft({ cardType: null, team: null, digits: "", startedGameClockMs: null });
      return;
    }
    setCardDraft({ cardType: null, team: null, digits: "", startedGameClockMs: null });
    closePanel();
  };

  return (
    <div
      data-card-wizard-step={step}
      className="flex min-h-0 flex-col gap-1.5 rounded-2xl border border-slate-200 bg-slate-50 p-2 animate-in fade-in-0 slide-in-from-bottom-2"
    >
      <div className="flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
        <span>{step === "type" ? "Card type" : step === "team" ? "Team" : "Player number"}</span>
        {step !== "type" ? (
          <span className="truncate text-right normal-case tracking-normal text-slate-600">
            {cardDraft.cardType}{" "}
            {cardDraft.team === null ? "" : `· ${displayTeamName(cardDraft.team)}`}
          </span>
        ) : null}
      </div>

      {step === "type" ? (
        <div className="grid grid-cols-2 gap-1">
          {cardTypeOptions.map((option) => {
            const Icon = option.icon;
            return (
              <Button
                key={option.type}
                size="sm"
                variant="outline"
                className={`h-9 justify-start gap-1.5 rounded-xl px-2 text-[10px] ${option.idleClassName}`}
                onClick={() =>
                  setCardDraft({
                    cardType: option.type,
                    team: null,
                    digits: "",
                    startedGameClockMs: state.gameClockMs,
                  })
                }
                disabled={!canSelectCardType}
              >
                <Icon className="h-3.5 w-3.5" />
                {option.label}
              </Button>
            );
          })}
        </div>
      ) : null}

      {step === "team" ? (
        <div className="grid grid-cols-2 gap-1">
          {displayTeamOrder.map((team) => (
            <Button
              key={team}
              size="sm"
              variant="outline"
              className="h-10 rounded-xl border-slate-300 bg-white text-slate-900"
              onClick={() => setCardDraft((previous) => ({ ...previous, team }))}
              disabled={!canSelectCardTeam}
            >
              {displayTeamName(team)}
            </Button>
          ))}
        </div>
      ) : null}

      {step === "number" ? (
        <>
          <div className="grid grid-cols-[auto_1fr] items-center gap-2 rounded-xl border border-slate-300 bg-white px-2 py-1 text-[10px] font-medium">
            <span className="uppercase">{cardDraft.cardType}</span>
            <span className="truncate text-slate-600">
              {cardDraft.team === "home" ? state.homeName : state.awayName} • {cardPlayerLabel}
            </span>
          </div>
          <p
            role={canSubmitCard ? "status" : "alert"}
            className="min-h-4 text-[10px] text-slate-600"
          >
            {cardAddStatusText}
          </p>
          <div className="grid grid-cols-3 gap-1">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
              <Button
                key={digit}
                size="sm"
                variant="outline"
                className="h-9 rounded-xl border-slate-300 bg-white text-sm text-slate-900"
                onClick={() => appendCardDigit(digit)}
                disabled={!canEditCardDigits}
              >
                {digit}
              </Button>
            ))}
            <Button
              size="sm"
              variant="outline"
              className="h-9 rounded-xl border-slate-300 bg-white text-slate-900"
              onClick={() =>
                setCardDraft((previous) => ({ ...previous, digits: previous.digits.slice(0, -1) }))
              }
              disabled={!canEditCardDigits || cardDraft.digits.length === 0}
            >
              <Delete className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-9 rounded-xl border-slate-300 bg-white text-sm text-slate-900"
              onClick={() => appendCardDigit("0")}
              disabled={!canEditCardDigits}
            >
              0
            </Button>
            <Button
              size="sm"
              className="h-9 gap-1 rounded-xl bg-emerald-600 text-white hover:bg-emerald-500"
              onClick={submitCard}
              disabled={!canSubmitCard}
            >
              <Check className="h-4 w-4" />
              OK
            </Button>
          </div>
        </>
      ) : null}

      <Button
        size="sm"
        variant="ghost"
        className="h-8 rounded-xl text-slate-700"
        onClick={undo}
        disabled={!controller}
      >
        Undo
      </Button>
    </div>
  );
}
