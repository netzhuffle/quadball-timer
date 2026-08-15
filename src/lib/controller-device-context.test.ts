import { describe, expect, test } from "bun:test";
import {
  readControllerDeviceContext,
  type ControllerDeviceStorage,
} from "@/lib/controller-device-context";

function createStorage(): ControllerDeviceStorage {
  const values = new Map<string, string>();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

describe("Controller Device context", () => {
  test("keeps one pseudonymous context per browser storage and separates devices", () => {
    const firstDevice = createStorage();
    const secondDevice = createStorage();

    const firstContext = readControllerDeviceContext(firstDevice);
    expect(readControllerDeviceContext(firstDevice)).toBe(firstContext);
    expect(readControllerDeviceContext(secondDevice)).not.toBe(firstContext);
  });
});
