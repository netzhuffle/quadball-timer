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
      gameplaySlots: Array<{
        gameplaySlotId: string;
        gameDayId: string;
        sequence: number;
        scheduledStartMs: number;
      }>;
      pitchSlots: Array<{
        pitchSlotId: string;
        gameDayId: string;
        pitchId: string;
        gameplaySlotId: string;
        sequence: number;
      }>;
      eventGames: Array<{
        eventGameId: string;
        gameDayId: string;
        gameplaySlotId: string;
        pitchSlotId: string;
        gameCode: string | null;
        gameDesignation: string | null;
        sideA: { eventTeamId: string | null; sourceLabel: string | null };
        sideB: { eventTeamId: string | null; sourceLabel: string | null };
      }>;
    };
    selectedGameDayId: string | null;
    authority: "technical-admin" | "event-admin";
  };
};

type TeamDraft = { name: string; defaultColor: string };
type ConfirmationDraft = { sideA: string; sideB: string };
type ScheduleResponse = {
  status: "accepted";
  value: {
    gameDayId: string;
    gameplaySlots: HubResponse["value"]["event"]["gameplaySlots"];
    pitchSlots: HubResponse["value"]["event"]["pitchSlots"];
    eventGames: HubResponse["value"]["event"]["eventGames"];
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
  const [teamName, setTeamName] = useState("");
  const [teamColor, setTeamColor] = useState("#00afe8");
  const [pitchName, setPitchName] = useState("");
  const [rosterTeamId, setRosterTeamId] = useState("");
  const [playerNumber, setPlayerNumber] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [teamDrafts, setTeamDrafts] = useState<Record<string, TeamDraft>>({});
  const [pitchDrafts, setPitchDrafts] = useState<Record<string, string>>({});
  const [slotSequence, setSlotSequence] = useState("1");
  const [scheduledStart, setScheduledStart] = useState("");
  const [gameplaySlotId, setGameplaySlotId] = useState("");
  const [pitchSlotId, setPitchSlotId] = useState("");
  const [gameCode, setGameCode] = useState("");
  const [gameDesignation, setGameDesignation] = useState("");
  const [sideASource, setSideASource] = useState("");
  const [sideBSource, setSideBSource] = useState("");
  const [confirmationDrafts, setConfirmationDrafts] = useState<Record<string, ConfirmationDraft>>(
    {},
  );
  const [schedule, setSchedule] = useState<ScheduleResponse["value"] | null>(null);
  const [selectedPitchId, setSelectedPitchId] = useState("");
  const [pitchView, setPitchView] = useState<{
    pitch: { pitchId: string; name: string };
    gameplaySlots: HubResponse["value"]["event"]["gameplaySlots"];
    pitchSlots: HubResponse["value"]["event"]["pitchSlots"];
    eventGames: HubResponse["value"]["event"]["eventGames"];
  } | null>(null);

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
    setSchedule({
      gameDayId: payload.value.selectedGameDayId ?? "",
      gameplaySlots: payload.value.event.gameplaySlots.filter(
        (slot) => slot.gameDayId === payload.value.selectedGameDayId,
      ),
      pitchSlots: payload.value.event.pitchSlots.filter(
        (slot) => slot.gameDayId === payload.value.selectedGameDayId,
      ),
      eventGames: payload.value.event.eventGames.filter(
        (game) => game.gameDayId === payload.value.selectedGameDayId,
      ),
    });
    setConfirmationDrafts((current) =>
      Object.fromEntries(
        payload.value.event.eventGames.map((game) => [
          game.eventGameId,
          current[game.eventGameId] ?? {
            sideA: game.sideA.eventTeamId ?? "",
            sideB: game.sideB.eventTeamId ?? "",
          },
        ]),
      ),
    );
  };

  const loadSchedule = async (gameDayId = selectedGameDayId) => {
    if (eventId.trim().length === 0 || gameDayId === null) return;
    const response = await fetch(
      `/api/event-admin/slot-setup?eventId=${encodeURIComponent(eventId)}&gameDayId=${encodeURIComponent(gameDayId)}`,
    );
    const payload = (await response.json()) as ScheduleResponse;
    if (!response.ok || payload.status !== "accepted")
      throw new Error("Unable to load Slot setup.");
    setSchedule(payload.value);
  };

  const loadPitchView = async (pitchId: string) => {
    if (selectedGameDayId === null || pitchId.length === 0) return;
    const response = await fetch(
      `/api/event-admin/pitch-view?eventId=${encodeURIComponent(eventId)}&gameDayId=${encodeURIComponent(selectedGameDayId)}&pitchId=${encodeURIComponent(pitchId)}`,
    );
    const payload = (await response.json()) as {
      status: "accepted";
      value: NonNullable<typeof pitchView>;
    };
    if (!response.ok || payload.status !== "accepted")
      throw new Error("Unable to load Pitch view.");
    setPitchView(payload.value);
  };

  const confirmGameplaySlot = async (
    gameplaySlotId: string,
    games: HubResponse["value"]["event"]["eventGames"],
  ) => {
    if (selectedGameDayId === null) return;
    const response = await fetch(
      `/api/event-admin/events/${eventId}/game-days/${selectedGameDayId}/gameplay-slots/${gameplaySlotId}/confirm-teams`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          games: games.map((game) => ({
            eventGameId: game.eventGameId,
            sideAEventTeamId: confirmationDrafts[game.eventGameId]?.sideA ?? "",
            sideBEventTeamId: confirmationDrafts[game.eventGameId]?.sideB ?? "",
          })),
        }),
      },
    );
    if (!response.ok) throw new Error("Gameplay Slot confirmation failed.");
    await loadHub(selectedGameDayId);
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
              <div className="space-y-3 rounded-lg border p-3">
                <div>
                  <p className="font-semibold">Slot setup</p>
                  <p className="text-xs text-muted-foreground">
                    Create the ordered Gameplay Slots first. Each Pitch receives its matching Pitch
                    Slot automatically.
                  </p>
                </div>
                {selectedGameDayId === null ? (
                  <p className="text-sm text-muted-foreground">
                    Choose a Game Day to schedule Games.
                  </p>
                ) : (
                  <>
                    <div className="grid gap-2 sm:grid-cols-3">
                      <Input
                        aria-label="Gameplay Slot sequence"
                        inputMode="numeric"
                        placeholder="Slot #"
                        value={slotSequence}
                        onChange={(event) => setSlotSequence(event.target.value)}
                      />
                      <Input
                        aria-label="Gameplay Slot scheduled start"
                        type="datetime-local"
                        value={scheduledStart}
                        onChange={(event) => setScheduledStart(event.target.value)}
                      />
                      <Button
                        disabled={busy || scheduledStart.length === 0}
                        onClick={() =>
                          void run(async () => {
                            const response = await fetch(
                              `/api/event-admin/events/${eventId}/game-days/${selectedGameDayId}/gameplay-slots`,
                              {
                                method: "POST",
                                headers: { "content-type": "application/json" },
                                body: JSON.stringify({
                                  sequence: Number(slotSequence),
                                  scheduledStart,
                                }),
                              },
                            );
                            if (!response.ok) throw new Error("Gameplay Slot creation failed.");
                            await loadHub(selectedGameDayId);
                          })
                        }
                      >
                        Add Gameplay Slot
                      </Button>
                    </div>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void run(() => loadSchedule())}
                    >
                      Refresh Slot setup
                    </Button>
                    <div className="space-y-2">
                      {(schedule?.gameplaySlots ?? hub.event.gameplaySlots).map((slot) => {
                        const slotGames = (schedule?.eventGames ?? hub.event.eventGames).filter(
                          (game) => game.gameplaySlotId === slot.gameplaySlotId,
                        );
                        return (
                          <div className="rounded border p-2" key={slot.gameplaySlotId}>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-medium">
                                Slot {slot.sequence} ·{" "}
                                {new Intl.DateTimeFormat(undefined, {
                                  timeZone: hub.event.timeZone,
                                  hour: "2-digit",
                                  minute: "2-digit",
                                }).format(new Date(slot.scheduledStartMs))}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {slotGames.length} Games
                              </span>
                            </div>
                            <div className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                              {slotGames.map((game) => {
                                const draft = confirmationDrafts[game.eventGameId] ?? {
                                  sideA: game.sideA.eventTeamId ?? "",
                                  sideB: game.sideB.eventTeamId ?? "",
                                };
                                return (
                                  <div className="rounded bg-muted/50 p-2" key={game.eventGameId}>
                                    <span className="font-medium">
                                      {game.gameCode ?? game.eventGameId}
                                    </span>
                                    {game.gameDesignation ? (
                                      <span className="ml-2 text-muted-foreground">
                                        {game.gameDesignation}
                                      </span>
                                    ) : null}
                                    <div className="mt-1 grid gap-1 sm:grid-cols-2">
                                      <select
                                        aria-label={`Confirm ${game.eventGameId} Side A`}
                                        className="h-9 rounded-md border bg-background px-2 text-sm"
                                        value={draft.sideA}
                                        onChange={(event) =>
                                          setConfirmationDrafts((current) => ({
                                            ...current,
                                            [game.eventGameId]: {
                                              ...draft,
                                              sideA: event.target.value,
                                            },
                                          }))
                                        }
                                      >
                                        <option value="">Side A Team</option>
                                        {hub.event.teams.map((team) => (
                                          <option key={team.eventTeamId} value={team.eventTeamId}>
                                            {team.name}
                                          </option>
                                        ))}
                                      </select>
                                      <select
                                        aria-label={`Confirm ${game.eventGameId} Side B`}
                                        className="h-9 rounded-md border bg-background px-2 text-sm"
                                        value={draft.sideB}
                                        onChange={(event) =>
                                          setConfirmationDrafts((current) => ({
                                            ...current,
                                            [game.eventGameId]: {
                                              ...draft,
                                              sideB: event.target.value,
                                            },
                                          }))
                                        }
                                      >
                                        <option value="">Side B Team</option>
                                        {hub.event.teams.map((team) => (
                                          <option key={team.eventTeamId} value={team.eventTeamId}>
                                            {team.name}
                                          </option>
                                        ))}
                                      </select>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                            <Button
                              className="mt-2"
                              variant="outline"
                              disabled={
                                busy ||
                                slotGames.length === 0 ||
                                slotGames.some((game) => {
                                  const draft = confirmationDrafts[game.eventGameId];
                                  return (
                                    draft === undefined ||
                                    draft.sideA.length === 0 ||
                                    draft.sideB.length === 0 ||
                                    draft.sideA === draft.sideB
                                  );
                                })
                              }
                              onClick={() =>
                                void run(() => confirmGameplaySlot(slot.gameplaySlotId, slotGames))
                              }
                            >
                              Confirm teams for Slot
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                    <div className="space-y-2 border-t pt-3">
                      <p className="font-medium">Add Event Game</p>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <select
                          aria-label="Gameplay Slot for Event Game"
                          className="h-10 rounded-md border bg-background px-3 text-sm"
                          value={gameplaySlotId}
                          onChange={(event) => setGameplaySlotId(event.target.value)}
                        >
                          <option value="">Gameplay Slot</option>
                          {(schedule?.gameplaySlots ?? hub.event.gameplaySlots).map((slot) => (
                            <option key={slot.gameplaySlotId} value={slot.gameplaySlotId}>
                              Slot {slot.sequence}
                            </option>
                          ))}
                        </select>
                        <select
                          aria-label="Pitch Slot for Event Game"
                          className="h-10 rounded-md border bg-background px-3 text-sm"
                          value={pitchSlotId}
                          onChange={(event) => setPitchSlotId(event.target.value)}
                        >
                          <option value="">Pitch Slot</option>
                          {(schedule?.pitchSlots ?? hub.event.pitchSlots).map((slot) => (
                            <option key={slot.pitchSlotId} value={slot.pitchSlotId}>
                              {hub.event.pitches.find((pitch) => pitch.pitchId === slot.pitchId)
                                ?.name ?? slot.pitchId}{" "}
                              · Slot {slot.sequence}
                            </option>
                          ))}
                        </select>
                        <Input
                          aria-label="Game Code"
                          placeholder="Game Code (optional)"
                          value={gameCode}
                          onChange={(event) => setGameCode(event.target.value)}
                        />
                        <Input
                          aria-label="Game Designation"
                          placeholder="Game Designation (optional)"
                          value={gameDesignation}
                          onChange={(event) => setGameDesignation(event.target.value)}
                        />
                        <Input
                          aria-label="Side A source label"
                          placeholder="Side A source label"
                          value={sideASource}
                          onChange={(event) => setSideASource(event.target.value)}
                        />
                        <Input
                          aria-label="Side B source label"
                          placeholder="Side B source label"
                          value={sideBSource}
                          onChange={(event) => setSideBSource(event.target.value)}
                        />
                      </div>
                      <Button
                        disabled={
                          busy ||
                          gameplaySlotId.length === 0 ||
                          pitchSlotId.length === 0 ||
                          sideASource.trim().length === 0 ||
                          sideBSource.trim().length === 0
                        }
                        onClick={() =>
                          void run(async () => {
                            const response = await fetch(
                              `/api/event-admin/events/${eventId}/game-days/${selectedGameDayId}/event-games`,
                              {
                                method: "POST",
                                headers: { "content-type": "application/json" },
                                body: JSON.stringify({
                                  gameplaySlotId,
                                  pitchSlotId,
                                  gameCode,
                                  gameDesignation,
                                  sideA: { sourceLabel: sideASource },
                                  sideB: { sourceLabel: sideBSource },
                                }),
                              },
                            );
                            if (!response.ok) throw new Error("Event Game creation failed.");
                            setGameCode("");
                            setGameDesignation("");
                            setSideASource("");
                            setSideBSource("");
                            await loadHub(selectedGameDayId);
                          })
                        }
                      >
                        Add unresolved Event Game
                      </Button>
                    </div>
                  </>
                )}
              </div>
              <div className="space-y-3 rounded-lg border p-3">
                <p className="font-semibold">Pitch view</p>
                <div className="flex flex-wrap gap-2">
                  {hub.event.pitches.map((pitch) => (
                    <Button
                      key={pitch.pitchId}
                      variant={selectedPitchId === pitch.pitchId ? "default" : "outline"}
                      onClick={() => {
                        setSelectedPitchId(pitch.pitchId);
                        void run(() => loadPitchView(pitch.pitchId));
                      }}
                    >
                      {pitch.name}
                    </Button>
                  ))}
                </div>
                {pitchView ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {pitchView.pitchSlots.map((slot) => {
                      const gameplaySlot = pitchView.gameplaySlots.find(
                        (candidate) => candidate.gameplaySlotId === slot.gameplaySlotId,
                      );
                      const game = pitchView.eventGames.find(
                        (candidate) => candidate.pitchSlotId === slot.pitchSlotId,
                      );
                      return (
                        <div className="rounded border p-2 text-sm" key={slot.pitchSlotId}>
                          <span className="font-medium">
                            Slot {slot.sequence}
                            {gameplaySlot
                              ? ` · ${new Intl.DateTimeFormat(undefined, { timeZone: hub.event.timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(gameplaySlot.scheduledStartMs))}`
                              : ""}
                          </span>
                          <span className="ml-2 text-muted-foreground">
                            {game
                              ? `${game.sideA.eventTeamId ?? game.sideA.sourceLabel} vs ${game.sideB.eventTeamId ?? game.sideB.sourceLabel}`
                              : "Empty"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
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
