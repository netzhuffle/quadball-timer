import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type HubResponse = {
  status: "accepted";
  value: {
    event: {
      eventId: string;
      name: string;
      timeZone: string;
      lifecycle: string;
      gameDays: Array<{ gameDayId: string; date: string; classification: string }>;
    };
    selectedGameDayId: string | null;
    authority: "technical-admin" | "event-admin";
  };
};

export function EventAdminPage() {
  const queryEventId = new URLSearchParams(window.location.search).get("eventId") ?? "";
  const [eventId, setEventId] = useState(queryEventId);
  const [credential, setCredential] = useState("");
  const [hub, setHub] = useState<HubResponse["value"] | null>(null);
  const [selectedGameDayId, setSelectedGameDayId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadHub = async (nextGameDayId = selectedGameDayId) => {
    if (eventId.trim().length === 0) return;
    const params = new URLSearchParams({ eventId: eventId.trim() });
    if (nextGameDayId !== null) params.set("gameDayId", nextGameDayId);
    const response = await fetch(`/api/event-admin/hub?${params}`);
    const payload = (await response.json()) as
      | HubResponse
      | { status: "rejected" | "retryable-failure"; message?: string };
    if (!response.ok || payload.status !== "accepted")
      throw new Error("Unable to open the Event Hub.");
    setHub(payload.value);
    setSelectedGameDayId(payload.value.selectedGameDayId);
  };

  useEffect(() => {
    if (eventId.length > 0) void loadHub().catch(() => undefined);
  }, []);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch {
      setMessage("Unable to authorize the Event Hub.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl items-center justify-center p-4">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Event Hub</CardTitle>
          <CardDescription>Choose the Event and Game Day before operating it.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="event-id">Event ID</Label>
            <Input
              id="event-id"
              value={eventId}
              onChange={(event) => setEventId(event.target.value)}
            />
          </div>
          {hub === null ? (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="event-admin-credential">Scanned Event Admin QR value</Label>
                <Input
                  id="event-admin-credential"
                  type="password"
                  value={credential}
                  onChange={(event) => setCredential(event.target.value)}
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">
                  Use a trusted QR scanner and submit its value here.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy || eventId.trim().length === 0 || credential.length === 0}
                  onClick={() =>
                    void run(async () => {
                      const response = await fetch("/api/event-admin/admit", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ qrCredential: credential }),
                      });
                      if (!response.ok) throw new Error("Admission failed.");
                      setCredential("");
                      await loadHub(null);
                    })
                  }
                >
                  Admit Event Admin
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || eventId.trim().length === 0}
                  onClick={() => void run(() => loadHub(null))}
                >
                  Open as Technical Admin
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4 rounded-lg border p-4">
              <div>
                <p className="font-semibold">{hub.event.name}</p>
                <p className="text-sm text-muted-foreground">
                  {hub.event.timeZone} · {hub.authority}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="game-day-selector">Game Day</Label>
                <select
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  id="game-day-selector"
                  value={selectedGameDayId ?? ""}
                  onChange={(event) => {
                    const next = event.target.value || null;
                    setSelectedGameDayId(next);
                    void run(() => loadHub(next));
                  }}
                >
                  <option value="">Choose a Game Day</option>
                  {hub.event.gameDays.map((day) => (
                    <option key={day.gameDayId} value={day.gameDayId}>
                      {day.date} · {day.classification}
                    </option>
                  ))}
                </select>
              </div>
              <Button variant="outline" onClick={() => setHub(null)}>
                Change authority
              </Button>
            </div>
          )}
          {message ? <p className="text-sm text-destructive">{message}</p> : null}
        </CardContent>
      </Card>
    </main>
  );
}
