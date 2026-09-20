import { expect, test } from "bun:test";
import { summarizeBundle } from "./bundle-analysis";

test("separates server, eager browser closure, deferred routes and shared chunks", () => {
  const meta: Bun.BuildMetafile = {
    inputs: {
      "src/index.html": {
        bytes: 10,
        imports: [{ path: "src/frontend.tsx", kind: "import-statement" }],
      },
      "src/frontend.tsx": {
        bytes: 10,
        imports: [{ path: "src/admin.tsx", kind: "dynamic-import" }],
      },
      "src/admin.tsx": { bytes: 10, imports: [] },
    },
    outputs: {
      "./index.js": {
        bytes: 200,
        inputs: {},
        imports: [],
        exports: [],
        entryPoint: "src/index.ts",
      },
      "./index.html": {
        bytes: 10,
        inputs: {},
        imports: [],
        exports: [],
        entryPoint: "src/index.html",
      },
      "./app.js": {
        bytes: 90,
        inputs: { "src/frontend.tsx": { bytesInOutput: 80 } },
        imports: [
          { path: "./shared.js", kind: "import-statement" },
          { path: "./admin.js", kind: "dynamic-import" },
        ],
        exports: [],
        entryPoint: "src/index.html",
        cssBundle: "./app.css",
      },
      "./app.css": {
        bytes: 20,
        inputs: {},
        imports: [],
        exports: [],
        entryPoint: "src/index.html",
      },
      "./admin.js": {
        bytes: 50,
        inputs: { "src/admin.tsx": { bytesInOutput: 40 } },
        imports: [{ path: "./shared.js", kind: "import-statement" }],
        exports: [],
        entryPoint: "src/admin.tsx",
      },
      "./shared.js": { bytes: 30, inputs: {}, imports: [], exports: [] },
    },
  };
  const report = summarizeBundle(
    meta,
    { "./app.js": 100, "./app.css": 20, "./shared.js": 30 },
    '<script src="./app.js"></script><base href="/">',
  );
  expect(report.initialAssetEmittedBytes).toBe(150);
  expect(report.files.find((file) => file.file === "./index.js")?.scope).toBe("server");
  expect(report.files.find((file) => file.file === "./admin.js")).toMatchObject({
    scope: "browser",
    initial: false,
    modules: [{ importChain: ["src/index.html", "src/frontend.tsx", "src/admin.tsx"] }],
  });
  expect(report.files.find((file) => file.file === "./shared.js")).toMatchObject({
    role: "shared-chunk",
    initial: true,
  });
});

test("fails closed when nested browser metadata is unavailable", () => {
  expect(() => summarizeBundle({ inputs: {}, outputs: {} }, {}, "")).toThrow(
    "missing the browser graph",
  );
});
