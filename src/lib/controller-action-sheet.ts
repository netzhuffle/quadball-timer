export type ControllerActionPanel = "card" | "timeout" | "game";

/** Selecting the open action closes it; selecting another action switches panels. */
export function toggleControllerActionPanel(
  activePanel: ControllerActionPanel | null,
  requestedPanel: ControllerActionPanel,
): ControllerActionPanel | null {
  return activePanel === requestedPanel ? null : requestedPanel;
}
