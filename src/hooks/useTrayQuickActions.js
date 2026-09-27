import { useEffect } from "react";
import { resolveTrayAssistantAction } from "../helpers/trayActionPolicy";

/**
 * The tray's Ask assistant, answered by the one renderer that can open the panel.
 *
 * The pill's command menu hides the item while a live recording rules it out; the tray always shows it, so this either opens the panel or explains
 * itself through `refuse`. The tray's other two entries need no renderer: listen
 * goes straight to the dictation start, and a meeting starts in the main process.
 */
export function useTrayQuickActions({
  isRecording,
  liveTranscriptMounted,
  closeCommandMenu,
  openAssistantPanel,
  refuse,
}) {
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onOpenAssistantPanel?.(() => {
      closeCommandMenu();
      const decision = resolveTrayAssistantAction({ isRecording, liveTranscriptMounted });
      if (decision.action === "refuse") {
        refuse(decision.messageKey);
        return;
      }
      void openAssistantPanel();
    });
    return () => unsubscribe?.();
  }, [isRecording, liveTranscriptMounted, closeCommandMenu, openAssistantPanel, refuse]);
}
