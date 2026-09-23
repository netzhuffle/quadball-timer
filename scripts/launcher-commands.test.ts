import { expect, test } from "bun:test";
import manifest from "../package.json";

test("orphan containment stays on development and intentional browser launchers", () => {
  const contained = Object.entries(manifest.scripts)
    .filter(([, command]) => command.includes("--no-orphans"))
    .map(([name]) => name)
    .sort();
  expect(contained).toEqual([
    "dev",
    "test:focused:adhoc-browser",
    "test:focused:controller-header-mobile",
    "test:focused:event-admin-browser-webkit",
    "test:focused:event-game-controller-browser",
    "test:focused:launcher-lifecycle",
    "test:focused:public-event-browser",
    "test:focused:technical-admin-browser",
  ]);
  expect(manifest.scripts.dev).toContain("scripts/dev.ts");
  expect(manifest.scripts.test).not.toContain("focused");
  expect(manifest.scripts.check).not.toContain("launcher-lifecycle");
});
