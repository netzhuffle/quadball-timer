import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createInitialClockBaseline,
  projectClockBaseline,
  projectClockSample,
  SEEKER_RELEASE_MS,
} from "@/lib/clock-authority";
import type {
  ControllerProjection,
  LiveEventGameControlResult,
  LiveEventControllerIntent,
  LiveHeatAction,
} from "@/lib/live-event-game-control";
import {
  LIVE_EVENT_CONTROL_INTENT_VERSION,
  projectLiveHeatState,
} from "@/lib/live-event-game-control";
import {
  CLOSE_PLAY_ADJUDICATION_WINDOW_MS,
  LIVE_SUSPENSION_SNAPSHOT_VERSION,
  suspensionPenaltyStateFromProjection,
} from "@/lib/live-event-game-control";
import {
  deriveLivePenaltyProjection,
  type LiveCardType,
  type LivePenaltyProjection,
  type LivePenaltyReason,
} from "@/lib/live-event-penalties";
import { validateGameClockMs } from "@/lib/validation-policy";
import type { ActionJsonValue, OfficialOverrideMetadata } from "@/lib/event-game-actions";
import { readControllerDeviceContext } from "@/lib/controller-device-context";
import {
  acknowledgeControllerProjection,
  controllerReplicaStorageKey,
  createControllerReplica,
  dispatchControllerClockAction,
  dispatchControllerAction,
  invalidateControllerReplica,
  loadControllerReplica,
  prepareControllerReplayBatch,
  persistControllerReplica,
  rebindControllerReplica,
  reconcileControllerReplay,
  type ControllerReplicaLoad,
  type ControllerReplicaState,
  type ControllerReplayBatchResponse,
  type ControllerReplicaStorage,
} from "@/lib/controller-reconnect";

type PersistedControllerSession = { sessionBearer: string; eventGameId: string };
type ControllerOpenResponse = {
  status: "opened";
  eventGameId: string;
  session: { sessionBearer: string; grantSessionId: string; grantVersion: string };
  projection: ControllerProjection | null;
  projectionStatus: "available" | "unavailable";
};
type ControllerRefreshResponse =
  | {
      status: "authorized";
      session: { eventGameId: string; grantSessionId: string; grantVersion: string };
      projection: ControllerProjection | null;
      projectionStatus: "available" | "unavailable";
    }
  | { status: "switch-required"; previousEventGameId: string; currentEventGameId: string }
  | { status: "rejected"; message: string };

type ReplayAuthority = {
  ownerKey: string;
  bearer: string;
  bearerGeneration: number;
  eventGameId: string;
  replicaGeneration: string;
  grantSessionId: string;
  grantVersion: string;
};

type ReplayRequest = { state: ControllerReplicaState; authority: ReplayAuthority };

type ActiveReplay = ReplayRequest & { requestToken: symbol };

type PossessionSelection = Record<string, string | null>;

type PendingClosePlayAdjudication = {
  intentType: "record-goal" | "record-flag-catch";
  gameSideId: string;
  gameTimeMs: number;
  flagCatchBoundaryRunning: boolean | null;
  relatedFacts: readonly {
    factType: "goal" | "flag-catch";
    factId: string;
    gameTimeMs: number;
  }[];
};

type PendingFlagCatchBoundaryOverride = {
  gameSideId: string;
  gameTimeMs: number;
  running: boolean;
  sportingOrderAdjudication?: {
    relatedFactId: string;
    relation: "before" | "after";
  };
  sportingOrderOverride?: OfficialOverrideMetadata;
};

type ClockReceiptAnchor = {
  projection: ControllerProjection["clock"];
  localMonotonicMs: number;
};

export function EventGameControllerPage() {
  const persisted = readPersistedControllerSession();
  const [qrCredential, setQrCredential] = useState("");
  const [grantCode, setGrantCode] = useState("");
  const qrCredentialInputRef = useRef<HTMLInputElement>(null);
  const grantCodeInputRef = useRef<HTMLInputElement>(null);
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
  const [clockReceiptAnchor, setClockReceiptAnchor] = useState<ClockReceiptAnchor | null>(null);
  const [localMonotonicMs, setLocalMonotonicMs] = useState(readMonotonicNow);
  const [clockCorrectionInput, setClockCorrectionInput] = useState("");
  const [takeoverAdjustmentInput, setTakeoverAdjustmentInput] = useState("");
  const [cardGameSideId, setCardGameSideId] = useState("");
  const [cardPlayerNumber, setCardPlayerNumber] = useState("");
  const [cardType, setCardType] = useState<LiveCardType>("blue");
  const [cardFoulBeforeScore, setCardFoulBeforeScore] = useState(false);
  const [cardSeekerPenaltyConfirmed, setCardSeekerPenaltyConfirmed] = useState(false);
  const [skippedPenaltyReasonCardIds, setSkippedPenaltyReasonCardIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [volleyballPossession, setVolleyballPossession] = useState("");
  const [dodgeballPossession, setDodgeballPossession] = useState<PossessionSelection>({});
  const [showSuspensionRecovery, setShowSuspensionRecovery] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [heatOverrideConfirmed, setHeatOverrideConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingClosePlayAdjudication, setPendingClosePlayAdjudication] =
    useState<PendingClosePlayAdjudication | null>(null);
  const [pendingFlagCatchBoundaryOverride, setPendingFlagCatchBoundaryOverride] =
    useState<PendingFlagCatchBoundaryOverride | null>(null);
  const [persistedReplicaLoad] = useState<ControllerReplicaLoad>(() =>
    readPersistedControllerReplica(persisted?.eventGameId),
  );
  const [replica, setReplica] = useState<ControllerReplicaState | null>(persistedReplicaLoad.state);
  const replicaRef = useRef<ControllerReplicaState | null>(replica);
  const bearerGenerationRef = useRef(0);
  const installedReplayAuthorityRef = useRef<ReplayAuthority | null>(null);
  const activeReplayRef = useRef<ActiveReplay | null>(null);
  const queuedReplayRef = useRef<ReplayRequest | null>(null);
  const resynchronizationTimerRef = useRef<number | null>(null);
  const [durabilityWarning, setDurabilityWarning] = useState<string | null>(
    persistedReplicaLoad.warning,
  );
  const [browserContext] = useState(() => readControllerDeviceContext());

  useEffect(() => {
    const timer = window.setInterval(() => setLocalMonotonicMs(readMonotonicNow()), 250);
    return () => {
      window.clearInterval(timer);
      if (resynchronizationTimerRef.current !== null) {
        window.clearTimeout(resynchronizationTimerRef.current);
      }
    };
  }, []);

  const clockProjection =
    clockReceiptAnchor === null
      ? null
      : projectClockSample(
          clockReceiptAnchor.projection,
          localMonotonicMs - clockReceiptAnchor.localMonotonicMs,
        );

  const displayedHeat =
    projection?.heat === undefined
      ? undefined
      : projectLiveHeatState(
          projection.gameFacts ?? [],
          projection.heat.mode,
          clockProjection?.gameTimeMs ?? projection.clock.gameTimeMs,
          projection.clock.projectedAtMs +
            Math.max(
              0,
              localMonotonicMs - (clockReceiptAnchor?.localMonotonicMs ?? localMonotonicMs),
            ),
        );

  function projectClockImmediately() {
    const now = readMonotonicNow();
    setLocalMonotonicMs(now);
    setClockReceiptAnchor((anchor) =>
      anchor === null
        ? null
        : {
            projection: projectClockSample(anchor.projection, now - anchor.localMonotonicMs),
            localMonotonicMs: now,
          },
    );
  }

  useEffect(() => {
    if (sessionBearer === null || eventGameId === null) {
      window.sessionStorage.removeItem("quadball:event-controller-session");
      return;
    }
    window.sessionStorage.setItem(
      "quadball:event-controller-session",
      JSON.stringify({ sessionBearer, eventGameId } satisfies PersistedControllerSession),
    );
  }, [eventGameId, sessionBearer]);

  useEffect(() => {
    replicaRef.current = replica;
    if (replica === null) return;
    setProjection(replica.projection);
    setProjectionStatus("available");
    const persistedReplica = persistControllerReplica(
      replica,
      browserReplicaStorage(replica.eventGameId),
    );
    if (persistedReplica.warning !== null) setDurabilityWarning(persistedReplica.warning);
  }, [replica]);

  useEffect(() => {
    if (persisted !== null) void refreshController(true);
    // Persisted authority is deliberately revalidated after browser restore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const reconcileWhenForegrounded = () => {
      if (document.visibilityState === "hidden") return;
      projectClockImmediately();
      void (async () => {
        const revalidated = await refreshController(true);
        if (revalidated && replicaRef.current !== null) {
          await flushReplica(replicaRef.current);
        }
      })();
    };
    window.addEventListener("online", reconcileWhenForegrounded);
    document.addEventListener("visibilitychange", reconcileWhenForegrounded);
    return () => {
      window.removeEventListener("online", reconcileWhenForegrounded);
      document.removeEventListener("visibilitychange", reconcileWhenForegrounded);
    };
  }, [eventGameId, sessionBearer]);

  const livePenalties =
    projection === null
      ? null
      : clockProjection === null
        ? projection.penalties
        : deriveLivePenaltyProjection(projection.gameFacts ?? [], clockProjection.gameTimeMs);

  function controllerGameTimeMs(): number {
    return clockProjection?.gameTimeMs ?? projection?.clock.gameTimeMs ?? 0;
  }

  async function openController() {
    const hasQrCredential = qrCredential.length > 0;
    const hasGrantCode = grantCode.length > 0;
    if (hasQrCredential === hasGrantCode) {
      setMessage("Enter exactly one Controller QR credential or Grant Code.");
      return;
    }
    setBusy(true);
    setMessage(null);
    clearReplayAuthority();
    if (replicaRef.current !== null) {
      const invalidated = invalidateControllerReplica(replicaRef.current);
      replicaRef.current = invalidated;
      setReplica(invalidated);
    }
    try {
      const response = await postJson<ControllerOpenResponse>("/api/event-control/open", {
        ...(grantCode.length > 0 ? { grantCode } : { qrCredential }),
        browserContext,
      });
      if (response.status !== "opened") throw new Error("open failed");
      setQrCredential("");
      setGrantCode("");
      if (qrCredentialInputRef.current !== null) qrCredentialInputRef.current.value = "";
      if (grantCodeInputRef.current !== null) grantCodeInputRef.current.value = "";
      setSessionBearer(response.session.sessionBearer);
      setEventGameId(response.eventGameId);
      receiveProjection(response.projection);
      const existingReplica = replicaRef.current;
      const restoredLoad = loadControllerReplica(
        browserReplicaStorage(response.eventGameId),
        response.eventGameId,
      );
      if (restoredLoad.warning !== null) setDurabilityWarning(restoredLoad.warning);
      const scopedReplica =
        existingReplica?.eventGameId === response.eventGameId
          ? existingReplica
          : restoredLoad.state;
      const nextReplica =
        scopedReplica?.eventGameId === response.eventGameId
          ? rebindControllerReplica(
              scopedReplica,
              {
                eventGameId: response.eventGameId,
                grantSessionId: response.session.grantSessionId,
                grantVersion: response.session.grantVersion,
              },
              response.projection,
            )
          : createControllerReplica({
              eventGameId: response.eventGameId,
              projection: response.projection ?? emptyProjection(response.eventGameId),
              grantSessionId: response.session.grantSessionId,
              grantVersion: response.session.grantVersion,
            });
      commitReplica(nextReplica);
      await flushReplica(nextReplica, response.session.sessionBearer);
    } catch {
      clearSession();
      setMessage(
        "Unable to open Controller experience. A fresh device cannot reconstruct Clock Authority during a server outage; use manual timing.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function refreshController(silent = false): Promise<boolean> {
    if (sessionBearer === null || eventGameId === null) return false;
    projectClockImmediately();
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
        return false;
      }
      if (response.status === "rejected") throw new Error("refresh failed");
      setSwitchTarget(null);
      setEventGameId(response.session.eventGameId);
      receiveProjection(response.projection, { resynchronized: true });
      const currentReplica = replicaRef.current;
      const refreshedSession = {
        eventGameId: response.session.eventGameId,
        grantSessionId: response.session.grantSessionId,
        grantVersion: response.session.grantVersion,
      };
      const nextReplica =
        currentReplica?.eventGameId === response.session.eventGameId &&
        currentReplica.session.grantSessionId === response.session.grantSessionId &&
        currentReplica.session.grantVersion === response.session.grantVersion
          ? acknowledgeControllerProjection(currentReplica, response.projection)
          : currentReplica?.eventGameId === response.session.eventGameId
            ? rebindControllerReplica(currentReplica, refreshedSession, response.projection)
            : createControllerReplica({
                eventGameId: response.session.eventGameId,
                projection: response.projection ?? emptyProjection(response.session.eventGameId),
                grantSessionId: response.session.grantSessionId,
                grantVersion: response.session.grantVersion,
              });
      commitReplica(nextReplica);
      await flushReplica(nextReplica, sessionBearer);
      return true;
    } catch {
      if (!silent) setMessage("Unable to refresh Controller session.");
      return false;
    } finally {
      if (!silent) setBusy(false);
    }
  }

  async function switchController() {
    if (sessionBearer === null) return;
    setBusy(true);
    clearReplayAuthority();
    const current = replicaRef.current;
    if (current !== null) {
      const invalidated = invalidateControllerReplica(current);
      replicaRef.current = invalidated;
      setReplica(invalidated);
    }
    try {
      const response = await postJson<ControllerRefreshResponse>("/api/event-control/switch", {
        sessionBearer,
      });
      if (response.status !== "authorized") throw new Error("switch failed");
      setEventGameId(response.session.eventGameId);
      receiveProjection(response.projection);
      const restoredLoad = loadControllerReplica(
        browserReplicaStorage(response.session.eventGameId),
        response.session.eventGameId,
      );
      if (restoredLoad.warning !== null) setDurabilityWarning(restoredLoad.warning);
      const restored = restoredLoad.state;
      const nextReplica =
        restored === null
          ? createControllerReplica({
              eventGameId: response.session.eventGameId,
              projection: response.projection ?? emptyProjection(response.session.eventGameId),
              grantSessionId: response.session.grantSessionId,
              grantVersion: response.session.grantVersion,
            })
          : rebindControllerReplica(
              restored,
              {
                eventGameId: response.session.eventGameId,
                grantSessionId: response.session.grantSessionId,
                grantVersion: response.session.grantVersion,
              },
              response.projection,
            );
      commitReplica(nextReplica);
      await flushReplica(nextReplica, sessionBearer);
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
      receiveProjection(response.projection);
      if (replicaRef.current !== null) {
        const nextReplica = rebindControllerReplica(
          replicaRef.current,
          {
            eventGameId: response.session.eventGameId,
            grantSessionId: response.session.grantSessionId,
            grantVersion: response.session.grantVersion,
          },
          response.projection,
        );
        commitReplica(nextReplica);
        await flushReplica(nextReplica, sessionBearer);
      }
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

  function recordGoal(gameSideId: string) {
    recordScoringFact("record-goal", gameSideId);
  }

  function recordFlagCatch(gameSideId: string) {
    recordScoringFact("record-flag-catch", gameSideId);
  }

  function recordScoringFact(intentType: "record-goal" | "record-flag-catch", gameSideId: string) {
    const gameTimeMs = currentSportingTimeMs();
    if (gameTimeMs === null) return;
    const running = clockProjection?.running ?? projection?.clock.running ?? false;
    const flagCatchBoundaryRunning =
      intentType === "record-flag-catch" && (gameTimeMs < SEEKER_RELEASE_MS || running)
        ? running
        : null;
    const relatedFacts = (projection?.gameFacts ?? []).filter(
      (fact) =>
        fact.effective &&
        fact.gameTimeMs !== null &&
        Math.abs(fact.gameTimeMs - gameTimeMs) <= CLOSE_PLAY_ADJUDICATION_WINDOW_MS &&
        ((intentType === "record-goal" && fact.factType === "flag-catch") ||
          (intentType === "record-flag-catch" && fact.factType === "goal")),
    );
    if (relatedFacts.length > 0) {
      setPendingClosePlayAdjudication({
        intentType,
        gameSideId,
        gameTimeMs,
        flagCatchBoundaryRunning,
        relatedFacts: relatedFacts.map((fact) => ({
          factType: fact.factType as "goal" | "flag-catch",
          factId: fact.factId,
          gameTimeMs: fact.gameTimeMs ?? gameTimeMs,
        })),
      });
      setMessage("Head Referee adjudication is required to order this close goal and flag catch.");
      return;
    }
    if (flagCatchBoundaryRunning !== null) {
      setPendingFlagCatchBoundaryOverride({ gameSideId, gameTimeMs, running });
      setMessage(
        "Head Referee confirmation is required for a flag catch before seeker release or while play is running.",
      );
      return;
    }
    queueIntent({
      version: LIVE_EVENT_CONTROL_INTENT_VERSION,
      type: intentType,
      operationId: crypto.randomUUID(),
      factId: crypto.randomUUID(),
      gameSideId,
      gameTimeMs,
      sportingOrder: gameTimeMs,
      occurrence: { clientOriginAtMs: Date.now() },
    });
  }

  function submitClosePlayAdjudication(order: "before" | "after", relatedFactId: string) {
    const pending = pendingClosePlayAdjudication;
    if (pending === null) return;
    const relatedFact = pending.relatedFacts.find((fact) => fact.factId === relatedFactId);
    if (relatedFact === undefined) return;
    const override: OfficialOverrideMetadata = {
      guardrail: "sporting-order-adjudication",
      direction: "head-referee-adjudicated-sporting-order",
      confirmation: "head-referee-confirmed",
      authorityReference: "head-referee",
      gameTimeMs: pending.gameTimeMs,
      beforeValue: {
        candidateGameTimeMs: pending.gameTimeMs,
        relatedFactId: relatedFact.factId,
        relatedGameTimeMs: relatedFact.gameTimeMs,
      },
      afterValue: {
        relation: order,
        sportingOrder: "explicit-pair-order",
      },
      reason: "head-referee-direction",
    };
    if (pending.flagCatchBoundaryRunning !== null) {
      setPendingFlagCatchBoundaryOverride({
        gameSideId: pending.gameSideId,
        gameTimeMs: pending.gameTimeMs,
        running: pending.flagCatchBoundaryRunning,
        sportingOrderAdjudication: {
          relatedFactId: relatedFact.factId,
          relation: order,
        },
        sportingOrderOverride: override,
      });
      setPendingClosePlayAdjudication(null);
      setMessage(
        "Sporting Order recorded. Separately confirm the flag-catch boundary override before submission.",
      );
      return;
    }
    queueIntent({
      version: LIVE_EVENT_CONTROL_INTENT_VERSION,
      type: pending.intentType,
      operationId: crypto.randomUUID(),
      factId: crypto.randomUUID(),
      gameSideId: pending.gameSideId,
      gameTimeMs: pending.gameTimeMs,
      sportingOrderAdjudication: {
        relatedFactId: relatedFact.factId,
        relation: order,
      },
      override,
      occurrence: { clientOriginAtMs: Date.now() },
    });
    setPendingClosePlayAdjudication(null);
  }

  function submitFlagCatchBoundaryOverride() {
    const pending = pendingFlagCatchBoundaryOverride;
    if (pending === null) return;
    queueIntent({
      version: LIVE_EVENT_CONTROL_INTENT_VERSION,
      type: "record-flag-catch",
      operationId: crypto.randomUUID(),
      factId: crypto.randomUUID(),
      gameSideId: pending.gameSideId,
      gameTimeMs: pending.gameTimeMs,
      override: flagCatchBoundaryOverride(pending.gameTimeMs, pending.running),
      ...(pending.sportingOrderAdjudication === undefined
        ? {}
        : {
            sportingOrderAdjudication: pending.sportingOrderAdjudication,
            sportingOrderOverride: pending.sportingOrderOverride,
          }),
      occurrence: { clientOriginAtMs: Date.now() },
    });
    setPendingFlagCatchBoundaryOverride(null);
  }

  function recordConcession(gameSideId: string) {
    const gameTimeMs = currentSportingTimeMs();
    if (gameTimeMs === null) return;
    queueIntent({
      version: LIVE_EVENT_CONTROL_INTENT_VERSION,
      type: "record-concession",
      operationId: crypto.randomUUID(),
      factId: crypto.randomUUID(),
      gameSideId,
      gameTimeMs,
      sportingOrder: gameTimeMs,
      occurrence: { clientOriginAtMs: Date.now() },
    });
  }

  function recordForfeit(gameSideId: string) {
    const gameTimeMs = currentSportingTimeMs();
    if (gameTimeMs === null) return;
    queueIntent({
      version: LIVE_EVENT_CONTROL_INTENT_VERSION,
      type: "record-forfeit",
      operationId: crypto.randomUUID(),
      factId: crypto.randomUUID(),
      gameSideId,
      gameTimeMs,
      sportingOrder: gameTimeMs,
      occurrence: { clientOriginAtMs: Date.now() },
    });
  }

  function recordDoubleForfeit() {
    const gameTimeMs = currentSportingTimeMs();
    if (gameTimeMs === null) return;
    queueIntent({
      version: LIVE_EVENT_CONTROL_INTENT_VERSION,
      type: "record-double-forfeit",
      operationId: crypto.randomUUID(),
      factId: crypto.randomUUID(),
      gameTimeMs,
      sportingOrder: gameTimeMs,
      occurrence: { clientOriginAtMs: Date.now() },
    });
  }

  function recordCard() {
    if (cardGameSideId === "") return;
    const parsedPlayerNumber = cardPlayerNumber === "" ? null : Number(cardPlayerNumber);
    if (parsedPlayerNumber !== null && !Number.isSafeInteger(parsedPlayerNumber)) return;
    queueIntent({
      version: LIVE_EVENT_CONTROL_INTENT_VERSION,
      type: "record-card",
      operationId: crypto.randomUUID(),
      factId: crypto.randomUUID(),
      gameSideId: cardGameSideId,
      playerNumber: parsedPlayerNumber,
      cardType,
      ...(cardType === "blue" || cardType === "yellow"
        ? { foulBeforeScore: cardFoulBeforeScore }
        : {}),
      ...(cardSeekerPenaltyConfirmed ? { seekerPenalty: "head-referee-confirmed" as const } : {}),
      gameTimeMs: controllerGameTimeMs(),
      occurrence: { clientOriginAtMs: Date.now() },
    });
  }

  function recordPenaltyReason(targetCardFactId: string, reason: LivePenaltyReason) {
    setSkippedPenaltyReasonCardIds((current) => {
      if (!current.has(targetCardFactId)) return current;
      const next = new Set(current);
      next.delete(targetCardFactId);
      return next;
    });
    const cardOperationId = replicaRef.current?.pendingActions.find(
      (action) => action.intent.type === "record-card" && action.intent.factId === targetCardFactId,
    )?.intent.operationId;
    queueIntent(
      {
        version: LIVE_EVENT_CONTROL_INTENT_VERSION,
        type: "record-penalty-reason",
        operationId: crypto.randomUUID(),
        factId: crypto.randomUUID(),
        targetCardFactId,
        reason,
        gameTimeMs: controllerGameTimeMs(),
        occurrence: { clientOriginAtMs: Date.now() },
      },
      cardOperationId === undefined ? {} : { causalPredecessorIds: [cardOperationId] },
    );
  }

  function skipPenaltyReason(targetCardFactId: string) {
    setSkippedPenaltyReasonCardIds((current) => {
      const next = new Set(current);
      next.add(targetCardFactId);
      return next;
    });
  }

  function resolvePenaltyExpiration(pendingId: string, scoreFactId: string, playerKey: string) {
    const scoreOperationId = replicaRef.current?.pendingActions.find(
      (action) => action.intent.type === "record-goal" && action.intent.factId === scoreFactId,
    )?.intent.operationId;
    queueIntent(
      {
        version: LIVE_EVENT_CONTROL_INTENT_VERSION,
        type: "resolve-penalty-expiration",
        operationId: crypto.randomUUID(),
        factId: crypto.randomUUID(),
        pendingId,
        scoreFactId,
        playerKey,
        gameTimeMs: controllerGameTimeMs(),
        occurrence: { clientOriginAtMs: Date.now() },
      },
      scoreOperationId === undefined ? {} : { causalPredecessorIds: [scoreOperationId] },
    );
  }

  function correctFact(factId: string, effective: boolean) {
    const gameTimeMs = currentSportingTimeMs();
    if (gameTimeMs === null) return;
    queueIntent({
      version: LIVE_EVENT_CONTROL_INTENT_VERSION,
      type: "correct-fact",
      operationId: crypto.randomUUID(),
      factId: crypto.randomUUID(),
      targetFactId: factId,
      effective,
      gameTimeMs,
      sportingOrder: gameTimeMs,
      occurrence: { clientOriginAtMs: Date.now() },
    });
  }

  function trigger(
    type: "card" | "timeout" | "suspension" | "result",
    options: {
      timeoutAction?: "stoppage" | "start" | "complete";
      timeoutGameSideId?: string;
      suspensionAction?: "start" | "resume";
      resumesSuspensionFactId?: string;
    } = {},
  ) {
    const gameTimeMs = currentSportingTimeMs();
    if (gameTimeMs === null) return;
    if (type === "suspension" && options.suspensionAction !== "resume") {
      if (projection === null || projection.penalties === undefined) {
        setMessage("A current authoritative projection is required before suspending.");
        return;
      }
      if (volleyballPossession === "") {
        setMessage("Confirm volleyball possession before suspending.");
        return;
      }
      if ((projection.knownDodgeballIds ?? []).some((ballId) => !(ballId in dodgeballPossession))) {
        setMessage("Confirm every known dodgeball possession before suspending.");
        return;
      }
    }
    const suspensionSnapshot =
      type === "suspension" && options.suspensionAction !== "resume" && projection !== null
        ? {
            version: LIVE_SUSPENSION_SNAPSHOT_VERSION,
            gameTimeMs,
            scoreByGameSide: projection.scoreByGameSide,
            penalties: suspensionPenaltyStateFromProjection(projection.penalties!),
            volleyballPossession,
            dodgeballPossession,
          }
        : undefined;
    queueIntent({
      version: LIVE_EVENT_CONTROL_INTENT_VERSION,
      type: "substantive",
      trigger: type,
      operationId: crypto.randomUUID(),
      factId: crypto.randomUUID(),
      gameTimeMs,
      sportingOrder: gameTimeMs,
      occurrence: { clientOriginAtMs: Date.now() },
      ...options,
      ...(suspensionSnapshot === undefined ? {} : { suspensionSnapshot }),
    });
  }

  function submitHeatAction(heatAction: LiveHeatAction) {
    const heat = displayedHeat;
    if (projection === null || heat === undefined) return;
    const decisionAction =
      heatAction === "start" ||
      heatAction === "end-of-drive" ||
      heatAction === "dead-volleyball" ||
      heatAction === "other-stoppage" ||
      heatAction === "skip" ||
      heatAction === "skip-required" ||
      heatAction === "suppress";
    const triggerId =
      heatAction === "extend-permitted"
        ? heat.permittedExtensionTriggerId
        : heatAction === "end" || heatAction === "extend"
          ? heat.activeTriggerId
          : decisionAction
            ? heat.pendingTriggerId
            : null;
    const gameTimeMs =
      decisionAction && typeof heat.pendingTriggerGameTimeMs === "number"
        ? heat.pendingTriggerGameTimeMs
        : (clockProjection?.gameTimeMs ?? projection.clock.gameTimeMs);
    const override = heatOverrideConfirmed
      ? buildHeatOverride(heatAction, heat, gameTimeMs)
      : undefined;
    queueIntent({
      version: LIVE_EVENT_CONTROL_INTENT_VERSION,
      type: "substantive",
      trigger: "heat-stoppage",
      operationId: crypto.randomUUID(),
      factId: crypto.randomUUID(),
      gameTimeMs,
      heatAction,
      ...(triggerId === null || triggerId === undefined ? {} : { heatTriggerId: triggerId }),
      ...(override === undefined ? {} : { override }),
      occurrence: { clientOriginAtMs: Date.now() },
    });
  }

  function buildHeatOverride(
    heatAction: LiveHeatAction,
    heat: NonNullable<ControllerProjection["heat"]>,
    gameTimeMs: number,
  ): OfficialOverrideMetadata {
    const modeChange = heatAction === "enable" || heatAction === "disable";
    const pendingTriggerGameTimeMs = heat.pendingTriggerGameTimeMs ?? null;
    const nominalDurationMs = heat.nominalDurationMs ?? null;
    const actualDurationMs = heat.actualDurationMs ?? 0;
    const scores = Object.values(projection?.scoreByGameSide ?? {});
    const scoreDifference = Math.abs((scores[0] ?? 0) - (scores[1] ?? 0));
    const beforeValue: ActionJsonValue = (
      modeChange
        ? { heatMode: heat.mode === "enabled" }
        : heatAction === "suppress"
          ? { pendingTriggerGameTimeMs }
          : heatAction === "start" ||
              heatAction === "end-of-drive" ||
              heatAction === "dead-volleyball" ||
              heatAction === "other-stoppage"
            ? { heat: "pending", requiredDecision: "skip" }
            : heatAction === "skip" || heatAction === "skip-required"
              ? { scoreDifference }
              : heatAction === "end" || heatAction === "extend"
                ? actualDurationMs >= (nominalDurationMs ?? 0)
                  ? {
                      heat: heat.status,
                      nominalDurationMs,
                      actualDurationMs,
                    }
                  : { heat: heat.status }
                : { heat: heat.status }
    ) as ActionJsonValue;
    return {
      guardrail: modeChange ? "heat-stoppage-mode-change" : "heat-stoppage-rule-deviation",
      direction: modeChange
        ? "head-referee-directed-heat-mode-change"
        : "head-referee-directed-heat-stoppage",
      confirmation: "head-referee-confirmed",
      authorityReference: "head-referee",
      gameTimeMs,
      beforeValue,
      afterValue: modeChange
        ? { heatMode: heatAction === "enable" }
        : heatAction === "suppress"
          ? { trigger: "suppressed" }
          : heatAction === "end"
            ? { heat: "ended" }
            : {
                heat:
                  heatAction === "skip" || heatAction === "skip-required"
                    ? "skipped"
                    : heatAction === "extend"
                      ? "extended"
                      : heatAction,
              },
      reason: "head-referee-direction",
    };
  }

  function queueIntent(
    candidate: LiveEventControllerIntent,
    options: { causalPredecessorIds?: readonly string[] } = {},
  ) {
    const current = replicaRef.current;
    if (current === null) return;
    try {
      const relatedFactId = candidate.sportingOrderAdjudication?.relatedFactId;
      const relatedPendingOperationId =
        relatedFactId === undefined
          ? undefined
          : current.pendingActions.find((action) => action.intent.factId === relatedFactId)?.intent
              .operationId;
      const dispatched = dispatchControllerAction(
        current,
        {
          ...candidate,
          occurrence: {
            ...candidate.occurrence,
            source: navigator.onLine === false ? "offline" : "online",
          },
        },
        {
          ...options,
          causalPredecessorIds: [
            ...(options.causalPredecessorIds ?? []),
            ...(relatedPendingOperationId === undefined ? [] : [relatedPendingOperationId]),
          ],
          nowMs: Math.floor(readMonotonicNow()),
        },
      );
      replicaRef.current = dispatched.state;
      setReplica(dispatched.state);
      setProjection(dispatched.state.projection);
      setProjectionStatus("available");
      void flushReplica(dispatched.state);
    } catch {
      setMessage("The Controller action could not be retained safely.");
    }
  }

  function currentSportingTimeMs(): number | null {
    const value = clockProjection?.gameTimeMs ?? projection?.clock.gameTimeMs;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      setMessage("The current Game time is unavailable; resynchronize before recording a fact.");
      return null;
    }
    return value;
  }

  async function flushReplica(state: ControllerReplicaState, bearer = sessionBearer) {
    if (bearer === null) return;
    const request = { state, authority: installReplayAuthority(state, bearer) };
    const active = activeReplayRef.current;
    if (active !== null) {
      if (active.authority.ownerKey !== request.authority.ownerKey || active.state !== state) {
        queuedReplayRef.current = request;
      }
      return;
    }
    await runReplay(request);
  }

  async function runReplay(request: ReplayRequest) {
    if (!isInstalledReplayAuthority(request.authority)) return;
    const current = replicaRef.current;
    const replayState =
      current !== null && replicaMatchesAuthority(current, request.authority)
        ? current
        : request.state;
    const prepared = prepareControllerReplayBatch(replayState);
    if (prepared === null) return;
    commitReplica(prepared.state);
    const active: ActiveReplay = {
      state: prepared.state,
      authority: request.authority,
      requestToken: Symbol("controller-replay"),
    };
    activeReplayRef.current = active;
    try {
      const response = await postJson<ControllerReplayBatchResponse>("/api/event-control/replay", {
        sessionBearer: request.authority.bearer,
        eventGameId: prepared.batch.eventGameId,
        batchId: prepared.batch.batchId,
        replicaGeneration: prepared.batch.replicaGeneration,
        grantSessionId: prepared.batch.session.grantSessionId,
        grantVersion: prepared.batch.session.grantVersion,
        actions: prepared.batch.actions,
      });
      if (!isInstalledReplayAuthority(request.authority)) return;
      const nextReplica = reconcileControllerReplay(replicaRef.current ?? prepared.state, response);
      commitReplica(nextReplica);
      receiveProjection(response.projection);
      if (response.discardedCount !== undefined) {
        setMessage(
          `${response.discardedCount} queued Controller action(s) were discarded after Game Lock.`,
        );
      }
      if (
        response.status === "synchronized" &&
        nextReplica.pendingActions.some((action) => action.status === "pending")
      ) {
        queuedReplayRef.current = { state: nextReplica, authority: request.authority };
      }
      if (response.status === "retryable")
        setMessage("Reconnect is incomplete; retained actions will retry.");
    } catch {
      if (isInstalledReplayAuthority(request.authority)) {
        const hasPendingClock = replicaRef.current?.pendingActions.some(
          (action) =>
            action.intent.type === "clock" ||
            action.intent.type === "set-running" ||
            action.intent.type === "clock-adjust" ||
            action.intent.type === "clock-correction" ||
            action.intent.type === "clock-takeover",
        );
        const hasPendingTakeover = replicaRef.current?.pendingActions.some(
          (action) => action.intent.type === "clock-takeover",
        );
        setMessage(
          hasPendingTakeover
            ? "Emergency clock takeover retained for synchronization."
            : hasPendingClock
              ? "Clock action retained for synchronization."
              : "Connection lost. Pending Controller actions remain safely retained.",
        );
      }
    } finally {
      if (activeReplayRef.current?.requestToken === active.requestToken) {
        activeReplayRef.current = null;
        const queued = queuedReplayRef.current;
        queuedReplayRef.current = null;
        const installed = installedReplayAuthorityRef.current;
        if (
          queued !== null &&
          installed !== null &&
          queued.authority.ownerKey === installed.ownerKey
        ) {
          void runReplay({ state: replicaRef.current ?? queued.state, authority: installed });
        }
      }
    }
  }

  function installReplayAuthority(state: ControllerReplicaState, bearer: string): ReplayAuthority {
    const current = installedReplayAuthorityRef.current;
    if (current !== null && current.bearer === bearer && replicaMatchesAuthority(state, current)) {
      return current;
    }
    const bearerGeneration = bearerGenerationRef.current + 1;
    bearerGenerationRef.current = bearerGeneration;
    const authority: ReplayAuthority = {
      ownerKey: [
        state.eventGameId,
        state.replicaGeneration,
        state.session.grantSessionId,
        state.session.grantVersion,
        bearerGeneration,
      ].join("\u001f"),
      bearer,
      bearerGeneration,
      eventGameId: state.eventGameId,
      replicaGeneration: state.replicaGeneration,
      grantSessionId: state.session.grantSessionId,
      grantVersion: state.session.grantVersion,
    };
    installedReplayAuthorityRef.current = authority;
    return authority;
  }

  function isInstalledReplayAuthority(authority: ReplayAuthority): boolean {
    return installedReplayAuthorityRef.current?.ownerKey === authority.ownerKey;
  }

  function clearReplayAuthority() {
    installedReplayAuthorityRef.current = null;
    queuedReplayRef.current = null;
  }

  function commitReplica(state: ControllerReplicaState) {
    replicaRef.current = state;
    setReplica(state);
  }

  function toggleClock() {
    const bearer = sessionBearer;
    const currentEventGameId = eventGameId;
    if (bearer === null || currentEventGameId === null) return;
    if (navigator.onLine === false) {
      queueClockAuthorityIntent({
        version: LIVE_EVENT_CONTROL_INTENT_VERSION,
        type: "clock",
        running: !clockRunning,
        operationId: crypto.randomUUID(),
        factId: crypto.randomUUID(),
        gameTimeMs: clockProjection?.gameTimeMs ?? projection?.clock.gameTimeMs ?? 0,
        occurrence: { clientOriginAtMs: Date.now(), source: "offline" },
      });
      return;
    }
    void submitOnlineControllerIntent(
      {
        version: LIVE_EVENT_CONTROL_INTENT_VERSION,
        type: "clock",
        running: !clockRunning,
        operationId: crypto.randomUUID(),
        factId: crypto.randomUUID(),
        gameTimeMs: 0,
        occurrence: { clientOriginAtMs: Date.now(), source: "online" },
      },
      bearer,
      currentEventGameId,
    );
  }

  function adjustClock(adjustmentMs: number) {
    const bearer = sessionBearer;
    const currentEventGameId = eventGameId;
    if (bearer === null || currentEventGameId === null) return;
    if (navigator.onLine === false) {
      queueClockAuthorityIntent({
        version: LIVE_EVENT_CONTROL_INTENT_VERSION,
        type: "clock-adjust",
        adjustmentMs,
        operationId: crypto.randomUUID(),
        factId: crypto.randomUUID(),
        gameTimeMs: clockProjection?.gameTimeMs ?? projection?.clock.gameTimeMs ?? 0,
        occurrence: { clientOriginAtMs: Date.now(), source: "offline" },
      });
      return;
    }
    void submitOnlineControllerIntent(
      {
        version: LIVE_EVENT_CONTROL_INTENT_VERSION,
        type: "clock-adjust",
        adjustmentMs,
        operationId: crypto.randomUUID(),
        factId: crypto.randomUUID(),
        gameTimeMs: 0,
        occurrence: { clientOriginAtMs: Date.now(), source: "online" },
      },
      bearer,
      currentEventGameId,
    );
  }

  function correctClock() {
    if (clockCorrectionInput.trim() === "") {
      setMessage("Enter a whole number of milliseconds from 0 to 7200000.");
      return;
    }
    const candidate = Number(clockCorrectionInput);
    const validated = validateGameClockMs(candidate);
    if (!validated.ok) {
      setMessage("Clock correction must be a whole number from 0 to 7200000 milliseconds.");
      return;
    }
    const bearer = sessionBearer;
    const currentEventGameId = eventGameId;
    if (bearer === null || currentEventGameId === null) return;
    if (navigator.onLine === false) {
      queueClockAuthorityIntent({
        version: LIVE_EVENT_CONTROL_INTENT_VERSION,
        type: "clock-correction",
        clockTimeMs: validated.value,
        operationId: crypto.randomUUID(),
        factId: crypto.randomUUID(),
        gameTimeMs: clockProjection?.gameTimeMs ?? projection?.clock.gameTimeMs ?? 0,
        occurrence: { clientOriginAtMs: Date.now(), source: "offline" },
      });
      return;
    }
    void submitOnlineControllerIntent(
      {
        version: LIVE_EVENT_CONTROL_INTENT_VERSION,
        type: "clock-correction",
        clockTimeMs: validated.value,
        operationId: crypto.randomUUID(),
        factId: crypto.randomUUID(),
        gameTimeMs: 0,
        occurrence: { clientOriginAtMs: Date.now(), source: "online" },
      },
      bearer,
      currentEventGameId,
    );
    setClockCorrectionInput("");
    setQrCredential("");
    setGrantCode("");
  }

  function emergencyClockTakeover() {
    const current = clockProjection ?? projection?.clock;
    if (current === undefined || replicaRef.current === null) {
      setMessage("Clock is unavailable; use manual timing until an admitted device reconnects.");
      return;
    }
    if (!window.confirm("Confirm emergency clock takeover with the Timekeeper or Head Referee.")) {
      return;
    }
    const parsedAdjustment =
      takeoverAdjustmentInput.trim() === "" ? 0 : Number(takeoverAdjustmentInput);
    const confirmationElapsedMs = current.running
      ? Math.max(0, readMonotonicNow() - localMonotonicMs)
      : 0;
    const adjustment = validateGameClockMs(
      current.gameTimeMs + confirmationElapsedMs + parsedAdjustment,
    );
    if (!adjustment.ok) {
      setMessage(
        "Takeover adjustment must keep the game clock between 0 and 7200000 milliseconds.",
      );
      return;
    }
    queueClockAuthorityIntent({
      version: LIVE_EVENT_CONTROL_INTENT_VERSION,
      type: "clock-takeover",
      clockTimeMs: adjustment.value,
      running: current.running,
      authorityGeneration: current.baseline.authorityGeneration,
      confirmation: "physical-timekeeper-or-head-referee",
      operationId: crypto.randomUUID(),
      factId: crypto.randomUUID(),
      gameTimeMs: adjustment.value,
      occurrence: {
        clientOriginAtMs: Date.now(),
        source: navigator.onLine === false ? "offline" : "online",
      },
    });
    setTakeoverAdjustmentInput("");
  }

  function queueClockAuthorityIntent(intent: LiveEventControllerIntent) {
    const current = replicaRef.current;
    if (current === null) return;
    try {
      const dispatched = dispatchControllerClockAction(
        current,
        {
          ...intent,
          ...(intent.type === "clock" ||
          intent.type === "set-running" ||
          intent.type === "clock-adjust" ||
          intent.type === "clock-correction"
            ? { clockGeneration: current.projection.clock.baseline.authorityGeneration }
            : {}),
        },
        { nowMs: Math.floor(readMonotonicNow()) },
      );
      commitReplica(dispatched.state);
      receiveProjection(dispatched.state.projection);
      setMessage(
        intent.type === "clock-takeover"
          ? "Emergency clock takeover retained for synchronization."
          : "Clock action retained for synchronization.",
      );
      void flushReplica(dispatched.state);
    } catch (error) {
      setMessage(
        error instanceof Error && error.message.includes("Offline Clock Holder")
          ? "Only the Offline Clock Holder may control the disconnected clock."
          : "Clock action could not be retained safely.",
      );
    }
  }

  function receiveProjection(
    nextProjection: ControllerProjection | null,
    options: { resynchronized?: boolean } = {},
  ) {
    setProjection(nextProjection);
    setProjectionStatus(nextProjection === null ? "unavailable" : "available");
    setClockRunning(nextProjection?.clock.running ?? false);
    setClockReceiptAnchor(
      nextProjection === null
        ? null
        : { projection: nextProjection.clock, localMonotonicMs: readMonotonicNow() },
    );
    if (options.resynchronized) {
      setMessage("Clock resynchronized.");
      if (resynchronizationTimerRef.current !== null) {
        window.clearTimeout(resynchronizationTimerRef.current);
      }
      resynchronizationTimerRef.current = window.setTimeout(() => {
        setMessage((current) => (current === "Clock resynchronized." ? null : current));
      }, 2_000);
    }
  }

  async function submitOnlineControllerIntent(
    intent: LiveEventControllerIntent,
    bearer: string,
    currentEventGameId: string,
  ) {
    try {
      const response = await postJson<LiveEventGameControlResult>("/api/event-control/intent", {
        sessionBearer: bearer,
        eventGameId: currentEventGameId,
        intent,
      });
      if (response.status !== "accepted" && response.status !== "duplicate-accepted") {
        setMessage("The online Controller action was not accepted.");
        return;
      }
      if (response.projection !== null) {
        const current = replicaRef.current;
        if (current?.eventGameId === currentEventGameId) {
          const nextReplica = acknowledgeControllerProjection(current, response.projection);
          replicaRef.current = nextReplica;
          setReplica(nextReplica);
        }
        receiveProjection(response.projection);
        if (intent.type === "clock" || intent.type === "set-running") {
          setClockRunning(intent.running);
        }
      }
    } catch {
      setMessage("The online Controller action could not be submitted.");
    }
  }

  function clearSession() {
    clearReplayAuthority();
    if (replicaRef.current !== null) {
      const invalidated = invalidateControllerReplica(replicaRef.current);
      replicaRef.current = invalidated;
      setReplica(invalidated);
    }
    setSessionBearer(null);
    setEventGameId(null);
    setProjection(null);
    setProjectionStatus("unavailable");
    setClockRunning(false);
    setClockReceiptAnchor(null);
    setClockCorrectionInput("");
    setRevealedQr(null);
    setSwitchTarget(null);
    setStayedOnAssignment(null);
  }

  return (
    <main className="mx-auto max-h-[calc(100vh-1rem)] w-full max-w-xl overflow-y-auto p-4 pb-12 sm:max-h-none sm:overflow-visible sm:p-6">
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
                  ref={qrCredentialInputRef}
                  value={qrCredential}
                  onChange={(event) => setQrCredential(event.target.value)}
                  onInput={(event) => setQrCredential(event.currentTarget.value)}
                  autoComplete="off"
                  placeholder="Scan or paste the QR credential"
                  disabled={busy}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="control-grant-code">Radio Grant Code</Label>
                <Input
                  id="control-grant-code"
                  ref={grantCodeInputRef}
                  type="password"
                  value={grantCode}
                  onChange={(event) => setGrantCode(event.target.value)}
                  onInput={(event) => setGrantCode(event.currentTarget.value)}
                  autoComplete="off"
                  placeholder="two words and three digits"
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
              <div className="flex flex-wrap gap-2 max-[639px]:hidden">
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
              <div className="rounded-lg border bg-slate-950 p-4 text-center text-white">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-300">Game Clock</p>
                <p className="mt-1 text-5xl font-semibold tabular-nums">
                  {clockProjection === null || clockProjection.synchronization === "unavailable"
                    ? "--:--"
                    : formatClock(clockProjection.gameTimeMs)}
                </p>
                <p className="mt-1 text-xs text-slate-300">
                  {clockProjection?.running ? "Play" : "Paused"} · Controller projection
                </p>
                <p className="mt-2 text-xs text-slate-300" data-clock-freshness="true">
                  {clockProjection === null
                    ? "Unavailable · manual timing required"
                    : `${clockProjection.synchronization} · last synchronization: ${formatSynchronizationTime(clockProjection.lastSynchronizedAtMs)}`}
                </p>
              </div>
              {clockProjection === null ? null : (
                <div className="space-y-1 rounded-lg border border-amber-500/50 bg-amber-50 p-3 text-sm text-amber-950 max-[639px]:hidden">
                  <p data-clock-cue="flag-runner">
                    {clockProjection.cues.flagRunnerEntry === "pending"
                      ? "Flag-runner entry pending at 19:00"
                      : clockProjection.cues.flagRunnerEntry === "due"
                        ? "FLAG-RUNNER ENTRY NOW"
                        : "Flag-runner entry complete"}
                  </p>
                  <p data-clock-cue="seeker-warning">
                    {clockProjection.cues.seekerWarning === "pending"
                      ? "Seeker warning pending"
                      : clockProjection.cues.seekerWarning === "due"
                        ? "SEEKER WARNING: release countdown active"
                        : "Seeker warning complete"}
                  </p>
                  <p data-clock-cue="seeker-countdown">
                    {clockProjection.cues.seekerCountdownMs === null
                      ? "Seeker countdown: complete"
                      : `SEEKER COUNTDOWN: ${formatClock(clockProjection.cues.seekerCountdownMs)}`}
                  </p>
                  <p data-clock-cue="seeker-release">
                    {clockProjection.cues.seekerRelease === "released"
                      ? "SEEKER RELEASED at 20:00"
                      : "Seeker release pending at 20:00"}
                  </p>
                </div>
              )}
              {displayedHeat === undefined ? null : (
                <div className="space-y-3 rounded-lg border border-orange-500/50 bg-orange-50 p-3 text-sm text-orange-950">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium">Heat Stoppage Controller workflow</p>
                      <p>
                        Mode: {displayedHeat.mode ?? "disabled"} · status: {displayedHeat.status}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => submitHeatAction("enable")}
                        disabled={busy || displayedHeat.mode === "enabled"}
                      >
                        Enable mode
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => submitHeatAction("disable")}
                        disabled={busy || displayedHeat.mode !== "enabled"}
                      >
                        Disable mode
                      </Button>
                    </div>
                  </div>
                  <p>
                    {displayedHeat.pendingTrigger === null ||
                    displayedHeat.pendingTrigger === undefined
                      ? "No Heat Stoppage cue is pending."
                      : `Pending cue at ${formatClock(displayedHeat.pendingTrigger.gameTimeMs)} · the Game Clock remains running until a Controller decision.`}
                  </p>
                  {displayedHeat.status === "started" || displayedHeat.status === "extended" ? (
                    <div className="rounded border bg-white/70 p-2">
                      <p>
                        Timer: {formatClock(displayedHeat.actualDurationMs ?? 0)} elapsed · nominal{" "}
                        {formatClock(displayedHeat.nominalDurationMs ?? 0)} · allowed{" "}
                        {formatClock(
                          displayedHeat.allowedDurationMs ?? displayedHeat.nominalDurationMs ?? 0,
                        )}
                      </p>
                      <p className="text-xs">
                        Start game time: {formatClock(displayedHeat.startedAtGameTimeMs ?? 0)}
                      </p>
                    </div>
                  ) : null}
                  {displayedHeat.status === "ended" && displayedHeat.completedAtAllowed === true ? (
                    <div className="rounded border bg-white/70 p-2">
                      <p>
                        Heat Stoppage complete at the allowed duration; the Game Clock remains
                        stopped.
                      </p>
                      <Button size="sm" onClick={() => submitHeatAction("end")} disabled={busy}>
                        Acknowledge completion
                      </Button>
                    </div>
                  ) : null}
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={heatOverrideConfirmed}
                      onChange={(event) => setHeatOverrideConfirmed(event.target.checked)}
                    />
                    Head Referee Official Override confirmed
                  </label>
                  {displayedHeat.pendingTriggerId === null ? null : (
                    <div className="flex flex-wrap gap-2">
                      {(
                        [
                          ["end-of-drive", "End of drive"],
                          ["dead-volleyball", "Dead volleyball"],
                          ["other-stoppage", "Other stoppage"],
                          ["skip-required", "Required skip"],
                          ["start", "Start Heat Stoppage"],
                        ] as const
                      ).map(([action, label]) => (
                        <Button
                          key={action}
                          size="sm"
                          variant="outline"
                          onClick={() => submitHeatAction(action)}
                          disabled={busy}
                        >
                          {label}
                        </Button>
                      ))}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => submitHeatAction("skip")}
                        disabled={busy || !heatOverrideConfirmed}
                      >
                        Skip (Official Override)
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => submitHeatAction("suppress")}
                        disabled={busy || !heatOverrideConfirmed}
                      >
                        Suppress cue (override)
                      </Button>
                    </div>
                  )}
                  {displayedHeat.status === "started" || displayedHeat.status === "extended" ? (
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => submitHeatAction("end")} disabled={busy}>
                        End Heat Stoppage
                      </Button>
                      {displayedHeat.permittedExtensionTriggerId ===
                      displayedHeat.activeTriggerId ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => submitHeatAction("extend-permitted")}
                          disabled={busy}
                        >
                          Permitted extension
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => submitHeatAction("extend")}
                        disabled={busy || !heatOverrideConfirmed}
                      >
                        Extend (override)
                      </Button>
                    </div>
                  ) : null}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button onClick={toggleClock} disabled={busy}>
                  {clockRunning ? "Pause clock" : "Start clock"}
                </Button>
                {[-60_000, -10_000, 10_000, 60_000].map((adjustmentMs) => (
                  <Button
                    key={adjustmentMs}
                    variant="outline"
                    onClick={() => adjustClock(adjustmentMs)}
                    disabled={busy}
                  >
                    {adjustmentMs < 0 ? "−" : "+"}
                    {Math.abs(adjustmentMs) / 1000}s
                  </Button>
                ))}
                <div className="flex w-full flex-wrap items-end gap-2 rounded border p-2 text-left max-[639px]:hidden">
                  <div className="min-w-48 flex-1 space-y-1">
                    <Label htmlFor="clock-correction">Set game clock (milliseconds)</Label>
                    <Input
                      id="clock-correction"
                      inputMode="numeric"
                      value={clockCorrectionInput}
                      onChange={(event) => setClockCorrectionInput(event.target.value)}
                      placeholder="0–7200000"
                      disabled={busy}
                    />
                  </div>
                  <Button
                    variant="outline"
                    data-clock-correction="true"
                    onClick={correctClock}
                    disabled={busy}
                  >
                    Correct clock
                  </Button>
                </div>
                <div className="flex w-full flex-wrap items-end gap-2 rounded border border-amber-500/50 p-2 text-left max-[639px]:hidden">
                  <div className="min-w-48 flex-1 space-y-1">
                    <Label htmlFor="clock-takeover-adjustment">
                      Emergency takeover adjustment (ms)
                    </Label>
                    <Input
                      id="clock-takeover-adjustment"
                      inputMode="numeric"
                      value={takeoverAdjustmentInput}
                      onChange={(event) => setTakeoverAdjustmentInput(event.target.value)}
                      placeholder="optional, e.g. -1000"
                      disabled={busy}
                    />
                  </div>
                  <Button
                    variant="outline"
                    data-clock-takeover="true"
                    onClick={emergencyClockTakeover}
                    disabled={busy}
                  >
                    Emergency clock takeover
                  </Button>
                </div>
                <div className="flex w-full flex-wrap items-end gap-2 rounded border p-2 text-left max-[639px]:hidden">
                  <div className="min-w-32 flex-1 space-y-1">
                    <Label htmlFor="penalty-game-side">Penalized Game Side</Label>
                    <select
                      id="penalty-game-side"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                      value={cardGameSideId}
                      onChange={(event) => setCardGameSideId(event.target.value)}
                      disabled={busy}
                    >
                      <option value="">Choose side</option>
                      {Object.keys(projection?.scoreByGameSide ?? {}).map((sideId) => (
                        <option key={sideId} value={sideId}>
                          {sideId}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="w-24 space-y-1">
                    <Label htmlFor="penalty-player-number">Player #</Label>
                    <Input
                      id="penalty-player-number"
                      inputMode="numeric"
                      value={cardPlayerNumber}
                      onChange={(event) => setCardPlayerNumber(event.target.value)}
                      placeholder="optional"
                      disabled={busy}
                    />
                  </div>
                  <div className="min-w-24 space-y-1">
                    <Label htmlFor="penalty-card-type">Card</Label>
                    <select
                      id="penalty-card-type"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                      value={cardType}
                      onChange={(event) => {
                        const nextCardType = event.target.value as LiveCardType;
                        setCardType(nextCardType);
                        if (nextCardType === "red" || nextCardType === "ejection") {
                          setCardFoulBeforeScore(false);
                        }
                      }}
                      disabled={busy}
                    >
                      <option value="blue">Blue</option>
                      <option value="yellow">Yellow</option>
                      <option value="red">Red</option>
                      <option value="ejection">Ejection</option>
                    </select>
                  </div>
                  <p className="max-w-52 self-center text-xs text-muted-foreground">
                    Timing follows the live Game Clock: pregame cards begin at sticks up and
                    confirmed seeker penalties during the seeker floor begin at 20:00.
                  </p>
                  <Button
                    variant="outline"
                    onClick={recordCard}
                    disabled={busy || cardGameSideId === ""}
                  >
                    Accept card
                  </Button>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={cardFoulBeforeScore}
                      onChange={(event) => setCardFoulBeforeScore(event.target.checked)}
                      disabled={busy || cardType === "red" || cardType === "ejection"}
                    />
                    Foul before score
                  </label>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={cardSeekerPenaltyConfirmed}
                      onChange={(event) => setCardSeekerPenaltyConfirmed(event.target.checked)}
                      disabled={busy}
                    />
                    Penalized player is the seeker (Head Referee confirmed)
                  </label>
                </div>
                {projection === null
                  ? null
                  : Object.keys(projection.scoreByGameSide).map((gameSideId) => {
                      const timeout = projection.timeout;
                      const isStoppageForSide =
                        timeout?.status === "stoppage" && timeout.gameSideId === gameSideId;
                      const used = timeout?.usedGameSideIds?.includes(gameSideId) === true;
                      const anotherSideActive =
                        (timeout?.status === "stoppage" || timeout?.status === "started") &&
                        timeout.gameSideId !== gameSideId;
                      return (
                        <Button
                          key={gameSideId}
                          variant="outline"
                          onClick={() =>
                            trigger("timeout", {
                              timeoutAction: isStoppageForSide ? "start" : "stoppage",
                              timeoutGameSideId: gameSideId,
                            })
                          }
                          disabled={busy || anotherSideActive || (used && !isStoppageForSide)}
                        >
                          {isStoppageForSide
                            ? `Start timeout minute: ${gameSideId}`
                            : used
                              ? `Timeout used: ${gameSideId}`
                              : `Timeout stoppage: ${gameSideId}`}
                        </Button>
                      );
                    })}
                <Button
                  variant="outline"
                  onClick={() => setShowSuspensionRecovery(true)}
                  disabled={busy}
                >
                  Review suspension recovery
                </Button>
                {showSuspensionRecovery || projection?.suspension?.status === "suspended" ? (
                  <div className="w-full space-y-2 rounded-lg border p-3 text-left">
                    <p className="text-sm font-medium">Suspension recovery review</p>
                    <p className="text-xs text-muted-foreground">
                      Verify the effective snapshot with another Controller before resuming.
                    </p>
                    {projection?.suspension?.snapshot === null ||
                    projection?.suspension?.snapshot === undefined ? (
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div className="space-y-1">
                          <Label htmlFor="volleyball-possession">Volleyball possession</Label>
                          <select
                            id="volleyball-possession"
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                            value={volleyballPossession}
                            onChange={(event) => setVolleyballPossession(event.target.value)}
                            disabled={busy}
                          >
                            <option value="">Select Game Side</option>
                            {Object.keys(projection?.scoreByGameSide ?? {}).map((sideId) => (
                              <option key={sideId} value={sideId}>
                                {sideId}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="space-y-1">
                          <p className="text-sm font-medium">Dodgeball possession</p>
                          {(projection?.knownDodgeballIds ?? []).map((ballId) => (
                            <div key={ballId} className="space-y-1">
                              <Label htmlFor={`dodgeball-possession-${ballId}`}>{ballId}</Label>
                              <select
                                id={`dodgeball-possession-${ballId}`}
                                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                                value={dodgeballPossession[ballId] ?? ""}
                                onChange={(event) =>
                                  setDodgeballPossession((current) => ({
                                    ...current,
                                    [ballId]: event.target.value || null,
                                  }))
                                }
                                disabled={busy}
                              >
                                <option value="">No confirmed side</option>
                                {Object.keys(projection?.scoreByGameSide ?? {}).map((sideId) => (
                                  <option key={sideId} value={sideId}>
                                    {sideId}
                                  </option>
                                ))}
                              </select>
                            </div>
                          ))}
                        </div>
                        <Button
                          variant="outline"
                          onClick={() => trigger("suspension", { suspensionAction: "start" })}
                          disabled={busy}
                        >
                          Suspend with verified snapshot
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div
                          data-suspension-snapshot="effective"
                          className="rounded-md bg-muted p-2 text-xs"
                        >
                          <p>Volleyball: {projection.suspension.snapshot.volleyballPossession}</p>
                          {Object.entries(projection.suspension.snapshot.dodgeballPossession).map(
                            ([ballId, gameSideId]) => (
                              <p key={ballId} data-dodgeball-id={ballId}>
                                {ballId}={gameSideId ?? "unconfirmed"}
                              </p>
                            ),
                          )}
                          <p>
                            Penalty segments:{" "}
                            {projection.suspension.snapshot.penalties.segments.length}
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          onClick={() =>
                            trigger("suspension", {
                              suspensionAction: "resume",
                              resumesSuspensionFactId: projection.suspension?.factId ?? undefined,
                            })
                          }
                          disabled={busy || projection.suspension?.factId === null}
                        >
                          Resume verified suspension
                        </Button>
                      </div>
                    )}
                  </div>
                ) : null}
                <Button variant="outline" onClick={() => trigger("result")} disabled={busy}>
                  Record result
                </Button>
              </div>
              {projection === null ? null : (
                <div className="space-y-3 max-[639px]:hidden">
                  <p className="text-sm text-muted-foreground">
                    Phase: {projection.phase} · Goals: {projection.goalCount}
                    {projection.overtime ? " · Overtime" : ""}
                  </p>
                  {projection.overtime ? (
                    <p data-overtime-target="true" className="text-sm font-semibold">
                      Overtime target: {projection.overtimeTarget ?? projection.targetScore ?? "—"}
                    </p>
                  ) : null}
                  {pendingClosePlayAdjudication === null ? null : (
                    <div
                      data-close-play-adjudication="true"
                      className="space-y-2 rounded-lg border border-amber-500/60 bg-amber-50 p-3 text-sm text-amber-950"
                    >
                      <p className="font-medium">Head Referee close goal/catch ordering</p>
                      <p>
                        The{" "}
                        {pendingClosePlayAdjudication.intentType === "record-goal"
                          ? "goal"
                          : "flag catch"}{" "}
                        has {pendingClosePlayAdjudication.relatedFacts.length} opposing close-play
                        candidate
                        {pendingClosePlayAdjudication.relatedFacts.length === 1 ? "" : "s"}. Choose
                        the exact paired fact and adjudicated sporting order without changing either
                        Game Clock time.
                      </p>
                      {pendingClosePlayAdjudication.relatedFacts.map((relatedFact) => (
                        <div
                          key={relatedFact.factId}
                          data-close-play-related-fact-id={relatedFact.factId}
                          className="space-y-1"
                        >
                          <p>
                            Existing {relatedFact.factType} at {relatedFact.gameTimeMs}
                          </p>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="outline"
                              onClick={() =>
                                submitClosePlayAdjudication("before", relatedFact.factId)
                              }
                              disabled={busy}
                            >
                              {pendingClosePlayAdjudication.intentType === "record-goal"
                                ? "Goal before catch"
                                : "Catch before goal"}
                            </Button>
                            <Button
                              variant="outline"
                              onClick={() =>
                                submitClosePlayAdjudication("after", relatedFact.factId)
                              }
                              disabled={busy}
                            >
                              {pendingClosePlayAdjudication.intentType === "record-goal"
                                ? "Goal after catch"
                                : "Catch after goal"}
                            </Button>
                          </div>
                        </div>
                      ))}
                      <div>
                        <Button
                          variant="ghost"
                          onClick={() => setPendingClosePlayAdjudication(null)}
                          disabled={busy}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                  {pendingFlagCatchBoundaryOverride === null ? null : (
                    <div
                      data-flag-catch-boundary-override="true"
                      className="space-y-2 rounded-lg border border-amber-500/60 bg-amber-50 p-3 text-sm text-amber-950"
                    >
                      <p className="font-medium">Head Referee flag-catch boundary override</p>
                      <p>
                        Confirm the catch despite unreleased seekers or running play. This records
                        the affected guardrail separately from any Sporting Order decision.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button onClick={submitFlagCatchBoundaryOverride} disabled={busy}>
                          Confirm boundary override
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => setPendingFlagCatchBoundaryOverride(null)}
                          disabled={busy}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Timeout: {projection.timeout?.status ?? "inactive"} · Stoppage:{" "}
                    {projection.stoppage?.status ?? "none"} · Heat:{" "}
                    {projection.heat?.status ?? "inactive"}
                    {projection.result === null || projection.result === undefined
                      ? ""
                      : projection.winnerGameSideId !== null &&
                          projection.winnerGameSideId !== undefined
                        ? ` · Winner: Game Side ${projection.winnerGameSideId}`
                        : isDoubleForfeitResult(projection.result)
                          ? " · Double-forfeit: no winner"
                          : " · Result recorded"}
                  </p>
                  {Object.entries(projection.scoreByGameSide).map(([gameSideId, score]) => (
                    <div key={gameSideId} className="flex items-center justify-between gap-3">
                      <span className="font-medium">Game Side {gameSideId}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-2xl font-semibold tabular-nums">{score}</span>
                        <Button onClick={() => recordGoal(gameSideId)} disabled={busy}>
                          Record 10-point goal
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => recordFlagCatch(gameSideId)}
                          disabled={busy}
                        >
                          Record flag catch
                        </Button>
                        {projection.overtime &&
                        projection.phase !== "finished" &&
                        projection.winnerGameSideId === null ? (
                          <Button
                            variant="outline"
                            onClick={() => recordConcession(gameSideId)}
                            disabled={busy}
                          >
                            Concede
                          </Button>
                        ) : null}
                        <Button
                          variant="outline"
                          onClick={() => recordForfeit(gameSideId)}
                          disabled={busy}
                        >
                          Directed forfeit
                        </Button>
                      </div>
                    </div>
                  ))}
                  <Button variant="outline" onClick={recordDoubleForfeit} disabled={busy}>
                    Record double-forfeit
                  </Button>
                  <div className="space-y-3 rounded-lg border p-3">
                    <p className="text-sm font-medium">Penalties</p>
                    {(livePenalties?.players ?? []).length === 0 ? (
                      <p className="text-sm text-muted-foreground">No active penalties.</p>
                    ) : (
                      (livePenalties?.players ?? []).map((player) => (
                        <div
                          key={player.playerKey}
                          className="flex items-center justify-between gap-3 text-sm"
                        >
                          <span>{formatPenaltyPlayerLabel(player.playerKey, livePenalties)}</span>
                          <span className="tabular-nums">
                            {formatClock(
                              player.segments.reduce(
                                (sum, segment) => sum + segment.remainingMs,
                                0,
                              ),
                            )}
                          </span>
                        </div>
                      ))
                    )}
                    {(livePenalties?.pendingExpirations ?? []).map((pending) => (
                      <div
                        key={pending.id}
                        className="space-y-2 rounded border border-amber-500/50 bg-amber-50 p-2 text-sm"
                      >
                        <p>
                          Goal release: choose a penalty ({formatClock(pending.serviceDurationMs)}).
                          {pending.requiresOfficialChoice
                            ? " Complete tie requires official choice."
                            : ""}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {pending.candidatePlayerKeys.map((playerKey) => (
                            <Button
                              key={playerKey}
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                resolvePenaltyExpiration(pending.id, pending.scoreFactId, playerKey)
                              }
                              disabled={busy}
                            >
                              Release {formatPenaltyPlayerLabel(playerKey, livePenalties)}
                            </Button>
                          ))}
                        </div>
                      </div>
                    ))}
                    {(livePenalties?.releases ?? []).map((release) => (
                      <p key={release.id} className="text-xs text-emerald-700">
                        Released {formatPenaltyPlayerLabel(release.playerKey, livePenalties)} after
                        {release.releaseCause === "foul-before-score"
                          ? " foul-before-score"
                          : " opposing score"}{" "}
                        at {formatClock(release.releasedMs)}.
                      </p>
                    ))}
                    {(livePenalties?.cards ?? []).map((card) => (
                      <div key={card.factId} className="flex flex-wrap items-center gap-2 text-xs">
                        <span>
                          {card.cardType} ·{" "}
                          {formatPenaltyPlayerLabel(card.playerKey, livePenalties, {
                            gameSideId: card.gameSideId,
                            playerNumber: card.playerNumber,
                          })}
                        </span>
                        <span>
                          {card.reason === null
                            ? skippedPenaltyReasonCardIds.has(card.factId)
                              ? "reason skipped; add later"
                              : "reason later/skipped"
                            : `reason: ${card.reason}`}
                        </span>
                        {card.reason === null ? (
                          <>
                            {(
                              [
                                ["contact-safety", "Contact/Safety"],
                                ["ball-interaction", "Ball Interaction"],
                                ["position-boundary", "Position/Boundary"],
                                ["procedure-substitution", "Procedure/Substitution"],
                                ["conduct", "Conduct"],
                                ["skip", "Skip"],
                              ] as const
                            ).map(([reason, label]) => (
                              <Button
                                key={reason}
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  reason === "skip"
                                    ? skipPenaltyReason(card.factId)
                                    : recordPenaltyReason(card.factId, reason as LivePenaltyReason)
                                }
                                disabled={busy}
                              >
                                {label}
                              </Button>
                            ))}
                          </>
                        ) : null}
                      </div>
                    ))}
                  </div>
                  <div className="space-y-2 rounded-lg border p-3">
                    <p className="text-sm font-medium">Game Facts</p>
                    {(projection.gameFacts ?? []).length === 0 ? (
                      <p className="text-sm text-muted-foreground">No Game Facts recorded.</p>
                    ) : (
                      (projection.gameFacts ?? []).map((fact) => (
                        <div
                          key={fact.factId}
                          data-game-fact-id={fact.factId}
                          className="flex items-center justify-between gap-3 text-sm"
                        >
                          <span className="min-w-0">
                            <span className="font-medium">{fact.factType}</span>
                            <code className="ml-2 text-xs text-muted-foreground">
                              {fact.factId}
                            </code>
                            <span className="ml-2 text-xs text-muted-foreground">
                              sporting {fact.sportingOrder} · sync {fact.synchronizationOrder}
                            </span>
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => correctFact(fact.factId, !fact.effective)}
                            disabled={busy}
                          >
                            {fact.effective ? "Correct" : "Reinstate"}
                          </Button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
              {replica !== null && replica.pendingActions.length > 0 ? (
                <p className="text-sm text-amber-700">
                  {replica.pendingActions.length} Controller action(s) retained for reconnect
                  replay.
                </p>
              ) : null}
              {durabilityWarning === null ? null : (
                <p role="alert" className="text-sm font-medium text-amber-700">
                  {durabilityWarning}
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

function flagCatchBoundaryOverride(gameTimeMs: number, running: boolean): OfficialOverrideMetadata {
  return {
    guardrail: "flag-catch-requires-seeker-release-and-stopped-play",
    direction: "head-referee-directed-flag-catch-boundary",
    confirmation: "head-referee-confirmed",
    authorityReference: "head-referee",
    gameTimeMs,
    beforeValue: {
      seekerReleased: gameTimeMs >= SEEKER_RELEASE_MS,
      running,
    },
    afterValue: { flagCatch: "accepted" },
    reason: "head-referee-direction",
  };
}

function formatClock(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function formatPenaltyPlayerLabel(
  playerKey: string | null,
  penalties: LivePenaltyProjection | null | undefined,
  fallback?: { gameSideId: string; playerNumber: number | null },
): string {
  const player =
    playerKey === null || penalties === null || penalties === undefined
      ? undefined
      : penalties.players.find((candidate) => candidate.playerKey === playerKey);
  const card =
    player === undefined && playerKey !== null && penalties !== null && penalties !== undefined
      ? penalties.cards.find((candidate) => candidate.playerKey === playerKey)
      : undefined;
  const gameSideId = player?.gameSideId ?? card?.gameSideId ?? fallback?.gameSideId ?? "unknown";
  const playerNumber = player?.playerNumber ?? card?.playerNumber ?? fallback?.playerNumber ?? null;
  return `Game Side ${gameSideId} · ${
    playerNumber === null ? "Player unknown" : `Player #${playerNumber}`
  }`;
}

function formatSynchronizationTime(milliseconds: number | null | undefined): string {
  return typeof milliseconds !== "number" ? "not available" : new Date(milliseconds).toISOString();
}

function isDoubleForfeitResult(result: ControllerProjection["result"]): boolean {
  return (
    result !== null &&
    result !== undefined &&
    typeof result.data === "object" &&
    result.data !== null &&
    !Array.isArray(result.data) &&
    result.data.resultKind === "double-forfeit"
  );
}

function readMonotonicNow(): number {
  return typeof performance === "undefined" ? 0 : performance.now();
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

function replicaMatchesAuthority(
  state: ControllerReplicaState,
  authority: ReplayAuthority,
): boolean {
  return (
    state.eventGameId === authority.eventGameId &&
    state.replicaGeneration === authority.replicaGeneration &&
    state.session.grantSessionId === authority.grantSessionId &&
    state.session.grantVersion === authority.grantVersion
  );
}

function readPersistedControllerSession(): PersistedControllerSession | null {
  try {
    const raw = window.sessionStorage.getItem("quadball:event-controller-session");
    if (raw === null) return null;
    const value = JSON.parse(raw) as Partial<PersistedControllerSession>;
    return typeof value.sessionBearer === "string" && typeof value.eventGameId === "string"
      ? { sessionBearer: value.sessionBearer, eventGameId: value.eventGameId }
      : null;
  } catch {
    return null;
  }
}

function readPersistedControllerReplica(eventGameId: string | undefined): ControllerReplicaLoad {
  try {
    if (typeof window === "undefined") {
      return { state: null, warning: null, quarantined: false };
    }
    return loadControllerReplica(browserReplicaStorage(eventGameId), eventGameId);
  } catch {
    return {
      state: null,
      warning: "Controller recovery storage is unavailable; changes remain in memory.",
      quarantined: false,
    };
  }
}

function browserReplicaStorage(eventGameId?: string): ControllerReplicaStorage {
  const storageKey = controllerReplicaStorageKey(eventGameId);
  return {
    read: () => window.localStorage.getItem(storageKey),
    write: (value) => window.localStorage.setItem(storageKey, value),
    quarantine: (value) => window.localStorage.setItem(`${storageKey}:quarantine`, value),
  };
}

function emptyProjection(eventGameId: string): ControllerProjection {
  return {
    eventGameId,
    phase: "scheduled",
    scoreByGameSide: {},
    goalCount: 0,
    clock: projectClockBaseline(createInitialClockBaseline(), 0),
    commencement: {
      status: "provisional",
      commencedAtMs: null,
      provisionalRunningSinceMs: null,
      provisionalElapsedMs: 0,
    },
  };
}
