import { describe, expect, test } from "bun:test";
import { createAudienceProjection, PUBLIC_AUDIENCE_ABSENCE } from "@/lib/audience-projection";
import {
  createEventCatalog,
  createFoundationEventCatalogStorage,
  createUnavailableEventCatalogStorage,
  type EventCatalogFoundationStorage,
  type EventCatalogStorageSnapshot,
  type StoredEvent,
} from "@/lib/event-catalog";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import {
  MemoryTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
} from "@/lib/technical-admin-auth";
import { readAudienceEvent, readAudienceEvents, readAudienceSitemap } from "@/index";

const authority = createTechnicalAdminAuth(
  { environment: "test", origin: "https://timer.example", rpId: "timer.example" },
  new MemoryTechnicalAdminAuthRepository(),
).resolveHostLocalAuthority();

describe("Audience Publication Projection", () => {
  test("keeps a zero-Day Published Event explicitly unscheduled", async () => {
    const event: StoredEvent = {
      eventId: "event-unscheduled",
      name: "Unscheduled",
      timeZone: "UTC",
      publicationStatus: "published",
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const snapshot = {
      listEvents: () => [event],
      findEvent: () => event,
      listGameDays: () => [],
      listEventTeams: () => [],
      listPitches: () => [],
    } as unknown as EventCatalogStorageSnapshot;
    const audience = createAudienceProjection(
      { snapshot: async () => snapshot } as unknown as EventCatalogFoundationStorage,
      { now: () => Date.parse("2026-08-14T12:00:00.000Z") },
    );

    const result = await audience.list();
    expect(result).toMatchObject({
      status: "accepted",
      value: { events: [{ name: "Unscheduled", lifecycle: "unscheduled" }] },
    });
  });

  test("lists only Published Events and classifies them in each Event timezone", async () => {
    const foundation = createInMemoryFoundationStorage();
    const storage = createFoundationEventCatalogStorage(foundation);
    const catalog = createEventCatalog(storage, {});
    const audience = createAudienceProjection(storage, {
      now: () => Date.parse("2026-08-14T00:30:00.000Z"),
    });
    const current = await catalog.createEvent(
      { name: "Current", timeZone: "Europe/Zurich" },
      authority,
    );
    const future = await catalog.createEvent({ name: "Future", timeZone: "UTC" }, authority);
    const past = await catalog.createEvent({ name: "Past", timeZone: "UTC" }, authority);
    if (current.status !== "accepted" || future.status !== "accepted" || past.status !== "accepted")
      throw new Error("Expected Events.");
    await catalog.addGameDay(current.value.eventId, { date: "2026-08-14" }, authority);
    await catalog.addGameDay(future.value.eventId, { date: "2026-08-15" }, authority);
    await catalog.addGameDay(past.value.eventId, { date: "2026-08-13" }, authority);
    await catalog.changePublicationStatus(
      current.value.eventId,
      { status: "published" },
      authority,
    );
    await catalog.changePublicationStatus(future.value.eventId, { status: "published" }, authority);
    await catalog.changePublicationStatus(past.value.eventId, { status: "published" }, authority);

    const result = await audience.list();
    expect(result).toMatchObject({ status: "accepted" });
    if (result.status !== "accepted") return;
    expect(result.value.events.map((event) => [event.name, event.lifecycle])).toEqual([
      ["Current", "current"],
      ["Future", "future"],
      ["Past", "past"],
    ]);
    expect(result.value.events[0]).toMatchObject({
      canonicalPath: `/events/${encodeURIComponent(current.value.eventId)}`,
      teams: [],
      pitches: [],
    });
    foundation.close();
  });

  test("adapts the allowlisted list and sitemap without exposing hidden Event names", async () => {
    const projection = {
      list: async () => ({
        status: "accepted" as const,
        value: {
          events: [
            {
              eventId: "event-public",
              name: "Public Event",
              timeZone: "UTC",
              publicationStatus: "published" as const,
              gameDays: ["2026-08-14"],
              lifecycle: "current" as const,
              canonicalPath: "/events/event-public",
              teams: [],
              pitches: [],
            },
          ],
        },
      }),
    };
    const listResponse = await readAudienceEvents(
      new Request("https://timer.example/api/audience/events"),
      projection,
    );
    expect(listResponse.status).toBe(200);
    expect(await listResponse.text()).toContain("Public Event");

    const sitemapResponse = await readAudienceSitemap(
      new Request("https://timer.example/sitemap.xml"),
      projection,
    );
    const sitemap = await sitemapResponse.text();
    expect(sitemapResponse.status).toBe(200);
    expect(sitemap).toContain("https://timer.example/events/event-public");
    expect(sitemap).not.toContain("unpublished");
  });

  test("excludes a real Unpublished Event from discovery and its sitemap", async () => {
    const foundation = createInMemoryFoundationStorage();
    const storage = createFoundationEventCatalogStorage(foundation);
    const catalog = createEventCatalog(storage, {});
    const audience = createAudienceProjection(storage, {
      now: () => Date.parse("2026-08-14T12:00:00.000Z"),
    });
    const hidden = await catalog.createEvent({ name: "Hidden Event", timeZone: "UTC" }, authority);
    const visible = await catalog.createEvent(
      { name: "Visible Event", timeZone: "UTC" },
      authority,
    );
    if (hidden.status !== "accepted" || visible.status !== "accepted")
      throw new Error("Expected Events.");
    await catalog.addGameDay(hidden.value.eventId, { date: "2026-08-14" }, authority);
    await catalog.addGameDay(visible.value.eventId, { date: "2026-08-14" }, authority);
    await catalog.changePublicationStatus(
      visible.value.eventId,
      { status: "published" },
      authority,
    );

    const list = await audience.list();
    if (list.status !== "accepted") throw new Error("Expected discovery list.");
    expect(list.value.events.map((event) => event.name)).toEqual(["Visible Event"]);

    const sitemap = await readAudienceSitemap(
      new Request("https://timer.example/sitemap.xml"),
      audience,
    );
    const sitemapBody = await sitemap.text();
    expect(sitemapBody).toContain(encodeURIComponent(visible.value.eventId));
    expect(sitemapBody).not.toContain(encodeURIComponent(hidden.value.eventId));
    foundation.close();
  });

  test("uses identical anonymous absence for unpublished, cancelled, nonexistent, and unknown Events", async () => {
    const foundation = createInMemoryFoundationStorage();
    const storage = createFoundationEventCatalogStorage(foundation);
    const catalog = createEventCatalog(storage, {});
    const audience = createAudienceProjection(storage);
    const event = await catalog.createEvent({ name: "Private", timeZone: "UTC" }, authority);
    if (event.status !== "accepted") throw new Error("Expected Event.");
    await catalog.addGameDay(event.value.eventId, { date: "2026-08-14" }, authority);

    const unpublished = await audience.read(event.value.eventId);
    const unknown = await audience.read("event-does-not-exist");
    expect(unpublished).toEqual(unknown);
    expect(unpublished).toEqual({ status: "unavailable" });

    await catalog.changePublicationStatus(event.value.eventId, { status: "published" }, authority);
    await catalog.changePublicationStatus(
      event.value.eventId,
      { status: "cancelled", impactConfirmed: true },
      authority,
    );
    expect(await audience.read(event.value.eventId)).toEqual(PUBLIC_AUDIENCE_ABSENCE);
    expect(await audience.read("" as unknown)).toEqual({ status: "unavailable" });
    const anonymousResponses = await Promise.all(
      [event.value.eventId, "event-does-not-exist", ""].map((eventId) =>
        readAudienceEvent(
          new Request(`https://timer.example/api/audience/events/${eventId}`),
          audience,
        ),
      ),
    );
    expect(anonymousResponses.map((response) => response.status)).toEqual([404, 404, 404]);
    expect(await Promise.all(anonymousResponses.map((response) => response.text()))).toEqual([
      '{"status":"unavailable"}',
      '{"status":"unavailable"}',
      '{"status":"unavailable"}',
    ]);
    foundation.close();
  });

  test("projects only current allowlisted state and has no publication history", async () => {
    const foundation = createInMemoryFoundationStorage();
    const storage = createFoundationEventCatalogStorage(foundation);
    const catalog = createEventCatalog(storage, {});
    const audience = createAudienceProjection(storage);
    const event = await catalog.createEvent({ name: "Current", timeZone: "UTC" }, authority);
    if (event.status !== "accepted") throw new Error("Expected Event.");
    const day = await catalog.addGameDay(event.value.eventId, { date: "2026-08-14" }, authority);
    if (day.status !== "accepted") throw new Error("Expected Game Day.");
    await catalog.changePublicationStatus(event.value.eventId, { status: "published" }, authority);
    await catalog.changePublicationStatus(
      event.value.eventId,
      { status: "cancelled", impactConfirmed: true },
      authority,
    );
    await catalog.updateEvent(event.value.eventId, { name: "Current Renamed" }, authority);
    await catalog.changePublicationStatus(event.value.eventId, { status: "published" }, authority);

    const current = await audience.read(event.value.eventId);
    expect(current).toMatchObject({
      status: "accepted",
      value: {
        eventId: event.value.eventId,
        name: "Current Renamed",
        publicationStatus: "published",
        gameDays: ["2026-08-14"],
      },
    });
    if (current.status !== "accepted") return;
    expect(current.value).not.toHaveProperty("auditTrail");
    expect(current.value).not.toHaveProperty("createdAtMs");
    expect(JSON.stringify(current.value)).not.toContain("event-publication-changed");
    foundation.close();
  });

  test("collapses authoritative storage failure to the same public HTTP absence", async () => {
    const projection = createAudienceProjection(
      createUnavailableEventCatalogStorage("private storage detail"),
    );
    expect(await projection.read("published-event")).toEqual({ status: "retryable-failure" });

    const failureResponse = await readAudienceEvent(
      new Request("https://timer.example/api/audience/events/published-event"),
      projection,
    );
    const absenceResponse = await readAudienceEvent(
      new Request("https://timer.example/api/audience/events/unknown-event"),
      { read: async () => PUBLIC_AUDIENCE_ABSENCE },
    );
    expect(failureResponse.status).toBe(404);
    const failureBody = await failureResponse.text();
    expect(failureBody).toBe(await absenceResponse.text());
    expect(failureBody).not.toContain("private storage detail");
  });
});
