import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ControllerProjection } from "@/lib/live-event-game-control";
import {
  retainControllerGoalIntent,
  type PendingControllerGoalIntent,
} from "@/lib/controller-intent-retry";
import { readControllerDeviceContext } from "@/lib/controller-device-context";

type OpenResponse = {
  status: "opened";
  eventGameId: string;
  session: { sessionBearer: string };
  projection: ControllerProjection | null;
  projectionStatus: "available" | "unavailable";
};

type ActionResponse = {
  status: "accepted" | "duplicate-accepted";
  acknowledgement: { status: "acknowledged"; operationId: string };
  projection: ControllerProjection | null;
  projectionStatus: "available" | "unavailable";
};

export function EventGameControllerPage() {
  const [qrCredential, setQrCredential] = useState("");
  const [sessionBearer, setSessionBearer] = useState<string | null>(null);
  const [eventGameId, setEventGameId] = useState<string | null>(null);
  const [projection, setProjection] = useState<ControllerProjection | null>(null);
  const [projectionStatus, setProjectionStatus] = useState<"available" | "unavailable">(
    "unavailable",
  );
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingIntent, setPendingIntent] = useState<PendingControllerGoalIntent | null>(null);
  const [browserContext] = useState(() => readControllerDeviceContext());

  async function openController() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/event-control/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ qrCredential, browserContext }),
      });
      if (!response.ok) throw new Error("Unable to open Controller experience.");
      const result = (await response.json()) as OpenResponse;
      setSessionBearer(result.session.sessionBearer);
      setEventGameId(result.eventGameId);
      setProjection(result.projection);
      setProjectionStatus(result.projectionStatus);
    } catch {
      setSessionBearer(null);
      setEventGameId(null);
      setProjection(null);
      setProjectionStatus("unavailable");
      setMessage("Unable to open Controller experience.");
    } finally {
      setBusy(false);
    }
  }

  async function recordGoal(gameSideId: string) {
    if (sessionBearer === null || eventGameId === null) return;
    setBusy(true);
    setMessage(null);
    const intent: PendingControllerGoalIntent = retainControllerGoalIntent(
      pendingIntent,
      gameSideId,
    );
    setPendingIntent(intent);
    try {
      const response = await fetch("/api/event-control/intent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionBearer,
          eventGameId,
          intent,
        }),
      });
      const result = (await response.json()) as ActionResponse | { error?: string };
      if (!response.ok || !("acknowledgement" in result)) {
        setMessage("The tap was not acknowledged. Retry the same pending tap.");
        return;
      }
      setPendingIntent(null);
      setProjection(result.projection);
      setProjectionStatus(result.projectionStatus);
      setMessage("Goal acknowledged by the durable Event Game record.");
    } catch {
      setMessage("The tap may still be pending. Retry the same pending tap.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-xl p-4 pb-12 sm:p-6">
      <Card>
        <CardHeader>
          <CardTitle>Event Game Controller</CardTitle>
          <CardDescription>Open this Controller Device with a valid Control Grant.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="control-grant">Control Grant credential</Label>
            <Input
              id="control-grant"
              value={qrCredential}
              onChange={(event) => setQrCredential(event.target.value)}
              autoComplete="off"
              placeholder="Scan or paste the QR credential"
              disabled={sessionBearer !== null || busy}
            />
          </div>
          {sessionBearer === null ? (
            <Button className="w-full" onClick={() => void openController()} disabled={busy}>
              Open Controller Device
            </Button>
          ) : (
            <>
              <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                <p className="font-medium">Controller Device is active.</p>
                {projectionStatus === "unavailable" ? (
                  <p className="mt-1 text-muted-foreground">
                    The durable action is available, but its projection is temporarily unavailable.
                  </p>
                ) : null}
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
                        <Button onClick={() => void recordGoal(gameSideId)} disabled={busy}>
                          Record 10-point goal
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          {message === null ? null : <p className="text-sm text-muted-foreground">{message}</p>}
        </CardContent>
      </Card>
    </main>
  );
}
