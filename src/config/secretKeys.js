// Single source of truth for the per-scope self-hosted API-key secrets:
// environment.js, ipcHandlers.js and the settings store all derive their
// per-key plumbing from this list, so adding a scope is one entry.
// CommonJS + pure data so both the main process and the Vite renderer share it.
// `base` yields the IPC channels `get-<base>-key` / `save-<base>-key`.
// preload.js can't require local modules under sandbox, so it mirrors the
// {base, get, save} tuples inline — keep SCOPE_KEY_BRIDGES there in sync
// (guarded by test/helpers/secretKeys.test.js).
// Dictation cleanup's key predates this manifest and keeps its bespoke
// accessors (CUSTOM_CLEANUP_API_KEY), as does the transcription server's.
const SCOPE_API_KEYS = [
  {
    base: "note-formatting-custom",
    env: "NOTE_FORMATTING_CUSTOM_API_KEY",
    get: "getNoteFormattingCustomKey",
    save: "saveNoteFormattingCustomKey",
    storeKey: "noteFormattingCustomApiKey",
  },
  {
    base: "translation-custom",
    env: "TRANSLATION_CUSTOM_API_KEY",
    get: "getTranslationCustomKey",
    save: "saveTranslationCustomKey",
    storeKey: "translationCustomApiKey",
  },
  {
    base: "dictation-agent-custom",
    env: "DICTATION_AGENT_CUSTOM_API_KEY",
    get: "getDictationAgentCustomKey",
    save: "saveDictationAgentCustomKey",
    storeKey: "dictationAgentCustomApiKey",
  },
  {
    base: "chat-agent-custom",
    env: "CHAT_AGENT_CUSTOM_API_KEY",
    get: "getChatAgentCustomKey",
    save: "saveChatAgentCustomKey",
    storeKey: "chatAgentCustomApiKey",
  },
];

module.exports = { SCOPE_API_KEYS };
