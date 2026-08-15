import { readJsonBodyWithinLimit } from "@/lib/http-body";
import type {
  ControllerLeaveResult,
  ControllerQrResult,
  ControllerRefreshResult,
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
  submitControllerIntent(request: Request): Promise<Response>;
};

export type LiveEventGameControlTransportTarget = {
  openController(input: {
    qrCredential: string;
    browserContext: string;
  }): Promise<OpenControllerResult>;
  refreshController(input: {
    sessionBearer: string;
    eventGameId: string;
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
  submitControllerIntent(input: {
    sessionBearer: string;
    eventGameId: string;
    intent: unknown;
  }): Promise<LiveEventGameControlResult>;
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
      if (typeof body.body.qrCredential !== "string") return unavailable();

      const result = await control.openController({
        qrCredential: body.body.qrCredential,
        browserContext:
          typeof body.body.browserContext === "string" ? body.body.browserContext : "phone",
      });
      return result.status === "opened" ? noStoreJson(result) : unavailable();
    },

    async submitControllerIntent(request) {
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

      const result = await control.submitControllerIntent({
        sessionBearer: body.body.sessionBearer,
        eventGameId: body.body.eventGameId,
        intent: body.body.intent,
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
): Promise<{ sessionBearer: string; eventGameId?: string } | null> {
  if (!isAllowedRequest(request)) return null;
  const body = await readJsonBodyWithinLimit(request, SHARED_LIMITS.transport.httpJsonBodyBytes);
  if (!body.ok || !isRecord(body.body) || typeof body.body.sessionBearer !== "string") return null;
  if (typeof body.body.eventGameId === "string") {
    return { sessionBearer: body.body.sessionBearer, eventGameId: body.body.eventGameId };
  }
  return { sessionBearer: body.body.sessionBearer };
}

function resultStatus(result: LiveEventGameControlResult): number {
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
