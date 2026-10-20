import type { SettingsState } from "../stores/settingsStore";

export interface InferenceScopeStoreKeys {
  mode: keyof SettingsState;
  provider: keyof SettingsState;
  model: keyof SettingsState;
  remoteUrl: keyof SettingsState;
  customApiKey: keyof SettingsState;
  disableThinking?: keyof SettingsState;
  toolCalling?: keyof SettingsState;
  acceptsImages?: keyof SettingsState;
  reasoningEffort?: keyof SettingsState;
}

export interface InferenceScopeDefinition {
  storeKeys: InferenceScopeStoreKeys;
  fallbackScope?: string;
}

// Every scope runs on the on-device llama.cpp runtime ("local") or on the
// user's own OpenAI-compatible server ("self-hosted": remoteUrl + optional key).
export const INFERENCE_SCOPES = {
  dictationCleanup: {
    storeKeys: {
      mode: "cleanupMode",
      provider: "cleanupProvider",
      model: "cleanupModel",
      remoteUrl: "cleanupRemoteUrl",
      customApiKey: "cleanupCustomApiKey",
      disableThinking: "cleanupDisableThinking",
      reasoningEffort: "cleanupReasoningEffort",
    },
  },
  dictationAgent: {
    storeKeys: {
      mode: "dictationAgentMode",
      provider: "dictationAgentProvider",
      model: "dictationAgentModel",
      remoteUrl: "dictationAgentRemoteUrl",
      customApiKey: "dictationAgentCustomApiKey",
      disableThinking: "dictationAgentDisableThinking",
      toolCalling: "dictationAgentToolCalling",
      acceptsImages: "dictationAgentAcceptsImages",
      reasoningEffort: "dictationAgentReasoningEffort",
    },
  },
  noteFormatting: {
    storeKeys: {
      mode: "noteFormattingMode",
      provider: "noteFormattingProvider",
      model: "noteFormattingModel",
      remoteUrl: "noteFormattingRemoteUrl",
      customApiKey: "noteFormattingCustomApiKey",
      disableThinking: "noteFormattingDisableThinking",
      reasoningEffort: "noteFormattingReasoningEffort",
    },
    fallbackScope: "dictationCleanup",
  },
  // Runs typed chat conversations (Control Panel, note and container chat).
  // The voice assistant panel's spoken commands, like selection edits, run on
  // dictationAgent — see resolveChatStreamingInference.
  chatIntelligence: {
    storeKeys: {
      mode: "chatAgentMode",
      provider: "chatAgentProvider",
      model: "chatAgentModel",
      remoteUrl: "chatAgentRemoteUrl",
      customApiKey: "chatAgentCustomApiKey",
      disableThinking: "chatAgentDisableThinking",
      toolCalling: "chatAgentToolCalling",
      acceptsImages: "chatAgentAcceptsImages",
      reasoningEffort: "chatAgentReasoningEffort",
    },
  },
  dictationTranslation: {
    storeKeys: {
      mode: "translationMode",
      provider: "translationProvider",
      model: "translationModel",
      remoteUrl: "translationRemoteUrl",
      customApiKey: "translationCustomApiKey",
      disableThinking: "translationDisableThinking",
      reasoningEffort: "translationReasoningEffort",
    },
  },
} as const satisfies Record<string, InferenceScopeDefinition>;

export type InferenceScope = keyof typeof INFERENCE_SCOPES;
