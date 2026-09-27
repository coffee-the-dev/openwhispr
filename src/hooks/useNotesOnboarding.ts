import { useState, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { selectIsCloudCleanupMode, useSettingsStore } from "../stores/settingsStore";

interface UseNotesOnboardingReturn {
  isComplete: boolean;
  isLLMConfigured: boolean;
  complete: () => void;
}

export function useNotesOnboarding(): UseNotesOnboardingReturn {
  const { useCleanupModel, effectiveModel, isCloudCleanup } = useSettingsStore(
    useShallow((settings) => {
      const effective = settings;
      return {
        useCleanupModel: effective.useCleanupModel,
        effectiveModel: effective.cleanupModel,
        isCloudCleanup: selectIsCloudCleanupMode(effective),
      };
    })
  );

  const [isComplete, setIsComplete] = useState(
    () => localStorage.getItem("notesOnboardingComplete") === "true"
  );

  const isLLMConfigured = isCloudCleanup || (useCleanupModel && !!effectiveModel);

  const complete = useCallback(() => {
    localStorage.setItem("notesOnboardingComplete", "true");
    setIsComplete(true);
  }, []);

  return { isComplete, isLLMConfigured, complete };
}
