import type { ActionJsonValue } from "@/lib/event-game-actions";
import {
  orderControllerGameFacts,
  type ControllerGameFact,
  type LiveEventGameDerivedState,
} from "@/lib/live-event-game-control";
import { parseLivePenaltyPlayerKey } from "@/lib/live-event-penalties";

export type PublicAudienceTimelineKind =
  | "goal"
  | "card"
  | "penalty"
  | "timeout"
  | "suspension"
  | "heat-stoppage"
  | "seeker-release"
  | "flag-catch"
  | "overtime"
  | "finish";

export type PublicAudienceTimelineLane = "side-a" | "side-b" | "center";

export type PublicAudienceTimelinePlayer = {
  number: number;
  name: string | null;
};

type PublicAudienceTimelineEntryBase = {
  gameTimeMs: number | null;
  lane: PublicAudienceTimelineLane;
  teamName: string | null;
};

type PlayerBearingEntry = PublicAudienceTimelineEntryBase & {
  player: PublicAudienceTimelinePlayer | null;
};

export type PublicAudienceTimelineEntry =
  | (PlayerBearingEntry & { kind: "goal"; points: number })
  | (PlayerBearingEntry & {
      kind: "card";
      cardColor: "blue" | "yellow" | "red" | "ejection" | null;
      penaltyReason: string | null;
    })
  | (PlayerBearingEntry & {
      kind: "penalty";
      release:
        | { kind: "selection"; cause: string; serviceDurationMs: number | null }
        | { kind: "consequence"; cause: string; serviceDurationMs: number | null };
    })
  | (PublicAudienceTimelineEntryBase & { kind: "timeout"; action: string | null })
  | (PublicAudienceTimelineEntryBase & { kind: "suspension"; action: string | null })
  | (PublicAudienceTimelineEntryBase & { kind: "heat-stoppage"; action: string | null })
  | (PublicAudienceTimelineEntryBase & { kind: "seeker-release" })
  | (PlayerBearingEntry & { kind: "flag-catch"; points: number })
  | (PublicAudienceTimelineEntryBase & { kind: "overtime"; targetScore: number | null })
  | (PublicAudienceTimelineEntryBase & {
      kind: "finish";
      outcome: "result" | "concession" | "forfeit" | "double-forfeit";
      resultKind: string | null;
    });

export type PublicAudienceTimelineSide = {
  sideId: string;
  eventTeamId: string | null;
  teamName: string | null;
};

export type PublicAudienceTimelineProjectionInput = {
  facts: readonly ControllerGameFact[];
  sideA: PublicAudienceTimelineSide;
  sideB: PublicAudienceTimelineSide;
  lookupRosterName: (eventTeamId: string, playerNumber: number) => string | null;
  derived: PublicAudienceTimelineDerivedState;
};

export type PublicAudienceTimelineDerivedState = {
  catch: null | Pick<
    NonNullable<LiveEventGameDerivedState["catch"]>,
    "factId" | "gameTimeMs" | "catchingGameSideId"
  >;
  overtime: boolean;
  overtimeTarget: number | null;
  result: null | Pick<NonNullable<LiveEventGameDerivedState["result"]>, "factId">;
};

const PUBLIC_FACT_TYPES = new Set([
  "goal",
  "card",
  "flag-catch",
  "concession",
  "forfeit",
  "double-forfeit",
  "result",
  "timeout",
  "suspension",
  "heat-stoppage",
  "penalty-release",
  "penalty-release-consequence",
]);
const SEEKER_RELEASE_GAME_TIME_MS = 20 * 60 * 1000;

type OrderedTimelineEntry = PublicAudienceTimelineEntry & {
  absentTimeOrderKey: number;
  canonicalFactOrder: number;
  synchronizationOrder: number;
  sequence: number;
};

/**
 * Assemble the public history from effective semantic facts. Raw actions,
 * correction objects, audit evidence, and unknown fact payloads never leave
 * this allowlist boundary.
 */
export function projectPublicGameTimeline(
  input: PublicAudienceTimelineProjectionInput,
): readonly PublicAudienceTimelineEntry[] {
  const sideById = new Map([
    [input.sideA.sideId, { ...input.sideA, lane: "side-a" as const }],
    [input.sideB.sideId, { ...input.sideB, lane: "side-b" as const }],
  ]);
  const effectiveFacts = orderControllerGameFacts(input.facts).filter((fact) => fact.effective);
  const penaltyReasons = penaltyReasonsByCard(effectiveFacts);
  const entries: OrderedTimelineEntry[] = [];

  effectiveFacts.forEach((fact, sequence) => {
    if (fact.factType === "clock" || fact.factType === "penalty-reason") return;
    if (!PUBLIC_FACT_TYPES.has(fact.factType)) return;

    const data = recordData(fact.data);
    const side = fact.gameSideId === null ? undefined : sideById.get(fact.gameSideId);
    const common = {
      gameTimeMs: fact.gameTimeMs,
      lane: side?.lane ?? "center",
      teamName: side?.teamName ?? null,
    } as const;
    switch (fact.factType) {
      case "goal":
        addEntry(
          entries,
          {
            ...common,
            kind: "goal",
            points: numberValue(data?.points) ?? 10,
            player: playerForFact(fact, side, input.lookupRosterName, effectiveFacts),
          },
          sequence,
          fact.synchronizationOrder,
          sequence,
        );
        break;
      case "card":
        addEntry(
          entries,
          {
            ...common,
            kind: "card",
            cardColor: cardColorFor(data),
            penaltyReason: penaltyReasons.get(fact.factId) ?? null,
            player: playerForFact(fact, side, input.lookupRosterName, effectiveFacts),
          },
          sequence,
          fact.synchronizationOrder,
          sequence,
        );
        break;
      case "flag-catch":
        addEntry(
          entries,
          {
            ...common,
            kind: "flag-catch",
            points: numberValue(data?.points) ?? 30,
            player: playerForFact(fact, side, input.lookupRosterName, effectiveFacts),
          },
          sequence,
          fact.synchronizationOrder,
          sequence,
        );
        break;
      case "concession":
      case "forfeit":
      case "double-forfeit":
      case "result":
        addEntry(
          entries,
          {
            ...common,
            kind: "finish",
            lane: fact.factType === "double-forfeit" ? "center" : common.lane,
            teamName: fact.factType === "double-forfeit" ? null : common.teamName,
            outcome: fact.factType,
            resultKind: stringValue(data?.resultKind),
          },
          sequence,
          fact.synchronizationOrder,
          sequence,
        );
        break;
      case "timeout":
        addEntry(
          entries,
          { ...common, kind: "timeout", action: stringValue(data?.timeoutAction) },
          sequence,
          fact.synchronizationOrder,
          sequence,
        );
        break;
      case "suspension":
        addEntry(
          entries,
          {
            ...common,
            kind: "suspension",
            lane: "center",
            teamName: null,
            action: stringValue(data?.suspensionAction),
          },
          sequence,
          fact.synchronizationOrder,
          sequence,
        );
        break;
      case "heat-stoppage":
        addEntry(
          entries,
          {
            ...common,
            kind: "heat-stoppage",
            lane: "center",
            teamName: null,
            action: stringValue(data?.heatAction),
          },
          sequence,
          fact.synchronizationOrder,
          sequence,
        );
        break;
      case "penalty-release":
      case "penalty-release-consequence":
        addEntry(
          entries,
          {
            ...common,
            kind: "penalty",
            player: playerForFact(fact, side, input.lookupRosterName, effectiveFacts),
            release: {
              kind: fact.factType === "penalty-release" ? "selection" : "consequence",
              cause: stringValue(data?.releaseCause) ?? "released",
              serviceDurationMs: numberValue(data?.serviceDurationMs),
            },
          },
          sequence,
          fact.synchronizationOrder,
          sequence,
        );
        break;
    }
  });

  const seekerRelease = synthesizeSeekerRelease(effectiveFacts);
  if (seekerRelease !== null) entries.push(seekerRelease);

  if (input.derived.catch !== null && !entries.some((entry) => entry.kind === "flag-catch")) {
    const catchFact = effectiveFacts.find((fact) => fact.factId === input.derived.catch?.factId);
    const side = sideById.get(input.derived.catch.catchingGameSideId);
    const catchFactOrder =
      catchFact === undefined ? effectiveFacts.length : effectiveFacts.indexOf(catchFact);
    addEntry(
      entries,
      {
        kind: "flag-catch",
        gameTimeMs: input.derived.catch.gameTimeMs,
        lane: side?.lane ?? "center",
        teamName: side?.teamName ?? null,
        player:
          catchFact === undefined
            ? null
            : playerForFact(catchFact, side, input.lookupRosterName, effectiveFacts),
        points: numberValue(recordData(catchFact?.data)?.points) ?? 30,
      },
      catchFactOrder,
      catchFact?.synchronizationOrder ?? 0,
      catchFactOrder,
    );
  }

  if (input.derived.overtime && input.derived.catch !== null) {
    const catchEntry = entries.find(
      (entry) =>
        entry.kind === "flag-catch" && entry.gameTimeMs === input.derived.catch?.gameTimeMs,
    );
    if (catchEntry !== undefined) {
      addEntry(
        entries,
        {
          kind: "overtime",
          gameTimeMs: input.derived.catch.gameTimeMs,
          lane: "center",
          teamName: null,
          targetScore: input.derived.overtimeTarget ?? null,
        },
        catchEntry.canonicalFactOrder,
        catchEntry.synchronizationOrder,
        catchEntry.sequence + 1,
      );
    }
  }

  if (input.derived.result !== null && !entries.some((entry) => entry.kind === "finish")) {
    const resultFact = effectiveFacts.find((fact) => fact.factId === input.derived.result?.factId);
    if (resultFact !== undefined) {
      const side = resultFact.gameSideId === null ? undefined : sideById.get(resultFact.gameSideId);
      addEntry(
        entries,
        {
          kind: "finish",
          gameTimeMs: resultFact.gameTimeMs,
          lane: side?.lane ?? "center",
          teamName: side?.teamName ?? null,
          outcome: "result",
          resultKind: stringValue(recordData(resultFact.data)?.resultKind),
        },
        effectiveFacts.indexOf(resultFact),
        resultFact.synchronizationOrder,
        effectiveFacts.indexOf(resultFact),
      );
    }
  }

  return entries
    .sort(compareTimelineEntries)
    .map(
      ({
        absentTimeOrderKey: _absentTimeOrderKey,
        canonicalFactOrder: _canonicalFactOrder,
        synchronizationOrder: _synchronizationOrder,
        sequence: _sequence,
        ...entry
      }) => entry,
    );
}

function synthesizeSeekerRelease(
  effectiveFacts: readonly ControllerGameFact[],
): OrderedTimelineEntry | null {
  const source = effectiveFacts.findLast(
    (fact) =>
      fact.factType === "clock" &&
      fact.gameTimeMs !== null &&
      fact.gameTimeMs >= SEEKER_RELEASE_GAME_TIME_MS,
  );
  if (source === undefined || source.gameTimeMs === null) return null;
  return {
    kind: "seeker-release",
    gameTimeMs: SEEKER_RELEASE_GAME_TIME_MS,
    lane: "center",
    teamName: null,
    absentTimeOrderKey: source.synchronizationOrder,
    canonicalFactOrder: effectiveFacts.indexOf(source),
    synchronizationOrder: source.synchronizationOrder,
    sequence: effectiveFacts.indexOf(source),
  };
}

function penaltyReasonsByCard(facts: readonly ControllerGameFact[]): Map<string, string> {
  const reasons = new Map<string, string>();
  for (const fact of facts) {
    if (fact.factType !== "penalty-reason") continue;
    const data = recordData(fact.data);
    const target = stringValue(data?.targetCardFactId);
    const reason = stringValue(data?.reason);
    if (target !== null && reason !== null) reasons.set(target, reason);
  }
  return reasons;
}

function playerForFact(
  fact: ControllerGameFact,
  side: (PublicAudienceTimelineSide & { lane: PublicAudienceTimelineLane }) | undefined,
  lookupRosterName: PublicAudienceTimelineProjectionInput["lookupRosterName"],
  facts: readonly ControllerGameFact[],
): PublicAudienceTimelinePlayer | null {
  const data = recordData(fact.data);
  let playerNumber = numberValue(data?.playerNumber);
  if (
    playerNumber === null &&
    (fact.factType === "penalty-release" || fact.factType === "penalty-release-consequence")
  ) {
    const playerKey = stringValue(data?.playerKey);
    playerNumber =
      playerKey === null ? null : (parseLivePenaltyPlayerKey(playerKey)?.playerNumber ?? null);
  }
  if (
    playerNumber === null &&
    (fact.factType === "penalty-release" || fact.factType === "penalty-release-consequence")
  ) {
    const sourceFactId = stringValue(data?.sourceFactId);
    const source = facts.find((candidate) => candidate.factId === sourceFactId);
    playerNumber = numberValue(recordData(source?.data)?.playerNumber);
  }
  if (playerNumber === null) return null;
  return {
    number: playerNumber,
    name:
      side?.eventTeamId === null || side?.eventTeamId === undefined
        ? null
        : lookupRosterName(side.eventTeamId, playerNumber),
  };
}

function cardColorFor(
  data: Record<string, unknown> | null,
): "blue" | "yellow" | "red" | "ejection" | null {
  return data?.cardType === "blue" ||
    data?.cardType === "yellow" ||
    data?.cardType === "red" ||
    data?.cardType === "ejection"
    ? data.cardType
    : null;
}

function addEntry(
  entries: OrderedTimelineEntry[],
  entry: PublicAudienceTimelineEntry,
  canonicalFactOrder: number,
  synchronizationOrder: number,
  sequence: number,
  absentTimeOrderKey = synchronizationOrder,
) {
  entries.push({
    ...entry,
    absentTimeOrderKey,
    canonicalFactOrder,
    synchronizationOrder,
    sequence,
  });
}

function compareTimelineEntries(left: OrderedTimelineEntry, right: OrderedTimelineEntry): number {
  if (left.gameTimeMs === null && right.gameTimeMs !== null) return 1;
  if (left.gameTimeMs !== null && right.gameTimeMs === null) return -1;
  if (left.gameTimeMs !== null && right.gameTimeMs !== null) {
    return (
      right.gameTimeMs - left.gameTimeMs ||
      right.canonicalFactOrder - left.canonicalFactOrder ||
      right.synchronizationOrder - left.synchronizationOrder ||
      right.sequence - left.sequence
    );
  }
  return (
    right.absentTimeOrderKey - left.absentTimeOrderKey ||
    right.canonicalFactOrder - left.canonicalFactOrder ||
    right.synchronizationOrder - left.synchronizationOrder ||
    right.sequence - left.sequence
  );
}

function recordData(value: ActionJsonValue | undefined): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
