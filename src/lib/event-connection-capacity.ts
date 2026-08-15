import {
  AD_HOC_EVENT_RESERVED_CONNECTION_CAPACITY,
  AD_HOC_EVENT_TOTAL_CONNECTION_CAPACITY,
} from "@/lib/ad-hoc-resource-budgets";
import type { ControllerCapacitySignal } from "@/lib/controller-capacity";

/** One process-wide Event connection envelope shared by admission and spectator fan-out. */
export function readEventConnectionCapacity(
  environment: Record<string, string | undefined>,
  activeControllerSessions: () => number,
): ControllerCapacitySignal {
  return {
    totalConnections: readCapacity(
      environment.EVENT_TOTAL_CONNECTION_CAPACITY,
      AD_HOC_EVENT_TOTAL_CONNECTION_CAPACITY,
    ),
    reservedConnections: readCapacity(
      environment.EVENT_RESERVED_CONNECTION_CAPACITY,
      AD_HOC_EVENT_RESERVED_CONNECTION_CAPACITY,
    ),
    activeControllerSessions,
  };
}

function readCapacity(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
