import { describe, expect, test } from "bun:test";
import type { ControllerReplayResult } from "@/lib/live-event-game-control";
import {
  createLiveEventGameControlTransport,
  type LiveEventGameControlTransportTarget,
} from "@/lib/live-event-game-transport";

describe("Live Event Game HTTP transport pre-mutation boundary", () => {
  test("passes malformed intent content only to the authorized Controller seam", async () => {
    const target = createSpyTarget();
    const transport = createLiveEventGameControlTransport(
      () => target,
      () => true,
    );
    const response = await transport.submitControlAction(
      request({ sessionBearer: "session", eventGameId: "game", intent: null }),
    );
    expect(response.status).toBe(403);
    expect(target.calls).toEqual([{ kind: "submit", intent: null }]);
  });

  test("rejects oversized and malformed replay envelopes before target parsing", async () => {
    const target = createSpyTarget();
    const transport = createLiveEventGameControlTransport(
      () => target,
      () => true,
    );
    const common = {
      sessionBearer: "session",
      eventGameId: "game",
      batchId: "batch",
      replicaGeneration: "generation",
      grantSessionId: "grant-session",
      grantVersion: "grant-version",
    };
    expect(
      (
        await transport.replayControlActions(
          request({
            ...common,
            actions: Array.from({ length: 101 }, () => ({ eventGameId: "game" })),
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await transport.replayControlActions(
          request({
            ...common,
            actions: [{ eventGameId: "game", intent: {}, causalPredecessorIds: [7] }],
          }),
        )
      ).status,
    ).toBe(404);
    expect(target.calls).toEqual([]);
  });

  test("validates opaque Event Game IDs before refresh, stay, or reveal invocation", async () => {
    const target = createSpyTarget();
    const transport = createLiveEventGameControlTransport(
      () => target,
      () => true,
    );
    for (const invoke of [
      transport.refreshController.bind(transport),
      transport.stayController.bind(transport),
      transport.revealControllerQr.bind(transport),
    ]) {
      const response = await invoke(
        request({ sessionBearer: "session", eventGameId: "x".repeat(129) }),
      );
      expect(response.status).toBe(404);
    }
    expect(target.calls).toEqual([]);
  });

  test("keeps Live Event Game control unavailable when HTTP route binding is denied", async () => {
    const target = createSpyTarget();
    const transport = createLiveEventGameControlTransport(
      () => target,
      () => false,
    );
    expect((await transport.openController(request({ qrCredential: "credential" }))).status).toBe(
      404,
    );
    expect(target.calls).toEqual([]);
  });
});

function request(body: unknown): Request {
  return new Request("http://localhost/api/event-control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createSpyTarget() {
  const calls: unknown[] = [];
  const replay: ControllerReplayResult = {
    batchId: "batch",
    replicaGeneration: "generation",
    session: {
      eventGameId: "game",
      grantSessionId: "grant-session",
      grantVersion: "grant-version",
    },
    eventGameId: "game",
    status: "synchronized",
    outcomes: [],
    projection: null,
  };
  return {
    calls,
    openController: async () => ({
      status: "rejected",
      message: "Unable to open Controller experience.",
    }),
    refreshController: async () => ({
      status: "rejected",
      message: "Unable to refresh Controller session.",
    }),
    switchController: async () => ({
      status: "rejected",
      message: "Unable to refresh Controller session.",
    }),
    stayController: async () => ({
      status: "rejected",
      message: "Unable to refresh Controller session.",
    }),
    revealControllerQr: async () => ({
      status: "rejected",
      message: "Unable to reveal the active Control Grant QR.",
    }),
    leaveController: async () => ({
      status: "rejected",
      message: "Unable to leave Controller session.",
    }),
    submitControlAction: async (input) => {
      calls.push({ kind: "submit", intent: input.intent });
      return {
        status: "rejected",
        message: "Unable to perform that Controller action.",
        operationId: null,
      };
    },
    replayControlActions: async () => replay,
    submitGamePresentationChange: async () => ({
      status: "rejected",
      message: "Unable to perform that Game Presentation Change.",
      operationId: null,
    }),
    replayGamePresentationChanges: async () => replay,
  } satisfies LiveEventGameControlTransportTarget & { calls: unknown[] };
}
