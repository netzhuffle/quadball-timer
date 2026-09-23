import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLiveEventGrantKeyRing } from "../src/lib/live-event-game-runtime";
import {
  developmentDirectory,
  developmentEnvironment,
  initializeDevelopmentState,
} from "./development-state";

const roots: string[] = [];
const root = () => {
  const path = mkdtempSync(join(tmpdir(), "qbt-dev-"));
  roots.push(path);
  return path;
};
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("restarts preserve keys and game identity across ports and HTTPS origins", () => {
  const worktree = root();
  const directory = initializeDevelopmentState(worktree);
  const before = readFileSync(join(directory, "state.json"), "utf8");
  expect(initializeDevelopmentState(worktree)).toBe(directory);
  expect(readFileSync(join(directory, "state.json"), "utf8")).toBe(before);
  const http = developmentEnvironment(directory, 3000, "http://localhost:3000");
  const https = developmentEnvironment(directory, 3001, "https://preview.example.com:8443");
  expect(http.AD_HOC_ENVIRONMENT_ID).toBe(https.AD_HOC_ENVIRONMENT_ID);
  expect(http.DEV_EVENT_GAME_KEY_RING_FILE).toBe(https.DEV_EVENT_GAME_KEY_RING_FILE);
  expect(http.AD_HOC_DATABASE).toBe(https.AD_HOC_DATABASE);
  expect(http.TECHNICAL_ADMIN_DATABASE).not.toBe(https.TECHNICAL_ADMIN_DATABASE);
  expect(http.LOCAL_HTTP_DEV).toBe("1");
  expect(https.LOCAL_HTTP_DEV).toBe("0");
  const keys = readLiveEventGrantKeyRing(https);
  expect(keys?.encryption.currentVersion).toBe("v1");
  expect(keys?.encryption.keys.has("v1")).toBe(true);
  expect(() => readLiveEventGrantKeyRing({ ...https, NODE_ENV: "production" })).toThrow(
    "restricted",
  );
  expect(() => readLiveEventGrantKeyRing({ ...https, QUADBALL_ENVIRONMENT: "production" })).toThrow(
    "restricted",
  );
});

test("worktrees start independently and copies retain sporting keys without passkeys", () => {
  const source = root();
  const target = root();
  const directory = initializeDevelopmentState(source);
  mkdirSync(join(directory, "technical-admin"));
  writeFileSync(join(directory, "technical-admin", "credential.sqlite"), "private");
  writeFileSync(join(directory, "ad-hoc.sqlite"), "sporting-data");
  const copied = initializeDevelopmentState(target, source);
  expect(readFileSync(join(copied, "ad-hoc.sqlite"), "utf8")).toBe("sporting-data");
  expect(readFileSync(join(copied, "state.json"), "utf8")).toBe(
    readFileSync(join(directory, "state.json"), "utf8"),
  );
  expect(existsSync(join(copied, "technical-admin"))).toBe(false);
  expect(() => initializeDevelopmentState(target, source)).toThrow("already exists");
  const independent = initializeDevelopmentState(root());
  expect(readFileSync(join(independent, "state.json"), "utf8")).not.toBe(
    readFileSync(join(directory, "state.json"), "utf8"),
  );
});

test("missing keys and running source fail without replacing data or creating a partial destination", () => {
  const source = root();
  const target = root();
  const directory = initializeDevelopmentState(source);
  mkdirSync(join(directory, "runtime.lock"));
  expect(() => initializeDevelopmentState(target, source)).toThrow("Stop the source");
  expect(existsSync(developmentDirectory(target))).toBe(false);
  rmSync(join(directory, "grant-key-ring.json"));
  expect(() => initializeDevelopmentState(source)).toThrow();
  expect(existsSync(join(directory, "grant-key-ring.json"))).toBe(false);
});

test("HTTP external origins and malformed ports are rejected", () => {
  const directory = initializeDevelopmentState(root());
  expect(() => developmentEnvironment(directory, 3000, "http://preview.local:3000")).toThrow(
    "loopback",
  );
  expect(() => developmentEnvironment(directory, 0, "http://localhost:3000")).toThrow("Port");
  expect(() => developmentEnvironment(directory, 3000, "https://host/path")).toThrow("exact");
});

test("imported catalog previews retain their explicitly disabled live reader", () => {
  const directory = initializeDevelopmentState(root());
  const path = join(directory, "state.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...state, liveEventGames: false }));
  const environment = developmentEnvironment(directory, 3000, "http://localhost:3000");
  expect(readLiveEventGrantKeyRing(environment)).toBeNull();
});
