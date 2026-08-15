import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { AdministrativeAuditBrowser } from "@/pages/administrative-audit-browser";

describe("shared administrative audit browser seam", () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  let testWindow: Window;
  let container: HTMLDivElement;
  let root: Root;
  let requests: string[];

  beforeEach(() => {
    testWindow = new Window({ url: "http://timer.quadball.app/event-admin?eventId=event-1" });
    Object.assign(globalThis, {
      window: testWindow,
      document: testWindow.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    requests = [];
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
      IS_REACT_ACT_ENVIRONMENT: originalActEnvironment,
    });
  });

  test("loads both projections, crosses a bounded page, and resets on filter and direction changes", async () => {
    const request = async (input: RequestInfo | URL) => {
      const rawInput =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(rawInput, testWindow.location.href);
      requests.push(url.toString());
      const projection = url.searchParams.get("projection") ?? "";
      const cursor = url.searchParams.get("cursor");
      const direction = url.searchParams.get("direction");
      const action = url.searchParams.get("action");
      const page = cursor === null ? 1 : 2;
      return new Response(
        JSON.stringify({
          status: "accepted",
          value: {
            entries: [
              {
                evidenceId: `${projection}-${direction}-${action ?? "all"}-${page}`,
                evidenceType: projection,
                action: action ?? "event-created",
                occurredAtMs: page,
                authority: { reference: "actor" },
                scope: {},
                before: null,
                after: null,
                links: {},
              },
            ],
            direction,
            hasMore: page === 1,
            nextCursor: page === 1 ? `${projection}-cursor` : null,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    await act(async () => {
      root.render(
        <AdministrativeAuditBrowser eventId="event-1" route="event-admin" request={request} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("event-administration-descending-all-1");
    expect(container.textContent).toContain("grant-descending-all-1");
    expect(requests).toHaveLength(2);

    await act(async () => {
      const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
        candidate.textContent?.includes("Load more Event Administration"),
      );
      if (button === undefined) throw new Error("Expected Event load-more button.");
      button.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("event-administration-descending-all-2");

    await act(async () => {
      const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
        candidate.textContent?.includes("Load more Grant Audit"),
      );
      if (button === undefined) throw new Error("Expected Grant load-more button.");
      button.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("grant-descending-all-2");

    await act(async () => {
      const direction = container.querySelector(
        'select[aria-label="Audit ordering"]',
      ) as HTMLSelectElement | null;
      if (direction === null) throw new Error("Expected ordering control.");
      direction.value = "ascending";
      direction.dispatchEvent(
        new testWindow.Event("change", { bubbles: true }) as unknown as Event,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain("event-administration-descending-all-2");
    expect(container.textContent).toContain("event-administration-ascending-all-1");

    await act(async () => {
      const action = container.querySelector(
        'input[aria-label="Audit action filter"]',
      ) as HTMLInputElement | null;
      if (action === null) throw new Error("Expected action filter.");
      action.value = "event-created";
      action.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as unknown as Event);
      action.dispatchEvent(new testWindow.Event("change", { bubbles: true }) as unknown as Event);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("event-administration-ascending-event-created-1");
    expect(requests.at(-1)).toContain("action=event-created");
  });

  test("keeps stale load-more success and rejected responses out of newer queries", async () => {
    type PendingRequest = {
      url: string;
      resolve: (response: Response) => void;
    };
    const pending: PendingRequest[] = [];
    const response = (label: string, hasMore = true) =>
      new Response(
        JSON.stringify({
          status: "accepted",
          value: {
            entries: [
              {
                evidenceId: label,
                evidenceType: "event-administration",
                action: "event-created",
                occurredAtMs: 1,
                authority: { reference: "actor" },
                scope: {},
                before: null,
                after: null,
                links: {},
              },
            ],
            direction: "descending",
            hasMore,
            nextCursor: hasMore ? `${label}-next` : null,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const rejectedAuditResponse = () =>
      new Response(
        JSON.stringify({ status: "rejected", detail: "Unable to load audit evidence." }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );
    const request = (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return new Promise<Response>((resolve) => {
        pending.push({ url, resolve });
      });
    };
    const flush = async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    };
    const findPending = (predicate: (request: PendingRequest) => boolean) => {
      const found = pending.find(predicate);
      if (found === undefined) throw new Error("Expected deferred request.");
      return found;
    };
    const resolveInitial = async (eventId: string, label: string, action?: string) => {
      for (const request of pending.filter(
        (candidate) =>
          candidate.url.includes(`eventId=${eventId}`) &&
          !candidate.url.includes("cursor=") &&
          (action === undefined
            ? !candidate.url.includes("action=")
            : candidate.url.includes(`action=${action}`)),
      )) {
        request.resolve(response(label));
      }
      await flush();
    };

    await act(async () => {
      root.render(
        <AdministrativeAuditBrowser eventId="event-a" route="event-admin" request={request} />,
      );
      await flush();
    });
    await act(async () => resolveInitial("event-a", "event-a-page-1"));
    expect(container.textContent).toContain("event-a-page-1");

    await act(async () => {
      const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
        candidate.textContent?.includes("Load more Event Administration"),
      );
      if (button === undefined) throw new Error("Expected Event load-more button.");
      button.click();
      await flush();
    });
    const staleSuccess = findPending(
      (candidate) => candidate.url.includes("eventId=event-a") && candidate.url.includes("cursor="),
    );

    await act(async () => {
      root.render(
        <AdministrativeAuditBrowser eventId="event-b" route="event-admin" request={request} />,
      );
      await flush();
    });
    await act(async () => resolveInitial("event-b", "event-b-page-1"));
    expect(container.textContent).toContain("event-b-page-1");
    expect(container.textContent).not.toContain("event-a-page-2");
    staleSuccess.resolve(response("event-a-page-2"));
    await act(flush);
    expect(container.textContent).toContain("event-b-page-1");
    expect(container.textContent).not.toContain("event-a-page-2");

    await act(async () => {
      const action = container.querySelector(
        'input[aria-label="Audit action filter"]',
      ) as HTMLInputElement | null;
      if (action === null) throw new Error("Expected action filter.");
      action.value = "filter-a";
      action.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as unknown as Event);
      action.dispatchEvent(new testWindow.Event("change", { bubbles: true }) as unknown as Event);
      await flush();
    });
    await act(async () => resolveInitial("event-b", "event-b-filter-a-page-1", "filter-a"));
    expect(container.textContent).toContain("event-b-filter-a-page-1");

    await act(async () => {
      const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
        candidate.textContent?.includes("Load more Event Administration"),
      );
      if (button === undefined) throw new Error("Expected filtered Event load-more button.");
      button.click();
      await flush();
    });
    const staleRejectedResponse = findPending(
      (candidate) =>
        candidate.url.includes("eventId=event-b") &&
        candidate.url.includes("action=filter-a") &&
        candidate.url.includes("cursor="),
    );

    await act(async () => {
      const action = container.querySelector(
        'input[aria-label="Audit action filter"]',
      ) as HTMLInputElement | null;
      if (action === null) throw new Error("Expected action filter.");
      action.value = "filter-b";
      action.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as unknown as Event);
      action.dispatchEvent(new testWindow.Event("change", { bubbles: true }) as unknown as Event);
      await flush();
    });
    await act(async () => resolveInitial("event-b", "event-b-filter-b-page-1", "filter-b"));
    expect(container.textContent).toContain("event-b-filter-b-page-1");
    expect(container.textContent).not.toContain("event-b-filter-a-page-1");
    const filterBLoadMore = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Load more Event Administration"),
    );
    if (filterBLoadMore === undefined) throw new Error("Expected filter-B load-more button.");
    expect(filterBLoadMore.textContent).toBe("Load more Event Administration");

    staleRejectedResponse.resolve(rejectedAuditResponse());
    await act(flush);
    const stableFilterBState = container.textContent;
    await act(flush);
    expect(container.textContent).toBe(stableFilterBState);
    expect(container.textContent).toContain("event-b-filter-b-page-1");
    expect(container.textContent).not.toContain("Unable to load audit evidence.");
    expect(container.textContent).not.toContain("event-a-page-2");

    await act(async () => {
      filterBLoadMore.click();
      await flush();
    });
    const filterBNextPage = findPending(
      (candidate) =>
        candidate.url.includes("eventId=event-b") &&
        candidate.url.includes("action=filter-b") &&
        candidate.url.includes("cursor="),
    );
    expect(filterBNextPage.url).toContain("cursor=event-b-filter-b-page-1-next");
  });
});
