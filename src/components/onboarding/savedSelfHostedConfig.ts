import { isSelfHostedTranscription } from "../../helpers/selfHostedTranscription.js";
import type { SettingsState } from "../../stores/settingsStore.ts";
import type { OnboardingSelfHostedDraft, OnboardingSelfHostedStepId } from "./flow.ts";

/** The saved settings a self-hosted step reads to reopen on what the user already configured. */
export type SavedSelfHostedSnapshot = Pick<
  SettingsState,
  | "transcriptionMode"
  | "remoteTranscriptionUrl"
  | "remoteTranscriptionModel"
  | "chatAgentMode"
  | "chatAgentModel"
  | "chatAgentRemoteUrl"
>;

/**
 * The server already saved for a self-hosted step, as the draft the step opens on. Null
 * when there is nothing to reopen: a first run, or a scope that runs locally. The draft
 * never carries a key; the step reads keys from the store.
 */
export function resolveSavedSelfHostedDraft(
  stepId: OnboardingSelfHostedStepId,
  settings: SavedSelfHostedSnapshot
): OnboardingSelfHostedDraft | null {
  if (stepId === "self-hosted-assistant") {
    const baseUrl = settings.chatAgentRemoteUrl.trim();
    return settings.chatAgentMode === "self-hosted" && baseUrl
      ? { baseUrl, model: settings.chatAgentModel }
      : null;
  }
  if (!isSelfHostedTranscription(settings)) return null;
  return {
    baseUrl: settings.remoteTranscriptionUrl.trim(),
    model: settings.remoteTranscriptionModel,
  };
}

export function isBlankSelfHostedDraft(draft: OnboardingSelfHostedDraft): boolean {
  return !(draft.baseUrl || draft.model);
}
