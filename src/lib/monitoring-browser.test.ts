import { describe, expect, test } from "bun:test";
import {
  createReactRootErrorHandlers,
  installBrowserMonitoringListeners,
} from "@/lib/monitoring-browser";

describe("browser monitoring listeners", () => {
  test("converts window errors and rejected promises into bounded capture calls", () => {
    const listeners = new Map<string, EventListener>();
    const target = {
      addEventListener(type: string, listener: EventListener) {
        listeners.set(type, listener);
      },
    };
    const captures: Array<{ error: unknown; category?: string; component?: string }> = [];
    installBrowserMonitoringListeners(target, (error, context) => {
      captures.push({ error, category: context.category, component: context.component });
    });

    const windowError = Object.assign(new Event("error"), {
      error: new Error("private team name"),
      message: "private team name",
    });
    listeners.get("error")?.(windowError);
    const rejection = Object.assign(new Event("unhandledrejection"), {
      reason: "private rejection value",
    });
    listeners.get("unhandledrejection")?.(rejection);

    expect(captures).toHaveLength(2);
    expect(captures[0]).toMatchObject({ category: "browser", component: "window" });
    expect(captures[0]?.error).toBeInstanceOf(Error);
    expect(captures[1]).toMatchObject({ category: "browser", component: "promise" });
    expect(captures[1]?.error).toBeInstanceOf(Error);
  });

  test("exposes all React 19 root error callback seams", () => {
    const handlers = createReactRootErrorHandlers();
    expect(Object.keys(handlers).sort()).toEqual([
      "onCaughtError",
      "onRecoverableError",
      "onUncaughtError",
    ]);
    expect(() =>
      handlers.onRecoverableError(new Error("private team name"), { componentStack: "" }),
    ).not.toThrow();
  });
});
