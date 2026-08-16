import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import {
  getBrowserControllerDeparture,
  type ControllerDepartureDestination,
  type ControllerDepartureOutcome,
  type ControllerDepartureReference,
} from "@/lib/controller-departure";

export function ControllerDepartureReturnCard() {
  const departureModule = getBrowserControllerDeparture();
  const [projection, setProjection] = useState(() => departureModule.project());
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => setProjection(departureModule.project());
    const interval = window.setInterval(refresh, 1_000);
    const unsubscribe = departureModule.subscribe(refresh);
    return () => {
      window.clearInterval(interval);
      unsubscribe();
    };
  }, [departureModule]);

  if (projection.status !== "returnable") return null;
  const departure = projection.departure;
  return (
    <section
      aria-labelledby="controller-return-title"
      className="rounded-2xl border-2 border-amber-400 bg-amber-50 p-5 shadow-sm"
    >
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-800">
        Controller return
      </p>
      <h2 id="controller-return-title" className="mt-1 text-xl font-semibold text-amber-950">
        Return to {departure.identity.title}
      </h2>
      <p className="mt-1 text-sm text-amber-900">
        {departure.identity.homeName} vs {departure.identity.awayName}
      </p>
      {departure.identity.detail === undefined ? null : (
        <p className="mt-1 text-xs text-amber-800">{departure.identity.detail}</p>
      )}
      {message === null ? null : (
        <p className="mt-3 text-sm font-medium text-rose-800" role="alert">
          {message}
        </p>
      )}
      <Button
        className="mt-4 min-h-11 w-full sm:w-auto"
        onClick={() => {
          setMessage(null);
          void departureModule
            .transition({
              type: "return",
              gameId: departure.gameId,
              online: navigator.onLine !== false,
            })
            .then((outcome) => {
              if (outcome.status === "resumed") navigateTo(departure.navigationPath);
              else {
                setProjection(departureModule.project());
                setMessage("This Controller return is no longer available.");
              }
            });
        }}
      >
        Return to game
      </Button>
    </section>
  );
}

export function useControllerDepartureEntry({
  destination,
  triggerRef,
  onCommitted,
  onUnavailable,
  onCancelled,
}: {
  destination: ControllerDepartureDestination;
  triggerRef: RefObject<HTMLElement | null>;
  onCommitted: () => boolean | void | Promise<boolean | void>;
  onUnavailable: () => void;
  onCancelled?: () => void;
}): { begin(): Promise<void>; dialog: ReactNode; busy: boolean } {
  const departureModule = getBrowserControllerDeparture();
  const destinationRef = useRef(destination);
  const onCommittedRef = useRef(onCommitted);
  const onUnavailableRef = useRef(onUnavailable);
  const onCancelledRef = useRef(onCancelled);
  destinationRef.current = destination;
  onCommittedRef.current = onCommitted;
  onUnavailableRef.current = onUnavailable;
  onCancelledRef.current = onCancelled;
  const [prompt, setPrompt] = useState<
    Extract<ControllerDepartureOutcome, { status: "needs-confirmation" }> | undefined
  >();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const resolve = useCallback(
    async (initial: ControllerDepartureOutcome) => {
      let outcome = initial;
      while (outcome.status === "authorized") {
        outcome = await departureModule.transition({
          type: "commit-entry",
          authorization: outcome.authorization,
        });
      }
      if (!mountedRef.current) return;
      if (outcome.status === "needs-confirmation") {
        setPrompt(outcome);
        busyRef.current = false;
        setBusy(false);
        return;
      }
      if (outcome.status === "committed") {
        setPrompt(undefined);
        let succeeded = false;
        try {
          succeeded = (await onCommittedRef.current()) !== false;
        } catch {
          succeeded = false;
        }
        const completed =
          outcome.completion === undefined
            ? { status: "unavailable" as const }
            : await departureModule.transition({
                type: "complete-entry",
                completion: outcome.completion,
                succeeded,
              });
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
        if (succeeded && completed.status !== "committed") onUnavailableRef.current();
        return;
      }
      setPrompt(undefined);
      busyRef.current = false;
      setBusy(false);
      onUnavailableRef.current();
    },
    [departureModule],
  );

  const begin = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const outcome = await departureModule.transition({
      type: "request-entry",
      destination: destinationRef.current,
      online: navigator.onLine !== false,
    });
    await resolve(outcome);
  }, [departureModule, resolve]);

  const dialog =
    prompt === undefined ? null : (
      <ControllerReplacementDialog
        departure={prompt.departure}
        triggerRef={triggerRef}
        busy={busy}
        onCancel={() => {
          const request = prompt.request;
          setPrompt(undefined);
          busyRef.current = false;
          setBusy(false);
          void departureModule.transition({ type: "cancel-entry", request });
          onCancelledRef.current?.();
        }}
        onConfirm={() => {
          if (busyRef.current) return;
          busyRef.current = true;
          setBusy(true);
          void departureModule
            .transition({
              type: "confirm-entry",
              request: prompt.request,
              online: navigator.onLine !== false,
            })
            .then(resolve);
        }}
      />
    );

  return { begin, dialog, busy };
}

function ControllerDepartureDialog({
  title,
  description,
  safeLabel,
  confirmLabel,
  titleId,
  descriptionId,
  triggerRef,
  onCancel,
  onConfirm,
  busy,
}: {
  title: string;
  description: string;
  safeLabel: string;
  confirmLabel: string;
  titleId: string;
  descriptionId: string;
  triggerRef: RefObject<HTMLElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  const safeButtonRef = useRef<HTMLButtonElement | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocus = () => window.setTimeout(() => triggerRef.current?.focus(), 0);
  const dismiss = () => {
    if (busy) return;
    onCancel();
    restoreFocus();
  };
  useEffect(() => {
    safeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [safeButtonRef.current, confirmButtonRef.current].filter(
        (element): element is HTMLButtonElement => element !== null && !element.disabled,
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-950/45 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="text-lg font-semibold text-slate-950">
          {title}
        </h2>
        <p id={descriptionId} className="mt-2 text-sm text-slate-700">
          {description}
        </p>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button ref={safeButtonRef} variant="outline" onClick={dismiss} disabled={busy}>
            {safeLabel}
          </Button>
          <Button
            ref={confirmButtonRef}
            onClick={() => {
              restoreFocus();
              onConfirm();
            }}
            disabled={busy}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ControllerLeaveDialog({
  triggerRef,
  onCancel,
  onConfirm,
  busy = false,
}: {
  triggerRef: RefObject<HTMLElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
  busy?: boolean;
}) {
  return (
    <ControllerDepartureDialog
      title="Leave this game?"
      description="You can return from Home for five minutes. After that, this browser will lose control access."
      safeLabel="Stay in game"
      confirmLabel="Leave game"
      titleId="controller-leave-title"
      descriptionId="controller-leave-description"
      triggerRef={triggerRef}
      onCancel={onCancel}
      onConfirm={onConfirm}
      busy={busy}
    />
  );
}

function ControllerReplacementDialog({
  departure,
  triggerRef,
  onCancel,
  onConfirm,
  busy = false,
}: {
  departure: ControllerDepartureReference;
  triggerRef: RefObject<HTMLElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
  busy?: boolean;
}) {
  return (
    <ControllerDepartureDialog
      title="Leave the previous game?"
      description={`Returning to ${departure.identity.homeName} vs ${departure.identity.awayName} will no longer be available after you start or join another game.`}
      safeLabel="Cancel"
      confirmLabel="Continue"
      titleId="controller-replacement-title"
      descriptionId="controller-replacement-description"
      triggerRef={triggerRef}
      onCancel={onCancel}
      onConfirm={onConfirm}
      busy={busy}
    />
  );
}

export function controllerDepartureReference(input: {
  workflow: ControllerDepartureReference["workflow"];
  gameId: string;
  sessionReferenceId?: string;
  homeName: string;
  awayName: string;
  navigationPath?: string;
  detail?: string;
}): ControllerDepartureReference {
  return {
    workflow: input.workflow,
    gameId: input.gameId,
    ...(input.sessionReferenceId === undefined
      ? {}
      : { sessionReferenceId: input.sessionReferenceId }),
    navigationPath: input.navigationPath ?? `/game/${input.gameId}`,
    identity: {
      title: input.workflow === "ad-hoc" ? "Ad Hoc Game" : "Event Game",
      homeName: input.homeName,
      awayName: input.awayName,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    },
  };
}

function navigateTo(path: string) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
