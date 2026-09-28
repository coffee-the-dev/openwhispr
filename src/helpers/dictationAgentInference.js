import {
  resolveAgentImageTarget,
  resolveDictationAgentReachability,
  resolveModeDisplayProvider,
  resolveModeProvider,
} from "./dictationRouting.js";
import { selectResolvedLLMConfig } from "../stores/settingsStore";

// The dictation agent's inference scope, shared by the dictation route in
// audioManager and the Prompt Studio test tab so a prompt test hits the same
// runtime, endpoint and credentials a real dictation does.
//
// Callers must add `systemPrompt` to the config: ReasoningService treats a
// missing one as its cleanup path, which echoes the input back instead of
// running the instruction.
export function resolveDictationAgentInference(settings) {
  const mode = settings.dictationAgentMode;
  const model = settings.dictationAgentModel?.trim() || "";
  const isSelfHosted = mode === "self-hosted" && !!settings.dictationAgentRemoteUrl?.trim();

  return {
    reachable: resolveDictationAgentReachability({
      useDictationAgent: settings.useDictationAgent,
      dictationAgentMode: mode,
      dictationAgentModel: model,
      isSelfHostedAgent: isSelfHosted,
    }),
    model,
    displayProvider: resolveModeDisplayProvider(mode),
    config: {
      inferenceScope: /** @type {const} */ ("dictationAgent"),
      provider: resolveModeProvider(mode),
      lanUrl: isSelfHosted ? settings.dictationAgentRemoteUrl : undefined,
      customApiKey: isSelfHosted ? settings.dictationAgentCustomApiKey || undefined : undefined,
      disableThinking: settings.dictationAgentDisableThinking,
    },
  };
}

/**
 * What a chat conversation streams on, and whether its screenshot rides along.
 *
 * Typed chat surfaces resolve the Chat scope. The voice assistant panel resolves
 * the Voice Assistant scope — the tab that also governs selection edits — so the
 * model picked there answers spoken commands; while that scope is unreachable
 * (assistant toggled off, no model or server configured) the panel falls back
 * to Chat, its previous home.
 *
 * Screenshots follow the dictation route's rule (resolveAgentImageTarget): they
 * attach only where the answering provider is image-wired.
 *
 * `isProviderImageWired` is injected: the provider registry reads Vite env at
 * load, which this helper's callers and tests do not all have.
 *
 * @param {import("../stores/settingsStore").SettingsState} settings
 * @param {{
 *   inferenceScope?: "chatIntelligence" | "dictationAgent",
 *   hasScreenContext?: boolean,
 *   isProviderImageWired?: (providerId: string | undefined) => boolean,
 * }} [options]
 * @returns {{
 *   config: import("../stores/settingsStore").ResolvedLLMConfig,
 *   attachScreenContext: boolean,
 * }}
 */
export function resolveChatStreamingInference(
  settings,
  {
    inferenceScope = "chatIntelligence",
    hasScreenContext = false,
    isProviderImageWired = () => false,
  } = {}
) {
  const onAgentScope =
    inferenceScope === "dictationAgent" && resolveDictationAgentInference(settings).reachable;
  const config = selectResolvedLLMConfig(
    settings,
    onAgentScope ? "dictationAgent" : "chatIntelligence"
  );
  return {
    config,
    attachScreenContext: resolveAgentImageTarget({
      hasScreenContext,
      providerImageWired: isProviderImageWired(config.mode === "self-hosted" ? "lan" : "local"),
    }),
  };
}
