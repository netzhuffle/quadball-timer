import {
  routeQualificationRequest,
  type QualificationEntry,
  type QualificationRequest,
  type RoutingDecision,
} from "@/lib/testing-policy";

const syntheticRegistry = {
  "example-qualification": {
    complete: true,
    riskStillExists: true,
    safe: true,
  },
} satisfies Readonly<Record<string, QualificationEntry>>;

const dryRunCases: ReadonlyArray<
  [string, QualificationRequest, Readonly<Record<string, QualificationEntry>>, RoutingDecision]
> = [
  [
    "explicit registered qualification request",
    {
      kind: "qualification",
      mode: "run",
      name: "example-qualification",
    },
    syntheticRegistry,
    "invoke-once",
  ],
  ["ordinary test request", { kind: "ordinary" }, {}, "ordinary-boundary"],
  ["ordinary check request", { kind: "ordinary" }, {}, "ordinary-boundary"],
  ["ordinary build request", { kind: "ordinary" }, {}, "ordinary-boundary"],
  ["ordinary implementation request", { kind: "ordinary" }, {}, "ordinary-boundary"],
  ["ordinary review request", { kind: "ordinary" }, {}, "ordinary-boundary"],
  [
    "validate-only qualification request",
    {
      kind: "qualification",
      mode: "validate",
      name: "example-qualification",
    },
    syntheticRegistry,
    "inspect-without-invocation",
  ],
  [
    "review-only qualification request",
    {
      kind: "qualification",
      mode: "review",
      name: "example-qualification",
    },
    syntheticRegistry,
    "inspect-without-invocation",
  ],
  [
    "empty-registry qualification request",
    {
      kind: "qualification",
      mode: "run",
      name: "example-qualification",
    },
    {},
    "refuse-unregistered",
  ],
];

function assertDecision(actual: RoutingDecision, expected: RoutingDecision, requestName: string) {
  if (actual !== expected) {
    throw new Error(`${requestName}: expected ${expected}, received ${actual}`);
  }
}

console.log("Testing policy routing dry-run:");
let simulatedLaunchCount = 0;
for (const [requestName, request, registry, expected] of dryRunCases) {
  const decision = routeQualificationRequest(request, registry);
  assertDecision(decision, expected, requestName);
  if (decision === "invoke-once") simulatedLaunchCount += 1;
  console.log(`- ${requestName}: ${decision}`);
}

if (simulatedLaunchCount !== 1) {
  throw new Error(`expected one simulated explicit invocation, received ${simulatedLaunchCount}`);
}

console.log("Dry-run passed; no qualification workload was launched.");
