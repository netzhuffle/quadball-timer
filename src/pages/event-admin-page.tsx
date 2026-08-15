import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode/lib/browser";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AdministrativeAuditBrowser } from "@/pages/administrative-audit-browser";
import { createGrantSecretOwner, type GrantSecretToken } from "@/lib/grant-secret-owner";
import { isEventOperationsHealth, type EventOperationsHealth } from "@/lib/event-operations-health";

type HubResponse = {
  status: "accepted";
  value: {
    event: {
      eventId: string;
      name: string;
      timeZone: string;
      lifecycle: string;
      publicationStatus: "unpublished" | "published" | "cancelled";
      gameDays: Array<{
        gameDayId: string;
        date: string;
        classification: string;
        heatStoppageConfiguration: "enabled" | "disabled";
      }>;
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
        sideA: {
          sideId: string;
          eventTeamId: string | null;
          eventTeamName: string | null;
          sourceLabel: string | null;
        };
        sideB: {
          sideId: string;
          eventTeamId: string | null;
          eventTeamName: string | null;
          sourceLabel: string | null;
        };
        expectedStartMs: number;
        expectedPlayingPeriod: { startMs: number; endMs: number };
        scheduleConflict: boolean;
        teamScheduleConflict: boolean;
      }>;
    };
    selectedGameDayId: string | null;
    authority: "technical-admin" | "event-admin";
    health: EventOperationsHealth;
  };
};

type TeamDraft = { name: string; defaultColor: string };
type ConfirmationDraft = { sideA: string; sideB: string };
type IdentityDraft = { eventTeamId: string; confirmation: boolean; reason: string };
type PresentationDraft = {
  pitchOrientation: "side-a-left" | "side-b-left";
  sideAColor: string;
  sideBColor: string;
};
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
type GrantCodeProjection = {
  grantId: string;
  grantVersion: string;
  state: "absent" | "present" | "disabled" | "erased";
  formatVersion: 1 | null;
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

export type GrantQrRenderer = (credential: string) => Promise<string>;

const defaultGrantQrRenderer: GrantQrRenderer = (credential) => QRCode.toDataURL(credential);

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

type LockedGameRequestToken = {
  eventId: string;
  gameDayId: string;
  authority: HubResponse["value"]["authority"] | "none";
  generation: number;
  grantToken: GrantSecretToken;
};

type LockedGamePreview = {
  operation: "locked-game-correction" | "game-reopening";
  fingerprint: string;
  impact: {
    facts: string;
    lifecycle: { from: string; to: string; lock: string };
    timer: string;
    authority: { controlGrant: string; qr: string; grantVersion: string };
    sessions: { category: string; count: number };
    code: { category: string; count: number };
    queuedDiscard: { category: string; count: number };
  };
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

export function EventAdminPage({
  qrRenderer = defaultGrantQrRenderer,
}: {
  qrRenderer?: GrantQrRenderer;
} = {}) {
  const queryEventId = new URLSearchParams(window.location.search).get("eventId") ?? "";
  const [eventId, setEventId] = useState(queryEventId);
  const [credential, setCredential] = useState("");
  const [grantCode, setGrantCode] = useState("");
  const [hub, setHub] = useState<HubResponse["value"] | null>(null);
  const [healthUnavailable, setHealthUnavailable] = useState(false);
  const [selectedGameDayId, setSelectedGameDayId] = useState<string | null>(null);
  const [pitchManagerGameDayId, setPitchManagerGameDayId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lockedGameId, setLockedGameId] = useState("");
  const [lockedOperationId, setLockedOperationId] = useState("");
  const [lockedEndState, setLockedEndState] = useState(
    '{\n  "scoreByGameSide": {},\n  "winnerGameSideId": null,\n  "flagCatchingGameSideId": null,\n  "catchTimeMs": null,\n  "endTimeMs": null\n}',
  );
  const [lockedGamePreview, setLockedGamePreview] = useState<LockedGamePreview | null>(null);
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
  const [identityDrafts, setIdentityDrafts] = useState<Record<string, IdentityDraft>>({});
  const [presentationDrafts, setPresentationDrafts] = useState<Record<string, PresentationDraft>>(
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
  const [pitchManagerCode, setPitchManagerCode] = useState<GrantCodeProjection | null>(null);
  const [pitchManagerCodePlaintext, setPitchManagerCodePlaintext] = useState<string | null>(null);
  const [controlGrants, setControlGrants] = useState<Record<string, ControlGrantResponse["value"]>>(
    {},
  );
  const [controlQrDataUrls, setControlQrDataUrls] = useState<Record<string, string>>({});
  const [controlSessions, setControlSessions] = useState<Record<string, ControlSession[]>>({});
  const [controlCodes, setControlCodes] = useState<Record<string, GrantCodeProjection | null>>({});
  const [controlCodePlaintexts, setControlCodePlaintexts] = useState<Record<string, string>>({});
  const [pitchManagerQrCredential, setPitchManagerQrCredential] = useState<string | null>(null);
  const [controlQrCredentials, setControlQrCredentials] = useState<Record<string, string>>({});
  const [pitchManagerRotationCount, setPitchManagerRotationCount] = useState<number | null>(null);
  const [controlRotationCounts, setControlRotationCounts] = useState<Record<string, number>>({});
  const [secretWarning, setSecretWarning] = useState<string | null>(null);
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
  const [secretOwner] = useState(createGrantSecretOwner);
  const lockedGameRequestGeneration = useRef(0);
  const lockedGameRequestToken = useRef<LockedGameRequestToken | null>(null);

  const secretScopeKey = (
    nextEventId = eventId,
    nextGameDayId = selectedGameDayId,
    nextPitchId = selectedPitchId,
  ) => `event-admin:${nextEventId}:${nextGameDayId ?? "none"}:${nextPitchId || "none"}`;

  const hubScopeKey = () => `event-admin-hub:${eventId}`;

  const gameDayScopeKey = (nextEventId = eventId, nextGameDayId = selectedGameDayId) =>
    `event-admin-game-day:${nextEventId}:${nextGameDayId ?? "none"}`;

  const invalidateLockedGameRequest = () => {
    lockedGameRequestGeneration.current += 1;
    const current = lockedGameRequestToken.current;
    if (current !== null) secretOwner.invalidate(current.grantToken.scopeKey);
    lockedGameRequestToken.current = null;
    setLockedGamePreview(null);
  };

  const captureLockedGameRequest = (): LockedGameRequestToken | null => {
    const currentEventId = eventId.trim();
    if (currentEventId.length === 0 || selectedGameDayId === null) return null;
    const existing = lockedGameRequestToken.current;
    if (existing !== null && secretOwner.current(existing.grantToken)) return existing;
    const grantToken = secretOwner.capture(hubScopeKey());
    const next: LockedGameRequestToken = {
      eventId: currentEventId,
      gameDayId: selectedGameDayId,
      authority: (hub?.authority ?? "none") as LockedGameRequestToken["authority"],
      generation: lockedGameRequestGeneration.current,
      grantToken,
    };
    lockedGameRequestToken.current = next;
    return next;
  };

  const lockedGameRequestCurrent = (token: LockedGameRequestToken) =>
    token.generation === lockedGameRequestGeneration.current &&
    token.eventId === eventId.trim() &&
    token.gameDayId === selectedGameDayId &&
    token.authority === (hub?.authority ?? "none") &&
    secretOwner.current(token.grantToken);

  const clearGrantSecrets = () => {
    setCredential("");
    setGrantCode("");
    setPitchManagerQrDataUrl(null);
    setPitchManagerQrCredential(null);
    setPitchManagerCodePlaintext(null);
    setControlQrDataUrls({});
    setControlQrCredentials({});
    setControlCodePlaintexts({});
    setPitchManagerRotationCount(null);
    setControlRotationCounts({});
    setSecretWarning(null);
    setMessage(null);
  };

  const invalidateGrantSecrets = () => {
    invalidateLockedGameRequest();
    accessSheetOwner.invalidate();
    secretOwner.invalidate(secretScopeKey());
    secretOwner.invalidate(gameDayScopeKey());
    secretOwner.invalidate(hubScopeKey());
    clearGrantSecrets();
  };

  const changeEventId = (nextEventId: string) => {
    invalidateLockedGameRequest();
    invalidateGrantSecrets();
    setHub(null);
    setHealthUnavailable(false);
    setSelectedGameDayId(null);
    setPitchManagerGameDayId("");
    setTeamDrafts({});
    setPitchDrafts({});
    setConfirmationDrafts({});
    setIdentityDrafts({});
    setPresentationDrafts({});
    setSchedule(null);
    setDelayDrafts({});
    setCascadeDrafts({});
    setDelayPreviews({});
    setReassignmentTargets({});
    setReassignmentModes({});
    setSelectedPitchId("");
    setPitchView(null);
    setPitchManagerPitchId("");
    setPitchManagerGrant(null);
    setPitchManagerCode(null);
    setControlGrants({});
    setControlSessions({});
    setControlCodes({});
    setTeamName("");
    setTeamColor("#00afe8");
    setPitchName("");
    setRosterTeamId("");
    setPlayerNumber("");
    setPlayerName("");
    setSlotSequence("1");
    setScheduledStart("");
    setGameplaySlotId("");
    setPitchSlotId("");
    setGameCode("");
    setGameDesignation("");
    setSideASource("");
    setSideBSource("");
    setLockedGameId("");
    setLockedOperationId("");
    setPublicationImpactConfirmed(false);
    setEventId(nextEventId);
  };

  const clearControlGrantSecrets = (pitchSlotId: string) => {
    setControlQrDataUrls((current) => {
      const next = { ...current };
      delete next[pitchSlotId];
      return next;
    });
    setControlQrCredentials((current) => {
      const next = { ...current };
      delete next[pitchSlotId];
      return next;
    });
    setControlCodePlaintexts((current) => {
      const next = { ...current };
      delete next[pitchSlotId];
      return next;
    });
    setControlRotationCounts((current) => {
      const next = { ...current };
      delete next[pitchSlotId];
      return next;
    });
  };

  useEffect(
    () => () => {
      secretOwner.unmount();
      setCredential("");
      setGrantCode("");
      setPitchManagerQrDataUrl(null);
      setPitchManagerQrCredential(null);
      setPitchManagerCodePlaintext(null);
      setControlQrDataUrls({});
      setControlQrCredentials({});
      setControlCodePlaintexts({});
      setPitchManagerRotationCount(null);
      setControlRotationCounts({});
      setSecretWarning(null);
    },
    [secretOwner],
  );

  useEffect(() => {
    invalidateLockedGameRequest();
  }, [eventId, selectedGameDayId, hub?.authority]);

  const loadHub = async (nextGameDayId = selectedGameDayId, providedToken?: GrantSecretToken) => {
    accessSheetOwner.invalidate();
    if (eventId.trim().length === 0) return;
    const token = providedToken ?? secretOwner.capture(hubScopeKey());
    if (!secretOwner.current(token)) return;
    const params = new URLSearchParams({ eventId: eventId.trim() });
    if (nextGameDayId !== null) params.set("gameDayId", nextGameDayId);
    try {
      const response = await fetch(`/api/event-admin/hub?${params}`);
      const payload = (await response.json()) as
        | HubResponse
        | { status: "rejected" | "retryable-failure"; message?: string };
      if (!response.ok || payload.status !== "accepted")
        throw new Error("Unable to open the Event Hub.");
      const validHealth = isEventOperationsHealth(payload.value.health);
      if (!secretOwner.current(token)) return;
      secretOwner.commit(token, () => {
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
          Object.fromEntries(
            payload.value.event.pitches.map((pitch) => [pitch.pitchId, pitch.name]),
          ),
        );
        setHub(payload.value);
        setHealthUnavailable(!validHealth);
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
        setIdentityDrafts((current) =>
          Object.fromEntries(
            payload.value.event.eventGames.flatMap((game) =>
              [
                [game.eventGameId, game.sideA],
                [game.eventGameId, game.sideB],
              ].map(([, value]) => {
                const sideValue = value as typeof game.sideA;
                const key = `${game.eventGameId}:${sideValue.sideId}`;
                return [
                  key,
                  current[key] ?? {
                    eventTeamId: sideValue.eventTeamId ?? "",
                    confirmation: false,
                    reason: "",
                  },
                ];
              }),
            ),
          ),
        );
        setPresentationDrafts((current) =>
          Object.fromEntries(
            payload.value.event.eventGames.map((game) => [
              game.eventGameId,
              current[game.eventGameId] ?? {
                pitchOrientation: "side-a-left",
                sideAColor:
                  payload.value.event.teams.find(
                    (team) => team.eventTeamId === game.sideA.eventTeamId,
                  )?.defaultColor ?? "#112233",
                sideBColor:
                  payload.value.event.teams.find(
                    (team) => team.eventTeamId === game.sideB.eventTeamId,
                  )?.defaultColor ?? "#445566",
              },
            ]),
          ),
        );
      });
      return payload.value;
    } catch (error) {
      if (secretOwner.current(token)) throw error;
    }
  };

  const loadSchedule = async (gameDayId = selectedGameDayId, providedToken?: GrantSecretToken) => {
    if (eventId.trim().length === 0 || gameDayId === null) return;
    const token =
      providedToken ?? secretOwner.capture(secretScopeKey(eventId, gameDayId, selectedPitchId));
    if (!secretOwner.current(token)) return;
    try {
      const response = await fetch(
        `/api/event-admin/slot-setup?eventId=${encodeURIComponent(eventId)}&gameDayId=${encodeURIComponent(gameDayId)}`,
      );
      const payload = (await response.json()) as ScheduleResponse;
      if (!response.ok || payload.status !== "accepted")
        throw new Error("Unable to load Slot setup.");
      if (!secretOwner.current(token)) return;
      secretOwner.commit(token, () => setSchedule(payload.value));
    } catch (error) {
      if (secretOwner.current(token)) throw error;
    }
  };

  const loadPitchView = async (
    pitchId: string,
    gameDayId = selectedGameDayId,
    providedToken?: GrantSecretToken,
  ) => {
    if (gameDayId === null || pitchId.length === 0) return;
    const token = providedToken ?? secretOwner.capture(secretScopeKey(eventId, gameDayId, pitchId));
    if (!secretOwner.current(token)) return;
    try {
      const response = await fetch(
        `/api/event-admin/pitch-view?eventId=${encodeURIComponent(eventId)}&gameDayId=${encodeURIComponent(gameDayId)}&pitchId=${encodeURIComponent(pitchId)}`,
      );
      const payload = (await response.json()) as {
        status: string;
        value?: NonNullable<typeof pitchView>;
      };
      if (!response.ok || payload.status !== "accepted" || payload.value === undefined)
        throw new Error("Unable to load Pitch view.");
      if (!secretOwner.current(token)) return;
      secretOwner.commit(token, () => setPitchView(payload.value!));
    } catch (error) {
      if (secretOwner.current(token)) throw error;
    }
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
    invalidateGrantSecrets();
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
    if (base === undefined) return;
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
    if (selected === undefined) return;
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

  const controlCodeUrl = (pitchSlotId: string) => `${controlGrantUrl(pitchSlotId)}/code`;

  const inspectControlGrant = async (
    pitchSlotId: string,
    preserveSecrets = false,
    providedToken?: GrantSecretToken,
  ) => {
    let token = providedToken;
    if (!preserveSecrets) {
      invalidateGrantSecrets();
      clearControlGrantSecrets(pitchSlotId);
      token = secretOwner.capture(secretScopeKey());
    }
    token ??= secretOwner.capture(secretScopeKey());
    if (!secretOwner.current(token)) return null;
    try {
      const response = await fetch(controlGrantUrl(pitchSlotId));
      const payload = (await response.json()) as ControlGrantResponse;
      if (!response.ok || payload.status !== "accepted")
        throw new Error("Control Grant lookup failed.");
      if (!secretOwner.current(token)) return null;
      secretOwner.commit(token, () =>
        setControlGrants((current) => ({ ...current, [pitchSlotId]: payload.value })),
      );
      const codeResponse = await fetch(controlCodeUrl(pitchSlotId));
      const codePayload = (await codeResponse.json()) as {
        status: string;
        value?: GrantCodeProjection | null;
      };
      if (codeResponse.ok && codePayload.status === "accepted" && secretOwner.current(token)) {
        const projection = codePayload.value ?? null;
        secretOwner.commit(token, () => {
          setControlCodes((current) => ({ ...current, [pitchSlotId]: projection }));
          if (projection === null || projection.state !== "present")
            clearControlGrantSecrets(pitchSlotId);
        });
      }
      return payload.value;
    } catch (error) {
      if (secretOwner.current(token)) throw error;
      return null;
    }
  };

  const createControlGrant = async (pitchSlotId: string) => {
    invalidateGrantSecrets();
    const token = secretOwner.capture(secretScopeKey());
    const response = await fetch(controlGrantUrl(pitchSlotId), { method: "POST" });
    if (!response.ok) {
      if (secretOwner.current(token)) throw new Error("Control Grant creation failed.");
      return;
    }
    await inspectControlGrant(pitchSlotId, true, token);
  };

  const revealControlGrant = async (pitchSlotId: string) => {
    invalidateGrantSecrets();
    const token = secretOwner.capture(secretScopeKey());
    const response = await fetch(`${controlGrantUrl(pitchSlotId)}/reveal`, { method: "POST" });
    const payload = (await response.json()) as {
      status: string;
      value?: { qrCredential?: string };
    };
    if (
      !response.ok ||
      payload.status !== "accepted" ||
      payload.value?.qrCredential === undefined
    ) {
      if (secretOwner.current(token)) throw new Error("Control Grant QR reveal failed.");
      return;
    }
    try {
      const dataUrl = await qrRenderer(payload.value.qrCredential);
      secretOwner.commit(token, () =>
        setControlQrDataUrls((current) => ({ ...current, [pitchSlotId]: dataUrl })),
      );
    } catch (error) {
      if (secretOwner.current(token)) throw error;
    }
  };

  const loadControlSessions = async (pitchSlotId: string, providedToken?: GrantSecretToken) => {
    const token = providedToken ?? secretOwner.capture(secretScopeKey());
    if (!secretOwner.current(token)) return;
    try {
      const response = await fetch(`${controlGrantUrl(pitchSlotId)}/sessions`);
      const payload = (await response.json()) as { status: string; value?: ControlSession[] };
      if (!response.ok || payload.status !== "accepted") throw new Error("Session list failed.");
      secretOwner.commit(token, () =>
        setControlSessions((current) => ({ ...current, [pitchSlotId]: payload.value ?? [] })),
      );
    } catch (error) {
      if (secretOwner.current(token)) throw error;
    }
  };

  const rotateControlGrant = async (pitchSlotId: string) => {
    invalidateGrantSecrets();
    const token = secretOwner.capture(secretScopeKey());
    const response = await fetch(`${controlGrantUrl(pitchSlotId)}/rotate`, { method: "POST" });
    const payload = (await response.json()) as {
      status: string;
      value?: { affectedSessionCount?: number; qrCredential?: string; code?: string };
    };
    if (!response.ok || payload.status !== "accepted") {
      if (secretOwner.current(token)) throw new Error("Control Grant rotation failed.");
      return;
    }
    if (payload.value?.qrCredential === undefined || payload.value.code === undefined)
      throw new Error("Control Grant rotation did not return replacement credentials.");
    const { code, qrCredential, affectedSessionCount = 0 } = payload.value;
    if (
      !secretOwner.commit(token, () => {
        setControlQrCredentials((current) => ({ ...current, [pitchSlotId]: qrCredential }));
        setControlCodePlaintexts((current) => ({ ...current, [pitchSlotId]: code }));
        setControlRotationCounts((current) => ({
          ...current,
          [pitchSlotId]: affectedSessionCount,
        }));
        setMessage(
          `Control Grant fully rotated; ${affectedSessionCount} session(s) revoked. Dictate the new code and scan the new QR now.`,
        );
      })
    )
      return;
    await renderControlQr(pitchSlotId, qrCredential, token);
    if (!secretOwner.current(token)) return;
    const refreshWarnings: string[] = [];
    try {
      await inspectControlGrant(pitchSlotId, true, token);
    } catch {
      refreshWarnings.push("Control Grant state refresh failed.");
    }
    try {
      await loadControlSessions(pitchSlotId, token);
    } catch {
      refreshWarnings.push("Control session refresh failed.");
    }
    if (refreshWarnings.length > 0 && secretOwner.current(token))
      setSecretWarning(refreshWarnings.join(" ") + " Replacement credentials remain visible.");
  };

  const renderControlQr = async (
    pitchSlotId: string,
    credential = controlQrCredentials[pitchSlotId],
    providedToken?: GrantSecretToken,
  ) => {
    if (credential === undefined) return;
    const token = providedToken ?? secretOwner.capture(secretScopeKey());
    if (!secretOwner.current(token)) return;
    try {
      const dataUrl = await qrRenderer(credential);
      secretOwner.commit(token, () => {
        setControlQrDataUrls((current) => ({ ...current, [pitchSlotId]: dataUrl }));
        setControlQrCredentials((current) => {
          const next = { ...current };
          delete next[pitchSlotId];
          return next;
        });
        setSecretWarning((current) => (current?.includes("QR render failed") ? null : current));
      });
    } catch {
      if (secretOwner.current(token))
        setSecretWarning("Replacement QR render failed. Retry QR render locally.");
    }
  };

  const manageControlCode = async (
    pitchSlotId: string,
    operation: "create" | "replace" | "disable",
  ) => {
    invalidateGrantSecrets();
    const token = secretOwner.capture(secretScopeKey());
    const response = await fetch(
      `${controlCodeUrl(pitchSlotId)}${operation === "create" ? "" : `/${operation}`}`,
      { method: "POST" },
    );
    const payload = (await response.json()) as {
      status: string;
      value?: GrantCodeProjection & { code?: string };
    };
    if (!response.ok || payload.status !== "accepted") {
      if (secretOwner.current(token)) throw new Error("Grant Code operation failed.");
      return;
    }
    if (operation !== "disable" && payload.value?.code !== undefined)
      secretOwner.commit(token, () =>
        setControlCodePlaintexts((current) => ({
          ...current,
          [pitchSlotId]: payload.value!.code!,
        })),
      );
    const inspected = await fetch(controlCodeUrl(pitchSlotId));
    const inspectedPayload = (await inspected.json()) as {
      status: string;
      value?: GrantCodeProjection | null;
    };
    if (inspected.ok && inspectedPayload.status === "accepted" && secretOwner.current(token)) {
      const projection = inspectedPayload.value ?? null;
      secretOwner.commit(token, () => {
        setControlCodes((current) => ({ ...current, [pitchSlotId]: projection }));
        if (projection === null || projection.state !== "present")
          clearControlGrantSecrets(pitchSlotId);
      });
    }
  };

  const revokeControlSession = async (pitchSlotId: string, label: string) => {
    invalidateGrantSecrets();
    const token = secretOwner.capture(secretScopeKey());
    try {
      const response = await fetch(`${controlGrantUrl(pitchSlotId)}/sessions/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionReference: label }),
      });
      if (!response.ok) throw new Error("Control session revocation failed.");
      await loadControlSessions(pitchSlotId, token);
    } catch (error) {
      if (secretOwner.current(token)) throw error;
    }
  };

  const loadPitchManagerGrant = async (
    preserveSecrets = false,
    providedToken?: GrantSecretToken,
  ) => {
    if (pitchManagerGameDayId.length === 0 || pitchManagerPitchId.length === 0) return;
    const token = providedToken ?? secretOwner.capture(secretScopeKey());
    if (!secretOwner.current(token)) return;
    const response = await fetch(
      `/api/event-admin/events/${eventId}/game-days/${pitchManagerGameDayId}/pitches/${pitchManagerPitchId}/pitch-manager-grant`,
    );
    const payload = (await response.json()) as PitchManagerGrantResponse | { status: string };
    if (!response.ok || payload.status !== "accepted") {
      if (secretOwner.current(token)) throw new Error("Grant lookup failed.");
      return;
    }
    if (!secretOwner.current(token)) return;
    secretOwner.commit(token, () =>
      setPitchManagerGrant((payload as PitchManagerGrantResponse).value ?? null),
    );
    if (!preserveSecrets) secretOwner.commit(token, () => setPitchManagerQrDataUrl(null));
    if (
      !preserveSecrets &&
      ((payload as PitchManagerGrantResponse).value === null ||
        (payload as PitchManagerGrantResponse).value?.status !== "active")
    ) {
      secretOwner.commit(token, () => {
        setPitchManagerCode(null);
        setPitchManagerCodePlaintext(null);
        setPitchManagerQrCredential(null);
        setPitchManagerRotationCount(null);
      });
      return;
    }
    const codeResponse = await fetch(
      `/api/event-admin/events/${eventId}/game-days/${pitchManagerGameDayId}/pitches/${pitchManagerPitchId}/pitch-manager-grant/code`,
    );
    const codePayload = (await codeResponse.json()) as {
      status: string;
      value?: GrantCodeProjection | null;
    };
    if (!codeResponse.ok || codePayload.status !== "accepted") {
      if (secretOwner.current(token)) throw new Error("Grant Code lookup failed.");
      return;
    }
    if (!secretOwner.current(token)) return;
    secretOwner.commit(token, () => setPitchManagerCode(codePayload.value ?? null));
    if (
      !preserveSecrets &&
      (codePayload.value === null || codePayload.value?.state !== "present")
    ) {
      secretOwner.commit(token, () => {
        setPitchManagerCodePlaintext(null);
        setPitchManagerQrCredential(null);
        setPitchManagerRotationCount(null);
      });
    }
  };

  const managePitchManagerCode = async (operation: "create" | "replace" | "disable") => {
    invalidateGrantSecrets();
    const token = secretOwner.capture(secretScopeKey());
    const response = await fetch(
      `/api/event-admin/events/${eventId}/game-days/${pitchManagerGameDayId}/pitches/${pitchManagerPitchId}/pitch-manager-grant/code${operation === "create" ? "" : `/${operation}`}`,
      { method: "POST" },
    );
    const payload = (await response.json()) as {
      status: string;
      value?: GrantCodeProjection & { code?: string };
    };
    if (!response.ok || payload.status !== "accepted") {
      if (secretOwner.current(token)) throw new Error("Grant Code operation failed.");
      return;
    }
    if (operation !== "disable" && payload.value?.code !== undefined)
      secretOwner.commit(token, () => setPitchManagerCodePlaintext(payload.value!.code!));
    if (!secretOwner.current(token)) return;
    await loadPitchManagerGrant(operation !== "disable", token);
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

  const setHeatStoppageConfiguration = async (configuration: "enabled" | "disabled") => {
    const gameDayId = selectedGameDayId;
    if (gameDayId === null) return;
    const token = secretOwner.capture(gameDayScopeKey(eventId, gameDayId));
    try {
      const response = await fetch(
        `/api/event-admin/events/${encodeURIComponent(eventId)}/game-days/${encodeURIComponent(gameDayId)}/heat-stoppage-configuration`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ configuration }),
        },
      );
      const payload = (await response.json()) as {
        status: "accepted" | "rejected" | "retryable-failure";
        detail?: string;
      };
      if (!response.ok || payload.status !== "accepted")
        throw new Error(payload.detail ?? "Heat Stoppage Configuration update failed.");
      if (
        !secretOwner.commit(token, () =>
          setMessage(
            `Heat Stoppage Configuration ${configuration === "enabled" ? "enabled" : "disabled"}.`,
          ),
        )
      )
        return;
      await loadHub(gameDayId, token);
    } catch (error) {
      if (secretOwner.current(token)) throw error;
    }
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
    invalidateGrantSecrets();
    const token = secretOwner.capture(secretScopeKey());
    const response = await fetch(
      `/api/event-admin/events/${eventId}/game-days/${pitchManagerGameDayId}/pitches/${pitchManagerPitchId}/pitch-manager-grant/${operation}`,
      { method: "POST" },
    );
    const payload = (await response.json()) as {
      status: string;
      value?: { qrCredential?: string; code?: string; affectedSessionCount?: number };
    };
    if (!response.ok || payload.status !== "accepted") {
      if (secretOwner.current(token))
        throw new Error("Pitch Manager Grant lifecycle change failed.");
      return;
    }
    if (operation === "rotate") {
      if (payload.value?.qrCredential === undefined || payload.value.code === undefined)
        throw new Error("Pitch Manager rotation did not return replacement credentials.");
      const { code, qrCredential, affectedSessionCount = 0 } = payload.value;
      if (
        !secretOwner.commit(token, () => {
          setPitchManagerQrCredential(qrCredential);
          setPitchManagerCodePlaintext(code);
          setPitchManagerRotationCount(affectedSessionCount);
          setMessage(
            `Pitch Manager Grant fully rotated; ${affectedSessionCount} session(s) revoked. Dictate the new code and scan the new QR now.`,
          );
        })
      )
        return;
      await renderPitchManagerQr(qrCredential, token);
      if (!secretOwner.current(token)) return;
      try {
        await loadPitchManagerGrant(true, token);
      } catch {
        if (secretOwner.current(token))
          setSecretWarning(
            "Pitch Manager Grant state refresh failed. Replacement credentials remain visible.",
          );
      }
      return;
    }
    await loadPitchManagerGrant(false, token);
  };

  const renderPitchManagerQr = async (
    credential = pitchManagerQrCredential,
    providedToken?: GrantSecretToken,
  ) => {
    if (credential === null || credential === undefined) return;
    const token = providedToken ?? secretOwner.capture(secretScopeKey());
    if (!secretOwner.current(token)) return;
    try {
      const dataUrl = await qrRenderer(credential);
      secretOwner.commit(token, () => {
        setPitchManagerQrDataUrl(dataUrl);
        setPitchManagerQrCredential(null);
        setSecretWarning((current) => (current?.includes("QR render failed") ? null : current));
      });
    } catch {
      if (secretOwner.current(token))
        setSecretWarning("Replacement QR render failed. Retry QR render locally.");
    }
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
    const token = secretOwner.capture(secretScopeKey());
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
    await loadSchedule(selectedGameDayId, token);
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
    const token = secretOwner.capture(secretScopeKey());
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
    await loadSchedule(selectedGameDayId, token);
    if (selectedPitchId.length > 0) await loadPitchView(selectedPitchId, selectedGameDayId, token);
    setDelayPreviews((current) => {
      const next = { ...current };
      delete next[slotId];
      return next;
    });
  };

  const reassignEventGame = async (eventGameId: string) => {
    if (selectedGameDayId === null) return;
    const token = secretOwner.capture(secretScopeKey());
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
    await loadSchedule(selectedGameDayId, token);
    if (selectedPitchId.length > 0) await loadPitchView(selectedPitchId, selectedGameDayId, token);
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

  const correctEventGameIdentity = async (
    game: HubResponse["value"]["event"]["eventGames"][number],
    side: "sideA" | "sideB",
    token: GrantSecretToken,
  ) => {
    if (selectedGameDayId === null) return;
    if (!secretOwner.current(token)) return;
    const sideValue = game[side];
    const key = `${game.eventGameId}:${sideValue.sideId}`;
    const draft = identityDrafts[key] ?? {
      eventTeamId: sideValue.eventTeamId ?? "",
      confirmation: false,
      reason: "",
    };
    const response = await fetch(
      `/api/event-admin/events/${eventId}/game-days/${selectedGameDayId}/event-games/${game.eventGameId}/identity`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          gameSideId: sideValue.sideId,
          eventTeamId: draft.eventTeamId,
          confirmation: draft.confirmation,
          reason: draft.reason.trim() || undefined,
        }),
      },
    );
    if (!secretOwner.current(token)) return;
    if (!response.ok) {
      const detail = await responseError(response, "Event Team correction failed.");
      if (secretOwner.current(token)) throw new Error(detail);
      return;
    }
    await loadHub(selectedGameDayId, token);
  };

  const changeEventGamePresentation = async (
    eventGameId: string,
    change:
      | { type: "pitch-orientation"; pitchOrientation: "side-a-left" | "side-b-left" }
      | {
          type: "displayed-team-color";
          gameSideId: string;
          color: string;
        },
    token: GrantSecretToken,
  ) => {
    if (!secretOwner.current(token)) return;
    const response = await fetch(
      `/api/event-admin/events/${eventId}/event-games/${eventGameId}/presentation`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          presentationChangeId: crypto.randomUUID(),
          change,
        }),
      },
    );
    if (!secretOwner.current(token)) return;
    if (!response.ok) {
      const detail = await responseError(response, "Game Presentation Change failed.");
      if (secretOwner.current(token)) throw new Error(detail);
      return;
    }
    await loadHub(selectedGameDayId, token);
  };

  const previewLockedGame = async (operation: LockedGamePreview["operation"]) => {
    if (lockedGameId.trim().length === 0) throw new Error("Choose an Event Game.");
    if (lockedOperationId.trim().length === 0) throw new Error("Enter an operation ID.");
    if (selectedGameDayId === null) throw new Error("Choose a Game Day.");
    let endState: unknown = undefined;
    if (operation === "locked-game-correction") {
      try {
        endState = JSON.parse(lockedEndState);
      } catch {
        throw new Error("End state must be valid JSON.");
      }
    }
    const token = captureLockedGameRequest();
    if (token === null) return;
    try {
      const previewPath =
        operation === "locked-game-correction" ? "locked-correction/preview" : "reopen/preview";
      const response = await fetch(
        `/api/event-admin/events/${token.eventId}/game-days/${token.gameDayId}/event-games/${lockedGameId}/${previewPath}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            operationId: lockedOperationId,
            ...(operation === "locked-game-correction" ? { endState } : {}),
          }),
        },
      );
      const payload = (await response.json()) as {
        status?: string;
        value?: LockedGamePreview;
        detail?: string;
        message?: string;
      };
      if (!lockedGameRequestCurrent(token)) return;
      if (!response.ok || payload.status !== "accepted" || payload.value === undefined)
        throw new Error(payload.detail ?? payload.message ?? "Locked Game preview failed.");
      setLockedGamePreview(payload.value);
    } catch (error) {
      if (lockedGameRequestCurrent(token)) throw error;
    }
  };

  const correctLockedGame = async (overrideConfirmed: boolean) => {
    if (lockedGamePreview?.operation !== "locked-game-correction")
      throw new Error("Preview the Locked Game Correction before confirming it.");
    if (lockedGameId.trim().length === 0) throw new Error("Choose an Event Game.");
    if (lockedOperationId.trim().length === 0) throw new Error("Enter an operation ID.");
    let endState: unknown;
    try {
      endState = JSON.parse(lockedEndState);
    } catch {
      throw new Error("End state must be valid JSON.");
    }
    const token = captureLockedGameRequest();
    if (token === null) return;
    try {
      const response = await fetch(
        `/api/event-admin/events/${token.eventId}/game-days/${token.gameDayId}/event-games/${lockedGameId}/locked-correction`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            operationId: lockedOperationId,
            endState,
            overrideConfirmed,
            previewFingerprint: lockedGamePreview.fingerprint,
          }),
        },
      );
      const payload = (await response.json()) as {
        status?: string;
        detail?: string;
        message?: string;
      };
      if (!lockedGameRequestCurrent(token)) return;
      if (!response.ok || payload.status !== "accepted")
        throw new Error(payload.detail ?? payload.message ?? "Locked Game correction failed.");
      if (!lockedGameRequestCurrent(token)) return;
      await loadHub(token.gameDayId, token.grantToken);
      if (!lockedGameRequestCurrent(token)) return;
      setLockedGamePreview(null);
    } catch (error) {
      if (lockedGameRequestCurrent(token)) throw error;
    }
  };

  const reopenLockedGame = async () => {
    if (lockedGamePreview?.operation !== "game-reopening")
      throw new Error("Preview Game Reopening before confirming it.");
    if (lockedGameId.trim().length === 0) throw new Error("Choose an Event Game.");
    if (lockedOperationId.trim().length === 0) throw new Error("Enter an operation ID.");
    if (selectedGameDayId === null) throw new Error("Choose a Game Day.");
    const token = captureLockedGameRequest();
    if (token === null) return;
    try {
      const response = await fetch(
        `/api/event-admin/events/${token.eventId}/game-days/${token.gameDayId}/event-games/${lockedGameId}/reopen`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            operationId: lockedOperationId,
            previewFingerprint: lockedGamePreview.fingerprint,
          }),
        },
      );
      const payload = (await response.json()) as {
        status?: string;
        detail?: string;
        message?: string;
      };
      if (!lockedGameRequestCurrent(token)) return;
      if (!response.ok || payload.status !== "accepted")
        throw new Error(payload.detail ?? payload.message ?? "Game Reopening failed.");
      if (!lockedGameRequestCurrent(token)) return;
      await loadHub(token.gameDayId, token.grantToken);
      if (!lockedGameRequestCurrent(token)) return;
      setLockedGamePreview(null);
    } catch (error) {
      if (lockedGameRequestCurrent(token)) throw error;
    }
  };

  useEffect(() => {
    if (eventId.length > 0) void loadHub().catch(() => undefined);
  }, []);

  const run = async (action: () => Promise<void>, ownerToken?: GrantSecretToken) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      if (ownerToken !== undefined && !secretOwner.current(ownerToken)) return;
      setMessage(
        error instanceof EventPublicationValidationError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Unable to authorize the Event Hub.",
      );
    } finally {
      if (ownerToken === undefined || secretOwner.current(ownerToken)) setBusy(false);
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
              onInput={(event) => changeEventId(event.currentTarget.value)}
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
                  onInput={(event) => setCredential(event.currentTarget.value)}
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">
                  Use a trusted QR scanner and submit its value here.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="event-admin-grant-code">Radio Grant Code</Label>
                <Input
                  id="event-admin-grant-code"
                  type="password"
                  value={grantCode}
                  onChange={(event) => setGrantCode(event.target.value)}
                  onInput={(event) => setGrantCode(event.currentTarget.value)}
                  autoComplete="off"
                  placeholder="two words and three digits"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={
                    busy ||
                    eventId.trim().length === 0 ||
                    (credential.length === 0 && grantCode.length === 0) ||
                    (credential.length > 0 && grantCode.length > 0)
                  }
                  onClick={() =>
                    void run(async () => {
                      const body =
                        grantCode.length > 0 ? { grantCode } : { qrCredential: credential };
                      invalidateGrantSecrets();
                      const token = secretOwner.capture(hubScopeKey());
                      try {
                        const response = await fetch("/api/event-admin/admit", {
                          method: "POST",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify(body),
                        });
                        const payload = (await response.json()) as { status?: string };
                        if (!response.ok || payload.status !== "admitted")
                          throw new Error("Admission failed.");
                        if (!secretOwner.current(token)) return;
                        await loadHub(null, token);
                      } catch (error) {
                        if (secretOwner.current(token)) throw error;
                      }
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
              <AdministrativeAuditBrowser eventId={hub.event.eventId} route="event-admin" />
              <section
                aria-labelledby="operations-health-title"
                className="space-y-2 rounded-lg border p-3"
              >
                <h2 className="font-semibold" id="operations-health-title">
                  Operations health
                </h2>
                <p className="text-sm text-muted-foreground">
                  Resolve these signals before handing a Game Day to operators. Counts are
                  allowlisted summaries; Grant credentials and audit details stay private.
                </p>
                {healthUnavailable ? (
                  <p role="status" aria-live="polite">
                    Operations health unavailable. No readiness counts are shown.
                  </p>
                ) : (
                  <ul className="grid gap-1 text-sm sm:grid-cols-2" aria-live="polite">
                    <li>Unresolved team assignments: {hub.health.unresolvedTeamCount}</li>
                    <li>Schedule conflicts: {hub.health.scheduleConflictCount}</li>
                    <li>Team schedule conflicts: {hub.health.teamScheduleConflictCount}</li>
                    <li>Grant problems: {hub.health.grantProblemCount}</li>
                  </ul>
                )}
              </section>
              <div className="space-y-3 rounded-lg border p-3">
                <div>
                  <p className="font-semibold">Locked Event Game administration</p>
                  <p className="text-xs text-muted-foreground">
                    Correct settled facts while retaining the lock, or reopen the game for fresh
                    control admission. One confirmation is required when the end state is
                    inconsistent with ordinary scoring rules.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="locked-game-id">Event Game</Label>
                  <select
                    id="locked-game-id"
                    className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
                    value={lockedGameId}
                    onChange={(event) => {
                      setLockedGameId(event.currentTarget.value);
                      setLockedGamePreview(null);
                    }}
                  >
                    <option value="">Choose an Event Game</option>
                    {hub.event.eventGames.map((game) => (
                      <option key={game.eventGameId} value={game.eventGameId}>
                        {game.gameDesignation ?? game.gameCode ?? game.eventGameId}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="locked-operation-id">Operation ID</Label>
                  <Input
                    id="locked-operation-id"
                    value={lockedOperationId}
                    onChange={(event) => {
                      setLockedOperationId(event.currentTarget.value);
                      setLockedGamePreview(null);
                    }}
                    onInput={(event) => {
                      setLockedOperationId(event.currentTarget.value);
                      setLockedGamePreview(null);
                    }}
                    placeholder="unique correction or reopening ID"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="locked-end-state">Corrected end state (JSON)</Label>
                  <textarea
                    id="locked-end-state"
                    className="border-input bg-background min-h-36 w-full rounded-md border p-3 font-mono text-xs"
                    value={lockedEndState}
                    onChange={(event) => {
                      setLockedEndState(event.currentTarget.value);
                      setLockedGamePreview(null);
                    }}
                    onInput={(event) => {
                      setLockedEndState(event.currentTarget.value);
                      setLockedGamePreview(null);
                    }}
                  />
                </div>
                {lockedGamePreview !== null ? (
                  <div className="space-y-1 rounded-md bg-muted p-3 text-xs">
                    <p className="font-semibold">
                      Preview ready ·{" "}
                      {lockedGamePreview.operation === "game-reopening" ? "reopen" : "correction"}
                    </p>
                    <p>
                      Facts: {lockedGamePreview.impact.facts}; lifecycle:{" "}
                      {lockedGamePreview.impact.lifecycle.from} →{" "}
                      {lockedGamePreview.impact.lifecycle.to}; lock:{" "}
                      {lockedGamePreview.impact.lifecycle.lock}.
                    </p>
                    <p>
                      Timer: {lockedGamePreview.impact.timer}; terminated sessions:{" "}
                      {lockedGamePreview.impact.sessions.count}; queued discard evidence:{" "}
                      {lockedGamePreview.impact.queuedDiscard.count}.
                    </p>
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => previewLockedGame("locked-game-correction"))}
                  >
                    Preview Locked Game Correction
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || lockedGamePreview?.operation !== "locked-game-correction"}
                    onClick={() => void run(() => correctLockedGame(true))}
                  >
                    Confirm Official Override
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || lockedGamePreview?.operation !== "locked-game-correction"}
                    onClick={() => void run(() => correctLockedGame(false))}
                  >
                    Confirm Locked Game Correction
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void run(() => previewLockedGame("game-reopening"))}
                  >
                    Preview Game Reopening
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || lockedGamePreview?.operation !== "game-reopening"}
                    onClick={() => void run(reopenLockedGame)}
                  >
                    Confirm Game Reopening
                  </Button>
                </div>
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
                    invalidateLockedGameRequest();
                    invalidateGrantSecrets();
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
              {selectedGameDayId !== null ? (
                <div className="space-y-3 rounded-lg border p-3">
                  <div>
                    <p className="font-semibold">Heat Stoppage Configuration</p>
                    <p className="text-sm text-muted-foreground">
                      New and uncommenced Event Games follow this Game Day setting. Commenced Games
                      keep their effective mode.
                    </p>
                  </div>
                  {(() => {
                    const selectedDay = hub.event.gameDays.find(
                      (day) => day.gameDayId === selectedGameDayId,
                    );
                    if (selectedDay === undefined) return null;
                    return (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm" role="status">
                          Currently {selectedDay.heatStoppageConfiguration}
                        </span>
                        {(["enabled", "disabled"] as const).map((configuration) => (
                          <Button
                            key={configuration}
                            disabled={
                              busy || selectedDay.heatStoppageConfiguration === configuration
                            }
                            onClick={() =>
                              void run(() => setHeatStoppageConfiguration(configuration))
                            }
                            variant={configuration === "enabled" ? "default" : "outline"}
                          >
                            {configuration === "enabled" ? "Enable" : "Disable"}
                          </Button>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              ) : null}
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
                    className="min-h-10"
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
                    className="min-h-10"
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
                                    <div className="mt-2 space-y-2 border-t pt-2">
                                      {(["sideA", "sideB"] as const).map((side) => {
                                        const sideValue = game[side];
                                        const key = `${game.eventGameId}:${sideValue.sideId}`;
                                        const identity = identityDrafts[key] ?? {
                                          eventTeamId: sideValue.eventTeamId ?? "",
                                          confirmation: false,
                                          reason: "",
                                        };
                                        return (
                                          <div
                                            className="grid gap-1 sm:grid-cols-[auto_1fr_auto]"
                                            key={sideValue.sideId}
                                          >
                                            <span className="text-xs text-muted-foreground">
                                              {side === "sideA" ? "Side A" : "Side B"} ·{" "}
                                              {sideValue.sideId}
                                            </span>
                                            <select
                                              aria-label={`Correct ${game.eventGameId} ${side} Event Team`}
                                              className="h-9 rounded-md border bg-background px-2 text-sm"
                                              value={identity.eventTeamId}
                                              onChange={(event) =>
                                                setIdentityDrafts((current) => ({
                                                  ...current,
                                                  [key]: {
                                                    ...identity,
                                                    eventTeamId: event.target.value,
                                                  },
                                                }))
                                              }
                                            >
                                              <option value="">Corrected Event Team</option>
                                              {hub.event.teams.map((team) => (
                                                <option
                                                  key={team.eventTeamId}
                                                  value={team.eventTeamId}
                                                >
                                                  {team.name}
                                                </option>
                                              ))}
                                            </select>
                                            <Button
                                              variant="outline"
                                              disabled={busy || identity.eventTeamId.length === 0}
                                              onClick={() => {
                                                const token = secretOwner.capture(secretScopeKey());
                                                void run(
                                                  () => correctEventGameIdentity(game, side, token),
                                                  token,
                                                );
                                              }}
                                            >
                                              Correct identity
                                            </Button>
                                            <label className="flex items-center gap-2 text-xs sm:col-start-2">
                                              <input
                                                type="checkbox"
                                                checked={identity.confirmation}
                                                onChange={(event) =>
                                                  setIdentityDrafts((current) => ({
                                                    ...current,
                                                    [key]: {
                                                      ...identity,
                                                      confirmation: event.target.checked,
                                                    },
                                                  }))
                                                }
                                              />
                                              Confirm if Game has commenced
                                            </label>
                                            <Input
                                              aria-label={`${game.eventGameId} ${side} correction reason`}
                                              placeholder="Reason when commenced"
                                              value={identity.reason}
                                              onChange={(event) =>
                                                setIdentityDrafts((current) => ({
                                                  ...current,
                                                  [key]: {
                                                    ...identity,
                                                    reason: event.target.value,
                                                  },
                                                }))
                                              }
                                            />
                                          </div>
                                        );
                                      })}
                                      {(() => {
                                        const presentation = presentationDrafts[
                                          game.eventGameId
                                        ] ?? {
                                          pitchOrientation: "side-a-left" as const,
                                          sideAColor: "#112233",
                                          sideBColor: "#445566",
                                        };
                                        return (
                                          <div className="grid gap-2 border-t pt-2 text-xs sm:grid-cols-3">
                                            <select
                                              aria-label={`${game.eventGameId} pitch orientation`}
                                              className="h-9 rounded-md border bg-background px-2 text-sm"
                                              value={presentation.pitchOrientation}
                                              onChange={(event) => {
                                                const pitchOrientation = event.target
                                                  .value as PresentationDraft["pitchOrientation"];
                                                setPresentationDrafts((current) => ({
                                                  ...current,
                                                  [game.eventGameId]: {
                                                    ...presentation,
                                                    pitchOrientation,
                                                  },
                                                }));
                                                const token = secretOwner.capture(secretScopeKey());
                                                void run(
                                                  () =>
                                                    changeEventGamePresentation(
                                                      game.eventGameId,
                                                      {
                                                        type: "pitch-orientation",
                                                        pitchOrientation,
                                                      },
                                                      token,
                                                    ),
                                                  token,
                                                );
                                              }}
                                            >
                                              <option value="side-a-left">Side A left</option>
                                              <option value="side-b-left">Side B left</option>
                                            </select>
                                            {(["sideA", "sideB"] as const).map((side) => {
                                              const colorKey =
                                                side === "sideA" ? "sideAColor" : "sideBColor";
                                              const color = presentation[colorKey];
                                              return (
                                                <label
                                                  className="flex items-center gap-2"
                                                  key={side}
                                                >
                                                  {side === "sideA" ? "Side A" : "Side B"} color
                                                  <input
                                                    type="color"
                                                    aria-label={`${game.eventGameId} ${side} displayed color`}
                                                    value={color}
                                                    onInput={(event) => {
                                                      const nextColor = (
                                                        event.target as HTMLInputElement
                                                      ).value;
                                                      setPresentationDrafts((current) => ({
                                                        ...current,
                                                        [game.eventGameId]: {
                                                          ...presentation,
                                                          [colorKey]: nextColor,
                                                        },
                                                      }));
                                                    }}
                                                  />
                                                  <Button
                                                    variant="outline"
                                                    size="sm"
                                                    disabled={busy}
                                                    onClick={() => {
                                                      const token =
                                                        secretOwner.capture(secretScopeKey());
                                                      void run(
                                                        () =>
                                                          changeEventGamePresentation(
                                                            game.eventGameId,
                                                            {
                                                              type: "displayed-team-color",
                                                              gameSideId: game[side].sideId,
                                                              color,
                                                            },
                                                            token,
                                                          ),
                                                        token,
                                                      );
                                                    }}
                                                  >
                                                    Apply
                                                  </Button>
                                                </label>
                                              );
                                            })}
                                          </div>
                                        );
                                      })()}
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
                        invalidateGrantSecrets();
                        const token = secretOwner.capture(
                          secretScopeKey(eventId, selectedGameDayId, pitch.pitchId),
                        );
                        setSelectedPitchId(pitch.pitchId);
                        void run(() => loadPitchView(pitch.pitchId, selectedGameDayId, token));
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
                                  void run(async () => {
                                    await inspectControlGrant(slot.pitchSlotId);
                                  })
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
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      void run(() => manageControlCode(slot.pitchSlotId, "create"))
                                    }
                                  >
                                    Create Radio Code
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={controlCodes[slot.pitchSlotId]?.state !== "present"}
                                    onClick={() =>
                                      void run(() => manageControlCode(slot.pitchSlotId, "replace"))
                                    }
                                  >
                                    Replace Code
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={controlCodes[slot.pitchSlotId]?.state !== "present"}
                                    onClick={() =>
                                      void run(() => manageControlCode(slot.pitchSlotId, "disable"))
                                    }
                                  >
                                    Disable Code
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
                            {controlGrant ? (
                              <p className="text-xs text-muted-foreground">
                                Radio code: {controlCodes[slot.pitchSlotId]?.state ?? "absent"}
                              </p>
                            ) : null}
                            {controlRotationCounts[slot.pitchSlotId] !== undefined ? (
                              <p className="text-xs text-muted-foreground">
                                Full rotation affected {controlRotationCounts[slot.pitchSlotId]}{" "}
                                session(s).
                              </p>
                            ) : null}
                            {controlCodePlaintexts[slot.pitchSlotId] ? (
                              <div className="flex items-center gap-2 rounded bg-muted p-2">
                                <p aria-live="polite" className="font-mono text-sm">
                                  Dictate now: {controlCodePlaintexts[slot.pitchSlotId]}
                                </p>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    setControlCodePlaintexts((current) => {
                                      const next = { ...current };
                                      delete next[slot.pitchSlotId];
                                      return next;
                                    })
                                  }
                                >
                                  Clear
                                </Button>
                              </div>
                            ) : null}
                            {controlQrDataUrls[slot.pitchSlotId] ? (
                              <img
                                alt={`Control Grant QR for Pitch Slot ${slot.sequence}`}
                                className="h-40 w-40 rounded border bg-white p-2"
                                src={controlQrDataUrls[slot.pitchSlotId]}
                              />
                            ) : null}
                            {controlQrCredentials[slot.pitchSlotId] ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void renderControlQr(slot.pitchSlotId)}
                              >
                                Retry QR render
                              </Button>
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
                      invalidateGrantSecrets();
                      setPitchManagerGameDayId(event.target.value);
                      setPitchManagerGrant(null);
                      setPitchManagerQrDataUrl(null);
                      setPitchManagerCode(null);
                      setPitchManagerCodePlaintext(null);
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
                      invalidateGrantSecrets();
                      setPitchManagerPitchId(event.target.value);
                      setPitchManagerGrant(null);
                      setPitchManagerQrDataUrl(null);
                      setPitchManagerCode(null);
                      setPitchManagerCodePlaintext(null);
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
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || pitchManagerGrant?.status !== "active"}
                    onClick={() => void run(() => managePitchManagerCode("create"))}
                  >
                    Create Radio Code
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || pitchManagerCode?.state !== "present"}
                    onClick={() => void run(() => managePitchManagerCode("replace"))}
                  >
                    Replace Code
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || pitchManagerCode?.state !== "present"}
                    onClick={() => void run(() => managePitchManagerCode("disable"))}
                  >
                    Disable Code
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
                {pitchManagerGrant ? (
                  <p className="text-xs text-muted-foreground">
                    Radio code: {pitchManagerCode?.state ?? "absent"}
                  </p>
                ) : null}
                {pitchManagerRotationCount !== null ? (
                  <p className="text-xs text-muted-foreground">
                    Full rotation affected {pitchManagerRotationCount} session(s).
                  </p>
                ) : null}
                {pitchManagerCodePlaintext ? (
                  <div className="flex items-center gap-2 rounded bg-muted p-2">
                    <p aria-live="polite" className="font-mono text-sm">
                      Dictate now: {pitchManagerCodePlaintext}
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setPitchManagerCodePlaintext(null)}
                    >
                      Clear
                    </Button>
                  </div>
                ) : null}
                {pitchManagerQrDataUrl ? (
                  <img
                    alt="Pitch Manager Grant QR code"
                    className="h-48 w-48 rounded border bg-white p-2"
                    src={pitchManagerQrDataUrl}
                  />
                ) : null}
                {pitchManagerQrCredential ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void renderPitchManagerQr()}
                  >
                    Retry QR render
                  </Button>
                ) : null}
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  invalidateGrantSecrets();
                  setHub(null);
                }}
              >
                Change authority
              </Button>
            </div>
          )}
          {secretWarning ? <p className="text-sm text-destructive">{secretWarning}</p> : null}
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
