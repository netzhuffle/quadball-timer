#!/usr/bin/env bun

const journeys = [
  {
    name: "Ad Hoc production Controller header",
    command: "scripts/test-ad-hoc-browser.ts",
  },
  {
    name: "Event production Controller header",
    command: "scripts/test-event-game-controller-browser.ts",
  },
] as const;

for (const journey of journeys) {
  console.log(`Focused Integration journey: ${journey.name}`);
  const child = Bun.spawn(["bun", journey.command], {
    cwd: process.cwd(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${journey.name} failed with exit code ${exitCode}.`);
  }
}

console.log(
  "Shared mobile Controller Focused Integration passed: Ad Hoc and Event headers at 390x844 and 412x915.",
);
