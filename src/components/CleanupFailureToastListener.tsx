import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "./ui/useToast";
import { consumeCleanupFailures, useCleanupFailureStore } from "../stores/cleanupFailureStore";
import { isDictationPanelWindow } from "../utils/windowContext";
import { providerErrorActions, providerErrorToastProps } from "../utils/describeProviderError";

/** Tells the user their dictation went out raw because AI cleanup failed or can't run. */
export default function CleanupFailureToastListener() {
  const { t } = useTranslation();
  const { toast } = useToast();

  const pending = useCleanupFailureStore((s) => s.pending);

  useEffect(() => {
    if (pending === 0) return;
    const state = useCleanupFailureStore.getState();
    const failure = state.lastFailure ?? { message: state.lastMessage };
    // Draining first keeps a re-run of this effect from toasting the same failure twice.
    if (consumeCleanupFailures() === 0) return;
    // Says the raw text was pasted only when it was: a held-back paste keeps its pill.
    const pasted = failure.pasted !== false;
    const pastedLine = pasted ? t("app.toasts.cleanupFailed.description") : "";
    // The panel may already be hidden after dictation; surface it so the toast is seen.
    if (isDictationPanelWindow()) {
      window.electronAPI?.showDictationPanel?.();
    }
    if (failure.surface === "llm") {
      // A classified provider failure: why cleanup failed, then that the raw text went in.
      const { description, actions } = providerErrorToastProps(failure, t);
      toast({
        title: t("app.toasts.cleanupFailed.title"),
        // A line break, not a space, so CJK sentences don't get one after "。".
        description: pastedLine ? `${description}\n${pastedLine}` : description,
        ...(actions ? { actions } : {}),
        variant: "destructive",
        // The dictation has already pasted, so the card can take the pill's place
        // like a transcription failure does.
        ...(pasted && isDictationPanelWindow() ? { presentation: "dictation-error" as const } : {}),
        duration: 10000,
      });
      return;
    }
    const title = failure.messageKey
      ? t(failure.messageKey, failure.messageParams)
      : failure.message || t("app.toasts.cleanupFailed.title");
    // A copy-details action stands in for the technical details block.
    const actions = providerErrorActions(
      { settingsTarget: failure.settingsTarget, technicalDetails: failure.technicalDetails },
      t
    );
    toast({
      title,
      ...(pastedLine ? { secondaryDescription: pastedLine } : {}),
      ...(actions.length ? { actions } : {}),
      variant: "destructive",
      duration: 10000,
    });
  }, [pending, toast, t]);

  return null;
}
