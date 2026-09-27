export type ControlPanelWindowMode = "compact" | "restore";

export interface SettledControlPanelWindowState {
  isControlPanel: boolean;
  isLoading: boolean;
  showOnboarding: boolean;
}

export function resolveSettledControlPanelWindowMode(
  state: SettledControlPanelWindowState
): ControlPanelWindowMode | null {
  if (!state.isControlPanel || state.isLoading || state.showOnboarding) return null;
  return "restore";
}
