import { useState, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { selectResolvedLLMConfig, useSettingsStore } from "../stores/settingsStore";

interface UseNotesOnboardingReturn {
  isComplete: boolean;
  isLLMConfigured: boolean;
  complete: () => void;
}

export function useNotesOnboarding(): UseNotesOnboardingReturn {
  const { useCleanupModel, mode, effectiveModel, remoteUrl } = useSettingsStore(
    useShallow((settings) => {
      const cleanup = selectResolvedLLMConfig(settings, "dictationCleanup");
      return {
        useCleanupModel: settings.useCleanupModel,
        mode: cleanup.mode,
        effectiveModel: cleanup.model,
        remoteUrl: cleanup.remoteUrl ?? "",
      };
    })
  );

  const [isComplete, setIsComplete] = useState(
    () => localStorage.getItem("notesOnboardingComplete") === "true"
  );

  const isLLMConfigured =
    useCleanupModel && (mode === "self-hosted" ? !!remoteUrl.trim() : !!effectiveModel);

  const complete = useCallback(() => {
    localStorage.setItem("notesOnboardingComplete", "true");
    setIsComplete(true);
  }, []);

  return { isComplete, isLLMConfigured, complete };
}
