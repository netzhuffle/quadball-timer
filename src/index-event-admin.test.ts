import { describe, expect, test } from "bun:test";
import { readEventAdminIdentityRoute, readEventAdminPresentationRoute } from "./index";

describe("Event Admin presentation HTTP route", () => {
  test("passes the event segment and Event Game segment to both presentation changes", () => {
    const path = "/api/event-admin/events/event-a/event-games/game-17/presentation".split("/");

    expect(readEventAdminPresentationRoute(path)).toEqual({
      eventId: "event-a",
      eventGameId: "game-17",
    });
  });
});

test("passes the Event, Game Day, and Event Game segments to identity correction", () => {
  const path = "/api/event-admin/events/event-a/game-days/day-2/event-games/game-17/identity".split(
    "/",
  );

  expect(readEventAdminIdentityRoute(path)).toEqual({
    eventId: "event-a",
    gameDayId: "day-2",
    eventGameId: "game-17",
  });
});
