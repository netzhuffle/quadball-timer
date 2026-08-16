import type { ReactNode } from "react";
import type { RefObject } from "react";
import { LogOut, QrCode, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ControllerHeaderIdentity = {
  eyebrow: string;
  title: string;
};

type ControllerHeaderWarningBase = {
  queuedActions: number;
  retryDetail?: string;
};

export type ControllerHeaderWarning =
  | (ControllerHeaderWarningBase & { kind: "offline" })
  | (ControllerHeaderWarningBase & { kind: "stale" });

export type ControllerHeaderQr = {
  onClick: () => void;
  expanded: boolean;
  controls: string;
  label: string;
  disabled?: boolean;
  triggerRef?: RefObject<HTMLButtonElement | null>;
};

export function ControllerHeader({
  identity,
  warning,
  qr,
  onLeave,
  leaveTriggerRef,
  leaveLabel = "Leave",
  leaveDisabled = false,
  children,
}: {
  identity: ControllerHeaderIdentity;
  warning: ControllerHeaderWarning | null;
  qr?: ControllerHeaderQr;
  onLeave?: () => void;
  leaveTriggerRef?: RefObject<HTMLButtonElement | null>;
  leaveLabel?: string;
  leaveDisabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <section
      aria-label="Controller header"
      className={cn(
        "rounded-2xl border bg-white px-3 py-2 shadow-[0_8px_18px_rgba(15,23,42,0.08)]",
        warning === null ? "border-slate-300" : "border-amber-300",
      )}
    >
      <div className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {qr === undefined ? null : (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-11 shrink-0 rounded-xl border-slate-300 bg-white text-slate-800 hover:bg-slate-100"
              ref={qr.triggerRef}
              aria-label={qr.label}
              aria-expanded={qr.expanded}
              aria-controls={qr.controls}
              onClick={qr.onClick}
              disabled={qr.disabled}
            >
              <QrCode className="size-4" aria-hidden="true" />
            </Button>
          )}
          <div className="min-w-0">
            <p className="truncate text-[10px] font-semibold tracking-[0.15em] text-slate-500 uppercase">
              {identity.eyebrow}
            </p>
            <p className="truncate text-xs font-bold text-slate-950">{identity.title}</p>
          </div>
        </div>
        {onLeave === undefined ? null : (
          <Button
            type="button"
            ref={leaveTriggerRef}
            variant="ghost"
            size="sm"
            className="h-11 shrink-0 px-2 text-[11px] font-semibold text-rose-700 hover:bg-rose-50 hover:text-rose-800"
            aria-label={leaveLabel}
            onClick={onLeave}
            disabled={leaveDisabled}
          >
            <LogOut className="size-3.5" aria-hidden="true" />
            Leave
            <span className="sr-only"> Controller Session</span>
          </Button>
        )}
      </div>
      {warning === null ? null : (
        <div
          role="status"
          aria-live="polite"
          data-controller-warning="true"
          className="mt-2 flex items-start gap-1.5 rounded-xl border border-amber-300 bg-amber-50 px-2 py-1.5 text-[10px] text-amber-950"
        >
          <WifiOff className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          <span>
            {warning.kind === "stale" ? "Connection stale" : "Offline"}
            {warning.queuedActions > 0
              ? ` · ${warning.queuedActions} queued action${warning.queuedActions === 1 ? "" : "s"}`
              : ""}
            .{warning.retryDetail === undefined ? null : ` ${warning.retryDetail}`}
          </span>
        </div>
      )}
      {children}
    </section>
  );
}
