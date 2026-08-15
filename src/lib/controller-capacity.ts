export type ControllerCapacityInput = {
  totalConnections: number;
  reservedConnections: number;
  activeControllerSessions: number;
};

/**
 * Return non-Controller capacity after honoring the configured reserve,
 * active authoritative Controller Sessions, and an optional workflow cap.
 */
export function availableNonControllerCapacity(
  input: ControllerCapacityInput,
  maximum = Number.POSITIVE_INFINITY,
): number {
  const totalConnections = Number.isFinite(input.totalConnections)
    ? Math.max(0, Math.floor(input.totalConnections))
    : 0;
  const reservedConnections = Number.isFinite(input.reservedConnections)
    ? Math.min(totalConnections, Math.max(0, Math.floor(input.reservedConnections)))
    : 0;
  const activeControllerSessions = Number.isFinite(input.activeControllerSessions)
    ? Math.max(0, Math.floor(input.activeControllerSessions))
    : 0;
  const available = Math.max(
    0,
    totalConnections - Math.max(reservedConnections, activeControllerSessions),
  );
  return Math.min(available, Number.isFinite(maximum) ? Math.max(0, maximum) : available);
}
