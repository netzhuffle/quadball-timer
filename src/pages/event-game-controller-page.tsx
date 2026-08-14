import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  ControllerProjection,
  LiveEventControllerIntent,
} from "@/lib/live-event-game-control";
import {
  LIVE_EVENT_CONTROL_INTENT_VERSION,
  parseLiveEventControllerIntent,
} from "@/lib/live-event-game-control";
import { readControllerDeviceContext } from "@/lib/controller-device-context";
import {
  retainControllerIntent,
  type PendingControllerIntent,
} from "@/lib/controller-intent-retry";

type PersistedControllerSession = { sessionBearer: string; eventGameId: string };
type ControllerOpenResponse = {
  status: "opened";
  eventGameId: string;
  session: { sessionBearer: string };
  projection: ControllerProjection | null;
  projectionStatus: "available" | "unavailable";
};
type ControllerRefreshResponse =
  | {
      status: "authorized";
      session: { eventGameId: string };
      projection: ControllerProjection | null;
      projectionStatus: "available" | "unavailable";
    }
  | { status: "switch-required"; previousEventGameId: string; currentEventGameId: string }
  | { status: "rejected"; message: string };

export function EventGameControllerPage() {
  const persisted = readPersistedControllerSession();
  const [qrCredential, setQrCredential] = useState("");
  const [sessionBearer, setSessionBearer] = useState<string | null>(
    persisted?.sessionBearer ?? null,
  );
  const [eventGameId, setEventGameId] = useState<string | null>(persisted?.eventGameId ?? null);
  const [projection, setProjection] = useState<ControllerProjection | null>(null);
  const [projectionStatus, setProjectionStatus] = useState<"available" | "unavailable">(
    "unavailable",
  );
  const [revealedQr, setRevealedQr] = useState<string | null>(null);
  const [switchTarget, setSwitchTarget] = useState<string | null>(null);
  const [stayedOnAssignment, setStayedOnAssignment] = useState<string | null>(null);
  const [clockRunning, setClockRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingIntent, setPendingIntent] = useState<PendingControllerIntent | null>(() =>
    readPersistedPendingIntent(),
  );
  const [browserContext] = useState(() => readControllerDeviceContext());

  useEffect(() => {
    if (sessionBearer === null || eventGameId === null) {
      sessionStorage.removeItem("quadball:event-controller-session");
      return;
    }
    sessionStorage.setItem(
      "quadball:event-controller-session",
      JSON.stringify({ sessionBearer, eventGameId } satisfies PersistedControllerSession),
    );
  }, [eventGameId, sessionBearer]);

  useEffect(() => {
    if (pendingIntent === null) {
      sessionStorage.removeItem("quadball:event-controller-pending-intent");
      return;
    }
    sessionStorage.setItem(
      "quadball:event-controller-pending-intent",
      JSON.stringify(pendingIntent),
    );
  }, [pendingIntent]);

  useEffect(() => {
    if (persisted !== null) void refreshController(true);
    // Persisted authority is deliberately revalidated after browser restore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openController() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await postJson<ControllerOpenResponse>("/api/event-control/open", {
        qrCredential,
        browserContext,
      });
      if (response.status !== "opened") throw new Error("open failed");
      setSessionBearer(response.session.sessionBearer);
      setEventGameId(response.eventGameId);
      setProjection(response.projection);
      setProjectionStatus(response.projectionStatus);
    } catch {
      clearSession();
      setMessage("Unable to open Controller experience.");
    } finally {
      setBusy(false);
    }
  }

  async function refreshController(silent = false) {
    if (sessionBearer === null || eventGameId === null) return;
    if (!silent) setBusy(true);
    try {
      const response = await postJson<ControllerRefreshResponse>("/api/event-control/refresh", {
        sessionBearer,
        eventGameId,
      });
      if (response.status === "switch-required") {
        setSwitchTarget(
          stayedOnAssignment === response.currentEventGameId ? null : response.currentEventGameId,
        );
        return;
      }
      if (response.status === "rejected") throw new Error("refresh failed");
      setSwitchTarget(null);
      setEventGameId(response.session.eventGameId);
      setProjection(response.projection);
      setProjectionStatus(response.projectionStatus);
    } catch {
      if (!silent) setMessage("Unable to refresh Controller session.");
    } finally {
      if (!silent) setBusy(false);
    }
  }

  async function switchController() {
    if (sessionBearer === null) return;
    setBusy(true);
    try {
      const response = await postJson<ControllerRefreshResponse>("/api/event-control/switch", {
        sessionBearer,
      });
      if (response.status !== "authorized") throw new Error("switch failed");
      setEventGameId(response.session.eventGameId);
      setProjection(response.projection);
      setProjectionStatus(response.projectionStatus);
      setSwitchTarget(null);
      setStayedOnAssignment(null);
      setMessage("Controller Device switched to the newly assigned Event Game.");
    } catch {
      setMessage("Unable to switch Controller Device.");
    } finally {
      setBusy(false);
    }
  }

  async function stayOnCurrentAssignment() {
    if (sessionBearer === null || eventGameId === null || switchTarget === null) return;
    setBusy(true);
    try {
      const response = await postJson<ControllerRefreshResponse>("/api/event-control/stay", {
        sessionBearer,
        eventGameId,
      });
      if (response.status !== "authorized") throw new Error("stay failed");
      setStayedOnAssignment(switchTarget);
      setSwitchTarget(null);
      setEventGameId(response.session.eventGameId);
      setProjection(response.projection);
      setProjectionStatus(response.projectionStatus);
      setMessage("Staying on the current Event Game until the assignment changes again.");
    } catch {
      setMessage("Unable to retain the current Event Game assignment.");
    } finally {
      setBusy(false);
    }
  }

  async function revealQr() {
    if (sessionBearer === null || eventGameId === null) return;
    setBusy(true);
    try {
      const response = await postJson<{ status: "revealed"; qrCredential: string }>(
        "/api/event-control/reveal-qr",
        { sessionBearer, eventGameId },
      );
      if (response.status !== "revealed") throw new Error("reveal failed");
      setRevealedQr(response.qrCredential);
    } catch {
      setMessage("The active Control Grant QR is no longer revealable.");
    } finally {
      setBusy(false);
    }
  }

  async function leaveController() {
    if (sessionBearer === null) return;
    setBusy(true);
    try {
      const response = await postJson<{ status: "left" }>("/api/event-control/leave", {
        sessionBearer,
      });
      if (response.status !== "left") throw new Error("leave failed");
      clearSession();
      setMessage("Controller Session left. Pending evidence remains on the Event Game Record.");
    } catch {
      setMessage("Unable to leave Controller session.");
    } finally {
      setBusy(false);
    }
  }

  async function submitIntent(intent: LiveEventControllerIntent) {
    if (sessionBearer === null || eventGameId === null) return;
    setBusy(true);
    try {
      const response = await postJson<
        | { status: "accepted" | "duplicate-accepted"; projection: ControllerProjection | null }
        | { status: "rejected" | "retryable" }
      >("/api/event-control/intent", { sessionBearer, eventGameId, intent });
      if (response.status !== "accepted" && response.status !== "duplicate-accepted") {
        if (response.status === "rejected") setPendingIntent(null);
        setMessage("The Controller action was not committed; retry is safe.");
        return;
      }
      setPendingIntent(null);
      setProjection(response.projection);
      setProjectionStatus(response.projection === null ? "unavailable" : "available");
      if (intent.type === "clock" || intent.type === "set-running") setClockRunning(intent.running);
    } catch {
      setMessage("The Controller action may still be pending. Retry the same action.");
    } finally {
      setBusy(false);
    }
  }

  function recordGoal(gameSideId: string) {
    queueIntent({
      version: LIVE_EVENT_CONTROL_INTENT_VERSION,
      type: "record-goal",
      operationId: crypto.randomUUID(),
      factId: crypto.randomUUID(),
      gameSideId,
      gameTimeMs: 0,
      occurrence: { clientOriginAtMs: Date.now() },
    });
  }

  function trigger(type: "card" | "timeout" | "suspension" | "result") {
    queueIntent({
      version: LIVE_EVENT_CONTROL_INTENT_VERSION,
      type: "substantive",
      trigger: type,
      operationId: crypto.randomUUID(),
      factId: crypto.randomUUID(),
      gameTimeMs: 0,
      occurrence: { clientOriginAtMs: Date.now() },
    });
  }

  function toggleClock() {
    queueIntent({
      version: LIVE_EVENT_CONTROL_INTENT_VERSION,
      type: "clock",
      running: !clockRunning,
      operationId: crypto.randomUUID(),
      factId: crypto.randomUUID(),
      gameTimeMs: 0,
      occurrence: { clientOriginAtMs: Date.now() },
    });
  }

  function queueIntent(candidate: LiveEventControllerIntent) {
    const intent = retainControllerIntent(pendingIntent, candidate);
    setPendingIntent(intent);
    void submitIntent(intent);
  }

  function clearSession() {
    setSessionBearer(null);
    setEventGameId(null);
    setProjection(null);
    setProjectionStatus("unavailable");
    setRevealedQr(null);
    setSwitchTarget(null);
    setStayedOnAssignment(null);
  }

  return (
    <main className="mx-auto w-full max-w-xl p-4 pb-12 sm:p-6">
      <Card>
        <CardHeader>
          <CardTitle>Event Game Controller</CardTitle>
          <CardDescription>
            A Grant Session survives refresh and connectivity loss until you explicitly leave.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {sessionBearer === null ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="control-grant">Active Pitch Slot Control Grant QR</Label>
                <Input
                  id="control-grant"
                  value={qrCredential}
                  onChange={(event) => setQrCredential(event.target.value)}
                  autoComplete="off"
                  placeholder="Scan or paste the QR credential"
                  disabled={busy}
                />
              </div>
              <Button className="w-full" onClick={() => void openController()} disabled={busy}>
                Open Controller Device
              </Button>
            </>
          ) : (
            <>
              <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                <p className="font-medium">Controller Device: {eventGameId}</p>
                <p className="mt-1 text-muted-foreground">
                  {projection?.commencement.status === "commenced"
                    ? "Game Commencement is irreversible."
                    : "Game remains provisional until genuine play is recognized."}
                </p>
                {projectionStatus === "unavailable" ? (
                  <p className="mt-1 text-muted-foreground">Projection temporarily unavailable.</p>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => void revealQr()} disabled={busy}>
                  Reveal active Grant QR
                </Button>
                <Button variant="outline" onClick={() => void refreshController()} disabled={busy}>
                  Refresh assignment
                </Button>
                <Button variant="outline" onClick={() => void leaveController()} disabled={busy}>
                  Leave Controller Session
                </Button>
              </div>
              {switchTarget === null ? null : (
                <div className="rounded-lg border border-amber-500/50 bg-amber-50 p-3 text-sm">
                  <p className="font-medium">Pitch Slot assignment changed.</p>
                  <p className="mt-1">
                    Switch to {switchTarget}, or stay on {eventGameId}.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Button onClick={() => void switchController()} disabled={busy}>
                      Switch Event Game
                    </Button>
                    <Button variant="outline" onClick={stayOnCurrentAssignment} disabled={busy}>
                      Stay here
                    </Button>
                  </div>
                </div>
              )}
              {revealedQr === null ? null : (
                <div className="rounded-lg border p-3 text-sm">
                  <p className="font-medium">Share this active Pitch Slot QR</p>
                  <code className="mt-2 block break-all text-xs">{revealedQr}</code>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button onClick={toggleClock} disabled={busy}>
                  {clockRunning ? "Pause clock" : "Start clock"}
                </Button>
                <Button variant="outline" onClick={() => trigger("card")} disabled={busy}>
                  Record card
                </Button>
                <Button variant="outline" onClick={() => trigger("timeout")} disabled={busy}>
                  Start timeout
                </Button>
                <Button variant="outline" onClick={() => trigger("suspension")} disabled={busy}>
                  Suspend game
                </Button>
                <Button variant="outline" onClick={() => trigger("result")} disabled={busy}>
                  Record result
                </Button>
              </div>
              {projection === null ? null : (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Phase: {projection.phase} · Goals: {projection.goalCount}
                  </p>
                  {Object.entries(projection.scoreByGameSide).map(([gameSideId, score]) => (
                    <div key={gameSideId} className="flex items-center justify-between gap-3">
                      <span className="font-medium">Game Side {gameSideId}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-2xl font-semibold tabular-nums">{score}</span>
                        <Button onClick={() => recordGoal(gameSideId)} disabled={busy}>
                          Record 10-point goal
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {pendingIntent === null ? null : (
                <p className="text-sm text-amber-700">
                  An uncertain Controller action is retained for safe retry.
                </p>
              )}
            </>
          )}
          {message === null ? null : <p className="text-sm text-muted-foreground">{message}</p>}
        </CardContent>
      </Card>
    </main>
  );
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as T;
  if (!response.ok) throw new Error("request failed");
  return result;
}

function readPersistedControllerSession(): PersistedControllerSession | null {
  try {
    const raw = sessionStorage.getItem("quadball:event-controller-session");
    if (raw === null) return null;
    const value = JSON.parse(raw) as Partial<PersistedControllerSession>;
    return typeof value.sessionBearer === "string" && typeof value.eventGameId === "string"
      ? { sessionBearer: value.sessionBearer, eventGameId: value.eventGameId }
      : null;
  } catch {
    return null;
  }
}

function readPersistedPendingIntent(): PendingControllerIntent | null {
  try {
    const raw = sessionStorage.getItem("quadball:event-controller-pending-intent");
    if (raw === null) return null;
    const parsed = parseLiveEventControllerIntent(JSON.parse(raw));
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}
