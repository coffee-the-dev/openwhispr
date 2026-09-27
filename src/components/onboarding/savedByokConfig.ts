import { isSelfHostedTranscription } from "../../helpers/selfHostedTranscription.js";
import type { SettingsState } from "../../stores/settingsStore.ts";
import type { OnboardingByokDraft, OnboardingByokStepId } from "./flow.ts";

/** The saved settings a BYOK step reads to reopen on what the user already configured. */
export type SavedByokSnapshot = Pick<
  SettingsState,
  | "transcriptionMode"
  | "remoteTranscriptionUrl"
  | "remoteTranscriptionModel"
  | "chatAgentMode"
  | "chatAgentProvider"
  | "chatAgentModel"
  | "chatAgentRemoteUrl"
>;

export interface SavedByokConfig {
  draft: OnboardingByokDraft;
  /**
   * The saved endpoint authenticates with the step's stored custom API key. False for a
   * hosted provider, whose key belongs to the provider rather than to the endpoint field.
   */
  usesCustomKey: boolean;
}

const hostedConfig = (provider: string, model: string): SavedByokConfig => ({
  draft: { selectedProvider: provider, selectedModel: model, baseUrl: "", customModel: "" },
  usesCustomKey: false,
});

const endpointConfig = (
  baseUrl: string,
  model: string,
  usesCustomKey = false
): SavedByokConfig => ({
  draft: { selectedProvider: "", selectedModel: "", baseUrl, customModel: model },
  usesCustomKey,
});

// Dictation's only endpoint is the self-hosted server, which carries the stored custom key.
function resolveSavedDictation(s: SavedByokSnapshot): SavedByokConfig | null {
  if (!isSelfHostedTranscription(s)) return null;
  return endpointConfig(s.remoteTranscriptionUrl.trim(), s.remoteTranscriptionModel, true);
}

// A Custom provider under "providers" is left out: this step can only save a
// self-hosted endpoint, which would move it to a different URL setting.
function resolveSavedAssistant(s: SavedByokSnapshot): SavedByokConfig | null {
  if (s.chatAgentMode === "self-hosted") {
    // The assistant has one self-hosted route and it carries chatAgentCustomApiKey,
    // so unlike dictation there is no key-less endpoint to tell apart.
    const baseUrl = s.chatAgentRemoteUrl.trim();
    return baseUrl ? endpointConfig(baseUrl, s.chatAgentModel, true) : null;
  }
  if (s.chatAgentMode === "providers" && s.chatAgentProvider && s.chatAgentProvider !== "custom") {
    return hostedConfig(s.chatAgentProvider, s.chatAgentModel);
  }
  return null;
}

/**
 * The provider setup already saved for a BYOK step, as the draft the step opens on. Null
 * when there is nothing to reopen: a first run, local, or a provider this step can't show.
 * The draft never carries a key; the step reads keys from the store.
 */
export function resolveSavedByokConfig(
  stepId: OnboardingByokStepId,
  settings: SavedByokSnapshot
): SavedByokConfig | null {
  return stepId === "byok-assistant"
    ? resolveSavedAssistant(settings)
    : resolveSavedDictation(settings);
}

export function isBlankByokDraft(draft: OnboardingByokDraft): boolean {
  return !(draft.selectedProvider || draft.selectedModel || draft.baseUrl || draft.customModel);
}
