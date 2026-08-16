import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { GameControllerActionPanels } from "@/components/game-controller-action-panels";
import { applyGameCommand, createInitialGameState } from "@/lib/game-engine";
import type { CardType, GameCommand, TeamId } from "@/lib/game-types";

describe("Ad Hoc Controller action UI", () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  let testWindow: Window;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    testWindow = new Window({ url: "http://timer.quadball.app/game/adhoc-ui" });
    Object.assign(globalThis, {
      window: testWindow,
      document: testWindow.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
    testWindow.close();
    Object.assign(globalThis, { window: originalWindow, document: originalDocument });
  });

  test("covers Ad Hoc validation, draft reset, local completion, timeout sequencing, focus, and core coexistence", async () => {
    await act(async () => {
      root.render(<AdHocActionHarness />);
      await Promise.resolve();
    });

    const cards = actionButton("Cards");
    const timeout = actionButton("Timeout");
    const gameEnd = actionButton("Game end");
    expect(container.querySelector('[data-controller-action-panel="true"]')).toBeNull();
    expect(document.activeElement).not.toBe(cards);

    await click(cards);
    expect(container.querySelector('[data-controller-action-panel="true"]')).not.toBeNull();
    expect(container.querySelector('[data-card-wizard-step="type"]')).not.toBeNull();
    await click(actionButton("Timeout"));
    await click(cards);
    expect(container.querySelector('[data-card-wizard-step="type"]')).not.toBeNull();

    await click(cards);
    await click(cards);
    await click(panelButton("Blue"));
    expect(container.querySelector('[data-card-wizard-step="team"]')).not.toBeNull();
    await click(panelButton("Home"));
    expect(container.querySelector('[data-card-wizard-step="number"]')).not.toBeNull();
    await click(panelButton("OK"));
    expect(container.querySelector('[data-controller-action-panel="true"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await click(panelButton("7"));
    await click(panelButton("OK"));
    expect(container.querySelector('[data-controller-action-panel="true"]')).toBeNull();
    expect(document.activeElement).toBe(cards);

    await click(timeout);
    await click(panelButton("Home timeout"));
    expect(container.querySelector('[data-controller-action-panel="true"]')).not.toBeNull();
    expect(document.activeElement).not.toBe(timeout);
    await click(panelButton("Start"));
    expect(container.querySelector('[data-controller-action-panel="true"]')).toBeNull();
    expect(document.activeElement).toBe(timeout);

    await click(gameEnd);
    await click(panelButton("Home forfeit"));
    await click(panelButton("Confirm"));
    expect(container.querySelector('[data-controller-action-panel="true"]')).toBeNull();
    expect(document.activeElement).toBe(gameEnd);

    await click(cards);
    await click(panelButton("Blue"));
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Play/pause game"]'));
    await click(
      container.querySelector<HTMLButtonElement>('button[aria-label="Increase Home score"]'),
    );
    await click(
      container.querySelector<HTMLButtonElement>('button[aria-label="Decrease Home score"]'),
    );
    expect(container.querySelector('[data-controller-action-panel="true"]')).not.toBeNull();
    expect(container.textContent).toContain("blue");
  });

  function actionButton(label: string) {
    const button = Array.from(container.getElementsByTagName("button")).find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (button === undefined) throw new Error(`Missing action button: ${label}`);
    return button;
  }

  function panelButton(label: string) {
    const panel = container.querySelector('[data-controller-action-panel="true"]');
    if (panel === null) throw new Error(`Missing action panel for: ${label}`);
    const button = Array.from(panel.getElementsByTagName("button")).find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (button === undefined) throw new Error(`Missing panel button: ${label}`);
    return button;
  }

  async function click(button: HTMLButtonElement | null) {
    if (button === null) throw new Error("Expected a button to click.");
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
  }
});

function AdHocActionHarness() {
  const [activePanel, setActivePanel] = useState<"card" | "timeout" | "game" | null>(null);
  const [state, setState] = useState(() => createInitialGameState({ id: "adhoc-ui", nowMs: 0 }));
  const [cardDraft, setCardDraft] = useState({
    cardType: null as CardType | null,
    team: null as TeamId | null,
    digits: "",
    startedGameClockMs: null as number | null,
  });
  const [pendingWinConfirmation, setPendingWinConfirmation] = useState<{ label: string } | null>(
    null,
  );

  const dispatch = (command: GameCommand) => {
    setState((current) =>
      applyGameCommand({ state: current, command, nowMs: 1_000, idGenerator: () => "ui-action" }),
    );
  };
  const resetDraft = () =>
    setCardDraft({ cardType: null, team: null, digits: "", startedGameClockMs: null });

  return (
    <>
      <button aria-label="Play/pause game" onClick={() => undefined}>
        Play/pause
      </button>
      <button
        aria-label="Increase Home score"
        onClick={() => dispatch({ type: "change-score", team: "home", delta: 10, reason: "goal" })}
      >
        Home +10
      </button>
      <button
        aria-label="Decrease Home score"
        onClick={() => dispatch({ type: "undo-last-score", team: "home" })}
      >
        Home −10
      </button>
      <GameControllerActionPanels
        activePanel={activePanel}
        setActivePanel={(panel) => {
          resetDraft();
          setPendingWinConfirmation(null);
          setActivePanel(panel);
        }}
        controller
        state={state}
        gameView={{ timeoutFinalCountdown: false, timeoutWarningActive: false }}
        displayTeamOrder={["home", "away"]}
        displayTeamName={(team) => (team === "home" ? "Home" : "Away")}
        tabThemes={{
          card: { activeStyle: {} },
          timeout: { activeStyle: {} },
          game: { activeStyle: {} },
        }}
        cardTypeOptions={[
          { type: "blue", label: "Blue", icon: EmptyIcon, activeClassName: "", idleClassName: "" },
          {
            type: "yellow",
            label: "Yellow",
            icon: EmptyIcon,
            activeClassName: "",
            idleClassName: "",
          },
          { type: "red", label: "Red", icon: EmptyIcon, activeClassName: "", idleClassName: "" },
          {
            type: "ejection",
            label: "Ejection",
            icon: EmptyIcon,
            activeClassName: "",
            idleClassName: "",
          },
        ]}
        cardDraft={cardDraft}
        setCardDraft={setCardDraft}
        canSelectCardType
        canSelectCardTeam={cardDraft.cardType !== null}
        cardPlayerLabel="no player"
        cardAddStatusText={
          cardDraft.cardType === null || cardDraft.team === null
            ? "Choose a card type and team."
            : cardDraft.digits.length === 0
              ? "Enter a player number to record this card."
              : "Ready"
        }
        canEditCardDigits={cardDraft.cardType !== null && cardDraft.team !== null}
        appendCardDigit={(digit) =>
          setCardDraft((current) => ({ ...current, digits: current.digits + digit }))
        }
        canSubmitCard={
          cardDraft.cardType !== null && cardDraft.team !== null && cardDraft.digits.length > 0
        }
        submitCard={() => {
          dispatch({
            type: "add-card",
            team: cardDraft.team ?? "home",
            cardType: cardDraft.cardType ?? "blue",
            playerNumber: cardDraft.digits.length === 0 ? null : Number(cardDraft.digits),
            startedGameClockMs: 0,
          });
          resetDraft();
          setActivePanel(null);
        }}
        activeTimeout={state.timeouts.active}
        formatRemaining={(ms) => `${ms}ms`}
        pendingWinConfirmation={pendingWinConfirmation}
        confirmWinAction={() => {
          setPendingWinConfirmation(null);
          setActivePanel(null);
        }}
        clearPendingWinConfirmation={() => setPendingWinConfirmation(null)}
        finishSummary={null}
        canResumeGame={false}
        canSuspendGame={false}
        canUseEndingActions
        canRecordFlagCatch={false}
        startTimeout={(team) => dispatch({ type: "start-timeout", team })}
        setTimeoutRunning={(running) => {
          dispatch({ type: "set-timeout-running", running });
          setActivePanel(null);
        }}
        undoTimeoutStart={() => {
          dispatch({ type: "undo-timeout-start" });
          setActivePanel(null);
        }}
        cancelTimeout={() => {
          dispatch({ type: "cancel-timeout" });
          setActivePanel(null);
        }}
        resumeGame={() => undefined}
        suspendGame={() => undefined}
        requestForfeitWin={() => setPendingWinConfirmation({ label: "Home wins by forfeit" })}
        recordDoubleForfeit={() => setActivePanel(null)}
        correctBackToUnfinished={() => undefined}
        requestTargetScoreWin={() => undefined}
        requestConcedeWin={() => undefined}
        recordOrConfirmFlagCatch={() => undefined}
      />
    </>
  );
}

function EmptyIcon({ className }: { className?: string }) {
  return <span className={className} aria-hidden="true" />;
}
