export type EventControllerHeaderProjection = {
  identity?: {
    pitchName: string | null;
    gameCode: string | null;
    gameDesignation: string | null;
  };
  teamAssignments?: readonly { eventTeamName?: string; gameSideId: string }[];
} | null;

export function eventControllerHeaderIdentity(projection: EventControllerHeaderProjection) {
  const pitch = projection?.identity?.pitchName?.trim() ?? "";
  const gameCode = projection?.identity?.gameCode?.trim() ?? "";
  const designation = projection?.identity?.gameDesignation?.trim() ?? "";
  return {
    eyebrow: [pitch, gameCode].filter((value) => value.length > 0).join(" · ") || "Event Game",
    title:
      designation.length > 0
        ? designation
        : `${eventTeamName(projection, 0)} vs ${eventTeamName(projection, 1)}`,
  };
}

function eventTeamName(projection: EventControllerHeaderProjection, sideIndex: number): string {
  const assignment = projection?.teamAssignments?.[sideIndex];
  return assignment?.eventTeamName ?? `Game Side ${assignment?.gameSideId ?? sideIndex + 1}`;
}
