import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, lazy } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { DeferredRoute } from "./deferred-route";

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT;
let testWindow: Window;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  testWindow = new Window({ url: "http://localhost/event-admin#grant=retained" });
  Object.assign(globalThis, {
    window: testWindow,
    document: testWindow.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container, { onCaughtError: () => undefined });
});

afterEach(async () => {
  await act(async () => root.unmount());
  testWindow.close();
  Object.assign(globalThis, {
    window: originalWindow,
    document: originalDocument,
    IS_REACT_ACT_ENVIRONMENT: originalActEnvironment,
  });
});

test("announces pending navigation and renders the resolved page", async () => {
  const pending = Promise.withResolvers<{ default: () => React.JSX.Element }>();
  const Page = lazy(() => pending.promise);
  await act(async () =>
    root.render(
      <DeferredRoute name="Event administration">
        <Page />
      </DeferredRoute>,
    ),
  );
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "Loading Event administration…",
  );
  await act(async () => pending.resolve({ default: () => <h1>Admit with a Grant</h1> }));
  expect(container.textContent).toBe("Admit with a Grant");
  expect(container.querySelector('[role="status"]')).toBeNull();
});

test("failed chunks offer a fresh document retry without changing the admission URL", async () => {
  const pending = Promise.withResolvers<{ default: () => React.JSX.Element }>();
  const Page = lazy(() => pending.promise);
  await act(async () =>
    root.render(
      <DeferredRoute name="Event administration">
        <Page />
      </DeferredRoute>,
    ),
  );
  await act(async () =>
    pending.reject(new TypeError("Failed to fetch dynamically imported module")),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Event administration could not load",
  );
  const reload = spyOn(testWindow.location, "reload").mockImplementation(() => undefined);
  try {
    container.querySelector("button")?.click();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(testWindow.location.href).toBe("http://localhost/event-admin#grant=retained");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/events?view=all");
  } finally {
    reload.mockRestore();
  }
  await act(async () =>
    root.render(
      <DeferredRoute key="another-route" name="Another page">
        <h1>Another page</h1>
      </DeferredRoute>,
    ),
  );
  expect(container.textContent).toBe("Another page");
});
