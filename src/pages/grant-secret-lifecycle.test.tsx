import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { EventAdminPage } from "@/pages/event-admin-page";
import { PitchManagerPage } from "@/pages/pitch-manager-page";
import { TechnicalAdminPage } from "@/pages/technical-admin-page";

const pitchManagerView = {
  eventId: "event",
  gameDayId: "day",
  gameDayDate: "2026-08-15",
  eventTimeZone: "UTC",
  pitch: { pitchId: "pitch", name: "Pitch Main" },
  schedule: [
    {
      pitchSlotId: "slot",
      gameplaySlotId: "gameplay",
      sequence: 1,
      expectedStart: "2026-08-15 10:00 UTC",
      eventGame: null,
      conflictEventGameIds: [],
      controlGrantStatus: "active",
    },
  ],
  grantSessionExpiresAt: "2026-08-15 12:00 UTC",
};

const eventHub = {
  event: {
    eventId: "event",
    name: "Event",
    timeZone: "UTC",
    lifecycle: "active",
    publicationStatus: "unpublished",
    gameDays: [
      {
        gameDayId: "day",
        date: "2026-08-15",
        classification: "scheduled",
        heatStoppageConfiguration: "disabled" as const,
      },
    ],
    teams: [],
    pitches: [{ pitchId: "pitch", name: "Pitch Main" }],
    gameplaySlots: [
      {
        gameplaySlotId: "gameplay",
        gameDayId: "day",
        sequence: 1,
        scheduledStartMs: Date.UTC(2026, 7, 15, 10),
        expectedDelayMs: 0,
      },
    ],
    pitchSlots: [
      {
        pitchSlotId: "slot",
        gameDayId: "day",
        pitchId: "pitch",
        gameplaySlotId: "gameplay",
        sequence: 1,
        expectedDelayMs: 0,
      },
    ],
    eventGames: [],
  },
  selectedGameDayId: "day",
  authority: "event-admin",
};

const identityEventHub = {
  ...eventHub,
  event: {
    ...eventHub.event,
    teams: [
      { eventTeamId: "team-a", name: "Original Team", defaultColor: "#112233", roster: [] },
      { eventTeamId: "team-b", name: "Corrected Team", defaultColor: "#445566", roster: [] },
    ],
    eventGames: [
      {
        eventGameId: "game-identity",
        gameDayId: "day",
        gameplaySlotId: "gameplay",
        pitchSlotId: "slot",
        gameCode: "G-1",
        gameDesignation: "Pool A",
        sideA: {
          sideId: "side-a",
          eventTeamId: "team-a",
          eventTeamName: "Original Team",
          sourceLabel: null,
        },
        sideB: {
          sideId: "side-b",
          eventTeamId: "team-b",
          eventTeamName: "Corrected Team",
          sourceLabel: null,
        },
        expectedStartMs: Date.UTC(2026, 7, 15, 10),
        expectedPlayingPeriod: { startMs: 0, endMs: 1 },
        scheduleConflict: false,
        teamScheduleConflict: false,
      },
    ],
  },
};

const twoDayEventHub = {
  ...eventHub,
  selectedGameDayId: "day",
  event: {
    ...eventHub.event,
    gameDays: [
      ...eventHub.event.gameDays,
      {
        gameDayId: "day-two",
        date: "2026-08-16",
        classification: "scheduled",
        heatStoppageConfiguration: "enabled" as const,
      },
    ],
  },
};

const dayBEventHub = {
  ...twoDayEventHub,
  selectedGameDayId: "day-two",
  event: {
    ...twoDayEventHub.event,
    gameDays: twoDayEventHub.event.gameDays,
    gameplaySlots: [
      {
        ...eventHub.event.gameplaySlots[0]!,
        gameplaySlotId: "gameplay-day-two",
        gameDayId: "day-two",
        sequence: 2,
      },
    ],
    pitchSlots: [
      {
        ...eventHub.event.pitchSlots[0]!,
        pitchSlotId: "slot-day-two",
        gameplaySlotId: "gameplay-day-two",
        gameDayId: "day-two",
        sequence: 2,
      },
    ],
  },
};

const eventBHub = {
  ...eventHub,
  event: {
    ...eventHub.event,
    eventId: "event-b",
    name: "Event B",
  },
};

const lockedGameHub = {
  ...twoDayEventHub,
  event: {
    ...twoDayEventHub.event,
    eventGames: [
      {
        ...identityEventHub.event.eventGames[0]!,
        gameDesignation: "Opening",
      },
    ],
  },
};

const eventPitchView = {
  pitch: { pitchId: "pitch", name: "Pitch Main" },
  gameplaySlots: eventHub.event.gameplaySlots,
  pitchSlots: eventHub.event.pitchSlots,
  eventGames: [],
};

describe("Grant secret UI lifecycle", () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalNavigator = globalThis.navigator;
  const originalFetch = globalThis.fetch;
  const originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  let testWindow: Window;
  let container: HTMLDivElement;
  let root: Root;
  let fetchHandler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

  beforeEach(() => {
    testWindow = new Window({ url: "https://timer.quadball.app/event-admin?eventId=event" });
    Object.assign(globalThis, {
      window: testWindow,
      document: testWindow.document,
      navigator: testWindow.navigator,
      fetch: (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET"))
          .toUpperCase()
          .trim();
        const headers = new Headers(init?.headers);
        if (method !== "GET" && url.includes("/api/event-admin/")) {
          expect(headers.get("x-event-admin-csrf")).toBe(
            url.endsWith("/api/event-admin/admit") ? null : "event-admin-proof",
          );
        }
        if (method !== "GET" && url.includes("/api/pitch-manager/")) {
          expect(headers.get("x-pitch-manager-csrf")).toBe(
            url.endsWith("/api/pitch-manager/admit") ? null : "pitch-manager-proof",
          );
        }
        return fetchHandler(input, init);
      },
    });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.cookie = "__Host-event-admin-csrf=event-admin-proof; Path=/; Secure; SameSite=Strict";
    document.cookie =
      "__Host-pitch-manager-csrf=pitch-manager-proof; Path=/; Secure; SameSite=Strict";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  test("Event Admin configures the selected Game Day heat setting", async () => {
    let configuration: "enabled" | "disabled" = "disabled";
    let configurationUpdates = 0;
    let hubCalls = 0;
    fetchHandler = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/event-admin/admit")) {
        expect(new Headers(init?.headers).has("x-event-admin-csrf")).toBe(false);
        return json({ status: "admitted", sessionExpiresAtMs: 123_000 });
      }
      if (url.includes("/api/event-admin/hub")) {
        hubCalls += 1;
        if (hubCalls === 1) return json({ status: "rejected" }, 401);
        return json({
          status: "accepted",
          value: {
            ...eventHub,
            event: {
              ...eventHub.event,
              gameDays: [
                { ...eventHub.event.gameDays[0]!, heatStoppageConfiguration: configuration },
              ],
            },
          },
        });
      }
      if (url.includes("/heat-stoppage-configuration") && method === "PATCH") {
        expect(new Headers(init?.headers).get("x-event-admin-csrf")).toBe("event-admin-proof");
        configurationUpdates += 1;
        const rawBody = typeof init?.body === "string" ? init.body : "";
        const body = JSON.parse(rawBody) as { configuration: typeof configuration };
        configuration = body.configuration;
        return json({ status: "accepted", value: { heatStoppageConfiguration: configuration } });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    await render(<EventAdminPage />);
    await admitEventAdmin();
    expect(container.textContent).toContain("Currently disabled");
    await clickButton("Enable");
    expect(configurationUpdates).toBe(1);
    expect(container.textContent).toContain("Currently enabled");
  });

  test("Event Admin operates public identity and presentation controls", async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    let hubCalls = 0;
    fetchHandler = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/event-admin/admit"))
        return json({ status: "admitted", sessionExpiresAtMs: 123_000 });
      if (url.includes("/api/event-admin/hub")) {
        hubCalls += 1;
        if (hubCalls === 1) return json({ status: "rejected" }, 401);
        return json({ status: "accepted", value: identityEventHub });
      }
      if (method === "POST" && (url.endsWith("/identity") || url.endsWith("/presentation"))) {
        requests.push({
          url,
          body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
            string,
            unknown
          >,
        });
        return json({ status: "accepted", value: identityEventHub });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    await render(<EventAdminPage />);
    await admitEventAdmin();
    const identitySelect = container.querySelector(
      'select[aria-label="Correct game-identity sideA Event Team"]',
    ) as HTMLSelectElement | null;
    expect(identitySelect).not.toBeNull();
    await act(async () => {
      setSelectValue(identitySelect as HTMLSelectElement, "team-b");
      await flush();
    });
    const identityButton = Array.from(container.querySelectorAll("button")).find(
      (button) =>
        button.textContent?.trim() === "Correct identity" &&
        button.parentElement?.querySelector(
          'select[aria-label="Correct game-identity sideA Event Team"]',
        ) !== null,
    );
    expect(identityButton).not.toBeNull();
    await act(async () => {
      identityButton?.click();
      await flush();
    });
    expect(requests[0]).toMatchObject({
      url: "/api/event-admin/events/event/game-days/day/event-games/game-identity/identity",
      body: { gameSideId: "side-a", eventTeamId: "team-b", confirmation: false },
    });

    const orientation = container.querySelector(
      'select[aria-label="game-identity pitch orientation"]',
    ) as HTMLSelectElement;
    await act(async () => {
      setSelectValue(orientation, "side-b-left");
      await flush();
    });
    expect(requests.at(-1)).toMatchObject({
      url: "/api/event-admin/events/event/event-games/game-identity/presentation",
      body: { change: { type: "pitch-orientation", pitchOrientation: "side-b-left" } },
    });

    const color = container.querySelector(
      'input[aria-label="game-identity sideA displayed color"]',
    ) as HTMLInputElement;
    await act(async () => {
      setInputValue(color, "#abcdef");
      await flush();
    });
    const colorButton = color.parentElement?.querySelector("button") as HTMLButtonElement | null;
    expect(colorButton).not.toBeNull();
    await act(async () => {
      colorButton?.click();
      await flush();
    });
    expect(requests.at(-1)).toMatchObject({
      url: "/api/event-admin/events/event/event-games/game-identity/presentation",
      body: {
        change: { type: "displayed-team-color", gameSideId: "side-a", color: "#abcdef" },
      },
    });
  });

  test("Event Admin ignores stale Day A heat success after selecting Day B", async () => {
    const pendingMutation = deferred<Response>();
    const hubGameDays: Array<string | null> = [];
    fetchHandler = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.includes("/api/event-admin/hub")) {
        const parsed = new URL(url, "http://timer.quadball.app");
        const gameDayId = parsed.searchParams.get("gameDayId");
        hubGameDays.push(gameDayId);
        return json({
          status: "accepted",
          value: gameDayId === "day-two" ? dayBEventHub : twoDayEventHub,
        });
      }
      if (url.includes("/heat-stoppage-configuration") && method === "PATCH")
        return pendingMutation.promise;
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    await render(<EventAdminPage />);
    await clickButton("Enable");
    const gameDaySelector = container.querySelector(
      "select#game-day-selector",
    ) as HTMLSelectElement;
    await act(async () => {
      setSelectValue(gameDaySelector, "day-two");
      await flush();
    });
    pendingMutation.resolve(
      json({ status: "accepted", value: { heatStoppageConfiguration: "enabled" } }),
    );
    await flushAct();

    expect(gameDaySelector.value).toBe("day-two");
    expect(container.textContent).toContain("Currently enabled");
    expect(container.textContent).toContain("Slot 2");
    expect(container.textContent).not.toContain("Slot 1 ·");
    expect(container.textContent).not.toContain("Heat Stoppage Configuration enabled.");
    expect(hubGameDays).toEqual([null, "day-two"]);
  });

  test("Event Admin ignores stale Day A heat rejection after selecting Day B", async () => {
    const pendingMutation = deferred<Response>();
    const hubGameDays: Array<string | null> = [];
    fetchHandler = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.includes("/api/event-admin/hub")) {
        const parsed = new URL(url, "http://timer.quadball.app");
        const gameDayId = parsed.searchParams.get("gameDayId");
        hubGameDays.push(gameDayId);
        return json({
          status: "accepted",
          value: gameDayId === "day-two" ? dayBEventHub : twoDayEventHub,
        });
      }
      if (url.includes("/heat-stoppage-configuration") && method === "PATCH")
        return pendingMutation.promise;
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    await render(<EventAdminPage />);
    await clickButton("Enable");
    const gameDaySelector = container.querySelector(
      "select#game-day-selector",
    ) as HTMLSelectElement;
    await act(async () => {
      setSelectValue(gameDaySelector, "day-two");
      await flush();
    });
    pendingMutation.resolve(json({ status: "rejected", detail: "stale Day A rejection" }, 409));
    await flushAct();

    expect(gameDaySelector.value).toBe("day-two");
    expect(container.textContent).toContain("Currently enabled");
    expect(container.textContent).toContain("Slot 2");
    expect(container.textContent).not.toContain("Slot 1 ·");
    expect(container.textContent).not.toContain("stale Day A rejection");
    expect(hubGameDays).toEqual([null, "day-two"]);
  });

  test("Event Admin ignores stale Day A heat network failure after selecting Day B", async () => {
    const pendingMutation = deferred<Response>();
    const hubGameDays: Array<string | null> = [];
    fetchHandler = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.includes("/api/event-admin/hub")) {
        const parsed = new URL(url, "http://timer.quadball.app");
        const gameDayId = parsed.searchParams.get("gameDayId");
        hubGameDays.push(gameDayId);
        return json({
          status: "accepted",
          value: gameDayId === "day-two" ? dayBEventHub : twoDayEventHub,
        });
      }
      if (url.includes("/heat-stoppage-configuration") && method === "PATCH")
        return pendingMutation.promise;
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    await render(<EventAdminPage />);
    await clickButton("Enable");
    const gameDaySelector = container.querySelector(
      "select#game-day-selector",
    ) as HTMLSelectElement;
    await act(async () => {
      setSelectValue(gameDaySelector, "day-two");
      await flush();
    });
    pendingMutation.reject(new Error("stale Day A network failure"));
    await flushAct();

    expect(gameDaySelector.value).toBe("day-two");
    expect(container.textContent).toContain("Currently enabled");
    expect(container.textContent).toContain("Slot 2");
    expect(container.textContent).not.toContain("Slot 1 ·");
    expect(container.textContent).not.toContain("stale Day A network failure");
    expect(hubGameDays).toEqual([null, "day-two"]);
  });

  test("Event Admin previews and confirms correction and reopening with separate override", async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    let hubCalls = 0;
    const correctionPreview = {
      operation: "locked-game-correction",
      fingerprint: "correction-preview-v1",
      impact: {
        facts: "corrected",
        lifecycle: { from: "finished", to: "finished", lock: "retained" },
        timer: "unchanged",
        authority: { controlGrant: "preserved", qr: "preserved", grantVersion: "preserved" },
        sessions: { category: "terminated", count: 1 },
        code: { category: "expired", count: 1 },
        queuedDiscard: { category: "locked-replay", count: 1 },
      },
    };
    const reopeningPreview = {
      ...correctionPreview,
      operation: "game-reopening",
      fingerprint: "reopening-preview-v1",
      impact: { ...correctionPreview.impact, facts: "preserved", timer: "restarted" },
    };
    fetchHandler = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/event-admin/admit"))
        return json({ status: "admitted", sessionExpiresAtMs: 123_000 });
      if (url.includes("/api/event-admin/hub")) {
        hubCalls += 1;
        if (hubCalls === 1) return json({ status: "rejected" }, 401);
        return json({ status: "accepted", value: { ...lockedGameHub, selectedGameDayId: "day" } });
      }
      if (method === "POST" && url.endsWith("/locked-correction/preview"))
        return json({ status: "accepted", value: correctionPreview });
      if (method === "POST" && url.endsWith("/locked-correction")) {
        requests.push({
          url,
          body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
            string,
            unknown
          >,
        });
        return json({ status: "accepted" });
      }
      if (method === "POST" && url.endsWith("/reopen/preview"))
        return json({ status: "accepted", value: reopeningPreview });
      if (method === "POST" && url.endsWith("/reopen")) {
        requests.push({
          url,
          body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
            string,
            unknown
          >,
        });
        return json({ status: "accepted" });
      }
      throw new Error(`Unexpected locked-game request: ${method} ${url}`);
    };

    await render(<EventAdminPage />);
    await admitEventAdmin();
    expect((container.querySelector("select#game-day-selector") as HTMLSelectElement).value).toBe(
      "day",
    );
    const gameSelect = container.querySelector("select#locked-game-id") as HTMLSelectElement;
    await act(async () => {
      setSelectValue(gameSelect, "game-identity");
      await flush();
    });
    expect(gameSelect.value).toBe("game-identity");
    await act(async () => {
      setInputValue(
        container.querySelector("input#locked-operation-id") as HTMLInputElement,
        "correct-1",
      );
      await flush();
    });
    expect((container.querySelector("input#locked-operation-id") as HTMLInputElement).value).toBe(
      "correct-1",
    );
    await act(async () => {
      setTextareaValue(
        container.querySelector("textarea#locked-end-state") as HTMLTextAreaElement,
        JSON.stringify({ scoreByGameSide: { "side-a": 31, "side-b": 20 } }),
      );
      await flush();
    });
    expect((container.querySelector("select#game-day-selector") as HTMLSelectElement).value).toBe(
      "day",
    );
    await clickButton("Preview Locked Game Correction");
    await flushAct();
    expect(container.textContent).toContain("Preview ready · correction");
    await clickButton("Confirm Official Override");
    expect(requests[0]).toMatchObject({
      url: "/api/event-admin/events/event/game-days/day/event-games/game-identity/locked-correction",
      body: {
        operationId: "correct-1",
        previewFingerprint: "correction-preview-v1",
        overrideConfirmed: true,
      },
    });

    await act(async () => {
      setInputValue(
        container.querySelector("input#locked-operation-id") as HTMLInputElement,
        "reopen-1",
      );
      await flush();
    });
    await clickButton("Preview Game Reopening");
    expect(container.textContent).toContain("Preview ready · reopen");
    await clickButton("Confirm Game Reopening");
    expect(requests[1]).toMatchObject({
      url: "/api/event-admin/events/event/game-days/day/event-games/game-identity/reopen",
      body: { operationId: "reopen-1", previewFingerprint: "reopening-preview-v1" },
    });
    expect(hubCalls).toBe(4);
  });

  test("Event Admin suppresses stale correction rejection and reopening network failure across Day and authority", async () => {
    const pendingCorrection = deferred<Response>();
    const pendingReopening = deferred<Response>();
    let hubCalls = 0;
    fetchHandler = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.includes("/api/event-admin/hub")) {
        hubCalls += 1;
        if (hubCalls === 1) return json({ status: "rejected" }, 401);
        return json({
          status: "accepted",
          value: { ...lockedGameHub, selectedGameDayId: hubCalls > 1 ? "day-two" : "day" },
        });
      }
      if (url.endsWith("/api/event-admin/admit"))
        return json({ status: "admitted", sessionExpiresAtMs: 123_000 });
      if (method === "POST" && url.endsWith("/locked-correction/preview"))
        return json({
          status: "accepted",
          value: {
            operation: "locked-game-correction",
            fingerprint: "stale-correction",
            impact: {
              facts: "corrected",
              lifecycle: { from: "finished", to: "finished", lock: "retained" },
              timer: "unchanged",
              authority: { controlGrant: "preserved", qr: "preserved", grantVersion: "preserved" },
              sessions: { category: "terminated", count: 0 },
              code: { category: "expired", count: 0 },
              queuedDiscard: { category: "locked-replay", count: 0 },
            },
          },
        });
      if (method === "POST" && url.endsWith("/locked-correction")) return pendingCorrection.promise;
      if (method === "POST" && url.endsWith("/reopen/preview"))
        return json({
          status: "accepted",
          value: {
            operation: "game-reopening",
            fingerprint: "stale-reopening",
            impact: {
              facts: "preserved",
              lifecycle: { from: "finished", to: "finished", lock: "removed" },
              timer: "restarted",
              authority: { controlGrant: "preserved", qr: "preserved", grantVersion: "preserved" },
              sessions: { category: "terminated", count: 0 },
              code: { category: "create-after-reopen", count: 0 },
              queuedDiscard: { category: "locked-replay", count: 0 },
            },
          },
        });
      if (method === "POST" && url.endsWith("/reopen")) return pendingReopening.promise;
      throw new Error(`Unexpected stale locked-game request: ${method} ${url}`);
    };

    await render(<EventAdminPage />);
    await admitEventAdmin();
    const gameSelect = container.querySelector("select#locked-game-id") as HTMLSelectElement;
    await act(async () => {
      setSelectValue(gameSelect, "game-identity");
      await flush();
    });
    await act(async () => {
      setInputValue(
        container.querySelector("input#locked-operation-id") as HTMLInputElement,
        "stale-correction",
      );
      await flush();
    });
    expect((container.querySelector("input#locked-operation-id") as HTMLInputElement).value).toBe(
      "stale-correction",
    );
    await act(async () => {
      setTextareaValue(
        container.querySelector("textarea#locked-end-state") as HTMLTextAreaElement,
        JSON.stringify({ scoreByGameSide: { "side-a": 31 } }),
      );
      await flush();
    });
    await clickButton("Preview Locked Game Correction");
    await flushAct();
    await clickButton("Confirm Locked Game Correction");
    const daySelector = container.querySelector("select#game-day-selector") as HTMLSelectElement;
    await act(async () => {
      setSelectValue(daySelector, "day-two");
      await flush();
    });
    pendingCorrection.resolve(json({ status: "rejected", detail: "stale correction" }, 409));
    await flushAct();
    expect(container.textContent).not.toContain("stale correction");

    await act(async () => {
      setInputValue(
        container.querySelector("input#locked-operation-id") as HTMLInputElement,
        "stale-reopening",
      );
      await flush();
    });
    await clickButton("Preview Game Reopening");
    await flushAct();
    await clickButton("Confirm Game Reopening");
    await clickButton("Change authority");
    pendingReopening.reject(new Error("stale reopening network"));
    await flushAct();
    expect(container.textContent).not.toContain("stale reopening network");
  });

  test("Event Admin fails closed when Hub health is absent or malformed", async () => {
    let hubCalls = 0;
    fetchHandler = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.includes("/api/event-admin/hub")) {
        hubCalls += 1;
        return hubCalls === 1
          ? json({ status: "accepted", value: eventHub })
          : json({
              status: "accepted",
              value: {
                ...eventHub,
                health: {
                  unresolvedTeamCount: "0",
                  scheduleConflictCount: 0,
                  teamScheduleConflictCount: 0,
                  grantProblemCount: 0,
                },
              },
            });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    await render(<EventAdminPage />);
    expect(container.textContent).toContain("Operations health unavailable");
    expect(container.textContent).not.toContain("Unresolved team assignments: 0");
    await typeEventId("event-b");
    await clickButton("Open as Technical Admin");
    expect(container.textContent).toContain("Operations health unavailable");
    expect(container.textContent).not.toContain("Grant problems: 0");
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
    testWindow.close();
    Object.assign(globalThis, {
      window: originalWindow,
      document: originalDocument,
      navigator: originalNavigator,
      fetch: originalFetch,
    });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      originalActEnvironment;
  });

  test("Event Admin keeps accepted Control rotation secrets when refresh fails", async () => {
    let hubRequests = 0;
    let controlLookupCalls = 0;
    fetchHandler = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/event-admin/admit"))
        return json({ status: "admitted", sessionExpiresAtMs: 123_000 });
      if (url.includes("/api/event-admin/hub")) {
        hubRequests += 1;
        return hubRequests === 1
          ? json({ status: "rejected", message: "Authentication failed." }, 401)
          : json({ status: "accepted", value: eventHub });
      }
      if (url.includes("/api/event-admin/pitch-view"))
        return json({ status: "accepted", value: eventPitchView });
      if (url.endsWith("/control-grant") && method === "GET") {
        controlLookupCalls += 1;
        return controlLookupCalls === 1
          ? json({
              status: "accepted",
              value: {
                grantId: "control-grant",
                status: "active",
                eligibility: "eligible",
                eventGameId: "game",
              },
            })
          : json({ status: "retryable-failure" }, 503);
      }
      if (url.endsWith("/control-grant/code"))
        return json({
          status: "accepted",
          value: {
            grantId: "control-grant",
            grantVersion: "v1",
            state: "present",
            formatVersion: 1,
          },
        });
      if (url.endsWith("/control-grant/rotate") && method === "POST")
        return json({
          status: "accepted",
          value: {
            qrCredential: "event-admin-new-qr",
            code: "alpha-bravo-123",
            affectedSessionCount: 2,
          },
        });
      if (url.endsWith("/control-grant/sessions"))
        return json({ status: "retryable-failure" }, 503);
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    await render(<EventAdminPage qrRenderer={async (credential) => `data:${credential}`} />);
    await admitEventAdmin();
    await clickButton("Pitch Main");
    await clickButton("Inspect Control Grant");
    await clickButton("Rotate Grant");

    expect(container.textContent).toContain("Dictate now: alpha-bravo-123");
    expect(container.textContent).toContain("2 session(s) revoked");
    expect(container.querySelector('img[alt="Control Grant QR for Pitch Slot 1"]')).not.toBeNull();
    expect(container.textContent).toContain("state refresh failed");
    expect(container.textContent).not.toContain("event-admin-new-qr");

    await clickButton("Change authority");
    expect(container.querySelector('img[alt="Control Grant QR for Pitch Slot 1"]')).toBeNull();
    expect(container.textContent).not.toContain("Dictate now: alpha-bravo-123");
    await admitEventAdmin();
    expect(container.textContent).not.toContain("Dictate now: alpha-bravo-123");
    expect(container.querySelector('img[alt="Control Grant QR for Pitch Slot 1"]')).toBeNull();
  });

  test("Pitch Manager keeps accepted Control rotation secrets when refresh fails", async () => {
    let currentCalls = 0;
    let controlLookupCalls = 0;
    fetchHandler = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/pitch-manager/current")) {
        currentCalls += 1;
        return currentCalls === 2
          ? json({ status: "rejected", message: "Authentication failed." }, 401)
          : json({ status: "accepted", value: pitchManagerView });
      }
      if (url.endsWith("/api/pitch-manager/admit")) {
        expect(new Headers(init?.headers).has("x-pitch-manager-csrf")).toBe(false);
        return json({ status: "admitted" });
      }
      if (url.endsWith("/api/pitch-manager/leave")) {
        expect(new Headers(init?.headers).get("x-pitch-manager-csrf")).toBe("pitch-manager-proof");
        return json({ status: "left" });
      }
      if (url.endsWith("/control-grant") && method === "GET") {
        controlLookupCalls += 1;
        return controlLookupCalls === 1
          ? json({
              status: "accepted",
              value: {
                grantId: "control-grant",
                status: "active",
                eligibility: "eligible",
                eventGameId: "game",
              },
            })
          : json({ status: "retryable-failure" }, 503);
      }
      if (url.endsWith("/control-grant/code"))
        return json({
          status: "accepted",
          value: {
            grantId: "control-grant",
            grantVersion: "v1",
            state: "present",
            formatVersion: 1,
          },
        });
      if (url.endsWith("/control-grant/rotate") && method === "POST") {
        expect(new Headers(init?.headers).get("x-pitch-manager-csrf")).toBe("pitch-manager-proof");
        return json({
          status: "accepted",
          value: {
            qrCredential: "pitch-manager-new-qr",
            code: "charlie-delta-456",
            affectedSessionCount: 3,
          },
        });
      }
      if (url.endsWith("/control-grant/sessions"))
        return json({ status: "retryable-failure" }, 503);
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    await render(<PitchManagerPage qrRenderer={async (credential) => `data:${credential}`} />);
    await clickButton("Inspect Control Grant");
    await clickButton("Rotate Grant");

    expect(container.textContent).toContain("Dictate now: charlie-delta-456");
    expect(container.textContent).toContain("3 session(s) revoked");
    expect(container.querySelector('img[alt="Control Grant QR for Pitch Slot 1"]')).not.toBeNull();
    expect(container.textContent).toContain("state refresh failed");
    expect(container.textContent).not.toContain("pitch-manager-new-qr");

    await clickButton("Leave");
    expect(container.querySelector('img[alt="Control Grant QR for Pitch Slot 1"]')).toBeNull();
    expect(container.textContent).not.toContain("Dictate now: charlie-delta-456");
    const reAdmissionInput = container.querySelector(
      "input#pitch-manager-grant-code",
    ) as HTMLInputElement;
    await act(async () => {
      setInputValue(reAdmissionInput, "new-manager-code");
      await flush();
    });
    await clickButton("Open Pitch");
    expect(container.textContent).not.toContain("Dictate now: charlie-delta-456");
    expect(container.querySelector('img[alt="Control Grant QR for Pitch Slot 1"]')).toBeNull();
  });

  test("Pitch Manager ignores a pending Control render after Leave", async () => {
    const pendingRender = deferred<string>();
    let currentCalls = 0;
    fetchHandler = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/pitch-manager/current")) {
        currentCalls += 1;
        return currentCalls === 1
          ? json({ status: "accepted", value: pitchManagerView })
          : json({ status: "rejected" }, 401);
      }
      if (url.endsWith("/api/pitch-manager/leave")) return json({ status: "left" });
      if (url.endsWith("/control-grant") && method === "GET")
        return json({
          status: "accepted",
          value: {
            grantId: "control-grant",
            status: "active",
            eligibility: "eligible",
            eventGameId: "game",
          },
        });
      if (url.endsWith("/control-grant/code"))
        return json({
          status: "accepted",
          value: {
            grantId: "control-grant",
            grantVersion: "v1",
            state: "present",
            formatVersion: 1,
          },
        });
      if (url.endsWith("/control-grant/rotate") && method === "POST")
        return json({
          status: "accepted",
          value: {
            qrCredential: "stale-pm-qr",
            code: "stale-pm-code",
            affectedSessionCount: 8,
          },
        });
      if (url.endsWith("/control-grant/sessions")) return json({ status: "accepted", value: [] });
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    await render(<PitchManagerPage qrRenderer={async () => pendingRender.promise} />);
    await clickButton("Inspect Control Grant");
    await clickButton("Rotate Grant");
    await clickButton("Leave");

    pendingRender.resolve("data:stale-pm-qr");
    await flushAct();

    expect(container.textContent).not.toContain("stale-pm-code");
    expect(container.textContent).not.toContain("8 session(s) revoked");
    expect(container.querySelector('img[alt="Control Grant QR for Pitch Slot 1"]')).toBeNull();
  });

  test("Event Admin ignores a pending Control render after authority change", async () => {
    const pendingRender = deferred<string>();
    let hubCalls = 0;
    fetchHandler = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/event-admin/admit"))
        return json({ status: "admitted", sessionExpiresAtMs: 123_000 });
      if (url.includes("/api/event-admin/hub")) {
        hubCalls += 1;
        return hubCalls === 1
          ? json({ status: "rejected", message: "Authentication failed." }, 401)
          : json({ status: "accepted", value: eventHub });
      }
      if (url.includes("/api/event-admin/pitch-view"))
        return json({ status: "accepted", value: eventPitchView });
      if (url.endsWith("/control-grant") && method === "GET")
        return json({
          status: "accepted",
          value: {
            grantId: "control-grant",
            status: "active",
            eligibility: "eligible",
            eventGameId: "game",
          },
        });
      if (url.endsWith("/control-grant/code"))
        return json({
          status: "accepted",
          value: {
            grantId: "control-grant",
            grantVersion: "v1",
            state: "present",
            formatVersion: 1,
          },
        });
      if (url.endsWith("/control-grant/rotate") && method === "POST")
        return json({
          status: "accepted",
          value: {
            qrCredential: "stale-ea-qr",
            code: "stale-ea-code",
            affectedSessionCount: 9,
          },
        });
      if (url.endsWith("/control-grant/sessions")) return json({ status: "accepted", value: [] });
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    await render(<EventAdminPage qrRenderer={async () => pendingRender.promise} />);
    await admitEventAdmin();
    await clickButton("Pitch Main");
    await clickButton("Inspect Control Grant");
    await clickButton("Rotate Grant");
    await clickButton("Change authority");

    pendingRender.resolve("data:stale-ea-qr");
    await flushAct();

    expect(container.textContent).not.toContain("stale-ea-code");
    expect(container.textContent).not.toContain("9 session(s) revoked");
    expect(container.querySelector('img[alt="Control Grant QR for Pitch Slot 1"]')).toBeNull();
  });

  test("Pitch Manager ignores stale session reload after Leave and re-admission", async () => {
    const pendingRevoke = deferred<Response>();
    let currentCalls = 0;
    let sessionCalls = 0;
    fetchHandler = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/pitch-manager/current")) {
        currentCalls += 1;
        return currentCalls === 2
          ? json({ status: "rejected" }, 401)
          : json({ status: "accepted", value: pitchManagerView });
      }
      if (url.endsWith("/api/pitch-manager/admit")) return json({ status: "admitted" });
      if (url.endsWith("/api/pitch-manager/leave")) return json({ status: "left" });
      if (url.endsWith("/control-grant") && method === "GET")
        return json({
          status: "accepted",
          value: {
            grantId: "control-grant",
            status: "active",
            eligibility: "eligible",
            eventGameId: "game",
          },
        });
      if (url.endsWith("/control-grant/code"))
        return json({
          status: "accepted",
          value: {
            grantId: "control-grant",
            grantVersion: "v1",
            state: "present",
            formatVersion: 1,
          },
        });
      if (url.endsWith("/control-grant/sessions") && method === "GET")
        return json({
          status: "accepted",
          value:
            sessionCalls++ === 0
              ? [
                  {
                    label: "initial-session",
                    createdAtMs: 1,
                    lastActiveAtMs: 2,
                    deviceClass: "x",
                    browserClass: "y",
                  },
                ]
              : [
                  {
                    label: "stale-session",
                    createdAtMs: 1,
                    lastActiveAtMs: 2,
                    deviceClass: "x",
                    browserClass: "y",
                  },
                ],
        });
      if (url.endsWith("/control-grant/sessions/revoke") && method === "POST")
        return pendingRevoke.promise;
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    await render(<PitchManagerPage qrRenderer={async (credential) => `data:${credential}`} />);
    await clickButton("Inspect Control Grant");
    await clickButton("Sessions");
    await clickButton("Revoke");
    await clickButton("Leave");
    const reAdmissionInput = container.querySelector(
      "input#pitch-manager-grant-code",
    ) as HTMLInputElement;
    await act(async () => {
      setInputValue(reAdmissionInput, "new-manager-code");
      await flush();
    });
    await clickButton("Open Pitch");

    pendingRevoke.resolve(json({ status: "accepted" }));
    await flushAct();

    expect(container.textContent).not.toContain("stale-session");
    expect(container.textContent).not.toContain("Control session revocation failed.");
  });

  test("Event Admin ignores stale session reload after authority change and re-admission", async () => {
    const pendingRevoke = deferred<Response>();
    let hubCalls = 0;
    let sessionCalls = 0;
    fetchHandler = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/event-admin/admit"))
        return json({ status: "admitted", sessionExpiresAtMs: 123_000 });
      if (url.includes("/api/event-admin/hub")) {
        hubCalls += 1;
        return hubCalls === 1
          ? json({ status: "rejected", message: "Authentication failed." }, 401)
          : json({ status: "accepted", value: eventHub });
      }
      if (url.includes("/api/event-admin/pitch-view"))
        return json({ status: "accepted", value: eventPitchView });
      if (url.endsWith("/control-grant") && method === "GET")
        return json({
          status: "accepted",
          value: {
            grantId: "control-grant",
            status: "active",
            eligibility: "eligible",
            eventGameId: "game",
          },
        });
      if (url.endsWith("/control-grant/code"))
        return json({
          status: "accepted",
          value: {
            grantId: "control-grant",
            grantVersion: "v1",
            state: "present",
            formatVersion: 1,
          },
        });
      if (url.endsWith("/control-grant/sessions") && method === "GET")
        return json({
          status: "accepted",
          value:
            sessionCalls++ === 0
              ? [{ label: "initial-event-session", deviceClass: "x", browserClass: "y" }]
              : [{ label: "stale-event-session", deviceClass: "x", browserClass: "y" }],
        });
      if (url.endsWith("/control-grant/sessions/revoke") && method === "POST")
        return pendingRevoke.promise;
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    await render(<EventAdminPage qrRenderer={async (credential) => `data:${credential}`} />);
    await admitEventAdmin();
    await clickButton("Pitch Main");
    await clickButton("Inspect Control Grant");
    await clickButton("Sessions");
    await clickButton("Revoke");
    await clickButton("Change authority");
    pendingRevoke.resolve(json({ status: "accepted" }));
    await flushAct();
    await admitEventAdmin();
    await clickButton("Pitch Main");

    expect(container.textContent).not.toContain("stale-event-session");
    expect(container.textContent).not.toContain("Control session revocation failed.");
  });

  test("Event Admin ignores stale Hub success after day transition and authority change", async () => {
    const pendingHub = deferred<Response>();
    let hubCalls = 0;
    fetchHandler = async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/event-admin/hub")) {
        hubCalls += 1;
        return hubCalls === 1
          ? json({ status: "accepted", value: twoDayEventHub })
          : pendingHub.promise;
      }
      throw new Error(`Unexpected Hub request: ${url}`);
    };

    await render(<EventAdminPage />);
    const gameDaySelector = container.querySelector(
      "select#game-day-selector",
    ) as HTMLSelectElement;
    await act(async () => {
      setSelectValue(gameDaySelector, "day-two");
      await flush();
    });
    await clickButton("Change authority");

    pendingHub.resolve(json({ status: "accepted", value: twoDayEventHub }));
    await flushAct();

    expect(container.querySelector("input#event-admin-credential")).not.toBeNull();
    expect(container.textContent).not.toContain("day-two");
  });

  test("Event Admin ignores stale Hub rejection after day transition and authority change", async () => {
    const pendingHub = deferred<Response>();
    let hubCalls = 0;
    fetchHandler = async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/event-admin/hub")) {
        hubCalls += 1;
        return hubCalls === 1
          ? json({ status: "accepted", value: twoDayEventHub })
          : pendingHub.promise;
      }
      throw new Error(`Unexpected Hub request: ${url}`);
    };

    await render(<EventAdminPage />);
    const gameDaySelector = container.querySelector(
      "select#game-day-selector",
    ) as HTMLSelectElement;
    await act(async () => {
      setSelectValue(gameDaySelector, "day-two");
      await flush();
    });
    await clickButton("Change authority");

    pendingHub.resolve(json({ status: "retryable-failure" }, 503));
    await flushAct();

    expect(container.querySelector("input#event-admin-credential")).not.toBeNull();
    expect(container.textContent).not.toContain("Unable to open the Event Hub.");
  });

  test("Event Admin ignores stale Event A Hub success after typing Event B", async () => {
    const pendingHub = deferred<Response>();
    let hubCalls = 0;
    let lastHubUrl = "";
    fetchHandler = async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.includes("/api/event-admin/hub")) throw new Error(`Unexpected request: ${url}`);
      lastHubUrl = url;
      hubCalls += 1;
      if (hubCalls === 1) return pendingHub.promise;
      return json({ status: "accepted", value: eventBHub });
    };

    await render(<EventAdminPage />);
    await typeEventId("event-b");
    pendingHub.resolve(json({ status: "accepted", value: eventHub }));
    await flushAct();

    expect(container.querySelector("input#event-admin-credential")).not.toBeNull();
    expect((container.querySelector("input#event-id") as HTMLInputElement).value).toBe("event-b");
    await clickButton("Open as Technical Admin");
    expect(lastHubUrl).toContain("eventId=event-b");
    expect(container.textContent).toContain("Event BUTC");
  });

  test("Event Admin ignores stale Event A Hub failure after typing Event B", async () => {
    const pendingHub = deferred<Response>();
    let hubCalls = 0;
    let lastHubUrl = "";
    fetchHandler = async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.includes("/api/event-admin/hub")) throw new Error(`Unexpected request: ${url}`);
      lastHubUrl = url;
      hubCalls += 1;
      if (hubCalls === 1) return pendingHub.promise;
      return json({ status: "accepted", value: eventBHub });
    };

    await render(<EventAdminPage />);
    await typeEventId("event-b");
    pendingHub.resolve(json({ status: "retryable-failure" }, 503));
    await flushAct();

    expect(container.querySelector("input#event-admin-credential")).not.toBeNull();
    expect(container.textContent).not.toContain("Unable to open the Event Hub.");
    await clickButton("Open as Technical Admin");
    expect(lastHubUrl).toContain("eventId=event-b");
    expect(container.textContent).toContain("Event BUTC");
  });

  test("Event Admin keeps Event A admission completion from opening Hub after typing Event B", async () => {
    const pendingAdmission = deferred<Response>();
    let hubCalls = 0;
    let lastHubUrl = "";
    fetchHandler = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/event-admin/admit") && method === "POST")
        return pendingAdmission.promise;
      if (url.includes("/api/event-admin/hub")) {
        lastHubUrl = url;
        hubCalls += 1;
        if (hubCalls === 1) return json({ status: "retryable-failure" }, 503);
        return json({ status: "accepted", value: eventBHub });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    await render(<EventAdminPage />);
    await admitEventAdmin();
    await typeEventId("event-b");
    pendingAdmission.resolve(json({ status: "admitted", sessionExpiresAtMs: 123_000 }));
    await flushAct();

    expect(container.querySelector("input#event-admin-credential")).not.toBeNull();
    expect(container.textContent).not.toContain("Admission failed.");
    await clickButton("Open as Technical Admin");
    expect(lastHubUrl).toContain("eventId=event-b");
    expect(container.textContent).toContain("Event BUTC");
  });

  test("Event Admin ignores stale non-accepted Event A admission after typing Event B", async () => {
    const pendingAdmission = deferred<Response>();
    let hubCalls = 0;
    let lastHubUrl = "";
    fetchHandler = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/event-admin/admit") && method === "POST")
        return pendingAdmission.promise;
      if (url.includes("/api/event-admin/hub")) {
        lastHubUrl = url;
        hubCalls += 1;
        if (hubCalls === 1) return json({ status: "retryable-failure" }, 503);
        return json({ status: "accepted", value: eventBHub });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    await render(<EventAdminPage />);
    await admitEventAdmin();
    await typeEventId("event-b");
    pendingAdmission.resolve(json({ status: "retryable-failure" }, 401));
    await flushAct();

    expect(container.querySelector("input#event-admin-credential")).not.toBeNull();
    expect(container.textContent).not.toContain("Admission failed.");
    await clickButton("Open as Technical Admin");
    expect(lastHubUrl).toContain("eventId=event-b");
    expect(container.textContent).toContain("Event BUTC");
  });

  test("Event Admin ignores a stale Event A admission network failure after typing Event B", async () => {
    const pendingAdmission = deferred<Response>();
    let hubCalls = 0;
    let lastHubUrl = "";
    fetchHandler = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/event-admin/admit") && method === "POST")
        return pendingAdmission.promise;
      if (url.includes("/api/event-admin/hub")) {
        lastHubUrl = url;
        hubCalls += 1;
        if (hubCalls === 1) return json({ status: "retryable-failure" }, 503);
        return json({ status: "accepted", value: eventBHub });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    await render(<EventAdminPage />);
    await admitEventAdmin();
    await typeEventId("event-b");
    pendingAdmission.reject(new Error("stale admission network failure"));
    await flushAct();

    expect(container.querySelector("input#event-admin-credential")).not.toBeNull();
    expect(container.textContent).not.toContain("Admission failed.");
    await clickButton("Open as Technical Admin");
    expect(lastHubUrl).toContain("eventId=event-b");
    expect(container.textContent).toContain("Event BUTC");
  });

  test("Event Admin invalidates old Event Control QR rendering after typing Event B", async () => {
    const pendingRender = deferred<string>();
    fetchHandler = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.includes("/api/event-admin/hub"))
        return json({ status: "accepted", value: eventHub });
      if (url.includes("/api/event-admin/pitch-view"))
        return json({ status: "accepted", value: eventPitchView });
      if (url.endsWith("/control-grant") && method === "GET")
        return json({
          status: "accepted",
          value: {
            grantId: "control-grant",
            status: "active",
            eligibility: "eligible",
            eventGameId: "game",
          },
        });
      if (url.endsWith("/control-grant/code") && method === "GET")
        return json({
          status: "accepted",
          value: {
            grantId: "control-grant",
            grantVersion: "v1",
            state: "present",
            formatVersion: 1,
          },
        });
      if (url.endsWith("/control-grant/reveal") && method === "POST")
        return json({ status: "accepted", value: { qrCredential: "stale-event-a-qr" } });
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    await render(<EventAdminPage qrRenderer={async () => pendingRender.promise} />);
    await clickButton("Pitch Main");
    await clickButton("Inspect Control Grant");
    await clickButton("Reveal QR");
    await typeEventId("event-b");
    pendingRender.resolve("data:stale-event-a-qr");
    await flushAct();

    expect(container.querySelector("input#event-admin-credential")).not.toBeNull();
    expect(container.querySelector('img[alt="Control Grant QR for Pitch Slot 1"]')).toBeNull();
    expect(container.textContent).not.toContain("QR reveal failed");
  });

  test("Event Admin invalidates old Event Control code follow-up after typing Event B", async () => {
    const pendingCodeProjection = deferred<Response>();
    let codeReads = 0;
    fetchHandler = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.includes("/api/event-admin/hub"))
        return json({ status: "accepted", value: eventHub });
      if (url.includes("/api/event-admin/pitch-view"))
        return json({ status: "accepted", value: eventPitchView });
      if (url.endsWith("/control-grant") && method === "GET")
        return json({
          status: "accepted",
          value: {
            grantId: "control-grant",
            status: "active",
            eligibility: "eligible",
            eventGameId: "game",
          },
        });
      if (url.endsWith("/control-grant/code") && method === "GET") {
        codeReads += 1;
        if (codeReads === 1)
          return json({
            status: "accepted",
            value: {
              grantId: "control-grant",
              grantVersion: "v1",
              state: "present",
              formatVersion: 1,
            },
          });
        return pendingCodeProjection.promise;
      }
      if (url.endsWith("/control-grant/code") && method === "POST")
        return json({ status: "accepted", value: { code: "stale-event-a-code" } });
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    await render(<EventAdminPage />);
    await clickButton("Pitch Main");
    await clickButton("Inspect Control Grant");
    await clickButton("Create Radio Code");
    await typeEventId("event-b");
    pendingCodeProjection.resolve(
      json({
        status: "accepted",
        value: { grantId: "control-grant", grantVersion: "v1", state: "present", formatVersion: 1 },
      }),
    );
    await flushAct();

    expect(container.querySelector("input#event-admin-credential")).not.toBeNull();
    expect(container.textContent).not.toContain("Dictate now: stale-event-a-code");
  });

  test("Event Admin invalidates old Event Control session follow-up after typing Event B", async () => {
    const pendingSessions = deferred<Response>();
    let sessionReads = 0;
    fetchHandler = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.includes("/api/event-admin/hub"))
        return json({ status: "accepted", value: eventHub });
      if (url.includes("/api/event-admin/pitch-view"))
        return json({ status: "accepted", value: eventPitchView });
      if (url.endsWith("/control-grant") && method === "GET")
        return json({
          status: "accepted",
          value: {
            grantId: "control-grant",
            status: "active",
            eligibility: "eligible",
            eventGameId: "game",
          },
        });
      if (url.endsWith("/control-grant/code") && method === "GET")
        return json({
          status: "accepted",
          value: {
            grantId: "control-grant",
            grantVersion: "v1",
            state: "present",
            formatVersion: 1,
          },
        });
      if (url.endsWith("/control-grant/sessions") && method === "GET") {
        sessionReads += 1;
        if (sessionReads === 1)
          return json({
            status: "accepted",
            value: [{ label: "initial-event-session", deviceClass: "x", browserClass: "y" }],
          });
        return pendingSessions.promise;
      }
      if (url.endsWith("/control-grant/sessions/revoke") && method === "POST")
        return json({ status: "accepted" });
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    await render(<EventAdminPage />);
    await clickButton("Pitch Main");
    await clickButton("Inspect Control Grant");
    await clickButton("Sessions");
    await clickButton("Revoke");
    await typeEventId("event-b");
    pendingSessions.resolve(
      json({
        status: "accepted",
        value: [{ label: "stale-event-a-session", deviceClass: "x", browserClass: "y" }],
      }),
    );
    await flushAct();

    expect(container.querySelector("input#event-admin-credential")).not.toBeNull();
    expect(container.textContent).not.toContain("stale-event-a-session");
  });

  test("Event Admin ignores stale Event A Slot setup after typing Event B", async () => {
    const pendingSchedule = deferred<Response>();
    let lastHubUrl = "";
    fetchHandler = async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/event-admin/hub")) {
        lastHubUrl = url;
        return url.includes("eventId=event-b")
          ? json({ status: "accepted", value: eventBHub })
          : json({ status: "accepted", value: eventHub });
      }
      if (url.includes("/api/event-admin/slot-setup")) return pendingSchedule.promise;
      throw new Error(`Unexpected request: ${url}`);
    };

    await render(<EventAdminPage />);
    await clickButton("Refresh Slot setup");
    await typeEventId("event-b");
    pendingSchedule.resolve(
      json({
        status: "accepted",
        value: {
          gameDayId: "day",
          gameplaySlots: [
            { ...eventHub.event.gameplaySlots[0], gameplaySlotId: "stale-gameplay", sequence: 77 },
          ],
          pitchSlots: [{ ...eventHub.event.pitchSlots[0], pitchSlotId: "stale-slot" }],
          eventGames: [],
        },
      }),
    );
    await flushAct();

    expect(container.querySelector("input#event-admin-credential")).not.toBeNull();
    expect(container.textContent).not.toContain("Slot setup failed");
    await clickButton("Open as Technical Admin");
    expect(lastHubUrl).toContain("eventId=event-b");
    expect(container.textContent).not.toContain("Slot 77");
  });

  test("Event Admin ignores stale Event A Slot setup failure after typing Event B", async () => {
    const pendingSchedule = deferred<Response>();
    let lastHubUrl = "";
    fetchHandler = async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/event-admin/hub")) {
        lastHubUrl = url;
        return url.includes("eventId=event-b")
          ? json({ status: "accepted", value: eventBHub })
          : json({ status: "accepted", value: eventHub });
      }
      if (url.includes("/api/event-admin/slot-setup")) return pendingSchedule.promise;
      throw new Error(`Unexpected request: ${url}`);
    };

    await render(<EventAdminPage />);
    await clickButton("Refresh Slot setup");
    await typeEventId("event-b");
    pendingSchedule.resolve(json({ status: "retryable-failure" }, 503));
    await flushAct();

    expect(container.querySelector("input#event-admin-credential")).not.toBeNull();
    expect(container.textContent).not.toContain("Unable to load Slot setup.");
    await clickButton("Open as Technical Admin");
    expect(lastHubUrl).toContain("eventId=event-b");
    expect(container.textContent).not.toContain("Unable to load Slot setup.");
  });

  test("Event Admin ignores stale Event A Pitch view after typing Event B", async () => {
    const pendingPitchView = deferred<Response>();
    let lastHubUrl = "";
    fetchHandler = async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/event-admin/hub")) {
        lastHubUrl = url;
        return url.includes("eventId=event-b")
          ? json({ status: "accepted", value: eventBHub })
          : json({ status: "accepted", value: eventHub });
      }
      if (url.includes("/api/event-admin/pitch-view")) return pendingPitchView.promise;
      throw new Error(`Unexpected request: ${url}`);
    };

    await render(<EventAdminPage />);
    await clickButton("Pitch Main");
    await typeEventId("event-b");
    pendingPitchView.resolve(
      json({
        status: "accepted",
        value: {
          pitch: { pitchId: "stale-pitch", name: "Stale Pitch" },
          gameplaySlots: [
            { ...eventHub.event.gameplaySlots[0], gameplaySlotId: "stale-gameplay", sequence: 77 },
          ],
          pitchSlots: [
            { ...eventHub.event.pitchSlots[0], pitchSlotId: "stale-slot", sequence: 77 },
          ],
          eventGames: [],
        },
      }),
    );
    await flushAct();

    expect(container.querySelector("input#event-admin-credential")).not.toBeNull();
    expect(container.textContent).not.toContain("Unable to load Pitch view.");
    await clickButton("Open as Technical Admin");
    expect(lastHubUrl).toContain("eventId=event-b");
    expect(container.textContent).not.toContain("Slot 77");
  });

  test("Event Admin ignores stale Event A Pitch view failure after typing Event B", async () => {
    const pendingPitchView = deferred<Response>();
    let lastHubUrl = "";
    fetchHandler = async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/event-admin/hub")) {
        lastHubUrl = url;
        return url.includes("eventId=event-b")
          ? json({ status: "accepted", value: eventBHub })
          : json({ status: "accepted", value: eventHub });
      }
      if (url.includes("/api/event-admin/pitch-view")) return pendingPitchView.promise;
      throw new Error(`Unexpected request: ${url}`);
    };

    await render(<EventAdminPage />);
    await clickButton("Pitch Main");
    await typeEventId("event-b");
    pendingPitchView.resolve(json({ status: "retryable-failure" }, 503));
    await flushAct();

    expect(container.querySelector("input#event-admin-credential")).not.toBeNull();
    expect(container.textContent).not.toContain("Unable to load Pitch view.");
    await clickButton("Open as Technical Admin");
    expect(lastHubUrl).toContain("eventId=event-b");
    expect(container.textContent).not.toContain("Unable to load Pitch view.");
  });

  test("Pitch Manager keeps an accepted Control code Create value through refresh", async () => {
    let codeState: "present" | "disabled" = "present";
    fetchHandler = pitchManagerCodeHandler("create", "golf-hotel-123", () => codeState);

    await render(<PitchManagerPage qrRenderer={async (credential) => `data:${credential}`} />);
    await clickButton("Inspect Control Grant");
    await clickButton("Create Radio Code");

    expect(container.textContent).toContain("Dictate now: golf-hotel-123");
    await clickButton("Disable Code");
    codeState = "disabled";
    expect(container.textContent).not.toContain("Dictate now: golf-hotel-123");
  });

  test("Pitch Manager keeps an accepted Control code Replace value through refresh", async () => {
    let codeState: "present" | "disabled" = "present";
    fetchHandler = pitchManagerCodeHandler("replace", "india-juliet-456", () => codeState);

    await render(<PitchManagerPage qrRenderer={async (credential) => `data:${credential}`} />);
    await clickButton("Inspect Control Grant");
    await clickButton("Replace Code");

    expect(container.textContent).toContain("Dictate now: india-juliet-456");
    await clickButton("Disable Code");
    codeState = "disabled";
    expect(container.textContent).not.toContain("Dictate now: india-juliet-456");
  });

  test("Pitch Manager ignores stale Create success after Leave and re-admission", async () => {
    const pending = await beginPendingPitchManagerCode("create", "disabled");
    pending.resolve(json({ status: "accepted", value: { code: "stale-create-after-readmit" } }));
    await flushAct();

    expect(container.textContent).not.toContain("stale-create-after-readmit");
    expect(container.textContent).not.toContain("Grant Code operation failed.");
    expect(container.textContent).toContain("Radio code: present");
    expect(container.textContent).not.toContain("Radio code: disabled");
  });

  test("Pitch Manager ignores stale Replace success after Leave and re-admission", async () => {
    const pending = await beginPendingPitchManagerCode("replace", "disabled");
    pending.resolve(json({ status: "accepted", value: { code: "stale-replace-after-readmit" } }));
    await flushAct();

    expect(container.textContent).not.toContain("stale-replace-after-readmit");
    expect(container.textContent).not.toContain("Grant Code operation failed.");
    expect(container.textContent).toContain("Radio code: present");
    expect(container.textContent).not.toContain("Radio code: disabled");
  });

  test("Pitch Manager ignores stale Create rejection after Leave and re-admission", async () => {
    const pending = await beginPendingPitchManagerCode("create", "present");
    pending.resolve(json({ status: "retryable-failure" }, 503));
    await flushAct();

    expect(container.textContent).not.toContain("Grant Code operation failed.");
    expect(container.textContent).toContain("Radio code: present");
  });

  test("Pitch Manager ignores stale Replace rejection after Leave and re-admission", async () => {
    const pending = await beginPendingPitchManagerCode("replace", "present");
    pending.resolve(json({ status: "retryable-failure" }, 503));
    await flushAct();

    expect(container.textContent).not.toContain("Grant Code operation failed.");
    expect(container.textContent).toContain("Radio code: present");
  });

  test("Technical Admin keeps accepted full-rotation secrets through QR render retry and logout", async () => {
    let renderAttempts = 0;
    const technicalAdminEvent = {
      eventId: "event",
      name: "Event",
      timeZone: "UTC",
      lifecycle: "current",
      gameDays: [],
    };
    fetchHandler = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/admin/session"))
        return json({ authenticated: true, environment: "test", activeSessionCount: 1 });
      if (url.endsWith("/api/admin/events") && method === "GET")
        return json({ status: "accepted", value: [technicalAdminEvent] });
      if (url.endsWith("/api/admin/events/event") && method === "GET")
        return json({ status: "accepted", value: technicalAdminEvent });
      if (url.endsWith("/event-admin-grant") && method === "GET")
        return json({
          status: "accepted",
          value: {
            grantId: "event-admin-grant",
            grantVersion: "v1",
            eventId: "event",
            status: "active",
            expiresAtMs: null,
          },
        });
      if (url.endsWith("/event-admin-grant/code") && method === "GET")
        return json({
          status: "accepted",
          value: {
            grantId: "event-admin-grant",
            grantVersion: "v1",
            state: "present",
            formatVersion: 1,
          },
        });
      if (url.endsWith("/event-admin-grant/rotate") && method === "POST")
        return json({
          status: "accepted",
          value: {
            qrCredential: "technical-admin-new-qr",
            code: "kilo-lima-789",
            affectedSessionCount: 4,
          },
        });
      if (url.endsWith("/api/admin/logout") && method === "POST")
        return json({ status: "accepted" });
      throw new Error(`Unexpected Technical Admin request: ${method} ${url}`);
    };

    await render(
      <TechnicalAdminPage
        enrollment={false}
        qrRenderer={async (credential) => {
          renderAttempts += 1;
          if (renderAttempts === 1) throw new Error("local encoder failed");
          return `data:${credential}`;
        }}
      />,
    );
    await clickButtonContaining("EventUTC · current");
    await clickButton("Rotate Grant");

    expect(container.textContent).toContain("Dictate now: kilo-lima-789");
    expect(container.textContent).toContain("Full rotation affected 4 session(s).");
    expect(container.textContent).toContain("QR render failed");
    expect(container.textContent).not.toContain("technical-admin-new-qr");
    expect(container.querySelector('img[alt="Event Admin Grant QR code"]')).toBeNull();

    await clickButton("Retry QR render");
    expect(renderAttempts).toBe(2);
    expect(container.querySelector('img[alt="Event Admin Grant QR code"]')).not.toBeNull();
    expect(container.textContent).toContain("Dictate now: kilo-lima-789");
    expect(container.textContent).not.toContain("QR render failed");

    await clickButton("Sign out");
    expect(container.textContent).not.toContain("Dictate now: kilo-lima-789");
    expect(container.textContent).not.toContain("Full rotation affected 4 session(s).");
    expect(container.querySelector('img[alt="Event Admin Grant QR code"]')).toBeNull();
  });

  test("Technical Admin ignores a stale Event A rotation after switching to Event B", async () => {
    const pendingRender = deferred<string>();
    const eventA = {
      eventId: "event-a",
      name: "Event A",
      timeZone: "UTC",
      lifecycle: "current",
      gameDays: [],
    };
    const eventB = {
      eventId: "event-b",
      name: "Event B",
      timeZone: "UTC",
      lifecycle: "current",
      gameDays: [],
    };
    let eventACodeReads = 0;
    fetchHandler = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/admin/session"))
        return json({ authenticated: true, environment: "test", activeSessionCount: 1 });
      if (url.endsWith("/api/admin/events") && method === "GET")
        return json({ status: "accepted", value: [eventA, eventB] });
      const event = url.includes("/events/event-a") ? eventA : eventB;
      if (url.endsWith(`/${event.eventId}`) && method === "GET")
        return json({ status: "accepted", value: event });
      if (url.endsWith("/event-admin-grant") && method === "GET")
        return json({
          status: "accepted",
          value: {
            grantId: `${event.eventId}-grant`,
            grantVersion: "v1",
            eventId: event.eventId,
            status: "active",
            expiresAtMs: null,
          },
        });
      if (url.endsWith("/event-admin-grant/code") && method === "GET") {
        if (event.eventId === "event-a") eventACodeReads += 1;
        return json({
          status: "accepted",
          value: {
            grantId: `${event.eventId}-grant`,
            grantVersion: "v1",
            state: event.eventId === "event-a" && eventACodeReads > 1 ? "disabled" : "present",
            formatVersion: 1,
          },
        });
      }
      if (url.endsWith("/event-admin-grant/rotate") && method === "POST")
        return json({
          status: "accepted",
          value: {
            qrCredential: "event-a-qr",
            code: "event-a-code",
            affectedSessionCount: 11,
          },
        });
      throw new Error(`Unexpected Technical Admin request: ${method} ${url}`);
    };

    await render(
      <TechnicalAdminPage enrollment={false} qrRenderer={async () => pendingRender.promise} />,
    );
    await clickButtonContaining("Event AUTC · current");
    await clickButton("Rotate Grant");
    await clickButtonContaining("Event BUTC · current");

    pendingRender.resolve("data:event-a-qr");
    await flushAct();

    expect(container.textContent).not.toContain("event-a-code");
    expect(container.textContent).not.toContain("11 session(s)");
    expect(container.textContent).not.toContain("QR render failed");
    expect(container.querySelector('img[alt="Event Admin Grant QR code"]')).toBeNull();
    expect(container.textContent).toContain("Code state: present");
    const replaceButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Replace Code",
    ) as HTMLButtonElement | undefined;
    expect(replaceButton?.disabled).toBe(false);
    expect(eventACodeReads).toBe(1);
  });

  test("Technical Admin ignores a stale Event A render failure after switching to Event B", async () => {
    const pendingRender = deferred<string>();
    const eventA = {
      eventId: "event-a",
      name: "Event A",
      timeZone: "UTC",
      lifecycle: "current",
      gameDays: [],
    };
    const eventB = {
      eventId: "event-b",
      name: "Event B",
      timeZone: "UTC",
      lifecycle: "current",
      gameDays: [],
    };
    fetchHandler = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/admin/session"))
        return json({ authenticated: true, environment: "test", activeSessionCount: 1 });
      if (url.endsWith("/api/admin/events") && method === "GET")
        return json({ status: "accepted", value: [eventA, eventB] });
      const event = url.includes("/events/event-a") ? eventA : eventB;
      if (url.endsWith(`/${event.eventId}`) && method === "GET")
        return json({ status: "accepted", value: event });
      if (url.endsWith("/event-admin-grant") && method === "GET")
        return json({
          status: "accepted",
          value: {
            grantId: `${event.eventId}-grant`,
            grantVersion: "v1",
            eventId: event.eventId,
            status: "active",
            expiresAtMs: null,
          },
        });
      if (url.endsWith("/event-admin-grant/code") && method === "GET")
        return json({
          status: "accepted",
          value: {
            grantId: `${event.eventId}-grant`,
            grantVersion: "v1",
            state: "present",
            formatVersion: 1,
          },
        });
      if (url.endsWith("/event-admin-grant/rotate") && method === "POST")
        return json({
          status: "accepted",
          value: {
            qrCredential: "event-a-qr-failure",
            code: "event-a-code-failure",
            affectedSessionCount: 12,
          },
        });
      throw new Error(`Unexpected Technical Admin request: ${method} ${url}`);
    };

    await render(
      <TechnicalAdminPage enrollment={false} qrRenderer={async () => pendingRender.promise} />,
    );
    await clickButtonContaining("Event AUTC · current");
    await clickButton("Rotate Grant");
    await clickButtonContaining("Event BUTC · current");

    pendingRender.reject(new Error("stale render failure"));
    await flushAct();

    expect(container.textContent).not.toContain("event-a-code-failure");
    expect(container.textContent).not.toContain("12 session(s)");
    expect(container.textContent).not.toContain("QR render failed");
    expect(container.querySelector('img[alt="Event Admin Grant QR code"]')).toBeNull();
  });

  test("Technical Admin ignores stale Event A rotation rejection after switching to Event B", async () => {
    const pendingRotation = await beginPendingTechnicalRotation();
    pendingRotation.resolve(json({ status: "retryable-failure" }, 503));
    await flushAct();

    expect(container.textContent).toContain("Event Bevent-b · UTC");
    expect(container.textContent).not.toContain("Event catalog operation failed.");
    expect(container.textContent).not.toContain("Authentication failed.");
  });

  test("Technical Admin ignores stale Event A rotation network error after switching to Event B", async () => {
    const pendingRotation = await beginPendingTechnicalRotation();
    pendingRotation.reject(new Error("stale rotation network failure"));
    await flushAct();

    expect(container.textContent).toContain("Event Bevent-b · UTC");
    expect(container.textContent).not.toContain("Event catalog operation failed.");
    expect(container.textContent).not.toContain("Authentication failed.");
  });

  test("retains the accepted code and credential for a local QR render retry", async () => {
    let renderAttempts = 0;
    fetchHandler = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/pitch-manager/current"))
        return json({ status: "accepted", value: pitchManagerView });
      if (url.endsWith("/control-grant") && method === "GET")
        return json({
          status: "accepted",
          value: {
            grantId: "control-grant",
            status: "active",
            eligibility: "eligible",
            eventGameId: "game",
          },
        });
      if (url.endsWith("/control-grant/code"))
        return json({
          status: "accepted",
          value: {
            grantId: "control-grant",
            grantVersion: "v1",
            state: "present",
            formatVersion: 1,
          },
        });
      if (url.endsWith("/control-grant/rotate") && method === "POST")
        return json({
          status: "accepted",
          value: {
            qrCredential: "retryable-qr",
            code: "echo-foxtrot-789",
            affectedSessionCount: 1,
          },
        });
      if (url.endsWith("/control-grant/sessions")) return json({ status: "accepted", value: [] });
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    await render(
      <PitchManagerPage
        qrRenderer={async (credential) => {
          renderAttempts += 1;
          if (renderAttempts === 1) throw new Error("local encoder failed");
          return `data:${credential}`;
        }}
      />,
    );
    await clickButton("Inspect Control Grant");
    await clickButton("Rotate Grant");

    expect(container.textContent).toContain("Dictate now: echo-foxtrot-789");
    expect(container.textContent).toContain("QR render failed");
    expect(container.querySelector('img[alt="Control Grant QR for Pitch Slot 1"]')).toBeNull();
    await clickButton("Retry QR render");
    expect(container.querySelector('img[alt="Control Grant QR for Pitch Slot 1"]')).not.toBeNull();
    expect(renderAttempts).toBe(2);
  });

  async function render(element: ReactElement) {
    await act(async () => {
      root.render(element);
      await flush();
    });
  }

  async function admitEventAdmin() {
    const input = container.querySelector("input#event-admin-credential") as HTMLInputElement;
    await act(async () => {
      setInputValue(input, "event-admin-qr");
      await flush();
    });
    await clickButton("Admit Event Admin");
  }

  async function typeEventId(value: string) {
    const input = container.querySelector("input#event-id") as HTMLInputElement;
    await act(async () => {
      setInputValue(input, value);
      await flush();
    });
  }

  async function clickButton(label: string) {
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === label && !candidate.disabled,
    );
    if (button === undefined)
      throw new Error(
        `Missing enabled button: ${label}; text=${container.textContent}; inputs=${Array.from(
          container.querySelectorAll("input"),
        )
          .map((input) => `${input.id}=${input.value}`)
          .join(",")}`,
      );
    await act(async () => {
      button.click();
      await flush();
    });
  }

  async function clickButtonContaining(label: string) {
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.includes(label) && !candidate.disabled,
    );
    if (button === undefined) throw new Error(`Missing enabled button containing: ${label}`);
    await act(async () => {
      button.click();
      await flush();
    });
  }

  function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      testWindow.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as unknown as Event);
    input.dispatchEvent(new testWindow.Event("change", { bubbles: true }) as unknown as Event);
  }

  function setSelectValue(select: HTMLSelectElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      testWindow.HTMLSelectElement.prototype,
      "value",
    )?.set;
    setter?.call(select, value);
    select.dispatchEvent(new testWindow.Event("change", { bubbles: true }) as unknown as Event);
  }

  function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      testWindow.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as unknown as Event);
    textarea.dispatchEvent(new testWindow.Event("change", { bubbles: true }) as unknown as Event);
  }

  function pitchManagerCodeHandler(
    operation: "create" | "replace",
    code: string,
    readCodeState: () => "present" | "disabled",
  ) {
    return async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/pitch-manager/current"))
        return json({ status: "accepted", value: pitchManagerView });
      if (url.endsWith("/control-grant") && method === "GET")
        return json({
          status: "accepted",
          value: {
            grantId: "control-grant",
            status: "active",
            eligibility: "eligible",
            eventGameId: "game",
          },
        });
      if (url.endsWith("/control-grant/code/disable") && method === "POST")
        return json({ status: "accepted", value: { status: "updated" } });
      if (url.endsWith(`/control-grant/code/${operation}`) && method === "POST")
        return json({ status: "accepted", value: { code } });
      if (url.endsWith("/control-grant/code") && method === "POST")
        return json({ status: "accepted", value: { code } });
      if (url.endsWith("/control-grant/code") && method === "GET")
        return json({
          status: "accepted",
          value: {
            grantId: "control-grant",
            grantVersion: "v1",
            state: readCodeState(),
            formatVersion: 1,
          },
        });
      throw new Error(`Unexpected ${operation} request: ${method} ${url}`);
    };
  }

  async function beginPendingPitchManagerCode(
    operation: "create" | "replace",
    staleProjectionState: "present" | "disabled",
  ) {
    const pending = deferred<Response>();
    let currentCalls = 0;
    let codeReads = 0;
    fetchHandler = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/pitch-manager/current")) {
        currentCalls += 1;
        return currentCalls === 2
          ? json({ status: "rejected" }, 401)
          : json({ status: "accepted", value: pitchManagerView });
      }
      if (url.endsWith("/api/pitch-manager/admit")) return json({ status: "admitted" });
      if (url.endsWith("/api/pitch-manager/leave")) return json({ status: "left" });
      if (url.endsWith("/control-grant") && method === "GET")
        return json({
          status: "accepted",
          value: {
            grantId: "control-grant",
            status: "active",
            eligibility: "eligible",
            eventGameId: "game",
          },
        });
      if (
        method === "POST" &&
        (url.endsWith("/control-grant/code") || url.endsWith(`/control-grant/code/${operation}`))
      )
        return pending.promise;
      if (url.endsWith("/control-grant/code") && method === "GET") {
        codeReads += 1;
        return json({
          status: "accepted",
          value: {
            grantId: "control-grant",
            grantVersion: "v1",
            state: codeReads === 1 ? "present" : staleProjectionState,
            formatVersion: 1,
          },
        });
      }
      throw new Error(`Unexpected ${operation} request: ${method} ${url}`);
    };

    await render(<PitchManagerPage qrRenderer={async (credential) => `data:${credential}`} />);
    await clickButton("Inspect Control Grant");
    await clickButton(operation === "create" ? "Create Radio Code" : "Replace Code");
    await clickButton("Leave");

    const reAdmissionInput = container.querySelector(
      "input#pitch-manager-grant-code",
    ) as HTMLInputElement;
    await act(async () => {
      setInputValue(reAdmissionInput, "new-manager-code");
      await flush();
    });
    await clickButton("Open Pitch");
    return pending;
  }

  async function beginPendingTechnicalRotation() {
    const pending = deferred<Response>();
    const eventA = {
      eventId: "event-a",
      name: "Event A",
      timeZone: "UTC",
      lifecycle: "current",
      gameDays: [],
    };
    const eventB = {
      eventId: "event-b",
      name: "Event B",
      timeZone: "UTC",
      lifecycle: "current",
      gameDays: [],
    };
    fetchHandler = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/admin/session"))
        return json({ authenticated: true, environment: "test", activeSessionCount: 1 });
      if (url.endsWith("/api/admin/events") && method === "GET")
        return json({ status: "accepted", value: [eventA, eventB] });
      const event = url.includes("/events/event-a") ? eventA : eventB;
      if (url.endsWith(`/${event.eventId}`) && method === "GET")
        return json({ status: "accepted", value: event });
      if (url.endsWith("/event-admin-grant") && method === "GET")
        return json({
          status: "accepted",
          value: {
            grantId: `${event.eventId}-grant`,
            grantVersion: "v1",
            eventId: event.eventId,
            status: "active",
            expiresAtMs: null,
          },
        });
      if (url.endsWith("/event-admin-grant/code") && method === "GET")
        return json({
          status: "accepted",
          value: {
            grantId: `${event.eventId}-grant`,
            grantVersion: "v1",
            state: "present",
            formatVersion: 1,
          },
        });
      if (url.endsWith("/event-admin-grant/rotate") && method === "POST") return pending.promise;
      throw new Error(`Unexpected Technical Admin request: ${method} ${url}`);
    };

    await render(<TechnicalAdminPage enrollment={false} />);
    await clickButtonContaining("Event AUTC · current");
    await clickButton("Rotate Grant");
    await clickButtonContaining("Event BUTC · current");
    return pending;
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function flush() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function flushAct() {
  await act(async () => {
    await flush();
  });
}
