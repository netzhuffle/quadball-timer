import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { collectHtmlBundleAssetPaths } from "@/lib/html-bundle-assets";
import { assetCacheControl, createHtmlBundleRoute, isVersionedAssetPath } from "@/index";

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

  test("revalidates dynamic HTML and keeps only versioned assets immutable", async () => {
    const route = createHtmlBundleRoute(
      '<!doctype html><html><head><script src="./chunk-a1b2c3d4.js"></script></head><body></body></html>',
      "/release",
      {
        testEnvironment: false,
        browserMonitoring: {
          environment: "production",
          release: "release-test",
          browserCorrelation: "browser-test",
        },
      },
    );
    const first = route(new Request("https://timer.example/events/event-1"));
    const etag = first.headers.get("etag");
    expect(first.headers.get("cache-control")).toBe("no-cache");
    expect(etag).not.toBeNull();
    const revalidated = route(
      new Request("https://timer.example/events/event-1", {
        headers: { "if-none-match": etag ?? "" },
      }),
    );
    expect(revalidated.status).toBe(304);

    expect(isVersionedAssetPath("/index-a1b2c3d4.js")).toBe(true);
    expect(isVersionedAssetPath("/chunk-5g7peymh.js")).toBe(true);
    expect(isVersionedAssetPath("/index.js")).toBe(false);
    expect(assetCacheControl(true, false)).toBe("public, max-age=31536000, immutable");
    expect(assetCacheControl(false, false)).toBe("no-cache");
    expect(assetCacheControl(true, true)).toBe("no-cache");
  });
});
