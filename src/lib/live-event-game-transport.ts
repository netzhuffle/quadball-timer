import { readJsonBodyWithinLimit } from "@/lib/http-body";
import type {
  ControllerLeaveResult,
  ControllerQrResult,
  ControllerRefreshResult,
  ControllerReplayResult,
  GamePresentationChangeResult,
  LiveEventGameControlResult,
  OpenControllerResult,
} from "@/lib/live-event-game-control";
import { SHARED_LIMITS } from "@/lib/validation-policy";

export type LiveEventGameControlTransport = {
  openController(request: Request): Promise<Response>;
  refreshController(request: Request): Promise<Response>;
  switchController(request: Request): Promise<Response>;
  stayController(request: Request): Promise<Response>;
  revealControllerQr(request: Request): Promise<Response>;
  leaveController(request: Request): Promise<Response>;
  submitControlAction(request: Request): Promise<Response>;
  submitControllerIntent(request: Request): Promise<Response>;
  replayControlActions(request: Request): Promise<Response>;
  replayControllerActions(request: Request): Promise<Response>;
  submitGamePresentationChange(request: Request): Promise<Response>;
  replayGamePresentationChanges(request: Request): Promise<Response>;
};

export type LiveEventGameControlTransportTarget = {
  openController(input: {
    qrCredential?: string;
    grantCode?: string;
    browserContext: string;
  }): Promise<OpenControllerResult>;
  refreshController(input: {
    sessionBearer: string;
    eventGameId: string;
    deferTimeoutMaterialization?: boolean;
  }): Promise<ControllerRefreshResult>;
  switchController(input: { sessionBearer: string }): Promise<ControllerRefreshResult>;
  stayController(input: {
    sessionBearer: string;
    eventGameId: string;
  }): Promise<ControllerRefreshResult>;
  revealControllerQr(input: {
    sessionBearer: string;
    eventGameId: string;
  }): Promise<ControllerQrResult>;
  leaveController(input: { sessionBearer: string }): Promise<ControllerLeaveResult>;
  submitControlAction(input: {
    sessionBearer: string;
    eventGameId: string;
    intent: unknown;
  }): Promise<LiveEventGameControlResult>;
  replayControlActions(input: {
    sessionBearer: string;
    eventGameId: string;
    batchId: string;
    replicaGeneration: string;
    expectedGrantSessionId: string;
    expectedGrantVersion: string;
    actions: readonly {
      eventGameId: string;
      intent: unknown;
      causalPredecessorIds?: readonly unknown[];
    }[];
  }): Promise<ControllerReplayResult>;
  submitGamePresentationChange(input: {
    sessionBearer: string;
    eventGameId: string;
    change: unknown;
  }): Promise<GamePresentationChangeResult>;
  replayGamePresentationChanges(input: {
    sessionBearer: string;
    eventGameId: string;
    batchId: string;
    replicaGeneration: string;
    expectedGrantSessionId: string;
    expectedGrantVersion: string;
    changes: readonly {
      eventGameId: string;
      change: unknown;
      causalPredecessorIds?: readonly unknown[];
      originatingGrant: unknown;
    }[];
  }): Promise<ControllerReplayResult>;
};

export function createLiveEventGameControlTransport(
  resolve: () => LiveEventGameControlTransportTarget | null,
  isAllowedRequest: (request: Request) => boolean,
): LiveEventGameControlTransport {
  return {
    async openController(request) {
      if (!isAllowedRequest(request)) return unavailable();
      const control = resolve();
      if (control === null) return unavailable();

      const body = await readJsonBodyWithinLimit(
        request,
        SHARED_LIMITS.transport.httpJsonBodyBytes,
      );
      if (!body.ok || !isRecord(body.body)) return unavailable();
      const qrCredential =
        typeof body.body.qrCredential === "string" ? body.body.qrCredential : undefined;
      const grantCode = typeof body.body.grantCode === "string" ? body.body.grantCode : undefined;
      if ((qrCredential === undefined) === (grantCode === undefined)) return unavailable();

      const result = await control.openController({
        ...(qrCredential === undefined ? { grantCode } : { qrCredential }),
        browserContext:
          typeof body.body.browserContext === "string" ? body.body.browserContext : "phone",
      });
      return result.status === "opened" ? noStoreJson(result) : unavailable();
    },

    async submitControlAction(request) {
      if (!isAllowedRequest(request)) return unavailable();
      const control = resolve();
      if (control === null) return unavailable();

      const body = await readJsonBodyWithinLimit(
        request,
        SHARED_LIMITS.transport.httpJsonBodyBytes,
      );
      if (!body.ok || !isRecord(body.body)) return unavailable();
      if (
        typeof body.body.sessionBearer !== "string" ||
        typeof body.body.eventGameId !== "string" ||
        body.body.intent === undefined
      ) {
        return unavailable();
      }

      const result = await control.submitControlAction({
        sessionBearer: body.body.sessionBearer,
        eventGameId: body.body.eventGameId,
        intent: body.body.intent,
      });
      return noStoreJson(result, resultStatus(result));
    },
    async submitControllerIntent(request) {
      return this.submitControlAction(request);
    },
    async submitGamePresentationChange(request) {
      if (!isAllowedRequest(request)) return unavailable();
      const control = resolve();
      if (control === null) return unavailable();
      const body = await readJsonBodyWithinLimit(
        request,
        SHARED_LIMITS.transport.httpJsonBodyBytes,
      );
      if (
        !body.ok ||
        !isRecord(body.body) ||
        typeof body.body.sessionBearer !== "string" ||
        typeof body.body.eventGameId !== "string" ||
        body.body.change === undefined
      ) {
        return unavailable();
      }
      const result = await control.submitGamePresentationChange({
        sessionBearer: body.body.sessionBearer,
        eventGameId: body.body.eventGameId,
        change: body.body.change,
      });
      return noStoreJson(result, resultStatus(result));
    },
    async replayControlActions(request) {
      if (!isAllowedRequest(request)) return unavailable();
      const control = resolve();
      if (control === null) return unavailable();
      const body = await readJsonBodyWithinLimit(
        request,
        SHARED_LIMITS.transport.httpJsonBodyBytes,
      );
      if (
        !body.ok ||
        !isRecord(body.body) ||
        typeof body.body.sessionBearer !== "string" ||
        typeof body.body.eventGameId !== "string" ||
        typeof body.body.batchId !== "string" ||
        typeof body.body.replicaGeneration !== "string" ||
        typeof body.body.grantSessionId !== "string" ||
        typeof body.body.grantVersion !== "string" ||
        !Array.isArray(body.body.actions)
      )
        return unavailable();
      if (
        body.body.actions.length === 0 ||
        body.body.actions.length > SHARED_LIMITS.replay.maxControlActions
      ) {
        return unavailable();
      }
      const result = await control.replayControlActions({
        sessionBearer: body.body.sessionBearer,
        eventGameId: body.body.eventGameId,
        batchId: body.body.batchId,
        replicaGeneration: body.body.replicaGeneration,
        expectedGrantSessionId: body.body.grantSessionId,
        expectedGrantVersion: body.body.grantVersion,
        actions: body.body.actions.map((action) => {
          if (!isRecord(action))
            return { eventGameId: "", intent: null, causalPredecessorIds: [null] };
          return {
            eventGameId: typeof action.eventGameId === "string" ? action.eventGameId : "",
            intent: action.intent,
            causalPredecessorIds: Array.isArray(action.causalPredecessorIds)
              ? action.causalPredecessorIds
              : [null],
          };
        }),
      });
      return noStoreJson(result, resultStatus(result));
    },
    async replayControllerActions(request) {
      return this.replayControlActions(request);
    },
    async replayGamePresentationChanges(request) {
      if (!isAllowedRequest(request)) return unavailable();
      const control = resolve();
      if (control === null) return unavailable();
      const body = await readJsonBodyWithinLimit(
        request,
        SHARED_LIMITS.transport.httpJsonBodyBytes,
      );
      if (
        !body.ok ||
        !isRecord(body.body) ||
        typeof body.body.sessionBearer !== "string" ||
        typeof body.body.eventGameId !== "string" ||
        typeof body.body.batchId !== "string" ||
        typeof body.body.replicaGeneration !== "string" ||
        typeof body.body.grantSessionId !== "string" ||
        typeof body.body.grantVersion !== "string" ||
        !Array.isArray(body.body.changes) ||
        body.body.changes.length === 0 ||
        body.body.changes.length > SHARED_LIMITS.replay.maxControlActions
      ) {
        return unavailable();
      }
      const result = await control.replayGamePresentationChanges({
        sessionBearer: body.body.sessionBearer,
        eventGameId: body.body.eventGameId,
        batchId: body.body.batchId,
        replicaGeneration: body.body.replicaGeneration,
        expectedGrantSessionId: body.body.grantSessionId,
        expectedGrantVersion: body.body.grantVersion,
        changes: body.body.changes.map((change) => {
          if (!isRecord(change)) {
            return {
              eventGameId: "",
              change: null,
              causalPredecessorIds: [null],
              originatingGrant: null,
            };
          }
          return {
            eventGameId: typeof change.eventGameId === "string" ? change.eventGameId : "",
            change: change.change,
            causalPredecessorIds: Array.isArray(change.causalPredecessorIds)
              ? change.causalPredecessorIds
              : [null],
            originatingGrant: change.originatingGrant,
          };
        }),
      });
      return noStoreJson(result, resultStatus(result));
    },
    async refreshController(request) {
      const input = await readSessionInput(request, isAllowedRequest);
      if (input === null || input.eventGameId === undefined) return unavailable();
      const control = resolve();
      if (control === null) return unavailable();
      const result = await control.refreshController({
        sessionBearer: input.sessionBearer,
        eventGameId: input.eventGameId,
        deferTimeoutMaterialization: input.deferTimeoutMaterialization,
      });
      return noStoreJson(result, controllerResultStatus(result));
    },
    async switchController(request) {
      const input = await readSessionInput(request, isAllowedRequest);
      if (input === null) return unavailable();
      const control = resolve();
      if (control === null) return unavailable();
      const result = await control.switchController({ sessionBearer: input.sessionBearer });
      return noStoreJson(result, controllerResultStatus(result));
    },
    async stayController(request) {
      const input = await readSessionInput(request, isAllowedRequest);
      if (input === null || input.eventGameId === undefined) return unavailable();
      const control = resolve();
      if (control === null) return unavailable();
      const result = await control.stayController({
        sessionBearer: input.sessionBearer,
        eventGameId: input.eventGameId,
      });
      return noStoreJson(result, controllerResultStatus(result));
    },
    async revealControllerQr(request) {
      const input = await readSessionInput(request, isAllowedRequest);
      if (input === null || input.eventGameId === undefined) return unavailable();
      const control = resolve();
      if (control === null) return unavailable();
      const result = await control.revealControllerQr({
        sessionBearer: input.sessionBearer,
        eventGameId: input.eventGameId,
      });
      return noStoreJson(result, controllerResultStatus(result));
    },
    async leaveController(request) {
      if (!isAllowedRequest(request)) return unavailable();
      const control = resolve();
      if (control === null) return unavailable();
      const body = await readJsonBodyWithinLimit(
        request,
        SHARED_LIMITS.transport.httpJsonBodyBytes,
      );
      if (!body.ok || !isRecord(body.body) || typeof body.body.sessionBearer !== "string") {
        return unavailable();
      }
      const result = await control.leaveController({ sessionBearer: body.body.sessionBearer });
      return noStoreJson(result, controllerResultStatus(result));
    },
  };
}

async function readSessionInput(
  request: Request,
  isAllowedRequest: (request: Request) => boolean,
): Promise<{
  sessionBearer: string;
  eventGameId?: string;
  deferTimeoutMaterialization?: boolean;
} | null> {
  if (!isAllowedRequest(request)) return null;
  const body = await readJsonBodyWithinLimit(request, SHARED_LIMITS.transport.httpJsonBodyBytes);
  if (!body.ok || !isRecord(body.body) || typeof body.body.sessionBearer !== "string") return null;
  if (typeof body.body.eventGameId === "string") {
    return {
      sessionBearer: body.body.sessionBearer,
      eventGameId: body.body.eventGameId,
      ...(body.body.deferTimeoutMaterialization === true
        ? { deferTimeoutMaterialization: true }
        : {}),
    };
  }
  return { sessionBearer: body.body.sessionBearer };
}

function resultStatus(
  result: LiveEventGameControlResult | GamePresentationChangeResult | ControllerReplayResult,
): number {
  if (result.status === "retryable") return 503;
  if (result.status === "rejected") return 403;
  return 200;
}

function controllerResultStatus(
  result: ControllerRefreshResult | ControllerQrResult | ControllerLeaveResult,
): number {
  if (result.status === "rejected") return 403;
  if (result.status === "switch-required") return 409;
  return 200;
}

function unavailable() {
  return noStoreJson({ error: "Event Game Controller is unavailable." }, 404);
}

function noStoreJson(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      "referrer-policy": "no-referrer",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
