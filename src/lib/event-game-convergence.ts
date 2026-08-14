import type {
  ActionRebuildResult,
  ControlAction,
  ControlAuditEntry,
  EffectiveGameFact,
} from "@/lib/event-game-actions";
import type { ControlActionAcceptanceOutcome } from "@/lib/event-game-record";

/**
 * The server acceptance clock is durable evidence, but it is arrival-specific:
 * two valid replicas can accept the same offline action at different server
 * times. Convergence comparisons must project only that evidence out; the
 * stored action, audit entry, and acknowledgement retain the original value.
 */
export type ConvergentControlAction = Omit<ControlAction, "acceptedAtMs">;
export type ConvergentControlAuditEntry = Omit<ControlAuditEntry, "createdAtMs">;

export function projectControlActionForConvergence(action: ControlAction): ConvergentControlAction {
  const { acceptedAtMs: _acceptedAtMs, ...projected } = structuredClone(action);
  return projected;
}

export function projectControlAuditEntryForConvergence(
  entry: ControlAuditEntry,
): ConvergentControlAuditEntry {
  const { createdAtMs: _createdAtMs, ...projected } = structuredClone(entry);
  return projected;
}

export function projectAcceptanceOutcomeForConvergence(outcome: ControlActionAcceptanceOutcome):
  | ControlActionAcceptanceOutcome
  | (Omit<
      Extract<ControlActionAcceptanceOutcome, { status: "accepted" | "duplicate-accepted" }>,
      "action"
    > & {
      action: ConvergentControlAction;
    }) {
  if (outcome.status !== "accepted" && outcome.status !== "duplicate-accepted") {
    return structuredClone(outcome);
  }
  return {
    ...structuredClone(outcome),
    action: projectControlActionForConvergence(outcome.action),
  };
}

export function projectRebuildForConvergence(
  rebuild: Extract<ActionRebuildResult, { status: "ready" }>,
): Omit<
  Extract<ActionRebuildResult, { status: "ready" }>,
  "canonicalActions" | "effectiveFacts"
> & {
  canonicalActions: ConvergentControlAction[];
  effectiveFacts: Array<Omit<EffectiveGameFact, "action"> & { action: ConvergentControlAction }>;
} {
  return {
    ...structuredClone(rebuild),
    canonicalActions: rebuild.canonicalActions.map(projectControlActionForConvergence),
    effectiveFacts: rebuild.effectiveFacts.map((fact) => ({
      ...structuredClone(fact),
      action: projectControlActionForConvergence(fact.action),
    })),
  };
}
