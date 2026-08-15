import { describe, expect, test } from "bun:test";
import { isAllowedWebSocketOrigin } from "@/lib/ws-origin";

describe("ws-origin", () => {
  test("accepts production origin for production host", () => {
    expect(isAllowedWebSocketOrigin("https://timer.quadball.app", "timer.quadball.app")).toBe(true);
  });

  test("accepts the canonical Test origin for the Test host", () => {
    expect(
      isAllowedWebSocketOrigin("https://test.timer.quadball.app", "test.timer.quadball.app"),
    ).toBe(true);
    expect(
      isAllowedWebSocketOrigin(
        "https://test.timer.quadball.app:443",
        "test.timer.quadball.app:443",
      ),
    ).toBe(true);
    expect(
      isAllowedWebSocketOrigin(
        "https://test.timer.quadball.app:39421",
        "test.timer.quadball.app:39421",
      ),
    ).toBe(true);
  });

  test("accepts explicit local development origins", () => {
    expect(isAllowedWebSocketOrigin("http://localhost:3000", "localhost:3000")).toBe(true);
    expect(isAllowedWebSocketOrigin("http://127.0.0.1:3000", "127.0.0.1:3000")).toBe(true);
    expect(isAllowedWebSocketOrigin("http://[::1]:3000", "[::1]:3000")).toBe(true);
  });

  test("rejects cross-site websocket origins", () => {
    expect(isAllowedWebSocketOrigin("https://evil.example", "timer.quadball.app")).toBe(false);
    expect(isAllowedWebSocketOrigin("https://test.timer.quadball.app", "timer.quadball.app")).toBe(
      false,
    );
    expect(isAllowedWebSocketOrigin("https://timer.quadball.app", "test.timer.quadball.app")).toBe(
      false,
    );
    expect(isAllowedWebSocketOrigin("http://localhost:3001", "localhost:3000")).toBe(false);
    expect(isAllowedWebSocketOrigin("http://timer.quadball.app", "timer.quadball.app")).toBe(false);
    expect(isAllowedWebSocketOrigin(null, "timer.quadball.app")).toBe(false);
    expect(isAllowedWebSocketOrigin("https://test.timer.quadball.app", null)).toBe(false);
    expect(
      isAllowedWebSocketOrigin("https://test.timer.quadball.app", "test.timer.quadball.app:8443"),
    ).toBe(false);
    expect(
      isAllowedWebSocketOrigin(
        "https://test.timer.quadball.app:8443",
        "test.timer.quadball.app:8444",
      ),
    ).toBe(false);
    expect(
      isAllowedWebSocketOrigin("http://test.timer.quadball.app", "test.timer.quadball.app"),
    ).toBe(false);
    expect(
      isAllowedWebSocketOrigin("ws://test.timer.quadball.app", "test.timer.quadball.app"),
    ).toBe(false);
    expect(isAllowedWebSocketOrigin("not-an-origin", "test.timer.quadball.app")).toBe(false);
  });
});
