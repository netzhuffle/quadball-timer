import { readJsonBodyWithinLimit } from "@/lib/http-body";
import type {
  LiveEventGameControlResult,
  OpenControllerResult,
} from "@/lib/live-event-game-control";
import { SHARED_LIMITS } from "@/lib/validation-policy";

export type LiveEventGameControlTransport = {
  openController(request: Request): Promise<Response>;
  submitControllerIntent(request: Request): Promise<Response>;
};

export type LiveEventGameControlTransportTarget = {
  openController(input: {
    qrCredential: string;
    browserContext: string;
  }): Promise<OpenControllerResult>;
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
  };
}

function resultStatus(result: LiveEventGameControlResult): number {
  if (result.status === "retryable") return 503;
  if (result.status === "rejected") return 403;
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
