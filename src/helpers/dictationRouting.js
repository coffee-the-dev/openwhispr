// A scope runs on the on-device runtime once a model is picked, or on the
// user's self-hosted server once its URL is set.
export function resolveModeReachability({ mode, model, isSelfHosted }) {
  if (mode === "self-hosted") return !!isSelfHosted;
  if (mode === "local") return (model?.trim()?.length ?? 0) > 0;
  return false;
}

export function resolveDictationAgentReachability({
  useDictationAgent,
  dictationAgentMode,
  dictationAgentModel,
  isSelfHostedAgent,
}) {
  if (!useDictationAgent) return false;
  return resolveModeReachability({
    mode: dictationAgentMode,
    model: dictationAgentModel,
    isSelfHosted: isSelfHostedAgent,
  });
}

// Whether a captured screenshot rides along with the request. It attaches only
// where the provider's client is wired to send images; dropping the image
// always beats failing the dictation.
export function resolveAgentImageTarget({ hasScreenContext, providerImageWired }) {
  return !!hasScreenContext && !!providerImageWired;
}

export function resolveDictationTranslationReachability({
  useDictationTranslation,
  translationTargetLanguage,
  translationMode,
  translationModel,
  isSelfHostedTranslation,
}) {
  if (!useDictationTranslation) return false;
  if (!translationTargetLanguage?.trim()) return false;
  return resolveModeReachability({
    mode: translationMode,
    model: translationModel,
    isSelfHosted: isSelfHostedTranslation,
  });
}

// The provider a ReasoningService request pins. Self-hosted requests are
// identified by their lanUrl instead, so they carry no provider.
export function resolveModeProvider(mode) {
  return mode === "local" ? "local" : undefined;
}

export function resolveModeDisplayProvider(mode) {
  return mode === "self-hosted" ? "self-hosted" : "local";
}

const ARABIC_SCRIPT_RE = /\p{Script=Arabic}/u;

// Wake-word cues gate on the explicit dictation language, then the language
// detected by STT. Some local and streaming providers do not report their
// auto-detected language, so Arabic script is a deterministic hint before the
// UI language fallback. Explicit and provider-reported languages stay
// authoritative, preventing foreign-language cues from broadening those modes.
export function resolveWakeWordLanguage(
  { preferredLanguage, uiLanguage },
  detectedLanguage,
  transcript
) {
  const language = typeof preferredLanguage === "string" ? preferredLanguage.trim() : "";
  if (language && language.toLowerCase() !== "auto") return language;
  const detected = typeof detectedLanguage === "string" ? detectedLanguage.trim() : "";
  if (detected && detected.toLowerCase() !== "auto") return detected;
  if (typeof transcript === "string" && ARABIC_SCRIPT_RE.test(transcript)) return "ar";
  return typeof uiLanguage === "string" ? uiLanguage : undefined;
}

// The renderer-side source of truth for what the main process gates the Agent
// companion pill on. Assistant wins over translation: a voice-agent request is
// explicit user intent even if a stale translation flag survived.
export function resolveLifecycleInputKind({ voiceAgentRequested, translationRequested }) {
  if (voiceAgentRequested) return "assistant";
  if (translationRequested) return "translation";
  return "dictation";
}

// Decides which reasoning path ("translation" | "agent" | "cleanup" | "skip")
// a finished dictation takes. A recording started via the voice assistant
// hotkey always takes the agent path — no wake word needed, and it wins over
// translation, as in resolveLifecycleInputKind. Standalone commands stream into
// the assistant panel (which resolves the Voice Assistant scope itself and
// reports configuration problems in-conversation), so the dictation
// agent's reachability only gates selection edits — that check happens at the
// selection disposition, not here. A translation recording degrades to
// cleanup instead: the transcript is still a useful dictation without the
// translation step.
export function resolveDictationRouteKind({
  cleanupReachable,
  agentReachable,
  agentInvoked,
  voiceAgentRequested,
  translationRequested,
  translationReachable,
}) {
  if (voiceAgentRequested) {
    return "agent";
  }
  if (translationRequested) {
    if (translationReachable) return "translation";
    return cleanupReachable ? "cleanup" : "skip";
  }
  if (agentReachable && agentInvoked) {
    return "agent";
  }
  if (cleanupReachable) {
    return "cleanup";
  }
  return "skip";
}

// A dictation skipped while cleanup is switched on goes out raw, which looks like
// a cleanup that changed nothing, so it carries a notice. `shownKey` names the
// broken setup the user was last warned about: the same one warns once, while a
// different mode or provider warns again. Once cleanup is off or reachable the
// warning is forgotten (`forget`), so the next broken setup warns.
// The "llm" surface gives it the same friendly cleanup toast as a provider failure.
export function cleanupUnconfiguredNotice(shownKey, { skipped, cleanupReachable, settings }) {
  if (!settings.useCleanupModel || cleanupReachable) return { forget: true, notice: null };
  if (!skipped) return { forget: false, notice: null };
  const setupKey = [settings.cleanupMode || "", settings.cleanupProvider || ""].join("\0");
  if (setupKey === shownKey) return { forget: false, notice: null };
  return {
    forget: false,
    notice: {
      message: "AI cleanup is on, but no cleanup model is set up.",
      messageKey: "hooks.audioRecording.cleanupUnconfigured",
      surface: "llm",
      settingsTarget: "llms",
      setupKey,
    },
  };
}
