import { clearAdHocControllerSession } from "@/lib/ad-hoc-controller-session";
import { validateOpaqueIdentifier } from "@/lib/validation-policy";

export const CONTROLLER_LEAVE_GRACE_MS = 5 * 60_000;
export const CONTROLLER_DEPARTURE_STORAGE_KEY = "quadball:controller-departure";
const CONTROLLER_DEPARTURE_VERSION = "controller-departure-v2" as const;
const LEGACY_CONTROLLER_DEPARTURE_VERSION = "controller-departure-v1" as const;
const AD_HOC_CONTROLLER_STORAGE_PREFIX = "quadball:ad-hoc-controller:";

export type ControllerDepartureWorkflow = "ad-hoc" | "event";

export type ControllerDepartureReference = {
  workflow: ControllerDepartureWorkflow;
  gameId: string;
  navigationPath: string;
  identity: { title: string; homeName: string; awayName: string; detail?: string };
};

type ControllerDepartureStateFields = {
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
  | { kind: "resume-ad-hoc"; gameId: string };

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

export type ControllerDepartureConnectivity = {
  isOnline(): boolean;
  onOnline(callback: () => void): () => void;
};

export type ControllerDepartureReplica = {
  clear(gameId: string): void;
  clearAll(): void;
};

export type ControllerDepartureAdapters = {
  clock: ControllerDepartureClock;
  persistence: ControllerDeparturePersistence;
  authority: ControllerDepartureAuthority;
  connectivity: ControllerDepartureConnectivity;
  replica: ControllerDepartureReplica;
};

export type ControllerDepartureModule = {
  project(): ControllerDepartureProjection;
  transition(intent: ControllerDepartureIntent): Promise<ControllerDepartureOutcome>;
  subscribe(callback: () => void): () => void;
  dispose(): void;
};

export function controllerDepartureBlocksGame(
  projection: ControllerDepartureProjection,
  gameId: string,
): boolean {
  return (
    projection.status === "failed-closed" ||
    (projection.status !== "empty" && projection.blockedGameIds.includes(gameId))
  );
}

export function createControllerDeparture(
  adapters: Partial<ControllerDepartureAdapters> = {},
): ControllerDepartureModule {
  const clock = adapters.clock ?? createBrowserClock();
  const persistence = adapters.persistence ?? createBrowserPersistence();
  const authority = adapters.authority ?? createBrowserAuthority();
  const connectivity = adapters.connectivity ?? createBrowserConnectivity();
  const replica = adapters.replica ?? createBrowserReplica();
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
  const clearReplica = (gameId: string) => {
    try {
      replica.clear(gameId);
    } catch {
      // Persisted fail-closed state remains authoritative for this browser.
    }
  };
  const clearAllReplicas = () => {
    try {
      replica.clearAll();
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
        result = await authority.finalize(departure);
      } catch {
        result = "deferred";
      }
      results.set(departure.gameId, result);
    }
    return results;
  };
  const callReconciliations = async (departures: ControllerDepartureReference[]) => {
    const results = new Map<string, "available" | "transient" | "unavailable">();
    for (const departure of departures) {
      let result: "available" | "transient" | "unavailable" = "transient";
      try {
        result = await authority.reconcile(departure);
      } catch {
        result = "transient";
      }
      results.set(departure.gameId, result);
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
        finalizations.get(departure.gameId) === "deferred" || !finalizations.has(departure.gameId),
    );
    const reconciliationPending = fields.reconciliationPending.filter(
      (departure) =>
        reconciliations.get(departure.gameId) === "transient" ||
        !reconciliations.has(departure.gameId),
    );
    const unavailableGameIds = [
      ...[...finalizations]
        .filter(([, result]) => result === "unavailable")
        .map(([gameId]) => gameId),
      ...[...reconciliations]
        .filter(([, result]) => result === "unavailable")
        .map(([gameId]) => gameId),
    ];
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
      for (const gameId of unavailableGameIds) clearReplica(gameId);
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
      blockedGameIds: unique([...current.blockedGameIds, current.departure.gameId]),
      pendingFinalizations,
      reconciliationPending: current.reconciliationPending,
    });
    if (next === null) return { status: "unavailable" };
    cancelExpiry();
    clearReplica(current.departure.gameId);
    if (!online) return { status: "expired", finalization: "deferred" };
    const results = await callFinalizations(pendingFinalizations);
    settleAuthorityResults(results, new Map());
    return {
      status: "expired",
      finalization: results.get(current.departure.gameId) ?? "deferred",
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
        : unique([...fields.blockedGameIds, superseded.gameId]);
    const next = writeFrom(current, {
      status: "returnable",
      departure: intent.departure,
      expiresAtMs: nowMs + CONTROLLER_LEAVE_GRACE_MS,
      blockedGameIds,
      pendingFinalizations,
      reconciliationPending: fields.reconciliationPending,
    });
    if (next === null) return { status: "unavailable" };
    if (superseded !== null) clearReplica(superseded.gameId);
    if ((intent.online ?? connectivity.isOnline()) && pendingFinalizations.length > 0) {
      const results = await callFinalizations(pendingFinalizations);
      settleAuthorityResults(results, new Map());
    }
    const latest = readStored();
    if (latest.status === "returnable" && latest.departure.gameId === intent.departure.gameId)
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
    const result = results.get(gameId) ?? "transient";
    if (result === "unavailable") {
      const next = writeFrom(latest, {
        status: "blocked",
        gameId,
        blockedGameIds: unique([...latest.blockedGameIds, gameId]),
        pendingFinalizations: latest.pendingFinalizations,
        reconciliationPending: latest.reconciliationPending,
      });
      if (next === null) return { status: "unavailable" };
      cancelExpiry();
      clearReplica(gameId);
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
      return destination.kind === "resume-ad-hoc"
        ? { status: "unavailable" }
        : issueAuthorization(destination, current.revision);
    }
    const gameId = destinationGameId(destination);
    if (gameId !== null && controllerDepartureBlocksGame(current, gameId))
      return { status: "unavailable" };
    if (
      destination.kind === "resume-ad-hoc" &&
      current.status === "returnable" &&
      current.departure.gameId === destination.gameId
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
      blockedGameIds: unique([...current.blockedGameIds, current.departure.gameId]),
      pendingFinalizations,
      reconciliationPending: current.reconciliationPending,
    });
    if (next === null) return { status: "unavailable" };
    pendingEntries.delete(request.id);
    clearReplica(current.departure.gameId);
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
    if (current.status === "failed-closed" && authorization.destination.kind === "resume-ad-hoc")
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
        blockedGameIds: unique([...projection.blockedGameIds, projection.departure.gameId]),
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
  } = {},
): ControllerDepartureAdapters & {
  advanceTo(nowMs: number): void;
  setOnline(value: boolean): void;
  clearedReplicas: string[];
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
    connectivity: {
      isOnline: () => online,
      onOnline(callback: () => void) {
        onlineListeners.add(callback);
        return () => onlineListeners.delete(callback);
      },
    },
    replica: {
      clear: (gameId: string) => clearedReplicas.push(gameId),
      clearAll: () => {
        clearAllCount += 1;
        adapters.clearAllCount = clearAllCount;
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
    clearAllCount,
  } satisfies ControllerDepartureAdapters & {
    advanceTo(nowMs: number): void;
    setOnline(value: boolean): void;
    clearedReplicas: string[];
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

function createBrowserAuthority(): ControllerDepartureAuthority {
  return {
    async finalize(departure) {
      if (departure.workflow !== "ad-hoc") return "deferred";
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
      if (departure.workflow !== "ad-hoc") return "available";
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

function createBrowserReplica(): ControllerDepartureReplica {
  return {
    clear: clearAdHocControllerSession,
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
  return {
    ...projection,
    revision,
    blockedGameIds: unique(projection.blockedGameIds),
    pendingFinalizations: uniqueDepartures(projection.pendingFinalizations),
    reconciliationPending: uniqueDepartures(projection.reconciliationPending),
  };
}

function destinationGameId(destination: ControllerDepartureDestination) {
  return destination.kind === "new-ad-hoc" ? null : destination.gameId;
}

function destinationMatches(
  left: ControllerDepartureDestination,
  right: ControllerDepartureDestination,
) {
  return (
    left.kind === right.kind &&
    (left.kind === "new-ad-hoc" || right.kind === "new-ad-hoc" || left.gameId === right.gameId)
  );
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function uniqueDepartures(values: ControllerDepartureReference[]) {
  const byGameId = new Map<string, ControllerDepartureReference>();
  for (const departure of values) byGameId.set(departure.gameId, departure);
  return [...byGameId.values()];
}

function sameStrings(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameDepartures(
  left: ControllerDepartureReference[],
  right: ControllerDepartureReference[],
) {
  return sameStrings(
    left.map((departure) => departure.gameId),
    right.map((departure) => departure.gameId),
  );
}

function isStoredDeparture(value: unknown): value is ControllerDepartureProjection & {
  version: typeof CONTROLLER_DEPARTURE_VERSION;
} {
  return (
    isRecord(value) &&
    value.version === CONTROLLER_DEPARTURE_VERSION &&
    isSafeTimestamp(value.revision) &&
    isProjectionBody(value)
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
    isProjectionBody(value) &&
    value.status !== "failed-closed"
  );
}

function isProjectionBody(value: Record<string, any>) {
  if (value.status === "empty" || value.status === "failed-closed") return true;
  if (value.status === "returned") return isStateFields(value);
  if (value.status === "blocked")
    return validateOpaqueIdentifier(value.gameId, "gameId").ok && isStateFields(value);
  return (
    value.status === "returnable" &&
    isSafeTimestamp(value.expiresAtMs) &&
    isDeparture(value.departure) &&
    isStateFields(value)
  );
}

function isStateFields(value: Record<string, any>) {
  return (
    Array.isArray(value.blockedGameIds) &&
    value.blockedGameIds.every((id: unknown) => validateOpaqueIdentifier(id, "gameId").ok) &&
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
    (value.identity.detail === undefined || typeof value.identity.detail === "string")
  );
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
