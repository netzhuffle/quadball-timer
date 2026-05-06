import { describe, expect, test } from "bun:test";
import { isAllowedWebSocketOrigin } from "@/lib/ws-origin";

describe("ws-origin", () => {
  test("accepts production origin for production host", () => {
    expect(isAllowedWebSocketOrigin("https://timer.quadball.app", "timer.quadball.app")).toBe(true);
  });

  test("accepts explicit local development origins", () => {
    expect(isAllowedWebSocketOrigin("http://localhost:3000", "localhost:3000")).toBe(true);
    expect(isAllowedWebSocketOrigin("http://127.0.0.1:3000", "127.0.0.1:3000")).toBe(true);
    expect(isAllowedWebSocketOrigin("http://[::1]:3000", "[::1]:3000")).toBe(true);
  });

  test("rejects cross-site websocket origins", () => {
    expect(isAllowedWebSocketOrigin("https://evil.example", "timer.quadball.app")).toBe(false);
    expect(isAllowedWebSocketOrigin("http://localhost:3001", "localhost:3000")).toBe(false);
    expect(isAllowedWebSocketOrigin("http://timer.quadball.app", "timer.quadball.app")).toBe(false);
    expect(isAllowedWebSocketOrigin(null, "timer.quadball.app")).toBe(false);
  });
});
