import { describe, expect, test } from "bun:test";
import { readPublicAudienceEventPage } from "./index";

const publishedEvent = {
  eventId: "event-published",
  name: "Published Event",
  timeZone: "UTC",
  publicationStatus: "published" as const,
  gameDays: ["2026-08-15"],
  lifecycle: "current" as const,
  canonicalPath: "/events/event-published",
  teams: [],
  pitches: [],
  schedule: {
    asOfMs: 0,
    runningGames: [],
    upcomingGames: [],
    scheduleGames: [],
    focusIndex: null,
  },
};

describe("public Event browser responses", () => {
  test("keeps an authoritative Published Event page indexable", async () => {
    const response = await readPublicAudienceEventPage(
      new Request("http://localhost/events/event-published"),
      { read: async () => ({ status: "accepted", value: publishedEvent }) },
      () =>
        new Response('<!doctype html><html><body><div id="root"></div></body></html>', {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBeNull();
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).not.toContain('"status":"unavailable"');
  });

  test.each([
    ["unknown", { status: "unavailable" as const }],
    ["unpublished", { status: "unavailable" as const }],
    ["database failure", { status: "retryable-failure" as const }],
  ])("marks %s browser pages noindex while keeping the HTML experience", async (_, result) => {
    const response = await readPublicAudienceEventPage(
      new Request("http://localhost/events/event-hidden"),
      { read: async () => result },
      () =>
        new Response('<!doctype html><html><body><div id="root"></div></body></html>', {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).not.toContain('"status":"unavailable"');
  });
});
