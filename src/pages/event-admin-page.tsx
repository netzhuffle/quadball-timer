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
      teams: Array<{
        eventTeamId: string;
        name: string;
        defaultColor: string;
        roster: Array<{ playerNumber: number; publicName: string }>;
      }>;
      pitches: Array<{ pitchId: string; name: string }>;
    };
    selectedGameDayId: string | null;
    authority: "technical-admin" | "event-admin";
  };
};

type TeamDraft = { name: string; defaultColor: string };

export function EventAdminPage() {
  const queryEventId = new URLSearchParams(window.location.search).get("eventId") ?? "";
  const [eventId, setEventId] = useState(queryEventId);
  const [credential, setCredential] = useState("");
  const [hub, setHub] = useState<HubResponse["value"] | null>(null);
  const [selectedGameDayId, setSelectedGameDayId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [teamColor, setTeamColor] = useState("#00afe8");
  const [pitchName, setPitchName] = useState("");
  const [rosterTeamId, setRosterTeamId] = useState("");
  const [playerNumber, setPlayerNumber] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [teamDrafts, setTeamDrafts] = useState<Record<string, TeamDraft>>({});
  const [pitchDrafts, setPitchDrafts] = useState<Record<string, string>>({});

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
    setTeamDrafts(
      Object.fromEntries(
        payload.value.event.teams.map((team) => [
          team.eventTeamId,
          {
            name: team.name,
            defaultColor: team.defaultColor,
          },
        ]),
      ),
    );
    setPitchDrafts(
      Object.fromEntries(payload.value.event.pitches.map((pitch) => [pitch.pitchId, pitch.name])),
    );
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
              <div className="space-y-3 rounded-lg border p-3">
                <p className="font-semibold">Event Teams</p>
                {hub.event.teams.map((team) =>
                  (() => {
                    const draft = teamDrafts[team.eventTeamId] ?? {
                      name: team.name,
                      defaultColor: team.defaultColor,
                    };
                    return (
                      <div className="space-y-2 rounded border p-2" key={team.eventTeamId}>
                        <div className="flex items-center gap-2">
                          <span
                            aria-label={`${team.name} color`}
                            className="size-4 rounded-full border"
                            style={{ backgroundColor: team.defaultColor }}
                          />
                          <span className="font-medium">{team.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {team.roster.length} roster entries
                          </span>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                          <Input
                            aria-label={`Event Team ${team.name} name`}
                            value={draft.name}
                            onChange={(event) =>
                              setTeamDrafts((current) => ({
                                ...current,
                                [team.eventTeamId]: { ...draft, name: event.target.value },
                              }))
                            }
                          />
                          <Input
                            aria-label={`Event Team ${team.name} color`}
                            type="color"
                            value={draft.defaultColor}
                            onChange={(event) =>
                              setTeamDrafts((current) => ({
                                ...current,
                                [team.eventTeamId]: { ...draft, defaultColor: event.target.value },
                              }))
                            }
                          />
                          <Button
                            disabled={busy || draft.name.trim().length === 0}
                            onClick={() =>
                              void run(async () => {
                                const response = await fetch(
                                  `/api/event-admin/events/${eventId}/teams/${team.eventTeamId}`,
                                  {
                                    method: "PATCH",
                                    headers: { "content-type": "application/json" },
                                    body: JSON.stringify(draft),
                                  },
                                );
                                if (!response.ok) throw new Error("Team update failed.");
                                await loadHub();
                              })
                            }
                          >
                            Save Event Team
                          </Button>
                        </div>
                        <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                          {team.roster.map((entry) => (
                            <span className="rounded bg-muted px-2 py-1" key={entry.playerNumber}>
                              #{entry.playerNumber} {entry.publicName}
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })(),
                )}
                <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                  <Input
                    aria-label="New Event Team name"
                    placeholder="Team name"
                    value={teamName}
                    onChange={(event) => setTeamName(event.target.value)}
                  />
                  <Input
                    aria-label="New Event Team color"
                    type="color"
                    value={teamColor}
                    onChange={(event) => setTeamColor(event.target.value)}
                  />
                  <Button
                    disabled={busy || teamName.trim().length === 0}
                    onClick={() =>
                      void run(async () => {
                        const response = await fetch(`/api/event-admin/events/${eventId}/teams`, {
                          method: "POST",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({ name: teamName, defaultColor: teamColor }),
                        });
                        if (!response.ok) throw new Error("Team creation failed.");
                        setTeamName("");
                        await loadHub();
                      })
                    }
                  >
                    Add Team
                  </Button>
                </div>
                <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                  <select
                    aria-label="Roster Event Team"
                    className="h-10 rounded-md border bg-background px-3 text-sm"
                    value={rosterTeamId}
                    onChange={(event) => setRosterTeamId(event.target.value)}
                  >
                    <option value="">Team</option>
                    {hub.event.teams.map((team) => (
                      <option key={team.eventTeamId} value={team.eventTeamId}>
                        {team.name}
                      </option>
                    ))}
                  </select>
                  <Input
                    aria-label="Player number"
                    inputMode="numeric"
                    placeholder="Player #"
                    value={playerNumber}
                    onChange={(event) => setPlayerNumber(event.target.value)}
                  />
                  <Input
                    aria-label="Player public name"
                    placeholder="Public name"
                    value={playerName}
                    onChange={(event) => setPlayerName(event.target.value)}
                  />
                  <Button
                    disabled={
                      busy ||
                      rosterTeamId.length === 0 ||
                      playerNumber.length === 0 ||
                      playerName.trim().length === 0
                    }
                    onClick={() =>
                      void run(async () => {
                        const response = await fetch(
                          `/api/event-admin/events/${eventId}/teams/${rosterTeamId}/roster`,
                          {
                            method: "PUT",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({
                              playerNumber: Number(playerNumber),
                              publicName: playerName,
                            }),
                          },
                        );
                        if (!response.ok) throw new Error("Roster update failed.");
                        setPlayerNumber("");
                        setPlayerName("");
                        await loadHub();
                      })
                    }
                  >
                    Save Roster
                  </Button>
                </div>
              </div>
              <div className="space-y-3 rounded-lg border p-3">
                <p className="font-semibold">Pitches</p>
                <div className="flex flex-wrap gap-2">
                  {hub.event.pitches.map((pitch) => (
                    <div className="flex items-center gap-2" key={pitch.pitchId}>
                      <Input
                        aria-label={`Pitch ${pitch.name} name`}
                        value={pitchDrafts[pitch.pitchId] ?? pitch.name}
                        onChange={(event) =>
                          setPitchDrafts((current) => ({
                            ...current,
                            [pitch.pitchId]: event.target.value,
                          }))
                        }
                      />
                      <Button
                        disabled={
                          busy || (pitchDrafts[pitch.pitchId] ?? pitch.name).trim().length === 0
                        }
                        onClick={() =>
                          void run(async () => {
                            const response = await fetch(
                              `/api/event-admin/events/${eventId}/pitches/${pitch.pitchId}`,
                              {
                                method: "PATCH",
                                headers: { "content-type": "application/json" },
                                body: JSON.stringify({
                                  name: pitchDrafts[pitch.pitchId] ?? pitch.name,
                                }),
                              },
                            );
                            if (!response.ok) throw new Error("Pitch update failed.");
                            await loadHub();
                          })
                        }
                      >
                        Save Pitch
                      </Button>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Input
                    aria-label="New Pitch name"
                    placeholder="Pitch name"
                    value={pitchName}
                    onChange={(event) => setPitchName(event.target.value)}
                  />
                  <Button
                    disabled={busy || pitchName.trim().length === 0}
                    onClick={() =>
                      void run(async () => {
                        const response = await fetch(`/api/event-admin/events/${eventId}/pitches`, {
                          method: "POST",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({ name: pitchName }),
                        });
                        if (!response.ok) throw new Error("Pitch creation failed.");
                        setPitchName("");
                        await loadHub();
                      })
                    }
                  >
                    Add Pitch
                  </Button>
                </div>
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
