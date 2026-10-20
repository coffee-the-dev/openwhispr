const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/dictationRouting.js");

test("voice agent hotkey routes to the agent without a wake word", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: true,
      agentInvoked: false,
      voiceAgentRequested: true,
    }),
    "agent"
  );
});

test("voice agent hotkey never triggers cleanup", async () => {
  const { resolveDictationRouteKind } = await load();

  // Even with the dictation agent unreachable, a voice assistant recording
  // takes the agent route: standalone commands run on the chat scope in the
  // panel, so only selection edits (decided later) need this scope.
  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: false,
      agentInvoked: false,
      voiceAgentRequested: true,
    }),
    "agent"
  );
});

test("voice agent hotkey ignores the wake word state", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      agentReachable: true,
      agentInvoked: true,
      voiceAgentRequested: true,
    }),
    "agent"
  );
});

test("voice agent hotkey wins over translation when both flags are present", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: false,
      agentInvoked: false,
      voiceAgentRequested: true,
      translationRequested: true,
      translationReachable: false,
    }),
    "agent"
  );
});

test("normal dictation with wake word routes to the agent", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: true,
      agentInvoked: true,
      voiceAgentRequested: false,
    }),
    "agent"
  );
});

test("normal dictation without wake word routes to cleanup", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: true,
      agentInvoked: false,
      voiceAgentRequested: false,
    }),
    "cleanup"
  );
});

test("wake word with unreachable agent falls back to cleanup", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: false,
      agentInvoked: true,
      voiceAgentRequested: false,
    }),
    "cleanup"
  );
});

test("skips reasoning when nothing is reachable", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      agentReachable: false,
      agentInvoked: false,
      voiceAgentRequested: false,
    }),
    "skip"
  );
});

test("a local agent is reachable only with a model", async () => {
  const { resolveDictationAgentReachability } = await load();
  const base = { useDictationAgent: true, dictationAgentMode: "local" };

  assert.equal(resolveDictationAgentReachability({ ...base, dictationAgentModel: "" }), false);
  assert.equal(
    resolveDictationAgentReachability({ ...base, dictationAgentModel: "qwen3.5-9b-q4_k_m" }),
    true
  );
});

test("a self-hosted agent is reachable once its server is set, model or not", async () => {
  const { resolveDictationAgentReachability } = await load();
  const base = { useDictationAgent: true, dictationAgentMode: "self-hosted" };

  assert.equal(resolveDictationAgentReachability({ ...base, isSelfHostedAgent: false }), false);
  assert.equal(resolveDictationAgentReachability({ ...base, isSelfHostedAgent: true }), true);
});

test("disabling the dictation agent overrides reachability", async () => {
  const { resolveDictationAgentReachability } = await load();

  assert.equal(
    resolveDictationAgentReachability({
      useDictationAgent: false,
      dictationAgentMode: "self-hosted",
      isSelfHostedAgent: true,
    }),
    false
  );
});

test("a retired mode is never reachable", async () => {
  const { resolveModeReachability } = await load();
  for (const mode of ["openwhispr", "providers", "enterprise", undefined]) {
    assert.equal(resolveModeReachability({ mode, model: "gpt-5", isSelfHosted: true }), false);
  }
});

test("translation hotkey routes to translation when reachable", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: true,
      agentInvoked: false,
      voiceAgentRequested: false,
      translationRequested: true,
      translationReachable: true,
    }),
    "translation"
  );
});

test("translation hotkey ignores the wake word state", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      agentReachable: true,
      agentInvoked: true,
      voiceAgentRequested: false,
      translationRequested: true,
      translationReachable: true,
    }),
    "translation"
  );
});

test("unreachable translation degrades to cleanup, not to the agent", async () => {
  const { resolveDictationRouteKind } = await load();

  // Deliberately different from the voice agent's hard skip: a dictation meant
  // for translation is still a useful dictation, so keep the cleanup.
  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: true,
      agentInvoked: true,
      voiceAgentRequested: false,
      translationRequested: true,
      translationReachable: false,
    }),
    "cleanup"
  );
});

test("unreachable translation with unreachable cleanup skips reasoning", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      agentReachable: true,
      agentInvoked: false,
      voiceAgentRequested: false,
      translationRequested: true,
      translationReachable: false,
    }),
    "skip"
  );
});

test("normal dictation never takes the translation route", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: false,
      agentInvoked: false,
      voiceAgentRequested: false,
      translationRequested: false,
      translationReachable: true,
    }),
    "cleanup"
  );
});

test("translation is unreachable when disabled", async () => {
  const { resolveDictationTranslationReachability } = await load();

  assert.equal(
    resolveDictationTranslationReachability({
      useDictationTranslation: false,
      translationTargetLanguage: "it",
      translationMode: "self-hosted",
      translationModel: "",
      isSelfHostedTranslation: true,
    }),
    false
  );
});

test("translation is unreachable without a target language", async () => {
  const { resolveDictationTranslationReachability } = await load();

  assert.equal(
    resolveDictationTranslationReachability({
      useDictationTranslation: true,
      translationTargetLanguage: "   ",
      translationMode: "self-hosted",
      translationModel: "",
      isSelfHostedTranslation: true,
    }),
    false
  );
});

test("self-hosted translation is reachable without an explicit model", async () => {
  const { resolveDictationTranslationReachability } = await load();

  assert.equal(
    resolveDictationTranslationReachability({
      useDictationTranslation: true,
      translationTargetLanguage: "fr",
      translationMode: "self-hosted",
      translationModel: "",
      isSelfHostedTranslation: true,
    }),
    true
  );
});

test("local translation needs a model", async () => {
  const { resolveDictationTranslationReachability } = await load();
  const base = {
    useDictationTranslation: true,
    translationTargetLanguage: "fr",
    translationMode: "local",
  };

  assert.equal(resolveDictationTranslationReachability({ ...base, translationModel: "" }), false);
  assert.equal(
    resolveDictationTranslationReachability({ ...base, translationModel: "qwen3.5-9b-q4_k_m" }),
    true
  );
});

test("local mode pins the local provider; self-hosted routes by its URL instead", async () => {
  const { resolveModeProvider, resolveModeDisplayProvider } = await load();

  assert.equal(resolveModeProvider("local"), "local");
  assert.equal(resolveModeProvider("self-hosted"), undefined);
  assert.equal(resolveModeDisplayProvider("local"), "local");
  assert.equal(resolveModeDisplayProvider("self-hosted"), "self-hosted");
});

test("a screenshot attaches only to an image-wired provider", async () => {
  const { resolveAgentImageTarget } = await load();

  assert.equal(
    resolveAgentImageTarget({ hasScreenContext: false, providerImageWired: true }),
    false
  );
  assert.equal(
    resolveAgentImageTarget({ hasScreenContext: true, providerImageWired: false }),
    false
  );
  assert.equal(resolveAgentImageTarget({ hasScreenContext: true, providerImageWired: true }), true);
});

test("wake-word language follows the dictation language when it is explicit", async () => {
  const { resolveWakeWordLanguage } = await load();

  assert.equal(resolveWakeWordLanguage({ preferredLanguage: "it", uiLanguage: "en" }, "fr"), "it");
  assert.equal(resolveWakeWordLanguage({ preferredLanguage: "zh-CN", uiLanguage: "en" }), "zh-CN");
});

test("wake-word language uses detected speech before the UI language on auto", async () => {
  const { resolveWakeWordLanguage } = await load();

  assert.equal(
    resolveWakeWordLanguage({ preferredLanguage: "auto", uiLanguage: "it" }, "en"),
    "en"
  );
  assert.equal(resolveWakeWordLanguage({ preferredLanguage: "", uiLanguage: "en" }, "it"), "it");
});

test("wake-word language infers Arabic script before the UI fallback on auto", async () => {
  const { resolveWakeWordLanguage } = await load();

  assert.equal(
    resolveWakeWordLanguage(
      { preferredLanguage: "auto", uiLanguage: "en" },
      undefined,
      "يا Max، لخّص هذه الملاحظة"
    ),
    "ar"
  );
  assert.equal(
    resolveWakeWordLanguage(
      { preferredLanguage: "en", uiLanguage: "ar" },
      undefined,
      "يا Max، summarize this note"
    ),
    "en",
    "an explicit dictation language must remain authoritative"
  );
  assert.equal(
    resolveWakeWordLanguage(
      { preferredLanguage: "auto", uiLanguage: "ar" },
      "en",
      "يا Max، summarize this note"
    ),
    "en",
    "provider detection must remain authoritative"
  );
});

test("wake-word language falls back to the UI language on auto or unset", async () => {
  const { resolveWakeWordLanguage } = await load();

  assert.equal(resolveWakeWordLanguage({ preferredLanguage: "auto", uiLanguage: "it" }), "it");
  assert.equal(resolveWakeWordLanguage({ preferredLanguage: "", uiLanguage: "pt" }), "pt");
  assert.equal(resolveWakeWordLanguage({ preferredLanguage: "  ", uiLanguage: "de" }), "de");
  assert.equal(resolveWakeWordLanguage({ preferredLanguage: undefined, uiLanguage: "fr" }), "fr");
});

test("wake-word language is undefined when no usable hint exists", async () => {
  const { resolveWakeWordLanguage } = await load();

  assert.equal(
    resolveWakeWordLanguage({ preferredLanguage: "auto", uiLanguage: undefined }),
    undefined
  );
  assert.equal(resolveWakeWordLanguage({}), undefined);
});

test("lifecycle input kind prefers assistant, then translation, then dictation", async () => {
  const { resolveLifecycleInputKind } = await load();
  assert.equal(
    resolveLifecycleInputKind({ voiceAgentRequested: true, translationRequested: true }),
    "assistant"
  );
  assert.equal(
    resolveLifecycleInputKind({ voiceAgentRequested: false, translationRequested: true }),
    "translation"
  );
  assert.equal(resolveLifecycleInputKind({}), "dictation");
});

test("an unconfigured cleanup warns once per broken setup, and again once it was fixed", async () => {
  const { cleanupUnconfiguredNotice } = await load();
  const settings = {
    useCleanupModel: true,
    cleanupMode: "providers",
    cleanupProvider: "openai",
    isSignedIn: false,
  };
  const skipped = { skipped: true, cleanupReachable: false, settings };

  const first = cleanupUnconfiguredNotice(null, skipped);
  assert.equal(first.forget, false);
  assert.equal(first.notice.messageKey, "hooks.audioRecording.cleanupUnconfigured");
  assert.equal(first.notice.settingsTarget, "llms");
  assert.equal(first.notice.surface, "llm", "it gets the friendly cleanup toast");

  const shownKey = first.notice.setupKey;
  assert.equal(cleanupUnconfiguredNotice(shownKey, skipped).notice, null);
  const otherProvider = cleanupUnconfiguredNotice(shownKey, {
    ...skipped,
    settings: { ...settings, cleanupProvider: "anthropic" },
  });
  assert.notEqual(otherProvider.notice, null, "a different broken setup warns again");

  // Only a skipped dictation warns; a wake-word command was handled by the agent.
  assert.deepEqual(cleanupUnconfiguredNotice(null, { ...skipped, skipped: false }), {
    forget: false,
    notice: null,
  });

  for (const fixed of [
    { ...skipped, cleanupReachable: true },
    { ...skipped, settings: { ...settings, useCleanupModel: false } },
  ]) {
    assert.deepEqual(cleanupUnconfiguredNotice(shownKey, fixed), { forget: true, notice: null });
  }
});
