const CONTROLLER_DEVICE_CONTEXT_STORAGE_KEY = "quadball-timer.controller-device-context.v1";

export type ControllerDeviceStorage = Pick<Storage, "getItem" | "setItem">;

export function readControllerDeviceContext(
  storage: ControllerDeviceStorage | null = readBrowserStorage(),
): string {
  if (storage !== null) {
    try {
      const existing = storage.getItem(CONTROLLER_DEVICE_CONTEXT_STORAGE_KEY);
      if (existing !== null && existing.length > 0) return existing;
    } catch {
      // Private browsing and disabled storage are still valid Controller states.
    }
  }

  const context = `controller-device-${crypto.randomUUID()}`;
  if (storage !== null) {
    try {
      storage.setItem(CONTROLLER_DEVICE_CONTEXT_STORAGE_KEY, context);
    } catch {
      // The page keeps this generated context for its current lifetime.
    }
  }
  return context;
}

function readBrowserStorage(): ControllerDeviceStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
