import { describe, expect, test } from "bun:test";
import { isInternalHealthHost } from "@/lib/internal-health";

describe("internal-health", () => {
  test("accepts loopback hosts with or without ports", () => {
    expect(isInternalHealthHost("127.0.0.1")).toBe(true);
    expect(isInternalHealthHost("127.0.0.1:3000")).toBe(true);
    expect(isInternalHealthHost("localhost")).toBe(true);
    expect(isInternalHealthHost("localhost:3000")).toBe(true);
    expect(isInternalHealthHost("[::1]:3000")).toBe(true);
  });

  test("rejects public hostnames and non-loopback addresses", () => {
    expect(isInternalHealthHost("timer.quadball.app")).toBe(false);
    expect(isInternalHealthHost("timer.quadball.app:443")).toBe(false);
    expect(isInternalHealthHost("10.0.0.12:3000")).toBe(false);
    expect(isInternalHealthHost(null)).toBe(false);
  });
});
