import { create } from "zustand";
import i18n, { normalizeUiLanguage } from "../i18n";
import { ensureAgentNameInDictionary } from "../utils/agentName";
import { chooseDictionaryStartupAction } from "../helpers/dictionaryStartup";
import logger from "../utils/logger";
import whisperVadConstants from "../constants/whisperVad.json";
import type {
  ChineseScriptPreference,
  LocalTranscriptionProvider,
  InferenceMode,
  LocalServerPrefs,
  SelfHostedType,
  TranscriptionMode,
} from "../types/electron";
import { normalizeToneStyles, type ToneStyles } from "../config/toneStyle";
import { PROMPT_KIND_LIST, type PromptKind } from "../config/prompts/registry";
import { sweepRetiredPromptOverrides } from "../config/retiredPrompts";
import { buildReasoningScopePatches, inheritsFallbackEndpoint } from "../helpers/reasoningRouting";
import { findStaleLocalModelKeys } from "../helpers/localModelSelections";
import {
  INFERENCE_SCOPES,
  type InferenceScope,
  type InferenceScopeDefinition,
  type InferenceScopeStoreKeys,
} from "../config/inferenceScopes";
import { normalizeChineseScriptPreference } from "../utils/chineseScript";
import modelRegistryData from "../models/modelRegistryData.json";
import type {
  TranscriptionSettings,
  CleanupSettings,
  HotkeySettings,
  OnboardingSettings,
  MicrophoneSettings,
  ApiKeySettings,
  PrivacySettings,
  ThemeSettings,
  ChatAgentSettings,
} from "../hooks/useSettings";
import type { Snippet } from "../utils/snippets";

// Requires localStorage as well as window: the module-scope migrations below
// dereference the bare localStorage global, and test harnesses import this
// store with partial window stubs that don't define it.
const isBrowser = typeof window !== "undefined" && typeof localStorage !== "undefined";

export type TranscriptionContext = "dictation" | "meeting" | "upload";

const localLlmProviderIds = new Set(
  modelRegistryData.localProviders.map((provider) => provider.id)
);

// The default OpenAI base older builds stored for a "Custom" provider nobody
// had pointed anywhere else. It is never adopted as a self-hosted server.
const LEGACY_OPENAI_BASE = "https://api.openai.com/v1";

function isLegacyOpenAIBase(url: string | null | undefined): boolean {
  const trimmed = url?.trim().replace(/\/+$/, "") ?? "";
  return trimmed === LEGACY_OPENAI_BASE;
}

function readString(key: string, fallback: string): string {
  if (!isBrowser) return fallback;
  return localStorage.getItem(key) ?? fallback;
}

// Literal rather than an import from ModelRegistry: ModelRegistry imports this
// store, so importing back would create a require cycle.
const DEFAULT_COHERE_MODEL = "cohere-transcribe-03-2026";

// Anything but an explicit self-hosted choice reads as Local.
function readTranscriptionMode(key: string): TranscriptionMode {
  return readString(key, "local") === "self-hosted" ? "self-hosted" : "local";
}

function readInferenceMode(key: string): InferenceMode {
  return readString(key, "local") === "self-hosted" ? "self-hosted" : "local";
}

export type ToolCallingSetting = "" | "auto" | "on" | "off";

function readToolCallingSetting(key: string): ToolCallingSetting {
  const stored = readString(key, "");
  return stored === "auto" || stored === "on" || stored === "off" ? stored : "";
}

function readLocalProvider(key: string): LocalTranscriptionProvider {
  const stored = readString(key, "whisper");
  return stored === "nvidia" || stored === "cohere" ? stored : "whisper";
}

// Meeting/upload keys defaulted to "whisper" even when never stored, so a
// fresh Parakeet/Cohere install resolved uploads against Whisper `base`.
function readScopedLocalProvider(scopeKey: string): LocalTranscriptionProvider {
  if (isBrowser && localStorage.getItem(scopeKey) === null) {
    return readLocalProvider("localTranscriptionProvider");
  }
  return readLocalProvider(scopeKey);
}

function readBoolean(key: string, fallback: boolean): boolean {
  if (!isBrowser) return fallback;
  const stored = localStorage.getItem(key);
  if (stored === null) return fallback;
  if (fallback === true) return stored !== "false";
  return stored === "true";
}

function readNumber(key: string, fallback: number): number {
  if (!isBrowser) return fallback;
  const parsed = parseInt(localStorage.getItem(key) ?? "", 10);
  return isNaN(parsed) ? fallback : parsed;
}

// Durations offered by the mic warm-hold select; unknown values snap to 0 (off)
// so a hand-edited localStorage entry can never hold the mic open indefinitely.
export const MIC_WARM_HOLD_CHOICES = [0, 10, 60, 900] as const;

function snapMicWarmHold(value: number): number {
  return (MIC_WARM_HOLD_CHOICES as readonly number[]).includes(value) ? value : 0;
}

function readStringArray(key: string, fallback: string[]): string[] {
  if (!isBrowser) return fallback;
  const stored = localStorage.getItem(key);
  if (stored === null) return fallback;
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

type MicrophoneSelectionMode = "system" | "built-in" | "specific";

// `message` is main's translated reason, when it gave one.
export type HotkeyRegistrationResult = { success: boolean; message?: string };

function migrateMicrophoneSelectionMode() {
  if (!isBrowser) return;
  const current = localStorage.getItem("microphoneSelectionMode");
  if (current === "system" || current === "built-in" || current === "specific") return;

  const selectedDeviceId = localStorage.getItem("selectedMicDeviceId") || "";
  const legacyBuiltIn = localStorage.getItem("preferBuiltInMic");
  const mode: MicrophoneSelectionMode =
    legacyBuiltIn === "true"
      ? "built-in"
      : selectedDeviceId && selectedDeviceId !== "default"
        ? "specific"
        : "system";
  localStorage.setItem("microphoneSelectionMode", mode);
}

migrateMicrophoneSelectionMode();

// Settings and account state for features this build no longer has. Dropping
// them keeps stale values (and account identifiers) from lingering in localStorage.
const RETIRED_SETTING_KEYS = [
  "activeWorkspaceId",
  "authenticationSkipped",
  "autoUpdatesEnabled",
  "cloudBackupEnabled",
  "enterpriseSetupMode",
  "enterpriseTranscriptionSetupMode",
  "folderUpdate404Counts",
  "gcalAccounts",
  "gcalPrimaryOnly",
  "insightsSyncEnabled",
  "isSignedIn",
  "lastSyncedAt",
  "mcalAccounts",
  "mcalPrimaryOnly",
  "noteConflicts.clientIds",
  "noteUpdate404Counts",
  "notesStructureIntroVersion",
  "openwhispr:accountScopePurgeRequired",
  "openwhispr:accountScopeUserId",
  "openwhispr:accountScopeValidated",
  "openwhispr:lastSignInTime",
  "openwhispr:usageAccountId",
  "pendingInvitationToken",
  "purgedSpaceIds",
  "purgedTeamIds",
  "signInPromptedAt",
  "skipAuth",
  "teamOnlyPass.emptyStreak",
  "teamOnlyPass.lastAt",
  "teamSpacesCapability",
  "teamSpacesCapability.probedAt",
  "telemetryEnabled",
  "upgradeProDismissed",
];

// Retired keys that carried an account, workspace or sync-kind suffix.
const RETIRED_SETTING_KEY_PREFIXES = [
  "lastSyncedAt.",
  "leaderboardLeavePending:",
  "managedEnterpriseScopes:",
  "workspaces.joinPromptDismissed.",
];

function removeRetiredSettingKeys() {
  if (!isBrowser) return;
  for (const key of RETIRED_SETTING_KEYS) localStorage.removeItem(key);
  const prefixed: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key && RETIRED_SETTING_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      prefixed.push(key);
    }
  }
  for (const key of prefixed) localStorage.removeItem(key);
}

removeRetiredSettingKeys();

const BOOLEAN_SETTINGS = new Set([
  "useLocalWhisper",
  "meetingUseLocalWhisper",
  "uploadUseLocalWhisper",
  "allowLocalFallback",
  "autoGenerateNoteTitle",
  "useCleanupModel",
  "toneStyleEnabled",
  "useDictationAgent",
  "keepLocalModelLoaded",
  "voiceAgentScreenContext",
  "webSearchEnabled",
  "useDictationTranslation",
  "translationDisableThinking",
  "preferBuiltInMic",
  "audioCuesEnabled",
  "pauseMediaOnDictation",
  "floatingIconAutoHide",
  "startMinimized",
  "meetingProcessDetection",
  "speakerDiarizationEnabled",
  "dictationSileroEnabled",
  "noteRecordingSileroEnabled",
  "meetingSileroEnabled",
  "meetingAecEnabled",
  "autoPasteEnabled",
  "keepTranscriptionInClipboard",
  "dataRetentionEnabled",
  "saveDiscardedTranscriptions",
  "noteFilesEnabled",
  "noteFilesExportDictations",
  "showTranscriptionPreview",
  "cleanupDisableThinking",
  "dictationAgentDisableThinking",
  "noteFormattingDisableThinking",
  "chatAgentDisableThinking",
  "dictationAgentAcceptsImages",
  "chatAgentAcceptsImages",
  "notificationsEnabled",
  "notifyMeetingDetection",
  "notifyCalendarReminders",
  "appleCalendarConnected",
]);

const ARRAY_SETTINGS = new Set([
  "customDictionary",
  "snippets",
  "onboardingUseCases",
  "spokenLanguages",
  "translationTargets",
]);

const NUMERIC_SETTINGS = new Set([
  "micWarmHoldSeconds",
  "audioRetentionDays",
  "meetingAudioRetentionDays",
  "transcriptRetentionDays",
  "whisperVadThreshold",
  "whisperVadMinSpeechDurationMs",
  "whisperVadMinSilenceDurationMs",
  "whisperVadMaxSpeechDurationS",
  "whisperVadSpeechPadMs",
  "whisperVadSamplesOverlap",
]);

const WHISPER_VAD_DEFAULTS = whisperVadConstants.DEFAULTS;
const WHISPER_VAD_LIMITS = whisperVadConstants.LIMITS;

type WhisperVadKey = keyof typeof WHISPER_VAD_DEFAULTS;

const clampVadValue = (key: WhisperVadKey, raw: unknown): number => {
  const fallback = WHISPER_VAD_DEFAULTS[key];
  const n = raw === null || raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const { min, max, round } = WHISPER_VAD_LIMITS[key];
  const clamped = Math.min(max, Math.max(min, n));
  return round ? Math.round(clamped) : clamped;
};

const LANGUAGE_MIGRATIONS: Record<string, string> = { zh: "zh-CN" };

function migratePreferredLanguage() {
  if (!isBrowser) return;
  const stored = localStorage.getItem("preferredLanguage");
  if (stored && LANGUAGE_MIGRATIONS[stored]) {
    localStorage.setItem("preferredLanguage", LANGUAGE_MIGRATIONS[stored]);
  }
}

migratePreferredLanguage();

// Map the underlying transcription fields to the InferenceMode the Settings
// tabs select on. Single source of truth shared by the provider-settings
// migration and the onboarding "use this provider everywhere" action.
function deriveTranscriptionMode(
  useLocalWhisper: boolean,
  cloudTranscriptionMode: string | null,
  cloudTranscriptionProvider: string | null
): string {
  if (useLocalWhisper) return "local";
  if (cloudTranscriptionMode === "byok") {
    return cloudTranscriptionProvider === "custom" ? "self-hosted" : "providers";
  }
  return "openwhispr";
}

// Map the legacy `cloudReasoningMode` + provider pair to the mode the Settings
// tabs selected on before this build. Shared by the provider-settings and
// agent-mode migrations and by healSkippedMeetingFollowModes();
// migrateInferenceScopesToLocalOnly() then settles every legacy mode.
function deriveLegacyReasoningMode(cloudMode: string | null, provider: string | null): string {
  if (cloudMode !== "byok") return "openwhispr";
  if (provider === "custom") return "self-hosted";
  if (provider === "bedrock" || provider === "azure" || provider === "vertex") {
    return "enterprise";
  }
  if (provider && localLlmProviderIds.has(provider)) return "local";
  return "providers";
}

function migrateProviderSettings() {
  if (!isBrowser) return;
  if (localStorage.getItem("_providerSettingsMigrated") === "1") return;

  const cloudMode = localStorage.getItem("cloudTranscriptionMode");
  const useLocal = localStorage.getItem("useLocalWhisper") === "true";
  const provider = localStorage.getItem("cloudTranscriptionProvider");

  const transcriptionMode = deriveTranscriptionMode(useLocal, cloudMode, provider);
  localStorage.setItem("transcriptionMode", transcriptionMode);

  if (provider === "custom" && cloudMode === "byok") {
    localStorage.setItem("remoteTranscriptionType", "openai-compatible");
    const legacyBaseUrl = localStorage.getItem("cloudTranscriptionBaseUrl");
    const existingRemoteUrl = localStorage.getItem("remoteTranscriptionUrl");
    if (!existingRemoteUrl && legacyBaseUrl && !isLegacyOpenAIBase(legacyBaseUrl)) {
      localStorage.setItem("remoteTranscriptionUrl", legacyBaseUrl);
    }
  }

  const reasoningMode = localStorage.getItem("cloudReasoningMode");
  const reasoningProvider = localStorage.getItem("reasoningProvider");
  localStorage.setItem(
    "reasoningMode",
    deriveLegacyReasoningMode(reasoningMode, reasoningProvider)
  );

  if (reasoningProvider === "custom" && reasoningMode === "byok") {
    localStorage.setItem("remoteReasoningType", "openai-compatible");
  }

  localStorage.setItem("_providerSettingsMigrated", "1");
}

migrateProviderSettings();

// One-time migration for legacy `meetingFollows{Transcription,Reasoning}` flags.
// When the flag was true (the default), meeting/note recordings inherited the
// main dictation/intelligence settings. We've removed the toggle; copy the
// effective values into the dedicated meeting fields so post-migration reads
// (which always go through meeting fields) preserve every existing user's
// behavior. After migration the flag stays at "false" as a marker so this
// never runs again. Safe to delete after a few releases.
const MEETING_TRANSCRIPTION_PAIRS: ReadonlyArray<[string, string]> = [
  ["useLocalWhisper", "meetingUseLocalWhisper"],
  ["whisperModel", "meetingWhisperModel"],
  ["localTranscriptionProvider", "meetingLocalTranscriptionProvider"],
  ["parakeetModel", "meetingParakeetModel"],
  ["cohereModel", "meetingCohereModel"],
  ["cloudTranscriptionProvider", "meetingCloudTranscriptionProvider"],
  ["cloudTranscriptionModel", "meetingCloudTranscriptionModel"],
  ["cloudTranscriptionBaseUrl", "meetingCloudTranscriptionBaseUrl"],
  ["cloudTranscriptionMode", "meetingCloudTranscriptionMode"],
  ["transcriptionMode", "meetingTranscriptionMode"],
  ["remoteTranscriptionType", "meetingRemoteTranscriptionType"],
  ["remoteTranscriptionUrl", "meetingRemoteTranscriptionUrl"],
];
const MEETING_REASONING_PAIRS: ReadonlyArray<[string, string]> = [
  ["reasoningProvider", "meetingReasoningProvider"],
  ["reasoningModel", "meetingReasoningModel"],
  ["reasoningMode", "meetingReasoningMode"],
  ["cloudReasoningMode", "meetingCloudReasoningMode"],
  ["cloudReasoningBaseUrl", "meetingCloudReasoningBaseUrl"],
  ["remoteReasoningType", "meetingRemoteReasoningType"],
  ["remoteReasoningUrl", "meetingRemoteReasoningUrl"],
];

function migrateMeetingFollowFlags() {
  if (!isBrowser) return;
  for (const [flag, pairs] of [
    ["meetingFollowsTranscription", MEETING_TRANSCRIPTION_PAIRS],
    ["meetingFollowsReasoning", MEETING_REASONING_PAIRS],
  ] as const) {
    if (localStorage.getItem(flag) === "false") continue;
    for (const [src, dst] of pairs) {
      const v = localStorage.getItem(src);
      if (v !== null) localStorage.setItem(dst, v);
    }
    localStorage.setItem(flag, "false");
  }
}

// Runs after migrateProviderSettings() so the mode keys it derives and persists
// (`transcriptionMode`, `reasoningMode`, the `remote*` keys) exist to be copied.
// Before 1.10.0 it ran first, skipped those pairs, and latched — see
// healSkippedMeetingFollowModes() for the profiles that already did.
migrateMeetingFollowFlags();

// One-time seed of the dedicated audio-upload transcription settings. Runs
// after migrateProviderSettings() so the `transcriptionMode` it derives and
// persists is available to copy. Before this context existed the upload page
// used the base dictation settings, so copy each value the user actually set
// into the matching `upload*` key. Fresh installs have no base keys persisted,
// so nothing is copied and the upload context falls through to its OpenWhispr
// Cloud defaults.
const UPLOAD_TRANSCRIPTION_PAIRS: ReadonlyArray<[string, string]> = [
  ["useLocalWhisper", "uploadUseLocalWhisper"],
  ["whisperModel", "uploadWhisperModel"],
  ["localTranscriptionProvider", "uploadLocalTranscriptionProvider"],
  ["parakeetModel", "uploadParakeetModel"],
  ["cohereModel", "uploadCohereModel"],
  ["cloudTranscriptionProvider", "uploadCloudTranscriptionProvider"],
  ["cloudTranscriptionModel", "uploadCloudTranscriptionModel"],
  ["cloudTranscriptionBaseUrl", "uploadCloudTranscriptionBaseUrl"],
  ["cloudTranscriptionMode", "uploadCloudTranscriptionMode"],
  ["transcriptionMode", "uploadTranscriptionMode"],
];

function migrateUploadTranscription() {
  if (!isBrowser) return;
  if (localStorage.getItem("uploadTranscriptionMigrated") === "true") return;
  for (const [src, dst] of UPLOAD_TRANSCRIPTION_PAIRS) {
    const v = localStorage.getItem(src);
    if (v !== null) localStorage.setItem(dst, v);
  }
  localStorage.setItem("uploadTranscriptionMigrated", "true");
}

migrateUploadTranscription();

// One-time seed of the upload self-hosted server. These keys arrived after
// migrateUploadTranscription() had latched (1.7.3), and until then the Upload
// tab edited dictation's server (#2049), so copy the values a profile has been
// uploading with; the tab then shows the server it actually uses. Fresh installs
// have nothing to copy, and an upload key the user already set is kept.
const UPLOAD_SELF_HOSTED_PAIRS: ReadonlyArray<[string, string]> = [
  ["remoteTranscriptionUrl", "uploadRemoteTranscriptionUrl"],
  ["remoteTranscriptionModel", "uploadRemoteTranscriptionModel"],
];

function migrateUploadSelfHosted() {
  if (!isBrowser) return;
  if (localStorage.getItem("uploadSelfHostedMigrated") === "true") return;
  for (const [src, dst] of UPLOAD_SELF_HOSTED_PAIRS) {
    if (localStorage.getItem(dst) !== null) continue;
    const v = localStorage.getItem(src);
    if (v !== null) localStorage.setItem(dst, v);
  }
  localStorage.setItem("uploadSelfHostedMigrated", "true");
}

migrateUploadSelfHosted();

// Dictation and upload render `*TranscriptionMode` in their picker but route
// on `*UseLocalWhisper` (audioManager, fileTranscription), so a Local mode whose
// flag disagrees would upload to the self-hosted server the user switched away
// from (#2086). Must run after the upload one-shot copy, which mirrors the
// dictation keys desync-and-all and then latches. Never complete the rule
// symmetrically: a mode-less toggle wrote the local flag alone until 6fb0c906.
const TRANSCRIPTION_ROUTING_KEYS: ReadonlyArray<{ mode: string; useLocal: string }> = [
  { mode: "transcriptionMode", useLocal: "useLocalWhisper" },
  { mode: "uploadTranscriptionMode", useLocal: "uploadUseLocalWhisper" },
];

function reconcileTranscriptionRouting(): void {
  if (!isBrowser) return;
  const repaired: string[] = [];
  for (const keys of TRANSCRIPTION_ROUTING_KEYS) {
    if (
      localStorage.getItem(keys.mode) === "local" &&
      localStorage.getItem(keys.useLocal) !== "true"
    ) {
      localStorage.setItem(keys.useLocal, "true");
      repaired.push(keys.useLocal);
    }
  }
  if (repaired.length === 0) return;

  logger.info(
    "Repaired transcription routing that disagreed with the selected mode",
    { keys: repaired },
    "settings"
  );
}

reconcileTranscriptionRouting();

function migrateAgentMode() {
  if (!isBrowser) return;
  if (localStorage.getItem("_agentModeMigrated") === "1") return;

  localStorage.setItem(
    "agentInferenceMode",
    deriveLegacyReasoningMode(
      localStorage.getItem("cloudAgentMode"),
      localStorage.getItem("agentProvider")
    )
  );

  localStorage.setItem("_agentModeMigrated", "1");
}

migrateAgentMode();

function migrateCustomPrompts() {
  if (!isBrowser) return;
  if (localStorage.getItem("_promptsMigrated") === "1") return;

  const legacyUnified = localStorage.getItem("customUnifiedPrompt");
  if (legacyUnified) {
    try {
      const parsed = JSON.parse(legacyUnified);
      if (typeof parsed === "string" && parsed.length > 0) {
        if (!localStorage.getItem("customPrompt.cleanup")) {
          localStorage.setItem("customPrompt.cleanup", parsed);
        }
        if (!localStorage.getItem("customPrompt.dictationAgent")) {
          localStorage.setItem("customPrompt.dictationAgent", parsed);
        }
      }
    } catch {}
    localStorage.removeItem("customUnifiedPrompt");
  }

  const legacyChat = localStorage.getItem("agentSystemPrompt");
  if (legacyChat && legacyChat.length > 0 && !localStorage.getItem("customPrompt.chatAgent")) {
    localStorage.setItem("customPrompt.chatAgent", legacyChat);
  }
  if (legacyChat !== null) localStorage.removeItem("agentSystemPrompt");

  localStorage.setItem("_promptsMigrated", "1");
}

migrateCustomPrompts();

// Overrides that byte-match a retired shipped default were persisted defaults,
// not user customizations; clear them so current defaults apply again.
function sweepRetiredCustomPrompts() {
  if (!isBrowser) return;
  void sweepRetiredPromptOverrides(localStorage, PROMPT_KIND_LIST)
    .then((swept) => {
      if (swept.length === 0) return;
      useSettingsStore.setState((s) => ({
        customPrompts: {
          ...s.customPrompts,
          ...Object.fromEntries(swept.map((kind) => [kind, ""])),
        },
      }));
      logger.info("Cleared retired default prompt overrides", { kinds: swept }, "settings");
    })
    .catch((error) => {
      logger.warn(
        "Retired prompt sweep failed",
        { error: error instanceof Error ? error.message : String(error) },
        "settings"
      );
    });
}

sweepRetiredCustomPrompts();

// One-time migration of legacy LLM-scope localStorage keys. Safe to delete
// after a few releases.
const LLM_SCOPE_KEY_PAIRS: ReadonlyArray<[string, string]> = [
  ["reasoningModel", "cleanupModel"],
  ["reasoningProvider", "cleanupProvider"],
  ["reasoningMode", "cleanupMode"],
  ["useReasoningModel", "useCleanupModel"],
  ["cloudReasoningMode", "cleanupCloudMode"],
  ["cloudReasoningBaseUrl", "cleanupCloudBaseUrl"],
  ["customReasoningApiKey", "cleanupCustomApiKey"],
  ["remoteReasoningUrl", "cleanupRemoteUrl"],
  ["meetingReasoningMode", "noteFormattingMode"],
  ["meetingReasoningProvider", "noteFormattingProvider"],
  ["meetingReasoningModel", "noteFormattingModel"],
  ["meetingCloudReasoningMode", "noteFormattingCloudMode"],
  ["meetingCloudReasoningBaseUrl", "noteFormattingCloudBaseUrl"],
  ["meetingRemoteReasoningUrl", "noteFormattingRemoteUrl"],
  ["agentInferenceMode", "chatAgentMode"],
  ["agentProvider", "chatAgentProvider"],
  ["agentModel", "chatAgentModel"],
  ["cloudAgentMode", "chatAgentCloudMode"],
  ["remoteAgentUrl", "chatAgentRemoteUrl"],
];

function migrateLLMScopeKeys() {
  if (!isBrowser) return;
  if (localStorage.getItem("_llmScopeKeysMigrated") === "1") return;

  for (const [oldKey, newKey] of LLM_SCOPE_KEY_PAIRS) {
    const value = localStorage.getItem(oldKey);
    if (value === null) continue;
    if (localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, value);
    }
    localStorage.removeItem(oldKey);
  }

  localStorage.setItem("_llmScopeKeysMigrated", "1");
}

migrateLLMScopeKeys();

// The Voice Assistant scope shipped unseeded — empty provider and model, mode
// defaulting to cloud — while the assistant panel answered on the Chat scope.
// The panel now answers on the Voice Assistant scope, so a profile that never
// configured it (no onboarding fan-out or Settings edit wrote its mode,
// provider or model) copies the Chat scope over once; otherwise a signed-in
// profile whose Chat runs local or BYOK would have its spoken commands move to
// the cloud default silently. The scope's custom key is a secret, so
// initializeSettings copies it once the secure store has loaded.
const SEEDED_SCOPE_KEYS: ReadonlyArray<[string, string]> = [
  ["chatAgentMode", "dictationAgentMode"],
  ["chatAgentProvider", "dictationAgentProvider"],
  ["chatAgentModel", "dictationAgentModel"],
  ["chatAgentCloudMode", "dictationAgentCloudMode"],
  ["chatAgentCloudBaseUrl", "dictationAgentCloudBaseUrl"],
  ["chatAgentRemoteUrl", "dictationAgentRemoteUrl"],
];

function seedDictationAgentScopeFromChat() {
  if (!isBrowser) return;
  if (localStorage.getItem("_dictationAgentSeeded") !== null) return;

  const agent = INFERENCE_SCOPES.dictationAgent.storeKeys;
  const configured = [agent.mode, agent.provider, agent.model].some(
    (key) => localStorage.getItem(key) !== null
  );
  if (configured) {
    localStorage.setItem("_dictationAgentSeeded", "1");
    return;
  }
  for (const [chatKey, agentKey] of SEEDED_SCOPE_KEYS) {
    const value = localStorage.getItem(chatKey);
    if (value !== null) localStorage.setItem(agentKey, value);
  }
  localStorage.setItem("_dictationAgentSeeded", "key-pending");
}

seedDictationAgentScopeFromChat();

// Builds before 1.10.0 ran migrateMeetingFollowFlags() before
// migrateProviderSettings() had created `transcriptionMode` / `reasoningMode`,
// so a profile upgrading straight from ≤1.6.7 copied every Note Recording key
// except the two modes and then latched the follow flags.
//
// The two modes fail differently when absent, so they are healed differently.
// `meetingTranscriptionMode` has no fallback: selectResolvedMeetingTranscription
// passes it straight through and the store default sends note recordings to
// OpenWhispr Cloud, so every mode is reconstructed from the snapshot the copy
// did write — with the same functions migrateProviderSettings() uses, not from
// today's dictation keys, which the user may have changed since.
// `noteFormattingMode` does have one: an absent mode follows dictation cleanup
// (migrateInferenceScopesToLocalOnly), so the only cohort at risk is one whose
// reasoning snapshot was local and whose cleanup has since moved elsewhere. So
// that mode is healed local-ward only.
//
// Runs after migrateLLMScopeKeys() so a pre-1.7.0 profile's reasoning snapshot
// is under its final `noteFormatting*` names. `noteFormattingCloudMode` is the
// reasoning-side signal: the scope editor can write the provider alone but only
// ever writes cloudMode together with mode. Idempotent — writing a mode retires
// its own guard — and it never touches `meetingUseLocalWhisper`, which no router
// reads but which rule two below depends on.
function healSkippedMeetingFollowModes(): Record<string, string> {
  if (!isBrowser) return {};
  const healed: Record<string, string> = {};

  const meetingUseLocal = localStorage.getItem("meetingUseLocalWhisper");
  const meetingCloudMode = localStorage.getItem("meetingCloudTranscriptionMode");
  if (
    localStorage.getItem("meetingTranscriptionMode") === null &&
    (meetingUseLocal !== null || meetingCloudMode !== null)
  ) {
    const mode = deriveTranscriptionMode(
      meetingUseLocal === "true",
      meetingCloudMode,
      localStorage.getItem("meetingCloudTranscriptionProvider")
    );
    localStorage.setItem("meetingTranscriptionMode", mode);
    healed.meetingTranscriptionMode = mode;
  }

  // v1.6.8–v1.6.9's since-removed mode-less toggle wrote `useLocalWhisper` alone,
  // so a deliberate Local choice could sit under a stale cloud mode; v1.6.10's
  // wholesale copy carried both into Note Recording, where the mode is what
  // routes. The UI writes the flag as `mode === "local"`, so this pair can only
  // be that copy. Follow the flag — local-ward only.
  const meetingMode = localStorage.getItem("meetingTranscriptionMode");
  if (meetingUseLocal === "true" && meetingMode !== null && meetingMode !== "local") {
    localStorage.setItem("meetingTranscriptionMode", "local");
    healed.meetingTranscriptionMode = "local";
  }

  const noteFormattingCloudMode = localStorage.getItem("noteFormattingCloudMode");
  if (localStorage.getItem("noteFormattingMode") === null && noteFormattingCloudMode !== null) {
    const mode = deriveLegacyReasoningMode(
      noteFormattingCloudMode,
      localStorage.getItem("noteFormattingProvider")
    );
    // Local-ward only — see the header. Any other snapshot is left absent so
    // note formatting keeps following dictation cleanup, as it does today.
    if (mode === "local") {
      localStorage.setItem("noteFormattingMode", mode);
      healed.noteFormattingMode = mode;
    }
  }

  return healed;
}

const healedMeetingFollowModes = healSkippedMeetingFollowModes();
if (Object.keys(healedMeetingFollowModes).length > 0) {
  logger.info(
    "Re-derived Note Recording modes the follow-flag migration had skipped",
    healedMeetingFollowModes,
    "settings"
  );
}

// One-time move off OpenWhispr Cloud, enterprise and third-party transcription:
// this build runs on-device or against the user's own self-hosted server only.
// Cloud and enterprise selections go local. A provider selection goes to the
// scope's self-hosted server when one is configured (a Custom provider's base
// URL counts), else local. Runs over the keys every earlier migration has
// settled. Fresh installs have nothing persisted and read the local defaults.
const LOCAL_ONLY_MODES_MIGRATED_KEY = "_localOnlyModesMigrated";

const LOCAL_ONLY_TRANSCRIPTION_KEYS: ReadonlyArray<{
  mode: string;
  useLocal: string;
  provider: string;
  baseUrl: string;
  // Note Recording had no server of its own to move to, so it goes local.
  remoteUrl: string | null;
}> = [
  {
    mode: "transcriptionMode",
    useLocal: "useLocalWhisper",
    provider: "cloudTranscriptionProvider",
    baseUrl: "cloudTranscriptionBaseUrl",
    remoteUrl: "remoteTranscriptionUrl",
  },
  {
    mode: "meetingTranscriptionMode",
    useLocal: "meetingUseLocalWhisper",
    provider: "meetingCloudTranscriptionProvider",
    baseUrl: "meetingCloudTranscriptionBaseUrl",
    remoteUrl: null,
  },
  {
    mode: "uploadTranscriptionMode",
    useLocal: "uploadUseLocalWhisper",
    provider: "uploadCloudTranscriptionProvider",
    baseUrl: "uploadCloudTranscriptionBaseUrl",
    remoteUrl: "uploadRemoteTranscriptionUrl",
  },
];

function selfHostedUrlFor(
  remoteUrl: string | null,
  provider: string | null,
  baseUrl: string | null
): string {
  const configured = remoteUrl?.trim();
  if (configured) return configured;
  if (provider !== "custom" || isLegacyOpenAIBase(baseUrl)) return "";
  return baseUrl?.trim() ?? "";
}

function migrateTranscriptionToLocalOnly(storage: Storage): void {
  if (storage.getItem(LOCAL_ONLY_MODES_MIGRATED_KEY) === "1") return;
  const get = (key: string) => storage.getItem(key);

  for (const keys of LOCAL_ONLY_TRANSCRIPTION_KEYS) {
    const mode = storage.getItem(keys.mode);
    let target: TranscriptionMode | null = null;
    if (mode === "openwhispr" || mode === "enterprise") target = "local";
    if (mode === "providers") {
      const provider = get(keys.provider) || get("cloudTranscriptionProvider");
      const url = keys.remoteUrl
        ? selfHostedUrlFor(get(keys.remoteUrl), provider, get(keys.baseUrl))
        : "";
      target = url ? "self-hosted" : "local";
      if (url && keys.remoteUrl && !get(keys.remoteUrl)?.trim())
        storage.setItem(keys.remoteUrl, url);
    }
    if (target) storage.setItem(keys.mode, target);
    if ((target ?? mode) === "local") storage.setItem(keys.useLocal, "true");
    if (target === "self-hosted") storage.setItem(keys.useLocal, "false");
  }

  storage.setItem(LOCAL_ONLY_MODES_MIGRATED_KEY, "1");
}

// The keys older builds routed each LLM scope's OpenWhispr Cloud and provider
// choices on. Read only here, to settle a leftover mode, then retired.
const LEGACY_SCOPE_BASE_URL_KEYS: Record<InferenceScope, string> = {
  dictationCleanup: "cleanupCloudBaseUrl",
  dictationAgent: "dictationAgentCloudBaseUrl",
  noteFormatting: "noteFormattingCloudBaseUrl",
  chatIntelligence: "chatAgentCloudBaseUrl",
  dictationTranslation: "translationCloudBaseUrl",
};

// Every LLM scope runs local or self-hosted. A scope left on OpenWhispr Cloud,
// enterprise or a provider (by an older build, or by the provider picker that
// shipped after the transcription move) is settled here on every launch, so it
// needs no latch: a provider selection goes to the scope's self-hosted server
// when one is configured (a Custom provider's base URL counts), anything else
// goes local. A local scope forgets a model the local catalog doesn't own, and
// a scope that follows another one keeps following it wherever it went.
export function migrateInferenceScopesToLocalOnly(storage: Storage): void {
  const get = (key: string) => storage.getItem(key);
  const finalModes: Partial<Record<InferenceScope, string>> = {};

  for (const scope of Object.keys(INFERENCE_SCOPES) as InferenceScope[]) {
    const definition: InferenceScopeDefinition = INFERENCE_SCOPES[scope];
    const keys = definition.storeKeys;
    const mode = get(keys.mode);
    const provider = get(keys.provider) ?? "";

    if (mode === "local" || mode === "self-hosted") {
      if (mode === "local" && provider && !localLlmProviderIds.has(provider)) {
        storage.setItem(keys.provider, "");
        storage.setItem(keys.model, "");
      }
      if (mode === "self-hosted" && provider !== "lan") storage.setItem(keys.provider, "lan");
      finalModes[scope] = mode;
      continue;
    }

    let target = "local";
    if (mode === "providers") {
      const url = selfHostedUrlFor(
        get(keys.remoteUrl),
        provider,
        get(LEGACY_SCOPE_BASE_URL_KEYS[scope])
      );
      if (url) {
        target = "self-hosted";
        if (!get(keys.remoteUrl)?.trim()) storage.setItem(keys.remoteUrl, url);
      }
    }

    const fallback = definition.fallbackScope
      ? finalModes[definition.fallbackScope as InferenceScope]
      : undefined;
    if (target === "local" && !localLlmProviderIds.has(provider)) {
      // The picker asks again rather than pointing at a missing model.
      if (fallback) target = fallback;
      storage.setItem(keys.provider, "");
      storage.setItem(keys.model, "");
    } else if (target === "self-hosted") {
      storage.setItem(keys.provider, "lan");
    }

    storage.setItem(keys.mode, target);
    finalModes[scope] = target;
  }
}

if (isBrowser) {
  migrateTranscriptionToLocalOnly(localStorage);
  migrateInferenceScopesToLocalOnly(localStorage);
}

// Cloud, enterprise and third-party settings. Removed only after every
// migration above has read them to settle each scope's mode.
const RETIRED_PROVIDER_KEYS = [
  "allowOpenAIFallback",
  "assemblyAiStreaming",
  "azureApiVersion",
  "azureDeploymentName",
  "azureEndpoint",
  "bedrockAuthMode",
  "bedrockProfile",
  "bedrockRegion",
  "chatAgentCloudBaseUrl",
  "chatAgentCloudMode",
  "cleanupCloudBaseUrl",
  "cleanupCloudMode",
  "cloudTranscriptionBaseUrl",
  "cloudTranscriptionMode",
  "cloudTranscriptionModel",
  "cloudTranscriptionProvider",
  "cortiEnvironment",
  "cortiTenant",
  "dictationAgentCloudBaseUrl",
  "dictationAgentCloudMode",
  "dictationAgentVisionCloudBaseUrl",
  "dictationAgentVisionCloudMode",
  "dictationAgentVisionMode",
  "dictationAgentVisionModel",
  "dictationAgentVisionProvider",
  "meetingCloudTranscriptionBaseUrl",
  "meetingCloudTranscriptionMode",
  "meetingCloudTranscriptionModel",
  "meetingCloudTranscriptionProvider",
  "noteFormattingCloudBaseUrl",
  "noteFormattingCloudMode",
  "openAiEndpointPreference",
  "reasoningModelByProvider",
  "tinfoilModels",
  "transcriptionModelByProvider",
  "translationCloudBaseUrl",
  "translationCloudMode",
  "uploadCloudTranscriptionBaseUrl",
  "uploadCloudTranscriptionMode",
  "uploadCloudTranscriptionModel",
  "uploadCloudTranscriptionProvider",
  "vertexAuthMode",
  "vertexLocation",
  "vertexProject",
];

if (isBrowser) {
  for (const key of RETIRED_PROVIDER_KEYS) localStorage.removeItem(key);
}

/** One runtime choice for every LLM scope, as onboarding applies it. */
export interface ReasoningSelection {
  mode: InferenceMode;
  provider?: string;
  model?: string;
  remoteUrl?: string;
  customApiKey?: string;
}

export interface SettingsState
  extends
    TranscriptionSettings,
    CleanupSettings,
    HotkeySettings,
    OnboardingSettings,
    MicrophoneSettings,
    ApiKeySettings,
    PrivacySettings,
    ThemeSettings,
    ChatAgentSettings {
  audioCuesEnabled: boolean;
  pauseMediaOnDictation: boolean;
  floatingIconAutoHide: boolean;
  startMinimized: boolean;
  notificationsEnabled: boolean;
  notifyMeetingDetection: boolean;
  notifyCalendarReminders: boolean;
  appleCalendarConnected: boolean;
  meetingProcessDetection: boolean;
  speakerDiarizationEnabled: boolean;
  diarizationMode: TranscriptionMode;
  diarizationRemoteUrl: string;
  dictationSileroEnabled: boolean;
  noteRecordingSileroEnabled: boolean;
  meetingSileroEnabled: boolean;
  meetingAecEnabled: boolean;
  whisperVadThreshold: number;
  whisperVadMinSpeechDurationMs: number;
  whisperVadMinSilenceDurationMs: number;
  whisperVadMaxSpeechDurationS: number;
  whisperVadSpeechPadMs: number;
  whisperVadSamplesOverlap: number;
  panelStartPosition: "bottom-right" | "center" | "bottom-left";
  showTranscriptionPreview: boolean;
  autoPasteEnabled: boolean;
  keepTranscriptionInClipboard: boolean;
  noteFilesEnabled: boolean;
  noteFilesPath: string;
  noteFilesBaseTag: string;
  noteFilesExportDictations: boolean;
  /** The note owner's name, given to note generation in place of "You". */
  userName: string;

  transcriptionMode: TranscriptionMode;
  remoteTranscriptionType: SelfHostedType;
  remoteTranscriptionUrl: string;
  remoteTranscriptionModel: string;
  cleanupMode: InferenceMode;
  cleanupRemoteUrl: string;
  keepLocalModelLoaded: boolean;

  meetingTranscriptionMode: TranscriptionMode;
  meetingUseLocalWhisper: boolean;
  meetingWhisperModel: string;
  meetingLocalTranscriptionProvider: LocalTranscriptionProvider;
  meetingParakeetModel: string;
  meetingCohereModel: string;
  meetingRemoteTranscriptionType: SelfHostedType;
  meetingRemoteTranscriptionUrl: string;
  meetingRemoteTranscriptionModel: string;

  uploadTranscriptionMode: TranscriptionMode;
  uploadUseLocalWhisper: boolean;
  uploadWhisperModel: string;
  uploadLocalTranscriptionProvider: LocalTranscriptionProvider;
  uploadParakeetModel: string;
  uploadCohereModel: string;
  uploadRemoteTranscriptionUrl: string;
  uploadRemoteTranscriptionModel: string;

  noteFormattingMode: InferenceMode;
  noteFormattingProvider: string;
  noteFormattingModel: string;
  noteFormattingRemoteUrl: string;
  noteFormattingCustomApiKey: string;

  translationMode: InferenceMode;
  translationProvider: string;
  translationModel: string;
  translationRemoteUrl: string;
  translationCustomApiKey: string;
  translationDisableThinking: boolean;
  translationReasoningEffort: string;
  useDictationTranslation: boolean;
  translationSourceLanguage: string;
  translationTargetLanguage: string;
  translationTargets: string[];

  dictationAgentMode: InferenceMode;
  dictationAgentProvider: string;
  dictationAgentModel: string;
  dictationAgentRemoteUrl: string;
  dictationAgentCustomApiKey: string;

  // Voice-agent screen context: opt-in screenshot capture.
  voiceAgentScreenContext: boolean;
  toneStyleEnabled: boolean;
  toneStyles: ToneStyles;

  // Agent web_search tool, served by the user's SearXNG instance.
  webSearchEnabled: boolean;
  webSearchUrl: string;

  cleanupDisableThinking: boolean;
  dictationAgentDisableThinking: boolean;
  noteFormattingDisableThinking: boolean;
  chatAgentDisableThinking: boolean;
  // "" is Auto: the server's default effort.
  cleanupReasoningEffort: string;
  dictationAgentReasoningEffort: string;
  noteFormattingReasoningEffort: string;
  chatAgentReasoningEffort: string;

  // Per-scope capabilities of the model answering chat and voice commands.
  // An empty tool-calling value means the mode's default (see toolCallingPolicy).
  dictationAgentToolCalling: ToolCallingSetting;
  chatAgentToolCalling: ToolCallingSetting;
  dictationAgentAcceptsImages: boolean;
  chatAgentAcceptsImages: boolean;

  customPrompts: Record<PromptKind, string>;
  setCustomPrompt: (kind: PromptKind, value: string) => void;

  setDictationAgentMode: (mode: InferenceMode) => void;
  setDictationAgentProvider: (value: string) => void;
  setDictationAgentModel: (value: string) => void;
  setDictationAgentRemoteUrl: (url: string) => void;
  setDictationAgentCustomApiKey: (key: string) => void;

  setVoiceAgentScreenContext: (value: boolean) => void;
  setToneStyleEnabled: (value: boolean) => void;
  setToneStyles: (styles: ToneStyles) => void;
  setWebSearchEnabled: (value: boolean) => void;
  setWebSearchUrl: (value: string) => void;

  setTranscriptionMode: (mode: TranscriptionMode) => void;
  setRemoteTranscriptionType: (type: SelfHostedType) => void;
  setRemoteTranscriptionUrl: (url: string) => void;
  setRemoteTranscriptionModel: (model: string) => void;
  setCleanupMode: (mode: InferenceMode) => void;
  setCleanupRemoteUrl: (url: string) => void;
  setKeepLocalModelLoaded: (value: boolean) => void;

  setMeetingTranscriptionMode: (mode: TranscriptionMode) => void;
  setMeetingUseLocalWhisper: (value: boolean) => void;
  setMeetingWhisperModel: (value: string) => void;
  setMeetingLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => void;
  setMeetingParakeetModel: (value: string) => void;
  setMeetingCohereModel: (value: string) => void;
  setMeetingRemoteTranscriptionType: (type: SelfHostedType) => void;
  setMeetingRemoteTranscriptionUrl: (url: string) => void;
  setMeetingRemoteTranscriptionModel: (model: string) => void;

  setUploadTranscriptionMode: (mode: TranscriptionMode) => void;
  setUploadUseLocalWhisper: (value: boolean) => void;
  setUploadWhisperModel: (value: string) => void;
  setUploadLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => void;
  setUploadParakeetModel: (value: string) => void;
  setUploadCohereModel: (value: string) => void;
  setUploadRemoteTranscriptionUrl: (value: string) => void;
  setUploadRemoteTranscriptionModel: (value: string) => void;

  setNoteFormattingMode: (mode: InferenceMode) => void;
  setNoteFormattingProvider: (value: string) => void;
  setNoteFormattingModel: (value: string) => void;
  setNoteFormattingRemoteUrl: (url: string) => void;
  setNoteFormattingCustomApiKey: (key: string) => void;

  setTranslationMode: (mode: InferenceMode) => void;
  setTranslationProvider: (value: string) => void;
  setTranslationModel: (value: string) => void;
  setTranslationRemoteUrl: (value: string) => void;
  setTranslationCustomApiKey: (value: string) => void;
  setTranslationDisableThinking: (value: boolean) => void;
  setUseDictationTranslation: (value: boolean) => void;
  setTranslationSourceLanguage: (value: string) => void;
  setTranslationTargetLanguage: (value: string) => void;
  setTranslationTargets: (targets: string[]) => void;

  setCleanupDisableThinking: (value: boolean) => void;
  setDictationAgentDisableThinking: (value: boolean) => void;
  setNoteFormattingDisableThinking: (value: boolean) => void;
  setChatAgentDisableThinking: (value: boolean) => void;

  setUseLocalWhisper: (value: boolean) => void;
  setWhisperModel: (value: string) => void;
  setLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => void;
  setParakeetModel: (value: string) => void;
  setCohereModel: (value: string) => void;
  setAllowLocalFallback: (value: boolean) => void;
  setFallbackWhisperModel: (value: string) => void;
  setPreferredLanguage: (value: string) => void;
  setChineseScriptPreference: (value: ChineseScriptPreference) => void;
  setCustomDictionary: (words: string[]) => void;
  updateCustomDictionary: (changes: { add?: string[]; remove?: string[] }) => void;
  applyCustomDictionaryFromExternal: (words: string[]) => void;
  setSnippets: (snippets: Snippet[]) => void;
  applySnippetsFromExternal: (snippets: Snippet[]) => void;
  setAutoGenerateNoteTitle: (value: boolean) => void;
  setUseCleanupModel: (value: boolean) => void;
  setUseDictationAgent: (value: boolean) => void;
  setCleanupModel: (value: string) => void;
  setCleanupProvider: (value: string) => void;
  setUiLanguage: (language: string) => void;

  setCustomTranscriptionApiKey: (key: string) => void;
  setCleanupCustomApiKey: (key: string) => void;

  setDictationKey: (key: string) => void;
  setMeetingKey: (key: string) => void;
  setVoiceAgentKey: (key: string) => Promise<HotkeyRegistrationResult>;
  translationKey: string;
  setTranslationKey: (key: string) => Promise<HotkeyRegistrationResult>;
  setMeetingHotkeyLayoutMode: (mode: "side-panel" | "full-width") => void;
  setOnboardingUseCases: (useCases: string[]) => void;
  setOnboardingUseCaseNote: (note: string) => void;
  setSpokenLanguages: (languages: string[]) => void;
  setActivationMode: (mode: "tap" | "push") => void;

  setPreferBuiltInMic: (value: boolean) => void;
  setMicrophoneSelectionMode: (mode: MicrophoneSelectionMode) => void;
  setSelectedMicDevice: (deviceId: string, label: string) => void;
  setMicWarmHoldSeconds: (seconds: number) => void;

  setTheme: (value: "light" | "dark" | "auto") => void;
  setAudioRetentionDays: (days: number) => void;
  setMeetingAudioRetentionDays: (days: number) => void;
  setTranscriptRetentionDays: (days: number) => void;
  setDataRetentionEnabled: (value: boolean) => void;
  setSaveDiscardedTranscriptions: (value: boolean) => void;
  setAudioCuesEnabled: (value: boolean) => void;
  setPauseMediaOnDictation: (value: boolean) => void;
  setFloatingIconAutoHide: (enabled: boolean) => void;
  setStartMinimized: (enabled: boolean) => void;
  setNotificationsEnabled: (value: boolean) => void;
  setNotifyMeetingDetection: (value: boolean) => void;
  setNotifyCalendarReminders: (value: boolean) => void;
  setAppleCalendarConnected: (value: boolean) => void;
  setMeetingProcessDetection: (value: boolean) => void;
  setSpeakerDiarizationEnabled: (value: boolean) => void;
  setDiarizationMode: (mode: TranscriptionMode) => void;
  setDiarizationRemoteUrl: (url: string) => void;
  setDictationSileroEnabled: (value: boolean) => void;
  setNoteRecordingSileroEnabled: (value: boolean) => void;
  setMeetingSileroEnabled: (value: boolean) => void;
  setMeetingAecEnabled: (value: boolean) => void;
  setWhisperVadThreshold: (value: number) => void;
  setWhisperVadMinSpeechDurationMs: (value: number) => void;
  setWhisperVadMinSilenceDurationMs: (value: number) => void;
  setWhisperVadMaxSpeechDurationS: (value: number) => void;
  setWhisperVadSpeechPadMs: (value: number) => void;
  setWhisperVadSamplesOverlap: (value: number) => void;
  setPanelStartPosition: (position: "bottom-right" | "center" | "bottom-left") => void;
  setShowTranscriptionPreview: (value: boolean) => void;
  setAutoPasteEnabled: (value: boolean) => void;
  setKeepTranscriptionInClipboard: (value: boolean) => void;
  setNoteFilesEnabled: (value: boolean) => void;
  setNoteFilesPath: (value: string) => void;
  setNoteFilesBaseTag: (value: string) => void;
  setNoteFilesExportDictations: (value: boolean) => void;
  setUserName: (value: string) => void;

  setChatAgentModel: (value: string) => void;
  setChatAgentProvider: (value: string) => void;
  setChatAgentMode: (mode: InferenceMode) => void;
  setChatAgentRemoteUrl: (url: string) => void;
  setChatAgentCustomApiKey: (key: string) => void;

  updateTranscriptionSettings: (settings: Partial<TranscriptionSettings>) => void;
  setTranscriptionModeForAllScopes: (mode: TranscriptionMode) => void;
  updateCleanupSettings: (settings: Partial<CleanupSettings>) => void;
  setReasoningForAllScopes: (config: ReasoningSelection) => void;
  updateApiKeys: (keys: Partial<ApiKeySettings>) => void;
  updateChatAgentSettings: (settings: Partial<ChatAgentSettings>) => void;
}

function createStringSetter(key: string) {
  return (value: string) => {
    if (isBrowser) localStorage.setItem(key, value);
    useSettingsStore.setState({ [key]: value });
  };
}

/** Writes a string setting whose key is computed rather than known up front. */
export function setStringSetting(key: keyof SettingsState, value: string): void {
  createStringSetter(key)(value);
}

// Meetings and uploads diarize in the main process, which only learns the
// speaker detection endpoint from here.
async function syncDiarizationEndpoint(): Promise<void> {
  if (!isBrowser) return;
  const { diarizationMode, diarizationRemoteUrl } = useSettingsStore.getState();
  await window.electronAPI?.setDiarizationEndpoint?.({
    mode: diarizationMode,
    url: diarizationRemoteUrl,
  });
}

function createBooleanSetter(key: string) {
  return (value: boolean) => {
    if (isBrowser) localStorage.setItem(key, String(value));
    useSettingsStore.setState({ [key]: value });
  };
}

function createNumberSetter(key: string) {
  return (value: number) => {
    if (isBrowser) localStorage.setItem(key, String(value));
    useSettingsStore.setState({ [key]: value });
  };
}

// Setter for hotkeys that must be registered with the main process before
// being persisted. Rolls back to the previous key if registration fails.
// Resolves to false on failure so optimistic UIs (HotkeyListInput) can revert.
function createRegisteredHotkeySetter(
  key: "voiceAgentKey" | "translationKey",
  label: string,
  getRegisterFn: () => ((hotkey: string) => Promise<HotkeyRegistrationResult>) | undefined,
  fallbackSave?: (hotkey: string) => void
) {
  return async (hotkey: string): Promise<HotkeyRegistrationResult> => {
    if (!isBrowser) {
      useSettingsStore.setState({ [key]: hotkey });
      return { success: true };
    }

    const registerFn = getRegisterFn();
    if (!registerFn) {
      localStorage.setItem(key, hotkey);
      useSettingsStore.setState({ [key]: hotkey });
      fallbackSave?.(hotkey);
      return { success: true };
    }

    const previousKey = useSettingsStore.getState()[key];

    try {
      const result = await registerFn(hotkey);
      if (!result?.success) {
        localStorage.setItem(key, previousKey);
        useSettingsStore.setState({ [key]: previousKey });
        logger.warn(`Failed to update ${label}`, { hotkey, message: result?.message }, "settings");
        return { success: false, message: result?.message };
      }

      localStorage.setItem(key, hotkey);
      useSettingsStore.setState({ [key]: hotkey });
      return { success: true };
    } catch (error) {
      logger.warn(
        `Failed to update ${label}`,
        { hotkey, error: error instanceof Error ? error.message : String(error) },
        "settings"
      );
      return { success: false };
    }
  };
}

let envPersistTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedPersistToEnv() {
  if (!isBrowser) return;
  if (envPersistTimer) clearTimeout(envPersistTimer);
  envPersistTimer = setTimeout(() => {
    window.electronAPI?.saveAllKeysToEnv?.().catch((err) => {
      logger.warn(
        "Failed to persist API keys to .env",
        { error: (err as Error).message },
        "settings"
      );
    });
  }, 1000);
}

const SECRET_IPC_SAVERS = {
  customTranscription: "saveCustomTranscriptionKey",
  cleanupCustom: "saveCleanupCustomKey",
  noteFormattingCustom: "saveNoteFormattingCustomKey",
  translationCustom: "saveTranslationCustomKey",
  dictationAgentCustom: "saveDictationAgentCustomKey",
  chatAgentCustom: "saveChatAgentCustomKey",
} as const;

type SecretProvider = keyof typeof SECRET_IPC_SAVERS;

const secretSaveTimers: Partial<Record<SecretProvider, ReturnType<typeof setTimeout>>> = {};
function debouncedSaveSecret(provider: SecretProvider, key: string) {
  if (!isBrowser) return;
  debouncedPersistToEnv();
  const timer = secretSaveTimers[provider];
  if (timer) clearTimeout(timer);
  secretSaveTimers[provider] = setTimeout(() => {
    const api = window.electronAPI;
    const save = api?.[SECRET_IPC_SAVERS[provider]] as
      ((k: string) => Promise<unknown>) | undefined;
    save?.(key)?.catch((err) => {
      logger.warn(
        "Failed to persist secret",
        { provider, error: (err as Error).message },
        "settings"
      );
    });
  }, 250);
}

const STALE_SECRET_LOCALSTORAGE_KEYS = [
  "openaiApiKey",
  "anthropicApiKey",
  "geminiApiKey",
  "groqApiKey",
  "xaiApiKey",
  "mistralApiKey",
  "openrouterApiKey",
  "cortiClientId",
  "cortiClientSecret",
  "cortiApiKey",
  "tinfoilApiKey",
  "deepgramApiKey",
  "assemblyaiApiKey",
  "customTranscriptionApiKey",
  "customReasoningApiKey",
  "cleanupCustomApiKey",
  "noteFormattingCustomApiKey",
  "translationCustomApiKey",
  "dictationAgentCustomApiKey",
  "dictationAgentVisionCustomApiKey",
  "chatAgentCustomApiKey",
  "bedrockAccessKeyId",
  "bedrockSecretAccessKey",
  "bedrockSessionToken",
  "azureApiKey",
  "vertexApiKey",
] as const;

function notifyApiKeyChanged() {
  if (isBrowser) window.dispatchEvent(new Event("api-key-changed"));
}

// Uniform secret setter: persist to the secure store (debounced) and tell
// listeners a key changed.
function createSecretSetter(storeKey: string, saver: SecretProvider) {
  return (key: string) => {
    useSettingsStore.setState({ [storeKey]: key });
    debouncedSaveSecret(saver, key);
    notifyApiKeyChanged();
  };
}

export const MAX_TRANSLATION_TARGETS = 5;

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  uiLanguage: normalizeUiLanguage(
    isBrowser ? localStorage.getItem("uiLanguage") || i18n.language : null
  ),
  useLocalWhisper: readBoolean("useLocalWhisper", true),
  whisperModel: readString("whisperModel", "base"),
  localTranscriptionProvider: readLocalProvider("localTranscriptionProvider"),
  parakeetModel: readString("parakeetModel", ""),
  cohereModel: readString("cohereModel", DEFAULT_COHERE_MODEL),
  allowLocalFallback: readBoolean("allowLocalFallback", false),
  fallbackWhisperModel: readString("fallbackWhisperModel", "base"),
  preferredLanguage: readString("preferredLanguage", "auto"),
  chineseScriptPreference: normalizeChineseScriptPreference(
    readString("chineseScriptPreference", "as-transcribed")
  ),
  customDictionary: readStringArray("customDictionary", []),
  snippets: (() => {
    try {
      const parsed = JSON.parse(readString("snippets", "[]"));
      return Array.isArray(parsed) ? (parsed as Snippet[]) : [];
    } catch {
      return [];
    }
  })(),

  autoGenerateNoteTitle: readBoolean("autoGenerateNoteTitle", true),
  useCleanupModel: readBoolean("useCleanupModel", true),
  useDictationAgent: readBoolean("useDictationAgent", true),
  cleanupModel: readString("cleanupModel", ""),
  cleanupProvider: readString("cleanupProvider", ""),

  // Secrets hydrate from main process in initializeSettings, never from localStorage.
  customTranscriptionApiKey: "",
  cleanupCustomApiKey: "",

  dictationKey: readString("dictationKey", ""),
  activeDictationKey: null,
  meetingKey: readString("meetingKey", ""),
  voiceAgentKey: readString("voiceAgentKey", ""),
  translationKey: readString("translationKey", ""),
  onboardingUseCases: readStringArray("onboardingUseCases", []),
  onboardingUseCaseNote: readString("onboardingUseCaseNote", ""),
  spokenLanguages: readStringArray("spokenLanguages", []),
  meetingHotkeyLayoutMode: (readString("meetingHotkeyLayoutMode", "full-width") === "side-panel"
    ? "side-panel"
    : "full-width") as "side-panel" | "full-width",
  activationMode: (readString("activationMode", "tap") === "push" ? "push" : "tap") as
    "tap" | "push",

  microphoneSelectionMode: (() => {
    const mode = readString("microphoneSelectionMode", "system");
    return (
      mode === "built-in" || mode === "specific" ? mode : "system"
    ) as MicrophoneSelectionMode;
  })(),
  preferBuiltInMic: readBoolean("preferBuiltInMic", false),
  selectedMicDeviceId: readString("selectedMicDeviceId", ""),
  selectedMicDeviceLabel: readString("selectedMicDeviceLabel", ""),
  micWarmHoldSeconds: snapMicWarmHold(readNumber("micWarmHoldSeconds", 0)),

  theme: (() => {
    const v = readString("theme", "auto");
    if (v === "light" || v === "dark" || v === "auto") return v;
    return "auto" as const;
  })(),
  audioRetentionDays: readNumber("audioRetentionDays", 30),
  meetingAudioRetentionDays: (() => {
    // Meeting audio used to follow the audio timer, and only while history was
    // on. Store that once so later dictation changes don't move it.
    if (isBrowser && localStorage.getItem("meetingAudioRetentionDays") === null) {
      const inherited = readBoolean("dataRetentionEnabled", true)
        ? readNumber("audioRetentionDays", 30)
        : 0;
      localStorage.setItem("meetingAudioRetentionDays", String(inherited));
    }
    return readNumber("meetingAudioRetentionDays", 30);
  })(),
  transcriptRetentionDays: readNumber("transcriptRetentionDays", 0),
  dataRetentionEnabled: readBoolean("dataRetentionEnabled", true),
  saveDiscardedTranscriptions: readBoolean("saveDiscardedTranscriptions", false),
  audioCuesEnabled: readBoolean("audioCuesEnabled", true),
  pauseMediaOnDictation: readBoolean("pauseMediaOnDictation", false),
  floatingIconAutoHide: readBoolean("floatingIconAutoHide", false),
  startMinimized: readBoolean("startMinimized", false),
  notificationsEnabled: readBoolean("notificationsEnabled", true),
  notifyMeetingDetection: readBoolean("notifyMeetingDetection", true),
  notifyCalendarReminders: readBoolean("notifyCalendarReminders", true),
  appleCalendarConnected: readBoolean("appleCalendarConnected", false),
  meetingProcessDetection: readBoolean("meetingProcessDetection", true),
  speakerDiarizationEnabled: readBoolean("speakerDiarizationEnabled", true),
  diarizationMode: readTranscriptionMode("diarizationMode"),
  diarizationRemoteUrl: readString("diarizationRemoteUrl", ""),
  // Off by default: VAD on pause-heavy dictations can strip the speech and make
  // Whisper hallucinate the dictionary prompt as the transcript (#1454).
  dictationSileroEnabled: readBoolean("dictationSileroEnabled", false),
  noteRecordingSileroEnabled: readBoolean("noteRecordingSileroEnabled", true),
  meetingSileroEnabled: readBoolean("meetingSileroEnabled", true),
  // Acoustic echo cancellation for meetings is opt-in: on headsets there's no
  // echo to cancel and it can suppress the mic entirely. See ipcHandlers AEC gate.
  meetingAecEnabled: readBoolean("meetingAecEnabled", false),
  whisperVadThreshold: clampVadValue("threshold", readString("whisperVadThreshold", "0.5")),
  whisperVadMinSpeechDurationMs: clampVadValue(
    "minSpeechDurationMs",
    readString("whisperVadMinSpeechDurationMs", "250")
  ),
  whisperVadMinSilenceDurationMs: clampVadValue(
    "minSilenceDurationMs",
    readString("whisperVadMinSilenceDurationMs", "200")
  ),
  whisperVadMaxSpeechDurationS: clampVadValue(
    "maxSpeechDurationS",
    readString("whisperVadMaxSpeechDurationS", "30")
  ),
  whisperVadSpeechPadMs: clampVadValue("speechPadMs", readString("whisperVadSpeechPadMs", "100")),
  whisperVadSamplesOverlap: clampVadValue(
    "samplesOverlap",
    readString("whisperVadSamplesOverlap", "0.5")
  ),
  panelStartPosition: (() => {
    const v = readString("panelStartPosition", "bottom-right");
    if (v === "bottom-right" || v === "center" || v === "bottom-left") return v;
    return "bottom-right" as const;
  })(),
  showTranscriptionPreview: readBoolean("showTranscriptionPreview", false),
  autoPasteEnabled: readBoolean("autoPasteEnabled", true),
  keepTranscriptionInClipboard: readBoolean("keepTranscriptionInClipboard", false),
  noteFilesEnabled: readBoolean("noteFilesEnabled", false),
  noteFilesPath: readString("noteFilesPath", ""),
  noteFilesBaseTag: readString("noteFilesBaseTag", "openwhispr"),
  noteFilesExportDictations: readBoolean("noteFilesExportDictations", false),
  userName: readString("userName", ""),

  transcriptionMode: readTranscriptionMode("transcriptionMode"),
  remoteTranscriptionType: (() => {
    const v = readString("remoteTranscriptionType", "lan");
    return v === "openai-compatible" ? "openai-compatible" : ("lan" as SelfHostedType);
  })(),
  remoteTranscriptionUrl: readString("remoteTranscriptionUrl", ""),
  remoteTranscriptionModel: readString("remoteTranscriptionModel", ""),
  cleanupMode: readInferenceMode("cleanupMode"),
  cleanupRemoteUrl: readString("cleanupRemoteUrl", ""),
  keepLocalModelLoaded: readBoolean("keepLocalModelLoaded", false),

  meetingTranscriptionMode: readTranscriptionMode("meetingTranscriptionMode"),
  meetingUseLocalWhisper: readBoolean("meetingUseLocalWhisper", true),
  meetingWhisperModel: readString("meetingWhisperModel", ""),
  meetingLocalTranscriptionProvider: readScopedLocalProvider("meetingLocalTranscriptionProvider"),
  meetingParakeetModel: readString("meetingParakeetModel", ""),
  meetingCohereModel: readString("meetingCohereModel", ""),
  meetingRemoteTranscriptionType: (() => {
    const v = readString("meetingRemoteTranscriptionType", "lan");
    return v === "openai-compatible" ? "openai-compatible" : ("lan" as SelfHostedType);
  })(),
  meetingRemoteTranscriptionUrl: readString("meetingRemoteTranscriptionUrl", ""),
  meetingRemoteTranscriptionModel: readString("meetingRemoteTranscriptionModel", ""),

  uploadTranscriptionMode: readTranscriptionMode("uploadTranscriptionMode"),
  uploadUseLocalWhisper: readBoolean("uploadUseLocalWhisper", true),
  uploadWhisperModel: readString("uploadWhisperModel", ""),
  uploadLocalTranscriptionProvider: readScopedLocalProvider("uploadLocalTranscriptionProvider"),
  uploadParakeetModel: readString("uploadParakeetModel", ""),
  uploadCohereModel: readString("uploadCohereModel", ""),
  uploadRemoteTranscriptionUrl: readString("uploadRemoteTranscriptionUrl", ""),
  uploadRemoteTranscriptionModel: readString("uploadRemoteTranscriptionModel", ""),

  noteFormattingMode: readInferenceMode("noteFormattingMode"),
  noteFormattingProvider: readString("noteFormattingProvider", ""),
  noteFormattingModel: readString("noteFormattingModel", ""),
  noteFormattingRemoteUrl: readString("noteFormattingRemoteUrl", ""),
  noteFormattingCustomApiKey: readString("noteFormattingCustomApiKey", ""),

  translationMode: readInferenceMode("translationMode"),
  translationProvider: readString("translationProvider", ""),
  translationModel: readString("translationModel", ""),
  translationRemoteUrl: readString("translationRemoteUrl", ""),
  translationCustomApiKey: readString("translationCustomApiKey", ""),
  translationDisableThinking: readBoolean("translationDisableThinking", true),
  translationReasoningEffort: readString("translationReasoningEffort", ""),
  useDictationTranslation: readBoolean("useDictationTranslation", false),
  translationSourceLanguage: readString("translationSourceLanguage", "auto"),
  translationTargetLanguage: readString("translationTargetLanguage", ""),
  translationTargets: (() => {
    // Seed from the saved array; otherwise from the single active target if set.
    const stored = isBrowser ? localStorage.getItem("translationTargets") : null;
    if (stored !== null) return readStringArray("translationTargets", []);
    const active = readString("translationTargetLanguage", "");
    return active ? [active] : [];
  })(),

  setTranscriptionMode: createStringSetter("transcriptionMode") as (
    mode: TranscriptionMode
  ) => void,
  setRemoteTranscriptionType: createStringSetter("remoteTranscriptionType") as (
    type: SelfHostedType
  ) => void,
  setRemoteTranscriptionUrl: createStringSetter("remoteTranscriptionUrl"),
  setRemoteTranscriptionModel: createStringSetter("remoteTranscriptionModel"),
  setCleanupMode: createStringSetter("cleanupMode") as (mode: InferenceMode) => void,
  setCleanupRemoteUrl: createStringSetter("cleanupRemoteUrl"),
  setKeepLocalModelLoaded: createBooleanSetter("keepLocalModelLoaded"),

  setMeetingTranscriptionMode: createStringSetter("meetingTranscriptionMode") as (
    mode: TranscriptionMode
  ) => void,
  setMeetingUseLocalWhisper: createBooleanSetter("meetingUseLocalWhisper"),
  setMeetingWhisperModel: createStringSetter("meetingWhisperModel"),
  setMeetingLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => {
    if (isBrowser) localStorage.setItem("meetingLocalTranscriptionProvider", value);
    useSettingsStore.setState({ meetingLocalTranscriptionProvider: value });
  },
  setMeetingParakeetModel: createStringSetter("meetingParakeetModel"),
  setMeetingCohereModel: createStringSetter("meetingCohereModel"),
  setMeetingRemoteTranscriptionType: createStringSetter("meetingRemoteTranscriptionType") as (
    type: SelfHostedType
  ) => void,
  setMeetingRemoteTranscriptionUrl: createStringSetter("meetingRemoteTranscriptionUrl"),
  setMeetingRemoteTranscriptionModel: createStringSetter("meetingRemoteTranscriptionModel"),

  setUploadTranscriptionMode: createStringSetter("uploadTranscriptionMode") as (
    mode: TranscriptionMode
  ) => void,
  setUploadUseLocalWhisper: createBooleanSetter("uploadUseLocalWhisper"),
  setUploadWhisperModel: createStringSetter("uploadWhisperModel"),
  setUploadLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => {
    if (isBrowser) localStorage.setItem("uploadLocalTranscriptionProvider", value);
    useSettingsStore.setState({ uploadLocalTranscriptionProvider: value });
  },
  setUploadParakeetModel: createStringSetter("uploadParakeetModel"),
  setUploadCohereModel: createStringSetter("uploadCohereModel"),
  setUploadRemoteTranscriptionUrl: createStringSetter("uploadRemoteTranscriptionUrl"),
  setUploadRemoteTranscriptionModel: createStringSetter("uploadRemoteTranscriptionModel"),

  setNoteFormattingMode: createStringSetter("noteFormattingMode") as (mode: InferenceMode) => void,
  setNoteFormattingProvider: createStringSetter("noteFormattingProvider"),
  setNoteFormattingModel: createStringSetter("noteFormattingModel"),
  setNoteFormattingRemoteUrl: createStringSetter("noteFormattingRemoteUrl"),
  setNoteFormattingCustomApiKey: createSecretSetter(
    "noteFormattingCustomApiKey",
    "noteFormattingCustom"
  ),

  setTranslationMode: createStringSetter("translationMode") as (mode: InferenceMode) => void,
  setTranslationProvider: createStringSetter("translationProvider"),
  setTranslationModel: createStringSetter("translationModel"),
  setTranslationRemoteUrl: createStringSetter("translationRemoteUrl"),
  setTranslationCustomApiKey: createSecretSetter("translationCustomApiKey", "translationCustom"),
  setTranslationDisableThinking: createBooleanSetter("translationDisableThinking"),
  setUseDictationTranslation: createBooleanSetter("useDictationTranslation"),
  setTranslationSourceLanguage: createStringSetter("translationSourceLanguage"),
  setTranslationTargetLanguage: createStringSetter("translationTargetLanguage"),
  setTranslationTargets: (targets: string[]) => {
    const normalized = Array.from(
      new Set(targets.filter((v) => typeof v === "string" && v.trim() && v !== "auto"))
    );
    if (isBrowser) localStorage.setItem("translationTargets", JSON.stringify(normalized));
    set({ translationTargets: normalized });
  },

  chatAgentModel: readString("chatAgentModel", ""),
  chatAgentProvider: readString("chatAgentProvider", ""),
  chatAgentMode: readInferenceMode("chatAgentMode"),
  chatAgentRemoteUrl: readString("chatAgentRemoteUrl", ""),
  chatAgentCustomApiKey: readString("chatAgentCustomApiKey", ""),

  dictationAgentMode: readInferenceMode("dictationAgentMode"),
  dictationAgentProvider: readString("dictationAgentProvider", ""),
  dictationAgentModel: readString("dictationAgentModel", ""),
  dictationAgentRemoteUrl: readString("dictationAgentRemoteUrl", ""),
  dictationAgentCustomApiKey: readString("dictationAgentCustomApiKey", ""),

  voiceAgentScreenContext: readBoolean("voiceAgentScreenContext", false),
  toneStyleEnabled: readBoolean("toneStyleEnabled", false),
  toneStyles: normalizeToneStyles(readString("toneStyles", "")),
  webSearchEnabled: readBoolean("webSearchEnabled", false),
  webSearchUrl: readString("webSearchUrl", ""),

  cleanupDisableThinking: readBoolean("cleanupDisableThinking", true),
  dictationAgentDisableThinking: readBoolean("dictationAgentDisableThinking", true),
  noteFormattingDisableThinking: readBoolean("noteFormattingDisableThinking", true),
  chatAgentDisableThinking: readBoolean("chatAgentDisableThinking", true),
  cleanupReasoningEffort: readString("cleanupReasoningEffort", ""),
  dictationAgentReasoningEffort: readString("dictationAgentReasoningEffort", ""),
  noteFormattingReasoningEffort: readString("noteFormattingReasoningEffort", ""),
  chatAgentReasoningEffort: readString("chatAgentReasoningEffort", ""),
  dictationAgentToolCalling: readToolCallingSetting("dictationAgentToolCalling"),
  chatAgentToolCalling: readToolCallingSetting("chatAgentToolCalling"),
  dictationAgentAcceptsImages: readBoolean("dictationAgentAcceptsImages", false),
  chatAgentAcceptsImages: readBoolean("chatAgentAcceptsImages", false),

  customPrompts: PROMPT_KIND_LIST.reduce(
    (acc, kind) => ({ ...acc, [kind]: readString(`customPrompt.${kind}`, "") }),
    {} as Record<PromptKind, string>
  ),
  setCustomPrompt: (kind, value) => {
    if (isBrowser) localStorage.setItem(`customPrompt.${kind}`, value);
    useSettingsStore.setState((s) => ({
      customPrompts: { ...s.customPrompts, [kind]: value },
    }));
  },

  setDictationAgentMode: createStringSetter("dictationAgentMode") as (mode: InferenceMode) => void,
  setDictationAgentProvider: createStringSetter("dictationAgentProvider"),
  setDictationAgentModel: createStringSetter("dictationAgentModel"),
  setDictationAgentRemoteUrl: createStringSetter("dictationAgentRemoteUrl"),
  setDictationAgentCustomApiKey: createSecretSetter(
    "dictationAgentCustomApiKey",
    "dictationAgentCustom"
  ),

  setVoiceAgentScreenContext: createBooleanSetter("voiceAgentScreenContext"),
  setToneStyleEnabled: createBooleanSetter("toneStyleEnabled"),
  setToneStyles: (styles) => {
    if (isBrowser) localStorage.setItem("toneStyles", JSON.stringify(styles));
    useSettingsStore.setState({ toneStyles: styles });
  },
  setWebSearchEnabled: createBooleanSetter("webSearchEnabled"),
  setWebSearchUrl: createStringSetter("webSearchUrl"),

  setCleanupDisableThinking: createBooleanSetter("cleanupDisableThinking"),
  setDictationAgentDisableThinking: createBooleanSetter("dictationAgentDisableThinking"),
  setNoteFormattingDisableThinking: createBooleanSetter("noteFormattingDisableThinking"),
  setChatAgentDisableThinking: createBooleanSetter("chatAgentDisableThinking"),

  setUseLocalWhisper: createBooleanSetter("useLocalWhisper"),
  setWhisperModel: createStringSetter("whisperModel"),
  setLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => {
    if (isBrowser) localStorage.setItem("localTranscriptionProvider", value);
    set({ localTranscriptionProvider: value });
  },
  setParakeetModel: createStringSetter("parakeetModel"),
  setCohereModel: createStringSetter("cohereModel"),
  setAllowLocalFallback: createBooleanSetter("allowLocalFallback"),
  setFallbackWhisperModel: createStringSetter("fallbackWhisperModel"),
  setPreferredLanguage: createStringSetter("preferredLanguage"),
  setChineseScriptPreference: (value: ChineseScriptPreference) =>
    createStringSetter("chineseScriptPreference")(normalizeChineseScriptPreference(value)),
  setAutoGenerateNoteTitle: createBooleanSetter("autoGenerateNoteTitle"),
  setUseCleanupModel: createBooleanSetter("useCleanupModel"),
  setUseDictationAgent: createBooleanSetter("useDictationAgent"),
  setCleanupProvider: createStringSetter("cleanupProvider"),
  setCleanupModel: createStringSetter("cleanupModel"),

  // Replaces the whole dictionary: anything absent from `words` is deleted.
  // Editing specific words wants updateCustomDictionary instead (#1295).
  setCustomDictionary: (words: string[]) => {
    if (isBrowser) localStorage.setItem("customDictionary", JSON.stringify(words));
    set({ customDictionary: words });
    window.electronAPI?.setDictionary(words).catch((err) => {
      logger.warn(
        "Failed to sync dictionary to SQLite",
        { error: (err as Error).message },
        "settings"
      );
    });
  },

  updateCustomDictionary: ({ add = [], remove = [] }) => {
    const removeLower = new Set(remove.map((w) => w.toLowerCase()));
    const addLower = new Set(add.map((w) => w.toLowerCase()));
    // Optimistic so the UI updates immediately; the stored list replaces it below.
    const optimistic = [
      ...get().customDictionary.filter((w) => {
        const lower = w.toLowerCase();
        return !removeLower.has(lower) && !addLower.has(lower);
      }),
      ...add,
    ];
    if (isBrowser) localStorage.setItem("customDictionary", JSON.stringify(optimistic));
    set({ customDictionary: optimistic });

    const api = window.electronAPI;
    if (!api) return;
    // Older preloads have no delta channel; fall back rather than drop the edit.
    const written = api.applyDictionaryChanges
      ? api.applyDictionaryChanges({ add, remove })
      : api.setDictionary(optimistic);

    written
      .then(async () => {
        // SQLite owns ordering, casing and dedupe — adopt what it stored.
        const stored = await api.getDictionary?.();
        if (stored) {
          if (isBrowser) localStorage.setItem("customDictionary", JSON.stringify(stored));
          set({ customDictionary: stored });
        }
      })
      .catch((err) => {
        logger.warn(
          "Failed to apply dictionary changes to SQLite",
          { error: (err as Error).message },
          "settings"
        );
      });
  },

  // For broadcasts from main process — DB is already authoritative, only update UI.
  applyCustomDictionaryFromExternal: (words: string[]) => {
    if (isBrowser) localStorage.setItem("customDictionary", JSON.stringify(words));
    set({ customDictionary: words });
  },

  setSnippets: (snippets: Snippet[]) => {
    if (isBrowser) localStorage.setItem("snippets", JSON.stringify(snippets));
    set({ snippets });
    window.electronAPI?.setSnippets?.(snippets).catch((err) => {
      logger.warn(
        "Failed to sync snippets to SQLite",
        { error: (err as Error).message },
        "settings"
      );
    });
  },

  // For broadcasts from main process — DB is already authoritative, only update UI.
  applySnippetsFromExternal: (snippets: Snippet[]) => {
    if (isBrowser) localStorage.setItem("snippets", JSON.stringify(snippets));
    set({ snippets });
  },

  setUiLanguage: (language: string) => {
    const normalized = normalizeUiLanguage(language);
    if (isBrowser) localStorage.setItem("uiLanguage", normalized);
    set({ uiLanguage: normalized });
    void i18n.changeLanguage(normalized);
    if (isBrowser && window.electronAPI?.setUiLanguage) {
      window.electronAPI.setUiLanguage(normalized).catch((err) => {
        logger.warn(
          "Failed to sync UI language to main process",
          { error: (err as Error).message },
          "settings"
        );
      });
    }
  },

  setCustomTranscriptionApiKey: createSecretSetter(
    "customTranscriptionApiKey",
    "customTranscription"
  ),
  setCleanupCustomApiKey: createSecretSetter("cleanupCustomApiKey", "cleanupCustom"),

  setDictationKey: (key: string) => {
    if (isBrowser) localStorage.setItem("dictationKey", key);
    set({ dictationKey: key });
    if (isBrowser) {
      window.electronAPI?.notifyHotkeyChanged?.(key);
      window.electronAPI?.saveDictationKey?.(key);
    }
  },
  setMeetingKey: (key: string) => {
    if (isBrowser) localStorage.setItem("meetingKey", key);
    set({ meetingKey: key });
  },
  setVoiceAgentKey: createRegisteredHotkeySetter(
    "voiceAgentKey",
    "voice agent hotkey",
    () => window.electronAPI?.updateVoiceAgentHotkey
  ),
  setTranslationKey: createRegisteredHotkeySetter(
    "translationKey",
    "translation hotkey",
    () => window.electronAPI?.updateTranslationHotkey
  ),

  setMeetingHotkeyLayoutMode: (mode: "side-panel" | "full-width") => {
    if (isBrowser) localStorage.setItem("meetingHotkeyLayoutMode", mode);
    set({ meetingHotkeyLayoutMode: mode });
  },

  setOnboardingUseCases: (useCases: string[]) => {
    if (isBrowser) localStorage.setItem("onboardingUseCases", JSON.stringify(useCases));
    set({ onboardingUseCases: useCases });
  },

  setOnboardingUseCaseNote: createStringSetter("onboardingUseCaseNote"),

  setSpokenLanguages: (languages: string[]) => {
    if (isBrowser) localStorage.setItem("spokenLanguages", JSON.stringify(languages));
    set({ spokenLanguages: languages });
  },

  setActivationMode: (mode: "tap" | "push") => {
    if (isBrowser) localStorage.setItem("activationMode", mode);
    set({ activationMode: mode });
    if (isBrowser) {
      window.electronAPI?.notifyActivationModeChanged?.(mode);
    }
  },

  setPreferBuiltInMic: (value: boolean) => {
    const mode: MicrophoneSelectionMode = value ? "built-in" : "system";
    if (isBrowser) {
      localStorage.setItem("preferBuiltInMic", String(value));
      localStorage.setItem("microphoneSelectionMode", mode);
    }
    set({ preferBuiltInMic: value, microphoneSelectionMode: mode });
  },
  setMicrophoneSelectionMode: (mode: MicrophoneSelectionMode) => {
    const normalized: MicrophoneSelectionMode =
      mode === "built-in" || mode === "specific" ? mode : "system";
    const preferBuiltInMic = normalized === "built-in";
    if (isBrowser) {
      localStorage.setItem("microphoneSelectionMode", normalized);
      localStorage.setItem("preferBuiltInMic", String(preferBuiltInMic));
    }
    set({ microphoneSelectionMode: normalized, preferBuiltInMic });
  },
  setSelectedMicDevice: (deviceId: string, label: string) => {
    if (isBrowser) {
      localStorage.setItem("selectedMicDeviceLabel", label);
      localStorage.setItem("selectedMicDeviceId", deviceId);
    }
    set({ selectedMicDeviceId: deviceId, selectedMicDeviceLabel: label });
  },

  setTheme: (value: "light" | "dark" | "auto") => {
    if (isBrowser) localStorage.setItem("theme", value);
    set({ theme: value });
  },

  setMicWarmHoldSeconds: (value: number) => {
    const snapped = snapMicWarmHold(value);
    if (isBrowser) localStorage.setItem("micWarmHoldSeconds", String(snapped));
    set({ micWarmHoldSeconds: snapped });
  },
  setAudioRetentionDays: createNumberSetter("audioRetentionDays"),
  setMeetingAudioRetentionDays: createNumberSetter("meetingAudioRetentionDays"),
  setTranscriptRetentionDays: createNumberSetter("transcriptRetentionDays"),
  setDataRetentionEnabled: (value: boolean) => {
    if (isBrowser) localStorage.setItem("dataRetentionEnabled", String(value));
    set({ dataRetentionEnabled: value });
    logger.info(
      value
        ? "Dictation history enabled — dictations and their audio will be saved"
        : "Dictation history disabled — dictations and their audio will not be saved",
      {},
      "settings"
    );
  },
  setSaveDiscardedTranscriptions: createBooleanSetter("saveDiscardedTranscriptions"),
  setAudioCuesEnabled: createBooleanSetter("audioCuesEnabled"),
  setPauseMediaOnDictation: createBooleanSetter("pauseMediaOnDictation"),

  setFloatingIconAutoHide: (enabled: boolean) => {
    if (get().floatingIconAutoHide === enabled) return;
    if (isBrowser) localStorage.setItem("floatingIconAutoHide", String(enabled));
    set({ floatingIconAutoHide: enabled });
    if (isBrowser) {
      window.electronAPI?.notifyFloatingIconAutoHideChanged?.(enabled);
    }
  },

  setStartMinimized: (enabled: boolean) => {
    if (get().startMinimized === enabled) return;
    if (isBrowser) localStorage.setItem("startMinimized", String(enabled));
    set({ startMinimized: enabled });
    if (isBrowser) {
      window.electronAPI?.notifyStartMinimizedChanged?.(enabled);
    }
  },

  setNotificationsEnabled: createBooleanSetter("notificationsEnabled"),
  setNotifyMeetingDetection: createBooleanSetter("notifyMeetingDetection"),
  setNotifyCalendarReminders: createBooleanSetter("notifyCalendarReminders"),
  setAppleCalendarConnected: createBooleanSetter("appleCalendarConnected"),
  setMeetingProcessDetection: createBooleanSetter("meetingProcessDetection"),
  setSpeakerDiarizationEnabled: (value: boolean) => {
    if (isBrowser) localStorage.setItem("speakerDiarizationEnabled", String(value));
    useSettingsStore.setState({ speakerDiarizationEnabled: value });
    if (isBrowser) {
      window.electronAPI?.setSpeakerDiarizationEnabled?.(value);
    }
  },
  setDiarizationMode: (mode: TranscriptionMode) => {
    createStringSetter("diarizationMode")(mode);
    void syncDiarizationEndpoint();
  },
  setDiarizationRemoteUrl: (url: string) => {
    createStringSetter("diarizationRemoteUrl")(url);
    void syncDiarizationEndpoint();
  },
  setDictationSileroEnabled: (value: boolean) => {
    if (isBrowser) localStorage.setItem("dictationSileroEnabled", String(value));
    useSettingsStore.setState({ dictationSileroEnabled: value });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ dictationSileroEnabled: value });
    }
  },
  setNoteRecordingSileroEnabled: (value: boolean) => {
    if (isBrowser) localStorage.setItem("noteRecordingSileroEnabled", String(value));
    useSettingsStore.setState({ noteRecordingSileroEnabled: value });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ noteRecordingSileroEnabled: value });
    }
  },
  setMeetingSileroEnabled: (value: boolean) => {
    if (isBrowser) localStorage.setItem("meetingSileroEnabled", String(value));
    useSettingsStore.setState({ meetingSileroEnabled: value });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ meetingSileroEnabled: value });
    }
  },
  setMeetingAecEnabled: createBooleanSetter("meetingAecEnabled"),
  setWhisperVadThreshold: (value: number) => {
    const next = clampVadValue("threshold", value);
    if (isBrowser) localStorage.setItem("whisperVadThreshold", String(next));
    useSettingsStore.setState({ whisperVadThreshold: next });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ threshold: next });
    }
  },
  setWhisperVadMinSpeechDurationMs: (value: number) => {
    const next = clampVadValue("minSpeechDurationMs", value);
    if (isBrowser) localStorage.setItem("whisperVadMinSpeechDurationMs", String(next));
    useSettingsStore.setState({ whisperVadMinSpeechDurationMs: next });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ minSpeechDurationMs: next });
    }
  },
  setWhisperVadMinSilenceDurationMs: (value: number) => {
    const next = clampVadValue("minSilenceDurationMs", value);
    if (isBrowser) localStorage.setItem("whisperVadMinSilenceDurationMs", String(next));
    useSettingsStore.setState({ whisperVadMinSilenceDurationMs: next });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ minSilenceDurationMs: next });
    }
  },
  setWhisperVadMaxSpeechDurationS: (value: number) => {
    const next = clampVadValue("maxSpeechDurationS", value);
    if (isBrowser) localStorage.setItem("whisperVadMaxSpeechDurationS", String(next));
    useSettingsStore.setState({ whisperVadMaxSpeechDurationS: next });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ maxSpeechDurationS: next });
    }
  },
  setWhisperVadSpeechPadMs: (value: number) => {
    const next = clampVadValue("speechPadMs", value);
    if (isBrowser) localStorage.setItem("whisperVadSpeechPadMs", String(next));
    useSettingsStore.setState({ whisperVadSpeechPadMs: next });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ speechPadMs: next });
    }
  },
  setWhisperVadSamplesOverlap: (value: number) => {
    const next = clampVadValue("samplesOverlap", value);
    if (isBrowser) localStorage.setItem("whisperVadSamplesOverlap", String(next));
    useSettingsStore.setState({ whisperVadSamplesOverlap: next });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ samplesOverlap: next });
    }
  },
  setPanelStartPosition: (position: "bottom-right" | "center" | "bottom-left") => {
    if (get().panelStartPosition === position) return;
    if (isBrowser) localStorage.setItem("panelStartPosition", position);
    set({ panelStartPosition: position });
    if (isBrowser) {
      window.electronAPI?.notifyPanelStartPositionChanged?.(position);
    }
  },

  setShowTranscriptionPreview: createBooleanSetter("showTranscriptionPreview"),
  setAutoPasteEnabled: createBooleanSetter("autoPasteEnabled"),
  setKeepTranscriptionInClipboard: createBooleanSetter("keepTranscriptionInClipboard"),
  setNoteFilesEnabled: createBooleanSetter("noteFilesEnabled"),
  setNoteFilesPath: createStringSetter("noteFilesPath"),
  setNoteFilesBaseTag: createStringSetter("noteFilesBaseTag"),
  setNoteFilesExportDictations: createBooleanSetter("noteFilesExportDictations"),
  setUserName: createStringSetter("userName"),

  setChatAgentModel: createStringSetter("chatAgentModel"),
  setChatAgentProvider: createStringSetter("chatAgentProvider"),
  setChatAgentMode: createStringSetter("chatAgentMode") as (mode: InferenceMode) => void,
  setChatAgentRemoteUrl: createStringSetter("chatAgentRemoteUrl"),
  setChatAgentCustomApiKey: createSecretSetter("chatAgentCustomApiKey", "chatAgentCustom"),

  updateTranscriptionSettings: (settings: Partial<TranscriptionSettings>) => {
    const s = useSettingsStore.getState();
    if (settings.useLocalWhisper !== undefined) s.setUseLocalWhisper(settings.useLocalWhisper);
    if (settings.uiLanguage !== undefined) s.setUiLanguage(settings.uiLanguage);
    if (settings.whisperModel !== undefined) s.setWhisperModel(settings.whisperModel);
    if (settings.localTranscriptionProvider !== undefined)
      s.setLocalTranscriptionProvider(settings.localTranscriptionProvider);
    if (settings.parakeetModel !== undefined) s.setParakeetModel(settings.parakeetModel);
    if (settings.cohereModel !== undefined) s.setCohereModel(settings.cohereModel);
    if (settings.allowLocalFallback !== undefined)
      s.setAllowLocalFallback(settings.allowLocalFallback);
    if (settings.fallbackWhisperModel !== undefined)
      s.setFallbackWhisperModel(settings.fallbackWhisperModel);
    if (settings.preferredLanguage !== undefined)
      s.setPreferredLanguage(settings.preferredLanguage);
    if (settings.chineseScriptPreference !== undefined)
      s.setChineseScriptPreference(settings.chineseScriptPreference);
    if (settings.customDictionary !== undefined) s.setCustomDictionary(settings.customDictionary);
    if (settings.snippets !== undefined) s.setSnippets(settings.snippets);
    if (settings.showTranscriptionPreview !== undefined)
      s.setShowTranscriptionPreview(settings.showTranscriptionPreview);
  },

  // Point dictation, Note Recording and audio upload at one engine, as
  // onboarding does. Note Recording's server is cleared so it follows dictation's.
  setTranscriptionModeForAllScopes: (mode: TranscriptionMode) => {
    const s = useSettingsStore.getState();
    const useLocal = mode === "local";
    s.setTranscriptionMode(mode);
    s.setUseLocalWhisper(useLocal);
    s.setUploadTranscriptionMode(mode);
    s.setUploadUseLocalWhisper(useLocal);
    s.setMeetingTranscriptionMode(mode);
    s.setMeetingUseLocalWhisper(useLocal);
    if (useLocal) {
      s.setMeetingLocalTranscriptionProvider(s.localTranscriptionProvider);
      s.setUploadLocalTranscriptionProvider(s.localTranscriptionProvider);
    } else {
      s.setMeetingRemoteTranscriptionUrl("");
      s.setMeetingRemoteTranscriptionModel("");
      s.setUploadRemoteTranscriptionUrl(s.remoteTranscriptionUrl);
      s.setUploadRemoteTranscriptionModel(s.remoteTranscriptionModel);
    }
  },

  updateCleanupSettings: (settings: Partial<CleanupSettings>) => {
    const s = useSettingsStore.getState();
    if (settings.useCleanupModel !== undefined) s.setUseCleanupModel(settings.useCleanupModel);
    if (settings.useDictationAgent !== undefined)
      s.setUseDictationAgent(settings.useDictationAgent);
    if (settings.cleanupModel !== undefined) s.setCleanupModel(settings.cleanupModel);
    if (settings.cleanupProvider !== undefined) s.setCleanupProvider(settings.cleanupProvider);
    if (settings.cleanupMode !== undefined) s.setCleanupMode(settings.cleanupMode);
    if (settings.cleanupRemoteUrl !== undefined) s.setCleanupRemoteUrl(settings.cleanupRemoteUrl);
  },

  // Point every LLM scope at one runtime, as onboarding does.
  setReasoningForAllScopes: (config: ReasoningSelection) => {
    for (const [scope, patch] of Object.entries(buildReasoningScopePatches(config))) {
      setResolvedLLMConfig(scope as InferenceScope, patch);
    }
  },

  updateApiKeys: (keys: Partial<ApiKeySettings>) => {
    const s = useSettingsStore.getState();
    if (keys.customTranscriptionApiKey !== undefined)
      s.setCustomTranscriptionApiKey(keys.customTranscriptionApiKey);
    if (keys.cleanupCustomApiKey !== undefined) s.setCleanupCustomApiKey(keys.cleanupCustomApiKey);
  },

  updateChatAgentSettings: (settings: Partial<ChatAgentSettings>) => {
    const s = useSettingsStore.getState();
    if (settings.chatAgentModel !== undefined) s.setChatAgentModel(settings.chatAgentModel);
    if (settings.chatAgentProvider !== undefined)
      s.setChatAgentProvider(settings.chatAgentProvider);
  },
}));

// --- Selectors (derived state, not stored) ---

export interface ResolvedMeetingTranscription {
  useLocalWhisper: boolean;
  whisperModel: string;
  localTranscriptionProvider: LocalTranscriptionProvider;
  parakeetModel: string;
  cohereModel: string;
  transcriptionMode: TranscriptionMode;
  remoteTranscriptionType: SelfHostedType;
  remoteTranscriptionUrl: string;
  remoteTranscriptionModel: string;
}

// An unset Note Recording server falls back to the dictation server, model and
// all; a set one uses its own model (empty = the server's default).
export const selectResolvedMeetingTranscription = (
  state: SettingsState
): ResolvedMeetingTranscription => ({
  useLocalWhisper: state.meetingUseLocalWhisper,
  whisperModel: state.meetingWhisperModel || state.whisperModel,
  localTranscriptionProvider: state.meetingLocalTranscriptionProvider,
  parakeetModel: state.meetingParakeetModel || state.parakeetModel,
  cohereModel: state.meetingCohereModel || state.cohereModel,
  transcriptionMode: state.meetingTranscriptionMode,
  remoteTranscriptionType: state.meetingRemoteTranscriptionType,
  remoteTranscriptionUrl: state.meetingRemoteTranscriptionUrl.trim()
    ? state.meetingRemoteTranscriptionUrl
    : state.remoteTranscriptionUrl,
  remoteTranscriptionModel: state.meetingRemoteTranscriptionUrl.trim()
    ? state.meetingRemoteTranscriptionModel
    : state.remoteTranscriptionModel,
});

export interface ResolvedUploadTranscription {
  useLocalWhisper: boolean;
  whisperModel: string;
  localTranscriptionProvider: LocalTranscriptionProvider;
  parakeetModel: string;
  cohereModel: string;
  transcriptionMode: TranscriptionMode;
  remoteTranscriptionUrl: string;
  remoteTranscriptionModel: string;
}

// Unset local model values fall back to the base dictation settings, matching
// the behavior before upload had its own context. The self-hosted server never
// inherits, so uploads go only to the server the Upload tab shows (#2049).
// migrateUploadSelfHosted() seeds it once for profiles from before the tab had its own.
export const selectResolvedUploadTranscription = (
  state: SettingsState
): ResolvedUploadTranscription => ({
  useLocalWhisper: state.uploadUseLocalWhisper,
  whisperModel: state.uploadWhisperModel || state.whisperModel,
  localTranscriptionProvider: state.uploadLocalTranscriptionProvider,
  parakeetModel: state.uploadParakeetModel || state.parakeetModel,
  cohereModel: state.uploadCohereModel || state.cohereModel,
  transcriptionMode: state.uploadTranscriptionMode,
  remoteTranscriptionUrl: state.uploadRemoteTranscriptionUrl,
  remoteTranscriptionModel: state.uploadRemoteTranscriptionModel,
});

export interface ResolvedNoteFormatting {
  provider: string;
  model: string;
  mode: InferenceMode;
  remoteUrl: string;
  customApiKey: string;
}

export const selectResolvedNoteFormatting = (state: SettingsState): ResolvedNoteFormatting => {
  const cfg = selectResolvedLLMConfig(state, "noteFormatting");
  const cleanup = selectResolvedLLMConfig(state, "dictationCleanup");
  // The endpoint falls back to dictation cleanup, so the key that opens it must too,
  // or an inherited endpoint gets called with no credential.
  const borrowsEndpoint = inheritsFallbackEndpoint(
    { mode: cfg.mode, remoteUrl: state.noteFormattingRemoteUrl },
    cleanup.mode
  );
  return {
    provider: cfg.provider,
    model: cfg.model,
    mode: cfg.mode,
    remoteUrl: cfg.remoteUrl || "",
    customApiKey: cfg.customApiKey || (borrowsEndpoint ? cleanup.customApiKey || "" : ""),
  };
};

export interface ResolvedLLMConfig {
  scope: InferenceScope;
  mode: InferenceMode;
  provider: string;
  model: string;
  remoteUrl?: string;
  customApiKey?: string;
  disableThinking: boolean;
  reasoningEffort?: string;
  /** Only on scopes that stream chat (see INFERENCE_SCOPES storeKeys). */
  toolCalling?: ToolCallingSetting;
  acceptsImages?: boolean;
}

export const selectResolvedLLMConfig = (
  state: SettingsState,
  scope: InferenceScope
): ResolvedLLMConfig => {
  const def: InferenceScopeDefinition = INFERENCE_SCOPES[scope];
  const fallback = def.fallbackScope
    ? selectResolvedLLMConfig(state, def.fallbackScope as InferenceScope)
    : undefined;

  const read = (field: keyof InferenceScopeStoreKeys): string | undefined => {
    const key = def.storeKeys[field];
    if (!key) return undefined;
    return (state[key] as string | undefined) || undefined;
  };

  const disableThinkingKey = def.storeKeys.disableThinking;
  const disableThinking = disableThinkingKey ? (state[disableThinkingKey] as boolean) : true;

  const toolCallingKey = def.storeKeys.toolCalling;
  const acceptsImagesKey = def.storeKeys.acceptsImages;

  return {
    scope,
    mode: state[def.storeKeys.mode] as InferenceMode,
    provider: read("provider") || fallback?.provider || "",
    model: read("model") || fallback?.model || "",
    remoteUrl: read("remoteUrl") || fallback?.remoteUrl,
    // Not inherited here: the settings editor renders this field, and a borrowed key
    // in it would be committed to this scope's storage by an idle edit. Inheritance
    // belongs on the request path — see selectResolvedNoteFormatting.
    customApiKey: read("customApiKey"),
    disableThinking,
    reasoningEffort: read("reasoningEffort"),
    ...(toolCallingKey ? { toolCalling: state[toolCallingKey] as ToolCallingSetting } : {}),
    ...(acceptsImagesKey ? { acceptsImages: state[acceptsImagesKey] === true } : {}),
  };
};

// Scope custom keys are secrets kept in the OS secure store, not localStorage
// (which is stripped on startup). Writes must go through their dedicated
// setters so the values survive restarts.
const SECRET_SCOPE_KEY_SETTERS = {
  cleanupCustomApiKey: "setCleanupCustomApiKey",
  noteFormattingCustomApiKey: "setNoteFormattingCustomApiKey",
  translationCustomApiKey: "setTranslationCustomApiKey",
  dictationAgentCustomApiKey: "setDictationAgentCustomApiKey",
  chatAgentCustomApiKey: "setChatAgentCustomApiKey",
} as const;

export function setResolvedLLMConfig(
  scope: InferenceScope,
  patch: Partial<Omit<ResolvedLLMConfig, "scope">>
): void {
  const def: InferenceScopeDefinition = INFERENCE_SCOPES[scope];
  const updates: Partial<SettingsState> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const storeKey = def.storeKeys[field as keyof InferenceScopeStoreKeys];
    if (!storeKey) continue;
    const secretSetter =
      SECRET_SCOPE_KEY_SETTERS[storeKey as keyof typeof SECRET_SCOPE_KEY_SETTERS];
    if (secretSetter) {
      useSettingsStore.getState()[secretSetter](value as string);
      continue;
    }
    if (isBrowser) {
      localStorage.setItem(
        storeKey as string,
        typeof value === "boolean" ? String(value) : (value as string)
      );
    }
    (updates as Record<string, unknown>)[storeKey as string] = value;
  }
  if (Object.keys(updates).length > 0) useSettingsStore.setState(updates);
}

// What resolveLocalServerNeeds (main process) decides the shared llama-server
// from. The resolved configs carry fallback inheritance, so they match what
// requests run on.
export function selectLocalServerPrefs(state: SettingsState): LocalServerPrefs {
  const cleanup = selectResolvedLLMConfig(state, "dictationCleanup");
  const dictationAgent = selectResolvedLLMConfig(state, "dictationAgent");
  const noteFormatting = selectResolvedLLMConfig(state, "noteFormatting");
  const chat = selectResolvedLLMConfig(state, "chatIntelligence");
  const translation = selectResolvedLLMConfig(state, "dictationTranslation");
  return {
    useCleanupModel: state.useCleanupModel,
    cleanupMode: cleanup.mode,
    cleanupModel: cleanup.model,
    useDictationAgent: state.useDictationAgent,
    dictationAgentMode: dictationAgent.mode,
    dictationAgentModel: dictationAgent.model,
    noteFormattingMode: noteFormatting.mode,
    noteFormattingModel: noteFormatting.model,
    chatAgentMode: chat.mode,
    chatAgentModel: chat.model,
    useDictationTranslation: state.useDictationTranslation,
    translationMode: translation.mode,
    translationModel: translation.model,
  };
}

// --- Convenience getters for non-React code ---

export function getSettings(): SettingsState {
  return useSettingsStore.getState();
}

export function getEffectiveCleanupModel() {
  return selectResolvedLLMConfig(getSettings(), "dictationCleanup").model;
}

/**
 * Drops any local model selection the model cache no longer backs — a scope left
 * pointing at a deleted model fails at inference time with an error the user has
 * no way to act on. Cleared rather than repointed so the picker asks again.
 */
export function clearMissingLocalModelSelections(isInstalled: (modelId: string) => boolean): void {
  const settings = useSettingsStore.getState() as unknown as Record<string, unknown>;
  const staleKeys: string[] = findStaleLocalModelKeys(
    Object.values(INFERENCE_SCOPES),
    settings,
    isInstalled
  );
  for (const key of staleKeys) {
    setStringSetting(key as keyof SettingsState, "");
  }
}

/** Reconciles every scope against the models actually on disk. */
export async function reconcileLocalModelSelections(): Promise<void> {
  if (!isBrowser || !window.electronAPI?.modelGetAll) return;

  const models = await window.electronAPI.modelGetAll();
  const installed = new Set(models.filter((model) => model.isDownloaded).map((model) => model.id));
  clearMissingLocalModelSelections((modelId) => installed.has(modelId));
}

// --- Initialization ---

// One-time migration: scope custom keys lived in plaintext localStorage before
// moving to the OS secure store. Prefer the secure value; otherwise push the
// legacy plaintext copy into the secure store — the stale-secret sweep in
// initializeSettings then strips it from localStorage.
async function migrateScopeCustomKeys(
  entries: ReadonlyArray<[keyof SettingsState & string, string | null | undefined, string]>
): Promise<Partial<SettingsState>> {
  const updates: Record<string, string> = {};
  for (const [storeKey, secureValue, saverName] of entries) {
    let value = secureValue || "";
    if (!value) {
      const legacy = localStorage.getItem(storeKey)?.trim() || "";
      if (legacy) {
        value = legacy;
        const save = window.electronAPI?.[saverName as keyof typeof window.electronAPI] as
          ((key: string) => Promise<unknown>) | undefined;
        await save?.(legacy);
      }
    }
    updates[storeKey] = value;
  }
  return updates as Partial<SettingsState>;
}

let hasInitialized = false;

export async function initializeSettings(): Promise<void> {
  if (hasInitialized) return;
  hasInitialized = true;

  if (!isBrowser) return;

  const state = useSettingsStore.getState();
  let hydratingSecrets = true;
  const pendingSecretUpdates = new Set<string>();

  // A key saved in another window. Queue updates until hydration can no
  // longer overwrite them.
  const refreshApiKey = async (storeKey: string) => {
    if (!STALE_SECRET_LOCALSTORAGE_KEYS.some((key) => key === storeKey)) return;
    if (hydratingSecrets) {
      pendingSecretUpdates.add(storeKey);
      return;
    }
    const saver =
      SECRET_IPC_SAVERS[storeKey as SecretProvider] ||
      SECRET_IPC_SAVERS[storeKey.replace(/ApiKey$/, "") as SecretProvider];
    if (!saver) return;
    const getter = window.electronAPI?.[
      saver.replace(/^save/, "get") as keyof typeof window.electronAPI
    ] as (() => Promise<string | null>) | undefined;
    if (!getter) return;
    try {
      const key = await getter();
      if (key !== null && typeof key !== "string") return;
      useSettingsStore.setState({ [storeKey]: key || "" });
      notifyApiKeyChanged();
    } catch {
      logger.warn("Failed to refresh API key", { storeKey }, "settings");
    }
  };
  window.electronAPI?.onApiKeyUpdated?.(refreshApiKey);

  if (window.electronAPI) {
    // Preferences are already in localStorage; do not wait for secret or provider hydration.
    try {
      await window.electronAPI.syncNotificationPreferences?.({
        notificationsEnabled: state.notificationsEnabled,
        notifyMeetingDetection: state.notifyMeetingDetection,
        notifyCalendarReminders: state.notifyCalendarReminders,
        meetingProcessDetection: state.meetingProcessDetection,
      });
    } catch (err) {
      logger.warn(
        "Failed to sync notification preferences on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Here rather than in the control panel, which doesn't exist on a minimized
    // start: the note files export and import must run from launch.
    if (state.noteFilesEnabled) {
      try {
        await window.electronAPI.noteFilesSetEnabled?.(true, state.noteFilesPath || undefined, {
          skipRebuild: true,
          baseTag: state.noteFilesBaseTag,
          exportDictations: state.noteFilesExportDictations,
        });
      } catch (err) {
        logger.warn(
          "Failed to enable note files on startup",
          { error: (err as Error).message },
          "settings"
        );
      }
    }

    try {
      const [
        customTx,
        customRx,
        noteFormattingCustom,
        translationCustom,
        dictationAgentCustom,
        chatAgentCustom,
      ] = await Promise.all([
        window.electronAPI.getCustomTranscriptionKey?.(),
        window.electronAPI.getCleanupCustomKey?.(),
        window.electronAPI.getNoteFormattingCustomKey?.(),
        window.electronAPI.getTranslationCustomKey?.(),
        window.electronAPI.getDictationAgentCustomKey?.(),
        window.electronAPI.getChatAgentCustomKey?.(),
      ]);

      useSettingsStore.setState({
        customTranscriptionApiKey: customTx || "",
        cleanupCustomApiKey: customRx || "",
        ...(await migrateScopeCustomKeys([
          ["noteFormattingCustomApiKey", noteFormattingCustom, "saveNoteFormattingCustomKey"],
          ["translationCustomApiKey", translationCustom, "saveTranslationCustomKey"],
          ["dictationAgentCustomApiKey", dictationAgentCustom, "saveDictationAgentCustomKey"],
          ["chatAgentCustomApiKey", chatAgentCustom, "saveChatAgentCustomKey"],
        ])),
      });

      if (localStorage.getItem("_dictationAgentSeeded") === "key-pending") {
        const { chatAgentCustomApiKey, setDictationAgentCustomApiKey } =
          useSettingsStore.getState();
        if (chatAgentCustomApiKey) setDictationAgentCustomApiKey(chatAgentCustomApiKey);
        localStorage.setItem("_dictationAgentSeeded", "1");
      }

      for (const key of STALE_SECRET_LOCALSTORAGE_KEYS) {
        localStorage.removeItem(key);
      }
      // Latch for the one-time semantic reindex that no longer exists (#2143).
      localStorage.removeItem("semanticReindexVersion");
    } catch (err) {
      logger.warn(
        "Failed to hydrate secrets from main process",
        { error: (err as Error).message },
        "settings"
      );
    } finally {
      hydratingSecrets = false;
      await Promise.all([...pendingSecretUpdates].map(refreshApiKey));
      pendingSecretUpdates.clear();
    }

    // Sync dictation key from main process.
    // localStorage holds the user's preferred hotkey. Only populate from .env
    // when localStorage is empty (fresh install / cleared data).
    try {
      if (!state.dictationKey) {
        const envKey = await window.electronAPI.getDictationKey?.();
        if (envKey) {
          createStringSetter("dictationKey")(envKey);
        }
      }
    } catch (err) {
      logger.warn(
        "Failed to sync dictation key on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Track what is actually registered, separately from the editable
    // dictationKey preference so partial registrations never get persisted.
    // May return constructor default during early startup; corrected by dictation-key-active event later.
    try {
      const activeKey = await window.electronAPI?.getActiveDictationKey?.();
      if (activeKey) {
        useSettingsStore.setState({ activeDictationKey: activeKey });
      }
    } catch (err) {
      logger.warn(
        "Failed to sync active dictation key on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Sync voice agent hotkey from main process
    try {
      const envKey = await window.electronAPI.getVoiceAgentKey?.();
      if (envKey && envKey !== state.voiceAgentKey) {
        createStringSetter("voiceAgentKey")(envKey);
      }
    } catch (err) {
      logger.warn(
        "Failed to sync voice agent hotkey on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Sync translation hotkey from main process
    try {
      const envKey = await window.electronAPI.getTranslationKey?.();
      if (envKey && envKey !== state.translationKey) {
        createStringSetter("translationKey")(envKey);
      }
    } catch (err) {
      logger.warn(
        "Failed to sync translation hotkey on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      let envMode = await window.electronAPI.getActivationMode?.();
      if (envMode && envMode !== state.activationMode) {
        if (isBrowser) localStorage.setItem("activationMode", envMode);
        useSettingsStore.setState({ activationMode: envMode });
      }
    } catch (err) {
      logger.warn(
        "Failed to sync activation mode on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Sync UI language from main process
    try {
      const envLanguage = await window.electronAPI.getUiLanguage?.();
      const resolved = normalizeUiLanguage(envLanguage || state.uiLanguage);
      if (resolved !== state.uiLanguage) {
        if (isBrowser) localStorage.setItem("uiLanguage", resolved);
        useSettingsStore.setState({ uiLanguage: resolved });
      }
      await i18n.changeLanguage(resolved);
    } catch (err) {
      logger.warn(
        "Failed to sync UI language on startup",
        { error: (err as Error).message },
        "settings"
      );
      void i18n.changeLanguage(normalizeUiLanguage(state.uiLanguage));
    }

    const migratedLang = isBrowser ? localStorage.getItem("preferredLanguage") : null;
    if (migratedLang && migratedLang !== state.preferredLanguage) {
      useSettingsStore.setState({ preferredLanguage: migratedLang });
    }

    // Sync dictionary from SQLite <-> localStorage.
    // Prefer SQLite whenever it has entries (same policy as snippets). A stale
    // cache used to win when both sides were non-empty; ensureAgentNameInDictionary
    // then wrote that cache through setDictionary and wiped newer DB words (#1295).
    let dictionarySyncSucceeded = !window.electronAPI?.getDictionary;
    try {
      if (window.electronAPI.getDictionary) {
        const currentDictionary = useSettingsStore.getState().customDictionary;
        const dbWords = await window.electronAPI.getDictionary();
        const decision = chooseDictionaryStartupAction(dbWords, currentDictionary);
        if (decision.action === "push-local-to-db") {
          await window.electronAPI.setDictionary(decision.words);
        } else if (decision.action === "pull-db-to-local") {
          if (isBrowser) localStorage.setItem("customDictionary", JSON.stringify(decision.words));
          useSettingsStore.setState({ customDictionary: decision.words });
        }
        dictionarySyncSucceeded = true;
      }
    } catch (err) {
      logger.warn(
        "Failed to sync dictionary on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Sync snippets from SQLite <-> localStorage
    try {
      if (window.electronAPI.getSnippets) {
        const currentSnippets = useSettingsStore.getState().snippets;
        const dbSnippets = await window.electronAPI.getSnippets();
        if (dbSnippets.length === 0 && currentSnippets.length > 0) {
          await window.electronAPI.setSnippets?.(currentSnippets);
          const normalizedSnippets = await window.electronAPI.getSnippets();
          if (isBrowser) localStorage.setItem("snippets", JSON.stringify(normalizedSnippets));
          useSettingsStore.setState({ snippets: normalizedSnippets });
        } else if (dbSnippets.length > 0) {
          if (isBrowser) localStorage.setItem("snippets", JSON.stringify(dbSnippets));
          useSettingsStore.setState({ snippets: dbSnippets });
        }
      }
    } catch (err) {
      logger.warn(
        "Failed to sync snippets on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // The main-process DB is the source of truth for the Apple Calendar connection
    try {
      const status = await window.electronAPI.acalGetConnectionStatus?.();
      if (status) {
        useSettingsStore.getState().setAppleCalendarConnected(status.connected);
      }
    } catch (err) {
      logger.warn(
        "Failed to hydrate Apple Calendar connection status",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      const currentState = useSettingsStore.getState();
      await window.electronAPI.setSpeakerDiarizationEnabled?.(
        currentState.speakerDiarizationEnabled
      );
    } catch (err) {
      logger.warn(
        "Failed to sync speaker diarization preference on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      await syncDiarizationEndpoint();
    } catch (err) {
      logger.warn(
        "Failed to sync speaker detection endpoint on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      const currentState = useSettingsStore.getState();
      await window.electronAPI.setWhisperVadConfig?.({
        dictationSileroEnabled: currentState.dictationSileroEnabled,
        noteRecordingSileroEnabled: currentState.noteRecordingSileroEnabled,
        meetingSileroEnabled: currentState.meetingSileroEnabled,
        threshold: currentState.whisperVadThreshold,
        minSpeechDurationMs: currentState.whisperVadMinSpeechDurationMs,
        minSilenceDurationMs: currentState.whisperVadMinSilenceDurationMs,
        maxSpeechDurationS: currentState.whisperVadMaxSpeechDurationS,
        speechPadMs: currentState.whisperVadSpeechPadMs,
        samplesOverlap: currentState.whisperVadSamplesOverlap,
      });
    } catch (err) {
      logger.warn(
        "Failed to sync whisper VAD config on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      await reconcileLocalModelSelections();
    } catch (err) {
      logger.warn(
        "Failed to reconcile local model selections on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Only after a successful DB↔cache reconcile. If the read failed, the cache
    // may still be stale — writing it via setCustomDictionary would wipe SQLite.
    if (dictionarySyncSucceeded) {
      ensureAgentNameInDictionary();
    }
  }

  // Sync Zustand store when another window writes to localStorage
  window.addEventListener("storage", (event) => {
    if (!event.key || event.storageArea !== localStorage || event.newValue === null) return;

    const { key, newValue } = event;

    if (key.startsWith("customPrompt.")) {
      const kind = key.slice("customPrompt.".length) as PromptKind;
      if (!PROMPT_KIND_LIST.includes(kind)) return;
      useSettingsStore.setState((s) => ({
        customPrompts: { ...s.customPrompts, [kind]: newValue },
      }));
      return;
    }

    const state = useSettingsStore.getState();
    if (!(key in state) || typeof (state as unknown as Record<string, unknown>)[key] === "function")
      return;

    let value: unknown;
    if (BOOLEAN_SETTINGS.has(key)) {
      value = newValue === "true";
    } else if (ARRAY_SETTINGS.has(key)) {
      try {
        const parsed = JSON.parse(newValue);
        value = Array.isArray(parsed) ? parsed : [];
      } catch {
        value = [];
      }
    } else if (NUMERIC_SETTINGS.has(key)) {
      const parsed = Number(newValue);
      if (Number.isNaN(parsed)) {
        value =
          key === "audioRetentionDays" || key === "meetingAudioRetentionDays"
            ? 30
            : (state as unknown as Record<string, unknown>)[key];
      } else if (key === "audioRetentionDays" || key === "meetingAudioRetentionDays") {
        value = Math.round(parsed);
      } else if (key === "micWarmHoldSeconds") {
        // Same whitelist as the setter — a hand-edited localStorage value
        // synced from another window must not exceed the offered durations.
        value = snapMicWarmHold(parsed);
      } else {
        value = parsed;
      }
    } else if (key === "toneStyles") {
      value = normalizeToneStyles(newValue);
    } else {
      value = newValue;
    }

    useSettingsStore.setState({ [key]: value });

    if (key === "uiLanguage" && typeof value === "string") {
      void i18n.changeLanguage(value);
    }
  });

  // Active hotkey updates from backend — display state, never persisted.
  window.electronAPI?.onDictationKeyActive?.((key: string) => {
    useSettingsStore.setState({ activeDictationKey: key });
  });

  // Sync settings pushed from main process (e.g., hotkey changed in control panel)
  window.electronAPI?.onSettingUpdated?.((data: { key: string; value: unknown }) => {
    const state = useSettingsStore.getState();
    if (
      data.key in state &&
      typeof (state as unknown as Record<string, unknown>)[data.key] !== "function"
    ) {
      localStorage.setItem(
        data.key,
        typeof data.value === "string" ? data.value : JSON.stringify(data.value)
      );
      useSettingsStore.setState({ [data.key]: data.value });
    }
  });
}
