import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createInitialClockBaseline,
  projectClockBaseline,
  projectClockSample,
} from "@/lib/clock-authority";
import type {
  ControllerProjection,
  LiveEventGameControlResult,
  LiveEventControllerIntent,
} from "@/lib/live-event-game-control";
import { LIVE_EVENT_CONTROL_INTENT_VERSION } from "@/lib/live-event-game-control";
import { validateGameClockMs } from "@/lib/validation-policy";
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

type ClockReceiptAnchor = {
  projection: ControllerProjection["clock"];
  localMonotonicMs: number;
};

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
  const [clockReceiptAnchor, setClockReceiptAnchor] = useState<ClockReceiptAnchor | null>(null);
  const [localMonotonicMs, setLocalMonotonicMs] = useState(readMonotonicNow);
  const [clockCorrectionInput, setClockCorrectionInput] = useState("");
  const [takeoverAdjustmentInput, setTakeoverAdjustmentInput] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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

  async function openController() {
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
        qrCredential,
        browserContext,
      });
      if (response.status !== "opened") throw new Error("open failed");
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

  function correctFact(factId: string, effective: boolean) {
    queueIntent({
      version: LIVE_EVENT_CONTROL_INTENT_VERSION,
      type: "correct-fact",
      operationId: crypto.randomUUID(),
      factId: crypto.randomUUID(),
      targetFactId: factId,
      effective,
      gameTimeMs: projection?.clock.gameTimeMs ?? 0,
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

  function queueIntent(candidate: LiveEventControllerIntent) {
    const current = replicaRef.current;
    if (current === null) return;
    try {
      const dispatched = dispatchControllerAction(current, {
        ...candidate,
        occurrence: {
          ...candidate.occurrence,
          source: navigator.onLine === false ? "offline" : "online",
        },
      });
      replicaRef.current = dispatched.state;
      setReplica(dispatched.state);
      setProjection(dispatched.state.projection);
      setProjectionStatus("available");
      void flushReplica(dispatched.state);
    } catch {
      setMessage("The Controller action could not be retained safely.");
    }
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
                <div className="space-y-1 rounded-lg border border-amber-500/50 bg-amber-50 p-3 text-sm text-amber-950">
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
                <div className="flex w-full flex-wrap items-end gap-2 rounded border p-2 text-left">
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
                <div className="flex w-full flex-wrap items-end gap-2 rounded border border-amber-500/50 p-2 text-left">
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
                  <p className="text-xs text-muted-foreground">
                    Timeout: {projection.timeout?.status ?? "inactive"} · Stoppage:{" "}
                    {projection.stoppage?.status ?? "none"} · Heat:{" "}
                    {projection.heat?.status ?? "inactive"}
                    {projection.result === null || projection.result === undefined
                      ? ""
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
                      </div>
                    </div>
                  ))}
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

function formatClock(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function formatSynchronizationTime(milliseconds: number | null | undefined): string {
  return typeof milliseconds !== "number" ? "not available" : new Date(milliseconds).toISOString();
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
