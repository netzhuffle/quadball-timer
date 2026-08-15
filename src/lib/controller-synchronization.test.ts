import { describe, expect, test } from "bun:test";
import {
  createControllerReplayAcknowledgement,
  projectControllerReplayRetry,
  resolveControllerBatch,
  validateControllerReplay,
  type ControllerSynchronizationOperation,
} from "@/lib/controller-synchronization";

type Payload = { value: number };
const operation = (
  id: string,
  value: number,
  predecessors: readonly string[] = [],
): ControllerSynchronizationOperation<Payload> => ({
  operationId: id,
  workflow: "ad-hoc",
  clientOriginAtMs: value,
  causalPredecessorIds: predecessors,
  payload: { value },
});

describe("shared Controller synchronization boundary", () => {
  test("resolves causal order independently of incoming order and keeps unrelated work", () => {
    const results = [
      [operation("child", 2, ["parent"]), operation("unrelated", 1), operation("parent", 3)],
      [operation("parent", 3), operation("unrelated", 1), operation("child", 2, ["parent"])],
    ].map((operations) => resolveControllerBatch({ operations, retainedStatuses: new Map() }));
    for (const resolution of results) {
      expect(resolution.ordered.map((entry) => entry.operationId)).toEqual([
        "unrelated",
        "parent",
        "child",
      ]);
      expect(resolution.statuses.get("child")).toBe("accepted");
    }
  });

  test("rejects missing/cyclic predecessors and blocks only descendants of retained rejection", () => {
    const operations = [
      operation("missing-child", 1, ["missing"]),
      operation("descendant", 2, ["missing-child"]),
      operation("independent", 3),
      operation("cycle-a", 4, ["cycle-b"]),
      operation("cycle-b", 5, ["cycle-a"]),
    ];
    for (const resolution of [
      resolveControllerBatch({ operations, retainedStatuses: new Map() }),
      resolveControllerBatch({
        operations: [...operations].reverse(),
        retainedStatuses: new Map(),
      }),
    ]) {
      expect(resolution.statuses.get("missing-child")).toBe("rejected");
      expect(resolution.statuses.get("descendant")).toBe("causally-blocked");
      expect(resolution.statuses.get("independent")).toBe("accepted");
      expect(resolution.statuses.get("cycle-a")).toBe("rejected");
      expect(resolution.statuses.get("cycle-b")).toBe("rejected");
    }
    const retained = resolveControllerBatch({
      operations: [operation("descendant", 2, ["rejected"]), operation("independent", 3)],
      retainedStatuses: new Map([["rejected", "rejected"]]),
    });
    expect(retained.statuses.get("descendant")).toBe("causally-blocked");
    expect(retained.statuses.get("independent")).toBe("accepted");
  });

  test("uses one workflow-scoped envelope contract for Event and Ad Hoc", () => {
    expect(
      validateControllerReplay(
        [{ id: "event-op", workflow: "event", clientSentAtMs: 1, intent: { type: "event" } }],
        "event",
      ).ok,
    ).toBe(true);
    expect(
      validateControllerReplay(
        [{ id: "adhoc-op", workflow: "ad-hoc", clientSentAtMs: 1, command: { type: "adhoc" } }],
        "ad-hoc",
      ).ok,
    ).toBe(true);
    expect(
      validateControllerReplay(
        [{ id: "event-op", workflow: "ad-hoc", clientSentAtMs: 1, intent: {} }],
        "event",
      ).ok,
    ).toBe(false);
    expect(
      validateControllerReplay(
        [
          {
            id: "cycle-a",
            workflow: "ad-hoc",
            clientSentAtMs: 1,
            causalPredecessorIds: ["cycle-b"],
            command: {},
          },
          {
            id: "cycle-b",
            workflow: "ad-hoc",
            clientSentAtMs: 2,
            causalPredecessorIds: ["cycle-a"],
            command: {},
          },
          {
            id: "cycle-descendant",
            workflow: "ad-hoc",
            clientSentAtMs: 3,
            causalPredecessorIds: ["cycle-a"],
            command: {},
          },
        ],
        "ad-hoc",
      ).ok,
    ).toBe(false);
  });

  test("shares acknowledgement and retry projection semantics across workflows", () => {
    const acknowledgement = createControllerReplayAcknowledgement({
      workflow: "event",
      acknowledgedOperationIds: ["event-op"],
      outcomes: [{ operationId: "event-op", workflow: "event", status: "accepted" }],
    });
    expect(acknowledgement.acknowledgedOperationIds).toEqual(["event-op"]);
    expect(
      projectControllerReplayRetry(
        [{ status: "accepted" }, { status: "retryable" }, { status: "causally-blocked" }],
        new Set(["retryable", "causally-blocked"]),
      ),
    ).toHaveLength(2);
  });
});
