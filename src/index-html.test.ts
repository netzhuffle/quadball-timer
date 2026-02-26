import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("index.html", () => {
  test("sets base href for route-safe asset resolution", () => {
    const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    expect(html).toContain('<base href="/" />');
  });
});
