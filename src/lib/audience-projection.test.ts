import { describe, expect, test } from "bun:test";
import { createAudienceProjection, PUBLIC_AUDIENCE_ABSENCE } from "@/lib/audience-projection";
import {
  createEventCatalog,
  createFoundationEventCatalogStorage,
  createUnavailableEventCatalogStorage,
} from "@/lib/event-catalog";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import {
  MemoryTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
} from "@/lib/technical-admin-auth";
import { readAudienceEvent } from "@/index";

const authority = createTechnicalAdminAuth(
  { environment: "test", origin: "https://timer.example", rpId: "timer.example" },
  new MemoryTechnicalAdminAuthRepository(),
).resolveHostLocalAuthority();

describe("Audience Publication Projection", () => {
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
