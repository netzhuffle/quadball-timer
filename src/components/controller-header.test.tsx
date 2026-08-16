import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { ControllerHeader } from "@/components/controller-header";
import { eventControllerHeaderIdentity } from "@/lib/controller-header-identity";

describe("shared Controller header", () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  let testWindow: Window;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    testWindow = new Window({ url: "http://timer.quadball.app/game/controller" });
    Object.assign(globalThis, {
      window: testWindow,
      document: testWindow.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
    testWindow.close();
    Object.assign(globalThis, { window: originalWindow, document: originalDocument });
  });

  test("keeps healthy state quiet and wires compact accessible QR and Leave controls", async () => {
    let qrClicks = 0;
    let leaveClicks = 0;
    await act(async () => {
      root.render(
        <ControllerHeader
          identity={{ eyebrow: "Ad Hoc Game", title: "Basel Basilisks vs Thunderbirds" }}
          warning={null}
          qr={{
            label: "Show Ad Hoc Control QR",
            expanded: false,
            controls: "qr-dialog",
            onClick: () => {
              qrClicks += 1;
            },
          }}
          onLeave={() => {
            leaveClicks += 1;
          }}
          leaveLabel="Leave Ad Hoc Game Controller"
        />,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Ad Hoc Game");
    expect(container.textContent).toContain("Basel Basilisks vs Thunderbirds");
    expect(container.textContent).not.toContain("Live");
    const qr = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show Ad Hoc Control QR"]',
    );
    expect(qr?.getAttribute("aria-expanded")).toBe("false");
    expect(qr?.getAttribute("aria-controls")).toBe("qr-dialog");
    expect(qr?.className).toContain("size-11");
    qr?.click();
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Leave Ad Hoc Game Controller"]')
      ?.click();
    expect(qrClicks).toBe(1);
    expect(leaveClicks).toBe(1);
  });

  test("projects Offline without a zero queued-action clause", async () => {
    await act(async () => {
      root.render(
        <ControllerHeader
          identity={{ eyebrow: "Pitch 2 · QF-07", title: "Game Designation" }}
          warning={{ kind: "offline", queuedActions: 0, retryDetail: "Reconnect to reconcile." }}
        />,
      );
      await Promise.resolve();
    });
    const warning = container.querySelector("[data-controller-warning]");
    expect(warning?.textContent).toBe("Offline. Reconnect to reconcile.");
    expect(container.querySelectorAll("[data-controller-warning]")).toHaveLength(1);
    expect(container.textContent).not.toContain("Connection is healthy");
  });

  test("projects one queued action in the concise Offline warning", async () => {
    await act(async () => {
      root.render(
        <ControllerHeader
          identity={{ eyebrow: "Pitch 2 · QF-07", title: "Game Designation" }}
          warning={{ kind: "offline", queuedActions: 1 }}
        />,
      );
      await Promise.resolve();
    });

    expect(container.querySelector("[data-controller-warning]")?.textContent).toBe(
      "Offline · 1 queued action.",
    );
  });

  test("projects many queued actions in the concise Offline warning", async () => {
    await act(async () => {
      root.render(
        <ControllerHeader
          identity={{ eyebrow: "Pitch 2 · QF-07", title: "Game Designation" }}
          warning={{ kind: "offline", queuedActions: 2 }}
        />,
      );
      await Promise.resolve();
    });

    expect(container.querySelector("[data-controller-warning]")?.textContent).toBe(
      "Offline · 2 queued actions.",
    );
  });

  test("projects stale connectivity without mislabeling it Offline", async () => {
    await act(async () => {
      root.render(
        <ControllerHeader
          identity={{ eyebrow: "Pitch 2 · QF-07", title: "Game Designation" }}
          warning={{ kind: "stale", queuedActions: 0, retryDetail: "Reconnect to reconcile." }}
        />,
      );
      await Promise.resolve();
    });

    expect(container.querySelector("[data-controller-warning]")?.textContent).toBe(
      "Connection stale. Reconnect to reconcile.",
    );
    expect(container.textContent).not.toContain("Offline");
  });

  test("formats Event identity without empty separators and falls back to teams", () => {
    expect(
      eventControllerHeaderIdentity({
        identity: { pitchName: "Pitch 2", gameCode: null, gameDesignation: "Final" },
        teamAssignments: [
          { eventTeamName: "Basilisks", gameSideId: "side-a" },
          { eventTeamName: "Thunderbirds", gameSideId: "side-b" },
        ],
      }),
    ).toEqual({ eyebrow: "Pitch 2", title: "Final" });
    expect(
      eventControllerHeaderIdentity({
        identity: { pitchName: null, gameCode: "QF-07", gameDesignation: null },
        teamAssignments: [
          { eventTeamName: "Basilisks", gameSideId: "side-a" },
          { eventTeamName: "Thunderbirds", gameSideId: "side-b" },
        ],
      }),
    ).toEqual({ eyebrow: "QF-07", title: "Basilisks vs Thunderbirds" });
  });
});
