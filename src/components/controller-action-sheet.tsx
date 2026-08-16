import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { Clock3, Flag, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  toggleControllerActionPanel,
  type ControllerActionPanel,
} from "@/lib/controller-action-sheet";

type TabTheme = { activeStyle?: CSSProperties };

export function ControllerActionSheet({
  activePanel,
  onPanelChange,
  panel,
  tabThemes,
}: {
  activePanel: ControllerActionPanel | null;
  onPanelChange: (panel: ControllerActionPanel | null) => void;
  panel: ReactNode;
  tabThemes?: Partial<Record<ControllerActionPanel, TabTheme>>;
}) {
  const previousPanelRef = useRef<ControllerActionPanel | null>(null);
  const actionButtonRefs = useRef<Partial<Record<ControllerActionPanel, HTMLButtonElement | null>>>(
    {},
  );

  useEffect(() => {
    const previousPanel = previousPanelRef.current;
    previousPanelRef.current = activePanel;
    if (previousPanel !== null && activePanel === null) {
      actionButtonRefs.current[previousPanel]?.focus();
    }
  }, [activePanel]);

  const select = (requestedPanel: ControllerActionPanel) => {
    onPanelChange(toggleControllerActionPanel(activePanel, requestedPanel));
  };

  return (
    <div
      data-controller-action-sheet="true"
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col gap-2"
    >
      {activePanel === null ? null : (
        <section
          id="controller-action-panel"
          data-controller-action-panel="true"
          role="region"
          aria-label={`${panelLabel(activePanel)} actions`}
          className="pointer-events-auto max-h-[min(15dvh,12rem)] overflow-y-auto overscroll-contain rounded-2xl border border-slate-300 bg-white/95 p-2 shadow-[0_12px_30px_rgba(15,23,42,0.2)] backdrop-blur-sm [&_button]:min-h-11"
        >
          {panel}
        </section>
      )}
      <nav
        data-controller-action-navigation="true"
        aria-label="Controller actions"
        className="pointer-events-auto rounded-2xl border border-slate-300 bg-white p-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] shadow-[0_8px_20px_rgba(15,23,42,0.16)]"
      >
        <div className="grid grid-cols-3 gap-1">
          <ActionTab
            panel="card"
            activePanel={activePanel}
            theme={tabThemes?.card}
            onSelect={select}
            buttonRef={(button) => {
              actionButtonRefs.current.card = button;
            }}
            icon={<Flag className="size-4" aria-hidden="true" />}
          >
            Cards
          </ActionTab>
          <ActionTab
            panel="timeout"
            activePanel={activePanel}
            theme={tabThemes?.timeout}
            onSelect={select}
            buttonRef={(button) => {
              actionButtonRefs.current.timeout = button;
            }}
            icon={<Clock3 className="size-4" aria-hidden="true" />}
          >
            Timeout
          </ActionTab>
          <ActionTab
            panel="game"
            activePanel={activePanel}
            theme={tabThemes?.game}
            onSelect={select}
            buttonRef={(button) => {
              actionButtonRefs.current.game = button;
            }}
            icon={<Trophy className="size-4" aria-hidden="true" />}
          >
            Game end
          </ActionTab>
        </div>
      </nav>
    </div>
  );
}

function ActionTab({
  panel,
  activePanel,
  theme,
  onSelect,
  buttonRef,
  icon,
  children,
}: {
  panel: ControllerActionPanel;
  activePanel: ControllerActionPanel | null;
  theme?: TabTheme;
  onSelect: (panel: ControllerActionPanel) => void;
  buttonRef: (button: HTMLButtonElement | null) => void;
  icon: ReactNode;
  children: ReactNode;
}) {
  const selected = activePanel === panel;
  return (
    <Button
      type="button"
      ref={buttonRef}
      variant="ghost"
      size="sm"
      aria-expanded={selected}
      aria-controls={selected ? "controller-action-panel" : undefined}
      className={`h-11 min-h-11 gap-1 rounded-xl px-1 text-[11px] transition-all ${
        selected ? "" : "bg-slate-100 text-slate-700"
      }`}
      style={selected ? theme?.activeStyle : undefined}
      onClick={() => onSelect(panel)}
    >
      {icon}
      {children}
    </Button>
  );
}

function panelLabel(panel: ControllerActionPanel) {
  return panel === "card" ? "Cards" : panel === "timeout" ? "Timeout" : "Game end";
}
