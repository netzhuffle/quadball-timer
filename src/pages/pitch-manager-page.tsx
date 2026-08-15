import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Scope = {
  eventId: string;
  gameDayId: string;
  gameDayDate: string;
  eventTimeZone: string;
  pitchId: string;
};

type View = {
  eventId: string;
  gameDayId: string;
  gameDayDate: string;
  eventTimeZone: string;
  pitch: { pitchId: string; name: string };
  schedule: Array<{
    pitchSlotId: string;
    gameplaySlotId: string;
    sequence: number;
    expectedStart: string;
    eventGame: {
      eventGameId: string;
      gameCode: string | null;
      gameDesignation: string | null;
      sideA: { displayName: string };
      sideB: { displayName: string };
    } | null;
    conflictEventGameIds: string[];
    controlGrantStatus: string;
  }>;
  grantSessionExpiresAt: string | null;
};

export function PitchManagerPage() {
  const [credential, setCredential] = useState("");
  const [scope, setScope] = useState<Scope | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadCurrent = useCallback(async () => {
    const response = await fetch("/api/pitch-manager/current");
    const payload = (await response.json()) as { status: string; value?: View };
    if (!response.ok || payload.status !== "accepted" || payload.value === undefined)
      throw new Error("Unable to open the Pitch Manager view.");
    const nextScope: Scope = {
      eventId: payload.value.eventId,
      gameDayId: payload.value.gameDayId,
      gameDayDate: payload.value.gameDayDate,
      eventTimeZone: payload.value.eventTimeZone,
      pitchId: payload.value.pitch.pitchId,
    };
    setScope(nextScope);
    setView(payload.value);
  }, []);

  const admit = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/pitch-manager/admit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ qrCredential: credential, deviceClass: "mobile" }),
      });
      const payload = (await response.json()) as { status: string };
      if (!response.ok || payload.status !== "admitted")
        throw new Error("Unable to admit this Pitch Manager QR.");
      await loadCurrent();
    } catch {
      setMessage("Unable to admit this Pitch Manager QR.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (scope !== null || view !== null) return;
    void loadCurrent().catch(() => undefined);
  }, [loadCurrent, scope, view]);

  const leave = async () => {
    await fetch("/api/pitch-manager/leave", { method: "POST" });
    setScope(null);
    setView(null);
  };

  if (view === null || scope === null) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-xl items-center justify-center p-4">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Pitch Manager handoff</CardTitle>
            <CardDescription>Scan the QR for one Pitch and Game Day.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="pitch-manager-credential">Scanned Pitch Manager QR value</Label>
              <Input
                id="pitch-manager-credential"
                type="password"
                autoComplete="off"
                value={credential}
                onChange={(event) => setCredential(event.target.value)}
              />
            </div>
            <Button disabled={busy || credential.length === 0} onClick={() => void admit()}>
              Open Pitch
            </Button>
            {message ? <p className="text-sm text-destructive">{message}</p> : null}
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl p-4 pb-12 sm:p-6">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>{view.pitch.name}</CardTitle>
            <CardDescription>
              Pitch Manager · Game Day {view.gameDayDate} · {view.eventTimeZone} ·{" "}
              {view.schedule.length} Slots
            </CardDescription>
          </div>
          <Button variant="outline" onClick={() => void leave()}>
            Leave
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Session valid until{" "}
            {view.grantSessionExpiresAt === null ? "the Grant expires" : view.grantSessionExpiresAt}
            .
          </p>
          <div className="space-y-2" aria-label="Pitch schedule">
            {view.schedule.map((slot) => {
              const game = slot.eventGame;
              return (
                <div
                  className={`rounded border p-3 ${slot.conflictEventGameIds.length > 1 ? "border-destructive" : ""}`}
                  key={slot.pitchSlotId}
                >
                  <div className="flex flex-wrap justify-between gap-2">
                    <span className="font-medium">Slot {slot.sequence}</span>
                    <span>{slot.expectedStart}</span>
                  </div>
                  <p className="text-sm">
                    {game === null
                      ? "No Event Game"
                      : `${game.gameCode ?? game.eventGameId} · ${game.sideA.displayName} vs ${game.sideB.displayName}`}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Control Grant: {slot.controlGrantStatus}
                    {slot.conflictEventGameIds.length > 1 ? " · Schedule conflict" : ""}
                  </p>
                </div>
              );
            })}
          </div>
          {message ? <p className="text-sm text-destructive">{message}</p> : null}
          <Button
            variant="outline"
            onClick={() => void loadCurrent().catch(() => setMessage("View refresh failed."))}
          >
            Refresh Pitch
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
