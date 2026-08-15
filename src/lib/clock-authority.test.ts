import { describe, expect, test } from "bun:test";
import {
  createInitialClockBaseline,
  deriveClockAuthority,
  projectClockSample,
  projectClockBaseline,
  type ClockAuthorityAction,
} from "@/lib/clock-authority";

describe("Clock Authority", () => {
  test("serializes simultaneous transitions deterministically and transfers the holder", () => {
    const actions: ClockAuthorityAction[] = [
      clockAction({
        operationId: "z-start",
        trustedAtMs: 1_000,
        sessionId: "session-a",
        command: "set-running",
        running: true,
      }),
      clockAction({
        operationId: "a-pause",
        trustedAtMs: 1_000,
        sessionId: "session-b",
        command: "set-running",
        running: false,
      }),
    ];

    const baseline = deriveClockAuthority(actions);

    expect(baseline).toMatchObject({
      gameTimeMs: 0,
      penaltyTimeMs: 0,
      running: true,
      holderGrantSessionId: "session-a",
      lastTransitionOperationId: "z-start",
    });
    expect(baseline.holderGeneration).toBe(2);
  });

  test("composes simultaneous relative adjustments against the canonical baseline", () => {
    const actions: ClockAuthorityAction[] = [
      clockAction({
        operationId: "start",
        trustedAtMs: 1_000,
        sessionId: "session-a",
        command: "set-running",
        running: true,
      }),
      clockAction({
        operationId: "adjust-a",
        trustedAtMs: 2_000,
        sessionId: "session-a",
        command: "adjust",
        adjustmentMs: 1_000,
      }),
      clockAction({
        operationId: "adjust-b",
        trustedAtMs: 2_000,
        sessionId: "session-b",
        command: "adjust",
        adjustmentMs: 1_000,
      }),
    ];

    expect(deriveClockAuthority(actions)).toMatchObject({
      gameTimeMs: 3_000,
      running: true,
      lastTransitionOperationId: "adjust-b",
    });
    expect(deriveClockAuthority([...actions].reverse()).gameTimeMs).toBe(3_000);
    expect(deriveClockAuthority([...actions, actions[2]!]).gameTimeMs).toBe(3_000);
  });

  test("projects the latest accepted holder even when its occurrence is earlier", () => {
    const actions: ClockAuthorityAction[] = [
      clockAction({
        operationId: "accepted-first",
        trustedAtMs: 2_000,
        acceptedAtMs: 2_000,
        sessionId: "session-a",
        command: "set-running",
        running: true,
      }),
      clockAction({
        operationId: "accepted-later-earlier-occurrence",
        trustedAtMs: 1_000,
        acceptedAtMs: 3_000,
        sessionId: "session-b",
        command: "adjust",
        adjustmentMs: 1_000,
      }),
    ];

    for (const candidate of [actions, [...actions].reverse()]) {
      expect(deriveClockAuthority(candidate)).toMatchObject({
        holderGrantSessionId: "session-b",
        holderGeneration: 2,
        lastAcceptedAtMs: 3_000,
      });
    }
  });

  test("keeps penalty time independent, live-only, and paused with the game", () => {
    const baseline = deriveClockAuthority([
      clockAction({
        operationId: "start",
        trustedAtMs: 1_000,
        sessionId: "session-a",
        command: "set-running",
        running: true,
      }),
      clockAction({
        operationId: "penalty-start",
        trustedAtMs: 2_000,
        sessionId: "session-a",
        command: "penalty-start",
      }),
    ]);

    expect(projectClockBaseline(createInitialClockBaseline(), 20_000).activePenaltyTimeMs).toBe(0);

    const projection = projectClockBaseline(baseline, 5_000);

    expect(projection).toMatchObject({
      gameTimeMs: 4_000,
      activePenaltyTimeMs: 3_000,
      running: true,
      baseline: { activePenalty: { elapsedMs: 3_000 } },
    });

    const pausedBaseline = deriveClockAuthority([
      ...baselineActions(),
      clockAction({
        operationId: "pause",
        trustedAtMs: 5_000,
        sessionId: "session-a",
        command: "set-running",
        running: false,
      }),
    ]);
    const paused = projectClockBaseline(pausedBaseline, 9_000);
    expect(paused.gameTimeMs).toBe(4_000);
    expect(paused.activePenaltyTimeMs).toBe(3_000);
    expect(paused.running).toBe(false);

    const resumedBaseline = deriveClockAuthority([
      ...baselineActions(),
      clockAction({
        operationId: "pause",
        trustedAtMs: 5_000,
        sessionId: "session-a",
        command: "set-running",
        running: false,
      }),
      clockAction({
        operationId: "resume",
        trustedAtMs: 9_000,
        sessionId: "session-a",
        command: "set-running",
        running: true,
      }),
    ]);
    expect(projectClockBaseline(resumedBaseline, 11_000).activePenaltyTimeMs).toBe(5_000);
  });

  test("uses monotonic elapsed time for estimated running projections and stale paused projections", () => {
    const baseline = deriveClockAuthority([
      clockAction({
        operationId: "start-monotonic",
        trustedAtMs: 10_000,
        sessionId: "session-a",
        command: "set-running",
        running: true,
      }),
    ]);
    const receipt = projectClockBaseline(baseline, 10_000);
    const estimated = projectClockSample(receipt, 2_500);
    expect(estimated).toMatchObject({
      gameTimeMs: 2_500,
      synchronization: "estimated",
      lastSynchronizedAtMs: 10_000,
    });
    expect(projectClockSample(receipt, 86_400_000).gameTimeMs).toBe(7_200_000);

    const paused = projectClockSample(
      projectClockBaseline(
        deriveClockAuthority([
          clockAction({
            operationId: "paused",
            trustedAtMs: 10_000,
            sessionId: "session-a",
            command: "set-running",
            running: false,
          }),
        ]),
        10_000,
      ),
      2_500,
    );
    expect(paused).toMatchObject({ gameTimeMs: 0, synchronization: "stale" });
  });

  test("creates a new takeover generation and retains stale-generation evidence", () => {
    const baseline = deriveClockAuthority([
      clockAction({
        operationId: "holder-start",
        trustedAtMs: 1_000,
        sessionId: "session-a",
        command: "set-running",
        running: true,
      }),
      clockAction({
        operationId: "takeover",
        trustedAtMs: 2_000,
        sessionId: "session-b",
        command: "takeover",
        gameTimeMs: 5_000,
        running: false,
        authorityGeneration: 1,
      }),
      clockAction({
        operationId: "stale-holder-action",
        trustedAtMs: 3_000,
        sessionId: "session-a",
        command: "set-running",
        running: true,
        authorityGeneration: 1,
      }),
    ]);

    expect(baseline).toMatchObject({
      gameTimeMs: 5_000,
      running: false,
      holderGrantSessionId: "session-b",
      authorityGeneration: 2,
      staleGenerationOperationIds: ["stale-holder-action"],
    });
  });
});

function baselineActions(): ClockAuthorityAction[] {
  return [
    clockAction({
      operationId: "start",
      trustedAtMs: 1_000,
      sessionId: "session-a",
      command: "set-running",
      running: true,
    }),
    clockAction({
      operationId: "penalty-start",
      trustedAtMs: 2_000,
      sessionId: "session-a",
      command: "penalty-start",
    }),
  ];
}

function clockAction(input: {
  operationId: string;
  trustedAtMs: number;
  sessionId: string;
  acceptedAtMs?: number;
  command: ClockAuthorityAction["command"];
  running?: boolean;
  adjustmentMs?: number;
  gameTimeMs?: number;
  authorityGeneration?: number;
}): ClockAuthorityAction {
  return {
    operationId: input.operationId,
    trustedAtMs: input.trustedAtMs,
    acceptedAtMs: input.acceptedAtMs ?? input.trustedAtMs,
    sessionId: input.sessionId,
    command: input.command,
    ...(input.running === undefined ? {} : { running: input.running }),
    ...(input.adjustmentMs === undefined ? {} : { adjustmentMs: input.adjustmentMs }),
    ...(input.gameTimeMs === undefined ? {} : { gameTimeMs: input.gameTimeMs }),
    ...(input.authorityGeneration === undefined
      ? {}
      : { authorityGeneration: input.authorityGeneration }),
  };
}
