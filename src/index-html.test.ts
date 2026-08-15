import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("index.html", () => {
  test("sets base href for route-safe asset resolution", () => {
    const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    expect(html).toContain('<base href="/" />');
  });

  test("keeps Test presentation marker and crawler policy in the server transform", () => {
    const server = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(server).toContain("Test environment — not for live games");
    expect(server).toContain("noindex, nofollow, noarchive, noimageindex");
  });
});
