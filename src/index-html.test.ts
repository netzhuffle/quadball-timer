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

  test("includes deferred and shared browser manifest assets without exposing maps or HTML", () => {
    const files: NonNullable<Bun.HTMLBundle["files"]> = [
      {
        path: "./chunk-admin123.js",
        loader: "js",
        isEntry: true,
        headers: { etag: "admin", "content-type": "text/javascript" },
      },
      {
        path: "/$bunfs/root/chunk-shared12.js",
        loader: "js",
        isEntry: false,
        headers: { etag: "shared", "content-type": "text/javascript" },
      },
      {
        path: "./chunk-admin123.js.map",
        loader: "file",
        isEntry: false,
        headers: { etag: "map", "content-type": "application/json" },
      },
      {
        path: "./index.html",
        loader: "html",
        isEntry: true,
        headers: { etag: "html", "content-type": "text/html" },
      },
    ];
    expect(
      collectHtmlBundleAssetPaths(
        '<script src="./chunk-main123.js"></script>',
        "/$bunfs/root",
        files,
      ),
    ).toEqual(
      new Map([
        ["/chunk-main123.js", "/$bunfs/root/chunk-main123.js"],
        ["/chunk-admin123.js", "/$bunfs/root/chunk-admin123.js"],
        ["/chunk-shared12.js", "/$bunfs/root/chunk-shared12.js"],
      ]),
    );
    const route = createHtmlBundleRoute("<!doctype html><html></html>", "/$bunfs/root", {
      testEnvironment: false,
      bundleFiles: files,
    });
    const response = route(new Request("https://timer.example/chunk-admin123.js"));
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });
});
