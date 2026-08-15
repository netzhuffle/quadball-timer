import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode/lib/browser";
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

type ControlGrant = {
  grantId: string;
  status: string;
  eligibility: string;
  eventGameId: string | null;
  affectedSessionCount?: number;
};

type ControlSession = {
  label: string;
  createdAtMs: number;
  lastActiveAtMs: number;
  deviceClass: string;
  browserClass: string;
};

export function PitchManagerPage() {
  const [credential, setCredential] = useState("");
  const [scope, setScope] = useState<Scope | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [controlGrants, setControlGrants] = useState<Record<string, ControlGrant | null>>({});
  const [controlQr, setControlQr] = useState<Record<string, string>>({});
  const [controlSessions, setControlSessions] = useState<Record<string, ControlSession[]>>({});

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

  const controlGrantUrl = (pitchSlotId: string) =>
    `/api/pitch-manager/events/${scope?.eventId}/game-days/${scope?.gameDayId}/pitches/${scope?.pitchId}/pitch-slots/${pitchSlotId}/control-grant`;

  const inspectControlGrant = async (pitchSlotId: string) => {
    const response = await fetch(controlGrantUrl(pitchSlotId));
    const payload = (await response.json()) as { status: string; value?: ControlGrant | null };
    if (!response.ok || payload.status !== "accepted")
      throw new Error("Control Grant lookup failed.");
    setControlGrants((current) => ({ ...current, [pitchSlotId]: payload.value ?? null }));
    setControlQr((current) => ({ ...current, [pitchSlotId]: "" }));
    return payload.value ?? null;
  };

  const createControlGrant = async (pitchSlotId: string) => {
    const response = await fetch(controlGrantUrl(pitchSlotId), { method: "POST" });
    if (!response.ok) throw new Error("Control Grant creation failed.");
    await inspectControlGrant(pitchSlotId);
  };

  const revealControlGrant = async (pitchSlotId: string) => {
    const response = await fetch(`${controlGrantUrl(pitchSlotId)}/reveal`, { method: "POST" });
    const payload = (await response.json()) as {
      status: string;
      value?: { qrCredential?: string };
    };
    if (!response.ok || payload.status !== "accepted" || payload.value?.qrCredential === undefined)
      throw new Error("Control Grant QR reveal failed.");
    const dataUrl = await QRCode.toDataURL(payload.value.qrCredential);
    setControlQr((current) => ({ ...current, [pitchSlotId]: dataUrl }));
  };

  const loadControlSessions = async (pitchSlotId: string) => {
    const response = await fetch(`${controlGrantUrl(pitchSlotId)}/sessions`);
    const payload = (await response.json()) as { status: string; value?: ControlSession[] };
    if (!response.ok || payload.status !== "accepted") throw new Error("Session list failed.");
    setControlSessions((current) => ({ ...current, [pitchSlotId]: payload.value ?? [] }));
  };

  const rotateControlGrant = async (pitchSlotId: string) => {
    const response = await fetch(`${controlGrantUrl(pitchSlotId)}/rotate`, { method: "POST" });
    const payload = (await response.json()) as {
      status: string;
      value?: { affectedSessionCount?: number };
    };
    if (!response.ok || payload.status !== "accepted")
      throw new Error("Control Grant rotation failed.");
    setMessage(
      `Control Grant rotated; ${payload.value?.affectedSessionCount ?? 0} session(s) revoked.`,
    );
    await inspectControlGrant(pitchSlotId);
    await loadControlSessions(pitchSlotId);
  };

  const revokeControlSession = async (pitchSlotId: string, label: string) => {
    const response = await fetch(`${controlGrantUrl(pitchSlotId)}/sessions/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionReference: label }),
    });
    if (!response.ok) throw new Error("Control session revocation failed.");
    await loadControlSessions(pitchSlotId);
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
              const controlGrant = controlGrants[slot.pitchSlotId];
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
                  <div className="mt-3 space-y-2 border-t pt-2">
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void inspectControlGrant(slot.pitchSlotId).catch(() =>
                            setMessage("Control Grant lookup failed."),
                          )
                        }
                      >
                        Inspect Control Grant
                      </Button>
                      {controlGrant === undefined || controlGrant === null ? (
                        <Button
                          size="sm"
                          onClick={() =>
                            void createControlGrant(slot.pitchSlotId).catch(() =>
                              setMessage("Control Grant creation failed."),
                            )
                          }
                        >
                          Create Control Grant
                        </Button>
                      ) : null}
                      {controlGrant ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void revealControlGrant(slot.pitchSlotId).catch(() =>
                                setMessage("Control Grant QR reveal failed."),
                              )
                            }
                          >
                            Reveal QR
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void loadControlSessions(slot.pitchSlotId).catch(() =>
                                setMessage("Session list failed."),
                              )
                            }
                          >
                            Sessions
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void rotateControlGrant(slot.pitchSlotId).catch(() =>
                                setMessage("Control Grant rotation failed."),
                              )
                            }
                          >
                            Rotate Grant
                          </Button>
                        </>
                      ) : null}
                    </div>
                    {controlGrant ? (
                      <p className="text-xs text-muted-foreground">
                        {controlGrant.status} · {controlGrant.eligibility}
                        {controlGrant.eventGameId ? ` · ${controlGrant.eventGameId}` : ""}
                      </p>
                    ) : null}
                    {controlQr[slot.pitchSlotId] ? (
                      <img
                        alt={`Control Grant QR for Pitch Slot ${slot.sequence}`}
                        className="h-40 w-40 rounded border bg-white p-2"
                        src={controlQr[slot.pitchSlotId]}
                      />
                    ) : null}
                    {(controlSessions[slot.pitchSlotId] ?? []).map((session) => (
                      <div
                        className="flex items-center justify-between gap-2 text-xs"
                        key={session.label}
                      >
                        <span>
                          {session.label} · {session.deviceClass}/{session.browserClass}
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void revokeControlSession(slot.pitchSlotId, session.label).catch(() =>
                              setMessage("Control session revocation failed."),
                            )
                          }
                        >
                          Revoke
                        </Button>
                      </div>
                    ))}
                  </div>
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
