import { clearAdHocControllerSession } from "@/lib/ad-hoc-controller-session";
import {
  createBrowserEventControllerSessionStorage,
  legacyEventControllerSessionReference,
} from "@/lib/event-controller-session";
import { controllerReplicaStorageKey, parseControllerReplica } from "@/lib/controller-reconnect";
import { validateOpaqueIdentifier } from "@/lib/validation-policy";

export const CONTROLLER_LEAVE_GRACE_MS = 5 * 60_000;
export const CONTROLLER_DEPARTURE_STORAGE_KEY = "quadball:controller-departure";
const CONTROLLER_DEPARTURE_VERSION = "controller-departure-v3" as const;
const PREVIOUS_CONTROLLER_DEPARTURE_VERSION = "controller-departure-v2" as const;
const LEGACY_CONTROLLER_DEPARTURE_VERSION = "controller-departure-v1" as const;
const AD_HOC_CONTROLLER_STORAGE_PREFIX = "quadball:ad-hoc-controller:";
export { EVENT_CONTROLLER_SESSION_STORAGE_KEY } from "@/lib/event-controller-session";

export type ControllerDepartureWorkflow = "ad-hoc" | "event";

export type ControllerDepartureReference = {
  workflow: ControllerDepartureWorkflow;
  gameId: string;
  /** Non-secret local reference to the exact Event Grant Session. */
  sessionReferenceId?: string;
  navigationPath: string;
  identity: { title: string; homeName: string; awayName: string; detail?: string };
};

type ControllerDepartureStateFields = {
  /** Values are workflow-qualified (`ad-hoc:<id>` or `event:<id>`). */
  blockedGameIds: string[];
  pendingFinalizations: ControllerDepartureReference[];
  reconciliationPending: ControllerDepartureReference[];
};

type Revisioned = { revision: number };

type ControllerDepartureState =
  | { status: "empty" }
  | { status: "failed-closed" }
  | ({
      status: "returnable";
      departure: ControllerDepartureReference;
      expiresAtMs: number;
    } & ControllerDepartureStateFields)
  | ({ status: "returned" } & ControllerDepartureStateFields)
  | ({ status: "blocked"; gameId: string } & ControllerDepartureStateFields);

type WithRevision<T> = T extends unknown ? T & Revisioned : never;

export type ControllerDepartureProjection = WithRevision<ControllerDepartureState>;

export type ControllerDepartureDestination =
  | { kind: "new-ad-hoc" }
  | { kind: "admit-ad-hoc"; gameId: string }
  | { kind: "resume-ad-hoc"; gameId: string }
  | { kind: "admit-event" }
  | { kind: "resume-event"; gameId: string; sessionReferenceId?: string };

export type ControllerDepartureEntryRequest = {
  id: string;
  destination: ControllerDepartureDestination;
  revision: number;
};

export type ControllerDepartureEntryAuthorization = {
  id: string;
  destination: ControllerDepartureDestination;
  revision: number;
};

export type ControllerDepartureEntryCompletion = ControllerDepartureEntryAuthorization;

export type ControllerDepartureIntent =
  | { type: "leave"; departure: ControllerDepartureReference; nowMs?: number; online?: boolean }
  | { type: "return"; gameId: string; online: boolean; nowMs?: number }
  | { type: "expire"; online: boolean; nowMs?: number }
  | {
      type: "request-entry";
      destination: ControllerDepartureDestination;
      online?: boolean;
      nowMs?: number;
    }
  | { type: "confirm-entry"; request: ControllerDepartureEntryRequest; online?: boolean }
  | { type: "cancel-entry"; request: ControllerDepartureEntryRequest }
  | { type: "commit-entry"; authorization: ControllerDepartureEntryAuthorization }
  | {
      type: "complete-entry";
      completion: ControllerDepartureEntryCompletion;
      succeeded: boolean;
    };

export type ControllerDepartureOutcome =
  | { status: "left"; projection: ControllerDepartureProjection }
  | { status: "resumed"; mode: "online" | "offline" }
  | { status: "unavailable" }
  | { status: "expired"; finalization: "accepted" | "deferred" | "unavailable" }
  | { status: "no-op" }
  | {
      status: "needs-confirmation";
      departure: ControllerDepartureReference;
      request: ControllerDepartureEntryRequest;
    }
  | { status: "authorized"; authorization: ControllerDepartureEntryAuthorization }
  | { status: "committed"; completion?: ControllerDepartureEntryCompletion }
  | { status: "cancelled" };

export type ControllerDepartureClock = {
  now(): number;
  schedule(delayMs: number, callback: () => void): unknown;
  cancel(handle: unknown): void;
};

export type ControllerDeparturePersistence = {
  read(): ControllerDepartureProjection;
  write(projection: ControllerDepartureProjection): boolean | void;
  clear(): void;
  subscribe?(callback: () => void): () => void;
};

export type ControllerDepartureAuthority = {
  finalize(
    departure: ControllerDepartureReference,
  ): Promise<"accepted" | "deferred" | "unavailable">;
  reconcile(
    departure: ControllerDepartureReference,
  ): Promise<"available" | "transient" | "unavailable">;
};

export type ControllerDepartureAuthorityAdapters = {
  adHoc: ControllerDepartureAuthority;
  event: ControllerDepartureAuthority;
};

export type ControllerDepartureConnectivity = {
  isOnline(): boolean;
  onOnline(callback: () => void): () => void;
};

export type ControllerDepartureReplica = {
  clear(departure: ControllerDepartureReference): void;
  clearAll(): void;
};

export type ControllerDepartureReplicaAdapters = {
  adHoc: ControllerDepartureReplica;
  event: ControllerDepartureReplica;
};

export type ControllerDepartureAdapters = {
  clock: ControllerDepartureClock;
  persistence: ControllerDeparturePersistence;
  authority?: ControllerDepartureAuthority;
  authorities?: ControllerDepartureAuthorityAdapters;
  connectivity: ControllerDepartureConnectivity;
  replica?: ControllerDepartureReplica;
  replicas?: ControllerDepartureReplicaAdapters;
};

export type ControllerDepartureModule = {
  project(): ControllerDepartureProjection;
  transition(intent: ControllerDepartureIntent): Promise<ControllerDepartureOutcome>;
  subscribe(callback: () => void): () => void;
  dispose(): void;
};

export function controllerDepartureBlocksGame(
  projection: ControllerDepartureProjection,
  workflow: ControllerDepartureWorkflow,
  gameId: string,
  sessionReferenceId?: string,
): boolean;
export function controllerDepartureBlocksGame(
  projection: ControllerDepartureProjection,
  gameId: string,
): boolean;
export function controllerDepartureBlocksGame(
  projection: ControllerDepartureProjection,
  workflowOrGameId: string,
  maybeGameId?: string,
  sessionReferenceId?: string,
): boolean {
  const key =
    maybeGameId === undefined
      ? lifecycleKey("ad-hoc", workflowOrGameId)
      : lifecycleKey(
          workflowOrGameId as ControllerDepartureWorkflow,
          maybeGameId,
          sessionReferenceId,
        );
  return (
    projection.status === "failed-closed" ||
    (projection.status !== "empty" && projection.blockedGameIds.includes(key))
  );
}

export function createControllerDeparture(
  adapters: Partial<ControllerDepartureAdapters> = {},
): ControllerDepartureModule {
  const clock = adapters.clock ?? createBrowserClock();
  const persistence = adapters.persistence ?? createBrowserPersistence();
  const authorities =
    adapters.authorities ??
    (adapters.authority === undefined
      ? { adHoc: createBrowserAdHocAuthority(), event: createBrowserEventAuthority() }
      : { adHoc: adapters.authority, event: adapters.authority });
  const connectivity = adapters.connectivity ?? createBrowserConnectivity();
  const replicas =
    adapters.replicas ??
    (adapters.replica === undefined
      ? { adHoc: createBrowserAdHocReplica(), event: createBrowserEventReplica() }
      : { adHoc: adapters.replica, event: adapters.replica });
  let expiryHandle: unknown = null;
  let disposed = false;
  let lifecycleQueue = Promise.resolve();
  let entryCounter = 0;
  let writingPersistence = false;
  const pendingEntries = new Map<string, ControllerDepartureEntryRequest>();
  const issuedAuthorizations = new Map<string, ControllerDepartureEntryAuthorization>();
  const invalidatedAuthorizations = new Map<string, ControllerDepartureEntryAuthorization>();
  const pendingCompletions = new Map<string, ControllerDepartureEntryCompletion>();
  const subscribers = new Set<() => void>();

  const readStored = (): ControllerDepartureProjection => {
    try {
      return normalizeProjection(persistence.read());
    } catch {
      return { status: "failed-closed", revision: 0 };
    }
  };
  const notify = () => {
    for (const callback of subscribers) callback();
  };
  const invalidateAuthorizations = () => {
    for (const [id, authorization] of issuedAuthorizations)
      invalidatedAuthorizations.set(id, authorization);
    issuedAuthorizations.clear();
  };
  const writeFrom = (
    base: ControllerDepartureProjection,
    next: ControllerDepartureState,
  ): ControllerDepartureProjection | null => {
    const latest = readStored();
    if (latest.revision !== base.revision) return null;
    const revisioned = { ...next, revision: base.revision + 1 } as ControllerDepartureProjection;
    try {
      writingPersistence = true;
      const written = persistence.write(revisioned) !== false;
      writingPersistence = false;
      if (!written) return null;
      invalidateAuthorizations();
      notify();
      return revisioned;
    } catch {
      writingPersistence = false;
      return null;
    }
  };
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = lifecycleQueue.then(operation, operation);
    lifecycleQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const authorityFor = (workflow: ControllerDepartureWorkflow) =>
    authorities[workflow === "event" ? "event" : "adHoc"];
  const replicaFor = (workflow: ControllerDepartureWorkflow) =>
    replicas[workflow === "event" ? "event" : "adHoc"];
  const clearReplica = (departure: ControllerDepartureReference) => {
    try {
      replicaFor(departure.workflow).clear(departure);
    } catch {
      // Persisted fail-closed state remains authoritative for this browser.
    }
  };
  const clearAllReplicas = () => {
    try {
      replicas.adHoc.clearAll();
      replicas.event.clearAll();
    } catch {
      // The failed-closed projection still prevents retained replicas from being used.
    }
  };
  const scheduleExpiry = (expiresAtMs: number) => {
    if (expiryHandle !== null) clock.cancel(expiryHandle);
    expiryHandle = clock.schedule(Math.max(0, expiresAtMs - clock.now()), () => {
      expiryHandle = null;
      void transition({ type: "expire", online: connectivity.isOnline(), nowMs: clock.now() });
    });
  };
  const cancelExpiry = () => {
    if (expiryHandle !== null) clock.cancel(expiryHandle);
    expiryHandle = null;
  };
  const newEntryId = () => {
    entryCounter += 1;
    return `entry-${entryCounter}`;
  };
  const issueAuthorization = (
    destination: ControllerDepartureDestination,
    revision: number,
  ): ControllerDepartureOutcome => {
    const authorization = { id: newEntryId(), destination, revision };
    issuedAuthorizations.set(authorization.id, authorization);
    return { status: "authorized", authorization };
  };
  const requestConfirmation = (
    departure: ControllerDepartureReference,
    destination: ControllerDepartureDestination,
    revision: number,
  ): ControllerDepartureOutcome => {
    const request = { id: newEntryId(), destination, revision };
    pendingEntries.set(request.id, request);
    return { status: "needs-confirmation", departure, request };
  };

  const callFinalizations = async (departures: ControllerDepartureReference[]) => {
    const results = new Map<string, "accepted" | "deferred" | "unavailable">();
    for (const departure of departures) {
      let result: "accepted" | "deferred" | "unavailable" = "deferred";
      try {
        result = await authorityFor(departure.workflow).finalize(departure);
      } catch {
        result = "deferred";
      }
      results.set(departureKey(departure), result);
    }
    return results;
  };
  const callReconciliations = async (departures: ControllerDepartureReference[]) => {
    const results = new Map<string, "available" | "transient" | "unavailable">();
    for (const departure of departures) {
      let result: "available" | "transient" | "unavailable" = "transient";
      try {
        result = await authorityFor(departure.workflow).reconcile(departure);
      } catch {
        result = "transient";
      }
      results.set(departureKey(departure), result);
    }
    return results;
  };
  const settleAuthorityResults = (
    finalizations: Map<string, "accepted" | "deferred" | "unavailable">,
    reconciliations: Map<string, "available" | "transient" | "unavailable">,
  ) => {
    const latest = readStored();
    if (latest.status === "empty" || latest.status === "failed-closed") return latest;
    const fields = projectionFields(latest);
    const pendingFinalizations = fields.pendingFinalizations.filter(
      (departure) =>
        finalizations.get(departureKey(departure)) === "deferred" ||
        !finalizations.has(departureKey(departure)),
    );
    const reconciliationPending = fields.reconciliationPending.filter(
      (departure) =>
        reconciliations.get(departureKey(departure)) === "transient" ||
        !reconciliations.has(departureKey(departure)),
    );
    const unavailableDepartureKeys = [
      ...[...finalizations].filter(([, result]) => result === "unavailable").map(([key]) => key),
      ...[...reconciliations].filter(([, result]) => result === "unavailable").map(([key]) => key),
    ];
    const unavailableGameIds = unavailableDepartureKeys.map((key) => {
      const departure = [...fields.pendingFinalizations, ...fields.reconciliationPending].find(
        (candidate) => departureKey(candidate) === key,
      );
      return departure === undefined ? key : blockedDepartureKey(departure);
    });
    const blockedGameIds = unique([...fields.blockedGameIds, ...unavailableGameIds]);
    if (
      sameDepartures(pendingFinalizations, fields.pendingFinalizations) &&
      sameDepartures(reconciliationPending, fields.reconciliationPending) &&
      sameStrings(blockedGameIds, fields.blockedGameIds)
    )
      return latest;
    const written = writeFrom(latest, {
      ...withoutRevision(latest),
      blockedGameIds,
      pendingFinalizations,
      reconciliationPending,
    } as ControllerDepartureState);
    if (written !== null) {
      for (const key of unavailableDepartureKeys) {
        const departure = [...fields.pendingFinalizations, ...fields.reconciliationPending].find(
          (candidate) => departureKey(candidate) === key,
        );
        if (departure !== undefined) clearReplica(departure);
      }
      return written;
    }
    return readStored();
  };
  const retryPending = async () => {
    if (disposed || !connectivity.isOnline()) return;
    const snapshot = readStored();
    if (snapshot.status === "empty" || snapshot.status === "failed-closed") return;
    const fields = projectionFields(snapshot);
    if (fields.pendingFinalizations.length === 0 && fields.reconciliationPending.length === 0)
      return;
    const finalizations = await callFinalizations(fields.pendingFinalizations);
    const reconciliations = await callReconciliations(fields.reconciliationPending);
    settleAuthorityResults(finalizations, reconciliations);
  };
  const queueRetry = () => {
    void enqueue(retryPending);
  };

  const expire = async (online: boolean, nowMs: number): Promise<ControllerDepartureOutcome> => {
    const current = readStored();
    if (current.status !== "returnable" || current.expiresAtMs > nowMs) return { status: "no-op" };
    const pendingFinalizations = uniqueDepartures([
      ...current.pendingFinalizations,
      current.departure,
    ]);
    const next = writeFrom(current, {
      status: "blocked",
      gameId: current.departure.gameId,
      blockedGameIds: unique([...current.blockedGameIds, blockedDepartureKey(current.departure)]),
      pendingFinalizations,
      reconciliationPending: current.reconciliationPending,
    });
    if (next === null) return { status: "unavailable" };
    cancelExpiry();
    clearReplica(current.departure);
    if (!online) return { status: "expired", finalization: "deferred" };
    const results = await callFinalizations(pendingFinalizations);
    settleAuthorityResults(results, new Map());
    return {
      status: "expired",
      finalization: results.get(departureKey(current.departure)) ?? "deferred",
    };
  };

  const leave = async (
    intent: Extract<ControllerDepartureIntent, { type: "leave" }>,
    nowMs: number,
  ): Promise<ControllerDepartureOutcome> => {
    let current = readStored();
    if (current.status === "returnable" && current.expiresAtMs <= nowMs) {
      await expire(intent.online ?? connectivity.isOnline(), nowMs);
      current = readStored();
    }
    if (current.status === "failed-closed") return { status: "unavailable" };
    const fields = projectionFields(current);
    const superseded = current.status === "returnable" ? current.departure : null;
    const pendingFinalizations =
      superseded === null
        ? fields.pendingFinalizations
        : uniqueDepartures([...fields.pendingFinalizations, superseded]);
    const blockedGameIds =
      superseded === null
        ? fields.blockedGameIds
        : unique([...fields.blockedGameIds, blockedDepartureKey(superseded)]);
    const next = writeFrom(current, {
      status: "returnable",
      departure: intent.departure,
      expiresAtMs: nowMs + CONTROLLER_LEAVE_GRACE_MS,
      blockedGameIds,
      pendingFinalizations,
      reconciliationPending: fields.reconciliationPending,
    });
    if (next === null) return { status: "unavailable" };
    if (superseded !== null) clearReplica(superseded);
    if ((intent.online ?? connectivity.isOnline()) && pendingFinalizations.length > 0) {
      const results = await callFinalizations(pendingFinalizations);
      settleAuthorityResults(results, new Map());
    }
    const latest = readStored();
    if (
      latest.status === "returnable" &&
      departureKey(latest.departure) === departureKey(intent.departure)
    )
      scheduleExpiry(latest.expiresAtMs);
    return { status: "left", projection: latest };
  };

  const returnToGame = async (
    gameId: string,
    online: boolean,
  ): Promise<ControllerDepartureOutcome> => {
    const current = readStored();
    if (current.status !== "returnable" || current.departure.gameId !== gameId)
      return { status: "unavailable" };
    if (!online) {
      const next = writeFrom(current, {
        status: "returned",
        blockedGameIds: current.blockedGameIds,
        pendingFinalizations: current.pendingFinalizations,
        reconciliationPending: uniqueDepartures([
          ...current.reconciliationPending,
          current.departure,
        ]),
      });
      if (next === null) return { status: "unavailable" };
      cancelExpiry();
      return { status: "resumed", mode: "offline" };
    }
    const departure = current.departure;
    const results = await callReconciliations([departure]);
    const latest = readStored();
    if (
      latest.revision !== current.revision ||
      latest.status !== "returnable" ||
      latest.departure.gameId !== gameId
    )
      return { status: "unavailable" };
    const result = results.get(departureKey(departure)) ?? "transient";
    if (result === "unavailable") {
      const next = writeFrom(latest, {
        status: "blocked",
        gameId,
        blockedGameIds: unique([...latest.blockedGameIds, blockedDepartureKey(departure)]),
        pendingFinalizations: latest.pendingFinalizations,
        reconciliationPending: latest.reconciliationPending,
      });
      if (next === null) return { status: "unavailable" };
      cancelExpiry();
      clearReplica(departure);
      return { status: "unavailable" };
    }
    const next = writeFrom(latest, {
      status: "returned",
      blockedGameIds: latest.blockedGameIds,
      pendingFinalizations: latest.pendingFinalizations,
      reconciliationPending:
        result === "transient"
          ? uniqueDepartures([...latest.reconciliationPending, departure])
          : latest.reconciliationPending,
    });
    if (next === null) return { status: "unavailable" };
    cancelExpiry();
    if (result === "transient") queueRetry();
    return { status: "resumed", mode: "online" };
  };

  const requestEntry = async (
    destination: ControllerDepartureDestination,
    online: boolean,
    nowMs: number,
  ): Promise<ControllerDepartureOutcome> => {
    let current = readStored();
    if (current.status === "returnable" && current.expiresAtMs <= nowMs) {
      await expire(online, nowMs);
      current = readStored();
    }
    if (current.status === "failed-closed") {
      return destination.kind === "resume-ad-hoc" || destination.kind === "resume-event"
        ? { status: "unavailable" }
        : issueAuthorization(destination, current.revision);
    }
    const gameId = destinationGameId(destination);
    if (
      gameId !== null &&
      controllerDepartureBlocksGame(
        current,
        destination.kind === "resume-event" ? "event" : "ad-hoc",
        gameId,
        destination.kind === "resume-event" ? destination.sessionReferenceId : undefined,
      )
    )
      return { status: "unavailable" };
    if (
      (destination.kind === "resume-ad-hoc" || destination.kind === "resume-event") &&
      current.status === "returnable" &&
      destinationMatchesDeparture(current.departure, destination)
    ) {
      const returned = await returnToGame(destination.gameId, online);
      if (returned.status !== "resumed") return returned;
      current = readStored();
      return issueAuthorization(destination, current.revision);
    }
    if (current.status === "returnable")
      return requestConfirmation(current.departure, destination, current.revision);
    return issueAuthorization(destination, current.revision);
  };

  const confirmEntry = async (
    request: ControllerDepartureEntryRequest,
    online: boolean,
  ): Promise<ControllerDepartureOutcome> => {
    const pending = pendingEntries.get(request.id);
    if (pending === undefined || !destinationMatches(pending.destination, request.destination))
      return { status: "unavailable" };
    const current = readStored();
    if (
      pending.revision !== request.revision ||
      current.revision !== request.revision ||
      current.status !== "returnable"
    ) {
      pendingEntries.delete(request.id);
      return requestEntry(request.destination, online, clock.now());
    }
    const pendingFinalizations = uniqueDepartures([
      ...current.pendingFinalizations,
      current.departure,
    ]);
    const next = writeFrom(current, {
      status: "blocked",
      gameId: current.departure.gameId,
      blockedGameIds: unique([...current.blockedGameIds, blockedDepartureKey(current.departure)]),
      pendingFinalizations,
      reconciliationPending: current.reconciliationPending,
    });
    if (next === null) return { status: "unavailable" };
    pendingEntries.delete(request.id);
    clearReplica(current.departure);
    if (online) {
      const results = await callFinalizations(pendingFinalizations);
      settleAuthorityResults(results, new Map());
    }
    const latest = readStored();
    if (latest.status === "returnable")
      return requestConfirmation(latest.departure, request.destination, latest.revision);
    return issueAuthorization(request.destination, latest.revision);
  };

  const commitEntry = async (
    authorization: ControllerDepartureEntryAuthorization,
  ): Promise<ControllerDepartureOutcome> => {
    const issued = issuedAuthorizations.get(authorization.id);
    const invalidated = invalidatedAuthorizations.get(authorization.id);
    issuedAuthorizations.delete(authorization.id);
    invalidatedAuthorizations.delete(authorization.id);
    const current = readStored();
    const known = issued ?? invalidated;
    if (known === undefined) return { status: "unavailable" };
    if (
      !destinationMatches(known.destination, authorization.destination) ||
      known.revision !== authorization.revision
    )
      return { status: "unavailable" };
    if (invalidated !== undefined || current.revision !== authorization.revision)
      return requestEntry(authorization.destination, connectivity.isOnline(), clock.now());
    if (
      current.status === "failed-closed" &&
      (authorization.destination.kind === "resume-ad-hoc" ||
        authorization.destination.kind === "resume-event")
    )
      return { status: "unavailable" };
    const completion = { ...authorization };
    pendingCompletions.set(completion.id, completion);
    return { status: "committed", completion };
  };

  const completeEntry = async (
    completion: ControllerDepartureEntryCompletion,
    succeeded: boolean,
  ): Promise<ControllerDepartureOutcome> => {
    const pending = pendingCompletions.get(completion.id);
    pendingCompletions.delete(completion.id);
    if (
      pending === undefined ||
      !destinationMatches(pending.destination, completion.destination) ||
      pending.revision !== completion.revision
    )
      return { status: "unavailable" };
    if (!succeeded) return { status: "committed" };
    const current = readStored();
    if (current.revision !== completion.revision) return { status: "committed" };
    if (current.status !== "failed-closed") return { status: "committed" };
    return writeFrom(current, { status: "empty" }) === null
      ? { status: "unavailable" }
      : { status: "committed" };
  };

  const transitionInternal = async (
    intent: ControllerDepartureIntent,
  ): Promise<ControllerDepartureOutcome> => {
    const nowMs = "nowMs" in intent && intent.nowMs !== undefined ? intent.nowMs : clock.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) return { status: "unavailable" };
    switch (intent.type) {
      case "leave":
        return leave(intent, nowMs);
      case "return":
        return returnToGame(intent.gameId, intent.online);
      case "expire":
        return expire(intent.online, nowMs);
      case "request-entry":
        return requestEntry(intent.destination, intent.online ?? connectivity.isOnline(), nowMs);
      case "confirm-entry":
        return confirmEntry(intent.request, intent.online ?? connectivity.isOnline());
      case "cancel-entry":
        pendingEntries.delete(intent.request.id);
        return { status: "cancelled" };
      case "commit-entry":
        return commitEntry(intent.authorization);
      case "complete-entry":
        return completeEntry(intent.completion, intent.succeeded);
    }
  };
  const transition = (intent: ControllerDepartureIntent) =>
    enqueue(() => transitionInternal(intent));

  let initial = readStored();
  if (initial.status === "failed-closed") {
    clearAllReplicas();
    initial = writeFrom(initial, { status: "failed-closed" }) ?? {
      status: "failed-closed",
      revision: initial.revision,
    };
  }
  if (initial.status === "returnable") scheduleExpiry(initial.expiresAtMs);
  const removeOnlineListener = connectivity.onOnline(queueRetry);
  const removePersistenceListener =
    persistence.subscribe?.(() => {
      if (writingPersistence) return;
      invalidateAuthorizations();
      const current = readStored();
      if (current.status === "failed-closed") clearAllReplicas();
      if (current.status === "returnable") scheduleExpiry(current.expiresAtMs);
      else cancelExpiry();
      notify();
      queueRetry();
    }) ?? (() => undefined);
  if (
    connectivity.isOnline() &&
    initial.status !== "empty" &&
    initial.status !== "failed-closed" &&
    (initial.pendingFinalizations.length > 0 || initial.reconciliationPending.length > 0)
  )
    queueRetry();

  return {
    project() {
      const projection = readStored();
      if (projection.status !== "returnable" || projection.expiresAtMs > clock.now())
        return projection;
      return {
        status: "blocked",
        gameId: projection.departure.gameId,
        revision: projection.revision,
        blockedGameIds: unique([
          ...projection.blockedGameIds,
          blockedDepartureKey(projection.departure),
        ]),
        pendingFinalizations: uniqueDepartures([
          ...projection.pendingFinalizations,
          projection.departure,
        ]),
        reconciliationPending: projection.reconciliationPending,
      };
    },
    transition,
    subscribe(callback) {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
    dispose() {
      disposed = true;
      cancelExpiry();
      removeOnlineListener();
      removePersistenceListener();
      pendingEntries.clear();
      issuedAuthorizations.clear();
      invalidatedAuthorizations.clear();
      subscribers.clear();
    },
  };
}

const browserModules = new WeakMap<object, ControllerDepartureModule>();

export function getBrowserControllerDeparture(): ControllerDepartureModule {
  const owner = typeof window === "undefined" ? globalThis : window;
  const existing = browserModules.get(owner);
  if (existing !== undefined) return existing;
  const created = createControllerDeparture();
  browserModules.set(owner, created);
  return created;
}

export function createInMemoryControllerDepartureAdapters(
  options: {
    nowMs?: number;
    departure?: ControllerDepartureReference;
    expiresAtMs?: number;
    projection?: ControllerDepartureProjection;
    finalize?: ControllerDepartureAuthority["finalize"];
    reconcile?: ControllerDepartureAuthority["reconcile"];
    eventFinalize?: ControllerDepartureAuthority["finalize"];
    eventReconcile?: ControllerDepartureAuthority["reconcile"];
  } = {},
): ControllerDepartureAdapters & {
  advanceTo(nowMs: number): void;
  setOnline(value: boolean): void;
  clearedReplicas: string[];
  clearedReplicaReferences: ControllerDepartureReference[];
  clearAllCount: number;
} {
  let nowMs = options.nowMs ?? 0;
  let online = true;
  let projection: ControllerDepartureProjection =
    options.projection ??
    (options.departure === undefined
      ? { status: "empty", revision: 0 }
      : {
          status: "returnable",
          revision: 0,
          departure: options.departure,
          expiresAtMs: options.expiresAtMs ?? nowMs + CONTROLLER_LEAVE_GRACE_MS,
          blockedGameIds: [],
          pendingFinalizations: [],
          reconciliationPending: [],
        });
  const scheduled = new Map<number, () => void>();
  const onlineListeners = new Set<() => void>();
  const persistenceListeners = new Set<() => void>();
  const clearedReplicas: string[] = [];
  const clearedReplicaReferences: ControllerDepartureReference[] = [];
  let clearAllCount = 0;
  let nextHandle = 0;
  const adapters = {
    clock: {
      now: () => nowMs,
      schedule(delayMs: number, callback: () => void) {
        const handle = nextHandle++;
        scheduled.set(handle, callback);
        return handle;
      },
      cancel(handle: unknown) {
        if (typeof handle === "number") scheduled.delete(handle);
      },
    },
    persistence: {
      read: () => projection,
      write(next: ControllerDepartureProjection) {
        projection = next;
        for (const callback of persistenceListeners) callback();
      },
      clear() {
        projection = { status: "empty", revision: projection.revision + 1 };
        for (const callback of persistenceListeners) callback();
      },
      subscribe(callback: () => void) {
        persistenceListeners.add(callback);
        return () => persistenceListeners.delete(callback);
      },
    },
    authority: {
      finalize: options.finalize ?? (async () => "accepted" as const),
      reconcile: options.reconcile ?? (async () => "available" as const),
    },
    authorities: {
      adHoc: {
        finalize: options.finalize ?? (async () => "accepted" as const),
        reconcile: options.reconcile ?? (async () => "available" as const),
      },
      event: {
        finalize: options.eventFinalize ?? options.finalize ?? (async () => "accepted" as const),
        reconcile:
          options.eventReconcile ?? options.reconcile ?? (async () => "available" as const),
      },
    },
    connectivity: {
      isOnline: () => online,
      onOnline(callback: () => void) {
        onlineListeners.add(callback);
        return () => onlineListeners.delete(callback);
      },
    },
    replica: {
      clear: (departure: ControllerDepartureReference) => {
        clearedReplicas.push(departure.gameId);
        clearedReplicaReferences.push(departure);
      },
      clearAll: () => {
        clearAllCount += 1;
        adapters.clearAllCount = clearAllCount;
      },
    },
    replicas: {
      adHoc: {
        clear: (departure: ControllerDepartureReference) => {
          clearedReplicas.push(departure.gameId);
          clearedReplicaReferences.push(departure);
        },
        clearAll: () => {
          clearAllCount += 1;
          adapters.clearAllCount = clearAllCount;
        },
      },
      event: {
        clear: (departure: ControllerDepartureReference) => {
          clearedReplicas.push(departure.gameId);
          clearedReplicaReferences.push(departure);
        },
        clearAll: () => undefined,
      },
    },
    advanceTo(value: number) {
      nowMs = value;
      for (const [handle, callback] of scheduled) {
        scheduled.delete(handle);
        callback();
      }
    },
    setOnline(value: boolean) {
      const becameOnline = !online && value;
      online = value;
      if (becameOnline) for (const callback of onlineListeners) callback();
    },
    clearedReplicas,
    clearedReplicaReferences,
    clearAllCount,
  } satisfies ControllerDepartureAdapters & {
    advanceTo(nowMs: number): void;
    setOnline(value: boolean): void;
    clearedReplicas: string[];
    clearedReplicaReferences: ControllerDepartureReference[];
    clearAllCount: number;
  };
  return adapters;
}

function createBrowserClock(): ControllerDepartureClock {
  return {
    now: () => Date.now(),
    schedule: (delayMs, callback) =>
      typeof window === "undefined"
        ? globalThis.setTimeout(callback, delayMs)
        : window.setTimeout(callback, delayMs),
    cancel: (handle) =>
      typeof window === "undefined"
        ? globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
        : window.clearTimeout(handle as number),
  };
}

function createBrowserConnectivity(): ControllerDepartureConnectivity {
  if (typeof window === "undefined")
    return { isOnline: () => true, onOnline: () => () => undefined };
  return {
    isOnline: browserIsOnline,
    onOnline(callback) {
      window.addEventListener("online", callback);
      return () => window.removeEventListener("online", callback);
    },
  };
}

function createBrowserPersistence(): ControllerDeparturePersistence {
  const changedEvent = "quadball:controller-departure-changed";
  return {
    read() {
      try {
        const raw = window.localStorage.getItem(CONTROLLER_DEPARTURE_STORAGE_KEY);
        if (raw === null) return { status: "empty", revision: 0 };
        const value = JSON.parse(raw) as unknown;
        if (isStoredDeparture(value)) return normalizeProjection(value);
        if (isPreviousStoredDeparture(value))
          return normalizeProjection({ ...value, revision: value.revision ?? 0 });
        if (isLegacyStoredDeparture(value)) return normalizeProjection({ ...value, revision: 0 });
        return { status: "failed-closed", revision: 0 };
      } catch {
        return { status: "failed-closed", revision: 0 };
      }
    },
    write(projection) {
      try {
        window.localStorage.setItem(
          CONTROLLER_DEPARTURE_STORAGE_KEY,
          JSON.stringify({ version: CONTROLLER_DEPARTURE_VERSION, ...projection }),
        );
        window.dispatchEvent(new window.Event(changedEvent));
        return true;
      } catch {
        return false;
      }
    },
    clear() {
      try {
        window.localStorage.removeItem(CONTROLLER_DEPARTURE_STORAGE_KEY);
        window.dispatchEvent(new window.Event(changedEvent));
      } catch {}
    },
    subscribe(callback) {
      const refresh = () => callback();
      window.addEventListener("storage", refresh);
      window.addEventListener(changedEvent, refresh);
      return () => {
        window.removeEventListener("storage", refresh);
        window.removeEventListener(changedEvent, refresh);
      };
    },
  };
}

function createBrowserAdHocAuthority(): ControllerDepartureAuthority {
  return {
    async finalize(departure) {
      try {
        const response = await fetch(`/api/games/${encodeURIComponent(departure.gameId)}/leave`, {
          method: "POST",
          credentials: "same-origin",
        });
        if (response.ok) return "accepted";
        return response.status === 401 ||
          response.status === 403 ||
          response.status === 404 ||
          response.status === 410
          ? "unavailable"
          : "deferred";
      } catch {
        return "deferred";
      }
    },
    async reconcile(departure) {
      try {
        const response = await fetch(`/api/games/${encodeURIComponent(departure.gameId)}`, {
          credentials: "same-origin",
        });
        if (response.ok) return "available";
        return response.status === 404 || response.status === 410 ? "unavailable" : "transient";
      } catch {
        return "transient";
      }
    },
  };
}

function createBrowserEventAuthority(): ControllerDepartureAuthority {
  const sessionStorage = createBrowserEventControllerSessionStorage();
  return {
    async finalize(departure) {
      const persisted = sessionStorage.readForGame(departure.gameId, departure.sessionReferenceId);
      if (persisted === null) return "unavailable";
      try {
        const response = await fetch("/api/event-control/leave", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ sessionBearer: persisted.sessionBearer }),
        });
        if (response.ok) {
          sessionStorage.clear(departure.gameId, departure.sessionReferenceId);
          return "accepted";
        }
        if ([401, 403, 404, 410].includes(response.status)) {
          sessionStorage.clear(departure.gameId, departure.sessionReferenceId);
          return "unavailable";
        }
        return "deferred";
      } catch {
        return "deferred";
      }
    },
    async reconcile(departure) {
      const persisted = sessionStorage.readForGame(departure.gameId, departure.sessionReferenceId);
      if (persisted === null) return "unavailable";
      try {
        const response = await fetch("/api/event-control/refresh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            sessionBearer: persisted.sessionBearer,
            eventGameId: departure.gameId,
          }),
        });
        if (response.status === 409) {
          const value = (await response.json()) as { status?: string };
          return value.status === "switch-required" ? "available" : "transient";
        }
        if (response.ok) {
          const value = (await response.json()) as { status?: string };
          // Reassignment is a retained authority choice. The Event page
          // renders the existing retain-or-switch decision after Return.
          if (value.status === "authorized" || value.status === "switch-required")
            return "available";
          return "unavailable";
        }
        if ([401, 403, 404, 410].includes(response.status)) {
          sessionStorage.clear(departure.gameId, departure.sessionReferenceId);
          return "unavailable";
        }
        return "transient";
      } catch {
        return "transient";
      }
    },
  };
}

function createBrowserAdHocReplica(): ControllerDepartureReplica {
  return {
    clear(departure) {
      clearAdHocControllerSession(departure.gameId);
    },
    clearAll() {
      try {
        const keys: string[] = [];
        for (let index = 0; index < window.localStorage.length; index += 1) {
          const key = window.localStorage.key(index);
          if (key?.startsWith(AD_HOC_CONTROLLER_STORAGE_PREFIX)) keys.push(key);
        }
        for (const key of keys) window.localStorage.removeItem(key);
      } catch {
        // The failed-closed lifecycle projection still blocks local control.
      }
    },
  };
}

function createBrowserEventReplica(): ControllerDepartureReplica {
  return {
    clear(departure) {
      if (departure.sessionReferenceId === undefined) return;
      try {
        const storageKey = controllerReplicaStorageKey(departure.gameId);
        const raw = window.localStorage.getItem(storageKey);
        if (raw === null) return;
        const state = parseControllerReplica(JSON.parse(raw), departure.gameId);
        if (state.sessionReferenceId !== departure.sessionReferenceId) return;
        window.localStorage.removeItem(storageKey);
      } catch {
        // The lifecycle projection remains authoritative if replica storage fails.
      }
    },
    clearAll() {
      try {
        const keys: string[] = [];
        for (let index = 0; index < window.localStorage.length; index += 1) {
          const key = window.localStorage.key(index);
          if (key?.startsWith(`${controllerReplicaStorageKey()}:`)) keys.push(key);
        }
        for (const key of keys) window.localStorage.removeItem(key);
      } catch {
        // The failed-closed lifecycle projection still blocks local control.
      }
    },
  };
}

function browserIsOnline() {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function projectionFields(
  projection: ControllerDepartureProjection,
): ControllerDepartureStateFields {
  return projection.status === "empty" || projection.status === "failed-closed"
    ? { blockedGameIds: [], pendingFinalizations: [], reconciliationPending: [] }
    : projection;
}

function withoutRevision(projection: ControllerDepartureProjection): ControllerDepartureState {
  const { revision: _revision, ...rest } = projection;
  return rest as ControllerDepartureState;
}

function normalizeProjection(
  projection: ControllerDepartureProjection | (ControllerDepartureState & { revision?: number }),
): ControllerDepartureProjection {
  const revision = isSafeTimestamp(projection.revision) ? projection.revision : 0;
  if (projection.status === "empty" || projection.status === "failed-closed")
    return { status: projection.status, revision };
  const departure =
    projection.status === "returnable"
      ? normalizeDepartureReference(projection.departure)
      : undefined;
  const pendingFinalizations = projection.pendingFinalizations.map(normalizeDepartureReference);
  const reconciliationPending = projection.reconciliationPending.map(normalizeDepartureReference);
  const knownDepartures = [
    ...(departure === undefined ? [] : [departure]),
    ...pendingFinalizations,
    ...reconciliationPending,
  ];
  return {
    ...projection,
    revision,
    ...(departure === undefined ? {} : { departure }),
    blockedGameIds: unique(
      projection.blockedGameIds.flatMap((value) => qualifyStoredGameIds(value, knownDepartures)),
    ),
    pendingFinalizations: uniqueDepartures(pendingFinalizations),
    reconciliationPending: uniqueDepartures(reconciliationPending),
  };
}

function workflowQualifiedGameId(workflow: ControllerDepartureWorkflow, gameId: string) {
  return `${workflow}:${gameId}`;
}

function lifecycleKey(
  workflow: ControllerDepartureWorkflow,
  gameId: string,
  sessionReferenceId?: string,
) {
  return workflow === "event"
    ? `${workflowQualifiedGameId(workflow, gameId)}|${sessionReferenceId ?? legacyEventControllerSessionReference(gameId)}`
    : workflowQualifiedGameId(workflow, gameId);
}

function departureKey(departure: ControllerDepartureReference) {
  return lifecycleKey(departure.workflow, departure.gameId, departure.sessionReferenceId);
}

function blockedDepartureKey(departure: ControllerDepartureReference) {
  return departureKey(departure);
}

function normalizeDepartureReference(
  departure: ControllerDepartureReference,
): ControllerDepartureReference {
  return departure.workflow === "event" && departure.sessionReferenceId === undefined
    ? { ...departure, sessionReferenceId: legacyEventControllerSessionReference(departure.gameId) }
    : departure;
}

function qualifyStoredGameIds(
  value: string,
  knownDepartures: ControllerDepartureReference[],
): string[] {
  if (value.startsWith("ad-hoc:")) return [value];
  if (value.startsWith("event:")) {
    if (value.includes("|")) return [value];
    const gameId = value.slice("event:".length);
    const exactReferences = knownDepartures
      .filter((departure) => departure.workflow === "event" && departure.gameId === gameId)
      .map(departureKey);
    return exactReferences.length > 0 ? exactReferences : [lifecycleKey("event", gameId)];
  }
  return [workflowQualifiedGameId("ad-hoc", value)];
}

function destinationGameId(destination: ControllerDepartureDestination) {
  return destination.kind === "new-ad-hoc" || destination.kind === "admit-event"
    ? null
    : destination.gameId;
}

function destinationMatches(
  left: ControllerDepartureDestination,
  right: ControllerDepartureDestination,
) {
  if (left.kind !== right.kind) return false;
  if (left.kind === "new-ad-hoc" || left.kind === "admit-event") return true;
  if (left.kind === "resume-event" && right.kind === "resume-event") {
    return left.gameId === right.gameId && left.sessionReferenceId === right.sessionReferenceId;
  }
  return (
    (left.kind === "resume-ad-hoc" || left.kind === "admit-ad-hoc") &&
    (right.kind === "resume-ad-hoc" || right.kind === "admit-ad-hoc") &&
    left.gameId === right.gameId
  );
}

function destinationMatchesDeparture(
  departure: ControllerDepartureReference,
  destination: ControllerDepartureDestination,
) {
  return (
    (destination.kind === "resume-ad-hoc" || destination.kind === "resume-event") &&
    departure.workflow === (destination.kind === "resume-event" ? "event" : "ad-hoc") &&
    departure.gameId === destination.gameId &&
    (destination.kind !== "resume-event" ||
      lifecycleKey("event", departure.gameId, departure.sessionReferenceId) ===
        lifecycleKey("event", destination.gameId, destination.sessionReferenceId))
  );
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function uniqueDepartures(values: ControllerDepartureReference[]) {
  const byWorkflowGame = new Map<string, ControllerDepartureReference>();
  for (const departure of values) byWorkflowGame.set(departureKey(departure), departure);
  return [...byWorkflowGame.values()];
}

function sameStrings(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameDepartures(
  left: ControllerDepartureReference[],
  right: ControllerDepartureReference[],
) {
  return sameStrings(left.map(departureKey), right.map(departureKey));
}

function isStoredDeparture(value: unknown): value is ControllerDepartureProjection & {
  version: typeof CONTROLLER_DEPARTURE_VERSION;
} {
  return (
    isRecord(value) &&
    value.version === CONTROLLER_DEPARTURE_VERSION &&
    isSafeTimestamp(value.revision) &&
    isProjectionBody(value, true)
  );
}

function isLegacyStoredDeparture(value: unknown): value is Exclude<
  ControllerDepartureState,
  { status: "failed-closed" }
> & {
  version: typeof LEGACY_CONTROLLER_DEPARTURE_VERSION;
} {
  return (
    isRecord(value) &&
    value.version === LEGACY_CONTROLLER_DEPARTURE_VERSION &&
    isProjectionBody(value, false) &&
    value.status !== "failed-closed"
  );
}

function isPreviousStoredDeparture(value: unknown): value is ControllerDepartureProjection & {
  version: typeof PREVIOUS_CONTROLLER_DEPARTURE_VERSION;
} {
  return (
    isRecord(value) &&
    value.version === PREVIOUS_CONTROLLER_DEPARTURE_VERSION &&
    isSafeTimestamp(value.revision) &&
    isProjectionBody(value, false)
  );
}

function isProjectionBody(value: Record<string, any>, qualifiedIds: boolean) {
  if (value.status === "empty" || value.status === "failed-closed") return true;
  if (value.status === "returned") return isStateFields(value, qualifiedIds);
  if (value.status === "blocked")
    return (
      validateOpaqueIdentifier(value.gameId, "gameId").ok && isStateFields(value, qualifiedIds)
    );
  return (
    value.status === "returnable" &&
    isSafeTimestamp(value.expiresAtMs) &&
    isDeparture(value.departure) &&
    isStateFields(value, qualifiedIds)
  );
}

function isStateFields(value: Record<string, any>, qualifiedIds = true) {
  return (
    Array.isArray(value.blockedGameIds) &&
    value.blockedGameIds.every(
      (id: unknown) =>
        typeof id === "string" &&
        (qualifiedIds
          ? /^(?:ad-hoc|event):.+/u.test(id) &&
            validateOpaqueIdentifier(id.slice(id.indexOf(":") + 1), "gameId").ok
          : validateOpaqueIdentifier(id, "gameId").ok),
    ) &&
    Array.isArray(value.pendingFinalizations) &&
    value.pendingFinalizations.every(isDeparture) &&
    Array.isArray(value.reconciliationPending) &&
    value.reconciliationPending.every(isDeparture)
  );
}

function isDeparture(value: unknown): value is ControllerDepartureReference {
  if (!isRecord(value) || (value.workflow !== "ad-hoc" && value.workflow !== "event")) return false;
  if (
    !validateOpaqueIdentifier(value.gameId, "gameId").ok ||
    typeof value.navigationPath !== "string" ||
    !value.navigationPath.startsWith("/")
  )
    return false;
  if (!isRecord(value.identity)) return false;
  return (
    typeof value.identity.title === "string" &&
    typeof value.identity.homeName === "string" &&
    typeof value.identity.awayName === "string" &&
    (value.identity.detail === undefined || typeof value.identity.detail === "string") &&
    (value.sessionReferenceId === undefined ||
      (value.workflow === "event" &&
        typeof value.sessionReferenceId === "string" &&
        validateOpaqueIdentifier(value.sessionReferenceId, "sessionReferenceId").ok))
  );
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
