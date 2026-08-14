export type QualificationEntry = {
  complete: boolean;
  riskStillExists: boolean;
  safe: boolean;
};

export type QualificationRequest =
  | { kind: "ordinary" }
  | {
      kind: "qualification";
      mode: "run" | "validate" | "review";
      name?: string;
      parametersMatch?: boolean;
    };

export type RoutingDecision =
  | "ordinary-boundary"
  | "inspect-without-invocation"
  | "invoke-once"
  | "refuse-ambiguous"
  | "refuse-unregistered"
  | "refuse-incomplete"
  | "refuse-unsafe"
  | "refuse-parameter-mismatch"
  | "refuse-risk-not-established";

export function routeQualificationRequest(
  request: QualificationRequest,
  registry: Readonly<Record<string, QualificationEntry>>,
): RoutingDecision {
  if (request.kind === "ordinary") return "ordinary-boundary";
  if (!request.name) return "refuse-ambiguous";

  const entry = registry[request.name];
  if (!entry) return "refuse-unregistered";
  if (!entry.complete) return "refuse-incomplete";
  if (!entry.riskStillExists) return "refuse-risk-not-established";
  if (!entry.safe) return "refuse-unsafe";
  if (request.parametersMatch === false) return "refuse-parameter-mismatch";
  if (request.mode !== "run") return "inspect-without-invocation";
  return "invoke-once";
}
