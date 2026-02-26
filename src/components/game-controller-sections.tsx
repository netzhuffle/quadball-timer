import type { KeyboardEventHandler, RefObject } from "react";
import { ArrowLeftRight, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { TeamId } from "@/lib/game-types";

type ScoreColumnView = {
  team: TeamId;
  name: string;
  score: number;
  scoreBoxClassName: string;
  scoreValueBorderClassName: string;
  scoreValueGlowClassName: string;
  scoreDownButtonClassName: string;
};

type ScorePulseState = { home: -1 | 0 | 1; away: -1 | 0 | 1 };

type ClockAttachmentView = null | {
  label: string;
  value: string;
  className: string;
  positionClassName: string;
};

type TimeoutReminderView = null | {
  text: string;
  warningActive: boolean;
};

type PenaltyEntryView = {
  playerKey: string;
  label: string;
  remaining: string;
  highlight: boolean;
};

type ReleasedPenaltyView = {
  id: string;
  label: string;
  remainingMs: number;
};

type PendingReleaseActionView = {
  pendingId: string;
  reason: "score" | "flag-catch";
  expireMs: number;
};

type PenaltyColumnView = {
  team: TeamId;
  penalties: PenaltyEntryView[];
  visiblePenalties: PenaltyEntryView[];
  recentReleases: ReleasedPenaltyView[];
  panelBorderClassName: string;
  panelTintClassName: string;
  headerTextClassName: string;
  neutralChipClassName: string;
};

type TeamNameEditorState = {
  controller: boolean;
  renamingTeam: TeamId | null;
  homeName: string;
  awayName: string;
  activeTeamRenameInputRef: RefObject<HTMLInputElement | null>;
  leftTeamNameButtonRef: RefObject<HTMLButtonElement | null>;
  rightTeamNameButtonRef: RefObject<HTMLButtonElement | null>;
  displayTeamNameHeightPx: number | null;
  onOpenRename: (team: TeamId) => void;
  onRenameInputChange: (team: TeamId, value: string) => void;
  onRenameInputKeyDown: KeyboardEventHandler<HTMLInputElement>;
  onSaveRename: () => void;
  onSwapDisplayedTeamSides: () => void;
};

export function ControllerTopSection({
  controller,
  stateIsRunning,
  stateIsFinished,
  stateIsSuspended,
  statusLabel,
  gameClockText,
  leftScoreColumn,
  rightScoreColumn,
  scorePulse,
  teamNameEditor,
  onAddScore,
  onUndoScore,
  onToggleClockAdjust,
  onToggleRunning,
  clockAdjustOpen,
  onAdjustGameClock,
  finishSummary,
  timeoutReminder,
  flagStatus,
  seekersStatus,
}: {
  controller: boolean;
  stateIsRunning: boolean;
  stateIsFinished: boolean;
  stateIsSuspended: boolean;
  statusLabel: string;
  gameClockText: string;
  leftScoreColumn: ScoreColumnView;
  rightScoreColumn: ScoreColumnView;
  scorePulse: ScorePulseState;
  teamNameEditor: TeamNameEditorState;
  onAddScore: (team: TeamId) => void;
  onUndoScore: (team: TeamId) => void;
  onToggleClockAdjust: () => void;
  onToggleRunning: () => void;
  clockAdjustOpen: boolean;
  onAdjustGameClock: (deltaMs: number) => void;
  finishSummary: string | null;
  timeoutReminder: TimeoutReminderView;
  flagStatus: ClockAttachmentView;
  seekersStatus: ClockAttachmentView;
}) {
  return (
    <section className="rounded-2xl border border-slate-300 bg-white px-3 py-2 shadow-[0_8px_18px_rgba(15,23,42,0.08)]">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-1">
        <TeamScoreColumn
          column={leftScoreColumn}
          scorePulse={scorePulse}
          editor={teamNameEditor}
          side="left"
          onAddScore={onAddScore}
          onUndoScore={onUndoScore}
          scoreUpDisabled={!controller || stateIsFinished}
          scoreDownDisabled={!controller}
        />

        <div className="relative">
          <div className="relative flex aspect-square w-[min(47vw,206px)] flex-col items-center overflow-hidden rounded-full border border-sky-300/60 bg-[radial-gradient(circle,#ffffff_34%,#dbeafe_70%,#bfdbfe_100%)] p-2 pt-3 shadow-[0_0_0_1px_rgba(125,211,252,0.5),0_0_24px_rgba(14,165,233,0.22)]">
            <div
              className="clock-rotor pointer-events-none absolute inset-0 rounded-full bg-[conic-gradient(from_0deg,rgba(14,165,233,0.22),rgba(251,146,60,0.18),rgba(14,165,233,0.22))]"
              style={{ animationPlayState: stateIsRunning ? "running" : "paused" }}
            />
            <div
              className="clock-rotor-slow pointer-events-none absolute inset-3 rounded-full bg-[conic-gradient(from_180deg,rgba(255,255,255,0.8),rgba(14,165,233,0.14),rgba(255,255,255,0.8))]"
              style={{ animationPlayState: stateIsRunning ? "running" : "paused" }}
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
                onClick={onToggleClockAdjust}
              >
                <p className="text-[clamp(2.55rem,14vw,3.5rem)] leading-none font-semibold tabular-nums text-slate-950">
                  {gameClockText}
                </p>
              </button>
            </div>

            <button
              type="button"
              aria-label={stateIsRunning ? "Pause game" : "Start game"}
              className="absolute inset-x-2 top-[53%] bottom-2 flex items-center justify-center rounded-b-full rounded-t-[42%] transition disabled:opacity-35"
              onClick={onToggleRunning}
              disabled={!controller || stateIsFinished || stateIsSuspended}
            >
              <span className="relative h-20 w-20">
                <PauseFilledGlyph
                  className={`absolute inset-0 h-20 w-20 fill-slate-900 transition-all duration-200 ${
                    stateIsRunning
                      ? "scale-100 rotate-0 opacity-100"
                      : "scale-70 -rotate-10 opacity-0"
                  }`}
                />
                <PlayFilledGlyph
                  className={`absolute inset-0 h-20 w-20 fill-slate-900 transition-all duration-200 ${
                    stateIsRunning
                      ? "scale-70 rotate-10 opacity-0"
                      : "scale-100 rotate-0 opacity-100"
                  }`}
                />
              </span>
            </button>
          </div>

          {flagStatus !== null ? <ClockAttachment status={flagStatus} /> : null}

          {seekersStatus !== null ? <ClockAttachment status={seekersStatus} /> : null}
        </div>

        <TeamScoreColumn
          column={rightScoreColumn}
          scorePulse={scorePulse}
          editor={teamNameEditor}
          side="right"
          onAddScore={onAddScore}
          onUndoScore={onUndoScore}
          scoreUpDisabled={!controller || stateIsFinished}
          scoreDownDisabled={!controller}
        />
      </div>

      {finishSummary !== null ? (
        <p className="mt-1 text-center text-[10px] font-medium text-slate-600">{finishSummary}</p>
      ) : null}
      {controller ? (
        clockAdjustOpen ? (
          <div
            className="mt-2 grid grid-cols-6 gap-1 text-[11px] animate-in fade-in-0 slide-in-from-bottom-2"
            data-clock-adjust-keep="true"
          >
            {[
              { label: "-1m", delta: -60_000 },
              { label: "-10s", delta: -10_000 },
              { label: "-1s", delta: -1_000 },
              { label: "+1s", delta: 1_000 },
              { label: "+10s", delta: 10_000 },
              { label: "+1m", delta: 60_000 },
            ].map((adjustment) => (
              <Button
                key={adjustment.label}
                size="sm"
                variant="outline"
                className="h-7 border-slate-300 bg-white text-slate-800"
                onClick={() => onAdjustGameClock(adjustment.delta)}
              >
                {adjustment.label}
              </Button>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-center text-[11px] font-medium text-slate-600">
            Tap game time or team names to adjust.
          </p>
        )
      ) : null}

      {timeoutReminder !== null ? (
        <p
          className={`mt-2 rounded-xl border px-2 py-1 text-[10px] font-medium ${
            timeoutReminder.warningActive
              ? "border-red-300 bg-red-100 text-red-900"
              : "border-sky-300 bg-sky-100 text-sky-900"
          }`}
        >
          {timeoutReminder.text}
        </p>
      ) : null}
    </section>
  );
}

function TeamScoreColumn({
  column,
  scorePulse,
  editor,
  side,
  onAddScore,
  onUndoScore,
  scoreUpDisabled,
  scoreDownDisabled,
}: {
  column: ScoreColumnView;
  scorePulse: ScorePulseState;
  editor: TeamNameEditorState;
  side: "left" | "right";
  onAddScore: (team: TeamId) => void;
  onUndoScore: (team: TeamId) => void;
  scoreUpDisabled: boolean;
  scoreDownDisabled: boolean;
}) {
  const isRenamingThis = editor.controller && editor.renamingTeam === column.team;
  const draftValue = column.team === "home" ? editor.homeName : editor.awayName;
  const nameButtonRef =
    side === "left" ? editor.leftTeamNameButtonRef : editor.rightTeamNameButtonRef;

  return (
    <div className="flex min-w-0 flex-col items-center gap-1">
      {isRenamingThis ? (
        <div className="grid w-full gap-1">
          <Input
            ref={editor.activeTeamRenameInputRef}
            value={draftValue}
            onChange={(event) => editor.onRenameInputChange(column.team, event.target.value)}
            onKeyDown={editor.onRenameInputKeyDown}
            className="h-7 border-slate-300 bg-white text-[10px] text-slate-900"
            maxLength={40}
          />
          <div className="grid grid-cols-[minmax(0,1fr)_2rem] gap-1">
            <Button
              size="sm"
              className="h-6 min-w-0 px-1 text-[10px]"
              onClick={editor.onSaveRename}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 w-8 min-w-0 border-slate-300 bg-white px-0 text-slate-800"
              onClick={editor.onSwapDisplayedTeamSides}
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
          ref={nameButtonRef}
          style={
            editor.displayTeamNameHeightPx === null
              ? undefined
              : { height: `${editor.displayTeamNameHeightPx}px` }
          }
          className="w-[calc(100%+0.75rem)] min-h-[2.6rem] max-w-none overflow-hidden whitespace-normal px-1 pt-0.5 pb-0 text-center text-[clamp(1.05rem,3.8vw,1.35rem)] leading-[1.03] font-extrabold tracking-tight text-slate-900 [display:-webkit-box] [overflow-wrap:normal] [word-break:keep-all] [-webkit-box-orient:vertical] [-webkit-line-clamp:3] transition-opacity hover:opacity-70"
          onClick={() => editor.onOpenRename(column.team)}
        >
          {column.name}
        </button>
      )}

      <Button
        size="sm"
        className={column.scoreBoxClassName}
        onClick={() => onAddScore(column.team)}
        disabled={scoreUpDisabled}
      >
        <ChevronUp className="h-4 w-4" />
      </Button>
      <div
        className={`w-full rounded-2xl border bg-white px-2 py-2 text-center ${column.scoreValueBorderClassName} ${column.scoreValueGlowClassName}`}
      >
        <p
          className={`text-[clamp(1.75rem,9.4vw,2.45rem)] leading-none font-semibold tabular-nums transition-all duration-300 ${
            scorePulse[column.team] === 1
              ? "score-pop-up text-emerald-700"
              : scorePulse[column.team] === -1
                ? "score-pop-down text-rose-700"
                : "text-slate-900"
          }`}
        >
          {column.score}
        </p>
      </div>
      <Button
        size="sm"
        variant="outline"
        className={column.scoreDownButtonClassName}
        onClick={() => onUndoScore(column.team)}
        disabled={scoreDownDisabled}
      >
        <ChevronDown className="h-4 w-4" />
      </Button>
    </div>
  );
}

function ClockAttachment({ status }: { status: NonNullable<ClockAttachmentView> }) {
  return (
    <div
      className={`pointer-events-none absolute w-[94px] rounded-2xl border px-2 py-1 text-center shadow-[0_6px_14px_rgba(15,23,42,0.18)] ${status.positionClassName} ${status.className}`}
    >
      <p className="text-[9px] font-semibold tracking-[0.14em] uppercase">{status.label}</p>
      <p className="text-xs font-semibold tabular-nums">{status.value}</p>
    </div>
  );
}

export function PenaltyColumnsSection({
  penaltyColumns,
  displayTeamName,
  pendingReleaseByPlayer,
  controller,
  onConfirmPenaltyExpiration,
  getPendingReleaseActionLabel,
}: {
  penaltyColumns: PenaltyColumnView[];
  displayTeamName: (team: TeamId) => string;
  pendingReleaseByPlayer: Record<string, PendingReleaseActionView[]>;
  controller: boolean;
  onConfirmPenaltyExpiration: (pendingId: string, playerKey: string) => void;
  getPendingReleaseActionLabel: (action: PendingReleaseActionView, playerKey: string) => string;
}) {
  return (
    <section className="grid min-h-0 grid-cols-2 gap-2">
      {penaltyColumns.map((column) => (
        <Card
          key={column.team}
          className={`relative h-full min-h-0 overflow-hidden rounded-2xl ${column.panelBorderClassName} bg-white py-1 shadow-[0_8px_20px_rgba(15,23,42,0.1)]`}
        >
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute inset-0 ${column.panelTintClassName}`}
          />
          <CardContent className="relative z-10 flex h-full min-h-0 flex-col gap-1 overflow-hidden px-2">
            <p
              className={`truncate text-[10px] font-semibold tracking-[0.14em] uppercase ${column.headerTextClassName}`}
            >
              {displayTeamName(column.team)} penalties
            </p>
            <div className="grid min-h-0 gap-1 overflow-hidden">
              {column.visiblePenalties.length === 0 ? (
                <p className="text-[10px] text-slate-500">No penalties</p>
              ) : (
                column.visiblePenalties.map((entry) => {
                  const releaseActions = pendingReleaseByPlayer[entry.playerKey] ?? [];

                  return (
                    <div
                      key={entry.playerKey}
                      className={`rounded-xl border px-2 py-1 text-[10px] ${
                        releaseActions.length > 0
                          ? "animate-pulse border-red-300 bg-red-100 text-red-900"
                          : entry.highlight
                            ? "border-amber-300 bg-amber-100 text-amber-900"
                            : column.neutralChipClassName
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
                                onConfirmPenaltyExpiration(action.pendingId, entry.playerKey)
                              }
                              disabled={!controller}
                            >
                              {getPendingReleaseActionLabel(action, entry.playerKey)}
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
                  <span>{release.label} released</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}

function PlayFilledGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M8.2 5.7c0-1.3 1.4-2.1 2.5-1.4l9.3 6.3c1 .7 1 2.1 0 2.8l-9.3 6.3c-1.1.7-2.5-.1-2.5-1.4V5.7z" />
    </svg>
  );
}

function PauseFilledGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M7 5.5C7 4.7 7.7 4 8.5 4h1C10.3 4 11 4.7 11 5.5v13c0 .8-.7 1.5-1.5 1.5h-1c-.8 0-1.5-.7-1.5-1.5v-13zM13 5.5c0-.8.7-1.5 1.5-1.5h1c.8 0 1.5.7 1.5 1.5v13c0 .8-.7 1.5-1.5 1.5h-1c-.8 0-1.5-.7-1.5-1.5v-13z" />
    </svg>
  );
}
