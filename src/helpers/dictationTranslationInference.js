import {
  resolveDictationTranslationReachability,
  resolveModeDisplayProvider,
  resolveModeProvider,
} from "./dictationRouting.js";

// Shared by live dictation and Prompt Studio so both translation entry points
// use the same runtime, endpoint, and credentials.
export function resolveDictationTranslationInference(settings) {
  const mode = settings.translationMode;
  const model = settings.translationModel?.trim() || "";
  const isSelfHosted = mode === "self-hosted" && !!settings.translationRemoteUrl?.trim();

  return {
    reachable: resolveDictationTranslationReachability({
      useDictationTranslation: settings.useDictationTranslation,
      translationTargetLanguage: settings.translationTargetLanguage,
      translationMode: mode,
      translationModel: model,
      isSelfHostedTranslation: isSelfHosted,
    }),
    model,
    displayProvider: resolveModeDisplayProvider(mode),
    config: {
      inferenceScope: /** @type {const} */ ("dictationTranslation"),
      provider: resolveModeProvider(mode),
      language: settings.translationTargetLanguage,
      lanUrl: isSelfHosted ? settings.translationRemoteUrl : undefined,
      customApiKey: isSelfHosted ? settings.translationCustomApiKey || undefined : undefined,
      disableThinking: settings.translationDisableThinking,
    },
  };
}
