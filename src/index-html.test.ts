import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { collectHtmlBundleAssetPaths } from "@/lib/html-bundle-assets";

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

  test("routes root-relative compiled bundle assets instead of returning the HTML shell", () => {
    const paths = collectHtmlBundleAssetPaths(
      '<link href="/chunk-style.css"><script src="/chunk-app.js"></script>',
      "/release",
    );

    expect(paths).toEqual(
      new Map([
        ["/chunk-style.css", "/release/chunk-style.css"],
        ["/chunk-app.js", "/release/chunk-app.js"],
      ]),
    );
  });
});
