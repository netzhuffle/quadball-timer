import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode/lib/browser";
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
      publicationStatus: "unpublished" | "published" | "cancelled";
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
        expectedDelayMs: number;
      }>;
      pitchSlots: Array<{
        pitchSlotId: string;
        gameDayId: string;
        pitchId: string;
        gameplaySlotId: string;
        sequence: number;
        expectedDelayMs: number;
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
        expectedStartMs: number;
        expectedPlayingPeriod: { startMs: number; endMs: number };
        scheduleConflict: boolean;
        teamScheduleConflict: boolean;
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
type PitchManagerGrantResponse = {
  status: "accepted";
  value: {
    grantId: string;
    grantVersion: string;
    gameDayId: string;
    gameDayDate: string;
    pitchId: string;
    status: string;
    expiresAtMs: number | null;
  };
};
type ControlGrantResponse = {
  status: "accepted";
  value: {
    grantId: string;
    status: string;
    eligibility: string;
    eventGameId: string | null;
  } | null;
};
type ControlSession = {
  label: string;
  deviceClass: string;
  browserClass: string;
};
type AccessSheetType = "event-admin" | "pitch-manager" | "control-grant";
type AccessSheetResponse = {
  status: "accepted";
  value: {
    contentType: "text/html";
    body: string;
    version: {
      versionId: string;
      environmentId: string;
      type: AccessSheetType;
      generatedAtMs: number;
      testMark: boolean;
    };
  };
};

type CatalogRemovalPreview = {
  target: {
    kind: "event-team" | "game-day" | "pitch" | "gameplay-slot" | "pitch-slot" | "event-game";
    eventId: string;
    targetId: string;
  };
  eligible: boolean;
  rejectionCategory: string | null;
  repairWorkflow: string | null;
  impact: {
    descendantCount: number;
    retiredAuthorityCount: number;
    retiredAuthorityCategories: {
      eventAdmin: number;
      pitchManager: number;
      control: number;
    };
    retainedEventGameCount: number;
    retainedControlActionCount: number;
  };
  fingerprint: string;
};

class EventPublicationValidationError extends Error {}

const publicationWarningLabels: Record<string, string> = {
  "missing-event-teams": "Event Teams",
  "missing-pitches": "Pitches",
  "missing-gameplay-slots": "Gameplay Slots",
  "missing-pitch-slots": "Pitch Slots",
  "missing-event-games": "Event Games",
  "unresolved-matchups": "unresolved matchups or confirmed sides",
};

type AccessSheetArtifactScope = {
  eventId: string;
  authority: HubResponse["value"]["authority"] | "none";
  gameDayId: string | null;
  pitchId: string;
  type: AccessSheetType;
};

type AccessSheetGenerationAttempt = {
  sequence: number;
  scopeKey: string;
};

function useAccessSheetArtifactOwner(scope: AccessSheetArtifactScope) {
  const scopeKey = JSON.stringify(scope);
  const sequenceRef = useRef(0);
  const [stored, setStored] = useState<{
    scopeKey: string;
    artifact: AccessSheetResponse["value"];
  } | null>(null);

  useEffect(() => {
    sequenceRef.current += 1;
    setStored(null);
  }, [scopeKey]);

  useEffect(
    () => () => {
      sequenceRef.current += 1;
    },
    [],
  );

  const invalidate = () => {
    sequenceRef.current += 1;
    setStored(null);
  };

  const begin = (): AccessSheetGenerationAttempt => {
    sequenceRef.current += 1;
    setStored(null);
    return { sequence: sequenceRef.current, scopeKey };
  };

  const matches = (attempt: AccessSheetGenerationAttempt) =>
    attempt.sequence === sequenceRef.current && attempt.scopeKey === scopeKey;

  const install = (
    attempt: AccessSheetGenerationAttempt,
    artifact: AccessSheetResponse["value"],
  ) => {
    if (!matches(attempt)) return false;
    setStored({ scopeKey, artifact });
    return true;
  };

  const fail = (attempt: AccessSheetGenerationAttempt) => {
    if (matches(attempt)) setStored(null);
  };

  return {
    artifact: stored?.scopeKey === scopeKey ? stored.artifact : null,
    begin,
    fail,
    install,
    invalidate,
  };
}

type ScheduleDelayPreview = {
  dimension: "gameplay-slot" | "pitch-slot";
  targetSlotId: string;
  cascade: boolean;
  changes: Array<{
    slotId: string;
    beforeExpectedStartMs: number;
    afterExpectedStartMs: number;
    eventGames: Array<{
      eventGameId: string;
      beforeExpectedStartMs: number;
      afterExpectedStartMs: number;
      beforeExpectedPlayingPeriod: { startMs: number; endMs: number };
      afterExpectedPlayingPeriod: { startMs: number; endMs: number };
    }>;
  }>;
};

export function EventAdminPage() {
  const queryEventId = new URLSearchParams(window.location.search).get("eventId") ?? "";
  const [eventId, setEventId] = useState(queryEventId);
  const [credential, setCredential] = useState("");
  const [hub, setHub] = useState<HubResponse["value"] | null>(null);
  const [selectedGameDayId, setSelectedGameDayId] = useState<string | null>(null);
  const [pitchManagerGameDayId, setPitchManagerGameDayId] = useState("");
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
  const [delayDrafts, setDelayDrafts] = useState<Record<string, string>>({});
  const [cascadeDrafts, setCascadeDrafts] = useState<Record<string, boolean>>({});
  const [delayPreviews, setDelayPreviews] = useState<Record<string, ScheduleDelayPreview>>({});
  const [reassignmentTargets, setReassignmentTargets] = useState<Record<string, string>>({});
  const [reassignmentModes, setReassignmentModes] = useState<Record<string, "move" | "swap">>({});
  const [selectedPitchId, setSelectedPitchId] = useState("");
  const [pitchView, setPitchView] = useState<{
    pitch: { pitchId: string; name: string };
    gameplaySlots: HubResponse["value"]["event"]["gameplaySlots"];
    pitchSlots: HubResponse["value"]["event"]["pitchSlots"];
    eventGames: HubResponse["value"]["event"]["eventGames"];
  } | null>(null);
  const [pitchManagerPitchId, setPitchManagerPitchId] = useState("");
  const [pitchManagerGrant, setPitchManagerGrant] = useState<
    PitchManagerGrantResponse["value"] | null
  >(null);
  const [pitchManagerQrDataUrl, setPitchManagerQrDataUrl] = useState<string | null>(null);
  const [controlGrants, setControlGrants] = useState<Record<string, ControlGrantResponse["value"]>>(
    {},
  );
  const [controlQrDataUrls, setControlQrDataUrls] = useState<Record<string, string>>({});
  const [controlSessions, setControlSessions] = useState<Record<string, ControlSession[]>>({});
  const [publicationImpactConfirmed, setPublicationImpactConfirmed] = useState(false);
  const [removalPreview, setRemovalPreview] = useState<CatalogRemovalPreview | null>(null);
  const [accessSheetType, setAccessSheetType] = useState<AccessSheetType>("event-admin");
  const accessSheetOwner = useAccessSheetArtifactOwner({
    eventId: eventId.trim(),
    authority: hub?.authority ?? "none",
    gameDayId: selectedGameDayId,
    pitchId: selectedPitchId,
    type: accessSheetType,
  });

  const loadHub = async (nextGameDayId = selectedGameDayId) => {
    accessSheetOwner.invalidate();
    if (eventId.trim().length === 0) throw new Error("An Event is required.");
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
    return payload.value;
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

  const loadPitchView = async (pitchId: string, gameDayId = selectedGameDayId) => {
    if (gameDayId === null || pitchId.length === 0) return;
    const response = await fetch(
      `/api/event-admin/pitch-view?eventId=${encodeURIComponent(eventId)}&gameDayId=${encodeURIComponent(gameDayId)}&pitchId=${encodeURIComponent(pitchId)}`,
    );
    const payload = (await response.json()) as {
      status: "accepted";
      value: NonNullable<typeof pitchView>;
    };
    if (!response.ok || payload.status !== "accepted")
      throw new Error("Unable to load Pitch view.");
    setPitchView(payload.value);
  };

  const previewCatalogRemoval = async (
    kind: CatalogRemovalPreview["target"]["kind"],
    targetId: string,
  ) => {
    const response = await fetch(
      `/api/event-admin/events/${encodeURIComponent(eventId)}/catalog-removal/preview`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, targetId }),
      },
    );
    const payload = (await response.json()) as
      | { status: "accepted"; value: CatalogRemovalPreview }
      | { status: "rejected" | "retryable-failure"; detail?: string };
    if (!response.ok || payload.status !== "accepted")
      throw new Error(
        "detail" in payload
          ? (payload.detail ?? "Removal preview failed.")
          : "Removal preview failed.",
      );
    setRemovalPreview(payload.value);
  };

  const acceptCatalogRemoval = async () => {
    if (removalPreview === null || !removalPreview.eligible) return;
    const target = removalPreview.target;
    const removedSelectedGameDay =
      target.kind === "game-day" && target.targetId === selectedGameDayId;
    const removedSelectedPitch = target.kind === "pitch" && target.targetId === selectedPitchId;
    const preferredGameDayId = removedSelectedGameDay ? null : selectedGameDayId;
    const preferredPitchId = removedSelectedPitch ? "" : selectedPitchId;
    if (removedSelectedGameDay) {
      setSelectedGameDayId(null);
      setSchedule(null);
      setSelectedPitchId("");
      setPitchView(null);
    } else if (removedSelectedPitch) {
      setSelectedPitchId("");
      setPitchView(null);
    }
    const response = await fetch(
      `/api/event-admin/events/${encodeURIComponent(eventId)}/catalog-removal`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: removalPreview.target.kind,
          targetId: removalPreview.target.targetId,
          previewFingerprint: removalPreview.fingerprint,
        }),
      },
    );
    const payload = (await response.json()) as { status: string; detail?: string };
    if (!response.ok || payload.status !== "accepted")
      throw new Error(payload.detail ?? "Event Catalog removal failed.");
    setRemovalPreview(null);
    const base = await loadHub(null);
    const nextGameDayId =
      (preferredGameDayId !== null &&
        base.event.gameDays.some((day) => day.gameDayId === preferredGameDayId) &&
        preferredGameDayId) ||
      base.event.gameDays[0]?.gameDayId ||
      null;
    if (nextGameDayId === null) {
      setSelectedGameDayId(null);
      setSchedule(null);
      setSelectedPitchId("");
      setPitchView(null);
      return;
    }
    const selected = await loadHub(nextGameDayId);
    await loadSchedule(nextGameDayId);
    const nextPitchId =
      (preferredPitchId.length > 0 &&
        selected.event.pitches.some((pitch) => pitch.pitchId === preferredPitchId) &&
        preferredPitchId) ||
      selected.event.pitches[0]?.pitchId ||
      "";
    if (nextPitchId.length === 0) {
      setSelectedPitchId("");
      setPitchView(null);
      return;
    }
    setSelectedPitchId(nextPitchId);
    await loadPitchView(nextPitchId, nextGameDayId);
  };

  const controlGrantUrl = (pitchSlotId: string) =>
    `/api/event-admin/events/${eventId}/game-days/${selectedGameDayId}/pitches/${selectedPitchId}/pitch-slots/${pitchSlotId}/control-grant`;

  const inspectControlGrant = async (pitchSlotId: string) => {
    const response = await fetch(controlGrantUrl(pitchSlotId));
    const payload = (await response.json()) as ControlGrantResponse;
    if (!response.ok || payload.status !== "accepted")
      throw new Error("Control Grant lookup failed.");
    setControlGrants((current) => ({ ...current, [pitchSlotId]: payload.value }));
    setControlQrDataUrls((current) => ({ ...current, [pitchSlotId]: "" }));
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
    setControlQrDataUrls((current) => ({ ...current, [pitchSlotId]: dataUrl }));
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

  const loadPitchManagerGrant = async () => {
    if (pitchManagerGameDayId.length === 0 || pitchManagerPitchId.length === 0) return;
    const response = await fetch(
      `/api/event-admin/events/${eventId}/game-days/${pitchManagerGameDayId}/pitches/${pitchManagerPitchId}/pitch-manager-grant`,
    );
    const payload = (await response.json()) as PitchManagerGrantResponse | { status: string };
    if (!response.ok || payload.status !== "accepted") throw new Error("Grant lookup failed.");
    setPitchManagerGrant((payload as PitchManagerGrantResponse).value ?? null);
    setPitchManagerQrDataUrl(null);
  };

  const changePublicationStatus = async (status: "unpublished" | "published" | "cancelled") => {
    if (hub === null) return;
    const leavingPublished = hub.event.publicationStatus === "published" && status !== "published";
    const response = await fetch(`/api/event-admin/events/${eventId}/publication-status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status,
        impactConfirmed: leavingPublished ? publicationImpactConfirmed : undefined,
      }),
    });
    const payload = (await response.json()) as {
      status: "accepted" | "rejected" | "retryable-failure";
      reason?: string;
      detail?: string;
      value?: { warnings?: readonly string[] };
    };
    if (
      response.status === 400 &&
      payload.status === "rejected" &&
      payload.reason === "invalid-input" &&
      typeof payload.detail === "string"
    )
      throw new EventPublicationValidationError(payload.detail);
    if (!response.ok || payload.status !== "accepted")
      throw new Error("Publication update failed.");
    setPublicationImpactConfirmed(false);
    const warningLabels = (payload.value?.warnings ?? []).map(
      (warning) => publicationWarningLabels[warning] ?? "incomplete schedule content",
    );
    setMessage(
      warningLabels.length > 0
        ? `Published with incomplete schedule: ${warningLabels.join(", ")}.`
        : "Publication Status updated.",
    );
    await loadHub(selectedGameDayId);
  };

  const generateAccessSheet = async () => {
    const attempt = accessSheetOwner.begin();
    const gameDayId = selectedGameDayId ?? "";
    const pitchId = selectedPitchId;
    try {
      if (eventId.length === 0 || (accessSheetType === "control-grant" && gameDayId.length === 0))
        throw new Error("Select a Game Day before generating this Access Sheet.");
      if (accessSheetType === "control-grant" && pitchId.length === 0)
        throw new Error("Select a Pitch before generating the Control Access Sheet.");
      const response = await fetch(
        `/api/event-admin/events/${encodeURIComponent(eventId)}/access-sheets`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: accessSheetType,
            ...(accessSheetType === "control-grant" && gameDayId.length > 0 ? { gameDayId } : {}),
            ...(accessSheetType === "control-grant" && pitchId.length > 0 ? { pitchId } : {}),
          }),
        },
      );
      const payload = (await response.json()) as AccessSheetResponse | { status: string };
      if (!response.ok || payload.status !== "accepted")
        throw new Error("Access Sheet generation failed.");
      accessSheetOwner.install(attempt, (payload as AccessSheetResponse).value);
    } catch (error) {
      accessSheetOwner.fail(attempt);
      throw error;
    }
  };

  const managePitchManagerGrant = async (
    operation: "rotate" | "disable" | "revoke" | "reactivate",
  ) => {
    if (pitchManagerGameDayId.length === 0 || pitchManagerPitchId.length === 0) return;
    const response = await fetch(
      `/api/event-admin/events/${eventId}/game-days/${pitchManagerGameDayId}/pitches/${pitchManagerPitchId}/pitch-manager-grant/${operation}`,
      { method: "POST" },
    );
    if (!response.ok) throw new Error("Pitch Manager Grant lifecycle change failed.");
    await loadPitchManagerGrant();
  };

  const delayMsFor = (slotId: string) => {
    const minutes = Number(delayDrafts[slotId] ?? "0");
    if (!Number.isSafeInteger(minutes) || minutes < 0)
      throw new Error("Expected Delay is invalid.");
    return minutes * 60_000;
  };

  const previewGameplayDelay = async (slotId: string) => {
    if (selectedGameDayId === null) return;
    const response = await fetch(
      `/api/event-admin/events/${eventId}/game-days/${selectedGameDayId}/gameplay-slots/${slotId}/expected-delay/preview`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedDelayMs: delayMsFor(slotId),
          cascade: cascadeDrafts[slotId] === true,
        }),
      },
    );
    if (!response.ok) throw new Error(await responseError(response, "Delay preview failed."));
    const payload = (await response.json()) as { status: string; value?: ScheduleDelayPreview };
    if (payload.status !== "accepted" || payload.value === undefined)
      throw new Error("Delay preview failed.");
    setDelayPreviews((current) => ({ ...current, [slotId]: payload.value! }));
  };

  const applyGameplayDelay = async (slotId: string) => {
    if (selectedGameDayId === null) return;
    const response = await fetch(
      `/api/event-admin/events/${eventId}/game-days/${selectedGameDayId}/gameplay-slots/${slotId}/expected-delay`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedDelayMs: delayMsFor(slotId),
          cascade: cascadeDrafts[slotId] === true,
        }),
      },
    );
    if (!response.ok) throw new Error(await responseError(response, "Delay apply failed."));
    await loadSchedule();
    setDelayPreviews((current) => {
      const next = { ...current };
      delete next[slotId];
      return next;
    });
  };

  const previewPitchDelay = async (slotId: string) => {
    if (selectedGameDayId === null) return;
    const response = await fetch(
      `/api/event-admin/events/${eventId}/game-days/${selectedGameDayId}/pitch-slots/${slotId}/expected-delay/preview`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedDelayMs: delayMsFor(slotId),
          cascade: cascadeDrafts[slotId] === true,
        }),
      },
    );
    if (!response.ok) throw new Error(await responseError(response, "Delay preview failed."));
    const payload = (await response.json()) as { status: string; value?: ScheduleDelayPreview };
    if (payload.status !== "accepted" || payload.value === undefined)
      throw new Error("Delay preview failed.");
    setDelayPreviews((current) => ({ ...current, [slotId]: payload.value! }));
  };

  const applyPitchDelay = async (slotId: string) => {
    if (selectedGameDayId === null) return;
    const response = await fetch(
      `/api/event-admin/events/${eventId}/game-days/${selectedGameDayId}/pitch-slots/${slotId}/expected-delay`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedDelayMs: delayMsFor(slotId),
          cascade: cascadeDrafts[slotId] === true,
        }),
      },
    );
    if (!response.ok) throw new Error(await responseError(response, "Delay apply failed."));
    await loadSchedule();
    if (selectedPitchId.length > 0) await loadPitchView(selectedPitchId);
    setDelayPreviews((current) => {
      const next = { ...current };
      delete next[slotId];
      return next;
    });
  };

  const reassignEventGame = async (eventGameId: string) => {
    if (selectedGameDayId === null) return;
    const targetPitchSlotId = reassignmentTargets[eventGameId];
    if (targetPitchSlotId === undefined || targetPitchSlotId.length === 0)
      throw new Error("Choose a target Pitch Slot.");
    const response = await fetch(
      `/api/event-admin/events/${eventId}/game-days/${selectedGameDayId}/event-games/${eventGameId}/reassign`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetPitchSlotId,
          mode: reassignmentModes[eventGameId] ?? "move",
        }),
      },
    );
    if (!response.ok) throw new Error(await responseError(response, "Pitch Reassignment failed."));
    await loadSchedule();
    if (selectedPitchId.length > 0) await loadPitchView(selectedPitchId);
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
    } catch (error) {
      setMessage(
        error instanceof EventPublicationValidationError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Unable to authorize the Event Hub.",
      );
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
              onChange={(event) => {
                accessSheetOwner.invalidate();
                setEventId(event.target.value);
              }}
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
                  onClick={() =>
                    void run(async () => {
                      await loadHub(null);
                    })
                  }
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
                  {hub.event.timeZone} · {hub.authority} · {hub.event.publicationStatus}
                </p>
              </div>
              <div className="space-y-3 rounded-lg border p-3">
                <div>
                  <p className="font-semibold">Unused catalog removal</p>
                  <p className="text-xs text-muted-foreground">
                    Preview validates references and lifecycle state. Accepted removal refetches the
                    Event Hub and schedule projections.
                  </p>
                </div>
                <div className="space-y-2">
                  {[
                    ...hub.event.teams.map((item) => ({
                      kind: "event-team" as const,
                      targetId: item.eventTeamId,
                      label: `Event Team ${item.name}`,
                    })),
                    ...hub.event.gameDays.map((item) => ({
                      kind: "game-day" as const,
                      targetId: item.gameDayId,
                      label: `Game Day ${item.date}`,
                    })),
                    ...hub.event.pitches.map((item) => ({
                      kind: "pitch" as const,
                      targetId: item.pitchId,
                      label: `Pitch ${item.name}`,
                    })),
                    ...hub.event.gameplaySlots.map((item) => ({
                      kind: "gameplay-slot" as const,
                      targetId: item.gameplaySlotId,
                      label: `Gameplay Slot ${item.sequence}`,
                    })),
                    ...hub.event.pitchSlots.map((item) => ({
                      kind: "pitch-slot" as const,
                      targetId: item.pitchSlotId,
                      label: `Pitch Slot ${item.sequence}`,
                    })),
                    ...hub.event.eventGames.map((item) => ({
                      kind: "event-game" as const,
                      targetId: item.eventGameId,
                      label: `Event Game ${item.eventGameId}`,
                    })),
                  ].map((item) => {
                    const active =
                      removalPreview?.target.kind === item.kind &&
                      removalPreview.target.targetId === item.targetId;
                    return (
                      <div className="flex flex-wrap items-center gap-2" key={item.targetId}>
                        <span className="min-w-40 text-sm">{item.label}</span>
                        <Button
                          aria-label={`Preview removal ${item.label}`}
                          disabled={busy}
                          onClick={() =>
                            void run(() => previewCatalogRemoval(item.kind, item.targetId))
                          }
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          Preview removal
                        </Button>
                        {active && removalPreview !== null && removalPreview.eligible ? (
                          <Button
                            disabled={busy}
                            onClick={() => void run(acceptCatalogRemoval)}
                            size="sm"
                            type="button"
                            variant="destructive"
                          >
                            Confirm
                          </Button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                {removalPreview ? (
                  <div className="rounded border p-2 text-sm" role="status">
                    <p>
                      {removalPreview.eligible ? "Eligible" : "Blocked"} · catalog descendants{" "}
                      {removalPreview.impact.descendantCount}; retained Event Game Records{" "}
                      {removalPreview.impact.retainedEventGameCount}; accepted Control Actions{" "}
                      {removalPreview.impact.retainedControlActionCount}; retiring{" "}
                      {removalPreview.impact.retiredAuthorityCount} authority item(s).
                    </p>
                    <p className="text-muted-foreground">
                      Authority categories: Event Admin{" "}
                      {removalPreview.impact.retiredAuthorityCategories.eventAdmin}, Pitch Manager{" "}
                      {removalPreview.impact.retiredAuthorityCategories.pitchManager}, Control{" "}
                      {removalPreview.impact.retiredAuthorityCategories.control}.
                    </p>
                    {!removalPreview.eligible && removalPreview.repairWorkflow ? (
                      <p className="text-muted-foreground">{removalPreview.repairWorkflow}</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div className="space-y-3 rounded-lg border p-3">
                <p className="font-semibold">Publication Status</p>
                <p className="text-sm text-muted-foreground">
                  Only Published Events are visible to anonymous audiences.
                </p>
                {hub.event.publicationStatus === "published" ? (
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      aria-label="Confirm leaving Published"
                      checked={publicationImpactConfirmed}
                      onChange={(event) => setPublicationImpactConfirmed(event.target.checked)}
                      type="checkbox"
                    />
                    <span>I understand that leaving Published removes public availability.</span>
                  </label>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {(["unpublished", "published", "cancelled"] as const).map((status) => {
                    const leavingPublished =
                      hub.event.publicationStatus === "published" && status !== "published";
                    return (
                      <Button
                        key={status}
                        disabled={
                          busy ||
                          hub.event.publicationStatus === status ||
                          (leavingPublished && !publicationImpactConfirmed)
                        }
                        onClick={() => void run(() => changePublicationStatus(status))}
                        variant={status === "published" ? "default" : "outline"}
                      >
                        {status === "cancelled"
                          ? "Cancel Event"
                          : `${status[0]?.toUpperCase()}${status.slice(1)} Event`}
                      </Button>
                    );
                  })}
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="game-day-selector">Game Day</Label>
                <select
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  id="game-day-selector"
                  value={selectedGameDayId ?? ""}
                  onChange={(event) => {
                    const next = event.target.value || null;
                    accessSheetOwner.invalidate();
                    setSelectedGameDayId(next);
                    void run(async () => {
                      await loadHub(next);
                    });
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
                                {slotGames.length} Games · Expected Delay{" "}
                                {slot.expectedDelayMs / 60_000}m
                              </span>
                            </div>
                            <div className="mt-2 grid gap-2 sm:grid-cols-[auto_auto_1fr_auto_auto]">
                              <Label htmlFor={`gameplay-delay-${slot.gameplaySlotId}`}>
                                Delay (min)
                              </Label>
                              <Input
                                id={`gameplay-delay-${slot.gameplaySlotId}`}
                                aria-label={`Gameplay Slot ${slot.sequence} Expected Delay minutes`}
                                inputMode="numeric"
                                value={
                                  delayDrafts[slot.gameplaySlotId] ??
                                  String(slot.expectedDelayMs / 60_000)
                                }
                                onChange={(event) =>
                                  setDelayDrafts((current) => ({
                                    ...current,
                                    [slot.gameplaySlotId]: event.target.value,
                                  }))
                                }
                              />
                              <label className="flex items-center gap-2 text-sm">
                                <input
                                  type="checkbox"
                                  checked={cascadeDrafts[slot.gameplaySlotId] === true}
                                  onChange={(event) =>
                                    setCascadeDrafts((current) => ({
                                      ...current,
                                      [slot.gameplaySlotId]: event.target.checked,
                                    }))
                                  }
                                />
                                Cascade later Gameplay Slots
                              </label>
                              <Button
                                variant="outline"
                                disabled={busy}
                                onClick={() =>
                                  void run(() => previewGameplayDelay(slot.gameplaySlotId))
                                }
                              >
                                Preview Delay
                              </Button>
                              <Button
                                disabled={busy}
                                onClick={() =>
                                  void run(() => applyGameplayDelay(slot.gameplaySlotId))
                                }
                              >
                                Apply Delay
                              </Button>
                            </div>
                            {delayPreviews[slot.gameplaySlotId] ? (
                              <DelayPreviewView
                                preview={delayPreviews[slot.gameplaySlotId]!}
                                timeZone={hub.event.timeZone}
                              />
                            ) : null}
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
                        accessSheetOwner.invalidate();
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
                      const games = pitchView.eventGames.filter(
                        (candidate) => candidate.pitchSlotId === slot.pitchSlotId,
                      );
                      const controlGrant = controlGrants[slot.pitchSlotId];
                      return (
                        <div className="rounded border p-2 text-sm" key={slot.pitchSlotId}>
                          <div className="flex flex-wrap justify-between gap-2">
                            <span className="font-medium">
                              Slot {slot.sequence}
                              {gameplaySlot
                                ? ` · ${new Intl.DateTimeFormat(undefined, { timeZone: hub.event.timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(gameplaySlot.scheduledStartMs))}`
                                : ""}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              Expected Delay {slot.expectedDelayMs / 60_000}m
                            </span>
                          </div>
                          <div className="mt-2 grid gap-2 sm:grid-cols-[auto_1fr_auto_auto]">
                            <Label htmlFor={`pitch-delay-${slot.pitchSlotId}`}>Delay (min)</Label>
                            <Input
                              id={`pitch-delay-${slot.pitchSlotId}`}
                              aria-label={`Pitch Slot ${slot.sequence} Expected Delay minutes`}
                              inputMode="numeric"
                              value={
                                delayDrafts[slot.pitchSlotId] ??
                                String(slot.expectedDelayMs / 60_000)
                              }
                              onChange={(event) =>
                                setDelayDrafts((current) => ({
                                  ...current,
                                  [slot.pitchSlotId]: event.target.value,
                                }))
                              }
                            />
                            <Button
                              variant="outline"
                              disabled={busy}
                              onClick={() => void run(() => previewPitchDelay(slot.pitchSlotId))}
                            >
                              Preview Pitch Delay
                            </Button>
                            <Button
                              disabled={busy}
                              onClick={() => void run(() => applyPitchDelay(slot.pitchSlotId))}
                            >
                              Apply Pitch Delay
                            </Button>
                          </div>
                          {delayPreviews[slot.pitchSlotId] ? (
                            <DelayPreviewView
                              preview={delayPreviews[slot.pitchSlotId]!}
                              timeZone={hub.event.timeZone}
                            />
                          ) : null}
                          {games.length === 0 ? (
                            <p className="mt-2 text-muted-foreground">Empty</p>
                          ) : (
                            games.map((game) => (
                              <div className="mt-2 rounded bg-muted/50 p-2" key={game.eventGameId}>
                                <div>
                                  <span className="font-medium">
                                    {game.gameCode ?? game.eventGameId}
                                  </span>
                                  <span className="ml-2 text-muted-foreground">
                                    {game.sideA.eventTeamId ?? game.sideA.sourceLabel} vs{" "}
                                    {game.sideB.eventTeamId ?? game.sideB.sourceLabel}
                                  </span>
                                </div>
                                <div className="mt-1 text-xs">
                                  Expected Start{" "}
                                  {formatScheduleTime(game.expectedStartMs, hub.event.timeZone)}
                                  {game.scheduleConflict ? " · Schedule Conflict" : ""}
                                  {game.teamScheduleConflict ? " · Team Schedule Conflict" : ""}
                                </div>
                                <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                                  <select
                                    aria-label={`Reassign ${game.eventGameId} target Pitch Slot`}
                                    className="h-9 rounded-md border bg-background px-2 text-sm"
                                    value={reassignmentTargets[game.eventGameId] ?? ""}
                                    onChange={(event) =>
                                      setReassignmentTargets((current) => ({
                                        ...current,
                                        [game.eventGameId]: event.target.value,
                                      }))
                                    }
                                  >
                                    <option value="">Target Pitch Slot</option>
                                    {(schedule?.pitchSlots ?? hub.event.pitchSlots).map(
                                      (target) => (
                                        <option key={target.pitchSlotId} value={target.pitchSlotId}>
                                          {target.pitchSlotId} · Slot {target.sequence}
                                        </option>
                                      ),
                                    )}
                                  </select>
                                  <select
                                    aria-label={`Reassign ${game.eventGameId} mode`}
                                    className="h-9 rounded-md border bg-background px-2 text-sm"
                                    value={reassignmentModes[game.eventGameId] ?? "move"}
                                    onChange={(event) =>
                                      setReassignmentModes((current) => ({
                                        ...current,
                                        [game.eventGameId]: event.target.value as "move" | "swap",
                                      }))
                                    }
                                  >
                                    <option value="move">Move</option>
                                    <option value="swap">Swap</option>
                                  </select>
                                  <Button
                                    variant="outline"
                                    disabled={busy}
                                    onClick={() =>
                                      void run(() => reassignEventGame(game.eventGameId))
                                    }
                                  >
                                    Reassign Game
                                  </Button>
                                </div>
                              </div>
                            ))
                          )}
                          <div className="mt-3 space-y-2 border-t pt-2">
                            <div className="flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  void run(() => inspectControlGrant(slot.pitchSlotId))
                                }
                              >
                                Inspect Control Grant
                              </Button>
                              {controlGrant === undefined || controlGrant === null ? (
                                <Button
                                  size="sm"
                                  onClick={() =>
                                    void run(() => createControlGrant(slot.pitchSlotId))
                                  }
                                >
                                  Create Control Grant
                                </Button>
                              ) : (
                                <>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      void run(() => revealControlGrant(slot.pitchSlotId))
                                    }
                                  >
                                    Reveal QR
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      void run(() => loadControlSessions(slot.pitchSlotId))
                                    }
                                  >
                                    Sessions
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      void run(() => rotateControlGrant(slot.pitchSlotId))
                                    }
                                  >
                                    Rotate Grant
                                  </Button>
                                </>
                              )}
                            </div>
                            {controlGrant ? (
                              <p className="text-xs text-muted-foreground">
                                {controlGrant.status} · {controlGrant.eligibility}
                                {controlGrant.eventGameId ? ` · ${controlGrant.eventGameId}` : ""}
                              </p>
                            ) : null}
                            {controlQrDataUrls[slot.pitchSlotId] ? (
                              <img
                                alt={`Control Grant QR for Pitch Slot ${slot.sequence}`}
                                className="h-40 w-40 rounded border bg-white p-2"
                                src={controlQrDataUrls[slot.pitchSlotId]}
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
                                    void run(() =>
                                      revokeControlSession(slot.pitchSlotId, session.label),
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
                ) : null}
              </div>
              <div className="space-y-3 rounded-lg border p-3">
                <div>
                  <p className="font-semibold">Grant Access Sheets</p>
                  <p className="text-xs text-muted-foreground">
                    Generate a print-ready QR handoff. Grant Codes are never included. Test sheets
                    are marked TEST in the artifact.
                  </p>
                </div>
                <div className="grid gap-2 sm:grid-cols-3">
                  <select
                    aria-label="Access Sheet type"
                    className="h-10 rounded-md border bg-background px-3 text-sm"
                    value={accessSheetType}
                    onChange={(event) => {
                      accessSheetOwner.invalidate();
                      setAccessSheetType(event.target.value as AccessSheetType);
                    }}
                  >
                    <option value="event-admin">Event Admin</option>
                    <option value="pitch-manager">Pitch Manager</option>
                    <option value="control-grant">Control Grant</option>
                  </select>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || hub === null}
                    onClick={() => void run(generateAccessSheet)}
                  >
                    Generate Access Sheet
                  </Button>
                </div>
                {accessSheetOwner.artifact ? (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Version {accessSheetOwner.artifact.version.versionId} ·{" "}
                      {accessSheetOwner.artifact.version.environmentId}
                      {accessSheetOwner.artifact.version.testMark ? " · TEST" : ""}
                    </p>
                    <iframe
                      id="generated-access-sheet-preview"
                      title="Generated Grant Access Sheet preview"
                      className="min-h-[28rem] w-full rounded border bg-white"
                      srcDoc={accessSheetOwner.artifact.body}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        const frame = document.getElementById(
                          "generated-access-sheet-preview",
                        ) as HTMLIFrameElement | null;
                        frame?.contentWindow?.focus();
                        frame?.contentWindow?.print();
                      }}
                    >
                      Print Access Sheet
                    </Button>
                  </div>
                ) : null}
              </div>
              <div className="space-y-3 rounded-lg border p-3">
                <div>
                  <p className="font-semibold">Pitch Manager handoff</p>
                  <p className="text-xs text-muted-foreground">
                    One Grant covers exactly one Pitch and Game Day. The QR is revealed only on
                    demand.
                  </p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <select
                    aria-label="Pitch Manager Game Day"
                    className="h-10 rounded-md border bg-background px-3 text-sm"
                    value={pitchManagerGameDayId}
                    onChange={(event) => {
                      accessSheetOwner.invalidate();
                      setPitchManagerGameDayId(event.target.value);
                      setPitchManagerGrant(null);
                      setPitchManagerQrDataUrl(null);
                    }}
                  >
                    <option value="">Game Day</option>
                    {hub.event.gameDays.map((day) => (
                      <option key={day.gameDayId} value={day.gameDayId}>
                        {day.date}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Pitch Manager Pitch"
                    className="h-10 rounded-md border bg-background px-3 text-sm"
                    value={pitchManagerPitchId}
                    onChange={(event) => {
                      accessSheetOwner.invalidate();
                      setPitchManagerPitchId(event.target.value);
                      setPitchManagerGrant(null);
                      setPitchManagerQrDataUrl(null);
                    }}
                  >
                    <option value="">Pitch</option>
                    {hub.event.pitches.map((pitch) => (
                      <option key={pitch.pitchId} value={pitch.pitchId}>
                        {pitch.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={
                      busy || pitchManagerGameDayId.length === 0 || pitchManagerPitchId.length === 0
                    }
                    onClick={() => void run(loadPitchManagerGrant)}
                  >
                    Inspect Grant
                  </Button>
                  <Button
                    type="button"
                    disabled={
                      busy || pitchManagerGameDayId.length === 0 || pitchManagerPitchId.length === 0
                    }
                    onClick={() =>
                      void run(async () => {
                        const response = await fetch(
                          `/api/event-admin/events/${eventId}/game-days/${pitchManagerGameDayId}/pitches/${pitchManagerPitchId}/pitch-manager-grant`,
                          { method: "POST" },
                        );
                        if (!response.ok) throw new Error("Pitch Manager Grant creation failed.");
                        await loadPitchManagerGrant();
                      })
                    }
                  >
                    Create Grant
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || pitchManagerGrant === null}
                    onClick={() =>
                      void run(async () => {
                        const response = await fetch(
                          `/api/event-admin/events/${eventId}/game-days/${pitchManagerGameDayId}/pitches/${pitchManagerPitchId}/pitch-manager-grant/reveal`,
                          { method: "POST" },
                        );
                        const payload = (await response.json()) as {
                          status: string;
                          value?: { qrCredential?: string };
                        };
                        if (
                          !response.ok ||
                          payload.status !== "accepted" ||
                          payload.value?.qrCredential === undefined
                        )
                          throw new Error("Pitch Manager QR reveal failed.");
                        setPitchManagerQrDataUrl(
                          await QRCode.toDataURL(payload.value.qrCredential),
                        );
                      })
                    }
                  >
                    Reveal QR
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    aria-label="Rotate Pitch Manager Grant"
                    disabled={busy || pitchManagerGrant === null}
                    onClick={() => void run(() => managePitchManagerGrant("rotate"))}
                  >
                    Rotate Grant
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    aria-label="Disable Pitch Manager Grant"
                    disabled={busy || pitchManagerGrant === null}
                    onClick={() => void run(() => managePitchManagerGrant("disable"))}
                  >
                    Disable Grant
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    aria-label="Revoke Pitch Manager Grant"
                    disabled={busy || pitchManagerGrant === null}
                    onClick={() => void run(() => managePitchManagerGrant("revoke"))}
                  >
                    Revoke Grant
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    aria-label="Reactivate Pitch Manager Grant"
                    disabled={busy || pitchManagerGrant === null}
                    onClick={() => void run(() => managePitchManagerGrant("reactivate"))}
                  >
                    Reactivate Grant
                  </Button>
                </div>
                {pitchManagerGrant ? (
                  <p className="text-sm">
                    {pitchManagerGrant.status} · expires{" "}
                    {pitchManagerGrant.expiresAtMs === null
                      ? "never"
                      : new Date(pitchManagerGrant.expiresAtMs).toLocaleString()}
                  </p>
                ) : null}
                {pitchManagerQrDataUrl ? (
                  <img
                    alt="Pitch Manager Grant QR code"
                    className="h-48 w-48 rounded border bg-white p-2"
                    src={pitchManagerQrDataUrl}
                  />
                ) : null}
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  accessSheetOwner.invalidate();
                  setHub(null);
                }}
              >
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

function DelayPreviewView({
  preview,
  timeZone,
}: {
  preview: ScheduleDelayPreview;
  timeZone: string;
}) {
  return (
    <div className="mt-2 rounded bg-blue-50 p-2 text-xs dark:bg-blue-950/30">
      <p className="font-medium">
        Preview · {preview.dimension === "gameplay-slot" ? "Gameplay" : "Pitch"} ·{" "}
        {preview.cascade ? "cascaded" : "single slot"}
      </p>
      {preview.changes.length === 0 ? (
        <p>No slots change; applying this value will be rejected as no change.</p>
      ) : (
        preview.changes.map((change) => (
          <div key={change.slotId}>
            Slot {change.slotId}: {formatScheduleTime(change.beforeExpectedStartMs, timeZone)} →{" "}
            {formatScheduleTime(change.afterExpectedStartMs, timeZone)}
            {change.eventGames.map((game) => (
              <div className="ml-3" key={game.eventGameId}>
                {game.eventGameId}: {formatScheduleTime(game.beforeExpectedStartMs, timeZone)} →{" "}
                {formatScheduleTime(game.afterExpectedStartMs, timeZone)}
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

function formatScheduleTime(value: number, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: unknown; message?: unknown };
    if (typeof payload.detail === "string") return payload.detail;
    if (typeof payload.message === "string") return payload.message;
  } catch {
    // Keep the bounded generic UI message.
  }
  return fallback;
}
